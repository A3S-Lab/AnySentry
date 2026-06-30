import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { ClickHouseStore } from './clickhouse-store';
import {
  IngestionSourceCheckInAck,
  IngestionSourceCheckInRequest,
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

const RETAIN_LIMIT = 2_000;
const STALE_AFTER_MS = 10 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

export interface IngestionSourceResolution {
  accepted: boolean;
  reason?: string;
  source?: IngestionSourceRecord;
}

export interface IngestionSourceResolveInput {
  sourceId?: string;
  token?: string;
  collectorId?: string;
  workspacePath?: string;
  sourceName?: string;
  type?: IngestionSourceType;
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
  private initialized = false;

  async onModuleInit(): Promise<void> {
    if (await this.ch.init()) {
      for (const record of await this.ch.loadIngestionSources()) {
        if (record.sourceId) this.sources.set(record.sourceId, this.normalize(record));
      }
    }
    this.initialized = true;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    await this.persist();
    await this.ch.close();
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
        const matchesFilter =
          (!query.status || query.status === 'all' || item.status === query.status) &&
          (!query.type || query.type === 'all' || item.type === query.type) &&
          (!collectorId || item.collectorId === collectorId) &&
          (!workspacePath || item.workspacePath === workspacePath) &&
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
    return [...this.sources.values()].map((record) => ({ ...record, tags: [...record.tags] }));
  }

  resolve(input: IngestionSourceResolveInput): IngestionSourceResolution {
    const sourceId = clean(input.sourceId, 160);
    const token = clean(input.token, 500);
    const collectorId = clean(input.collectorId, 180);
    const sourceName = cleanText(input.sourceName, 180);
    let source: IngestionSourceRecord | undefined;

    if (token) {
      const hashed = tokenHash(token);
      source = [...this.sources.values()].find((item) => item.tokenHash === hashed);
      if (!source) {
        const hinted = sourceId ? this.sources.get(sourceId) : undefined;
        return { accepted: false, source: hinted, reason: 'invalid source token' };
      }
      if (sourceId && source.sourceId !== sourceId) {
        return { accepted: false, source, reason: 'source id does not match token' };
      }
    }

    if (!source && sourceId) source = this.sources.get(sourceId);
    if (!source) source = this.findExistingIdentity(input);
    if (!source && (collectorId || sourceName)) source = this.discover({ ...input, collectorId, sourceName });
    if (!source) return { accepted: true };

    if (!source.enabled) {
      return { accepted: false, source, reason: 'source disabled' };
    }
    if (source.requireToken && !token) {
      return { accepted: false, source, reason: 'source token required' };
    }
    return { accepted: true, source };
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
    this.persistSoon();
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

  private async persist(): Promise<void> {
    await this.ch.saveIngestionSources([...this.sources.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, RETAIN_LIMIT));
  }
}
