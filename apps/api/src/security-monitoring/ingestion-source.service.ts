import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { ClickHouseStore } from './clickhouse-store';
import { DistributedCurrentStateService } from './distributed-current-state.service';
import { RelationalBusinessStore } from './relational-business-store.service';
import {
  CorrelationClaimAuthority,
  CorrelationClaimAuthorizationReason,
  IngestionSourceCheckInAck,
  IngestionSourceCheckInRequest,
  IngestionSourceCorrelationClaimBindings,
  IngestionSourceCorrelationClaimsPolicy,
  IngestionSourceCorrelationClaimsPolicyInput,
  IngestionSourceCurrentActivity,
  IngestionSourceItem,
  IngestionSourceList,
  IngestionSourceMutationResult,
  IngestionSourceQuery,
  IngestionSourceRecord,
  IngestionSourceStatus,
  IngestionSourceType,
  IngestionSourceUpdateRequest,
  SourceTokenRotationStatus,
} from './types';
import { cleanText } from './redaction';
import { correlationCaptureRollout } from './correlation-rollout';

const RETAIN_LIMIT = 2_000;
const STALE_AFTER_MS = 10 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

export interface IngestionSourceResolution {
  accepted: boolean;
  reason?: string;
  source?: IngestionSourceRecord;
  authenticated: boolean;
  authentication: 'token' | 'none';
  claimAuthorization: boolean;
  claimAuthorizationReason: CorrelationClaimAuthorizationReason;
  claimAuthority?: CorrelationClaimAuthority;
}

export interface IngestionSourceCorrelationClaimRequest {
  authority?: CorrelationClaimAuthority;
  /** Raw identity values; authorization performs strict, non-truncating validation. */
  tenantId?: unknown;
  environmentId?: unknown;
  workspaceId?: unknown;
  workspacePath?: unknown;
  collectorId?: unknown;
  physicalWorkloadId?: unknown;
  agentScopeId?: unknown;
}

export interface IngestionSourceResolveInput {
  sourceId?: string;
  token?: string;
  collectorId?: string;
  workspacePath?: string;
  sourceName?: string;
  type?: IngestionSourceType;
  correlationClaim?: IngestionSourceCorrelationClaimRequest;
}

export type IngestionActivityKind = 'event' | 'heartbeat';

function iso(t = Date.now()): string {
  return new Date(t).toISOString().slice(0, 19).replace('T', ' ');
}

function clean(value: unknown, limit: number): string | undefined {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed ? trimmed.slice(0, limit) : undefined;
}

function hashId(parts: Array<string | number | undefined>): string {
  const h = createHash('sha1');
  for (const p of parts) h.update(String(p ?? '')).update('\0');
  return `src_${h.digest('hex').slice(0, 16)}`;
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function newToken(): string {
  return `ansrc_${randomBytes(24).toString('base64url')}`;
}

function tokenPreview(token: string): string {
  return `${token.slice(0, 8)}...${token.slice(-6)}`;
}

function envInt(name: string, fallback: number, min: number, max: number): number {
  const n = Number(process.env[name]);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function cleanType(value: unknown): IngestionSourceType {
  return value === 'observer' || value === 'forwarder' || value === 'webhook' || value === 'otel' || value === 'custom' ? value : 'observer';
}

function cleanTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  return [...new Set(tags.map((tag) => cleanText(tag, 48)).filter((tag): tag is string => Boolean(tag)))].slice(0, 24);
}

const CLAIM_BINDING_LIMIT = 64;

function strictClaimIdentity(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > limit || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    return undefined;
  }
  return normalized;
}

const CORRELATION_AUTHORITY_SOURCE_TYPES: Readonly<Record<CorrelationClaimAuthority, readonly IngestionSourceType[]>> = {
  application: ['otel', 'webhook', 'custom'],
  agent_adapter: ['forwarder', 'otel', 'webhook', 'custom'],
  observer_runtime: ['observer', 'forwarder'],
};

function cleanClaimAuthority(value: unknown): CorrelationClaimAuthority | undefined {
  return value === 'application' || value === 'agent_adapter' || value === 'observer_runtime' ? value : undefined;
}

function cleanBindingList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => strictClaimIdentity(item, limit)).filter((item): item is string => Boolean(item)))].slice(0, CLAIM_BINDING_LIMIT);
}

function emptyClaimBindings(): IngestionSourceCorrelationClaimBindings {
  return {
    tenantIds: [],
    environmentIds: [],
    workspaceIds: [],
    workspacePaths: [],
    collectorIds: [],
    physicalWorkloadIds: [],
    agentScopeIds: [],
  };
}

