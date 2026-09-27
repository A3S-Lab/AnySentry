#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  builtinFilterRules,
  CAPTURE_PROFILE_ACTIONS,
} = require('../apps/api/dist/security-monitoring/filter-rule-builtins.js');
const {
  compileFilterRuleEvaluationIndex,
  compileFilterRuleProjection,
  evaluateIndexedFilterRules,
} = require('../apps/api/dist/security-monitoring/filter-rule-engine.js');
const {
  CAPTURE_PROFILE_CAPABILITIES,
  FilterRulePublisher,
  compileCaptureDecision,
  supportsCaptureProfileCapabilities,
} = require('./observer-filter-rules.js');
const { safeDesiredProbeActions } = require('./observer-capture-profile-control.js');

const rules = builtinFilterRules();
const readRule = rules.find((rule) => rule.ruleId === 'fr_guardrail_agent_file_read_enable');
assert.ok(readRule, 'the unified Catalog exposes the Agent read enablement rule');
assert.equal(readRule.ruleKind, 'signal_enablement');
assert.deepEqual(readRule.consumerCapabilities, ['f0', 'f1', 'f2', 'f3']);
assert.equal(readRule.effect.signal, 'file_open_read');
assert.equal(CAPTURE_PROFILE_ACTIONS.agent_full.file_read, 'full');
assert.equal(CAPTURE_PROFILE_ACTIONS.probable_investigation.file_read, 'full');
for (const profile of ['unknown_discovery', 'security_full', 'business_context', 'infrastructure_aggregate', 'self_health']) {
  assert.equal(CAPTURE_PROFILE_ACTIONS[profile].file_read, 'not_enabled', `${profile} cannot enable read-open globally`);
}

const index = compileFilterRuleEvaluationIndex(rules);
const versions = { identity: 2, capture: 2, forwarder: 2, retention: 2 };
const matched = evaluateIndexedFilterRules({
  index,
  context: {
    identityClassification: 'probable_agent',
    runtimeState: 'current',
    bindingQuality: 'exact',
    signalName: 'file_open_read',
    probe: 'file_read',
  },
  stage: 'f1',
  catalogVersion: 2,
  domainVersions: versions,
});
assert.equal(matched.winner?.ruleId, readRule.ruleId);
const weak = evaluateIndexedFilterRules({
  index,
  context: {
    identityClassification: 'probable_agent',
    runtimeState: 'current',
    bindingQuality: 'weak',
    signalName: 'file_open_read',
    probe: 'file_read',
  },
  stage: 'f1',
  catalogVersion: 2,
  domainVersions: versions,
});
assert.notEqual(weak.winner?.ruleId, readRule.ruleId, 'weak candidates cannot widen a cgroup read scope');

const now = Date.parse('2026-08-26T00:00:00.000Z');
const exactProbable = compileCaptureDecision(
  {
    process: { pid: 501, cgroupId: '9001' },
    event: { ToolExec: { pid: 501, execIdExact: '7001' } },
  },
  {
    state: 'agent',
    attribution: {
      classification: 'probable_agent',
      agentInstanceId: 'ari-probable-501',
      rootPid: 501,
      rootKey: 'node:boot:501:7001',
    },
  },
  {
    scopeType: 'cgroup', scopeKey: 'cgroup:9001', cgroupId: '9001',
    classification: 'probable_agent', authority: 'candidate', action: 'keep',
    captureProfile: 'probable_investigation', expiresAt: new Date(now + 600_000).toISOString(),
  },
  { captureProfileMode: 'enforce', activationMode: 'enforce', now: () => now },
);
assert.equal(exactProbable.desiredProbeActions.file_read, 'full');
assert.equal(exactProbable.rootPid, 501);
assert.equal(exactProbable.rootExecIdExact, '7001');

const weakProbable = compileCaptureDecision(
  { process: { cgroupId: '9002' }, event: { FileAccess: { path: '/workspace/a' } } },
  { state: 'agent', attribution: { classification: 'probable_agent', source: 'behavior' } },
  {
    scopeType: 'cgroup', scopeKey: 'cgroup:9002', cgroupId: '9002',
    classification: 'probable_agent', authority: 'candidate', action: 'keep',
    captureProfile: 'probable_investigation', expiresAt: new Date(now + 600_000).toISOString(),
  },
  { captureProfileMode: 'enforce', activationMode: 'enforce', now: () => now },
);
assert.equal(weakProbable.desiredProbeActions.file_read, 'not_enabled');

