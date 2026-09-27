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

// A day-scale prefix is loaded in aligned 2h ClickHouse chunks, not one 24h fold that exceeds
// the 128 MiB bucket-build budget.
{
  const wideReads = [];
  const wide = new CommitAwareFactBucketCache({
    async latestCursor() {
      return { committedAtMs: 1, eventId: 'evt_wide', decisionRevision: 1 };
    },
    async changes(after) {
      return { changes: [], cursor: after, hasMore: false };
    },
    async facts(startMs, endExclusiveMs) {
      wideReads.push([startMs, endExclusiveMs]);
      const rows = [];
      for (let bucket = startMs; bucket < endExclusiveMs; bucket += BUCKET_MS) {
        rows.push({ bucketStartMs: bucket, identityKey: `wide-${bucket}`, eventCount: 1 });
      }
      return rows;
    },
  }, BUCKET_MS);
  const sixHours = 6 * 3_600_000;
  const eightHours = 8 * 3_600_000;
  const firstWide = await wide.read(0, eightHours);
  assert.equal(firstWide, null, 'one 6h chunk must not pretend a longer prefix is complete');
  assert.deepEqual(wideReads, [[0, sixHours]]);
  wideReads.length = 0;
  const secondWide = await wide.read(0, eightHours);
  assert.equal(secondWide?.length, eightHours / BUCKET_MS);
  assert.deepEqual(wideReads, [[sixHours, eightHours]]);

  const warmReads = [];
  const warm = new CommitAwareFactBucketCache({
    async latestCursor() {
      return { committedAtMs: 1, eventId: 'evt_warm', decisionRevision: 1 };
    },
    async changes(after) {
      return { changes: [], cursor: after, hasMore: false };
    },
    async facts(startMs, endExclusiveMs) {
      warmReads.push([startMs, endExclusiveMs]);
      const rows = [];
      for (let bucket = startMs; bucket < endExclusiveMs; bucket += BUCKET_MS) {
        rows.push({ bucketStartMs: bucket, identityKey: `warm-${bucket}`, eventCount: 1 });
      }
      return rows;
    },
  }, BUCKET_MS);
  assert.equal(await warm.read(0, eightHours), null);
  assert.deepEqual(warmReads, [[0, sixHours]]);
  warm.continueWarmup(0, eightHours);
  await warm.drainWarmup();
  assert.deepEqual(warmReads, [[0, sixHours], [sixHours, eightHours]]);
  warmReads.length = 0;
  assert.equal((await warm.read(0, eightHours))?.length, eightHours / BUCKET_MS);
  assert.deepEqual(warmReads, []);
  warm.close();

  const tightReads = [];
  const tight = new CommitAwareFactBucketCache({
    async latestCursor() {
      return { committedAtMs: 1, eventId: 'evt_tight', decisionRevision: 1 };
    },
    async changes(after) {
      return { changes: [], cursor: after, hasMore: false };
    },
    async facts(startMs, endExclusiveMs) {
      tightReads.push([startMs, endExclusiveMs]);
      const rows = [];
      for (let bucket = startMs; bucket < endExclusiveMs; bucket += BUCKET_MS) {
        rows.push({ bucketStartMs: bucket, identityKey: `tight-${bucket}`, eventCount: 1 });
      }
      return rows;
    },
  }, BUCKET_MS, 100);
  assert.equal(await tight.read(0, eightHours), null);
  assert.equal(tightReads.length, 1);
  tight.continueWarmup(0, eightHours);
  await tight.drainWarmup();
  assert.equal(tightReads.length, 1, 'budget-rejected prefixes must not keep scanning ClickHouse');
  tight.close();
}

const [aggregation, clickhouse, judge] = await Promise.all([
  read('apps/api/src/security-monitoring/aggregation.service.ts'),
  read('apps/api/src/security-monitoring/clickhouse-store.ts'),
  read('apps/api/src/security-monitoring/sentry-judge.service.ts'),
]);
assert.match(aggregation, /new CommitAwareFactBucketCache<StoredAgentBucketFact>/);
assert.match(aggregation, /new CommitAwareFactBucketCache<StoredTopologyBucketFact>/);
assert.match(aggregation, /function reusableFactSlices\(/);
assert.match(aggregation, /fullEndExclusiveMs/);
assert.match(aggregation, /using bounded hot fallback/);
assert.match(aggregation, /boundedHotDashboardOverlay/);
assert.match(aggregation, /partialReason: 'hot_ring_only'/);
assert.match(aggregation, /DASHBOARD_EXACT_COMPARISON_MAX_BUCKETS = 360/);
assert.match(aggregation, /Math\.ceil\(\(window\.spanMs \* 2\) \/ REUSABLE_BUCKET_MS\)/);
assert.match(
  aggregation,
  /failed reusable read[\s\S]*?return null/u,
  'a reusable history failure must not launch a second exact full-window scan',
);
assert.match(clickhouse, /async agentWindowBucketFacts\(/);
assert.match(
  clickhouse,
  /BOUNDED_DASHBOARD_BUCKET_BUILD_SETTINGS[\s\S]*?max_block_size: "1024"/u,
  'bucket-build scans use small blocks so a 24h fold cannot pin 128 MiB',
);
assert.match(
  await read('apps/api/src/security-monitoring/commit-aware-fact-cache.ts'),
  /FACT_BUCKET_QUERY_CHUNK_MS = 6 \* 3_600_000/,
);
assert.match(
  await read('apps/api/src/security-monitoring/commit-aware-fact-cache.ts'),
  /FACT_BUCKET_QUERY_MAX_CHUNKS = 1/,
);
assert.match(
  await read('apps/api/src/security-monitoring/commit-aware-fact-cache.ts'),
  /continueWarmup/,
);
assert.match(aggregation, /cache\.continueWarmup/);
const agentBucketQuery = clickhouse.slice(
  clickhouse.indexOf('async agentWindowBucketFacts('),
  clickhouse.indexOf('async workspaceWindowFacts('),
);
assert.match(agentBucketQuery, /argMax\(eventKind, tuple\(decisionRevision, decisionUpdatedAt, at\)\) AS eventKind/u);
assert.match(agentBucketQuery, /countIf\(collectorId = '' AND eventKind NOT IN/u,
  'Agent bucket query projects eventKind for collector-coverage aggregation');
assert.match(agentBucketQuery, /clickhouse_settings: BOUNDED_DASHBOARD_BUCKET_BUILD_SETTINGS/u,
  'Agent cold bucket builds are bounded instead of blocking the asset directory indefinitely');
assert.match(agentBucketQuery, /WHERE at >= \{since:UInt64\} AND at < \{endExclusive:UInt64\}[\s\S]*?\$\{monitoredClause\}[\s\S]*?GROUP BY eventId/u,
  'Agent membership is narrowed before event revision aggregation');
assert.match(clickhouse, /async topologyWindowBucketFacts\(/);
assert.match(clickhouse, /intDiv\(eventAt, \{bucketMs:UInt64\}\)/);
assert.match(clickhouse, /argMax\(at, tuple\(decisionRevision, decisionUpdatedAt, at\)\)/);
assert.match(judge, /agentWindowBucketFacts/);
assert.match(judge, /topologyWindowBucketFacts/);

console.log('Data lifecycle Phase 12 verification passed');
