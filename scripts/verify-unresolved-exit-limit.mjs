#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DurableSpool } = require('./observer-durable-spool.js');

const workspace = await mkdtemp(join(tmpdir(), 'anysentry-unresolved-exit-limit-'));
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
const replaySpool = new DurableSpool({ writerId: 'replay-test', filePath: join(workspace, 'events.wal') });
const replayBootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
for (const [pid, classification, cgroupId] of [[1, 'non_agent', 'evaluation-cgroup'], [93004, 'unknown', 'limit-cgroup']]) {
  replaySpool.put({
    id: `replay-${pid}`,
    priority: 4,
    queuedAt: Date.now(),
    body: {
      line: JSON.stringify({
        process: {
          hostId: 'replay-host', bootId: replayBootId, pid, comm: 'git', cgroupId,
          startBoottimeNs: String(10_000_000_000 + pid), lifecycleReason: 'ancestry_incomplete',
        },
        event: { ProcessExit: { pid, exit_code: 0, signal: 0 } },
      }),
      sourceEventId: `replay-${pid}`,
      attribution: { classification },
    },
  });
}
replaySpool.close();
let child;
try {
  const diagnosticsPath = join(workspace, 'pipeline.json');
  child = spawn(process.execPath, ['scripts/observer-forward.js'], { env: {
    ...process.env,
    ANYSENTRY_INGEST_URL: `${base}/ingest`,
    ANYSENTRY_BATCH_INGEST_URL: `${base}/ingest/batch`,
    ANYSENTRY_IDENTITY_SNAPSHOT_URL: `${base}/identity/snapshot`,
    ANYSENTRY_DOCKER_DISCOVERY: 'off',
    ANYSENTRY_INTERACTIONS: 'off',
    ANYSENTRY_UNRESOLVED_EXIT_LIMIT: '2',
    ANYSENTRY_EVALUATION_LIFECYCLE_CGROUP_IDS: 'evaluation-cgroup',
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
    hostId: 'limit-host',
    bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
    cgroupId: 'limit-cgroup',
    userHz: 100,
  };
  for (const pid of [93001, 93002, 93003]) {
    child.stdin.write(`${JSON.stringify({
      process: { ...common, pid, comm: 'git', startBoottimeNs: String(10_000_000_000 + pid) },
      event: { ProcessExit: { pid, exit_code: 0, signal: 0 } },
    })}\n`);
  }
  child.stdin.end();
  let timer;
  try {
    await Promise.race([done, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('unresolved exit limit test timed out')), 10000);
    })]);
  } finally { clearTimeout(timer); }
  const forwarded = received.map(item => JSON.parse(item.line));
  const exits = forwarded.filter(event => event.event.ProcessExit).map(event => event.process.pid);
  assert.deepEqual(new Set(exits), new Set([93001, 93002, 93004, 1]));
  const receipts = JSON.parse(await readFile(diagnosticsPath, 'utf8'));
  assert.ok(receipts.some(item => item.pid === 93001 && item.stage === 'unresolved_exit_retained'));
  assert.ok(receipts.some(item => item.pid === 93003 && item.stage === 'filtered' && item.reason === 'unresolved_exit_capacity'));
  for (const event of forwarded) {
    assert.notEqual(event.attribution?.classification, 'confirmed_agent');
    assert.notEqual(event.attribution?.classification, 'probable_agent');
  }
  console.log('PASS bounded unresolved exits are retained without Agent attribution and excess is explicit');
} finally {
  if (child && child.exitCode === null) child.kill('SIGKILL');
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(workspace, { recursive: true, force: true });
}
