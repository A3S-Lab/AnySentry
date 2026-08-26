import { createHash } from 'node:crypto';

export const SYSTEM_CONTEXT_BUNDLE_SCHEMA_VERSION = 'anysentry.system_context_bundle.v1' as const;

export type SystemContextDomain =
  | 'inventory'
  | 'tool_evidence'
  | 'topology'
  | 'metrics'
  | 'alerts'
  | 'changes'
  | 'collection_quality';

export type SystemContextSourceKind =
  | 'kubernetes_inventory'
  | 'docker_inventory'
  | 'systemd_inventory'
  | 'agent_adapter'
  | 'observer'
  | 'observer_aggregate'
  | 'prometheus'
  | 'otel'
  | 'alert_manager'
  | 'deployment_controller'
  | 'audit_log'
  | 'clickhouse'
  | 'custom';

export type SystemContextResourceKind =
  | 'agent_runtime'
  | 'service'
  | 'database'
  | 'queue'
  | 'external_endpoint'
  | 'host'
  | 'container'
  | 'pod'
  | 'systemd_unit'
  | 'unknown';

export type SystemContextWorkloadRole =
  | 'agent'
  | 'anysentry_internal'
  | 'platform_infrastructure'
  | 'business_service'
  | 'ordinary_process'
  | 'unknown';

export type SystemContextFreshnessState = 'fresh' | 'stale' | 'future' | 'unknown';

export interface SystemContextEvidenceInput {
  sourceId: string;
  sourceKind: SystemContextSourceKind;
  authority: string;
  recordId?: string;
  observedAt: number;
  freshnessTtlMs?: number;
  confidence: number;
  associationMethod: string;
  inferred?: boolean;
}

export interface SystemContextEvidence {
  source: {
    sourceId: string;
    kind: SystemContextSourceKind;
    authority: string;
    recordId?: string;
  };
  observedAt: string;
  freshness: {
    state: SystemContextFreshnessState;
    ageMs?: number;
    ttlMs: number;
    evaluatedAt: string;
  };
  association: {
    confidence: number;
    method: string;
    authority: string;
    inferred: boolean;
  };
}

export interface SystemContextAgentFocusInput {
  agentAssetId: string;
  agentRuntimeInstanceId?: string;
  invocationId?: string;
  toolCallId?: string;
  physicalWorkloadId?: string;
  relatedResourceIds?: string[];
  evidence: SystemContextEvidenceInput;
}

export interface SystemContextToolKernelEvidenceFact {
  eventId: string;
  eventKind: string;
  at: number;
  linkMethod: string;
  confidence: number;
  evidence: SystemContextEvidenceInput;
}

export interface SystemContextToolEvidenceFact {
  agentAssetId: string;
  agentRuntimeInstanceId?: string;
  invocationId: string;
  toolCallId: string;
  toolName: string;
  status: 'linked' | 'semantic_only' | 'ambiguous';
  reason: string;
  startedAt?: number;
  endedAt?: number;
  adapterEventIds?: string[];
  kernelEvidence?: SystemContextToolKernelEvidenceFact[];
  relatedResourceIds?: string[];
  evidence: SystemContextEvidenceInput;
}

export interface SystemContextResourceFact {
  resourceId: string;
  kind: SystemContextResourceKind;
  role: SystemContextWorkloadRole;
  name: string;
  namespace?: string;
  environment?: string;
  physicalWorkloadId?: string;
  validFrom?: number;
  validTo?: number;
  evidence: SystemContextEvidenceInput;
}

export interface SystemContextDependencyFact {
  edgeId: string;
  sourceResourceId: string;
  targetResourceId: string;
  relation: 'calls' | 'connects' | 'queries' | 'publishes' | 'consumes' | 'resolves' | 'stores' | 'unknown';
  firstObservedAt: number;
  lastObservedAt: number;
  eventCount: number;
  aggregated: boolean;
  evidence: SystemContextEvidenceInput;
}

export interface SystemContextMetricFact {
  metricId: string;
  resourceId: string;
  name: string;
  value: number;
  unit?: string;
  kind: 'gauge' | 'counter' | 'rate' | 'histogram_summary';
  status: 'normal' | 'anomalous' | 'unknown';
  observedAt: number;
  evidence: SystemContextEvidenceInput;
}

export interface SystemContextAlertFact {
  alertId: string;
  resourceIds: string[];
  agentAssetId?: string;
  title: string;
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
  status: 'open' | 'acknowledged' | 'resolved' | 'silenced';
  firstSeenAt: number;
  lastSeenAt: number;
  evidence: SystemContextEvidenceInput;
}

export interface SystemContextChangeFact {
  changeId: string;
  resourceIds: string[];
  agentAssetId?: string;
  type: 'deployment' | 'configuration' | 'image' | 'restart' | 'scale' | 'policy' | 'unknown';
  summary: string;
  at: number;
  evidence: SystemContextEvidenceInput;
}

export interface SystemContextCollectionQualityFact {
  collectorId: string;
  windowStartMs: number;
  windowEndMs: number;
  rawKernelDetail: 'full' | 'aggregated' | 'sampled' | 'mixed' | 'unknown';
  accountingConserved: boolean;
  ringDropped: number;
  collectorDropped: number;
  queueDropped: number;
  aggregateSummariesIncomplete: boolean;
  evidence: SystemContextEvidenceInput;
}

export interface SystemContextSourceStatusInput {
  domain: SystemContextDomain;
  sourceId: string;
  sourceKind: SystemContextSourceKind;
  state: 'complete' | 'partial' | 'unavailable';
  checkedAt: number;
  lastObservedAt?: number;
  freshnessTtlMs?: number;
  required?: boolean;
  truncated?: boolean;
  recordsRead?: number;
  reason?: string;
}

export interface SystemContextBundleLimitsInput {
  maxWindowMs?: number;
  maxHops?: number;
  maxTools?: number;
  maxKernelEvidencePerTool?: number;
  maxResources?: number;
  maxDependencies?: number;
  maxMetrics?: number;
  maxMetricsPerResource?: number;
  maxAlerts?: number;
  maxChanges?: number;
  maxCollectionQuality?: number;
  maxSources?: number;
  maxBytes?: number;
}

