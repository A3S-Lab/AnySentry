#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  ObservedAssetCoreError,
  ObservedAssetLifecycleCore,
  stableSubjectAssetId,
} = require('../apps/api/dist/security-monitoring/observed-asset-lifecycle.service.js');

let now = Date.parse('2026-08-22T00:00:00.000Z');
const core = new ObservedAssetLifecycleCore({
  now: () => now,
  maxAssets: 100,
  maxVersionsPerAsset: 16,
  maxFactsPerAsset: 64,
  maxCoverageIntervalsPerScope: 16,
});

assert.notEqual(
  stableSubjectAssetId('service', { workspaceId: 'workspace-a', clusterId: 'cluster-a' }, 'orders/api'),
  stableSubjectAssetId('service', { workspaceId: 'workspace-b', clusterId: 'cluster-a' }, 'orders/api'),
  'tenant/workspace scope is part of a generated canonical asset identity',
);

const clickhouseId = 'service:k8s:cluster-a:anysentry:clickhouse';
const piId = 'agent_pi_asset';
core.reconcileKubeServices([{
  serviceAssetId: clickhouseId,
  name: 'clickhouse',
  namespace: 'anysentry',
  clusterId: 'cluster-a',
  kind: 'database',
  role: 'anysentry_internal',
  ownerKind: 'StatefulSet',
  ownerName: 'clickhouse',
  revision: 'revision-1',
  physicalWorkloadIds: ['k8s:cluster-a:pod-clickhouse-1'],
  runtimeInstanceIds: ['container-clickhouse-1'],
  observedAt: now,
  replicas: { observed: 1, ready: 1 },
}]);
core.reconcileAgentAssets([{
  agentAssetId: piId,
  agentId: 'pi',
  displayName: 'Pi Agent',
  classification: 'confirmed_agent',
  detectedClassification: 'confirmed_agent',
  workspacePath: '/workspace/pi',
  runtime: 'kubernetes',
  physicalWorkloadId: 'k8s:cluster-a:pod-clickhouse-1:container-pi-1',
  agentInstanceId: 'container-pi-1',
  firstSeen: now - 60_000,
  lastSeen: now,
  lifecycleState: 'current',
  eventCount: 2,
  eventCategoryCounts: { tool: 2 },
  attributionSource: 'agent_adapter',
  attributionEvidence: ['authenticated-adapter'],
}]);

const clickhouse = core.getAsset(clickhouseId);
assert(clickhouse, 'Kubernetes Service Asset enters the unified read model');
assert.equal(clickhouse.asset.subjectAssetType, 'service');
assert.equal(clickhouse.asset.identity.classification, 'unknown', 'service role does not force a negative Agent identity');
assert.equal(clickhouse.asset.role.role, 'anysentry_internal');
assert.equal(clickhouse.asset.observationState, 'aggregate');
assert.equal(clickhouse.asset.runtimeSummary.current, 1);
assert.equal(clickhouse.bindings[0].quality, 'exact');

const pi = core.getAsset(piId);
assert(pi);
assert.equal(pi.asset.subjectAssetType, 'agent');
assert.equal(pi.asset.identity.classification, 'confirmed_agent');
assert.equal(pi.asset.observationState, 'full');
assert.equal(pi.asset.runtimeSummary.current, 1);

const initialClickhouseBindings = clickhouse.bindings.length;
const initialClickhouseFacts = clickhouse.lifecycleFacts.length;
now += 5_000;
core.reconcileKubeServices([{
  serviceAssetId: clickhouseId,
  name: 'clickhouse', namespace: 'anysentry', clusterId: 'cluster-a', kind: 'database',
  role: 'anysentry_internal', ownerKind: 'StatefulSet', ownerName: 'clickhouse', revision: 'revision-1',
  physicalWorkloadIds: ['k8s:cluster-a:pod-clickhouse-1'], runtimeInstanceIds: ['container-clickhouse-1'],
  observedAt: now, replicas: { observed: 1, ready: 1 },
}]);
assert.equal(core.getAsset(clickhouseId).bindings.length, initialClickhouseBindings, 'inventory refresh does not create duplicate bindings');
assert.equal(core.getAsset(clickhouseId).lifecycleFacts.length, initialClickhouseFacts, 'inventory TTL refresh is not a lifecycle fact');

