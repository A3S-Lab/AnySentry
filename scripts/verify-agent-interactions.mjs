#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { managementAuthHeaders, safeProbeId } from './probe-id.mjs';

const baseUrl = (process.env.ANYSENTRY_API_BASE
  ?? `http://127.0.0.1:${process.env.PORT ?? '29653'}/security-center`).replace(/\/$/u, '');
const runId = safeProbeId('interaction');

async function request(path, method = 'GET', body, headers = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...managementAuthHeaders(), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : undefined;
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}: ${text}`);
  return payload?.data ?? payload;
}

const digest = (value) => createHash('sha256').update(value).digest('hex');
const requestBody = JSON.stringify({
  model: 'fixture-model',
  messages: [
    { role: 'user', content: 'FINAL_REQUEST_SENTINEL' },
    { role: 'tool', tool_call_id: 'call-fixture-1', content: 'TOOL_RESULT_SENTINEL' },
  ],
});
const responseBody = JSON.stringify({
  choices: [{
    message: {
      role: 'assistant',
      content: 'VISIBLE_RESPONSE_SENTINEL',
      tool_calls: [{
        id: 'call-fixture-2',
        type: 'function',
        function: { name: 'read', arguments: '{"path":"canary.txt"}' },
      }],
    },
  }],
});
const content = (body, extra = {}) => ({
  body,
  encoding: 'utf8',
  contentType: 'application/json',
  capturedBytes: Buffer.byteLength(body),
  decodedBytes: Buffer.byteLength(body),
  sha256: digest(body),
  completeness: 'complete',
  structured: JSON.parse(body),
  ...extra,
});
const nowNs = BigInt(Date.now()) * 1_000_000n;
const interactionId = `mi_${digest(`${runId}\0interaction`).slice(0, 24)}`;
const collectorId = `${runId}-collector`;

const source = await request('/sources', 'POST', {
  name: `${runId} interaction observer`,
  type: 'observer',
  enabled: true,
  requireToken: true,
  collectorId,
  workspacePath: `repo://${runId}/workspace`,
  owner: 'verify-agent-interactions',
  tags: [runId, 'interaction-verifier'],
});
assert.ok(source.source?.sourceId && source.token, 'managed Observer Source token is required');

const line = JSON.stringify({
  eventAtUnixNs: String(nowNs + 3_000_000n),
  receivedAtUnixNs: String(nowNs + 4_000_000n),
  identity: { agent: 'pi', task: '4242', session: null },
  process: { pid: 4242, ppid: 1, comm: 'pi', exe: '/usr/bin/node', cgroup_id: 77 },
  event: {
    LlmInteraction: {
      schemaVersion: 'anysentry.agent_interaction.v1',
      interactionId,
      interactionType: 'model',
      pid: 4242,
      connectionId: 'tls:feedbeef',
      transport: 'tls',
      protocol: 'http/1.1',
      endpoint: 'api.fixture.invalid',
      method: 'POST',
      path: '/v1/chat/completions',
      statusCode: 200,
      model: 'fixture-model',
      startedAtUnixNs: String(nowNs),
      requestCompleteAtUnixNs: String(nowNs + 1_000_000n),
      firstResponseAtUnixNs: String(nowNs + 2_000_000n),
      endedAtUnixNs: String(nowNs + 3_000_000n),
      durationNs: '3000000',
      timeQuality: 'collector_calibrated',
      request: content(requestBody, {
        messages: [
          { role: 'user', content: 'FINAL_REQUEST_SENTINEL' },
          { role: 'tool', content: 'TOOL_RESULT_SENTINEL', toolCallId: 'call-fixture-1' },
        ],
      }),
      response: content(responseBody, { text: 'VISIBLE_RESPONSE_SENTINEL' }),
      toolCalls: [{
        toolCallId: 'call-fixture-2',
        name: 'read',
        arguments: { path: 'canary.txt' },
        issuedAtUnixNs: String(nowNs + 2_000_000n),
      }],
      toolResults: [{
        toolCallId: 'call-fixture-1',
        name: 'bash',
        content: 'TOOL_RESULT_SENTINEL',
        isError: false,
        observedAtUnixNs: String(nowNs + 1_000_000n),
      }],
      completeness: 'complete',
      partialReasons: [],
      captureSource: 'tls_uprobe',
    },
  },
});

