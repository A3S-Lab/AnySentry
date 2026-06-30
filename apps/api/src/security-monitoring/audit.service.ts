import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ClickHouseStore } from './clickhouse-store';
import {
  AuditAction,
  AuditActor,
  AuditList,
  AuditListItem,
  AuditQuery,
  AuditRecord,
  AuditResourceType,
  AuditResult,
} from './types';

const HOUR = 3_600_000;
const WINDOW: Record<string, number> = { last_3h: 3 * HOUR, last_1d: 24 * HOUR, last_7d: 7 * 24 * HOUR, last_30d: 30 * 24 * HOUR };
const RETAIN_LIMIT = 5_000;
const SECRET_KEY = /(api[-_]?key|token|secret|password|credential|authorization|cookie|private[-_]?key)/i;

export interface AuditRecordInput {
  actor?: Partial<AuditActor>;
  action: AuditAction;
  resourceType: AuditResourceType;
  resourceId: string;
  summary: string;
  result?: AuditResult;
  details?: Record<string, unknown>;
}

function iso(t = Date.now()): string {
  return new Date(t).toISOString().slice(0, 19).replace('T', ' ');
}

function redactText(value: string): string {
  return value
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^"'\s,}&]+/gi, '$1[redacted]')
    .replace(/(["']?(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password|passwd|credential)["']?\s*[:=]\s*["']?)[^"'\s,}&]+/gi, '$1[redacted]')
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, 'sk-[redacted]');
}

function clean(value: unknown, limit: number): string | undefined {
  const trimmed = typeof value === 'string' ? redactText(value.trim()) : '';
  return trimmed ? trimmed.slice(0, limit) : undefined;
}

function hashId(parts: Array<string | number | undefined>): string {
  const h = createHash('sha1');
  for (const p of parts) h.update(String(p ?? '')).update('\0');
  return `aud_${h.digest('hex').slice(0, 20)}`;
}

function normalizeActor(actor?: Partial<AuditActor>): AuditActor {
  const id = clean(actor?.id, 160) ?? 'operator';
  const type = actor?.type === 'system' || actor?.type === 'api' || actor?.type === 'operator' ? actor.type : 'operator';
  return {
    type,
    id,
    displayName: clean(actor?.displayName, 160),
    sourceIp: clean(actor?.sourceIp, 80),
    userAgent: clean(actor?.userAgent, 240),
  };
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[truncated]';
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const redacted = redactText(value);
    return redacted.length > 1_000 ? `${redacted.slice(0, 1_000)}...` : redacted;
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redact(item, depth + 1));
  if (typeof value !== 'object') return String(value);

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 80)) {
    out[key] = SECRET_KEY.test(key) ? '[redacted]' : redact(item, depth + 1);
  }
  return out;
}

function sanitizeDetails(details?: Record<string, unknown>): Record<string, unknown> {
  const redacted = redact(details ?? {});
  if (!redacted || Array.isArray(redacted) || typeof redacted !== 'object') return {};
  const asRecord = redacted as Record<string, unknown>;
  const encoded = JSON.stringify(asRecord);
  if (encoded.length <= 12_000) return asRecord;
  return { truncated: true, preview: encoded.slice(0, 12_000) };
}

@Injectable()
export class AuditService implements OnModuleInit, OnModuleDestroy {
  private readonly ch = new ClickHouseStore();
  private readonly records = new Map<string, AuditRecord>();
  private persistTimer?: NodeJS.Timeout;
  private initialized = false;
  private sequence = 0;

  async onModuleInit(): Promise<void> {
    if (await this.ch.init()) {
      for (const record of await this.ch.loadAuditLog()) this.records.set(record.auditId, record);
    }
    this.initialized = true;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    await this.persist();
    await this.ch.close();
  }

