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
  FILTER_RULE_SNAPSHOT_SCHEMA,
  FilterRulePublisher,
  canonicalJson,
  captureIntentHash,
  captureIntentProjection,
  captureSnapshotContentHash,
  compileCaptureDecision,
  digest,
} = require('./observer-filter-rules.js');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'anysentry-s5-control-'));
const fixedNow = Date.parse('2026-08-20T00:00:00.000Z');
const expiresAt = '2026-08-20T00:10:00.000Z';

function paths(name) {
  return {
    file: path.join(temp, `${name}.json`),
    ackFile: path.join(temp, `${name}.ack.json`),
  };
}

function centralDecision(cgroupId = '42', overrides = {}) {
  return {
    scopeType: 'cgroup',
    scopeKey: `cgroup:${cgroupId}`,
    cgroupId,
    classification: 'non_agent',
    authority: 'authoritative',
    action: 'drop',
    reasonCode: 'known_anysentry_infrastructure',
    source: 'platform_inventory',
    physicalWorkloadId: `docker:node-a:service-${cgroupId}`,
    ruleId: `rule-${cgroupId}`,
    ruleRevision: 3,
    materializationId: `mat-${cgroupId}`,
    policyVersion: 7,
    captureProfile: 'infrastructure_aggregate',
    desiredProbeActions: {
      exec: 'full', exit: 'full', tls: 'aggregate', connect: 'aggregate', dns: 'aggregate',
      file_access: 'drop', file_delete: 'sample', llm: 'aggregate', ssl: 'aggregate', security: 'full', file_read: 'not_enabled',
    },
    expiresAt,
    ...overrides,
  };
}

function publisher(name, mode, options = {}) {
  return new FilterRulePublisher({
    ...paths(name),
    captureProfileMode: mode,
    publisherInstanceId: `publisher-${name}`,
    nodeId: 'node-a',
    collectorId: 'collector-a',
    hostBootId: 'boot-a',
    now: options.now ?? (() => fixedNow),
    flushIntervalMs: 5_000,
    ttlMs: 120_000,
    ...options,
  });
}

function ackFor(snapshot, collectorInstanceId = 'collector-instance-a') {
  return {
    schemaVersion: CAPTURE_PROFILE_ACK_SCHEMA,
    status: 'applied',
    errors: [],
    downgrades: [],
    nodeId: 'node-a',
    collectorId: 'collector-a',
    collectorInstanceId,
    hostBootId: 'boot-a',
    publisherInstanceId: snapshot.publisherInstanceId,
    epoch: snapshot.epoch,
    policyVersion: snapshot.policyVersion,
    contentHash: snapshot.contentHash,
    intentHash: snapshot.intentHash,
    entriesApplied: snapshot.expectedEntries,
    appliedAt: new Date(fixedNow).toISOString(),
    capabilities: structuredClone(CAPTURE_PROFILE_CAPABILITIES),
    capabilitiesHash: digest(CAPTURE_PROFILE_CAPABILITIES),
    effectiveActionsHash: snapshot.effectiveActionsHash,
  };
}

// Rollout modes are exact: legacy stays v1, shadow is observational FULL, enforce starts safe.
const legacy = publisher('legacy', 'legacy');
legacy.observeDecision(centralDecision());
legacy.flush();
const legacySnapshot = JSON.parse(fs.readFileSync(paths('legacy').file, 'utf8'));
assert.equal(legacySnapshot.entries[0].action, 'drop');
assert.equal(legacySnapshot.captureProfileMode, undefined);

const shadow = publisher('shadow', 'shadow');
shadow.observeDecision(centralDecision());
shadow.flush();
const shadowSnapshot = JSON.parse(fs.readFileSync(paths('shadow').file, 'utf8'));
assert.equal(shadowSnapshot.captureProfileMode, 'shadow');
assert.equal(shadowSnapshot.entries[0].action, 'keep');
assert.ok(Object.entries(shadowSnapshot.entries[0].probeActions)
  .every(([probe, action]) => action === (probe === 'file_read' ? 'not_enabled' : 'full')));
assert.equal(shadowSnapshot.entries[0].desiredProbeActions.file_access, 'drop');