const ingest = await request('/ingest/batch', 'POST', {
  events: [{
    line,
    collectorId,
    sourceId: source.source.sourceId,
    token: source.token,
    workspacePath: `repo://${runId}/workspace`,
    classificationSemantics: {
      schemaVersion: 'anysentry.classification_semantics.v1',
      identityClassification: 'confirmed_agent',
      workloadRole: 'agent',
      captureProfile: 'agent_full',
    },
    attribution: {
      monitored: true,
      classification: 'confirmed_agent',
      agentScopeId: `${runId}-agent`,
      agentDisplayName: 'Pi interaction fixture',
      agentInstanceId: `${runId}-instance`,
      confidence: 1,
      reason: 'authoritative_anchor',
      source: 'self_register',
      evidence: ['verifier:confirmed-agent'],
    },
  }],
});
assert.equal(ingest.acceptedEvents, 1, JSON.stringify(ingest));

let list;
const deadline = Date.now() + 5_000;
do {
  list = await request('/agents/interactions', 'POST', {
    timeType: 'last_30d',
    scope: 'raw',
    interactionId,
    limit: 10,
  });
  if (list.items?.length) break;
  await new Promise((resolve) => setTimeout(resolve, 100));
} while (Date.now() < deadline);

assert.equal(list.items?.length, 1, JSON.stringify(list));
const item = list.items[0];
assert.equal(item.interactionId, interactionId);
assert.equal(item.interactionType, 'model');
assert.equal(item.transport, 'tls');
assert.equal(item.request.body, requestBody);
assert.equal(item.response.text, 'VISIBLE_RESPONSE_SENTINEL');
assert.equal(item.toolCalls[0].toolCallId, 'call-fixture-2');
assert.deepEqual(item.toolCalls[0].arguments, { path: 'canary.txt' });
assert.equal(item.toolResults[0].content, 'TOOL_RESULT_SENTINEL');
assert.equal(item.completeness, 'complete');
assert.equal(item.captureSource, 'tls_uprobe');
assert.ok(!JSON.stringify(item).includes('authorization'), 'transport credentials must not enter interaction content');

const modelOnly = await request('/agents/interactions', 'POST', {
  timeType: 'last_30d', scope: 'raw', interactionType: 'model', interactionId, limit: 10,
});
assert.equal(modelOnly.items.length, 1, 'interactionType=model must be filterable');
const toolOnly = await request('/agents/interactions', 'POST', {
  timeType: 'last_30d', scope: 'raw', interactionType: 'tool', interactionId, limit: 10,
});
assert.equal(toolOnly.items.length, 0, 'interactionType=tool must exclude model records');

