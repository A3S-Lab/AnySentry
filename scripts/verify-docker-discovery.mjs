#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AgentTemplateRegistry } = require('./observer-agent-templates');
const { DockerDiscovery, dockerHealthchecks, dockerSnapshot } = require('./observer-docker-discovery');
const { WorkloadIdentityCache } = require('./observer-workload-filter');

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function eventually(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

const clawId = 'd'.repeat(64);
const unknownId = 'e'.repeat(64);
const infraId = 'f'.repeat(64);
const legacyInfraId = '1'.repeat(64);
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
    ImageID: `sha256:${'2'.repeat(64)}`,
    Labels: { 'anysentry.io/workload-role': 'BUSINESS_SERVICE' },
  },
  {
    Id: infraId,
    Names: ['/metrics'],
    Image: 'prom/node-exporter:latest',
    Labels: { 'anysentry.io/workload-kind': 'non-agent' },
  },
  {
    Id: legacyInfraId,
    Names: ['/clickhouse'],
    Image: 'clickhouse/clickhouse-server:24.8',
    Labels: {
      'io.anysentry.observe': 'false',
      'anysentry.io/workload-role': 'anysentry_internal',
    },
  },
];

assert.deepEqual(dockerHealthchecks({
  Config: { Healthcheck: { Test: ['CMD', '/usr/bin/test', '-f', '/tmp/ready'] } },
}), [{ activitySubtype: 'docker_healthcheck', argv: ['/usr/bin/test', '-f', '/tmp/ready'] }]);
assert.deepEqual(dockerHealthchecks({
  Config: { Healthcheck: { Test: ['CMD-SHELL', 'test -f /tmp/ready || exit 1'] } },
}), [{ activitySubtype: 'docker_healthcheck', argv: ['/bin/sh', '-c', 'test -f /tmp/ready || exit 1'] }]);
assert.deepEqual(dockerHealthchecks({
  Config: {
    Shell: ['/bin/bash', '-ec'],
    Healthcheck: { Test: ['CMD-SHELL', 'test -f /tmp/ready'] },
  },
}), [{ activitySubtype: 'docker_healthcheck', argv: ['/bin/bash', '-ec', 'test -f /tmp/ready'] }]);
assert.deepEqual(dockerHealthchecks({ Config: { Healthcheck: { Test: ['NONE'] } } }), []);

const snapshot = dockerSnapshot(containers, {
  version: 7,
  nodeName: 'node-a',
  hostId: 'host-a',
  now: () => Date.UTC(2026, 6, 30),
});
assert.equal(snapshot.ready, true);
assert.equal(snapshot.entries.length, 4);
assert.equal(snapshot.entries.find((entry) => entry.ids.includes(unknownId))?.classification, 'unknown');
assert.equal(
  snapshot.entries.find((entry) => entry.ids.includes(unknownId))?.imageDigest,
  `sha256:${'2'.repeat(64)}`,
);
assert.equal(snapshot.entries.find((entry) => entry.ids.includes(infraId))?.classification, 'non_agent');
assert.equal(snapshot.entries.find((entry) => entry.ids.includes(legacyInfraId))?.classification, 'non_agent');
assert.equal(snapshot.entries.find((entry) => entry.ids.includes(legacyInfraId))?.workloadRole, 'anysentry_internal');
assert.equal(
  snapshot.entries.find((entry) => entry.ids.includes(unknownId))?.workloadRole,
  undefined,
  'Docker role labels are exact closed-set inventory facts',
);
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

