#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  effectiveInfrastructureAction,
  infrastructureAuthoritativeSelectorErrors,
  InfrastructureRuleError,
  InfrastructureRuleService,
  infrastructureSelectorMatches,
  normalizeInfrastructureSelector,
} from '../apps/api/dist/security-monitoring/infrastructure-rule.service.js';

function actor(id) {
  return { id, type: 'operator', displayName: id };
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, item]) => [key, stableValue(item)]));
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

function stores(saved) {
  return {
    relational: {
      async loadPlatformConfig() {
        return saved.value ? { record: structuredClone(saved.value), updatedAt: Date.now() } : undefined;
      },
      async savePlatformConfig(_key, record) {
        saved.value = structuredClone(record);
        return true;
      },
      isReady() { return true; },
    },
    audit: {
      records: [],
      record(input) { this.records.push(structuredClone(input)); return input; },
    },
  };
}

const selector = normalizeInfrastructureSelector({
  placement: 'kubernetes',
  clusterId: 'prod-a',
  namespace: 'anysentry',
  ownerKind: 'StatefulSet',
  ownerName: 'clickhouse',
  containerName: 'clickhouse',
  labels: { 'io.anysentry.observe': 'false' },
});
assert.equal(infrastructureSelectorMatches(selector, {
  placement: 'kubernetes',
  clusterId: 'prod-a',
  namespace: 'anysentry',
  ownerKind: 'StatefulSet',
  ownerName: 'clickhouse',
  containerName: 'clickhouse',
  labels: { 'io.anysentry.observe': 'false' },
  physicalWorkloadId: 'k8s:clickhouse',
}), true);
assert.equal(infrastructureSelectorMatches(selector, {
  placement: 'kubernetes',
  clusterId: 'prod-a',
  namespace: 'agents',
  ownerKind: 'StatefulSet',
  ownerName: 'clickhouse',
  containerName: 'clickhouse',
  labels: { 'io.anysentry.observe': 'false' },
  physicalWorkloadId: 'k8s:other',
}), false);
assert.deepEqual(infrastructureAuthoritativeSelectorErrors(selector), []);
assert.ok(infrastructureAuthoritativeSelectorErrors(normalizeInfrastructureSelector({
  placement: 'kubernetes', clusterId: 'prod-a', namespace: 'anysentry', containerName: 'clickhouse',
})).some((error) => error.includes('ownerKind, ownerName')));
assert.ok(infrastructureAuthoritativeSelectorErrors(normalizeInfrastructureSelector({
  placement: 'docker', composeProject: 'tools',
})).some((error) => error.includes('composeProject+serviceName')));
const standaloneDockerSelector = normalizeInfrastructureSelector({
  placement: 'docker',
  containerName: 'a3s-k8s-test-control-plane',
  imageDigest: `sha256:${'c'.repeat(64)}`,
});
assert.deepEqual(infrastructureAuthoritativeSelectorErrors(standaloneDockerSelector), []);
assert.equal(infrastructureSelectorMatches(standaloneDockerSelector, {
  placement: 'docker',
  containerName: 'a3s-k8s-test-control-plane',
  imageDigest: `sha256:${'c'.repeat(64)}`,
  physicalWorkloadId: 'docker:kind-control-plane',
}), true);

