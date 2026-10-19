import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { buildLocalToolEvidence, staticToolCommands, observedCommandHash } from '../apps/api/dist/security-monitoring/local-tool-evidence.js';
import { indexToolSystemEvidence } from '../apps/web/src/lib/tool-system-evidence.ts';

const call = { eventId: 'call-event', callId: 'call-a', turnId: 'turn-a', kind: 'tool_call', timestamp: 1000,
  content: `text(await tools.exec_command({cmd:"/usr/bin/printf 'hello'; /usr/bin/sleep 15",yield_time_ms:20000}));` };
const result = { ...call, eventId: 'result', kind: 'tool_result', timestamp: 2000 };
const command = "/usr/bin/printf 'hello'; /usr/bin/sleep 15";
const shell = { eventId: 'shell', eventKind: 'ToolExec', processInstanceKey: 'pri-shell', at: 1100,
  command: `/usr/bin/bash -c ${command}` };
const child = { eventId: 'child', eventKind: 'ToolExec', processInstanceKey: 'pri-child', at: 1200,
  command: '/usr/bin/printf hello' };
const edge = { edgeId: 'edge', parentProcessInstanceKey: 'pri-shell', childProcessInstanceKey: 'pri-child', validFrom: 1150 };
const evidence = { binding: { nativeSessionId: 'session-a' }, events: [shell, child], lineage: [edge],
  completeness: 'complete_as_observed', page: { hasMore: false } };
const build = (timeline = [call, result], ev = evidence) => buildLocalToolEvidence('session-a', timeline, ev);

const cwdScript = `cd '/workspace' && ${command}`;
const cwdShell = { ...shell, command: `/bin/bash -c ${cwdScript}`,
  commandHash: createHash('sha256').update(cwdScript).digest('hex') };
const cwdEvidence = build([call, result], { ...evidence, events: [cwdShell, child] });
assert.equal(cwdEvidence.calls[0].status, 'candidate');
assert.equal(cwdEvidence.calls[0].confirmedEventIds.length, 0, 'cwd wrappers never promote a candidate to trusted binding');
assert.equal(build([call, result], { ...evidence, events: [{ ...cwdShell, command: cwdShell.command.slice(0, 55) }] }).calls[0].status,
  'candidate', 'a capped display must not discard equality proved by the complete kernel script hash');
assert.equal(build([call, result], { ...evidence, events: [{ ...cwdShell, commandHash: undefined }] }).calls[0].status, 'unmatched');
assert.equal(build([call, result], { ...evidence, events: [{ ...cwdShell, commandHash: '0'.repeat(64) }] }).calls[0].status, 'unmatched');
assert.equal(build([call, result], { ...evidence, events: [{ ...cwdShell, command: `/bin/bash -c cd '/workspace'; ${command}` }] }).calls[0].status, 'unmatched');

assert.deepEqual(staticToolCommands(call), [command]);
assert.deepEqual(staticToolCommands({ ...call, content: `tools.exec_command({yield_time_ms:1000,cmd:'printf "x"'})` }), ['printf "x"']);
assert.deepEqual(staticToolCommands({ ...call, content: '{"cmd":"echo hi","tty":false}' }), ['echo hi']);
for (const content of [
  '// tools.exec_command({cmd:"malicious"})',
  'const x = "tools.exec_command({cmd:\\"malicious\\"})";',
  'const x = /tools.exec_command({cmd:"malicious"})/;',
  '`tools.exec_command({cmd:"malicious"})`',
  'tools.exec_command({cmd:"prefix" + secret})',
  'tools.exec_command({cmd:"good",...override})',
  'tools.exec_command({cmd:"good",cmd:dynamic})',
  'tools.exec_command({cmd:dynamic})',
  'obj.tools.exec_command({cmd:"unrelated"})',
]) assert.deepEqual(staticToolCommands({ ...call, content }), [], content);
let projection = build();
assert.equal(projection.calls[0].status, 'candidate');
assert.deepEqual(projection.calls[0].candidates, [
  { eventId: 'shell', anchorEventId: 'shell', reason: 'shell_wrapper' },
  { eventId: 'child', anchorEventId: 'shell', reason: 'process_lineage' },
]);
assert.deepEqual(projection.calls[0].confirmedEventIds, []);
const fullCommand = `printf '${'long-command-'.repeat(100)}'\n`;
const commandHash = createHash('sha256').update(fullCommand).digest('hex');
const longCall = { ...call, content: JSON.stringify({cmd:fullCommand}) };
const hashMatch = build([longCall,result],{...evidence,events:[{...shell,command:fullCommand.slice(0,300),commandHash}]});
assert.equal(hashMatch.calls[0].candidates[0].reason,'command_hash','display truncation must not break complete-command equality');
assert.equal(hashMatch.calls[0].confirmedEventIds.length,0);
const attrs={'anysentry.kernel.command_hash':commandHash,exec_confirmed:true,argv_truncated:false,argv_incomplete:false};
assert.equal(observedCommandHash(attrs),commandHash);
for(const patch of [{argv_truncated:true},{argv_incomplete:true},{exec_confirmed:false},{exec_confirmed:undefined}])
  assert.equal(observedCommandHash({...attrs,...patch}),undefined,'incomplete capture must not supply a hash equality key');
