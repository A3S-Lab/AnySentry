#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { RequestMethod } = require('../apps/api/node_modules/@nestjs/common');
const { AgentRuntimeStateService } = require('../apps/api/dist/security-monitoring/agent-runtime-state.service.js');
const { SecurityMonitoringController } = require('../apps/api/dist/security-monitoring/security-monitoring.controller.js');
const { SecurityMonitoringModule } = require('../apps/api/dist/security-monitoring/security-monitoring.module.js');
const root = fileURLToPath(new URL('..', import.meta.url));

let now = 1_780_000_000_000;
const discoveredAt = now - 1_000;
const service = new AgentRuntimeStateService({
  now: () => now,
  maxForwarders: 8,
  maxInstances: 10,
  maxEntriesPerSnapshot: 8,
  terminalTtlMs: 40,
  unobservedTtlMs: 5_000,
  minUnobservedMs: 100,
  unobservedIntervals: 2,
  activityIdleMs: 20,
  pruneIntervalMs: 0,
});

function runtimeEntry(id, state = 'running', overrides = {}) {
  const pid = Number(id.replace(/\D+/g, '')) || 100;
  const lastSeenAt = overrides.lastSeenAt ?? now;
  const base = {
    agentScopeId: 'codex',
    agentDisplayName: 'Codex',
    agentInstanceId: `host-a/boot-a/${id}/${pid * 10}`,
    physicalWorkloadId: `host:host-a:boot-a:root:${id}:${pid * 10}`,
    classification: 'probable_agent',
    runtimeState: state,
    rootPid: pid,
    rootStartTimeTicks: String(pid * 10),
    rootGeneration: 1,
    hostId: 'host-a',
    bootId: 'boot-a',
    comm: 'codex',
    exe: '/usr/bin/codex',
    workspacePath: `/workspace/${id}`,
    discoveredAt: new Date(discoveredAt).toISOString(),
    lastSeenAt: new Date(lastSeenAt).toISOString(),
    lastActivityAt: new Date(overrides.lastActivityAt ?? lastSeenAt).toISOString(),
    confidence: 0.8,
    source: 'process_signature',
    evidence: [`comm_exact:codex:${id}`],
    workloadRef: {
      environment: 'host',
      kind: 'process',
      processName: 'codex',
      executable: '/usr/bin/codex',
    },
  };
  if (state !== 'running') {
    base.endedAt = new Date(overrides.endedAt ?? lastSeenAt).toISOString();
    delete base.lastActivityAt;
  }
  const result = {
    ...base,
    ...overrides,
    discoveredAt: new Date(overrides.discoveredAt ?? discoveredAt).toISOString(),
    lastSeenAt: new Date(lastSeenAt).toISOString(),
  };
  if (state === 'running') {
    result.lastActivityAt = new Date(overrides.lastActivityAt ?? lastSeenAt).toISOString();
  } else {
    result.endedAt = new Date(overrides.endedAt ?? lastSeenAt).toISOString();
    delete result.lastActivityAt;
  }
  return result;
}

function snapshot(forwarder, version, entries, overrides = {}) {
  return {
    schemaVersion: 'anysentry.agent_runtime_snapshot.v1',
    collectorId: 'collector-a',
    forwarderInstanceId: forwarder,
    leaseEpoch: overrides.leaseEpoch ?? 1,
    snapshotVersion: version,
    generatedAt: new Date(now).toISOString(),
    ready: true,
    intervalSecs: 1,
    filterMode: 'shadow',
    registryVersion: 3,
    registryHash: 'a'.repeat(64),
    registryMatcherHash: 'b'.repeat(64),
    entries,
    ...overrides,
  };
}

function leaseRequest(forwarderInstanceId, overrides = {}) {
  return {
    collectorId: 'collector-a',
    forwarderInstanceId,
    hostId: 'host-a',
    bootId: 'boot-a',
    forwarderPid: 10_001,
    forwarderStartTimeTicks: '1000',
    ...overrides,
  };
}

function issueLease(target, forwarderInstanceId, overrides = {}) {
  const ack = target.issueLease(leaseRequest(forwarderInstanceId, overrides));
  assert.equal(ack.accepted, true, ack.reason);
  return ack;
}

const badSchema = service.recordSnapshot({ schemaVersion: 'wrong' });
assert.equal(badSchema.accepted, false);
assert.equal(badSchema.reasonCode, 'validation_error');
assert.match(badSchema.reason, /schemaVersion/u);

const noLease = service.recordSnapshot(snapshot('forwarder-no-lease', 1, []));
assert.equal(noLease.accepted, false);
assert.equal(noLease.reasonCode, 'lease_not_found');

const duplicateEntrySnapshot = snapshot('forwarder-invalid', 1, [runtimeEntry('101'), runtimeEntry('101')]);
const duplicateEntryResult = service.recordSnapshot(duplicateEntrySnapshot);
assert.equal(duplicateEntryResult.accepted, false);
assert.match(duplicateEntryResult.reason, /duplicated/u);

const runningWithEnd = runtimeEntry('102', 'running', { endedAt: new Date(now).toISOString() });
const invalidLifecycle = service.recordSnapshot(snapshot('forwarder-invalid', 2, [runningWithEnd]));
assert.equal(invalidLifecycle.accepted, false);
assert.match(invalidLifecycle.reason, /endedAt is not allowed/u);