const saved = {};
const dependencies = stores(saved);
let platformConflict = true;
const governanceWorkloads = [
  {
    assetId: 'asset-platform', displayName: 'AnySentry ClickHouse', workloadRole: 'platform_infrastructure',
    workload: {
      placement: 'kubernetes', clusterId: 'prod-a', namespace: 'anysentry', ownerKind: 'StatefulSet',
      ownerName: 'clickhouse', containerName: 'clickhouse', labels: { 'io.anysentry.observe': 'false' },
      physicalWorkloadId: 'k8s:clickhouse',
    },
  },
  {
    assetId: 'asset-host', displayName: 'Host ClickHouse', workloadRole: 'platform_infrastructure',
    workload: { placement: 'host', nodeId: 'node-a', systemdUnit: 'anysentry-clickhouse.service', physicalWorkloadId: 'host:node-a:systemd:anysentry-clickhouse.service' },
  },
  {
    assetId: 'asset-aggregate', displayName: 'Analytics ClickHouse', workloadRole: 'business_service',
    workload: { placement: 'docker', composeProject: 'analytics', serviceName: 'clickhouse', physicalWorkloadId: 'docker:analytics:clickhouse' },
  },
  {
    assetId: 'asset-bridge', displayName: 'Reviewed runtime', workloadRole: 'ordinary_process',
    workload: { placement: 'docker', composeProject: 'reviewed', serviceName: 'runtime', containerName: 'runtime', imageDigest: `sha256:${'d'.repeat(64)}`, labels: { 'anysentry.test/source': 'unknown-learning' }, physicalWorkloadId: 'docker:unknown-learning:reviewed-runtime' },
  },
];
const assetProvider = {
  snapshot() {
    return {
      schemaVersion: 'anysentry.infrastructure_asset_snapshot.v1', provider: 'unit', trusted: true,
      ready: true, destructiveReady: true, version: platformConflict ? 1 : 2, generatedAt: Date.now(), errors: [],
      assets: governanceWorkloads.map((item, index) => ({
        ...item, revision: 1, assetType: 'infrastructure', bindingQuality: 'exact',
        classification: item.assetId === 'asset-platform' && platformConflict ? 'confirmed_agent' : 'non_agent',
        conflict: item.assetId === 'asset-platform' && platformConflict,
        sharedScope: false, instanceCount: 1, nodeIds: [item.workload.nodeId].filter(Boolean),
        continuity: {
          currentPresenceVerified: true,
          observationCoverageAvailable: true,
          serviceContextAvailable: true,
          partialReasons: [],
        },
        workload: {
          ...item.workload,
          classification: item.assetId === 'asset-platform' && platformConflict ? 'confirmed_agent' : 'non_agent',
        },
      })),
    };
  },
};

// A durable PostgreSQL write is sufficient for the control-plane response. The optional
// ClickHouse migration mirror must not hold a generation-bound grant behind event-store pressure.
{
  let mirrorStarted = false;
  let releaseMirror;
  const primary = {
    isReady: () => true,
    loadPlatformConfig: async () => undefined,
    savePlatformConfig: async () => true,
  };
  const primaryService = new InfrastructureRuleService(primary, { record() {} });
  primaryService.ch.savePlatformConfig = async () => {
    mirrorStarted = true;
    return new Promise((resolve) => { releaseMirror = resolve; });
  };
  const created = await Promise.race([
    primaryService.create({
      name: 'Primary durability response fence',
      selector,
      source: { type: 'operator', sourceRef: 'primary-durability-test' },
    }, actor('primary-writer')),
    new Promise((_, reject) => setTimeout(() => reject(new Error('primary persistence waited for ClickHouse mirror')), 500)),
  ]);
  assert.equal(created.name, 'Primary durability response fence');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(mirrorStarted, true);
  releaseMirror(true);
  await new Promise((resolve) => setImmediate(resolve));
}

const service = new InfrastructureRuleService(dependencies.relational, dependencies.audit, assetProvider);
await service.onModuleInit();
const aggregateCaptureIntent = {
  schemaVersion: 'anysentry.infrastructure_capture_intent.v1',
  action: 'aggregate',
};

