#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { builtinFilterRules, CAPTURE_PROFILE_ACTIONS } = require('../apps/api/dist/security-monitoring/filter-rule-builtins.js');
const {
  compileFilterRuleEvaluationIndex,
  compileFilterRuleProjection,
  evaluateIndexedFilterRules,
  evaluateFilterRules,
  filterRuleIndexCandidates,
  matchFilterRule,
} = require('../apps/api/dist/security-monitoring/filter-rule-engine.js');
const { FilterRuleCatalogService } = require('../apps/api/dist/security-monitoring/filter-rule-catalog.service.js');
const { FilterRuleSystemService } = require('../apps/api/dist/security-monitoring/filter-rule-system.service.js');

const builtins = builtinFilterRules();
const versions = { identity: 2, capture: 3, forwarder: 4, retention: 5 };
assert(builtins.length >= 30, 'unified catalog must expose the complete builtin rule families');
for (const category of [
  'agent_identity',
  'infrastructure',
  'capture_profile',
  'forwarder_retention',
  'api_retention',
  'safety_guardrail',
]) {
  assert(builtins.some((rule) => rule.category === category), `missing builtin category ${category}`);
}
assert.equal(builtins.filter((rule) => rule.ruleKind === 'runtime_signature').length, 6);
assert.equal(Object.keys(CAPTURE_PROFILE_ACTIONS).length, 8);
for (const actions of Object.values(CAPTURE_PROFILE_ACTIONS)) {
  assert.equal(actions.exec, 'full');
  assert.equal(actions.exit, 'full');
  assert.equal(actions.security, 'full');
}

const codex = builtins.find((rule) => rule.ruleId === 'fr_builtin_agent_runtime_codex');
assert(codex);
assert.equal(matchFilterRule(codex, { process: { comm: 'codex' } }).matched, true);
assert.equal(matchFilterRule(codex, { process: { comm: 'clickhouse' } }).matched, false);
const identity = evaluateFilterRules({
  rules: builtins,
  context: { process: { comm: 'codex' }, identityClassification: 'unknown', workloadRole: 'unknown' },
  stage: 'f0',
  catalogVersion: 7,
  domainVersions: versions,
});
assert.equal(identity.winner?.ruleId, codex.ruleId);
assert.equal(identity.outcome?.type, 'emit_identity');
assert.equal(identity.outcome?.classification, 'probable_agent');

const conflict = evaluateFilterRules({
  rules: builtins,
  context: {
    identityClassification: 'probable_agent',
    workloadRole: 'platform_infrastructure',
    eventKind: 'FileAccess',
    probe: 'file_access',
    conflict: true,
  },
  stage: 'f1',
  catalogVersion: 7,
  domainVersions: versions,
});
assert.equal(conflict.winner?.ruleId, 'fr_guardrail_agent_conflict_keep');
assert.equal(conflict.outcome?.type, 'protect');
assert.equal(conflict.outcome?.captureAction, 'full');

const security = evaluateFilterRules({
  rules: builtins,
  context: { identityClassification: 'non_agent', workloadRole: 'platform_infrastructure', eventKind: 'SecurityAction' },
  stage: 'f3',
  catalogVersion: 7,
  domainVersions: versions,
});
assert.equal(security.winner?.ruleId, 'fr_guardrail_security_full');
assert.equal(security.outcome?.persistenceAction, 'retain_full');

const structural = evaluateFilterRules({
  rules: builtins,
  context: { identityClassification: 'non_agent', workloadRole: 'ordinary_process', eventKind: 'ToolExec' },
  stage: 'f3',
  catalogVersion: 7,
  domainVersions: versions,
});
assert.equal(structural.winner?.ruleId, 'fr_builtin_f3_non_agent_structural');
assert.equal(structural.outcome?.action, 'structural_consume');

const nonAgent = evaluateFilterRules({
  rules: builtins,
  context: { identityClassification: 'non_agent', workloadRole: 'business_service', eventKind: 'FileAccess' },
  stage: 'f3',
  catalogVersion: 7,
  domainVersions: versions,
});
assert.equal(nonAgent.winner?.ruleId, 'fr_builtin_f3_non_agent_discard');
assert.equal(nonAgent.outcome?.action, 'discard');

