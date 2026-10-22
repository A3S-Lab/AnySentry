import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Pool, PoolClient } from 'pg';
import {
  AgentMetadataRecord,
  AgentRuntimeInstanceRecord,
  AgentSemanticKernelRelation,
  AgentConversationBindingRecord,
  AgentConversationThreadRecord,
  AgentConversationAnchor,
  ConversationInstanceSegment,
  AgentWorkspaceBindingRecord,
  AlertRecord,
  IngestionSourceRecord,
  Incident,
  MaintenanceWindowRecord,
  NotificationChannelRecord,
  NotificationRouteRecord,
  ObjectiveRecord,
  PlatformUserRecord,
  RemediationRecord,
  WorkspaceDirectoryRecord,
  RawObservation,
  KernelFact,
  SemanticRecord,
  CoverageGap,
  EvidenceLink,
  SessionMembership,
} from './types';
import type {
  ConversationMembershipV2,
  ConversationRouteAliasV1,
  TechnicalActivityProjection,
} from './agent-conversation-resolution-v2';
import {
  validateCoverageGap,
  validateEvidenceLink,
  validateKernelFact,
  validateRawObservation,
  validateSemanticRecord,
  validateSessionMembership,
} from './canonical-observability';
import { PolicyConfig } from './policy-config';
import {
  interactionPayloadFingerprint,
  type InteractionRecord,
  type InteractionReceiptReservation,
} from './interaction.types';
import type {
  EncryptedInteractionContent,
  InteractionContentFinalizeResult,
  StoredInteractionContent,
} from './interaction-content.types';
import type {
  EventSessionAttributionResult,
  EventSessionRelation,
  ProcessLineageEdge,
  SessionProcessBinding,
} from './session-event-attribution.types';
import { SESSION_EVENT_ATTRIBUTION_VERSION } from './session-event-attribution.types';

export const INVALIDATE_OLD_SESSION_RELATIONS_SQL = `
  UPDATE anysentry_event_session_relations
     SET record = record || jsonb_build_object(
       'active', false, 'effectiveTo', $2::bigint,
       'invalidationReason', 'attribution_algorithm_upgrade',
       'requiresReattribution', true),
         updated_at = $2::bigint
   WHERE COALESCE((record->>'active')::boolean, true)
     AND COALESCE((record->>'attributionVersion')::integer, 0) < $1
`;

// Unfiltered "latest n" reads stay inside one day. Point reads by id are not limited.
// A BRIN index can skip old pages only when the scan has a time predicate (design §6.4).
const RECENT_READ_WINDOW_MS = 24 * 60 * 60 * 1000;

function recentUnixNsFloor(windowMs = RECENT_READ_WINDOW_MS): string {
  return (BigInt(Date.now()) * 1_000_000n - BigInt(windowMs) * 1_000_000n).toString();
}

const AGENT_METADATA_LIMIT = 10_000;
const WORKSPACE_DIRECTORY_LIMIT = 10_000;
const AGENT_WORKSPACE_BINDING_LIMIT = 100_000;
const AGENT_RUNTIME_INSTANCE_LIMIT = 100_000;
const AGENT_CONVERSATION_BINDING_LIMIT = 100_000;
const RAW_OBSERVATION_LIMIT = 100_000;
const KERNEL_FACT_LIMIT = 200_000;
const SEMANTIC_RECORD_LIMIT = 200_000;
const SESSION_MEMBERSHIP_LIMIT = 200_000;
const INCIDENT_LIMIT = 20_000;
const ALERT_LIMIT = 20_000;
const REMEDIATION_LIMIT = 20_000;
const CONFIG_OBJECT_LIMIT = 20_000;
const BUSINESS_WRITE_MAX_ATTEMPTS = 3;
const BUSINESS_WRITE_BATCH_SIZE = 250;
const EFFECT_LEASE_MS = 60_000;
const WRITER_OWNERSHIP_CACHE_MAX_ENTRIES = 10_000;
const WRITER_OWNERSHIP_CACHE_MAX_BYTES = 2 * 1024 * 1024;
const WRITER_OWNERSHIP_IN_FLIGHT_MAX_ENTRIES = 1_024;
const WRITER_OWNERSHIP_IN_FLIGHT_TIMEOUT_MS = 30_000;
// Conversation resolution is a derived projection, but it can fan out one interaction into many
// anchors. Keep each transactional JSON payload bounded independently of the canonical event
// stores; callers receive `false` and retain the hot projection when a batch exceeds these caps.
const CONVERSATION_RESOLUTION_V2_MAX_ANCHORS = 50_000;
const CONVERSATION_RESOLUTION_V2_MAX_MEMBERSHIPS = 20_000;
const CONVERSATION_RESOLUTION_V2_MAX_ALIASES = 20_000;
const CONVERSATION_RESOLUTION_V2_MAX_TECHNICAL = 20_000;
const CONVERSATION_RESOLUTION_V2_MAX_BYTES = 32 * 1024 * 1024;
const CONVERSATION_RESOLUTION_V2_MAX_CATEGORY_BYTES = 16 * 1024 * 1024;
// V1 tables remain a mutable latest-value compatibility projection, but their transport into
// PostgreSQL must still be bounded. Canonical SessionMembership/Relation history is written via
// the versioned append-only paths below; rejecting an oversized compatibility batch is safer than
// allocating an unbounded JSON document inside the API or database connection.
const CONVERSATION_RESOLUTION_V1_MAX_THREADS = 20_000;
const CONVERSATION_RESOLUTION_V1_MAX_SEGMENTS = 50_000;
const CONVERSATION_RESOLUTION_V1_MAX_BINDINGS = 100_000;
const CONVERSATION_RESOLUTION_V1_MAX_BYTES = 32 * 1024 * 1024;
const CONVERSATION_RESOLUTION_V1_MAX_CATEGORY_BYTES = 16 * 1024 * 1024;
const SEMANTIC_KERNEL_RELATION_MAX_ROWS = 100_000;
const SEMANTIC_KERNEL_RELATION_MAX_BYTES = 32 * 1024 * 1024;
const CANONICAL_WRITE_MAX_BYTES = 64 * 1024 * 1024;
const COVERAGE_GAP_REVISION_KEEP = 32;
const COVERAGE_GAP_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const COVERAGE_GAP_TTL_PRUNE_EVERY = 256;
/** One ingest save must not delete the historic 7-day tail in a single statement.
 *  An unbounded `DELETE WHERE last_seen_at < ttl` on this table wrote ~1 GiB WAL
 *  during a 5-minute Observer window while raw_observations only grew by ~500 rows. */
const COVERAGE_GAP_TTL_PRUNE_BATCH = 256;
/** Observer-paused hosts still need to retire the historic per-cgroup revision pile.
 *  Each idle tick deletes at most this many rows so WAL stays comparable to ingest prune. */
const COVERAGE_GAP_IDLE_PRUNE_BATCH = 8_192;
const COVERAGE_GAP_IDLE_PRUNE_MS = 20_000;
const COVERAGE_GAP_IDLE_SAMPLE_ROWS = 8_192;
// When the event loop is saturated (e.g. a dense host rebuilding its inventory), PostgreSQL
// operations start failing with connect timeouts even though the server is healthy. Each failing
// operation used to log immediately, and the resulting warn flood further starved the loop,
// producing a death spiral. Coalesce repeat warnings per operation and, once failures cluster,
// open a short circuit breaker so callers fast-fail instead of paying a full connect timeout.
const UNAVAILABLE_WARN_COALESCE_MS = 60_000;
const OPERATION_FAILURE_WINDOW_MS = 10_000;
const OPERATION_FAILURE_BREAKER_THRESHOLD = 5;
const OPERATION_FAILURE_BREAKER_COOLDOWN_MS = 30_000;
const PG_COOLDOWN_ERROR_CODE = 'A3S_PG_COOLDOWN';

type ProjectionBatchEntry<T> = {
  rows: readonly T[];
  bytes: number;
  resolve: (value: boolean) => void;
};

type ProjectionBatchState<T> = {
  queue: Array<ProjectionBatchEntry<T>>;
  pendingRows: number;
  pendingBytes: number;
  timer?: ReturnType<typeof setTimeout>;
  inFlight?: Promise<void>;
  closed: boolean;
};

function validatedRawRecord(value: unknown): RawObservation | undefined {
  const checked = validateRawObservation(value);
  if (!checked.ok) return undefined;
  const payload = { ...checked.value.payload };
  delete payload.body;
  if (payload.redactionState === 'none' || payload.redactionState === 'partial') {
    payload.redactionState = 'hash_only';
  }
  return { ...checked.value, payload };
}

function stableRecordJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableRecordJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableRecordJson(item)}`)
    .join(',')}}`;
}

function batchHasConflictingRecords<T>(rows: readonly T[], keyOf: (row: T) => string): boolean {
  const fingerprints = new Map<string, string>();
  for (const row of rows) {
    const key = keyOf(row);
    const fingerprint = stableRecordJson(row);
    const previous = fingerprints.get(key);
    if (previous !== undefined && previous !== fingerprint) return true;
    fingerprints.set(key, fingerprint);
  }
  return false;
}

function boundedJsonRows<T>(rows: readonly T[], maxRows: number, maxBytes: number): string | undefined {
  if (rows.length > maxRows) return undefined;
  const json = JSON.stringify(rows);
  return typeof json === 'string' && Buffer.byteLength(json, 'utf8') <= maxBytes ? json : undefined;
}

export type BusinessEffectLease =
  | { status: 'acquired' }
  | { status: 'duplicate' }
  | { status: 'busy' }
  | { status: 'conflict'; acceptedFingerprint: string }
  | { status: 'unavailable' };

export type WriterOwnership =
  | { status: 'owned' }
  | { status: 'conflict'; ownerWriterId: string; leaseExpiresAt: number }
  | { status: 'unavailable' };

export interface AgentConversationAnchorPersistence {
  interactionId: string;
  logicalScopeKey: string;
  observedAt: number;
  anchor: AgentConversationAnchor;
}

export interface AgentConversationAnchorMembershipMatch {
  anchor: AgentConversationAnchorPersistence;
  membership: ConversationMembershipV2;
}

export interface AgentConversationInteractionMembershipSlice {
  interactionIds: string[];
  truncated: boolean;
}

interface InteractionContentDbRow {
  content_ref: string;
  interaction_id: string;
  conversation_id: string;
  source_id: string;
  source_event_id: string;
  tenant_id: string;
  content_role: 'user_instruction' | 'assistant_response';
  content_sha256: string;
  content_bytes: string | number;
  key_version: string;
  algorithm: 'aes-256-gcm';
  nonce: Buffer;
  auth_tag: Buffer;
  ciphertext: Buffer;
  state: 'pending' | 'accepted' | 'deleted';
  finalized_at: string | number;
  accepted_at: string | number | null;
  deleted_at: string | number | null;
}

