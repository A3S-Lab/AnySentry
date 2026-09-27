#!/usr/bin/env node

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const baseUrl = (process.env.ANYSENTRY_API_BASE
  ?? 'http://127.0.0.1:29653/security-center').replace(/\/$/u, '');
const adminToken = process.env.ANYSENTRY_ADMIN_TOKEN?.trim();
const runId = `l2-code-runtime-${Date.now()}-${randomUUID().slice(0, 8)}`;

async function request(path, { method = 'POST', body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(adminToken && path !== '/ingest' ? { authorization: `Bearer ${adminToken}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : undefined;
  if (!response.ok) throw new Error(`${method} ${path} returned ${response.status}: ${text}`);
  return payload?.data ?? payload;
}

const original = await request('/config', { method: 'GET' });
const originalPolicy = original.policy ?? original;
assert.ok(originalPolicy.llm, 'L2 must be configured before running the runtime verification');

const probePolicy = {
  ...originalPolicy,
  rules: [
    ...(originalPolicy.rules ?? []),
    {
      name: 'A3S Code L2 runtime probe',
      on: 'ToolExec',
      match: 'l2-connectivity-ok',
      verdict: 'escalate',
      severity: 'low',
      reason: 'explicit L2 runtime verification',
    },
  ],
};

try {
  await request('/config', { method: 'PUT', body: probePolicy });
  const line = JSON.stringify({
    identity: { agent: runId, session: runId, task: 'connectivity' },
    process: {
      pid: 74991,
      ppid: 74990,
      uid: 1000,
      comm: runId,
      exe: '/usr/bin/printf',
      cwd: `/workspace/${runId}`,
      boot_id: runId,
      start_time_ticks: '99174991',
    },
    event: {
      ToolExec: {
        pid: 74991,
        uid: 1000,
        cwd: `/workspace/${runId}`,
        argv: ['/usr/bin/printf', 'l2-connectivity-ok'],
        exec_confirmed: true,
      },
    },
  });
  const ingested = await request('/ingest', {
    body: {
      line,
      sourceEventId: runId,
      sourceType: 'observer',
      collectorId: `${runId}-collector`,
      nodeName: `${runId}-node`,
      workspacePath: `/workspace/${runId}`,
      attribution: {
        monitored: true,
        classification: 'confirmed_agent',
        agentScopeId: runId,
        agentDisplayName: runId,
        rootPid: 74991,
        confidence: 1,
        reason: 'authoritative_anchor',
        source: 'self_register',
        evidence: [`runtime-contract:${runId}`],
      },
    },
  });
  assert.equal(ingested.accepted, true);

  const deadline = Date.now() + Number(process.env.ANYSENTRY_L2_RUNTIME_TIMEOUT_MS ?? 90_000);
  let event;
  while (Date.now() < deadline) {
    const response = await request('/events/list', {
      body: {
        timeType: 'last_3h',
        scope: 'raw',
        includeUnknown: true,
        durable: true,
        q: runId,
        limit: 10,
      },
    });
    event = response.items.find((item) => item.eventId === ingested.eventId);
    if (event?.decisionStatus === 'succeeded') break;
    if (event?.decisionStatus === 'failed') throw new Error(`L2 runtime judgment failed: ${event.reason}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  assert.ok(event, 'runtime probe event was not stored');
  assert.equal(event.decisionStatus, 'succeeded', JSON.stringify(event));
  assert.equal(event.judgment?.l1Verdict, 'escalate');
  assert.equal(event.tier, 'Llm', `expected the A3S Code L2 stage to terminate the benign probe: ${JSON.stringify(event)}`);
  assert.equal(event.verdict, 'allow');
  console.log(JSON.stringify({
    eventId: event.eventId,
    decisionStatus: event.decisionStatus,
    l1Verdict: event.judgment.l1Verdict,
    tier: event.tier,
    verdict: event.verdict,
    latencyMs: event.latencyMs,
  }, null, 2));
  console.log('A3S Code L2 runtime verification passed');
} finally {
  await request('/config', { method: 'PUT', body: originalPolicy });
}
