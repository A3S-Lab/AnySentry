import { BadRequestException, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ClickHouseStore } from './clickhouse-store';
import {
  agentAssetIdAliasesForEvent,
  agentAssetIdForIdentityKey,
  agentIdentityKeysForEvent as semanticIdentityKeysForEvent,
  agentRuntimeInstanceIdForEvent,
  detectedAgentIdentity,
} from './agent-identity';
import {
  AgentClassification,
  AgentCriticality,
  AgentMetadataListItem,
  AgentMetadataRecord,
  AgentMetadataUpdateRequest,
  AgentReviewDecision,
  AgentReviewRequest,
  AgentReviewRevisionRecord,
  AgentWorkloadRef,
  EventMeta,
  JudgedEvent,
  WorkloadIdentitySnapshotEntry,
} from './types';
import { cleanText } from './redaction';
import { RelationalBusinessStore } from './relational-business-store.service';
import {
  normalizedReviewHistory,
  stableAgentReviewIdentityKeys,
  validReviewEffectiveAt,
} from './agent-review-safety';
import {
  resolveLogicalAgentDefinition,
  type LogicalAgentDefinition,
} from './canonical-observability';
import { captureClassificationDecision } from './identity-judgment-routing';

const RETAIN_LIMIT = 10_000;
const RELATIONAL_REFRESH_MS = 15_000;
const OBSERVED_ALIAS_MAX_ENTRIES = 50_000;
const OBSERVED_ALIAS_MAX_BYTES = 16 * 1024 * 1024;
const OBSERVED_ALIAS_TTL_MS = 30 * 60_000;

function legacyKey(workspacePath: string, agentId: string): string {
  return `${workspacePath}\0${agentId}`;
}

function assetKey(agentAssetId: string): string {
  return `asset\0${agentAssetId}`;
}

function iso(t = Date.now()): string {
  return new Date(t).toISOString().slice(0, 19).replace('T', ' ');
}

function clean(value: unknown, limit: number): string | undefined {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed ? trimmed.slice(0, limit) : undefined;
}

function managementSourceRef(record: Pick<AgentMetadataRecord, 'agentAssetId' | 'registrationRef'>): string {
  return `management:${createHash('sha256')
    .update(record.registrationRef ?? record.agentAssetId)
    .digest('hex').slice(0, 24)}`;
}

const LOGICAL_SCOPE_MODES = new Set<NonNullable<AgentMetadataRecord['logicalScopeMode']>>([
  'registered_definition', 'workflow_definition', 'service_definition', 'terminal', 'unresolved',
]);
const LOGICAL_DEFINITION_TYPES = new Set<NonNullable<AgentMetadataRecord['logicalDefinitionType']>>([
  'registered', 'workflow', 'service', 'graph', 'application', 'candidate',
]);

function cleanLogicalScopeMode(value: unknown): AgentMetadataRecord['logicalScopeMode'] | undefined {
  return LOGICAL_SCOPE_MODES.has(value as NonNullable<AgentMetadataRecord['logicalScopeMode']>)
    ? value as AgentMetadataRecord['logicalScopeMode'] : undefined;
}

function cleanLogicalDefinitionType(value: unknown): AgentMetadataRecord['logicalDefinitionType'] | undefined {
  return LOGICAL_DEFINITION_TYPES.has(value as NonNullable<AgentMetadataRecord['logicalDefinitionType']>)
    ? value as AgentMetadataRecord['logicalDefinitionType'] : undefined;
}

function cleanTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  return [...new Set(tags
    .map((tag) => cleanText(tag, 48))
    .filter((tag): tag is string => Boolean(tag)))]
    .slice(0, 24);
}

function cleanCriticality(value: unknown): AgentCriticality | undefined {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'critical' ? value : undefined;
}

function cleanReviewDecision(value: unknown): AgentReviewDecision | undefined {
  return value === 'confirmed_agent' || value === 'unknown' || value === 'non_agent' ? value : undefined;
}

function normalizeIdentityKey(value: unknown): string | undefined {
  const normalized = clean(value, 500)?.toLowerCase();
  return normalized || undefined;
}

function cleanIdentityKeys(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values
    .map((value) => normalizeIdentityKey(value))
    .filter((value): value is string => Boolean(value)))]
    .slice(0, 32);
}

function cleanWorkloadRef(value: unknown): AgentWorkloadRef | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const ref = value as AgentWorkloadRef;
  const environment =
    ref.environment === 'kubernetes' || ref.environment === 'docker' || ref.environment === 'host'
      ? ref.environment
      : undefined;
  const kind =
    ref.kind === 'pod' || ref.kind === 'container' || ref.kind === 'service' || ref.kind === 'process' || ref.kind === 'cgroup'
      ? ref.kind
      : undefined;
  const next: AgentWorkloadRef = {
    environment,
    kind,
    name: clean(ref.name, 240),
    namespace: clean(ref.namespace, 160),
    podName: clean(ref.podName, 240),
    podUid: clean(ref.podUid, 240),
    nodeName: clean(ref.nodeName, 240),
    containerName: clean(ref.containerName, 240),
    containerImage: clean(ref.containerImage, 500),
    ownerKind: clean(ref.ownerKind, 120),
    ownerName: clean(ref.ownerName, 240),
    systemdUnit: clean(ref.systemdUnit, 240),
    processName: clean(ref.processName, 240),
    executable: clean(ref.executable, 500),
  };
  return Object.values(next).some(Boolean) ? next : undefined;
}

const REVIEW_TRANSITIONS: Record<AgentClassification, ReadonlySet<AgentReviewDecision>> = {
  confirmed_agent: new Set(['unknown']),
  probable_agent: new Set(['confirmed_agent', 'unknown']),
  unknown: new Set(['confirmed_agent', 'non_agent']),
  non_agent: new Set(['unknown']),
};

export function isReviewTransitionAllowed(
  from: AgentClassification,
  to: AgentReviewDecision | 'clear',
): boolean {
  return to === 'clear' || from === to || REVIEW_TRANSITIONS[from].has(to);
}

export interface ResolvedAgentMetadata {
  agentAssetId: string;
  agentAssetAliases: string[];
  agentRuntimeInstanceId: string;
  agentRuntimeInstanceAliases: string[];
  agentProduct?: string;
  /** Canonical logical-definition fields are additive to the legacy asset projection. */
  logicalAgentId?: string;
  logicalAgentCandidateId?: string;
  logicalDefinitionId?: string;
  logicalDefinitionType?: AgentMetadataRecord['logicalDefinitionType'];
  logicalScopeMode?: AgentMetadataRecord['logicalScopeMode'];
  logicalIdentityAuthority?: 'management_registration' | 'authenticated_adapter' | 'inferred' | 'unknown';
  logicalDefinitionFingerprint?: string;
  ingestionSourceId?: string;
  tenantId?: string;
  ownerId?: string;
  profile?: string;
  profileVersion?: string;
  environmentId?: string;
  terminalContextId?: string;
  bindingQuality: 'exact' | 'weak';
  identityReasonCode: string;
  displayName?: string;
  detectedName?: string;
  detectedClassification: AgentClassification;
  effectiveClassification: AgentClassification;
  metadata?: AgentMetadataRecord;
  reviewConflict: boolean;
  reviewRevision?: number;
  reviewEffectiveAt?: number;
}

interface IndexedReviewRevision {
  recordKey: string;
  review: AgentReviewRevisionRecord;
}

interface ResolvedReview {
  record?: AgentMetadataRecord;
  review?: AgentReviewRevisionRecord;
  conflict: boolean;
}

@Injectable()
export class AgentMetadataService implements OnModuleInit, OnModuleDestroy {
  private readonly records = new Map<string, AgentMetadataRecord>();
  private readonly reviewIndex = new Map<string, string | null>();
  private readonly reviewHistoryIndex = new Map<string, IndexedReviewRevision[]>();
  private readonly identityIndex = new Map<string, string | null>();
  private readonly assetIndex = new Map<string, string | null>();
  private readonly legacyIndex = new Map<string, string | null>();
  private readonly aliasIndex = new Map<string, string | null>();
  /**
   * Query-time compatibility aliases observed from typed runtime evidence. They are intentionally
   * separate from persisted human metadata: seeing an equivalent Container/Process encoding may
   * canonicalise reads, but it must not silently create a permanent human review binding.
   */
  private readonly observedAssetAliases = new Map<string, { id: string; rank: number } | null>();
  private readonly observedAssetAliasMeta = new Map<string, { touchedAt: number; bytes: number }>();
  private observedAssetAliasBytes = 0;
  private observedAssetAliasEvictions = 0;
  private observedAssetAliasExpired = 0;
  private observedAssetAliasDropped = 0;
  private persistTimer?: NodeJS.Timeout;
  private relationalRefreshTimer?: NodeJS.Timeout;
  private readonly dirtyAssetIds = new Set<string>();
  private initialized = false;
  private reviewVersion = 0;

  constructor(
    private readonly ch: ClickHouseStore,
    private readonly relational: RelationalBusinessStore,
  ) {}