function positiveInt(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

function storedInteractionContent(row: InteractionContentDbRow): StoredInteractionContent {
  return {
    contentRef: row.content_ref,
    interactionId: row.interaction_id,
    conversationId: row.conversation_id,
    sourceId: row.source_id,
    sourceEventId: row.source_event_id,
    tenantId: row.tenant_id,
    contentRole: row.content_role,
    contentSha256: row.content_sha256,
    contentBytes: Number(row.content_bytes),
    keyVersion: row.key_version,
    algorithm: row.algorithm,
    nonce: row.nonce,
    authTag: row.auth_tag,
    ciphertext: row.ciphertext,
    state: row.state,
    finalizedAt: Number(row.finalized_at),
    acceptedAt: row.accepted_at === null ? undefined : Number(row.accepted_at),
    deletedAt: row.deleted_at === null ? undefined : Number(row.deleted_at),
  };
}

/**
 * Mutable business state belongs in a transactional store, not in ClickHouse config rows.
 *
 * PostgreSQL is optional during the migration. When it is unavailable, callers continue to use
 * the existing ClickHouse copy; when configured, writes are made per domain object so concurrent
 * API replicas cannot overwrite an unrelated Agent record.
 */
@Injectable()
export class RelationalBusinessStore implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(RelationalBusinessStore.name);
  private readonly databaseUrl =
    process.env.ANYSENTRY_DATABASE_URL?.trim() ??
    process.env.ANYSENTRY_POSTGRES_URL?.trim() ??
    '';
  // PostgreSQL contains mutable business projections.  During an Observer soak on a shared
  // node these projections are intentionally switchable: ClickHouse remains the authoritative
  // event/fact store while a disabled relational lane avoids turning every alert/incident update
  // into a competing transaction and records its availability as false.  The default stays on so
  // ordinary deployments preserve the existing migration behaviour.
  private readonly persistenceEnabled =
    process.env.ANYSENTRY_RELATIONAL_PERSIST !== 'off';
  private pool?: Pool;
  private initializePromise?: Promise<boolean>;
  private ready = false;
  private readonly unavailableWarnedAt = new Map<string, number>();
  private readonly unavailableSuppressed = new Map<string, number>();
  private recentOperationFailureAt: number[] = [];
  private operationCooldownUntil = 0;
  private readonly rawBatchMaxRows = positiveInt(
    process.env.ANYSENTRY_RELATIONAL_RAW_BATCH_ROWS,
    256,
    2_000,
  );
  private readonly rawBatchMaxBytes = positiveInt(
    process.env.ANYSENTRY_RELATIONAL_RAW_BATCH_MAX_BYTES,
    8 * 1024 * 1024,
    64 * 1024 * 1024,
  );
  private readonly rawBatchWindowMs = positiveInt(
    process.env.ANYSENTRY_RELATIONAL_RAW_BATCH_WINDOW_MS,
    10,
    1_000,
  );
  private rawBatchQueue: Array<{ rows: readonly RawObservation[]; resolve: (value: boolean) => void }> = [];
  private rawBatchTimer?: ReturnType<typeof setTimeout>;
  private rawBatchFlushInFlight?: Promise<void>;
  private readonly semanticBatchMaxRows = positiveInt(
    process.env.ANYSENTRY_RELATIONAL_SEMANTIC_BATCH_ROWS,
    128,
    2_000,
  );
  private readonly semanticBatchWindowMs = positiveInt(
    process.env.ANYSENTRY_RELATIONAL_SEMANTIC_BATCH_WINDOW_MS,
    10,
    1_000,
  );
  private readonly semanticPendingMaxRows = positiveInt(
    process.env.ANYSENTRY_RELATIONAL_SEMANTIC_PENDING_ROWS, 4_096, SEMANTIC_RECORD_LIMIT,
  );
  private readonly semanticPendingMaxBytes = positiveInt(
    process.env.ANYSENTRY_RELATIONAL_SEMANTIC_PENDING_BYTES, 8 * 1024 * 1024, CANONICAL_WRITE_MAX_BYTES,
  );
  private semanticPendingRows = 0;
  private semanticPendingBytes = 0;
  private semanticBatchClosed = false;
  private semanticBatchQueue: Array<{ rows: readonly SemanticRecord[]; bytes: number; resolve: (value: boolean) => void }> = [];
  private semanticBatchTimer?: ReturnType<typeof setTimeout>;
  private semanticBatchFlushInFlight?: Promise<void>;
  private readonly evidenceBatchMaxRows = positiveInt(
    process.env.ANYSENTRY_RELATIONAL_EVIDENCE_BATCH_ROWS, 128, 2_000,
  );
  private readonly sessionBatchMaxRows = positiveInt(
    process.env.ANYSENTRY_RELATIONAL_SESSION_BATCH_ROWS, 128, 2_000,
  );
  private readonly projectionBatchWindowMs = positiveInt(
    process.env.ANYSENTRY_RELATIONAL_PROJECTION_BATCH_WINDOW_MS, 10, 1_000,
  );
  private readonly projectionPendingMaxRows = positiveInt(
    process.env.ANYSENTRY_RELATIONAL_PROJECTION_PENDING_ROWS, 4_096, 200_000,
  );
  private readonly projectionPendingMaxBytes = positiveInt(
    process.env.ANYSENTRY_RELATIONAL_PROJECTION_PENDING_BYTES, 8 * 1024 * 1024, CANONICAL_WRITE_MAX_BYTES,
  );
  private evidenceBatch: ProjectionBatchState<EvidenceLink> = {
    queue: [], pendingRows: 0, pendingBytes: 0, closed: false,
  };
  private sessionBatch: ProjectionBatchState<SessionMembership> = {
    queue: [], pendingRows: 0, pendingBytes: 0, closed: false,
  };
  private evidenceLinksReadFailureAt = 0;
  private shuttingDown = false;
  private readonly effectOwnerId = `api:${process.pid}:${randomUUID()}`;
  private readonly writerOwnershipCache = new Map<string, number>();
  private readonly writerOwnershipInFlight = new Map<string, Promise<WriterOwnership>>();
  private coverageGapPruneCounter = 0;
  private coverageGapIdleTimer?: NodeJS.Timeout;
  private coverageGapIdlePruneInFlight = false;
  private writerOwnershipCacheBytes = 0;
  private writerOwnershipCacheExpired = 0;
  private writerOwnershipCacheEvicted = 0;
  private writerOwnershipInFlightRejected = 0;
  private writerOwnershipInFlightTimeouts = 0;

  configured(): boolean {
    return this.persistenceEnabled && Boolean(this.databaseUrl);
  }

  isReady(): boolean {
    return this.ready;
  }

  /** Read-side availability for the canonical EvidenceLink index. A successful empty query is
   * healthy; callers use this distinction to label hot-ring fallback as partial during outages. */
  isEvidenceLinksReadAvailable(): boolean {
    return this.evidenceLinksReadFailureAt === 0;
  }

  async onModuleInit(): Promise<void> {
    await this.initialize();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.coverageGapIdleTimer) clearTimeout(this.coverageGapIdleTimer);
    this.coverageGapIdleTimer = undefined;
    this.semanticBatchClosed = true;
    this.evidenceBatch.closed = true;
    this.sessionBatch.closed = true;
    if (this.rawBatchTimer) clearTimeout(this.rawBatchTimer);
    this.rawBatchTimer = undefined;
    while (this.rawBatchFlushInFlight || this.rawBatchQueue.length > 0) {
      await (this.rawBatchFlushInFlight ?? this.flushRawBatchQueue());
    }
    if (this.semanticBatchTimer) clearTimeout(this.semanticBatchTimer);
    this.semanticBatchTimer = undefined;
    while (this.semanticBatchFlushInFlight || this.semanticBatchQueue.length > 0) {
      await (this.semanticBatchFlushInFlight ?? this.flushSemanticBatchQueue());
    }
    for (const state of [this.evidenceBatch, this.sessionBatch]) {
      if (state.timer) clearTimeout(state.timer);
      state.timer = undefined;
    }
    while (this.evidenceBatch.inFlight || this.evidenceBatch.queue.length > 0) {
      await (this.evidenceBatch.inFlight ?? this.flushProjectionBatch(
        this.evidenceBatch, this.evidenceBatchMaxRows,
        rows => this.saveEvidenceLinksNow(rows), row => `${row.linkId}\0${row.resolutionRevision}`,
      ));
    }
    while (this.sessionBatch.inFlight || this.sessionBatch.queue.length > 0) {
      await (this.sessionBatch.inFlight ?? this.flushProjectionBatch(
        this.sessionBatch, this.sessionBatchMaxRows,
        rows => this.saveSessionMembershipsNow(rows), row => `${row.membershipId}\0${row.resolutionRevision}`,
      ));
    }
  }

  // All business destroy/before-shutdown hooks must finish before the shared pool closes.
  async onApplicationShutdown(): Promise<void> {
    this.shuttingDown = true;
    const pool = this.pool;
    this.pool = undefined;
    this.ready = false;
    this.writerOwnershipCache.clear();
    this.writerOwnershipCacheBytes = 0;
    this.writerOwnershipInFlight.clear();
    if (pool) await pool.end().catch(() => undefined);
  }

  async initialize(): Promise<boolean> {
    if (this.shuttingDown) return false;
    if (this.ready && this.pool) return true;
    if (!this.configured()) return false;
    if (this.initializePromise) return this.initializePromise;

    this.initializePromise = this.connect();
    const initialized = await this.initializePromise;
    this.initializePromise = undefined;
    return initialized;
  }

  async loadAgentMetadata(): Promise<AgentMetadataRecord[]> {
    if (!(await this.initialize()) || !this.pool) return [];
    try {
      const result = await this.pool.query<{ record: AgentMetadataRecord | string }>(
        `SELECT record
           FROM anysentry_agent_metadata
          ORDER BY updated_at DESC
          LIMIT $1`,
        [AGENT_METADATA_LIMIT],
      );
      return result.rows
        .map(({ record }) => {
          if (typeof record !== 'string') return record;
          try {
            return JSON.parse(record) as AgentMetadataRecord;
          } catch {
            return undefined;
          }
        })
        .filter((record): record is AgentMetadataRecord => Boolean(record?.agentAssetId));
    } catch (error) {
      this.markUnavailable('load Agent metadata', error);
      return [];
    }
  }

  async saveAgentMetadata(records: AgentMetadataRecord[]): Promise<boolean> {
    if (records.length === 0) return true;
    if (!(await this.initialize()) || !this.pool) return false;

    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect();
      await client.query('BEGIN');
      for (const record of records) {
        const aliases = [...new Set(record.agentAssetAliases ?? [])]
          .filter((alias) => alias && alias !== record.agentAssetId);
        await client.query(
          `INSERT INTO anysentry_agent_metadata (
             agent_asset_id,
             agent_id,
             workspace_path,
             record,
             updated_at
           ) VALUES ($1, $2, $3, $4::jsonb, $5)
           ON CONFLICT (agent_asset_id) DO UPDATE SET
             agent_id = EXCLUDED.agent_id,
             workspace_path = EXCLUDED.workspace_path,
             record = EXCLUDED.record,
             updated_at = EXCLUDED.updated_at
           WHERE EXCLUDED.updated_at >= anysentry_agent_metadata.updated_at`,
          [
            record.agentAssetId,
            record.agentId,
            record.workspacePath,
            JSON.stringify(record),
            record.updatedAt,
          ],
        );
        if (aliases.length > 0) {
          // Canonical identity can change as stronger workload evidence arrives. Cleanup follows
          // the canonical upsert and never removes an alias row newer than this observation.
          await client.query(
            `DELETE FROM anysentry_agent_metadata
              WHERE agent_asset_id = ANY($1::text[])
                AND agent_asset_id <> $2
                AND updated_at <= $3`,
            [aliases, record.agentAssetId, record.updatedAt],
          );
        }
      }
      await client.query('COMMIT');
      return true;
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => undefined);
      this.markUnavailable('save Agent metadata', error);
      return false;
    } finally {
      client?.release();
    }
  }

  async loadWorkspaceDirectory(): Promise<WorkspaceDirectoryRecord[]> {
    if (!(await this.initialize()) || !this.pool) return [];
    try {
      const result = await this.pool.query<{ record: WorkspaceDirectoryRecord | string }>(
        `SELECT record
           FROM anysentry_workspace_directory
          ORDER BY updated_at DESC
          LIMIT $1`,
        [WORKSPACE_DIRECTORY_LIMIT],
      );
      return result.rows
        .map(({ record }) => this.parseRecord<WorkspaceDirectoryRecord>(record))
        .filter((record): record is WorkspaceDirectoryRecord =>
          Boolean(record?.workspaceId && record.workspacePath));
    } catch (error) {
      this.markUnavailable('load Workspace directory', error);
      return [];
    }
  }

  async saveWorkspaceDirectory(records: WorkspaceDirectoryRecord[]): Promise<boolean> {
    if (records.length === 0) return true;
    if (!(await this.initialize()) || !this.pool) return false;
    try {
      for (const record of records) {
        await this.pool.query(
          `INSERT INTO anysentry_workspace_directory (
             workspace_id,
             workspace_path,
             workspace_path_fingerprint,
             display_name,
             repository_id,
             source_id,
             environment_id,
             node_scope,
             record,
             first_seen_at,
             last_seen_at,
             updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12)
           ON CONFLICT (workspace_id) DO UPDATE SET
             workspace_path = EXCLUDED.workspace_path,
             workspace_path_fingerprint = EXCLUDED.workspace_path_fingerprint,
             display_name = EXCLUDED.display_name,
             repository_id = EXCLUDED.repository_id,
             source_id = EXCLUDED.source_id,
             environment_id = EXCLUDED.environment_id,
             node_scope = EXCLUDED.node_scope,
             record = EXCLUDED.record,
             first_seen_at = LEAST(anysentry_workspace_directory.first_seen_at, EXCLUDED.first_seen_at),
             last_seen_at = GREATEST(anysentry_workspace_directory.last_seen_at, EXCLUDED.last_seen_at),
             updated_at = EXCLUDED.updated_at
           WHERE EXCLUDED.updated_at >= anysentry_workspace_directory.updated_at`,
          [
            record.workspaceId,
            record.workspacePath,
            record.workspacePathFingerprint,
            record.displayName,
            record.repositoryId ?? null,
            record.sourceId ?? null,
            record.environmentId ?? null,
            record.nodeScope ?? null,
            JSON.stringify(record),
            record.firstSeenAt,
            record.lastSeenAt,
            record.updatedAt,
          ],
        );
      }
      return true;
    } catch (error) {
      this.markUnavailable('save Workspace directory', error);
      return false;
    }
  }

  async loadAgentWorkspaceBindings(): Promise<AgentWorkspaceBindingRecord[]> {
    if (!(await this.initialize()) || !this.pool) return [];
    try {
      const result = await this.pool.query<{ record: AgentWorkspaceBindingRecord | string }>(
        `SELECT record
           FROM anysentry_agent_workspace_bindings
          ORDER BY updated_at DESC
          LIMIT $1`,
        [AGENT_WORKSPACE_BINDING_LIMIT],
      );
      return result.rows
        .map(({ record }) => this.parseRecord<AgentWorkspaceBindingRecord>(record))
        .filter((record): record is AgentWorkspaceBindingRecord =>
          Boolean(record?.bindingId && record.agentAssetId && record.workspaceId));
    } catch (error) {
      this.markUnavailable('load Agent-Workspace bindings', error);
      return [];
    }
  }

  async saveAgentWorkspaceBindings(records: AgentWorkspaceBindingRecord[]): Promise<boolean> {
    if (records.length === 0) return true;
    if (!(await this.initialize()) || !this.pool) return false;
    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect();
      await client.query('BEGIN');
      for (const record of records) {
        await client.query(
          `INSERT INTO anysentry_agent_workspace_bindings (
             binding_id,
             agent_asset_id,
             workspace_id,
             workspace_path,
             valid_from,
             valid_to,
             last_observed_at,
             record,
             updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
           ON CONFLICT (binding_id) DO UPDATE SET
             workspace_path = EXCLUDED.workspace_path,
             valid_from = LEAST(anysentry_agent_workspace_bindings.valid_from, EXCLUDED.valid_from),
             valid_to = EXCLUDED.valid_to,
             last_observed_at = GREATEST(anysentry_agent_workspace_bindings.last_observed_at, EXCLUDED.last_observed_at),
             record = EXCLUDED.record,
             updated_at = EXCLUDED.updated_at
           WHERE EXCLUDED.updated_at >= anysentry_agent_workspace_bindings.updated_at`,
          [
            record.bindingId,
            record.agentAssetId,
            record.workspaceId,
            record.workspacePath,
            record.validFrom,
            record.validTo ?? null,
            record.lastObservedAt,
            JSON.stringify(record),
            record.updatedAt,
          ],
        );
      }
      await client.query('COMMIT');
      return true;
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => undefined);
      this.markUnavailable('save Agent-Workspace bindings', error);
      return false;
    } finally {
      client?.release();
    }
  }

  async loadAgentRuntimeInstances(): Promise<AgentRuntimeInstanceRecord[]> {
    if (!(await this.initialize()) || !this.pool) return [];
    try {
      const result = await this.pool.query<{ record: AgentRuntimeInstanceRecord | string }>(
        `SELECT record
           FROM anysentry_agent_runtime_instances_v2
          ORDER BY updated_at DESC
          LIMIT $1`,
        [AGENT_RUNTIME_INSTANCE_LIMIT],
      );
      return result.rows
        .map(({ record }) => this.parseRecord<AgentRuntimeInstanceRecord>(record))
        .filter((record): record is AgentRuntimeInstanceRecord => Boolean(
          record?.agentInstanceId
          && record.canonicalAgentInstanceId
          && record.rootPid
          && record.rootStartTimeTicks,
        ));
    } catch (error) {
      this.markUnavailable('load Agent Runtime instances', error);
      return [];
    }
  }

  async saveAgentRuntimeInstances(records: AgentRuntimeInstanceRecord[]): Promise<boolean> {
    if (records.length === 0) return true;
    if (!(await this.initialize()) || !this.pool) return false;
    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect();
      await client.query('BEGIN');
      const normalizedRecords = records.map((record) => {
        const canonical = record.canonicalAgentInstanceId ?? record.agentInstanceId;
        const aliases = [...new Set([
          canonical,
          record.agentInstanceId,
          ...(record.agentInstanceAliases ?? []),
        ])].filter(Boolean);
        const updatedAt = Math.max(
          record.receivedAt,
          record.lastSeenAt,
          record.endedAt ?? 0,
        );
        return {
          ...record,
          canonicalAgentInstanceId: canonical,
          agentInstanceAliases: aliases,
          updatedAt,
        };
      });
      await client.query(
        `WITH incoming AS (
           SELECT item AS record
             FROM jsonb_array_elements($1::jsonb) AS source(item)
         )
         INSERT INTO anysentry_agent_runtime_instances_v2 (
           canonical_instance_id, agent_scope_id, runtime_state, last_seen_at,
           ended_at, record, updated_at
         )
         SELECT
           record->>'canonicalAgentInstanceId',
           record->>'agentScopeId',
           record->>'runtimeState',
           (record->>'lastSeenAt')::bigint,
           NULLIF(record->>'endedAt', '')::bigint,
           record - 'updatedAt',
           (record->>'updatedAt')::bigint
         FROM incoming
         ON CONFLICT (canonical_instance_id) DO UPDATE SET
           agent_scope_id = EXCLUDED.agent_scope_id,
           runtime_state = EXCLUDED.runtime_state,
           last_seen_at = GREATEST(
             anysentry_agent_runtime_instances_v2.last_seen_at,
             EXCLUDED.last_seen_at
           ),
           ended_at = COALESCE(EXCLUDED.ended_at, anysentry_agent_runtime_instances_v2.ended_at),
           record = EXCLUDED.record,
           updated_at = EXCLUDED.updated_at
         WHERE EXCLUDED.updated_at >= anysentry_agent_runtime_instances_v2.updated_at`,
        [JSON.stringify(normalizedRecords)],
      );
      const aliasRows = normalizedRecords.flatMap((record) =>
        record.agentInstanceAliases.map((alias) => ({
          alias,
          canonical: record.canonicalAgentInstanceId,
          firstSeenAt: record.discoveredAt,
          lastSeenAt: record.lastSeenAt,
        })));
      await client.query(
        `WITH incoming AS (
           SELECT item AS record
             FROM jsonb_array_elements($1::jsonb) AS source(item)
         )
         INSERT INTO anysentry_agent_runtime_instance_aliases_v1 (
           alias_instance_id, canonical_instance_id, first_seen_at, last_seen_at
         )
         SELECT
           record->>'alias',
           record->>'canonical',
           (record->>'firstSeenAt')::bigint,
           (record->>'lastSeenAt')::bigint
         FROM incoming
         ON CONFLICT (alias_instance_id) DO UPDATE SET
           canonical_instance_id = EXCLUDED.canonical_instance_id,
           first_seen_at = LEAST(
             anysentry_agent_runtime_instance_aliases_v1.first_seen_at,
             EXCLUDED.first_seen_at
           ),
           last_seen_at = GREATEST(
             anysentry_agent_runtime_instance_aliases_v1.last_seen_at,
             EXCLUDED.last_seen_at
           )`,
        [JSON.stringify(aliasRows)],
      );
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client?.query('ROLLBACK').catch(() => undefined);
      this.markUnavailable('save Agent Runtime instances', error);
      return false;
    } finally {
      client?.release();
    }
  }

  async loadAgentConversationBindings(
    interactionIds: string[],
  ): Promise<AgentConversationBindingRecord[]> {
    if (interactionIds.length === 0 || !(await this.initialize()) || !this.pool) return [];
    try {
      const result = await this.pool.query<{ record: AgentConversationBindingRecord | string }>(
        `SELECT record
           FROM anysentry_agent_conversation_bindings_v1
          WHERE interaction_id = ANY($1::text[])
          LIMIT $2`,
        [interactionIds.slice(0, AGENT_CONVERSATION_BINDING_LIMIT), AGENT_CONVERSATION_BINDING_LIMIT],
      );
      return result.rows
        .map(({ record }) => this.parseRecord<AgentConversationBindingRecord>(record))
        .filter((record): record is AgentConversationBindingRecord => Boolean(
          record?.interactionId && record.conversationId && record.segmentId,
        ));
    } catch (error) {
      this.markUnavailable('load Agent Conversation bindings', error);
      return [];
    }
  }

  async loadAgentConversationThreads(
    logicalScopeKeys: string[],
  ): Promise<AgentConversationThreadRecord[]> {
    if (logicalScopeKeys.length === 0 || !(await this.initialize()) || !this.pool) return [];
    try {
      const result = await this.pool.query<{ record: AgentConversationThreadRecord | string }>(
        `SELECT record
           FROM anysentry_agent_conversation_threads_v1
          WHERE logical_scope_key = ANY($1::text[])
          ORDER BY last_activity_at DESC
          LIMIT $2`,
        [[...new Set(logicalScopeKeys)], AGENT_CONVERSATION_BINDING_LIMIT],
      );
      return result.rows
        .map(({ record }) => this.parseRecord<AgentConversationThreadRecord>(record))
        .filter((record): record is AgentConversationThreadRecord => Boolean(
          record?.conversationId && record.logicalScopeKey,
        ));
    } catch (error) {
      this.markUnavailable('load Agent Conversation threads', error);
      return [];
    }
  }

  async loadAgentConversationThreadsByIds(
    conversationIds: string[],
  ): Promise<AgentConversationThreadRecord[]> {
    if (conversationIds.length === 0 || !(await this.initialize()) || !this.pool) return [];
    try {
      const result = await this.pool.query<{ record: AgentConversationThreadRecord | string }>(
        `SELECT record
           FROM anysentry_agent_conversation_threads_v1
          WHERE conversation_id = ANY($1::text[])
          LIMIT $2`,
        [[...new Set(conversationIds)], AGENT_CONVERSATION_BINDING_LIMIT],
      );
      return result.rows
        .map(({ record }) => this.parseRecord<AgentConversationThreadRecord>(record))
        .filter((record): record is AgentConversationThreadRecord => Boolean(
          record?.conversationId && record.logicalScopeKey,
        ));
    } catch (error) {
      this.markUnavailable('load Agent Conversation threads by id', error);
      return [];
    }
  }

  async loadAgentConversationSegments(
    conversationIds: string[],
  ): Promise<ConversationInstanceSegment[]> {
    if (conversationIds.length === 0 || !(await this.initialize()) || !this.pool) return [];
    try {
      const result = await this.pool.query<{ record: ConversationInstanceSegment | string }>(
        `SELECT record
           FROM anysentry_agent_conversation_segments_v1
          WHERE conversation_id = ANY($1::text[])
          ORDER BY conversation_id, ordinal
          LIMIT $2`,
        [[...new Set(conversationIds)], AGENT_CONVERSATION_BINDING_LIMIT],
      );
      return result.rows
        .map(({ record }) => this.parseRecord<ConversationInstanceSegment>(record))
        .filter((record): record is ConversationInstanceSegment => Boolean(
          record?.segmentId && record.conversationId && record.agentInstanceId,
        ));
    } catch (error) {
      this.markUnavailable('load Agent Conversation segments', error);
      return [];
    }
  }

  async loadAgentConversationMembershipsV2(
    interactionIds: string[],
  ): Promise<ConversationMembershipV2[]> {
    if (interactionIds.length === 0 || !(await this.initialize()) || !this.pool) return [];
    try {
      const result = await this.pool.query<{ record: ConversationMembershipV2 | string }>(
        `SELECT DISTINCT ON (interaction_id) record
           FROM anysentry_agent_conversation_memberships_v2
          WHERE interaction_id = ANY($1::text[])
          ORDER BY interaction_id, resolution_revision DESC
          LIMIT $2`,
        [interactionIds.slice(0, AGENT_CONVERSATION_BINDING_LIMIT), AGENT_CONVERSATION_BINDING_LIMIT],
      );
      return result.rows
        .map(({ record }) => this.parseRecord<ConversationMembershipV2>(record))
        .filter((record): record is ConversationMembershipV2 => Boolean(
          record?.interactionId && record.membershipId && record.resolutionRevision,
        ));
    } catch (error) {
      this.markUnavailable('load Agent Conversation V2 memberships', error);
      return [];
    }
  }

  /**
   * Load the current durable Interaction membership of one canonical Conversation Thread.
   *
   * A Thread can absorb an older inferred Thread after stronger Provider/continuity evidence is
   * observed. The recursive alias set therefore remains part of the read model until the next
   * resolver pass rewrites every old membership. V2 rows are considered only when no newer
   * resolution exists for the same Interaction; otherwise an obsolete revision could resurrect a
   * record that was deliberately moved to another Thread or folded into technical activity.
   */
  async loadAgentConversationInteractionIds(
    conversationId: string,
    limit = 5_000,
  ): Promise<AgentConversationInteractionMembershipSlice | null> {
    const normalizedConversationId = conversationId.trim();
    if (!normalizedConversationId || !(await this.initialize()) || !this.pool) return null;
    const boundedLimit = Math.max(1, Math.min(10_000, Math.trunc(limit)));
    try {
      // Canonical Session IDs are a separate namespace from compatibility Thread IDs. Read
      // their members directly, including after restart when no route alias is in memory.
      if (/^sess_[a-f0-9]{24}$/u.test(normalizedConversationId)) {
        const result = await this.pool.query<{ interaction_id: string }>(
          `SELECT COALESCE(NULLIF(candidate.interaction_id, ''), candidate.record->>'interactionId') AS interaction_id
             FROM anysentry_session_memberships_v1 AS candidate
            WHERE candidate.session_id = $1
              AND COALESCE(NULLIF(candidate.interaction_id, ''), NULLIF(candidate.record->>'interactionId', '')) IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM anysentry_session_memberships_v1 AS newer
                 WHERE newer.session_id = candidate.session_id
                   AND COALESCE(NULLIF(newer.interaction_id, ''), newer.record->>'interactionId')
                     = COALESCE(NULLIF(candidate.interaction_id, ''), candidate.record->>'interactionId')
                   AND newer.resolution_revision > candidate.resolution_revision
              )
            GROUP BY COALESCE(NULLIF(candidate.interaction_id, ''), candidate.record->>'interactionId')
            ORDER BY MIN(candidate.valid_from), interaction_id
            LIMIT $2`,
          [normalizedConversationId, boundedLimit + 1],
        );
        const interactionIds = result.rows.map((row) => row.interaction_id);
        return { interactionIds: interactionIds.slice(0, boundedLimit), truncated: interactionIds.length > boundedLimit };
      }
      const result = await this.pool.query<{ interaction_id: string }>(
        `WITH RECURSIVE thread_ids(conversation_id) AS (
           SELECT $1::text
           UNION
           SELECT alias.alias_conversation_id
             FROM anysentry_agent_conversation_route_aliases_v1 AS alias
             JOIN thread_ids AS target
               ON alias.target_type = 'conversation'
              AND alias.target_id = target.conversation_id
         ),
         current_v2 AS (
           SELECT candidate.interaction_id,
                  candidate.decided_at
             FROM anysentry_agent_conversation_memberships_v2 AS candidate
             JOIN thread_ids AS thread
               ON thread.conversation_id = candidate.canonical_conversation_id
            WHERE NOT EXISTS (
              SELECT 1
                FROM anysentry_agent_conversation_memberships_v2 AS newer
               WHERE newer.interaction_id = candidate.interaction_id
                 AND newer.resolution_revision > candidate.resolution_revision
            )
         ),
         legacy_v1 AS (
           SELECT binding.interaction_id,
                  binding.updated_at AS decided_at
             FROM anysentry_agent_conversation_bindings_v1 AS binding
             JOIN thread_ids AS thread
               ON thread.conversation_id = binding.conversation_id
            WHERE NOT EXISTS (
              SELECT 1
                FROM anysentry_agent_conversation_memberships_v2 AS current
               WHERE current.interaction_id = binding.interaction_id
            )
         ),
         members AS (
           SELECT interaction_id, decided_at FROM current_v2
           UNION ALL
           SELECT interaction_id, decided_at FROM legacy_v1
         )
         SELECT interaction_id
           FROM members
          GROUP BY interaction_id
          ORDER BY MAX(decided_at), interaction_id
          LIMIT $2`,
        [normalizedConversationId, boundedLimit + 1],
      );
      const interactionIds = result.rows
        .map((row) => row.interaction_id?.trim())
        .filter((value): value is string => Boolean(value));
      return {
        interactionIds: interactionIds.slice(0, boundedLimit),
        truncated: interactionIds.length > boundedLimit,
      };
    } catch (error) {
      this.markUnavailable('load Agent Conversation Interaction membership', error);
      return null;
    }
  }

  async loadAgentConversationMembershipsByAnchors(
    anchors: AgentConversationAnchor[],
    logicalScopeKeys: readonly string[] = [],
  ): Promise<AgentConversationAnchorMembershipMatch[]> {
    if (anchors.length === 0 || !(await this.initialize()) || !this.pool) return [];
    const lookup = [...new Map(anchors
      .filter((anchor) => anchor.namespace && anchor.valueHash)
      .map((anchor) => [`${anchor.namespace}\u0000${anchor.valueHash}`, {
        namespace: anchor.namespace,
        valueHash: anchor.valueHash,
      }])).values()].slice(0, 4_096);
    if (lookup.length === 0) return [];
    // Scope filtering is deliberately optional for legacy/synthetic CLI anchors.  Callers that
    // have a concrete definition scope pass it here so the database cannot fan a shared provider
    // anchor out across unrelated LogicalAgent definitions before the in-memory fence runs.
    const scopedKeys = [...new Set(logicalScopeKeys
      .map((value) => value.trim())
      .filter(Boolean))].slice(0, 4_096);
    try {
      const result = await this.pool.query<{
        anchor_record: (AgentConversationAnchorPersistence & AgentConversationAnchor) | string;
        membership_record: ConversationMembershipV2 | string;
      }>(
        `WITH incoming AS (
           SELECT DISTINCT item->>'namespace' AS namespace,
                           item->>'valueHash' AS value_hash
             FROM jsonb_array_elements($1::jsonb) AS source(item)
         )
         SELECT anchor.record AS anchor_record,
                membership.record AS membership_record
           FROM incoming
         JOIN anysentry_agent_conversation_anchors_v1 AS anchor
             ON anchor.anchor_namespace = incoming.namespace
            AND anchor.value_hash = incoming.value_hash
            AND (
              cardinality($3::text[]) = 0
              OR anchor.logical_scope_key = ANY($3::text[])
            )
           JOIN LATERAL (
             SELECT candidate.record
               FROM anysentry_agent_conversation_memberships_v2 AS candidate
              WHERE candidate.interaction_id = anchor.interaction_id
                AND candidate.canonical_conversation_id IS NOT NULL
                AND (
                  candidate.logical_scope_key = anchor.logical_scope_key
                  OR split_part(anchor.logical_scope_key, '|deployment:', 1)
                     = candidate.logical_scope_key
                )
              ORDER BY candidate.resolution_revision DESC
              LIMIT 1
           ) AS membership ON TRUE
          ORDER BY anchor.observed_at DESC
          LIMIT $2`,
        [JSON.stringify(lookup), AGENT_CONVERSATION_BINDING_LIMIT, scopedKeys],
      );
      return result.rows.flatMap((row) => {
        const stored = this.parseRecord<AgentConversationAnchorPersistence & AgentConversationAnchor>(
          row.anchor_record,
        );
        const membership = this.parseRecord<ConversationMembershipV2>(row.membership_record);
        if (
          !stored?.interactionId
          || !stored.logicalScopeKey
          || !stored.kind
          || !stored.namespace
          || !stored.valueHash
          || !membership?.canonicalConversationId
        ) {
          return [];
        }
        return [{
          anchor: {
            interactionId: stored.interactionId,
            logicalScopeKey: stored.logicalScopeKey,
            observedAt: Number(stored.observedAt),
            anchor: {
              kind: stored.kind,
              namespace: stored.namespace,
              valueHash: stored.valueHash,
              strength: stored.strength,
              sourcePath: stored.sourcePath,
            },
          },
          membership,
        }];
      });
    } catch (error) {
      this.markUnavailable('load Agent Conversation memberships by Anchor', error);
      return [];
    }
  }

  async loadAgentConversationRouteAliases(
    conversationIds: string[],
  ): Promise<ConversationRouteAliasV1[]> {
    if (conversationIds.length === 0 || !(await this.initialize()) || !this.pool) return [];
    try {
      const result = await this.pool.query<{ record: ConversationRouteAliasV1 | string }>(
        `SELECT record
           FROM anysentry_agent_conversation_route_aliases_v1
          WHERE alias_conversation_id = ANY($1::text[])
          LIMIT $2`,
        [[...new Set(conversationIds)], AGENT_CONVERSATION_BINDING_LIMIT],
      );
      return result.rows
        .map(({ record }) => this.parseRecord<ConversationRouteAliasV1>(record))
        .filter((record): record is ConversationRouteAliasV1 => Boolean(
          record?.aliasConversationId && record.targetType && record.targetId,
        ));
    } catch (error) {
      this.markUnavailable('load Agent Conversation route aliases', error);
      return [];
    }
  }

  async loadAgentRunTechnicalActivities(
    agentInstanceIds: string[],
  ): Promise<TechnicalActivityProjection[]> {
    if (agentInstanceIds.length === 0 || !(await this.initialize()) || !this.pool) return [];
    try {
      const result = await this.pool.query<{ record: TechnicalActivityProjection | string }>(
        `SELECT record
           FROM anysentry_agent_run_technical_activities_v1
          WHERE agent_instance_id = ANY($1::text[])
          ORDER BY started_at DESC
          LIMIT $2`,
        [[...new Set(agentInstanceIds)], AGENT_CONVERSATION_BINDING_LIMIT],
      );
      return result.rows
        .map(({ record }) => this.parseRecord<TechnicalActivityProjection>(record))
        .filter((record): record is TechnicalActivityProjection => Boolean(
          record?.technicalActivityId && record.interactionIds?.length,
        ));
    } catch (error) {
      this.markUnavailable('load Agent Run technical activities', error);
      return [];
    }
  }

  /**
   * Append immutable canonical raw observations.  The JSON record is retained as a metadata-first
   * envelope (the caller strips any body before this method); retries with the same
   * observation/revision are idempotent, while a conflicting idempotency key is rejected by the
   * unique constraint and surfaced as `false` to the hot-store caller.
   */
  async saveRawObservations(observations: readonly RawObservation[]): Promise<boolean> {
    if (observations.length === 0) return true;
    return new Promise<boolean>((resolve) => {
      this.rawBatchQueue.push({ rows: observations, resolve });
      if (this.rawBatchQueue.reduce((sum, item) => sum + item.rows.length, 0) >= this.rawBatchMaxRows) {
        void this.flushRawBatchQueue();
      } else if (!this.rawBatchTimer) {
        this.rawBatchTimer = setTimeout(() => {
          this.rawBatchTimer = undefined;
          void this.flushRawBatchQueue();
        }, this.rawBatchWindowMs);
        this.rawBatchTimer.unref?.();
      }
    });
  }

  private async flushRawBatchQueue(): Promise<void> {
    if (this.rawBatchFlushInFlight || this.rawBatchQueue.length === 0) return;
    const entries: Array<{ rows: readonly RawObservation[]; resolve: (value: boolean) => void }> = [];
    let rows = 0;
    let bytes = 2;
    while (this.rawBatchQueue.length > 0) {
      const next = this.rawBatchQueue[0];
      const nextBytes = Buffer.byteLength(JSON.stringify(next.rows));
      if (entries.length > 0 && (rows + next.rows.length > this.rawBatchMaxRows
        || bytes + nextBytes > this.rawBatchMaxBytes)) break;
      this.rawBatchQueue.shift();
      entries.push(next);
      rows += next.rows.length;
      bytes += nextBytes;
    }
    const combined = entries.flatMap((entry) => entry.rows);
    this.rawBatchFlushInFlight = this.saveRawObservationsNow(combined)
      .then((result) => { for (const entry of entries) entry.resolve(result); })
      .catch(() => { for (const entry of entries) entry.resolve(false); })
      .finally(() => {
        this.rawBatchFlushInFlight = undefined;
        if (this.rawBatchQueue.length > 0) void this.flushRawBatchQueue();
      });
    await this.rawBatchFlushInFlight;
  }

  private async saveRawObservationsNow(observations: readonly RawObservation[]): Promise<boolean> {
    if (observations.length === 0) return true;
    if (observations.length > RAW_OBSERVATION_LIMIT) return false;
    const bounded = observations.slice(0, RAW_OBSERVATION_LIMIT);
    if (batchHasConflictingRecords(
      bounded,
      (record) => `${record.observationId}\0${record.revision}`,
    )) return false;
    if (batchHasConflictingRecords(
      bounded,
      (record) => `${record.idempotencyKey}\0${record.revision}`,
    )) return false;
    const boundedJson = boundedJsonRows(bounded, RAW_OBSERVATION_LIMIT, CANONICAL_WRITE_MAX_BYTES);
    if (!boundedJson) return false;
    if (!(await this.initialize()) || !this.pool) return false;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // The unique keys serialize conflicting inserts at the index without a global advisory
      // lock. Insert first, then inspect the committed row for an idempotency payload conflict;
      // concurrent identical retries become no-ops while a conflicting retry rolls back this
      // transaction. This preserves the old conflict contract without serializing every batch.
      await client.query(
        `WITH incoming AS (
           SELECT item AS record
             FROM jsonb_array_elements($1::jsonb) AS source(item)
         )
         INSERT INTO anysentry_raw_observations_v1 (
           observation_id, revision, idempotency_key, event_at, received_at,
           source_type, source_id, collector_id, payload_sha256,
           original_bytes, captured_bytes, record
         )
         SELECT
           record->>'observationId',
           (record->>'revision')::bigint,
           record->>'idempotencyKey',
           (record->>'eventAtUnixNs')::numeric,
           (record->>'receivedAtUnixNs')::numeric,
           record->'source'->>'sourceType',
           NULLIF(record->'source'->>'sourceId', ''),
           NULLIF(record->'source'->>'collectorId', ''),
           record->'payload'->>'sha256',
           (record->'payload'->>'originalBytes')::bigint,
           (record->'payload'->>'capturedBytes')::bigint,
           record
         FROM incoming
         -- Both observation_id/revision and idempotency_key/revision are unique.
         -- Leave the conflict target unspecified so either idempotent key can
         -- turn a retry into a no-op; the query below still rejects payload
         -- mismatches instead of silently accepting a conflicting record.
         ON CONFLICT DO NOTHING`,
        [boundedJson],
      );
      const conflict = await client.query<{ conflict: boolean }>(
        `WITH incoming AS (
           SELECT item AS record
             FROM jsonb_array_elements($1::jsonb) AS source(item)
         )
         SELECT EXISTS (
           SELECT 1
             FROM anysentry_raw_observations_v1 existing
             JOIN incoming
               ON existing.revision = (incoming.record->>'revision')::bigint
              AND (existing.observation_id = incoming.record->>'observationId'
                OR existing.idempotency_key = incoming.record->>'idempotencyKey')
           WHERE existing.payload_sha256 <> incoming.record->'payload'->>'sha256'
              OR existing.record <> incoming.record
         ) AS conflict`,
        [boundedJson],
      );
      if (conflict.rows?.[0]?.conflict === true) {
        await client.query('ROLLBACK');
        return false;
      }
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      this.markUnavailable('save canonical raw observations', error);
      return false;
    } finally {
      client.release();
    }
  }

  async latestRawObservationWatermarks(
    sources: readonly { sourceId: string; collectorId: string }[] = [],
  ): Promise<Array<{ sourceId: string; collectorId: string; eventAtMs: number }>> {
    if (!(await this.initialize()) || !this.pool) return [];
    const pairs = [...sources]
      .map((item) => ({
        sourceId: String(item.sourceId ?? '').trim(),
        collectorId: String(item.collectorId ?? '').trim(),
      }))
      .filter((item) => item.sourceId && item.collectorId)
      .slice(0, 256);
    if (!pairs.length) return [];
    try {
      const result = await this.pool.query<{
        source_id: string;
        collector_id: string;
        event_at: string;
      }>(
        `SELECT source_id, collector_id, MAX(event_at) AS event_at
           FROM anysentry_raw_observations_v1
          WHERE event_at >= $1::numeric
            AND (source_id, collector_id) IN (
              SELECT * FROM UNNEST($2::text[], $3::text[])
            )
          GROUP BY source_id, collector_id`,
        [
          recentUnixNsFloor(),
          pairs.map((item) => item.sourceId),
          pairs.map((item) => item.collectorId),
        ],
      );
      return result.rows.flatMap((row) => {
        let eventAtNs = 0n;
        try {
          eventAtNs = BigInt(String(row.event_at ?? '0'));
        } catch {
          return [];
        }
        if (eventAtNs <= 0n) return [];
        return [{
          sourceId: String(row.source_id ?? ''),
          collectorId: String(row.collector_id ?? ''),
          eventAtMs: Number(eventAtNs / 1_000_000n),
        }];
      });
    } catch {
      return [];
    }
  }

  async loadRawObservations(
    input: { observationIds?: readonly string[]; revision?: number; limit?: number } = {},
  ): Promise<RawObservation[]> {
    if (!(await this.initialize()) || !this.pool) return [];
    const limit = Math.max(1, Math.min(RAW_OBSERVATION_LIMIT, Math.trunc(input.limit ?? 1_000)));
    try {
      const ids = [...new Set((input.observationIds ?? [])
        .map((value) => String(value).trim())
        .filter(Boolean))].slice(0, RAW_OBSERVATION_LIMIT);
      const requestedRevision = input.revision !== undefined
        && Number.isSafeInteger(input.revision) && input.revision > 0
        ? input.revision : undefined;
      const result = await this.pool.query<{ record: RawObservation | string }>(
        ids.length && requestedRevision !== undefined
          ? `SELECT record
               FROM anysentry_raw_observations_v1
              WHERE observation_id = ANY($1::text[]) AND revision = $2
              ORDER BY observation_id
              LIMIT $3`
          : ids.length
            ? `SELECT record
                 FROM anysentry_raw_observations_v1
                WHERE observation_id = ANY($1::text[])
                ORDER BY observation_id, revision DESC
                LIMIT $2`
            : requestedRevision !== undefined
              ? `SELECT record
                   FROM anysentry_raw_observations_v1
                  WHERE revision = $1 AND event_at >= $2::numeric
                  ORDER BY event_at DESC, observation_id
                  LIMIT $3`
              : `SELECT record
                   FROM anysentry_raw_observations_v1
                  WHERE event_at >= $1::numeric
                  ORDER BY event_at DESC, observation_id, revision DESC
                  LIMIT $2`,
        ids.length && requestedRevision !== undefined
          ? [ids, requestedRevision, limit]
          : ids.length ? [ids, limit]
            : requestedRevision !== undefined
              ? [requestedRevision, recentUnixNsFloor(), limit]
              : [recentUnixNsFloor(), limit],
      );
      return result.rows
        .flatMap(({ record }) => {
          const parsed = this.parseRecord<RawObservation>(record);
          const safe = validatedRawRecord(parsed);
          return safe ? [safe] : [];
        });
    } catch (error) {
      this.markUnavailable('load canonical raw observations', error);
      return [];
    }
  }

  /**
   * Append machine-side KernelFact records without ever updating an existing fact.
   *
   * Kernel facts are deliberately stored in their own append-only table.  A fact ID is a
   * deterministic identity for one observed event, so retries use `ON CONFLICT DO NOTHING` and
   * cannot rewrite the original JSONB payload.  The in-memory KernelFactStore remains the hot
   * fallback when PostgreSQL is not configured or temporarily unavailable.
   */
  async saveKernelFacts(facts: readonly KernelFact[]): Promise<boolean> {
    if (facts.length === 0) return true;
    if (facts.length > KERNEL_FACT_LIMIT) return false;
    const bounded = facts.slice(0, KERNEL_FACT_LIMIT);
    if (batchHasConflictingRecords(bounded, (record) => record.factId)) return false;
    const boundedJson = boundedJsonRows(bounded, KERNEL_FACT_LIMIT, CANONICAL_WRITE_MAX_BYTES);
    if (!boundedJson) return false;
    if (!(await this.initialize()) || !this.pool) return false;
    try {
      const conflict = await this.pool.query<{ conflict: boolean }>(
        `WITH incoming AS (
           SELECT item AS record
             FROM jsonb_array_elements($1::jsonb) AS source(item)
         )
         SELECT EXISTS (
           SELECT 1
             FROM anysentry_kernel_facts_v1 existing
             JOIN incoming ON existing.fact_id = incoming.record->>'factId'
            WHERE existing.record <> incoming.record
         ) AS conflict`,
        [boundedJson],
      );
      if (conflict.rows?.[0]?.conflict === true) return false;
      await this.pool.query(
        `WITH incoming AS (
           SELECT item AS record
             FROM jsonb_array_elements($1::jsonb) AS source(item)
         )
         INSERT INTO anysentry_kernel_facts_v1 (
           fact_id, kind, authority, observed_at,
           process_generation_key, parent_process_generation_key,
           connection_id, payload_ref, event_id, scope, status, record
         )
         SELECT
           record->>'factId',
           record->>'kind',
           record->>'authority',
           (record->>'observedAtUnixNs')::numeric,
           NULLIF(record->>'processGenerationKey', ''),
           NULLIF(record->>'parentProcessGenerationKey', ''),
           NULLIF(record->>'connectionId', ''),
           NULLIF(record->>'payloadRef', ''),
           NULLIF(record->>'eventId', ''),
           NULLIF(record->>'scope', ''),
           record->>'status',
           record
         FROM incoming
         ON CONFLICT (fact_id) DO NOTHING`,
        [boundedJson],
      );
      return true;
    } catch (error) {
      this.markUnavailable('save canonical KernelFacts', error);
      return false;
    }
  }

  async loadKernelFacts(
    input: {
      factIds?: readonly string[];
      eventIds?: readonly string[];
      sourceRefs?: readonly string[];
      derivedFrom?: readonly string[];
      limit?: number;
    } = {},
  ): Promise<KernelFact[]> {
    if (!(await this.initialize()) || !this.pool) return [];
    const requestedLimit = Number(input.limit ?? 1_000);
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(KERNEL_FACT_LIMIT, Math.trunc(requestedLimit)))
      : 1_000;
    try {
      const boundedIds = (values: readonly string[] | undefined): string[] => [...new Set((values ?? [])
        .map((value) => String(value).trim())
        .filter((value) => value.length > 0 && value.length <= 512))]
        .slice(0, KERNEL_FACT_LIMIT);
      const ids = boundedIds(input.factIds);
      const eventIds = boundedIds(input.eventIds);
      const sourceRefs = boundedIds(input.sourceRefs);
      const derivedFrom = boundedIds(input.derivedFrom);
      const predicates: string[] = [];
      const params: unknown[] = [];
      if (ids.length > 0) {
        params.push(ids);
        predicates.push(`fact_id = ANY($${params.length}::text[])`);
      }
      if (eventIds.length > 0) {
        params.push(eventIds);
        predicates.push(`event_id = ANY($${params.length}::text[])`);
      }
      if (sourceRefs.length > 0) {
        params.push(sourceRefs);
        predicates.push(`(record->'sourceRefs') ?| $${params.length}::text[]`);
      }
      if (derivedFrom.length > 0) {
        params.push(derivedFrom);
        predicates.push(`(record->'derivedFrom') ?| $${params.length}::text[]`);
      }
      params.push(limit);
      const result = await this.pool.query<{ record: KernelFact | string }>(
        predicates.length
          ? `SELECT record
               FROM anysentry_kernel_facts_v1
              WHERE ${predicates.join(' OR ')}
              ORDER BY observed_at DESC, fact_id
              LIMIT $${params.length}`
          : `SELECT record
               FROM anysentry_kernel_facts_v1
              WHERE observed_at >= $1::numeric
              ORDER BY observed_at DESC, fact_id
              LIMIT $2`,
        predicates.length ? params : [recentUnixNsFloor(), limit],
      );
      return result.rows.flatMap(({ record }) => {
        const parsed = this.parseRecord<KernelFact>(record);
        const checked = validateKernelFact(parsed);
        return checked.ok ? [checked.value] : [];
      });
    } catch (error) {
      this.markUnavailable('load canonical KernelFacts', error);
      return [];
    }
  }

  async saveSemanticRecords(records: readonly SemanticRecord[]): Promise<boolean> {
    if (this.semanticBatchClosed) return false;
    if (records.length === 0) return true;
    if (records.length + this.semanticPendingRows > this.semanticPendingMaxRows) return false;
    let serialized: string;
    try { serialized = JSON.stringify(records); } catch { return false; }
    const bytes = Buffer.byteLength(serialized);
    if (bytes + this.semanticPendingBytes > this.semanticPendingMaxBytes) return false;
    // Snapshot accepted records: caller mutation must not alter a deferred durable write.
    const snapshot: SemanticRecord[] = JSON.parse(serialized);
    if (batchHasConflictingRecords(snapshot, row => `${row.semanticRecordId}\0${row.revision ?? 1}`)) return false;
    this.semanticPendingRows += snapshot.length;
    this.semanticPendingBytes += bytes;
    return new Promise<boolean>((resolve) => {
      this.semanticBatchQueue.push({ rows: snapshot, bytes, resolve });
      const queued = this.semanticBatchQueue.reduce((sum, item) => sum + item.rows.length, 0);
      if (queued >= this.semanticBatchMaxRows) void this.flushSemanticBatchQueue();
      else if (!this.semanticBatchTimer) {
        this.semanticBatchTimer = setTimeout(() => {
          this.semanticBatchTimer = undefined;
          void this.flushSemanticBatchQueue();
        }, this.semanticBatchWindowMs);
        this.semanticBatchTimer.unref?.();
      }
    });
  }

  private async flushSemanticBatchQueue(): Promise<void> {
    if (this.semanticBatchFlushInFlight) return this.semanticBatchFlushInFlight;
    if (this.semanticBatchQueue.length === 0) return;
    const entries: typeof this.semanticBatchQueue = [];
    let rows = 0;
    const fingerprints = new Map<string, string>();
    while (this.semanticBatchQueue.length > 0) {
      const next = this.semanticBatchQueue[0];
      if (entries.length > 0 && rows + next.rows.length > this.semanticBatchMaxRows) break;
      const incoming = next.rows.map(row => [
        `${row.semanticRecordId}\0${row.revision ?? 1}`, stableRecordJson(row),
      ] as const);
      // Conflicting independent callers must reach the existing conflict check separately.
      if (incoming.some(([key, value]) => fingerprints.has(key) && fingerprints.get(key) !== value)) break;
      for (const [key, value] of incoming) fingerprints.set(key, value);
      this.semanticBatchQueue.shift();
      entries.push(next);
      rows += next.rows.length;
    }
    const combined = entries.flatMap((entry) => entry.rows);
    this.semanticBatchFlushInFlight = Promise.resolve().then(() => this.saveSemanticRecordsNow(combined))
      .catch(() => false)
      .then((result) => {
        for (const entry of entries) {
          this.semanticPendingRows -= entry.rows.length;
          this.semanticPendingBytes -= entry.bytes;
          entry.resolve(result);
        }
      })
      .finally(() => {
        this.semanticBatchFlushInFlight = undefined;
        if (this.semanticBatchQueue.length > 0) void this.flushSemanticBatchQueue();
      });
    await this.semanticBatchFlushInFlight;
  }

  private async saveSemanticRecordsNow(records: readonly SemanticRecord[]): Promise<boolean> {
    if (records.length === 0) return true;
    if (records.length > SEMANTIC_RECORD_LIMIT) return false;
    const bounded = records.slice(0, SEMANTIC_RECORD_LIMIT);
    if (batchHasConflictingRecords(
      bounded,
      (record) => `${record.semanticRecordId}\0${record.revision ?? 1}`,
    )) return false;
    const boundedJson = boundedJsonRows(bounded, SEMANTIC_RECORD_LIMIT, CANONICAL_WRITE_MAX_BYTES);
    if (!boundedJson) return false;
    if (!(await this.initialize()) || !this.pool) return false;
    try {
      const conflict = await this.pool.query<{ conflict: boolean }>(
        `WITH incoming AS (
           SELECT item AS record
             FROM jsonb_array_elements($1::jsonb) AS source(item)
         )
         SELECT EXISTS (
           SELECT 1
             FROM anysentry_semantic_records_v1 existing
             JOIN incoming
               ON existing.semantic_record_id = incoming.record->>'semanticRecordId'
              AND existing.revision = COALESCE((incoming.record->>'revision')::bigint, 1)
            WHERE existing.record <> incoming.record
         ) AS conflict`,
        [boundedJson],
      );
      if (conflict.rows?.[0]?.conflict === true) return false;
      await this.pool.query(
        `WITH incoming AS (
           SELECT item AS record
             FROM jsonb_array_elements($1::jsonb) AS source(item)
         )
         INSERT INTO anysentry_semantic_records_v1 (
           semantic_record_id, revision, kind, authority, observed_at,
           logical_agent_id, agent_instance_id, session_id, turn_id, run_id,
           tool_call_id, record
         )
         SELECT
           record->>'semanticRecordId',
           COALESCE((record->>'revision')::bigint, 1),
           record->>'kind',
           record->>'authority',
           (record->>'observedAtUnixNs')::numeric,
           NULLIF(record->>'logicalAgentId', ''),
           NULLIF(record->>'agentInstanceId', ''),
           NULLIF(record->>'sessionId', ''),
           NULLIF(record->>'turnId', ''),
           NULLIF(record->>'runId', ''),
           NULLIF(record->>'toolCallId', ''),
           record
         FROM incoming
         ON CONFLICT (semantic_record_id, revision) DO NOTHING`,
        [boundedJson],
      );
      return true;
    } catch (error) {
      this.markUnavailable('save canonical semantic records', error);
      return false;
    }
  }

  async loadSemanticRecords(input: { semanticRecordIds?: readonly string[]; revision?: number; limit?: number } = {}): Promise<SemanticRecord[]> {
    if (!(await this.initialize()) || !this.pool) return [];
    const requested = Number(input.limit ?? 1_000);
    const limit = Number.isFinite(requested)
      ? Math.max(1, Math.min(SEMANTIC_RECORD_LIMIT, Math.trunc(requested)))
      : 1_000;
    try {
      const ids = [...new Set((input.semanticRecordIds ?? []).map((value) => String(value).trim()).filter(Boolean))].slice(0, SEMANTIC_RECORD_LIMIT);
      const requestedRevision = input.revision !== undefined
        && Number.isSafeInteger(input.revision) && input.revision > 0
        ? input.revision : undefined;
      const result = await this.pool.query<{ record: SemanticRecord | string }>(
        ids.length && requestedRevision !== undefined
          ? `SELECT record
               FROM anysentry_semantic_records_v1
              WHERE semantic_record_id = ANY($1::text[]) AND revision = $2
              ORDER BY semantic_record_id
              LIMIT $3`
          : ids.length
            ? `SELECT record
                 FROM anysentry_semantic_records_v1
                WHERE semantic_record_id = ANY($1::text[])
                ORDER BY semantic_record_id, revision DESC
                LIMIT $2`
            : requestedRevision !== undefined
              ? `SELECT record
                   FROM anysentry_semantic_records_v1
                  WHERE revision = $1 AND observed_at >= $2::numeric
                  ORDER BY observed_at DESC, semantic_record_id
                  LIMIT $3`
              : `SELECT record
                   FROM anysentry_semantic_records_v1
                  WHERE observed_at >= $1::numeric
                  ORDER BY observed_at DESC, semantic_record_id, revision DESC
                  LIMIT $2`,
        ids.length && requestedRevision !== undefined
          ? [ids, requestedRevision, limit]
          : ids.length ? [ids, limit]
            : requestedRevision !== undefined
              ? [requestedRevision, recentUnixNsFloor(), limit]
              : [recentUnixNsFloor(), limit],
      );
      return result.rows
        .flatMap(({ record }) => {
          const parsed = this.parseRecord<SemanticRecord>(record);
          const checked = validateSemanticRecord(parsed);
          return checked.ok ? [checked.value] : [];
        });
    } catch (error) {
      this.markUnavailable('load canonical semantic records', error);
      return [];
    }
  }

  private enqueueProjectionBatch<T>(
    state: ProjectionBatchState<T>, rows: readonly T[], maxRows: number,
    keyOf: (row: T) => string,
    flushRows: (rows: readonly T[]) => Promise<boolean>,
  ): Promise<boolean> {
    if (state.closed || rows.length === 0) return Promise.resolve(state.closed ? false : true);
    if (rows.length + state.pendingRows > this.projectionPendingMaxRows) return Promise.resolve(false);
    let serialized: string;
    try { serialized = JSON.stringify(rows); } catch { return Promise.resolve(false); }
    const bytes = Buffer.byteLength(serialized);
    if (bytes + state.pendingBytes > this.projectionPendingMaxBytes) return Promise.resolve(false);
    const snapshot: T[] = JSON.parse(serialized);
    if (batchHasConflictingRecords(snapshot, keyOf)) return Promise.resolve(false);
    state.pendingRows += snapshot.length;
    state.pendingBytes += bytes;
    return new Promise<boolean>((resolve) => {
      state.queue.push({ rows: snapshot, bytes, resolve });
      if (state.pendingRows >= maxRows) void this.flushProjectionBatch(state, maxRows, flushRows, keyOf);
      else if (!state.timer) {
        state.timer = setTimeout(() => {
          state.timer = undefined;
          void this.flushProjectionBatch(state, maxRows, flushRows, keyOf);
        }, this.projectionBatchWindowMs);
        state.timer.unref?.();
      }
    });
  }

  private async flushProjectionBatch<T>(
    state: ProjectionBatchState<T>, maxRows: number,
    flushRows: (rows: readonly T[]) => Promise<boolean>,
    keyOf: (row: T) => string,
  ): Promise<void> {
    if (state.inFlight) return state.inFlight;
    if (state.queue.length === 0) return;
    const entries: Array<ProjectionBatchEntry<T>> = [];
    const fingerprints = new Map<string, string>();
    let rows = 0;
    while (state.queue.length > 0) {
      const next = state.queue[0];
      if (entries.length > 0 && rows + next.rows.length > maxRows) break;
      const incoming = next.rows.map(row => [keyOf(row), stableRecordJson(row)] as const);
      if (incoming.some(([key, value]) => fingerprints.has(key) && fingerprints.get(key) !== value)) break;
      for (const [key, value] of incoming) fingerprints.set(key, value);
      state.queue.shift();
      entries.push(next);
      rows += next.rows.length;
    }
    const combined = entries.flatMap(entry => entry.rows);
    state.inFlight = Promise.resolve().then(() => flushRows(combined)).catch(() => false)
      .then(result => {
        for (const entry of entries) {
          state.pendingRows -= entry.rows.length;
          state.pendingBytes -= entry.bytes;
          entry.resolve(result);
        }
      }).finally(() => {
        state.inFlight = undefined;
        if (state.queue.length > 0) void this.flushProjectionBatch(state, maxRows, flushRows, keyOf);
      });
    await state.inFlight;
  }

  async saveSessionMemberships(memberships: readonly SessionMembership[]): Promise<boolean> {
    return this.enqueueProjectionBatch(
      this.sessionBatch, memberships, this.sessionBatchMaxRows,
      row => `${row.membershipId}\0${row.resolutionRevision}`,
      rows => this.saveSessionMembershipsNow(rows),
    );
  }

  private async saveSessionMembershipsNow(memberships: readonly SessionMembership[]): Promise<boolean> {
    if (memberships.length === 0) return true;
    if (memberships.length > SESSION_MEMBERSHIP_LIMIT) return false;
    const bounded = memberships.slice(0, SESSION_MEMBERSHIP_LIMIT);
    if (batchHasConflictingRecords(
      bounded,
      (record) => `${record.membershipId}\0${record.resolutionRevision}`,
    )) return false;
    const boundedJson = boundedJsonRows(bounded, SESSION_MEMBERSHIP_LIMIT, CANONICAL_WRITE_MAX_BYTES);
    if (!boundedJson) return false;
    if (!(await this.initialize()) || !this.pool) return false;
    try {
      const conflict = await this.pool.query<{ conflict: boolean }>(
        `WITH incoming AS (
           SELECT item AS record
             FROM jsonb_array_elements($1::jsonb) AS source(item)
         )
         SELECT EXISTS (
           SELECT 1
             FROM anysentry_session_memberships_v1 existing
             JOIN incoming
               ON existing.membership_id = incoming.record->>'membershipId'
              AND existing.resolution_revision = (incoming.record->>'resolutionRevision')::bigint
            WHERE existing.record <> incoming.record
         ) AS conflict`,
        [boundedJson],
      );
      if (conflict.rows?.[0]?.conflict === true) return false;
      await this.pool.query(
        `WITH incoming AS (
           SELECT item AS record
             FROM jsonb_array_elements($1::jsonb) AS source(item)
         )
         INSERT INTO anysentry_session_memberships_v1 (
           membership_id, resolution_revision, session_id, session_key,
           provider_session_id_hash, role, confidence, valid_from, record, interaction_id
         )
         SELECT
           record->>'membershipId',
           (record->>'resolutionRevision')::bigint,
           record->>'sessionId',
           NULLIF(record->>'sessionKey', ''),
           NULLIF(record->>'providerSessionIdHash', ''),
           record->>'role',
           record->>'confidence',
           (record->>'validFromUnixNs')::numeric,
           record,
           NULLIF(record->>'interactionId', '')
         FROM incoming
         ON CONFLICT (membership_id, resolution_revision) DO NOTHING`,
        [boundedJson],
      );
      return true;
    } catch (error) {
      this.markUnavailable('save canonical SessionMemberships', error);
      return false;
    }
  }

  async loadSessionMemberships(input: { membershipIds?: readonly string[]; sessionIds?: readonly string[]; interactionIds?: readonly string[]; resolutionRevision?: number; limit?: number; strictRead?: boolean } = {}): Promise<SessionMembership[]> {
    const strictRead = input.strictRead === true;
    if (!(await this.initialize()) || !this.pool) {
      if (strictRead) throw new Error('canonical SessionMembership store is unavailable');
      return [];
    }
    const requested = Number(input.limit ?? 1_000);
    const limit = Number.isFinite(requested)
      ? Math.max(1, Math.min(SESSION_MEMBERSHIP_LIMIT, Math.trunc(requested))) : 1_000;
    try {
      const ids = [...new Set((input.membershipIds ?? []).map((value) => String(value).trim()).filter(Boolean))].slice(0, SESSION_MEMBERSHIP_LIMIT);
      const sessionIds = [...new Set((input.sessionIds ?? []).map((value) => String(value).trim()).filter(Boolean))].slice(0, SESSION_MEMBERSHIP_LIMIT);
      const interactionIds = [...new Set((input.interactionIds ?? []).map((value) => String(value).trim()).filter(Boolean))].slice(0, SESSION_MEMBERSHIP_LIMIT);
      const requestedRevision = input.resolutionRevision !== undefined
        && Number.isSafeInteger(input.resolutionRevision) && input.resolutionRevision > 0
        ? input.resolutionRevision : undefined;
      const result = await this.pool.query<{ record: SessionMembership | string }>(
        sessionIds.length && requestedRevision !== undefined
          ? `SELECT record
               FROM anysentry_session_memberships_v1
              WHERE session_id = ANY($1::text[]) AND resolution_revision = $2
              ORDER BY valid_from DESC, membership_id
              LIMIT $3`
          : sessionIds.length
            ? `SELECT record
                 FROM anysentry_session_memberships_v1
                WHERE session_id = ANY($1::text[])
                ORDER BY valid_from DESC, membership_id, resolution_revision DESC
                LIMIT $2`
            : interactionIds.length && requestedRevision !== undefined
          ? `SELECT record
               FROM anysentry_session_memberships_v1
              WHERE COALESCE(NULLIF(interaction_id, ''), record->>'interactionId') = ANY($1::text[]) AND resolution_revision = $2
              ORDER BY valid_from DESC, membership_id
              LIMIT $3`
          : interactionIds.length
            ? `SELECT record
                 FROM anysentry_session_memberships_v1
                WHERE COALESCE(NULLIF(interaction_id, ''), record->>'interactionId') = ANY($1::text[])
                ORDER BY valid_from DESC, membership_id, resolution_revision DESC
                LIMIT $2`
            : ids.length && requestedRevision !== undefined
          ? `SELECT record
               FROM anysentry_session_memberships_v1
              WHERE membership_id = ANY($1::text[]) AND resolution_revision = $2
              ORDER BY membership_id
              LIMIT $3`
          : ids.length
            ? `SELECT record
                 FROM anysentry_session_memberships_v1
                WHERE membership_id = ANY($1::text[])
                ORDER BY membership_id, resolution_revision DESC
                LIMIT $2`
            : requestedRevision !== undefined
              ? `SELECT record
                   FROM anysentry_session_memberships_v1
                  WHERE resolution_revision = $1
                  ORDER BY valid_from DESC, membership_id
                  LIMIT $2`
              : `SELECT record
                   FROM anysentry_session_memberships_v1
                  ORDER BY valid_from DESC, membership_id, resolution_revision DESC
                  LIMIT $1`,
        sessionIds.length && requestedRevision !== undefined
          ? [sessionIds, requestedRevision, limit]
          : sessionIds.length ? [sessionIds, limit]
            : interactionIds.length && requestedRevision !== undefined
          ? [interactionIds, requestedRevision, limit]
          : interactionIds.length ? [interactionIds, limit]
            : ids.length && requestedRevision !== undefined
          ? [ids, requestedRevision, limit]
          : ids.length ? [ids, limit]
            : requestedRevision !== undefined ? [requestedRevision, limit] : [limit],
      );
      return result.rows
        .flatMap(({ record }) => {
          const parsed = this.parseRecord<SessionMembership>(record);
          const checked = validateSessionMembership(parsed);
          return checked.ok ? [checked.value] : [];
        });
    } catch (error) {
      this.markUnavailable('load canonical SessionMemberships', error);
      if (strictRead) throw error;
      return [];
    }
  }

  async saveCoverageGaps(gaps: readonly CoverageGap[]): Promise<boolean> {
    if (gaps.length === 0) return true;
    if (gaps.length > SEMANTIC_RECORD_LIMIT) return false;
    const bounded = gaps.slice(0, SEMANTIC_RECORD_LIMIT);
    if (batchHasConflictingRecords(
      bounded,
      (record) => `${record.gapId}\0${record.revision}`,
    )) return false;
    const boundedJson = boundedJsonRows(bounded, SEMANTIC_RECORD_LIMIT, CANONICAL_WRITE_MAX_BYTES);
    if (!boundedJson) return false;
    if (!(await this.initialize()) || !this.pool) return false;
    try {
      const conflict = await this.pool.query<{ conflict: boolean }>(
        `WITH incoming AS (
           SELECT item AS record
             FROM jsonb_array_elements($1::jsonb) AS source(item)
         )
         SELECT EXISTS (
           SELECT 1
             FROM anysentry_coverage_gaps_v1 existing
             JOIN incoming
               ON existing.gap_id = incoming.record->>'gapId'
              AND existing.revision = (incoming.record->>'revision')::bigint
            WHERE existing.record <> incoming.record
         ) AS conflict`,
        [boundedJson],
      );
      if (conflict.rows?.[0]?.conflict === true) return false;
      await this.pool.query(
        `WITH incoming AS (
           SELECT item AS record
             FROM jsonb_array_elements($1::jsonb) AS source(item)
         )
         INSERT INTO anysentry_coverage_gaps_v1 (
           gap_id, revision, stage, reason, scope, first_seen_at, last_seen_at,
           dropped_count, orphaned_count, record
         )
         SELECT
           record->>'gapId',
           (record->>'revision')::bigint,
           record->>'stage',
           record->>'reason',
           record->>'scope',
           (record->>'firstSeenAtUnixNs')::numeric,
           (record->>'lastSeenAtUnixNs')::numeric,
           (record->>'droppedCount')::bigint,
           (record->>'orphanedCount')::bigint,
           record
         FROM incoming
         ON CONFLICT (gap_id, revision) DO NOTHING`,
        [boundedJson],
      );
      await this.pruneCoverageGapHistory(boundedJson);
      return true;
    } catch (error) {
      this.markUnavailable('save canonical coverage gaps', error);
      return false;
    }
  }

  private async pruneCoverageGapHistory(incomingJson: string): Promise<void> {
    if (!this.pool) return;
    await this.pool.query(
      `WITH incoming AS (
         SELECT DISTINCT item->>'gapId' AS gap_id
           FROM jsonb_array_elements($1::jsonb) AS source(item)
       ),
       cutoff AS (
         SELECT gap_id, MAX(revision) - $2::bigint AS min_revision
           FROM anysentry_coverage_gaps_v1
          WHERE gap_id IN (SELECT gap_id FROM incoming)
          GROUP BY gap_id
       )
       DELETE FROM anysentry_coverage_gaps_v1 existing
        USING cutoff
        WHERE existing.gap_id = cutoff.gap_id
          AND existing.revision < cutoff.min_revision`,
      [incomingJson, COVERAGE_GAP_REVISION_KEEP - 1],
    );
    this.coverageGapPruneCounter += 1;
    if (this.coverageGapPruneCounter % COVERAGE_GAP_TTL_PRUNE_EVERY !== 1) return;
    const ttlNs = String(BigInt(Date.now() - COVERAGE_GAP_TTL_MS) * 1_000_000n);
    await this.pool.query(
      `DELETE FROM anysentry_coverage_gaps_v1
        WHERE (last_seen_at, gap_id, revision) IN (
          SELECT last_seen_at, gap_id, revision
            FROM anysentry_coverage_gaps_v1
           WHERE last_seen_at < $1::numeric
           ORDER BY last_seen_at, gap_id, revision
           LIMIT $2
        )`,
      [ttlNs, COVERAGE_GAP_TTL_PRUNE_BATCH],
    );
  }

  private startCoverageGapIdlePrune(): void {
    if (this.coverageGapIdleTimer || !this.configured()) return;
    const tick = () => {
      void this.pruneCoverageGapsIdle()
        .catch((error) => {
          this.logger.warn(
            `coverage gap idle prune failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        })
        .finally(() => {
          if (!this.ready) return;
          this.coverageGapIdleTimer = setTimeout(tick, COVERAGE_GAP_IDLE_PRUNE_MS);
          this.coverageGapIdleTimer.unref();
        });
    };
    this.coverageGapIdleTimer = setTimeout(tick, 8_000);
    this.coverageGapIdleTimer.unref();
  }

  private async pruneCoverageGapsIdle(): Promise<void> {
    if (!this.pool || this.coverageGapIdlePruneInFlight) return;
    this.coverageGapIdlePruneInFlight = true;
    try {
      const excess = await this.pool.query(
        `WITH recent AS (
           SELECT gap_id
             FROM anysentry_coverage_gaps_v1
            ORDER BY last_seen_at DESC
            LIMIT $1
         ),
         hot AS (
           SELECT g.gap_id, (MAX(g.revision) - $2::bigint) AS min_keep
             FROM anysentry_coverage_gaps_v1 g
            WHERE g.gap_id IN (SELECT DISTINCT gap_id FROM recent)
            GROUP BY g.gap_id
           HAVING COUNT(*) > $3::bigint
         )
         DELETE FROM anysentry_coverage_gaps_v1 g
          WHERE g.ctid IN (
            SELECT g2.ctid
              FROM anysentry_coverage_gaps_v1 g2
              JOIN hot ON hot.gap_id = g2.gap_id
             WHERE g2.revision < hot.min_keep
             LIMIT $4
          )`,
        [
          COVERAGE_GAP_IDLE_SAMPLE_ROWS,
          COVERAGE_GAP_REVISION_KEEP - 1,
          COVERAGE_GAP_REVISION_KEEP,
          COVERAGE_GAP_IDLE_PRUNE_BATCH,
        ],
      );
      const ttlNs = String(BigInt(Date.now() - COVERAGE_GAP_TTL_MS) * 1_000_000n);
      const ttl = await this.pool.query(
        `DELETE FROM anysentry_coverage_gaps_v1
          WHERE (last_seen_at, gap_id, revision) IN (
            SELECT last_seen_at, gap_id, revision
              FROM anysentry_coverage_gaps_v1
             WHERE last_seen_at < $1::numeric
             ORDER BY last_seen_at, gap_id, revision
             LIMIT $2
          )`,
        [ttlNs, COVERAGE_GAP_IDLE_PRUNE_BATCH],
      );
      const sampled = await this.pool.query(
        `WITH sample AS (
           SELECT gap_id
             FROM anysentry_coverage_gaps_v1 TABLESAMPLE SYSTEM (1)
         ),
         freq AS (
           SELECT gap_id, COUNT(*) AS n
             FROM sample
            GROUP BY gap_id
            ORDER BY n DESC
            LIMIT 16
         ),
         hot AS (
           SELECT g.gap_id, (MAX(g.revision) - $1::bigint) AS min_keep
             FROM anysentry_coverage_gaps_v1 g
             JOIN freq f ON f.gap_id = g.gap_id
            GROUP BY g.gap_id
           HAVING COUNT(*) > $2::bigint
         )
         DELETE FROM anysentry_coverage_gaps_v1 g
          WHERE g.ctid IN (
            SELECT g2.ctid
              FROM anysentry_coverage_gaps_v1 g2
              JOIN hot ON hot.gap_id = g2.gap_id
             WHERE g2.revision < hot.min_keep
             LIMIT $3
          )`,
        [
          COVERAGE_GAP_REVISION_KEEP - 1,
          COVERAGE_GAP_REVISION_KEEP,
          COVERAGE_GAP_IDLE_PRUNE_BATCH,
        ],
      );
      this.logger.log(
        `coverage gap idle prune recent=${excess.rowCount ?? 0} sample=${sampled.rowCount ?? 0} ttl=${ttl.rowCount ?? 0}`,
      );
    } finally {
      this.coverageGapIdlePruneInFlight = false;
    }
  }

  async loadCoverageGaps(input: { limit?: number } = {}): Promise<CoverageGap[]> {
    if (!(await this.initialize()) || !this.pool) return [];
    const requested = Number(input.limit ?? 1_000);
    const limit = Number.isFinite(requested)
      ? Math.max(1, Math.min(SEMANTIC_RECORD_LIMIT, Math.trunc(requested)))
      : 1_000;
    try {
      const result = await this.pool.query<{ record: CoverageGap | string }>(
        `SELECT record
           FROM anysentry_coverage_gaps_v1
          ORDER BY last_seen_at DESC, gap_id, revision DESC
          LIMIT $1`,
        [limit],
      );
      return result.rows
        .flatMap(({ record }) => {
          const parsed = this.parseRecord<CoverageGap>(record);
          const checked = validateCoverageGap(parsed);
          return checked.ok ? [checked.value] : [];
        });
    } catch (error) {
      this.markUnavailable('load canonical coverage gaps', error);
      return [];
    }
  }

  async saveEvidenceLinks(links: readonly EvidenceLink[]): Promise<boolean> {
    return this.enqueueProjectionBatch(
      this.evidenceBatch, links, this.evidenceBatchMaxRows,
      row => `${row.linkId}\0${row.resolutionRevision}`,
      rows => this.saveEvidenceLinksNow(rows),
    );
  }

  private async saveEvidenceLinksNow(links: readonly EvidenceLink[]): Promise<boolean> {
    if (links.length === 0) return true;
    if (links.length > SEMANTIC_RECORD_LIMIT) return false;
    const bounded = links.slice(0, SEMANTIC_RECORD_LIMIT);
    if (batchHasConflictingRecords(
      bounded,
      (record) => `${record.linkId}\0${record.resolutionRevision}`,
    )) return false;
    const boundedJson = boundedJsonRows(bounded, SEMANTIC_RECORD_LIMIT, CANONICAL_WRITE_MAX_BYTES);
    if (!boundedJson) return false;
    if (!(await this.initialize()) || !this.pool) return false;
    try {
      const conflict = await this.pool.query<{ conflict: boolean }>(
        `WITH incoming AS (
           SELECT item AS record
             FROM jsonb_array_elements($1::jsonb) AS source(item)
         )
         SELECT EXISTS (
           SELECT 1
             FROM anysentry_evidence_links_v1 existing
             JOIN incoming
               ON existing.link_id = incoming.record->>'linkId'
              AND existing.resolution_revision = (incoming.record->>'resolutionRevision')::bigint
            WHERE existing.record <> incoming.record
         ) AS conflict`,
        [boundedJson],
      );
      if (conflict.rows?.[0]?.conflict === true) return false;
      await this.pool.query(
        `WITH incoming AS (
           SELECT item AS record
             FROM jsonb_array_elements($1::jsonb) AS source(item)
         )
         INSERT INTO anysentry_evidence_links_v1 (
           link_id, resolution_revision, from_type, from_id, to_type, to_id,
           relation, method, confidence, status, authority, valid_from, record
         )
         SELECT
           record->>'linkId',
           (record->>'resolutionRevision')::bigint,
           record->>'fromType', record->>'fromId', record->>'toType', record->>'toId',
           record->>'relation', record->>'method', (record->>'confidence')::double precision,
           record->>'status', record->>'authority', (record->>'validFromUnixNs')::numeric, record
         FROM incoming
         ON CONFLICT (link_id, resolution_revision) DO NOTHING`,
        [boundedJson],
      );
      return true;
    } catch (error) {
      this.markUnavailable('save canonical EvidenceLinks', error);
      return false;
    }
  }

  async loadEvidenceLinks(input: {
    linkIds?: readonly string[];
    fromType?: EvidenceLink['fromType'];
    fromIds?: readonly string[];
    toType?: EvidenceLink['toType'];
    toIds?: readonly string[];
    evidenceRef?: string;
    resolutionRevision?: number;
    limit?: number;
  } = {}): Promise<EvidenceLink[]> {
    if (!(await this.initialize()) || !this.pool) {
      this.evidenceLinksReadFailureAt = Date.now();
      return [];
    }
    const requested = Number(input.limit ?? 1_000);
    const limit = Number.isFinite(requested)
      ? Math.max(1, Math.min(SEMANTIC_RECORD_LIMIT, Math.trunc(requested))) : 1_000;
    try {
      const ids = [...new Set((input.linkIds ?? []).map((value) => String(value).trim()).filter(Boolean))].slice(0, SEMANTIC_RECORD_LIMIT);
      const fromIds = [...new Set((input.fromIds ?? []).map((value) => String(value).trim()).filter(Boolean))].slice(0, SEMANTIC_RECORD_LIMIT);
      const toIds = [...new Set((input.toIds ?? []).map((value) => String(value).trim()).filter(Boolean))].slice(0, SEMANTIC_RECORD_LIMIT);
      const requestedRevision = input.resolutionRevision !== undefined
        && Number.isSafeInteger(input.resolutionRevision) && input.resolutionRevision > 0
        ? input.resolutionRevision : undefined;
      const params: unknown[] = [];
      const clauses: string[] = [];
      const bind = (value: unknown): string => {
        params.push(value);
        return `$${params.length}`;
      };
      if (ids.length) clauses.push(`link_id = ANY(${bind(ids)}::text[])`);
      if (input.fromType) clauses.push(`from_type = ${bind(input.fromType)}`);
      if (fromIds.length) clauses.push(`from_id = ANY(${bind(fromIds)}::text[])`);
      if (input.toType) clauses.push(`to_type = ${bind(input.toType)}`);
      if (toIds.length) clauses.push(`to_id = ANY(${bind(toIds)}::text[])`);
      const evidenceRef = typeof input.evidenceRef === 'string' ? input.evidenceRef.trim().slice(0, 512) : '';
      if (evidenceRef) clauses.push(`record->'evidenceRefs' ? ${bind(evidenceRef)}`);
      if (requestedRevision !== undefined) clauses.push(`resolution_revision = ${bind(requestedRevision)}`);
      const limitBind = bind(limit);
      const result = await this.pool.query<{ record: EvidenceLink | string }>(
        `SELECT record
           FROM anysentry_evidence_links_v1
          ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
          ORDER BY valid_from DESC, link_id, resolution_revision DESC
          LIMIT ${limitBind}`,
        params,
      );
      this.evidenceLinksReadFailureAt = 0;
      return result.rows
        .flatMap(({ record }) => {
          const parsed = this.parseRecord<EvidenceLink>(record);
          const checked = validateEvidenceLink(parsed);
          return checked.ok ? [checked.value] : [];
        });
    } catch (error) {
      this.evidenceLinksReadFailureAt = Date.now();
      this.markUnavailable('load canonical EvidenceLinks', error);
      return [];
    }
  }

  async saveAgentConversationResolution(
    threads: AgentConversationThreadRecord[],
    segments: ConversationInstanceSegment[],
    bindings: AgentConversationBindingRecord[],
  ): Promise<boolean> {
    if (threads.length === 0 && segments.length === 0 && bindings.length === 0) return true;
    const threadJson = boundedJsonRows(
      threads,
      CONVERSATION_RESOLUTION_V1_MAX_THREADS,
      CONVERSATION_RESOLUTION_V1_MAX_CATEGORY_BYTES,
    );
    const segmentJson = boundedJsonRows(
      segments,
      CONVERSATION_RESOLUTION_V1_MAX_SEGMENTS,
      CONVERSATION_RESOLUTION_V1_MAX_CATEGORY_BYTES,
    );
    const bindingJson = boundedJsonRows(
      bindings,
      CONVERSATION_RESOLUTION_V1_MAX_BINDINGS,
      CONVERSATION_RESOLUTION_V1_MAX_CATEGORY_BYTES,
    );
    const totalBytes = [threadJson, segmentJson, bindingJson]
      .filter((json): json is string => Boolean(json))
      .reduce((sum, json) => sum + Buffer.byteLength(json, 'utf8'), 0);
    if ((threads.length > 0 && !threadJson)
      || (segments.length > 0 && !segmentJson)
      || (bindings.length > 0 && !bindingJson)
      || totalBytes > CONVERSATION_RESOLUTION_V1_MAX_BYTES) {
      this.logger.warn('Agent Conversation V1 compatibility persistence batch exceeded its bounded payload budget');
      return false;
    }
    if (!(await this.initialize()) || !this.pool) return false;
    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect();
      await client.query('BEGIN');
      if (threads.length) {
        await client.query(
          `WITH incoming AS (
             SELECT item AS record
               FROM jsonb_array_elements($1::jsonb) AS source(item)
           )
           INSERT INTO anysentry_agent_conversation_threads_v1 (
             conversation_id, logical_scope_key, id_source, last_activity_at, record, updated_at
           )
           SELECT
             record->>'conversationId',
             record->>'logicalScopeKey',
             record->>'idSource',
             (record->>'lastActivityAtUnixNs')::numeric,
             record,
             (record->>'updatedAt')::bigint
           FROM incoming
           ON CONFLICT (conversation_id) DO UPDATE SET
             logical_scope_key = EXCLUDED.logical_scope_key,
             id_source = EXCLUDED.id_source,
             last_activity_at = GREATEST(
               anysentry_agent_conversation_threads_v1.last_activity_at,
               EXCLUDED.last_activity_at
             ),
             record = EXCLUDED.record,
             updated_at = EXCLUDED.updated_at
           WHERE EXCLUDED.updated_at >= anysentry_agent_conversation_threads_v1.updated_at`,
          [threadJson],
        );
      }
      if (segments.length) {
        await client.query(
          `WITH incoming AS (
             SELECT item AS record
               FROM jsonb_array_elements($1::jsonb) AS source(item)
           )
           INSERT INTO anysentry_agent_conversation_segments_v1 (
             segment_id, conversation_id, agent_instance_id, ordinal,
             started_at, ended_at, record, updated_at
           )
           SELECT
             record->>'segmentId',
             record->>'conversationId',
             record->>'agentInstanceId',
             (record->>'ordinal')::integer,
             (record->>'startedAtUnixNs')::numeric,
             NULLIF(record->>'endedAtUnixNs', '')::numeric,
             record,
             (record->>'updatedAt')::bigint
           FROM incoming
           ON CONFLICT (segment_id) DO UPDATE SET
             ended_at = EXCLUDED.ended_at,
             record = EXCLUDED.record,
             updated_at = EXCLUDED.updated_at
           WHERE EXCLUDED.updated_at >= anysentry_agent_conversation_segments_v1.updated_at`,
          [segmentJson],
        );
      }
      if (bindings.length) {
        await client.query(
          `WITH incoming AS (
             SELECT item AS record
               FROM jsonb_array_elements($1::jsonb) AS source(item)
           )
           INSERT INTO anysentry_agent_conversation_bindings_v1 (
             interaction_id, conversation_id, segment_id, logical_scope_key,
             record, updated_at
           )
           SELECT
             record->>'interactionId',
             record->>'conversationId',
             record->>'segmentId',
             record->>'logicalScopeKey',
             record,
             (record->>'updatedAt')::bigint
           FROM incoming
           ON CONFLICT (interaction_id) DO UPDATE SET
             conversation_id = EXCLUDED.conversation_id,
             segment_id = EXCLUDED.segment_id,
             logical_scope_key = EXCLUDED.logical_scope_key,
             record = EXCLUDED.record,
             updated_at = EXCLUDED.updated_at
           WHERE (EXCLUDED.record->>'resolverVersion')::integer >= (
             anysentry_agent_conversation_bindings_v1.record->>'resolverVersion'
           )::integer`,
          [bindingJson],
        );
      }
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client?.query('ROLLBACK').catch(() => undefined);
      this.markUnavailable('save Agent Conversation resolution', error);
      return false;
    } finally {
      client?.release();
    }
  }

  async saveAgentConversationResolutionV2(
    anchors: AgentConversationAnchorPersistence[],
    memberships: ConversationMembershipV2[],
    aliases: ConversationRouteAliasV1[],
    technicalActivities: TechnicalActivityProjection[],
  ): Promise<boolean> {
    if (!anchors.length && !memberships.length && !aliases.length && !technicalActivities.length) {
      return true;
    }
    const anchorRows = anchors.map((item) => ({
      interactionId: item.interactionId,
      logicalScopeKey: item.logicalScopeKey,
      observedAt: item.observedAt,
      ...item.anchor,
    }));
    let technicalRowsValid = true;
    const technicalRows = technicalActivities.map((item) => {
      try {
        const endedAt = BigInt(item.endedAtUnixNs);
        if (endedAt < 0n) technicalRowsValid = false;
        return { ...item, updatedAt: Number(endedAt / 1_000_000n) };
      } catch {
        technicalRowsValid = false;
        return { ...item, updatedAt: 0 };
      }
    });
    const anchorJson = boundedJsonRows(
      anchorRows,
      CONVERSATION_RESOLUTION_V2_MAX_ANCHORS,
      CONVERSATION_RESOLUTION_V2_MAX_CATEGORY_BYTES,
    );
    const membershipJson = boundedJsonRows(
      memberships,
      CONVERSATION_RESOLUTION_V2_MAX_MEMBERSHIPS,
      CONVERSATION_RESOLUTION_V2_MAX_CATEGORY_BYTES,
    );
    const aliasJson = boundedJsonRows(
      aliases,
      CONVERSATION_RESOLUTION_V2_MAX_ALIASES,
      CONVERSATION_RESOLUTION_V2_MAX_CATEGORY_BYTES,
    );
    const technicalJson = boundedJsonRows(
      technicalRows,
      CONVERSATION_RESOLUTION_V2_MAX_TECHNICAL,
      CONVERSATION_RESOLUTION_V2_MAX_CATEGORY_BYTES,
    );
    const totalBytes = [anchorJson, membershipJson, aliasJson, technicalJson]
      .filter((json): json is string => Boolean(json))
      .reduce((sum, json) => sum + Buffer.byteLength(json, 'utf8'), 0);
    if ((anchors.length > 0 && !anchorJson)
      || (memberships.length > 0 && !membershipJson)
      || (aliases.length > 0 && !aliasJson)
      || (technicalActivities.length > 0 && !technicalJson)
      || !technicalRowsValid
      || batchHasConflictingRecords(aliases, (alias) => alias.aliasConversationId)
      || batchHasConflictingRecords(technicalActivities, (activity) => activity.technicalActivityId)
      || totalBytes > CONVERSATION_RESOLUTION_V2_MAX_BYTES) {
      this.logger.warn('Agent Conversation V2 persistence batch exceeded its bounded payload budget');
      return false;
    }
    if (!(await this.initialize()) || !this.pool) return false;
    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect();
      await client.query('BEGIN');
      if (anchors.length) {
        const conflict = await client.query<{ conflict: boolean }>(
          `WITH incoming AS (
             SELECT item AS record
               FROM jsonb_array_elements($1::jsonb) AS source(item)
           )
           SELECT (
             EXISTS (
               SELECT 1
                 FROM incoming
                GROUP BY record->>'interactionId', record->>'kind',
                         record->>'namespace', record->>'valueHash'
               HAVING COUNT(DISTINCT record) > 1
             ) OR EXISTS (
               SELECT 1
                 FROM anysentry_agent_conversation_anchors_v1 AS existing
                 JOIN incoming
                   ON existing.interaction_id = incoming.record->>'interactionId'
                  AND existing.anchor_kind = incoming.record->>'kind'
                  AND existing.anchor_namespace = incoming.record->>'namespace'
                  AND existing.value_hash = incoming.record->>'valueHash'
                WHERE existing.record <> incoming.record
             )
           ) AS conflict`,
          [anchorJson],
        );
        if (conflict.rows?.[0]?.conflict === true) {
          await client.query('ROLLBACK');
          return false;
        }
        await client.query(
          `WITH incoming AS (
             SELECT item AS record
               FROM jsonb_array_elements($1::jsonb) AS source(item)
           )
           INSERT INTO anysentry_agent_conversation_anchors_v1 (
             interaction_id, logical_scope_key, anchor_kind, anchor_namespace,
             value_hash, strength, source_path, observed_at, record
           )
           SELECT
             record->>'interactionId',
             record->>'logicalScopeKey',
             record->>'kind',
             record->>'namespace',
             record->>'valueHash',
             record->>'strength',
             record->>'sourcePath',
             (record->>'observedAt')::bigint,
             record
           FROM incoming
           -- Anchor facts are immutable.  A late/stronger observation gets a distinct anchor
           -- value (or a future relation revision); it must never rewrite the source path or
           -- strength of an already persisted fact.
           ON CONFLICT (interaction_id, anchor_kind, anchor_namespace, value_hash)
           DO NOTHING`,
          [anchorJson],
        );
      }
      if (memberships.length) {
        const conflict = await client.query<{ conflict: boolean }>(
          `WITH incoming AS (
             SELECT item AS record
               FROM jsonb_array_elements($1::jsonb) AS source(item)
           )
           SELECT (
             EXISTS (
               SELECT 1
                 FROM incoming
                GROUP BY record->>'interactionId', (record->>'resolutionRevision')::bigint
               HAVING COUNT(DISTINCT record) > 1
             ) OR EXISTS (
               SELECT 1
                 FROM anysentry_agent_conversation_memberships_v2 AS existing
                 JOIN incoming
                   ON existing.interaction_id = incoming.record->>'interactionId'
                  AND existing.resolution_revision = (incoming.record->>'resolutionRevision')::bigint
                WHERE existing.record <> incoming.record
             )
           ) AS conflict`,
          [membershipJson],
        );
        if (conflict.rows?.[0]?.conflict === true) {
          await client.query('ROLLBACK');
          return false;
        }
        await client.query(
          `WITH incoming AS (
             SELECT item AS record
               FROM jsonb_array_elements($1::jsonb) AS source(item)
           )
           INSERT INTO anysentry_agent_conversation_memberships_v2 (
             interaction_id, resolution_revision, logical_scope_key, role,
             canonical_conversation_id, technical_activity_id, record, decided_at
           )
           SELECT
             record->>'interactionId',
             (record->>'resolutionRevision')::bigint,
             record->>'logicalScopeKey',
             record->>'role',
             NULLIF(record->>'canonicalConversationId', ''),
             NULLIF(record->>'technicalActivityId', ''),
             record,
             (record->>'decidedAt')::bigint
           FROM incoming
           -- Memberships are versioned decisions.  The same interaction/revision is immutable;
           -- a changed decision must be emitted under a new resolution revision rather than
           -- silently overwriting the historical row.
           ON CONFLICT (interaction_id, resolution_revision)
           DO NOTHING`,
          [membershipJson],
        );
      }
      if (aliases.length) {
        await client.query(
          `WITH incoming AS (
             SELECT item AS record
               FROM jsonb_array_elements($1::jsonb) AS source(item)
           )
           INSERT INTO anysentry_agent_conversation_route_aliases_v1 (
             alias_conversation_id, target_type, target_id, resolution_revision,
             record, updated_at
           )
           SELECT
             record->>'aliasConversationId',
             record->>'targetType',
             record->>'targetId',
             (record->>'resolutionRevision')::bigint,
             record,
             (record->>'createdAt')::bigint
           FROM incoming
           ON CONFLICT (alias_conversation_id) DO UPDATE SET
             target_type = EXCLUDED.target_type,
             target_id = EXCLUDED.target_id,
             resolution_revision = EXCLUDED.resolution_revision,
             record = EXCLUDED.record,
             updated_at = EXCLUDED.updated_at
           WHERE EXCLUDED.resolution_revision >=
             anysentry_agent_conversation_route_aliases_v1.resolution_revision`,
          [aliasJson],
        );
      }
      if (technicalActivities.length) {
        await client.query(
          `WITH incoming AS (
             SELECT item AS record
               FROM jsonb_array_elements($1::jsonb) AS source(item)
           )
           INSERT INTO anysentry_agent_run_technical_activities_v1 (
             technical_activity_id, agent_instance_id, started_at, ended_at,
             record, updated_at
           )
           SELECT
             record->>'technicalActivityId',
             NULLIF(record->>'agentInstanceId', ''),
             (record->>'startedAtUnixNs')::numeric,
             (record->>'endedAtUnixNs')::numeric,
             record,
             (record->>'updatedAt')::bigint
           FROM incoming
           ON CONFLICT (technical_activity_id) DO UPDATE SET
             agent_instance_id = EXCLUDED.agent_instance_id,
             started_at = LEAST(
               anysentry_agent_run_technical_activities_v1.started_at, EXCLUDED.started_at
             ),
             ended_at = GREATEST(
               anysentry_agent_run_technical_activities_v1.ended_at, EXCLUDED.ended_at
             ),
             record = EXCLUDED.record,
             updated_at = EXCLUDED.updated_at
           WHERE EXCLUDED.updated_at >=
             anysentry_agent_run_technical_activities_v1.updated_at`,
          [technicalJson],
        );
      }
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client?.query('ROLLBACK').catch(() => undefined);
      this.markUnavailable('save Agent Conversation V2 resolution', error);
      return false;
    } finally {
      client?.release();
    }
  }

  async loadAgentSemanticKernelRelations(
    semanticEventId: string,
  ): Promise<AgentSemanticKernelRelation[]> {
    if (!semanticEventId || !(await this.initialize()) || !this.pool) return [];
    try {
      const result = await this.pool.query<{ record: AgentSemanticKernelRelation | string }>(
        `WITH history_latest AS (
           SELECT DISTINCT ON (relation_id) relation_id, record, resolution_revision
             FROM anysentry_agent_semantic_kernel_relation_history_v1
            WHERE stable_semantic_event_id = $1
            ORDER BY relation_id, resolution_revision DESC
         ), legacy_only AS (
           SELECT current.relation_id, current.record, current.resolution_revision
             FROM anysentry_agent_semantic_kernel_relations_v1 AS current
            WHERE current.stable_semantic_event_id = $1
              AND NOT EXISTS (
                SELECT 1
                  FROM history_latest AS historical
                 WHERE historical.relation_id = current.relation_id
              )
         )
         SELECT record
           FROM (
             SELECT record, resolution_revision, relation_id FROM history_latest
             UNION ALL
             SELECT record, resolution_revision, relation_id FROM legacy_only
           ) AS combined
         ORDER BY resolution_revision DESC, relation_id
         LIMIT 1_000`,
        [semanticEventId],
      );
      return result.rows
        .map(({ record }) => this.parseRecord<AgentSemanticKernelRelation>(record))
        .filter((record): record is AgentSemanticKernelRelation => Boolean(
          record?.relationId && record.stableSemanticEventId === semanticEventId,
        ));
    } catch (error) {
      // Older installations may not have run the additive history migration yet.  Preserve the
      // compatibility read path while surfacing the migration failure through normal health state.
      this.markUnavailable('load Agent Semantic Kernel relations', error);
      try {
        const legacy = await this.pool.query<{ record: AgentSemanticKernelRelation | string }>(
          `SELECT record
             FROM anysentry_agent_semantic_kernel_relations_v1
            WHERE stable_semantic_event_id = $1
            ORDER BY resolution_revision DESC, relation_id
            LIMIT 1_000`,
          [semanticEventId],
        );
        return legacy.rows
          .map(({ record }) => this.parseRecord<AgentSemanticKernelRelation>(record))
          .filter((record): record is AgentSemanticKernelRelation => Boolean(
            record?.relationId && record.stableSemanticEventId === semanticEventId,
          ));
      } catch {
        return [];
      }
    }
  }

  async loadAgentSemanticRelationsForKernelEvent(
    kernelEventId: string,
  ): Promise<AgentSemanticKernelRelation[]> {
    if (!kernelEventId || !(await this.initialize()) || !this.pool) return [];
    try {
      const result = await this.pool.query<{ record: AgentSemanticKernelRelation | string }>(
        `WITH history_latest AS (
           SELECT DISTINCT ON (relation_id) relation_id, record, resolution_revision
             FROM anysentry_agent_semantic_kernel_relation_history_v1
            WHERE kernel_event_id = $1
            ORDER BY relation_id, resolution_revision DESC
         ), legacy_only AS (
           SELECT current.relation_id, current.record, current.resolution_revision
             FROM anysentry_agent_semantic_kernel_relations_v1 AS current
            WHERE current.kernel_event_id = $1
              AND NOT EXISTS (
                SELECT 1
                  FROM history_latest AS historical
                 WHERE historical.relation_id = current.relation_id
              )
         )
         SELECT record
           FROM (
             SELECT record, resolution_revision, relation_id FROM history_latest
             UNION ALL
             SELECT record, resolution_revision, relation_id FROM legacy_only
           ) AS combined
         ORDER BY resolution_revision DESC, relation_id
         LIMIT 1_000`,
        [kernelEventId],
      );
      return result.rows
        .map(({ record }) => this.parseRecord<AgentSemanticKernelRelation>(record))
        .filter((record): record is AgentSemanticKernelRelation => Boolean(
          record?.kernelEventId === kernelEventId && record.stableSemanticEventId,
        ));
    } catch (error) {
      this.markUnavailable('load semantic context for Kernel event', error);
      try {
        const legacy = await this.pool.query<{ record: AgentSemanticKernelRelation | string }>(
          `SELECT record
             FROM anysentry_agent_semantic_kernel_relations_v1
            WHERE kernel_event_id = $1
            ORDER BY resolution_revision DESC, relation_id
            LIMIT 1_000`,
          [kernelEventId],
        );
        return legacy.rows
          .map(({ record }) => this.parseRecord<AgentSemanticKernelRelation>(record))
          .filter((record): record is AgentSemanticKernelRelation => Boolean(
            record?.kernelEventId === kernelEventId && record.stableSemanticEventId,
          ));
      } catch {
        return [];
      }
    }
  }

  async saveAgentSemanticKernelRelations(
    relations: AgentSemanticKernelRelation[],
  ): Promise<boolean> {
    if (!relations.length) return true;
    if (relations.length > SEMANTIC_KERNEL_RELATION_MAX_ROWS
      || batchHasConflictingRecords(
        relations,
        (relation) => `${relation.relationId}\u0000${relation.resolutionRevision}`,
      )) {
      this.logger.warn('Agent Semantic Kernel relation batch exceeded row bounds or contained conflicting revisions');
      return false;
    }
    let client: PoolClient | undefined;
    try {
      const updatedAt = Date.now();
      const rows = relations.map((relation) => ({ ...relation, updatedAt }));
      const rowsJson = boundedJsonRows(
        rows,
        SEMANTIC_KERNEL_RELATION_MAX_ROWS,
        SEMANTIC_KERNEL_RELATION_MAX_BYTES,
      );
      if (!rowsJson) {
        this.logger.warn('Agent Semantic Kernel relation batch exceeded its bounded payload budget');
        return false;
      }
      if (!(await this.initialize()) || !this.pool) return false;
      client = await this.pool.connect();
      await client.query('BEGIN');
      // Check both the history table and the legacy latest-row projection before inserting.  A
      // retry with the same relation/revision is idempotent; a changed payload is a conflict and
      // must never overwrite an already-audited decision.
      const conflict = await client.query<{ conflict: boolean }>(
        `WITH incoming AS (
           SELECT item AS record
             FROM jsonb_array_elements($1::jsonb) AS source(item)
         )
         SELECT EXISTS (
           SELECT 1
             FROM anysentry_agent_semantic_kernel_relation_history_v1 AS historical
             JOIN incoming
               ON historical.relation_id = incoming.record->>'relationId'
              AND historical.resolution_revision = (incoming.record->>'resolutionRevision')::bigint
            -- updatedAt is a mutable storage timestamp, not part of the relation identity.
            -- Exclude it from the conflict comparison so a retry of the same relation/revision is
            -- idempotent even when it arrives in a later millisecond.
            WHERE (historical.record - 'updatedAt') <> (incoming.record - 'updatedAt')
           UNION ALL
           SELECT 1
             FROM anysentry_agent_semantic_kernel_relations_v1 AS current
             JOIN incoming
               ON current.relation_id = incoming.record->>'relationId'
              AND current.resolution_revision = (incoming.record->>'resolutionRevision')::bigint
            WHERE (current.record - 'updatedAt') <> (incoming.record - 'updatedAt')
         ) AS conflict`,
        [rowsJson],
      );
      if (conflict.rows?.[0]?.conflict === true) {
        await client.query('ROLLBACK');
        return false;
      }
      await client.query(
        `WITH incoming AS (
           SELECT item AS record
             FROM jsonb_array_elements($1::jsonb) AS source(item)
         )
         INSERT INTO anysentry_agent_semantic_kernel_relation_history_v1 (
           relation_id, stable_semantic_event_id, tool_invocation_id,
           kernel_event_id, relation_status, resolution_revision, record, updated_at
         )
         SELECT
           record->>'relationId',
           record->>'stableSemanticEventId',
           record->>'toolInvocationId',
           NULLIF(record->>'kernelEventId', ''),
           record->>'status',
           (record->>'resolutionRevision')::bigint,
           record,
           (record->>'updatedAt')::bigint
         FROM incoming
         ON CONFLICT (relation_id, resolution_revision) DO NOTHING`,
        [rowsJson],
      );
      // Keep the existing table as a latest-row compatibility projection only.  It may be
      // updated, but the immutable history row above is never deleted or rewritten.
      await client.query(
        `WITH incoming AS (
           SELECT item AS record
             FROM jsonb_array_elements($1::jsonb) AS source(item)
         ), latest_incoming AS (
           SELECT DISTINCT ON (record->>'relationId') record
             FROM incoming
            ORDER BY record->>'relationId', (record->>'resolutionRevision')::bigint DESC
         )
         INSERT INTO anysentry_agent_semantic_kernel_relations_v1 (
           relation_id, stable_semantic_event_id, tool_invocation_id,
           kernel_event_id, relation_status, resolution_revision, record, updated_at
         )
         SELECT
           record->>'relationId',
           record->>'stableSemanticEventId',
           record->>'toolInvocationId',
           NULLIF(record->>'kernelEventId', ''),
           record->>'status',
           (record->>'resolutionRevision')::bigint,
           record,
           (record->>'updatedAt')::bigint
         FROM latest_incoming AS incoming
         WHERE NOT EXISTS (
           SELECT 1
             FROM anysentry_agent_semantic_kernel_relation_history_v1 AS newer
            WHERE newer.relation_id = incoming.record->>'relationId'
              AND newer.resolution_revision > (incoming.record->>'resolutionRevision')::bigint
         )
         ON CONFLICT (relation_id) DO UPDATE SET
           kernel_event_id = EXCLUDED.kernel_event_id,
           relation_status = EXCLUDED.relation_status,
           resolution_revision = EXCLUDED.resolution_revision,
           record = EXCLUDED.record,
           updated_at = EXCLUDED.updated_at
         WHERE EXCLUDED.resolution_revision >=
           anysentry_agent_semantic_kernel_relations_v1.resolution_revision`,
        [rowsJson],
      );
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client?.query('ROLLBACK').catch(() => undefined);
      this.markUnavailable('save Agent Semantic Kernel relations', error);
      return false;
    } finally {
      client?.release();
    }
  }

  async loadIncidents(): Promise<Incident[]> {
    return this.loadBusinessRecords<Incident>(
      'anysentry_incidents',
      'incident_id',
      INCIDENT_LIMIT,
      (record) => record.incidentId,
      'load Incidents',
    );
  }

  async saveIncidents(records: Incident[]): Promise<boolean> {
    if (records.length === 0) return true;
    return this.saveBusinessRecords(
      records,
      'save Incidents',
      (record) => record.incidentId,
      (client, batch) => this.upsertIncidentRecords(client, batch),
    );
  }

  async loadAlerts(): Promise<AlertRecord[]> {
    return this.loadBusinessRecords<AlertRecord>(
      'anysentry_alerts',
      'alert_id',
      ALERT_LIMIT,
      (record) => record.alertId,
      'load Alerts',
    );
  }

  async saveAlerts(records: AlertRecord[]): Promise<boolean> {
    if (records.length === 0) return true;
    return this.saveBusinessRecords(
      records,
      'save Alerts',
      (record) => record.alertId,
      (client, batch) => this.upsertAlertRecords(client, batch),
    );
  }

  /**
   * Commit the mutable business state and the idempotency ledger in one PostgreSQL transaction.
   *
   * ClickHouse copies are intentionally excluded: they are rebuildable projections and must not
   * turn an analytics failure into a false negative durable receipt.
   */
  async commitBusinessEffect(
    effectKey: string,
    incidents: Incident[],
    alerts: AlertRecord[],
    at = Date.now(),
  ): Promise<boolean> {
    if (!(await this.initialize()) || !this.pool) return false;
    let lastError: unknown;
    for (let attempt = 1; attempt <= BUSINESS_WRITE_MAX_ATTEMPTS; attempt += 1) {
      let client: PoolClient | undefined;
      try {
        client = await this.pool.connect();
        await client.query('BEGIN');
        const lease = await client.query<{ status: string; lease_owner: string | null }>(
          `SELECT status, lease_owner
             FROM anysentry_business_effects
            WHERE effect_key = $1
            FOR UPDATE`,
          [effectKey],
        );
        const row = lease.rows[0];
        if (!row || row.status !== 'pending' || row.lease_owner !== this.effectOwnerId) {
          await client.query('ROLLBACK');
          return false;
        }
        for (let offset = 0; offset < incidents.length; offset += BUSINESS_WRITE_BATCH_SIZE) {
          await this.upsertIncidentRecords(
            client,
            incidents.slice(offset, offset + BUSINESS_WRITE_BATCH_SIZE),
          );
        }
        for (let offset = 0; offset < alerts.length; offset += BUSINESS_WRITE_BATCH_SIZE) {
          await this.upsertAlertRecords(
            client,
            alerts.slice(offset, offset + BUSINESS_WRITE_BATCH_SIZE),
          );
        }
        const completed = await client.query(
          `UPDATE anysentry_business_effects
              SET status = 'applied',
                  lease_expires_at = $3,
                  applied_at = $2,
                  updated_at = $2
            WHERE effect_key = $1
              AND status = 'pending'
              AND lease_owner = $4`,
          [effectKey, at, at, this.effectOwnerId],
        );
        if (completed.rowCount !== 1) throw new Error(`business effect lease lost for ${effectKey}`);
        await client.query('COMMIT');
        return true;
      } catch (error) {
        lastError = error;
        await client?.query('ROLLBACK').catch(() => undefined);
        if (!this.retryableTransactionError(error) || attempt === BUSINESS_WRITE_MAX_ATTEMPTS) break;
        await new Promise((resolve) => setTimeout(resolve, attempt * 50));
      } finally {
        client?.release();
      }
    }
    this.markUnavailable('commit business effect', lastError);
    return false;
  }

  /**
   * Acquire the right to apply one externally visible business effect.
   *
   * The logical key is stable across retries and API replicas. A short lease lets a replay recover
   * work left pending by a crashed process; an applied row is never acquired again.
   */
  async acquireBusinessEffect(
    effectKey: string,
    effectType: string,
    payloadFingerprint: string,
    metadata: Record<string, unknown>,
    at = Date.now(),
  ): Promise<BusinessEffectLease> {
    if (!(await this.initialize()) || !this.pool) return { status: 'unavailable' };
    const leaseExpiresAt = at + EFFECT_LEASE_MS;
    try {
      const inserted = await this.pool.query<{ effect_key: string }>(
        `INSERT INTO anysentry_business_effects (
           effect_key, effect_type, payload_fingerprint, status, lease_owner,
           lease_expires_at, attempts, metadata, created_at_ms, updated_at
         ) VALUES ($1, $2, $3, 'pending', $4, $5, 1, $6::jsonb, $7, $7)
         ON CONFLICT (effect_key) DO NOTHING
         RETURNING effect_key`,
        [
          effectKey,
          effectType,
          payloadFingerprint,
          this.effectOwnerId,
          leaseExpiresAt,
          JSON.stringify(metadata),
          at,
        ],
      );
      if (inserted.rowCount === 1) return { status: 'acquired' };

      const reclaimed = await this.pool.query<{ effect_key: string }>(
        `UPDATE anysentry_business_effects
            SET lease_owner = $2,
                lease_expires_at = $3,
                attempts = attempts + 1,
                updated_at = $4
          WHERE effect_key = $1
            AND status = 'pending'
            AND lease_expires_at < $4
            AND payload_fingerprint = $5
         RETURNING effect_key`,
        [effectKey, this.effectOwnerId, leaseExpiresAt, at, payloadFingerprint],
      );
      if (reclaimed.rowCount === 1) return { status: 'acquired' };

      const existing = await this.pool.query<{
        payload_fingerprint: string;
        status: string;
      }>(
        `SELECT payload_fingerprint, status
           FROM anysentry_business_effects
          WHERE effect_key = $1`,
        [effectKey],
      );
      const row = existing.rows[0];
      if (!row) return { status: 'unavailable' };
      if (row.payload_fingerprint !== payloadFingerprint) {
        return { status: 'conflict', acceptedFingerprint: row.payload_fingerprint };
      }
      // A matching fingerprint is a completed no-op only after the first owner has marked the
      // effect applied. A live pending lease may still fail, so acknowledging a concurrent replay
      // here would create a false durable receipt.
      return row.status === 'applied' ? { status: 'duplicate' } : { status: 'busy' };
    } catch (error) {
      this.markUnavailable('acquire business effect', error);
      return { status: 'unavailable' };
    }
  }

  async completeBusinessEffect(effectKey: string, at = Date.now()): Promise<boolean> {
    if (!(await this.initialize()) || !this.pool) return false;
    try {
      const result = await this.pool.query(
        `UPDATE anysentry_business_effects
            SET status = 'applied',
                lease_expires_at = $3,
                applied_at = $2,
                updated_at = $2
          WHERE effect_key = $1
            AND status = 'pending'
            AND lease_owner = $4`,
        [effectKey, at, at, this.effectOwnerId],
      );
      return result.rowCount === 1;
    } catch (error) {
      this.markUnavailable('complete business effect', error);
      return false;
    }
  }

  async acquireWriterOwnership(
    sourceScope: string,
    writerId: string,
    writerVersion: string,
    protocolVersion: string,
    at = Date.now(),
  ): Promise<WriterOwnership> {
    if (!(await this.initialize()) || !this.pool) return { status: 'unavailable' };
    const cacheKey = `${sourceScope}\0${writerId}`;
    for (const [key, expiresAt] of this.writerOwnershipCache) {
      if (expiresAt > at + 15_000) continue;
      this.writerOwnershipCache.delete(key);
      this.writerOwnershipCacheBytes = Math.max(0, this.writerOwnershipCacheBytes - Buffer.byteLength(key, 'utf8') - 16);
      this.writerOwnershipCacheExpired += 1;
    }
    while (
      this.writerOwnershipCache.size > WRITER_OWNERSHIP_CACHE_MAX_ENTRIES
      || this.writerOwnershipCacheBytes > WRITER_OWNERSHIP_CACHE_MAX_BYTES
    ) {
      const oldest = this.writerOwnershipCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.writerOwnershipCache.delete(oldest);
      this.writerOwnershipCacheBytes = Math.max(0, this.writerOwnershipCacheBytes - Buffer.byteLength(oldest, 'utf8') - 16);
      this.writerOwnershipCacheEvicted += 1;
    }
    if ((this.writerOwnershipCache.get(cacheKey) ?? 0) > at + 15_000) {
      return { status: 'owned' };
    }
    const current = this.writerOwnershipInFlight.get(cacheKey);
    if (current) return current;
    if (this.writerOwnershipInFlight.size >= WRITER_OWNERSHIP_IN_FLIGHT_MAX_ENTRIES) {
      this.writerOwnershipInFlightRejected += 1;
      return { status: 'unavailable' };
    }
    const acquisition = this.acquireWriterOwnershipUncached(
      sourceScope,
      writerId,
      writerVersion,
      protocolVersion,
      cacheKey,
      at,
    );
    let boundedAcquisition: Promise<WriterOwnership>;
    boundedAcquisition = new Promise<WriterOwnership>((resolve) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.writerOwnershipInFlightTimeouts += 1;
        if (this.writerOwnershipInFlight.get(cacheKey) === boundedAcquisition) {
          this.writerOwnershipInFlight.delete(cacheKey);
        }
        resolve({ status: 'unavailable' });
      }, WRITER_OWNERSHIP_IN_FLIGHT_TIMEOUT_MS);
      timeout.unref();
      acquisition.then((value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      }).catch(() => {
        if (settled) return;
        settled = true;
        resolve({ status: 'unavailable' });
      }).finally(() => clearTimeout(timeout));
    });
    this.writerOwnershipInFlight.set(cacheKey, boundedAcquisition);
    try {
      return await boundedAcquisition;
    } finally {
      if (this.writerOwnershipInFlight.get(cacheKey) === boundedAcquisition) {
        this.writerOwnershipInFlight.delete(cacheKey);
      }
    }
  }

  writerOwnershipStats() {
    return {
      entries: this.writerOwnershipCache.size,
      bytes: this.writerOwnershipCacheBytes,
      maxEntries: WRITER_OWNERSHIP_CACHE_MAX_ENTRIES,
      maxBytes: WRITER_OWNERSHIP_CACHE_MAX_BYTES,
      inFlight: this.writerOwnershipInFlight.size,
      inFlightMaxEntries: WRITER_OWNERSHIP_IN_FLIGHT_MAX_ENTRIES,
      expired: this.writerOwnershipCacheExpired,
      evicted: this.writerOwnershipCacheEvicted,
      rejected: this.writerOwnershipInFlightRejected,
      timeouts: this.writerOwnershipInFlightTimeouts,
    };
  }

  private async acquireWriterOwnershipUncached(
    sourceScope: string,
    writerId: string,
    writerVersion: string,
    protocolVersion: string,
    cacheKey: string,
    at: number,
  ): Promise<WriterOwnership> {
    const pool = this.pool;
    if (!pool) return { status: 'unavailable' };
    const leaseMs = positiveInt(
      process.env.ANYSENTRY_WRITER_OWNERSHIP_LEASE_MS,
      90_000,
      15 * 60_000,
    );
    const leaseExpiresAt = at + leaseMs;
    try {
      const result = await pool.query<{
        writer_id: string;
        lease_expires_at: string | number;
      }>(
        `INSERT INTO anysentry_writer_ownership (
           source_scope, writer_id, writer_version, protocol_version,
           lease_expires_at, first_seen_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $6)
         ON CONFLICT (source_scope) DO UPDATE SET
           writer_id = EXCLUDED.writer_id,
           writer_version = EXCLUDED.writer_version,
           protocol_version = EXCLUDED.protocol_version,
           lease_expires_at = EXCLUDED.lease_expires_at,
           updated_at = EXCLUDED.updated_at
         WHERE anysentry_writer_ownership.writer_id = EXCLUDED.writer_id
            OR anysentry_writer_ownership.lease_expires_at < EXCLUDED.updated_at
         RETURNING writer_id, lease_expires_at`,
        [sourceScope, writerId, writerVersion, protocolVersion, leaseExpiresAt, at],
      );
      const row = result.rows[0];
      if (row?.writer_id === writerId) {
        const previous = this.writerOwnershipCache.get(cacheKey);
        if (previous !== undefined) {
          this.writerOwnershipCache.delete(cacheKey);
          this.writerOwnershipCacheBytes = Math.max(
            0,
            this.writerOwnershipCacheBytes - Buffer.byteLength(cacheKey, 'utf8') - 16,
          );
        }
        this.writerOwnershipCache.set(cacheKey, Number(row.lease_expires_at));
        this.writerOwnershipCacheBytes += Buffer.byteLength(cacheKey, 'utf8') + 16;
        while (
          this.writerOwnershipCache.size > WRITER_OWNERSHIP_CACHE_MAX_ENTRIES
          || this.writerOwnershipCacheBytes > WRITER_OWNERSHIP_CACHE_MAX_BYTES
        ) {
          const oldest = this.writerOwnershipCache.keys().next().value as string | undefined;
          if (oldest === undefined) break;
          this.writerOwnershipCache.delete(oldest);
          this.writerOwnershipCacheBytes = Math.max(
            0,
            this.writerOwnershipCacheBytes - Buffer.byteLength(oldest, 'utf8') - 16,
          );
          this.writerOwnershipCacheEvicted += 1;
        }
        return { status: 'owned' };
      }
      const existing = await pool.query<{
        writer_id: string;
        lease_expires_at: string | number;
      }>(
        `SELECT writer_id, lease_expires_at
           FROM anysentry_writer_ownership
          WHERE source_scope = $1`,
        [sourceScope],
      );
      const owner = existing.rows[0];
      return owner
        ? {
            status: 'conflict',
            ownerWriterId: owner.writer_id,
            leaseExpiresAt: Number(owner.lease_expires_at),
          }
        : { status: 'unavailable' };
    } catch (error) {
      this.markUnavailable('acquire Writer ownership', error);
      return { status: 'unavailable' };
    }
  }

  async loadRemediations(): Promise<RemediationRecord[]> {
    return this.loadBusinessRecords<RemediationRecord>(
      'anysentry_remediations',
      'task_id',
      REMEDIATION_LIMIT,
      (record) => record.taskId,
      'load Remediations',
    );
  }

  async saveRemediations(records: RemediationRecord[]): Promise<boolean> {
    if (records.length === 0) return true;
    return this.saveBusinessRecords(
      records,
      'save Remediations',
      (record) => record.taskId,
      async (client, batch) => {
        await client.query(
          `WITH incoming AS (
             SELECT
               item AS record,
               item->>'taskId' AS task_id,
               item->>'sourceType' AS source_type,
               COALESCE(item->>'sourceId', '') AS source_id,
               item->>'status' AS status,
               item->>'severity' AS severity,
               (item->>'createdAt')::bigint AS created_at_ms,
               (item->>'updatedAt')::bigint AS updated_at
             FROM jsonb_array_elements($1::jsonb) AS source(item)
           )
           INSERT INTO anysentry_remediations (
             task_id,
             source_type,
             source_id,
             status,
             severity,
             record,
             created_at_ms,
             updated_at
           )
           SELECT
             task_id,
             source_type,
             source_id,
             status,
             severity,
             record,
             created_at_ms,
             updated_at
           FROM incoming
           ON CONFLICT (task_id) DO UPDATE SET
             source_type = EXCLUDED.source_type,
             source_id = EXCLUDED.source_id,
             status = EXCLUDED.status,
             severity = EXCLUDED.severity,
             record = EXCLUDED.record,
             created_at_ms = LEAST(anysentry_remediations.created_at_ms, EXCLUDED.created_at_ms),
             updated_at = EXCLUDED.updated_at
           WHERE EXCLUDED.updated_at >= anysentry_remediations.updated_at
             AND (anysentry_remediations.record IS DISTINCT FROM EXCLUDED.record
               OR EXCLUDED.updated_at > anysentry_remediations.updated_at
               OR EXCLUDED.created_at_ms < anysentry_remediations.created_at_ms)`,
          [JSON.stringify(batch)],
        );
      },
    );
  }

  async loadIngestionSources(): Promise<IngestionSourceRecord[]> {
    return this.loadSimpleBusinessRecords(
      'anysentry_ingestion_sources',
      'source_id',
      (record: IngestionSourceRecord) => record.sourceId,
      'load Ingestion Sources',
    );
  }

  async saveIngestionSources(records: IngestionSourceRecord[]): Promise<boolean> {
    return this.saveSimpleBusinessRecords(
      'anysentry_ingestion_sources',
      'source_id',
      'sourceId',
      records,
      (record) => record.sourceId,
      'save Ingestion Sources',
    );
  }

  async loadMaintenanceWindows(): Promise<MaintenanceWindowRecord[]> {
    return this.loadSimpleBusinessRecords(
      'anysentry_maintenance_windows',
      'window_id',
      (record: MaintenanceWindowRecord) => record.windowId,
      'load Maintenance Windows',
    );
  }

  async saveMaintenanceWindows(records: MaintenanceWindowRecord[]): Promise<boolean> {
    return this.saveSimpleBusinessRecords(
      'anysentry_maintenance_windows',
      'window_id',
      'windowId',
      records,
      (record) => record.windowId,
      'save Maintenance Windows',
    );
  }

  async loadNotificationChannels(): Promise<NotificationChannelRecord[]> {
    return this.loadSimpleBusinessRecords(
      'anysentry_notification_channels',
      'channel_id',
      (record: NotificationChannelRecord) => record.channelId,
      'load Notification Channels',
    );
  }

  async saveNotificationChannels(records: NotificationChannelRecord[]): Promise<boolean> {
    return this.saveSimpleBusinessRecords(
      'anysentry_notification_channels',
      'channel_id',
      'channelId',
      records,
      (record) => record.channelId,
      'save Notification Channels',
    );
  }

  async loadNotificationRoutes(): Promise<NotificationRouteRecord[]> {
    return this.loadSimpleBusinessRecords(
      'anysentry_notification_routes',
      'route_id',
      (record: NotificationRouteRecord) => record.routeId,
      'load Notification Routes',
    );
  }

  async saveNotificationRoutes(records: NotificationRouteRecord[]): Promise<boolean> {
    return this.saveSimpleBusinessRecords(
      'anysentry_notification_routes',
      'route_id',
      'routeId',
      records,
      (record) => record.routeId,
      'save Notification Routes',
    );
  }

  async loadObjectives(): Promise<ObjectiveRecord[]> {
    return this.loadSimpleBusinessRecords(
      'anysentry_objectives',
      'objective_id',
      (record: ObjectiveRecord) => record.objectiveId,
      'load Objectives',
    );
  }

  async saveObjectives(records: ObjectiveRecord[]): Promise<boolean> {
    return this.saveSimpleBusinessRecords(
      'anysentry_objectives',
      'objective_id',
      'objectiveId',
      records,
      (record) => record.objectiveId,
      'save Objectives',
    );
  }

  async loadPlatformUsers(): Promise<PlatformUserRecord[]> {
    return this.loadSimpleBusinessRecords(
      'anysentry_platform_users',
      'user_id',
      (record: PlatformUserRecord) => record.userId,
      'load Platform Users',
    );
  }

  async savePlatformUsers(records: PlatformUserRecord[]): Promise<boolean> {
    return this.saveSimpleBusinessRecords(
      'anysentry_platform_users',
      'user_id',
      'userId',
      records,
      (record) => record.userId,
      'save Platform Users',
    );
  }

  async loadPolicyConfig(): Promise<{ config: PolicyConfig; updatedAt: number } | undefined> {
    if (!(await this.initialize()) || !this.pool) return undefined;
    try {
      const result = await this.pool.query<{
        record: PolicyConfig | string;
        updated_at: string | number;
      }>(
        `SELECT record, updated_at
           FROM anysentry_platform_configs
          WHERE config_key = 'judge_policy'`,
      );
      const row = result.rows[0];
      const config = row ? this.parseRecord<PolicyConfig>(row.record) : undefined;
      return config ? { config, updatedAt: Number(row.updated_at) } : undefined;
    } catch (error) {
      this.markUnavailable('load Policy Config', error);
      return undefined;
    }
  }

  async savePolicyConfig(config: PolicyConfig, updatedAt = Date.now()): Promise<boolean> {
    if (!(await this.initialize()) || !this.pool) return false;
    try {
      await this.pool.query(
        `INSERT INTO anysentry_platform_configs (config_key, record, updated_at)
         VALUES ('judge_policy', $1::jsonb, $2)
         ON CONFLICT (config_key) DO UPDATE SET
           record = EXCLUDED.record,
           updated_at = EXCLUDED.updated_at
         WHERE EXCLUDED.updated_at >= anysentry_platform_configs.updated_at`,
        [JSON.stringify(config), updatedAt],
      );
      return true;
    } catch (error) {
      this.markUnavailable('save Policy Config', error);
      return false;
    }
  }

  async loadPlatformConfig<T>(configKey: string): Promise<{ record: T; updatedAt: number } | undefined> {
    if (!(await this.initialize()) || !this.pool) return undefined;
    try {
      const result = await this.pool.query<{
        record: T | string;
        updated_at: string | number;
      }>(
        `SELECT record, updated_at
           FROM anysentry_platform_configs
          WHERE config_key = $1`,
        [configKey.slice(0, 160)],
      );
      const row = result.rows[0];
      const record = row ? this.parseRecord<T>(row.record) : undefined;
      return record ? { record, updatedAt: Number(row.updated_at) } : undefined;
    } catch (error) {
      this.markUnavailable(`load Platform Config ${configKey}`, error);
      return undefined;
    }
  }

  async savePlatformConfig<T>(configKey: string, record: T, updatedAt = Date.now()): Promise<boolean> {
    if (!(await this.initialize()) || !this.pool) return false;
    try {
      await this.pool.query(
        `INSERT INTO anysentry_platform_configs (config_key, record, updated_at)
         VALUES ($1, $2::jsonb, $3)
         ON CONFLICT (config_key) DO UPDATE SET
           record = EXCLUDED.record,
           updated_at = EXCLUDED.updated_at
         WHERE EXCLUDED.updated_at >= anysentry_platform_configs.updated_at`,
        [configKey.slice(0, 160), JSON.stringify(record), updatedAt],
      );
      return true;
    } catch (error) {
      this.markUnavailable(`save Platform Config ${configKey}`, error);
      return false;
    }
  }

  async compareAndSwapPlatformConfig<T extends { globalRevision?: number }>(
    configKey: string,
    expectedGlobalRevision: number,
    record: T,
    updatedAt = Date.now(),
  ): Promise<'saved' | 'conflict' | 'unavailable'> {
    if (!(await this.initialize()) || !this.pool) return 'unavailable';
    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect();
      await client.query('BEGIN');
      // A missing row cannot be protected by SELECT ... FOR UPDATE. Serialize the first insert and
      // all later revisions on the logical config key as well.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [configKey.slice(0, 160)]);
      const current = await client.query<{ record: T | string }>(
        `SELECT record FROM anysentry_platform_configs WHERE config_key = $1 FOR UPDATE`,
        [configKey.slice(0, 160)],
      );
      const parsed = current.rows[0] ? this.parseRecord<T>(current.rows[0].record) : undefined;
      const currentRevision = Number(parsed?.globalRevision) || 0;
      if (currentRevision !== expectedGlobalRevision) {
        await client.query('ROLLBACK');
        return 'conflict';
      }
      await client.query(
        `INSERT INTO anysentry_platform_configs (config_key, record, updated_at)
         VALUES ($1, $2::jsonb, $3)
         ON CONFLICT (config_key) DO UPDATE SET
           record = EXCLUDED.record,
           updated_at = EXCLUDED.updated_at`,
        [configKey.slice(0, 160), JSON.stringify(record), updatedAt],
      );
      await client.query('COMMIT');
      return 'saved';
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => undefined);
      this.markUnavailable(`compare-and-swap Platform Config ${configKey}`, error);
      return 'unavailable';
    } finally {
      client?.release();
    }
  }

  async saveInteractionMetadata(record: InteractionRecord): Promise<boolean> {
    return this.saveInteractionMetadataBatch([record]);
  }

  async saveInteractionMetadataBatch(
    records: readonly InteractionRecord[],
  ): Promise<boolean> {
    if (records.length === 0) return true;
    if (!(await this.initialize()) || !this.pool) return false;
    const projectedAt = Date.now();
    const unique = new Map<
      string,
      { record: InteractionRecord; fingerprint: string }
    >();
    for (const record of records) {
      const fingerprint = interactionPayloadFingerprint(record);
      const previous = unique.get(record.interactionId);
      if (previous && previous.fingerprint !== fingerprint) {
        this.logger.error(
          `Interaction immutable-key conflict inside projection batch: `
          + `${record.sourceId}/${record.sourceEventId}`,
        );
        return false;
      }
      if (!previous) unique.set(record.interactionId, { record, fingerprint });
    }
    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect();
      await client.query('BEGIN');
      const rows = [...unique.values()];
      for (let offset = 0; offset < rows.length; offset += BUSINESS_WRITE_BATCH_SIZE) {
        const chunk = rows.slice(offset, offset + BUSINESS_WRITE_BATCH_SIZE);
        const payload = chunk.map(({ record, fingerprint }) => ({
          interaction_id: record.interactionId,
          conversation_id: record.conversationId,
          source_id: record.sourceId,
          source_event_id: record.sourceEventId,
          collector_id: record.collectorId,
          tenant_id: record.tenantId,
          environment_id: record.environmentId ?? null,
          agent_instance_id: record.agentInstanceId ?? null,
          process_instance_id: record.processInstanceId,
          workspace_path: record.workspacePath ?? null,
          provider:
            record.eventType === 'LlmTransportObserved'
              ? record.transport.provider ?? null
              : null,
          observed_at: record.observedAt,
          accepted_at: record.acceptedAt,
          projected_at: projectedAt,
          payload_fingerprint: fingerprint,
          record: { ...record, projectedAt },
        }));
        const result = await client.query<{ applied: string | number }>(
          `WITH incoming AS (
             SELECT *
               FROM jsonb_to_recordset($1::jsonb) AS value(
                 interaction_id text,
                 conversation_id text,
                 source_id text,
                 source_event_id text,
                 collector_id text,
                 tenant_id text,
                 environment_id text,
                 agent_instance_id text,
                 process_instance_id text,
                 workspace_path text,
                 provider text,
                 observed_at bigint,
                 accepted_at bigint,
                 projected_at bigint,
                 payload_fingerprint text,
                 record jsonb
               )
           ),
           applied AS (
             INSERT INTO anysentry_interaction_metadata (
               interaction_id,
               conversation_id,
               source_id,
               source_event_id,
               collector_id,
               tenant_id,
               environment_id,
               agent_instance_id,
               process_instance_id,
               workspace_path,
               provider,
               observed_at,
               accepted_at,
               projected_at,
               payload_fingerprint,
               record
             )
             SELECT
               interaction_id,
               conversation_id,
               source_id,
               source_event_id,
               collector_id,
               tenant_id,
               environment_id,
               agent_instance_id,
               process_instance_id,
               workspace_path,
               provider,
               observed_at,
               accepted_at,
               projected_at,
               payload_fingerprint,
               record
             FROM incoming
             ON CONFLICT (interaction_id) DO UPDATE SET
               projected_at = GREATEST(
                 anysentry_interaction_metadata.projected_at,
                 EXCLUDED.projected_at
               )
             WHERE anysentry_interaction_metadata.payload_fingerprint =
                   EXCLUDED.payload_fingerprint
             RETURNING interaction_id
           )
           SELECT count(*) AS applied FROM applied`,
          [JSON.stringify(payload)],
        );
        if (Number(result.rows[0]?.applied ?? 0) !== chunk.length) {
          await client.query('ROLLBACK');
          this.logger.error('Interaction immutable-key conflict in PostgreSQL projection');
          return false;
        }
      }
      await client.query('COMMIT');
      return true;
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => undefined);
      this.markUnavailable('save Interaction metadata projection', error);
      return false;
    } finally {
      client?.release();
    }
  }

  async reserveInteractionReceipt(
    record: InteractionRecord,
  ): Promise<InteractionReceiptReservation> {
    if (!(await this.initialize()) || !this.pool) return { state: 'unavailable' };
    const fingerprint = interactionPayloadFingerprint(record);
    try {
      const result = await this.pool.query<{
        payload_fingerprint: string;
        status: 'pending' | 'accepted';
        accepted_at: string | number;
        inserted: boolean;
      }>(
        `INSERT INTO anysentry_interaction_receipts (
           source_id,
           source_event_id,
           interaction_id,
           conversation_id,
           payload_fingerprint,
           status,
           accepted_at,
           updated_at
         ) VALUES ($1, $2, $3, $4, $5, 'pending', $6, $6)
         ON CONFLICT (source_id, source_event_id) DO UPDATE SET
           updated_at = anysentry_interaction_receipts.updated_at
         WHERE anysentry_interaction_receipts.payload_fingerprint =
               EXCLUDED.payload_fingerprint
         RETURNING
           payload_fingerprint,
           status,
           accepted_at,
           (xmax = 0) AS inserted`,
        [
          record.sourceId,
          record.sourceEventId,
          record.interactionId,
          record.conversationId,
          fingerprint,
          record.acceptedAt,
        ],
      );
      const row = result.rows[0];
      if (!row) {
        this.logger.error(
          `Interaction immutable-key conflict rejected before Kafka: `
          + `${record.sourceId}/${record.sourceEventId}`,
        );
        return { state: 'conflict' };
      }
      return {
        state: row.inserted ? 'new' : row.status,
        acceptedAt: Number(row.accepted_at),
      };
    } catch (error) {
      this.markUnavailable('reserve Interaction durable receipt', error);
      return { state: 'unavailable' };
    }
  }

  async markInteractionReceiptAccepted(
    record: InteractionRecord,
  ): Promise<boolean> {
    if (!(await this.initialize()) || !this.pool) return false;
    const fingerprint = interactionPayloadFingerprint(record);
    try {
      const result = await this.pool.query(
        `UPDATE anysentry_interaction_receipts
            SET status = 'accepted',
                updated_at = $4
          WHERE source_id = $1
            AND source_event_id = $2
            AND payload_fingerprint = $3`,
        [record.sourceId, record.sourceEventId, fingerprint, Date.now()],
      );
      return result.rowCount === 1;
    } catch (error) {
      this.markUnavailable('mark Interaction durable receipt accepted', error);
      return false;
    }
  }

  async loadInteractionMetadata(query: {
    limit: number;
    collectorId?: string;
    agentInstanceId?: string;
    workspacePath?: string;
    since?: number;
    until?: number;
    conversationId?: string;
  }): Promise<InteractionRecord[] | null> {
    if (!(await this.initialize()) || !this.pool) return null;
    const filters: string[] = [];
    const values: unknown[] = [];
    const bind = (value: unknown): string => {
      values.push(value);
      return `$${values.length}`;
    };
    if (query.collectorId) filters.push(`collector_id = ${bind(query.collectorId)}`);
    if (query.agentInstanceId) {
      filters.push(`agent_instance_id = ${bind(query.agentInstanceId)}`);
    }
    if (query.workspacePath) filters.push(`workspace_path = ${bind(query.workspacePath)}`);
    if (query.since) filters.push(`observed_at >= ${bind(query.since)}`);
    if (query.until) filters.push(`observed_at <= ${bind(query.until)}`);
    if (query.conversationId) {
      filters.push(`conversation_id = ${bind(query.conversationId)}`);
    }
    values.push(Math.max(1, Math.min(10_000, Math.trunc(query.limit))));
    try {
      const result = await this.pool.query<{ record: InteractionRecord | string }>(
        `SELECT record
           FROM anysentry_interaction_metadata
          ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
          ORDER BY observed_at DESC, interaction_id ASC
          LIMIT $${values.length}`,
        values,
      );
      return result.rows
        .map(({ record }) => this.parseRecord<InteractionRecord>(record))
        .filter(
          (record): record is InteractionRecord =>
            Boolean(record?.interactionId && record.conversationId),
        );
    } catch (error) {
      this.markUnavailable('load Interaction metadata projection', error);
      return null;
    }
  }

  async saveSessionProcessBindings(
    records: readonly SessionProcessBinding[],
  ): Promise<boolean> {
    if (records.length === 0) return true;
    return this.saveBusinessRecords(
      [...records],
      'save Session Process bindings',
      (record) => record.bindingId,
      async (client, batch) => {
        await client.query(
          `WITH incoming AS (
             SELECT
               item AS record,
               item->>'bindingId' AS binding_id,
               (item->>'bindingRevision')::bigint AS binding_revision,
               (item->>'observedAt')::bigint AS observed_at
             FROM jsonb_array_elements($1::jsonb) AS source(item)
           )
           INSERT INTO anysentry_session_process_binding_revisions (
             binding_id, binding_revision, observed_at, record
           )
           SELECT binding_id, binding_revision, observed_at, record
           FROM incoming
           ON CONFLICT (binding_id, binding_revision) DO NOTHING`,
          [JSON.stringify(batch)],
        );
        await client.query(
          `WITH incoming AS (
             SELECT
               item AS record,
               item->>'bindingId' AS binding_id,
               item->>'conversationId' AS conversation_id,
               item->>'nativeSessionId' AS native_session_id,
               item->>'hostId' AS host_id,
               item->>'bootId' AS boot_id,
               item->>'collectorId' AS collector_id,
               item->>'matchedOsProcessInstanceKey' AS process_instance_key,
               (item->>'bindingRevision')::bigint AS binding_revision,
               (item->>'validFrom')::bigint AS valid_from,
               NULLIF(item->>'validTo', '')::bigint AS valid_to,
               (item->>'observedAt')::bigint AS observed_at
             FROM jsonb_array_elements($1::jsonb) AS source(item)
           )
           INSERT INTO anysentry_session_process_bindings (
             binding_id, conversation_id, native_session_id, host_id, boot_id,
             collector_id, process_instance_key, binding_revision, valid_from,
             valid_to, observed_at, record
           )
           SELECT binding_id, conversation_id, native_session_id, host_id, boot_id,
             collector_id, process_instance_key, binding_revision, valid_from,
             valid_to, observed_at, record
           FROM incoming
           ON CONFLICT (binding_id) DO UPDATE SET
             conversation_id = EXCLUDED.conversation_id,
             binding_revision = EXCLUDED.binding_revision,
             valid_from = LEAST(anysentry_session_process_bindings.valid_from, EXCLUDED.valid_from),
             valid_to = EXCLUDED.valid_to,
             observed_at = EXCLUDED.observed_at,
             record = EXCLUDED.record
           WHERE EXCLUDED.binding_revision >= anysentry_session_process_bindings.binding_revision`,
          [JSON.stringify(batch)],
        );
      },
    );
  }

  async loadLatestSessionProcessBinding(
    bindingId: string,
  ): Promise<SessionProcessBinding | undefined | null> {
    if (!(await this.initialize()) || !this.pool) return null;
    try {
      const result = await this.pool.query<{ record: SessionProcessBinding | string }>(
        `SELECT record
           FROM anysentry_session_process_bindings
          WHERE binding_id = $1
          LIMIT 1`,
        [bindingId],
      );
      return this.parseRecord<SessionProcessBinding>(result.rows[0]?.record);
    } catch (error) {
      this.markUnavailable('load latest Session Process binding', error);
      return null;
    }
  }

  async loadSessionProcessBindingForGeneration(query: {
    nativeSessionId: string;
    runtimeType: string;
    matchedPid: number;
    matchedStartTime: string;
    method: SessionProcessBinding['method'];
    hostId?: string;
    bootId?: string;
    pidNamespace?: string;
    tenantId?: string;
    environmentId?: string;
    collectorId?: string;
  }): Promise<SessionProcessBinding | undefined | null> {
    if (!(await this.initialize()) || !this.pool) return null;
    try {
      const result = await this.pool.query<{ record: SessionProcessBinding | string }>(
        `SELECT record
           FROM anysentry_session_process_bindings
          WHERE native_session_id = $1
            AND record->>'runtimeType' = $2
            AND record->>'matchedPid' = $3
            AND record->>'matchedStartTime' = $4
            AND record->>'method' = $5
            AND ($6::text IS NULL OR host_id = $6)
            AND ($7::text IS NULL OR boot_id = $7)
            AND ($8::text IS NULL OR record->>'pidNamespace' = $8)
            AND ($9::text IS NULL OR record->>'tenantId' = $9)
            AND ($10::text IS NULL OR record->>'environmentId' = $10)
            AND ($11::text IS NULL OR collector_id = $11)
          ORDER BY (COALESCE(record->>'pidNamespace', '') <> '') DESC,
            observed_at DESC, binding_revision DESC
          LIMIT 33`,
        [
          query.nativeSessionId,
          query.runtimeType,
          String(query.matchedPid),
          query.matchedStartTime,
          query.method,
          query.hostId ?? null,
          query.bootId ?? null,
          query.pidNamespace ?? null,
          query.tenantId ?? null,
          query.environmentId ?? null,
          query.collectorId ?? null,
        ],
      );
      if (result.rows.length >= 33) return undefined;
      const records = result.rows.map(row => this.parseRecord<SessionProcessBinding>(row.record))
        .filter((item): item is SessionProcessBinding => Boolean(item));
      const complete = records.filter(item => Boolean(item.pidNamespace));
      // Duplicate historical weak bindings must not outrank a complete generation. Multiple
      // complete scopes are genuinely ambiguous; let lifecycle resolution disambiguate instead.
      if (new Set(complete.map(item => JSON.stringify([
        item.hostId, item.bootId, item.pidNamespace, item.matchedOsProcessInstanceKey,
        item.tenantId, item.environmentId, item.collectorId,
      ]))).size > 1) return undefined;
      return complete[0] ?? records[0];
    } catch (error) {
      this.markUnavailable('load Session Process binding by generation', error);
      return null;
    }
  }

  async loadSessionProcessBindings(query: {
    hostId: string;
    bootId: string;
    since: number;
    until: number;
    collectorId?: string;
  }): Promise<SessionProcessBinding[] | null> {
    if (!(await this.initialize()) || !this.pool) return null;
    const values: unknown[] = [query.hostId, query.bootId, query.until, query.since];
    const collectorClause = query.collectorId
      ? `AND collector_id = $${values.push(query.collectorId)}`
      : '';
    try {
      const result = await this.pool.query<{ record: SessionProcessBinding | string }>(
        `SELECT record
           FROM anysentry_session_process_bindings
          WHERE host_id = $1
            AND boot_id = $2
            AND valid_from <= $3
            AND (valid_to IS NULL OR valid_to >= $4)
            ${collectorClause}
          ORDER BY valid_from, binding_id
          LIMIT 5001`,
        values,
      );
      // Truncation is incomplete ownership context, not evidence of no competitor.
      if (result.rows.length > 5000) return null;
      return result.rows
        .map(({ record }) => this.parseRecord<SessionProcessBinding>(record))
        .filter((record): record is SessionProcessBinding => Boolean(record?.bindingId));
    } catch (error) {
      this.markUnavailable('load Session Process bindings', error);
      return null;
    }
  }

  /**
   * Load the durable OS generations previously bound to one Native Session. This is the
   * historical-detail path: it deliberately does not depend on a currently live /proc match,
   * because a Session can be resumed after Observer capture has stopped.
   */
  async loadSessionProcessBindingsForNativeSession(query: {
    nativeSessionId: string;
    runtimeType: string;
    limit?: number;
  }): Promise<SessionProcessBinding[] | null> {
    if (!(await this.initialize()) || !this.pool) return null;
    const rowLimit = Math.max(1, Math.min(128, Math.trunc(query.limit ?? 64)));
    try {
      const result = await this.pool.query<{ record: SessionProcessBinding | string }>(
        `SELECT record
           FROM anysentry_session_process_bindings
          WHERE native_session_id = $1
            AND record->>'runtimeType' = $2
          ORDER BY observed_at DESC, binding_revision DESC, binding_id
          LIMIT $3`,
        [query.nativeSessionId, query.runtimeType, rowLimit],
      );
      return result.rows
        .map(({ record }) => this.parseRecord<SessionProcessBinding>(record))
        .filter((record): record is SessionProcessBinding => Boolean(
          record?.bindingId
          && record.nativeSessionId === query.nativeSessionId
          && record.runtimeType === query.runtimeType,
        ));
    } catch (error) {
      this.markUnavailable('load Session Process bindings by Native Session', error);
      return null;
    }
  }

  /**
   * Read already-materialized historical ownership without recomputing the process tree. Active
   * rows are audit-approved relations; DISTINCT ON prevents an older Binding Revision for the
   * same event from appearing beside its newer replacement.
   */
  async loadHistoricalEventSessionRelations(query: {
    bindingId: string;
    conversationId: string;
    limit: number;
    since: number;
    until: number;
  }): Promise<EventSessionRelation[] | null> {
    if (!(await this.initialize()) || !this.pool) return null;
    const rowLimit = Math.max(1, Math.min(5_000, Math.trunc(query.limit)));
    try {
      const result = await this.pool.query<{ record: EventSessionRelation | string }>(
        `WITH latest AS (
           SELECT DISTINCT ON (record->>'eventId') record
             FROM anysentry_event_session_relations
            WHERE record->>'bindingId' = $1
              AND record->>'conversationId' = $2
              AND COALESCE((record->>'active')::boolean, true)
              AND (record->>'attributionVersion')::integer = $4
              AND record ? 'eventAt'
              AND record->>'eventAt' ~ '^[0-9]+$'
              AND (record->>'eventAt')::bigint BETWEEN $5 AND $6
            ORDER BY record->>'eventId',
              (record->>'bindingRevision')::bigint DESC,
              (record->>'effectiveFrom')::bigint DESC,
              updated_at DESC
         )
         SELECT record
           FROM latest
          ORDER BY (record->>'eventAt')::bigint DESC, record->>'eventId'
          LIMIT $3`,
        [query.bindingId, query.conversationId, rowLimit,
          SESSION_EVENT_ATTRIBUTION_VERSION, query.since, query.until],
      );
      return result.rows
        .map(({ record }) => this.parseRecord<EventSessionRelation>(record))
        .filter((record): record is EventSessionRelation => Boolean(
          record?.relationId
          && Number.isSafeInteger(record.eventAt)
          && (record.relation === 'DIRECT' || record.relation === 'LINEAGE'),
        ));
    } catch (error) {
      this.markUnavailable('load historical Event Session relations', error);
      return null;
    }
  }

  /**
   * Bindings whose older relations were invalidated by an attribution-version upgrade and still
   * lack any active relation. Used by the explicit historical backfill, not by interactive reads.
   */
  async loadBindingsNeedingReattribution(limit = 32): Promise<SessionProcessBinding[] | null> {
    if (!(await this.initialize()) || !this.pool) return null;
    const rowLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    try {
      const result = await this.pool.query<{ record: SessionProcessBinding | string }>(
        `WITH need AS (
           SELECT DISTINCT record->>'bindingId' AS binding_id
             FROM anysentry_event_session_relations
            WHERE COALESCE((record->>'requiresReattribution')::boolean, false)
         ),
         active AS (
           SELECT DISTINCT record->>'bindingId' AS binding_id
             FROM anysentry_event_session_relations
            WHERE COALESCE((record->>'active')::boolean, true)
         ),
         pending AS (
           SELECT need.binding_id
             FROM need
             LEFT JOIN active USING (binding_id)
            WHERE active.binding_id IS NULL
         )
         SELECT b.record
           FROM anysentry_session_process_bindings b
           JOIN pending ON pending.binding_id = b.binding_id
          ORDER BY b.observed_at DESC NULLS LAST, b.binding_id
          LIMIT $1`,
        [rowLimit],
      );
      return result.rows
        .map(({ record }) => this.parseRecord<SessionProcessBinding>(record))
        .filter((record): record is SessionProcessBinding => Boolean(record?.bindingId));
    } catch (error) {
      this.markUnavailable('load bindings needing reattribution', error);
      return null;
    }
  }

  async saveProcessLineageEdges(records: readonly ProcessLineageEdge[]): Promise<boolean> {
    return this.saveAttributionRecords(
      'anysentry_process_lineage_edges',
      'edge_id',
      'edgeId',
      [...records],
      (record) => record.edgeId,
      'save Process lineage edges',
    );
  }

  async saveEventSessionAttributionResults(
    records: readonly EventSessionAttributionResult[],
  ): Promise<boolean> {
    return this.saveAttributionRecords(
      'anysentry_event_session_attribution_results',
      'result_id',
      'resultId',
      [...records],
      (record) => record.resultId,
      'save Event Session attribution results',
    );
  }

  async saveEventSessionRelations(records: readonly EventSessionRelation[]): Promise<boolean> {
    if (records.some((record) => record.relation !== 'DIRECT' && record.relation !== 'LINEAGE')) {
      return false;
    }
    return this.saveAttributionRecords(
      'anysentry_event_session_relations',
      'relation_id',
      'relationId',
      [...records],
      (record) => record.relationId,
      'save Event Session relations',
    );
  }

  /**
   * Interactive System Evidence prefers durable relations already written by the background
   * reconciler. Returning null means "store unavailable / incomplete"; an empty array means no
   * active relations exist yet for this binding and the caller should fall back to a live walk.
   */
  async loadActiveEventSessionRelations(query: {
    bindingId: string;
    conversationId: string;
    limit: number;
    since: number;
    until: number;
    bindingRevision: number;
    bindingContextHash: string;
    timeWindows?: readonly { sinceMs: number; untilMs: number }[];
  }): Promise<EventSessionRelation[] | null> {
    if (!(await this.initialize()) || !this.pool) return null;
    const rowLimit = Math.max(1, Math.min(5_000, Math.trunc(query.limit)));
    try {
      const result = await this.pool.query<{ record: EventSessionRelation | string }>(
        `SELECT record
           FROM anysentry_event_session_relations
          WHERE record->>'bindingId' = $1
            AND record->>'conversationId' = $2
            AND COALESCE((record->>'active')::boolean, true)
            AND (record->>'attributionVersion')::integer = $4
            AND record->>'bindingContextHash' = $5
            AND (record->>'bindingRevision')::bigint = $6
            AND (record->>'eventAt')::bigint BETWEEN $7 AND $8
            AND ($9::jsonb = '[]'::jsonb OR EXISTS (
              SELECT 1 FROM jsonb_array_elements($9::jsonb) w
              WHERE (record->>'eventAt')::bigint BETWEEN
                (w->>'sinceMs')::bigint AND (w->>'untilMs')::bigint
            ))
          ORDER BY (record->>'eventAt')::bigint DESC, relation_id ASC
          LIMIT $3`,
        [query.bindingId, query.conversationId, rowLimit, SESSION_EVENT_ATTRIBUTION_VERSION,
          query.bindingContextHash, query.bindingRevision, query.since, query.until,
          JSON.stringify(query.timeWindows ?? [])],
      );
      return result.rows
        .map(({ record }) => this.parseRecord<EventSessionRelation>(record))
        .filter((record): record is EventSessionRelation => {
          if (!record?.relationId) return false;
          return record.relation === 'DIRECT' || record.relation === 'LINEAGE';
        });
    } catch (error) {
      this.markUnavailable('load active Event Session relations', error);
      return null;
    }
  }

  async loadProcessLineageEdgesForProcesses(
    processInstanceKeys: readonly string[],
    limit = 2_000,
  ): Promise<ProcessLineageEdge[] | null> {
    if (!(await this.initialize()) || !this.pool) return null;
    const keys = [...new Set(processInstanceKeys.map((item) => item.trim()).filter(Boolean))];
    if (keys.length === 0) return [];
    const rowLimit = Math.max(1, Math.min(5_000, Math.trunc(limit)));
    try {
      const result = await this.pool.query<{ record: ProcessLineageEdge | string }>(
        `SELECT record
           FROM anysentry_process_lineage_edges
          WHERE record->>'parentProcessInstanceKey' = ANY($1::text[])
             OR record->>'childProcessInstanceKey' = ANY($1::text[])
          ORDER BY updated_at DESC, edge_id ASC
          LIMIT $2`,
        [keys, rowLimit],
      );
      return result.rows
        .map(({ record }) => this.parseRecord<ProcessLineageEdge>(record))
        .filter((record): record is ProcessLineageEdge => Boolean(record?.edgeId));
    } catch (error) {
      this.markUnavailable('load Process lineage edges', error);
      return null;
    }
  }

  /**
   * Keep prior definite relations as audit history while preventing them from remaining effective
   * after a newer attribution calculation becomes ambiguous, conflicting, or unattributed.
   */
  async reconcileEventSessionRelations(
    results: readonly EventSessionAttributionResult[],
    activeRelations: readonly EventSessionRelation[],
    calculatedAt: number,
  ): Promise<boolean> {
    if (results.length === 0) return true;
    if (!(await this.initialize()) || !this.pool) return false;
    const decisions = [...new Map(results.map((result) => [result.eventId, result])).values()]
      .map((result) => ({ eventId: result.eventId, resultId: result.resultId }));
    const activeRelationIds = [...new Set(activeRelations.map((relation) => relation.relationId))];
    // Only supersede within the bindings this calculation owns. Cross-binding deactivation made
    // historical backfills thrash: binding A persisted active edges, binding B then cleared them
    // for shared eventIds, and A returned to the pending queue forever.
    const bindingIds = [...new Set(activeRelations.map((relation) => relation.bindingId).filter(Boolean))];
    if (bindingIds.length === 0) return true;
    try {
      await this.pool.query(
        `WITH decisions AS (
           SELECT item->>'eventId' AS event_id, item->>'resultId' AS result_id
           FROM jsonb_array_elements($1::jsonb) AS source(item)
         )
         UPDATE anysentry_event_session_relations AS relation
            SET record = relation.record || jsonb_build_object(
                  'active', false,
                  'effectiveTo', $3::bigint,
                  'supersededByResultId', decisions.result_id
                ),
                updated_at = $3
           FROM decisions
          WHERE relation.record->>'eventId' = decisions.event_id
            AND relation.record->>'bindingId' = ANY($4::text[])
            AND COALESCE((relation.record->>'active')::boolean, true)
            AND NOT (relation.relation_id = ANY($2::text[]))
            AND relation.updated_at <= $3`,
        [JSON.stringify(decisions), activeRelationIds, calculatedAt, bindingIds],
      );
      return true;
    } catch (error) {
      this.markUnavailable('reconcile Event Session relations', error);
      return false;
    }
  }

  async finalizeInteractionContent(
    content: EncryptedInteractionContent,
  ): Promise<InteractionContentFinalizeResult> {
    if (!(await this.initialize()) || !this.pool) return { state: 'unavailable' };
    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect();
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [content.contentRef]);
      const existing = await client.query<InteractionContentDbRow>(
        `SELECT
           content_ref, interaction_id, conversation_id, source_id, source_event_id,
           tenant_id, content_role, content_sha256, content_bytes, key_version,
           algorithm, nonce, auth_tag, ciphertext, state, finalized_at, accepted_at,
           deleted_at
         FROM anysentry_interaction_contents
         WHERE content_ref = $1
         FOR UPDATE`,
        [content.contentRef],
      );
      const current = existing.rows[0]
        ? storedInteractionContent(existing.rows[0])
        : undefined;
      if (current) {
        const identical =
          current.interactionId === content.interactionId
          && current.conversationId === content.conversationId
          && current.sourceId === content.sourceId
          && current.sourceEventId === content.sourceEventId
          && current.tenantId === content.tenantId
          && current.contentRole === content.contentRole
          && current.contentSha256 === content.contentSha256
          && current.contentBytes === content.contentBytes;
        await client.query(identical ? 'COMMIT' : 'ROLLBACK');
        return identical
          ? { state: 'duplicate', record: current }
          : { state: 'conflict' };
      }
      await client.query(
        `INSERT INTO anysentry_interaction_contents (
           content_ref, interaction_id, conversation_id, source_id, source_event_id,
           tenant_id, content_role, content_sha256, content_bytes, key_version,
           algorithm, nonce, auth_tag, ciphertext, state, finalized_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
           $11, $12, $13, $14, 'pending', $15, $15
         )`,
        [
          content.contentRef,
          content.interactionId,
          content.conversationId,
          content.sourceId,
          content.sourceEventId,
          content.tenantId,
          content.contentRole,
          content.contentSha256,
          content.contentBytes,
          content.keyVersion,
          content.algorithm,
          content.nonce,
          content.authTag,
          content.ciphertext,
          content.finalizedAt,
        ],
      );
      await client.query('COMMIT');
      return {
        state: 'stored',
        record: { ...content, state: 'pending' },
      };
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => undefined);
      this.markUnavailable('finalize encrypted Interaction content', error);
      return { state: 'unavailable' };
    } finally {
      client?.release();
    }
  }

  async markInteractionContentAccepted(
    contentRef: string,
    acceptedAt = Date.now(),
  ): Promise<boolean> {
    if (!(await this.initialize()) || !this.pool) return false;
    try {
      const result = await this.pool.query(
        `UPDATE anysentry_interaction_contents
            SET state = 'accepted',
                accepted_at = COALESCE(accepted_at, $2),
                updated_at = $2
          WHERE content_ref = $1
            AND state IN ('pending', 'accepted')`,
        [contentRef, acceptedAt],
      );
      return result.rowCount === 1;
    } catch (error) {
      this.markUnavailable('mark encrypted Interaction content accepted', error);
      return false;
    }
  }

  async loadInteractionContent(
    interactionId: string,
  ): Promise<StoredInteractionContent | null | undefined> {
    if (!(await this.initialize()) || !this.pool) return undefined;
    try {
      const result = await this.pool.query<InteractionContentDbRow>(
        `SELECT
           content_ref, interaction_id, conversation_id, source_id, source_event_id,
           tenant_id, content_role, content_sha256, content_bytes, key_version,
           algorithm, nonce, auth_tag, ciphertext, state, finalized_at, accepted_at,
           deleted_at
         FROM anysentry_interaction_contents
         WHERE interaction_id = $1
         LIMIT 1`,
        [interactionId],
      );
      return result.rows[0] ? storedInteractionContent(result.rows[0]) : null;
    } catch (error) {
      this.markUnavailable('load encrypted Interaction content', error);
      return undefined;
    }
  }

  async loadAvailableInteractionContentIds(
    interactionIds: readonly string[],
  ): Promise<Set<string> | null> {
    if (interactionIds.length === 0) return new Set();
    if (!(await this.initialize()) || !this.pool) return null;
    try {
      const result = await this.pool.query<{ interaction_id: string }>(
        `SELECT interaction_id
           FROM anysentry_interaction_contents
          WHERE interaction_id = ANY($1::text[])
            AND state <> 'deleted'`,
        [[...new Set(interactionIds)].slice(0, 10_000)],
      );
      return new Set(result.rows.map((row) => row.interaction_id));
    } catch (error) {
      this.markUnavailable('load encrypted Interaction content availability', error);
      return null;
    }
  }

  async deleteInteractionContent(
    interactionId: string,
    deletedAt = Date.now(),
  ): Promise<'deleted' | 'not_found' | 'unavailable'> {
    if (!(await this.initialize()) || !this.pool) return 'unavailable';
    try {
      const result = await this.pool.query(
        `UPDATE anysentry_interaction_contents
            SET state = 'deleted',
                nonce = decode('', 'hex'),
                auth_tag = decode('', 'hex'),
                ciphertext = decode('', 'hex'),
                deleted_at = COALESCE(deleted_at, $2),
                updated_at = $2
          WHERE interaction_id = $1
            AND state <> 'deleted'`,
        [interactionId, deletedAt],
      );
      if (result.rowCount === 1) return 'deleted';
      const existing = await this.pool.query(
        `SELECT 1 FROM anysentry_interaction_contents WHERE interaction_id = $1 LIMIT 1`,
        [interactionId],
      );
      return existing.rowCount ? 'deleted' : 'not_found';
    } catch (error) {
      this.markUnavailable('delete encrypted Interaction content', error);
      return 'unavailable';
    }
  }

  async purgeOrphanInteractionContents(
    olderThan: number,
  ): Promise<number | null> {
    if (!(await this.initialize()) || !this.pool) return null;
    try {
      const result = await this.pool.query(
        `UPDATE anysentry_interaction_contents AS content
            SET state = 'deleted',
                nonce = decode('', 'hex'),
                auth_tag = decode('', 'hex'),
                ciphertext = decode('', 'hex'),
                deleted_at = $1,
                updated_at = $1
          WHERE content.state = 'pending'
            AND content.finalized_at < $2
            AND NOT EXISTS (
              SELECT 1
                FROM anysentry_interaction_receipts AS receipt
               WHERE receipt.source_id = content.source_id
                 AND receipt.source_event_id = content.source_event_id
                 AND receipt.status = 'accepted'
            )`,
        [Date.now(), olderThan],
      );
      return result.rowCount ?? 0;
    } catch (error) {
      this.markUnavailable('purge orphaned encrypted Interaction content', error);
      return null;
    }
  }

  private async connect(): Promise<boolean> {
    const pool = new Pool({
      connectionString: this.databaseUrl,
      max: positiveInt(process.env.ANYSENTRY_DATABASE_POOL_MAX, 10, 50),
      connectionTimeoutMillis: positiveInt(
        process.env.ANYSENTRY_DATABASE_CONNECT_TIMEOUT_MS,
        5_000,
        60_000,
      ),
      idleTimeoutMillis: positiveInt(
        process.env.ANYSENTRY_DATABASE_IDLE_TIMEOUT_MS,
        30_000,
        300_000,
      ),
      ssl: process.env.ANYSENTRY_DATABASE_SSL === 'on'
        ? { rejectUnauthorized: process.env.ANYSENTRY_DATABASE_SSL_REJECT_UNAUTHORIZED !== 'off' }
        : undefined,
    });
    // node-postgres emits idle-client failures on the Pool itself. Without a listener, a
    // transient PostgreSQL restart or network reset becomes an uncaught EventEmitter error and
    // terminates the API process even though the ClickHouse migration fallback remains usable.
    pool.on('error', (error) => {
      this.markUnavailable('handle an idle PostgreSQL client failure', error);
    });
    // Pool-level errors cover idle clients only. While a client is checked out for a transaction,
    // node-postgres emits connection termination on the Client itself; without a permanent
    // listener PostgreSQL restart/failover becomes an uncaught EventEmitter error and exits the
    // whole API process. Attach once when each physical client is created and keep query-level
    // rollback/fallback handling unchanged.
    pool.on('connect', (client) => {
      client.on('error', (error) => {
        this.markUnavailable('handle an active PostgreSQL client failure', error);
      });
    });

    try {
      await pool.query('SELECT 1');
      await pool.query(`
        CREATE TABLE IF NOT EXISTS anysentry_agent_metadata (
          agent_asset_id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          workspace_path TEXT NOT NULL,
          record JSONB NOT NULL,
          updated_at BIGINT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS anysentry_agent_metadata_updated_at_idx
          ON anysentry_agent_metadata (updated_at DESC)
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS anysentry_workspace_directory (
          workspace_id TEXT PRIMARY KEY,
          workspace_path TEXT NOT NULL,
          workspace_path_fingerprint TEXT NOT NULL,
          display_name TEXT NOT NULL,
          repository_id TEXT,
          source_id TEXT,
          environment_id TEXT,
          node_scope TEXT,
          record JSONB NOT NULL,
          first_seen_at BIGINT NOT NULL,
          last_seen_at BIGINT NOT NULL,
          updated_at BIGINT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(`
        DROP INDEX IF EXISTS anysentry_workspace_directory_path_idx
      `);
      await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS anysentry_workspace_directory_scope_path_idx
          ON anysentry_workspace_directory (COALESCE(node_scope, ''), workspace_path_fingerprint)
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS anysentry_workspace_directory_updated_at_idx
          ON anysentry_workspace_directory (updated_at DESC)
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS anysentry_agent_workspace_bindings (
          binding_id TEXT PRIMARY KEY,
          agent_asset_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          workspace_path TEXT NOT NULL,
          valid_from BIGINT NOT NULL,
          valid_to BIGINT,
          last_observed_at BIGINT NOT NULL,
          record JSONB NOT NULL,
          updated_at BIGINT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS anysentry_agent_workspace_bindings_agent_time_idx
          ON anysentry_agent_workspace_bindings (agent_asset_id, valid_from DESC)
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS anysentry_agent_workspace_bindings_workspace_time_idx
          ON anysentry_agent_workspace_bindings (workspace_id, valid_from DESC)
      `);
      await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS anysentry_agent_workspace_bindings_active_idx
          ON anysentry_agent_workspace_bindings (agent_asset_id)
          WHERE valid_to IS NULL
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS anysentry_agent_runtime_instances_v2 (
          canonical_instance_id TEXT PRIMARY KEY,
          agent_scope_id TEXT NOT NULL,
          runtime_state TEXT NOT NULL,
          last_seen_at BIGINT NOT NULL,
          ended_at BIGINT,
          record JSONB NOT NULL,
          updated_at BIGINT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS anysentry_agent_runtime_instances_v2_scope_time_idx
          ON anysentry_agent_runtime_instances_v2 (agent_scope_id, last_seen_at DESC)
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS anysentry_agent_runtime_instances_v2_state_time_idx
          ON anysentry_agent_runtime_instances_v2 (runtime_state, last_seen_at DESC)
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS anysentry_agent_runtime_instance_aliases_v1 (
          alias_instance_id TEXT PRIMARY KEY,
          canonical_instance_id TEXT NOT NULL REFERENCES
            anysentry_agent_runtime_instances_v2(canonical_instance_id) ON DELETE CASCADE,
          first_seen_at BIGINT NOT NULL,
          last_seen_at BIGINT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS anysentry_agent_runtime_instance_aliases_v1_canonical_idx
          ON anysentry_agent_runtime_instance_aliases_v1 (canonical_instance_id)
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS anysentry_agent_conversation_threads_v1 (
          conversation_id TEXT PRIMARY KEY,
          logical_scope_key TEXT NOT NULL,
          id_source TEXT NOT NULL,
          last_activity_at NUMERIC(40, 0) NOT NULL,
          record JSONB NOT NULL,
          updated_at BIGINT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS anysentry_raw_observations_v1 (
          observation_id TEXT NOT NULL,
          revision BIGINT NOT NULL,
          idempotency_key TEXT NOT NULL,
          event_at NUMERIC(40, 0) NOT NULL,
          received_at NUMERIC(40, 0) NOT NULL,
          source_type TEXT NOT NULL,
          source_id TEXT,
          collector_id TEXT,
          payload_sha256 TEXT NOT NULL,
          original_bytes BIGINT NOT NULL,
          captured_bytes BIGINT NOT NULL,
          record JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (observation_id, revision)
        )
      `);
      // Idempotency is scoped to an observation revision.  A late relation/projection revision
      // must append beside revision 1 rather than colliding with a transport retry key.
      await pool.query(`
        ALTER TABLE anysentry_raw_observations_v1
          DROP CONSTRAINT IF EXISTS anysentry_raw_observations_v1_idempotency_key_key
      `);
      await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS anysentry_raw_observations_v1_idempotency_revision_idx
          ON anysentry_raw_observations_v1 (idempotency_key, revision)
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS anysentry_raw_observations_v1_event_brin
          ON anysentry_raw_observations_v1 USING brin (event_at)
      `);
      await pool.query(`DROP INDEX IF EXISTS anysentry_raw_observations_v1_event_idx`);
      await pool.query(`DROP INDEX IF EXISTS anysentry_raw_observations_v1_source_idx`);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS anysentry_kernel_facts_v1 (
          fact_id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          authority TEXT NOT NULL,
          observed_at NUMERIC(40, 0) NOT NULL,
          process_generation_key TEXT,
          parent_process_generation_key TEXT,
          connection_id TEXT,
          payload_ref TEXT,
          event_id TEXT,
          scope TEXT,
          status TEXT NOT NULL,
          record JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS anysentry_kernel_facts_v1_observed_brin
          ON anysentry_kernel_facts_v1 USING brin (observed_at)
      `);
      await pool.query(`DROP INDEX IF EXISTS anysentry_kernel_facts_v1_observed_idx`);
      await pool.query(`DROP INDEX IF EXISTS anysentry_kernel_facts_v1_process_idx`);
      await pool.query(`DROP INDEX IF EXISTS anysentry_kernel_facts_v1_connection_idx`);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS anysentry_kernel_facts_v1_event_idx
          ON anysentry_kernel_facts_v1 (event_id)
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS anysentry_semantic_records_v1 (
          semantic_record_id TEXT NOT NULL,
          revision BIGINT NOT NULL DEFAULT 1,
          kind TEXT NOT NULL,
          authority TEXT NOT NULL,
          observed_at NUMERIC(40, 0) NOT NULL,
          logical_agent_id TEXT,
          agent_instance_id TEXT,
          session_id TEXT,
          turn_id TEXT,
          run_id TEXT,
          tool_call_id TEXT,
          record JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (semantic_record_id, revision)
        )
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS anysentry_semantic_records_v1_observed_idx
          ON anysentry_semantic_records_v1 (observed_at DESC, semantic_record_id, revision DESC)
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS anysentry_semantic_records_v1_session_idx
          ON anysentry_semantic_records_v1 (session_id, observed_at DESC)
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS anysentry_session_memberships_v1 (
          membership_id TEXT NOT NULL,
          resolution_revision BIGINT NOT NULL,
          session_id TEXT NOT NULL,
          session_key TEXT,
          provider_session_id_hash TEXT,
          role TEXT NOT NULL,
          confidence TEXT NOT NULL,
          valid_from NUMERIC(40, 0) NOT NULL,
          record JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (membership_id, resolution_revision)
        )
      `);
      await pool.query(`
        ALTER TABLE anysentry_session_memberships_v1
          ADD COLUMN IF NOT EXISTS session_key TEXT,
          ADD COLUMN IF NOT EXISTS provider_session_id_hash TEXT,
          ADD COLUMN IF NOT EXISTS interaction_id TEXT
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS anysentry_session_memberships_v1_session_idx
          ON anysentry_session_memberships_v1 (session_id, valid_from DESC, resolution_revision DESC)
      `);
      await pool.query(`DROP INDEX IF EXISTS anysentry_session_memberships_v1_session_key_idx`);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS anysentry_session_memberships_v1_interaction_idx
          ON anysentry_session_memberships_v1 ((record->>'interactionId'), valid_from DESC)
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS anysentry_coverage_gaps_v1 (
          gap_id TEXT NOT NULL,
          revision BIGINT NOT NULL,
          stage TEXT NOT NULL,
          reason TEXT NOT NULL,
          scope TEXT NOT NULL,
          first_seen_at NUMERIC(40, 0) NOT NULL,
          last_seen_at NUMERIC(40, 0) NOT NULL,
          dropped_count BIGINT NOT NULL,
          orphaned_count BIGINT NOT NULL,
          record JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (gap_id, revision)
        )
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS anysentry_coverage_gaps_v1_last_seen_idx
          ON anysentry_coverage_gaps_v1 (last_seen_at DESC, gap_id, revision DESC)
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS anysentry_evidence_links_v1 (
          link_id TEXT NOT NULL,
          resolution_revision BIGINT NOT NULL,
          from_type TEXT NOT NULL,
          from_id TEXT NOT NULL,
          to_type TEXT NOT NULL,
          to_id TEXT NOT NULL,
          relation TEXT NOT NULL,
          method TEXT NOT NULL,
          confidence DOUBLE PRECISION NOT NULL,
          status TEXT NOT NULL,
          authority TEXT NOT NULL,
          valid_from NUMERIC(40, 0) NOT NULL,
          record JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (link_id, resolution_revision)
        )
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS anysentry_evidence_links_v1_from_idx
          ON anysentry_evidence_links_v1 (from_type, from_id, valid_from DESC)
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS anysentry_evidence_links_v1_to_idx
          ON anysentry_evidence_links_v1 (to_type, to_id, valid_from DESC)
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS anysentry_agent_conversation_threads_v1_scope_time_idx
          ON anysentry_agent_conversation_threads_v1 (logical_scope_key, last_activity_at DESC)
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS anysentry_agent_conversation_segments_v1 (
          segment_id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES
            anysentry_agent_conversation_threads_v1(conversation_id) ON DELETE CASCADE,
          agent_instance_id TEXT NOT NULL,
          ordinal INTEGER NOT NULL,
          started_at NUMERIC(40, 0) NOT NULL,
          ended_at NUMERIC(40, 0),
          record JSONB NOT NULL,
          updated_at BIGINT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS anysentry_agent_conversation_segments_v1_thread_idx
          ON anysentry_agent_conversation_segments_v1 (conversation_id, ordinal)
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS anysentry_agent_conversation_segments_v1_instance_time_idx
          ON anysentry_agent_conversation_segments_v1 (agent_instance_id, started_at DESC)
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS anysentry_agent_conversation_bindings_v1 (
          interaction_id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES
            anysentry_agent_conversation_threads_v1(conversation_id) ON DELETE CASCADE,
          segment_id TEXT NOT NULL REFERENCES
            anysentry_agent_conversation_segments_v1(segment_id) ON DELETE CASCADE,
          logical_scope_key TEXT NOT NULL,
          record JSONB NOT NULL,
          updated_at BIGINT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS anysentry_agent_conversation_bindings_v1_thread_idx
          ON anysentry_agent_conversation_bindings_v1 (conversation_id)
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS anysentry_agent_conversation_anchors_v1 (
          interaction_id TEXT NOT NULL,
          logical_scope_key TEXT NOT NULL,
          anchor_kind TEXT NOT NULL,
          anchor_namespace TEXT NOT NULL,
          value_hash TEXT NOT NULL,
          strength TEXT NOT NULL,
          source_path TEXT NOT NULL,
          observed_at BIGINT NOT NULL,
          record JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (interaction_id, anchor_kind, anchor_namespace, value_hash)
        )
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS anysentry_agent_conversation_anchors_v1_lookup_idx
          ON anysentry_agent_conversation_anchors_v1 (
            logical_scope_key, anchor_kind, anchor_namespace, value_hash
          )
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS anysentry_agent_conversation_anchors_v1_hash_lookup_idx
          ON anysentry_agent_conversation_anchors_v1 (
            anchor_namespace, value_hash, anchor_kind, observed_at DESC
          )
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS anysentry_agent_conversation_memberships_v2 (
          interaction_id TEXT NOT NULL,
          resolution_revision BIGINT NOT NULL,
          logical_scope_key TEXT NOT NULL,
          role TEXT NOT NULL,
          canonical_conversation_id TEXT,
          technical_activity_id TEXT,
          record JSONB NOT NULL,
          decided_at BIGINT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (interaction_id, resolution_revision)
        )
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS anysentry_agent_conversation_memberships_v2_current_idx
          ON anysentry_agent_conversation_memberships_v2 (
            interaction_id, resolution_revision DESC
          )
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS anysentry_agent_conversation_memberships_v2_thread_idx
          ON anysentry_agent_conversation_memberships_v2 (
            canonical_conversation_id, resolution_revision DESC
          )
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS anysentry_agent_conversation_route_aliases_v1 (
          alias_conversation_id TEXT PRIMARY KEY,
          target_type TEXT NOT NULL,
          target_id TEXT NOT NULL,
          resolution_revision BIGINT NOT NULL,
          record JSONB NOT NULL,
          updated_at BIGINT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS anysentry_agent_conversation_route_aliases_v1_target_idx
          ON anysentry_agent_conversation_route_aliases_v1 (target_type, target_id)
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS anysentry_agent_run_technical_activities_v1 (
          technical_activity_id TEXT PRIMARY KEY,
          agent_instance_id TEXT,
          started_at NUMERIC(40, 0) NOT NULL,
          ended_at NUMERIC(40, 0) NOT NULL,
          record JSONB NOT NULL,
          updated_at BIGINT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS anysentry_agent_run_technical_activities_v1_instance_idx
          ON anysentry_agent_run_technical_activities_v1 (agent_instance_id, started_at DESC)
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS anysentry_agent_semantic_kernel_relations_v1 (
          relation_id TEXT PRIMARY KEY,
          stable_semantic_event_id TEXT NOT NULL,
          tool_invocation_id TEXT NOT NULL,
          kernel_event_id TEXT,
          relation_status TEXT NOT NULL,
          resolution_revision BIGINT NOT NULL,
          record JSONB NOT NULL,
          updated_at BIGINT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      // The *_v1 table above is retained as a latest-row compatibility projection for existing
      // readers.  Correlation decisions themselves are append-only: every resolution revision is
      // preserved in this history table so a late Kernel event cannot erase the prior decision.
      await pool.query(`
        CREATE TABLE IF NOT EXISTS anysentry_agent_semantic_kernel_relation_history_v1 (
          relation_id TEXT NOT NULL,
          stable_semantic_event_id TEXT NOT NULL,
          tool_invocation_id TEXT NOT NULL,
          kernel_event_id TEXT,
          relation_status TEXT NOT NULL,
          resolution_revision BIGINT NOT NULL,
          record JSONB NOT NULL,
          updated_at BIGINT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (relation_id, resolution_revision)
        )
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS anysentry_agent_semantic_kernel_relation_history_v1_semantic_idx
          ON anysentry_agent_semantic_kernel_relation_history_v1 (
            stable_semantic_event_id, resolution_revision DESC, relation_id
          )
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS anysentry_agent_semantic_kernel_relation_history_v1_kernel_idx
          ON anysentry_agent_semantic_kernel_relation_history_v1 (kernel_event_id, resolution_revision DESC)
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS anysentry_agent_semantic_kernel_relations_v1_semantic_idx
          ON anysentry_agent_semantic_kernel_relations_v1 (
            stable_semantic_event_id, resolution_revision DESC
          )
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS anysentry_agent_semantic_kernel_relations_v1_kernel_idx
          ON anysentry_agent_semantic_kernel_relations_v1 (kernel_event_id)
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS anysentry_incidents (
          incident_id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          severity TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          workspace_path TEXT NOT NULL,
          record JSONB NOT NULL,
          opened_at BIGINT NOT NULL,
          updated_at BIGINT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS anysentry_incidents_status_idx
          ON anysentry_incidents (status)
      `);
      await pool.query(`DROP INDEX IF EXISTS anysentry_incidents_status_updated_idx`);
      await pool.query(`DROP INDEX IF EXISTS anysentry_incidents_agent_updated_idx`);
      await pool.query(`ALTER TABLE anysentry_incidents SET (fillfactor = 70)`);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS anysentry_alerts (
          alert_id TEXT PRIMARY KEY,
          dedupe_key TEXT NOT NULL,
          status TEXT NOT NULL,
          severity TEXT NOT NULL,
          kind TEXT NOT NULL,
          record JSONB NOT NULL,
          first_seen_at BIGINT NOT NULL,
          last_seen_at BIGINT NOT NULL,
          updated_at BIGINT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS anysentry_alerts_status_idx
          ON anysentry_alerts (status)
      `);
      await pool.query(`DROP INDEX IF EXISTS anysentry_alerts_status_updated_idx`);
      await pool.query(`ALTER TABLE anysentry_alerts SET (fillfactor = 70)`);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS anysentry_alerts_dedupe_key_idx
          ON anysentry_alerts (dedupe_key)
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS anysentry_business_effects (
          effect_key TEXT PRIMARY KEY,
          effect_type TEXT NOT NULL,
          payload_fingerprint TEXT NOT NULL,
          status TEXT NOT NULL,
          lease_owner TEXT NOT NULL,
          lease_expires_at BIGINT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 1,
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at_ms BIGINT NOT NULL,
          applied_at BIGINT,
          updated_at BIGINT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS anysentry_business_effects_status_lease_idx
          ON anysentry_business_effects (status, lease_expires_at)
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS anysentry_writer_ownership (
          source_scope TEXT PRIMARY KEY,
          writer_id TEXT NOT NULL,
          writer_version TEXT NOT NULL,
          protocol_version TEXT NOT NULL,
          lease_expires_at BIGINT NOT NULL,
          first_seen_at BIGINT NOT NULL,
          updated_at BIGINT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS anysentry_writer_ownership_lease_idx
          ON anysentry_writer_ownership (lease_expires_at)
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS anysentry_remediations (
          task_id TEXT PRIMARY KEY,
          source_type TEXT NOT NULL,
          source_id TEXT NOT NULL,
          status TEXT NOT NULL,
          severity TEXT NOT NULL,
          record JSONB NOT NULL,
          created_at_ms BIGINT NOT NULL,
          updated_at BIGINT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS anysentry_remediations_status_idx
          ON anysentry_remediations (status)
      `);
      await pool.query(`DROP INDEX IF EXISTS anysentry_remediations_status_updated_idx`);
      await pool.query(`ALTER TABLE anysentry_remediations SET (fillfactor = 70)`);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS anysentry_remediations_source_idx
          ON anysentry_remediations (source_type, source_id)
      `);
      for (const [table, identityColumn] of [
        ['anysentry_ingestion_sources', 'source_id'],
        ['anysentry_maintenance_windows', 'window_id'],
        ['anysentry_notification_channels', 'channel_id'],
        ['anysentry_notification_routes', 'route_id'],
        ['anysentry_objectives', 'objective_id'],
        ['anysentry_platform_users', 'user_id'],
      ] as const) {
        await pool.query(`
          CREATE TABLE IF NOT EXISTS ${table} (
            ${identityColumn} TEXT PRIMARY KEY,
            record JSONB NOT NULL,
            updated_at BIGINT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);
        await pool.query(`
          CREATE INDEX IF NOT EXISTS ${table}_updated_at_idx
            ON ${table} (updated_at DESC)
        `);
      }
      await pool.query(`
        CREATE TABLE IF NOT EXISTS anysentry_platform_configs (
          config_key TEXT PRIMARY KEY,
          record JSONB NOT NULL,
          updated_at BIGINT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS anysentry_interaction_receipts (
          source_id TEXT NOT NULL,
          source_event_id TEXT NOT NULL,
          interaction_id TEXT NOT NULL,
          conversation_id TEXT NOT NULL,
          payload_fingerprint TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending', 'accepted')),
          accepted_at BIGINT NOT NULL,
          updated_at BIGINT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (source_id, source_event_id)
        )
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS anysentry_interaction_receipts_status_updated_idx
          ON anysentry_interaction_receipts (status, updated_at ASC)
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS anysentry_interaction_contents (
          content_ref TEXT PRIMARY KEY,
          interaction_id TEXT NOT NULL UNIQUE,
          conversation_id TEXT NOT NULL,
          source_id TEXT NOT NULL,
          source_event_id TEXT NOT NULL,
          tenant_id TEXT NOT NULL,
          content_role TEXT NOT NULL CHECK (
            content_role IN ('user_instruction', 'assistant_response')
          ),
          content_sha256 TEXT NOT NULL,
          content_bytes BIGINT NOT NULL,
          key_version TEXT NOT NULL,
          algorithm TEXT NOT NULL CHECK (algorithm IN ('aes-256-gcm')),
          nonce BYTEA NOT NULL,
          auth_tag BYTEA NOT NULL,
          ciphertext BYTEA NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('pending', 'accepted', 'deleted')),
          finalized_at BIGINT NOT NULL,
          accepted_at BIGINT,
          deleted_at BIGINT,
          updated_at BIGINT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (source_id, source_event_id, content_role)
        )
      `);
      await pool.query(`
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1
              FROM pg_constraint
             WHERE conrelid = 'anysentry_interaction_contents'::regclass
               AND conname = 'anysentry_interaction_contents_content_role_check'
               AND pg_get_constraintdef(oid) NOT LIKE '%assistant_response%'
          ) THEN
            ALTER TABLE anysentry_interaction_contents
              DROP CONSTRAINT anysentry_interaction_contents_content_role_check;
            ALTER TABLE anysentry_interaction_contents
              ADD CONSTRAINT anysentry_interaction_contents_content_role_check
              CHECK (content_role IN ('user_instruction', 'assistant_response'));
          END IF;
        END $$;
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS anysentry_interaction_contents_state_updated_idx
          ON anysentry_interaction_contents (state, updated_at ASC)
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS anysentry_interaction_contents_conversation_idx
          ON anysentry_interaction_contents (conversation_id, finalized_at ASC)
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS anysentry_interaction_metadata (
          interaction_id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL,
          source_id TEXT NOT NULL,
          source_event_id TEXT NOT NULL,
          collector_id TEXT NOT NULL,
          tenant_id TEXT NOT NULL,
          environment_id TEXT,
          agent_instance_id TEXT,
          process_instance_id TEXT NOT NULL,
          workspace_path TEXT,
          provider TEXT,
          observed_at BIGINT NOT NULL,
          accepted_at BIGINT NOT NULL,
          projected_at BIGINT NOT NULL,
          payload_fingerprint TEXT NOT NULL,
          record JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (source_id, source_event_id)
        )
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS anysentry_interaction_conversation_time_idx
          ON anysentry_interaction_metadata (conversation_id, observed_at ASC)
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS anysentry_interaction_collector_time_idx
          ON anysentry_interaction_metadata (collector_id, observed_at DESC)
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS anysentry_interaction_agent_time_idx
          ON anysentry_interaction_metadata (agent_instance_id, observed_at DESC)
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS anysentry_interaction_workspace_time_idx
          ON anysentry_interaction_metadata (workspace_path, observed_at DESC)
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS anysentry_session_process_bindings (
          binding_id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL,
          native_session_id TEXT NOT NULL,
          host_id TEXT NOT NULL,
          boot_id TEXT NOT NULL,
          collector_id TEXT NOT NULL,
          process_instance_key TEXT NOT NULL,
          binding_revision BIGINT NOT NULL,
          valid_from BIGINT NOT NULL,
          valid_to BIGINT,
          observed_at BIGINT NOT NULL,
          record JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS anysentry_session_process_bindings_scope_time_idx
          ON anysentry_session_process_bindings
          (host_id, boot_id, collector_id, valid_from, valid_to)
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS anysentry_session_process_bindings_conversation_idx
          ON anysentry_session_process_bindings (conversation_id, binding_revision DESC)
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS anysentry_session_process_binding_revisions (
          binding_id TEXT NOT NULL,
          binding_revision BIGINT NOT NULL,
          observed_at BIGINT NOT NULL,
          record JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (binding_id, binding_revision)
        )
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS anysentry_session_process_binding_revisions_observed_idx
          ON anysentry_session_process_binding_revisions (observed_at DESC)
      `);
      await pool.query(`
        INSERT INTO anysentry_session_process_binding_revisions (
          binding_id, binding_revision, observed_at, record
        )
        SELECT binding_id, binding_revision, observed_at, record
          FROM anysentry_session_process_bindings
        ON CONFLICT (binding_id, binding_revision) DO NOTHING
      `);
      for (const [table, identityColumn] of [
        ['anysentry_process_lineage_edges', 'edge_id'],
        ['anysentry_event_session_attribution_results', 'result_id'],
        ['anysentry_event_session_relations', 'relation_id'],
      ] as const) {
        await pool.query(`
          CREATE TABLE IF NOT EXISTS ${table} (
            ${identityColumn} TEXT PRIMARY KEY,
            record JSONB NOT NULL,
            updated_at BIGINT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);
        await pool.query(`
          CREATE INDEX IF NOT EXISTS ${table}_updated_at_idx
            ON ${table} (updated_at DESC)
        `);
      }
      await pool.query(`
        CREATE INDEX IF NOT EXISTS anysentry_event_session_relations_event_id_idx
          ON anysentry_event_session_relations ((record->>'eventId'))
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS anysentry_event_session_relations_binding_active_idx
          ON anysentry_event_session_relations (
            (record->>'bindingId'),
            updated_at DESC,
            relation_id
          )
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS anysentry_process_lineage_edges_parent_idx
          ON anysentry_process_lineage_edges ((record->>'parentProcessInstanceKey'))
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS anysentry_process_lineage_edges_child_idx
          ON anysentry_process_lineage_edges ((record->>'childProcessInstanceKey'))
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS anysentry_event_session_results_event_id_idx
          ON anysentry_event_session_attribution_results ((record->>'eventId'), updated_at DESC)
      `);
      // Upgrade records written before relation effectiveness was explicit. A newer non-definite
      // result invalidates the old definite edge, but the edge remains available as audit history.
      await pool.query(`
        WITH latest_result AS (
          SELECT DISTINCT ON (record->>'eventId')
            record->>'eventId' AS event_id,
            record->>'resultId' AS result_id,
            record->>'status' AS status,
            updated_at
          FROM anysentry_event_session_attribution_results
          ORDER BY record->>'eventId', updated_at DESC, record->>'resultId'
        )
        UPDATE anysentry_event_session_relations AS relation
           SET record = relation.record || jsonb_build_object(
                 'active', false,
                 'effectiveTo', latest_result.updated_at,
                 'supersededByResultId', latest_result.result_id
               ),
               updated_at = latest_result.updated_at
          FROM latest_result
         WHERE relation.record->>'eventId' = latest_result.event_id
           AND COALESCE((relation.record->>'active')::boolean, true)
           AND latest_result.status NOT IN ('DIRECT', 'LINEAGE')
           AND latest_result.updated_at > relation.updated_at
      `);
      // Retain old decisions for audit, but do not present them as current truth.
      // Bounded on-demand/background evaluation can materialize new-version relations.
      await pool.query(INVALIDATE_OLD_SESSION_RELATIONS_SQL,
        [SESSION_EVENT_ATTRIBUTION_VERSION, Date.now()]);
      // Gate every query/connect through the failure breaker so a saturated event loop
      // fast-fails during cooldown instead of stacking 5s connect timeouts. Methods are bound
      // to the real pool so node-postgres internals never see the Proxy as `this`.
      this.pool = new Proxy(pool, {
        get: (target, prop) => {
          if (prop === 'query' || prop === 'connect') this.gatePoolAccess();
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as Pool;
      this.ready = true;
      this.startCoverageGapIdlePrune();
      this.logger.log('PostgreSQL business-state store is ready');
      return true;
    } catch (error) {
      await pool.end().catch(() => undefined);
      this.ready = false;
      this.logger.warn(
        `PostgreSQL business-state store unavailable; using migration fallback: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }

  private markUnavailable(operation: string, error: unknown): void {
    const isCooldownRejection =
      typeof error === 'object' && error !== null && 'code' in error
        && (error as { code?: unknown }).code === PG_COOLDOWN_ERROR_CODE;
    if (!isCooldownRejection) {
      const now = Date.now();
      this.recentOperationFailureAt.push(now);
      if (this.recentOperationFailureAt.length > 32) this.recentOperationFailureAt.shift();
      const windowStart = now - OPERATION_FAILURE_WINDOW_MS;
      this.recentOperationFailureAt = this.recentOperationFailureAt.filter((at) => at >= windowStart);
      if (this.recentOperationFailureAt.length >= OPERATION_FAILURE_BREAKER_THRESHOLD) {
        this.operationCooldownUntil = now + OPERATION_FAILURE_BREAKER_COOLDOWN_MS;
      }
    }
    const now = Date.now();
    const lastWarnAt = this.unavailableWarnedAt.get(operation) ?? 0;
    if (now - lastWarnAt < UNAVAILABLE_WARN_COALESCE_MS) {
      this.unavailableSuppressed.set(operation, (this.unavailableSuppressed.get(operation) ?? 0) + 1);
      return;
    }
    const suppressed = this.unavailableSuppressed.get(operation) ?? 0;
    this.unavailableSuppressed.delete(operation);
    this.unavailableWarnedAt.set(operation, now);
    this.logger.warn(
      `PostgreSQL could not ${operation}; ClickHouse migration copy remains available: ${
        error instanceof Error ? error.message : String(error)
      }${suppressed > 0 ? ` (${suppressed} similar failures suppressed in the last ${UNAVAILABLE_WARN_COALESCE_MS / 1000}s)` : ''}`,
    );
  }

  // Short-circuit pool access while the failure breaker is open. Rejecting immediately keeps a
  // saturated event loop from queuing thousands of doomed 5s connect attempts behind itself.
  private gatePoolAccess(): void {
    if (Date.now() < this.operationCooldownUntil) {
      throw Object.assign(
        new Error('PostgreSQL operations cooling down after clustered failures'),
        { code: PG_COOLDOWN_ERROR_CODE },
      );
    }
  }

  private async loadBusinessRecords<T>(
    table: string,
    identityColumn: string,
    limit: number,
    identity: (record: T) => string | undefined,
    operation: string,
  ): Promise<T[]> {
    if (!(await this.initialize()) || !this.pool) return [];
    try {
      const result = await this.pool.query<{ record: T | string }>(
        `SELECT record
           FROM ${table}
          ORDER BY updated_at DESC, ${identityColumn}
          LIMIT $1`,
        [limit],
      );
      return result.rows
        .map(({ record }) => this.parseRecord<T>(record))
        .filter((record): record is T => Boolean(record && identity(record)));
    } catch (error) {
      this.markUnavailable(operation, error);
      return [];
    }
  }

  private async loadSimpleBusinessRecords<T>(
    table: string,
    identityColumn: string,
    identity: (record: T) => string | undefined,
    operation: string,
  ): Promise<T[]> {
    return this.loadBusinessRecords(
      table,
      identityColumn,
      CONFIG_OBJECT_LIMIT,
      identity,
      operation,
    );
  }

  private async saveSimpleBusinessRecords<T>(
    table: string,
    identityColumn: string,
    identityJsonKey: string,
    records: T[],
    identity: (record: T) => string,
    operation: string,
  ): Promise<boolean> {
    if (records.length === 0) return true;
    return this.saveBusinessRecords(records, operation, identity, async (client, batch) => {
      await client.query(
        `WITH incoming AS (
           SELECT
             item AS record,
             item->>'${identityJsonKey}' AS object_id,
             (item->>'updatedAt')::bigint AS updated_at
           FROM jsonb_array_elements($1::jsonb) AS source(item)
         )
         INSERT INTO ${table} (${identityColumn}, record, updated_at)
         SELECT object_id, record, updated_at
         FROM incoming
         ON CONFLICT (${identityColumn}) DO UPDATE SET
           record = EXCLUDED.record,
           updated_at = EXCLUDED.updated_at
         WHERE EXCLUDED.updated_at >= ${table}.updated_at
           AND (${table}.record - 'updatedAt') IS DISTINCT FROM (EXCLUDED.record - 'updatedAt')`,
        [JSON.stringify(batch)],
      );
    });
  }

  private async upsertIncidentRecords(client: PoolClient, records: Incident[]): Promise<void> {
    if (records.length === 0) return;
    await client.query(
      `WITH incoming AS (
         SELECT
           item AS record,
           item->>'incidentId' AS incident_id,
           item->>'status' AS status,
           item->>'severity' AS severity,
           item->>'agentId' AS agent_id,
           item->>'workspacePath' AS workspace_path,
           (item->>'openedAt')::bigint AS opened_at,
           (item->>'updatedAt')::bigint AS updated_at
         FROM jsonb_array_elements($1::jsonb) AS source(item)
       )
       INSERT INTO anysentry_incidents (
         incident_id,
         status,
         severity,
         agent_id,
         workspace_path,
         record,
         opened_at,
         updated_at
       )
       SELECT
         incident_id,
         status,
         severity,
         agent_id,
         workspace_path,
         record,
         opened_at,
         updated_at
       FROM incoming
       ON CONFLICT (incident_id) DO UPDATE SET
         status = EXCLUDED.status,
         severity = EXCLUDED.severity,
         agent_id = EXCLUDED.agent_id,
         workspace_path = EXCLUDED.workspace_path,
         record = EXCLUDED.record,
         opened_at = LEAST(anysentry_incidents.opened_at, EXCLUDED.opened_at),
         updated_at = EXCLUDED.updated_at
       WHERE EXCLUDED.updated_at >= anysentry_incidents.updated_at
         AND (anysentry_incidents.record IS DISTINCT FROM EXCLUDED.record
           OR EXCLUDED.updated_at > anysentry_incidents.updated_at
           OR EXCLUDED.opened_at < anysentry_incidents.opened_at)`,
      [JSON.stringify(records)],
    );
  }

  private async upsertAlertRecords(client: PoolClient, records: AlertRecord[]): Promise<void> {
    if (records.length === 0) return;
    await client.query(
      `WITH incoming AS (
         SELECT
           item AS record,
           item->>'alertId' AS alert_id,
           item->>'dedupeKey' AS dedupe_key,
           item->>'status' AS status,
           item->>'severity' AS severity,
           item->>'kind' AS kind,
           (item->>'firstSeenAt')::bigint AS first_seen_at,
           (item->>'lastSeenAt')::bigint AS last_seen_at,
           (item->>'updatedAt')::bigint AS updated_at
         FROM jsonb_array_elements($1::jsonb) AS source(item)
       )
       INSERT INTO anysentry_alerts (
         alert_id,
         dedupe_key,
         status,
         severity,
         kind,
         record,
         first_seen_at,
         last_seen_at,
         updated_at
       )
       SELECT
         alert_id,
         dedupe_key,
         status,
         severity,
         kind,
         record,
         first_seen_at,
         last_seen_at,
         updated_at
       FROM incoming
         ON CONFLICT (alert_id) DO UPDATE SET
         dedupe_key = EXCLUDED.dedupe_key,
         status = EXCLUDED.status,
         severity = EXCLUDED.severity,
         kind = EXCLUDED.kind,
         record = EXCLUDED.record,
         first_seen_at = LEAST(anysentry_alerts.first_seen_at, EXCLUDED.first_seen_at),
         last_seen_at = GREATEST(anysentry_alerts.last_seen_at, EXCLUDED.last_seen_at),
         updated_at = EXCLUDED.updated_at
       WHERE EXCLUDED.updated_at >= anysentry_alerts.updated_at
         AND (anysentry_alerts.record IS DISTINCT FROM EXCLUDED.record
           OR EXCLUDED.updated_at > anysentry_alerts.updated_at
           OR EXCLUDED.first_seen_at < anysentry_alerts.first_seen_at
           OR EXCLUDED.last_seen_at > anysentry_alerts.last_seen_at)`,
      [JSON.stringify(records)],
    );
  }

  private async saveBusinessRecords<T>(
    records: T[],
    operation: string,
    identity: (record: T) => string,
    upsert: (client: PoolClient, records: T[]) => Promise<void>,
  ): Promise<boolean> {
    if (!(await this.initialize()) || !this.pool) return false;
    // Every writer locks rows in the same order. This prevents two API replicas (or overlapping
    // refresh/persist cycles) from deadlocking while upserting the same business-object batch.
    const ordered = [...records].sort((left, right) =>
      identity(left).localeCompare(identity(right)));
    let lastError: unknown;
    for (let attempt = 1; attempt <= BUSINESS_WRITE_MAX_ATTEMPTS; attempt += 1) {
      let client: PoolClient | undefined;
      try {
        client = await this.pool.connect();
        await client.query('BEGIN');
        for (let offset = 0; offset < ordered.length; offset += BUSINESS_WRITE_BATCH_SIZE) {
          await upsert(client, ordered.slice(offset, offset + BUSINESS_WRITE_BATCH_SIZE));
        }
        await client.query('COMMIT');
        return true;
      } catch (error) {
        lastError = error;
        if (client) await client.query('ROLLBACK').catch(() => undefined);
        if (!this.retryableTransactionError(error) || attempt === BUSINESS_WRITE_MAX_ATTEMPTS) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, attempt * 50));
      } finally {
        client?.release();
      }
    }
    this.markUnavailable(operation, lastError);
    return false;
  }

  private async saveAttributionRecords<T>(
    table: string,
    identityColumn: string,
    identityJsonKey: string,
    records: T[],
    identity: (record: T) => string,
    operation: string,
  ): Promise<boolean> {
    if (records.length === 0) return true;
    return this.saveBusinessRecords(records, operation, identity, async (client, batch) => {
      await client.query(
        `WITH incoming AS (
           SELECT
             item AS record,
             item->>'${identityJsonKey}' AS object_id,
             COALESCE(
               NULLIF(item->>'calculatedAt', '')::bigint,
               NULLIF(item->>'createdAt', '')::bigint,
               NULLIF(item->>'observedAt', '')::bigint,
               NULLIF(item->>'validFrom', '')::bigint,
               0
             ) AS updated_at
           FROM jsonb_array_elements($1::jsonb) AS source(item)
         )
         INSERT INTO ${table} (${identityColumn}, record, updated_at)
         SELECT object_id, record, updated_at
         FROM incoming
         ON CONFLICT (${identityColumn}) DO UPDATE SET
           record = EXCLUDED.record,
           updated_at = EXCLUDED.updated_at
         WHERE EXCLUDED.updated_at >= ${table}.updated_at`,
        [JSON.stringify(batch)],
      );
    });
  }

  private retryableTransactionError(error: unknown): boolean {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: unknown }).code ?? '')
        : '';
    return code === '40P01' || code === '40001';
  }

  private parseRecord<T>(record: T | string): T | undefined {
    if (typeof record !== 'string') return record;
    try {
      return JSON.parse(record) as T;
    } catch {
      return undefined;
    }
  }
}
