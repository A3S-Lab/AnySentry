#!/usr/bin/env node

import assert from 'node:assert/strict';
import { managementAuthHeaders, safeProbeId } from './probe-id.mjs';

const configuredBase = (
  process.env.ANYSENTRY_API_BASE
  ?? process.env.API_BASE
)?.trim();
if (!configuredBase) {
  throw new Error(
    'ANYSENTRY_API_BASE is required; the runtime verifier never defaults to a production port',
  );
}
const baseUrl = configuredBase.replace(/\/$/u, '');
if (
  new URL(baseUrl).port === '29653'
  && process.env.ANYSENTRY_ALLOW_PRODUCTION_INTERACTION_VERIFY
    !== 'I_UNDERSTAND_THIS_WRITES_TEST_DATA'
) {
  throw new Error('refusing to run a mutating interaction verifier against port 29653');
}
const runId = safeProbeId('interaction');
const collectorId = `${runId}-collector`;
const workspacePath = `repo://${runId}/workspace`;

function pass(message) {
  console.log(`PASS ${message}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestRaw(path, method = 'GET', body, headers = {}) {
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
  };
}

async function request(path, method = 'GET', body, headers = {}) {
  const result = await requestRaw(path, method, body, headers);
  assert.ok(
    result.status >= 200 && result.status < 300,
    `${method} ${path} -> ${result.status}: ${result.raw}`,
  );
  return result.payload;
}

async function eventually(label, fn, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

function sourceHeaders(sourceId, token) {
  return {
    'x-anysentry-source-id': sourceId,
    'x-anysentry-ingest-token': token,
  };
}

function fixture(sourceEventId) {
  return {
    schemaVersion: 'anysentry.interaction-metadata.v1',
    eventType: 'LlmTransportObserved',
    sourceEventId,
    collectorId,
    observedAt: Date.now(),
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
      requestBytes: 512,
      responseBytes: 2048,
      timingScope: 'connection',
      latencyAvailability: 'available',
      latencyMs: 87,
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

async function main() {
  console.log(`AnySentry interaction runtime verification against ${baseUrl}`);
  const initialStatus = await request('/interactions/status');
  assert.equal(initialStatus.enabled, true);
  assert.equal(initialStatus.ready, true);
  assert.equal(initialStatus.captureMode, 'metadata');
  assert.equal(initialStatus.contentCaptureAllowed, false);
  assert.equal(initialStatus.rawViewEnabled, false);
  assert.equal(initialStatus.durableBoundary, 'kafka_ack');
  assert.equal(initialStatus.durability.state, 'ready');
  assert.equal(initialStatus.projection.state, 'ready');
  assert.deepEqual(initialStatus.projection.failingPartitions, []);
  assert.equal(initialStatus.backpressure.inFlightRequests, 0);
  pass('interaction lane is ready and fail-closed for content');

  const created = await request('/sources', 'POST', {
    name: `${runId} interaction source`,
    type: 'forwarder',
    enabled: true,
    requireToken: true,
    collectorId,
    workspacePath,
    owner: 'agent-interaction-runtime-verifier',
    tags: [runId, 'interaction-runtime'],
    correlationClaims: {
      enabled: true,
      authority: 'observer_runtime',
      bindings: {
        collectorIds: [collectorId],
        workspacePaths: [workspacePath],
      },
    },
  });
  assert.ok(created.source?.sourceId);
  assert.ok(created.token);
  const sourceId = created.source.sourceId;
  const headers = sourceHeaders(sourceId, created.token);
  pass('protected forwarder Source and scoped token created');

  const event = fixture(`${runId}-event-1`);
  const unauthenticated = await requestRaw('/interactions/ingest', 'POST', event);
  assert.equal(unauthenticated.status, 401);
  pass('metadata ingestion rejects missing Source token');

  const first = await request('/interactions/ingest', 'POST', event, headers);
  assert.equal(first.accepted, true);
  assert.equal(first.kafkaDurable, true);
  assert.equal(first.projectionStatus, 'pending');
  assert.equal(first.contentDisposition, 'metadata_only');
  assert.equal(first.sourceEventId, event.sourceEventId);
  pass('first observation returns Kafka durable receipt');

  const learnedWorkspacePath = `agent://${runId}-latest-runtime`;
  const checkIn = await request('/sources/check-in', 'POST', {
    sourceId,
    sourceType: 'forwarder',
    collectorId,
    workspacePath: learnedWorkspacePath,
    status: 'ok',
  }, headers);
  assert.equal(checkIn.accepted, true);
  const driftedSourceState = await request('/sources/list', 'POST', { sourceId, limit: 5 });
  assert.equal(driftedSourceState.items?.[0]?.workspacePath, learnedWorkspacePath);
  pass('runtime check-in may update learned Source display identity');

  const replay = await request('/interactions/ingest', 'POST', event, headers);
  assert.deepEqual(replay, first);
  pass('identical retry survives learned Source workspace drift');

  const sourceState = await request('/sources/list', 'POST', { sourceId, limit: 5 });
  assert.equal(sourceState.total, 1);
  assert.ok(sourceState.items?.[0]?.acceptedEvents >= 2);
  assert.equal(sourceState.items?.[0]?.lastResult, 'accepted');
  pass('durably accepted Interaction deliveries update their protected Source activity');

  const conflicting = structuredClone(event);
  conflicting.transport.requestBytes += 1;
  const conflict = await requestRaw('/interactions/ingest', 'POST', conflicting, headers);
  assert.equal(conflict.status, 409, conflict.raw);
  pass('same immutable key with different metadata is rejected before Kafka');

  const outOfScope = {
    ...fixture(`${runId}-event-out-of-scope`),
    workspacePath: `repo://${runId}/other-workspace`,
  };
  const outOfScopeResult = await requestRaw(
    '/interactions/ingest',
    'POST',
    outOfScope,
    headers,
  );
  assert.equal(outOfScopeResult.status, 401, outOfScopeResult.raw);
  pass('configured correlation bindings reject an out-of-scope workspace');

  const forbidden = {
    ...fixture(`${runId}-event-forbidden`),
    prompt: 'THIS_SENTINEL_MUST_NEVER_BE_ACCEPTED',
  };
  const forbiddenResult = await requestRaw('/interactions/ingest', 'POST', forbidden, headers);
  assert.equal(forbiddenResult.status, 400, forbiddenResult.raw);
  pass('metadata-only schema rejects content-bearing fields');

  const content = await requestRaw(
    `/interactions/${encodeURIComponent(first.interactionId)}/content`,
  );
  assert.equal(content.status, 403, content.raw);
  pass('raw content route remains fail-closed even for management auth');

  const projected = await eventually('PostgreSQL and ClickHouse projection', async () => {
    const list = await request(
      `/conversations?collectorId=${encodeURIComponent(collectorId)}&limit=20`,
    );
    const item = list.items?.find(
      (candidate) => candidate.conversationId === first.conversationId,
    );
    return item ? { list, item } : undefined;
  });
  assert.equal(projected.list.contentCapture, 'metadata_only');
  assert.equal(projected.list.queryCompleteness, 'projected');
  assert.equal(projected.item.transportObservations, 1);
  assert.equal(projected.item.requestBytes, event.transport.requestBytes);
  assert.equal(projected.item.responseBytes, event.transport.responseBytes);
  assert.equal(projected.item.contentAvailable, false);
  pass('projected conversation contains one logical metadata observation after replay');

  const detail = await request(
    `/conversations/${encodeURIComponent(first.conversationId)}`,
  );
  assert.equal(detail.observations.length, 1);
  assert.equal(detail.observations[0].interactionId, first.interactionId);
  assert.equal(detail.observations[0].capture.captureMode, 'metadata');
  assert.equal(detail.observations[0].transport.timingScope, 'connection');
  assert.equal(detail.observations[0].transport.ttftAvailability, 'unavailable');
  assert.equal(detail.contentCapture, 'metadata_only');
  assert.equal(
    JSON.stringify(detail).includes('THIS_SENTINEL_MUST_NEVER_BE_ACCEPTED'),
    false,
  );
  pass('detail remains metadata-only and labels HTTP/2 timing as connection-level');

  const finalStatus = await request('/interactions/status');
  assert.equal(finalStatus.backpressure.inFlightRequests, 0);
  assert.equal(finalStatus.backpressure.inFlightBytes, 0);
  assert.ok(finalStatus.accepted >= 1);
  assert.ok(finalStatus.duplicates >= 1);
  assert.ok(finalStatus.rejected >= 2);
  assert.ok(finalStatus.projected >= 1);
  pass('counters expose accepted, duplicate, rejected, projected, and drained backpressure');

  console.log(JSON.stringify({
    ok: true,
    runId,
    sourceId,
    interactionId: first.interactionId,
    conversationId: first.conversationId,
  }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
