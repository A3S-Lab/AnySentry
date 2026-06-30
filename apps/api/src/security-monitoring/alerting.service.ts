import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AgentMetadataService } from './agent-metadata.service';
import { ClickHouseStore } from './clickhouse-store';
import { IngestionSourceService } from './ingestion-source.service';
import { MaintenanceWindowService } from './maintenance-window.service';
import { NotificationService } from './notification.service';
import { cleanText } from './redaction';
import {
  AlertConfig,
  AlertKind,
  AlertList,
  AlertListItem,
  AlertListQuery,
  AlertRecord,
  AlertRule,
  AlertStatus,
  AlertUpdateRequest,
  CollectorHeartbeatRecord,
  CoverageIssue,
  Incident,
  IngestionSourceRecord,
  IngestionSourceType,
  JudgedEvent,
  ObjectiveItem,
  RemediationListItem,
  Severity,
} from './types';

const HOUR = 3_600_000;
const WINDOW: Record<string, number> = { last_3h: 3 * HOUR, last_1d: 24 * HOUR, last_7d: 7 * 24 * HOUR, last_30d: 30 * 24 * HOUR };
const SEVERITY_RANK: Record<Severity, number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };
const ALERT_HISTORY_LIMIT = 2_000;
const SILENCE_DEFAULT_MINUTES = 60;
const SILENCE_MAX_MINUTES = 7 * 24 * 60;

type AlertInput = Omit<
  AlertRecord,
  | 'alertId'
  | 'status'
  | 'firstSeenAt'
  | 'lastSeenAt'
  | 'updatedAt'
  | 'acknowledgedAt'
  | 'resolvedAt'
  | 'silencedUntil'
  | 'owner'
  | 'note'
  | 'occurrenceCount'
  | 'lastNotificationAt'
> & { at?: number; increment?: boolean; owner?: string };

interface SourceRejectionInput {
  reason: string;
  source?: IngestionSourceRecord;
  sourceId?: string;
  sourceName?: string;
  sourceType?: IngestionSourceType;
  collectorId?: string;
  workspacePath?: string;
  nodeName?: string;
  endpoint?: string;
  rejectedEvents?: number;
  at?: number;
}

interface SourceCheckInInput {
  source?: IngestionSourceRecord;
  sourceId?: string;
  sourceName?: string;
  sourceType?: IngestionSourceType;
  collectorId?: string;
  workspacePath?: string;
  status?: 'ok' | 'error';
  message?: string;
  at?: number;
}

interface CoverageAlertScope {
  issueId?: string;
  type?: string;
  workspacePath?: string;
  agentId?: string;
  collectorId?: string;
  sourceId?: string;
}

function hashId(prefix: string, parts: Array<string | number | undefined>): string {
  const h = createHash('sha1');
  for (const p of parts) h.update(String(p ?? '')).update('\0');
  return `${prefix}_${h.digest('hex').slice(0, 16)}`;
}

function envInt(name: string, fallback: number, min: number, max: number): number {
  const n = Number(process.env[name]);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function envSeverity(name: string, fallback: Severity): Severity {
  const v = process.env[name];
  return v === 'info' || v === 'low' || v === 'medium' || v === 'high' || v === 'critical' ? v : fallback;
}

function iso(t = Date.now()): string {
  return new Date(t).toISOString().slice(0, 19).replace('T', ' ');
}

function parseTime(value?: string): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(trimmed)
    ? `${trimmed.replace(' ', 'T')}Z`
    : trimmed;
  const n = Date.parse(normalized);
  return Number.isFinite(n) ? n : undefined;
}

function splitAgentTargetId(targetId: string | undefined): { workspacePath?: string; agentId?: string } {
  if (!targetId) return {};
  const separator = targetId.lastIndexOf(':');
  if (separator <= 0 || separator >= targetId.length - 1) return { agentId: targetId };
  return {
    workspacePath: targetId.slice(0, separator),
    agentId: targetId.slice(separator + 1),
  };
}

function active(status: AlertStatus): boolean {
  return status === 'open' || status === 'acknowledged' || status === 'silenced';
}

function maxSeverity(a: Severity, b: Severity): Severity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

function sanitizeText(value: string | undefined, limit: number): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, limit) : undefined;
}

function cleanAlertLabels(labels: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels).slice(0, 80)) {
    const k = sanitizeText(key, 80);
    const v = cleanText(value, 500);
    if (k && v) out[k] = v;
  }
  return out;
}

function attrText(event: JudgedEvent, key: string, limit: number): string | undefined {
  const promoted = key === 'collectorId' ? event.collectorId : key === 'sourceId' ? event.sourceId : undefined;
  const value = promoted?.trim() || event.attributes[key];
  return sanitizeText(value == null ? undefined : String(value), limit);
}

function sourceRejectionSeverity(reason: string): Severity {
  const normalized = reason.toLowerCase();
  if (normalized.includes('token') || normalized.includes('does not match')) return 'high';
  if (normalized.includes('disabled')) return 'medium';
  if (normalized.includes('unparseable') || normalized.includes('unsupported')) return 'medium';
  if (normalized.includes('filtered:')) return 'low';
  return 'medium';
}

function reasonKey(reason: string): string {
  return reason.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'source_rejected';
}

function sourceSignalAt(source: IngestionSourceRecord): number | undefined {
  const signalAt = Math.max(Number(source.lastEventAt) || 0, Number(source.lastHeartbeatAt) || 0);
  return signalAt > 0 ? signalAt : undefined;
}

function sourceCheckInSeverity(message: string | undefined): Severity {
  const normalized = (message ?? '').toLowerCase();
  return normalized.includes('drop') || normalized.includes('fail') || normalized.includes('error') ? 'high' : 'medium';
}

@Injectable()
export class AlertingService implements OnModuleInit, OnModuleDestroy {
  private readonly ch = new ClickHouseStore();
  private readonly alerts = new Map<string, AlertRecord>();
  private readonly incidents = new Map<string, Incident>();
  private readonly latestCollectorHeartbeat = new Map<string, CollectorHeartbeatRecord>();
  private persistTimer?: NodeJS.Timeout;
  private collectorTimer?: NodeJS.Timeout;
  private sourceTimer?: NodeJS.Timeout;
  private initialized = false;

