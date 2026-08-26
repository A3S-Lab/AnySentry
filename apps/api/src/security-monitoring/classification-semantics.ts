import { correlationCaptureRollout } from './correlation-rollout';
import {
  AgentClassification,
  CaptureProfile,
  ClassificationSemanticsV1,
  ProcessContext,
  ProcessLifecycleSource,
  UnknownReason,
  WorkloadRole,
} from './types';

const IDENTITY_CLASSIFICATIONS = new Set<AgentClassification>([
  'confirmed_agent',
  'probable_agent',
  'non_agent',
  'unknown',
]);

const WORKLOAD_ROLES = new Set<WorkloadRole>([
  'agent',
  'anysentry_internal',
  'platform_infrastructure',
  'business_service',
  'ordinary_process',
  'unknown',
]);

const CAPTURE_PROFILES = new Set<CaptureProfile>([
  'agent_full',
  'probable_investigation',
  'security_full',
  'investigation_full',
  'business_context',
  'infrastructure_aggregate',
  'unknown_discovery',
  'self_health',
]);

const UNKNOWN_REASONS = new Set<UnknownReason>([
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

const ALLOWED_FIELDS = new Set([
  'schemaVersion',
  'identityClassification',
  'workloadRole',
  'captureProfile',
  'unknownReason',
]);

const PROCESS_LIFECYCLE_SOURCES = new Set<ProcessLifecycleSource>([
  'exec_process_key',
  'exec_tombstone',
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/**
 * Strictly validates the Forwarder-resolved S3 view before it can reach persistence, public APIs,
 * or low-cardinality metrics. This view remains observational: it never authorizes filtering and
 * never changes the legacy Agent attribution decision.
 */
export function parseClassificationSemantics(value: unknown): ClassificationSemanticsV1 | undefined {
  const input = record(value);
  if (!input || Object.keys(input).some((field) => !ALLOWED_FIELDS.has(field))) return undefined;
  if (input.schemaVersion !== 'anysentry.classification_semantics.v1') return undefined;
  if (typeof input.identityClassification !== 'string'
    || !IDENTITY_CLASSIFICATIONS.has(input.identityClassification as AgentClassification)) return undefined;
  if (typeof input.workloadRole !== 'string'
    || !WORKLOAD_ROLES.has(input.workloadRole as WorkloadRole)) return undefined;
  if (typeof input.captureProfile !== 'string'
    || !CAPTURE_PROFILES.has(input.captureProfile as CaptureProfile)) return undefined;

  const identityClassification = input.identityClassification as AgentClassification;
  const unknownReason = input.unknownReason;
  if (unknownReason !== undefined && (
    identityClassification !== 'unknown'
    || typeof unknownReason !== 'string'
    || !UNKNOWN_REASONS.has(unknownReason as UnknownReason)
  )) {
    return undefined;
  }

  return {
    schemaVersion: 'anysentry.classification_semantics.v1',
    identityClassification,
    workloadRole: input.workloadRole as WorkloadRole,
    captureProfile: input.captureProfile as CaptureProfile,
    ...(unknownReason ? { unknownReason: unknownReason as UnknownReason } : {}),
  };
}

/** S0 kill switch: legacy mode must neither publish nor reveal the additive S3 view. */
export function classificationSemanticsVisible(): boolean {
  return correlationCaptureRollout().unknownRetention !== 'legacy';
}

export function visibleClassificationSemantics(value: unknown): ClassificationSemanticsV1 | undefined {
  return classificationSemanticsVisible() ? parseClassificationSemantics(value) : undefined;
}

/** Bounds heartbeat dimensions to the same closed Unknown-reason vocabulary. */
export function normalizeUnknownReasonCounts(value: unknown): Partial<Record<UnknownReason, number>> {
  const input = record(value);
  if (!input) return {};
  const counts: Partial<Record<UnknownReason, number>> = {};
  for (const reason of UNKNOWN_REASONS) {
    const count = Number(input[reason]);
    if (!Number.isFinite(count) || count <= 0) continue;
    counts[reason] = Math.min(Number.MAX_SAFE_INTEGER, Math.round(count));
  }
  return counts;
}

/** Read-model gate for persisted or hot heartbeats across shadow/enforce -> legacy rollback. */
export function visibleUnknownReasonCounts(
  value: unknown,
): Partial<Record<UnknownReason, number>> | undefined {
  if (!classificationSemanticsVisible()) return undefined;
  const counts = normalizeUnknownReasonCounts(value);
  return Object.keys(counts).length ? counts : undefined;
}

export function parseUnknownReason(value: unknown): UnknownReason | undefined {
  return typeof value === 'string' && UNKNOWN_REASONS.has(value as UnknownReason)
    ? value as UnknownReason
    : undefined;
}

export function parseProcessLifecycleSource(value: unknown): ProcessLifecycleSource | undefined {
  return typeof value === 'string' && PROCESS_LIFECYCLE_SOURCES.has(value as ProcessLifecycleSource)
    ? value as ProcessLifecycleSource
    : undefined;
}

function nonEmptyProcessContext(value: ProcessContext): ProcessContext | undefined {
  return Object.values(value).some((field) => field !== undefined) ? value : undefined;
}

/** Removes S3 lifecycle provenance without leaving a legacy-incompatible empty process object. */
export function processContextWithoutLifecycle(
  value: ProcessContext | undefined,
): ProcessContext | undefined {
  if (!value) return undefined;
  const {
    lifecycleSource: _lifecycleSource,
    lifecycleReason: _lifecycleReason,
    ...legacyProcess
  } = value;
  return nonEmptyProcessContext(legacyProcess);
}

/** Applies the S3 kill switch and validates lifecycle provenance at every read/write boundary. */
export function visibleProcessContext(value: ProcessContext | undefined): ProcessContext | undefined {
  if (!value) return undefined;
  const {
    lifecycleSource: rawLifecycleSource,
    lifecycleReason: rawLifecycleReason,
    ...legacyProcess
  } = value;
  if (!classificationSemanticsVisible()) return nonEmptyProcessContext(legacyProcess);
  const lifecycleSource = parseProcessLifecycleSource(rawLifecycleSource);
  const lifecycleReason = parseUnknownReason(rawLifecycleReason);
  return nonEmptyProcessContext({
    ...legacyProcess,
    ...(lifecycleSource ? { lifecycleSource } : {}),
    ...(lifecycleReason ? { lifecycleReason } : {}),
  });
}
