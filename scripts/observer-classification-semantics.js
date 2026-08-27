'use strict';

const CLASSIFICATION_SEMANTICS_SCHEMA = 'anysentry.classification_semantics.v1';

const IDENTITY_CLASSIFICATIONS = Object.freeze([
  'confirmed_agent',
  'probable_agent',
  'non_agent',
  'unknown',
]);

const WORKLOAD_ROLES = Object.freeze([
  'agent',
  'anysentry_internal',
  'platform_infrastructure',
  'business_service',
  'ordinary_process',
  'unknown',
]);

const CAPTURE_PROFILES = Object.freeze([
  'agent_full',
  'probable_investigation',
  'security_full',
  'investigation_full',
  'business_context',
  'infrastructure_aggregate',
  'unknown_discovery',
  'self_health',
]);

const UNKNOWN_REASONS = Object.freeze([
  'snapshot_not_ready',
  'snapshot_miss',
  'container_identity_missing',
  'container_name_missing',
  'parent_missing',
  'process_exited_before_enrichment',
  'ancestry_incomplete',
  'pid_reuse_ambiguous',
  'signature_miss',
  'template_conflict',
  'policy_expired',
  'shared_scope_ambiguous',
  'unsupported_agent_adapter',
]);

const identityClassifications = new Set(IDENTITY_CLASSIFICATIONS);
const workloadRoles = new Set(WORKLOAD_ROLES);
const unknownReasons = new Set(UNKNOWN_REASONS);
const containerCgroupPattern = /(?:^|\/)(?:docker(?:[-/]|$)|kubepods(?:[./-]|\/|$)|cri-containerd[-/]|containerd[-/])/iu;

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

function text(value, limit = 512) {
  const normalized = typeof value === 'string'
    ? value.trim()
    : value == null
      ? ''
      : String(value).trim();
  return normalized.slice(0, limit);
}

function normalizedEnum(value, values) {
  const normalized = text(value, 80);
  return values.has(normalized) ? normalized : undefined;
}

function identityClassification(classification) {
  const attribution = object(classification?.attribution) ?? {};
  const explicit = normalizedEnum(attribution.classification, identityClassifications);
  // Either positive fact is sufficient for fail-safe Agent KEEP. A contradictory negative field
  // can make the view probable/conflicted, but must never turn an Agent result into non-Agent.
  if (explicit === 'confirmed_agent' || explicit === 'probable_agent') return explicit;
  if (classification?.state === 'agent') return 'probable_agent';
  if (explicit) return explicit;
  if (classification?.state === 'non_agent' || classification?.state === 'infrastructure') {
    return 'non_agent';
  }
  return 'unknown';
}

function evidenceValues(classification) {
  const values = classification?.attribution?.evidence;
  if (!Array.isArray(values)) return [];
  return values.slice(0, 32).map((value) => text(value)).filter(Boolean);
}

function evidenceValue(evidence, prefix) {
  const match = evidence.find((value) => value.startsWith(prefix));
  return match ? text(match.slice(prefix.length), 80) : '';
}

function explicitWorkloadRole(classification, evidence) {
  const attribution = object(classification?.attribution) ?? {};
  const facts = object(classification?.infrastructureFacts) ?? {};
  const labels = object(facts.labels) ?? {};
  for (const candidate of [
    classification?.workloadRole,
    attribution.workloadRole,
    facts.workloadRole,
    labels['anysentry.io/workload-role'],
    evidenceValue(evidence, 'label:anysentry.io/workload-role='),
  ]) {
    const role = normalizedEnum(candidate, workloadRoles);
    if (role) return role;
  }
  return undefined;
}

function explicitInfrastructureInventory(classification, evidence) {
  const facts = object(classification?.infrastructureFacts) ?? {};
  const labels = object(facts.labels) ?? {};
  const kind = text(labels['anysentry.io/workload-kind'], 80).toLowerCase();
  return kind === 'infrastructure'
    || evidence.some((value) => value === 'label:anysentry.io/workload-kind=infrastructure');
}

function placedService(classification) {
  const attribution = object(classification?.attribution) ?? {};
  const workloadRef = object(attribution.workloadRef) ?? {};
  const kind = text(workloadRef.kind, 80).toLowerCase();
  return Boolean(text(attribution.physicalWorkloadId))
    || ['pod', 'container', 'service', 'deployment', 'statefulset', 'daemonset'].includes(kind);
}

function workloadRole(classification, identity, evidence) {
  const explicit = explicitWorkloadRole(classification, evidence);
  // Workload role and Agent identity are independent axes. A service can host an Agent Runtime;
  // the strong Agent fact controls capture safety, but must not erase the service's inventory
  // role or turn every sibling process into an Agent workload.
  if (explicit) return explicit;
  // A positive Agent identity is fail-safe: Infrastructure/non-Agent placement can add conflict
  // evidence, but can never demote the resolved role or its full-fidelity capture class.
  if (identity === 'confirmed_agent' || identity === 'probable_agent') return 'agent';
  if (classification?.state === 'infrastructure' || explicitInfrastructureInventory(classification, evidence)) {
    return 'platform_infrastructure';
  }
  if (identity === 'non_agent') return placedService(classification) ? 'business_service' : 'ordinary_process';
  return 'unknown';
}

function eventKind(observerEvent) {
  const event = object(observerEvent?.event) ?? {};
  return Object.keys(event)[0] || '';
}

