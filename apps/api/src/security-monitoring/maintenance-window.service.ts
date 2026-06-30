import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ClickHouseStore } from './clickhouse-store';
import {
  MaintenanceStatus,
  MaintenanceTargetType,
  MaintenanceWindowItem,
  MaintenanceWindowList,
  MaintenanceWindowQuery,
  MaintenanceWindowRecord,
  MaintenanceWindowUpdateRequest,
} from './types';
import { cleanText } from './redaction';

const HOUR = 3_600_000;
const WINDOW: Record<string, number> = { last_3h: 3 * HOUR, last_1d: 24 * HOUR, last_7d: 7 * 24 * HOUR, last_30d: 30 * 24 * HOUR };
const RETAIN_LIMIT = 5_000;

export interface MaintenanceMatchContext {
  workspacePath?: string;
  agentId?: string;
  collectorId?: string;
  sourceId?: string;
  nodeName?: string;
}

function iso(t = Date.now()): string {
  return new Date(t).toISOString().slice(0, 19).replace('T', ' ');
}

function parseTime(value: unknown, fallback: number): number {
  if (typeof value !== 'string') return fallback;
  const n = Date.parse(value);
  return Number.isFinite(n) ? n : fallback;
}

function clean(value: unknown, limit: number): string | undefined {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed ? trimmed.slice(0, limit) : undefined;
}

function cleanTargetType(value: unknown): MaintenanceTargetType {
  return value === 'workspace' || value === 'agent' || value === 'collector' || value === 'source' || value === 'all' ? value : 'all';
}

function statusOf(record: MaintenanceWindowRecord, at = Date.now()): MaintenanceStatus {
  if (!record.enabled) return 'disabled';
  if (record.startAt > at) return 'scheduled';
  if (record.endAt < at) return 'expired';
  return 'active';
}

function hashId(parts: Array<string | number | undefined>): string {
  const h = createHash('sha1');
  for (const p of parts) h.update(String(p ?? '')).update('\0');
  return `mw_${h.digest('hex').slice(0, 16)}`;
}

function cleanLabels(labels: unknown): Record<string, string> {
  if (!labels || typeof labels !== 'object' || Array.isArray(labels)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels as Record<string, unknown>).slice(0, 40)) {
    const k = cleanText(key, 64);
    const v = cleanText(value, 180);
    if (k && v) out[k] = v;
  }
  return out;
}

@Injectable()
export class MaintenanceWindowService implements OnModuleInit, OnModuleDestroy {
  private readonly ch = new ClickHouseStore();
  private readonly windows = new Map<string, MaintenanceWindowRecord>();
  private persistTimer?: NodeJS.Timeout;
  private initialized = false;

  async onModuleInit(): Promise<void> {
    if (await this.ch.init()) {
      for (const record of await this.ch.loadMaintenanceWindows()) {
        if (record.windowId) this.windows.set(record.windowId, this.normalize(record));
      }
    }
    this.initialized = true;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    await this.persist();
    await this.ch.close();
  }

  upsert(windowId: string | undefined, input: MaintenanceWindowUpdateRequest): MaintenanceWindowItem {
    const at = Date.now();
    const cur = windowId ? this.windows.get(windowId) : undefined;
    const startAt = parseTime(input.startAt, cur?.startAt ?? at);
    const endAt = Math.max(startAt + 60_000, parseTime(input.endAt, cur?.endAt ?? at + HOUR));
    const targetType = input.targetType ? cleanTargetType(input.targetType) : cur?.targetType ?? 'all';
    const targetId = targetType === 'all' ? '*' : clean(input.targetId, 500) ?? cur?.targetId ?? '*';
    const id = windowId || hashId([at, targetType, targetId, input.title]);
    const next: MaintenanceWindowRecord = {
      windowId: id,
      title: cleanText(input.title, 240) ?? cur?.title ?? `维护窗口 · ${targetType}:${targetId}`,
      targetType,
      targetId,
      startAt,
      endAt,
      enabled: input.enabled ?? cur?.enabled ?? true,
      reason: 'reason' in input ? cleanText(input.reason, 500) : cur?.reason,
      owner: 'owner' in input ? cleanText(input.owner, 160) : cur?.owner,
      note: 'note' in input ? cleanText(input.note, 2_000) : cur?.note,
      labels: 'labels' in input ? cleanLabels(input.labels) : cur?.labels ?? {},
      createdAt: cur?.createdAt ?? at,
      updatedAt: at,
    };
    this.windows.set(id, next);
    this.trim();
    this.persistSoon();
    return this.item(next);
  }

  has(windowId: string): boolean {
    return this.windows.has(windowId);
  }

