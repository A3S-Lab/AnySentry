#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ClickHouseStore } from '../apps/api/dist/security-monitoring/clickhouse-store.js';
import { SecurityMonitoringController } from '../apps/api/dist/security-monitoring/security-monitoring.controller.js';
import { SentryJudgeService } from '../apps/api/dist/security-monitoring/sentry-judge.service.js';
import { canonicalizeEvent } from '../apps/api/dist/security-monitoring/streaming-normalizer.js';
import {
  decisionResultWorkerConcurrency,
  JudgmentQueueService,
} from '../apps/api/dist/security-monitoring/judgment-queue.service.js';
import { StreamingQueueService } from '../apps/api/dist/security-monitoring/streaming-queue.service.js';
import { StreamFindingStore } from '../apps/api/dist/security-monitoring/streaming-finding.service.js';
import {
  bindServerTrustedCorrelationContext,
  serverTrustedCorrelationContext,
} from '../apps/api/dist/security-monitoring/trusted-correlation.js';

const BATCH_BYTES = 4 * 1024 * 1024;

assert.equal(decisionResultWorkerConcurrency(), 64, 'result worker concurrency must fill one revision microbatch');
assert.equal(decisionResultWorkerConcurrency('4'), 8);
assert.equal(decisionResultWorkerConcurrency('999'), 128);

{
  const controller = Object.create(SecurityMonitoringController.prototype);
  controller.observedAssets = { bindIngestMeta: (meta) => ({ ...meta, subjectAssetId: 'asset-agent' }) };
  const context = {
    sourceTrust: {
      verification: 'server_verified',
      authenticated: true,
      authority: 'agent_adapter',
      allowedClaims: ['agent_adapter'],
      bindings: { tenantId: 'tenant-a', environmentId: 'env-a' },
    },
  };
  const meta = bindServerTrustedCorrelationContext({ sourceEventId: 'pi-external-id' }, context);
  const bound = controller.bindObservedAssetMeta(meta, 1);
  assert.notEqual(bound, meta, 'Observed Asset binding fixture clones EventMeta');
  assert.deepEqual(serverTrustedCorrelationContext(bound), context,
    'server-only adapter trust survives the Observed Asset projection clone');
}

{
  const previousUrl = process.env.CLICKHOUSE_URL;
  delete process.env.CLICKHOUSE_URL;
  const judge = Object.create(SentryJudgeService.prototype);
  judge.ch = { enabled: false };
  assert.equal(
    await judge.persistPreparedBatch([], 'memory-only-batch'),
    'memory_only',
    'a batch without ClickHouse must not claim a durability fence',
  );
  let durableWrites = 0;
  judge.ch = { enabled: true, insertManyNow: async () => { durableWrites += 1; } };
  assert.equal(await judge.persistPreparedBatch([], 'durable-batch'), 'durable');
  assert.equal(durableWrites, 1);
  if (previousUrl === undefined) delete process.env.CLICKHOUSE_URL;
  else process.env.CLICKHOUSE_URL = previousUrl;
}

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

function batchController(options = {}) {
  const controller = Object.create(SecurityMonitoringController.prototype);
  const acceptedSource = { accepted: true };
  Object.assign(controller, {
    sources: {
      resolve: () => acceptedSource,
      recordAccepted() {},
      recordRejected() {},
    },
    alerting: { observeSourceRejection() {} },
    agentMetadata: { applyReview: (value) => value },
    kube: { enrich: (value) => value },
    judge: {
      prepareAcceptWithDisposition(line, meta) {
        return options.prepare?.(line, meta) ?? {
          disposition: 'retained',
          notify: false,
          event: event(Number(meta.attributes?.sequence ?? 0), {
            eventId: `event-${line}`,
            sourceEventId: meta.sourceEventId,
          }),
        };
      },
      async persistPreparedBatch(prepared, token) {
        await options.persist?.(prepared, token);
        return options.durability ?? 'durable';
      },
      commitPreparedBatch(prepared) {
        options.commit?.(prepared);
      },
      async enqueuePreparedFastJob(prepared) {
        await options.deliver?.(prepared);
      },
      async enqueuePreparedFastJobs(prepared) {
        for (const item of prepared) await options.deliver?.(item);
      },
    },
    streaming: {
      async enqueueCanonical() { return true; },
      async enqueueCanonicalBatch() { return 0; },
    },
    supplyChain: { async observeRuntimeInstall() {} },
    workspaceDirectory: { observeEvent() {} },
    identityReview: { considerCandidate() {} },
    unknownLearning: { observeMany() {} },
    agg: { invalidateWindowCache() {} },
    observedAssets: {
      bindIngestMeta: (meta) => meta,
      materializeCommittedIngest: (meta) => options.materialize?.(meta),
    },
    ingest: options.ingest ?? (async () => ({ accepted: true })),
  });
  return controller;
}

