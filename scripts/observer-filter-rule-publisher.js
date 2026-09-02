'use strict';

// Capture-profile publication state lives outside the stable observer-filter-rules compatibility
// entrypoint so the legacy decision API and the additive S5 handshake can evolve independently.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const FILTER_ACTIONS = new Set(['keep', 'sample', 'drop']);
const {
  ALL_FULL_PROBE_ACTIONS,
  SHADOW_SAFE_PROBE_ACTIONS,
  CAPTURE_PROFILE_ACK_SCHEMA,
  CAPTURE_PROFILE_CAPABILITIES,
  CAPTURE_PROFILE_CAPABILITIES_HASH,
  CAPTURE_PROFILE_MODES,
  CAPTURE_PROFILES,
  FILTER_RULE_SNAPSHOT_SCHEMA,
  PROFILE_PROBE_ACTIONS,
  PROBE_NAMES,
  canonicalJson,
  captureIntentHash,
  captureIntentProjection,
  captureProfileActions,
  captureSnapshotContentHash,
  compileCaptureDecision,
  completeMaterializationIdentity,
  digest,
  effectiveActionsHash,
  eventKind,
  isAgentKeepDecision,
  legacyActionForProbeActions,
  normalizedProbeActions,
  previewProbeActions,
  safeDesiredProbeActions,
  supportsCaptureProfileCapabilities,
} = require('./observer-capture-profile-control');
const AUTHORITATIVE_NON_AGENT_SOURCES = new Set([
  'manual_review',
  'kubernetes',
  'docker',
  'self_register',
  'configured_root',
  'docker_label',
  'operator',
  'platform_inventory',
]);

function text(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function boundedNumber(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.round(parsed))) : fallback;
}

function normalizedCgroupId(value) {
  const normalized = text(value);
  if (!/^\d{1,20}$/u.test(normalized)) return '';
  try {
    return BigInt(normalized) > 0n ? normalized : '';
  } catch {
    return '';
  }
}

function eventCgroupId(observerEvent) {
  const processInfo = observerEvent?.process && typeof observerEvent.process === 'object'
    ? observerEvent.process
    : {};
  return normalizedCgroupId(processInfo.cgroupId ?? processInfo.cgroup_id);
}

function authoritativeNonAgent(classification) {
  if (classification?.state === 'infrastructure') return true;
  if (classification?.state !== 'non_agent') return false;
  return AUTHORITATIVE_NON_AGENT_SOURCES.has(text(classification.attribution?.source).toLowerCase());
}

function filterDecision(observerEvent, classification, options = {}) {
  const cgroupId = eventCgroupId(observerEvent);
  if (!cgroupId) return undefined;
  const now = typeof options.now === 'function' ? options.now() : Date.now();
  const ttlMs = boundedNumber(options.ttlMs, 120_000, 1_000, 24 * 60 * 60_000);
  const attribution = classification?.attribution && typeof classification.attribution === 'object'
    ? classification.attribution
    : {};
  const identityClassification = text(attribution.classification)
    || (classification?.state === 'agent'
      ? 'probable_agent'
      : classification?.state === 'non_agent' || classification?.state === 'infrastructure'
        ? 'non_agent'
        : 'unknown');
  const conflict = classification?.workspaceConflict === true || attribution.conflict === true;
  let action = 'sample';
  let authority = 'candidate';
  let reasonCode = 'identity_unknown';
  if (classification?.state === 'agent') {
    action = 'keep';
    authority = identityClassification === 'confirmed_agent' ? 'authoritative' : 'candidate';
    reasonCode = identityClassification === 'confirmed_agent'
      ? 'confirmed_agent'
      : 'probable_agent';
  } else if (authoritativeNonAgent(classification) && !conflict) {
    action = 'drop';
    authority = 'authoritative';
    reasonCode = classification?.state === 'infrastructure'
      ? 'platform_infrastructure'
      : 'confirmed_non_agent';
  } else if (conflict) {
    reasonCode = 'identity_conflict';
  } else if (classification?.state === 'non_agent') {
    authority = 'candidate';
    reasonCode = 'non_agent_unconfirmed';
  }
  return {
    scopeType: 'cgroup',
    scopeKey: `cgroup:${cgroupId}`,
    cgroupId,
    classification: identityClassification,
    authority,
    action,
    reasonCode,
    source: text(attribution.source) || (classification?.state === 'infrastructure' ? 'configured_root' : 'none'),
    ...(text(attribution.physicalWorkloadId) ? { physicalWorkloadId: text(attribution.physicalWorkloadId) } : {}),
    ...(text(attribution.agentInstanceId) ? { agentInstanceId: text(attribution.agentInstanceId) } : {}),
    expiresAt: new Date(now + ttlMs).toISOString(),
  };
}

function decisionRank(decision) {
  if (decision.action === 'keep') return 4;
  if (decision.action === 'drop' && decision.authority === 'authoritative') return 3;
  if (decision.action === 'sample') return 1;
  return 0;
}

function decisionCore(decision) {
  if (!decision) return undefined;
  const { expiresAt: _expiresAt, epoch: _epoch, ruleVersion: _ruleVersion, ...core } = decision;
  return core;
}

function sameDecisionCore(left, right) {
  return JSON.stringify(decisionCore(left)) === JSON.stringify(decisionCore(right));
}

function effectiveAgentKeepDecision(entry, captureProfileMode) {
  // S5 gives probable_agent its own bounded discovery profile, so it must not reserve an
  // agent_full member in shadow/enforce. Legacy snapshots have no profile matrix, however, and
  // historically treated probable Agent KEEP as stronger than a conflicting non-Agent DROP.
  return isAgentKeepDecision(entry)
    || (captureProfileMode === 'legacy' && entry?.classification === 'probable_agent');
}

function captureEntryPriority(entry, captureProfileMode) {
  if (effectiveAgentKeepDecision(entry, captureProfileMode)) return 5;
  if (entry?.captureProfile === 'investigation_full' || entry?.captureProfile === 'security_full') return 4;
  if (entry?.captureProfile === 'unknown_discovery') return 0;
  if (entry?.captureProfile === 'probable_investigation') return 1;
  if (entry?.captureProfile === 'business_context') return 2;
  if (
    entry?.captureProfile === 'infrastructure_aggregate'
    || entry?.captureProfile === 'self_health'
    || Object.values(safeDesiredProbeActions(entry ?? {})).includes('drop')
  ) return 3;
  return 1;
}

function implicitDiscoveryDefault(entry) {
  const hasStableRootIdentity = Number.isSafeInteger(Number(entry?.rootPid))
    && Number(entry.rootPid) > 0
    && Boolean(text(entry?.rootProcessKey));
  return (
    !text(entry?.ruleId)
    && entry?.conflict !== true
    && !text(entry?.promotionReason)
    // A root ProcessKey is stable for the lifetime of the Agent process. Do not collapse such a
    // candidate back to the Unknown/default matrix merely because an exec-generation field was
    // absent on a network event; doing so makes a long-lived CLI lose later TLS turns when the
    // short profile lease expires. PID/start-time fencing remains the authority for reuse.
    && !hasStableRootIdentity
    && !isAgentKeepDecision(entry)
    && entry?.captureProfile !== 'investigation_full'
    && !(entry?.captureProfile === 'probable_investigation'
      && safeDesiredProbeActions(entry).file_read === 'full')
  );
}