for (const unsafeSelector of [
  {
    placement: 'kubernetes', clusterId: 'prod-a', namespace: '*', ownerKind: 'StatefulSet',
    ownerName: 'clickhouse', containerName: 'clickhouse',
  },
  { placement: 'docker', composeProject: 'tools', serviceName: 'cache.*' },
  { placement: 'docker', composeProject: 'tools', serviceName: 'cache[0-9]' },
]) {
  await assert.rejects(
    service.create({
      name: 'Unsafe selector',
      selector: unsafeSelector,
      source: { type: 'platform_inventory' },
    }, actor('alice')),
    (error) => error instanceof InfrastructureRuleError && error.code === 'invalid_selector',
    'wildcard, glob, and regex selectors must be rejected instead of becoming empty constraints',
  );
}
await assert.rejects(
  service.create({
    name: 'Unsafe Host configured root',
    selector: { placement: 'host', nodeId: 'node-a', configuredRoot: '/opt/platform' },
    source: { type: 'operator' },
  }, actor('alice')),
  (error) => error instanceof InfrastructureRuleError && error.code === 'invalid_selector',
  'Host selector requires an exact systemdUnit; configuredRoot alone is insufficient',
);
await assert.rejects(
  service.create({
    name: 'Ambiguous capture semantics',
    selector: { placement: 'docker', composeProject: 'tools', serviceName: 'ambiguous' },
    source: { type: 'operator' },
    captureIntent: aggregateCaptureIntent,
    eventPolicies: { default: 'drop' },
  }, actor('alice')),
  (error) => error instanceof InfrastructureRuleError && error.code === 'invalid_selector',
  'a versioned captureIntent cannot be combined with legacy eventPolicies',
);

const candidate = await service.create({
  name: 'Behavior candidate',
  selector: { placement: 'docker', composeProject: 'tools', serviceName: 'cache' },
  source: { type: 'behavior_discovery', sourceRef: 'candidate-1' },
}, actor('alice'));
assert.equal(candidate.authority, 'candidate');
assert.equal(candidate.lifecycleStage, 'draft');
const candidateShadow = await service.shadow(candidate.ruleId, { expectedRevision: 1 }, actor('alice'));
assert.equal(effectiveInfrastructureAction(candidateShadow), 'sample');
assert.equal(service.validate(candidate.ruleId, { inventory: [{
  placement: 'docker', composeProject: 'tools', serviceName: 'cache', physicalWorkloadId: 'docker:cache', classification: 'non_agent',
}] }, actor('alice')).canPromoteToEnforced, false);
await assert.rejects(
  service.promote(candidate.ruleId, { expectedRevision: 2 }, actor('bob')),
  (error) => error instanceof InfrastructureRuleError && error.code === 'authority_required',
);

const platform = await service.create({
  name: 'AnySentry ClickHouse',
  selector,
  source: { type: 'platform_inventory', sourceRef: 'defaults/v1' },
  eventPolicies: {
    default: 'sample', FileAccess: 'drop', FileDelete: 'keep', Egress: 'sample',
    Dns: 'keep', SslContent: 'sample', LlmCall: 'drop',
  },
  changeTicket: 'SEC-1024',
}, actor('alice'));
const platformShadow = await service.shadow(platform.ruleId, { expectedRevision: 1 }, actor('alice'));
assert.equal(platformShadow.lifecycleStage, 'shadow');
const conflicted = service.validate(platform.ruleId, { inventory: [
  {
    placement: 'kubernetes', clusterId: 'prod-a', namespace: 'anysentry', ownerKind: 'StatefulSet', ownerName: 'clickhouse', containerName: 'clickhouse',
    labels: { 'io.anysentry.observe': 'false' }, physicalWorkloadId: 'k8s:clickhouse', classification: 'non_agent',
  },
  {
    placement: 'kubernetes', clusterId: 'prod-a', namespace: 'anysentry', ownerKind: 'StatefulSet', ownerName: 'clickhouse', containerName: 'clickhouse',
    labels: { 'io.anysentry.observe': 'false' }, physicalWorkloadId: 'k8s:agent-conflict', classification: 'confirmed_agent',
  },
] }, actor('alice'));
assert.equal(conflicted.valid, false);
assert.equal(conflicted.agentConflicts, 1);
await assert.rejects(
  service.promote(platform.ruleId, { expectedRevision: 2 }, actor('bob')),
  (error) => error instanceof InfrastructureRuleError && error.code === 'authority_required',
);