function assertBatchAccounting(ack, batchLength) {
  assert.equal(
    ack.acceptedEvents + ack.rejectedEvents + ack.retryableEvents,
    batchLength,
    'batch acknowledgement counts must cover every submitted event exactly once',
  );
  assert.equal(ack.items.length, batchLength);
  const dispositions = { retained: 0, discarded: 0, rejected: 0, retryable: 0 };
  let structuralConsumed = 0;
  let retrySuffixStarted = false;
  for (let index = 0; index < ack.items.length; index += 1) {
    const item = ack.items[index];
    assert.equal(item.index, index, 'batch item indices must remain positional and contiguous');
    assert.ok(item.disposition in dispositions, `unexpected batch disposition: ${item.disposition}`);
    dispositions[item.disposition] += 1;
    if (item.disposition === 'retryable') {
      retrySuffixStarted = true;
      assert.equal(item.accepted, false);
      assert.equal(item.reasonCode, 'clickhouse_event_buffer_full');
    } else {
      assert.equal(retrySuffixStarted, false, 'capacity backpressure must mark one contiguous suffix');
      assert.equal(
        item.accepted,
        item.disposition === 'retained' || item.disposition === 'discarded',
      );
      if (item.structuralConsumed === true) {
        assert.equal(item.disposition, 'discarded');
        assert.equal(item.reasonCode, 'non_agent_structural_consumed');
        structuralConsumed += 1;
      }
    }
  }
  assert.equal(dispositions.retained, ack.retainedEvents);
  assert.equal(structuralConsumed, ack.structuralEvents ?? 0);
  assert.equal(dispositions.discarded, ack.discardedEvents);
  assert.equal(dispositions.rejected, ack.rejectedEvents);
  assert.equal(dispositions.retryable, ack.retryableEvents);
  assert.equal(
    ack.retainedEvents + ack.discardedEvents,
    ack.acceptedEvents,
  );
  assert.equal(ack.accepted, ack.acceptedEvents > 0);
  assert.equal(
    ack.retryAfterMs,
    ack.retryableEvents > 0 ? 1_000 : undefined,
    'retry delay must be present only for explicit retryable backpressure',
  );
}

{
  const aggregated = event(42, {
    eventKind: 'FileAccess',
    eventCategory: 'file',
    attributes: {
      path: '/workspace/.cache/state.json',
      write: true,
      repeat_count: 27,
      first_event_at: 1_700_000_000_000,
      lastEventAt: 1_700_000_000_900,
      aggregation_window_ms: 1_000,
    },
  });
  const canonical = canonicalizeEvent(
    aggregated,
    JSON.stringify({ event: { FileAccess: { path: aggregated.attributes.path, write: true } } }),
  );
  assert.deepEqual(
    {
      repeatCount: canonical.repeatCount,
      firstEventAt: canonical.firstEventAt,
      lastEventAt: canonical.lastEventAt,
      aggregationWindowMs: canonical.aggregationWindowMs,
    },
    {
      repeatCount: 27,
      firstEventAt: 1_700_000_000_000,
      lastEventAt: 1_700_000_000_900,
      aggregationWindowMs: 1_000,
    },
    'canonical normalization must preserve Collector FileAccess aggregation metadata',
  );
}

await (async () => {
  const fastCalls = [];
  const judgmentQueue = Object.create(JudgmentQueueService.prototype);
  judgmentQueue.fastQueue = { async addBulk(items) { fastCalls.push(items); } };
  const fastJobs = [1, 2].map((index) => ({
    schemaVersion: 'anysentry.fast_judge_job.v2',
    evaluationId: `evaluation-${index}`,
    policyVersion: 'policy-1',
    event: event(50 + index),
    observerLine: '{}',
    policy: {},
    routing: {},
    queuedAt: 1,
  }));
  await judgmentQueue.enqueueFastBatch(fastJobs);
  assert.deepEqual(
    fastCalls[0].map((item) => item.opts.jobId),
    ['evaluation-1', 'evaluation-2'],
    'FastJudge batch delivery must retain stable evaluation job ids',
  );

  const canonicalCalls = [];
  const streamingQueue = Object.create(StreamingQueueService.prototype);
  Object.assign(streamingQueue, {
    queue: { async addBulk(items) { canonicalCalls.push(items); } },
    agentOnly: false,
    canonicalTopic: 'canonical-test',
  });
  const canonicalCount = await streamingQueue.enqueueCanonicalBatch([
    { event: event(61), observerLine: '{}' },
    { event: event(62), observerLine: '{}' },
  ]);
  assert.equal(canonicalCount, 2);
  assert.equal(canonicalCalls.length, 1, 'canonical post-commit delivery must use one Redis bulk command');
  assert.ok(canonicalCalls[0].every((item) => item.opts.jobId === `canonical-${item.data.messageId}`));
})();

