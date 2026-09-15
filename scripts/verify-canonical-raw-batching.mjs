#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
const require = createRequire(import.meta.url);
const { CanonicalObservabilityService } = require('../apps/api/dist/security-monitoring/canonical-observability.service.js');
process.env.ANYSENTRY_CANONICAL_ASYNC_PERSIST = 'on';
process.env.ANYSENTRY_CANONICAL_ASYNC_PERSIST_MAX_INFLIGHT = '1';
process.env.ANYSENTRY_CANONICAL_ASYNC_RAW_BATCH_ROWS = '4';
process.env.ANYSENTRY_CANONICAL_ASYNC_RAW_BATCH_WINDOW_MS = '10';
const context = (id) => ({ sourceId: 'batch-fixture', sourceType: 'api', sourceSequence: id,
  eventAtUnixNs: '1788000000000000000', receivedAtUnixNs: '1788000000000000000' });
async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await delay(5); }
  assert.fail('batch flush did not complete within bounded test window');
}
const service = new CanonicalObservabilityService();
const writes = [];
service.setSink({ saveRawObservations: async (rows) => { writes.push(rows); return true; } });
try {
  // A raw side-lane writer occupies the raw slot, then completes without another ingest event.
  let release;
  await service.writeCanonicalSideLane(() => new Promise(resolve => { release = resolve; }), () => {}, 'raw');
  const commits = await Promise.all(['one', 'two', 'three'].map(id =>
    service.commitObserverLine(JSON.stringify({ kind: 'fixture', id }), context(id))));
  assert(commits.every(result => result.observation && result.durable === false));
  await delay(30);
  assert.equal(writes.length, 0, 'raw batch respects shared concurrency bound');
  release(true);
  await until(() => writes.length === 1);
  assert.equal(writes[0].length, 3, 'timer coalesces records and resumes without new traffic');
  await until(() => service.gapStats().asyncPersistenceInFlight === 0);
  assert.equal(service.gapStats().asyncPersistenceDropped, 0);
  service.setSink({ saveRawObservations: async () => false });
  await service.commitObserverLine('{"kind":"failure-fixture"}', context('failure'));
  await until(() => service.gapStats().asyncPersistenceFailed === 1);
  assert(service.gapStats().entries > 0, 'failed batch produces explicit coverage evidence');
} finally { service.close(); }
console.log('PASS raw batching, shared-slot saturation recovery and failed-write coverage');
