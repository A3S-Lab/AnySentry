#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const forwarder = fileURLToPath(new URL('./observer-forward.js', import.meta.url));

function event(session, kind, payload, processFields = {}) {
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
      ...processFields,
    },
    event: { [kind]: payload },
  });
}

function collectorHeartbeat(collectorId) {
  return JSON.stringify({
    identity: { agent: null, task: null, session: null },
    event: {
      CollectorHeartbeat: {
        collector_id: collectorId,
        version: 'fixture',
        mode: 'observe',
        interval_secs: 1,
        dropped: 0,
        output_dropped: 0,
      },
    },
  });
}

function captureAggregate(marker) {
  return JSON.stringify({
    identity: { agent: null, task: null, session: null },
    event: {
      CaptureAggregate: {
        count: 1,
        probe: 'connect',
        effectiveAction: 'aggregate',
        qualifier: marker,
        profile: 'infrastructure_aggregate',
        epoch: 1,
        policyVersion: 1,
        authority: 'authoritative',
        reason: 'test',
        terminal: true,
      },
    },
  });
}

function acceptedBatchAck(events) {
  return {
    accepted: events.length > 0,
    acceptedEvents: events.length,
    rejectedEvents: 0,
    retryableEvents: 0,
    items: events.map((_, index) => ({ index, accepted: true })),
  };
}

function legacyAcceptedBatchAck(events) {
  return {
    accepted: events.length > 0,
    acceptedEvents: events.length,
    rejectedEvents: 0,
    items: events.map((_, index) => ({ index, accepted: true })),
  };
}

function retryableBatchAck(events, retryAfterMs = 10) {
  return {
    accepted: false,
    acceptedEvents: 0,
    rejectedEvents: 0,
    retryableEvents: events.length,
    retryAfterMs,
    items: events.map((_, index) => ({
      index,
      accepted: false,
      disposition: 'retryable',
      reasonCode: 'clickhouse_event_buffer_full',
    })),
  };
}

