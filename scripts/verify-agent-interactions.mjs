#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { managementAuthHeaders, safeProbeId } from './probe-id.mjs';

const require = createRequire(import.meta.url);
const { projectAgentConversations, projectConversationTimeline } = require(
  '../apps/api/dist/security-monitoring/agent-conversation.js',
);
const { parseObserverAgentInteraction } = require(
  '../apps/api/dist/security-monitoring/agent-interaction.js',
);
const { agentAssetIdForIdentityKey } = require(
  '../apps/api/dist/security-monitoring/agent-identity.js',
);

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

async function requestWithoutManagementToken(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : undefined;
  if (!response.ok) throw new Error(`POST ${path} -> ${response.status}: ${text}`);
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
      tlsAdapterId: 'openssl-ex',
      transportProtocol: 'http/1.1',
      wireTemplateId: 'openai-chat-completions',
      parseState: 'parsed',
      llmLikelihood: 'confirmed',
      schemaFingerprint: 'sf_' + digest('fixture-chat-schema').slice(0, 24),
      transportCompleteness: 'complete',
      wireCompleteness: 'complete',
      conversationCompleteness: 'complete',
      endpoint: 'api.fixture.invalid',
      method: 'POST',
      path: '/v1/chat/completions',
      statusCode: 200,
      model: 'fixture-model',
      traceId: digest(`${runId}\0trace`).slice(0, 32),
      runId: `${runId}-workflow-run`,
      sessionId: `${runId}-workflow-session`,
      invocationId: `${runId}-workflow-run`,
      providerConversationId: `${runId}-provider-conversation`,
      providerResponseId: `${runId}-provider-response`,
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
      usage: {
        source: 'provider_reported',
        completeness: 'complete',
        inputTokens: 120,
        outputTokens: 30,
        totalTokens: 150,
        cachedInputTokens: 40,
        reasoningOutputTokens: 12,
        totalTokensDerived: false,
      },
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
      semanticParserId: 'observer.agent-interaction',
      semanticParserVersion: 1,
      semanticItems: [{
        semanticItemId: `si_${digest(`${runId}\0semantic-user`).slice(0, 24)}`,
        actor: 'user',
        kind: 'user_message',
        phase: 'final',
        origin: 'request',
        atUnixNs: String(nowNs),
        content: 'FINAL_REQUEST_SENTINEL',
        sourceItemId: 'request.messages[0]',
        sequenceNumber: 0,
        completeness: 'complete',
        partialReasons: [],
      }, {
        semanticItemId: `si_${digest(`${runId}\0semantic-model`).slice(0, 24)}`,
        actor: 'model',
        kind: 'model_progress',
        phase: 'progress',
        origin: 'response',
        atUnixNs: String(nowNs + 2_000_000n),
        content: 'VISIBLE_RESPONSE_SENTINEL',
        sequenceNumber: 1,
        completeness: 'complete',
        partialReasons: [],
      }, {
        semanticItemId: `si_${digest(`${runId}\0semantic-tool-result`).slice(0, 24)}`,
        actor: 'tool',
        kind: 'tool_result',
        phase: 'final',
        origin: 'request',
        atUnixNs: String(nowNs + 1_000_000n),
        content: 'TOOL_RESULT_SENTINEL',
        toolCallId: 'call-fixture-1',
        toolName: 'bash',
        sequenceNumber: 2,
        completeness: 'complete',
        partialReasons: [],
      }, {
        semanticItemId: `si_${digest(`${runId}\0semantic-tool-call`).slice(0, 24)}`,
        actor: 'tool',
        kind: 'tool_call',
        phase: 'final',
        origin: 'response',
        atUnixNs: String(nowNs + 2_000_000n),
        content: { path: 'canary.txt' },
        toolCallId: 'call-fixture-2',
        toolName: 'read',
        sequenceNumber: 3,
        completeness: 'complete',
        partialReasons: [],
      }],
      completeness: 'complete',
      partialReasons: [],
      captureSource: 'tls_uprobe',
    },
  },
});