const expectedIntentActions = (action) => {
  const matrix = Object.fromEntries(CAPTURE_PROFILE_CAPABILITIES.probeNames.map((probe) => [probe, action]));
  matrix.exec = 'full';
  matrix.exit = 'full';
  matrix.security = 'full';
  if (action !== 'full') matrix.file_delete = 'sample';
  matrix.file_read = 'not_enabled';
  return matrix;
};
for (const [index, action] of ['full', 'aggregate', 'sample', 'drop'].entries()) {
  const captureIntent = {
    schemaVersion: 'anysentry.infrastructure_capture_intent.v1',
    action,
  };
  const input = {
    scopeType: 'cgroup', scopeKey: `cgroup:${600 + index}`, cgroupId: String(600 + index),
    classification: 'non_agent', authority: 'candidate',
    action: action === 'full' ? 'keep' : 'sample',
    captureProfile: 'infrastructure_aggregate', captureIntent,
    reasonCode: `capture_intent_${action}`, source: 'operator',
    physicalWorkloadId: `docker:node-a:intent-${action}`,
    ruleId: `intent-${action}`, ruleRevision: 1, policyVersion: 7, expiresAt,
  };
  const shadowIntent = compileCaptureDecision(
    { process: { cgroupId: input.cgroupId }, event: { FileAccess: {} } },
    { state: 'infrastructure', attribution: { classification: 'unknown', source: 'operator' } },
    input,
    { captureProfileMode: 'shadow', now: () => fixedNow },
  );
  const enforcedIntent = compileCaptureDecision(
    { process: { cgroupId: input.cgroupId }, event: { FileAccess: {} } },
    { state: 'infrastructure', attribution: { classification: 'non_agent', source: 'operator' } },
    {
      ...input,
      authority: 'authoritative',
      action: action === 'full' ? 'keep' : action === 'drop' ? 'drop' : 'sample',
    },
    { captureProfileMode: 'enforce', activationMode: 'enforce', now: () => fixedNow },
  );
  const expected = expectedIntentActions(action);
  assert.deepEqual(shadowIntent.captureIntent, captureIntent);
  assert.deepEqual(shadowIntent.desiredProbeActions, expected,
    `${action} desired intent must survive candidate/shadow safety projection`);
  assert.ok(Object.entries(shadowIntent.probeActions)
    .every(([probe, probeAction]) => probeAction === (probe === 'file_read' ? 'not_enabled' : 'full')));
  assert.deepEqual(enforcedIntent.captureIntent, captureIntent);
  assert.deepEqual(enforcedIntent.desiredProbeActions, expected,
    `${action} desired intent cannot drift during shadow to enforced transition`);
  assert.deepEqual(enforcedIntent.probeActions, expected);
  assert.equal(enforcedIntent.probeActions.exec, 'full');
  assert.equal(enforcedIntent.probeActions.exit, 'full');
  assert.equal(enforcedIntent.probeActions.security, 'full');
}

// Kernel execution generations exceed JavaScript's exact integer range. Preserve the legacy
// number while carrying a lossless additive decimal field through the root-promotion contract.
const exactRoot = compileCaptureDecision(
  {
    process: { pid: 77, cgroupId: '77' },
    event: { ToolExec: { pid: 77, execId: 9_007_199_254_740_993, execIdExact: '9007199254740993' } },
  },
  {
    state: 'agent',
    attribution: { classification: 'confirmed_agent', rootPid: 77, rootKey: 'boot:77:1' },
  },
  {
    scopeType: 'cgroup', scopeKey: 'cgroup:77', cgroupId: '77', classification: 'confirmed_agent',
    authority: 'authoritative', action: 'keep', captureProfile: 'agent_full', expiresAt,
  },
  { captureProfileMode: 'shadow', now: () => fixedNow },
);
assert.equal(exactRoot.rootExecId, '9007199254740992', 'legacy numeric alias remains compatible');
assert.equal(exactRoot.rootExecIdExact, '9007199254740993', 'exact generation never round-trips through Number');

