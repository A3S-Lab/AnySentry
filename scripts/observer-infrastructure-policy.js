'use strict';

const fs = require('node:fs');

const {
  InfrastructureRuleSet,
  materializeCgroupFilterDecision,
  normalizeWorkloadFacts,
  policyRuleDocument,
} = require('./observer-infrastructure-rules');

function text(value, limit = 500) {
  const normalized = typeof value === 'string'
    ? value.trim()
    : value == null
      ? ''
      : String(value).trim();
  return normalized.slice(0, limit);
}

function eventKind(observerEvent) {
  return Object.keys(observerEvent?.event && typeof observerEvent.event === 'object'
    ? observerEvent.event
    : {})[0] || '';
}

function exactSystemdUnit(cgroup) {
  const match = text(cgroup, 4_096).match(/(?:^|\/)([^/]+\.(?:service|slice|scope))(?:\/|$)/u);
  return match?.[1] || '';
}

function eventFacts(observerEvent, workloadClassification, options = {}) {
  const processInfo = observerEvent?.process && typeof observerEvent.process === 'object'
    ? observerEvent.process
    : {};
  const supplied = workloadClassification?.infrastructureFacts;
  if (options.boundFacts && typeof options.boundFacts === 'object') {
    // A cgroup binding is materialized from the full container inventory. It is more specific than
    // a transient Pod-level cache hit, but supplied facts may still contribute non-conflicting
    // fields. The bound container/owner identity wins on overlap.
    return normalizeWorkloadFacts({
      ...(supplied && typeof supplied === 'object' ? supplied : {}),
      ...options.boundFacts,
      process: processInfo,
      hostGroup: options.boundFacts.hostGroup || supplied?.hostGroup || options.hostGroup,
    });
  }
  if (supplied && typeof supplied === 'object') {
    return normalizeWorkloadFacts({
      ...supplied,
      process: processInfo,
      hostGroup: supplied.hostGroup || options.hostGroup,
    });
  }
  const systemdUnit = exactSystemdUnit(processInfo.cgroup);
  if (!systemdUnit) return undefined;
  return normalizeWorkloadFacts({
    type: 'host',
    hostGroup: options.hostGroup,
    systemdUnit,
    executable: processInfo.exe,
    process: processInfo,
  });
}

function infrastructureClassification(resolution) {
  if (!resolution) return undefined;
  const enforced = resolution.classification === 'non_agent';
  const facts = resolution.facts ?? {};
  return {
    state: enforced ? 'infrastructure' : 'unknown',
    infrastructureRule: true,
    filterDecision: resolution,
    attribution: {
      monitored: false,
      classification: enforced ? 'non_agent' : 'unknown',
      confidence: enforced ? 1 : 0,
      reason: enforced ? 'platform_infrastructure' : 'not_evaluated',
      source: resolution.source || 'platform_inventory',
      evidence: [
        `infrastructure_policy:${resolution.documentVersion}`,
        ...resolution.effectiveRuleIds.map((ruleId) => `infrastructure_rule:${ruleId}`),
      ].slice(0, 16),
      ...(facts.physicalWorkloadId ? { physicalWorkloadId: facts.physicalWorkloadId } : {}),
      ...(facts.type ? {
        workloadRef: {
          environment: facts.type,
          kind: facts.type === 'kubernetes' ? 'pod' : facts.type === 'docker' ? 'container' : 'service',
          ...(facts.namespace ? { namespace: facts.namespace } : {}),
          ...(facts.ownerKind ? { ownerKind: facts.ownerKind } : {}),
          ...(facts.ownerName ? { ownerName: facts.ownerName } : {}),
          ...(facts.containerName ? { containerName: facts.containerName } : {}),
          ...(facts.systemdUnit ? { systemdUnit: facts.systemdUnit } : {}),
          ...(facts.executable ? { executable: facts.executable } : {}),
        },
      } : {}),
    },
  };
}

const CAPTURE_PROBE_EVENT_KINDS = Object.freeze({
  tls: 'Egress',
  connect: 'Egress',
  dns: 'Dns',
  file_access: 'FileAccess',
  file_delete: 'FileDelete',
  llm: 'LlmCall',
  ssl: 'SslContent',
});

function probeAction(resolution, probe) {
  const captureIntent = resolution?.captureIntent;
  if (captureIntent?.action === 'full') return 'full';
  if (captureIntent?.action === 'aggregate') return probe === 'file_delete' ? 'sample' : 'aggregate';
  if (captureIntent?.action === 'sample') return 'sample';
  if (captureIntent?.action === 'drop') return probe === 'file_delete' ? 'sample' : 'drop';
  if (resolution?.action === 'keep') return 'full';
  if (resolution?.action === 'drop') return 'drop';
  return 'sample';
}

