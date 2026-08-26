#!/usr/bin/env node

import assert from 'node:assert/strict';
import { managementAuthHeaders, safeProbeId } from './probe-id.mjs';

const baseUrl = (
  process.env.ANYSENTRY_API_BASE ?? process.env.API_BASE ??
  `http://127.0.0.1:${process.env.PORT ?? '29653'}/security-center`
).replace(/\/$/u, '');
const runId = safeProbeId('s8-learning-api');

async function rawRequest(path, method = 'GET', body, headers = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...managementAuthHeaders(), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  let payload;
  try { payload = raw ? JSON.parse(raw) : undefined; } catch { payload = raw; }
  return { response, payload: payload?.data ?? payload, raw };
}

async function request(path, method = 'GET', body, headers = {}) {
  const result = await rawRequest(path, method, body, headers);
  if (!result.response.ok) throw new Error(`${method} ${path} -> ${result.response.status}: ${result.raw}`);
  return result.payload;
}

const collectorId = `${runId}-collector`;
const source = await request('/sources', 'POST', {
  name: `${runId} Observer`, type: 'observer', enabled: true, requireToken: true, collectorId,
  owner: 'verify-s8-unknown-learning-api', tags: [runId, 'unknown-learning'],
});
assert(source.source?.sourceId && source.token);
const sourceHeaders = {
  'x-anysentry-source-id': source.source.sourceId,
  'x-anysentry-ingest-token': source.token,
};

const hostId = `${runId}-host`;
const bootId = `${runId}-boot`;
const physicalWorkloadId = `${runId}-workload`;
const processContext = {
  hostId, bootId, pid: 81_001, ppid: 1, startTimeTicks: '910001',
  comm: 'custom-runtime', exe: '/usr/local/bin/custom-runtime', cwd: `/workspace/${runId}`,
  cgroup: `/docker/${'9'.repeat(64)}`, cgroupId: `${runId}-cgroup`,
};

async function ingestUnknown(index) {
  const line = JSON.stringify({
    identity: { agent: 'unknown', session: `${runId}-session`, task: processContext.pid },
    process: processContext,
    event: { FileAccess: { pid: processContext.pid, uid: 1000, cwd: processContext.cwd, path: `${processContext.cwd}/src/index.ts`, flags: 1 } },
  });
  return request('/ingest', 'POST', {
    line,
    sourceEventId: `${runId}-unknown-${index}`,
    collectorId,
    sourceType: 'observer',
    workspacePath: processContext.cwd,
    process: processContext,
    classificationSemantics: {
      schemaVersion: 'anysentry.classification_semantics.v1',
      identityClassification: 'unknown', workloadRole: 'unknown', captureProfile: 'unknown_discovery',
      unknownReason: 'signature_miss',
    },
    attribution: {
      monitored: false, classification: 'unknown', physicalWorkloadId,
      workloadRef: { environment: 'docker', kind: 'container', name: 'unknown-runtime', containerName: 'unknown-runtime' },
      confidence: 0, reason: 'not_evaluated', source: 'none', evidence: ['signature:miss'],
    },
  }, sourceHeaders);
}

for (let index = 0; index < 5; index += 1) {
  const result = await ingestUnknown(index);
  assert(result.accepted && result.eventId);
}

const status = await request('/unknown-learning/status');
assert.equal(status.enabled, true);
assert.equal(status.activeFamilies, 1);
const families = await request('/unknown-learning/families', 'POST', { limit: 20 });
assert.equal(families.items.length, 1);
const family = families.items[0];
assert.equal(family.exactCount, 5);
assert.equal(family.countScope, 'retained_events');
assert(family.clusters.every((cluster) => cluster.countScope === 'retained_events'));
assert.equal(family.unknownReason, 'signature_miss');
assert.equal(family.review, 'unreviewed');

const review = await request(`/unknown-learning/families/${encodeURIComponent(family.familyId)}/review`, 'PUT', {
  decision: 'non_agent', expectedRevision: 0, reason: 'verified business runtime',
});
assert.equal(review.decision, 'non_agent');
assert.equal(review.revision, 1);

const unsafe = await rawRequest('/unknown-learning/policies', 'POST', {
  familyId: family.familyId, desiredAction: 'drop', reason: 'must be rejected',
});
assert.equal(unsafe.response.status, 400, 'learning workflow cannot create DROP');

