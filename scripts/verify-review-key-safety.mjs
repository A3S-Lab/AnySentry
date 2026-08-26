#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AgentMetadataService } = require('../apps/api/dist/security-monitoring/agent-metadata.service.js');

const service = new AgentMetadataService();

function review(agentId, body, at = Date.now()) {
  return service.review(agentId, {
    workspacePath: `/workspace/${agentId}`,
    agentAssetId: `agent_${agentId.replace(/[^a-z0-9_-]/giu, '_')}`,
    currentClassification: 'unknown',
    ...body,
  }, 'review-safety-verifier', at);
}

for (const [label, identityKeys] of [
  ['bare process name', ['bash']],
  ['host logical name', ['logical:host:host-a:bash']],
  ['shared session', ['session-42.scope']],
  ['unknown process generation', ['host:host-a:boot-a:root:42:start-unknown']],
  ['short pid', ['pid:42']],
  ['short container id', ['0123456789ab']],
  ['short prefixed container id', ['container:0123456789ab']],
]) {
  assert.throws(
    () => review(`weak-${label}`, { decision: 'non_agent', identityKeys }),
    /stable review identity is required/u,
    `${label} must not create a long-lived review`,
  );
}

const containerA = 'a'.repeat(64);
const containerB = 'b'.repeat(64);
const exactContainer = review('exact-container', {
  decision: 'non_agent',
  expectedRevision: 0,
  identityKeys: [containerA, containerA.slice(0, 12), 'bash'],
});
assert.equal(exactContainer.reviewRevision, 1);
assert.deepEqual(exactContainer.reviewIdentityKeys, [containerA]);

assert.throws(
  () => service.review('exact-container', {
    workspacePath: '/workspace/exact-container',
    agentAssetId: exactContainer.agentAssetId,
    decision: 'unknown',
    expectedRevision: 0,
    identityKeys: [containerA],
  }, 'stale-reviewer'),
  /review revision conflict: expected 0, current 1/iu,
  'stale reviewers must fail compare-and-set',
);

const narrowed = service.review('exact-container', {
  workspacePath: '/workspace/exact-container',
  agentAssetId: exactContainer.agentAssetId,
  decision: 'unknown',
  expectedRevision: 1,
  identityKeys: [containerB],
}, 'review-safety-verifier', exactContainer.reviewHistory[0].effectiveAt + 10);
assert.equal(narrowed.reviewRevision, 2);
assert.deepEqual(narrowed.reviewIdentityKeys, [containerB]);
assert(!narrowed.reviewIdentityKeys.includes(containerA), 'current review scope must replace, not union, old keys');
assert.deepEqual(
  narrowed.reviewHistory.at(-1).clearedIdentityKeys,
  [containerA],
  'removed keys remain only as an explicit historical scope closure',
);

const eventFor = (containerId) => ({
  workspacePath: '/workspace/exact-container',
  agentId: 'bash',
  sessionId: 'session',
  userId: 'uid:1000',
  attribution: {
    monitored: false,
    classification: 'unknown',
    physicalWorkloadId: `container:${containerId}`,
    confidence: 0,
    reason: 'not_evaluated',
    source: 'none',
  },
});
assert.equal(
  service.applyReview(eventFor(containerA)).attribution.classification,
  'unknown',
  'a key removed from the current scope must stop receiving the active review',
);
assert.equal(
  service.applyReview(eventFor(containerB)).attribution.classification,
  'unknown',
  'the replacement key receives the explicit manual-unknown decision',
);

const pod = review('exact-pod', {
  decision: 'confirmed_agent',
  identityKeys: ['pod-uid-a', 'logical:k8s:prod:deployment:api:app:pi'],
  physicalWorkloadId: 'k8s:cluster-a:pod-uid-a:container-a',
  workloadRef: {
    environment: 'kubernetes',
    kind: 'pod',
    namespace: 'prod',
    podName: 'api-a',
    podUid: 'pod-uid-a',
    containerName: 'app',
    ownerKind: 'Deployment',
    ownerName: 'api',
  },
});
assert(pod.reviewIdentityKeys.includes('pod-uid-a'));
assert(pod.reviewIdentityKeys.some((key) => key.startsWith('logical:k8s:')));

const systemd = review('exact-systemd', {
  decision: 'non_agent',
  identityKeys: ['systemd:host-a:redis.service'],
  physicalWorkloadId: 'host:host-a:systemd:redis.service',
  workloadRef: { environment: 'host', kind: 'service', systemdUnit: 'redis.service' },
});
assert(systemd.reviewIdentityKeys.includes('systemd:host-a:redis.service'));

const process = review('exact-process', {
  decision: 'confirmed_agent',
  identityKeys: ['host:host-a:boot-a:process:4242:9001:/usr/bin/pi'],
});
assert.equal(process.reviewIdentityKeys.length, 1);

console.log('PASS Agent review key safety and revision CAS');
