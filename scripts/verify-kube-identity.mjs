#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.KUBERNETES_SERVICE_HOST = 'kubernetes.test';
process.env.ANYSENTRY_AGENT_NAMESPACES = 'agents';
process.env.ANYSENTRY_AGENT_LABEL_SELECTOR = 'anysentry.io/workload-kind=agent';
process.env.ANYSENTRY_CLUSTER_ID = 'test-cluster';

const require = createRequire(import.meta.url);
const { KubeIdentityService } = require('../apps/api/dist/security-monitoring/kube-identity.service.js');

const service = new KubeIdentityService();
assert.equal(
  service.podsPath('*', new URLSearchParams({ limit: '1' })),
  '/api/v1/pods?limit=1',
  'wildcard namespace uses the cluster-scoped Pod endpoint',
);
const agentId = 'a'.repeat(64);
const sidecarId = 'b'.repeat(64);
const infraId = 'c'.repeat(64);
const labelledInfraId = 'd'.repeat(64);
const invalidRoleId = 'f'.repeat(64);
const invalidSelectedAgentId = 'g'.repeat(64);
const invalidSelectedSidecarId = 'h'.repeat(64);
const redisId = '1'.repeat(64);
const apiId = '2'.repeat(64);
const businessId = '3'.repeat(64);
const agentPod = {
  metadata: {
    uid: 'pod-agent-uid',
    name: 'claw-agent-7',
    namespace: 'agents',
    labels: {
      'anysentry.io/workload-kind': 'agent',
      'anysentry.io/agent-id': 'claw-agent',
      'anysentry.io/agent-container': 'agent',
    },
    ownerReferences: [
      { kind: 'Deployment', name: 'claw-agent', uid: 'owner-uid', controller: true },
    ],
  },
  spec: {
    nodeName: 'node-a',
    containers: [
      {
        name: 'agent',
        image: 'company/claw:v1',
        livenessProbe: { exec: { command: ['/usr/bin/test', '-f', '/tmp/agent-ready'] } },
        readinessProbe: { exec: { command: ['/usr/bin/test', '-f', '/tmp/agent-ready'] } },
        startupProbe: { exec: { command: ['/usr/bin/test', '-f', '/tmp/agent-started'] } },
      },
      {
        name: 'metrics',
        image: 'company/metrics:v1',
        livenessProbe: { httpGet: { path: '/healthz', port: 9090 } },
        readinessProbe: { tcpSocket: { port: 9090 } },
      },
    ],
  },
  status: {
    containerStatuses: [
      { name: 'agent', containerID: `containerd://${agentId}` },
      { name: 'metrics', containerID: `containerd://${sidecarId}` },
    ],
  },
};
const infraPod = {
  metadata: {
    uid: 'pod-infra-uid',
    name: 'database',
    namespace: 'agents',
    labels: {},
  },
  spec: {
    nodeName: 'node-b',
    containers: [{ name: 'database', image: 'company/database:v1' }],
  },
  status: {
    containerStatuses: [{ name: 'database', containerID: `containerd://${infraId}` }],
  },
};
const labelledInfraPod = {
  metadata: {
    uid: 'pod-labelled-infra-uid',
    name: 'clickhouse',
    namespace: 'agents',
    labels: {
      'io.anysentry.observe': 'false',
      'anysentry.io/workload-role': 'anysentry_internal',
    },
  },
  spec: { nodeName: 'node-b', containers: [{
    name: 'clickhouse',
    image: 'clickhouse/clickhouse-server:24.8',
    env: [{ name: 'CLICKHOUSE_USER', value: 'anysentry' }],
    resources: {
      requests: { cpu: '250m', memory: '1Gi' }, limits: { cpu: '2', memory: '4Gi' },
    },
  }] },
  status: { phase: 'Running', podIP: '10.10.0.10', startTime: '2026-08-21T00:00:00Z', containerStatuses: [
    { name: 'clickhouse', containerID: `containerd://${labelledInfraId}`, ready: true, restartCount: 0 },
  ] },
};
const redisPod = {
  metadata: { uid: 'pod-redis-uid', name: 'redis-0', namespace: 'agents', labels: {
    app: 'redis', 'io.anysentry.observe': 'false', 'anysentry.io/workload-role': 'anysentry_internal',
  }, ownerReferences: [{ kind: 'StatefulSet', name: 'redis', controller: true }] },
  spec: { nodeName: 'node-b', containers: [{ name: 'redis', image: 'redis:7.4-alpine', resources: {
    requests: { cpu: '100m', memory: '128Mi' }, limits: { cpu: '1', memory: '1Gi' },
  } }] },
  status: { phase: 'Running', podIP: '10.10.0.11', startTime: '2026-08-21T00:00:01Z', containerStatuses: [
    { name: 'redis', containerID: `containerd://${redisId}`, ready: true, restartCount: 1 },
  ] },
};
const apiPod = {
  metadata: { uid: 'pod-api-uid', name: 'anysentry-api-hash', namespace: 'agents', labels: {
    app: 'anysentry', 'io.anysentry.observe': 'false', 'anysentry.io/workload-role': 'anysentry_internal',
  }, ownerReferences: [{ kind: 'Deployment', name: 'anysentry', controller: true }] },
  spec: { nodeName: 'node-b', containers: [{ name: 'anysentry', image: 'anysentry:test', env: [
    { name: 'CLICKHOUSE_URL', value: 'http://clickhouse:8123' },
    { name: 'REDIS_URL', value: 'redis://redis:6379' },
  ], resources: { requests: { cpu: '50m', memory: '128Mi' }, limits: { cpu: '2', memory: '2Gi' } } }] },
  status: { phase: 'Running', podIP: '10.10.0.12', startTime: '2026-08-21T00:00:02Z', containerStatuses: [
    { name: 'anysentry', containerID: `containerd://${apiId}`, ready: true, restartCount: 0 },
  ] },
};
const businessPod = {
  metadata: {
    uid: 'pod-business-uid',
    name: 'orders-api-hash',
    namespace: 'agents',
    labels: { app: 'orders-api' },
    ownerReferences: [{ kind: 'Deployment', name: 'orders-api', controller: true }],
  },
  spec: { nodeName: 'node-b', containers: [{ name: 'api', image: 'company/orders-api:v1' }] },
  status: { phase: 'Running', podIP: '10.10.0.13', containerStatuses: [
    { name: 'api', containerID: `containerd://${businessId}`, ready: true, restartCount: 0 },
  ] },
};
const otherClickhousePod = {
  metadata: {
    uid: 'pod-other-clickhouse-uid',
    name: 'clickhouse-other',
    namespace: 'other',
    labels: { app: 'clickhouse' },
    ownerReferences: [{ kind: 'Deployment', name: 'clickhouse', controller: true }],
  },
  spec: { nodeName: 'node-c', containers: [{ name: 'clickhouse', image: 'clickhouse/clickhouse-server:24.8' }] },
  status: { phase: 'Running', podIP: '10.20.0.10', containerStatuses: [
    { name: 'clickhouse', containerID: `containerd://${'f'.repeat(64)}`, ready: true, restartCount: 0 },
  ] },
};
const replicaSetOwnedPod = {
  metadata: {
    uid: 'pod-coredns-uid',
    name: 'coredns-hash-1',
    namespace: 'agents',
    labels: {},
    ownerReferences: [{ kind: 'ReplicaSet', name: 'coredns-hash', controller: true }],
  },
  spec: { nodeName: 'node-b', containers: [{ name: 'coredns' }] },
  status: { containerStatuses: [{ name: 'coredns', containerID: `containerd://${'e'.repeat(64)}` }] },
};
const invalidRolePod = {
  metadata: {
    uid: 'pod-invalid-role-uid',
    name: 'invalid-role',
    namespace: 'agents',
    labels: { 'anysentry.io/workload-role': 'ANYSENTRY_INTERNAL' },
  },
  spec: { nodeName: 'node-b', containers: [{ name: 'invalid-role' }] },
  status: { containerStatuses: [{ name: 'invalid-role', containerID: `containerd://${invalidRoleId}` }] },
};
const invalidSelectedContainerPod = {
  metadata: {
    uid: 'pod-invalid-selected-container',
    name: 'agent-with-stale-container-label',
    namespace: 'agents',
    labels: {
      'anysentry.io/workload-kind': 'agent',
      'anysentry.io/agent-id': 'stale-container-agent',
      'anysentry.io/agent-container': 'deleted-container',
    },
  },
  spec: {
    nodeName: 'node-a',
    containers: [{ name: 'agent' }, { name: 'metrics' }],
  },
  status: {
    containerStatuses: [
      { name: 'agent', containerID: `containerd://${invalidSelectedAgentId}` },
      { name: 'metrics', containerID: `containerd://${invalidSelectedSidecarId}` },
    ],
  },
};

