import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const {
  CommitAwareFactBucketCache,
} = require('../apps/api/dist/security-monitoring/commit-aware-fact-cache.js');
const {
  DashboardHistoryBucketCache,
} = require('../apps/api/dist/security-monitoring/dashboard-history-cache.js');
const {
  foldLatestEventRevisions,
} = require('../apps/api/dist/security-monitoring/event-revision.js');
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

const BUCKET_MS = 10_000;
const cursor = (committedAtMs, eventId, decisionRevision = 1) => ({
  committedAtMs,
  eventId,
  decisionRevision,
});
const noChanges = async (after) => ({
  changes: [],
  cursor: after,
  hasMore: false,
});

// A required range that cannot fit the configured fact budget must not remain cached or return a
// sampled result. The caller receives null and takes the exact ClickHouse fallback path.
{
  const cache = new CommitAwareFactBucketCache(
    {
      async latestCursor() {
        return cursor(1, 'evt-initial');
      },
      changes: noChanges,
      async facts(startMs, endExclusiveMs) {
        const facts = [];
        for (
          let bucketStartMs = startMs;
          bucketStartMs < endExclusiveMs;
          bucketStartMs += BUCKET_MS
        ) {
          facts.push({ bucketStartMs, eventCount: 1 });
        }
        return facts;
      },
    },
    BUCKET_MS,
    10,
    2,
    1024 * 1024,
  );
  assert.equal(await cache.read(0, 3 * BUCKET_MS), null);
  assert.deepEqual(cache.stats(), {
    buckets: 0,
    facts: 0,
    estimatedBytes: 0,
    evictions: 0,
    budgetRejects: 1,
    journalResets: 0,
  });
}

// If the cache cursor falls behind the oldest retained journal row, invalidations may have been
// lost. The cache must discard its prefix and reload rather than claim that stale facts are exact.
{
  let latest = cursor(10, 'evt-10');
  let earliest = cursor(1, 'evt-1');
  let factReads = 0;
  const cache = new CommitAwareFactBucketCache(
    {
      async latestCursor() {
        return latest;
      },
      async earliestCursor() {
        return earliest;
      },
      changes: noChanges,
      async facts(startMs) {
        factReads += 1;
        return [{ bucketStartMs: startMs, generation: factReads }];
      },
    },
    BUCKET_MS,
  );

  assert.equal((await cache.read(0, BUCKET_MS))?.[0]?.generation, 1);
  earliest = cursor(20, 'evt-20');
  latest = cursor(30, 'evt-30');
  assert.equal((await cache.read(0, BUCKET_MS))?.[0]?.generation, 2);
  assert.equal(cache.stats().journalResets, 1);
}

function dashboardFact(bucketStartMs, overrides = {}) {
  return {
    bucketStartMs,
    monitored: true,
    decisionStatus: 'succeeded',
    verdict: 'allow',
    tier: 'L1',
    riskType: 'other',
    riskCategory: 'atomic',
    riskName: 'Unclassified risk event',
    severityRank: 0,
    sessionKey: 'session-a',
    userId: 'user-a',
    workspacePath: '/workspace/a',
    eventCount: 1,
    blockedCount: 0,
    escalatedCount: 0,
    l2Count: 0,
    l3Count: 0,
    riskActivationCount: 0,
    riskyEventCount: 0,
    tokenCount: 0,
    latencyTotal: 1,
    riskScoreTotal: 0,
    lastEventAt: bucketStartMs,
    commandDangerCount: 0,
    promptInjectionCount: 0,
    dataLeakCount: 0,
    communicationRiskCount: 0,
    systemicRiskCount: 0,
    ...overrides,
  };
}

// Only the closed prefix is cached. The exact recent tail supplied by the caller participates in
// the same Dashboard contract without rescanning or polluting the stable prefix.
{
  const factReads = [];
  const cache = new DashboardHistoryBucketCache({
    async latestCursor() {
      return cursor(1, 'evt-initial');
    },
    changes: noChanges,
    async facts(startMs, endExclusiveMs) {
      factReads.push([startMs, endExclusiveMs]);
      const rows = [];
      for (
        let bucketStartMs = startMs;
        bucketStartMs < endExclusiveMs;
        bucketStartMs += BUCKET_MS
      ) {
        rows.push(dashboardFact(bucketStartMs));
      }
      return rows;
    },
  });

  const result = await cache.readWithTail(
    60_000,
    120_000,
    6,
    100_000,
    [
      dashboardFact(110_000, {
        verdict: 'block',
        blockedCount: 1,
        riskyEventCount: 1,
        riskScoreTotal: 76,
      }),
    ],
  );
  assert.deepEqual(factReads, [[0, 100_000]]);
  assert.equal(
    result?.dimensions.find((row) => row.period === 'current' && row.verdict === 'block')
      ?.eventCount,
    1,
  );
  assert.equal(
    result?.buckets.reduce((total, row) => total + row.blockedCount, 0),
    1,
  );
}

