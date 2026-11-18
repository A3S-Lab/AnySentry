import type { LocalRecordDetail, LocalRecordTimelineEvent, LocalRecordTokenUsage } from './api/security-center';
import { buildLocalTraceRows } from './local-record-trace.ts';

const finite = (n: number | undefined) => n !== undefined && Number.isFinite(n) && n >= 0;
const count = (n: number | undefined) => finite(n) ? n! : 0;
export function distribution(values: Array<number | undefined>) {
  const sorted = values.filter((n): n is number => finite(n)).sort((a, b) => a - b);
  const percentile = (p: number) => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] : undefined;
  return { count: sorted.length, p50: percentile(.5), p95: percentile(.95), max: sorted.at(-1) };
}

/** Convert adapter-specific counters into disjoint display categories; never add reasoning twice. */
export function normalizeAnalysisTokens(adapter: LocalRecordDetail['record']['adapter'], usage: LocalRecordTokenUsage) {
  const input = count(usage.inputTokens), cached = count(usage.cachedInputTokens), output = count(usage.outputTokens);
  const includedCache = adapter !== 'claude_code';
  const uncached = includedCache ? Math.max(0, input - cached) : input;
  const reasoningSeparate = adapter === 'gemini_cli';
  const reasoning = reasoningSeparate ? count(usage.reasoningOutputTokens) : 0;
  const parts = [
    { key: 'input', label: '非缓存输入', value: uncached },
    { key: 'cache', label: '缓存输入', value: cached },
    { key: 'output', label: '输出', value: output },
    ...(reasoningSeparate ? [{ key: 'reasoning', label: '推理', value: reasoning }] : []),
  ];
  const accounted = parts.reduce((sum, part) => sum + part.value, 0);
  const total = count(usage.totalTokens);
  // Do not silently reconstruct reported totals: adapters may have incomplete usage metadata.
  const consistent = total > 0 && accounted === total && (!includedCache || cached <= input);
  return { parts, total, accounted, consistent, uncached, cached, billableOutput: output + reasoning,
    reasoning: count(usage.reasoningOutputTokens), cacheIncludesWrites: ['claude_code', 'kimi_cli', 'opencode'].includes(adapter) };
}

export function estimateAnalysisCost(tokens: ReturnType<typeof normalizeAnalysisTokens>, rates: string[]) {
  if (!tokens.consistent || rates.length !== 3 || rates.some(rate => !rate.trim() || !finite(Number(rate)))) return undefined;
  const [input, cache, output] = rates.map(Number);
  const estimate = (tokens.uncached * input + tokens.cached * cache + tokens.billableOutput * output) / 1_000_000;
  return Number.isFinite(estimate) ? estimate : undefined;
}

export function buildSessionAnalysis(detail: LocalRecordDetail, loadedEvents = detail.events) {
  const events = [...new Map(loadedEvents.map(event => [event.eventId, event])).values()];
  const rows = buildLocalTraceRows(detail, events);
  const calls = rows.filter(row => row.type === 'TOOL' && row.id.startsWith('tool:'));
  const tools = new Map<string, { name: string; calls: number; success: number; failure: number; unknown: number; durations: number[] }>();
  for (const row of calls) {
    const tool = tools.get(row.name) ?? { name: row.name, calls: 0, success: 0, failure: 0, unknown: 0, durations: [] };
    tool.calls++;
    if (row.status === '失败') tool.failure++;
    else if (row.status === '成功') tool.success++;
    else tool.unknown++;
    if (finite(row.durationMs)) tool.durations.push(row.durationMs!);
    tools.set(row.name, tool);
  }
  const completed = events.filter(event => event.kind === 'turn_complete');
  const turnRows = rows.filter(row => row.type === 'TURN');
  const turnDurations = completed.map(event => finite(event.durationMs) ? event.durationMs
    : turnRows.find(row => row.turnId === event.turnId)?.durationMs).filter((value): value is number => finite(value));
  const success = calls.filter(row => row.status === '成功').length;
  const failure = calls.filter(row => row.status === '失败').length;
  const evidence = detail.systemEvidence?.binding.nativeSessionId === detail.record.sessionId ? detail.systemEvidence : undefined;
  const system = [...new Map((evidence?.events ?? []).map(event => [event.eventId, event])).values()];
  const processKeys = new Set(system.map(event => event.processInstanceKey).filter(Boolean));
  const categories = new Map<string, number>();
  for (const event of system) categories.set(event.eventKind, (categories.get(event.eventKind) ?? 0) + 1);
  const links = detail.toolEvidence?.nativeSessionId === detail.record.sessionId && evidence
    ? detail.toolEvidence.calls.filter(link => calls.some(row => row.eventId === link.callEventId && row.callId === link.callId)) : [];
  const confirmed = links.filter(link => link.status === 'confirmed').length;
  const candidate = links.filter(link => link.status === 'candidate' || link.status === 'ambiguous').length;
  const usage = detail.metrics.tokenUsage.totalTokens > 0 ? detail.metrics.tokenUsage : detail.record.tokenUsage;
  return {
    events, rows, calls, success, failure, unknown: calls.length - success - failure,
    failureRate: success + failure > 0 ? failure / (success + failure) : undefined,
    orphanResults: rows.filter(row => row.id.startsWith('result:')).length,
    users: events.filter(event => event.kind === 'user_message').length,
    replies: events.filter(event => event.kind === 'assistant_message').length,
    turns: new Set(events.map(event => event.turnId).filter(Boolean)).size,
    completed: completed.length,
    completedDuration: turnDurations.length ? turnDurations.reduce((a, b) => a + b, 0) : undefined,
    latency: { turn: distribution(turnDurations), tool: distribution(calls.map(row => row.durationMs)),
      ttft: distribution(completed.map(event => event.timeToFirstTokenMs)) },
    tools: [...tools.values()].sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name)),
    tokens: normalizeAnalysisTokens(detail.record.adapter, usage), usage,
    evidence, system, processes: processKeys.size, categories: [...categories].sort((a, b) => b[1] - a[1]),
    confirmed, candidate, unchecked: calls.length - confirmed - candidate,
    blocked: system.filter(event => /^(deny|block|blocked)$/i.test(event.verdict)).length,
    models: [...new Set(rows.filter(row => row.type === 'MODEL' && row.association === '主会话请求').map(row => row.model).filter(Boolean))],
  };
}

export type SessionAnalysis = ReturnType<typeof buildSessionAnalysis>;
export type AnalysisEvent = LocalRecordTimelineEvent;
