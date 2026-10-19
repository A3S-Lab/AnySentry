import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Pool, PoolClient } from 'pg';
import {
  AgentMetadataRecord,
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
} from './types';
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

const AGENT_METADATA_LIMIT = 10_000;
const WORKSPACE_DIRECTORY_LIMIT = 10_000;
const AGENT_WORKSPACE_BINDING_LIMIT = 100_000;
const INCIDENT_LIMIT = 20_000;
const ALERT_LIMIT = 20_000;
const REMEDIATION_LIMIT = 20_000;
const CONFIG_OBJECT_LIMIT = 20_000;
const BUSINESS_WRITE_MAX_ATTEMPTS = 3;
const BUSINESS_WRITE_BATCH_SIZE = 250;
const EFFECT_LEASE_MS = 60_000;

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
  private pool?: Pool;
  private initializePromise?: Promise<boolean>;
  private ready = false;
  private shuttingDown = false;
  private readonly effectOwnerId = `api:${process.pid}:${randomUUID()}`;
  private readonly writerOwnershipCache = new Map<string, number>();
  private readonly writerOwnershipInFlight = new Map<string, Promise<WriterOwnership>>();

  configured(): boolean {
    return Boolean(this.databaseUrl);
  }

  isReady(): boolean {
    return this.ready;
  }

  async onModuleInit(): Promise<void> {
    await this.initialize();
  }

  // All business destroy/before-shutdown hooks must finish before the shared pool closes.
  async onApplicationShutdown(): Promise<void> {
    this.shuttingDown = true;
    const pool = this.pool;
    this.pool = undefined;
    this.ready = false;
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
    if ((this.writerOwnershipCache.get(cacheKey) ?? 0) > at + 15_000) {
      return { status: 'owned' };
    }
    const current = this.writerOwnershipInFlight.get(cacheKey);
    if (current) return current;
    const acquisition = this.acquireWriterOwnershipUncached(
      sourceScope,
      writerId,
      writerVersion,
      protocolVersion,
      cacheKey,
      at,
    );
    this.writerOwnershipInFlight.set(cacheKey, acquisition);
    try {
      return await acquisition;
    } finally {
      if (this.writerOwnershipInFlight.get(cacheKey) === acquisition) {
        this.writerOwnershipInFlight.delete(cacheKey);
      }
    }
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
        this.writerOwnershipCache.set(cacheKey, Number(row.lease_expires_at));
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
        CREATE INDEX IF NOT EXISTS anysentry_incidents_status_updated_idx
          ON anysentry_incidents (status, updated_at DESC)
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS anysentry_incidents_agent_updated_idx
          ON anysentry_incidents (agent_id, updated_at DESC)
      `);
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
        CREATE INDEX IF NOT EXISTS anysentry_alerts_status_updated_idx
          ON anysentry_alerts (status, updated_at DESC)
      `);
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
        CREATE INDEX IF NOT EXISTS anysentry_remediations_status_updated_idx
          ON anysentry_remediations (status, updated_at DESC)
      `);
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
      this.pool = pool;
      this.ready = true;
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
    this.logger.warn(
      `PostgreSQL could not ${operation}; ClickHouse migration copy remains available: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
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
         WHERE EXCLUDED.updated_at >= ${table}.updated_at`,
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
