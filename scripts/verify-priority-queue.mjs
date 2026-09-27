#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { BoundedPriorityQueue } = require('./observer-priority-queue');

const queue = new BoundedPriorityQueue(3, 5);
assert.equal(queue.push('routine-a', 0).accepted, true);
assert.equal(queue.push('unknown', 2).accepted, true);
assert.equal(queue.push('confirmed', 4).accepted, true);
const security = queue.push('security', 5);
assert.equal(security.accepted, true);
assert.equal(security.dropped, 'routine-a');
assert.equal(queue.length, 3);

const rejected = queue.push('routine-b', 0);
assert.equal(rejected.accepted, false);
assert.equal(rejected.droppedIncoming, true);
assert.equal(queue.length, 3);
assert.deepEqual(queue.take(3), ['security', 'confirmed', 'unknown']);
assert.equal(queue.length, 0);

const bulk = new BoundedPriorityQueue(5_000, 5);
for (let index = 0; index < 5_000; index++) bulk.push(index, index % 6);
assert.equal(bulk.take(5_000).length, 5_000);
assert.equal(bulk.length, 0);
bulk.push('leftover-a', 0);
bulk.push('leftover-b', 5);
assert.equal(bulk.clear(), 2);
assert.equal(bulk.length, 0);

const weighted = new BoundedPriorityQueue(10, 5);
weighted.push({ id: 'high-a', bytes: 6 }, 5);
weighted.push({ id: 'high-b', bytes: 6 }, 5);
weighted.push({ id: 'low', bytes: 1 }, 0);
assert.deepEqual(
  weighted.takeWeighted(10, 10, (item) => item.bytes).map((item) => item.id),
  ['high-a'],
);
assert.deepEqual(
  weighted.takeWeighted(10, 10, (item) => item.bytes).map((item) => item.id),
  ['high-b', 'low'],
);
weighted.push({ id: 'oversized', bytes: 20 }, 4);
assert.equal(weighted.takeWeighted(10, 10, (item) => item.bytes)[0].id, 'oversized');
weighted.push({ id: 'lowest', bytes: 1 }, 0);
weighted.push({ id: 'highest', bytes: 1 }, 5);
assert.equal(weighted.dropLowest().id, 'lowest');
assert.equal(weighted.dropLowest().id, 'highest');
assert.equal(weighted.dropLowest(), undefined);

const accounted = new BoundedPriorityQueue(2, 5, (item) => item.bytes);
accounted.push({ id: 'low-a', bytes: 7 }, 0);
accounted.push({ id: 'low-b', bytes: 11 }, 0);
assert.equal(accounted.totalWeight, 18);
const rejectedWeighted = accounted.push({ id: 'rejected', bytes: 101 }, 0);
assert.equal(rejectedWeighted.accepted, false);
assert.equal(rejectedWeighted.droppedIncoming, true);
assert.equal(accounted.totalWeight, 18, 'rejecting an incoming item must not change queued bytes');
const replaced = accounted.push({ id: 'high', bytes: 13 }, 5);
assert.equal(replaced.accepted, true);
assert.equal(replaced.dropped.id, 'low-a');
assert.equal(accounted.totalWeight, 24, 'count eviction must subtract only the queued item');
assert.equal(accounted.dropLowest().id, 'low-b');
assert.equal(accounted.totalWeight, 13);
assert.equal(accounted.clear(), 1);
assert.equal(accounted.totalWeight, 0);

const released = new BoundedPriorityQueue(2_000, 5);
for (let index = 0; index < 1_100; index++) {
  released.push({ index, body: `event-${index}` }, 3);
}
assert.equal(released.take(1_000).length, 1_000);
assert.equal(released.buckets[3].head, 1_000, 'fixture must remain below the compaction threshold');
assert.ok(
  released.buckets[3].items.slice(0, released.buckets[3].head).every((item) => item === undefined),
  'consumed queue slots must release event body references before compaction',
);
assert.equal(released.buckets[3].items[released.buckets[3].head].index, 1_000);

console.log('Priority queue verification passed');
