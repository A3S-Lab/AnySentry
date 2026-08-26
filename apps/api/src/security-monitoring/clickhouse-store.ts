// Durable event store backed by ClickHouse — the system of record for judged events.
//
// ClickHouse is the durable event and judgment fact store. Historical lists and aggregates query it
// directly; the bounded in-memory ring only contributes uncommitted low-latency facts and fallback
// reads while ClickHouse is unavailable. It must never decide whether historical data still exists.
//
// Connection comes from env (CLICKHOUSE_URL/USER/PASSWORD/DB). If ClickHouse is unreachable the store
// degrades to in-memory-only (the dashboard keeps working; just no durability) rather than crashing.

import { ClickHouseClient, createClient } from '@clickhouse/client';
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import {
  agentIdentityKeyForEvent,
  agentRuntimeInstanceIdForEvent,
  hasDirectAgentRootEvidence,
  isInternalAgentHelperRootEvent,
} from './agent-identity';
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
  commitBatchId String DEFAULT '',
  logicalKeyVersion UInt16 DEFAULT 1,
  eventLogicalKey String DEFAULT '',
  payloadFingerprintVersion UInt16 DEFAULT 1,
  payloadFingerprint String DEFAULT '',
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
  agentSessionKey String DEFAULT '',
  resolvedWorkspacePath String DEFAULT '',
  agentHasPhysicalIdentity UInt8 DEFAULT 0,
  agentHasRootIdentity UInt8 DEFAULT 0,
  agentHasInternalHelperRoot UInt8 DEFAULT 0,
  judgment String DEFAULT '{}',
  rawPreview String,
  ts DateTime MATERIALIZED toDateTime(intDiv(at, 1000))
) ENGINE = MergeTree
ORDER BY at
TTL ts + INTERVAL 90 DAY`;

const EVENT_ALTERS = [
  'ADD COLUMN IF NOT EXISTS schemaVersion LowCardinality(String) DEFAULT \'anysentry.agent_event.v1\'',
  'ADD COLUMN IF NOT EXISTS eventId String DEFAULT \'\'',
  'ADD COLUMN IF NOT EXISTS sourceEventId String DEFAULT \'\'',
  'ADD COLUMN IF NOT EXISTS ingestedAt UInt64 DEFAULT at',
  'ADD COLUMN IF NOT EXISTS commitBatchId String DEFAULT \'\'',
  'ADD COLUMN IF NOT EXISTS logicalKeyVersion UInt16 DEFAULT 1',
  'ADD COLUMN IF NOT EXISTS eventLogicalKey String DEFAULT \'\'',
  'ADD COLUMN IF NOT EXISTS payloadFingerprintVersion UInt16 DEFAULT 1',
  'ADD COLUMN IF NOT EXISTS payloadFingerprint String DEFAULT \'\'',
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
  `ADD COLUMN IF NOT EXISTS agentSessionKey String DEFAULT if(
    JSONExtractString(attribution, 'agentSessionId') != '',
    JSONExtractString(attribution, 'agentSessionId'),
    if(
      JSONExtractString(attribution, 'agentDisplayName') != '',
      JSONExtractString(attribution, 'agentDisplayName'),
      if(JSONExtractString(attribution, 'agentScopeId') != '', JSONExtractString(attribution, 'agentScopeId'), agentId)
    )
  )`,
  `ADD COLUMN IF NOT EXISTS resolvedWorkspacePath String DEFAULT if(
    JSONExtractString(process, 'cwd') != '',
    JSONExtractString(process, 'cwd'),
    if(
      JSONExtractString(attribution, 'agentScopeId') != '',
      concat('agent://', JSONExtractString(attribution, 'agentScopeId')),
      workspacePath
    )
  )`,
  `ADD COLUMN IF NOT EXISTS agentHasPhysicalIdentity UInt8 DEFAULT toUInt8(
    JSONExtractString(attribution, 'physicalWorkloadId') != ''
    OR JSONExtractString(attribution, 'agentInstanceId') != ''
    OR JSONExtractString(attribution, 'workloadRef', 'podUid') != ''
  )`,
  `ADD COLUMN IF NOT EXISTS agentHasRootIdentity UInt8 DEFAULT toUInt8(
    JSONExtractUInt(attribution, 'rootPid') > 0
    AND JSONExtractString(attribution, 'rootStartTime') != ''
  )`,
  `ADD COLUMN IF NOT EXISTS agentHasInternalHelperRoot UInt8 DEFAULT toUInt8(
    (
      positionCaseInsensitive(attributes, '--codex-run-as-fs-helper') > 0
      OR positionCaseInsensitive(attributes, 'codex-linux-sandbox') > 0
    )
    AND JSONExtractUInt(process, 'pid') = JSONExtractUInt(attribution, 'rootPid')
  )`,
  `MODIFY COLUMN IF EXISTS agentHasInternalHelperRoot UInt8 DEFAULT toUInt8(
    (
      positionCaseInsensitive(attributes, '--codex-run-as-fs-helper') > 0
      OR positionCaseInsensitive(attributes, 'codex-linux-sandbox') > 0
    )
    AND JSONExtractUInt(process, 'pid') = JSONExtractUInt(attribution, 'rootPid')
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

// A compact, append-only invalidation journal maintained by ClickHouse itself. Because the
// materialized view is part of the event insert pipeline it also observes revisions written by
// Fast Judge/L3 processes; an API-local generation counter would miss those cross-process writes.
// The table is not an event store and is safe to retain for a much shorter period than evidence.
const EVENT_COMMIT_FACT_TABLE = 'event_commit_facts_v2';
const EVENT_COMMIT_FACT_DDL = `CREATE TABLE IF NOT EXISTS ${EVENT_COMMIT_FACT_TABLE} (
  eventId String,
  decisionRevision UInt32,
  eventAt UInt64,
  committedAt UInt64,
  commitBatchId String,
  sourceId String,
  collectorId String,
  ts DateTime MATERIALIZED toDateTime(intDiv(committedAt, 1000))
) ENGINE = MergeTree
ORDER BY (committedAt, commitBatchId, eventId, decisionRevision)
TTL ts + INTERVAL 7 DAY`;
const EVENT_COMMIT_FACT_MV = 'event_commit_facts_v2_mv';
const EVENT_COMMIT_FACT_MV_DDL = `CREATE MATERIALIZED VIEW IF NOT EXISTS ${EVENT_COMMIT_FACT_MV}
TO ${EVENT_COMMIT_FACT_TABLE}
AS SELECT
  eventId,
  decisionRevision,
  at AS eventAt,
  toUInt64(toUnixTimestamp64Milli(now64(3))) AS committedAt,
  commitBatchId,
  sourceId,
  collectorId
FROM ${TABLE}`;

const EVENT_REVISION_CONFLICT_TABLE = 'event_revision_conflicts';
const EVENT_REVISION_CONFLICT_DDL = `CREATE TABLE IF NOT EXISTS ${EVENT_REVISION_CONFLICT_TABLE} (
  logicalKeyVersion UInt16,
  eventLogicalKey String,
  payloadFingerprintVersion UInt16,
  acceptedFingerprint String,
  conflictingFingerprint String,
  eventId String,
  decisionRevision UInt32,
  sourceId String,
  collectorId String,
  commitBatchId String,
  observedAt UInt64,
  payloadPreview String,
  ts DateTime MATERIALIZED toDateTime(intDiv(observedAt, 1000))
) ENGINE = MergeTree
ORDER BY (eventLogicalKey, observedAt, commitBatchId)
TTL ts + INTERVAL 90 DAY`;

const EVENT_REVISION_IDENTITY_TABLE = 'event_revision_identities';
const EVENT_REVISION_IDENTITY_DDL = `CREATE TABLE IF NOT EXISTS ${EVENT_REVISION_IDENTITY_TABLE} (
  eventLogicalKey String,
  payloadFingerprint String,
  eventId String,
  decisionRevision UInt32,
  sourceId String,
  collectorId String,
  committedAt UInt64,
  commitBatchId String,
  ts DateTime MATERIALIZED toDateTime(intDiv(committedAt, 1000))
) ENGINE = MergeTree
ORDER BY (eventLogicalKey, committedAt, commitBatchId)
TTL ts + INTERVAL 90 DAY`;
const EVENT_REVISION_IDENTITY_MV = 'event_revision_identities_mv';
const EVENT_REVISION_IDENTITY_MV_DDL = `CREATE MATERIALIZED VIEW IF NOT EXISTS ${EVENT_REVISION_IDENTITY_MV}
TO ${EVENT_REVISION_IDENTITY_TABLE}
AS SELECT
  eventLogicalKey,
  payloadFingerprint,
  eventId,
  decisionRevision,
  sourceId,
  collectorId,
  toUInt64(toUnixTimestamp64Milli(now64(3))) AS committedAt,
  commitBatchId
FROM ${TABLE}
WHERE eventLogicalKey != '' AND payloadFingerprint != ''`;

// Source progress is deliberately separate from the event store. It describes only the greatest
// business event time that ClickHouse has observed for each source/collector pair; it is not an
// arrival-completeness watermark. Aggregating states make the one-off historical backfill and the
// live MV overlap idempotently, so startup never needs to GROUP BY the events table again.
const SOURCE_COMMIT_PROGRESS_TABLE = 'source_commit_progress';
const SOURCE_COMMIT_PROGRESS_DDL = `CREATE TABLE IF NOT EXISTS ${SOURCE_COMMIT_PROGRESS_TABLE} (
  sourceId String,
  collectorId String,
  observedDurableThroughState AggregateFunction(max, UInt64),
  lastStoreCommittedAtState AggregateFunction(max, UInt64),
  commitGenerationState AggregateFunction(uniq, UInt64)
) ENGINE = AggregatingMergeTree
ORDER BY (sourceId, collectorId)`;
const SOURCE_COMMIT_PROGRESS_MV = 'source_commit_progress_mv';
const SOURCE_COMMIT_PROGRESS_MV_DDL = `CREATE MATERIALIZED VIEW IF NOT EXISTS ${SOURCE_COMMIT_PROGRESS_MV}
TO ${SOURCE_COMMIT_PROGRESS_TABLE}
AS SELECT
  sourceId,
  collectorId,
  maxState(eventAt) AS observedDurableThroughState,
  maxState(committedAt) AS lastStoreCommittedAtState,
  uniqState(cityHash64(eventId, decisionRevision)) AS commitGenerationState
FROM ${EVENT_COMMIT_FACT_TABLE}
GROUP BY sourceId, collectorId`;

// Complete aggregate snapshots, not incrementally accumulated counters. One JSON payload represents
// the whole event-time bucket at a proven commit cursor, so a later revision can replace the bucket
// without leaving the previous decision counted. The commit journal remains the authority that
// determines whether a stored snapshot is still reusable.
const DASHBOARD_BUCKET_SNAPSHOT_TABLE = 'dashboard_bucket_snapshots';
const DASHBOARD_BUCKET_SNAPSHOT_DDL = `CREATE TABLE IF NOT EXISTS ${DASHBOARD_BUCKET_SNAPSHOT_TABLE} (
  bucketStart UInt64,
  bucketMs UInt32,
  snapshotCommittedAt UInt64,
  snapshotCommitBatchId String DEFAULT '',
  snapshotEventId String,
  snapshotDecisionRevision UInt32,
  snapshotVersion UInt64,
  snapshotSchemaVersion LowCardinality(String) DEFAULT 'anysentry.dashboard-bucket-snapshot.v2',
  status LowCardinality(String) DEFAULT 'ready',
  factsJson String,
  payloadChecksum String DEFAULT '',
  computedAt UInt64,
  ts DateTime MATERIALIZED toDateTime(intDiv(computedAt, 1000))
) ENGINE = MergeTree
ORDER BY (
  bucketMs,
  bucketStart,
  snapshotCommittedAt,
  snapshotCommitBatchId,
  snapshotEventId,
  snapshotDecisionRevision,
  snapshotVersion
)
TTL ts + INTERVAL 14 DAY`;

type Row = Omit<JudgedEvent, 'actionKind' | 'actionTarget' | 'attributes' | 'process' | 'attribution' | 'judgment' | 'collectorId' | 'sourceId' | 'parentSpanId' | 'taskId' | 'rawPreview'> & {
  ingestedAt: number;
  commitBatchId: string;
  logicalKeyVersion: number;
  eventLogicalKey: string;
  payloadFingerprintVersion: number;
  payloadFingerprint: string;
  actionKind: string;
  actionTarget: string;
  attributes: string;
  process: string;
  attribution: string;
  agentIdentityKey: string;
  agentInstanceKey: string;
  agentMonitored: number;
  agentSessionKey: string;
  resolvedWorkspacePath: string;
  agentHasPhysicalIdentity: number;
  agentHasRootIdentity: number;
  agentHasInternalHelperRoot: number;
  judgment: string;
  collectorId: string;
  sourceId: string;
  parentSpanId: string;
  taskId: string;
  rawPreview: string;
};
interface ImmediateWrite {
  row: Row;
  eventAt: number;
  bytes: number;
  queuedAt: number;
  resolve: (receipt: EventBatchReceipt) => void;
  reject: (error: unknown) => void;
}

export interface EventBatchReceipt {
  schemaVersion: 'anysentry.event-batch-receipt.v1';
  batchId: string;
  result: 'durable_fact' | 'durable_dlq';
  rowCount: number;
  byteCount: number;
  queuedAt: number;
  flushStartedAt: number;
  durableAt: number;
  attempts: number;
  commitCursor?: EventCommitCursor;
  conflict?: {
    eventLogicalKey: string;
    acceptedFingerprint: string;
    conflictingFingerprint: string;
  };
}

export interface EventWriteBatchStatus {
  schemaVersion: 'anysentry.event-write-batch.v1';
  enabled: boolean;
  revisionImmutabilityEnforced: boolean;
  maxRows: number;
  maxDelayMs: number;
  maxBytes: number;
  queuedRows: number;
  queuedBytes: number;
  pendingReceipts: number;
  oldestQueuedMs: number;
  inFlight: boolean;
  batches: number;
  rows: number;
  bytes: number;
  retries: number;
  failures: number;
  conflicts: number;
  backpressureRejects: number;
  lastDurableAt?: number;
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
  commitBatchId?: string;
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
  hasInternalHelperRoot: boolean;
}

export interface StoredAgentBucketFact extends StoredAgentWindowFact {
  bucketStartMs: number;
}

function eligibleAgentRuntimeRows(
  rows: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const groupFor = (row: Record<string, unknown>): string => {
    const instances = Array.isArray(row.instanceKeys)
      ? row.instanceKeys.map(String).filter(Boolean)
      : [String(row.instanceKey ?? '')].filter(Boolean);
    return instances.length
      ? `instance\u0000${instances.join('\u0001')}`
      : `identity\u0000${String(row.identityKey ?? '')}`;
  };
  const runtimeEvidence = new Map<
    string,
    { hasPhysicalIdentity: boolean; hasRootIdentity: boolean; hasInternalHelperRoot: boolean }
  >();
  for (const row of rows) {
    const key = groupFor(row);
    const current = runtimeEvidence.get(key) ?? {
      hasPhysicalIdentity: false,
      hasRootIdentity: false,
      hasInternalHelperRoot: false,
    };
    current.hasPhysicalIdentity ||= Boolean(Number(row.hasPhysicalIdentity) || 0);
    current.hasRootIdentity ||= Boolean(Number(row.hasRootIdentity) || 0);
    current.hasInternalHelperRoot ||= Boolean(Number(row.hasInternalHelperRootFlag) || 0);
    runtimeEvidence.set(key, current);
  }
  return rows.filter((row) => {
    const evidence = runtimeEvidence.get(groupFor(row));
    return Boolean(
      evidence &&
      (evidence.hasPhysicalIdentity || evidence.hasRootIdentity) &&
      !evidence.hasInternalHelperRoot
    );
  });
}

export interface StoredAgentMetricBucketFact {
  bucketIndex: number;
  identityKey: string;
  agentId: string;
  representativeEvent?: JudgedEvent;
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

export interface StoredAgentObservabilityFact {
  eventCount: number;
  riskyEventCount: number;
  latencyTotal: number;
  agentIds: string[];
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
  instanceKey: string;
  representativeEvent: JudgedEvent;
  hasPhysicalIdentity: boolean;
  hasRootIdentity: boolean;
  hasInternalHelperRoot: boolean;
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

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

export function eventRevisionIdentity(e: JudgedEvent): {
  logicalKey: string;
  fingerprint: string;
} {
  const sourceId = e.sourceId?.trim() || attrString(e.attributes, 'sourceId');
  const collectorId = e.collectorId?.trim() || attrString(e.attributes, 'collectorId');
  const tenantId = attrString(e.attributes, 'tenantId');
  const revision = Math.max(1, Math.trunc(e.decisionRevision ?? 1));
  const logicalKey = [
    tenantId,
    sourceId || `${e.source}:${collectorId}`,
    e.eventId,
    String(revision),
  ].join('\u0000');
  // Transport and store-owned metadata are not part of a Canonical Revision. Keeping this
  // explicit prevents retries from acquiring a different fingerprint merely because they were
  // committed in another batch or received at another wall-clock time.
  const canonicalPayload = { ...e } as Record<string, unknown>;
  delete canonicalPayload.ingestedAt;
  delete canonicalPayload.storeCommittedAt;
  delete canonicalPayload.commitBatchId;
  delete canonicalPayload.kafkaOffset;
  delete canonicalPayload.deliveryAttempt;
  const canonicalAttributes = {
    ...(e.attributes ?? {}),
  } as Record<string, unknown>;
  delete canonicalAttributes.commitRequestBatchId;
  delete canonicalAttributes.writerId;
  delete canonicalAttributes.writerVersion;
  delete canonicalAttributes.idempotencyProtocolVersion;
  canonicalPayload.attributes = canonicalAttributes;
  return {
    logicalKey,
    fingerprint: createHash('sha256')
      .update(canonicalJson(canonicalPayload))
      .digest('hex'),
  };
}

function toRow(e: JudgedEvent): Row {
  const attribution = e.attribution;
  const physical = attribution?.physicalWorkloadId?.trim();
  const instance = attribution?.agentInstanceId?.trim();
  const revisionIdentity = eventRevisionIdentity(e);
  return {
    schemaVersion: e.schemaVersion,
    eventId: e.eventId,
    sourceEventId: e.sourceEventId ?? '',
    at: e.at,
    ingestedAt: Date.now(),
    commitBatchId: '',
    logicalKeyVersion: 1,
    eventLogicalKey: revisionIdentity.logicalKey,
    payloadFingerprintVersion: 1,
    payloadFingerprint: revisionIdentity.fingerprint,
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
    agentSessionKey:
      attribution?.agentSessionId?.trim()
      || attribution?.agentDisplayName?.trim()
      || attribution?.agentScopeId?.trim()
      || e.agentId,
    resolvedWorkspacePath:
      e.process?.cwd?.trim()
      || (attribution?.agentScopeId?.trim()
        ? `agent://${attribution.agentScopeId.trim()}`
        : e.workspacePath),
    agentHasPhysicalIdentity: physical || instance || attribution?.workloadRef?.podUid ? 1 : 0,
    agentHasRootIdentity: attribution?.rootStartTime && hasDirectAgentRootEvidence(e) ? 1 : 0,
    agentHasInternalHelperRoot: isInternalAgentHelperRootEvent(e) ? 1 : 0,
    judgment: JSON.stringify(e.judgment ?? {}),
    rawPreview: e.rawPreview ?? '',
  };
}

function prepareCommitBatch(rows: Row[]): Row[] {
  const existingBatchId = rows.find((row) => row.commitBatchId)?.commitBatchId;
  const commitBatchId = existingBatchId || randomUUID();
  for (const row of rows) {
    if (!row.commitBatchId) row.commitBatchId = commitBatchId;
  }
  return rows;
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

@Injectable()
export class ClickHouseStore implements OnModuleDestroy {
  private client?: ClickHouseClient;
  private buf: Row[] = [];
  private collectorHeartbeatBuf: Array<{ collectorId: string; at: number; payload: string }> = [];
  private flushTimer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private connectInFlight?: Promise<boolean>;
  private flushInFlight?: Promise<void>;
  private flushBatchMinEventTimeMs?: number;
  private immediateWriteQueue: ImmediateWrite[] = [];
  private immediateWriteQueueBytes = 0;
  private immediateWriteTimer?: NodeJS.Timeout;
  private immediateWriteInFlight?: Promise<void>;
  private readonly immediateWriteEventTimes = new Map<number, number>();
  private readonly eventWriteStats = {
    batches: 0,
    rows: 0,
    bytes: 0,
    retries: 0,
    failures: 0,
    conflicts: 0,
    backpressureRejects: 0,
    lastDurableAt: undefined as number | undefined,
  };
  private ready = false;
  private closing = false;
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

  get enabled(): boolean {
    return this.ready;
  }

  dashboardBucketSnapshotStatus() {
    return {
      schemaVersion: 'anysentry.dashboard-bucket-snapshots.v1' as const,
      enabled: process.env.ANYSENTRY_PERSISTED_DASHBOARD_BUCKETS !== 'off',
      ...this.dashboardSnapshotStats,
    };
  }

  private eventMicrobatchEnabled(): boolean {
    return process.env.ANYSENTRY_CLICKHOUSE_MICROBATCH === 'on';
  }

  private eventBatchMaxRows(): number {
    return boundedPositiveInt(
      process.env.ANYSENTRY_CLICKHOUSE_BATCH_MAX_ROWS,
      this.eventMicrobatchEnabled() ? 1_000 : 500,
      1,
      10_000,
    );
  }

  private eventBatchMaxDelayMs(): number {
    return boundedPositiveInt(
      process.env.ANYSENTRY_CLICKHOUSE_BATCH_MAX_DELAY_MS,
      this.eventMicrobatchEnabled() ? 1_000 : 10,
      1,
      10_000,
    );
  }

  private eventBatchMaxBytes(): number {
    return boundedPositiveInt(
      process.env.ANYSENTRY_CLICKHOUSE_BATCH_MAX_BYTES,
      1024 * 1024,
      16 * 1024,
      16 * 1024 * 1024,
    );
  }

  eventWriteBatchStatus(): EventWriteBatchStatus {
    const oldestQueuedAt = this.immediateWriteQueue[0]?.queuedAt;
    return {
      schemaVersion: 'anysentry.event-write-batch.v1',
      enabled: this.eventMicrobatchEnabled(),
      revisionImmutabilityEnforced:
        process.env.ANYSENTRY_REVISION_IMMUTABILITY === 'enforce',
      maxRows: this.eventBatchMaxRows(),
      maxDelayMs: this.eventBatchMaxDelayMs(),
      maxBytes: this.eventBatchMaxBytes(),
      queuedRows: this.immediateWriteQueue.length,
      queuedBytes: this.immediateWriteQueueBytes,
      pendingReceipts: [...this.immediateWriteEventTimes.values()]
        .reduce((sum, count) => sum + count, 0),
      oldestQueuedMs: oldestQueuedAt ? Math.max(0, Date.now() - oldestQueuedAt) : 0,
      inFlight: Boolean(this.immediateWriteInFlight),
      ...this.eventWriteStats,
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
    this.closing = false;
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
      await nextClient.command({ query: COLLECTOR_HEARTBEAT_DDL });
      await nextClient.command({ query: CONFIG_DDL });
      await nextClient.command({ query: NOTIFICATION_DELIVERY_DDL });
      await nextClient.command({ query: IDENTITY_AI_REVIEW_DDL });
      await nextClient.command({ query: AUDIT_FACT_DDL });
      await nextClient.command({ query: EVENT_COMMIT_FACT_DDL });
      await nextClient.command({ query: EVENT_COMMIT_FACT_MV_DDL });
      await nextClient.command({ query: EVENT_REVISION_CONFLICT_DDL });
      await nextClient.command({ query: EVENT_REVISION_IDENTITY_DDL });
      await nextClient.command({ query: EVENT_REVISION_IDENTITY_MV_DDL });
      await nextClient.command({ query: SOURCE_COMMIT_PROGRESS_DDL });
      await nextClient.command({ query: SOURCE_COMMIT_PROGRESS_MV_DDL });
      await nextClient.command({ query: DASHBOARD_BUCKET_SNAPSHOT_DDL });
      await nextClient.command({
        query: `ALTER TABLE ${DASHBOARD_BUCKET_SNAPSHOT_TABLE}
          ADD COLUMN IF NOT EXISTS snapshotCommitBatchId String DEFAULT ''
          AFTER snapshotCommittedAt`,
      });
      await nextClient.command({
        query: `ALTER TABLE ${DASHBOARD_BUCKET_SNAPSHOT_TABLE}
          ADD COLUMN IF NOT EXISTS snapshotSchemaVersion LowCardinality(String)
          DEFAULT 'anysentry.dashboard-bucket-snapshot.v2' AFTER snapshotVersion`,
      });
      await nextClient.command({
        query: `ALTER TABLE ${DASHBOARD_BUCKET_SNAPSHOT_TABLE}
          ADD COLUMN IF NOT EXISTS status LowCardinality(String) DEFAULT 'ready'
          AFTER snapshotSchemaVersion`,
      });
      await nextClient.command({
        query: `ALTER TABLE ${DASHBOARD_BUCKET_SNAPSHOT_TABLE}
          ADD COLUMN IF NOT EXISTS payloadChecksum String DEFAULT ''
          AFTER factsJson`,
      });
      const committed = await nextClient.query({
        query: `
          SELECT
            sourceId,
            collectorId,
            maxMerge(observedDurableThroughState) AS committedThrough,
            maxMerge(lastStoreCommittedAtState) AS committedAt
          FROM ${SOURCE_COMMIT_PROGRESS_TABLE}
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
        this.committedSourceProgress.set(`${sourceId ?? ''}\u0000${collectorId ?? ''}`, {
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
      if (this.flushTimer) clearInterval(this.flushTimer);
      this.flushTimer = setInterval(() => void this.flush(), 2_000);
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
    if (!this.ready) return;
    this.buf.push(toRow(e));
    if (this.buf.length >= 500) void this.flush();
  }
  /** Persist one lifecycle revision before acknowledging queue work. */
  async insertNow(e: JudgedEvent): Promise<void> {
    const receipt = await this.insertNowWithReceipt(e);
    if (receipt.result === 'durable_dlq') {
      throw new Error(
        `Immutable Revision conflict for ${receipt.conflict?.eventLogicalKey ?? e.eventId}`,
      );
    }
  }

  /**
   * Persist one lifecycle revision and return the durable batch receipt.
   *
   * Queue admission is deliberately bounded. Callers that require durability must observe a
   * rejected promise and apply their transport-specific backpressure instead of accumulating an
   * unbounded number of pending promises while ClickHouse is unavailable.
   */
  async insertNowWithReceipt(e: JudgedEvent): Promise<EventBatchReceipt> {
    if (!this.client || !this.ready || this.closed || this.closing) {
      throw new Error('ClickHouse is not ready');
    }
    const row = toRow(e);
    const bytes = Buffer.byteLength(JSON.stringify(row));
    const maxQueuedRows = boundedPositiveInt(
      process.env.ANYSENTRY_CLICKHOUSE_MAX_QUEUED_ROWS,
      20_000,
      100,
      1_000_000,
    );
    const maxQueuedBytes = boundedPositiveInt(
      process.env.ANYSENTRY_CLICKHOUSE_MAX_QUEUED_BYTES,
      64 * 1024 * 1024,
      1024 * 1024,
      1024 * 1024 * 1024,
    );
    if (
      this.immediateWriteQueue.length >= maxQueuedRows ||
      this.immediateWriteQueueBytes + bytes > maxQueuedBytes
    ) {
      this.eventWriteStats.backpressureRejects += 1;
      throw new Error(
        `ClickHouse event queue is full (${this.immediateWriteQueue.length} rows, `
        + `${this.immediateWriteQueueBytes} bytes)`,
      );
    }
    this.immediateWriteEventTimes.set(
      e.at,
      (this.immediateWriteEventTimes.get(e.at) ?? 0) + 1,
    );
    return new Promise<EventBatchReceipt>((resolve, reject) => {
      this.immediateWriteQueue.push({
        row,
        eventAt: e.at,
        bytes,
        queuedAt: Date.now(),
        resolve,
        reject,
      });
      this.immediateWriteQueueBytes += bytes;
      if (
        this.immediateWriteQueue.length >= this.eventBatchMaxRows() ||
        this.immediateWriteQueueBytes >= this.eventBatchMaxBytes()
      ) {
        void this.drainImmediateWrites();
        return;
      }
      this.scheduleImmediateWriteDrain();
    });
  }

  private scheduleImmediateWriteDrain(): void {
    if (this.immediateWriteTimer || !this.immediateWriteQueue.length) return;
    const oldest = this.immediateWriteQueue[0]?.queuedAt ?? Date.now();
    const waitMs = Math.max(
      0,
      this.eventBatchMaxDelayMs() - Math.max(0, Date.now() - oldest),
    );
    // A lifecycle revision remains synchronous from the caller's perspective: every promise
    // resolves only after ClickHouse and its critical synchronous materialized views accept the
    // block. The configurable coalescing window only changes how many receipts share one INSERT.
    this.immediateWriteTimer = setTimeout(() => {
      this.immediateWriteTimer = undefined;
      void this.drainImmediateWrites();
    }, waitMs);
  }

  private drainImmediateWrites(): Promise<void> {
    if (this.immediateWriteTimer) clearTimeout(this.immediateWriteTimer);
    this.immediateWriteTimer = undefined;
    if (this.immediateWriteInFlight) return this.immediateWriteInFlight;
    if (!this.immediateWriteQueue.length) return Promise.resolve();

    const operation = this.flushImmediateWrites();
    this.immediateWriteInFlight = operation;
    return operation.finally(() => {
      if (this.immediateWriteInFlight === operation) this.immediateWriteInFlight = undefined;
      if (
        this.immediateWriteQueue.length >= this.eventBatchMaxRows() ||
        this.immediateWriteQueueBytes >= this.eventBatchMaxBytes()
      ) {
        void this.drainImmediateWrites();
      } else {
        this.scheduleImmediateWriteDrain();
      }
    });
  }

  private async existingRevisionFingerprints(
    logicalKeys: string[],
  ): Promise<Map<string, string>> {
    if (!this.client || !this.ready || !logicalKeys.length) return new Map();
    const result = await this.client.query({
      query: `
        SELECT
          eventLogicalKey,
          argMin(payloadFingerprint, tuple(committedAt, commitBatchId)) AS acceptedFingerprint
        FROM ${EVENT_REVISION_IDENTITY_TABLE}
        WHERE eventLogicalKey IN {logicalKeys:Array(String)}
        GROUP BY eventLogicalKey`,
      query_params: { logicalKeys: [...new Set(logicalKeys)] },
      format: 'JSONEachRow',
    });
    const rows = await result.json() as Array<{
      eventLogicalKey?: string;
      acceptedFingerprint?: string;
    }>;
    return new Map(rows.flatMap((row) => {
      const key = row.eventLogicalKey?.trim();
      const fingerprint = row.acceptedFingerprint?.trim();
      return key && fingerprint ? [[key, fingerprint] as const] : [];
    }));
  }

  private async flushImmediateWrites(): Promise<void> {
    if (this.immediateWriteQueue.length) {
      const batch: ImmediateWrite[] = [];
      let batchBytes = 0;
      const maxRows = this.eventBatchMaxRows();
      const maxBytes = this.eventBatchMaxBytes();
      while (this.immediateWriteQueue.length && batch.length < maxRows) {
        const next = this.immediateWriteQueue[0];
        if (batch.length && batchBytes + next.bytes > maxBytes) break;
        batch.push(this.immediateWriteQueue.shift()!);
        batchBytes += next.bytes;
        this.immediateWriteQueueBytes = Math.max(0, this.immediateWriteQueueBytes - next.bytes);
      }

      const enforceRevisionImmutability =
        process.env.ANYSENTRY_REVISION_IMMUTABILITY === 'enforce';
      let existingFingerprints = new Map<string, string>();
      if (enforceRevisionImmutability) {
        try {
          existingFingerprints = await this.existingRevisionFingerprints(
            batch.map((entry) => entry.row.eventLogicalKey),
          );
        } catch (error) {
          this.eventWriteStats.failures += 1;
          for (const entry of batch) entry.reject(error);
          for (const entry of batch) {
            const remainingAtTime =
              (this.immediateWriteEventTimes.get(entry.eventAt) ?? 1) - 1;
            if (remainingAtTime > 0) {
              this.immediateWriteEventTimes.set(entry.eventAt, remainingAtTime);
            } else {
              this.immediateWriteEventTimes.delete(entry.eventAt);
            }
          }
          return;
        }
      }
      const factEntries: ImmediateWrite[] = [];
      const physicalEntries: ImmediateWrite[] = [];
      const conflictEntries: Array<{
        entry: ImmediateWrite;
        acceptedFingerprint: string;
      }> = [];
      const firstByLogicalKey = new Map<string, ImmediateWrite>();
      for (const entry of batch) {
        if (!enforceRevisionImmutability) {
          factEntries.push(entry);
          physicalEntries.push(entry);
          continue;
        }
        const existingFingerprint = existingFingerprints.get(entry.row.eventLogicalKey);
        if (existingFingerprint) {
          if (existingFingerprint === entry.row.payloadFingerprint) {
            factEntries.push(entry);
          } else {
            conflictEntries.push({
              entry,
              acceptedFingerprint: existingFingerprint,
            });
          }
          continue;
        }
        const first = firstByLogicalKey.get(entry.row.eventLogicalKey);
        if (!first) {
          firstByLogicalKey.set(entry.row.eventLogicalKey, entry);
          factEntries.push(entry);
          physicalEntries.push(entry);
        } else if (first.row.payloadFingerprint === entry.row.payloadFingerprint) {
          // The caller still receives a durable receipt, but one physical row is enough for
          // identical deliveries of the same immutable Revision within this batch.
          factEntries.push(entry);
        } else {
          conflictEntries.push({
            entry,
            acceptedFingerprint: first.row.payloadFingerprint,
          });
        }
      }
      const rows = prepareCommitBatch(physicalEntries.map((entry) => entry.row));
      const batchId = rows[0]?.commitBatchId ?? randomUUID();
      const flushStartedAt = Date.now();
      const maxAttempts = boundedPositiveInt(
        process.env.ANYSENTRY_CLICKHOUSE_BATCH_MAX_ATTEMPTS,
        5,
        1,
        20,
      );
      let attempts = 0;
      let finalError: unknown;
      while (attempts < maxAttempts) {
        attempts += 1;
        try {
          if (!this.client || !this.ready || this.closed) throw new Error('ClickHouse is not ready');
          if (conflictEntries.length) {
            await this.client.insert({
              table: EVENT_REVISION_CONFLICT_TABLE,
              values: conflictEntries.map(({ entry, acceptedFingerprint }) => ({
                logicalKeyVersion: entry.row.logicalKeyVersion,
                eventLogicalKey: entry.row.eventLogicalKey,
                payloadFingerprintVersion: entry.row.payloadFingerprintVersion,
                acceptedFingerprint,
                conflictingFingerprint: entry.row.payloadFingerprint,
                eventId: entry.row.eventId,
                decisionRevision: entry.row.decisionRevision,
                sourceId: entry.row.sourceId,
                collectorId: entry.row.collectorId,
                commitBatchId: batchId,
                observedAt: Date.now(),
                payloadPreview: JSON.stringify(entry.row).slice(0, 64 * 1024),
              })),
              format: 'JSONEachRow',
            });
          }
          if (rows.length) {
            await this.client.insert({ table: TABLE, values: rows, format: 'JSONEachRow' });
          }
          const durableAt = Date.now();
          if (rows.length) {
            this.committedThroughMs = Math.max(
              this.committedThroughMs ?? 0,
              ...physicalEntries.map((entry) => entry.eventAt),
            );
            this.noteCommittedRows(rows);
          }
          this.eventWriteStats.batches += 1;
          this.eventWriteStats.rows += rows.length;
          this.eventWriteStats.bytes += batchBytes;
          this.eventWriteStats.lastDurableAt = durableAt;
          const commitCursor: EventCommitCursor | undefined = rows.length
            ? {
                committedAtMs: durableAt,
                commitBatchId: batchId,
                eventId: rows.at(-1)?.eventId ?? '',
                decisionRevision: rows.at(-1)?.decisionRevision ?? 0,
              }
            : undefined;
          for (const entry of factEntries) {
            entry.resolve({
              schemaVersion: 'anysentry.event-batch-receipt.v1',
              batchId,
              result: 'durable_fact',
              rowCount: rows.length,
              byteCount: batchBytes,
              queuedAt: entry.queuedAt,
              flushStartedAt,
              durableAt,
              attempts,
              ...(commitCursor ? { commitCursor } : {}),
            });
          }
          for (const { entry, acceptedFingerprint } of conflictEntries) {
            entry.resolve({
              schemaVersion: 'anysentry.event-batch-receipt.v1',
              batchId,
              result: 'durable_dlq',
              rowCount: 0,
              byteCount: entry.bytes,
              queuedAt: entry.queuedAt,
              flushStartedAt,
              durableAt,
              attempts,
              conflict: {
                eventLogicalKey: entry.row.eventLogicalKey,
                acceptedFingerprint,
                conflictingFingerprint: entry.row.payloadFingerprint,
              },
            });
          }
          this.eventWriteStats.conflicts += conflictEntries.length;
          finalError = undefined;
          break;
        } catch (error) {
          finalError = error;
          if (attempts >= maxAttempts || this.closed) break;
          this.eventWriteStats.retries += 1;
          const baseMs = boundedPositiveInt(
            process.env.ANYSENTRY_CLICKHOUSE_BATCH_RETRY_BASE_MS,
            200,
            10,
            10_000,
          );
          const waitMs = Math.min(5_000, baseMs * 2 ** (attempts - 1));
          await delay(waitMs + Math.floor(Math.random() * Math.max(1, waitMs / 4)));
        }
      }
      if (finalError !== undefined) {
        this.eventWriteStats.failures += 1;
        for (const entry of batch) entry.reject(finalError);
      }
      {
        for (const entry of batch) {
          const remainingAtTime =
            (this.immediateWriteEventTimes.get(entry.eventAt) ?? 1) - 1;
          if (remainingAtTime > 0) {
            this.immediateWriteEventTimes.set(entry.eventAt, remainingAtTime);
          } else {
            this.immediateWriteEventTimes.delete(entry.eventAt);
          }
        }
      }
    }
  }

  async flush(): Promise<void> {
    // Chain flushes instead of allowing two callers to drain the buffers concurrently. A caller
    // arriving during an insert receives its own pass after that insert, so rows appended while
    // the first batch is in flight are not stranded (including during close()).
    const previous = this.flushInFlight ?? Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(() => this.flushBatch());
    this.flushInFlight = operation;
    try {
      await Promise.all([operation, this.drainImmediateWrites()]);
    } finally {
      if (this.flushInFlight === operation) this.flushInFlight = undefined;
    }
  }

  private async flushBatch(): Promise<void> {
    if (!this.client) return;
    const values = prepareCommitBatch(this.buf);
    this.buf = [];
    if (values.length) {
      this.flushBatchMinEventTimeMs = Math.min(
        ...values.map((row) => Number(row.at) || Number.MAX_SAFE_INTEGER),
      );
      try {
        await this.client.insert({ table: TABLE, values, format: 'JSONEachRow' });
        this.committedThroughMs = Math.max(
          this.committedThroughMs ?? 0,
          ...values.map((row) => Number(row.at) || 0),
        );
        this.noteCommittedRows(values);
      } catch (err) {
        // A transient durable-store failure must not leave the hot ring as the only remaining
        // copy. Put the failed batch before rows that arrived while the insert was in flight.
        this.buf = [...values, ...this.buf];
        console.error('[clickhouse] insert failed (batch queued for retry):', (err as Error).message);
      } finally {
        this.flushBatchMinEventTimeMs = undefined;
      }
    }
    const heartbeatValues = this.collectorHeartbeatBuf;
    this.collectorHeartbeatBuf = [];
    if (heartbeatValues.length) {
      try {
        await this.client.insert({
          table: COLLECTOR_HEARTBEAT_TABLE,
          values: heartbeatValues,
          format: 'JSONEachRow',
        });
      } catch (err) {
        this.collectorHeartbeatBuf = [...heartbeatValues, ...this.collectorHeartbeatBuf];
        console.error('[clickhouse] collector heartbeat insert failed (batch queued for retry):', (err as Error).message);
      }
    }
  }

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
    try {
      const rs = await this.client.query({
        query: `SELECT * FROM (SELECT * FROM ${TABLE} WHERE at >= {since:UInt64} ORDER BY at DESC LIMIT {lim:UInt32}) ORDER BY at ASC`,
        query_params: { since: sinceMs, lim: Math.min(limit * 3, 300_000) },
        format: 'JSONEachRow',
      });
      const rows = (await rs.json()) as Array<Record<string, unknown>>;
      return foldLatestEventRevisions(rows.map(fromRow)).sort((a, b) => a.at - b.at).slice(-limit);
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
    const safeLimit = Math.max(1, Math.min(5_000, Math.round(limit)));
    const clauses = ['at >= {since:UInt64}', 'at <= {until:UInt64}'];
    if (options.monitoredOnly) clauses.push('agentMonitored = 1');
    if (options.tier) clauses.push('tier = {tier:String}');
    try {
      const rs = await this.client.query({
        query: `
          SELECT *
          FROM (
            SELECT *
            FROM ${TABLE}
            WHERE ${clauses.join(' AND ')}
            ORDER BY at DESC, decisionRevision DESC, decisionUpdatedAt DESC
            LIMIT {scanLimit:UInt32}
          )
          ORDER BY at DESC, decisionRevision DESC, decisionUpdatedAt DESC
          LIMIT 1 BY eventId
          LIMIT {limit:UInt32}`,
        query_params: {
          since: sinceMs,
          until: untilMs,
          tier: options.tier ?? '',
          scanLimit: Math.min(15_000, safeLimit * 3),
          limit: safeLimit,
        },
        format: 'JSONEachRow',
      });
      return (await rs.json() as Array<Record<string, unknown>>).map(fromRow);
    } catch (error) {
      console.error('[clickhouse] recent dashboard events query failed:', (error as Error).message);
      return null;
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
    // Replay a short server-commit-time boundary on every page. ClickHouse assigns committedAt in
    // the MV, while commitBatchId disambiguates batches sharing the same millisecond. Replaying is
    // intentional: cache invalidation is idempotent and this closes the race where a concurrent
    // insert becomes visible just after a reader advanced within the same server millisecond.
    const replayMs = boundedPositiveInt(
      process.env.ANYSENTRY_COMMIT_CURSOR_REPLAY_MS,
      250,
      1,
      5_000,
    );
    const replayFrom = Math.max(0, (after?.committedAtMs ?? 0) - replayMs);
    try {
      const result = await this.client.query({
        query: `
          SELECT eventId, decisionRevision, eventAt, committedAt, commitBatchId, sourceId, collectorId
          FROM ${EVENT_COMMIT_FACT_TABLE}
          PREWHERE committedAt >= {replayFrom:UInt64}
          ORDER BY committedAt, commitBatchId, eventId, decisionRevision
          LIMIT {limit:UInt32}`,
        query_params: {
          replayFrom,
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
          commitBatchId: String(row.commitBatchId ?? ''),
          eventId: String(row.eventId ?? ''),
          decisionRevision: Math.max(1, Number(row.decisionRevision) || 1),
        },
        eventAtMs: Number(row.eventAt) || 0,
        sourceId: String(row.sourceId ?? '').trim() || undefined,
        collectorId: String(row.collectorId ?? '').trim() || undefined,
      }));
      const selectedCursor = changes.at(-1)?.cursor;
      const cursor = selectedCursor && (
        !after || compareEventCommitCursor(selectedCursor, after) >= 0
      )
        ? selectedCursor
        : after;
      return {
        changes,
        cursor,
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
          SELECT committedAt, commitBatchId, eventId, decisionRevision
          FROM ${EVENT_COMMIT_FACT_TABLE}
          ORDER BY committedAt DESC, commitBatchId DESC, eventId DESC, decisionRevision DESC
          LIMIT 1`,
        format: 'JSONEachRow',
      });
      const row = (await result.json() as Array<Record<string, unknown>>)[0];
      if (!row) return { committedAtMs: 0, eventId: '', decisionRevision: 0 };
      return {
        committedAtMs: Number(row.committedAt) || 0,
        commitBatchId: String(row.commitBatchId ?? ''),
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
          SELECT committedAt, commitBatchId, eventId, decisionRevision
          FROM ${EVENT_COMMIT_FACT_TABLE}
          ORDER BY committedAt, commitBatchId, eventId, decisionRevision
          LIMIT 1`,
        format: 'JSONEachRow',
      });
      const row = (await result.json() as Array<Record<string, unknown>>)[0];
      if (!row) return { committedAtMs: 0, eventId: '', decisionRevision: 0 };
      return {
        committedAtMs: Number(row.committedAt) || 0,
        commitBatchId: String(row.commitBatchId ?? ''),
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
      // Once persisted snapshots are populated, late revisions usually leave a small number of
      // sparse dirty buckets. Collapsing 9-20 isolated buckets into one hour-wide envelope defeats
      // the cache and rescans hundreds of thousands of unrelated rows. Keep bounded point ranges
      // until fragmentation is genuinely pathological.
      const ranges = missingRanges.length > 32
        ? [{ start: missingRanges[0].start, end: missingRanges.at(-1)!.end }]
        : missingRanges;
      if (ranges.length) {
        const envelopeStart = ranges[0].start;
        const envelopeEnd = ranges.at(-1)!.end;
        const missingBuckets = new Set<number>();
        for (const range of ranges) {
          for (let bucket = range.start; bucket < range.end; bucket += size) {
            missingBuckets.add(bucket);
          }
        }
        const beforeByBucket = await this.eventCommitCursorsForBuckets(
          envelopeStart,
          envelopeEnd,
          size,
        );
        const beforeGlobal = await this.latestEventCommitCursor();
        const grouped = new Map<number, DashboardAggregateBucketFact[]>();
        for (const range of ranges) {
          this.dashboardSnapshotStats.exactRanges += 1;
          const rows = await this.queryDashboardAggregateBucketFactsRaw(
            range.start,
            range.end,
            size,
          );
          if (rows === null) return null;
          for (const row of rows) {
            const bucketRows = grouped.get(row.bucketStartMs) ?? [];
            bucketRows.push(row);
            grouped.set(row.bucketStartMs, bucketRows);
          }
          for (let bucket = range.start; bucket < range.end; bucket += size) {
            byBucket.set(bucket, grouped.get(bucket) ?? []);
          }
        }

        const afterByBucket = await this.eventCommitCursorsForBuckets(
          envelopeStart,
          envelopeEnd,
          size,
        );
        const afterGlobal = await this.latestEventCommitCursor();
        if (beforeGlobal && afterGlobal) {
          const stableCursors = new Map<number, EventCommitCursor>();
          const globalStable =
            compareEventCommitCursor(beforeGlobal, afterGlobal) === 0;
          for (const bucket of missingBuckets) {
            const before = beforeByBucket.get(bucket);
            const after = afterByBucket.get(bucket);
            if (before && after && compareEventCommitCursor(before, after) === 0) {
              stableCursors.set(bucket, after);
            } else if (!before && !after && globalStable) {
              // Empty buckets need a global fence: no bucket-local cursor exists until the first
              // late event arrives. A later event then advances the bucket cursor and invalidates
              // this snapshot on the next read.
              stableCursors.set(bucket, afterGlobal);
            }
          }
          await this.writePersistedDashboardBuckets(
            envelopeStart,
            envelopeEnd,
            size,
            stableCursors,
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
            agentMonitored AS monitored,
            decisionStatus,
            verdict,
            tier,
            riskType,
            riskCategory,
            riskName,
            multiIf(severity = 'critical', 4, severity = 'high', 3, severity = 'medium', 2, severity = 'low', 1, 0) AS severityRank,
            agentSessionKey AS sessionKey,
            userId,
            resolvedWorkspacePath,
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
              tuple(snapshotCommittedAt, snapshotCommitBatchId, snapshotEventId, snapshotDecisionRevision, snapshotVersion)
            ) AS latestSnapshotCommittedAt,
            argMax(
              snapshotCommitBatchId,
              tuple(snapshotCommittedAt, snapshotCommitBatchId, snapshotEventId, snapshotDecisionRevision, snapshotVersion)
            ) AS latestSnapshotCommitBatchId,
            argMax(
              snapshotEventId,
              tuple(snapshotCommittedAt, snapshotCommitBatchId, snapshotEventId, snapshotDecisionRevision, snapshotVersion)
            ) AS latestSnapshotEventId,
            argMax(
              snapshotDecisionRevision,
              tuple(snapshotCommittedAt, snapshotCommitBatchId, snapshotEventId, snapshotDecisionRevision, snapshotVersion)
            ) AS latestSnapshotDecisionRevision,
            argMax(
              factsJson,
              tuple(snapshotCommittedAt, snapshotCommitBatchId, snapshotEventId, snapshotDecisionRevision, snapshotVersion)
            ) AS latestFactsJson,
            argMax(
              payloadChecksum,
              tuple(snapshotCommittedAt, snapshotCommitBatchId, snapshotEventId, snapshotDecisionRevision, snapshotVersion)
            ) AS latestPayloadChecksum
          FROM ${DASHBOARD_BUCKET_SNAPSHOT_TABLE}
          WHERE bucketMs = {bucketMs:UInt32}
            AND bucketStart >= {start:UInt64}
            AND bucketStart < {end:UInt64}
            AND status = 'ready'
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
            argMax(committedAt, tuple(committedAt, commitBatchId, eventId, decisionRevision)) AS latestCommittedAt,
            argMax(commitBatchId, tuple(committedAt, commitBatchId, eventId, decisionRevision)) AS latestCommitBatchId,
            argMax(eventId, tuple(committedAt, commitBatchId, eventId, decisionRevision)) AS latestEventId,
            argMax(decisionRevision, tuple(committedAt, commitBatchId, eventId, decisionRevision)) AS latestDecisionRevision
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
          const factsJson = String(row.latestFactsJson ?? '[]');
          const expectedChecksum = String(row.latestPayloadChecksum ?? '');
          if (
            expectedChecksum &&
            createHash('sha256').update(factsJson).digest('hex') !== expectedChecksum
          ) {
            this.dashboardSnapshotStats.invalidated += 1;
            return [];
          }
          const facts = JSON.parse(factsJson) as unknown;
          if (!Array.isArray(facts)) return [];
          return [{
            bucketStartMs: Number(row.bucketStart) || 0,
            bucketMs: Number(row.bucketMs) || bucketMs,
            cursor: {
              committedAtMs: Number(row.latestSnapshotCommittedAt) || 0,
              commitBatchId: String(row.latestSnapshotCommitBatchId ?? ''),
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
          commitBatchId: String(row.latestCommitBatchId ?? ''),
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

  private async eventCommitCursorsForBuckets(
    startMs: number,
    endExclusiveMs: number,
    bucketMs: number,
  ): Promise<Map<number, EventCommitCursor>> {
    if (!this.client || !this.ready || endExclusiveMs <= startMs) return new Map();
    const result = await this.client.query({
      query: `
        SELECT
          intDiv(eventAt, {bucketMs:UInt64}) * {bucketMs:UInt64} AS bucketStart,
          argMax(committedAt, tuple(committedAt, commitBatchId, eventId, decisionRevision)) AS latestCommittedAt,
          argMax(commitBatchId, tuple(committedAt, commitBatchId, eventId, decisionRevision)) AS latestCommitBatchId,
          argMax(eventId, tuple(committedAt, commitBatchId, eventId, decisionRevision)) AS latestEventId,
          argMax(decisionRevision, tuple(committedAt, commitBatchId, eventId, decisionRevision)) AS latestDecisionRevision
        FROM ${EVENT_COMMIT_FACT_TABLE}
        WHERE eventAt >= {start:UInt64} AND eventAt < {end:UInt64}
        GROUP BY bucketStart`,
      query_params: {
        start: startMs,
        end: endExclusiveMs,
        bucketMs,
      },
      format: 'JSONEachRow',
    });
    const rows = await result.json() as Array<Record<string, unknown>>;
    return new Map(rows.map((row) => [
      Number(row.bucketStart) || 0,
      {
        committedAtMs: Number(row.latestCommittedAt) || 0,
        commitBatchId: String(row.latestCommitBatchId ?? ''),
        eventId: String(row.latestEventId ?? ''),
        decisionRevision: Number(row.latestDecisionRevision) || 0,
      },
    ]));
  }

  private async writePersistedDashboardBuckets(
    startMs: number,
    endExclusiveMs: number,
    bucketMs: number,
    cursorsByBucket: Map<number, EventCommitCursor>,
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
      snapshotCommitBatchId: string;
      snapshotEventId: string;
      snapshotDecisionRevision: number;
      snapshotVersion: number;
      snapshotSchemaVersion: string;
      status: 'ready';
      factsJson: string;
      payloadChecksum: string;
      computedAt: number;
    }> = [];
    for (let bucket = startMs; bucket < endExclusiveMs; bucket += bucketMs) {
      const cursor = cursorsByBucket.get(bucket);
      if (!cursor) continue;
      const factsJson = JSON.stringify(factsByBucket.get(bucket) ?? []);
      values.push({
        bucketStart: bucket,
        bucketMs,
        snapshotCommittedAt: cursor.committedAtMs,
        snapshotCommitBatchId: cursor.commitBatchId ?? '',
        snapshotEventId: cursor.eventId,
        snapshotDecisionRevision: cursor.decisionRevision,
        snapshotVersion: baseVersion,
        snapshotSchemaVersion: 'anysentry.dashboard-bucket-snapshot.v2',
        status: 'ready',
        factsJson,
        payloadChecksum: createHash('sha256').update(factsJson).digest('hex'),
        computedAt,
      });
    }
    if (!values.length) return;
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
        argMax(sourceEvent.attribution, tuple(sourceEvent.decisionRevision, sourceEvent.decisionUpdatedAt, sourceEvent.at)) AS attribution,
        argMax(sourceEvent.agentMonitored, tuple(sourceEvent.decisionRevision, sourceEvent.decisionUpdatedAt, sourceEvent.at)) AS monitored
      FROM ${TABLE} AS sourceEvent
      WHERE sourceEvent.at >= {start:UInt64} AND sourceEvent.at <= {end:UInt64}
        AND sourceEvent.agentMonitored = 1
      GROUP BY eventId
      HAVING monitored = 1`;
    try {
      const [dimensionResult, bucketResult, sessionResult, workspaceResult] = await Promise.all([
        this.client.query({
          query: `
            SELECT
              if(at < {start:UInt64}, 'previous', 'current') AS period,
              agentMonitored AS monitored,
              verdict,
              tier,
              riskType,
              riskCategory,
              riskName,
              uniqExact(eventId) AS eventCount,
              sum(tokenCount) AS tokenCount,
              sum(latencyMs) AS latencyTotal,
              sum(riskScore) AS riskScoreTotal
            FROM (
              SELECT *
              FROM ${TABLE}
              WHERE at >= {queryStart:UInt64} AND at <= {end:UInt64}
              ORDER BY decisionRevision DESC, decisionUpdatedAt DESC, at DESC
              LIMIT 1 BY eventId
            )
            WHERE decisionStatus IN ('succeeded', 'failed', 'timeout')
            GROUP BY period, monitored, verdict, tier, riskType, riskCategory, riskName`,
          query_params: { queryStart: queryStartMs, start: startMs, end: endMs },
          format: 'JSONEachRow',
        }),
        this.client.query({
          query: `
            SELECT
              least({bucketCount:UInt32} - 1, intDiv(at - {start:UInt64}, {bucketMs:UInt64})) AS bucketIndex,
              agentMonitored AS monitored,
              uniqExact(eventId) AS eventCount,
              uniqExactIf(eventId, verdict = 'block' AND decisionStatus IN ('succeeded', 'failed', 'timeout')) AS blockedCount,
              uniqExactIf(eventId, verdict = 'escalate' AND decisionStatus IN ('succeeded', 'failed', 'timeout')) AS escalatedCount,
              uniqExactIf(eventId, tier IN ('Llm', 'Agent') AND decisionStatus IN ('succeeded', 'failed', 'timeout')) AS l2Count,
              uniqExactIf(eventId, tier = 'Agent' AND decisionStatus IN ('succeeded', 'failed', 'timeout')) AS l3Count,
              uniqExactIf(eventId, verdict != 'allow' AND decisionStatus IN ('succeeded', 'failed', 'timeout')) AS riskActivationCount,
              sumIf(tokenCount, decisionStatus IN ('succeeded', 'failed', 'timeout')) AS tokenCount,
              sumIf(latencyMs, decisionStatus IN ('succeeded', 'failed', 'timeout')) AS latencyTotal,
              sumIf(riskScore, decisionStatus IN ('succeeded', 'failed', 'timeout')) AS riskScoreTotal
            FROM (
              SELECT *
              FROM ${TABLE}
              WHERE at >= {start:UInt64} AND at <= {end:UInt64}
              ORDER BY decisionRevision DESC, decisionUpdatedAt DESC, at DESC
              LIMIT 1 BY eventId
            )
            GROUP BY bucketIndex, monitored
            ORDER BY bucketIndex`,
          query_params: { queryStart: queryStartMs, start: startMs, end: endMs, bucketCount: buckets, bucketMs },
          format: 'JSONEachRow',
        }),
        this.client.query({
          query: `
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
          query_params: { start: startMs, end: endMs },
          format: 'JSONEachRow',
        }),
        this.client.query({
          query: `
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
              uniqExact(
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
          query_params: { start: startMs, end: endMs },
          format: 'JSONEachRow',
        }),
      ]);
      const num = (value: unknown): number => Number(value) || 0;
      const dimensions = (await dimensionResult.json() as Array<Record<string, unknown>>).map<DashboardWindowDimensionRow>((row) => ({
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
      const bucketRows = (await bucketResult.json() as Array<Record<string, unknown>>).map<DashboardWindowBucketRow>((row) => ({
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
      const sessionRows = await sessionResult.json() as Array<Record<string, unknown>>;
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
      const workspaces = (await workspaceResult.json() as Array<Record<string, unknown>>).map((row) => ({
        workspacePath: String(row.resolvedWorkspacePath ?? ''),
        sessionCount: num(row.sessionCount),
        totalRiskScore: num(row.totalRiskScore),
        worstSeverityRank: num(row.worstSeverityRank),
      }));
      return { dimensions, buckets: bucketRows, topSession, workspaces };
    } catch (error) {
      console.error('[clickhouse] dashboard window aggregation failed:', (error as Error).message);
      return null;
    }
  }

  /** Query durable event history. Identity visibility is deliberately applied by the service
   * after current human-review metadata is resolved; a mutable review decision must never be
   * baked into this immutable evidence query. */
  async searchEvents(input: StoredEventQuery): Promise<JudgedEvent[]> {
    return (await this.searchEventsPage(input)).events;
  }

  /** Query the durable history as latest-per-event facts. Request one extra row so callers can
   * expose pagination completeness without loading the full raw event history into memory. */
  async searchEventsPage(input: StoredEventQuery): Promise<StoredEventSearchResult> {
    if (!this.client) {
      return {
        events: [],
        hasMore: false,
        committedCutoffMs: this.committedCutoffMs(),
        unavailable: true,
      };
    }
    const conditions = ['at >= {since:UInt64}', 'at <= {until:UInt64}'];
    const queryParams: Record<string, string | number> = { since: input.sinceMs, until: input.untilMs };
    const fields: Array<[keyof StoredEventQuery, string]> = [
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
      ['verdict', 'verdict'],
      ['tier', 'tier'],
    ];
    for (const [key, column] of fields) {
      const value = input[key];
      if (typeof value !== 'string' || !value.trim()) continue;
      conditions.push(`${column} = {${String(key)}:String}`);
      queryParams[String(key)] = value.trim();
    }
    if (input.monitoredOnly) conditions.push('agentMonitored = 1');
    const rowLimit = Math.max(1, Math.min(20_000, input.limit));
    queryParams.limit = rowLimit + 1;
    try {
      const rs = await this.client.query({
        query: `SELECT *
          FROM (
            SELECT *
            FROM ${TABLE}
            WHERE ${conditions.join(' AND ')}
            ORDER BY decisionRevision DESC, decisionUpdatedAt DESC, at DESC
            LIMIT 1 BY eventId
          )
          ORDER BY at DESC, eventId DESC
          LIMIT {limit:UInt32}`,
        query_params: queryParams,
        format: 'JSONEachRow',
      });
      const rows = (await rs.json()) as Array<Record<string, unknown>>;
      const hasMore = rows.length > rowLimit;
      return {
        events: rows.slice(0, rowLimit).map(fromRow),
        hasMore,
        committedCutoffMs: this.committedCutoffMs(),
      };
    } catch (err) {
      console.error('[clickhouse] event search failed:', (err as Error).message);
      return {
        events: [],
        hasMore: false,
        committedCutoffMs: this.committedCutoffMs(),
        unavailable: true,
      };
    }
  }

  /**
   * Return one aggregate fact per logical identity and concrete runtime instance for the complete
   * persisted interval.
   * The inner query first collapses judgment revisions by eventId. This keeps the response bounded
   * by Agent identities rather than raw event volume while preserving exact counters.
   */
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
    const validInstanceClause = monitoredOnly
      ? `
        AND agentInstanceKey IN (
          SELECT agentInstanceKey
          FROM ${TABLE}
          WHERE at >= {since:UInt64} AND at <= {until:UInt64}
            AND agentMonitored = 1
            AND agentInstanceKey != ''
          GROUP BY agentInstanceKey
          HAVING
            max(agentHasPhysicalIdentity) = 1
            OR maxIf(
              agentHasRootIdentity,
              eventKind != 'ProcessExit' AND agentHasInternalHelperRoot = 0
            ) = 1
        )`
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
        argMax(agentIdentityKey, tuple(decisionRevision, decisionUpdatedAt, at)) AS identityKey,
        argMax(agentInstanceKey, tuple(decisionRevision, decisionUpdatedAt, at)) AS instanceKey,
        argMax(agentMonitored, tuple(decisionRevision, decisionUpdatedAt, at)) AS agentMonitored,
        argMax(agentHasPhysicalIdentity, tuple(decisionRevision, decisionUpdatedAt, at)) AS hasPhysicalIdentity,
        argMax(
          agentHasRootIdentity,
          tuple(decisionRevision, decisionUpdatedAt, at)
        ) AS storedHasRootIdentity,
        argMax(
          agentHasInternalHelperRoot,
          tuple(decisionRevision, decisionUpdatedAt, at)
        ) AS hasInternalHelperRoot
      FROM ${TABLE}
      WHERE at >= {since:UInt64} AND at <= {until:UInt64}
        ${validInstanceClause}
        AND eventId NOT IN {excludedEventIds:Array(String)}
      GROUP BY eventId
      HAVING 1 ${monitoredClause}`;
    try {
      const result = await this.client.query({
        query: `
          SELECT
            identityKey,
            instanceKey,
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
            maxIf(
              storedHasRootIdentity,
              hasInternalHelperRoot = 0 AND eventKind != 'ProcessExit'
            ) AS hasRootIdentity,
            max(hasInternalHelperRoot) AS hasInternalHelperRootFlag,
            argMax(eventId, eventAt) AS representativeEventId
          FROM (${latestEvents})
          GROUP BY identityKey, instanceKey`,
        query_params: { since: sinceMs, until: untilMs, excludedEventIds },
        format: 'JSONEachRow',
      });
      const rows = eligibleAgentRuntimeRows(
        await result.json() as Array<Record<string, unknown>>,
      );
      const representativeIds = rows
        .map((row) => String(row.representativeEventId ?? ''))
        .filter(Boolean);
      const representativeEventTimes = new Map(
        rows.map((row) => [
          String(row.representativeEventId ?? ''),
          Number(row.lastSeenAt) || 0,
        ] as const),
      );
      const representativeEvents = await this.eventsByIds(
        representativeIds,
        sinceMs,
        untilMs,
        representativeEventTimes,
      );
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
          hasInternalHelperRoot: Boolean(num(row.hasInternalHelperRootFlag)),
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
    const validInstanceClause = monitoredOnly
      ? `
              AND agentInstanceKey IN (
                SELECT agentInstanceKey
                FROM ${TABLE}
                WHERE at >= {since:UInt64} AND at < {endExclusive:UInt64}
                  AND agentMonitored = 1
                  AND agentInstanceKey != ''
                GROUP BY agentInstanceKey
                HAVING
                  max(agentHasPhysicalIdentity) = 1
                  OR maxIf(
                    agentHasRootIdentity,
                    eventKind != 'ProcessExit' AND agentHasInternalHelperRoot = 0
                  ) = 1
              )`
      : '';
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
            maxIf(
              storedHasRootIdentity,
              hasInternalHelperRoot = 0 AND eventKind != 'ProcessExit'
            ) AS hasRootIdentity,
            max(hasInternalHelperRoot) AS hasInternalHelperRootFlag,
            argMax(eventId, eventAt) AS representativeEventId
          FROM (
            SELECT
              eventId,
              argMax(at, tuple(decisionRevision, decisionUpdatedAt, at)) AS eventAt,
              argMax(eventKind, tuple(decisionRevision, decisionUpdatedAt, at)) AS eventKind,
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
              argMax(
                agentHasRootIdentity,
                tuple(decisionRevision, decisionUpdatedAt, at)
              ) AS storedHasRootIdentity,
              argMax(
                agentHasInternalHelperRoot,
                tuple(decisionRevision, decisionUpdatedAt, at)
              ) AS hasInternalHelperRoot
            FROM ${TABLE}
            WHERE at >= {since:UInt64} AND at < {endExclusive:UInt64}
              ${validInstanceClause}
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
      const rows = eligibleAgentRuntimeRows(
        await result.json() as Array<Record<string, unknown>>,
      );
      const representativeIds = rows
        .map((row) => String(row.representativeEventId ?? ''))
        .filter(Boolean);
      const representativeEventTimes = new Map(
        rows.map((row) => [
          String(row.representativeEventId ?? ''),
          Number(row.lastSeenAt) || 0,
        ] as const),
      );
      const representativeEvents = await this.eventsByIds(
        representativeIds,
        sinceMs,
        Math.max(sinceMs, endExclusiveMs - 1),
        representativeEventTimes,
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
          hasInternalHelperRoot: Boolean(num(row.hasInternalHelperRootFlag)),
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
    hydrateRepresentatives = true,
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
            argMax(agentId, eventAt) AS agentId,
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
            max(eventAt) AS representativeEventAt,
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
              argMax(agentId, tuple(decisionRevision, decisionUpdatedAt, at)) AS agentId,
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
      const groupFor = (row: Record<string, unknown>): string =>
        `${String(row.identityKey ?? '')}\u0000${String(row.instanceKey ?? '')}`;
      const representativeRowByGroup = new Map<string, Record<string, unknown>>();
      for (const row of rows) {
        const key = groupFor(row);
        const current = representativeRowByGroup.get(key);
        if (
          !current ||
          Number(row.representativeEventAt) >= Number(current.representativeEventAt)
        ) {
          representativeRowByGroup.set(key, row);
        }
      }
      const representativeRows = hydrateRepresentatives
        ? [...representativeRowByGroup.values()]
        : [];
      const representativeIds = representativeRows
        .map((row) => String(row.representativeEventId ?? ''))
        .filter(Boolean);
      const representativeEventTimes = new Map(
        representativeRows.map((row) => [
          String(row.representativeEventId ?? ''),
          Number(row.representativeEventAt) || 0,
        ] as const),
      );
      const representativeEvents = await this.eventsByIds(
        representativeIds,
        sinceMs,
        untilMs,
        representativeEventTimes,
      );
      const byId = new Map(representativeEvents.map((event) => [event.eventId, event]));
      const representativeEventByGroup = new Map(
        representativeRows.flatMap((row) => {
          const event = byId.get(String(row.representativeEventId ?? ''));
          return event ? [[groupFor(row), event] as const] : [];
        }),
      );
      const num = (value: unknown): number => Number(value) || 0;
      return rows.flatMap((row): StoredAgentMetricBucketFact[] => {
        const representativeEvent = representativeEventByGroup.get(groupFor(row));
        if (hydrateRepresentatives && !representativeEvent) return [];
        return [{
          bucketIndex: num(row.bucketIndex),
          identityKey: String(row.identityKey ?? ''),
          agentId: String(row.agentId ?? ''),
          ...(representativeEvent ? { representativeEvent } : {}),
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

  /**
   * Return the global values needed by the overview observability strip. Unlike the per-agent
   * metric query above, this intentionally aggregates in ClickHouse before crossing the process
   * boundary: the overview needs exact totals and distinct IDs, not one row per identity/instance.
   */
  async agentObservabilityFact(
    sinceMs: number,
    untilMs: number,
    monitoredOnly: boolean,
  ): Promise<StoredAgentObservabilityFact | null> {
    if (!this.client || !this.ready) return null;
    if (untilMs < sinceMs) {
      return {
        eventCount: 0,
        riskyEventCount: 0,
        latencyTotal: 0,
        agentIds: [],
        recentEventCount: 0,
        recentCommCount: 0,
        recentSessionKeys: [],
      };
    }
    const monitoredClause = monitoredOnly ? 'AND agentMonitored = 1' : '';
    try {
      const result = await this.client.query({
        query: `
          SELECT
            count() AS eventCount,
            countIf(verdict != 'allow') AS riskyEventCount,
            sum(latencyMs) AS latencyTotal,
            groupUniqArray(agentId) AS agentIds,
            countIf(eventAt > {recentSince:UInt64}) AS recentEventCount,
            countIf(eventAt > {recentSince:UInt64} AND eventKind IN ('Egress', 'Dns')) AS recentCommCount,
            groupUniqArrayIf(sessionId, eventAt > {recentSince:UInt64}) AS recentSessionKeys
          FROM (
            SELECT
              at AS eventAt,
              eventKind,
              sessionId,
              verdict,
              latencyMs,
              agentId,
              agentMonitored
            FROM ${TABLE}
            PREWHERE at >= {since:UInt64} AND at <= {until:UInt64}
            ORDER BY decisionRevision DESC, decisionUpdatedAt DESC, at DESC
            LIMIT 1 BY eventId
          )
          WHERE 1 ${monitoredClause}`,
        query_params: {
          since: sinceMs,
          until: untilMs,
          recentSince: Math.max(sinceMs, untilMs - 60_000),
        },
        format: 'JSONEachRow',
      });
      const rows = await result.json() as Array<Record<string, unknown>>;
      const row = rows[0] ?? {};
      const num = (value: unknown): number => Number(value) || 0;
      return {
        eventCount: num(row.eventCount),
        riskyEventCount: num(row.riskyEventCount),
        latencyTotal: num(row.latencyTotal),
        agentIds: Array.isArray(row.agentIds) ? row.agentIds.map(String).filter(Boolean) : [],
        recentEventCount: num(row.recentEventCount),
        recentCommCount: num(row.recentCommCount),
        recentSessionKeys: Array.isArray(row.recentSessionKeys)
          ? row.recentSessionKeys.map(String).filter(Boolean)
          : [],
      };
    } catch (error) {
      console.error('[clickhouse] agent observability query failed:', (error as Error).message);
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
                  agentMonitored = 1
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
                  agentMonitored = 1
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
    monitoredOnly: boolean,
    excludedEventIds: string[] = [],
  ): Promise<StoredTopologyWindowFact[] | null> {
    if (!this.client || !this.ready) return null;
    const monitoredClause = monitoredOnly ? 'HAVING agentMonitored = 1' : '';
    const validInstanceClause = monitoredOnly
      ? `
              AND agentInstanceKey IN (
                SELECT agentInstanceKey
                FROM ${TABLE}
                WHERE at >= {since:UInt64} AND at <= {until:UInt64}
                  AND agentMonitored = 1
                  AND agentInstanceKey != ''
                GROUP BY agentInstanceKey
                HAVING
                  max(agentHasPhysicalIdentity) = 1
                  OR maxIf(
                    agentHasRootIdentity,
                    eventKind != 'ProcessExit' AND agentHasInternalHelperRoot = 0
                  ) = 1
              )`
      : '';
    try {
      const result = await this.client.query({
        query: `
          SELECT
            identityKey,
            instanceKey,
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
            max(hasPhysicalIdentity) AS hasPhysicalIdentity,
            maxIf(
              storedHasRootIdentity,
              hasInternalHelperRoot = 0 AND eventKind != 'ProcessExit'
            ) AS hasRootIdentity,
            max(hasInternalHelperRoot) AS hasInternalHelperRootFlag,
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
              argMax(agentInstanceKey, tuple(decisionRevision, decisionUpdatedAt, at)) AS instanceKey,
              argMax(agentMonitored, tuple(decisionRevision, decisionUpdatedAt, at)) AS agentMonitored,
              argMax(agentHasPhysicalIdentity, tuple(decisionRevision, decisionUpdatedAt, at)) AS hasPhysicalIdentity,
              argMax(
                agentHasRootIdentity,
                tuple(decisionRevision, decisionUpdatedAt, at)
              ) AS storedHasRootIdentity,
              argMax(
                agentHasInternalHelperRoot,
                tuple(decisionRevision, decisionUpdatedAt, at)
              ) AS hasInternalHelperRoot
            FROM ${TABLE}
            WHERE at >= {since:UInt64} AND at <= {until:UInt64}
              ${validInstanceClause}
              AND eventId NOT IN {excludedEventIds:Array(String)}
            GROUP BY eventId
            ${monitoredClause}
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
          instanceKey: String(row.instanceKey ?? ''),
          representativeEvent,
          hasPhysicalIdentity: Boolean(num(row.hasPhysicalIdentity)),
          hasRootIdentity: Boolean(num(row.hasRootIdentity)),
          hasInternalHelperRoot: Boolean(num(row.hasInternalHelperRootFlag)),
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
    monitoredOnly: boolean,
  ): Promise<StoredTopologyBucketFact[] | null> {
    if (!this.client || !this.ready) return null;
    const monitoredClause = monitoredOnly ? 'HAVING agentMonitored = 1' : '';
    const validInstanceClause = monitoredOnly
      ? `
              AND agentInstanceKey IN (
                SELECT agentInstanceKey
                FROM ${TABLE}
                WHERE at >= {since:UInt64} AND at < {endExclusive:UInt64}
                  AND agentMonitored = 1
                  AND agentInstanceKey != ''
                GROUP BY agentInstanceKey
                HAVING
                  max(agentHasPhysicalIdentity) = 1
                  OR maxIf(
                    agentHasRootIdentity,
                    eventKind != 'ProcessExit' AND agentHasInternalHelperRoot = 0
                  ) = 1
              )`
      : '';
    try {
      const result = await this.client.query({
        query: `
          SELECT
            intDiv(eventAt, {bucketMs:UInt64}) * {bucketMs:UInt64} AS bucketStartMs,
            identityKey,
            instanceKey,
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
            max(hasPhysicalIdentity) AS hasPhysicalIdentity,
            maxIf(
              storedHasRootIdentity,
              hasInternalHelperRoot = 0 AND eventKind != 'ProcessExit'
            ) AS hasRootIdentity,
            max(hasInternalHelperRoot) AS hasInternalHelperRootFlag,
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
              argMax(agentInstanceKey, tuple(decisionRevision, decisionUpdatedAt, at)) AS instanceKey,
              argMax(agentMonitored, tuple(decisionRevision, decisionUpdatedAt, at)) AS agentMonitored,
              argMax(agentHasPhysicalIdentity, tuple(decisionRevision, decisionUpdatedAt, at)) AS hasPhysicalIdentity,
              argMax(
                agentHasRootIdentity,
                tuple(decisionRevision, decisionUpdatedAt, at)
              ) AS storedHasRootIdentity,
              argMax(
                agentHasInternalHelperRoot,
                tuple(decisionRevision, decisionUpdatedAt, at)
              ) AS hasInternalHelperRoot
            FROM ${TABLE}
            WHERE at >= {since:UInt64} AND at < {endExclusive:UInt64}
              ${validInstanceClause}
            GROUP BY eventId
            ${monitoredClause}
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
          instanceKey: String(row.instanceKey ?? ''),
          representativeEvent,
          hasPhysicalIdentity: Boolean(num(row.hasPhysicalIdentity)),
          hasRootIdentity: Boolean(num(row.hasRootIdentity)),
          hasInternalHelperRoot: Boolean(num(row.hasInternalHelperRootFlag)),
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

  private async eventsByIds(
    eventIds: string[],
    sinceMs?: number,
    untilMs?: number,
    eventAtById?: ReadonlyMap<string, number>,
  ): Promise<JudgedEvent[]> {
    if (!this.client || eventIds.length === 0) return [];
    // ClickHouse's HTTP interface limits the size of one form field. Topology aggregation can
    // legitimately produce thousands of representative event IDs, so a single Array(String)
    // parameter eventually fails with "HTML Form Exception: Field value too long". Keep each
    // request bounded and use only a small amount of concurrency to avoid replacing one memory
    // spike with many simultaneous scans.
    const uniqueEventIds = [...new Set(eventIds.filter(Boolean))];
    const batches: string[][] = [];
    // Keep both the UUID-like ID parameter and the optional exact event-time parameter below
    // ClickHouse's per-form-field limit. Exact-time lookup makes each scan narrow enough that four
    // smaller requests are cheaper and more reliable than one oversized HTTP form.
    const batchSize = 200;
    for (let index = 0; index < uniqueEventIds.length; index += batchSize) {
      batches.push(uniqueEventIds.slice(index, index + batchSize));
    }
    const events: JudgedEvent[] = [];
    for (let index = 0; index < batches.length; index += 2) {
      const rows = await Promise.all(
        batches.slice(index, index + 2).map(async (batch) => {
          const exactEventTimes = eventAtById
            ? [...new Set(batch.map((eventId) => eventAtById.get(eventId) ?? 0))]
                .filter((at) => at > 0)
            : [];
          const prewhereClause = exactEventTimes.length
            ? 'PREWHERE at IN {eventTimes:Array(UInt64)}'
            : sinceMs === undefined || untilMs === undefined
              ? ''
              : 'PREWHERE at >= {since:UInt64} AND at <= {until:UInt64}';
          const result = await this.client!.query({
            query: `
              SELECT *
              FROM (
                SELECT *
                FROM ${TABLE}
                ${prewhereClause}
                WHERE eventId IN {eventIds:Array(String)}
                ORDER BY decisionRevision DESC, decisionUpdatedAt DESC, at DESC
                LIMIT 1 BY eventId
              )`,
            query_params: {
              eventIds: batch,
              eventTimes: exactEventTimes,
              since: sinceMs ?? 0,
              until: untilMs ?? Number.MAX_SAFE_INTEGER,
            },
            format: 'JSONEachRow',
          });
          return await result.json() as Array<Record<string, unknown>>;
        }),
      );
      events.push(...rows.flat().map(fromRow));
    }
    return events;
  }

  committedCutoffMs(): number | undefined {
    // This is only the greatest event time already observed in a successful durable insert, not
    // an arrival-completeness watermark. An older event or Revision waiting in the writer must not
    // move this value backwards: doing so hides newer facts that are already queryable in
    // ClickHouse (especially while replaying a backlog). Once the pending write succeeds, the
    // commit journal invalidates every affected historical bucket.
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

  async saveCollectorHeartbeats(records: CollectorHeartbeatRecord[]): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.insert({
        table: CONFIG_TABLE,
        values: [{ key: 'collector_heartbeats', value: JSON.stringify(records), updated_at: Date.now() }],
        format: 'JSONEachRow',
      });
    } catch (err) {
      console.error('[clickhouse] saveCollectorHeartbeats failed:', (err as Error).message);
    }
  }

  async close(): Promise<void> {
    if (this.closed || this.closing) return;
    this.closing = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = undefined;
    if (this.immediateWriteTimer) clearTimeout(this.immediateWriteTimer);
    this.immediateWriteTimer = undefined;
    const timeoutMs = boundedPositiveInt(
      process.env.ANYSENTRY_CLICKHOUSE_SHUTDOWN_FLUSH_MS,
      10_000,
      100,
      60_000,
    );
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.flush(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error(`ClickHouse shutdown flush exceeded ${timeoutMs}ms`)),
            timeoutMs,
          );
        }),
      ]);
    } catch (error) {
      console.error('[clickhouse] bounded shutdown flush failed:', (error as Error).message);
    } finally {
      if (timeout) clearTimeout(timeout);
      this.closed = true;
      const shutdownError = new Error('ClickHouse store closed before event receipt became durable');
      for (const entry of this.immediateWriteQueue.splice(0)) entry.reject(shutdownError);
      this.immediateWriteQueueBytes = 0;
      this.immediateWriteEventTimes.clear();
    }
    await this.client?.close().catch(() => undefined);
    this.client = undefined;
    this.ready = false;
    this.closing = false;
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }
}