export interface SystemContextBundleInput {
  focus: SystemContextAgentFocusInput;
  window: { startMs: number; endMs: number };
  expectedDomains?: SystemContextDomain[];
  toolEvidence?: SystemContextToolEvidenceFact[];
  resources?: SystemContextResourceFact[];
  dependencies?: SystemContextDependencyFact[];
  metrics?: SystemContextMetricFact[];
  alerts?: SystemContextAlertFact[];
  changes?: SystemContextChangeFact[];
  collectionQuality?: SystemContextCollectionQualityFact[];
  sourceStatus?: SystemContextSourceStatusInput[];
  limits?: SystemContextBundleLimitsInput;
}

export interface SystemContextToolEvidence {
  invocationId: string;
  toolCallId: string;
  toolName: string;
  status: SystemContextToolEvidenceFact['status'];
  reason: string;
  startedAt?: string;
  endedAt?: string;
  adapterEventIds: string[];
  kernelEvidence: Array<{
    eventId: string;
    eventKind: string;
    at: string;
    linkMethod: string;
    confidence: number;
    evidence: SystemContextEvidence;
  }>;
  relatedResourceIds: string[];
  evidence: SystemContextEvidence;
}

export interface SystemContextResource {
  resourceId: string;
  kind: SystemContextResourceKind;
  role: SystemContextWorkloadRole;
  name: string;
  namespace?: string;
  environment?: string;
  physicalWorkloadId?: string;
  evidence: SystemContextEvidence;
}

export interface SystemContextDependency {
  edgeId: string;
  sourceResourceId: string;
  targetResourceId: string;
  relation: SystemContextDependencyFact['relation'];
  hop: number;
  firstObservedAt: string;
  lastObservedAt: string;
  eventCount: number;
  aggregated: boolean;
  evidence: SystemContextEvidence;
}

export interface SystemContextMetric {
  metricId: string;
  resourceId: string;
  name: string;
  value: number;
  unit?: string;
  kind: SystemContextMetricFact['kind'];
  status: SystemContextMetricFact['status'];
  observedAt: string;
  evidence: SystemContextEvidence;
}

export interface SystemContextAlert {
  alertId: string;
  resourceIds: string[];
  title: string;
  severity: SystemContextAlertFact['severity'];
  status: SystemContextAlertFact['status'];
  firstSeenAt: string;
  lastSeenAt: string;
  evidence: SystemContextEvidence;
}

export interface SystemContextChange {
  changeId: string;
  resourceIds: string[];
  type: SystemContextChangeFact['type'];
  summary: string;
  at: string;
  evidence: SystemContextEvidence;
}

export interface SystemContextCollectionQuality {
  collectorId: string;
  windowStart: string;
  windowEnd: string;
  rawKernelDetail: SystemContextCollectionQualityFact['rawKernelDetail'];
  accountingConserved: boolean;
  losses: {
    ringDropped: number;
    collectorDropped: number;
    queueDropped: number;
  };
  aggregateSummariesIncomplete: boolean;
  evidence: SystemContextEvidence;
}

export interface SystemContextSourceStatus {
  domain: SystemContextDomain;
  sourceId: string;
  sourceKind: SystemContextSourceKind;
  state: SystemContextSourceStatusInput['state'];
  required: boolean;
  checkedAt: string;
  lastObservedAt?: string;
  freshness: SystemContextEvidence['freshness'];
  truncated: boolean;
  recordsRead?: number;
  reason?: string;
}

export type SystemContextQualityReasonCode =
  | 'time_window_clamped'
  | 'topology_seed_missing'
  | 'source_status_missing'
  | 'source_partial'
  | 'source_unavailable'
  | 'source_stale'
  | 'candidate_scan_limit'
  | 'result_limit'
  | 'byte_budget'
  | 'invalid_fact'
  | 'raw_kernel_detail_aggregated'
  | 'raw_kernel_detail_sampled'
  | 'ring_loss'
  | 'collector_loss'
  | 'queue_loss'
  | 'aggregate_summary_incomplete'
  | 'accounting_unreconciled';

export interface SystemContextQualityReason {
  code: SystemContextQualityReasonCode;
  domain?: SystemContextDomain;
  sourceId?: string;
  detail?: string;
}

export interface SystemContextBundle {
  schemaVersion: typeof SYSTEM_CONTEXT_BUNDLE_SCHEMA_VERSION;
  bundleId: string;
  generatedAt: string;
  focus: {
    agentAssetId: string;
    agentRuntimeInstanceId?: string;
    invocationId?: string;
    toolCallId?: string;
    physicalWorkloadId?: string;
    evidence: SystemContextEvidence;
  };
  window: {
    startAt: string;
    endAt: string;
    requestedStartAt: string;
    requestedEndAt: string;
    clamped: boolean;
  };
  limits: Required<SystemContextBundleLimitsInput>;
  toolEvidence: SystemContextToolEvidence[];
  relatedResources: SystemContextResource[];
  dependencies: SystemContextDependency[];
  metrics: SystemContextMetric[];
  alerts: SystemContextAlert[];
  changes: SystemContextChange[];
  collectionQuality: SystemContextCollectionQuality[];
  quality: {
    status: 'complete' | 'partial';
    confidence: number;
    reasons: SystemContextQualityReason[];
    domains: Array<{
      domain: SystemContextDomain;
      state: 'complete' | 'partial' | 'missing';
      sourceIds: string[];
    }>;
    sources: SystemContextSourceStatus[];
    bounds: Record<'toolEvidence' | 'resources' | 'dependencies' | 'metrics' | 'alerts' | 'changes' | 'collectionQuality' | 'sources', {
      input: number;
      scanned: number;
      included: number;
      omitted: number;
      truncated: boolean;
    }>;
    output: {
      estimatedBytes: number;
      maxBytes: number;
      truncated: boolean;
    };
  };
  summary: {
    toolCallCount: number;
    linkedToolCallCount: number;
    relatedResourceCount: number;
    businessServiceCount: number;
    dependencyCount: number;
    anomalousMetricCount: number;
    activeAlertCount: number;
    changeCount: number;
    maxTopologyHop: number;
  };
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const HARD_MAX_WINDOW_MS = 7 * DAY;
const INPUT_SCAN_LIMIT = 20_000;

const DEFAULT_LIMITS: Required<SystemContextBundleLimitsInput> = {
  maxWindowMs: DAY,
  maxHops: 2,
  maxTools: 32,
  maxKernelEvidencePerTool: 32,
  maxResources: 32,
  maxDependencies: 48,
  maxMetrics: 64,
  maxMetricsPerResource: 8,
  maxAlerts: 32,
  maxChanges: 32,
  maxCollectionQuality: 8,
  maxSources: 32,
  maxBytes: 256 * 1_024,
};

const LIMIT_BOUNDS: Record<keyof SystemContextBundleLimitsInput, [number, number]> = {
  maxWindowMs: [MINUTE, HARD_MAX_WINDOW_MS],
  // Risk context is deliberately local: Agent -> directly accessed service -> one adjacent
  // dependency. A caller may ask for less, but must not widen this into a cluster graph scan.
  maxHops: [1, 2],
  maxTools: [1, 100],
  maxKernelEvidencePerTool: [1, 256],
  maxResources: [1, 100],
  maxDependencies: [1, 200],
  maxMetrics: [1, 256],
  maxMetricsPerResource: [1, 32],
  maxAlerts: [1, 100],
  maxChanges: [1, 100],
  maxCollectionQuality: [1, 32],
  maxSources: [1, 100],
  maxBytes: [32 * 1_024, 1024 * 1_024],
};

type BoundKey = keyof SystemContextBundle['quality']['bounds'];

interface BoundTracker {
  input: number;
  scanned: number;
  candidate: number;
  scanTruncated: boolean;
  limitTruncated: boolean;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}

function clean(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, limit) : undefined;
}