export function normalizeCorrelationClaimsPolicy(
  input: IngestionSourceCorrelationClaimsPolicyInput | IngestionSourceCorrelationClaimsPolicy | undefined,
  current?: IngestionSourceCorrelationClaimsPolicy,
): IngestionSourceCorrelationClaimsPolicy {
  const prior = current?.bindings ?? emptyClaimBindings();
  const incoming = input?.bindings;
  const binding = (key: keyof IngestionSourceCorrelationClaimBindings, limit: number): string[] =>
    incoming && Object.prototype.hasOwnProperty.call(incoming, key)
      ? cleanBindingList(incoming[key], limit)
      : cleanBindingList(prior[key], limit);
  const hasEnabled = Boolean(input && Object.prototype.hasOwnProperty.call(input, 'enabled'));
  const hasAuthority = Boolean(input && Object.prototype.hasOwnProperty.call(input, 'authority'));
  return {
    enabled: hasEnabled ? input?.enabled === true : current?.enabled === true,
    authority: hasAuthority ? cleanClaimAuthority(input?.authority) : cleanClaimAuthority(current?.authority),
    bindings: {
      tenantIds: binding('tenantIds', 160),
      environmentIds: binding('environmentIds', 80),
      workspaceIds: binding('workspaceIds', 180),
      workspacePaths: binding('workspacePaths', 500),
      collectorIds: binding('collectorIds', 180),
      physicalWorkloadIds: binding('physicalWorkloadIds', 240),
      agentScopeIds: binding('agentScopeIds', 160),
    },
  };
}

function scopeFailure(
  requested: string | undefined,
  bindings: readonly string[],
  missingReason: CorrelationClaimAuthorizationReason,
  mismatchReason: CorrelationClaimAuthorizationReason,
): CorrelationClaimAuthorizationReason | undefined {
  if (!requested) return undefined;
  if (!bindings.length) return missingReason;
  return bindings.includes(requested) ? undefined : mismatchReason;
}