function captureProfile(classification, identity, role, observerEvent) {
  if (eventKind(observerEvent) === 'SecurityAction') return 'security_full';
  const declared = text(classification?.captureProfile, 80);
  if (declared === 'investigation_full' || declared === 'security_full') return declared;
  if (identity === 'confirmed_agent') return 'agent_full';
  if (identity === 'probable_agent' || role === 'agent') return 'probable_investigation';
  if (role === 'anysentry_internal') return 'self_health';
  if (role === 'platform_infrastructure') return 'infrastructure_aggregate';
  if (role === 'business_service' || role === 'ordinary_process') return 'business_context';
  return 'unknown_discovery';
}

function processFacts(observerEvent) {
  const process = object(observerEvent?.process) ?? {};
  const event = object(observerEvent?.event) ?? {};
  const payload = object(event[Object.keys(event)[0]]) ?? {};
  return {
    kind: Object.keys(event)[0] || '',
    pid: Number(process.pid ?? payload.pid ?? observerEvent?.identity?.task),
    ppid: Number(process.ppid ?? payload.ppid),
    startTime: text(
      process.startTimeTicks ?? process.start_time_ticks ??
      process.startTimeNs ?? process.start_time_ns,
    ),
    comm: text(process.comm),
    exe: text(process.exe),
    argv: Array.isArray(payload.argv) ? payload.argv.map((value) => text(value)).filter(Boolean) : [],
    cgroup: text(process.cgroup, 4_096),
    lifecycleReason: normalizedEnum(
      process.lifecycleReason ?? process.lifecycle_reason,
      unknownReasons,
    ),
  };
}

function explicitUnknownReason(classification) {
  const attribution = object(classification?.attribution) ?? {};
  return normalizedEnum(classification?.unknownReason ?? attribution.unknownReason, unknownReasons);
}

function mappedEvidenceReason(evidence) {
  const mappings = [
    ['workload_snapshot:not_ready', 'snapshot_not_ready', false],
    ['workload_snapshot:miss', 'snapshot_miss', false],
    ['container_identity:missing', 'container_identity_missing', false],
    ['container_name:missing', 'container_name_missing', false],
    ['process_lineage:parent_missing', 'parent_missing', false],
    ['process:exited_before_enrichment', 'process_exited_before_enrichment', false],
    ['process_identity:pid_reuse_ambiguous', 'pid_reuse_ambiguous', false],
    ['process_signature:miss', 'signature_miss', false],
    ['template_ambiguous:', 'template_conflict', true],
    ['infrastructure_policy:expired', 'policy_expired', false],
    ['policy:expired', 'policy_expired', false],
    ['shared_scope:ambiguous', 'shared_scope_ambiguous', false],
    ['container:ambiguous', 'shared_scope_ambiguous', false],
    ['agent_adapter:unsupported', 'unsupported_agent_adapter', false],
  ];
  for (const [token, reason, prefix] of mappings) {
    if (evidence.some((value) => prefix ? value.startsWith(token) : value === token)) return reason;
  }
  return undefined;
}

function derivedUnknownReason(classification, observerEvent, evidence) {
  const supplied = explicitUnknownReason(classification);
  if (supplied) return supplied;
  const facts = processFacts(observerEvent);
  if (facts.lifecycleReason) return facts.lifecycleReason;
  const mapped = mappedEvidenceReason(evidence);
  if (mapped) return mapped;
  const attribution = object(classification?.attribution) ?? {};
  const infrastructureFacts = object(classification?.infrastructureFacts) ?? {};
  const workloadRef = object(attribution.workloadRef) ?? {};
  const containerIdentity = text(attribution.physicalWorkloadId)
    || text(infrastructureFacts.physicalWorkloadId);
  const containerName = text(workloadRef.containerName)
    || text(infrastructureFacts.containerName);

  if (facts.kind === 'ProcessExit' && !facts.startTime && !facts.ppid && !facts.comm && !facts.exe) {
    return 'process_exited_before_enrichment';
  }
  if (containerIdentity && !containerName) return 'container_name_missing';
  if (!containerIdentity && containerCgroupPattern.test(facts.cgroup)) return 'container_identity_missing';
  if (Number.isSafeInteger(facts.pid) && facts.pid > 0 && !facts.ppid) return 'parent_missing';
  if (evidence.some((value) => value === 'process_lineage:incomplete')) return 'ancestry_incomplete';
  if (facts.comm || facts.exe || facts.argv.length) return 'signature_miss';
  return undefined;
}

function resolveClassificationSemantics(classification, observerEvent) {
  const normalized = object(classification) ?? {};
  const evidence = evidenceValues(normalized);
  const identity = identityClassification(normalized);
  const role = workloadRole(normalized, identity, evidence);
  const capture = captureProfile(normalized, identity, role, observerEvent);
  const unknownReason = identity === 'unknown'
    ? derivedUnknownReason(normalized, observerEvent, evidence)
    : undefined;
  return {
    schemaVersion: CLASSIFICATION_SEMANTICS_SCHEMA,
    identityClassification: identity,
    workloadRole: role,
    captureProfile: capture,
    ...(unknownReason ? { unknownReason } : {}),
  };
}

function classificationSemanticsEnabled(env = process.env) {
  return ['shadow', 'enforce'].includes(
    text(env?.ANYSENTRY_UNKNOWN_RETENTION_MODE, 32).toLowerCase(),
  );
}

function classificationSemanticsEnvelope(classification, observerEvent, env = process.env) {
  if (!classificationSemanticsEnabled(env)) return {};
  return {
    classificationSemantics: resolveClassificationSemantics(classification, observerEvent),
  };
}

module.exports = {
  CAPTURE_PROFILES,
  CLASSIFICATION_SEMANTICS_SCHEMA,
  IDENTITY_CLASSIFICATIONS,
  UNKNOWN_REASONS,
  WORKLOAD_ROLES,
  classificationSemanticsEnvelope,
  classificationSemanticsEnabled,
  resolveClassificationSemantics,
};
