#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { InfrastructureRuleService } = require('../apps/api/dist/security-monitoring/infrastructure-rule.service.js');

const auditRecords = [];
const relational = {
  isReady: () => true,
  loadPlatformConfig: async () => undefined,
  savePlatformConfig: async () => true,
};
const audit = { record: (record) => auditRecords.push(record) };
const workload = {
  placement: 'kubernetes',
  nodeId: 'node-a',
  clusterId: 'cluster-a',
  namespace: 'anysentry',
  ownerKind: 'StatefulSet',
  ownerName: 'clickhouse',
  containerName: 'clickhouse',
  imageDigest: 'sha256:' + 'a'.repeat(64),
  physicalWorkloadId: 'k8s:cluster-a:pod-clickhouse:container-clickhouse',
  classification: 'non_agent',
};
const asset = {
  assetId: 'asset_clickhouse',
  revision: 7,
  displayName: 'AnySentry ClickHouse',
  assetType: 'service',
  bindingQuality: 'logical',
  workloadRole: 'anysentry_internal',
  classification: 'non_agent',
  workload,
  instanceCount: 1,
  nodeIds: ['node-a'],
  recentLogicalEvents: 12_000,
  signalCounts: { FileAccess: 10_000, Egress: 2_000 },
  continuity: {
    currentPresenceVerified: true,
    observationCoverageAvailable: true,
    serviceContextAvailable: true,
    partialReasons: [],
  },
};
let assets = [asset];
const provider = {
  snapshot: () => ({
    schemaVersion: 'anysentry.infrastructure_asset_snapshot.v1',
    provider: 'verified-test-inventory',
    trusted: true,
    ready: true,
    destructiveReady: true,
    version: 19,
    generatedAt: Date.now(),
    assets,
    errors: [],
  }),
};

const creator = { id: 'reviewer-a', type: 'operator' };
const approver = { id: 'reviewer-b', type: 'operator' };
const service = new InfrastructureRuleService(relational, audit, provider);

const draft = await service.createDraftFromAsset({
  assetId: asset.assetId,
  expectedAssetRevision: asset.revision,
  intent: 'aggregate',
  reason: 'reduce repeated ClickHouse file and network signals',
}, creator);
assert.equal(draft.created, true);
assert.equal(draft.rule.status.stage, 'draft');
assert.equal(draft.rule.status.authority, 'candidate');
assert.equal(draft.rule.intent.action, 'aggregate');
assert.equal(draft.operation.status, 'succeeded');
for (const probe of ['exec', 'exit', 'security']) {
  const policy = draft.rule.protectedSignals.find((item) => item.probe === probe);
  assert.equal(policy?.protected, true);
  assert.equal(policy?.action, 'full');
}
const humanJson = JSON.stringify(draft.rule);
for (const internalField of ['"selector"', '"contentHash"', '"eventPolicies"', '"captureIntent"']) {
  assert(!humanJson.includes(internalField), `human read model must not expose ${internalField}`);
}
assert(draft.rule.scope.label.includes('Kubernetes'));
assert(draft.rule.scope.label.includes('clickhouse'));

const duplicate = await service.createDraftFromAsset({
  assetId: asset.assetId,
  expectedAssetRevision: asset.revision,
  intent: 'aggregate',
  reason: 'idempotent reviewer retry',
}, creator);
assert.equal(duplicate.created, false);
assert.equal(duplicate.rule.ruleId, draft.rule.ruleId);

const shadow = await service.shadow(draft.rule.ruleId, {
  expectedRevision: 1,
  reason: 'observe impact before enforcement',
}, creator);
assert.equal(shadow.lifecycleStage, 'shadow');
const preview = await service.impactPreview(shadow.ruleId, creator);
assert.equal(preview.valid, true);
assert.equal(preview.provider, 'verified-test-inventory');
assert.equal(preview.matchedAssets, 1);
assert.equal(preview.matchedInstances, 1);
assert.equal(preview.recentLogicalEvents, 12_000);
assert.equal(preview.lifecycleContinuous, true);
assert.equal(preview.serviceContextContinuous, true);
assert.deepEqual(preview.partialReasons, []);
assert.equal(preview.canPromoteToEnforced, true);

const enforced = await service.promote(shadow.ruleId, {
  expectedRevision: shadow.revision,
  reason: 'independent approval after server-owned preview',
}, approver);
assert.equal(enforced.lifecycleStage, 'enforced');
assert.equal(enforced.authority, 'authoritative');
assert.equal(enforced.approvedBy, approver.id);

const revoked = await service.revoke(enforced.ruleId, {
  expectedRevision: enforced.revision,
  reason: 'reviewer stopped the rule',
}, creator);
assert.equal(revoked.lifecycleStage, 'revoked');
const operations = service.listOperations({ ruleId: revoked.ruleId, limit: 20 });
assert(operations.items.some((operation) => operation.kind === 'shadow' && operation.status === 'succeeded'));
assert(operations.items.some((operation) => operation.kind === 'promote' && operation.status === 'succeeded'));
assert(operations.items.some((operation) => operation.kind === 'revoke' && operation.status === 'succeeded'));

assets = [{
  ...asset,
  continuity: {
    currentPresenceVerified: true,
    observationCoverageAvailable: false,
    serviceContextAvailable: false,
    partialReasons: ['observation_coverage_unavailable', 'service_context_metrics_unavailable'],
  },
}];
const partial = await service.impactPreview(revoked.ruleId, creator);
assert.equal(partial.valid, true, 'non-destructive preview may remain usable while disclosing partial continuity');
assert.equal(partial.lifecycleContinuous, false);
assert.equal(partial.serviceContextContinuous, false);
assert.deepEqual(partial.partialReasons, ['observation_coverage_unavailable', 'service_context_metrics_unavailable']);

const dropDraft = await service.createDraftFromAsset({
  assetId: asset.assetId,
  expectedAssetRevision: asset.revision,
  intent: 'drop',
  reason: 'destructive rule must fail closed without continuity evidence',
}, creator);
const dropPreview = await service.impactPreview(dropDraft.rule.ruleId, creator);
assert.equal(dropPreview.valid, false);
assert(dropPreview.errors.some((error) => error.includes('Observation Coverage')));
assert(dropPreview.errors.some((error) => error.includes('Service Context')));

assets = [
  asset,
  {
    ...asset,
    assetId: 'asset_agent_conflict',
    revision: 1,
    displayName: 'Embedded Agent conflict',
    classification: 'confirmed_agent',
    conflict: true,
  },
];
const conflicted = await service.impactPreview(revoked.ruleId, creator);
assert.equal(conflicted.valid, false);
assert.equal(conflicted.agentConflicts, 1);

const unavailable = new InfrastructureRuleService(relational, audit);
await assert.rejects(
  unavailable.createDraftFromAsset({
    assetId: asset.assetId,
    expectedAssetRevision: asset.revision,
    intent: 'aggregate',
    reason: 'must fail closed',
  }, creator),
  (error) => error?.code === 'asset_provider_unavailable',
);

assert(auditRecords.some((record) => record.action === 'infrastructure_rule.validated'));
console.log('PASS human Infrastructure rule governance, server-owned preview, and operation status');