// Real Dashboard snapshots include milliseconds. Exact slices on both sides of the current-window
// boundary preserve the closed comparison semantics, while only complete 10-second buckets enter
// the reusable cache.
{
  const factReads = [];
  const cache = new DashboardHistoryBucketCache({
    async latestCursor() {
      return cursor(1, 'evt-initial');
    },
    changes: noChanges,
    async facts(startMs, endExclusiveMs) {
      factReads.push([startMs, endExclusiveMs]);
      return [dashboardFact(
        Math.floor(startMs / BUCKET_MS) * BUCKET_MS,
        {
          eventCount: 1,
          lastEventAt: startMs,
        },
      )];
    },
  });

  const result = await cache.readWithTail(
    65_432,
    125_432,
    6,
    100_000,
    [dashboardFact(120_000)],
  );
  assert.ok(result);
  assert.ok(factReads.some(([startMs, endMs]) => startMs === 5_432 && endMs === 10_000));
  assert.ok(factReads.some(([startMs, endMs]) => startMs === 60_000 && endMs === 65_432));
  assert.ok(factReads.some(([startMs, endMs]) => startMs === 65_432 && endMs === 70_000));
  assert.equal(
    result.dimensions
      .filter((row) => row.period === 'current')
      .reduce((total, row) => total + row.eventCount, 0),
    2,
  );
  assert.equal(
    result.dimensions
      .filter((row) => row.period === 'previous')
      .reduce((total, row) => total + row.eventCount, 0),
    3,
  );
}

// Persisted and hot deliveries are folded to one effective event. A stale hot delivery cannot
// overwrite a newer durable judgment, while a genuinely newer hot revision is immediately visible.
{
  const base = {
    eventId: 'evt-revision',
    at: 100,
    decisionUpdatedAt: 100,
  };
  const persistedRevision2 = {
    ...base,
    decisionRevision: 2,
    decisionUpdatedAt: 200,
    verdict: 'block',
  };
  const staleHotRevision1 = {
    ...base,
    decisionRevision: 1,
    decisionUpdatedAt: 300,
    verdict: 'allow',
  };
  assert.deepEqual(
    foldLatestEventRevisions([persistedRevision2, staleHotRevision1]),
    [persistedRevision2],
  );

  const hotRevision3 = {
    ...base,
    decisionRevision: 3,
    decisionUpdatedAt: 400,
    verdict: 'escalate',
  };
  assert.deepEqual(
    foldLatestEventRevisions([persistedRevision2, staleHotRevision1, hotRevision3]),
    [hotRevision3],
  );
}

const [aggregation, clickhouse, commitCache, dashboardCache, controller, frontendApi, packageJson] = await Promise.all([
  read('apps/api/src/security-monitoring/aggregation.service.ts'),
  read('apps/api/src/security-monitoring/clickhouse-store.ts'),
  read('apps/api/src/security-monitoring/commit-aware-fact-cache.ts'),
  read('apps/api/src/security-monitoring/dashboard-history-cache.ts'),
  read('apps/api/src/security-monitoring/security-monitoring.controller.ts'),
  read('apps/web/src/lib/api/security-center.ts'),
  read('package.json'),
]);
assert.match(aggregation, /DASHBOARD_HOT_TAIL_MS = REUSABLE_BUCKET_MS/);
assert.match(aggregation, /dashboardTailEvents/);
assert.match(aggregation, /foldLatestEventRevisions/);
assert.match(aggregation, /readWithTail/);
assert.match(clickhouse, /argMax\([\s\S]*?tuple\(at, _part, _part_offset\)/u);
assert.match(clickhouse, /argMax\(at, tuple\(decisionRevision, decisionUpdatedAt, at\)\) AS eventAt/u);
assert.doesNotMatch(clickhouse, /argMax\(at, tuple\(decisionRevision, decisionUpdatedAt, at\)\) AS at/u);
assert.match(clickhouse, /earliestEventCommitCursor/);
assert.match(clickhouse, /LIMIT 1 BY eventId/);
assert.match(commitCache, /maxFacts = 100_000/);
assert.match(commitCache, /maxEstimatedBytes = 96 \* 1024 \* 1024/);
assert.match(dashboardCache, /maxFacts = 250_000/);
assert.match(dashboardCache, /maxEstimatedBytes = 128 \* 1024 \* 1024/);
assert.match(aggregation, /historyFactCacheStatus\(\)/);
assert.match(controller, /historyFactCache: this\.agg\.historyFactCacheStatus\(\)/);
assert.match(frontendApi, /schemaVersion: "anysentry\.history-cache\.v1"/);
assert.match(packageJson, /verify:data-lifecycle-phase15/);

console.log('Data lifecycle Phase 15 verification passed');
