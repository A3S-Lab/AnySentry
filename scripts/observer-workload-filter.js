'use strict';

const fs = require('node:fs');
const { WORKLOAD_ROLES } = require('./observer-classification-semantics');

const workloadRoles = new Set(WORKLOAD_ROLES);

function text(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function workloadRole(value) {
  const normalized = text(value);
  return workloadRoles.has(normalized) ? normalized : undefined;
}

function normalizedContainerId(value) {
  return text(value).replace(/^[a-z0-9._-]+:\/\//i, '');
}

const PLATFORM_HEALTHCHECK_SUBTYPES = new Set([
  'docker_healthcheck',
  'k8s_exec_probe',
  'k8s_liveness_probe',
  'k8s_readiness_probe',
  'k8s_startup_probe',
]);

function boundedPlatformHealthchecks(value) {
  if (!Array.isArray(value)) return [];
  const probes = [];
  const seen = new Set();
  for (const raw of value.slice(0, 8)) {
    if (!raw || !PLATFORM_HEALTHCHECK_SUBTYPES.has(raw.activitySubtype)) continue;
    if (!Array.isArray(raw.argv) || raw.argv.length === 0 || raw.argv.length > 64) continue;
    if (raw.argv.some((arg) => typeof arg !== 'string' || arg.length === 0 || arg.length > 2_048)) continue;
    const key = JSON.stringify([raw.activitySubtype, raw.argv]);
    if (seen.has(key)) continue;
    seen.add(key);
    probes.push({ activitySubtype: raw.activitySubtype, argv: [...raw.argv] });
  }
  return probes;
}

function mergedPlatformHealthchecks(left, right) {
  return boundedPlatformHealthchecks([
    ...boundedPlatformHealthchecks(left),
    ...boundedPlatformHealthchecks(right),
  ]);
}

function exactArgv(left, right) {
  return left.length === right.length && left.every((arg, index) => arg === right[index]);
}

function classifyEventActivity(observerEvent, processClassification, workloadClassification) {
  const payload = observerEvent?.event?.ToolExec;
  if (!payload || typeof payload !== 'object') return undefined;
  const agentAction = { activityContext: 'agent_action' };
  // A command actually owned by an Agent remains an Agent action even when it intentionally runs
  // the same argv as its platform-declared probe.
  if (processClassification?.state === 'agent') return agentAction;
  if (
    payload.argv_truncated === true ||
    payload.argv_incomplete === true ||
    !Array.isArray(payload.argv) ||
    payload.argv.length === 0 ||
    payload.argv.some((arg) => typeof arg !== 'string')
  ) return agentAction;
  const probes = Array.isArray(workloadClassification?.platformHealthchecks)
    ? workloadClassification.platformHealthchecks
    : [];
  const matches = probes
    .filter((probe) => exactArgv(payload.argv, probe.argv));
  if (!matches.length) return agentAction;
  const subtypes = [...new Set(matches.map((probe) => probe.activitySubtype))];
  return {
    activityContext: 'platform_healthcheck',
    activitySubtype: subtypes.length === 1 ? subtypes[0] : 'k8s_exec_probe',
  };
}

function behaviorDiscoveryEligible(classification) {
  if (!classification || classification.attribution?.source === 'manual_review') return false;
  const evidence = Array.isArray(classification.attribution?.evidence)
    ? classification.attribution.evidence.map(text)
    : [];
  const facts = classification.infrastructureFacts && typeof classification.infrastructureFacts === 'object'
    ? classification.infrastructureFacts
    : {};
  const labels = facts.labels && typeof facts.labels === 'object' ? facts.labels : {};
  const roleCandidates = [
    classification.workloadRole,
    classification.attribution?.workloadRole,
    facts.workloadRole,
    labels['anysentry.io/workload-role'],
    evidence.find((value) => value.startsWith('label:anysentry.io/workload-role='))
      ?.slice('label:anysentry.io/workload-role='.length),
  ].map(workloadRole).filter(Boolean);
  const role = roleCandidates.find((value) => value !== 'unknown') ?? roleCandidates[0];
  // Stable inventory role is negative evidence for weak behavior promotion, not an Agent identity
  // verdict. Strong labels/signatures/Adapter facts still arrive as state=agent and bypass this
  // heuristic gate entirely.
  if (['anysentry_internal', 'platform_infrastructure', 'business_service'].includes(role)) {
    return false;
  }
  if (classification.state === 'infrastructure') return false;
  return (
    classification.state === 'unknown' ||
    (
      classification.state === 'non_agent' &&
      classification.attribution?.source === 'process_graph'
    )
  );
}

function eventIdentityCandidates(observerEvent) {
  const identity = observerEvent?.identity && typeof observerEvent.identity === 'object'
    ? observerEvent.identity
    : {};
  const workload = observerEvent?.workload && typeof observerEvent.workload === 'object'
    ? observerEvent.workload
    : {};
  const processInfo = observerEvent?.process && typeof observerEvent.process === 'object'
    ? observerEvent.process
    : {};
  const cgroup = text(processInfo.cgroup);
  const containerIds = [];
  const podIds = [];
  const add = (target, value) => {
    const normalized = normalizedContainerId(value);
    if (normalized && !target.includes(normalized)) target.push(normalized);
  };

  // Container-specific facts win over Pod-level identity so a sidecar cannot inherit the
  // classification of another container in the same Pod.
  add(containerIds, identity.session);
  add(containerIds, workload.provider_unit_id);
  for (const match of cgroup.matchAll(/(?:^|[-/])([a-f0-9]{64})(?:\.scope|$|[/.-])/gi)) {
    add(containerIds, match[1]);
    add(containerIds, match[1].slice(0, 12));
  }

  add(podIds, identity.agent);
  add(podIds, workload.replica_id);
  for (const match of cgroup.matchAll(/pod([a-f0-9][a-f0-9_-]{28,})/gi)) {
    add(podIds, match[1].replaceAll('_', '-'));
  }
  return {
    candidates: [...containerIds, ...podIds],
    containerized:
      containerIds.length > 0 ||
      Object.keys(workload).length > 0 ||
      /(?:kubepods|docker|containerd|crio|libpod)/i.test(cgroup),
  };
}

function readProcCgroup(pid, procRoot = '/proc') {
  const normalizedPid = Number(pid);
  if (!Number.isInteger(normalizedPid) || normalizedPid <= 0) return '';
  try {
    return fs.readFileSync(`${procRoot}/${normalizedPid}/cgroup`, 'utf8').trim();
  } catch {
    return '';
  }
}

function attributionFor(entry) {
  const classification = entry.classification;
  const monitored = classification === 'confirmed_agent' || classification === 'probable_agent';
  const environment =
    entry.environment ||
    (entry.source === 'kubernetes' ? 'kubernetes' : entry.source === 'docker' ? 'docker' : 'host');
  const processName = text(entry.processName || entry.executable);
  const workloadName =
    text(entry.podName) ||
    text(entry.containerName) ||
    text(entry.systemdUnit) ||
    processName;
  const workloadRef = {
    environment,
    kind:
      environment === 'kubernetes'
        ? 'pod'
        : environment === 'docker'
          ? 'container'
          : entry.systemdUnit
            ? 'service'
            : processName
              ? 'process'
              : 'cgroup',
    ...(workloadName ? { name: workloadName } : {}),
    ...(entry.namespace ? { namespace: entry.namespace } : {}),
    ...(entry.podName ? { podName: entry.podName } : {}),
    ...(entry.podUid ? { podUid: entry.podUid } : {}),
    ...(entry.nodeName ? { nodeName: entry.nodeName } : {}),
    ...(entry.containerName ? { containerName: entry.containerName } : {}),
    ...(entry.containerImage ? { containerImage: entry.containerImage } : {}),
    ...(entry.ownerKind ? { ownerKind: entry.ownerKind } : {}),
    ...(entry.ownerName ? { ownerName: entry.ownerName } : {}),
    ...(entry.systemdUnit ? { systemdUnit: entry.systemdUnit } : {}),
    ...(processName ? { processName } : {}),
    ...(entry.executable ? { executable: entry.executable } : {}),
  };
  return {
    monitored,
    classification,
    ...(entry.agentScopeId ? { agentScopeId: entry.agentScopeId } : {}),
    ...(entry.agentDisplayName ? { agentDisplayName: entry.agentDisplayName } : {}),
    ...(entry.agentInstanceId ? { agentInstanceId: entry.agentInstanceId } : {}),
    ...(entry.physicalWorkloadId ? { physicalWorkloadId: entry.physicalWorkloadId } : {}),
    workloadRef,
    confidence: classification === 'confirmed_agent' ? 1 : classification === 'probable_agent' ? 0.7 : 0,
    reason:
      classification === 'confirmed_agent'
        ? 'authoritative_anchor'
        : classification === 'non_agent'
          ? 'not_agent'
          : 'not_evaluated',
    source: entry.attributionSource || entry.source || 'kubernetes',
    evidence: Array.isArray(entry.evidence) ? entry.evidence.slice(0, 16) : [],
  };
}

function infrastructureFactsFor(entry) {
  const environment = text(entry.environment).toLowerCase()
    || (entry.source === 'kubernetes' ? 'kubernetes' : entry.source === 'docker' ? 'docker' : 'host');
  const physicalWorkloadId = text(entry.physicalWorkloadId);
  const physicalParts = physicalWorkloadId.split(':');
  const labels = entry.labels && typeof entry.labels === 'object' && !Array.isArray(entry.labels)
    ? { ...entry.labels }
    : {};
  return {
    type: environment,
    physicalWorkloadId,
    classification: text(entry.classification),
    cgroupId: text(entry.cgroupId),
    cgroupPath: text(entry.cgroupPath),
    hostGroup: environment === 'docker'
      ? text(entry.hostGroup || physicalParts[1] || entry.nodeName)
      : text(entry.hostGroup || entry.nodeName),
    clusterId: environment === 'kubernetes'
      ? text(entry.clusterId || physicalParts[1])
      : '',
    namespace: text(entry.namespace),
    podUid: text(entry.podUid),
    ownerKind: text(entry.ownerKind),
    ownerName: text(entry.ownerName),
    containerName: text(entry.containerName),
    containerImage: text(entry.containerImage),
    imageDigest: text(entry.imageDigest),
    composeProject: text(entry.composeProject || labels['com.docker.compose.project']),
    composeService: text(entry.composeService || labels['com.docker.compose.service']),
    systemdUnit: text(entry.systemdUnit),
    executable: text(entry.executable),
    labels,
    agentInstanceId: text(entry.agentInstanceId),
  };
}

class WorkloadIdentityCache {
  constructor(options = {}) {
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.byId = new Map();
    this.ready = false;
    this.version = 0;
    this.generatedAt = '';
    this.updatedAt = 0;
    this.errors = 0;
    this.hits = 0;
    this.misses = 0;
    this.templateRegistry = options.templateRegistry;
    this.readProcCgroup =
      typeof options.readProcCgroup === 'function'
        ? options.readProcCgroup
        : (pid) => readProcCgroup(pid, options.procRoot);
    this.sources = new Map();
    this.sourceMetrics = new Map();
    this.candidateCache = new Map();
    this.cgroupBindings = new Map();
    this.maxEventKeys = Math.max(1_000, Number(options.maxEventKeys) || 50_000);
    this.cgroupHits = 0;
    this.cgroupMisses = 0;
    this.procCgroupReads = 0;
  }

  replace(snapshot, sourceKey = 'kubernetes') {
    if (
      !snapshot ||
      snapshot.schemaVersion !== 'anysentry.workload_identity_snapshot.v1' ||
      !Array.isArray(snapshot.entries)
    ) {
      this.errors++;
      return false;
    }
    const sourceEntries = [];
    for (const entry of snapshot.entries) {
      if (!entry || !Array.isArray(entry.ids) || !text(entry.classification)) continue;
      const template = this.templateRegistry?.classifyEntry(entry);
      const nextEntry = template
        ? {
            ...entry,
            classification: template.attribution.classification,
            agentScopeId: template.attribution.agentScopeId,
            agentDisplayName: template.attribution.agentDisplayName,
            agentInstanceId:
              entry.agentInstanceId ||
              (template.attribution.agentScopeId ? entry.physicalWorkloadId : undefined),
            attributionSource: template.attribution.source,
            evidence: [
              ...(Array.isArray(entry.evidence) ? entry.evidence : []),
              ...(template.attribution.evidence ?? []),
            ].slice(0, 16),
          }
        : entry;
      sourceEntries.push(nextEntry);
    }
    this.sources.set(sourceKey, sourceEntries);
    this.sourceMetrics.set(sourceKey, {
      ready: snapshot.ready === true,
      version: Number(snapshot.version) || 0,
      generatedAt: text(snapshot.generatedAt),
      updatedAt: this.now(),
      errors: Number(snapshot.errors) || 0,
    });
    const next = new Map();
    const combinedEntries = [...this.sources.values()].flat();
    // Reviews are authoritative regardless of which discovery source was registered first.
    // Array#sort is stable, so every non-review source retains its existing relative order.
    combinedEntries.sort((left, right) =>
      Number(right.attributionSource === 'manual_review') -
      Number(left.attributionSource === 'manual_review'));
    for (const entry of combinedEntries) {
      const ids = entry.ids.map(normalizedContainerId).filter(Boolean);
      const existingEntries = [...new Set(ids.map((id) => next.get(id)).filter(Boolean))];
      const selectedEntry = existingEntries[0] ?? {
        ...entry,
        platformHealthchecks: boundedPlatformHealthchecks(entry.platformHealthchecks),
      };
      for (const existing of existingEntries) {
        const merged = mergedPlatformHealthchecks(existing.platformHealthchecks, entry.platformHealthchecks);
        // Identity remains first-wins (manual review before platform discovery), while exact
        // platform facts are allowed to enrich that authoritative identity. Workload role is an
        // independent axis: a non-Agent review must not erase exact deployment inventory.
        if (merged.length) existing.platformHealthchecks = merged;
        const supplementalRole = workloadRole(entry.workloadRole);
        if (!workloadRole(existing.workloadRole) && supplementalRole) {
          existing.workloadRole = supplementalRole;
        }
      }
      for (const id of ids) {
        if (!next.has(id)) next.set(id, selectedEntry);
      }
    }
    /*
     * A source replacement is atomic from the event loop's perspective. A later Docker source can
     * share this cache without overwriting the Kubernetes snapshot.
     */
    this.byId = next;
    // A snapshot change can reclassify or replace a container. Parsed cgroup candidates remain
    // valid, but the fast cgroup -> identity binding must be rebuilt against the new snapshot.
    this.cgroupBindings.clear();
    const metrics = [...this.sourceMetrics.values()];
    this.ready = metrics.some((source) => source.ready);
    this.version = metrics.reduce((total, source) => total + source.version, 0);
    this.generatedAt = metrics
      .map((source) => source.generatedAt)
      .filter(Boolean)
      .sort()
      .at(-1) || '';
    this.updatedAt = this.now();
    this.errors = metrics.reduce((total, source) => total + source.errors, 0);
    return true;
  }

  classify(observerEvent) {
    const processInfo = observerEvent?.process && typeof observerEvent.process === 'object'
      ? observerEvent.process
      : {};
    const cgroupKey =
      text(processInfo.cgroupId) ||
      text(processInfo.cgroup_id) ||
      text(processInfo.cgroup);
    const identityInfo =
      observerEvent?.identity && typeof observerEvent.identity === 'object'
        ? observerEvent.identity
        : {};
    const explicitContainerId = normalizedContainerId(identityInfo.session);
    const boundIdentity = cgroupKey ? this.cgroupBindings.get(cgroupKey) : undefined;
    const bindingConflicts =
      boundIdentity &&
      explicitContainerId &&
      boundIdentity !== explicitContainerId &&
      !boundIdentity.startsWith(explicitContainerId) &&
      !explicitContainerId.startsWith(boundIdentity);
    if (bindingConflicts) this.cgroupBindings.delete(cgroupKey);
    if (boundIdentity && !bindingConflicts) {
      const entry = this.byId.get(boundIdentity);
      if (entry) {
        this.hits++;
        this.cgroupHits++;
        return this.resultFor(entry);
      }
      this.cgroupBindings.delete(cgroupKey);
    }
    let identity;
    const workload =
      observerEvent?.workload && typeof observerEvent.workload === 'object'
        ? observerEvent.workload
        : {};
    const candidateParts = [
      cgroupKey,
      text(identityInfo.session),
      text(identityInfo.agent),
      text(workload.provider_unit_id),
      text(workload.replica_id),
    ];
    const candidateKey = candidateParts.some(Boolean) ? candidateParts.join('|') : '';
    if (candidateKey && this.candidateCache.has(candidateKey)) {
      identity = this.candidateCache.get(candidateKey);
    } else {
      let identityEvent = observerEvent;
      if (!text(processInfo.cgroup)) {
        const rawPayload = Object.values(observerEvent?.event ?? {})[0];
        const payload = rawPayload && typeof rawPayload === 'object' ? rawPayload : {};
        const candidatePids = [
          Number(processInfo.pid) || Number(payload.pid) || Number(observerEvent?.identity?.task),
          Number(processInfo.ppid) || Number(payload.ppid),
        ].filter((pid, index, values) => Number.isInteger(pid) && pid > 0 && values.indexOf(pid) === index);
        let procCgroup = '';
        for (const pid of candidatePids) {
          this.procCgroupReads++;
          procCgroup = this.readProcCgroup(pid);
          if (procCgroup) break;
        }
        if (procCgroup) {
          identityEvent = {
            ...observerEvent,
            process: {
              ...processInfo,
              cgroup: procCgroup,
            },
          };
        }
      }
      identity = eventIdentityCandidates(identityEvent);
      if (candidateKey) {
        if (this.candidateCache.size >= this.maxEventKeys) {
          const oldest = this.candidateCache.keys().next().value;
          if (oldest) this.candidateCache.delete(oldest);
        }
        this.candidateCache.set(candidateKey, identity);
      }
    }
    if (!identity.containerized) return undefined;
    for (const candidate of identity.candidates) {
      const entry = this.byId.get(candidate);
      if (!entry) continue;
      this.hits++;
      if (cgroupKey) this.cgroupBindings.set(cgroupKey, candidate);
      return this.resultFor(entry);
    }
    this.misses++;
    this.cgroupMisses++;
    // Container evidence without a registry match is never handed to host PID-name heuristics.
    // Metadata may be starting, stale, or temporarily unavailable, so the only safe state is
    // unknown and the event remains observable.
    return {
      state: 'unknown',
      attribution: {
        monitored: false,
        classification: 'unknown',
        confidence: 0,
        reason: 'not_evaluated',
        source: 'none',
        degraded: !this.ready,
        evidence: [this.ready ? 'workload_snapshot:miss' : 'workload_snapshot:not_ready'],
      },
    };
  }

  resultFor(entry) {
    const attribution = attributionFor(entry);
    const platformHealthchecks = entry.platformHealthchecks ?? [];
    const infrastructureFacts = infrastructureFactsFor(entry);
    const role = workloadRole(entry.workloadRole);
    const supplemental = {
      ...(role ? { workloadRole: role } : {}),
      platformHealthchecks,
      infrastructureFacts,
    };
    if (entry.classification === 'confirmed_agent' || entry.classification === 'probable_agent') {
      return { state: 'agent', attribution, ...supplemental };
    }
    if (entry.classification === 'non_agent') {
      return { state: 'non_agent', attribution, ...supplemental };
    }
    return { state: 'unknown', attribution, ...supplemental };
  }

  infrastructureInventory() {
    const seen = new Set();
    const result = [];
    for (const entry of [...this.sources.values()].flat()) {
      const facts = infrastructureFactsFor(entry);
      const key = [facts.type, facts.physicalWorkloadId, facts.cgroupId].join('|');
      if (!facts.physicalWorkloadId || seen.has(key)) continue;
      seen.add(key);
      result.push(facts);
    }
    return result;
  }

  metrics() {
    return {
      ready: this.ready,
      version: this.version,
      ageSeconds: this.updatedAt ? Math.max(0, Math.round((this.now() - this.updatedAt) / 1000)) : -1,
      entries: this.byId.size,
      hits: this.hits,
      misses: this.misses,
      errors: this.errors,
      sources: Object.fromEntries(
        [...this.sourceMetrics.entries()].map(([source, value]) => [
          source,
          {
            ready: value.ready,
            version: value.version,
            entries: this.sources.get(source)?.length ?? 0,
            errors: value.errors,
          },
        ]),
      ),
      candidateCacheEntries: this.candidateCache.size,
      cgroupBindings: this.cgroupBindings.size,
      cgroupHits: this.cgroupHits,
      cgroupMisses: this.cgroupMisses,
      procCgroupReads: this.procCgroupReads,
    };
  }
}

class DiscoveryBudget {
  constructor(options = {}) {
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.limit = Math.max(1, Number(options.limit) || 20);
    this.globalLimit = Math.max(1, Number(options.globalLimit) || 200);
    this.windowMs = Math.max(100, Number(options.windowMs) || 1_000);
    this.maxKeys = Math.max(100, Number(options.maxKeys) || 10_000);
    this.windows = new Map();
    this.globalWindow = { startedAt: 0, count: 0 };
    this.allowed = 0;
    this.suppressed = 0;
  }

  allow(observerEvent, pressure = 0) {
    const identity = eventIdentityCandidates(observerEvent);
    const processInfo = observerEvent?.process && typeof observerEvent.process === 'object'
      ? observerEvent.process
      : {};
    const rawPayload = Object.values(observerEvent?.event ?? {})[0];
    const payload = rawPayload && typeof rawPayload === 'object' ? rawPayload : {};
    const key =
      identity.candidates[0] ||
      text(processInfo.cgroupId) ||
      text(processInfo.cgroup_id) ||
      text(observerEvent?.identity?.agent) ||
      text(processInfo.pid) ||
      text(payload.pid) ||
      'unknown';
    const now = this.now();
    if (!this.globalWindow.startedAt || now - this.globalWindow.startedAt >= this.windowMs) {
      this.globalWindow = { startedAt: now, count: 0 };
    }
    let window = this.windows.get(key);
    if (!window || now - window.startedAt >= this.windowMs) {
      window = { startedAt: now, count: 0 };
      this.windows.set(key, window);
    }
    const normalizedPressure = Math.max(0, Math.min(1, Number(pressure) || 0));
    const effectiveLimit = Math.max(
      1,
      Math.ceil(this.limit * (1 - normalizedPressure * 0.75)),
    );
    const effectiveGlobalLimit = Math.max(
      1,
      Math.ceil(this.globalLimit * (1 - normalizedPressure * 0.75)),
    );
    if (window.count >= effectiveLimit || this.globalWindow.count >= effectiveGlobalLimit) {
      this.suppressed++;
      return false;
    }
    window.count++;
    this.globalWindow.count++;
    this.allowed++;
    if (this.windows.size > this.maxKeys) {
      for (const [candidate, item] of this.windows) {
        if (now - item.startedAt >= this.windowMs) this.windows.delete(candidate);
      }
      while (this.windows.size > this.maxKeys) {
        const oldest = this.windows.keys().next().value;
        if (!oldest) break;
        this.windows.delete(oldest);
      }
    }
    return true;
  }

  metrics() {
    return {
      limit: this.limit,
      globalLimit: this.globalLimit,
      windowMs: this.windowMs,
      keys: this.windows.size,
      allowed: this.allowed,
      suppressed: this.suppressed,
      currentGlobalCount: this.globalWindow.count,
    };
  }
}

module.exports = {
  behaviorDiscoveryEligible,
  classifyEventActivity,
  infrastructureFactsFor,
  DiscoveryBudget,
  WorkloadIdentityCache,
  eventIdentityCandidates,
  normalizedContainerId,
};
