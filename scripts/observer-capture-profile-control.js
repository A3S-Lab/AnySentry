'use strict';

const crypto = require('node:crypto');

const { resolveClassificationSemantics } = require('./observer-classification-semantics');

const FILTER_RULE_SNAPSHOT_SCHEMA = 'anysentry.filter_rule_snapshot.v1';
const CAPTURE_PROFILE_ACK_SCHEMA = 'anysentry.capture_profile_ack.v1';
const INFRASTRUCTURE_CAPTURE_INTENT_SCHEMA = 'anysentry.infrastructure_capture_intent.v1';
const CAPTURE_PROFILE_MODES = new Set(['legacy', 'shadow', 'enforce']);
const CAPTURE_PROFILES = new Set([
  'agent_full',
  'probable_investigation',
  'security_full',
  'investigation_full',
  'business_context',
  'infrastructure_aggregate',
  'unknown_discovery',
  'self_health',
]);
const PROBE_NAMES = Object.freeze([
  'exec', 'exit', 'tls', 'connect', 'dns', 'file_access', 'file_delete', 'llm', 'ssl', 'security', 'file_read',
]);
const PROBE_ACTIONS = new Set(['full', 'aggregate', 'sample', 'drop', 'not_enabled']);
const CAPTURE_INTENT_ACTIONS = new Set(['full', 'aggregate', 'sample', 'drop']);
const ALL_FULL_PROBE_ACTIONS = Object.freeze(Object.fromEntries(PROBE_NAMES.map((name) => [name, 'full'])));
const SHADOW_SAFE_PROBE_ACTIONS = Object.freeze({ ...ALL_FULL_PROBE_ACTIONS, file_read: 'not_enabled' });
const PROFILE_PROBE_ACTIONS = Object.freeze({
  agent_full: ALL_FULL_PROBE_ACTIONS,
  investigation_full: ALL_FULL_PROBE_ACTIONS,
  probable_investigation: Object.freeze({
    exec: 'full', exit: 'full', tls: 'sample', connect: 'sample', dns: 'sample',
    file_access: 'sample', file_delete: 'sample', llm: 'full', ssl: 'sample', security: 'full', file_read: 'full',
  }),
  security_full: Object.freeze({
    exec: 'full', exit: 'full', tls: 'sample', connect: 'full', dns: 'sample',
    file_access: 'sample', file_delete: 'full', llm: 'full', ssl: 'sample', security: 'full', file_read: 'not_enabled',
  }),
  unknown_discovery: Object.freeze({
    exec: 'full', exit: 'full', tls: 'sample', connect: 'sample', dns: 'sample',
    file_access: 'sample', file_delete: 'sample', llm: 'full', ssl: 'sample', security: 'full', file_read: 'not_enabled',
  }),
  business_context: Object.freeze({
    exec: 'full', exit: 'full', tls: 'aggregate', connect: 'aggregate', dns: 'aggregate',
    file_access: 'aggregate', file_delete: 'sample', llm: 'aggregate', ssl: 'aggregate', security: 'full', file_read: 'not_enabled',
  }),
  infrastructure_aggregate: Object.freeze({
    exec: 'full', exit: 'full', tls: 'aggregate', connect: 'aggregate', dns: 'aggregate',
    file_access: 'aggregate', file_delete: 'sample', llm: 'aggregate', ssl: 'aggregate', security: 'full', file_read: 'not_enabled',
  }),
  self_health: Object.freeze({
    exec: 'full', exit: 'full', tls: 'aggregate', connect: 'aggregate', dns: 'aggregate',
    file_access: 'aggregate', file_delete: 'sample', llm: 'aggregate', ssl: 'aggregate', security: 'full', file_read: 'not_enabled',
  }),
});

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

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => [key, stableValue(item)]),
  );
}

function canonicalJson(value) {
  return JSON.stringify(stableValue(value));
}