const probable = compileCaptureDecision(
  { process: { pid: 78, cgroupId: '78' }, event: { FileAccess: { pid: 78 } } },
  {
    state: 'agent',
    attribution: {
      classification: 'probable_agent', rootPid: 78, rootKey: 'boot:78:1',
      agentInstanceId: 'candidate-runtime-78',
    },
  },
  {
    scopeType: 'cgroup', scopeKey: 'cgroup:78', cgroupId: '78', classification: 'probable_agent',
    authority: 'candidate', action: 'keep', expiresAt,
  },
  { captureProfileMode: 'enforce', activationMode: 'preview', now: () => fixedNow },
);
assert.equal(probable.captureProfile, 'probable_investigation');
assert.equal(probable.ttlMs, 120_000);
assert.equal(probable.expiresAt, new Date(fixedNow + 120_000).toISOString(),
  'probable investigation cannot inherit an unbounded or ordinary long-lived profile TTL');
assert.deepEqual(probable.desiredProbeActions, {
  exec: 'full', exit: 'full', tls: 'sample', connect: 'sample', dns: 'sample',
  file_access: 'sample', file_delete: 'sample', llm: 'full', ssl: 'sample', security: 'full', file_read: 'not_enabled',
});

const implicitDiscovery = publisher('implicit-discovery-default', 'enforce');
const unknownDefault = implicitDiscovery.observe(
  { process: { cgroupId: '79' }, event: { FileAccess: { pid: 79 } } },
  { state: 'unknown', attribution: { classification: 'unknown', source: 'none' } },
);
assert.equal(unknownDefault.implicitDefault, true);
assert.equal(implicitDiscovery.entries.size, 0, 'redundant Unknown cgroups use the kernel discovery default');
const probableDefault = implicitDiscovery.observe(
  { process: { cgroupId: '80' }, event: { FileAccess: { pid: 80 } } },
  { state: 'agent', attribution: { classification: 'probable_agent', source: 'behavior' } },
);
assert.equal(probableDefault.captureProfile, 'probable_investigation');
assert.equal(probableDefault.implicitDefault, true);
assert.equal(implicitDiscovery.entries.size, 0, 'probable investigation shares the bounded kernel default without epoch churn');
const probableSecurityDefault = implicitDiscovery.observe(
  { process: { cgroupId: '82' }, event: { SecurityAction: { pid: 82, kind: 'setuid' } } },
  { state: 'agent', attribution: { classification: 'probable_agent', source: 'process_graph' } },
);
assert.equal(probableSecurityDefault.captureProfile, 'security_full');
assert.equal(probableSecurityDefault.desiredProbeActions.security, 'full');
assert.equal(probableSecurityDefault.implicitDefault, true);
assert.equal(implicitDiscovery.entries.size, 0,
  'a raw SecurityAction is retained as FULL evidence without installing a cgroup-wide profile');
const businessCandidate = centralDecision('81', {
  classification: 'non_agent', authority: 'candidate', action: 'sample',
  captureProfile: 'business_context', reasonCode: 'non_agent_unconfirmed', source: 'process_graph',
});
delete businessCandidate.ruleId;
delete businessCandidate.ruleRevision;
delete businessCandidate.materializationId;
const businessDefault = implicitDiscovery.observeDecision(businessCandidate);
assert.equal(businessDefault.implicitDefault, true);
assert.equal(implicitDiscovery.entries.size, 0,
  'unapproved business candidates retain the safe node default instead of churning global grants');
const unruledInfrastructure = centralDecision('82', {
  captureProfile: 'infrastructure_aggregate', source: 'kubernetes',
});
delete unruledInfrastructure.ruleId;
delete unruledInfrastructure.ruleRevision;
delete unruledInfrastructure.materializationId;
const infrastructureDefault = implicitDiscovery.observeDecision(unruledInfrastructure);
assert.equal(infrastructureDefault.implicitDefault, true);
assert.equal(implicitDiscovery.entries.size, 0,
  'local infrastructure observations require a Central rule before entering the global grant intent');

let enforceNow = fixedNow;
const enforce = publisher('enforce', 'enforce', { now: () => enforceNow });
const enforceDecision = () => centralDecision('42', {
  expiresAt: new Date(enforceNow + 120_000).toISOString(),
});
const centralPrecedence = publisher('central-precedence', 'enforce');
centralPrecedence.observeDecision(centralDecision('41'));
centralPrecedence.observe(
  { process: { cgroupId: '41' }, event: { FileAccess: { pid: 41 } } },
  { state: 'non_agent', attribution: { classification: 'non_agent', source: 'kubernetes' } },
);
assert.equal(centralPrecedence.entries.get('cgroup:41').ruleId, 'rule-41',
  'local discovery observations cannot oscillate an exact central policy entry');
