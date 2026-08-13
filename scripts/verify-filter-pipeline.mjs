#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const forwarder = fileURLToPath(new URL('./observer-forward.js', import.meta.url));

function event(session, kind, payload) {
  return JSON.stringify({
    identity: { agent: 'runtime', task: String(payload.pid), session },
    process: {
      host_id: 'node-test',
      boot_id: 'boot-test',
      pid: payload.pid,
      ppid: 1,
      start_time_ticks: String(payload.pid * 10),
      comm: 'worker',
      exe: '/usr/bin/worker',
      cgroup_id: payload.pid,
      cgroup: `0::/docker/${session}`,
    },
    event: { [kind]: payload },
  });
}

async function runConfig(label, env = {}) {
  const batches = [];
  const heartbeats = [];
  let resolveSnapshotRequested;
  const snapshotRequested = new Promise((resolve) => {
    resolveSnapshotRequested = resolve;
  });
  const snapshot = {
    schemaVersion: 'anysentry.workload_identity_snapshot.v1',
    version: 1,
    generatedAt: new Date().toISOString(),
    ready: true,
    errors: 0,
    entries: [
      {
        ids: ['nonagent-container'],
        classification: 'non_agent',
        physicalWorkloadId: 'docker:test:nonagent',
        source: 'docker',
        environment: 'docker',
        evidence: ['explicit:test'],
      },
      {
        ids: ['unknown-container'],
        classification: 'unknown',
        physicalWorkloadId: 'docker:test:unknown',
        source: 'docker',
        environment: 'docker',
        evidence: ['discovery:test'],
      },
    ],
  };
  const server = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url.startsWith('/security-center/identity/snapshot')) {
      resolveSnapshotRequested();
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(snapshot));
      return;
    }
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      const parsed = body ? JSON.parse(body) : {};
      if (request.url === '/security-center/ingest/batch') batches.push(...(parsed.events ?? []));
      if (request.url === '/security-center/collectors/heartbeat') heartbeats.push(parsed);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      if (request.url === '/security-center/runtime/lease') {
        response.end('{"accepted":true,"leaseEpoch":1}');
      } else if (request.url === '/security-center/runtime/snapshot') {
        response.end('{"accepted":true,"applied":true,"duplicate":false}');
      } else {
        response.end('{"accepted":true}');
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const api = `http://127.0.0.1:${address.port}/security-center/ingest`;
  const child = spawn(process.execPath, [forwarder], {
    env: {
      ...process.env,
      FORWARD_FILTER_MODE: 'enforce',
      FORWARD_RETAIN_UNKNOWN: 'true',
      FORWARD_RETAIN_NON_AGENT: 'false',
      FORWARD_NOISE_POLICY: 'balanced',
      ...env,
      FORWARD_BATCH_SIZE: '32',
      FORWARD_BATCH_FLUSH_MS: '5',
      ANYSENTRY_INGEST_URL: api,
      ANYSENTRY_IDENTITY_SNAPSHOT_SECS: '0.05',
      ANYSENTRY_HEARTBEAT_SECS: '0.05',
      ANYSENTRY_DOCKER_DISCOVERY: 'off',
      ANYSENTRY_BEHAVIOR_DISCOVERY: 'off',
      ANYSENTRY_AGENT_TEMPLATES_JSON: '[]',
      A3S_OBSERVER_COLLECTOR_ID: `filter-${label}`,
    },
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  await snapshotRequested;
  await new Promise((resolve) => setTimeout(resolve, 20));
  const lines = [
    event('nonagent-container', 'ToolExec', { pid: 10, argv: ['true'] }),
    event('unknown-container', 'FileAccess', { pid: 20, path: '/workspace/a', write: true }),
    event('unknown-container', 'FileAccess', { pid: 20, path: '/workspace/b', write: true }),
    event('unknown-container', 'FileAccess', { pid: 20, path: '/proc/status', write: false }),
    event('unknown-container', 'FileDelete', { pid: 20, path: '/proc/important' }),
    event('unknown-container', 'SecurityAction', { pid: 20, kind: 'setuid' }),
  ];
  child.stdin.end(`${lines.join('\n')}\n`);
  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`forwarder ${label} timed out: ${stderr}`));
    }, 5_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  await new Promise((resolve) => server.close(resolve));
  assert.equal(exitCode, 0, stderr);
  const heartbeat = [...heartbeats]
    .reverse()
    .find((candidate) => candidate.filterMetrics?.observed === lines.length);
  assert.ok(heartbeat, `missing structured ${label} heartbeat: ${JSON.stringify(heartbeats)}`);
  return { batches, heartbeat };
}