export function authorizeCorrelationClaims(input: {
  source?: IngestionSourceRecord;
  tokenProvided: boolean;
  tokenMatched: boolean;
  sourceIdMismatch?: boolean;
  claim?: IngestionSourceCorrelationClaimRequest;
}): Pick<IngestionSourceResolution, 'claimAuthorization' | 'claimAuthorizationReason' | 'claimAuthority'> {
  const source = input.source;
  const authority = cleanClaimAuthority(input.claim?.authority);
  const denied = (reason: CorrelationClaimAuthorizationReason) => ({
    claimAuthorization: false as const,
    claimAuthorizationReason: reason,
    claimAuthority: authority,
  });
  if (!source) return denied('source_unresolved');
  if (!source.enabled) return denied('source_disabled');
  if (source.discovered) return denied('source_discovered');
  const policy = normalizeCorrelationClaimsPolicy(source.correlationClaims);
  if (!policy.enabled) return denied('policy_disabled');
  if (!policy.authority) return denied('policy_invalid');
  if (!source.requireToken) return denied('protected_source_required');
  if (!input.tokenProvided) return denied('token_missing');
  if (!input.tokenMatched) return denied('token_invalid');
  if (input.sourceIdMismatch) return denied('source_id_mismatch');
  if (!authority) return denied('authority_missing');
  if (policy.authority !== authority) return denied('authority_mismatch');
  if (!CORRELATION_AUTHORITY_SOURCE_TYPES[authority].includes(source.type)) return denied('source_type_not_allowed');

  const claim = input.claim ?? {};
  const bindings = policy.bindings;
  const requestedScopes = {
    tenantId: strictClaimIdentity(claim.tenantId, 160),
    environmentId: strictClaimIdentity(claim.environmentId, 80),
    workspaceId: strictClaimIdentity(claim.workspaceId, 180),
    workspacePath: strictClaimIdentity(claim.workspacePath, 500),
    collectorId: strictClaimIdentity(claim.collectorId, 180),
    physicalWorkloadId: strictClaimIdentity(claim.physicalWorkloadId, 240),
    agentScopeId: strictClaimIdentity(claim.agentScopeId, 160),
  };
  const workspacePolicyConfigured = bindings.workspaceIds.length > 0 || bindings.workspacePaths.length > 0;
  const workspaceRequested = Boolean(requestedScopes.workspaceId || requestedScopes.workspacePath);
  const workloadPolicyConfigured = bindings.physicalWorkloadIds.length > 0;
  const workloadRequested = Boolean(requestedScopes.physicalWorkloadId);
  const agentPolicyConfigured = bindings.agentScopeIds.length > 0;
  const agentRequested = Boolean(requestedScopes.agentScopeId);
  const invalidProvidedScope = (
    raw: unknown,
    parsed: string | undefined,
    configured: boolean,
    reason: CorrelationClaimAuthorizationReason,
  ): CorrelationClaimAuthorizationReason | undefined =>
    configured && raw !== undefined && parsed === undefined ? reason : undefined;
  const invalidScope = [
    invalidProvidedScope(claim.tenantId, requestedScopes.tenantId, bindings.tenantIds.length > 0, 'tenant_binding_mismatch'),
    invalidProvidedScope(claim.environmentId, requestedScopes.environmentId, bindings.environmentIds.length > 0, 'environment_binding_mismatch'),
    invalidProvidedScope(claim.workspaceId, requestedScopes.workspaceId, bindings.workspaceIds.length > 0, 'workspace_binding_mismatch'),
    invalidProvidedScope(claim.workspacePath, requestedScopes.workspacePath, bindings.workspacePaths.length > 0, 'workspace_binding_mismatch'),
    invalidProvidedScope(claim.collectorId, requestedScopes.collectorId, bindings.collectorIds.length > 0, 'collector_binding_mismatch'),
    invalidProvidedScope(claim.physicalWorkloadId, requestedScopes.physicalWorkloadId, bindings.physicalWorkloadIds.length > 0, 'workload_binding_mismatch'),
    invalidProvidedScope(claim.agentScopeId, requestedScopes.agentScopeId, bindings.agentScopeIds.length > 0, 'agent_binding_mismatch'),
  ].find((reason): reason is CorrelationClaimAuthorizationReason => Boolean(reason));
  if (invalidScope) return denied(invalidScope);
  if (authority === 'application' || authority === 'agent_adapter') {
    if (!bindings.tenantIds.length || !bindings.environmentIds.length || (!workspacePolicyConfigured && !workloadPolicyConfigured && !agentPolicyConfigured)) {
      return denied('policy_invalid');
    }
    if (!requestedScopes.tenantId || !requestedScopes.environmentId || (!workspaceRequested && !workloadRequested && !agentRequested)) {
      return denied('required_scope_missing');
    }
  } else if (!bindings.collectorIds.length) {
    return denied('policy_invalid');
  } else if (!requestedScopes.collectorId) {
    return denied('required_scope_missing');
  } else if (!bindings.collectorIds.includes(requestedScopes.collectorId)) {
    return denied('collector_binding_mismatch');
  }

  const workspaceFailure = (): CorrelationClaimAuthorizationReason | undefined => {
    if (!workspaceRequested) return undefined;
    if (requestedScopes.workspaceId) {
      if (!bindings.workspaceIds.length) return 'workspace_binding_missing';
      if (!bindings.workspaceIds.includes(requestedScopes.workspaceId)) return 'workspace_binding_mismatch';
    }
    if (requestedScopes.workspacePath) {
      if (!bindings.workspacePaths.length) return 'workspace_binding_missing';
      if (!bindings.workspacePaths.includes(requestedScopes.workspacePath)) return 'workspace_binding_mismatch';
    }
    return undefined;
  };
  const failures: Array<CorrelationClaimAuthorizationReason | undefined> = [
    scopeFailure(requestedScopes.tenantId, bindings.tenantIds, 'tenant_binding_missing', 'tenant_binding_mismatch'),
    scopeFailure(requestedScopes.environmentId, bindings.environmentIds, 'environment_binding_missing', 'environment_binding_mismatch'),
    workspaceFailure(),
    scopeFailure(requestedScopes.collectorId, bindings.collectorIds, 'collector_binding_missing', 'collector_binding_mismatch'),
    scopeFailure(requestedScopes.physicalWorkloadId, bindings.physicalWorkloadIds, 'workload_binding_missing', 'workload_binding_mismatch'),
    scopeFailure(requestedScopes.agentScopeId, bindings.agentScopeIds, 'agent_binding_missing', 'agent_binding_mismatch'),
  ];
  if (bindings.tenantIds.length && !requestedScopes.tenantId) failures[0] = 'tenant_binding_missing';
  if (bindings.environmentIds.length && !requestedScopes.environmentId) failures[1] = 'environment_binding_missing';
  if (bindings.collectorIds.length && !requestedScopes.collectorId) failures[3] = 'collector_binding_missing';
  if (authority === 'observer_runtime') {
    if (bindings.workspaceIds.length && !requestedScopes.workspaceId) failures[2] = 'workspace_binding_missing';
    if (bindings.workspacePaths.length && !requestedScopes.workspacePath) failures[2] = 'workspace_binding_missing';
    if (bindings.physicalWorkloadIds.length && !requestedScopes.physicalWorkloadId) failures[4] = 'workload_binding_missing';
    if (bindings.agentScopeIds.length && !requestedScopes.agentScopeId) failures[5] = 'agent_binding_missing';
  }
  const failure = failures.find((reason): reason is CorrelationClaimAuthorizationReason => Boolean(reason));
  if (failure) return denied(failure);
  return {
    claimAuthorization: true,
    claimAuthorizationReason: 'authorized',
    claimAuthority: authority,
  };
}

type VerificationSourceIdentity = Pick<
  IngestionSourceRecord,
  'sourceId' | 'name' | 'owner' | 'team' | 'environment' | 'note' | 'tags'
>;

export function isVerificationSource(item: VerificationSourceIdentity): boolean {
  const searchable = [
    item.sourceId,
    item.name,
    item.owner,
    item.team,
    item.environment,
    item.note,
    ...(item.tags ?? []),
  ].filter(Boolean).join(' ').toLowerCase();
  return /\b(?:verify|verifier|verification|contract-test|streaming-phase|temporal-episode|supply-chain-(?:runtime|temporal|phase))\b/u.test(searchable)
    || item.sourceId.startsWith('src_verify_')
    || item.sourceId.startsWith('src_flink_');
}

