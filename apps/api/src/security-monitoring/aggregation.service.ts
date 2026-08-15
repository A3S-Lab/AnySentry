import { Injectable } from '@nestjs/common';
import { Sentry } from '@a3s-lab/sentry';
import { DashboardAggregateBucketFact, DashboardWindowBucketRow, DashboardWindowDimensionRow, DashboardWindowHistory, StoredAgentBucketFact, StoredAgentMetricBucketFact, StoredAgentWindowFact, StoredTopologyBucketFact, StoredTopologyWindowFact, StoredWorkspaceBucketFact, StoredWorkspaceWindowFact } from './clickhouse-store';
import {
  agentRuntimeInstanceIdForEvent,
  detectedAgentIdentity,
  hasDirectAgentRootEvidence,
  isAgentAssetClassification,
} from './agent-identity';
import { AgentMetadataService } from './agent-metadata.service';
import { WorkspaceDirectoryService } from './workspace-directory.service';
import { isEventClassificationVisible } from './event-visibility';
import { IngestionSourceService } from './ingestion-source.service';
import { MaintenanceWindowService } from './maintenance-window.service';
import { buildAcl, policyConfigError, sanitizePolicy } from './policy-config';
import { SentryJudgeService } from './sentry-judge.service';
import { planDashboardRead, pruneSnapshotCache } from './dashboard-query-plan';
import { DashboardHistoryBucketCache } from './dashboard-history-cache';
import {
  observedDurableThrough,
  relevantCommitProgress,
} from './query-coverage';
import { CommitAwareFactBucketCache } from './commit-aware-fact-cache';
import { foldLatestEventRevisions } from './event-revision';
import { resolveTimeWindow } from './time-window';
import * as T from './types';

const SEV_RANK: Record<T.Severity, number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };
const LEVEL_BY_RANK = ['info', 'low', 'medium', 'high', 'critical'];
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
const COMPACT_WINDOW_MS = 3_000;
const HOUR = 3_600_000;
const REUSABLE_BUCKET_MS = 10_000;
const DASHBOARD_HOT_TAIL_MS = 60_000;
const FINAL_DECISION_STATUSES = new Set<T.DecisionStatus>(['succeeded', 'failed', 'timeout']);

export interface ReusableFactSlices {
  fullStartMs: number;
  fullEndExclusiveMs: number;
  head?: { startMs: number; endMs: number };
  tail?: { startMs: number; endMs: number };
}

/**
 * Split the persisted closed interval into exact partial boundaries and reusable full buckets.
 *
 * Public Dashboard snapshots carry millisecond precision and are almost never bucket-aligned.
 * Refusing those ranges silently disabled the Agent, Workspace and topology caches. The split
 * preserves the exact closed-interval contract without letting a partial bucket enter the cache.
 */
export function reusableFactSlices(
  startMs: number,
  persistedUntilMs: number,
  hotFromMs: number,
  bucketMs = REUSABLE_BUCKET_MS,
): ReusableFactSlices {
  const size = Math.max(1, Math.trunc(bucketMs));
  const endExclusiveMs = Math.max(startMs, persistedUntilMs + 1);
  const firstFullBucket = Math.ceil(startMs / size) * size;
  const safeFullEnd = Math.min(
    Math.floor(endExclusiveMs / size) * size,
    Math.floor(hotFromMs / size) * size,
  );
  const fullEndExclusiveMs = Math.max(firstFullBucket, safeFullEnd);
  const headEndMs = Math.min(persistedUntilMs, firstFullBucket - 1);
  const tailStartMs = Math.max(startMs, fullEndExclusiveMs);
  return {
    fullStartMs: firstFullBucket,
    fullEndExclusiveMs,
    head: startMs <= headEndMs ? { startMs, endMs: headEndMs } : undefined,
    tail: tailStartMs <= persistedUntilMs
      ? { startMs: tailStartMs, endMs: persistedUntilMs }
      : undefined,
  };
}

class BoundedHistoryQueryGate {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly concurrency: number) {}

  async run<V>(operation: () => Promise<V>): Promise<V> {
    if (this.active >= this.concurrency) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active += 1;
    try {
      return await operation();
    } finally {
      this.active -= 1;
      this.waiters.shift()?.();
    }
  }
}

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

function agentInventoryGroupKey(agentAssetId: string, agentInstanceId: string): string {
  return `${agentAssetId}\0${agentInstanceId}`;
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
  if (kind === 'RuntimeEvent') return 'runtime';
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

function isMonitoredAgentEvent(e: T.JudgedEvent): boolean {
  return e.attribution?.monitored === true;
}

function canonicalAgentName(value?: string): string | undefined {
  const text = value?.trim().toLowerCase();
  if (!text) return undefined;
  if (text === 'a3s' || text === 'a3s-code' || text === 'a3s code') return 'a3s code';
  if (text === 'claude' || text === 'claude-code' || text === 'claude code') return 'Claude Code';
  return text;
}

function attributionWorkspacePath(e: T.JudgedEvent): string {
  if (!isMonitoredAgentEvent(e)) return e.workspacePath;
  const cwd = e.process?.cwd?.trim();
  if (cwd) return cwd;
  const scope = canonicalAgentName(e.attribution?.agentScopeId);
  return scope ? `agent://${scope}` : e.workspacePath;
}

function eventAgentLabel(e: T.JudgedEvent): string {
  return canonicalAgentName(e.attribution?.agentDisplayName) ?? canonicalAgentName(e.attribution?.agentScopeId) ?? e.agentId;
}

function eventSessionLabel(e: T.JudgedEvent): string {
  return e.attribution?.agentSessionId?.trim() || eventAgentLabel(e);
}

function dashboardFactForEvent(e: T.JudgedEvent): DashboardAggregateBucketFact {
  const final = e.decisionStatus !== undefined && FINAL_DECISION_STATUSES.has(e.decisionStatus);
  const risky = e.verdict !== 'allow';
  return {
    bucketStartMs: Math.floor(e.at / REUSABLE_BUCKET_MS) * REUSABLE_BUCKET_MS,
    monitored: isMonitoredAgentEvent(e),
    decisionStatus: e.decisionStatus ?? '',
    verdict: e.verdict,
    tier: e.tier,
    riskType: e.riskType,
    riskCategory: e.riskCategory,
    riskName: e.riskName,
    severityRank: SEV_RANK[e.severity],
    sessionKey: eventSessionLabel(e),
    userId: e.userId,
    workspacePath: attributionWorkspacePath(e),
    eventCount: 1,
    blockedCount: final && e.verdict === 'block' ? 1 : 0,
    escalatedCount: final && e.verdict === 'escalate' ? 1 : 0,
    l2Count: final && (e.tier === 'Llm' || e.tier === 'Agent') ? 1 : 0,
    l3Count: final && e.tier === 'Agent' ? 1 : 0,
    riskActivationCount: final && risky ? 1 : 0,
    riskyEventCount: risky ? 1 : 0,
    tokenCount: final ? e.tokenCount : 0,
    latencyTotal: final ? e.latencyMs : 0,
    riskScoreTotal: final ? e.riskScore : 0,
    lastEventAt: e.at,
    commandDangerCount: risky && e.riskCategory === 'command_danger' ? 1 : 0,
    promptInjectionCount: risky && e.riskCategory === 'prompt_injection' ? 1 : 0,
    dataLeakCount: risky && (e.riskCategory === 'data_leak' || e.riskCategory === 'secret_exfil') ? 1 : 0,
    communicationRiskCount: risky && e.riskCategory === 'communication_risk' ? 1 : 0,
    systemicRiskCount: risky && (
      e.riskCategory === 'systemic_risk' ||
      e.riskCategory === 'privilege_escalation'
    ) ? 1 : 0,
  };
}

function isLoopbackPeer(peer: string): boolean {
  return peer === '127.0.0.1' || peer === '::1' || peer === 'localhost';
}

function normalizedCommand(e: T.JudgedEvent): string {
  return (attrString(e, 'argv') || e.subject).trim().replace(/\s+/g, ' ').toLowerCase();
}

function isLowValueAgentNoise(e: T.JudgedEvent): boolean {
  if (!isMonitoredAgentEvent(e)) return false;
  if (e.verdict !== 'allow' || e.riskScore > 0) return false;
  if (e.eventKind === 'ProcessExit') return true;
  if (e.eventKind === 'Egress') {
    const peer = attrString(e, 'peer');
    const port = Number(attrString(e, 'port'));
    return isLoopbackPeer(peer) && (port === 7890 || port === 29653);
  }
  if (e.eventKind !== 'ToolExec') return false;
  const cmd = normalizedCommand(e);
  const exactNoise = new Set([
    'getconf long_bit',
    'lsb_release -a',
    'hostname -i',
    'who',
    'tr [:upper:] [:lower:]',
    'cut -c2-',
  ]);
  return exactNoise.has(cmd) || cmd === 'uname' || cmd.startsWith('uname ');
}
function eventCollectorId(e: T.JudgedEvent): string {
  return e.collectorId?.trim() || attrString(e, 'collectorId');
}

function eventSourceId(e: T.JudgedEvent): string {
  return e.sourceId?.trim() || attrString(e, 'sourceId');
}

function durableEventSearchKey(filter: T.AgentEventQuery): string {
  const text = (value?: string): string => value?.trim() ?? '';
  return JSON.stringify({
    timeType: filter.timeType ?? 'last_3h',
    // Preserve the raw custom boundaries: a date-only end includes the whole day, while an ISO
    // midnight ends at that instant even though Date.parse yields the same millisecond value.
    startTime: filter.startTime ?? '',
    endTime: filter.endTime ?? '',
    // Omitted scope compacts events; explicit raw scope does not, so these are not equivalent.
    scope: filter.scope ?? '',
    includeUnknown: filter.includeUnknown !== false,
    noise: filter.noise ?? 'hide',
    eventId: text(filter.eventId),
    sourceId: text(filter.sourceId),
    collectorId: text(filter.collectorId),
    agentId: text(filter.agentId),
    agentAssetId: text(filter.agentAssetId),
    sessionId: text(filter.sessionId),
    workspacePath: text(filter.workspacePath),
    traceId: text(filter.traceId),
    runId: text(filter.runId),
    // eventKind and limit are used without text/round normalization by filterEvents/slice.
    eventKind: filter.eventKind ?? '',
    eventCategory: filter.eventCategory ?? '',
    verdict: filter.verdict ?? '',
    tier: filter.tier ?? '',
    q: text(filter.q).toLowerCase(),
    limit: String(filter.limit ?? 40),
  });
}

function basename(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] || path;
}

function commandName(argv: string): string {
  const first = argv.trim().split(/\s+/)[0] ?? '';
  return first.includes('/') ? basename(first) : first;
}

function compactEventKey(e: T.JudgedEvent): string {
  const agent = eventAgentLabel(e);
  const command = e.eventKind === 'ToolExec' ? normalizedCommand(e) : '';
  const peer = e.eventKind === 'Egress' ? attrString(e, 'peer') + ':' + attrString(e, 'port') : '';
  const file = e.eventKind === 'FileAccess' || e.eventKind === 'FileDelete' ? attrString(e, 'path') : '';
  const subject = command || peer || file || e.subject;
  return [agent, e.eventKind, e.verdict, e.riskCategory, subject].join('\0');
}