const cleanValidation = service.validate(platform.ruleId, { inventory: [{
  placement: 'kubernetes', clusterId: 'prod-a', namespace: 'anysentry', ownerKind: 'StatefulSet', ownerName: 'clickhouse', containerName: 'clickhouse',
  labels: { 'io.anysentry.observe': 'false' }, physicalWorkloadId: 'k8s:clickhouse', classification: 'non_agent',
}] }, actor('alice'));
assert.equal(cleanValidation.canPromoteToEnforced, false, 'client inventory cannot authorize promotion');
platformConflict = false;
await assert.rejects(
  service.promote(platform.ruleId, { expectedRevision: 2 }, actor('alice')),
  (error) => error instanceof InfrastructureRuleError && error.code === 'authority_required',
);
const enforced = await service.promote(platform.ruleId, { expectedRevision: 2 }, actor('bob'));
assert.equal(enforced.authority, 'authoritative');
assert.equal(enforced.lifecycleStage, 'enforced');
assert.equal(effectiveInfrastructureAction(enforced), 'drop');

const failingPersistence = new InfrastructureRuleService({
  async loadPlatformConfig() { return undefined; },
  async savePlatformConfig() { return false; },
  isReady() { return false; },
}, { record() {} }, assetProvider);
await failingPersistence.onModuleInit();
const volatileRule = await failingPersistence.create({
  name: 'Volatile enforced rule', selector, source: { type: 'platform_inventory', sourceRef: 'volatile' },
}, actor('volatile-author'));
const volatileShadow = await failingPersistence.shadow(
  volatileRule.ruleId,
  { expectedRevision: volatileRule.revision, reason: 'shadow before failed persistence' },
  actor('volatile-author'),
);
await assert.rejects(
  failingPersistence.promote(
    volatileRule.ruleId,
    { expectedRevision: volatileShadow.revision, reason: 'must not publish before durable commit' },
    actor('volatile-approver'),
  ),
  (error) => error instanceof InfrastructureRuleError && error.code === 'asset_provider_unavailable',
  'enforced revision must roll back when neither PostgreSQL nor ClickHouse persisted it',
);
assert.equal(failingPersistence.get(volatileRule.ruleId).lifecycleStage, 'shadow');
assert.equal(failingPersistence.policySnapshot().rules.some((rule) =>
  rule.ruleId === volatileRule.ruleId && rule.lifecycleStage === 'enforced'), false);

const weakDocker = await service.create({
  name: 'Incomplete Docker authority selector',
  selector: { placement: 'docker', composeProject: 'tools' },
  source: { type: 'platform_inventory' },
}, actor('alice'));
const weakDockerShadow = await service.shadow(weakDocker.ruleId, { expectedRevision: 1 }, actor('alice'));
const weakDockerValidation = service.validate(weakDocker.ruleId, { inventory: [{
  placement: 'docker', composeProject: 'tools', physicalWorkloadId: 'docker:tools', classification: 'non_agent',
}] }, actor('alice'));
assert.equal(weakDockerValidation.valid, false);
assert.ok(weakDockerValidation.errors.some((error) => error.includes('composeProject+serviceName')));
await assert.rejects(
  service.promote(weakDocker.ruleId, { expectedRevision: weakDockerShadow.revision }, actor('bob')),
  (error) => error instanceof InfrastructureRuleError && error.code === 'authority_required',
  'authoritative Docker drop requires a stable Compose or standalone image identity',
);
await service.revoke(weakDocker.ruleId, { expectedRevision: weakDockerShadow.revision }, actor('alice'));

const host = await service.create({
  name: 'Exact Host platform unit',
  selector: { placement: 'host', nodeId: 'node-a', systemdUnit: 'anysentry-clickhouse.service' },
  source: { type: 'operator', sourceRef: 'host-inventory/node-a' },
}, actor('alice'));
const hostShadow = await service.shadow(host.ruleId, { expectedRevision: 1 }, actor('alice'));
const hostValidation = service.validate(host.ruleId, { inventory: [{
  placement: 'host', nodeId: 'node-a', systemdUnit: 'anysentry-clickhouse.service',
  physicalWorkloadId: 'host:node-a:systemd:anysentry-clickhouse.service', classification: 'non_agent',
}] }, actor('alice'));
assert.equal(hostValidation.canPromoteToEnforced, false);
const hostEnforced = await service.promote(host.ruleId, { expectedRevision: hostShadow.revision }, actor('bob'));
assert.equal(hostEnforced.lifecycleStage, 'enforced');
assert.equal(hostEnforced.authority, 'authoritative');
assert.equal(effectiveInfrastructureAction(hostEnforced), 'drop');

