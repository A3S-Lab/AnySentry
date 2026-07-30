#!/usr/bin/env node

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const baseUrl = (process.env.ANYSENTRY_API_BASE
  ?? 'http://127.0.0.1:29653/security-center').replace(/\/$/, '');
const workspacePath = process.env.ANYSENTRY_SUPPLY_CHAIN_VERIFY_WORKSPACE
  ?? '/home/zhongyule/code/AnySentry';
const runId = `flink-${Date.now()}-${randomUUID().slice(0, 8)}-supply-chain`;
const agentId = `${runId}-agent`;
const sessionId = `${runId}-session`;

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

function line(event) {
  return JSON.stringify({
    identity: { agent: agentId, session: sessionId, task: `${runId}-task` },
    process: {
      pid: 74001,
      ppid: 73999,
      uid: 1000,
      comm: 'supply-chain-verifier',
      exe: '/usr/bin/supply-chain-verifier',
      cwd: workspacePath,
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
      rootPid: 74001,
      confidence: 0.99,
      reason: 'authoritative_anchor',
      source: 'self_register',
    },
  });
  assert.equal(result.accepted, true, JSON.stringify(result));
  assert.ok(result.eventId);
  return result.eventId;
}

const overview = await request('/supply-chain/overview');
assert.equal(overview.enabled, true);
assert.equal(overview.runtimeCorrelationEnabled, true);
const finding = overview.findings.find((item) =>
  item.status === 'open'
  && item.component?.ecosystem?.toLowerCase() === 'npm'
  && item.component?.packageName);
assert.ok(finding, 'an open npm OSV finding is required for this runtime verification');

const packageLeaf = finding.component.packageName.split('/').pop();
const executable = `${workspacePath}/node_modules/.bin/${packageLeaf}`;
const source = await request('/sources', {
  name: `${runId} runtime verifier`,
  type: 'observer',
  enabled: true,
  requireToken: false,
  collectorId: `${runId}-collector`,
  workspacePath,
  owner: 'verify-supply-chain-runtime',
  tags: ['streaming-phase2', 'supply-chain-runtime', runId],
});
const sourceId = source.source?.sourceId;
assert.ok(sourceId, JSON.stringify(source));

await ingest(sourceId, `${runId}-component`, {
  ToolExec: {
    pid: 74001,
    uid: 1000,
    cwd: workspacePath,
    argv: [executable, '--version'],
    exec_confirmed: true,
  },
});
await ingest(sourceId, `${runId}-egress`, {
  ToolExec: {
    pid: 74001,
    uid: 1000,
    cwd: workspacePath,
    argv: ['curl', 'https://example.com/supply-chain-runtime-verification'],
    exec_confirmed: true,
  },
});

const deadline = Date.now() + Number(process.env.ANYSENTRY_STREAM_VERIFY_TIMEOUT_MS ?? 150_000);
while (Date.now() < deadline) {
  const findings = await request('/stream/findings', { timeType: 'last_3h', limit: 200 });
  const judgment = findings.compositeJudgments?.find((item) =>
    item.agentType === agentId
    && item.ruleVersion === 'supply-chain-exploit-v1'
    && item.status === 'succeeded');
  if (judgment) {
    const matches = judgment.evidence.flatMap((item) => item.runtimeVulnerabilities ?? []);
    assert.equal(judgment.shadow, true);
    assert.equal(judgment.synthetic, true);
    assert.equal(judgment.decisionSource, 'composite_judge');
    assert.equal(judgment.classification, 'simulation');
    assert.equal(judgment.verdict, 'allow');
    const runtimeMatch = matches.find((item) =>
      item.packageName === finding.component.packageName
      && item.version === finding.component.version
      && item.vulnerabilityId === finding.vulnerability.id);
    assert.ok(runtimeMatch);
    assert.ok(runtimeMatch.dependencySnapshotId);
    assert.ok(runtimeMatch.vulnerabilityAssessmentId);
    console.log(JSON.stringify({
      runId,
      sourceId,
      episodeId: judgment.episodeId,
      ruleVersion: judgment.ruleVersion,
      decisionSource: judgment.decisionSource,
      packageName: finding.component.packageName,
      packageVersion: finding.component.version,
      vulnerabilityId: finding.vulnerability.id,
      dependencySnapshotId: runtimeMatch.dependencySnapshotId,
      vulnerabilityAssessmentId: runtimeMatch.vulnerabilityAssessmentId,
    }, null, 2));
    console.log('Supply-chain runtime correlation verification passed');
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}

throw new Error(`supply-chain runtime judgment was not produced within the deadline for ${runId}`);
