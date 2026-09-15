#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
const require = createRequire(import.meta.url);
const { RelationalBusinessStore } = require('../apps/api/dist/security-monitoring/relational-business-store.service.js');
process.env.ANYSENTRY_RELATIONAL_EVIDENCE_BATCH_ROWS = '4';
process.env.ANYSENTRY_RELATIONAL_SESSION_BATCH_ROWS = '4';
process.env.ANYSENTRY_RELATIONAL_PROJECTION_BATCH_WINDOW_MS = '10';
process.env.ANYSENTRY_RELATIONAL_PROJECTION_PENDING_ROWS = '6';
process.env.ANYSENTRY_RELATIONAL_PROJECTION_PENDING_BYTES = '2048';
const keepAlive = setInterval(() => {}, 1000);
async function until(check) {
  for (let i = 0; i < 200; i++) { if (check()) return; await delay(5); }
  assert.fail('projection batch did not settle');
}
try {
  for (const [method, stateName, key] of [
    ['saveEvidenceLinks', 'evidenceBatch', 'linkId'],
    ['saveSessionMemberships', 'sessionBatch', 'membershipId'],
  ]) {
    const store = new RelationalBusinessStore();
    const batches = [];
    const row = (id, value = 'original') => ({ [key]: id, resolutionRevision: 1, value });
    store[`${method}Now`] = async rows => { batches.push(rows); return true; };
    const mutable = row('a');
    const first = store[method]([mutable]);
    mutable.value = 'mutated';
    assert.deepEqual(await Promise.all([first, store[method]([row('b')])]), [true, true]);
    assert.equal(batches.length, 1);
    assert.equal(batches[0][0].value, 'original');
    assert.equal(await store[method]([row('large', 'x'.repeat(2048))]), false);
    assert.equal(batches.length, 1);

    const persisted = new Map();
    store[`${method}Now`] = async rows => {
      if (rows.some(r => persisted.has(r[key]) && persisted.get(r[key]) !== r.value)) return false;
      for (const r of rows) persisted.set(r[key], r.value);
      return true;
    };
    assert.deepEqual(await Promise.all([
      store[method]([row('conflict', 'one')]), store[method]([row('conflict', 'two')]),
    ]), [true, false]);

    let release;
    let attempts = 0;
    store[`${method}Now`] = async () => {
      attempts++;
      if (attempts === 1) return new Promise(resolve => { release = resolve; });
      throw new Error('controlled sink failure');
    };
    const active = store[method](['c', 'd', 'e', 'f'].map(id => row(id)));
    await until(() => Boolean(release));
    const waiting = store[method]([row('g'), row('h')]);
    assert.equal(await store[method]([row('overflow')]), false,
      'the pending row budget includes active writes');
    let closed = false;
    const shutdown = store.onModuleDestroy().then(() => { closed = true; });
    await delay(20);
    assert.equal(closed, false);
    assert.equal(await store[method]([row('late')]), false);
    release(true);
    assert.equal(await active, true);
    assert.equal(await waiting, false);
    await shutdown;
    assert.equal(attempts, 2);
    assert.equal(store[stateName].pendingRows, 0);
    assert.equal(store[stateName].pendingBytes, 0);
  }

  // A blocked evidence sink must not consume the SessionMembership batch's capacity.
  const isolated = new RelationalBusinessStore();
  let release;
  isolated.saveEvidenceLinksNow = () => new Promise(resolve => { release = resolve; });
  isolated.saveSessionMembershipsNow = async () => true;
  const held = isolated.saveEvidenceLinks([{ linkId: 'held', resolutionRevision: 1 }]);
  await until(() => Boolean(release));
  assert.equal(await isolated.saveSessionMemberships([{ membershipId: 'session', resolutionRevision: 1 }]), true);
  release(true);
  assert.equal(await held, true);
  await isolated.onModuleDestroy();
  console.log('PASS Evidence/Session coalescing, conflicts, bounds, sink isolation and shutdown');
} finally {
  clearInterval(keepAlive);
}
