#!/usr/bin/env node

import assert from 'node:assert/strict';

const baseUrl = (
  process.env.ANYSENTRY_API_BASE
  ?? process.env.API_BASE
  ?? `http://127.0.0.1:${process.env.PORT ?? '29653'}/security-center`
).replace(/\/$/u, '');
const adminToken = (process.env.ANYSENTRY_ADMIN_TOKEN ?? process.env.ANYSENTRY_MANAGEMENT_TOKEN ?? '').trim();
if (!adminToken) throw new Error('Set ANYSENTRY_ADMIN_TOKEN or ANYSENTRY_MANAGEMENT_TOKEN.');

async function request(path, { method = 'GET', body, token, actor, headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token === undefined ? {} : { 'x-anysentry-admin-token': token }),
      ...(actor ? { 'x-anysentry-actor': actor, 'x-anysentry-actor-type': 'operator' } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const raw = text ? JSON.parse(text) : undefined;
  return { response, raw, payload: raw?.data ?? raw };
}

const first = await request('/filter-rules/catalog?limit=5');
assert.equal(first.response.status, 200, JSON.stringify(first.raw));
assert.equal(first.payload.items.length, 5);
assert(first.payload.total >= 30);
assert.equal(typeof first.payload.nextCursor, 'string');
assert.equal(first.payload.categories.length, 8);
assert(first.payload.categories.some((category) => category.category === 'agent_identity' && category.total >= 6));
assert(first.payload.categories.some((category) => category.category === 'investigation' && category.total === 0));

const second = await request(`/filter-rules/catalog?limit=5&cursor=${encodeURIComponent(first.payload.nextCursor)}`);
assert.equal(second.response.status, 200, JSON.stringify(second.raw));
assert.equal(new Set([...first.payload.items, ...second.payload.items].map((item) => item.ruleId)).size, 10);
const mismatchedCursor = await request(`/filter-rules/catalog?limit=5&category=agent_identity&cursor=${encodeURIComponent(first.payload.nextCursor)}`);
assert.equal(mismatchedCursor.response.status, 400);

const codexList = await request('/filter-rules/catalog?category=agent_identity&q=Codex&limit=20');
const codex = codexList.payload.items.find((item) => item.ruleId === 'fr_builtin_agent_runtime_codex');
assert(codex);
assert.equal(codex.editable, false);
assert.equal(codex.management, 'builtin');
assert(codex.stageImpacts.some((impact) => impact.stage === 'f0' && impact.applicability === 'active'));
assert(codex.stageImpacts.some((impact) => impact.stage === 'f1' && impact.applicability === 'indirect'));

const codexDetail = await request(`/filter-rules/${encodeURIComponent(codex.ruleId)}`);
assert.equal(codexDetail.response.status, 200, JSON.stringify(codexDetail.raw));
assert.equal(codexDetail.payload.matcher.conditions.length >= 2, true);
assert.equal(codexDetail.payload.rawAvailable, false);
assert(!JSON.stringify(codexDetail.payload).includes('contentHash'));

const status = await request('/filter-rules/stages/status');
assert.equal(status.response.status, 200, JSON.stringify(status.raw));
assert.deepEqual(status.payload.stages.map((stage) => stage.stage), ['f0', 'f1', 'f2', 'f3']);
assert.equal(typeof status.payload.catalogVersion, 'string');

const materializations = await request('/filter-rules/materializations');
assert.equal(materializations.response.status, 200, JSON.stringify(materializations.raw));
assert(Array.isArray(materializations.payload.items));
const conflictExample = await request('/filter-rules/examples/agent-infrastructure-conflict');
assert.equal(conflictExample.response.status, 200, JSON.stringify(conflictExample.raw));
assert.equal(conflictExample.payload.context.conflict, true);
assert.equal(conflictExample.payload.stages.find((stage) => stage.stage === 'f1')?.winner?.ruleId, 'fr_guardrail_agent_conflict_keep');
assert.equal(conflictExample.payload.stages.find((stage) => stage.stage === 'f3')?.winner?.ruleId, 'fr_guardrail_agent_conflict_keep');

for (const protectedProbe of [
  { path: '/filter-rules/projections/forwarder' },
  { path: '/filter-rules/operations' },
  { path: '/filter-rules/simulate', method: 'POST', body: { ruleId: codex.ruleId } },
  { path: '/filter-rules/drafts', method: 'POST', body: {} },
  { path: `/filter-rules/raw/${encodeURIComponent(codex.ruleId)}` },
]) {
  const response = await request(protectedProbe.path, protectedProbe);
  assert.equal(response.response.status, 401, `${protectedProbe.path} must require management auth`);
}

const projection = await request('/filter-rules/projections/forwarder', { token: adminToken });
assert.equal(projection.response.status, 200, JSON.stringify(projection.raw));
assert.equal(projection.payload.runtimeSignatures.runtimes.length, 6);
assert.equal(projection.payload.captureProfiles.agent_full.file_access, 'full');
assert.equal(projection.payload.captureProfiles.infrastructure_aggregate.file_access, 'aggregate');

const runId = `filter-api-${Date.now()}-${process.pid}`;
const ingested = await request('/ingest/events', {
  method: 'POST',
  body: {
    sourceType: 'custom',
    sourceName: `${runId}-source`,
    collectorId: `${runId}-collector`,
    workspacePath: `repo://${runId}`,
    events: [{
      kind: 'tool',
      agentId: `${runId}-unassigned`,
      sessionId: `${runId}-session`,
      argv: ['id'],
      cwd: '/workspace',
    }],
  },
});
assert.equal(ingested.response.status, 201, JSON.stringify(ingested.raw));
const eventId = ingested.payload.items?.[0]?.eventId;
assert.equal(typeof eventId, 'string');
const eventList = await request('/events/list', {
  method: 'POST',
  body: { timeType: 'last_3h', scope: 'raw', includeUnknown: true, preview: true, eventId, limit: 5 },
});
assert.equal(eventList.response.status, 200, JSON.stringify(eventList.raw));
const stored = eventList.payload.items.find((item) => item.eventId === eventId);
assert(stored, JSON.stringify(eventList.raw));
assert.equal(stored.judgment.filterRuleDecision.stage, 'f3');
assert.equal(stored.judgment.filterRuleDecision.ruleId, 'fr_builtin_f3_unknown_l1');
assert.equal(stored.judgment.filterRuleDecision.failOpen, false);
const explained = await request('/filter-rules/explain', { method: 'POST', body: { eventId } });
assert.equal(explained.response.status, 201, JSON.stringify(explained.raw));
assert.equal(explained.payload.stages.find((stage) => stage.stage === 'f3')?.winner?.ruleId, 'fr_builtin_f3_unknown_l1');
const missingAssetExplain = await request('/filter-rules/explain', {
  method: 'POST',
  body: { assetId: `${runId}-missing-asset` },
});
assert.equal(missingAssetExplain.response.status, 404, JSON.stringify(missingAssetExplain.raw));

const unsafe = await request('/filter-rules/drafts', {
  method: 'POST',
  token: adminToken,
  actor: 'reviewer-a',
  body: {
    name: 'Unsafe Confirmed Signature',
    description: 'A process signature must not confirm an Agent',
    category: 'agent_identity',
    ruleKind: 'runtime_signature',
    matcher: { all: [{ field: 'process.comm', operator: 'equals', value: 'unsafe-agent' }], description: 'comm=unsafe-agent' },
    effect: { type: 'emit_identity', classification: 'confirmed_agent', confidence: 1, captureProfile: 'agent_full' },
    reason: 'adversarial API verifier',
  },
});
assert.equal(unsafe.response.status, 400, JSON.stringify(unsafe.raw));

const created = await request('/filter-rules/drafts', {
  method: 'POST',
  token: adminToken,
  actor: 'reviewer-a',
  body: {
    name: 'Verifier Runtime Signature',
    description: 'Exact verifier-agent executable',
    category: 'agent_identity',
    ruleKind: 'runtime_signature',
    matcher: { all: [{ field: 'process.exe_basename', operator: 'equals', value: 'verifier-agent' }], description: 'exe basename=verifier-agent' },
    effect: { type: 'emit_identity', classification: 'probable_agent', confidence: 0.85, captureProfile: 'probable_investigation' },
    reason: 'API lifecycle verifier',
  },
});
assert.equal(created.response.status, 201, JSON.stringify(created.raw));
const rule = created.payload.rule;
assert.equal(rule.lifecycleStage, 'draft');
assert.equal(rule.editable, true);

const staleCursor = await request(`/filter-rules/catalog?limit=5&cursor=${encodeURIComponent(first.payload.nextCursor)}`);
assert.equal(staleCursor.response.status, 409, JSON.stringify(staleCursor.raw));

const simulation = await request('/filter-rules/simulate', {
  method: 'POST',
  token: adminToken,
  actor: 'reviewer-a',
  body: {
    ruleId: rule.ruleId,
    context: {
      process: { exe: '/opt/bin/verifier-agent', argv: ['/opt/bin/verifier-agent'] },
      identityClassification: 'unknown',
      workloadRole: 'unknown',
      eventKind: 'FileAccess',
      probe: 'file_access',
    },
  },
});
assert.equal(simulation.response.status, 201, JSON.stringify(simulation.raw));
assert.equal(simulation.payload.preview.matchedAssets, 1);
assert(simulation.payload.stageChanges.some((stage) => stage.stage === 'f0' && stage.changed === 1));
assert.equal(simulation.payload.sample.source, 'provided_context');
assert.equal(simulation.payload.sample.partial, false);

const historicalSimulation = await request('/filter-rules/simulate', {
  method: 'POST',
  token: adminToken,
  actor: 'reviewer-a',
  body: { ruleId: rule.ruleId, historyWindow: 'last_30m', sampleLimit: 50 },
});
assert.equal(historicalSimulation.response.status, 201, JSON.stringify(historicalSimulation.raw));
assert.equal(historicalSimulation.payload.sample.historyWindow, 'last_30m');
assert(['historical_events', 'current_inventory'].includes(historicalSimulation.payload.sample.source));
if (historicalSimulation.payload.sample.source === 'current_inventory') {
  assert.equal(historicalSimulation.payload.sample.partial, true);
  assert(historicalSimulation.payload.sample.reasons.includes('historical_event_store_unavailable'));
}

const preview = await request(`/filter-rules/${encodeURIComponent(rule.ruleId)}/preview`, {
  method: 'POST', token: adminToken, actor: 'reviewer-a', body: {},
});
assert.equal(preview.response.status, 201, JSON.stringify(preview.raw));
assert.equal(preview.payload.valid, true);
assert.equal(preview.payload.canEnterShadow, true);

const shadow = await request(`/filter-rules/${encodeURIComponent(rule.ruleId)}/shadow`, {
  method: 'POST',
  token: adminToken,
  actor: 'reviewer-a',
  body: { expectedRevision: rule.revision, reason: 'observe exact verifier runtime matches' },
});
assert.equal(shadow.response.status, 201, JSON.stringify(shadow.raw));
assert.equal(shadow.payload.lifecycleStage, 'shadow');

const revoked = await request(`/filter-rules/${encodeURIComponent(rule.ruleId)}/revoke`, {
  method: 'POST',
  token: adminToken,
  actor: 'reviewer-a',
  body: { expectedRevision: shadow.payload.revision, reason: 'finish API verifier lifecycle' },
});
assert.equal(revoked.response.status, 201, JSON.stringify(revoked.raw));
assert.equal(revoked.payload.lifecycleStage, 'revoked');

const successor = await request('/filter-rules/drafts', {
  method: 'POST',
  token: adminToken,
  actor: 'reviewer-a',
  body: {
    name: 'Verifier Runtime Signature successor',
    description: 'Typed successor that preserves the predecessor rule family',
    category: 'agent_identity',
    ruleKind: 'runtime_signature',
    matcher: { all: [{ field: 'process.exe_basename', operator: 'equals', value: 'verifier-agent-v2' }], description: 'exe basename=verifier-agent-v2' },
    effect: { type: 'emit_identity', classification: 'probable_agent', confidence: 0.85, captureProfile: 'probable_investigation' },
    reason: 'API successor lifecycle verifier',
    predecessorRuleId: rule.ruleId,
  },
});
assert.equal(successor.response.status, 201, JSON.stringify(successor.raw));
assert.equal(successor.payload.rule.predecessorRuleId, rule.ruleId);
const invalidSuccessor = await request('/filter-rules/drafts', {
  method: 'POST',
  token: adminToken,
  actor: 'reviewer-a',
  body: {
    name: 'Invalid successor family',
    description: 'Cannot replace a signature with a capture profile',
    category: 'capture_profile',
    ruleKind: 'capture_profile',
    matcher: { all: [{ field: 'identity.classification', operator: 'equals', value: 'probable_agent' }], description: 'probable Agent' },
    effect: { type: 'assign_capture_profile', captureProfile: 'probable_investigation' },
    reason: 'adversarial API successor verifier',
    predecessorRuleId: rule.ruleId,
  },
});
assert.equal(invalidSuccessor.response.status, 400, JSON.stringify(invalidSuccessor.raw));
await request(`/filter-rules/${encodeURIComponent(successor.payload.rule.ruleId)}/revoke`, {
  method: 'POST', token: adminToken, actor: 'reviewer-a', body: { expectedRevision: 1, reason: 'clean up API successor verifier' },
});

const operations = await request(`/filter-rules/operations?ruleId=${encodeURIComponent(rule.ruleId)}`, { token: adminToken });
assert.equal(operations.response.status, 200, JSON.stringify(operations.raw));
assert(operations.payload.items.some((operation) => operation.kind === 'create'));
assert(operations.payload.items.some((operation) => operation.kind === 'preview'));
assert(operations.payload.items.some((operation) => operation.kind === 'shadow'));
assert(operations.payload.items.some((operation) => operation.kind === 'revoke'));

console.log('PASS unified Filter Rule Catalog API, cursor, projections, governance, and auth boundaries');
