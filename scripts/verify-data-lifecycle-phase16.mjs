import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const {
  validPersistedDashboardBuckets,
} = require('../apps/api/dist/security-monitoring/persisted-dashboard-bucket.js');
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

const cursor = (committedAtMs, eventId, decisionRevision = 1) => ({
  committedAtMs,
  eventId,
  decisionRevision,
});
const snapshot = (bucketStartMs, snapshotCursor) => ({
  bucketStartMs,
  bucketMs: 10_000,
  cursor: snapshotCursor,
  facts: [{ bucketStartMs, eventCount: 1 }],
});

// A cold API process may reuse a durable bucket when the retained commit journal proves that no
// newer event or judgment revision was committed into that event-time bucket.
{
  const snapshots = [
    snapshot(0, cursor(100, 'evt-a', 1)),
    snapshot(10_000, cursor(100, 'evt-a', 1)),
  ];
  const valid = validPersistedDashboardBuckets(
    snapshots,
    [{ bucketStartMs: 0, cursor: cursor(100, 'evt-a', 1) }],
    cursor(50, 'evt-earliest', 1),
  );
  assert.deepEqual([...valid.keys()], [0, 10_000]);
}

// A late arrival or a newer L1/L2/L3 revision invalidates only the affected event-time bucket.
{
  const snapshots = [
    snapshot(0, cursor(100, 'evt-a', 1)),
    snapshot(10_000, cursor(100, 'evt-a', 1)),
  ];
  const valid = validPersistedDashboardBuckets(
    snapshots,
    [{ bucketStartMs: 0, cursor: cursor(120, 'evt-a', 2) }],
    cursor(50, 'evt-earliest', 1),
  );
  assert.equal(valid.has(0), false);
  assert.equal(valid.has(10_000), true);
}

// If the cache cursor predates the oldest retained journal row, absence of a change cannot prove
// continuity. Every such snapshot must be rebuilt from exact event facts.
{
  const valid = validPersistedDashboardBuckets(
    [snapshot(0, cursor(100, 'evt-a', 1))],
    [],
    cursor(101, 'evt-b', 1),
  );
  assert.equal(valid.size, 0);
}

const [clickhouse, helper, judge, controller, frontendApi, packageJson] = await Promise.all([
  read('apps/api/src/security-monitoring/clickhouse-store.ts'),
  read('apps/api/src/security-monitoring/persisted-dashboard-bucket.ts'),
  read('apps/api/src/security-monitoring/sentry-judge.service.ts'),
  read('apps/api/src/security-monitoring/security-monitoring.controller.ts'),
  read('apps/web/src/lib/api/security-center.ts'),
  read('package.json'),
]);

assert.match(clickhouse, /CREATE TABLE IF NOT EXISTS \$\{DASHBOARD_BUCKET_SNAPSHOT_TABLE\}/);
assert.match(clickhouse, /ENGINE = MergeTree/);
assert.match(clickhouse, /factsJson String/);
assert.match(clickhouse, /tuple\(snapshotCommittedAt, snapshotEventId, snapshotDecisionRevision, snapshotVersion\)/);
assert.match(clickhouse, /validPersistedDashboardBuckets/);
assert.match(clickhouse, /compareEventCommitCursor\(before, after\) === 0/);
assert.match(clickhouse, /dashboard bucket snapshot write failed/);
assert.match(clickhouse, /schemaVersion: 'anysentry\.dashboard-bucket-snapshots\.v1'/);
assert.match(helper, /Snapshots older than the retained commit journal are rejected/);
assert.match(judge, /dashboardBucketSnapshotStatus/);
assert.match(controller, /dashboardBucketSnapshots: this\.judge\.dashboardBucketSnapshotStatus\(\)/);
assert.match(frontendApi, /schemaVersion: "anysentry\.dashboard-bucket-snapshots\.v1"/);
assert.match(packageJson, /verify:data-lifecycle-phase16/);

console.log('Data lifecycle Phase 16 verification passed');
