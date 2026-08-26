#!/usr/bin/env node

import assert from 'node:assert/strict';

const { InfrastructureAssetSnapshotService } = await import(
  '../apps/api/dist/security-monitoring/infrastructure-asset-snapshot.service.js'
);

const now = Date.now();
const podId = 'k8s:cluster-a:pod-uid-a';
const containerId = `${podId}:${'a'.repeat(64)}`;
const serviceInventory = {
  schemaVersion: 'anysentry.service_inventory.v1',
  version: 9,
  generatedAt: new Date(now).toISOString(),
  ready: true,
  errors: 0,
  items: [{
    serviceAssetId: 'service:k8s:cluster-a:anysentry:clickhouse',
    name: 'clickhouse', namespace: 'anysentry', clusterId: 'cluster-a', kind: 'database',
    role: 'anysentry_internal', ownerKind: 'StatefulSet', ownerName: 'clickhouse', revision: 'sts-r9',
    images: [], replicas: { observed: 1, ready: 1 }, restarts: 0, phaseCounts: { Running: 1 },
    physicalWorkloadIds: [podId], runtimeInstanceIds: [containerId], endpointAliases: [],
    metrics: [{
      name: 'kubernetes.replicas.ready_ratio', value: 1, unit: 'ratio',
      category: 'availability', status: 'normal', observedAt: now,
    }],
    observedAt: now,
  }],
  dependencies: [], changes: [],
};
const workloadInventory = {
  schemaVersion: 'anysentry.workload_identity_snapshot.v1', version: 10,
  generatedAt: new Date(now).toISOString(), ready: true, errors: 0,
  entries: [{
    ids: ['pi'], classification: 'confirmed_agent', workloadRole: 'agent', physicalWorkloadId: containerId,
    environment: 'kubernetes', source: 'kubernetes', agentScopeId: 'pi', agentInstanceId: containerId,
    namespace: 'anysentry', podName: 'clickhouse-0', podUid: 'pod-uid-a', nodeName: 'node-a',
    containerName: 'clickhouse', ownerKind: 'StatefulSet', ownerName: 'clickhouse', evidence: ['fixture'],
  }],
};
const kube = { serviceInventory: () => serviceInventory, snapshot: () => workloadInventory };
const aggregation = {
  agentInventory: () => ({
    items: [], total: 900, summary: {},
    coverage: { partial: true, source: 'memory_hot_ring', totalMode: 'estimated' },
    updateTime: new Date(now).toISOString(),
  }),
};
const reviews = {
  version: () => 3,
  current: (assetId) => assetId.startsWith('service:')
    ? { decision: 'non_agent', revision: 2, globalRevision: 3, durable: true }
    : undefined,
};
const runtime = {
  list: () => ({ items: [], total: 0, updateTime: new Date(now).toISOString() }),
};

const provider = new InfrastructureAssetSnapshotService(aggregation, kube, reviews, runtime);
const snapshot = provider.snapshot();
assert.equal(snapshot.ready, true);
assert.equal(snapshot.destructiveReady, true, 'complete Kube and Runtime inventories fence destructive readiness');
assert(snapshot.partialReasons.includes('agent_event_inventory_partial'));
const service = snapshot.assets.find((asset) => asset.assetId.startsWith('service:'));
assert(service);
assert.equal(service.classification, 'non_agent');
assert.equal(service.sharedScope, true, 'pod-level Service must detect the container-level Agent binding');
assert.equal(service.workload.containerName, 'clickhouse');
assert.deepEqual(service.nodeIds, ['node-a']);
assert.equal(service.continuity.currentPresenceVerified, true);
assert.equal(service.continuity.observationCoverageAvailable, false);
assert.equal(service.continuity.serviceContextAvailable, true);
assert(service.continuity.partialReasons.includes('observation_coverage_unavailable'));
assert(snapshot.assets.some((asset) => asset.classification === 'confirmed_agent' && asset.workload.physicalWorkloadId === containerId));

const truncatedRuntime = new InfrastructureAssetSnapshotService(
  aggregation,
  kube,
  reviews,
  { list: () => ({ items: [], total: 1, updateTime: new Date(now).toISOString() }) },
).snapshot();
assert.equal(truncatedRuntime.ready, false);
assert.equal(truncatedRuntime.destructiveReady, false);
assert(truncatedRuntime.errors.includes('agent_runtime_inventory_truncated'));

console.log('Infrastructure server-owned asset snapshot completeness and pod/container binding verification passed');
