import { Body, Controller, Get, Post, Query, Sse } from '@nestjs/common';
import { Observable, map, timer } from 'rxjs';
import { SkipWrap } from '../shared/api-response.interceptor';
import { AggregationService } from './aggregation.service';
import { KubeIdentityService } from './kube-identity.service';
import { SentryJudgeService } from './sentry-judge.service';
import * as T from './types';

/** Ingest a real observer event: judge it via sentry and record it for the dashboard. */
interface IngestBody extends Partial<T.EventMeta> {
  line: string; // a raw a3s-observer NDJSON line (identity + event) — metadata is derived from it
}

// Cluster LLM endpoints (agents call these for inference — internal/self-hosted, so they don't
// match the observer's public-provider SNI list, and several are plain HTTP). Egress/Dns to them is
// surfaced as an LlmCall so the dashboard observes LLM activity. Override via ANYSENTRY_LLM_ENDPOINTS.
const LLM_ENDPOINTS = (process.env.ANYSENTRY_LLM_ENDPOINTS ?? 'api.anthropic.com,api.openai.com,api.deepseek.com')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function isLlmEndpoint(inner: Record<string, unknown>): boolean {
  const a = inner as { peer?: string; sni?: string; query?: string };
  const peer = a.peer ?? '';
  const sni = a.sni ?? '';
  const query = a.query ?? '';
  return LLM_ENDPOINTS.some((e) => peer === e || (sni !== '' && sni.includes(e)) || (query !== '' && query.includes(e)));
}

function summarize(kind: string, inner: Record<string, unknown>): string {
  const a = inner as { argv?: string[]; peer?: string; port?: number; query?: string; path?: string; sni?: string; kind?: string };
  if (kind === 'ToolExec') return (a.argv ?? []).join(' ').slice(0, 80) || 'exec';
  if (kind === 'Egress') return `egress → ${a.peer ?? '?'}${a.port ? `:${a.port}` : ''}`;
  if (kind === 'Dns') return `dns ${a.query ?? ''}`;
  if (kind === 'FileAccess') return `file ${a.path ?? ''}`;
  if (kind === 'SslContent') return 'ssl content';
  if (kind === 'SecurityAction') return `security ${a.kind ?? ''}`;
  if (kind === 'LlmCall') return `llm ${a.sni ?? ''}`;
  return kind;
}

/** Fill EventMeta from an a3s-observer line's identity + event, honoring any explicitly-given fields. */
function deriveMeta(line: string, given: Partial<T.EventMeta>): T.EventMeta {
  let id: { agent?: string; task?: string | number; session?: string } = {};
  let eventKey = 'Event';
  let inner: Record<string, unknown> = {};
  try {
    const o = JSON.parse(line) as { identity?: typeof id; event?: Record<string, Record<string, unknown>> };
    id = o.identity ?? {};
    const ev = o.event ?? {};
    eventKey = Object.keys(ev)[0] ?? 'Event';
    inner = ev[eventKey] ?? {};
  } catch {
    // not JSON — leave defaults; sentry.evaluate will return null and the event is dropped
  }
  const agentId = given.agentId ?? id.agent ?? 'unknown';
  const cwd = typeof inner.cwd === 'string' ? inner.cwd : undefined;
  const uid = inner.uid;
  // Surface an agent→LLM-endpoint connection as an LlmCall even when it isn't an SNI-classified
  // public provider (internal/self-hosted endpoints, plain HTTP).
  const isLlm = (eventKey === 'Egress' || eventKey === 'Dns') && isLlmEndpoint(inner);
  const peer = (inner as { peer?: string; query?: string }).peer ?? (inner as { query?: string }).query ?? '';
  return {
    agentId,
    workspacePath: given.workspacePath ?? cwd ?? `agent://${agentId}`,
    // A session is a logical work unit. The kernel rarely knows an app-level session id, so fall
    // back to the AGENT (workload), NOT the pid — else every short-lived process counts as a session.
    sessionId: given.sessionId ?? id.session ?? id.agent ?? (id.task != null ? `task-${id.task}` : 'session'),
    userId: given.userId ?? (uid != null ? `uid:${uid}` : 'system'),
    eventKind: given.eventKind ?? (isLlm ? 'LlmCall' : eventKey),
    subject: given.subject ?? (isLlm ? `LLM 调用 → ${peer}` : summarize(eventKey, inner)),
    tokenCount: given.tokenCount,
    latencyMs: given.latencyMs,
  };
}

