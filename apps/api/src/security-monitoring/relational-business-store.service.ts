import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
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

function positiveInt(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

/**
 * Mutable business state belongs in a transactional store, not in ClickHouse config rows.
 *
 * PostgreSQL is optional during the migration. When it is unavailable, callers continue to use
 * the existing ClickHouse copy; when configured, writes are made per domain object so concurrent
 * API replicas cannot overwrite an unrelated Agent record.
 */
@Injectable()
export class RelationalBusinessStore implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RelationalBusinessStore.name);
  private readonly databaseUrl =
    process.env.ANYSENTRY_DATABASE_URL?.trim() ??
    process.env.ANYSENTRY_POSTGRES_URL?.trim() ??
    '';
  private pool?: Pool;
  private initializePromise?: Promise<boolean>;
  private ready = false;
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

  async onModuleDestroy(): Promise<void> {
    const pool = this.pool;
    this.pool = undefined;
    this.ready = false;
    if (pool) await pool.end().catch(() => undefined);
  }

  async initialize(): Promise<boolean> {
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
      await client?.query('ROLLBACK').catch(() => undefined);
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
           WHERE EXCLUDED.updated_at >= anysentry_remediations.updated_at`,
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
       WHERE EXCLUDED.updated_at >= anysentry_incidents.updated_at`,
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
       WHERE EXCLUDED.updated_at >= anysentry_alerts.updated_at`,
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
        await client?.query('ROLLBACK').catch(() => undefined);
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
