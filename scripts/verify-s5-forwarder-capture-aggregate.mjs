#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

async function eventually(label, predicate, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const batches = [];
const batchHeaders = [];
const heartbeats = [];
let identityRequests = 0;
const server = http.createServer(async (request, response) => {
  let raw = '';
  for await (const chunk of request) raw += chunk;
  const body = raw ? JSON.parse(raw) : undefined;
  if (request.url?.startsWith('/security-center/identity/snapshot')) {
    identityRequests++;
    json(response, 200, {
      schemaVersion: 'anysentry.workload_identity_snapshot.v1',
      version: 1,
      generatedAt: new Date().toISOString(),
      ready: true,
      errors: 0,
      entries: [{
        ids: ['infra-container', '4242'],
        classification: 'non_agent',
        physicalWorkloadId: 'docker:node-a:infra-container',
        source: 'docker',
        environment: 'docker',
        evidence: ['fixture:exact-inventory'],
      }],
    });
    return;
  }
  if (request.url === '/security-center/ingest/batch') {
    batches.push(body);
    batchHeaders.push(request.headers);
    const events = body.events ?? [];
    json(response, 200, {
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
  if (request.url === '/security-center/collectors/heartbeat') {
    heartbeats.push(body);
    json(response, 200, { accepted: true });
    return;
  }
  if (request.url === '/security-center/runtime/lease') {
    json(response, 200, { accepted: true, leaseEpoch: 1 });
    return;
  }
  if (request.url === '/security-center/runtime/snapshot') {
    json(response, 200, { accepted: true, applied: true, duplicate: false });
    return;
  }
  json(response, 200, {});
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
assert.ok(address && typeof address === 'object');
const base = `http://127.0.0.1:${address.port}/security-center`;
const credentialDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'anysentry-forwarder-credentials-'));
const credentialFile = path.join(credentialDirectory, 'observer-sources.json');
fs.writeFileSync(credentialFile, JSON.stringify({
  schemaVersion: 'anysentry.observer_source_credentials.v1',
  credentials: [{
    collectorId: 'capture-aggregate-forwarder',
    sourceId: 'managed-capture-source',
    token: 'managed-capture-token',
  }],
}), { mode: 0o600 });
const child = spawn(process.execPath, ['scripts/observer-forward.js'], {
  cwd: repoRoot,
  env: {
    ...process.env,
    ANYSENTRY_INGEST_URL: `${base}/ingest`,
    ANYSENTRY_BATCH_INGEST_URL: `${base}/ingest/batch`,
    ANYSENTRY_HEARTBEAT_URL: `${base}/collectors/heartbeat`,
    ANYSENTRY_IDENTITY_SNAPSHOT_URL: `${base}/identity/snapshot`,
    ANYSENTRY_AGENT_RUNTIME_SNAPSHOT_URL: `${base}/runtime/snapshot`,
    ANYSENTRY_AGENT_RUNTIME_LEASE_URL: `${base}/runtime/lease`,
    ANYSENTRY_IDENTITY_SNAPSHOT_SECS: '0.05',
    ANYSENTRY_INFRASTRUCTURE_POLICY_SECS: '0',
    ANYSENTRY_HEARTBEAT_SECS: '0.05',
    ANYSENTRY_AGENT_RUNTIME_SNAPSHOT_SECS: '300',
    ANYSENTRY_AGENT_RUNTIME_LIVENESS_SECS: '300',
    ANYSENTRY_DOCKER_DISCOVERY: 'off',
    ANYSENTRY_BEHAVIOR_DISCOVERY: 'off',
    ANYSENTRY_AGENT_TEMPLATES_JSON: '[]',
    FORWARD_FILTER_MODE: 'enforce',
    FORWARD_RETAIN_NON_AGENT: 'false',
    FORWARD_NOISE_POLICY: 'balanced',
    FORWARD_FILE_AGGREGATION: 'true',
    FORWARD_BATCH_SIZE: '1',
    FORWARD_BATCH_FLUSH_MS: '1',
    FORWARD_SHUTDOWN_TIMEOUT_MS: '5000',
    A3S_OBSERVER_COLLECTOR_ID: 'capture-aggregate-forwarder',
    A3S_NODE_NAME: 'node-a',
    ANYSENTRY_SOURCE_CREDENTIALS_FILE: credentialFile,
  },
  stdio: ['pipe', 'ignore', 'pipe'],
});
let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => { stderr += chunk; });

const aggregate = JSON.stringify({
  identity: { agent: null, task: null, session: 'infra-container' },
  process: { host_id: 'node-a', boot_id: 'boot-a', cgroup_id: '4242' },
  event: {
    CaptureAggregate: {
      windowStartUnixNs: 1_777_000_000_000_000_000,
      windowStartUnixNsExact: '1777000000000000001',
      windowEndUnixNs: 1_777_000_001_000_000_000,
      windowEndUnixNsExact: '1777000001000000001',
      cgroupId: 4242,
      probe: 'file_access',
      effectiveAction: 'aggregate',
      qualifier: 1,
      profile: 'infrastructure_aggregate',
      epoch: 7001,
      policyVersion: 7,
      count: 123,
      bytes: 4096,
      authority: 'authoritative',
      reason: 'platform_infrastructure',
      terminal: false,
    },
  },
});
const rawNoise = JSON.stringify({
  identity: { agent: null, task: null, session: 'infra-container' },
  process: {
    host_id: 'node-a', boot_id: 'boot-a', pid: 4500, ppid: 1,
    start_time_ticks: '45000', cgroup_id: '4242', cgroup: '0::/docker/infra-container',
  },
  event: { FileAccess: { pid: 4500, path: '/var/lib/clickhouse/noise', flags: 1 } },
});

try {
  await eventually('identity snapshot readiness', () => identityRequests > 0);
  child.stdin.write(`${aggregate}\n${rawNoise}\n`);
  const forwarded = await eventually('CaptureAggregate batch', () => batches
    .flatMap((batch) => batch.events ?? [])
    .find((event) => event.line === aggregate));
  assert.ok(forwarded);
  assert.equal(batchHeaders.at(-1)?.['x-anysentry-source-id'], 'managed-capture-source');
  assert.equal(batchHeaders.at(-1)?.['x-anysentry-ingest-token'], 'managed-capture-token');
  assert.equal(forwarded.attributes.captureWindowStartUnixNs, '1777000000000000001');
  assert.equal(forwarded.attributes.captureWindowEndUnixNs, '1777000001000000001');
  assert.equal(forwarded.filterAction, undefined, 'aggregate summaries must not feed profile learning');
  assert.deepEqual({
    aggregate: forwarded.attributes.captureAggregate,
    probe: forwarded.attributes.captureProbe,
    action: forwarded.attributes.captureEffectiveAction,
    profile: forwarded.attributes.captureProfile,
    epoch: forwarded.attributes.captureEpoch,
    policyVersion: forwarded.attributes.capturePolicyVersion,
  }, {
    aggregate: true,
    probe: 'file_access',
    action: 'aggregate',
    profile: 'infrastructure_aggregate',
    epoch: 7001,
    policyVersion: 7,
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(
    batches.flatMap((batch) => batch.events ?? []).some((event) => event.line === rawNoise),
    false,
    'ordinary non-Agent raw noise remains filtered in enforce mode',
  );
  const heartbeat = await eventually('CaptureAggregate heartbeat counters', () => heartbeats.find((item) =>
    item.filterMetrics?.captureAggregateOutputs === 1));
  assert.equal(heartbeat.filterMetrics.captureAggregateDecisionAttempts, 123);
  assert.equal(heartbeat.filterMetrics.aggregationOutputs, 0, 'no second FileAccess aggregation is applied');
  assert.equal(heartbeat.filterMetrics.observed, 1, 'summary must not count as a raw identity observation');
  assert.equal(heartbeat.filterMetrics.nonAgent, 1, 'summary must not inflate identity classification counts');

  child.stdin.end();
  const exit = await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`forwarder did not exit: ${stderr}`)), 6_000)),
  ]);
  assert.equal(exit, 0, stderr);
} catch (error) {
  throw new Error(`${error instanceof Error ? error.message : String(error)}\n${stderr}`);
} finally {
  if (child.exitCode === null) child.kill('SIGKILL');
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(credentialDirectory, { recursive: true, force: true });
}

console.log('S5 Forwarder CaptureAggregate bypass verification passed');
