#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  CAPTURE_PROFILE_ACK_SCHEMA,
  CAPTURE_PROFILE_CAPABILITIES,
  FilterRulePublisher,
  PROFILE_PROBE_ACTIONS,
  PROBE_NAMES,
  digest,
} = require('./observer-filter-rules.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anysentry-s5-safety-'));
const baseNow = Date.parse('2026-08-20T08:00:00.000Z');
let now = baseNow;
let sequence = 0;

const allFull = Object.fromEntries(PROBE_NAMES.map((probe) => [probe, 'full']));
const expectedProfiles = {
  agent_full: allFull,
  investigation_full: allFull,
  probable_investigation: {
    exec: 'full', exit: 'full', tls: 'sample', connect: 'sample', dns: 'sample',
    file_access: 'sample', file_delete: 'sample', llm: 'full', ssl: 'sample', security: 'full', file_read: 'full',
  },
  security_full: {
    exec: 'full', exit: 'full', tls: 'sample', connect: 'full', dns: 'sample',
    file_access: 'sample', file_delete: 'full', llm: 'full', ssl: 'sample', security: 'full', file_read: 'not_enabled',
  },
  unknown_discovery: {
    exec: 'full', exit: 'full', tls: 'sample', connect: 'sample', dns: 'sample',
    file_access: 'sample', file_delete: 'sample', llm: 'full', ssl: 'sample', security: 'full', file_read: 'not_enabled',
  },
  business_context: {
    exec: 'full', exit: 'full', tls: 'aggregate', connect: 'aggregate', dns: 'aggregate',
    file_access: 'aggregate', file_delete: 'sample', llm: 'aggregate', ssl: 'aggregate', security: 'full', file_read: 'not_enabled',
  },
  infrastructure_aggregate: {
    exec: 'full', exit: 'full', tls: 'aggregate', connect: 'aggregate', dns: 'aggregate',
    file_access: 'aggregate', file_delete: 'sample', llm: 'aggregate', ssl: 'aggregate', security: 'full', file_read: 'not_enabled',
  },
  self_health: {
    exec: 'full', exit: 'full', tls: 'aggregate', connect: 'aggregate', dns: 'aggregate',
    file_access: 'aggregate', file_delete: 'sample', llm: 'aggregate', ssl: 'aggregate', security: 'full', file_read: 'not_enabled',
  },
};
assert.deepEqual(Object.fromEntries(Object.entries(PROFILE_PROBE_ACTIONS)), expectedProfiles);

function locations(label) {
  const stem = path.join(root, `${++sequence}-${label}`);
  return { file: `${stem}.json`, ackFile: `${stem}.ack.json` };
}

function decision(cgroupId = '101', overrides = {}) {
  return {
    scopeType: 'cgroup',
    scopeKey: `cgroup:${cgroupId}`,
    cgroupId,
    classification: 'non_agent',
    authority: 'authoritative',
    action: 'drop',
    policyAction: 'drop',
    reasonCode: 'verified_infrastructure',
    source: 'platform_inventory',
    physicalWorkloadId: `docker:node-safety:service-${cgroupId}`,
    ruleId: `rule-${cgroupId}`,
    ruleRevision: 9,
    materializationId: `materialization-${cgroupId}`,
    policyVersion: 12,
    captureProfile: 'infrastructure_aggregate',
    desiredProbeActions: {
      ...expectedProfiles.infrastructure_aggregate,
      file_access: 'drop',
    },
    expiresAt: new Date(baseNow + 10 * 60_000).toISOString(),
    ...overrides,
  };
}

function createPublisher(label, options = {}) {
  const files = locations(label);
  const instance = new FilterRulePublisher({
    ...files,
    captureProfileMode: 'enforce',
    publisherInstanceId: `publisher-${label}`,
    nodeId: 'node-safety',
    collectorId: 'collector-safety',
    hostBootId: 'boot-safety',
    now: () => now,
    ttlMs: 120_000,
    ackMaxAgeMs: 120_000,
    flushIntervalMs: 5_000,
    ...options,
  });
  return { files, instance };
}

function publish(label, entry = decision(), options = {}) {
  const created = createPublisher(label, options);
  created.instance.synchronizePolicyDecisions([entry], 12);
  assert.equal(created.instance.flush(), true);
  return {
    ...created,
    snapshot: JSON.parse(fs.readFileSync(created.files.file, 'utf8')),
  };
}

