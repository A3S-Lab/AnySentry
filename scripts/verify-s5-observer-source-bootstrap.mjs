#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'anysentry-observer-bootstrap-'));
const managementToken = 'management-token-s5-bootstrap';
const records = new Map();
let createCount = 0;
let updateCount = 0;
let rotateCount = 0;

function send(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  response.end(body);
}

const server = http.createServer(async (request, response) => {
  let raw = '';
  for await (const chunk of request) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  if (request.headers['x-anysentry-management-token'] !== managementToken) {
    send(response, 401, { message: 'management token required' });
    return;
  }
  if (request.url === '/security-center/sources/list') {
    send(response, 200, { items: [...records.values()].map((record) => ({ ...record })) });
    return;
  }
  if (request.url === '/security-center/sources' && request.method === 'POST') {
    createCount++;
    const sourceId = `src-${body.collectorId}`;
    const source = { sourceId, name: body.name, type: body.type, collectorId: body.collectorId, discovered: false };
    records.set(sourceId, source);
    send(response, 200, { source, token: `token-create-${body.collectorId}` });
    return;
  }
  const update = request.url?.match(/^\/security-center\/sources\/([^/]+)$/u);
  if (update && request.method === 'PUT') {
    updateCount++;
    const sourceId = decodeURIComponent(update[1]);
    const source = { ...records.get(sourceId), ...body, sourceId, discovered: false };
    records.set(sourceId, source);
    send(response, 200, { source });
    return;
  }
  const rotate = request.url?.match(/^\/security-center\/sources\/([^/]+)\/rotate-token$/u);
  if (rotate && request.method === 'POST') {
    rotateCount++;
    const sourceId = decodeURIComponent(rotate[1]);
    send(response, 200, { source: records.get(sourceId), token: `token-rotate-${sourceId}` });
    return;
  }
  send(response, 404, { message: 'not found' });
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
assert(address && typeof address === 'object');
const base = `http://127.0.0.1:${address.port}/security-center`;

async function bootstrap(output, collectors, format) {
  const child = spawn(process.execPath, ['scripts/bootstrap-observer-sources.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ANYSENTRY_API_BASE: base,
      ANYSENTRY_MANAGEMENT_TOKEN: managementToken,
      ANYSENTRY_OBSERVER_AUTH_OUTPUT: output,
      ANYSENTRY_OBSERVER_AUTH_FORMAT: format,
      ANYSENTRY_OBSERVER_COLLECTOR_IDS: collectors.join(','),
      ANYSENTRY_OBSERVER_SOURCE_NAME_PREFIX: 'bootstrap-e2e',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => child.once('exit', resolve));
  assert.equal(code, 0, stderr);
  assert(!stdout.includes('token-create-') && !stdout.includes('token-rotate-') && !stdout.includes(managementToken));
}

try {
  const jsonFile = path.join(directory, 'credentials.json');
  await bootstrap(jsonFile, ['node-a', 'node-b'], 'json');
  const first = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
  assert.equal(first.schemaVersion, 'anysentry.observer_source_credentials.v1');
  assert.deepEqual(first.credentials.map((entry) => entry.collectorId), ['node-a', 'node-b']);
  assert.equal(fs.statSync(jsonFile).mode & 0o777, 0o600);
  assert.equal(createCount, 2);

  await bootstrap(jsonFile, ['node-a', 'node-b'], 'json');
  const second = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
  assert(second.credentials.every((entry) => entry.token.startsWith('token-rotate-')));
  assert.equal(createCount, 2, 'reinstall must not duplicate managed Sources');
  assert.equal(updateCount, 2);
  assert.equal(rotateCount, 2);

  const envFile = path.join(directory, 'observer-auth.env');
  await bootstrap(envFile, ['node-a'], 'env');
  const env = fs.readFileSync(envFile, 'utf8');
  assert.match(env, /^ANYSENTRY_SOURCE_ID=src-node-a$/mu);
  assert.match(env, /^ANYSENTRY_INGEST_TOKEN=token-rotate-src-node-a$/mu);
  assert.match(env, /^ANYSENTRY_INFRASTRUCTURE_POLICY_TOKEN=management-token-s5-bootstrap$/mu);
  assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(directory, { recursive: true, force: true });
}

console.log('S5 managed Observer Source bootstrap mock E2E passed');