now += 1_000;
const eventBindings = core.observeEvents([
  {
    eventId: 'capture-clickhouse', at: now, eventKind: 'CaptureAggregate',
    physicalWorkloadId: 'k8s:cluster-a:pod-clickhouse-1',
  },
  { eventId: 'pi-tool', at: now, eventKind: 'AgentTool', agentAssetId: piId },
  {
    eventId: 'clickhouse-file', at: now, eventKind: 'FileAccess',
    agentAssetId: piId,
    physicalWorkloadId: 'k8s:cluster-a:pod-clickhouse-1:container-pi-1',
    identityClassification: 'unknown', workloadRole: 'anysentry_internal',
  },
  {
    eventId: 'short-cat', at: now, eventKind: 'ProcessExit',
    processInstanceKey: 'host-a:boot-a:pid-42:start-100', displayName: 'cat',
    scope: { hostId: 'host-a' },
  },
  { eventId: 'unassigned', at: now, eventKind: 'FileAccess' },
]);
assert.equal(eventBindings[0].subjectAssetId, clickhouseId, 'CaptureAggregate resolves through physical workload binding');
assert.equal(eventBindings[1].subjectAssetId, piId);
assert.equal(eventBindings[2].subjectAssetId, clickhouseId, 'ordinary Service evidence is not replaced by a shared Agent asset');
assert.equal(eventBindings[3].subjectAssetType, 'ephemeral_process');
assert.equal(eventBindings[3].assetBindingQuality, 'ephemeral');
assert.equal(eventBindings[4].assetBindingQuality, 'unassigned');
assert.equal(eventBindings[4].assetBindingRevision, 0);
const clickhouseAfterEvent = core.getAsset(clickhouseId);
assert.equal(clickhouseAfterEvent.asset.eventSummary.eventCount, 2);
assert.equal(clickhouseAfterEvent.asset.eventSummary.eventKindCounts.CaptureAggregate, 1);
assert.equal('events' in clickhouseAfterEvent, false, 'core stores aggregate event facts, not per-event detail');

// Event silence must not become a Runtime exit or Asset lifecycle transition.
now += 10 * 60_000;
const stillRunning = core.getAsset(clickhouseId);
assert.equal(stillRunning.asset.existenceState, 'active');
assert.equal(stillRunning.runtimes[0].state, 'current');

now += 1_000;
core.reconcileKubeServices([{
  serviceAssetId: clickhouseId,
  name: 'clickhouse', namespace: 'anysentry', clusterId: 'cluster-a', kind: 'database',
  role: 'anysentry_internal', ownerKind: 'StatefulSet', ownerName: 'clickhouse', revision: 'revision-2',
  physicalWorkloadIds: ['k8s:cluster-a:pod-clickhouse-2'], runtimeInstanceIds: ['container-clickhouse-2'],
  observedAt: now, replicas: { observed: 1, ready: 1 },
}]);
const rolledRuntime = core.getAsset(clickhouseId);
assert.equal(rolledRuntime.runtimes.find((runtime) => runtime.runtimeInstanceId === 'container-clickhouse-1')?.state, 'lost');
assert.equal(rolledRuntime.runtimes.find((runtime) => runtime.runtimeInstanceId === 'container-clickhouse-2')?.state, 'current');
assert.equal(rolledRuntime.asset.existenceState, 'active', 'Runtime replacement does not retire the logical Service Asset');
assert.equal(
  rolledRuntime.lifecycleFacts.filter((fact) => fact.factKind === 'runtime_lost').length,
  1,
  'Inventory generation replacement creates one explicit low-frequency lost fact',
);
const lostFactsBeforeReplay = rolledRuntime.lifecycleFacts.length;
core.upsertRuntime({
  runtimeInstanceId: 'container-clickhouse-1', subjectAssetId: clickhouseId, placement: 'kubernetes',
  state: 'current', observedAt: now + 1_000, source: 'stale_inventory_replay', reasonCode: 'stale_replay',
});
assert.equal(core.getAsset(clickhouseId).runtimes.find((runtime) => runtime.runtimeInstanceId === 'container-clickhouse-1')?.state, 'current',
  'a newer trusted inventory snapshot can recover a transiently lost generation');