function lastSignalAt(record: IngestionSourceRecord): number | undefined {
  const at = Math.max(Number(record.lastEventAt) || 0, Number(record.lastHeartbeatAt) || 0);
  return at > 0 ? at : undefined;
}

function statusOf(record: IngestionSourceRecord, at = Date.now()): IngestionSourceStatus {
  if (!record.enabled) return 'disabled';
  const signalAt = lastSignalAt(record);
  if (!signalAt) return 'unused';
  return at - signalAt > STALE_AFTER_MS ? 'stale' : 'active';
}

function statusText(status: IngestionSourceStatus): string {
  if (status === 'active') return 'Active';
  if (status === 'stale') return 'Stale';
  if (status === 'disabled') return 'Disabled';
  return 'Unused';
}

function cleanRotationDays(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(3650, Math.round(n)));
}

function tokenRotationDueAt(record: IngestionSourceRecord): number | undefined {
  if (!record.requireToken || !record.tokenHash || !record.tokenIssuedAt) return undefined;
  const days = cleanRotationDays(record.tokenRotationDays, defaultTokenRotationDays());
  return record.tokenIssuedAt + days * DAY_MS;
}

function tokenRotationStatus(record: IngestionSourceRecord, at = Date.now()): SourceTokenRotationStatus {
  const dueAt = tokenRotationDueAt(record);
  if (!dueAt) return 'untracked';
  return dueAt <= at ? 'overdue' : 'fresh';
}

function defaultTokenRotationDays(): number {
  return envInt('ANYSENTRY_SOURCE_TOKEN_ROTATION_DAYS', 90, 0, 3650);
}

@Injectable()
export class IngestionSourceService implements OnModuleInit, OnModuleDestroy {
  private readonly ch = new ClickHouseStore();
  private readonly sources = new Map<string, IngestionSourceRecord>();
  private persistTimer?: NodeJS.Timeout;
  private currentStateTimer?: NodeJS.Timeout;
  private persistInFlight?: Promise<void>;
  private persistRequested = false;
  private initialized = false;

  constructor(
    private readonly currentState: DistributedCurrentStateService,
    private readonly relational: RelationalBusinessStore,
  ) {}

  async onModuleInit(): Promise<void> {
    if (await this.ch.init()) {
      for (const record of await this.ch.loadIngestionSources()) {
        this.mergePersisted(record);
      }
    }
    for (const record of await this.relational.loadIngestionSources()) {
      this.mergePersisted(record);
    }
    this.initialized = true;
    await this.persist();
    await this.refreshDistributedCurrentState();
    this.currentStateTimer = setInterval(() => {
      void this.refreshRelationalState();
      void this.refreshDistributedCurrentState();
    }, 15_000);
    this.currentStateTimer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    if (this.currentStateTimer) clearInterval(this.currentStateTimer);
    await this.persist();
    await this.ch.close();
  }

  stateStatus() {
    return {
      sourceCount: this.sources.size,
      postgresqlBacked: this.relational.isReady(),
      clickhouseMigrationCopy: this.ch.enabled,
    };
  }

  create(input: IngestionSourceUpdateRequest): IngestionSourceMutationResult {
    const token = newToken();
    const source = this.upsert(undefined, input, token);
    return { source, token };
  }

  update(sourceId: string, input: IngestionSourceUpdateRequest): IngestionSourceMutationResult {
    return { source: this.upsert(sourceId, input) };
  }

  rotateToken(sourceId: string): IngestionSourceMutationResult | undefined {
    const cur = this.sources.get(sourceId);
    if (!cur) return undefined;
    const token = newToken();
    const source = this.upsert(sourceId, cur, token);
    return { source, token };
  }

