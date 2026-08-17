#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  WorkloadIdentityCache,
  classifyEventActivity,
} = require('./observer-workload-filter');
const {
  eventActivityContext,
  normalizeActivitySemantics,
} = require('../apps/api/dist/security-monitoring/activity-context.js');

function toolExec(containerId, argv, extra = {}) {
  return {
    identity: { session: containerId },
    process: { pid: 42, cgroup: `0::/docker/${containerId}` },
    event: { ToolExec: { pid: 42, argv, ...extra } },
  };
}

const dockerId = 'd'.repeat(64);
const otherId = 'e'.repeat(64);
const healthArgv = ['/bin/sh', '-c', 'test -f /tmp/agent-ready || exit 1'];
const cache = new WorkloadIdentityCache();
assert.equal(cache.replace({
  schemaVersion: 'anysentry.workload_identity_snapshot.v1',
  version: 1,
  generatedAt: new Date(0).toISOString(),
  ready: true,
  errors: 0,
  entries: [
    {
      ids: [dockerId, dockerId.slice(0, 12)],
      classification: 'confirmed_agent',
      physicalWorkloadId: `docker:test:${dockerId}`,
      source: 'docker',
      environment: 'docker',
      agentScopeId: 'docker-agent',
      evidence: ['label:anysentry.io/workload-kind=agent'],
      platformHealthchecks: [{ activitySubtype: 'docker_healthcheck', argv: healthArgv }],
    },
    {
      ids: [otherId, otherId.slice(0, 12)],
      classification: 'confirmed_agent',
      physicalWorkloadId: `docker:test:${otherId}`,
      source: 'docker',
      environment: 'docker',
      agentScopeId: 'other-agent',
      evidence: ['label:anysentry.io/workload-kind=agent'],
    },
  ],
}), true);

const healthEvent = toolExec(dockerId, healthArgv);
const dockerWorkload = cache.classify(healthEvent);
assert.deepEqual(
  classifyEventActivity(healthEvent, { state: 'unknown' }, dockerWorkload),
  { activityContext: 'platform_healthcheck', activitySubtype: 'docker_healthcheck' },
);
assert.deepEqual(
  classifyEventActivity(healthEvent, { state: 'agent' }, dockerWorkload),
  { activityContext: 'agent_action' },
  'an Agent-owned copy of the declared healthcheck remains an Agent action',
);
assert.deepEqual(
  classifyEventActivity(toolExec(dockerId, ['/bin/sh', '-c', 'echo manual']), { state: 'unknown' }, dockerWorkload),
  { activityContext: 'agent_action' },
);
assert.deepEqual(
  classifyEventActivity(toolExec(dockerId, healthArgv, { argv_incomplete: true }), { state: 'unknown' }, dockerWorkload),
  { activityContext: 'agent_action' },
);
assert.deepEqual(
  classifyEventActivity(toolExec(otherId, healthArgv), { state: 'unknown' }, cache.classify(toolExec(otherId, healthArgv))),
  { activityContext: 'agent_action' },
  'the same argv in another physical container does not inherit a probe declaration',
);