function digest(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function eventKind(observerEvent) {
  const events = observerEvent?.event && typeof observerEvent.event === 'object' ? observerEvent.event : {};
  return Object.keys(events)[0] || '';
}

function captureProfileActions(profile) {
  return { ...(PROFILE_PROBE_ACTIONS[profile] ?? PROFILE_PROBE_ACTIONS.unknown_discovery) };
}

function captureIntentProbeActions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  if (
    value.schemaVersion !== INFRASTRUCTURE_CAPTURE_INTENT_SCHEMA
    || !CAPTURE_INTENT_ACTIONS.has(value.action)
    || Object.keys(value).some((field) => field !== 'schemaVersion' && field !== 'action')
  ) return undefined;
  const actions = Object.fromEntries(PROBE_NAMES.map((probe) => [probe, value.action]));
  actions.exec = 'full';
  actions.exit = 'full';
  actions.security = 'full';
  if (value.action !== 'full') actions.file_delete = 'sample';
  actions.file_read = 'not_enabled';
  return actions;
}

function normalizedProbeActions(value, fallback) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const output = {};
  for (const probe of PROBE_NAMES) {
    const action = text(input[probe]).toLowerCase();
    output[probe] = PROBE_ACTIONS.has(action) ? action : fallback[probe];
  }
  output.exec = 'full';
  output.exit = 'full';
  output.security = 'full';
  return output;
}

function previewProbeActions(desired) {
  const output = {};
  for (const probe of PROBE_NAMES) {
    if (desired[probe] !== 'drop') output[probe] = desired[probe];
    else output[probe] = probe === 'file_delete' || probe === 'llm' ? 'sample' : 'aggregate';
  }
  output.exec = 'full';
  output.exit = 'full';
  output.security = 'full';
  return output;
}

function legacyActionForProbeActions(probeActions) {
  return probeActions.file_access === 'full' ? 'keep' : 'sample';
}

function rootProcessFields(classification, observerEvent) {
  const attribution = classification?.attribution && typeof classification.attribution === 'object'
    ? classification.attribution
    : {};
  const toolExec = observerEvent?.event?.ToolExec && typeof observerEvent.event.ToolExec === 'object'
    ? observerEvent.event.ToolExec
    : {};
  const rootPid = Number(attribution.rootPid);
  const eventPid = Number(observerEvent?.process?.pid ?? toolExec.pid);
  const suppliedRootExecId = text(attribution.rootExecId);
  const suppliedRootExecIdExact = text(attribution.rootExecIdExact);
  const currentExecIdExact = Number.isSafeInteger(rootPid) && rootPid > 0 && eventPid === rootPid
    ? text(toolExec.execIdExact ?? toolExec.exec_id_exact)
    : '';
  const currentExecId = Number.isSafeInteger(rootPid) && rootPid > 0 && eventPid === rootPid
    ? text(toolExec.execId ?? toolExec.exec_id)
    : '';
  const rootExecIdExact = suppliedRootExecIdExact || currentExecIdExact;
  return {
    ...(text(attribution.rootKey) ? { rootProcessKey: text(attribution.rootKey) } : {}),
    ...(Number.isSafeInteger(rootPid) && rootPid > 0 ? { rootPid } : {}),
    ...(text(attribution.rootGeneration) ? { rootGeneration: text(attribution.rootGeneration) } : {}),
    ...(suppliedRootExecId || currentExecId ? { rootExecId: suppliedRootExecId || currentExecId } : {}),
    ...(rootExecIdExact ? { rootExecIdExact } : {}),
  };
}