function compactEvents(events: T.JudgedEvent[]): Array<{ event: T.JudgedEvent; repeatCount: number; lastAt: number }> {
  const out: Array<{ event: T.JudgedEvent; repeatCount: number; lastAt: number }> = [];
  for (const event of events) {
    const last = out[out.length - 1];
    if (last && compactEventKey(last.event) === compactEventKey(event) && Math.abs(last.lastAt - event.at) <= COMPACT_WINDOW_MS) {
      last.repeatCount += 1;
      last.lastAt = Math.max(last.lastAt, event.at);
      if (event.riskScore > last.event.riskScore || event.at > last.event.at) last.event = event;
      continue;
    }
    out.push({ event, repeatCount: 1, lastAt: event.at });
  }
  return out;
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
    private readonly workspaceDirectory: WorkspaceDirectoryService,
    private readonly maintenance: MaintenanceWindowService,
    private readonly sources: IngestionSourceService,
  ) {}

  // The dashboard polls 9 endpoints with the same filter near-simultaneously; cache the windowed
  // scan for a beat so they share one pass over the 100k ring instead of nine (keeps latency flat).
  private readonly winCache = new Map<string, { at: number; val: ReturnType<AggregationService['computeWin']> }>();
  private readonly historyCache = new Map<string, {
    startedAt: number;
    completedAt?: number;
    ttlMs: number;
    value: Promise<DashboardWindowHistory | null>;
  }>();
  private readonly agentInstanceMetricsCache = new Map<string, {
    at: number;
    value: T.AgentInstanceMetrics;
  }>();
  private dashboardHistoryBuckets?: DashboardHistoryBucketCache;
  private readonly agentHistoryBuckets = new Map<
    'agent' | 'all',
    CommitAwareFactBucketCache<StoredAgentBucketFact>
  >();
  private topologyHistoryBuckets?: CommitAwareFactBucketCache<StoredTopologyBucketFact>;
  private readonly workspaceHistoryBuckets = new Map<
    'agent' | 'all',
    CommitAwareFactBucketCache<StoredWorkspaceBucketFact>
  >();
  // A cold page can request Dashboard, Agent, Workspace and topology history together. Bounding
  // only those expensive historical reads prevents their ClickHouse aggregation peaks from
  // stacking while leaving ordinary event ingestion and short boundary reads unconstrained.
  private readonly historyQueryGate = new BoundedHistoryQueryGate(2);

  historyFactCacheStatus() {
    const agents = [...this.agentHistoryBuckets.entries()].map(([scope, cache]) => ({
      scope,
      ...cache.stats(),
    }));
    const workspaces = [...this.workspaceHistoryBuckets.entries()].map(([scope, cache]) => ({
      scope,
      ...cache.stats(),
    }));
    const caches = [
      ...(this.dashboardHistoryBuckets
        ? [{ name: 'dashboard', ...this.dashboardHistoryBuckets.stats() }]
        : []),
      ...agents.map((stats) => ({ name: `agents:${stats.scope}`, ...stats })),
      ...workspaces.map((stats) => ({ name: `workspaces:${stats.scope}`, ...stats })),
      ...(this.topologyHistoryBuckets
        ? [{ name: 'topology', ...this.topologyHistoryBuckets.stats() }]
        : []),
    ];
    return {
      schemaVersion: 'anysentry.history-cache.v1',
      caches,
      totals: caches.reduce(
        (total, cache) => ({
          buckets: total.buckets + cache.buckets,
          facts: total.facts + cache.facts,
          estimatedBytes: total.estimatedBytes + cache.estimatedBytes,
          evictions: total.evictions + cache.evictions,
          budgetRejects: total.budgetRejects + cache.budgetRejects,
          journalResets: total.journalResets + cache.journalResets,
        }),
        {
          buckets: 0,
          facts: 0,
          estimatedBytes: 0,
          evictions: 0,
          budgetRejects: 0,
          journalResets: 0,
        },
      ),
    };
  }

  invalidateWindowCache(): void {
    this.winCache.clear();
    // Ingestion invalidates the millisecond-scale hot-ring cache, but must not cancel or discard a
    // multi-second ClickHouse history query. Historical snapshots intentionally refresh on their
    // own short TTL; clearing them for every event creates a query storm at observer throughput.
  }

  private history(filter: T.SecurityTimeFilter): Promise<DashboardWindowHistory | null> {
    const window = resolveTimeWindow(filter);
    const t = now();
    const ttlMs = window.custom
      ? 5 * 60_000
      : window.spanMs >= 7 * 24 * 60 * 60_000
        ? 5 * 60_000
        : window.spanMs >= 24 * 60 * 60_000
          ? 60_000
          : 30_000;
    pruneSnapshotCache(this.historyCache, t, (entry) => entry.ttlMs);
    const cached = this.historyCache.get(window.cacheKey);
    if (cached && (cached.completedAt === undefined || t - cached.completedAt < cached.ttlMs)) return cached.value;
    const value = this.loadDashboardHistory(window);
    const entry = { startedAt: t, completedAt: undefined as number | undefined, ttlMs, value };
    this.historyCache.set(window.cacheKey, entry);
    void value.then((result) => {
      if (this.historyCache.get(window.cacheKey)?.value !== value) return;
      entry.completedAt = now();
      if (!result) entry.failedAt = entry.completedAt;
    });
    return value;
  }

  private async loadDashboardHistory(window: ReturnType<typeof resolveTimeWindow>): Promise<DashboardWindowHistory | null> {
    // The reusable cache currently targets the high-frequency preset ranges whose two-window
    // footprint is bounded. Long/custom investigations retain the exact legacy query until their
    // own persisted aggregate tables are available.
    if (!window.custom && window.spanMs <= 24 * HOUR) {
      this.dashboardHistoryBuckets ??= new DashboardHistoryBucketCache({
        latestCursor: () => this.judge.latestEventCommitCursor(),
        earliestCursor: () => this.judge.earliestEventCommitCursor(),
        changes: (after) => this.judge.eventCommitChanges(after),
        facts: (startMs, endExclusiveMs, bucketMs) =>
          this.historyQueryGate.run(() =>
            this.judge.dashboardAggregateBucketFacts(startMs, endExclusiveMs, bucketMs),
          ),
      });
      const tailStartMs = Math.max(
        window.startMs,
        Math.floor((window.endMs - DASHBOARD_HOT_TAIL_MS) / REUSABLE_BUCKET_MS) *
          REUSABLE_BUCKET_MS,
      );
      try {
        const [persistedTail, hotTail] = await Promise.all([
          this.judge.dashboardTailEvents(tailStartMs, window.endMs),
          Promise.resolve(this.judge.queryRange(tailStartMs, window.endMs)),
        ]);
        if (persistedTail === null) throw new Error('persisted dashboard tail unavailable');
        const tailFacts = foldLatestEventRevisions([...persistedTail, ...hotTail])
          .filter((event) => event.at >= tailStartMs && event.at <= window.endMs)
          .map(dashboardFactForEvent);
        const history = await this.dashboardHistoryBuckets.readWithTail(
          window.startMs,
          window.endMs,
          180,
          tailStartMs,
          tailFacts,
        );
        if (history) return history;
      } catch (error) {
        console.warn(
          `[dashboard] reusable history unavailable; using exact fallback: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      return this.historyQueryGate.run(() =>
        this.judge.dashboardWindowHistory(window.startMs, window.endMs, 180),
      );
    }
    return this.historyQueryGate.run(() =>
      this.judge.dashboardWindowHistory(window.startMs, window.endMs, 180),
    );
  }

  private currentDimensions(history: DashboardWindowHistory, filter: T.SecurityTimeFilter): DashboardWindowDimensionRow[] {
    const agentScoped = filter.scope === 'agent';
    return history.dimensions.filter((row) => row.period === 'current' && (!agentScoped || row.monitored));
  }

  private aggregateHistoryBuckets(history: DashboardWindowHistory, filter: T.SecurityTimeFilter, count: number): DashboardWindowBucketRow[] {
    const agentScoped = filter.scope === 'agent';
    const size = 180;
    const out: DashboardWindowBucketRow[] = Array.from({ length: count }, (_, bucketIndex) => ({
      bucketIndex,
      monitored: agentScoped,
      eventCount: 0,
      blockedCount: 0,
      escalatedCount: 0,
      l2Count: 0,
      l3Count: 0,
      riskActivationCount: 0,
      tokenCount: 0,
      latencyTotal: 0,
      riskScoreTotal: 0,
    }));
    for (const row of history.buckets) {
      if (agentScoped && !row.monitored) continue;
      const index = Math.min(count - 1, Math.floor((row.bucketIndex * count) / size));
      const target = out[index];
      target.eventCount += row.eventCount;
      target.blockedCount += row.blockedCount;
      target.escalatedCount += row.escalatedCount;
      target.l2Count += row.l2Count;
      target.l3Count += row.l3Count;
      target.riskActivationCount += row.riskActivationCount;
      target.tokenCount += row.tokenCount;
      target.latencyTotal += row.latencyTotal;
      target.riskScoreTotal += row.riskScoreTotal;
    }
    return out;
  }

  private win(filter: T.SecurityTimeFilter): { events: T.JudgedEvent[]; sinceMs: number; spanMs: number; dataSinceMs: number; dataSpanMs: number } {
    const window = resolveTimeWindow(filter);
    const key = window.cacheKey;
    const cached = this.winCache.get(key);
    const t = now();
    if (cached && t - cached.at < 1500) return cached.val;
    const val = this.computeWin(window.startMs, window.endMs);
    this.winCache.set(key, { at: t, val });
    return val;
  }

  private computeWin(sinceMs: number, endMs: number): { events: T.JudgedEvent[]; sinceMs: number; spanMs: number; dataSinceMs: number; dataSpanMs: number } {
    const queryRange = (this.judge as SentryJudgeService & {
      queryRange?: (startMs: number, untilMs: number) => T.JudgedEvent[];
    }).queryRange;
    const events = typeof queryRange === 'function'
      ? queryRange.call(this.judge, sinceMs, endMs)
      : this.judge.query(sinceMs).filter((event) => event.at <= endMs);
    // The in-memory ring may hold less time than the nominal window. Time-series/rate panels must
    // bucket over the data that actually exists, or everything piles into one bucket (req=100000).
    const dataSinceMs = events.length ? events[0].at : sinceMs;
    return { events, sinceMs, spanMs: endMs - sinceMs, dataSinceMs, dataSpanMs: Math.max(1, endMs - dataSinceMs) };
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
    const windowEvents = this.win(filter).events;
    const events = filter.scope === 'agent' ? windowEvents.filter(isMonitoredAgentEvent) : windowEvents;
    const total = events.length || 1;
    const blocked = events.filter((e) => e.verdict === 'block').length;
    const escalated = events.filter((e) => e.verdict === 'escalate').length;
    const score = Math.max(1, Math.min(100, Math.round(100 - (blocked / total) * 60 - (escalated / total) * 25)));
    const text = score >= 90 ? '健康' : score >= 75 ? '良好' : score >= 60 ? '注意' : score >= 40 ? '风险偏高' : '高危';
    const tok = fmtTokens(events.reduce((a, e) => a + e.tokenCount, 0));
    return { healthScore: score, healthStatusText: text, tokenConsumptionTotal: tok.total, tokenConsumptionUnit: tok.unit };
  }

  explainabilityScan(filter: T.ExplainabilityScanRequest): T.SecurityExplainabilityScan {
    const { events: windowEvents, dataSinceMs, dataSpanMs } = this.win(filter);
    const events = filter.scope === 'agent' ? windowEvents.filter(isMonitoredAgentEvent) : windowEvents;
    const n = Math.max(8, Math.min(72, filter.seriesPoints ?? 24));
    const size = dataSpanMs / n || 1;
    const buckets = this.buckets(events, dataSinceMs, dataSpanMs, n);
    const safeSeries: T.WaveSeriesPoint[] = [];
    const riskSeries: T.WaveSeriesPoint[] = [];
    buckets.forEach((b, i) => {
      const statTime = iso(dataSinceMs + i * size);
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

  private eventItem(e: T.JudgedEvent, repeatCount = 1, lastAt = e.at): T.AgentEventListItem {
    const detected = detectedAgentIdentity(e);
    const resolved = this.agentMetadata.resolveEvent(e);
    return {
      schemaVersion: e.schemaVersion,
      eventId: e.eventId,
      sourceEventId: e.sourceEventId,
      at: iso(e.at),
      eventKind: e.eventKind,
      eventCategory: e.eventCategory,
      source: e.source,
      subject: e.subject,
      workspacePath: e.workspacePath,
      agentId: e.agentId,
      agentAssetId: resolved.agentAssetId,
      displayName: resolved.displayName,
      detectedName: resolved.detectedName,
      detectedClassification: resolved.detectedClassification,
      effectiveClassification: resolved.effectiveClassification,
      runtime: detected.runtime,
      locationLabel: detected.locationLabel,
      collectorId: eventCollectorId(e) || undefined,
      sourceId: eventSourceId(e) || undefined,
      sessionId: e.sessionId,
      userId: e.userId,
      traceId: e.traceId,
      spanId: e.spanId,
      parentSpanId: e.parentSpanId,
      runId: e.runId,
      taskId: e.taskId,
      decisionStatus: e.decisionStatus,
      evaluationId: e.evaluationId,
      policyVersion: e.policyVersion,
      decisionRevision: e.decisionRevision,
      decisionUpdatedAt: e.decisionUpdatedAt,
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
      process: e.process,
      attribution: e.attribution,
      judgment: e.judgment,
      repeatCount: repeatCount > 1 ? repeatCount : undefined,
      lastAt: repeatCount > 1 ? iso(lastAt) : undefined,
      rawPreview: e.rawPreview,
    };
  }

  private queryCoverage(
    filter: T.SecurityTimeFilter,
    events: T.JudgedEvent[],
    input: {
      source: T.QueryDataSource;
      totalMode: T.QueryTotalMode;
      partial: boolean;
      partialReason?: T.QueryCoverage['partialReason'];
      committedCutoffMs?: number;
      dataFromMs?: number;
      dataToMs?: number;
    },
  ): T.QueryCoverage {
    const window = resolveTimeWindow(filter);
    const eventTimes = events.map((event) => event.at);
    if (input.dataFromMs !== undefined) eventTimes.push(input.dataFromMs);
    if (input.dataToMs !== undefined) eventTimes.push(input.dataToMs);
    const snapshotAsOf = new Date(window.endMs).toISOString();
    const queryIdentity = filter as T.SecurityTimeFilter & {
      sourceId?: string;
      collectorId?: string;
    };
    const progress = relevantCommitProgress(
      this.judge.committedEventProgress(),
      queryIdentity,
    );
    const observedThroughMs = observedDurableThrough(
      input.committedCutoffMs,
      progress,
    );
    const observedThrough = observedThroughMs === undefined
      ? undefined
      : new Date(Math.min(observedThroughMs, window.endMs)).toISOString();
    return {
      requestedFrom: new Date(window.startMs).toISOString(),
      requestedTo: snapshotAsOf,
      snapshotAsOf,
      asOf: snapshotAsOf,
      dataFrom: eventTimes.length ? new Date(Math.min(...eventTimes)).toISOString() : undefined,
      dataTo: eventTimes.length ? new Date(Math.max(...eventTimes)).toISOString() : undefined,
      observedDurableThrough: observedThrough,
      committedCutoff: observedThrough,
      commitBoundaryKind: observedThrough ? 'observed_durable_high_water' : undefined,
      commitProgress: progress.entries.map((entry) => ({
        sourceId: entry.sourceId,
        collectorId: entry.collectorId,
        committedEventTime: new Date(entry.committedEventTimeMs).toISOString(),
        committedAt: new Date(entry.committedAtMs).toISOString(),
      })),
      commitProgressScope: progress.scope,
      lateDataPolicy: input.source === 'memory_hot_ring'
        ? undefined
        : 'commit_journal_revision_repair',
      completeness: input.partial ? 'partial' : 'exact_as_observed',
      // A real event-time watermark is not yet available from every collector/partition. Do not
      // present ClickHouse's latest timestamp as a watermark.
      watermark: undefined,
      partial: input.partial,
      partialReason: input.partialReason,
      source: input.source,
      totalMode: input.totalMode,
    };
  }

  private filterEvents(events: T.JudgedEvent[], filter: T.AgentEventQuery): T.JudgedEvent[] {
    const pinnedEventId = filter.eventId?.trim();
    const sourceId = filter.sourceId?.trim();
    const collectorId = filter.collectorId?.trim();
    const agentId = filter.agentId?.trim();
    const requestedAgentAssetId = filter.agentAssetId?.trim();
    const agentAssetId = requestedAgentAssetId
      ? this.agentMetadata.canonicalAgentAssetId(requestedAgentAssetId)
      : undefined;
    const agentInstanceId = filter.agentInstanceId?.trim();
    const sessionId = filter.sessionId?.trim();
    const workspacePath = filter.workspacePath?.trim();
    const traceId = filter.traceId?.trim();
    const runId = filter.runId?.trim();
    const q = filter.q?.trim().toLowerCase();
    const hasFilter = Boolean(sourceId || collectorId || agentId || agentAssetId || agentInstanceId || sessionId || workspacePath || traceId || runId || filter.eventKind || filter.eventCategory || filter.verdict || filter.tier || q);
    const agentScoped = filter.scope === 'agent' && !pinnedEventId;
    const includeUnknown = filter.includeUnknown !== false;
    // Process lifecycle rows remain stored for audit/debugging, but are hidden from both the
    // Agent and raw "all events" views by default. An explicit kind filter, noise=include, or a
    // pinned event still makes them accessible.
    const hideNoise = !pinnedEventId && !filter.eventKind && filter.noise !== 'include';
    return events.filter((e) => {
      const matchesEventId = Boolean(pinnedEventId && e.eventId === pinnedEventId);
      if (pinnedEventId && !hasFilter) return matchesEventId;

      const eventSource = eventSourceId(e);
      const eventCollector = eventCollectorId(e);
      const isHiddenNoise = agentScoped ? isLowValueAgentNoise(e) : e.eventKind === 'ProcessExit';
      // Exact fields are already present on the event. Reject on them before resolving display
      // metadata, which may read the manual-review registry and hash an asset identity. A scoped
      // query commonly reduces the 100k hot ring to tens of rows, so this ordering keeps event
      // search proportional to the result set without changing pinned-event semantics.
      const matchesDirectFilter =
        (!sourceId || eventSource === sourceId) &&
        (!collectorId || eventCollector === collectorId) &&
        (agentAssetId || !agentId || e.agentId === agentId) &&
        (!sessionId || e.sessionId === sessionId) &&
        (agentAssetId || !workspacePath || e.workspacePath === workspacePath) &&
        (!traceId || e.traceId === traceId) &&
        (!runId || e.runId === runId) &&
        (!filter.eventKind || e.eventKind === filter.eventKind) &&
        (!filter.eventCategory || e.eventCategory === filter.eventCategory) &&
        (!filter.verdict || e.verdict === filter.verdict) &&
        (!filter.tier || e.tier === filter.tier) &&
        (!hideNoise || !isHiddenNoise);
      if (!matchesEventId && !matchesDirectFilter) return false;

      const resolved = this.agentMetadata.resolveEvent(e);
      const visibleClassification = isEventClassificationVisible(
        resolved.effectiveClassification,
        agentScoped ? 'agent' : 'raw',
        includeUnknown,
        matchesEventId,
      );
      const matchesScope =
        visibleClassification &&
        (!hideNoise || !isHiddenNoise);
      const matchesFilter =
        matchesScope &&
        matchesDirectFilter &&
        (!agentAssetId || resolved.agentAssetId === agentAssetId) &&
        (!agentInstanceId || agentRuntimeInstanceIdForEvent(e) === agentInstanceId) &&
        (
          !q ||
          [
            e.subject,
            e.agentId,
            resolved.displayName,
            resolved.detectedName,
            e.sessionId,
            e.rawPreview,
            JSON.stringify(e.attributes ?? {}),
            JSON.stringify(e.attribution ?? {}),
          ].some((value) => value?.toLowerCase().includes(q))
        );
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
    const compacted = filter.scope === 'raw' || pinnedEventId ? filtered.map((event) => ({ event, repeatCount: 1, lastAt: event.at })) : compactEvents(filtered);
    return {
      items: compacted.slice(0, limit).map(({ event, repeatCount, lastAt }) => this.eventItem(event, repeatCount, lastAt)),
      total: compacted.length,
      totalMode: 'exact',
      coverage: this.queryCoverage(filter, filtered, {
        source: 'memory_hot_ring',
        totalMode: 'exact',
        partial: true,
        partialReason: 'hot_ring_only',
      }),
      updateTime: iso(),
    };
  }

  agentEventsPreview(filter: T.AgentEventQuery): T.AgentEventList {
    const window = resolveTimeWindow(filter);
    const limit = Math.max(1, Math.min(200, filter.limit ?? 40));
    const scanLimit = Math.min(4_000, Math.max(800, limit * 20));
    const recent = this.judge.queryRecentRange(window.startMs, window.endMs, scanLimit);
    const filtered = this.filterEvents(recent, filter).sort((a, b) => b.at - a.at);
    const compacted = filter.scope === 'raw'
      ? filtered.map((event) => ({ event, repeatCount: 1, lastAt: event.at }))
      : compactEvents(filtered);
    return {
      items: compacted.slice(0, limit).map(({ event, repeatCount, lastAt }) => this.eventItem(event, repeatCount, lastAt)),
      total: compacted.length,
      totalMode: 'estimated',
      coverage: this.queryCoverage(filter, filtered, {
        source: 'memory_hot_ring',
        totalMode: 'estimated',
        partial: true,
        partialReason: 'hot_ring_only',
      }),
      updateTime: iso(),
    };
  }

  async agentEventsForWindow(filter: T.AgentEventQuery): Promise<T.AgentEventList> {
    if (filter.eventId) return this.agentEvents(filter);
    const window = resolveTimeWindow(filter);
    const limit = Math.max(1, Math.min(200, filter.limit ?? 40));
    const persistedLimit = Math.max(1_000, limit * 10);
    const persisted = await this.judge.recentPersistedEvents(
      window.startMs,
      window.endMs,
      persistedLimit,
      { monitoredOnly: filter.scope === 'agent', tier: filter.tier },
    );
    if (!persisted) return { ...this.agentEvents(filter), totalApproximate: true };
    const filtered = this.filterEvents(persisted, filter).sort((a, b) => b.at - a.at);
    const compacted = filter.scope === 'raw'
      ? filtered.map((event) => ({ event, repeatCount: 1, lastAt: event.at }))
      : compactEvents(filtered);
    const hasDetailedFilter = Boolean(
      filter.sourceId || filter.collectorId || filter.agentId || filter.agentAssetId || filter.sessionId || filter.workspacePath ||
      filter.traceId || filter.runId || filter.eventKind || filter.eventCategory || filter.verdict || filter.q,
    );
    // A history aggregate cannot answer a text/identity-filtered total. Avoid an unrelated full
    // window scan and report the bounded compacted result set already fetched above.
    const history = hasDetailedFilter ? null : await this.history(filter);
    const rows = history && !hasDetailedFilter
      ? this.currentDimensions(history, filter).filter((row) => !filter.tier || row.tier === filter.tier)
      : [];
    const total = rows.length ? rows.reduce((sum, row) => sum + row.eventCount, 0) : compacted.length;
    const totalApproximate = hasDetailedFilter || !history ||
      (rows.length > 0 && history.countsApproximate) || persisted.length >= persistedLimit;
    return {
      items: compacted.slice(0, limit).map(({ event, repeatCount, lastAt }) => this.eventItem(event, repeatCount, lastAt)),
      total,
      totalMode: rows.length ? 'exact' : 'estimated',
      coverage: this.queryCoverage(filter, filtered, {
        source: 'clickhouse',
        totalMode: rows.length ? 'exact' : 'estimated',
        partial: persisted.length >= Math.max(1_000, limit * 10),
        partialReason: persisted.length >= Math.max(1_000, limit * 10) ? 'scan_limit' : undefined,
        committedCutoffMs: this.judge.committedEventCutoffMs(),
      }),
      updateTime: iso(),
    };
  }

  async storedAgentEvents(filter: T.AgentEventQuery): Promise<T.AgentEventList> {
    const snapshot = { ...filter };
    const key = durableEventSearchKey(snapshot);
    const current = this.durableEventSearchInFlight;
    if (current?.key === key) {
      const shared = await current.value;
      return structuredClone(shared);
    }
    // A different request is still allowed to reach ClickHouseStore, whose shared wide-read slot
    // will fail it closed to the explicit hot-ring fallback instead of queueing another query.
    if (current) return this.computeStoredAgentEvents(snapshot);

    const value = Promise.resolve().then(() => this.computeStoredAgentEvents(snapshot));
    this.durableEventSearchInFlight = { key, value };
    try {
      const result = await value;
      return structuredClone(result);
    } finally {
      if (this.durableEventSearchInFlight?.value === value) this.durableEventSearchInFlight = undefined;
    }
  }

  private async computeStoredAgentEvents(filter: T.AgentEventQuery): Promise<T.AgentEventList> {
    if (!this.judge.storageStatus().clickhouseReady) {
      return { ...this.agentEvents(filter), totalApproximate: true, storageFallback: 'hot_ring' };
    }
    const pinnedEventId = filter.eventId?.trim();
    const window = resolveTimeWindow(filter);
    const limit = Math.max(1, Math.min(200, filter.limit ?? 40));
    const scanLimit = Math.min(20_000, Math.max(2_000, limit * 50));
    const committedCutoffMs = this.judge.committedEventCutoffMs();
    const plan = planDashboardRead(window.startMs, window.endMs, committedCutoffMs);
    const persistedUntilMs = plan.persistedUntilMs ?? window.endMs;
    const persistentPage = await this.judge.searchStoredEventsPage({
      sinceMs: pinnedEventId ? 0 : window.startMs,
      untilMs: pinnedEventId ? window.endMs : persistedUntilMs,
      eventId: pinnedEventId,
      sourceId: filter.sourceId,
      collectorId: filter.collectorId,
      agentId: filter.agentAssetId ? undefined : filter.agentId,
      agentInstanceId: filter.agentInstanceId,
      sessionId: filter.sessionId,
      workspacePath: filter.agentAssetId ? undefined : filter.workspacePath,
      traceId: filter.traceId,
      runId: filter.runId,
      eventKind: filter.eventKind,
      eventCategory: filter.eventCategory,
      verdict: filter.verdict,
      tier: filter.tier,
      limit: scanLimit,
    });
    if (persistentPage.unavailable) {
      return this.agentEvents(filter);
    }
    // A collector/partition event-time watermark is not available yet. Query the bounded hot
    // overlap defensively and remove overlap by stable eventId before aggregation. Splitting only
    // at max(at) would lose a late event that is buffered with an event time below that maximum.
    const hot = this.judge.queryRange(pinnedEventId ? 0 : plan.hotFromMs, window.endMs);
    const folded = foldLatestEventRevisions([...persistentPage.events, ...hot]);
    const filtered = this.filterEvents(folded, filter).sort((a, b) =>
      Number(Boolean(pinnedEventId) && b.eventId === pinnedEventId) - Number(Boolean(pinnedEventId) && a.eventId === pinnedEventId) ||
      b.at - a.at,
    );
    const compacted = filter.scope === 'raw' || pinnedEventId
      ? filtered.map((event) => ({ event, repeatCount: 1, lastAt: event.at }))
      : compactEvents(filtered);
    const totalMode: T.QueryTotalMode = persistentPage.hasMore ? 'estimated' : 'exact';
    return {
      items: compacted.slice(0, limit).map(({ event, repeatCount, lastAt }) => this.eventItem(event, repeatCount, lastAt)),
      total: compacted.length,
      totalMode,
      coverage: this.queryCoverage(filter, filtered, {
        source: hot.length ? 'clickhouse+hot_delta' : 'clickhouse',
        totalMode,
        partial: persistentPage.hasMore,
        partialReason: persistentPage.hasMore ? 'scan_limit' : undefined,
        committedCutoffMs: persistentPage.committedCutoffMs,
      }),
      updateTime: iso(),
    };
  }

  async storedAgentTimeline(filter: T.AgentEventQuery): Promise<T.AgentTimeline> {
    if (!this.judge.storageStatus().clickhouseReady) {
      const fallback = this.agentTimeline(filter);
      return fallback;
    }
    const window = resolveTimeWindow(filter);
    const limit = Math.max(1, Math.min(5_000, filter.limit ?? 240));
    const pinnedEventId = filter.eventId?.trim();
    const pinnedPage = pinnedEventId
      ? await this.judge.searchStoredEventsPage({
          sinceMs: 0,
          untilMs: window.endMs,
          eventId: pinnedEventId,
          limit: 1,
        })
      : undefined;
    const pinned = pinnedPage?.events[0] ?? (pinnedEventId ? this.judge.findEvent(pinnedEventId) : undefined);
    const traceId = filter.traceId?.trim() || pinned?.traceId;
    const effectiveFilter: T.AgentEventQuery = {
      ...filter,
      eventId: undefined,
      traceId,
    };
    const committedCutoffMs = this.judge.committedEventCutoffMs();
    const plan = planDashboardRead(window.startMs, window.endMs, committedCutoffMs);
    const persistedUntilMs = plan.persistedUntilMs ?? window.endMs;
    const persistentPage = await this.judge.searchStoredEventsPage({
      sinceMs: window.startMs,
      untilMs: persistedUntilMs,
      traceId,
      runId: traceId ? undefined : filter.runId,
      sessionId: traceId || filter.runId ? undefined : filter.sessionId,
      agentInstanceId: traceId || filter.runId || filter.sessionId
        ? undefined
        : filter.agentInstanceId,
      limit,
    });
    if (persistentPage.unavailable) {
      return this.agentTimeline(filter);
    }
    // See storedAgentEvents: until collector-scoped watermarks exist, overlap is safer than
    // event-time splitting and is removed before building the ordered timeline.
    const hot = this.judge.queryRange(plan.hotFromMs, window.endMs);
    const folded = foldLatestEventRevisions([...persistentPage.events, ...hot]);
    const filtered = this.filterEvents(folded, effectiveFilter).sort((a, b) => a.at - b.at);
    const visible = filtered.slice(-limit);
    const head = visible[0];
    const hasMore = persistentPage.hasMore || filtered.length > limit;
    return {
      traceId: traceId ?? head?.traceId ?? '',
      runId: filter.runId ?? head?.runId,
      sessionId: filter.sessionId ?? head?.sessionId,
      items: visible.map((event) => this.eventItem(event)),
      total: filtered.length,
      hasMore,
      coverage: this.queryCoverage(filter, visible, {
        source: hot.length ? 'clickhouse+hot_delta' : 'clickhouse',
        totalMode: hasMore ? 'estimated' : 'exact',
        partial: hasMore,
        partialReason: hasMore ? 'scan_limit' : undefined,
        committedCutoffMs: persistentPage.committedCutoffMs,
      }),
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
      total: filtered.length,
      hasMore: false,
      coverage: this.queryCoverage(filter, filtered, {
        source: 'memory_hot_ring',
        totalMode: 'exact',
        partial: true,
        partialReason: 'hot_ring_only',
      }),
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
        if (filter.scope === 'agent' && !matchesIncidentId && i.monitored !== true) return false;
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
    const window = this.win(filter);
    const events = filter.scope === 'agent'
      ? window.events.filter((event) => event.attribution?.monitored === true)
      : window.events;
    return this.agentInventoryFromEvents(filter, events);
  }

  private agentFactForEvent(event: T.JudgedEvent): StoredAgentWindowFact {
    const risky = event.verdict !== 'allow';
    const instanceKey = agentRuntimeInstanceIdForEvent(event);
    const categoryCounts = Object.fromEntries(EVENT_CATEGORIES.map((category) => [
      category,
      event.eventCategory === category ? 1 : 0,
    ]));
    const sourceCounts = Object.fromEntries(EVENT_SOURCES.map((source) => [
      source,
      event.source === source ? 1 : 0,
    ]));
    return {
      identityKey: event.eventId,
      representativeEvent: event,
      firstSeenAt: event.at,
      lastSeenAt: event.at,
      eventCount: 1,
      riskyEventCount: risky ? 1 : 0,
      sessionCount: 1,
      runCount: 1,
      traceCount: 1,
      sessionKeys: [event.sessionId],
      runKeys: [event.runId],
      traceKeys: [event.traceId],
      collectorKeys: eventCollectorId(event) ? [eventCollectorId(event)] : [],
      eventsWithoutCollector: eventCollectorId(event) ? 0 : 1,
      tokenCount: event.tokenCount,
      latencyTotal: event.latencyMs,
      instanceCount: 1,
      instanceKeys: [instanceKey],
      worstSeverityRank: risky ? SEV_RANK[event.severity] : 0,
      topRiskAt: risky ? event.at : undefined,
      topRiskCategory: risky ? event.riskCategory : undefined,
      topRiskName: risky ? event.riskName : undefined,
      eventCategoryCounts: categoryCounts,
      sourceCounts,
      hasPhysicalIdentity: Boolean(
        event.attribution?.physicalWorkloadId ||
        event.attribution?.agentInstanceId ||
        event.attribution?.workloadRef?.podUid,
      ),
      hasRootIdentity: Boolean(event.attribution?.rootStartTime) && hasDirectAgentRootEvidence(event),
    };
  }

  private mergeAgentFacts(a: StoredAgentWindowFact, b: StoredAgentWindowFact): StoredAgentWindowFact {
    const newest = a.lastSeenAt >= b.lastSeenAt ? a : b;
    const latestRisk = (b.topRiskAt ?? 0) >= (a.topRiskAt ?? 0) ? b : a;
    const sessionKeys = [...new Set([...a.sessionKeys, ...b.sessionKeys])];
    const runKeys = [...new Set([...a.runKeys, ...b.runKeys])];
    const traceKeys = [...new Set([...a.traceKeys, ...b.traceKeys])];
    const collectorKeys = [...new Set([...a.collectorKeys, ...b.collectorKeys])];
    const instanceKeys = [...new Set([...a.instanceKeys, ...b.instanceKeys])];
    const eventCategoryCounts: Record<string, number> = {};
    for (const category of EVENT_CATEGORIES) {
      eventCategoryCounts[category] =
        (a.eventCategoryCounts[category] ?? 0) +
        (b.eventCategoryCounts[category] ?? 0);
    }
    const sourceCounts: Record<string, number> = {};
    for (const source of EVENT_SOURCES) {
      sourceCounts[source] =
        (a.sourceCounts[source] ?? 0) +
        (b.sourceCounts[source] ?? 0);
    }
    return {
      identityKey: newest.identityKey,
      representativeEvent: newest.representativeEvent,
      firstSeenAt: Math.min(a.firstSeenAt, b.firstSeenAt),
      lastSeenAt: Math.max(a.lastSeenAt, b.lastSeenAt),
      eventCount: a.eventCount + b.eventCount,
      riskyEventCount: a.riskyEventCount + b.riskyEventCount,
      sessionCount: sessionKeys.length,
      runCount: runKeys.length,
      traceCount: traceKeys.length,
      sessionKeys,
      runKeys,
      traceKeys,
      collectorKeys,
      eventsWithoutCollector: a.eventsWithoutCollector + b.eventsWithoutCollector,
      tokenCount: a.tokenCount + b.tokenCount,
      latencyTotal: a.latencyTotal + b.latencyTotal,
      instanceCount: instanceKeys.length,
      instanceKeys,
      worstSeverityRank: Math.max(a.worstSeverityRank, b.worstSeverityRank),
      topRiskAt: latestRisk.topRiskAt,
      topRiskCategory: latestRisk.topRiskCategory,
      topRiskName: latestRisk.topRiskName,
      eventCategoryCounts,
      sourceCounts,
      hasPhysicalIdentity: a.hasPhysicalIdentity || b.hasPhysicalIdentity,
      hasRootIdentity: a.hasRootIdentity || b.hasRootIdentity,
    };
  }

  async storedAgentInventory(filter: T.AgentInventoryQuery): Promise<T.AgentInventory> {
    if (!this.judge.storageStatus().clickhouseReady) return this.agentInventory(filter);
    const window = resolveTimeWindow(filter);
    const committedCutoffMs = this.judge.committedEventCutoffMs();
    if (committedCutoffMs === undefined) return this.agentInventory(filter);
    const plan = planDashboardRead(window.startMs, window.endMs, committedCutoffMs);
    const persistedUntilMs = plan.persistedUntilMs ?? window.endMs;
    const hotEvents = foldLatestEventRevisions(
      this.judge.queryRange(plan.hotFromMs, window.endMs)
        .filter((event) => filter.scope !== 'agent' || event.attribution?.monitored === true),
    );
    const overlapEventIds = hotEvents
      .filter((event) => event.at <= persistedUntilMs)
      .map((event) => event.eventId);
    let persisted: StoredAgentWindowFact[] | null;
    const slices = reusableFactSlices(window.startMs, persistedUntilMs, plan.hotFromMs);
    if (
      !window.custom &&
      window.spanMs <= 24 * HOUR &&
      slices.fullEndExclusiveMs > slices.fullStartMs
    ) {
      const scope = filter.scope === 'agent' ? 'agent' : 'all';
      let cache = this.agentHistoryBuckets.get(scope);
      if (!cache) {
        cache = new CommitAwareFactBucketCache<StoredAgentBucketFact>({
          latestCursor: () => this.judge.latestEventCommitCursor(),
          earliestCursor: () => this.judge.earliestEventCommitCursor(),
          changes: (after) => this.judge.eventCommitChanges(after),
          facts: (startMs, endExclusiveMs, bucketMs) =>
            this.historyQueryGate.run(() =>
              this.judge.agentWindowBucketFacts(
                startMs,
                endExclusiveMs,
                bucketMs,
                scope === 'agent',
              ),
            ),
        });
        this.agentHistoryBuckets.set(scope, cache);
      }
      const [stableFacts, headFacts, tailFacts] = await Promise.all([
        cache.read(slices.fullStartMs, slices.fullEndExclusiveMs).catch((error) => {
          console.warn(
            `[agents] reusable history unavailable; using exact fallback: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return null;
        }),
        slices.head
          ? this.historyQueryGate.run(() =>
              this.judge.agentWindowFacts(
                slices.head!.startMs,
                slices.head!.endMs,
                scope === 'agent',
                overlapEventIds,
              ),
            )
          : Promise.resolve([]),
        slices.tail
          ? this.historyQueryGate.run(() =>
              this.judge.agentWindowFacts(
                slices.tail!.startMs,
                slices.tail!.endMs,
                scope === 'agent',
                overlapEventIds,
              ),
            )
          : Promise.resolve([]),
      ]);
      persisted = stableFacts && headFacts && tailFacts
        ? [...headFacts, ...stableFacts, ...tailFacts]
        : null;
      if (!persisted) {
        persisted = await this.historyQueryGate.run(() =>
          this.judge.agentWindowFacts(
            window.startMs,
            persistedUntilMs,
            filter.scope === 'agent',
            overlapEventIds,
          ),
        );
      }
    } else {
      persisted = await this.historyQueryGate.run(() =>
        this.judge.agentWindowFacts(
          window.startMs,
          persistedUntilMs,
          filter.scope === 'agent',
          overlapEventIds,
        ),
      );
    }
    if (!persisted) return this.agentInventory(filter);

    const allFacts = [
      ...persisted,
      ...hotEvents.map((event) => this.agentFactForEvent(event)),
    ];
    const factsByInstance = new Map<string, StoredAgentWindowFact>();
    for (const fact of allFacts) {
      const assetId = this.agentMetadata.resolveEvent(fact.representativeEvent).agentAssetId;
      const instanceId = agentRuntimeInstanceIdForEvent(fact.representativeEvent);
      const groupKey = agentInventoryGroupKey(assetId, instanceId);
      const current = factsByInstance.get(groupKey);
      factsByInstance.set(groupKey, current ? this.mergeAgentFacts(current, fact) : fact);
    }
    const result = this.agentInventoryFromEvents(
      filter,
      [...factsByInstance.values()].map((fact) => fact.representativeEvent),
      factsByInstance,
    );
    result.coverage = this.queryCoverage(filter, [...factsByInstance.values()].map((fact) => fact.representativeEvent), {
      source: hotEvents.length ? 'clickhouse+hot_delta' : 'clickhouse',
      totalMode: 'exact',
      partial: false,
      committedCutoffMs,
      dataFromMs: allFacts.length ? Math.min(...allFacts.map((fact) => fact.firstSeenAt)) : undefined,
      dataToMs: allFacts.length ? Math.max(...allFacts.map((fact) => fact.lastSeenAt)) : undefined,
    });
    return result;
  }

  private agentInventoryFromEvents(
    filter: T.AgentInventoryQuery,
    events: T.JudgedEvent[],
    factsByInstance?: Map<string, StoredAgentWindowFact>,
  ): T.AgentInventory {
    const q = filter.q?.trim().toLowerCase();
    const owner = filter.owner?.trim().toLowerCase();
    const environment = filter.environment?.trim().toLowerCase();
    const tag = filter.tag?.trim().toLowerCase();
    const agentId = filter.agentId?.trim();
    const requestedAgentAssetId = filter.agentAssetId?.trim();
    const agentAssetId = requestedAgentAssetId
      ? this.agentMetadata.canonicalAgentAssetId(requestedAgentAssetId)
      : undefined;
    const agentInstanceId = filter.agentInstanceId?.trim();
    const workspacePath = filter.workspacePath?.trim();
    const hasFilter = Boolean((filter.healthState && filter.healthState !== 'all') || (filter.criticality && filter.criticality !== 'all') || owner || environment || tag || q || filter.userId);
    const shouldScopeExactAgent = Boolean((agentAssetId || agentId || agentInstanceId) && !hasFilter);
    const byAgent = new Map<string, T.JudgedEvent[]>();
    for (const e of events) {
      if (shouldScopeExactAgent && !agentAssetId && agentId && e.agentId !== agentId && e.attribution?.agentScopeId !== agentId) continue;
      // A canonical asset selection identifies the workload. Legacy display fields must not
      // reject its raw events before metadata/alias resolution.
      if (!agentAssetId && workspacePath && e.workspacePath !== workspacePath) continue;
      if (!agentId && filter.userId && e.userId !== filter.userId) continue;
      const resolved = this.agentMetadata.resolveEvent(e);
      if (agentAssetId && resolved.agentAssetId !== agentAssetId) continue;
      const runtimeInstanceId = agentRuntimeInstanceIdForEvent(e);
      if (agentInstanceId && runtimeInstanceId !== agentInstanceId) continue;
      const groupKey = agentInventoryGroupKey(resolved.agentAssetId, runtimeInstanceId);
      (byAgent.get(groupKey) ?? byAgent.set(groupKey, []).get(groupKey)!).push(e);
    }

    const openIncidents = new Map<string, number>();
    for (const incident of this.judge.listIncidents(0)) {
      if (incident.status !== 'open') continue;
      if (filter.scope === 'agent' && incident.monitored !== true) continue;
      const key = `${incident.workspacePath}\0${incident.agentId}`;
      openIncidents.set(key, (openIncidents.get(key) ?? 0) + 1);
    }

    const t = now();
    const visibleAgentGroups = [...byAgent.entries()].filter(([groupKey, evs]) => {
      if (shouldScopeExactAgent) return true;
      const identityEvent =
        [...evs].reverse().find((event) => Boolean(event.attribution?.classification)) ??
        evs.at(-1);
      if (!identityEvent) return false;
      const resolved = this.agentMetadata.resolveEvent(identityEvent);
      if (resolved.effectiveClassification !== 'probable_agent') return true;
      if (resolved.metadata?.reviewDecision) return true;
      if (
        resolved.metadata?.displayName ||
        resolved.metadata?.owner ||
        resolved.metadata?.team ||
        resolved.metadata?.environment ||
        resolved.metadata?.note ||
        resolved.metadata?.tags?.length
      ) return true;
      const fact = factsByInstance?.get(groupKey);
      if (fact?.hasPhysicalIdentity || evs.some((event) =>
        Boolean(
          event.attribution?.physicalWorkloadId ||
          event.attribution?.agentInstanceId ||
          event.attribution?.workloadRef?.podUid,
        )
      )) return true;
      if (
        (
          fact?.hasRootIdentity &&
          Boolean(fact.representativeEvent.attribution?.rootStartTime) &&
          hasDirectAgentRootEvidence(fact.representativeEvent)
        ) ||
        evs.some((event) =>
          Boolean(event.attribution?.rootStartTime) && hasDirectAgentRootEvidence(event)
        )
      ) return true;
      return evs.some((event) =>
        ['self_register', 'manual_review']
          .includes(event.attribution?.source ?? '')
      );
    });

    const logicalInstanceCounts = new Map<string, number>();
    for (const [, evs] of visibleAgentGroups) {
      const identityEvent = evs.at(-1);
      if (!identityEvent) continue;
      const assetId = this.agentMetadata.resolveEvent(identityEvent).agentAssetId;
      logicalInstanceCounts.set(assetId, (logicalInstanceCounts.get(assetId) ?? 0) + 1);
    }

    const eventBackedItems = visibleAgentGroups.map(([groupKey, evs]): T.AgentInventoryItem => {
      const sorted = [...evs].sort((a, b) => a.at - b.at);
      const fact = factsByInstance?.get(groupKey);
      const first = sorted[0];
      const last = sorted[sorted.length - 1];
      const risky = sorted.filter((e) => e.verdict !== 'allow');
      const lvl = fact
        ? levelByRank(fact.worstSeverityRank)
        : worstLevel(sorted);
      const identityEvent =
        [...sorted].reverse().find((event) => Boolean(event.attribution?.classification)) ??
        last;
      const resolved = this.agentMetadata.resolveEvent(identityEvent);
      const assetId = resolved.agentAssetId;
      const detected = detectedAgentIdentity(identityEvent);
      const metadata = resolved.metadata;
      const attribution = identityEvent.attribution;
      const classification = resolved.effectiveClassification;
      const reviewed = Boolean(metadata?.reviewDecision);
      const itemAgentId =
        attribution?.agentScopeId ??
        attribution?.agentDisplayName ??
        detected.detectedName ??
        last.agentId;
      const itemWorkspacePath = last.workspacePath;
      const incidentKeys = new Set(sorted.map((event) => `${event.workspacePath}\0${event.agentId}`));
      const openIncidentCount = [...incidentKeys].reduce(
        (total, incidentKey) => total + (openIncidents.get(incidentKey) ?? 0),
        0,
      );
      const sinceLast = t - (fact?.lastSeenAt ?? last.at);
      const rootExit = [...sorted].reverse().find((event) =>
        event.eventKind === 'ProcessExit' &&
        Boolean(event.attribution?.rootPid) &&
        event.process?.pid === event.attribution?.rootPid
      );
      const terminatedAt = rootExit && !sorted.some((event) => event.at > rootExit.at)
        ? rootExit.at
        : undefined;
      const lifecycleState: T.AgentLifecycleState = terminatedAt !== undefined
        ? 'terminated'
        : sinceLast <= ACTIVE_MS
          ? 'current'
          : 'historical';
      const healthState: T.AgentHealthState = openIncidentCount > 0
        ? 'risky'
        : sinceLast <= ACTIVE_MS
          ? 'active'
          : sinceLast <= STALE_MS
            ? 'idle'
            : 'stale';
      const categoryCounts = Object.fromEntries(EVENT_CATEGORIES.map((category) => [
        category,
        fact?.eventCategoryCounts[category] ?? 0,
      ])) as Record<T.EventCategory, number>;
      const sourceCounts = Object.fromEntries(EVENT_SOURCES.map((source) => [
        source,
        fact?.sourceCounts[source] ?? 0,
      ])) as Record<T.EventSource, number>;
      const topRisk = new Map<string, { count: number; name: string }>();
      if (!fact) {
        for (const e of sorted) {
          categoryCounts[e.eventCategory] = (categoryCounts[e.eventCategory] ?? 0) + 1;
          sourceCounts[e.source] = (sourceCounts[e.source] ?? 0) + 1;
          if (e.verdict !== 'allow') {
            const cur = topRisk.get(e.riskCategory);
            topRisk.set(e.riskCategory, { count: (cur?.count ?? 0) + 1, name: e.riskName });
          }
        }
      }
      const top = [...topRisk.entries()].sort((a, b) => b[1].count - a[1].count)[0];
      const runtimeInstanceId = agentRuntimeInstanceIdForEvent(identityEvent);
      return {
        agentId: itemAgentId,
        agentAssetId: assetId,
        agentAssetAliases: metadata?.agentAssetAliases,
        workspacePath: itemWorkspacePath,
        userId: last.userId,
        displayName: resolved.displayName,
        detectedName: resolved.detectedName,
        detectedClassification: resolved.detectedClassification,
        owner: metadata?.owner,
        team: metadata?.team,
        environment: metadata?.environment,
        criticality: metadata?.criticality,
        tags: metadata?.tags ?? [],
        note: metadata?.note,
        metadataUpdatedAt: metadata?.updatedAt ? iso(metadata.updatedAt) : undefined,
        classification,
        runtime: detected.runtime,
        locationLabel: detected.locationLabel,
        instanceCount: 1,
        logicalInstanceCount: logicalInstanceCounts.get(assetId) ?? 1,
        confidence: reviewed ? 1 : attribution?.confidence ?? 0,
        attributionSource: reviewed ? 'manual_review' : attribution?.source ?? 'none',
        attributionEvidence: reviewed
          ? [
              ...(attribution?.evidence ?? []),
              `manual_review:${metadata?.reviewDecision}`,
              ...(metadata?.reviewedBy ? [`manual_review:reviewer=${metadata.reviewedBy}`] : []),
            ].slice(-16)
          : attribution?.evidence ?? [],
        physicalWorkloadId: attribution?.physicalWorkloadId ?? metadata?.reviewPhysicalWorkloadId,
        agentInstanceId: runtimeInstanceId,
        workloadRef: attribution?.workloadRef ?? metadata?.reviewWorkloadRef,
        hostId: identityEvent.process?.hostId,
        bootId: identityEvent.process?.bootId,
        rootPid: attribution?.rootPid,
        rootStartTime: attribution?.rootStartTime,
        reviewDecision: metadata?.reviewDecision,
        reviewedBy: metadata?.reviewedBy,
        reviewedAt: metadata?.reviewedAt ? iso(metadata.reviewedAt) : undefined,
        reviewNote: metadata?.reviewNote,
        reviewIdentityKeys:
          metadata?.identityKeys ??
          metadata?.reviewIdentityKeys ??
          this.agentMetadata.identityKeysForEvent(identityEvent),
        firstSeen: iso(fact?.firstSeenAt ?? first.at),
        lastSeen: iso(fact?.lastSeenAt ?? last.at),
        lifecycleState,
        terminatedAt: terminatedAt !== undefined ? iso(terminatedAt) : undefined,
        healthState,
        riskLevel: lvl.level,
        riskLevelText: lvl.text,
        eventCount: fact?.eventCount ?? sorted.length,
        riskyEventCount: fact?.riskyEventCount ?? risky.length,
        openIncidentCount,
        sessionCount: fact?.sessionCount ?? distinct(sorted.map((e) => e.sessionId)),
        runCount: fact?.runCount ?? distinct(sorted.map((e) => e.runId)),
        traceCount: fact?.traceCount ?? distinct(sorted.map((e) => e.traceId)),
        tokenCount: fact?.tokenCount ?? sorted.reduce((a, e) => a + e.tokenCount, 0),
        avgLatencyMs: fact
          ? Math.round(fact.latencyTotal / Math.max(1, fact.eventCount))
          : Math.round(mean(sorted.map((e) => e.latencyMs))),
        topRiskCategory: fact?.topRiskCategory ?? top?.[0],
        topRiskName: fact?.topRiskName ?? top?.[1].name,
        lastEventSubject: last.subject,
        lastEventId: last.eventId,
        collectorIds: fact?.collectorKeys ?? [...new Set(sorted.map(eventCollectorId).filter(Boolean))],
        eventsWithoutCollector: fact?.eventsWithoutCollector ?? sorted.filter((event) => !eventCollectorId(event)).length,
        eventCategoryCounts: categoryCounts,
        sourceCounts,
      };
    });

    const eventBackedAssetIds = new Set(eventBackedItems.map((item) => item.agentAssetId));
    const metadataOnlyItems = this.agentMetadata.list()
      .filter((metadata) =>
        (
          isAgentAssetClassification(metadata.reviewDecision ?? 'unknown') ||
          Boolean(filter.includeUnclassified && (agentAssetId || agentId))
        ) &&
        !eventBackedAssetIds.has(metadata.agentAssetId) &&
        !agentInstanceId &&
        (
          !shouldScopeExactAgent ||
          (agentAssetId ? metadata.agentAssetId === agentAssetId : metadata.agentId === agentId)
        ) &&
        (!agentAssetId || metadata.agentAssetId === agentAssetId) &&
        (!workspacePath || metadata.workspacePath === workspacePath) &&
        !filter.userId
      )
      .map((metadata): T.AgentInventoryItem => {
        const categoryCounts = Object.fromEntries(EVENT_CATEGORIES.map((category) => [category, 0])) as Record<T.EventCategory, number>;
        const sourceCounts = Object.fromEntries(EVENT_SOURCES.map((source) => [source, 0])) as Record<T.EventSource, number>;
        return {
          agentId: metadata.agentId,
          agentAssetId: metadata.agentAssetId,
          agentAssetAliases: metadata.agentAssetAliases,
          workspacePath: metadata.workspacePath,
          userId: '-',
          displayName: metadata.displayName,
          detectedName: metadata.agentId,
          detectedClassification: 'unknown',
          owner: metadata.owner,
          team: metadata.team,
          environment: metadata.environment,
          criticality: metadata.criticality,
          tags: metadata.tags,
          note: metadata.note,
          metadataUpdatedAt: metadata.updatedAt,
          classification: metadata.reviewDecision ?? 'unknown',
          runtime: metadata.workloadRef?.environment ?? metadata.reviewWorkloadRef?.environment ?? 'unknown',
          locationLabel: metadata.workspacePath,
          instanceCount: metadata.agentInstanceId || metadata.reviewAgentInstanceId ? 1 : 0,
          confidence: metadata.reviewDecision ? 1 : 0,
          attributionSource: metadata.reviewDecision ? 'manual_review' : 'none',
          attributionEvidence: metadata.reviewDecision
            ? [
                `manual_review:${metadata.reviewDecision}`,
                ...(metadata.reviewedBy ? [`manual_review:reviewer=${metadata.reviewedBy}`] : []),
              ]
            : [],
          physicalWorkloadId: metadata.physicalWorkloadId ?? metadata.reviewPhysicalWorkloadId,
          agentInstanceId: metadata.agentInstanceId ?? metadata.reviewAgentInstanceId,
          workloadRef: metadata.workloadRef ?? metadata.reviewWorkloadRef,
          reviewDecision: metadata.reviewDecision,
          reviewedBy: metadata.reviewedBy,
          reviewedAt: metadata.reviewedAt,
          reviewNote: metadata.reviewNote,
          reviewIdentityKeys: metadata.identityKeys ?? metadata.reviewIdentityKeys ?? [metadata.agentId.toLowerCase()],
          firstSeen: metadata.updatedAt,
          lastSeen: metadata.updatedAt,
          lifecycleState: 'historical',
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
          collectorIds: [],
          eventsWithoutCollector: 0,
          eventCategoryCounts: categoryCounts,
          sourceCounts,
        };
      });

    const items = [...eventBackedItems, ...metadataOnlyItems];

    const filtered = items
      .filter((item) => {
        const matchesInstance = !agentInstanceId || item.agentInstanceId === agentInstanceId;
        const matchesAgentId = Boolean(
          matchesInstance && (
            (agentAssetId && item.agentAssetId === agentAssetId) ||
            (agentId && item.agentId === agentId && (!workspacePath || item.workspacePath === workspacePath))
          ),
        );
        if (
          !isAgentAssetClassification(item.classification) &&
          !(filter.includeUnclassified && matchesAgentId)
        ) {
          return false;
        }
        const matchesFilter =
          (!filter.healthState || filter.healthState === 'all' || item.healthState === filter.healthState) &&
          (!filter.criticality || filter.criticality === 'all' || item.criticality === filter.criticality) &&
          (!owner || (item.owner ?? '').toLowerCase().includes(owner)) &&
          (!environment || (item.environment ?? '').toLowerCase().includes(environment)) &&
          (!tag || item.tags.some((value) => value.toLowerCase().includes(tag))) &&
          (!q || [
            item.agentId,
            item.agentAssetId,
            item.agentInstanceId,
            item.displayName,
            item.detectedName,
            item.locationLabel,
            item.workspacePath,
            item.hostId,
            item.bootId,
            item.rootPid !== undefined ? String(item.rootPid) : undefined,
            item.rootStartTime,
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
        if ((agentAssetId || agentId) && !hasFilter) return matchesAgentId;
        return matchesAgentId || matchesFilter;
      })
      .sort((a, b) => {
        const classificationRank: Record<T.AgentClassification, number> = {
          confirmed_agent: 0,
          probable_agent: 1,
          unknown: 2,
          non_agent: 3,
        };
        const riskRank: Record<string, number> = {
          critical: 4,
          high: 3,
          medium: 2,
          low: 1,
          safe: 0,
          unknown: 0,
        };
        const aSelected = Boolean(
          (!agentInstanceId || a.agentInstanceId === agentInstanceId) &&
          (
            (agentAssetId && a.agentAssetId === agentAssetId) ||
            (agentId && a.agentId === agentId && (!workspacePath || a.workspacePath === workspacePath))
          ),
        );
        const bSelected = Boolean(
          (!agentInstanceId || b.agentInstanceId === agentInstanceId) &&
          (
            (agentAssetId && b.agentAssetId === agentAssetId) ||
            (agentId && b.agentId === agentId && (!workspacePath || b.workspacePath === workspacePath))
          ),
        );
        return Number(bSelected) - Number(aSelected)
          || classificationRank[a.classification] - classificationRank[b.classification]
          || (riskRank[b.riskLevel] ?? 0) - (riskRank[a.riskLevel] ?? 0)
          || b.openIncidentCount - a.openIncidentCount
          || b.riskyEventCount - a.riskyEventCount
          || Date.parse(b.lastSeen) - Date.parse(a.lastSeen)
          || (a.displayName ?? a.detectedName ?? a.agentId).localeCompare(b.displayName ?? b.detectedName ?? b.agentId)
          || a.agentAssetId.localeCompare(b.agentAssetId)
          || (a.agentInstanceId ?? '').localeCompare(b.agentInstanceId ?? '');
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
    return {
      items: filtered.slice(0, limit),
      total: filtered.length,
      summary,
      coverage: this.queryCoverage(filter, events, {
        source: 'memory_hot_ring',
        totalMode: 'exact',
        partial: true,
        partialReason: 'hot_ring_only',
      }),
      updateTime: iso(),
    };
  }

  agentInstanceMetrics(filter: T.AgentInstanceMetricsQuery): T.AgentInstanceMetrics {
    const requestedAgentAssetId = filter.agentAssetId?.trim();
    const agentAssetId = requestedAgentAssetId
      ? this.agentMetadata.canonicalAgentAssetId(requestedAgentAssetId)
      : '';
    const agentInstanceId = filter.agentInstanceId?.trim();
    const cacheKey = [
      agentAssetId,
      agentInstanceId ?? '',
      filter.timeType ?? '',
      filter.startTime ?? '',
      filter.endTime ?? '',
      filter.seriesPoints ?? 36,
      this.agentMetadata.identitySnapshotVersion(),
    ].join('\0');
    const cached = this.agentInstanceMetricsCache.get(cacheKey);
    if (cached && now() - cached.at < 15_000) return cached.value;
    const window = this.win(filter);
    const events = agentAssetId
      ? window.events.filter((event) =>
          this.agentMetadata.resolveEvent(event).agentAssetId === agentAssetId &&
          (!agentInstanceId || agentRuntimeInstanceIdForEvent(event) === agentInstanceId)
        )
      : [];
    const pointCount = Math.max(12, Math.min(72, filter.seriesPoints ?? 36));
    const bucketSize = window.spanMs / pointCount || 1;
    const buckets = this.buckets(events, window.sinceMs, window.spanMs, pointCount);
    const points = buckets.map((bucket, index): T.AgentInstanceMetricPoint => {
      const latencies = bucket
        .map((event) => event.latencyMs)
        .filter((value) => Number.isFinite(value) && value >= 0);
      return {
        statTime: iso(window.sinceMs + index * bucketSize),
        eventCount: bucket.length,
        riskyEventCount: bucket.filter((event) => event.verdict !== 'allow').length,
        blockedCount: bucket.filter((event) => event.verdict === 'block').length,
        escalatedCount: bucket.filter((event) => event.verdict === 'escalate').length,
        toolCount: bucket.filter((event) => event.eventCategory === 'tool').length,
        fileCount: bucket.filter((event) => event.eventCategory === 'file').length,
        networkCount: bucket.filter((event) => event.eventCategory === 'network').length,
        processCount: bucket.filter((event) => event.eventCategory === 'process' || event.eventCategory === 'runtime').length,
        llmCount: bucket.filter((event) => event.eventCategory === 'llm').length,
        l1Count: bucket.filter((event) => event.tier === 'Rules').length,
        l2Count: bucket.filter((event) => event.tier === 'Llm').length,
        l3Count: bucket.filter((event) => event.tier === 'Agent').length,
        failedCount: bucket.filter((event) => event.decisionStatus === 'failed').length,
        timeoutCount: bucket.filter((event) => event.decisionStatus === 'timeout').length,
        tokenCount: bucket.reduce((total, event) => total + event.tokenCount, 0),
        avgLatencyMs: Math.round(mean(latencies)),
        maxRiskScore: bucket.length ? Math.max(...bucket.map((event) => event.riskScore)) : 0,
      };
    });
    const latencies = events
      .map((event) => event.latencyMs)
      .filter((value) => Number.isFinite(value) && value >= 0);
    const value: T.AgentInstanceMetrics = {
      agentAssetId,
      points,
      eventCount: events.length,
      riskyEventCount: events.filter((event) => event.verdict !== 'allow').length,
      blockedCount: events.filter((event) => event.verdict === 'block').length,
      escalatedCount: events.filter((event) => event.verdict === 'escalate').length,
      tokenCount: events.reduce((total, event) => total + event.tokenCount, 0),
      avgLatencyMs: Math.round(mean(latencies)),
      failedCount: events.filter((event) => event.decisionStatus === 'failed').length,
      timeoutCount: events.filter((event) => event.decisionStatus === 'timeout').length,
      updateTime: iso(),
    };
    this.agentInstanceMetricsCache.set(cacheKey, { at: now(), value });
    if (this.agentInstanceMetricsCache.size > 256) {
      const oldestKey = [...this.agentInstanceMetricsCache.entries()]
        .sort((a, b) => a[1].at - b[1].at)[0]?.[0];
      if (oldestKey) this.agentInstanceMetricsCache.delete(oldestKey);
    }
    return value;
  }

  private metricFactForEvent(
    event: T.JudgedEvent,
    bucketIndex: number,
    recentSinceMs: number,
  ): StoredAgentMetricBucketFact {
    const recent = event.at > recentSinceMs;
    return {
      bucketIndex,
      identityKey: event.eventId,
      representativeEvent: event,
      eventCount: 1,
      riskyEventCount: event.verdict !== 'allow' ? 1 : 0,
      blockedCount: event.verdict === 'block' ? 1 : 0,
      escalatedCount: event.verdict === 'escalate' ? 1 : 0,
      toolCount: event.eventCategory === 'tool' ? 1 : 0,
      fileCount: event.eventCategory === 'file' ? 1 : 0,
      networkCount: event.eventCategory === 'network' ? 1 : 0,
      processCount: event.eventCategory === 'process' || event.eventCategory === 'runtime' ? 1 : 0,
      llmCount: event.eventCategory === 'llm' ? 1 : 0,
      l1Count: event.tier === 'Rules' ? 1 : 0,
      l2Count: event.tier === 'Llm' ? 1 : 0,
      l3Count: event.tier === 'Agent' ? 1 : 0,
      failedCount: event.decisionStatus === 'failed' ? 1 : 0,
      timeoutCount: event.decisionStatus === 'timeout' ? 1 : 0,
      tokenCount: event.tokenCount,
      latencyTotal: event.latencyMs,
      maxRiskScore: event.riskScore,
      sessionKeys: [event.sessionId],
      recentEventCount: recent ? 1 : 0,
      recentCommCount: recent && (event.eventKind === 'Egress' || event.eventKind === 'Dns') ? 1 : 0,
      recentSessionKeys: recent ? [event.sessionId] : [],
    };
  }

  private async storedAgentMetricFacts(
    filter: T.SecurityTimeFilter,
    bucketCount: number,
  ): Promise<{
    facts: StoredAgentMetricBucketFact[];
    coverage: T.QueryCoverage;
  } | null> {
    if (!this.judge.storageStatus().clickhouseReady) return null;
    const window = resolveTimeWindow(filter);
    const pointCount = Math.max(1, Math.min(72, Math.round(bucketCount)));
    const bucketSize = window.spanMs / pointCount || 1;
    const committedCutoffMs = this.judge.committedEventCutoffMs();
    if (committedCutoffMs === undefined) return null;
    const plan = planDashboardRead(window.startMs, window.endMs, committedCutoffMs);
    const persistedUntilMs = plan.persistedUntilMs ?? window.endMs;
    const hotEvents = foldLatestEventRevisions(
      this.judge.queryRange(plan.hotFromMs, window.endMs)
        .filter((event) => filter.scope !== 'agent' || isMonitoredAgentEvent(event)),
    );
    const overlapEventIds = hotEvents
      .filter((event) => event.at <= persistedUntilMs)
      .map((event) => event.eventId);
    const persisted = await this.judge.agentMetricBucketFacts(
      window.startMs,
      persistedUntilMs,
      pointCount,
      filter.scope === 'agent',
      overlapEventIds,
    );
    if (!persisted) return null;
    const recentSinceMs = Math.max(window.startMs, window.endMs - 60_000);
    const hotFacts = hotEvents.map((event) => this.metricFactForEvent(
      event,
      Math.min(pointCount - 1, Math.max(0, Math.floor((event.at - window.startMs) / bucketSize))),
      recentSinceMs,
    ));
    const facts = [...persisted, ...hotFacts];
    return {
      facts,
      coverage: this.queryCoverage(filter, facts.map((fact) => fact.representativeEvent), {
        source: hotEvents.length ? 'clickhouse+hot_delta' : 'clickhouse',
        totalMode: 'exact',
        partial: false,
        committedCutoffMs,
      }),
    };
  }

  async storedAgentInstanceMetrics(filter: T.AgentInstanceMetricsQuery): Promise<T.AgentInstanceMetrics> {
    const requestedAgentAssetId = filter.agentAssetId?.trim();
    const agentAssetId = requestedAgentAssetId
      ? this.agentMetadata.canonicalAgentAssetId(requestedAgentAssetId)
      : '';
    const agentInstanceId = filter.agentInstanceId?.trim();
    const pointCount = Math.max(12, Math.min(72, filter.seriesPoints ?? 36));
    const cacheKey = [
      'durable',
      agentAssetId,
      agentInstanceId ?? '',
      filter.timeType ?? '',
      filter.startTime ?? '',
      filter.endTime ?? '',
      pointCount,
      this.agentMetadata.identitySnapshotVersion(),
    ].join('\0');
    const cached = this.agentInstanceMetricsCache.get(cacheKey);
    if (cached && now() - cached.at < 15_000) return cached.value;
    const durable = await this.storedAgentMetricFacts({ ...filter, scope: 'agent' }, pointCount);
    if (!durable) return this.agentInstanceMetrics(filter);
    const window = resolveTimeWindow(filter);
    const bucketSize = window.spanMs / pointCount || 1;
    const selected = durable.facts.filter((fact) =>
      agentAssetId &&
      this.agentMetadata.resolveEvent(fact.representativeEvent).agentAssetId === agentAssetId &&
      (!agentInstanceId || agentRuntimeInstanceIdForEvent(fact.representativeEvent) === agentInstanceId),
    );
    const bucketFacts = Array.from({ length: pointCount }, () => [] as StoredAgentMetricBucketFact[]);
    for (const fact of selected) {
      if (fact.bucketIndex >= 0 && fact.bucketIndex < pointCount) bucketFacts[fact.bucketIndex].push(fact);
    }
    const points = bucketFacts.map((facts, index): T.AgentInstanceMetricPoint => {
      const eventCount = facts.reduce((sum, fact) => sum + fact.eventCount, 0);
      return {
        statTime: iso(window.startMs + index * bucketSize),
        eventCount,
        riskyEventCount: facts.reduce((sum, fact) => sum + fact.riskyEventCount, 0),
        blockedCount: facts.reduce((sum, fact) => sum + fact.blockedCount, 0),
        escalatedCount: facts.reduce((sum, fact) => sum + fact.escalatedCount, 0),
        toolCount: facts.reduce((sum, fact) => sum + fact.toolCount, 0),
        fileCount: facts.reduce((sum, fact) => sum + fact.fileCount, 0),
        networkCount: facts.reduce((sum, fact) => sum + fact.networkCount, 0),
        processCount: facts.reduce((sum, fact) => sum + fact.processCount, 0),
        llmCount: facts.reduce((sum, fact) => sum + fact.llmCount, 0),
        l1Count: facts.reduce((sum, fact) => sum + fact.l1Count, 0),
        l2Count: facts.reduce((sum, fact) => sum + fact.l2Count, 0),
        l3Count: facts.reduce((sum, fact) => sum + fact.l3Count, 0),
        failedCount: facts.reduce((sum, fact) => sum + fact.failedCount, 0),
        timeoutCount: facts.reduce((sum, fact) => sum + fact.timeoutCount, 0),
        tokenCount: facts.reduce((sum, fact) => sum + fact.tokenCount, 0),
        avgLatencyMs: Math.round(facts.reduce((sum, fact) => sum + fact.latencyTotal, 0) / (eventCount || 1)),
        maxRiskScore: Math.max(0, ...facts.map((fact) => fact.maxRiskScore)),
      };
    });
    const eventCount = selected.reduce((sum, fact) => sum + fact.eventCount, 0);
    const value: T.AgentInstanceMetrics = {
      agentAssetId,
      points,
      eventCount,
      riskyEventCount: selected.reduce((sum, fact) => sum + fact.riskyEventCount, 0),
      blockedCount: selected.reduce((sum, fact) => sum + fact.blockedCount, 0),
      escalatedCount: selected.reduce((sum, fact) => sum + fact.escalatedCount, 0),
      tokenCount: selected.reduce((sum, fact) => sum + fact.tokenCount, 0),
      avgLatencyMs: Math.round(selected.reduce((sum, fact) => sum + fact.latencyTotal, 0) / (eventCount || 1)),
      failedCount: selected.reduce((sum, fact) => sum + fact.failedCount, 0),
      timeoutCount: selected.reduce((sum, fact) => sum + fact.timeoutCount, 0),
      coverage: durable.coverage,
      updateTime: iso(window.endMs),
    };
    this.agentInstanceMetricsCache.set(cacheKey, { at: now(), value });
    return value;
  }

  private workspaceFactForEvent(event: T.JudgedEvent): StoredWorkspaceWindowFact {
    const risky = event.verdict !== 'allow';
    const collectorId = eventCollectorId(event);
    const resolvedWorkspacePath =
      this.agentMetadata.resolveEvent(event).metadata?.workspacePath ??
      attributionWorkspacePath(event);
    return {
      workspacePath: resolvedWorkspacePath,
      representativeEvent: event,
      firstSeenAt: event.at,
      lastSeenAt: event.at,
      eventCount: 1,
      riskyEventCount: risky ? 1 : 0,
      sessionKeys: [event.sessionId],
      runKeys: [event.runId],
      traceKeys: [event.traceId],
      collectorKeys: collectorId ? [collectorId] : [],
      tokenCount: event.tokenCount,
      latencyTotal: event.latencyMs,
      worstSeverityRank: risky ? SEV_RANK[event.severity] : 0,
      topRiskAt: risky ? event.at : undefined,
      topRiskCategory: risky ? event.riskCategory : undefined,
      topRiskName: risky ? event.riskName : undefined,
    };
  }

  private mergeWorkspaceFacts(
    a: StoredWorkspaceWindowFact,
    b: StoredWorkspaceWindowFact,
  ): StoredWorkspaceWindowFact {
    const newest = a.lastSeenAt >= b.lastSeenAt ? a : b;
    const latestRisk = (b.topRiskAt ?? 0) >= (a.topRiskAt ?? 0) ? b : a;
    return {
      workspacePath: newest.workspacePath,
      representativeEvent: newest.representativeEvent,
      firstSeenAt: Math.min(a.firstSeenAt, b.firstSeenAt),
      lastSeenAt: Math.max(a.lastSeenAt, b.lastSeenAt),
      eventCount: a.eventCount + b.eventCount,
      riskyEventCount: a.riskyEventCount + b.riskyEventCount,
      sessionKeys: [...new Set([...a.sessionKeys, ...b.sessionKeys])],
      runKeys: [...new Set([...a.runKeys, ...b.runKeys])],
      traceKeys: [...new Set([...a.traceKeys, ...b.traceKeys])],
      collectorKeys: [...new Set([...a.collectorKeys, ...b.collectorKeys])],
      tokenCount: a.tokenCount + b.tokenCount,
      latencyTotal: a.latencyTotal + b.latencyTotal,
      worstSeverityRank: Math.max(a.worstSeverityRank, b.worstSeverityRank),
      topRiskAt: latestRisk.topRiskAt,
      topRiskCategory: latestRisk.topRiskCategory,
      topRiskName: latestRisk.topRiskName,
    };
  }

  async storedWorkspaceInventory(filter: T.WorkspaceInventoryQuery): Promise<T.WorkspaceInventory> {
    if (!this.judge.storageStatus().clickhouseReady) return this.workspaceInventory(filter);
    const window = resolveTimeWindow(filter);
    const committedCutoffMs = this.judge.committedEventCutoffMs();
    if (committedCutoffMs === undefined) return this.workspaceInventory(filter);
    const plan = planDashboardRead(window.startMs, window.endMs, committedCutoffMs);
    const persistedUntilMs = plan.persistedUntilMs ?? window.endMs;
    const hotEvents = foldLatestEventRevisions(
      this.judge.queryRange(plan.hotFromMs, window.endMs)
        .filter((event) => filter.scope !== 'agent' || event.attribution?.monitored === true),
    );
    const overlapEventIds = hotEvents
      .filter((event) => event.at <= persistedUntilMs)
      .map((event) => event.eventId);
    const scope = filter.scope === 'agent' ? 'agent' : 'all';
    const slices = reusableFactSlices(window.startMs, persistedUntilMs, plan.hotFromMs);
    let persisted: StoredWorkspaceWindowFact[] | null = null;
    if (
      !window.custom &&
      window.spanMs <= 24 * HOUR &&
      slices.fullEndExclusiveMs > slices.fullStartMs
    ) {
      let cache = this.workspaceHistoryBuckets.get(scope);
      if (!cache) {
        cache = new CommitAwareFactBucketCache<StoredWorkspaceBucketFact>({
          latestCursor: () => this.judge.latestEventCommitCursor(),
          earliestCursor: () => this.judge.earliestEventCommitCursor(),
          changes: (cursor) => this.judge.eventCommitChanges(cursor),
          facts: (startMs, endExclusiveMs) => this.historyQueryGate.run(() =>
            this.judge.workspaceWindowBucketFacts(
              startMs,
              endExclusiveMs,
              REUSABLE_BUCKET_MS,
              scope === 'agent',
            ),
          ),
        }, REUSABLE_BUCKET_MS);
        this.workspaceHistoryBuckets.set(scope, cache);
      }
      const [reusableFacts, headFacts, tailFacts] = await Promise.all([
        cache.read(slices.fullStartMs, slices.fullEndExclusiveMs).catch((error) => {
          console.error('[aggregation] reusable workspace history failed:', (error as Error).message);
          return null;
        }),
        slices.head
          ? this.historyQueryGate.run(() =>
              this.judge.workspaceWindowFacts(
                slices.head!.startMs,
                slices.head!.endMs,
                scope === 'agent',
                overlapEventIds,
              ),
            )
          : Promise.resolve([]),
        slices.tail
          ? this.historyQueryGate.run(() =>
              this.judge.workspaceWindowFacts(
                slices.tail!.startMs,
                slices.tail!.endMs,
                scope === 'agent',
                overlapEventIds,
              ),
            )
          : Promise.resolve([]),
      ]);
      if (reusableFacts && headFacts && tailFacts) {
        persisted = [...headFacts, ...reusableFacts, ...tailFacts];
      }
    }
    if (!persisted) {
      // Custom ranges retain the exact query path; presets reuse their aligned interior.
      persisted = await this.historyQueryGate.run(() =>
        this.judge.workspaceWindowFacts(
          window.startMs,
          persistedUntilMs,
          scope === 'agent',
          overlapEventIds,
        ),
      );
    }
    if (!persisted) return this.workspaceInventory(filter);

    const factsByWorkspace = new Map<string, StoredWorkspaceWindowFact>();
    for (const fact of [...persisted, ...hotEvents.map((event) => this.workspaceFactForEvent(event))]) {
      const resolvedWorkspacePath =
        this.agentMetadata.resolveEvent(fact.representativeEvent).metadata?.workspacePath ??
        fact.workspacePath;
      const canonicalFact = resolvedWorkspacePath === fact.workspacePath
        ? fact
        : { ...fact, workspacePath: resolvedWorkspacePath };
      const current = factsByWorkspace.get(resolvedWorkspacePath);
      factsByWorkspace.set(
        resolvedWorkspacePath,
        current ? this.mergeWorkspaceFacts(current, canonicalFact) : canonicalFact,
      );
    }

    const q = filter.q?.trim().toLowerCase();
    const owner = filter.owner?.trim().toLowerCase();
    const environment = filter.environment?.trim().toLowerCase();
    const workspacePath = filter.workspacePath?.trim();
    const hasFilter = Boolean(
      (filter.healthState && filter.healthState !== 'all') ||
      (filter.criticality && filter.criticality !== 'all') ||
      owner ||
      environment ||
      q
    );
    const shouldScopeExactWorkspace = Boolean(workspacePath && !hasFilter);
    const agents = await this.storedAgentInventory({
      timeType: filter.timeType,
      startTime: filter.startTime,
      endTime: filter.endTime,
      scope: filter.scope,
      workspacePath: shouldScopeExactWorkspace ? workspacePath : undefined,
      limit: 500,
    });
    const byWorkspaceAgents = new Map<string, T.AgentInventoryItem[]>();
    for (const agent of agents.items) {
      if (shouldScopeExactWorkspace && agent.workspacePath !== workspacePath) continue;
      const current = byWorkspaceAgents.get(agent.workspacePath) ?? [];
      current.push(agent);
      byWorkspaceAgents.set(agent.workspacePath, current);
    }

    const workspaceKeys = new Set([...factsByWorkspace.keys(), ...byWorkspaceAgents.keys()]);
    const items = [...workspaceKeys].flatMap((key): T.WorkspaceInventoryItem[] => {
      if (shouldScopeExactWorkspace && key !== workspacePath) return [];
      const fact = factsByWorkspace.get(key);
      const wsAgents = byWorkspaceAgents.get(key) ?? [];
      if (!fact && !wsAgents.length) return [];
      const agentFirstSeen = wsAgents.map((agent) => Date.parse(agent.firstSeen)).filter(Number.isFinite);
      const agentLastSeen = wsAgents.map((agent) => Date.parse(agent.lastSeen)).filter(Number.isFinite);
      const firstMs = fact?.firstSeenAt ?? Math.min(...agentFirstSeen);
      const lastMs = fact?.lastSeenAt ?? Math.max(...agentLastSeen);
      const lvl = fact?.riskyEventCount
        ? levelByRank(fact.worstSeverityRank)
        : { level: 'safe', text: LEVEL_TEXT.safe };
      const maintenance = this.maintenance.activeFor({ workspacePath: key });
      const tags = [...new Set(wsAgents.flatMap((agent) => agent.tags ?? []))].slice(0, 24);
      const healthState: T.AgentHealthState = wsAgents.some((agent) => agent.healthState === 'risky')
        ? 'risky'
        : wsAgents.some((agent) => agent.healthState === 'active')
          ? 'active'
          : wsAgents.some((agent) => agent.healthState === 'idle')
            ? 'idle'
            : 'stale';
      const byLastSeen = [...wsAgents].sort((a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen));
      const eventCount = fact?.eventCount ?? wsAgents.reduce((sum, agent) => sum + agent.eventCount, 0);
      return [{
        workspaceId: this.workspaceDirectory.resolveWorkspaceId(key),
        workspacePath: key,
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
        openIncidentCount: wsAgents.reduce((sum, agent) => sum + agent.openIncidentCount, 0),
        collectorCount: fact?.collectorKeys.length ?? 0,
        eventCount,
        riskyEventCount: fact?.riskyEventCount ?? wsAgents.reduce((sum, agent) => sum + agent.riskyEventCount, 0),
        sessionCount: fact?.sessionKeys.length ?? wsAgents.reduce((sum, agent) => sum + agent.sessionCount, 0),
        runCount: fact?.runKeys.length ?? wsAgents.reduce((sum, agent) => sum + agent.runCount, 0),
        traceCount: fact?.traceKeys.length ?? wsAgents.reduce((sum, agent) => sum + agent.traceCount, 0),
        tokenCount: fact?.tokenCount ?? wsAgents.reduce((sum, agent) => sum + agent.tokenCount, 0),
        avgLatencyMs: fact
          ? Math.round(fact.latencyTotal / (eventCount || 1))
          : Math.round(mean(wsAgents.map((agent) => agent.avgLatencyMs))),
        topRiskCategory: fact?.topRiskCategory ?? mode(wsAgents.map((agent) => agent.topRiskCategory)),
        topRiskName: fact?.topRiskName ?? mode(wsAgents.map((agent) => agent.topRiskName)),
        firstSeen: iso(Number.isFinite(firstMs) ? firstMs : window.startMs),
        lastSeen: iso(Number.isFinite(lastMs) ? lastMs : window.endMs),
        lastEventSubject: fact?.representativeEvent.subject ?? byLastSeen[0]?.lastEventSubject ?? '',
        maintenanceActive: Boolean(maintenance),
        maintenanceWindowId: maintenance?.windowId,
        maintenanceTitle: maintenance?.title,
      }];
    });

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
        return Number(Boolean(workspacePath) && b.workspacePath === workspacePath) -
          Number(Boolean(workspacePath) && a.workspacePath === workspacePath) ||
          Number(b.maintenanceActive) - Number(a.maintenanceActive) ||
          rank[a.healthState] - rank[b.healthState] ||
          b.openIncidentCount - a.openIncidentCount ||
          b.riskyEventCount - a.riskyEventCount ||
          Date.parse(b.lastSeen) - Date.parse(a.lastSeen);
      });
    const summary: T.WorkspaceInventorySummary = {
      totalWorkspaces: filtered.length,
      managedWorkspaces: filtered.filter((item) => item.managedAgentCount > 0).length,
      productionWorkspaces: filtered.filter((item) => ['prod', 'production'].includes(item.environment?.toLowerCase() ?? '')).length,
      highCriticalityWorkspaces: filtered.filter((item) => item.criticality === 'high' || item.criticality === 'critical').length,
      activeWorkspaces: filtered.filter((item) => item.healthState === 'active').length,
      staleWorkspaces: filtered.filter((item) => item.healthState === 'stale').length,
      riskyWorkspaces: filtered.filter((item) => item.healthState === 'risky').length,
      maintainedWorkspaces: filtered.filter((item) => item.maintenanceActive).length,
      totalAgents: filtered.reduce((sum, item) => sum + item.agentCount, 0),
      openIncidentCount: filtered.reduce((sum, item) => sum + item.openIncidentCount, 0),
      observedEventCount: filtered.reduce((sum, item) => sum + item.eventCount, 0),
      riskyEventCount: filtered.reduce((sum, item) => sum + item.riskyEventCount, 0),
    };
    const allFacts = [...factsByWorkspace.values()];
    const limit = Math.max(1, Math.min(500, filter.limit ?? 120));
    return {
      items: filtered.slice(0, limit),
      total: filtered.length,
      summary,
      coverage: this.queryCoverage(filter, allFacts.map((fact) => fact.representativeEvent), {
        source: hotEvents.length ? 'clickhouse+hot_delta' : 'clickhouse',
        totalMode: 'exact',
        partial: false,
        committedCutoffMs,
        dataFromMs: allFacts.length ? Math.min(...allFacts.map((fact) => fact.firstSeenAt)) : undefined,
        dataToMs: allFacts.length ? Math.max(...allFacts.map((fact) => fact.lastSeenAt)) : undefined,
      }),
      updateTime: iso(window.endMs),
    };
  }

  workspaceInventory(filter: T.WorkspaceInventoryQuery): T.WorkspaceInventory {
    const window = this.win(filter);
    const events = filter.scope === 'agent'
      ? window.events.filter((event) => event.attribution?.monitored === true)
      : window.events;
    const q = filter.q?.trim().toLowerCase();
    const owner = filter.owner?.trim().toLowerCase();
    const environment = filter.environment?.trim().toLowerCase();
    const workspacePath = filter.workspacePath?.trim();
    const hasFilter = Boolean((filter.healthState && filter.healthState !== 'all') || (filter.criticality && filter.criticality !== 'all') || owner || environment || q);
    const shouldScopeExactWorkspace = Boolean(workspacePath && !hasFilter);
    const agents = this.agentInventory({
      timeType: filter.timeType,
      startTime: filter.startTime,
      endTime: filter.endTime,
      scope: filter.scope,
      workspacePath: shouldScopeExactWorkspace ? workspacePath : undefined,
      limit: 500,
    });
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
        workspaceId: this.workspaceDirectory.resolveWorkspaceId(workspacePath),
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

  async storedAgentTopology(filter: T.AgentTopologyQuery): Promise<T.AgentTopology> {
    const window = resolveTimeWindow(filter);
    const committed = this.judge.committedEventCutoffMs();
    if (committed === undefined) return this.agentTopology(filter);
    const plan = planDashboardRead(window.startMs, window.endMs, committed);
    const persistedUntilMs = plan.persistedUntilMs ?? window.endMs;
    const hotEvents = foldLatestEventRevisions(
      this.judge.queryRange(plan.hotFromMs, window.endMs),
    );
    const overlapEventIds = hotEvents
      .filter((event) => event.at <= persistedUntilMs)
      .map((event) => event.eventId);
    const slices = reusableFactSlices(window.startMs, persistedUntilMs, plan.hotFromMs);
    let persisted: StoredTopologyWindowFact[] | null;
    if (
      !window.custom &&
      window.spanMs <= 24 * HOUR &&
      slices.fullEndExclusiveMs > slices.fullStartMs
    ) {
      this.topologyHistoryBuckets ??= new CommitAwareFactBucketCache<StoredTopologyBucketFact>({
        latestCursor: () => this.judge.latestEventCommitCursor(),
        earliestCursor: () => this.judge.earliestEventCommitCursor(),
        changes: (after) => this.judge.eventCommitChanges(after),
        facts: (startMs, endExclusiveMs, bucketMs) =>
          this.historyQueryGate.run(() =>
            this.judge.topologyWindowBucketFacts(startMs, endExclusiveMs, bucketMs),
          ),
      });
      const [stableFacts, headFacts, tailFacts] = await Promise.all([
        this.topologyHistoryBuckets.read(
          slices.fullStartMs,
          slices.fullEndExclusiveMs,
        ).catch((error) => {
          console.warn(
            `[topology] reusable history unavailable; using exact fallback: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return null;
        }),
        slices.head
          ? this.historyQueryGate.run(() =>
              this.judge.topologyWindowFacts(
                slices.head!.startMs,
                slices.head!.endMs,
                overlapEventIds,
              ),
            )
          : Promise.resolve([]),
        slices.tail
          ? this.historyQueryGate.run(() =>
              this.judge.topologyWindowFacts(
                slices.tail!.startMs,
                slices.tail!.endMs,
                overlapEventIds,
              ),
            )
          : Promise.resolve([]),
      ]);
      persisted = stableFacts && headFacts && tailFacts
        ? [...headFacts, ...stableFacts, ...tailFacts]
        : null;
      if (!persisted) {
        persisted = await this.historyQueryGate.run(() =>
          this.judge.topologyWindowFacts(
            window.startMs,
            persistedUntilMs,
            overlapEventIds,
          ),
        );
      }
    } else {
      persisted = await this.historyQueryGate.run(() =>
        this.judge.topologyWindowFacts(
          window.startMs,
          persistedUntilMs,
          overlapEventIds,
        ),
      );
    }
    if (persisted === null) return this.agentTopology(filter);
    const pinnedEventId = filter.eventId?.trim();
    const pinnedPage = pinnedEventId
      ? await this.judge.searchStoredEventsPage({
          sinceMs: 0,
          untilMs: window.endMs,
          eventId: pinnedEventId,
          limit: 1,
        })
      : undefined;
    const pinnedEvent = pinnedPage?.events[0] ?? (pinnedEventId ? this.judge.findEvent(pinnedEventId) : undefined);
    const hotFacts: StoredTopologyWindowFact[] = hotEvents.map((event) => ({
      identityKey: event.eventId,
      representativeEvent: event,
      firstSeenAt: event.at,
      lastSeenAt: event.at,
      eventCount: 1,
      riskyEventCount: event.verdict === 'allow' ? 0 : 1,
      worstSeverityRank: event.verdict === 'allow' ? 0 : SEV_RANK[event.severity],
      riskCategory: event.riskCategory,
      riskName: event.riskName,
    }));
    const facts = [...persisted, ...hotFacts];
    if (pinnedEvent && !facts.some((fact) => fact.representativeEvent.eventId === pinnedEvent.eventId)) {
      facts.push({
        identityKey: pinnedEvent.eventId,
        representativeEvent: pinnedEvent,
        firstSeenAt: pinnedEvent.at,
        lastSeenAt: pinnedEvent.at,
        eventCount: 1,
        riskyEventCount: pinnedEvent.verdict === 'allow' ? 0 : 1,
        worstSeverityRank: pinnedEvent.verdict === 'allow' ? 0 : SEV_RANK[pinnedEvent.severity],
        riskCategory: pinnedEvent.riskCategory,
        riskName: pinnedEvent.riskName,
      });
    }
    return this.agentTopology(filter, {
      facts,
      committedCutoffMs: Math.min(committed, window.endMs),
      source: hotFacts.length ? 'clickhouse+hot_delta' : 'clickhouse',
    });
  }

  agentTopology(
    filter: T.AgentTopologyQuery,
    durable?: {
      facts: StoredTopologyWindowFact[];
      committedCutoffMs: number;
      source: 'clickhouse' | 'clickhouse+hot_delta';
    },
  ): T.AgentTopology {
    const pinnedEdgeId = filter.edgeId?.trim();
    const pinnedEventId = filter.eventId?.trim();
    const agentScoped = filter.scope === 'agent';
    const resolvedEvents = new Map<string, ReturnType<AgentMetadataService['resolveEvent']>>();
    const resolveAgent = (event: T.JudgedEvent) => {
      const cached = resolvedEvents.get(event.eventId);
      if (cached) return cached;
      const resolved = this.agentMetadata.resolveEvent(event);
      resolvedEvents.set(event.eventId, resolved);
      return resolved;
    };
    const isAgentRelatedEvent = (event: T.JudgedEvent) =>
      isAgentAssetClassification(resolveAgent(event).effectiveClassification);
    const topologyFacts = durable?.facts;
    const factByEventId = new Map((topologyFacts ?? []).map((fact) => [fact.representativeEvent.eventId, fact]));
    const rawWindowedEvents = topologyFacts
      ? topologyFacts.map((fact) => fact.representativeEvent)
      : this.win(filter).events;
    const windowedEvents = agentScoped
      ? rawWindowedEvents.filter(isAgentRelatedEvent)
      : rawWindowedEvents;
    const windowedEventIds = new Set(windowedEvents.map((event) => event.eventId));
    const rawPinnedEvent = pinnedEventId
      ? topologyFacts?.find((fact) => fact.representativeEvent.eventId === pinnedEventId)?.representativeEvent
        ?? this.judge.findEvent(pinnedEventId)
      : undefined;
    const pinnedEvent = rawPinnedEvent && (!agentScoped || isAgentRelatedEvent(rawPinnedEvent))
      ? rawPinnedEvent
      : undefined;
    const rawEvents = pinnedEdgeId && !topologyFacts
      ? this.judge.query(0)
      : pinnedEvent && !windowedEventIds.has(pinnedEvent.eventId)
        ? [...windowedEvents, pinnedEvent]
        : windowedEvents;
    const events = agentScoped ? rawEvents.filter(isAgentRelatedEvent) : rawEvents;
    const includeBenign = filter.includeBenign !== false;
    const q = filter.q?.trim().toLowerCase();
    const requestedAgentAssetId = filter.agentAssetId?.trim();
    const agentAssetId = requestedAgentAssetId
      ? this.agentMetadata.canonicalAgentAssetId(requestedAgentAssetId)
      : undefined;
    const agentInstanceId = filter.agentInstanceId?.trim();
    const agentId = filter.agentId?.trim();
    const workspacePath = filter.workspacePath?.trim();
    const collectorId = filter.collectorId?.trim();
    const sourceId = filter.sourceId?.trim();
    const hasFilter = Boolean(agentAssetId || agentInstanceId || agentId || workspacePath || collectorId || sourceId || q || !includeBenign);
    const exactPinnedMode = Boolean((pinnedEdgeId || pinnedEventId) && !hasFilter);
    const limit = Math.max(20, Math.min(1000, filter.limit ?? 300));
    const pinnedEdgeIds = new Set<string>(pinnedEdgeId ? [pinnedEdgeId] : []);

    type NodeSpec = {
      id: string;
      type: T.TopologyNodeType;
      label: string;
      subtitle?: string;
      extra?: Partial<Pick<T.AgentTopologyNode, 'agentAssetId' | 'agentInstanceId' | 'agentId' | 'classification' | 'workspacePath' | 'collectorId'>>;
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
    const rosterAgentNodeIds = new Set<string>();
    const bumpNode = (
      id: string,
      type: T.TopologyNodeType,
      label: string,
      subtitle: string | undefined,
      event: T.JudgedEvent,
      extra: Partial<Pick<T.AgentTopologyNode, 'agentAssetId' | 'agentInstanceId' | 'agentId' | 'classification' | 'workspacePath' | 'collectorId'>> = {},
    ) => {
      const fact = factByEventId.get(event.eventId);
      const eventCount = fact?.eventCount ?? 1;
      const riskyEventCount = fact?.riskyEventCount ?? (event.verdict !== 'allow' ? 1 : 0);
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
      base.eventCount += eventCount;
      if (riskyEventCount > 0) {
        base.riskyEventCount += riskyEventCount;
        base.severityRank = Math.max(base.severityRank, fact?.worstSeverityRank ?? SEV_RANK[event.severity]);
      }
      base.lastSeenMs = Math.max(base.lastSeenMs, fact?.lastSeenAt ?? event.at);
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
      const fact = factByEventId.get(event.eventId);
      const eventCount = fact?.eventCount ?? 1;
      const riskyEventCount = fact?.riskyEventCount ?? (event.verdict !== 'allow' ? 1 : 0);
      const rank = riskyEventCount > 0 ? (fact?.worstSeverityRank ?? SEV_RANK[event.severity]) : 0;
      const lastSeenAt = fact?.lastSeenAt ?? event.at;
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
      base.eventCount += eventCount;
      if (riskyEventCount > 0) {
        base.riskyEventCount += riskyEventCount;
        if (rank >= base.severityRank) {
          base.severityRank = rank;
          base.maxSeverity = LEVEL_BY_RANK[Math.max(0, Math.min(4, rank))] as T.Severity;
        }
        const category = fact?.riskCategory ?? event.riskCategory;
        const risk = base.risks.get(category);
        base.risks.set(category, {
          riskName: fact?.riskName ?? event.riskName,
          eventCount: (risk?.eventCount ?? 0) + riskyEventCount,
        });
      }
      if (lastSeenAt >= base.lastSeenMs) {
        base.lastSeenMs = lastSeenAt;
        base.sampleEventId = event.eventId;
        base.sampleSubject = event.subject;
      }
      edges.set(id, base);
    };

    for (const e of events) {
      const resolved = resolveAgent(e);
      const collectorRef = eventCollectorId(e);
      const sourceRef = eventSourceId(e);
      const canonicalWorkspacePath = resolved.metadata?.workspacePath ?? e.workspacePath;
      const canonicalAgentId =
        canonicalAgentName(e.attribution?.agentScopeId) ??
        canonicalAgentName(e.attribution?.agentDisplayName) ??
        resolved.detectedName ??
        e.agentId;
      const canonicalAgentLabel =
        resolved.displayName ??
        canonicalAgentName(e.attribution?.agentDisplayName) ??
        canonicalAgentName(e.attribution?.agentScopeId) ??
        resolved.detectedName ??
        e.agentId;
      const runtimeInstanceId = agentRuntimeInstanceIdForEvent(e);
      const runtimeLocation = detectedAgentIdentity(e).locationLabel ?? canonicalWorkspacePath;
      const isPinnedEvent = Boolean(pinnedEventId && e.eventId === pinnedEventId);
      const matchesEntityScope =
        (!agentAssetId || resolved.agentAssetId === agentAssetId) &&
        (!agentInstanceId || runtimeInstanceId === agentInstanceId) &&
        (!agentId || [e.agentId, canonicalAgentId, canonicalAgentLabel].includes(agentId)) &&
        (!workspacePath || canonicalWorkspacePath === workspacePath || e.workspacePath === workspacePath) &&
        (!collectorId || collectorRef === collectorId) &&
        (!sourceId || sourceRef === sourceId);
      const matchesRelationshipScope =
        matchesEntityScope &&
        (includeBenign || e.verdict !== 'allow');
      if (!pinnedEdgeId && !isPinnedEvent && !matchesEntityScope) continue;

      const target = topologyTarget(e);
      const agentNodeId = nodeId(
        'agent',
        agentInventoryGroupKey(resolved.agentAssetId, runtimeInstanceId),
      );
      const workspaceNodeId = nodeId('workspace', canonicalWorkspacePath);
      const collectorNodeId = collectorRef ? nodeId('collector', collectorRef) : '';
      const targetNodeId = target ? nodeId(target.type, target.key) : '';
      const workspaceNode: NodeSpec = {
        id: workspaceNodeId,
        type: 'workspace',
        label: canonicalWorkspacePath,
        extra: { workspacePath: canonicalWorkspacePath },
      };
      const agentNode: NodeSpec = {
        id: agentNodeId,
        type: 'agent',
        label: canonicalAgentLabel,
        subtitle: runtimeLocation,
        extra: {
          agentAssetId: resolved.agentAssetId,
          agentInstanceId: runtimeInstanceId,
          agentId: canonicalAgentId,
          classification: resolved.effectiveClassification,
          workspacePath: canonicalWorkspacePath,
        },
      };
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
      const isPinnedEdge = Boolean(pinnedEdgeId && eventEdgeIds.includes(pinnedEdgeId));
      const matchesText =
        !q || [
          e.agentId,
          resolved.agentAssetId,
          runtimeInstanceId,
          canonicalAgentId,
          canonicalAgentLabel,
          canonicalWorkspacePath,
          e.subject,
          e.riskCategory,
          e.riskName,
          collectorRef,
          sourceRef,
          target?.label,
          target?.subtitle,
        ].some((v) => (v ?? '').toLowerCase().includes(q));
      const rosterMatch =
        windowedEventIds.has(e.eventId) &&
        matchesEntityScope &&
        matchesText;
      const normalMatch =
        rosterMatch &&
        matchesRelationshipScope;
      const includeAllEventEdges = exactPinnedMode ? isPinnedEvent : normalMatch || isPinnedEvent;
      const includedEdges = includeAllEventEdges ? eventEdges : eventEdges.filter((edge) => pinnedEdgeId && edge.id === pinnedEdgeId);
      if (isPinnedEvent) for (const id of eventEdgeIds) pinnedEdgeIds.add(id);

      const bumpedNodeIds = new Set<string>();
      const bumpNodeOnce = (node: NodeSpec) => {
        if (bumpedNodeIds.has(node.id)) return;
        bumpedNodeIds.add(node.id);
        bumpNode(node.id, node.type, node.label, node.subtitle, e, node.extra);
      };
      // The relationship dropdown filters edges, not the Agent roster. Otherwise a healthy
      // runtime disappears from topology and looks like an attribution/data-loss bug.
      if (rosterMatch) {
        rosterAgentNodeIds.add(agentNode.id);
        bumpNodeOnce(agentNode);
      }
      if (!includedEdges.length && !isPinnedEdge) continue;
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
    const selectedNodeIds = new Set([
      ...selectedEdges.flatMap((edge) => [edge.sourceNodeId, edge.targetNodeId]),
      ...rosterAgentNodeIds,
    ]);
    const selectedNodes = [...nodes.values()].filter((node) => selectedNodeIds.has(node.nodeId));
    const nodeItem = (node: NodeAgg): T.AgentTopologyNode => {
      const level = node.riskyEventCount ? levelByRank(node.severityRank) : { level: 'safe', text: LEVEL_TEXT.safe };
      return {
        nodeId: node.nodeId,
        type: node.type,
        label: node.label,
        subtitle: node.subtitle,
        agentAssetId: node.agentAssetId,
        agentInstanceId: node.agentInstanceId,
        agentId: node.agentId,
        classification: node.classification,
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
      coverage: this.queryCoverage(filter, events, {
        source: durable?.source ?? 'memory_hot_ring',
        totalMode: 'exact',
        partial: !durable,
        partialReason: durable ? undefined : 'hot_ring_only',
        committedCutoffMs: durable?.committedCutoffMs,
        dataFromMs: topologyFacts?.length
          ? Math.min(...topologyFacts.map((fact) => fact.firstSeenAt))
          : undefined,
        dataToMs: topologyFacts?.length
          ? Math.max(...topologyFacts.map((fact) => fact.lastSeenAt))
          : undefined,
      }),
      updateTime: iso(resolveTimeWindow(filter).endMs),
    };
  }

  async storedCollectorHealth(filter: T.CollectorHealthQuery): Promise<T.CollectorHealth> {
    const window = resolveTimeWindow(filter);
    const [persistedHeartbeats, persistedLatest, distributedLatest] = await Promise.all([
      this.judge.storedCollectorHeartbeats(window.startMs, window.endMs),
      this.judge.storedLatestCollectorHeartbeats(window.endMs),
      this.judge.distributedLatestCollectorHeartbeats(window.endMs),
    ]);
    if (persistedHeartbeats === null || persistedLatest === null) return this.collectorHealth(filter);
    const hotHeartbeats = this.judge.queryCollectorHeartbeats(window.startMs, window.endMs);
    const hotLatest = this.judge.latestCollectorHeartbeats(window.endMs);
    const merge = (items: T.CollectorHeartbeatRecord[]) => {
      const unique = new Map<string, T.CollectorHeartbeatRecord>();
      for (const item of items) unique.set(`${item.collectorId}\0${item.at}`, item);
      return [...unique.values()];
    };
    const heartbeats = merge([...persistedHeartbeats, ...hotHeartbeats]);
    const latest = merge([...persistedLatest, ...distributedLatest, ...hotLatest])
      .sort((a, b) => a.at - b.at)
      .reduce((map, item) => map.set(item.collectorId, item), new Map<string, T.CollectorHeartbeatRecord>());
    const hasRedisCurrent = distributedLatest.some((current) =>
      !persistedLatest.some((saved) => saved.collectorId === current.collectorId && saved.at >= current.at),
    );
    return this.collectorHealth(filter, {
      heartbeats,
      latest: [...latest.values()],
      source: hasRedisCurrent
        ? 'clickhouse+redis_current'
        : hotHeartbeats.some((hot) => !persistedHeartbeats.some((saved) => saved.collectorId === hot.collectorId && saved.at === hot.at))
        ? 'clickhouse+hot_delta'
        : 'clickhouse',
    });
  }

  collectorHealth(
    filter: T.CollectorHealthQuery,
    durable?: {
      heartbeats: T.CollectorHeartbeatRecord[];
      latest: T.CollectorHeartbeatRecord[];
      source: 'clickhouse' | 'clickhouse+hot_delta' | 'clickhouse+redis_current';
    },
  ): T.CollectorHealth {
    const window = resolveTimeWindow(filter);
    const sinceMs = window.startMs;
    const spanMs = window.spanMs;
    const windowHeartbeats = durable?.heartbeats
      ?? this.judge.queryCollectorHeartbeats(window.startMs, window.endMs);
    const latestAtSnapshot = durable?.latest
      ?? this.judge.latestCollectorHeartbeats(window.endMs);
    const byCollector = new Map<string, T.CollectorHeartbeatRecord[]>();
    for (const hb of windowHeartbeats) (byCollector.get(hb.collectorId) ?? byCollector.set(hb.collectorId, []).get(hb.collectorId)!).push(hb);
    for (const hb of latestAtSnapshot) {
      if (!byCollector.has(hb.collectorId)) byCollector.set(hb.collectorId, []);
    }

    const t = window.endMs;
    const stateText: Record<T.CollectorHealthState, string> = {
      healthy: '健康',
      quiet: '静默',
      degraded: '降级',
      stale: '陈旧',
      down: '断流',
    };
    const items = [...byCollector.entries()].map(([collectorId, hbs]): T.CollectorHealthItem => {
      const latest = [...hbs, ...latestAtSnapshot.filter((hb) => hb.collectorId === collectorId)]
        .sort((a, b) => b.at - a.at)[0];
      const categoryCounts = Object.fromEntries(EVENT_CATEGORIES.map((category) => [category, 0])) as Record<T.EventCategory, number>;
      let eventCount = 0;
      let observedAgentCount = 0;
      let reportedIntervalSecs = 0;
      const windowErrorMaxima = { droppedEvents: 0, outputDropped: 0, errorCount: 0 };
      const windowExecEvidence: T.CollectorExecEvidenceMetrics & {
        heartbeatCount: number;
        intervalSecs: number;
        shutdownFinalCount: number;
      } = {
        exec: 0,
        execTruncated: 0,
        execIncomplete: 0,
        execReassemblyTimeout: 0,
        heartbeatCount: 0,
        intervalSecs: 0,
        shutdownFinalCount: 0,
      };
      let latestExecEvidenceHeartbeat: T.CollectorHeartbeatRecord | undefined;
      for (const hb of hbs) {
        observedAgentCount = Math.max(observedAgentCount, hb.observedAgents);
        reportedIntervalSecs += hb.intervalSecs;
        windowErrorMaxima.droppedEvents = Math.max(windowErrorMaxima.droppedEvents, hb.droppedEvents ?? 0);
        windowErrorMaxima.outputDropped = Math.max(windowErrorMaxima.outputDropped, hb.outputDropped ?? 0);
        windowErrorMaxima.errorCount = Math.max(windowErrorMaxima.errorCount, hb.errorCount ?? 0);
        if (hb.origin === 'raw_collector' && hb.execEvidence) {
          windowExecEvidence.exec += hb.execEvidence.exec ?? 0;
          windowExecEvidence.execTruncated += hb.execEvidence.execTruncated ?? 0;
          windowExecEvidence.execIncomplete += hb.execEvidence.execIncomplete ?? 0;
          windowExecEvidence.execReassemblyTimeout += hb.execEvidence.execReassemblyTimeout ?? 0;
          windowExecEvidence.heartbeatCount += 1;
          windowExecEvidence.intervalSecs += hb.intervalSecs ?? 0;
          if (hb.execEvidence.shutdownFinal) windowExecEvidence.shutdownFinalCount += 1;
          if (!latestExecEvidenceHeartbeat || hb.at >= latestExecEvidenceHeartbeat.at) {
            latestExecEvidenceHeartbeat = hb;
          }
        }
        for (const [kind, count] of Object.entries(hb.eventKindCounts)) {
          eventCount += count;
          const category = eventCategory(kind);
          categoryCounts[category] = (categoryCounts[category] ?? 0) + count;
        }
      }
      const age = latest ? t - latest.at : Infinity;
      // Raw Collector and enriched Forwarder heartbeats are independent operational producers.
      // A clean record from one must not erase the latest error/drop reported by the other.
      const operationalHeads = [latestRawHeartbeat, latestForwarderHeartbeat].filter(
        (heartbeat): heartbeat is T.CollectorHeartbeatRecord => heartbeat !== undefined,
      );
      const currentDroppedEvents = operationalHeads.reduce(
        (value, heartbeat) => Math.max(value, heartbeat.droppedEvents), 0,
      );
      const currentOutputDropped = operationalHeads.reduce(
        (value, heartbeat) => Math.max(value, heartbeat.outputDropped), 0,
      );
      const currentErrorCount = operationalHeads.reduce(
        (value, heartbeat) => Math.max(value, heartbeat.errorCount), 0,
      );
      const currentQueueDepth = operationalHeads.reduce(
        (value, heartbeat) => Math.max(value, heartbeat.queueDepth), 0,
      );
      const degraded = operationalHeads.some((heartbeat) =>
        heartbeat.status !== 'ok' ||
        heartbeat.droppedEvents > 0 ||
        heartbeat.outputDropped > 0 ||
        heartbeat.errorCount > 0,
      );
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
        queueDepth: currentQueueDepth,
        droppedEvents: currentDroppedEvents,
        outputDropped: currentOutputDropped,
        errorCount: currentErrorCount,
        windowErrorMaxima,
        execEvidence: {
          reported: latestExecEvidenceHeartbeat !== undefined,
          ...(latestExecEvidenceHeartbeat ? {
            // Preserve milliseconds for the shutdown barrier; top-level health timestamps are
            // intentionally second-granular and cannot order two raw heartbeats in one second.
            lastReportedAt: new Date(latestExecEvidenceHeartbeat.at).toISOString(),
            latest: {
              exec: latestExecEvidenceHeartbeat.execEvidence?.exec ?? 0,
              execTruncated: latestExecEvidenceHeartbeat.execEvidence?.execTruncated ?? 0,
              execIncomplete: latestExecEvidenceHeartbeat.execEvidence?.execIncomplete ?? 0,
              execReassemblyTimeout: latestExecEvidenceHeartbeat.execEvidence?.execReassemblyTimeout ?? 0,
              shutdownFinal: latestExecEvidenceHeartbeat.execEvidence?.shutdownFinal === true,
              intervalSecs: latestExecEvidenceHeartbeat.intervalSecs ?? 0,
            },
          } : {}),
          window: windowExecEvidence,
        },
        filterMetricsReported: freshMetricsHeartbeat !== undefined,
        filterMetrics: freshMetricsHeartbeat?.filterMetrics ?? {
          scope: 'decoupled',
          shutdownFinal: false,
          filterMode: 'shadow',
          retainUnknown: true,
          retainNonAgent: false,
          noisePolicy: 'balanced',
          observed: 0,
          forwarded: 0,
          confirmedAgent: 0,
          probableAgent: 0,
          unknown: 0,
          nonAgent: 0,
          filteredNonAgent: 0,
          wouldFilterNonAgent: 0,
          filteredNoise: 0,
          wouldFilterNoise: 0,
          discoveryBudgetDropped: 0,
          wouldDiscoveryBudgetDrop: 0,
          deduplicated: 0,
          queueDropped: 0,
          batches: 0,
          batchEvents: 0,
          identitySnapshotReady: false,
          identitySnapshotVersion: 0,
          identitySnapshotAgeSeconds: 0,
          identityCacheEntries: 0,
          identityCacheHits: 0,
          identityCacheMisses: 0,
          identityCandidateCacheEntries: 0,
          identityCgroupBindings: 0,
          identityCgroupHits: 0,
          identityCgroupMisses: 0,
          identityErrors: 0,
          dockerEnabled: false,
          dockerReady: false,
          dockerEntries: 0,
          dockerReconnects: 0,
          dockerErrors: 0,
          behaviorWorkloads: 0,
          behaviorCandidates: 0,
          behaviorPromoted: 0,
          behaviorEvicted: 0,
          templateLoaded: 0,
          templateInvalid: 0,
          templateMatches: 0,
          templateAmbiguous: 0,
          processCacheEntries: 0,
          processTombstones: 0,
          processClassifications: 0,
          processCacheHits: 0,
          processCacheMisses: 0,
          processProcReads: 0,
          processBootstrapProcReads: 0,
          processFallbackProcReads: 0,
          processAncestryProcReads: 0,
        },
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
    return {
      items: filtered.slice(0, limit),
      total: filtered.length,
      summary,
      coverage: this.queryCoverage(filter, [], {
        source: durable?.source ?? 'memory_hot_ring',
        totalMode: 'exact',
        partial: !durable,
        partialReason: durable ? undefined : 'hot_ring_only',
        dataFromMs: windowHeartbeats.length
          ? Math.min(...windowHeartbeats.map((heartbeat) => heartbeat.at))
          : undefined,
        dataToMs: windowHeartbeats.length
          ? Math.max(...windowHeartbeats.map((heartbeat) => heartbeat.at))
          : undefined,
      }),
      updateTime: iso(window.endMs),
    };
  }

  async storedCoverageOverview(filter: T.CoverageQuery): Promise<T.CoverageOverview> {
    if (!this.judge.storageStatus().clickhouseReady) return this.coverageOverview(filter);
    const [collectors, agents] = await Promise.all([
      this.storedCollectorHealth({
        timeType: filter.timeType,
        startTime: filter.startTime,
        endTime: filter.endTime,
        limit: 500,
      }),
      this.storedAgentInventory({
        timeType: filter.timeType,
        startTime: filter.startTime,
        endTime: filter.endTime,
        scope: 'agent',
        limit: 500,
      }),
      this.sources.refreshDistributedCurrentState(),
    ]);
    return this.coverageOverview(filter, { collectors, agents });
  }

  coverageOverview(
    filter: T.CoverageQuery,
    durable?: { collectors: T.CollectorHealth; agents: T.AgentInventory },
  ): T.CoverageOverview {
    const events = durable
      ? []
      : this.win(filter).events.filter((event) => event.attribution?.monitored === true);
    const collectors = durable?.collectors ??
      this.collectorHealth({ timeType: filter.timeType, startTime: filter.startTime, endTime: filter.endTime, limit: 500 });
    const agents = durable?.agents ??
      this.agentInventory({ timeType: filter.timeType, startTime: filter.startTime, endTime: filter.endTime, scope: 'agent', limit: 500 });
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

    const collectorIdsFromEvents = new Map<string, {
      count: number;
      agents: Set<string>;
      sample?: T.JudgedEvent;
      aggregateOnly?: boolean;
    }>();
    for (const e of events) {
      const collectorId = eventCollectorId(e);
      if (!collectorId) continue;
      const cur = collectorIdsFromEvents.get(collectorId) ?? { count: 0, agents: new Set<string>(), sample: e };
      cur.count += 1;
      cur.agents.add(e.agentId);
      if (!cur.sample || e.at > cur.sample.at) cur.sample = e;
      collectorIdsFromEvents.set(collectorId, cur);
    }
    if (durable) {
      for (const agent of agents.items) {
        for (const collectorId of agent.collectorIds ?? []) {
          const current = collectorIdsFromEvents.get(collectorId) ?? {
            count: 0,
            agents: new Set<string>(),
            aggregateOnly: true,
          };
          current.agents.add(agent.agentId);
          collectorIdsFromEvents.set(collectorId, current);
        }
      }
    }
    for (const [collectorId, rec] of collectorIdsFromEvents) {
      if (collectorById.has(collectorId)) continue;
      issues.push(issue(
        'missing_collector_heartbeat',
        'high',
        `缺少 Collector 心跳 · ${collectorId}`,
        rec.aggregateOnly
          ? `${rec.agents.size} 个持久化 Agent 聚合仍引用该 collectorId，但查询窗口内没有对应 CollectorHeartbeat。`
          : `${rec.count} 条事件携带该 collectorId，但没有对应 CollectorHeartbeat。`,
        '启用 a3s-observer CollectorHeartbeat，或让 forwarder 定期 POST /security-center/collectors/heartbeat。',
        rec.aggregateOnly
          ? { evidenceMode: 'agent_aggregate', agentCount: String(rec.agents.size) }
          : { evidenceMode: 'event_fact', eventCount: String(rec.count), agentCount: String(rec.agents.size) },
        {
          collectorId,
          nodeName: rec.sample ? attrString(rec.sample, 'collectorNode') || undefined : undefined,
          evidenceEventId: rec.sample?.eventId,
          evidenceSubject: rec.sample?.subject,
          lastSeenAt: rec.sample ? iso(rec.sample.at) : undefined,
        },
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
      const collectorIds = new Set(
        durable
          ? agent.collectorIds ?? []
          : agentEvents.map(eventCollectorId).filter(Boolean),
      );
      const liveCollectorIds = [...collectorIds].filter((collectorId) => activeCollectorIds.has(collectorId));
      const missingCollectorEvents = agentEvents.filter((e) => !eventCollectorId(e));
      const missingCollectorEventCount = durable
        ? agent.eventsWithoutCollector ?? 0
        : missingCollectorEvents.length;
      eventsWithoutCollector += missingCollectorEventCount;
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
          { agentId: agent.agentId, workspacePath: agent.workspacePath, evidenceEventId: latest?.eventId ?? agent.lastEventId, evidenceSubject: latest?.subject ?? agent.lastEventSubject, lastSeenAt: agent.lastSeen },
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
          { collectorIds: [...collectorIds].join(', ') || 'none', missingCollectorEvents: String(missingCollectorEventCount) },
          { agentId: agent.agentId, workspacePath: agent.workspacePath, evidenceEventId: latest?.eventId ?? agent.lastEventId, evidenceSubject: latest?.subject ?? agent.lastEventSubject, lastSeenAt: agent.lastSeen },
        ));
      } else if (missingCollectorEventCount > 0) {
        issues.push(issue(
          'agent_uncovered',
          agent.riskyEventCount > 0 ? 'medium' : 'low',
          `Agent 部分事件缺少 Collector 归属 · ${agent.agentId}`,
          `${missingCollectorEventCount}/${agent.eventCount} 条事件没有 collectorId。`,
          '统一使用 observer forwarder，并在事件 attributes 中附加 collectorId/nodeName。',
          { missingCollectorEvents: String(missingCollectorEventCount), eventCount: String(agent.eventCount) },
          { agentId: agent.agentId, workspacePath: agent.workspacePath, evidenceEventId: missingCollectorEvents[0]?.eventId ?? agent.lastEventId, evidenceSubject: missingCollectorEvents[0]?.subject ?? agent.lastEventSubject, lastSeenAt: agent.lastSeen },
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
      coverage: durable
        ? {
            ...agents.coverage,
            source: agents.coverage.source === 'clickhouse+hot_delta' || collectors.coverage?.source === 'clickhouse+hot_delta'
              ? 'clickhouse+hot_delta'
              : collectors.coverage?.source === 'clickhouse+redis_current'
                ? 'clickhouse+redis_current'
                : 'clickhouse',
            partial: Boolean(agents.coverage.partial || collectors.coverage?.partial),
            partialReason: agents.coverage.partialReason ?? collectors.coverage?.partialReason,
          }
        : this.queryCoverage(filter, events, {
            source: 'memory_hot_ring',
            totalMode: 'exact',
            partial: true,
            partialReason: 'hot_ring_only',
          }),
      updateTime: iso(),
    };
  }

  async storedPolicySimulation(input: T.PolicySimulationRequest): Promise<T.PolicySimulationResult> {
    if (!this.judge.storageStatus().clickhouseReady) return this.policySimulation(input);
    const window = resolveTimeWindow(input);
    const sampleLimit = Math.max(100, Math.min(5_000, input.sampleLimit ?? 2_000));
    const persisted = await this.judge.searchStoredEventsPage({
      sinceMs: window.startMs,
      untilMs: window.endMs,
      monitoredOnly: input.scope === 'agent',
      limit: sampleLimit,
    });
    const hot = this.judge.queryRange(window.startMs, window.endMs);
    const scoped = foldLatestEventRevisions([...persisted.events, ...hot])
      .filter((event) => input.scope !== 'agent' || isMonitoredAgentEvent(event))
      .sort((a, b) => b.at - a.at);
    const truncated = persisted.hasMore || scoped.length > sampleLimit;
    const events = scoped.slice(0, sampleLimit);
    const coverage = this.queryCoverage(input, events, {
      source: hot.length ? 'clickhouse+hot_delta' : 'clickhouse',
      totalMode: 'omitted',
      partial: truncated,
      partialReason: truncated ? 'scan_limit' : undefined,
      committedCutoffMs: persisted.committedCutoffMs,
    });
    return this.policySimulation(input, events, coverage, sampleLimit, truncated);
  }

  policySimulation(
    input: T.PolicySimulationRequest,
    sampledEvents?: T.JudgedEvent[],
    durableCoverage?: T.QueryCoverage,
    durableSampleLimit?: number,
    durableTruncated = false,
  ): T.PolicySimulationResult {
    const config = sanitizePolicy(input.policy);
    let simulator: Sentry;
    try {
      simulator = Sentry.create(buildAcl(config));
    } catch (error) {
      throw policyConfigError(error);
    }
    const window = sampledEvents ? undefined : this.win(input);
    const events = sampledEvents ?? window!.events;
    const limit = Math.max(1, Math.min(500, input.limit ?? 120));
    const sampleLimit = durableSampleLimit ?? Math.max(1, Math.min(100_000, events.length));
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
      sampling: {
        strategy: 'latest_event_sample',
        sampleLimit,
        sampledEvents: events.length,
        truncated: durableTruncated || !sampledEvents,
      },
      coverage: durableCoverage ?? this.queryCoverage(input, events, {
        source: 'memory_hot_ring',
        totalMode: 'omitted',
        partial: true,
        partialReason: 'hot_ring_only',
      }),
      updateTime: iso(),
    };
  }

  performanceCard(filter: T.SecurityTimeFilter): T.SecurityPerformanceCard {
    const { events: windowEvents, dataSinceMs, dataSpanMs } = this.win(filter);
    const events = filter.scope === 'agent' ? windowEvents.filter(isMonitoredAgentEvent) : windowEvents;
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
    const agentScoped = filter.scope === 'agent';
    const scopedEvents = agentScoped ? events.filter(isMonitoredAgentEvent) : events;
    const prev = this.judge.query(sinceMs - spanMs).filter((e) => e.at < sinceMs);
    const scopedPrev = agentScoped ? prev.filter(isMonitoredAgentEvent) : prev;
    const cat = (type: T.RiskType): T.RiskCategory => {
      const risky = scopedEvents.filter((e) => e.verdict !== 'allow' && e.riskType === type);
      const prevRisky = scopedPrev.filter((e) => e.verdict !== 'allow' && e.riskType === type);
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
    const agentEvents = events.filter(isMonitoredAgentEvent);
    const bySession = new Map<string, T.JudgedEvent[]>();
    for (const e of agentEvents) {
      const key = eventSessionLabel(e);
      (bySession.get(key) ?? bySession.set(key, []).get(key)!).push(e);
    }
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
      sessionId: eventAgentLabel(head), userId: head.userId, workspacePath: attributionWorkspacePath(head),
      riskLevel: lvl.level, riskLevelText: lvl.text, compositeScore: composite,
      lastEventTime: iso(Math.max(...top.map((e) => e.at))), riskDimensions: dims, updateTime: iso(),
    };
  }

  decisionFunnel(filter: T.SecurityTimeFilter): T.SecurityDecisionFunnel {
    const windowEvents = this.win(filter).events;
    const events = filter.scope === 'agent' ? windowEvents.filter(isMonitoredAgentEvent) : windowEvents;
    const total = events.length || 1;
    const l2 = events.filter((e) => e.tier === 'Llm' || e.tier === 'Agent');
    const l3 = events.filter((e) => e.tier === 'Agent');
    const blocked = events.filter((e) => e.verdict === 'block').length;
    const pct = (c: number) => round1((c / total) * 100);
    return {
      tiers: [
        { tierCode: 'L1', tierName: '规则引擎', count: events.length, percentage: 100, slaDesc: '确定性匹配 · <1ms' },
        { tierCode: 'L2', tierName: 'LLM 研判', count: l2.length, percentage: pct(l2.length), slaDesc: '语义判定 · <100ms' },
        { tierCode: 'L3', tierName: '智能体深判', count: l3.length, percentage: pct(l3.length), slaDesc: 'a3s-code · 深度调查' },
      ],
      finalBlock: { count: blocked, percentage: pct(blocked) },
      updateTime: iso(),
    };
  }

  agentObservability(filter: T.SecurityTimeFilter): T.AgentObservability {
    const windowEvents = this.win(filter).events;
    const events = filter.scope === 'agent' ? windowEvents.filter(isMonitoredAgentEvent) : windowEvents;
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

  async agentObservabilityForWindow(filter: T.SecurityTimeFilter): Promise<T.AgentObservability> {
    const durable = await this.storedAgentMetricFacts(filter, 60);
    if (!durable) return this.agentObservability(filter);
    const window = resolveTimeWindow(filter);
    const facts = durable.facts;
    const eventCount = facts.reduce((sum, fact) => sum + fact.eventCount, 0);
    const riskyEventCount = facts.reduce((sum, fact) => sum + fact.riskyEventCount, 0);
    const recentEventCount = facts.reduce((sum, fact) => sum + fact.recentEventCount, 0);
    const recentCommCount = facts.reduce((sum, fact) => sum + fact.recentCommCount, 0);
    const recentSessionKeys = new Set(facts.flatMap((fact) => fact.recentSessionKeys));
    const agentAssetIds = new Set(facts.map((fact) =>
      this.agentMetadata.resolveEvent(fact.representativeEvent).agentAssetId,
    ));
    const errorRate = round1((riskyEventCount / (eventCount || 1)) * 100);
    return {
      health: {
        heartbeatOk: recentEventCount > 0,
        resourceUtil: Math.min(99, 20 + recentEventCount * 3),
        errorRate,
        decisionLatencyMs: Math.round(
          facts.reduce((sum, fact) => sum + fact.latencyTotal, 0) / (eventCount || 1),
        ),
      },
      behavioral: {
        actionRate: recentEventCount,
        decisionPattern: errorRate > 25 ? 'drift' : 'baseline',
        stateTransitions: recentSessionKeys.size,
        goalProgress: Math.max(0, 100 - Math.round(errorRate)),
      },
      system: {
        agentCount: agentAssetIds.size,
        commThroughput: recentCommCount,
        infraHealthy: true,
      },
      coverage: durable.coverage,
      updateTime: iso(window.endMs),
    };
  }

  workspaceRiskDistribution(filter: T.SecurityTimeFilter): T.SecurityWorkspaceRiskDistribution {
    const { events } = this.win(filter);
    const agentScoped = filter.scope !== 'raw';
    const scopedEvents = agentScoped ? events.filter(isMonitoredAgentEvent) : events;
    const byWs = new Map<string, T.JudgedEvent[]>();
    for (const e of scopedEvents) {
      const workspacePath = agentScoped ? attributionWorkspacePath(e) : e.workspacePath;
      (byWs.get(workspacePath) ?? byWs.set(workspacePath, []).get(workspacePath)!).push(e);
    }
    const list = [...byWs.entries()]
      .map(([workspacePath, evs]) => {
        const lvl = worstLevel(evs);
        return { workspacePath, sessionCount: distinct(evs.map((e) => e.sessionId)), totalRiskScore: evs.reduce((a, e) => a + e.riskScore, 0), riskLevel: lvl.level, riskLevelText: lvl.text };
      })
      .sort((a, b) => b.totalRiskScore - a.totalRiskScore);
    return { list, updateTime: iso() };
  }

  async healthCardForWindow(filter: T.SecurityTimeFilter): Promise<T.SecurityHealthCard> {
    const history = await this.history(filter);
    if (!history) return this.healthCard(filter);
    const rows = this.currentDimensions(history, filter);
    const total = rows.reduce((sum, row) => sum + row.eventCount, 0) || 1;
    const blocked = rows.filter((row) => row.verdict === 'block').reduce((sum, row) => sum + row.eventCount, 0);
    const escalated = rows.filter((row) => row.verdict === 'escalate').reduce((sum, row) => sum + row.eventCount, 0);
    const score = Math.max(1, Math.min(100, Math.round(100 - (blocked / total) * 60 - (escalated / total) * 25)));
    const text = score >= 90 ? '健康' : score >= 75 ? '良好' : score >= 60 ? '注意' : score >= 40 ? '风险偏高' : '高危';
    const tokens = fmtTokens(rows.reduce((sum, row) => sum + row.tokenCount, 0));
    return { healthScore: score, healthStatusText: text, tokenConsumptionTotal: tokens.total, tokenConsumptionUnit: tokens.unit };
  }

  async explainabilityScanForWindow(filter: T.ExplainabilityScanRequest): Promise<T.SecurityExplainabilityScan> {
    const history = await this.history(filter);
    if (!history) return this.explainabilityScan(filter);
    const n = Math.max(8, Math.min(72, filter.seriesPoints ?? 24));
    const window = resolveTimeWindow(filter);
    const buckets = this.aggregateHistoryBuckets(history, filter, n);
    const safeSeries: T.WaveSeriesPoint[] = [];
    const riskSeries: T.WaveSeriesPoint[] = [];
    buckets.forEach((bucket, index) => {
      const statTime = iso(window.startMs + index * (window.spanMs / n));
      const avgRisk = bucket.eventCount ? bucket.riskScoreTotal / bucket.eventCount : 0;
      riskSeries.push({ statTime, value: Math.round(avgRisk), activationCount: bucket.riskActivationCount });
      safeSeries.push({ statTime, value: Math.round(100 - avgRisk), activationCount: bucket.eventCount });
    });
    const rows = this.currentDimensions(history, filter);
    const total = rows.reduce((sum, row) => sum + row.eventCount, 0);
    const blocked = rows.filter((row) => row.verdict === 'block').reduce((sum, row) => sum + row.eventCount, 0);
    const hotEvents = window.custom ? [] : this.judge.queryRange(Math.max(window.startMs, window.endMs - 5 * 60_000), window.endMs);
    const scopedHotEvents = filter.scope === 'agent' ? hotEvents.filter(isMonitoredAgentEvent) : hotEvents;
    return {
      waveSeries: [{ safeSeries, riskSeries }],
      threatInterception: `${round1((blocked / (total || 1)) * 100)}%`,
      sessionActiveCount: String(distinct(scopedHotEvents.map((event) => event.sessionId))),
      updateTime: iso(),
    };
  }

  async performanceCardForWindow(filter: T.SecurityTimeFilter): Promise<T.SecurityPerformanceCard> {
    const history = await this.history(filter);
    if (!history) return this.performanceCard(filter);
    const window = resolveTimeWindow(filter);
    const buckets = this.aggregateHistoryBuckets(history, filter, 60);
    const bucketSeconds = window.spanMs / buckets.length / 1000;
    const counts = buckets.map((bucket) => bucket.eventCount);
    const perSecond = counts.map((count) => count / (bucketSeconds || 1));
    const total = buckets.reduce((sum, bucket) => sum + bucket.eventCount, 0);
    const latencyTotal = buckets.reduce((sum, bucket) => sum + bucket.latencyTotal, 0);
    return {
      componentRequestCount: {
        current: counts[counts.length - 1] ?? 0,
        peak: Math.max(0, ...counts),
        avg: Math.round(mean(counts)),
      },
      tps: {
        current: round1(perSecond[perSecond.length - 1] ?? 0),
        peak: round1(Math.max(0, ...perSecond)),
        avg: round1(mean(perSecond)),
      },
      avgLatency: { value: Math.round(latencyTotal / (total || 1)), unit: 'ms' },
      updateTime: iso(),
    };
  }

  async riskSummaryForWindow(filter: T.SecurityTimeFilter): Promise<T.SecurityRiskSummary> {
    const history = await this.history(filter);
    if (!history) return this.riskSummary(filter);
    const rows = this.currentDimensions(history, filter).filter((row) => row.verdict !== 'allow');
    const card = (code: T.RiskType, name: string) => ({
      riskTypeCode: code,
      riskTypeName: name,
      eventCount: rows.filter((row) => row.riskType === code).reduce((sum, row) => sum + row.eventCount, 0),
    });
    return {
      summaryCards: [
        card('system', '系统性风险'),
        card('communication', '通信风险'),
        card('atomic', '单体智能体风险'),
      ],
      updateTime: iso(),
    };
  }

  async riskBreakdownForWindow(filter: T.SecurityTimeFilter): Promise<T.SecurityRiskBreakdown> {
    const history = await this.history(filter);
    if (!history) return this.riskBreakdown(filter);
    const agentScoped = filter.scope === 'agent';
    const select = (period: DashboardWindowDimensionRow['period']) => history.dimensions.filter((row) =>
      row.period === period && row.verdict !== 'allow' && (!agentScoped || row.monitored));
    const current = select('current');
    const previous = select('previous');
    const category = (type: T.RiskType): T.RiskCategory => {
      const rows = current.filter((row) => row.riskType === type);
      const previousRows = previous.filter((row) => row.riskType === type);
      const countOf = (items: DashboardWindowDimensionRow[], code: string) =>
        items.filter((row) => row.riskCategory === code).reduce((sum, row) => sum + row.eventCount, 0);
      const known = RISK_TAXONOMY[type];
      const extras = [...new Set(rows.map((row) => row.riskCategory))]
        .filter((code) => !known.some((item) => item.code === code))
        .map((code) => ({ code, name: rows.find((row) => row.riskCategory === code)?.riskName || code }));
      const items = [...known, ...extras].map(({ code, name }) => {
        const eventCount = countOf(rows, code);
        const before = countOf(previousRows, code);
        const changeRate = before === 0 ? (eventCount ? 100 : 0) : round1(((eventCount - before) / before) * 100);
        return { riskCode: code, riskName: name, eventCount, changeRate };
      }).sort((a, b) => b.eventCount - a.eventCount);
      const top = items.find((item) => item.eventCount > 0);
      return {
        totalCount: rows.reduce((sum, row) => sum + row.eventCount, 0),
        displayColor: CATEGORY_COLOR[top?.riskCode ?? ''] ?? '#94a3b8',
        items,
      };
    };
    return {
      systemRisks: category('system'),
      communicationRisks: category('communication'),
      singleAgentRisks: category('atomic'),
      updateTime: iso(),
    };
  }

  async highestRiskSessionForWindow(filter: T.SecurityTimeFilter): Promise<T.SecurityHighestRiskSession> {
    const history = await this.history(filter);
    if (!history) return this.highestRiskSession(filter);
    const top = history.topSession;
    if (!top) {
      return {
        sessionId: '-',
        userId: '-',
        workspacePath: '-',
        riskLevel: 'safe',
        riskLevelText: LEVEL_TEXT.safe,
        compositeScore: 0,
        lastEventTime: iso(resolveTimeWindow(filter).endMs),
        riskDimensions: DIMENSIONS.map((dimension) => ({ dimensionCode: dimension.code, dimensionName: dimension.name, score: 0 })),
        updateTime: iso(),
      };
    }
    const compositeScore = Math.min(100, Math.round((top.riskScoreTotal / (top.eventCount || 1)) + Math.sqrt(top.riskyEventCount) * 6));
    const level = levelByRank(Math.min(4, Math.floor(compositeScore / 22)));
    return {
      sessionId: top.sessionId,
      userId: top.userId,
      workspacePath: top.workspacePath,
      riskLevel: level.level,
      riskLevelText: level.text,
      compositeScore,
      lastEventTime: iso(top.lastEventAt),
      riskDimensions: DIMENSIONS.map((dimension) => {
        const count = top.dimensionCounts[dimension.code] ?? 0;
        return {
          dimensionCode: dimension.code,
          dimensionName: dimension.name,
          score: count === 0 ? 0 : count === 1 ? 1 : count <= 3 ? 2 : 3,
        };
      }),
      updateTime: iso(),
    };
  }

  async decisionFunnelForWindow(filter: T.SecurityTimeFilter): Promise<T.SecurityDecisionFunnel> {
    const history = await this.history(filter);
    if (!history) return this.decisionFunnel(filter);
    const rows = this.currentDimensions(history, filter);
    const total = rows.reduce((sum, row) => sum + row.eventCount, 0) || 1;
    const count = (predicate: (row: DashboardWindowDimensionRow) => boolean) =>
      rows.filter(predicate).reduce((sum, row) => sum + row.eventCount, 0);
    const l2 = count((row) => row.tier === 'Llm' || row.tier === 'Agent');
    const l3 = count((row) => row.tier === 'Agent');
    const blocked = count((row) => row.verdict === 'block');
    const percentage = (value: number) => round1((value / total) * 100);
    return {
      tiers: [
        { tierCode: 'L1', tierName: '规则引擎', count: total, percentage: 100, slaDesc: '确定性匹配 · <1ms' },
        { tierCode: 'L2', tierName: 'LLM 研判', count: l2, percentage: percentage(l2), slaDesc: '语义判定 · <100ms' },
        { tierCode: 'L3', tierName: '智能体深判', count: l3, percentage: percentage(l3), slaDesc: 'a3s-code · 深度调查' },
      ],
      finalBlock: { count: blocked, percentage: percentage(blocked) },
      updateTime: iso(),
    };
  }

  async workspaceRiskDistributionForWindow(filter: T.SecurityTimeFilter): Promise<T.SecurityWorkspaceRiskDistribution> {
    const history = await this.history(filter);
    if (!history || filter.scope === 'raw') return this.workspaceRiskDistribution(filter);
    return {
      list: history.workspaces.map((workspace) => {
        const level = levelByRank(workspace.worstSeverityRank);
        return {
          workspacePath: workspace.workspacePath,
          sessionCount: workspace.sessionCount,
          totalRiskScore: workspace.totalRiskScore,
          riskLevel: level.level,
          riskLevelText: level.text,
        };
      }),
      updateTime: iso(),
    };
  }
}
