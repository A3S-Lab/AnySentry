import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AlertingService } from './alerting.service';
import { AggregationService } from './aggregation.service';
import { ClickHouseStore } from './clickhouse-store';
import {
  AlertListItem,
  CoverageIssue,
  IncidentListItem,
  RemediationActionKind,
  RemediationList,
  RemediationListItem,
  RemediationQuery,
  RemediationRecord,
  RemediationSourceType,
  RemediationStatus,
  RemediationStep,
  RemediationUpdateRequest,
  Severity,
} from './types';
import { cleanText } from './redaction';

const HOUR = 3_600_000;
const WINDOW: Record<string, number> = { last_3h: 3 * HOUR, last_1d: 24 * HOUR, last_7d: 7 * 24 * HOUR, last_30d: 30 * 24 * HOUR };
const SEVERITY_RANK: Record<Severity, number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };
const RETAIN_LIMIT = 2_000;
const OVERDUE_SCAN_BUFFER_MS = 250;

function envInt(name: string, fallback: number, min: number, max: number): number {
  const n = Number(process.env[name]);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function hashId(prefix: string, parts: Array<string | number | undefined>): string {
  const h = createHash('sha1');
  for (const p of parts) h.update(String(p ?? '')).update('\0');
  return `${prefix}_${h.digest('hex').slice(0, 16)}`;
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

function active(status: RemediationStatus): boolean {
  return status === 'open' || status === 'in_progress' || status === 'blocked';
}

function clean(value: string | undefined, limit: number): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, limit) : undefined;
}

function dueFor(severity: Severity, at: number): number {
  const hours: Record<Severity, number> = { critical: 4, high: 12, medium: 36, low: 72, info: 168 };
  return at + hours[severity] * HOUR;
}

function step(stepId: string, title: string, detail?: string): RemediationStep {
  return { stepId, title, detail, done: false };
}

function stepsFor(kind: RemediationActionKind, sourceType: RemediationSourceType): RemediationStep[] {
  if (kind === 'source') {
    return [
      step('inspect_source', '检查 Sources 页面中的 sourceId、类型、owner、环境和最近错误'),
      step('verify_auth', '确认 sourceId/token 绑定、Require token 设置和生产者配置一致'),
      step('send_signal', '发送测试事件或 check-in，验证 Last Accepted Signal 更新'),
    ];
  }
  if (kind === 'collector') {
    return [
      step('inspect_collector', '检查 Collector/forwarder 进程和 DaemonSet 状态'),
      step('check_ingest', '确认 /security-center/ingest 与 heartbeat 上报可达'),
      step('verify_recovery', '等待新心跳或新事件验证恢复'),
    ];
  }
  if (kind === 'policy') {
    return [
      step('review_evidence', '查看事件证据和当前策略命中原因'),
      step('simulate_policy', '在策略配置中回放草稿策略影响'),
      step('apply_or_note', '保存策略或记录不变更原因'),
    ];
  }
  if (kind === 'credential') {
    return [
      step('scope_secret', '确认凭据访问范围和可能外泄路径'),
      step('rotate_secret', '轮换相关凭据或临时吊销权限'),
      step('verify_agent', '确认 Agent 后续事件不再访问敏感路径'),
    ];
  }
  if (kind === 'ownership') {
    return [
      step('assign_owner', '确认负责团队或服务 owner'),
      step('check_coverage', '检查 Collector 归属、agentId/workspace 识别是否正确'),
      step('close_loop', '补齐归属并复查覆盖视图'),
    ];
  }
  return [
    step('review_evidence', sourceType === 'coverage' ? '查看覆盖证据和推荐动作' : '查看事件、Alert 或 Incident 证据'),
    step('scope_impact', '确认影响 Agent、Workspace 和相关会话'),
    step('mitigate', '执行缓解动作并记录处置结果'),
  ];
}

function actionKindForText(text: string): RemediationActionKind {
  const lower = text.toLowerCase();
  if (lower.includes('source') || lower.includes('token') || text.includes('接入源')) return 'source';
  if (lower.includes('collector') || lower.includes('heartbeat') || lower.includes('daemonset') || lower.includes('forwarder') || text.includes('采集') || text.includes('心跳')) return 'collector';
  if (lower.includes('policy') || text.includes('策略')) return 'policy';
  if (lower.includes('credential') || lower.includes('secret') || text.includes('凭据') || text.includes('密钥')) return 'credential';
  if (lower.includes('egress') || lower.includes('dns') || text.includes('外联') || text.includes('网络')) return 'network';
  if (lower.includes('file') || text.includes('文件')) return 'file';
  if (text.includes('owner') || text.includes('归属') || text.includes('覆盖')) return 'ownership';
  return 'investigate';
}

