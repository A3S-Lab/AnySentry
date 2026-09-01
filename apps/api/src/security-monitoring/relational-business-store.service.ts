import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
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
} from './types';
import type {
  ConversationMembershipV2,
  ConversationRouteAliasV1,
  TechnicalActivityProjection,
} from './agent-conversation-resolution-v2';
import { PolicyConfig } from './policy-config';

const AGENT_METADATA_LIMIT = 10_000;
const WORKSPACE_DIRECTORY_LIMIT = 10_000;
const AGENT_WORKSPACE_BINDING_LIMIT = 100_000;
const AGENT_RUNTIME_INSTANCE_LIMIT = 100_000;
const AGENT_CONVERSATION_BINDING_LIMIT = 100_000;
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
  ): Promise<AgentConversationAnchorMembershipMatch[]> {
    if (anchors.length === 0 || !(await this.initialize()) || !this.pool) return [];
    const lookup = [...new Map(anchors
      .filter((anchor) => anchor.namespace && anchor.valueHash)
      .map((anchor) => [`${anchor.namespace}\u0000${anchor.valueHash}`, {
        namespace: anchor.namespace,
        valueHash: anchor.valueHash,
      }])).values()].slice(0, 4_096);
    if (lookup.length === 0) return [];
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
           JOIN LATERAL (
             SELECT candidate.record
               FROM anysentry_agent_conversation_memberships_v2 AS candidate
              WHERE candidate.interaction_id = anchor.interaction_id
                AND candidate.canonical_conversation_id IS NOT NULL
              ORDER BY candidate.resolution_revision DESC
              LIMIT 1
           ) AS membership ON TRUE
          ORDER BY anchor.observed_at DESC
          LIMIT $2`,
        [JSON.stringify(lookup), AGENT_CONVERSATION_BINDING_LIMIT],
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

  async saveAgentConversationResolution(
    threads: AgentConversationThreadRecord[],
    segments: ConversationInstanceSegment[],
    bindings: AgentConversationBindingRecord[],
  ): Promise<boolean> {
    if (threads.length === 0 && segments.length === 0 && bindings.length === 0) return true;
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
          [JSON.stringify(threads)],
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
          [JSON.stringify(segments)],
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
          [JSON.stringify(bindings)],
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
    if (!(await this.initialize()) || !this.pool) return false;
    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect();
      await client.query('BEGIN');
      if (anchors.length) {
        const rows = anchors.map((item) => ({
          interactionId: item.interactionId,
          logicalScopeKey: item.logicalScopeKey,
          observedAt: item.observedAt,
          ...item.anchor,
        }));
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
           ON CONFLICT (interaction_id, anchor_kind, anchor_namespace, value_hash)
           DO UPDATE SET
             strength = EXCLUDED.strength,
             source_path = EXCLUDED.source_path,
             observed_at = EXCLUDED.observed_at,
             record = EXCLUDED.record`,
          [JSON.stringify(rows)],
        );
      }
      if (memberships.length) {
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
           ON CONFLICT (interaction_id, resolution_revision) DO UPDATE SET
             logical_scope_key = EXCLUDED.logical_scope_key,
             role = EXCLUDED.role,
             canonical_conversation_id = EXCLUDED.canonical_conversation_id,
             technical_activity_id = EXCLUDED.technical_activity_id,
             record = EXCLUDED.record,
             decided_at = EXCLUDED.decided_at`,
          [JSON.stringify(memberships)],
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
          [JSON.stringify(aliases)],
        );
      }
      if (technicalActivities.length) {
        const rows = technicalActivities.map((item) => ({
          ...item,
          updatedAt: Number(BigInt(item.endedAtUnixNs) / 1_000_000n),
        }));
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
          [JSON.stringify(rows)],
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
        `SELECT record
           FROM anysentry_agent_semantic_kernel_relations_v1
          WHERE stable_semantic_event_id = $1
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
      this.markUnavailable('load Agent Semantic Kernel relations', error);
      return [];
    }
  }

  async loadAgentSemanticRelationsForKernelEvent(
    kernelEventId: string,
  ): Promise<AgentSemanticKernelRelation[]> {
    if (!kernelEventId || !(await this.initialize()) || !this.pool) return [];
    try {
      const result = await this.pool.query<{ record: AgentSemanticKernelRelation | string }>(
        `SELECT record
           FROM anysentry_agent_semantic_kernel_relations_v1
          WHERE kernel_event_id = $1
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
      return [];
    }
  }

  async saveAgentSemanticKernelRelations(
    relations: AgentSemanticKernelRelation[],
  ): Promise<boolean> {
    if (!relations.length) return true;
    if (!(await this.initialize()) || !this.pool) return false;
    try {
      const updatedAt = Date.now();
      const rows = relations.map((relation) => ({ ...relation, updatedAt }));
      await this.pool.query(
        `WITH incoming AS (
           SELECT item AS record
             FROM jsonb_array_elements($1::jsonb) AS source(item)
         ), latest_incoming AS (
           SELECT
             record->>'stableSemanticEventId' AS stable_semantic_event_id,
             MAX((record->>'resolutionRevision')::bigint) AS resolution_revision
           FROM incoming
           GROUP BY record->>'stableSemanticEventId'
         ), pruned AS (
           DELETE FROM anysentry_agent_semantic_kernel_relations_v1 AS existing
           USING latest_incoming
           WHERE existing.stable_semantic_event_id = latest_incoming.stable_semantic_event_id
             AND existing.resolution_revision <= latest_incoming.resolution_revision
             AND NOT EXISTS (
               SELECT 1
               FROM incoming
               WHERE incoming.record->>'relationId' = existing.relation_id
             )
           RETURNING existing.relation_id
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
         FROM incoming
         WHERE NOT EXISTS (
           SELECT 1
           FROM anysentry_agent_semantic_kernel_relations_v1 AS newer
           WHERE newer.stable_semantic_event_id = incoming.record->>'stableSemanticEventId'
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
        [JSON.stringify(rows)],
      );
      return true;
    } catch (error) {
      this.markUnavailable('save Agent Semantic Kernel relations', error);
      return false;
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