let policy = await request('/unknown-learning/policies', 'POST', {
  familyId: family.familyId, desiredAction: 'aggregate', reason: 'bounded service repetition',
});
assert.equal(policy.stage, 'candidate');
assert.equal(policy.evidence.countScope, 'retained_events');
const bridgeWorkload = {
  placement: 'docker',
  nodeId: hostId,
  composeProject: runId,
  serviceName: 'unknown-runtime',
  containerName: 'unknown-runtime',
  imageDigest: `sha256:${'a'.repeat(64)}`,
  labels: { 'anysentry.test/runtime': runId },
  physicalWorkloadId,
  classification: 'non_agent',
};
const bridgeBody = () => ({
  expectedPolicyRevision: policy.revision,
  expectedReviewRevision: review.revision,
  reason: 'explicitly bridge the canary-validated workload into Infrastructure review',
  workload: bridgeWorkload,
  priority: 120,
  // DROP is only a latent operator intent here. The bridge must still return candidate/draft and
  // remain absent from the policy snapshot until the independent Infrastructure workflow runs.
  eventPolicies: { default: 'sample', FileAccess: 'drop' },
  changeTicket: `${runId}-change`,
});
const prematureBridge = await rawRequest(
  `/unknown-learning/policies/${policy.policyId}/infrastructure-draft`,
  'POST',
  bridgeBody(),
  { 'x-anysentry-actor': `${runId}-bridge-operator` },
);
assert.equal(prematureBridge.response.status, 400, 'candidate recommendation cannot bridge into Infrastructure');
policy = await request(`/unknown-learning/policies/${policy.policyId}`, 'PUT', {
  expectedRevision: policy.revision, to: 'shadow', reason: 'measure before changing capture',
});
policy = await request(`/unknown-learning/policies/${policy.policyId}`, 'PUT', {
  expectedRevision: policy.revision, to: 'replay_validated', reason: 'bounded historical replay',
  replayEvents: 5, replayAgentConflicts: 0,
});
policy = await request(`/unknown-learning/policies/${policy.policyId}`, 'PUT', {
  expectedRevision: policy.revision, to: 'canary', reason: 'one workload canary',
  canaryScope: { kind: 'physical_workload', value: physicalWorkloadId },
});
policy = await request(`/unknown-learning/policies/${policy.policyId}`, 'PUT', {
  expectedRevision: policy.revision, to: 'enforced', reason: 'canary retained all Agent and Critical evidence',
  canaryEvents: 100, canaryAgentRecall: 1, canaryCriticalDrops: 0,
});
assert.equal(policy.stage, 'enforced');
const policies = await request('/unknown-learning/policies/list', 'POST', { limit: 20 });
assert.equal(policies.recommendations.length, 1);
assert.equal(policies.recommendations[0].authority, 'recommendation_only');
assert.equal(policies.recommendations[0].authoritativeDrop, false);
assert.equal(policies.recommendations[0].action, 'aggregate');

const mismatchedScope = await rawRequest(
  `/unknown-learning/policies/${policy.policyId}/infrastructure-draft`,
  'POST',
  { ...bridgeBody(), workload: { ...bridgeWorkload, physicalWorkloadId: `${physicalWorkloadId}-other` } },
  { 'x-anysentry-actor': `${runId}-bridge-operator` },
);
assert.equal(mismatchedScope.response.status, 400, 'bridge rejects a workload outside the reviewed family scope');
const agentScope = await rawRequest(
  `/unknown-learning/policies/${policy.policyId}/infrastructure-draft`,
  'POST',
  { ...bridgeBody(), workload: { ...bridgeWorkload, classification: 'confirmed_agent' } },
  { 'x-anysentry-actor': `${runId}-bridge-operator` },
);
assert.equal(agentScope.response.status, 400, 'bridge rejects inventory that currently identifies an Agent');

const bridge = await request(
  `/unknown-learning/policies/${policy.policyId}/infrastructure-draft`,
  'POST',
  bridgeBody(),
  { 'x-anysentry-actor': `${runId}-bridge-operator`, 'x-anysentry-actor-type': 'operator' },
);
assert.equal(bridge.created, true);
assert.equal(bridge.bridge.operationDestructive, false);
assert.equal(bridge.rule.lifecycleStage, 'draft');
assert.equal(bridge.rule.authority, 'candidate');
assert.equal(bridge.rule.source.type, 'manual_review');
assert.match(bridge.rule.source.sourceRef, new RegExp(`^unknown-learning:${policy.policyId}:r${policy.revision}:scope:`));
assert.equal(bridge.rule.eventPolicies.default, 'sample');
assert.equal(bridge.rule.eventPolicies.FileAccess, 'drop');