const unknownF2 = evaluateFilterRules({
  rules: builtins,
  context: { identityClassification: 'unknown', workloadRole: 'unknown', eventKind: 'FileAccess' },
  stage: 'f2',
  catalogVersion: 7,
  domainVersions: versions,
});
assert.equal(unknownF2.outcome?.action, 'keep');
const unknownF3 = evaluateFilterRules({
  rules: builtins,
  context: { identityClassification: 'unknown', workloadRole: 'unknown', eventKind: 'FileAccess' },
  stage: 'f3',
  catalogVersion: 7,
  domainVersions: versions,
});
assert.equal(unknownF3.outcome?.action, 'retain_l1_only');

const expiredInvestigation = {
  ...codex,
  ruleId: 'fr_expired_investigation_fixture',
  category: 'investigation',
  ruleKind: 'investigation_override',
  matcher: { all: [{ field: 'asset.id', operator: 'equals', value: 'asset:expired' }], description: 'asset:expired' },
  effect: { type: 'investigation', captureProfile: 'investigation_full', expiresAt: '2026-08-25T11:59:59.000Z', reasonCode: 'expired_fixture' },
  consumerCapabilities: ['f1', 'f2'],
};
const expiredReceipt = evaluateFilterRules({
  rules: [expiredInvestigation],
  context: { assetId: 'asset:expired', identityClassification: 'unknown', workloadRole: 'unknown' },
  stage: 'f1',
  catalogVersion: 7,
  domainVersions: versions,
  now: Date.parse('2026-08-25T12:00:00.000Z'),
});
assert.equal(expiredReceipt.winner, undefined);
assert.equal(expiredReceipt.failOpen, true);

const projection = compileFilterRuleProjection({ rules: builtins, catalogVersion: 7, domainVersions: versions, now: 1_787_630_000_000 });
assert.equal(projection.runtimeSignatures.runtimes.length, 6);
assert.equal(projection.runtimeSignatures.runtimes.find((runtime) => runtime.id === 'codex')?.ruleId, codex.ruleId);
assert.equal(projection.captureProfiles.agent_full.file_access, 'full');
assert.equal(projection.captureProfiles.infrastructure_aggregate.file_access, 'aggregate');
assert(projection.semanticRetentionRules.length >= 5);
assert(projection.persistenceRetentionRules.length >= 5);
assert(projection.safetyGuardrails.length >= 4);
assert.match(projection.contentHash, /^[a-f0-9]{64}$/u);

const denseIdentityRules = Array.from({ length: 2_000 }, (_, index) => ({
  ...codex,
  ruleId: `fr_dense_identity_${String(index).padStart(4, '0')}`,
  name: `Dense identity ${index}`,
  matcher: {
    all: [{ field: 'process.comm', operator: 'equals', value: `dense-runtime-${index}` }],
    description: `process.comm=dense-runtime-${index}`,
  },
  consumerCapabilities: ['f0'],
}));
const denseIndex = compileFilterRuleEvaluationIndex(denseIdentityRules);
const denseContext = { process: { comm: 'dense-runtime-1777' }, identityClassification: 'unknown', workloadRole: 'unknown' };
const denseCandidates = filterRuleIndexCandidates(denseIndex, denseContext);
assert.equal(denseCandidates.length, 1, 'the hot-path index must not scan 2,000 unrelated exact rules');
const denseIndexed = evaluateIndexedFilterRules({
  index: denseIndex,
  context: denseContext,
  stage: 'f0',
  catalogVersion: 7,
  domainVersions: versions,
});
const denseExhaustive = evaluateFilterRules({
  rules: denseIdentityRules,
  context: denseContext,
  stage: 'f0',
  catalogVersion: 7,
  domainVersions: versions,
});
assert.equal(denseIndexed.winner?.ruleId, denseExhaustive.winner?.ruleId);
assert.equal(denseIndex.bucketCount, 2_000);
assert.equal(denseIndex.maxBucketSize, 1);

