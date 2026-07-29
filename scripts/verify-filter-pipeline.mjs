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

async function runScope(scope) {
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
      response.end('{"accepted":true}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const api = `http://127.0.0.1:${address.port}/security-center/ingest`;
  const child = spawn(process.execPath, [forwarder], {
    env: {
      ...process.env,
      FORWARD_SCOPE: scope,
      FORWARD_BATCH_SIZE: '32',
      FORWARD_BATCH_FLUSH_MS: '5',
      FORWARD_UNKNOWN_FILE_BUDGET_PER_SEC: '1',
      ANYSENTRY_INGEST_URL: api,
      ANYSENTRY_IDENTITY_SNAPSHOT_SECS: '0.05',
      ANYSENTRY_HEARTBEAT_SECS: '0.05',
      ANYSENTRY_DOCKER_DISCOVERY: 'off',
      ANYSENTRY_BEHAVIOR_DISCOVERY: 'off',
      ANYSENTRY_AGENT_TEMPLATES_JSON: '[]',
      A3S_OBSERVER_COLLECTOR_ID: `filter-${scope}`,
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
    event('unknown-container', 'FileDelete', { pid: 20, path: '/proc/important' }),
    event('unknown-container', 'SecurityAction', { pid: 20, kind: 'setuid' }),
  ];
  child.stdin.end(`${lines.join('\n')}\n`);
  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`forwarder ${scope} timed out: ${stderr}`));
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
  assert.ok(heartbeat, `missing structured ${scope} heartbeat: ${JSON.stringify(heartbeats)}`);
  return { batches, heartbeat };
}

const all = await runScope('all');
assert.equal(all.batches.length, 5);
assert.equal(all.heartbeat.filterMetrics.filteredNonAgent, 0);
assert.equal(all.heartbeat.filterMetrics.wouldFilterNonAgent, 0);

const shadow = await runScope('shadow');
assert.equal(shadow.batches.length, 5, 'shadow forwards every routing decision');
assert.equal(shadow.heartbeat.filterMetrics.wouldFilterNonAgent, 1);
assert.equal(shadow.heartbeat.filterMetrics.wouldDiscoveryBudgetDrop, 1);
assert.equal(shadow.heartbeat.filterMetrics.filteredNonAgent, 0);
assert.equal(shadow.heartbeat.filterMetrics.discoveryBudgetDropped, 0);

const agent = await runScope('agent');
assert.equal(agent.batches.length, 3);
assert.equal(agent.heartbeat.filterMetrics.filteredNonAgent, 1);
assert.equal(agent.heartbeat.filterMetrics.discoveryBudgetDropped, 1);
assert.equal(agent.heartbeat.filterMetrics.wouldFilterNonAgent, 0);
assert.ok(
  agent.batches.some((item) => JSON.parse(item.line).event.FileDelete),
  'high-value FileDelete survives even for a pseudo-filesystem path',
);
assert.ok(
  agent.batches.some((item) => JSON.parse(item.line).event.SecurityAction),
  'SecurityAction survives unknown routing',
);

console.log('Filter all/shadow/agent pipeline verification passed');