  list(query: MaintenanceWindowQuery): MaintenanceWindowList {
    const sinceMs = this.since(query);
    const q = query.q?.trim().toLowerCase();
    const targetId = query.targetId?.trim();
    const pinnedWindowId = query.windowId?.trim();
    const hasFilter = Boolean((query.status && query.status !== 'all') || (query.targetType && query.targetType !== 'all') || targetId || q);
    const items = [...this.windows.values()]
      .filter((window) => {
        const status = statusOf(window);
        const matchesWindowId = Boolean(pinnedWindowId && window.windowId === pinnedWindowId);
        const matchesFilter =
          (status === 'active' || status === 'scheduled' || window.updatedAt >= sinceMs || window.endAt >= sinceMs) &&
          (!query.status || query.status === 'all' || status === query.status) &&
          (!query.targetType || query.targetType === 'all' || window.targetType === query.targetType) &&
          (!targetId || window.targetId === targetId) &&
          (!q || this.matches(window, q));
        if (pinnedWindowId && !hasFilter) return matchesWindowId;
        return matchesWindowId || matchesFilter;
      })
      .sort((a, b) => {
        const rank: Record<MaintenanceStatus, number> = { active: 0, scheduled: 1, disabled: 2, expired: 3 };
        return (
          Number(Boolean(pinnedWindowId) && b.windowId === pinnedWindowId) - Number(Boolean(pinnedWindowId) && a.windowId === pinnedWindowId) ||
          rank[statusOf(a)] - rank[statusOf(b)] ||
          a.startAt - b.startAt ||
          b.updatedAt - a.updatedAt
        );
      });

    const summary = {
      totalWindows: items.length,
      activeWindows: items.filter((window) => statusOf(window) === 'active').length,
      scheduledWindows: items.filter((window) => statusOf(window) === 'scheduled').length,
      expiredWindows: items.filter((window) => statusOf(window) === 'expired').length,
      disabledWindows: items.filter((window) => statusOf(window) === 'disabled').length,
    };
    const limit = Math.max(1, Math.min(500, query.limit ?? 120));
    return { items: items.slice(0, limit).map((window) => this.item(window)), total: items.length, summary, updateTime: iso() };
  }

  activeFor(ctx: MaintenanceMatchContext, at = Date.now()): MaintenanceWindowRecord | undefined {
    return [...this.windows.values()]
      .filter((window) => statusOf(window, at) === 'active' && this.targetMatches(window, ctx))
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  }

  private targetMatches(window: MaintenanceWindowRecord, ctx: MaintenanceMatchContext): boolean {
    if (window.targetType === 'all') return true;
    if (window.targetType === 'workspace') return ctx.workspacePath === window.targetId;
    if (window.targetType === 'collector') return ctx.collectorId === window.targetId || ctx.nodeName === window.targetId;
    if (window.targetType === 'source') return ctx.sourceId === window.targetId;
    if (window.targetType === 'agent') {
      return ctx.agentId === window.targetId || `${ctx.workspacePath ?? ''}:${ctx.agentId ?? ''}` === window.targetId;
    }
    return false;
  }

  private normalize(record: MaintenanceWindowRecord): MaintenanceWindowRecord {
    const targetType = cleanTargetType(record.targetType);
    const startAt = Number(record.startAt) || Date.now();
    return {
      windowId: clean(record.windowId, 120) ?? hashId([record.targetType, record.targetId, startAt]),
      title: cleanText(record.title, 240) ?? '维护窗口',
      targetType,
      targetId: targetType === 'all' ? '*' : clean(record.targetId, 500) ?? '*',
      startAt,
      endAt: Math.max(startAt + 60_000, Number(record.endAt) || startAt + HOUR),
      enabled: record.enabled !== false,
      reason: cleanText(record.reason, 500),
      owner: cleanText(record.owner, 160),
      note: cleanText(record.note, 2_000),
      labels: cleanLabels(record.labels),
      createdAt: Number(record.createdAt) || startAt,
      updatedAt: Number(record.updatedAt) || startAt,
    };
  }

  private item(record: MaintenanceWindowRecord): MaintenanceWindowItem {
    return {
      ...record,
      startAt: iso(record.startAt),
      endAt: iso(record.endAt),
      createdAt: iso(record.createdAt),
      updatedAt: iso(record.updatedAt),
      status: statusOf(record),
    };
  }

  private matches(window: MaintenanceWindowRecord, q: string): boolean {
    return [
      window.windowId,
      window.title,
      window.targetType,
      window.targetId,
      window.reason,
      window.owner,
      window.note,
      JSON.stringify(window.labels),
    ].some((value) => (value ?? '').toLowerCase().includes(q));
  }

  private since(query: MaintenanceWindowQuery): number {
    const end = Date.now();
    if (query.timeType === 'custom' && query.startTime) return Date.parse(query.startTime) || end - 3 * HOUR;
    return end - (WINDOW[query.timeType ?? 'last_7d'] ?? 7 * 24 * HOUR);
  }

  private trim(): void {
    if (this.windows.size <= RETAIN_LIMIT) return;
    const keep = [...this.windows.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, RETAIN_LIMIT);
    this.windows.clear();
    for (const record of keep) this.windows.set(record.windowId, record);
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
    const records = [...this.windows.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, RETAIN_LIMIT);
    await this.ch.saveMaintenanceWindows(records);
  }
}