function ackFor(snapshot, overrides = {}) {
  const ack = {
    schemaVersion: CAPTURE_PROFILE_ACK_SCHEMA,
    status: 'applied',
    errors: [],
    downgrades: [],
    nodeId: 'node-safety',
    collectorId: 'collector-safety',
    collectorInstanceId: 'collector-generation-a',
    hostBootId: 'boot-safety',
    publisherInstanceId: snapshot.publisherInstanceId,
    epoch: snapshot.epoch,
    policyVersion: snapshot.policyVersion,
    contentHash: snapshot.contentHash,
    intentHash: snapshot.intentHash,
    entriesApplied: snapshot.expectedEntries,
    appliedAt: new Date(now).toISOString(),
    capabilities: structuredClone(CAPTURE_PROFILE_CAPABILITIES),
    capabilitiesHash: digest(CAPTURE_PROFILE_CAPABILITIES),
    effectiveActionsHash: snapshot.effectiveActionsHash,
    ...overrides,
  };
  return ack;
}

function acceptedReport(instance, ack, overrides = {}) {
  const request = instance.materializationReport(ack);
  assert.ok(request, 'a consumed exact preview ACK must produce a materialization request');
  return {
    ...request,
    accepted: true,
    reportId: 'central-report-safety',
    filterRuleEntries: [{
      scopeKey: 'cgroup:101',
      cgroupId: '101',
      ruleId: 'rule-101',
      ruleRevision: 9,
      physicalWorkloadId: 'docker:node-safety:service-101',
      action: 'drop',
    }],
    ...overrides,
  };
}

// No ACK means preview forever: S5 actions may aggregate/sample, but no DROP reaches either reader.
const noAck = publish('no-ack');
assert.equal(noAck.snapshot.activation.mode, 'preview');
assert.equal(noAck.snapshot.entries[0].action, 'sample');
assert.equal(noAck.snapshot.entries[0].probeActions.file_access, 'aggregate');
assert.equal(noAck.snapshot.entries[0].desiredProbeActions.file_access, 'drop');

// Every field participating in freshness, generation, capability, or exact application is fenced.
const validAck = ackFor(noAck.snapshot);
const invalidAckMutations = [
  ['schema', { schemaVersion: 'anysentry.capture_profile_ack.v0' }],
  ['status', { status: 'degraded' }],
  ['errors', { errors: ['map update failed'] }],
  ['downgrades', { downgrades: ['drop->sample'] }],
  ['node', { nodeId: 'node-other' }],
  ['collector', { collectorId: 'collector-other' }],
  ['collector generation', { collectorInstanceId: '' }],
  ['boot', { hostBootId: 'boot-other' }],
  ['publisher', { publisherInstanceId: 'publisher-other' }],
  ['epoch', { epoch: noAck.snapshot.epoch + 1 }],
  ['policy', { policyVersion: noAck.snapshot.policyVersion + 1 }],
  ['content hash', { contentHash: '0'.repeat(64) }],
  ['intent hash', { intentHash: '1'.repeat(64) }],
  ['entry count', { entriesApplied: noAck.snapshot.expectedEntries + 1 }],
  ['stale time', { appliedAt: new Date(now - 120_001).toISOString() }],
  ['future time', { appliedAt: new Date(now + 30_001).toISOString() }],
  ['capabilities', { capabilities: { activationGrantV1: true } }],
  ['capabilities hash', { capabilitiesHash: '2'.repeat(64) }],
  ['effective actions', { effectiveActionsHash: '3'.repeat(64) }],
];
for (const [label, mutation] of invalidAckMutations) {
  assert.equal(noAck.instance.validateAck({ ...validAck, ...mutation }).ok, false, `${label} must reject`);
}
assert.equal(noAck.instance.validateAck(validAck).ok, true);

// A shape-valid ACK cannot authorize DROP unless this publisher actually consumed and pinned it.
const notConsumed = publish('not-consumed');
const notConsumedAck = ackFor(notConsumed.snapshot);
assert.equal(
  notConsumed.instance.acceptCentralMaterialization(
    notConsumedAck,
    {
      accepted: true,
      reportId: 'forged-report',
      nodeId: 'node-safety',
      publisherInstanceId: notConsumed.snapshot.publisherInstanceId,
      epoch: notConsumedAck.epoch,
      policyVersion: notConsumedAck.policyVersion,
      expectedEntries: notConsumedAck.entriesApplied,
      snapshotContentHash: notConsumedAck.contentHash,
      intentHash: notConsumedAck.intentHash,
      ack: notConsumedAck,
      filterRuleEntries: [],
    },
  ),
  false,
);