const leaseOneRequest = leaseRequest('forwarder-one');
const leaseOne = issueLease(service, 'forwarder-one');
assert.equal(leaseOne.leaseEpoch, 1);
assert.deepEqual(
  service.issueLease(leaseOneRequest),
  leaseOne,
  'a current forwarder may retry lease acquisition idempotently',
);

const roots = [runtimeEntry('101'), runtimeEntry('201'), runtimeEntry('301')];
const pending = snapshot('forwarder-one', 1, roots, { ready: false });
const pendingAck = service.recordSnapshot(pending);
assert.equal(pendingAck.accepted, true);
assert.equal(pendingAck.applied, false);
assert.equal(service.list().total, 0, 'an unready bootstrap snapshot must not become authoritative');

const ready = snapshot('forwarder-one', 2, roots);
const readyAck = service.recordSnapshot(ready);
assert.equal(readyAck.accepted, true);
assert.equal(readyAck.applied, true);
assert.match(readyAck.snapshotHash, /^[a-f0-9]{64}$/u);

let state = service.list();
assert.equal(state.total, 3);
assert.equal(state.summary.runningInstances, 3);
assert.equal(state.summary.activeInstances, 3);
assert.equal(
  new Set(state.items.map((item) => item.agentInstanceId)).size,
  3,
  'same-scope Codex roots remain independent runtime instances',
);
assert.equal(state.items.every((item) => item.agentScopeId === 'codex'), true);
assert.equal(state.items.every((item) => item.leaseEpoch === leaseOne.leaseEpoch), true);
assert.equal(state.items.every((item) => item.registryMatcherHash === 'b'.repeat(64)), true);

// Entry ordering is not semantic: a retry with the same version and reversed roots is idempotent.
const duplicate = service.recordSnapshot({ ...ready, entries: [...ready.entries].reverse() });
assert.equal(duplicate.accepted, true);
assert.equal(duplicate.applied, false);
assert.equal(duplicate.duplicate, true);
assert.equal(duplicate.snapshotHash, readyAck.snapshotHash);

const conflict = service.recordSnapshot({
  ...ready,
  entries: ready.entries.map((entry, index) => index === 0 ? { ...entry, comm: 'changed' } : entry),
});
assert.equal(conflict.accepted, false);
assert.match(conflict.reason, /version conflict/u);

const stale = service.recordSnapshot(snapshot('forwarder-one', 1, roots));
assert.equal(stale.accepted, true);
assert.equal(stale.applied, false);
assert.match(stale.reason, /stale/u);

now += 30;
state = service.list();
assert.equal(state.summary.runningInstances, 3);
assert.equal(state.summary.activeInstances, 0);
assert.equal(state.summary.idleInstances, 3, 'activity becomes idle without changing root liveness');

now += 1_980;
state = service.list();
assert.equal(state.summary.unobservedInstances, 3, 'API derives unobserved after the snapshot deadline');
assert.equal(state.items.every((item) => item.activityState === undefined), true);

const refreshedRoots = roots.map((entry) => ({
  ...entry,
  lastSeenAt: new Date(now).toISOString(),
  lastActivityAt: new Date(now).toISOString(),
}));
const refreshAck = service.recordSnapshot(snapshot('forwarder-one', 3, refreshedRoots));
assert.equal(refreshAck.applied, true);
assert.equal(service.list().summary.runningInstances, 3, 'fresh data restores running after unobserved');

const exitedA = runtimeEntry('101', 'exited', { lastSeenAt: now, endedAt: now, exitCode: 0, rootGeneration: 2 });
const runningB = runtimeEntry('201', 'running', { lastSeenAt: now, lastActivityAt: now });
const runningC = runtimeEntry('301', 'running', { lastSeenAt: now, lastActivityAt: now });
const exitAck = service.recordSnapshot(snapshot('forwarder-one', 4, [exitedA, runningB, runningC]));
assert.equal(exitAck.applied, true, `${exitAck.reasonCode}: ${exitAck.reason}`);
assert.equal(service.get(exitedA.agentInstanceId)?.runtimeState, 'exited');
assert.equal(service.get(runningB.agentInstanceId)?.runtimeState, 'running');

const leaseTwo = issueLease(service, 'forwarder-two', {
  forwarderPid: 10_002,
  forwarderStartTimeTicks: '2000',
});
assert.equal(leaseTwo.leaseEpoch, 2);
const pendingTakeover = service.recordSnapshot(snapshot('forwarder-two', 1, [runningB], {
  leaseEpoch: leaseTwo.leaseEpoch,
  ready: false,
  filterMode: 'enforce',
}));
assert.equal(pendingTakeover.applied, false);
assert.equal(service.get(runningB.agentInstanceId)?.forwarderInstanceId, 'forwarder-one');

const takeover = service.recordSnapshot(snapshot('forwarder-two', 2, [runningB], { leaseEpoch: leaseTwo.leaseEpoch, filterMode: 'enforce' }));
assert.equal(takeover.applied, true);
assert.equal(service.get(runningB.agentInstanceId)?.forwarderInstanceId, 'forwarder-two');
assert.equal(service.get(runningC.agentInstanceId)?.runtimeState, 'lost', 'a takeover ready snapshot is a complete collector view');
assert.equal(service.get(exitedA.agentInstanceId)?.runtimeState, 'exited', 'explicit terminal state remains terminal across takeover');

const supersededWrite = service.recordSnapshot(snapshot('forwarder-one', 5, [runningC]));
assert.equal(supersededWrite.accepted, false);
assert.equal(supersededWrite.reasonCode, 'lease_owner_mismatch');