const draftPolicySnapshot = await request('/infrastructure-rules/policy');
assert(!draftPolicySnapshot.rules.some((rule) => rule.ruleId === bridge.rule.ruleId), 'draft is not executable policy');

const reused = await request(
  `/unknown-learning/policies/${policy.policyId}/infrastructure-draft`,
  'POST',
  bridgeBody(),
  { 'x-anysentry-actor': `${runId}-bridge-operator` },
);
assert.equal(reused.created, false);
assert.equal(reused.rule.ruleId, bridge.rule.ruleId, 'identical bridge is idempotent');
const conflictingIntent = await rawRequest(
  `/unknown-learning/policies/${policy.policyId}/infrastructure-draft`,
  'POST',
  { ...bridgeBody(), eventPolicies: { default: 'sample', FileAccess: 'sample' } },
  { 'x-anysentry-actor': `${runId}-bridge-operator` },
);
assert.equal(conflictingIntent.response.status, 409, 'same policy/scope cannot fork into a different draft intent');

const directPromote = await rawRequest(
  `/infrastructure-rules/${bridge.rule.ruleId}/promote`,
  'POST',
  { expectedRevision: bridge.rule.revision, reason: 'must pass shadow and validation first' },
  { 'x-anysentry-actor': `${runId}-bridge-approver` },
);
assert.equal(directPromote.response.status, 400, 'bridge cannot bypass Infrastructure shadow validation');
const shadowRule = await request(
  `/infrastructure-rules/${bridge.rule.ruleId}/shadow`,
  'POST',
  { expectedRevision: bridge.rule.revision, reason: 'begin independent Infrastructure shadow' },
  { 'x-anysentry-actor': `${runId}-bridge-operator` },
);
assert.equal(shadowRule.lifecycleStage, 'shadow');
assert.equal(shadowRule.authority, 'candidate');
const validation = await request(
  `/infrastructure-rules/${bridge.rule.ruleId}/validate`,
  'POST',
  { inventory: [bridgeWorkload] },
  { 'x-anysentry-actor': `${runId}-bridge-validator` },
);
assert.equal(validation.valid, true);
assert.equal(validation.canPromoteToEnforced, false, 'client inventory preview is diagnostic only');
const blockedPromotion = await rawRequest(
  `/infrastructure-rules/${bridge.rule.ruleId}/promote`,
  'POST',
  { expectedRevision: shadowRule.revision, reason: 'second operator accepts validated scope' },
  { 'x-anysentry-actor': `${runId}-bridge-approver` },
);
assert([400, 503].includes(blockedPromotion.response.status), 'promotion must fail closed without a server-owned asset snapshot');
const enforcedPolicySnapshot = await request('/infrastructure-rules/policy');
assert(!enforcedPolicySnapshot.rules.some((rule) =>
  rule.ruleId === shadowRule.ruleId && rule.lifecycleStage === 'enforced'));

const disabled = await request('/unknown-learning/config', 'PUT', {
  enabled: false, reason: 'kill switch E2E',
});
assert.equal(disabled.enabled, false);
assert.equal(disabled.activePolicies, 0);
const beforeCount = (await request('/unknown-learning/families', 'POST', { limit: 20 })).items[0].exactCount;
assert((await ingestUnknown(99)).accepted);
const after = await request('/unknown-learning/families', 'POST', { limit: 20 });
assert.equal(after.items[0].exactCount, beforeCount, 'disabled learning does not mutate cluster state');
const rolledBack = (await request('/unknown-learning/policies/list', 'POST', { limit: 20 })).items[0];
assert.equal(rolledBack.stage, 'rolled_back');

const audit = await request('/audit/list', 'POST', {
  timeType: 'last_30d', resourceType: 'unknown-learning', limit: 100,
});
assert(audit.items.some((item) => item.action === 'unknown_learning.reviewed'));
assert(audit.items.some((item) => item.action === 'unknown_learning.policy_updated'));
assert(audit.items.some((item) => item.action === 'unknown_learning.infrastructure_draft_created'));
assert(audit.items.some((item) => item.action === 'unknown_learning.infrastructure_draft_reused'));
assert(audit.items.some((item) => item.action === 'unknown_learning.infrastructure_draft_rejected'));
assert(audit.items.some((item) => item.action === 'unknown_learning.config_updated'));

console.log('S8 Unknown learning API lifecycle E2E passed');
