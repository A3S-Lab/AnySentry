#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const temporary = mkdtempSync(path.join(os.tmpdir(), 'anysentry-forwarder-durable-'));
const spoolPath = path.join(temporary, 'observer.wal');
const requests = [];
let responseMode = 'disconnect-once';

function observerLine(marker) {
  return JSON.stringify({
    identity: { agent: 'codex', session: 'durability-test', task: marker },
    event: {
      ToolExec: {
        pid: process.pid,
        ppid: process.ppid,
        uid: 1000,
        cwd: repoRoot,
        argv: ['echo', marker],
      },
    },
  });
}

function durableResponse(body) {
  return {
    data: {
      accepted: true,
      batchId: body.batchId,
      writerId: body.writerId,
      acceptedEvents: body.events.length,
      rejectedEvents: 0,
      items: body.events.map((event, index) => ({
        index,
        sourceEventId: event.sourceEventId,
        accepted: true,
        durable: true,
        retryable: false,
      })),
    },
  };
}

const server = http.createServer((request, response) => {
  if (
    request.method !== 'POST' ||
    !request.url?.startsWith('/security-center/ingest/batch')
  ) {
    response.writeHead(404).end();
    return;
  }
  let raw = '';
  request.setEncoding('utf8');
  request.on('data', (chunk) => {
    raw += chunk;
  });
  request.on('end', () => {
    const body = JSON.parse(raw || '{}');
    requests.push(body);
    if (responseMode === 'disconnect-once') {
      responseMode = 'accept';
      request.socket.destroy();
      return;
    }
    if (responseMode === 'unavailable') {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'fault injection' }));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(durableResponse(body)));
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert(address && typeof address === 'object');
const batchUrl = `http://127.0.0.1:${address.port}/security-center/ingest/batch`;

function runForwarder({ line, killAfterRequest = false }) {
  return new Promise((resolve, reject) => {
    const requestStart = requests.length;
    const child = spawn(process.execPath, ['scripts/observer-forward.js'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        ANYSENTRY_BATCH_INGEST_URL: batchUrl,
        ANYSENTRY_INGEST_URL: batchUrl.replace('/batch', ''),
        ANYSENTRY_HEARTBEAT_SECS: '0',
        ANYSENTRY_IDENTITY_SNAPSHOT_SECS: '0',
        ANYSENTRY_WRITER_ID: 'durability-gate-writer',
        FORWARD_SPOOL_PATH: spoolPath,
        FORWARD_SPOOL_FSYNC: 'always',
        FORWARD_BATCH_SIZE: '1',
        FORWARD_BATCH_FLUSH_MS: '1',
        FORWARD_RETRY_BASE_MS: '50',
        FORWARD_RETRY_MAX_MS: '100',
        FORWARD_HTTP_TIMEOUT_MS: '1000',
        FORWARD_FILTER_MODE: 'shadow',
        FORWARD_NOISE_POLICY: 'include',
      },
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    let killed = false;
    const timer = setInterval(() => {
      if (killAfterRequest && !killed && requests.length > requestStart) {
        killed = true;
        child.kill('SIGKILL');
      }
    }, 10);
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`forwarder durability test timed out: ${stderr}`));
    }, 12_000);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      clearInterval(timer);
      clearTimeout(timeout);
      if (killAfterRequest && signal === 'SIGKILL') resolve({ stderr });
      else if (code === 0) resolve({ stderr });
      else reject(new Error(`forwarder exited with ${signal ?? code}: ${stderr}`));
    });
    if (line) child.stdin.write(`${line}\n`);
    child.stdin.end();
  });
}

try {
  const firstStart = requests.length;
  await runForwarder({ line: observerLine('retry-same-process') });
  const retryRequests = requests.slice(firstStart);
  assert(retryRequests.length >= 2, 'transport failure must retry');
  assert.equal(retryRequests[0].batchId, retryRequests[1].batchId);
  assert.equal(retryRequests[0].writerId, 'durability-gate-writer');
  assert.equal(retryRequests[0].idempotencyProtocolVersion, 'anysentry.idempotency.v1');
  assert.equal(
    retryRequests[0].events[0].sourceEventId,
    retryRequests[1].events[0].sourceEventId,
    'source event identity must remain stable across a retry',
  );
  assert.equal(
    retryRequests[0].events[0].observedAt,
    retryRequests[1].events[0].observedAt,
    'source observation time must remain stable across a retry',
  );

  responseMode = 'accept';
  const repeatedStart = requests.length;
  const repeatedLine = JSON.stringify({
    identity: { agent: 'codex', session: 'durability-test', task: 'same-content-distinct-occurrence' },
    event: { FileDelete: { pid: process.pid, path: '/tmp/repeated-observation' } },
  });
  await runForwarder({ line: `${repeatedLine}\n${repeatedLine}` });
  const repeatedRequests = requests.slice(repeatedStart);
  const repeatedEvents = repeatedRequests.flatMap((request) => request.events);
  assert.equal(repeatedEvents.length, 2, 'both repeated occurrences must be delivered');
  assert.notEqual(
    repeatedEvents[0].sourceEventId,
    repeatedEvents[1].sourceEventId,
    'equal source text observed twice must not collapse into one logical event',
  );

  responseMode = 'unavailable';
  const crashStart = requests.length;
  await runForwarder({ line: observerLine('restart-recovery'), killAfterRequest: true });
  const beforeRestart = requests.slice(crashStart);
  assert.equal(beforeRestart.length, 1);
  const sourceEventId = beforeRestart[0].events[0].sourceEventId;
  assert(readFileSync(spoolPath, 'utf8').includes(sourceEventId), 'unacknowledged event must remain in WAL');

  responseMode = 'accept';
  const recoveryStart = requests.length;
  await runForwarder({});
  const recovered = requests.slice(recoveryStart);
  assert(recovered.length >= 1, 'restart must replay the durable spool');
  assert.equal(recovered[0].events[0].sourceEventId, sourceEventId);
  assert.equal(recovered[0].batchId, beforeRestart[0].batchId);

  console.log('PASS Forwarder retries the same stable batch after a transport failure');
  console.log('PASS Forwarder assigns distinct IDs to equal source text observed twice');
  console.log('PASS Forwarder replays an unacknowledged WAL record after process death');
  console.log('PASS Forwarder deletes records only after item-level durable acknowledgement');
} finally {
  await new Promise((resolve) => server.close(resolve));
  rmSync(temporary, { recursive: true, force: true });
}
