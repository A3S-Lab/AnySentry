import { Injectable } from '@nestjs/common';
import { Sentry } from '@a3s-lab/sentry';
import { AgentMetadataService } from './agent-metadata.service';
import { IngestionSourceService } from './ingestion-source.service';
import { MaintenanceWindowService } from './maintenance-window.service';
import { buildAcl, policyConfigError, sanitizePolicy } from './policy-config';
import { SentryJudgeService } from './sentry-judge.service';
import * as T from './types';

const HOUR = 3_600_000;
const WINDOW: Record<string, number> = { last_3h: 3 * HOUR, last_1d: 24 * HOUR, last_7d: 7 * 24 * HOUR, last_30d: 30 * 24 * HOUR };

const SEV_RANK: Record<T.Severity, number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };
const LEVEL_BY_RANK = ['safe', 'low', 'medium', 'high', 'critical'];
const LEVEL_TEXT: Record<string, string> = { safe: '安全', low: '低危', medium: '中危', high: '高危', critical: '严重', unknown: '未知' };
const CATEGORY_COLOR: Record<string, string> = {
  command_danger: '#fb7185', data_leak: '#f59e0b', secret_exfil: '#f59e0b', prompt_injection: '#a855f7',
  communication_risk: '#38bdf8', systemic_risk: '#f43f5e', privilege_escalation: '#fb7185', other: '#94a3b8',
};
// The monitored risk taxonomy, grouped by risk type. Always listed on the dashboard (with 0 counts
// when nothing fired) so operators see WHAT is watched, not a blank panel. Names mirror `deriveRisk`.
const RISK_TAXONOMY: Record<T.RiskType, Array<{ code: string; name: string }>> = {
  system: [
    { code: 'systemic_risk', name: '云元数据 SSRF' },
    { code: 'privilege_escalation', name: '提权 / 进程注入' },
  ],
  communication: [
    { code: 'secret_exfil', name: '密钥外泄' },
    { code: 'prompt_injection', name: '提示词注入' },
    { code: 'communication_risk', name: '异常外联 / 回连' },
  ],
  atomic: [
    { code: 'command_danger', name: '危险命令执行' },
    { code: 'data_leak', name: '凭据文件访问' },
    { code: 'other', name: '其他风险' },
  ],
};

// The 6 radar dimensions of the highest-risk session.
const DIMENSIONS: Array<{ code: string; name: string; cats: string[] }> = [
  { code: 'command_danger', name: '命令危险', cats: ['command_danger'] },
  { code: 'prompt_injection', name: '提示注入', cats: ['prompt_injection'] },
  { code: 'data_leak', name: '数据泄露', cats: ['data_leak', 'secret_exfil'] },
  { code: 'jailbreak', name: '越狱绕过', cats: ['prompt_injection'] },
  { code: 'communication_risk', name: '通信风险', cats: ['communication_risk'] },
  { code: 'systemic_risk', name: '系统性风险', cats: ['systemic_risk', 'privilege_escalation'] },
];

const EVENT_CATEGORIES: T.EventCategory[] = ['tool', 'network', 'file', 'llm', 'security', 'process', 'runtime', 'unknown'];
const EVENT_SOURCES: T.EventSource[] = ['observer', 'synthetic', 'api'];
const ACTIVE_MS = 5 * 60_000;
const STALE_MS = 60 * 60_000;
const COLLECTOR_STALE_MS = 3 * 60_000;
const COLLECTOR_DOWN_MS = 10 * 60_000;

const now = () => Date.now();
const iso = (t = now()) => new Date(t).toISOString().slice(0, 19).replace('T', ' ');
const round1 = (n: number) => Math.round(n * 10) / 10;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const distinct = <V>(xs: V[]) => new Set(xs).size;
function mode(values: Array<string | undefined>): string | undefined {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
}
function worstCriticality(values: Array<T.AgentCriticality | undefined>): T.AgentCriticality | undefined {
  const rank: Record<T.AgentCriticality, number> = { low: 1, medium: 2, high: 3, critical: 4 };
  return values
    .filter((value): value is T.AgentCriticality => Boolean(value))
    .sort((a, b) => rank[b] - rank[a])[0];
}

function levelByRank(rank: number): { level: string; text: string } {
  const level = LEVEL_BY_RANK[Math.max(0, Math.min(4, rank))];
  return { level, text: LEVEL_TEXT[level] };
}
function worstLevel(events: T.JudgedEvent[]): { level: string; text: string } {
  const risky = events.filter((e) => e.verdict !== 'allow');
  if (!risky.length) return { level: 'safe', text: LEVEL_TEXT.safe };
  return levelByRank(Math.max(...risky.map((e) => SEV_RANK[e.severity])));
}
function fmtTokens(n: number): { total: number; unit: string } {
  if (n >= 1e9) return { total: round1(n / 1e9), unit: 'G' };
  if (n >= 1e6) return { total: round1(n / 1e6), unit: 'M' };
  if (n >= 1e3) return { total: round1(n / 1e3), unit: 'K' };
  return { total: n, unit: '' };
}

function eventCategory(kind: string): T.EventCategory {
  if (kind === 'ToolExec') return 'tool';
  if (kind === 'Egress' || kind === 'Dns' || kind === 'SslContent') return 'network';
  if (kind === 'FileAccess' || kind === 'FileDelete') return 'file';
  if (kind === 'LlmCall' || kind === 'LlmApi') return 'llm';
  if (kind === 'SecurityAction') return 'security';
  if (kind === 'ProcessExit') return 'process';
  return 'unknown';
}

function nodeId(type: T.TopologyNodeType, key: string): string {
  return `${type}:${key.slice(0, 240)}`;
}

function edgeId(sourceNodeId: string, targetNodeId: string, type: T.TopologyEdgeType): string {
  return `${type}:${sourceNodeId}->${targetNodeId}`;
}

function attrString(e: T.JudgedEvent, key: string): string {
  const value = e.attributes[key];
  return value == null ? '' : String(value).trim();
}

function eventCollectorId(e: T.JudgedEvent): string {
  return e.collectorId?.trim() || attrString(e, 'collectorId');
}

function eventSourceId(e: T.JudgedEvent): string {
  return e.sourceId?.trim() || attrString(e, 'sourceId');
}

function basename(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] || path;
}

function commandName(argv: string): string {
  const first = argv.trim().split(/\s+/)[0] ?? '';
  return first.includes('/') ? basename(first) : first;
}

function topologyTarget(e: T.JudgedEvent): { type: T.TopologyNodeType; key: string; label: string; subtitle?: string; edgeType: T.TopologyEdgeType; edgeLabel: string } | null {
  if (e.eventKind === 'ToolExec') {
    const argv = attrString(e, 'argv') || e.subject;
    const cmd = commandName(argv) || 'exec';
    return { type: 'tool', key: cmd, label: cmd, subtitle: argv.slice(0, 120), edgeType: 'executes', edgeLabel: '执行' };
  }
  if (e.eventKind === 'Egress') {
    const peer = attrString(e, 'peer') || e.subject.replace(/^egress\s*→\s*/i, '');
    const port = attrString(e, 'port');
    const label = port && !peer.includes(':') ? `${peer}:${port}` : peer;
    return { type: 'network', key: label || 'unknown-egress', label: label || 'unknown-egress', subtitle: 'egress', edgeType: 'connects', edgeLabel: '连接' };
  }
  if (e.eventKind === 'Dns') {
    const query = attrString(e, 'query') || e.subject.replace(/^dns\s*/i, '');
    return { type: 'network', key: query || 'unknown-dns', label: query || 'unknown-dns', subtitle: 'dns', edgeType: 'resolves', edgeLabel: '解析' };
  }
  if (e.eventKind === 'FileAccess' || e.eventKind === 'FileDelete') {
    const path = attrString(e, 'path') || e.actionTarget || e.subject.replace(/^file\s*/i, '');
    return { type: 'file', key: path || 'unknown-file', label: basename(path || 'unknown-file'), subtitle: path, edgeType: 'accesses', edgeLabel: e.eventKind === 'FileDelete' ? '删除' : '访问' };
  }
  if (e.eventKind === 'LlmCall' || e.eventKind === 'LlmApi') {
    const endpoint = attrString(e, 'sni') || attrString(e, 'peer') || attrString(e, 'query') || e.subject.replace(/^llm\s*/i, '');
    return { type: 'llm', key: endpoint || 'unknown-llm', label: endpoint || 'unknown-llm', subtitle: e.eventKind, edgeType: 'calls_llm', edgeLabel: '调用' };
  }
  if (e.eventKind === 'SecurityAction' || e.eventCategory === 'security') {
    const label = e.actionKind || e.riskName || e.subject;
    return { type: 'security', key: label || e.riskCategory, label: label || e.riskCategory, subtitle: e.reason, edgeType: 'triggers', edgeLabel: '触发' };
  }
  return null;
}

function compactIssueId(type: T.CoverageIssueType, ...parts: Array<string | number | undefined>): string {
  return `cov_${type}_${parts.join('_')}`.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 140);
}

type SimulatedDecision = { verdict: string; tier: string; severity: string; reason: string };

function normalizeSimulationDecision(decision: SimulatedDecision | null): T.PolicySimulationDecision {
  if (!decision) return { verdict: 'allow', tier: 'Rules', severity: 'info', reason: 'observed' };
  let verdict = decision.verdict as T.Verdict;
  if (verdict === 'allow' && decision.reason.includes('unresolved escalation')) verdict = 'escalate';
  return {
    verdict,
    tier: decision.tier as T.Tier,
    severity: decision.severity as T.Severity,
    reason: decision.reason,
  };
}

function simulationChange(current: T.PolicySimulationDecision, simulated: T.PolicySimulationDecision): T.PolicySimulationChangeType | null {
  if (current.verdict !== 'block' && simulated.verdict === 'block') return 'new_block';
  if (current.verdict === 'block' && simulated.verdict !== 'block') return 'removed_block';
  if (current.verdict === 'allow' && simulated.verdict === 'escalate') return 'new_escalation';
  if (current.verdict === 'escalate' && simulated.verdict === 'allow') return 'removed_escalation';
  if (SEV_RANK[simulated.severity] > SEV_RANK[current.severity]) return 'severity_increase';
  if (SEV_RANK[simulated.severity] < SEV_RANK[current.severity]) return 'severity_decrease';
  if (current.verdict !== simulated.verdict || current.tier !== simulated.tier) return 'verdict_changed';
  return null;
}

@Injectable()
export class AggregationService {
  constructor(
    private readonly judge: SentryJudgeService,
    private readonly agentMetadata: AgentMetadataService,
    private readonly maintenance: MaintenanceWindowService,
    private readonly sources: IngestionSourceService,
  ) {}

  // The dashboard polls 9 endpoints with the same filter near-simultaneously; cache the windowed
  // scan for a beat so they share one pass over the 100k ring instead of nine (keeps latency flat).
  private readonly winCache = new Map<string, { at: number; val: ReturnType<AggregationService['computeWin']> }>();

