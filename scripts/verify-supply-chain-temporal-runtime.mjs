#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Kafka, logLevel } from 'kafkajs';

const baseUrl = (process.env.ANYSENTRY_API_BASE
  ?? 'http://127.0.0.1:29653/security-center').replace(/\/$/, '');
const brokers = (process.env.ANYSENTRY_STREAM_BOOTSTRAP_SERVERS ?? 'kafka:9092')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const contextTopic = process.env.ANYSENTRY_SUPPLY_CHAIN_CONTEXT_TOPIC
  ?? 'anysentry.supply-chain.context.v1';
const runId = `flink-${Date.now()}-${randomUUID().slice(0, 8)}-supply-chain-v2`;
const workspacePath = `/tmp/${runId}-workspace`;
const agentId = `${runId}-agent`;
const negativeAgentId = `${runId}-negative-agent`;

function fingerprint(path) {
  return `sha256:${createHash('sha256').update(path).digest('hex')}`;
}

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

function line(agent, process, event) {
  return JSON.stringify({
    identity: { agent, session: `${agent}-session`, task: `${agent}-task` },
    process: {
      uid: 1000,
      comm: process.executable,
      exe: `/usr/bin/${process.executable}`,
      cwd: workspacePath,
      hostId: `${runId}-node`,
      bootId: `${runId}-boot`,
      pid: process.pid,
      ppid: process.ppid,
      startTimeNs: String(1_785_000_000_000_000_000n + BigInt(process.pid)),
    },
    event,
  });
}

async function source(agent) {
  const result = await request('/sources', {
    name: `${agent} runtime verifier`,
    type: 'observer',
    enabled: true,
    requireToken: false,
    collectorId: `${agent}-collector`,
    workspacePath,
    owner: 'verify-supply-chain-temporal-runtime',
    tags: ['supply-chain-temporal-v2', runId],
  });
  assert.ok(result.source?.sourceId, JSON.stringify(result));
  return result.source.sourceId;
}

async function ingest(sourceId, agent, suffix, process, event) {
  const result = await request('/ingest', {
    line: line(agent, process, event),
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
      rootPid: 70000,
      confidence: 0.99,
      reason: 'authoritative_anchor',
      source: 'self_register',
    },
  });
  assert.equal(result.accepted, true, JSON.stringify(result));
  return result.eventId;
}

const kafka = new Kafka({
  clientId: `anysentry-${runId}`,
  brokers,
  logLevel: logLevel.NOTHING,
});
const producer = kafka.producer({ idempotent: true, maxInFlightRequests: 1 });
await producer.connect();
try {
  await producer.send({
    topic: contextTopic,
    acks: -1,
    messages: [{
      key: fingerprint(workspacePath),
      value: JSON.stringify({
        schemaVersion: 'anysentry.supply_chain_runtime_context.v1',
        workspaceId: `${runId}-workspace`,
        workspacePathFingerprint: fingerprint(workspacePath),
        dependencySnapshotId: `${runId}-deps`,
        vulnerabilityAssessmentId: `${runId}-assessment`,
        assessedAt: Date.now(),
        assessmentStatus: 'complete',
        intelligenceRevision: `${runId}-intelligence`,
        findings: [{
          findingId: `${runId}-finding`,
          ecosystem: 'npm',
          packageName: 'verify-vulnerable',
          version: '1.0.0',
          dependencyScope: 'runtime',
          direct: true,
          purl: 'pkg:npm/verify-vulnerable@1.0.0',
          vulnerabilityId: 'GHSA-verify-temporal-v2',
          aliases: [],
          summary: 'Synthetic Temporal v2 verification finding',
        }],
        shadow: true,
      }),
    }],
  });
} finally {
  await producer.disconnect();
}

// The context and canonical events are independent Kafka inputs. Give the
// broadcast context enough time to reach every enrichment subtask before
// publishing the synthetic runtime evidence.
await new Promise((resolve) => setTimeout(resolve, 5_000));

