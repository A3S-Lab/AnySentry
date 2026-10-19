import assert from 'node:assert/strict';
import { indexToolSystemEvidence, literalToolCommands } from '../apps/web/src/lib/tool-system-evidence.ts';
import { systemToolCallBinding } from '../apps/api/dist/security-monitoring/system-tool-call-binding.js';

const trusted = {
  schemaVersion:'anysentry.trusted_correlation.v1', identityVersion:'trusted_correlation.v1',
  method:'agent_adapter', scope:'invocation', authority:'authenticated_agent_adapter',
  confidence:1, inferred:false, traceOrigin:'adapter', invocationId:'inv-a', toolCallId:'call-a',
  provenance:['source_authenticated','source_scope_bound','adapter_invocation','adapter_tool_call'],
  claimReceipts:[{kind:'agent_adapter',decision:'accepted',reason:'authorized'}],
};
const beforeMode = process.env.ANYSENTRY_TRUSTED_CORRELATION_MODE;
try {
  process.env.ANYSENTRY_TRUSTED_CORRELATION_MODE='off';
  assert.equal(systemToolCallBinding(trusted),undefined);
  process.env.ANYSENTRY_TRUSTED_CORRELATION_MODE='enabled';
  assert.deepEqual(systemToolCallBinding(trusted),{method:'authenticated_agent_adapter',toolCallId:'call-a',invocationId:'inv-a'});
  for (const value of [undefined,{toolCallId:'call-a'}, {...trusted,inferred:true}, {...trusted,claimReceipts:[]}, {...trusted,authority:'inferred'}, {...trusted,toolCallId:undefined}]) {
    assert.equal(systemToolCallBinding(value),undefined);
  }
} finally {
  if (beforeMode === undefined) delete process.env.ANYSENTRY_TRUSTED_CORRELATION_MODE;
  else process.env.ANYSENTRY_TRUSTED_CORRELATION_MODE=beforeMode;
}
const call = {eventId:'call-event-a',kind:'tool_call',callId:'call-a',turnId:'turn-a',timestamp:1000,sourceOffset:1,content:'text(await tools.exec_command({cmd:"/usr/bin/printf marker",max_output_tokens:100}));'};
const result = {...call,eventId:'result-a',kind:'tool_result',timestamp:2000,sourceOffset:2};
const event = {eventId:'sys-a',eventKind:'ToolExec',at:1500,command:'/usr/bin/printf marker',processInstanceKey:'pri-a',relation:'LINEAGE'};
const evidence = {binding:{nativeSessionId:'session-a'},events:[event]};
const original=JSON.stringify({call,result,evidence});
let index = indexToolSystemEvidence('session-a',[call,result],evidence);
assert.equal(index.confirmedEvents,0);
assert.equal(index.candidateEvents,1);
assert.equal(index.unassigned.length,1,'candidate remains unassigned');
assert.equal(JSON.stringify({call,result,evidence}),original,'never mutate facts');
assert.deepEqual(literalToolCommands(call),['/usr/bin/printf marker']);
assert.deepEqual(literalToolCommands({...call,content:'tools.exec_command({cmd:danger()})'}),[]);
assert.deepEqual(literalToolCommands({...call,content:'tools.exec_command({cmd:"prefix" + secret})'}),[]);
assert.deepEqual(literalToolCommands({...call,content:'tools.exec_command({cmd:"printf \\"hello\\""})'}),['printf "hello"']);
assert.equal(indexToolSystemEvidence('other',[call,result],evidence).candidateEvents,0,'Session scope enforced');
assert.equal(indexToolSystemEvidence('session-a',[call],evidence).candidateEvents,0,'no invented end time');
assert.equal(indexToolSystemEvidence('session-a',[call,{...result,callId:'other'}],evidence).candidateEvents,0,'result paired by Call ID');
assert.equal(indexToolSystemEvidence('session-a',[call,result],{...evidence,events:[{...event,command:'unrelated'}]}).candidateEvents,0,'time alone insufficient');
assert.equal(indexToolSystemEvidence('session-a',[call,result],{...evidence,events:[{...event,at:3000}]}).candidateEvents,0,'outside call window');
const bound={...event,toolCallBinding:{method:'authenticated_agent_adapter',toolCallId:'call-a'}};
index=indexToolSystemEvidence('session-a',[call,result],{...evidence,events:[bound,bound]});
assert.equal(index.confirmedEvents,1,'event ID dedupe');
assert.equal(index.unassigned.length,0);
index=indexToolSystemEvidence('session-a',[call,result,{...call,eventId:'call-b',turnId:'turn-b'}],{...evidence,events:[bound]});
assert.equal(index.confirmedEvents,0,'reused Call ID across Turns is ambiguous');
assert.equal(index.unassigned.length,1);
index=indexToolSystemEvidence('session-a',[call,result],{...evidence,events:[{...bound,toolCallBinding:{...bound.toolCallBinding,toolCallId:'another'}}]});
assert.equal(index.candidateEvents,0,'conflicting explicit binding cannot fall back to heuristics');
index=indexToolSystemEvidence('session-a',[call,result,{...call,eventId:'call-b',callId:'call-b'},{...result,eventId:'result-b',callId:'call-b'}],evidence);
assert.equal(index.candidateEvents,1,'concurrent candidates deduped in total');
assert.equal(index.byEvent.get('call-b').candidates.length,1);
assert.equal(index.confirmedEvents,0,'concurrent same-command never confirmed');
console.log('PASS: trusted projection/rollout, Session isolation, literal extraction, exact Call/result, ambiguity, candidate-only matching, dedupe and immutability');