await (async () => {
  const inserts = [];
  const store = new StreamFindingStore();
  store.ready = true;
  store.client = { async insert(request) { inserts.push(request); } };
  const findings = Array.from({ length: 130 }, (_, index) => ({
    schemaVersion: 'anysentry.stream_finding.v1',
    findingType: 'risk_profile',
    findingId: `finding-${index}`,
    profileId: `profile-${index}`,
    version: 1,
    features: { fileWrites: index },
    hitRules: [],
    shadow: true,
  }));
  await store.upsertMany(findings);
  assert.equal(inserts.length, 1, 'one Kafka finding batch must create one ClickHouse profile block');
  assert.equal(inserts[0].table, 'stream_risk_profiles');
  assert.equal(inserts[0].values.length, 130);
})();

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
  assert.equal(fake.state.calls[0].values[0].activityContext, 'agent_action');
  assert.equal(fake.state.calls[0].values[0].activitySubtype, '');
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
  const fake = fakeClickHouse();
  const store = storeFor(fake);
  store.enqueue(event(501, {
    eventCategory: 'runtime',
    activityContext: 'platform_healthcheck',
    activitySubtype: 'docker_healthcheck',
  }));
  await store.flush();
  assert.equal(fake.state.calls.length, 1);
  assert.equal(fake.state.calls[0].values[0].eventKind, 'ToolExec');
  assert.equal(fake.state.calls[0].values[0].eventCategory, 'runtime');
  assert.equal(fake.state.calls[0].values[0].activityContext, 'platform_healthcheck');
  assert.equal(fake.state.calls[0].values[0].activitySubtype, 'docker_healthcheck');
  await store.close();
});

await withoutExpectedErrorLogs(async () => {
  const fake = fakeClickHouse();
  const producerDigest = createHash('sha256').update('stable-pi-producer-payload').digest('hex');
  const idempotencyKey = `adapter-event:source-a\0pi-invocation-start:${producerDigest}`;
  const original = event(3_260, {
    eventKind: 'AgentInvocation',
    sourceEventId: 'pi-invocation-start',
    receivedAt: 1_700_000_003_260,
    decisionRevision: 1,
  });
  const beforeRestart = storeFor(fake);
  await beforeRestart.insertNow(original, idempotencyKey);
  await beforeRestart.close();

  // Simulate a fresh API process: all in-memory revision/idempotency caches are empty. Server-side
  // receipt/asset projections may differ, but the exact authenticated producer payload retains the
  // same ClickHouse dedup token, so the first durable revision remains authoritative.
  const afterRestart = storeFor(fake);
  await afterRestart.insertNow({
    ...original,
    receivedAt: original.receivedAt + 1,
    subjectAssetId: 'server-projection-after-restart',
  }, idempotencyKey);
  assert.equal(fake.state.calls.length, 2);
  assert.equal(batchToken(fake.state.calls[1]), batchToken(fake.state.calls[0]),
    'exact external-id replay keeps one ClickHouse token across API process restart');
  await afterRestart.close();
});