  private readonly config: AlertConfig = {
    enabled: process.env.ANYSENTRY_ALERTS !== 'off',
    webhookConfigured: Boolean(process.env.ANYSENTRY_ALERT_WEBHOOK_URL?.trim()),
    webhookCooldownSecs: envInt('ANYSENTRY_ALERT_WEBHOOK_COOLDOWN_SECS', 300, 30, 86_400),
    incidentMinSeverity: envSeverity('ANYSENTRY_ALERT_INCIDENT_MIN_SEVERITY', 'high'),
    eventMinSeverity: envSeverity('ANYSENTRY_ALERT_EVENT_MIN_SEVERITY', 'critical'),
    agentOpenIncidentThreshold: envInt('ANYSENTRY_ALERT_AGENT_OPEN_INCIDENT_THRESHOLD', 3, 1, 100),
    collectorStaleAfterSecs: envInt('ANYSENTRY_COLLECTOR_STALE_AFTER_SECS', 180, 30, 86_400),
    collectorDownAfterSecs: envInt('ANYSENTRY_COLLECTOR_DOWN_AFTER_SECS', 600, 60, 604_800),
    sourceStaleAfterSecs: envInt('ANYSENTRY_SOURCE_STALE_AFTER_SECS', 600, 60, 604_800),
    sourceDownAfterSecs: envInt('ANYSENTRY_SOURCE_DOWN_AFTER_SECS', 1800, 120, 2_592_000),
  };

  constructor(
    private readonly maintenance: MaintenanceWindowService,
    private readonly notifications: NotificationService,
    private readonly sources: IngestionSourceService,
    private readonly agentMetadata: AgentMetadataService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (await this.ch.init()) {
      const persisted = await this.ch.loadAlertState();
      for (const rec of persisted) this.mergePersisted(rec);
    }
    this.initialized = true;
    this.collectorTimer = setInterval(() => this.checkCollectorAvailability(), 30_000);
    this.sourceTimer = setInterval(() => this.checkSourceAvailability(), 30_000);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    if (this.collectorTimer) clearInterval(this.collectorTimer);
    if (this.sourceTimer) clearInterval(this.sourceTimer);
    await this.persist();
    await this.ch.close();
  }

  getConfig(): AlertConfig {
    return { ...this.config, webhookConfigured: this.notifications.config().summary.enabledChannels > 0 };
  }

  getRules(): AlertRule[] {
    const cooldownSecs = this.config.webhookCooldownSecs;
    return [
      {
        ruleId: 'incident.high_or_critical',
        name: '高危 Incident',
        kind: 'incident',
        enabled: this.config.enabled,
        severity: this.config.incidentMinSeverity,
        cooldownSecs,
        description: '开放状态的高危/严重 Incident 会生成平台告警。',
      },
      {
        ruleId: 'collector.availability',
        name: 'Collector 断流',
        kind: 'collector',
        enabled: this.config.enabled,
        severity: 'high',
        cooldownSecs,
        description: 'Collector 心跳超过阈值未到达时生成陈旧/断流告警。',
      },
      {
        ruleId: 'collector.quality',
        name: 'Collector 降级',
        kind: 'collector',
        enabled: this.config.enabled,
        severity: 'high',
        cooldownSecs,
        description: 'Collector 上报降级、错误或丢弃事件时生成链路质量告警。',
      },
      {
        ruleId: 'agent.open_incidents',
        name: 'Agent 风险聚集',
        kind: 'agent',
        enabled: this.config.enabled,
        severity: 'high',
        cooldownSecs,
        description: '同一 Agent 的开放 Incident 数超过阈值时生成聚集告警。',
      },
      {
        ruleId: 'event.critical_block',
        name: '严重阻断事件',
        kind: 'event',
        enabled: this.config.enabled,
        severity: this.config.eventMinSeverity,
        cooldownSecs,
        description: '高危/严重阻断事件会生成证据级告警。',
      },
      {
        ruleId: 'source.rejected_ingest',
        name: '接入源拒绝',
        kind: 'source',
        enabled: this.config.enabled,
        severity: 'high',
        cooldownSecs,
        description: '接入 token 缺失/错误、禁用源、无法解析的上报会生成接入源告警。',
      },
      {
        ruleId: 'source.check_in_error',
        name: '接入源自检异常',
        kind: 'source',
        enabled: this.config.enabled,
        severity: 'high',
        cooldownSecs,
        description: 'Forwarder / bridge check-in 上报 error 状态时生成接入源健康告警。',
      },
      {
        ruleId: 'source.availability',
        name: '接入源断流',
        kind: 'source',
        enabled: this.config.enabled,
        severity: 'high',
        cooldownSecs,
        description: '接入源超过阈值没有 accepted event/heartbeat 时生成陈旧/断流告警。',
      },
      {
        ruleId: 'coverage.issue',
        name: '覆盖盲区',
        kind: 'coverage',
        enabled: this.config.enabled,
        severity: 'high',
        cooldownSecs,
        description: '高优先级覆盖盲区或 Source token 轮换到期会生成覆盖治理告警。',
      },
      {
        ruleId: 'objective.breach',
        name: 'Objective 违约',
        kind: 'objective',
        enabled: this.config.enabled,
        severity: 'high',
        cooldownSecs,
        description: '平台侧监控目标进入 breach 状态时生成管理告警。',
      },
      {
        ruleId: 'remediation.overdue',
        name: 'Remediation 逾期',
        kind: 'remediation',
        enabled: this.config.enabled,
        severity: 'high',
        cooldownSecs,
        description: '处置任务超过 dueAt 且仍未完成时生成管理告警。',
      },
    ];
  }

  observeEvent(event: JudgedEvent): void {
    if (!this.config.enabled) return;
    if (event.verdict !== 'block' || SEVERITY_RANK[event.severity] < SEVERITY_RANK[this.config.eventMinSeverity]) return;
    const collectorId = attrText(event, 'collectorId', 180);
    const sourceId = attrText(event, 'sourceId', 160);
    if (this.maintenance.activeFor({ workspacePath: event.workspacePath, agentId: event.agentId, collectorId, sourceId }, event.at)) return;
    this.upsert({
      dedupeKey: ['event', event.workspacePath, event.agentId, event.traceId, event.riskCategory].join(':'),
      ruleId: 'event.critical_block',
      kind: 'event',
      severity: event.severity,
      title: `${event.riskName} 阻断 · ${event.agentId}`,
      description: `${event.subject} (${event.reason})`,
      workspacePath: event.workspacePath,
      agentId: event.agentId,
      collectorId,
      sourceId,
      sessionId: event.sessionId,
      userId: event.userId,
      traceId: event.traceId,
      runId: event.runId,
      eventId: event.eventId,
      riskCategory: event.riskCategory,
      riskName: event.riskName,
      sourceSummary: event.subject,
      owner: this.ownerFor({ workspacePath: event.workspacePath, agentId: event.agentId, sourceId }),
      team: this.teamFor({ workspacePath: event.workspacePath, agentId: event.agentId, sourceId }),
      labels: {
        verdict: event.verdict,
        tier: event.tier,
        eventKind: event.eventKind,
        ...(collectorId ? { collectorId } : {}),
        ...(sourceId ? { sourceId } : {}),
      },
      at: event.at,
    });
  }