const aggregateRule = await service.create({
  name: 'Aggregate service noise without dropping it',
  selector: { placement: 'docker', composeProject: 'analytics', serviceName: 'clickhouse' },
  source: { type: 'operator', sourceRef: 'asset:service:analytics-clickhouse' },
  captureIntent: aggregateCaptureIntent,
  reasonCode: 'reduce_repeated_infrastructure_signals',
}, actor('alice'));
assert.deepEqual(aggregateRule.captureIntent, aggregateCaptureIntent);
assert.equal(aggregateRule.eventPolicies, undefined);
assert.equal(effectiveInfrastructureAction(aggregateRule), 'sample',
  'the legacy post-Ring projection stays conservative for an aggregate Ring intent');
const aggregateShadow = await service.shadow(
  aggregateRule.ruleId,
  { expectedRevision: aggregateRule.revision },
  actor('alice'),
);
assert.deepEqual(aggregateShadow.captureIntent, aggregateCaptureIntent);
assert.deepEqual(
  service.policySnapshot().rules.find((rule) => rule.ruleId === aggregateRule.ruleId)?.captureIntent,
  aggregateCaptureIntent,
  'the shadow policy snapshot preserves the exact versioned Ring intent',
);
const aggregateValidation = service.validate(aggregateRule.ruleId, { inventory: [{
  placement: 'docker', composeProject: 'analytics', serviceName: 'clickhouse',
  physicalWorkloadId: 'docker:analytics:clickhouse', classification: 'non_agent',
}] }, actor('alice'));
assert.equal(aggregateValidation.canPromoteToEnforced, false);
const aggregateEnforced = await service.promote(
  aggregateRule.ruleId,
  { expectedRevision: aggregateShadow.revision },
  actor('bob'),
);
assert.deepEqual(aggregateEnforced.captureIntent, aggregateCaptureIntent);
assert.equal(effectiveInfrastructureAction(aggregateEnforced), 'sample',
  'promoting an aggregate intent must never project it to legacy DROP');
assert.deepEqual(
  service.policySnapshot().rules.find((rule) => rule.ruleId === aggregateRule.ruleId)?.captureIntent,
  aggregateCaptureIntent,
  'the enforced policy snapshot cannot drift from AGGREGATE to DROP',
);

