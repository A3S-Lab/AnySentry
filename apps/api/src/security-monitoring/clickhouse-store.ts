// ClickHouse persistence for judged events. The dashboard serves reads from an in-memory hot ring;
// this store adds a bounded in-memory write queue, retry-safe batch tokens, server-side deduplication
// for ambiguous outcomes, and graceful shutdown drain. Persisted rows hydrate the ring on boot so
// ordinary restarts and rollouts preserve date windows.
//
// This queue is not a WAL/outbox: a process or host failure can still lose rows that had not reached
// ClickHouse. Crash-durable delivery would require a persistent WAL/outbox and upstream replay.
//
// Connection comes from env (CLICKHOUSE_URL/USER/PASSWORD/DB). If ClickHouse is unreachable the store
// degrades to in-memory-only (the dashboard keeps working; just no persistence) rather than crashing.

import { ClickHouseClient, createClient, type ClickHouseSettings } from '@clickhouse/client';
import { createHash, randomUUID } from 'node:crypto';
import { agentIdentityKeyForEvent, agentRuntimeInstanceIdForEvent, hasDirectAgentRootEvidence } from './agent-identity';
import { foldLatestEventRevisions } from './event-revision';
import {
  BucketCommitCursor,
  compareEventCommitCursor,
  PersistedDashboardBucket,
  validPersistedDashboardBuckets,
} from './persisted-dashboard-bucket';
import { PolicyConfig } from './policy-config';
import { AgentAttribution, AgentMetadataRecord, AlertRecord, AuditRecord, CollectorHeartbeatRecord, IdentityAiReviewRecord, Incident, IngestionSourceRecord, JudgedEvent, MaintenanceWindowRecord, NotificationDeliveryRecord, NotificationState, ObjectiveRecord, ProcessContext, RemediationRecord } from './types';

function boundedPositiveInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = Number(raw);
  return Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.trunc(value)))
    : fallback;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const TABLE = 'events';
// `at` is raw epoch-ms (matches the aggregator); `ts` is a derived DateTime only for TTL/partitioning.
const DDL = (table: string) => `CREATE TABLE IF NOT EXISTS ${table} (
  schemaVersion LowCardinality(String),
  eventId String,
  sourceEventId String DEFAULT '',
  at UInt64,
  ingestedAt UInt64 DEFAULT at,
  eventKind LowCardinality(String),
  eventCategory LowCardinality(String),
  source LowCardinality(String),
  subject String,
  workspacePath String,
  agentId LowCardinality(String),
  collectorId String,
  sourceId String,
  sessionId String,
  userId String,
  traceId String,
  spanId String,
  parentSpanId String,
  runId String,
  taskId String,
  decisionStatus LowCardinality(String) DEFAULT 'succeeded',
  evaluationId String DEFAULT '',
  policyVersion String DEFAULT '',
  decisionRevision UInt32 DEFAULT 1,
  decisionUpdatedAt UInt64 DEFAULT at,
  verdict LowCardinality(String),
  tier LowCardinality(String),
  severity LowCardinality(String),
  reason String,
  actionKind String,
  actionTarget String,
  riskCategory LowCardinality(String),
  riskName String,
  riskType LowCardinality(String),
  riskScore Float64,
  tokenCount UInt64,
  latencyMs Float64,
  attributes String,
  process String DEFAULT '{}',
  attribution String DEFAULT '{}',
  agentIdentityKey String DEFAULT '',
  agentInstanceKey String DEFAULT '',
  agentMonitored UInt8 DEFAULT 0,
  agentHasPhysicalIdentity UInt8 DEFAULT 0,
  agentHasRootIdentity UInt8 DEFAULT 0,
  judgment String DEFAULT '{}',
  rawPreview String,
  ts DateTime MATERIALIZED toDateTime(intDiv(at, 1000))
) ENGINE = MergeTree
ORDER BY at
TTL ts + INTERVAL 90 DAY
SETTINGS non_replicated_deduplication_window = 1000`;

const EVENT_DEDUPLICATION_WINDOW = 1_000;
const EVENT_WRITE_BATCH_ROWS = 500;
const EVENT_WRITE_BATCH_BYTES = 4 * 1024 * 1024;
// The API pod has a 512 MiB cgroup limit and already retains a wide 10k-event hot ring. Bound the
// asynchronous ClickHouse payload separately by both rows and serialized bytes; JavaScript object
// overhead is intentionally not claimed as an exact heap measurement.
const EVENT_WRITE_MAX_BUFFERED_ROWS = 5_000;
const EVENT_WRITE_MAX_BUFFERED_BYTES = 32 * 1024 * 1024;
const EVENT_WRITE_RETRY_DEADLINE_MS = 15_000;
const EVENT_WRITE_ATTEMPT_TIMEOUT_MS = 5_000;
const EVENT_WRITE_RETRY_COOLDOWN_MS = 2_000;
const EVENT_WRITE_CLOSE_DEADLINE_MS = 20_000;
const EVENT_WRITE_BACKOFF_BASE_MS = 250;
const EVENT_WRITE_BACKOFF_MAX_MS = 2_000;

const EVENT_ALTERS = [
  'ADD COLUMN IF NOT EXISTS schemaVersion LowCardinality(String) DEFAULT \'anysentry.agent_event.v1\'',
  'ADD COLUMN IF NOT EXISTS eventId String DEFAULT \'\'',
  'ADD COLUMN IF NOT EXISTS sourceEventId String DEFAULT \'\'',
  'ADD COLUMN IF NOT EXISTS ingestedAt UInt64 DEFAULT at',
  'ADD COLUMN IF NOT EXISTS eventCategory LowCardinality(String) DEFAULT \'unknown\'',
  'ADD COLUMN IF NOT EXISTS source LowCardinality(String) DEFAULT \'observer\'',
  'ADD COLUMN IF NOT EXISTS collectorId String DEFAULT \'\'',
  'ADD COLUMN IF NOT EXISTS sourceId String DEFAULT \'\'',
  'ADD COLUMN IF NOT EXISTS traceId String DEFAULT \'\'',
  'ADD COLUMN IF NOT EXISTS spanId String DEFAULT \'\'',
  'ADD COLUMN IF NOT EXISTS parentSpanId String DEFAULT \'\'',
  'ADD COLUMN IF NOT EXISTS runId String DEFAULT \'\'',
  'ADD COLUMN IF NOT EXISTS taskId String DEFAULT \'\'',
  "ADD COLUMN IF NOT EXISTS decisionStatus LowCardinality(String) DEFAULT 'succeeded'",
  "ADD COLUMN IF NOT EXISTS evaluationId String DEFAULT ''",
  "ADD COLUMN IF NOT EXISTS policyVersion String DEFAULT ''",
  'ADD COLUMN IF NOT EXISTS decisionRevision UInt32 DEFAULT 1',
  'ADD COLUMN IF NOT EXISTS decisionUpdatedAt UInt64 DEFAULT at',
  'ADD COLUMN IF NOT EXISTS attributes String DEFAULT \'{}\'',
  'ADD COLUMN IF NOT EXISTS process String DEFAULT \'{}\'',
  'ADD COLUMN IF NOT EXISTS attribution String DEFAULT \'{}\'',
  `ADD COLUMN IF NOT EXISTS agentIdentityKey String DEFAULT multiIf(
    JSONExtractString(attribution, 'physicalWorkloadId') != '', JSONExtractString(attribution, 'physicalWorkloadId'),
    JSONExtractString(attribution, 'agentInstanceId') != '', JSONExtractString(attribution, 'agentInstanceId'),
    JSONExtractString(attribution, 'workloadRef', 'podUid') != '', concat(
      'k8s:',
      JSONExtractString(attribution, 'workloadRef', 'podUid'),
      ':',
      if(
        JSONExtractString(attribution, 'workloadRef', 'containerName') != '',
        JSONExtractString(attribution, 'workloadRef', 'containerName'),
        if(JSONExtractString(attribution, 'workloadRef', 'name') != '', JSONExtractString(attribution, 'workloadRef', 'name'), 'container')
      )
    ),
    JSONExtractUInt(attribution, 'rootPid') > 0, concat(
      'host-root:',
      if(JSONExtractString(process, 'hostId') != '', JSONExtractString(process, 'hostId'), 'host'),
      ':',
      if(JSONExtractString(process, 'bootId') != '', JSONExtractString(process, 'bootId'), 'boot'),
      ':',
      toString(JSONExtractUInt(attribution, 'rootPid')),
      ':',
      if(JSONExtractString(attribution, 'rootStartTime') != '', JSONExtractString(attribution, 'rootStartTime'), 'start-unknown')
    ),
    concat(
      'logical:',
      workspacePath,
      ':',
      if(
        JSONExtractString(attribution, 'agentScopeId') != '',
        JSONExtractString(attribution, 'agentScopeId'),
        if(JSONExtractString(attribution, 'agentDisplayName') != '', JSONExtractString(attribution, 'agentDisplayName'), agentId)
      )
    )
  )`,
  `ADD COLUMN IF NOT EXISTS agentInstanceKey String DEFAULT multiIf(
    JSONExtractString(attribution, 'agentInstanceId') != '', JSONExtractString(attribution, 'agentInstanceId'),
    JSONExtractString(attribution, 'physicalWorkloadId') != '', JSONExtractString(attribution, 'physicalWorkloadId'),
    JSONExtractUInt(attribution, 'rootPid') > 0, concat(
      if(JSONExtractString(process, 'hostId') != '', JSONExtractString(process, 'hostId'), 'host'),
      ':',
      if(JSONExtractString(process, 'bootId') != '', JSONExtractString(process, 'bootId'), 'boot'),
      ':',
      toString(JSONExtractUInt(attribution, 'rootPid'))
    ),
    concat(sessionId, ':', agentId)
  )`,
  "ADD COLUMN IF NOT EXISTS agentMonitored UInt8 DEFAULT toUInt8(JSONExtractBool(attribution, 'monitored'))",
  `ADD COLUMN IF NOT EXISTS agentHasPhysicalIdentity UInt8 DEFAULT toUInt8(
    JSONExtractString(attribution, 'physicalWorkloadId') != ''
    OR JSONExtractString(attribution, 'agentInstanceId') != ''
    OR JSONExtractString(attribution, 'workloadRef', 'podUid') != ''
  )`,
  `ADD COLUMN IF NOT EXISTS agentHasRootIdentity UInt8 DEFAULT toUInt8(
    JSONExtractUInt(attribution, 'rootPid') > 0
    AND JSONExtractString(attribution, 'rootStartTime') != ''
  )`,
  'ADD COLUMN IF NOT EXISTS judgment String DEFAULT \'{}\'',
  'ADD COLUMN IF NOT EXISTS rawPreview String DEFAULT \'\'',
];

const COLLECTOR_HEARTBEAT_TABLE = 'collector_heartbeats';
const COLLECTOR_HEARTBEAT_DDL = `CREATE TABLE IF NOT EXISTS ${COLLECTOR_HEARTBEAT_TABLE} (
  collectorId String,
  at UInt64,
  payload String,
  ts DateTime MATERIALIZED toDateTime(intDiv(at, 1000))
) ENGINE = MergeTree
ORDER BY (collectorId, at)
TTL ts + INTERVAL 90 DAY`;

// Singleton policy config (the config panels' persistence). ReplacingMergeTree keeps only the latest
// row per key; `FINAL` collapses to it on read.
const CONFIG_TABLE = 'config';
const CONFIG_DDL = `CREATE TABLE IF NOT EXISTS ${CONFIG_TABLE} (
  key String,
  value String,
  updated_at UInt64
) ENGINE = ReplacingMergeTree(updated_at)
ORDER BY key`;

const NOTIFICATION_DELIVERY_TABLE = 'notification_delivery_facts';
const NOTIFICATION_DELIVERY_DDL = `CREATE TABLE IF NOT EXISTS ${NOTIFICATION_DELIVERY_TABLE} (
  deliveryId String,
  sentAt UInt64,
  ingestedAt UInt64,
  payload String,
  ts DateTime MATERIALIZED toDateTime(intDiv(sentAt, 1000))
) ENGINE = MergeTree
ORDER BY (deliveryId, sentAt, ingestedAt)
TTL ts + INTERVAL 365 DAY`;

const IDENTITY_AI_REVIEW_TABLE = 'identity_ai_review_revisions';
const IDENTITY_AI_REVIEW_DDL = `CREATE TABLE IF NOT EXISTS ${IDENTITY_AI_REVIEW_TABLE} (
  reviewId String,
  revision UInt32,
  status LowCardinality(String),
  createdAt UInt64,
  updatedAt UInt64,
  ingestedAt UInt64,
  payload String,
  ts DateTime MATERIALIZED toDateTime(intDiv(createdAt, 1000))
) ENGINE = MergeTree
ORDER BY (reviewId, revision, ingestedAt)
TTL ts + INTERVAL 365 DAY`;

const AUDIT_FACT_TABLE = 'audit_facts';
const AUDIT_FACT_DDL = `CREATE TABLE IF NOT EXISTS ${AUDIT_FACT_TABLE} (
  auditId String,
  at UInt64,
  ingestedAt UInt64,
  payload String,
  ts DateTime MATERIALIZED toDateTime(intDiv(at, 1000))
) ENGINE = MergeTree
ORDER BY (auditId, at, ingestedAt)
TTL ts + INTERVAL 365 DAY`;

// The journal observes inserts from every judge process, so cache invalidation is not limited to
// this API process's local write queue.
const EVENT_COMMIT_FACT_TABLE = 'event_commit_facts';
const EVENT_COMMIT_FACT_DDL = `CREATE TABLE IF NOT EXISTS ${EVENT_COMMIT_FACT_TABLE} (
  eventId String,
  decisionRevision UInt32,
  eventAt UInt64,
  committedAt UInt64,
  sourceId String,
  collectorId String,
  ts DateTime MATERIALIZED toDateTime(intDiv(committedAt, 1000))
) ENGINE = MergeTree
ORDER BY (committedAt, eventId, decisionRevision)
TTL ts + INTERVAL 7 DAY`;
const EVENT_COMMIT_FACT_MV = 'event_commit_facts_mv';
const EVENT_COMMIT_FACT_MV_DDL = `CREATE MATERIALIZED VIEW IF NOT EXISTS ${EVENT_COMMIT_FACT_MV}
TO ${EVENT_COMMIT_FACT_TABLE}
AS SELECT
  eventId,
  decisionRevision,
  at AS eventAt,
  ingestedAt AS committedAt,
  sourceId,
  collectorId
FROM ${TABLE}`;

// These are complete, commit-cursor-qualified bucket snapshots. Revisions replace the complete
// snapshot rather than incrementing a counter, which keeps late judgment updates exact.
const DASHBOARD_BUCKET_SNAPSHOT_TABLE = 'dashboard_bucket_snapshots';
const DASHBOARD_BUCKET_SNAPSHOT_DDL = `CREATE TABLE IF NOT EXISTS ${DASHBOARD_BUCKET_SNAPSHOT_TABLE} (
  bucketStart UInt64,
  bucketMs UInt32,
  snapshotCommittedAt UInt64,
  snapshotEventId String,
  snapshotDecisionRevision UInt32,
  snapshotVersion UInt64,
  factsJson String,
  computedAt UInt64,
  ts DateTime MATERIALIZED toDateTime(intDiv(computedAt, 1000))
) ENGINE = MergeTree
ORDER BY (
  bucketMs,
  bucketStart,
  snapshotCommittedAt,
  snapshotEventId,
  snapshotDecisionRevision,
  snapshotVersion
)
TTL ts + INTERVAL 14 DAY`;

// Dashboard reads must coexist with sustained Observer writes inside the bundled 2 GiB
// ClickHouse budget. Large window aggregations spill early and use at most two read threads;
// otherwise several dashboard panels can collectively consume the server budget and evict one
// another before any result is returned.
const BOUNDED_DASHBOARD_READ_SETTINGS: ClickHouseSettings = {
  max_threads: 2,
  max_memory_usage: String(384 * 1024 * 1024),
  max_bytes_before_external_group_by: String(64 * 1024 * 1024),
  max_bytes_before_external_sort: String(64 * 1024 * 1024),
  min_bytes_to_use_direct_io: String(1024 * 1024),
  max_execution_time: 25,
};

// Session/workspace queries materialize wider per-event state. Small blocks keep each below its
// query budget; running only these two one-thread reads together keeps the cold dashboard under
// the browser deadline without restoring the previous four-query fan-out.
const BOUNDED_DASHBOARD_DETAIL_READ_SETTINGS: ClickHouseSettings = {
  ...BOUNDED_DASHBOARD_READ_SETTINGS,
  max_threads: 1,
  max_block_size: '1024',
  preferred_block_size_bytes: String(1024 * 1024),
};

// Hydration reads wide rows rather than compact aggregates. A single read thread and small blocks
// keep both ClickHouse and the API startup peak bounded, while a separate 640 MiB query budget
// leaves measured headroom above the roughly 341 MiB production query peak.
const BOUNDED_HYDRATE_READ_SETTINGS: ClickHouseSettings = {
  ...BOUNDED_DASHBOARD_DETAIL_READ_SETTINGS,
  max_memory_usage: String(640 * 1024 * 1024),
};

// Recent event reads also materialize wide rows. Moving-window production samples exceeded the
// shared 384 MiB budget by up to 2.5 MiB, so only this path gets a measured 448 MiB ceiling while
// retaining one thread and small blocks.
const BOUNDED_RECENT_READ_SETTINGS: ClickHouseSettings = {
  ...BOUNDED_DASHBOARD_DETAIL_READ_SETTINGS,
  max_memory_usage: String(448 * 1024 * 1024),
};

// Durable searches manually late-materialize wide rows: the candidate sort carries only row
// locators and judgment keys, then the outer PREWHERE fetches the selected physical revisions.
// A 512 MiB ceiling bounds the locator set and at most 10k final JSON rows without restoring the
// former 640 MiB SELECT-* sort budget.
const BOUNDED_EVENT_SEARCH_READ_SETTINGS: ClickHouseSettings = {
  ...BOUNDED_DASHBOARD_DETAIL_READ_SETTINGS,
  max_memory_usage: String(512 * 1024 * 1024),
};

const MAX_DURABLE_EVENT_SEARCH_ROWS = 10_000;

type Row = Omit<JudgedEvent, 'actionKind' | 'actionTarget' | 'attributes' | 'process' | 'attribution' | 'judgment' | 'collectorId' | 'sourceId' | 'parentSpanId' | 'taskId' | 'rawPreview'> & {
  ingestedAt: number;
  actionKind: string;
  actionTarget: string;
  attributes: string;
  process: string;
  attribution: string;
  agentIdentityKey: string;
  agentInstanceKey: string;
  agentMonitored: number;
  agentHasPhysicalIdentity: number;
  agentHasRootIdentity: number;
  judgment: string;
  collectorId: string;
  sourceId: string;
  parentSpanId: string;
  taskId: string;
  rawPreview: string;
};

interface QueuedEventRow {
  row: Row;
  bytes: number;
}

interface EventWriteWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
}

interface EventWriteBatch {
  rows: Row[];
  bytes: number;
  token: string;
  settings: ClickHouseSettings;
  source: 'buffered' | 'direct';
  waiters: EventWriteWaiter[];
  retryNotBefore: number;
  createdAt: number;
  lastError?: Error;
}

interface EventWriteErrorDecision {
  retryable: boolean;
  ambiguous: boolean;
  code: string;
}
export type IncidentState = Pick<Incident, 'incidentId' | 'status' | 'owner' | 'note' | 'acknowledgedAt' | 'resolvedAt' | 'updatedAt'>;
export interface StoredEventQuery {
  sinceMs: number;
  untilMs: number;
  monitoredOnly?: boolean;
  eventId?: string;
  sourceId?: string;
  collectorId?: string;
  agentId?: string;
  /** Stable concrete runtime identity. Unlike display agentId, this is safe to push down. */
  agentInstanceId?: string;
  sessionId?: string;
  workspacePath?: string;
  traceId?: string;
  runId?: string;
  eventKind?: string;
  eventCategory?: string;
  verdict?: string;
  tier?: string;
  limit: number;
}
export interface StoredEventSearchResult {
  events: JudgedEvent[];
  hasMore: boolean;
  committedCutoffMs?: number;
  /** The durable query failed; callers must not interpret the empty page as an exact zero. */
  unavailable?: boolean;
}

export interface CommittedSourceProgress {
  sourceId?: string;
  collectorId?: string;
  committedEventTimeMs: number;
  committedAtMs: number;
}

export interface EventCommitCursor {
  committedAtMs: number;
  eventId: string;
  decisionRevision: number;
}

export interface EventCommitChange {
  cursor: EventCommitCursor;
  eventAtMs: number;
  sourceId?: string;
  collectorId?: string;
}

export interface EventCommitChanges {
  changes: EventCommitChange[];
  cursor?: EventCommitCursor;
  hasMore: boolean;
}

export interface DashboardAggregateBucketFact {
  bucketStartMs: number;
  monitored: boolean;
  decisionStatus: string;
  verdict: string;
  tier: string;
  riskType: string;
  riskCategory: string;
  riskName: string;
  severityRank: number;
  sessionKey: string;
  userId: string;
  workspacePath: string;
  eventCount: number;
  blockedCount: number;
  escalatedCount: number;
  l2Count: number;
  l3Count: number;
  riskActivationCount: number;
  riskyEventCount: number;
  tokenCount: number;
  latencyTotal: number;
  riskScoreTotal: number;
  lastEventAt: number;
  commandDangerCount: number;
  promptInjectionCount: number;
  dataLeakCount: number;
  communicationRiskCount: number;
  systemicRiskCount: number;
}