// A final inline image is transport evidence, not an internal RAG artifact. This payload makes
// the observer envelope larger than the former 4 MiB ingress ceiling and verifies that the raw
// body remains available while oversized duplicate `structured` convenience data is omitted.
const multimodalId = `mi_${digest(`${runId}\0multimodal`).slice(0, 24)}`;
const multimodalBody = JSON.stringify({
  model: 'fixture-multimodal-model',
  messages: [{
    role: 'user',
    content: [
      { type: 'text', text: 'inspect the final image' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(2 * 1024 * 1024)}` } },
    ],
  }],
});
const multimodalEnvelope = JSON.parse(line);
multimodalEnvelope.event.LlmInteraction.interactionId = multimodalId;
multimodalEnvelope.event.LlmInteraction.model = 'fixture-multimodal-model';
multimodalEnvelope.event.LlmInteraction.request = content(multimodalBody);
multimodalEnvelope.event.LlmInteraction.toolCalls = [];
multimodalEnvelope.event.LlmInteraction.toolResults = [];
const multimodalLine = JSON.stringify(multimodalEnvelope);
assert(Buffer.byteLength(multimodalLine) > 4 * 1024 * 1024, 'multimodal envelope must exercise the raised ingress bound');
const multimodalIngest = await request('/ingest/batch', 'POST', {
  events: [{
    line: multimodalLine,
    collectorId,
    sourceId: source.source.sourceId,
    token: source.token,
    workspacePath: `repo://${runId}/workspace`,
    classificationSemantics: {
      schemaVersion: 'anysentry.classification_semantics.v1',
      identityClassification: 'confirmed_agent',
      workloadRole: 'agent',
      captureProfile: 'agent_full',
    },
  }],
});
assert.equal(multimodalIngest.acceptedEvents, 1, JSON.stringify(multimodalIngest));
const multimodal = await request('/agents/interactions', 'POST', {
  timeType: 'last_30d', scope: 'raw', interactionId: multimodalId, limit: 10,
});
assert.equal(multimodal.items.length, 1);
assert.equal(multimodal.items[0].request.body, multimodalBody);
assert.equal(multimodal.items[0].request.structured, undefined);
assert(multimodal.items[0].request.body.includes('data:image/png;base64,'));

const tamperedId = `mi_${digest(`${runId}\0tampered`).slice(0, 24)}`;
const tamperedEnvelope = JSON.parse(line);
tamperedEnvelope.event.LlmInteraction.interactionId = tamperedId;
tamperedEnvelope.event.LlmInteraction.request.sha256 = '0'.repeat(64);
await request('/ingest/batch', 'POST', {
  events: [{
    line: JSON.stringify(tamperedEnvelope),
    collectorId,
    sourceId: source.source.sourceId,
    token: source.token,
    workspacePath: `repo://${runId}/workspace`,
    classificationSemantics: {
      schemaVersion: 'anysentry.classification_semantics.v1',
      identityClassification: 'confirmed_agent',
      workloadRole: 'agent',
      captureProfile: 'agent_full',
    },
  }],
});
const tampered = await request('/agents/interactions', 'POST', {
  timeType: 'last_30d', scope: 'raw', interactionId: tamperedId, limit: 10,
});
assert.equal(tampered.items.length, 0, 'content whose declared hash does not match its body must fail closed');

const unknownId = `mi_${digest(`${runId}\0unknown`).slice(0, 24)}`;
const unknownEnvelope = JSON.parse(line);
unknownEnvelope.event.LlmInteraction.interactionId = unknownId;
await request('/ingest/batch', 'POST', {
  events: [{
    line: JSON.stringify(unknownEnvelope),
    collectorId,
    sourceId: source.source.sourceId,
    token: source.token,
    workspacePath: `repo://${runId}/workspace`,
    classificationSemantics: {
      schemaVersion: 'anysentry.classification_semantics.v1',
      identityClassification: 'unknown',
      workloadRole: 'unknown',
      captureProfile: 'unknown_discovery',
    },
  }],
});
const unknown = await request('/agents/interactions', 'POST', {
  timeType: 'last_30d', scope: 'raw', interactionId: unknownId, limit: 10,
});
assert.equal(unknown.items.length, 0, 'unknown/non-Agent plaintext must never enter the interaction store');

console.log('Agent interaction ingest/query verification passed');
console.log(JSON.stringify({
  interactionId,
  dataSource: list.dataSource,
  requestBytes: item.request.decodedBytes,
  responseBytes: item.response.decodedBytes,
  toolCalls: item.toolCalls.length,
  toolResults: item.toolResults.length,
  multimodalBytes: Buffer.byteLength(multimodalBody),
}));
