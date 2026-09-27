import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const {
  relevantCommitProgress,
  observedDurableThrough,
} = require('../apps/api/dist/security-monitoring/query-coverage.js');
const {
  CommitAwareFactBucketCache,
} = require('../apps/api/dist/security-monitoring/commit-aware-fact-cache.js');
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

const progressEntries = [
  {
    sourceId: 'observer-a',
    collectorId: 'collector-a1',
    committedEventTimeMs: 100,
    committedAtMs: 1_000,
  },
  {
    sourceId: 'observer-a',
    collectorId: 'collector-a2',
    committedEventTimeMs: 200,
    committedAtMs: 1_100,
  },
  {
    sourceId: 'observer-b',
    collectorId: 'collector-b1',
    committedEventTimeMs: 900,
    committedAtMs: 1_200,
  },
];

const allProgress = relevantCommitProgress(progressEntries, {});
assert.equal(allProgress.scope, 'all_sources');
assert.equal(allProgress.entries.length, 3);
assert.equal(observedDurableThrough(900, allProgress), 900);

const sourceProgress = relevantCommitProgress(progressEntries, { sourceId: 'observer-a' });
assert.equal(sourceProgress.scope, 'query_sources');
assert.deepEqual(
  sourceProgress.entries.map((entry) => entry.collectorId),
  ['collector-a1', 'collector-a2'],
);
assert.equal(observedDurableThrough(900, sourceProgress), 200);

const collectorProgress = relevantCommitProgress(progressEntries, { collectorId: 'collector-a1' });
assert.equal(collectorProgress.entries.length, 1);
assert.equal(observedDurableThrough(900, collectorProgress), 100);

const missingProgress = relevantCommitProgress(progressEntries, { sourceId: 'missing' });
assert.equal(missingProgress.entries.length, 0);
assert.equal(observedDurableThrough(900, missingProgress), undefined);

// Simulate one hour of ten-second Dashboard refreshes over a three-hour range. The first request
// materialises the stable history; later requests read only the new ten-second tail.
const BUCKET_MS = 10_000;
const WINDOW_MS = 3 * 60 * 60 * 1_000;
const REFRESHES = 360;
const factReads = [];
const commitChanges = [];
let cursor = { committedAtMs: 1, eventId: 'evt-initial', decisionRevision: 1 };
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
    const facts = [];
    for (let bucketStartMs = startMs; bucketStartMs < endExclusiveMs; bucketStartMs += BUCKET_MS) {
      facts.push({ bucketStartMs, eventCount: 1 });
    }
    return facts;
  },
};
const cache = new CommitAwareFactBucketCache(provider, BUCKET_MS, 2_000);
for (let index = 0; index < REFRESHES; index += 1) {
  const endExclusiveMs = WINDOW_MS + (index * BUCKET_MS);
  const startMs = endExclusiveMs - WINDOW_MS;
  const rows = await cache.read(startMs, endExclusiveMs);
  assert.equal(rows?.length, WINDOW_MS / BUCKET_MS);
}
const queriedDurationMs = factReads.reduce(
  (total, [startMs, endExclusiveMs]) => total + (endExclusiveMs - startMs),
  0,
);
const fullRescanDurationMs = WINDOW_MS * REFRESHES;
assert.ok(
  queriedDurationMs <= WINDOW_MS + ((REFRESHES - 1) * BUCKET_MS),
  `expected prefix reuse, queried ${queriedDurationMs}ms`,
);
assert.ok(
  queriedDurationMs / fullRescanDurationMs < 0.01,
  'ten-second refreshes should scan less than one percent of the naïve history duration',
);

// Late facts and newer decision revisions invalidate only their event-time bucket even after the
// prefix has been reused across many refresh cycles.
const lateBucketMs = WINDOW_MS + ((REFRESHES - 10) * BUCKET_MS);
cursor = { committedAtMs: 2, eventId: 'evt-late', decisionRevision: 1 };
commitChanges.push({
  cursor,
  eventAtMs: lateBucketMs + 1,
  sourceId: 'observer-a',
  collectorId: 'collector-a1',
});
factReads.length = 0;
await cache.read(
  (WINDOW_MS + ((REFRESHES - 1) * BUCKET_MS)) - WINDOW_MS,
  WINDOW_MS + ((REFRESHES - 1) * BUCKET_MS),
);
assert.deepEqual(factReads, [[lateBucketMs, lateBucketMs + BUCKET_MS]]);

cursor = { committedAtMs: 3, eventId: 'evt-late', decisionRevision: 2 };
commitChanges.push({
  cursor,
  eventAtMs: lateBucketMs + 1,
  sourceId: 'observer-a',
  collectorId: 'collector-a1',
});
factReads.length = 0;
await cache.read(
  (WINDOW_MS + ((REFRESHES - 1) * BUCKET_MS)) - WINDOW_MS,
  WINDOW_MS + ((REFRESHES - 1) * BUCKET_MS),
);
assert.deepEqual(factReads, [[lateBucketMs, lateBucketMs + BUCKET_MS]]);

const [aggregation, backendTypes, frontendApi] = await Promise.all([
  read('apps/api/src/security-monitoring/aggregation.service.ts'),
  read('apps/api/src/security-monitoring/types.ts'),
  read('apps/web/src/lib/api/security-center.ts'),
]);
for (const contract of [backendTypes, frontendApi]) {
  assert.match(contract, /observedDurableThrough/);
  assert.match(contract, /commitBoundaryKind/);
  assert.match(contract, /commitProgressScope/);
  assert.match(contract, /lateDataPolicy/);
  assert.match(contract, /completeness/);
}
assert.match(aggregation, /relevantCommitProgress/);
assert.match(aggregation, /observedDurableThrough/);
assert.match(aggregation, /watermark: undefined/);

console.log('Data lifecycle Phase 13 verification passed');
console.log(JSON.stringify({
  refreshes: REFRESHES,
  naiveHistoryHoursScanned: fullRescanDurationMs / 3_600_000,
  cachedHistoryHoursScanned: queriedDurationMs / 3_600_000,
  scanRatio: queriedDurationMs / fullRescanDurationMs,
}));