assert.equal(core.getAsset(clickhouseId).lifecycleFacts.length, lostFactsBeforeReplay + 1);
core.upsertRuntime({
  runtimeInstanceId: 'container-clickhouse-1', subjectAssetId: clickhouseId, placement: 'kubernetes',
  state: 'exited', observedAt: now + 2_000, endedAt: now + 2_000,
  source: 'exact_container_exit', reasonCode: 'exact_container_exit',
});
const exitedFactCount = core.getAsset(clickhouseId).lifecycleFacts.length;
core.upsertRuntime({
  runtimeInstanceId: 'container-clickhouse-1', subjectAssetId: clickhouseId, placement: 'kubernetes',
  state: 'current', observedAt: now + 3_000, source: 'stale_inventory_replay', reasonCode: 'stale_replay',
});
assert.equal(core.getAsset(clickhouseId).runtimes.find((runtime) => runtime.runtimeInstanceId === 'container-clickhouse-1')?.state, 'exited');
assert.equal(core.getAsset(clickhouseId).lifecycleFacts.length, exitedFactCount,
  'an exact Exit remains terminal for the same immutable generation');

const aggregateCoverage = {
  exec: 'structural', exit: 'structural', security: 'full',
  file: 'aggregate', network: 'aggregate', llm: 'sample',
};
const firstCoverage = core.activateCoverage({
  subjectAssetId: clickhouseId,
  runtimeInstanceId: 'container-clickhouse-1',
  effectiveAt: now,
  confirmedAt: now,
  captureProfile: 'infrastructure_aggregate',
  capturePolicyVersion: 7,
  captureEpoch: '7001',
  signalCoverage: aggregateCoverage,
  completeness: 'bounded',
  observationState: 'aggregate',
  reasonCode: 'infrastructure_rule',
  ruleRefs: ['rule-clickhouse:3'],
});
const coverageFactCount = core.getAsset(clickhouseId).lifecycleFacts.length;
now += 60_000;
const refreshedCoverage = core.activateCoverage({
  subjectAssetId: clickhouseId,
  runtimeInstanceId: 'container-clickhouse-1',
  effectiveAt: now,
  confirmedAt: now,
  captureProfile: 'infrastructure_aggregate',
  capturePolicyVersion: 7,
  captureEpoch: '7002',
  signalCoverage: aggregateCoverage,
  completeness: 'bounded',
  observationState: 'aggregate',
  reasonCode: 'infrastructure_rule',
  ruleRefs: ['rule-clickhouse:3'],
});
assert.equal(refreshedCoverage.intervalId, firstCoverage.intervalId, 'TTL/epoch refresh reuses the semantic coverage interval');
assert.equal(refreshedCoverage.latestCaptureEpoch, '7002');
assert.equal(core.getAsset(clickhouseId).observationCoverage.length, 1);
assert.equal(core.getAsset(clickhouseId).lifecycleFacts.length, coverageFactCount, 'TTL refresh does not create lifecycle history');

now += 1_000;
core.activateCoverage({
  subjectAssetId: clickhouseId,
  runtimeInstanceId: 'container-clickhouse-1',
  effectiveAt: now,
  confirmedAt: now,
  captureProfile: 'unknown_discovery',
  capturePolicyVersion: 8,
  captureEpoch: '7003',
  signalCoverage: {
    exec: 'structural', exit: 'structural', security: 'full',
    file: 'unknown', network: 'unknown', llm: 'unknown',
  },
  completeness: 'gap',
  observationState: 'gap',
  reasonCode: 'control_plane_unavailable',
  ruleRefs: [],
});
const coverageAfterGap = core.getAsset(clickhouseId).observationCoverage;
assert.equal(coverageAfterGap.length, 2);
assert.equal(coverageAfterGap[0].state, 'closed');
assert.equal(coverageAfterGap[1].state, 'active');
assert.equal(core.getAsset(clickhouseId).asset.observationState, 'gap');
assert.equal(core.getAsset(clickhouseId).asset.subjectAssetId, clickhouseId, 'coverage changes never replace the canonical asset');

// Keyset pagination is frozen to one model revision and ordered by immutable subjectAssetId.
for (const id of ['asset-workload-a', 'asset-workload-m', 'asset-workload-z']) {
  now += 1;
  core.upsertAsset({
    subjectAssetId: id,
    subjectAssetType: 'workload',
    logicalIdentity: id,
    displayName: id,
    existenceState: 'active',
    identity: 'unknown',
    role: 'ordinary_process',
    source: 'unit_test_inventory',
    observedAt: now,
  });
}
const expectedSnapshotIds = core.listAssets({ limit: 100 }).items.map((item) => item.subjectAssetId);
const firstPage = core.listAssets({ limit: 2 });
assert(firstPage.nextCursor);
const snapshotRevision = firstPage.snapshotRevision;

