#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  agentAssetIdAliasesForEvent,
  agentAssetIdForEvent,
  agentRuntimeInstanceIdForEvent,
  detectedAgentIdentity,
} = require('../apps/api/dist/security-monitoring/agent-identity.js');
const {
  agentRuntimeIdentityAliasesFromAtoms,
  hostRootInstanceIdFromAtoms,
  projectAgentSemanticIdentity,
} = require('../apps/api/dist/security-monitoring/agent-semantic-identity.js');
const {
  AgentMetadataService,
} = require('../apps/api/dist/security-monitoring/agent-metadata.service.js');
const {
  AggregationService,
} = require('../apps/api/dist/security-monitoring/aggregation.service.js');

const podUid = '58271d30-7492-4d04-9bb6-0c015c1f1958';
const containerId = '639658d40342202a84d0bca5a7cbcc404d2394ea97f2617ea4849aa1e0a1a505';
const physicalWorkloadId = `k8s:default-cluster:${podUid}:${containerId}`;
const legacyInstanceId = `${podUid}/${containerId}`;

function baseEvent(overrides = {}) {
  const at = Date.now();
  return {
    schemaVersion: 'anysentry.agent_event.v1',
    eventId: overrides.eventId ?? `event-${Math.random()}`,
    at,
    eventKind: overrides.eventKind ?? 'FileAccess',
    eventCategory: overrides.eventCategory ?? 'file',
    source: overrides.source ?? 'observer',
    subject: overrides.subject ?? 'file /workspace/result.txt',
    workspacePath: '/workspace',
    agentId: 'k8s-pi-agent-manual',
    sessionId: 'session',
    userId: 'uid:1000',
    traceId: overrides.traceId ?? 'trace',
    spanId: overrides.spanId ?? 'span',
    runId: 'run',
    verdict: 'allow',
    tier: 'Rules',
    severity: 'info',
    reason: 'fixture',
    riskCategory: 'other',
    riskName: 'fixture',
    riskType: 'atomic',
    riskScore: 0,
    tokenCount: 0,
    latencyMs: 0,
    attributes: overrides.attributes ?? { path: '/workspace/result.txt' },
    process: overrides.process ?? {
      hostId: 'node-a',
      bootId: 'boot-a',
      pid: 3922002,
      pidNamespace: '4026533351',
      namespacePid: 549265,
      startTimeTicks: '56883916',
      comm: 'pi',
      exe: '/usr/local/bin/node',
      cwd: '/workspace',
      cgroup: `0::/kubepods.slice/kubepods-pod${podUid.replaceAll('-', '_')}.slice/cri-containerd-${containerId}.scope`,
    },
    attribution: overrides.attribution ?? {
      monitored: true,
      classification: 'confirmed_agent',
      agentScopeId: 'k8s-pi-agent-manual',
      agentDisplayName: 'k8s-pi-agent-manual',
      agentInstanceId: legacyInstanceId,
      physicalWorkloadId,
      workloadRef: {
        environment: 'kubernetes', kind: 'container', namespace: 'anysentry-agent-test',
        podUid, podName: 'pi-agent-1', containerName: 'agent',
      },
      rootPid: 3922002,
      rootStartTime: '56883916',
      confidence: 1,
      reason: 'authoritative_anchor',
      source: 'self_register',
      evidence: ['label:anysentry.io/workload-kind=agent'],
    },
    ...overrides,
  };
}

const observerEvent = baseEvent({ eventId: 'observer-file' });
const adapterEvent = baseEvent({
  eventId: 'adapter-tool',
  source: 'api',
  eventKind: 'AgentTool',
  eventCategory: 'tool',
  subject: 'Pi tool write completed',
  attributes: {
    'anysentry.adapter.runtime': 'pi',
    'gen_ai.tool.name': 'write',
    'anysentry.tool.resource_path': '/workspace/result.txt',
  },
  process: {
    bootId: 'boot-a',
    pid: 549265,
    pidNamespace: '4026533351',
    namespacePid: 549265,
    startTimeTicks: '56883916',
    cwd: '/workspace',
  },
  attribution: {
    monitored: true,
    classification: 'confirmed_agent',
    agentScopeId: 'k8s-pi-agent-manual',
    agentDisplayName: 'k8s-pi-agent-manual',
    agentInstanceId: legacyInstanceId,
    physicalWorkloadId,
    workloadRef: {
      environment: 'kubernetes',
      kind: 'container',
      namespace: 'anysentry-agent-test',
      podUid,
      podName: 'pi-agent-1',
      containerName: 'agent',
    },
    confidence: 1,
    reason: 'authoritative_anchor',
    source: 'kubernetes',
    evidence: ['server:authenticated-agent-adapter'],
  },
});