const sharedContainerId = 'f9896b781d94d050a6211e07248b69fb9576966f4b7ac7170045f5c1c2fa616b';
const sharedPhysicalWorkload = `docker:node-a:${sharedContainerId}`;
const legacyContainerAsset = agentAssetIdForIdentityKey(sharedPhysicalWorkload);
const processRootInteraction = parseObserverAgentInteraction(line, {
  workspacePath: '/root',
  agentId: 'codex',
  sessionId: '',
  userId: '',
  attributes: {},
  subjectAssetId: legacyContainerAsset,
  subjectAssetType: 'agent',
  classificationSemantics: {
    schemaVersion: 'anysentry.classification_semantics.v1',
    identityClassification: 'confirmed_agent',
    workloadRole: 'agent',
    captureProfile: 'agent_full',
  },
  process: {
    hostId: 'node-a',
    bootId: 'boot-a',
    pid: 4242,
    ppid: 1,
    startTimeTicks: '424200',
    comm: 'codex',
    exe: '/opt/codex/bin/codex',
    cwd: '/root',
    cgroup: `0::/system.slice/docker-${sharedContainerId}.scope`,
  },
  attribution: {
    monitored: true,
    classification: 'confirmed_agent',
    confidence: 1,
    source: 'docker',
    reason: 'authoritative_anchor',
    agentScopeId: 'codex',
    agentDisplayName: 'Codex',
    agentInstanceId: sharedPhysicalWorkload,
    physicalWorkloadId: sharedPhysicalWorkload,
    rootPid: 4242,
    rootStartTime: '424200',
    evidence: [
      'label:anysentry.io/workload-kind=agent',
      'runtime_signature:commExact=codex',
    ],
  },
});
assert.ok(processRootInteraction, 'strong process-root interaction must parse');
assert.notEqual(processRootInteraction.agentAssetId, legacyContainerAsset);
assert.match(processRootInteraction.agentInstanceId ?? '', /^host-root:/u);
assert.equal(processRootInteraction.agentProduct, 'codex');
assert.equal(processRootInteraction.semanticParserId, 'observer.agent-interaction');
assert.equal(processRootInteraction.semanticParserVersion, 1);
assert.equal(processRootInteraction.traceId, digest(`${runId}\0trace`).slice(0, 32));
assert.equal(processRootInteraction.runId, `${runId}-workflow-run`);
assert.equal(processRootInteraction.sessionId, `${runId}-workflow-session`);
assert.equal(processRootInteraction.invocationId, `${runId}-workflow-run`);
assert.deepEqual(
  processRootInteraction.semanticItems?.map((item) => [item.actor, item.kind]),
  [
    ['user', 'user_message'],
    ['model', 'model_progress'],
    ['tool', 'tool_result'],
    ['tool', 'tool_call'],
  ],
);
const transportSessionEnvelope = structuredClone(JSON.parse(line));
transportSessionEnvelope.event.LlmInteraction.interactionId = `mi_${digest(`${runId}\0transport-session`).slice(0, 24)}`;
delete transportSessionEnvelope.event.LlmInteraction.providerConversationId;
const transportSessionInteraction = parseObserverAgentInteraction(
  JSON.stringify(transportSessionEnvelope),
  {
    workspacePath: '/root',
    agentId: 'langgraph-workflow-sandbox-agent',
    sessionId: '',
    userId: '',
    attributes: {},
    classificationSemantics: {
      schemaVersion: 'anysentry.classification_semantics.v1',
      identityClassification: 'confirmed_agent',
      workloadRole: 'agent',
      captureProfile: 'agent_full',
    },
    process: processRootInteraction.process,
    attribution: {
      monitored: true,
      classification: 'confirmed_agent',
      confidence: 1,
      source: 'kubernetes',
      reason: 'workload_label',
      agentScopeId: 'langgraph-workflow-sandbox-agent',
      agentDisplayName: 'LangGraph',
      agentInstanceId: processRootInteraction.agentInstanceId,
      rootPid: 4242,
      rootStartTime: '424200',
      evidence: ['label:anysentry.io/workload-kind=agent'],
    },
  },
);
assert.equal(
  transportSessionInteraction?.providerConversationId,
  `${runId}-workflow-session`,
  'a trusted plaintext session header must become the product Conversation anchor',
);

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
assert.equal(item.traceId, digest(`${runId}\0trace`).slice(0, 32));
assert.equal(item.runId, `${runId}-workflow-run`);
assert.equal(item.sessionId, `${runId}-workflow-session`);
assert.equal(item.invocationId, `${runId}-workflow-run`);
assert.equal(item.transport, 'tls');
assert.equal(item.tlsAdapterId, 'openssl-ex');
assert.equal(item.transportProtocol, 'http/1.1');
assert.equal(item.wireTemplateId, 'openai-chat-completions');
assert.equal(item.parseState, 'parsed');
assert.equal(item.llmLikelihood, 'confirmed');
assert.equal(item.transportCompleteness, 'complete');
assert.equal(item.wireCompleteness, 'complete');
assert.equal(item.conversationCompleteness, 'complete');
assert.equal(item.request.body, requestBody);
assert.equal(item.response.text, 'VISIBLE_RESPONSE_SENTINEL');
assert.deepEqual(item.usage, {
  source: 'provider_reported',
  completeness: 'complete',
  inputTokens: 120,
  outputTokens: 30,
  totalTokens: 150,
  cachedInputTokens: 40,
  reasoningOutputTokens: 12,
  totalTokensDerived: false,
});
assert.equal(item.toolCalls[0].toolCallId, 'call-fixture-2');
assert.deepEqual(item.toolCalls[0].arguments, { path: 'canary.txt' });
assert.equal(item.toolResults[0].content, 'TOOL_RESULT_SENTINEL');
assert.equal(item.completeness, 'complete');
assert.equal(item.captureSource, 'tls_uprobe');
assert.ok(!JSON.stringify(item).includes('authorization'), 'transport credentials must not enter interaction content');
const usageEvent = await request('/events/list', 'POST', {
  timeType: 'last_30d',
  scope: 'raw',
  eventId: item.evidenceEventIds?.[0],
  limit: 10,
});
assert.equal(usageEvent.items[0]?.tokenCount, 150);
assert.equal(usageEvent.items[0]?.attributes?.['llm.usage.input_tokens'], 120);
assert.equal(usageEvent.items[0]?.attributes?.['llm.usage.output_tokens'], 30);