@Injectable()
export class RemediationService implements OnModuleInit, OnModuleDestroy {
  private readonly ch = new ClickHouseStore();
  private readonly state = new Map<string, RemediationRecord>();
  private readonly overdueScanIntervalMs = envInt('ANYSENTRY_REMEDIATION_OVERDUE_SCAN_SECS', 60, 5, 86_400) * 1000;
  private persistTimer?: NodeJS.Timeout;
  private overdueTimer?: NodeJS.Timeout;
  private initialized = false;

  constructor(
    private readonly agg: AggregationService,
    private readonly alerting: AlertingService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (await this.ch.init()) {
      for (const record of await this.ch.loadRemediationState()) this.state.set(record.taskId, record);
    }
    this.initialized = true;
    this.scheduleOverdueScan(0);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    if (this.overdueTimer) clearTimeout(this.overdueTimer);
    await this.persist();
    await this.ch.close();
  }

  list(query: RemediationQuery): RemediationList {
    this.syncGenerated(query);
    this.syncOverdueAlerts();
    this.scheduleOverdueScan();

    const sinceMs = this.since(query);
    const q = query.q?.trim().toLowerCase();
    const pinnedTaskId = query.taskId?.trim();
    const pinnedIncidentId = query.incidentId?.trim();
    const pinnedAlertId = query.alertId?.trim();
    const pinnedEventId = query.eventId?.trim();
    const pinnedObjectiveId = query.objectiveId?.trim();
    const pinnedIssueId = query.issueId?.trim();
    const hasRelatedId = Boolean(pinnedTaskId || pinnedIncidentId || pinnedAlertId || pinnedEventId || pinnedObjectiveId || pinnedIssueId);
    const workspacePath = query.workspacePath?.trim();
    const agentId = query.agentId?.trim();
    const collectorId = query.collectorId?.trim();
    const sourceId = query.sourceId?.trim();
    const hasFilter = Boolean(
      (query.status && query.status !== 'all') ||
      (query.severity && query.severity !== 'all') ||
      (query.sourceType && query.sourceType !== 'all') ||
      (query.actionKind && query.actionKind !== 'all') ||
      q ||
      workspacePath ||
      agentId ||
      collectorId ||
      sourceId,
    );
    const items = [...this.state.values()]
      .filter((task) => {
        const matchesRelatedId = Boolean(
          (pinnedTaskId && task.taskId === pinnedTaskId) ||
            (pinnedIncidentId && task.incidentId === pinnedIncidentId) ||
            (pinnedAlertId && task.alertId === pinnedAlertId) ||
            (pinnedEventId && task.eventId === pinnedEventId) ||
            (pinnedObjectiveId && task.labels?.objectiveId === pinnedObjectiveId) ||
            (pinnedIssueId && task.sourceType === 'coverage' && (task.sourceId === pinnedIssueId || task.labels?.issueId === pinnedIssueId)),
        );
        const matchesFilter =
          (active(task.status) || task.updatedAt >= sinceMs || task.createdAt >= sinceMs) &&
          (!query.status || query.status === 'all' || task.status === query.status) &&
          (!query.severity || query.severity === 'all' || task.severity === query.severity) &&
          (!query.sourceType || query.sourceType === 'all' || task.sourceType === query.sourceType) &&
          (!query.actionKind || query.actionKind === 'all' || task.actionKind === query.actionKind) &&
          (!workspacePath || task.workspacePath === workspacePath) &&
          (!agentId || task.agentId === agentId) &&
          (!collectorId || task.collectorId === collectorId) &&
          (!sourceId || task.ingestionSourceId === sourceId) &&
          (!q || this.matches(task, q));
        if (hasRelatedId && !hasFilter) return matchesRelatedId;
        return matchesRelatedId || matchesFilter;
      })
      .sort((a, b) => {
        const statusRank: Record<RemediationStatus, number> = { open: 0, in_progress: 1, blocked: 2, done: 3, dismissed: 4 };
        return (
          Number(Boolean(pinnedTaskId) && b.taskId === pinnedTaskId) - Number(Boolean(pinnedTaskId) && a.taskId === pinnedTaskId) ||
          Number(Boolean(pinnedIncidentId) && b.incidentId === pinnedIncidentId) - Number(Boolean(pinnedIncidentId) && a.incidentId === pinnedIncidentId) ||
          Number(Boolean(pinnedAlertId) && b.alertId === pinnedAlertId) - Number(Boolean(pinnedAlertId) && a.alertId === pinnedAlertId) ||
          Number(Boolean(pinnedEventId) && b.eventId === pinnedEventId) - Number(Boolean(pinnedEventId) && a.eventId === pinnedEventId) ||
          Number(Boolean(pinnedObjectiveId) && b.labels?.objectiveId === pinnedObjectiveId) - Number(Boolean(pinnedObjectiveId) && a.labels?.objectiveId === pinnedObjectiveId) ||
          Number(Boolean(pinnedIssueId) && b.sourceType === 'coverage' && (b.sourceId === pinnedIssueId || b.labels?.issueId === pinnedIssueId)) -
            Number(Boolean(pinnedIssueId) && a.sourceType === 'coverage' && (a.sourceId === pinnedIssueId || a.labels?.issueId === pinnedIssueId)) ||
          statusRank[a.status] - statusRank[b.status] ||
          SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
          b.updatedAt - a.updatedAt
        );
      });

    const now = Date.now();
    const summary = {
      totalTasks: items.length,
      activeTasks: items.filter((task) => active(task.status)).length,
      openTasks: items.filter((task) => task.status === 'open').length,
      inProgressTasks: items.filter((task) => task.status === 'in_progress').length,
      blockedTasks: items.filter((task) => task.status === 'blocked').length,
      doneTasks: items.filter((task) => task.status === 'done').length,
      dismissedTasks: items.filter((task) => task.status === 'dismissed').length,
      overdueTasks: items.filter((task) => active(task.status) && task.dueAt && task.dueAt < now).length,
      highPriorityTasks: items.filter((task) => task.severity === 'critical' || task.severity === 'high').length,
      incidentTasks: items.filter((task) => task.sourceType === 'incident').length,
      alertTasks: items.filter((task) => task.sourceType === 'alert').length,
      coverageTasks: items.filter((task) => task.sourceType === 'coverage').length,
    };
    const limit = Math.max(1, Math.min(500, query.limit ?? 120));
    return { items: items.slice(0, limit).map((task) => this.item(task)), total: items.length, summary, updateTime: iso() };
  }