const pageTwoCandidate = expectedSnapshotIds.find((id) => !firstPage.items.some((item) => item.subjectAssetId === id));
assert(pageTwoCandidate);
const oldCandidate = core.getAsset(pageTwoCandidate).asset;
now += 1;
core.upsertAsset({
  subjectAssetId: oldCandidate.subjectAssetId,
  subjectAssetType: oldCandidate.subjectAssetType,
  logicalIdentity: oldCandidate.logicalIdentityHash,
  displayName: `${oldCandidate.displayName} changed after page one`,
  scope: oldCandidate.scope,
  existenceState: oldCandidate.existenceState,
  identity: oldCandidate.identity.classification,
  role: oldCandidate.role.role,
  source: 'unit_test_inventory',
  observedAt: now,
});
core.upsertAsset({
  subjectAssetId: 'asset-created-after-snapshot',
  subjectAssetType: 'workload',
  logicalIdentity: 'created-after-snapshot',
  displayName: 'created after snapshot',
  existenceState: 'active',
  identity: 'unknown',
  role: 'ordinary_process',
  source: 'unit_test_inventory',
  observedAt: now,
});

const pagedIds = [...firstPage.items.map((item) => item.subjectAssetId)];
let cursor = firstPage.nextCursor;
while (cursor) {
  const page = core.listAssets({ limit: 2, cursor });
  assert.equal(page.snapshotRevision, snapshotRevision);
  pagedIds.push(...page.items.map((item) => item.subjectAssetId));
  cursor = page.nextCursor;
}
assert.deepEqual(pagedIds, expectedSnapshotIds, 'updates and inserts between pages cause no duplicates or omissions');
assert.equal(pagedIds.includes('asset-created-after-snapshot'), false);
assert.throws(
  () => core.listAssets({ limit: 2, cursor: firstPage.nextCursor, role: 'agent' }),
  (error) => error instanceof ObservedAssetCoreError && error.code === 'invalid_cursor',
  'a cursor cannot be replayed under different filters',
);

const summary = core.summary();
assert(summary.totalAssets >= expectedSnapshotIds.length + 1);
assert.equal(summary.byType.agent, 1);
assert.equal(summary.byType.service, 1);
assert.equal(summary.unassignedEvents, 1);
assert.equal(summary.byObservation.gap, 1);
assert(summary.totalEvents >= 5);

const durableState = core.stateDocument();
const restored = new ObservedAssetLifecycleCore({ now: () => now });
assert.equal(restored.restoreState(durableState), true);
assert.equal(restored.getAsset(clickhouseId)?.asset.subjectAssetId, clickhouseId);
assert.equal(restored.getAsset(clickhouseId)?.observationCoverage.length, coverageAfterGap.length);
assert.equal(restored.getAsset(clickhouseId)?.lifecycleFacts.length, core.getAsset(clickhouseId).lifecycleFacts.length);
assert.equal(restored.bindingRevision(), core.bindingRevision());
assert.equal(restored.summary().byType.service, 1);

