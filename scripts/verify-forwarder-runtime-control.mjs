#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const forwarder = fileURLToPath(new URL('./observer-forward.js', import.meta.url));

function waitFor(label, predicate, timeoutMs = 5_000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      const value = predicate();
      if (value) {
        resolve(value);
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error(`timed out waiting for ${label}`));
        return;
      }
      setTimeout(poll, 20);
    };
    poll();
  });
}

async function withForwarder(label, respond, verify) {
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      const parsed = body ? JSON.parse(body) : undefined;
      requests.push({ method: request.method, url: request.url, body: parsed });
      const payload = respond({ method: request.method, url: request.url, body: parsed }, requests);
      response.writeHead(payload?.status ?? 200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(payload?.body ?? { accepted: true }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const child = spawn(process.execPath, [forwarder], {
    env: {
      ...process.env,
      ANYSENTRY_INGEST_URL: `http://127.0.0.1:${address.port}/security-center/ingest`,
      ANYSENTRY_AGENT_RUNTIME_SNAPSHOT_SECS: '1',
      ANYSENTRY_AGENT_RUNTIME_LIVENESS_SECS: '1',
      ANYSENTRY_IDENTITY_SNAPSHOT_SECS: '0',
      ANYSENTRY_HEARTBEAT_SECS: '0.05',
      ANYSENTRY_DOCKER_DISCOVERY: 'off',
      ANYSENTRY_BEHAVIOR_DISCOVERY: 'off',
      ANYSENTRY_AGENT_TEMPLATES_JSON: '[]',
      A3S_OBSERVER_COLLECTOR_ID: `runtime-control-${label}`,
    },
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  try {
    await verify(requests);
    child.stdin.end();
    const exitCode = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`forwarder ${label} did not exit: ${stderr}`));
      }, 5_000);
      child.once('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    assert.equal(exitCode, 0, stderr);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    await new Promise((resolve) => server.close(resolve));
  }
}

await withForwarder(
  'api-restart',
  (request, requests) => {
    if (request.url === '/security-center/runtime/lease') {
      const leases = requests.filter((item) => item.url === request.url).length;
      return { body: { accepted: true, leaseEpoch: leases } };
    }
    if (request.url === '/security-center/runtime/snapshot') {
      const snapshots = requests.filter((item) => item.url === request.url).length;
      if (snapshots === 1) {
        return {
          body: {
            accepted: false,
            applied: false,
            duplicate: false,
            reasonCode: 'lease_not_found',
            reason: 'runtime lease not found after API restart',
          },
        };
      }
      return { body: { accepted: true, applied: true, duplicate: false } };
    }
    return { body: { accepted: true } };
  },
  async (requests) => {
    await waitFor(
      'a new lease and successful snapshot after API lease loss',
      () => requests.filter((item) => item.url === '/security-center/runtime/snapshot').length >= 2,
    );
    const leases = requests.filter((item) => item.url === '/security-center/runtime/lease');
    const snapshots = requests.filter((item) => item.url === '/security-center/runtime/snapshot');
    assert.equal(leases.length, 2);
    assert.equal(snapshots[0].body.leaseEpoch, 1);
    assert.equal(snapshots[1].body.leaseEpoch, 2);
    assert.equal(leases[0].body.collectorId, 'runtime-control-api-restart');
    assert.equal(typeof leases[0].body.hostId, 'string');
    assert.equal(typeof leases[0].body.bootId, 'string');
    assert.equal(leases[0].body.forwarderPid > 0, true);
    assert.match(leases[0].body.forwarderStartTimeTicks, /^\d+$/u);
  },
);

await withForwarder(
  'fenced',
  (request) => {
    if (request.url === '/security-center/runtime/lease') {
      return { body: { accepted: true, leaseEpoch: 7 } };
    }
    if (request.url === '/security-center/runtime/snapshot') {
      return {
        body: {
          accepted: false,
          applied: false,
          duplicate: false,
          reasonCode: 'lease_epoch_stale',
          reason: 'lease epoch was fenced by a newer forwarder',
        },
      };
    }
    return { body: { accepted: true } };
  },
  async (requests) => {
    await waitFor(
      'the first fenced runtime snapshot',
      () => requests.some((item) => item.url === '/security-center/runtime/snapshot'),
    );
    await new Promise((resolve) => setTimeout(resolve, 1_250));
    assert.equal(
      requests.filter((item) => item.url === '/security-center/runtime/lease').length,
      1,
      'a fenced old process must never acquire a newer lease automatically',
    );
    assert.equal(
      requests.filter((item) => item.url === '/security-center/runtime/snapshot').length,
      1,
      'a fenced old process must stop publishing lifecycle snapshots',
    );
    const heartbeat = [...requests]
      .reverse()
      .find((item) => item.url === '/security-center/collectors/heartbeat')?.body;
    assert.equal(heartbeat?.filterMetrics?.runtimeLeaseFenced, true);
    assert.equal(heartbeat?.filterMetrics?.runtimeSnapshotRejected, 1);
    assert.match(heartbeat?.filterMetrics?.lastRuntimeSnapshotError ?? '', /fenced/u);
  },
);

await withForwarder(
  'lease-fenced',
  (request) => {
    if (request.url === '/security-center/runtime/lease') {
      return {
        body: {
          accepted: false,
          reasonCode: 'stale_forwarder',
          reason: 'this forwarder process instance was already superseded',
        },
      };
    }
    return { body: { accepted: true } };
  },
  async (requests) => {
    await waitFor(
      'the direct lease fencing decision',
      () => requests.some((item) => item.url === '/security-center/runtime/lease'),
    );
    await new Promise((resolve) => setTimeout(resolve, 1_250));
    assert.equal(
      requests.filter((item) => item.url === '/security-center/runtime/lease').length,
      1,
      'a process fenced while acquiring its lease must not retry every snapshot interval',
    );
    assert.equal(
      requests.some((item) => item.url === '/security-center/runtime/snapshot'),
      false,
      'a process without an accepted lease must never publish a lifecycle snapshot',
    );
    const heartbeat = [...requests]
      .reverse()
      .find((item) => item.url === '/security-center/collectors/heartbeat')?.body;
    assert.equal(heartbeat?.filterMetrics?.runtimeLeaseFenced, true);
    assert.equal(heartbeat?.filterMetrics?.runtimeLeaseErrors, 1);
    assert.match(heartbeat?.filterMetrics?.lastRuntimeSnapshotError ?? '', /superseded/u);
  },
);

await withForwarder(
  'lease-takeover-after-ttl',
  (request, requests) => {
    if (request.url === '/security-center/runtime/lease') {
      const attempts = requests.filter((item) => item.url === request.url).length;
      if (attempts === 1) {
        return {
          body: {
            accepted: false,
            reasonCode: 'collector_conflict',
            reason: 'the previous host lease is still fresh',
          },
        };
      }
      return { body: { accepted: true, leaseEpoch: 2 } };
    }
    if (request.url === '/security-center/runtime/snapshot') {
      return { body: { accepted: true, applied: true, duplicate: false } };
    }
    return { body: { accepted: true } };
  },
  async (requests) => {
    await waitFor(
      'collector takeover after the old host lease expires',
      () => requests.some((item) => item.url === '/security-center/runtime/snapshot'),
    );
    assert.equal(requests.filter((item) => item.url === '/security-center/runtime/lease').length, 2);
    assert.equal(
      requests.find((item) => item.url === '/security-center/runtime/snapshot')?.body?.leaseEpoch,
      2,
    );
  },
);

console.log('Forwarder runtime lease, business ACK, API restart, and fencing verification passed');
