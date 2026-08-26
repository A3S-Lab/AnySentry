import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const { ClickHouseStore, eventRevisionIdentity } = require(
  '../apps/api/dist/security-monitoring/clickhouse-store.js',
);

const source = await readFile(
  new URL('../apps/api/src/security-monitoring/clickhouse-store.ts', import.meta.url),
  'utf8',
);
const queueSource = await readFile(
  new URL('../apps/api/src/security-monitoring/judgment-queue.service.ts', import.meta.url),
  'utf8',
);

assert.match(source, /ANYSENTRY_CLICKHOUSE_BATCH_MAX_ROWS/);
assert.match(source, /ANYSENTRY_CLICKHOUSE_BATCH_MAX_DELAY_MS/);
assert.match(source, /ANYSENTRY_CLICKHOUSE_BATCH_MAX_BYTES/);
assert.match(source, /ANYSENTRY_CLICKHOUSE_MAX_QUEUED_ROWS/);
assert.match(source, /ANYSENTRY_CLICKHOUSE_MAX_QUEUED_BYTES/);
assert.match(source, /ANYSENTRY_CLICKHOUSE_SHUTDOWN_FLUSH_MS/);
assert.match(source, /anysentry\.event-batch-receipt\.v1/);
assert.match(source, /EVENT_REVISION_CONFLICT_TABLE/);
assert.match(source, /EVENT_REVISION_IDENTITY_TABLE/);
assert.match(source, /eventCommitCursorsForBuckets/);
assert.match(source, /payloadChecksum/);
assert.match(
  source,
  /committedCutoffMs\(\): number \| undefined \{[\s\S]*return this\.committedThroughMs;/,
  'pending or replayed event time must not hide facts that are already durable',
);
assert.match(queueSource, /ANYSENTRY_RESULT_APPLY_CONCURRENCY/);
assert.match(queueSource, /Math\.max\(1, Math\.min\(512/);

const base = {
  schemaVersion: 'anysentry.agent_event.v1',
  eventId: 'evt_verify_batch',
  at: 1_700_000_000_000,
  eventKind: 'ToolExec',
  eventCategory: 'tool',
  source: 'observer',
  subject: 'verify',
  workspacePath: '/workspace',
  agentId: 'agent',
  collectorId: 'collector',
  sourceId: 'source',
  sessionId: 'session',
  userId: 'user',
  traceId: 'trace',
  spanId: 'span',
  runId: 'run',
  decisionStatus: 'succeeded',
  decisionRevision: 2,
  decisionUpdatedAt: 1_700_000_000_100,
  verdict: 'allow',
  tier: 'Rules',
  severity: 'info',
  reason: 'verified',
  riskCategory: 'benign',
  riskName: 'normal',
  riskType: 'atomic',
  riskScore: 0,
  tokenCount: 0,
  latencyMs: 1,
  attributes: { z: 2, a: 1 },
};

const reordered = {
  ...base,
  attributes: { a: 1, z: 2 },
  commitBatchId: 'retry-batch',
  storeCommittedAt: Date.now(),
};
const first = eventRevisionIdentity(base);
const retry = eventRevisionIdentity(reordered);
assert.equal(first.logicalKey, retry.logicalKey);
assert.equal(first.fingerprint, retry.fingerprint);

const changed = eventRevisionIdentity({ ...base, subject: 'conflicting-payload' });
assert.equal(first.logicalKey, changed.logicalKey);
assert.notEqual(first.fingerprint, changed.fingerprint);

const nextRevision = eventRevisionIdentity({ ...base, decisionRevision: 3 });
assert.notEqual(first.logicalKey, nextRevision.logicalKey);

const originalEnv = {
  microbatch: process.env.ANYSENTRY_CLICKHOUSE_MICROBATCH,
  maxDelay: process.env.ANYSENTRY_CLICKHOUSE_BATCH_MAX_DELAY_MS,
  maxAttempts: process.env.ANYSENTRY_CLICKHOUSE_BATCH_MAX_ATTEMPTS,
  retryBase: process.env.ANYSENTRY_CLICKHOUSE_BATCH_RETRY_BASE_MS,
  maxQueuedBytes: process.env.ANYSENTRY_CLICKHOUSE_MAX_QUEUED_BYTES,
  revisionImmutability: process.env.ANYSENTRY_REVISION_IMMUTABILITY,
};
process.env.ANYSENTRY_CLICKHOUSE_MICROBATCH = 'on';
process.env.ANYSENTRY_CLICKHOUSE_BATCH_MAX_DELAY_MS = '5';
process.env.ANYSENTRY_CLICKHOUSE_BATCH_MAX_ATTEMPTS = '2';
process.env.ANYSENTRY_CLICKHOUSE_BATCH_RETRY_BASE_MS = '10';
process.env.ANYSENTRY_CLICKHOUSE_MAX_QUEUED_BYTES = String(1024 * 1024);

const retryStore = new ClickHouseStore();
const retryBlocks = [];
let retryAttempts = 0;
retryStore.client = {
  insert: async ({ table, values }) => {
    if (table !== 'events') return;
    retryBlocks.push(structuredClone(values));
    retryAttempts += 1;
    if (retryAttempts === 1) throw new Error('simulated lost acknowledgement');
  },
  close: async () => undefined,
};
retryStore.ready = true;
const retriedReceipt = await retryStore.insertNowWithReceipt(base);
assert.equal(retriedReceipt.result, 'durable_fact');
assert.equal(retriedReceipt.attempts, 2);
assert.equal(retryBlocks.length, 2);
assert.equal(retryBlocks[0][0].commitBatchId, retryBlocks[1][0].commitBatchId);
await retryStore.close();

const shutdownStore = new ClickHouseStore();
const shutdownBlocks = [];
shutdownStore.client = {
  insert: async ({ table, values }) => {
    if (table === 'events') shutdownBlocks.push(structuredClone(values));
  },
  close: async () => undefined,
};
shutdownStore.ready = true;
process.env.ANYSENTRY_CLICKHOUSE_BATCH_MAX_DELAY_MS = '10000';
const pendingReceipts = [
  shutdownStore.insertNowWithReceipt({ ...base, eventId: 'evt_shutdown_1' }),
  shutdownStore.insertNowWithReceipt({ ...base, eventId: 'evt_shutdown_2' }),
];
await shutdownStore.close();
const shutdownReceipts = await Promise.all(pendingReceipts);
assert.equal(shutdownBlocks.length, 1);
assert.equal(shutdownBlocks[0].length, 2);
assert.ok(shutdownReceipts.every((receipt) => receipt.result === 'durable_fact'));

const backpressureStore = new ClickHouseStore();
backpressureStore.client = {
  insert: async () => undefined,
  close: async () => undefined,
};
backpressureStore.ready = true;
await assert.rejects(
  backpressureStore.insertNowWithReceipt({
    ...base,
    eventId: 'evt_backpressure',
    rawPreview: 'x'.repeat(2 * 1024 * 1024),
  }),
  /queue is full/,
);
await backpressureStore.close();

const conflictStore = new ClickHouseStore();
const conflictTables = [];
conflictStore.client = {
  query: async () => ({ json: async () => [] }),
  insert: async ({ table }) => {
    conflictTables.push(table);
  },
  close: async () => undefined,
};
conflictStore.ready = true;
process.env.ANYSENTRY_REVISION_IMMUTABILITY = 'enforce';
process.env.ANYSENTRY_CLICKHOUSE_BATCH_MAX_DELAY_MS = '5';
const conflictReceipts = await Promise.all([
  conflictStore.insertNowWithReceipt({ ...base, eventId: 'evt_conflict' }),
  conflictStore.insertNowWithReceipt({
    ...base,
    eventId: 'evt_conflict',
    subject: 'different immutable payload',
  }),
]);
assert.deepEqual(
  conflictReceipts.map((receipt) => receipt.result).sort(),
  ['durable_dlq', 'durable_fact'],
);
assert.ok(conflictTables.includes('events'));
assert.ok(conflictTables.includes('event_revision_conflicts'));
await conflictStore.close();

for (const [key, value] of Object.entries(originalEnv)) {
  const envKey = {
    microbatch: 'ANYSENTRY_CLICKHOUSE_MICROBATCH',
    maxDelay: 'ANYSENTRY_CLICKHOUSE_BATCH_MAX_DELAY_MS',
    maxAttempts: 'ANYSENTRY_CLICKHOUSE_BATCH_MAX_ATTEMPTS',
    retryBase: 'ANYSENTRY_CLICKHOUSE_BATCH_RETRY_BASE_MS',
    maxQueuedBytes: 'ANYSENTRY_CLICKHOUSE_MAX_QUEUED_BYTES',
    revisionImmutability: 'ANYSENTRY_REVISION_IMMUTABILITY',
  }[key];
  if (value === undefined) delete process.env[envKey];
  else process.env[envKey] = value;
}

console.log('write batching and immutable Revision contracts verified');