  observeIncident(incident: Incident): void {
    this.incidents.set(incident.incidentId, incident);
    if (!this.config.enabled) return;

    if (incident.status === 'resolved') {
      this.resolveWhere((alert) => alert.incidentId === incident.incidentId, incident.updatedAt, 'linked incident resolved');
      this.recomputeAgentIncidentAlert(incident.workspacePath, incident.agentId, incident.updatedAt);
      return;
    }

    if (incident.status === 'acknowledged') this.acknowledgeWhere((alert) => alert.incidentId === incident.incidentId, incident.updatedAt);

    if (incident.status === 'open' && SEVERITY_RANK[incident.severity] >= SEVERITY_RANK[this.config.incidentMinSeverity]) {
      if (this.maintenance.activeFor({ workspacePath: incident.workspacePath, agentId: incident.agentId, collectorId: incident.collectorId, sourceId: incident.sourceId }, incident.updatedAt)) {
        this.resolveWhere((alert) => alert.incidentId === incident.incidentId, incident.updatedAt, 'suppressed by maintenance window');
        this.recomputeAgentIncidentAlert(incident.workspacePath, incident.agentId, incident.updatedAt);
        return;
      }
      this.upsert({
        dedupeKey: ['incident', incident.incidentId].join(':'),
        ruleId: 'incident.high_or_critical',
        kind: 'incident',
        severity: incident.severity,
        title: incident.title,
        description: incident.description,
        workspacePath: incident.workspacePath,
        agentId: incident.agentId,
        collectorId: incident.collectorId,
        sourceId: incident.sourceId,
        sessionId: incident.sessionId,
        userId: incident.userId,
        traceId: incident.traceId,
        runId: incident.runId,
        incidentId: incident.incidentId,
        eventId: incident.lastEventId,
        riskCategory: incident.riskCategory,
        riskName: incident.riskName,
        sourceSummary: incident.lastEventSubject,
        owner: incident.owner ?? this.ownerFor({ workspacePath: incident.workspacePath, agentId: incident.agentId, sourceId: incident.sourceId }),
        team: this.teamFor({ workspacePath: incident.workspacePath, agentId: incident.agentId, sourceId: incident.sourceId }),
        labels: {
          riskType: incident.riskType,
          eventCount: String(incident.eventCount),
          ...(incident.collectorId ? { collectorId: incident.collectorId } : {}),
          ...(incident.sourceId ? { sourceId: incident.sourceId } : {}),
        },
        at: incident.updatedAt,
      });
    }

    this.recomputeAgentIncidentAlert(incident.workspacePath, incident.agentId, incident.updatedAt);
  }

  observeCollectorHeartbeat(heartbeat: CollectorHeartbeatRecord): void {
    this.latestCollectorHeartbeat.set(heartbeat.collectorId, heartbeat);
    if (!this.config.enabled) return;

    this.resolveWhere(
      (alert) => alert.kind === 'collector' && alert.collectorId === heartbeat.collectorId && alert.ruleId === 'collector.availability',
      heartbeat.at,
      'collector heartbeat recovered',
    );

    const dropped = heartbeat.droppedEvents + heartbeat.outputDropped;
    const degraded = heartbeat.status !== 'ok' || dropped > 0 || heartbeat.errorCount > 0;
    if (!degraded) {
      this.resolveWhere(
        (alert) => alert.kind === 'collector' && alert.collectorId === heartbeat.collectorId && alert.ruleId === 'collector.quality',
        heartbeat.at,
        'collector quality recovered',
      );
      return;
    }

    const severity: Severity = heartbeat.status === 'error' || heartbeat.errorCount > 0 || dropped > 0 ? 'high' : 'medium';
    if (this.maintenance.activeFor({ collectorId: heartbeat.collectorId, nodeName: heartbeat.nodeName }, heartbeat.at)) {
      this.resolveWhere(
        (alert) => alert.kind === 'collector' && alert.collectorId === heartbeat.collectorId,
        heartbeat.at,
        'suppressed by maintenance window',
      );
      return;
    }
    const reason = [
      heartbeat.status !== 'ok' ? `status=${heartbeat.status}` : '',
      dropped > 0 ? `dropped=${dropped}` : '',
      heartbeat.errorCount > 0 ? `errors=${heartbeat.errorCount}` : '',
      heartbeat.queueDepth > 0 ? `queue=${heartbeat.queueDepth}` : '',
    ].filter(Boolean).join(', ');
    this.upsert({
      dedupeKey: ['collector', heartbeat.collectorId, 'quality'].join(':'),
      ruleId: 'collector.quality',
      kind: 'collector',
      severity,
      title: `Collector 降级 · ${heartbeat.collectorId}`,
      description: reason || heartbeat.message || 'collector reported degraded status',
      collectorId: heartbeat.collectorId,
      nodeName: heartbeat.nodeName,
      sourceSummary: heartbeat.message || reason || heartbeat.status,
      labels: {
        status: heartbeat.status,
        droppedEvents: String(heartbeat.droppedEvents),
        outputDropped: String(heartbeat.outputDropped),
        errorCount: String(heartbeat.errorCount),
      },
      at: heartbeat.at,
    });
  }

  observeSourceRejection(input: SourceRejectionInput): void {
    if (!this.config.enabled) return;
    const at = input.at ?? Date.now();
    const sourceId = sanitizeText(input.sourceId ?? input.source?.sourceId, 160);
    const sourceName = cleanText(input.sourceName ?? input.source?.name, 180);
    const sourceType = input.sourceType ?? input.source?.type ?? 'custom';
    const collectorId = sanitizeText(input.collectorId ?? input.source?.collectorId, 180);
    const workspacePath = sanitizeText(input.workspacePath ?? input.source?.workspacePath, 500);
    const nodeName = sanitizeText(input.nodeName, 180);
    const endpoint = sanitizeText(input.endpoint, 120);
    const reason = cleanText(input.reason, 300) ?? 'source rejected';
    const rejectedEvents = Math.max(1, Math.min(10_000, Math.round(input.rejectedEvents ?? 1)));
    const target = sourceId ?? collectorId ?? sourceName ?? 'unknown-source';
    const dedupeKey = ['source', target, reasonKey(reason)].join(':');

    if (this.maintenance.activeFor({ workspacePath, collectorId, sourceId, nodeName }, at)) {
      this.resolveWhere(
        (alert) =>
          alert.kind === 'source' &&
          ((sourceId ? alert.sourceId === sourceId : false) ||
            (collectorId ? alert.collectorId === collectorId : false) ||
            (!sourceId && !collectorId && alert.dedupeKey === dedupeKey)),
        at,
        'suppressed by maintenance window',
      );
      return;
    }

    const labels: Record<string, string> = {
      reason,
      sourceType,
      rejectedEvents: String(rejectedEvents),
    };
    if (sourceId) labels.sourceId = sourceId;
    if (sourceName) labels.sourceName = sourceName;
    if (collectorId) labels.collectorId = collectorId;
    if (endpoint) labels.endpoint = endpoint;

    this.upsert({
      dedupeKey,
      ruleId: 'source.rejected_ingest',
      kind: 'source',
      severity: sourceRejectionSeverity(reason),
      title: `接入源拒绝 · ${target}`,
      description: `${rejectedEvents} 个接入事件被拒绝: ${reason}`,
      workspacePath,
      collectorId,
      sourceId,
      nodeName,
      sourceSummary: sourceName ? `${sourceName} (${sourceType})` : target,
      owner: this.ownerFor({ workspacePath, sourceId }),
      team: this.teamFor({ workspacePath, sourceId }),
      labels,
      at,
    });
  }