await withoutExpectedErrorLogs(async () => {
  const fake = fakeClickHouse();
  const store = storeFor(fake);
  const judge = Object.create(SentryJudgeService.prototype);
  const initialPending = Array.from({ length: 128 }, (_, index) => event(30_000 + index, {
    decisionStatus: 'pending',
    decisionRevision: 1,
    decisionUpdatedAt: 1_000 + index,
    evaluationId: `evaluation-replay-${index}`,
    policyVersion: 'policy-replay',
  }));
  const replayPending = initialPending.map((pending, index) => ({
    ...pending,
    at: 3_000 + index,
    decisionUpdatedAt: 3_000 + index,
  }));
  const storeById = new Map(initialPending.map((pending) => [pending.eventId, pending]));
  Object.assign(judge, {
    storeById,
    resultApplyLocks: new Map(),
    decisionRevisionWrites: [],
    decisionRevisionWriterClosing: false,
    ch: store,
    alerting: { observeJudgmentResult() {} },
    upsertMemory(record) {
      this.storeById.set(record.eventId, record);
      return record;
    },
  });

  judge.commitPreparedBatch(replayPending.map((pending) => ({
    disposition: 'retained',
    event: pending,
    notify: false,
  })));
  assert.equal(
    storeById.get(initialPending[0].eventId).decisionUpdatedAt,
    initialPending[0].decisionUpdatedAt,
    'an immutable pending batch replay must not refresh the hot-ring revision timestamp',
  );

  // Also emulate a process hydrated from an older buggy replay: even a later pending timestamp must
  // not suppress a real judgment result, because pending revision 1 is not an applied decision.
  for (const replay of replayPending) storeById.set(replay.eventId, replay);
  const results = initialPending.map((pending, index) => ({
    schemaVersion: 'anysentry.decision_result.v1',
    evaluationId: pending.evaluationId,
    policyVersion: pending.policyVersion,
    event: pending,
    stage: 'L1',
    status: 'succeeded',
    decision: {
      verdict: 'allow',
      tier: 'Rules',
      severity: 'info',
      reason: 'replay ordering regression fixture',
    },
    l1Decision: {
      verdict: 'allow',
      tier: 'Rules',
      severity: 'info',
      reason: 'replay ordering regression fixture',
    },
    nextTierEligible: false,
    stageStopReason: 'decision_final',
    startedAt: 1_500 + index,
    completedAt: 2_000 + index,
    attempt: 1,
  }));
  await Promise.all(results.map((result) => judge.applyAsyncResult(result)));
  assert.deepEqual(
    fake.state.calls.map((call) => call.values.length),
    [64, 64],
    '128 results completed before a replay receipt must still produce two 64-row final-revision blocks',
  );
  assert.ok(fake.state.calls.flatMap((call) => call.values).every((row) => row.decisionRevision === 2));
  await judge.applyAsyncResult(results[0]);
  assert.equal(fake.state.calls.length, 2, 'an already-applied final result must remain idempotent');
  await store.close();
});

await withoutExpectedErrorLogs(async () => {
  const batches = [];
  const judge = Object.create(SentryJudgeService.prototype);
  Object.assign(judge, {
    decisionRevisionWrites: [],
    decisionRevisionWriterClosing: false,
    ch: {
      async insertManyNow(events) {
        batches.push(events.map((item) => item.eventId));
      },
    },
  });
  await Promise.all([
    judge.persistDecisionRevision(event(3_400, { decisionRevision: 2, decisionStatus: 'succeeded' })),
    judge.persistDecisionRevision(event(3_401, { decisionRevision: 2, decisionStatus: 'succeeded' })),
    judge.persistDecisionRevision(event(3_402, { decisionRevision: 2, decisionStatus: 'succeeded' })),
  ]);
  assert.deepEqual(
    batches,
    [[event(3_400).eventId, event(3_401).eventId, event(3_402).eventId]],
    'concurrent final revisions must wait for one durable micro-batch',
  );
});

await withoutExpectedErrorLogs(async () => {
  const fake = fakeClickHouse();
  const store = storeFor(fake);
  const judge = Object.create(SentryJudgeService.prototype);
  Object.assign(judge, {
    decisionRevisionWrites: [],
    decisionRevisionWriterClosing: false,
    ch: store,
  });
  const revisions = Array.from({ length: 128 }, (_, index) => event(20_000 + index, {
    decisionRevision: 2,
    decisionStatus: 'succeeded',
    decisionUpdatedAt: 1_700_000_100_000 + index,
  }));
  await Promise.all(revisions.map((revision) => judge.persistDecisionRevision(revision)));
  assert.deepEqual(
    fake.state.calls.map((call) => call.values.length),
    [64, 64],
    '128 concurrent final revisions must drain as two consecutive 64-row blocks',
  );
  assert.notEqual(
    batchToken(fake.state.calls[0]),
    batchToken(fake.state.calls[1]),
    'two different final-revision blocks must not share a ClickHouse deduplication token',
  );
  assert.equal(
    new Set(fake.state.calls.flatMap((call) => call.values.map((row) => row.eventId))).size,
    128,
    'both final-revision blocks must retain every unique event id',
  );
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
    (error) => (
      error?.code === 'ANYSENTRY_CLICKHOUSE_EVENT_BUFFER_FULL' &&
      error?.retrySafe === true
    ),
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
  const fake = fakeClickHouse();
  const store = storeFor(fake);
  const sameRevision = event(3_250, { decisionStatus: 'succeeded', decisionRevision: 1 });
  store.enqueue(sameRevision);
  await store.insertNow(sameRevision);
  assert.equal(fake.state.calls.length, 1, 'a direct waiter must join an earlier buffered copy of the same revision');
  assert.equal(fake.state.calls[0].values.length, 1);
  await store.close();
});