  invalidateWindowCache(): void {
    this.winCache.clear();
  }

  private win(filter: T.SecurityTimeFilter): { events: T.JudgedEvent[]; sinceMs: number; spanMs: number; dataSinceMs: number; dataSpanMs: number } {
    const key = `${filter.timeType ?? 'last_3h'}|${filter.startTime ?? ''}`;
    const cached = this.winCache.get(key);
    const t = now();
    if (cached && t - cached.at < 1500) return cached.val;
    const val = this.computeWin(filter);
    this.winCache.set(key, { at: t, val });
    return val;
  }

  private computeWin(filter: T.SecurityTimeFilter): { events: T.JudgedEvent[]; sinceMs: number; spanMs: number; dataSinceMs: number; dataSpanMs: number } {
    const end = now();
    let sinceMs: number;
    if (filter.timeType === 'custom' && filter.startTime) sinceMs = Date.parse(filter.startTime) || end - 3 * HOUR;
    else sinceMs = end - (WINDOW[filter.timeType ?? 'last_3h'] ?? 3 * HOUR);
    const events = this.judge.query(sinceMs);
    // The in-memory ring may hold less time than the nominal window. Time-series/rate panels must
    // bucket over the data that actually exists, or everything piles into one bucket (req=100000).
    const dataSinceMs = events.length ? events[0].at : sinceMs;
    return { events, sinceMs, spanMs: end - sinceMs, dataSinceMs, dataSpanMs: Math.max(1, end - dataSinceMs) };
  }

  // bucketed counts over the window (for time-series + rate panels)
  private buckets(events: T.JudgedEvent[], sinceMs: number, spanMs: number, n: number): T.JudgedEvent[][] {
    const size = spanMs / n || 1;
    const out: T.JudgedEvent[][] = Array.from({ length: n }, () => []);
    for (const e of events) {
      const i = Math.min(n - 1, Math.max(0, Math.floor((e.at - sinceMs) / size)));
      out[i].push(e);
    }
    return out;
  }

  healthCard(filter: T.SecurityTimeFilter): T.SecurityHealthCard {
    const { events } = this.win(filter);
    const total = events.length || 1;
    const blocked = events.filter((e) => e.verdict === 'block').length;
    const escalated = events.filter((e) => e.verdict === 'escalate').length;
    const score = Math.max(1, Math.min(100, Math.round(100 - (blocked / total) * 60 - (escalated / total) * 25)));
    const text = score >= 90 ? '健康' : score >= 75 ? '良好' : score >= 60 ? '注意' : score >= 40 ? '风险偏高' : '高危';
    const tok = fmtTokens(events.reduce((a, e) => a + e.tokenCount, 0));
    return { healthScore: score, healthStatusText: text, tokenConsumptionTotal: tok.total, tokenConsumptionUnit: tok.unit };
  }

  explainabilityScan(filter: T.ExplainabilityScanRequest): T.SecurityExplainabilityScan {
    const { events, dataSinceMs, dataSpanMs } = this.win(filter);
    const n = Math.max(8, Math.min(72, filter.seriesPoints ?? 24));
    const size = dataSpanMs / n || 1;
    const buckets = this.buckets(events, dataSinceMs, dataSpanMs, n);
    const safeSeries: T.WaveSeriesPoint[] = [];
    const riskSeries: T.WaveSeriesPoint[] = [];
    buckets.forEach((b, i) => {
      const statTime = iso(dataSinceMs + i * size).slice(11, 16);
      const avgRisk = mean(b.map((e) => e.riskScore));
      riskSeries.push({ statTime, value: Math.round(avgRisk), activationCount: b.filter((e) => e.verdict !== 'allow').length });
      safeSeries.push({ statTime, value: Math.round(100 - avgRisk), activationCount: b.length });
    });
    const blocked = events.filter((e) => e.verdict === 'block').length;
    const recent = events.filter((e) => e.at >= now() - 5 * 60_000);
    return {
      waveSeries: [{ safeSeries, riskSeries }],
      threatInterception: `${round1((blocked / (events.length || 1)) * 100)}%`,
      sessionActiveCount: String(distinct(recent.map((e) => e.sessionId))),
      updateTime: iso(),
    };
  }

  private eventItem(e: T.JudgedEvent): T.AgentEventListItem {
    return {
      schemaVersion: e.schemaVersion,
      eventId: e.eventId,
      at: iso(e.at),
      eventKind: e.eventKind,
      eventCategory: e.eventCategory,
      source: e.source,
      subject: e.subject,
      workspacePath: e.workspacePath,
      agentId: e.agentId,
      collectorId: eventCollectorId(e) || undefined,
      sourceId: eventSourceId(e) || undefined,
      sessionId: e.sessionId,
      userId: e.userId,
      traceId: e.traceId,
      spanId: e.spanId,
      parentSpanId: e.parentSpanId,
      runId: e.runId,
      taskId: e.taskId,
      verdict: e.verdict,
      tier: e.tier,
      severity: e.severity,
      reason: e.reason,
      riskCategory: e.riskCategory,
      riskName: e.riskName,
      riskType: e.riskType,
      riskScore: e.riskScore,
      tokenCount: e.tokenCount,
      latencyMs: e.latencyMs,
      attributes: e.attributes,
      rawPreview: e.rawPreview,
    };
  }

  private filterEvents(events: T.JudgedEvent[], filter: T.AgentEventQuery): T.JudgedEvent[] {
    const pinnedEventId = filter.eventId?.trim();
    const sourceId = filter.sourceId?.trim();
    const collectorId = filter.collectorId?.trim();
    const agentId = filter.agentId?.trim();
    const sessionId = filter.sessionId?.trim();
    const workspacePath = filter.workspacePath?.trim();
    const traceId = filter.traceId?.trim();
    const runId = filter.runId?.trim();
    const hasFilter = Boolean(sourceId || collectorId || agentId || sessionId || workspacePath || traceId || runId || filter.eventKind || filter.eventCategory || filter.verdict);
    return events.filter((e) => {
      const matchesEventId = Boolean(pinnedEventId && e.eventId === pinnedEventId);
      const eventSource = eventSourceId(e);
      const eventCollector = eventCollectorId(e);
      const matchesFilter =
        (!sourceId || eventSource === sourceId) &&
        (!collectorId || eventCollector === collectorId) &&
        (!agentId || e.agentId === agentId) &&
        (!sessionId || e.sessionId === sessionId) &&
        (!workspacePath || e.workspacePath === workspacePath) &&
        (!traceId || e.traceId === traceId) &&
        (!runId || e.runId === runId) &&
        (!filter.eventKind || e.eventKind === filter.eventKind) &&
        (!filter.eventCategory || e.eventCategory === filter.eventCategory) &&
        (!filter.verdict || e.verdict === filter.verdict);
      if (pinnedEventId && !hasFilter) return matchesEventId;
      return matchesEventId || matchesFilter;
    });
  }

  agentEvents(filter: T.AgentEventQuery): T.AgentEventList {
    const pinnedEventId = filter.eventId?.trim();
    const events = pinnedEventId ? this.judge.query(0) : this.win(filter).events;
    const limit = Math.max(1, Math.min(200, filter.limit ?? 40));
    const filtered = this.filterEvents(events, filter).sort((a, b) =>
      Number(Boolean(pinnedEventId) && b.eventId === pinnedEventId) - Number(Boolean(pinnedEventId) && a.eventId === pinnedEventId) ||
      b.at - a.at,
    );
    return {
      items: filtered.slice(0, limit).map((e) => this.eventItem(e)),
      total: filtered.length,
      updateTime: iso(),
    };
  }

  agentTimeline(filter: T.AgentEventQuery): T.AgentTimeline {
    const pinnedEventId = filter.eventId?.trim();
    const events = pinnedEventId ? this.judge.query(0) : this.win(filter).events;
    const limit = Math.max(1, Math.min(500, filter.limit ?? 120));
    const pinned = pinnedEventId ? events.find((event) => event.eventId === pinnedEventId) : undefined;
    const effectiveFilter = pinned && !filter.traceId ? { ...filter, eventId: undefined, traceId: pinned.traceId } : filter;
    const filtered = this.filterEvents(events, effectiveFilter).sort((a, b) => a.at - b.at).slice(-limit);
    const head = filtered[0];
    return {
      traceId: filter.traceId ?? pinned?.traceId ?? head?.traceId ?? '',
      runId: filter.runId ?? head?.runId,
      sessionId: filter.sessionId ?? head?.sessionId,
      items: filtered.map((e) => this.eventItem(e)),
      updateTime: iso(),
    };
  }

  private incidentItem(i: T.Incident): T.IncidentListItem {
    return {
      ...i,
      openedAt: iso(i.openedAt),
      updatedAt: iso(i.updatedAt),
      acknowledgedAt: i.acknowledgedAt ? iso(i.acknowledgedAt) : undefined,
      resolvedAt: i.resolvedAt ? iso(i.resolvedAt) : undefined,
    };
  }

  incidents(filter: T.IncidentQuery): T.IncidentList {
    const { sinceMs } = this.win(filter);
    const limit = Math.max(1, Math.min(200, filter.limit ?? 60));
    const pinnedIncidentId = filter.incidentId?.trim();
    const workspacePath = filter.workspacePath?.trim();
    const agentId = filter.agentId?.trim();
    const collectorId = filter.collectorId?.trim();
    const sourceId = filter.sourceId?.trim();
    const sessionId = filter.sessionId?.trim();
    const traceId = filter.traceId?.trim();
    const hasFilter = Boolean(
      (filter.status && filter.status !== 'all') ||
      (filter.severity && filter.severity !== 'all') ||
      workspacePath ||
      agentId ||
      collectorId ||
      sourceId ||
      sessionId ||
      traceId,
    );
    const all = this.judge.listIncidents(pinnedIncidentId ? 0 : sinceMs);
    const filtered = all
      .filter((i) => {
        const matchesIncidentId = Boolean(pinnedIncidentId && i.incidentId === pinnedIncidentId);
        const matchesFilter =
          i.updatedAt >= sinceMs &&
          (!filter.status || filter.status === 'all' || i.status === filter.status) &&
          (!filter.severity || filter.severity === 'all' || i.severity === filter.severity) &&
          (!workspacePath || i.workspacePath === workspacePath) &&
          (!agentId || i.agentId === agentId) &&
          (!collectorId || i.collectorId === collectorId) &&
          (!sourceId || i.sourceId === sourceId) &&
          (!sessionId || i.sessionId === sessionId) &&
          (!traceId || i.traceId === traceId);
        if (pinnedIncidentId && !hasFilter) return matchesIncidentId;
        return matchesIncidentId || matchesFilter;
      })
      .sort((a, b) =>
        Number(Boolean(pinnedIncidentId) && b.incidentId === pinnedIncidentId) - Number(Boolean(pinnedIncidentId) && a.incidentId === pinnedIncidentId) ||
        b.updatedAt - a.updatedAt,
      );
    const summary: Record<T.IncidentStatus, number> = { open: 0, acknowledged: 0, resolved: 0 };
    for (const i of all) summary[i.status]++;
    return {
      items: filtered.slice(0, limit).map((i) => this.incidentItem(i)),
      total: filtered.length,
      summary,
      updateTime: iso(),
    };
  }

