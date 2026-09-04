#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { AgentConversationBindingService, conversationLogicalScopeKey, trafficRoleForEvent } = require(
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
let exactMembershipQuery;
const exactMembershipAggregation = new AggregationService(
  {
    storedAgentInteractions: async (queryInput) => {
      exactMembershipQuery = queryInput;
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
assert.equal(exactMembershipQuery.interactionIds.length, 80);
assert.equal(exactMembershipQuery.fairPerAgentLimit, undefined);
assert.equal(longTimeline.interactionIds.length, 80,
  'a selected Thread with more than 64 Interactions must return every durable member');
assert.equal(longTimeline.coverage.partial, false);
assert.equal(longTimeline.coverage.partialReason, undefined,
  'partial inventory decoration must not downgrade exact selected-Thread content');

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

// V2 memberships/anchors are historical decisions. Keep a source-level guard alongside the
// executable SQL mock so a future migration cannot reintroduce an in-place DO UPDATE that erases
// a same-revision correlation decision.
const relationalSource = readFileSync(
  new URL('../apps/api/src/security-monitoring/relational-business-store.service.ts', import.meta.url),
  'utf8',
);
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
  ['LegacyTool', 'conversation', { eventCategory: 'unknown' }], // unknown/legacy fallback is retained
  ['ToolExec', 'background', { activityContext: 'platform_healthcheck', eventCategory: 'runtime' }],
];
const bindingSource = readFileSync(
  new URL('../apps/api/src/security-monitoring/agent-conversation-binding.service.ts', import.meta.url),
  'utf8',
);
assert.match(bindingSource, /const role = trafficRoleForEvent\(event\)/u,
  'event membership uses the generic traffic-role resolver');
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
  assert.equal(persistedEventMemberships.at(-1).role, expectedRole,
    `${eventKind} commitEventMembership role`);
}

console.log('Agent Conversation durable Thread/Segment binding verification passed');