  observeSourceCheckIn(input: SourceCheckInInput): void {
    const at = input.at ?? Date.now();
    const sourceId = sanitizeText(input.sourceId ?? input.source?.sourceId, 160);
    const sourceName = cleanText(input.sourceName ?? input.source?.name, 180);
    const sourceType = input.sourceType ?? input.source?.type ?? 'forwarder';
    const collectorId = sanitizeText(input.collectorId ?? input.source?.collectorId, 180);
    const workspacePath = sanitizeText(input.workspacePath ?? input.source?.workspacePath, 500);
    const target = sourceId ?? collectorId ?? sourceName ?? 'unknown-source';

    if (input.status !== 'error') {
      this.resolveWhere(
        (alert) =>
          alert.kind === 'source' &&
          alert.ruleId === 'source.check_in_error' &&
          ((sourceId ? alert.sourceId === sourceId : false) ||
            (collectorId ? alert.collectorId === collectorId : false) ||
            (!sourceId && !collectorId && alert.dedupeKey === ['source', target, 'check-in-error'].join(':'))),
        at,
        'source check-in recovered',
      );
      return;
    }

    if (!this.config.enabled) return;
    const message = cleanText(input.message, 500) ?? 'source reported error status';
    if (this.maintenance.activeFor({ workspacePath, collectorId, sourceId }, at)) {
      this.resolveWhere(
        (alert) =>
          alert.kind === 'source' &&
          alert.ruleId === 'source.check_in_error' &&
          ((sourceId ? alert.sourceId === sourceId : false) ||
            (collectorId ? alert.collectorId === collectorId : false) ||
            (!sourceId && !collectorId && alert.dedupeKey === ['source', target, 'check-in-error'].join(':'))),
        at,
        'suppressed by maintenance window',
      );
      return;
    }

    const labels: Record<string, string> = { status: 'error', sourceType };
    if (sourceId) labels.sourceId = sourceId;
    if (sourceName) labels.sourceName = sourceName;
    if (collectorId) labels.collectorId = collectorId;

    this.upsert({
      dedupeKey: ['source', target, 'check-in-error'].join(':'),
      ruleId: 'source.check_in_error',
      kind: 'source',
      severity: sourceCheckInSeverity(message),
      title: `接入源自检异常 · ${target}`,
      description: message,
      workspacePath,
      collectorId,
      sourceId,
      sourceSummary: sourceName ? `${sourceName} (${sourceType})` : target,
      owner: this.ownerFor({ workspacePath, sourceId }),
      team: this.teamFor({ workspacePath, sourceId }),
      labels,
      at,
    });
  }

  observeObjective(objective: ObjectiveItem): void {
    const at = parseTime(objective.evaluatedAt) ?? Date.now();
    const dedupeKey = ['objective', objective.objectiveId].join(':');
    if (objective.status !== 'breach') {
      this.resolveWhere((alert) => alert.ruleId === 'objective.breach' && alert.dedupeKey === dedupeKey, at, `objective ${objective.status}`);
      return;
    }
    if (!this.config.enabled) return;

    const agentTarget = objective.targetType === 'agent' ? splitAgentTargetId(objective.targetId) : {};
    const workspacePath = objective.targetType === 'workspace' ? objective.targetId : agentTarget.workspacePath;
    const agentId = agentTarget.agentId;
    const collectorId = objective.targetType === 'collector' ? objective.targetId : undefined;
    const sourceId = objective.targetType === 'source' ? objective.targetId : undefined;
    if (this.maintenance.activeFor({ workspacePath, agentId, collectorId, sourceId }, at)) {
      this.resolveWhere((alert) => alert.ruleId === 'objective.breach' && alert.dedupeKey === dedupeKey, at, 'suppressed by maintenance window');
      return;
    }

    const comparatorText = objective.comparator === 'gte' ? '>=' : '<=';
    const targetText = objective.targetType === 'global' ? 'global' : `${objective.targetType}:${objective.targetId ?? 'unknown'}`;
    this.upsert({
      dedupeKey,
      ruleId: 'objective.breach',
      kind: 'objective',
      severity: objective.severity,
      title: `Objective 违约 · ${objective.name}`,
      description: `${objective.metric}=${objective.currentValue} 违反目标 ${comparatorText} ${objective.threshold}: ${objective.evidence}`,
      workspacePath,
      agentId,
      collectorId,
      sourceId,
      sourceSummary: targetText,
      owner: objective.owner ?? this.ownerFor({ workspacePath, agentId, sourceId }),
      team: this.teamFor({ workspacePath, agentId, sourceId }),
      labels: {
        objectiveId: objective.objectiveId,
        objectiveName: objective.name,
        targetType: objective.targetType,
        ...(objective.targetId ? { targetId: objective.targetId } : {}),
        metric: objective.metric,
        comparator: objective.comparator,
        threshold: String(objective.threshold),
        currentValue: String(objective.currentValue),
        evidence: objective.evidence,
      },
      at,
      increment: false,
    });
  }

