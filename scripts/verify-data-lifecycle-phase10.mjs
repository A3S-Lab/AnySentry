import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const {
  DASHBOARD_HISTORY_CACHE_LIMIT,
  planDashboardRead,
  pruneSnapshotCache,
} = require('../apps/api/dist/security-monitoring/dashboard-query-plan.js');
const {
  foldLatestEventRevisions,
  isNewerEventRevision,
} = require('../apps/api/dist/security-monitoring/event-revision.js');
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

const plan = planDashboardRead(0, 100_000, 90_000, 60_000);
assert.deepEqual(plan, {
  snapshotAsOfMs: 100_000,
  persistedUntilMs: 90_000,
  hotFromMs: 30_000,
  hasDurableBoundary: true,
});
assert.deepEqual(planDashboardRead(10_000, 100_000, undefined), {
  snapshotAsOfMs: 100_000,
  persistedUntilMs: undefined,
  hotFromMs: 10_000,
  hasDurableBoundary: false,
});

const event = (revision, updatedAt, reason) => ({
  schemaVersion: 'anysentry.agent_event.v1',
  eventId: 'evt_phase10',
  traceId: 'tr_phase10',
  spanId: 'sp_phase10',
  source: 'observer',
  eventKind: 'ToolExec',
  eventCategory: 'tool',
  at: 1_000,
  subject: 'echo phase10',
  verdict: 'allow',
  tier: 'Rules',
  severity: 'info',
  reason,
  decisionRevision: revision,
  decisionUpdatedAt: updatedAt,
  attributes: {},
});
const revision1 = event(1, 1_000, 'revision 1');
const revision2 = event(2, 2_000, 'revision 2');
const duplicateRevision2 = event(2, 2_100, 'latest delivery of revision 2');
assert.equal(isNewerEventRevision(revision2, revision1), true);
assert.equal(isNewerEventRevision(revision1, revision2), false);
assert.deepEqual(
  foldLatestEventRevisions([revision1, revision2, duplicateRevision2]),
  [duplicateRevision2],
);

const cache = new Map();
for (let index = 0; index < DASHBOARD_HISTORY_CACHE_LIMIT + 4; index += 1) {
  cache.set(String(index), {
    startedAt: index,
    completedAt: index,
    ttlMs: index === 0 ? 1 : 60_000,
  });
}
pruneSnapshotCache(cache, 10, (entry) => entry.ttlMs);
assert.equal(cache.has('0'), false);
assert.equal(cache.size, DASHBOARD_HISTORY_CACHE_LIMIT);

const [aggregation, clickhouse, judge, types, page] = await Promise.all([
  read('apps/api/src/security-monitoring/aggregation.service.ts'),
  read('apps/api/src/security-monitoring/clickhouse-store.ts'),
  read('apps/api/src/security-monitoring/sentry-judge.service.ts'),
  read('apps/api/src/security-monitoring/types.ts'),
  read('apps/web/src/pages/SecurityMonitorPage.tsx'),
]);

assert.match(
  aggregation,
  /relevantCommitProgress\([\s\S]*this\.judge\.committedEventProgress\(\)/,
);
assert.match(aggregation, /commitProgress: progress\.entries\.map/);
assert.match(aggregation, /commitProgressScope: progress\.scope/);
assert.match(aggregation, /watermark: undefined/);
assert.match(aggregation, /pruneSnapshotCache\(this\.historyCache/);
assert.match(aggregation, /agentWindowFacts\([\s\S]*overlapEventIds/);
assert.match(aggregation, /agentMetricBucketFacts\([\s\S]*overlapEventIds/);
assert.match(aggregation, /workspaceWindowFacts\([\s\S]*overlapEventIds/);
assert.match(aggregation, /topologyWindowFacts\([\s\S]*overlapEventIds/);
assert.match(clickhouse, /ingestedAt UInt64 DEFAULT at/);
assert.match(clickhouse, /GROUP BY sourceId, collectorId/);
assert.match(clickhouse, /committedProgress\(\): CommittedSourceProgress\[\]/);
assert.match(judge, /isNewerEventRevision\(rec, current\)/);
assert.doesNotMatch(judge, /function decisionIsNewer/);
assert.match(types, /commitProgress\?: QueryCommitProgress\[\]/);
assert.match(page, /DASHBOARD_SNAPSHOT_QUANTUM_MS = 10_000/);
assert.match(page, /function dashboardSnapshotAsOf\(\)/);

console.log('Data lifecycle Phase 10 verification passed');
