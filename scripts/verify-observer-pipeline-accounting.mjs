#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  BACKLOG_FIELDS,
  ForwarderPipelineAccounting,
  SCHEMA_VERSION,
  STAGE_REASONS,
  STAGES,
} = require('./observer-pipeline-accounting');

let now = 1_000;
const accounting = new ForwarderPipelineAccounting({
  producerInstanceId: 'forwarder-test-instance',
  now: () => now,
});

accounting.record('received', 'input', 5);
accounting.record('parse_error', 'invalid_json');
accounting.record('classified', 'unknown', 3);
accounting.record('filtered', 'deduplicated');
accounting.record('aggregated', 'file_access_coalesced', 2);
accounting.record('queue_admitted', 'event', 2);
accounting.record('queue_dropped', 'outstanding_limit');
accounting.record('queue_dropped', 'wal_pending_capacity');
accounting.record('api_retained', 'ack');
accounting.record('api_discarded', 'ack');
accounting.record('api_rejected', 'ack');
accounting.record('api_retryable', 'ack');

now = 2_000;
const backlog = Object.fromEntries(BACKLOG_FIELDS.map((field, index) => [field, index + 1]));
const first = accounting.beginDelivery(backlog);
assert.ok(first);
assert.equal(first.schemaVersion, SCHEMA_VERSION);
assert.equal(first.schemaVersion, 'anysentry.pipeline_accounting.v1');
assert.equal(first.producer, 'forwarder');
assert.equal(first.producerInstanceId, 'forwarder-test-instance');
assert.equal(first.sequence, 1);
assert.deepEqual(first.window, { startedAtUnixMs: 1_000, endedAtUnixMs: 2_000 });
assert.equal(first.temporality, 'delta');
assert.deepEqual(first.unit, { input: 'logical_event', queue: 'logical_event' });
assert.deepEqual(first.backlog, backlog);
assert.deepEqual(first.stages.map((stage) => stage.stage), STAGES);
assert.deepEqual(
  first.stages.map((stage) => stage.reasons.map((reason) => reason.reason)),
  STAGES.map((stage) => [...STAGE_REASONS[stage]]),
  'stage and reason label sets must stay fixed and low-cardinality',
);
assert.equal(first.stages.find((stage) => stage.stage === 'received').count, 5);
assert.equal(first.stages.find((stage) => stage.stage === 'parse_error').count, 1);
assert.equal(first.stages.find((stage) => stage.stage === 'aggregated').count, 2);
assert.equal(first.stages.find((stage) => stage.stage === 'queue_admitted').count, 2);
assert.equal(first.stages.find((stage) => stage.stage === 'queue_dropped').count, 2);
assert.equal(
  first.stages.find((stage) => stage.stage === 'queue_dropped')
    .reasons.find((reason) => reason.reason === 'wal_pending_capacity').count,
  1,
);
assert.equal(first.stages.find((stage) => stage.stage === 'api_retained').count, 1);
assert.equal(first.stages.find((stage) => stage.stage === 'api_discarded').count, 1);
assert.equal(first.stages.find((stage) => stage.stage === 'api_rejected').count, 1);
assert.equal(first.stages.find((stage) => stage.stage === 'api_retryable').count, 1);
assert.equal(accounting.beginDelivery(backlog), undefined, 'one window cannot be sent concurrently');

// New observations belong to the next active window even while the prior heartbeat is in flight.
accounting.record('received', 'input', 2);
accounting.record('classified', 'confirmed_agent', 2);
accounting.record('queue_admitted', 'event', 2);
accounting.failDelivery();

now = 3_000;
const retried = accounting.beginDelivery(Object.fromEntries(BACKLOG_FIELDS.map((field) => [field, 99])));
assert.strictEqual(retried, first, 'a failed POST must retry the exact frozen payload');
assert.equal(retried.sequence, 1, 'a failed POST must not consume a sequence');
assert.deepEqual(retried.backlog, backlog, 'the idempotent retry retains its original gauge snapshot');
accounting.completeDelivery();

now = 4_000;
const second = accounting.beginDelivery();
assert.ok(second);
assert.equal(second.sequence, 2);
assert.deepEqual(second.window, { startedAtUnixMs: 2_000, endedAtUnixMs: 4_000 });
assert.equal(second.stages.find((stage) => stage.stage === 'received').count, 2);
assert.equal(second.stages.find((stage) => stage.stage === 'classified').count, 2);
assert.equal(second.stages.find((stage) => stage.stage === 'queue_admitted').count, 2);
assert.equal(second.stages.find((stage) => stage.stage === 'api_retained').count, 0);
assert.doesNotThrow(() => JSON.stringify(second));
accounting.completeDelivery();

assert.throws(
  () => accounting.record('received', '/high/cardinality/path'),
  /unsupported received reason/,
);
assert.throws(
  () => accounting.record('pid-12345', 'input'),
  /unsupported pipeline stage/,
);
assert.throws(
  () => accounting.record('received', 'input', -1),
  /non-negative safe integer/,
);

console.log('Observer Forwarder pipeline accounting verification passed');
