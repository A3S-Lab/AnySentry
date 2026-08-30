#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AgentConversationBindingService } = require(
  '../apps/api/dist/security-monitoring/agent-conversation-binding.service.js',
);
const { projectAgentConversations } = require(
  '../apps/api/dist/security-monitoring/agent-conversation.js',
);

const digest = (value) => createHash('sha256').update(value).digest('hex');
const content = (body, messages = []) => ({
  body,
  encoding: 'utf8',
  contentType: 'application/json',
  capturedBytes: Buffer.byteLength(body),
  decodedBytes: Buffer.byteLength(body),
  sha256: digest(body),
  completeness: 'complete',
  messages,
});
const interaction = ({ id, at, instance, users }) => ({
  schemaVersion: 'anysentry.agent_interaction.v1',
  interactionId: id,
  interactionType: 'model',
  at,
  workspacePath: '/workspace/thread-fixture',
  agentAssetId: 'agent-thread-fixture',
  agentInstanceId: instance,
  agentProduct: 'Codex',
  detectedClassification: 'confirmed_agent',
  currentEffectiveClassification: 'confirmed_agent',
  process: {
    hostId: 'host-thread',
    bootId: 'boot-thread',
    pid: Number(instance.replace(/\D+/gu, '')) || 100,
    ppid: 1,
    startTimeTicks: String(at),
    comm: 'codex',
    exe: '/usr/bin/codex',
    cwd: '/workspace/thread-fixture',
  },
  connectionId: `tls:${id}`,
  transport: 'tls',
  protocol: 'http/1.1',
  wireTemplateId: 'openai-responses',
  parseState: 'parsed',
  llmLikelihood: 'confirmed',
  endpoint: 'gateway.invalid',
  method: 'POST',
  path: '/v1/responses',
  statusCode: 200,
  model: 'fixture-model',
  startedAtUnixNs: String(BigInt(at) * 1_000_000n),
  requestCompleteAtUnixNs: String(BigInt(at + 1) * 1_000_000n),
  firstResponseAtUnixNs: String(BigInt(at + 2) * 1_000_000n),
  endedAtUnixNs: String(BigInt(at + 3) * 1_000_000n),
  durationNs: '3000000',
  timeQuality: 'collector_calibrated',
  request: content(JSON.stringify(users), users.map((value) => ({ role: 'user', content: value }))),
  response: { ...content(`reply:${users.at(-1)}`), text: `reply:${users.at(-1)}` },
  toolCalls: [],
  toolResults: [],
  completeness: 'complete',
  partialReasons: [],
  captureSource: 'tls_uprobe_rustls',
  receivedAt: at + 4,
});

const storedBindings = new Map();
const storedThreads = new Map();
const storedSegments = new Map();
const fakeStore = {
  configured: () => true,
  loadAgentConversationBindings: async (ids) => ids.flatMap((id) =>
    storedBindings.has(id) ? [structuredClone(storedBindings.get(id))] : []),
  loadAgentConversationThreads: async (scopes) => [...storedThreads.values()]
    .filter((thread) => scopes.includes(thread.logicalScopeKey))
    .map((thread) => structuredClone(thread)),
  loadAgentConversationSegments: async (conversationIds) => [...storedSegments.values()]
    .filter((segment) => conversationIds.includes(segment.conversationId))
    .map((segment) => structuredClone(segment)),
  saveAgentConversationResolution: async (threads, segments, bindings) => {
    for (const thread of threads) storedThreads.set(thread.conversationId, structuredClone(thread));
    for (const segment of segments) storedSegments.set(segment.segmentId, structuredClone(segment));
    for (const binding of bindings) storedBindings.set(binding.interactionId, structuredClone(binding));
    return true;
  },
};

const query = { timeType: 'last_30d', scope: 'agent', limit: 100 };
const resolveAndPersist = async (service, records) => {
  const bound = await service.applyPersistedBindings(records);
  const projection = projectAgentConversations(bound, [], query);
  await service.persistProjection(projection);
  return { bound, projection };
};

const service = new AgentConversationBindingService(fakeStore);
const first = interaction({
  id: 'mi_binding_first',
  at: 1_788_400_000_000,
  instance: 'host-root:thread:one',
  users: ['first'],
});
const firstProjection = await resolveAndPersist(service, [first]);
const conversationId = firstProjection.projection.summaries[0].conversationId;
assert.ok(conversationId.startsWith('cv_'));

const nextDay = interaction({
  id: 'mi_binding_next_day',
  at: first.at + 25 * 60 * 60 * 1_000,
  instance: first.agentInstanceId,
  users: ['first', 'next day'],
});
const nextDayProjection = await resolveAndPersist(service, [nextDay]);
assert.equal(nextDayProjection.bound[0].conversationId, conversationId);
assert.equal(service.segmentsForConversation(conversationId).length, 1);
assert.equal(service.segmentsForConversation(conversationId)[0].interactionCount, 2,
  'long idle on one process must extend the same instance segment');

const resumed = interaction({
  id: 'mi_binding_resumed_process',
  at: nextDay.at + 1_000,
  instance: 'host-root:thread:two',
  users: ['first', 'next day', 'resumed'],
});
const resumedProjection = await resolveAndPersist(service, [resumed]);
assert.equal(resumedProjection.bound[0].conversationId, conversationId);
assert.equal(service.segmentsForConversation(conversationId).length, 2,
  'resume on a new root process must create a new segment in the same Thread');

const fresh = interaction({
  id: 'mi_binding_fresh_process',
  at: resumed.at + 1_000,
  instance: 'host-root:thread:three',
  users: ['first'],
});
const freshProjection = await resolveAndPersist(service, [fresh]);
assert.notEqual(freshProjection.projection.summaries[0].conversationId, conversationId,
  'an equal first prompt is insufficient evidence to merge a fresh process');

const restartedService = new AgentConversationBindingService(fakeStore);
const resumedAfterApiRestart = interaction({
  id: 'mi_binding_after_api_restart',
  at: resumed.at + 2_000,
  instance: 'host-root:thread:four',
  users: ['first', 'next day', 'resumed', 'after restart'],
});
const restartedProjection = await resolveAndPersist(restartedService, [resumedAfterApiRestart]);
assert.equal(restartedProjection.bound[0].conversationId, conversationId,
  'PostgreSQL Thread state must recover resume attribution after an API restart');
assert.equal(restartedService.segmentsForConversation(conversationId).length, 3);
assert.equal(storedBindings.size, 5);

console.log('Agent Conversation durable Thread/Segment binding verification passed');