@Controller('security-center')
export class SecurityMonitoringController {
  constructor(
    private readonly agg: AggregationService,
    private readonly judge: SentryJudgeService,
    private readonly kube: KubeIdentityService,
  ) {}

  @Post('top/healthCard')
  healthCard(@Body() f: T.SecurityTimeFilter) {
    return this.agg.healthCard(f);
  }

  @Post('top/explainabilityScan')
  explainabilityScan(@Body() f: T.ExplainabilityScanRequest) {
    return this.agg.explainabilityScan(f);
  }

  /** The WHY view — mechanistic interpretability of LLM outputs (SAE drivers, per-category, flagged). */
  @Post('top/explainabilityDrivers')
  explainabilityDrivers(@Body() f: T.SecurityTimeFilter) {
    return this.agg.explainabilityDrivers(f);
  }

  @Post('top/performanceCard')
  performanceCard(@Body() f: T.SecurityTimeFilter) {
    return this.agg.performanceCard(f);
  }

  @Post('risks/summary')
  riskSummary(@Body() f: T.SecurityTimeFilter) {
    return this.agg.riskSummary(f);
  }

  @Post('risks/breakdown')
  riskBreakdown(@Body() f: T.SecurityTimeFilter) {
    return this.agg.riskBreakdown(f);
  }

  @Post('sessions/highestRisk')
  highestRisk(@Body() f: T.SecurityTimeFilter) {
    return this.agg.highestRiskSession(f);
  }

  @Post('sessions/decisionFunnel')
  decisionFunnel(@Body() f: T.SecurityTimeFilter) {
    return this.agg.decisionFunnel(f);
  }

  @Post('sessions/agentObservability')
  agentObservability(@Body() f: T.SecurityTimeFilter) {
    return this.agg.agentObservability(f);
  }

  @Post('sessions/workspaceRiskDistribution')
  workspaceRiskDistribution(@Body() f: T.SecurityTimeFilter) {
    return this.agg.workspaceRiskDistribution(f);
  }

  /** Live agent-observability stream (a frame every 3s), consumed by the dashboard's SSE client. */
  @Sse('sessions/agentObservability/stream')
  @SkipWrap()
  stream(@Query() q: T.SecurityTimeFilter): Observable<{ data: T.AgentObservability }> {
    return timer(0, 3000).pipe(map(() => ({ data: this.agg.agentObservability(q) })));
  }

  /** Store histograms — which signal kinds / verdicts / tiers are flowing (ops + verification). */
  @Get('stats')
  stats() {
    return this.judge.stats();
  }

  /** The real ingestion seam: external agents/observers POST events here to be judged + counted. */
  @Post('ingest')
  ingest(@Body() body: IngestBody) {
    const { line, ...given } = body;
    // Enrich identity (pod-uid → real agent name) and focus on agent workloads (drop infra/host).
    const meta = this.kube.enrich(deriveMeta(line, given));
    if (!meta) return { accepted: false, reason: 'filtered: infra/host (not an agent workload)' };
    const rec = this.judge.judge(line, meta);
    return rec ? { accepted: true, verdict: rec.verdict, tier: rec.tier, severity: rec.severity, reason: rec.reason, riskCategory: rec.riskCategory } : { accepted: false, reason: 'unparseable event' };
  }
}