service.replicaSetOwners.set('agents/coredns-hash', { kind: 'Deployment', name: 'coredns' });
service.podsByNamespace.set('agents', new Map([
  ['pod-agent-uid', agentPod],
  ['pod-infra-uid', infraPod],
  ['pod-labelled-infra-uid', labelledInfraPod],
  ['pod-redis-uid', redisPod],
  ['pod-api-uid', apiPod],
  ['pod-business-uid', businessPod],
  ['pod-coredns-uid', replicaSetOwnedPod],
  ['pod-invalid-role-uid', invalidRolePod],
  ['pod-invalid-selected-container', invalidSelectedContainerPod],
]));
service.podsByNamespace.set('other', new Map([['pod-other-clickhouse-uid', otherClickhousePod]]));
service.servicesByNamespace.set('default', new Map([['kubernetes-service-uid', {
  metadata: { uid: 'kubernetes-service-uid', name: 'kubernetes', namespace: 'default' },
  spec: { clusterIP: '10.43.0.1', ports: [{ port: 443 }] },
}]]));
service.readyNamespaces.add('agents');
service.serviceReadyNamespaces.add('agents');
service.rebuild();

const serviceInventory = service.serviceInventory();
assert.equal(serviceInventory.schemaVersion, 'anysentry.service_inventory.v1');
const clickhouseService = serviceInventory.items.find((item) => item.name === 'clickhouse' && item.namespace === 'agents');
const redisService = serviceInventory.items.find((item) => item.name === 'redis');
const apiService = serviceInventory.items.find((item) => item.name === 'anysentry');
const businessService = serviceInventory.items.find((item) => item.name === 'orders-api');
const kubernetesService = serviceInventory.items.find((item) => item.name === 'kubernetes' && item.namespace === 'default');
assert.equal(clickhouseService?.kind, 'database');
assert.equal(clickhouseService?.role, 'anysentry_internal');
assert.deepEqual(clickhouseService?.replicas, { observed: 1, ready: 1 });
assert(clickhouseService?.metrics.some((metric) => metric.category === 'availability'));
assert(clickhouseService?.metrics.some((metric) => metric.category === 'capacity'));
assert.equal(redisService?.kind, 'database');
assert.equal(redisService?.role, 'anysentry_internal');
assert.equal(redisService?.restarts, 1);
assert.equal(apiService?.kind, 'service');
assert.equal(businessService?.role, 'business_service', 'stable Kubernetes services become business context without Agent labels');
assert.equal(kubernetesService?.role, 'platform_infrastructure', 'the default Kubernetes API Service remains control-plane context');
assert.equal(
  serviceInventory.dependencies.filter((edge) => edge.sourceServiceAssetId === apiService?.serviceAssetId).length,
  2,
  'same-namespace endpoint resolution establishes AnySentry API dependencies despite duplicate service names',
);
assert.equal(
  serviceInventory.dependencies.some((edge) =>
    edge.sourceServiceAssetId === clickhouseService?.serviceAssetId &&
    edge.targetServiceAssetId === apiService?.serviceAssetId),
  false,
  'credential and database-name values cannot create reversed service dependencies',
);
assert.equal(service.resolveServiceEndpoint('clickhouse.agents.svc:8123', 'agents')?.serviceAssetId, clickhouseService?.serviceAssetId);
assert.equal(service.resolveServiceEndpoint('10.10.0.11')?.serviceAssetId, redisService?.serviceAssetId);
assert(serviceInventory.changes.some((change) => change.serviceAssetId === clickhouseService?.serviceAssetId));