  async onModuleInit(): Promise<void> {
    const [clickHouseReady, relationalReady] = await Promise.all([
      this.ch.init(),
      this.relational.initialize(),
    ]);
    const [clickHouseRecords, relationalRecords] = await Promise.all([
      clickHouseReady ? this.ch.loadAgentMetadata() : Promise.resolve([]),
      relationalReady ? this.relational.loadAgentMetadata() : Promise.resolve([]),
    ]);
    for (const record of [...clickHouseRecords, ...relationalRecords]) {
      if (record.agentId && record.workspacePath) this.storeNormalized(this.normalize(record));
    }
    this.rebuildReviewIndex();
    this.reviewVersion = [...this.records.values()].reduce(
      (total, record) => Math.min(Number.MAX_SAFE_INTEGER, total + (record.reviewRevision ?? 0)),
      0,
    );

    const canonicalRecords = [...this.records.values()];
    if (canonicalRecords.length > 0) {
      if (clickHouseReady) {
        // Keep the ClickHouse migration copy until all deployments have PostgreSQL configured.
        await this.ch.saveAgentMetadata(canonicalRecords);
      }
      if (relationalReady) {
        // Idempotently backfill ClickHouse-only rows and reconcile by updatedAt.
        await this.relational.saveAgentMetadata(canonicalRecords);
      }
    }

    if (this.relational.configured()) {
      this.relationalRefreshTimer = setInterval(() => {
        void this.refreshRelationalRecords();
      }, RELATIONAL_REFRESH_MS);
      this.relationalRefreshTimer.unref();
    }
    this.initialized = true;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    if (this.relationalRefreshTimer) clearInterval(this.relationalRefreshTimer);
    await this.persist();
    this.observedAssetAliases.clear();
    this.observedAssetAliasMeta.clear();
    this.observedAssetAliasBytes = 0;
    this.dirtyAssetIds.clear();
  }

  private async refreshRelationalRecords(): Promise<void> {
    const loadedRecords = await this.relational.loadAgentMetadata();
    if (loadedRecords.length === 0) return;
    for (const record of loadedRecords) {
      if (record.agentId && record.workspacePath) this.storeNormalized(this.normalize(record));
    }
    this.rebuildReviewIndex();
  }

  get(workspacePath: string, agentId: string): AgentMetadataRecord | undefined {
    const recordKey = this.legacyIndex.get(legacyKey(workspacePath, agentId));
    const record = recordKey ? this.records.get(recordKey) : undefined;
    return record ? { ...record, tags: [...record.tags] } : undefined;
  }

  /**
   * Return the management-plane LogicalAgent definition for an observed asset, when one was
   * explicitly registered.  A missing definition is deliberately reported as `undefined`; callers
   * must keep the observation as a candidate rather than deriving a stable identity from a PID.
   */
  resolveRegisteredDefinition(
    workspacePath: string,
    agentId: string,
    agentAssetId?: string,
    context: {
      sourceId?: string;
      logicalAgentId?: string;
      logicalDefinitionId?: string;
      tenantId?: string;
      ownerId?: string;
      profile?: string;
      terminalContextId?: string;
      deploymentId?: string;
      deploymentRevision?: string;
      environmentId?: string;
    } = {},
  ): LogicalAgentDefinition | undefined {
    const requestedAsset = clean(agentAssetId, 160);
    const assetRecordKey = requestedAsset
      ? this.assetIndex.get(requestedAsset) ?? this.aliasIndex.get(requestedAsset)
      : undefined;
    // An observed-asset alias is a useful early index, not an authority boundary. It can be
    // absent/ambiguous while a new process generation is being materialized, so retain the exact
    // workspace+agent candidates as a fallback and let the hard scope filters below decide. This
    // prevents a transient asset-index miss from hiding a valid management registration, while
    // still refusing cross-workspace records.
    const workspaceCandidates = [...this.records.values()].filter((candidate) =>
      candidate.workspacePath === workspacePath && candidate.agentId === agentId,
    );
    const assetCandidate = assetRecordKey && assetRecordKey !== null
      ? this.records.get(assetRecordKey)
      : undefined;
    const candidates = [
      // An explicitly supplied asset alias cannot cross the workspace/agent boundary. If it
      // points elsewhere, ignore it and let the exact workspace candidate set (usually empty)
      // keep the lookup unresolved.
      ...(assetCandidate
        && assetCandidate.workspacePath === workspacePath
        ? [assetCandidate] : []),
      ...workspaceCandidates,
    ].filter((candidate, index, all) => all.findIndex((item) =>
      item.agentAssetId === candidate.agentAssetId
        && item.workspacePath === candidate.workspacePath
        && item.agentId === candidate.agentId,
    ) === index);
    const sourceId = clean(context.sourceId, 240);
    const logicalAgentId = clean(context.logicalAgentId, 240);
    const logicalDefinitionId = clean(context.logicalDefinitionId, 240);
    const tenantId = clean(context.tenantId, 240);
    const ownerId = clean(context.ownerId, 240);
    const profile = clean(context.profile, 240);
    const terminalContextId = clean(context.terminalContextId, 240);
    const deploymentId = clean(context.deploymentId, 240);
    const deploymentRevision = clean(context.deploymentRevision, 120);
    const environmentId = clean(context.environmentId, 240);
    const scopedCandidates = candidates.filter((candidate) => {
      if (candidate.ingestionSourceId && candidate.ingestionSourceId !== sourceId) return false;
      return true;
    });
    // Tenant/environment are the cross-boundary fences for a Source-bound registration. Profile,
    // deployment and terminal values may be stale producer hints (and are useful for selecting
    // among multiple definitions), but they must not veto a unique management row when the Source
    // and workspace already identify it.
    const hardScopeMatches = scopedCandidates.filter((candidate) => {
      if (tenantId && candidate.tenantId !== tenantId) return false;
      if (environmentId && candidate.environmentId !== environmentId) return false;
      return true;
    });
    const hintedMatches = hardScopeMatches.filter((candidate) => {
      if (logicalAgentId && candidate.logicalAgentId !== logicalAgentId) return false;
      if (logicalDefinitionId && candidate.logicalDefinitionId !== logicalDefinitionId) return false;
      if (ownerId && (candidate.ownerId ?? candidate.owner) !== ownerId) return false;
      if (profile && candidate.profile !== profile) return false;
      if (terminalContextId && candidate.terminalContextId !== terminalContextId) return false;
      if (deploymentId && candidate.deploymentId !== deploymentId) return false;
      if (deploymentRevision && candidate.deploymentRevision !== deploymentRevision) return false;
      return true;
    });
    // Producer hints are deliberately non-authoritative.  If they disagree with one unique
    // management registration, choose that registration and overwrite the hint; if several
    // definitions share the tuple, require an explicit matching hint/source binding instead of
    // picking whichever row was inserted first.
    const record = hintedMatches.length === 1
      ? hintedMatches[0]
      // Logical/profile/deployment/terminal IDs are producer hints and are intentionally soft: a
      // unique, source-bound management registration may overwrite stale/self-reported values.
      // Tenant and environment remain hard fences; ambiguity still stays unresolved instead of
      // selecting whichever definition was inserted first.
      : hardScopeMatches.length === 1 ? hardScopeMatches[0] : undefined;
    if (!record || (!record.logicalAgentId && !record.logicalDefinitionId)) return undefined;
    const definition = resolveLogicalAgentDefinition({
      ...(record.logicalAgentId ? { logicalAgentId: record.logicalAgentId } : {}),
      family: record.agentId,
      tenantId: record.tenantId,
      ownerId: record.ownerId ?? record.owner,
      workspacePath: record.workspacePath,
      profile: record.profile,
      profileVersion: record.profileVersion,
      deploymentId: record.deploymentId,
      deploymentRevision: record.deploymentRevision,
      environmentId: record.environmentId,
      definitionId: record.logicalDefinitionId,
      definitionType: record.logicalDefinitionType ?? (record.logicalDefinitionId ? 'registered' : undefined),
      logicalScopeMode: record.logicalScopeMode,
      terminalContextId: record.terminalContextId,
      authority: 'management_registration',
      sourceRefs: [managementSourceRef(record)],
    }).definition;
    return definition.identityQuality === 'confirmed'
      || (Boolean(record.logicalDefinitionId) && definition.identityQuality === 'strong')
      ? definition
      : undefined;
  }

  private pruneObservedAssetAliases(at = Date.now()): void {
    for (const [key, meta] of this.observedAssetAliasMeta) {
      if (at - meta.touchedAt <= OBSERVED_ALIAS_TTL_MS) continue;
      this.observedAssetAliasMeta.delete(key);
      this.observedAssetAliases.delete(key);
      this.observedAssetAliasBytes = Math.max(0, this.observedAssetAliasBytes - meta.bytes);
      this.observedAssetAliasExpired += 1;
    }
    while (
      this.observedAssetAliasMeta.size > OBSERVED_ALIAS_MAX_ENTRIES
      || this.observedAssetAliasBytes > OBSERVED_ALIAS_MAX_BYTES
    ) {
      const oldest = this.observedAssetAliasMeta.entries().next().value as
        | [string, { touchedAt: number; bytes: number }]
        | undefined;
      if (!oldest) break;
      this.observedAssetAliasMeta.delete(oldest[0]);
      this.observedAssetAliases.delete(oldest[0]);
      this.observedAssetAliasBytes = Math.max(0, this.observedAssetAliasBytes - oldest[1].bytes);
      this.observedAssetAliasEvictions += 1;
    }
  }

  private setObservedAssetAlias(
    key: string,
    value: { id: string; rank: number } | null,
    at = Date.now(),
  ): void {
    const normalized = clean(key, 512);
    if (!normalized) {
      this.observedAssetAliasDropped += 1;
      return;
    }
    const bytes = Buffer.byteLength(normalized, 'utf8') + 64;
    if (bytes > OBSERVED_ALIAS_MAX_BYTES) {
      this.observedAssetAliasDropped += 1;
      return;
    }
    const previous = this.observedAssetAliasMeta.get(normalized);
    if (previous) this.observedAssetAliasBytes = Math.max(0, this.observedAssetAliasBytes - previous.bytes);
    this.observedAssetAliases.delete(normalized);
    this.observedAssetAliases.set(normalized, value);
    this.observedAssetAliasMeta.delete(normalized);
    this.observedAssetAliasMeta.set(normalized, { touchedAt: at, bytes });
    this.observedAssetAliasBytes += bytes;
    this.pruneObservedAssetAliases(at);
  }