function compileCaptureDecision(observerEvent, classification, input, options = {}) {
  if (!input) return undefined;
  const semantics = resolveClassificationSemantics(classification, observerEvent);
  const processRoot = rootProcessFields(classification, observerEvent);
  const attribution = classification?.attribution && typeof classification.attribution === 'object'
    ? classification.attribution
    : {};
  const conflict = classification?.workspaceConflict === true
    || classification?.attribution?.conflict === true
    || input.conflict === true;
  // SecurityAction is already FULL in every closed profile matrix. Expanding the entire cgroup to
  // investigation_full requires an explicit risk/control-plane decision; the raw event kind alone
  // cannot bypass the bounded probable/Unknown profiles.
  const riskPromotion = options.riskPromotion === true;
  const now = typeof options.now === 'function' ? options.now() : Date.now();
  const promotionExpiresAt = Number.isFinite(options.promotionExpiresAt)
    ? options.promotionExpiresAt
    : now + boundedNumber(options.riskPromotionTtlMs, 300_000, 1_000, 24 * 60 * 60_000);
  let captureProfile = CAPTURE_PROFILES.has(input.captureProfile) ? input.captureProfile : semantics.captureProfile;
  if (conflict || semantics.identityClassification === 'confirmed_agent') {
    captureProfile = 'agent_full';
  }
  if (riskPromotion) captureProfile = 'investigation_full';
  const contextualProfile = ['business_context', 'infrastructure_aggregate', 'self_health'].includes(captureProfile);
  const declaredCaptureIntent = contextualProfile
    ? captureIntentProbeActions(input.captureIntent)
    : undefined;
  let desiredProbeActions = declaredCaptureIntent ?? normalizedProbeActions(
    input.desiredProbeActions ?? input.probeActions,
    captureProfileActions(captureProfile),
  );
  if (!declaredCaptureIntent && !input.desiredProbeActions && !input.probeActions) {
    if (input.action === 'keep') desiredProbeActions.file_access = 'full';
    else if (input.action === 'sample') desiredProbeActions.file_access = 'sample';
    else if (input.action === 'drop') desiredProbeActions.file_access = 'drop';
  }
  if (conflict || captureProfile === 'agent_full' || captureProfile === 'investigation_full') {
    desiredProbeActions = { ...ALL_FULL_PROBE_ACTIONS };
  } else if (['security_full', 'probable_investigation', 'unknown_discovery'].includes(captureProfile)) {
    desiredProbeActions = captureProfileActions(captureProfile);
  } else if (contextualProfile && !declaredCaptureIntent) {
    desiredProbeActions.file_delete = 'sample';
  }
  const workload = input.workloadRef ?? attribution.workloadRef ?? observerEvent?.workload ?? {};
  const workloadEnvironment = text(workload.environment ?? workload.placement).toLowerCase();
  const physicalWorkloadId = text(input.physicalWorkloadId ?? attribution.physicalWorkloadId);
  const dedicatedRuntimeReadScope = ['kubernetes', 'docker'].includes(workloadEnvironment)
    && Boolean(physicalWorkloadId)
    && Boolean(text(input.agentInstanceId ?? attribution.agentInstanceId));
  const exactRootReadScope = Number.isSafeInteger(Number(processRoot.rootPid))
    && Number(processRoot.rootPid) > 0
    && Boolean(text(processRoot.rootProcessKey))
    && Boolean(text(processRoot.rootExecIdExact));
  const exactAgentReadScope = ['confirmed_agent', 'probable_agent'].includes(semantics.identityClassification)
    && (dedicatedRuntimeReadScope || exactRootReadScope);
  if (!exactAgentReadScope && !riskPromotion) desiredProbeActions.file_read = 'not_enabled';
  if (
    !declaredCaptureIntent
    && (input.authority !== 'authoritative' || (options.captureProfileMode !== 'legacy' && !text(input.ruleId)))
  ) {
    desiredProbeActions = previewProbeActions(desiredProbeActions);
  }
  const captureProfileMode = CAPTURE_PROFILE_MODES.has(options.captureProfileMode)
    ? options.captureProfileMode
    : 'legacy';
  const effectiveProbeActions = captureProfileMode === 'shadow'
    ? { ...SHADOW_SAFE_PROBE_ACTIONS }
    : captureProfileMode === 'enforce' && options.activationMode !== 'enforce'
      ? previewProbeActions(desiredProbeActions)
      : { ...desiredProbeActions };
  const inputExpiresAt = Date.parse(text(input.expiresAt));
  const ttlMs = captureProfile === 'probable_investigation'
    ? boundedNumber(options.probableTtlMs, 120_000, 1_000, 10 * 60_000)
    : boundedNumber(options.ttlMs, 120_000, 1_000, 24 * 60 * 60_000);
  const expiresAt = riskPromotion
    ? new Date(Math.min(Number.isFinite(inputExpiresAt) ? inputExpiresAt : now + 120_000, promotionExpiresAt)).toISOString()
    : captureProfile === 'probable_investigation'
      ? new Date(Math.min(Number.isFinite(inputExpiresAt) ? inputExpiresAt : now + ttlMs, now + ttlMs)).toISOString()
      : input.expiresAt;
  return {
    ...input,
    ...processRoot,
    captureProfile,
    probeActions: effectiveProbeActions,
    desiredProbeActions,
    action: captureProfileMode === 'legacy'
      ? input.action
      : captureProfileMode === 'shadow' ? 'keep' : legacyActionForProbeActions(effectiveProbeActions),
    reason: text(input.reasonCode) || 'capture_profile',
    ttlMs,
    ...(riskPromotion ? {
      promotionReason: 'risk_signal',
      promotionExpiresAt: new Date(promotionExpiresAt).toISOString(),
    } : {}),
    expiresAt,
  };
}