const noTokenInteraction = await requestWithoutManagementToken('/agents/interactions', {
  timeType: 'last_30d', scope: 'raw', interactionId, limit: 10,
});
assert.equal(noTokenInteraction.items.length, 1, 'read-only interaction content must not require a management token');

const directory = await requestWithoutManagementToken('/agents/conversation-directory', {
  timeType: 'last_30d',
  scope: 'agent',
  classificationView: 'current_effective',
  lifecycleScope: 'all',
});
assert(directory.items.some((entry) =>
  entry.agentAssetIds.includes(item.agentAssetId)
  && entry.conversations.some((candidate) => candidate.conversationId)),
  JSON.stringify(directory));

const conversations = await requestWithoutManagementToken('/agents/conversations', {
  timeType: 'last_30d',
  scope: 'agent',
  agentAssetId: item.agentAssetId,
  classificationView: 'current_effective',
  limit: 20,
});
const conversation = conversations.items.find((entry) => entry.hasContent);
assert.ok(conversation, JSON.stringify(conversations));
assert.equal(conversation.idSource, 'provider');
assert.equal(conversation.modelCallCount, 1);
assert.equal(conversation.toolCallCount, 1);
assert.equal(conversation.toolResultCount, 1);
assert.equal(conversation.usage.totalTokens, 150);
assert.equal(conversation.usage.inputTokens, 120);
assert.equal(conversation.usage.outputTokens, 30);
assert.equal(conversation.usage.tokenCoverage, 'complete');
assert.equal(conversation.usage.tokenReportedModelCallCount, 1);
assert.equal(conversation.instanceUsage.length, 1);
assert.equal(conversation.instanceUsage[0].totalTokens, 150);
assert.match(conversation.firstPromptPreview, /FINAL_REQUEST_SENTINEL/u);