  hotStateStats() {
    this.pruneObservedAssetAliases();
    return {
      observedAssetAliases: {
        entries: this.observedAssetAliases.size,
        bytes: this.observedAssetAliasBytes,
        maxEntries: OBSERVED_ALIAS_MAX_ENTRIES,
        maxBytes: OBSERVED_ALIAS_MAX_BYTES,
        ttlMs: OBSERVED_ALIAS_TTL_MS,
        evicted: this.observedAssetAliasEvictions,
        expired: this.observedAssetAliasExpired,
        dropped: this.observedAssetAliasDropped,
      },
      dirtyAssetIds: {
        entries: this.dirtyAssetIds.size,
        maxEntries: RETAIN_LIMIT,
      },
    };
  }

  canonicalAgentAssetId(agentAssetId: string): string {
    const normalized = clean(agentAssetId, 160) ?? agentAssetId;
    this.pruneObservedAssetAliases();
    const recordKey = this.assetIndex.get(normalized) ?? this.aliasIndex.get(normalized);
    if (recordKey) return this.records.get(recordKey)?.agentAssetId ?? normalized;
    let current = normalized;
    const seen = new Set<string>();
    for (let depth = 0; depth < 8; depth += 1) {
      if (seen.has(current)) return normalized;
      seen.add(current);
      const next = this.observedAssetAliases.get(current);
      if (this.observedAssetAliasMeta.has(current) && next !== undefined) {
        this.setObservedAssetAlias(current, next);
      }
      if (!next) return current;
      const persisted = this.assetIndex.get(next.id) ?? this.aliasIndex.get(next.id);
      if (persisted) return this.records.get(persisted)?.agentAssetId ?? next.id;
      current = next.id;
    }
    return normalized;
  }

  private rememberObservedAssetAliases(canonicalAssetId: string, aliases: string[], rank: number): string {
    this.pruneObservedAssetAliases();
    const members = cleanIdentityKeys([canonicalAssetId, ...aliases]);
    const candidates = new Map<string, number>([[canonicalAssetId, rank]]);
    for (const member of members) {
      const current = this.observedAssetAliases.get(member);
      if (current) candidates.set(current.id, Math.max(candidates.get(current.id) ?? 0, current.rank));
    }
    const highest = Math.max(...candidates.values());
    const winners = [...candidates.entries()].filter(([, candidateRank]) => candidateRank === highest);
    if (winners.length !== 1) {
      for (const member of members) if (member !== canonicalAssetId) this.setObservedAssetAlias(member, null);
      return canonicalAssetId;
    }
    const [winner, winnerRank] = winners[0];
    for (const [candidate] of candidates) {
      if (candidate !== winner) this.setObservedAssetAlias(candidate, { id: winner, rank: winnerRank });
    }
    for (const member of members) {
      if (member !== winner) this.setObservedAssetAlias(member, { id: winner, rank: winnerRank });
    }
    return winner;
  }

  update(agentId: string, input: AgentMetadataUpdateRequest): AgentMetadataListItem {
    const workspacePath = clean(input.workspacePath, 500) ?? 'unknown';
    if (input.logicalScopeMode !== undefined && !cleanLogicalScopeMode(input.logicalScopeMode)) {
      throw new BadRequestException('logicalScopeMode is invalid');
    }
    if (input.logicalDefinitionType !== undefined && !cleanLogicalDefinitionType(input.logicalDefinitionType)) {
      throw new BadRequestException('logicalDefinitionType is invalid');
    }
    if (input.logicalScopeMode === 'terminal'
      && !clean(input.terminalContextId, 240)) {
      throw new BadRequestException('terminalContextId is required for terminal logical scope');
    }
    const inputAssetId = clean(input.agentAssetId, 160);
    const curKey = this.findRecordKey(inputAssetId, workspacePath, agentId, input.identityKeys, {
      ingestionSourceId: input.ingestionSourceId,
      logicalAgentId: input.logicalAgentId,
      logicalDefinitionId: input.logicalDefinitionId,
      tenantId: input.tenantId,
      ownerId: input.ownerId,
      profile: input.profile,
      terminalContextId: input.terminalContextId,
      deploymentId: input.deploymentId,
      deploymentRevision: input.deploymentRevision,
      environmentId: input.environmentId,
    });
    const cur = curKey ? this.records.get(curKey) : undefined;
    const canonicalAssetId = this.canonicalAssetIdForMutation(agentId, workspacePath, input, cur);
    const next: AgentMetadataRecord = {
      agentId: cur?.agentId ?? clean(agentId, 240) ?? agentId,
      agentAssetId: canonicalAssetId,
      agentAssetAliases: this.assetAliases(cur, canonicalAssetId, workspacePath, agentId),
      logicalAgentId: 'logicalAgentId' in input ? clean(input.logicalAgentId, 240) : cur?.logicalAgentId,
      logicalDefinitionId: 'logicalDefinitionId' in input ? clean(input.logicalDefinitionId, 240) : cur?.logicalDefinitionId,
      logicalDefinitionType: 'logicalDefinitionType' in input
        ? cleanLogicalDefinitionType(input.logicalDefinitionType) : cur?.logicalDefinitionType,
      logicalScopeMode: 'logicalScopeMode' in input
        ? cleanLogicalScopeMode(input.logicalScopeMode) : cur?.logicalScopeMode,
      logicalIdentityAuthority: ('logicalAgentId' in input || 'logicalDefinitionId' in input
        || cur?.logicalAgentId || cur?.logicalDefinitionId) ? 'management_registration' : undefined,
      registrationRef: 'registrationRef' in input ? clean(input.registrationRef, 240) : cur?.registrationRef,
      ingestionSourceId: 'ingestionSourceId' in input
        ? clean(input.ingestionSourceId, 240) : cur?.ingestionSourceId,
      tenantId: 'tenantId' in input ? clean(input.tenantId, 240) : cur?.tenantId,
      ownerId: 'ownerId' in input ? clean(input.ownerId, 240) : cur?.ownerId,
      profile: 'profile' in input ? clean(input.profile, 240) : cur?.profile,
      profileVersion: 'profileVersion' in input ? clean(input.profileVersion, 120) : cur?.profileVersion,
      deploymentId: 'deploymentId' in input ? clean(input.deploymentId, 240) : cur?.deploymentId,
      deploymentRevision: 'deploymentRevision' in input ? clean(input.deploymentRevision, 120) : cur?.deploymentRevision,
      environmentId: 'environmentId' in input ? clean(input.environmentId, 240) : cur?.environmentId,
      terminalContextId: 'terminalContextId' in input ? clean(input.terminalContextId, 240) : cur?.terminalContextId,
      workspacePath: cur?.workspacePath ?? workspacePath,
      displayName: 'displayName' in input ? cleanText(input.displayName, 160) : cur?.displayName,
      owner: 'owner' in input ? cleanText(input.owner, 160) : cur?.owner,
      team: 'team' in input ? cleanText(input.team, 160) : cur?.team,
      environment: 'environment' in input ? cleanText(input.environment, 80) : cur?.environment,
      criticality: 'criticality' in input ? cleanCriticality(input.criticality) : cur?.criticality,
      tags: 'tags' in input ? cleanTags(input.tags) : cur?.tags ?? [],
      note: 'note' in input ? cleanText(input.note, 2_000) : cur?.note,
      identityKeys: 'identityKeys' in input ? cleanIdentityKeys(input.identityKeys) : cur?.identityKeys,
      physicalWorkloadId: 'physicalWorkloadId' in input
        ? clean(input.physicalWorkloadId, 500)
        : cur?.physicalWorkloadId,
      agentInstanceId: 'agentInstanceId' in input
        ? clean(input.agentInstanceId, 500)
        : cur?.agentInstanceId,
      workloadRef: 'workloadRef' in input ? cleanWorkloadRef(input.workloadRef) : cur?.workloadRef,
      reviewDecision: cur?.reviewDecision,
      reviewedBy: cur?.reviewedBy,
      reviewedAt: cur?.reviewedAt,
      reviewNote: cur?.reviewNote,
      reviewIdentityKeys: cur?.reviewIdentityKeys,
      reviewPhysicalWorkloadId: cur?.reviewPhysicalWorkloadId,
      reviewAgentInstanceId: cur?.reviewAgentInstanceId,
      reviewWorkloadRef: cur?.reviewWorkloadRef,
      reviewRevision: cur?.reviewRevision,
      reviewEffectiveAt: cur?.reviewEffectiveAt,
      reviewHistory: cur?.reviewHistory,
      updatedAt: Date.now(),
    };
    // Management updates are replacement semantics for explicitly supplied identity fields.  Do
    // not nullish-merge an intentional clear (`logicalDefinitionId: ''`, scope=`unresolved`) back
    // into the prior registered definition; that would leave a disabled test registration able to
    // authorize future observations.
    this.storeNormalized(next, curKey, true);
    this.dirtyAssetIds.add(next.agentAssetId);
    this.trim();
    this.rebuildReviewIndex();
    this.persistSoon();
    return this.item(this.records.get(assetKey(next.agentAssetId)) ?? next);
  }