// Capacity eviction is an atomic cascade. No bounded map or reverse index may retain a deleted
// ephemeral Process Asset, because an old ProcessKey would otherwise resolve to a missing asset
// and fail later inside mergeEventAggregate/requireAsset.
let churnNow = Date.parse('2026-08-22T03:00:00.000Z');
const churn = new ObservedAssetLifecycleCore({
  now: () => churnNow,
  maxAssets: 2,
  maxVersionsPerAsset: 2,
  maxFactsPerAsset: 8,
  maxCoverageIntervalsPerScope: 4,
  maxBindingsPerAsset: 2,
  maxRuntimesPerAsset: 1,
});
const stableWorkloadId = 'asset-workload-capacity-anchor';
churn.upsertAsset({
  subjectAssetId: stableWorkloadId,
  subjectAssetType: 'workload',
  logicalIdentity: stableWorkloadId,
  displayName: 'capacity anchor',
  existenceState: 'active',
  identity: 'unknown',
  role: 'ordinary_process',
  source: 'capacity_test_inventory',
  observedAt: churnNow,
});
const stablePersistenceRevision = churn.persistentRevision();
const oldProcessKey = 'pri_capacity_old_process';
const oldPhysicalWorkloadId = 'docker:capacity:old-process';
const oldProcessAssetId = stableSubjectAssetId(
  'ephemeral_process',
  { hostId: 'host-capacity' },
  oldProcessKey,
);
churnNow += 1;
churn.upsertAsset({
  subjectAssetId: oldProcessAssetId,
  subjectAssetType: 'ephemeral_process',
  logicalIdentity: oldProcessKey,
  displayName: 'old short process',
  scope: { hostId: 'host-capacity' },
  existenceState: 'inactive',
  identity: 'unknown',
  role: 'ordinary_process',
  source: 'capacity_test_process',
  observedAt: churnNow,
  inventoryObserved: false,
  observationState: 'structural',
});
churn.upsertBinding({
  subjectAssetId: oldProcessAssetId,
  runtimeInstanceId: oldProcessKey,
  quality: 'ephemeral',
  physicalWorkloadId: oldPhysicalWorkloadId,
  processInstanceKey: oldProcessKey,
  source: 'capacity_test_process',
  effectiveAt: churnNow,
});
churn.upsertRuntime({
  runtimeInstanceId: oldProcessKey,
  subjectAssetId: oldProcessAssetId,
  placement: 'process',
  state: 'exited',
  physicalWorkloadId: oldPhysicalWorkloadId,
  processInstanceKey: oldProcessKey,
  observedAt: churnNow,
  endedAt: churnNow,
  source: 'capacity_test_process',
});
churn.activateCoverage({
  subjectAssetId: oldProcessAssetId,
  runtimeInstanceId: oldProcessKey,
  effectiveAt: churnNow,
  confirmedAt: churnNow,
  captureProfile: 'unknown_discovery',
  capturePolicyVersion: 1,
  captureEpoch: '1',
  signalCoverage: {
    exec: 'structural', exit: 'structural', security: 'full',
    file: 'sample', network: 'sample', llm: 'sample',
  },
  completeness: 'bounded',
  observationState: 'structural',
  reasonCode: 'capacity_test_process',
});
churn.applyLifecycleFact({
  factKind: 'asset_inactivated',
  subjectAssetId: oldProcessAssetId,
  effectiveAt: churnNow,
  observedAt: churnNow,
  source: 'capacity_test_process',
  dedupeKey: 'repeat-after-eviction',
});
assert.equal(
  churn.persistentRevision(),
  stablePersistenceRevision,
  'ephemeral Process Asset churn does not schedule a full logical-state persistence write',
);
assert.deepEqual(
  churn.stateDocument().assets.map((asset) => asset.subjectAssetId),
  [stableWorkloadId],
  'the production durable mirror excludes ephemeral Process Assets by default',
);
assert.equal(churn.stateDocument(1).truncated, false,
  'excluded ephemeral Process Assets do not make the logical snapshot look truncated');
assert.equal(churn.stateDocument(1, { includeEphemeral: true }).truncated, true,
  'the explicit test/debug mirror still reports actual truncation when ephemeral assets are included');

churnNow += 1;
churn.upsertAsset({
  subjectAssetId: 'asset_process_capacity_replacement',
  subjectAssetType: 'ephemeral_process',
  logicalIdentity: 'replacement-process',
  displayName: 'replacement short process',
  scope: { hostId: 'host-capacity' },
  existenceState: 'inactive',
  identity: 'unknown',
  role: 'ordinary_process',
  source: 'capacity_test_process',
  observedAt: churnNow,
  inventoryObserved: false,
});
assert.equal(churn.getAsset(oldProcessAssetId), undefined, 'the oldest inactive ephemeral asset is evicted');
const afterEviction = churn.stateDocument(10, { includeEphemeral: true });
for (const collection of [
  afterEviction.runtimes,
  afterEviction.bindings,
  afterEviction.lifecycleFacts,
  afterEviction.coverageIntervals,
]) {
  assert.equal(collection.some((item) => item.subjectAssetId === oldProcessAssetId), false,
    'durable/debug child collections contain no reference to the evicted asset');
}

