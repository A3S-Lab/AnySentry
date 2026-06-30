import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AggregationService } from './aggregation.service';
import { AlertingService } from './alerting.service';
import { ClickHouseStore } from './clickhouse-store';
import { IngestionSourceService } from './ingestion-source.service';
import { RemediationService } from './remediation.service';
import {
  AlertStatus,
  ObjectiveComparator,
  ObjectiveItem,
  ObjectiveList,
  ObjectiveMetric,
  ObjectiveQuery,
  ObjectiveRecord,
  ObjectiveStatus,
  ObjectiveTargetType,
  ObjectiveUpdateRequest,
  Severity,
} from './types';
import { cleanText } from './redaction';

const RETAIN_LIMIT = 1_000;
const SEVERITY_RANK: Record<Severity, number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };

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
  return `obj_${h.digest('hex').slice(0, 16)}`;
}

function cleanTargetType(value: unknown): ObjectiveTargetType {
  return value === 'workspace' || value === 'agent' || value === 'collector' || value === 'source' || value === 'global' ? value : 'global';
}

function cleanMetric(value: unknown): ObjectiveMetric {
  return value === 'coverage_score' || value === 'open_incidents' || value === 'active_alerts' || value === 'overdue_remediations' || value === 'risky_events' || value === 'stale_agents' || value === 'collector_down' || value === 'source_down'
    ? value
    : 'active_alerts';
}

function cleanComparator(value: unknown): ObjectiveComparator {
  return value === 'gte' || value === 'lte' ? value : 'lte';
}