function requiredText(value: unknown, name: string, limit = 240): string {
  const normalized = clean(value, limit);
  if (!normalized) throw new Error(`system context requires ${name}`);
  return normalized;
}

function iso(value: number): string {
  return new Date(value).toISOString();
}

function idList(values: unknown, maximum = 64): string[] {
  if (!Array.isArray(values)) return [];
  // Producers should already emit bounded identities. Keep this defensive parser bounded too so
  // a malformed fact cannot turn context construction into a second unbounded data plane.
  return [...new Set(values.slice(0, maximum * 4).flatMap((value) => {
    const normalized = clean(value, 240);
    return normalized ? [normalized] : [];
  }))].slice(0, maximum);
}

function nonnegative(value: unknown): number {
  return finite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function overlap(start: number, end: number, windowStart: number, windowEnd: number): boolean {
  return finite(start) && finite(end) && start <= end && end >= windowStart && start <= windowEnd;
}

function evidence(
  input: SystemContextEvidenceInput,
  referenceAt: number,
): SystemContextEvidence | undefined {
  const sourceId = clean(input?.sourceId, 240);
  const authority = clean(input?.authority, 120);
  const method = clean(input?.associationMethod, 120);
  if (!sourceId || !authority || !method || !finite(input?.observedAt)) return undefined;
  const ttlMs = clamp(
    finite(input.freshnessTtlMs) ? input.freshnessTtlMs : 5 * MINUTE,
    1_000,
    HARD_MAX_WINDOW_MS,
  );
  const ageMs = referenceAt - input.observedAt;
  const state: SystemContextFreshnessState = ageMs < -MINUTE
    ? 'future'
    : ageMs <= ttlMs
      ? 'fresh'
      : 'stale';
  return {
    source: {
      sourceId,
      kind: input.sourceKind,
      authority,
      ...(clean(input.recordId, 240) ? { recordId: clean(input.recordId, 240) } : {}),
    },
    observedAt: iso(input.observedAt),
    freshness: {
      state,
      ageMs: Math.max(0, ageMs),
      ttlMs,
      evaluatedAt: iso(referenceAt),
    },
    association: {
      confidence: finite(input.confidence) ? Math.max(0, Math.min(1, input.confidence)) : 0,
      method,
      authority,
      inferred: input.inferred === true,
    },
  };
}

export function systemContextBundleLimits(
  input: SystemContextBundleLimitsInput | undefined,
): Required<SystemContextBundleLimitsInput> {
  const out = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(DEFAULT_LIMITS) as Array<keyof SystemContextBundleLimitsInput>) {
    const value = input?.[key];
    if (!finite(value)) continue;
    const [minimum, maximum] = LIMIT_BOUNDS[key];
    out[key] = clamp(value, minimum, maximum);
  }
  return out;
}

function tracker(input: unknown[] | undefined): BoundTracker {
  const length = input?.length ?? 0;
  return {
    input: length,
    scanned: Math.min(length, INPUT_SCAN_LIMIT),
    candidate: 0,
    scanTruncated: length > INPUT_SCAN_LIMIT,
    limitTruncated: false,
  };
}

function scanned<T>(input: T[] | undefined): T[] {
  return (input ?? []).slice(0, INPUT_SCAN_LIMIT);
}

function addReason(
  reasons: SystemContextQualityReason[],
  reason: SystemContextQualityReason,
): void {
  if (reasons.some((candidate) =>
    candidate.code === reason.code &&
    candidate.domain === reason.domain &&
    candidate.sourceId === reason.sourceId &&
    candidate.detail === reason.detail,
  )) return;
  reasons.push(reason);
}

function severityRank(value: SystemContextAlertFact['severity']): number {
  return { info: 0, low: 1, medium: 2, high: 3, critical: 4 }[value];
}

function bundleId(focus: SystemContextBundle['focus'], startMs: number, endMs: number): string {
  const digest = createHash('sha256')
    .update(focus.agentAssetId).update('\0')
    .update(focus.agentRuntimeInstanceId ?? '').update('\0')
    .update(focus.invocationId ?? '').update('\0')
    .update(focus.toolCallId ?? '').update('\0')
    .update(String(startMs)).update('\0')
    .update(String(endMs))
    .digest('hex');
  return `scb_${digest.slice(0, 24)}`;
}

/**
 * Builds a bounded risk-analysis view from already scoped, normalized facts.
 *
 * This function does not scan a cluster or infer a ToolCall from time. Callers must query each
 * backing data plane with the returned limits, then pass the candidate facts here. Topology is
 * expanded only from the selected Agent/runtime/tool resources and never from a global root.
 */