function isAgentKeepDecision(decision) {
  if (decision?.captureProfile === 'probable_investigation') return false;
  if (decision?.classification === 'probable_agent' && decision?.captureProfile !== 'agent_full') return false;
  return decision?.captureProfile === 'agent_full'
    || decision?.classification === 'confirmed_agent'
    || (Boolean(text(decision?.agentInstanceId) || text(decision?.rootProcessKey))
      && (decision?.policyAction === 'keep' || decision?.action === 'keep'));
}

function completeMaterializationIdentity(entry) {
  return entry?.authority === 'authoritative'
    && Boolean(text(entry.ruleId))
    && Number.isSafeInteger(Number(entry.ruleRevision))
    && Number(entry.ruleRevision) > 0
    && Boolean(text(entry.physicalWorkloadId))
    && Boolean(normalizedCgroupId(entry.cgroupId));
}

function exactRootReadScope(entry) {
  return Number.isSafeInteger(Number(entry?.rootPid))
    && Number(entry.rootPid) > 0
    && Boolean(text(entry?.rootExecIdExact));
}

function safeDesiredProbeActions(entry) {
  const profile = CAPTURE_PROFILES.has(entry?.captureProfile) ? entry.captureProfile : 'unknown_discovery';
  const contextualProfile = ['business_context', 'infrastructure_aggregate', 'self_health'].includes(profile);
  const declaredCaptureIntent = contextualProfile
    ? captureIntentProbeActions(entry?.captureIntent)
    : undefined;
  let desired = declaredCaptureIntent ?? normalizedProbeActions(
    entry?.desiredProbeActions ?? entry?.probeActions,
    captureProfileActions(profile),
  );
  if (isAgentKeepDecision(entry) || entry?.conflict === true || profile === 'investigation_full') {
    const agent = { ...ALL_FULL_PROBE_ACTIONS };
    if (exactRootReadScope(entry) || entry?.desiredProbeActions?.file_read === 'not_enabled') {
      agent.file_read = 'not_enabled';
    }
    return agent;
  }
  // These profiles are discovery/safety envelopes rather than rule-programmable policies. Keep
  // their single cross-language matrix fixed at the writer boundary so a malformed direct input
  // cannot create an intent the Collector must downgrade forever.
  if (['unknown_discovery', 'probable_investigation', 'security_full'].includes(profile)) {
    const fixed = captureProfileActions(profile);
    if (entry?.desiredProbeActions?.file_read === 'not_enabled') fixed.file_read = 'not_enabled';
    if (exactRootReadScope(entry)) fixed.file_read = 'not_enabled';
    return fixed;
  }
  // Deletes retain bounded path evidence for contextual profiles. Exact materialized policy may
  // tune the other high-volume probes, but it must not turn infrastructure delete floods into raw
  // FULL/DROP behavior that disagrees with the profile contract.
  if (contextualProfile && !declaredCaptureIntent) {
    desired.file_delete = 'sample';
  }
  if (!declaredCaptureIntent && Object.values(desired).includes('drop') && !completeMaterializationIdentity(entry)) {
    desired = previewProbeActions(desired);
  }
  desired.exec = 'full';
  desired.exit = 'full';
  desired.security = 'full';
  return desired;
}