  list(query: IngestionSourceQuery): IngestionSourceList {
    const sourceId = clean(query.sourceId, 160);
    const collectorId = clean(query.collectorId, 180);
    const workspacePath = clean(query.workspacePath, 500);
    const q = query.q?.trim().toLowerCase();
    const hasFilter = Boolean((query.status && query.status !== 'all') || (query.type && query.type !== 'all') || collectorId || workspacePath || q);
    const items = [...this.sources.values()]
      .map((record) => this.item(record))
      .filter((item) => {
        const matchesSourceId = Boolean(sourceId && item.sourceId === sourceId);
        const matchesCollectorId = Boolean(collectorId && item.collectorId === collectorId);
        const matchesWorkspacePath = Boolean(workspacePath && item.workspacePath === workspacePath);
        // Verification sources stay out of broad inventory views, but an operator's exact
        // identity selector must remain authoritative and auditable.
        const matchesExactIdentity = matchesSourceId || matchesCollectorId || matchesWorkspacePath;
        if (!query.includeVerification && !matchesExactIdentity && isVerificationSource(item)) return false;
        const matchesFilter =
          (!query.status || query.status === 'all' || item.status === query.status) &&
          (!query.type || query.type === 'all' || item.type === query.type) &&
          (!collectorId || matchesCollectorId) &&
          (!workspacePath || matchesWorkspacePath) &&
          (!q || [item.sourceId, item.name, item.type, item.collectorId, item.workspacePath, item.owner, item.team, item.environment, item.note, ...(item.tags ?? [])].some((value) => (value ?? '').toLowerCase().includes(q)));
        if (sourceId && !hasFilter) return matchesSourceId;
        return matchesSourceId || matchesFilter;
      })
      .sort((a, b) => {
        const rank: Record<IngestionSourceStatus, number> = { active: 0, stale: 1, unused: 2, disabled: 3 };
        return Number(Boolean(sourceId) && b.sourceId === sourceId) - Number(Boolean(sourceId) && a.sourceId === sourceId)
          || rank[a.status] - rank[b.status]
          || (Date.parse(b.lastSignalAt ?? b.lastSeenAt ?? b.updatedAt) - Date.parse(a.lastSignalAt ?? a.lastSeenAt ?? a.updatedAt));
      });
    const summary = {
      totalSources: items.length,
      enabledSources: items.filter((item) => item.enabled).length,
      protectedSources: items.filter((item) => item.requireToken).length,
      activeSources: items.filter((item) => item.status === 'active').length,
      staleSources: items.filter((item) => item.status === 'stale').length,
      unusedSources: items.filter((item) => item.status === 'unused').length,
      disabledSources: items.filter((item) => item.status === 'disabled').length,
      discoveredSources: items.filter((item) => item.discovered).length,
      tokenRotationOverdueSources: items.filter((item) => item.tokenRotationStatus === 'overdue').length,
      rejectedEvents: items.reduce((sum, item) => sum + item.rejectedEvents, 0),
    };
    const limit = Math.max(1, Math.min(500, query.limit ?? 120));
    return { items: items.slice(0, limit), total: items.length, summary, updateTime: iso() };
  }

  snapshot(): IngestionSourceRecord[] {
    return [...this.sources.values()].map((record) => ({
      ...record,
      tags: [...record.tags],
      ...(record.correlationClaims
        ? { correlationClaims: normalizeCorrelationClaimsPolicy(record.correlationClaims) }
        : {}),
    }));
  }

  resolve(input: IngestionSourceResolveInput): IngestionSourceResolution {
    const sourceId = clean(input.sourceId, 160);
    const token = clean(input.token, 500);
    const collectorId = clean(input.collectorId, 180);
    const sourceName = cleanText(input.sourceName, 180);
    let source: IngestionSourceRecord | undefined;
    let tokenMatched = false;
    const finish = (
      result: Pick<IngestionSourceResolution, 'accepted' | 'reason' | 'source'>,
      sourceIdMismatch = false,
    ): IngestionSourceResolution => ({
      ...result,
      authenticated: tokenMatched,
      authentication: tokenMatched ? 'token' : 'none',
      ...(correlationCaptureRollout().trustedCorrelation === 'off'
        ? {
            claimAuthorization: false as const,
            claimAuthorizationReason: 'policy_disabled' as const,
            claimAuthority: cleanClaimAuthority(input.correlationClaim?.authority),
          }
        : authorizeCorrelationClaims({
            source: result.source,
            tokenProvided: Boolean(token),
            tokenMatched,
            sourceIdMismatch,
            claim: input.correlationClaim
              ? {
                  ...input.correlationClaim,
                  collectorId: input.correlationClaim.collectorId ?? input.collectorId,
                  workspacePath: input.correlationClaim.workspacePath ?? input.workspacePath,
                }
              : undefined,
          })),
    });

    if (token) {
      const hashed = tokenHash(token);
      source = [...this.sources.values()].find((item) => item.tokenHash === hashed);
      if (!source) {
        const hinted = sourceId ? this.sources.get(sourceId) : undefined;
        return finish({ accepted: false, source: hinted, reason: 'invalid source token' });
      }
      tokenMatched = true;
      if (sourceId && source.sourceId !== sourceId) {
        return finish({ accepted: false, source, reason: 'source id does not match token' }, true);
      }
    }

    if (!source && sourceId) source = this.sources.get(sourceId);
    if (!source) source = this.findExistingIdentity(input);
    if (!source && (collectorId || sourceName)) source = this.discover({ ...input, collectorId, sourceName });
    if (!source) return finish({ accepted: true });

    if (!source.enabled) {
      return finish({ accepted: false, source, reason: 'source disabled' });
    }
    if (source.requireToken && !token) {
      return finish({ accepted: false, source, reason: 'source token required' });
    }
    return finish({ accepted: true, source });
  }