export function buildSystemContextBundle(
  input: SystemContextBundleInput,
  generatedAtMs = Date.now(),
): SystemContextBundle {
  if (!finite(generatedAtMs)) throw new Error('system context requires a valid generation time');
  if (!finite(input.window?.startMs) || !finite(input.window?.endMs) || input.window.startMs > input.window.endMs) {
    throw new Error('system context requires a valid time window');
  }
  const limits = systemContextBundleLimits(input.limits);
  const requestedStartMs = input.window.startMs;
  const requestedEndMs = input.window.endMs;
  const endMs = Math.min(requestedEndMs, generatedAtMs + MINUTE);
  const startMs = Math.min(endMs, Math.max(requestedStartMs, endMs - limits.maxWindowMs));
  const referenceAt = Math.min(generatedAtMs, endMs);
  const clampedWindow = startMs !== requestedStartMs || endMs !== requestedEndMs;
  const focusEvidence = evidence(input.focus.evidence, referenceAt);
  if (!focusEvidence) throw new Error('system context requires valid focus evidence');

  const focus: SystemContextBundle['focus'] = {
    agentAssetId: requiredText(input.focus.agentAssetId, 'agentAssetId'),
    ...(clean(input.focus.agentRuntimeInstanceId, 240) ? { agentRuntimeInstanceId: clean(input.focus.agentRuntimeInstanceId, 240) } : {}),
    ...(clean(input.focus.invocationId, 240) ? { invocationId: clean(input.focus.invocationId, 240) } : {}),
    ...(clean(input.focus.toolCallId, 240) ? { toolCallId: clean(input.focus.toolCallId, 240) } : {}),
    ...(clean(input.focus.physicalWorkloadId, 240) ? { physicalWorkloadId: clean(input.focus.physicalWorkloadId, 240) } : {}),
    evidence: focusEvidence,
  };

  const reasons: SystemContextQualityReason[] = [];
  if (clampedWindow) addReason(reasons, { code: 'time_window_clamped' });

  const trackers: Record<BoundKey, BoundTracker> = {
    toolEvidence: tracker(input.toolEvidence),
    resources: tracker(input.resources),
    dependencies: tracker(input.dependencies),
    metrics: tracker(input.metrics),
    alerts: tracker(input.alerts),
    changes: tracker(input.changes),
    collectionQuality: tracker(input.collectionQuality),
    sources: tracker(input.sourceStatus),
  };
  const invalidByDomain = new Map<SystemContextDomain, number>();
  const invalid = (domain: SystemContextDomain) => invalidByDomain.set(domain, (invalidByDomain.get(domain) ?? 0) + 1);

  const toolCandidates: SystemContextToolEvidence[] = [];
  for (const fact of scanned(input.toolEvidence)) {
    if (fact.agentAssetId !== focus.agentAssetId) continue;
    if (focus.agentRuntimeInstanceId && fact.agentRuntimeInstanceId !== focus.agentRuntimeInstanceId) continue;
    if (focus.invocationId && fact.invocationId !== focus.invocationId) continue;
    if (focus.toolCallId && fact.toolCallId !== focus.toolCallId) continue;
    const toolStart = fact.startedAt ?? fact.endedAt;
    const toolEnd = fact.endedAt ?? fact.startedAt;
    if (!finite(toolStart) || !finite(toolEnd) || !overlap(toolStart, toolEnd, startMs, endMs)) continue;
    const toolEvidence = evidence(fact.evidence, referenceAt);
    const invocationId = clean(fact.invocationId, 240);
    const toolCallId = clean(fact.toolCallId, 240);
    const toolName = clean(fact.toolName, 160);
    if (!toolEvidence || !invocationId || !toolCallId || !toolName) {
      invalid('tool_evidence');
      continue;
    }
    const rawKernelEvidence = fact.kernelEvidence ?? [];
    if (rawKernelEvidence.length > INPUT_SCAN_LIMIT) trackers.toolEvidence.scanTruncated = true;
    const kernelCandidates = rawKernelEvidence.slice(0, INPUT_SCAN_LIMIT)
      .filter((item) => finite(item.at) && item.at >= startMs && item.at <= endMs)
      .sort((left, right) => left.at - right.at);
    const kernelEvidence = kernelCandidates.slice(0, limits.maxKernelEvidencePerTool).flatMap((item) => {
      const itemEvidence = evidence(item.evidence, referenceAt);
      const eventId = clean(item.eventId, 240);
      const eventKind = clean(item.eventKind, 120);
      const linkMethod = clean(item.linkMethod, 120);
      if (!itemEvidence || !eventId || !eventKind || !linkMethod) {
        invalid('tool_evidence');
        return [];
      }
      return [{
        eventId,
        eventKind,
        at: iso(item.at),
        linkMethod,
        confidence: finite(item.confidence) ? Math.max(0, Math.min(1, item.confidence)) : 0,
        evidence: itemEvidence,
      }];
    });
    if (kernelCandidates.length > limits.maxKernelEvidencePerTool) trackers.toolEvidence.limitTruncated = true;
    toolCandidates.push({
      invocationId,
      toolCallId,
      toolName,
      status: fact.status,
      reason: clean(fact.reason, 240) ?? 'unspecified',
      ...(finite(fact.startedAt) ? { startedAt: iso(fact.startedAt) } : {}),
      ...(finite(fact.endedAt) ? { endedAt: iso(fact.endedAt) } : {}),
      adapterEventIds: idList(fact.adapterEventIds),
      kernelEvidence,
      relatedResourceIds: idList(fact.relatedResourceIds),
      evidence: toolEvidence,
    });
  }
  toolCandidates.sort((left, right) => Date.parse(left.startedAt ?? left.endedAt ?? '') - Date.parse(right.startedAt ?? right.endedAt ?? '') || left.toolCallId.localeCompare(right.toolCallId));
  trackers.toolEvidence.candidate = toolCandidates.length;
  const toolEvidence = toolCandidates.slice(0, limits.maxTools);
  if (toolCandidates.length > limits.maxTools) trackers.toolEvidence.limitTruncated = true;

  const rootResourceIds = idList(focus.physicalWorkloadId ? [focus.physicalWorkloadId] : [], limits.maxResources);
  const directResourceIds = idList([
    ...idList(input.focus.relatedResourceIds),
    ...toolEvidence.flatMap((item) => item.relatedResourceIds),
  ], 256);
  const seedDepth = new Map<string, number>();
  for (const resourceId of rootResourceIds) seedDepth.set(resourceId, 0);
  for (const resourceId of directResourceIds) {
    if (seedDepth.has(resourceId)) continue;
    if (seedDepth.size >= limits.maxResources) {
      trackers.resources.limitTruncated = true;
      break;
    }
    // A resource named by a Tool span is already one hop away from the Agent. Starting it at
    // depth zero would accidentally widen a two-hop query into three service hops.
    seedDepth.set(resourceId, 1);
  }
  if (seedDepth.size === 0) addReason(reasons, { code: 'topology_seed_missing', domain: 'topology' });

  const resourceById = new Map<string, SystemContextResource>();
  for (const fact of scanned(input.resources)) {
    const resourceId = clean(fact.resourceId, 240);
    const name = clean(fact.name, 240);
    const itemEvidence = evidence(fact.evidence, referenceAt);
    const validFrom = finite(fact.validFrom) ? fact.validFrom : startMs;
    const validTo = finite(fact.validTo) ? fact.validTo : endMs;
    if (!resourceId || !name || !itemEvidence || !overlap(validFrom, validTo, startMs, endMs)) {
      if (resourceId && seedDepth.has(resourceId)) invalid('inventory');
      continue;
    }
    const candidate: SystemContextResource = {
      resourceId,
      kind: fact.kind,
      role: fact.role,
      name,
      ...(clean(fact.namespace, 160) ? { namespace: clean(fact.namespace, 160) } : {}),
      ...(clean(fact.environment, 160) ? { environment: clean(fact.environment, 160) } : {}),
      ...(clean(fact.physicalWorkloadId, 240) ? { physicalWorkloadId: clean(fact.physicalWorkloadId, 240) } : {}),
      evidence: itemEvidence,
    };
    const existing = resourceById.get(resourceId);
    if (!existing || Date.parse(candidate.evidence.observedAt) > Date.parse(existing.evidence.observedAt)) {
      resourceById.set(resourceId, candidate);
    }
  }
  for (const resourceId of seedDepth.keys()) {
    if (!resourceById.has(resourceId)) invalid('inventory');
  }

  const dependencyBySource = new Map<string, SystemContextDependencyFact[]>();
  for (const fact of scanned(input.dependencies)) {
    if (!overlap(fact.firstObservedAt, fact.lastObservedAt, startMs, endMs)) continue;
    const source = clean(fact.sourceResourceId, 240);
    const target = clean(fact.targetResourceId, 240);
    const edge = clean(fact.edgeId, 240);
    if (!source || !target || !edge || !evidence(fact.evidence, referenceAt)) {
      invalid('topology');
      continue;
    }
    const list = dependencyBySource.get(source) ?? [];
    list.push(fact);
    dependencyBySource.set(source, list);
  }
  for (const list of dependencyBySource.values()) {
    list.sort((left, right) =>
      right.lastObservedAt - left.lastObservedAt ||
      right.evidence.confidence - left.evidence.confidence ||
      right.eventCount - left.eventCount ||
      left.edgeId.localeCompare(right.edgeId),
    );
  }

  const reachedDepth = new Map(seedDepth);
  const reachedOrder = [...seedDepth.keys()];
  const frontier = [...seedDepth.entries()].sort((left, right) => left[1] - right[1] || left[0].localeCompare(right[0]));
  const dependencies: SystemContextDependency[] = [];
  const selectedEdgeIds = new Set<string>();
  for (let cursor = 0; cursor < frontier.length; cursor += 1) {
    const [source, sourceDepth] = frontier[cursor];
    if (sourceDepth >= limits.maxHops) continue;
    // A dependency without both resource facts is not a usable context edge. Besides producing a
    // dangling response, traversing through an unknown intermediate would let an edge-only feed
    // widen the graph beyond the inventory that the caller can actually audit.
    if (!resourceById.has(source)) continue;
    const hop = sourceDepth + 1;
    for (const fact of dependencyBySource.get(source) ?? []) {
      trackers.dependencies.candidate += 1;
      if (dependencies.length >= limits.maxDependencies) {
        trackers.dependencies.limitTruncated = true;
        continue;
      }
      const edgeId = clean(fact.edgeId, 240)!;
      if (selectedEdgeIds.has(edgeId)) continue;
      const targetResourceId = clean(fact.targetResourceId, 240)!;
      if (!resourceById.has(targetResourceId)) {
        invalid('topology');
        continue;
      }
      if (!reachedDepth.has(targetResourceId) && reachedOrder.length >= limits.maxResources) {
        trackers.resources.limitTruncated = true;
        trackers.dependencies.limitTruncated = true;
        continue;
      }
      const itemEvidence = evidence(fact.evidence, referenceAt)!;
      dependencies.push({
        edgeId,
        sourceResourceId: clean(fact.sourceResourceId, 240)!,
        targetResourceId,
        relation: fact.relation,
        hop,
        firstObservedAt: iso(fact.firstObservedAt),
        lastObservedAt: iso(fact.lastObservedAt),
        eventCount: nonnegative(fact.eventCount),
        aggregated: fact.aggregated === true,
        evidence: itemEvidence,
      });
      selectedEdgeIds.add(edgeId);
      if (!reachedDepth.has(targetResourceId)) {
        reachedDepth.set(targetResourceId, hop);
        reachedOrder.push(targetResourceId);
        frontier.push([targetResourceId, hop]);
      }
    }
  }

  const relatedResources = reachedOrder.flatMap((resourceId) => {
    const item = resourceById.get(resourceId);
    return item ? [item] : [];
  }).slice(0, limits.maxResources);
  trackers.resources.candidate = reachedOrder.filter((resourceId) => resourceById.has(resourceId)).length;
  if (trackers.resources.candidate > limits.maxResources) trackers.resources.limitTruncated = true;

  const metricCandidates: SystemContextMetric[] = [];
  for (const fact of scanned(input.metrics)) {
    if (!reachedDepth.has(fact.resourceId) || !finite(fact.observedAt) || fact.observedAt < startMs || fact.observedAt > endMs || !finite(fact.value)) continue;
    const metricId = clean(fact.metricId, 240);
    const name = clean(fact.name, 240);
    const itemEvidence = evidence(fact.evidence, referenceAt);
    if (!metricId || !name || !itemEvidence) {
      invalid('metrics');
      continue;
    }
    metricCandidates.push({
      metricId,
      resourceId: requiredText(fact.resourceId, 'metric resourceId'),
      name,
      value: fact.value,
      ...(clean(fact.unit, 64) ? { unit: clean(fact.unit, 64) } : {}),
      kind: fact.kind,
      status: fact.status,
      observedAt: iso(fact.observedAt),
      evidence: itemEvidence,
    });
  }
  metricCandidates.sort((left, right) =>
    Number(right.status === 'anomalous') - Number(left.status === 'anomalous') ||
    Date.parse(right.observedAt) - Date.parse(left.observedAt) ||
    left.metricId.localeCompare(right.metricId),
  );
  trackers.metrics.candidate = metricCandidates.length;
  const metricCountByResource = new Map<string, number>();
  const metrics: SystemContextMetric[] = [];
  for (const item of metricCandidates) {
    if (metrics.length >= limits.maxMetrics) {
      trackers.metrics.limitTruncated = true;
      continue;
    }
    const resourceCount = metricCountByResource.get(item.resourceId) ?? 0;
    if (resourceCount >= limits.maxMetricsPerResource) {
      trackers.metrics.limitTruncated = true;
      continue;
    }
    metricCountByResource.set(item.resourceId, resourceCount + 1);
    metrics.push(item);
  }

  const alertCandidates: SystemContextAlert[] = [];
  for (const fact of scanned(input.alerts)) {
    const relatedIds = idList(fact.resourceIds);
    const isRelated = fact.agentAssetId === focus.agentAssetId || relatedIds.some((resourceId) => reachedDepth.has(resourceId));
    if (!isRelated || !overlap(fact.firstSeenAt, fact.lastSeenAt, startMs, endMs)) continue;
    const alertId = clean(fact.alertId, 240);
    const title = clean(fact.title, 500);
    const itemEvidence = evidence(fact.evidence, referenceAt);
    if (!alertId || !title || !itemEvidence) {
      invalid('alerts');
      continue;
    }
    alertCandidates.push({
      alertId,
      resourceIds: relatedIds.filter((resourceId) => reachedDepth.has(resourceId)),
      title,
      severity: fact.severity,
      status: fact.status,
      firstSeenAt: iso(fact.firstSeenAt),
      lastSeenAt: iso(fact.lastSeenAt),
      evidence: itemEvidence,
    });
  }
  alertCandidates.sort((left, right) =>
    Number(right.status !== 'resolved') - Number(left.status !== 'resolved') ||
    severityRank(right.severity) - severityRank(left.severity) ||
    Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt),
  );
  trackers.alerts.candidate = alertCandidates.length;
  const alerts = alertCandidates.slice(0, limits.maxAlerts);
  if (alertCandidates.length > limits.maxAlerts) trackers.alerts.limitTruncated = true;

  const changeCandidates: SystemContextChange[] = [];
  for (const fact of scanned(input.changes)) {
    const relatedIds = idList(fact.resourceIds);
    const isRelated = fact.agentAssetId === focus.agentAssetId || relatedIds.some((resourceId) => reachedDepth.has(resourceId));
    if (!isRelated || !finite(fact.at) || fact.at < startMs || fact.at > endMs) continue;
    const changeId = clean(fact.changeId, 240);
    const summary = clean(fact.summary, 500);
    const itemEvidence = evidence(fact.evidence, referenceAt);
    if (!changeId || !summary || !itemEvidence) {
      invalid('changes');
      continue;
    }
    changeCandidates.push({
      changeId,
      resourceIds: relatedIds.filter((resourceId) => reachedDepth.has(resourceId)),
      type: fact.type,
      summary,
      at: iso(fact.at),
      evidence: itemEvidence,
    });
  }
  changeCandidates.sort((left, right) => Date.parse(right.at) - Date.parse(left.at));
  trackers.changes.candidate = changeCandidates.length;
  const changes = changeCandidates.slice(0, limits.maxChanges);
  if (changeCandidates.length > limits.maxChanges) trackers.changes.limitTruncated = true;

  const collectionCandidates: SystemContextCollectionQuality[] = [];
  for (const fact of scanned(input.collectionQuality)) {
    if (!overlap(fact.windowStartMs, fact.windowEndMs, startMs, endMs)) continue;
    const collectorId = clean(fact.collectorId, 240);
    const itemEvidence = evidence(fact.evidence, referenceAt);
    if (!collectorId || !itemEvidence) {
      invalid('collection_quality');
      continue;
    }
    collectionCandidates.push({
      collectorId,
      windowStart: iso(fact.windowStartMs),
      windowEnd: iso(fact.windowEndMs),
      rawKernelDetail: fact.rawKernelDetail,
      accountingConserved: fact.accountingConserved === true,
      losses: {
        ringDropped: nonnegative(fact.ringDropped),
        collectorDropped: nonnegative(fact.collectorDropped),
        queueDropped: nonnegative(fact.queueDropped),
      },
      aggregateSummariesIncomplete: fact.aggregateSummariesIncomplete === true,
      evidence: itemEvidence,
    });
  }
  collectionCandidates.sort((left, right) => Date.parse(right.windowEnd) - Date.parse(left.windowEnd));
  trackers.collectionQuality.candidate = collectionCandidates.length;
  const collectionQuality = collectionCandidates.slice(0, limits.maxCollectionQuality);
  if (collectionCandidates.length > limits.maxCollectionQuality) trackers.collectionQuality.limitTruncated = true;

  const sourceCandidates: SystemContextSourceStatus[] = [];
  for (const status of scanned(input.sourceStatus)) {
    const sourceId = clean(status.sourceId, 240);
    if (!sourceId || !finite(status.checkedAt)) {
      invalid(status.domain);
      continue;
    }
    const observedAt = finite(status.lastObservedAt) ? status.lastObservedAt : status.checkedAt;
    const statusEvidence = evidence({
      sourceId,
      sourceKind: status.sourceKind,
      authority: 'query_adapter',
      observedAt,
      freshnessTtlMs: status.freshnessTtlMs,
      confidence: status.state === 'complete' ? 1 : status.state === 'partial' ? 0.6 : 0,
      associationMethod: 'source_status',
    }, generatedAtMs)!;
    sourceCandidates.push({
      domain: status.domain,
      sourceId,
      sourceKind: status.sourceKind,
      state: status.state,
      required: status.required !== false,
      checkedAt: iso(status.checkedAt),
      ...(finite(status.lastObservedAt) ? { lastObservedAt: iso(status.lastObservedAt) } : {}),
      freshness: statusEvidence.freshness,
      truncated: status.truncated === true,
      ...(finite(status.recordsRead) ? { recordsRead: nonnegative(status.recordsRead) } : {}),
      ...(clean(status.reason, 240) ? { reason: clean(status.reason, 240) } : {}),
    });
  }
  sourceCandidates.sort((left, right) => left.domain.localeCompare(right.domain) || left.sourceId.localeCompare(right.sourceId));
  trackers.sources.candidate = sourceCandidates.length;
  const sources = sourceCandidates.slice(0, limits.maxSources);
  if (sourceCandidates.length > limits.maxSources) trackers.sources.limitTruncated = true;

  for (const [key, value] of Object.entries(trackers) as Array<[BoundKey, BoundTracker]>) {
    if (value.scanTruncated) addReason(reasons, { code: 'candidate_scan_limit', domain: domainForBound(key), detail: key });
    if (value.limitTruncated) addReason(reasons, { code: 'result_limit', domain: domainForBound(key), detail: key });
  }
  for (const [domain, count] of invalidByDomain) {
    if (count > 0) addReason(reasons, { code: 'invalid_fact', domain, detail: String(count) });
  }
  for (const item of collectionQuality) {
    if (item.rawKernelDetail === 'aggregated' || item.rawKernelDetail === 'mixed') {
      addReason(reasons, { code: 'raw_kernel_detail_aggregated', domain: 'collection_quality', sourceId: item.collectorId });
    }
    if (item.rawKernelDetail === 'sampled' || item.rawKernelDetail === 'mixed') {
      addReason(reasons, { code: 'raw_kernel_detail_sampled', domain: 'collection_quality', sourceId: item.collectorId });
    }
    if (item.losses.ringDropped > 0) addReason(reasons, { code: 'ring_loss', domain: 'collection_quality', sourceId: item.collectorId });
    if (item.losses.collectorDropped > 0) addReason(reasons, { code: 'collector_loss', domain: 'collection_quality', sourceId: item.collectorId });
    if (item.losses.queueDropped > 0) addReason(reasons, { code: 'queue_loss', domain: 'collection_quality', sourceId: item.collectorId });
    if (item.aggregateSummariesIncomplete) addReason(reasons, { code: 'aggregate_summary_incomplete', domain: 'collection_quality', sourceId: item.collectorId });
    if (!item.accountingConserved) addReason(reasons, { code: 'accounting_unreconciled', domain: 'collection_quality', sourceId: item.collectorId });
  }

  const defaultExpectedDomains: SystemContextDomain[] = [
    'inventory',
    ...(focus.invocationId || focus.toolCallId ? ['tool_evidence' as const] : []),
    'topology',
    'metrics',
    'alerts',
    'changes',
    'collection_quality',
  ];
  const expectedDomains = [...new Set(input.expectedDomains ?? defaultExpectedDomains)];

  const bundle: SystemContextBundle = {
    schemaVersion: SYSTEM_CONTEXT_BUNDLE_SCHEMA_VERSION,
    bundleId: bundleId(focus, startMs, endMs),
    generatedAt: iso(generatedAtMs),
    focus,
    window: {
      startAt: iso(startMs),
      endAt: iso(endMs),
      requestedStartAt: iso(requestedStartMs),
      requestedEndAt: iso(requestedEndMs),
      clamped: clampedWindow,
    },
    limits,
    toolEvidence,
    relatedResources,
    dependencies,
    metrics,
    alerts,
    changes,
    collectionQuality,
    quality: {
      status: 'complete',
      confidence: 0,
      reasons,
      domains: [],
      sources,
      bounds: emptyBounds(),
      output: { estimatedBytes: 0, maxBytes: limits.maxBytes, truncated: false },
    },
    summary: {
      toolCallCount: 0,
      linkedToolCallCount: 0,
      relatedResourceCount: 0,
      businessServiceCount: 0,
      dependencyCount: 0,
      anomalousMetricCount: 0,
      activeAlertCount: 0,
      changeCount: 0,
      maxTopologyHop: 0,
    },
  };

  const recompute = () => {
    bundle.summary = {
      toolCallCount: bundle.toolEvidence.length,
      linkedToolCallCount: bundle.toolEvidence.filter((item) => item.status === 'linked').length,
      relatedResourceCount: bundle.relatedResources.length,
      businessServiceCount: bundle.relatedResources.filter((item) => item.role === 'business_service').length,
      dependencyCount: bundle.dependencies.length,
      anomalousMetricCount: bundle.metrics.filter((item) => item.status === 'anomalous').length,
      activeAlertCount: bundle.alerts.filter((item) => item.status !== 'resolved').length,
      changeCount: bundle.changes.length,
      maxTopologyHop: bundle.dependencies.reduce((maximum, item) => Math.max(maximum, item.hop), 0),
    };
    bundle.quality.bounds = bounds(trackers, bundle);
    bundle.quality.domains = domainQuality(expectedDomains, bundle.quality.sources, bundle.quality.reasons);
    bundle.quality.status = bundle.quality.reasons.length || bundle.quality.domains.some((item) => item.state !== 'complete')
      ? 'partial'
      : 'complete';
    bundle.quality.confidence = contextConfidence(bundle);
  };

  recompute();
  while (Buffer.byteLength(JSON.stringify(bundle), 'utf8') > limits.maxBytes) {
    if (!dropLowestPriority(bundle)) break;
    bundle.quality.output.truncated = true;
    addReason(bundle.quality.reasons, { code: 'byte_budget' });
    recompute();
  }
  bundle.quality.output.estimatedBytes = Buffer.byteLength(JSON.stringify(bundle), 'utf8');
  // Updating the estimate can add a few bytes. One final bounded pass keeps the advertised hard
  // byte budget truthful instead of treating it as an approximation.
  while (Buffer.byteLength(JSON.stringify(bundle), 'utf8') > limits.maxBytes) {
    if (!dropLowestPriority(bundle)) break;
    bundle.quality.output.truncated = true;
    addReason(bundle.quality.reasons, { code: 'byte_budget' });
    recompute();
    bundle.quality.output.estimatedBytes = Buffer.byteLength(JSON.stringify(bundle), 'utf8');
  }
  bundle.quality.output.estimatedBytes = Buffer.byteLength(JSON.stringify(bundle), 'utf8');
  return bundle;
}