const timeline = await requestWithoutManagementToken('/agents/conversations/timeline', {
  timeType: 'last_30d',
  scope: 'agent',
  agentAssetId: item.agentAssetId,
  conversationId: conversation.conversationId,
  classificationView: 'current_effective',
});
assert.equal(timeline.conversation.conversationId, conversation.conversationId);
assert.deepEqual(
  [...new Set(timeline.items.map((entry) => entry.kind))].sort(),
  ['error', 'model_request', 'model_response', 'tool_call', 'tool_result'],
);
assert.equal(timeline.interactionIds.includes(interactionId), true);
const semanticTimeline = await requestWithoutManagementToken('/agents/conversations/timeline-v2', {
  timeType: 'last_30d',
  scope: 'agent',
  classificationView: 'current_effective',
  agentAssetId: item.agentAssetId,
  conversationId: conversation.conversationId,
});
assert.equal(semanticTimeline.thread.conversationId, conversation.conversationId);
assert.deepEqual(
  [...new Set(semanticTimeline.turns.flatMap((turn) =>
    turn.events.map((event) => event.actor)))].sort(),
  ['model', 'tool', 'user'],
);
assert.equal(semanticTimeline.parserVersion, 2);

const directoryV3 = await requestWithoutManagementToken('/agents/conversation-directory-v3', {
  timeType: 'last_30d',
  scope: 'agent',
  classificationView: 'current_effective',
  lifecycleScope: 'all',
});
assert.equal(directoryV3.apiVersion, 3);
assert.ok(Number.isSafeInteger(directoryV3.resolutionRevision));
assert.ok(directoryV3.items.every((entry) =>
  entry.userThreads.every((thread) => thread.hasContent)),
  'the V3 user Thread directory must exclude asset-only placeholders');
const v3Owner = directoryV3.items.find((entry) =>
  entry.userThreads.some((thread) => thread.conversationId === conversation.conversationId));
assert.ok(v3Owner, JSON.stringify(directoryV3));
assert.equal(v3Owner.conversationCount, v3Owner.userThreads.length);
assert.ok(v3Owner.usage.totalTokens >= 150);
assert.ok(v3Owner.instanceUsage.some((usage) => usage.totalTokens >= 150));

const directoryV4 = await requestWithoutManagementToken('/agents/conversation-directory-v4', {
  timeType: 'last_30d',
  scope: 'agent',
  classificationView: 'current_effective',
  lifecycleScope: 'all',
});
assert.equal(directoryV4.apiVersion, 4);
assert.equal(directoryV4.resolutionRevision, directoryV3.resolutionRevision);
assert.ok(directoryV4.items.every((entry) => !Object.hasOwn(entry, 'conversations')),
  'the V4 read model must not duplicate user Threads under a legacy field');
assert.ok(directoryV4.items.every((entry) => entry.recentInstances.length <= 12));
assert.ok(directoryV4.items.every((entry) => entry.technicalActivities.length <= 32));
const v4Owner = directoryV4.items.find((entry) =>
  entry.userThreads.some((thread) => thread.conversationId === conversation.conversationId));
assert.ok(v4Owner, JSON.stringify(directoryV4));
assert.deepEqual(v4Owner.userThreads, v3Owner.userThreads);

