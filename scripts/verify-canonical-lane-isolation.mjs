#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
const require = createRequire(import.meta.url);
const { CanonicalObservabilityService } = require('../apps/api/dist/security-monitoring/canonical-observability.service.js');
process.env.ANYSENTRY_CANONICAL_ASYNC_PERSIST = 'on';
process.env.ANYSENTRY_CANONICAL_ASYNC_PERSIST_MAX_INFLIGHT = '1';
process.env.ANYSENTRY_CANONICAL_ASYNC_DERIVED_MAX_INFLIGHT = '1';
process.env.ANYSENTRY_CANONICAL_ASYNC_PERSIST_WAIT_MS = '30';

async function until(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await delay(5); }
  assert.fail('persistence lanes did not settle');
}
const service = new CanonicalObservabilityService();
service.setSink({ saveRawObservations: async () => true });
let releaseRaw, releaseDerived;
let rejectedOperations = 0, failures = 0;
try {
  assert(await service.writeCanonicalSideLane(
    () => new Promise(resolve => { releaseRaw = resolve; }), () => {}, 'raw'));
  assert(await service.writeCanonicalSideLane(
    () => new Promise(resolve => { releaseDerived = resolve; }), () => {}, 'derived'),
  'derived write is admitted even while the raw pool is full');
  assert.equal(service.gapStats().asyncPersistenceInFlight, 1);
  assert.equal(service.gapStats().asyncDerivedPersistenceInFlight, 1);
  const extra = () => { rejectedOperations++; return Promise.resolve(true); };
  assert.equal(await service.writeCanonicalSideLane(extra, () => failures++, 'raw'), false);
  assert.equal(await service.writeCanonicalSideLane(extra, () => failures++, 'derived'), false);
  assert.equal(rejectedOperations, 0, 'saturated pools must not execute excess writes');
  assert.equal(failures, 2, 'each expired admission reports its gap');
  releaseRaw(true);
  await until(() => service.gapStats().asyncPersistenceInFlight === 0);
  assert(await service.writeCanonicalSideLane(async () => true, () => {}, 'raw'),
    'raw progress resumes while the derived pool remains full');
  const pending = service.writeCanonicalSideLane(extra, () => failures++, 'derived');
  service.close();
  releaseDerived(true);
  assert.equal(await pending, false, 'a waiter cannot start after service shutdown');
  assert.equal(rejectedOperations, 0);
  await until(() => service.gapStats().asyncDerivedPersistenceInFlight === 0);
} finally {
  releaseRaw?.(true);
  releaseDerived?.(true);
  service.close();
}
console.log('PASS independent bounded persistence lanes, recovery, timeout and shutdown');
