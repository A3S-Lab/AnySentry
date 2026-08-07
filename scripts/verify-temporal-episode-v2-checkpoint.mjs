#!/usr/bin/env node

import assert from 'node:assert/strict';

const baseUrl = (process.env.ANYSENTRY_API_BASE
  ?? 'http://127.0.0.1:29653/security-center').replace(/\/$/, '');
const phase = process.env.ANYSENTRY_TEMPORAL_CHECKPOINT_PHASE ?? 'seed';
const runId = process.env.ANYSENTRY_TEMPORAL_CHECKPOINT_RUN_ID;
const existingSourceId = process.env.ANYSENTRY_TEMPORAL_CHECKPOINT_SOURCE_ID;
assert.ok(runId, 'ANYSENTRY_TEMPORAL_CHECKPOINT_RUN_ID is required');
const agent = `flink-${runId}-checkpoint`;
const workspacePath = `/tmp/${runId}-workspace`;

async function request(path, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : undefined;
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${text}`);
  return payload?.data ?? payload;
}

async function source() {
  if (existingSourceId) return existingSourceId;
  const result = await request('/sources', {
    name: `${agent} verifier`,
    type: 'observer',
    enabled: true,
    requireToken: false,
    collectorId: `${agent}-collector`,
    workspacePath,
    owner: 'verify-temporal-episode-v2-checkpoint',
    tags: ['temporal-episode-v2', 'checkpoint', runId],
  });
  assert.ok(result.source?.sourceId, JSON.stringify(result));
  return result.source.sourceId;
}

async function ingest(sourceId, suffix, process, event) {
  const result = await request('/ingest', {
    line: JSON.stringify({
      identity: { agent, session: `${agent}-session`, task: `${agent}-task` },
      process: {
        uid: 1000,
        comm: process.executable,
        exe: `/usr/bin/${process.executable}`,
        cwd: workspacePath,
        hostId: `${runId}-node`,
        bootId: `${runId}-boot`,
        pid: process.pid,
        ppid: 85_000,
        startTimeNs: String(1_785_200_000_000_000_000n + BigInt(process.pid)),
      },
      event,
    }),
    sourceEventId: `${agent}-${suffix}`,
    sourceId,
    collectorId: `${agent}-collector`,
    nodeName: `${runId}-node`,
    sourceType: 'observer',
    workspacePath,
    attribution: {
      monitored: true,
      agentScopeId: agent,
      agentDisplayName: agent,
      agentSessionId: `${agent}-session`,
      rootPid: 85_000,
      confidence: 0.99,
      reason: 'authoritative_anchor',
      source: 'self_register',
    },
  });
  assert.equal(result.accepted, true, JSON.stringify(result));
}

const sourceId = await source();
const target = '/etc/systemd/system/anysentry-checkpoint.service';
if (phase === 'seed') {
  await ingest(sourceId, 'write', { pid: 85_001, executable: 'installer' }, {
    FileAccess: {
      pid: 85_001,
      ppid: 85_000,
      uid: 1000,
      path: target,
      write: true,
    },
  });
  console.log(JSON.stringify({ phase, runId, agent, sourceId }));
  process.exit(0);
}
assert.equal(phase, 'complete', 'phase must be seed or complete');
await ingest(sourceId, 'activate', { pid: 85_002, executable: 'systemctl' }, {
  ToolExec: {
    pid: 85_002,
    ppid: 85_000,
    uid: 1000,
    cwd: workspacePath,
    argv: ['systemctl', 'enable', target],
    exec_confirmed: true,
  },
});

const deadline = Date.now() + 90_000;
let judgment;
while (Date.now() < deadline) {
  const findings = await request('/stream/findings', { timeType: 'last_3h', limit: 200 });
  judgment = findings.compositeJudgments?.find((item) =>
    item.agentType === agent
    && item.ruleVersion === 'temporal-episode-v2'
    && item.status === 'succeeded');
  if (judgment) break;
  await new Promise((resolve) => setTimeout(resolve, 500));
}
assert.ok(judgment, `checkpoint-restored persistence Episode was not produced for ${agent}`);
assert.deepEqual(
  judgment.evidence.map((item) => item.operation),
  ['file_write', 'persistence_activate'],
);
console.log(JSON.stringify({
  phase,
  runId,
  agent,
  sourceId,
  episodeId: judgment.episodeId,
  decisionSource: judgment.decisionSource,
}, null, 2));
console.log('Temporal Episode v2 checkpoint recovery verification passed');
