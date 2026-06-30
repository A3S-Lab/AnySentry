import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AuditService } from './audit.service';
import { ClickHouseStore } from './clickhouse-store';
import {
  AlertKind,
  AlertListItem,
  NotificationChannelItem,
  NotificationChannelRecord,
  NotificationChannelUpdateRequest,
  NotificationConfig,
  NotificationConfigQuery,
  NotificationDeliveryAction,
  NotificationDeliveryItem,
  NotificationDeliveryRecord,
  NotificationDeliveryStatus,
  NotificationRouteItem,
  NotificationRouteRecord,
  NotificationRouteUpdateRequest,
  Severity,
} from './types';

const RETAIN_LIMIT = 1_000;
const SEVERITY_RANK: Record<Severity, number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };

type NotificationMatch = {
  channel: NotificationChannelRecord;
  route?: NotificationRouteRecord;
};

function iso(t = Date.now()): string {
  return new Date(t).toISOString().slice(0, 19).replace('T', ' ');
}

function clean(value: unknown, limit: number): string | undefined {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed ? trimmed.slice(0, limit) : undefined;
}

function redactText(value: string): string {
  return value
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^"'\s,}&]+/gi, '$1[redacted]')
    .replace(/(["']?(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password|passwd|credential)["']?\s*[:=]\s*["']?)[^"'\s,}&]+/gi, '$1[redacted]')
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, 'sk-[redacted]');
}

function cleanText(value: unknown, limit: number): string | undefined {
  const trimmed = typeof value === 'string' ? redactText(value.trim()) : '';
  return trimmed ? trimmed.slice(0, limit) : undefined;
}

function hashId(prefix: string, parts: Array<string | number | undefined>): string {
  const h = createHash('sha1');
  for (const p of parts) h.update(String(p ?? '')).update('\0');
  return `${prefix}_${h.digest('hex').slice(0, 16)}`;
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

function cleanSeverity(value: unknown): Severity | undefined {
  return value === 'info' || value === 'low' || value === 'medium' || value === 'high' || value === 'critical' ? value : undefined;
}

function cleanKinds(value: unknown): AlertKind[] {
  if (!Array.isArray(value)) return [];
  const allowed = new Set<AlertKind>(['incident', 'collector', 'agent', 'event', 'source', 'coverage', 'objective', 'remediation']);
  return [...new Set(value.filter((kind): kind is AlertKind => allowed.has(kind)))];
}

function cleanKind(value: unknown): AlertKind | undefined {
  const [kind] = cleanKinds([value]);
  return kind;
}

function endpointPreview(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname && parsed.pathname !== '/' ? '/...' : ''}`;
  } catch {
    return '[invalid-url]';
  }
}

function alertText(alert: AlertListItem): string {
  return [
    alert.alertId,
    alert.title,
    alert.description,
    alert.sourceSummary,
    alert.workspacePath,
    alert.agentId,
    alert.collectorId,
    alert.sourceId,
    alert.nodeName,
    alert.owner,
    alert.team,
    alert.riskName,
    alert.riskCategory,
    alert.kind,
  ].filter(Boolean).join(' ').toLowerCase();
}

function pinFirst<T>(items: T[], pinnedId: string | undefined, idOf: (item: T) => string): T[] {
  if (!pinnedId) return items;
  return [...items].sort((a, b) => Number(idOf(b) === pinnedId) - Number(idOf(a) === pinnedId));
}

@Injectable()
export class NotificationService implements OnModuleInit, OnModuleDestroy {
  private readonly ch = new ClickHouseStore();
  private readonly channels = new Map<string, NotificationChannelRecord>();
  private readonly routes = new Map<string, NotificationRouteRecord>();
  private readonly deliveries = new Map<string, NotificationDeliveryRecord>();
  private persistTimer?: NodeJS.Timeout;
  private initialized = false;
  private readonly legacyWebhookUrl = process.env.ANYSENTRY_ALERT_WEBHOOK_URL?.trim();

  constructor(private readonly audit: AuditService) {}

  async onModuleInit(): Promise<void> {
    if (await this.ch.init()) {
      const state = await this.ch.loadNotificationState();
      for (const channel of state.channels) this.channels.set(channel.channelId, this.normalizeChannel(channel));
      for (const route of state.routes) this.routes.set(route.routeId, this.normalizeRoute(route));
      for (const delivery of state.deliveries ?? []) this.deliveries.set(delivery.deliveryId, this.normalizeDelivery(delivery));
    }
    this.initialized = true;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    await this.persist();
    await this.ch.close();
  }

  config(query: NotificationConfigQuery = {}): NotificationConfig {
    const pinnedChannelId = clean(query.channelId, 160);
    const pinnedRouteId = clean(query.routeId, 160);
    const routeKind = query.kind === 'all' ? undefined : cleanKind(query.kind);
    const routeMinSeverity = query.minSeverity === 'all' ? undefined : cleanSeverity(query.minSeverity);
    const routeWorkspacePath = clean(query.workspacePath, 500);
    const routeAgentId = clean(query.agentId, 240);
    const routeCollectorId = clean(query.collectorId, 240);
    const routeSourceId = clean(query.sourceId, 240);
    const routeOwner = clean(query.owner, 160);
    const routeTeam = clean(query.team, 160);
    const pinnedDeliveryId = clean(query.deliveryId, 180);
    const pinnedAlertId = clean(query.alertId, 180);
    const pinnedIncidentId = clean(query.incidentId, 180);
    const pinnedEventId = clean(query.eventId, 180);
    const pinnedTaskId = clean(query.taskId, 180);
    const pinnedObjectiveId = clean(query.objectiveId, 180);
    const pinnedIssueId = clean(query.issueId, 180);
    let channels = [...this.channels.values()].map((channel) => this.channelItem(channel));
    if (this.legacyWebhookUrl) {
      channels.unshift({
        channelId: 'env-webhook',
        name: 'Env webhook',
        type: 'webhook',
        enabled: true,
        endpointPreview: endpointPreview(this.legacyWebhookUrl),
        readOnly: true,
        labels: { source: 'ANYSENTRY_ALERT_WEBHOOK_URL' },
        createdAt: iso(),
        updatedAt: iso(),
      });
    }
    channels = pinFirst(channels, pinnedChannelId, (channel) => channel.channelId);
    const routeHasFilter = Boolean(routeKind || routeMinSeverity || routeWorkspacePath || routeAgentId || routeCollectorId || routeSourceId || routeOwner || routeTeam);
    const routes = pinFirst(
      [...this.routes.values()]
        .filter((route) => {
          const matchesRouteId = Boolean(pinnedRouteId && route.routeId === pinnedRouteId);
          const matchesFilter =
            (!routeKind || route.kinds.length === 0 || route.kinds.includes(routeKind)) &&
            (!routeMinSeverity || route.minSeverity === routeMinSeverity) &&
            (!routeWorkspacePath || route.workspacePath === routeWorkspacePath) &&
            (!routeAgentId || route.agentId === routeAgentId) &&
            (!routeCollectorId || route.collectorId === routeCollectorId) &&
            (!routeSourceId || route.sourceId === routeSourceId) &&
            (!routeOwner || route.owner === routeOwner) &&
            (!routeTeam || route.team === routeTeam);
          return routeHasFilter ? matchesRouteId || matchesFilter : true;
        })
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((route) => this.routeItem(route)),
      pinnedRouteId,
      (route) => route.routeId,
    );
    const deliveryLimit = Math.max(1, Math.min(300, Number(query.limit) || 80));
    const deliveryHasFilter = Boolean(
      pinnedChannelId ||
        pinnedRouteId ||
        pinnedAlertId ||
        pinnedIncidentId ||
        pinnedEventId ||
        pinnedTaskId ||
        pinnedObjectiveId ||
        pinnedIssueId ||
        routeHasFilter,
    );
    const deliveries = [...this.deliveries.values()]
      .filter((delivery) => {
        const matchesDeliveryId = Boolean(pinnedDeliveryId && delivery.deliveryId === pinnedDeliveryId);
        const matchesFilter =
          (!pinnedChannelId || delivery.channelId === pinnedChannelId) &&
          (!pinnedRouteId || delivery.routeId === pinnedRouteId) &&
          (!routeKind || delivery.alertKind === routeKind) &&
          (!routeMinSeverity || SEVERITY_RANK[delivery.alertSeverity] >= SEVERITY_RANK[routeMinSeverity]) &&
          (!routeWorkspacePath || delivery.workspacePath === routeWorkspacePath) &&
          (!routeAgentId || delivery.agentId === routeAgentId) &&
          (!routeCollectorId || delivery.collectorId === routeCollectorId) &&
          (!routeSourceId || delivery.sourceId === routeSourceId) &&
          (!routeOwner || delivery.owner === routeOwner) &&
          (!routeTeam || delivery.team === routeTeam) &&
          (!pinnedAlertId || delivery.alertId === pinnedAlertId) &&
          (!pinnedIncidentId || delivery.incidentId === pinnedIncidentId) &&
          (!pinnedEventId || delivery.eventId === pinnedEventId) &&
          (!pinnedTaskId || delivery.taskId === pinnedTaskId) &&
          (!pinnedObjectiveId || delivery.objectiveId === pinnedObjectiveId) &&
          (!pinnedIssueId || delivery.issueId === pinnedIssueId);
        if (pinnedDeliveryId && !deliveryHasFilter) return matchesDeliveryId;
        return matchesDeliveryId || matchesFilter;
      })
      .sort((a, b) => Number(Boolean(pinnedDeliveryId) && b.deliveryId === pinnedDeliveryId) - Number(Boolean(pinnedDeliveryId) && a.deliveryId === pinnedDeliveryId) || b.sentAt - a.sentAt)
      .slice(0, deliveryLimit)
      .map((delivery) => this.deliveryItem(delivery));
    return {
      channels,
      routes,
      deliveries,
      summary: {
        totalChannels: channels.length,
        enabledChannels: channels.filter((channel) => channel.enabled).length,
        totalRoutes: routes.length,
        enabledRoutes: routes.filter((route) => route.enabled).length,
        totalDeliveries: deliveries.length,
        okDeliveries: deliveries.filter((delivery) => delivery.status === 'ok').length,
        errorDeliveries: deliveries.filter((delivery) => delivery.status === 'error').length,
        notSentDeliveries: deliveries.filter((delivery) => delivery.status === 'not_sent').length,
        legacyWebhookConfigured: Boolean(this.legacyWebhookUrl),
      },
      updateTime: iso(),
    };
  }

  upsertChannel(channelId: string | undefined, input: NotificationChannelUpdateRequest): NotificationChannelItem {
    const at = Date.now();
    const cur = channelId ? this.channels.get(channelId) : undefined;
    const id = channelId || hashId('chn', [at, input.name, input.webhookUrl]);
    const next: NotificationChannelRecord = {
      channelId: id,
      name: cleanText(input.name, 160) ?? cur?.name ?? 'Webhook',
      type: input.type === 'webhook' ? input.type : cur?.type ?? 'webhook',
      enabled: input.enabled ?? cur?.enabled ?? true,
      webhookUrl: 'webhookUrl' in input ? clean(input.webhookUrl, 2_000) : cur?.webhookUrl,
      description: 'description' in input ? cleanText(input.description, 500) : cur?.description,
      labels: 'labels' in input ? cleanLabels(input.labels) : cur?.labels ?? {},
      createdAt: cur?.createdAt ?? at,
      updatedAt: at,
      lastSentAt: cur?.lastSentAt,
      lastStatus: cur?.lastStatus,
      lastError: cur?.lastError,
    };
    this.channels.set(id, next);
    this.trim();
    this.persistSoon();
    return this.channelItem(next);
  }

  hasChannel(channelId: string): boolean {
    return this.channels.has(channelId);
  }

  upsertRoute(routeId: string | undefined, input: NotificationRouteUpdateRequest): NotificationRouteItem {
    const at = Date.now();
    const cur = routeId ? this.routes.get(routeId) : undefined;
    const id = routeId || hashId('rou', [at, input.name, input.q]);
    const next: NotificationRouteRecord = {
      routeId: id,
      name: cleanText(input.name, 160) ?? cur?.name ?? 'Alert route',
      enabled: input.enabled ?? cur?.enabled ?? true,
      channelIds: Array.isArray(input.channelIds) ? [...new Set(input.channelIds.map((value) => clean(value, 160)).filter((value): value is string => Boolean(value)))] : cur?.channelIds ?? [],
      minSeverity: 'minSeverity' in input ? cleanSeverity(input.minSeverity) : cur?.minSeverity,
      kinds: 'kinds' in input ? cleanKinds(input.kinds) : cur?.kinds ?? [],
      workspacePath: 'workspacePath' in input ? clean(input.workspacePath, 500) : cur?.workspacePath,
      agentId: 'agentId' in input ? clean(input.agentId, 240) : cur?.agentId,
      collectorId: 'collectorId' in input ? clean(input.collectorId, 240) : cur?.collectorId,
      sourceId: 'sourceId' in input ? clean(input.sourceId, 240) : cur?.sourceId,
      owner: 'owner' in input ? cleanText(input.owner, 160) : cur?.owner,
      team: 'team' in input ? cleanText(input.team, 160) : cur?.team,
      q: 'q' in input ? cleanText(input.q, 240) : cur?.q,
      description: 'description' in input ? cleanText(input.description, 500) : cur?.description,
      createdAt: cur?.createdAt ?? at,
      updatedAt: at,
    };
    this.routes.set(id, next);
    this.trim();
    this.persistSoon();
    return this.routeItem(next);
  }

  hasRoute(routeId: string): boolean {
    return this.routes.has(routeId);
  }

  async dispatch(alert: AlertListItem, action: NotificationDeliveryAction, sentAt = Date.now()): Promise<number> {
    const matches = this.channelMatchesFor(alert);
    let sent = 0;
    for (const match of matches) {
      const { channel, route } = match;
      if (!channel.enabled || channel.type !== 'webhook' || !channel.webhookUrl) {
        this.recordDelivery(alert, action, match, 'not_sent', sentAt, undefined, 'channel disabled or missing webhook URL');
        continue;
      }
      const startedAt = Date.now();
      try {
        await fetch(channel.webhookUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            schemaVersion: 'anysentry.alert.v1',
            action,
            sentAt: new Date(sentAt).toISOString(),
            route: { channelId: channel.channelId, channelName: channel.name, routeId: route?.routeId, routeName: route?.name },
            alert,
          }),
        });
        this.markChannel(channel.channelId, 'ok', undefined, sentAt);
        this.recordDelivery(alert, action, match, 'ok', sentAt, Date.now() - startedAt);
        sent += 1;
      } catch (err) {
        const message = (err as Error).message;
        this.markChannel(channel.channelId, 'error', message, sentAt);
        this.recordDelivery(alert, action, match, 'error', sentAt, Date.now() - startedAt, message);
        console.error('[notification] webhook failed:', message);
      }
    }
    return sent;
  }

  private channelMatchesFor(alert: AlertListItem): NotificationMatch[] {
    const matched = new Map<string, NotificationMatch>();
    const routes = [...this.routes.values()].filter((route) => this.routeMatches(route, alert));
    for (const route of routes) {
      for (const channelId of route.channelIds) {
        if (matched.has(channelId)) continue;
        const channel = this.channels.get(channelId);
        if (channel) matched.set(channelId, { channel, route });
      }
    }
    if (matched.size) return [...matched.values()];
    if (this.legacyWebhookUrl) {
      return [{
        channel: {
          channelId: 'env-webhook',
          name: 'Env webhook',
          type: 'webhook',
          enabled: true,
          webhookUrl: this.legacyWebhookUrl,
          labels: {},
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      }];
    }
    return [];
  }

  private routeMatches(route: NotificationRouteRecord, alert: AlertListItem): boolean {
    if (!route.enabled) return false;
    if (route.minSeverity && SEVERITY_RANK[alert.severity] < SEVERITY_RANK[route.minSeverity]) return false;
    if (route.kinds.length && !route.kinds.includes(alert.kind)) return false;
    if (route.workspacePath && alert.workspacePath !== route.workspacePath) return false;
    if (route.agentId && alert.agentId !== route.agentId) return false;
    if (route.collectorId && alert.collectorId !== route.collectorId) return false;
    if (route.sourceId && alert.sourceId !== route.sourceId) return false;
    if (route.owner && alert.owner !== route.owner) return false;
    if (route.team && alert.team !== route.team) return false;
    if (route.q && !alertText(alert).includes(route.q.toLowerCase())) return false;
    return route.channelIds.length > 0;
  }

  private normalizeChannel(channel: NotificationChannelRecord): NotificationChannelRecord {
    const at = Date.now();
    return {
      channelId: clean(channel.channelId, 160) ?? hashId('chn', [channel.name, at]),
      name: cleanText(channel.name, 160) ?? 'Webhook',
      type: channel.type === 'webhook' ? 'webhook' : 'webhook',
      enabled: channel.enabled !== false,
      webhookUrl: clean(channel.webhookUrl, 2_000),
      description: cleanText(channel.description, 500),
      labels: cleanLabels(channel.labels),
      createdAt: Number(channel.createdAt) || at,
      updatedAt: Number(channel.updatedAt) || at,
      lastSentAt: Number(channel.lastSentAt) || undefined,
      lastStatus: channel.lastStatus === 'ok' || channel.lastStatus === 'error' || channel.lastStatus === 'not_sent' ? channel.lastStatus : undefined,
      lastError: cleanText(channel.lastError, 500),
    };
  }

  private normalizeDelivery(delivery: NotificationDeliveryRecord): NotificationDeliveryRecord {
    const at = Number(delivery.sentAt) || Date.now();
    const status = delivery.status === 'ok' || delivery.status === 'error' || delivery.status === 'not_sent' ? delivery.status : 'not_sent';
    return {
      deliveryId: clean(delivery.deliveryId, 180) ?? hashId('ndl', [delivery.alertId, delivery.channelId, at]),
      alertId: clean(delivery.alertId, 180) ?? 'unknown-alert',
      alertRuleId: clean(delivery.alertRuleId, 180) ?? 'unknown-rule',
      alertKind: cleanKinds([delivery.alertKind])[0] ?? 'event',
      alertSeverity: cleanSeverity(delivery.alertSeverity) ?? 'info',
      alertTitle: cleanText(delivery.alertTitle, 240) ?? 'Alert notification',
      channelId: clean(delivery.channelId, 160) ?? 'unknown-channel',
      channelName: cleanText(delivery.channelName, 160) ?? 'Webhook',
      routeId: clean(delivery.routeId, 160),
      routeName: cleanText(delivery.routeName, 160),
      action: delivery.action === 'reopened' || delivery.action === 'resolved' ? delivery.action : 'opened',
      status,
      sentAt: at,
      durationMs: Number.isFinite(Number(delivery.durationMs)) ? Math.max(0, Math.floor(Number(delivery.durationMs))) : undefined,
      error: cleanText(delivery.error, 500),
      endpointPreview: clean(delivery.endpointPreview, 240),
      workspacePath: clean(delivery.workspacePath, 500),
      agentId: clean(delivery.agentId, 240),
      collectorId: clean(delivery.collectorId, 240),
      sourceId: clean(delivery.sourceId, 240),
      incidentId: clean(delivery.incidentId, 180),
      eventId: clean(delivery.eventId, 180),
      taskId: clean(delivery.taskId, 180),
      objectiveId: clean(delivery.objectiveId, 180),
      issueId: clean(delivery.issueId, 180),
      owner: cleanText(delivery.owner, 160),
      team: cleanText(delivery.team, 160),
    };
  }

  private normalizeRoute(route: NotificationRouteRecord): NotificationRouteRecord {
    const at = Date.now();
    return {
      routeId: clean(route.routeId, 160) ?? hashId('rou', [route.name, at]),
      name: cleanText(route.name, 160) ?? 'Alert route',
      enabled: route.enabled !== false,
      channelIds: Array.isArray(route.channelIds) ? [...new Set(route.channelIds.map((id) => clean(id, 160)).filter((id): id is string => Boolean(id)))] : [],
      minSeverity: cleanSeverity(route.minSeverity),
      kinds: cleanKinds(route.kinds),
      workspacePath: clean(route.workspacePath, 500),
      agentId: clean(route.agentId, 240),
      collectorId: clean(route.collectorId, 240),
      sourceId: clean(route.sourceId, 240),
      owner: cleanText(route.owner, 160),
      team: cleanText(route.team, 160),
      q: cleanText(route.q, 240),
      description: cleanText(route.description, 500),
      createdAt: Number(route.createdAt) || at,
      updatedAt: Number(route.updatedAt) || at,
    };
  }

  private channelItem(channel: NotificationChannelRecord): NotificationChannelItem {
    return {
      channelId: channel.channelId,
      name: channel.name,
      type: channel.type,
      enabled: channel.enabled,
      endpointPreview: endpointPreview(channel.webhookUrl),
      description: channel.description,
      labels: channel.labels,
      createdAt: iso(channel.createdAt),
      updatedAt: iso(channel.updatedAt),
      lastSentAt: channel.lastSentAt ? iso(channel.lastSentAt) : undefined,
      lastStatus: channel.lastStatus,
      lastError: channel.lastError,
    };
  }

  private routeItem(route: NotificationRouteRecord): NotificationRouteItem {
    return {
      ...route,
      channelIds: [...route.channelIds],
      kinds: [...route.kinds],
      createdAt: iso(route.createdAt),
      updatedAt: iso(route.updatedAt),
    };
  }

  private deliveryItem(delivery: NotificationDeliveryRecord): NotificationDeliveryItem {
    return {
      ...delivery,
      sentAt: iso(delivery.sentAt),
    };
  }

  private markChannel(channelId: string, status: NotificationDeliveryStatus, error: string | undefined, at: number): void {
    const channel = this.channels.get(channelId);
    if (!channel) return;
    this.channels.set(channelId, {
      ...channel,
      lastSentAt: at,
      lastStatus: status,
      lastError: cleanText(error, 500),
      updatedAt: Date.now(),
    });
    this.persistSoon();
  }

  private recordDelivery(
    alert: AlertListItem,
    action: NotificationDeliveryAction,
    match: NotificationMatch,
    status: NotificationDeliveryStatus,
    sentAt: number,
    durationMs?: number,
    error?: string,
  ): void {
    const { channel, route } = match;
    const deliveryId = hashId('ndl', [alert.alertId, channel.channelId, route?.routeId, action, sentAt, status]);
    const delivery: NotificationDeliveryRecord = {
      deliveryId,
      alertId: alert.alertId,
      alertRuleId: alert.ruleId,
      alertKind: alert.kind,
      alertSeverity: alert.severity,
      alertTitle: alert.title,
      channelId: channel.channelId,
      channelName: channel.name,
      routeId: route?.routeId,
      routeName: route?.name,
      action,
      status,
      sentAt,
      durationMs,
      error: cleanText(error, 500),
      endpointPreview: endpointPreview(channel.webhookUrl),
      workspacePath: alert.workspacePath,
      agentId: alert.agentId,
      collectorId: alert.collectorId,
      sourceId: alert.sourceId,
      incidentId: alert.incidentId,
      eventId: alert.eventId,
      taskId: clean(alert.labels?.taskId, 180),
      objectiveId: clean(alert.labels?.objectiveId, 180),
      issueId: clean(alert.labels?.issueId, 180),
      owner: cleanText(alert.owner, 160),
      team: cleanText(alert.team, 160),
    };
    this.deliveries.set(deliveryId, delivery);
    this.auditFailedDelivery(delivery);
    this.trim();
    this.persistSoon();
  }

  private auditFailedDelivery(delivery: NotificationDeliveryRecord): void {
    if (delivery.status === 'ok') return;
    this.audit.record({
      actor: {
        type: 'system',
        id: 'notification-dispatcher',
        displayName: 'Notification Dispatcher',
      },
      action: 'notification.delivery_failed',
      resourceType: 'notification',
      resourceId: delivery.deliveryId,
      summary: `Notification delivery ${delivery.status}: ${delivery.alertTitle}`,
      result: 'failure',
      details: {
        deliveryId: delivery.deliveryId,
        alertId: delivery.alertId,
        alertRuleId: delivery.alertRuleId,
        alertKind: delivery.alertKind,
        alertSeverity: delivery.alertSeverity,
        alertTitle: delivery.alertTitle,
        channelId: delivery.channelId,
        channelName: delivery.channelName,
        routeId: delivery.routeId,
        routeName: delivery.routeName,
        action: delivery.action,
        status: delivery.status,
        durationMs: delivery.durationMs,
        error: delivery.error,
        endpointPreview: delivery.endpointPreview,
        workspacePath: delivery.workspacePath,
        agentId: delivery.agentId,
        collectorId: delivery.collectorId,
        sourceId: delivery.sourceId,
        incidentId: delivery.incidentId,
        eventId: delivery.eventId,
        taskId: delivery.taskId,
        objectiveId: delivery.objectiveId,
        issueId: delivery.issueId,
        owner: delivery.owner,
        team: delivery.team,
      },
    });
  }

  private trim(): void {
    if (this.channels.size > RETAIN_LIMIT) {
      const keep = [...this.channels.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, RETAIN_LIMIT);
      this.channels.clear();
      for (const channel of keep) this.channels.set(channel.channelId, channel);
    }
    if (this.routes.size > RETAIN_LIMIT) {
      const keep = [...this.routes.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, RETAIN_LIMIT);
      this.routes.clear();
      for (const route of keep) this.routes.set(route.routeId, route);
    }
    if (this.deliveries.size > RETAIN_LIMIT) {
      const keep = [...this.deliveries.values()].sort((a, b) => b.sentAt - a.sentAt).slice(0, RETAIN_LIMIT);
      this.deliveries.clear();
      for (const delivery of keep) this.deliveries.set(delivery.deliveryId, delivery);
    }
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
    await this.ch.saveNotificationState({
      channels: [...this.channels.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, RETAIN_LIMIT),
      routes: [...this.routes.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, RETAIN_LIMIT),
      deliveries: [...this.deliveries.values()].sort((a, b) => b.sentAt - a.sentAt).slice(0, RETAIN_LIMIT),
    });
  }
}