  review(
    agentId: string,
    input: AgentReviewRequest,
    reviewer?: string,
    effectiveAtInput = Date.now(),
  ): AgentMetadataListItem {
    const workspacePath = clean(input.workspacePath, 500) ?? 'unknown';
    const inputAssetId = clean(input.agentAssetId, 160);
    const recordKey = this.findRecordKey(inputAssetId, workspacePath, agentId, input.identityKeys);
    const cur = recordKey ? this.records.get(recordKey) : undefined;
    const canonicalAssetId = this.canonicalAssetIdForMutation(agentId, workspacePath, input, cur);
    const decision = cleanReviewDecision(input.decision);
    const currentRevision = cur?.reviewRevision ?? cur?.reviewHistory?.at(-1)?.revision ?? 0;
    if (input.expectedRevision !== undefined && (
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 0 ||
      input.expectedRevision !== currentRevision
    )) {
      throw new BadRequestException(
        `Agent review revision conflict: expected ${input.expectedRevision}, current ${currentRevision}`,
      );
    }
    const currentClassification =
      cur?.reviewDecision ??
      (
        input.currentClassification === 'confirmed_agent' ||
        input.currentClassification === 'probable_agent' ||
        input.currentClassification === 'unknown' ||
        input.currentClassification === 'non_agent'
          ? input.currentClassification
          : 'unknown'
      );
    if (!isReviewTransitionAllowed(currentClassification, input.decision)) {
      throw new BadRequestException(
        `cannot change Agent classification from ${currentClassification} to ${input.decision}`,
      );
    }
    const workloadRef = cleanWorkloadRef(input.workloadRef) ?? cur?.workloadRef ?? cur?.reviewWorkloadRef;
    const physicalWorkloadId = clean(input.physicalWorkloadId, 500) ?? cur?.physicalWorkloadId;
    const agentInstanceId = clean(input.agentInstanceId, 500) ?? cur?.agentInstanceId;
    const identityKeys = decision
      ? stableAgentReviewIdentityKeys({
          identityKeys: input.identityKeys ?? cur?.identityKeys ?? cur?.reviewIdentityKeys,
          physicalWorkloadId,
          agentInstanceId,
          workloadRef,
        })
      : [];
    if (decision && identityKeys.length === 0) {
      throw new BadRequestException(
        'a stable review identity is required; bare process names, sessions, short PIDs, and start-unknown keys cannot be reviewed',
      );
    }
    const previousActiveKeys = cur?.reviewDecision ? [...(cur.reviewIdentityKeys ?? [])] : [];
    const clearedIdentityKeys = decision
      ? previousActiveKeys.filter((key) => !identityKeys.includes(key))
      : previousActiveKeys;
    const previousEffectiveAt = cur?.reviewEffectiveAt ?? cur?.reviewHistory?.at(-1)?.effectiveAt ?? 0;
    const effectiveAt = validReviewEffectiveAt(effectiveAtInput);
    if (effectiveAt < previousEffectiveAt) {
      throw new BadRequestException(
        `Agent review effective time must be monotonic: previous ${previousEffectiveAt}, next ${effectiveAt}`,
      );
    }
    const reviewRevision = currentRevision + 1;
    const revision: AgentReviewRevisionRecord = {
      revision: reviewRevision,
      decision: decision ?? 'clear',
      effectiveAt,
      reviewedBy: clean(reviewer, 240),
      note: cleanText(input.note, 2_000),
      identityKeys: decision ? [...identityKeys] : [...previousActiveKeys],
      clearedIdentityKeys: clearedIdentityKeys.length ? clearedIdentityKeys : undefined,
      physicalWorkloadId,
      agentInstanceId,
      workloadRef,
    };
    const reviewHistory = normalizedReviewHistory([...(cur?.reviewHistory ?? []), revision]);
    const next: AgentMetadataRecord = {
      agentId: cur?.agentId ?? clean(agentId, 240) ?? agentId,
      agentAssetId: canonicalAssetId,
      agentAssetAliases: this.assetAliases(cur, canonicalAssetId, workspacePath, agentId),
      logicalAgentId: cur?.logicalAgentId,
      logicalDefinitionId: cur?.logicalDefinitionId,
      logicalDefinitionType: cur?.logicalDefinitionType,
      logicalScopeMode: cur?.logicalScopeMode,
      logicalIdentityAuthority: cur?.logicalIdentityAuthority,
      registrationRef: cur?.registrationRef,
      ingestionSourceId: cur?.ingestionSourceId,
      tenantId: cur?.tenantId,
      ownerId: cur?.ownerId,
      profile: cur?.profile,
      profileVersion: cur?.profileVersion,
      deploymentId: cur?.deploymentId,
      deploymentRevision: cur?.deploymentRevision,
      environmentId: cur?.environmentId,
      terminalContextId: cur?.terminalContextId,
      workspacePath: cur?.workspacePath ?? workspacePath,
      displayName: cur?.displayName,
      owner: cur?.owner,
      team: cur?.team,
      environment: cur?.environment,
      criticality: cur?.criticality,
      tags: cur?.tags ?? [],
      note: cur?.note,
      identityKeys: cur?.identityKeys?.length ? cur.identityKeys : identityKeys,
      physicalWorkloadId: decision
        ? physicalWorkloadId
        : cur?.physicalWorkloadId,
      agentInstanceId: decision
        ? agentInstanceId
        : cur?.agentInstanceId,
      workloadRef: decision
        ? workloadRef
        : cur?.workloadRef,
      reviewDecision: decision,
      reviewedBy: decision ? revision.reviewedBy : undefined,
      reviewedAt: decision ? effectiveAt : undefined,
      reviewNote: decision ? cleanText(input.note, 2_000) : undefined,
      reviewIdentityKeys: decision ? identityKeys : undefined,
      reviewPhysicalWorkloadId: decision ? physicalWorkloadId : undefined,
      reviewAgentInstanceId: decision ? agentInstanceId : undefined,
      reviewWorkloadRef: decision ? workloadRef : undefined,
      reviewRevision,
      reviewEffectiveAt: effectiveAt,
      reviewHistory,
      updatedAt: Math.max(Date.now(), effectiveAt),
    };
    this.storeNormalized(next, recordKey);
    this.dirtyAssetIds.add(next.agentAssetId);
    this.trim();
    this.reviewVersion += 1;
    this.rebuildReviewIndex();
    this.persistSoon();
    return this.item(this.records.get(assetKey(next.agentAssetId)) ?? next);
  }

  logicalIdentityKeysForEvent(
    event: Pick<JudgedEvent, 'agentId' | 'workspacePath' | 'userId' | 'process' | 'attribution' | 'logicalAgentId' | 'logicalDefinitionId'>,
  ): string[] {
    const attribution = event.attribution;
    const workload = attribution?.workloadRef;
    const host = clean(event.process?.hostId, 240);
    const agentId = clean(
      attribution?.agentScopeId ?? attribution?.agentDisplayName ?? event.agentId,
      240,
    );
    if (!agentId) return [];

    if (event.logicalAgentId) {
      return cleanIdentityKeys([
        `logical-agent:${event.logicalAgentId}`,
        event.logicalDefinitionId ? `logical-definition:${event.logicalDefinitionId}` : undefined,
      ]);
    }

    if (workload?.podUid && workload.namespace) {
      const owner = clean(workload.ownerName ?? workload.podName, 240);
      if (owner) {
        return cleanIdentityKeys([
          `logical:k8s:${workload.namespace}:${workload.ownerKind ?? 'pod'}:${owner}:${workload.containerName ?? 'container'}:${agentId}`,
        ]);
      }
    }

    if (workload?.environment === 'docker' && host && workload.containerName && workload.containerImage) {
      return cleanIdentityKeys([
        `logical:docker:${host}:${workload.containerName}:${workload.containerImage}:${agentId}`,
      ]);
    }

    const systemdUnit = clean(event.process?.systemdUnit ?? workload?.systemdUnit, 240);
    if (host && systemdUnit?.endsWith('.service') && !systemdUnit.startsWith('session-')) {
      return cleanIdentityKeys([`logical:systemd:${host}:${systemdUnit}:${agentId}`]);
    }

    if (host) return cleanIdentityKeys([`logical:host:${host}:${agentId}`]);
    return [];
  }

  identityKeysForEvent(
    event: Pick<JudgedEvent, 'agentId' | 'workspacePath' | 'userId' | 'sessionId' | 'attributes' | 'process' | 'attribution' | 'logicalAgentId' | 'logicalDefinitionId'>,
  ): string[] {
    const attribution = event.attribution;
    const logicalKeys = this.logicalIdentityKeysForEvent(event);
    const strongValues: unknown[] = [
      ...semanticIdentityKeysForEvent(event),
      attribution?.physicalWorkloadId,
      attribution?.agentInstanceId,
      attribution?.workloadRef?.podUid,
      agentRuntimeInstanceIdForEvent(event),
    ];
    for (const candidate of [attribution?.physicalWorkloadId, attribution?.agentInstanceId]) {
      const normalized = normalizeIdentityKey(candidate);
      if (normalized?.startsWith('container:')) strongValues.push(normalized.slice('container:'.length));
    }
    const cgroup = event.process?.cgroup ?? '';
    for (const match of cgroup.matchAll(/(?:cri-containerd|docker|crio|libpod)[-/]([a-f0-9]{12,64})(?:\.scope)?/gi)) {
      strongValues.push(match[1], match[1]?.slice(0, 12));
    }
    for (const match of cgroup.matchAll(/kubepods[^/]*[-/]pod([a-f0-9_-]{16,})/gi)) {
      const podUid = match[1]?.replace(/_/g, '-');
      strongValues.push(podUid);
    }
    const strong = cleanIdentityKeys(strongValues);
    if (strong.length > 0) return cleanIdentityKeys([...strong, ...logicalKeys]);

    const host = clean(event.process?.hostId, 240) ?? 'host';
    const boot = clean(event.process?.bootId, 240) ?? 'boot';
    if (attribution?.rootPid) {
      return cleanIdentityKeys([
        `host:${host}:${boot}:root:${attribution.rootPid}:${attribution.rootStartTime ?? 'start-unknown'}`,
        // Keep the previous identity shape as a migration alias so existing human reviews remain
        // attached after workspace-independent, PID-reuse-safe instance identity is enabled.
        `host:${host}:${boot}:root:${attribution.rootPid}:${attribution.agentScopeId ?? attribution.agentDisplayName ?? event.agentId}`,
        ...logicalKeys,
      ]);
    }
    if (event.process?.pid && (event.process.startTimeTicks || event.process.startTimeNs)) {
      return cleanIdentityKeys([
        `host:${host}:${boot}:process:${event.process.pid}:${event.process.startTimeTicks ?? event.process.startTimeNs}:${event.process.exe ?? event.process.comm ?? event.agentId}`,
        ...logicalKeys,
      ]);
    }
    const systemdUnit = clean(event.process?.systemdUnit, 240);
    if (systemdUnit?.endsWith('.service') && !systemdUnit.startsWith('session-')) {
      return cleanIdentityKeys([`systemd:${host}:${systemdUnit}`, ...logicalKeys]);
    }
    // session-*.scope is a shared runtime boundary, never an Agent review or suppression key.
    return cleanIdentityKeys([
      ...logicalKeys,
      event.agentId,
      event.sessionId?.startsWith('session-') ? undefined : event.sessionId,
    ]);
  }

