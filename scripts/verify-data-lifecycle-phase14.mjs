import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [aggregation, clickhouse, judge] = await Promise.all([
  read('apps/api/src/security-monitoring/aggregation.service.ts'),
  read('apps/api/src/security-monitoring/clickhouse-store.ts'),
  read('apps/api/src/security-monitoring/sentry-judge.service.ts'),
]);

assert.match(clickhouse, /export interface StoredWorkspaceBucketFact extends StoredWorkspaceWindowFact/);
assert.match(clickhouse, /async workspaceWindowBucketFacts\(/);
assert.match(clickhouse, /at < \{endExclusive:UInt64\}/);
assert.match(clickhouse, /GROUP BY bucketStartMs, workspacePath/);
assert.match(clickhouse, /argMax\(at, tuple\(decisionRevision, decisionUpdatedAt, at\)\)/);

assert.match(judge, /workspaceWindowBucketFacts\(/);
assert.match(aggregation, /workspaceHistoryBuckets/);
assert.match(
  aggregation,
  /new CommitAwareFactBucketCache<StoredWorkspaceBucketFact>/,
);
assert.match(aggregation, /reusable workspace history failed/);
assert.match(aggregation, /const slices = reusableFactSlices\(window\.startMs, persistedUntilMs, plan\.hotFromMs\)/);

const cacheBlock = aggregation.slice(
  aggregation.indexOf('const slices = reusableFactSlices', aggregation.indexOf('async storedWorkspaceInventory')),
  aggregation.indexOf('if (!persisted) return this.workspaceInventory', aggregation.indexOf('async storedWorkspaceInventory')),
);
assert.match(cacheBlock, /cache\.read\(slices\.fullStartMs, slices\.fullEndExclusiveMs\)/);
assert.match(cacheBlock, /slices\.head/);
assert.match(cacheBlock, /slices\.tail/);
assert.match(cacheBlock, /workspaceWindowFacts\(/);
assert.match(cacheBlock, /overlapEventIds/);
assert.match(cacheBlock, /persisted = \[\.\.\.headFacts, \.\.\.reusableFacts, \.\.\.tailFacts\]/);

console.log('Data lifecycle Phase 14 verification passed');
