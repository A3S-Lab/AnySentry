#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workspace = await mkdtemp(join(tmpdir(), 'anysentry-attribution-retry-'));
const received = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    const events = body ? JSON.parse(body).events ?? [] : [];
    if (req.url.endsWith('/ingest/batch')) received.push(...events);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ code: 200, data: {
      accepted: true, acceptedEvents: events.length, rejectedEvents: 0, retryableEvents: 0,
      items: events.map((_, index) => ({ index, accepted: true })),
      schemaVersion: 'anysentry.workload_identity_snapshot.v1', version: 1, ready: true, entries: [],
    } }));
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/security-center`;
let child;
try {
  const diagnosticsPath = join(workspace, 'pipeline.json');
  child = spawn(process.execPath, ['scripts/observer-forward.js'], { env: {
    ...process.env,
    A3S_OBSERVER_HOST_ID: 'retry-host',
    ANYSENTRY_INGEST_URL: `${base}/ingest`,
    ANYSENTRY_BATCH_INGEST_URL: `${base}/ingest/batch`,
    ANYSENTRY_IDENTITY_SNAPSHOT_URL: `${base}/identity/snapshot`,
    ANYSENTRY_DOCKER_DISCOVERY: 'off',
    ANYSENTRY_INTERACTIONS: 'off',
    ANYSENTRY_EVALUATION_LIFECYCLE_CGROUP_IDS: 'retry-cgroup',
    ANYSENTRY_PIPELINE_DIAGNOSTICS_PATH: diagnosticsPath,
    FORWARD_AGENT_ALLOWLIST: 'kimi-cli',
    FORWARD_FILTER_MODE: 'enforce',
    FORWARD_BATCH_FLUSH_MS: '5',
    FORWARD_SPOOL_PATH: join(workspace, 'events.wal'),
    FORWARD_SHUTDOWN_TIMEOUT_MS: '3000',
  } });
  let stderr = '';
  child.stdout.resume();
  child.stderr.on('data', chunk => { stderr += chunk; });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`forwarder exit=${code}: ${stderr.slice(-1800)}`)));
  });
  const common = {
    hostId: 'retry-host',
    bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
    cgroupId: 'retry-cgroup',
    userHz: 100,
  };
  const childExit = {
    process: { ...common, pid: 92002, ppid: 92001, creationPpid: 92001,
      creationParentStartBoottimeNs: '10000000000', startBoottimeNs: '10010000000', comm: 'git' },
    event: { ProcessExit: { pid: 92002, exit_code: 0, signal: 0 } },
  };
  const rootExec = {
    process: { ...common, pid: 92001, ppid: 1, startBoottimeNs: '10000000000', comm: 'kimi', exe: '/opt/kimi', cwd: '/workspace' },
    event: { ToolExec: { pid: 92001, ppid: 1, argv: ['kimi'] } },
  };
  child.stdin.write(`${JSON.stringify(childExit)}\n`);
  await new Promise(resolve => setTimeout(resolve, 50));
  child.stdin.write(`${JSON.stringify(rootExec)}\n`);
  await new Promise(resolve => setTimeout(resolve, 200));
  child.stdin.end();
  let timer;
  try {
    await Promise.race([done, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('attribution retry test timed out')), 10000);
    })]);
  } finally { clearTimeout(timer); }
  const forwarded = received.map(item => JSON.parse(item.line));
  const receipts = JSON.parse(await readFile(diagnosticsPath, 'utf8'));
  assert.ok(forwarded.some(event => event.event.ProcessExit?.pid === 92002), JSON.stringify({ forwarded, receipts }));
  assert.ok(receipts.some(item => item.pid === 92002 && item.stage === 'evaluation_lifecycle_retained'));
  assert.ok(receipts.some(item => item.pid === 92002 && item.stage === 'ingest_accepted'));
  console.log('PASS scoped unresolved exit is retained without inventing Agent attribution');
} finally {
  if (child && child.exitCode === null) child.kill('SIGKILL');
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(workspace, { recursive: true, force: true });
}
