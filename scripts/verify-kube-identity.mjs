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
    containers: [{ name: 'database' }],
  },
  status: {
    containerStatuses: [{ name: 'database', containerID: `containerd://${infraId}` }],
  },
};

service.podsByNamespace.set('agents', new Map([
  ['pod-agent-uid', agentPod],
  ['pod-infra-uid', infraPod],
]));
service.readyNamespaces.add('agents');
service.rebuild();

const nodeSnapshot = service.snapshot('node-a');
assert.equal(nodeSnapshot.ready, true);
assert.equal(nodeSnapshot.nodeName, 'node-a');
assert.equal(nodeSnapshot.entries.some((entry) => entry.nodeName === 'node-b'), false);
assert.equal(nodeSnapshot.entries.find((entry) => entry.ids.includes(agentId))?.classification, 'confirmed_agent');
assert.equal(nodeSnapshot.entries.find((entry) => entry.ids.includes(sidecarId))?.classification, 'non_agent');
assert.equal(nodeSnapshot.entries.find((entry) => entry.ids.includes(agentId))?.agentScopeId, 'claw-agent');
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
  nodeSnapshot.entries.find((entry) => entry.ids.includes('pod-agent-uid'))?.platformHealthchecks,
  undefined,
  'container probes are never attached to a Pod-wide identity',
);
assert.equal(
  service.snapshot('node-b').entries.find((entry) => entry.podUid === 'pod-infra-uid')?.classification,
  'unknown',
  'an unlabelled Pod remains discoverable instead of becoming positive non-Agent evidence',
);

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
  const localService = new KubeIdentityService();
  const localConnection = localService.loadConnection();
  assert.equal(localService.enabled, true, 'an out-of-cluster kubeconfig enables identity enrichment');
  assert.deepEqual(localService.agentNs, ['*'], 'identity discovery covers every namespace by default');
  assert.equal(localConnection.server.toString(), 'https://127.0.0.1:6443/');
  assert.equal(localConnection.ca.toString(), 'test-ca');
  assert.equal(localConnection.cert.toString(), 'test-cert');
  assert.equal(localConnection.key.toString(), 'test-key');
} finally {
  delete process.env.ANYSENTRY_KUBECONFIG;
  rmSync(kubeconfigDirectory, { recursive: true, force: true });
}

console.log('Kubernetes identity registry verification passed.');