  private currentReviewForIdentityKeys(identityKeys: string[]): ResolvedReview {
    let recordKey: string | null | undefined;
    for (const identityKey of identityKeys) {
      const indexed = this.reviewIndex.get(identityKey);
      if (indexed === null) return { conflict: true };
      if (!indexed) continue;
      if (recordKey && recordKey !== indexed) return { conflict: true };
      recordKey = indexed;
    }
    if (!recordKey) return { conflict: false };
    const record = this.records.get(recordKey);
    if (!record?.reviewDecision) return { conflict: false };
    const review = record.reviewHistory?.find((item) => item.revision === record.reviewRevision);
    return {
      record,
      review: review ?? {
        revision: record.reviewRevision ?? 1,
        decision: record.reviewDecision,
        effectiveAt: record.reviewEffectiveAt ?? record.reviewedAt ?? record.updatedAt,
        reviewedBy: record.reviewedBy,
        note: record.reviewNote,
        identityKeys: [...(record.reviewIdentityKeys ?? [])],
        physicalWorkloadId: record.reviewPhysicalWorkloadId,
        agentInstanceId: record.reviewAgentInstanceId,
        workloadRef: record.reviewWorkloadRef,
      },
      conflict: false,
    };
  }

  private temporalReviewForIdentityKeys(identityKeys: string[], eventAt: number): ResolvedReview {
    const byRecord = new Map<string, IndexedReviewRevision>();
    for (const identityKey of identityKeys) {
      for (const indexed of this.reviewHistoryIndex.get(identityKey) ?? []) {
        if (indexed.review.effectiveAt > eventAt) continue;
        const current = byRecord.get(indexed.recordKey);
        const newer = !current ||
          indexed.review.revision > current.review.revision ||
          (
            indexed.review.revision === current.review.revision &&
            indexed.review.effectiveAt > current.review.effectiveAt
          ) ||
          (
            indexed.review.revision === current.review.revision &&
            indexed.review.effectiveAt === current.review.effectiveAt &&
            current.review.decision === 'clear' && indexed.review.decision !== 'clear'
          );
        if (newer) byRecord.set(indexed.recordKey, indexed);
      }
    }
    if (byRecord.size > 1) return { conflict: true };
    const selected = byRecord.values().next().value as IndexedReviewRevision | undefined;
    if (!selected || selected.review.decision === 'clear') return { conflict: false };
    return {
      record: this.records.get(selected.recordKey),
      review: selected.review,
      conflict: false,
    };
  }

  private reviewForIdentityKeys(identityKeys: string[], eventAt?: number): ResolvedReview {
    return Number.isSafeInteger(eventAt) && Number(eventAt) >= 0
      ? this.temporalReviewForIdentityKeys(identityKeys, Number(eventAt))
      : this.currentReviewForIdentityKeys(identityKeys);
  }

  resolveEvent(event: JudgedEvent, eventAt?: number): ResolvedAgentMetadata {
    const detected = detectedAgentIdentity(event);
    const detectedAssetAliases = agentAssetIdAliasesForEvent(event);
    this.rememberObservedAssetAliases(
      detected.agentAssetId,
      detectedAssetAliases,
      detected.identityResolutionRank,
    );
    const exactRecordKey = this.legacyIndex.get(legacyKey(event.workspacePath, event.agentId));
    const exact = exactRecordKey ? this.records.get(exactRecordKey) : undefined;
    let assetRecordKey: string | null | undefined;
    for (const assetId of detectedAssetAliases) {
      const indexed = this.assetIndex.get(assetId) ?? this.aliasIndex.get(assetId);
      if (indexed === null) {
        assetRecordKey = null;
        break;
      }
      if (!indexed) continue;
      if (assetRecordKey && assetRecordKey !== indexed) {
        assetRecordKey = null;
        break;
      }
      assetRecordKey = indexed;
    }
    const identityKeys = this.identityKeysForEvent(event);
    let identityRecordKey: string | null | undefined;
    for (const identityKey of identityKeys) {
      const indexed = this.identityIndex.get(identityKey);
      if (indexed === null) {
        identityRecordKey = null;
        break;
      }
      if (indexed) identityRecordKey = indexed;
    }
    const metadataRecordKey =
      assetRecordKey === null || identityRecordKey === null
        ? undefined
        : assetRecordKey ?? identityRecordKey;
    const indexedMetadata = metadataRecordKey ? this.records.get(metadataRecordKey) : undefined;
    const metadata = (
      indexedMetadata
      && indexedMetadata.workspacePath === event.workspacePath
      // A child process (curl/bash/python) may have a different display agentId; the asset index
      // and process/root identity establish the same workspace-scoped runtime. Cross-workspace
      // aliases are rejected above and can never enter this overlay.
      ? indexedMetadata
      : undefined
    ) ?? exact;
    const eventSourceId = clean(event.attributes?.sourceId, 240);
    const rejectedCorrelationClaim = Boolean(
      event.attribution?.correlation?.claimReceipts?.some((receipt) => receipt.decision === 'rejected'),
    );
    const metadataScopeCompatible = Boolean(metadata) && !rejectedCorrelationClaim
      && (!event.tenantId || !metadata?.tenantId || event.tenantId === metadata.tenantId)
      && (!event.environmentId || !metadata?.environmentId || event.environmentId === metadata.environmentId)
      && (!eventSourceId || !metadata?.ingestionSourceId || eventSourceId === metadata.ingestionSourceId)
      // An event that still carries producer logical IDs but no authenticated authority must not
      // be upgraded merely because a query-time asset alias happens to point at a registration.
      && (event.logicalIdentityAuthority === 'management_registration'
        || event.logicalIdentityAuthority === 'authenticated_adapter'
        || (!event.logicalAgentId && !event.logicalDefinitionId));
    const managedDefinition = metadataScopeCompatible && metadata && (metadata.logicalAgentId || metadata.logicalDefinitionId)
      ? resolveLogicalAgentDefinition({
          ...(metadata.logicalAgentId ? { logicalAgentId: metadata.logicalAgentId } : {}),
          family: metadata.agentId,
          tenantId: metadata.tenantId,
          ownerId: metadata.ownerId ?? metadata.owner,
          workspacePath: metadata.workspacePath,
          profile: metadata.profile,
          profileVersion: metadata.profileVersion,
          deploymentId: metadata.deploymentId,
          deploymentRevision: metadata.deploymentRevision,
          definitionId: metadata.logicalDefinitionId,
          definitionType: metadata.logicalDefinitionType ?? (metadata.logicalDefinitionId ? 'registered' : undefined),
          logicalScopeMode: metadata.logicalScopeMode,
          terminalContextId: metadata.terminalContextId,
          authority: 'management_registration',
          sourceRefs: [managementSourceRef(metadata)],
        }).definition
      : undefined;
    const resolvedReview = this.reviewForIdentityKeys(identityKeys, eventAt);
    const reviewDecision = resolvedReview.review?.decision;
    let agentAssetId = metadata?.agentAssetId ?? this.canonicalAgentAssetId(detected.agentAssetId);
    let agentAssetAliases = cleanIdentityKeys([
      ...detectedAssetAliases,
      ...(metadata?.agentAssetAliases ?? []),
    ]).filter((alias) => alias !== agentAssetId);
    agentAssetId = this.rememberObservedAssetAliases(
      agentAssetId,
      agentAssetAliases,
      metadata ? 10 : detected.identityResolutionRank,
    );
    agentAssetAliases = cleanIdentityKeys([
      detected.agentAssetId,
      ...agentAssetAliases,
    ]).filter((alias) => alias !== agentAssetId);
    return {
      agentAssetId,
      agentAssetAliases,
      agentRuntimeInstanceId: detected.agentRuntimeInstanceId,
      agentRuntimeInstanceAliases: detected.agentRuntimeInstanceAliases,
      agentProduct: detected.agentProduct,
      logicalAgentId: detected.logicalAgentId ?? managedDefinition?.logicalAgentId ?? metadata?.logicalAgentId,
      logicalAgentCandidateId: detected.logicalAgentCandidateId,
      logicalDefinitionId: detected.logicalDefinitionId ?? managedDefinition?.definitionId ?? metadata?.logicalDefinitionId,
      logicalDefinitionType: metadata?.logicalDefinitionType,
      logicalScopeMode: detected.logicalScopeMode ?? managedDefinition?.logicalScopeMode ?? metadata?.logicalScopeMode,
      logicalIdentityAuthority: detected.logicalIdentityAuthority
        ?? (managedDefinition ? managedDefinition.logicalIdentityAuthority : undefined),
      logicalDefinitionFingerprint: detected.logicalDefinitionFingerprint ?? managedDefinition?.definitionFingerprint,
      tenantId: metadata?.tenantId,
      ownerId: metadata?.ownerId ?? metadata?.owner,
      profile: metadata?.profile,
      profileVersion: metadata?.profileVersion,
      environmentId: metadata?.environmentId,
      terminalContextId: detected.terminalContextId ?? managedDefinition?.terminalContextId ?? metadata?.terminalContextId,
      bindingQuality: detected.bindingQuality,
      identityReasonCode: detected.identityReasonCode,
      displayName: metadata?.displayName,
      detectedName: detected.detectedName,
      detectedClassification: detected.detectedClassification,
      effectiveClassification:
        reviewDecision && reviewDecision !== 'clear'
          ? reviewDecision
          : captureClassificationDecision(detected.detectedClassification).effective,
      metadata,
      reviewConflict: resolvedReview.conflict,
      reviewRevision: resolvedReview.review?.revision,
      reviewEffectiveAt: resolvedReview.review?.effectiveAt,
    };
  }

