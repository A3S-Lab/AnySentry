#!/usr/bin/env node

/**
 * F0–F3 / process-generation gate. Local contracts always run; live HTTP runs when
 * ANYSENTRY_API_BASE + ANYSENTRY_MANAGEMENT_TOKEN are set.
 *
 * Builtin catalog + Observer ACK + process generation are the pollable readiness
 * surface. Candidate ifr_* adapters may appear from remaining exact non-Agent inventory;
 * they stay out of the lossy Forwarder identity projection until promoted.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import process from 'node:process';

const infraSource = readFileSync(
  new URL('../apps/api/src/security-monitoring/infrastructure-rule.service.ts', import.meta.url),
  'utf8',
);
assert.match(infraSource, /ensureInventoryCandidates/);
assert.match(infraSource, /MAX_INVENTORY_CANDIDATES = 32/);
assert.match(infraSource, /INVENTORY_SYNC_TTL_MS = 60_000/);
assert.match(infraSource, /intent: 'aggregate'/);
assert.match(infraSource, /allowStale: true/);

const require = createRequire(import.meta.url);
const {
  deriveAgentInstanceIdentity,
  deriveProcessGenerationKey,
} = require('../apps/api/dist/security-monitoring/canonical-observability.js');

const samePidDifferentStart = [
  deriveProcessGenerationKey({ hostId: 'host-a', bootId: 'boot-a', pid: 42, startTimeTicks: '100' }),
  deriveProcessGenerationKey({ hostId: 'host-a', bootId: 'boot-a', pid: 42, startTimeTicks: '200' }),
];
assert.ok(samePidDifferentStart[0]);
assert.ok(samePidDifferentStart[1]);
assert.notEqual(samePidDifferentStart[0], samePidDifferentStart[1], 'same PID different start time must not inherit generation');
assert.notEqual(
  deriveAgentInstanceIdentity({ logicalAgentId: 'logical-a', processGenerationKey: samePidDifferentStart[0] }).agentInstanceId,
  deriveAgentInstanceIdentity({ logicalAgentId: 'logical-a', processGenerationKey: samePidDifferentStart[1] }).agentInstanceId,
  'a new process generation must create a new functional AgentInstance',
);

console.log('verify-phase-f0-f3-live: local contracts ok');

const base = process.env.ANYSENTRY_API_BASE?.replace(/\/$/u, '');
const token = process.env.ANYSENTRY_MANAGEMENT_TOKEN;
if (!base || !token) {
  console.log('verify-phase-f0-f3-live: live HTTP skipped (set ANYSENTRY_API_BASE and ANYSENTRY_MANAGEMENT_TOKEN)');
  process.exit(0);
}

async function get(path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'x-anysentry-admin-token': token,
      'x-anysentry-management-token': token,
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const raw = await response.json();
  if (!response.ok) {
    throw new Error(`${path} HTTP ${response.status} ${JSON.stringify(raw).slice(0, 240)}`);
  }
  return raw.data ?? raw;
}

const catalog = await get('/filter-rules/catalog?limit=200');
assert.ok((catalog.items?.length ?? 0) > 0);
assert.ok(catalog.items.some((rule) => rule.ruleKind === 'runtime_signature'));
assert.ok(catalog.items.some((rule) => rule.ruleId === 'fr_guardrail_security_full'));
const infrastructureAdapters = catalog.items.filter((rule) => String(rule.ruleId).startsWith('ifr_'));
assert.ok(
  infrastructureAdapters.every((rule) => rule.lifecycleStage !== 'enforced'),
  'inventory-synced ifr_* drafts must stay candidate/shadow, not enforced',
);

const stages = await get('/filter-rules/stages/status');
const byStage = Object.fromEntries((stages.stages ?? []).map((item) => [item.stage, item]));
assert.equal(byStage.f0?.status, 'ready');
assert.equal(byStage.f1?.status, 'ready');
assert.equal(byStage.f2?.status, 'ready');
assert.equal(byStage.f3?.status, 'ready');
const epochs = ['f0', 'f1', 'f2'].map((stage) => byStage[stage].nodes?.[0]?.epoch).filter(Boolean);
assert.ok(epochs.length === 3 && epochs.every((epoch) => epoch === epochs[0]), 'F0/F1/F2 must share one Observer epoch');

const projectionA = await get('/filter-rules/projections/forwarder');
await new Promise((resolve) => setTimeout(resolve, 20));
const projectionB = await get('/filter-rules/projections/forwarder');
assert.match(projectionA.intentHash ?? '', /^[a-f0-9]{64}$/u);
assert.equal(projectionA.intentHash, projectionB.intentHash, 'TTL refresh must keep semantic intent stable');
assert.ok(projectionA.generatedAt && projectionA.expiresAt);

const conflict = await get('/filter-rules/examples/agent-infrastructure-conflict');
assert.equal(conflict.context?.conflict, true);
assert.equal(conflict.stages?.find((stage) => stage.stage === 'f1')?.winner?.ruleId, 'fr_guardrail_agent_conflict_keep');
assert.equal(conflict.stages?.find((stage) => stage.stage === 'f3')?.winner?.ruleId, 'fr_guardrail_agent_conflict_keep');

const services = await get('/assets/list', { method: 'POST', body: { subjectAssetType: 'service', limit: 50 } });
const explainAsset = (services.items ?? []).find((item) => item.bindingQuality === 'exact')
  ?? (services.items ?? []).find((item) => item.subjectAssetId);
assert.ok(explainAsset, 'remaining inventory must expose at least one service asset');
const explained = await get('/filter-rules/explain', { method: 'POST', body: { assetId: explainAsset.subjectAssetId } });
assert.deepEqual(explained.stages?.map((stage) => stage.stage), ['f0', 'f1', 'f2', 'f3']);
assert.ok((explained.context?.facts?.length ?? 0) >= 4);

const instances = await get('/v1/agent-instances?timeType=last_1d&limit=12');
assert.ok(Array.isArray(instances.items));
let generation = null;
for (const item of instances.items) {
  const runtimes = await get(`/v1/agent-instances/${encodeURIComponent(item.agentInstanceId)}/runtimes?timeType=last_1d`);
  const runtime = (runtimes.items ?? []).find((row) => (row.processGenerationKeys?.length ?? 0) > 0);
  if (!runtime) continue;
  generation = {
    processGenerationKey: runtime.processGenerationKeys[0],
    physicalWorkloadId: runtime.physicalWorkloadId,
    hostId: runtime.hostId,
    rootPid: runtime.rootPid,
    rootStartTimeTicks: runtime.rootStartTimeTicks,
    environment: runtime.environment,
  };
  assert.match(generation.processGenerationKey, /^pgk_[a-f0-9]{24}$/u);
  assert.ok(generation.hostId && generation.rootPid && generation.rootStartTimeTicks);
  break;
}
assert.ok(generation, 'at least one live or historical RuntimeInstance must expose process generation');

const health = await get('/healthz');
const gaps = health.canonicalObservability?.gaps ?? {};
assert.equal(gaps.asyncRawPersistenceDropped ?? 0, 0);
assert.equal(gaps.asyncKernelPersistenceDropped ?? 0, 0);
assert.equal(gaps.asyncDerivedPersistenceDropped ?? 0, 0);

console.log(JSON.stringify({
  schemaVersion: 'anysentry.phase_f0_f3_live.v1',
  catalogRules: catalog.items.length,
  infrastructureAdapters: infrastructureAdapters.length,
  sharedEpoch: epochs[0],
  stages: Object.fromEntries(Object.entries(byStage).map(([stage, item]) => [stage, item.status])),
  intentHash: projectionA.intentHash,
  explainAsset: explainAsset.subjectAssetId,
  generation,
  derivedDrops: {
    asyncRawPersistenceDropped: gaps.asyncRawPersistenceDropped,
    asyncKernelPersistenceDropped: gaps.asyncKernelPersistenceDropped,
    asyncDerivedPersistenceDropped: gaps.asyncDerivedPersistenceDropped,
  },
}, null, 2));
console.log('verify-phase-f0-f3-live: live HTTP ok');