const positiveSource = await source(agentId);
await ingest(positiveSource, agentId, 'component', {
  pid: 70100,
  ppid: 70000,
  executable: 'verify-vulnerable',
}, {
  ToolExec: {
    pid: 70100,
    ppid: 70000,
    uid: 1000,
    cwd: workspacePath,
    argv: [`${workspacePath}/node_modules/.bin/verify-vulnerable`, '--version'],
    exec_confirmed: true,
  },
});
await ingest(positiveSource, agentId, 'shell', {
  pid: 70101,
  ppid: 70100,
  executable: 'bash',
}, {
  ToolExec: {
    pid: 70101,
    ppid: 70100,
    uid: 1000,
    cwd: workspacePath,
    argv: ['bash', '-c', 'printf supply-chain-temporal-v2'],
    exec_confirmed: true,
  },
});
await ingest(positiveSource, agentId, 'egress', {
  pid: 70102,
  ppid: 70101,
  executable: 'curl',
}, {
  ToolExec: {
    pid: 70102,
    ppid: 70101,
    uid: 1000,
    cwd: workspacePath,
    argv: ['curl', 'https://example.com/supply-chain-temporal-v2'],
    exec_confirmed: true,
  },
});

const negativeSource = await source(negativeAgentId);
await ingest(negativeSource, negativeAgentId, 'component', {
  pid: 70200,
  ppid: 70000,
  executable: 'verify-vulnerable',
}, {
  ToolExec: {
    pid: 70200,
    ppid: 70000,
    uid: 1000,
    cwd: workspacePath,
    argv: [`${workspacePath}/node_modules/.bin/verify-vulnerable`, '--version'],
    exec_confirmed: true,
  },
});
await ingest(negativeSource, negativeAgentId, 'unrelated-shell', {
  pid: 70301,
  ppid: 70300,
  executable: 'bash',
}, {
  ToolExec: {
    pid: 70301,
    ppid: 70300,
    uid: 1000,
    cwd: workspacePath,
    argv: ['bash', '-c', 'printf unrelated'],
    exec_confirmed: true,
  },
});
await ingest(negativeSource, negativeAgentId, 'egress', {
  pid: 70302,
  ppid: 70301,
  executable: 'curl',
}, {
  ToolExec: {
    pid: 70302,
    ppid: 70301,
    uid: 1000,
    cwd: workspacePath,
    argv: ['curl', 'https://example.com/unrelated'],
    exec_confirmed: true,
  },
});

const deadline = Date.now() + Number(process.env.ANYSENTRY_STREAM_VERIFY_TIMEOUT_MS ?? 120_000);
let positive;
while (Date.now() < deadline) {
  const findings = await request('/stream/findings', { timeType: 'last_3h', limit: 200 });
  positive = findings.compositeJudgments?.find((item) =>
    item.agentType === agentId
    && item.ruleVersion === 'supply-chain-temporal-v2'
    && item.status === 'succeeded');
  if (positive) {
    const negative = findings.compositeJudgments?.find((item) =>
      item.agentType === negativeAgentId
      && item.ruleVersion === 'supply-chain-temporal-v2');
    assert.equal(negative, undefined, 'unrelated process lineage must not form a v2 Episode');
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}

assert.ok(positive, `supply-chain Temporal v2 judgment was not produced for ${runId}`);
assert.equal(positive.synthetic, true);
assert.equal(positive.shadow, true);
assert.equal(positive.decisionSource, 'deterministic_rule');
assert.equal(positive.classification, 'simulation');
assert.equal(positive.verdict, 'allow');
assert.equal(positive.attackType, 'known-vulnerability-exploitation');
assert.equal(positive.evidence.length, 3);
console.log(JSON.stringify({
  runId,
  episodeId: positive.episodeId,
  ruleVersion: positive.ruleVersion,
  decisionSource: positive.decisionSource,
  classification: positive.classification,
  evidence: positive.evidence.map((item) => ({
    eventId: item.eventId,
    executable: item.executable,
    pid: item.processIdentity?.pid,
    ppid: item.processIdentity?.ppid,
  })),
}, null, 2));
console.log('Supply-chain Temporal v2 runtime verification passed');