  applyReview(meta: EventMeta, eventAt?: number): EventMeta {
    const identityKeys = this.identityKeysForEvent(meta as JudgedEvent);
    const resolved = this.reviewForIdentityKeys(identityKeys, eventAt);
    const record = resolved.record;
    const review = resolved.review;
    if (resolved.conflict || !record || !review || review.decision === 'clear') return meta;
    const confirmed = review.decision === 'confirmed_agent';
    const rejected = review.decision === 'non_agent';
    const previous = meta.attribution;
    const evidence = [
      ...(previous?.evidence ?? []),
      `manual_review:${review.decision}`,
      `manual_review:revision=${review.revision}`,
      ...(review.reviewedBy ? [`manual_review:reviewer=${review.reviewedBy}`] : []),
    ].slice(-16);
    return {
      ...meta,
      logicalAgentId: meta.logicalAgentId ?? record.logicalAgentId,
      logicalDefinitionId: meta.logicalDefinitionId ?? record.logicalDefinitionId,
      logicalScopeMode: meta.logicalScopeMode ?? record.logicalScopeMode,
      terminalContextId: meta.terminalContextId ?? record.terminalContextId,
      attribution: {
        monitored: confirmed,
        classification: review.decision,
        agentScopeId: previous?.agentScopeId ?? (confirmed ? record.agentId : undefined),
        agentDisplayName:
          previous?.agentDisplayName ??
          review.workloadRef?.podName ??
          review.workloadRef?.containerName ??
          review.workloadRef?.processName ??
          record.agentId,
        agentSessionId: previous?.agentSessionId,
        // Classification belongs to the logical Agent. Runtime identity belongs to the observed
        // process/container and must never be copied from the instance that was originally
        // reviewed onto a later terminal window or PID lifetime.
        agentInstanceId: previous?.agentInstanceId,
        // Preserve the observed root ProcessKey across a human classification overlay. The Judge
        // still discards any inbound correlation and resolves a fresh server-owned view.
        rootKey: previous?.rootKey,
        physicalWorkloadId: previous?.physicalWorkloadId,
        workloadRef: previous?.workloadRef ?? review.workloadRef,
        rootPid: previous?.rootPid,
        rootStartTime: previous?.rootStartTime,
        confidence: 1,
        reason: confirmed ? 'human_confirmed' : rejected ? 'human_rejected' : 'human_deferred',
        source: 'manual_review',
        evidence,
      },
    };
  }

  identitySnapshotEntries(nodeName?: string): WorkloadIdentitySnapshotEntry[] {
    const normalizedNode = clean(nodeName, 240);
    return [...this.records.values()]
      .filter((record) =>
        Boolean(record.reviewDecision && record.reviewIdentityKeys?.length) &&
        (!normalizedNode || !record.reviewWorkloadRef?.nodeName || record.reviewWorkloadRef.nodeName === normalizedNode)
      )
      .map((record): WorkloadIdentitySnapshotEntry => {
        const workload = record.reviewWorkloadRef;
        const environment = workload?.environment;
        const source =
          environment === 'kubernetes'
            ? 'kubernetes'
            : environment === 'docker'
              ? 'docker'
              : 'host';
        return {
          ids: [...(record.reviewIdentityKeys ?? [])],
          classification: record.reviewDecision!,
          physicalWorkloadId:
            record.reviewPhysicalWorkloadId ??
            record.physicalWorkloadId ??
            record.reviewAgentInstanceId ??
            record.agentInstanceId ??
            `manual:${record.workspacePath}:${record.agentId}`,
          source,
          attributionSource: 'manual_review',
          reviewRevision: record.reviewRevision,
          effectiveAt: record.reviewEffectiveAt ? new Date(record.reviewEffectiveAt).toISOString() : undefined,
          agentScopeId: record.reviewDecision === 'confirmed_agent' ? record.agentId : undefined,
          agentDisplayName:
            workload?.podName ??
            workload?.containerName ??
            workload?.processName ??
            record.agentId,
          agentInstanceId: record.reviewAgentInstanceId ?? record.agentInstanceId,
          namespace: workload?.namespace,
          podName: workload?.podName,
          podUid: workload?.podUid,
          nodeName: workload?.nodeName,
          containerName: workload?.containerName,
          containerImage: workload?.containerImage,
          ownerKind: workload?.ownerKind,
          ownerName: workload?.ownerName,
          systemdUnit: workload?.systemdUnit,
          evidence: [
            `manual_review:${record.reviewDecision}`,
            ...(record.reviewedBy ? [`manual_review:reviewer=${record.reviewedBy}`] : []),
          ],
        };
      });
  }

  identitySnapshotVersion(): number {
    return this.reviewVersion;
  }