  updateIncident(incidentId: string, body: T.IncidentUpdateRequest): T.IncidentListItem | null {
    const incident = this.judge.updateIncident(incidentId, body);
    return incident ? this.incidentItem(incident) : null;
  }

  agentInventory(filter: T.AgentInventoryQuery): T.AgentInventory {
    const { events } = this.win(filter);
    const q = filter.q?.trim().toLowerCase();
    const owner = filter.owner?.trim().toLowerCase();
    const environment = filter.environment?.trim().toLowerCase();
    const tag = filter.tag?.trim().toLowerCase();
    const agentId = filter.agentId?.trim();
    const workspacePath = filter.workspacePath?.trim();
    const hasFilter = Boolean((filter.healthState && filter.healthState !== 'all') || (filter.criticality && filter.criticality !== 'all') || owner || environment || tag || q || filter.userId);
    const shouldScopeExactAgent = Boolean(agentId && !hasFilter);
    const byAgent = new Map<string, T.JudgedEvent[]>();
    for (const e of events) {
      if (shouldScopeExactAgent && e.agentId !== agentId) continue;
      if (workspacePath && e.workspacePath !== workspacePath) continue;
      if (!agentId && filter.userId && e.userId !== filter.userId) continue;
      const key = `${e.workspacePath}\0${e.agentId}`;
      (byAgent.get(key) ?? byAgent.set(key, []).get(key)!).push(e);
    }

    const openIncidents = new Map<string, number>();
    for (const incident of this.judge.listIncidents(0)) {
      if (incident.status !== 'open') continue;
      const key = `${incident.workspacePath}\0${incident.agentId}`;
      openIncidents.set(key, (openIncidents.get(key) ?? 0) + 1);
    }

    const t = now();
    const eventBackedItems = [...byAgent.entries()].map(([key, evs]): T.AgentInventoryItem => {
      const sorted = [...evs].sort((a, b) => a.at - b.at);
      const first = sorted[0];
      const last = sorted[sorted.length - 1];
      const risky = sorted.filter((e) => e.verdict !== 'allow');
      const lvl = worstLevel(sorted);
      const [workspacePath, agentId] = key.split('\0');
      const metadata = this.agentMetadata.get(workspacePath, agentId);
      const openIncidentCount = openIncidents.get(key) ?? 0;
      const sinceLast = t - last.at;
      const healthState: T.AgentHealthState = openIncidentCount > 0
        ? 'risky'
        : sinceLast <= ACTIVE_MS
          ? 'active'
          : sinceLast <= STALE_MS
            ? 'idle'
            : 'stale';
      const categoryCounts = Object.fromEntries(EVENT_CATEGORIES.map((category) => [category, 0])) as Record<T.EventCategory, number>;
      const sourceCounts = Object.fromEntries(EVENT_SOURCES.map((source) => [source, 0])) as Record<T.EventSource, number>;
      const topRisk = new Map<string, { count: number; name: string }>();
      for (const e of sorted) {
        categoryCounts[e.eventCategory] = (categoryCounts[e.eventCategory] ?? 0) + 1;
        sourceCounts[e.source] = (sourceCounts[e.source] ?? 0) + 1;
        if (e.verdict !== 'allow') {
          const cur = topRisk.get(e.riskCategory);
          topRisk.set(e.riskCategory, { count: (cur?.count ?? 0) + 1, name: e.riskName });
        }
      }
      const top = [...topRisk.entries()].sort((a, b) => b[1].count - a[1].count)[0];
      return {
        agentId,
        workspacePath,
        userId: last.userId,
        displayName: metadata?.displayName,
        owner: metadata?.owner,
        team: metadata?.team,
        environment: metadata?.environment,
        criticality: metadata?.criticality,
        tags: metadata?.tags ?? [],
        note: metadata?.note,
        metadataUpdatedAt: metadata?.updatedAt ? iso(metadata.updatedAt) : undefined,
        firstSeen: iso(first.at),
        lastSeen: iso(last.at),
        healthState,
        riskLevel: lvl.level,
        riskLevelText: lvl.text,
        eventCount: sorted.length,
        riskyEventCount: risky.length,
        openIncidentCount,
        sessionCount: distinct(sorted.map((e) => e.sessionId)),
        runCount: distinct(sorted.map((e) => e.runId)),
        traceCount: distinct(sorted.map((e) => e.traceId)),
        tokenCount: sorted.reduce((a, e) => a + e.tokenCount, 0),
        avgLatencyMs: Math.round(mean(sorted.map((e) => e.latencyMs))),
        topRiskCategory: top?.[0],
        topRiskName: top?.[1].name,
        lastEventSubject: last.subject,
        eventCategoryCounts: categoryCounts,
        sourceCounts,
      };
    });

    const metadataOnlyItems = this.agentMetadata.list()
      .filter((metadata) =>
        !byAgent.has(`${metadata.workspacePath}\0${metadata.agentId}`) &&
        (!shouldScopeExactAgent || metadata.agentId === agentId) &&
        (!workspacePath || metadata.workspacePath === workspacePath) &&
        !filter.userId
      )
      .map((metadata): T.AgentInventoryItem => {
        const categoryCounts = Object.fromEntries(EVENT_CATEGORIES.map((category) => [category, 0])) as Record<T.EventCategory, number>;
        const sourceCounts = Object.fromEntries(EVENT_SOURCES.map((source) => [source, 0])) as Record<T.EventSource, number>;
        return {
          agentId: metadata.agentId,
          workspacePath: metadata.workspacePath,
          userId: '-',
          displayName: metadata.displayName,
          owner: metadata.owner,
          team: metadata.team,
          environment: metadata.environment,
          criticality: metadata.criticality,
          tags: metadata.tags,
          note: metadata.note,
          metadataUpdatedAt: metadata.updatedAt,
          firstSeen: metadata.updatedAt,
          lastSeen: metadata.updatedAt,
          healthState: 'stale',
          riskLevel: 'safe',
          riskLevelText: LEVEL_TEXT.safe,
          eventCount: 0,
          riskyEventCount: 0,
          openIncidentCount: 0,
          sessionCount: 0,
          runCount: 0,
          traceCount: 0,
          tokenCount: 0,
          avgLatencyMs: 0,
          lastEventSubject: 'metadata-only asset',
          eventCategoryCounts: categoryCounts,
          sourceCounts,
        };
      });

    const items = [...eventBackedItems, ...metadataOnlyItems];

    const filtered = items
      .filter((item) => {
        const matchesAgentId = Boolean(agentId && item.agentId === agentId && (!workspacePath || item.workspacePath === workspacePath));
        const matchesFilter =
          (!filter.healthState || filter.healthState === 'all' || item.healthState === filter.healthState) &&
          (!filter.criticality || filter.criticality === 'all' || item.criticality === filter.criticality) &&
          (!owner || (item.owner ?? '').toLowerCase().includes(owner)) &&
          (!environment || (item.environment ?? '').toLowerCase().includes(environment)) &&
          (!tag || item.tags.some((value) => value.toLowerCase().includes(tag))) &&
          (!q || [
            item.agentId,
            item.displayName,
            item.workspacePath,
            item.userId,
            item.owner,
            item.team,
            item.environment,
            item.criticality,
            item.note,
            item.topRiskName,
            item.lastEventSubject,
            ...item.tags,
          ].some((v) => (v ?? '').toLowerCase().includes(q)));
        if (agentId && !hasFilter) return matchesAgentId;
        return matchesAgentId || matchesFilter;
      })
      .sort((a, b) => {
        const rank: Record<T.AgentHealthState, number> = { risky: 0, active: 1, idle: 2, stale: 3 };
        return Number(Boolean(agentId) && b.agentId === agentId && (!workspacePath || b.workspacePath === workspacePath)) - Number(Boolean(agentId) && a.agentId === agentId && (!workspacePath || a.workspacePath === workspacePath))
          || rank[a.healthState] - rank[b.healthState]
          || b.openIncidentCount - a.openIncidentCount
          || b.riskyEventCount - a.riskyEventCount
          || Date.parse(b.lastSeen) - Date.parse(a.lastSeen);
      });

    const summary: T.AgentInventorySummary = {
      totalAgents: filtered.length,
      managedAgents: filtered.filter((item) => item.metadataUpdatedAt).length,
      productionAgents: filtered.filter((item) => item.environment?.toLowerCase() === 'prod' || item.environment?.toLowerCase() === 'production').length,
      highCriticalityAgents: filtered.filter((item) => item.criticality === 'high' || item.criticality === 'critical').length,
      activeAgents: filtered.filter((item) => item.healthState === 'active').length,
      idleAgents: filtered.filter((item) => item.healthState === 'idle').length,
      staleAgents: filtered.filter((item) => item.healthState === 'stale').length,
      riskyAgents: filtered.filter((item) => item.healthState === 'risky').length,
      openIncidentAgents: filtered.filter((item) => item.openIncidentCount > 0).length,
      observedEventCount: filtered.reduce((a, item) => a + item.eventCount, 0),
      riskyEventCount: filtered.reduce((a, item) => a + item.riskyEventCount, 0),
    };
    const limit = Math.max(1, Math.min(500, filter.limit ?? 120));
    return { items: filtered.slice(0, limit), total: filtered.length, summary, updateTime: iso() };
  }