  update(taskId: string, input: RemediationUpdateRequest): RemediationListItem | null {
    const cur = this.state.get(taskId);
    if (!cur) return null;
    const at = Date.now();
    const status = input.status && ['open', 'in_progress', 'blocked', 'done', 'dismissed'].includes(input.status) ? input.status : cur.status;
    const completed = new Set(input.completedStepIds ?? cur.steps.filter((s) => s.done).map((s) => s.stepId));
    const next: RemediationRecord = {
      ...cur,
      status,
      owner: cleanText(input.owner, 120) ?? cur.owner,
      note: cleanText(input.note, 2_000) ?? cur.note,
      dueAt: input.dueAt === '' ? undefined : parseTime(input.dueAt) ?? cur.dueAt,
      updatedAt: at,
      completedAt: status === 'done' ? at : status === 'open' || status === 'in_progress' || status === 'blocked' ? undefined : cur.completedAt,
      steps: cur.steps.map((s) => ({ ...s, done: completed.has(s.stepId) })),
    };
    this.state.set(taskId, next);
    this.persistSoon();
    this.alerting.observeRemediation(this.item(next), at);
    this.scheduleOverdueScan();
    return this.item(next);
  }

  private generate(query: RemediationQuery): RemediationRecord[] {
    const filter = { timeType: query.timeType, startTime: query.startTime, endTime: query.endTime };
    const incidents = this.agg.incidents({ ...filter, status: 'all', limit: 500 }).items
      .filter((incident) => incident.status !== 'resolved')
      .map((incident) => this.fromIncident(incident));
    const alerts = this.alerting.list({ ...filter, status: 'all', limit: 500 }).items
      .filter((alert) => alert.ruleId !== 'remediation.overdue' && alert.ruleId !== 'coverage.issue' && alert.status !== 'resolved' && alert.status !== 'silenced')
      .map((alert) => this.fromAlert(alert));
    const coverageIssues = this.agg.coverageOverview({ ...filter, limit: 500 }).issues;
    this.alerting.observeCoverageList(coverageIssues);
    const coverage = coverageIssues
      .filter((issue) => !issue.suppressedByMaintenance)
      .map((issue) => this.fromCoverage(issue));
    return [...incidents, ...alerts, ...coverage];
  }