async function runManualReviewRecovery() {
  const batches = [];
  const heartbeats = [];
  let snapshotVersion = 1;
  let resolveInitialSnapshot;
  let resolveRecoverySnapshot;
  const initialSnapshot = new Promise((resolve) => {
    resolveInitialSnapshot = resolve;
  });
  const recoverySnapshot = new Promise((resolve) => {
    resolveRecoverySnapshot = resolve;
  });
  const server = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url.startsWith('/security-center/identity/snapshot')) {
      const classification = snapshotVersion === 1 ? 'non_agent' : 'unknown';
      const snapshot = {
        schemaVersion: 'anysentry.workload_identity_snapshot.v1',
        version: snapshotVersion,
        generatedAt: new Date().toISOString(),
        ready: true,
        errors: 0,
        entries: [{
          ids: ['reviewed-container'],
          classification,
          physicalWorkloadId: 'docker:test:reviewed',
          source: 'docker',
          attributionSource: 'manual_review',
          environment: 'docker',
          evidence: [`manual:${classification}`],
        }],
      };
      if (snapshotVersion === 1) resolveInitialSnapshot();
      else resolveRecoverySnapshot();
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(snapshot));
      return;
    }
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      const parsed = body ? JSON.parse(body) : {};
      if (request.url === '/security-center/ingest/batch') batches.push(...(parsed.events ?? []));
      if (request.url === '/security-center/collectors/heartbeat') heartbeats.push(parsed);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      if (request.url === '/security-center/runtime/lease') {
        response.end('{"accepted":true,"leaseEpoch":1}');
      } else if (request.url === '/security-center/runtime/snapshot') {
        response.end('{"accepted":true,"applied":true,"duplicate":false}');
      } else {
        response.end('{"accepted":true}');
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const child = spawn(process.execPath, [forwarder], {
    env: {
      ...process.env,
      FORWARD_FILTER_MODE: 'enforce',
      FORWARD_RETAIN_UNKNOWN: 'true',
      FORWARD_RETAIN_NON_AGENT: 'false',
      FORWARD_NOISE_POLICY: 'balanced',
      FORWARD_BATCH_SIZE: '1',
      FORWARD_BATCH_FLUSH_MS: '1',
      ANYSENTRY_INGEST_URL: `http://127.0.0.1:${address.port}/security-center/ingest`,
      ANYSENTRY_IDENTITY_SNAPSHOT_SECS: '0.02',
      ANYSENTRY_HEARTBEAT_SECS: '60',
      ANYSENTRY_DOCKER_DISCOVERY: 'off',
      ANYSENTRY_BEHAVIOR_DISCOVERY: 'on',
      ANYSENTRY_AGENT_TEMPLATES_JSON: '[]',
      A3S_OBSERVER_COLLECTOR_ID: 'filter-manual-recovery',
    },
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  await initialSnapshot;
  await new Promise((resolve) => setTimeout(resolve, 20));
  child.stdin.write(`${event('reviewed-container', 'ToolExec', { pid: 30, argv: ['blocked'] })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 40));
  snapshotVersion = 2;
  await recoverySnapshot;
  await new Promise((resolve) => setTimeout(resolve, 20));
  child.stdin.end(`${event('reviewed-container', 'ToolExec', { pid: 31, argv: ['observed-again'] })}\n`);

  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`manual review recovery timed out: ${stderr}`));
    }, 5_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  await new Promise((resolve) => server.close(resolve));
  assert.equal(exitCode, 0, stderr);
  assert.equal(batches.length, 1, 'manual non-Agent is suppressed until it returns to Unknown');
  const recovered = JSON.parse(batches[0].line);
  assert.deepEqual(recovered.event.ToolExec.argv, ['observed-again']);
  assert.equal(batches[0].attribution?.classification, 'unknown');
  assert.equal(batches[0].attribution?.source, 'manual_review');
  const heartbeat = heartbeats.find((candidate) => candidate.filterMetrics?.lastSuppressedAt);
  assert.ok(heartbeat, `missing manual suppression heartbeat: ${JSON.stringify(heartbeats)}`);
  assert.match(heartbeat?.filterMetrics?.lastSuppressedAt ?? '', /^\d{4}-\d{2}-\d{2}T/u);
}

const include = await runConfig('include', {
  FORWARD_RETAIN_NON_AGENT: 'true',
  FORWARD_NOISE_POLICY: 'include',
});
assert.equal(include.batches.length, 6);
assert.equal(include.heartbeat.filterMetrics.filteredNonAgent, 0);
assert.equal(include.heartbeat.filterMetrics.filteredNoise, 0);

const shadow = await runConfig('shadow', { FORWARD_FILTER_MODE: 'shadow' });
assert.equal(shadow.batches.length, 6, 'shadow forwards every retention decision');
assert.equal(shadow.heartbeat.filterMetrics.wouldFilterNonAgent, 1);
assert.equal(shadow.heartbeat.filterMetrics.wouldFilterNoise, 1);
assert.equal(shadow.heartbeat.filterMetrics.filteredNonAgent, 0);
assert.equal(shadow.heartbeat.filterMetrics.filteredNoise, 0);

const safeDefault = await runConfig('safe-default', { FORWARD_FILTER_MODE: '' });
assert.equal(safeDefault.heartbeat.filterMetrics.filterMode, 'shadow');
assert.equal(safeDefault.batches.length, 6, 'an unset filter mode must fail safe to shadow');
assert.equal(safeDefault.heartbeat.filterMetrics.filteredNonAgent, 0);
assert.equal(safeDefault.heartbeat.filterMetrics.wouldFilterNonAgent, 1);

const defaultRetention = await runConfig('default');
assert.equal(defaultRetention.batches.length, 4);
assert.equal(defaultRetention.heartbeat.filterMetrics.filteredNonAgent, 1);
assert.equal(defaultRetention.heartbeat.filterMetrics.filteredNoise, 1);
assert.equal(defaultRetention.heartbeat.filterMetrics.unknown, 5);
assert.equal(defaultRetention.heartbeat.filterMetrics.discoveryBudgetDropped, 0);
assert.match(defaultRetention.heartbeat.filterMetrics.lastSuppressedAt, /^\d{4}-\d{2}-\d{2}T/u);
assert.ok(
  defaultRetention.batches.some((item) => JSON.parse(item.line).event.FileDelete),
  'high-value FileDelete survives even for a pseudo-filesystem path',
);
assert.ok(
  defaultRetention.batches.some((item) => JSON.parse(item.line).event.SecurityAction),
  'SecurityAction survives unknown routing',
);

await runManualReviewRecovery();

console.log('Independent retention/noise/shadow pipeline verification passed');
