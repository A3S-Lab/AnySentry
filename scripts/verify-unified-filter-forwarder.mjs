#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import http from 'node:http';

const require = createRequire(import.meta.url);
const { builtinFilterRules } = require('../apps/api/dist/security-monitoring/filter-rule-builtins.js');
const { compileFilterRuleProjection } = require('../apps/api/dist/security-monitoring/filter-rule-engine.js');

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
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

const projection = compileFilterRuleProjection({
  rules: builtinFilterRules(),
  catalogVersion: 21,
  domainVersions: { identity: 7, capture: 8, forwarder: 9, retention: 10 },
  now: Date.now(),
  ttlMs: 120_000,
});
const projectionHeaders = [];
const batches = [];
const heartbeats = [];
const server = http.createServer(async (request, response) => {
  let raw = '';
  for await (const chunk of request) raw += chunk;
  const body = raw ? JSON.parse(raw) : undefined;
  if (request.url === '/security-center/filter-rules/projections/forwarder') {
    projectionHeaders.push(request.headers);
    json(response, 200, projection);
    return;
  }
  if (request.url?.startsWith('/security-center/identity/snapshot')) {
    json(response, 200, {
      schemaVersion: 'anysentry.workload_identity_snapshot.v1',
      version: 1,
      generatedAt: new Date().toISOString(),
      ready: true,
      errors: 0,
      entries: [],
    });
    return;
  }
  if (request.url === '/security-center/ingest/batch') {
    batches.push(body);
    json(response, 200, {
      accepted: true,
      batchId: body.batchId,
      payloadDigest: body.payloadDigest,
      acceptedEvents: body.events.length,
      retainedEvents: body.events.length,
      discardedEvents: 0,
      rejectedEvents: 0,
      retryableEvents: 0,
      items: body.events.map((_, index) => ({ index, accepted: true, disposition: 'retained' })),
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
  json(response, 404, { message: 'not found' });
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
assert(address && typeof address === 'object');
const base = `http://127.0.0.1:${address.port}/security-center`;
const child = spawn(process.execPath, ['scripts/observer-forward.js'], {
  env: {
    ...process.env,
    ANYSENTRY_INGEST_URL: `${base}/ingest`,
    ANYSENTRY_BATCH_INGEST_URL: `${base}/ingest/batch`,
    ANYSENTRY_HEARTBEAT_URL: `${base}/collectors/heartbeat`,
    ANYSENTRY_IDENTITY_SNAPSHOT_URL: `${base}/identity/snapshot`,
    ANYSENTRY_AGENT_RUNTIME_SNAPSHOT_URL: `${base}/runtime/snapshot`,
    ANYSENTRY_AGENT_RUNTIME_LEASE_URL: `${base}/runtime/lease`,
    ANYSENTRY_FILTER_RULE_PROJECTION_URL: `${base}/filter-rules/projections/forwarder`,
    ANYSENTRY_FILTER_RULE_PROJECTION_SECS: '0.05',
    ANYSENTRY_UNKNOWN_RETENTION_MODE: 'enforce',
    ANYSENTRY_INFRASTRUCTURE_POLICY_TOKEN: 'unified-control-token',
    ANYSENTRY_INFRASTRUCTURE_POLICY_SECS: '0',
    ANYSENTRY_IDENTITY_SNAPSHOT_SECS: '0.05',
    ANYSENTRY_HEARTBEAT_SECS: '0.05',
    ANYSENTRY_AGENT_RUNTIME_SNAPSHOT_SECS: '300',
    ANYSENTRY_AGENT_RUNTIME_LIVENESS_SECS: '300',
    ANYSENTRY_DOCKER_DISCOVERY: 'off',
    ANYSENTRY_BEHAVIOR_DISCOVERY: 'off',
    ANYSENTRY_AGENT_TEMPLATES_JSON: '[]',
    ANYSENTRY_AGENT_RUNTIME_SIGNATURES_JSON: JSON.stringify({
      schemaVersion: 'anysentry.agent_runtime_signatures.v1',
      version: 1,
      runtimes: [],
    }),
    FORWARD_FILTER_MODE: 'shadow',
    FORWARD_RETAIN_NON_AGENT: 'true',
    FORWARD_NOISE_POLICY: 'include',
    FORWARD_FILE_AGGREGATION: 'false',
    FORWARD_BATCH_SIZE: '1',
    FORWARD_BATCH_FLUSH_MS: '1',
    FORWARD_SHUTDOWN_TIMEOUT_MS: '5000',
    A3S_OBSERVER_COLLECTOR_ID: 'unified-filter-forwarder',
    A3S_NODE_NAME: 'node-unified',
  },
  stdio: ['pipe', 'ignore', 'pipe'],
});
let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => { stderr += chunk; });

const event = JSON.stringify({
  identity: { agent: null, task: 991, session: null },
  process: {
    host_id: 'node-unified',
    boot_id: 'boot-unified',
    pid: 991,
    ppid: 1,
    start_time_ticks: '99100',
    comm: 'codex',
    exe: '/opt/bin/codex',
    cgroup_id: '9001',
    cgroup: '0::/user.slice/codex.scope',
  },
  event: { ToolExec: { pid: 991, ppid: 1, argv: ['/opt/bin/codex', 'exec', 'id'], cwd: '/workspace' } },
});

try {
  await eventually('central projection load', () => projectionHeaders.length > 0);
  child.stdin.write(`${event}\n`);
  const forwarded = await eventually('centrally identified Codex event', () => batches
    .flatMap((batch) => batch.events ?? [])
    .find((item) => item.line === event));
  assert.equal(projectionHeaders[0]['x-anysentry-management-token'], 'unified-control-token');
  assert(forwarded.classificationSemantics, JSON.stringify(forwarded));
  assert.equal(forwarded.classificationSemantics.identityClassification, 'probable_agent');
  assert.equal(forwarded.classificationSemantics.captureProfile, 'probable_investigation');
  assert.equal(forwarded.attributes.filterF2RuleId, 'fr_guardrail_lifecycle_structure');
  assert.equal(forwarded.attributes.filterF2Action, 'priority');
  assert.equal(forwarded.attributes.filterRuleCatalogVersion, 21);
  assert.equal(forwarded.attributes.filterRuleForwarderVersion, 9);

  const heartbeat = await eventually('unified projection heartbeat', () => heartbeats.find((item) =>
    item.filterMetrics?.unifiedProjectionState === 'ready'
    && item.filterMetrics?.unifiedCatalogVersion === 21));
  assert.equal(heartbeat.filterMetrics.filterMode, 'enforce', 'central rule settings replace bootstrap env');
  assert.equal(heartbeat.filterMetrics.retainNonAgent, false);
  assert.equal(heartbeat.filterMetrics.noisePolicy, 'balanced');
  assert.equal(heartbeat.filterMetrics.fileAggregationEnabled, true);
  assert.equal(heartbeat.filterMetrics.unifiedIdentityVersion, 7);
  assert.equal(heartbeat.filterMetrics.unifiedCaptureVersion, 8);
  assert.equal(heartbeat.filterMetrics.unifiedForwarderVersion, 9);
  assert.equal(heartbeat.filterMetrics.unifiedRuntimeSignatures, 6);
  assert.equal(heartbeat.filterMetrics.unifiedProjectionLoadErrors, 0);

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
}

console.log('PASS central Filter Rule projection controls Forwarder F0/F1/F2 and heartbeat lineage');