let procCgroupReads = 0;
const procCgroupPids = [];
const labeledContainerId = 'a'.repeat(64);
const labeledSnapshot = dockerSnapshot([
  {
    Id: labeledContainerId,
    Names: ['/a3s-code-agent'],
    Image: 'anysentry-agent-runtime-lab:0.1.0',
    Labels: {
      'anysentry.io/workload-kind': 'agent',
      'anysentry.io/agent-id': 'docker-a3s-code-loop',
    },
  },
], {
  version: 8,
  nodeName: 'node-a',
  hostId: 'host-a',
});
const runningLabeledSnapshot = dockerSnapshot([
  {
    Id: labeledContainerId,
    Names: ['/a3s-code-agent'],
    Image: 'anysentry-agent-runtime-lab:0.1.0',
    State: 'running',
    Labels: {
      'anysentry.io/workload-kind': 'agent',
      'anysentry.io/agent-id': 'docker-a3s-code-loop',
    },
  },
], {
  version: 9,
  nodeName: 'node-a',
  hostId: 'host-a',
  bootId: 'boot-a',
  runtimeById: new Map([[
    labeledContainerId,
    { hostPid: 42, rootStartTimeTicks: '4242', cgroupId: '987654' },
  ]]),
});
const runtimeInventoryAt = Date.UTC(2026, 7, 30, 1, 2, 3);
const runtimeInventoryCache = new WorkloadIdentityCache({ now: () => runtimeInventoryAt });
assert.equal(runtimeInventoryCache.replace(runningLabeledSnapshot, 'docker'), true);
assert.deepEqual(runtimeInventoryCache.agentRuntimeInventory(), [{
  agentScopeId: 'docker-a3s-code-loop',
  agentDisplayName: 'docker-a3s-code-loop',
  agentInstanceId: `docker:host-a:${labeledContainerId}`,
  physicalWorkloadId: `docker:host-a:${labeledContainerId}`,
  classification: 'confirmed_agent',
  runtimeState: 'running',
  rootPid: 42,
  rootStartTimeTicks: '4242',
  rootGeneration: 1,
  hostId: 'host-a',
  bootId: 'boot-a',
  discoveredAt: new Date(runtimeInventoryAt).toISOString(),
  lastSeenAt: new Date(runtimeInventoryAt).toISOString(),
  confidence: 1,
  source: 'docker',
  evidence: [
    'label:anysentry.io/workload-kind=agent',
    'label:anysentry.io/agent-id=docker-a3s-code-loop',
  ],
  workloadRef: {
    environment: 'docker',
    kind: 'container',
    name: 'a3s-code-agent',
    containerName: 'a3s-code-agent',
    containerImage: 'anysentry-agent-runtime-lab:0.1.0',
  },
}]);
const legacyCollectorCache = new WorkloadIdentityCache({
  readProcCgroup(pid) {
    procCgroupReads += 1;
    procCgroupPids.push(pid);
    return pid === 42 ? `1:net_cls:/\n0::/../docker-${labeledContainerId}.scope` : '';
  },
});
assert.equal(legacyCollectorCache.replace(labeledSnapshot, 'docker'), true);
const legacyCollectorEvent = {
  identity: { agent: 'node', task: '42' },
  process: {
    pid: 42,
    ppid: 1,
    cgroup_id: '987654',
    comm: 'node',
    exe: '/usr/local/bin/node',
  },
  event: { ToolExec: { pid: 42, argv: ['node', 'agent.mjs'] } },
};
const legacyCollectorResult = legacyCollectorCache.classify(legacyCollectorEvent);
assert.equal(legacyCollectorResult.state, 'agent');
assert.equal(legacyCollectorResult.attribution.classification, 'confirmed_agent');
assert.equal(legacyCollectorResult.attribution.agentScopeId, 'docker-a3s-code-loop');
assert.equal(procCgroupReads, 1);
assert.equal(legacyCollectorCache.classify(structuredClone(legacyCollectorEvent)).state, 'agent');
assert.equal(procCgroupReads, 1, 'numeric cgroup bindings must avoid repeated /proc reads');
assert.equal(legacyCollectorCache.metrics().procCgroupReads, 1);

const exitedChildResult = legacyCollectorCache.classify({
  identity: { agent: 'bash', task: '43' },
  process: {
    pid: 43,
    ppid: 42,
    cgroup_id: '987655',
    comm: 'bash',
    exe: '/usr/bin/bash',
  },
  event: { ToolExec: { pid: 43, ppid: 42, argv: ['bash', '-c', 'true'] } },
});
assert.equal(exitedChildResult.state, 'agent');
assert.equal(exitedChildResult.attribution.agentScopeId, 'docker-a3s-code-loop');
assert.deepEqual(procCgroupPids, [42, 43, 42]);
assert.equal(
  legacyCollectorCache.metrics().procCgroupReads,
  3,
  'an exited child must fall back to its still-live parent cgroup',
);

