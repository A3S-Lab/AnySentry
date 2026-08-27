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
import {
  agentIdentityKeyForEvent,
  agentRuntimeInstanceIdForEvent,
  hasDirectAgentRootEvidence,
  isInternalAgentHelperRootEvent,
} from './agent-identity';
import { eventActivityContext, eventActivitySubtype, normalizeActivitySemantics } from './activity-context';
import { correlationCaptureRollout } from './correlation-rollout';
import { visibleClassificationSemantics, visibleProcessContext } from './classification-semantics';
import { foldLatestEventRevisions } from './event-revision';
import type { ProcessLifecycleFact } from './process-lifecycle';
import {
  BucketCommitCursor,
  compareEventCommitCursor,
  PersistedDashboardBucket,
  validPersistedDashboardBuckets,
} from './persisted-dashboard-bucket';
import { PolicyConfig } from './policy-config';
import { parseTrustedCorrelation } from './trusted-correlation';
import {
  TOOL_EVIDENCE_RELATION_VERSION,
  toolEvidenceIndexFields,
  type ToolEvidenceItem,
} from './tool-evidence-linker';
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
const OBSERVER_SOURCE_PAYLOAD_SHA256_ATTRIBUTE = 'anysentry.observer.source_payload_sha256';
const SHA256_HEX = /^[a-f0-9]{64}$/u;
// `at` is raw epoch-ms (matches the aggregator); `ts` is a derived DateTime only for TTL/partitioning.
const DDL = (table: string) => `CREATE TABLE IF NOT EXISTS ${table} (
  schemaVersion LowCardinality(String),
  eventId String,
  sourceEventId String DEFAULT '',
  at UInt64,
  eventAtUnixNs String DEFAULT '',
  receivedAtUnixNs String DEFAULT '',
  receivedAt UInt64 DEFAULT 0,
  eventTimeQuality LowCardinality(String) DEFAULT 'api_received',
  captureEpoch UInt64 DEFAULT 0,
  captureProfileCode UInt8 DEFAULT 0,
  captureActionCode UInt8 DEFAULT 0,
  captureAuthorityCode UInt8 DEFAULT 0,
  captureDispositionCode UInt8 DEFAULT 0,
  captureSelected UInt8 DEFAULT 0,
  captureFlags UInt8 DEFAULT 0,
  capturePolicyVersion UInt64 DEFAULT 0,
  ingestedAt UInt64 DEFAULT at,
  commitBatchId String DEFAULT '',
  logicalKeyVersion UInt16 DEFAULT 1,
  eventLogicalKey String DEFAULT '',
  payloadFingerprintVersion UInt16 DEFAULT 1,
  payloadFingerprint String DEFAULT '',
  eventKind LowCardinality(String),
  eventCategory LowCardinality(String),
  activityContext LowCardinality(String) DEFAULT if(eventKind = 'ToolExec', 'agent_action', ''),
  activitySubtype LowCardinality(String) DEFAULT '',
  source LowCardinality(String),
  subject String,
  workspacePath String,
  agentId LowCardinality(String),
  subjectAssetId String DEFAULT '',
  subjectAssetType LowCardinality(String) DEFAULT '',
  assetBindingQuality LowCardinality(String) DEFAULT '',
  assetBindingRevision UInt64 DEFAULT 0,
  assetBindingReason LowCardinality(String) DEFAULT '',
  identityRevision UInt64 DEFAULT 0,
  collectorId String,
  sourceId String,
  sessionId String,
  userId String,
  traceId String,
  invocationId String DEFAULT '',
  toolCallId String DEFAULT '',
  processInstanceKey String DEFAULT '',
  correlationMethod LowCardinality(String) DEFAULT '',
  correlationConfidence Float32 DEFAULT 0,
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
  classificationSemantics String DEFAULT '{}',
  process String DEFAULT '{}',
  processHostId String DEFAULT JSONExtractString(process, 'hostId'),
  processBootId String DEFAULT JSONExtractString(process, 'bootId'),
  processPid UInt64 DEFAULT JSONExtractUInt(process, 'pid'),
  processPpid UInt64 DEFAULT JSONExtractUInt(process, 'ppid'),
  processPidNamespace String DEFAULT JSONExtractString(process, 'pidNamespace'),
  processNamespacePid UInt64 DEFAULT JSONExtractUInt(process, 'namespacePid'),
  processNamespacePpid UInt64 DEFAULT JSONExtractUInt(process, 'namespacePpid'),
  processStartTimeTicks String DEFAULT JSONExtractString(process, 'startTimeTicks'),
  processStartTimeNs String DEFAULT JSONExtractString(process, 'startTimeNs'),
  evidenceResourceHash String DEFAULT multiIf(
    eventKind = 'AgentTool', JSONExtractString(attributes, 'anysentry.tool.resource_hash'),
    eventKind IN ('FileAccess', 'FileDelete') AND startsWith(JSONExtractString(attributes, 'path'), '/'),
      lower(hex(SHA256(JSONExtractString(attributes, 'path')))),
    ''
  ),
  evidenceCommandHash String DEFAULT multiIf(
    eventKind = 'AgentTool', JSONExtractString(attributes, 'anysentry.tool.command_hash'),
    eventKind = 'ToolExec', JSONExtractString(attributes, 'anysentry.kernel.command_hash'),
    ''
  ),
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
  INDEX idx_event_id eventId TYPE bloom_filter(0.01) GRANULARITY 1,
  INDEX idx_invocation_id invocationId TYPE bloom_filter(0.01) GRANULARITY 1,
  INDEX idx_tool_call_id toolCallId TYPE bloom_filter(0.01) GRANULARITY 1,
  INDEX idx_trace_id traceId TYPE bloom_filter(0.01) GRANULARITY 1,
  INDEX idx_session_id sessionId TYPE bloom_filter(0.01) GRANULARITY 1,
  INDEX idx_run_id runId TYPE bloom_filter(0.01) GRANULARITY 1,
  INDEX idx_subject_asset_id subjectAssetId TYPE bloom_filter(0.01) GRANULARITY 1,
  INDEX idx_agent_instance_key agentInstanceKey TYPE bloom_filter(0.01) GRANULARITY 1,
  INDEX idx_process_boot_id processBootId TYPE bloom_filter(0.01) GRANULARITY 1,
  INDEX idx_process_pid_namespace processPidNamespace TYPE bloom_filter(0.01) GRANULARITY 1,
  INDEX idx_process_host_id processHostId TYPE bloom_filter(0.01) GRANULARITY 1,
  INDEX idx_evidence_resource_hash evidenceResourceHash TYPE bloom_filter(0.01) GRANULARITY 1,
  INDEX idx_evidence_command_hash evidenceCommandHash TYPE bloom_filter(0.01) GRANULARITY 1,
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
// Full-file live validation observed rare successful local inserts at 5.8–6.7s. Aborting them at
// 5s creates an unnecessary ambiguous retry just before QueryFinish. Keep one attempt below the
// Forwarder 10s request deadline and the writer's independent 15s total retry deadline.
const EVENT_WRITE_ATTEMPT_TIMEOUT_MS = 8_000;
const EVENT_WRITE_RETRY_COOLDOWN_MS = 2_000;
const EVENT_WRITE_CLOSE_DEADLINE_MS = 20_000;
const EVENT_WRITE_BACKOFF_BASE_MS = 250;
const EVENT_WRITE_BACKOFF_MAX_MS = 2_000;

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
  "ADD COLUMN IF NOT EXISTS eventAtUnixNs String DEFAULT ''",
  "ADD COLUMN IF NOT EXISTS receivedAtUnixNs String DEFAULT ''",
  'ADD COLUMN IF NOT EXISTS receivedAt UInt64 DEFAULT 0',
  "ADD COLUMN IF NOT EXISTS eventTimeQuality LowCardinality(String) DEFAULT 'api_received'",
  'ADD COLUMN IF NOT EXISTS captureEpoch UInt64 DEFAULT 0',
  'ADD COLUMN IF NOT EXISTS captureProfileCode UInt8 DEFAULT 0',
  'ADD COLUMN IF NOT EXISTS captureActionCode UInt8 DEFAULT 0',
  'ADD COLUMN IF NOT EXISTS captureAuthorityCode UInt8 DEFAULT 0',
  'ADD COLUMN IF NOT EXISTS captureDispositionCode UInt8 DEFAULT 0',
  'ADD COLUMN IF NOT EXISTS captureSelected UInt8 DEFAULT 0',
  'ADD COLUMN IF NOT EXISTS captureFlags UInt8 DEFAULT 0',
  'ADD COLUMN IF NOT EXISTS capturePolicyVersion UInt64 DEFAULT 0',
  'ADD COLUMN IF NOT EXISTS eventCategory LowCardinality(String) DEFAULT \'unknown\'',
  "ADD COLUMN IF NOT EXISTS activityContext LowCardinality(String) DEFAULT if(eventKind = 'ToolExec', 'agent_action', '')",
  "ADD COLUMN IF NOT EXISTS activitySubtype LowCardinality(String) DEFAULT ''",
  'ADD COLUMN IF NOT EXISTS source LowCardinality(String) DEFAULT \'observer\'',
  'ADD COLUMN IF NOT EXISTS collectorId String DEFAULT \'\'',
  'ADD COLUMN IF NOT EXISTS sourceId String DEFAULT \'\'',
  'ADD COLUMN IF NOT EXISTS subjectAssetId String DEFAULT \'\'',
  'ADD COLUMN IF NOT EXISTS subjectAssetType LowCardinality(String) DEFAULT \'\'',
  'ADD COLUMN IF NOT EXISTS assetBindingQuality LowCardinality(String) DEFAULT \'\'',
  'ADD COLUMN IF NOT EXISTS assetBindingRevision UInt64 DEFAULT 0',
  'ADD COLUMN IF NOT EXISTS assetBindingReason LowCardinality(String) DEFAULT \'\'',
  'ADD COLUMN IF NOT EXISTS identityRevision UInt64 DEFAULT 0',
  'ADD COLUMN IF NOT EXISTS traceId String DEFAULT \'\'',
  'ADD COLUMN IF NOT EXISTS invocationId String DEFAULT \'\'',
  'ADD COLUMN IF NOT EXISTS toolCallId String DEFAULT \'\'',
  'ADD COLUMN IF NOT EXISTS processInstanceKey String DEFAULT \'\'',
  'ADD COLUMN IF NOT EXISTS correlationMethod LowCardinality(String) DEFAULT \'\'',
  'ADD COLUMN IF NOT EXISTS correlationConfidence Float32 DEFAULT 0',
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
  'ADD COLUMN IF NOT EXISTS classificationSemantics String DEFAULT \'{}\'',
  'ADD COLUMN IF NOT EXISTS process String DEFAULT \'{}\'',
  "ADD COLUMN IF NOT EXISTS processHostId String DEFAULT JSONExtractString(process, 'hostId')",
  "ADD COLUMN IF NOT EXISTS processBootId String DEFAULT JSONExtractString(process, 'bootId')",
  "ADD COLUMN IF NOT EXISTS processPid UInt64 DEFAULT JSONExtractUInt(process, 'pid')",
  "ADD COLUMN IF NOT EXISTS processPpid UInt64 DEFAULT JSONExtractUInt(process, 'ppid')",
  "ADD COLUMN IF NOT EXISTS processPidNamespace String DEFAULT JSONExtractString(process, 'pidNamespace')",
  "ADD COLUMN IF NOT EXISTS processNamespacePid UInt64 DEFAULT JSONExtractUInt(process, 'namespacePid')",
  "ADD COLUMN IF NOT EXISTS processNamespacePpid UInt64 DEFAULT JSONExtractUInt(process, 'namespacePpid')",
  "ADD COLUMN IF NOT EXISTS processStartTimeTicks String DEFAULT JSONExtractString(process, 'startTimeTicks')",
  "ADD COLUMN IF NOT EXISTS processStartTimeNs String DEFAULT JSONExtractString(process, 'startTimeNs')",
  `ADD COLUMN IF NOT EXISTS evidenceResourceHash String DEFAULT multiIf(
    eventKind = 'AgentTool', JSONExtractString(attributes, 'anysentry.tool.resource_hash'),
    eventKind IN ('FileAccess', 'FileDelete') AND startsWith(JSONExtractString(attributes, 'path'), '/'),
      lower(hex(SHA256(JSONExtractString(attributes, 'path')))),
    ''
  )`,
  `ADD COLUMN IF NOT EXISTS evidenceCommandHash String DEFAULT multiIf(
    eventKind = 'AgentTool', JSONExtractString(attributes, 'anysentry.tool.command_hash'),
    eventKind = 'ToolExec', JSONExtractString(attributes, 'anysentry.kernel.command_hash'),
    ''
  )`,
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
  'ADD COLUMN IF NOT EXISTS judgment String DEFAULT \'{}\'',
  'ADD COLUMN IF NOT EXISTS rawPreview String DEFAULT \'\'',
  'ADD INDEX IF NOT EXISTS idx_event_id eventId TYPE bloom_filter(0.01) GRANULARITY 1',
  'ADD INDEX IF NOT EXISTS idx_invocation_id invocationId TYPE bloom_filter(0.01) GRANULARITY 1',
  'ADD INDEX IF NOT EXISTS idx_tool_call_id toolCallId TYPE bloom_filter(0.01) GRANULARITY 1',
  'ADD INDEX IF NOT EXISTS idx_trace_id traceId TYPE bloom_filter(0.01) GRANULARITY 1',
  'ADD INDEX IF NOT EXISTS idx_session_id sessionId TYPE bloom_filter(0.01) GRANULARITY 1',
  'ADD INDEX IF NOT EXISTS idx_run_id runId TYPE bloom_filter(0.01) GRANULARITY 1',
  'ADD INDEX IF NOT EXISTS idx_subject_asset_id subjectAssetId TYPE bloom_filter(0.01) GRANULARITY 1',
  'ADD INDEX IF NOT EXISTS idx_agent_instance_key agentInstanceKey TYPE bloom_filter(0.01) GRANULARITY 1',
  'ADD INDEX IF NOT EXISTS idx_process_boot_id processBootId TYPE bloom_filter(0.01) GRANULARITY 1',
  'ADD INDEX IF NOT EXISTS idx_process_pid_namespace processPidNamespace TYPE bloom_filter(0.01) GRANULARITY 1',
  'ADD INDEX IF NOT EXISTS idx_process_host_id processHostId TYPE bloom_filter(0.01) GRANULARITY 1',
  'ADD INDEX IF NOT EXISTS idx_evidence_resource_hash evidenceResourceHash TYPE bloom_filter(0.01) GRANULARITY 1',
  'ADD INDEX IF NOT EXISTS idx_evidence_command_hash evidenceCommandHash TYPE bloom_filter(0.01) GRANULARITY 1',
];
const EVENT_EVIDENCE_INDEX_NAMES = [
  'idx_event_id',
  'idx_invocation_id',
  'idx_tool_call_id',
  'idx_trace_id',
  'idx_session_id',
  'idx_run_id',
  'idx_subject_asset_id',
  'idx_agent_instance_key',
  'idx_process_boot_id',
  'idx_process_pid_namespace',
  'idx_process_host_id',
  'idx_evidence_resource_hash',
  'idx_evidence_command_hash',
] as const;
const EVENT_EVIDENCE_INDEX_MIGRATION_KEY = 'schema.events.evidence_indexes.v3';

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

const TOOL_EVIDENCE_RELATION_TABLE = 'tool_evidence_relations';
const TOOL_EVIDENCE_RELATION_DDL = `CREATE TABLE IF NOT EXISTS ${TOOL_EVIDENCE_RELATION_TABLE} (
  invocationId String,
  toolCallId String,
  workspacePath String,
  sourceId String,
  agentInstanceId String,
  relationVersion UInt32,
  evidenceVersion String,
  itemCount UInt32,
  updatedAt UInt64,
  payload String,
  ts DateTime MATERIALIZED toDateTime(intDiv(updatedAt, 1000))
) ENGINE = ReplacingMergeTree(updatedAt)
ORDER BY (invocationId, workspacePath, sourceId, agentInstanceId, toolCallId, relationVersion)
TTL ts + INTERVAL 90 DAY`;

const PROCESS_LIFECYCLE_FACT_TABLE = 'process_lifecycle_facts';
const PROCESS_LIFECYCLE_FACT_DDL = `CREATE TABLE IF NOT EXISTS ${PROCESS_LIFECYCLE_FACT_TABLE} (
  factId String,
  eventId String,
  sourceEventId String,
  factKind LowCardinality(String),
  at UInt64,
  receivedAt UInt64,
  source LowCardinality(String),
  sourceId String,
  collectorId String,
  workspacePath String,
  subjectAssetId String DEFAULT '',
  subjectAssetType LowCardinality(String) DEFAULT '',
  assetBindingQuality LowCardinality(String) DEFAULT '',
  assetBindingRevision UInt64 DEFAULT 0,
  assetBindingReason LowCardinality(String) DEFAULT '',
  runtimeInstanceId String DEFAULT '',
  rootProcess UInt8 DEFAULT 0,
  identityRevision UInt64 DEFAULT 0,
  processInstanceKey String,
  physicalWorkloadId String,
  hostId String,
  bootId String,
  pid UInt64,
  ppid UInt64,
  pidNamespace String,
  namespacePid UInt64,
  namespacePpid UInt64,
  startTime String,
  lifecycleSource LowCardinality(String),
  exitStatus UInt32 DEFAULT 0,
  exitStatusPresent UInt8 DEFAULT 0,
  exitSignal UInt32 DEFAULT 0,
  exitSignalPresent UInt8 DEFAULT 0,
  executableHash String,
  commandHash String,
  ts DateTime MATERIALIZED toDateTime(intDiv(at, 1000)),
  INDEX idx_process_lifecycle_instance processInstanceKey TYPE bloom_filter(0.01) GRANULARITY 1,
  INDEX idx_process_lifecycle_workload physicalWorkloadId TYPE bloom_filter(0.01) GRANULARITY 1
) ENGINE = ReplacingMergeTree(receivedAt)
ORDER BY (processInstanceKey, factKind, at, eventId)
TTL ts + INTERVAL 30 DAY`;

const PROCESS_LIFECYCLE_FACT_ALTERS = [
  'MODIFY COLUMN exitStatus UInt32 DEFAULT 0',
  'ADD COLUMN IF NOT EXISTS exitStatusPresent UInt8 DEFAULT 0 AFTER exitStatus',
  'ADD COLUMN IF NOT EXISTS exitSignal UInt32 DEFAULT 0 AFTER exitStatusPresent',
  'ADD COLUMN IF NOT EXISTS exitSignalPresent UInt8 DEFAULT 0 AFTER exitSignal',
  'ADD COLUMN IF NOT EXISTS subjectAssetId String DEFAULT \'\'',
  'ADD COLUMN IF NOT EXISTS subjectAssetType LowCardinality(String) DEFAULT \'\'',
  'ADD COLUMN IF NOT EXISTS assetBindingQuality LowCardinality(String) DEFAULT \'\'',
  'ADD COLUMN IF NOT EXISTS assetBindingRevision UInt64 DEFAULT 0',
  'ADD COLUMN IF NOT EXISTS assetBindingReason LowCardinality(String) DEFAULT \'\'',
  'ADD COLUMN IF NOT EXISTS runtimeInstanceId String DEFAULT \'\'',
  'ADD COLUMN IF NOT EXISTS rootProcess UInt8 DEFAULT 0',
  'ADD COLUMN IF NOT EXISTS identityRevision UInt64 DEFAULT 0',
];

// Startup progress hydration must stay independent of the cardinality of the 90-day event table.
// The commit journal is ordered by committedAt, so this compatibility sample reads a deterministic
// recent prefix even when the materialized view was added after an older events table already
// existed. It deliberately remains an observed-progress sample, never a completeness claim.
const EVENT_COMMIT_PROGRESS_HYDRATE_ROWS = 100_000;

// These are complete, commit-cursor-qualified bucket snapshots. Revisions replace the complete
// snapshot rather than incrementing a counter, which keeps late judgment updates exact.
const DASHBOARD_BUCKET_SNAPSHOT_TABLE = 'dashboard_bucket_snapshots';
// Cold dashboard snapshots are built from the raw, revisioned event table. At production
// full-file volume a ten-minute fold can approach 400 MiB and monopolise ClickHouse long enough to
// delay ingestion and the Observer control plane. A request only schedules a single-flight worker
// over a few one-minute chunks, returns an explicit hot/partial response immediately, and later
// refreshes resume from the durable buckets already written by earlier workers.
const DASHBOARD_BUCKET_BUILD_CHUNK_MS = 60_000;
const DASHBOARD_BUCKET_BUILD_MAX_CHUNKS = 1;
// DashboardHistory asks for current + previous comparison windows. More than one hour of absolute
// 10-second facts expands tens of MiB of factsJson in Node and can stall health/control requests.
// Longer presets remain available through durable Event search and return an explicit hot/partial
// dashboard until a compact window-level snapshot format is introduced.
const DASHBOARD_PERSISTED_READ_MAX_BUCKETS = 360;
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

// Raw snapshot bootstrap is lower priority than both event ingestion and already-materialised
// dashboard reads. A one-minute chunk fits this tighter budget under the sustained full-file test;
// if it does not, the caller returns the bounded hot view instead of raising the budget or retrying
// another raw scan in the same request.
const BOUNDED_DASHBOARD_BUCKET_BUILD_SETTINGS: ClickHouseSettings = {
  max_threads: 1,
  max_memory_usage: String(128 * 1024 * 1024),
  max_bytes_before_external_group_by: String(32 * 1024 * 1024),
  max_bytes_before_external_sort: String(32 * 1024 * 1024),
  min_bytes_to_use_direct_io: String(1024 * 1024),
  max_execution_time: 5,
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

const BOUNDED_BOOTSTRAP_PROGRESS_READ_SETTINGS: ClickHouseSettings = {
  max_threads: 1,
  max_memory_usage: String(128 * 1024 * 1024),
  max_execution_time: 15,
};

const BOUNDED_TOOL_EVIDENCE_RELATION_SETTINGS: ClickHouseSettings = {
  max_threads: 1,
  max_memory_usage: String(64 * 1024 * 1024),
  max_execution_time: 2,
};

// Startup restores only the latest bounded structural facts. The production 30-minute window was
// measured just above the 64 MiB point-lookup budget, so keep a separate one-thread ceiling rather
// than weakening ToolEvidence's 2-second/64 MiB query contract.
const BOUNDED_PROCESS_LIFECYCLE_READ_SETTINGS: ClickHouseSettings = {
  max_threads: 1,
  max_memory_usage: String(96 * 1024 * 1024),
  max_execution_time: 5,
};

const MAX_DURABLE_EVENT_SEARCH_ROWS = 10_000;

type Row = Omit<JudgedEvent, 'activityContext' | 'activitySubtype' | 'actionKind' | 'actionTarget' | 'attributes' | 'classificationSemantics' | 'process' | 'attribution' | 'judgment' | 'collectorId' | 'sourceId' | 'parentSpanId' | 'taskId' | 'rawPreview' | 'invocationId' | 'toolCallId' | 'captureSelected' | 'subjectAssetType' | 'assetBindingQuality'> & {
  ingestedAt: number;
  commitBatchId: string;
  logicalKeyVersion: number;
  eventLogicalKey: string;
  payloadFingerprintVersion: number;
  payloadFingerprint: string;
  activityContext: string;
  activitySubtype: string;
  actionKind: string;
  actionTarget: string;
  attributes: string;
  classificationSemantics: string;
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
  subjectAssetType: string;
  assetBindingQuality: string;
  invocationId: string;
  toolCallId: string;
  processInstanceKey: string;
  processHostId: string;
  processBootId: string;
  processPid: number;
  processPpid: number;
  processPidNamespace: string;
  processNamespacePid: number;
  processNamespacePpid: number;
  processStartTimeTicks: string;
  processStartTimeNs: string;
  evidenceResourceHash: string;
  evidenceCommandHash: string;
  correlationMethod: string;
  correlationConfidence: number;
  captureSelected: number;
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

const EVENT_REVISION_DIGEST_CACHE_SIZE = 20_000;
const EVENT_REVISION_CONFLICT = 'ANYSENTRY_EVENT_REVISION_CONFLICT';
const EVENT_WRITE_BATCH_TOO_LARGE = 'ANYSENTRY_CLICKHOUSE_EVENT_BATCH_TOO_LARGE';

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
  /** Narrow locator/revision candidates scanned before full evidence rows are materialised. */
  candidateLimit?: number;
  eventId?: string;
  sourceId?: string;
  collectorId?: string;
  agentId?: string;
  subjectAssetId?: string;
  /** Stable concrete runtime identity. Unlike display agentId, this is safe to push down. */
  agentInstanceId?: string;
  sessionId?: string;
  workspacePath?: string;
  traceId?: string;
  /** Trusted invocation identity. This is independent from the legacy traceId predicate. */
  invocationId?: string;
  /** Authenticated Agent adapter ToolCall identity. */
  toolCallId?: string;
  /** Bounded S6 evidence lookup predicates over server-derived scalar columns. */
  processHostId?: string;
  processBootId?: string;
  processPid?: number;
  processPpid?: number;
  processPidNamespace?: string;
  processNamespacePid?: number;
  processNamespacePpid?: number;
  processStartTimeTicks?: string;
  processStartTimeNs?: string;
  evidenceResourceHashes?: string[];
  evidenceCommandHashes?: string[];
  runId?: string;
  eventKind?: string;
  eventCategory?: string;
  activityContext?: string;
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

export interface StoredToolEvidenceRelations {
  items: ToolEvidenceItem[];
  evidenceVersion?: string;
  updatedAt?: number;
}

export interface ToolEvidenceRelationScope {
  workspacePath?: string;
  sourceId?: string;
  agentInstanceId?: string;
}

export interface CommittedSourceProgress {
  sourceId?: string;
  collectorId?: string;
  committedEventTimeMs: number;
  committedAtMs: number;
}

interface ClickHouseBootstrapConfig {
  url: string;
  database: string;
  username: string;
  password: string;
}

interface ClickHouseBootstrapState {
  committedSourceProgress: CommittedSourceProgress[];
}

// Nest can construct several services that each own a ClickHouseStore. Schema work and startup
// progress hydration belong to the process/database target, not to an individual writer. Share only
// the active operation: a later reconnect must validate/rebuild schema against the current server
// and hydrate fresh journal progress rather than reusing a successful but stale snapshot forever.
// The target digest includes credentials without retaining a plaintext password in a module-level
// map key.
const clickHouseBootstrapByTarget = new Map<string, Promise<ClickHouseBootstrapState>>();

function clickHouseBootstrapTargetKey(config: ClickHouseBootstrapConfig): string {
  return createHash('sha256')
    .update(JSON.stringify([config.url, config.database, config.username, config.password]))
    .digest('hex');
}

function sharedClickHouseBootstrap(config: ClickHouseBootstrapConfig): Promise<ClickHouseBootstrapState> {
  const key = clickHouseBootstrapTargetKey(config);
  const current = clickHouseBootstrapByTarget.get(key);
  if (current) return current;

  const operation = runClickHouseBootstrap(config);
  clickHouseBootstrapByTarget.set(key, operation);
  void operation.finally(() => {
    if (clickHouseBootstrapByTarget.get(key) === operation) clickHouseBootstrapByTarget.delete(key);
  }).catch(() => undefined);
  return operation;
}

async function runClickHouseBootstrap(config: ClickHouseBootstrapConfig): Promise<ClickHouseBootstrapState> {
  const credentials = { username: config.username, password: config.password };
  let boot: ClickHouseClient | undefined;
  let schema: ClickHouseClient | undefined;
  try {
    boot = createClient({ url: config.url, ...credentials });
    await boot.command({ query: `CREATE DATABASE IF NOT EXISTS ${config.database}` });
    await boot.close();
    boot = undefined;

    schema = createClient({
      url: config.url,
      database: config.database,
      ...credentials,
    });
    await schema.command({ query: DDL(TABLE) });
    // One metadata transaction is materially cheaper than dozens of sequential ALTERs on a busy
    // MergeTree. Every operation is idempotent, so rolling versions retain the same compatibility.
    await schema.command({ query: `ALTER TABLE ${TABLE} ${EVENT_ALTERS.join(', ')}` });
    await schema.command({
      query: `ALTER TABLE ${TABLE} MODIFY SETTING non_replicated_deduplication_window = ${EVENT_DEDUPLICATION_WINDOW}`,
    });
    await schema.command({ query: CONFIG_DDL });
    try {
      const migrationResult = await schema.query({
        query: `SELECT value FROM ${CONFIG_TABLE} FINAL WHERE key = {key:String} LIMIT 1`,
        query_params: { key: EVENT_EVIDENCE_INDEX_MIGRATION_KEY },
        clickhouse_settings: BOUNDED_BOOTSTRAP_PROGRESS_READ_SETTINGS,
        format: 'JSONEachRow',
      });
      const migrationRows = (await migrationResult.json()) as Array<{ value?: string }>;
      if (!['scheduled', 'complete'].includes(migrationRows[0]?.value ?? '')) {
        await schema.command({
          query: `ALTER TABLE ${TABLE} ${EVENT_EVIDENCE_INDEX_NAMES
            .map((name) => `MATERIALIZE INDEX ${name}`)
            .join(', ')}`,
          // Backfilling ninety days of parts is a server-side mutation and may take minutes. The
          // indexed query remains correct while it runs, so bootstrap must schedule it once rather
          // than blocking every API replica behind the HTTP command timeout.
          clickhouse_settings: { mutations_sync: '0' },
        });
        await schema.insert({
          table: CONFIG_TABLE,
          values: [{
            key: EVENT_EVIDENCE_INDEX_MIGRATION_KEY,
            value: 'scheduled',
            updated_at: Date.now(),
          }],
          format: 'JSONEachRow',
        });
      }
    } catch (error) {
      // Existing data remains queryable without materialized skipping indexes. Do not claim the
      // migration complete; a later healthy bootstrap retries it.
      console.warn('[clickhouse] evidence index backfill deferred:',
        error instanceof Error ? error.message : String(error));
    }
    await schema.command({ query: COLLECTOR_HEARTBEAT_DDL });
    await schema.command({ query: NOTIFICATION_DELIVERY_DDL });
    await schema.command({ query: IDENTITY_AI_REVIEW_DDL });
    await schema.command({ query: AUDIT_FACT_DDL });
    await schema.command({ query: EVENT_COMMIT_FACT_DDL });
    await schema.command({ query: EVENT_COMMIT_FACT_MV_DDL });
    await schema.command({ query: EVENT_REVISION_CONFLICT_DDL });
    await schema.command({ query: EVENT_REVISION_IDENTITY_DDL });
    await schema.command({ query: EVENT_REVISION_IDENTITY_MV_DDL });
    await schema.command({ query: SOURCE_COMMIT_PROGRESS_DDL });
    await schema.command({ query: SOURCE_COMMIT_PROGRESS_MV_DDL });
    await schema.command({ query: TOOL_EVIDENCE_RELATION_DDL });
    await schema.command({ query: PROCESS_LIFECYCLE_FACT_DDL });
    await schema.command({
      query: `ALTER TABLE ${PROCESS_LIFECYCLE_FACT_TABLE} ${PROCESS_LIFECYCLE_FACT_ALTERS.join(', ')}`,
    });
    await schema.command({ query: DASHBOARD_BUCKET_SNAPSHOT_DDL });
    await schema.command({
      query: `ALTER TABLE ${DASHBOARD_BUCKET_SNAPSHOT_TABLE}
        ADD COLUMN IF NOT EXISTS snapshotCommitBatchId String DEFAULT ''
        AFTER snapshotCommittedAt`,
    });
    await schema.command({
      query: `ALTER TABLE ${DASHBOARD_BUCKET_SNAPSHOT_TABLE}
        ADD COLUMN IF NOT EXISTS snapshotSchemaVersion LowCardinality(String)
        DEFAULT 'anysentry.dashboard-bucket-snapshot.v2' AFTER snapshotVersion`,
    });
    await schema.command({
      query: `ALTER TABLE ${DASHBOARD_BUCKET_SNAPSHOT_TABLE}
        ADD COLUMN IF NOT EXISTS status LowCardinality(String) DEFAULT 'ready'
        AFTER snapshotSchemaVersion`,
    });
    await schema.command({
      query: `ALTER TABLE ${DASHBOARD_BUCKET_SNAPSHOT_TABLE}
        ADD COLUMN IF NOT EXISTS payloadChecksum String DEFAULT ''
        AFTER factsJson`,
    });

    // A materialized view does not retroactively populate rows that predate its creation. Read only
    // a bounded recent journal prefix for per-source observed progress. Missing older sources stay
    // absent instead of being presented as complete coverage. In particular this partial journal
    // must not initialize the global committed cutoff: without an explicit full-backfill marker the
    // dashboard safely performs its ordinary durable query rather than truncating at a false split.
    let committedSourceProgress: CommittedSourceProgress[] = [];
    try {
      const progress = await schema.query({
        query: `
          SELECT
            sourceId,
            collectorId,
            max(eventAt) AS committedThrough,
            max(committedAt) AS committedAt
          FROM (
            SELECT sourceId, collectorId, eventAt, committedAt
            FROM ${EVENT_COMMIT_FACT_TABLE}
            ORDER BY committedAt DESC, commitBatchId DESC, eventId DESC, decisionRevision DESC
            LIMIT {journalRows:UInt32}
          )
          GROUP BY sourceId, collectorId`,
        query_params: { journalRows: EVENT_COMMIT_PROGRESS_HYDRATE_ROWS },
        clickhouse_settings: BOUNDED_BOOTSTRAP_PROGRESS_READ_SETTINGS,
        format: 'JSONEachRow',
      });
      const progressRows = (await progress.json()) as Array<{
        sourceId?: string;
        collectorId?: string;
        committedThrough?: string | number;
        committedAt?: string | number;
      }>;
      committedSourceProgress = progressRows.flatMap((row): CommittedSourceProgress[] => {
        const committedEventTimeMs = Number(row.committedThrough);
        if (!Number.isFinite(committedEventTimeMs) || committedEventTimeMs <= 0) return [];
        return [{
          sourceId: row.sourceId?.trim() || undefined,
          collectorId: row.collectorId?.trim() || undefined,
          committedEventTimeMs,
          committedAtMs: Number(row.committedAt) || committedEventTimeMs,
        }];
      });
    } catch (error) {
      // Progress is query metadata, not a prerequisite for durable reads/writes. Failing closed to
      // no boundary is correct and lets a healthy schema/client become ready under read pressure.
      console.warn('[clickhouse] bounded startup progress hydration unavailable:',
        error instanceof Error ? error.message : String(error));
    }
    return { committedSourceProgress };
  } finally {
    await boot?.close().catch(() => undefined);
    await schema?.close().catch(() => undefined);
  }
}

export interface EventCommitCursor {
  committedAtMs: number;
  commitBatchId?: string;
  eventId: string;
  decisionRevision: number;
}

export type DurableReplayEventStatus = 'new' | 'duplicate' | 'conflict';

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
  const evidenceByRuntime = new Map<
    string,
    { physical: boolean; root: boolean; helper: boolean }
  >();
  for (const row of rows) {
    const key = groupFor(row);
    const evidence = evidenceByRuntime.get(key) ?? {
      physical: false,
      root: false,
      helper: false,
    };
    evidence.physical ||= Boolean(Number(row.hasPhysicalIdentity) || 0);
    evidence.root ||= Boolean(Number(row.hasRootIdentity) || 0);
    evidence.helper ||= Boolean(Number(row.hasInternalHelperRootFlag) || 0);
    evidenceByRuntime.set(key, evidence);
  }
  return rows.filter((row) => {
    const evidence = evidenceByRuntime.get(groupFor(row));
    return Boolean(evidence && (evidence.physical || evidence.root) && !evidence.helper);
  });
}

export interface StoredAgentMetricBucketFact {
  bucketIndex: number;
  identityKey: string;
  agentId?: string;
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

/**
 * Return the durable identity of one immutable Canonical Revision.
 *
 * Transport retries may change writer and commit metadata, but they must retain the same
 * fingerprint. A real semantic change must advance decisionRevision instead of silently replacing
 * the payload claimed by the existing logical key.
 */
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
  const canonicalPayload = { ...e } as Record<string, unknown>;
  delete canonicalPayload.ingestedAt;
  delete canonicalPayload.storeCommittedAt;
  delete canonicalPayload.commitBatchId;
  delete canonicalPayload.kafkaOffset;
  delete canonicalPayload.deliveryAttempt;
  const canonicalAttributes = { ...(e.attributes ?? {}) } as Record<string, unknown>;
  delete canonicalAttributes.commitRequestBatchId;
  delete canonicalAttributes.writerId;
  delete canonicalAttributes.writerVersion;
  delete canonicalAttributes.idempotencyProtocolVersion;
  canonicalPayload.attributes = canonicalAttributes;
  const sourcePayloadDigest = attrString(e.attributes, OBSERVER_SOURCE_PAYLOAD_SHA256_ATTRIBUTE);
  return {
    logicalKey,
    fingerprint: SHA256_HEX.test(sourcePayloadDigest)
      ? sourcePayloadDigest
      : createHash('sha256').update(canonicalJson(canonicalPayload)).digest('hex'),
  };
}

/**
 * ClickHouse JSONEachRow rejects an escaped lone UTF-16 surrogate and would otherwise retain a
 * whole durable batch behind that one value forever. Preserve valid pairs byte-for-byte and
 * replace only malformed code units at the persistence boundary.
 */
function clickHouseWellFormedText(value: string): string {
  let repaired = '';
  let segmentStart = 0;
  let changed = false;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
    } else if (unit < 0xdc00 || unit > 0xdfff) {
      continue;
    }
    repaired += value.slice(segmentStart, index) + '\ufffd';
    segmentStart = index + 1;
    changed = true;
  }
  return changed ? repaired + value.slice(segmentStart) : value;
}

function clickHouseWellFormedRow(row: Row): Row {
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === 'string') (row as unknown as Record<string, unknown>)[key] = clickHouseWellFormedText(value);
  }
  return row;
}

function toRow(e: JudgedEvent): Row {
  const rawAttribution = e.attribution;
  const correlation = parseTrustedCorrelation(rawAttribution?.correlation);
  const attribution = !rawAttribution
    ? undefined
    : correlation
      ? { ...rawAttribution, correlation }
      : (({ correlation: _invalidCorrelation, ...legacyAttribution }) => legacyAttribution)(rawAttribution);
  const physical = attribution?.physicalWorkloadId?.trim();
  const instance = attribution?.agentInstanceId?.trim();
  const classificationSemantics = visibleClassificationSemantics(e.classificationSemantics);
  const process = visibleProcessContext(e.process);
  const evidenceIndex = toolEvidenceIndexFields(e);
  const revisionIdentity = eventRevisionIdentity(e);
  return clickHouseWellFormedRow({
    schemaVersion: e.schemaVersion,
    eventId: e.eventId,
    sourceEventId: e.sourceEventId ?? '',
    at: e.at,
    eventAtUnixNs: e.eventAtUnixNs ?? '',
    receivedAtUnixNs: e.receivedAtUnixNs ?? '',
    receivedAt: e.receivedAt ?? 0,
    eventTimeQuality: e.eventTimeQuality ?? 'api_received',
    captureEpoch: e.captureEpoch ?? '0',
    captureProfileCode: e.captureProfileCode ?? 0,
    captureActionCode: e.captureActionCode ?? 0,
    captureAuthorityCode: e.captureAuthorityCode ?? 0,
    captureDispositionCode: e.captureDispositionCode ?? 0,
    captureSelected: e.captureSelected === true ? 1 : 0,
    captureFlags: e.captureFlags ?? 0,
    capturePolicyVersion: e.capturePolicyVersion ?? 0,
    ingestedAt: Date.now(),
    commitBatchId: '',
    logicalKeyVersion: 1,
    eventLogicalKey: revisionIdentity.logicalKey,
    payloadFingerprintVersion: 1,
    payloadFingerprint: revisionIdentity.fingerprint,
    eventKind: e.eventKind,
    eventCategory: e.eventCategory,
    activityContext: eventActivityContext(e) ?? '',
    activitySubtype: eventActivitySubtype(e) ?? '',
    source: e.source,
    subject: e.subject,
    workspacePath: e.workspacePath,
    agentId: e.agentId,
    subjectAssetId: e.subjectAssetId ?? '',
    subjectAssetType: e.subjectAssetType ?? '',
    assetBindingQuality: e.assetBindingQuality ?? '',
    assetBindingRevision: e.assetBindingRevision ?? 0,
    assetBindingReason: e.assetBindingReason ?? '',
    identityRevision: e.identityRevision ?? 0,
    collectorId: e.collectorId?.trim() || attrString(e.attributes, 'collectorId'),
    sourceId: e.sourceId?.trim() || attrString(e.attributes, 'sourceId'),
    sessionId: e.sessionId,
    userId: e.userId,
    traceId: e.traceId,
    // These query columns are projections of the server-resolved correlation object. Producer
    // convenience fields are deliberately not an independent authority at the persistence edge.
    invocationId: correlation?.invocationId?.trim() ?? '',
    toolCallId: correlation?.toolCallId?.trim() ?? '',
    processInstanceKey: correlation?.processInstanceId?.trim() ?? '',
    processHostId: process?.hostId?.trim() ?? '',
    processBootId: process?.bootId?.trim() ?? '',
    processPid: process?.pid ?? 0,
    processPpid: process?.ppid ?? 0,
    processPidNamespace: process?.pidNamespace?.trim() ?? '',
    processNamespacePid: process?.namespacePid ?? 0,
    processNamespacePpid: process?.namespacePpid ?? 0,
    processStartTimeTicks: process?.startTimeTicks?.trim() ?? '',
    processStartTimeNs: process?.startTimeNs?.trim() ?? '',
    evidenceResourceHash: evidenceIndex.resourceHash ?? '',
    evidenceCommandHash: evidenceIndex.commandHash ?? '',
    correlationMethod: correlation?.method ?? '',
    correlationConfidence: typeof correlation?.confidence === 'number' && Number.isFinite(correlation.confidence)
      ? correlation.confidence
      : 0,
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
    classificationSemantics: JSON.stringify(classificationSemantics ?? {}),
    process: JSON.stringify(process ?? {}),
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
      process?.cwd?.trim()
      || (attribution?.agentScopeId?.trim()
        ? `agent://${attribution.agentScopeId.trim()}`
        : e.workspacePath),
    agentHasPhysicalIdentity: physical || instance || attribution?.workloadRef?.podUid ? 1 : 0,
    agentHasRootIdentity: attribution?.rootStartTime && hasDirectAgentRootEvidence(e) ? 1 : 0,
    agentHasInternalHelperRoot: isInternalAgentHelperRootEvent(e) ? 1 : 0,
    judgment: JSON.stringify(e.judgment ?? {}),
    rawPreview: e.rawPreview ?? '',
  });
}