await withoutExpectedErrorLogs(async () => {
  const fake = fakeClickHouse();
  const store = storeFor(fake);
  const rows = Array.from({ length: 128 }, (_, index) => event(3_000 + index, {
    decisionStatus: 'pending',
    decisionRevision: 1,
  }));
  await store.insertManyNow(rows, 'observer-batch:stable-128');
  assert.equal(fake.state.calls.length, 1, 'insertManyNow must persist one bounded request as one block');
  assert.equal(fake.state.calls[0].values.length, 128);
  const token = batchToken(fake.state.calls[0]);

  await store.insertManyNow(rows, 'observer-batch:stable-128');
  assert.equal(fake.state.calls.length, 1, 'a committed immutable revision batch must be idempotent');
  assert.equal(token, batchToken(fake.state.calls[0]));
  await store.close();
});

await withoutExpectedErrorLogs(async () => {
  const firstInsert = deferred();
  const fake = fakeClickHouse({ behaviors: [async () => firstInsert.promise] });
  const store = storeFor(fake);
  const rows = [event(3_200, { decisionStatus: 'pending', decisionRevision: 1 })];
  const first = store.insertManyNow(rows, 'observer-batch:join-active');
  await eventually(() => fake.state.calls.length === 1, 'the direct batch did not enter the writer');
  const joined = store.insertManyNow(rows, 'observer-batch:join-active');
  assert.equal(store.eventWriteBatches[0].waiters.length, 2, 'same immutable batch must share one durable waiter');
  firstInsert.resolve();
  await Promise.all([first, joined]);
  assert.equal(fake.state.calls.length, 1);
  await store.close();
});