function wrapped(data) {
  return { code: 200, message: 'Success', data };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function within(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function eventually(predicate, timeoutMs, label) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${label} timed out after ${timeoutMs} ms`);
}

async function runConfig(label, env = {}, inputLines, options = {}) {
  const batches = [];
  const batchRequests = [];
  const batchRequestBytes = [];
  const heartbeats = [];
  const runtimeSnapshots = [];
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
      const reply = typeof options.identitySnapshotReply === 'function'
        ? options.identitySnapshotReply(snapshot)
        : options.identitySnapshotReply ?? { statusCode: 200, body: snapshot };
      if (typeof reply.handle === 'function') {
        reply.handle(response);
        return;
      }
      response.writeHead(reply.statusCode ?? 200, { 'Content-Type': 'application/json' });
      response.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {}));
      return;
    }
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      const parsed = body ? JSON.parse(body) : {};
      if (request.url === '/security-center/ingest/batch') {
        batchRequestBytes.push(Buffer.byteLength(body));
        const events = parsed.events ?? [];
        batchRequests.push(events);
        batches.push(...events);
        const reply = options.batchReply?.(events, batchRequests.length) ?? {
          statusCode: 200,
          body: wrapped(acceptedBatchAck(events)),
        };
        if (typeof reply.handle === 'function') {
          reply.handle(response);
          return;
        }
        response.writeHead(reply.statusCode ?? 200, { 'Content-Type': 'application/json' });
        response.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {}));
        return;
      }
      if (request.url === '/security-center/collectors/heartbeat') heartbeats.push(parsed);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      if (request.url === '/security-center/runtime/lease') {
        response.end('{"accepted":true,"leaseEpoch":1}');
      } else if (request.url === '/security-center/runtime/snapshot') {
        runtimeSnapshots.push(parsed);
        response.end('{"accepted":true,"applied":true,"duplicate":false}');
      } else {
        response.end('{"accepted":true}');
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const api = `http://127.0.0.1:${address.port}/security-center/ingest`;
  const spoolDirectory = fs.mkdtempSync(path.join(os.tmpdir(), `anysentry-filter-${label}-`));
  const childEnv = {
      ...process.env,
      FORWARD_FILTER_MODE: 'enforce',
      FORWARD_RETAIN_UNKNOWN: 'true',
      FORWARD_RETAIN_NON_AGENT: 'false',
      FORWARD_NOISE_POLICY: 'balanced',
      FORWARD_BATCH_SIZE: '32',
      FORWARD_BATCH_FLUSH_MS: '5',
      ...env,
      ANYSENTRY_INGEST_URL: api,
      ANYSENTRY_BATCH_INGEST_URL: `${api}/batch`,
      ANYSENTRY_HEARTBEAT_URL: api.replace(/\/ingest$/u, '/collectors/heartbeat'),
      ANYSENTRY_IDENTITY_SNAPSHOT_URL: api.replace(/\/ingest$/u, '/identity/snapshot'),
      ANYSENTRY_AGENT_RUNTIME_SNAPSHOT_URL: api.replace(/\/ingest$/u, '/runtime/snapshot'),
      ANYSENTRY_AGENT_RUNTIME_LEASE_URL: api.replace(/\/ingest$/u, '/runtime/lease'),
      FORWARD_SPOOL_PATH: path.join(spoolDirectory, 'spool.wal'),
      ANYSENTRY_IDENTITY_SNAPSHOT_SECS: '0.05',
      // Most fixtures assert one closed accounting window. Keep periodic delivery outside the
      // short-lived fixture unless a scenario explicitly tests overlapping heartbeat behavior.
      ANYSENTRY_HEARTBEAT_SECS: options.heartbeatSecs ?? '60',
      ANYSENTRY_DOCKER_DISCOVERY: 'off',
      ANYSENTRY_BEHAVIOR_DISCOVERY: 'off',
      ANYSENTRY_AGENT_TEMPLATES_JSON: '[]',
      A3S_OBSERVER_COLLECTOR_ID: `filter-${label}`,
  };
  if (!Object.prototype.hasOwnProperty.call(env, 'ANYSENTRY_E2E_INGEST_MARKER_PREFIX')) {
    delete childEnv.ANYSENTRY_E2E_INGEST_MARKER_PREFIX;
  }
  const child = spawn(process.execPath, [forwarder], {
    env: childEnv,
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  try {
    await within(snapshotRequested, 5_000, `${label} identity snapshot request`);
  } catch (error) {
    child.kill('SIGKILL');
    if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve));
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(spoolDirectory, { recursive: true, force: true });
    throw new Error(`${error.message}: ${stderr}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  const lines = inputLines ?? [
    event('nonagent-container', 'ToolExec', { pid: 10, argv: ['true'] }),
    env.ANYSENTRY_E2E_FILTER_MARKER_VALUE
      ? event('unknown-container', 'ToolExec', { pid: 20, argv: ['/usr/bin/true', env.ANYSENTRY_E2E_FILTER_MARKER_VALUE] })
      : event('unknown-container', 'FileAccess', { pid: 20, path: '/workspace/a', write: true }),
    event('unknown-container', 'FileAccess', { pid: 20, path: '/workspace/b', write: true }),
    event('unknown-container', 'FileAccess', { pid: 20, path: '/proc/status', write: false }),
    event('unknown-container', 'FileDelete', { pid: 20, path: '/proc/important' }),
    event('unknown-container', 'SecurityAction', { pid: 20, kind: 'setuid' }),
  ];
  if (options.driveInput) {
    await options.driveInput({ child, lines, batchRequests, heartbeats });
  } else {
    child.stdin.end(`${lines.join('\n')}\n`);
  }
  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`forwarder ${label} timed out: ${stderr}`));
    // Scenario-specific assertions retain the sub-second protocol deadlines. This outer watchdog
    // only detects a leaked child, so allow CI hosts under image/database I/O enough scheduling
    // headroom before declaring the whole Forwarder process hung.
    }, options.timeoutMs ?? 15_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(spoolDirectory, { recursive: true, force: true });
  assert.equal(exitCode, 0, stderr);
  const expectedObserved = options.expectedObserved ?? lines.length;
  const heartbeat = options.heartbeatPredicate
    ? [...heartbeats].reverse().find(options.heartbeatPredicate)
    : [...heartbeats]
      .reverse()
      .find((candidate) => candidate.filterMetrics?.observed === expectedObserved);
  assert.ok(heartbeat, `missing structured ${label} heartbeat: ${JSON.stringify(heartbeats)}`);
  return { batches, batchRequests, batchRequestBytes, heartbeat, heartbeats, runtimeSnapshots };
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
      if (request.url === '/security-center/ingest/batch') {
        const events = parsed.events ?? [];
        batches.push(...events);
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(wrapped(acceptedBatchAck(events))));
        return;
      }
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
      ANYSENTRY_BATCH_INGEST_URL: `http://127.0.0.1:${address.port}/security-center/ingest/batch`,
      ANYSENTRY_HEARTBEAT_URL: `http://127.0.0.1:${address.port}/security-center/collectors/heartbeat`,
      ANYSENTRY_IDENTITY_SNAPSHOT_URL: `http://127.0.0.1:${address.port}/security-center/identity/snapshot`,
      ANYSENTRY_AGENT_RUNTIME_SNAPSHOT_URL: `http://127.0.0.1:${address.port}/security-center/runtime/snapshot`,
      ANYSENTRY_AGENT_RUNTIME_LEASE_URL: `http://127.0.0.1:${address.port}/security-center/runtime/lease`,
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
  child.stdin.write(`${event('reviewed-container', 'FileAccess', { pid: 30, path: '/tmp/blocked', write: false })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 40));
  snapshotVersion = 2;
  await recoverySnapshot;
  await new Promise((resolve) => setTimeout(resolve, 20));
  child.stdin.end(`${event('reviewed-container', 'FileAccess', { pid: 31, path: '/tmp/observed-again', write: false })}\n`);

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
  assert.equal(recovered.event.FileAccess.path, '/tmp/observed-again');
  assert.equal(batches[0].attribution?.classification, 'unknown');
  assert.equal(batches[0].attribution?.source, 'manual_review');
  const heartbeat = heartbeats.find((candidate) => candidate.filterMetrics?.lastSuppressedAt);
  assert.ok(heartbeat, `missing manual suppression heartbeat: ${JSON.stringify(heartbeats)}`);
  assert.match(heartbeat?.filterMetrics?.lastSuppressedAt ?? '', /^\d{4}-\d{2}-\d{2}T/u);
}

async function runHungShutdownScenario() {
  const spoolDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'anysentry-filter-hung-shutdown-'));
  const initialRuntimeSnapshot = deferred();
  const batchStarted = deferred();
  const snapshotWhileBatchOpen = deferred();
  const controlAgentSaturated = deferred();
  const hangingBatchClosed = deferred();
  const sockets = new Set();
  const trickleTimers = new Set();
  const hungControlSockets = new Set();
  const heartbeats = [];
  const runtimeSnapshots = [];
  let hangingBatchSocket;
  let hangControlTraffic = false;
  let hungHeartbeats = 0;
  let hungIdentitySnapshots = 0;
  let signalAt = 0;
  let child;
  let childExit;
  let stderr = '';

  const hangResponseBody = (response) => {
    response.write(' ');
    const timer = setInterval(() => response.write(' '), 100);
    trickleTimers.add(timer);
    response.once('close', () => {
      clearInterval(timer);
      trickleTimers.delete(timer);
    });
  };

  const occupyControlSocket = (request, response) => {
    hungControlSockets.add(request.socket);
    if (hungControlSockets.size === 4) controlAgentSaturated.resolve();
    hangResponseBody(response);
  };

  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      const parsed = body ? JSON.parse(body) : {};
      const receivedAt = Date.now();
      if (request.url === '/security-center/identity/snapshot') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        if (hangControlTraffic && hungIdentitySnapshots < 2) {
          hungIdentitySnapshots++;
          occupyControlSocket(request, response);
          return;
        }
        response.end(JSON.stringify({
          schemaVersion: 'anysentry.workload_identity_snapshot.v1',
          version: 1,
          generatedAt: new Date().toISOString(),
          ready: true,
          errors: 0,
          entries: [],
        }));
        return;
      }
      if (request.url === '/security-center/ingest/batch') {
        hangingBatchSocket = request.socket;
        hangingBatchSocket.once('close', () => hangingBatchClosed.resolve());
        batchStarted.resolve();
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      if (request.url === '/security-center/runtime/lease') {
        response.end('{"accepted":true,"leaseEpoch":1}');
        return;
      }
      if (request.url === '/security-center/runtime/snapshot') {
        const record = { body: parsed, receivedAt, socket: request.socket };
        runtimeSnapshots.push(record);
        if (runtimeSnapshots.length === 1) initialRuntimeSnapshot.resolve(record);
        if (runtimeSnapshots.length === 2 && hangingBatchSocket && !hangingBatchSocket.destroyed) {
          hangControlTraffic = true;
          snapshotWhileBatchOpen.resolve(record);
          occupyControlSocket(request, response);
          return;
        }
        response.end('{"accepted":true,"applied":true,"duplicate":false}');
        return;
      }
      if (request.url === '/security-center/collectors/heartbeat') {
        const record = { body: parsed, receivedAt, socket: request.socket };
        heartbeats.push(record);
        if (signalAt && receivedAt >= signalAt) {
          // The final response deliberately trickles forever. The forwarder's absolute control
          // timeout must still settle it and exit before the global shutdown deadline.
          hangResponseBody(response);
          return;
        }
        if (hangControlTraffic && hungHeartbeats < 2) {
          hungHeartbeats++;
          occupyControlSocket(request, response);
          return;
        }
        response.end('{"accepted":true}');
        return;
      }
      response.end('{}');
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}/security-center`;

  try {
    child = spawn(process.execPath, [forwarder], {
      env: {
        ...process.env,
        FORWARD_FILTER_MODE: 'shadow',
        FORWARD_RETAIN_UNKNOWN: 'true',
        FORWARD_RETAIN_NON_AGENT: 'true',
        FORWARD_NOISE_POLICY: 'include',
        FORWARD_BATCH_SIZE: '1',
        FORWARD_BATCH_FLUSH_MS: '1',
        FORWARD_MAX_INFLIGHT: '1',
        FORWARD_HTTP_TIMEOUT_MS: '120000',
        FORWARD_SHUTDOWN_TIMEOUT_MS: '2500',
        ANYSENTRY_INGEST_URL: `${base}/ingest`,
        ANYSENTRY_BATCH_INGEST_URL: `${base}/ingest/batch`,
        ANYSENTRY_HEARTBEAT_URL: `${base}/collectors/heartbeat`,
        ANYSENTRY_IDENTITY_SNAPSHOT_URL: `${base}/identity/snapshot`,
        ANYSENTRY_AGENT_RUNTIME_SNAPSHOT_URL: `${base}/runtime/snapshot`,
        ANYSENTRY_AGENT_RUNTIME_LEASE_URL: `${base}/runtime/lease`,
        ANYSENTRY_IDENTITY_SNAPSHOT_SECS: '0.05',
        ANYSENTRY_HEARTBEAT_SECS: '0.05',
        ANYSENTRY_AGENT_RUNTIME_SNAPSHOT_SECS: '1',
        ANYSENTRY_AGENT_RUNTIME_LIVENESS_SECS: '300',
        FORWARD_SPOOL_PATH: path.join(spoolDirectory, 'spool.wal'),
        ANYSENTRY_DOCKER_DISCOVERY: 'off',
        ANYSENTRY_BEHAVIOR_DISCOVERY: 'off',
        ANYSENTRY_AGENT_TEMPLATES_JSON: '[]',
        ANYSENTRY_AGENT_RUNTIME_SIGNATURES_FILE: '',
        A3S_OBSERVER_COLLECTOR_ID: 'filter-hung-shutdown',
      },
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const exitPromise = new Promise((resolve) => {
      child.once('exit', (code, signal) => {
        childExit = { code, signal };
        resolve(childExit);
      });
    });

    await within(initialRuntimeSnapshot.promise, 3_000, 'initial runtime snapshot');
    child.stdin.write(`${event('hung-container', 'ToolExec', { pid: 3_500, argv: ['/usr/bin/true', 'hung-request'] })}\n`);
    await within(batchStarted.promise, 2_000, 'hanging event batch');
    const snapshotDuringHang = await within(
      snapshotWhileBatchOpen.promise,
      3_000,
      'in-flight runtime snapshot while the event socket is occupied',
    );
    await within(controlAgentSaturated.promise, 2_000, 'four saturated control sockets');
    assert.equal(hangingBatchSocket.destroyed, false);
    assert.notEqual(snapshotDuringHang.socket, hangingBatchSocket);
    assert.equal(hungControlSockets.size, 4, 'fixture must occupy every control Agent socket');
    assert.equal(hungHeartbeats, 1, 'heartbeat accounting allows only one in-flight delta window');
    assert.equal(hungIdentitySnapshots, 2, 'fixture must include two in-flight identity requests');
    for (const socket of hungControlSockets) assert.notEqual(socket, hangingBatchSocket);

    const preSignalSnapshotVersion = snapshotDuringHang.body.snapshotVersion ?? 0;
    signalAt = Date.now();
    assert.equal(child.kill('SIGTERM'), true);
    const exit = await within(exitPromise, 3_200, `bounded SIGTERM shutdown: ${stderr}`);
    const elapsedMs = Date.now() - signalAt;
    assert.deepEqual(exit, { code: 0, signal: null }, stderr);
    assert.ok(elapsedMs < 3_200, `SIGTERM shutdown took ${elapsedMs} ms`);
    await within(hangingBatchClosed.promise, 500, 'hanging batch socket close');
    assert.ok(
      runtimeSnapshots.some((record) =>
        record.receivedAt >= signalAt && (record.body.snapshotVersion ?? 0) > preSignalSnapshotVersion),
      'graceful SIGTERM must publish a final runtime snapshot',
    );
    const finalHeartbeat = heartbeats.find((record) =>
      record.receivedAt >= signalAt &&
      record.body.filterMetrics?.shutdownFinal === true);
    assert.ok(finalHeartbeat, `missing final dropped-event heartbeat: ${JSON.stringify(heartbeats.map((item) => ({
      receivedAt: item.receivedAt,
      shutdownFinal: item.body.filterMetrics?.shutdownFinal,
      outputDropped: item.body.outputDropped,
      errorCount: item.body.errorCount,
      identityErrors: item.body.filterMetrics?.identityErrors,
      runtimeSnapshotErrors: item.body.filterMetrics?.runtimeSnapshotErrors,
    })))}`);
    assert.equal(finalHeartbeat.body.outputDropped, 1);
    assert.equal(finalHeartbeat.body.errorCount, 1);
    assert.equal(finalHeartbeat.body.filterMetrics?.queueDropped, 0);
    assert.equal(finalHeartbeat.body.filterMetrics?.identityErrors, 0);
    assert.equal(finalHeartbeat.body.filterMetrics?.runtimeSnapshotErrors, 0);
    assert.equal(finalHeartbeat.body.filterMetrics?.runtimeLeaseErrors, 0);
    assert.equal(
      heartbeats.some((record) => record.receivedAt < signalAt && record.body.filterMetrics?.shutdownFinal === true),
      false,
      'periodic heartbeats must never claim to be the final shutdown heartbeat',
    );
  } finally {
    if (child && !childExit) child.kill('SIGKILL');
    child?.stdin.destroy();
    for (const timer of trickleTimers) clearInterval(timer);
    trickleTimers.clear();
    const closed = new Promise((resolve) => server.close(resolve));
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    for (const socket of sockets) socket.destroy();
    await closed;
    fs.rmSync(spoolDirectory, { recursive: true, force: true });
  }
}

const include = await runConfig('include', {
  FORWARD_RETAIN_NON_AGENT: 'true',
  FORWARD_NOISE_POLICY: 'include',
});

const declaredHealthcheckArgv = ['/bin/sh', '-c', 'test -f /tmp/agent-ready || exit 1'];
const activityContext = await runConfig('activity-context', {}, [
  event('unknown-container', 'ToolExec', { pid: 21, argv: declaredHealthcheckArgv }),
  event('unknown-container', 'ToolExec', { pid: 22, argv: ['/bin/sh', '-c', 'echo manual'] }),
], {
  expectedObserved: 2,
  identitySnapshotReply(snapshot) {
    const target = snapshot.entries.find((entry) => entry.ids.includes('unknown-container'));
    target.platformHealthchecks = [{
      activitySubtype: 'docker_healthcheck',
      argv: declaredHealthcheckArgv,
    }];
    return { statusCode: 200, body: snapshot };
  },
});
const activityEvents = activityContext.batches.filter((item) =>
  JSON.parse(item.line).event?.ToolExec);
assert.equal(activityEvents.length, 2);
assert.equal(activityEvents[0].activityContext, 'platform_healthcheck');
assert.equal(activityEvents[0].activitySubtype, 'docker_healthcheck');
assert.equal(activityEvents[1].activityContext, 'agent_action');
assert.equal(activityEvents[1].activitySubtype, undefined);
assert.deepEqual(
  JSON.parse(activityEvents[0].line).event.ToolExec.argv,
  declaredHealthcheckArgv,
  'activity metadata must not rewrite the raw ToolExec audit line',
);
const agentOwnedHealthcheck = await runConfig('agent-owned-healthcheck', {}, [
  event('unknown-container', 'ToolExec', { pid: 23, argv: ['pi', '--print'] }, {
    host_id: undefined,
    boot_id: undefined,
    comm: 'pi',
    exe: '/usr/local/bin/pi',
  }),
  event('unknown-container', 'ToolExec', { pid: 24, ppid: 23, argv: declaredHealthcheckArgv }, {
    host_id: undefined,
    boot_id: undefined,
    ppid: 23,
    comm: 'sh',
    exe: '/bin/sh',
  }),
], {
  expectedObserved: 2,
  identitySnapshotReply(snapshot) {
    const target = snapshot.entries.find((entry) => entry.ids.includes('unknown-container'));
    target.platformHealthchecks = [{
      activitySubtype: 'docker_healthcheck',
      argv: declaredHealthcheckArgv,
    }];
    return { statusCode: 200, body: snapshot };
  },
});
const agentOwnedEvents = agentOwnedHealthcheck.batches.filter((item) =>
  JSON.parse(item.line).event?.ToolExec);
assert.equal(agentOwnedEvents.length, 2);
assert.equal(agentOwnedEvents[0].activityContext, 'agent_action');
assert.equal(
  agentOwnedEvents[1].activityContext,
  'agent_action',
  'an Agent descendant that runs the declared probe argv remains an Agent action',
);
assert.equal(include.batches.length, 6);
assert.equal(include.heartbeat.filterMetrics.filteredNonAgent, 0);
assert.equal(include.heartbeat.filterMetrics.filteredNoise, 0);

const shadow = await runConfig('shadow', { FORWARD_FILTER_MODE: 'shadow' });
assert.equal(shadow.batches.length, 6, 'shadow forwards every retention decision');
assert.equal(shadow.heartbeat.filterMetrics.wouldFilterNonAgent, 0);
assert.equal(
  shadow.heartbeat.filterMetrics.wouldFilterNoise,
  0,
  'path noise cannot silently suppress or shadow-drop an Unknown event',
);
assert.equal(shadow.heartbeat.filterMetrics.filteredNonAgent, 0);
assert.equal(shadow.heartbeat.filterMetrics.filteredNoise, 0);

const policyDiscardLines = Array.from({ length: 3 }, (_, index) => event(
  'nonagent-container',
  'ToolExec',
  { pid: 1_800 + index, argv: ['/usr/bin/true', `policy-discard-${index}`] },
));
const policyDiscardAck = await runConfig('policy-discard-ack', {
  FORWARD_FILTER_MODE: 'shadow',
  FORWARD_BATCH_SIZE: '3',
  FORWARD_MAX_INFLIGHT: '1',
}, policyDiscardLines, {
  batchReply: (events) => ({
    statusCode: 200,
    body: wrapped({
      accepted: true,
      acceptedEvents: events.length,
      retainedEvents: 0,
      discardedEvents: events.length,
      rejectedEvents: 0,
      items: events.map((_, index) => ({ index, accepted: true, disposition: 'discarded', reasonCode: 'non_agent_discarded' })),
    }),
  }),
});
assert.equal(policyDiscardAck.batchRequests.length, 1);
assert.equal(policyDiscardAck.heartbeat.filterMetrics.wouldFilterNonAgent, 0);
assert.equal(policyDiscardAck.heartbeat.outputDropped, 0, 'a deliberate policy discard is not a transport drop');
assert.equal(policyDiscardAck.heartbeat.errorCount, 0, 'a deliberate policy discard does not degrade collector health');
assert.equal(policyDiscardAck.heartbeat.status, 'ok');

const structuralAck = await runConfig('structural-consumed-ack', {
  FORWARD_FILTER_MODE: 'enforce',
  FORWARD_BATCH_SIZE: '1',
}, [event('nonagent-container', 'ToolExec', { pid: 1_825, argv: ['/usr/bin/true', 'structural'] })], {
  batchReply: () => ({
    statusCode: 200,
    body: wrapped({
      accepted: true,
      acceptedEvents: 1,
      retainedEvents: 0,
      structuralEvents: 1,
      discardedEvents: 1,
      rejectedEvents: 0,
      retryableEvents: 0,
      items: [{
        index: 0,
        accepted: true,
        disposition: 'discarded',
        structuralConsumed: true,
        reasonCode: 'non_agent_structural_consumed',
      }],
    }),
  }),
});
assert.equal(structuralAck.batchRequests.length, 1);
assert.equal(structuralAck.heartbeat.outputDropped, 0);
assert.equal(structuralAck.heartbeat.errorCount, 0);
assert.equal(structuralAck.heartbeat.status, 'ok');

const legacyAckLine = event(
  'unknown-container',
  'ToolExec',
  { pid: 1_850, argv: ['/usr/bin/true', 'legacy-batch-ack'] },
);
const legacyWrappedAck = await runConfig('legacy-wrapped-batch-ack', {
  FORWARD_FILTER_MODE: 'shadow',
  FORWARD_BATCH_SIZE: '1',
}, [legacyAckLine], {
  heartbeatSecs: '60',
  batchReply: (events) => ({ statusCode: 200, body: wrapped(legacyAcceptedBatchAck(events)) }),
});
const legacyRawAck = await runConfig('legacy-raw-batch-ack', {
  FORWARD_FILTER_MODE: 'shadow',
  FORWARD_BATCH_SIZE: '1',
}, [legacyAckLine], {
  heartbeatSecs: '60',
  batchReply: (events) => ({ statusCode: 200, body: legacyAcceptedBatchAck(events) }),
});
for (const result of [legacyWrappedAck, legacyRawAck]) {
  assert.equal(result.batchRequests.length, 1);
  assert.equal(result.heartbeat.outputDropped, 0);
  assert.equal(result.heartbeat.errorCount, 0);
  assert.equal(result.heartbeat.filterMetrics.retryQueued, 0);
  assert.equal(result.heartbeat.filterMetrics.retryAttempts, 0);
  assert.equal(result.heartbeat.status, 'ok');
}

const oversizedIdentity = await runConfig('oversized-identity-snapshot', {
  FORWARD_FILTER_MODE: 'shadow',
  FORWARD_IDENTITY_SNAPSHOT_MAX_BYTES: String(64 * 1024),
}, undefined, {
  identitySnapshotReply: (snapshot) => ({
    statusCode: 200,
    body: { ...snapshot, padding: 'x'.repeat(70 * 1024) },
  }),
});
assert.equal(oversizedIdentity.heartbeat.filterMetrics.identitySnapshotReady, false);
assert.ok(
  oversizedIdentity.heartbeat.filterMetrics.identityErrors >= 1,
  'an oversized identity snapshot must fail within its configured memory bound',
);

const byteBoundLines = Array.from({ length: 12 }, (_, index) => event(
  'unknown-container',
  'ToolExec',
  { pid: 2_000 + index, argv: ['/usr/bin/printf', 'x'.repeat(20_000)] },
));
const byteBound = await runConfig('byte-bound', {
  FORWARD_FILTER_MODE: 'shadow',
  FORWARD_BATCH_MAX_BYTES: String(64 * 1024),
  FORWARD_MAX_EVENT_BYTES: String(64 * 1024),
  FORWARD_MAX_QUEUE: '20',
  FORWARD_MAX_QUEUE_BYTES: String(1024 * 1024),
}, byteBoundLines, {
  heartbeatSecs: '60',
});
assert.equal(byteBound.batches.length, byteBoundLines.length);
assert.ok(byteBound.batchRequestBytes.length >= 4, 'large events must be split into multiple HTTP batches');
assert.ok(
  byteBound.batchRequestBytes.every((bytes) => bytes <= 64 * 1024 + 512),
  `serialized HTTP batch exceeded its byte budget: ${byteBound.batchRequestBytes.join(', ')}`,
);
assert.equal(byteBound.heartbeat.filterMetrics.outstandingEventLimit, 20);
assert.equal(byteBound.heartbeat.filterMetrics.outstandingByteLimit, 1024 * 1024);

const partialAckLines = Array.from({ length: 3 }, (_, index) => event(
  'unknown-container',
  'ToolExec',
  { pid: 3_000 + index, argv: ['/usr/bin/true', `partial-${index}`] },
));
const partialAck = await runConfig('partial-ack', {
  FORWARD_FILTER_MODE: 'shadow',
  FORWARD_BATCH_SIZE: '3',
  FORWARD_MAX_INFLIGHT: '1',
}, partialAckLines, {
  batchReply: (events) => ({
    statusCode: 200,
    body: wrapped({
      accepted: true,
      acceptedEvents: 2,
      retainedEvents: 1,
      discardedEvents: 1,
      rejectedEvents: 1,
      items: events.map((_, index) => ({
        index,
        accepted: index !== 1,
        disposition: index === 0 ? 'retained' : index === 2 ? 'discarded' : 'rejected',
        ...(index === 1 ? { reason: 'fixture rejection' } : {}),
      })),
    }),
  }),
});
assert.equal(partialAck.batchRequests.length, 1, 'a business rejection must not retry accepted siblings');
assert.equal(partialAck.heartbeat.filterMetrics.forwarded, partialAckLines.length);
assert.equal(partialAck.heartbeat.outputDropped, 1, 'HTTP 200 partial rejection must be counted as a drop');
assert.ok(partialAck.heartbeat.errorCount >= 1);
assert.equal(partialAck.heartbeat.filterMetrics.queueDropped, 0);
assert.equal(partialAck.heartbeat.status, 'degraded');

const retryRecoveryLines = Array.from({ length: 3 }, (_, index) => event(
  'unknown-container',
  'ToolExec',
  { pid: 3_010 + index, argv: ['/usr/bin/true', `retry-recovery-${index}`] },
));
let retryRecoveryRequests = 0;
const retryRecovery = await runConfig('retry-recovery', {
  FORWARD_FILTER_MODE: 'shadow',
  FORWARD_BATCH_SIZE: '3',
  FORWARD_MAX_INFLIGHT: '1',
  FORWARD_RETRY_BASE_DELAY_MS: '10',
  FORWARD_RETRY_MAX_DELAY_MS: '20',
  FORWARD_RETRY_MAX_AGE_MS: '500',
}, retryRecoveryLines, {
  heartbeatSecs: '60',
  batchReply: (events) => {
    retryRecoveryRequests++;
    if (retryRecoveryRequests > 1) {
      return { statusCode: 200, body: wrapped(acceptedBatchAck(events)) };
    }
    return {
      statusCode: 200,
      body: wrapped({
        accepted: true,
        acceptedEvents: 1,
        retainedEvents: 1,
        discardedEvents: 0,
        rejectedEvents: 0,
        retryableEvents: 2,
        retryAfterMs: 10,
        items: events.map((_, index) => index === 0
          ? { index, accepted: true, disposition: 'retained' }
          : {
              index,
              accepted: false,
              disposition: 'retryable',
              reasonCode: 'clickhouse_event_buffer_full',
            }),
      }),
    };
  },
});
assert.equal(retryRecovery.batchRequests.length, 2);
assert.deepEqual(
  retryRecovery.batchRequests[1],
  retryRecovery.batchRequests[0].slice(1),
  'only the exact retryable suffix is replayed and its event envelopes are unchanged',
);
assert.equal(retryRecovery.heartbeat.outputDropped, 0);
assert.equal(retryRecovery.heartbeat.errorCount, 0);
assert.equal(retryRecovery.heartbeat.status, 'ok', 'retry progress alone must not degrade collector health');
assert.equal(retryRecovery.heartbeat.filterMetrics.retryQueued, 2);
assert.equal(retryRecovery.heartbeat.filterMetrics.retryAttempts, 2);
assert.equal(retryRecovery.heartbeat.filterMetrics.retryRecovered, 2);
assert.equal(retryRecovery.heartbeat.filterMetrics.retryExhausted, 0);
assert.equal(retryRecovery.heartbeat.filterMetrics.retryQueueDepth, 0);
assert.equal(retryRecovery.heartbeat.filterMetrics.retryOutstandingEvents, 0);
assert.equal(retryRecovery.heartbeat.filterMetrics.outstandingEvents, 0);
assert.equal(retryRecovery.heartbeat.filterMetrics.outstandingBytes, 0);

const wrongRetryReason = await runConfig('wrong-retry-reason', {
  FORWARD_FILTER_MODE: 'shadow',
  FORWARD_BATCH_SIZE: '1',
  FORWARD_MAX_INFLIGHT: '1',
  FORWARD_RETRY_BASE_DELAY_MS: '10',
  FORWARD_RETRY_MAX_DELAY_MS: '20',
}, [event('unknown-container', 'ToolExec', { pid: 3_025, argv: ['/usr/bin/true', 'wrong-retry-reason'] })], {
  heartbeatSecs: '60',
  batchReply: (events) => ({
    statusCode: 200,
    body: wrapped({
      ...retryableBatchAck(events),
      items: [{
        index: 0,
        accepted: false,
        disposition: 'retryable',
        reasonCode: 'generic_temporary_failure',
      }],
    }),
  }),
});
assert.equal(wrongRetryReason.batchRequests.length, 1, 'an unrecognized retry reason must never replay');
assert.equal(wrongRetryReason.heartbeat.filterMetrics.retryQueued, 0);
assert.equal(wrongRetryReason.heartbeat.filterMetrics.retryAttempts, 0);
assert.equal(wrongRetryReason.heartbeat.outputDropped, 1);
assert.ok(wrongRetryReason.heartbeat.errorCount >= 1);

const nonSuffixRetryLines = Array.from({ length: 2 }, (_, index) => event(
  'unknown-container',
  'ToolExec',
  { pid: 3_030 + index, argv: ['/usr/bin/true', `non-suffix-retry-${index}`] },
));
const nonSuffixRetry = await runConfig('non-suffix-retry', {
  FORWARD_FILTER_MODE: 'shadow',
  FORWARD_BATCH_SIZE: '2',
  FORWARD_MAX_INFLIGHT: '1',
}, nonSuffixRetryLines, {
  heartbeatSecs: '60',
  batchReply: () => ({
    statusCode: 200,
    body: wrapped({
      accepted: true,
      acceptedEvents: 1,
      rejectedEvents: 0,
      retryableEvents: 1,
      retryAfterMs: 10,
      items: [
        {
          index: 0,
          accepted: false,
          disposition: 'retryable',
          reasonCode: 'clickhouse_event_buffer_full',
        },
        { index: 1, accepted: true, disposition: 'retained' },
      ],
    }),
  }),
});
assert.equal(nonSuffixRetry.batchRequests.length, 1, 'retryable items must be a contiguous ACK suffix');
assert.equal(nonSuffixRetry.heartbeat.outputDropped, 2);
assert.equal(nonSuffixRetry.heartbeat.filterMetrics.retryQueued, 0);

let retryThen503Requests = 0;
const retryThen503 = await runConfig('retry-then-503', {
  FORWARD_FILTER_MODE: 'shadow',
  FORWARD_BATCH_SIZE: '1',
  FORWARD_MAX_INFLIGHT: '1',
  FORWARD_RETRY_BASE_DELAY_MS: '10',
  FORWARD_RETRY_MAX_DELAY_MS: '20',
  FORWARD_RETRY_MAX_AGE_MS: '500',
}, [event('unknown-container', 'ToolExec', { pid: 3_040, argv: ['/usr/bin/true', 'retry-then-503'] })], {
  heartbeatSecs: '60',
  batchReply: (events) => {
    retryThen503Requests++;
    if (retryThen503Requests === 1) {
      return { statusCode: 200, body: wrapped(retryableBatchAck(events)) };
    }
    return {
      statusCode: 503,
      body: wrapped(retryableBatchAck(events)),
    };
  },
});
assert.ok(retryThen503.batchRequests.length > 2, 'a 5xx must replay with the stable batch identity until its bounded retry age');
assert.equal(retryThen503.heartbeat.filterMetrics.retryQueued, 1);
assert.ok(retryThen503.heartbeat.filterMetrics.retryAttempts > 1);
assert.equal(retryThen503.heartbeat.filterMetrics.retryRecovered, 0);
assert.equal(retryThen503.heartbeat.filterMetrics.retryExhausted, 1);
assert.equal(retryThen503.heartbeat.outputDropped, 1);
assert.ok(retryThen503.heartbeat.errorCount >= 1);

let retryThenNetworkRequests = 0;
const retryThenNetwork = await runConfig('retry-then-network-error', {
  FORWARD_FILTER_MODE: 'shadow',
  FORWARD_BATCH_SIZE: '1',
  FORWARD_MAX_INFLIGHT: '1',
  FORWARD_RETRY_BASE_DELAY_MS: '10',
  FORWARD_RETRY_MAX_DELAY_MS: '20',
  FORWARD_RETRY_MAX_AGE_MS: '500',
}, [event('unknown-container', 'ToolExec', { pid: 3_042, argv: ['/usr/bin/true', 'retry-then-network'] })], {
  heartbeatSecs: '60',
  batchReply: (events) => {
    retryThenNetworkRequests++;
    if (retryThenNetworkRequests === 1) {
      return { statusCode: 200, body: wrapped(retryableBatchAck(events)) };
    }
    return { handle: (response) => response.destroy() };
  },
});
assert.ok(retryThenNetwork.batchRequests.length > 2, 'a network failure must replay until its bounded retry age');
assert.equal(retryThenNetwork.heartbeat.filterMetrics.retryQueued, 1);
assert.ok(retryThenNetwork.heartbeat.filterMetrics.retryAttempts > 1);
assert.equal(retryThenNetwork.heartbeat.filterMetrics.retryRecovered, 0);
assert.equal(retryThenNetwork.heartbeat.filterMetrics.retryExhausted, 1);
assert.equal(retryThenNetwork.heartbeat.outputDropped, 1);
assert.ok(retryThenNetwork.heartbeat.errorCount >= 1);

const retryAgeStartedAt = Date.now();
const retryAge = await runConfig('retry-max-age', {
  FORWARD_FILTER_MODE: 'shadow',
  FORWARD_BATCH_SIZE: '1',
  FORWARD_MAX_INFLIGHT: '1',
  FORWARD_RETRY_BASE_DELAY_MS: '10',
  FORWARD_RETRY_MAX_DELAY_MS: '20',
  FORWARD_RETRY_MAX_AGE_MS: '100',
}, [event('unknown-container', 'ToolExec', { pid: 3_045, argv: ['/usr/bin/true', 'retry-max-age'] })], {
  heartbeatSecs: '60',
  batchReply: (events) => ({ statusCode: 200, body: wrapped(retryableBatchAck(events, 0)) }),
});
assert.ok(retryAge.batchRequests.length >= 2, 'an explicitly retryable item must be attempted');
assert.ok(retryAge.batchRequests.length < 20, 'retry age must bound the number of attempts');
assert.ok(Date.now() - retryAgeStartedAt < 1_000, 'the configured retry age is an end-to-end deadline');
assert.equal(retryAge.heartbeat.filterMetrics.retryQueued, 1);
assert.equal(retryAge.heartbeat.filterMetrics.retryAttempts, retryAge.batchRequests.length - 1);
assert.equal(retryAge.heartbeat.filterMetrics.retryRecovered, 0);
assert.equal(retryAge.heartbeat.filterMetrics.retryExhausted, 1);
assert.equal(retryAge.heartbeat.outputDropped, 1);
assert.ok(retryAge.heartbeat.errorCount >= 1);

let slowRetryDeadlineRequests = 0;
const slowRetryDeadlineStartedAt = Date.now();
const slowRetryDeadline = await runConfig('retry-request-absolute-deadline', {
  FORWARD_FILTER_MODE: 'shadow',
  FORWARD_BATCH_SIZE: '1',
  FORWARD_MAX_INFLIGHT: '1',
  FORWARD_RETRY_BASE_DELAY_MS: '10',
  FORWARD_RETRY_MAX_DELAY_MS: '20',
  FORWARD_RETRY_MAX_AGE_MS: '150',
  FORWARD_HTTP_TIMEOUT_MS: '4000',
}, [event('unknown-container', 'ToolExec', { pid: 3_046, argv: ['/usr/bin/true', 'slow-retry-deadline'] })], {
  heartbeatSecs: '60',
  batchReply: (events) => {
    slowRetryDeadlineRequests++;
    if (slowRetryDeadlineRequests === 1) {
      return { statusCode: 200, body: wrapped(retryableBatchAck(events)) };
    }
    return {
      handle: (response) => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        const timer = setInterval(() => response.write(' '), 20);
        response.once('close', () => clearInterval(timer));
      },
    };
  },
});
assert.equal(slowRetryDeadline.batchRequests.length, 2);
assert.ok(
  // Keep the gate well below the erroneous 4 s HTTP timeout while allowing host-level image and
  // database I/O to pause the verifier event loop during the full contract suite.
  Date.now() - slowRetryDeadlineStartedAt < 2_000,
  'an in-flight authorized retry must use the remaining retry age, not reset the HTTP timeout',
);
assert.equal(slowRetryDeadline.heartbeat.filterMetrics.retryQueued, 1);
assert.equal(slowRetryDeadline.heartbeat.filterMetrics.retryAttempts, 1);
assert.equal(slowRetryDeadline.heartbeat.filterMetrics.retryRecovered, 0);
assert.equal(slowRetryDeadline.heartbeat.filterMetrics.retryExhausted, 1);
assert.equal(slowRetryDeadline.heartbeat.outputDropped, 1);
assert.ok(slowRetryDeadline.heartbeat.errorCount >= 1);

const sigtermRetryStarted = deferred();
let sigtermRetryRequests = 0;
let sigtermSentAt = 0;
const sigtermRetry = await runConfig('sigterm-retry-drain', {
  FORWARD_FILTER_MODE: 'shadow',
  FORWARD_BATCH_SIZE: '1',
  FORWARD_MAX_INFLIGHT: '1',
  FORWARD_RETRY_BASE_DELAY_MS: '200',
  FORWARD_RETRY_MAX_DELAY_MS: '200',
  FORWARD_RETRY_MAX_AGE_MS: '1000',
  FORWARD_SHUTDOWN_TIMEOUT_MS: '2000',
}, [event('unknown-container', 'ToolExec', { pid: 3_047, argv: ['/usr/bin/true', 'sigterm-retry'] })], {
  heartbeatSecs: '60',
  batchReply: (events) => {
    sigtermRetryRequests++;
    if (sigtermRetryRequests === 1) {
      sigtermRetryStarted.resolve();
      return { statusCode: 200, body: wrapped(retryableBatchAck(events, 200)) };
    }
    return { statusCode: 200, body: wrapped(acceptedBatchAck(events)) };
  },
  driveInput: async ({ child, lines }) => {
    child.stdin.write(`${lines[0]}\n`);
    await sigtermRetryStarted.promise;
    await new Promise((resolve) => setTimeout(resolve, 50));
    sigtermSentAt = Date.now();
    assert.equal(child.kill('SIGTERM'), true);
  },
});
assert.equal(sigtermRetry.batchRequests.length, 2, 'SIGTERM must drain a scheduled retry before closing');
assert.ok(Date.now() - sigtermSentAt >= 100, 'shutdown must wait for the cancellable retry timer');
assert.equal(sigtermRetry.heartbeat.outputDropped, 0);
assert.equal(sigtermRetry.heartbeat.errorCount, 0);
assert.equal(sigtermRetry.heartbeat.filterMetrics.retryQueued, 1);
assert.equal(sigtermRetry.heartbeat.filterMetrics.retryAttempts, 1);
assert.equal(sigtermRetry.heartbeat.filterMetrics.retryRecovered, 1);
assert.equal(sigtermRetry.heartbeat.filterMetrics.retryExhausted, 0);
assert.equal(sigtermRetry.heartbeat.filterMetrics.retryQueueDepth, 0);
assert.equal(sigtermRetry.heartbeat.filterMetrics.outstandingEvents, 0);

const capacityRetryQueued = deferred();
const capacityInflightStarted = deferred();
let capacityHeldResponse;
let capacityHeldEvents;
let capacityARequests = 0;
const capacityLines = ['a', 'b', 'c', 'd'].map((name, index) => event(
  'unknown-container',
  'ToolExec',
  { pid: 3_060 + index, argv: ['/usr/bin/true', `capacity-${name}`] },
));
capacityLines.push(event(
  'unknown-container',
  'SecurityAction',
  { pid: 3_064, kind: 'capacity-e' },
));
const capacity = await runConfig('unified-outstanding-capacity', {
  FORWARD_FILTER_MODE: 'shadow',
  FORWARD_BATCH_SIZE: '1',
  FORWARD_BATCH_FLUSH_MS: '1',
  FORWARD_MAX_INFLIGHT: '1',
  FORWARD_MAX_OUTSTANDING_EVENTS: '4',
  FORWARD_MAX_OUTSTANDING_BYTES: String(1024 * 1024),
  // New unified settings must win over the two legacy compatibility aliases.
  FORWARD_MAX_QUEUE: '1',
  FORWARD_MAX_QUEUE_BYTES: '1024',
  FORWARD_RETRY_BASE_DELAY_MS: '500',
  FORWARD_RETRY_MAX_DELAY_MS: '500',
  FORWARD_RETRY_MAX_AGE_MS: '1000',
}, capacityLines, {
  heartbeatSecs: '0.02',
  timeoutMs: 6_000,
  heartbeatPredicate: (candidate) => candidate.filterMetrics?.shutdownFinal === true,
  batchReply: (events) => {
    const parsed = JSON.parse(events[0].line).event;
    const marker = parsed.ToolExec?.argv.at(-1) ?? parsed.SecurityAction?.kind;
    if (marker === 'capacity-a') {
      capacityARequests++;
      if (capacityARequests === 1) {
        capacityRetryQueued.resolve();
        return { statusCode: 200, body: wrapped(retryableBatchAck(events, 500)) };
      }
    }
    if (marker === 'capacity-b') {
      return {
        handle: (response) => {
          capacityHeldResponse = response;
          capacityHeldEvents = events;
          capacityInflightStarted.resolve();
        },
      };
    }
    return { statusCode: 200, body: wrapped(acceptedBatchAck(events)) };
  },
  driveInput: async ({ child, lines, batchRequests, heartbeats }) => {
    child.stdin.write(`${lines[0]}\n`);
    await capacityRetryQueued.promise;
    await eventually(
      () => heartbeats.find((heartbeat) => heartbeat.filterMetrics?.retryQueueDepth === 1),
      500,
      'retry item entering the scheduled queue',
    );
    // Feed a single already-buffered chunk: pause prevents further reads, while the unified hard
    // cap still deterministically admits the higher-priority final line by evicting one pending.
    child.stdin.write(`${lines.slice(1).join('\n')}\n`);
    await capacityInflightStarted.promise;
    const saturated = await eventually(
      () => heartbeats.find((heartbeat) => (
        heartbeat.filterMetrics?.outstandingEvents === 4
        && heartbeat.filterMetrics?.retryQueueDepth === 1
        && heartbeat.filterMetrics?.inflightEvents === 1
        && heartbeat.queueDepth === 2
      )),
      500,
      'unified retry/inflight/pending capacity',
    );
    assert.equal(saturated.filterMetrics.outstandingEventLimit, 4);
    assert.equal(saturated.filterMetrics.outstandingByteLimit, 1024 * 1024);
    assert.ok(saturated.filterMetrics.outstandingBytes <= saturated.filterMetrics.outstandingByteLimit);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(batchRequests.length, 2, 'no additional HTTP batch may start while unified capacity is full');
    capacityHeldResponse.writeHead(200, { 'Content-Type': 'application/json' });
    capacityHeldResponse.end(JSON.stringify(wrapped(acceptedBatchAck(capacityHeldEvents))));
    child.stdin.end();
  },
});
const capacityMarkers = capacity.batchRequests.flatMap((events) => events.map((item) => {
  const parsed = JSON.parse(item.line).event;
  return parsed.ToolExec?.argv.at(-1) ?? parsed.SecurityAction?.kind;
}));
assert.equal(capacityMarkers.filter((marker) => marker === 'capacity-a').length, 2);
for (const marker of ['capacity-b', 'capacity-d', 'capacity-e']) {
  assert.equal(
    capacityMarkers.filter((value) => value === marker).length,
    1,
    `${marker} must be sent once: ${capacityMarkers.join(', ')}`,
  );
}
assert.equal(
  capacityMarkers.filter((value) => value === 'capacity-c').length,
  0,
  'the higher-priority buffered event may replace only a pending event at the unified hard cap',
);
assert.ok(
  capacity.heartbeats.every((heartbeat) => (
    (heartbeat.filterMetrics?.outstandingEvents ?? 0)
      <= (heartbeat.filterMetrics?.outstandingEventLimit ?? 4)
    && (heartbeat.filterMetrics?.outstandingBytes ?? 0)
      <= (heartbeat.filterMetrics?.outstandingByteLimit ?? 1024 * 1024)
  )),
  'heartbeat gauges must never exceed either unified outstanding limit',
);
assert.equal(
  capacity.heartbeats.reduce((sum, heartbeat) => sum + (heartbeat.filterMetrics?.retryQueued ?? 0), 0),
  1,
);
assert.equal(
  capacity.heartbeats.reduce((sum, heartbeat) => sum + (heartbeat.filterMetrics?.retryAttempts ?? 0), 0),
  1,
);
assert.equal(
  capacity.heartbeats.reduce((sum, heartbeat) => sum + (heartbeat.filterMetrics?.retryRecovered ?? 0), 0),
  1,
);
assert.equal(
  capacity.heartbeats.reduce((sum, heartbeat) => sum + (heartbeat.filterMetrics?.queueDropped ?? 0), 0),
  1,
);
assert.equal(
  capacity.heartbeats.reduce((sum, heartbeat) => sum + (heartbeat.outputDropped ?? 0), 0),
  1,
);
assert.equal(
  capacity.heartbeats.reduce((sum, heartbeat) => sum + (heartbeat.errorCount ?? 0), 0),
  0,
);

const protectedReserveHeld = deferred();
let protectedReserveResponse;
let protectedReserveEvents;
const protectedReserveLines = [
  captureAggregate('reserve-a'),
  captureAggregate('reserve-b'),
  captureAggregate('reserve-c'),
  event('unknown-container', 'ToolExec', { pid: 3_070, argv: ['/usr/bin/true', 'reserve-tool'] }),
  event('unknown-container', 'SecurityAction', { pid: 3_071, kind: 'reserve-security' }),
];
const protectedReserve = await runConfig('protected-capacity-reserve', {
  FORWARD_FILTER_MODE: 'shadow',
  FORWARD_BATCH_SIZE: '1',
  FORWARD_BATCH_FLUSH_MS: '1',
  FORWARD_MAX_INFLIGHT: '1',
  FORWARD_MAX_OUTSTANDING_EVENTS: '4',
  FORWARD_MAX_OUTSTANDING_BYTES: String(1024 * 1024),
  FORWARD_PROTECTED_RESERVE_EVENTS: '2',
  FORWARD_PROTECTED_RESERVE_BYTES: '0',
}, protectedReserveLines, {
  heartbeatSecs: '0.02',
  timeoutMs: 6_000,
  heartbeatPredicate: (candidate) => candidate.filterMetrics?.shutdownFinal === true,
  batchReply: (events) => {
    const parsed = JSON.parse(events[0].line).event;
    if (parsed.CaptureAggregate?.qualifier === 'reserve-a') {
      return {
        handle: (response) => {
          protectedReserveResponse = response;
          protectedReserveEvents = events;
          protectedReserveHeld.resolve();
        },
      };
    }
    return { statusCode: 200, body: wrapped(acceptedBatchAck(events)) };
  },
  driveInput: async ({ child, lines, heartbeats }) => {
    child.stdin.write(`${lines[0]}\n`);
    await protectedReserveHeld.promise;
    child.stdin.write(`${lines.slice(1).join('\n')}\n`);
    await eventually(
      () => heartbeats.find((heartbeat) => (
        heartbeat.filterMetrics?.outstandingEvents === 4
        && heartbeat.filterMetrics?.protectedReserveEvents === 2
      )),
      500,
      'protected ownership reserve',
    );
    protectedReserveResponse.writeHead(200, { 'Content-Type': 'application/json' });
    protectedReserveResponse.end(JSON.stringify(wrapped(acceptedBatchAck(protectedReserveEvents))));
    child.stdin.end();
  },
});
const protectedReserveMarkers = protectedReserve.batchRequests.flatMap((events) => events.map((item) => {
  const parsed = JSON.parse(item.line).event;
  return parsed.CaptureAggregate?.qualifier
    ?? parsed.ToolExec?.argv.at(-1)
    ?? parsed.SecurityAction?.kind;
}));
for (const marker of ['reserve-a', 'reserve-b', 'reserve-tool', 'reserve-security']) {
  assert.equal(
    protectedReserveMarkers.filter((value) => value === marker).length,
    1,
    `${marker} must retain one delivery through the protected reserve: ${protectedReserveMarkers.join(', ')}`,
  );
}
assert.equal(
  protectedReserveMarkers.includes('reserve-c'),
  false,
  'routine aggregate traffic must not consume protected ownership slots',
);
assert.equal(protectedReserve.heartbeat.filterMetrics.protectedReserveEvents, 2);
assert.equal(
  protectedReserve.heartbeats.reduce(
    (sum, heartbeat) => sum + (heartbeat.filterMetrics?.protectedQueueDropped ?? 0),
    0,
  ),
  0,
);
assert.equal(
  protectedReserve.heartbeats.reduce(
    (sum, heartbeat) => sum + (heartbeat.filterMetrics?.queueDroppedByClass?.capture_aggregate ?? 0),
    0,
  ),
  1,
);
assert.equal(
  protectedReserve.heartbeats.reduce((sum, heartbeat) => {
    const reasons = heartbeat.pipelineAccounting?.stages
      ?.find((stage) => stage.stage === 'queue_dropped')?.reasons ?? [];
    return sum + (reasons.find((reason) => reason.reason === 'protected_reserve')?.count ?? 0);
  }, 0),
  1,
);

const expiryCapacityQueued = deferred();
const expiryCapacityResumed = deferred();
let expiryCapacityRequests = 0;
const expiryCapacityLines = [
  event('unknown-container', 'ToolExec', { pid: 3_068, argv: ['/usr/bin/true', 'expiry-capacity-a'] }),
  event('unknown-container', 'ToolExec', { pid: 3_069, argv: ['/usr/bin/true', 'expiry-capacity-b'] }),
];
const expiryCapacity = await runConfig('retry-expiry-releases-capacity', {
  FORWARD_FILTER_MODE: 'shadow',
  FORWARD_BATCH_SIZE: '1',
  FORWARD_MAX_INFLIGHT: '1',
  FORWARD_MAX_OUTSTANDING_EVENTS: '1',
  FORWARD_MAX_OUTSTANDING_BYTES: String(1024 * 1024),
  FORWARD_RETRY_BASE_DELAY_MS: '200',
  FORWARD_RETRY_MAX_DELAY_MS: '200',
  FORWARD_RETRY_MAX_AGE_MS: '100',
}, expiryCapacityLines, {
  heartbeatSecs: '0.02',
  heartbeatPredicate: (candidate) => candidate.filterMetrics?.shutdownFinal === true,
  batchReply: (events) => {
    expiryCapacityRequests++;
    const marker = JSON.parse(events[0].line).event.ToolExec.argv.at(-1);
    if (marker === 'expiry-capacity-a') {
      expiryCapacityQueued.resolve();
      return { statusCode: 200, body: wrapped(retryableBatchAck(events, 200)) };
    }
    expiryCapacityResumed.resolve();
    return { statusCode: 200, body: wrapped(acceptedBatchAck(events)) };
  },
  driveInput: async ({ child, lines, heartbeats }) => {
    child.stdin.write(`${lines[0]}\n`);
    await expiryCapacityQueued.promise;
    await eventually(
      () => heartbeats.find((heartbeat) => (
        heartbeat.filterMetrics?.retryQueueDepth === 1
        && heartbeat.filterMetrics?.outstandingEvents === 1
      )),
      500,
      'retry item occupying the unified one-event cap',
    );
    child.stdin.write(`${lines[1]}\n`);
    await within(expiryCapacityResumed.promise, 500, 'stdin resume after retry age expiry');
    child.stdin.end();
  },
});
const expiryCapacityMarkers = expiryCapacity.batchRequests.flatMap((events) => events.map((item) =>
  JSON.parse(item.line).event.ToolExec.argv.at(-1)));
assert.deepEqual(
  expiryCapacityMarkers,
  ['expiry-capacity-a', 'expiry-capacity-b'],
  'age expiry without an HTTP callback must resume stdin and admit the buffered next event',
);
assert.equal(
  expiryCapacity.heartbeats.reduce((sum, heartbeat) => sum + (heartbeat.filterMetrics?.retryAttempts ?? 0), 0),
  0,
  'a retry whose delay reaches its deadline expires without starting another request',
);
assert.equal(
  expiryCapacity.heartbeats.reduce((sum, heartbeat) => sum + (heartbeat.filterMetrics?.retryExhausted ?? 0), 0),
  1,
);
assert.equal(
  expiryCapacity.heartbeats.reduce((sum, heartbeat) => sum + (heartbeat.outputDropped ?? 0), 0),
  1,
);
assert.equal(expiryCapacity.heartbeat.filterMetrics.outstandingEvents, 0);

const byteCapacity = await runConfig('unified-outstanding-byte-capacity', {
  FORWARD_FILTER_MODE: 'shadow',
  FORWARD_BATCH_SIZE: '1',
  FORWARD_MAX_INFLIGHT: '1',
  FORWARD_MAX_OUTSTANDING_EVENTS: '10',
  FORWARD_MAX_OUTSTANDING_BYTES: '1024',
}, [event('unknown-container', 'ToolExec', {
  pid: 3_070,
  argv: ['/usr/bin/true', 'x'.repeat(4_000)],
})], { heartbeatSecs: '60' });
assert.equal(byteCapacity.batchRequests.length, 0, 'an event exceeding the unified byte budget is rejected');
assert.equal(byteCapacity.heartbeat.filterMetrics.outstandingByteLimit, 1024);
assert.equal(byteCapacity.heartbeat.filterMetrics.outstandingBytes, 0);
assert.equal(byteCapacity.heartbeat.filterMetrics.queueDropped, 1);
assert.equal(byteCapacity.heartbeat.outputDropped, 1);

const contradictoryDisposition = await runConfig('contradictory-disposition', {
  FORWARD_FILTER_MODE: 'shadow',
  FORWARD_BATCH_SIZE: '1',
  FORWARD_MAX_INFLIGHT: '1',
}, [event('unknown-container', 'ToolExec', { pid: 3_050, argv: ['/usr/bin/true', 'bad-disposition'] })], {
  batchReply: () => ({
    statusCode: 200,
    body: wrapped({
      accepted: true,
      acceptedEvents: 1,
      rejectedEvents: 0,
      items: [{ index: 0, accepted: true, disposition: 'rejected' }],
    }),
  }),
});
assert.equal(contradictoryDisposition.heartbeat.outputDropped, 1, 'a contradictory ACK disposition fails closed');
assert.ok(contradictoryDisposition.heartbeat.errorCount >= 1);

const oversizedAck = await runConfig('oversized-ack', {
  FORWARD_FILTER_MODE: 'shadow',
  FORWARD_BATCH_SIZE: '1',
  FORWARD_MAX_INFLIGHT: '1',
  FORWARD_BATCH_ACK_MAX_BYTES: String(16 * 1024),
  FORWARD_RETRY_BASE_DELAY_MS: '10',
  FORWARD_RETRY_MAX_DELAY_MS: '20',
  FORWARD_RETRY_MAX_AGE_MS: '100',
}, [event('unknown-container', 'ToolExec', { pid: 3_100, argv: ['/usr/bin/true', 'oversized-ack'] })], {
  batchReply: (events) => ({
    statusCode: 200,
    body: { ...wrapped(acceptedBatchAck(events)), padding: 'x'.repeat(20 * 1024) },
  }),
});
assert.equal(oversizedAck.heartbeat.outputDropped, 1, 'an oversized batch ACK must fail within its memory bound');
assert.ok(oversizedAck.heartbeat.errorCount >= 1);
assert.equal(oversizedAck.heartbeat.filterMetrics.queueDropped, 0);

const slowAckStartedAt = Date.now();
const slowAck = await runConfig('slow-ack-timeout', {
  FORWARD_FILTER_MODE: 'shadow',
  FORWARD_BATCH_SIZE: '1',
  FORWARD_MAX_INFLIGHT: '1',
  FORWARD_HTTP_TIMEOUT_MS: '1000',
  FORWARD_RETRY_BASE_DELAY_MS: '10',
  FORWARD_RETRY_MAX_DELAY_MS: '20',
  FORWARD_RETRY_MAX_AGE_MS: '100',
}, [event('unknown-container', 'ToolExec', { pid: 3_150, argv: ['/usr/bin/true', 'slow-ack'] })], {
  batchReply: () => ({
    handle: (response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      const timer = setInterval(() => response.write(' '), 100);
      response.once('close', () => clearInterval(timer));
    },
  }),
});
assert.ok(Date.now() - slowAckStartedAt < 3_000, 'trickled response bytes must not reset the absolute event timeout');
assert.ok(slowAck.batchRequests.length >= 1, 'an ordinary timeout remains bounded by the retry deadline');
assert.equal(slowAck.heartbeat.outputDropped, 1);
assert.ok(slowAck.heartbeat.errorCount >= 1);
assert.equal(slowAck.heartbeat.filterMetrics.queueDropped, 0);
assert.equal(slowAck.heartbeat.filterMetrics.retryQueued, 1);
assert.ok(slowAck.heartbeat.filterMetrics.retryAttempts >= 0);

const splitLines = Array.from({ length: 4 }, (_, index) => event(
  'unknown-container',
  'ToolExec',
  { pid: 3_200 + index, argv: ['/usr/bin/true', index === 2 ? 'reject-singleton' : `split-${index}`] },
));
const successfulSingletons = [];
let rejectedSingletonAttempts = 0;
let multi413Attempts = 0;
const split413StartedAt = Date.now();
const split413 = await runConfig('split-413', {
  FORWARD_FILTER_MODE: 'shadow',
  FORWARD_BATCH_SIZE: '4',
  FORWARD_MAX_INFLIGHT: '1',
  FORWARD_BATCH_ACK_MAX_BYTES: String(16 * 1024),
  FORWARD_HTTP_TIMEOUT_MS: '4000',
}, splitLines, {
  batchReply: (events) => {
    if (events.length > 1) {
      multi413Attempts++;
      if (multi413Attempts === 1) {
        // A proxy can return an HTML error body larger than the normal ACK cap. Non-2xx bodies
        // must be discarded without buffering, while the 413 status still triggers splitting.
        return { statusCode: 413, body: 'x'.repeat(20 * 1024) };
      }
      if (multi413Attempts === 2) return {
        handle: (response) => {
          // Some proxies close their generated 413 body after sending headers. The status remains
          // authoritative and the recoverable multi-event batch must still be split.
          response.writeHead(413, { 'Content-Type': 'text/html' });
          response.flushHeaders();
          setTimeout(() => response.destroy(), 10);
        },
      };
      return {
        handle: (response) => {
          // A 413 body may remain active forever while a reverse proxy trickles diagnostics.
          // Receiving the header must immediately close it and continue the finite split tree.
          response.writeHead(413, { 'Content-Type': 'text/html' });
          response.write(' ');
          const timer = setInterval(() => response.write(' '), 100);
          response.once('close', () => clearInterval(timer));
        },
      };
    }
    const line = events[0]?.line ?? '';
    if (line.includes('reject-singleton')) {
      rejectedSingletonAttempts++;
      return { statusCode: 413, body: { message: 'fixture event too large' } };
    }
    successfulSingletons.push(line);
    return { statusCode: 200, body: wrapped(acceptedBatchAck(events)) };
  },
});
assert.deepEqual(
  split413.batchRequests.map((events) => events.length).sort((a, b) => a - b),
  [1, 1, 1, 1, 2, 2, 4],
  '413 recovery must use a finite binary split tree',
);
assert.equal(new Set(successfulSingletons).size, 3);
assert.equal(successfulSingletons.length, 3, 'each accepted singleton must be delivered exactly once');
assert.equal(multi413Attempts, 3, 'each multi-event node in the binary split tree is attempted once');
assert.ok(Date.now() - split413StartedAt < 2_000, '413 headers must split without waiting for a trickled body timeout');
assert.equal(rejectedSingletonAttempts, 1, 'an irreducible 413 must not loop');
assert.equal(split413.heartbeat.filterMetrics.forwarded, splitLines.length);
assert.equal(split413.heartbeat.outputDropped, 1, 'only the irreducible singleton is dropped');
assert.ok(split413.heartbeat.errorCount >= 1);
assert.equal(split413.heartbeat.filterMetrics.queueDropped, 0);
assert.equal(split413.heartbeat.status, 'degraded');

const partial413Lines = Array.from({ length: 4 }, (_, index) => event(
  'unknown-container',
  'ToolExec',
  { pid: 3_300 + index, argv: ['/usr/bin/true', `partial-413-${index}`] },
));
let partial413Requests = 0;
const partial413 = await runConfig('partial-ack-after-413', {
  FORWARD_FILTER_MODE: 'shadow',
  FORWARD_BATCH_SIZE: '4',
  FORWARD_MAX_INFLIGHT: '1',
  FORWARD_RETRY_BASE_DELAY_MS: '10',
  FORWARD_RETRY_MAX_DELAY_MS: '20',
  FORWARD_RETRY_MAX_AGE_MS: '500',
}, partial413Lines, {
  heartbeatSecs: '60',
  batchReply: (events) => {
    partial413Requests++;
    if (partial413Requests === 1) return { statusCode: 413, body: 'split fixture' };
    const markers = events.map((item) => JSON.parse(item.line).event.ToolExec.argv.at(-1));
    if (markers.join(',') === 'partial-413-0,partial-413-1') {
      return {
        statusCode: 200,
        body: wrapped({
          accepted: true,
          acceptedEvents: 1,
          retainedEvents: 1,
          discardedEvents: 0,
          rejectedEvents: 0,
          retryableEvents: 1,
          retryAfterMs: 10,
          items: [
            { index: 0, accepted: true, disposition: 'retained' },
            {
              index: 1,
              accepted: false,
              disposition: 'retryable',
              reasonCode: 'clickhouse_event_buffer_full',
            },
          ],
        }),
      };
    }
    return { statusCode: 200, body: wrapped(acceptedBatchAck(events)) };
  },
});
assert.deepEqual(
  partial413.batchRequests.map((events) => events.map((item) =>
    JSON.parse(item.line).event.ToolExec.argv.at(-1))),
  [
    ['partial-413-0', 'partial-413-1', 'partial-413-2', 'partial-413-3'],
    ['partial-413-0', 'partial-413-1'],
    ['partial-413-2', 'partial-413-3'],
    ['partial-413-1'],
  ],
  '413 sub-batches use relative ACK indices and only replay their exact retryable item',
);
assert.equal(partial413.heartbeat.outputDropped, 0);
assert.equal(partial413.heartbeat.filterMetrics.retryQueued, 1);
assert.equal(partial413.heartbeat.filterMetrics.retryAttempts, 1);
assert.equal(partial413.heartbeat.filterMetrics.retryRecovered, 1);
assert.equal(partial413.heartbeat.filterMetrics.retryExhausted, 0);

const shutdown413RightStarted = deferred();
const shutdown413Lines = Array.from({ length: 4 }, (_, index) => event(
  'unknown-container',
  'ToolExec',
  { pid: 3_350 + index, argv: ['/usr/bin/true', `shutdown-413-${index}`] },
));
let shutdown413Requests = 0;
let shutdown413SignalAt = 0;
const shutdown413 = await runConfig('partial-413-shutdown', {
  FORWARD_FILTER_MODE: 'shadow',
  FORWARD_BATCH_SIZE: '4',
  FORWARD_MAX_INFLIGHT: '1',
  FORWARD_HTTP_TIMEOUT_MS: '120000',
  FORWARD_SHUTDOWN_TIMEOUT_MS: '2000',
}, shutdown413Lines, {
  heartbeatSecs: '60',
  timeoutMs: 3_500,
  batchReply: (events) => {
    shutdown413Requests++;
    if (shutdown413Requests === 1) return { statusCode: 413, body: 'split fixture' };
    if (shutdown413Requests === 2) {
      return {
        statusCode: 200,
        body: wrapped({
          accepted: true,
          acceptedEvents: 1,
          retainedEvents: 1,
          discardedEvents: 0,
          rejectedEvents: 0,
          retryableEvents: 1,
          retryAfterMs: 1_000,
          items: [
            { index: 0, accepted: true, disposition: 'retained' },
            {
              index: 1,
              accepted: false,
              disposition: 'retryable',
              reasonCode: 'clickhouse_event_buffer_full',
            },
          ],
        }),
      };
    }
    return {
      handle: () => shutdown413RightStarted.resolve(),
    };
  },
  driveInput: async ({ child, lines }) => {
    child.stdin.write(`${lines.join('\n')}\n`);
    await within(shutdown413RightStarted.promise, 1_000, 'hanging right 413 sub-batch');
    shutdown413SignalAt = Date.now();
    assert.equal(child.kill('SIGTERM'), true);
  },
});
assert.ok(Date.now() - shutdown413SignalAt < 3_000, '413 shutdown must remain wall-clock bounded');
assert.deepEqual(
  shutdown413.batchRequests.map((events) => events.map((item) =>
    JSON.parse(item.line).event.ToolExec.argv.at(-1))),
  [
    ['shutdown-413-0', 'shutdown-413-1', 'shutdown-413-2', 'shutdown-413-3'],
    ['shutdown-413-0', 'shutdown-413-1'],
    ['shutdown-413-2', 'shutdown-413-3'],
  ],
  'shutdown must not launch a late retry after aborting the hanging right 413 sub-batch',
);
assert.equal(shutdown413.heartbeat.outputDropped, 3);
assert.equal(shutdown413.heartbeat.errorCount, 2, 'a scheduled replay is not itself an operational error');
assert.equal(shutdown413.heartbeat.filterMetrics.retryQueued, 3);
assert.equal(shutdown413.heartbeat.filterMetrics.retryAttempts, 0);
assert.equal(shutdown413.heartbeat.filterMetrics.retryRecovered, 0);
assert.equal(shutdown413.heartbeat.filterMetrics.retryExhausted, 3);
assert.equal(shutdown413.heartbeat.filterMetrics.retryQueueDepth, 0);
assert.equal(shutdown413.heartbeat.filterMetrics.retryOutstandingEvents, 0);
assert.equal(shutdown413.heartbeat.filterMetrics.outstandingEvents, 0);
assert.equal(shutdown413.heartbeat.filterMetrics.outstandingBytes, 0);
assert.equal(shutdown413.heartbeat.filterMetrics.shutdownFinal, true);

const safeDefault = await runConfig('safe-default', { FORWARD_FILTER_MODE: '' });
assert.equal(safeDefault.heartbeat.filterMetrics.filterMode, 'shadow');
assert.equal(safeDefault.batches.length, 6, 'an unset filter mode must fail safe to shadow');
assert.equal(safeDefault.heartbeat.filterMetrics.filteredNonAgent, 0);
assert.equal(safeDefault.heartbeat.filterMetrics.wouldFilterNonAgent, 0);
assert.doesNotMatch(safeDefault.heartbeat.message, /e2e_marker_/u, 'unset E2E scope must preserve the production message contract');

const rawHeartbeatLine = collectorHeartbeat('raw-control-heartbeat');
const rawHeartbeat = await runConfig('raw-control-heartbeat', {
  FORWARD_FILTER_MODE: 'enforce',
  FORWARD_RETAIN_UNKNOWN: 'false',
}, [rawHeartbeatLine], { expectedObserved: 0 });
assert.equal(rawHeartbeat.batches.length, 1, 'raw CollectorHeartbeat must bypass Agent filtering');
assert.equal(rawHeartbeat.batches[0].line, rawHeartbeatLine);
assert.equal(rawHeartbeat.batches[0].attribution, undefined, 'raw heartbeat must not gain Agent attribution');
assert.equal(rawHeartbeat.heartbeat.filterMetrics.observed, 0, 'raw heartbeat is not Agent activity');
assert.equal(rawHeartbeat.heartbeat.filterMetrics.unknown, 0, 'raw heartbeat is not an unknown Agent');
assert.equal(rawHeartbeat.heartbeat.filterMetrics.forwarded, 0, 'raw heartbeat is not an Agent forward count');
assert.equal(rawHeartbeat.heartbeat.filterMetrics.discoveryBudgetDropped, 0);

const scopedPrefix = 'asel-marker-run-docker-shadow-';
const scopedMarkerValue = scopedPrefix + 'pi';
const scopedMarkerLine = event('unknown-container', 'ToolExec', {
  pid: 20,
  argv: ['/usr/bin/true', scopedMarkerValue],
});
const scopedHeartbeatLine = collectorHeartbeat('scoped-control-heartbeat');
const scopedIngest = await runConfig('e2e-marker-scope', {
  FORWARD_FILTER_MODE: 'shadow',
  FORWARD_RETAIN_UNKNOWN: 'false',
  ANYSENTRY_E2E_INGEST_MARKER_PREFIX: scopedPrefix,
  ANYSENTRY_E2E_FILTER_MARKER_SHA256: createHash('sha256')
    .update(JSON.stringify(scopedMarkerValue))
    .digest('hex'),
}, [
  scopedHeartbeatLine,
  event('pi-runtime', 'ToolExec', { pid: 30, argv: ['pi', '--print'] }, {
    comm: 'pi',
    exe: '/usr/local/bin/pi',
  }),
  scopedMarkerLine,
  event('unknown-container', 'ToolExec', {
    pid: 20,
    argv: ['/usr/bin/true', 'asel-marker-run-docker-shadow-child-docker-shadow-pi'],
  }),
  event('unknown-container', 'ToolExec', {
    pid: 20,
    argv: ['/usr/bin/true', 'asel-marker-run-k8s-shadow-pi'],
  }),
  event('unknown-container', 'ToolExec', {
    pid: 20,
    argv: ['/usr/bin/true', 'asel-marker-run-docker-enforce-pi'],
  }),
  event('unknown-container', 'FileAccess', {
    pid: 20,
    path: '/workspace/' + scopedPrefix + 'spoof',
  }),
], { expectedObserved: 6 });
assert.equal(scopedIngest.batches.length, 2, 'E2E scope must retain only heartbeat and marker ToolExec');
assert.ok(scopedIngest.batches.some((item) => item.line === scopedHeartbeatLine));
assert.ok(scopedIngest.batches.some((item) => item.line === scopedMarkerLine));
assert.equal(scopedIngest.heartbeat.filterMetrics.observed, 6, 'scope must run after attribution');
assert.equal(scopedIngest.heartbeat.filterMetrics.forwarded, 1);
assert.equal(scopedIngest.heartbeat.filterMetrics.probableAgent, 1);
assert.equal(scopedIngest.heartbeat.filterMetrics.wouldFilterUnknown, 0);
assert.equal(scopedIngest.heartbeat.filterMetrics.wouldDiscoveryBudgetDrop, 0);
assert.match(scopedIngest.heartbeat.message, /e2e_marker_scope=enabled/u);
assert.match(scopedIngest.heartbeat.message, /e2e_marker_scoped_out=5/u);
assert.equal(
  scopedIngest.heartbeat.filterMetrics.e2eFilterReceipts,
  undefined,
  'retained Unknown markers must not produce a filter receipt',
);
assert.ok(
  scopedIngest.runtimeSnapshots.some((snapshot) => snapshot.entries?.some((entry) =>
    entry.agentScopeId === 'pi' &&
    entry.rootPid === 30 &&
    entry.rootStartTimeTicks === '300' &&
    entry.hostId === 'node-test' &&
    entry.bootId === 'boot-test',
  )),
  'a non-marker Pi root must still reach runtime discovery and snapshots',
);

for (const invalidPrefix of [
  '',
  'asel-marker-',
  'asel-marker-SCOPE-test-docker-shadow-',
  ' asel-marker-scope-test-docker-shadow-',
  'asel-marker-scope-test-docker-shadow',
  'asel-marker-' + 'a'.repeat(29) + '-docker-shadow-',
  'asel-marker-scope\ntest-docker-shadow-',
  'asel-marker-scope-test-vm-shadow-',
  'asel-marker-scope-test-docker-audit-',
]) {
  const invalidScopedIngest = spawnSync(process.execPath, [forwarder], {
    env: {
      ...process.env,
      ANYSENTRY_E2E_INGEST_MARKER_PREFIX: invalidPrefix,
    },
    input: '',
    encoding: 'utf8',
    timeout: 2_000,
  });
  assert.notEqual(invalidScopedIngest.status, 0, 'invalid E2E marker scope must fail closed');
  assert.match(invalidScopedIngest.stderr, /must identify one bounded E2E collector phase/u);
  if (invalidPrefix) {
    assert.doesNotMatch(
      invalidScopedIngest.stderr,
      new RegExp(invalidPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'u'),
    );
  }
}

const defaultRetention = await runConfig('default');
assert.equal(defaultRetention.batches.length, 6);
assert.equal(defaultRetention.heartbeat.filterMetrics.filteredNonAgent, 0);
assert.equal(defaultRetention.heartbeat.filterMetrics.filteredNoise, 0);
assert.equal(defaultRetention.heartbeat.filterMetrics.unknown, 5);
assert.equal(defaultRetention.heartbeat.filterMetrics.discoveryBudgetDropped, 0);
assert.equal(defaultRetention.heartbeat.filterMetrics.lastSuppressedAt, undefined);
assert.ok(
  defaultRetention.batches.some((item) => JSON.parse(item.line).event.FileDelete),
  'high-value FileDelete survives even for a pseudo-filesystem path',
);
assert.ok(
  defaultRetention.batches.some((item) => JSON.parse(item.line).event.SecurityAction),
  'SecurityAction survives unknown routing',
);

const unknownFileBudget = await runConfig('unknown-file-budget', {
  ANYSENTRY_BEHAVIOR_DISCOVERY: 'off',
  FORWARD_FILTER_MODE: 'enforce',
  FORWARD_RETAIN_UNKNOWN: 'true',
  FORWARD_NOISE_POLICY: 'include',
  FORWARD_UNKNOWN_FILE_RATE: '2',
  FORWARD_UNKNOWN_FILE_GLOBAL_RATE: '10',
}, Array.from({ length: 5 }, (_, index) => event(
  'unknown-container',
  'FileAccess',
  { pid: 20, path: `/workspace/budget-${index}.json`, write: true },
)), { expectedObserved: 5 });
assert.equal(unknownFileBudget.batches.length, 5, 'unknown FileAccess must be retained losslessly regardless of legacy budget settings');
assert.equal(unknownFileBudget.heartbeat.filterMetrics.filteredUnknown, 0);
assert.equal(unknownFileBudget.heartbeat.filterMetrics.discoveryBudgetDropped, 0);

const repeatedAgentFiles = Array.from({ length: 100 }, () => event(
  'unknown-container',
  'FileAccess',
  { pid: 30, path: '/workspace/cache.json', write: true, flags: 1 },
  { comm: 'pi', exe: '/usr/local/bin/pi' },
));
const aggregatedAgentFiles = await runConfig('agent-file-aggregation', {
  FORWARD_FILTER_MODE: 'enforce',
  FORWARD_FILE_AGGREGATION: 'true',
  FORWARD_FILE_AGGREGATION_WINDOW_MS: '1000',
}, repeatedAgentFiles, { expectedObserved: 100 });
assert.equal(aggregatedAgentFiles.batches.length, 1, 'exact repeated Agent FileAccess must become one transport event');
const aggregatedAgentFile = JSON.parse(aggregatedAgentFiles.batches[0].line).event.FileAccess;
assert.equal(aggregatedAgentFile.repeatCount, 100);
assert.equal(aggregatedAgentFile.repeat_count, 100);
assert.equal(aggregatedAgentFile.firstEventAt, aggregatedAgentFile.first_event_at);
assert.equal(aggregatedAgentFile.lastEventAt, aggregatedAgentFile.last_event_at);
assert.equal(aggregatedAgentFile.aggregationWindowMs, 1000);
assert.equal(aggregatedAgentFile.aggregation_window_ms, 1000);
assert.equal(aggregatedAgentFiles.batches[0].attribution.classification, 'probable_agent');
assert.equal(aggregatedAgentFiles.heartbeats.reduce(
  (sum, heartbeat) => sum + (heartbeat.filterMetrics?.aggregatedFileEvents ?? 0), 0,
), 99);
assert.equal(aggregatedAgentFiles.heartbeats.reduce(
  (sum, heartbeat) => sum + (heartbeat.filterMetrics?.aggregationOutputs ?? 0), 0,
), 1);

const repeatedUnknownFiles = Array.from({ length: 75 }, () => event(
  'unknown-container',
  'FileAccess',
  { pid: 32, path: '/workspace/unknown-cache.json', write: true, flags: 1 },
));
const aggregatedUnknownFiles = await runConfig('unknown-file-aggregation', {
  ANYSENTRY_BEHAVIOR_DISCOVERY: 'off',
  FORWARD_FILTER_MODE: 'enforce',
  FORWARD_RETAIN_UNKNOWN: 'true',
  FORWARD_NOISE_POLICY: 'include',
  FORWARD_FILE_AGGREGATION: 'true',
  FORWARD_FILE_AGGREGATION_WINDOW_MS: '1000',
}, repeatedUnknownFiles, { expectedObserved: 75 });
assert.equal(aggregatedUnknownFiles.batches.length, 1, 'strict repeated Unknown FileAccess must become one lossless transport event');
const aggregatedUnknownFile = JSON.parse(aggregatedUnknownFiles.batches[0].line).event.FileAccess;
assert.equal(aggregatedUnknownFile.repeatCount, 75);
assert.equal(aggregatedUnknownFile.repeat_count, 75);
assert.equal(aggregatedUnknownFile.firstEventAt, aggregatedUnknownFile.first_event_at);
assert.equal(aggregatedUnknownFile.lastEventAt, aggregatedUnknownFile.last_event_at);
assert.equal(aggregatedUnknownFile.aggregationWindowMs, 1000);
assert.equal(aggregatedUnknownFile.aggregation_window_ms, 1000);
assert.equal(aggregatedUnknownFiles.batches[0].attribution.classification, 'unknown');
assert.equal(aggregatedUnknownFiles.heartbeats.reduce(
  (sum, heartbeat) => sum + (heartbeat.filterMetrics?.aggregatedFileEvents ?? 0), 0,
), 74);
assert.equal(aggregatedUnknownFiles.heartbeats.reduce(
  (sum, heartbeat) => sum + (heartbeat.filterMetrics?.aggregationOutputs ?? 0), 0,
), 1);
assert.equal(aggregatedUnknownFiles.heartbeat.filterMetrics.filteredUnknown, 0);
assert.equal(aggregatedUnknownFiles.heartbeat.filterMetrics.discoveryBudgetDropped, 0);

const repeatedDeletes = Array.from({ length: 5 }, () => event(
  'unknown-container',
  'FileDelete',
  { pid: 33, path: '/workspace/delete-me.json' },
));
const unaggregatedDeletes = await runConfig('file-delete-no-aggregation', {
  ANYSENTRY_BEHAVIOR_DISCOVERY: 'off',
  FORWARD_FILTER_MODE: 'enforce',
  FORWARD_RETAIN_UNKNOWN: 'true',
  FORWARD_NOISE_POLICY: 'include',
  FORWARD_FILE_AGGREGATION: 'true',
}, repeatedDeletes, { expectedObserved: 5 });
assert.equal(unaggregatedDeletes.batches.length, 5, 'FileDelete must remain one transport event per observation');
assert.ok(unaggregatedDeletes.batches.every((item) => JSON.parse(item.line).event.FileDelete));
assert.equal(unaggregatedDeletes.heartbeat.filterMetrics.aggregatedFileEvents, 0);

const agentPseudoFile = await runConfig('agent-pseudo-file', {
  FORWARD_FILTER_MODE: 'enforce',
  FORWARD_NOISE_POLICY: 'balanced',
}, [event(
  'unknown-container',
  'FileAccess',
  { pid: 31, path: '/proc/sys/kernel/core_pattern', write: true },
  { comm: 'pi', exe: '/usr/local/bin/pi' },
)], { expectedObserved: 1 });
assert.equal(agentPseudoFile.batches.length, 1, 'confirmed/probable Agent pseudo-filesystem writes must not be hidden as routine host noise');
assert.equal(agentPseudoFile.heartbeat.filterMetrics.filteredNoise, 0);

const filterRuleDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'anysentry-forward-filter-rules-'));
const filterRuleFile = path.join(filterRuleDirectory, 'rules.json');
const publishedRules = await runConfig('filter-rule-publisher', {
  FORWARD_FILTER_MODE: 'enforce',
  ANYSENTRY_FILTER_RULES_FILE: filterRuleFile,
  FORWARD_FILTER_RULE_FLUSH_MS: '10',
}, [
  event('nonagent-container', 'ToolExec', { pid: 10, argv: ['true'] }),
  event('unknown-container', 'ToolExec', { pid: 30, argv: ['pi', '--print'] }, { comm: 'pi', exe: '/usr/local/bin/pi' }),
], { expectedObserved: 2 });
const filterSnapshot = JSON.parse(fs.readFileSync(filterRuleFile, 'utf8'));
assert.equal(filterSnapshot.schemaVersion, 'anysentry.filter_rule_snapshot.v1');
assert.ok(filterSnapshot.entries.some((entry) => entry.cgroupId === '10' && entry.action === 'drop' && entry.authority === 'authoritative'));
assert.ok(filterSnapshot.entries.some((entry) => entry.cgroupId === '30' && entry.action === 'keep'));
assert.ok(publishedRules.heartbeat.filterMetrics.filterRuleVersion > 0);
fs.rmSync(filterRuleDirectory, { recursive: true, force: true });

const e2eMarker = 'asel-marker-filter-receipt-docker-enforce-pi';
const e2eMarkerLine = event('nonagent-container', 'ToolExec', {
  pid: 10,
  argv: ['/usr/bin/true', e2eMarker],
});
const e2eReceipt = await runConfig('e2e-protected-structural', {
  FORWARD_RETAIN_UNKNOWN: 'false',
  ANYSENTRY_E2E_INGEST_MARKER_PREFIX: 'asel-marker-filter-receipt-docker-enforce-',
  ANYSENTRY_E2E_FILTER_MARKER_VALUE: e2eMarker,
  ANYSENTRY_E2E_FILTER_MARKER_SHA256: createHash('sha256').update(JSON.stringify(e2eMarker)).digest('hex'),
}, [e2eMarkerLine], { expectedObserved: 1 });
assert.equal(
  e2eReceipt.batches.length,
  1,
  'non-Agent ToolExec must reach the structural lifecycle consumer',
);
assert.equal(e2eReceipt.heartbeat.filterMetrics.filteredNonAgent, 0);
assert.equal(e2eReceipt.heartbeat.filterMetrics.filteredUnknown, 0);
assert.equal(e2eReceipt.heartbeat.filterMetrics.discoveryBudgetDropped, 0);
assert.equal(e2eReceipt.heartbeat.filterMetrics.e2eFilterReceipts, undefined);

await runManualReviewRecovery();
await runHungShutdownScenario();

console.log('Independent retention/noise/shadow pipeline verification passed');
