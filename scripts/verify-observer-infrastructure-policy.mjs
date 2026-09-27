#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { InfrastructurePolicyRegistry } = require('./observer-infrastructure-policy.js');
const { FilterRulePublisher } = require('./observer-filter-rules.js');

const now = Date.parse('2026-08-17T12:00:00.000Z');

function policy(lifecycleStage = 'enforced', placement = 'docker') {
  return {
    schemaVersion: 'anysentry.infrastructure_policy_snapshot.v1',
    policyVersion: lifecycleStage === 'enforced' ? 7 : 6,
    generatedAt: '2026-08-17T11:59:00.000Z',
    expiresAt: '2026-08-17T12:02:00.000Z',
    contentHash: 'a'.repeat(64),
    rules: [{
      schemaVersion: 'anysentry.infrastructure_rule.v1',
      ruleId: `${placement}-clickhouse`,
      revision: 3,
      name: 'ClickHouse infrastructure',
      selector: placement === 'docker'
        ? {
            placement: 'docker',
            composeProject: 'anysentry-modules-experiment',
            serviceName: 'clickhouse',
            labels: {},
          }
        : placement === 'kubernetes'
          ? {
              placement: 'kubernetes',
              clusterId: 'default',
              namespace: 'kube-system',
              ownerKind: 'Deployment',
              ownerName: 'coredns',
              containerName: 'coredns',
              labels: {},
            }
          : {
            placement: 'host',
            nodeId: 'node-a',
            systemdUnit: 'docker.service',
            labels: {},
          },
      effect: 'infrastructure',
      source: { type: 'platform_inventory', issuer: 'inventory-controller' },
      authority: lifecycleStage === 'enforced' ? 'authoritative' : 'candidate',
      lifecycleStage,
      reasonCode: 'platform_infrastructure',
      priority: 100,
      createdAt: now - 60_000,
      updatedAt: now - 30_000,
      createdBy: 'inventory-controller',
      contentHash: 'b'.repeat(64),
    }],
  };
}

const registry = new InfrastructurePolicyRegistry({ hostGroup: 'node-a', now: () => now });
assert.deepEqual(registry.replace(policy()), { ok: true, version: 7, rules: 1 });

const facts = {
  type: 'docker',
  hostGroup: 'node-a',
  composeProject: 'anysentry-modules-experiment',
  composeService: 'clickhouse',
  physicalWorkloadId: 'docker:node-a:clickhouse-container',
  cgroupId: '9001',
};
const file = registry.evaluateFacts(facts, 'FileAccess');
assert.equal(file.classification.state, 'infrastructure');
assert.equal(file.decision.action, 'drop');
assert.equal(file.fileDecision.action, 'drop');
assert.equal(file.fileDecision.policyVersion, 7);

const probePolicyDocument = policy();
probePolicyDocument.rules[0].eventPolicies = {
  default: 'sample',
  FileAccess: 'drop',
  FileDelete: 'keep',
  Egress: 'sample',
  Dns: 'keep',
  SslContent: 'sample',
  LlmCall: 'drop',
};
const probeRegistry = new InfrastructurePolicyRegistry({ hostGroup: 'node-a', now: () => now });
assert.equal(probeRegistry.replace(probePolicyDocument).ok, true);
const capture = probeRegistry.materializeCaptureProfile(facts);
assert.deepEqual(capture.desiredProbeActions, {
  exec: 'full',
  exit: 'full',
  security: 'full',
  tls: 'sample',
  connect: 'sample',
  dns: 'full',
  file_access: 'drop',
  file_delete: 'sample',
  llm: 'drop',
  ssl: 'sample',
  file_read: 'not_enabled',
});
assert.equal(capture.ruleId, 'docker-clickhouse');
assert.equal(capture.ruleRevision, 3);
assert.equal(
  probeRegistry.materializeCaptureProfile({ ...facts, workloadRole: 'anysentry_internal' }).captureProfile,
  'self_health',
);

