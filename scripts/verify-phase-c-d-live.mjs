#!/usr/bin/env node

/**
 * Phase C/D gate: local contracts always run; live HTTP runs when
 * ANYSENTRY_API_BASE + ANYSENTRY_MANAGEMENT_TOKEN are set.
 *
 * C: generic route shape, Session/Run aliases, AgentInstance/RuntimeInstance point-read.
 * D: parent hop does not import child Kernel; child hop may be linked.
 * Does not treat LangChain/LangGraph names as identity.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import process from 'node:process';

const require = createRequire(import.meta.url);
const { normalizeAgentRouteShape } = require('../apps/api/dist/security-monitoring/agent-interaction.js');
const {
  observabilityCoverageLayers,
  exactSessionPointReadCoverage,
  sessionResourceHydrated,
  sessionResourceAliases,
} = require('../apps/api/dist/security-monitoring/observability-coverage.js');
const { inMemoryPlanTool } = require('../apps/api/dist/security-monitoring/agent-tool-shape.js');

assert.equal(normalizeAgentRouteShape('/runs/thread-abc123/nodes/42?stream=true'), '/runs/:param/nodes/:param');
assert.equal(normalizeAgentRouteShape('/invoke'), '/invoke');
assert.equal(inMemoryPlanTool('write_todos'), true);
assert.equal(inMemoryPlanTool('run_python'), false);

const parentIx = [{
  schemaVersion: 'anysentry.agent_interaction.v1',
  interactionId: 'mi_parent',
  interactionType: 'remote_agent',
  at: 1,
  canonicalSessionId: 'sess_parent',
  invocationId: 'run-shared',
  runId: 'run-shared',
  parseState: 'parsed',
  completeness: 'complete',
  conversationCompleteness: 'complete',
  partialReasons: [],
  toolCalls: [],
  toolResults: [],
}];
const childIx = [{
  schemaVersion: 'anysentry.agent_interaction.v1',
  interactionId: 'mi_child',
  interactionType: 'tool',
  at: 2,
  canonicalSessionId: 'sess_child',
  invocationId: 'run-shared',
  runId: 'run-shared',
  parseState: 'parsed',
  completeness: 'complete',
  conversationCompleteness: 'complete',
  partialReasons: [],
  toolCalls: [{ toolCallId: 'http-1', name: 'http.code.execute' }],
  toolResults: [{ toolCallId: 'http-1', content: { stdout: '1\n' }, isError: false }],
}];
const parentLayers = observabilityCoverageLayers(parentIx, [], {
  status: 'complete',
  reasons: [],
  completeInteractions: 1,
  partialInteractions: 0,
});
const childLayers = observabilityCoverageLayers(childIx, [{
  invocationId: 'run-shared',
  toolCallId: 'http-1',
  toolName: 'http.code.execute',
  status: 'linked',
  reason: 'network_witness',
  adapterEventIds: [],
  kernelEvidence: [{ eventId: 'evt_child', eventKind: 'Egress', at: 2, linkMethod: 'network', confidence: 0.9 }],
}], {
  status: 'complete',
  reasons: [],
  completeInteractions: 1,
  partialInteractions: 0,
});
assert.equal(parentLayers.kernel.factCount, 0, 'parent hop must not import child KernelFact');
assert.equal(childLayers.kernel.factCount, 1);
assert.equal(childLayers.kernel.status, 'complete');
assert.notEqual(parentLayers.session.canonicalSessionIds[0], childLayers.session.canonicalSessionIds[0]);

assert.equal(sessionResourceHydrated({ coverage: { status: 'partial', completeInteractions: 0 } }), false);
assert.equal(sessionResourceHydrated({ coverage: { status: 'complete', completeInteractions: 3 } }), true);
assert.ok(sessionResourceAliases({
  sessionId: 'thread-1',
  conversationId: 'cv_abc',
  coverageLayers: { run: { runIds: ['run-1'] } },
}).includes('run-1'));
assert.deepEqual(
  exactSessionPointReadCoverage([{ coverage: { status: 'complete', reasons: [] } }], 'clickhouse'),
  { status: 'complete', reasons: [], source: 'clickhouse' },
);

console.log('verify-phase-c-d-live: local contracts ok');

const base = process.env.ANYSENTRY_API_BASE?.replace(/\/$/u, '');
const token = process.env.ANYSENTRY_MANAGEMENT_TOKEN;
if (!base || !token) {
  console.log('verify-phase-c-d-live: live HTTP skipped (set ANYSENTRY_API_BASE and ANYSENTRY_MANAGEMENT_TOKEN)');
  process.exit(0);
}

async function get(path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'x-anysentry-admin-token': token,
      'x-anysentry-management-token': token,
    },
  });
  const raw = await response.json();
  if (response.status === 404 && options.allowNotFound) return undefined;
  if (!response.ok) {
    throw new Error(`${path} HTTP ${response.status} ${JSON.stringify(raw).slice(0, 240)}`);
  }
  return raw.data ?? raw;
}

const timeTypes = (process.env.ANYSENTRY_VERIFY_TIME_TYPES || 'last_1d')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const sessionIds = (process.env.ANYSENTRY_VERIFY_SESSION_IDS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const runIds = (process.env.ANYSENTRY_VERIFY_RUN_IDS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const list = await get('/v1/sessions?timeType=last_1d&limit=12');
assert.ok(Array.isArray(list.items), 'session list must return items');
const discoveredSessions = sessionIds.length > 0
  ? sessionIds
  : [...new Set(list.items.flatMap((item) => [item.conversationId, item.sessionId]).filter(Boolean))].slice(0, 6);
const discoveredRuns = runIds.length > 0
  ? runIds
  : [...new Set(list.items.flatMap((item) => item.coverageLayers?.run?.runIds ?? []))].slice(0, 4);

let completeSession = 0;
let completeRun = 0;
let parentUnlinked = 0;
let childLinked = 0;
const sample = [];
const instanceIds = [];

for (const timeType of timeTypes) {
  for (const id of discoveredSessions) {
    const body = await get(`/v1/sessions/${encodeURIComponent(id)}?timeType=${timeType}`, { allowNotFound: true });
    if (!body) continue;
    if (body.coverage?.status === 'complete' && body.item?.coverage?.status === 'complete') {
      completeSession += 1;
      sample.push({ kind: 'session', timeType, id, conversationId: body.item.conversationId });
      for (const instanceId of body.item.agentInstanceIds ?? []) {
        if (instanceId && !instanceIds.includes(instanceId)) instanceIds.push(instanceId);
      }
    }
    const kernel = body.item?.coverageLayers?.kernel;
    if (body.item?.parentSessionId || body.item?.canonicalParentSessionId) {
      if (kernel?.status === 'unlinked' || kernel?.reasons?.includes('no_kernel_event_expected')) {
        parentUnlinked += 1;
      }
    }
    if ((kernel?.factCount ?? 0) > 0 && kernel?.status === 'complete') childLinked += 1;
  }
  for (const id of discoveredRuns) {
    const body = await get(`/v1/runs/${encodeURIComponent(id)}?timeType=${timeType}`, { allowNotFound: true });
    if (!body) continue;
    if (body.coverage?.status === 'complete' && body.item?.coverage?.status === 'complete') {
      completeRun += 1;
      sample.push({ kind: 'run', timeType, id, conversationId: body.item.conversationId });
    }
  }
}

const instances = await get('/v1/agent-instances?timeType=last_1d&limit=8');
assert.ok(Array.isArray(instances.items));
const instanceId = instanceIds[0] ?? instances.items.find((item) => item.agentInstanceId)?.agentInstanceId;
if (instanceId) {
  const one = await get(`/v1/agent-instances/${encodeURIComponent(instanceId)}?timeType=last_1d`);
  assert.equal(one.coverage?.status, 'complete', 'AgentInstance point-read from a complete Session must be complete');
  const runtimes = await get(`/v1/agent-instances/${encodeURIComponent(instanceId)}/runtimes?timeType=last_1d`);
  assert.equal(runtimes.coverage?.status, 'complete', 'RuntimeInstance list for that instance must be complete');
}

const health = await get('/healthz');
const gaps = health.canonicalObservability?.gaps ?? {};
assert.equal(gaps.asyncRawPersistenceDropped ?? 0, 0);
assert.equal(gaps.asyncKernelPersistenceDropped ?? 0, 0);
assert.equal(gaps.asyncDerivedPersistenceDropped ?? 0, 0);

const evidence = await get('/v1/evidence-links?limit=3');
assert.equal(evidence.coverage?.status, 'complete');
const kernelFacts = await get('/v1/kernel-facts?limit=3');
assert.equal(kernelFacts.coverage?.status, 'complete');

assert.ok(completeSession > 0, 'at least one Session point-read must be complete');
assert.ok(completeRun > 0, 'at least one Run point-read must be complete');

console.log(JSON.stringify({
  schemaVersion: 'anysentry.phase_c_d_live.v1',
  completeSession,
  completeRun,
  parentUnlinked,
  childLinked,
  derivedDrops: {
    asyncRawPersistenceDropped: gaps.asyncRawPersistenceDropped,
    asyncKernelPersistenceDropped: gaps.asyncKernelPersistenceDropped,
    asyncDerivedPersistenceDropped: gaps.asyncDerivedPersistenceDropped,
  },
  sample: sample.slice(0, 8),
}, null, 2));
console.log('verify-phase-c-d-live: live HTTP ok');