const missingB = service.recordSnapshot(snapshot('forwarder-two', 3, [], { leaseEpoch: leaseTwo.leaseEpoch, filterMode: 'enforce' }));
assert.equal(missingB.applied, true);
assert.equal(service.get(runningB.agentInstanceId)?.runtimeState, 'lost', 'a missing root in a complete ready snapshot falls back to lost');

const recoveredB = runtimeEntry('201', 'running', { lastSeenAt: now, lastActivityAt: now, rootGeneration: 2 });
assert.equal(
  service.recordSnapshot(snapshot('forwarder-two', 4, [recoveredB], { leaseEpoch: leaseTwo.leaseEpoch, filterMode: 'enforce' })).applied,
  true,
  'a liveness miss may recover before the root identity changes',
);
const exitedB = runtimeEntry('201', 'exited', { lastSeenAt: now, endedAt: now, signal: 15, rootGeneration: 3 });
assert.equal(service.recordSnapshot(snapshot('forwarder-two', 5, [exitedB], { leaseEpoch: leaseTwo.leaseEpoch, filterMode: 'enforce' })).applied, true);
const impossibleResurrection = service.recordSnapshot(snapshot('forwarder-two', 6, [recoveredB], { leaseEpoch: leaseTwo.leaseEpoch, filterMode: 'enforce' }));
assert.equal(impossibleResurrection.accepted, false);
assert.equal(impossibleResurrection.reasonCode, 'terminal_state_conflict');
assert.match(impossibleResurrection.reason, /is terminal/u);

const byPhysical = service.list({ physicalWorkloadId: exitedB.physicalWorkloadId, includeShadow: true });
assert.equal(byPhysical.total, 1);
assert.equal(byPhysical.items[0].agentInstanceId, exitedB.agentInstanceId);
const enforceOnly = service.list({ includeShadow: false });
assert.equal(enforceOnly.items.every((item) => item.filterMode === 'enforce'), true);

const cloned = service.get(exitedB.agentInstanceId);
cloned.evidence.push('caller-mutation');
cloned.workloadRef.processName = 'caller-mutation';
const unchanged = service.get(exitedB.agentInstanceId);
assert.equal(unchanged.evidence.includes('caller-mutation'), false);
assert.equal(unchanged.workloadRef.processName, 'codex');

now += 41;
service.prune();
assert.equal(service.get(exitedA.agentInstanceId), undefined);
assert.equal(service.get(exitedB.agentInstanceId), undefined);
assert.equal(service.metrics().instances <= 10, true);

const bounded = new AgentRuntimeStateService({
  now: () => now,
  maxForwarders: 2,
  maxInstances: 2,
  maxEntriesPerSnapshot: 2,
  pruneIntervalMs: 0,
});
const boundedLease = issueLease(bounded, 'bounded-forwarder', {
  forwarderPid: 20_001,
  forwarderStartTimeTicks: '3000',
});
const tooLarge = bounded.recordSnapshot(snapshot('bounded-forwarder', 1, [
  runtimeEntry('401'),
  runtimeEntry('402'),
  runtimeEntry('403'),
]));
assert.equal(tooLarge.accepted, false);
assert.match(tooLarge.reason, /entries exceeds limit 2/u);
assert.equal(bounded.recordSnapshot(snapshot('bounded-forwarder', 2, [runtimeEntry('401'), runtimeEntry('402')], {
  leaseEpoch: boundedLease.leaseEpoch,
})).applied, true);
assert.equal(bounded.metrics().instances, 2);

// Fencing survives detailed-record/tombstone cleanup, and process start order beats request order.
let fencingNow = now;
const fencing = new AgentRuntimeStateService({
  now: () => fencingNow,
  maxForwarders: 4,
  maxRetiredForwarders: 1,
  pruneIntervalMs: 0,
});
const firstLeaseRequest = leaseRequest('forwarder-new', {
  forwarderPid: 30_001,
  forwarderStartTimeTicks: '2000',
});
const firstLease = fencing.issueLease(firstLeaseRequest);
assert.equal(firstLease.accepted, true);
assert.deepEqual(fencing.issueLease(firstLeaseRequest), firstLease, 'same-process lease retries are idempotent');
const delayedOlder = fencing.issueLease(leaseRequest('forwarder-old-delayed', {
  forwarderPid: 30_000,
  forwarderStartTimeTicks: '1000',
}));
assert.equal(delayedOlder.accepted, false);
assert.equal(delayedOlder.reasonCode, 'stale_forwarder');

const newerLease = issueLease(fencing, 'forwarder-newer', {
  forwarderPid: 30_002,
  forwarderStartTimeTicks: '3000',
});
assert.equal(newerLease.leaseEpoch, 2);
const staleEpoch = fencing.recordSnapshot(snapshot('forwarder-newer', 1, [], { leaseEpoch: 1 }));
assert.equal(staleEpoch.accepted, false);
assert.equal(staleEpoch.reasonCode, 'lease_epoch_stale');
const staleOwner = fencing.recordSnapshot(snapshot('forwarder-new', 1, [], { leaseEpoch: firstLease.leaseEpoch }));
assert.equal(staleOwner.accepted, false);
assert.equal(staleOwner.reasonCode, 'lease_owner_mismatch');

