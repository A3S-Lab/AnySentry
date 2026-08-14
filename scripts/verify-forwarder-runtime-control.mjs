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
      if (payload?.destroy === true) {
        response.destroy();
        return;
      }
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
    await verify(requests, child);
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
  'snapshot-transport-retry',
  (request, requests) => {
    if (request.url === '/security-center/runtime/lease') {
      return { body: { accepted: true, leaseEpoch: 3 } };
    }
    if (request.url === '/security-center/runtime/snapshot') {
      const snapshots = requests.filter((item) => item.url === request.url).length;
      if (snapshots === 1) return { destroy: true };
      return { body: { accepted: true, applied: false, duplicate: true } };
    }
    return { body: { accepted: true } };
  },
  async (requests) => {
    const snapshots = await waitFor(
      'same-version runtime snapshot retry after a transport failure',
      () => {
        const items = requests.filter((item) => item.url === '/security-center/runtime/snapshot');
        return items.length >= 2 ? items : undefined;
      },
    );
    assert.equal(snapshots[0].body.snapshotVersion, snapshots[1].body.snapshotVersion);
    assert.deepEqual(snapshots[0].body, snapshots[1].body);
    const heartbeat = await waitFor(
      'successful runtime snapshot metrics after retry',
      () => [...requests]
        .reverse()
        .find((item) =>
          item.url === '/security-center/collectors/heartbeat' &&
          item.body?.filterMetrics?.runtimeSnapshotPosts >= 2 &&
          item.body?.filterMetrics?.lastRuntimeSnapshotAt),
    );
    assert.equal(heartbeat.body.filterMetrics.runtimeSnapshotErrors, 0);
    assert.equal(heartbeat.body.errorCount, 0);
    assert.equal(heartbeat.body.filterMetrics.runtimeSnapshotPosts, 2);
    assert.equal(heartbeat.body.filterMetrics.runtimeSnapshotRetries, 1);
    assert.equal(heartbeat.body.filterMetrics.runtimeSnapshotRecovered, 1);
    assert.equal(heartbeat.body.filterMetrics.runtimeSnapshotDuplicates, 1);
    assert.equal(typeof heartbeat.body.filterMetrics.lastRuntimeSnapshotRetryAt, 'string');
    assert.match(heartbeat.body.filterMetrics.lastRuntimeSnapshotRetryReason ?? '', /socket|hang|reset/iu);
    assert.equal(heartbeat.body.filterMetrics.lastRuntimeSnapshotError, undefined);
  },
);

await withForwarder(
  'snapshot-retry-superseded-by-shutdown',
  (request, requests) => {
    if (request.url === '/security-center/runtime/lease') {
      return { body: { accepted: true, leaseEpoch: 6 } };
    }
    if (request.url === '/security-center/runtime/snapshot') {
      const snapshots = requests.filter((item) => item.url === request.url).length;
      if (snapshots === 1) return { status: 503, body: { accepted: false } };
      return { body: { accepted: true, applied: true, duplicate: false } };
    }
    return { body: { accepted: true } };
  },
  async (requests, child) => {
    const first = await waitFor(
      'runtime snapshot failure before graceful shutdown',
      () => requests.find((item) => item.url === '/security-center/runtime/snapshot'),
    );
    child.stdin.end();
    const finalHeartbeat = await waitFor(
      'final heartbeat after scheduled runtime snapshot retry is superseded',
      () => [...requests]
        .reverse()
        .find((item) =>
          item.url === '/security-center/collectors/heartbeat' &&
          item.body?.filterMetrics?.shutdownFinal === true),
    );
    const snapshots = requests.filter((item) => item.url === '/security-center/runtime/snapshot');
    assert.equal(
      snapshots.filter((item) => item.body.snapshotVersion === first.body.snapshotVersion).length,
      1,
      'a scheduled retry must not post after graceful shutdown supersedes its operation',
    );
    assert.ok(snapshots.some((item) => item.body.snapshotVersion > first.body.snapshotVersion));
    assert.equal(finalHeartbeat.body.errorCount, 0);
    assert.equal(finalHeartbeat.body.filterMetrics.runtimeSnapshotErrors, 0);
    assert.equal(finalHeartbeat.body.filterMetrics.runtimeSnapshotRetries, 0);
    assert.equal(finalHeartbeat.body.filterMetrics.runtimeSnapshotRecovered, 0);
  },
);

await withForwarder(
  'snapshot-transport-exhausted',
  (request) => {
    if (request.url === '/security-center/runtime/lease') {
      return { body: { accepted: true, leaseEpoch: 4 } };
    }
    if (request.url === '/security-center/runtime/snapshot') {
      return { status: 503, body: { accepted: false } };
    }
    return { body: { accepted: true } };
  },
  async (requests) => {
    const heartbeat = await waitFor(
      'exhausted runtime snapshot retry metrics',
      () => [...requests]
        .reverse()
        .find((item) =>
          item.url === '/security-center/collectors/heartbeat' &&
          item.body?.filterMetrics?.runtimeSnapshotPosts === 2 &&
          item.body?.filterMetrics?.runtimeSnapshotErrors === 1),
    );
    assert.equal(heartbeat.body.filterMetrics.runtimeSnapshotRetries, 1);
    assert.equal(heartbeat.body.filterMetrics.runtimeSnapshotRecovered, 0);
    assert.equal(heartbeat.body.errorCount, 1);
    assert.equal(heartbeat.body.filterMetrics.runtimeSnapshotPosts, 2);
    assert.match(heartbeat.body.filterMetrics.lastRuntimeSnapshotError ?? '', /503/u);
    assert.equal(typeof heartbeat.body.filterMetrics.lastRuntimeSnapshotFailureAt, 'string');
    assert.match(heartbeat.body.filterMetrics.lastRuntimeSnapshotFailure ?? '', /503/u);
    assert.equal(heartbeat.body.filterMetrics.lastRuntimeSnapshotFailureVersion, 1);
  },
);

await withForwarder(
  'snapshot-non-retryable-http',
  (request) => {
    if (request.url === '/security-center/runtime/lease') {
      return { body: { accepted: true, leaseEpoch: 5 } };
    }
    if (request.url === '/security-center/runtime/snapshot') {
      return { status: 401, body: { accepted: false } };
    }
    return { body: { accepted: true } };
  },
  async (requests) => {
    const heartbeat = await waitFor(
      'non-retryable runtime snapshot HTTP failure metrics',
      () => [...requests]
        .reverse()
        .find((item) =>
          item.url === '/security-center/collectors/heartbeat' &&
          item.body?.filterMetrics?.runtimeSnapshotErrors === 1),
    );
    assert.equal(
      requests.filter((item) => item.url === '/security-center/runtime/snapshot').length,
      1,
    );
    assert.equal(heartbeat.body.filterMetrics.runtimeSnapshotRetries, 0);
    assert.equal(heartbeat.body.filterMetrics.runtimeSnapshotRecovered, 0);
    assert.equal(heartbeat.body.errorCount, 1);
    assert.equal(heartbeat.body.filterMetrics.runtimeSnapshotPosts, 1);
    assert.match(heartbeat.body.filterMetrics.lastRuntimeSnapshotError ?? '', /401/u);
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
