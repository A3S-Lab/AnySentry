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
const { AggregationService } = require(
  '../apps/api/dist/security-monitoring/aggregation.service.js',
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
const interaction = ({
  id,
  at,
  instance,
  users,
  workspacePath = '/workspace/thread-fixture',
  conversationAnchors = [],
}) => ({
  schemaVersion: 'anysentry.agent_interaction.v1',
  interactionId: id,
  interactionType: 'model',
  at,
  workspacePath,
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
    cwd: workspacePath,
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
  conversationAnchors,
  completeness: 'complete',
  partialReasons: [],
  captureSource: 'tls_uprobe_rustls',
  receivedAt: at + 4,
});

const storedBindings = new Map();
const storedThreads = new Map();
const storedSegments = new Map();
const storedAnchors = [];
const storedMemberships = new Map();
let persistedV1Items = 0;
let persistedV2Items = 0;
const fakeStore = {
  configured: () => true,
  loadAgentConversationBindings: async (ids) => ids.flatMap((id) =>
    storedBindings.has(id) ? [structuredClone(storedBindings.get(id))] : []),
  loadAgentConversationThreads: async (scopes) => [...storedThreads.values()]
    .filter((thread) => scopes.includes(thread.logicalScopeKey))
    .map((thread) => structuredClone(thread)),
  loadAgentConversationThreadsByIds: async (ids) => [...storedThreads.values()]
    .filter((thread) => ids.includes(thread.conversationId))
    .map((thread) => structuredClone(thread)),
  loadAgentConversationSegments: async (conversationIds) => [...storedSegments.values()]
    .filter((segment) => conversationIds.includes(segment.conversationId))
    .map((segment) => structuredClone(segment)),
  loadAgentConversationMembershipsV2: async (ids) => ids.flatMap((id) =>
    storedMemberships.has(id) ? [structuredClone(storedMemberships.get(id))] : []),
  loadAgentConversationMembershipsByAnchors: async (anchors) => {
    const keys = new Set(anchors.map((anchor) => `${anchor.namespace}\0${anchor.valueHash}`));
    return storedAnchors.flatMap((stored) => {
      const membership = storedMemberships.get(stored.interactionId);
      return keys.has(`${stored.anchor.namespace}\0${stored.anchor.valueHash}`)
        && membership?.canonicalConversationId
        ? [{ anchor: structuredClone(stored), membership: structuredClone(membership) }]
        : [];
    });
  },
  saveAgentConversationResolution: async (threads, segments, bindings) => {
    persistedV1Items += threads.length + segments.length + bindings.length;
    for (const thread of threads) storedThreads.set(thread.conversationId, structuredClone(thread));
    for (const segment of segments) storedSegments.set(segment.segmentId, structuredClone(segment));
    for (const binding of bindings) storedBindings.set(binding.interactionId, structuredClone(binding));
    return true;
  },
  saveAgentConversationResolutionV2: async (anchors, memberships) => {
    persistedV2Items += anchors.length + memberships.length;
    for (const anchor of anchors) {
      const key = `${anchor.interactionId}\0${anchor.anchor.kind}\0${anchor.anchor.namespace}\0${anchor.anchor.valueHash}`;
      const index = storedAnchors.findIndex((item) =>
        `${item.interactionId}\0${item.anchor.kind}\0${item.anchor.namespace}\0${item.anchor.valueHash}` === key);
      if (index >= 0) storedAnchors[index] = structuredClone(anchor);
      else storedAnchors.push(structuredClone(anchor));
    }
    for (const membership of memberships) {
      const previous = storedMemberships.get(membership.interactionId);
      if (!previous || membership.resolutionRevision >= previous.resolutionRevision) {
        storedMemberships.set(membership.interactionId, structuredClone(membership));
      }
    }
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
const continuityAnchor = {
  kind: 'continuity_key',
  namespace: 'provider',
  valueHash: 'a'.repeat(64),
  strength: 'strong',
  sourcePath: 'fixture.continuity',
};
const first = interaction({
  id: 'mi_binding_first',
  at: 1_788_400_000_000,
  instance: 'host-root:thread:one',
  users: ['first'],
  conversationAnchors: [continuityAnchor],
});
const firstProjection = await resolveAndPersist(service, [first]);
const conversationId = firstProjection.projection.summaries[0].conversationId;
assert.ok(conversationId.startsWith('cv_'));
const persistedAfterFirstProjection = persistedV1Items + persistedV2Items;
await resolveAndPersist(service, [structuredClone(first)]);
assert.equal(persistedV1Items + persistedV2Items, persistedAfterFirstProjection,
  'an unchanged read-time projection must not write duplicate Conversation rows');

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

const firstStoredSegment = [...storedSegments.values()].find((segment) =>
  segment.conversationId === conversationId
  && segment.agentInstanceId === first.agentInstanceId);
assert.ok(firstStoredSegment);
storedSegments.set('seg_legacy_contained_subset', {
  ...structuredClone(firstStoredSegment),
  segmentId: 'seg_legacy_contained_subset',
  ordinal: 99,
  startedAtUnixNs: nextDay.startedAtUnixNs,
  firstInteractionId: nextDay.interactionId,
  interactionCount: 1,
  updatedAt: nextDay.receivedAt - 1,
});

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
assert.ok(!restartedService.segmentsForConversation(conversationId).some((segment) =>
  segment.segmentId === 'seg_legacy_contained_subset'),
  'a contained historical segment must not duplicate its complete Runtime segment');
assert.equal(storedBindings.size, 5);

const anchorRestartService = new AgentConversationBindingService(fakeStore);
const resumedFromAnchorOnly = interaction({
  id: 'mi_binding_anchor_only_resume',
  at: resumedAfterApiRestart.at + 25 * 60 * 60 * 1_000,
  instance: 'host-root:thread:five',
  workspacePath: 'agent://runtime-worker',
  users: ['first', 'next day', 'resumed', 'after restart', 'anchor-only resume'],
  conversationAnchors: [continuityAnchor],
});
const anchorProjection = await resolveAndPersist(anchorRestartService, [resumedFromAnchorOnly]);
assert.equal(anchorProjection.bound[0].conversationId, conversationId,
  'a persisted continuity Anchor must recover the canonical Thread without an old in-window Interaction');
assert.equal(anchorProjection.bound[0].workspacePath, '/workspace/thread-fixture',
  'a weak resumed workspace must inherit the Thread\'s remembered explicit workspace');
assert.equal(storedThreads.get(conversationId).workspacePath, '/workspace/thread-fixture',
  'a short-window projection must not downgrade persisted Thread workspace evidence');
assert.equal(anchorRestartService.segmentsForConversation(conversationId).length, 4);
assert.equal(storedBindings.size, 6);

let projectionComputations = 0;
const cacheAggregation = new AggregationService(
  { persistAgentInteraction: async () => true },
  {
    identitySnapshotVersion: () => 0,
    canonicalAgentAssetId: (value) => value,
  },
  {},
  {},
  {},
);
const cachedProjectionResult = {
  projection: { summaries: [], interactionsByConversation: new Map() },
  interactions: { items: [] },
  inventory: { items: [] },
};
cacheAggregation.computeAgentConversationProjection = async () => {
  projectionComputations += 1;
  return cachedProjectionResult;
};
const fixedProjectionQuery = {
  timeType: 'custom',
  startTime: new Date(first.at - 1_000).toISOString(),
  endTime: new Date(first.at + 1_000).toISOString(),
  snapshotAsOf: new Date(first.at + 1_000).toISOString(),
  scope: 'agent',
  classificationView: 'current_effective',
  limit: 100,
};
assert.strictEqual(
  await cacheAggregation.agentConversationProjection(fixedProjectionQuery),
  cachedProjectionResult,
);
assert.strictEqual(
  await cacheAggregation.agentConversationProjection(fixedProjectionQuery),
  cachedProjectionResult,
);
assert.equal(projectionComputations, 1,
  'unchanged directory/timeline reads must share one materialized projection');
await cacheAggregation.storeAgentInteraction(structuredClone(first));
await cacheAggregation.agentConversationProjection(fixedProjectionQuery);
assert.equal(projectionComputations, 2,
  'a newly stored Interaction must invalidate the projection cache immediately');

console.log('Agent Conversation durable Thread/Segment binding verification passed');