function domainForBound(key: BoundKey): SystemContextDomain | undefined {
  return {
    toolEvidence: 'tool_evidence',
    resources: 'inventory',
    dependencies: 'topology',
    metrics: 'metrics',
    alerts: 'alerts',
    changes: 'changes',
    collectionQuality: 'collection_quality',
    sources: undefined,
  }[key] as SystemContextDomain | undefined;
}

function emptyBounds(): SystemContextBundle['quality']['bounds'] {
  const empty = () => ({ input: 0, scanned: 0, included: 0, omitted: 0, truncated: false });
  return {
    toolEvidence: empty(),
    resources: empty(),
    dependencies: empty(),
    metrics: empty(),
    alerts: empty(),
    changes: empty(),
    collectionQuality: empty(),
    sources: empty(),
  };
}

function bounds(
  trackers: Record<BoundKey, BoundTracker>,
  bundle: SystemContextBundle,
): SystemContextBundle['quality']['bounds'] {
  const included: Record<BoundKey, number> = {
    toolEvidence: bundle.toolEvidence.length,
    resources: bundle.relatedResources.length,
    dependencies: bundle.dependencies.length,
    metrics: bundle.metrics.length,
    alerts: bundle.alerts.length,
    changes: bundle.changes.length,
    collectionQuality: bundle.collectionQuality.length,
    sources: bundle.quality.sources.length,
  };
  return Object.fromEntries((Object.keys(trackers) as BoundKey[]).map((key) => {
    const item = trackers[key];
    return [key, {
      input: item.input,
      scanned: item.scanned,
      included: included[key],
      omitted: Math.max(0, item.candidate - included[key]) + Math.max(0, item.input - item.scanned),
      truncated: item.scanTruncated || item.limitTruncated || item.candidate > included[key],
    }];
  })) as SystemContextBundle['quality']['bounds'];
}

