#!/usr/bin/env node

// Regression: WorkloadIdentityCache.replace() applied operator template reclassification to
// every entry, including control-plane projection entries whose attributionSource is
// 'manual_review'. A probable_agent template matching the reviewed container's image silently
// downgraded the human-confirmed identity, confirmedPhysicalWorkloadIds() came back empty, and
// the TLS/plaintext whitelist never gained entries (UOS field report, 2026-10-10).
//
// Also pins the runtime-inventory join: review entries carry no live runtime facts (no
// containerState/hostPid), so agentRuntimeInventory() re-applies the human decision onto the
// live discovery entry for the same workload instead of emitting the fact-less review entry.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { WorkloadIdentityCache } = require('./observer-workload-filter');
const { AgentTemplateRegistry, SCHEMA_VERSION } = require('./observer-agent-templates');

const HOST_ID = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4';
const BOOT_ID = 'boot-1';
const CONTAINER_ID = '9'.repeat(64);
const PWID = `docker:${HOST_ID}:${CONTAINER_ID}`;

const templateRegistry = new AgentTemplateRegistry({
  schemaVersion: SCHEMA_VERSION,
  templates: [
    {
      id: 'docker-office-agent-image',
      name: 'office agent image',
      deployment: 'docker',
      classification: 'probable_agent',
      agentId: 'office-agent',
      match: { image: '*agent:office*' },
    },
  ],
});
assert.equal(templateRegistry.stats.loaded, 1, 'template fixture must load');

const newCache = () => new WorkloadIdentityCache({
  templateRegistry,
  hostId: HOST_ID,
  bootId: BOOT_ID,
});

// The control-plane projection entry for a human-confirmed container. Its containerImage
// matches the probable_agent template — the pre-fix stomp condition.
const reviewEntry = {
  ids: [`container:${CONTAINER_ID}`],
  classification: 'confirmed_agent',
  physicalWorkloadId: PWID,
  source: 'docker',
  attributionSource: 'manual_review',
  agentScopeId: 'office-agent',
  agentDisplayName: 'office-agent',
  containerImage: 'registry.local/agent:office',
  evidence: ['manual_review:confirmed_agent'],
};

const projectionSnapshot = (entries) => ({
  schemaVersion: 'anysentry.workload_identity_snapshot.v1',
  ready: true,
  version: 1,
  entries,
});

// --- 1. Template override must skip manual_review entries -------------------------------
{
  const cache = newCache();
  assert.equal(cache.replace(projectionSnapshot([reviewEntry])), true);
  const stored = [...cache.sources.get('kubernetes')][0] ?? [...cache.sources.values()].flat()[0];
  assert.equal(stored.classification, 'confirmed_agent', 'review classification must survive replace()');
  assert.equal(stored.attributionSource, 'manual_review', 'review provenance must survive replace()');
  assert.ok(
    cache.confirmedPhysicalWorkloadIds().has(PWID),
    'confirmed whitelist join set must contain the reviewed workload',
  );
}

// --- 2. Templates still classify unlabeled entries (no over-correction) -----------------
{
  const cache = newCache();
  const unlabeled = {
    ids: [CONTAINER_ID],
    classification: 'unknown',
    physicalWorkloadId: PWID,
    source: 'docker',
    containerImage: 'registry.local/agent:office',
    evidence: ['label_missing:anysentry.io/workload-kind'],
  };
  assert.equal(cache.replace(projectionSnapshot([unlabeled]), 'docker'), true);
  const stored = [...cache.sources.get('docker')][0];
  assert.equal(stored.classification, 'probable_agent', 'template must still classify unlabeled entries');
  assert.equal(stored.attributionSource, 'self_register');
}