const alignedPolicy = publisher('aligned-policy-expiry', 'enforce');
alignedPolicy.synchronizePolicyDecisions([
  centralDecision('410', { expiresAt: new Date(fixedNow + 120_000).toISOString() }),
  centralDecision('411', { expiresAt: new Date(fixedNow + 125_000).toISOString() }),
], 7);
assert.deepEqual(
  [...new Set([...alignedPolicy.entries.values()].map((entry) => entry.expiresAt))],
  [new Date(fixedNow + 120_000).toISOString()],
  'one Central synchronization aligns scope TTLs without extending the earliest authority',
);
let refreshNow = fixedNow;
const boundedRefresh = publisher('bounded-ttl-refresh', 'enforce', { now: () => refreshNow });
const originalExpiry = new Date(fixedNow + 120_000).toISOString();
boundedRefresh.observeDecision(centralDecision('412', { expiresAt: originalExpiry }));
const initialRefreshVersion = boundedRefresh.version;
refreshNow += 70_000;
boundedRefresh.observeDecision(centralDecision('412', { expiresAt: originalExpiry }));
assert.equal(boundedRefresh.version, initialRefreshVersion,
  're-reading one unchanged expiry in its second half cannot trigger another handshake');
boundedRefresh.observeDecision(centralDecision('412', {
  expiresAt: new Date(fixedNow + 190_000).toISOString(),
}));
assert.equal(boundedRefresh.version, initialRefreshVersion,
  'a newer same-intent lease outside the bounded refresh lead is coalesced');
refreshNow += 36_000;
boundedRefresh.observeDecision(centralDecision('412', {
  expiresAt: new Date(fixedNow + 190_000).toISOString(),
}));
assert(boundedRefresh.version > initialRefreshVersion,
  'a genuinely newer bounded expiry still requires Preview and ACK inside the safety lead');
const protectedAgentDecision = () => {
  const value = centralDecision('43', {
    classification: 'confirmed_agent', authority: 'authoritative', action: 'keep',
    captureProfile: 'agent_full', agentInstanceId: 'agent-refresh-protected',
    desiredProbeActions: Object.fromEntries(
      Object.keys(centralDecision().desiredProbeActions).map((probe) => [probe, 'full']),
    ),
    expiresAt: new Date(enforceNow + 120_000).toISOString(),
  });
  delete value.ruleId;
  delete value.ruleRevision;
  delete value.materializationId;
  return value;
};
enforce.synchronizePolicyDecisions([enforceDecision(), protectedAgentDecision()], 7);
enforce.flush();
const preview = JSON.parse(fs.readFileSync(paths('enforce').file, 'utf8'));
assert.equal(preview.activation.mode, 'preview');
assert.equal(preview.entries[0].action, 'sample', 'legacy readers must never receive S5 destructive action');
assert.equal(preview.entries[0].probeActions.file_access, 'aggregate');
assert.equal(preview.entries[0].desiredProbeActions.file_access, 'drop');
assert.equal(captureSnapshotContentHash(preview), preview.contentHash);

const previewAck = ackFor(preview);
fs.writeFileSync(paths('enforce').ackFile, `${JSON.stringify(previewAck)}\n`);
assert.equal(enforce.consumeAckFile().accepted, true);
const request = enforce.materializationReport();
assert.equal(request.bindings.length, 1);
assert.equal(request.bindings[0].action, 'drop');
assert.match(request.reportId, /^matr_[a-f0-9]{24}$/u);
assert.equal(enforce.materializationReport().reportId, request.reportId,
  'a lost Central response retries the same generation-bound report operation');
const centralReport = {
  ...request,
  accepted: true,
  reportId: 'report-a',
  filterRuleEntries: [{
    scopeKey: 'cgroup:42', cgroupId: '42', ruleId: 'rule-42', ruleRevision: 3,
    physicalWorkloadId: 'docker:node-a:service-42', action: 'drop',
  }],
};
assert.equal(enforce.acceptCentralMaterialization(previewAck, centralReport), true);
enforce.flush();
const active = JSON.parse(fs.readFileSync(paths('enforce').file, 'utf8'));
assert.equal(active.activation.mode, 'enforce');
assert.equal(active.entries[0].action, 'sample', 'old v1 Collector remains non-destructive after grant');
assert.equal(active.entries[0].probeActions.file_access, 'drop');
assert.equal(active.activationGrant.collectorInstanceId, 'collector-instance-a');
assert.equal(active.activationGrant.previewContentHash, preview.contentHash);