function cleanSeverity(value: unknown): Severity {
  return value === 'info' || value === 'low' || value === 'medium' || value === 'high' || value === 'critical' ? value : 'high';
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

function isActiveAlert(status: AlertStatus): boolean {
  return status === 'open' || status === 'acknowledged' || status === 'silenced';
}

function countsTowardActiveAlertObjective(alert: { ruleId: string; status: AlertStatus }): boolean {
  // Governance alerts have their own objective signals and should not recursively inflate alert-count objectives.
  return isActiveAlert(alert.status) && alert.ruleId !== 'objective.breach' && alert.ruleId !== 'coverage.issue';
}

@Injectable()
export class ObjectiveService implements OnModuleInit, OnModuleDestroy {
  private readonly ch = new ClickHouseStore();
  private readonly objectives = new Map<string, ObjectiveRecord>();
  private persistTimer?: NodeJS.Timeout;
  private initialized = false;

  constructor(
    private readonly agg: AggregationService,
    private readonly alerting: AlertingService,
    private readonly sources: IngestionSourceService,
    private readonly remediations: RemediationService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (await this.ch.init()) {
      for (const record of await this.ch.loadObjectives()) {
        if (record.objectiveId) this.objectives.set(record.objectiveId, this.normalize(record));
      }
    }
    this.initialized = true;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    await this.persist();
    await this.ch.close();
  }

  upsert(objectiveId: string | undefined, input: ObjectiveUpdateRequest): ObjectiveItem {
    const at = Date.now();
    const cur = objectiveId ? this.objectives.get(objectiveId) : undefined;
    const targetType = input.targetType ? cleanTargetType(input.targetType) : cur?.targetType ?? 'global';
    const metric = input.metric ? cleanMetric(input.metric) : cur?.metric ?? 'active_alerts';
    const comparator = input.comparator ? cleanComparator(input.comparator) : cur?.comparator ?? (metric === 'coverage_score' ? 'gte' : 'lte');
    const id = objectiveId || hashId([at, input.name, targetType, input.targetId, metric]);
    const next: ObjectiveRecord = {
      objectiveId: id,
      name: cleanText(input.name, 180) ?? cur?.name ?? `${metric} objective`,
      enabled: input.enabled ?? cur?.enabled ?? true,
      targetType,
      targetId: targetType === 'global' ? undefined : clean(input.targetId, 500) ?? cur?.targetId,
      metric,
      comparator,
      threshold: Number.isFinite(Number(input.threshold)) ? Number(input.threshold) : cur?.threshold ?? (metric === 'coverage_score' ? 90 : 0),
      severity: input.severity ? cleanSeverity(input.severity) : cur?.severity ?? 'high',
      owner: 'owner' in input ? cleanText(input.owner, 160) : cur?.owner,
      description: 'description' in input ? cleanText(input.description, 500) : cur?.description,
      createdAt: cur?.createdAt ?? at,
      updatedAt: at,
    };
    this.objectives.set(id, next);
    this.trim();
    this.persistSoon();
    return this.evaluateAndObserve(next, {});
  }

  has(objectiveId: string): boolean {
    return this.objectives.has(objectiveId);
  }

  list(query: ObjectiveQuery, options: { observe?: boolean } = {}): ObjectiveList {
    const q = query.q?.trim().toLowerCase();
    const pinnedObjectiveId = query.objectiveId?.trim();
    const targetId = query.targetId?.trim();
    const hasFilter = Boolean((query.status && query.status !== 'all') || (query.targetType && query.targetType !== 'all') || targetId || (query.metric && query.metric !== 'all') || q);
    const items = [...this.objectives.values()]
      .map((record) => (options.observe === false ? this.evaluate(record, query) : this.evaluateAndObserve(record, query)))
      .filter((item) => {
        const matchesObjectiveId = Boolean(pinnedObjectiveId && item.objectiveId === pinnedObjectiveId);
        const matchesFilter =
          (!query.status || query.status === 'all' || item.status === query.status) &&
          (!query.targetType || query.targetType === 'all' || item.targetType === query.targetType) &&
          (!targetId || item.targetId === targetId) &&
          (!query.metric || query.metric === 'all' || item.metric === query.metric) &&
          (!q || [item.name, item.targetType, item.targetId, item.metric, item.owner, item.description, item.evidence].some((value) => (value ?? '').toLowerCase().includes(q)));
        if (pinnedObjectiveId && !hasFilter) return matchesObjectiveId;
        return matchesObjectiveId || matchesFilter;
      })
      .sort((a, b) => {
        const statusRank: Record<ObjectiveStatus, number> = { breach: 0, ok: 1, disabled: 2 };
        return (
          Number(Boolean(pinnedObjectiveId) && b.objectiveId === pinnedObjectiveId) - Number(Boolean(pinnedObjectiveId) && a.objectiveId === pinnedObjectiveId) ||
          statusRank[a.status] - statusRank[b.status] ||
          SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
          b.updatedAt.localeCompare(a.updatedAt)
        );
      });
    const summary = {
      totalObjectives: items.length,
      enabledObjectives: items.filter((item) => item.enabled).length,
      okObjectives: items.filter((item) => item.status === 'ok').length,
      breachedObjectives: items.filter((item) => item.status === 'breach').length,
      disabledObjectives: items.filter((item) => item.status === 'disabled').length,
      highSeverityBreaches: items.filter((item) => item.status === 'breach' && (item.severity === 'high' || item.severity === 'critical')).length,
    };
    const limit = Math.max(1, Math.min(500, query.limit ?? 120));
    return { items: items.slice(0, limit), total: items.length, summary, updateTime: iso() };
  }

  private evaluate(record: ObjectiveRecord, query: Partial<ObjectiveQuery>): ObjectiveItem {
    if (!record.enabled) return this.item(record, 'disabled', 0, 'objective disabled');
    const filter = { timeType: query.timeType, startTime: query.startTime, endTime: query.endTime };
    const { value, evidence } = this.valueFor(record, filter);
    const ok = record.comparator === 'gte' ? value >= record.threshold : value <= record.threshold;
    return this.item(record, ok ? 'ok' : 'breach', value, evidence);
  }

  private evaluateAndObserve(record: ObjectiveRecord, query: Partial<ObjectiveQuery>): ObjectiveItem {
    const item = this.evaluate(record, query);
    this.alerting.observeObjective(item);
    return item;
  }

  private valueFor(record: ObjectiveRecord, filter: Pick<ObjectiveQuery, 'timeType' | 'startTime' | 'endTime'>): { value: number; evidence: string } {
    const target = record.targetId;
    const agentTarget = record.targetType === 'agent' ? splitAgentTargetId(target) : {};
    const workspaceTarget = record.targetType === 'workspace' ? target : agentTarget.workspacePath;
    const collectorTarget = record.targetType === 'collector' ? target : undefined;
    const sourceTarget = record.targetType === 'source' ? target : undefined;
    if (record.metric === 'coverage_score') {
      const coverage = this.agg.coverageOverview({
        ...filter,
        workspacePath: workspaceTarget,
        agentId: agentTarget.agentId,
        collectorId: collectorTarget,
        sourceId: sourceTarget,
        limit: 500,
      });
      if (record.targetType === 'global') return { value: coverage.summary.coverageScore, evidence: `${coverage.summary.issueCount} actionable issues` };
      const issues = coverage.issues.filter((issue) => this.matchesTarget(record, issue));
      const penalty = issues.filter((issue) => !issue.suppressedByMaintenance).reduce((score, issue) => score + (issue.severity === 'critical' ? 25 : issue.severity === 'high' ? 15 : issue.severity === 'medium' ? 7 : 3), 0);
      return { value: Math.max(1, 100 - penalty), evidence: `${issues.length} matching coverage issues` };
    }
    if (record.metric === 'open_incidents') {
      const collectorIncidentMatch = record.targetType === 'collector' ? this.collectorIncidentMatcher(target, filter) : undefined;
      const incidents = this.agg.incidents({
        ...filter,
        status: 'open',
        agentId: agentTarget.agentId,
        workspacePath: workspaceTarget,
        collectorId: collectorTarget,
        sourceId: sourceTarget,
        limit: 500,
      }).items
        .filter((incident) => {
          if (record.targetType === 'collector') return this.matchesTarget(record, incident) || (collectorIncidentMatch?.(incident) ?? false);
          return this.matchesTarget(record, incident);
        });
      return { value: incidents.length, evidence: `${incidents.length} open incidents` };
    }
    if (record.metric === 'active_alerts') {
      const alerts = this.alerting.list({
        ...filter,
        status: 'all',
        agentId: agentTarget.agentId,
        workspacePath: workspaceTarget,
        collectorId: collectorTarget,
        sourceId: sourceTarget,
        limit: 500,
      }).items
        .filter((alert) => countsTowardActiveAlertObjective(alert) && this.matchesTarget(record, alert));
      return { value: alerts.length, evidence: `${alerts.length} active alerts` };
    }
    if (record.metric === 'overdue_remediations') {
      const remediations = this.remediations.list({
        ...filter,
        status: 'all',
        workspacePath: workspaceTarget,
        agentId: agentTarget.agentId,
        collectorId: collectorTarget,
        sourceId: sourceTarget,
        limit: 500,
      });
      return { value: remediations.summary.overdueTasks, evidence: `${remediations.summary.overdueTasks} overdue remediations` };
    }
    if (record.metric === 'risky_events') {
      const events = this.agg.agentEvents({
        ...filter,
        agentId: agentTarget.agentId,
        workspacePath: workspaceTarget,
        collectorId: collectorTarget,
        sourceId: sourceTarget,
        limit: 500,
      }).items
        .filter((event) => event.verdict !== 'allow' && this.matchesTarget(record, event));
      return { value: events.length, evidence: `${events.length} risky events` };
    }
    if (record.metric === 'stale_agents') {
      const scopedAgentKeys = this.scopedAgentKeys(record, filter);
      const agents = this.agg.agentInventory({
        ...filter,
        workspacePath: workspaceTarget,
        agentId: agentTarget.agentId,
        limit: 500,
      }).items
        .filter((agent) =>
          agent.healthState === 'stale' &&
          (scopedAgentKeys ? scopedAgentKeys.has([agent.workspacePath, agent.agentId].join('\0')) : this.matchesTarget(record, agent)),
        );
      return { value: agents.length, evidence: `${agents.length} stale agents` };
    }
    const collectors = this.agg.collectorHealth({ ...filter, collectorId: collectorTarget, state: 'all', limit: 500 }).items
      .filter((collector) => collector.state === 'down' && this.matchesTarget(record, collector));
    if (record.metric === 'collector_down') return { value: collectors.length, evidence: `${collectors.length} down collectors` };

    const sources = this.sources.list({
      status: 'all',
      type: 'all',
      sourceId: sourceTarget,
      collectorId: collectorTarget,
      workspacePath: workspaceTarget,
      limit: 500,
    }).items
      .filter((source) => source.enabled && (source.status === 'stale' || source.status === 'unused' || source.lastResult === 'rejected') && this.matchesTarget(record, source));
    return { value: sources.length, evidence: `${sources.length} unhealthy sources` };
  }

  private matchesTarget(record: ObjectiveRecord, item: { workspacePath?: string; agentId?: string; collectorId?: string; sourceId?: string; nodeName?: string }): boolean {
    if (record.targetType === 'global') return true;
    if (record.targetType === 'workspace') return item.workspacePath === record.targetId;
    if (record.targetType === 'agent') {
      const target = splitAgentTargetId(record.targetId);
      return Boolean(target.agentId && item.agentId === target.agentId && (!target.workspacePath || item.workspacePath === target.workspacePath));
    }
    if (record.targetType === 'collector') return item.collectorId === record.targetId || item.nodeName === record.targetId;
    if (record.targetType === 'source') return item.sourceId === record.targetId;
    return true;
  }

  private collectorIncidentMatcher(
    collectorId: string | undefined,
    filter: Pick<ObjectiveQuery, 'timeType' | 'startTime' | 'endTime'>,
  ): (incident: { workspacePath?: string; agentId?: string; traceId?: string; runId?: string; lastEventId?: string }) => boolean {
    if (!collectorId) return () => false;
    const events = this.agg.agentEvents({ ...filter, collectorId, limit: 500 }).items.filter((event) => event.verdict !== 'allow');
    const eventIds = new Set(events.map((event) => event.eventId));
    const traces = new Set(events.map((event) => [event.workspacePath, event.agentId, event.traceId, event.runId].join('\0')));
    return (
      incident: { workspacePath?: string; agentId?: string; traceId?: string; runId?: string; lastEventId?: string },
    ): boolean =>
      Boolean(incident.lastEventId && eventIds.has(incident.lastEventId)) ||
      traces.has([incident.workspacePath, incident.agentId, incident.traceId, incident.runId].join('\0'));
  }

  private scopedAgentKeys(
    record: ObjectiveRecord,
    filter: Pick<ObjectiveQuery, 'timeType' | 'startTime' | 'endTime'>,
  ): Set<string> | undefined {
    if (record.targetType !== 'collector' && record.targetType !== 'source') return undefined;
    const events = this.agg.agentEvents({
      ...filter,
      collectorId: record.targetType === 'collector' ? record.targetId : undefined,
      sourceId: record.targetType === 'source' ? record.targetId : undefined,
      limit: 500,
    }).items;
    return new Set(events.map((event) => [event.workspacePath, event.agentId].join('\0')));
  }

  private item(record: ObjectiveRecord, status: ObjectiveStatus, currentValue: number, evidence: string): ObjectiveItem {
    return {
      ...record,
      createdAt: iso(record.createdAt),
      updatedAt: iso(record.updatedAt),
      status,
      currentValue,
      evaluatedAt: iso(),
      evidence,
    };
  }

  private normalize(record: ObjectiveRecord): ObjectiveRecord {
    const metric = cleanMetric(record.metric);
    return {
      objectiveId: clean(record.objectiveId, 160) ?? hashId([record.name, Date.now()]),
      name: cleanText(record.name, 180) ?? `${metric} objective`,
      enabled: record.enabled !== false,
      targetType: cleanTargetType(record.targetType),
      targetId: clean(record.targetId, 500),
      metric,
      comparator: cleanComparator(record.comparator),
      threshold: Number.isFinite(Number(record.threshold)) ? Number(record.threshold) : (metric === 'coverage_score' ? 90 : 0),
      severity: cleanSeverity(record.severity),
      owner: cleanText(record.owner, 160),
      description: cleanText(record.description, 500),
      createdAt: Number(record.createdAt) || Date.now(),
      updatedAt: Number(record.updatedAt) || Date.now(),
    };
  }

  private trim(): void {
    if (this.objectives.size <= RETAIN_LIMIT) return;
    const keep = [...this.objectives.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, RETAIN_LIMIT);
    this.objectives.clear();
    for (const record of keep) this.objectives.set(record.objectiveId, record);
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
    await this.ch.saveObjectives([...this.objectives.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, RETAIN_LIMIT));
  }
}
