#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const {
  AgentConversationBindingService,
  conversationLogicalScopeKey,
  threadAcceptsUnboundRecord,
  trafficRoleForEvent,
} = require(
  '../apps/api/dist/security-monitoring/agent-conversation-binding.service.js',
);
const { conversationLogicalScopeKeyV2 } = require(
  '../apps/api/dist/security-monitoring/agent-conversation-resolution-v2.js',
);
const { projectAgentConversations } = require(
  '../apps/api/dist/security-monitoring/agent-conversation.js',
);
const { AggregationService } = require(
  '../apps/api/dist/security-monitoring/aggregation.service.js',
);
const { RelationalBusinessStore } = require(
  '../apps/api/dist/security-monitoring/relational-business-store.service.js',
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
  loadAgentConversationInteractionIds: async (id, limit = 5_000) => {
    const ids = [...new Set([
      ...[...storedMemberships.values()]
        .filter((membership) => membership.canonicalConversationId === id)
        .map((membership) => membership.interactionId),
      ...[...storedBindings.values()]
        .filter((binding) => binding.conversationId === id)
        .map((binding) => binding.interactionId),
    ])].sort();
    return { interactionIds: ids.slice(0, limit), truncated: ids.length > limit };
  },
  loadAgentConversationMembershipsByAnchors: async (anchors, logicalScopeKeys = []) => {
    const keys = new Set(anchors.map((anchor) => `${anchor.namespace}\0${anchor.valueHash}`));
    const scopes = new Set(logicalScopeKeys);
    return storedAnchors.flatMap((stored) => {
      const membership = storedMemberships.get(stored.interactionId);
      return keys.has(`${stored.anchor.namespace}\0${stored.anchor.valueHash}`)
        && (scopes.size === 0 || scopes.has(stored.logicalScopeKey))
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
// Keep the synthetic timeline inside the binding hot-state TTL even when this verifier is run
// days after it was authored. The 25-hour gap below is intentional; a stale absolute timestamp
// would be pruned before the continuation assertion and make the test depend on the calendar.
const fixtureNow = Date.now();
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
  at: fixtureNow - 2 * 60 * 60 * 1_000,
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
const persistedMembership = await anchorRestartService.interactionIdsForConversation(conversationId);
assert.equal(persistedMembership.durable, true);
assert.equal(persistedMembership.truncated, false);
assert.deepEqual(new Set(persistedMembership.interactionIds), new Set([
  first.interactionId,
  nextDay.interactionId,
  resumed.interactionId,
  resumedAfterApiRestart.interactionId,
  resumedFromAnchorOnly.interactionId,
]));

// A shared provider/continuity hash is not a LogicalAgent identity.  Persisted anchor lookup must
// retain the candidate row but refuse a Thread whose definition fingerprint differs.
const scopeAnchor = { ...continuityAnchor, valueHash: 'b'.repeat(64), strength: 'exact' };
const scopeRecord = {
  ...interaction({
    id: 'mi_binding_scope_mismatch',
    at: resumedFromAnchorOnly.at + 1_000,
    instance: 'host-root:scope-a',
    workspacePath: '/workspace/scope-a',
    users: ['scope mismatch'],
    conversationAnchors: [scopeAnchor],
  }),
  tenantId: 'tenant-scope',
  logicalAgentId: 'logical-scope-a',
  logicalDefinitionFingerprint: 'definition-scope-a',
  logicalScopeMode: 'registered_definition',
  logicalIdentityAuthority: 'management_registration',
};
const wrongDefinitionThread = {
  ...structuredClone(storedThreads.get(conversationId)),
  conversationId: 'cv_scope_wrong_definition',
  logicalScopeKey: conversationLogicalScopeKey(scopeRecord),
  logicalAgentId: 'logical-scope-a',
  definitionFingerprint: 'definition-scope-b',
  logicalScopeMode: 'registered_definition',
  tenantId: 'tenant-scope',
  workspacePath: '/workspace/scope-b',
  agentInstanceIds: ['host-root:scope-b'],
};
storedThreads.set(wrongDefinitionThread.conversationId, wrongDefinitionThread);
storedAnchors.push({
  interactionId: 'mi_binding_scope_anchor',
  logicalScopeKey: conversationLogicalScopeKeyV2(scopeRecord),
  observedAt: scopeRecord.receivedAt,
  anchor: scopeAnchor,
});
storedMemberships.set('mi_binding_scope_anchor', {
  ...structuredClone(storedMemberships.get(first.interactionId)),
  interactionId: 'mi_binding_scope_anchor',
  canonicalConversationId: wrongDefinitionThread.conversationId,
});
const scopeIsolationService = new AgentConversationBindingService(fakeStore);
const scopeIsolationResult = await scopeIsolationService.applyPersistedBindings([scopeRecord]);
assert.notEqual(scopeIsolationResult[0].conversationId, wrongDefinitionThread.conversationId,
  'a shared anchor must not cross-bind a different definition fingerprint');

// Workflow/service definitions additionally fence deployment/environment revisions even when the
// LogicalAgent and definition fingerprint are the same.
const deploymentAnchor = { ...continuityAnchor, valueHash: 'c'.repeat(64), strength: 'exact' };
const deploymentRecord = {
  ...interaction({
    id: 'mi_binding_deployment_mismatch',
    at: scopeRecord.at + 1_000,
    instance: 'k8s:workflow:v1',
    workspacePath: '/workspace/workflow',
    users: ['deployment mismatch'],
    conversationAnchors: [deploymentAnchor],
  }),
  tenantId: 'tenant-workflow',
  logicalAgentId: 'logical-workflow',
  logicalDefinitionFingerprint: 'definition-workflow',
  logicalScopeMode: 'workflow_definition',
  logicalIdentityAuthority: 'management_registration',
  environment: 'kubernetes',
  environmentId: 'cluster-prod',
  deploymentId: 'workflow-revision-a',
};
const deploymentThreadRecord = { ...deploymentRecord, deploymentId: 'workflow-revision-b' };
assert.equal(
  conversationLogicalScopeKey(deploymentRecord).includes('\0'),
  false,
  'deployment-fenced LogicalAgent scope keys must remain PostgreSQL TEXT/JSONB safe',
);
const wrongDeploymentThread = {
  ...structuredClone(wrongDefinitionThread),
  conversationId: 'cv_scope_wrong_deployment',
  logicalScopeKey: conversationLogicalScopeKey(deploymentThreadRecord),
  logicalAgentId: 'logical-workflow',
  definitionFingerprint: 'definition-workflow',
  logicalScopeMode: 'workflow_definition',
  tenantId: 'tenant-workflow',
  environment: 'kubernetes',
  environmentId: 'cluster-prod',
  deploymentId: 'workflow-revision-b',
  workspacePath: '/workspace/workflow',
  agentInstanceIds: ['k8s:workflow:v2'],
};
storedThreads.set(wrongDeploymentThread.conversationId, wrongDeploymentThread);
storedAnchors.push({
  interactionId: 'mi_binding_deployment_anchor',
  logicalScopeKey: conversationLogicalScopeKeyV2(deploymentRecord),
  observedAt: deploymentRecord.receivedAt,
  anchor: deploymentAnchor,
});
storedMemberships.set('mi_binding_deployment_anchor', {
  ...structuredClone(storedMemberships.get(first.interactionId)),
  interactionId: 'mi_binding_deployment_anchor',
  canonicalConversationId: wrongDeploymentThread.conversationId,
});
const deploymentIsolationService = new AgentConversationBindingService(fakeStore);
const deploymentIsolationResult = await deploymentIsolationService.applyPersistedBindings([deploymentRecord]);
assert.notEqual(deploymentIsolationResult[0].conversationId, wrongDeploymentThread.conversationId,
  'a workflow anchor must not cross-bind a different deployment revision');

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

// A selected long Thread must hydrate from durable membership instead of the 64-per-Agent
// directory sample. The selected time range intentionally excludes the early records: once a
// Thread is selected, its strong membership IDs define the complete resumable product session.
const longConversationId = 'cv_exact_membership_long_thread';
const longRecords = Array.from({ length: 80 }, (_, index) => ({
  ...interaction({
    id: `mi_exact_member_${String(index).padStart(3, '0')}`,
    at: first.at + index * 1_000,
    instance: index < 40 ? 'host-root:thread:long-a' : 'host-root:thread:long-b',
    users: [`long prompt ${index}`],
  }),
  conversationId: longConversationId,
  conversationIdSource: 'provider',
  conversationBindingVersion: 2,
  trafficRole: 'conversation',
}));
const exactMembershipQueries = [];
const exactMembershipAggregation = new AggregationService(
  {
    storedAgentInteractions: async (queryInput) => {
      exactMembershipQueries.push(queryInput);
      return longRecords;
    },
  },
  {
    identitySnapshotVersion: () => 0,
    canonicalAgentAssetId: (value) => value,
  },
  {},
  {},
  {},
  undefined,
  {
    resolveRouteAlias: async () => undefined,
    interactionIdsForConversation: async () => ({
      interactionIds: longRecords.map((record) => record.interactionId),
      truncated: false,
      durable: true,
    }),
    applyPersistedBindings: async (records) => records,
    routeAlias: () => undefined,
    segmentsForConversation: () => [],
  },
);
exactMembershipAggregation.agentInventory = async () => ({
  items: [],
  total: 0,
  totalMode: 'omitted',
  coverage: { partial: true, partialReason: 'hot_ring_only' },
  dataSource: 'hot_ring',
});
const longTimeline = await exactMembershipAggregation.agentConversationTimelineV2({
  timeType: 'custom',
  startTime: new Date(longRecords.at(-2).at).toISOString(),
  endTime: new Date(longRecords.at(-1).at + 10).toISOString(),
  snapshotAsOf: new Date(longRecords.at(-1).at + 10).toISOString(),
  scope: 'agent',
  classificationView: 'current_effective',
  conversationId: longConversationId,
  limit: 100,
});
const exactMembershipQuery = exactMembershipQueries.find((query) => Array.isArray(query.interactionIds));
assert.ok(exactMembershipQuery, 'selected Thread must issue an exact interaction membership read');
assert.equal(exactMembershipQuery.interactionIds.length, 80);
assert.equal(exactMembershipQuery.fairPerAgentLimit, undefined);
assert.equal(exactMembershipQueries.length, 1,
  'a selected Thread must not add a last_1h fair peer scan after its membership read');
assert.equal(
  exactMembershipQueries.filter((query) => query.fairPerAgentLimit).length,
  0,
  'selected Thread point-reads must not use fair-per-agent sampling',
);
assert.equal(longTimeline.interactionIds.length, 80,
  'a selected Thread with more than 64 Interactions must return every durable member');
assert.equal(longTimeline.coverage.partial, false);
assert.equal(longTimeline.coverage.partialReason, undefined,
  'partial inventory decoration must not downgrade exact selected-Thread content');

const emptyMembershipQueries = [];
const emptyMembershipAggregation = new AggregationService(
  {
    storedAgentInteractions: async (queryInput) => {
      emptyMembershipQueries.push(queryInput);
      return longRecords;
    },
  },
  {
    identitySnapshotVersion: () => 0,
    canonicalAgentAssetId: (value) => value,
  },
  {},
  {},
  {},
  undefined,
  {
    resolveRouteAlias: async () => undefined,
    interactionIdsForConversation: async () => ({
      interactionIds: [],
      truncated: false,
      durable: true,
    }),
    applyPersistedBindings: async (records) => records,
    routeAlias: () => undefined,
    segmentsForConversation: () => [],
  },
);
emptyMembershipAggregation.agentInventory = exactMembershipAggregation.agentInventory;
const emptyMembershipTimeline = await emptyMembershipAggregation.agentConversationTimelineV2({
  timeType: 'custom',
  startTime: new Date(longRecords.at(-2).at).toISOString(),
  endTime: new Date(longRecords.at(-1).at + 10).toISOString(),
  snapshotAsOf: new Date(longRecords.at(-1).at + 10).toISOString(),
  scope: 'agent',
  classificationView: 'current_effective',
  conversationId: 'cv_empty_membership_point_read',
  limit: 100,
});
assert.equal(emptyMembershipQueries.length, 0,
  'an empty durable Thread membership must not fetch unrelated last_1h history');
assert.equal(emptyMembershipTimeline.turns.length, 0);
assert.equal(emptyMembershipTimeline.interactionIds.length, 0);

const sessionFallbackQueries = [];
const sessionFallbackRecords = longRecords.slice(0, 4).map((record) => ({
  ...record,
  sessionId: 'thread-session-fallback',
  conversationId: 'cv_session_fallback_thread',
}));
const sessionFallbackAggregation = new AggregationService(
  {
    storedAgentInteractions: async (queryInput) => {
      sessionFallbackQueries.push(queryInput);
      return queryInput.sessionId === 'thread-session-fallback'
        || queryInput.runId === 'thread-session-fallback'
        ? sessionFallbackRecords
        : [];
    },
  },
  {
    identitySnapshotVersion: () => 0,
    canonicalAgentAssetId: (value) => value,
  },
  {},
  {},
  {},
  undefined,
  {
    resolveRouteAlias: async () => undefined,
    interactionIdsForConversation: async () => ({
      interactionIds: [],
      truncated: false,
      durable: true,
    }),
    applyPersistedBindings: async (records) => records,
    routeAlias: () => undefined,
    segmentsForConversation: () => [],
  },
  {
    configured: () => true,
    loadAgentConversationThreadsByIds: async () => [{
      conversationId: 'cv_session_fallback_thread',
      sessionId: 'thread-session-fallback',
    }],
  },
);
sessionFallbackAggregation.agentInventory = exactMembershipAggregation.agentInventory;
const sessionFallbackTimeline = await sessionFallbackAggregation.agentConversationTimelineV2({
  timeType: 'custom',
  startTime: new Date(sessionFallbackRecords[0].at).toISOString(),
  endTime: new Date(sessionFallbackRecords.at(-1).at + 10).toISOString(),
  snapshotAsOf: new Date(sessionFallbackRecords.at(-1).at + 10).toISOString(),
  scope: 'agent',
  classificationView: 'current_effective',
  conversationId: 'cv_session_fallback_thread',
  limit: 100,
});
assert.equal(sessionFallbackQueries.filter((query) => query.fairPerAgentLimit).length, 0,
  'empty membership plus a durable Thread session must not use a last_1h fair sample');
assert.ok(
  sessionFallbackQueries.some((query) =>
    query.sessionId === 'thread-session-fallback' || query.runId === 'thread-session-fallback'),
  'empty membership must hydrate the selected Thread from its durable session/run id');
assert.equal(sessionFallbackTimeline.coverage.partialReason, undefined);
assert.equal(sessionFallbackTimeline.coverage.partial, false);

// Parent and child hops can share sessionId/runId. Session hydration must not fold the peer
// hop into the selected Thread, and hop-fenced aliases must still pick the owning summary.
const hopSession = 'shared-parent-child-session';
const hopWorkerRecords = [0, 1, 2].map((index) => ({
  ...interaction({
    id: `mi_hop_worker_${index}`,
    at: first.at + index * 1_000,
    instance: 'host-root:thread:hop-worker',
    users: [`worker hop ${index}`],
  }),
  sessionId: hopSession,
  runId: hopSession,
  hop: 'worker',
  conversationId: 'cv_worker_hop_thread',
  conversationIdSource: 'provider',
  conversationBindingVersion: 2,
  trafficRole: 'conversation',
}));
const hopOrchRecords = [0, 1, 2].map((index) => ({
  ...interaction({
    id: `mi_hop_orch_${index}`,
    at: first.at + 4_000 + index * 1_000,
    instance: 'host-root:thread:hop-orch',
    users: [`orch hop ${index}`],
  }),
  sessionId: hopSession,
  runId: hopSession,
  hop: 'orchestrator',
  conversationId: 'cv_orch_hop_thread',
  conversationIdSource: 'provider',
  conversationBindingVersion: 2,
  trafficRole: 'conversation',
}));
const hopAllRecords = [...hopWorkerRecords, ...hopOrchRecords];
function hopTimelineAggregation(conversationId, membershipIds) {
  const reads = [];
  const agg = new AggregationService(
    {
      storedAgentInteractions: async (queryInput) => {
        reads.push(queryInput);
        if (Array.isArray(queryInput.interactionIds)) {
          const wanted = new Set(queryInput.interactionIds);
          return hopAllRecords.filter((record) => wanted.has(record.interactionId));
        }
        return queryInput.sessionId === hopSession || queryInput.runId === hopSession
          ? hopAllRecords
          : [];
      },
    },
    {
      identitySnapshotVersion: () => 0,
      canonicalAgentAssetId: (value) => value,
    },
    {},
    {},
    {},
    undefined,
    {
      resolveRouteAlias: async () => undefined,
      interactionIdsForConversation: async () => ({
        interactionIds: membershipIds,
        truncated: false,
        durable: true,
      }),
      applyPersistedBindings: async (records) => records.map((record) => ({
        ...record,
        conversationId: record.hop === 'worker' ? 'cv_worker_fenced_alias' : 'cv_orch_fenced_alias',
        conversationIdSource: 'inferred',
        conversationBindingVersion: 2,
      })),
      routeAlias: () => undefined,
      segmentsForConversation: () => [],
    },
    {
      configured: () => true,
      loadAgentConversationThreadsByIds: async () => [{
        conversationId,
        sessionId: hopSession,
      }],
    },
  );
  agg.agentInventory = exactMembershipAggregation.agentInventory;
  return { agg, reads };
}
const hopQuery = {
  timeType: 'custom',
  startTime: new Date(hopWorkerRecords[0].at).toISOString(),
  endTime: new Date(hopOrchRecords.at(-1).at + 10).toISOString(),
  snapshotAsOf: new Date(hopOrchRecords.at(-1).at + 10).toISOString(),
  scope: 'agent',
  classificationView: 'current_effective',
  limit: 100,
};
const workerHop = hopTimelineAggregation(
  'cv_worker_hop_thread',
  hopWorkerRecords.map((record) => record.interactionId),
);
const workerHopTimeline = await workerHop.agg.agentConversationTimelineV2({
  ...hopQuery,
  conversationId: 'cv_worker_hop_thread',
});
assert.deepEqual(
  [...workerHopTimeline.interactionIds].sort(),
  hopWorkerRecords.map((record) => record.interactionId).sort(),
  'selected worker Thread must not include orchestrator hop members from the shared session',
);
assert.equal(
  workerHopTimeline.interactionIds.some((id) => String(id).includes('orch')),
  false,
);
const orchHop = hopTimelineAggregation(
  'cv_orch_hop_thread',
  hopOrchRecords.map((record) => record.interactionId),
);
const orchHopTimeline = await orchHop.agg.agentConversationTimelineV2({
  ...hopQuery,
  conversationId: 'cv_orch_hop_thread',
});
assert.deepEqual(
  [...orchHopTimeline.interactionIds].sort(),
  hopOrchRecords.map((record) => record.interactionId).sort(),
  'selected orchestrator Thread must not include worker hop members from the shared session',
);

// A canonical Session is not a compatibility conversation ID. Its selected records must retain
// their messages across a cold read, and missing membership must never trigger a history scan.
const canonicalSession = `sess_${'c'.repeat(24)}`;
const canonicalRecords = longRecords.slice(0, 2).map((record) => ({
  ...record, sessionId: canonicalSession, canonicalSessionId: canonicalSession,
}));
function canonicalAggregation(selection, records = canonicalRecords) {
  const reads = [];
  const agg = new AggregationService({ storedAgentInteractions: async (q) => {
    assert.ok(Array.isArray(q.interactionIds), 'canonical Session reads must stay membership-scoped');
    reads.push(q);
    return records;
  } }, { identitySnapshotVersion: () => 0, canonicalAgentAssetId: (v) => v }, {}, {}, {}, undefined, {
    resolveRouteAlias: async () => undefined,
    interactionIdsForConversation: async (id) => {
      assert.equal(id, canonicalSession);
      return selection;
    },
    applyPersistedBindings: async (items) => items,
    routeAlias: () => undefined,
    segmentsForConversation: () => [],
  });
  agg.agentInventory = exactMembershipAggregation.agentInventory;
  return { agg, reads };
}
const canonicalSelection = {
  interactionIds: canonicalRecords.map((record) => record.interactionId),
  durable: true, truncated: false,
};
const canonicalQuery = { ...fixedProjectionQuery, scope: 'raw', conversationId: canonicalSession };
const canonicalRead = canonicalAggregation(canonicalSelection);
const canonicalTimeline = await canonicalRead.agg.agentConversationTimelineV2(canonicalQuery);
assert.deepEqual(canonicalTimeline.interactionIds.sort(), canonicalSelection.interactionIds);
assert.equal(canonicalTimeline.thread.sessionId, canonicalSession);
assert.ok(canonicalTimeline.turns.length > 0, 'canonical ID lookup must retain the semantic timeline');
assert.equal(canonicalTimeline.coverage.partial, false);
assert.equal(canonicalRead.reads.length, 1, 'no additional broad peer read for canonical content');
for (const durable of [true, false]) {
  const missing = canonicalAggregation({ interactionIds: [], durable, truncated: false, storeUnavailable: !durable });
  const result = await missing.agg.agentConversationTimelineV2(canonicalQuery);
  assert.equal(missing.reads.length, 0, 'empty membership must not fetch unrelated history');
  assert.equal(result.turns.length, 0);
  assert.ok(durable || result.coverage.partial, 'store outage must remain partial');
}

const { SecurityMonitoringController } = require('../apps/api/dist/security-monitoring/security-monitoring.controller.js');
const controller = Object.create(SecurityMonitoringController.prototype);
controller.agg = canonicalRead.agg;
controller.agg.agentInteractions = async () => ({ items: canonicalRecords, coverage: { partial: false }, dataSource: 'clickhouse' });
controller.canonicalCurrentRevision = () => 1;
controller.canonicalRevisionCoverage = (_query, _revision, coverage) => coverage;
controller.canonicalObservability = {
  listDurableSessionMemberships: async () =>
    canonicalRecords.map((record, i) => ({
      membershipId: `sm_test_${i}`, sessionId: canonicalSession, sessionKey: canonicalSession,
      interactionId: record.interactionId, resolutionRevision: 1, sourceRefs: [record.interactionId],
    })),
  listDurableSemanticRecords: async () => [],
};
const sessionQuery = { sessionId: canonicalSession, limit: 20, offset: 0 };
const sessionProjection = await controller.computeCanonicalSessionResources(sessionQuery, {});
assert.deepEqual(sessionProjection.items[0].interactionIds.sort(), canonicalSelection.interactionIds);
assert.ok(sessionProjection.items[0].turnCount > 0, 'Session resource must retain semantic content');
controller.agg = { agentInteractions: async () => ({
  items: [], coverage: { partial: true, partialReason: 'storage_unavailable' }, dataSource: 'hot_ring',
}) };
const missingProjection = await controller.computeCanonicalSessionResources(sessionQuery, {});
assert.deepEqual(missingProjection.items[0].interactionIds.sort(), canonicalSelection.interactionIds,
  'a missing semantic projection must still expose every canonical member');
assert.equal(missingProjection.items[0].coverage.status, 'asset_only');

// Keep the SQL contract executable without requiring PostgreSQL in the local verifier.
let membershipSql;
let membershipParams;
const relationalStore = new RelationalBusinessStore();
relationalStore.initialize = async () => true;
relationalStore.pool = {
  query: async (sql, params) => {
    membershipSql = sql;
    membershipParams = params;
    return { rows: [{ interaction_id: 'mi_sql_member' }] };
  },
};
assert.deepEqual(
  await relationalStore.loadAgentConversationInteractionIds(longConversationId, 5_000),
  { interactionIds: ['mi_sql_member'], truncated: false },
);
assert.match(membershipSql, /WITH RECURSIVE thread_ids/u);
assert.match(membershipSql, /newer\.resolution_revision > candidate\.resolution_revision/u);
assert.match(membershipSql, /NOT EXISTS[\s\S]*current\.interaction_id = binding\.interaction_id/u);
assert.deepEqual(membershipParams, [longConversationId, 5_001]);
assert.deepEqual(
  await relationalStore.loadAgentConversationInteractionIds(`sess_${'a'.repeat(24)}`, 12),
  { interactionIds: ['mi_sql_member'], truncated: false },
);
assert.match(membershipSql, /FROM anysentry_session_memberships_v1 AS candidate/u);
assert.deepEqual(membershipParams, [`sess_${'a'.repeat(24)}`, 13]);

// V2 memberships/anchors are historical decisions. Keep a source-level guard alongside the
// executable SQL mock so a future migration cannot reintroduce an in-place DO UPDATE that erases
// a same-revision correlation decision.
const relationalSource = readFileSync(
  new URL('../apps/api/src/security-monitoring/relational-business-store.service.ts', import.meta.url),
  'utf8',
);
assert.match(relationalSource, /Canonical Session IDs are a separate namespace/u,
  'durable membership loader must have a canonical Session point-read path');
assert.match(relationalSource, /FROM anysentry_session_memberships_v1 AS candidate[\s\S]*candidate\.session_id = \$1/u,
  'canonical Session point-read must query SessionMembership by session_id');
const v1Start = relationalSource.indexOf('async saveAgentConversationResolution(');
const v2Start = relationalSource.indexOf('async saveAgentConversationResolutionV2(');
const v2End = relationalSource.indexOf('async loadAgentSemanticKernelRelations(', v2Start);
assert(v1Start >= 0 && v2Start > v1Start, 'V1 compatibility resolution writer source region is present');
const v1Writer = relationalSource.slice(v1Start, v2Start);
assert.match(v1Writer, /CONVERSATION_RESOLUTION_V1_MAX_THREADS/iu,
  'legacy Thread projection persistence has an explicit row bound');
assert.match(v1Writer, /CONVERSATION_RESOLUTION_V1_MAX_BYTES/iu,
  'legacy conversation projection persistence has an aggregate byte bound');
assert.match(v1Writer, /boundedJsonRows/iu,
  'legacy compatibility rows are size checked before PostgreSQL allocation');
assert(v2Start >= 0 && v2End > v2Start, 'V2 resolution writer source region is present');
const v2Writer = relationalSource.slice(v2Start, v2End);
assert.doesNotMatch(v2Writer, /ON CONFLICT \(interaction_id, resolution_revision\)\s+DO UPDATE/iu,
  'same-revision memberships must never be updated in place');
assert.match(v2Writer, /ON CONFLICT \(interaction_id, resolution_revision\)\s+DO NOTHING/iu,
  'same-revision memberships use immutable insert semantics');
assert.match(v2Writer, /ON CONFLICT \(interaction_id, anchor_kind, anchor_namespace, value_hash\)[\s\S]*?DO NOTHING/iu,
  'conversation anchors use immutable insert semantics');
assert.match(v2Writer, /COUNT\(DISTINCT record\)\s*>\s*1/iu,
  'V2 writer detects conflicting duplicate keys inside one incoming batch');
assert.match(v2Writer, /existing\.record\s*<>\s*incoming\.record/iu,
  'V2 writer detects a changed payload at an existing immutable key');
assert.match(v2Writer, /const technicalRows\s*=\s*technicalActivities\.map/iu,
  'technical activity rows receive a bounded storage timestamp before JSON serialization');
assert.match(v2Writer, /const technicalJson\s*=\s*boundedJsonRows\(\s*technicalRows/iu,
  'technical activity payload bounds include the storage timestamp field');
assert.match(v2Writer, /batchHasConflictingRecords\(aliases/iu,
  'V2 latest alias projection rejects conflicting duplicate aliases in one batch');
assert.match(v2Writer, /batchHasConflictingRecords\(technicalActivities/iu,
  'V2 latest technical projection rejects conflicting duplicate activities in one batch');

assert.match(
  readFileSync(new URL('../apps/api/src/security-monitoring/agent-conversation-binding.service.ts', import.meta.url), 'utf8'),
  /correlationQuality\s*===\s*'coverage_gap'[\s\S]{0,320}'unresolved'/u,
  'a coverage-gap correlation remains a queryable unresolved Session membership instead of being dropped as an invalid unknown quality',
);

// Generic event fallback must keep semantic intent/result records in the human lane while
// reserving tool_backend for the machine-side ToolExec fact.  Invocation/node bookkeeping and
// unanchored LlmApi/control events stay technical even though they carry the legacy Session id.
const eventRoleFixture = {
  attributes: {},
  activityContext: undefined,
  sessionId: 'fixture-session',
  eventCategory: 'runtime',
  runId: undefined,
  runIdSource: undefined,
  turnId: undefined,
  sessionKey: undefined,
  sessionIdentityQuality: undefined,
  canonicalSessionId: undefined,
};
const eventRoleCases = [
  ['ToolExec', 'tool_backend', {}],
  ['tool', 'tool_backend', {}], // legacy universal-ingest alias
  ['tool', 'conversation', { eventCategory: 'tool', toolCallId: 'semantic-tool-alias' }],
  ['AgentTool', 'conversation', { eventCategory: 'tool', attributes: { 'gen_ai.operation.name': 'execute_tool' } }],
  ['ToolResult', 'conversation', { eventCategory: 'tool' }],
  ['AgentInvocation', 'background', { eventCategory: 'runtime', runId: 'derived-run', runIdSource: 'derived_ephemeral' }],
  ['NodeRun', 'background', { eventCategory: 'runtime', runId: 'producer-run', runIdSource: 'producer' }],
  ['WorkflowNode', 'background', { eventCategory: 'runtime' }],
  ['LlmApi', 'background', { eventCategory: 'llm', runId: 'derived-run', runIdSource: 'derived_ephemeral' }],
  ['LlmApi', 'control', { eventCategory: 'llm', attributes: { 'gen_ai.operation.name': 'initialize' } }],
  ['LlmApi', 'conversation', { eventCategory: 'llm', runId: 'producer-run', runIdSource: 'producer' }],
  ['LlmApi', 'conversation', { eventCategory: 'llm', sessionIdSource: 'provider' }],
  ['LlmApi', 'background', { eventCategory: 'llm', sessionIdSource: 'per_request', runId: 'derived-run', runIdSource: 'derived_ephemeral' }],
  ['AgentTool', 'background', { eventCategory: 'tool', attributes: { 'anysentry.traffic.role': 'background' } }],
  ['RuntimeEvent', 'background', { eventCategory: 'runtime' }],
  ['ProcessExit', 'background', { eventCategory: 'process' }],
  ['FileAccess', 'background', { eventCategory: 'file' }],
  ['Egress', 'background', { eventCategory: 'network' }],
  ['SystemContext', 'background', { eventCategory: 'runtime' }],
  ['LegacyTool', 'conversation', { eventCategory: 'unknown' }], // unknown/legacy fallback is retained
  ['ToolExec', 'background', { activityContext: 'platform_healthcheck', eventCategory: 'runtime' }],
];
const bindingSource = readFileSync(
  new URL('../apps/api/src/security-monitoring/agent-conversation-binding.service.ts', import.meta.url),
  'utf8',
);
assert.match(bindingSource, /const role = trafficRoleForEvent\(event\)/u,
  'event membership uses the generic traffic-role resolver');
assert.match(bindingSource, /eventMembershipEligible\(event\)/u,
  'kernel-only events must not mint event-scoped Sessions');
assert.doesNotMatch(bindingSource, /normalizedKind\.includes\(['"]tool['"]\)/u,
  'event membership must not classify semantic Tool kinds by substring');
for (const [eventKind, expectedRole, overrides] of eventRoleCases) {
  const event = {
    ...eventRoleFixture,
    ...overrides,
    eventKind,
  };
  assert.equal(trafficRoleForEvent(event), expectedRole, `${eventKind} traffic role`);
}
// Controller-normalized ToolExec events use eventCategory=tool as well; the canonical kind must
// still stay on the machine lane even when a tool call id is attached by the producer.
assert.equal(
  trafficRoleForEvent({
    ...eventRoleFixture,
    eventKind: 'ToolExec',
    eventCategory: 'tool',
    toolCallId: 'kernel-tool-call',
  }),
  'tool_backend',
  'canonical ToolExec remains tool_backend with universal tool category',
);
const persistedEventMemberships = [];
const eventMembershipSink = {
  commitSessionMemberships: async (memberships) => {
    persistedEventMemberships.push(...memberships);
    return { accepted: memberships.length, rejected: 0, durable: false };
  },
  recordGap: () => {},
};
const eventMembershipService = new AgentConversationBindingService(undefined, eventMembershipSink);
for (const [index, [eventKind, expectedRole, overrides]] of eventRoleCases.entries()) {
  const kernelOnly = new Set([
    'ToolExec', 'tool', 'ProcessExit', 'FileAccess', 'Egress', 'SystemContext',
  ]).has(eventKind)
    && !(overrides.eventCategory === 'tool' || overrides.toolCallId);
  const before = persistedEventMemberships.length;
  await eventMembershipService.commitEventMembership({
    schemaVersion: 'anysentry.agent_event.v1',
    eventId: `event-role-${index}`,
    at: fixtureNow + index,
    eventKind,
    eventCategory: 'runtime',
    source: 'api',
    subject: eventKind,
    workspacePath: '/workspace/event-role-fixture',
    agentId: 'event-role-fixture',
    sessionId: 'fixture-session',
    userId: 'fixture-user',
    traceId: `trace-${index}`,
    spanId: `span-${index}`,
    runId: undefined,
    verdict: 'allow',
    tier: 'Rules',
    severity: 'info',
    reason: 'fixture',
    riskCategory: 'system',
    riskName: 'fixture',
    riskType: 'system',
    riskScore: 0,
    tokenCount: 0,
    latencyMs: 0,
    ...overrides,
  });
  if (kernelOnly) {
    assert.equal(persistedEventMemberships.length, before,
      `${eventKind} kernel fact must not create a SessionMembership`);
  } else {
    assert.equal(persistedEventMemberships.at(-1).role, expectedRole,
      `${eventKind} commitEventMembership role`);
  }
}

// The ingest-time Interaction path must retain every resolver role.  A previous compatibility
// mapper only copied bootstrap/control/background/tool_backend and silently folded replay,
// derived-metadata, retry, and unclassified records into the human conversation lane.
const persistedInteractionMemberships = [];
const interactionMembershipSink = {
  commitSessionMemberships: async (memberships) => {
    persistedInteractionMemberships.push(...memberships);
    return { accepted: memberships.length, rejected: 0, durable: false };
  },
  recordGap: () => {},
};
const interactionMembershipService = new AgentConversationBindingService(undefined, interactionMembershipSink);
const interactionRoleCases = [
  ['conversation', { interactionType: 'model', trafficRole: 'conversation' }],
  ['bootstrap', { interactionType: 'model', trafficRole: 'bootstrap' }],
  ['control', { interactionType: 'tool', trafficRole: 'control' }],
  ['context_replay', { interactionType: 'model', trafficRole: 'context_replay' }],
  ['tool_backend', { interactionType: 'model', trafficRole: 'tool_backend' }],
  ['derived_metadata', { interactionType: 'model', trafficRole: 'derived_metadata' }],
  ['retry', { interactionType: 'model', trafficRole: 'retry' }],
  ['background', { interactionType: 'model', trafficRole: 'background' }],
  ['unclassified', { interactionType: 'unknown', trafficRole: 'unclassified' }],
  ['conversation', { interactionType: 'model', trafficRole: 'future_role' }],
];
for (const [index, [expectedRole, overrides]] of interactionRoleCases.entries()) {
  await interactionMembershipService.commitInteractionMembership({
    schemaVersion: 'anysentry.agent_interaction.v1',
    interactionId: `interaction-role-${index}`,
    interactionType: 'model',
    at: fixtureNow + 100 + index,
    agentAssetId: 'interaction-role-fixture',
    sessionId: 'fixture-session',
    sessionKey: 'fixture:session',
    sessionIdentityQuality: 'strong',
    sessionNamespaceKey: 'fixture',
    startedAtUnixNs: String(BigInt(fixtureNow + 100 + index) * 1_000_000n),
    request: content('{}'),
    response: content('{}'),
    toolCalls: [],
    toolResults: [],
    receivedAt: fixtureNow + 100 + index,
    ...overrides,
  });
  assert.equal(persistedInteractionMemberships.at(-1).role, expectedRole,
    `${overrides.trafficRole} commitInteractionMembership role`);
}

const childThread = {
  conversationId: 'cv_old_child',
  logicalScopeKey: 'ls_fixture',
  sessionId: 'fanout-run-1',
  sessionMode: 'resumable',
  sessionIdentityQuality: 'strong',
  idSource: 'inferred',
  agentProduct: 'LangGraph',
  workspacePath: '/workspace/specialist',
  agentInstanceIds: ['docker:same-specialist'],
  userLineageHashes: ['abc'],
  pendingToolCallIds: [],
  startedAtUnixNs: '1',
  lastActivityAtUnixNs: '2',
  resolverVersion: 2,
  updatedAt: 1,
};
assert.equal(
  threadAcceptsUnboundRecord(childThread, {
    sessionId: 'fanout-run-2',
    sessionMode: 'resumable',
    sessionIdentityQuality: 'strong',
    sessionIdSource: 'provider',
  }),
  false,
  'same-container child with a new session/run must not reuse the prior Thread',
);
assert.equal(
  threadAcceptsUnboundRecord(childThread, {
    sessionId: 'fanout-run-1',
    sessionMode: 'resumable',
    sessionIdentityQuality: 'strong',
    sessionIdSource: 'provider',
  }),
  true,
  'the same Session anchor may continue the Thread',
);
assert.equal(
  threadAcceptsUnboundRecord({
    ...childThread,
    sessionId: 's113-stateful-shared',
    sessionKey: 'sess_stateful',
  }, {
    sessionId: 's113-stateful-shared',
    sessionKey: 'sess_stateful',
    sessionMode: 'resumable',
    sessionIdentityQuality: 'strong',
    sessionIdSource: 'provider',
  }),
  true,
  'stateful Design A keeps one Thread across runs',
);
assert.equal(
  threadAcceptsUnboundRecord({
    ...childThread,
    logicalScopeKey: 'ls_fixture|hop:orchestrator',
    sessionId: 'design-b-shared-run',
  }, {
    hop: 'worker',
    sessionId: 'design-b-shared-run',
    sessionMode: 'resumable',
    sessionIdentityQuality: 'strong',
    sessionIdSource: 'provider',
  }),
  false,
  'shared session/run across hops must not bind the child into the parent Thread',
);
assert.notEqual(
  conversationLogicalScopeKey({ hop: 'orchestrator' }),
  conversationLogicalScopeKey({ hop: 'worker' }),
  'Thread logical scope must stay hop-fenced without embedding NUL',
);
assert.equal(
  conversationLogicalScopeKey({ hop: 'orchestrator' }).includes('\0'),
  false,
  'hop-fenced logical scope must stay PostgreSQL TEXT safe',
);

const persistHopSession = 'design-b-persist-shared-run';
const persistHopService = new AgentConversationBindingService(fakeStore);
const persistHopOrch = {
  ...interaction({
    id: 'mi_persist_hop_orch',
    at: fixtureNow + 50_000,
    instance: 'host-root:thread:persist-orch',
    users: ['persist orch'],
  }),
  hop: 'orchestrator',
  sessionId: persistHopSession,
  runId: persistHopSession,
  providerConversationId: persistHopSession,
  sessionMode: 'resumable',
  sessionIdentityQuality: 'strong',
  sessionIdSource: 'provider',
};
const persistHopWorker = {
  ...interaction({
    id: 'mi_persist_hop_worker',
    at: fixtureNow + 50_100,
    instance: 'host-root:thread:persist-worker',
    users: ['persist worker'],
  }),
  hop: 'worker',
  sessionId: persistHopSession,
  runId: persistHopSession,
  providerConversationId: persistHopSession,
  sessionMode: 'resumable',
  sessionIdentityQuality: 'strong',
  sessionIdSource: 'provider',
};
const persistHopProjection = await resolveAndPersist(persistHopService, [
  persistHopOrch,
  persistHopWorker,
]);
const persistHopMembershipIds = [...new Set(
  [persistHopOrch, persistHopWorker].map((record) =>
    storedMemberships.get(record.interactionId)?.canonicalConversationId),
)];
assert.equal(
  persistHopMembershipIds.length,
  2,
  'persist must keep hop-local memberships instead of one parent stamp',
);
assert.notEqual(
  storedMemberships.get(persistHopOrch.interactionId)?.canonicalConversationId,
  storedMemberships.get(persistHopWorker.interactionId)?.canonicalConversationId,
  'worker membership must not reuse the orchestrator stamp',
);
assert.notEqual(
  storedBindings.get(persistHopOrch.interactionId)?.conversationId,
  storedBindings.get(persistHopWorker.interactionId)?.conversationId,
  'v1 bindings must follow hop-local memberships',
);
const persistHopRestart = new AgentConversationBindingService(fakeStore);
const persistHopRebound = await persistHopRestart.applyPersistedBindings([
  structuredClone(persistHopOrch),
  structuredClone(persistHopWorker),
]);
assert.notEqual(
  persistHopRebound[0].conversationId,
  persistHopRebound[1].conversationId,
  'apply must not chase a parent stamp alias onto the worker hop',
);
assert.ok(
  persistHopProjection.projection.summaries.length >= 2,
  'directory projection of a shared run must keep two hop Threads',
);

console.log('Agent Conversation durable Thread/Segment binding verification passed');
