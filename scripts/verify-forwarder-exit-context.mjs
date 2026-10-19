import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const spool = await mkdtemp(join(tmpdir(), 'anysentry-exit-context-'));
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
  child = spawn(process.execPath, ['scripts/observer-forward.js'], { env: {
    ...process.env, ANYSENTRY_INGEST_URL: `${base}/ingest`, ANYSENTRY_BATCH_INGEST_URL: `${base}/ingest/batch`,
    ANYSENTRY_IDENTITY_SNAPSHOT_URL: `${base}/identity/snapshot`, ANYSENTRY_DOCKER_DISCOVERY: 'off',
    ANYSENTRY_INTERACTIONS: 'off', FORWARD_AGENT_ALLOWLIST: 'kimi-cli', FORWARD_FILTER_MODE: 'enforce',
    FORWARD_BATCH_FLUSH_MS: '5', FORWARD_SPOOL_PATH: join(spool, 'events.wal'),
    FORWARD_SHUTDOWN_TIMEOUT_MS: '3000',
  } });
  let stderr = '';
  child.stdout.resume(); child.stderr.on('data', chunk => { stderr += chunk; });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`forwarder exit=${code}: ${stderr.slice(-1800)}`)));
  });
  const fixtureProcess = { hostId: 'host-fixture', bootId: 'boot-fixture', pid: 880901, ppid: 1,
    cgroupId: '601', comm: 'kimi-code', exe: '/opt/kimi-code/bin/kimi-code',
    startTimeTicks: '1234', pidNamespace: 'pidns-fixture', namespacePid: 21, cwd: '/workspace' };
  const root = { identity: { agent: 'runtime', task: '880901', session: null }, process: fixtureProcess,
    event: { ToolExec: { pid: 880901, ppid: 1, argv: ['kimi-code'] } } };
  const exit = { ...root, process: { hostId: 'host-fixture', bootId: 'boot-fixture', pid: 880901,
    ppid: 0, cgroupId: '601', comm: 'kimi-code' }, event: { ProcessExit: { pid: 880901, exit_code: 0, signal: 0 } } };
  child.stdin.end(JSON.stringify(root) + '\n' + JSON.stringify(exit) + '\n');
  let timer;
  try {
    await Promise.race([done, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('forwarder context test timed out')), 10000);
    })]);
  } finally { clearTimeout(timer); }
  const forwarded = received.map(item => JSON.parse(item.line));
  const terminal = forwarded.find(event => event.event.ProcessExit);
  assert.ok(terminal, 'ProcessExit must reach the API lane');
  assert.equal(terminal.process.startTimeTicks, '1234');
  assert.equal(terminal.process.pidNamespace, 'pidns-fixture');
  assert.equal(terminal.process.namespacePid, 21);
  assert.equal(terminal.process.ppid, 1);
  console.log('PASS real Forwarder subprocess preserves exact cached exit context without crashing');
} finally {
  if (child && child.exitCode === null) child.kill('SIGKILL');
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(spool, { recursive: true, force: true });
}
