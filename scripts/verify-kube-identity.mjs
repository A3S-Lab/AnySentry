#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

process.env.KUBERNETES_SERVICE_HOST = 'kubernetes.test';
process.env.ANYSENTRY_AGENT_NAMESPACES = 'agents';
process.env.ANYSENTRY_AGENT_LABEL_SELECTOR = 'anysentry.io/workload-kind=agent';
process.env.ANYSENTRY_CLUSTER_ID = 'test-cluster';

const require = createRequire(import.meta.url);
const { KubeIdentityService } = require('../apps/api/dist/security-monitoring/kube-identity.service.js');

const service = new KubeIdentityService();
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
  },
  spec: {
    nodeName: 'node-a',
    containers: [{ name: 'agent' }, { name: 'metrics' }],
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

const enriched = service.enrich({
  workspacePath: 'agent://pod-agent-uid',
  agentId: 'pod-agent-uid',
  sessionId: agentId.slice(0, 12),
  userId: 'uid:1000',
});
assert.equal(enriched.agentId, 'claw-agent');
assert.equal(enriched.attribution?.classification, 'confirmed_agent');
assert.equal(enriched.attribution?.source, 'kubernetes');

const sidecar = service.enrich({
  workspacePath: 'agent://pod-agent-uid',
  agentId: 'pod-agent-uid',
  sessionId: sidecarId.slice(0, 12),
  userId: 'uid:1000',
});
assert.equal(sidecar.agentId, 'pod-agent-uid');
assert.equal(sidecar.attribution?.classification, 'non_agent');
assert.equal(sidecar.attribution?.monitored, false);

service.podsByNamespace.set('agents', new Map());
service.rebuild();
assert.equal(service.snapshot().entries.length, 0, 'an authoritative empty list clears active identities');

console.log('Kubernetes identity registry verification passed.');