const internal = churn;
assert(internal.assets.size <= 2);
assert(internal.assetVersions.size <= internal.assets.size);
assert(internal.createdRevision.size <= internal.assets.size);
assert(internal.runtimes.size <= internal.assets.size);
assert(internal.runtimeKeysByAsset.size <= internal.assets.size);
assert(internal.bindings.size <= internal.assets.size);
assert(internal.lifecycleFacts.size <= internal.assets.size);
assert(internal.factRevisions.size <= internal.assets.size);
assert(internal.coverageIntervals.size <= internal.assets.size * 2);
assert(internal.coverageKeysByAsset.size <= internal.assets.size);
for (const runtime of internal.runtimes.values()) assert(internal.assets.has(runtime.subjectAssetId));
for (const [assetId, keys] of internal.runtimeKeysByAsset) {
  assert(internal.assets.has(assetId));
  for (const key of keys) assert(internal.runtimes.get(key)?.subjectAssetId === assetId);
}
for (const bindings of internal.bindings.values()) {
  for (const binding of bindings) assert(internal.assets.has(binding.subjectAssetId));
}
for (const intervals of internal.coverageIntervals.values()) {
  for (const interval of intervals) assert(internal.assets.has(interval.subjectAssetId));
}
for (const [assetId, keys] of internal.coverageKeysByAsset) {
  assert(internal.assets.has(assetId));
  for (const key of keys) {
    assert((internal.coverageIntervals.get(key) ?? []).every((interval) => interval.subjectAssetId === assetId));
  }
}
for (const indexed of internal.physicalBindingIndex.values()) {
  for (const binding of indexed) assert(internal.assets.has(binding.assetId));
}
for (const binding of internal.processBindingIndex.values()) assert(internal.assets.has(binding.assetId));
for (const dedupeKey of internal.factDedupe.keys()) {
  const delimiter = dedupeKey.indexOf('\0');
  assert(delimiter >= 0 && internal.assets.has(dedupeKey.slice(0, delimiter)));
}
for (const assetId of internal.factRevisions.keys()) assert(internal.assets.has(assetId));

let oldPhysicalResult;
assert.doesNotThrow(() => {
  oldPhysicalResult = churn.observeEvents([{
    eventId: 'old-physical-key-after-eviction',
    at: ++churnNow,
    eventKind: 'FileAccess',
    physicalWorkloadId: oldPhysicalWorkloadId,
  }]);
}, 'an evicted physical key cannot resolve to a missing asset');
assert.equal(oldPhysicalResult[0].subjectAssetId, undefined);
assert.equal(oldPhysicalResult[0].assetBindingQuality, 'unassigned');

let oldProcessResult;
assert.doesNotThrow(() => {
  oldProcessResult = churn.observeEvents([{
    eventId: 'old-process-key-after-eviction',
    at: ++churnNow,
    eventKind: 'ToolExec',
    processInstanceKey: oldProcessKey,
    displayName: 'recreated short process',
    scope: { hostId: 'host-capacity' },
  }]);
}, 'an old ProcessKey is safely recreated instead of reaching requireAsset through a stale index');
assert.equal(oldProcessResult[0].subjectAssetId, oldProcessAssetId);
assert.equal(oldProcessResult[0].assetBindingQuality, 'ephemeral');
const repeatedFact = churn.applyLifecycleFact({
  factKind: 'asset_inactivated',
  subjectAssetId: oldProcessAssetId,
  effectiveAt: ++churnNow,
  observedAt: churnNow,
  source: 'capacity_test_process',
  dedupeKey: 'repeat-after-eviction',
});
assert.equal(repeatedFact.revision, 2,
  'fact dedupe and revision state restart from the recreated asset rather than leaking the evicted lifecycle');
const recreatedRuntime = churn.upsertRuntime({
  runtimeInstanceId: oldProcessKey,
  subjectAssetId: oldProcessAssetId,
  placement: 'process',
  state: 'current',
  observedAt: ++churnNow,
  source: 'capacity_test_process',
});
assert.equal(recreatedRuntime.revision, 1, 'evicted Runtime state does not consume recreated-asset capacity');
assert.equal(churn.persistentRevision(), stablePersistenceRevision,
  'continued Process churn remains outside the low-frequency logical persistence revision');

churn.upsertAsset({
  subjectAssetId: stableWorkloadId,
  subjectAssetType: 'workload',
  logicalIdentity: stableWorkloadId,
  displayName: 'capacity anchor updated',
  existenceState: 'active',
  identity: 'unknown',
  role: 'ordinary_process',
  source: 'capacity_test_inventory',
  observedAt: ++churnNow,
});
assert(churn.persistentRevision() > stablePersistenceRevision,
  'a real logical-asset change still advances durable persistence scheduling');

console.log('Observed Asset lifecycle Phase-B core verification passed');
