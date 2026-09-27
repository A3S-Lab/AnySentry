#!/usr/bin/env node

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const baseUrl = (process.env.ANYSENTRY_API_BASE
  ?? 'http://127.0.0.1:29653/security-center').replace(/\/$/, '');
const runId = `flink-${Date.now()}-${randomUUID().slice(0, 8)}-temporal-v2`;
const positiveAgent = `${runId}-positive`;
const negativeAgent = `${runId}-negative`;
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

async function createSource(agent) {
  const result = await request('/sources', {
    name: `${agent} verifier`,
    type: 'observer',
    enabled: true,
    requireToken: false,
    collectorId: `${agent}-collector`,
    workspacePath,
    owner: 'verify-temporal-episode-v2-runtime',
    tags: ['temporal-episode-v2', runId],
  });
  assert.ok(result.source?.sourceId, JSON.stringify(result));
  return result.source.sourceId;
}

function observerLine(agent, process, event) {
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
      startTimeNs: String(1_785_100_000_000_000_000n + BigInt(process.pid)),
    },
    event,
  });
}

async function ingest(sourceId, agent, suffix, rootPid, process, event) {
  const result = await request('/ingest', {
    line: observerLine(agent, process, event),
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
      rootPid,
      confidence: 0.99,
      reason: 'authoritative_anchor',
      source: 'self_register',
    },
  });
  assert.equal(result.accepted, true, JSON.stringify(result));
  return result.eventId;
}

async function positiveSequences(sourceId) {
  await ingest(sourceId, positiveAgent, 'persistence-write', 81_000, {
    pid: 81_001, ppid: 81_000, executable: 'installer',
  }, {
    FileAccess: {
      pid: 81_001,
      ppid: 81_000,
      uid: 1000,
      path: '/etc/systemd/system/anysentry-temporal-v2.service',
      write: true,
    },
  });
  await ingest(sourceId, positiveAgent, 'persistence-activate', 81_000, {
    pid: 81_002, ppid: 81_000, executable: 'systemctl',
  }, {
    ToolExec: {
      pid: 81_002,
      ppid: 81_000,
      uid: 1000,
      cwd: workspacePath,
      argv: ['systemctl', 'enable', '/etc/systemd/system/anysentry-temporal-v2.service'],
      exec_confirmed: true,
    },
  });
  // Replay the same stable source event after completion. Canonical and Flink
  // deduplication must keep the Episode immutable and unique.
  await ingest(sourceId, positiveAgent, 'persistence-write', 81_000, {
    pid: 81_001, ppid: 81_000, executable: 'installer',
  }, {
    FileAccess: {
      pid: 81_001,
      ppid: 81_000,
      uid: 1000,
      path: '/etc/systemd/system/anysentry-temporal-v2.service',
      write: true,
    },
  });

  await ingest(sourceId, positiveAgent, 'sandbox-probe', 82_000, {
    pid: 82_001, ppid: 82_000, executable: 'unshare',
  }, {
    ToolExec: {
      pid: 82_001,
      ppid: 82_000,
      uid: 1000,
      cwd: workspacePath,
      argv: ['unshare', '--user', '--mount', '/bin/sh'],
      exec_confirmed: true,
    },
  });
  await ingest(sourceId, positiveAgent, 'privilege-change', 82_000, {
    pid: 82_002, ppid: 82_000, executable: 'sudo',
  }, {
    ToolExec: {
      pid: 82_002,
      ppid: 82_000,
      uid: 1000,
      cwd: workspacePath,
      argv: ['sudo', '-n', 'bash'],
      exec_confirmed: true,
    },
  });
  await ingest(sourceId, positiveAgent, 'privileged-consequence', 82_000, {
    pid: 82_003, ppid: 82_000, executable: 'cat',
  }, {
    FileAccess: {
      pid: 82_003,
      ppid: 82_000,
      uid: 1000,
      path: '/etc/shadow',
      write: false,
    },
  });

  await ingest(sourceId, positiveAgent, 'target-discovery', 83_000, {
    pid: 83_001, ppid: 83_000, executable: 'find',
  }, {
    ToolExec: {
      pid: 83_001,
      ppid: 83_000,
      uid: 1000,
      cwd: workspacePath,
      argv: ['find', '/tmp/anysentry-temporal-v2-victim', '-type', 'f'],
      exec_confirmed: true,
    },
  });
  await ingest(sourceId, positiveAgent, 'destroy-command', 83_000, {
    pid: 83_002, ppid: 83_000, executable: 'rm',
  }, {
    ToolExec: {
      pid: 83_002,
      ppid: 83_000,
      uid: 1000,
      cwd: workspacePath,
      argv: ['rm', '-f', '/tmp/anysentry-temporal-v2-victim/a'],
      exec_confirmed: true,
    },
  });
  await ingest(sourceId, positiveAgent, 'destroy-observed', 83_000, {
    pid: 83_002, ppid: 83_000, executable: 'rm',
  }, {
    FileDelete: {
      pid: 83_002,
      ppid: 83_000,
      uid: 1000,
      path: '/tmp/anysentry-temporal-v2-victim/a',
    },
  });

  const sshKey = '/home/anysentry/.ssh/id_temporal_v2';
  await ingest(sourceId, positiveAgent, 'credential-read', 84_000, {
    pid: 84_001, ppid: 84_000, executable: 'cat',
  }, {
    FileAccess: {
      pid: 84_001,
      ppid: 84_000,
      uid: 1000,
      path: sshKey,
      write: false,
    },
  });
  await ingest(sourceId, positiveAgent, 'remote-connect', 84_000, {
    pid: 84_002, ppid: 84_000, executable: 'ssh',
  }, {
    ToolExec: {
      pid: 84_002,
      ppid: 84_000,
      uid: 1000,
      cwd: workspacePath,
      argv: ['ssh', '-i', sshKey, '-N', '10.0.0.8'],
      exec_confirmed: true,
    },
  });
  await ingest(sourceId, positiveAgent, 'remote-action', 84_000, {
    pid: 84_003, ppid: 84_000, executable: 'ssh',
  }, {
    ToolExec: {
      pid: 84_003,
      ppid: 84_000,
      uid: 1000,
      cwd: workspacePath,
      argv: ['ssh', '-i', sshKey, '10.0.0.8', 'id'],
      exec_confirmed: true,
    },
  });
}