  observeCoverage(issue: CoverageIssue, at = Date.now()): void {
    const dedupeKey = ['coverage', issue.issueId].join(':');
    if (issue.suppressedByMaintenance) {
      this.resolveWhere((alert) => alert.ruleId === 'coverage.issue' && alert.dedupeKey === dedupeKey, at, 'suppressed by maintenance window');
      return;
    }
    if (SEVERITY_RANK[issue.severity] < SEVERITY_RANK.medium) {
      this.resolveWhere((alert) => alert.ruleId === 'coverage.issue' && alert.dedupeKey === dedupeKey, at, 'coverage issue below alert threshold');
      return;
    }
    if (!this.config.enabled) return;

    const issueAt = parseTime(issue.lastSeenAt ?? issue.detectedAt) ?? at;
    if (this.maintenance.activeFor({ workspacePath: issue.workspacePath, agentId: issue.agentId, collectorId: issue.collectorId, sourceId: issue.sourceId, nodeName: issue.nodeName }, issueAt)) {
      this.resolveWhere((alert) => alert.ruleId === 'coverage.issue' && alert.dedupeKey === dedupeKey, issueAt, 'suppressed by maintenance window');
      return;
    }

    this.upsert({
      dedupeKey,
      ruleId: 'coverage.issue',
      kind: 'coverage',
      severity: issue.severity,
      title: issue.title,
      description: issue.description,
      workspacePath: issue.workspacePath,
      agentId: issue.agentId,
      collectorId: issue.collectorId,
      sourceId: issue.sourceId,
      nodeName: issue.nodeName,
      eventId: issue.evidenceEventId,
      sourceSummary: issue.evidenceSubject ?? issue.recommendedAction,
      owner: this.ownerFor({ workspacePath: issue.workspacePath, agentId: issue.agentId, sourceId: issue.sourceId }),
      team: this.teamFor({ workspacePath: issue.workspacePath, agentId: issue.agentId, sourceId: issue.sourceId }),
      labels: {
        issueId: issue.issueId,
        type: issue.type,
        recommendedAction: issue.recommendedAction,
        ...(issue.maintenanceWindowId ? { maintenanceWindowId: issue.maintenanceWindowId } : {}),
        ...(issue.maintenanceTitle ? { maintenanceTitle: issue.maintenanceTitle } : {}),
        ...issue.labels,
      },
      at: issueAt,
      increment: false,
    });
  }

  observeCoverageList(
    issues: CoverageIssue[],
    at = Date.now(),
    options: {
      resolveMissing?: boolean;
      scope?: CoverageAlertScope;
    } = {},
  ): void {
    const activeKeys = new Set<string>();
    for (const issue of issues) {
      if (!issue.suppressedByMaintenance && SEVERITY_RANK[issue.severity] >= SEVERITY_RANK.medium) activeKeys.add(['coverage', issue.issueId].join(':'));
      this.observeCoverage(issue, at);
    }
    if (!options.resolveMissing) return;
    this.resolveWhere(
      (alert) => alert.ruleId === 'coverage.issue' && this.matchesCoverageScope(alert, options.scope) && !activeKeys.has(alert.dedupeKey),
      at,
      'coverage issue recovered',
    );
  }

  observeRemediation(task: RemediationListItem, at = Date.now()): void {
    const dedupeKey = ['remediation', task.taskId, 'overdue'].join(':');
    const dueAt = parseTime(task.dueAt);
    const overdue = Boolean(dueAt && dueAt < at && (task.status === 'open' || task.status === 'in_progress' || task.status === 'blocked'));
    if (!overdue) {
      this.resolveWhere((alert) => alert.ruleId === 'remediation.overdue' && alert.dedupeKey === dedupeKey, at, `remediation ${task.status}`);
      return;
    }
    if (!this.config.enabled) return;

    if (this.maintenance.activeFor({ workspacePath: task.workspacePath, agentId: task.agentId, collectorId: task.collectorId, sourceId: task.ingestionSourceId }, at)) {
      this.resolveWhere((alert) => alert.ruleId === 'remediation.overdue' && alert.dedupeKey === dedupeKey, at, 'suppressed by maintenance window');
      return;
    }

    const overdueMinutes = Math.max(1, Math.round((at - (dueAt ?? at)) / 60_000));
    this.upsert({
      dedupeKey,
      ruleId: 'remediation.overdue',
      kind: 'remediation',
      severity: task.severity,
      title: `Remediation 逾期 · ${task.title}`,
      description: `处置任务 ${task.taskId} 已逾期 ${overdueMinutes} 分钟: ${task.recommendedAction}`,
      workspacePath: task.workspacePath,
      agentId: task.agentId,
      collectorId: task.collectorId,
      sourceId: task.ingestionSourceId,
      incidentId: task.incidentId,
      eventId: task.eventId,
      traceId: task.traceId,
      sourceSummary: task.title,
      owner: task.owner ?? this.ownerFor({ workspacePath: task.workspacePath, agentId: task.agentId, sourceId: task.ingestionSourceId }),
      team: this.teamFor({ workspacePath: task.workspacePath, agentId: task.agentId, sourceId: task.ingestionSourceId }),
      labels: {
        taskId: task.taskId,
        sourceType: task.sourceType,
        sourceId: task.sourceId,
        actionKind: task.actionKind,
        taskStatus: task.status,
        dueAt: task.dueAt ?? '',
        overdueMinutes: String(overdueMinutes),
        ...(task.alertId ? { alertId: task.alertId } : {}),
        ...(task.labels?.objectiveId ? { objectiveId: task.labels.objectiveId } : {}),
        ...(task.labels?.issueId ? { issueId: task.labels.issueId } : {}),
      },
      at,
      increment: false,
    });
  }

