#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.ANYSENTRY_INTERACTIONS = 'on';
process.env.ANYSENTRY_INTERACTION_MAX_INFLIGHT_REQUESTS = '8';
process.env.ANYSENTRY_INTERACTION_MAX_INFLIGHT_BYTES = String(2 * 1024 * 1024);

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {
  InteractionService,
  parseInteractionKafkaRecord,
} = require(path.join(
  root,
  'apps/api/dist/security-monitoring/interaction.service.js',
));

const content = '受控 Agent 指令：只返回 OK，不执行任何写操作。';
const contentBytes = Buffer.byteLength(content);
const contentSha256 = createHash('sha256').update(content).digest('hex');
const responseContent = 'OK';
const responseBytes = Buffer.byteLength(responseContent);
const responseSha256 = createHash('sha256').update(responseContent).digest('hex');
const sourceTurnId = 'content-service-turn-1';

function envelope(sourceEventId) {
  return {
    schemaVersion: 'anysentry.interaction-instruction.v1',
    eventType: 'AgentInputObserved',
    sourceEventId,
    collectorId: 'content-service-collector',
    observedAt: 1787901000000,
    agentInstanceId: 'content-service-agent',
    workspacePath: '/tmp/content-service',
    turn: { sourceTurnId, sequence: 1 },
    process: {
      hostId: 'content-service-host',
      bootId: 'content-service-boot',
      pid: 5151,
      startTimeTicks: '123456',
      comm: 'codex',
    },
    input: {
      protocol: 'native_stdio',
      inputScope: 'agent_process_stdin',
      fd: 0,
    },
    capture: {
      captureMethod: 'ebpf_stdin',
      captureProfile: 'isolated_fixture',
      captureMode: 'encrypted_full',
      captureCompleteness: 'complete',
      parseStatus: 'boundary_observed',
      rawRetentionState: 'encrypted',
      presentationState: 'redacted',
    },
    userInstruction: {
      eventType: 'UserInstructionObserved',
      messageRole: 'user',
      content,
      contentBytes,
      contentSha256,
    },
  };
}

function responseEnvelope(sourceEventId) {
  return {
    schemaVersion: 'anysentry.interaction-response.v1',
    eventType: 'AgentOutputObserved',
    sourceEventId,
    collectorId: 'content-service-collector',
    observedAt: 1787901000001,
    agentInstanceId: 'content-service-agent',
    workspacePath: '/tmp/content-service',
    turn: { sourceTurnId, sequence: 1 },
    process: {
      hostId: 'content-service-host',
      bootId: 'content-service-boot',
      pid: 5151,
      startTimeTicks: '123456',
      comm: 'codex',
    },
    output: {
      protocol: 'native_stdio',
      outputScope: 'agent_process_stdout',
      fd: 1,
    },
    capture: {
      captureMethod: 'ebpf_stdout',
      captureProfile: 'isolated_fixture',
      captureMode: 'encrypted_full',
      captureCompleteness: 'complete',
      parseStatus: 'boundary_observed',
      rawRetentionState: 'encrypted',
      presentationState: 'redacted',
    },
    assistantResponse: {
      eventType: 'AssistantResponseObserved',
      messageRole: 'assistant',
      content: responseContent,
      contentBytes: responseBytes,
      contentSha256: responseSha256,
    },
  };
}

function source() {
  return { sourceId: 'content-service-source', tenantId: 'tenant_default' };
}

function httpStatus(error) {
  return typeof error?.getStatus === 'function' ? error.getStatus() : undefined;
}

