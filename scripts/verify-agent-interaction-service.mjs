#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.ANYSENTRY_INTERACTIONS = 'on';
process.env.ANYSENTRY_INTERACTION_MAX_INFLIGHT_REQUESTS = '1';
process.env.ANYSENTRY_INTERACTION_MAX_INFLIGHT_BYTES = String(64 * 1024);

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { InteractionService } = require(path.join(
  root,
  'apps/api/dist/security-monitoring/interaction.service.js',
));

function input(sourceEventId) {
  return {
    schemaVersion: 'anysentry.interaction-metadata.v1',
    eventType: 'LlmTransportObserved',
    sourceEventId,
    collectorId: 'unit-collector',
    observedAt: 1787800000000,
    process: {
      hostId: 'unit-host',
      bootId: 'unit-boot',
      pid: 4242,
      startTimeTicks: '1',
    },
    transport: {
      protocol: 'unknown',
      requestBytes: 64,
      responseBytes: 128,
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

function source() {
  return {
    sourceId: 'unit-source',
    tenantId: 'unit-tenant',
  };
}

async function eventually(label, fn) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = fn();
    if (value) return value;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function rejectionStatus(promise) {
  try {
    await promise;
  } catch (error) {
    return typeof error?.getStatus === 'function' ? error.getStatus() : undefined;
  }
  return undefined;
}

async function main() {
  let reservation = { state: 'new', acceptedAt: 1787800000100 };
  const relational = {
    isReady: () => true,
    reserveInteractionReceipt: async () => reservation,
    markInteractionReceiptAccepted: async () => true,
    loadInteractionMetadata: async () => [],
  };
  const clickhouse = {
    enabled: true,
    loadInteractionMetadata: async () => [],
  };
  const contents = {
    status: () => ({
      contentCaptureAllowed: false,
      contentCaptureMode: 'metadata_only',
      contentStore: {
        enabled: false,
        fixtureMode: false,
        encryptionReady: false,
        backend: 'postgresql_encrypted',
      },
      rawViewEnabled: false,
      rawViewAuthentication: 'disabled',
      counters: {
        finalized: 0,
        duplicates: 0,
        conflicts: 0,
        reads: 0,
        deleted: 0,
        orphanPurges: 0,
        failures: 0,
      },
    }),
  };
  const service = new InteractionService(relational, clickhouse, contents);
  service.ready = true;

  let releaseProducer;
  let producerCalls = 0;
  service.producer = {
    send: async () => {
      producerCalls += 1;
      await new Promise((resolve) => {
        releaseProducer = resolve;
      });
    },
  };
  const first = service.ingest(input('unit-event-1'), source());
  await eventually('first Kafka send', () => producerCalls === 1);
  assert.equal(
    await rejectionStatus(service.ingest(input('unit-event-2'), source())),
    503,
  );
  assert.equal(service.status().backpressure.inFlightRequests, 1);
  releaseProducer();
  const receipt = await first;
  assert.equal(receipt.kafkaDurable, true);
  assert.equal(receipt.contentStoreDurable, false);
  assert.equal(receipt.acceptedAt, 1787800000100);
  assert.equal(service.status().backpressure.inFlightRequests, 0);
  assert.equal(service.status().backpressure.inFlightBytes, 0);
  console.log('PASS durable-ack concurrency is bounded and fully released');

  service.producer = {
    send: async () => {
      throw new Error('fixture Kafka failure');
    },
  };
  assert.equal(
    await rejectionStatus(service.ingest(input('unit-event-3'), source())),
    503,
  );
  assert.equal(service.status().accepted, 1);
  assert.equal(service.status().backpressure.inFlightRequests, 0);
  console.log('PASS producer failure cannot create a false durable receipt');

  reservation = { state: 'conflict' };
  assert.equal(
    await rejectionStatus(service.ingest(input('unit-event-4'), source())),
    409,
  );
  console.log('PASS immutable-key conflict is surfaced as HTTP 409');

  reservation = { state: 'accepted', acceptedAt: 1787800000200 };
  producerCalls = 0;
  service.producer = {
    send: async () => {
      producerCalls += 1;
    },
  };
  const duplicate = await service.ingest(input('unit-event-5'), source());
  assert.equal(duplicate.kafkaDurable, true);
  assert.equal(duplicate.acceptedAt, 1787800000200);
  assert.equal(producerCalls, 0);
  assert.ok(service.status().duplicates >= 1);
  console.log('PASS accepted replay returns its stable receipt without another Kafka send');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