  private fromIncident(incident: IncidentListItem): RemediationRecord {
    const sourceId = incident.incidentId;
    const actionKind = actionKindForText(`${incident.riskName} ${incident.description}`);
    const createdAt = parseTime(incident.openedAt) ?? Date.now();
    const updatedAt = parseTime(incident.updatedAt) ?? createdAt;
    return {
      taskId: hashId('rem', ['incident', sourceId]),
      sourceType: 'incident',
      sourceId,
      status: incident.status === 'acknowledged' ? 'in_progress' : 'open',
      severity: incident.severity,
      actionKind,
      title: `处置 Incident · ${incident.title}`,
      description: incident.description,
      recommendedAction: '查看事件证据，确认影响范围，执行缓解动作后解决 Incident。',
      createdAt,
      updatedAt,
      dueAt: dueFor(incident.severity, createdAt),
      owner: incident.owner,
      note: incident.note,
      agentId: incident.agentId,
      workspacePath: incident.workspacePath,
      collectorId: incident.collectorId,
      ingestionSourceId: incident.sourceId,
      incidentId: incident.incidentId,
      eventId: incident.lastEventId,
      traceId: incident.traceId,
      steps: stepsFor(actionKind, 'incident'),
      labels: {
        riskCategory: incident.riskCategory,
        riskName: incident.riskName,
        eventCount: String(incident.eventCount),
        ...(incident.collectorId ? { collectorId: incident.collectorId } : {}),
        ...(incident.sourceId ? { sourceId: incident.sourceId } : {}),
      },
    };
  }

  private fromAlert(alert: AlertListItem): RemediationRecord {
    const sourceId = alert.alertId;
    const actionKind = alert.kind === 'collector' ? 'collector' : alert.kind === 'source' ? 'source' : actionKindForText(`${alert.title} ${alert.description}`);
    const createdAt = parseTime(alert.firstSeenAt) ?? Date.now();
    const updatedAt = parseTime(alert.updatedAt) ?? createdAt;
    return {
      taskId: hashId('rem', ['alert', sourceId]),
      sourceType: 'alert',
      sourceId,
      status: alert.status === 'acknowledged' ? 'in_progress' : 'open',
      severity: alert.severity,
      actionKind,
      title: `处置告警 · ${alert.title}`,
      description: alert.description,
      recommendedAction: alert.kind === 'collector'
        ? '检查采集链路并确认告警恢复。'
        : alert.kind === 'source'
          ? '检查 Sources 页面、接入 token、生产者 check-in 和 Source 告警恢复状态。'
          : alert.kind === 'objective'
            ? '查看 Objectives 页面中的违约指标、当前值和目标阈值，恢复目标后记录处置结果。'
            : '查看告警来源，关联 Incident/事件证据并记录处置结果。',
      createdAt,
      updatedAt,
      dueAt: dueFor(alert.severity, createdAt),
      owner: alert.owner,
      note: alert.note,
      agentId: alert.agentId,
      workspacePath: alert.workspacePath,
      collectorId: alert.collectorId,
      ingestionSourceId: alert.sourceId,
      nodeName: alert.nodeName,
      alertId: alert.alertId,
      incidentId: alert.incidentId,
      eventId: alert.eventId,
      traceId: alert.traceId,
      steps: stepsFor(actionKind, 'alert'),
      labels: { kind: alert.kind, ruleId: alert.ruleId, ...alert.labels },
    };
  }