  list(query: AlertListQuery): AlertList {
    this.refreshExpiredSilences();
    const sinceMs = this.since(query);
    const limit = Math.max(1, Math.min(500, query.limit ?? 120));
    const q = query.q?.trim().toLowerCase();
    const pinnedAlertId = query.alertId?.trim();
    const workspacePath = query.workspacePath?.trim();
    const agentId = query.agentId?.trim();
    const collectorId = query.collectorId?.trim();
    const sourceId = query.sourceId?.trim();
    const incidentId = query.incidentId?.trim();
    const eventId = query.eventId?.trim();
    const taskId = query.taskId?.trim();
    const objectiveId = query.objectiveId?.trim();
    const issueId = query.issueId?.trim();
    const hasRelatedId = Boolean(eventId || taskId || objectiveId || issueId);
    const hasContextFilter = Boolean(
      (query.status && query.status !== 'all') ||
      (query.severity && query.severity !== 'all') ||
      (query.kind && query.kind !== 'all') ||
      q ||
      workspacePath ||
      agentId ||
      collectorId ||
      sourceId ||
      incidentId,
    );
    const items = [...this.alerts.values()]
      .filter((alert) => {
        const matchesAlertId = Boolean(pinnedAlertId && alert.alertId === pinnedAlertId);
        const matchesRelatedId = Boolean(
          (eventId && alert.eventId === eventId) ||
          (taskId && alert.labels?.taskId === taskId) ||
          (objectiveId && alert.labels?.objectiveId === objectiveId) ||
          (issueId && alert.labels?.issueId === issueId),
        );
        const matchesFilter =
          (active(alert.status) || alert.lastSeenAt >= sinceMs || alert.updatedAt >= sinceMs) &&
          (!query.status || query.status === 'all' || alert.status === query.status) &&
          (!query.severity || query.severity === 'all' || alert.severity === query.severity) &&
          (!query.kind || query.kind === 'all' || alert.kind === query.kind) &&
          (!workspacePath || alert.workspacePath === workspacePath) &&
          (!agentId || alert.agentId === agentId) &&
          (!collectorId || alert.collectorId === collectorId) &&
          (!sourceId || alert.sourceId === sourceId) &&
          (!incidentId || alert.incidentId === incidentId) &&
          (!q || this.matches(alert, q));
        if (pinnedAlertId && !hasRelatedId && !hasContextFilter) return matchesAlertId;
        if (!pinnedAlertId && hasRelatedId && !hasContextFilter) return matchesRelatedId;
        return matchesAlertId || matchesRelatedId || matchesFilter;
      })
      .sort((a, b) => {
        const statusRank: Record<AlertStatus, number> = { open: 0, acknowledged: 1, silenced: 2, resolved: 3 };
        return (
          Number(Boolean(pinnedAlertId) && b.alertId === pinnedAlertId) - Number(Boolean(pinnedAlertId) && a.alertId === pinnedAlertId) ||
          Number(Boolean(eventId) && b.eventId === eventId) - Number(Boolean(eventId) && a.eventId === eventId) ||
          Number(Boolean(taskId) && b.labels?.taskId === taskId) - Number(Boolean(taskId) && a.labels?.taskId === taskId) ||
          Number(Boolean(objectiveId) && b.labels?.objectiveId === objectiveId) - Number(Boolean(objectiveId) && a.labels?.objectiveId === objectiveId) ||
          Number(Boolean(issueId) && b.labels?.issueId === issueId) - Number(Boolean(issueId) && a.labels?.issueId === issueId) ||
          statusRank[a.status] - statusRank[b.status] ||
          SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
          b.lastSeenAt - a.lastSeenAt
        );
      });

    const summary = {
      totalAlerts: items.length,
      activeAlerts: items.filter((alert) => active(alert.status)).length,
      openAlerts: items.filter((alert) => alert.status === 'open').length,
      acknowledgedAlerts: items.filter((alert) => alert.status === 'acknowledged').length,
      silencedAlerts: items.filter((alert) => alert.status === 'silenced').length,
      resolvedAlerts: items.filter((alert) => alert.status === 'resolved').length,
      criticalAlerts: items.filter((alert) => alert.severity === 'critical').length,
      highAlerts: items.filter((alert) => alert.severity === 'high').length,
      incidentAlerts: items.filter((alert) => alert.kind === 'incident').length,
      collectorAlerts: items.filter((alert) => alert.kind === 'collector').length,
      agentAlerts: items.filter((alert) => alert.kind === 'agent').length,
      eventAlerts: items.filter((alert) => alert.kind === 'event').length,
      sourceAlerts: items.filter((alert) => alert.kind === 'source').length,
      coverageAlerts: items.filter((alert) => alert.kind === 'coverage').length,
      objectiveAlerts: items.filter((alert) => alert.kind === 'objective').length,
      remediationAlerts: items.filter((alert) => alert.kind === 'remediation').length,
    };

    return {
      items: items.slice(0, limit).map((alert) => this.item(alert)),
      total: items.length,
      summary,
      rules: this.getRules(),
      webhookConfigured: this.notifications.config().summary.enabledChannels > 0,
      updateTime: iso(),
    };
  }

  update(alertId: string, body: AlertUpdateRequest): AlertListItem | null {
    this.refreshExpiredSilences();
    const cur = this.alerts.get(alertId);
    if (!cur) return null;
    const statusProvided = body.status === 'open' || body.status === 'acknowledged' || body.status === 'resolved' || body.status === 'silenced';
    const status: AlertStatus = statusProvided ? body.status as AlertStatus : cur.status;
    const at = Date.now();
    const shouldNotifyResolved = status === 'resolved' && active(cur.status);
    const shouldNotifyReopened = status === 'open' && cur.status === 'resolved';
    const next: AlertRecord = {
      ...cur,
      status,
      owner: cleanText(body.owner, 120) ?? cur.owner,
      note: cleanText(body.note, 2_000) ?? cur.note,
      updatedAt: at,
      acknowledgedAt: status === 'acknowledged' ? cur.acknowledgedAt ?? at : status === 'open' ? undefined : cur.acknowledgedAt,
      resolvedAt: status === 'resolved' ? cur.resolvedAt ?? at : status === 'open' ? undefined : cur.resolvedAt,
      silencedUntil: status === 'silenced' ? (statusProvided || body.silenceMinutes !== undefined ? at + this.silenceMinutes(body.silenceMinutes) * 60_000 : cur.silencedUntil) : status === 'open' || status === 'resolved' ? undefined : cur.silencedUntil,
    };
    this.alerts.set(alertId, next);
    this.persistSoon();
    if (shouldNotifyResolved) void this.notify(next, 'resolved');
    if (shouldNotifyReopened) void this.notify(next, 'reopened');
    return this.item(next);
  }

  private ownerFor(input: { workspacePath?: string; agentId?: string; sourceId?: string }): string | undefined {
    const agentOwner = input.workspacePath && input.agentId ? this.agentMetadata.get(input.workspacePath, input.agentId)?.owner : undefined;
    if (agentOwner) return agentOwner;
    if (!input.sourceId) return undefined;
    return this.sources.snapshot().find((source) => source.sourceId === input.sourceId)?.owner;
  }

  private matchesCoverageScope(alert: AlertRecord, scope?: CoverageAlertScope): boolean {
    if (!scope) return true;
    return (
      (!scope.issueId || alert.labels?.issueId === scope.issueId) &&
      (!scope.type || alert.labels?.type === scope.type) &&
      (!scope.workspacePath || alert.workspacePath === scope.workspacePath) &&
      (!scope.agentId || alert.agentId === scope.agentId) &&
      (!scope.collectorId || alert.collectorId === scope.collectorId) &&
      (!scope.sourceId || alert.sourceId === scope.sourceId)
    );
  }

  private teamFor(input: { workspacePath?: string; agentId?: string; sourceId?: string }): string | undefined {
    const agentTeam = input.workspacePath && input.agentId ? this.agentMetadata.get(input.workspacePath, input.agentId)?.team : undefined;
    if (agentTeam) return agentTeam;
    if (!input.sourceId) return undefined;
    return this.sources.snapshot().find((source) => source.sourceId === input.sourceId)?.team;
  }

