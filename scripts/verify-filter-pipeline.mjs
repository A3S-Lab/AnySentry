#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
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

function acceptedBatchAck(events) {
  return {
    accepted: events.length > 0,
    acceptedEvents: events.length,
    rejectedEvents: 0,
    items: events.map((_, index) => ({ index, accepted: true })),
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

async function runConfig(label, env = {}, inputLines, options = {}) {
  const batches = [];
  const batchRequests = [];
  const batchRequestBytes = [];
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
        const reply = options.batchReply?.(events) ?? {
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
        response.end('{"accepted":true,"applied":true,"duplicate":false}');
      } else {
        response.end('{"accepted":true}');
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const api = `http://127.0.0.1:${address.port}/security-center/ingest`;
  const child = spawn(process.execPath, [forwarder], {
    env: {
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
      ANYSENTRY_IDENTITY_SNAPSHOT_SECS: '0.05',
      ANYSENTRY_HEARTBEAT_SECS: '0.05',
      ANYSENTRY_DOCKER_DISCOVERY: 'off',
      ANYSENTRY_BEHAVIOR_DISCOVERY: 'off',
      ANYSENTRY_AGENT_TEMPLATES_JSON: '[]',
      A3S_OBSERVER_COLLECTOR_ID: `filter-${label}`,
    },
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  await snapshotRequested;
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
  child.stdin.end(`${lines.join('\n')}\n`);
  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`forwarder ${label} timed out: ${stderr}`));
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
  assert.ok(heartbeat, `missing structured ${label} heartbeat: ${JSON.stringify(heartbeats)}`);
  return { batches, batchRequests, batchRequestBytes, heartbeat };
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
  child.stdin.write(`${event('reviewed-container', 'ToolExec', { pid: 30, argv: ['blocked'] })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 40));
  snapshotVersion = 2;
  await recoverySnapshot;
  await new Promise((resolve) => setTimeout(resolve, 20));
  child.stdin.end(`${event('reviewed-container', 'ToolExec', { pid: 31, argv: ['observed-again'] })}\n`);

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
  assert.deepEqual(recovered.event.ToolExec.argv, ['observed-again']);
  assert.equal(batches[0].attribution?.classification, 'unknown');
  assert.equal(batches[0].attribution?.source, 'manual_review');
  const heartbeat = heartbeats.find((candidate) => candidate.filterMetrics?.lastSuppressedAt);
  assert.ok(heartbeat, `missing manual suppression heartbeat: ${JSON.stringify(heartbeats)}`);
  assert.match(heartbeat?.filterMetrics?.lastSuppressedAt ?? '', /^\d{4}-\d{2}-\d{2}T/u);
}

async function runHungShutdownScenario() {
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

  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      const parsed = body ? JSON.parse(body) : {};
      const receivedAt = Date.now();
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
          hungControlSockets.add(request.socket);
          snapshotWhileBatchOpen.resolve(record);
          hangResponseBody(response);
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
        if (hangControlTraffic && hungHeartbeats < 3) {
          hungHeartbeats++;
          hungControlSockets.add(request.socket);
          if (hungHeartbeats === 3) controlAgentSaturated.resolve();
          hangResponseBody(response);
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
        ANYSENTRY_IDENTITY_SNAPSHOT_SECS: '0',
        ANYSENTRY_HEARTBEAT_SECS: '0.05',
        ANYSENTRY_AGENT_RUNTIME_SNAPSHOT_SECS: '1',
        ANYSENTRY_AGENT_RUNTIME_LIVENESS_SECS: '300',
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
      record.receivedAt >= signalAt && record.body.outputDropped >= 1);
    assert.ok(finalHeartbeat, `missing final dropped-event heartbeat: ${JSON.stringify(heartbeats.map((item) => item.body))}`);
    assert.ok(finalHeartbeat.body.errorCount >= 1);
    assert.equal(finalHeartbeat.body.filterMetrics?.queueDropped, 0);
  } finally {
    if (child && !childExit) child.kill('SIGKILL');
    child?.stdin.destroy();
    for (const timer of trickleTimers) clearInterval(timer);
    trickleTimers.clear();
    const closed = new Promise((resolve) => server.close(resolve));
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    for (const socket of sockets) socket.destroy();
    await closed;
  }
}

const include = await runConfig('include', {
  FORWARD_RETAIN_NON_AGENT: 'true',
  FORWARD_NOISE_POLICY: 'include',
});
assert.equal(include.batches.length, 6);
assert.equal(include.heartbeat.filterMetrics.filteredNonAgent, 0);
assert.equal(include.heartbeat.filterMetrics.filteredNoise, 0);

const shadow = await runConfig('shadow', { FORWARD_FILTER_MODE: 'shadow' });
assert.equal(shadow.batches.length, 6, 'shadow forwards every retention decision');
assert.equal(shadow.heartbeat.filterMetrics.wouldFilterNonAgent, 1);
assert.equal(shadow.heartbeat.filterMetrics.wouldFilterNoise, 1);
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
assert.equal(policyDiscardAck.heartbeat.filterMetrics.wouldFilterNonAgent, policyDiscardLines.length);
assert.equal(policyDiscardAck.heartbeat.outputDropped, 0, 'a deliberate policy discard is not a transport drop');
assert.equal(policyDiscardAck.heartbeat.errorCount, 0, 'a deliberate policy discard does not degrade collector health');
assert.equal(policyDiscardAck.heartbeat.status, 'ok');

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
  FORWARD_MAX_QUEUE_BYTES: String(1024 * 1024),
}, byteBoundLines);
assert.equal(byteBound.batches.length, byteBoundLines.length);
assert.ok(byteBound.batchRequestBytes.length >= 4, 'large events must be split into multiple HTTP batches');
assert.ok(
  byteBound.batchRequestBytes.every((bytes) => bytes <= 64 * 1024 + 512),
  `serialized HTTP batch exceeded its byte budget: ${byteBound.batchRequestBytes.join(', ')}`,
);

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
assert.equal(slowAck.heartbeat.outputDropped, 1);
assert.ok(slowAck.heartbeat.errorCount >= 1);
assert.equal(slowAck.heartbeat.filterMetrics.queueDropped, 0);

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

const safeDefault = await runConfig('safe-default', { FORWARD_FILTER_MODE: '' });
assert.equal(safeDefault.heartbeat.filterMetrics.filterMode, 'shadow');
assert.equal(safeDefault.batches.length, 6, 'an unset filter mode must fail safe to shadow');
assert.equal(safeDefault.heartbeat.filterMetrics.filteredNonAgent, 0);
assert.equal(safeDefault.heartbeat.filterMetrics.wouldFilterNonAgent, 1);

const defaultRetention = await runConfig('default');
assert.equal(defaultRetention.batches.length, 4);
assert.equal(defaultRetention.heartbeat.filterMetrics.filteredNonAgent, 1);
assert.equal(defaultRetention.heartbeat.filterMetrics.filteredNoise, 1);
assert.equal(defaultRetention.heartbeat.filterMetrics.unknown, 5);
assert.equal(defaultRetention.heartbeat.filterMetrics.discoveryBudgetDropped, 0);
assert.match(defaultRetention.heartbeat.filterMetrics.lastSuppressedAt, /^\d{4}-\d{2}-\d{2}T/u);
assert.ok(
  defaultRetention.batches.some((item) => JSON.parse(item.line).event.FileDelete),
  'high-value FileDelete survives even for a pseudo-filesystem path',
);
assert.ok(
  defaultRetention.batches.some((item) => JSON.parse(item.line).event.SecurityAction),
  'SecurityAction survives unknown routing',
);

const e2eMarker = 'asel-marker-filter-receipt-test';
const e2eMarkerLine = event('unknown-container', 'ToolExec', {
  pid: 20,
  argv: ['/usr/bin/true', e2eMarker],
});
const e2eReceipt = await runConfig('e2e-receipt', {
  FORWARD_RETAIN_UNKNOWN: 'false',
  ANYSENTRY_E2E_FILTER_MARKER_VALUE: e2eMarker,
  ANYSENTRY_E2E_FILTER_MARKER_SHA256: createHash('sha256').update(JSON.stringify(e2eMarker)).digest('hex'),
});
assert.equal(e2eReceipt.batches.length, 0, 'E2E unknown marker must be filtered in enforce mode');
assert.equal(e2eReceipt.heartbeat.filterMetrics.discoveryBudgetDropped, 5);
assert.deepEqual(e2eReceipt.heartbeat.filterMetrics.e2eFilterReceipts, [{
  schema: 'anysentry.e2e_filter_receipt.v1',
  eventKind: 'ToolExec',
  markerSha256: createHash('sha256').update(JSON.stringify(e2eMarker)).digest('hex'),
  lineSha256: createHash('sha256').update(e2eMarkerLine).digest('hex'),
  physicalWorkloadId: 'docker:test:unknown',
  classification: 'unknown',
  filterReason: 'unknown',
  filteredAt: e2eReceipt.heartbeat.filterMetrics.e2eFilterReceipts[0].filteredAt,
}]);
assert.match(e2eReceipt.heartbeat.filterMetrics.e2eFilterReceipts[0].filteredAt, /^\d{4}-\d{2}-\d{2}T/u);
assert.doesNotMatch(JSON.stringify(e2eReceipt.heartbeat.filterMetrics.e2eFilterReceipts), new RegExp(e2eMarker, 'u'));

await runManualReviewRecovery();
await runHungShutdownScenario();

console.log('Independent retention/noise/shadow pipeline verification passed');