const nodeSnapshot = service.snapshot('node-a');
assert.equal(nodeSnapshot.ready, true);
assert.equal(nodeSnapshot.nodeName, 'node-a');
assert.equal(nodeSnapshot.entries.some((entry) => entry.nodeName === 'node-b'), false);
assert.equal(nodeSnapshot.entries.find((entry) => entry.ids.includes(agentId))?.classification, 'confirmed_agent');
assert.equal(nodeSnapshot.entries.find((entry) => entry.ids.includes(agentId))?.workloadRole, 'agent',
  'an explicit Agent label defaults to Agent role even when its image belongs to AnySentry');
assert.equal(nodeSnapshot.entries.find((entry) => entry.ids.includes(sidecarId))?.classification, 'non_agent');
assert.equal(nodeSnapshot.entries.find((entry) => entry.ids.includes(agentId))?.agentScopeId, 'claw-agent');
assert.equal(
  nodeSnapshot.entries.find((entry) => entry.ids.includes(agentId))?.agentInstanceId,
  `pod-agent-uid/${agentId}`,
  'an actual container ID keeps its resolved Agent runtime identity in a multi-container Pod',
);
assert.equal(nodeSnapshot.entries.find((entry) => entry.ids.includes(agentId))?.containerImage, 'company/claw:v1');
assert.equal(nodeSnapshot.entries.find((entry) => entry.ids.includes(agentId))?.ownerName, 'claw-agent');
assert.deepEqual(
  nodeSnapshot.entries.find((entry) => entry.ids.includes(agentId))?.platformHealthchecks,
  [
    { activitySubtype: 'k8s_liveness_probe', argv: ['/usr/bin/test', '-f', '/tmp/agent-ready'] },
    { activitySubtype: 'k8s_readiness_probe', argv: ['/usr/bin/test', '-f', '/tmp/agent-ready'] },
    { activitySubtype: 'k8s_startup_probe', argv: ['/usr/bin/test', '-f', '/tmp/agent-started'] },
  ],
);
assert.equal(
  nodeSnapshot.entries.find((entry) => entry.ids.includes(sidecarId))?.platformHealthchecks,
  undefined,
  'HTTP/TCP probes do not create container ToolExec metadata',
);
assert.equal(
  service.snapshot('node-b').entries.find((entry) => entry.podUid === 'pod-coredns-uid')?.ownerName,
  'coredns',
  'ReplicaSet ownership is resolved to the stable Deployment owner',
);
assert.equal(
  nodeSnapshot.entries.find((entry) => entry.ids.includes('pod-agent-uid'))?.platformHealthchecks,
  undefined,
  'container probes are never attached to a Pod-wide identity',
);
const multiContainerPodEntry = nodeSnapshot.entries.find((entry) => entry.ids.includes('pod-agent-uid'));
assert.equal(
  multiContainerPodEntry?.classification,
  'probable_agent',
  'a Pod-wide identity cannot confirm one container inside a multi-container Agent Pod',
);
assert.equal(multiContainerPodEntry?.containerName, undefined, 'multi-container Pod fallback stays unresolved');
assert.equal(multiContainerPodEntry?.containerImage, undefined, 'multi-container Pod fallback does not guess an image');
assert.equal(multiContainerPodEntry?.agentInstanceId, 'pod-agent-uid/pod');
const singleContainerPodEntry = service
  .snapshot('node-b')
  .entries.find((entry) => entry.ids.includes('pod-infra-uid'));