export interface StoredAgentWindowFact {
  identityKey: string;
  representativeEvent: JudgedEvent;
  firstSeenAt: number;
  lastSeenAt: number;
  eventCount: number;
  riskyEventCount: number;
  sessionCount: number;
  runCount: number;
  traceCount: number;
  sessionKeys: string[];
  runKeys: string[];
  traceKeys: string[];
  collectorKeys: string[];
  eventsWithoutCollector: number;
  tokenCount: number;
  latencyTotal: number;
  instanceCount: number;
  instanceKeys: string[];
  worstSeverityRank: number;
  topRiskAt?: number;
  topRiskCategory?: string;
  topRiskName?: string;
  eventCategoryCounts: Record<string, number>;
  sourceCounts: Record<string, number>;
  hasPhysicalIdentity: boolean;
  hasRootIdentity: boolean;
}

export interface StoredAgentBucketFact extends StoredAgentWindowFact {
  bucketStartMs: number;
}

export interface StoredAgentMetricBucketFact {
  bucketIndex: number;
  identityKey: string;
  representativeEvent: JudgedEvent;
  eventCount: number;
  riskyEventCount: number;
  blockedCount: number;
  escalatedCount: number;
  toolCount: number;
  fileCount: number;
  networkCount: number;
  processCount: number;
  llmCount: number;
  l1Count: number;
  l2Count: number;
  l3Count: number;
  failedCount: number;
  timeoutCount: number;
  tokenCount: number;
  latencyTotal: number;
  maxRiskScore: number;
  sessionKeys: string[];
  recentEventCount: number;
  recentCommCount: number;
  recentSessionKeys: string[];
}

export interface StoredWorkspaceWindowFact {
  workspacePath: string;
  representativeEvent: JudgedEvent;
  firstSeenAt: number;
  lastSeenAt: number;
  eventCount: number;
  riskyEventCount: number;
  sessionKeys: string[];
  runKeys: string[];
  traceKeys: string[];
  collectorKeys: string[];
  tokenCount: number;
  latencyTotal: number;
  worstSeverityRank: number;
  topRiskAt?: number;
  topRiskCategory?: string;
  topRiskName?: string;
}

export interface StoredWorkspaceBucketFact extends StoredWorkspaceWindowFact {
  bucketStartMs: number;
}

export interface StoredTopologyWindowFact {
  identityKey: string;
  representativeEvent: JudgedEvent;
  firstSeenAt: number;
  lastSeenAt: number;
  eventCount: number;
  riskyEventCount: number;
  worstSeverityRank: number;
  riskCategory?: string;
  riskName?: string;
}

export interface StoredTopologyBucketFact extends StoredTopologyWindowFact {
  bucketStartMs: number;
}

export interface DashboardWindowDimensionRow {
  period: 'current' | 'previous';
  monitored: boolean;
  verdict: string;
  tier: string;
  riskType: string;
  riskCategory: string;
  riskName: string;
  eventCount: number;
  tokenCount: number;
  latencyTotal: number;
  riskScoreTotal: number;
}

export interface DashboardWindowBucketRow {
  bucketIndex: number;
  monitored: boolean;
  eventCount: number;
  blockedCount: number;
  escalatedCount: number;
  l2Count: number;
  l3Count: number;
  riskActivationCount: number;
  tokenCount: number;
  latencyTotal: number;
  riskScoreTotal: number;
}

export interface DashboardWindowHistory {
  /** Distinct counts use ClickHouse's bounded approximate aggregate to avoid an unbounded hash set. */
  countsApproximate?: true;
  dimensions: DashboardWindowDimensionRow[];
  buckets: DashboardWindowBucketRow[];
  topSession?: {
    sessionId: string;
    userId: string;
    workspacePath: string;
    eventCount: number;
    riskyEventCount: number;
    riskScoreTotal: number;
    lastEventAt: number;
    dimensionCounts: Record<string, number>;
  };
  workspaces: Array<{
    workspacePath: string;
    sessionCount: number;
    totalRiskScore: number;
    worstSeverityRank: number;
  }>;
}

function attrString(attributes: JudgedEvent['attributes'], key: string): string {
  const value = attributes[key];
  return value == null ? '' : String(value).trim();
}

function toRow(e: JudgedEvent): Row {
  const attribution = e.attribution;
  const physical = attribution?.physicalWorkloadId?.trim();
  const instance = attribution?.agentInstanceId?.trim();
  return {
    schemaVersion: e.schemaVersion,
    eventId: e.eventId,
    sourceEventId: e.sourceEventId ?? '',
    at: e.at,
    ingestedAt: Date.now(),
    eventKind: e.eventKind,
    eventCategory: e.eventCategory,
    source: e.source,
    subject: e.subject,
    workspacePath: e.workspacePath,
    agentId: e.agentId,
    collectorId: e.collectorId?.trim() || attrString(e.attributes, 'collectorId'),
    sourceId: e.sourceId?.trim() || attrString(e.attributes, 'sourceId'),
    sessionId: e.sessionId,
    userId: e.userId,
    traceId: e.traceId,
    spanId: e.spanId,
    parentSpanId: e.parentSpanId ?? '',
    runId: e.runId,
    taskId: e.taskId ?? '',
    decisionStatus: e.decisionStatus ?? 'succeeded',
    evaluationId: e.evaluationId ?? '',
    policyVersion: e.policyVersion ?? '',
    decisionRevision: Math.max(1, Math.trunc(e.decisionRevision ?? 1)),
    decisionUpdatedAt: e.decisionUpdatedAt ?? e.at,
    verdict: e.verdict,
    tier: e.tier,
    severity: e.severity,
    reason: e.reason,
    actionKind: e.actionKind ?? '',
    actionTarget: e.actionTarget ?? '',
    riskCategory: e.riskCategory,
    riskName: e.riskName,
    riskType: e.riskType,
    riskScore: e.riskScore,
    tokenCount: e.tokenCount,
    latencyMs: e.latencyMs,
    attributes: JSON.stringify(e.attributes ?? {}),
    process: JSON.stringify(e.process ?? {}),
    attribution: JSON.stringify(attribution ?? {}),
    agentIdentityKey: agentIdentityKeyForEvent(e),
    agentInstanceKey: agentRuntimeInstanceIdForEvent(e),
    agentMonitored: attribution?.monitored === true ? 1 : 0,
    agentHasPhysicalIdentity: physical || instance || attribution?.workloadRef?.podUid ? 1 : 0,
    agentHasRootIdentity: attribution?.rootStartTime && hasDirectAgentRootEvidence(e) ? 1 : 0,
    judgment: JSON.stringify(e.judgment ?? {}),
    rawPreview: e.rawPreview ?? '',
  };
}

function parseObject<T extends object>(value: unknown): T | undefined {
  const text = String(value ?? '').trim();
  if (!text || text === '{}') return undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as T) : undefined;
  } catch {
    return undefined;
  }
}

function fromRow(r: Record<string, unknown>): JudgedEvent {
  const num = (v: unknown) => Number(v) || 0; // ClickHouse returns UInt64 as a string in JSON
  const str = (v: unknown) => String(v ?? '');
  let attributes: JudgedEvent['attributes'] = {};
  try {
    attributes = JSON.parse(str(r.attributes) || '{}') as JudgedEvent['attributes'];
  } catch {
    attributes = {};
  }
  const at = num(r.at);
  const agentId = str(r.agentId);
  const sessionId = str(r.sessionId);
  const eventKind = str(r.eventKind);
  const collectorId = str(r.collectorId) || attrString(attributes, 'collectorId') || undefined;
  const sourceId = str(r.sourceId) || attrString(attributes, 'sourceId') || undefined;
  return {
    schemaVersion: (str(r.schemaVersion) || 'anysentry.agent_event.v1') as JudgedEvent['schemaVersion'],
    eventId: str(r.eventId) || `evt_${at}_${agentId}_${eventKind}`,
    sourceEventId: str(r.sourceEventId) || undefined,
    at,
    eventKind,
    eventCategory: (str(r.eventCategory) || 'unknown') as JudgedEvent['eventCategory'],
    source: (str(r.source) || 'observer') as JudgedEvent['source'],
    subject: str(r.subject),
    workspacePath: str(r.workspacePath),
    agentId,
    collectorId,
    sourceId,
    sessionId,
    userId: str(r.userId),
    traceId: str(r.traceId) || `tr_${agentId}_${sessionId}`,
    spanId: str(r.spanId) || `sp_${at}_${eventKind}`,
    parentSpanId: str(r.parentSpanId) || undefined,
    runId: str(r.runId) || sessionId,
    taskId: str(r.taskId) || undefined,
    decisionStatus: (str(r.decisionStatus) || 'succeeded') as JudgedEvent['decisionStatus'],
    evaluationId: str(r.evaluationId) || undefined,
    policyVersion: str(r.policyVersion) || undefined,
    decisionRevision: Math.max(1, num(r.decisionRevision) || 1),
    decisionUpdatedAt: num(r.decisionUpdatedAt) || at,
    verdict: r.verdict as JudgedEvent['verdict'],
    tier: r.tier as JudgedEvent['tier'],
    severity: r.severity as JudgedEvent['severity'],
    reason: str(r.reason),
    actionKind: (r.actionKind as string) || undefined,
    actionTarget: (r.actionTarget as string) || undefined,
    riskCategory: str(r.riskCategory),
    riskName: str(r.riskName),
    riskType: r.riskType as JudgedEvent['riskType'],
    riskScore: num(r.riskScore),
    tokenCount: num(r.tokenCount),
    latencyMs: num(r.latencyMs),
    attributes,
    process: parseObject<ProcessContext>(r.process),
    attribution: parseObject<AgentAttribution>(r.attribution),
    judgment: parseObject<NonNullable<JudgedEvent['judgment']>>(r.judgment),
    rawPreview: str(r.rawPreview) || undefined,
  };
}

export class ClickHouseStore {
  private client?: ClickHouseClient;
  private buf: QueuedEventRow[] = [];
  private collectorHeartbeatBuf: Array<{ collectorId: string; at: number; payload: string }> = [];
  private bufferedEventBytes = 0;
  // Includes unsealed rows plus sealed/active batches. Keeping the active batch in these totals
  // prevents a slow HTTP request from becoming hidden memory outside the advertised buffer bound.
  private eventWriteRows = 0;
  private eventWriteBytes = 0;
  private eventWriteBatches: EventWriteBatch[] = [];
  private eventWriteBatchesByToken = new Map<string, EventWriteBatch>();
  private eventWriteDrainInFlight?: Promise<void>;
  private eventWriteRetryWakeTimer?: NodeJS.Timeout;
  private eventWriteRetrySleep?: { timer: NodeJS.Timeout; wake: () => void };
  private eventWriteAbortController?: AbortController;
  private eventWritePermanentError?: Error;
  private eventWriteClosingDeadline?: number;
  private closeInFlight?: Promise<void>;
  private closing = false;
  private flushTimer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private connectInFlight?: Promise<boolean>;
  private flushInFlight?: Promise<void>;
  private immediateWritesInFlight = 0;
  private ready = false;
  private closed = false;
  private committedThroughMs?: number;
  private readonly committedSourceProgress = new Map<string, CommittedSourceProgress>();
  private earliestCommitCursorCache?: {
    expiresAt: number;
    value: Promise<EventCommitCursor | null>;
  };
  private dashboardSnapshotSequence = 0;
  private readonly dashboardSnapshotStats = {
    hits: 0,
    misses: 0,
    invalidated: 0,
    exactRanges: 0,
    writtenBuckets: 0,
    fallbackErrors: 0,
  };

  // Instance fields make the retry clock/delays replaceable by the standalone deterministic
  // verifier without exposing a production API or relying on Node-version-specific fake timers.
  private eventWriteNow = (): number => Date.now();
  private eventWriteRetryDeadlineMs = EVENT_WRITE_RETRY_DEADLINE_MS;
  private eventWriteAttemptTimeoutMs = EVENT_WRITE_ATTEMPT_TIMEOUT_MS;
  private eventWriteCloseDeadlineMs = EVENT_WRITE_CLOSE_DEADLINE_MS;
  private eventWriteRetryDelayMs = (failedAttempt: number): number => {
    const exponential = Math.min(
      EVENT_WRITE_BACKOFF_MAX_MS,
      EVENT_WRITE_BACKOFF_BASE_MS * (2 ** Math.max(0, failedAttempt - 1)),
    );
    return Math.max(1, Math.round(exponential * (0.8 + Math.random() * 0.4)));
  };
  // All three dashboard paths below read or aggregate wide event rows. Keep one shared slot so a
  // durable search cannot overlap a recent/history read and collectively exceed the 2 GiB server
  // budget. Equivalent recent/durable requests still coalesce through their per-path in-flight
  // promise before attempting to acquire this slot.
  private wideEventReadActive = false;
  // Share one equivalent wide read, but fail a different window closed to the hot-ring fallback.
  // This is an in-flight guard only: completed results are never cached here.
  private recentQueryInFlight?: {
    key: string;
    value: Promise<JudgedEvent[] | null>;
  };
  // Durable event searches materialize the same wide rows as the recent dashboard read. Share an
  // equivalent request and fail a different one closed to the hot-ring fallback so concurrent API
  // callers cannot multiply the per-query memory budget.
  private eventSearchInFlight?: {
    key: string;
    value: Promise<JudgedEvent[] | null>;
  };