const stableGrantVersion = enforce.version;
enforce.observeDecision({
  ...enforceDecision(),
  materializationId: 'mat-reconciled-without-semantic-change',
  rootProcessKey: 'boot:pid:next',
  rootPid: 4242,
  rootGeneration: 'next',
});
assert.equal(enforce.version, stableGrantVersion,
  'process and materialization revision churn cannot revoke a same-intent live grant');
assert.equal(enforce.metrics().activationMode, 'enforce');

// A refresh inside the bounded expiry lead changes the transport epoch/content and therefore
// starts a fresh preview. Earlier sliding TTL observations are coalesced.
// The old grant is never replayed; protected Agent actions remain FULL throughout the transition.
const activeEpoch = active.epoch;
const rejectedBeforeRefresh = enforce.metrics().ackRejected;
enforceNow += 61_000;
enforce.synchronizePolicyDecisions([enforceDecision(), protectedAgentDecision()], 7);
enforce.flush();
assert.equal(JSON.parse(fs.readFileSync(paths('enforce').file, 'utf8')).epoch, activeEpoch,
  'same-intent TTL refresh outside the safety lead does not reload the Collector');
enforceNow += 45_000;
enforce.synchronizePolicyDecisions([enforceDecision(), protectedAgentDecision()], 7);
enforce.flush();
const ttlRefresh = JSON.parse(fs.readFileSync(paths('enforce').file, 'utf8'));
assert.ok(ttlRefresh.epoch > activeEpoch, 'transport epoch remains monotonic');
assert.equal(ttlRefresh.intentHash, active.intentHash,
  'TTL-only refresh keeps the semantic intent hash stable');
assert.equal(ttlRefresh.activation.mode, 'preview');
assert.equal(ttlRefresh.activation.reason, 'ttl_refresh_requires_preview');
assert.equal(ttlRefresh.activationGrant, undefined, 'old grant cannot cross epoch/content');
assert.equal(enforce.metrics().ttlRefreshes, 1,
  'one node lease window produces one TTL Preview operation');
assert.ok(enforce.metrics().coalescedTtlRefreshes >= 1,
  'same-intent Agent/Central expiry updates join that one Preview');
assert.equal(ttlRefresh.entries.find((entry) => entry.cgroupId === '42').probeActions.file_access, 'aggregate');
assert.ok(Object.values(
  ttlRefresh.entries.find((entry) => entry.cgroupId === '43').probeActions,
).every((action) => action === 'full'));
assert.equal(enforce.metrics().ackRejected, rejectedBeforeRefresh, 'refresh never emits an invalid enforce ACK');

// Static security focus is narrow; a real SecurityAction promotes to investigation_full.
const security = compileCaptureDecision(
  { process: { cgroupId: '71', pid: 71 }, event: { FileAccess: {} } },
  { state: 'unknown', captureProfile: 'security_full', attribution: { classification: 'unknown' } },
  { ...centralDecision('71'), action: 'sample', captureProfile: 'security_full' },
  { captureProfileMode: 'enforce', activationMode: 'preview', now: () => fixedNow },
);
assert.deepEqual(
  Object.fromEntries(Object.entries(security.desiredProbeActions).filter(([, action]) => action === 'full').map(([probe]) => [probe, true])),
  { exec: true, exit: true, connect: true, file_delete: true, llm: true, security: true },
);
const risk = compileCaptureDecision(
  { process: { cgroupId: '72', pid: 72 }, event: { SecurityAction: {} } },
  { state: 'unknown', attribution: { classification: 'unknown' } },
  { ...centralDecision('72'), action: 'sample' },
  {
    captureProfileMode: 'enforce', activationMode: 'preview', now: () => fixedNow,
    riskPromotion: true, riskPromotionTtlMs: 30_000,
  },
);
assert.equal(risk.captureProfile, 'investigation_full');
assert.ok(Object.values(risk.desiredProbeActions).every((action) => action === 'full'));
assert.equal(risk.promotionExpiresAt, '2026-08-20T00:00:30.000Z');

