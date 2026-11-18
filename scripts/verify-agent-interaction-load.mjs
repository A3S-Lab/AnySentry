#!/usr/bin/env node

import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { managementAuthHeaders, safeProbeId } from './probe-id.mjs';

const configuredBase = process.env.ANYSENTRY_API_BASE?.trim();
if (!configuredBase) {
  throw new Error(
    'ANYSENTRY_API_BASE is required; the load verifier never defaults to a production port',
  );
}
const baseUrl = configuredBase.replace(/\/$/u, '');
const parsedBase = new URL(baseUrl);
if (
  parsedBase.port === '29653'
  && process.env.ANYSENTRY_ALLOW_PRODUCTION_LOAD_VERIFY
    !== 'I_UNDERSTAND_THIS_WRITES_TEST_DATA'
) {
  throw new Error('refusing to run a mutating load verifier against port 29653');
}

function bounded(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.max(min, Math.min(max, Math.trunc(number)))
    : fallback;
}

const eventCount = bounded(process.env.ANYSENTRY_INTERACTION_LOAD_EVENTS, 1_000, 1, 5_000);
const concurrency = bounded(process.env.ANYSENTRY_INTERACTION_LOAD_CONCURRENCY, 32, 1, 64);
const replayCount = Math.min(
  eventCount,
  bounded(process.env.ANYSENTRY_INTERACTION_LOAD_REPLAYS, 100, 0, 1_000),
);
const runId = safeProbeId('interaction-load');
const collectorId = `${runId}-collector`;
const workspacePath = `repo://${runId}/workspace`;
const observedAtBase = Date.now();

function percentile(values, ratio) {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * ratio) - 1)];
}

async function requestRaw(path, method = 'GET', body, headers = {}) {
  const started = performance.now();
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...managementAuthHeaders(),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  let payload;
  try {
    payload = raw ? JSON.parse(raw) : undefined;
  } catch {
    payload = raw;
  }
  return {
    status: response.status,
    payload: payload?.data ?? payload,
    raw,
    durationMs: performance.now() - started,
  };
}

async function request(path, method = 'GET', body, headers = {}) {
  const result = await requestRaw(path, method, body, headers);
  assert.ok(
    result.status >= 200 && result.status < 300,
    `${method} ${path} -> ${result.status}: ${result.raw}`,
  );
  return result;
}

function sourceHeaders(sourceId, token) {
  return {
    'x-anysentry-source-id': sourceId,
    'x-anysentry-ingest-token': token,
  };
}

function fixture(index) {
  return {
    schemaVersion: 'anysentry.interaction-metadata.v1',
    eventType: 'LlmTransportObserved',
    sourceEventId: `${runId}-event-${index}`,
    collectorId,
    observedAt: observedAtBase + index,
    agentInstanceId: `${runId}-agent`,
    workspacePath,
    process: {
      hostId: `${runId}-host`,
      bootId: `${runId}-boot`,
      pid: 4242,
      startTimeTicks: '987654321',
      comm: 'node',
      exe: '/usr/bin/node',
      cgroupId: '123456789',
    },
    transport: {
      sni: 'api.openai.com',
      provider: 'openai-compatible',
      peer: '203.0.113.10:443',
      protocol: 'http2',
      requestBytes: 512 + (index % 32),
      responseBytes: 2_048 + (index % 128),
      timingScope: 'unavailable',
      latencyAvailability: 'unavailable',
      ttftAvailability: 'unavailable',
    },
    capture: {
      captureMethod: 'ebpf_transport',
      captureMode: 'metadata',
      captureCompleteness: 'unavailable',
      parseStatus: 'not_attempted',
      rawRetentionState: 'not_retained',
      presentationState: 'metadata_only',
    },
  };
}

async function concurrentMap(items, workers, operation) {
  let next = 0;
  const results = new Array(items.length);
  await Promise.all(
    Array.from({ length: Math.min(workers, items.length) }, async () => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= items.length) return;
        results[index] = await operation(items[index], index);
      }
    }),
  );
  return results;
}

async function eventually(label, operation, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await operation();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

async function main() {
  console.log(
    `Interaction load verification: ${eventCount} events, concurrency ${concurrency}, `
    + `${replayCount} replays against ${baseUrl}`,
  );
  const before = (await request('/interactions/status')).payload;
  assert.equal(before.ready, true);
  const created = (
    await request('/sources', 'POST', {
      name: `${runId} interaction load source`,
      type: 'forwarder',
      enabled: true,
      requireToken: true,
      collectorId,
      workspacePath,
      owner: 'agent-interaction-load-verifier',
      tags: [runId, 'interaction-load'],
    })
  ).payload;
  assert.ok(created.source?.sourceId && created.token);
  const headers = sourceHeaders(created.source.sourceId, created.token);
  const fixtures = Array.from({ length: eventCount }, (_, index) => fixture(index));

  const started = performance.now();
  const accepted = await concurrentMap(fixtures, concurrency, async (event) => {
    const result = await request('/interactions/ingest', 'POST', event, headers);
    assert.equal(result.status, 202);
    assert.equal(result.payload.kafkaDurable, true);
    return result;
  });
  const elapsedMs = performance.now() - started;
  assert.equal(new Set(accepted.map(({ payload }) => payload.interactionId)).size, eventCount);

  const replays = await concurrentMap(
    fixtures.slice(0, replayCount),
    concurrency,
    async (event, index) => {
      const result = await request('/interactions/ingest', 'POST', event, headers);
      assert.deepEqual(result.payload, accepted[index].payload);
      return result;
    },
  );

  const firstConversationId = accepted[0].payload.conversationId;
  const projected = await eventually('all logical observations to project', async () => {
    const detail = (
      await request(`/conversations/${encodeURIComponent(firstConversationId)}`)
    ).payload;
    return detail?.observations?.length === eventCount ? detail : undefined;
  });
  assert.equal(projected.contentCapture, 'metadata_only');
  assert.equal(
    projected.observations.every(
      (item) =>
        item.capture.captureMode === 'metadata'
        && item.capture.rawRetentionState === 'not_retained'
        && item.transport.timingScope === 'unavailable',
    ),
    true,
  );

  const after = (await request('/interactions/status')).payload;
  assert.equal(after.backpressure.inFlightRequests, 0);
  assert.equal(after.backpressure.inFlightBytes, 0);
  assert.equal(after.accepted - before.accepted, eventCount);
  assert.equal(after.duplicates - before.duplicates, replayCount);
  assert.ok(after.projected - before.projected >= eventCount);
  assert.ok(after.projectionBatches - before.projectionBatches > 0);

  const receiptLatencies = accepted.map(({ durationMs }) => durationMs);
  const replayLatencies = replays.map(({ durationMs }) => durationMs);
  console.log(JSON.stringify({
    ok: true,
    runId,
    eventCount,
    concurrency,
    replayCount,
    elapsedMs: Math.round(elapsedMs),
    durableReceiptsPerSecond: Number((eventCount / (elapsedMs / 1_000)).toFixed(2)),
    receiptLatencyMs: {
      p50: Number(percentile(receiptLatencies, 0.5).toFixed(2)),
      p95: Number(percentile(receiptLatencies, 0.95).toFixed(2)),
      max: Number(Math.max(...receiptLatencies).toFixed(2)),
    },
    replayLatencyMs: {
      p95: Number(percentile(replayLatencies, 0.95).toFixed(2)),
    },
    projectionBatches: after.projectionBatches - before.projectionBatches,
    projectionDuplicates: after.projectionDuplicates - before.projectionDuplicates,
    projectionFailures: after.projectionFailures - before.projectionFailures,
  }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
