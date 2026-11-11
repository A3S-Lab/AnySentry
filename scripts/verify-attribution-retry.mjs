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
    ANYSENTRY_ATTRIBUTION_RETRY_DELAY_MS: '10',
    ANYSENTRY_ATTRIBUTION_RETRY_MAX_ATTEMPTS: '10000',
    ANYSENTRY_ATTRIBUTION_RETRY_MAX_AGE_MS: '200',
    ANYSENTRY_UNRESOLVED_EXIT_LIMIT: '1000',
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
  const childExec = {
    process: { ...childExit.process, cgroupId: 'agent-only-cgroup' },
    event: { ToolExec: { pid: 92002, ppid: 92001, argv: ['git', 'status'], exec_confirmed: true } },
  };
  const wrongGenerationExec = {
    process: { ...childExec.process, pid: 92003, creationParentStartBoottimeNs: '99999999999' },
    event: { ToolExec: { pid: 92003, ppid: 92001, argv: ['git', 'diff'], exec_confirmed: true } },
  };
  const lateUnresolvedExit = {
    process: { ...childExit.process, pid: 92004, startBoottimeNs: '10040000000', cgroupId: 'agent-only-cgroup', creationPpid: 99999999, creationParentStartBoottimeNs: '99999999999' },
    event: { ProcessExit: { pid: 92004, exit_code: 0, signal: 0 } },
  };
  const lateUnresolvedExec = {
    process: lateUnresolvedExit.process,
    event: { ToolExec: { pid: 92004, ppid: 99999999, argv: ['git', 'show'], exec_confirmed: true } },
  };
  const exhaustedUnresolvedExec = {
    process: { ...lateUnresolvedExit.process, pid: 92005, ppid: 99999999, startBoottimeNs: '10050000000' },
    event: { ToolExec: { pid: 92005, ppid: 99999999, argv: ['long-running-check'], exec_confirmed: true } },
  };
  const delayedRootExec = {
    process: { ...common, pid: 92007, ppid: 1, startBoottimeNs: '10070000000', comm: 'kimi', exe: '/opt/kimi', cwd: '/workspace' },
    event: { ToolExec: { pid: 92007, ppid: 1, argv: ['kimi'] } },
  };
  const delayedWindowExec = {
    process: { ...common, pid: 92006, ppid: 92007, creationPpid: 92007,
      creationParentStartBoottimeNs: '10070000000', startBoottimeNs: '10060000000', comm: 'gcc', cgroupId: 'agent-only-cgroup' },
    event: { ToolExec: { pid: 92006, ppid: 92007, argv: ['gcc', '-v'], exec_confirmed: true } },
  };
  child.stdin.write(`${JSON.stringify(childExec)}\n`);
  child.stdin.write(`${JSON.stringify(wrongGenerationExec)}\n`);
  child.stdin.write(`${JSON.stringify(childExit)}\n`);
  child.stdin.write(`${JSON.stringify(lateUnresolvedExit)}\n`);
  child.stdin.write(`${JSON.stringify(lateUnresolvedExec)}\n`);
  child.stdin.write(`${JSON.stringify(exhaustedUnresolvedExec)}\n`);
  child.stdin.write(`${JSON.stringify(delayedWindowExec)}\n`);
  await new Promise(resolve => setTimeout(resolve, 20));
  child.stdin.write(`${JSON.stringify(rootExec)}\n`);
  await new Promise(resolve => setTimeout(resolve, 100));
  child.stdin.write(`${JSON.stringify(delayedRootExec)}\n`);
  await new Promise(resolve => setTimeout(resolve, 100));
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
  assert.ok(forwarded.some(event => event.event.ToolExec?.pid === 92002), 'late parent must unblock exact child exec');
  assert.ok(forwarded.some(event => event.event.ToolExec?.pid === 92006), 'parent inside the bounded age window must unblock child exec');
  assert.ok(!forwarded.some(event => event.event.ToolExec?.pid === 92006 && event.process.lifecycleReason), 'age-window exec resolved by parent must not stay unresolved');
  assert.ok(!forwarded.some(event => event.event.ToolExec?.pid === 92003), 'wrong parent generation must stay filtered');
  assert.ok(!forwarded.some(event => event.event.ToolExec?.pid === 92002 && event.process.lifecycleReason), 'resolved exec must not stay unresolved');
  assert.ok(forwarded.some(event => event.event.ToolExec?.pid === 92004 && event.process.lifecycleReason === 'ancestry_incomplete'), `unresolved exit must retain its exact-generation late exec: ${JSON.stringify({ forwarded, receipts })}`);
  assert.ok(forwarded.some(event => event.event.ToolExec?.pid === 92005 && event.process.lifecycleReason === 'ancestry_incomplete'), `retry exhaustion must not silently drop a generation-complete exec: ${JSON.stringify({ forwarded, receipts })}`);
  assert.ok(forwarded.every(event => event.event.ToolExec?.pid !== 92005 || !['confirmed_agent', 'probable_agent'].includes(event.attribution?.classification)), 'unresolved exec must not gain Agent attribution');
  assert.ok(receipts.some(item => item.pid === 92005 && item.stage === 'unresolved_exec_retained'));
  assert.ok(receipts.some(item => item.pid === 92004 && item.stage === 'unresolved_exec_retained'));
  assert.ok(receipts.some(item => item.pid === 92002 && item.stage === 'attribution_deferred'));
  assert.ok(receipts.some(item => item.pid === 92002 && item.stage === 'evaluation_lifecycle_retained'));
  assert.ok(receipts.some(item => item.pid === 92002 && item.stage === 'ingest_accepted'));
  console.log('PASS scoped unresolved exit and bounded parent-order exec retry');
} finally {
  if (child && child.exitCode === null) child.kill('SIGKILL');
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(workspace, { recursive: true, force: true });
}