// Unknown discovery is a fixed bounded matrix even for a complete authoritative direct input.
const maliciousUnknownInput = centralDecision('79', {
  classification: 'unknown',
  captureProfile: 'unknown_discovery',
  desiredProbeActions: Object.fromEntries(
    Object.keys(centralDecision().desiredProbeActions).map((probe) => [probe, 'drop']),
  ),
});
const compiledUnknown = compileCaptureDecision(
  { process: { cgroupId: '79', pid: 79 }, event: { FileAccess: {} } },
  { state: 'unknown', attribution: { classification: 'unknown' } },
  maliciousUnknownInput,
  { captureProfileMode: 'enforce', activationMode: 'preview', now: () => fixedNow },
);
assert.equal(compiledUnknown.desiredProbeActions.file_access, 'sample');
assert.equal(compiledUnknown.desiredProbeActions.file_delete, 'sample');
assert.equal(compiledUnknown.desiredProbeActions.llm, 'full');
const unknownWriter = publisher('unknown-writer-safety', 'enforce');
unknownWriter.observeDecision(maliciousUnknownInput);
unknownWriter.flush();
const unknownSnapshot = JSON.parse(fs.readFileSync(paths('unknown-writer-safety').file, 'utf8'));
assert.deepEqual(unknownSnapshot.entries[0].desiredProbeActions, compiledUnknown.desiredProbeActions);

// The final writer boundary rejects malicious direct Agent/candidate destructive intents.
const agent = publisher('agent-safety', 'enforce');
agent.observeDecision(centralDecision('80', {
  classification: 'confirmed_agent', captureProfile: 'agent_full', action: 'keep', authority: 'candidate',
  desiredProbeActions: Object.fromEntries(Object.keys(centralDecision().desiredProbeActions).map((probe) => [probe, 'drop'])),
  agentInstanceId: 'agent-a',
}));
agent.flush();
const agentSnapshot = JSON.parse(fs.readFileSync(paths('agent-safety').file, 'utf8'));
assert.ok(Object.values(agentSnapshot.entries[0].desiredProbeActions).every((action) => action === 'full'));

// Existing destructive v1 disk state is synchronously rewritten to a monotonic safe preview.
const migrationPaths = paths('migration');
fs.writeFileSync(migrationPaths.file, `${JSON.stringify({
  schemaVersion: FILTER_RULE_SNAPSHOT_SCHEMA,
  version: 99,
  epoch: 99,
  generatedAt: new Date(fixedNow - 1_000).toISOString(),
  entries: [centralDecision('90', { epoch: 99 })],
})}\n`);
const migration = publisher('migration', 'enforce');
const migrated = JSON.parse(fs.readFileSync(migrationPaths.file, 'utf8'));
assert.ok(migrated.epoch > 99);
assert.equal(migrated.activation.mode, 'preview');
assert.notEqual(migrated.entries[0].action, 'drop');

// A corrupt snapshot recovers above the live Collector ACK epoch and wall-clock seed.
const recoveryPaths = paths('recovery');
fs.writeFileSync(recoveryPaths.file, '{broken');
fs.writeFileSync(recoveryPaths.ackFile, JSON.stringify({ epoch: fixedNow * 1_000 + 50 }));
const recovery = publisher('recovery', 'enforce');
recovery.observeDecision(centralDecision('91'));
recovery.flush();
assert.ok(JSON.parse(fs.readFileSync(recoveryPaths.file, 'utf8')).epoch > fixedNow * 1_000 + 50);

// LKG expiry is fixed at first degradation; repeated failures cannot slide it forever.
let lkgNow = fixedNow;
const lkg = publisher('lkg', 'enforce', { now: () => lkgNow, lkgTtlMs: 120_000 });
lkg.markControlPlaneReady();
lkg.observeDecision(centralDecision('92'));
assert.equal(lkg.degradeToLastKnownGood('offline'), true);
const firstLkgExpiry = lkg.entries.get('cgroup:92').expiresAt;
lkgNow += 60_000;
assert.equal(lkg.degradeToLastKnownGood('still-offline'), false);
assert.equal(lkg.entries.get('cgroup:92').expiresAt, firstLkgExpiry);
lkgNow += 61_000;
assert.equal(lkg.snapshot().entries.length, 0);

