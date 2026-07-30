#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AgentTemplateRegistry } = require('./observer-agent-templates');
const { DockerDiscovery, dockerSnapshot } = require('./observer-docker-discovery');
const { WorkloadIdentityCache } = require('./observer-workload-filter');

const clawId = 'd'.repeat(64);
const unknownId = 'e'.repeat(64);
const infraId = 'f'.repeat(64);
const containers = [
  {
    Id: clawId,
    Names: ['/production-claw-worker'],
    Image: 'company/claw:latest',
    Labels: {},
  },
  {
    Id: unknownId,
    Names: ['/new-runtime'],
    Image: 'company/new-runtime:v1',
    Labels: {},
  },
  {
    Id: infraId,
    Names: ['/metrics'],
    Image: 'prom/node-exporter:latest',
    Labels: { 'anysentry.io/workload-kind': 'non-agent' },
  },
];

const snapshot = dockerSnapshot(containers, {
  version: 7,
  nodeName: 'node-a',
  hostId: 'host-a',
  now: () => Date.UTC(2026, 6, 30),
});
assert.equal(snapshot.ready, true);
assert.equal(snapshot.entries.length, 3);
assert.equal(snapshot.entries.find((entry) => entry.ids.includes(unknownId))?.classification, 'unknown');
assert.equal(snapshot.entries.find((entry) => entry.ids.includes(infraId))?.classification, 'non_agent');
assert.equal(
  snapshot.entries.find((entry) => entry.ids.includes(clawId))?.physicalWorkloadId,
  `docker:host-a:${clawId}`,
);

const templates = new AgentTemplateRegistry({
  templates: [
    { id: 'claw', agentId: 'claw', deployment: 'docker', name: 'claw' },
  ],
});
const cache = new WorkloadIdentityCache({ templateRegistry: templates });
assert.equal(cache.replace(snapshot, 'docker'), true);
const claw = cache.classify({
  identity: { session: clawId },
  process: { cgroup: `0::/docker/${clawId}` },
  event: { ToolExec: { pid: 2, argv: ['node', 'agent.js'] } },
});
assert.equal(claw.state, 'agent');
assert.equal(claw.attribution.classification, 'confirmed_agent');
assert.equal(claw.attribution.agentScopeId, 'claw');
assert.equal(claw.attribution.source, 'self_register');
assert.equal(claw.attribution.physicalWorkloadId, `docker:host-a:${clawId}`);
assert.deepEqual(claw.attribution.workloadRef, {
  environment: 'docker',
  kind: 'container',
  name: 'production-claw-worker',
  nodeName: 'node-a',
  containerName: 'production-claw-worker',
  containerImage: 'company/claw:latest',
});

const unknown = cache.classify({
  identity: { session: unknownId },
  process: { cgroup: `0::/docker/${unknownId}` },
  event: { ToolExec: { pid: 3, argv: ['python', 'main.py'] } },
});
assert.equal(unknown.state, 'unknown');
assert.equal(unknown.attribution.source, 'docker');
assert.equal(unknown.attribution.workloadRef.containerName, 'new-runtime');
assert.equal(unknown.attribution.workloadRef.environment, 'docker');

let callbackSnapshot;
const discovery = new DockerDiscovery({
  enabled: 'on',
  socketExists: () => true,
  nodeName: 'node-a',
  hostId: 'host-a',
  requestJson: async () => containers,
  streamFactory: () => ({ destroy() {} }),
  refreshMs: 3_600_000,
});
assert.equal(await discovery.start((value) => {
  callbackSnapshot = value;
}), true);
assert.equal(callbackSnapshot.entries.length, 3);
assert.equal(discovery.metrics().ready, true);
assert.equal(discovery.metrics().version, 1);
discovery.stop();

if (process.argv.includes('--real')) {
  const real = new DockerDiscovery();
  assert.equal(real.enabled, true, 'real Docker socket is not available');
  let realSnapshot;
  await real.start((value) => {
    realSnapshot = value;
  });
  assert.equal(realSnapshot.ready, true);
  assert.ok(realSnapshot.entries.length > 0, 'real Docker host has no discoverable containers');
  assert.ok(realSnapshot.entries.every((entry) => entry.source === 'docker'));
  real.stop();
  console.log(`Real Docker discovery observed ${realSnapshot.entries.length} containers`);
}

console.log('Docker discovery verification passed');