const persisted = [];
const auditRecords = [];
const relational = {
  isReady: () => true,
  loadPlatformConfig: async () => undefined,
  savePlatformConfig: async (key, record, updatedAt) => {
    persisted.push({ key, record: structuredClone(record), updatedAt });
    return true;
  },
};
const audit = { record: (record) => auditRecords.push(record) };
const catalog = new FilterRuleCatalogService(relational, audit);
const creator = { type: 'operator', id: 'reviewer-a' };
const approver = { type: 'operator', id: 'reviewer-b' };
const draft = await catalog.createDraft({
  name: 'Internal Agent Runtime',
  description: 'Exact internal-agent executable signature',
  category: 'agent_identity',
  ruleKind: 'runtime_signature',
  matcher: {
    any: [{ field: 'process.exe_basename', operator: 'equals', value: 'internal-agent' }],
    description: 'process executable basename equals internal-agent',
  },
  effect: { type: 'emit_identity', classification: 'probable_agent', confidence: 0.85, captureProfile: 'probable_investigation' },
  reason: 'register a reviewed exact runtime signature',
}, creator);
assert.equal(draft.lifecycleStage, 'draft');
assert.equal(draft.authority, 'candidate');
assert.equal(draft.management, 'catalog');

const firstPreview = await catalog.preview(draft.ruleId, creator, { serverOwned: true, matchedAssets: 1, matchedInstances: 1, matchedNodes: 1 });
assert.equal(firstPreview.valid, true);
assert.equal(firstPreview.canEnterShadow, true);
const shadow = await catalog.shadow(draft.ruleId, { expectedRevision: draft.revision, reason: 'observe exact runtime matches' }, creator);
assert.equal(shadow.lifecycleStage, 'shadow');
const secondPreview = await catalog.preview(shadow.ruleId, creator, { serverOwned: true, matchedAssets: 1, matchedInstances: 1, matchedNodes: 1 });
assert.equal(secondPreview.canPromote, true);
await assert.rejects(
  catalog.promote(shadow.ruleId, { expectedRevision: shadow.revision, reason: 'self approval must fail' }, creator),
  (error) => error?.code === 'authority_required',
);
const enforced = await catalog.promote(shadow.ruleId, { expectedRevision: shadow.revision, reason: 'independent approval' }, approver);
assert.equal(enforced.lifecycleStage, 'enforced');
assert.equal(enforced.authority, 'authoritative');
assert.equal(enforced.approvedBy, approver.id);
assert(catalog.projection().runtimeSignatures.runtimes.some((runtime) => runtime.ruleId === enforced.ruleId));

const successorDraft = await catalog.createDraft({
  name: 'Internal Agent Runtime v2',
  description: 'Reviewed successor for the exact internal-agent executable signature',
  category: 'agent_identity',
  ruleKind: 'runtime_signature',
  matcher: {
    any: [{ field: 'process.exe_basename', operator: 'equals', value: 'internal-agent-v2' }],
    description: 'process executable basename equals internal-agent-v2',
  },
  effect: { type: 'emit_identity', classification: 'probable_agent', confidence: 0.85, captureProfile: 'probable_investigation' },
  reason: 'replace the reviewed runtime signature without mutating the enforced revision',
  predecessorRuleId: enforced.ruleId,
}, creator);
assert.equal(successorDraft.predecessorRuleId, enforced.ruleId);
assert.equal(successorDraft.lifecycleStage, 'draft');
await assert.rejects(
  catalog.createDraft({
    name: 'Invalid successor type',
    description: 'A successor cannot change rule kind or category',
    category: 'capture_profile',
    ruleKind: 'capture_profile',
    matcher: { all: [{ field: 'identity.classification', operator: 'equals', value: 'probable_agent' }], description: 'probable Agent' },
    effect: { type: 'assign_capture_profile', captureProfile: 'probable_investigation' },
    reason: 'adversarial successor verifier',
    predecessorRuleId: enforced.ruleId,
  }, creator),
  (error) => error?.code === 'invalid_rule' && /same|category|kind/u.test(error.message),
);
await assert.rejects(
  catalog.createDraft({
    name: 'Invalid builtin replacement',
    description: 'Builtins must only be replaced by their authoritative software source',
    category: 'agent_identity',
    ruleKind: 'runtime_signature',
    matcher: { all: [{ field: 'process.comm', operator: 'equals', value: 'codex-v2' }], description: 'codex-v2' },
    effect: { type: 'emit_identity', classification: 'probable_agent', confidence: 0.8 },
    reason: 'adversarial builtin successor verifier',
    predecessorRuleId: codex.ruleId,
  }, creator),
  (error) => error?.code === 'invalid_rule' && /authoritative source/u.test(error.message),
);
await catalog.revoke(successorDraft.ruleId, { expectedRevision: successorDraft.revision, reason: 'clean up successor verifier' }, creator);
const revoked = await catalog.revoke(enforced.ruleId, { expectedRevision: enforced.revision, reason: 'retire test signature' }, creator);
assert.equal(revoked.lifecycleStage, 'revoked');
assert(catalog.getRevisions(revoked.ruleId).length >= 4);
assert(catalog.listOperations(revoked.ruleId).some((operation) => operation.kind === 'promote'));
assert(persisted.length > 0);
assert(auditRecords.some((record) => record.action === 'filter_rule.promoted'));