async function main() {
  const sequence = [];
  let reservation = { state: 'new', acceptedAt: 1787901000100 };
  const relational = {
    isReady: () => true,
    reserveInteractionReceipt: async () => {
      sequence.push('reserve');
      return reservation;
    },
    markInteractionReceiptAccepted: async () => {
      sequence.push('receipt-accepted');
      return true;
    },
    loadInteractionMetadata: async () => [],
  };
  let finalizeState = 'stored';
  const contents = {
    status: () => ({
      contentCaptureAllowed: true,
      contentCaptureMode: 'isolated_fixture_encrypted',
      contentStore: {
        enabled: true,
        fixtureMode: true,
        encryptionReady: true,
        backend: 'postgresql_encrypted',
        keyVersion: 'v1',
      },
      rawViewEnabled: true,
      rawViewAuthentication: 'management_plus_raw_capability',
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
    finalize: async (record, plaintext) => {
      sequence.push('content-finalize');
      assert.ok([content, responseContent].includes(plaintext));
      return finalizeState === 'conflict'
        ? { state: 'conflict' }
        : { state: finalizeState, record: { interactionId: record.interactionId } };
    },
    markAccepted: async () => {
      sequence.push('content-accepted');
    },
    availableInteractionIds: async () => new Set(),
    rawViewAuthorized: () => true,
    read: async () => null,
    delete: async () => 'not_found',
  };
  const clickhouse = {
    enabled: true,
    loadInteractionMetadata: async () => [],
  };
  const service = new InteractionService(relational, clickhouse, contents);
  service.ready = true;
  let kafkaRecord;
  service.producer = {
    send: async (request) => {
      sequence.push('kafka-ack');
      kafkaRecord = request.messages[0].value;
    },
  };

  const receipt = await service.ingestContent(
    envelope('content-service-event-1'),
    source(),
  );
  assert.deepEqual(sequence.slice(0, 3), ['reserve', 'content-finalize', 'kafka-ack']);
  assert.equal(receipt.contentDisposition, 'encrypted');
  assert.equal(receipt.contentStoreDurable, true);
  assert.equal(receipt.kafkaDurable, true);
  assert.ok(receipt.contentRef?.startsWith('blob_'));
  assert.equal(kafkaRecord.includes(content), false);
  const projected = parseInteractionKafkaRecord(Buffer.from(kafkaRecord));
  assert.equal(projected.eventType, 'AgentInputObserved');
  assert.equal(projected.userInstruction.contentSha256, contentSha256);
  assert.equal('content' in projected.userInstruction, false);
  console.log('PASS ContentStore finalize precedes Kafka durable ack and plaintext never enters Kafka');

  sequence.length = 0;
  reservation = { state: 'new', acceptedAt: 1787901000150 };
  finalizeState = 'stored';
  let responseKafkaRecord;
  service.producer = {
    send: async (request) => {
      sequence.push('kafka-ack');
      responseKafkaRecord = request.messages[0].value;
    },
  };
  const responseReceipt = await service.ingestContent(
    responseEnvelope('content-service-response-1'),
    source(),
  );
  const projectedResponse = parseInteractionKafkaRecord(Buffer.from(responseKafkaRecord));
  assert.equal(projectedResponse.eventType, 'AgentOutputObserved');
  assert.equal(projectedResponse.assistantResponse.messageRole, 'assistant');
  assert.equal(projectedResponse.assistantResponse.contentSha256, responseSha256);
  assert.equal('content' in projectedResponse.assistantResponse, false);
  assert.equal(projectedResponse.turnId, projected.turnId);
  assert.equal(responseReceipt.conversationId, receipt.conversationId);
  console.log('PASS user instruction and Agent response share one explicit stable Turn');

  sequence.length = 0;
  reservation = { state: 'pending', acceptedAt: 1787901000200 };
  finalizeState = 'duplicate';
  service.producer = {
    send: async () => {
      sequence.push('kafka-failed');
      throw new Error('fixture Kafka failure after ContentStore finalize');
    },
  };
  await assert.rejects(
    service.ingestContent(envelope('content-service-event-2'), source()),
    (error) => httpStatus(error) === 503,
  );
  assert.deepEqual(sequence, ['reserve', 'content-finalize', 'kafka-failed']);
  assert.equal(sequence.includes('receipt-accepted'), false);
  console.log('PASS Kafka failure after finalize cannot create a false Durable Receipt');

  sequence.length = 0;
  service.producer = {
    send: async () => {
      sequence.push('kafka-ack');
    },
  };
  const retry = await service.ingestContent(
    envelope('content-service-event-2'),
    source(),
  );
  assert.equal(retry.kafkaDurable, true);
  assert.deepEqual(sequence.slice(0, 3), ['reserve', 'content-finalize', 'kafka-ack']);
  console.log('PASS orphaned finalized content is reused on a stable retry');

  sequence.length = 0;
  reservation = { state: 'accepted', acceptedAt: 1787901000300 };
  service.producer = {
    send: async () => {
      throw new Error('accepted replay must not send Kafka again');
    },
  };
  const replay = await service.ingestContent(
    envelope('content-service-event-3'),
    source(),
  );
  assert.equal(replay.acceptedAt, 1787901000300);
  assert.deepEqual(sequence, ['reserve', 'content-finalize']);
  console.log('PASS lost HTTP response replay returns the stable accepted receipt');

  reservation = { state: 'new', acceptedAt: 1787901000400 };
  finalizeState = 'conflict';
  await assert.rejects(
    service.ingestContent(envelope('content-service-event-4'), source()),
    (error) => httpStatus(error) === 409,
  );
  console.log('PASS immutable content conflict is rejected before Kafka');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
