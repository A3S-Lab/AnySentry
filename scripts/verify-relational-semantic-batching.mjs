#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
const require = createRequire(import.meta.url);
const { RelationalBusinessStore } = require('../apps/api/dist/security-monitoring/relational-business-store.service.js');
process.env.ANYSENTRY_RELATIONAL_SEMANTIC_BATCH_ROWS = '4';
process.env.ANYSENTRY_RELATIONAL_SEMANTIC_BATCH_WINDOW_MS = '10';
process.env.ANYSENTRY_RELATIONAL_SEMANTIC_PENDING_ROWS = '6';
process.env.ANYSENTRY_RELATIONAL_SEMANTIC_PENDING_BYTES = '2048';
const keepAlive = setInterval(() => {}, 1000);
const record = (id, value = 'original') => ({ semanticRecordId: id, revision: 1, value });
async function until(check) {
  for (let i = 0; i < 200; i++) { if (check()) return; await delay(5); }
  assert.fail('semantic sink did not settle');
}
try {
  const store = new RelationalBusinessStore();
  const batches = [];
  store.saveSemanticRecordsNow = async rows => { batches.push(rows); return true; };
  const mutable = record('one');
  const first = store.saveSemanticRecords([mutable]);
  mutable.value = 'changed';
  const second = store.saveSemanticRecords([record('two')]);
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(batches.length, 1, 'same-window calls share a database batch');
  assert.equal(batches[0][0].value, 'original', 'deferred records are immutable snapshots');
  assert.equal(await store.saveSemanticRecords([record('large', 'x'.repeat(2048))]), false);
  assert.equal(batches.length, 1, 'oversized admission never reaches the sink');

  const saved = new Map();
  store.saveSemanticRecordsNow = async rows => {
    if (rows.some(row => saved.has(row.semanticRecordId) && saved.get(row.semanticRecordId) !== row.value)) return false;
    for (const row of rows) saved.set(row.semanticRecordId, row.value);
    return true;
  };
  assert.deepEqual(await Promise.all([
    store.saveSemanticRecords([record('conflict', 'first')]),
    store.saveSemanticRecords([record('conflict', 'second')]),
  ]), [true, false], 'coalescing must not reject the first valid writer because of a later conflicting caller');

  let release;
  let attempts = 0;
  store.saveSemanticRecordsNow = async () => {
    attempts++;
    if (attempts === 1) return new Promise(resolve => { release = resolve; });
    throw new Error('controlled sink failure');
  };
  const held = store.saveSemanticRecords(['a', 'b', 'c', 'd'].map(id => record(id)));
  await until(() => Boolean(release));
  const queued = store.saveSemanticRecords([record('e'), record('f')]);
  assert.equal(await store.saveSemanticRecords([record('g')]), false,
    'capacity includes active database writes as well as queued records');
  let closed = false;
  const closing = store.onModuleDestroy().then(() => { closed = true; });
  await delay(20);
  assert.equal(closed, false, 'shutdown waits for active durable writes');
  assert.equal(await store.saveSemanticRecords([record('late')]), false);
  release(true);
  assert.equal(await held, true);
  assert.equal(await queued, false, 'a failed sink resolves every admitted caller');
  await closing;
  assert.equal(store.semanticPendingRows, 0);
  assert.equal(store.semanticPendingBytes, 0);
  assert.equal(attempts, 2, 'shutdown drains the trailing queue exactly once');
  console.log('PASS semantic coalescing, snapshot, conflict isolation, byte/row capacity and shutdown');
} finally {
  clearInterval(keepAlive);
}