  workspaceInventory(filter: T.WorkspaceInventoryQuery): T.WorkspaceInventory {
    const { events } = this.win(filter);
    const q = filter.q?.trim().toLowerCase();
    const owner = filter.owner?.trim().toLowerCase();
    const environment = filter.environment?.trim().toLowerCase();
    const workspacePath = filter.workspacePath?.trim();
    const hasFilter = Boolean((filter.healthState && filter.healthState !== 'all') || (filter.criticality && filter.criticality !== 'all') || owner || environment || q);
    const shouldScopeExactWorkspace = Boolean(workspacePath && !hasFilter);
    const agents = this.agentInventory({ timeType: filter.timeType, startTime: filter.startTime, endTime: filter.endTime, workspacePath: shouldScopeExactWorkspace ? workspacePath : undefined, limit: 500 });
    const byWorkspaceEvents = new Map<string, T.JudgedEvent[]>();
    for (const e of events) {
      if (shouldScopeExactWorkspace && e.workspacePath !== workspacePath) continue;
      (byWorkspaceEvents.get(e.workspacePath) ?? byWorkspaceEvents.set(e.workspacePath, []).get(e.workspacePath)!).push(e);
    }
    const byWorkspaceAgents = new Map<string, T.AgentInventoryItem[]>();
    for (const agent of agents.items) {
      if (shouldScopeExactWorkspace && agent.workspacePath !== workspacePath) continue;
      (byWorkspaceAgents.get(agent.workspacePath) ?? byWorkspaceAgents.set(agent.workspacePath, []).get(agent.workspacePath)!).push(agent);
    }

    const workspaceKeys = new Set([...byWorkspaceEvents.keys(), ...byWorkspaceAgents.keys()]);
    const items = [...workspaceKeys].map((workspacePath): T.WorkspaceInventoryItem | null => {
      const evs = [...(byWorkspaceEvents.get(workspacePath) ?? [])].sort((a, b) => a.at - b.at);
      const wsAgents = byWorkspaceAgents.get(workspacePath) ?? [];
      if (!evs.length && !wsAgents.length) return null;
      const firstMs = evs[0]?.at ?? Math.min(...wsAgents.map((agent) => Date.parse(agent.firstSeen)).filter(Number.isFinite));
      const lastMs = evs.at(-1)?.at ?? Math.max(...wsAgents.map((agent) => Date.parse(agent.lastSeen)).filter(Number.isFinite));
      const risky = evs.filter((event) => event.verdict !== 'allow');
      const topRisk = new Map<string, { count: number; name: string }>();
      for (const e of risky) {
        const cur = topRisk.get(e.riskCategory);
        topRisk.set(e.riskCategory, { count: (cur?.count ?? 0) + 1, name: e.riskName });
      }
      const top = [...topRisk.entries()].sort((a, b) => b[1].count - a[1].count)[0];
      const lvl = evs.length ? worstLevel(evs) : { level: 'safe', text: LEVEL_TEXT.safe };
      const collectorIds = new Set(evs.map(eventCollectorId).filter(Boolean));
      const maintenance = this.maintenance.activeFor({ workspacePath });
      const tags = [...new Set(wsAgents.flatMap((agent) => agent.tags ?? []))].slice(0, 24);
      const healthState: T.AgentHealthState = wsAgents.some((agent) => agent.healthState === 'risky')
        ? 'risky'
        : wsAgents.some((agent) => agent.healthState === 'active')
          ? 'active'
          : wsAgents.some((agent) => agent.healthState === 'idle')
            ? 'idle'
            : 'stale';
      const byLastSeen = [...wsAgents].sort((a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen));
      return {
        workspacePath,
        owner: mode(wsAgents.map((agent) => agent.owner)),
        team: mode(wsAgents.map((agent) => agent.team)),
        environment: mode(wsAgents.map((agent) => agent.environment)),
        criticality: worstCriticality(wsAgents.map((agent) => agent.criticality)),
        tags,
        healthState,
        riskLevel: lvl.level,
        riskLevelText: lvl.text,
        agentCount: wsAgents.length,
        managedAgentCount: wsAgents.filter((agent) => agent.metadataUpdatedAt).length,
        activeAgentCount: wsAgents.filter((agent) => agent.healthState === 'active').length,
        idleAgentCount: wsAgents.filter((agent) => agent.healthState === 'idle').length,
        staleAgentCount: wsAgents.filter((agent) => agent.healthState === 'stale').length,
        riskyAgentCount: wsAgents.filter((agent) => agent.healthState === 'risky').length,
        openIncidentCount: wsAgents.reduce((a, agent) => a + agent.openIncidentCount, 0),
        collectorCount: collectorIds.size,
        eventCount: evs.length || wsAgents.reduce((a, agent) => a + agent.eventCount, 0),
        riskyEventCount: risky.length || wsAgents.reduce((a, agent) => a + agent.riskyEventCount, 0),
        sessionCount: evs.length ? distinct(evs.map((event) => event.sessionId)) : wsAgents.reduce((a, agent) => a + agent.sessionCount, 0),
        runCount: evs.length ? distinct(evs.map((event) => event.runId)) : wsAgents.reduce((a, agent) => a + agent.runCount, 0),
        traceCount: evs.length ? distinct(evs.map((event) => event.traceId)) : wsAgents.reduce((a, agent) => a + agent.traceCount, 0),
        tokenCount: evs.reduce((a, event) => a + event.tokenCount, 0) || wsAgents.reduce((a, agent) => a + agent.tokenCount, 0),
        avgLatencyMs: Math.round(mean(evs.length ? evs.map((event) => event.latencyMs) : wsAgents.map((agent) => agent.avgLatencyMs))),
        topRiskCategory: top?.[0] ?? mode(wsAgents.map((agent) => agent.topRiskCategory)),
        topRiskName: top?.[1].name ?? mode(wsAgents.map((agent) => agent.topRiskName)),
        firstSeen: iso(Number.isFinite(firstMs) ? firstMs : now()),
        lastSeen: iso(Number.isFinite(lastMs) ? lastMs : now()),
        lastEventSubject: evs.at(-1)?.subject ?? byLastSeen[0]?.lastEventSubject ?? '',
        maintenanceActive: Boolean(maintenance),
        maintenanceWindowId: maintenance?.windowId,
        maintenanceTitle: maintenance?.title,
      };
    }).filter((item): item is T.WorkspaceInventoryItem => Boolean(item));

    const filtered = items
      .filter((item) => {
        const matchesWorkspacePath = Boolean(workspacePath && item.workspacePath === workspacePath);
        const matchesFilter =
          (!filter.healthState || filter.healthState === 'all' || item.healthState === filter.healthState) &&
          (!filter.criticality || filter.criticality === 'all' || item.criticality === filter.criticality) &&
          (!owner || (item.owner ?? '').toLowerCase().includes(owner)) &&
          (!environment || (item.environment ?? '').toLowerCase().includes(environment)) &&
          (!q || [
            item.workspacePath,
            item.owner,
            item.team,
            item.environment,
            item.criticality,
            item.topRiskName,
            item.topRiskCategory,
            item.lastEventSubject,
            item.maintenanceTitle,
            ...item.tags,
          ].some((value) => (value ?? '').toLowerCase().includes(q)));
        if (workspacePath && !hasFilter) return matchesWorkspacePath;
        return matchesWorkspacePath || matchesFilter;
      })
      .sort((a, b) => {
        const rank: Record<T.AgentHealthState, number> = { risky: 0, active: 1, idle: 2, stale: 3 };
        return Number(Boolean(workspacePath) && b.workspacePath === workspacePath) - Number(Boolean(workspacePath) && a.workspacePath === workspacePath)
          || Number(b.maintenanceActive) - Number(a.maintenanceActive)
          || rank[a.healthState] - rank[b.healthState]
          || b.openIncidentCount - a.openIncidentCount
          || b.riskyEventCount - a.riskyEventCount
          || Date.parse(b.lastSeen) - Date.parse(a.lastSeen);
      });

    const summary: T.WorkspaceInventorySummary = {
      totalWorkspaces: filtered.length,
      managedWorkspaces: filtered.filter((item) => item.managedAgentCount > 0).length,
      productionWorkspaces: filtered.filter((item) => item.environment?.toLowerCase() === 'prod' || item.environment?.toLowerCase() === 'production').length,
      highCriticalityWorkspaces: filtered.filter((item) => item.criticality === 'high' || item.criticality === 'critical').length,
      activeWorkspaces: filtered.filter((item) => item.healthState === 'active').length,
      staleWorkspaces: filtered.filter((item) => item.healthState === 'stale').length,
      riskyWorkspaces: filtered.filter((item) => item.healthState === 'risky').length,
      maintainedWorkspaces: filtered.filter((item) => item.maintenanceActive).length,
      totalAgents: filtered.reduce((a, item) => a + item.agentCount, 0),
      openIncidentCount: filtered.reduce((a, item) => a + item.openIncidentCount, 0),
      observedEventCount: filtered.reduce((a, item) => a + item.eventCount, 0),
      riskyEventCount: filtered.reduce((a, item) => a + item.riskyEventCount, 0),
    };
    const limit = Math.max(1, Math.min(500, filter.limit ?? 120));
    return { items: filtered.slice(0, limit), total: filtered.length, summary, updateTime: iso() };
  }