const latestLease = issueLease(fencing, 'forwarder-latest', {
  forwarderPid: 30_003,
  forwarderStartTimeTicks: '4000',
});
assert.equal(latestLease.leaseEpoch, 3);
assert.equal(fencing.metrics().retiredForwarders, 1, 'retired detail tombstones remain bounded');
const oldAfterTombstoneEviction = fencing.issueLease(firstLeaseRequest);
assert.equal(oldAfterTombstoneEviction.accepted, false);
assert.equal(oldAfterTombstoneEviction.reasonCode, 'stale_forwarder');

// A live collector cannot move across hosts; a successful snapshot refreshes the lease TTL.
let crossHostNow = 2_000_000;
const crossHost = new AgentRuntimeStateService({
  now: () => crossHostNow,
  leaseTtlMs: 1_000,
  pruneIntervalMs: 0,
});
const hostALease = issueLease(crossHost, 'forwarder-host-a', {
  hostId: 'host-a',
  bootId: 'boot-a',
  forwarderPid: 31_001,
  forwarderStartTimeTicks: '1000',
});
crossHostNow += 900;
assert.equal(crossHost.recordSnapshot(snapshot('forwarder-host-a', 1, [], {
  leaseEpoch: hostALease.leaseEpoch,
})).applied, true);
crossHostNow += 600;
const freshCrossHostConflict = crossHost.issueLease(leaseRequest('forwarder-host-b', {
  hostId: 'host-b',
  bootId: 'boot-b',
  forwarderPid: 31_002,
  forwarderStartTimeTicks: '5000',
}));
assert.equal(freshCrossHostConflict.accepted, false);
assert.equal(freshCrossHostConflict.reasonCode, 'collector_conflict');
crossHostNow += 300;
const replayedStaleSnapshot = crossHost.recordSnapshot(snapshot('forwarder-host-a', 0, [], {
  leaseEpoch: hostALease.leaseEpoch,
}));
assert.equal(replayedStaleSnapshot.accepted, true);
assert.equal(replayedStaleSnapshot.reasonCode, 'snapshot_version_stale');
crossHostNow += 201;
const expiredCrossHostLease = issueLease(crossHost, 'forwarder-host-b', {
  hostId: 'host-b',
  bootId: 'boot-b',
  forwarderPid: 31_002,
  forwarderStartTimeTicks: '5000',
});
assert.equal(expiredCrossHostLease.leaseEpoch, 2);

// Capacity is checked before mutation: a complete view cannot silently evict an active instance.
let capacityNow = now;
const capacity = new AgentRuntimeStateService({
  now: () => capacityNow,
  maxForwarders: 1,
  maxInstances: 1,
  maxEntriesPerSnapshot: 1,
  pruneIntervalMs: 0,
});
const capacityLease = issueLease(capacity, 'capacity-forwarder', {
  forwarderPid: 32_001,
  forwarderStartTimeTicks: '1000',
});
const capacityRoot = runtimeEntry('501');
assert.equal(capacity.recordSnapshot(snapshot('capacity-forwarder', 1, [capacityRoot], {
  leaseEpoch: capacityLease.leaseEpoch,
})).applied, true);
const overCapacity = capacity.recordSnapshot(snapshot('capacity-forwarder', 2, [runtimeEntry('502')], {
  leaseEpoch: capacityLease.leaseEpoch,
}));
assert.equal(overCapacity.accepted, false);
assert.equal(overCapacity.reasonCode, 'capacity_exceeded');
assert.equal(capacity.get(capacityRoot.agentInstanceId)?.runtimeState, 'running');
assert.equal(capacity.get(capacityRoot.agentInstanceId)?.snapshotVersion, 1);
const collectorCapacity = capacity.issueLease(leaseRequest('capacity-other', {
  collectorId: 'collector-b',
  hostId: 'host-b',
  bootId: 'boot-b',
  forwarderPid: 32_002,
  forwarderStartTimeTicks: '1000',
}));
assert.equal(collectorCapacity.accepted, false);
assert.equal(collectorCapacity.reasonCode, 'capacity_exceeded');

// Fully inactive collectors are eventually reclaimable, preventing lease-table churn exhaustion.
let churnNow = 6_000_000;
const churn = new AgentRuntimeStateService({
  now: () => churnNow,
  maxForwarders: 1,
  unobservedTtlMs: 50,
  pruneIntervalMs: 0,
});
assert.equal(churn.issueLease(leaseRequest('churn-a', {
  collectorId: 'collector-churn-a',
  forwarderPid: 32_101,
  forwarderStartTimeTicks: '1000',
})).accepted, true);
assert.equal(churn.issueLease(leaseRequest('churn-b', {
  collectorId: 'collector-churn-b',
  forwarderPid: 32_102,
  forwarderStartTimeTicks: '1000',
})).reasonCode, 'capacity_exceeded');
churnNow += 51;
const reclaimedLease = churn.issueLease(leaseRequest('churn-b', {
  collectorId: 'collector-churn-b',
  forwarderPid: 32_102,
  forwarderStartTimeTicks: '1000',
}));
assert.equal(reclaimedLease.accepted, true, reclaimedLease.reason);
assert.equal(reclaimedLease.leaseEpoch, 1);

