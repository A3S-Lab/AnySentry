#!/usr/bin/env node

import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

const baseUrl = (
  process.env.ANYSENTRY_API_BASE
  ?? process.env.API_BASE
  ?? 'http://127.0.0.1:32653/security-center'
).replace(/\/$/u, '');
const adminToken = (process.env.ANYSENTRY_ADMIN_TOKEN ?? process.env.ANYSENTRY_MANAGEMENT_TOKEN ?? '').trim();
if (!adminToken) throw new Error('Set ANYSENTRY_ADMIN_TOKEN or ANYSENTRY_MANAGEMENT_TOKEN.');

async function request(path, { method = 'GET', body, admin = false } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(admin ? { 'x-anysentry-admin-token': adminToken } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const rawText = await response.text();
  let raw;
  try { raw = rawText ? JSON.parse(rawText) : undefined; } catch { raw = rawText; }
  const payload = raw?.data ?? raw;
  assert(response.ok, `${method} ${path} -> ${response.status}: ${rawText.slice(0, 1_000)}`);
  return payload;
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}

async function eventually(label, read, accept, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = await read();
    if (accept(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`${label} did not converge: ${JSON.stringify(latest, null, 2).slice(0, 4_000)}`);
}

const health = await request('/healthz');
assert.equal(health.status, 'ok');

const catalogPages = [];
let cursor;
do {
  const page = await request(`/filter-rules/catalog?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
  catalogPages.push(page);
  cursor = page.nextCursor;
} while (cursor);
const first = catalogPages[0];
const rules = catalogPages.flatMap((page) => page.items);
assert.equal(rules.length, first.total, 'cursor pagination must enumerate the complete deployed catalog');
assert.equal(first.categories.length, 8);
assert.equal(new Set(rules.map((rule) => rule.ruleId)).size, rules.length);
assert(rules.filter((rule) => rule.ruleId.startsWith('ifr_')).length >= 60, 'all migrated Infrastructure rules must remain visible');
assert.equal(rules.filter((rule) => rule.ruleKind === 'runtime_signature').length, 6);
assert(first.kinds.some((kind) => kind.kind === 'agent_template' && kind.total === 0), 'empty Agent Template category must remain explicit');
assert(rules.some((rule) => rule.ruleId === 'fr_guardrail_security_full' && rule.editable === false));
assert(rules.some((rule) => rule.ruleId === 'fr_builtin_f3_non_agent_structural'));

const infrastructureStateBefore = await request('/infrastructure-rules/status', { admin: true });
const infrastructureStateAfter = infrastructureStateBefore.reports >= 200
  ? infrastructureStateBefore
  : await eventually(
      'physical materialization state advance',
      () => request('/infrastructure-rules/status', { admin: true }),
      (status) => status.stateVersion > infrastructureStateBefore.stateVersion,
      90_000,
    );
assert(infrastructureStateAfter.reports <= 200, 'materialization history must remain bounded');
const catalogAfterMaterialization = await request('/filter-rules/catalog?limit=1');
assert.equal(infrastructureStateAfter.policyVersion, infrastructureStateBefore.policyVersion);
assert.equal(catalogAfterMaterialization.catalogVersion, first.catalogVersion, 'materialization reports must not invalidate Catalog cursors');
assert.deepEqual(catalogAfterMaterialization.domainVersions, first.domainVersions, 'materialization reports must not advance logical domain versions');

const projectionA = await request('/filter-rules/projections/forwarder', { admin: true });
await new Promise((resolve) => setTimeout(resolve, 20));
const projectionB = await request('/filter-rules/projections/forwarder', { admin: true });
assert.equal(projectionA.runtimeSignatures.runtimes.length, 6);
assert.equal(projectionA.agentTemplates.templates.length, 0);
assert(projectionA.identityRules.some((rule) => rule.ruleId.startsWith('ifr_')), 'Forwarder projection must contain enforced adapter rules');
assert.equal(projectionA.captureProfiles.agent_full.file_access, 'full');
assert.equal(projectionA.captureProfiles.infrastructure_aggregate.file_access, 'aggregate');
assert.match(projectionA.intentHash, /^[a-f0-9]{64}$/u);
assert.equal(projectionA.intentHash, projectionB.intentHash, 'TTL refresh must keep semantic intent stable');
assert.notEqual(projectionA.contentHash, projectionB.contentHash, 'transport hash must cover refreshed timestamps');

const conflict = await request('/filter-rules/examples/agent-infrastructure-conflict');
assert.equal(conflict.context.conflict, true);
assert.equal(conflict.stages.find((stage) => stage.stage === 'f1')?.winner?.ruleId, 'fr_guardrail_agent_conflict_keep');
assert.equal(conflict.stages.find((stage) => stage.stage === 'f3')?.winner?.ruleId, 'fr_guardrail_agent_conflict_keep');

const stableAssetPages = await Promise.all(['service', 'infrastructure', 'workload'].map((subjectAssetType) =>
  request('/assets/list', { method: 'POST', body: { subjectAssetType, limit: 200 } })));
const explainAsset = stableAssetPages.flatMap((page) => page.items).find((asset) =>
  asset.bindingQuality === 'exact' || asset.bindingQuality === 'logical');
assert(explainAsset, 'deployed server-owned Inventory must expose one stable service/infrastructure asset');
const explained = await request('/filter-rules/explain', {
  method: 'POST',
  body: { assetId: explainAsset.subjectAssetId },
});
assert.equal(explained.subject.id, explainAsset.subjectAssetId);
assert.deepEqual(explained.stages.map((stage) => stage.stage), ['f0', 'f1', 'f2', 'f3']);
assert(explained.context.facts.length >= 4);

const historical = await request('/filter-rules/simulate', {
  method: 'POST',
  admin: true,
  body: { ruleId: 'fr_builtin_f2_unknown_keep', historyWindow: 'last_30m', sampleLimit: 200 },
});
assert.equal(historical.sample.source, 'historical_events', JSON.stringify(historical.sample));
assert.equal(historical.sample.historyWindow, 'last_30m');
assert(historical.sample.evaluated <= 200);

const stageStatus = await eventually(
  'F0/F1/F2 runtime projection alignment',
  () => request('/filter-rules/stages/status'),
  (status) => ['f0', 'f1', 'f2'].every((stage) => {
    const item = status.stages.find((candidate) => candidate.stage === stage);
    return item?.status === 'ready' && item.nodes.length > 0 && item.nodes.every((node) => node.status === 'aligned');
  }),
);
assert.deepEqual(stageStatus.stages.map((stage) => stage.stage), ['f0', 'f1', 'f2', 'f3']);
assert.equal(stageStatus.stages.find((stage) => stage.stage === 'f3')?.status, 'ready');

const catalogDurations = [];
for (let index = 0; index < 15; index += 1) {
  const started = performance.now();
  await request('/filter-rules/catalog?limit=100');
  catalogDurations.push(performance.now() - started);
}
const explainDurations = [];
for (let index = 0; index < 10; index += 1) {
  const started = performance.now();
  await request('/filter-rules/explain', { method: 'POST', body: { assetId: explainAsset.subjectAssetId } });
  explainDurations.push(performance.now() - started);
}
const catalogP95Ms = percentile(catalogDurations, 0.95);
const explainP95Ms = percentile(explainDurations, 0.95);
assert(catalogP95Ms < 2_000, `deployed catalog P95 ${catalogP95Ms.toFixed(1)}ms exceeded 2s`);
assert(explainP95Ms < 1_000, `deployed Explain P95 ${explainP95Ms.toFixed(1)}ms exceeded 1s`);

console.log(JSON.stringify({
  api: baseUrl,
  catalogRules: rules.length,
  infrastructureRules: rules.filter((rule) => rule.ruleId.startsWith('ifr_')).length,
  materializationStateAdvance: infrastructureStateAfter.stateVersion - infrastructureStateBefore.stateVersion,
  runtimeSignatures: 6,
  agentTemplates: 0,
  explainAsset: explainAsset.subjectAssetId,
  historicalSamples: historical.sample.evaluated,
  stages: Object.fromEntries(stageStatus.stages.map((stage) => [stage.stage, stage.status])),
  catalogP95Ms: Number(catalogP95Ms.toFixed(2)),
  explainP95Ms: Number(explainP95Ms.toFixed(2)),
  projectionIntentHash: projectionA.intentHash,
}, null, 2));
console.log('PASS deployed unified Filter Rule catalog, projection, Explain, history, stage alignment, and latency');
