// Regression for the real Harbor failure: worker TIDs were exported as parent process IDs.
// Read-only/in-memory: no API, ClickHouse, PostgreSQL or historical relation writes.
import assert from 'node:assert/strict';
import { SessionEventAttributionService } from '../apps/api/dist/security-monitoring/session-event-attribution.service.js';

const service = new SessionEventAttributionService();
const at = 1_788_975_800_000;
const root = {
  factId: 'root-fact', eventId: 'root-event', factKind: 'exec',
  processInstanceKey: 'root-generation', pid: 2341360, ppid: 2341291,
  hostId: 'host-a', bootId: 'boot-a', pidNamespace: 'container-a',
  startTime: 'ticks:3925637', at,
};
const child = {
  ...root, factId: 'child-fact', eventId: 'child-event',
  processInstanceKey: 'child-generation', pid: 2342792, ppid: 2341364,
  pidNamespace: undefined, startTime: 'ticks:3926725', at: at + 10_000,
};
const binding = {
  bindingId: 'session-a-binding', nativeSessionId: 'session-a',
  hostId: root.hostId, bootId: root.bootId, matchedPid: root.pid,
  matchedStartTime: root.startTime, matchedOsProcessInstanceKey: root.processInstanceKey,
  validFrom: at,
};
const edges = (facts, bindings = [binding]) => service.lineageEdges(facts, bindings);
assert.equal(edges([root, child]).length, 0, 'a worker TID must not be guessed to belong to the root');
const corrected = { ...child, ppid: root.pid };
const fixed = edges([root, corrected]);
assert.equal(fixed.length, 1);
assert.equal(fixed[0].parentProcessInstanceKey, root.processInstanceKey);
assert.equal(fixed[0].childProcessInstanceKey, child.processInstanceKey);
assert.equal(service.descendantIndex(fixed, [binding]).get(binding.bindingId).has(child.processInstanceKey), true);

// Same namespace-local parent number is not a host PID identity.
assert.equal(edges([root, { ...corrected, ppid: 4506 }]).length, 0);
assert.equal(edges([root, { ...corrected, hostId: 'host-b' }]).length, 0);
assert.equal(edges([root, { ...corrected, bootId: 'boot-b' }]).length, 0);
assert.equal(edges([root, { ...corrected, startTime: 'ticks:3925636' }]).length, 0);
assert.equal(edges([root, { ...corrected, startTime: undefined }]).length, 0);
assert.equal(edges([root, { ...root, factKind: 'exit', at: at + 1 }, corrected]).length, 0);

const otherRoot = { ...root, pid: 3333333, processInstanceKey: 'other-root', pidNamespace: 'container-b' };
const otherBinding = { ...binding, bindingId: 'session-b-binding', matchedPid: otherRoot.pid,
  matchedOsProcessInstanceKey: otherRoot.processInstanceKey };
const family = service.descendantIndex(edges([root, otherRoot, corrected], [binding, otherBinding]), [binding, otherBinding]);
assert.equal(family.get(binding.bindingId).has(child.processInstanceKey), true);
assert.equal(family.get(otherBinding.bindingId).has(child.processInstanceKey), false);
console.log('PASS: Harbor host-TGID repair restores lineage without guessing TIDs, local PIDs, stale generations or other sessions');