  private findExistingIdentity(input: IngestionSourceResolveInput): IngestionSourceRecord | undefined {
    const collectorId = clean(input.collectorId, 180);
    const sourceName = cleanText(input.sourceName, 180);
    const workspacePath = clean(input.workspacePath, 500);
    const type = input.type ? cleanType(input.type) : undefined;
    const records = [...this.sources.values()];
    if (collectorId) {
      const byCollector = records.filter((record) => record.collectorId === collectorId);
      if (byCollector.length) {
        if (sourceName) {
          const byName = byCollector.filter((record) => record.name === sourceName);
          if (byName.length) return this.preferIdentityMatch(byName, { sourceName, workspacePath, type });
          const protectedRecords = byCollector.filter((record) => record.requireToken);
          if (protectedRecords.length) return this.preferIdentityMatch(protectedRecords, { workspacePath, type });
          return undefined;
        }
        return this.preferIdentityMatch(byCollector, { sourceName, workspacePath, type });
      }
    }
    if (!sourceName) return undefined;
    const byName = records.filter((record) => record.name === sourceName);
    if (!byName.length) return undefined;
    const scoped = workspacePath ? byName.filter((record) => record.workspacePath === workspacePath) : byName;
    const typed = type ? scoped.filter((record) => record.type === type) : scoped;
    if (typed.length) return this.preferIdentityMatch(typed, { sourceName, workspacePath, type });
    if (scoped.length) return this.preferIdentityMatch(scoped, { sourceName, workspacePath, type });
    if (!workspacePath && byName.length === 1) return byName[0];
    return undefined;
  }

  private preferIdentityMatch(
    records: IngestionSourceRecord[],
    context: { sourceName?: string; workspacePath?: string; type?: IngestionSourceType },
  ): IngestionSourceRecord {
    return [...records].sort((a, b) => {
      const score = (record: IngestionSourceRecord): number =>
        (context.sourceName && record.name === context.sourceName ? 64 : 0) +
        (context.workspacePath && record.workspacePath === context.workspacePath ? 32 : 0) +
        (context.type && record.type === context.type ? 8 : 0) +
        (record.discovered ? 0 : 4) +
        (record.requireToken ? 2 : 0);
      return score(b) - score(a) || b.updatedAt - a.updatedAt;
    })[0];
  }

  recordAccepted(resolution: IngestionSourceResolution, kind: IngestionActivityKind, context: Partial<Pick<IngestionSourceRecord, 'collectorId' | 'workspacePath'>> = {}): void {
    if (!resolution.accepted || !resolution.source) return;
    const record = this.sources.get(resolution.source.sourceId);
    if (!record) return;
    const at = Date.now();
    record.lastSeenAt = at;
    record.updatedAt = at;
    record.lastResult = 'accepted';
    record.lastError = undefined;
    if (context.collectorId) record.collectorId = clean(context.collectorId, 180);
    if (context.workspacePath) record.workspacePath = clean(context.workspacePath, 500);
    if (kind === 'heartbeat') {
      record.lastHeartbeatAt = at;
      record.acceptedHeartbeats += 1;
    } else {
      record.lastEventAt = at;
      record.acceptedEvents += 1;
    }
    void this.currentState.recordSourceActivity({
      sourceId: record.sourceId,
      lastSeenAt: at,
      lastEventAt: kind === 'event' ? at : undefined,
      lastHeartbeatAt: kind === 'heartbeat' ? at : undefined,
      collectorId: record.collectorId,
      workspacePath: record.workspacePath,
    });
    this.persistSoon();
  }

  async refreshDistributedCurrentState(untilMs = Date.now()): Promise<void> {
    const activities = await this.currentState.latestSourceActivities(untilMs);
    for (const activity of activities) this.mergeCurrentActivity(activity);
  }

  recordRejected(resolution: IngestionSourceResolution, reason: string): void {
    if (resolution.source) {
      this.markRejected(resolution.source.sourceId, reason);
    }
  }

  checkIn(input: IngestionSourceCheckInRequest): IngestionSourceCheckInAck {
    const resolution = this.resolve({
      sourceId: input.sourceId,
      token: input.token,
      collectorId: input.collectorId,
      workspacePath: input.workspacePath,
      sourceName: input.sourceName,
      type: input.sourceType ?? 'forwarder',
    });
    if (!resolution.accepted) {
      this.recordRejected(resolution, resolution.reason ?? 'check-in rejected');
      return { accepted: false, sourceId: resolution.source?.sourceId, receivedAt: iso(), reason: resolution.reason };
    }
    this.recordAccepted(resolution, 'heartbeat', { collectorId: input.collectorId, workspacePath: input.workspacePath });
    return { accepted: true, sourceId: resolution.source?.sourceId, receivedAt: iso() };
  }

