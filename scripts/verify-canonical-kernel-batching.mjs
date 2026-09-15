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
process.env.ANYSENTRY_CANONICAL_ASYNC_KERNEL_BATCH_MAX_BYTES = '65536';

async function until(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await delay(5); }
  assert.fail('canonical queues did not settle');
}
const service = new CanonicalObservabilityService();
const raw = [], facts = [];
service.setSink({
  saveRawObservations: async rows => { raw.push(...rows); return true; },
  saveKernelFacts: async rows => { facts.push(rows); return true; },
});
try {
  let release;
  await service.writeCanonicalSideLane(() => new Promise(resolve => { release = resolve; }), () => {}, 'raw');
  const results = [];
  for (const id of ['one', 'two', 'three']) {
    results.push(await service.commitObserverLine(JSON.stringify({ kind: 'Exec', id }), {
      sourceId: 'kernel-batch-fixture', sourceType: 'kernel', sourceSequence: id,
      eventAtUnixNs: '1788000000000000000', receivedAtUnixNs: '1788000000000000000',
    }));
  }
  assert(results.every(result => result.kernelFact && !result.durable));
  await delay(30);
  assert.equal(facts.length, 0);
  assert.equal(service.gapStats().asyncKernelBatchQueueRows, 3);
  assert(service.gapStats().asyncKernelBatchQueueBytes > 0);
  release(true);
  await until(() => facts.length === 1 && raw.length === 3 && service.gapStats().asyncPersistenceInFlight === 0);
  assert.equal(raw.length, 3);
  assert.deepEqual(facts[0].map(fact => fact.factId), results.map(result => result.kernelFact.factId));
  assert.equal(service.gapStats().asyncKernelBatchQueueBytes, 0);
  assert.equal(service.gapStats().asyncPersistenceDropped, 0);

  service.setSink({ saveRawObservations: async () => true, saveKernelFacts: async () => false });
  const failedBefore = service.gapStats().asyncPersistenceFailed;
  let failures = 0;
  service.enqueueKernelFact(results[0].kernelFact, () => failures++);
  await until(() => failures === 1);
  assert.equal(service.gapStats().asyncPersistenceFailed, failedBefore + 1);
  await until(() => service.gapStats().asyncPersistenceInFlight === 0);

  const oversized = { ...results[0].kernelFact, sourceRefs: ['x'.repeat(65536)] };
  assert.equal(service.enqueueKernelFact(oversized, () => failures++), false);
  assert.equal(service.gapStats().asyncKernelBatchQueueRows, 0);
  assert.equal(service.gapStats().asyncPersistenceDropped, 1);

  service.enqueueKernelFact(results[1].kernelFact, () => failures++);
  service.close();
  assert.equal(failures, 3, 'close reports queued facts instead of silently losing them');
  assert.equal(service.gapStats().asyncKernelBatchQueueRows, 0);
  assert.equal(service.gapStats().asyncKernelBatchQueueBytes, 0);
  assert.equal(service.gapStats().asyncPersistenceDropped, 2);
  await delay(30);
  assert.equal(failures, 3, 'cancelled timer must not write or report failure twice');
} finally { service.close(); }
console.log('PASS kernel batching, shared capacity recovery, failed sink, byte bounds and close accounting');
