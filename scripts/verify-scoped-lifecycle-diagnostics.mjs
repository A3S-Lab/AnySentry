#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PipelineDiagnostics } = require('./observer-pipeline-diagnostics.js');
const workspace = await mkdtemp(join(tmpdir(), 'anysentry-lifecycle-diagnostics-'));
try {
  const boundedPath = join(workspace, 'bounded.json');
  const diagnostics = new PipelineDiagnostics({ filePath: boundedPath, maxRecords: 1000, flushMs: 10 });
  for (let index = 0; index < 1005; index++) {
    diagnostics.record({ sourceEventId: `evt-${index}`, process: { pid: index } }, 'filtered', 'test');
  }
  diagnostics.close();
  const bounded = JSON.parse(await readFile(boundedPath, 'utf8'));
  assert.equal(bounded.length, 1000);
  assert.equal(bounded.at(-1).sourceEventId, 'evt-1004');
  assert.ok(!JSON.stringify(bounded).includes('argv'));

  const lanesPath = join(workspace, 'lanes.json');
  const lanes = new PipelineDiagnostics({ filePath: lanesPath, maxRecords: 2, flushMs: 10 });
  for (let index = 0; index < 5; index++) {
    lanes.record({ eventKind: 'ProcessExit', process: { pid: 70000 + index } }, 'filtered', 'agent_allowlist');
    lanes.record({ eventKind: 'FileAccess', process: { pid: 80000 + index } }, 'filtered', 'agent_allowlist');
  }
  lanes.record({ eventKind: 'ProcessExit', process: { pid: 91001 } }, 'ingest_accepted', 'accepted');
  lanes.close();
  const laneRecords = JSON.parse(await readFile(lanesPath, 'utf8'));
  assert.ok(laneRecords.some(item => item.pid === 91001 && item.stage === 'ingest_accepted'));
  assert.ok(laneRecords.length <= 6);

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
  const diagnosticsPath = join(workspace, 'pipeline.json');
  try {
    child = spawn(process.execPath, ['scripts/observer-forward.js'], { env: {
      ...process.env,
      ANYSENTRY_UNRESOLVED_EXIT_LIMIT: '0',
      ANYSENTRY_INGEST_URL: `${base}/ingest`,
      ANYSENTRY_BATCH_INGEST_URL: `${base}/ingest/batch`,
      ANYSENTRY_IDENTITY_SNAPSHOT_URL: `${base}/identity/snapshot`,
      ANYSENTRY_DOCKER_DISCOVERY: 'off',
      ANYSENTRY_INTERACTIONS: 'off',
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
    const makeExit = (pid, cgroupId) => ({
      process: { hostId: 'scope-host', bootId: 'scope-boot', pid, comm: 'gcc', cgroupId, startBoottimeNs: String(10_000_000_000 + pid) },
      event: { ProcessExit: { pid, exit_code: 0, signal: 0 } },
    });
    child.stdin.end(`${JSON.stringify(makeExit(91001, 'evaluation-cgroup'))}\n${JSON.stringify(makeExit(1, 'evaluation-cgroup'))}\n${JSON.stringify(makeExit(91002, 'other-cgroup'))}\n`);
    let timer;
    try {
      await Promise.race([done, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('scoped lifecycle test timed out')), 10000);
      })]);
    } finally { clearTimeout(timer); }
    const forwarded = received.map(item => JSON.parse(item.line));
    const exits = forwarded.filter(event => event.event.ProcessExit);
    assert.equal(exits.length, 2);
    assert.deepEqual(new Set(exits.map(event => event.process.pid)), new Set([91001, 1]));
    assert.ok(exits.every(event => event.process.lifecycleReason === 'ancestry_incomplete'));
    const receipts = JSON.parse(await readFile(diagnosticsPath, 'utf8'));
    assert.ok(receipts.some(item => item.pid === 91001 && item.stage === 'evaluation_lifecycle_retained'));
    assert.ok(receipts.some(item => item.pid === 91001 && item.stage === 'queue_admitted'), JSON.stringify(receipts));
    assert.ok(receipts.some(item => item.pid === 91001 && item.stage === 'ingest_accepted'));
    assert.ok(receipts.some(item => item.pid === 91002 && item.stage === 'filtered' && item.reason === 'unresolved_exit_disabled' && item.classification === 'unknown'), JSON.stringify(receipts));
    assert.ok(!receipts.some(item => item.pid === 91002 && item.stage === 'attribution_pending'));
    assert.ok(!JSON.stringify(receipts).includes('argv'));
  } finally {
    if (child && child.exitCode === null) child.kill('SIGKILL');
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  console.log('PASS bounded diagnostics and evaluation-cgroup-only unknown lifecycle retention');
} finally {
  await rm(workspace, { recursive: true, force: true });
}
