#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const temporary = mkdtempSync(path.join(os.tmpdir(), 'anysentry-spool-replay-'));
const input = path.join(temporary, 'input.wal');
const output = path.join(temporary, 'remaining.wal');
const records = [
  { id: 'evt-high', priority: 4, queuedAt: 1, body: { sourceEventId: 'evt-high', line: '{}' } },
  { id: 'evt-low', priority: 0, queuedAt: 2, body: { sourceEventId: 'evt-low', line: '{}' } },
  { id: 'evt-acked', priority: 2, queuedAt: 3, body: { sourceEventId: 'evt-acked', line: '{}' } },
];
writeFileSync(input, [
  ...records.map((record) => JSON.stringify({ op: 'put', record })),
  JSON.stringify({ op: 'ack', ids: ['evt-acked'] }),
  '{"op":"put","record":',
].join('\n'), { mode: 0o600 });

let firstPass = true;
const received = [];
const server = http.createServer((request, response) => {
  let raw = '';
  request.setEncoding('utf8');
  request.on('data', (chunk) => { raw += chunk; });
  request.on('end', () => {
    const body = JSON.parse(raw);
    received.push(body);
    const items = body.events.map((event, index) => ({
      index,
      accepted: !firstPass || event.sourceEventId === 'evt-high',
      disposition: !firstPass || event.sourceEventId === 'evt-high' ? 'retained' : 'retryable',
      ...(!firstPass || event.sourceEventId === 'evt-high' ? {} : { reasonCode: 'clickhouse_event_buffer_full' }),
    }));
    const acceptedEvents = items.filter((item) => item.accepted).length;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: {
      accepted: acceptedEvents > 0,
      batchId: body.batchId,
      payloadDigest: body.payloadDigest,
      acceptedEvents,
      rejectedEvents: 0,
      retryableEvents: items.length - acceptedEvents,
      items,
    } }));
  });
});

function run(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const address = server.address();
    const child = spawn(process.execPath, [
      'scripts/replay-observer-spool.mjs',
      '--input', inputPath,
      '--output', outputPath,
      '--url', `http://127.0.0.1:${address.port}/security-center/ingest/batch`,
      '--writer-id', 'spool-rescue-test',
      '--batch-size', '2',
      '--apply',
    ], {
      cwd: repoRoot,
      env: { ...process.env, ANYSENTRY_SOURCE_ID: 'source-test', ANYSENTRY_INGEST_TOKEN: 'secret-test' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const first = await run(input, output);
  assert.equal(first.code, 3, first.stderr);
  const firstReport = JSON.parse(first.stdout);
  assert.equal(firstReport.malformedFinalLineIgnored, true);
  assert.equal(firstReport.initialRecords, 2);
  assert.equal(firstReport.acknowledgedRecords, 1);
  assert.equal(firstReport.remainingRecords, 1);
  assert.equal(received[0].events[0].sourceEventId, 'evt-high', 'priority evidence replays first');
  assert.match(readFileSync(output, 'utf8'), /evt-low/u);
  assert.doesNotMatch(readFileSync(output, 'utf8'), /evt-high|evt-acked/u);

  firstPass = false;
  const finalOutput = path.join(temporary, 'final.wal');
  const second = await run(output, finalOutput);
  assert.equal(second.code, 0, second.stderr);
  const secondReport = JSON.parse(second.stdout);
  assert.equal(secondReport.remainingRecords, 0);
  assert.equal(readFileSync(finalOutput, 'utf8'), '');
  console.log('Observer spool replay rescue verification passed');
} finally {
  await new Promise((resolve) => server.close(resolve));
  rmSync(temporary, { recursive: true, force: true });
}