// The same fixed deadline survives any number of Forwarder restarts. Process start time is never
// accepted as a new control-plane success, otherwise a restart loop could retain stale DROP intent
// forever.
let restartNow = fixedNow;
const restartFirst = publisher('lkg-restart', 'enforce', {
  now: () => restartNow,
  lkgTtlMs: 120_000,
});
restartFirst.markControlPlaneReady();
restartFirst.observeDecision(centralDecision('93'));
restartFirst.flush();
restartFirst.close();

restartNow += 30_000;
const restartSecond = publisher('lkg-restart', 'enforce', {
  now: () => restartNow,
  lkgTtlMs: 120_000,
});
assert.equal(restartSecond.degradeToLastKnownGood('offline-after-restart'), true);
restartSecond.flush();
const persistedLkgExpiry = restartSecond.entries.get('cgroup:93').expiresAt;
assert.equal(persistedLkgExpiry, new Date(fixedNow + 120_000).toISOString());
restartSecond.close();

restartNow += 30_000;
const restartThird = publisher('lkg-restart', 'enforce', {
  now: () => restartNow,
  lkgTtlMs: 120_000,
});
assert.equal(restartThird.degradeToLastKnownGood('offline-after-second-restart'), true);
assert.equal(restartThird.entries.get('cgroup:93').expiresAt, persistedLkgExpiry);
restartThird.close();

const neverGood = publisher('lkg-never-good', 'enforce', { lkgTtlMs: 120_000 });
neverGood.observeDecision(centralDecision('94'));
assert.equal(neverGood.degradeToLastKnownGood('initial-control-plane-failure'), true);
assert.equal(neverGood.entries.size, 0, 'process startup cannot mint an LKG lease');

// Serialized output is hard-bounded; missing evicted scopes fall back to discovery-safe handling.
const bounded = publisher('bounded', 'enforce', { maxSnapshotBytes: 64 * 1024, maxEntries: 1_000 });
for (let index = 0; index < 300; index++) {
  bounded.observeDecision(centralDecision(String(10_000 + index), {
    physicalWorkloadId: `docker:node-a:${'x'.repeat(500)}:${index}`,
  }));
}
bounded.flush();
assert.ok(fs.statSync(paths('bounded').file).size <= 64 * 1024);
assert.ok(bounded.metrics().capacityEvicted > 0);

// The max-entry guard uses the same priority as byte pruning: Agent is evicted last, not oldest.
const maxEntryBounded = publisher('max-entry-bounded', 'enforce', { maxEntries: 100 });
maxEntryBounded.observeDecision(centralDecision('20000', {
  action: 'keep', authority: 'authoritative', classification: 'confirmed_agent',
  captureProfile: 'agent_full', agentInstanceId: 'agent-capacity',
}));
for (let index = 0; index < 100; index++) {
  maxEntryBounded.observeDecision(centralDecision(String(21_000 + index), {
    classification: 'unknown', captureProfile: 'unknown_discovery',
  }));
}
assert.equal(maxEntryBounded.entries.size, 100);
assert.ok(maxEntryBounded.entries.has('cgroup:20000'));

const probableBounded = publisher('probable-bounded', 'enforce', {
  maxEntries: 100,
  maxProbableEntries: 16,
  probableTtlMs: 60_000,
});
for (let index = 0; index < 20; index++) {
  probableBounded.observeDecision(centralDecision(String(22_000 + index), {
    action: 'keep', authority: 'candidate', classification: 'probable_agent',
    captureProfile: 'probable_investigation', agentInstanceId: `probable-${index}`,
    expiresAt,
  }));
}
assert.equal(
  [...probableBounded.entries.values()].filter((entry) => entry.captureProfile === 'probable_investigation').length,
  16,
  'probable investigations have an independent per-node capacity bound',
);
assert.equal(probableBounded.metrics().probableCapacityEvicted, 4);
assert([...probableBounded.entries.values()].every((entry) => Date.parse(entry.expiresAt) <= fixedNow + 60_000));