// A ready collector with an empty complete view must not pin the sole forwarder slot forever.
let emptyChurnNow = 7_000_000;
const emptyChurn = new AgentRuntimeStateService({
  now: () => emptyChurnNow,
  maxForwarders: 1,
  unobservedTtlMs: 50,
  pruneIntervalMs: 0,
});
const emptyLease = emptyChurn.issueLease(leaseRequest('empty-churn-a', {
  collectorId: 'collector-empty-a',
  forwarderPid: 32_201,
  forwarderStartTimeTicks: '1000',
}));
assert.equal(emptyLease.accepted, true);
assert.equal(emptyChurn.recordSnapshot(snapshot('empty-churn-a', 1, [], {
  collectorId: 'collector-empty-a',
  leaseEpoch: emptyLease.leaseEpoch,
})).applied, true);
emptyChurnNow += 51;
emptyChurn.prune();
assert.equal(emptyChurn.metrics().forwarders, 0);
assert.equal(emptyChurn.metrics().activeForwarders, 0);
assert.equal(emptyChurn.issueLease(leaseRequest('empty-churn-b', {
  collectorId: 'collector-empty-b',
  hostId: 'host-b',
  bootId: 'boot-b',
  forwarderPid: 32_202,
  forwarderStartTimeTicks: '1000',
})).accepted, true, 'an expired ready-empty collector releases its forwarder and lease capacity');

// Root ProcessKeys are host scoped; a node forwarder cannot publish another host's roots.
const hostBound = new AgentRuntimeStateService({ now: () => now, pruneIntervalMs: 0 });
const hostBoundLease = issueLease(hostBound, 'host-bound-forwarder', {
  forwarderPid: 32_301,
  forwarderStartTimeTicks: '1000',
});
const foreignRoot = runtimeEntry('601', 'running', {
  hostId: 'host-b',
  bootId: 'boot-b',
});
const foreignRootAck = hostBound.recordSnapshot(snapshot('host-bound-forwarder', 1, [foreignRoot], {
  leaseEpoch: hostBoundLease.leaseEpoch,
}));
assert.equal(foreignRootAck.accepted, false);
assert.equal(foreignRootAck.reasonCode, 'identity_conflict');
assert.equal(hostBound.list({ includeShadow: true }).total, 0);

// Relative source-clock ages avoid classifying activity with the API host's wall clock.
let clockNow = 3_000_000;
const clockSafe = new AgentRuntimeStateService({
  now: () => clockNow,
  activityIdleMs: 20,
  minUnobservedMs: 10_000,
  pruneIntervalMs: 0,
});
const clockLease = issueLease(clockSafe, 'clock-forwarder', {
  forwarderPid: 33_001,
  forwarderStartTimeTicks: '1000',
});
const sourceAheadAt = clockNow + 60 * 60_000;
const aheadEntry = runtimeEntry('601', 'running', {
  discoveredAt: sourceAheadAt - 1_000,
  lastSeenAt: sourceAheadAt,
  lastActivityAt: sourceAheadAt - 5,
});
assert.equal(clockSafe.recordSnapshot(snapshot('clock-forwarder', 1, [aheadEntry], {
  leaseEpoch: clockLease.leaseEpoch,
  generatedAt: new Date(sourceAheadAt).toISOString(),
})).applied, true);
clockNow += 10;
assert.equal(clockSafe.get(aheadEntry.agentInstanceId)?.activityState, 'active');
clockNow += 6;
assert.equal(clockSafe.get(aheadEntry.agentInstanceId)?.activityState, 'idle');

// A forwarder NTP rollback is accepted because lease epoch/version, not wall clock, fence writes.
const sourceBehindAt = sourceAheadAt - 2 * 60_000;
const rollbackEntry = runtimeEntry('601', 'running', {
  discoveredAt: sourceAheadAt - 1_000,
  lastSeenAt: sourceBehindAt,
  lastActivityAt: sourceBehindAt - 5,
});
const rollbackAck = clockSafe.recordSnapshot(snapshot('clock-forwarder', 2, [rollbackEntry], {
  leaseEpoch: clockLease.leaseEpoch,
  generatedAt: new Date(sourceBehindAt).toISOString(),
}));
assert.equal(rollbackAck.applied, true, rollbackAck.reason);
assert.equal(clockSafe.get(rollbackEntry.agentInstanceId)?.activityState, 'active');

// Re-reporting the same terminal root cannot extend its retention indefinitely.
let terminalNow = 4_000_000;
const terminalRetention = new AgentRuntimeStateService({
  now: () => terminalNow,
  terminalTtlMs: 40,
  pruneIntervalMs: 0,
});
const terminalLease = issueLease(terminalRetention, 'terminal-forwarder', {
  forwarderPid: 34_001,
  forwarderStartTimeTicks: '1000',
});
const terminalRoot = runtimeEntry('701', 'exited', { rootGeneration: 2 });
assert.equal(terminalRetention.recordSnapshot(snapshot('terminal-forwarder', 1, [terminalRoot], {
  leaseEpoch: terminalLease.leaseEpoch,
})).applied, true);
terminalNow += 30;
assert.equal(terminalRetention.recordSnapshot(snapshot('terminal-forwarder', 2, [terminalRoot], {
  leaseEpoch: terminalLease.leaseEpoch,
})).applied, true);
terminalNow += 11;
assert.equal(terminalRetention.get(terminalRoot.agentInstanceId), undefined);