const aggregateIntent = {
  schemaVersion: 'anysentry.infrastructure_capture_intent.v1',
  action: 'aggregate',
};
const aggregateShadowPolicy = policy('shadow');
aggregateShadowPolicy.rules[0].captureIntent = aggregateIntent;
const aggregateShadowRegistry = new InfrastructurePolicyRegistry({ hostGroup: 'node-a', now: () => now });
assert.equal(aggregateShadowRegistry.replace(aggregateShadowPolicy).ok, true);
const aggregateShadowCapture = aggregateShadowRegistry.materializeCaptureProfile(facts);
assert.deepEqual(aggregateShadowCapture.captureIntent, aggregateIntent);
assert.deepEqual(aggregateShadowCapture.desiredProbeActions, {
  exec: 'full', exit: 'full', security: 'full',
  tls: 'aggregate', connect: 'aggregate', dns: 'aggregate', file_access: 'aggregate',
  file_delete: 'sample', llm: 'aggregate', ssl: 'aggregate', file_read: 'not_enabled',
});
assert.equal(Object.values(aggregateShadowCapture.desiredProbeActions).includes('drop'), false);

const aggregateEnforcedPolicy = policy('enforced');
aggregateEnforcedPolicy.rules[0].captureIntent = aggregateIntent;
const aggregateEnforcedRegistry = new InfrastructurePolicyRegistry({ hostGroup: 'node-a', now: () => now });
assert.equal(aggregateEnforcedRegistry.replace(aggregateEnforcedPolicy).ok, true);
const aggregateEnforcedCapture = aggregateEnforcedRegistry.materializeCaptureProfile(facts);
assert.deepEqual(aggregateEnforcedCapture.captureIntent, aggregateIntent);
assert.deepEqual(
  aggregateEnforcedCapture.desiredProbeActions,
  aggregateShadowCapture.desiredProbeActions,
  'shadow to enforced cannot change an AGGREGATE Ring intent into DROP',
);
assert.equal(aggregateEnforcedCapture.action, 'sample',
  'the legacy post-Ring projection remains non-destructive for AGGREGATE');

const aggregatePublisher = new FilterRulePublisher({
  file: '/tmp/aggregate-capture-rules.json',
  fs: {
    readFileSync() {
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    },
    mkdirSync() {},
    writeFileSync() {},
    renameSync() {},
  },
  captureProfileMode: 'enforce',
  publisherInstanceId: 'aggregate-publisher',
  nodeId: 'node-a',
  collectorId: 'collector-a',
  hostBootId: 'boot-a',
  now: () => now,
  flushIntervalMs: 5_000,
});
aggregatePublisher.synchronizePolicyDecisions([aggregateEnforcedCapture], 7);
const aggregateSnapshot = aggregatePublisher.snapshot();
assert.deepEqual(aggregateSnapshot.entries[0].captureIntent, aggregateIntent);
assert.deepEqual(aggregateSnapshot.entries[0].probeActions, aggregateEnforcedCapture.desiredProbeActions);
assert.deepEqual(aggregateSnapshot.entries[0].desiredProbeActions, aggregateEnforcedCapture.desiredProbeActions);
assert.equal(Object.values(aggregateSnapshot.entries[0].probeActions).includes('drop'), false,
  'Observer materialization of AGGREGATE must remain non-destructive before and after activation');
aggregatePublisher.close();

const tool = registry.evaluateFacts(facts, 'ToolExec');
assert.equal(tool.decision.action, 'keep', 'Infrastructure ToolExec must reach the API structural lifecycle consumer');
assert.equal(tool.fileDecision.action, 'drop', 'the same cgroup must still publish its file prefilter');

const probableInvestigation = registry.evaluateFacts({
  ...facts,
  classification: 'probable_agent',
  agentInstanceId: 'agent-1',
}, 'FileAccess');
assert.equal(probableInvestigation.fileDecision.action, 'drop',
  'weak probable identity cannot override exact authoritative Infrastructure inventory');
assert.equal(probableInvestigation.fileDecision.reasonCode, 'platform_infrastructure');

const confirmedAgentConflict = registry.evaluateFacts({
  ...facts,
  classification: 'confirmed_agent',
  agentInstanceId: 'agent-confirmed',
}, 'FileAccess');
assert.equal(confirmedAgentConflict.fileDecision.action, 'keep');
assert.equal(confirmedAgentConflict.fileDecision.reasonCode, 'agent_keep_conflict');

const shadow = new InfrastructurePolicyRegistry({ hostGroup: 'node-a', now: () => now });
assert.equal(shadow.replace(policy('shadow')).ok, true);
const shadowResult = shadow.evaluateFacts(facts, 'FileAccess');
assert.equal(shadowResult.classification.state, 'unknown');
assert.equal(shadowResult.fileDecision.action, 'sample');
assert.equal(shadowResult.fileDecision.wouldAction, 'drop');