assert.equal(
  singleContainerPodEntry?.classification,
  'unknown',
  'an unlabelled Pod remains discoverable instead of becoming positive non-Agent evidence',
);
assert.equal(singleContainerPodEntry?.containerName, 'database', 'a unique Pod container is a safe name fallback');
assert.equal(singleContainerPodEntry?.containerImage, 'company/database:v1', 'a unique Pod container is a safe image fallback');
const selfContainerEntry = service
  .snapshot('node-b')
  .entries.find((entry) => entry.ids.includes(labelledInfraId));
assert.equal(
  selfContainerEntry?.classification,
  'non_agent',
  'the deployed io.anysentry.observe=false compatibility label is authoritative infrastructure evidence',
);
assert.equal(
  selfContainerEntry?.workloadRole,
  'anysentry_internal',
  'the exact workload-role inventory label is carried into the identity snapshot',
);
assert.ok(
  selfContainerEntry?.evidence.includes('label:anysentry.io/workload-role=anysentry_internal'),
  'the explicit inventory role remains auditable independently from Agent classification',
);
assert.equal(
  service.snapshot('node-b').entries.find((entry) => entry.ids.includes(invalidRoleId))?.workloadRole,
  undefined,
  'workload roles require an exact inventory label value and are not normalized from guesses',
);
const invalidSelectedSnapshot = service.snapshot('node-a').entries;
assert.equal(
  invalidSelectedSnapshot.find((entry) => entry.ids.includes('pod-invalid-selected-container'))?.classification,
  'probable_agent',
  'a stale explicit container label retains only the Pod-level probable Agent fact',
);
for (const id of [invalidSelectedAgentId, invalidSelectedSidecarId]) {
  const entry = invalidSelectedSnapshot.find((candidate) => candidate.ids.includes(id));
  assert.equal(entry?.classification, 'unknown', 'a stale container selector cannot demote a real container');
  assert.equal(entry?.agentScopeId, undefined, 'an ambiguous container cannot inherit the Agent scope');
  assert.ok(entry?.evidence.includes('container:ambiguous'));
}

