import assert from 'node:assert/strict';
import { buildLocalTraceRows } from '../apps/web/src/lib/local-record-trace.ts';

const event = (kind, id, offset, extra={}) => ({kind,eventId:id,sourceOffset:offset,timestamp:1000+offset,title:kind,turnId:'t1',...extra});
const events = [event('turn_start','start',1),event('user_message','user',2,{content:'hello'}),
  event('tool_call','call',3,{callId:'same-call',toolName:'Shell',content:'{"command":"false"}'}),
  event('tool_result','result',4,{callId:'same-call',content:'exit 7',status:'failure',durationMs:1}),
  event('assistant_message','reply',5,{content:'failed command'}),event('turn_complete','end',6),
  event('tool_call','second',7,{turnId:'t2',callId:'same-call',toolName:'Shell'}),
  event('tool_result','orphan',8,{turnId:'t3',callId:'same-call',content:'do not cross-pair',status:'success'})];
const detail = {record:{sessionId:'session-a'},events,observedLlmRequests:[],
  toolEvidence:{nativeSessionId:'session-a',calls:[{callEventId:'call',callId:'same-call',status:'candidate',candidates:[{eventId:'sys'}],confirmedEventIds:[]}]},
  systemEvidence:{binding:{nativeSessionId:'session-a'},events:[{eventId:'sys',at:1003,eventKind:'ToolExec',subject:'false',pid:123,traceId:'real-trace',verdict:'allow'}],exceptions:[]}};
const before=JSON.stringify(detail);
const rows=buildLocalTraceRows(detail);
assert.equal(JSON.stringify(detail),before,'projection never mutates capture data');
assert.equal(rows.find(r=>r.id==='tool:call').output,'exit 7');
assert.equal(rows.find(r=>r.id==='tool:call').status,'失败');
assert.equal(rows.find(r=>r.id==='tool:call').association,'候选 1 条');
assert.equal(rows.find(r=>r.id==='tool:second').output,undefined,'same call ID in another Turn cannot match');
assert.ok(rows.some(r=>r.id==='result:orphan'),'unmatched results stay visible');
assert.equal(rows.filter(r=>r.type==='MODEL').length,0,'local replies never become model capture');
assert.equal(rows.find(r=>r.id==='turn:t1').durationMs,5);
assert.equal(rows.find(r=>r.id==='turn:t2').durationMs,undefined,'partial Turn has no invented duration');
assert.equal(rows.find(r=>r.id==='turn:t1').traceId,undefined,'Turn ID must not become trace ID');
assert.equal(rows.find(r=>r.id==='system:sys').traceId,'real-trace');

const duplicate=buildLocalTraceRows({...detail,events:[...events,event('tool_call','duplicate',3.5,{callId:'same-call'})]});
assert.equal(duplicate.find(r=>r.id==='tool:call').output,undefined,'duplicate calls must not arbitrarily claim one result');
assert.ok(duplicate.some(r=>r.id==='result:result'));
const missingEvidence=buildLocalTraceRows({...detail,systemEvidence:undefined});
assert.equal(missingEvidence.find(r=>r.id==='tool:call').association,'未核验','old projection cannot stand in for missing evidence');
const requests=[{interactionId:'request',observedAt:1050,model:'codex-auto-review',sessionId:'review-session',threadId:'review-thread',turnId:'review-turn',pid:9,content:'secret-stale',contentAvailability:'not_authorized',capture:{method:'ebpf_rustls'}}];
const observer=buildLocalTraceRows({...detail,observedLlmRequests:requests});
const request=observer.find(r=>r.type==='MODEL');
assert.equal(request.input,undefined,'body permission is respected');
assert.equal(request.output,undefined,'local AI reply cannot be attached to captured request');
assert.equal(request.sessionId,'review-session');
assert.equal(request.turnId,'review-turn');
assert.equal(request.metadata.requestScope,'auto_review');
assert.equal(request.association,'独立请求');
assert.ok(!JSON.stringify(request).includes('secret-stale'));
assert.ok(!observer.some(r=>r.id==='turn:review-turn'),'independent request cannot fabricate a native Turn');
assert.equal(new Set(rows.map(r=>r.id)).size,rows.length);
const { readFile } = await import('node:fs/promises');
const tracePanelSource = await readFile(new URL('../apps/web/src/components/custom/local-record-trace.tsx', import.meta.url), 'utf8');
assert.match(tracePanelSource, /data-trace-system-only/u);
assert.match(tracePanelSource, /setTypes\(\["SYSTEM"\]\)/u);
console.log(JSON.stringify({pass:true,uniquePairing:true,duplicateAndPartialGuards:true,observerProvenance:true,noInventedTraceOrDuration:true,systemEventShortcut:true}));