  private upsert(sourceId: string | undefined, input: IngestionSourceUpdateRequest, token?: string): IngestionSourceItem {
    const at = Date.now();
    const cur = sourceId ? this.sources.get(sourceId) : undefined;
    const type = input.type ? cleanType(input.type) : cur?.type ?? 'observer';
    const id = clean(sourceId, 160) ?? hashId([at, input.name, input.collectorId, input.workspacePath]);
    const next: IngestionSourceRecord = {
      sourceId: id,
      name: cleanText(input.name, 180) ?? cur?.name ?? clean(input.collectorId, 180) ?? `${type} source`,
      type,
      enabled: input.enabled ?? cur?.enabled ?? true,
      requireToken: 'requireToken' in input ? Boolean(input.requireToken) : cur?.requireToken ?? Boolean(token),
      tokenHash: token ? tokenHash(token) : cur?.tokenHash,
      tokenPreview: token ? tokenPreview(token) : cur?.tokenPreview,
      tokenIssuedAt: token ? at : cur?.tokenIssuedAt,
      tokenRotationDays: 'tokenRotationDays' in input ? cleanRotationDays(input.tokenRotationDays, cur?.tokenRotationDays ?? defaultTokenRotationDays()) : cur?.tokenRotationDays ?? defaultTokenRotationDays(),
      ...(correlationCaptureRollout().trustedCorrelation !== 'off' && input.correlationClaims !== undefined
        ? { correlationClaims: normalizeCorrelationClaimsPolicy(input.correlationClaims, cur?.correlationClaims) }
        : cur?.correlationClaims
          ? { correlationClaims: normalizeCorrelationClaimsPolicy(cur.correlationClaims) }
          : {}),
      collectorId: 'collectorId' in input ? clean(input.collectorId, 180) : cur?.collectorId,
      workspacePath: 'workspacePath' in input ? clean(input.workspacePath, 500) : cur?.workspacePath,
      owner: 'owner' in input ? cleanText(input.owner, 160) : cur?.owner,
      team: 'team' in input ? cleanText(input.team, 160) : cur?.team,
      environment: 'environment' in input ? cleanText(input.environment, 80) : cur?.environment,
      tags: 'tags' in input ? cleanTags(input.tags) : cur?.tags ?? [],
      note: 'note' in input ? cleanText(input.note, 2_000) : cur?.note,
      discovered: cur?.discovered ?? false,
      createdAt: cur?.createdAt ?? at,
      updatedAt: at,
      lastSeenAt: cur?.lastSeenAt,
      lastEventAt: cur?.lastEventAt,
      lastHeartbeatAt: cur?.lastHeartbeatAt,
      acceptedEvents: cur?.acceptedEvents ?? 0,
      acceptedHeartbeats: cur?.acceptedHeartbeats ?? 0,
      rejectedEvents: cur?.rejectedEvents ?? 0,
      lastResult: cur?.lastResult,
      lastError: cur?.lastError,
    };
    this.sources.set(id, next);
    this.trim();
    this.persistSoon();
    return this.item(next);
  }

  private discover(input: IngestionSourceResolveInput): IngestionSourceRecord {
    const collectorId = clean(input.collectorId, 180);
    const sourceName = cleanText(input.sourceName, 180);
    const workspacePath = clean(input.workspacePath, 500);
    const type = input.type ? cleanType(input.type) : 'observer';
    const id = collectorId
      ? hashId(['discovered', collectorId])
      : hashId(['discovered', type, sourceName, workspacePath]);
    const cur = this.sources.get(id);
    if (cur) return cur;
    const at = Date.now();
    const record: IngestionSourceRecord = {
      sourceId: id,
      name: sourceName ?? `Discovered ${type} source`,
      type,
      enabled: true,
      requireToken: false,
      collectorId,
      workspacePath,
      tags: [],
      discovered: true,
      createdAt: at,
      updatedAt: at,
      acceptedEvents: 0,
      acceptedHeartbeats: 0,
      rejectedEvents: 0,
    };
    this.sources.set(id, record);
    this.trim();
    this.persistSoon();
    return record;
  }

  private markRejected(sourceId: string, reason: string): void {
    const record = this.sources.get(sourceId);
    if (!record) return;
    const at = Date.now();
    record.updatedAt = at;
    record.lastSeenAt = at;
    record.rejectedEvents += 1;
    record.lastResult = 'rejected';
    record.lastError = cleanText(reason, 300);
    this.persistSoon();
  }

  private normalize(record: IngestionSourceRecord): IngestionSourceRecord {
    const type = cleanType(record.type);
    return {
      sourceId: clean(record.sourceId, 160) ?? hashId([record.name, Date.now()]),
      name: cleanText(record.name, 180) ?? `${type} source`,
      type,
      enabled: record.enabled !== false,
      requireToken: Boolean(record.requireToken),
      tokenHash: clean(record.tokenHash, 128),
      tokenPreview: clean(record.tokenPreview, 32),
      tokenIssuedAt: Number(record.tokenIssuedAt) || (record.tokenHash ? Number(record.createdAt) || Date.now() : undefined),
      tokenRotationDays: cleanRotationDays(record.tokenRotationDays, defaultTokenRotationDays()),
      ...(record.correlationClaims
        ? { correlationClaims: normalizeCorrelationClaimsPolicy(record.correlationClaims) }
        : {}),
      collectorId: clean(record.collectorId, 180),
      workspacePath: clean(record.workspacePath, 500),
      owner: cleanText(record.owner, 160),
      team: cleanText(record.team, 160),
      environment: cleanText(record.environment, 80),
      tags: cleanTags(record.tags),
      note: cleanText(record.note, 2_000),
      discovered: Boolean(record.discovered),
      createdAt: Number(record.createdAt) || Date.now(),
      updatedAt: Number(record.updatedAt) || Date.now(),
      lastSeenAt: Number(record.lastSeenAt) || undefined,
      lastEventAt: Number(record.lastEventAt) || undefined,
      lastHeartbeatAt: Number(record.lastHeartbeatAt) || undefined,
      acceptedEvents: Number(record.acceptedEvents) || 0,
      acceptedHeartbeats: Number(record.acceptedHeartbeats) || 0,
      rejectedEvents: Number(record.rejectedEvents) || 0,
      lastResult: record.lastResult === 'accepted' || record.lastResult === 'rejected' ? record.lastResult : undefined,
      lastError: cleanText(record.lastError, 300),
    };
  }

