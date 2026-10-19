import assert from 'node:assert/strict';
import { InteractionService } from '../apps/api/dist/security-monitoring/interaction.service.js';

const record = {eventType: 'AgentInputObserved', interactionId: 'request-1', observedAt: 1,
  runtime: {runtimeType: 'codex_ebpf_rustls', sessionId: 'session-1'}};
let enabled = true;
let reads = 0;
let result = {content: ''};
let fail = false;
const context = {
  loadRecords: async () => [record, {...record, interactionId: 'foreign', runtime: {...record.runtime, sessionId: 'other'}}],
  contents: {directViewEnabled: () => enabled, read: async () => {
    reads++;
    if (fail) throw new Error('temporary read failure');
    return result;
  }},
};
const query = (includeContent) => InteractionService.prototype.instructionsForRuntimeSession.call(context, 'session-1', {includeContent});
assert.equal((await query(false))[0].contentAvailability, 'not_requested');
assert.equal(reads, 0);
enabled = false;
assert.equal((await query(false))[0].contentAvailability, 'not_requested');
assert.equal((await query(true))[0].contentAvailability, 'not_authorized');
assert.equal(reads, 0);
enabled = true;
assert.deepEqual(await query(true), [{record, contentAvailability:'available', content:''}]);
result = null;
assert.equal((await query(true))[0].contentAvailability, 'deleted');
fail = true;
assert.equal((await query(true))[0].contentAvailability, 'unavailable');
console.log('PASS: metadata-only, authorization, empty body, deletion, read failure and Session isolation');