class FilterRulePublisher {
  constructor(options = {}) {
    this.file = text(options.file);
    this.ackFile = text(options.ackFile);
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.fs = options.fs || fs;
    this.flushIntervalMs = boundedNumber(options.flushIntervalMs, 100, 10, 5_000);
    this.ttlMs = boundedNumber(options.ttlMs, 120_000, 1_000, 24 * 60 * 60_000);
    // A same-intent lease refresh still needs Preview -> ACK -> Central -> Grant because the wire
    // epoch/content/expiry change. Starting that handshake at half TTL made a 5-second policy poll
    // revoke the node grant every minute. Keep a bounded safety lead instead: Preview is still
    // mandatory, but stable authority is not refreshed substantially earlier than necessary.
    this.ttlRefreshLeadMs = boundedNumber(
      options.ttlRefreshLeadMs,
      Math.min(15_000, Math.max(1_000, Math.floor(this.ttlMs / 4))),
      1_000,
      Math.max(1_000, this.ttlMs - 1_000),
    );
    this.probableTtlMs = boundedNumber(options.probableTtlMs, 120_000, 1_000, 10 * 60_000);
    this.lkgTtlMs = boundedNumber(options.lkgTtlMs, 600_000, this.ttlMs, 24 * 60 * 60_000);
    this.ackMaxAgeMs = boundedNumber(options.ackMaxAgeMs, 120_000, 1_000, 24 * 60 * 60_000);
    this.maxEntries = boundedNumber(options.maxEntries, 50_000, 100, 1_000_000);
    this.maxProbableEntries = boundedNumber(options.maxProbableEntries, 4_096, 16, this.maxEntries);
    this.maxSnapshotBytes = boundedNumber(options.maxSnapshotBytes, 4 * 1024 * 1024, 64 * 1024, 4 * 1024 * 1024);
    this.enforceDrops = options.enforceDrops !== false;
    this.captureProfileMode = CAPTURE_PROFILE_MODES.has(options.captureProfileMode)
      ? options.captureProfileMode
      : 'legacy';
    this.publisherInstanceId = text(options.publisherInstanceId) || crypto.randomUUID();
    const configuredNodeId = text(options.nodeId);
    const configuredCollectorId = text(options.collectorId);
    this.nodeId = configuredNodeId || configuredCollectorId;
    this.collectorId = configuredCollectorId || configuredNodeId;
    this.hostBootId = text(options.hostBootId);
    this.entries = new Map();
    this.pendingExpiryRefreshes = new Map();
    this.version = this.captureProfileMode === 'legacy' ? 0 : Math.floor(this.now() * 1_000);
    this.timer = undefined;
    this.dirty = false;
    this.synchronizedPolicyVersion = undefined;
    this.activationMode = this.captureProfileMode === 'shadow' ? 'shadow' : 'preview';
    this.activationReason = this.captureProfileMode === 'enforce' ? 'awaiting_preview_ack' : 'rollout_mode';
    this.activationGrant = undefined;
    this.lastPublishedSnapshot = undefined;
    this.lastAck = undefined;
    this.pendingPreviewAck = undefined;
    this.pinnedPreviewGeneration = undefined;
    this.lastAckFingerprint = '';
    this.controlPlaneState = 'ready';
    // A process start is not a successful control-plane observation. This value is persisted in
    // S5 snapshots so repeated Forwarder restarts cannot slide an old policy's LKG deadline.
    this.lastGoodAt = 0;
    this.lkgExpiresAt = 0;
    this.stats = {
      observed: 0,
      changed: 0,
      writes: 0,
      errors: 0,
      conflicts: 0,
      evicted: 0,
      restored: 0,
      restoreErrors: 0,
      ackReads: 0,
      ackAccepted: 0,
      ackRejected: 0,
      ackReplayIgnored: 0,
      centralAccepted: 0,
      centralRejected: 0,
      activationGrants: 0,
      activationRevoked: 0,
      intentChanges: 0,
      ttlRefreshes: 0,
      coalescedTtlRefreshes: 0,
      semanticNoops: 0,
      lkgDegraded: 0,
      capacityEvicted: 0,
      capacityAgentEvicted: 0,
      probableCapacityEvicted: 0,
      oversizeSnapshots: 0,
    };
    if (this.captureProfileMode !== 'legacy' && this.ackFile && typeof this.fs.readFileSync === 'function') {
      try {
        const previousAck = JSON.parse(this.fs.readFileSync(this.ackFile, 'utf8'));
        const ackEpoch = Number(previousAck?.epoch);
        if (Number.isSafeInteger(ackEpoch) && ackEpoch >= this.version) this.version = ackEpoch + 1;
      } catch {}
    }
    this.restoreExistingSnapshot();
    // S5 migration is safety-sensitive: rewrite a restored legacy drop as a safe shadow/preview
    // synchronously. The Collector also receives captureProfileMode and must reject legacy DROP
    // while S5 is enabled, closing the small co-process startup race.
    if (this.dirty && this.captureProfileMode !== 'legacy') this.flush();
    else if (this.dirty) this.schedule();
  }