  private tryAcquireWideEventReadSlot(): (() => void) | null {
    if (this.wideEventReadActive) return null;
    this.wideEventReadActive = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.wideEventReadActive = false;
    };
  }

  get enabled(): boolean {
    return this.ready && !this.closing && !this.eventWritePermanentError;
  }

  dashboardBucketSnapshotStatus() {
    return {
      schemaVersion: 'anysentry.dashboard-bucket-snapshots.v1' as const,
      enabled: process.env.ANYSENTRY_PERSISTED_DASHBOARD_BUCKETS !== 'off',
      ...this.dashboardSnapshotStats,
    };
  }

  /**
   * Connect and ensure the database/table exist.
   *
   * ClickHouse can become healthy a few seconds after the API container starts (for example during
   * a full Compose restart). A single failed attempt used to leave this store in memory-only mode
   * until the API was manually restarted. Keep startup retries bounded so boot cannot hang forever,
   * then continue a low-frequency reconnect loop in the background.
   */
  async init(): Promise<boolean> {
    const url = process.env.CLICKHOUSE_URL;
    if (!url) return false;
    this.closed = false;
    const attempts = boundedPositiveInt(
      process.env.ANYSENTRY_CLICKHOUSE_INIT_ATTEMPTS,
      15,
      1,
      60,
    );
    const retryMs = boundedPositiveInt(
      process.env.ANYSENTRY_CLICKHOUSE_INIT_RETRY_MS,
      2_000,
      250,
      30_000,
    );
    let errorMessage = 'unknown error';
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const result = await this.connect();
      if (result.ok) return true;
      errorMessage = result.error;
      if (attempt < attempts) {
        console.warn(
          `[clickhouse] init attempt ${attempt}/${attempts} failed; retrying in ${retryMs}ms: ${errorMessage}`,
        );
        await delay(retryMs);
      }
    }
    console.error(
      `[clickhouse] init failed after ${attempts} attempts — running in-memory until reconnect: ${errorMessage}`,
    );
    this.scheduleReconnect();
    return false;
  }

  private connect(): Promise<{ ok: boolean; error: string }> {
    if (this.ready) return Promise.resolve({ ok: true, error: '' });
    if (this.connectInFlight) {
      return this.connectInFlight.then((ok) => ({
        ok,
        error: ok ? '' : 'connection attempt failed',
      }));
    }
    const operation = this.connectOnce();
    this.connectInFlight = operation.then((result) => result.ok);
    return operation.finally(() => {
      this.connectInFlight = undefined;
    });
  }

  private async connectOnce(): Promise<{ ok: boolean; error: string }> {
    const url = process.env.CLICKHOUSE_URL;
    if (!url || this.closed) return { ok: false, error: 'ClickHouse is not configured or store is closed' };
    const database = process.env.CLICKHOUSE_DB || 'anysentry';
    const credentials = {
      username: process.env.CLICKHOUSE_USER || 'default',
      password: process.env.CLICKHOUSE_PASSWORD || '',
    };
    let boot: ClickHouseClient | undefined;
    let nextClient: ClickHouseClient | undefined;
    try {
      // Create the database with a bootstrap client (no db bound), then connect to it.
      boot = createClient({ url, ...credentials });
      await boot.command({ query: `CREATE DATABASE IF NOT EXISTS ${database}` });
      await boot.close();
      boot = undefined;
      nextClient = createClient({ url, database, ...credentials });
      await nextClient.command({ query: DDL(TABLE) });
      for (const alter of EVENT_ALTERS) await nextClient.command({ query: `ALTER TABLE ${TABLE} ${alter}` });
      // CREATE IF NOT EXISTS does not update an existing table. Explicitly enable the local
      // MergeTree deduplication log so retrying an ambiguously acknowledged batch with the same
      // token is idempotent on both fresh and upgraded installations.
      await nextClient.command({
        query: `ALTER TABLE ${TABLE} MODIFY SETTING non_replicated_deduplication_window = ${EVENT_DEDUPLICATION_WINDOW}`,
      });
      await nextClient.command({ query: COLLECTOR_HEARTBEAT_DDL });
      await nextClient.command({ query: CONFIG_DDL });
      await nextClient.command({ query: NOTIFICATION_DELIVERY_DDL });
      await nextClient.command({ query: IDENTITY_AI_REVIEW_DDL });
      await nextClient.command({ query: AUDIT_FACT_DDL });
      await nextClient.command({ query: EVENT_COMMIT_FACT_DDL });
      await nextClient.command({ query: EVENT_COMMIT_FACT_MV_DDL });
      await nextClient.command({ query: DASHBOARD_BUCKET_SNAPSHOT_DDL });
      const committed = await nextClient.query({
        query: `
          SELECT
            sourceId,
            collectorId,
            max(at) AS committedThrough,
            max(ingestedAt) AS committedAt
          FROM ${TABLE}
          GROUP BY sourceId, collectorId
        `,
        format: 'JSONEachRow',
      });
      const committedRows = (await committed.json()) as Array<{
        sourceId?: string;
        collectorId?: string;
        committedThrough?: string | number;
        committedAt?: string | number;
      }>;
      this.committedSourceProgress.clear();
      for (const row of committedRows) {
        const committedEventTimeMs = Number(row.committedThrough);
        if (!Number.isFinite(committedEventTimeMs) || committedEventTimeMs <= 0) continue;
        const sourceId = row.sourceId?.trim() || undefined;
        const collectorId = row.collectorId?.trim() || undefined;
        this.committedSourceProgress.set(`${sourceId ?? ''}\0${collectorId ?? ''}`, {
          sourceId,
          collectorId,
          committedEventTimeMs,
          committedAtMs: Number(row.committedAt) || committedEventTimeMs,
        });
      }
      const committedThrough = committedRows.reduce(
        (maximum, row) => Math.max(maximum, Number(row.committedThrough) || 0),
        0,
      );
      this.committedThroughMs = Number.isFinite(committedThrough) && committedThrough > 0
        ? committedThrough
        : undefined;
      await this.client?.close().catch(() => undefined);
      this.client = nextClient;
      nextClient = undefined;
      this.closing = false;
      if (this.flushTimer) clearInterval(this.flushTimer);
      this.flushTimer = setInterval(() => {
        void this.flush().catch(() => undefined);
      }, 2000);
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
      this.ready = true;
      console.info('[clickhouse] connection ready');
      return { ok: true, error: '' };
    } catch (error) {
      this.ready = false;
      await boot?.close().catch(() => undefined);
      await nextClient?.close().catch(() => undefined);
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.ready || this.reconnectTimer || !process.env.CLICKHOUSE_URL) return;
    const reconnectMs = boundedPositiveInt(
      process.env.ANYSENTRY_CLICKHOUSE_RECONNECT_MS,
      15_000,
      1_000,
      300_000,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect().then((result) => {
        if (result.ok) {
          console.info('[clickhouse] background reconnect succeeded');
          return;
        }
        console.warn(`[clickhouse] background reconnect failed; retrying in ${reconnectMs}ms: ${result.error}`);
        this.scheduleReconnect();
      });
    }, reconnectMs);
  }

  /** Buffer one event; flush opportunistically when the batch is large. */
  enqueue(e: JudgedEvent): void {
    if (this.closing) throw new Error('ClickHouse event writer is closing');
    if (!this.ready) return;
    if (this.eventWritePermanentError) throw this.eventWritePermanentError;
    const queued = this.queuedEventRow(toRow(e));
    this.assertEventWriteCapacity(queued.bytes);
    this.buf.push(queued);
    this.bufferedEventBytes += queued.bytes;
    this.eventWriteRows += 1;
    this.eventWriteBytes += queued.bytes;
    const sealed = this.sealBufferedEventBatches(false);
    if (sealed) this.startEventWriteDrain();
  }

  /** Persist one lifecycle revision before acknowledging queue work. */
  async insertNow(e: JudgedEvent): Promise<void> {
    if (!this.client || !this.ready || this.closing) throw new Error('ClickHouse is not ready');
    if (this.eventWritePermanentError) throw this.eventWritePermanentError;
    const queued = this.queuedEventRow(toRow(e));
    const token = this.directEventWriteToken(queued.row);
    const existing = this.eventWriteBatchesByToken.get(token);
    if (existing) {
      const completion = new Promise<void>((resolve, reject) => existing.waiters.push({ resolve, reject }));
      this.startEventWriteDrain();
      return completion;
    }

    this.assertEventWriteCapacity(queued.bytes);
    // Preserve global event-write FIFO: a direct lifecycle revision may not jump over a partial
    // buffered batch that was accepted earlier merely because the two-second timer has not fired.
    this.sealBufferedEventBatches(true);
    const batch = this.createEventWriteBatch([queued], token, 'direct');
    this.eventWriteRows += 1;
    this.eventWriteBytes += queued.bytes;
    this.eventWriteBatches.push(batch);
    this.eventWriteBatchesByToken.set(token, batch);
    const completion = new Promise<void>((resolve, reject) => batch.waiters.push({ resolve, reject }));
    this.startEventWriteDrain();
    return completion;
  }

  async flush(): Promise<void> {
    // Serialize the heartbeat side buffer with event draining. The event queue has its own FIFO
    // retry state, while this outer chain prevents two heartbeat inserts from racing.
    const previous = this.flushInFlight ?? Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(() => this.flushBatch());
    this.flushInFlight = operation;
    try {
      await operation;
    } finally {
      if (this.flushInFlight === operation) this.flushInFlight = undefined;
    }
  }

  private async flushBatch(): Promise<void> {
    const client = this.client;
    if (!client) return;
    this.sealBufferedEventBatches(true);
    if (this.eventWriteBatches.length) await this.ensureEventWriteDrain();

    const heartbeatValues = this.collectorHeartbeatBuf;
    this.collectorHeartbeatBuf = [];
    if (!heartbeatValues.length) return;
    try {
      await client.insert({
        table: COLLECTOR_HEARTBEAT_TABLE,
        values: heartbeatValues,
        format: 'JSONEachRow',
      });
    } catch (error) {
      this.collectorHeartbeatBuf = [...heartbeatValues, ...this.collectorHeartbeatBuf];
      console.error('[clickhouse] collector heartbeat insert failed (batch queued for retry):', (error as Error).message);
    }
  }

  private queuedEventRow(row: Row): QueuedEventRow {
    const bytes = Buffer.byteLength(JSON.stringify(row), 'utf8') + 1;
    if (bytes > EVENT_WRITE_BATCH_BYTES) {
      const error = Object.assign(
        new Error(`ClickHouse event row is ${bytes} bytes, above the ${EVENT_WRITE_BATCH_BYTES}-byte insert bound`),
        { code: 'ANYSENTRY_CLICKHOUSE_EVENT_ROW_TOO_LARGE' },
      );
      console.error('[clickhouse] event write rejected:', {
        code: error.code,
        eventId: row.eventId,
        bytes,
        maxBytes: EVENT_WRITE_BATCH_BYTES,
      });
      throw error;
    }
    return { row, bytes };
  }

  private assertEventWriteCapacity(additionalBytes: number): void {
    if (
      this.eventWriteRows + 1 <= EVENT_WRITE_MAX_BUFFERED_ROWS &&
      this.eventWriteBytes + additionalBytes <= EVENT_WRITE_MAX_BUFFERED_BYTES
    ) return;
    const error = Object.assign(
      new Error('ClickHouse event write buffer is full; retry the ingest request'),
      // Capacity is checked before the row joins any batch or enters an HTTP request. Callers may
      // expose this exact failure as retryable only while they can still prove no earlier stage
      // accepted the event.
      { code: 'ANYSENTRY_CLICKHOUSE_EVENT_BUFFER_FULL', retrySafe: true as const },
    );
    // enqueue() intentionally remains synchronous for the existing judge path. Throwing is the
    // only available backpressure signal; silently dropping here would falsely claim durability.
    console.error('[clickhouse] event write buffer capacity reached:', {
      code: error.code,
      rows: this.eventWriteRows,
      bytes: this.eventWriteBytes,
      maxRows: EVENT_WRITE_MAX_BUFFERED_ROWS,
      maxBytes: EVENT_WRITE_MAX_BUFFERED_BYTES,
    });
    throw error;
  }

  private createEventWriteBatch(
    queued: QueuedEventRow[],
    token: string,
    source: EventWriteBatch['source'],
  ): EventWriteBatch {
    return {
      rows: queued.map(({ row }) => row),
      bytes: queued.reduce((sum, row) => sum + row.bytes, 0),
      token,
      settings: {
        insert_deduplicate: 1,
        insert_deduplication_token: token,
      },
      source,
      waiters: [],
      retryNotBefore: 0,
      createdAt: this.eventWriteNow(),
    };
  }

  /** Seal every eligible buffered chunk, retaining arrival order and a stable retry token. */
  private sealBufferedEventBatches(forceTail: boolean): boolean {
    let sealed = false;
    while (
      this.buf.length > 0 &&
      (forceTail || this.buf.length >= EVENT_WRITE_BATCH_ROWS || this.bufferedEventBytes >= EVENT_WRITE_BATCH_BYTES)
    ) {
      let count = 0;
      let bytes = 0;
      for (const queued of this.buf) {
        if (count >= EVENT_WRITE_BATCH_ROWS) break;
        if (count > 0 && bytes + queued.bytes > EVENT_WRITE_BATCH_BYTES) break;
        count += 1;
        bytes += queued.bytes;
      }
      if (count === 0) break;
      const queued = this.buf.splice(0, count);
      this.bufferedEventBytes = Math.max(0, this.bufferedEventBytes - bytes);
      const token = `events-${randomUUID()}`;
      const batch = this.createEventWriteBatch(queued, token, 'buffered');
      this.eventWriteBatches.push(batch);
      this.eventWriteBatchesByToken.set(token, batch);
      sealed = true;
    }
    return sealed;
  }

  private directEventWriteToken(row: Row): string {
    // `ingestedAt` is assigned for each attempt and must not split two callers persisting the same
    // lifecycle revision into distinct batches. The stable evidence/revision payload defines the
    // idempotency token; ClickHouse still stores the timestamp from the first accepted caller.
    const { ingestedAt: _ingestedAt, ...stableRevision } = row;
    return `event-${createHash('sha256').update(JSON.stringify(stableRevision)).digest('hex')}`;
  }

  private startEventWriteDrain(): void {
    void this.ensureEventWriteDrain().catch(() => undefined);
  }

  private ensureEventWriteDrain(): Promise<void> {
    if (this.eventWriteDrainInFlight) return this.eventWriteDrainInFlight;
    let tracked!: Promise<void>;
    tracked = this.drainEventWrites().finally(() => {
      if (this.eventWriteDrainInFlight !== tracked) return;
      this.eventWriteDrainInFlight = undefined;
      // A direct-write waiter is resolved before the owner promise's finalizer runs. Its caller may
      // enqueue the next lifecycle revision in that continuation and observe this just-completed
      // owner. Re-check after clearing it so the newly queued head cannot remain stranded until the
      // periodic timer. Respect retry cooldowns to avoid a rejected-drain microtask spin.
      const head = this.eventWriteBatches[0];
      const now = this.eventWriteNow();
      const mayRestart = this.closing
        ? this.eventWriteClosingDeadline !== undefined && now < this.eventWriteClosingDeadline
        : Boolean(head && head.retryNotBefore <= now);
      if (
        head &&
        this.client &&
        !this.eventWritePermanentError &&
        mayRestart
      ) this.startEventWriteDrain();
    });
    this.eventWriteDrainInFlight = tracked;
    return tracked;
  }

  private async drainEventWrites(): Promise<void> {
    while (this.eventWriteBatches.length > 0) {
      if (this.eventWritePermanentError) throw this.eventWritePermanentError;
      const batch = this.eventWriteBatches[0];
      const now = this.eventWriteNow();
      if (!this.closing && batch.retryNotBefore > now) {
        this.scheduleEventWriteRetry(batch.retryNotBefore);
        throw batch.lastError ?? new Error('ClickHouse event batch is waiting for its retry cooldown');
      }
      const outcome = await this.insertEventWriteBatch(batch);
      if (outcome.status === 'success') {
        this.committedThroughMs = Math.max(
          this.committedThroughMs ?? 0,
          ...batch.rows.map((row) => Number(row.at) || 0),
        );
        this.noteCommittedRows(batch.rows);
        this.eventWriteBatches.shift();
        this.eventWriteBatchesByToken.delete(batch.token);
        this.eventWriteRows = Math.max(0, this.eventWriteRows - batch.rows.length);
        this.eventWriteBytes = Math.max(0, this.eventWriteBytes - batch.bytes);
        for (const waiter of batch.waiters.splice(0)) waiter.resolve();
        continue;
      }

      batch.lastError = outcome.error;
      if (outcome.status === 'permanent') {
        this.eventWritePermanentError = outcome.error;
        for (const waiter of batch.waiters.splice(0)) waiter.reject(outcome.error);
        console.error('[clickhouse] event insert permanently blocked; batch retained:', {
          token: batch.token,
          rows: batch.rows.length,
          bytes: batch.bytes,
          code: outcome.decision.code,
          ambiguous: outcome.decision.ambiguous,
          message: outcome.error.message,
        });
        throw outcome.error;
      }

      // The active retry cycle is bounded. Keep the exact sealed batch and any direct-write
      // waiters at the head, then retry after a cooldown rather than spinning. Rejecting a waiter
      // here while retaining and later applying the batch would let its caller advance lifecycle
      // work under the false belief that this revision was never persisted.
      batch.retryNotBefore = this.closing ? 0 : this.eventWriteNow() + EVENT_WRITE_RETRY_COOLDOWN_MS;
      if (!this.closing) this.scheduleEventWriteRetry(batch.retryNotBefore);
      console.error('[clickhouse] event insert retry deadline reached; batch retained:', {
        token: batch.token,
        rows: batch.rows.length,
        bytes: batch.bytes,
        code: outcome.decision.code,
        ambiguous: outcome.decision.ambiguous,
        message: outcome.error.message,
      });
      throw outcome.error;
    }
  }

  private async insertEventWriteBatch(batch: EventWriteBatch): Promise<
    | { status: 'success' }
    | { status: 'retry_later'; error: Error; decision: EventWriteErrorDecision }
    | { status: 'permanent'; error: Error; decision: EventWriteErrorDecision }
  > {
    const cycleDeadline = this.eventWriteNow() + this.eventWriteRetryDeadlineMs;
    const activeDeadline = (): number => Math.min(
      cycleDeadline,
      this.eventWriteClosingDeadline ?? Number.POSITIVE_INFINITY,
    );
    let failedAttempts = 0;
    let lastError = new Error('ClickHouse event insert retry deadline reached');
    let lastDecision: EventWriteErrorDecision = { retryable: true, ambiguous: true, code: 'DEADLINE' };

    while (this.eventWriteNow() < activeDeadline()) {
      try {
        await this.insertEventWriteAttempt(batch, activeDeadline());
        return { status: 'success' };
      } catch (error) {
        lastError = this.asEventWriteError(error);
        lastDecision = this.classifyEventWriteError(lastError);
        if (!lastDecision.retryable) {
          return { status: 'permanent', error: lastError, decision: lastDecision };
        }
        failedAttempts += 1;
        const delayMs = this.eventWriteRetryDelayMs(failedAttempts);
        console.error('[clickhouse] event insert retrying:', {
          token: batch.token,
          attempt: failedAttempts,
          delayMs,
          code: lastDecision.code,
          ambiguous: lastDecision.ambiguous,
          message: lastError.message,
        });
        if (this.eventWriteNow() + delayMs >= activeDeadline()) break;
        await this.sleepBeforeEventWriteRetry(delayMs);
      }
    }
    return { status: 'retry_later', error: lastError, decision: lastDecision };
  }

  private async insertEventWriteAttempt(batch: EventWriteBatch, cycleDeadline: number): Promise<void> {
    const client = this.client;
    if (!client) throw new Error('ClickHouse client is unavailable');
    const controller = new AbortController();
    this.eventWriteAbortController = controller;
    let attemptTimedOut = false;
    const remainingMs = Math.max(1, cycleDeadline - this.eventWriteNow());
    const timer = setTimeout(() => {
      attemptTimedOut = true;
      controller.abort('ClickHouse event insert attempt timed out');
    }, Math.min(this.eventWriteAttemptTimeoutMs, remainingMs));
    try {
      await client.insert({
        table: TABLE,
        values: batch.rows,
        format: 'JSONEachRow',
        clickhouse_settings: batch.settings,
        abort_signal: controller.signal,
      });
    } catch (error) {
      const normalized = this.asEventWriteError(error);
      if (attemptTimedOut) Object.assign(normalized, { eventWriteAttemptTimedOut: true });
      throw normalized;
    } finally {
      clearTimeout(timer);
      if (this.eventWriteAbortController === controller) this.eventWriteAbortController = undefined;
    }
  }

  private asEventWriteError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
  }

  private classifyEventWriteError(error: Error): EventWriteErrorDecision {
    const detail = error as Error & {
      code?: string | number;
      type?: string;
      status?: string | number;
      statusCode?: string | number;
      eventWriteAttemptTimedOut?: boolean;
    };
    const code = detail.code == null ? '' : String(detail.code);
    const type = detail.type ?? '';
    if (detail.eventWriteAttemptTimedOut) return { retryable: true, ambiguous: true, code: 'ATTEMPT_TIMEOUT' };

    const status = Number(detail.status ?? detail.statusCode);
    const retryableHttpStatuses = new Set([408, 425, 429, 502, 503, 504]);
    if (retryableHttpStatuses.has(status)) {
      // A 408 may be returned after an upstream accepted bytes; the remaining explicit gateway/
      // overload responses are known unsuccessful responses rather than ambiguous applications.
      return { retryable: true, ambiguous: status === 408, code: `HTTP_${status}` };
    }

    const transientServerTypes = new Set([
      'MEMORY_LIMIT_EXCEEDED',
      'TOO_MANY_SIMULTANEOUS_QUERIES',
      'TOO_MANY_PARTS',
    ]);
    if (code === '241' || transientServerTypes.has(type)) {
      return { retryable: true, ambiguous: false, code: type || code };
    }
    const ambiguousServerTypes = new Set([
      'TIMEOUT_EXCEEDED',
      'NETWORK_ERROR',
      'SOCKET_TIMEOUT',
      'UNKNOWN_STATUS_OF_INSERT',
    ]);
    if (ambiguousServerTypes.has(type)) return { retryable: true, ambiguous: true, code: type };

    const transportCodes = new Set([
      'ECONNREFUSED',
      'ENOTFOUND',
      'EHOSTUNREACH',
      'ENETUNREACH',
      'EAI_AGAIN',
      'ECONNRESET',
      'EPIPE',
      'ETIMEDOUT',
      'UND_ERR_CONNECT_TIMEOUT',
    ]);
    if (transportCodes.has(code)) {
      const definitelyBeforeApply = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN']);
      return { retryable: true, ambiguous: !definitelyBeforeApply.has(code), code };
    }
    if (/timeout error|socket hang up|aborted a request/i.test(error.message)) {
      return { retryable: true, ambiguous: true, code: code || 'TRANSPORT_TIMEOUT' };
    }
    return { retryable: false, ambiguous: false, code: type || code || 'PERMANENT_OR_UNKNOWN' };
  }

  private sleepBeforeEventWriteRetry(milliseconds: number): Promise<void> {
    if (milliseconds <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      let timer!: NodeJS.Timeout;
      const wake = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.eventWriteRetrySleep?.wake === wake) this.eventWriteRetrySleep = undefined;
        resolve();
      };
      timer = setTimeout(wake, milliseconds);
      this.eventWriteRetrySleep = { timer, wake };
    });
  }

  private wakeEventWriteRetrySleep(): void {
    this.eventWriteRetrySleep?.wake();
  }

  private scheduleEventWriteRetry(at: number): void {
    if (this.closing || this.eventWritePermanentError) return;
    if (this.eventWriteRetryWakeTimer) clearTimeout(this.eventWriteRetryWakeTimer);
    const delayMs = Math.max(0, at - this.eventWriteNow());
    this.eventWriteRetryWakeTimer = setTimeout(() => {
      this.eventWriteRetryWakeTimer = undefined;
      this.startEventWriteDrain();
    }, delayMs);
    this.eventWriteRetryWakeTimer.unref?.();
  }

  /** Load the most-recent `limit` events at/after `sinceMs`, oldest-first (to seed the hot ring). */
  enqueueCollectorHeartbeat(record: CollectorHeartbeatRecord): void {
    if (!this.ready) return;
    this.collectorHeartbeatBuf.push({
      collectorId: record.collectorId,
      at: record.at,
      payload: JSON.stringify(record),
    });
    if (this.collectorHeartbeatBuf.length >= 100) void this.flush();
  }

  async queryCollectorHeartbeats(sinceMs: number, untilMs: number): Promise<CollectorHeartbeatRecord[] | null> {
    if (!this.client || !this.ready) return null;
    try {
      const result = await this.client.query({
        query: `
          SELECT argMax(payload, at) AS payload
          FROM ${COLLECTOR_HEARTBEAT_TABLE}
          WHERE at >= {since:UInt64} AND at <= {until:UInt64}
          GROUP BY collectorId, at
          ORDER BY at`,
        query_params: { since: sinceMs, until: untilMs },
        format: 'JSONEachRow',
      });
      const rows = await result.json() as Array<{ payload: string }>;
      return rows.flatMap((row) => {
        try {
          return [JSON.parse(row.payload) as CollectorHeartbeatRecord];
        } catch {
          return [];
        }
      });
    } catch (error) {
      console.error('[clickhouse] collector heartbeat query failed:', (error as Error).message);
      return null;
    }
  }

  async latestCollectorHeartbeats(untilMs: number): Promise<CollectorHeartbeatRecord[] | null> {
    if (!this.client || !this.ready) return null;
    try {
      const result = await this.client.query({
        query: `
          SELECT argMax(payload, at) AS payload
          FROM ${COLLECTOR_HEARTBEAT_TABLE}
          WHERE at <= {until:UInt64}
          GROUP BY collectorId`,
        query_params: { until: untilMs },
        format: 'JSONEachRow',
      });
      const rows = await result.json() as Array<{ payload: string }>;
      return rows.flatMap((row) => {
        try {
          return [JSON.parse(row.payload) as CollectorHeartbeatRecord];
        } catch {
          return [];
        }
      });
    } catch (error) {
      console.error('[clickhouse] latest collector heartbeat query failed:', (error as Error).message);
      return null;
    }
  }

  /** Load the most-recent `limit` events at/after `sinceMs`, oldest-first (to seed the hot ring). */

  async hydrate(sinceMs: number, limit: number): Promise<JudgedEvent[]> {
    if (!this.client) return [];
    const safeLimit = Math.max(1, Math.min(100_000, Math.round(limit)));
    try {
      const rs = await this.client.query({
        // Bound the primary-key scan before revision ordering, but keep every row at the cutoff
        // timestamp so lifecycle revisions cannot be split. Server-side dedup means the API parses
        // only the hot-ring result instead of three times as many wide JSON rows during startup.
        query: `
          SELECT *
          FROM (
            SELECT *
            FROM ${TABLE}
            PREWHERE at >= {since:UInt64}
            ORDER BY at DESC
            LIMIT {scanLimit:UInt32} WITH TIES
          )
          ORDER BY at DESC, decisionUpdatedAt DESC
          LIMIT 1 BY eventId
          LIMIT {limit:UInt32}`,
        query_params: {
          since: sinceMs,
          scanLimit: Math.min(safeLimit * 3, 300_000),
          limit: safeLimit,
        },
        clickhouse_settings: BOUNDED_HYDRATE_READ_SETTINGS,
        format: 'JSONEachRow',
      });
      const rows = (await rs.json()) as Array<Record<string, unknown>>;
      const latest = new Map<string, JudgedEvent>();
      for (const event of rows.map(fromRow)) {
        const previous = latest.get(event.eventId);
        if (!previous || (event.decisionUpdatedAt ?? event.at) >= (previous.decisionUpdatedAt ?? previous.at)) latest.set(event.eventId, event);
      }
      return [...latest.values()].sort((a, b) => a.at - b.at).slice(-safeLimit);
    } catch (err) {
      console.error('[clickhouse] hydrate failed:', (err as Error).message);
      return [];
    }
  }

  /** Read the latest persisted events from a bounded interval for dashboard timelines. */
  async recentWindowEvents(
    sinceMs: number,
    untilMs: number,
    limit: number,
    options: { monitoredOnly?: boolean; tier?: string } = {},
  ): Promise<JudgedEvent[] | null> {
    if (!this.client || !this.ready) return null;
    const client = this.client;
    const safeLimit = Math.max(1, Math.min(5_000, Math.round(limit)));
    const monitoredOnly = Boolean(options.monitoredOnly);
    const tier = options.tier ?? '';
    const queryKey = JSON.stringify([String(sinceMs), String(untilMs), safeLimit, monitoredOnly, tier]);
    const current = this.recentQueryInFlight;
    if (current) {
      if (current.key !== queryKey) return null;
      const shared = await current.value;
      return shared ? [...shared] : null;
    }
    const release = this.tryAcquireWideEventReadSlot();
    if (!release) return null;
    // Attribution is copied unchanged into every judgment revision, so monitored can safely narrow
    // the primary-key sample. Tier changes across L1/L2/L3 and must be filtered only after the
    // latest revision is selected.
    const scanFilters = monitoredOnly ? ["JSONExtractBool(attribution, 'monitored')"] : [];
    const latestFilters = tier ? ['tier = {tier:String}'] : [];
    const value = (async (): Promise<JudgedEvent[] | null> => {
      try {
        const rs = await client.query({
          query: `
          SELECT *
          FROM (
            SELECT *
            FROM (
              SELECT *
              FROM ${TABLE}
              PREWHERE at >= {since:UInt64} AND at <= {until:UInt64}
              ${scanFilters.length ? `WHERE ${scanFilters.join(' AND ')}` : ''}
              ORDER BY at DESC
              LIMIT {scanLimit:UInt32} WITH TIES
            )
            ORDER BY at DESC, decisionUpdatedAt DESC
            LIMIT 1 BY eventId
          )
          ${latestFilters.length ? `WHERE ${latestFilters.join(' AND ')}` : ''}
          ORDER BY at DESC, decisionUpdatedAt DESC
          LIMIT {limit:UInt32}`,
          query_params: {
            since: sinceMs,
            until: untilMs,
            tier,
            scanLimit: tier ? 15_000 : Math.min(15_000, safeLimit * 3),
            limit: safeLimit,
          },
          clickhouse_settings: BOUNDED_RECENT_READ_SETTINGS,
          format: 'JSONEachRow',
        });
        return (await rs.json() as Array<Record<string, unknown>>).map(fromRow);
      } catch (error) {
        console.error('[clickhouse] recent dashboard events query failed:', (error as Error).message);
        return null;
      }
    })();
    this.recentQueryInFlight = { key: queryKey, value };
    try {
      const rows = await value;
      return rows ? [...rows] : null;
    } finally {
      if (this.recentQueryInFlight?.value === value) this.recentQueryInFlight = undefined;
      release();
    }
  }

  /**
   * Return durable writes after a stable lexicographic cursor. The journal is populated by a
   * ClickHouse materialized view, so revisions inserted by another worker process invalidate the
   * same dashboard bucket cache. A bounded page prevents a recovery burst from monopolising the
   * API; callers continue from the returned cursor while `hasMore` is true.
   */
  async eventCommitChanges(
    after?: EventCommitCursor,
    limit = 20_000,
  ): Promise<EventCommitChanges | null> {
    if (!this.client || !this.ready) return null;
    const safeLimit = Math.max(1, Math.min(100_000, Math.trunc(limit)));
    try {
      const result = await this.client.query({
        query: `
          SELECT eventId, decisionRevision, eventAt, committedAt, sourceId, collectorId
          FROM ${EVENT_COMMIT_FACT_TABLE}
          WHERE tuple(committedAt, eventId, decisionRevision) >
            tuple({committedAt:UInt64}, {eventId:String}, {decisionRevision:UInt32})
          ORDER BY committedAt, eventId, decisionRevision
          LIMIT {limit:UInt32}`,
        query_params: {
          committedAt: after?.committedAtMs ?? 0,
          eventId: after?.eventId ?? '',
          decisionRevision: after?.decisionRevision ?? 0,
          limit: safeLimit + 1,
        },
        format: 'JSONEachRow',
      });
      const rows = await result.json() as Array<Record<string, unknown>>;
      const hasMore = rows.length > safeLimit;
      const selected = hasMore ? rows.slice(0, safeLimit) : rows;
      const changes = selected.map<EventCommitChange>((row) => ({
        cursor: {
          committedAtMs: Number(row.committedAt) || 0,
          eventId: String(row.eventId ?? ''),
          decisionRevision: Math.max(1, Number(row.decisionRevision) || 1),
        },
        eventAtMs: Number(row.eventAt) || 0,
        sourceId: String(row.sourceId ?? '').trim() || undefined,
        collectorId: String(row.collectorId ?? '').trim() || undefined,
      }));
      return {
        changes,
        cursor: changes.at(-1)?.cursor ?? after,
        hasMore,
      };
    } catch (error) {
      console.error('[clickhouse] event commit journal query failed:', (error as Error).message);
      return null;
    }
  }

  async latestEventCommitCursor(): Promise<EventCommitCursor | null> {
    if (!this.client || !this.ready) return null;
    try {
      const result = await this.client.query({
        query: `
          SELECT committedAt, eventId, decisionRevision
          FROM ${EVENT_COMMIT_FACT_TABLE}
          ORDER BY committedAt DESC, eventId DESC, decisionRevision DESC
          LIMIT 1`,
        format: 'JSONEachRow',
      });
      const row = (await result.json() as Array<Record<string, unknown>>)[0];
      if (!row) return { committedAtMs: 0, eventId: '', decisionRevision: 0 };
      return {
        committedAtMs: Number(row.committedAt) || 0,
        eventId: String(row.eventId ?? ''),
        decisionRevision: Math.max(1, Number(row.decisionRevision) || 1),
      };
    } catch (error) {
      console.error('[clickhouse] latest event commit cursor query failed:', (error as Error).message);
      return null;
    }
  }

  /**
   * Return the oldest journal row that can still be observed.
   *
   * The commit journal has a finite TTL. A long-lived API cache whose cursor is older than this
   * row cannot prove that it observed every invalidation, so callers must discard their cached
   * historical prefix and rebuild it. Brief memoisation keeps several dashboard caches from
   * issuing the same bounds query during one refresh cycle.
   */
  earliestEventCommitCursor(): Promise<EventCommitCursor | null> {
    const current = Date.now();
    const cached = this.earliestCommitCursorCache;
    if (cached && cached.expiresAt > current) return cached.value;
    const value = this.queryEarliestEventCommitCursor();
    this.earliestCommitCursorCache = {
      expiresAt: current + 10_000,
      value,
    };
    void value.catch(() => {
      if (this.earliestCommitCursorCache?.value === value) {
        this.earliestCommitCursorCache = undefined;
      }
    });
    return value;
  }

  private async queryEarliestEventCommitCursor(): Promise<EventCommitCursor | null> {
    if (!this.client || !this.ready) return null;
    try {
      const result = await this.client.query({
        query: `
          SELECT committedAt, eventId, decisionRevision
          FROM ${EVENT_COMMIT_FACT_TABLE}
          ORDER BY committedAt, eventId, decisionRevision
          LIMIT 1`,
        format: 'JSONEachRow',
      });
      const row = (await result.json() as Array<Record<string, unknown>>)[0];
      if (!row) return { committedAtMs: 0, eventId: '', decisionRevision: 0 };
      return {
        committedAtMs: Number(row.committedAt) || 0,
        eventId: String(row.eventId ?? ''),
        decisionRevision: Math.max(1, Number(row.decisionRevision) || 1),
      };
    } catch (error) {
      console.error('[clickhouse] earliest event commit cursor query failed:', (error as Error).message);
      return null;
    }
  }

  /**
   * Read the complete persisted tail without an arbitrary row limit. The interval is intentionally
   * short (the Dashboard uses 60 seconds), and the latest decision revision is selected before the
   * result is merged with the in-process hot ring.
   */
  async dashboardTailEvents(startMs: number, endMs: number): Promise<JudgedEvent[] | null> {
    if (!this.client || !this.ready) return null;
    if (endMs < startMs) return [];
    try {
      const result = await this.client.query({
        query: `
          SELECT *
          FROM (
            SELECT *
            FROM ${TABLE}
            WHERE at >= {start:UInt64} AND at <= {end:UInt64}
            ORDER BY decisionRevision DESC, decisionUpdatedAt DESC, at DESC
            LIMIT 1 BY eventId
          )
          ORDER BY at, eventId`,
        query_params: {
          start: Math.max(0, Math.trunc(startMs)),
          end: Math.max(0, Math.trunc(endMs)),
        },
        format: 'JSONEachRow',
      });
      return (await result.json() as Array<Record<string, unknown>>).map(fromRow);
    } catch (error) {
      console.error('[clickhouse] dashboard tail query failed:', (error as Error).message);
      return null;
    }
  }

  async dashboardAggregateBucketFacts(
    startMs: number,
    endExclusiveMs: number,
    bucketMs = 10_000,
  ): Promise<DashboardAggregateBucketFact[] | null> {
    if (!this.client || !this.ready) return null;
    const size = Math.max(1_000, Math.min(60_000, Math.trunc(bucketMs)));
    if (endExclusiveMs <= startMs) return [];
    const start = Math.max(0, Math.trunc(startMs));
    const end = Math.max(0, Math.trunc(endExclusiveMs));
    const canPersist =
      process.env.ANYSENTRY_PERSISTED_DASHBOARD_BUCKETS !== 'off' &&
      start % size === 0 &&
      end % size === 0;
    if (!canPersist) return this.queryDashboardAggregateBucketFactsRaw(start, end, size);

    try {
      const stored = await this.readPersistedDashboardBuckets(start, end, size);
      const byBucket = new Map<number, DashboardAggregateBucketFact[]>();
      for (const snapshot of stored.values()) {
        byBucket.set(snapshot.bucketStartMs, snapshot.facts);
      }

      const missingRanges: Array<{ start: number; end: number }> = [];
      let missingStart: number | undefined;
      for (let bucket = start; bucket <= end; bucket += size) {
        const missing = bucket < end && !byBucket.has(bucket);
        if (missing && missingStart === undefined) missingStart = bucket;
        if ((!missing || bucket === end) && missingStart !== undefined) {
          missingRanges.push({ start: missingStart, end: bucket });
          missingStart = undefined;
        }
      }

      // A very fragmented retained snapshot set should not turn into a query fan-out. Recompute
      // one bounded span and replace all buckets in it instead.
      const ranges = missingRanges.length > 8
        ? [{ start: missingRanges[0].start, end: missingRanges.at(-1)!.end }]
        : missingRanges;
      for (const range of ranges) {
        this.dashboardSnapshotStats.exactRanges += 1;
        const before = await this.latestEventCommitCursor();
        const rows = await this.queryDashboardAggregateBucketFactsRaw(
          range.start,
          range.end,
          size,
        );
        if (rows === null) return null;
        const grouped = new Map<number, DashboardAggregateBucketFact[]>();
        for (const row of rows) {
          const bucketRows = grouped.get(row.bucketStartMs) ?? [];
          bucketRows.push(row);
          grouped.set(row.bucketStartMs, bucketRows);
        }
        for (let bucket = range.start; bucket < range.end; bucket += size) {
          byBucket.set(bucket, grouped.get(bucket) ?? []);
        }

        const after = await this.latestEventCommitCursor();
        if (
          before &&
          after &&
          compareEventCommitCursor(before, after) === 0
        ) {
          await this.writePersistedDashboardBuckets(
            range.start,
            range.end,
            size,
            after,
            grouped,
          );
        }
      }

      const result: DashboardAggregateBucketFact[] = [];
      for (let bucket = start; bucket < end; bucket += size) {
        result.push(...(byBucket.get(bucket) ?? []));
      }
      return result;
    } catch (error) {
      this.dashboardSnapshotStats.fallbackErrors += 1;
      console.warn(
        '[clickhouse] persisted dashboard bucket cache unavailable; using exact raw aggregation:',
        (error as Error).message,
      );
      return this.queryDashboardAggregateBucketFactsRaw(start, end, size);
    }
  }

  /**
   * Aggregate absolute, reusable time buckets. The query first folds all decision revisions to the
   * latest fact for each eventId, then emits additive facts keyed by the security dimensions needed
   * by the Dashboard. No sampling or event limit is used.
   */
  private async queryDashboardAggregateBucketFactsRaw(
    startMs: number,
    endExclusiveMs: number,
    bucketMs: number,
  ): Promise<DashboardAggregateBucketFact[] | null> {
    if (!this.client || !this.ready) return null;
    const size = Math.max(1_000, Math.min(60_000, Math.trunc(bucketMs)));
    if (endExclusiveMs <= startMs) return [];
    try {
      const result = await this.client.query({
        query: `
          SELECT
            intDiv(at, {bucketMs:UInt64}) * {bucketMs:UInt64} AS bucketStart,
            JSONExtractBool(attribution, 'monitored') AS monitored,
            decisionStatus,
            verdict,
            tier,
            riskType,
            riskCategory,
            riskName,
            multiIf(severity = 'critical', 4, severity = 'high', 3, severity = 'medium', 2, severity = 'low', 1, 0) AS severityRank,
            if(
              JSONExtractString(attribution, 'agentSessionId') != '',
              JSONExtractString(attribution, 'agentSessionId'),
              if(
                JSONExtractString(attribution, 'agentDisplayName') != '',
                JSONExtractString(attribution, 'agentDisplayName'),
                if(JSONExtractString(attribution, 'agentScopeId') != '', JSONExtractString(attribution, 'agentScopeId'), agentId)
              )
            ) AS sessionKey,
            userId,
            if(
              JSONExtractString(process, 'cwd') != '',
              JSONExtractString(process, 'cwd'),
              if(
                JSONExtractString(attribution, 'agentScopeId') != '',
                concat('agent://', JSONExtractString(attribution, 'agentScopeId')),
                workspacePath
              )
            ) AS resolvedWorkspacePath,
            count() AS eventCount,
            countIf(verdict = 'block' AND decisionStatus IN ('succeeded', 'failed', 'timeout')) AS blockedCount,
            countIf(verdict = 'escalate' AND decisionStatus IN ('succeeded', 'failed', 'timeout')) AS escalatedCount,
            countIf(tier IN ('Llm', 'Agent') AND decisionStatus IN ('succeeded', 'failed', 'timeout')) AS l2Count,
            countIf(tier = 'Agent' AND decisionStatus IN ('succeeded', 'failed', 'timeout')) AS l3Count,
            countIf(verdict != 'allow' AND decisionStatus IN ('succeeded', 'failed', 'timeout')) AS riskActivationCount,
            countIf(verdict != 'allow') AS riskyEventCount,
            sumIf(tokenCount, decisionStatus IN ('succeeded', 'failed', 'timeout')) AS tokenCount,
            sumIf(latencyMs, decisionStatus IN ('succeeded', 'failed', 'timeout')) AS latencyTotal,
            sumIf(riskScore, decisionStatus IN ('succeeded', 'failed', 'timeout')) AS riskScoreTotal,
            max(at) AS lastEventAt,
            countIf(verdict != 'allow' AND riskCategory = 'command_danger') AS commandDangerCount,
            countIf(verdict != 'allow' AND riskCategory = 'prompt_injection') AS promptInjectionCount,
            countIf(verdict != 'allow' AND riskCategory IN ('data_leak', 'secret_exfil')) AS dataLeakCount,
            countIf(verdict != 'allow' AND riskCategory = 'communication_risk') AS communicationRiskCount,
            countIf(verdict != 'allow' AND riskCategory IN ('systemic_risk', 'privilege_escalation')) AS systemicRiskCount
          FROM (
            SELECT *
            FROM ${TABLE}
            WHERE at >= {start:UInt64} AND at < {end:UInt64}
            ORDER BY decisionRevision DESC, decisionUpdatedAt DESC, at DESC
            LIMIT 1 BY eventId
          )
          GROUP BY
            bucketStart, monitored, decisionStatus, verdict, tier, riskType, riskCategory, riskName,
            severityRank, sessionKey, userId, resolvedWorkspacePath
          ORDER BY bucketStart`,
        query_params: {
          start: Math.max(0, Math.trunc(startMs)),
          end: Math.max(0, Math.trunc(endExclusiveMs)),
          bucketMs: size,
        },
        format: 'JSONEachRow',
      });
      const num = (value: unknown): number => Number(value) || 0;
      return (await result.json() as Array<Record<string, unknown>>).map((row) => ({
        bucketStartMs: num(row.bucketStart),
        monitored: Boolean(num(row.monitored)),
        decisionStatus: String(row.decisionStatus ?? ''),
        verdict: String(row.verdict ?? ''),
        tier: String(row.tier ?? ''),
        riskType: String(row.riskType ?? ''),
        riskCategory: String(row.riskCategory ?? ''),
        riskName: String(row.riskName ?? ''),
        severityRank: num(row.severityRank),
        sessionKey: String(row.sessionKey ?? ''),
        userId: String(row.userId ?? ''),
        workspacePath: String(row.resolvedWorkspacePath ?? ''),
        eventCount: num(row.eventCount),
        blockedCount: num(row.blockedCount),
        escalatedCount: num(row.escalatedCount),
        l2Count: num(row.l2Count),
        l3Count: num(row.l3Count),
        riskActivationCount: num(row.riskActivationCount),
        riskyEventCount: num(row.riskyEventCount),
        tokenCount: num(row.tokenCount),
        latencyTotal: num(row.latencyTotal),
        riskScoreTotal: num(row.riskScoreTotal),
        lastEventAt: num(row.lastEventAt),
        commandDangerCount: num(row.commandDangerCount),
        promptInjectionCount: num(row.promptInjectionCount),
        dataLeakCount: num(row.dataLeakCount),
        communicationRiskCount: num(row.communicationRiskCount),
        systemicRiskCount: num(row.systemicRiskCount),
      }));
    } catch (error) {
      console.error('[clickhouse] reusable dashboard bucket query failed:', (error as Error).message);
      return null;
    }
  }

  private async readPersistedDashboardBuckets(
    startMs: number,
    endExclusiveMs: number,
    bucketMs: number,
  ): Promise<Map<number, PersistedDashboardBucket>> {
    if (!this.client || !this.ready) return new Map();
    const [snapshotResult, commitResult, earliest] = await Promise.all([
      this.client.query({
        query: `
          SELECT
            bucketStart,
            bucketMs,
            argMax(
              snapshotCommittedAt,
              tuple(snapshotCommittedAt, snapshotEventId, snapshotDecisionRevision, snapshotVersion)
            ) AS latestSnapshotCommittedAt,
            argMax(
              snapshotEventId,
              tuple(snapshotCommittedAt, snapshotEventId, snapshotDecisionRevision, snapshotVersion)
            ) AS latestSnapshotEventId,
            argMax(
              snapshotDecisionRevision,
              tuple(snapshotCommittedAt, snapshotEventId, snapshotDecisionRevision, snapshotVersion)
            ) AS latestSnapshotDecisionRevision,
            argMax(
              factsJson,
              tuple(snapshotCommittedAt, snapshotEventId, snapshotDecisionRevision, snapshotVersion)
            ) AS latestFactsJson
          FROM ${DASHBOARD_BUCKET_SNAPSHOT_TABLE}
          WHERE bucketMs = {bucketMs:UInt32}
            AND bucketStart >= {start:UInt64}
            AND bucketStart < {end:UInt64}
          GROUP BY bucketStart, bucketMs
          ORDER BY bucketStart`,
        query_params: {
          start: startMs,
          end: endExclusiveMs,
          bucketMs,
        },
        format: 'JSONEachRow',
      }),
      this.client.query({
        query: `
          SELECT
            intDiv(eventAt, {bucketMs:UInt64}) * {bucketMs:UInt64} AS bucketStart,
            argMax(committedAt, tuple(committedAt, eventId, decisionRevision)) AS latestCommittedAt,
            argMax(eventId, tuple(committedAt, eventId, decisionRevision)) AS latestEventId,
            argMax(decisionRevision, tuple(committedAt, eventId, decisionRevision)) AS latestDecisionRevision
          FROM ${EVENT_COMMIT_FACT_TABLE}
          WHERE eventAt >= {start:UInt64} AND eventAt < {end:UInt64}
          GROUP BY bucketStart`,
        query_params: {
          start: startMs,
          end: endExclusiveMs,
          bucketMs,
        },
        format: 'JSONEachRow',
      }),
      this.earliestEventCommitCursor(),
    ]);
    if (earliest === null) return new Map();
    const snapshots = (await snapshotResult.json() as Array<Record<string, unknown>>)
      .flatMap<PersistedDashboardBucket>((row) => {
        try {
          const facts = JSON.parse(String(row.latestFactsJson ?? '[]')) as unknown;
          if (!Array.isArray(facts)) return [];
          return [{
            bucketStartMs: Number(row.bucketStart) || 0,
            bucketMs: Number(row.bucketMs) || bucketMs,
            cursor: {
              committedAtMs: Number(row.latestSnapshotCommittedAt) || 0,
              eventId: String(row.latestSnapshotEventId ?? ''),
              decisionRevision: Number(row.latestSnapshotDecisionRevision) || 0,
            },
            facts: facts as DashboardAggregateBucketFact[],
          }];
        } catch {
          return [];
        }
      });
    const latestCommits = (await commitResult.json() as Array<Record<string, unknown>>)
      .map<BucketCommitCursor>((row) => ({
        bucketStartMs: Number(row.bucketStart) || 0,
        cursor: {
          committedAtMs: Number(row.latestCommittedAt) || 0,
          eventId: String(row.latestEventId ?? ''),
          decisionRevision: Number(row.latestDecisionRevision) || 0,
        },
      }));
    const valid = validPersistedDashboardBuckets(snapshots, latestCommits, earliest);
    const expectedBuckets = Math.max(
      0,
      Math.ceil((endExclusiveMs - startMs) / bucketMs),
    );
    this.dashboardSnapshotStats.hits += valid.size;
    this.dashboardSnapshotStats.misses += Math.max(0, expectedBuckets - valid.size);
    this.dashboardSnapshotStats.invalidated += Math.max(0, snapshots.length - valid.size);
    return valid;
  }

  private async writePersistedDashboardBuckets(
    startMs: number,
    endExclusiveMs: number,
    bucketMs: number,
    cursor: EventCommitCursor,
    factsByBucket: Map<number, DashboardAggregateBucketFact[]>,
  ): Promise<void> {
    if (!this.client || !this.ready || endExclusiveMs <= startMs) return;
    const computedAt = Date.now();
    const baseVersion =
      computedAt * 1_000 + (this.dashboardSnapshotSequence++ % 1_000);
    const values: Array<{
      bucketStart: number;
      bucketMs: number;
      snapshotCommittedAt: number;
      snapshotEventId: string;
      snapshotDecisionRevision: number;
      snapshotVersion: number;
      factsJson: string;
      computedAt: number;
    }> = [];
    for (let bucket = startMs; bucket < endExclusiveMs; bucket += bucketMs) {
      values.push({
        bucketStart: bucket,
        bucketMs,
        snapshotCommittedAt: cursor.committedAtMs,
        snapshotEventId: cursor.eventId,
        snapshotDecisionRevision: cursor.decisionRevision,
        snapshotVersion: baseVersion,
        factsJson: JSON.stringify(factsByBucket.get(bucket) ?? []),
        computedAt,
      });
    }
    try {
      await this.client.insert({
        table: DASHBOARD_BUCKET_SNAPSHOT_TABLE,
        values,
        format: 'JSONEachRow',
      });
      this.dashboardSnapshotStats.writtenBuckets += values.length;
    } catch (error) {
      this.dashboardSnapshotStats.fallbackErrors += 1;
      // Snapshot persistence is an optimisation only. Exact raw facts have already been computed;
      // a write failure must not make the Dashboard unavailable.
      console.warn(
        '[clickhouse] dashboard bucket snapshot write failed:',
        (error as Error).message,
      );
    }
  }

  /**
   * Aggregate the complete persisted interval instead of the bounded in-memory hot ring. The latest
   * decision revision is selected per eventId before grouping, so a pending event later judged by
   * L2/L3 is counted once with its final state.
   */
  async dashboardWindowHistory(startMs: number, endMs: number, bucketCount = 180): Promise<DashboardWindowHistory | null> {
    if (!this.client || !this.ready) return null;
    const spanMs = Math.max(1, endMs - startMs);
    const queryStartMs = Math.max(0, startMs - spanMs);
    const buckets = Math.max(1, Math.min(360, Math.round(bucketCount)));
    const bucketMs = Math.max(1, Math.ceil(spanMs / buckets));
    const latestMonitored = `
      SELECT
        eventId,
        argMax(sourceEvent.at, tuple(sourceEvent.decisionRevision, sourceEvent.decisionUpdatedAt, sourceEvent.at)) AS eventAt,
        argMax(sourceEvent.agentId, tuple(sourceEvent.decisionRevision, sourceEvent.decisionUpdatedAt, sourceEvent.at)) AS agentId,
        argMax(sourceEvent.sessionId, tuple(sourceEvent.decisionRevision, sourceEvent.decisionUpdatedAt, sourceEvent.at)) AS sessionId,
        argMax(sourceEvent.userId, tuple(sourceEvent.decisionRevision, sourceEvent.decisionUpdatedAt, sourceEvent.at)) AS userId,
        argMax(sourceEvent.workspacePath, tuple(sourceEvent.decisionRevision, sourceEvent.decisionUpdatedAt, sourceEvent.at)) AS workspacePath,
        argMax(sourceEvent.verdict, tuple(sourceEvent.decisionRevision, sourceEvent.decisionUpdatedAt, sourceEvent.at)) AS verdict,
        argMax(sourceEvent.severity, tuple(sourceEvent.decisionRevision, sourceEvent.decisionUpdatedAt, sourceEvent.at)) AS severity,
        argMax(sourceEvent.riskCategory, tuple(sourceEvent.decisionRevision, sourceEvent.decisionUpdatedAt, sourceEvent.at)) AS riskCategory,
        argMax(sourceEvent.riskScore, tuple(sourceEvent.decisionRevision, sourceEvent.decisionUpdatedAt, sourceEvent.at)) AS riskScore,
        argMax(sourceEvent.process, tuple(sourceEvent.decisionRevision, sourceEvent.decisionUpdatedAt, sourceEvent.at)) AS process,
        argMax(sourceEvent.attribution, tuple(sourceEvent.decisionRevision, sourceEvent.decisionUpdatedAt, sourceEvent.at)) AS attribution
      FROM ${TABLE} AS sourceEvent
      PREWHERE sourceEvent.at >= {start:UInt64} AND sourceEvent.at <= {end:UInt64}
      WHERE JSONExtractBool(sourceEvent.attribution, 'monitored')
      GROUP BY eventId
      HAVING JSONExtractBool(attribution, 'monitored')`;
    // AggregationService already coalesces the same window. A different concurrent full-window
    // request must fall back to the hot ring instead of building an unbounded queue of heavy reads.
    const release = this.tryAcquireWideEventReadSlot();
    if (!release) return null;
    try {
      const queryRows = async (
        query: string,
        queryParams: Record<string, string | number>,
        settings = BOUNDED_DASHBOARD_READ_SETTINGS,
      ): Promise<Array<Record<string, unknown>>> => {
        const result = await this.client!.query({
          query,
          query_params: queryParams,
          clickhouse_settings: settings,
          format: 'JSONEachRow',
        });
        return await result.json() as Array<Record<string, unknown>>;
      };
      const dimensionRows = await queryRows(
        `
            SELECT
              if(at < {start:UInt64}, 'previous', 'current') AS period,
              JSONExtractBool(attribution, 'monitored') AS monitored,
              verdict,
              tier,
              riskType,
              riskCategory,
              argMax(riskName, decisionUpdatedAt) AS riskName,
              uniqCombined64(eventId) AS eventCount,
              sum(tokenCount) AS tokenCount,
              sum(latencyMs) AS latencyTotal,
              sum(riskScore) AS riskScoreTotal
            FROM ${TABLE}
            PREWHERE at >= {queryStart:UInt64} AND at <= {end:UInt64}
            WHERE decisionStatus IN ('succeeded', 'failed', 'timeout')
            GROUP BY period, monitored, verdict, tier, riskType, riskCategory`,
        { queryStart: queryStartMs, start: startMs, end: endMs },
      );
      const bucketRowsRaw = await queryRows(
        `
            SELECT
              least({bucketCount:UInt32} - 1, intDiv(at - {start:UInt64}, {bucketMs:UInt64})) AS bucketIndex,
              JSONExtractBool(attribution, 'monitored') AS monitored,
              uniqCombined64(eventId) AS eventCount,
              uniqCombined64If(eventId, verdict = 'block' AND decisionStatus IN ('succeeded', 'failed', 'timeout')) AS blockedCount,
              uniqCombined64If(eventId, verdict = 'escalate' AND decisionStatus IN ('succeeded', 'failed', 'timeout')) AS escalatedCount,
              uniqCombined64If(eventId, tier IN ('Llm', 'Agent') AND decisionStatus IN ('succeeded', 'failed', 'timeout')) AS l2Count,
              uniqCombined64If(eventId, tier = 'Agent' AND decisionStatus IN ('succeeded', 'failed', 'timeout')) AS l3Count,
              uniqCombined64If(eventId, verdict != 'allow' AND decisionStatus IN ('succeeded', 'failed', 'timeout')) AS riskActivationCount,
              sumIf(tokenCount, decisionStatus IN ('succeeded', 'failed', 'timeout')) AS tokenCount,
              sumIf(latencyMs, decisionStatus IN ('succeeded', 'failed', 'timeout')) AS latencyTotal,
              sumIf(riskScore, decisionStatus IN ('succeeded', 'failed', 'timeout')) AS riskScoreTotal
            FROM ${TABLE}
            PREWHERE at >= {start:UInt64} AND at <= {end:UInt64}
            GROUP BY bucketIndex, monitored
            ORDER BY bucketIndex`,
        { queryStart: queryStartMs, start: startMs, end: endMs, bucketCount: buckets, bucketMs },
      );
      const [sessionResult, workspaceResult] = await Promise.allSettled([
        queryRows(
          `
            SELECT
              if(
                JSONExtractString(attribution, 'agentSessionId') != '',
                JSONExtractString(attribution, 'agentSessionId'),
                if(
                  JSONExtractString(attribution, 'agentDisplayName') != '',
                  JSONExtractString(attribution, 'agentDisplayName'),
                  if(JSONExtractString(attribution, 'agentScopeId') != '', JSONExtractString(attribution, 'agentScopeId'), agentId)
                )
              ) AS sessionLabel,
              argMax(userId, eventAt) AS userId,
              argMax(
                if(
                  JSONExtractString(process, 'cwd') != '',
                  JSONExtractString(process, 'cwd'),
                  if(
                    JSONExtractString(attribution, 'agentScopeId') != '',
                    concat('agent://', JSONExtractString(attribution, 'agentScopeId')),
                    workspacePath
                  )
                ),
                eventAt
              ) AS resolvedWorkspacePath,
              count() AS eventCount,
              countIf(verdict != 'allow') AS riskyEventCount,
              sum(riskScore) AS riskScoreTotal,
              max(eventAt) AS lastEventAt,
              countIf(verdict != 'allow' AND riskCategory = 'command_danger') AS commandDanger,
              countIf(verdict != 'allow' AND riskCategory = 'prompt_injection') AS promptInjection,
              countIf(verdict != 'allow' AND riskCategory IN ('data_leak', 'secret_exfil')) AS dataLeak,
              countIf(verdict != 'allow' AND riskCategory = 'communication_risk') AS communicationRisk,
              countIf(verdict != 'allow' AND riskCategory IN ('systemic_risk', 'privilege_escalation')) AS systemicRisk
            FROM (${latestMonitored})
            GROUP BY sessionLabel
            ORDER BY riskScoreTotal DESC
            LIMIT 1`,
          { start: startMs, end: endMs },
          BOUNDED_DASHBOARD_DETAIL_READ_SETTINGS,
        ),
        queryRows(
          `
            SELECT
              if(
                JSONExtractString(process, 'cwd') != '',
                JSONExtractString(process, 'cwd'),
                if(
                  JSONExtractString(attribution, 'agentScopeId') != '',
                  concat('agent://', JSONExtractString(attribution, 'agentScopeId')),
                  workspacePath
                )
              ) AS resolvedWorkspacePath,
              uniqCombined64(
                if(
                  JSONExtractString(attribution, 'agentSessionId') != '',
                  JSONExtractString(attribution, 'agentSessionId'),
                  if(JSONExtractString(attribution, 'agentScopeId') != '', JSONExtractString(attribution, 'agentScopeId'), sessionId)
                )
              ) AS sessionCount,
              sum(riskScore) AS totalRiskScore,
              maxIf(
                multiIf(severity = 'critical', 4, severity = 'high', 3, severity = 'medium', 2, severity = 'low', 1, 0),
                verdict != 'allow'
              ) AS worstSeverityRank
            FROM (${latestMonitored})
            GROUP BY resolvedWorkspacePath
            ORDER BY totalRiskScore DESC
            LIMIT 500`,
          { start: startMs, end: endMs },
          BOUNDED_DASHBOARD_DETAIL_READ_SETTINGS,
        ),
      ]);
      if (sessionResult.status === 'rejected') throw sessionResult.reason;
      if (workspaceResult.status === 'rejected') throw workspaceResult.reason;
      const sessionRows = sessionResult.value;
      const workspaceRows = workspaceResult.value;
      const num = (value: unknown): number => Number(value) || 0;
      const dimensions = dimensionRows.map<DashboardWindowDimensionRow>((row) => ({
        period: String(row.period) === 'previous' ? 'previous' : 'current',
        monitored: Boolean(num(row.monitored)),
        verdict: String(row.verdict ?? ''),
        tier: String(row.tier ?? ''),
        riskType: String(row.riskType ?? ''),
        riskCategory: String(row.riskCategory ?? ''),
        riskName: String(row.riskName ?? ''),
        eventCount: num(row.eventCount),
        tokenCount: num(row.tokenCount),
        latencyTotal: num(row.latencyTotal),
        riskScoreTotal: num(row.riskScoreTotal),
      }));
      const bucketRows = bucketRowsRaw.map<DashboardWindowBucketRow>((row) => ({
        bucketIndex: num(row.bucketIndex),
        monitored: Boolean(num(row.monitored)),
        eventCount: num(row.eventCount),
        blockedCount: num(row.blockedCount),
        escalatedCount: num(row.escalatedCount),
        l2Count: num(row.l2Count),
        l3Count: num(row.l3Count),
        riskActivationCount: num(row.riskActivationCount),
        tokenCount: num(row.tokenCount),
        latencyTotal: num(row.latencyTotal),
        riskScoreTotal: num(row.riskScoreTotal),
      }));
      const top = sessionRows[0];
      const topSession = top ? {
        sessionId: String(top.sessionLabel ?? ''),
        userId: String(top.userId ?? ''),
        workspacePath: String(top.resolvedWorkspacePath ?? ''),
        eventCount: num(top.eventCount),
        riskyEventCount: num(top.riskyEventCount),
        riskScoreTotal: num(top.riskScoreTotal),
        lastEventAt: num(top.lastEventAt),
        dimensionCounts: {
          command_danger: num(top.commandDanger),
          prompt_injection: num(top.promptInjection),
          data_leak: num(top.dataLeak),
          jailbreak: num(top.promptInjection),
          communication_risk: num(top.communicationRisk),
          systemic_risk: num(top.systemicRisk),
        },
      } : undefined;
      const workspaces = workspaceRows.map((row) => ({
        workspacePath: String(row.resolvedWorkspacePath ?? ''),
        sessionCount: num(row.sessionCount),
        totalRiskScore: num(row.totalRiskScore),
        worstSeverityRank: num(row.worstSeverityRank),
      }));
      return { countsApproximate: true, dimensions, buckets: bucketRows, topSession, workspaces };
    } catch (error) {
      console.error('[clickhouse] dashboard window aggregation failed:', (error as Error).message);
      return null;
    } finally {
      release();
    }
  }

  /** Query durable event history. Identity visibility is deliberately applied by the service
   * after current human-review metadata is resolved; a mutable review decision must never be
   * baked into this immutable evidence query. */
  async searchEvents(input: StoredEventQuery): Promise<JudgedEvent[] | null> {
    if (!this.client) return null;
    const sampleConditions: string[] = [];
    const latestConditions: string[] = [];
    const activeMutableColumns: string[] = [];
    const queryParams: Record<string, string | number> = { since: input.sinceMs, until: input.untilMs };
    const stableFields: Array<[keyof StoredEventQuery, string]> = [
      ['eventId', 'eventId'],
      ['sourceId', 'sourceId'],
      ['collectorId', 'collectorId'],
      ['agentId', 'agentId'],
      ['agentInstanceId', 'agentInstanceKey'],
      ['sessionId', 'sessionId'],
      ['workspacePath', 'workspacePath'],
      ['traceId', 'traceId'],
      ['runId', 'runId'],
      ['eventKind', 'eventKind'],
      ['eventCategory', 'eventCategory'],
    ];
    const mutableFields: Array<[keyof StoredEventQuery, string]> = [
      ['verdict', 'verdict'],
      ['tier', 'tier'],
    ];
    for (const [key, column] of stableFields) {
      const value = input[key];
      if (typeof value !== 'string' || !value.trim()) continue;
      sampleConditions.push(`${column} = {${String(key)}:String}`);
      queryParams[String(key)] = value.trim();
    }
    // Stable predicates are applied before lifecycle revision collapse. Keep the generic name for
    // compatibility with the durable-query contract checks while retaining the late-materialized
    // split between stable and mutable filters.
    const conditions = sampleConditions;
    if (input.monitoredOnly) conditions.push('agentMonitored = 1');
    for (const [key, column] of mutableFields) {
      const value = input[key];
      if (typeof value !== 'string' || !value.trim()) continue;
      latestConditions.push(`${column} = {${String(key)}:String}`);
      activeMutableColumns.push(column);
      queryParams[String(key)] = value.trim();
    }
    const rowLimit = Math.max(1, Math.min(MAX_DURABLE_EVENT_SEARCH_ROWS, Math.round(input.limit)));
    queryParams.limit = rowLimit;
    queryParams.scanLimit = Math.min(300_000, Math.max(rowLimit * 3, latestConditions.length ? 15_000 : 0));
    const queryKey = JSON.stringify(queryParams);
    const current = this.eventSearchInFlight;
    if (current) {
      if (current.key !== queryKey) return null;
      const shared = await current.value;
      return shared ? [...shared] : null;
    }
    const release = this.tryAcquireWideEventReadSlot();
    if (!release) return null;
    const client = this.client;
    const value = (async (): Promise<JudgedEvent[] | null> => {
      try {
        const rs = await client.query({
          // Sort only narrow candidate columns, then use ClickHouse's physical row locators to
          // fetch the selected full revisions. This preserves primary-key pruning and lifecycle
          // semantics without making rawPreview/attributes/process part of the Top-N workspace.
          // Verdict and tier can change between revisions, so filter them only after LIMIT 1 BY.
          query: `
            SELECT e.*
            FROM ${TABLE} AS e
            PREWHERE
              e.at >= {since:UInt64}
              AND e.at <= {until:UInt64}
              AND tuple(e.at, e._part, e._part_offset) IN (
                SELECT at, selectedPart, selectedPartOffset
                FROM (
                  SELECT *
                  FROM (
                    SELECT
                      eventId,
                      at,
                      decisionUpdatedAt,
                      _part AS selectedPart,
                      _part_offset AS selectedPartOffset
                      ${activeMutableColumns.length ? `, ${activeMutableColumns.join(', ')}` : ''}
                    FROM ${TABLE}
                    PREWHERE at >= {since:UInt64} AND at <= {until:UInt64}
                    ${sampleConditions.length ? `WHERE ${sampleConditions.join(' AND ')}` : ''}
                    ORDER BY at DESC
                    LIMIT {scanLimit:UInt32} WITH TIES
                  )
                  ORDER BY at DESC, decisionUpdatedAt DESC
                  LIMIT 1 BY eventId
                )
                ${latestConditions.length ? `WHERE ${latestConditions.join(' AND ')}` : ''}
                ORDER BY at DESC, decisionUpdatedAt DESC
                LIMIT {limit:UInt32}
              )
            ORDER BY e.at DESC, e.decisionUpdatedAt DESC
            LIMIT {limit:UInt32}`,
          query_params: queryParams,
          clickhouse_settings: BOUNDED_EVENT_SEARCH_READ_SETTINGS,
          format: 'JSONEachRow',
        });
        const rows = (await rs.json()) as Array<Record<string, unknown>>;
        const latest = new Map<string, JudgedEvent>();
        for (const row of rows) {
          const event = fromRow(row);
          if (!latest.has(event.eventId)) latest.set(event.eventId, event);
        }
        return [...latest.values()].sort((a, b) => b.at - a.at);
      } catch (err) {
        console.error('[clickhouse] event search failed:', (err as Error).message);
        return null;
      }
    })();
    this.eventSearchInFlight = { key: queryKey, value };
    try {
      const rows = await value;
      return rows ? [...rows] : null;
    } finally {
      if (this.eventSearchInFlight?.value === value) this.eventSearchInFlight = undefined;
      release();
    }
  }

  /** Return durable latest-per-event facts with an explicit completeness marker. The optimized
   * late-materialized search remains the single query implementation; one extra row supplies the
   * bounded pagination signal without loading the full historical result. */
  async searchEventsPage(input: StoredEventQuery): Promise<StoredEventSearchResult> {
    const rowLimit = Math.max(1, Math.min(MAX_DURABLE_EVENT_SEARCH_ROWS, Math.round(input.limit)));
    const events = await this.searchEvents({ ...input, limit: Math.min(MAX_DURABLE_EVENT_SEARCH_ROWS, rowLimit + 1) });
    if (!events) {
      return {
        events: [],
        hasMore: false,
        committedCutoffMs: this.committedCutoffMs(),
        unavailable: true,
      };
    }
    return {
      events: events.slice(0, rowLimit),
      hasMore: events.length > rowLimit,
      committedCutoffMs: this.committedCutoffMs(),
    };
  }

  async agentWindowFacts(
    sinceMs: number,
    untilMs: number,
    monitoredOnly: boolean,
    excludedEventIds: string[] = [],
  ): Promise<StoredAgentWindowFact[] | null> {
    if (!this.client || !this.ready) return null;
    const monitoredClause = monitoredOnly
      ? 'AND agentMonitored = 1'
      : '';
    const latestEvents = `
      SELECT
        eventId,
        argMax(at, tuple(decisionRevision, decisionUpdatedAt, at)) AS eventAt,
        argMax(eventKind, tuple(decisionRevision, decisionUpdatedAt, at)) AS eventKind,
        argMax(eventCategory, tuple(decisionRevision, decisionUpdatedAt, at)) AS eventCategory,
        argMax(source, tuple(decisionRevision, decisionUpdatedAt, at)) AS source,
        argMax(agentId, tuple(decisionRevision, decisionUpdatedAt, at)) AS agentId,
        argMax(workspacePath, tuple(decisionRevision, decisionUpdatedAt, at)) AS workspacePath,
        argMax(sessionId, tuple(decisionRevision, decisionUpdatedAt, at)) AS sessionId,
        argMax(runId, tuple(decisionRevision, decisionUpdatedAt, at)) AS runId,
        argMax(traceId, tuple(decisionRevision, decisionUpdatedAt, at)) AS traceId,
        argMax(collectorId, tuple(decisionRevision, decisionUpdatedAt, at)) AS collectorId,
        argMax(verdict, tuple(decisionRevision, decisionUpdatedAt, at)) AS verdict,
        argMax(severity, tuple(decisionRevision, decisionUpdatedAt, at)) AS severity,
        argMax(riskCategory, tuple(decisionRevision, decisionUpdatedAt, at)) AS riskCategory,
        argMax(riskName, tuple(decisionRevision, decisionUpdatedAt, at)) AS riskName,
        argMax(tokenCount, tuple(decisionRevision, decisionUpdatedAt, at)) AS tokenCount,
        argMax(latencyMs, tuple(decisionRevision, decisionUpdatedAt, at)) AS latencyMs,
        argMax(process, tuple(decisionRevision, decisionUpdatedAt, at)) AS process,
        argMax(attribution, tuple(decisionRevision, decisionUpdatedAt, at)) AS attribution,
        argMax(agentIdentityKey, tuple(decisionRevision, decisionUpdatedAt, at)) AS identityKey,
        argMax(agentInstanceKey, tuple(decisionRevision, decisionUpdatedAt, at)) AS instanceKey,
        argMax(agentMonitored, tuple(decisionRevision, decisionUpdatedAt, at)) AS agentMonitored,
        argMax(agentHasPhysicalIdentity, tuple(decisionRevision, decisionUpdatedAt, at)) AS hasPhysicalIdentity,
        argMax(agentHasRootIdentity, tuple(decisionRevision, decisionUpdatedAt, at)) AS hasRootIdentity
      FROM ${TABLE}
      WHERE at >= {since:UInt64} AND at <= {until:UInt64}
        AND eventId NOT IN {excludedEventIds:Array(String)}
      GROUP BY eventId
      HAVING 1 ${monitoredClause}`;
    try {
      const result = await this.client.query({
        query: `
          SELECT
            identityKey,
            min(eventAt) AS firstSeenAt,
            max(eventAt) AS lastSeenAt,
            count() AS eventCount,
            countIf(verdict != 'allow') AS riskyEventCount,
            uniqExact(sessionId) AS sessionCount,
            uniqExact(runId) AS runCount,
            uniqExact(traceId) AS traceCount,
            groupUniqArray(sessionId) AS sessionKeys,
            groupUniqArray(runId) AS runKeys,
            groupUniqArray(traceId) AS traceKeys,
            groupUniqArrayIf(collectorId, collectorId != '') AS collectorKeys,
            countIf(collectorId = '') AS eventsWithoutCollector,
            sum(tokenCount) AS tokenCount,
            sum(latencyMs) AS latencyTotal,
            uniqExact(instanceKey) AS instanceCount,
            groupUniqArray(instanceKey) AS instanceKeys,
            maxIf(
              multiIf(severity = 'critical', 4, severity = 'high', 3, severity = 'medium', 2, severity = 'low', 1, 0),
              verdict != 'allow'
            ) AS worstSeverityRank,
            argMaxIf(riskCategory, eventAt, verdict != 'allow') AS topRiskCategory,
            argMaxIf(riskName, eventAt, verdict != 'allow') AS topRiskName,
            maxIf(eventAt, verdict != 'allow') AS topRiskAt,
            countIf(eventCategory = 'tool') AS toolCount,
            countIf(eventCategory = 'file') AS fileCount,
            countIf(eventCategory = 'network') AS networkCount,
            countIf(eventCategory = 'process') AS processCount,
            countIf(eventCategory = 'llm') AS llmCount,
            countIf(eventCategory = 'security') AS securityCount,
            countIf(eventCategory = 'runtime') AS runtimeCount,
            countIf(eventCategory = 'unknown') AS unknownCount,
            countIf(source = 'observer') AS observerCount,
            countIf(source = 'api') AS apiCount,
            countIf(source = 'synthetic') AS syntheticCount,
            max(hasPhysicalIdentity) AS hasPhysicalIdentity,
            max(hasRootIdentity) AS hasRootIdentity,
            argMax(eventId, eventAt) AS representativeEventId
          FROM (${latestEvents})
          GROUP BY identityKey, instanceKey`,
        query_params: { since: sinceMs, until: untilMs, excludedEventIds },
        format: 'JSONEachRow',
      });
      const rows = await result.json() as Array<Record<string, unknown>>;
      const representativeIds = rows
        .map((row) => String(row.representativeEventId ?? ''))
        .filter(Boolean);
      const representativeEvents = await this.eventsByIds(representativeIds, sinceMs, untilMs);
      const byId = new Map(representativeEvents.map((event) => [event.eventId, event]));
      const num = (value: unknown): number => Number(value) || 0;
      return rows.flatMap((row): StoredAgentWindowFact[] => {
        const representativeEvent = byId.get(String(row.representativeEventId ?? ''));
        if (!representativeEvent) return [];
        const sessionKeys = Array.isArray(row.sessionKeys) ? row.sessionKeys.map(String).filter(Boolean) : [];
        const runKeys = Array.isArray(row.runKeys) ? row.runKeys.map(String).filter(Boolean) : [];
        const traceKeys = Array.isArray(row.traceKeys) ? row.traceKeys.map(String).filter(Boolean) : [];
        const collectorKeys = Array.isArray(row.collectorKeys) ? row.collectorKeys.map(String).filter(Boolean) : [];
        const instanceKeys = Array.isArray(row.instanceKeys) ? row.instanceKeys.map(String).filter(Boolean) : [];
        return [{
          identityKey: String(row.identityKey ?? ''),
          representativeEvent,
          firstSeenAt: num(row.firstSeenAt),
          lastSeenAt: num(row.lastSeenAt),
          eventCount: num(row.eventCount),
          riskyEventCount: num(row.riskyEventCount),
          sessionCount: sessionKeys.length,
          runCount: runKeys.length,
          traceCount: traceKeys.length,
          sessionKeys,
          runKeys,
          traceKeys,
          collectorKeys,
          eventsWithoutCollector: num(row.eventsWithoutCollector),
          tokenCount: num(row.tokenCount),
          latencyTotal: num(row.latencyTotal),
          instanceCount: instanceKeys.length,
          instanceKeys,
          worstSeverityRank: num(row.worstSeverityRank),
          topRiskAt: num(row.topRiskAt) || undefined,
          topRiskCategory: String(row.topRiskCategory ?? '') || undefined,
          topRiskName: String(row.topRiskName ?? '') || undefined,
          eventCategoryCounts: {
            tool: num(row.toolCount),
            file: num(row.fileCount),
            network: num(row.networkCount),
            process: num(row.processCount),
            llm: num(row.llmCount),
            security: num(row.securityCount),
            runtime: num(row.runtimeCount),
            unknown: num(row.unknownCount),
          },
          sourceCounts: {
            observer: num(row.observerCount),
            api: num(row.apiCount),
            synthetic: num(row.syntheticCount),
          },
          hasPhysicalIdentity: Boolean(num(row.hasPhysicalIdentity)),
          hasRootIdentity: Boolean(num(row.hasRootIdentity)),
        }];
      });
    } catch (error) {
      console.error('[clickhouse] agent window aggregation failed:', (error as Error).message);
      return null;
    }
  }

  /**
   * Exact absolute buckets for the stable historical prefix of Agent inventory queries.
   * The bucket dimension lets the API retain closed history across refreshes and invalidate only
   * the event-time bucket touched by a late event or a newer judgment revision.
   */
  async agentWindowBucketFacts(
    sinceMs: number,
    endExclusiveMs: number,
    bucketMs: number,
    monitoredOnly: boolean,
  ): Promise<StoredAgentBucketFact[] | null> {
    if (!this.client || !this.ready) return null;
    const monitoredClause = monitoredOnly ? 'AND agentMonitored = 1' : '';
    try {
      const result = await this.client.query({
        query: `
          SELECT
            intDiv(eventAt, {bucketMs:UInt64}) * {bucketMs:UInt64} AS bucketStartMs,
            identityKey,
            min(eventAt) AS firstSeenAt,
            max(eventAt) AS lastSeenAt,
            count() AS eventCount,
            countIf(verdict != 'allow') AS riskyEventCount,
            groupUniqArray(sessionId) AS sessionKeys,
            groupUniqArray(runId) AS runKeys,
            groupUniqArray(traceId) AS traceKeys,
            groupUniqArrayIf(collectorId, collectorId != '') AS collectorKeys,
            countIf(collectorId = '') AS eventsWithoutCollector,
            sum(tokenCount) AS tokenCount,
            sum(latencyMs) AS latencyTotal,
            groupUniqArray(instanceKey) AS instanceKeys,
            maxIf(
              multiIf(severity = 'critical', 4, severity = 'high', 3, severity = 'medium', 2, severity = 'low', 1, 0),
              verdict != 'allow'
            ) AS worstSeverityRank,
            argMaxIf(riskCategory, eventAt, verdict != 'allow') AS topRiskCategory,
            argMaxIf(riskName, eventAt, verdict != 'allow') AS topRiskName,
            maxIf(eventAt, verdict != 'allow') AS topRiskAt,
            countIf(eventCategory = 'tool') AS toolCount,
            countIf(eventCategory = 'file') AS fileCount,
            countIf(eventCategory = 'network') AS networkCount,
            countIf(eventCategory = 'process') AS processCount,
            countIf(eventCategory = 'llm') AS llmCount,
            countIf(eventCategory = 'security') AS securityCount,
            countIf(eventCategory = 'runtime') AS runtimeCount,
            countIf(eventCategory = 'unknown') AS unknownCount,
            countIf(source = 'observer') AS observerCount,
            countIf(source = 'api') AS apiCount,
            countIf(source = 'synthetic') AS syntheticCount,
            max(hasPhysicalIdentity) AS hasPhysicalIdentity,
            max(hasRootIdentity) AS hasRootIdentity,
            argMax(eventId, eventAt) AS representativeEventId
          FROM (
            SELECT
              eventId,
              argMax(at, tuple(decisionRevision, decisionUpdatedAt, at)) AS eventAt,
              argMax(eventCategory, tuple(decisionRevision, decisionUpdatedAt, at)) AS eventCategory,
              argMax(source, tuple(decisionRevision, decisionUpdatedAt, at)) AS source,
              argMax(sessionId, tuple(decisionRevision, decisionUpdatedAt, at)) AS sessionId,
              argMax(runId, tuple(decisionRevision, decisionUpdatedAt, at)) AS runId,
              argMax(traceId, tuple(decisionRevision, decisionUpdatedAt, at)) AS traceId,
              argMax(collectorId, tuple(decisionRevision, decisionUpdatedAt, at)) AS collectorId,
              argMax(verdict, tuple(decisionRevision, decisionUpdatedAt, at)) AS verdict,
              argMax(severity, tuple(decisionRevision, decisionUpdatedAt, at)) AS severity,
              argMax(riskCategory, tuple(decisionRevision, decisionUpdatedAt, at)) AS riskCategory,
              argMax(riskName, tuple(decisionRevision, decisionUpdatedAt, at)) AS riskName,
              argMax(tokenCount, tuple(decisionRevision, decisionUpdatedAt, at)) AS tokenCount,
              argMax(latencyMs, tuple(decisionRevision, decisionUpdatedAt, at)) AS latencyMs,
              argMax(agentIdentityKey, tuple(decisionRevision, decisionUpdatedAt, at)) AS identityKey,
              argMax(agentInstanceKey, tuple(decisionRevision, decisionUpdatedAt, at)) AS instanceKey,
              argMax(agentMonitored, tuple(decisionRevision, decisionUpdatedAt, at)) AS agentMonitored,
              argMax(agentHasPhysicalIdentity, tuple(decisionRevision, decisionUpdatedAt, at)) AS hasPhysicalIdentity,
              argMax(agentHasRootIdentity, tuple(decisionRevision, decisionUpdatedAt, at)) AS hasRootIdentity
            FROM ${TABLE}
            WHERE at >= {since:UInt64} AND at < {endExclusive:UInt64}
            GROUP BY eventId
            HAVING 1 ${monitoredClause}
          )
          GROUP BY bucketStartMs, identityKey, instanceKey`,
        query_params: {
          since: sinceMs,
          endExclusive: endExclusiveMs,
          bucketMs: Math.max(1, Math.trunc(bucketMs)),
        },
        format: 'JSONEachRow',
      });
      const rows = await result.json() as Array<Record<string, unknown>>;
      const representativeIds = rows
        .map((row) => String(row.representativeEventId ?? ''))
        .filter(Boolean);
      const representativeEvents = await this.eventsByIds(
        representativeIds,
        sinceMs,
        Math.max(sinceMs, endExclusiveMs - 1),
      );
      const byId = new Map(representativeEvents.map((event) => [event.eventId, event]));
      const num = (value: unknown): number => Number(value) || 0;
      return rows.flatMap((row): StoredAgentBucketFact[] => {
        const representativeEvent = byId.get(String(row.representativeEventId ?? ''));
        if (!representativeEvent) return [];
        const sessionKeys = Array.isArray(row.sessionKeys) ? row.sessionKeys.map(String).filter(Boolean) : [];
        const runKeys = Array.isArray(row.runKeys) ? row.runKeys.map(String).filter(Boolean) : [];
        const traceKeys = Array.isArray(row.traceKeys) ? row.traceKeys.map(String).filter(Boolean) : [];
        const collectorKeys = Array.isArray(row.collectorKeys) ? row.collectorKeys.map(String).filter(Boolean) : [];
        const instanceKeys = Array.isArray(row.instanceKeys) ? row.instanceKeys.map(String).filter(Boolean) : [];
        return [{
          bucketStartMs: num(row.bucketStartMs),
          identityKey: String(row.identityKey ?? ''),
          representativeEvent,
          firstSeenAt: num(row.firstSeenAt),
          lastSeenAt: num(row.lastSeenAt),
          eventCount: num(row.eventCount),
          riskyEventCount: num(row.riskyEventCount),
          sessionCount: sessionKeys.length,
          runCount: runKeys.length,
          traceCount: traceKeys.length,
          sessionKeys,
          runKeys,
          traceKeys,
          collectorKeys,
          eventsWithoutCollector: num(row.eventsWithoutCollector),
          tokenCount: num(row.tokenCount),
          latencyTotal: num(row.latencyTotal),
          instanceCount: instanceKeys.length,
          instanceKeys,
          worstSeverityRank: num(row.worstSeverityRank),
          topRiskAt: num(row.topRiskAt) || undefined,
          topRiskCategory: String(row.topRiskCategory ?? '') || undefined,
          topRiskName: String(row.topRiskName ?? '') || undefined,
          eventCategoryCounts: {
            tool: num(row.toolCount),
            file: num(row.fileCount),
            network: num(row.networkCount),
            process: num(row.processCount),
            llm: num(row.llmCount),
            security: num(row.securityCount),
            runtime: num(row.runtimeCount),
            unknown: num(row.unknownCount),
          },
          sourceCounts: {
            observer: num(row.observerCount),
            api: num(row.apiCount),
            synthetic: num(row.syntheticCount),
          },
          hasPhysicalIdentity: Boolean(num(row.hasPhysicalIdentity)),
          hasRootIdentity: Boolean(num(row.hasRootIdentity)),
        }];
      });
    } catch (error) {
      console.error('[clickhouse] agent bucket aggregation failed:', (error as Error).message);
      return null;
    }
  }

  /**
   * Return bounded time-bucket metrics per stable workload identity. Persisted event revisions are
   * collapsed before aggregation and hot event IDs can be excluded, allowing callers to merge the
   * committed interval with an uncommitted hot delta without double counting.
   */
  async agentMetricBucketFacts(
    sinceMs: number,
    untilMs: number,
    bucketCount: number,
    monitoredOnly: boolean,
    excludedEventIds: string[] = [],
  ): Promise<StoredAgentMetricBucketFact[] | null> {
    if (!this.client || !this.ready) return null;
    const buckets = Math.max(1, Math.min(72, Math.round(bucketCount)));
    const bucketMs = Math.max(1, Math.ceil(Math.max(1, untilMs - sinceMs) / buckets));
    const monitoredClause = monitoredOnly ? 'AND agentMonitored = 1' : '';
    try {
      const result = await this.client.query({
        query: `
          SELECT
            least({bucketCount:UInt32} - 1, intDiv(eventAt - {since:UInt64}, {bucketMs:UInt64})) AS bucketIndex,
            identityKey,
            instanceKey,
            count() AS eventCount,
            countIf(verdict != 'allow') AS riskyEventCount,
            countIf(verdict = 'block') AS blockedCount,
            countIf(verdict = 'escalate') AS escalatedCount,
            countIf(eventCategory = 'tool') AS toolCount,
            countIf(eventCategory = 'file') AS fileCount,
            countIf(eventCategory = 'network') AS networkCount,
            countIf(eventCategory IN ('process', 'runtime')) AS processCount,
            countIf(eventCategory = 'llm') AS llmCount,
            countIf(tier = 'Rules') AS l1Count,
            countIf(tier = 'Llm') AS l2Count,
            countIf(tier = 'Agent') AS l3Count,
            countIf(decisionStatus = 'failed') AS failedCount,
            countIf(decisionStatus = 'timeout') AS timeoutCount,
            sum(tokenCount) AS tokenCount,
            sum(latencyMs) AS latencyTotal,
            max(riskScore) AS maxRiskScore,
            groupUniqArray(sessionId) AS sessionKeys,
            countIf(eventAt > {recentSince:UInt64}) AS recentEventCount,
            countIf(eventAt > {recentSince:UInt64} AND eventKind IN ('Egress', 'Dns')) AS recentCommCount,
            groupUniqArrayIf(sessionId, eventAt > {recentSince:UInt64}) AS recentSessionKeys,
            argMax(eventId, eventAt) AS representativeEventId
          FROM (
            SELECT
              eventId,
              argMax(at, tuple(decisionRevision, decisionUpdatedAt, at)) AS eventAt,
              argMax(eventKind, tuple(decisionRevision, decisionUpdatedAt, at)) AS eventKind,
              argMax(eventCategory, tuple(decisionRevision, decisionUpdatedAt, at)) AS eventCategory,
              argMax(sessionId, tuple(decisionRevision, decisionUpdatedAt, at)) AS sessionId,
              argMax(verdict, tuple(decisionRevision, decisionUpdatedAt, at)) AS verdict,
              argMax(tier, tuple(decisionRevision, decisionUpdatedAt, at)) AS tier,
              argMax(decisionStatus, tuple(decisionRevision, decisionUpdatedAt, at)) AS decisionStatus,
              argMax(tokenCount, tuple(decisionRevision, decisionUpdatedAt, at)) AS tokenCount,
              argMax(latencyMs, tuple(decisionRevision, decisionUpdatedAt, at)) AS latencyMs,
              argMax(riskScore, tuple(decisionRevision, decisionUpdatedAt, at)) AS riskScore,
              argMax(agentIdentityKey, tuple(decisionRevision, decisionUpdatedAt, at)) AS identityKey,
              argMax(agentInstanceKey, tuple(decisionRevision, decisionUpdatedAt, at)) AS instanceKey,
              argMax(agentMonitored, tuple(decisionRevision, decisionUpdatedAt, at)) AS agentMonitored
            FROM ${TABLE}
            WHERE at >= {since:UInt64} AND at <= {until:UInt64}
              AND eventId NOT IN {excludedEventIds:Array(String)}
            GROUP BY eventId
            HAVING 1 ${monitoredClause}
          )
          GROUP BY bucketIndex, identityKey, instanceKey
          ORDER BY bucketIndex, identityKey, instanceKey`,
        query_params: {
          since: sinceMs,
          until: untilMs,
          recentSince: Math.max(sinceMs, untilMs - 60_000),
          bucketCount: buckets,
          bucketMs,
          excludedEventIds,
        },
        format: 'JSONEachRow',
      });
      const rows = await result.json() as Array<Record<string, unknown>>;
      const representativeIds = rows
        .map((row) => String(row.representativeEventId ?? ''))
        .filter(Boolean);
      const representativeEvents = await this.eventsByIds(representativeIds, sinceMs, untilMs);
      const byId = new Map(representativeEvents.map((event) => [event.eventId, event]));
      const num = (value: unknown): number => Number(value) || 0;
      return rows.flatMap((row): StoredAgentMetricBucketFact[] => {
        const representativeEvent = byId.get(String(row.representativeEventId ?? ''));
        if (!representativeEvent) return [];
        return [{
          bucketIndex: num(row.bucketIndex),
          identityKey: String(row.identityKey ?? ''),
          representativeEvent,
          eventCount: num(row.eventCount),
          riskyEventCount: num(row.riskyEventCount),
          blockedCount: num(row.blockedCount),
          escalatedCount: num(row.escalatedCount),
          toolCount: num(row.toolCount),
          fileCount: num(row.fileCount),
          networkCount: num(row.networkCount),
          processCount: num(row.processCount),
          llmCount: num(row.llmCount),
          l1Count: num(row.l1Count),
          l2Count: num(row.l2Count),
          l3Count: num(row.l3Count),
          failedCount: num(row.failedCount),
          timeoutCount: num(row.timeoutCount),
          tokenCount: num(row.tokenCount),
          latencyTotal: num(row.latencyTotal),
          maxRiskScore: num(row.maxRiskScore),
          sessionKeys: Array.isArray(row.sessionKeys) ? row.sessionKeys.map(String).filter(Boolean) : [],
          recentEventCount: num(row.recentEventCount),
          recentCommCount: num(row.recentCommCount),
          recentSessionKeys: Array.isArray(row.recentSessionKeys)
            ? row.recentSessionKeys.map(String).filter(Boolean)
            : [],
        }];
      });
    } catch (error) {
      console.error('[clickhouse] agent metric bucket query failed:', (error as Error).message);
      return null;
    }
  }

  async workspaceWindowFacts(
    sinceMs: number,
    untilMs: number,
    monitoredOnly: boolean,
    excludedEventIds: string[] = [],
  ): Promise<StoredWorkspaceWindowFact[] | null> {
    if (!this.client || !this.ready) return null;
    const monitoredClause = monitoredOnly ? 'AND agentMonitored = 1' : '';
    try {
      const result = await this.client.query({
        query: `
          SELECT
            workspacePath,
            min(eventAt) AS firstSeenAt,
            max(eventAt) AS lastSeenAt,
            count() AS eventCount,
            countIf(verdict != 'allow') AS riskyEventCount,
            groupUniqArray(sessionId) AS sessionKeys,
            groupUniqArray(runId) AS runKeys,
            groupUniqArray(traceId) AS traceKeys,
            groupUniqArrayIf(collectorId, collectorId != '') AS collectorKeys,
            sum(tokenCount) AS tokenCount,
            sum(latencyMs) AS latencyTotal,
            maxIf(
              multiIf(severity = 'critical', 4, severity = 'high', 3, severity = 'medium', 2, severity = 'low', 1, 0),
              verdict != 'allow'
            ) AS worstSeverityRank,
            argMaxIf(riskCategory, eventAt, verdict != 'allow') AS topRiskCategory,
            argMaxIf(riskName, eventAt, verdict != 'allow') AS topRiskName,
            maxIf(eventAt, verdict != 'allow') AS topRiskAt,
            argMax(eventId, eventAt) AS representativeEventId
          FROM (
            SELECT
              eventId,
              argMax(at, tuple(decisionRevision, decisionUpdatedAt, at)) AS eventAt,
              argMax(
                if(
                  JSONExtractBool(attribution, 'monitored')
                    AND JSONExtractString(process, 'cwd') != '',
                  JSONExtractString(process, 'cwd'),
                  workspacePath
                ),
                tuple(decisionRevision, decisionUpdatedAt, at)
              ) AS workspacePath,
              argMax(sessionId, tuple(decisionRevision, decisionUpdatedAt, at)) AS sessionId,
              argMax(runId, tuple(decisionRevision, decisionUpdatedAt, at)) AS runId,
              argMax(traceId, tuple(decisionRevision, decisionUpdatedAt, at)) AS traceId,
              argMax(collectorId, tuple(decisionRevision, decisionUpdatedAt, at)) AS collectorId,
              argMax(verdict, tuple(decisionRevision, decisionUpdatedAt, at)) AS verdict,
              argMax(severity, tuple(decisionRevision, decisionUpdatedAt, at)) AS severity,
              argMax(riskCategory, tuple(decisionRevision, decisionUpdatedAt, at)) AS riskCategory,
              argMax(riskName, tuple(decisionRevision, decisionUpdatedAt, at)) AS riskName,
              argMax(tokenCount, tuple(decisionRevision, decisionUpdatedAt, at)) AS tokenCount,
              argMax(latencyMs, tuple(decisionRevision, decisionUpdatedAt, at)) AS latencyMs,
              argMax(agentMonitored, tuple(decisionRevision, decisionUpdatedAt, at)) AS agentMonitored
            FROM ${TABLE}
            WHERE at >= {since:UInt64} AND at <= {until:UInt64}
              AND eventId NOT IN {excludedEventIds:Array(String)}
            GROUP BY eventId
            HAVING 1 ${monitoredClause}
          )
          GROUP BY workspacePath
          ORDER BY lastSeenAt DESC`,
        query_params: { since: sinceMs, until: untilMs, excludedEventIds },
        format: 'JSONEachRow',
      });
      const rows = await result.json() as Array<Record<string, unknown>>;
      const representativeIds = rows.map((row) => String(row.representativeEventId ?? '')).filter(Boolean);
      const representativeEvents = await this.eventsByIds(representativeIds, sinceMs, untilMs);
      const byId = new Map(representativeEvents.map((event) => [event.eventId, event]));
      const strings = (value: unknown): string[] =>
        Array.isArray(value) ? value.map(String).filter(Boolean) : [];
      const num = (value: unknown): number => Number(value) || 0;
      return rows.flatMap((row): StoredWorkspaceWindowFact[] => {
        const representativeEvent = byId.get(String(row.representativeEventId ?? ''));
        if (!representativeEvent) return [];
        return [{
          workspacePath: String(row.workspacePath ?? ''),
          representativeEvent,
          firstSeenAt: num(row.firstSeenAt),
          lastSeenAt: num(row.lastSeenAt),
          eventCount: num(row.eventCount),
          riskyEventCount: num(row.riskyEventCount),
          sessionKeys: strings(row.sessionKeys),
          runKeys: strings(row.runKeys),
          traceKeys: strings(row.traceKeys),
          collectorKeys: strings(row.collectorKeys),
          tokenCount: num(row.tokenCount),
          latencyTotal: num(row.latencyTotal),
          worstSeverityRank: num(row.worstSeverityRank),
          topRiskAt: num(row.topRiskAt) || undefined,
          topRiskCategory: String(row.topRiskCategory ?? '') || undefined,
          topRiskName: String(row.topRiskName ?? '') || undefined,
        }];
      });
    } catch (error) {
      console.error('[clickhouse] workspace window aggregation failed:', (error as Error).message);
      return null;
    }
  }

  /**
   * Return exact absolute workspace buckets for a closed persisted interval. These buckets are
   * reusable across Dashboard refreshes; commit-journal changes invalidate the affected bucket.
   */
  async workspaceWindowBucketFacts(
    sinceMs: number,
    endExclusiveMs: number,
    bucketMs: number,
    monitoredOnly: boolean,
  ): Promise<StoredWorkspaceBucketFact[] | null> {
    if (!this.client || !this.ready) return null;
    const monitoredClause = monitoredOnly ? 'AND agentMonitored = 1' : '';
    try {
      const result = await this.client.query({
        query: `
          SELECT
            intDiv(eventAt, {bucketMs:UInt64}) * {bucketMs:UInt64} AS bucketStartMs,
            workspacePath,
            min(eventAt) AS firstSeenAt,
            max(eventAt) AS lastSeenAt,
            count() AS eventCount,
            countIf(verdict != 'allow') AS riskyEventCount,
            groupUniqArray(sessionId) AS sessionKeys,
            groupUniqArray(runId) AS runKeys,
            groupUniqArray(traceId) AS traceKeys,
            groupUniqArrayIf(collectorId, collectorId != '') AS collectorKeys,
            sum(tokenCount) AS tokenCount,
            sum(latencyMs) AS latencyTotal,
            maxIf(
              multiIf(severity = 'critical', 4, severity = 'high', 3, severity = 'medium', 2, severity = 'low', 1, 0),
              verdict != 'allow'
            ) AS worstSeverityRank,
            argMaxIf(riskCategory, eventAt, verdict != 'allow') AS topRiskCategory,
            argMaxIf(riskName, eventAt, verdict != 'allow') AS topRiskName,
            maxIf(eventAt, verdict != 'allow') AS topRiskAt,
            argMax(eventId, eventAt) AS representativeEventId
          FROM (
            SELECT
              eventId,
              argMax(at, tuple(decisionRevision, decisionUpdatedAt, at)) AS eventAt,
              argMax(
                if(
                  JSONExtractBool(attribution, 'monitored')
                    AND JSONExtractString(process, 'cwd') != '',
                  JSONExtractString(process, 'cwd'),
                  workspacePath
                ),
                tuple(decisionRevision, decisionUpdatedAt, at)
              ) AS workspacePath,
              argMax(sessionId, tuple(decisionRevision, decisionUpdatedAt, at)) AS sessionId,
              argMax(runId, tuple(decisionRevision, decisionUpdatedAt, at)) AS runId,
              argMax(traceId, tuple(decisionRevision, decisionUpdatedAt, at)) AS traceId,
              argMax(collectorId, tuple(decisionRevision, decisionUpdatedAt, at)) AS collectorId,
              argMax(verdict, tuple(decisionRevision, decisionUpdatedAt, at)) AS verdict,
              argMax(severity, tuple(decisionRevision, decisionUpdatedAt, at)) AS severity,
              argMax(riskCategory, tuple(decisionRevision, decisionUpdatedAt, at)) AS riskCategory,
              argMax(riskName, tuple(decisionRevision, decisionUpdatedAt, at)) AS riskName,
              argMax(tokenCount, tuple(decisionRevision, decisionUpdatedAt, at)) AS tokenCount,
              argMax(latencyMs, tuple(decisionRevision, decisionUpdatedAt, at)) AS latencyMs,
              argMax(agentMonitored, tuple(decisionRevision, decisionUpdatedAt, at)) AS agentMonitored
            FROM ${TABLE}
            WHERE at >= {since:UInt64} AND at < {endExclusive:UInt64}
            GROUP BY eventId
            HAVING 1 ${monitoredClause}
          )
          GROUP BY bucketStartMs, workspacePath
          ORDER BY bucketStartMs, workspacePath`,
        query_params: {
          since: sinceMs,
          endExclusive: endExclusiveMs,
          bucketMs: Math.max(1, Math.round(bucketMs)),
        },
        format: 'JSONEachRow',
      });
      const rows = await result.json() as Array<Record<string, unknown>>;
      const representativeIds = rows.map((row) => String(row.representativeEventId ?? '')).filter(Boolean);
      const representativeEvents = await this.eventsByIds(
        representativeIds,
        sinceMs,
        Math.max(sinceMs, endExclusiveMs - 1),
      );
      const byId = new Map(representativeEvents.map((event) => [event.eventId, event]));
      const strings = (value: unknown): string[] =>
        Array.isArray(value) ? value.map(String).filter(Boolean) : [];
      const num = (value: unknown): number => Number(value) || 0;
      return rows.flatMap((row): StoredWorkspaceBucketFact[] => {
        const representativeEvent = byId.get(String(row.representativeEventId ?? ''));
        if (!representativeEvent) return [];
        return [{
          bucketStartMs: num(row.bucketStartMs),
          workspacePath: String(row.workspacePath ?? ''),
          representativeEvent,
          firstSeenAt: num(row.firstSeenAt),
          lastSeenAt: num(row.lastSeenAt),
          eventCount: num(row.eventCount),
          riskyEventCount: num(row.riskyEventCount),
          sessionKeys: strings(row.sessionKeys),
          runKeys: strings(row.runKeys),
          traceKeys: strings(row.traceKeys),
          collectorKeys: strings(row.collectorKeys),
          tokenCount: num(row.tokenCount),
          latencyTotal: num(row.latencyTotal),
          worstSeverityRank: num(row.worstSeverityRank),
          topRiskAt: num(row.topRiskAt) || undefined,
          topRiskCategory: String(row.topRiskCategory ?? '') || undefined,
          topRiskName: String(row.topRiskName ?? '') || undefined,
        }];
      });
    } catch (error) {
      console.error('[clickhouse] workspace bucket aggregation failed:', (error as Error).message);
      return null;
    }
  }

  /**
   * Return persisted topology facts grouped by stable workload, relationship target and risk
   * category. Raw events remain the evidence source; this query only bounds the amount of data
   * transferred to the API by aggregating exact counters inside ClickHouse.
   */
  async topologyWindowFacts(
    sinceMs: number,
    untilMs: number,
    excludedEventIds: string[] = [],
  ): Promise<StoredTopologyWindowFact[] | null> {
    if (!this.client || !this.ready) return null;
    try {
      const result = await this.client.query({
        query: `
          SELECT
            identityKey,
            min(eventAt) AS firstSeenAt,
            max(eventAt) AS lastSeenAt,
            count() AS eventCount,
            countIf(verdict != 'allow') AS riskyEventCount,
            maxIf(
              multiIf(severity = 'critical', 4, severity = 'high', 3, severity = 'medium', 2, severity = 'low', 1, 0),
              verdict != 'allow'
            ) AS worstSeverityRank,
            riskCategory,
            argMax(riskName, eventAt) AS riskName,
            argMax(eventId, eventAt) AS representativeEventId
          FROM (
            SELECT
              eventId,
              argMax(at, tuple(decisionRevision, decisionUpdatedAt, at)) AS eventAt,
              argMax(eventKind, tuple(decisionRevision, decisionUpdatedAt, at)) AS eventKind,
              argMax(eventCategory, tuple(decisionRevision, decisionUpdatedAt, at)) AS eventCategory,
              argMax(subject, tuple(decisionRevision, decisionUpdatedAt, at)) AS subject,
              argMax(actionTarget, tuple(decisionRevision, decisionUpdatedAt, at)) AS actionTarget,
              argMax(agentId, tuple(decisionRevision, decisionUpdatedAt, at)) AS agentId,
              argMax(workspacePath, tuple(decisionRevision, decisionUpdatedAt, at)) AS workspacePath,
              argMax(verdict, tuple(decisionRevision, decisionUpdatedAt, at)) AS verdict,
              argMax(severity, tuple(decisionRevision, decisionUpdatedAt, at)) AS severity,
              argMax(riskCategory, tuple(decisionRevision, decisionUpdatedAt, at)) AS riskCategory,
              argMax(riskName, tuple(decisionRevision, decisionUpdatedAt, at)) AS riskName,
              argMax(agentIdentityKey, tuple(decisionRevision, decisionUpdatedAt, at)) AS identityKey,
              argMax(agentInstanceKey, tuple(decisionRevision, decisionUpdatedAt, at)) AS instanceKey
            FROM ${TABLE}
            WHERE at >= {since:UInt64} AND at <= {until:UInt64}
              AND eventId NOT IN {excludedEventIds:Array(String)}
            GROUP BY eventId
          )
          GROUP BY
            identityKey,
            instanceKey,
            workspacePath,
            eventKind,
            eventCategory,
            subject,
            actionTarget,
            riskCategory`,
        query_params: { since: sinceMs, until: untilMs, excludedEventIds },
        format: 'JSONEachRow',
      });
      const rows = await result.json() as Array<Record<string, unknown>>;
      const representativeIds = rows
        .map((row) => String(row.representativeEventId ?? ''))
        .filter(Boolean);
      const representativeEvents = await this.eventsByIds(representativeIds, sinceMs, untilMs);
      const byId = new Map(representativeEvents.map((event) => [event.eventId, event]));
      const num = (value: unknown): number => Number(value) || 0;
      return rows.flatMap((row): StoredTopologyWindowFact[] => {
        const representativeEvent = byId.get(String(row.representativeEventId ?? ''));
        if (!representativeEvent) return [];
        return [{
          identityKey: String(row.identityKey ?? ''),
          representativeEvent,
          firstSeenAt: num(row.firstSeenAt),
          lastSeenAt: num(row.lastSeenAt),
          eventCount: num(row.eventCount),
          riskyEventCount: num(row.riskyEventCount),
          worstSeverityRank: num(row.worstSeverityRank),
          riskCategory: String(row.riskCategory ?? '') || undefined,
          riskName: String(row.riskName ?? '') || undefined,
        }];
      });
    } catch (error) {
      console.error('[clickhouse] topology window aggregation failed:', (error as Error).message);
      return null;
    }
  }

  /** Absolute relationship buckets used by the cross-refresh topology cache. */
  async topologyWindowBucketFacts(
    sinceMs: number,
    endExclusiveMs: number,
    bucketMs: number,
  ): Promise<StoredTopologyBucketFact[] | null> {
    if (!this.client || !this.ready) return null;
    try {
      const result = await this.client.query({
        query: `
          SELECT
            intDiv(eventAt, {bucketMs:UInt64}) * {bucketMs:UInt64} AS bucketStartMs,
            identityKey,
            min(eventAt) AS firstSeenAt,
            max(eventAt) AS lastSeenAt,
            count() AS eventCount,
            countIf(verdict != 'allow') AS riskyEventCount,
            maxIf(
              multiIf(severity = 'critical', 4, severity = 'high', 3, severity = 'medium', 2, severity = 'low', 1, 0),
              verdict != 'allow'
            ) AS worstSeverityRank,
            riskCategory,
            argMax(riskName, eventAt) AS riskName,
            argMax(eventId, eventAt) AS representativeEventId
          FROM (
            SELECT
              eventId,
              argMax(at, tuple(decisionRevision, decisionUpdatedAt, at)) AS eventAt,
              argMax(eventKind, tuple(decisionRevision, decisionUpdatedAt, at)) AS eventKind,
              argMax(eventCategory, tuple(decisionRevision, decisionUpdatedAt, at)) AS eventCategory,
              argMax(subject, tuple(decisionRevision, decisionUpdatedAt, at)) AS subject,
              argMax(actionTarget, tuple(decisionRevision, decisionUpdatedAt, at)) AS actionTarget,
              argMax(workspacePath, tuple(decisionRevision, decisionUpdatedAt, at)) AS workspacePath,
              argMax(verdict, tuple(decisionRevision, decisionUpdatedAt, at)) AS verdict,
              argMax(severity, tuple(decisionRevision, decisionUpdatedAt, at)) AS severity,
              argMax(riskCategory, tuple(decisionRevision, decisionUpdatedAt, at)) AS riskCategory,
              argMax(riskName, tuple(decisionRevision, decisionUpdatedAt, at)) AS riskName,
              argMax(agentIdentityKey, tuple(decisionRevision, decisionUpdatedAt, at)) AS identityKey,
              argMax(agentInstanceKey, tuple(decisionRevision, decisionUpdatedAt, at)) AS instanceKey
            FROM ${TABLE}
            WHERE at >= {since:UInt64} AND at < {endExclusive:UInt64}
            GROUP BY eventId
          )
          GROUP BY
            bucketStartMs,
            identityKey,
            instanceKey,
            workspacePath,
            eventKind,
            eventCategory,
            subject,
            actionTarget,
            riskCategory`,
        query_params: {
          since: sinceMs,
          endExclusive: endExclusiveMs,
          bucketMs: Math.max(1, Math.trunc(bucketMs)),
        },
        format: 'JSONEachRow',
      });
      const rows = await result.json() as Array<Record<string, unknown>>;
      const representativeIds = rows
        .map((row) => String(row.representativeEventId ?? ''))
        .filter(Boolean);
      const representativeEvents = await this.eventsByIds(
        representativeIds,
        sinceMs,
        Math.max(sinceMs, endExclusiveMs - 1),
      );
      const byId = new Map(representativeEvents.map((event) => [event.eventId, event]));
      const num = (value: unknown): number => Number(value) || 0;
      return rows.flatMap((row): StoredTopologyBucketFact[] => {
        const representativeEvent = byId.get(String(row.representativeEventId ?? ''));
        if (!representativeEvent) return [];
        return [{
          bucketStartMs: num(row.bucketStartMs),
          identityKey: String(row.identityKey ?? ''),
          representativeEvent,
          firstSeenAt: num(row.firstSeenAt),
          lastSeenAt: num(row.lastSeenAt),
          eventCount: num(row.eventCount),
          riskyEventCount: num(row.riskyEventCount),
          worstSeverityRank: num(row.worstSeverityRank),
          riskCategory: String(row.riskCategory ?? '') || undefined,
          riskName: String(row.riskName ?? '') || undefined,
        }];
      });
    } catch (error) {
      console.error('[clickhouse] topology bucket aggregation failed:', (error as Error).message);
      return null;
    }
  }

  private async eventsByIds(eventIds: string[], sinceMs?: number, untilMs?: number): Promise<JudgedEvent[]> {
    if (!this.client || eventIds.length === 0) return [];
    const timeClause = sinceMs === undefined || untilMs === undefined
      ? ''
      : 'AND at >= {since:UInt64} AND at <= {until:UInt64}';
    const result = await this.client.query({
      query: `
        SELECT *
        FROM (
          SELECT *
          FROM ${TABLE}
          WHERE eventId IN {eventIds:Array(String)}
            ${timeClause}
          ORDER BY decisionRevision DESC, decisionUpdatedAt DESC, at DESC
          LIMIT 1 BY eventId
        )`,
      query_params: { eventIds, since: sinceMs ?? 0, until: untilMs ?? Number.MAX_SAFE_INTEGER },
      format: 'JSONEachRow',
    });
    return (await result.json() as Array<Record<string, unknown>>).map(fromRow);
  }

  committedCutoffMs(): number | undefined {
    // This is an observed durable high-water mark, not an event-time watermark. While a batch is
    // buffered, retrying, or in flight, omit it. Readers retain an overlap and deduplicate stable
    // eventId/revision facts because late collector events can still fall below this timestamp.
    if (
      this.buf.length > 0 ||
      this.collectorHeartbeatBuf.length > 0 ||
      this.flushInFlight ||
      this.immediateWritesInFlight > 0
    ) return undefined;
    return this.committedThroughMs;
  }

  committedProgress(): CommittedSourceProgress[] {
    return [...this.committedSourceProgress.values()]
      .map((entry) => ({ ...entry }))
      .sort((left, right) =>
        (left.sourceId ?? '').localeCompare(right.sourceId ?? '') ||
        (left.collectorId ?? '').localeCompare(right.collectorId ?? ''),
      );
  }

  private noteCommittedRows(rows: Row[]): void {
    const committedAtMs = Date.now();
    for (const row of rows) {
      const sourceId = row.sourceId || undefined;
      const collectorId = row.collectorId || undefined;
      const key = `${sourceId ?? ''}\u0000${collectorId ?? ''}`;
      const previous = this.committedSourceProgress.get(key);
      this.committedSourceProgress.set(key, {
        sourceId,
        collectorId,
        committedEventTimeMs: Math.max(previous?.committedEventTimeMs ?? 0, Number(row.at) || 0),
        committedAtMs,
      });
    }
  }

  /** Load the persisted judge policy (the singleton config row), or null if none/unreachable. */
  async loadConfig(): Promise<PolicyConfig | null> {
    if (!this.client) return null;
    try {
      const rs = await this.client.query({
        query: `SELECT value FROM ${CONFIG_TABLE} FINAL WHERE key = 'policy' LIMIT 1`,
        format: 'JSONEachRow',
      });
      const rows = (await rs.json()) as Array<{ value: string }>;
      return rows.length ? (JSON.parse(rows[0].value) as PolicyConfig) : null;
    } catch (err) {
      console.error('[clickhouse] loadConfig failed:', (err as Error).message);
      return null;
    }
  }

  /** Persist the judge policy (survives restarts). No-op if ClickHouse is unconfigured/down. */
  async saveConfig(config: PolicyConfig): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.insert({
        table: CONFIG_TABLE,
        values: [{ key: 'policy', value: JSON.stringify(config), updated_at: Date.now() }],
        format: 'JSONEachRow',
      });
    } catch (err) {
      console.error('[clickhouse] saveConfig failed:', (err as Error).message);
    }
  }

  async loadIncidentState(): Promise<Record<string, IncidentState>> {
    if (!this.client) return {};
    try {
      const rs = await this.client.query({
        query: `SELECT value FROM ${CONFIG_TABLE} FINAL WHERE key = 'incident_state' LIMIT 1`,
        format: 'JSONEachRow',
      });
      const rows = (await rs.json()) as Array<{ value: string }>;
      return rows.length ? (JSON.parse(rows[0].value) as Record<string, IncidentState>) : {};
    } catch (err) {
      console.error('[clickhouse] loadIncidentState failed:', (err as Error).message);
      return {};
    }
  }

  async saveIncidentState(incidents: Incident[]): Promise<void> {
    if (!this.client) return;
    const state: Record<string, IncidentState> = {};
    for (const i of incidents) {
      if (i.status !== 'open' || i.owner || i.note || i.acknowledgedAt || i.resolvedAt) {
        state[i.incidentId] = {
          incidentId: i.incidentId,
          status: i.status,
          owner: i.owner,
          note: i.note,
          acknowledgedAt: i.acknowledgedAt,
          resolvedAt: i.resolvedAt,
          updatedAt: i.updatedAt,
        };
      }
    }
    try {
      await this.client.insert({
        table: CONFIG_TABLE,
        values: [{ key: 'incident_state', value: JSON.stringify(state), updated_at: Date.now() }],
        format: 'JSONEachRow',
      });
    } catch (err) {
      console.error('[clickhouse] saveIncidentState failed:', (err as Error).message);
    }
  }

  async loadAlertState(): Promise<AlertRecord[]> {
    if (!this.client) return [];
    try {
      const rs = await this.client.query({
        query: `SELECT value FROM ${CONFIG_TABLE} FINAL WHERE key = 'alert_state' LIMIT 1`,
        format: 'JSONEachRow',
      });
      const rows = (await rs.json()) as Array<{ value: string }>;
      return rows.length ? (JSON.parse(rows[0].value) as AlertRecord[]) : [];
    } catch (err) {
      console.error('[clickhouse] loadAlertState failed:', (err as Error).message);
      return [];
    }
  }

  async saveAlertState(alerts: AlertRecord[]): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.insert({
        table: CONFIG_TABLE,
        values: [{ key: 'alert_state', value: JSON.stringify(alerts), updated_at: Date.now() }],
        format: 'JSONEachRow',
      });
    } catch (err) {
      console.error('[clickhouse] saveAlertState failed:', (err as Error).message);
    }
  }

  async loadRemediationState(): Promise<RemediationRecord[]> {
    if (!this.client) return [];
    try {
      const rs = await this.client.query({
        query: `SELECT value FROM ${CONFIG_TABLE} FINAL WHERE key = 'remediation_state' LIMIT 1`,
        format: 'JSONEachRow',
      });
      const rows = (await rs.json()) as Array<{ value: string }>;
      return rows.length ? (JSON.parse(rows[0].value) as RemediationRecord[]) : [];
    } catch (err) {
      console.error('[clickhouse] loadRemediationState failed:', (err as Error).message);
      return [];
    }
  }

  async saveRemediationState(tasks: RemediationRecord[]): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.insert({
        table: CONFIG_TABLE,
        values: [{ key: 'remediation_state', value: JSON.stringify(tasks), updated_at: Date.now() }],
        format: 'JSONEachRow',
      });
    } catch (err) {
      console.error('[clickhouse] saveRemediationState failed:', (err as Error).message);
    }
  }

  async loadAuditLog(): Promise<AuditRecord[]> {
    if (!this.client) return [];
    try {
      const factResult = await this.client.query({
        query: `
          SELECT argMax(payload, ingestedAt) AS payload
          FROM ${AUDIT_FACT_TABLE}
          GROUP BY auditId
          ORDER BY max(at) DESC
          LIMIT 5000`,
        format: 'JSONEachRow',
      });
      const factRows = (await factResult.json()) as Array<{ payload: string }>;
      const facts = factRows.flatMap(({ payload }) => {
        try {
          return [JSON.parse(payload) as AuditRecord];
        } catch {
          return [];
        }
      });
      if (facts.length > 0) {
        return facts.sort((a, b) => a.at - b.at);
      }

      const rs = await this.client.query({
        query: `SELECT value FROM ${CONFIG_TABLE} FINAL WHERE key = 'audit_log' LIMIT 1`,
        format: 'JSONEachRow',
      });
      const rows = (await rs.json()) as Array<{ value: string }>;
      const parsed = rows.length ? (JSON.parse(rows[0].value) as unknown) : [];
      const legacy = Array.isArray(parsed) ? (parsed as AuditRecord[]) : [];
      if (legacy.length > 0) await this.appendAuditFacts(legacy);
      return legacy;
    } catch (err) {
      console.error('[clickhouse] loadAuditLog failed:', (err as Error).message);
      return [];
    }
  }

  async appendAuditFacts(records: AuditRecord[]): Promise<boolean> {
    if (records.length === 0) return true;
    if (!this.client) return false;
    try {
      const ingestedAt = Date.now();
      await this.client.insert({
        table: AUDIT_FACT_TABLE,
        values: records.map((record) => ({
          auditId: record.auditId,
          at: record.at,
          ingestedAt,
          payload: JSON.stringify(record),
        })),
        format: 'JSONEachRow',
      });
      return true;
    } catch (err) {
      console.error('[clickhouse] appendAuditFacts failed:', (err as Error).message);
      return false;
    }
  }

  /** @deprecated Compatibility writer for callers predating append-only audit facts. */
  async saveAuditLog(records: AuditRecord[]): Promise<void> {
    await this.appendAuditFacts(records.slice(-5_000));
  }

  async loadAgentMetadata(): Promise<AgentMetadataRecord[]> {
    if (!this.client) return [];
    try {
      const rs = await this.client.query({
        query: `SELECT key, value FROM ${CONFIG_TABLE} FINAL WHERE key IN ('agent_metadata', 'agent_metadata_v2') ORDER BY key DESC LIMIT 1`,
        format: 'JSONEachRow',
      });
      const rows = (await rs.json()) as Array<{ key: string; value: string }>;
      const parsed = rows.length ? (JSON.parse(rows[0].value) as unknown) : [];
      if (Array.isArray(parsed)) return parsed as AgentMetadataRecord[];
      if (
        parsed &&
        typeof parsed === 'object' &&
        (parsed as { schemaVersion?: unknown }).schemaVersion === 'anysentry.agent_metadata.v2' &&
        Array.isArray((parsed as { assets?: unknown }).assets)
      ) {
        return (parsed as { assets: AgentMetadataRecord[] }).assets;
      }
      return [];
    } catch (err) {
      console.error('[clickhouse] loadAgentMetadata failed:', (err as Error).message);
      return [];
    }
  }

  async saveAgentMetadata(records: AgentMetadataRecord[]): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.insert({
        table: CONFIG_TABLE,
        values: [{
          key: 'agent_metadata_v2',
          value: JSON.stringify({ schemaVersion: 'anysentry.agent_metadata.v2', assets: records }),
          updated_at: Date.now(),
        }],
        format: 'JSONEachRow',
      });
    } catch (err) {
      console.error('[clickhouse] saveAgentMetadata failed:', (err as Error).message);
    }
  }

  async loadIdentityAiReviews(): Promise<IdentityAiReviewRecord[]> {
    if (!this.client) return [];
    try {
      const factResult = await this.client.query({
        query: `
          SELECT argMax(payload, tuple(revision, ingestedAt)) AS payload
          FROM ${IDENTITY_AI_REVIEW_TABLE}
          GROUP BY reviewId
          ORDER BY max(updatedAt) DESC
          LIMIT 1000`,
        format: 'JSONEachRow',
      });
      const factRows = (await factResult.json()) as Array<{ payload: string }>;
      const facts = factRows.flatMap(({ payload }) => {
        try {
          return [JSON.parse(payload) as IdentityAiReviewRecord];
        } catch {
          return [];
        }
      });
      if (facts.length > 0) return facts;

      const rs = await this.client.query({
        query: `SELECT value FROM ${CONFIG_TABLE} FINAL WHERE key = 'identity_ai_reviews' LIMIT 1`,
        format: 'JSONEachRow',
      });
      const rows = (await rs.json()) as Array<{ value: string }>;
      const parsed = rows.length ? (JSON.parse(rows[0].value) as unknown) : [];
      const legacy = Array.isArray(parsed) ? (parsed as IdentityAiReviewRecord[]) : [];
      if (legacy.length > 0) await this.appendIdentityAiReviewRevisions(legacy);
      return legacy;
    } catch (err) {
      console.error('[clickhouse] loadIdentityAiReviews failed:', (err as Error).message);
      return [];
    }
  }

  async appendIdentityAiReviewRevision(record: IdentityAiReviewRecord): Promise<boolean> {
    return this.appendIdentityAiReviewRevisions([record]);
  }

  private async appendIdentityAiReviewRevisions(records: IdentityAiReviewRecord[]): Promise<boolean> {
    if (!this.client || records.length === 0) return false;
    try {
      const ingestedAt = Date.now();
      await this.client.insert({
        table: IDENTITY_AI_REVIEW_TABLE,
        values: records.map((record) => ({
          reviewId: record.reviewId,
          revision: Math.max(1, Math.floor(Number(record.revision) || (record.status === 'running' ? 1 : 2))),
          status: record.status,
          createdAt: Date.parse(record.createdAt) || ingestedAt,
          updatedAt: Date.parse(record.updatedAt ?? record.completedAt ?? record.createdAt) || ingestedAt,
          ingestedAt,
          payload: JSON.stringify(record),
        })),
        format: 'JSONEachRow',
      });
      return true;
    } catch (err) {
      console.error('[clickhouse] appendIdentityAiReviewRevision failed:', (err as Error).message);
      return false;
    }
  }

  /** @deprecated Compatibility writer for callers predating append-only review revisions. */
  async saveIdentityAiReviews(records: IdentityAiReviewRecord[]): Promise<void> {
    await this.appendIdentityAiReviewRevisions(records.slice(-1_000));
  }

  async loadMaintenanceWindows(): Promise<MaintenanceWindowRecord[]> {
    if (!this.client) return [];
    try {
      const rs = await this.client.query({
        query: `SELECT value FROM ${CONFIG_TABLE} FINAL WHERE key = 'maintenance_windows' LIMIT 1`,
        format: 'JSONEachRow',
      });
      const rows = (await rs.json()) as Array<{ value: string }>;
      const parsed = rows.length ? (JSON.parse(rows[0].value) as unknown) : [];
      return Array.isArray(parsed) ? (parsed as MaintenanceWindowRecord[]) : [];
    } catch (err) {
      console.error('[clickhouse] loadMaintenanceWindows failed:', (err as Error).message);
      return [];
    }
  }

  async saveMaintenanceWindows(records: MaintenanceWindowRecord[]): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.insert({
        table: CONFIG_TABLE,
        values: [{ key: 'maintenance_windows', value: JSON.stringify(records), updated_at: Date.now() }],
        format: 'JSONEachRow',
      });
    } catch (err) {
      console.error('[clickhouse] saveMaintenanceWindows failed:', (err as Error).message);
    }
  }

  async loadNotificationState(): Promise<NotificationState> {
    if (!this.client) return { channels: [], routes: [], deliveries: [] };
    try {
      const rs = await this.client.query({
        query: `SELECT value FROM ${CONFIG_TABLE} FINAL WHERE key = 'notification_state' LIMIT 1`,
        format: 'JSONEachRow',
      });
      const rows = (await rs.json()) as Array<{ value: string }>;
      const parsed = rows.length ? (JSON.parse(rows[0].value) as Partial<NotificationState>) : {};
      const legacyDeliveries = Array.isArray(parsed.deliveries) ? parsed.deliveries : [];
      const deliveries = await this.loadNotificationDeliveryFacts();
      if (deliveries.length === 0 && legacyDeliveries.length > 0) {
        await this.appendNotificationDeliveryFacts(legacyDeliveries);
      }
      return {
        channels: Array.isArray(parsed.channels) ? parsed.channels : [],
        routes: Array.isArray(parsed.routes) ? parsed.routes : [],
        deliveries: deliveries.length > 0 ? deliveries : legacyDeliveries,
      };
    } catch (err) {
      console.error('[clickhouse] loadNotificationState failed:', (err as Error).message);
      return { channels: [], routes: [], deliveries: [] };
    }
  }

  async saveNotificationState(state: NotificationState): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.insert({
        table: CONFIG_TABLE,
        // Delivery history is immutable and lives in notification_delivery_facts. This row remains
        // only as the migration copy for mutable channel/route configuration.
        values: [{
          key: 'notification_state',
          value: JSON.stringify({ channels: state.channels, routes: state.routes, deliveries: [] }),
          updated_at: Date.now(),
        }],
        format: 'JSONEachRow',
      });
    } catch (err) {
      console.error('[clickhouse] saveNotificationState failed:', (err as Error).message);
    }
  }

  async loadNotificationDeliveryFacts(limit = 1_000): Promise<NotificationDeliveryRecord[]> {
    if (!this.client) return [];
    try {
      const result = await this.client.query({
        query: `
          SELECT argMax(payload, ingestedAt) AS payload
          FROM ${NOTIFICATION_DELIVERY_TABLE}
          GROUP BY deliveryId
          ORDER BY max(sentAt) DESC
          LIMIT {limit:UInt32}`,
        query_params: { limit: Math.max(1, Math.min(20_000, Math.floor(limit))) },
        format: 'JSONEachRow',
      });
      const rows = (await result.json()) as Array<{ payload: string }>;
      return rows.flatMap(({ payload }) => {
        try {
          return [JSON.parse(payload) as NotificationDeliveryRecord];
        } catch {
          return [];
        }
      });
    } catch (err) {
      console.error('[clickhouse] loadNotificationDeliveryFacts failed:', (err as Error).message);
      return [];
    }
  }

  async appendNotificationDeliveryFacts(records: NotificationDeliveryRecord[]): Promise<boolean> {
    if (records.length === 0) return true;
    if (!this.client) return false;
    try {
      const ingestedAt = Date.now();
      await this.client.insert({
        table: NOTIFICATION_DELIVERY_TABLE,
        values: records.map((record) => ({
          deliveryId: record.deliveryId,
          sentAt: record.sentAt,
          ingestedAt,
          payload: JSON.stringify(record),
        })),
        format: 'JSONEachRow',
      });
      return true;
    } catch (err) {
      console.error('[clickhouse] appendNotificationDeliveryFacts failed:', (err as Error).message);
      return false;
    }
  }

  async loadObjectives(): Promise<ObjectiveRecord[]> {
    if (!this.client) return [];
    try {
      const rs = await this.client.query({
        query: `SELECT value FROM ${CONFIG_TABLE} FINAL WHERE key = 'objective_state' LIMIT 1`,
        format: 'JSONEachRow',
      });
      const rows = (await rs.json()) as Array<{ value: string }>;
      const parsed = rows.length ? (JSON.parse(rows[0].value) as unknown) : [];
      return Array.isArray(parsed) ? (parsed as ObjectiveRecord[]) : [];
    } catch (err) {
      console.error('[clickhouse] loadObjectives failed:', (err as Error).message);
      return [];
    }
  }

  async saveObjectives(records: ObjectiveRecord[]): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.insert({
        table: CONFIG_TABLE,
        values: [{ key: 'objective_state', value: JSON.stringify(records), updated_at: Date.now() }],
        format: 'JSONEachRow',
      });
    } catch (err) {
      console.error('[clickhouse] saveObjectives failed:', (err as Error).message);
    }
  }

  async loadIngestionSources(): Promise<IngestionSourceRecord[]> {
    if (!this.client) return [];
    try {
      const rs = await this.client.query({
        query: `SELECT value FROM ${CONFIG_TABLE} FINAL WHERE key = 'source_state' LIMIT 1`,
        format: 'JSONEachRow',
      });
      const rows = (await rs.json()) as Array<{ value: string }>;
      const parsed = rows.length ? (JSON.parse(rows[0].value) as unknown) : [];
      return Array.isArray(parsed) ? (parsed as IngestionSourceRecord[]) : [];
    } catch (err) {
      console.error('[clickhouse] loadIngestionSources failed:', (err as Error).message);
      return [];
    }
  }

  async saveIngestionSources(records: IngestionSourceRecord[]): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.insert({
        table: CONFIG_TABLE,
        values: [{ key: 'source_state', value: JSON.stringify(records), updated_at: Date.now() }],
        format: 'JSONEachRow',
      });
    } catch (err) {
      console.error('[clickhouse] saveIngestionSources failed:', (err as Error).message);
    }
  }

  async loadCollectorHeartbeats(): Promise<CollectorHeartbeatRecord[]> {
    if (!this.client) return [];
    try {
      const rs = await this.client.query({
        query: `SELECT value FROM ${CONFIG_TABLE} FINAL WHERE key = 'collector_heartbeats' LIMIT 1`,
        format: 'JSONEachRow',
      });
      const rows = (await rs.json()) as Array<{ value: string }>;
      const parsed = rows.length ? (JSON.parse(rows[0].value) as unknown) : [];
      const records = Array.isArray(parsed) ? (parsed as CollectorHeartbeatRecord[]) : [];
      // One-time compatibility bridge from the former config snapshot. Queries deduplicate by
      // collectorId+at, so retrying this after an interrupted startup remains safe.
      if (records.length) {
        const countResult = await this.client.query({
          query: `SELECT count() AS count FROM ${COLLECTOR_HEARTBEAT_TABLE}`,
          format: 'JSONEachRow',
        });
        const countRows = await countResult.json() as Array<{ count?: string | number }>;
        if (Number(countRows[0]?.count ?? 0) === 0) {
          await this.client.insert({
            table: COLLECTOR_HEARTBEAT_TABLE,
            values: records.map((record) => ({
              collectorId: record.collectorId,
              at: record.at,
              payload: JSON.stringify(record),
            })),
            format: 'JSONEachRow',
          });
        }
      }
      return records;
    } catch (err) {
      console.error('[clickhouse] loadCollectorHeartbeats failed:', (err as Error).message);
      return [];
    }
  }

  async saveCollectorHeartbeats(records: CollectorHeartbeatRecord[], abortSignal?: AbortSignal): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.insert({
        table: CONFIG_TABLE,
        values: [{ key: 'collector_heartbeats', value: JSON.stringify(records), updated_at: Date.now() }],
        format: 'JSONEachRow',
        abort_signal: abortSignal,
      });
    } catch (err) {
      console.error('[clickhouse] saveCollectorHeartbeats failed:', (err as Error).message);
    }
  }

  close(): Promise<void> {
    if (this.closeInFlight) return this.closeInFlight;
    // Change the externally visible state before the first await so a concurrent enqueue cannot
    // slip into the shutdown tail after it was sealed.
    this.closed = true;
    this.closing = true;
    this.ready = false;
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = undefined;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    if (this.eventWriteRetryWakeTimer) clearTimeout(this.eventWriteRetryWakeTimer);
    this.eventWriteRetryWakeTimer = undefined;
    this.eventWriteClosingDeadline = this.eventWriteNow() + this.eventWriteCloseDeadlineMs;
    this.wakeEventWriteRetrySleep();
    this.sealBufferedEventBatches(true);
    const value = this.finishClose();
    this.closeInFlight = value;
    return value;
  }

  private async finishClose(): Promise<void> {
    const client = this.client;
    let closeError: Error | undefined;
    try {
      while (
        this.eventWriteBatches.length > 0 &&
        !this.eventWritePermanentError &&
        this.eventWriteNow() < (this.eventWriteClosingDeadline ?? 0)
      ) {
        this.eventWriteBatches[0].retryNotBefore = 0;
        try {
          await this.waitForEventWriteDrainUntilCloseDeadline();
        } catch (error) {
          if (this.eventWritePermanentError) break;
        }
      }

      if (this.eventWriteBatches.length > 0 || this.buf.length > 0) {
        const head = this.eventWriteBatches[0];
        closeError = Object.assign(
          new Error(
            `ClickHouse event writer closed with ${this.eventWriteRows} undrained rows` +
            (head?.lastError ? `: ${head.lastError.message}` : ''),
          ),
          { code: 'ANYSENTRY_CLICKHOUSE_EVENT_SHUTDOWN_UNDRAINED' },
        );
        console.error('[clickhouse] event writer shutdown deadline/terminal failure:', {
          code: (closeError as Error & { code?: string }).code,
          rows: this.eventWriteRows,
          bytes: this.eventWriteBytes,
          oldestBatchAgeMs: head ? Math.max(0, this.eventWriteNow() - head.createdAt) : 0,
          token: head?.token,
          cause: head?.lastError?.message ?? this.eventWritePermanentError?.message,
        });
      }
    } finally {
      this.eventWriteAbortController?.abort('ClickHouse event writer is closing');
      this.wakeEventWriteRetrySleep();
      for (const batch of this.eventWriteBatches) {
        for (const waiter of batch.waiters.splice(0)) {
          waiter.reject(closeError ?? new Error('ClickHouse event writer closed before the direct write completed'));
        }
      }
      // A periodic flush may already own the heartbeat side buffer. Let it finish first, then
      // persist any tail accepted after its snapshot before closing the shared client.
      await this.flushInFlight?.catch((error) => {
        console.error('[clickhouse] collector heartbeat shutdown flush failed:', (error as Error).message);
      });
      const heartbeatValues = this.collectorHeartbeatBuf;
      this.collectorHeartbeatBuf = [];
      if (client && heartbeatValues.length > 0) {
        try {
          await client.insert({
            table: COLLECTOR_HEARTBEAT_TABLE,
            values: heartbeatValues,
            format: 'JSONEachRow',
          });
        } catch (error) {
          this.collectorHeartbeatBuf = [...heartbeatValues, ...this.collectorHeartbeatBuf];
          console.error('[clickhouse] collector heartbeat shutdown insert failed:', (error as Error).message);
        }
      }
      try {
        await client?.close();
      } catch (error) {
        closeError ??= this.asEventWriteError(error);
      }
      this.client = undefined;
      this.eventWriteClosingDeadline = undefined;
    }
    if (closeError) throw closeError;
  }

  private async waitForEventWriteDrainUntilCloseDeadline(): Promise<void> {
    const deadline = this.eventWriteClosingDeadline ?? this.eventWriteNow();
    const remainingMs = Math.max(0, deadline - this.eventWriteNow());
    if (remainingMs === 0) throw new Error('ClickHouse event writer shutdown deadline reached');
    const drain = this.ensureEventWriteDrain();
    // A fake/misbehaving client may ignore AbortSignal. The outer wall-clock timer prevents Nest's
    // shutdown hook from consuming the full Kubernetes grace period before client.close destroys it.
    let timer!: NodeJS.Timeout;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        this.eventWriteAbortController?.abort('ClickHouse event writer shutdown deadline reached');
        reject(new Error('ClickHouse event writer shutdown deadline reached'));
      }, remainingMs);
    });
    try {
      await Promise.race([drain, timeout]);
    } finally {
      clearTimeout(timer);
      // If the outer deadline won, ensure a later rejection from the tracked drain is observed.
      void drain.catch(() => undefined);
    }
  }
}