const bridgePhysicalWorkloadId = 'docker:unknown-learning:reviewed-runtime';
const bridgeRecommendation = {
  policyId: `upol_${'1'.repeat(24)}`,
  policyRevision: 5,
  familyId: `ufam_${'2'.repeat(24)}`,
  clusterId: `ucl_${'3'.repeat(24)}`,
  reviewRevision: 1,
  desiredAction: 'aggregate',
  stableScope: `workload:${createHash('sha256').update(bridgePhysicalWorkloadId).digest('hex').slice(0, 32)}`,
  eventKind: 'FileAccess',
};
const bridgeWorkload = {
  placement: 'docker', composeProject: 'reviewed', serviceName: 'runtime', containerName: 'runtime',
  imageDigest: `sha256:${'d'.repeat(64)}`, labels: { 'anysentry.test/source': 'unknown-learning' },
  physicalWorkloadId: bridgePhysicalWorkloadId, classification: 'non_agent',
};
const bridgeRequest = {
  recommendation: bridgeRecommendation,
  request: {
    expectedPolicyRevision: 5,
    expectedReviewRevision: 1,
    reason: 'explicit bridge unit test',
    workload: bridgeWorkload,
    eventPolicies: { default: 'sample', FileAccess: 'drop' },
    priority: 120,
  },
};
await assert.rejects(
  service.createUnknownRecommendationDraft({
    ...bridgeRequest,
    request: { ...bridgeRequest.request, workload: { ...bridgeWorkload, classification: 'confirmed_agent' } },
  }, actor('bridge-author')),
  (error) => error instanceof InfrastructureRuleError && error.code === 'invalid_selector',
  'Unknown bridge cannot bind a current Agent inventory item',
);
const bridged = await service.createUnknownRecommendationDraft(bridgeRequest, actor('bridge-author'));
assert.equal(bridged.created, true);
assert.equal(bridged.bridge.operationDestructive, false);
assert.equal(bridged.rule.lifecycleStage, 'draft');
assert.equal(bridged.rule.authority, 'candidate');
assert.equal(effectiveInfrastructureAction(bridged.rule), 'sample');
assert.equal(bridged.rule.source.type, 'manual_review');
assert.equal(bridged.rule.eventPolicies.default, 'sample');
assert.equal(bridged.rule.eventPolicies.FileAccess, 'drop');
assert.equal(service.policySnapshot().rules.some((rule) => rule.ruleId === bridged.rule.ruleId), false);
const bridgeReplay = await service.createUnknownRecommendationDraft(bridgeRequest, actor('bridge-author'));
assert.equal(bridgeReplay.created, false);
assert.equal(bridgeReplay.rule.ruleId, bridged.rule.ruleId);
await assert.rejects(
  service.createUnknownRecommendationDraft({
    ...bridgeRequest,
    request: { ...bridgeRequest.request, eventPolicies: { default: 'sample', FileAccess: 'sample' } },
  }, actor('bridge-author')),
  (error) => error instanceof InfrastructureRuleError && error.code === 'revision_conflict',
  'one recommendation revision/scope cannot fork into conflicting Infrastructure intents',
);
await assert.rejects(
  service.promote(bridged.rule.ruleId, { expectedRevision: bridged.rule.revision }, actor('bridge-approver')),
  (error) => error instanceof InfrastructureRuleError && error.code === 'invalid_transition',
  'bridge cannot bypass draft -> shadow',
);
const bridgeShadow = await service.shadow(
  bridged.rule.ruleId,
  { expectedRevision: bridged.rule.revision, reason: 'independent shadow' },
  actor('bridge-author'),
);
const bridgeValidation = service.validate(
  bridged.rule.ruleId,
  { inventory: [bridgeWorkload] },
  actor('bridge-validator'),
);
assert.equal(bridgeValidation.canPromoteToEnforced, false);
const bridgeEnforced = await service.promote(
  bridged.rule.ruleId,
  { expectedRevision: bridgeShadow.revision, reason: 'second operator approval' },
  actor('bridge-approver'),
);
assert.equal(bridgeEnforced.lifecycleStage, 'enforced');
assert.equal(bridgeEnforced.authority, 'authoritative');
assert.notEqual(bridgeEnforced.createdBy, bridgeEnforced.approvedBy);
assert.ok(dependencies.audit.records.some((record) =>
  record.action === 'infrastructure_rule.created' &&
  record.details.unknownPolicyId === bridgeRecommendation.policyId &&
  record.details.scopeBindingHash === bridged.bridge.scopeBindingHash));

await assert.rejects(
  service.reportMaterialization({
    nodeId: 'node-a', policyVersion: service.status().policyVersion, epoch: 1,
    bindings: [{
      ruleId: candidateShadow.ruleId, ruleRevision: candidateShadow.revision,
      physicalWorkloadId: 'docker:cache', cgroupId: '100', action: 'drop',
    }],
  }, actor('node-a')),
  (error) => error instanceof InfrastructureRuleError && error.code === 'invalid_report',
  'candidate rule must never materialize a drop',
);

const report = await service.reportMaterialization({
  nodeId: 'node-a', policyVersion: service.status().policyVersion, epoch: 2,
  bindings: [
    {
      ruleId: candidateShadow.ruleId, ruleRevision: candidateShadow.revision,
      physicalWorkloadId: 'docker:cache', cgroupId: '100', action: 'sample',
    },
    {
      ruleId: enforced.ruleId, ruleRevision: enforced.revision,
      physicalWorkloadId: 'k8s:clickhouse', cgroupId: '200', action: 'drop',
    },
    {
      ruleId: enforced.ruleId, ruleRevision: enforced.revision,
      physicalWorkloadId: 'k8s:agent-conflict', cgroupId: '201', action: 'keep', agentKeepConflict: true,
    },
  ],
}, actor('node-a'));
assert.deepEqual(report.filterRuleEntries.map((entry) => entry.action), ['sample', 'drop', 'keep']);
assert.equal(report.filterRuleEntries[2].reasonCode, 'conflict_keep_preferred');
assert.equal(report.conflicts, 1);

