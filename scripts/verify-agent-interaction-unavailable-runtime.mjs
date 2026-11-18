#!/usr/bin/env node

import assert from 'node:assert/strict';
import { managementAuthHeaders, safeProbeId } from './probe-id.mjs';

const configuredBase = (
  process.env.ANYSENTRY_API_BASE
  ?? process.env.API_BASE
)?.trim();
if (!configuredBase) {
  throw new Error(
    'ANYSENTRY_API_BASE is required; the unavailable-runtime verifier never defaults to a production port',
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
const runId = safeProbeId('interaction-unavailable');
const collectorId = `${runId}-collector`;
const workspacePath = `repo://${runId}/workspace`;

async function rawRequest(path, method = 'GET', body, headers = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...managementAuthHeaders(),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : undefined;
  } catch {
    payload = text;
  }
  return { status: response.status, payload: payload?.data ?? payload, text };
}

async function request(path, method = 'GET', body, headers = {}) {
  const result = await rawRequest(path, method, body, headers);
  assert.ok(result.status >= 200 && result.status < 300, result.text);
  return result.payload;
}

async function main() {
  const status = await request('/interactions/status');
  assert.equal(status.enabled, true);
  assert.equal(status.ready, false);
  assert.equal(status.durability.state, 'unavailable');
  assert.equal(status.durableBoundary, 'kafka_ack');
  assert.ok(status.lastError);
  console.log('PASS unavailable Kafka keeps the interaction lane unready');

  const created = await request('/sources', 'POST', {
    name: `${runId} source`,
    type: 'forwarder',
    enabled: true,
    requireToken: true,
    collectorId,
    workspacePath,
    owner: 'interaction-unavailable-verifier',
    tags: [runId],
  });
  assert.ok(created.source?.sourceId && created.token);

  const ingest = await rawRequest('/interactions/ingest', 'POST', {
    schemaVersion: 'anysentry.interaction-metadata.v1',
    eventType: 'LlmTransportObserved',
    sourceEventId: `${runId}-event`,
    collectorId,
    observedAt: Date.now(),
    workspacePath,
    process: {
      hostId: `${runId}-host`,
      bootId: `${runId}-boot`,
      pid: 4242,
      startTimeTicks: '1',
    },
    transport: {
      protocol: 'unknown',
      requestBytes: 1,
      responseBytes: 0,
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
  }, {
    'x-anysentry-source-id': created.source.sourceId,
    'x-anysentry-ingest-token': created.token,
  });
  assert.equal(ingest.status, 503, ingest.text);
  assert.match(ingest.text, /disabled|durably connected/iu);
  console.log('PASS API refuses a false durable receipt while Kafka is unavailable');

  const finalStatus = await request('/interactions/status');
  assert.equal(finalStatus.accepted, 0);
  assert.equal(finalStatus.backpressure.inFlightRequests, 0);
  assert.equal(finalStatus.backpressure.inFlightBytes, 0);
  console.log('PASS failed durability leaves no accepted receipt or pending memory');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