// Same-owner lifecycle changes require generation advance; process identity is immutable.
let transitionNow = 5_000_000;
const transitions = new AgentRuntimeStateService({ now: () => transitionNow, pruneIntervalMs: 0 });
const transitionLease = issueLease(transitions, 'transition-forwarder', {
  forwarderPid: 35_001,
  forwarderStartTimeTicks: '1000',
});
const transitionRoot = runtimeEntry('801');
assert.equal(transitions.recordSnapshot(snapshot('transition-forwarder', 1, [transitionRoot], {
  leaseEpoch: transitionLease.leaseEpoch,
  filterMode: undefined,
})).applied, true);
assert.equal(transitions.get(transitionRoot.agentInstanceId)?.filterMode, 'shadow');
const noGenerationAdvance = transitions.recordSnapshot(snapshot('transition-forwarder', 2, [{
  ...transitionRoot,
  runtimeState: 'lost',
  endedAt: transitionRoot.lastSeenAt,
}], { leaseEpoch: transitionLease.leaseEpoch }));
assert.equal(noGenerationAdvance.accepted, false);
assert.equal(noGenerationAdvance.reasonCode, 'generation_regression');
const identityConflict = transitions.recordSnapshot(snapshot('transition-forwarder', 2, [{
  ...transitionRoot,
  rootPid: transitionRoot.rootPid + 1,
}], { leaseEpoch: transitionLease.leaseEpoch }));
assert.equal(identityConflict.accepted, false);
assert.equal(identityConflict.reasonCode, 'identity_conflict');
const readyRegression = transitions.recordSnapshot(snapshot('transition-forwarder', 2, [transitionRoot], {
  leaseEpoch: transitionLease.leaseEpoch,
  ready: false,
}));
assert.equal(readyRegression.accepted, false);
assert.equal(readyRegression.reasonCode, 'ready_regression');
const invalidHash = transitions.recordSnapshot(snapshot('transition-forwarder', 2, [transitionRoot], {
  leaseEpoch: transitionLease.leaseEpoch,
  registryMatcherHash: 'not-a-sha256',
}));
assert.equal(invalidHash.accepted, false);
assert.equal(invalidHash.reasonCode, 'validation_error');
const numericStringPid = transitions.recordSnapshot(snapshot('transition-forwarder', 2, [{
  ...transitionRoot,
  rootPid: String(transitionRoot.rootPid),
}], { leaseEpoch: transitionLease.leaseEpoch }));
assert.equal(numericStringPid.accepted, false);
assert.equal(numericStringPid.reasonCode, 'validation_error');
const mismatchedLaunchRoot = {
  ...transitionRoot,
  launchContext: {
    schemaVersion: 'anysentry.agent_launch_context.v1',
    rootProcessGenerationKey: `pgk_${'1'.repeat(24)}`,
    observedAt: new Date(now).toISOString(),
    completeness: 'complete',
    path: [{
      processGenerationKey: `pgk_${'2'.repeat(24)}`,
      pid: transitionRoot.rootPid,
      ppid: 1,
      command: 'codex',
    }],
    origins: [],
  },
};
const mismatchedLaunchContext = transitions.recordSnapshot(snapshot(
  'transition-forwarder',
  2,
  [mismatchedLaunchRoot],
  { leaseEpoch: transitionLease.leaseEpoch },
));
assert.equal(mismatchedLaunchContext.accepted, false);
assert.equal(mismatchedLaunchContext.reasonCode, 'validation_error');

// Durable history keeps exact process generations after hot terminal retention and restores them
// as historical/unobserved state after an API restart.
const durableRows = new Map();
const fakeRelationalStore = {
  configured: () => true,
  loadAgentRuntimeInstances: async () => [...durableRows.values()].map((record) => ({ ...record })),
  saveAgentRuntimeInstances: async (records) => {
    for (const record of records) {
      durableRows.set(record.canonicalAgentInstanceId, structuredClone(record));
    }
    return true;
  },
};
let durableNow = 6_000_000;
now = durableNow;
const durable = new AgentRuntimeStateService({
  now: () => durableNow,
  terminalTtlMs: 40,
  pruneIntervalMs: 0,
  durableHistory: true,
}, fakeRelationalStore);
await durable.onModuleInit();
const durableLease = issueLease(durable, 'durable-forwarder', {
  forwarderPid: 36_001,
  forwarderStartTimeTicks: '1000',
});
const durableRoot = runtimeEntry('901', 'exited', {
  rootGeneration: 2,
  launchContext: {
    schemaVersion: 'anysentry.agent_launch_context.v1',
    rootProcessGenerationKey: `pgk_${'a'.repeat(24)}`,
    observedAt: new Date(durableNow - 20).toISOString(),
    completeness: 'complete',
    path: [
      { processGenerationKey: `pgk_${'b'.repeat(24)}`, pid: 1, ppid: 0, command: 'systemd' },
      { processGenerationKey: `pgk_${'c'.repeat(24)}`, pid: 200, ppid: 1, command: 'sshd' },
      {
        processGenerationKey: `pgk_${'a'.repeat(24)}`,
        pid: Number('901'),
        ppid: 200,
        command: 'codex',
        exe: '/usr/bin/codex',
      },
    ],
    origins: [
      { type: 'service_manager', processGenerationKey: `pgk_${'b'.repeat(24)}`, pid: 1, name: 'systemd' },
      {
        type: 'ssh_session',
        processGenerationKey: `pgk_${'c'.repeat(24)}`,
        pid: 200,
        name: 'sshd',
        remoteAddress: '203.0.113.8',
        remotePort: 52144,
        localAddress: '10.0.0.5',
        localPort: 22,
        tty: '/dev/pts/7',
        terminalSession: 'tmux',
      },
    ],
  },
});
assert.equal(durable.recordSnapshot(snapshot('durable-forwarder', 1, [durableRoot], {
  leaseEpoch: durableLease.leaseEpoch,
})).applied, true);
const canonicalDurableId = `host-root:${durableRoot.hostId}:${durableRoot.bootId}:${durableRoot.rootPid}:${durableRoot.rootStartTimeTicks}`;
assert.equal(durable.get(durableRoot.agentInstanceId)?.canonicalAgentInstanceId, canonicalDurableId);
assert.deepEqual(
  durable.get(durableRoot.agentInstanceId)?.launchContext?.path.map((node) => node.command),
  ['systemd', 'sshd', 'codex'],
);
assert.equal(
  durable.get(durableRoot.agentInstanceId)?.agentInstanceAliases.includes(durableRoot.physicalWorkloadId),
  false,
  'a physical workload is a placement relation, not a one-to-one Runtime alias',
);
durableNow += 41;
durable.prune();
assert.equal(durable.get(durableRoot.agentInstanceId)?.runtimeState, 'exited',
  'durable terminal history must survive hot-state pruning');