function domainQuality(
  expectedDomains: SystemContextDomain[],
  sources: SystemContextSourceStatus[],
  reasons: SystemContextQualityReason[],
): SystemContextBundle['quality']['domains'] {
  return expectedDomains.map((domain) => {
    const statuses = sources.filter((item) => item.domain === domain);
    if (!statuses.length) {
      addReason(reasons, { code: 'source_status_missing', domain });
      return { domain, state: 'missing' as const, sourceIds: [] };
    }
    for (const item of statuses) {
      if (item.state === 'partial' || item.truncated) addReason(reasons, { code: 'source_partial', domain, sourceId: item.sourceId });
      if (item.state === 'unavailable') addReason(reasons, { code: 'source_unavailable', domain, sourceId: item.sourceId });
      if (item.freshness.state !== 'fresh') addReason(reasons, { code: 'source_stale', domain, sourceId: item.sourceId });
    }
    const required = statuses.filter((item) => item.required);
    const relevant = required.length ? required : statuses;
    const unavailable = relevant.every((item) => item.state === 'unavailable');
    const partial = relevant.some((item) => item.state !== 'complete' || item.truncated || item.freshness.state !== 'fresh') ||
      reasons.some((reason) => reason.domain === domain && !['raw_kernel_detail_aggregated', 'raw_kernel_detail_sampled'].includes(reason.code));
    return {
      domain,
      state: unavailable ? 'missing' : partial ? 'partial' : 'complete',
      sourceIds: statuses.map((item) => item.sourceId),
    };
  });
}