  agentTopology(filter: T.AgentTopologyQuery): T.AgentTopology {
    const pinnedEdgeId = filter.edgeId?.trim();
    const pinnedEventId = filter.eventId?.trim();
    const windowedEvents = this.win(filter).events;
    const windowedEventIds = new Set(windowedEvents.map((event) => event.eventId));
    const events = pinnedEdgeId || pinnedEventId ? this.judge.query(0) : windowedEvents;
    const includeBenign = filter.includeBenign !== false;
    const q = filter.q?.trim().toLowerCase();
    const agentId = filter.agentId?.trim();
    const workspacePath = filter.workspacePath?.trim();
    const collectorId = filter.collectorId?.trim();
    const sourceId = filter.sourceId?.trim();
    const hasFilter = Boolean(agentId || workspacePath || collectorId || sourceId || q || !includeBenign);
    const exactPinnedMode = Boolean((pinnedEdgeId || pinnedEventId) && !hasFilter);
    const limit = Math.max(20, Math.min(1000, filter.limit ?? 300));
    const pinnedEdgeIds = new Set<string>(pinnedEdgeId ? [pinnedEdgeId] : []);

    type NodeSpec = {
      id: string;
      type: T.TopologyNodeType;
      label: string;
      subtitle?: string;
      extra?: Partial<Pick<T.AgentTopologyNode, 'agentId' | 'workspacePath' | 'collectorId'>>;
    };
    type EdgeSpec = {
      id: string;
      source: NodeSpec;
      target: NodeSpec;
      type: T.TopologyEdgeType;
      label: string;
    };
    type NodeAgg = Omit<T.AgentTopologyNode, 'lastSeen' | 'riskLevel' | 'riskLevelText'> & { lastSeenMs: number; severityRank: number };
    type EdgeAgg = Omit<T.AgentTopologyEdge, 'lastSeen' | 'riskCategories'> & {
      lastSeenMs: number;
      severityRank: number;
      risks: Map<string, { riskName: string; eventCount: number }>;
    };

    const nodes = new Map<string, NodeAgg>();
    const edges = new Map<string, EdgeAgg>();
    const bumpNode = (
      id: string,
      type: T.TopologyNodeType,
      label: string,
      subtitle: string | undefined,
      event: T.JudgedEvent,
      extra: Partial<Pick<T.AgentTopologyNode, 'agentId' | 'workspacePath' | 'collectorId'>> = {},
    ) => {
      const risky = event.verdict !== 'allow';
      const cur = nodes.get(id);
      const base = cur ?? {
        nodeId: id,
        type,
        label,
        subtitle,
        eventCount: 0,
        riskyEventCount: 0,
        lastSeenMs: 0,
        severityRank: 0,
        ...extra,
      };
      base.eventCount += 1;
      if (risky) {
        base.riskyEventCount += 1;
        base.severityRank = Math.max(base.severityRank, SEV_RANK[event.severity]);
      }
      base.lastSeenMs = Math.max(base.lastSeenMs, event.at);
      nodes.set(id, base);
    };
    const bumpEdge = (
      sourceNodeId: string,
      targetNodeId: string,
      type: T.TopologyEdgeType,
      label: string,
      event: T.JudgedEvent,
    ) => {
      const id = edgeId(sourceNodeId, targetNodeId, type);
      const cur = edges.get(id);
      const risky = event.verdict !== 'allow';
      const rank = risky ? SEV_RANK[event.severity] : 0;
      const base: EdgeAgg = cur ?? {
        edgeId: id,
        sourceNodeId,
        targetNodeId,
        type,
        label,
        eventCount: 0,
        riskyEventCount: 0,
        maxSeverity: 'info',
        lastSeenMs: 0,
        severityRank: 0,
        sampleEventId: event.eventId,
        sampleSubject: event.subject,
        risks: new Map(),
      };
      base.eventCount += 1;
      if (risky) {
        base.riskyEventCount += 1;
        if (rank >= base.severityRank) {
          base.severityRank = rank;
          base.maxSeverity = event.severity;
        }
        const risk = base.risks.get(event.riskCategory);
        base.risks.set(event.riskCategory, { riskName: event.riskName, eventCount: (risk?.eventCount ?? 0) + 1 });
      }
      if (event.at >= base.lastSeenMs) {
        base.lastSeenMs = event.at;
        base.sampleEventId = event.eventId;
        base.sampleSubject = event.subject;
      }
      edges.set(id, base);
    };

    for (const e of events) {
      const target = topologyTarget(e);
      const agentNodeId = nodeId('agent', `${e.workspacePath}|${e.agentId}`);
      const workspaceNodeId = nodeId('workspace', e.workspacePath);
      const collectorRef = eventCollectorId(e);
      const sourceRef = eventSourceId(e);
      const collectorNodeId = collectorRef ? nodeId('collector', collectorRef) : '';
      const targetNodeId = target ? nodeId(target.type, target.key) : '';
      const workspaceNode: NodeSpec = { id: workspaceNodeId, type: 'workspace', label: e.workspacePath, extra: { workspacePath: e.workspacePath } };
      const agentNode: NodeSpec = { id: agentNodeId, type: 'agent', label: e.agentId, subtitle: e.workspacePath, extra: { agentId: e.agentId, workspacePath: e.workspacePath } };
      const collectorNode: NodeSpec | undefined = collectorRef
        ? { id: collectorNodeId, type: 'collector', label: collectorRef, subtitle: attrString(e, 'collectorNode') || undefined, extra: { collectorId: collectorRef } }
        : undefined;
      const targetNode: NodeSpec | undefined = target && targetNodeId
        ? { id: targetNodeId, type: target.type, label: target.label, subtitle: target.subtitle }
        : undefined;
      const eventEdges: EdgeSpec[] = [
        { id: edgeId(workspaceNodeId, agentNodeId, 'runs_in'), source: workspaceNode, target: agentNode, type: 'runs_in', label: '运行' },
      ];
      if (collectorNode) eventEdges.push({ id: edgeId(collectorNodeId, agentNodeId, 'observed_by'), source: collectorNode, target: agentNode, type: 'observed_by', label: '观测' });
      if (target && targetNode) eventEdges.push({ id: edgeId(agentNodeId, targetNodeId, target.edgeType), source: agentNode, target: targetNode, type: target.edgeType, label: target.edgeLabel });
      const eventEdgeIds = eventEdges.map((edge) => edge.id);
      const isPinnedEvent = Boolean(pinnedEventId && e.eventId === pinnedEventId);
      const isPinnedEdge = Boolean(pinnedEdgeId && eventEdgeIds.includes(pinnedEdgeId));
      const normalMatch =
        windowedEventIds.has(e.eventId) &&
        (!agentId || e.agentId === agentId) &&
        (!workspacePath || e.workspacePath === workspacePath) &&
        (!collectorId || collectorRef === collectorId) &&
        (!sourceId || sourceRef === sourceId) &&
        (includeBenign || e.verdict !== 'allow') &&
        (!q || [e.agentId, e.workspacePath, e.subject, e.riskCategory, e.riskName, collectorRef, sourceRef, target?.label, target?.subtitle].some((v) => (v ?? '').toLowerCase().includes(q)));
      const includeAllEventEdges = exactPinnedMode ? isPinnedEvent : normalMatch || isPinnedEvent;
      const includedEdges = includeAllEventEdges ? eventEdges : eventEdges.filter((edge) => pinnedEdgeId && edge.id === pinnedEdgeId);
      if (!includedEdges.length && !isPinnedEdge) continue;
      if (isPinnedEvent) for (const id of eventEdgeIds) pinnedEdgeIds.add(id);

      const bumpedNodeIds = new Set<string>();
      const bumpNodeOnce = (node: NodeSpec) => {
        if (bumpedNodeIds.has(node.id)) return;
        bumpedNodeIds.add(node.id);
        bumpNode(node.id, node.type, node.label, node.subtitle, e, node.extra);
      };
      for (const edge of includedEdges) {
        bumpNodeOnce(edge.source);
        bumpNodeOnce(edge.target);
        bumpEdge(edge.source.id, edge.target.id, edge.type, edge.label, e);
      }
    }

    const selectedEdges = [...edges.values()]
      .sort((a, b) =>
        Number(pinnedEdgeIds.has(b.edgeId)) - Number(pinnedEdgeIds.has(a.edgeId)) ||
        b.riskyEventCount - a.riskyEventCount ||
        b.severityRank - a.severityRank ||
        b.eventCount - a.eventCount ||
        b.lastSeenMs - a.lastSeenMs,
      )
      .slice(0, limit);
    const selectedNodeIds = new Set(selectedEdges.flatMap((edge) => [edge.sourceNodeId, edge.targetNodeId]));
    const selectedNodes = [...nodes.values()].filter((node) => selectedNodeIds.has(node.nodeId));
    const nodeItem = (node: NodeAgg): T.AgentTopologyNode => {
      const level = node.riskyEventCount ? levelByRank(node.severityRank) : { level: 'safe', text: LEVEL_TEXT.safe };
      return {
        nodeId: node.nodeId,
        type: node.type,
        label: node.label,
        subtitle: node.subtitle,
        agentId: node.agentId,
        workspacePath: node.workspacePath,
        collectorId: node.collectorId,
        riskLevel: level.level,
        riskLevelText: level.text,
        eventCount: node.eventCount,
        riskyEventCount: node.riskyEventCount,
        lastSeen: iso(node.lastSeenMs),
      };
    };
    const edgeItem = (edge: EdgeAgg): T.AgentTopologyEdge => ({
      edgeId: edge.edgeId,
      sourceNodeId: edge.sourceNodeId,
      targetNodeId: edge.targetNodeId,
      type: edge.type,
      label: edge.label,
      eventCount: edge.eventCount,
      riskyEventCount: edge.riskyEventCount,
      maxSeverity: edge.maxSeverity,
      lastSeen: iso(edge.lastSeenMs),
      sampleEventId: edge.sampleEventId,
      sampleSubject: edge.sampleSubject,
      riskCategories: [...edge.risks.entries()]
        .map(([riskCategory, value]) => ({ riskCategory, riskName: value.riskName, eventCount: value.eventCount }))
        .sort((a, b) => b.eventCount - a.eventCount),
    });
    const items = selectedNodes.map(nodeItem).sort((a, b) => b.riskyEventCount - a.riskyEventCount || b.eventCount - a.eventCount || Date.parse(b.lastSeen) - Date.parse(a.lastSeen));
    const edgeItems = selectedEdges.map(edgeItem);
    const countNodes = (type: T.TopologyNodeType) => items.filter((node) => node.type === type).length;
    return {
      nodes: items,
      edges: edgeItems,
      summary: {
        agentCount: countNodes('agent'),
        workspaceCount: countNodes('workspace'),
        collectorCount: countNodes('collector'),
        toolTargetCount: countNodes('tool'),
        externalEndpointCount: countNodes('network'),
        fileTargetCount: countNodes('file'),
        llmEndpointCount: countNodes('llm'),
        securityTargetCount: countNodes('security'),
        nodeCount: items.length,
        edgeCount: edgeItems.length,
        riskyEdgeCount: edgeItems.filter((edge) => edge.riskyEventCount > 0).length,
      },
      updateTime: iso(),
    };
  }

  collectorHealth(filter: T.CollectorHealthQuery): T.CollectorHealth {
    const { sinceMs, spanMs } = this.win(filter);
    const windowHeartbeats = this.judge.queryCollectorHeartbeats(sinceMs);
    const byCollector = new Map<string, T.CollectorHeartbeatRecord[]>();
    for (const hb of windowHeartbeats) (byCollector.get(hb.collectorId) ?? byCollector.set(hb.collectorId, []).get(hb.collectorId)!).push(hb);
    for (const hb of this.judge.latestCollectorHeartbeats()) {
      if (!byCollector.has(hb.collectorId)) byCollector.set(hb.collectorId, []);
    }

    const t = now();
    const stateText: Record<T.CollectorHealthState, string> = {
      healthy: '健康',
      quiet: '静默',
      degraded: '降级',
      stale: '陈旧',
      down: '断流',
    };
    const items = [...byCollector.entries()].map(([collectorId, hbs]): T.CollectorHealthItem => {
      const latest = [...hbs, ...this.judge.latestCollectorHeartbeats().filter((hb) => hb.collectorId === collectorId)]
        .sort((a, b) => b.at - a.at)[0];
      const categoryCounts = Object.fromEntries(EVENT_CATEGORIES.map((category) => [category, 0])) as Record<T.EventCategory, number>;
      let eventCount = 0;
      let observedAgentCount = 0;
      let reportedIntervalSecs = 0;
      for (const hb of hbs) {
        observedAgentCount = Math.max(observedAgentCount, hb.observedAgents);
        reportedIntervalSecs += hb.intervalSecs;
        for (const [kind, count] of Object.entries(hb.eventKindCounts)) {
          eventCount += count;
          const category = eventCategory(kind);
          categoryCounts[category] = (categoryCounts[category] ?? 0) + count;
        }
      }
      const age = latest ? t - latest.at : Infinity;
      const degraded = latest ? latest.status !== 'ok' || latest.droppedEvents > 0 || latest.outputDropped > 0 || latest.errorCount > 0 : false;
      const state: T.CollectorHealthState = age > COLLECTOR_DOWN_MS
        ? 'down'
        : age > COLLECTOR_STALE_MS
          ? 'stale'
          : degraded
            ? 'degraded'
            : eventCount === 0
              ? 'quiet'
              : 'healthy';
      return {
        collectorId,
        nodeName: latest?.nodeName,
        namespace: latest?.namespace,
        podName: latest?.podName,
        version: latest?.version,
        mode: latest?.mode,
        state,
        stateText: stateText[state],
        firstSeen: hbs.length ? iso(Math.min(...hbs.map((hb) => hb.at))) : undefined,
        lastHeartbeatAt: latest ? iso(latest.at) : undefined,
        lastSeenAt: latest ? iso(latest.at) : undefined,
        eventCount,
        eventRatePerMin: round1(eventCount / Math.max(1, reportedIntervalSecs > 0 ? reportedIntervalSecs / 60 : spanMs / 60_000)),
        riskyEventCount: 0,
        observedAgentCount,
        observedWorkspaceCount: 0,
        attachedProbes: latest?.attachedProbes ?? 0,
        enabledFeatures: latest?.enabledFeatures ?? [],
        queueDepth: latest?.queueDepth ?? 0,
        droppedEvents: latest?.droppedEvents ?? 0,
        outputDropped: latest?.outputDropped ?? 0,
        errorCount: latest?.errorCount ?? 0,
        message: latest?.message,
        eventCategoryCounts: categoryCounts,
      };
    });

    const collectorId = filter.collectorId?.trim();
    const nodeName = filter.nodeName?.trim();
    const q = filter.q?.trim().toLowerCase();
    const hasFilter = Boolean((filter.state && filter.state !== 'all') || nodeName || q);
    const filtered = items
      .filter((item) => {
        const matchesCollectorId = Boolean(collectorId && item.collectorId === collectorId);
        const matchesFilter =
          (!filter.state || filter.state === 'all' || item.state === filter.state) &&
          (!nodeName || item.nodeName === nodeName) &&
          (!q || [item.collectorId, item.nodeName, item.namespace, item.podName, item.version, item.mode, item.message].some((v) => (v ?? '').toLowerCase().includes(q)));
        if (collectorId && !hasFilter) return matchesCollectorId;
        return matchesCollectorId || matchesFilter;
      })
      .sort((a, b) => {
        const rank: Record<T.CollectorHealthState, number> = { down: 0, stale: 1, degraded: 2, quiet: 3, healthy: 4 };
        return Number(Boolean(collectorId) && b.collectorId === collectorId) - Number(Boolean(collectorId) && a.collectorId === collectorId)
          || rank[a.state] - rank[b.state]
          || b.droppedEvents - a.droppedEvents
          || b.eventCount - a.eventCount;
      });
    const summary: T.CollectorHealthSummary = {
      totalCollectors: filtered.length,
      healthyCollectors: filtered.filter((item) => item.state === 'healthy').length,
      quietCollectors: filtered.filter((item) => item.state === 'quiet').length,
      degradedCollectors: filtered.filter((item) => item.state === 'degraded').length,
      staleCollectors: filtered.filter((item) => item.state === 'stale').length,
      downCollectors: filtered.filter((item) => item.state === 'down').length,
      collectorsWithHeartbeat: filtered.filter((item) => item.lastHeartbeatAt).length,
      observedEventCount: filtered.reduce((a, item) => a + item.eventCount, 0),
      observedAgentCount: filtered.reduce((a, item) => a + item.observedAgentCount, 0),
    };
    const limit = Math.max(1, Math.min(500, filter.limit ?? 120));
    return { items: filtered.slice(0, limit), total: filtered.length, summary, updateTime: iso() };
  }