let callbackSnapshot;
const inspectRequests = new Map();
const discovery = new DockerDiscovery({
  enabled: 'on',
  socketExists: () => true,
  nodeName: 'node-a',
  hostId: 'host-a',
  requestJson: async (requestPath) => {
    if (requestPath === '/containers/json?all=1') return containers;
    const id = requestPath.split('/')[2];
    inspectRequests.set(id, (inspectRequests.get(id) ?? 0) + 1);
    return id === unknownId
      ? { Config: { Healthcheck: { Test: ['CMD-SHELL', 'test -f /tmp/agent-ready || exit 1'] } } }
      : { Config: {} };
  },
  streamFactory: () => ({ destroy() {} }),
  refreshMs: 3_600_000,
});
assert.equal(await discovery.start((value) => {
  callbackSnapshot = value;
}), true);
assert.equal(callbackSnapshot.entries.length, 4);
assert.equal(discovery.metrics().ready, true);
assert.equal(discovery.metrics().version, 1);
assert.equal(discovery.metrics().inspected, containers.length);
assert.equal(discovery.metrics().healthchecks, 1);
assert.deepEqual(
  callbackSnapshot.entries.find((entry) => entry.ids.includes(unknownId))?.platformHealthchecks,
  [{ activitySubtype: 'docker_healthcheck', argv: ['/bin/sh', '-c', 'test -f /tmp/agent-ready || exit 1'] }],
);
await discovery.refresh();
assert.ok([...inspectRequests.values()].every((count) => count === 1), 'a container ID is inspected once');
discovery.handleEvent({ Action: 'destroy', Actor: { ID: unknownId } });
assert.equal(discovery.inspectById.has(unknownId), false, 'destroy evicts cached healthcheck metadata');
discovery.stop();

let inspectAttempts = 0;
const retryingDiscovery = new DockerDiscovery({
  enabled: 'on',
  socketExists: () => true,
  requestJson: async (requestPath) => {
    if (requestPath === '/containers/json?all=1') return [containers[0]];
    inspectAttempts++;
    if (inspectAttempts === 1) throw new Error('transient inspect failure');
    return { Config: {} };
  },
  streamFactory: () => ({ destroy() {} }),
  refreshMs: 3_600_000,
});
await retryingDiscovery.start(() => {});
assert.equal(retryingDiscovery.inspectById.has(clawId), false);
await retryingDiscovery.refresh();
assert.equal(inspectAttempts, 2, 'failed inspect remains eligible for the next bounded refresh');
assert.equal(retryingDiscovery.inspectById.has(clawId), true);
retryingDiscovery.stop();

const staleList = deferred();
let listCalls = 0;
const raceSnapshots = [];
const raceDiscovery = new DockerDiscovery({
  enabled: 'on',
  socketExists: () => true,
  requestJson: async (requestPath) => {
    if (requestPath === '/containers/json?all=1') {
      listCalls++;
      if (listCalls === 1) return staleList.promise;
      throw new Error('synthetic authoritative refresh failure');
    }
    return { Config: { Healthcheck: { Test: ['CMD', '/usr/bin/true'] } } };
  },
  streamFactory: () => ({ destroy() {} }),
  refreshMs: 3_600_000,
});
raceDiscovery.onSnapshot = (value) => raceSnapshots.push(value);
const staleRefresh = raceDiscovery.refresh();
raceDiscovery.handleEvent({ Action: 'destroy', Actor: { ID: clawId } });
staleList.resolve([containers[0]]);
await staleRefresh;
await eventually(() => listCalls >= 2 && raceDiscovery.refreshInFlight === undefined,
  'destroy must schedule one fresh authoritative list after an in-flight stale list');
assert.equal(
  raceSnapshots.some((value) => value.entries.some((entry) => entry.ids.includes(clawId))),
  false,
  'an old list response must never republish a destroyed container even when the follow-up list fails',
);
assert.equal(raceDiscovery.inspectById.has(clawId), false);
assert.equal(raceDiscovery.inspectEpoch.size, 0, 'container churn metadata must remain bounded');
raceDiscovery.stop();

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