await new Promise((resolve) => setImmediate(resolve));
assert.equal(durableRows.has(canonicalDurableId), true);

const restored = new AgentRuntimeStateService({
  now: () => durableNow,
  pruneIntervalMs: 0,
  durableHistory: true,
}, fakeRelationalStore);
await restored.onModuleInit();
assert.equal(restored.get(canonicalDurableId)?.runtimeState, 'exited');
assert.equal(restored.get(durableRoot.agentInstanceId)?.canonicalAgentInstanceId, canonicalDurableId,
  'a persisted strong alias must resolve to the canonical Runtime after API restart');
assert.deepEqual(
  restored.get(durableRoot.agentInstanceId)?.launchContext?.origins.map((origin) => origin.type),
  ['service_manager', 'ssh_session'],
  'Launch Context must survive durable Runtime history and API restart',
);
assert.equal(
  restored.get(durableRoot.agentInstanceId)?.launchContext?.origins
    .find((origin) => origin.type === 'ssh_session')?.terminalSession,
  'tmux',
);
restored.close();
durable.close();

const typesSource = readFileSync(`${root}/apps/api/src/security-monitoring/types.ts`, 'utf8');
assert.match(
  typesSource,
  /export type AgentHealthState = 'active' \| 'idle' \| 'stale' \| 'risky';/u,
  'event-derived AgentHealthState contract remains unchanged',
);

const runtimeProviders = Reflect.getMetadata('providers', SecurityMonitoringModule) ?? [];
assert.equal(
  runtimeProviders.includes(AgentRuntimeStateService),
  true,
  'the security-monitoring module owns one injectable runtime state service',
);

const controllerPrototype = SecurityMonitoringController.prototype;
assert.equal(Reflect.getMetadata('path', SecurityMonitoringController), 'security-center');
assert.equal(Reflect.getMetadata('path', controllerPrototype.issueAgentRuntimeLease), 'runtime/lease');
assert.equal(Reflect.getMetadata('path', controllerPrototype.ingestAgentRuntimeSnapshot), 'runtime/snapshot');
assert.equal(Reflect.getMetadata('path', controllerPrototype.agentRuntimeInstances), 'runtime/instances');
assert.equal(Reflect.getMetadata('path', controllerPrototype.agentRuntimeSummary), 'runtime/summary');
assert.equal(Reflect.getMetadata('method', controllerPrototype.issueAgentRuntimeLease), RequestMethod.POST);
assert.equal(Reflect.getMetadata('method', controllerPrototype.ingestAgentRuntimeSnapshot), RequestMethod.POST);
assert.equal(Reflect.getMetadata('method', controllerPrototype.agentRuntimeInstances), RequestMethod.POST);
assert.equal(Reflect.getMetadata('method', controllerPrototype.agentRuntimeSummary), RequestMethod.POST);
assert.equal(
  Reflect.getMetadata('skipWrap', controllerPrototype.issueAgentRuntimeLease),
  true,
  'the forwarder receives the lease ACK directly',
);
assert.equal(
  Reflect.getMetadata('skipWrap', controllerPrototype.ingestAgentRuntimeSnapshot),
  true,
  'the forwarder receives the version/hash ACK directly',
);

const endpointService = new AgentRuntimeStateService({ now: () => now, pruneIntervalMs: 0 });
const endpointController = Object.create(controllerPrototype);
Object.defineProperty(endpointController, 'agentRuntimeState', { value: endpointService });
const resolvedSource = { sourceId: 'source-runtime', collectorId: 'collector-a' };
const resolveCalls = [];
Object.defineProperty(endpointController, 'sources', {
  value: {
    resolve(input) {
      resolveCalls.push(input);
      return { accepted: true, source: resolvedSource };
    },
    recordAccepted() {
      throw new Error('runtime control writes must not count as source heartbeats');
    },
  },
});
let pipelineAccesses = 0;
for (const property of ['judge', 'agg']) {
  Object.defineProperty(endpointController, property, {
    get() {
      pipelineAccesses += 1;
      throw new Error(`runtime snapshot must not access ${property}`);
    },
  });
}
const endpointHeaders = {
  'x-anysentry-source-id': 'source-runtime',
  'x-anysentry-ingest-token': 'runtime-token',
};
const endpointLease = endpointController.issueAgentRuntimeLease(
  leaseRequest('forwarder-endpoint', {
    forwarderPid: 40_001,
    forwarderStartTimeTicks: '1000',
  }),
  endpointHeaders,
);
assert.equal(endpointLease.accepted, true, endpointLease.reason);
const endpointEntry = runtimeEntry('901');
const endpointAck = endpointController.ingestAgentRuntimeSnapshot(
  snapshot('forwarder-endpoint', 1, [endpointEntry], { leaseEpoch: endpointLease.leaseEpoch }),
  endpointHeaders,
);
assert.equal(endpointAck.applied, true);
const endpointList = endpointController.agentRuntimeInstances({ includeShadow: true });
assert.equal(endpointList.total, 1);
assert.equal(endpointList.items[0].agentInstanceId, endpointEntry.agentInstanceId);
const endpointSummary = endpointController.agentRuntimeSummary({ includeShadow: true });
assert.equal(endpointSummary.summary.runningInstances, 1);
assert.equal(typeof endpointSummary.updateTime, 'string');
assert.equal(
  pipelineAccesses,
  0,
  'snapshot/list/summary handlers stay outside accept, judge, aggregation, and L1',
);
assert.equal(resolveCalls.length, 2);
assert.deepEqual(resolveCalls[0], {
  sourceId: 'source-runtime',
  token: 'runtime-token',
  collectorId: 'collector-a',
  type: 'forwarder',
});

