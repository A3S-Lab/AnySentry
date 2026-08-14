#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ClickHouseStore } from '../apps/api/dist/security-monitoring/clickhouse-store.js';
import { SentryJudgeService } from '../apps/api/dist/security-monitoring/sentry-judge.service.js';

const BATCH_BYTES = 4 * 1024 * 1024;

function event(index, overrides = {}) {
  return {
    schemaVersion: 'anysentry.agent_event.v1',
    eventId: `event-${String(index).padStart(6, '0')}`,
    at: 1_700_000_000_000 + index,
    eventKind: 'ToolExec',
    eventCategory: 'tool',
    source: 'observer',
    subject: `event ${index}`,
    workspacePath: '/workspace',
    agentId: 'agent-a',
    collectorId: 'collector-a',
    sourceId: 'source-a',
    sessionId: 'session-a',
    userId: 'user-a',
    traceId: `trace-${index}`,
    spanId: `span-${index}`,
    runId: 'run-a',
    decisionStatus: 'succeeded',
    decisionUpdatedAt: 1_700_000_000_000 + index,
    verdict: 'allow',
    tier: 'Rules',
    severity: 'info',
    reason: 'write-buffer verifier',
    riskCategory: 'other',
    riskName: 'none',
    riskType: 'atomic',
    riskScore: 0,
    tokenCount: 0,
    latencyMs: 1,
    attributes: { sequence: index },
    ...overrides,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, resolve, reject };
}

