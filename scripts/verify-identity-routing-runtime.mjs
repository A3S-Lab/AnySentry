#!/usr/bin/env node

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const baseUrl = (process.env.ANYSENTRY_API_BASE
  ?? 'http://127.0.0.1:29653/security-center').replace(/\/$/u, '');
const adminToken = process.env.ANYSENTRY_ADMIN_TOKEN?.trim();
const runId = `identity-route-${Date.now()}-${randomUUID().slice(0, 8)}`;
const classifications = ['confirmed_agent', 'probable_agent', 'unknown', 'non_agent'];

async function request(path, { method = 'POST', body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(adminToken ? { authorization: `Bearer ${adminToken}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : undefined;
  if (!response.ok) throw new Error(`${method} ${path} returned ${response.status}: ${text}`);
  return payload?.data ?? payload;
}

function observerLine(classification) {
  const pid = 74100 + classifications.indexOf(classification);
  return JSON.stringify({
    identity: { agent: `${runId}-${classification}`, session: runId, task: classification },
    process: {
      pid,
      ppid: 74099,
      uid: 1000,
      comm: 'identity-route-probe',
      exe: '/usr/bin/identity-route-probe',
      cwd: `/workspace/${runId}`,
      boot_id: runId,
      start_time_ticks: String(900000 + pid),
    },
    event: {
      ToolExec: {
        pid,
        uid: 1000,
        cwd: `/workspace/${runId}`,
        argv: ['identity-route-probe', classification],
        exec_confirmed: true,
      },
    },
  });
}

function attribution(classification) {
  const candidate = classification === 'probable_agent';
  const confirmed = classification === 'confirmed_agent';
  return {
    monitored: classification !== 'non_agent',
    classification,
    agentScopeId: `${runId}-${classification}`,
    agentDisplayName: `${runId}-${classification}`,
    rootPid: 74100 + classifications.indexOf(classification),
    confidence: confirmed ? 1 : candidate ? 0.82 : classification === 'unknown' ? 0.2 : 0.99,
    reason: confirmed ? 'authoritative_anchor' : candidate ? 'hint_only' : classification === 'unknown' ? 'not_evaluated' : 'not_agent',
    source: confirmed ? 'self_register' : candidate ? 'behavior' : 'none',
    evidence: [`runtime-contract:${runId}`],
  };
}

async function ingest(classification) {
  return request('/ingest', {
    body: {
      line: observerLine(classification),
      sourceEventId: `${runId}-${classification}`,
      sourceType: 'observer',
      collectorId: `${runId}-collector`,
      nodeName: `${runId}-node`,
      workspacePath: `/workspace/${runId}`,
      attribution: attribution(classification),
    },
  });
}

async function list(scope) {
  return request('/events/list', {
    body: {
      timeType: 'last_3h',
      scope,
      includeUnknown: true,
      durable: true,
      q: runId,
      limit: 50,
    },
  });
}

const original = await request('/config', { method: 'GET' });
const originalPolicy = original.policy ?? original;
const testPolicy = {
  failClosed: false,
  speculate: 'off',
  rules: [{
    name: 'identity routing runtime probe',
    on: 'ToolExec',
    match: 'identity-route-probe',
    verdict: 'allow',
    severity: 'info',
    reason: 'identity routing runtime probe',
  }],
  llm: { url: 'http://127.0.0.1:9/v1', model: 'runtime-probe', timeoutS: 1 },
  agent: { bin: '/opt/anysentry/l3-agent.mjs', skills: '/opt/anysentry/skills' },
  identity: { candidatePipeline: 'full' },
};

try {
  await request('/config', { method: 'PUT', body: testPolicy });
  const ingested = Object.fromEntries(await Promise.all(classifications.map(async (classification) => [
    classification,
    await ingest(classification),
  ])));

  assert.equal(ingested.confirmed_agent.accepted, true);
  assert.equal(ingested.probable_agent.accepted, true);
  assert.equal(ingested.unknown.accepted, true);
  assert.equal(ingested.non_agent.accepted, false);

  const deadline = Date.now() + Number(process.env.ANYSENTRY_IDENTITY_ROUTE_VERIFY_TIMEOUT_MS ?? 30_000);
  let raw;
  while (Date.now() < deadline) {
    raw = await list('raw');
    const completed = raw.items.filter((item) => item.decisionStatus === 'succeeded');
    if (completed.length === 3) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  assert.ok(raw, 'raw event response missing');
  const byClassification = new Map(raw.items.map((item) => [item.effectiveClassification, item]));
  assert.equal(raw.items.length, 3, JSON.stringify(raw));
  assert.equal(byClassification.get('confirmed_agent')?.judgment?.profile, 'full');
  assert.equal(byClassification.get('confirmed_agent')?.judgment?.maxTier, 'L3');
  assert.equal(byClassification.get('probable_agent')?.judgment?.profile, 'full');
  assert.equal(byClassification.get('probable_agent')?.judgment?.maxTier, 'L3');
  assert.equal(byClassification.get('unknown')?.judgment?.profile, 'l1_only');
  assert.equal(byClassification.get('unknown')?.judgment?.maxTier, 'L1');
  assert.equal(byClassification.get('unknown')?.tier, 'Rules');
  assert.equal(raw.items.every((item) => item.decisionStatus === 'succeeded'), true, JSON.stringify(raw));

  const agents = await list('agent');
  assert.deepEqual(
    new Set(agents.items.map((item) => item.effectiveClassification)),
    new Set(['confirmed_agent', 'probable_agent']),
  );
  assert.equal(agents.items.length, 2, JSON.stringify(agents));

  await request('/config', {
    method: 'PUT',
    body: { ...testPolicy, identity: { candidatePipeline: 'l1_only' } },
  });
  const candidateL1 = await ingest('probable_agent');
  assert.equal(candidateL1.accepted, true);
  const candidateDeadline = Date.now() + 30_000;
  let candidateEvent;
  while (Date.now() < candidateDeadline) {
    const response = await list('raw');
    candidateEvent = response.items.find((item) => item.eventId === candidateL1.eventId);
    if (candidateEvent?.decisionStatus === 'succeeded') break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal(candidateEvent?.judgment?.profile, 'l1_only', JSON.stringify(candidateEvent));
  assert.equal(candidateEvent?.judgment?.maxTier, 'L1');
  assert.equal(candidateEvent?.tier, 'Rules');

  console.log(JSON.stringify({
    runId,
    retainedClassifications: [...byClassification.keys()].sort(),
    agentViewClassifications: agents.items.map((item) => item.effectiveClassification).sort(),
    discardedClassification: 'non_agent',
    candidateL1OnlyEventId: candidateEvent.eventId,
  }, null, 2));
  console.log('Identity routing runtime verification passed');
} finally {
  await request('/config', { method: 'PUT', body: originalPolicy });
}