await assert.rejects(
  catalog.createDraft({
    name: 'Unsafe Signature',
    description: 'Must not create confirmed identity from a process signature',
    category: 'agent_identity',
    ruleKind: 'runtime_signature',
    matcher: { all: [{ field: 'process.comm', operator: 'equals', value: 'unsafe-agent' }], description: 'unsafe-agent' },
    effect: { type: 'emit_identity', classification: 'confirmed_agent', confidence: 1, captureProfile: 'agent_full' },
    reason: 'adversarial verifier',
  }, creator),
  (error) => error?.code === 'invalid_rule',
);

await assert.rejects(
  catalog.createDraft({
    name: 'Unsafe Generic Drop',
    description: 'Must use an exact Infrastructure rule instead',
    category: 'capture_profile',
    ruleKind: 'capture_profile',
    matcher: { all: [{ field: 'workload.role', operator: 'equals', value: 'platform_infrastructure' }], description: 'all infrastructure' },
    effect: {
      type: 'assign_capture_profile',
      captureProfile: 'infrastructure_aggregate',
      probeActions: { ...CAPTURE_PROFILE_ACTIONS.infrastructure_aggregate, file_access: 'drop' },
    },
    reason: 'adversarial verifier',
  }, creator),
  (error) => error?.code === 'invalid_rule',
);