const CAPTURE_PROFILE_CAPABILITIES = Object.freeze({
  schemaVersions: Object.freeze([FILTER_RULE_SNAPSHOT_SCHEMA]),
  probeNames: PROBE_NAMES,
  probeActions: Object.freeze(['aggregate', 'drop', 'full', 'not_enabled', 'sample']),
  selectiveFileRead: true,
  captureProfileModes: Object.freeze(['enforce', 'shadow']),
  activationGrantV1: true,
});
const CAPTURE_PROFILE_CAPABILITIES_HASH = digest(CAPTURE_PROFILE_CAPABILITIES);

function captureIntentProjection(entries, policyVersion) {
  return {
    policyVersion: Number.isSafeInteger(Number(policyVersion)) ? Number(policyVersion) : 0,
    entries: entries.map((entry) => ({
      scopeType: 'cgroup', scopeKey: entry.scopeKey, cgroupId: entry.cgroupId,
      // Process membership and exec generation are maintained in their own generation-safe state.
      // A new Invocation/root PID inside the same cgroup must not recompile the node policy.
      classification: entry.classification, authority: entry.authority,
      captureProfile: entry.captureProfile,
      ...(captureIntentProbeActions(entry.captureIntent) ? { captureIntent: entry.captureIntent } : {}),
      desiredProbeActions: safeDesiredProbeActions(entry),
      reasonCode: entry.reasonCode, source: entry.source,
      physicalWorkloadId: entry.physicalWorkloadId, agentInstanceId: entry.agentInstanceId,
      ruleId: entry.ruleId, ruleRevision: entry.ruleRevision,
      // materializationId identifies one Preview/ACK/report attempt. It is audit bookkeeping, not
      // capture intent; including it made every accepted report immediately invalidate its grant.
      policyVersion: entry.policyVersion, ttlMs: entry.ttlMs,
    })).sort((left, right) => left.scopeKey < right.scopeKey ? -1 : left.scopeKey > right.scopeKey ? 1 : 0),
  };
}

function captureIntentHash(entries, policyVersion) {
  return digest(captureIntentProjection(entries, policyVersion));
}

function captureSnapshotContentHash(snapshot) {
  const { contentHash: _contentHash, ...payload } = snapshot ?? {};
  return digest(payload);
}

function effectiveActionsHash(entries) {
  return digest(entries.map((entry) => ({
    scopeKey: entry.scopeKey,
    probeActions: entry.probeActions,
  })).sort((left, right) => left.scopeKey < right.scopeKey ? -1 : left.scopeKey > right.scopeKey ? 1 : 0));
}

function supportsCaptureProfileCapabilities(value) {
  if (!value || typeof value !== 'object' || value.activationGrantV1 !== true) return false;
  const contains = (actual, required) => Array.isArray(actual) && required.every((item) => actual.includes(item));
  return contains(value.schemaVersions, CAPTURE_PROFILE_CAPABILITIES.schemaVersions)
    && contains(value.probeNames, CAPTURE_PROFILE_CAPABILITIES.probeNames)
    && contains(value.probeActions, CAPTURE_PROFILE_CAPABILITIES.probeActions)
    && contains(value.captureProfileModes, CAPTURE_PROFILE_CAPABILITIES.captureProfileModes)
    && value.selectiveFileRead === true;
}

module.exports = {
  ALL_FULL_PROBE_ACTIONS,
  SHADOW_SAFE_PROBE_ACTIONS,
  CAPTURE_PROFILE_ACK_SCHEMA,
  CAPTURE_PROFILE_CAPABILITIES,
  CAPTURE_PROFILE_CAPABILITIES_HASH,
  CAPTURE_PROFILE_MODES,
  CAPTURE_PROFILES,
  INFRASTRUCTURE_CAPTURE_INTENT_SCHEMA,
  FILTER_RULE_SNAPSHOT_SCHEMA,
  PROFILE_PROBE_ACTIONS,
  PROBE_NAMES,
  canonicalJson,
  captureIntentHash,
  captureIntentProbeActions,
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
};