const observerIdentity = projectAgentSemanticIdentity(observerEvent);
const adapterIdentity = projectAgentSemanticIdentity(adapterEvent);
assert.equal(observerIdentity.canonicalIdentityKey, adapterIdentity.canonicalIdentityKey);
assert.match(observerIdentity.canonicalIdentityKey, /^k8s-agent-logical:v1:/u);
assert.equal(observerIdentity.canonicalRuntimeInstanceId, adapterIdentity.canonicalRuntimeInstanceId);
assert.equal(agentAssetIdForEvent(observerEvent), agentAssetIdForEvent(adapterEvent));
assert.equal(agentRuntimeInstanceIdForEvent(observerEvent), agentRuntimeInstanceIdForEvent(adapterEvent));
assert.equal(adapterIdentity.agentProduct, 'pi');
assert.equal(observerIdentity.bindingQuality, 'exact');

const snapshotKubernetesAliases = agentRuntimeIdentityAliasesFromAtoms({
  agentInstanceId: 'ari-kubernetes-runtime',
  physicalWorkloadId,
  hostId: 'node-a',
  bootId: 'boot-a',
  rootPid: 3922002,
  rootStartTime: '56883916',
});
assert.ok(snapshotKubernetesAliases.includes(physicalWorkloadId));
assert.ok(snapshotKubernetesAliases.includes(legacyInstanceId),
  'Runtime Snapshot physical identity derives the same Kubernetes canonical Runtime alias');

const snapshotHostAtoms = {
  agentInstanceId: 'ari-host-runtime',
  hostId: 'node-a',
  bootId: 'boot-a',
  rootPid: 100,
  rootStartTime: '1000',
};
const snapshotHostRoot = hostRootInstanceIdFromAtoms(snapshotHostAtoms);
assert.equal(snapshotHostRoot, 'host-root:node-a:boot-a:100:1000');
assert.ok(agentRuntimeIdentityAliasesFromAtoms(snapshotHostAtoms).includes(snapshotHostRoot),
  'independent Runtime Snapshot atoms derive the event model host-root identity');

const restartedPodUid = '68271d30-7492-4d04-9bb6-0c015c1f1959';
const restartedContainerId = '739658d40342202a84d0bca5a7cbcc404d2394ea97f2617ea4849aa1e0a1a506';
const restarted = structuredClone(adapterEvent);
restarted.eventId = 'adapter-tool-after-rollout';
restarted.attribution.agentInstanceId = `${restartedPodUid}/${restartedContainerId}`;
restarted.attribution.physicalWorkloadId = `k8s:default-cluster:${restartedPodUid}:${restartedContainerId}`;
restarted.attribution.workloadRef.podUid = restartedPodUid;
restarted.attribution.workloadRef.podName = 'pi-agent-2';
const restartedIdentity = projectAgentSemanticIdentity(restarted);
assert.equal(restartedIdentity.canonicalIdentityKey, adapterIdentity.canonicalIdentityKey,
  'a Kubernetes rollout keeps one Logical Agent anchor');
assert.notEqual(restartedIdentity.canonicalRuntimeInstanceId, adapterIdentity.canonicalRuntimeInstanceId,
  'a Kubernetes rollout still creates a distinct Runtime instance');
assert.ok(
  agentAssetIdAliasesForEvent(adapterEvent).includes(
    require('../apps/api/dist/security-monitoring/agent-identity.js').agentAssetIdForIdentityKey(physicalWorkloadId),
  ),
  'the former physical-workload-derived Asset remains a compatibility alias',
);
assert.ok(
  agentAssetIdAliasesForEvent(adapterEvent).includes(
    require('../apps/api/dist/security-monitoring/agent-identity.js').agentAssetIdForIdentityKey(legacyInstanceId),
  ),
  'the former raw instance-derived Asset remains a compatibility alias',
);