const enriched = service.enrich({
  workspacePath: 'agent://pod-agent-uid',
  agentId: 'pod-agent-uid',
  sessionId: agentId.slice(0, 12),
  userId: 'uid:1000',
});
assert.equal(enriched.agentId, 'claw-agent');
assert.equal(enriched.attribution?.classification, 'confirmed_agent');
assert.equal(enriched.attribution?.source, 'kubernetes');
assert.deepEqual(enriched.attribution?.workloadRef, {
  environment: 'kubernetes',
  kind: 'container',
  name: 'claw-agent-7',
  namespace: 'agents',
  podName: 'claw-agent-7',
  podUid: 'pod-agent-uid',
  nodeName: 'node-a',
  containerName: 'agent',
  containerImage: 'company/claw:v1',
  ownerKind: 'Deployment',
  ownerName: 'claw-agent',
});

const semantic = service.enrichAuthenticatedAgentSemantic({
  workspacePath: '/source-bound/workspace',
  agentId: 'claw-agent',
  sessionId: 'producer-session',
  userId: 'uid:1000',
  process: { cgroup: `0::/kubepods/${agentId}` },
}, ['claw-agent']);
assert.equal(semantic.inventoryObserved, true);
assert.equal(semantic.meta.workspacePath, '/source-bound/workspace', 'inventory merge preserves the Source-bound workspace');
assert.equal(semantic.meta.agentId, 'claw-agent', 'inventory merge does not rewrite the legacy Agent ID');
assert.equal(semantic.meta.attribution?.agentInstanceId, `pod-agent-uid/${agentId}`);
assert.equal(semantic.meta.attribution?.physicalWorkloadId, `k8s:test-cluster:pod-agent-uid:${agentId}`);
assert.deepEqual(semantic.meta.classificationSemantics, {
  schemaVersion: 'anysentry.classification_semantics.v1',
  identityClassification: 'confirmed_agent',
  workloadRole: 'agent',
  captureProfile: 'agent_full',
});
const semanticWithoutContainerClaim = service.enrichAuthenticatedAgentSemantic({
  workspacePath: '/source-bound/workspace',
  agentId: 'claw-agent',
  sessionId: 'producer-session',
  userId: 'uid:1000',
}, ['claw-agent']);
assert.equal(semanticWithoutContainerClaim.inventoryObserved, true,
  'one exact container wins over its same-Pod fallback instead of creating a false ambiguity');
