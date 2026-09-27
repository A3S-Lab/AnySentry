#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { FileAccessAggregator } = require('./observer-file-aggregation.js');

const agentClassification = {
  state: 'agent',
  attribution: { classification: 'confirmed_agent', agentInstanceId: 'agent-1' },
};
const unknownClassification = {
  state: 'unknown',
  attribution: { classification: 'unknown' },
};

function record({
  filePath = '/workspace/cache.json',
  pid = 10,
  start = '100',
  hostId = 'node',
  bootId = 'boot',
  cgroupId = '42',
  cgroup = '0::/docker/container-42',
  write = true,
  flags = 1,
  classification = agentClassification,
  activity,
  filterDecision,
  fileExtra = {},
  processExtra = {},
  representedEvents,
} = {}) {
  const observerEvent = {
    identity: { agent: 'runtime', task: String(pid), session: 'session-1' },
    process: {
      hostId,
      bootId,
      pid,
      ppid: 1,
      startTimeTicks: start,
      cgroupId,
      cgroup,
      comm: 'worker',
      exe: '/usr/bin/worker',
      ...processExtra,
    },
    event: { FileAccess: { pid, path: filePath, write, flags, ...fileExtra } },
  };
  return {
    observerEvent,
    classification,
    activity,
    filterDecision,
    ...(representedEvents === undefined ? {} : { representedEvents }),
    line: JSON.stringify(observerEvent),
  };
}

let now = 1_000;
const emitted = [];
const aggregator = new FileAccessAggregator({ now: () => now, windowMs: 100, autoSchedule: false });
for (let index = 0; index < 100; index++) {
  aggregator.push(record(), (item) => emitted.push(item));
  now += 0.5;
}
assert.equal(emitted.length, 0);
now += 100;
aggregator.flushExpired();
assert.equal(emitted.length, 1);
const aggregatedFile = emitted[0].observerEvent.event.FileAccess;
assert.equal(aggregatedFile.repeatCount, 100);
assert.equal(aggregatedFile.repeat_count, 100);
assert.equal(aggregatedFile.firstEventAt, new Date(1_000).toISOString());
assert.equal(aggregatedFile.first_event_at, aggregatedFile.firstEventAt);
assert.equal(aggregatedFile.lastEventAt, new Date(1_049.5).toISOString());
assert.equal(aggregatedFile.last_event_at, aggregatedFile.lastEventAt);
assert.equal(aggregatedFile.aggregationWindowMs, 100);
assert.equal(aggregatedFile.aggregation_window_ms, 100);
assert.equal(emitted[0].representedEvents, 100);

aggregator.push(record({ filePath: '/etc/shadow' }), (item) => emitted.push(item));
assert.equal(emitted.length, 2, 'sensitive paths must bypass aggregation');
aggregator.push(record({ pid: 11, start: '101' }), (item) => emitted.push(item));
aggregator.flushAll();
assert.equal(emitted.length, 3, 'different process generations must not coalesce');
assert.equal(aggregator.metrics().coalesced, 99);

const cachedProcessEmitted = [];
const cachedProcessAggregator = new FileAccessAggregator({ now: () => now, windowMs: 100, autoSchedule: false });
const missingStart = record({ filePath: '/workspace/from-cache.json', pid: 12, start: '' });
cachedProcessAggregator.push(
  { ...missingStart, processStartTime: '102' },
  (item) => cachedProcessEmitted.push(item),
);
cachedProcessAggregator.push(
  { ...missingStart, processStartTime: '102' },
  (item) => cachedProcessEmitted.push(item),
);
cachedProcessAggregator.flushAll();
assert.equal(cachedProcessEmitted.length, 1, 'the shared ProcessTree start time should unlock safe aggregation');
assert.equal(cachedProcessEmitted[0].representedEvents, 2);

const unknownEmitted = [];
const unknownAggregator = new FileAccessAggregator({ now: () => now, windowMs: 100, autoSchedule: false });
for (let index = 0; index < 7; index++) {
  unknownAggregator.push(
    record({
      filePath: '/workspace/unknown-cache.json',
      pid: 20,
      start: '200',
      cgroupId: '84',
      cgroup: '0::/docker/unknown-84',
      classification: unknownClassification,
    }),
    (item) => unknownEmitted.push(item),
  );
  now += 1;
}
unknownAggregator.flushAll();
assert.equal(unknownEmitted.length, 1, 'strictly identical Unknown FileAccess should aggregate');
assert.equal(unknownEmitted[0].representedEvents, 7);
assert.equal(unknownEmitted[0].observerEvent.event.FileAccess.repeatCount, 7);
assert.equal(unknownEmitted[0].classification.state, 'unknown');

function assertDoesNotCoalesce(label, left, right) {
  const outputs = [];
  const candidate = new FileAccessAggregator({ now: () => now, windowMs: 100, autoSchedule: false });
  candidate.push(left, (item) => outputs.push(item));
  candidate.push(right, (item) => outputs.push(item));
  candidate.flushAll();
  assert.equal(outputs.length, 2, label);
  assert.equal(outputs.reduce((total, item) => total + (item.representedEvents ?? 1), 0), 2);
}