  coverageOverview(filter: T.CoverageQuery): T.CoverageOverview {
    const { events } = this.win(filter);
    const collectors = this.collectorHealth({ timeType: filter.timeType, startTime: filter.startTime, endTime: filter.endTime, limit: 500 });
    const agents = this.agentInventory({ timeType: filter.timeType, startTime: filter.startTime, endTime: filter.endTime, limit: 500 });
    const sourceList = this.sources.list({ status: 'all', type: 'all', limit: 500 });
    const collectorById = new Map(collectors.items.map((collector) => [collector.collectorId, collector]));
    const activeCollectorIds = new Set(
      collectors.items
        .filter((collector) => collector.state === 'healthy' || collector.state === 'quiet' || collector.state === 'degraded')
        .map((collector) => collector.collectorId),
    );
    const byAgent = new Map<string, T.JudgedEvent[]>();
    const byWorkspace = new Map<string, T.AgentInventoryItem[]>();
    for (const e of events) {
      const key = `${e.workspacePath}\0${e.agentId}`;
      (byAgent.get(key) ?? byAgent.set(key, []).get(key)!).push(e);
    }
    for (const agent of agents.items) {
      (byWorkspace.get(agent.workspacePath) ?? byWorkspace.set(agent.workspacePath, []).get(agent.workspacePath)!).push(agent);
    }

    const issue = (
      type: T.CoverageIssueType,
      severity: T.Severity,
      title: string,
      description: string,
      recommendedAction: string,
      labels: Record<string, string>,
      refs: Partial<Pick<T.CoverageIssue, 'agentId' | 'workspacePath' | 'collectorId' | 'sourceId' | 'nodeName' | 'evidenceEventId' | 'evidenceSubject' | 'lastSeenAt'>> = {},
    ): T.CoverageIssue => {
      const maintenance = this.maintenance.activeFor({
        workspacePath: refs.workspacePath,
        agentId: refs.agentId,
        collectorId: refs.collectorId,
        sourceId: refs.sourceId,
        nodeName: refs.nodeName,
      });
      return {
        issueId: compactIssueId(type, refs.workspacePath, refs.agentId, refs.collectorId, refs.nodeName, title),
        type,
        severity,
        title,
        description,
        detectedAt: iso(),
        recommendedAction,
        labels,
        suppressedByMaintenance: Boolean(maintenance),
        maintenanceWindowId: maintenance?.windowId,
        maintenanceTitle: maintenance?.title,
        ...refs,
      };
    };

    const issues: T.CoverageIssue[] = [];
    for (const source of sourceList.items) {
      if (!source.enabled) continue;
      const refs = {
        sourceId: source.sourceId,
        collectorId: source.collectorId,
        workspacePath: source.workspacePath,
        lastSeenAt: source.lastSignalAt ?? source.lastSeenAt,
      };
      const labels = {
        sourceType: source.type,
        requireToken: String(source.requireToken),
        acceptedEvents: String(source.acceptedEvents),
        acceptedHeartbeats: String(source.acceptedHeartbeats),
        rejectedEvents: String(source.rejectedEvents),
      };
      if (source.status === 'unused') {
        issues.push(issue(
          'source_unused',
          source.discovered ? 'low' : 'medium',
          `接入源未产生有效信号 · ${source.sourceId}`,
          source.lastSeenAt ? `最近只有接入尝试: ${source.lastSeenAt}，尚无 accepted event/heartbeat。` : '该接入源尚未产生 accepted event/heartbeat。',
          '发送一次带正确 sourceId/token 的测试事件或 check-in；若该源已废弃，请禁用它。',
          { ...labels, discovered: String(source.discovered) },
          refs,
        ));
      } else if (source.status === 'stale') {
        issues.push(issue(
          'source_stale',
          'high',
          `接入源信号陈旧 · ${source.sourceId}`,
          `最近 accepted 信号: ${source.lastSignalAt ?? 'unknown'}，该异构接入链路可能已经中断。`,
          '检查 forwarder/webhook/OTel bridge 进程、网络和 token；确认仍在发送 accepted event 或 heartbeat。',
          labels,
          refs,
        ));
      }

      if (source.lastResult === 'rejected') {
        issues.push(issue(
          'source_rejected',
          source.requireToken ? 'high' : 'medium',
          `接入源最近请求被拒绝 · ${source.sourceId}`,
          source.lastError ?? '最近一次接入尝试被拒绝。',
          '检查 source token、sourceId 绑定、事件格式和 /alerts 中的 Source 告警。',
          { ...labels, lastError: source.lastError ?? 'unknown' },
          { ...refs, lastSeenAt: source.lastSeenAt },
        ));
      }

      if (source.tokenRotationStatus === 'overdue') {
        issues.push(issue(
          'source_token_rotation_due',
          source.status === 'active' ? 'medium' : 'low',
          `接入源 Token 需要轮换 · ${source.sourceId}`,
          `Token issued=${source.tokenIssuedAt ?? 'unknown'}，rotation due=${source.tokenRotationDueAt ?? 'unknown'}。`,
          '在 Sources 页面轮换 token，更新生产者密钥后发送 check-in 或测试事件确认新 token 生效。',
          {
            ...labels,
            tokenIssuedAt: source.tokenIssuedAt ?? 'unknown',
            tokenRotationDueAt: source.tokenRotationDueAt ?? 'unknown',
            tokenRotationDays: String(source.tokenRotationDays ?? ''),
            tokenAgeSecs: String(source.tokenAgeSecs ?? ''),
          },
          { ...refs, lastSeenAt: source.lastSignalAt ?? source.lastSeenAt ?? source.tokenRotationDueAt },
        ));
      }
    }

    for (const collector of collectors.items) {
      if (collector.state === 'down') {
        issues.push(issue(
          'collector_down',
          'critical',
          `Collector 断流 · ${collector.collectorId}`,
          `最近心跳: ${collector.lastHeartbeatAt ?? 'unknown'}，该采集链路已超过断流阈值。`,
          '检查 DaemonSet/forwarder 进程、节点网络和 /security-center/ingest 可达性。',
          { state: collector.state, eventRatePerMin: String(collector.eventRatePerMin) },
          { collectorId: collector.collectorId, nodeName: collector.nodeName, lastSeenAt: collector.lastSeenAt },
        ));
      } else if (collector.state === 'stale') {
        issues.push(issue(
          'collector_stale',
          'high',
          `Collector 心跳陈旧 · ${collector.collectorId}`,
          `最近心跳: ${collector.lastHeartbeatAt ?? 'unknown'}，采集链路可能正在断开。`,
          '确认 observer collector 仍在发送 CollectorHeartbeat，并检查节点资源压力。',
          { state: collector.state, eventRatePerMin: String(collector.eventRatePerMin) },
          { collectorId: collector.collectorId, nodeName: collector.nodeName, lastSeenAt: collector.lastSeenAt },
        ));
      } else if (collector.state === 'degraded') {
        const dropped = collector.droppedEvents + collector.outputDropped;
        issues.push(issue(
          'collector_degraded',
          dropped > 0 || collector.errorCount > 0 ? 'high' : 'medium',
          `Collector 降级 · ${collector.collectorId}`,
          `dropped=${dropped}, errors=${collector.errorCount}, queue=${collector.queueDepth}`,
          '检查 ring buffer、输出队列、CPU/内存限制，以及 AnySentry ingest 延迟。',
          { dropped: String(dropped), errors: String(collector.errorCount), queueDepth: String(collector.queueDepth) },
          { collectorId: collector.collectorId, nodeName: collector.nodeName, lastSeenAt: collector.lastSeenAt },
        ));
      } else if (collector.state === 'quiet' && collector.observedAgentCount > 0) {
        issues.push(issue(
          'collector_quiet',
          'low',
          `Collector 静默 · ${collector.collectorId}`,
          `Collector 上报覆盖 ${collector.observedAgentCount} 个 Agent，但当前窗口没有事件。`,
          '确认窗口内是否预期无活动；若不是，检查 eBPF probes 和事件过滤条件。',
          { observedAgents: String(collector.observedAgentCount) },
          { collectorId: collector.collectorId, nodeName: collector.nodeName, lastSeenAt: collector.lastSeenAt },
        ));
      }
    }

    const collectorIdsFromEvents = new Map<string, { count: number; agents: Set<string>; sample?: T.JudgedEvent }>();
    for (const e of events) {
      const collectorId = eventCollectorId(e);
      if (!collectorId) continue;
      const cur = collectorIdsFromEvents.get(collectorId) ?? { count: 0, agents: new Set<string>(), sample: e };
      cur.count += 1;
      cur.agents.add(e.agentId);
      if (!cur.sample || e.at > cur.sample.at) cur.sample = e;
      collectorIdsFromEvents.set(collectorId, cur);
    }
    for (const [collectorId, rec] of collectorIdsFromEvents) {
      if (collectorById.has(collectorId)) continue;
      issues.push(issue(
        'missing_collector_heartbeat',
        'high',
        `缺少 Collector 心跳 · ${collectorId}`,
        `${rec.count} 条事件携带该 collectorId，但没有对应 CollectorHeartbeat。`,
        '启用 a3s-observer CollectorHeartbeat，或让 forwarder 定期 POST /security-center/collectors/heartbeat。',
        { eventCount: String(rec.count), agentCount: String(rec.agents.size) },
        { collectorId, nodeName: attrString(rec.sample!, 'collectorNode') || undefined, evidenceEventId: rec.sample?.eventId, evidenceSubject: rec.sample?.subject, lastSeenAt: rec.sample ? iso(rec.sample.at) : undefined },
      ));
    }

    let coveredAgents = 0;
    let uncoveredAgents = 0;
    let staleAgents = 0;
    let eventsWithoutCollector = 0;
    for (const agent of agents.items) {
      const key = `${agent.workspacePath}\0${agent.agentId}`;
      const agentEvents = byAgent.get(key) ?? [];
      const latest = [...agentEvents].sort((a, b) => b.at - a.at)[0];
      const collectorIds = new Set(agentEvents.map(eventCollectorId).filter(Boolean));
      const liveCollectorIds = [...collectorIds].filter((collectorId) => activeCollectorIds.has(collectorId));
      const missingCollectorEvents = agentEvents.filter((e) => !eventCollectorId(e));
      eventsWithoutCollector += missingCollectorEvents.length;
      const covered = liveCollectorIds.length > 0;
      if (covered) coveredAgents += 1;
      else uncoveredAgents += 1;
      if (agent.healthState === 'stale') staleAgents += 1;

      if (agent.healthState === 'stale') {
        issues.push(issue(
          'agent_stale',
          agent.openIncidentCount > 0 ? 'high' : 'medium',
          `Agent 观测陈旧 · ${agent.agentId}`,
          `最近事件: ${agent.lastSeen}，当前窗口内该 Agent 没有新的旁路活动。`,
          '确认该 Agent 是否仍在运行；若仍运行，检查所在节点 observer/forwarder 覆盖。',
          { openIncidents: String(agent.openIncidentCount), eventCount: String(agent.eventCount) },
          { agentId: agent.agentId, workspacePath: agent.workspacePath, evidenceEventId: latest?.eventId, evidenceSubject: latest?.subject, lastSeenAt: agent.lastSeen },
        ));
      }

      if (!covered) {
        const severity: T.Severity = agent.openIncidentCount > 0 || agent.riskyEventCount > 0 ? 'high' : 'medium';
        issues.push(issue(
          'agent_uncovered',
          severity,
          `Agent 缺少有效 Collector 覆盖 · ${agent.agentId}`,
          collectorIds.size
            ? `事件归属 Collector: ${[...collectorIds].join(', ')}，但当前没有活跃心跳。`
            : '该 Agent 的事件没有 collectorId，无法定位采集链路。',
          '检查 forwarder 是否附加 collectorId/nodeName，并确认对应 CollectorHeartbeat 正常上报。',
          { collectorIds: [...collectorIds].join(', ') || 'none', missingCollectorEvents: String(missingCollectorEvents.length) },
          { agentId: agent.agentId, workspacePath: agent.workspacePath, evidenceEventId: latest?.eventId, evidenceSubject: latest?.subject, lastSeenAt: agent.lastSeen },
        ));
      } else if (missingCollectorEvents.length > 0) {
        issues.push(issue(
          'agent_uncovered',
          agent.riskyEventCount > 0 ? 'medium' : 'low',
          `Agent 部分事件缺少 Collector 归属 · ${agent.agentId}`,
          `${missingCollectorEvents.length}/${agentEvents.length} 条事件没有 collectorId。`,
          '统一使用 observer forwarder，并在事件 attributes 中附加 collectorId/nodeName。',
          { missingCollectorEvents: String(missingCollectorEvents.length), eventCount: String(agentEvents.length) },
          { agentId: agent.agentId, workspacePath: agent.workspacePath, evidenceEventId: missingCollectorEvents[0]?.eventId, evidenceSubject: missingCollectorEvents[0]?.subject, lastSeenAt: agent.lastSeen },
        ));
      }
    }

    for (const [workspacePath, workspaceAgents] of byWorkspace) {
      if (workspaceAgents.length < 2) continue;
      const stale = workspaceAgents.filter((agent) => agent.healthState === 'stale');
      if (stale.length !== workspaceAgents.length) continue;
      issues.push(issue(
        'workspace_quiet',
        'medium',
        `Workspace 整体静默 · ${workspacePath}`,
        `${workspaceAgents.length} 个已观察 Agent 全部处于陈旧状态。`,
        '确认该 Workspace 是否已停用；若未停用，检查节点级 observer 覆盖和命名空间过滤。',
        { agentCount: String(workspaceAgents.length) },
        { workspacePath, lastSeenAt: workspaceAgents.map((agent) => agent.lastSeen).sort().at(-1) },
      ));
    }

    const q = filter.q?.trim().toLowerCase();
    const pinnedIssueId = filter.issueId?.trim();
    const agentId = filter.agentId?.trim();
    const workspacePath = filter.workspacePath?.trim();
    const collectorId = filter.collectorId?.trim();
    const sourceId = filter.sourceId?.trim();
    const hasFilter = Boolean(agentId || workspacePath || collectorId || sourceId || (filter.severity && filter.severity !== 'all') || (filter.type && filter.type !== 'all') || q);
    const filtered = issues
      .filter((item) => {
        const matchesIssueId = Boolean(pinnedIssueId && item.issueId === pinnedIssueId);
        const matchesFilter =
          (!agentId || item.agentId === agentId) &&
          (!workspacePath || item.workspacePath === workspacePath) &&
          (!collectorId || item.collectorId === collectorId) &&
          (!sourceId || item.sourceId === sourceId) &&
          (!filter.severity || filter.severity === 'all' || item.severity === filter.severity) &&
          (!filter.type || filter.type === 'all' || item.type === filter.type) &&
          (!q || [item.title, item.description, item.agentId, item.workspacePath, item.collectorId, item.sourceId, item.nodeName, item.evidenceSubject, item.type, item.maintenanceTitle].some((v) => (v ?? '').toLowerCase().includes(q)));
        if (pinnedIssueId && !hasFilter) return matchesIssueId;
        return matchesIssueId || matchesFilter;
      })
      .sort((a, b) =>
        Number(Boolean(pinnedIssueId) && b.issueId === pinnedIssueId) - Number(Boolean(pinnedIssueId) && a.issueId === pinnedIssueId) ||
        Number(a.suppressedByMaintenance) - Number(b.suppressedByMaintenance) ||
        SEV_RANK[b.severity] - SEV_RANK[a.severity] ||
        String(b.lastSeenAt ?? '').localeCompare(String(a.lastSeenAt ?? '')),
      );
    const limit = Math.max(1, Math.min(500, filter.limit ?? 120));
    const actionable = issues.filter((item) => !item.suppressedByMaintenance);
    const actionableSourceGapCount = distinct(
      actionable
        .filter((item) => item.type === 'source_unused' || item.type === 'source_stale')
        .map((item) => item.sourceId)
        .filter((sourceId): sourceId is string => Boolean(sourceId)),
    );
    const allCounts = {
      critical: actionable.filter((item) => item.severity === 'critical').length,
      high: actionable.filter((item) => item.severity === 'high').length,
      medium: actionable.filter((item) => item.severity === 'medium').length,
      low: actionable.filter((item) => item.severity === 'low').length,
    };
    const unhealthySourceCount = distinct(
      sourceList.items
        .filter((source) => source.enabled && (source.status === 'stale' || source.status === 'unused' || source.lastResult === 'rejected' || source.tokenRotationStatus === 'overdue'))
        .map((source) => source.sourceId),
    );
    const coverageScore = Math.max(1, Math.min(100, Math.round(
      100
      - allCounts.critical * 25
      - allCounts.high * 15
      - allCounts.medium * 7
      - allCounts.low * 3
      - Math.max(0, uncoveredAgents) * 4
      - actionableSourceGapCount * 2
      - Math.min(20, eventsWithoutCollector),
    )));
    const statusText = coverageScore >= 90 ? '覆盖良好' : coverageScore >= 75 ? '轻微缺口' : coverageScore >= 55 ? '需要关注' : coverageScore >= 35 ? '覆盖不足' : '严重盲区';
    return {
      summary: {
        coverageScore,
        statusText,
        issueCount: actionable.length,
        criticalIssues: allCounts.critical,
        highIssues: allCounts.high,
        mediumIssues: allCounts.medium,
        lowIssues: allCounts.low,
        suppressedIssues: issues.length - actionable.length,
        observedAgents: agents.summary.totalAgents,
        coveredAgents,
        uncoveredAgents,
        staleAgents,
        totalCollectors: collectors.summary.totalCollectors,
        activeCollectors: collectors.summary.healthyCollectors + collectors.summary.quietCollectors + collectors.summary.degradedCollectors,
        degradedCollectors: collectors.summary.degradedCollectors,
        downCollectors: collectors.summary.downCollectors + collectors.summary.staleCollectors,
        totalSources: sourceList.summary.totalSources,
        activeSources: sourceList.summary.activeSources,
        unhealthySources: unhealthySourceCount,
        eventsWithoutCollector,
        observedWorkspaces: distinct(agents.items.map((agent) => agent.workspacePath)),
      },
      issues: filtered.slice(0, limit),
      updateTime: iso(),
    };
  }

