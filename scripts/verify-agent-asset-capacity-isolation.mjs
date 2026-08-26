#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  ObservedAssetLifecycleCore,
} = require('../apps/api/dist/security-monitoring/observed-asset-lifecycle.service.js');

let clock = 1_800_000_000_000;
const core = new ObservedAssetLifecycleCore({
  now: () => clock,
  maxAssets: 5,
  maxEphemeralAssets: 3,
  maxRuntimesPerAsset: 4,
});

function tick() {
  clock += 1_000;
  return clock;
}

function addEphemeral(index) {
  const at = tick();
  const id = `asset-process-${index}`;
  core.upsertAsset({
    subjectAssetId: id,
    subjectAssetType: 'ephemeral_process',
    logicalIdentity: `process-${index}`,
    displayName: `Process ${index}`,
    existenceState: 'active',
    identity: 'unknown',
    role: 'ordinary_process',
    source: 'process-lifecycle',
    observedAt: at,
    inventoryObserved: false,
    observationState: 'structural',
  });
  core.upsertRuntime({
    runtimeInstanceId: `runtime-process-${index}`,
    subjectAssetId: id,
    placement: 'process',
    state: 'current',
    processInstanceKey: `process-key-${index}`,
    observedAt: at,
    source: 'process-lifecycle',
  });
  return id;
}

function addDurable(id, type, role) {
  core.upsertAsset({
    subjectAssetId: id,
    subjectAssetType: type,
    logicalIdentity: id,
    displayName: id,
    existenceState: 'active',
    identity: type === 'agent' ? 'confirmed_agent' : 'unknown',
    role,
    source: 'inventory',
    observedAt: tick(),
    inventoryObserved: true,
    observationState: type === 'agent' ? 'full' : 'aggregate',
  });
}

const processOne = addEphemeral(1);
addEphemeral(2);
addEphemeral(3);
addDurable('agent-critical', 'agent', 'agent');
addDurable('service-critical', 'service', 'business_service');

let all = core.listAssets({ limit: 200 });
assert.equal(all.total, 5);
assert.ok(all.items.some((asset) => asset.subjectAssetId === 'agent-critical'));
assert.ok(all.items.some((asset) => asset.subjectAssetId === 'service-critical'));

addEphemeral(4);
all = core.listAssets({ limit: 200 });
assert.equal(all.total, 5, 'the transient tier remains independently bounded');
assert.equal(all.items.filter((asset) => asset.subjectAssetType === 'ephemeral_process').length, 3);
assert.ok(!all.items.some((asset) => asset.subjectAssetId === processOne), 'the oldest active ephemeral projection is reconstructibly evicted');
assert.ok(all.items.some((asset) => asset.subjectAssetId === 'agent-critical'));
assert.ok(all.items.some((asset) => asset.subjectAssetId === 'service-critical'));

addDurable('agent-second', 'agent', 'agent');
all = core.listAssets({ limit: 200 });
assert.equal(all.total, 5);
assert.ok(all.items.some((asset) => asset.subjectAssetId === 'agent-critical'));
assert.ok(all.items.some((asset) => asset.subjectAssetId === 'agent-second'));
assert.ok(all.items.some((asset) => asset.subjectAssetId === 'service-critical'));
assert.equal(all.items.filter((asset) => asset.subjectAssetType === 'ephemeral_process').length, 2);

console.log('Agent/Service asset capacity isolation from ephemeral Process churn passed');
