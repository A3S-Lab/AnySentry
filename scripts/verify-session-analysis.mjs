import assert from 'node:assert/strict';
import { buildSessionAnalysis, normalizeAnalysisTokens, estimateAnalysisCost, distribution } from '../apps/web/src/lib/local-record-analysis.ts';

const usage = { inputTokens: 100, cachedInputTokens: 80, outputTokens: 20, reasoningOutputTokens: 5, totalTokens: 120 };
const codex = normalizeAnalysisTokens('codex', usage);
assert.equal(codex.accounted, 120, 'cache and reasoning must not be counted twice');
assert.equal(codex.uncached, 20);
assert.equal(estimateAnalysisCost(codex, ['10', '1', '20']), .00068);
assert.equal(estimateAnalysisCost(codex, ['', '1', '20']), undefined, 'missing prices are not free');
assert.equal(estimateAnalysisCost(codex, ['-1', '1', '20']), undefined);
assert.equal(estimateAnalysisCost(codex, ['Infinity', '1', '20']), undefined);
assert.equal(estimateAnalysisCost(codex, ['0', '0', '0']), 0);
assert.equal(normalizeAnalysisTokens('claude_code', { ...usage, totalTokens: 200 }).consistent, true);
assert.equal(normalizeAnalysisTokens('gemini_cli', { ...usage, totalTokens: 125 }).consistent, true);
assert.equal(normalizeAnalysisTokens('opencode', usage).consistent, true);
assert.equal(estimateAnalysisCost(normalizeAnalysisTokens('codex', { ...usage, totalTokens: 121 }), ['1', '1', '1']), undefined);
assert.deepEqual(distribution([undefined, NaN, -1, 0, 10, 20]), { count: 3, p50: 10, p95: 20, max: 20 });
assert.equal(distribution([]).p95, undefined);

const ev = (kind, id, offset, extra = {}) => ({ eventId: id, kind, title: kind, timestamp: 1000 + offset, sourceOffset: offset, turnId: 't1', ...extra });
const events = [ev('turn_start','s',1), ev('tool_call','a',2,{callId:'call',toolName:'Shell'}),
  ev('tool_result','b',3,{callId:'call',status:'failure'}), ev('turn_complete','e',4,{durationMs:3}),
  ev('tool_call','c',5,{turnId:'t2',callId:'call',toolName:'Shell'}),
  ev('tool_result','d',6,{turnId:'t3',callId:'call',status:'success'})];
const detail = { record: { sessionId:'session', adapter:'codex', tokenUsage:usage }, events,
  metrics:{tokenUsage:usage}, observedLlmRequests:[], toolEvidence: {nativeSessionId:'session',calls:[{callEventId:'a',callId:'call',status:'candidate',candidates:[{eventId:'sys'}]}]},
  systemEvidence:{binding:{nativeSessionId:'session'},events:[{eventId:'sys',at:1002,eventKind:'ToolExec',processInstanceKey:'pid:1:g1',verdict:'allow'}],exceptions:[]} };
const original = JSON.stringify(detail);
const result = buildSessionAnalysis(detail, [...events,events[0]]);
assert.equal(result.events.length,events.length);
assert.equal(result.calls.length,2);
assert.equal(result.failure,1);
assert.equal(result.unknown,1);
assert.equal(result.failureRate,1,'only known results form failure-rate denominator');
assert.equal(result.orphanResults,1,'same call id in another turn is not a pair');
assert.equal(result.latency.tool.count,1);
assert.equal(result.confirmed,0,'candidates never become trusted');
assert.equal(result.candidate,1);
assert.equal(result.system.length,1,'native tools never become kernel events');
assert.equal(result.completedDuration,3);
assert.equal(JSON.stringify(detail),original);
const wrongSession=buildSessionAnalysis({...detail, systemEvidence:{...detail.systemEvidence,binding:{nativeSessionId:'other'}}});
assert.equal(wrongSession.system.length,0);
assert.equal(wrongSession.candidate,0);
const empty=buildSessionAnalysis({...detail,events:[],systemEvidence:undefined});
assert.equal(empty.failureRate,undefined);
assert.equal(empty.completedDuration,undefined);
assert.equal(empty.latency.tool.p95,undefined);
console.log('Session analysis: token semantics, cost guards, latency samples, unique pairing, partial data and evidence isolation passed.');
