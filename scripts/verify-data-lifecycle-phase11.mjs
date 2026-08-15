import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const {
  DashboardHistoryBucketCache,
  dashboardHistoryFromFacts,
} = require('../apps/api/dist/security-monitoring/dashboard-history-cache.js');
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

const BUCKET_MS = 10_000;
const fact = (bucketStartMs, overrides = {}) => ({
  bucketStartMs,
  monitored: true,
  decisionStatus: 'succeeded',
  verdict: 'allow',
  tier: 'Rules',
  riskType: 'atomic',
  riskCategory: 'other',
  riskName: 'Unclassified risk event',
  severityRank: 0,
  sessionKey: 'session-phase11',
  userId: 'user-phase11',
  workspacePath: '/workspace/phase11',
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
  lastEventAt: bucketStartMs + 1,
  commandDangerCount: 0,
  promptInjectionCount: 0,
  dataLeakCount: 0,
  communicationRiskCount: 0,
  systemicRiskCount: 0,
  ...overrides,
});

const factsByBucket = new Map();
for (let bucket = 0; bucket < 80_000; bucket += BUCKET_MS) {
  factsByBucket.set(bucket, [fact(bucket)]);
}
const factReads = [];
let cursor = { committedAtMs: 100, eventId: 'evt_initial', decisionRevision: 1 };
const commitChanges = [];
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
    for (let bucket = Math.floor(startMs / BUCKET_MS) * BUCKET_MS;
      bucket < endExclusiveMs;
      bucket += BUCKET_MS) {
      if (bucket < startMs) continue;
      rows.push(...(factsByBucket.get(bucket) ?? []));
    }
    return rows;
  },
};

const cache = new DashboardHistoryBucketCache(provider, 100);

// The first read materialises the exact previous+current history once. The one-millisecond
// boundary query remains deliberately uncached because the public API uses a closed end timestamp.
const first = await cache.read(30_000, 60_000, 3);
assert.ok(first);
assert.deepEqual(factReads, [[0, 60_000], [60_000, 60_001]]);
assert.equal(first.buckets.reduce((sum, row) => sum + row.eventCount, 0), 4);
assert.equal(first.dimensions.find((row) => row.period === 'previous')?.eventCount, 3);
assert.equal(first.dimensions.find((row) => row.period === 'current')?.eventCount, 4);

// Moving the same preset window by one quantum reuses every closed bucket except the newly closed
// tail. It does not rescan the complete two-window history.
factReads.length = 0;
const second = await cache.read(40_000, 70_000, 3);
assert.ok(second);
assert.deepEqual(factReads, [[60_000, 70_000], [70_000, 70_001]]);

// A late revision changes a previously cached bucket. The durable commit journal invalidates that
// exact bucket, and only that bucket is re-read.
factsByBucket.set(20_000, [fact(20_000, {
  verdict: 'block',
  severityRank: 4,
  blockedCount: 1,
  riskActivationCount: 1,
  riskyEventCount: 1,
  riskScoreTotal: 95,
  commandDangerCount: 1,
})]);
cursor = { committedAtMs: 200, eventId: 'evt_late', decisionRevision: 2 };
commitChanges.push({
  cursor,
  eventAtMs: 20_001,
  sourceId: 'observer',
  collectorId: 'collector-phase11',
});
factReads.length = 0;
const revised = await cache.read(40_000, 70_000, 3);
assert.ok(revised);
assert.deepEqual(factReads, [[20_000, 30_000], [70_000, 70_001]]);
assert.equal(
  revised.dimensions.find((row) => row.period === 'previous' && row.verdict === 'block')?.eventCount,
  1,
);

// The pure fold keeps final revision facts additive and derives session/workspace summaries from
// complete facts rather than a sampled event list.
const folded = dashboardHistoryFromFacts([
  fact(10_000),
  fact(20_000, {
    verdict: 'escalate',
    severityRank: 3,
    escalatedCount: 1,
    riskActivationCount: 1,
    riskyEventCount: 1,
    riskScoreTotal: 76,
    sessionKey: 'session-risk',
  }),
], 20_000, 30_000, 2);
assert.equal(folded.topSession?.sessionId, 'session-risk');
assert.equal(folded.workspaces[0]?.sessionCount, 1);
assert.equal(folded.buckets.reduce((sum, row) => sum + row.eventCount, 0), 1);

const [aggregation, clickhouse, judge] = await Promise.all([
  read('apps/api/src/security-monitoring/aggregation.service.ts'),
  read('apps/api/src/security-monitoring/clickhouse-store.ts'),
  read('apps/api/src/security-monitoring/sentry-judge.service.ts'),
]);
assert.match(aggregation, /new DashboardHistoryBucketCache/);
assert.match(aggregation, /dashboardAggregateBucketFacts/);
assert.match(clickhouse, /CREATE MATERIALIZED VIEW IF NOT EXISTS \$\{EVENT_COMMIT_FACT_MV\}/);
assert.match(clickhouse, /LIMIT 1 BY eventId/);
assert.match(clickhouse, /ORDER BY \(committedAt, eventId, decisionRevision\)/);
assert.match(judge, /eventCommitChanges/);
assert.match(judge, /latestEventCommitCursor/);

console.log('Data lifecycle Phase 11 verification passed');