  policySimulation(input: T.PolicySimulationRequest): T.PolicySimulationResult {
    const config = sanitizePolicy(input.policy);
    let simulator: Sentry;
    try {
      simulator = Sentry.create(buildAcl(config));
    } catch (error) {
      throw policyConfigError(error);
    }
    const { events } = this.win(input);
    const limit = Math.max(1, Math.min(500, input.limit ?? 120));
    let evaluatedEvents = 0;
    let skippedEvents = 0;
    const diffs: T.PolicySimulationDiff[] = [];

    for (const event of events) {
      const raw = event.rawPreview;
      if (!raw) {
        skippedEvents += 1;
        continue;
      }
      evaluatedEvents += 1;
      let simulated: T.PolicySimulationDecision;
      try {
        simulated = normalizeSimulationDecision(simulator.evaluate(raw) as SimulatedDecision | null);
      } catch {
        skippedEvents += 1;
        continue;
      }
      const current: T.PolicySimulationDecision = {
        verdict: event.verdict,
        tier: event.tier,
        severity: event.severity,
        reason: event.reason,
      };
      const changeType = simulationChange(current, simulated);
      if (!changeType) continue;
      diffs.push({
        eventId: event.eventId,
        at: iso(event.at),
        eventKind: event.eventKind,
        subject: event.subject,
        agentId: event.agentId,
        workspacePath: event.workspacePath,
        traceId: event.traceId,
        riskCategory: event.riskCategory,
        riskName: event.riskName,
        current,
        simulated,
        changeType,
      });
    }

    diffs.sort((a, b) => {
      const aWeight = a.changeType === 'new_block' ? 4 : a.changeType === 'removed_block' ? 3 : a.changeType === 'new_escalation' ? 2 : 1;
      const bWeight = b.changeType === 'new_block' ? 4 : b.changeType === 'removed_block' ? 3 : b.changeType === 'new_escalation' ? 2 : 1;
      return bWeight - aWeight || SEV_RANK[b.simulated.severity] - SEV_RANK[a.simulated.severity] || Date.parse(b.at) - Date.parse(a.at);
    });

    const group = (keyOf: (diff: T.PolicySimulationDiff) => string): T.PolicySimulationGroup[] => {
      const byKey = new Map<string, T.PolicySimulationGroup>();
      for (const diff of diffs) {
        const key = keyOf(diff);
        const cur = byKey.get(key) ?? { key, eventCount: 0, newBlocks: 0, removedBlocks: 0, newEscalations: 0, maxSeverity: 'info' as T.Severity };
        cur.eventCount += 1;
        if (diff.changeType === 'new_block') cur.newBlocks += 1;
        if (diff.changeType === 'removed_block') cur.removedBlocks += 1;
        if (diff.changeType === 'new_escalation') cur.newEscalations += 1;
        cur.maxSeverity = SEV_RANK[diff.simulated.severity] > SEV_RANK[cur.maxSeverity] ? diff.simulated.severity : cur.maxSeverity;
        byKey.set(key, cur);
      }
      return [...byKey.values()].sort((a, b) => b.newBlocks - a.newBlocks || b.eventCount - a.eventCount).slice(0, 20);
    };

    const summary: T.PolicySimulationSummary = {
      evaluatedEvents,
      skippedEvents,
      changedEvents: diffs.length,
      newBlocks: diffs.filter((d) => d.changeType === 'new_block').length,
      removedBlocks: diffs.filter((d) => d.changeType === 'removed_block').length,
      newEscalations: diffs.filter((d) => d.changeType === 'new_escalation').length,
      removedEscalations: diffs.filter((d) => d.changeType === 'removed_escalation').length,
      severityIncreases: diffs.filter((d) => d.changeType === 'severity_increase').length,
      severityDecreases: diffs.filter((d) => d.changeType === 'severity_decrease').length,
      affectedAgents: distinct(diffs.map((d) => d.agentId)),
      affectedWorkspaces: distinct(diffs.map((d) => d.workspacePath)),
    };
    return {
      summary,
      diffs: diffs.slice(0, limit),
      byAgent: group((diff) => diff.agentId),
      byWorkspace: group((diff) => diff.workspacePath),
      updateTime: iso(),
    };
  }

