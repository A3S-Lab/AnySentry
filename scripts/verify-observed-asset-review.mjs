#!/usr/bin/env node

import assert from 'node:assert/strict';

const { ObservedAssetReviewService } = await import(
  '../apps/api/dist/security-monitoring/observed-asset-review.service.js'
);

const saved = [];
const audits = [];
let storedGlobalRevision = 0;
const relational = {
  configured: () => true,
  loadPlatformConfig: async () => undefined,
  compareAndSwapPlatformConfig: async (_key, expected, record) => {
    if (expected !== storedGlobalRevision) return 'conflict';
    storedGlobalRevision = record.globalRevision;
    saved.push(structuredClone(record));
    return 'saved';
  },
};
const audit = { record: (record) => audits.push(structuredClone(record)) };
const reviews = new ObservedAssetReviewService(relational, audit);
await reviews.onModuleInit();

const asset = {
  schemaVersion: 'anysentry.observed_asset.v1',
  subjectAssetId: 'service:k8s:cluster-a:anysentry:clickhouse',
  subjectAssetType: 'service',
  canonicalIdentityVersion: 'observed_asset.v1',
  displayName: 'clickhouse',
  aliases: [],
  logicalIdentityHash: 'a'.repeat(32),
  scope: { clusterId: 'cluster-a', namespace: 'anysentry', ownerKind: 'StatefulSet', ownerName: 'clickhouse' },
  existenceState: 'active',
  identity: { classification: 'unknown', revision: 1, source: 'kubernetes_inventory', effectiveAt: new Date().toISOString() },
  role: { role: 'anysentry_internal', revision: 1, source: 'kubernetes_inventory', effectiveAt: new Date().toISOString() },
  bindingQuality: 'logical',
  bindingRevision: 4,
  observationState: 'aggregate',
  captureProfile: 'self_health',
  runtimeSummary: { total: 1, starting: 0, current: 1, idle: 0, exited: 0, lost: 0, unknown: 0 },
  eventSummary: { eventCount: 50, eventKindCounts: { CaptureAggregate: 50 } },
  firstSeenAt: new Date().toISOString(),
  sources: ['kubernetes_inventory'],
  evidenceRefs: [],
  modelRevision: 9,
  updatedAt: new Date().toISOString(),
};

const first = await reviews.review(asset, {
  decision: 'non_agent',
  expectedReviewRevision: 0,
  expectedBindingRevision: 4,
  reason: 'verified AnySentry ClickHouse service',
}, { type: 'operator', id: 'reviewer-a' });
assert.equal(first.revision, 1);
assert.equal(first.durable, true);
assert.equal(reviews.current(asset.subjectAssetId)?.decision, 'non_agent');
assert.equal(reviews.effectiveAt(asset.subjectAssetId, first.effectiveAt - 1), undefined);
assert.equal(reviews.effectiveAt(asset.subjectAssetId, first.effectiveAt)?.decision, 'non_agent');
assert.equal(reviews.version(), 1);
assert.equal(saved.length >= 1, true);
assert.equal(audits.at(-1)?.action, 'asset.review.updated');

await assert.rejects(
  reviews.review(asset, {
    decision: 'unknown',
    expectedReviewRevision: 0,
    expectedBindingRevision: 4,
    reason: 'stale update',
  }, { type: 'operator', id: 'reviewer-b' }),
  /revision changed/u,
);

await assert.rejects(
  reviews.review({ ...asset, bindingQuality: 'weak' }, {
    decision: 'non_agent',
    expectedReviewRevision: 1,
    expectedBindingRevision: 4,
    reason: 'weak identity must fail',
  }, { type: 'operator', id: 'reviewer-b' }),
  /exact or logical/u,
);

const cleared = await reviews.review(asset, {
  decision: 'clear',
  expectedReviewRevision: 1,
  expectedBindingRevision: 4,
  reason: 'restore automatic identification',
}, { type: 'operator', id: 'reviewer-b' });
assert.equal(cleared.revision, 2);
assert.equal(reviews.current(asset.subjectAssetId), undefined);
assert.equal(reviews.effectiveAt(asset.subjectAssetId, cleared.effectiveAt - 1)?.decision, 'non_agent');
assert.equal(reviews.effectiveAt(asset.subjectAssetId, cleared.effectiveAt), undefined);
assert.deepEqual(reviews.historyFor(asset.subjectAssetId).map((item) => item.decision), ['non_agent', 'clear']);
assert.equal(audits.at(-1)?.action, 'asset.review.cleared');

const concurrent = await Promise.allSettled([
  reviews.review(asset, {
    decision: 'non_agent', expectedReviewRevision: 2, expectedBindingRevision: 4, reason: 'concurrent first',
  }, { type: 'operator', id: 'reviewer-c' }),
  reviews.review(asset, {
    decision: 'unknown', expectedReviewRevision: 2, expectedBindingRevision: 4, reason: 'concurrent second',
  }, { type: 'operator', id: 'reviewer-d' }),
]);
assert.equal(concurrent.filter((result) => result.status === 'fulfilled').length, 1);
assert.equal(concurrent.filter((result) => result.status === 'rejected').length, 1);
assert.equal(reviews.historyFor(asset.subjectAssetId).length, 3, 'same-process CAS must not overwrite concurrent revisions');
assert.equal(reviews.latestRevision(asset.subjectAssetId), 3, 'per-asset revision pointer is independent from bounded history retention');

const unavailable = new ObservedAssetReviewService({
  configured: () => true,
  loadPlatformConfig: async () => undefined,
  compareAndSwapPlatformConfig: async () => 'unavailable',
}, { record() { throw new Error('failed review must not be audited as success'); } });
await unavailable.onModuleInit();
await assert.rejects(
  unavailable.review(asset, {
    decision: 'non_agent', expectedReviewRevision: 0, expectedBindingRevision: 4, reason: 'storage failure',
  }, { type: 'operator', id: 'reviewer-e' }),
  /storage is unavailable/u,
);
assert.equal(unavailable.current(asset.subjectAssetId), undefined, 'non-durable review must never become effective');

console.log('Observed Asset review revision, weak-key rejection, persistence, and clear verification passed');