const k8sId = 'a'.repeat(64);
const k8sArgv = ['/usr/bin/test', '-f', '/tmp/agent-ready'];
const reviewedCache = new WorkloadIdentityCache();
assert.equal(reviewedCache.replace({
  schemaVersion: 'anysentry.workload_identity_snapshot.v1',
  version: 1,
  generatedAt: new Date(0).toISOString(),
  ready: true,
  errors: 0,
  entries: [{
    ids: [k8sId, k8sId.slice(0, 12)],
    classification: 'confirmed_agent',
    physicalWorkloadId: `review:${k8sId}`,
    source: 'host',
    attributionSource: 'manual_review',
    evidence: ['human_confirmed'],
  }],
}, 'review'), true);
assert.equal(reviewedCache.replace({
  schemaVersion: 'anysentry.workload_identity_snapshot.v1',
  version: 2,
  generatedAt: new Date(1).toISOString(),
  ready: true,
  errors: 0,
  entries: [{
    ids: [k8sId, k8sId.slice(0, 12)],
    classification: 'confirmed_agent',
    physicalWorkloadId: `k8s:test:${k8sId}`,
    source: 'kubernetes',
    environment: 'kubernetes',
    evidence: ['container:agent'],
    platformHealthchecks: [
      { activitySubtype: 'k8s_liveness_probe', argv: k8sArgv },
      { activitySubtype: 'k8s_readiness_probe', argv: k8sArgv },
    ],
  }],
}, 'kubernetes'), true);
const k8sEvent = toolExec(k8sId, k8sArgv);
const reviewedWorkload = reviewedCache.classify(k8sEvent);
assert.equal(reviewedWorkload.attribution.source, 'manual_review');
assert.deepEqual(
  classifyEventActivity(k8sEvent, { state: 'unknown' }, reviewedWorkload),
  { activityContext: 'platform_healthcheck', activitySubtype: 'k8s_exec_probe' },
  'manual identity priority retains platform probe metadata and ambiguous Probe types stay generic',
);

const reviewLastCache = new WorkloadIdentityCache();
assert.equal(reviewLastCache.replace({
  schemaVersion: 'anysentry.workload_identity_snapshot.v1',
  version: 1,
  generatedAt: new Date(0).toISOString(),
  ready: true,
  errors: 0,
  entries: [{
    ids: [k8sId],
    classification: 'confirmed_agent',
    physicalWorkloadId: `k8s:test:${k8sId}`,
    source: 'kubernetes',
    evidence: ['container:agent'],
    platformHealthchecks: [{ activitySubtype: 'k8s_readiness_probe', argv: k8sArgv }],
  }],
}, 'platform-first'), true);
assert.equal(reviewLastCache.replace({
  schemaVersion: 'anysentry.workload_identity_snapshot.v1',
  version: 2,
  generatedAt: new Date(1).toISOString(),
  ready: true,
  errors: 0,
  entries: [{
    ids: [k8sId],
    classification: 'confirmed_agent',
    physicalWorkloadId: `review:${k8sId}`,
    source: 'host',
    attributionSource: 'manual_review',
    evidence: ['human_confirmed'],
  }],
}, 'review-later'), true);
const reviewLast = reviewLastCache.classify(k8sEvent);
assert.equal(reviewLast.attribution.source, 'manual_review');
assert.deepEqual(
  classifyEventActivity(k8sEvent, { state: 'unknown' }, reviewLast),
  { activityContext: 'platform_healthcheck', activitySubtype: 'k8s_readiness_probe' },
  'manual review wins even when its discovery source is registered after platform metadata',
);

assert.deepEqual(
  normalizeActivitySemantics('ToolExec', 'platform_healthcheck', 'docker_healthcheck'),
  {
    activityContext: 'platform_healthcheck',
    activitySubtype: 'docker_healthcheck',
    eventCategory: 'runtime',
  },
);
assert.deepEqual(
  normalizeActivitySemantics('ToolExec', 'platform_healthcheck', 'observer_heartbeat'),
  { activityContext: 'agent_action', eventCategory: 'tool' },
  'invalid platform subtype fails open to Agent command visibility',
);
assert.deepEqual(
  normalizeActivitySemantics('ToolExec', undefined, undefined),
  { activityContext: 'agent_action', eventCategory: 'tool' },
);
assert.equal(eventActivityContext({ eventKind: 'ToolExec' }), 'agent_action');
assert.equal(
  eventActivityContext({ eventKind: 'ToolExec', activityContext: 'platform_healthcheck' }),
  'agent_action',
  'an incomplete platform pair fails open to command visibility',
);
assert.equal(eventActivityContext({ eventKind: 'Egress' }), undefined);
assert.equal(
  eventActivityContext({ eventKind: 'Egress', activityContext: 'platform_healthcheck' }),
  undefined,
  'dirty non-ToolExec context cannot hide another event kind from topology or runtime views',
);

console.log('Activity context verification passed.');