function prepareCommitBatch(rows: Row[], requestedBatchId?: string): Row[] {
  const existingBatchId = rows.find((row) => row.commitBatchId)?.commitBatchId;
  const commitBatchId = existingBatchId || requestedBatchId || randomUUID();
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
  const rawActivityContext = str(r.activityContext);
  const rawActivitySubtype = str(r.activitySubtype);
  const activity = normalizeActivitySemantics(eventKind, rawActivityContext, rawActivitySubtype);
  const collectorId = str(r.collectorId) || attrString(attributes, 'collectorId') || undefined;
  const sourceId = str(r.sourceId) || attrString(attributes, 'sourceId') || undefined;
  const rawAttribution = parseObject<AgentAttribution>(r.attribution);
  const parsedCorrelation = parseTrustedCorrelation(rawAttribution?.correlation);
  // Rows written before the additive columns existed may contain producer-controlled JSON under
  // attribution.correlation. Treat the server-written narrow projection as the persistence trust
  // marker, and make the kill switch restore the exact legacy read shape without rewriting data.
  const correlation = correlationCaptureRollout().trustedCorrelation !== 'off' &&
    parsedCorrelation &&
    str(r.correlationMethod) === parsedCorrelation.method &&
    str(r.invocationId) === (parsedCorrelation.invocationId ?? '') &&
    str(r.toolCallId) === (parsedCorrelation.toolCallId ?? '') &&
    str(r.processInstanceKey) === (parsedCorrelation.processInstanceId ?? '') &&
    Math.abs(num(r.correlationConfidence) - parsedCorrelation.confidence) <= 0.000_01
    ? parsedCorrelation
    : undefined;
  const attribution = !rawAttribution
    ? undefined
    : correlation
      ? { ...rawAttribution, correlation }
      : (({ correlation: _invalidCorrelation, ...legacyAttribution }) => legacyAttribution)(rawAttribution);
  const invocationId = correlation?.invocationId;
  const toolCallId = correlation?.toolCallId;
  const classificationSemantics = visibleClassificationSemantics(
    parseObject(r.classificationSemantics),
  );
  const captureEpoch = str(r.captureEpoch);
  const hasCaptureDecision = captureEpoch !== '' && captureEpoch !== '0';
  return {
    schemaVersion: (str(r.schemaVersion) || 'anysentry.agent_event.v1') as JudgedEvent['schemaVersion'],
    eventId: str(r.eventId) || `evt_${at}_${agentId}_${eventKind}`,
    sourceEventId: str(r.sourceEventId) || undefined,
    at,
    eventAtUnixNs: str(r.eventAtUnixNs) || undefined,
    receivedAtUnixNs: str(r.receivedAtUnixNs) || undefined,
    receivedAt: num(r.receivedAt) || undefined,
    eventTimeQuality: (str(r.eventTimeQuality) || 'api_received') as JudgedEvent['eventTimeQuality'],
    captureEpoch: hasCaptureDecision ? captureEpoch : undefined,
    captureProfileCode: hasCaptureDecision ? num(r.captureProfileCode) : undefined,
    captureActionCode: hasCaptureDecision ? num(r.captureActionCode) : undefined,
    captureAuthorityCode: hasCaptureDecision ? num(r.captureAuthorityCode) : undefined,
    captureDispositionCode: hasCaptureDecision ? num(r.captureDispositionCode) : undefined,
    captureSelected: hasCaptureDecision ? num(r.captureSelected) > 0 : undefined,
    captureFlags: hasCaptureDecision ? num(r.captureFlags) : undefined,
    capturePolicyVersion: num(r.capturePolicyVersion) || undefined,
    eventKind,
    eventCategory: (str(r.eventCategory) || 'unknown') as JudgedEvent['eventCategory'],
    activityContext: activity.activityContext,
    activitySubtype: activity.activitySubtype,
    source: (str(r.source) || 'observer') as JudgedEvent['source'],
    subject: str(r.subject),
    workspacePath: str(r.workspacePath),
    agentId,
    subjectAssetId: str(r.subjectAssetId) || undefined,
    subjectAssetType: str(r.subjectAssetType) as JudgedEvent['subjectAssetType'] || undefined,
    assetBindingQuality: str(r.assetBindingQuality) as JudgedEvent['assetBindingQuality'] || undefined,
    assetBindingRevision: num(r.assetBindingRevision) || undefined,
    assetBindingReason: str(r.assetBindingReason) || undefined,
    identityRevision: num(r.identityRevision) || undefined,
    collectorId,
    sourceId,
    sessionId,
    userId: str(r.userId),
    traceId: str(r.traceId) || `tr_${agentId}_${sessionId}`,
    ...(invocationId ? { invocationId } : {}),
    ...(toolCallId ? { toolCallId } : {}),
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
    ...(classificationSemantics ? { classificationSemantics } : {}),
    process: visibleProcessContext(parseObject<ProcessContext>(r.process)),
    attribution,
    judgment: parseObject<NonNullable<JudgedEvent['judgment']>>(r.judgment),
    rawPreview: str(r.rawPreview) || undefined,
  };
}