function contextConfidence(bundle: SystemContextBundle): number {
  const scores = [
    bundle.focus.evidence.association.confidence,
    ...bundle.toolEvidence.map((item) => item.evidence.association.confidence),
    ...bundle.toolEvidence.flatMap((item) => item.kernelEvidence.map((kernel) => Math.min(kernel.confidence, kernel.evidence.association.confidence))),
    ...bundle.relatedResources.map((item) => item.evidence.association.confidence),
    ...bundle.dependencies.map((item) => item.evidence.association.confidence),
    ...bundle.metrics.map((item) => item.evidence.association.confidence),
    ...bundle.alerts.map((item) => item.evidence.association.confidence),
    ...bundle.changes.map((item) => item.evidence.association.confidence),
    ...bundle.collectionQuality.map((item) => item.evidence.association.confidence),
  ];
  return Number((scores.reduce((sum, score) => sum + score, 0) / Math.max(1, scores.length)).toFixed(4));
}

function discardSourceReasons(bundle: SystemContextBundle, sourceId: string): void {
  bundle.quality.reasons = bundle.quality.reasons.filter((reason) => reason.sourceId !== sourceId);
}

function dropLowestPriority(bundle: SystemContextBundle): boolean {
  if (bundle.metrics.length > 0) return Boolean(bundle.metrics.pop());
  if (bundle.changes.length > 0) return Boolean(bundle.changes.pop());
  if (bundle.alerts.length > 0) return Boolean(bundle.alerts.pop());
  if (bundle.dependencies.length > 0) return Boolean(bundle.dependencies.pop());

  if (bundle.relatedResources.length > 1) {
    const removed = bundle.relatedResources.pop();
    if (!removed) return false;
    // Dependencies have already been shed at this priority, but Tool references can otherwise
    // become dangling when the byte budget removes a resource.
    for (const tool of bundle.toolEvidence) {
      tool.relatedResourceIds = tool.relatedResourceIds.filter((id) => id !== removed.resourceId);
    }
    return true;
  }

  // A single ToolCall can legally contain hundreds of bounded kernel facts and exceed the entire
  // bundle budget on its own. Trim evidence within the ToolCall before discarding its semantic
  // span; keeping the previous "at least one Tool" rule made maxBytes advisory rather than hard.
  for (let index = bundle.toolEvidence.length - 1; index >= 0; index -= 1) {
    if (bundle.toolEvidence[index].kernelEvidence.length > 0) {
      bundle.toolEvidence[index].kernelEvidence.pop();
      return true;
    }
  }
  if (bundle.toolEvidence.length > 1) return Boolean(bundle.toolEvidence.pop());

  for (let index = bundle.toolEvidence.length - 1; index >= 0; index -= 1) {
    if (bundle.toolEvidence[index].adapterEventIds.length > 0) {
      bundle.toolEvidence[index].adapterEventIds.pop();
      return true;
    }
    if (bundle.toolEvidence[index].relatedResourceIds.length > 0) {
      bundle.toolEvidence[index].relatedResourceIds.pop();
      return true;
    }
  }

  if (bundle.collectionQuality.length > 1) {
    const removed = bundle.collectionQuality.pop();
    if (!removed) return false;
    discardSourceReasons(bundle, removed.collectorId);
    return true;
  }
  if (bundle.quality.sources.length > 1) {
    const removed = bundle.quality.sources.pop();
    if (!removed) return false;
    discardSourceReasons(bundle, removed.sourceId);
    return true;
  }

  // Absolute-budget fallbacks. The focus identity and its provenance remain mandatory; every
  // optional collection can be removed and is reflected by bounds/domain quality after recompute.
  if (bundle.toolEvidence.length > 0) return Boolean(bundle.toolEvidence.pop());
  if (bundle.collectionQuality.length > 0) {
    const removed = bundle.collectionQuality.pop();
    if (!removed) return false;
    discardSourceReasons(bundle, removed.collectorId);
    return true;
  }
  if (bundle.relatedResources.length > 0) return Boolean(bundle.relatedResources.pop());
  if (bundle.quality.sources.length > 0) {
    const removed = bundle.quality.sources.pop();
    if (!removed) return false;
    discardSourceReasons(bundle, removed.sourceId);
    return true;
  }
  return false;
}