async function negativeSequences(sourceId) {
  await ingest(sourceId, negativeAgent, 'persistence-write', 91_000, {
    pid: 91_001, ppid: 91_000, executable: 'installer',
  }, {
    FileAccess: {
      pid: 91_001, ppid: 91_000, uid: 1000,
      path: '/etc/systemd/system/negative-a.service', write: true,
    },
  });
  await ingest(sourceId, negativeAgent, 'persistence-activate', 91_000, {
    pid: 91_002, ppid: 91_000, executable: 'systemctl',
  }, {
    ToolExec: {
      pid: 91_002, ppid: 91_000, uid: 1000, cwd: workspacePath,
      argv: ['systemctl', 'enable', '/etc/systemd/system/negative-b.service'],
      exec_confirmed: true,
    },
  });

  await ingest(sourceId, negativeAgent, 'sandbox-probe', 92_000, {
    pid: 92_001, ppid: 92_000, executable: 'unshare',
  }, {
    ToolExec: {
      pid: 92_001, ppid: 92_000, uid: 1000, cwd: workspacePath,
      argv: ['unshare', '--user', '/bin/sh'], exec_confirmed: true,
    },
  });
  await ingest(sourceId, negativeAgent, 'privilege-change', 92_000, {
    pid: 92_002, ppid: 92_000, executable: 'sudo',
  }, {
    ToolExec: {
      pid: 92_002, ppid: 92_000, uid: 1000, cwd: workspacePath,
      argv: ['sudo', '-n', 'bash'], exec_confirmed: true,
    },
  });
  await ingest(sourceId, negativeAgent, 'privileged-consequence', 92_100, {
    pid: 92_103, ppid: 92_100, executable: 'cat',
  }, {
    FileAccess: {
      pid: 92_103, ppid: 92_100, uid: 1000, path: '/etc/shadow', write: false,
    },
  });

  await ingest(sourceId, negativeAgent, 'target-discovery', 93_000, {
    pid: 93_001, ppid: 93_000, executable: 'find',
  }, {
    ToolExec: {
      pid: 93_001, ppid: 93_000, uid: 1000, cwd: workspacePath,
      argv: ['find', '/tmp/negative-a', '-type', 'f'], exec_confirmed: true,
    },
  });
  await ingest(sourceId, negativeAgent, 'destroy-a', 93_000, {
    pid: 93_002, ppid: 93_000, executable: 'rm',
  }, {
    ToolExec: {
      pid: 93_002, ppid: 93_000, uid: 1000, cwd: workspacePath,
      argv: ['rm', '-f', '/tmp/negative-a/a'], exec_confirmed: true,
    },
  });
  await ingest(sourceId, negativeAgent, 'destroy-b', 93_000, {
    pid: 93_003, ppid: 93_000, executable: 'rm',
  }, {
    ToolExec: {
      pid: 93_003, ppid: 93_000, uid: 1000, cwd: workspacePath,
      argv: ['rm', '-f', '/tmp/negative-b/b'], exec_confirmed: true,
    },
  });

  const sshKey = '/home/anysentry/.ssh/id_temporal_v2_negative';
  await ingest(sourceId, negativeAgent, 'credential-read', 94_000, {
    pid: 94_001, ppid: 94_000, executable: 'cat',
  }, {
    FileAccess: {
      pid: 94_001, ppid: 94_000, uid: 1000, path: sshKey, write: false,
    },
  });
  await ingest(sourceId, negativeAgent, 'remote-connect', 94_000, {
    pid: 94_002, ppid: 94_000, executable: 'ssh',
  }, {
    ToolExec: {
      pid: 94_002, ppid: 94_000, uid: 1000, cwd: workspacePath,
      argv: ['ssh', '-i', sshKey, '-N', '10.0.0.8'], exec_confirmed: true,
    },
  });
  await ingest(sourceId, negativeAgent, 'remote-action', 94_000, {
    pid: 94_003, ppid: 94_000, executable: 'ssh',
  }, {
    ToolExec: {
      pid: 94_003, ppid: 94_000, uid: 1000, cwd: workspacePath,
      argv: ['ssh', '-i', sshKey, '10.0.0.9', 'id'], exec_confirmed: true,
    },
  });
}