// Candidate and Agent/conflict inputs are sanitized again at the final writer boundary.
const candidate = publish('candidate', decision('201', { authority: 'candidate' }));
assert.ok(!Object.values(candidate.snapshot.entries[0].desiredProbeActions).includes('drop'));
const maliciousDrop = Object.fromEntries(PROBE_NAMES.map((probe) => [probe, 'drop']));
const agent = publish('agent', decision('202', {
  action: 'keep', policyAction: 'keep', authority: 'candidate', classification: 'confirmed_agent',
  captureProfile: 'agent_full', agentInstanceId: 'agent-safety', desiredProbeActions: maliciousDrop,
}));
assert.deepEqual(agent.snapshot.entries[0].desiredProbeActions, allFull);

const shared = createPublisher('shared-cgroup').instance;
shared.observeDecision(decision('203'));
shared.observeDecision(decision('203', {
  action: 'keep', policyAction: 'keep', authority: 'candidate', classification: 'probable_agent',
  captureProfile: 'agent_full', agentInstanceId: 'agent-shared', desiredProbeActions: maliciousDrop,
}));
assert.equal(shared.flush(), true);
const sharedEntry = shared.publishedSnapshot().entries[0];
assert.equal(sharedEntry.conflict, true);
assert.equal(sharedEntry.captureProfile, 'agent_full');
assert.deepEqual(sharedEntry.probeActions, allFull);

// A complete central acceptance must echo every destructive binding exactly.
const activation = publish('activation');
const activationAck = ackFor(activation.snapshot);
fs.writeFileSync(activation.files.ackFile, `${JSON.stringify(activationAck)}\n`);
assert.equal(activation.instance.consumeAckFile().accepted, true);
const incomplete = acceptedReport(activation.instance, activationAck, { filterRuleEntries: [] });
assert.equal(activation.instance.acceptCentralMaterialization(activationAck, incomplete), false);
const report = acceptedReport(activation.instance, activationAck);
assert.equal(activation.instance.acceptCentralMaterialization(activationAck, report), true);
assert.equal(activation.instance.flush(), true);
let active = activation.instance.publishedSnapshot();
assert.equal(active.activation.mode, 'enforce');
assert.equal(active.entries[0].action, 'sample', 'old Collector wire must remain non-destructive');
assert.equal(active.entries[0].probeActions.file_access, 'drop');

// The grant is time-bounded. Expiry restores preview-safe actions without a restart.
now = Date.parse(active.activationGrant.expiresAt) + 1;
activation.instance.metrics();
assert.equal(activation.instance.metrics().activationMode, 'preview');
assert.equal(activation.instance.flush(), true);
active = activation.instance.publishedSnapshot();
assert.equal(active.activation.mode, 'preview');
assert.equal(active.entries[0].probeActions.file_access, 'aggregate');

// Semantic rollback is allowed, but transport epoch only increases and destructive content replays
// must complete a fresh preview/ACK cycle.
now = baseNow;
const rollback = publish('rollback');
const firstEpoch = rollback.snapshot.epoch;
rollback.instance.synchronizePolicyDecisions([
  decision('101', {
    action: 'sample',
    policyAction: 'sample',
    desiredProbeActions: expectedProfiles.infrastructure_aggregate,
  }),
], 13);
assert.equal(rollback.instance.flush(), true);
const safeContent = rollback.instance.publishedSnapshot();
assert.ok(safeContent.epoch > firstEpoch);
rollback.instance.synchronizePolicyDecisions([decision('101')], 12);
assert.equal(rollback.instance.flush(), true);
const rolledBack = rollback.instance.publishedSnapshot();
assert.ok(rolledBack.epoch > safeContent.epoch);
assert.equal(rolledBack.activation.mode, 'preview');
assert.equal(rolledBack.entries[0].probeActions.file_access, 'aggregate');

console.log('S5 capture profile adversarial safety verification passed');
