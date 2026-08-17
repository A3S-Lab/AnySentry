import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const {
  CommitAwareFactBucketCache,
} = require('../apps/api/dist/security-monitoring/commit-aware-fact-cache.js');
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

const BUCKET_MS = 10_000;
const factsByBucket = new Map();
for (let bucket = 0; bucket < 100_000; bucket += BUCKET_MS) {
  factsByBucket.set(bucket, [{
    bucketStartMs: bucket,
    identityKey: `agent-${bucket}`,
    eventCount: 1,
  }]);
}

const factReads = [];
const commitChanges = [];
let cursor = { committedAtMs: 100, eventId: 'evt_initial', decisionRevision: 1 };
const provider = {
  async latestCursor() {
    return cursor;
  },
  async changes(after) {
    const changes = commitChanges.filter((change) => (
      change.cursor.committedAtMs > (after?.committedAtMs ?? 0)
      || (
        change.cursor.committedAtMs === (after?.committedAtMs ?? 0)
        && (
          change.cursor.eventId > (after?.eventId ?? '')
          || (
            change.cursor.eventId === (after?.eventId ?? '')
            && change.cursor.decisionRevision > (after?.decisionRevision ?? 0)
          )
        )
      )
    ));
    return {
      changes,
      cursor: changes.at(-1)?.cursor ?? after,
      hasMore: false,
    };
  },
  async facts(startMs, endExclusiveMs) {
    factReads.push([startMs, endExclusiveMs]);
    const rows = [];
    for (let bucket = startMs; bucket < endExclusiveMs; bucket += BUCKET_MS) {
      rows.push(...(factsByBucket.get(bucket) ?? []));
    }
    return rows;
  },
};

const cache = new CommitAwareFactBucketCache(provider, BUCKET_MS, 100);

// First read materialises the exact stable prefix in one query.
const first = await cache.read(20_000, 60_000);
assert.equal(first?.length, 4);
assert.deepEqual(factReads, [[20_000, 60_000]]);

// Moving the window reuses all overlapping buckets and reads only the newly requested tail.
factReads.length = 0;
const second = await cache.read(30_000, 70_000);
assert.equal(second?.length, 4);
assert.deepEqual(factReads, [[60_000, 70_000]]);

// A late canonical event invalidates only its event-time bucket.
factsByBucket.set(40_000, [{
  bucketStartMs: 40_000,
  identityKey: 'agent-late',
  eventCount: 2,
}]);
cursor = { committedAtMs: 200, eventId: 'evt_late', decisionRevision: 1 };
commitChanges.push({
  cursor,
  eventAtMs: 40_001,
  sourceId: 'observer',
  collectorId: 'collector-phase12',
});
factReads.length = 0;
const late = await cache.read(30_000, 70_000);
assert.deepEqual(factReads, [[40_000, 50_000]]);
assert.equal(late?.find((row) => row.bucketStartMs === 40_000)?.eventCount, 2);

// A later L2/L3 revision for the same event follows the same durable invalidation path.
factsByBucket.set(40_000, [{
  bucketStartMs: 40_000,
  identityKey: 'agent-late',
  eventCount: 3,
}]);
cursor = { committedAtMs: 300, eventId: 'evt_late', decisionRevision: 2 };
commitChanges.push({
  cursor,
  eventAtMs: 40_001,
  sourceId: 'observer',
  collectorId: 'collector-phase12',
});
factReads.length = 0;
const revised = await cache.read(30_000, 70_000);
assert.deepEqual(factReads, [[40_000, 50_000]]);
assert.equal(revised?.find((row) => row.bucketStartMs === 40_000)?.eventCount, 3);

// Unaligned custom ranges deliberately use the exact legacy path rather than an approximate cache.
assert.equal(await cache.read(30_001, 70_000), null);

const [aggregation, clickhouse, judge] = await Promise.all([
  read('apps/api/src/security-monitoring/aggregation.service.ts'),
  read('apps/api/src/security-monitoring/clickhouse-store.ts'),
  read('apps/api/src/security-monitoring/sentry-judge.service.ts'),
]);
assert.match(aggregation, /new CommitAwareFactBucketCache<StoredAgentBucketFact>/);
assert.match(aggregation, /new CommitAwareFactBucketCache<StoredTopologyBucketFact>/);
assert.match(aggregation, /function reusableFactSlices\(/);
assert.match(aggregation, /fullEndExclusiveMs/);
assert.match(aggregation, /using exact fallback/);
assert.match(clickhouse, /async agentWindowBucketFacts\(/);
assert.match(clickhouse, /async topologyWindowBucketFacts\(/);
assert.match(clickhouse, /intDiv\(eventAt, \{bucketMs:UInt64\}\)/);
assert.match(clickhouse, /argMax\(at, tuple\(decisionRevision, decisionUpdatedAt, at\)\)/);
assert.match(judge, /agentWindowBucketFacts/);
assert.match(judge, /topologyWindowBucketFacts/);

console.log('Data lifecycle Phase 12 verification passed');
