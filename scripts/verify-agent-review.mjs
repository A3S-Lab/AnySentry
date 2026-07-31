#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AgentMetadataService } = require('../apps/api/dist/security-monitoring/agent-metadata.service.js');

const service = new AgentMetadataService();
const containerId = 'c4c5f098f38fe7a837c572d199133a5b13a6b1f39d3d31da053b9d261d865330';
const event = {
  workspacePath: 'anysentry/clickhouse-0',
  agentId: containerId.slice(0, 12),
  sessionId: containerId.slice(0, 12),
  userId: 'system',
  process: {
    hostId: 'node-a',
    bootId: 'boot-a',
    pid: 101,
    exe: '/usr/bin/clickhouse',
    cgroup: `0::/kubepods.slice/kubepods-burstable-podpod_uid.slice/cri-containerd-${containerId}.scope`,
  },
  attribution: {
    monitored: true,
    classification: 'probable_agent',
    agentScopeId: 'discovered-clickhouse',
    agentDisplayName: `cri-containerd-${containerId}.scope`,
    agentInstanceId: `container:${containerId.slice(0, 12)}`,
    physicalWorkloadId: `container:${containerId.slice(0, 12)}`,
    workloadRef: {
      environment: 'kubernetes',
      kind: 'pod',
      namespace: 'anysentry',
      podName: 'clickhouse-0',
      podUid: 'pod-uid',
      nodeName: 'node-a',
      containerName: 'clickhouse',
      containerImage: 'clickhouse/clickhouse-server:24.8',
    },
    confidence: 0.68,
    reason: 'hint_only',
    source: 'behavior',
    evidence: ['behavior:score=9'],
  },
};

const identityKeys = service.identityKeysForEvent(event);
assert(identityKeys.includes(containerId), 'full CRI container ID is a stable review key');
assert(identityKeys.includes(containerId.slice(0, 12)), 'short CRI container ID is retained for event compatibility');

const confirmed = service.review('reviewed-clickhouse', {
  workspacePath: event.workspacePath,
  decision: 'confirmed_agent',
  currentClassification: 'probable_agent',
  agentAssetId: 'agent_reviewed_clickhouse',
  identityKeys,
  physicalWorkloadId: event.attribution.physicalWorkloadId,
  agentInstanceId: event.attribution.agentInstanceId,
  workloadRef: event.attribution.workloadRef,
  note: 'review fixture',
}, 'security-reviewer');
assert.equal(confirmed.reviewDecision, 'confirmed_agent');
assert.equal(confirmed.reviewedBy, 'security-reviewer');

const confirmedEvent = service.applyReview(event);
assert.equal(confirmedEvent.attribution?.classification, 'confirmed_agent');
assert.equal(confirmedEvent.attribution?.source, 'manual_review');
assert.equal(confirmedEvent.attribution?.reason, 'human_confirmed');
assert.equal(confirmedEvent.attribution?.monitored, true);

let snapshot = service.identitySnapshotEntries('node-a');
assert.equal(snapshot.length, 1);
assert.equal(snapshot[0].classification, 'confirmed_agent');
assert.equal(snapshot[0].attributionSource, 'manual_review');
assert(snapshot[0].ids.includes(containerId));

assert.throws(
  () => service.review('reviewed-clickhouse', {
    workspacePath: event.workspacePath,
    decision: 'non_agent',
    currentClassification: 'confirmed_agent',
    identityKeys,
  }, 'security-reviewer'),
  /cannot change Agent classification from confirmed_agent to non_agent/,
  'a confirmed Agent must return to observation before it can be excluded',
);

const deferred = service.review('reviewed-clickhouse', {
  workspacePath: event.workspacePath,
  decision: 'unknown',
  currentClassification: 'confirmed_agent',
  agentAssetId: 'agent_reviewed_clickhouse',
  identityKeys,
  physicalWorkloadId: event.attribution.physicalWorkloadId,
  agentInstanceId: event.attribution.agentInstanceId,
  workloadRef: event.attribution.workloadRef,
}, 'security-reviewer');
assert.equal(deferred.reviewDecision, 'unknown');
const deferredEvent = service.applyReview(event);
assert.equal(deferredEvent.attribution?.classification, 'unknown');
assert.equal(deferredEvent.attribution?.source, 'manual_review');
assert.equal(deferredEvent.attribution?.reason, 'human_deferred');
assert.equal(deferredEvent.attribution?.monitored, false);
snapshot = service.identitySnapshotEntries('node-a');
assert.equal(snapshot[0].classification, 'unknown');

const rejected = service.review('reviewed-clickhouse', {
  workspacePath: event.workspacePath,
  decision: 'non_agent',
  currentClassification: 'unknown',
  agentAssetId: 'agent_reviewed_clickhouse',
  identityKeys,
  physicalWorkloadId: event.attribution.physicalWorkloadId,
  agentInstanceId: event.attribution.agentInstanceId,
  workloadRef: event.attribution.workloadRef,
}, 'security-reviewer');
assert.equal(rejected.reviewDecision, 'non_agent');

const rejectedEvent = service.applyReview(event);
assert.equal(rejectedEvent.attribution?.classification, 'non_agent');
assert.equal(rejectedEvent.attribution?.source, 'manual_review');
assert.equal(rejectedEvent.attribution?.reason, 'human_rejected');
assert.equal(rejectedEvent.attribution?.monitored, false);

snapshot = service.identitySnapshotEntries('node-a');
assert.equal(snapshot[0].classification, 'non_agent');

const observedAgain = service.review('reviewed-clickhouse', {
  workspacePath: event.workspacePath,
  decision: 'unknown',
  currentClassification: 'non_agent',
  agentAssetId: 'agent_reviewed_clickhouse',
  identityKeys,
  physicalWorkloadId: event.attribution.physicalWorkloadId,
  agentInstanceId: event.attribution.agentInstanceId,
  workloadRef: event.attribution.workloadRef,
}, 'security-reviewer');
assert.equal(observedAgain.reviewDecision, 'unknown');
assert.equal(service.applyReview(event).attribution?.classification, 'unknown');

service.review('reviewed-clickhouse', {
  workspacePath: event.workspacePath,
  decision: 'non_agent',
  currentClassification: 'unknown',
  agentAssetId: 'agent_reviewed_clickhouse',
  identityKeys,
  physicalWorkloadId: event.attribution.physicalWorkloadId,
  agentInstanceId: event.attribution.agentInstanceId,
  workloadRef: event.attribution.workloadRef,
}, 'security-reviewer');

service.review('conflicting-review', {
  workspacePath: 'other/workspace',
  decision: 'confirmed_agent',
  currentClassification: 'unknown',
  identityKeys: [containerId],
}, 'second-reviewer');
assert.equal(
  service.applyReview(event).attribution?.source,
  'behavior',
  'conflicting manual records fail open instead of selecting an arbitrary decision',
);

service.review('conflicting-review', {
  workspacePath: 'other/workspace',
  decision: 'clear',
}, 'second-reviewer');
assert.equal(service.applyReview(event).attribution?.classification, 'non_agent');

service.review('reviewed-clickhouse', {
  workspacePath: event.workspacePath,
  decision: 'clear',
}, 'security-reviewer');
assert.equal(service.applyReview(event).attribution?.source, 'behavior');
assert.equal(service.identitySnapshotEntries('node-a').length, 0);

console.log('Agent human review verification passed.');
