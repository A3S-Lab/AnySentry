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

console.log('Priority queue verification passed');