let ensuredAssetId;
const adapterRule = {
  schemaVersion: 'anysentry.infrastructure_rule.v1',
  ruleId: 'ifr_projection_adapter_fixture',
  revision: 3,
  name: 'Payments service context',
  selector: {
    placement: 'kubernetes', clusterId: 'cluster-a', namespace: 'production', ownerKind: 'Deployment',
    ownerName: 'payments', containerName: 'payments', labels: {},
  },
  effect: 'infrastructure',
  source: { type: 'kubernetes', sourceRef: 'asset:payments', issuer: 'inventory' },
  authority: 'authoritative',
  lifecycleStage: 'enforced',
  reasonCode: 'business_service_context',
  workloadRole: 'business_service',
  priority: 720,
  captureIntent: { schemaVersion: 'anysentry.infrastructure_capture_intent.v1', action: 'aggregate' },
  createdAt: 1_787_630_000_000,
  updatedAt: 1_787_630_100_000,
  createdBy: 'inventory',
  approvedBy: 'reviewer-b',
  contentHash: 'fixture-hash-not-consumed-by-adapter',
};
let infrastructureStateVersion = 5;
let infrastructurePolicyVersion = 7;
const infrastructureAdapter = {
  status: () => ({ stateVersion: infrastructureStateVersion, policyVersion: infrastructurePolicyVersion }),
  catalogRecords: () => [adapterRule],
  getHuman: () => ({
    scope: { label: 'Kubernetes / production / Deployment payments / payments', fields: [{ value: 'production' }, { value: 'payments' }] },
    intent: { description: 'Aggregate routine business-service signals' },
    reasonLabel: 'Business service context',
  }),
};
let heartbeatFixture;
const judgeFixture = {
  collectorHeartbeatHeads: () => ({ latestMetrics: heartbeatFixture ? [heartbeatFixture] : [] }),
};
const system = new FilterRuleSystemService(
  catalog,
  infrastructureAdapter,
  { list: () => [], identitySnapshotVersion: () => 0 },
  { listPolicies: () => [], catalogPolicies: () => [] },
  { snapshot: () => ({ version: 17 }) },
  judgeFixture,
  { snapshot: () => ({ provider: 'empty-governance-fixture', assets: [] }) },
  {
    ensureAsset: async (assetId) => { ensuredAssetId = assetId; return true; },
    detail: (assetId) => assetId === 'asset:observed-service' ? {
      asset: {
        subjectAssetId: assetId,
        displayName: 'Observed business service',
        subjectAssetType: 'service',
        identity: { classification: 'non_agent', source: 'human_asset_review' },
        role: { role: 'business_service', source: 'kubernetes_inventory' },
        scope: { clusterId: 'cluster-a', namespace: 'production', ownerKind: 'Deployment', ownerName: 'payments', containerName: 'payments' },
        bindingQuality: 'logical',
        existenceState: 'active',
      },
      runtimes: [{ runtimeInstanceId: 'runtime:payments:1', state: 'current', placement: 'kubernetes' }],
      bindings: [{ physicalWorkloadId: 'k8s:cluster-a:pod-a', validTo: undefined }],
    } : undefined,
  },
);
const assetExplain = await system.explain({ assetId: 'asset:observed-service' });
assert.equal(ensuredAssetId, 'asset:observed-service');
assert.equal(assetExplain.subject.type, 'asset');
assert.equal(assetExplain.context.identityClassification, 'non_agent');
assert.equal(assetExplain.context.workloadRole, 'business_service');
assert.deepEqual(assetExplain.stages.map((stage) => stage.stage), ['f0', 'f1', 'f2', 'f3']);
assert(assetExplain.context.facts.some((fact) => fact.label === 'Physical workload'));
const aggregateProjection = system.projection();
const projectedAdapter = aggregateProjection.identityRules.find((rule) => rule.ruleId === adapterRule.ruleId);
assert(projectedAdapter, 'the Forwarder projection must compile unified adapter rules, not only core Catalog rules');
assert.equal(projectedAdapter.effect.type, 'assign_role');
assert.equal(projectedAdapter.effect.role, 'business_service');
assert.equal(projectedAdapter.effect.captureProfile, 'business_context');
assert.equal(aggregateProjection.domainVersions.identity >= 6, true);
const stableAggregateVersions = system.versions();
infrastructureStateVersion += 1_000;
assert.deepEqual(system.versions(), stableAggregateVersions, 'physical materialization reports must not advance logical Catalog/domain versions');
heartbeatFixture = {
  at: Date.now(),
  filterMetricsReportedAt: Date.now(),
  nodeName: 'node-a',
  collectorId: 'collector-a',
  filterMetrics: {
    unifiedCatalogVersion: aggregateProjection.catalogVersion,
    unifiedIdentityVersion: aggregateProjection.domainVersions.identity,
    unifiedCaptureVersion: aggregateProjection.domainVersions.capture,
    unifiedForwarderVersion: aggregateProjection.domainVersions.forwarder,
    unifiedProjectionState: 'ready',
    identitySnapshotReady: true,
    identitySnapshotVersion: 24,
    identityKubernetesVersion: 17,
    identityDockerVersion: 7,
    identityErrors: 0,
    dockerEnabled: true,
    dockerReady: true,
    infrastructurePolicyVersion: 7,
    filteredNonAgent: 0,
    filteredUnknown: 0,
    filteredNoise: 0,
    discoveryBudgetDropped: 0,
    queueDropped: 0,
  },
};
const f0Status = system.status().stages.find((stage) => stage.stage === 'f0');
assert.equal(f0Status.status, 'ready', 'F0 must compare the central Kubernetes fact version, not Kubernetes+Docker sum');
assert.equal(f0Status.nodes[0].factVersion, 17);
assert.equal(f0Status.nodes[0].localFactVersion, 24);

console.log('PASS unified filter rule builtins, evaluator, projection, governance, and safety bounds');