assert.equal(semanticWithoutContainerClaim.meta.attribution?.agentInstanceId, `pod-agent-uid/${agentId}`);
assert.equal(
  service.enrichAuthenticatedAgentSemantic({
    workspacePath: '/source-bound/workspace',
    agentId: 'claw-agent',
    sessionId: 'producer-session',
    userId: 'uid:1000',
  }, ['different-agent']).reason,
  'agent_scope_not_bound',
  'an explicit Source Agent binding cannot be bypassed by a producer claim',
);
assert.equal(
  service.enrichAuthenticatedAgentSemantic({
    workspacePath: '/source-bound/workspace',
    agentId: 'claw-agent',
    sessionId: 'producer-session',
    userId: 'uid:1000',
    process: { cgroup: `0::/kubepods/${sidecarId}` },
  }, ['claw-agent']).reason,
  'physical_scope_conflict',
  'an exact non-Agent container identity blocks a semantic Agent merge',
);

const sidecar = service.enrich({
  workspacePath: 'agent://pod-agent-uid',
  agentId: 'pod-agent-uid',
  sessionId: sidecarId.slice(0, 12),
  userId: 'uid:1000',
});
assert.equal(sidecar.agentId, 'pod-agent-uid');
assert.equal(sidecar.attribution?.classification, 'non_agent');
assert.equal(sidecar.attribution?.monitored, false);

const infrastructure = service.enrich({
  workspacePath: 'agent://pod-infra-uid',
  agentId: 'cri-containerd-infrastructure.scope',
  sessionId: infraId.slice(0, 12),
  userId: 'uid:1000',
});
assert.equal(infrastructure.agentId, 'cri-containerd-infrastructure.scope');
assert.equal(infrastructure.attribution?.classification, 'unknown');
assert.equal(infrastructure.attribution?.workloadRef?.namespace, 'agents');
assert.equal(infrastructure.attribution?.workloadRef?.podName, 'database');
assert.equal(infrastructure.attribution?.workloadRef?.containerName, 'database');

service.podsByNamespace.set('agents', new Map());
service.podsByNamespace.set('other', new Map());
service.rebuild();
assert.equal(service.snapshot().entries.length, 0, 'an authoritative empty list clears active identities');

const kubeconfigDirectory = mkdtempSync(join(tmpdir(), 'anysentry-kubeconfig-'));
const kubeconfigPath = join(kubeconfigDirectory, 'config');
try {
  writeFileSync(kubeconfigPath, `
apiVersion: v1
kind: Config
current-context: local-test
clusters:
  - name: local
    cluster:
      server: https://127.0.0.1:6443
      certificate-authority-data: ${Buffer.from('test-ca').toString('base64')}
contexts:
  - name: local-test
    context:
      cluster: local
      user: local-user
users:
  - name: local-user
    user:
      client-certificate-data: ${Buffer.from('test-cert').toString('base64')}
      client-key-data: ${Buffer.from('test-key').toString('base64')}
`, 'utf8');
  delete process.env.KUBERNETES_SERVICE_HOST;
  delete process.env.ANYSENTRY_AGENT_NAMESPACES;
  process.env.ANYSENTRY_KUBECONFIG = kubeconfigPath;
  process.env.ANYSENTRY_KUBE_SERVER = 'https://192.0.2.10:6443';
  const localService = new KubeIdentityService();
  const localConnection = localService.loadConnection();
  assert.equal(localService.enabled, true, 'an out-of-cluster kubeconfig enables identity enrichment');
  assert.deepEqual(localService.agentNs, ['*'], 'identity discovery covers every namespace by default');
  assert.equal(localConnection.server.toString(), 'https://192.0.2.10:6443/');
  assert.equal(localConnection.ca.toString(), 'test-ca');
  assert.equal(localConnection.cert.toString(), 'test-cert');
  assert.equal(localConnection.key.toString(), 'test-key');
} finally {
  delete process.env.ANYSENTRY_KUBECONFIG;
  delete process.env.ANYSENTRY_KUBE_SERVER;
  rmSync(kubeconfigDirectory, { recursive: true, force: true });
}

console.log('Kubernetes identity registry verification passed.');