  restoreExistingSnapshot() {
    if (!this.file || typeof this.fs.readFileSync !== 'function') return;
    try {
      const document = JSON.parse(this.fs.readFileSync(this.file, 'utf8'));
      if (document?.schemaVersion !== FILTER_RULE_SNAPSHOT_SCHEMA || !Array.isArray(document.entries)) {
        throw new Error('unsupported filter snapshot');
      }
      const epoch = Number(document.epoch ?? document.version);
      if (!Number.isSafeInteger(epoch) || epoch <= 0) throw new Error('invalid filter snapshot epoch');
      this.version = this.captureProfileMode === 'legacy' ? epoch : Math.max(this.version, epoch + 1);
      const now = this.now();
      if (this.captureProfileMode !== 'legacy') {
        const generatedAt = Date.parse(text(document.generatedAt));
        const explicitLastGoodAt = Date.parse(text(document.lastControlPlaneGoodAt));
        const policyVersion = Number(document.policyVersion);
        const hashValid = Boolean(text(document.contentHash))
          && captureSnapshotContentHash(document) === text(document.contentHash);
        const generatedValid = Number.isFinite(generatedAt) && generatedAt > 0 && generatedAt <= now;
        const policyValid = Number.isSafeInteger(policyVersion) && policyVersion >= 0;
        if (
          hashValid
          && generatedValid
          && policyValid
          && Number.isFinite(explicitLastGoodAt)
          && explicitLastGoodAt > 0
          && explicitLastGoodAt <= generatedAt
          && explicitLastGoodAt <= now
        ) {
          this.lastGoodAt = explicitLastGoodAt;
        } else if (
          hashValid
          && generatedValid
          && policyValid
          && document.lastControlPlaneGoodAt === undefined
        ) {
          // One-time compatibility baseline for pre-field S5 snapshots. The next write persists
          // this original generation time, preventing subsequent restarts from moving it again.
          this.lastGoodAt = generatedAt;
        }
      }
      for (const entry of document.entries.slice(0, this.maxEntries)) {
        const cgroupId = normalizedCgroupId(entry?.cgroupId);
        const scopeKey = text(entry?.scopeKey);
        const expiresAt = Date.parse(text(entry?.expiresAt));
        if (
          !cgroupId || scopeKey !== `cgroup:${cgroupId}`
          || !FILTER_ACTIONS.has(entry?.action)
          || !['authoritative', 'candidate'].includes(entry?.authority)
          || !Number.isFinite(expiresAt) || expiresAt <= now
        ) continue;
        let restored = { ...entry, cgroupId, scopeKey };
        if (this.captureProfileMode !== 'legacy') {
          const profile = CAPTURE_PROFILES.has(entry.captureProfile)
            ? entry.captureProfile
            : entry.action === 'keep' ? 'agent_full' : 'unknown_discovery';
          const desired = normalizedProbeActions(
            entry.desiredProbeActions ?? entry.probeActions,
            captureProfileActions(profile),
          );
          restored = {
            ...restored,
            captureProfile: profile,
            desiredProbeActions: desired,
            policyAction: FILTER_ACTIONS.has(entry.policyAction) ? entry.policyAction : entry.action,
            ttlMs: boundedNumber(entry.ttlMs, this.ttlMs, 1_000, 24 * 60 * 60_000),
          };
          if (profile === 'probable_investigation') {
            restored.ttlMs = Math.min(restored.ttlMs, this.probableTtlMs);
            restored.expiresAt = new Date(Math.min(expiresAt, now + this.probableTtlMs)).toISOString();
          }
          restored.desiredProbeActions = safeDesiredProbeActions(restored);
        }
        if (this.captureProfileMode !== 'legacy' && implicitDiscoveryDefault(restored)) continue;
        this.entries.set(scopeKey, restored);
        this.stats.restored++;
      }
      if (this.captureProfileMode !== 'legacy' && this.entries.size) {
        // A restarted Forwarder has a new publisherInstanceId. Republish a monotonic preview so an
        // ACK or grant from the previous process generation cannot be replayed.
        this.dirty = true;
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') this.stats.restoreErrors++;
    }
  }

  observe(observerEvent, classification, resolvedDecision) {
    if (!this.file) return undefined;
    const derived = filterDecision(observerEvent, classification, { now: this.now, ttlMs: this.ttlMs });
    let next = resolvedDecision && typeof resolvedDecision === 'object'
      ? { ...resolvedDecision }
      : derived;
    if (derived?.action === 'keep') next = derived;
    if (!next) return undefined;
    const cgroupId = eventCgroupId(observerEvent) || normalizedCgroupId(next.cgroupId);
    if (this.captureProfileMode !== 'legacy') {
      // SecurityAction is already FULL and unfilterable in every closed profile matrix. A raw
      // action must not automatically turn a probable/Unknown/Infrastructure cgroup into
      // investigation_full: that violates the bounded probable profile and lets short-lived
      // system cgroups continuously revoke the node grant. Investigation remains an explicit
      // control-plane/risk decision rather than an event-local side effect.
      next = compileCaptureDecision(observerEvent, classification, next, {
        now: this.now,
        ttlMs: this.ttlMs,
        probableTtlMs: this.probableTtlMs,
        captureProfileMode: this.captureProfileMode,
        activationMode: this.activationMode,
      });
    }
    return this.observeDecision(next);
  }

  observeDecision(input) {
    if (!this.file) return undefined;
    let next = input && typeof input === 'object' ? { ...input } : undefined;
    if (!next || !FILTER_ACTIONS.has(next.action)) return undefined;
    const cgroupId = normalizedCgroupId(next.cgroupId);
    if (!cgroupId) return undefined;
    next.cgroupId = cgroupId;
    next.scopeType = 'cgroup';
    next.scopeKey = `cgroup:${cgroupId}`;
    if (!['authoritative', 'candidate'].includes(next.authority)) next.authority = 'candidate';
    const expiresAt = Date.parse(text(next.expiresAt));
    if (!Number.isFinite(expiresAt) || expiresAt <= this.now()) {
      next.expiresAt = new Date(this.now() + this.ttlMs).toISOString();
    }
    if (next.action === 'drop' && !this.enforceDrops) {
      next = {
        ...next,
        action: 'sample',
        policyAction: 'sample',
        wouldAction: 'drop',
        reasonCode: text(next.reasonCode).startsWith('shadow_')
          ? text(next.reasonCode)
          : `shadow_${text(next.reasonCode) || 'platform_infrastructure'}`,
      };
    }
    if (this.captureProfileMode !== 'legacy' && !next.desiredProbeActions) {
      const syntheticClassification = isAgentKeepDecision(next)
        ? { state: 'agent', attribution: { classification: next.classification || 'probable_agent' } }
        : next.ruleId
          ? { state: 'infrastructure', attribution: { classification: 'non_agent', source: next.source } }
          : { state: 'unknown', attribution: { classification: next.classification || 'unknown' } };
      next = compileCaptureDecision(
        { process: { cgroupId }, event: { FileAccess: {} } },
        syntheticClassification,
        next,
        {
          now: this.now,
          ttlMs: this.ttlMs,
          probableTtlMs: this.probableTtlMs,
          captureProfileMode: this.captureProfileMode,
          activationMode: this.activationMode,
        },
      );
    }
    if (this.captureProfileMode !== 'legacy') {
      next.policyAction = FILTER_ACTIONS.has(next.policyAction) ? next.policyAction : input.action;
      next.ttlMs = boundedNumber(next.ttlMs, this.ttlMs, 1_000, 24 * 60 * 60_000);
      if (next.captureProfile === 'probable_investigation') {
        next.ttlMs = Math.min(next.ttlMs, this.probableTtlMs);
        const expiresAtMs = Date.parse(next.expiresAt);
        next.expiresAt = new Date(Math.min(
          Number.isFinite(expiresAtMs) ? expiresAtMs : this.now() + next.ttlMs,
          this.now() + next.ttlMs,
        )).toISOString();
      }
      next.desiredProbeActions = safeDesiredProbeActions(next);
    }
    this.stats.observed++;
    const previous = this.entries.get(next.scopeKey);
    if (this.captureProfileMode !== 'legacy' && implicitDiscoveryDefault(next)) {
      // The kernel's node default is exactly the fixed Unknown/probable SAMPLE matrix. Publishing
      // one identical rule for every short-lived cgroup creates policy-epoch churn and can starve
      // Preview→ACK→Grant forever. Keep a stronger existing fact until its TTL; otherwise omit the
      // redundant member entry and let generation-safe kernel defaults handle the scope.
      if (previous && !implicitDiscoveryDefault(previous) && Date.parse(previous.expiresAt) > this.now()) {
        return { ...previous, ruleVersion: this.version };
      }
      if (previous && this.entries.delete(next.scopeKey)) {
        this.pendingExpiryRefreshes.delete(next.scopeKey);
        this.version++;
        this.stats.changed++;
        this.dirty = true;
        this.revokeActivation('discovery_scope_uses_default', false);
        this.schedule();
      }
      return { ...next, implicitDefault: true, ruleVersion: this.version };
    }
    if (
      previous
      && text(previous.rootProcessKey)
      && text(previous.rootProcessKey) === text(next.rootProcessKey)
    ) {
      for (const field of ['rootPid', 'rootGeneration', 'rootExecId', 'rootExecIdExact']) {
        if (next[field] === undefined && previous[field] !== undefined) next[field] = previous[field];
      }
    }
    const previousExpired = previous && Date.parse(previous.expiresAt) <= this.now();
    const centralPolicyDecision = Number.isSafeInteger(Number(next.documentVersion)) || Boolean(text(next.ruleId));
    const previousCentralPolicy = Boolean(
      text(previous?.ruleId)
      && Number.isSafeInteger(Number(previous?.ruleRevision))
      && previous?.authority === 'authoritative',
    );
    let selected = next;
    if (previous && !previousExpired) {
      const previousAgent = effectiveAgentKeepDecision(previous, this.captureProfileMode);
      const nextAgent = effectiveAgentKeepDecision(next, this.captureProfileMode);
      if (previousAgent || nextAgent) {
        if (previousAgent !== nextAgent || previous.captureProfile !== next.captureProfile) this.stats.conflicts++;
        if (previousAgent && nextAgent && this.captureProfileMode === 'legacy'
          && previous.action === next.action && previous.authority === next.authority) {
          selected = { ...previous, expiresAt: next.expiresAt };
        } else {
          selected = nextAgent ? next : previous;
        }
        if (previousAgent !== nextAgent) {
          selected = {
            ...selected,
            action: this.captureProfileMode === 'legacy' ? 'keep' : selected.action,
            policyAction: 'keep',
            captureProfile: this.captureProfileMode === 'legacy' ? selected.captureProfile : 'agent_full',
            desiredProbeActions: this.captureProfileMode === 'legacy'
              ? selected.desiredProbeActions
              : { ...ALL_FULL_PROBE_ACTIONS },
            authority: selected.authority === 'authoritative' ? 'authoritative' : 'candidate',
            reasonCode: 'conflict_keep_preferred',
            conflict: true,
            expiresAt: new Date(this.now() + this.ttlMs).toISOString(),
          };
        }
      } else if (previousCentralPolicy && !centralPolicyDecision) {
        // An event-local role/default observation cannot replace an unexpired, exact central
        // materialization for the same cgroup. Confirmed Agent/conflict and Investigation paths
        // were handled above; preserving the policy here prevents per-event profile oscillation.
        selected = previous;
      } else if (centralPolicyDecision) {
        selected = next;
      } else if (this.captureProfileMode === 'legacy' && decisionRank(previous) > decisionRank(next)) {
        selected = { ...previous, expiresAt: next.expiresAt };
      } else if (
        this.captureProfileMode === 'legacy'
          ? previous.action === next.action && previous.authority === next.authority
          : canonicalJson(captureIntentProjection([previous], previous.policyVersion))
            === canonicalJson(captureIntentProjection([next], next.policyVersion))
      ) {
        selected = { ...previous, expiresAt: next.expiresAt };
      }
    }
    const intentChanged = this.captureProfileMode === 'legacy'
      ? !sameDecisionCore(previous, selected)
      : canonicalJson(captureIntentProjection(previous ? [previous] : [], previous?.policyVersion))
        !== canonicalJson(captureIntentProjection([selected], selected.policyVersion));
    const previousExpiresAt = previous ? Date.parse(previous.expiresAt) : Number.NaN;
    const selectedExpiresAt = Date.parse(selected.expiresAt);
    const refreshDue = previous
      && previousExpiresAt - this.now() <= this.ttlRefreshLeadMs
      && Number.isFinite(selectedExpiresAt)
      && selectedExpiresAt > previousExpiresAt;
    if (
      previous
      && !intentChanged
      && !refreshDue
      && Number.isFinite(selectedExpiresAt)
      && selectedExpiresAt > previousExpiresAt
    ) {
      const pending = this.pendingExpiryRefreshes.get(selected.scopeKey) ?? 0;
      if (selectedExpiresAt > pending) this.pendingExpiryRefreshes.set(selected.scopeKey, selectedExpiresAt);
    }
    if (intentChanged || refreshDue) {
      this.pendingExpiryRefreshes.delete(selected.scopeKey);
      this.entries.set(selected.scopeKey, selected);
      this.version++;
      this.stats.changed++;
      this.dirty = true;
      if (intentChanged) {
        this.stats.intentChanges++;
        this.revokeActivation('intent_changed', false);
      }
      else if (refreshDue && this.activationMode === 'enforce') {
        // Grants bind one exact preview epoch/content. A TTL-only wire refresh changes both, so it
        // must start another safe preview instead of reusing a grant the Collector will reject.
        this.revokeActivation('ttl_refresh_requires_preview', false);
      }
      if (refreshDue) this.stats.ttlRefreshes++;
      this.stats.coalescedTtlRefreshes += this.applyPendingExpiryRefreshes();
      this.prune(false);
      this.schedule();
    } else if (previous) {
      this.stats.semanticNoops++;
    }
    return { ...(this.entries.get(selected.scopeKey) ?? selected), ruleVersion: this.version };
  }

  applyPendingExpiryRefreshes() {
    if (this.controlPlaneState !== 'ready' || !this.pendingExpiryRefreshes.size) return 0;
    const now = this.now();
    let applied = 0;
    for (const [scopeKey, pendingExpiresAt] of this.pendingExpiryRefreshes) {
      this.pendingExpiryRefreshes.delete(scopeKey);
      const entry = this.entries.get(scopeKey);
      if (!entry || !Number.isFinite(pendingExpiresAt) || pendingExpiresAt <= now) continue;
      const currentExpiresAt = Date.parse(entry.expiresAt);
      if (Number.isFinite(currentExpiresAt) && pendingExpiresAt <= currentExpiresAt) continue;
      this.entries.set(scopeKey, {
        ...entry,
        expiresAt: new Date(pendingExpiresAt).toISOString(),
      });
      applied++;
    }
    return applied;
  }

  synchronizePolicyDecisions(decisions, policyVersion) {
    if (!this.file) return { removed: 0, applied: 0 };
    const rawInputs = Array.isArray(decisions) ? decisions : [];
    const now = this.now();
    const centralExpiries = rawInputs
      .filter((decision) => text(decision?.ruleId))
      .map((decision) => Date.parse(text(decision?.expiresAt)))
      .filter((expiresAt) => Number.isFinite(expiresAt) && expiresAt > now);
    // One inventory/policy synchronization is one node intent. Align its exact Central bindings
    // to the earliest existing expiry: this never extends authority, but prevents a few seconds of
    // discovery skew from producing one Preview/ACK/Grant cycle per scope group.
    const alignedCentralExpiresAt = centralExpiries.length
      ? new Date(Math.min(...centralExpiries)).toISOString()
      : '';
    const inputs = rawInputs.map((decision) =>
      alignedCentralExpiresAt && text(decision?.ruleId)
        ? { ...decision, expiresAt: alignedCentralExpiresAt }
        : decision);
    const activeScopes = new Set(inputs.map((decision) => text(decision?.scopeKey)).filter(Boolean));
    const versionChanged = this.synchronizedPolicyVersion !== policyVersion;
    let removed = 0;
    if (versionChanged) {
      for (const [scopeKey, entry] of this.entries) {
        if (entry.policyVersion === undefined || activeScopes.has(scopeKey)) continue;
        this.entries.delete(scopeKey);
        this.pendingExpiryRefreshes.delete(scopeKey);
        removed++;
      }
      this.synchronizedPolicyVersion = policyVersion;
    }
    if (removed) {
      this.version++;
      this.stats.changed += removed;
      this.dirty = true;
      this.revokeActivation('policy_scope_changed', false);
    }
    if (this.captureProfileMode !== 'legacy') {
      // Stage every same-intent expiry before applying the first due member. That first member can
      // then publish one node-wide Preview carrying the freshest independently observed lease for
      // Agent/Investigation and all Central scopes, instead of a second staggered refresh.
      for (const decision of inputs) {
        const scopeKey = text(decision?.scopeKey);
        const previous = this.entries.get(scopeKey);
        if (!previous) continue;
        const next = { ...decision, policyVersion };
        const sameIntent = canonicalJson(captureIntentProjection([previous], previous.policyVersion))
          === canonicalJson(captureIntentProjection([next], next.policyVersion));
        const nextExpiresAt = Date.parse(text(next.expiresAt));
        const previousExpiresAt = Date.parse(text(previous.expiresAt));
        if (!sameIntent || !Number.isFinite(nextExpiresAt) || nextExpiresAt <= previousExpiresAt) continue;
        const pending = this.pendingExpiryRefreshes.get(scopeKey) ?? 0;
        if (nextExpiresAt > pending) this.pendingExpiryRefreshes.set(scopeKey, nextExpiresAt);
      }
    }
    let applied = 0;
    for (const decision of inputs) {
      const result = this.observeDecision({ ...decision, policyVersion });
      if (result) applied++;
    }
    if (this.dirty) this.schedule();
    return { removed, applied };
  }

  degradeToLastKnownGood(reason = 'control_plane_unavailable') {
    if (this.captureProfileMode === 'legacy' || !this.entries.size) return false;
    if (this.controlPlaneState === 'lkg_degraded') {
      if (this.lkgExpiresAt <= this.now()) this.refreshSafety();
      return false;
    }
    const now = this.now();
    this.lkgExpiresAt = this.lastGoodAt > 0 ? this.lastGoodAt + this.lkgTtlMs : now;
    if (this.lkgExpiresAt <= now) {
      const removed = this.entries.size;
      this.entries.clear();
      this.pendingExpiryRefreshes.clear();
      this.stats.evicted += removed;
      this.stats.changed += removed + 1;
      this.controlPlaneState = 'lkg_degraded';
      this.revokeActivation('control_plane_unavailable', false);
      this.version++;
      this.stats.lkgDegraded++;
      this.dirty = true;
      this.schedule();
      return true;
    }
    const expiresAt = new Date(this.lkgExpiresAt).toISOString();
    let changed = true;
    this.controlPlaneState = 'lkg_degraded';
    this.pendingExpiryRefreshes.clear();
    for (const [scopeKey, entry] of this.entries) {
      if (entry.expiresAt !== expiresAt || entry.controlState !== 'lkg_degraded') {
        this.entries.set(scopeKey, {
          ...entry,
          expiresAt,
          controlState: 'lkg_degraded',
          degradationReason: text(reason) || 'control_plane_unavailable',
        });
        changed = true;
      }
    }
    if (!changed) return false;
    this.revokeActivation('control_plane_unavailable', false);
    this.version++;
    this.stats.changed++;
    this.stats.lkgDegraded++;
    this.dirty = true;
    this.schedule();
    return true;
  }

  markControlPlaneReady() {
    this.controlPlaneState = 'ready';
    this.lastGoodAt = this.now();
    this.lkgExpiresAt = 0;
  }

  revokeActivation(reason, advanceVersion = true) {
    if (this.captureProfileMode !== 'enforce') return false;
    const changed = this.activationMode === 'enforce' || Boolean(this.activationGrant);
    this.activationMode = 'preview';
    this.activationReason = text(reason) || 'awaiting_preview_ack';
    this.activationGrant = undefined;
    this.pendingPreviewAck = undefined;
    this.pinnedPreviewGeneration = undefined;
    if (changed) {
      this.stats.activationRevoked++;
      if (advanceVersion) {
        this.version++;
        this.stats.changed++;
        this.dirty = true;
        this.schedule();
      }
    }
    return changed;
  }

  refreshSafety() {
    const before = this.entries.size;
    this.prune(true);
    if (this.activationGrant && Date.parse(this.activationGrant.expiresAt) <= this.now()) {
      this.revokeActivation('activation_grant_expired');
    }
    if (before !== this.entries.size || this.dirty) this.schedule();
  }

  prune(advanceVersion = true) {
    const now = this.now();
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (Date.parse(entry.expiresAt) <= now) {
        this.entries.delete(key);
        this.pendingExpiryRefreshes.delete(key);
        this.stats.evicted++;
        removed++;
      }
    }
    while ([...this.entries.values()].filter((entry) => entry.captureProfile === 'probable_investigation').length > this.maxProbableEntries) {
      const candidate = [...this.entries.entries()].find(([, entry]) => entry.captureProfile === 'probable_investigation');
      if (!candidate) break;
      this.entries.delete(candidate[0]);
      this.pendingExpiryRefreshes.delete(candidate[0]);
      this.stats.evicted++;
      this.stats.capacityEvicted++;
      this.stats.probableCapacityEvicted++;
      removed++;
    }
    while (this.entries.size > this.maxEntries) {
      const candidate = [...this.entries.entries()]
        .map(([scopeKey, entry], insertionOrder) => ({
          scopeKey,
          priority: captureEntryPriority(entry, this.captureProfileMode),
          insertionOrder,
        }))
        .sort((left, right) => left.priority - right.priority || left.insertionOrder - right.insertionOrder)[0];
      if (!candidate) break;
      this.entries.delete(candidate.scopeKey);
      this.pendingExpiryRefreshes.delete(candidate.scopeKey);
      this.stats.evicted++;
      removed++;
    }
    if (removed) {
      if (advanceVersion) this.version++;
      this.stats.changed += removed;
      this.dirty = true;
      this.revokeActivation('scope_expired', false);
    }
    return removed;
  }