const relationalStub = {
  initialize: async () => false,
  configured: () => false,
  loadAgentMetadata: async () => [],
  saveAgentMetadata: async () => undefined,
};
const metadata = new AgentMetadataService(relationalStub);
const adapterResolved = metadata.resolveEvent(adapterEvent);
assert.equal(adapterResolved.agentAssetId, agentAssetIdForEvent(observerEvent));
const legacyPhysicalAssetId = require('../apps/api/dist/security-monitoring/agent-identity.js')
  .agentAssetIdForIdentityKey(physicalWorkloadId);
assert.equal(
  metadata.canonicalAgentAssetId(legacyPhysicalAssetId),
  adapterResolved.agentAssetId,
  'an observed legacy Asset deep link resolves to the canonical query-time Asset',
);

const physicalFirst = structuredClone(observerEvent);
physicalFirst.eventId = 'observer-before-logical-binding';
delete physicalFirst.attribution.physicalWorkloadId;
delete physicalFirst.attribution.workloadRef;
const orderIndependentMetadata = new AgentMetadataService(relationalStub);
const earlyPhysical = orderIndependentMetadata.resolveEvent(physicalFirst);
const laterLogical = orderIndependentMetadata.resolveEvent(adapterEvent);
const reboundPhysical = orderIndependentMetadata.resolveEvent(physicalFirst);
assert.notEqual(earlyPhysical.agentAssetId, laterLogical.agentAssetId,
  'the first physical-only fact may initially materialize a Runtime-scoped alias');
assert.equal(reboundPhysical.agentAssetId, laterLogical.agentAssetId,
  'a later strong logical anchor deterministically wins over the weaker physical/root alias');

const codexOne = baseEvent({
  eventId: 'codex-one',
  agentId: 'codex',
  workspacePath: '/workspace/a',
  process: {
    hostId: 'node-a', bootId: 'boot-a', pid: 100, ppid: 1,
    startTimeTicks: '1000', comm: 'codex', exe: '/usr/bin/codex', cwd: '/workspace/a',
  },
  attribution: {
    monitored: true, classification: 'probable_agent', agentScopeId: 'codex',
    agentDisplayName: 'Codex', rootPid: 100, rootStartTime: '1000', confidence: 0.85,
    reason: 'runtime_signature', source: 'process_signature', evidence: ['runtime_signature:commExact=codex'],
  },
});
const codexTwo = structuredClone(codexOne);
codexTwo.eventId = 'codex-two';
codexTwo.process.pid = 200;
codexTwo.process.startTimeTicks = '2000';
codexTwo.attribution.rootPid = 200;
codexTwo.attribution.rootStartTime = '2000';
assert.equal(detectedAgentIdentity(codexOne).agentProduct, 'codex');
assert.equal(detectedAgentIdentity(codexTwo).agentProduct, 'codex');
assert.notEqual(agentAssetIdForEvent(codexOne), agentAssetIdForEvent(codexTwo));
assert.notEqual(agentRuntimeInstanceIdForEvent(codexOne), agentRuntimeInstanceIdForEvent(codexTwo));

const judge = {
  query: () => [observerEvent, adapterEvent],
  listIncidents: () => [],
  committedEventProgress: () => [],
};
const aggregation = new AggregationService(judge, metadata, {}, {});
const inventory = aggregation.agentInventory({ timeType: 'last_3h', limit: 100 });
assert.equal(inventory.items.length, 1, 'Adapter and Observer facts form one Agent inventory item');
assert.equal(inventory.items[0].eventCount, 2);
assert.equal(inventory.items[0].agentInstanceId, legacyInstanceId);
assert.equal(inventory.items[0].identityBindingQuality, 'exact');

const physicalFirstJudge = { ...judge, query: () => [physicalFirst, adapterEvent] };
const physicalFirstAggregation = new AggregationService(
  physicalFirstJudge,
  new AgentMetadataService(relationalStub),
  {},
  {},
);
const physicalFirstInventory = physicalFirstAggregation.agentInventory({ timeType: 'last_3h', limit: 100 });
assert.equal(physicalFirstInventory.items.length, 1, 'batch grouping is independent of physical/semantic event order');
assert.equal(physicalFirstInventory.items[0].agentAssetId, laterLogical.agentAssetId);

console.log('General Agent semantic identity normalization verification passed');
