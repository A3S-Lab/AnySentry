#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
const require = createRequire(import.meta.url);
const { CanonicalObservabilityService } = require('../apps/api/dist/security-monitoring/canonical-observability.service.js');
process.env.ANYSENTRY_CANONICAL_ASYNC_PERSIST = 'on';
process.env.ANYSENTRY_CANONICAL_ASYNC_DERIVED_MAX_INFLIGHT = '1';
process.env.ANYSENTRY_CANONICAL_ASYNC_DERIVED_BATCH_ROWS = '4';
process.env.ANYSENTRY_CANONICAL_ASYNC_DERIVED_BATCH_WINDOW_MS = '10';
process.env.ANYSENTRY_CANONICAL_ASYNC_PERSIST_WAIT_MS = '30';

const record = (id) => ({
  schemaVersion: 'anysentry.semantic_record.v1',
  semanticRecordId: `sr_${id}`,
  kind: 'message',
  authority: 'inferred',
  sourceRefs: [`raw:${id}`],
  derivedFrom: [`kf:${id}`],
  observedAtUnixNs: '1788000000000000000',
  completeness: 'complete',
  partialReasons: [],
});

async function until(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await delay(5); }
  assert.fail('derived queues did not settle');
}

const service = new CanonicalObservabilityService();
const writes = [];
let release;
service.setSink({
  saveSemanticRecords: async (rows) => new Promise((resolve) => {
    writes.push(rows);
    if (!release) release = resolve;
    else resolve(true);
  }),
});

try {
  const first = await Promise.all(['a', 'b', 'c'].map((id) => service.commitSemanticRecords([record(id)])));
  assert(first.every((result) => result.accepted === 1 && result.durable === false));
  await until(() => writes.length === 1 && service.gapStats().asyncDerivedPersistenceInFlight === 1);
  assert.equal(writes[0].length, 3, 'window coalesces derived semantic records into one sink call');

  const queued = await service.commitSemanticRecords([record('d')]);
  assert.equal(queued.accepted, 1);
  await delay(20);
  assert.equal(service.gapStats().asyncDerivedBatchQueueRows, 1,
    'a full derived slot queues later semantic admissions instead of waiting to drop');
  assert.equal(service.gapStats().asyncDerivedPersistenceDropped, 0);

  release(true);
  await until(() => writes.length === 2 && service.gapStats().asyncDerivedPersistenceInFlight === 0);
  assert.equal(writes[1].length, 1);
  assert.equal(service.gapStats().asyncDerivedPersistenceDropped, 0);

  service.close();
  assert.equal(service.gapStats().asyncDerivedBatchQueueRows, 0);
} finally {
  release?.(true);
  service.close();
}
console.log('PASS derived semantic coalescing and slot queuing without wait-timeout drops');
