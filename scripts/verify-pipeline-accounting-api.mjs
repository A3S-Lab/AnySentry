#!/usr/bin/env node

import assert from 'node:assert/strict';
import { managementAuthHeaders, safeProbeId } from './probe-id.mjs';

const baseUrl = (process.env.ANYSENTRY_API_BASE ?? process.env.API_BASE ?? `http://127.0.0.1:${process.env.PORT ?? '29653'}/security-center`).replace(/\/$/u, '');
const runId = safeProbeId('pipeline');
const collectorId = `${runId}-collector`;

async function request(path, method = 'GET', body, headers = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...managementAuthHeaders(), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : undefined;
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}`);
  return parsed?.data ?? parsed;
}

function forwarderAccounting(sequence) {
  const startedAtUnixMs = Date.now() + sequence * 10;
  return {
    schemaVersion: 'anysentry.pipeline_accounting.v1',
    producer: 'forwarder',
    producerInstanceId: `${runId}:forwarder:instance`,
    sequence,
    window: { startedAtUnixMs, endedAtUnixMs: startedAtUnixMs + 10 },
    temporality: 'delta',
    unit: { input: 'logical_event', queue: 'logical_event' },
    stages: [
      { stage: 'received', count: 1, reasons: [{ reason: 'input', count: 1 }] },
      { stage: 'queue_admitted', count: 1, reasons: [{ reason: 'event', count: 1 }] },
    ],
    backlog: {
      queueEvents: sequence,
      queueBytes: sequence * 100,
      inflightEvents: 0,
      inflightBytes: 0,
      retryEvents: 0,
      retryBytes: 0,
      outstandingEvents: sequence,
      outstandingBytes: sequence * 100,
    },
  };
}

const created = await request('/sources', 'POST', {
  name: `${runId} observer forwarder`,
  type: 'observer',
  enabled: true,
  requireToken: true,
  collectorId,
  workspacePath: `repo://${runId}/pipeline-accounting`,
  owner: 'verify-pipeline-accounting',
  tags: [runId, 'pipeline-accounting-verifier'],
});
assert.ok(created.source?.sourceId && created.token, 'test Source must provide an ID and managed token');
const sourceId = created.source.sourceId;
const token = created.token;

const rawAccounting = {
  schemaVersion: 'anysentry.pipeline_accounting.v1',
  producer: 'observer',
  producerInstanceId: `${runId}:observer:instance`,
  sequence: 1,
  window: { startedAtUnixMs: Date.now() - 1_000, endedAtUnixMs: Date.now() },
  temporality: 'delta',
  unit: { ring: 'physical_record', queue: 'logical_event' },
  rings: [{
    ring: 'exec',
    ringSubmitted: 10,
    ringDropped: 1,
    collectorReceived: 9,
    logicalEvents: 8,
    queueAdmitted: 7,
    queueDropped: 1,
  }],
};
const rawLine = JSON.stringify({
  identity: {},
  event: {
    CollectorHeartbeat: {
      collector_id: collectorId,
      node_name: `${runId}-node`,
      mode: 'observe',
      status: 'ok',
      interval_secs: 30,
      attached_probes: 1,
      enabled_features: ['exec'],
      exec: 0,
      exit: 0,
      egress: 0,
      dns: 0,
      file: 0,
      llm: 0,
      ssl: 0,
      sec: 0,
      dropped: 0,
      output_dropped: 0,
      pipelineAccounting: rawAccounting,
    },
  },
});
const rawAck = await request('/ingest', 'POST', {
  line: rawLine,
  collectorId,
  nodeName: `${runId}-node`,
  sourceId,
  sourceType: 'observer',
  token,
  workspacePath: `repo://${runId}/pipeline-accounting`,
});
assert.equal(rawAck.accepted, true);
assert.equal(rawAck.kind, 'collector-heartbeat');

async function sendForwarder(sequence, failures = 0) {
  const ack = await request('/collectors/heartbeat', 'POST', {
    sourceId,
    token,
    sourceType: 'observer',
    collectorId,
    nodeName: `${runId}-node`,
    workspacePath: `repo://${runId}/pipeline-accounting`,
    mode: 'observer-forwarder:shadow',
    status: failures ? 'degraded' : 'ok',
    intervalSecs: 30,
    eventKindCounts: {},
    queueDepth: sequence,
    outputDropped: failures,
    errorCount: failures,
    legacyCounterTemporality: 'delta',
    pipelineAccounting: forwarderAccounting(sequence),
  });
  assert.equal(ack.accepted, true);
}

await sendForwarder(1);
await sendForwarder(2, 1);
await sendForwarder(3, 1);

const health = await request('/collectors/health', 'POST', {
  timeType: 'last_30d',
  collectorId,
  limit: 5,
});
assert.equal(health.total, 1);
const accounting = health.items?.[0]?.pipelineAccounting;
assert.equal(accounting?.reported, true, 'Judge-retained accounting must reach Collector health');
assert.equal(accounting?.window?.heartbeatCount, 4);
assert.equal(accounting?.window?.acceptedWindowCount, 4);
assert.equal(accounting?.window?.producerCount, 2);
assert.equal(accounting?.window?.restartCount, 0, 'Observer and Forwarder are concurrent producer lanes');
assert.equal(accounting?.window?.sequenceGapCount, 0);
assert.equal(accounting?.window?.ringSubmitted, 10);
assert.equal(accounting?.window?.ringDropped, 1);
assert.equal(accounting?.window?.logicalResidual, 0);
assert.equal(accounting?.window?.stageCountResidual, 0);
assert.equal(accounting?.window?.exact, true);
assert.equal(accounting?.latest?.producerInstanceId, `${runId}:forwarder:instance`);
assert.equal(accounting?.latest?.sequence, 3);
assert.equal(accounting?.latest?.backlog?.outstandingEvents, 3, 'health must expose the latest gauge, not a sum');

const alerts = await request('/alerts/list', 'POST', {
  timeType: 'last_30d',
  collectorId,
  kind: 'collector',
  status: 'all',
  limit: 10,
});
const quality = alerts.items?.find((item) =>
  item.ruleId === 'collector.quality' && item.labels?.heartbeatOrigin === 'forwarder');
assert.equal(quality?.status, 'open', 'equal adjacent Forwarder interval failures must not resolve the quality alert');
assert.equal(quality?.labels?.droppedDelta, '1');
assert.equal(quality?.labels?.errorDelta, '1');

console.log('Pipeline accounting API verification passed');