  list(): AgentMetadataListItem[] {
    return [...this.records.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((record) => this.item(record));
  }

  private normalize(record: AgentMetadataRecord): AgentMetadataRecord {
    const agentId = clean(record.agentId, 240) ?? 'unknown';
    const workspacePath = clean(record.workspacePath, 500) ?? 'unknown';
    const agentAssetId = clean(record.agentAssetId, 160) ?? this.derivedAgentAssetId(record, workspacePath, agentId);
    const suppliedLogicalAgentId = clean(record.logicalAgentId, 240);
    const logicalDefinitionId = clean(record.logicalDefinitionId, 240);
    const logicalDefinitionType = cleanLogicalDefinitionType(record.logicalDefinitionType);
    const logicalScopeMode = cleanLogicalScopeMode(record.logicalScopeMode);
    const tenantId = clean(record.tenantId, 240);
    const ownerId = clean(record.ownerId, 240);
    const profile = clean(record.profile, 240);
    const profileVersion = clean(record.profileVersion, 120);
    const deploymentId = clean(record.deploymentId, 240);
    const deploymentRevision = clean(record.deploymentRevision, 120);
    const environmentId = clean(record.environmentId, 240);
    const registrationRef = clean(record.registrationRef, 240);
    const ingestionSourceId = clean(record.ingestionSourceId, 240);
    const terminalContextId = clean(record.terminalContextId, 240);
    // A terminal-scoped definition without a terminal attestation cannot be a stable boundary;
    // downgrade it to an unresolved candidate instead of silently treating the product/workspace
    // as a confirmed LogicalAgent.
    const effectiveLogicalScopeMode = logicalScopeMode === 'terminal' && !terminalContextId
      ? 'unresolved' as const
      : logicalScopeMode;
    const resolvedDefinition = resolveLogicalAgentDefinition({
      logicalAgentId: suppliedLogicalAgentId,
      family: agentId,
      tenantId,
      ownerId: ownerId ?? clean(record.owner, 240),
      workspacePath,
      profile,
      profileVersion,
      deploymentId,
      deploymentRevision,
      environmentId,
      definitionId: logicalDefinitionId,
      definitionType: logicalDefinitionType,
      logicalScopeMode: effectiveLogicalScopeMode,
      terminalContextId,
      authority: 'management_registration',
      sourceRefs: [managementSourceRef(record)],
    });
    const logicalAgentId = resolvedDefinition.stable
      ? resolvedDefinition.definition.logicalAgentId
      : undefined;
    const reviewPhysicalWorkloadId = clean(record.reviewPhysicalWorkloadId, 500);
    const reviewAgentInstanceId = clean(record.reviewAgentInstanceId, 500);
    const reviewWorkloadRef = cleanWorkloadRef(record.reviewWorkloadRef);
    const rawReviewDecision = cleanReviewDecision(record.reviewDecision);
    const stableReviewKeys = rawReviewDecision
      ? stableAgentReviewIdentityKeys({
          identityKeys: record.reviewIdentityKeys,
          physicalWorkloadId: reviewPhysicalWorkloadId,
          agentInstanceId: reviewAgentInstanceId,
          workloadRef: reviewWorkloadRef,
        })
      : [];
    const reviewedAt = Number(record.reviewedAt) || undefined;
    const legacyReview = rawReviewDecision
      ? {
          revision: Number.isSafeInteger(record.reviewRevision) && Number(record.reviewRevision) > 0
            ? Number(record.reviewRevision)
            : 1,
          decision: rawReviewDecision,
          effectiveAt: Number(record.reviewEffectiveAt) || reviewedAt || Number(record.updatedAt) || Date.now(),
          reviewedBy: clean(record.reviewedBy, 240),
          note: cleanText(record.reviewNote, 2_000),
          identityKeys: stableReviewKeys,
          physicalWorkloadId: reviewPhysicalWorkloadId,
          agentInstanceId: reviewAgentInstanceId,
          workloadRef: reviewWorkloadRef,
        } satisfies AgentReviewRevisionRecord
      : undefined;
    const reviewHistory = normalizedReviewHistory(record.reviewHistory, legacyReview);
    const latestReview = reviewHistory.at(-1);
    const reviewDecision = rawReviewDecision && stableReviewKeys.length > 0
      ? rawReviewDecision
      : undefined;
    return {
      agentId,
      agentAssetId,
      agentAssetAliases: cleanIdentityKeys([
        ...(record.agentAssetAliases ?? []),
        agentAssetIdForIdentityKey(`${workspacePath}\0${agentId}`),
      ]).filter((alias) => alias !== agentAssetId),
      logicalAgentId,
      logicalDefinitionId,
      logicalDefinitionType,
      logicalScopeMode: effectiveLogicalScopeMode,
      logicalIdentityAuthority: logicalAgentId
        ? 'management_registration' : undefined,
      registrationRef,
      ingestionSourceId,
      tenantId,
      ownerId,
      profile,
      profileVersion,
      deploymentId,
      deploymentRevision,
      environmentId,
      terminalContextId,
      workspacePath,
      displayName: cleanText(record.displayName, 160),
      owner: cleanText(record.owner, 160),
      team: cleanText(record.team, 160),
      environment: cleanText(record.environment, 80),
      criticality: cleanCriticality(record.criticality),
      tags: cleanTags(record.tags),
      note: cleanText(record.note, 2_000),
      identityKeys: cleanIdentityKeys([
        ...(record.identityKeys ?? record.reviewIdentityKeys ?? []),
        logicalAgentId ? `logical-agent:${logicalAgentId}` : undefined,
        logicalDefinitionId ? `logical-definition:${logicalDefinitionId}` : undefined,
      ]),
      physicalWorkloadId: clean(record.physicalWorkloadId ?? record.reviewPhysicalWorkloadId, 500),
      agentInstanceId: clean(record.agentInstanceId ?? record.reviewAgentInstanceId, 500),
      workloadRef: cleanWorkloadRef(record.workloadRef ?? record.reviewWorkloadRef),
      reviewDecision,
      reviewedBy: reviewDecision ? clean(record.reviewedBy, 240) : undefined,
      reviewedAt: reviewDecision ? reviewedAt : undefined,
      reviewNote: reviewDecision ? cleanText(record.reviewNote, 2_000) : undefined,
      reviewIdentityKeys: reviewDecision ? stableReviewKeys : undefined,
      reviewPhysicalWorkloadId: reviewDecision ? reviewPhysicalWorkloadId : undefined,
      reviewAgentInstanceId: reviewDecision ? reviewAgentInstanceId : undefined,
      reviewWorkloadRef: reviewDecision ? reviewWorkloadRef : undefined,
      reviewRevision: Math.max(Number(record.reviewRevision) || 0, latestReview?.revision ?? 0) || undefined,
      reviewEffectiveAt: Number(record.reviewEffectiveAt) || latestReview?.effectiveAt,
      reviewHistory,
      updatedAt: Number(record.updatedAt) || Date.now(),
    };
  }

  private item(record: AgentMetadataRecord): AgentMetadataListItem {
    const { reviewedAt, reviewEffectiveAt, ...rest } = record;
    return {
      ...rest,
      tags: [...record.tags],
      agentAssetAliases: record.agentAssetAliases ? [...record.agentAssetAliases] : undefined,
      identityKeys: record.identityKeys ? [...record.identityKeys] : undefined,
      workloadRef: record.workloadRef ? { ...record.workloadRef } : undefined,
      reviewIdentityKeys: record.reviewIdentityKeys ? [...record.reviewIdentityKeys] : undefined,
      reviewWorkloadRef: record.reviewWorkloadRef ? { ...record.reviewWorkloadRef } : undefined,
      reviewHistory: record.reviewHistory?.map((review) => ({
        ...review,
        identityKeys: [...review.identityKeys],
        clearedIdentityKeys: review.clearedIdentityKeys ? [...review.clearedIdentityKeys] : undefined,
        workloadRef: review.workloadRef ? { ...review.workloadRef } : undefined,
      })),
      reviewedAt: reviewedAt ? iso(reviewedAt) : undefined,
      reviewEffectiveAt: reviewEffectiveAt !== undefined ? iso(reviewEffectiveAt) : undefined,
      updatedAt: iso(record.updatedAt),
    };
  }

  private trim(): void {
    if (this.records.size <= RETAIN_LIMIT) return;
    const keep = [...this.records.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, RETAIN_LIMIT);
    this.records.clear();
    for (const record of keep) this.records.set(assetKey(record.agentAssetId), record);
    const retained = new Set(keep.map((record) => record.agentAssetId));
    for (const assetId of this.dirtyAssetIds) {
      if (!retained.has(assetId)) this.dirtyAssetIds.delete(assetId);
    }
    this.rebuildReviewIndex();
  }

  private rebuildReviewIndex(): void {
    this.reviewIndex.clear();
    this.reviewHistoryIndex.clear();
    this.identityIndex.clear();
    this.assetIndex.clear();
    this.legacyIndex.clear();
    this.aliasIndex.clear();
    for (const [recordKey, record] of this.records) {
      const assetId = clean(record.agentAssetId, 160);
      if (assetId) this.addIndexEntry(this.assetIndex, assetId, recordKey);
      this.addIndexEntry(this.legacyIndex, legacyKey(record.workspacePath, record.agentId), recordKey);
      for (const alias of record.agentAssetAliases ?? []) {
        this.addIndexEntry(this.aliasIndex, alias, recordKey);
      }
      for (const identityKey of record.identityKeys ?? record.reviewIdentityKeys ?? []) {
        const normalized = normalizeIdentityKey(identityKey);
        if (normalized) this.addIndexEntry(this.identityIndex, normalized, recordKey);
      }
      if (!record.reviewDecision) continue;
      for (const identityKey of record.reviewIdentityKeys ?? []) {
        const normalized = normalizeIdentityKey(identityKey);
        if (!normalized) continue;
        this.addIndexEntry(this.reviewIndex, normalized, recordKey);
      }
    }
    for (const [recordKey, record] of this.records) {
      for (const review of record.reviewHistory ?? []) {
        const activeKeys = stableAgentReviewIdentityKeys({
          identityKeys: review.identityKeys,
          physicalWorkloadId: review.physicalWorkloadId,
          agentInstanceId: review.agentInstanceId,
          workloadRef: review.workloadRef,
        });
        for (const identityKey of activeKeys) {
          const entries = this.reviewHistoryIndex.get(identityKey) ?? [];
          entries.push({ recordKey, review: { ...review, identityKeys: [...activeKeys] } });
          this.reviewHistoryIndex.set(identityKey, entries);
        }
        const clearedKeys = stableAgentReviewIdentityKeys({
          identityKeys: review.clearedIdentityKeys,
          physicalWorkloadId: review.physicalWorkloadId,
          agentInstanceId: review.agentInstanceId,
          workloadRef: review.workloadRef,
        });
        for (const identityKey of clearedKeys) {
          const entries = this.reviewHistoryIndex.get(identityKey) ?? [];
          entries.push({
            recordKey,
            review: { ...review, decision: 'clear', identityKeys: [identityKey] },
          });
          this.reviewHistoryIndex.set(identityKey, entries);
        }
      }
    }
  }

  private addIndexEntry(index: Map<string, string | null>, identity: string, recordKey: string): void {
    const existingKey = index.get(identity);
    if (existingKey === undefined) {
      index.set(identity, recordKey);
      return;
    }
    if (existingKey !== recordKey) index.set(identity, null);
  }

  private derivedAgentAssetId(
    record: Partial<AgentMetadataRecord>,
    workspacePath: string,
    agentId: string,
  ): string {
    const workload = record.workloadRef ?? record.reviewWorkloadRef;
    const identityKeys = cleanIdentityKeys(record.identityKeys ?? record.reviewIdentityKeys);
    const canonicalIdentityKey = identityKeys.find((key) => /^(?:docker-agent-root|docker-agent-logical|k8s-agent-logical|host-root):/u.test(key));
    const logicalAgentId = clean(record.logicalAgentId, 500);
    const logicalDefinitionId = clean(record.logicalDefinitionId, 500);
    const logicalDefinitionType = clean(record.logicalDefinitionType, 120);
    const logicalScopeMode = clean(record.logicalScopeMode, 120);
    const tenantId = clean(record.tenantId, 240);
    const ownerId = clean(record.ownerId ?? record.owner, 240);
    const profile = clean(record.profile, 240);
    const profileVersion = clean(record.profileVersion, 120);
    // A management logical ID is only unique within its tenant/owner/definition namespace.  Keep
    // deployment/revision out of this asset key (those are AgentInstance boundaries), but include
    // the stable definition tuple so two registrations that accidentally reuse a logical ID do
    // not collapse into one metadata record.
    const logicalDefinitionKey = (logicalAgentId || logicalDefinitionId)
      ? [
          tenantId,
          ownerId,
          clean(record.agentId, 240) ?? agentId,
          workspacePath,
          logicalAgentId,
          logicalDefinitionId,
          logicalDefinitionType,
          profile,
          profileVersion,
          // Workflow/service registrations may have several concurrently live deployment
          // revisions. Keep those metadata/runtime records distinct while the directory still
          // groups them back under the shared LogicalAgent definition.
          ...(logicalScopeMode === 'workflow_definition' || logicalScopeMode === 'service_definition'
            ? [record.environmentId, record.deploymentId, record.deploymentRevision] : []),
        ]
          .map((value) => value ?? '').join('\0')
      : undefined;
    const identityKey =
      (logicalDefinitionKey ? `logical-definition:${logicalDefinitionKey}` : undefined) ??
      logicalDefinitionId ??
      canonicalIdentityKey ??
      clean(record.physicalWorkloadId ?? record.reviewPhysicalWorkloadId, 500) ??
      clean(record.agentInstanceId ?? record.reviewAgentInstanceId, 500) ??
      (
        workload?.podUid
          ? `k8s:${workload.podUid}:${workload.containerName ?? workload.name ?? 'container'}`
          : undefined
      ) ??
      identityKeys[0] ??
      `${workspacePath}\0${agentId}`;
    // Review identity keys are indexed lower-case for collision-safe comparisons, while the
    // semantic identity encoder uses canonical percent-escape casing. Restore that representation
    // before deriving an asset ID so a review submitted with normalized keys resolves to the same
    // event-backed asset (not a second alias differing only by `%3a` vs `%3A`).
    const canonicalIdentity = identityKey.replace(/%[0-9a-f]{2}/giu, (value) => value.toUpperCase());
    return agentAssetIdForIdentityKey(canonicalIdentity);
  }

  private canonicalAssetIdForMutation(
    agentId: string,
    workspacePath: string,
    input: AgentMetadataUpdateRequest | AgentReviewRequest,
    current?: AgentMetadataRecord,
  ): string {
    const requested = clean(input.agentAssetId, 160);
    if (requested) {
      const direct = this.assetIndex.get(requested) ?? this.aliasIndex.get(requested);
      if (direct && direct !== null) {
        const directRecord = this.records.get(direct);
        if (directRecord
          && (directRecord.workspacePath !== workspacePath || directRecord.agentId !== agentId)) {
          throw new BadRequestException('agentAssetId belongs to another workspace or agent');
        }
      }
      return this.canonicalAgentAssetId(requested);
    }
    if (current) return current.agentAssetId;
    const canonicalInput = input as AgentMetadataUpdateRequest;
    const hasStableIdentity = Boolean(
      clean(canonicalInput.logicalAgentId, 240) ||
      clean(canonicalInput.logicalDefinitionId, 240) ||
      clean(input.physicalWorkloadId, 500) ||
      clean(input.agentInstanceId, 500) ||
      clean(input.workloadRef?.podUid, 240) ||
      cleanIdentityKeys(input.identityKeys).length,
    );
    if (!hasStableIdentity) {
      throw new BadRequestException('agentAssetId or stable observed identity is required');
    }
    return this.derivedAgentAssetId({
      agentId,
      workspacePath,
      logicalAgentId: canonicalInput.logicalAgentId,
      logicalDefinitionId: canonicalInput.logicalDefinitionId,
      logicalDefinitionType: canonicalInput.logicalDefinitionType,
      logicalScopeMode: canonicalInput.logicalScopeMode,
      tenantId: canonicalInput.tenantId,
      ownerId: canonicalInput.ownerId,
      profile: canonicalInput.profile,
      profileVersion: canonicalInput.profileVersion,
      deploymentId: canonicalInput.deploymentId,
      deploymentRevision: canonicalInput.deploymentRevision,
      environmentId: canonicalInput.environmentId,
      identityKeys: input.identityKeys,
      physicalWorkloadId: input.physicalWorkloadId,
      agentInstanceId: input.agentInstanceId,
      workloadRef: input.workloadRef,
    }, workspacePath, agentId);
  }

  private assetAliases(
    current: AgentMetadataRecord | undefined,
    canonicalAssetId: string,
    workspacePath: string,
    agentId: string,
  ): string[] {
    return cleanIdentityKeys([
      ...(current?.agentAssetAliases ?? []),
      current?.agentAssetId,
      agentAssetIdForIdentityKey(`${workspacePath}\0${agentId}`),
    ]).filter((alias) => alias !== canonicalAssetId);
  }

  private findRecordKey(
    requestedAssetId: string | undefined,
    workspacePath: string,
    agentId: string,
    identityKeys?: string[],
    context: Partial<Pick<AgentMetadataRecord, 'ingestionSourceId' | 'logicalAgentId' | 'logicalDefinitionId' | 'tenantId' | 'ownerId' | 'profile' | 'terminalContextId' | 'deploymentId' | 'deploymentRevision' | 'environmentId'>> = {},
  ): string | undefined {
    if (requestedAssetId) {
      const direct = this.assetIndex.get(requestedAssetId) ?? this.aliasIndex.get(requestedAssetId);
      if (direct) {
        if (direct === null) return undefined;
        const directRecord = this.records.get(direct);
        if (directRecord?.workspacePath !== workspacePath || directRecord.agentId !== agentId) {
          // A metadata mutation names a concrete workspace/Agent owner. Runtime child names may
          // resolve through the read-only alias path, but must not mutate another Agent's record.
          return undefined;
        }
        return direct;
      }
    }
    const matches = [...this.records.entries()].filter(([, record]) => {
      if (record.workspacePath !== workspacePath || record.agentId !== agentId) return false;
      if (context.ingestionSourceId && record.ingestionSourceId !== clean(context.ingestionSourceId, 240)) return false;
      if (context.logicalAgentId && record.logicalAgentId !== clean(context.logicalAgentId, 240)) return false;
      if (context.logicalDefinitionId && record.logicalDefinitionId !== clean(context.logicalDefinitionId, 240)) return false;
      if (context.tenantId && record.tenantId !== clean(context.tenantId, 240)) return false;
      if (context.ownerId && (record.ownerId ?? record.owner) !== clean(context.ownerId, 240)) return false;
      if (context.profile && record.profile !== clean(context.profile, 240)) return false;
      if (context.terminalContextId && record.terminalContextId !== clean(context.terminalContextId, 240)) return false;
      if (context.deploymentId && record.deploymentId !== clean(context.deploymentId, 240)) return false;
      if (context.deploymentRevision && record.deploymentRevision !== clean(context.deploymentRevision, 120)) return false;
      if (context.environmentId && record.environmentId !== clean(context.environmentId, 240)) return false;
      return true;
    });
    if (matches.length === 1) return matches[0][0];
    if (matches.length > 1) return undefined;
    const hasExplicitContext = Object.values(context).some((value) =>
      typeof value === 'string' ? value.trim().length > 0 : value !== undefined,
    );
    // Do not fall back to the legacy workspace+agent index after an explicit identity tuple
    // failed to match. That fallback used to overwrite registration A when a caller created
    // registration B for the same display/workspace but a different tenant/source/definition.
    // An unscoped legacy update may still use the index; scoped mismatches must create a distinct
    // record or remain unresolved.
    if (hasExplicitContext) return undefined;
    const legacy = this.legacyIndex.get(legacyKey(workspacePath, agentId));
    if (legacy) return legacy;
    for (const identity of cleanIdentityKeys(identityKeys)) {
      const indexed = this.identityIndex.get(identity);
      if (indexed) return indexed;
    }
    return undefined;
  }

  private storeNormalized(record: AgentMetadataRecord, previousKey?: string, replace = false): void {
    const normalized = this.normalize(record);
    const nextKey = assetKey(normalized.agentAssetId);
    if (previousKey && previousKey !== nextKey) this.records.delete(previousKey);
    const existing = this.records.get(nextKey);
    this.records.set(nextKey, existing && !replace ? this.mergeRecords(existing, normalized) : normalized);
    this.rebuildReviewIndex();
  }

  private mergeRecords(left: AgentMetadataRecord, right: AgentMetadataRecord): AgentMetadataRecord {
    const newer = right.updatedAt >= left.updatedAt ? right : left;
    const older = newer === right ? left : right;
    const leftRevision = left.reviewRevision ?? 0;
    const rightRevision = right.reviewRevision ?? 0;
    const reviewOwner = rightRevision > leftRevision
      ? right
      : leftRevision > rightRevision
        ? left
        : newer;
    const reviewHistory = normalizedReviewHistory([
      ...(left.reviewHistory ?? []),
      ...(right.reviewHistory ?? []),
    ]);
    return this.normalize({
      ...older,
      ...newer,
      logicalAgentId: newer.logicalAgentId ?? older.logicalAgentId,
      logicalDefinitionId: newer.logicalDefinitionId ?? older.logicalDefinitionId,
      logicalDefinitionType: newer.logicalDefinitionType ?? older.logicalDefinitionType,
      logicalScopeMode: newer.logicalScopeMode ?? older.logicalScopeMode,
      logicalIdentityAuthority: newer.logicalIdentityAuthority ?? older.logicalIdentityAuthority,
      registrationRef: newer.registrationRef ?? older.registrationRef,
      ingestionSourceId: newer.ingestionSourceId ?? older.ingestionSourceId,
      tenantId: newer.tenantId ?? older.tenantId,
      ownerId: newer.ownerId ?? older.ownerId,
      profile: newer.profile ?? older.profile,
      profileVersion: newer.profileVersion ?? older.profileVersion,
      deploymentId: newer.deploymentId ?? older.deploymentId,
      deploymentRevision: newer.deploymentRevision ?? older.deploymentRevision,
      environmentId: newer.environmentId ?? older.environmentId,
      terminalContextId: newer.terminalContextId ?? older.terminalContextId,
      displayName: newer.displayName ?? older.displayName,
      owner: newer.owner ?? older.owner,
      team: newer.team ?? older.team,
      environment: newer.environment ?? older.environment,
      criticality: newer.criticality ?? older.criticality,
      note: newer.note ?? older.note,
      tags: [...new Set([...(older.tags ?? []), ...(newer.tags ?? [])])],
      identityKeys: cleanIdentityKeys([...(older.identityKeys ?? []), ...(newer.identityKeys ?? [])]),
      reviewDecision: reviewOwner.reviewDecision,
      reviewedBy: reviewOwner.reviewedBy,
      reviewedAt: reviewOwner.reviewedAt,
      reviewNote: reviewOwner.reviewNote,
      // Current scope is a replace operation. Historical scopes remain only in reviewHistory.
      reviewIdentityKeys: reviewOwner.reviewIdentityKeys
        ? [...reviewOwner.reviewIdentityKeys]
        : undefined,
      reviewPhysicalWorkloadId: reviewOwner.reviewPhysicalWorkloadId,
      reviewAgentInstanceId: reviewOwner.reviewAgentInstanceId,
      reviewWorkloadRef: reviewOwner.reviewWorkloadRef,
      reviewRevision: reviewOwner.reviewRevision,
      reviewEffectiveAt: reviewOwner.reviewEffectiveAt,
      reviewHistory,
      agentAssetAliases: cleanIdentityKeys([...(older.agentAssetAliases ?? []), ...(newer.agentAssetAliases ?? [])]),
    });
  }

  private persistSoon(): void {
    if (!this.initialized) return;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.persist();
    }, 500);
  }

  private async persist(): Promise<void> {
    const records = [...this.records.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, RETAIN_LIMIT);
    const retained = new Set(records.map((record) => record.agentAssetId));
    for (const assetId of this.dirtyAssetIds) {
      if (!retained.has(assetId)) this.dirtyAssetIds.delete(assetId);
    }
    const dirtyRecords = records.filter((record) => this.dirtyAssetIds.has(record.agentAssetId));
    const [, relationalSaved] = await Promise.all([
      this.ch.saveAgentMetadata(records),
      this.relational.saveAgentMetadata(dirtyRecords),
    ]);
    if (relationalSaved) {
      for (const saved of dirtyRecords) {
        const current = this.records.get(assetKey(saved.agentAssetId));
        if (!current || current.updatedAt <= saved.updatedAt) {
          this.dirtyAssetIds.delete(saved.agentAssetId);
        }
      }
    }
  }
}