const strictBase = {
  filePath: '/workspace/strict.json',
  pid: 30,
  start: '300',
  cgroupId: '126',
  cgroup: '0::/docker/strict-126',
  classification: unknownClassification,
};
for (const [label, change] of [
  ['different hostId', { hostId: 'other-node' }],
  ['different bootId', { bootId: 'other-boot' }],
  ['different pid', { pid: 31 }],
  ['different process generation', { start: '301' }],
  ['different parent process', { processExtra: { ppid: 2 } }],
  ['different executable context', { processExtra: { exe: '/usr/bin/other' } }],
  ['different cgroup id', { cgroupId: '127' }],
  ['different cgroup path', { cgroup: '0::/docker/strict-other' }],
  ['different path', { filePath: '/workspace/strict-other.json' }],
  ['different write operation', { write: false }],
  ['different flags', { flags: 2 }],
  ['different extra operation semantics', { fileExtra: { operation: 'truncate' } }],
  ['different activity semantics', { activity: { activityContext: 'agent_action' } }],
  ['different filter decision', { filterDecision: { action: 'keep', ruleVersion: 2 } }],
]) {
  assertDoesNotCoalesce(label, record(strictBase), record({ ...strictBase, ...change }));
}
assertDoesNotCoalesce(
  'Unknown and Agent classifications must never share an aggregate',
  record(strictBase),
  record({ ...strictBase, classification: agentClassification }),
);

for (const [label, incomplete] of [
  ['missing hostId', { hostId: '' }],
  ['missing bootId', { bootId: '' }],
  ['missing start marker', { start: '' }],
  ['missing cgroup id', { cgroupId: '' }],
  ['missing cgroup path', { cgroup: '' }],
  ['missing operation', { fileExtra: { write: undefined } }],
  ['mismatched payload pid', { fileExtra: { pid: 999 } }],
  ['invalid flags', { fileExtra: { flags: '1' } }],
  ['relative path', { filePath: 'workspace/strict.json' }],
]) {
  const outputs = [];
  const candidate = new FileAccessAggregator({ now: () => now, windowMs: 100, autoSchedule: false });
  candidate.push(record({ ...strictBase, ...incomplete }), (item) => outputs.push(item));
  assert.equal(outputs.length, 1, `${label} must bypass immediately`);
  assert.equal(candidate.metrics().pendingKeys, 0);
}

const deleteOutputs = [];
const deleteAggregator = new FileAccessAggregator({ now: () => now, windowMs: 100, autoSchedule: false });
const deleteRecord = record(strictBase);
deleteRecord.observerEvent.event = {
  FileDelete: { pid: strictBase.pid, path: strictBase.filePath },
};
deleteRecord.line = JSON.stringify(deleteRecord.observerEvent);
deleteAggregator.push(deleteRecord, (item) => deleteOutputs.push(item));
assert.equal(deleteOutputs.length, 1, 'FileDelete must bypass aggregation');
assert.equal(deleteAggregator.metrics().pendingKeys, 0);

const weightedOutputs = [];
const weightedAggregator = new FileAccessAggregator({ now: () => now, windowMs: 100, autoSchedule: false });
weightedAggregator.push(record({
  ...strictBase,
  representedEvents: 3,
  fileExtra: {
    repeatCount: 3,
    repeat_count: 3,
    firstEventAt: '2026-08-17T00:00:00.000Z',
    first_event_at: '2026-08-17T00:00:00.000Z',
    lastEventAt: '2026-08-17T00:00:00.010Z',
    last_event_at: '2026-08-17T00:00:00.010Z',
    aggregationWindowMs: 10,
    aggregation_window_ms: 10,
  },
}), (item) => weightedOutputs.push(item));
weightedAggregator.push(record({
  ...strictBase,
  representedEvents: 2,
  fileExtra: {
    repeatCount: 2,
    repeat_count: 2,
    firstEventAt: '2026-08-17T00:00:00.020Z',
    first_event_at: '2026-08-17T00:00:00.020Z',
    lastEventAt: '2026-08-17T00:00:00.030Z',
    last_event_at: '2026-08-17T00:00:00.030Z',
    aggregationWindowMs: 10,
    aggregation_window_ms: 10,
  },
}), (item) => weightedOutputs.push(item));
weightedAggregator.flushAll();
assert.equal(weightedOutputs.length, 1);
assert.equal(weightedOutputs[0].representedEvents, 5);
assert.equal(weightedOutputs[0].observerEvent.event.FileAccess.repeatCount, 5);
assert.equal(weightedOutputs[0].observerEvent.event.FileAccess.firstEventAt, '2026-08-17T00:00:00.000Z');
assert.equal(weightedOutputs[0].observerEvent.event.FileAccess.lastEventAt, '2026-08-17T00:00:00.030Z');

const conflictingCountOutputs = [];
const conflictingCountAggregator = new FileAccessAggregator({ now: () => now, windowMs: 100, autoSchedule: false });
conflictingCountAggregator.push(record({
  ...strictBase,
  fileExtra: { repeatCount: 2, repeat_count: 3 },
}), (item) => conflictingCountOutputs.push(item));
assert.equal(conflictingCountOutputs.length, 1, 'conflicting upstream counts must bypass without rewriting');

let sinkAvailable = false;
const retryOutputs = [];
const retryAggregator = new FileAccessAggregator({ now: () => now, windowMs: 100, autoSchedule: false });
retryAggregator.push(record(strictBase), (item) => {
  if (!sinkAvailable) throw new Error('transient sink failure');
  retryOutputs.push(item);
});
assert.throws(() => retryAggregator.flushAll(), /transient sink failure/u);
assert.equal(retryAggregator.metrics().pendingKeys, 1, 'failed synchronous emit must remain pending');
sinkAvailable = true;
retryAggregator.flushAll();
assert.equal(retryOutputs.length, 1);
assert.equal(retryAggregator.metrics().pendingKeys, 0);

console.log('FileAccess aggregation verification passed');