async function eventually(predicate, message, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

async function within(promise, message, milliseconds = 1_000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function fakeClickHouse({ behaviors = [], onInsert } = {}) {
  const state = {
    calls: [],
    active: 0,
    maxActive: 0,
    closeCalls: 0,
    appliedByToken: new Map(),
  };
  const pendingBehaviors = [...behaviors];
  return {
    state,
    client: {
      async insert(options) {
        const call = {
          table: options.table,
          format: options.format,
          values: structuredClone(options.values),
          clickhouse_settings: structuredClone(options.clickhouse_settings ?? {}),
          abort_signal: options.abort_signal,
        };
        state.calls.push(call);
        state.active += 1;
        state.maxActive = Math.max(state.maxActive, state.active);
        try {
          const behavior = pendingBehaviors.shift();
          if (behavior) await behavior(call, state);
          else if (onInsert) await onInsert(call, state);
          return { executed: true, query_id: 'fake-write', summary: {}, response_headers: {}, http_status: 200 };
        } finally {
          state.active -= 1;
        }
      },
      async close() {
        assert.equal(state.active, 0, 'client.close must not overlap an active insert');
        state.closeCalls += 1;
      },
    },
  };
}

function storeFor(fake, overrides = {}) {
  const store = new ClickHouseStore();
  Object.assign(store, {
    client: fake.client,
    ready: true,
    eventWriteRetryDeadlineMs: 1_000,
    eventWriteAttemptTimeoutMs: 1_000,
    eventWriteCloseDeadlineMs: 2_000,
    eventWriteRetryDelayMs: () => 0,
    ...overrides,
  });
  return store;
}

function snapshot(store) {
  return {
    rows: store.eventWriteRows,
    bytes: store.eventWriteBytes,
    bufferedRows: store.buf.length,
    batches: store.eventWriteBatches.length,
    permanentError: store.eventWritePermanentError,
  };
}

function batchToken(call) {
  const token = call.clickhouse_settings?.insert_deduplication_token;
  assert.equal(typeof token, 'string');
  assert.ok(token.length > 0);
  assert.equal(call.clickhouse_settings?.insert_deduplicate, 1);
  return token;
}

async function withoutExpectedErrorLogs(run) {
  const original = console.error;
  console.error = () => undefined;
  try {
    return await run();
  } finally {
    console.error = original;
  }
}

await withoutExpectedErrorLogs(async () => {
  const memoryPressure = Object.assign(new Error('synthetic memory pressure'), {
    code: '241',
    type: 'MEMORY_LIMIT_EXCEEDED',
  });
  const fake = fakeClickHouse({ behaviors: [async () => { throw memoryPressure; }] });
  const store = storeFor(fake);
  for (let index = 0; index < 500; index += 1) store.enqueue(event(index));
  await store.flush();

  assert.equal(fake.state.calls.length, 2, '241 should retry the retained 500-row batch');
  assert.equal(fake.state.maxActive, 1, 'all event inserts must use one lane');
  assert.deepEqual(
    fake.state.calls[1].values.map(({ eventId }) => eventId),
    fake.state.calls[0].values.map(({ eventId }) => eventId),
    'a retry must reuse the exact rows and FIFO order',
  );
  assert.equal(batchToken(fake.state.calls[1]), batchToken(fake.state.calls[0]), 'a retry must reuse its token');
  assert.deepEqual(fake.state.calls[1].clickhouse_settings, fake.state.calls[0].clickhouse_settings);
  assert.deepEqual(snapshot(store), {
    rows: 0,
    bytes: 0,
    bufferedRows: 0,
    batches: 0,
    permanentError: undefined,
  });
  await store.close();
});

await withoutExpectedErrorLogs(async () => {
  const dnsFailure = Object.assign(new Error('getaddrinfo ENOTFOUND clickhouse'), { code: 'ENOTFOUND' });
  const unavailable = Object.assign(new Error('synthetic service unavailable'), { statusCode: 503 });
  const fake = fakeClickHouse({
    behaviors: [
      async () => { throw dnsFailure; },
      async () => { throw unavailable; },
    ],
  });
  const store = storeFor(fake);
  store.enqueue(event(550));
  await store.flush();
  assert.equal(fake.state.calls.length, 3, 'ENOTFOUND and explicit HTTP 503 must retry');
  assert.equal(fake.state.maxActive, 1);
  assert.ok(fake.state.calls.every((call) => batchToken(call) === batchToken(fake.state.calls[0])));
  assert.ok(fake.state.calls.every((call) => (
    call.values.length === 1 && call.values[0].eventId === event(550).eventId
  )));
  await store.close();
});

await withoutExpectedErrorLogs(async () => {
  const firstInsert = deferred();
  const fake = fakeClickHouse({ behaviors: [async () => firstInsert.promise] });
  const store = storeFor(fake);
  for (let index = 0; index < 500; index += 1) store.enqueue(event(index));
  await eventually(() => fake.state.calls.length === 1, 'the first full batch did not start');
  for (let index = 500; index < 5_000; index += 1) store.enqueue(event(index));

  assert.throws(
    () => store.enqueue(event(5_000)),
    (error) => error?.code === 'ANYSENTRY_CLICKHOUSE_EVENT_BUFFER_FULL',
    'the active batch must count toward the explicit 5k-row capacity',
  );
  const draining = store.flush();
  assert.equal(fake.state.calls.length, 1, 'repeated threshold flushes must coalesce behind the active insert');
  firstInsert.resolve();
  await draining;

  assert.deepEqual(fake.state.calls.map(({ values }) => values.length), Array(10).fill(500));
  assert.deepEqual(
    fake.state.calls.flatMap(({ values }) => values.map(({ eventId }) => eventId)),
    Array.from({ length: 5_000 }, (_, index) => event(index).eventId),
    'sealed batches must preserve global FIFO without loss or duplication',
  );
  assert.equal(fake.state.maxActive, 1);
  assert.equal(snapshot(store).rows, 0);
  await store.close();
});

await withoutExpectedErrorLogs(async () => {
  const firstInsert = deferred();
  const fake = fakeClickHouse({ behaviors: [async () => firstInsert.promise] });
  const store = storeFor(fake);
  for (let index = 0; index < 500; index += 1) store.enqueue(event(index));
  await eventually(() => fake.state.calls.length === 1, 'the buffered insert did not start');

  const direct = store.insertNow(event(500, { decisionStatus: 'pending' }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fake.state.calls.length, 1, 'insertNow must join the same event-write lane');
  firstInsert.resolve();
  await direct;
  await store.flush();
  assert.deepEqual(fake.state.calls.map(({ values }) => values.length), [500, 1]);
  assert.equal(fake.state.calls[1].values[0].eventId, event(500).eventId);
  assert.equal(fake.state.maxActive, 1);
  await store.close();
});

await withoutExpectedErrorLogs(async () => {
  const fake = fakeClickHouse();
  const store = storeFor(fake);
  const chained = store.insertNow(event(600, { decisionStatus: 'pending' })).then(() => (
    store.insertNow(event(601, { decisionStatus: 'running' }))
  ));
  await within(chained, 'a write queued from a resolved waiter continuation was stranded');
  assert.deepEqual(fake.state.calls.map(({ values }) => values[0].eventId), [event(600).eventId, event(601).eventId]);
  assert.equal(fake.state.maxActive, 1);
  await store.close();
});

await withoutExpectedErrorLogs(async () => {
  const firstInsert = deferred();
  const fake = fakeClickHouse({ behaviors: [async () => firstInsert.promise] });
  const store = storeFor(fake);
  const directEvent = event(650, { decisionStatus: 'pending' });
  const firstDirect = store.insertNow(directEvent);
  await eventually(() => fake.state.calls.length === 1, 'the direct capacity test insert did not start');
  for (let index = 0; index < 4_999; index += 1) store.enqueue(event(10_000 + index));
  assert.equal(snapshot(store).rows, 5_000);

  const joinedDirect = store.insertNow(directEvent);
  assert.equal(snapshot(store).rows, 5_000, 'joining an existing token must not consume capacity twice');
  assert.equal(fake.state.calls.length, 1, 'joining an active token must not create another insert');
  assert.equal(store.eventWriteBatches[0].rows.length, 1, 'same-token callers must share one direct row');
  assert.equal(store.eventWriteBatches[0].waiters.length, 2, 'same-token callers must share one completion');
  firstInsert.resolve();
  await Promise.all([firstDirect, joinedDirect]);
  await store.flush();

  assert.equal(fake.state.calls.filter(({ values }) => values.length === 1).length, 1);
  assert.equal(fake.state.calls.length, 11);
  assert.equal(fake.state.maxActive, 1);
  assert.equal(snapshot(store).rows, 0);
  await store.close();
});

await withoutExpectedErrorLogs(async () => {
  let fakeNow = 0;
  const retryable = Object.assign(new Error('synthetic memory pressure'), {
    code: '241',
    type: 'MEMORY_LIMIT_EXCEEDED',
  });
  const fake = fakeClickHouse({ behaviors: [async () => { throw retryable; }] });
  const store = storeFor(fake, {
    eventWriteNow: () => fakeNow,
    eventWriteRetryDeadlineMs: 1,
    eventWriteRetryDelayMs: () => 2,
  });
  let directSettled = false;
  const direct = store.insertNow(event(700, { decisionStatus: 'pending' }));
  direct.then(
    () => { directSettled = true; },
    () => { directSettled = true; },
  );
  await eventually(() => fake.state.calls.length === 1 && store.eventWriteDrainInFlight === undefined,
    'the first bounded retry cycle did not finish');
  assert.equal(directSettled, false, 'a retained retryable batch must retain its direct waiter');
  assert.equal(store.eventWriteBatches.length, 1);

  store.eventWriteBatches[0].retryNotBefore = 0;
  store.eventWriteRetryDeadlineMs = 100;
  fakeNow = 1;
  await store.flush();
  await direct;
  assert.equal(directSettled, true);
  assert.equal(fake.state.calls.length, 2);
  assert.equal(batchToken(fake.state.calls[1]), batchToken(fake.state.calls[0]));
  assert.deepEqual(fake.state.calls[1].values, fake.state.calls[0].values);
  await store.close();
});

await withoutExpectedErrorLogs(async () => {
  let attempts = 0;
  const fake = fakeClickHouse({
    onInsert(call, state) {
      const token = batchToken(call);
      if (!state.appliedByToken.has(token)) state.appliedByToken.set(token, structuredClone(call.values));
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error('Timeout error.'), { code: 'ETIMEDOUT' });
    },
  });
  const store = storeFor(fake);
  store.enqueue(event(800));
  await store.flush();

  assert.equal(fake.state.calls.length, 2);
  assert.equal(fake.state.appliedByToken.size, 1, 'an apply-then-timeout retry should apply one logical batch');
  assert.equal(batchToken(fake.state.calls[1]), batchToken(fake.state.calls[0]));

  store.enqueue(event(800));
  await store.flush();
  assert.equal(fake.state.appliedByToken.size, 2, 'a distinct logical batch must receive a distinct token');
  await store.close();
});

await withoutExpectedErrorLogs(async () => {
  const permanent = Object.assign(new Error('synthetic type mismatch'), {
    code: '53',
    type: 'TYPE_MISMATCH',
  });
  const fake = fakeClickHouse({ onInsert: async () => { throw permanent; } });
  const store = storeFor(fake);
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  try {
    for (let index = 0; index < 500; index += 1) store.enqueue(event(900 + index));
    await assert.rejects(store.flush(), /synthetic type mismatch/u);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fake.state.calls.length, 1, 'a permanent/unknown error must not retry');
    assert.equal(fake.state.maxActive, 1);
    assert.equal(snapshot(store).rows, 500, 'a permanently failed batch must remain retained');
    assert.equal(snapshot(store).batches, 1);
    assert.equal(unhandled.length, 0, 'fire-and-forget threshold drains must observe rejection');
    await assert.rejects(store.close(), /undrained rows/u);
    assert.equal(fake.state.closeCalls, 1);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

await withoutExpectedErrorLogs(async () => {
  const firstInsert = deferred();
  const fake = fakeClickHouse({ behaviors: [async () => firstInsert.promise] });
  const store = storeFor(fake);
  for (let index = 0; index < 501; index += 1) store.enqueue(event(1_500 + index));
  await eventually(() => fake.state.calls.length === 1, 'the shutdown test insert did not start');

  const firstClose = store.close();
  const secondClose = store.close();
  assert.equal(firstClose, secondClose, 'close must be idempotent and share one promise');
  assert.equal(fake.state.closeCalls, 0, 'client.close must wait for active and tail batches');
  assert.throws(() => store.enqueue(event(2_100)), /closing/u, 'close must stop accepting synchronously');
  firstInsert.resolve();
  await firstClose;

  assert.deepEqual(fake.state.calls.map(({ values }) => values.length), [500, 1]);
  assert.equal(fake.state.maxActive, 1);
  assert.equal(fake.state.closeCalls, 1);
  assert.equal(store.enabled, false);
  assert.equal(snapshot(store).rows, 0);
});

await withoutExpectedErrorLogs(async () => {
  const pressure = Object.assign(new Error('synthetic memory pressure'), {
    code: '241',
    type: 'MEMORY_LIMIT_EXCEEDED',
  });
  const fake = fakeClickHouse({ behaviors: [async () => { throw pressure; }] });
  const store = storeFor(fake, {
    eventWriteRetryDeadlineMs: 120_000,
    eventWriteRetryDelayMs: () => 60_000,
    eventWriteCloseDeadlineMs: 2_000,
  });
  store.enqueue(event(2_200));
  const flushing = store.flush();
  await eventually(() => Boolean(store.eventWriteRetrySleep), 'the retry backoff did not start');
  const startedAt = Date.now();
  await store.close();
  await flushing;
  assert.ok(Date.now() - startedAt < 1_000, 'close must wake a long retry backoff');
  assert.equal(fake.state.calls.length, 2);
  assert.equal(fake.state.closeCalls, 1);
});

{
  let fakeNow = 0;
  const firstInsert = deferred();
  const pressure = () => Object.assign(new Error('synthetic persistent memory pressure'), {
    code: '241',
    type: 'MEMORY_LIMIT_EXCEEDED',
  });
  const fake = fakeClickHouse({
    behaviors: [async () => {
      await firstInsert.promise;
      fakeNow += 5;
      throw pressure();
    }],
    onInsert() {
      fakeNow += 5;
      throw pressure();
    },
  });
  const store = storeFor(fake, {
    eventWriteNow: () => fakeNow,
    eventWriteRetryDeadlineMs: 15,
    eventWriteRetryDelayMs: () => 0,
    eventWriteCloseDeadlineMs: 20,
  });
  const diagnostics = [];
  const originalError = console.error;
  console.error = (...values) => diagnostics.push(values);
  try {
    store.enqueue(event(2_250));
    const flushing = store.flush().catch((error) => error);
    await eventually(() => fake.state.calls.length === 1, 'the persistent-failure insert did not start');
    const startedAt = Date.now();
    const closing = store.close();
    firstInsert.resolve();
    await assert.rejects(closing, /1 undrained rows/u);
    assert.ok(Date.now() - startedAt < 500, 'an always-retryable failure must obey the close deadline');
    assert.ok((await flushing) instanceof Error);
    assert.equal(fake.state.closeCalls, 1);
    assert.equal(snapshot(store).rows, 1, 'deadline failure must retain the undrained batch for diagnosis');
    assert.equal(snapshot(store).batches, 1);
    assert.ok(
      diagnostics.some((values) => values[0] === '[clickhouse] event writer shutdown deadline/terminal failure:'),
      'deadline exhaustion must emit a retained-batch shutdown diagnostic',
    );
  } finally {
    console.error = originalError;
  }
}

await withoutExpectedErrorLogs(async () => {
  const fake = fakeClickHouse({
    onInsert(call) {
      return new Promise((_, reject) => {
        const fail = () => reject(Object.assign(new Error('aborted a request after ambiguous apply'), {
          code: 'ETIMEDOUT',
        }));
        if (call.abort_signal.aborted) fail();
        else call.abort_signal.addEventListener('abort', fail, { once: true });
      });
    },
  });
  const store = storeFor(fake, {
    eventWriteRetryDeadlineMs: 1_000,
    eventWriteAttemptTimeoutMs: 1_000,
    eventWriteCloseDeadlineMs: 40,
    eventWriteRetryDelayMs: () => 0,
  });
  store.enqueue(event(2_275));
  const flushing = store.flush().catch((error) => error);
  await eventually(() => fake.state.calls.length === 1, 'the abort-aware close insert did not start');
  await assert.rejects(store.close(), /1 undrained rows/u);
  assert.ok((await flushing) instanceof Error);
  assert.equal(snapshot(store).rows, 1);
  assert.equal(snapshot(store).batches, 1);
  assert.equal(fake.state.closeCalls, 1);

  const callsAtClose = fake.state.calls.length;
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(fake.state.calls.length, callsAtClose, 'no insert may restart after close settles');
  assert.equal(store.eventWriteDrainInFlight, undefined, 'the drain owner must clear after close settles');
});

await withoutExpectedErrorLogs(async () => {
  const fake = fakeClickHouse();
  const store = storeFor(fake);
  const preview = 'x'.repeat(1_100_000);
  for (let index = 0; index < 4; index += 1) store.enqueue(event(2_300 + index, { rawPreview: preview }));
  await store.flush();
  assert.deepEqual(fake.state.calls.map(({ values }) => values.length), [3, 1],
    'serialized-byte bounds must split a logical batch below 500 rows when necessary');
  for (const call of fake.state.calls) {
    const bytes = call.values.reduce(
      (sum, row) => sum + Buffer.byteLength(JSON.stringify(row), 'utf8') + 1,
      0,
    );
    assert.ok(bytes <= BATCH_BYTES, `batch exceeded ${BATCH_BYTES} bytes: ${bytes}`);
  }
  assert.throws(
    () => store.enqueue(event(2_400, { rawPreview: 'x'.repeat(BATCH_BYTES) })),
    (error) => error?.code === 'ANYSENTRY_CLICKHOUSE_EVENT_ROW_TOO_LARGE',
  );
  await store.close();
});

const [storeSource, judgeSource, mainSource, manifestSource] = await Promise.all([
  readFile(new URL('../apps/api/src/security-monitoring/clickhouse-store.ts', import.meta.url), 'utf8'),
  readFile(new URL('../apps/api/src/security-monitoring/sentry-judge.service.ts', import.meta.url), 'utf8'),
  readFile(new URL('../apps/api/src/main.ts', import.meta.url), 'utf8'),
  readFile(new URL('../deploy/anysentry.yaml', import.meta.url), 'utf8'),
]);
assert.match(
  storeSource,
  /SETTINGS non_replicated_deduplication_window = 1000/u,
  'fresh events tables must enable ordinary-MergeTree deduplication',
);
assert.match(
  storeSource,
  /ALTER TABLE \$\{TABLE\} MODIFY SETTING non_replicated_deduplication_window = \$\{EVENT_DEDUPLICATION_WINDOW\}/u,
  'existing events tables must receive the deduplication setting',
);
assert.match(storeSource, /const EVENT_DEDUPLICATION_WINDOW = 1_000/u);
assert.match(storeSource, /const EVENT_WRITE_BATCH_ROWS = 500/u);
assert.match(storeSource, /const EVENT_WRITE_BATCH_BYTES = 4 \* 1024 \* 1024/u);
assert.match(storeSource, /const EVENT_WRITE_CLOSE_DEADLINE_MS = 20_000/u);
assert.match(judgeSource, /const COLLECTOR_HEARTBEAT_SHUTDOWN_TIMEOUT_MS = 5_000/u);
const hookIndex = mainSource.indexOf("app.enableShutdownHooks(['SIGTERM', 'SIGINT'])");
const listenIndex = mainSource.indexOf("await app.listen(port, '0.0.0.0')");
assert.ok(hookIndex >= 0 && listenIndex > hookIndex, 'SIGTERM/SIGINT hooks must be enabled before listen');
assert.match(
  manifestSource,
  /kind: Deployment[\s\S]*?name: anysentry[\s\S]*?terminationGracePeriodSeconds: 30/u,
  'the API pod must reserve 30 seconds for graceful buffer drain',
);

{
  const capacityError = Object.assign(new Error('synthetic event buffer full'), {
    code: 'ANYSENTRY_CLICKHOUSE_EVENT_BUFFER_FULL',
  });
  const hotRing = [];
  const byId = new Map();
  const incidents = new Map();
  const observed = { events: 0, incidents: 0 };
  const judge = Object.create(SentryJudgeService.prototype);
  Object.assign(judge, {
    ch: { enqueue() { throw capacityError; } },
    store: hotRing,
    storeById: byId,
    incidents,
    MAX: 10_000,
    TRIM_BATCH: 1_000,
    alerting: {
      observeEvent() { observed.events += 1; },
      observeIncident() { observed.incidents += 1; },
    },
  });
  assert.throws(() => judge.push(event(2_500)), (error) => error === capacityError);
  assert.deepEqual(hotRing, [], 'queue rejection must not mutate the hot ring');
  assert.equal(byId.size, 0, 'queue rejection must not mutate the event index');
  assert.equal(incidents.size, 0, 'queue rejection must not create an incident');
  assert.deepEqual(observed, { events: 0, incidents: 0 }, 'queue rejection must not notify alerting');
}

{
  let heartbeatAborted = false;
  let closeCalls = 0;
  const judge = Object.create(SentryJudgeService.prototype);
  Object.assign(judge, {
    collectorHeartbeats: [],
    MAX_COLLECTOR_HEARTBEATS: 10_000,
    collectorHeartbeatShutdownTimeoutMs: 5,
    ch: {
      saveCollectorHeartbeats(_records, signal) {
        return new Promise((_, reject) => {
          const abort = () => {
            heartbeatAborted = true;
            reject(new Error('synthetic heartbeat persistence abort'));
          };
          if (signal.aborted) abort();
          else signal.addEventListener('abort', abort, { once: true });
        });
      },
      async close() { closeCalls += 1; },
    },
  });
  await assert.rejects(
    within(judge.onModuleDestroy(), 'heartbeat shutdown timeout did not reach the event drain'),
    /synthetic heartbeat persistence abort/u,
  );
  assert.equal(heartbeatAborted, true, 'hung heartbeat persistence must receive an AbortSignal');
  assert.equal(closeCalls, 1, 'heartbeat timeout must still close and drain the event writer');
}

{
  let closeCalls = 0;
  const judge = Object.create(SentryJudgeService.prototype);
  Object.assign(judge, {
    collectorHeartbeats: [],
    MAX_COLLECTOR_HEARTBEATS: 10_000,
    collectorHeartbeatShutdownTimeoutMs: 5,
    ch: {
      async saveCollectorHeartbeats() { throw new Error('synthetic heartbeat persistence failure'); },
      async close() { closeCalls += 1; },
    },
  });
  await assert.rejects(judge.onModuleDestroy(), /synthetic heartbeat persistence failure/u);
  assert.equal(closeCalls, 1, 'heartbeat persistence failure must still close and drain the event writer');
}

console.log('ClickHouse write-buffer verification passed');