await withoutExpectedErrorLogs(async () => {
  const fake = fakeClickHouse();
  const store = storeFor(fake);
  const original = event(3_300, { decisionStatus: 'pending', decisionRevision: 1 });
  await store.insertManyNow([original], 'observer-batch:revision-original');
  await assert.rejects(
    store.insertManyNow([{ ...original, reason: 'conflicting semantic payload' }], 'observer-batch:revision-conflict'),
    (error) => error?.code === 'ANYSENTRY_EVENT_REVISION_CONFLICT',
    'the same event revision must reject a different semantic payload',
  );
  assert.equal(fake.state.calls.length, 1, 'revision conflict must be rejected before another insert');
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
  assert.equal(
    fake.state.appliedByToken.size,
    1,
    'a duplicate immutable event revision must not create another physical ClickHouse block',
  );
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
assert.match(storeSource, /const EVENT_WRITE_ATTEMPT_TIMEOUT_MS = 8_000/u);
assert.match(storeSource, /const EVENT_WRITE_CLOSE_DEADLINE_MS = 20_000/u);
assert.match(
  judgeSource,
  /ANYSENTRY_HOT_COLLECTOR_HEARTBEAT_LIMIT'[\s\S]*?1_000,[\s\S]*?128,[\s\S]*?2_000/u,
  'the in-process Collector heartbeat working set must remain independently bounded',
);
assert.match(
  judgeSource,
  /ANYSENTRY_HOT_COLLECTOR_HEARTBEAT_BYTES'[\s\S]*?16 \* 1024 \* 1024/u,
  'the Collector heartbeat working set must also have a byte budget',
);
assert.doesNotMatch(
  judgeSource,
  /saveCollectorHeartbeats/u,
  'the API must not rewrite the former whole-array heartbeat config snapshot',
);
assert.match(
  storeSource,
  /arraySlice\(JSONExtractArrayRaw\(value\), -\{limit:Int32\}\)/u,
  'legacy heartbeat migration must slice the config snapshot inside ClickHouse',
);
assert.match(
  storeSource,
  /SELECT collectorId, at, payload[\s\S]*?ORDER BY at DESC[\s\S]*?LIMIT \{scanLimit:UInt32\}/u,
  'heartbeat hydration must limit recent physical rows before in-process deduplication',
);
const healthStatsBody = judgeSource.match(/healthStats\(\):[^]*?\n  \}\n\n  \/\*\* Store histograms/u)?.[0] ?? '';
assert.ok(healthStatsBody, 'the O(1) health summary must exist');
assert.doesNotMatch(healthStatsBody, /for\s*\(|new Set|parseTrustedCorrelation/u);
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
    retrySafe: true,
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

await withoutExpectedErrorLogs(async () => {
  const queueError = Object.assign(new Error('synthetic judgment queue unavailable'), {
    code: 'SYNTHETIC_JUDGMENT_QUEUE_UNAVAILABLE',
  });
  const capacityError = Object.assign(new Error('synthetic failure-revision buffer full'), {
    code: 'ANYSENTRY_CLICKHOUSE_EVENT_BUFFER_FULL',
    retrySafe: true,
  });
  const writes = [];
  const memoryStates = [];
  const judge = Object.create(SentryJudgeService.prototype);
  Object.assign(judge, {
    policy: {},
    sentry: {
      evaluateL1() {
        return {
          l1Decision: { verdict: 'escalate' },
          nextTierEligible: true,
          stopReason: 'unresolved_l1_escalation',
        };
      },
    },
    queues: {
      enabled: true,
      async enqueueFast() { throw queueError; },
    },
    ch: {
      async insertNow(record) {
        writes.push(record);
        if (writes.length === 2) throw capacityError;
      },
    },
    eventBase() {
      return {
        schemaVersion: 'anysentry.event.v1',
        eventId: 'evt-post-persist-capacity',
        at: 1,
        eventKind: 'ToolExec',
        eventCategory: 'tool',
        source: 'observer',
        subject: 'post-persist capacity fixture',
        workspacePath: '/workspace',
        agentId: 'fixture-agent',
        sessionId: 'fixture-session',
        traceId: 'fixture-trace',
        spanId: 'fixture-span',
        runId: 'fixture-run',
        attributes: {},
        attribution: { classification: 'confirmed_agent' },
      };
    },
    availableTiers() { return { l1: true, l2: true, l3: false }; },
    policyVersion() { return 'fixture-policy'; },
    isInternalL3Invocation() { return false; },
    upsertMemory(record) { memoryStates.push(record); },
  });
  await assert.rejects(
    judge.acceptWithDisposition('{"event":{"ToolExec":{}}}', {}, 1),
    (error) => error === queueError,
    'a post-persist capacity error must never replace the primary queue failure with retryable backpressure',
  );
  assert.equal(writes.length, 2, 'the pending revision and best-effort failed revision must both be attempted');
  assert.equal(writes[0].decisionStatus, 'pending');
  assert.equal(writes[1].decisionStatus, 'failed');
  assert.deepEqual(
    memoryStates.map((record) => record.decisionStatus),
    ['pending', 'failed'],
    'the hot ring must expose the actual queue failure even when its failure revision cannot persist',
  );
});

{
  let materialized = 0;
  const controller = batchController({
    durability: 'memory_only',
    materialize() { materialized += 1; },
  });
  const ack = await controller.ingestBatch({ events: [{ line: 'memory-only-retained' }] }, {});
  assert.equal(ack.retainedEvents, 1, 'memory-only compatibility mode may still retain in the hot ring');
  assert.equal(materialized, 0,
    'memory-only batch retention must not publish a durable Observed Asset lifecycle state');
}

{
  let acceptedWrites = 0;
  const controller = batchController();
  controller.sources.resolve = () => ({
    accepted: true,
    authenticated: true,
    source: {
      sourceId: 'source-direct-adapter-idempotency',
      type: 'custom',
      enabled: true,
      requireToken: true,
      correlationClaims: {
        enabled: true,
        authority: 'agent_adapter',
        bindings: {
          tenantIds: [], environmentIds: [], workspaceIds: [], workspacePaths: [],
          collectorIds: [], physicalWorkloadIds: [], agentScopeIds: [],
        },
      },
    },
  });
  controller.kube.enrichAuthenticatedAgentSemantic = (meta) => ({
    meta,
    inventoryObserved: false,
    reason: 'fixture-no-inventory',
  });
  controller.unknownLearning.observe = () => {};
  Object.assign(controller.judge, {
    eventIdForSource: () => 'evt-direct-adapter-idempotency',
    findEvent: () => undefined,
    storageStatus: () => ({ clickhouseReady: false }),
    async acceptWithDisposition(_line, meta) {
      acceptedWrites += 1;
      return {
        disposition: 'retained',
        durability: 'durable',
        event: event(3_700, {
          eventId: 'evt-direct-adapter-idempotency',
          sourceEventId: meta.sourceEventId,
          eventKind: 'AgentInvocation',
          invocationId: meta.invocationId,
          traceId: meta.traceId,
        }),
      };
    },
  });
  const request = {
    sourceId: 'source-direct-adapter-idempotency',
    sourceType: 'custom',
    workspacePath: '/workspace',
    events: [{
      id: 'pi-invocation-start-idempotency',
      at: 1_700_000_003_700,
      eventKind: 'AgentInvocation',
      eventCategory: 'runtime',
      subject: 'Pi invocation started',
      agentId: 'pi-agent',
      sessionId: 'pi-session',
      invocationId: 'pi-invocation-one',
      traceId: 'a'.repeat(32),
      workspacePath: '/workspace',
      attributes: {
        'anysentry.adapter.schema': 'anysentry.agent_adapter_event.v1',
        'anysentry.adapter.runtime': 'pi',
        'anysentry.lifecycle.phase': 'start',
      },
    }],
  };
  const first = await controller.ingestEvents(request, {});
  const replay = await controller.ingestEvents(structuredClone(request), {});
  assert.equal(first.acceptedEvents, 1);
  assert.equal(first.items[0].invocationId, 'pi-invocation-one');
  assert.equal(replay.acceptedEvents, 1);
  assert.equal(replay.items[0].eventId, first.items[0].eventId);
  assert.equal(replay.items[0].duplicate, true,
    'exact direct adapter external-id replay is explicitly acknowledged as a duplicate');
  assert.equal(acceptedWrites, 1, 'exact replay cannot generate another event revision');
  await assert.rejects(
    controller.ingestEvents({
      ...structuredClone(request),
      events: [{ ...request.events[0], subject: 'different payload under same external id' }],
    }, {}),
    (error) => error?.getStatus?.() === 409,
    'different producer payload under one external id terminates with HTTP 409',
  );
  assert.equal(acceptedWrites, 1);
}

{
  const capacityError = Object.assign(new Error('synthetic event buffer full'), {
    code: 'ANYSENTRY_CLICKHOUSE_EVENT_BUFFER_FULL',
    retrySafe: true,
  });
  const preparedLines = [];
  let commits = 0;
  const controller = batchController({
    prepare(line, meta) {
      preparedLines.push(line);
      if (line === 'discarded') return { disposition: 'discarded', reasonCode: 'non_agent_discarded' };
      return {
        disposition: 'retained',
        notify: false,
        event: event(preparedLines.length, { eventId: `event-${line}`, sourceEventId: meta.sourceEventId }),
      };
    },
    async persist() { throw capacityError; },
    commit() { commits += 1; },
  });
  const ack = await controller.ingestBatch({
    events: [
      { line: 'retained' },
      { line: 'discarded' },
      { line: 'capacity' },
      { line: 'must-not-run' },
    ],
  }, {});
  assertBatchAccounting(ack, 4);
  assert.deepEqual(
    preparedLines,
    ['retained', 'discarded', 'capacity', 'must-not-run'],
    'batch preparation must finish before the one durable commit is attempted',
  );
  assert.equal(commits, 0, 'capacity rejection must not commit hot-ring or alerting side effects');
  assert.deepEqual(
    {
      accepted: ack.accepted,
      acceptedEvents: ack.acceptedEvents,
      retainedEvents: ack.retainedEvents,
      discardedEvents: ack.discardedEvents,
      rejectedEvents: ack.rejectedEvents,
      retryableEvents: ack.retryableEvents,
      retryAfterMs: ack.retryAfterMs,
      dispositions: ack.items.map((item) => item.disposition),
    },
    {
      accepted: false,
      acceptedEvents: 0,
      retainedEvents: 0,
      discardedEvents: 0,
      rejectedEvents: 0,
      retryableEvents: 4,
      retryAfterMs: 1_000,
      dispositions: ['retryable', 'retryable', 'retryable', 'retryable'],
    },
    'pre-commit capacity failure must retry the complete immutable batch without a partial prefix',
  );
  assert.ok(ack.items.every((item) => item.accepted === false && item.reasonCode === 'clickhouse_event_buffer_full'));
}

{
  const delivered = [];
  const controller = batchController({
    prepare(line) {
      if (line === 'discarded') return { disposition: 'discarded', reasonCode: 'non_agent_discarded' };
      if (line === 'hard-rejection') return { disposition: 'rejected', reasonCode: 'unsupported_or_unparseable' };
      return {
        disposition: 'retained',
        notify: false,
        event: event(delivered.length + 100, { eventId: `event-${line}` }),
      };
    },
    async deliver(prepared) {
      const line = prepared.event.eventId.replace(/^event-/u, '');
      delivered.push(line);
      if (line === 'delivery-failure') throw new Error('synthetic canonical queue outage');
    },
  });
  const ack = await controller.ingestBatch({
    batchId: 'batch-delivery-suffix',
    events: [
      { line: 'discarded' },
      { line: 'retained-a' },
      { line: 'delivery-failure' },
      { line: 'hard-rejection' },
    ],
  }, {});
  assertBatchAccounting(ack, 4);
  assert.deepEqual(delivered, ['retained-a', 'delivery-failure']);
  assert.deepEqual(
    {
      accepted: ack.accepted,
      acceptedEvents: ack.acceptedEvents,
      rejectedEvents: ack.rejectedEvents,
      retryableEvents: ack.retryableEvents,
      retryAfterMs: ack.retryAfterMs,
    },
    {
      accepted: true,
      acceptedEvents: 1,
      rejectedEvents: 0,
      retryableEvents: 3,
      retryAfterMs: 1_000,
    },
  );
  assert.deepEqual(
    ack.items.map((item) => item.disposition),
    ['discarded', 'retryable', 'retryable', 'retryable'],
    'post-commit delivery failure must retain its successful prefix and retry one contiguous suffix',
  );
  assert.ok(ack.items.slice(1).every((item) => item.deliveryIncomplete === true));
  assert.equal(ack.batchId, 'batch-delivery-suffix');
  assert.match(ack.payloadDigest, /^[a-f0-9]{64}$/u);
}

{
  let prepared = 0;
  let persisted = 0;
  let delivered = 0;
  const controller = batchController({
    prepare(line) {
      prepared += 1;
      return {
        disposition: 'retained',
        notify: false,
        event: event(3_500 + prepared, { eventId: `event-${line}` }),
      };
    },
    async persist() { persisted += 1; },
    async deliver() { delivered += 1; },
  });
  const events = [{ line: 'digest-a' }, { line: 'digest-b' }];
  const digest = createHash('sha256').update(JSON.stringify(events)).digest('hex');
  const ack = await controller.ingestBatch({
    batchId: 'batch-digest-contract',
    payloadDigest: digest,
    events,
  }, {});
  assert.equal(ack.batchId, 'batch-digest-contract');
  assert.equal(ack.payloadDigest, digest);
  assert.equal(prepared, 2);
  assert.equal(persisted, 1);
  assert.equal(delivered, 2);

  const replay = await controller.ingestBatch({
    batchId: 'batch-digest-contract',
    payloadDigest: digest,
    events,
  }, {});
  assert.deepEqual(replay, ack,
    'an exact immutable batch replay returns the original terminal acknowledgement');
  assert.equal(prepared, 4, 'replay still crosses current Source validation and side-effect-free preparation');
  assert.equal(persisted, 1, 'replay cannot create another ClickHouse event revision');
  assert.equal(delivered, 2, 'replay cannot duplicate canonical or judgment delivery');

  await assert.rejects(
    controller.ingestBatch({
      batchId: 'batch-digest-contract',
      payloadDigest: '0'.repeat(64),
      events,
    }, {}),
    (error) => error?.getStatus?.() === 400,
    'a mismatched payload digest must fail before event preparation',
  );
  assert.equal(prepared, 4);
  await assert.rejects(
    controller.ingestBatch({
      batchId: 'batch-digest-contract',
      events: [{ line: 'different-payload' }],
    }, {}),
    (error) => error?.getStatus?.() === 400,
    'one batchId must not be reused for a different payload',
  );
  assert.equal(prepared, 4);
}

{
  const permanent = Object.assign(new Error('synthetic permanent ingest failure'), { code: 'SYNTHETIC_PERMANENT' });
  const controller = batchController({ async persist() { throw permanent; } });
  await assert.rejects(
    controller.ingestBatch({ events: [{ line: 'permanent' }] }, {}),
    (error) => error === permanent,
    'non-capacity errors must keep propagating through the batch endpoint',
  );
}

{
  const ambiguousCapacity = Object.assign(new Error('synthetic post-accept capacity failure'), {
    code: 'ANYSENTRY_CLICKHOUSE_EVENT_BUFFER_FULL',
  });
  const controller = batchController({ async persist() { throw ambiguousCapacity; } });
  await assert.rejects(
    controller.ingestBatch({ events: [{ line: 'already-accepted' }] }, {}),
    (error) => error === ambiguousCapacity,
    'the controller must require explicit retrySafe proof, not just a shared capacity error code',
  );
}

{
  let calls = 0;
  const controller = batchController({
    prepare() {
      calls += 1;
      return { disposition: 'rejected', reasonCode: 'unsupported_or_unparseable' };
    },
  });
  await assert.rejects(
    controller.ingestBatch({
      events: Array.from({ length: 257 }, (_, index) => ({ line: `oversized-${index}` })),
    }, {}),
    (error) => error?.getStatus?.() === 413,
    'an oversized item-count batch must be rejected before any prefix is consumed',
  );
  assert.equal(calls, 0, 'HTTP 413 is safe to split only when the controller processed zero items');
}

{
  let closeCalls = 0;
  let incidentSaves = 0;
  const judge = Object.create(SentryJudgeService.prototype);
  Object.assign(judge, {
    incidents: new Map(),
    decisionRevisionWrites: [],
    async persistIncidentState() { incidentSaves += 1; },
    ch: {
      async close() { closeCalls += 1; },
    },
  });
  await within(judge.onModuleDestroy(), 'shutdown did not reach the additive heartbeat/event drain');
  assert.equal(incidentSaves, 1, 'shutdown must still persist bounded incident state');
  assert.equal(closeCalls, 1, 'ClickHouse close must flush the additive heartbeat side buffer');
}

console.log('ClickHouse write-buffer verification passed');