  private upsert(input: AlertInput): AlertRecord {
    const at = input.at ?? Date.now();
    const alertId = hashId('alt', [input.dedupeKey]);
    const prev = this.alerts.get(alertId);
    const silenceActive = prev?.status === 'silenced' && (prev.silencedUntil ?? 0) > at;
    const silenceExpired = prev?.status === 'silenced' && (prev.silencedUntil ?? 0) <= at;
    const reopened = !prev || prev.status === 'resolved' || silenceExpired;
    const status: AlertStatus = silenceActive ? 'silenced' : prev?.status === 'acknowledged' ? 'acknowledged' : 'open';
    const next: AlertRecord = {
      ...input,
      alertId,
      status,
      severity: prev ? maxSeverity(prev.severity, input.severity) : input.severity,
      title: cleanText(input.title, 240) ?? 'Alert',
      description: cleanText(input.description, 1_000) ?? '',
      sourceSummary: cleanText(input.sourceSummary, 500) ?? '',
      labels: cleanAlertLabels(input.labels),
      firstSeenAt: prev?.firstSeenAt ?? at,
      lastSeenAt: Math.max(prev?.lastSeenAt ?? 0, at),
      updatedAt: at,
      acknowledgedAt: status === 'acknowledged' ? prev?.acknowledgedAt : undefined,
      resolvedAt: undefined,
      silencedUntil: silenceActive ? prev?.silencedUntil : undefined,
      owner: prev?.owner ?? cleanText(input.owner, 160),
      team: cleanText(input.team, 160) ?? prev?.team,
      note: prev?.note,
      occurrenceCount: (prev?.occurrenceCount ?? 0) + (input.increment === false ? 0 : 1),
      lastNotificationAt: prev?.lastNotificationAt,
    };
    this.alerts.set(alertId, next);
    this.persistSoon();
    if (status === 'open' && (reopened || !prev || SEVERITY_RANK[next.severity] > SEVERITY_RANK[prev.severity])) {
      void this.notify(next, prev ? 'reopened' : 'opened');
    }
    return next;
  }

  private recomputeAgentIncidentAlert(workspacePath: string, agentId: string, at = Date.now()): void {
    const open = [...this.incidents.values()].filter((incident) => incident.status === 'open' && incident.workspacePath === workspacePath && incident.agentId === agentId);
    const dedupeKey = ['agent', workspacePath, agentId, 'open-incidents'].join(':');
    if (this.maintenance.activeFor({ workspacePath, agentId }, at)) {
      this.resolveWhere((alert) => alert.dedupeKey === dedupeKey, at, 'suppressed by maintenance window');
      return;
    }
    if (open.length < this.config.agentOpenIncidentThreshold) {
      this.resolveWhere((alert) => alert.dedupeKey === dedupeKey, at, 'agent incident pressure recovered');
      return;
    }
    const worstSeverity = open.reduce<Severity>((worst, incident) => maxSeverity(worst, incident.severity), 'info');
    const severity: Severity = SEVERITY_RANK[worstSeverity] >= SEVERITY_RANK.critical || open.length >= this.config.agentOpenIncidentThreshold * 2 ? 'critical' : 'high';
    const top = [...open].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    this.upsert({
      dedupeKey,
      ruleId: 'agent.open_incidents',
      kind: 'agent',
      severity,
      title: `Agent 风险聚集 · ${agentId}`,
      description: `${open.length} 个开放 Incident 聚集在同一 Agent。最近风险: ${top?.riskName ?? 'unknown'}`,
      workspacePath,
      agentId,
      sessionId: top?.sessionId,
      userId: top?.userId,
      traceId: top?.traceId,
      runId: top?.runId,
      incidentId: top?.incidentId,
      riskCategory: top?.riskCategory,
      riskName: top?.riskName,
      sourceSummary: top?.lastEventSubject ?? `${open.length} open incidents`,
      owner: this.ownerFor({ workspacePath, agentId, sourceId: top?.sourceId }),
      team: this.teamFor({ workspacePath, agentId, sourceId: top?.sourceId }),
      labels: { openIncidentCount: String(open.length) },
      at,
    });
  }

  private checkCollectorAvailability(at = Date.now()): void {
    if (!this.config.enabled) return;
    for (const heartbeat of this.latestCollectorHeartbeat.values()) {
      const ageSecs = Math.floor((at - heartbeat.at) / 1000);
      if (ageSecs >= this.config.collectorDownAfterSecs) {
        if (this.maintenance.activeFor({ collectorId: heartbeat.collectorId, nodeName: heartbeat.nodeName }, at)) {
          this.resolveWhere((alert) => alert.kind === 'collector' && alert.collectorId === heartbeat.collectorId, at, 'suppressed by maintenance window');
          continue;
        }
        this.upsertCollectorAvailability(heartbeat, 'critical', `Collector 断流 · ${heartbeat.collectorId}`, `last heartbeat ${ageSecs}s ago`, at);
      } else if (ageSecs >= this.config.collectorStaleAfterSecs) {
        if (this.maintenance.activeFor({ collectorId: heartbeat.collectorId, nodeName: heartbeat.nodeName }, at)) {
          this.resolveWhere((alert) => alert.kind === 'collector' && alert.collectorId === heartbeat.collectorId, at, 'suppressed by maintenance window');
          continue;
        }
        this.upsertCollectorAvailability(heartbeat, 'high', `Collector 心跳陈旧 · ${heartbeat.collectorId}`, `last heartbeat ${ageSecs}s ago`, at);
      } else {
        this.resolveWhere(
          (alert) => alert.kind === 'collector' && alert.collectorId === heartbeat.collectorId && alert.ruleId === 'collector.availability',
          at,
          'collector availability recovered',
        );
      }
    }
  }

  private checkSourceAvailability(at = Date.now()): void {
    if (!this.config.enabled) return;
    for (const source of this.sources.snapshot()) {
      const dedupeKey = ['source', source.sourceId, 'availability'].join(':');
      const signalAt = sourceSignalAt(source);
      const match = (alert: AlertRecord) => alert.kind === 'source' && alert.ruleId === 'source.availability' && alert.sourceId === source.sourceId;
      if (!source.enabled || !signalAt) {
        this.resolveWhere(match, at, source.enabled ? 'source has not emitted accepted signals yet' : 'source disabled');
        continue;
      }

      const ageSecs = Math.floor((at - signalAt) / 1000);
      if (ageSecs < this.config.sourceStaleAfterSecs) {
        this.resolveWhere(match, at, 'source recovered');
        continue;
      }

      if (this.maintenance.activeFor({ workspacePath: source.workspacePath, collectorId: source.collectorId, sourceId: source.sourceId }, at)) {
        this.resolveWhere(match, at, 'suppressed by maintenance window');
        continue;
      }

      if (ageSecs >= this.config.sourceDownAfterSecs) {
        this.upsertSourceAvailability(source, 'high', `接入源断流 · ${source.sourceId}`, `last accepted signal ${ageSecs}s ago`, signalAt, at, dedupeKey);
      } else {
        this.upsertSourceAvailability(source, 'medium', `接入源心跳陈旧 · ${source.sourceId}`, `last accepted signal ${ageSecs}s ago`, signalAt, at, dedupeKey);
      }
    }
  }