const semanticTimelineV3 = await requestWithoutManagementToken('/agents/conversations/timeline-v3', {
  timeType: 'last_30d',
  scope: 'agent',
  classificationView: 'current_effective',
  agentAssetId: item.agentAssetId,
  conversationId: conversation.conversationId,
});
assert.equal(semanticTimelineV3.apiVersion, 3);
assert.equal(semanticTimelineV3.timelineVersion, 3);
assert.equal(semanticTimelineV3.canonicalConversationId, conversation.conversationId);
assert.equal(semanticTimelineV3.requestedConversationId, conversation.conversationId);
assert.match(semanticTimelineV3.requestKey, /^[a-f0-9]{32}$/u);
assert.deepEqual(semanticTimelineV3.contextReplaySummaries, []);
const timelineBurst = await Promise.all(Array.from({ length: 20 }, () =>
  requestWithoutManagementToken('/agents/conversations/timeline-v3', {
    timeType: 'last_30d',
    scope: 'agent',
    classificationView: 'current_effective',
    agentAssetId: item.agentAssetId,
    conversationId: conversation.conversationId,
  })));
assert.equal(new Set(timelineBurst.map((entry) => entry.requestKey)).size, 1,
  'identical concurrent Timeline reads must share one stable projection result');
const semanticToolEvent = semanticTimelineV3.turns
  .flatMap((turn) => turn.events)
  .find((event) => event.kind === 'tool_call');
assert.ok(semanticToolEvent, JSON.stringify(semanticTimelineV3));
const semanticEvidence = await requestWithoutManagementToken('/agents/semantic-events/evidence', {
  timeType: 'last_30d',
  scope: 'agent',
  classificationView: 'current_effective',
  conversationId: conversation.conversationId,
  semanticEventId: semanticToolEvent.semanticEventId,
});
assert.equal(semanticEvidence.schemaVersion, 'anysentry.agent_semantic_evidence.v1');
assert.equal(semanticEvidence.semanticEventId, semanticToolEvent.semanticEventId);
assert.match(semanticEvidence.toolInvocationId, /^ti_[a-f0-9]{24}$/u);
assert.ok(semanticEvidence.interactionEvidenceEventIds.length >= 1,
  'the TLS Interaction must retain its source JudgedEvent identity');
assert(['semantic_only', 'coverage_gap'].includes(semanticEvidence.relationStatus),
  JSON.stringify(semanticEvidence));

const modelOnly = await request('/agents/interactions', 'POST', {
  timeType: 'last_30d', scope: 'raw', interactionType: 'model', interactionId, limit: 10,
});
assert.equal(modelOnly.items.length, 1, 'interactionType=model must be filterable');
const toolOnly = await request('/agents/interactions', 'POST', {
  timeType: 'last_30d', scope: 'raw', interactionType: 'tool', interactionId, limit: 10,
});
assert.equal(toolOnly.items.length, 0, 'interactionType=tool must exclude model records');
const exactWithStaleIdentityHints = await request('/agents/interactions', 'POST', {
  timeType: 'last_30d',
  scope: 'raw',
  interactionId,
  agentAssetId: 'agent_stale_identity_hint',
  agentInstanceId: 'runtime-stale-identity-hint',
  limit: 10,
});
assert.equal(exactWithStaleIdentityHints.items[0]?.interactionId, interactionId,
  'the immutable interactionId must outrank stale asset and Runtime attribution hints');

