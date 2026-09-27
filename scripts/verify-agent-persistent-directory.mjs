#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildAgentDirectoryRuntimeIdentityIndex,
  currentAgentSubjectAssetIds,
  lifecycleAgentHasCurrentRuntime,
  mergePersistentAgentDirectory,
} = require('../apps/api/dist/security-monitoring/agent-directory.js');
const { agentAssetIdForIdentityKey } = require('../apps/api/dist/security-monitoring/agent-identity.js');
const { SecurityMonitoringController } = require('../apps/api/dist/security-monitoring/security-monitoring.controller.js');

const now = new Date().toISOString();
const coverage = {
  requestedFrom: now,
  requestedTo: now,
  snapshotAsOf: now,
  asOf: now,
  partial: false,
  source: 'clickhouse',
  totalMode: 'exact',
};
const emptyWindow = {
  items: [],
  total: 0,
  summary: {
    totalAgents: 0,
    managedAgents: 0,
    productionAgents: 0,
    highCriticalityAgents: 0,
    activeAgents: 0,
    idleAgents: 0,
    staleAgents: 0,
    riskyAgents: 0,
    openIncidentAgents: 0,
    observedEventCount: 0,
    riskyEventCount: 0,
  },
  coverage,
  updateTime: now,
};

function asset({ id, identity, aliases = [], runtimeTotal = 0 }) {
  return {
    schemaVersion: 'anysentry.observed_asset.v1',
    subjectAssetId: id,
    subjectAssetType: 'agent',
    displayName: id === 'agent-durable' ? 'Durable custom agent' : 'Unknown candidate',
    aliases,
    scope: { workspacePath: `/workspace/${id}`, hostId: 'host-a' },
    existenceState: 'inactive',
    identity: { classification: identity, revision: 3, source: 'process_signature', effectiveAt: now },
    role: { role: 'ordinary_process', revision: 1, source: 'observer', effectiveAt: now },
    bindingQuality: 'exact',
    bindingRevision: 4,
    observationState: 'structural',
    runtimeSummary: { starting: 0, current: 0, idle: 0, exited: runtimeTotal, lost: 0, unknown: 0, total: runtimeTotal },
    eventSummary: { eventCount: 17, lastEventAt: now, eventKindCounts: { ToolExec: 1 } },
    firstSeenAt: now,
    lastActivityAt: now,
    sources: ['agent_inventory'],
    modelRevision: 9,
    updatedAt: now,
  };
}

const lifecycle = {
  schemaVersion: 'anysentry.observed_asset_list.v1',
  items: [
    asset({ id: 'agent-durable', identity: 'probable_agent', aliases: ['agent-old'], runtimeTotal: 2 }),
    asset({ id: 'agent-unknown', identity: 'unknown' }),
  ],
  total: 2,
  snapshotRevision: 19,
  summary: {},
  updateTime: now,
  readStatus: { partial: false, reasons: [], modelRevision: 19, reconciledAt: now },
};
const metadata = [{
  agentId: 'custom-agent',
  agentAssetId: 'agent-durable',
  workspacePath: '/workspace/agent-durable',
  owner: 'platform-security',
  tags: ['managed'],
  updatedAt: now,
}];

const agentDirectory = mergePersistentAgentDirectory(emptyWindow, lifecycle, metadata, {
  timeType: 'last_3h',
  scope: 'agent',
  assetRange: 'recent',
});
assert.equal(agentDirectory.items.length, 1, 'Agent scope retains the durable probable Asset but not Unknown');
assert.equal(agentDirectory.items[0].agentAssetId, 'agent-durable');
assert.equal(agentDirectory.items[0].eventCount, 0, 'lifetime Asset facts never masquerade as window metrics');
assert.equal(agentDirectory.items[0].lastEventSubject, '当前行为窗口无事件；资产由持久生命周期目录保留');
assert.equal(agentDirectory.items[0].owner, 'platform-security');
assert.equal(agentDirectory.items[0].logicalInstanceCount, 2);
assert.equal(agentDirectory.directory.source, 'observed_asset_lifecycle');
assert.equal(agentDirectory.directory.snapshotRevision, 19);

const currentOnly = mergePersistentAgentDirectory(emptyWindow, lifecycle, metadata, {
  timeType: 'last_3h', scope: 'agent', assetRange: 'current',
});
assert.equal(currentOnly.items.length, 0,
  'inactive historical runtimes stay queryable in recent/history instead of cluttering current assets');
const currentRuntime = mergePersistentAgentDirectory(emptyWindow, {
  ...lifecycle,
  activeSubjectAssetIds: ['agent-durable'],
}, metadata, { timeType: 'last_3h', scope: 'agent', assetRange: 'current' });
assert.equal(currentRuntime.items.length, 1,
  'an independently live Runtime keeps a silent logical Agent in the current directory');

