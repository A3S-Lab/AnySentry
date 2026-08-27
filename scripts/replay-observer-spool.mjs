#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream, openSync, closeSync, fsyncSync, writeSync, renameSync, chmodSync, unlinkSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import readline from 'node:readline';

function usage(message) {
  if (message) console.error(message);
  console.error(
    'Usage: node scripts/replay-observer-spool.mjs --input WAL [--output WAL] '
    + '[--url URL] [--writer-id ID] [--batch-size N] [--timeout-ms N] [--apply]',
  );
  process.exit(message ? 2 : 0);
}

function args() {
  const result = { apply: false, batchSize: 64, timeoutMs: 30_000 };
  for (let index = 2; index < process.argv.length; index += 1) {
    const argument = process.argv[index];
    if (argument === '--apply') result.apply = true;
    else if (argument === '--help') usage();
    else if (argument.startsWith('--')) {
      const key = argument.slice(2).replace(/-([a-z])/gu, (_, value) => value.toUpperCase());
      const value = process.argv[++index];
      if (!value || value.startsWith('--')) usage(`missing value for ${argument}`);
      result[key] = value;
    } else usage(`unexpected argument: ${argument}`);
  }
  if (!result.input) usage('--input is required');
  result.input = path.resolve(result.input);
  result.output = path.resolve(result.output || `${result.input}.remaining`);
  if (result.output === result.input) usage('--output must differ from --input');
  result.url = result.url || process.env.ANYSENTRY_BATCH_INGEST_URL;
  result.writerId = result.writerId || process.env.ANYSENTRY_WRITER_ID;
  result.batchSize = Math.max(1, Math.min(256, Number(result.batchSize) || 64));
  result.timeoutMs = Math.max(1_000, Math.min(120_000, Number(result.timeoutMs) || 30_000));
  if (result.apply && (!result.url || !result.writerId)) {
    usage('--apply requires --url/ANYSENTRY_BATCH_INGEST_URL and --writer-id/ANYSENTRY_WRITER_ID');
  }
  return result;
}

async function loadWal(filePath) {
  const records = new Map();
  let lineNumber = 0;
  let malformedFinalLine = false;
  const lines = readline.createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    lineNumber += 1;
    if (!line) continue;
    if (malformedFinalLine) throw new Error(`WAL contains data after malformed line ${lineNumber - 1}`);
    let operation;
    try {
      operation = JSON.parse(line);
    } catch {
      malformedFinalLine = true;
      continue;
    }
    if (operation.op === 'put' && operation.record?.id && operation.record?.body) {
      const record = {
        id: String(operation.record.id),
        body: operation.record.body,
        priority: Math.max(0, Math.min(5, Number(operation.record.priority) || 0)),
        queuedAt: Math.max(0, Number(operation.record.queuedAt) || 0),
      };
      records.delete(record.id);
      records.set(record.id, record);
    } else if (operation.op === 'ack' && Array.isArray(operation.ids)) {
      for (const id of operation.ids) records.delete(String(id));
    }
  }
  return { records, malformedFinalLine };
}

function batchEnvelope(writerId, records) {
  const events = records.map((record) => record.body);
  const canonical = JSON.stringify(events);
  const payloadDigest = createHash('sha256').update(canonical).digest('hex');
  const batchId = `obat_${createHash('sha256')
    .update(writerId)
    .update('\0')
    .update(payloadDigest)
    .digest('hex')
    .slice(0, 24)}`;
  return {
    schemaVersion: 'anysentry.observer_batch.v2',
    batchId,
    payloadDigest,
    durableReplay: true,
    writerId,
    writerVersion: 'observer-spool-replay/1.0.0',
    idempotencyProtocolVersion: 'anysentry.idempotency.v1',
    events,
  };
}

function sourceHeaders() {
  const sourceId = String(process.env.ANYSENTRY_SOURCE_ID || '').trim();
  const token = String(process.env.ANYSENTRY_INGEST_TOKEN || '').trim();
  return {
    ...(sourceId ? { 'X-AnySentry-Source-Id': sourceId } : {}),
    ...(token ? { 'X-AnySentry-Ingest-Token': token } : {}),
  };
}

function postJson(urlText, value, timeoutMs) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlText);
    const transport = url.protocol === 'https:' ? https : http;
    if (!['http:', 'https:'].includes(url.protocol)) {
      reject(new Error(`unsupported protocol ${url.protocol}`));
      return;
    }
    const body = JSON.stringify(value);
    let responseBody = '';
    const request = transport.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      agent: false,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...sourceHeaders(),
      },
    }, (response) => {
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        if (responseBody.length <= 2 * 1024 * 1024) responseBody += chunk;
      });
      response.on('end', () => {
        if ((response.statusCode || 500) < 200 || (response.statusCode || 500) >= 300) {
          reject(new Error(`batch endpoint returned HTTP ${response.statusCode}`));
          return;
        }
        try {
          resolve(responseBody ? JSON.parse(responseBody) : undefined);
        } catch {
          reject(new Error('batch endpoint returned invalid JSON'));
        }
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('batch request timed out')));
    request.on('error', reject);
    request.end(body);
  });
}

function acknowledgedIds(response, batch) {
  const ack = response?.data ?? response;
  if (!ack || ack.batchId !== batch.envelope.batchId || !Array.isArray(ack.items)) {
    throw new Error('batch endpoint returned an inconsistent acknowledgement');
  }
  const acknowledged = [];
  for (let index = 0; index < batch.records.length; index += 1) {
    const item = ack.items[index];
    if (!item || item.index !== index) throw new Error('batch acknowledgement item order is invalid');
    if (item.accepted === true) acknowledged.push(batch.records[index].id);
  }
  return acknowledged;
}

function batches(records, writerId, batchSize) {
  const ordered = [...records.values()].sort((left, right) =>
    right.priority - left.priority || left.queuedAt - right.queuedAt || left.id.localeCompare(right.id));
  const result = [];
  for (let index = 0; index < ordered.length; index += batchSize) {
    const items = ordered.slice(index, index + batchSize);
    result.push({ records: items, envelope: batchEnvelope(writerId, items) });
  }
  return result;
}

function writeCompactedWal(filePath, records) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    for (const record of records.values()) {
      writeSync(descriptor, `${JSON.stringify({ op: 'put', record })}\n`);
    }
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, filePath);
    chmodSync(filePath, 0o600);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try { unlinkSync(temporary); } catch {}
  }
}

async function main() {
  const options = args();
  const loaded = await loadWal(options.input);
  const initial = loaded.records.size;
  let acknowledged = 0;
  let failedBatches = 0;
  if (options.apply) {
    for (const batch of batches(loaded.records, options.writerId, options.batchSize)) {
      try {
        const response = await postJson(options.url, batch.envelope, options.timeoutMs);
        for (const id of acknowledgedIds(response, batch)) {
          if (loaded.records.delete(id)) acknowledged += 1;
        }
      } catch (error) {
        failedBatches += 1;
        console.error(`spool replay batch retained: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  writeCompactedWal(options.output, loaded.records);
  console.log(JSON.stringify({
    schemaVersion: 'anysentry.observer_spool_replay_report.v1',
    apply: options.apply,
    malformedFinalLineIgnored: loaded.malformedFinalLine,
    initialRecords: initial,
    acknowledgedRecords: acknowledged,
    remainingRecords: loaded.records.size,
    failedBatches,
    output: options.output,
  }));
  if (options.apply && (loaded.records.size > 0 || failedBatches > 0)) process.exitCode = 3;
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