const evidenceSuffix = digest(runId + '\0plaintext-evidence').slice(0, 24);
const evidenceId = 'pe_' + evidenceSuffix;
const evidenceInteractionId = 'mi_' + evidenceSuffix;
const evidenceEnvelope = {
  eventAtUnixNs: String(nowNs + 5_000_000n),
  receivedAtUnixNs: String(nowNs + 6_000_000n),
  identity: { agent: 'pi', task: '4242', session: null },
  process: { pid: 4242, ppid: 1, comm: 'pi', exe: '/usr/bin/node', cgroup_id: 77 },
  event: {
    AgentPlaintextEvidence: {
      schemaVersion: 'anysentry.agent_plaintext_evidence.v1',
      evidenceId,
      pid: 4242,
      connectionId: 'tls:evidence',
      direction: 'write',
      tlsAdapterId: 'openssl-ex',
      transportProtocol: 'http/2',
      parseState: 'unparsed',
      llmLikelihood: 'unknown',
      observedAtUnixNs: String(nowNs + 5_000_000n),
      capturedBytes: 24,
      encoding: 'metadata_only',
      sampleSha256: digest('http2-metadata-only'),
      reasons: ['transport_decoder_unavailable'],
      captureSource: 'tls_uprobe',
    },
  },
};
const evidenceIngest = await request('/ingest/batch', 'POST', {
  events: [{
    line: JSON.stringify(evidenceEnvelope),
    collectorId,
    sourceId: source.source.sourceId,
    token: source.token,
    workspacePath: 'repo://' + runId + '/workspace',
    classificationSemantics: {
      schemaVersion: 'anysentry.classification_semantics.v1',
      identityClassification: 'confirmed_agent',
      workloadRole: 'agent',
      captureProfile: 'agent_full',
    },
    attribution: {
      monitored: true,
      classification: 'confirmed_agent',
      agentScopeId: runId + '-agent',
      agentDisplayName: 'Pi interaction fixture',
      agentInstanceId: runId + '-instance',
      confidence: 1,
      reason: 'authoritative_anchor',
      source: 'self_register',
      evidence: ['verifier:confirmed-agent'],
    },
  }],
});
assert.equal(evidenceIngest.acceptedEvents, 1, JSON.stringify(evidenceIngest));
const unparsed = await requestWithoutManagementToken('/agents/interactions', {
  timeType: 'last_30d',
  scope: 'raw',
  interactionId: evidenceInteractionId,
  interactionType: 'unparsed',
  tlsAdapterId: 'openssl-ex',
  transportProtocol: 'http/2',
  parseState: 'unparsed',
  limit: 10,
});
assert.equal(unparsed.items.length, 1, JSON.stringify(unparsed));
assert.equal(unparsed.items[0].request.body, '');
assert.equal(unparsed.items[0].parseState, 'unparsed');
assert.equal(unparsed.items[0].transportProtocol, 'http/2');
assert.equal(unparsed.items[0].partialReasons.includes('unparsed_plaintext_evidence'), true);

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

// A Docker runtime id is physical workload evidence, not an application conversation id. One
// long-running HTTP Agent must split independent invocations while retaining the two model calls
// connected by a tool_call_id inside one invocation.
const containerId = 'f9896b781d94d050a6211e07248b69fb9576966f4b7ac7170045f5c1c2fa616b';
const projectionRecord = (id, at, prompt, overrides = {}) => {
  const record = structuredClone(item);
  Object.assign(record, {
    interactionId: `mi_${digest(`${runId}\0${id}`).slice(0, 24)}`,
    at,
    startedAtUnixNs: String(BigInt(at) * 1_000_000n),
    requestCompleteAtUnixNs: String(BigInt(at + 1) * 1_000_000n),
    firstResponseAtUnixNs: String(BigInt(at + 2) * 1_000_000n),
    endedAtUnixNs: String(BigInt(at + 3) * 1_000_000n),
    durationNs: '3000000',
    agentAssetId: 'agent_langchain_projection',
    agentInstanceId: `docker:node-a:${containerId}`,
    agentProduct: 'LangChain',
    runtimeSessionId: containerId.slice(0, 12),
    process: {
      hostId: 'node-a', bootId: 'boot-a', pid: 700, startTimeTicks: '7000',
      comm: 'python', exe: '/usr/bin/python3', cwd: '/srv/agent',
      cgroup: `0::/system.slice/docker-${containerId}.scope`,
    },
    request: {
      ...record.request,
      body: JSON.stringify({ messages: [{ role: 'user', content: prompt }] }),
      structured: { messages: [{ role: 'user', content: prompt }] },
      messages: [{ role: 'user', content: prompt }],
      sha256: digest(`request:${id}:${prompt}`),
    },
    response: {
      ...record.response,
      body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: `response:${id}` } }] }),
      text: `response:${id}`,
      structured: { choices: [{ message: { role: 'assistant', content: `response:${id}` } }] },
      sha256: digest(`response:${id}`),
    },
    toolCalls: [],
    toolResults: [],
    ...overrides,
  });
  for (const field of [
    'conversationId', 'conversationIdSource', 'turnId', 'modelCallId', 'attemptId',
    'providerConversationId', 'providerResponseId', 'providerPreviousResponseId',
  ]) if (!(field in overrides)) delete record[field];
  return record;
};
const projectionAt = Date.now() - 10_000;
const invokeOneCall = projectionRecord('invoke-one-call', projectionAt, 'LANGCHAIN_INVOKE_ONE', {
  toolCalls: [{
    toolCallId: 'call-projection-1', name: 'lookup_fixture', arguments: { key: 'canary' },
    issuedAtUnixNs: String(BigInt(projectionAt + 2) * 1_000_000n),
  }],
  completeness: 'partial',
  partialReasons: ['tool_result_pending'],
  conversationCompleteness: 'tool_pending',
});
const invokeOneFinal = projectionRecord('invoke-one-final', projectionAt + 5, 'LANGCHAIN_INVOKE_ONE', {
  toolResults: [{
    toolCallId: 'call-projection-1', content: 'LANGCHAIN_TOOL_RESULT', isError: false,
    observedAtUnixNs: String(BigInt(projectionAt + 5) * 1_000_000n),
  }],
});
const invokeTwo = projectionRecord('invoke-two', projectionAt + 10, 'LANGCHAIN_INVOKE_TWO');
const inferredProjection = projectAgentConversations(
  [invokeOneCall, invokeOneFinal, invokeTwo],
  [],
  { timeType: 'last_30d', scope: 'agent', limit: 20 },
);
assert.equal(inferredProjection.summaries.length, 2,
  'independent HTTP invocations in one container/process must not collapse into one conversation');