class InfrastructurePolicyRegistry {
  constructor(options = {}) {
    this.hostGroup = text(options.hostGroup, 240) || 'local';
    this.canaryEnabled = options.canaryEnabled === true;
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.ruleSet = undefined;
    this.factsByCgroup = new Map();
    this.policyVersion = 0;
    this.contentHash = '';
    this.expiresAt = 0;
    this.stats = {
      loads: 0,
      loadErrors: 0,
      expired: 0,
      evaluations: 0,
      matches: 0,
      wouldDrop: 0,
      enforced: 0,
      agentConflicts: 0,
      materialized: 0,
    };
  }

  replace(policy) {
    try {
      const document = policyRuleDocument(policy, { hostGroup: this.hostGroup });
      const ruleSet = new InfrastructureRuleSet(document);
      const expiresAt = Date.parse(text(policy.expiresAt, 80));
      if (!Number.isFinite(expiresAt) || expiresAt <= this.now()) {
        throw new Error('infrastructure policy is already expired');
      }
      this.ruleSet = ruleSet;
      this.policyVersion = Number(policy.policyVersion) || 0;
      this.contentHash = text(policy.contentHash, 128);
      this.expiresAt = expiresAt;
      this.stats.loads++;
      return { ok: true, version: this.policyVersion, rules: document.rules.length };
    } catch (error) {
      this.stats.loadErrors++;
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  recordLoadError() {
    this.stats.loadErrors++;
  }

  evaluate(observerEvent, workloadClassification) {
    this.stats.evaluations++;
    if (!this.ruleSet) return undefined;
    if (this.expiresAt <= this.now()) {
      this.stats.expired++;
      return undefined;
    }
    const processInfo = observerEvent?.process && typeof observerEvent.process === 'object'
      ? observerEvent.process
      : {};
    const cgroupId = text(processInfo.cgroupId ?? processInfo.cgroup_id, 20);
    const facts = eventFacts(observerEvent, workloadClassification, {
      hostGroup: this.hostGroup,
      boundFacts: this.factsByCgroup.get(cgroupId),
    });
    if (!facts) return undefined;
    const kind = eventKind(observerEvent);
    return this.evaluateFacts(facts, kind, observerEvent);
  }

  evaluateFacts(factsInput, kind, observerEvent) {
    if (!this.ruleSet || this.expiresAt <= this.now()) return undefined;
    const facts = normalizeWorkloadFacts({ ...factsInput, hostGroup: factsInput?.hostGroup || this.hostGroup });
    const resolution = this.ruleSet.resolve(facts, kind, {
      now: this.now,
      canaryEnabled: this.canaryEnabled,
    });
    if (!resolution) return undefined;
    const agentClassification = ['confirmed_agent', 'probable_agent'].includes(
      text(factsInput?.classification).toLowerCase(),
    ) ? text(factsInput.classification).toLowerCase() : '';
    const confirmedAgent = agentClassification === 'confirmed_agent';
    this.stats.matches++;
    if (resolution.wouldAction === 'drop') this.stats.wouldDrop++;
    if (resolution.action === 'drop') this.stats.enforced++;
    const materializationEvent = observerEvent ?? {
      process: { cgroup_id: factsInput?.cgroupId },
      event: { [kind]: {} },
    };
    const decision = materializeCgroupFilterDecision(materializationEvent, resolution, {
      eventKind: kind,
      cgroupId: factsInput?.cgroupId,
    });
    const fileResolution = kind === 'FileAccess'
      ? resolution
      : this.ruleSet.resolve(facts, 'FileAccess', {
          now: this.now,
          canaryEnabled: this.canaryEnabled,
        });
    const fileDecision = materializeCgroupFilterDecision(
      {
        process: {
          cgroup_id: factsInput?.cgroupId
            || observerEvent?.process?.cgroup_id
            || observerEvent?.process?.cgroupId,
        },
        event: { FileAccess: {} },
      },
      fileResolution,
      {
        eventKind: 'FileAccess',
        cgroupId: factsInput?.cgroupId,
      },
    );
    if (confirmedAgent && fileDecision) {
      this.stats.agentConflicts++;
      fileDecision.action = 'keep';
      fileDecision.wouldAction = 'keep';
      fileDecision.classification = agentClassification;
      fileDecision.authority = agentClassification === 'confirmed_agent'
        ? 'authoritative'
        : 'candidate';
      fileDecision.reasonCode = 'agent_keep_conflict';
      fileDecision.conflict = true;
    }
    if (decision) decision.policyVersion = this.policyVersion;
    if (fileDecision) {
      fileDecision.policyVersion = this.policyVersion;
      fileDecision.ruleId = fileResolution?.audit?.primaryRuleId;
      fileDecision.ruleRevision = fileResolution?.audit?.primaryRuleRevision;
    }
    if (fileDecision) this.stats.materialized++;
    const captureDecision = this.materializeCaptureProfile({ ...factsInput, ...facts });
    return {
      facts,
      resolution,
      classification: infrastructureClassification(resolution),
      decision,
      fileDecision,
      captureDecision,
    };
  }

  materializeCaptureProfile(factsInput) {
    if (!this.ruleSet || this.expiresAt <= this.now()) return undefined;
    const facts = normalizeWorkloadFacts({ ...factsInput, hostGroup: factsInput?.hostGroup || this.hostGroup });
    const cgroupId = text(factsInput?.cgroupId, 20);
    if (!/^\d{1,20}$/u.test(cgroupId) || cgroupId === '0') return undefined;
    const agentClassification = ['confirmed_agent', 'probable_agent'].includes(
      text(factsInput?.classification).toLowerCase(),
    ) ? text(factsInput.classification).toLowerCase() : '';
    const confirmedAgent = agentClassification === 'confirmed_agent';
    const resolutions = Object.fromEntries(Object.entries(CAPTURE_PROBE_EVENT_KINDS).map(([probe, kind]) => [
      probe,
      this.ruleSet.resolve(facts, kind, { now: this.now, canaryEnabled: this.canaryEnabled }),
    ]));
    const primary = resolutions.file_access ?? Object.values(resolutions).find(Boolean);
    if (!primary) return undefined;
    const expiresAt = new Date(Math.min(
      ...Object.values(resolutions).filter(Boolean).map((resolution) => Date.parse(resolution.expiresAt)),
    )).toISOString();
    if (confirmedAgent || primary.role === 'agent' || primary.conflict) {
      this.stats.agentConflicts++;
      return {
        scopeType: 'cgroup',
        scopeKey: `cgroup:${cgroupId}`,
        cgroupId,
        classification: confirmedAgent ? 'confirmed_agent' : 'probable_agent',
        authority: confirmedAgent ? 'authoritative' : 'candidate',
        action: 'keep',
        reasonCode: 'agent_keep_conflict',
        source: primary.source,
        conflict: true,
        captureProfile: 'agent_full',
        desiredProbeActions: {
          exec: 'full', exit: 'full', tls: 'full', connect: 'full', dns: 'full',
          file_access: 'full', file_delete: 'full', llm: 'full', ssl: 'full', security: 'full', file_read: 'full',
        },
        physicalWorkloadId: facts.physicalWorkloadId,
        agentInstanceId: facts.agentInstanceId,
        policyVersion: this.policyVersion,
        expiresAt,
      };
    }
    const desiredProbeActions = {
      exec: 'full',
      exit: 'full',
      security: 'full',
      ...Object.fromEntries(Object.entries(resolutions).map(([probe, resolution]) => [
        probe,
        resolution ? probeAction(resolution, probe) : probe === 'llm' ? 'sample' : 'aggregate',
      ])),
    };
    // FileDelete shares the Critical lane. Even confirmed Infrastructure keeps bounded path
    // evidence while its exact attempted/suppressed count is emitted through CaptureAggregate.
    desiredProbeActions.file_delete = 'sample';
    desiredProbeActions.file_read = 'not_enabled';
    const destructiveRules = new Map();
    for (const [probe, resolution] of Object.entries(resolutions)) {
      if (desiredProbeActions[probe] !== 'drop' || !resolution) continue;
      destructiveRules.set(resolution.audit.primaryRuleId, resolution.audit.primaryRuleRevision);
    }
    const materializationConflict = destructiveRules.size > 1;
    if (materializationConflict) {
      for (const [probe, action] of Object.entries(desiredProbeActions)) {
        if (action === 'drop') desiredProbeActions[probe] = probe === 'file_delete' || probe === 'llm' ? 'sample' : 'aggregate';
      }
    }
    const [ruleId, ruleRevision] = destructiveRules.entries().next().value
      ?? [primary.audit.primaryRuleId, primary.audit.primaryRuleRevision];
    return {
      scopeType: 'cgroup',
      scopeKey: `cgroup:${cgroupId}`,
      cgroupId,
      classification: primary.classification,
      authority: primary.authority,
      action: resolutions.file_access?.action ?? 'sample',
      wouldAction: resolutions.file_access?.wouldAction,
      reasonCode: materializationConflict ? 'multi_rule_capture_conflict' : primary.reasonCode,
      source: primary.source,
      conflict: materializationConflict,
      captureProfile: text(factsInput?.workloadRole).toLowerCase() === 'anysentry_internal'
        ? 'self_health'
        : 'infrastructure_aggregate',
      ...(primary.captureIntent ? { captureIntent: { ...primary.captureIntent } } : {}),
      desiredProbeActions,
      physicalWorkloadId: facts.physicalWorkloadId,
      ruleId,
      ruleRevision,
      policyVersion: this.policyVersion,
      expiresAt,
    };
  }

  recordAgentConflict() {
    this.stats.agentConflicts++;
  }

  replaceMaterializedFacts(inventory) {
    const next = new Map();
    for (const facts of Array.isArray(inventory) ? inventory : []) {
      const cgroupId = text(facts?.cgroupId, 20);
      if (!/^\d{1,20}$/u.test(cgroupId) || cgroupId === '0') continue;
      next.set(cgroupId, { ...facts });
    }
    this.factsByCgroup = next;
    return next.size;
  }

  hostInventory(options = {}) {
    if (!this.ruleSet || this.expiresAt <= this.now()) return [];
    const cgroupRoot = text(options.cgroupRoot, 1_024) || '/sys/fs/cgroup';
    const statSync = typeof options.statSync === 'function' ? options.statSync : fs.statSync;
    const facts = [];
    const seen = new Set();
    for (const rule of this.ruleSet.document.rules) {
      if (rule.selector.type !== 'host' || rule.stage === 'disabled') continue;
      const unit = rule.selector.systemdUnit;
      for (const candidate of [`${cgroupRoot}/system.slice/${unit}`, `${cgroupRoot}/${unit}`]) {
        try {
          const stat = statSync(candidate, { bigint: true });
          const inode = typeof stat.ino === 'bigint' ? stat.ino : BigInt(stat.ino);
          if (inode <= 0n || seen.has(inode.toString())) break;
          seen.add(inode.toString());
          facts.push({
            type: 'host',
            hostGroup: this.hostGroup,
            systemdUnit: unit,
            // Do not copy an executable selector into the observed facts. A future Host inventory
            // adapter must read it from systemd/proc; until then an executable-constrained rule
            // deliberately fails closed while an exact-unit rule remains materializable.
            executable: '',
            physicalWorkloadId: `host:${this.hostGroup}:systemd:${unit}`,
            cgroupId: inode.toString(),
            cgroupPath: candidate.slice(cgroupRoot.length) || '/',
          });
          break;
        } catch {}
      }
    }
    return facts;
  }

  resolveCgroupFacts(factsInput, options = {}) {
    if (!factsInput || factsInput.cgroupId || factsInput.type !== 'kubernetes') return factsInput;
    const cgroupRoot = text(options.cgroupRoot, 1_024) || '/sys/fs/cgroup';
    const statSync = typeof options.statSync === 'function' ? options.statSync : fs.statSync;
    const podUid = text(factsInput.podUid, 160);
    const containerId = text(factsInput.physicalWorkloadId).split(':').at(-1)?.toLowerCase() || '';
    if (!/^[a-f0-9]{64}$/u.test(containerId) || !/^[a-f0-9-]{20,160}$/iu.test(podUid)) {
      return factsInput;
    }
    const escapedPodUid = podUid.replaceAll('-', '_');
    const podSlices = [
      `kubepods-pod${escapedPodUid}.slice`,
      `kubepods-burstable.slice/kubepods-burstable-pod${escapedPodUid}.slice`,
      `kubepods-besteffort.slice/kubepods-besteffort-pod${escapedPodUid}.slice`,
    ];
    const scopes = [
      `cri-containerd-${containerId}.scope`,
      `crio-${containerId}.scope`,
      `docker-${containerId}.scope`,
    ];
    for (const podSlice of podSlices) {
      for (const scope of scopes) {
        const relative = `kubepods.slice/${podSlice}/${scope}`;
        try {
          const stat = statSync(`${cgroupRoot}/${relative}`, { bigint: true });
          const inode = typeof stat.ino === 'bigint' ? stat.ino : BigInt(stat.ino);
          if (inode > 0n) {
            return {
              ...factsInput,
              cgroupId: inode.toString(),
              cgroupPath: `/${relative}`,
            };
          }
        } catch {}
      }
    }
    return factsInput;
  }

  metrics() {
    return {
      ready: Boolean(this.ruleSet && this.expiresAt > this.now()),
      policyVersion: this.policyVersion,
      contentHash: this.contentHash || undefined,
      expiresInSeconds: this.expiresAt ? Math.max(0, Math.floor((this.expiresAt - this.now()) / 1_000)) : -1,
      rules: this.ruleSet?.document.rules.length ?? 0,
      materializedFacts: this.factsByCgroup.size,
      ...this.stats,
    };
  }
}

module.exports = {
  InfrastructurePolicyRegistry,
  eventFacts,
  exactSystemdUnit,
  infrastructureClassification,
};