const fakeFs = {
  readFileSync() {
    const error = new Error('missing');
    error.code = 'ENOENT';
    throw error;
  },
  mkdirSync() {},
  writeFileSync() {},
  renameSync() {},
};
const publisher = new FilterRulePublisher({
  file: '/tmp/filter-rules.json',
  fs: fakeFs,
  now: () => now,
  flushIntervalMs: 5_000,
});
publisher.synchronizePolicyDecisions([file.fileDecision], 7);
assert.equal(publisher.snapshot().entries[0].action, 'drop');
publisher.synchronizePolicyDecisions([shadowResult.fileDecision], 6);
assert.equal(publisher.snapshot().entries[0].action, 'sample', 'rollback to shadow must remove a stale drop immediately');
publisher.synchronizePolicyDecisions([], 8);
assert.equal(publisher.snapshot().entries.length, 0, 'revoked/empty policy must remove managed entries');
publisher.close();

const host = new InfrastructurePolicyRegistry({ hostGroup: 'node-a', now: () => now });
assert.equal(host.replace(policy('enforced', 'host')).ok, true);
const hostFacts = host.hostInventory({
  cgroupRoot: '/sys/fs/cgroup',
  statSync(candidate) {
    if (candidate !== '/sys/fs/cgroup/system.slice/docker.service') throw new Error('missing');
    return { ino: 8123n };
  },
});
assert.deepEqual(hostFacts.map((item) => [item.systemdUnit, item.cgroupId]), [['docker.service', '8123']]);
assert.equal(host.evaluateFacts(hostFacts[0], 'FileAccess').fileDecision.action, 'drop');
assert.equal(host.replaceMaterializedFacts(hostFacts), 1);
const hostBoundEvent = host.evaluate({
  process: { cgroup_id: '8123', pid: 42, comm: 'dockerd', exe: '/usr/bin/dockerd' },
  event: { ToolExec: { pid: 42, argv: ['dockerd'] } },
});
assert.equal(hostBoundEvent.classification.state, 'infrastructure');
assert.equal(hostBoundEvent.decision.action, 'keep', 'host ToolExec remains a protected structural signal');

const kubernetes = new InfrastructurePolicyRegistry({ hostGroup: 'node-a', now: () => now });
assert.equal(kubernetes.replace(policy('enforced', 'kubernetes')).ok, true);
const containerId = 'c'.repeat(64);
const podUid = '4310c328-7cb3-4367-9f88-d47b7266ee9d';
const kubeFacts = kubernetes.resolveCgroupFacts({
  type: 'kubernetes',
  clusterId: 'default',
  namespace: 'kube-system',
  ownerKind: 'Deployment',
  ownerName: 'coredns',
  containerName: 'coredns',
  podUid,
  physicalWorkloadId: `k8s:default:${podUid}:${containerId}`,
}, {
  statSync(candidate) {
    const expected = `/sys/fs/cgroup/kubepods.slice/kubepods-burstable.slice/` +
      `kubepods-burstable-pod${podUid.replaceAll('-', '_')}.slice/cri-containerd-${containerId}.scope`;
    if (candidate !== expected) throw new Error('missing');
    return { ino: 26590n };
  },
});
assert.equal(kubeFacts.cgroupId, '26590');
assert.equal(kubernetes.evaluateFacts(kubeFacts, 'FileAccess').fileDecision.action, 'drop');
kubernetes.replaceMaterializedFacts([kubeFacts]);
const podLevelHit = kubernetes.evaluate({
  process: { cgroup_id: '26590', pid: 71 },
  event: { Egress: { pid: 71, peer: '10.43.0.10', port: 53 } },
}, {
  state: 'unknown',
  infrastructureFacts: {
    type: 'kubernetes',
    clusterId: 'default',
    namespace: 'kube-system',
    ownerKind: 'Deployment',
    ownerName: 'coredns',
    podUid,
    physicalWorkloadId: `k8s:default:${podUid}`,
  },
});
assert.equal(podLevelHit.classification.state, 'infrastructure');
assert.equal(podLevelHit.decision.action, 'drop');

const expired = new InfrastructurePolicyRegistry({ hostGroup: 'node-a', now: () => now + 10 * 60_000 });
assert.equal(expired.replace(policy()).ok, false);

console.log('Observer central Infrastructure policy verification passed');