const hostWithoutGeneration = compileCaptureDecision(
  { process: { pid: 777, cgroupId: 'shared-session' }, event: { FileAccess: { path: '/workspace/a' } } },
  {
    state: 'agent',
    attribution: {
      classification: 'probable_agent', agentInstanceId: 'ari-host-777', rootPid: 777,
      rootKey: 'host:boot:777:unknown', source: 'process_signature',
    },
  },
  {
    scopeType: 'cgroup', scopeKey: 'cgroup:shared-session', cgroupId: '7777',
    classification: 'probable_agent', authority: 'candidate', action: 'keep',
    captureProfile: 'probable_investigation', expiresAt: new Date(now + 600_000).toISOString(),
  },
  { captureProfileMode: 'enforce', activationMode: 'enforce', now: () => now },
);
assert.equal(
  hostWithoutGeneration.desiredProbeActions.file_read,
  'not_enabled',
  'a Host Agent instance/root PID without exact exec generation cannot widen a shared session cgroup',
);
const confirmedWithoutScope = compileCaptureDecision(
  { process: { pid: 778, cgroupId: 'shared-confirmed' }, event: { FileAccess: { path: '/workspace/b' } } },
  {
    state: 'agent',
    attribution: { classification: 'confirmed_agent', agentInstanceId: 'confirmed-but-unbound' },
  },
  {
    scopeType: 'cgroup', scopeKey: 'cgroup:shared-confirmed', cgroupId: '7778',
    classification: 'confirmed_agent', authority: 'authoritative', action: 'keep',
    captureProfile: 'agent_full', expiresAt: new Date(now + 600_000).toISOString(),
  },
  { captureProfileMode: 'enforce', activationMode: 'enforce', now: () => now },
);
assert.equal(confirmedWithoutScope.desiredProbeActions.file_read, 'not_enabled');
assert.equal(
  safeDesiredProbeActions(confirmedWithoutScope).file_read,
  'not_enabled',
  'Agent keep safety cannot overwrite the explicit selective-read boundary',
);

const dedicatedKubernetes = compileCaptureDecision(
  { process: { cgroupId: 'dedicated-k8s' }, event: { ToolExec: { pid: 1 } } },
  {
    state: 'agent',
    attribution: {
      classification: 'probable_agent', agentInstanceId: 'pod/container',
      physicalWorkloadId: 'k8s:cluster:pod:container',
      workloadRef: { environment: 'kubernetes', kind: 'container' },
    },
  },
  {
    scopeType: 'cgroup', scopeKey: 'cgroup:dedicated-k8s', cgroupId: '8888',
    classification: 'probable_agent', authority: 'candidate', action: 'keep',
    captureProfile: 'probable_investigation', agentInstanceId: 'pod/container',
    physicalWorkloadId: 'k8s:cluster:pod:container',
    workloadRef: { environment: 'kubernetes', kind: 'container' },
    expiresAt: new Date(now + 600_000).toISOString(),
  },
  { captureProfileMode: 'enforce', activationMode: 'enforce', now: () => now },
);
assert.equal(dedicatedKubernetes.desiredProbeActions.file_read, 'full');

const shadow = compileCaptureDecision(
  { process: { pid: 501, cgroupId: '9001' }, event: { FileAccess: { path: '/workspace/a' } } },
  { state: 'agent', attribution: { classification: 'confirmed_agent', rootPid: 501, rootKey: 'root' } },
  {
    scopeType: 'cgroup', scopeKey: 'cgroup:9001', cgroupId: '9001',
    classification: 'confirmed_agent', authority: 'authoritative', action: 'keep',
    captureProfile: 'agent_full', expiresAt: new Date(now + 600_000).toISOString(),
  },
  { captureProfileMode: 'shadow', now: () => now },
);
assert.equal(shadow.probeActions.file_read, 'not_enabled', 'shadow never transports globally default-off reads');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'anysentry-agent-read-'));
const file = path.join(directory, 'rules.json');
const publisher = new FilterRulePublisher({
  file,
  captureProfileMode: 'enforce',
  publisherInstanceId: 'publisher-read',
  nodeId: 'node-a',
  collectorId: 'collector-a',
  hostBootId: 'boot-a',
  now: () => now,
  flushIntervalMs: 5_000,
});
publisher.observeDecision(exactProbable);
publisher.flush();
const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
assert.equal(snapshot.entries[0].desiredProbeActions.file_read, 'not_enabled', 'root-scoped reads stay disabled at cgroup level');
assert.equal(snapshot.entries[0].rootPid, 501, 'the Collector receives the exact root promotion');
assert.equal(snapshot.entries[0].rootExecIdExact, '7001');
publisher.close();
fs.rmSync(directory, { recursive: true, force: true });

const projection = compileFilterRuleProjection({
  rules,
  catalogVersion: 2,
  domainVersions: versions,
  now,
});
assert.equal(projection.signalEnablementRules.length, 1);
assert.equal(projection.captureProfiles.probable_investigation.file_read, 'full');

assert.equal(CAPTURE_PROFILE_CAPABILITIES.selectiveFileRead, true);
assert(CAPTURE_PROFILE_CAPABILITIES.probeActions.includes('not_enabled'));
assert.equal(supportsCaptureProfileCapabilities(CAPTURE_PROFILE_CAPABILITIES), true);
const lifecycleReadSource = fs.readFileSync(
  new URL('../apps/api/src/security-monitoring/observed-asset-lifecycle.read.service.ts', import.meta.url),
  'utf8',
);
assert.match(lifecycleReadSource, /profile === 'probable_investigation'[\s\S]*?fileRead: 'full'/u);
assert.match(lifecycleReadSource, /profile === 'security_full'[\s\S]*?fileRead: 'not_enabled'/u);
assert.match(lifecycleReadSource, /infrastructure_aggregate'[\s\S]*?fileRead: 'not_enabled'/u);

console.log('General Agent selective file-read rule and exact-scope projection passed');