const positiveSource = await createSource(positiveAgent);
const negativeSource = await createSource(negativeAgent);
await positiveSequences(positiveSource);
await negativeSequences(negativeSource);

const signatures = new Map([
  ['file_write,persistence_activate', {
    candidateType: 'persistence_installation',
    attackType: 'persistence-installation',
  }],
  ['sandbox_probe,privilege_change,file_read', {
    candidateType: 'sandbox_privilege_breakout',
    attackType: 'sandbox-privilege-breakout',
  }],
  ['target_discovery,destroy,destroy', {
    candidateType: 'destructive_behavior',
    attackType: 'destructive-behavior',
  }],
  ['file_read,remote_connect,remote_execute', {
    candidateType: 'lateral_movement',
    attackType: 'lateral-movement',
  }],
]);
const deadline = Date.now() + Number(process.env.ANYSENTRY_STREAM_VERIFY_TIMEOUT_MS ?? 120_000);
let accepted = [];
while (Date.now() < deadline) {
  const findings = await request('/stream/findings', { timeType: 'last_3h', limit: 200 });
  const judgments = findings.compositeJudgments ?? [];
  accepted = judgments.filter((item) =>
    item.agentType === positiveAgent
    && item.ruleVersion === 'temporal-episode-v2'
    && item.status === 'succeeded');
  const detected = new Set(accepted.map((item) =>
    signatures.get(item.evidence.map((evidence) => evidence.operation).join(','))?.candidateType));
  const negative = judgments.filter((item) =>
    item.agentType === negativeAgent
    && item.ruleVersion === 'temporal-episode-v2');
  if (detected.size === 4) {
    assert.equal(negative.length, 0, 'broken entity/process relationships must not form v2 Episodes');
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}

const results = accepted.map((item) => {
  const signature = item.evidence.map((evidence) => evidence.operation).join(',');
  const expected = signatures.get(signature);
  return {
    candidateType: expected?.candidateType,
    attackType: item.attackType,
    expectedAttackType: expected?.attackType,
    episodeId: item.episodeId,
    evidence: item.evidence.map((evidence) => evidence.operation),
    decisionSource: item.decisionSource,
    classification: item.classification,
  };
});
assert.equal(results.length, 4, 'replayed evidence must not create duplicate v2 Episodes');
assert.deepEqual(
  new Set(results.map((item) => item.candidateType)),
  new Set([...signatures.values()].map((item) => item.candidateType)),
  `missing Temporal v2 Episodes: ${JSON.stringify(results)}`,
);
for (const result of results) {
  assert.equal(result.decisionSource, 'deterministic_rule');
  assert.equal(result.classification, 'simulation');
  assert.equal(result.attackType, result.expectedAttackType);
}
console.log(JSON.stringify({ runId, positiveAgent, negativeAgent, results }, null, 2));
console.log('Temporal Episode v2 unified runtime verification passed');