const desiredProbeActions = {
  exec: 'full', exit: 'full', tls: 'sample', connect: 'sample', dns: 'full',
  file_access: 'drop', file_delete: 'sample', llm: 'drop', ssl: 'sample', security: 'full',
};
const previewProbeActions = {
  ...desiredProbeActions,
  file_access: 'aggregate',
  llm: 'sample',
};
const captureAck = {
  schemaVersion: 'anysentry.capture_profile_ack.v1',
  nodeId: 'node-a', collectorId: 'collector-a', collectorInstanceId: 'collector-instance-a',
  hostBootId: 'boot-a', publisherInstanceId: 'publisher-a',
  epoch: 3, policyVersion: service.status().policyVersion,
  contentHash: 'a'.repeat(64), intentHash: 'b'.repeat(64), entriesApplied: 1,
  appliedAt: new Date().toISOString(), status: 'applied', errors: [], downgrades: [],
  capabilities: {
    schemaVersions: ['anysentry.filter_rule_snapshot.v1'],
    probeNames: ['exec', 'exit', 'tls', 'connect', 'dns', 'file_access', 'file_delete', 'llm', 'ssl', 'security'],
    probeActions: ['full', 'aggregate', 'sample', 'drop'],
    captureProfileModes: ['shadow', 'enforce'],
    activationGrantV1: true,
  },
  capabilitiesHash: '',
  effectiveActionsHash: 'd'.repeat(64),
};
captureAck.capabilitiesHash = digest(captureAck.capabilities);
const captureRequest = {
  schemaVersion: 'anysentry.infrastructure_materialization_report.v1',
  reportId: `matr_${'c'.repeat(24)}`,
  nodeId: 'node-a', policyVersion: service.status().policyVersion, epoch: 3,
  snapshotContentHash: captureAck.contentHash,
  intentHash: captureAck.intentHash,
  activationMode: 'preview',
  publisherInstanceId: 'publisher-a',
  expectedEntries: 1,
  ack: captureAck,
  errors: [],
  bindings: [{
    ruleId: enforced.ruleId, ruleRevision: enforced.revision,
    physicalWorkloadId: 'k8s:clickhouse', cgroupId: '202', action: 'drop',
    effectiveAction: 'sample', captureProfile: 'infrastructure_aggregate',
    probeActions: previewProbeActions, desiredProbeActions,
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
  }],
};
const captureReport = await service.reportMaterialization(captureRequest, actor('node-a'));
assert.equal(captureReport.accepted, true);
assert.equal(captureReport.snapshotContentHash, captureRequest.snapshotContentHash);
assert.equal(captureReport.intentHash, captureRequest.intentHash);
assert.equal(captureReport.publisherInstanceId, 'publisher-a');
assert.deepEqual(captureReport.ack, captureAck);
assert.deepEqual(captureReport.filterRuleEntries[0].desiredProbeActions, desiredProbeActions);
assert(
  Date.parse(captureReport.filterRuleEntries[0].expiresAt) - captureReport.reportedAt >= 119_000,
  'Central acceptance aligns bindings to one full bounded report TTL',
);
const statusBeforeReportReplay = service.status();
const captureReportReplay = await service.reportMaterialization(structuredClone(captureRequest), actor('node-a'));
assert.deepEqual(captureReportReplay, captureReport,
  'a lost response retries the exact same materialization operation idempotently');
assert.deepEqual(service.status(), statusBeforeReportReplay,
  'an idempotent report replay creates no new state revision or report');