  private fromCoverage(issue: CoverageIssue): RemediationRecord {
    const sourceId = issue.issueId;
    const actionKind = issue.type === 'source_token_rotation_due' ? 'credential' : actionKindForText(`${issue.title} ${issue.description} ${issue.recommendedAction}`);
    const createdAt = parseTime(issue.detectedAt) ?? Date.now();
    const updatedAt = parseTime(issue.lastSeenAt) ?? createdAt;
    return {
      taskId: hashId('rem', ['coverage', sourceId]),
      sourceType: 'coverage',
      sourceId,
      status: 'open',
      severity: issue.severity,
      actionKind,
      title: `修复覆盖问题 · ${issue.title}`,
      description: issue.description,
      recommendedAction: issue.recommendedAction,
      createdAt,
      updatedAt,
      dueAt: dueFor(issue.severity, createdAt),
      agentId: issue.agentId,
      workspacePath: issue.workspacePath,
      collectorId: issue.collectorId,
      ingestionSourceId: issue.sourceId,
      nodeName: issue.nodeName,
      eventId: issue.evidenceEventId,
      steps: stepsFor(actionKind, 'coverage'),
      labels: { ...issue.labels, type: issue.type, issueId: issue.issueId },
    };
  }

  private mergeGenerated(generated: RemediationRecord): void {
    const cur = this.state.get(generated.taskId);
    if (!cur) {
      this.state.set(generated.taskId, generated);
      this.persistSoon();
      return;
    }
    if (cur.status === 'done' || cur.status === 'dismissed') return;
    this.state.set(generated.taskId, {
      ...generated,
      status: cur.status,
      owner: cur.owner ?? generated.owner,
      note: cur.note ?? generated.note,
      dueAt: cur.dueAt ?? generated.dueAt,
      completedAt: cur.completedAt,
      updatedAt: Math.max(cur.updatedAt, generated.updatedAt),
      steps: generated.steps.map((step) => ({ ...step, done: cur.steps.find((s) => s.stepId === step.stepId)?.done ?? step.done })),
    });
    this.persistSoon();
  }

  private item(task: RemediationRecord): RemediationListItem {
    return {
      ...task,
      createdAt: iso(task.createdAt),
      updatedAt: iso(task.updatedAt),
      dueAt: task.dueAt ? iso(task.dueAt) : undefined,
      completedAt: task.completedAt ? iso(task.completedAt) : undefined,
    };
  }

  private syncOverdueAlerts(at = Date.now()): void {
    for (const task of this.state.values()) this.alerting.observeRemediation(this.item(task), at);
  }

  private syncGenerated(query: RemediationQuery): void {
    for (const task of this.generate(query)) this.mergeGenerated(task);
  }

  private runScheduledOverdueScan(): void {
    this.syncGenerated({ timeType: 'last_30d', status: 'all', limit: 500 });
    this.syncOverdueAlerts();
    this.scheduleOverdueScan();
  }

  private nextOverdueScanDelay(at = Date.now()): number {
    let nextDueAt: number | undefined;
    for (const task of this.state.values()) {
      if (!active(task.status) || !task.dueAt) continue;
      if (task.dueAt <= at) continue;
      nextDueAt = nextDueAt === undefined ? task.dueAt : Math.min(nextDueAt, task.dueAt);
    }
    if (nextDueAt !== undefined) return Math.max(OVERDUE_SCAN_BUFFER_MS, Math.min(this.overdueScanIntervalMs, nextDueAt - at + OVERDUE_SCAN_BUFFER_MS));
    return this.overdueScanIntervalMs;
  }

  private scheduleOverdueScan(delayMs?: number): void {
    if (!this.initialized) return;
    if (this.overdueTimer) clearTimeout(this.overdueTimer);
    const delay = delayMs ?? this.nextOverdueScanDelay();
    this.overdueTimer = setTimeout(() => {
      this.overdueTimer = undefined;
      this.runScheduledOverdueScan();
    }, delay);
    this.overdueTimer.unref?.();
  }

  private matches(task: RemediationRecord, q: string): boolean {
    return [
      task.taskId,
      task.title,
      task.description,
      task.recommendedAction,
      task.agentId,
      task.workspacePath,
      task.collectorId,
      task.sourceId,
      task.ingestionSourceId,
      task.nodeName,
      task.incidentId,
      task.alertId,
      task.eventId,
      task.labels?.objectiveId,
      task.labels?.issueId,
      task.actionKind,
      task.sourceType,
    ].some((value) => (value ?? '').toLowerCase().includes(q));
  }

  private since(query: RemediationQuery): number {
    const end = Date.now();
    if (query.timeType === 'custom' && query.startTime) return parseTime(query.startTime) ?? end - 3 * HOUR;
    return end - (WINDOW[query.timeType ?? 'last_3h'] ?? 3 * HOUR);
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
    const tasks = [...this.state.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, RETAIN_LIMIT);
    await this.ch.saveRemediationState(tasks);
  }
}
