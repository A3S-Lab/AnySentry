import { Injectable } from '@nestjs/common';
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

const now = () => Date.now();
const iso = (t = now()) => new Date(t).toISOString().slice(0, 19).replace('T', ' ');
const round1 = (n: number) => Math.round(n * 10) / 10;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const distinct = <V>(xs: V[]) => new Set(xs).size;

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

@Injectable()
export class AggregationService {
  constructor(private readonly judge: SentryJudgeService) {}

  // The dashboard polls 9 endpoints with the same filter near-simultaneously; cache the windowed
  // scan for a beat so they share one pass over the 100k ring instead of nine (keeps latency flat).
  private readonly winCache = new Map<string, { at: number; val: ReturnType<AggregationService['computeWin']> }>();

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

  // The WHY view — mechanistic interpretability of LLM outputs. Aggregates the SAE-scored model
  // outputs (events carrying `explain`, from a3s-power's in-enclave tap) into per-category totals,
  // the top named feature drivers, and the recent flagged outputs with their drivers.
  explainabilityDrivers(filter: T.SecurityTimeFilter): T.SecurityExplainabilityDrivers {
    const { events } = this.win(filter);
    const scored = events.filter((e) => e.explain);
    const flagged = scored.filter((e) => e.verdict !== 'allow');
    const avgHarmful = scored.length
      ? Math.round((scored.reduce((a, e) => a + (e.explain?.harmful ?? 0), 0) / scored.length) * 100)
      : 0;

    const catMap = new Map<string, { total: number; count: number }>();
    for (const e of scored) {
      for (const [c, v] of Object.entries(e.explain?.perCategory ?? {})) {
        const cur = catMap.get(c) ?? { total: 0, count: 0 };
        cur.total += v;
        cur.count++;
        catMap.set(c, cur);
      }
    }
    const perCategory = [...catMap.entries()]
      .map(([category, x]) => ({ category, total: round1(x.total), count: x.count }))
      .sort((a, b) => b.total - a.total);

    const drvMap = new Map<string, { concept: string; category: string; source: string; count: number; sum: number }>();
    for (const e of scored) {
      for (const d of e.explain?.drivers ?? []) {
        const cur = drvMap.get(d.source) ?? { concept: d.concept, category: d.category, source: d.source, count: 0, sum: 0 };
        cur.count++;
        cur.sum += d.contribution;
        drvMap.set(d.source, cur);
      }
    }
    const topDrivers = [...drvMap.values()]
      .map((d) => ({ concept: d.concept, category: d.category, source: d.source, count: d.count, avgContribution: round1(d.sum / d.count) }))
      .sort((a, b) => b.count - a.count || b.avgContribution - a.avgContribution)
      .slice(0, 10);

    const flaggedOutputs = [...flagged]
      .sort((a, b) => b.at - a.at)
      .slice(0, 20)
      .map((e) => ({
        agentId: e.agentId,
        sessionId: e.sessionId,
        harmful: round1(e.explain?.harmful ?? 0),
        verdict: e.verdict,
        severity: e.severity,
        at: iso(e.at),
        drivers: e.explain?.drivers ?? [],
      }));

    return { scored: scored.length, flaggedCount: flagged.length, avgHarmful, perCategory, topDrivers, flaggedOutputs, updateTime: iso() };
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