const conflictingReportReplay = structuredClone(captureRequest);
conflictingReportReplay.bindings[0].expiresAt = new Date(Date.now() + 40_000).toISOString();
await assert.rejects(
  service.reportMaterialization(conflictingReportReplay, actor('node-a')),
  (error) => error instanceof InfrastructureRuleError
    && error.code === 'invalid_report'
    && error.message.includes('already bound'),
  'one deterministic reportId cannot authorize a different preview operation',
);

const aggregateProbeActions = {
  exec: 'full', exit: 'full', tls: 'aggregate', connect: 'aggregate', dns: 'aggregate',
  file_access: 'aggregate', file_delete: 'sample', llm: 'aggregate', ssl: 'aggregate', security: 'full',
};
const aggregateCaptureRequest = structuredClone(captureRequest);
aggregateCaptureRequest.reportId = `matr_${'d'.repeat(24)}`;
aggregateCaptureRequest.epoch = 5;
aggregateCaptureRequest.snapshotContentHash = 'e'.repeat(64);
aggregateCaptureRequest.intentHash = 'f'.repeat(64);
aggregateCaptureRequest.ack.epoch = 5;
aggregateCaptureRequest.ack.contentHash = aggregateCaptureRequest.snapshotContentHash;
aggregateCaptureRequest.ack.intentHash = aggregateCaptureRequest.intentHash;
aggregateCaptureRequest.bindings = [{
  ruleId: aggregateEnforced.ruleId,
  ruleRevision: aggregateEnforced.revision,
  physicalWorkloadId: 'docker:analytics:clickhouse',
  cgroupId: '203',
  action: 'sample',
  effectiveAction: 'sample',
  captureProfile: 'infrastructure_aggregate',
  captureIntent: aggregateCaptureIntent,
  probeActions: aggregateProbeActions,
  desiredProbeActions: aggregateProbeActions,
  expiresAt: new Date(Date.now() + 30_000).toISOString(),
}];
const aggregateCaptureReport = await service.reportMaterialization(aggregateCaptureRequest, actor('node-a'));
assert.equal(aggregateCaptureReport.filterRuleEntries[0].action, 'sample');
assert.deepEqual(aggregateCaptureReport.filterRuleEntries[0].captureIntent, aggregateCaptureIntent);
assert.deepEqual(aggregateCaptureReport.filterRuleEntries[0].desiredProbeActions, aggregateProbeActions);
assert.equal(
  Object.values(aggregateCaptureReport.filterRuleEntries[0].desiredProbeActions).includes('drop'),
  false,
  'Central materialization of AGGREGATE must contain no latent DROP action',
);

const expandedDns = structuredClone(captureRequest);
expandedDns.epoch = 4;
expandedDns.ack.epoch = 4;
expandedDns.bindings[0].desiredProbeActions.dns = 'sample';
await assert.rejects(
  service.reportMaterialization(expandedDns, actor('node-a')),
  (error) => error instanceof InfrastructureRuleError && error.code === 'invalid_report',
  'central materialization must reject actions that differ from the rule eventPolicies matrix',
);

const revoked = await service.revoke(platform.ruleId, { expectedRevision: 3, reason: 'rollback canary' }, actor('bob'));
assert.equal(revoked.lifecycleStage, 'revoked');
assert.equal(service.policySnapshot().rules.some((rule) => rule.ruleId === platform.ruleId), false);
assert.ok(dependencies.audit.records.some((record) => record.action === 'infrastructure_rule.promoted'));
assert.ok(dependencies.audit.records.some((record) => record.result === 'failure'));

const restoredDependencies = stores(saved);
const restored = new InfrastructureRuleService(restoredDependencies.relational, restoredDependencies.audit);
await restored.onModuleInit();
assert.equal(restored.list().total, 6);
assert.equal(restored.get(platform.ruleId).lifecycleStage, 'revoked');
assert.equal(restored.get(host.ruleId).lifecycleStage, 'enforced');
assert.equal(restored.get(bridged.rule.ruleId).lifecycleStage, 'enforced');
assert.deepEqual(restored.get(aggregateRule.ruleId).captureIntent, aggregateCaptureIntent);
assert.equal(restored.policySnapshot().rules.length, 4);

console.log('Infrastructure rule service verification passed');