  schedule() {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, this.flushIntervalMs);
    this.timer.unref?.();
  }

  wireEntry(entry, envelopeExpiresAt = Number.POSITIVE_INFINITY) {
    if (this.captureProfileMode === 'legacy') return { ...entry, epoch: this.version };
    const desiredProbeActions = safeDesiredProbeActions(entry);
    const probeActions = this.captureProfileMode === 'shadow'
      ? { ...SHADOW_SAFE_PROBE_ACTIONS }
      : this.activationMode === 'enforce' && this.activationGrant
        ? { ...desiredProbeActions }
        : previewProbeActions(desiredProbeActions);
    const { policyAction: _policyAction, ...wire } = entry;
    const grantExpiresAt = this.activationMode === 'enforce' && this.activationGrant
      ? Date.parse(this.activationGrant.expiresAt)
      : Number.POSITIVE_INFINITY;
    const entryExpiresAt = Date.parse(entry.expiresAt);
    return {
      ...wire,
      action: this.captureProfileMode === 'shadow' ? 'keep' : legacyActionForProbeActions(probeActions),
      desiredAction: entry.policyAction,
      probeActions,
      desiredProbeActions,
      expiresAt: new Date(Math.min(
        Number.isFinite(entryExpiresAt) ? entryExpiresAt : this.now() + this.ttlMs,
        grantExpiresAt,
        envelopeExpiresAt,
      )).toISOString(),
      epoch: this.version,
    };
  }

  enforceSnapshotByteBudget() {
    if (this.captureProfileMode === 'legacy' || !this.entries.size) return 0;
    // Reserve bounded space for the envelope, hashes, grant, and JSON separators. Entry sizes are
    // measured using the actual wire representation, so the resulting document remains below the
    // Collector's 4 MiB default parser ceiling without truncating JSON.
    const envelopeReserve = Math.min(128 * 1024, Math.floor(this.maxSnapshotBytes / 4));
    const targetEntryBytes = this.maxSnapshotBytes - envelopeReserve;
    const candidates = [...this.entries.values()].map((entry, insertionOrder) => {
      const wire = this.wireEntry(entry);
      return {
        scopeKey: entry.scopeKey,
        bytes: Buffer.byteLength(JSON.stringify(wire)) + 1,
        priority: captureEntryPriority(entry, this.captureProfileMode),
        insertionOrder,
        agent: effectiveAgentKeepDecision(entry, this.captureProfileMode),
      };
    });
    let bytes = candidates.reduce((total, candidate) => total + candidate.bytes, 0);
    if (bytes <= targetEntryBytes) return 0;
    this.stats.oversizeSnapshots++;
    candidates.sort((left, right) =>
      left.priority - right.priority || left.insertionOrder - right.insertionOrder);
    let removed = 0;
    for (const candidate of candidates) {
      if (bytes <= targetEntryBytes) break;
      if (!this.entries.delete(candidate.scopeKey)) continue;
      this.pendingExpiryRefreshes.delete(candidate.scopeKey);
      bytes -= candidate.bytes;
      removed++;
      this.stats.capacityEvicted++;
      if (candidate.agent) this.stats.capacityAgentEvicted++;
    }
    if (removed) {
      this.version++;
      this.stats.changed += removed;
      this.dirty = true;
      this.revokeActivation('snapshot_capacity', false);
    }
    return removed;
  }

  snapshot() {
    this.refreshSafety();
    this.enforceSnapshotByteBudget();
    const generatedAt = new Date(this.now()).toISOString();
    const storedEntries = [...this.entries.values()]
      .sort((left, right) => left.scopeKey < right.scopeKey ? -1 : left.scopeKey > right.scopeKey ? 1 : 0);
    const envelopeExpiresAt = Math.min(
      this.now() + this.ttlMs,
      this.activationMode === 'enforce' && this.activationGrant
        ? Date.parse(this.activationGrant.expiresAt)
        : Number.POSITIVE_INFINITY,
    );
    const entries = storedEntries.map((entry) => this.wireEntry(entry, envelopeExpiresAt));
    if (this.captureProfileMode === 'legacy') {
      return {
        schemaVersion: FILTER_RULE_SNAPSHOT_SCHEMA,
        version: this.version,
        epoch: this.version,
        generatedAt,
        entries,
      };
    }
    const policyVersion = Number.isSafeInteger(Number(this.synchronizedPolicyVersion))
      ? Number(this.synchronizedPolicyVersion)
      : Math.max(0, ...storedEntries.map((entry) => Number(entry.policyVersion) || 0));
    const intentHash = captureIntentHash(storedEntries, policyVersion);
    const snapshot = {
      schemaVersion: FILTER_RULE_SNAPSHOT_SCHEMA,
      captureProfileMode: this.captureProfileMode,
      version: this.version,
      epoch: this.version,
      policyVersion,
      publisherInstanceId: this.publisherInstanceId,
      generatedAt,
      expiresAt: new Date(envelopeExpiresAt).toISOString(),
      expectedEntries: entries.length,
      expectedCapabilitiesHash: CAPTURE_PROFILE_CAPABILITIES_HASH,
      effectiveActionsHash: effectiveActionsHash(entries),
      intentHash,
      controlPlaneState: this.controlPlaneState,
      ...(this.lastGoodAt > 0
        ? { lastControlPlaneGoodAt: new Date(this.lastGoodAt).toISOString() }
        : {}),
      activation: {
        mode: this.captureProfileMode === 'shadow' ? 'shadow' : this.activationMode,
        reason: this.activationReason,
      },
      ...(this.activationMode === 'enforce' && this.activationGrant
        ? { activationGrant: { ...this.activationGrant } }
        : {}),
      entries,
    };
    return { ...snapshot, contentHash: captureSnapshotContentHash(snapshot) };
  }

  publishedSnapshot() {
    return this.lastPublishedSnapshot;
  }

  flush() {
    if (!this.file || !this.dirty) return false;
    try {
      const directory = path.dirname(this.file);
      this.fs.mkdirSync(directory, { recursive: true, mode: 0o750 });
      let snapshot = this.snapshot();
      let serialized = `${JSON.stringify(snapshot)}\n`;
      while (Buffer.byteLength(serialized) > this.maxSnapshotBytes && this.entries.size) {
        this.stats.oversizeSnapshots++;
        const candidates = [...this.entries.values()].sort((left, right) => {
          return captureEntryPriority(left, this.captureProfileMode)
            - captureEntryPriority(right, this.captureProfileMode);
        });
        const evicted = candidates[0];
        if (!evicted || !this.entries.delete(evicted.scopeKey)) break;
        this.pendingExpiryRefreshes.delete(evicted.scopeKey);
        this.stats.capacityEvicted++;
        if (effectiveAgentKeepDecision(evicted, this.captureProfileMode)) {
          this.stats.capacityAgentEvicted++;
        }
        this.version++;
        this.stats.changed++;
        this.revokeActivation('snapshot_capacity', false);
        snapshot = this.snapshot();
        serialized = `${JSON.stringify(snapshot)}\n`;
      }
      if (Buffer.byteLength(serialized) > this.maxSnapshotBytes) {
        throw new Error(`filter snapshot exceeds ${this.maxSnapshotBytes} bytes`);
      }
      const temporary = `${this.file}.tmp-${process.pid}`;
      this.fs.writeFileSync(temporary, serialized, { mode: 0o640 });
      this.fs.renameSync(temporary, this.file);
      this.lastPublishedSnapshot = snapshot;
      this.dirty = false;
      this.stats.writes++;
      return true;
    } catch {
      this.stats.errors++;
      return false;
    }
  }

  validateAck(ack, snapshot = this.lastPublishedSnapshot) {
    const reject = (reason) => ({ ok: false, reason });
    if (this.captureProfileMode === 'legacy') return reject('capture_profile_legacy');
    if (!snapshot || snapshot.schemaVersion !== FILTER_RULE_SNAPSHOT_SCHEMA) return reject('snapshot_not_published');
    if (captureSnapshotContentHash(snapshot) !== snapshot.contentHash) return reject('snapshot_hash_invalid');
    if (!ack || ack.schemaVersion !== CAPTURE_PROFILE_ACK_SCHEMA) return reject('ack_schema_invalid');
    if (ack.status !== 'applied') return reject('ack_not_applied');
    if (!Array.isArray(ack.errors) || ack.errors.length !== 0) return reject('ack_has_errors');
    if (!Array.isArray(ack.downgrades) || ack.downgrades.length !== 0) return reject('ack_has_downgrades');
    if (!this.nodeId || text(ack.nodeId) !== this.nodeId) return reject('ack_node_mismatch');
    if (!this.collectorId || text(ack.collectorId) !== this.collectorId) return reject('ack_collector_mismatch');
    if (!text(ack.collectorInstanceId)) return reject('ack_collector_instance_missing');
    if (!this.hostBootId || text(ack.hostBootId) !== this.hostBootId) return reject('ack_boot_mismatch');
    if (text(ack.publisherInstanceId) !== this.publisherInstanceId) return reject('ack_publisher_mismatch');
    if (Number(ack.epoch) !== snapshot.epoch) return reject('ack_epoch_mismatch');
    if (Number(ack.policyVersion) !== snapshot.policyVersion) return reject('ack_policy_mismatch');
    if (text(ack.contentHash) !== snapshot.contentHash) return reject('ack_content_hash_mismatch');
    if (text(ack.intentHash) !== snapshot.intentHash) return reject('ack_intent_hash_mismatch');
    if (Number(ack.entriesApplied) !== snapshot.expectedEntries) return reject('ack_entry_count_mismatch');
    const appliedAt = Date.parse(text(ack.appliedAt));
    if (!Number.isFinite(appliedAt) || appliedAt > this.now() + 30_000 || this.now() - appliedAt > this.ackMaxAgeMs) {
      return reject('ack_stale');
    }
    if (!supportsCaptureProfileCapabilities(ack.capabilities)) return reject('ack_capabilities_mismatch');
    if (text(ack.capabilitiesHash) && text(ack.capabilitiesHash) !== digest(ack.capabilities)) {
      return reject('ack_capabilities_hash_invalid');
    }
    if (text(ack.effectiveActionsHash) !== snapshot.effectiveActionsHash) return reject('ack_effective_actions_mismatch');
    return { ok: true, ack: { ...ack } };
  }

  consumeAckFile() {
    if (!this.ackFile || this.captureProfileMode === 'legacy' || typeof this.fs.readFileSync !== 'function') {
      return undefined;
    }
    try {
      const raw = this.fs.readFileSync(this.ackFile, 'utf8');
      if (Buffer.byteLength(raw) > 64 * 1024) throw new Error('ack_too_large');
      const ack = JSON.parse(raw);
      const fingerprint = digest(ack);
      if (fingerprint === this.lastAckFingerprint) {
        this.stats.ackReplayIgnored++;
        return undefined;
      }
      this.lastAckFingerprint = fingerprint;
      this.stats.ackReads++;
      const validated = this.validateAck(ack);
      if (!validated.ok) {
        this.stats.ackRejected++;
        if (this.activationMode === 'enforce') this.revokeActivation(validated.reason);
        return { accepted: false, reason: validated.reason };
      }
      this.lastAck = validated.ack;
      this.stats.ackAccepted++;
      if (this.captureProfileMode === 'enforce') {
        const grant = this.activationGrant;
        if (
          this.activationMode === 'enforce'
          && grant
          && (grant.collectorInstanceId !== ack.collectorInstanceId || grant.hostBootId !== ack.hostBootId)
        ) {
          this.revokeActivation('collector_generation_changed');
          return { accepted: false, reason: 'collector_generation_changed' };
        }
        if (this.activationMode === 'preview') {
          const pinned = this.pinnedPreviewGeneration;
          if (
            pinned
            && (pinned.collectorInstanceId !== ack.collectorInstanceId || pinned.hostBootId !== ack.hostBootId)
          ) {
            this.pendingPreviewAck = undefined;
            this.pinnedPreviewGeneration = undefined;
            this.activationReason = 'preview_generation_changed';
            this.version++;
            this.stats.changed++;
            this.stats.ackRejected++;
            this.dirty = true;
            this.schedule();
            return { accepted: false, reason: 'preview_generation_changed' };
          }
          this.pinnedPreviewGeneration = {
            collectorInstanceId: ack.collectorInstanceId,
            hostBootId: ack.hostBootId,
            epoch: ack.epoch,
          };
          this.pendingPreviewAck = validated.ack;
        }
      }
      return { accepted: true, ack: validated.ack, activationMode: this.activationMode };
    } catch (error) {
      if (error?.code !== 'ENOENT') this.stats.ackRejected++;
      return error?.code === 'ENOENT' ? undefined : { accepted: false, reason: error.message || 'ack_read_failed' };
    }
  }

  materializationReport(ack = this.pendingPreviewAck) {
    if (!ack || this.captureProfileMode !== 'enforce' || this.activationMode !== 'preview') return undefined;
    const validated = this.validateAck(ack);
    if (!validated.ok) return undefined;
    const entries = [...this.entries.values()];
    const destructive = entries.filter((entry) =>
      Object.values(safeDesiredProbeActions(entry)).includes('drop'));
    if (!destructive.length || destructive.some((entry) => !completeMaterializationIdentity(entry))) return undefined;
    const bindings = entries
      .filter((entry) => text(entry.ruleId) && text(entry.physicalWorkloadId))
      .map((entry) => ({
        ruleId: entry.ruleId,
        ruleRevision: Number(entry.ruleRevision),
        physicalWorkloadId: entry.physicalWorkloadId,
        cgroupId: entry.cgroupId,
        agentKeepConflict: entry.conflict === true || entry.captureProfile === 'agent_full',
        action: entry.policyAction,
        effectiveAction: legacyActionForProbeActions(previewProbeActions(entry.desiredProbeActions)),
        captureProfile: entry.captureProfile,
        ...(entry.captureIntent ? { captureIntent: entry.captureIntent } : {}),
        probeActions: previewProbeActions(entry.desiredProbeActions),
        desiredProbeActions: safeDesiredProbeActions(entry),
        expiresAt: entry.expiresAt,
      }));
    // A transport timeout can happen after Central durably accepted the report. Bind the retry key
    // to the complete preview and Collector generation so every retry is the same idempotent
    // operation, while a new epoch/content/generation necessarily receives a different key.
    const reportId = `matr_${digest({
      nodeId: this.nodeId,
      publisherInstanceId: this.publisherInstanceId,
      collectorInstanceId: ack.collectorInstanceId,
      hostBootId: ack.hostBootId,
      policyVersion: Number(ack.policyVersion),
      epoch: Number(ack.epoch),
      snapshotContentHash: ack.contentHash,
      intentHash: ack.intentHash,
    }).slice(0, 24)}`;
    return {
      schemaVersion: 'anysentry.infrastructure_materialization_report.v1',
      reportId,
      nodeId: this.nodeId,
      policyVersion: Number(ack.policyVersion),
      epoch: Number(ack.epoch),
      snapshotContentHash: ack.contentHash,
      intentHash: ack.intentHash,
      activationMode: 'preview',
      publisherInstanceId: this.publisherInstanceId,
      expectedEntries: Number(ack.entriesApplied),
      ack,
      bindings,
      errors: [],
    };
  }

  acceptCentralMaterialization(ack, report) {
    const validated = this.validateAck(ack);
    const pending = this.pendingPreviewAck;
    const pinned = this.pinnedPreviewGeneration;
    const pendingMatches = Boolean(
      pending
      && pinned
      && digest(pending) === digest(ack)
      && text(pending.collectorInstanceId) === text(pinned.collectorInstanceId)
      && text(pending.hostBootId) === text(pinned.hostBootId)
      && Number(pending.epoch) === Number(pinned.epoch)
      && text(pending.contentHash) === text(ack?.contentHash),
    );
    const destructive = [...this.entries.values()].filter((entry) =>
      Object.values(safeDesiredProbeActions(entry)).includes('drop'));
    const reportedEntries = Array.isArray(report?.filterRuleEntries) ? report.filterRuleEntries : [];
    const allDestructiveAccepted = destructive.length > 0 && destructive.every((entry) =>
      completeMaterializationIdentity(entry)
      && reportedEntries.some((reported) =>
        text(reported.scopeKey) === entry.scopeKey
        && text(reported.ruleId) === text(entry.ruleId)
        && Number(reported.ruleRevision) === Number(entry.ruleRevision)
        && text(reported.physicalWorkloadId) === text(entry.physicalWorkloadId)
        && text(reported.cgroupId) === entry.cgroupId
        && reported.action === entry.policyAction));
    if (
      !validated.ok
      || !pendingMatches
      || this.captureProfileMode !== 'enforce'
      || this.activationMode !== 'preview'
      || report?.accepted !== true
      || !text(report.reportId)
      || text(report.nodeId) !== this.nodeId
      || text(report.publisherInstanceId) !== this.publisherInstanceId
      || Number(report.epoch) !== Number(ack.epoch)
      || Number(report.policyVersion) !== Number(ack.policyVersion)
      || Number(report.expectedEntries) !== Number(ack.entriesApplied)
      || text(report.snapshotContentHash) !== ack.contentHash
      || text(report.intentHash) !== ack.intentHash
      || text(report.ack?.collectorInstanceId) !== text(ack.collectorInstanceId)
      || !allDestructiveAccepted
    ) {
      this.stats.centralRejected++;
      return false;
    }
    const expiresAt = new Date(Math.min(
      this.now() + this.ackMaxAgeMs,
      Date.parse(this.lastPublishedSnapshot?.expiresAt ?? '') || this.now() + this.ttlMs,
    )).toISOString();
    this.activationGrant = {
      collectorInstanceId: ack.collectorInstanceId,
      hostBootId: ack.hostBootId,
      publisherInstanceId: this.publisherInstanceId,
      previewEpoch: ack.epoch,
      previewContentHash: ack.contentHash,
      intentHash: ack.intentHash,
      centralReportId: report.reportId,
      centralAcceptedAt: new Date(this.now()).toISOString(),
      expiresAt,
    };
    this.activationMode = 'enforce';
    this.activationReason = 'local_ack_and_central_acceptance';
    this.pendingPreviewAck = undefined;
    this.version++;
    this.stats.changed++;
    this.stats.centralAccepted++;
    this.stats.activationGrants++;
    this.dirty = true;
    this.schedule();
    return true;
  }

  close() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.flush();
  }

  metrics() {
    this.refreshSafety();
    return {
      enabled: Boolean(this.file),
      enforceDrops: this.enforceDrops,
      captureProfileMode: this.captureProfileMode,
      ackEnabled: Boolean(this.ackFile),
      version: this.version,
      policyVersion: this.synchronizedPolicyVersion,
      ttlRefreshLeadMs: this.ttlRefreshLeadMs,
      entries: this.entries.size,
      activationMode: this.activationMode,
      activationReason: this.activationReason,
      controlPlaneState: this.controlPlaneState,
      lastAckAt: this.lastAck?.appliedAt,
      lastAckCollectorInstanceId: this.lastAck?.collectorInstanceId,
      expectedCapabilitiesHash: CAPTURE_PROFILE_CAPABILITIES_HASH,
      ...this.stats,
    };
  }
}

module.exports = {
  AUTHORITATIVE_NON_AGENT_SOURCES,
  CAPTURE_PROFILE_ACK_SCHEMA,
  CAPTURE_PROFILE_CAPABILITIES,
  CAPTURE_PROFILE_CAPABILITIES_HASH,
  CAPTURE_PROFILES,
  FILTER_RULE_SNAPSHOT_SCHEMA,
  FilterRulePublisher,
  PROFILE_PROBE_ACTIONS,
  PROBE_NAMES,
  canonicalJson,
  captureIntentHash,
  captureIntentProjection,
  captureSnapshotContentHash,
  compileCaptureDecision,
  digest,
  effectiveActionsHash,
  eventCgroupId,
  filterDecision,
  previewProbeActions,
  supportsCaptureProfileCapabilities,
};