function hostRuntime(index, runtimeState = 'running', overrides = {}) {
  return {
    agentScopeId: 'codex',
    agentInstanceId: `ari-runtime-${index}`,
    rootPid: 1_000 + index,
    rootStartTimeTicks: String(50_000 + index),
    rootGeneration: 1,
    hostId: 'host-a',
    bootId: 'boot-a',
    runtimeState,
    ...overrides,
  };
}

function hostRootId(runtime) {
  return `host-root:${runtime.hostId}:${runtime.bootId}:${runtime.rootPid}:${runtime.rootStartTimeTicks}`;
}

// Reproduce the real Host Agent split: Runtime Snapshot reports `ari_*`, while event semantics
// deliberately canonicalize the same process generation as `host-root:*`.
const liveHostRuntimes = [1, 2, 3, 4].map((index) => hostRuntime(index));
const hostAssets = liveHostRuntimes.map((runtime) => asset({
  id: agentAssetIdForIdentityKey(hostRootId(runtime)),
  identity: 'probable_agent',
  aliases: [agentAssetIdForIdentityKey(runtime.agentInstanceId)],
  runtimeTotal: 1,
}));
const hostDetails = new Map(hostAssets.map((hostAsset, index) => [hostAsset.subjectAssetId, {
  runtimes: [{
    runtimeInstanceId: hostRootId(liveHostRuntimes[index]),
    subjectAssetId: hostAsset.subjectAssetId,
    state: 'current',
  }],
  bindings: [],
}]));
const activeHostAssets = currentAgentSubjectAssetIds(
  hostAssets,
  liveHostRuntimes,
  (subjectAssetId) => hostDetails.get(subjectAssetId),
);
assert.deepEqual(
  new Set(activeHostAssets),
  new Set(hostAssets.map((hostAsset) => hostAsset.subjectAssetId)),
  'ari, canonical host-root, and Asset aliases resolve the same four live Runtime generations',
);

const emptyRingDirectory = mergePersistentAgentDirectory(emptyWindow, {
  ...lifecycle,
  items: hostAssets,
  total: hostAssets.length,
  activeSubjectAssetIds: activeHostAssets,
}, [], { timeType: 'last_3h', scope: 'agent', assetRange: 'current' });
assert.equal(
  emptyRingDirectory.items.length,
  4,
  'Hot Ring eviction cannot remove independently running Host Agent Assets from current membership',
);
assert.equal(
  emptyRingDirectory.items.every((item) => item.eventCount === 0),
  true,
  'a retained Asset reports an empty behavior window without inventing event metrics',
);

const legacyFirstHostAsset = asset({
  id: agentAssetIdForIdentityKey(liveHostRuntimes[0].agentInstanceId),
  identity: 'probable_agent',
  runtimeTotal: 1,
});
const aliasOnlyFallback = mergePersistentAgentDirectory(emptyWindow, {
  ...lifecycle,
  // Put the legacy row first to prove selection does not depend on lifecycle iteration order.
  items: [legacyFirstHostAsset, ...hostAssets],
  total: hostAssets.length + 1,
  activeSubjectAssetIds: [legacyFirstHostAsset.subjectAssetId, ...activeHostAssets],
}, [], { timeType: 'last_3h', scope: 'agent', assetRange: 'current' });
assert.equal(aliasOnlyFallback.items.length, 4,
  'an all-fallback alias component emits one canonical Agent row rather than canonical + legacy');
assert.equal(
  aliasOnlyFallback.items.some((item) => item.agentAssetId === legacyFirstHostAsset.subjectAssetId),
  false,
  'the one-way legacy ari-derived Asset row is suppressed by its canonical host-root owner',
);
assert.equal(
  aliasOnlyFallback.items.find((item) => item.agentAssetId === hostAssets[0].subjectAssetId)
    ?.agentAssetAliases?.includes(legacyFirstHostAsset.subjectAssetId),
  true,
  'the canonical fallback row keeps the legacy Asset ID as a deep-link alias',
);

const directoryController = Object.create(SecurityMonitoringController.prototype);
Object.defineProperty(directoryController, 'agg', {
  value: { storedAgentInventory: async () => emptyWindow },
});
let detailReads = 0;
Object.defineProperty(directoryController, 'observedAssets', {
  value: {
    list: () => ({
      ...lifecycle,
      items: hostAssets,
      total: hostAssets.length,
    }),
    detail: (subjectAssetId) => {
      detailReads += 1;
      return hostDetails.get(subjectAssetId);
    },
  },
});
Object.defineProperty(directoryController, 'agentRuntimeState', {
  value: { list: () => ({ items: liveHostRuntimes }) },
});
Object.defineProperty(directoryController, 'agentMetadata', {
  value: { list: () => [] },
});
const endpointDirectory = await directoryController.agentDirectory({
  timeType: 'last_3h', scope: 'agent', assetRange: 'current',
});
assert.equal(endpointDirectory.items.length, 4,
  'the API directory endpoint joins an empty behavior window to all four active Host Runtimes');
