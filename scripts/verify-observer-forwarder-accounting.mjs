#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function eventually(label, predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function requestJson(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : undefined;
}

function json(res, statusCode, value) {
  const body = JSON.stringify(value);
  res.writeHead(statusCode, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function stage(envelope, name) {
  return envelope.stages.find((item) => item.stage === name);
}

const heartbeats = [];
const batches = [];
let failedShutdownFinal = false;
const server = http.createServer(async (req, res) => {
  try {
    const body = await requestJson(req);
    if (req.url === '/heartbeat') {
      heartbeats.push(body);
      // Establish one clean baseline, fail a non-empty delta, then accept its exact retry and the
      // following active window.
      const failFinal = body.filterMetrics?.shutdownFinal === true && !failedShutdownFinal;
      if (failFinal) failedShutdownFinal = true;
      const failed = heartbeats.length === 2 || failFinal;
      json(res, failed ? 503 : 200, { accepted: !failed });
      return;
    }
    if (req.url === '/security-center/ingest/batch') {
      batches.push(body);
      const events = body.events ?? [];
      json(res, 200, {
        accepted: events.length > 0,
        batchId: body.batchId,
        payloadDigest: body.payloadDigest,
        acceptedEvents: events.length,
        retainedEvents: events.length,
        discardedEvents: 0,
        rejectedEvents: 0,
        retryableEvents: 0,
        items: events.map((_, index) => ({ index, accepted: true, disposition: 'retained' })),
      });
      return;
    }
    if (req.url === '/security-center/runtime/lease') {
      json(res, 200, { data: { accepted: true, leaseEpoch: 1 } });
      return;
    }
    if (req.url === '/security-center/runtime/snapshot') {
      json(res, 200, { data: { accepted: true, applied: true } });
      return;
    }
    json(res, 200, { data: {} });
  } catch (error) {
    json(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
assert.ok(address && typeof address === 'object');
const baseUrl = `http://127.0.0.1:${address.port}`;

const child = spawn(process.execPath, ['scripts/observer-forward.js'], {
  cwd: repoRoot,
  env: {
    ...process.env,
    ANYSENTRY_INGEST_URL: `${baseUrl}/security-center/ingest`,
    ANYSENTRY_HEARTBEAT_URL: `${baseUrl}/heartbeat`,
    ANYSENTRY_HEARTBEAT_SECS: '0.2',
    ANYSENTRY_IDENTITY_SNAPSHOT_SECS: '0',
    ANYSENTRY_INFRASTRUCTURE_POLICY_SECS: '0',
    ANYSENTRY_FILTER_RULE_PROJECTION_SECS: '0',
    ANYSENTRY_AGENT_RUNTIME_SNAPSHOT_SECS: '300',
    ANYSENTRY_AGENT_RUNTIME_LIVENESS_SECS: '300',
    ANYSENTRY_DOCKER_SOCKET: '/tmp/anysentry-accounting-no-docker.sock',
    A3S_OBSERVER_COLLECTOR_ID: 'accounting-forwarder',
    A3S_NODE_NAME: 'accounting-node',
    FORWARD_FILTER_MODE: 'shadow',
    FORWARD_BATCH_FLUSH_MS: '5',
    FORWARD_SHUTDOWN_TIMEOUT_MS: '15000',
  },
  stdio: ['pipe', 'ignore', 'pipe'],
});
let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => { stderr += chunk; });

const rawCollectorAccounting = {
  schemaVersion: 'anysentry.pipeline_accounting.v1',
  producer: 'observer',
  producerInstanceId: 'raw-observer-instance',
  sequence: 41,
  window: { startedAtUnixMs: 10, endedAtUnixMs: 20 },
  temporality: 'delta',
  unit: { ring: 'physical_record', queue: 'logical_event' },
  rings: [{
    ring: 'exec',
    ringSubmitted: 4,
    ringDropped: 1,
    collectorReceived: 3,
    logicalEvents: 2,
    queueAdmitted: 2,
    queueDropped: 0,
  }],
};
const rawCollectorLine = JSON.stringify({
  identity: { agent: 'collector' },
  event: { CollectorHeartbeat: { pipelineAccounting: rawCollectorAccounting } },
});
const firstToolLine = JSON.stringify({
  identity: { agent: 'unsigned-agent' },
  event: { ToolExec: { pid: 991_001, ppid: 1, uid: 1000, argv: ['echo', 'first-window'] } },
});
const secondToolLine = JSON.stringify({
  identity: { agent: 'unsigned-agent' },
  event: { ToolExec: { pid: 991_002, ppid: 1, uid: 1000, argv: ['echo', 'second-window'] } },
});

try {
  await eventually('initial successful heartbeat', () => heartbeats.length >= 1);
  child.stdin.write(`${firstToolLine}\n${rawCollectorLine}\n`);

  await eventually('failed non-empty heartbeat', () => heartbeats.length >= 2);
  assert.equal(heartbeats[1].eventKindCounts.ToolExec, 1);
  assert.equal(heartbeats[1].filterMetrics.observed, 1);
  assert.equal(heartbeats[1].pipelineAccounting.sequence, 2);
  assert.equal(stage(heartbeats[1].pipelineAccounting, 'received').count, 2);
  assert.equal(stage(heartbeats[1].pipelineAccounting, 'classified').count, 2);
  child.stdin.write(`${secondToolLine}\n`);

  await eventually('exact retry heartbeat', () => heartbeats.length >= 3);
  assert.deepEqual(
    heartbeats[2],
    heartbeats[1],
    'a failed heartbeat must retry the full legacy and additive payload without clearing it',
  );

  await eventually('next active heartbeat window', () => heartbeats.length >= 4);
  assert.equal(heartbeats[3].pipelineAccounting.sequence, 3);
  assert.equal(heartbeats[3].eventKindCounts.ToolExec, 1);
  assert.equal(heartbeats[3].filterMetrics.observed, 1);
  assert.equal(heartbeats[3].legacyCounterTemporality, 'delta');
  assert.equal(
    heartbeats[3].outputDropped,
    0,
    'failed heartbeat transport must not be reported as event output loss',
  );
  assert.ok(
    heartbeats[3].filterMetrics.heartbeatDeliveryFailures >= 1,
    'failed heartbeat transport is reported on its dedicated control metric',
  );
  assert.ok(heartbeats[3].errorCount >= 1, 'failed heartbeat error is counted in the next delta');

  await eventually('forwarded raw collector heartbeat', () =>
    batches.some((batch) => batch.events?.some((event) => event.line === rawCollectorLine)));
  const forwardedRaw = batches
    .flatMap((batch) => batch.events ?? [])
    .find((event) => event.line === rawCollectorLine);
  assert.ok(forwardedRaw, 'raw CollectorHeartbeat line must be forwarded');
  assert.deepEqual(
    JSON.parse(forwardedRaw.line).event.CollectorHeartbeat.pipelineAccounting,
    rawCollectorAccounting,
    'Forwarder must preserve the Observer pipelineAccounting envelope byte semantics',
  );

  child.stdin.end();
  const exit = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({ timeout: true }), 20_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  if (exit.timeout) child.kill('SIGKILL');
  assert.deepEqual(exit, { code: 0, signal: null }, `forwarder failed: ${stderr}`);
  const finalHeartbeats = heartbeats.filter((heartbeat) => heartbeat.filterMetrics?.shutdownFinal === true);
  assert.equal(finalHeartbeats.length, 2, 'failed shutdown-final heartbeat must be retried once');
  assert.deepEqual(finalHeartbeats[1], finalHeartbeats[0], 'shutdown-final retry must preserve its exact payload');
} finally {
  if (!child.killed && child.exitCode === null) child.kill('SIGKILL');
  await new Promise((resolve) => server.close(resolve));
}

console.log('Observer Forwarder heartbeat accounting integration verification passed');