const before = JSON.stringify({ call, result, evidence }); build();
assert.equal(JSON.stringify({ call, result, evidence }), before, 'facts remain immutable');
assert.equal(build([call]).calls[0].status, 'pending');
assert.equal(build([call, { ...result, turnId: 'different' }]).calls[0].status, 'pending');
assert.equal(build([call, result], { ...evidence, binding: { nativeSessionId: 'other' } }).calls[0].candidates.length, 0);
assert.equal(build([call, result], { ...evidence, events: [{ ...shell, at: 5000 }] }).calls[0].candidates.length, 0);
assert.equal(build([call, result], { ...evidence, events: [{ ...shell, command: 'printf unrelated' }] }).calls[0].candidates.length, 0);
assert.equal(build([call, result], { ...evidence, lineage: [{ ...edge, validTo: 1199 }] }).calls[0].candidates.length, 1);
assert.equal(build([call, result], { ...evidence, events: [shell, { ...child, processInstanceKey: 'reused-pid-new-generation' }] }).calls[0].candidates.length, 1);
assert.equal(build([call, result], { ...evidence, events: [shell, { ...child, at: 2251 }] }).calls[0].candidates.length, 1);
assert.equal(build([call, result], { ...evidence, events: [{ ...shell, toolCallBinding: { method: 'authenticated_agent_adapter', toolCallId: 'other' } }, child] }).calls[0].candidates.length, 0);
const trusted = build([call, result], { ...evidence, events: [{ ...shell, toolCallBinding: { method: 'authenticated_agent_adapter', toolCallId: call.callId } }] });
assert.equal(trusted.calls[0].status, 'confirmed');
assert.deepEqual(trusted.calls[0].confirmedEventIds, ['shell']);
assert.equal(buildLocalToolEvidence('session-a', [call, result], evidence, true).partial, true);
assert.equal(indexToolSystemEvidence('session-a', [call, result], { ...evidence, events: [] }, build()).byEvent.get(call.eventId).sessionAssociated, false);
projection = build([call, result, { ...call, eventId: 'call-b', callId: 'call-b' }, { ...result, callId: 'call-b' }]);
assert.ok(projection.calls.every(c => c.status === 'ambiguous' && !c.confirmedEventIds.length));
assert.equal(build([call, result, { ...call, eventId: 'duplicate' }]).calls[0].candidates.length, 0);
const index = indexToolSystemEvidence('session-a', [call, result], evidence, build());
assert.equal(index.confirmedEvents, 0); assert.equal(index.candidateEvents, 2); assert.equal(index.unassigned.length, 2);
assert.equal(indexToolSystemEvidence('session-a', [call, result], evidence, { ...build(), nativeSessionId: 'other' }).candidateEvents, 0);
assert.equal(indexToolSystemEvidence('session-a', [{ ...call, eventId: 'older' }, result], evidence, build()).byEvent.get('older').checked, false);
if (process.argv[2]) {
  const detail = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const p = buildLocalToolEvidence(detail.record.sessionId, detail.events, detail.systemEvidence, detail.page.hasMore);
  assert.equal(p.calls.length, 4);
  assert.ok(p.calls.every(c => c.status === 'candidate' && c.candidates.length > 0 && c.confirmedEventIds.length === 0));
  console.log(JSON.stringify({ realCapturedReplay: true, candidatesByCall: p.calls.map(c => ({ callId: c.callId, count: c.candidates.length })) }));
}
console.log('PASS: static parsing, shell wrappers, generation-safe lineage, Session isolation, concurrent ambiguity, no promotion, incomplete windows and real capture replay');