const envelopeBounded = publisher('envelope-expiry-bounded', 'enforce', { ttlMs: 120_000, lkgTtlMs: 600_000 });
envelopeBounded.observeDecision(centralDecision('23000', { expiresAt }));
const envelopeSnapshot = envelopeBounded.snapshot();
assert(envelopeSnapshot.entries.every((entry) => Date.parse(entry.expiresAt) <= Date.parse(envelopeSnapshot.expiresAt)),
  'every wire entry is fenced by the snapshot expiry even when stored LKG/policy TTL is longer');

// Canonical hash golden vector shared with the Rust Collector. ASCII keys use code-unit/byte order.
const goldenEntry = centralDecision('314');
const goldenProjection = captureIntentProjection([goldenEntry], 7);
const goldenCanonical = canonicalJson(goldenProjection);
assert.equal(
  captureIntentHash([goldenEntry], 7),
  'eabcc170e9ce397ef52fa44fe9fe67f3d23b19198cfd50f0e3236f4bd4f01a8a',
);
assert.equal(
  captureIntentHash([{
    ...goldenEntry,
    captureIntent: { schemaVersion: 'anysentry.infrastructure_capture_intent.v1', action: 'drop' },
  }], 7),
  '8e5671f50eb139919babf65d193703d352823a66e1f885652317daeafd8e9162',
  'the declared capture intent has one shared JS/Rust golden hash',
);
assert.equal(
  captureIntentHash([goldenEntry], 7),
  captureIntentHash([{ ...goldenEntry, materializationId: 'mat-next-preview', epoch: 8_888 }], 7),
  'Preview/report bookkeeping cannot invalidate an otherwise identical capture intent',
);
assert.equal(
  captureIntentHash([{ ...goldenEntry, rootProcessKey: 'boot:pid:1', rootPid: 1, rootGeneration: '1' }], 7),
  captureIntentHash([{ ...goldenEntry, rootProcessKey: 'boot:pid:2', rootPid: 2, rootGeneration: '2' }], 7),
  'process-generation churn inside one cgroup cannot recompile the node Capture Profile',
);
const goldenSnapshot = {
  schemaVersion: FILTER_RULE_SNAPSHOT_SCHEMA,
  captureProfileMode: 'enforce',
  version: 7001,
  epoch: 7001,
  policyVersion: 7,
  publisherInstanceId: 'publisher_golden',
  generatedAt: '2026-08-20T00:00:00.000Z',
  expiresAt: '2026-08-20T00:02:00.000Z',
  expectedEntries: 0,
  expectedCapabilitiesHash: digest(CAPTURE_PROFILE_CAPABILITIES),
  effectiveActionsHash: digest([]),
  intentHash: captureIntentHash([], 7),
  controlPlaneState: 'ready',
  activation: { mode: 'preview', reason: 'awaiting_preview_ack' },
  entries: [],
};
assert.equal(
  captureSnapshotContentHash(goldenSnapshot),
  '4e09130afcb6e81aa8680d559fc487b7aa8a76c1e54bfe090c3de13023d829a3',
);
assert(CAPTURE_PROFILE_CAPABILITIES.probeActions.includes('not_enabled'));
assert.equal(CAPTURE_PROFILE_CAPABILITIES.selectiveFileRead, true);
assert.ok(goldenCanonical.includes('desiredProbeActions'));

const forwarderSource = fs.readFileSync(new URL('./observer-forward.js', import.meta.url), 'utf8');
assert.match(forwarderSource, /ANYSENTRY_CAPTURE_PROFILE_REPORT_TIMEOUT_MS/);
assert.match(forwarderSource, /CAPTURE_PROFILE_REPORT_TIMEOUT_MS,[\s\S]*?CAPTURE_PROFILE_REPORT_RESPONSE_MAX_BYTES,[\s\S]*?false,/u);
assert.match(forwarderSource, /requestAgent === false[\s\S]*?\? false/u);
assert.match(forwarderSource, /function getJson\(url, timeoutMs, done, extraHeaders = \{\}, requestAgent, maxResponseBytes = IDENTITY_SNAPSHOT_MAX_BYTES\)/u);
assert.match(forwarderSource, /infrastructurePolicyTarget,[\s\S]*?X-AnySentry-Management-Token[\s\S]*?false,/u);

console.log('S5 capture profile control verification passed');