function storedToolEvidenceItem(
  payload: unknown,
  invocationId: string,
  toolCallId: string,
  evidenceVersion: string,
  updatedAt: number,
): ToolEvidenceItem | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const item = payload as Partial<ToolEvidenceItem>;
  if (item.invocationId !== invocationId || item.toolCallId !== toolCallId) return undefined;
  if (typeof item.toolName !== 'string' || item.toolName.length > 120) return undefined;
  if (!['linked', 'semantic_only', 'ambiguous'].includes(item.status ?? '')) return undefined;
  if (![
    'exact_process_and_resource',
    'exact_child_and_command',
    'overlapping_exact_claims',
    'kernel_read_not_captured',
    'no_matching_kernel_evidence',
  ].includes(item.reason ?? '')) return undefined;
  if (!Array.isArray(item.adapterEventIds) || item.adapterEventIds.length > 2_000) return undefined;
  if (!Array.isArray(item.kernelEvidence) || item.kernelEvidence.length > 256) return undefined;
  return {
    ...(item as ToolEvidenceItem),
    relation: {
      schemaVersion: 'anysentry.tool_evidence_relation.v1',
      relationVersion: TOOL_EVIDENCE_RELATION_VERSION,
      evidenceVersion,
      updatedAt,
    },
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
  // This is a bounded process-local guard, not a durable idempotency registry. ClickHouse's stable
  // insert token protects replay across ambiguous writes; this cache additionally rejects two
  // different semantic payloads that claim the same (eventId, decisionRevision) while the API is
  // running. A durable cross-restart conflict registry belongs to the later outbox phase.
  private eventRevisionDigests = new Map<string, string>();
  private committedEventRevisionDigests = new Map<string, string>();
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
  private immediateWriteQueue: ImmediateWrite[] = [];
  private immediateWriteQueueBytes = 0;
  private immediateWriteTimer?: NodeJS.Timeout;
  private immediateWriteInFlight?: Promise<void>;
  private readonly immediateWriteEventTimes = new Map<number, number>();
  private readonly eventWriteReceiptStats = {
    batches: 0,
    rows: 0,
    bytes: 0,
    retries: 0,
    failures: 0,
    conflicts: 0,
    backpressureRejects: 0,
    lastDurableAt: undefined as number | undefined,
  };
  /** ReplacingMergeTree versions must remain distinct across rapid consecutive S8 snapshots. */
  private unknownLearningStateVersion = 0;
  private ready = false;
  private closed = false;
  private committedThroughMs?: number;
  // event_commit_facts can start after an existing events table and expires sooner than events.
  // Until an explicit, durable full-backfill marker exists, no journal-derived/local maximum may
  // be exposed as a global read split: doing so could hide persisted rows above a partial boundary.
  private committedBoundaryComplete = false;
  private readonly committedSourceProgress = new Map<string, CommittedSourceProgress>();
  private earliestCommitCursorCache?: {
    expiresAt: number;
    value: Promise<EventCommitCursor | null>;
  };
  private dashboardSnapshotSequence = 0;
  private dashboardSnapshotWarmInFlight?: Promise<void>;
  private readonly dashboardSnapshotStats = {
    hits: 0,
    misses: 0,
    invalidated: 0,
    exactRanges: 0,
    writtenBuckets: 0,
    fallbackErrors: 0,
    rangeRejects: 0,
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

  private eventMicrobatchEnabled(): boolean {
    return process.env.ANYSENTRY_CLICKHOUSE_MICROBATCH === 'on';
  }

  private eventBatchMaxRows(): number {
    return boundedPositiveInt(
      process.env.ANYSENTRY_CLICKHOUSE_BATCH_MAX_ROWS,
      this.eventMicrobatchEnabled() ? 1_000 : EVENT_WRITE_BATCH_ROWS,
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

  eventWriteBatchStatus() {
    const head = this.eventWriteBatches[0];
    const receiptHead = this.immediateWriteQueue[0];
    return {
      schemaVersion: 'anysentry.event-write-batch.v1' as const,
      enabled: this.eventMicrobatchEnabled(),
      revisionImmutabilityEnforced:
        process.env.ANYSENTRY_REVISION_IMMUTABILITY === 'enforce',
      maxRows: this.eventBatchMaxRows(),
      maxDelayMs: this.eventBatchMaxDelayMs(),
      maxBytes: this.eventBatchMaxBytes(),
      maxBufferedRows: EVENT_WRITE_MAX_BUFFERED_ROWS,
      maxBufferedBytes: EVENT_WRITE_MAX_BUFFERED_BYTES,
      queuedRows: this.eventWriteRows + this.immediateWriteQueue.length,
      queuedBytes: this.eventWriteBytes + this.immediateWriteQueueBytes,
      bufferedRows: this.buf.length,
      sealedBatches: this.eventWriteBatches.length,
      pendingReceipts: [...this.immediateWriteEventTimes.values()]
        .reduce((sum, count) => sum + count, 0),
      oldestQueuedMs: head || receiptHead
        ? Math.max(
            0,
            this.eventWriteNow() - Math.min(
              head?.createdAt ?? Number.POSITIVE_INFINITY,
              receiptHead?.queuedAt ?? Number.POSITIVE_INFINITY,
            ),
          )
        : 0,
      inFlight: Boolean(this.eventWriteDrainInFlight || this.immediateWriteInFlight),
      retrying: Boolean(head?.lastError),
      permanentError: this.eventWritePermanentError?.message,
      ...this.eventWriteReceiptStats,
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
    let nextClient: ClickHouseClient | undefined;
    try {
      const bootstrap = await sharedClickHouseBootstrap({ url, database, ...credentials });
      if (this.closed) throw new Error('ClickHouse store closed during bootstrap');

      // Schema/progress state is shared, while every store keeps its own client, buffers, retry
      // lane, and shutdown lifecycle.
      nextClient = createClient({ url, database, ...credentials });
      const ping = await nextClient.ping({ select: true });
      if (!ping.success) throw ping.error;
      for (const entry of bootstrap.committedSourceProgress) {
        const key = `${entry.sourceId ?? ''}\0${entry.collectorId ?? ''}`;
        const previous = this.committedSourceProgress.get(key);
        this.committedSourceProgress.set(key, {
          sourceId: entry.sourceId,
          collectorId: entry.collectorId,
          committedEventTimeMs: Math.max(
            previous?.committedEventTimeMs ?? 0,
            entry.committedEventTimeMs,
          ),
          committedAtMs: Math.max(previous?.committedAtMs ?? 0, entry.committedAtMs),
        });
      }
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
    this.assertEventRevisionConsistency([queued.row]);
    const revisionKey = this.eventRevisionKey(queued.row);
    const revisionDigest = this.eventRevisionDigest(queued.row);
    if (this.eventRevisionDigests.get(revisionKey) === revisionDigest) return;
    this.assertEventWriteCapacity(queued.bytes);
    this.rememberEventRevisionDigests([queued.row]);
    this.buf.push(queued);
    this.bufferedEventBytes += queued.bytes;
    this.eventWriteRows += 1;
    this.eventWriteBytes += queued.bytes;
    const sealed = this.sealBufferedEventBatches(false);
    if (sealed) this.startEventWriteDrain();
  }

  /** Persist one lifecycle revision before acknowledging queue work. */
  async insertNow(e: JudgedEvent, idempotencyKey?: string): Promise<void> {
    return this.insertManyNow([e], idempotencyKey);
  }

  /**
   * Persist one immutable Revision through the configurable receipt microbatch lane.
   *
   * This is used by durability-aware producers that need a stable commit batch receipt rather
   * than the void compatibility contract of insertNow/insertManyNow.
   */
  async insertNowWithReceipt(e: JudgedEvent): Promise<EventBatchReceipt> {
    if (!this.client || !this.ready || this.closed || this.closing) {
      throw new Error('ClickHouse is not ready');
    }
    const row = toRow(e);
    const bytes = Buffer.byteLength(JSON.stringify(row), 'utf8') + 1;
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
      this.immediateWriteQueue.length >= maxQueuedRows
      || this.immediateWriteQueueBytes + bytes > maxQueuedBytes
    ) {
      this.eventWriteReceiptStats.backpressureRejects += 1;
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
        this.immediateWriteQueue.length >= this.eventBatchMaxRows()
        || this.immediateWriteQueueBytes >= this.eventBatchMaxBytes()
      ) {
        void this.drainImmediateWrites();
        return;
      }
      this.scheduleImmediateWriteDrain();
    });
  }

  private scheduleImmediateWriteDrain(): void {
    if (
      this.immediateWriteTimer
      || this.immediateWriteInFlight
      || !this.immediateWriteQueue.length
      || this.closing
    ) return;
    const oldest = this.immediateWriteQueue[0]?.queuedAt ?? Date.now();
    const waitMs = Math.max(
      0,
      this.eventBatchMaxDelayMs() - Math.max(0, Date.now() - oldest),
    );
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

    let tracked!: Promise<void>;
    tracked = this.flushImmediateWrites().finally(() => {
      if (this.immediateWriteInFlight === tracked) this.immediateWriteInFlight = undefined;
      if (this.closing && this.immediateWriteQueue.length) {
        void this.drainImmediateWrites();
      } else if (
        this.immediateWriteQueue.length >= this.eventBatchMaxRows()
        || this.immediateWriteQueueBytes >= this.eventBatchMaxBytes()
      ) {
        void this.drainImmediateWrites();
      } else {
        this.scheduleImmediateWriteDrain();
      }
    });
    this.immediateWriteInFlight = tracked;
    return tracked;
  }

  private async existingRevisionFingerprints(
    logicalKeys: string[],
  ): Promise<Map<string, string>> {
    if (!this.client || this.closed || !logicalKeys.length) return new Map();
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
    return new Map(rows.flatMap((entry) => {
      const key = entry.eventLogicalKey?.trim();
      const fingerprint = entry.acceptedFingerprint?.trim();
      return key && fingerprint ? [[key, fingerprint] as const] : [];
    }));
  }

  private async flushImmediateWrites(): Promise<void> {
    if (!this.immediateWriteQueue.length) return;
    const batch: ImmediateWrite[] = [];
    let batchBytes = 0;
    const maxRows = this.eventBatchMaxRows();
    const maxBytes = this.eventBatchMaxBytes();
    while (this.immediateWriteQueue.length && batch.length < maxRows) {
      const next = this.immediateWriteQueue[0];
      if (batch.length && batchBytes + next.bytes > maxBytes) break;
      batch.push(this.immediateWriteQueue.shift()!);
      batchBytes += next.bytes;
      this.immediateWriteQueueBytes = Math.max(
        0,
        this.immediateWriteQueueBytes - next.bytes,
      );
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
        this.eventWriteReceiptStats.failures += 1;
        for (const entry of batch) entry.reject(error);
        this.finishImmediateWriteAccounting(batch);
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
        if (existingFingerprint === entry.row.payloadFingerprint) factEntries.push(entry);
        else conflictEntries.push({ entry, acceptedFingerprint: existingFingerprint });
        continue;
      }
      const first = firstByLogicalKey.get(entry.row.eventLogicalKey);
      if (!first) {
        firstByLogicalKey.set(entry.row.eventLogicalKey, entry);
        factEntries.push(entry);
        physicalEntries.push(entry);
      } else if (first.row.payloadFingerprint === entry.row.payloadFingerprint) {
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
        if (!this.client || this.closed) throw new Error('ClickHouse is not ready');
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
          await this.client.insert({
            table: TABLE,
            values: rows,
            format: 'JSONEachRow',
            clickhouse_settings: {
              insert_deduplicate: 1,
              insert_deduplication_token: `receipt-${batchId}`,
            },
          });
        }
        const durableAt = Date.now();
        if (rows.length) {
          this.committedThroughMs = Math.max(
            this.committedThroughMs ?? 0,
            ...physicalEntries.map((entry) => entry.eventAt),
          );
          this.noteCommittedRows(rows);
        }
        this.eventWriteReceiptStats.batches += 1;
        this.eventWriteReceiptStats.rows += rows.length;
        this.eventWriteReceiptStats.bytes += batchBytes;
        this.eventWriteReceiptStats.lastDurableAt = durableAt;
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
        this.eventWriteReceiptStats.conflicts += conflictEntries.length;
        finalError = undefined;
        break;
      } catch (error) {
        finalError = error;
        if (attempts >= maxAttempts || this.closed) break;
        this.eventWriteReceiptStats.retries += 1;
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
      this.eventWriteReceiptStats.failures += 1;
      for (const entry of batch) entry.reject(finalError);
    }
    this.finishImmediateWriteAccounting(batch);
  }

  private finishImmediateWriteAccounting(batch: ImmediateWrite[]): void {
    for (const entry of batch) {
      const remainingAtTime = (this.immediateWriteEventTimes.get(entry.eventAt) ?? 1) - 1;
      if (remainingAtTime > 0) {
        this.immediateWriteEventTimes.set(entry.eventAt, remainingAtTime);
      } else {
        this.immediateWriteEventTimes.delete(entry.eventAt);
      }
    }
  }

  async eventById(eventId: string, eventAt?: number): Promise<JudgedEvent | undefined> {
    const normalized = eventId.trim();
    if (!normalized) return undefined;
    const boundedAt = Number.isSafeInteger(eventAt) && Number(eventAt) >= 0
      ? Number(eventAt)
      : undefined;
    return (await this.eventsByIds([normalized], boundedAt, boundedAt))[0];
  }

  /**
   * Resolve authenticated Forwarder WAL replay at event granularity. A restart may regroup WAL
   * records into a new HTTP batch, so the batch cache alone cannot prove an already-durable event.
   */
  async classifyDurableReplayEvents(
    events: readonly JudgedEvent[],
  ): Promise<DurableReplayEventStatus[] | null> {
    if (!this.client || !this.ready || this.closing || this.eventWritePermanentError) return null;
    const existingEvents = await this.eventsByIds(events.map((event) => event.eventId));
    const existingById = new Map(existingEvents.map((event) => [event.eventId, event]));
    return events.map((event) => {
      const existing = existingById.get(event.eventId);
      if (!existing) return 'new';
      if (
        Math.max(1, Math.trunc(existing.decisionRevision ?? 1))
        !== Math.max(1, Math.trunc(event.decisionRevision ?? 1))
      ) return 'conflict';
      const incomingRow = toRow(event);
      const existingRow = toRow(existing);
      const incomingSourceDigest = this.eventRevisionSourcePayloadDigest(incomingRow);
      const existingSourceDigest = this.eventRevisionSourcePayloadDigest(existingRow);
      if (incomingSourceDigest && existingSourceDigest) {
        return incomingSourceDigest === existingSourceDigest ? 'duplicate' : 'conflict';
      }
      return this.eventRevisionDigest(incomingRow, false) === this.eventRevisionDigest(existingRow, false)
        ? 'duplicate'
        : 'conflict';
    });
  }

  /**
   * Persist one bounded set of event revisions as one ClickHouse block.
   *
   * `idempotencyKey` identifies the immutable upstream batch. Retrying the same key and payload
   * joins an in-flight write or reuses the same ClickHouse deduplication token. Callers must not
   * mutate a batch while retaining its key.
   */
  async insertManyNow(events: readonly JudgedEvent[], idempotencyKey?: string): Promise<void> {
    if (events.length === 0) return;
    if (!this.client || !this.ready || this.closing) throw new Error('ClickHouse is not ready');
    if (this.eventWritePermanentError) throw this.eventWritePermanentError;
    let queued = events.map((event) => this.queuedEventRow(toRow(event)));
    this.assertEventRevisionConsistency(queued.map(({ row }) => row));
    const uniqueRevisions = new Map<string, QueuedEventRow>();
    for (const item of queued) {
      const key = this.eventRevisionKey(item.row);
      if (!uniqueRevisions.has(key)) uniqueRevisions.set(key, item);
    }
    queued = [...uniqueRevisions.values()];
    const requestedBytes = queued.reduce((sum, row) => sum + row.bytes, 0);
    if (queued.length > EVENT_WRITE_BATCH_ROWS || requestedBytes > EVENT_WRITE_BATCH_BYTES) {
      throw Object.assign(
        new Error(
          `ClickHouse direct event batch exceeds ${EVENT_WRITE_BATCH_ROWS} rows or ${EVENT_WRITE_BATCH_BYTES} bytes`,
        ),
        {
          code: EVENT_WRITE_BATCH_TOO_LARGE,
          rows: queued.length,
          bytes: requestedBytes,
          maxRows: EVENT_WRITE_BATCH_ROWS,
          maxBytes: EVENT_WRITE_BATCH_BYTES,
        },
      );
    }

    // A direct durability waiter may overlap an earlier buffered delivery of the same immutable
    // revision. Seal that tail, join its batch, and insert only genuinely new revisions.
    this.sealBufferedEventBatches(true);
    const pendingByRevision = new Map<string, EventWriteBatch>();
    for (const batch of this.eventWriteBatches) {
      for (const row of batch.rows) pendingByRevision.set(this.eventRevisionKey(row), batch);
    }
    const joinedBatches = new Set<EventWriteBatch>();
    queued = queued.filter(({ row }) => {
      const key = this.eventRevisionKey(row);
      const digest = this.eventRevisionDigest(row);
      if (this.committedEventRevisionDigests.get(key) === digest) return false;
      const pending = pendingByRevision.get(key);
      if (!pending) return true;
      joinedBatches.add(pending);
      return false;
    });
    const completions = [...joinedBatches].map((batch) => (
      new Promise<void>((resolve, reject) => batch.waiters.push({ resolve, reject }))
    ));
    if (queued.length === 0) {
      this.startEventWriteDrain();
      await Promise.all(completions);
      return;
    }

    const bytes = queued.reduce((sum, row) => sum + row.bytes, 0);
    const token = this.directEventWriteToken(queued.map(({ row }) => row), idempotencyKey);
    this.assertEventWriteBatchCapacity(queued.length, bytes);
    const batch = this.createEventWriteBatch(queued, token, 'direct');
    this.rememberEventRevisionDigests(batch.rows);
    this.eventWriteRows += queued.length;
    this.eventWriteBytes += bytes;
    this.eventWriteBatches.push(batch);
    this.eventWriteBatchesByToken.set(token, batch);
    const completion = new Promise<void>((resolve, reject) => batch.waiters.push({ resolve, reject }));
    completions.push(completion);
    this.startEventWriteDrain();
    await Promise.all(completions);
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
      await Promise.all([operation, this.drainImmediateWrites()]);
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
    this.assertEventWriteBatchCapacity(1, additionalBytes);
  }

  private assertEventWriteBatchCapacity(additionalRows: number, additionalBytes: number): void {
    if (
      this.eventWriteRows + additionalRows <= EVENT_WRITE_MAX_BUFFERED_ROWS &&
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
    const rows = prepareCommitBatch(queued.map(({ row }) => row), token);
    return {
      rows,
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

  private stableEventRevision(row: Row): Record<string, unknown> {
    // Keep the legacy property order byte-for-byte when correlation is absent: rolling upgrades
    // must calculate the same ClickHouse deduplication token for the same old event. Deleting the
    // additive query projections leaves all pre-existing keys in their original insertion order.
    const stableRevision = { ...row } as Record<string, unknown>;
    delete stableRevision.ingestedAt;
    delete stableRevision.commitBatchId;
    delete stableRevision.logicalKeyVersion;
    delete stableRevision.eventLogicalKey;
    delete stableRevision.payloadFingerprintVersion;
    delete stableRevision.payloadFingerprint;
    delete stableRevision.invocationId;
    delete stableRevision.toolCallId;
    delete stableRevision.processInstanceKey;
    delete stableRevision.processHostId;
    delete stableRevision.processBootId;
    delete stableRevision.processPid;
    delete stableRevision.processPpid;
    delete stableRevision.processPidNamespace;
    delete stableRevision.processNamespacePid;
    delete stableRevision.processNamespacePpid;
    delete stableRevision.processStartTimeTicks;
    delete stableRevision.processStartTimeNs;
    delete stableRevision.evidenceResourceHash;
    delete stableRevision.evidenceCommandHash;
    delete stableRevision.correlationMethod;
    delete stableRevision.correlationConfidence;
    delete stableRevision.classificationSemantics;
    const process = String(stableRevision.process ?? '');
    try {
      const parsed = JSON.parse(process) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        delete parsed.lifecycleSource;
        delete parsed.lifecycleReason;
        stableRevision.process = JSON.stringify(parsed);
      }
    } catch {
      // Preserve malformed legacy payloads byte-for-byte in the token.
    }
    const attribution = String(stableRevision.attribution ?? '');
    try {
      const parsed = JSON.parse(attribution) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'correlation' in parsed) {
        delete parsed.correlation;
        // Reassigning an existing property does not change its insertion order.
        stableRevision.attribution = JSON.stringify(parsed);
      }
    } catch {
      // Preserve malformed legacy payloads byte-for-byte in the token.
    }
    return stableRevision;
  }

  private eventRevisionKey(row: Row): string {
    return `${row.eventId}\0${Math.max(1, Math.trunc(Number(row.decisionRevision) || 1))}`;
  }

  private eventRevisionSourcePayloadDigest(row: Row): string {
    try {
      const attributes = JSON.parse(String(row.attributes ?? '{}')) as Record<string, unknown>;
      const digest = String(attributes?.[OBSERVER_SOURCE_PAYLOAD_SHA256_ATTRIBUTE] ?? '').trim();
      return SHA256_HEX.test(digest) ? digest : '';
    } catch {
      return '';
    }
  }

  private eventRevisionDigest(row: Row, preferSourcePayload = true): string {
    const sourcePayloadDigest = this.eventRevisionSourcePayloadDigest(row);
    if (preferSourcePayload && sourcePayloadDigest) return `observer-source:${sourcePayloadDigest}`;
    // Receipt timestamps and generated span ids may legitimately change when an old observer client
    // retries a sourceEventId. They do not change the semantic revision. Every decision/evidence
    // field remains covered so a real revision conflict is still rejected.
    const {
      ingestedAt: _ingestedAt,
      commitBatchId: _commitBatchId,
      logicalKeyVersion: _logicalKeyVersion,
      eventLogicalKey: _eventLogicalKey,
      payloadFingerprintVersion: _payloadFingerprintVersion,
      payloadFingerprint: _payloadFingerprint,
      at: _at,
      receivedAt: _receivedAt,
      decisionUpdatedAt: _decisionUpdatedAt,
      spanId: _spanId,
      invocationId: _invocationId,
      toolCallId: _toolCallId,
      processInstanceKey: _processInstanceKey,
      processHostId: _processHostId,
      processBootId: _processBootId,
      processPid: _processPid,
      processPpid: _processPpid,
      processPidNamespace: _processPidNamespace,
      processNamespacePid: _processNamespacePid,
      processNamespacePpid: _processNamespacePpid,
      processStartTimeTicks: _processStartTimeTicks,
      processStartTimeNs: _processStartTimeNs,
      evidenceResourceHash: _evidenceResourceHash,
      evidenceCommandHash: _evidenceCommandHash,
      correlationMethod: _correlationMethod,
      correlationConfidence: _correlationConfidence,
      classificationSemantics: _classificationSemantics,
      attribution,
      ...semanticRevision
    } = row;
    const attributes = String(semanticRevision.attributes ?? '');
    try {
      const parsed = JSON.parse(attributes) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        delete parsed[OBSERVER_SOURCE_PAYLOAD_SHA256_ATTRIBUTE];
        semanticRevision.attributes = JSON.stringify(parsed);
      }
    } catch {
      // Preserve malformed legacy payloads byte-for-byte in the digest.
    }
    const process = String(semanticRevision.process ?? '');
    try {
      const parsed = JSON.parse(process) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        delete parsed.lifecycleSource;
        delete parsed.lifecycleReason;
        // Reassigning preserves the legacy Row property order used by rolling versions.
        semanticRevision.process = JSON.stringify(parsed);
      }
    } catch {
      // Preserve malformed legacy payloads byte-for-byte in the digest.
    }
    // Correlation is a rollout-derived, additive view. The same immutable source/decision revision
    // may legitimately be retried while a node moves between off and shadow. Exclude only that
    // nested view (and its query projections) from the revision digest; every pre-existing
    // attribution, decision, evidence, and payload field remains conflict-protected.
    let stableAttribution = attribution;
    try {
      const parsed = JSON.parse(attribution) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        delete parsed.correlation;
        stableAttribution = JSON.stringify(parsed);
      }
    } catch {
      // Preserve malformed legacy payloads byte-for-byte in the digest.
    }
    return createHash('sha256')
      .update(JSON.stringify({ ...semanticRevision, attribution: stableAttribution }))
      .digest('hex');
  }

  private assertEventRevisionConsistency(rows: readonly Row[]): void {
    const pending = new Map<string, string>();
    for (const row of rows) {
      const key = this.eventRevisionKey(row);
      const digest = this.eventRevisionDigest(row);
      const existing = pending.get(key) ?? this.eventRevisionDigests.get(key);
      if (existing && existing !== digest) {
        throw Object.assign(
          new Error(`event revision conflict for ${row.eventId} revision ${row.decisionRevision}`),
          {
            code: EVENT_REVISION_CONFLICT,
            eventId: row.eventId,
            decisionRevision: row.decisionRevision,
          },
        );
      }
      pending.set(key, digest);
    }
  }

  private rememberEventRevisionDigests(rows: readonly Row[]): void {
    for (const row of rows) {
      const key = this.eventRevisionKey(row);
      if (this.eventRevisionDigests.has(key)) this.eventRevisionDigests.delete(key);
      this.eventRevisionDigests.set(key, this.eventRevisionDigest(row));
    }
    while (this.eventRevisionDigests.size > EVENT_REVISION_DIGEST_CACHE_SIZE) {
      const oldest = this.eventRevisionDigests.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.eventRevisionDigests.delete(oldest);
    }
  }

  private rememberCommittedEventRevisionDigests(rows: readonly Row[]): void {
    for (const row of rows) {
      const key = this.eventRevisionKey(row);
      if (this.committedEventRevisionDigests.has(key)) this.committedEventRevisionDigests.delete(key);
      this.committedEventRevisionDigests.set(key, this.eventRevisionDigest(row));
    }
    while (this.committedEventRevisionDigests.size > EVENT_REVISION_DIGEST_CACHE_SIZE) {
      const oldest = this.committedEventRevisionDigests.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.committedEventRevisionDigests.delete(oldest);
    }
  }

  private directEventWriteToken(rows: readonly Row[], idempotencyKey?: string): string {
    const hash = createHash('sha256');
    if (idempotencyKey) hash.update('upstream\0').update(idempotencyKey);
    else {
      hash.update('revisions\0');
      for (const row of rows) {
        hash.update(JSON.stringify(this.stableEventRevision(row))).update('\n');
      }
    }
    return `event-${hash.digest('hex')}`;
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
        this.rememberCommittedEventRevisionDigests(batch.rows);
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
    const safeLimit = Math.max(1, Math.min(MAX_DURABLE_EVENT_SEARCH_ROWS, Math.round(limit)));
    // Reuse the durable search's narrow locator sort and late materialization. The former
    // SELECT-* Top-N hydration path could exhaust 640 MiB merely reading `attributes` from a busy
    // 30-day part, leaving the API healthy but its hot cache empty after every restart.
    const events = await this.searchEvents({
      sinceMs,
      untilMs: Date.now(),
      limit: safeLimit,
    });
    return (events ?? []).sort((left, right) => left.at - right.at).slice(-safeLimit);
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
   * short (the Dashboard uses one absolute bucket), and the latest decision revision is selected before the
   * result is merged with the in-process hot ring.
   */
  async dashboardTailEvents(startMs: number, endMs: number): Promise<JudgedEvent[] | null> {
    if (!this.client || !this.ready) return null;
    if (endMs < startMs) return [];
    try {
      const result = await this.client.query({
        query: `
          SELECT sourceEvent.*
          FROM ${TABLE} AS sourceEvent
          PREWHERE
            sourceEvent.at >= {start:UInt64}
            AND sourceEvent.at <= {end:UInt64}
            AND tuple(sourceEvent.at, sourceEvent._part, sourceEvent._part_offset) IN (
              SELECT
                tupleElement(locator, 1),
                tupleElement(locator, 2),
                tupleElement(locator, 3)
              FROM (
                SELECT argMax(
                  tuple(at, _part, _part_offset),
                  tuple(decisionRevision, decisionUpdatedAt, at)
                ) AS locator
                FROM ${TABLE}
                PREWHERE at >= {start:UInt64} AND at <= {end:UInt64}
                GROUP BY eventId
              )
            )
          ORDER BY sourceEvent.at, sourceEvent.eventId`,
        query_params: {
          start: Math.max(0, Math.trunc(startMs)),
          end: Math.max(0, Math.trunc(endMs)),
        },
        clickhouse_settings: BOUNDED_EVENT_SEARCH_READ_SETTINGS,
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
    if (!canPersist) {
      // Cache boundary slices are at most one bucket wide. Refuse an accidentally unaligned wide
      // scan instead of bypassing the persisted-snapshot admission control.
      if (end - start > DASHBOARD_BUCKET_BUILD_CHUNK_MS) return null;
      return this.queryDashboardAggregateBucketFactsRaw(start, end, size);
    }
    const requestedBuckets = Math.ceil((end - start) / size);
    if (requestedBuckets > DASHBOARD_PERSISTED_READ_MAX_BUCKETS) {
      this.dashboardSnapshotStats.rangeRejects += 1;
      return null;
    }

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

      // Cold bootstrap must not fold several hours of high-cardinality events in one query. Split
      // missing history into fixed absolute chunks and build only a bounded number per request.
      // Successful chunks are durable, so later polls resume instead of repeating prior work.
      const chunkMs = Math.max(size, Math.floor(DASHBOARD_BUCKET_BUILD_CHUNK_MS / size) * size);
      const buildRanges = missingRanges.flatMap((range) => {
        const chunks: Array<{ start: number; end: number }> = [];
        for (let chunkStart = range.start; chunkStart < range.end; chunkStart += chunkMs) {
          chunks.push({ start: chunkStart, end: Math.min(range.end, chunkStart + chunkMs) });
        }
        return chunks;
      });
      if (buildRanges.length > 0) {
        // Snapshot warming is deliberately detached from the HTTP request. The dashboard can show
        // its bounded hot/partial view immediately, while one single-flight worker materialises a
        // few small durable chunks for subsequent refreshes. Additional requests never create a
        // queue of raw scans.
        this.scheduleDashboardBucketWarm(buildRanges, size);
        return null;
      }

      const result: DashboardAggregateBucketFact[] = [];
      for (let bucket = start; bucket < end; bucket += size) {
        result.push(...(byBucket.get(bucket) ?? []));
      }
      return result;
    } catch (error) {
      this.dashboardSnapshotStats.fallbackErrors += 1;
      console.warn(
        '[clickhouse] persisted dashboard bucket cache unavailable; returning bounded hot fallback:',
        (error as Error).message,
      );
      return null;
    }
  }

  private scheduleDashboardBucketWarm(
    buildRanges: ReadonlyArray<{ start: number; end: number }>,
    bucketMs: number,
  ): void {
    if (this.dashboardSnapshotWarmInFlight || buildRanges.length === 0 || this.closing) return;
    const ranges = buildRanges.slice(0, DASHBOARD_BUCKET_BUILD_MAX_CHUNKS);
    let tracked!: Promise<void>;
    tracked = (async () => {
      for (const range of ranges) {
        if (this.closing || !this.ready) return;
        const before = await this.eventCommitCursorsForBuckets(
          range.start,
          range.end,
          bucketMs,
        );
        const beforeGlobal = await this.latestEventCommitCursor();
        if (!beforeGlobal) return;
        this.dashboardSnapshotStats.exactRanges += 1;
        const rows = await this.queryDashboardAggregateBucketFactsRaw(
          range.start,
          range.end,
          bucketMs,
        );
        if (rows === null) return;
        const grouped = new Map<number, DashboardAggregateBucketFact[]>();
        for (const row of rows) {
          const bucketRows = grouped.get(row.bucketStartMs) ?? [];
          bucketRows.push(row);
          grouped.set(row.bucketStartMs, bucketRows);
        }
        const after = await this.eventCommitCursorsForBuckets(
          range.start,
          range.end,
          bucketMs,
        );
        const afterGlobal = await this.latestEventCommitCursor();
        if (!afterGlobal) return;
        const stableCursors = new Map<number, EventCommitCursor>();
        const globalStable = compareEventCommitCursor(beforeGlobal, afterGlobal) === 0;
        for (let bucket = range.start; bucket < range.end; bucket += bucketMs) {
          const beforeCursor = before.get(bucket);
          const afterCursor = after.get(bucket);
          if (
            beforeCursor
            && afterCursor
            && compareEventCommitCursor(beforeCursor, afterCursor) === 0
          ) {
            stableCursors.set(bucket, afterCursor);
          } else if (!beforeCursor && !afterCursor && globalStable) {
            stableCursors.set(bucket, afterGlobal);
          }
        }
        // Only buckets whose complete commit cursor stayed stable across the raw aggregation are
        // published. A concurrent late event leaves that bucket missing for the next warm pass.
        await this.writePersistedDashboardBuckets(
          range.start,
          range.end,
          bucketMs,
          stableCursors,
          grouped,
        );
        // Yield between chunks so ingestion continuations and control-plane HTTP work are not
        // starved even when ClickHouse answers several warm-up queries immediately.
        await delay(25);
      }
    })()
      .catch((error) => {
        this.dashboardSnapshotStats.fallbackErrors += 1;
        console.warn('[clickhouse] dashboard bucket background warm failed:', (error as Error).message);
      })
      .finally(() => {
        if (this.dashboardSnapshotWarmInFlight === tracked) {
          this.dashboardSnapshotWarmInFlight = undefined;
        }
      });
    this.dashboardSnapshotWarmInFlight = tracked;
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
            intDiv(eventAt, {bucketMs:UInt64}) * {bucketMs:UInt64} AS bucketStart,
            monitored,
            decisionStatus,
            verdict,
            tier,
            riskType,
            riskCategory,
            riskName,
            multiIf(severity = 'critical', 4, severity = 'high', 3, severity = 'medium', 2, severity = 'low', 1, 0) AS severityRank,
            if(agentSessionId != '', agentSessionId, if(agentDisplayName != '', agentDisplayName, if(agentScopeId != '', agentScopeId, agentId))) AS sessionKey,
            userId,
            if(processCwd != '', processCwd, if(agentScopeId != '', concat('agent://', agentScopeId), workspacePath)) AS resolvedWorkspacePath,
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
            max(eventAt) AS lastEventAt,
            countIf(verdict != 'allow' AND riskCategory = 'command_danger') AS commandDangerCount,
            countIf(verdict != 'allow' AND riskCategory = 'prompt_injection') AS promptInjectionCount,
            countIf(verdict != 'allow' AND riskCategory IN ('data_leak', 'secret_exfil')) AS dataLeakCount,
            countIf(verdict != 'allow' AND riskCategory = 'communication_risk') AS communicationRiskCount,
            countIf(verdict != 'allow' AND riskCategory IN ('systemic_risk', 'privilege_escalation')) AS systemicRiskCount
          FROM (
            SELECT
              eventId,
              argMax(at, tuple(decisionRevision, decisionUpdatedAt, at)) AS eventAt,
              argMax(JSONExtractBool(attribution, 'monitored'), tuple(decisionRevision, decisionUpdatedAt, at)) AS monitored,
              argMax(JSONExtractString(attribution, 'agentSessionId'), tuple(decisionRevision, decisionUpdatedAt, at)) AS agentSessionId,
              argMax(JSONExtractString(attribution, 'agentDisplayName'), tuple(decisionRevision, decisionUpdatedAt, at)) AS agentDisplayName,
              argMax(JSONExtractString(attribution, 'agentScopeId'), tuple(decisionRevision, decisionUpdatedAt, at)) AS agentScopeId,
              argMax(JSONExtractString(process, 'cwd'), tuple(decisionRevision, decisionUpdatedAt, at)) AS processCwd,
              argMax(decisionStatus, tuple(decisionRevision, decisionUpdatedAt, at)) AS decisionStatus,
              argMax(verdict, tuple(decisionRevision, decisionUpdatedAt, at)) AS verdict,
              argMax(tier, tuple(decisionRevision, decisionUpdatedAt, at)) AS tier,
              argMax(riskType, tuple(decisionRevision, decisionUpdatedAt, at)) AS riskType,
              argMax(riskCategory, tuple(decisionRevision, decisionUpdatedAt, at)) AS riskCategory,
              argMax(riskName, tuple(decisionRevision, decisionUpdatedAt, at)) AS riskName,
              argMax(severity, tuple(decisionRevision, decisionUpdatedAt, at)) AS severity,
              argMax(agentId, tuple(decisionRevision, decisionUpdatedAt, at)) AS agentId,
              argMax(userId, tuple(decisionRevision, decisionUpdatedAt, at)) AS userId,
              argMax(workspacePath, tuple(decisionRevision, decisionUpdatedAt, at)) AS workspacePath,
              argMax(tokenCount, tuple(decisionRevision, decisionUpdatedAt, at)) AS tokenCount,
              argMax(latencyMs, tuple(decisionRevision, decisionUpdatedAt, at)) AS latencyMs,
              argMax(riskScore, tuple(decisionRevision, decisionUpdatedAt, at)) AS riskScore
            FROM ${TABLE}
            PREWHERE at >= {start:UInt64} AND at < {end:UInt64}
            GROUP BY eventId
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
        clickhouse_settings: BOUNDED_DASHBOARD_BUCKET_BUILD_SETTINGS,
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
            expectedChecksum
            && createHash('sha256').update(factsJson).digest('hex') !== expectedChecksum
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
    const queryParams: Record<string, unknown> = { since: input.sinceMs, until: input.untilMs };
    const stableFields: Array<[keyof StoredEventQuery, string]> = [
      ['eventId', 'eventId'],
      ['sourceId', 'sourceId'],
      ['collectorId', 'collectorId'],
      ['agentId', 'agentId'],
      ['subjectAssetId', 'subjectAssetId'],
      ['agentInstanceId', 'agentInstanceKey'],
      ['sessionId', 'sessionId'],
      ['workspacePath', 'workspacePath'],
      ['traceId', 'traceId'],
      ['invocationId', 'invocationId'],
      ['toolCallId', 'toolCallId'],
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
    const processStringPredicates: Array<[
      'processHostId' | 'processBootId' | 'processPidNamespace' | 'processStartTimeTicks' | 'processStartTimeNs',
      string,
    ]> = [
      ['processHostId', 'processHostId'],
      ['processBootId', 'processBootId'],
      ['processPidNamespace', 'processPidNamespace'],
      ['processStartTimeTicks', 'processStartTimeTicks'],
      ['processStartTimeNs', 'processStartTimeNs'],
    ];
    for (const [queryKey, column] of processStringPredicates) {
      const value = input[queryKey];
      if (typeof value !== 'string' || !value.trim()) continue;
      sampleConditions.push(`${column} = {${queryKey}:String}`);
      queryParams[queryKey] = value.trim();
    }
    for (const [queryKey, column] of [
      ['processPid', 'processPid'],
      ['processPpid', 'processPpid'],
      ['processNamespacePid', 'processNamespacePid'],
      ['processNamespacePpid', 'processNamespacePpid'],
    ] as const) {
      const value = input[queryKey];
      if (!Number.isSafeInteger(value) || Number(value) <= 0) continue;
      sampleConditions.push(`${column} = {${queryKey}:UInt64}`);
      queryParams[queryKey] = Number(value);
    }
    const boundedEvidenceHashes = (values: string[] | undefined): string[] => [...new Set(
      (values ?? [])
        .map((value) => value.trim().toLowerCase())
        .filter((value) => /^[a-f0-9]{64}$/u.test(value)),
    )].slice(0, 1_000);
    const resourceHashes = boundedEvidenceHashes(input.evidenceResourceHashes);
    const commandHashes = boundedEvidenceHashes(input.evidenceCommandHashes);
    if (resourceHashes.length > 0) {
      sampleConditions.push('evidenceResourceHash IN {evidenceResourceHashes:Array(String)}');
      queryParams.evidenceResourceHashes = resourceHashes;
    }
    if (commandHashes.length > 0) {
      sampleConditions.push('evidenceCommandHash IN {evidenceCommandHashes:Array(String)}');
      queryParams.evidenceCommandHashes = commandHashes;
    }
    const activityContext = input.activityContext?.trim();
    if (activityContext) {
      sampleConditions.push(`multiIf(
        eventKind != 'ToolExec', '',
        activityContext = 'platform_healthcheck'
          AND activitySubtype IN (
            'docker_healthcheck',
            'k8s_exec_probe',
            'k8s_liveness_probe',
            'k8s_readiness_probe',
            'k8s_startup_probe'
          ),
        'platform_healthcheck',
        'agent_action'
      ) = {activityContext:String}`);
      queryParams.activityContext = activityContext;
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
    const requestedCandidateLimit = Number(input.candidateLimit);
    queryParams.scanLimit = Math.min(300_000, Math.max(
      rowLimit,
      Number.isFinite(requestedCandidateLimit) ? Math.round(requestedCandidateLimit) : rowLimit * 3,
      latestConditions.length ? 15_000 : 0,
    ));
    const queryKey = JSON.stringify({
      queryParams,
      monitoredOnly: input.monitoredOnly === true,
    });
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

  async readToolEvidenceRelations(
    invocationIdInput: string,
    toolCallIdInput?: string,
    scope: ToolEvidenceRelationScope = {},
  ): Promise<StoredToolEvidenceRelations | null> {
    const invocationId = invocationIdInput.trim();
    const toolCallId = toolCallIdInput?.trim();
    if (!this.client || !this.ready || !invocationId || invocationId.length > 512) return null;
    try {
      const result = await this.client.query({
        query: `
          SELECT invocationId, toolCallId, workspacePath, sourceId, agentInstanceId,
            relationVersion, evidenceVersion, itemCount, updatedAt, payload
          FROM ${TOOL_EVIDENCE_RELATION_TABLE} FINAL
          WHERE invocationId = {invocationId:String}
            ${toolCallId ? 'AND toolCallId = {toolCallId:String}' : ''}
            ${scope.workspacePath ? 'AND workspacePath = {workspacePath:String}' : ''}
            ${scope.sourceId ? 'AND sourceId = {sourceId:String}' : ''}
            ${scope.agentInstanceId ? 'AND agentInstanceId = {agentInstanceId:String}' : ''}
            AND relationVersion = ${TOOL_EVIDENCE_RELATION_VERSION}
          ORDER BY toolCallId
          LIMIT 1000`,
        query_params: {
          invocationId,
          ...(toolCallId ? { toolCallId } : {}),
          ...(scope.workspacePath ? { workspacePath: scope.workspacePath } : {}),
          ...(scope.sourceId ? { sourceId: scope.sourceId } : {}),
          ...(scope.agentInstanceId ? { agentInstanceId: scope.agentInstanceId } : {}),
        },
        clickhouse_settings: BOUNDED_TOOL_EVIDENCE_RELATION_SETTINGS,
        format: 'JSONEachRow',
      });
      const rows = (await result.json()) as Array<Record<string, unknown>>;
      const items: ToolEvidenceItem[] = [];
      let evidenceVersion: string | undefined;
      let updatedAt: number | undefined;
      let expectedCount: number | undefined;
      let relationScopeKey: string | undefined;
      for (const row of rows) {
        const rowInvocationId = String(row.invocationId ?? '');
        const rowToolCallId = String(row.toolCallId ?? '');
        const rowEvidenceVersion = String(row.evidenceVersion ?? '');
        const rowUpdatedAt = Number(row.updatedAt);
        const rowCount = Number(row.itemCount);
        const rowScopeKey = [row.workspacePath, row.sourceId, row.agentInstanceId].map(String).join('\0');
        if (
          rowInvocationId !== invocationId ||
          !rowToolCallId ||
          !/^[a-f0-9]{64}$/u.test(rowEvidenceVersion) ||
          !Number.isFinite(rowUpdatedAt) ||
          !Number.isSafeInteger(rowCount) ||
          rowCount < 1 ||
          rowCount > 1_000
        ) continue;
        if (evidenceVersion && evidenceVersion !== rowEvidenceVersion) return { items: [] };
        if (expectedCount !== undefined && expectedCount !== rowCount) return { items: [] };
        if (relationScopeKey && relationScopeKey !== rowScopeKey) return { items: [] };
        let payload: unknown;
        try {
          payload = JSON.parse(String(row.payload ?? '')) as unknown;
        } catch {
          continue;
        }
        const item = storedToolEvidenceItem(
          payload,
          rowInvocationId,
          rowToolCallId,
          rowEvidenceVersion,
          rowUpdatedAt,
        );
        if (!item) continue;
        items.push(item);
        evidenceVersion = rowEvidenceVersion;
        expectedCount = rowCount;
        relationScopeKey = rowScopeKey;
        updatedAt = Math.max(updatedAt ?? 0, rowUpdatedAt);
      }
      if (!toolCallId && expectedCount !== undefined && items.length !== expectedCount) {
        return { items: [] };
      }
      return { items, evidenceVersion, updatedAt };
    } catch (error) {
      console.error('[clickhouse] ToolEvidence relation query failed:', (error as Error).message);
      return null;
    }
  }

  async writeToolEvidenceRelations(
    items: readonly ToolEvidenceItem[],
    evidenceVersion: string,
    scope: Required<ToolEvidenceRelationScope>,
    updatedAt = Date.now(),
  ): Promise<boolean> {
    if (!this.client || !this.ready || items.length === 0 || items.length > 1_000) return false;
    if (!/^[a-f0-9]{64}$/u.test(evidenceVersion)) return false;
    const invocationIds = new Set(items.map((item) => item.invocationId));
    if (
      invocationIds.size !== 1 ||
      items.some((item) => !item.toolCallId) ||
      !scope.workspacePath ||
      !scope.sourceId ||
      !scope.agentInstanceId
    ) return false;
    try {
      await this.client.insert({
        table: TOOL_EVIDENCE_RELATION_TABLE,
        values: items.map(({ relation: _relation, ...item }) => ({
          invocationId: item.invocationId,
          toolCallId: item.toolCallId,
          workspacePath: scope.workspacePath,
          sourceId: scope.sourceId,
          agentInstanceId: scope.agentInstanceId,
          relationVersion: TOOL_EVIDENCE_RELATION_VERSION,
          evidenceVersion,
          itemCount: items.length,
          updatedAt,
          payload: JSON.stringify(item),
        })),
        format: 'JSONEachRow',
      });
      return true;
    } catch (error) {
      console.error('[clickhouse] ToolEvidence relation insert failed:', (error as Error).message);
      return false;
    }
  }

  private processLifecycleFactFromRow(row: Record<string, unknown>): ProcessLifecycleFact {
    return {
      schemaVersion: 'anysentry.process_lifecycle_fact.v1',
      factId: String(row.factId ?? ''),
      eventId: String(row.eventId ?? ''),
      ...(String(row.sourceEventId ?? '') ? { sourceEventId: String(row.sourceEventId) } : {}),
      factKind: row.factKind === 'exit' ? 'exit' : 'exec',
      at: Number(row.at),
      receivedAt: Number(row.receivedAt),
      source: String(row.source ?? 'observer') as ProcessLifecycleFact['source'],
      ...(String(row.sourceId ?? '') ? { sourceId: String(row.sourceId) } : {}),
      ...(String(row.collectorId ?? '') ? { collectorId: String(row.collectorId) } : {}),
      workspacePath: String(row.workspacePath ?? ''),
      ...(String(row.subjectAssetId ?? '') ? { subjectAssetId: String(row.subjectAssetId) } : {}),
      ...(String(row.subjectAssetType ?? '')
        ? { subjectAssetType: String(row.subjectAssetType) as ProcessLifecycleFact['subjectAssetType'] }
        : {}),
      ...(String(row.assetBindingQuality ?? '')
        ? { assetBindingQuality: String(row.assetBindingQuality) as ProcessLifecycleFact['assetBindingQuality'] }
        : {}),
      ...(Number(row.assetBindingRevision) > 0 ? { assetBindingRevision: Number(row.assetBindingRevision) } : {}),
      ...(String(row.assetBindingReason ?? '') ? { assetBindingReason: String(row.assetBindingReason) } : {}),
      ...(String(row.runtimeInstanceId ?? '') ? { runtimeInstanceId: String(row.runtimeInstanceId) } : {}),
      ...(Number(row.rootProcess) > 0 ? { rootProcess: true } : {}),
      ...(Number(row.identityRevision) > 0 ? { identityRevision: Number(row.identityRevision) } : {}),
      processInstanceKey: String(row.processInstanceKey ?? ''),
      ...(String(row.physicalWorkloadId ?? '') ? { physicalWorkloadId: String(row.physicalWorkloadId) } : {}),
      ...(String(row.hostId ?? '') ? { hostId: String(row.hostId) } : {}),
      bootId: String(row.bootId ?? ''),
      pid: Number(row.pid),
      ...(Number(row.ppid) > 0 ? { ppid: Number(row.ppid) } : {}),
      ...(String(row.pidNamespace ?? '') ? { pidNamespace: String(row.pidNamespace) } : {}),
      ...(Number(row.namespacePid) > 0 ? { namespacePid: Number(row.namespacePid) } : {}),
      ...(Number(row.namespacePpid) > 0 ? { namespacePpid: Number(row.namespacePpid) } : {}),
      startTime: String(row.startTime ?? ''),
      ...(String(row.lifecycleSource ?? '')
        ? { lifecycleSource: String(row.lifecycleSource) as ProcessLifecycleFact['lifecycleSource'] }
        : {}),
      ...(row.factKind === 'exit' && Number(row.exitStatusPresent) > 0
        ? { exitStatus: Number(row.exitStatus) }
        : {}),
      ...(row.factKind === 'exit' && Number(row.exitSignalPresent) > 0
        ? { exitSignal: Number(row.exitSignal) }
        : {}),
      ...(String(row.executableHash ?? '') ? { executableHash: String(row.executableHash) } : {}),
      ...(String(row.commandHash ?? '') ? { commandHash: String(row.commandHash) } : {}),
    };
  }

  async writeProcessLifecycleFacts(facts: readonly ProcessLifecycleFact[]): Promise<boolean> {
    if (facts.length === 0) return true;
    if (!this.client || !this.ready || facts.length > 5_000) return false;
    try {
      await this.client.insert({
        table: PROCESS_LIFECYCLE_FACT_TABLE,
        values: facts.map((fact) => ({
          factId: fact.factId,
          eventId: fact.eventId,
          sourceEventId: fact.sourceEventId ?? '',
          factKind: fact.factKind,
          at: fact.at,
          receivedAt: fact.receivedAt,
          source: fact.source,
          sourceId: fact.sourceId ?? '',
          collectorId: fact.collectorId ?? '',
          workspacePath: fact.workspacePath,
          subjectAssetId: fact.subjectAssetId ?? '',
          subjectAssetType: fact.subjectAssetType ?? '',
          assetBindingQuality: fact.assetBindingQuality ?? '',
          assetBindingRevision: fact.assetBindingRevision ?? 0,
          assetBindingReason: fact.assetBindingReason ?? '',
          runtimeInstanceId: fact.runtimeInstanceId ?? '',
          rootProcess: fact.rootProcess === true ? 1 : 0,
          identityRevision: fact.identityRevision ?? 0,
          processInstanceKey: fact.processInstanceKey,
          physicalWorkloadId: fact.physicalWorkloadId ?? '',
          hostId: fact.hostId ?? '',
          bootId: fact.bootId,
          pid: fact.pid,
          ppid: fact.ppid ?? 0,
          pidNamespace: fact.pidNamespace ?? '',
          namespacePid: fact.namespacePid ?? 0,
          namespacePpid: fact.namespacePpid ?? 0,
          startTime: fact.startTime,
          lifecycleSource: fact.lifecycleSource ?? '',
          exitStatus: fact.exitStatus ?? 0,
          exitStatusPresent: fact.exitStatus !== undefined ? 1 : 0,
          exitSignal: fact.exitSignal ?? 0,
          exitSignalPresent: fact.exitSignal !== undefined ? 1 : 0,
          executableHash: fact.executableHash ?? '',
          commandHash: fact.commandHash ?? '',
        })),
        format: 'JSONEachRow',
      });
      return true;
    } catch (error) {
      console.error('[clickhouse] Process lifecycle fact insert failed:', (error as Error).message);
      return false;
    }
  }

  async readProcessLifecycleFacts(
    processInstanceKeyInput: string,
    sinceMs: number,
    untilMs: number,
    limit = 1_000,
  ): Promise<ProcessLifecycleFact[] | null> {
    const processInstanceKey = processInstanceKeyInput.trim();
    if (!this.client || !this.ready || !/^pri_[a-f0-9]{24}$/u.test(processInstanceKey)) return null;
    const rowLimit = Math.max(1, Math.min(5_000, Math.round(limit)));
    try {
      const result = await this.client.query({
        query: `
          SELECT *
          FROM ${PROCESS_LIFECYCLE_FACT_TABLE} FINAL
          WHERE processInstanceKey = {processInstanceKey:String}
            AND at >= {sinceMs:UInt64}
            AND at <= {untilMs:UInt64}
          ORDER BY at, factKind, eventId
          LIMIT {rowLimit:UInt32}`,
        query_params: { processInstanceKey, sinceMs, untilMs, rowLimit },
        clickhouse_settings: BOUNDED_TOOL_EVIDENCE_RELATION_SETTINGS,
        format: 'JSONEachRow',
      });
      const rows = (await result.json()) as Array<Record<string, unknown>>;
      return rows.map((row) => this.processLifecycleFactFromRow(row));
    } catch (error) {
      console.error('[clickhouse] Process lifecycle fact query failed:', (error as Error).message);
      return null;
    }
  }

  async readRecentProcessLifecycleFacts(
    sinceMs: number,
    untilMs: number,
    limit = 5_000,
  ): Promise<ProcessLifecycleFact[] | null> {
    if (!this.client || !this.ready) return null;
    const rowLimit = Math.max(1, Math.min(10_000, Math.round(limit)));
    try {
      const result = await this.client.query({
        query: `
          SELECT *
          FROM ${PROCESS_LIFECYCLE_FACT_TABLE} FINAL
          WHERE at >= {sinceMs:UInt64}
            AND at <= {untilMs:UInt64}
          ORDER BY at DESC, factKind, eventId
          LIMIT {rowLimit:UInt32}`,
        query_params: { sinceMs, untilMs, rowLimit },
        clickhouse_settings: BOUNDED_PROCESS_LIFECYCLE_READ_SETTINGS,
        format: 'JSONEachRow',
      });
      const rows = (await result.json()) as Array<Record<string, unknown>>;
      return rows.map((row) => this.processLifecycleFactFromRow(row)).reverse();
    } catch (error) {
      console.error('[clickhouse] Recent Process lifecycle fact query failed:', (error as Error).message);
      return null;
    }
  }

  async agentWindowFacts(
    sinceMs: number,
    untilMs: number,
    monitoredOnly: boolean,
    excludedEventIds: string[] = [],
  ): Promise<StoredAgentWindowFact[] | null> {
    if (!this.client || !this.ready) return null;
    const monitoredClause = monitoredOnly
      ? 'AND raw.agentMonitored = 1'
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
        argMax(agentHasRootIdentity, tuple(decisionRevision, decisionUpdatedAt, at)) AS storedHasRootIdentity,
        argMax(agentHasInternalHelperRoot, tuple(decisionRevision, decisionUpdatedAt, at)) AS hasInternalHelperRoot
      FROM ${TABLE} AS raw
      WHERE at >= {since:UInt64} AND at <= {until:UInt64}
        AND eventId NOT IN {excludedEventIds:Array(String)}
        ${monitoredClause}
      GROUP BY eventId
      HAVING 1`;
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
            countIf(collectorId = '' AND eventKind NOT IN ('AgentTool', 'AgentInvocation', 'SystemContext')) AS eventsWithoutCollector,
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
        clickhouse_settings: BOUNDED_DASHBOARD_BUCKET_BUILD_SETTINGS,
        format: 'JSONEachRow',
      });
      const rawRows = await result.json() as Array<Record<string, unknown>>;
      const rows = monitoredOnly ? eligibleAgentRuntimeRows(rawRows) : rawRows;
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
    const monitoredClause = monitoredOnly ? 'AND raw.agentMonitored = 1' : '';
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
            countIf(collectorId = '' AND eventKind NOT IN ('AgentTool', 'AgentInvocation', 'SystemContext')) AS eventsWithoutCollector,
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
              argMax(agentHasRootIdentity, tuple(decisionRevision, decisionUpdatedAt, at)) AS storedHasRootIdentity,
              argMax(agentHasInternalHelperRoot, tuple(decisionRevision, decisionUpdatedAt, at)) AS hasInternalHelperRoot
            FROM ${TABLE} AS raw
            WHERE at >= {since:UInt64} AND at < {endExclusive:UInt64}
              ${monitoredClause}
            GROUP BY eventId
            HAVING 1
          )
          GROUP BY bucketStartMs, identityKey, instanceKey`,
        query_params: {
          since: sinceMs,
          endExclusive: endExclusiveMs,
          bucketMs: Math.max(1, Math.trunc(bucketMs)),
        },
        clickhouse_settings: BOUNDED_DASHBOARD_BUCKET_BUILD_SETTINGS,
        format: 'JSONEachRow',
      });
      const rawRows = await result.json() as Array<Record<string, unknown>>;
      const rows = monitoredOnly ? eligibleAgentRuntimeRows(rawRows) : rawRows;
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
   * Aggregate the overview observability strip in ClickHouse so the API does not hydrate one
   * representative event for every Agent instance merely to compute global totals.
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
        clickhouse_settings: BOUNDED_DASHBOARD_DETAIL_READ_SETTINGS,
        format: 'JSONEachRow',
      });
      const row = ((await result.json()) as Array<Record<string, unknown>>)[0] ?? {};
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
    monitoredOnly: boolean,
    excludedEventIds: string[] = [],
  ): Promise<StoredTopologyWindowFact[] | null> {
    if (!this.client || !this.ready) return null;
    const monitoredClause = monitoredOnly ? 'HAVING agentMonitored = 1' : '';
    try {
      const result = await this.client.query({
        query: `
          SELECT
            identityKey,
            instanceKey,
            max(hasPhysicalIdentity) AS hasPhysicalIdentity,
            maxIf(
              storedHasRootIdentity,
              hasInternalHelperRoot = 0 AND eventKind != 'ProcessExit'
            ) AS hasRootIdentity,
            max(hasInternalHelperRoot) AS hasInternalHelperRootFlag,
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
              argMax(agentInstanceKey, tuple(decisionRevision, decisionUpdatedAt, at)) AS instanceKey,
              argMax(agentMonitored, tuple(decisionRevision, decisionUpdatedAt, at)) AS agentMonitored,
              argMax(agentHasPhysicalIdentity, tuple(decisionRevision, decisionUpdatedAt, at)) AS hasPhysicalIdentity,
              argMax(agentHasRootIdentity, tuple(decisionRevision, decisionUpdatedAt, at)) AS storedHasRootIdentity,
              argMax(agentHasInternalHelperRoot, tuple(decisionRevision, decisionUpdatedAt, at)) AS hasInternalHelperRoot
            FROM ${TABLE}
            WHERE at >= {since:UInt64} AND at <= {until:UInt64}
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
      const rawRows = await result.json() as Array<Record<string, unknown>>;
      const rows = monitoredOnly ? eligibleAgentRuntimeRows(rawRows) : rawRows;
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
    try {
      const result = await this.client.query({
        query: `
          SELECT
            intDiv(eventAt, {bucketMs:UInt64}) * {bucketMs:UInt64} AS bucketStartMs,
            identityKey,
            instanceKey,
            max(hasPhysicalIdentity) AS hasPhysicalIdentity,
            maxIf(
              storedHasRootIdentity,
              hasInternalHelperRoot = 0 AND eventKind != 'ProcessExit'
            ) AS hasRootIdentity,
            max(hasInternalHelperRoot) AS hasInternalHelperRootFlag,
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
              argMax(agentInstanceKey, tuple(decisionRevision, decisionUpdatedAt, at)) AS instanceKey,
              argMax(agentMonitored, tuple(decisionRevision, decisionUpdatedAt, at)) AS agentMonitored,
              argMax(agentHasPhysicalIdentity, tuple(decisionRevision, decisionUpdatedAt, at)) AS hasPhysicalIdentity,
              argMax(agentHasRootIdentity, tuple(decisionRevision, decisionUpdatedAt, at)) AS storedHasRootIdentity,
              argMax(agentHasInternalHelperRoot, tuple(decisionRevision, decisionUpdatedAt, at)) AS hasInternalHelperRoot
            FROM ${TABLE}
            WHERE at >= {since:UInt64} AND at < {endExclusive:UInt64}
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
      const rawRows = await result.json() as Array<Record<string, unknown>>;
      const rows = monitoredOnly ? eligibleAgentRuntimeRows(rawRows) : rawRows;
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
    const uniqueEventIds = [...new Set(eventIds.filter(Boolean))];
    const batches: string[][] = [];
    for (let index = 0; index < uniqueEventIds.length; index += 200) {
      batches.push(uniqueEventIds.slice(index, index + 200));
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
            clickhouse_settings: BOUNDED_DASHBOARD_DETAIL_READ_SETTINGS,
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
    // an arrival-completeness watermark. Pending or replayed older rows must not move it backwards
    // and hide newer facts that are already queryable; affected historical buckets are invalidated
    // by the server-side commit journal when those writes later succeed.
    return this.committedBoundaryComplete ? this.committedThroughMs : undefined;
  }

  /**
   * Return only process-local event revisions that have not completed the ClickHouse FIFO yet.
   *
   * This is intentionally different from the dashboard hot ring: the hot ring also contains
   * already committed rows and cannot be added to a full durable-window query without forcing
   * every historical aggregate to remain uncached. Pending rows stay in `buf` or a sealed batch
   * until the insert succeeds, so a durable full-window read plus this overlay is complete for the
   * current API process even while ingestion never becomes momentarily idle.
   */
  pendingEvents(sinceMs: number, untilMs: number): JudgedEvent[] {
    const latest = new Map<string, JudgedEvent>();
    const accept = (row: Row) => {
      if (row.at < sinceMs || row.at > untilMs) return;
      const event = fromRow(row as unknown as Record<string, unknown>);
      const current = latest.get(event.eventId);
      if (
        !current
        || (event.decisionRevision ?? 1) > (current.decisionRevision ?? 1)
        || (
          (event.decisionRevision ?? 1) === (current.decisionRevision ?? 1)
          && (event.decisionUpdatedAt ?? event.at) > (current.decisionUpdatedAt ?? current.at)
        )
      ) latest.set(event.eventId, event);
    };
    for (const queued of this.buf) accept(queued.row);
    for (const batch of this.eventWriteBatches) {
      for (const row of batch.rows) accept(row);
    }
    return [...latest.values()];
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

  async loadPlatformConfig<T>(configKeyInput: string): Promise<{ record: T; updatedAt: number } | undefined> {
    if (!this.client) return undefined;
    const configKey = configKeyInput.trim().slice(0, 160);
    if (!configKey || !/^[a-z0-9_.:-]+$/iu.test(configKey)) return undefined;
    try {
      const rs = await this.client.query({
        query: `SELECT value, updated_at FROM ${CONFIG_TABLE} FINAL WHERE key = {configKey:String} LIMIT 1`,
        query_params: { configKey },
        format: 'JSONEachRow',
      });
      const rows = await rs.json() as Array<{ value: string; updated_at?: number | string }>;
      if (!rows.length) return undefined;
      const updatedAt = Number(rows[0].updated_at);
      const record = JSON.parse(rows[0].value) as T;
      return { record, updatedAt: Number.isSafeInteger(updatedAt) ? updatedAt : 0 };
    } catch (err) {
      console.error(`[clickhouse] loadPlatformConfig ${configKey} failed:`, (err as Error).message);
      return undefined;
    }
  }

  async savePlatformConfig<T>(configKeyInput: string, record: T, updatedAtInput = Date.now()): Promise<boolean> {
    if (!this.client) return false;
    const configKey = configKeyInput.trim().slice(0, 160);
    if (!configKey || !/^[a-z0-9_.:-]+$/iu.test(configKey)) return false;
    try {
      const value = JSON.stringify(record);
      if (Buffer.byteLength(value, 'utf8') > 16 * 1024 * 1024) {
        throw new Error('platform config exceeds the 16 MiB persistence bound');
      }
      const updatedAt = Number.isSafeInteger(updatedAtInput) && updatedAtInput >= 0
        ? updatedAtInput
        : Date.now();
      await this.client.insert({
        table: CONFIG_TABLE,
        values: [{ key: configKey, value, updated_at: updatedAt }],
        format: 'JSONEachRow',
      });
      return true;
    } catch (err) {
      console.error(`[clickhouse] savePlatformConfig ${configKey} failed:`, (err as Error).message);
      return false;
    }
  }

  async loadUnknownLearningState(): Promise<unknown | undefined> {
    if (!this.client) return undefined;
    try {
      const rs = await this.client.query({
        query: `SELECT value, updated_at FROM ${CONFIG_TABLE} FINAL WHERE key = 'unknown_learning_state_v1' LIMIT 1`,
        format: 'JSONEachRow',
      });
      const rows = (await rs.json()) as Array<{ value: string; updated_at?: number | string }>;
      const persistedVersion = Number(rows[0]?.updated_at);
      if (Number.isSafeInteger(persistedVersion) && persistedVersion > this.unknownLearningStateVersion) {
        this.unknownLearningStateVersion = persistedVersion;
      }
      return rows.length ? JSON.parse(rows[0].value) as unknown : undefined;
    } catch (err) {
      console.error('[clickhouse] loadUnknownLearningState failed:', (err as Error).message);
      return undefined;
    }
  }

  async saveUnknownLearningState(state: unknown): Promise<boolean> {
    if (!this.client) return false;
    try {
      const value = JSON.stringify(state);
      // The runtime service exports a stricter configured bound. This last storage guard prevents
      // a programming error from turning one config row into an unbounded ClickHouse insert.
      if (Buffer.byteLength(value, 'utf8') > 16 * 1024 * 1024) {
        throw new Error('Unknown learning state exceeds the 16 MiB persistence bound');
      }
      const updatedAt = Math.max(Date.now(), this.unknownLearningStateVersion + 1);
      this.unknownLearningStateVersion = updatedAt;
      await this.client.insert({
        table: CONFIG_TABLE,
        values: [{ key: 'unknown_learning_state_v1', value, updated_at: updatedAt }],
        format: 'JSONEachRow',
      });
      return true;
    } catch (err) {
      console.error('[clickhouse] saveUnknownLearningState failed:', (err as Error).message);
      return false;
    }
  }

  async loadCollectorHeartbeats(limit = 1_000): Promise<CollectorHeartbeatRecord[]> {
    if (!this.client) return [];
    const safeLimit = Math.max(128, Math.min(2_000, Math.trunc(limit) || 1_000));
    try {
      const existenceResult = await this.client.query({
        query: `SELECT 1 AS present FROM ${COLLECTOR_HEARTBEAT_TABLE} LIMIT 1`,
        format: 'JSONEachRow',
      });
      const existenceRows = await existenceResult.json() as Array<{ present?: string | number }>;
      if (Number(existenceRows[0]?.present ?? 0) !== 1) {
        // One-time compatibility bridge. Slice the legacy JSON array inside ClickHouse so a large
        // historical snapshot is never transferred and expanded in the Node.js heap merely to
        // keep the newest bounded working set.
        const legacyResult = await this.client.query({
          query: `
            SELECT arraySlice(JSONExtractArrayRaw(value), -{limit:Int32}) AS records
            FROM ${CONFIG_TABLE} FINAL
            WHERE key = 'collector_heartbeats'
            LIMIT 1`,
          query_params: { limit: safeLimit },
          format: 'JSONEachRow',
        });
        const legacyRows = await legacyResult.json() as Array<{ records?: string[] }>;
        const records = (legacyRows[0]?.records ?? []).flatMap((value) => {
          try {
            return [JSON.parse(value) as CollectorHeartbeatRecord];
          } catch {
            return [];
          }
        });
        if (records.length > 0) {
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

      const recentResult = await this.client.query({
        query: `
          SELECT collectorId, at, payload
          FROM (
            SELECT collectorId, at, payload
            FROM ${COLLECTOR_HEARTBEAT_TABLE}
            ORDER BY at DESC
            LIMIT {scanLimit:UInt32}
          )
          ORDER BY at DESC
          LIMIT {scanLimit:UInt32}`,
        query_params: { scanLimit: safeLimit * 2 },
        format: 'JSONEachRow',
      });
      const recentRows = await recentResult.json() as Array<{
        collectorId?: string;
        at?: string | number;
        payload?: string;
      }>;
      const unique = new Map<string, CollectorHeartbeatRecord>();
      for (const row of recentRows) {
        try {
          if (!row.payload) continue;
          const record = JSON.parse(row.payload) as CollectorHeartbeatRecord;
          unique.set(`${String(row.collectorId ?? record.collectorId)}\u0000${Number(row.at ?? record.at)}`, record);
        } catch {
          // A malformed legacy row must not prevent later valid heartbeats from hydrating.
        }
        if (unique.size >= safeLimit) break;
      }
      return [...unique.values()].reverse();
    } catch (err) {
      console.error('[clickhouse] loadCollectorHeartbeats failed:', (err as Error).message);
      return [];
    }
  }

  close(): Promise<void> {
    if (this.closeInFlight) return this.closeInFlight;
    // Change the externally visible state before the first await so a concurrent enqueue cannot
    // slip into the shutdown tail after it was sealed.
    this.closing = true;
    this.ready = false;
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = undefined;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    if (this.eventWriteRetryWakeTimer) clearTimeout(this.eventWriteRetryWakeTimer);
    this.eventWriteRetryWakeTimer = undefined;
    if (this.immediateWriteTimer) clearTimeout(this.immediateWriteTimer);
    this.immediateWriteTimer = undefined;
    this.eventWriteCloseDeadlineMs = boundedPositiveInt(
      process.env.ANYSENTRY_CLICKHOUSE_SHUTDOWN_FLUSH_MS,
      EVENT_WRITE_CLOSE_DEADLINE_MS,
      100,
      60_000,
    );
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
        this.immediateWriteQueue.length > 0
        && this.eventWriteNow() < (this.eventWriteClosingDeadline ?? 0)
      ) {
        try {
          await this.drainImmediateWrites();
        } catch {
          break;
        }
      }
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
      this.closed = true;
      this.eventWriteAbortController?.abort('ClickHouse event writer is closing');
      this.wakeEventWriteRetrySleep();
      for (const batch of this.eventWriteBatches) {
        for (const waiter of batch.waiters.splice(0)) {
          waiter.reject(closeError ?? new Error('ClickHouse event writer closed before the direct write completed'));
        }
      }
      const receiptShutdownError =
        closeError ?? new Error('ClickHouse store closed before event receipt became durable');
      for (const entry of this.immediateWriteQueue.splice(0)) entry.reject(receiptShutdownError);
      this.immediateWriteQueueBytes = 0;
      this.immediateWriteEventTimes.clear();
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