// --- 3. Runtime inventory re-applies the review onto the live docker entry --------------
{
  const cache = newCache();
  assert.equal(cache.replace(projectionSnapshot([reviewEntry])), true);
  // Live local discovery sees the same container running, with runtime facts, but no template
  // match stays 'unknown' (image here deliberately misses the glob).
  const liveEntry = {
    ids: [CONTAINER_ID, CONTAINER_ID.slice(0, 12)],
    classification: 'unknown',
    physicalWorkloadId: PWID,
    source: 'docker',
    environment: 'docker',
    hostId: HOST_ID,
    bootId: BOOT_ID,
    containerState: 'running',
    hostPid: 12345,
    rootStartTimeTicks: '67890',
    containerImage: 'registry.local/agent:office',
    evidence: ['label_missing:anysentry.io/workload-kind'],
  };
  assert.equal(cache.replace({ ...projectionSnapshot([liveEntry]), version: 2 }, 'docker'), true);
  const inventory = cache.agentRuntimeInventory();
  assert.equal(inventory.length, 1, 'live entry joins the review into the runtime inventory');
  assert.equal(inventory[0].classification, 'confirmed_agent', 'runtime snapshot carries the human decision');
  assert.equal(inventory[0].agentScopeId, 'office-agent', 'review agent scope wins');
  assert.equal(inventory[0].rootPid, 12345, 'runtime facts come from live discovery');
}

// --- 4. A non_agent review excludes the workload from the runtime inventory -------------
{
  const cache = newCache();
  const rejected = { ...reviewEntry, classification: 'non_agent', agentScopeId: undefined };
  assert.equal(cache.replace(projectionSnapshot([rejected])), true);
  const liveEntry = {
    ids: [CONTAINER_ID],
    classification: 'confirmed_agent',
    physicalWorkloadId: PWID,
    source: 'docker',
    environment: 'docker',
    hostId: HOST_ID,
    bootId: BOOT_ID,
    containerState: 'running',
    hostPid: 12345,
    rootStartTimeTicks: '67890',
    evidence: ['label:anysentry.io/workload-kind=agent'],
  };
  assert.equal(cache.replace({ ...projectionSnapshot([liveEntry]), version: 2 }, 'docker'), true);
  assert.equal(
    cache.agentRuntimeInventory().length,
    0,
    'a human non_agent decision must remove even a label-confirmed workload from the agent runtime inventory',
  );
}

// --- 5. Multi-instance Agent: one review admits every named container --------------------
// UOS field shape: office-agent is one logical asset with two containers (ai-agent + skill);
// the review record holds a single physicalWorkloadId but both container identity keys.
{
  const cache = newCache();
  const CONTAINER_B = '8'.repeat(64);
  const PWID_B = `docker:${HOST_ID}:${CONTAINER_B}`;
  const multiReview = {
    ...reviewEntry,
    ids: [`container:${CONTAINER_ID}`, `container:${CONTAINER_B}`],
  };
  assert.equal(cache.replace(projectionSnapshot([multiReview])), true);
  const liveA = {
    ids: [CONTAINER_ID, CONTAINER_ID.slice(0, 12)],
    classification: 'unknown',
    physicalWorkloadId: PWID,
    source: 'docker',
    environment: 'docker',
    hostId: HOST_ID,
    bootId: BOOT_ID,
    containerState: 'running',
    hostPid: 12345,
    rootStartTimeTicks: '67890',
    containerImage: 'registry.local/agent:office',
  };
  const liveB = {
    ...liveA,
    ids: [CONTAINER_B, CONTAINER_B.slice(0, 12)],
    physicalWorkloadId: PWID_B,
    hostPid: 22345,
  };
  assert.equal(cache.replace({ ...projectionSnapshot([liveA, liveB]), version: 2 }, 'docker'), true);
  const confirmed = cache.confirmedPhysicalWorkloadIds();
  assert.ok(confirmed.has(PWID), 'reviewed physical workload admitted');
  assert.ok(
    confirmed.has(PWID_B),
    'the second container named in the review identity keys must also join the whitelist',
  );
}

// --- 6. A non_agent review wins over a label confirmation on the whitelist --------------
{
  const cache = newCache();
  const rejected = { ...reviewEntry, classification: 'non_agent', agentScopeId: undefined };
  assert.equal(cache.replace(projectionSnapshot([rejected])), true);
  const liveEntry = {
    ids: [CONTAINER_ID],
    classification: 'confirmed_agent',
    physicalWorkloadId: PWID,
    source: 'docker',
    environment: 'docker',
    hostId: HOST_ID,
    bootId: BOOT_ID,
    containerState: 'running',
    evidence: ['label:anysentry.io/workload-kind=agent'],
  };
  assert.equal(cache.replace({ ...projectionSnapshot([liveEntry]), version: 2 }, 'docker'), true);
  assert.ok(
    !cache.confirmedPhysicalWorkloadIds().has(PWID),
    'a human non_agent decision must remove the workload from the whitelist join set',
  );
}

console.log('workload filter review precedence verification passed');