// Authentication and collector-binding failures are structured business ACKs and create no lease.
function rejectedEndpointController(resolution) {
  const runtime = new AgentRuntimeStateService({ now: () => now, pruneIntervalMs: 0 });
  const controller = Object.create(controllerPrototype);
  let rejected = 0;
  Object.defineProperty(controller, 'agentRuntimeState', { value: runtime });
  Object.defineProperty(controller, 'sources', {
    value: {
      resolve: () => resolution,
      recordRejected: () => { rejected += 1; },
    },
  });
  Object.defineProperty(controller, 'alerting', {
    value: { observeSourceRejection: () => undefined },
  });
  return { controller, runtime, rejected: () => rejected };
}

const deniedEndpoint = rejectedEndpointController({
  accepted: false,
  reason: 'invalid source token',
  source: resolvedSource,
});
const deniedLease = deniedEndpoint.controller.issueAgentRuntimeLease(
  leaseRequest('denied-forwarder'),
  endpointHeaders,
);
assert.equal(deniedLease.accepted, false);
assert.equal(deniedLease.reasonCode, 'source_rejected');
assert.equal(deniedEndpoint.rejected(), 1);
assert.equal(
  deniedEndpoint.runtime.recordSnapshot(snapshot('denied-forwarder', 1, [])).reasonCode,
  'lease_not_found',
);
deniedEndpoint.runtime.close();

const mismatchedEndpoint = rejectedEndpointController({
  accepted: true,
  source: { sourceId: 'source-other', collectorId: 'collector-other' },
});
const mismatchedLease = mismatchedEndpoint.controller.issueAgentRuntimeLease(
  leaseRequest('mismatched-forwarder'),
  endpointHeaders,
);
assert.equal(mismatchedLease.accepted, false);
assert.equal(mismatchedLease.reasonCode, 'collector_conflict');
assert.equal(mismatchedEndpoint.rejected(), 1);
mismatchedEndpoint.runtime.close();

const controllerSource = readFileSync(`${root}/apps/api/src/security-monitoring/security-monitoring.controller.ts`, 'utf8');
const runtimeControlStart = controllerSource.indexOf("@Post('runtime/lease')");
const runtimeQueryStart = controllerSource.indexOf("@Post('runtime/instances')");
assert.equal(runtimeControlStart >= 0 && runtimeQueryStart > runtimeControlStart, true);
const runtimeControlHandlers = controllerSource.slice(runtimeControlStart, runtimeQueryStart);
assert.match(runtimeControlHandlers, /this\.sources\.resolve\(/u);
assert.match(runtimeControlHandlers, /this\.agentRuntimeState\.issueLease\(body\)/u);
assert.match(runtimeControlHandlers, /this\.agentRuntimeState\.recordSnapshot\(body\)/u);
assert.doesNotMatch(runtimeControlHandlers, /this\.(?:judge|agg)\b|\.accept\(|sources\.recordAccepted/u);

const judgeSource = readFileSync(`${root}/apps/api/src/security-monitoring/sentry-judge.service.ts`, 'utf8');
for (const field of [
  'runtimeLeaseEpoch',
  'runtimeLeaseAttempts',
  'runtimeLeaseErrors',
  'runtimeLeaseFenced',
  'runtimeSnapshotRejected',
  'runtimeSnapshotDuplicates',
  'lastRuntimeSnapshotError',
  'processRootsRecovered',
]) {
  assert.match(typesSource, new RegExp(`\\b${field}\\??:`, 'u'), `${field} is part of the heartbeat type`);
  assert.match(judgeSource, new RegExp(`\\b${field}:`, 'u'), `${field} is sanitized into heartbeat state`);
}
endpointService.close();

bounded.close();
const closedResult = bounded.recordSnapshot(snapshot('bounded-forwarder', 3, []));
assert.equal(closedResult.accepted, false);
assert.equal(closedResult.reasonCode, 'service_unavailable');
assert.match(closedResult.reason, /closed/u);
const closedLease = bounded.issueLease(leaseRequest('closed-forwarder'));
assert.equal(closedLease.accepted, false);
assert.equal(closedLease.reasonCode, 'service_unavailable');
fencing.close();
crossHost.close();
capacity.close();
clockSafe.close();
terminalRetention.close();
transitions.close();
churn.close();
emptyChurn.close();
hostBound.close();
service.close();

console.log('Agent runtime state lifecycle, bounds, idempotency, and takeover verification passed');