  performanceCard(filter: T.SecurityTimeFilter): T.SecurityPerformanceCard {
    const { events, dataSinceMs, dataSpanMs } = this.win(filter);
    const n = 60;
    const size = dataSpanMs / n || 1;
    const counts = this.buckets(events, dataSinceMs, dataSpanMs, n).map((b) => b.length);
    const perSec = counts.map((c) => c / (size / 1000));
    const reqCur = counts[counts.length - 1] ?? 0;
    return {
      componentRequestCount: { current: reqCur, peak: Math.max(0, ...counts), avg: Math.round(mean(counts)) },
      tps: { current: round1(perSec[perSec.length - 1] ?? 0), peak: round1(Math.max(0, ...perSec)), avg: round1(mean(perSec)) },
      avgLatency: { value: Math.round(mean(events.map((e) => e.latencyMs))), unit: 'ms' },
      updateTime: iso(),
    };
  }

  riskSummary(filter: T.SecurityTimeFilter): T.SecurityRiskSummary {
    const { events } = this.win(filter);
    const risky = events.filter((e) => e.verdict !== 'allow');
    const card = (code: T.RiskType, name: string) => ({ riskTypeCode: code, riskTypeName: name, eventCount: risky.filter((e) => e.riskType === code).length });
    return { summaryCards: [card('system', '系统性风险'), card('communication', '通信风险'), card('atomic', '单体智能体风险')], updateTime: iso() };
  }

  riskBreakdown(filter: T.SecurityTimeFilter): T.SecurityRiskBreakdown {
    const { events, sinceMs, spanMs } = this.win(filter);
    const prev = this.judge.query(sinceMs - spanMs).filter((e) => e.at < sinceMs);
    const cat = (type: T.RiskType): T.RiskCategory => {
      const risky = events.filter((e) => e.verdict !== 'allow' && e.riskType === type);
      const prevRisky = prev.filter((e) => e.verdict !== 'allow' && e.riskType === type);
      const countOf = (xs: T.JudgedEvent[], code: string) => xs.filter((e) => e.riskCategory === code).length;
      // Always emit the full taxonomy for this type, then append any live code not in it (so a new
      // category from deriveRisk is never silently dropped).
      const known = RISK_TAXONOMY[type];
      const extras = [...new Set(risky.map((e) => e.riskCategory))]
        .filter((c) => !known.some((k) => k.code === c))
        .map((code) => ({ code, name: risky.find((e) => e.riskCategory === code)?.riskName ?? code }));
      const items = [...known, ...extras]
        .map(({ code, name }) => {
          const eventCount = countOf(risky, code);
          const before = countOf(prevRisky, code);
          const changeRate = before === 0 ? (eventCount ? 100 : 0) : round1(((eventCount - before) / before) * 100);
          return { riskCode: code, riskName: name, eventCount, changeRate };
        })
        .sort((a, b) => b.eventCount - a.eventCount);
      const top = items.find((i) => i.eventCount > 0);
      return { totalCount: risky.length, displayColor: CATEGORY_COLOR[top?.riskCode ?? ''] ?? '#94a3b8', items };
    };
    return { systemRisks: cat('system'), communicationRisks: cat('communication'), singleAgentRisks: cat('atomic'), updateTime: iso() };
  }

  highestRiskSession(filter: T.SecurityTimeFilter): T.SecurityHighestRiskSession {
    const { events } = this.win(filter);
    const bySession = new Map<string, T.JudgedEvent[]>();
    for (const e of events) (bySession.get(e.sessionId) ?? bySession.set(e.sessionId, []).get(e.sessionId)!).push(e);
    let top: T.JudgedEvent[] = [];
    let topScore = -1;
    for (const evs of bySession.values()) {
      const s = evs.reduce((a, e) => a + e.riskScore, 0);
      if (s > topScore) [topScore, top] = [s, evs];
    }
    if (!top.length) {
      return { sessionId: '-', userId: '-', workspacePath: '-', riskLevel: 'safe', riskLevelText: LEVEL_TEXT.safe, compositeScore: 0, lastEventTime: iso(), riskDimensions: DIMENSIONS.map((d) => ({ dimensionCode: d.code, dimensionName: d.name, score: 0 })), updateTime: iso() };
    }
    const head = top[0];
    const composite = Math.min(100, Math.round(mean(top.map((e) => e.riskScore)) + Math.sqrt(top.filter((e) => e.verdict !== 'allow').length) * 6));
    const dims = DIMENSIONS.map((d) => {
      const c = top.filter((e) => e.verdict !== 'allow' && d.cats.includes(e.riskCategory)).length;
      return { dimensionCode: d.code, dimensionName: d.name, score: c === 0 ? 0 : c === 1 ? 1 : c <= 3 ? 2 : 3 };
    });
    const lvl = levelByRank(Math.min(4, Math.floor(composite / 22)));
    return {
      sessionId: head.sessionId, userId: head.userId, workspacePath: head.workspacePath,
      riskLevel: lvl.level, riskLevelText: lvl.text, compositeScore: composite,
      lastEventTime: iso(Math.max(...top.map((e) => e.at))), riskDimensions: dims, updateTime: iso(),
    };
  }

  decisionFunnel(filter: T.SecurityTimeFilter): T.SecurityDecisionFunnel {
    const { events } = this.win(filter);
    const total = events.length || 1;
    const escalated = events.filter((e) => e.verdict === 'escalate');
    const deep = escalated.filter((e) => SEV_RANK[e.severity] >= 3);
    const blocked = events.filter((e) => e.verdict === 'block').length;
    const pct = (c: number) => round1((c / total) * 100);
    return {
      tiers: [
        { tierCode: 'L1', tierName: '规则引擎', count: events.length, percentage: 100, slaDesc: '确定性匹配 · <1ms' },
        { tierCode: 'L2', tierName: 'LLM 研判', count: escalated.length, percentage: pct(escalated.length), slaDesc: '语义判定 · <100ms' },
        { tierCode: 'L3', tierName: '智能体深判', count: deep.length, percentage: pct(deep.length), slaDesc: 'a3s-code · 深度调查' },
      ],
      finalBlock: { count: blocked, percentage: pct(blocked) },
      updateTime: iso(),
    };
  }

  agentObservability(filter: T.SecurityTimeFilter): T.AgentObservability {
    const { events } = this.win(filter);
    const recent = events.filter((e) => e.at >= now() - 60_000);
    const total = events.length || 1;
    const errorRate = round1((events.filter((e) => e.verdict !== 'allow').length / total) * 100);
    const comm = recent.filter((e) => e.eventKind === 'Egress' || e.eventKind === 'Dns').length;
    return {
      health: { heartbeatOk: recent.length > 0, resourceUtil: Math.min(99, 20 + recent.length * 3), errorRate, decisionLatencyMs: Math.round(mean(events.map((e) => e.latencyMs))) },
      behavioral: { actionRate: recent.length, decisionPattern: errorRate > 25 ? 'drift' : 'baseline', stateTransitions: distinct(recent.map((e) => e.sessionId)), goalProgress: Math.max(0, 100 - Math.round(errorRate)) },
      system: { agentCount: distinct(events.map((e) => e.agentId)), commThroughput: comm, infraHealthy: true },
      updateTime: iso(),
    };
  }

  workspaceRiskDistribution(filter: T.SecurityTimeFilter): T.SecurityWorkspaceRiskDistribution {
    const { events } = this.win(filter);
    const byWs = new Map<string, T.JudgedEvent[]>();
    for (const e of events) (byWs.get(e.workspacePath) ?? byWs.set(e.workspacePath, []).get(e.workspacePath)!).push(e);
    const list = [...byWs.entries()]
      .map(([workspacePath, evs]) => {
        const lvl = worstLevel(evs);
        return { workspacePath, sessionCount: distinct(evs.map((e) => e.sessionId)), totalRiskScore: evs.reduce((a, e) => a + e.riskScore, 0), riskLevel: lvl.level, riskLevelText: lvl.text };
      })
      .sort((a, b) => b.totalRiskScore - a.totalRiskScore);
    return { list, updateTime: iso() };
  }
}