  private mergeCurrentActivity(activity: IngestionSourceCurrentActivity): void {
    const record = this.sources.get(activity.sourceId);
    if (!record) return;
    const existingAt = lastSignalAt(record) ?? 0;
    if (existingAt > activity.lastSeenAt) return;
    record.lastSeenAt = Math.max(record.lastSeenAt ?? 0, activity.lastSeenAt);
    record.updatedAt = Math.max(record.updatedAt, activity.lastSeenAt);
    record.lastResult = 'accepted';
    record.lastError = undefined;
    if (activity.collectorId) record.collectorId = clean(activity.collectorId, 180);
    if (activity.workspacePath) record.workspacePath = clean(activity.workspacePath, 500);
    if (activity.lastHeartbeatAt) record.lastHeartbeatAt = Math.max(record.lastHeartbeatAt ?? 0, activity.lastHeartbeatAt);
    if (activity.lastEventAt) record.lastEventAt = Math.max(record.lastEventAt ?? 0, activity.lastEventAt);
  }

  private item(record: IngestionSourceRecord): IngestionSourceItem {
    const status = statusOf(record);
    const signalAt = lastSignalAt(record);
    const rotationDueAt = tokenRotationDueAt(record);
    const rotationStatus = tokenRotationStatus(record);
    return {
      sourceId: record.sourceId,
      name: record.name,
      type: record.type,
      enabled: record.enabled,
      requireToken: record.requireToken,
      tokenPreview: record.tokenPreview,
      tokenIssuedAt: record.tokenIssuedAt ? iso(record.tokenIssuedAt) : undefined,
      tokenRotationDueAt: rotationDueAt ? iso(rotationDueAt) : undefined,
      tokenRotationDays: record.tokenRotationDays,
      ...(correlationCaptureRollout().trustedCorrelation !== 'off' && record.correlationClaims
        ? { correlationClaims: normalizeCorrelationClaimsPolicy(record.correlationClaims) }
        : {}),
      tokenAgeSecs: record.tokenIssuedAt ? Math.max(0, Math.round((Date.now() - record.tokenIssuedAt) / 1000)) : undefined,
      tokenRotationStatus: rotationStatus,
      collectorId: record.collectorId,
      workspacePath: record.workspacePath,
      owner: record.owner,
      team: record.team,
      environment: record.environment,
      tags: [...record.tags],
      note: record.note,
      discovered: record.discovered,
      createdAt: iso(record.createdAt),
      updatedAt: iso(record.updatedAt),
      lastSeenAt: record.lastSeenAt ? iso(record.lastSeenAt) : undefined,
      lastSignalAt: signalAt ? iso(signalAt) : undefined,
      lastEventAt: record.lastEventAt ? iso(record.lastEventAt) : undefined,
      lastHeartbeatAt: record.lastHeartbeatAt ? iso(record.lastHeartbeatAt) : undefined,
      acceptedEvents: record.acceptedEvents,
      acceptedHeartbeats: record.acceptedHeartbeats,
      rejectedEvents: record.rejectedEvents,
      lastResult: record.lastResult,
      lastError: record.lastError,
      status,
      statusText: statusText(status),
      ageSecs: signalAt ? Math.max(0, Math.round((Date.now() - signalAt) / 1000)) : undefined,
    };
  }

  private trim(): void {
    if (this.sources.size <= RETAIN_LIMIT) return;
    const keep = [...this.sources.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, RETAIN_LIMIT);
    this.sources.clear();
    for (const record of keep) this.sources.set(record.sourceId, record);
  }

  private persistSoon(): void {
    if (!this.initialized) return;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.persist();
    }, 500);
  }

  private persist(): Promise<void> {
    this.persistRequested = true;
    if (!this.persistInFlight) {
      this.persistInFlight = this.drainPersistence().finally(() => {
        this.persistInFlight = undefined;
        if (this.persistRequested) void this.persist();
      });
    }
    return this.persistInFlight;
  }

  private async drainPersistence(): Promise<void> {
    do {
      this.persistRequested = false;
      const records = [...this.sources.values()]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, RETAIN_LIMIT);
      await Promise.all([
        this.ch.saveIngestionSources(records),
        this.relational.saveIngestionSources(records),
      ]);
    } while (this.persistRequested);
  }

  private mergePersisted(record: IngestionSourceRecord): void {
    if (!record.sourceId) return;
    const normalized = this.normalize(record);
    const current = this.sources.get(normalized.sourceId);
    if (!current || normalized.updatedAt > current.updatedAt) {
      this.sources.set(normalized.sourceId, normalized);
    }
  }

  private async refreshRelationalState(): Promise<void> {
    for (const record of await this.relational.loadIngestionSources()) {
      this.mergePersisted(record);
    }
  }
}