assert.deepEqual(
  inferredProjection.summaries.map((summary) => summary.modelCallCount).sort(),
  [1, 2],
);
const toolConversation = inferredProjection.summaries.find((summary) => summary.modelCallCount === 2);
assert.equal(toolConversation?.toolCallCount, 1);
assert.equal(toolConversation?.toolResultCount, 1);
assert.equal(toolConversation?.errorCount, 0);
assert.equal(toolConversation?.coverage.status, 'complete');
assert.deepEqual(toolConversation?.coverage.reasons, []);
const projectedTimeline = projectConversationTimeline(
  toolConversation,
  inferredProjection.interactionsByConversation.get(toolConversation.conversationId),
);
assert.deepEqual(
  projectedTimeline.map((event) => event.kind),
  ['model_request', 'model_response', 'tool_call', 'tool_result', 'model_request', 'model_response'],
  'Agent-facing order must show the tool result before it is sent in the next model request',
);

const responseRoot = projectionRecord('response-root', projectionAt + 20, 'CHAIN_ROOT', {
  providerResponseId: 'resp-projection-root',
});
const responseChild = projectionRecord('response-child', projectionAt + 30, 'CHAIN_CHILD', {
  providerResponseId: 'resp-projection-child',
  providerPreviousResponseId: 'resp-projection-root',
});
const providerProjection = projectAgentConversations(
  [responseRoot, responseChild],
  [],
  { timeType: 'last_30d', scope: 'agent', limit: 20 },
);
assert.equal(providerProjection.summaries.length, 1);
assert.equal(providerProjection.summaries[0].idSource, 'provider');
assert.equal(providerProjection.summaries[0].modelCallCount, 2);

console.log('Agent interaction ingest/query verification passed');
console.log(JSON.stringify({
  interactionId,
  dataSource: list.dataSource,
  requestBytes: item.request.decodedBytes,
  responseBytes: item.response.decodedBytes,
  toolCalls: item.toolCalls.length,
  toolResults: item.toolResults.length,
  conversationId: conversation.conversationId,
  conversationEvents: timeline.items.length,
  managementTokenRequiredForRead: false,
  multimodalBytes: Buffer.byteLength(multimodalBody),
}));