assert.equal(detailReads, 0,
  'canonical Asset aliases avoid per-Asset detail reads when the strong Runtime identity is sufficient');

const firstHostIndex = buildAgentDirectoryRuntimeIdentityIndex([liveHostRuntimes[0]]);
assert.equal(firstHostIndex.runtimeInstanceIds.has(liveHostRuntimes[0].agentInstanceId), true);
assert.equal(firstHostIndex.runtimeInstanceIds.has(hostRootId(liveHostRuntimes[0])), true);
assert.equal(firstHostIndex.agentAssetIds.has(hostAssets[0].subjectAssetId), true);
assert.equal(
  lifecycleAgentHasCurrentRuntime(hostAssets[0], hostDetails.get(hostAssets[0].subjectAssetId), firstHostIndex),
  true,
  'the canonical Root tuple is a strong Runtime-equivalence edge',
);

const reusedPid = hostRuntime(99, 'running', {
  agentInstanceId: 'ari-reused-pid',
  rootPid: liveHostRuntimes[0].rootPid,
  rootStartTimeTicks: '999999',
});
assert.equal(
  lifecycleAgentHasCurrentRuntime(
    hostAssets[0],
    hostDetails.get(hostAssets[0].subjectAssetId),
    buildAgentDirectoryRuntimeIdentityIndex([reusedPid]),
  ),
  false,
  'a reused PID with a different start marker cannot inherit the previous Agent Asset',
);
assert.equal(
  lifecycleAgentHasCurrentRuntime(
    hostAssets[0],
    hostDetails.get(hostAssets[0].subjectAssetId),
    buildAgentDirectoryRuntimeIdentityIndex([hostRuntime(88)]),
  ),
  false,
  'the shared Codex product label never merges independent Host roots',
);

const unobservedIndex = buildAgentDirectoryRuntimeIdentityIndex([
  { ...liveHostRuntimes[0], runtimeState: 'unobserved' },
]);
assert.equal(unobservedIndex.retainedRuntimeCount, 1);
assert.equal(
  lifecycleAgentHasCurrentRuntime(hostAssets[0], hostDetails.get(hostAssets[0].subjectAssetId), unobservedIndex),
  true,
  'a temporary collector visibility gap retains the non-terminal Agent Asset',
);
for (const terminalState of ['lost', 'exited']) {
  const terminalIndex = buildAgentDirectoryRuntimeIdentityIndex([
    { ...liveHostRuntimes[0], runtimeState: terminalState },
  ]);
  assert.equal(terminalIndex.retainedRuntimeCount, 0);
  assert.equal(
    lifecycleAgentHasCurrentRuntime(hostAssets[0], hostDetails.get(hostAssets[0].subjectAssetId), terminalIndex),
    false,
    `${terminalState} is terminal and must not keep a current Asset alive`,
  );
}

const rawDirectory = mergePersistentAgentDirectory(emptyWindow, lifecycle, metadata, {
  timeType: 'last_3h',
  scope: 'raw',
  includeUnclassified: true,
  assetRange: 'all',
});
assert.equal(rawDirectory.items.length, 2, 'raw directory can expose Unknown for identity review');

const currentWindowItem = {
  ...agentDirectory.items[0],
  agentAssetId: 'agent-current',
  agentAssetAliases: ['agent-durable'],
  eventCount: 8,
  lastEventSubject: 'current behavior',
};
const lifecycleWithReverseAlias = {
  ...lifecycle,
  items: [
    { ...lifecycle.items[0], aliases: ['agent-old-lifecycle'] },
    lifecycle.items[1],
    asset({ id: 'agent-old-lifecycle', identity: 'probable_agent' }),
  ],
  total: 3,
};
const enriched = mergePersistentAgentDirectory({
  ...emptyWindow,
  items: [currentWindowItem],
  total: 1,
}, lifecycleWithReverseAlias, metadata, { timeType: 'last_3h', scope: 'agent' });
assert.equal(enriched.items.length, 1, 'canonical/legacy aliases prevent duplicate lifecycle rows');
assert.equal(enriched.items[0].eventCount, 8, 'current window metrics enrich the durable member');
assert.equal(enriched.items[0].agentAssetId, 'agent-current', 'query-time canonical identity remains authoritative');

console.log('Persistent Agent directory verification passed');