  private upsertCollectorAvailability(heartbeat: CollectorHeartbeatRecord, severity: Severity, title: string, description: string, at: number): void {
    this.upsert({
      dedupeKey: ['collector', heartbeat.collectorId, 'availability'].join(':'),
      ruleId: 'collector.availability',
      kind: 'collector',
      severity,
      title,
      description,
      collectorId: heartbeat.collectorId,
      nodeName: heartbeat.nodeName,
      sourceSummary: description,
      labels: { lastHeartbeatAt: iso(heartbeat.at) },
      at,
      increment: false,
    });
  }

  private upsertSourceAvailability(source: IngestionSourceRecord, severity: Severity, title: string, description: string, signalAt: number, at: number, dedupeKey: string): void {
    const labels: Record<string, string> = {
      sourceType: source.type,
      lastSignalAt: iso(signalAt),
      acceptedEvents: String(source.acceptedEvents),
      acceptedHeartbeats: String(source.acceptedHeartbeats),
    };
    if (source.collectorId) labels.collectorId = source.collectorId;
    if (source.workspacePath) labels.workspacePath = source.workspacePath;
    if (source.environment) labels.environment = source.environment;
    this.upsert({
      dedupeKey,
      ruleId: 'source.availability',
      kind: 'source',
      severity,
      title,
      description,
      workspacePath: source.workspacePath,
      collectorId: source.collectorId,
      sourceId: source.sourceId,
      sourceSummary: `${source.name} (${source.type})`,
      owner: source.owner,
      team: source.team,
      labels,
      at,
      increment: false,
    });
  }

  private resolveWhere(match: (alert: AlertRecord) => boolean, at: number, reason: string): void {
    let changed = false;
    for (const alert of this.alerts.values()) {
      if (!active(alert.status) || !match(alert)) continue;
      const resolved: AlertRecord = {
        ...alert,
        status: 'resolved',
        resolvedAt: at,
        silencedUntil: undefined,
        updatedAt: at,
        note: alert.note ?? reason,
      };
      this.alerts.set(alert.alertId, resolved);
      void this.notify(resolved, 'resolved');
      changed = true;
    }
    if (changed) this.persistSoon();
  }

  private acknowledgeWhere(match: (alert: AlertRecord) => boolean, at: number): void {
    let changed = false;
    for (const alert of this.alerts.values()) {
      if (alert.status !== 'open' || !match(alert)) continue;
      this.alerts.set(alert.alertId, { ...alert, status: 'acknowledged', acknowledgedAt: at, updatedAt: at });
      changed = true;
    }
    if (changed) this.persistSoon();
  }

  private refreshExpiredSilences(at = Date.now()): void {
    let changed = false;
    for (const alert of this.alerts.values()) {
      if (alert.status !== 'silenced' || !alert.silencedUntil || alert.silencedUntil > at) continue;
      this.alerts.set(alert.alertId, { ...alert, status: 'open', silencedUntil: undefined, updatedAt: at });
      changed = true;
    }
    if (changed) this.persistSoon();
  }

  private matches(alert: AlertRecord, q: string): boolean {
    return [
      alert.alertId,
      alert.title,
      alert.description,
      alert.sourceSummary,
      alert.agentId,
      alert.collectorId,
      alert.sourceId,
      alert.nodeName,
      alert.owner,
      alert.team,
      alert.incidentId,
      alert.eventId,
      alert.traceId,
      alert.riskCategory,
      alert.riskName,
      ...Object.entries(alert.labels ?? {}).flat(),
    ].some((value) => (value ?? '').toLowerCase().includes(q));
  }

  private since(query: AlertListQuery): number {
    const end = Date.now();
    if (query.timeType === 'custom' && query.startTime) return parseTime(query.startTime) ?? end - 3 * HOUR;
    return end - (WINDOW[query.timeType ?? 'last_3h'] ?? 3 * HOUR);
  }

  private silenceMinutes(input: number | undefined): number {
    const n = Number(input ?? SILENCE_DEFAULT_MINUTES);
    if (!Number.isFinite(n)) return SILENCE_DEFAULT_MINUTES;
    return Math.max(5, Math.min(SILENCE_MAX_MINUTES, Math.round(n)));
  }

  private item(alert: AlertRecord): AlertListItem {
    return {
      ...alert,
      firstSeenAt: iso(alert.firstSeenAt),
      lastSeenAt: iso(alert.lastSeenAt),
      updatedAt: iso(alert.updatedAt),
      acknowledgedAt: alert.acknowledgedAt ? iso(alert.acknowledgedAt) : undefined,
      resolvedAt: alert.resolvedAt ? iso(alert.resolvedAt) : undefined,
      silencedUntil: alert.silencedUntil ? iso(alert.silencedUntil) : undefined,
      lastNotificationAt: alert.lastNotificationAt ? iso(alert.lastNotificationAt) : undefined,
    };
  }

  private async notify(alert: AlertRecord, action: 'opened' | 'reopened' | 'resolved'): Promise<void> {
    if (action === 'resolved' ? alert.status !== 'resolved' : alert.status !== 'open') return;
    const at = Date.now();
    if (action === 'opened' && alert.lastNotificationAt && at - alert.lastNotificationAt < this.config.webhookCooldownSecs * 1000) return;
    const sent = await this.notifications.dispatch(this.item(alert), action, at);
    if (sent > 0) {
      const cur = this.alerts.get(alert.alertId);
      if (cur) this.alerts.set(alert.alertId, { ...cur, lastNotificationAt: at });
      this.persistSoon();
    }
  }

  private mergePersisted(rec: AlertRecord): void {
    const cur = this.alerts.get(rec.alertId);
    if (!cur) {
      this.alerts.set(rec.alertId, {
        ...rec,
        title: cleanText(rec.title, 240) ?? 'Alert',
        description: cleanText(rec.description, 1_000) ?? '',
        sourceSummary: cleanText(rec.sourceSummary, 500) ?? '',
        owner: cleanText(rec.owner, 160),
        team: cleanText(rec.team, 160),
        note: cleanText(rec.note, 2_000),
        labels: cleanAlertLabels(rec.labels ?? {}),
      });
      return;
    }
    this.alerts.set(rec.alertId, {
      ...cur,
      status: rec.status,
      owner: cleanText(rec.owner, 160),
      team: cleanText(rec.team, 160),
      note: cleanText(rec.note, 2_000),
      acknowledgedAt: rec.acknowledgedAt,
      resolvedAt: rec.resolvedAt,
      silencedUntil: rec.silencedUntil,
      lastNotificationAt: rec.lastNotificationAt,
      updatedAt: Math.max(cur.updatedAt, rec.updatedAt),
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
    const alerts = [...this.alerts.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, ALERT_HISTORY_LIMIT);
    await this.ch.saveAlertState(alerts);
  }
}