  record(input: AuditRecordInput): AuditListItem {
    const at = Date.now();
    const actor = normalizeActor(input.actor);
    const auditId = hashId([at, ++this.sequence, actor.id, input.action, input.resourceType, input.resourceId]);
    const record: AuditRecord = {
      schemaVersion: 'anysentry.audit.v1',
      auditId,
      at,
      actor,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId.slice(0, 240),
      summary: redactText(input.summary).slice(0, 500),
      result: input.result ?? 'success',
      details: sanitizeDetails(input.details),
    };
    this.records.set(record.auditId, record);
    this.trim();
    this.persistSoon();
    return this.item(record);
  }

  list(query: AuditQuery): AuditList {
    const sinceMs = this.since(query);
    const pinnedAuditId = query.auditId?.trim();
    const q = query.q?.trim().toLowerCase();
    const resourceId = query.resourceId?.trim();
    const actorId = query.actorId?.trim().toLowerCase();
    const hasFilter = Boolean((query.action && query.action !== 'all') || (query.resourceType && query.resourceType !== 'all') || resourceId || actorId || q);
    const items = [...this.records.values()]
      .filter((record) => {
        const matchesAuditId = Boolean(pinnedAuditId && record.auditId === pinnedAuditId);
        const matchesFilter =
          record.at >= sinceMs &&
          (!query.action || query.action === 'all' || record.action === query.action) &&
          (!query.resourceType || query.resourceType === 'all' || record.resourceType === query.resourceType) &&
          (!resourceId || record.resourceId === resourceId) &&
          (!actorId || record.actor.id.toLowerCase() === actorId) &&
          (!q || this.matches(record, q));
        if (pinnedAuditId && !hasFilter) return matchesAuditId;
        return matchesAuditId || matchesFilter;
      })
      .sort((a, b) =>
        Number(Boolean(pinnedAuditId) && b.auditId === pinnedAuditId) - Number(Boolean(pinnedAuditId) && a.auditId === pinnedAuditId) ||
        b.at - a.at,
      );

    const summary = {
      totalRecords: items.length,
      policyActions: items.filter((record) => record.resourceType === 'policy').length,
      agentActions: items.filter((record) => record.resourceType === 'agent').length,
      maintenanceActions: items.filter((record) => record.resourceType === 'maintenance').length,
      notificationActions: items.filter((record) => record.resourceType === 'notification').length,
      objectiveActions: items.filter((record) => record.resourceType === 'objective').length,
      sourceActions: items.filter((record) => record.resourceType === 'source').length,
      incidentActions: items.filter((record) => record.resourceType === 'incident').length,
      alertActions: items.filter((record) => record.resourceType === 'alert').length,
      remediationActions: items.filter((record) => record.resourceType === 'remediation').length,
      failureActions: items.filter((record) => record.result === 'failure').length,
    };
    const limit = Math.max(1, Math.min(500, query.limit ?? 150));
    return { items: items.slice(0, limit).map((record) => this.item(record)), total: items.length, summary, updateTime: iso() };
  }

  private matches(record: AuditRecord, q: string): boolean {
    return [
      record.auditId,
      record.action,
      record.resourceType,
      record.resourceId,
      record.summary,
      record.result,
      record.actor.id,
      record.actor.displayName,
      record.actor.sourceIp,
      JSON.stringify(record.details),
    ].some((value) => (value ?? '').toLowerCase().includes(q));
  }

  private since(query: AuditQuery): number {
    const end = Date.now();
    if (query.timeType === 'custom' && query.startTime) return Date.parse(query.startTime) || end - 3 * HOUR;
    return end - (WINDOW[query.timeType ?? 'last_3h'] ?? 3 * HOUR);
  }

  private item(record: AuditRecord): AuditListItem {
    return { ...record, at: iso(record.at) };
  }

  private trim(): void {
    if (this.records.size <= RETAIN_LIMIT) return;
    const keep = [...this.records.values()].sort((a, b) => b.at - a.at).slice(0, RETAIN_LIMIT);
    this.records.clear();
    for (const record of keep) this.records.set(record.auditId, record);
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
    const records = [...this.records.values()].sort((a, b) => b.at - a.at).slice(0, RETAIN_LIMIT);
    await this.ch.saveAuditLog(records);
  }
}
