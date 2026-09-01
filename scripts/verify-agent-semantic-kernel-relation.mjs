#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildSemanticKernelRelationBatch,
  buildSemanticKernelRelations,
  semanticKernelRelationBatchWindow,
  toolInvocationId,
} = require('../apps/api/dist/security-monitoring/agent-semantic-kernel-relation.js');
const {
  RelationalBusinessStore,
} = require('../apps/api/dist/security-monitoring/relational-business-store.service.js');
const {
  AggregationService,
  toolEvidenceHotPathTesting,
} = require('../apps/api/dist/security-monitoring/aggregation.service.js');
const {
  projectAgentConversations,
} = require('../apps/api/dist/security-monitoring/agent-conversation.js');
const {
  projectSemanticConversationTimeline,
} = require('../apps/api/dist/security-monitoring/agent-semantic-timeline.js');

const instanceId = 'host-root:semantic:100:200';
const interaction = {
  interactionId: 'mi_semantic_kernel_relation',
  agentAssetId: 'agent-semantic',
  agentInstanceId: instanceId,
};
const callAt = 1_788_500_000_000;
const toolCall = {
  semanticEventId: 'se_semantic_kernel_call',
  conversationId: 'cv_semantic',
  segmentId: 'seg_semantic',
  turnId: 'turn_semantic',
  actor: 'tool',
  kind: 'tool_call',
  atUnixNs: String(BigInt(callAt) * 1_000_000n),
  content: { cmd: 'rg -n resolver-v2 /tmp/canary.txt' },
  toolCallId: 'call-semantic',
  toolName: 'exec_command',
  toolKind: 'bash',
  sourceInteractionIds: [interaction.interactionId],
  evidenceEventIds: ['evt_llm_interaction'],
};
const toolResult = {
  ...toolCall,
  semanticEventId: 'se_semantic_kernel_result',
  kind: 'tool_result',
  atUnixNs: String(BigInt(callAt + 500) * 1_000_000n),
};
const kernelEvent = {
  eventId: 'evt_kernel_exec',
  at: new Date(callAt + 100).toISOString(),
  eventKind: 'ToolExec',
  decisionRevision: 3,
  subject: '/bin/bash -lc "rg -n resolver-v2 /tmp/canary.txt"',
  agentRuntimeInstanceId: instanceId,
  agentRuntimeInstanceAliases: [],
  attributes: {},
  verdict: 'block',
  tier: 'L1',
  severity: 'high',
  riskScore: 86,
  riskName: '危险命令',
  riskCategory: 'command_danger',
  reason: 'fixture risk judgment',
};
const unrelated = {
  ...kernelEvent,
  eventId: 'evt_unrelated',
  subject: '/bin/bash -lc "printf unrelated"',
};
const wrongInstance = {
  ...kernelEvent,
  eventId: 'evt_wrong_instance',
  agentRuntimeInstanceId: 'host-root:other:101:201',
};

const relations = buildSemanticKernelRelations(
  toolCall,
  toolResult,
  interaction,
  [kernelEvent, unrelated, wrongInstance],
  12,
  false,
);
assert.equal(relations.length, 1);
assert.equal(relations[0].status, 'linked_exact');
assert.equal(relations[0].linkMethod, 'command');
assert.equal(relations[0].kernelEventId, kernelEvent.eventId);
assert.equal(relations[0].kernelEventAt, kernelEvent.at);
assert.equal(relations[0].kernelEventKind, 'ToolExec');
assert.equal(relations[0].kernelEventDecisionRevision, 3);
assert.equal(relations[0].timeQuality, 'exact');
assert.equal(relations[0].risk.riskScore, 86);
assert.equal(relations[0].risk.verdict, 'block');
assert.equal(relations[0].authority, 'attested_tls_plaintext');
assert.equal(relations[0].toolInvocationId, toolInvocationId(toolCall, interaction));

const codexCustomToolCall = {
  ...toolCall,
  semanticEventId: 'se_codex_custom_tool',
  toolCallId: 'call-codex-custom',
  content: 'const r = await tools.exec_command({cmd:"rg -n resolver-v2 /tmp/canary.txt",workdir:"/tmp"}); text(r.output);',
};
const codexRelations = buildSemanticKernelRelations(
  codexCustomToolCall,
  toolResult,
  interaction,
  [kernelEvent],
  12,
  false,
);
assert.equal(codexRelations[0].status, 'linked_exact',
  'Codex custom-tool JavaScript wrappers must expose their bounded cmd field generically');
assert.equal(codexRelations[0].kernelEventId, kernelEvent.eventId);

const completeArgvEvent = {
  ...kernelEvent,
  eventId: 'evt_complete_argv_after_short_subject',
  subject: '/bin/bash -c source /tmp/agent-shell-snapshot',
  attributes: {
    argv: "/bin/bash -c source /tmp/agent-shell-snapshot && eval 'rg -n resolver-v2 /tmp/canary.txt'",
    argv_truncated: false,
    argv_incomplete: false,
  },
};
const completeArgvRelations = buildSemanticKernelRelations(
  toolCall,
  toolResult,
  interaction,
  [completeArgvEvent],
  12,
  false,
);
assert.equal(completeArgvRelations[0].status, 'linked_strong');
assert.equal(completeArgvRelations[0].linkMethod, 'command');
assert.equal(completeArgvRelations[0].kernelEventId, completeArgvEvent.eventId,
  'a complete eBPF argv must recover a command that the bounded Event subject omits');

const truncatedArgvRelations = buildSemanticKernelRelations(
  toolCall,
  toolResult,
  interaction,
  [{
    ...completeArgvEvent,
    eventId: 'evt_truncated_argv_after_short_subject',
    attributes: { ...completeArgvEvent.attributes, argv_truncated: true },
  }],
  12,
  false,
);
assert.equal(truncatedArgvRelations[0].status, 'semantic_only');
assert.equal(truncatedArgvRelations[0].kernelEventId, undefined,
  'an explicitly truncated argv must never be promoted into exact command evidence');

const preciseKernelTimeRelations = buildSemanticKernelRelations(
  toolCall,
  toolResult,
  interaction,
  [{
    ...kernelEvent,
    eventId: 'evt_precise_kernel_time',
    at: '1970-01-01 00:00:00',
    eventAtUnixNs: String(BigInt(callAt + 100) * 1_000_000n),
  }],
  12,
  false,
);
assert.equal(preciseKernelTimeRelations[0].status, 'linked_exact');
assert.equal(preciseKernelTimeRelations[0].kernelEventId, 'evt_precise_kernel_time',
  'the attested nanosecond event time must take precedence over a coarse or zone-less display time');

const resourceCall = {
  ...toolCall,
  semanticEventId: 'se_semantic_resource',
  toolCallId: 'call-resource',
  toolName: 'apply_patch',
  toolKind: 'write',
  content: { path: '/tmp/canary.txt', content: 'fixture' },
};
const fileEvent = {
  ...kernelEvent,
  eventId: 'evt_file_write',
  eventKind: 'FileAccess',
  subject: 'write /tmp/canary.txt',
  attributes: { path: '/tmp/canary.txt', accessMode: 'write_only' },
  verdict: 'allow',
  tier: 'Rules',
  severity: 'info',
  riskScore: 0,
  riskName: '正常',
  riskCategory: 'other',
};
const resourceRelations = buildSemanticKernelRelations(
  resourceCall,
  undefined,
  interaction,
  [fileEvent],
  13,
  false,
);
assert.equal(resourceRelations[0].status, 'linked_exact');
assert.equal(resourceRelations[0].linkMethod, 'resource');
assert.equal(resourceRelations[0].kernelEventId, fileEvent.eventId);
assert.equal(resourceRelations[0].timeQuality, 'bounded');
assert.equal(toolEvidenceHotPathTesting.semanticKernelEventCategory(resourceCall), 'file');

const httpToolInteraction = {
  ...interaction,
  interactionType: 'tool',
  endpoint: 'python-sandbox:8080',
};
const httpToolCall = {
  ...toolCall,
  semanticEventId: 'se_http_tool_call',
  toolCallId: 'sandbox-execution-1',
  toolName: 'http.code.execute',
  toolKind: 'other',
  content: { code: 'print(42)', timeout_ms: 4_000 },
};
const sandboxEgress = {
  ...kernelEvent,
  eventId: 'evt_sandbox_egress',
  eventKind: 'Egress',
  subject: 'python-sandbox:8080',
  attributes: { host: 'python-sandbox' },
};
const httpToolRelations = buildSemanticKernelRelations(
  httpToolCall,
  toolResult,
  httpToolInteraction,
  [sandboxEgress],
  13,
  false,
);
assert.equal(httpToolRelations[0].status, 'linked_strong');
assert.equal(toolEvidenceHotPathTesting.semanticKernelEventCategory(httpToolCall), 'network');
assert.equal(httpToolRelations[0].linkMethod, 'network');
assert.equal(httpToolRelations[0].kernelEventId, sandboxEgress.eventId);
const resolvedServiceEgress = {
  ...sandboxEgress,
  eventId: 'evt_sandbox_cluster_ip_egress',
  subject: 'egress → 10.43.62.211:8080',
  attributes: { peer: '10.43.62.211', port: 8080 },
};
const resolvedServiceRelations = buildSemanticKernelRelations(
  httpToolCall,
  toolResult,
  httpToolInteraction,
  [resolvedServiceEgress],
  13,
  false,
);
assert.equal(resolvedServiceRelations[0].status, 'linked_strong');
assert.equal(resolvedServiceRelations[0].linkMethod, 'network_endpoint');
assert.equal(resolvedServiceRelations[0].kernelEventId, resolvedServiceEgress.eventId);
const ambiguousServiceEndpoint = buildSemanticKernelRelations(
  httpToolCall,
  toolResult,
  httpToolInteraction,
  [
    resolvedServiceEgress,
    { ...resolvedServiceEgress, eventId: 'evt_second_cluster_ip_egress' },
  ],
  13,
  false,
);
assert.equal(ambiguousServiceEndpoint[0].status, 'semantic_only');
assert.equal(ambiguousServiceEndpoint[0].kernelEventId, undefined);

const shellBootstrapEvent = {
  ...kernelEvent,
  eventId: 'evt_shell_bootstrap',
  at: new Date(callAt + 200).toISOString(),
  subject: '/bin/bash -c source /tmp/agent-shell-snapshot',
  process: {
    pid: 101,
    ppid: 100,
    comm: 'bash',
    hostId: 'host-semantic',
    bootId: 'boot-semantic',
  },
  attribution: { rootPid: 100 },
};
const shellBootstrapRelations = buildSemanticKernelRelations(
  toolCall,
  toolResult,
  interaction,
  [shellBootstrapEvent],
  13,
  false,
);
assert.equal(shellBootstrapRelations[0].status, 'linked_strong');
assert.equal(toolEvidenceHotPathTesting.semanticKernelEventCategory(toolCall), 'tool');
assert.equal(shellBootstrapRelations[0].linkMethod, 'shell_bootstrap');
assert.equal(shellBootstrapRelations[0].lineageMethod, 'direct_runtime');
assert.equal(shellBootstrapRelations[0].confidence, 0.95);
assert.equal(shellBootstrapRelations[0].kernelEventId, shellBootstrapEvent.eventId);

const ambiguousShellBootstrap = buildSemanticKernelRelations(
  toolCall,
  toolResult,
  interaction,
  [
    shellBootstrapEvent,
    { ...shellBootstrapEvent, eventId: 'evt_second_shell_bootstrap' },
  ],
  13,
  false,
);
assert.equal(ambiguousShellBootstrap[0].status, 'semantic_only');
assert.equal(ambiguousShellBootstrap[0].kernelEventId, undefined,
  'multiple direct-child shells must not be guessed from time and Runtime alone');

const timeOnly = buildSemanticKernelRelations(
  toolCall,
  toolResult,
  interaction,
  [{ ...unrelated, eventId: 'evt_time_only' }],
  14,
  false,
);
assert.equal(timeOnly.length, 1);
assert.equal(timeOnly[0].status, 'semantic_only',
  'time and Runtime identity alone must never invent a Kernel relation');
assert.equal(timeOnly[0].kernelEventId, undefined);

const coverageGap = buildSemanticKernelRelations(
  toolCall,
  toolResult,
  interaction,
  [],
  15,
  true,
);
assert.equal(coverageGap[0].status, 'coverage_gap');

const earlierCompetingCall = {
  ...toolCall,
  semanticEventId: 'se_earlier_competing_call',
  toolCallId: 'call-earlier-competing',
  atUnixNs: String(BigInt(callAt - 10_000) * 1_000_000n),
};
const earlierCompetingResult = {
  ...toolResult,
  semanticEventId: 'se_earlier_competing_result',
  toolCallId: earlierCompetingCall.toolCallId,
  atUnixNs: String(BigInt(callAt + 100) * 1_000_000n),
};
const batchWindow = semanticKernelRelationBatchWindow([
  { event: earlierCompetingCall, result: earlierCompetingResult, interaction },
  { event: toolCall, result: toolResult, interaction },
], { event: toolCall, result: toolResult, interaction });
assert.equal(batchWindow.startMs, callAt - 12_000);
assert.equal(batchWindow.endMs, callAt + 2_500,
  'a replacement batch must query the full union of every competing Tool interval');

const shellParent = {
  ...kernelEvent,
  eventId: 'evt_shell_parent',
  subject: '/bin/bash -c source shell-snapshot',
  correlation: { authority: 'server_process_graph', inferred: false },
  attribution: { processGenerationKey: `pgk_${'a'.repeat(24)}` },
  process: {
    pid: 220, ppid: 100, hostId: 'host-semantic', bootId: 'boot-semantic',
    startTimeTicks: '2200',
  },
};
const externalChild = {
  ...kernelEvent,
  eventId: 'evt_external_child',
  subject: '/usr/bin/printf ancestry-marker',
  agentRuntimeInstanceId: 'docker:physical-workload',
  correlation: { authority: 'server_process_graph', inferred: false },
  attribution: {
    processGenerationKey: `pgk_${'b'.repeat(24)}`,
    parentProcessGenerationKey: shellParent.attribution.processGenerationKey,
    parentLinkAuthority: 'forwarder_process_graph',
  },
  process: {
    pid: 221, ppid: 220, hostId: 'host-semantic', bootId: 'boot-semantic',
    startTimeTicks: '2210',
  },
};
const ancestryCall = {
  ...toolCall,
  semanticEventId: 'se_ancestry_tool',
  toolCallId: 'call-ancestry',
  content: { command: '/usr/bin/printf ancestry-marker' },
};
const ancestryRelations = buildSemanticKernelRelations(
  ancestryCall,
  toolResult,
  interaction,
  [externalChild, shellParent],
  16,
  false,
);
assert.equal(ancestryRelations[0].status, 'linked_strong');
assert.equal(ancestryRelations[0].confidence, 0.99);
assert.equal(ancestryRelations[0].kernelEventId, externalChild.eventId);
assert.equal(ancestryRelations[0].linkMethod, 'command');
assert.equal(ancestryRelations[0].lineageMethod, 'generation_parent');

const reusedOldParent = {
  ...shellParent,
  eventId: 'evt_reused_old_parent',
  attribution: { processGenerationKey: `pgk_${'c'.repeat(24)}` },
  process: { ...shellParent.process, startTimeTicks: '1000' },
};
const reusedNewParent = {
  ...shellParent,
  eventId: 'evt_reused_new_parent',
  agentRuntimeInstanceId: 'runtime-unrelated',
  attribution: { processGenerationKey: `pgk_${'d'.repeat(24)}` },
  process: { ...shellParent.process, startTimeTicks: '2000' },
};
const reusedPidChild = {
  ...externalChild,
  eventId: 'evt_child_of_reused_parent',
  agentRuntimeInstanceId: 'runtime-unrelated',
  attribution: {
    processGenerationKey: `pgk_${'e'.repeat(24)}`,
    parentProcessGenerationKey: reusedNewParent.attribution.processGenerationKey,
    parentLinkAuthority: 'forwarder_process_graph',
  },
  process: { ...externalChild.process, startTimeTicks: '2001' },
};
const reusedPidRelations = buildSemanticKernelRelations(
  ancestryCall,
  toolResult,
  interaction,
  [reusedPidChild, reusedOldParent, reusedNewParent],
  17,
  false,
);
assert.equal(reusedPidRelations[0].status, 'semantic_only');
assert.equal(reusedPidRelations[0].kernelEventId, undefined,
  'an old same-PID Agent parent must not own a child of the reused parent generation');

const unauthoritativeParentRelations = buildSemanticKernelRelations(
  ancestryCall,
  toolResult,
  interaction,
  [{
    ...externalChild,
    eventId: 'evt_external_child_without_parent_authority',
    attribution: {
      processGenerationKey: externalChild.attribution.processGenerationKey,
      parentProcessGenerationKey: externalChild.attribution.parentProcessGenerationKey,
    },
  }, shellParent],
  18,
  false,
);
assert.equal(unauthoritativeParentRelations[0].status, 'semantic_only');
assert.equal(unauthoritativeParentRelations[0].kernelEventId, undefined,
  'a parent generation key without its graph authority must not become ancestry evidence');

const duplicateCallA = {
  ...ancestryCall,
  semanticEventId: 'se_duplicate_call_a',
  toolCallId: 'call-duplicate-a',
};
const duplicateCallB = {
  ...ancestryCall,
  semanticEventId: 'se_duplicate_call_b',
  toolCallId: 'call-duplicate-b',
};
const duplicateKernelEvent = {
  ...kernelEvent,
  eventId: 'evt_one_exec_two_tools',
  subject: '/usr/bin/printf ancestry-marker',
};
const duplicateBatch = buildSemanticKernelRelationBatch([
  { event: duplicateCallA, result: toolResult, interaction },
  { event: duplicateCallB, result: toolResult, interaction },
], [duplicateKernelEvent], 19, false);
const duplicateRelationsA = duplicateBatch.relationsBySemanticEventId.get(duplicateCallA.semanticEventId);
const duplicateRelationsB = duplicateBatch.relationsBySemanticEventId.get(duplicateCallB.semanticEventId);
assert.equal(duplicateRelationsA?.[0].status, 'ambiguous');
assert.equal(duplicateRelationsB?.[0].status, 'ambiguous');
assert.equal(duplicateRelationsA?.[0].kernelEventId, duplicateKernelEvent.eventId);
assert.equal(duplicateRelationsA?.[0].risk, undefined);
assert.deepEqual(
  duplicateRelationsA?.[0].competingToolInvocationIds,
  duplicateRelationsB?.[0].competingToolInvocationIds,
);
assert.equal(duplicateRelationsA?.[0].competingToolInvocationIds?.length, 2);

let replacementQuery;
let replacementParameters;
const relationStore = Object.create(RelationalBusinessStore.prototype);
relationStore.initialize = async () => true;
relationStore.pool = {
  query: async (sql, parameters) => {
    replacementQuery = sql;
    replacementParameters = parameters;
    return { rows: [] };
  },
};
relationStore.markUnavailable = () => undefined;
assert.equal(await relationStore.saveAgentSemanticKernelRelations(duplicateBatch.allRelations), true);
assert.match(replacementQuery, /DELETE FROM anysentry_agent_semantic_kernel_relations_v1 AS existing/u);
assert.match(replacementQuery, /existing\.resolution_revision <= latest_incoming\.resolution_revision/u);
assert.match(replacementQuery, /NOT EXISTS/u);
assert.match(replacementQuery, /newer\.resolution_revision > \(incoming\.record->>'resolutionRevision'\)::bigint/u);
assert.equal(JSON.parse(replacementParameters[0]).length, 2,
  'one persistence call must atomically replace both competing semantic relation sets');

const captured = (structured, messages = [], text) => {
  const body = JSON.stringify(structured);
  return {
    body,
    encoding: 'utf8',
    contentType: 'application/json',
    capturedBytes: Buffer.byteLength(body),
    decodedBytes: Buffer.byteLength(body),
    sha256: 'a'.repeat(64),
    completeness: 'complete',
    messages,
    structured,
    ...(text === undefined ? {} : { text }),
  };
};
const projectedInteraction = {
  schemaVersion: 'anysentry.agent_interaction.v1',
  interactionId: 'mi_incremental_relation_projection',
  interactionType: 'model',
  at: callAt,
  workspacePath: '/workspace',
  agentAssetId: 'agent-semantic',
  agentInstanceId: instanceId,
  agentProduct: 'Codex',
  detectedClassification: 'confirmed_agent',
  currentEffectiveClassification: 'confirmed_agent',
  process: {
    hostId: 'host-semantic', bootId: 'boot-semantic', pid: 100, ppid: 1,
    startTimeTicks: '200', comm: 'codex', exe: '/usr/bin/codex', cwd: '/workspace',
  },
  connectionId: 'tls:incremental',
  transport: 'tls',
  protocol: 'websocket-json',
  wireTemplateId: 'openai-responses',
  parseState: 'parsed',
  llmLikelihood: 'confirmed',
  endpoint: 'gateway.invalid',
  method: 'POST',
  path: '/responses',
  statusCode: 200,
  model: 'fixture-model',
  startedAtUnixNs: String(BigInt(callAt) * 1_000_000n),
  requestCompleteAtUnixNs: String(BigInt(callAt + 1) * 1_000_000n),
  firstResponseAtUnixNs: String(BigInt(callAt + 2) * 1_000_000n),
  endedAtUnixNs: String(BigInt(callAt + 3) * 1_000_000n),
  durationNs: '3000000',
  timeQuality: 'collector_calibrated',
  request: captured(
    { model: 'fixture-model', input: [{ role: 'user', content: 'run the command' }] },
    [{ role: 'user', content: 'run the command', messageOrigin: 'human_input' }],
  ),
  response: captured({
    id: 'resp-incremental', object: 'response', status: 'completed', output: [],
  }),
  toolCalls: [{
    toolCallId: toolCall.toolCallId,
    name: 'exec_command',
    arguments: toolCall.content,
    issuedAtUnixNs: toolCall.atUnixNs,
  }],
  toolResults: [],
  semanticParserId: 'observer.agent-interaction',
  semanticParserVersion: 2,
  completeness: 'partial',
  conversationCompleteness: 'tool_pending',
  partialReasons: ['tool_result_pending'],
  captureSource: 'tls_uprobe_rustls',
  receivedAt: callAt + 4,
};

const fastConversationId = 'cv_persisted_evidence_fast_path';
const fastInteraction = {
  ...projectedInteraction,
  conversationId: fastConversationId,
  conversationIdSource: 'provider',
  conversationBindingVersion: 2,
  trafficRole: 'conversation',
};
const fastQuery = {
  timeType: 'last_30d',
  scope: 'agent',
  classificationView: 'current_effective',
  conversationId: fastConversationId,
  limit: 200,
};
const fastProjection = projectAgentConversations([fastInteraction], [], fastQuery);
const fastThread = fastProjection.summaries.find((item) =>
  item.conversationId === fastConversationId);
const fastRecords = fastProjection.interactionsByConversation.get(fastConversationId) ?? [];
assert.ok(fastThread?.hasContent);
const fastToolCall = projectSemanticConversationTimeline(fastThread, fastRecords, [])
  .flatMap((turn) => turn.events)
  .find((event) => event.kind === 'tool_call');
assert.ok(fastToolCall);
const persistedFastRelation = {
  ...relations[0],
  relationId: 'skr_persisted_fast_path',
  stableSemanticEventId: fastToolCall.semanticEventId,
  conversationId: fastConversationId,
  turnId: fastToolCall.turnId,
  toolInvocationId: 'ti_persisted_fast_path',
  resolutionRevision: 99,
};
let fastKernelQueries = 0;
const fastEvidenceAggregate = new AggregationService(
  {},
  {
    identitySnapshotVersion: () => 0,
    canonicalAgentAssetId: (value) => value,
  },
  {},
  {},
  {},
  undefined,
  {
    segmentsForConversation: () => [],
    currentResolutionRevision: () => 99,
  },
  {
    configured: () => true,
    loadAgentSemanticKernelRelations: async () => [persistedFastRelation],
  },
);
fastEvidenceAggregate.agentConversationProjection = async () => ({
  projection: fastProjection,
  interactions: {
    items: [fastInteraction],
    coverage: {
      partial: false,
      completeness: 'exact_current_effective',
      source: 'clickhouse+hot_delta',
      totalMode: 'exact',
    },
  },
  inventory: { items: [], coverage: { partial: true, partialReason: 'hot_ring_only' } },
  canonicalConversationId: fastConversationId,
});
fastEvidenceAggregate.storedAgentEvents = async () => {
  fastKernelQueries += 1;
  throw new Error('persisted evidence fast path must not query the Event table');
};
const fastEvidence = await fastEvidenceAggregate.agentSemanticEvidence({
  ...fastQuery,
  semanticEventId: fastToolCall.semanticEventId,
});
assert.equal(fastKernelQueries, 0);
assert.equal(fastEvidence.relationStatus, 'linked_exact');
assert.equal(fastEvidence.relations[0].kernelEventId, kernelEvent.eventId);
assert.deepEqual(fastEvidence.kernelEvents, []);
assert.deepEqual(fastEvidence.evidenceBundleEventIds, [kernelEvent.eventId]);
assert.equal(fastEvidence.coverage.partial, false);

let projectionPersisted = 0;
let incrementallySavedRelations = [];
const bindingStub = {
  applyPersistedBindings: async (items) => items,
  persistProjection: async () => { projectionPersisted += 1; },
  segmentsForConversation: () => [],
  currentResolutionRevision: () => 22,
};
const incrementalStore = {
  configured: () => true,
  saveAgentSemanticKernelRelations: async (items) => {
    incrementallySavedRelations = items;
    return true;
  },
};
const aggregate = new AggregationService(
  {},
  { canonicalAgentAssetId: (value) => value },
  {},
  {},
  {},
  undefined,
  bindingStub,
  incrementalStore,
);
aggregate.readAgentInteractions = async () => ({
  items: [projectedInteraction],
  total: 1,
  totalMode: 'exact',
  coverage: { partial: false },
  dataSource: 'clickhouse',
  updateTime: new Date(callAt).toISOString(),
});
aggregate.storedAgentEvents = async () => ({
  items: [kernelEvent],
  total: 1,
  totalMode: 'exact',
  coverage: { partial: false },
  dataSource: 'clickhouse',
  updateTime: new Date(callAt).toISOString(),
});
await aggregate.projectSemanticKernelRelationsFor(projectedInteraction);
assert.equal(projectionPersisted, 1,
  'incremental relation work must persist the Conversation projection outside the read path');
assert.equal(incrementallySavedRelations.length, 1);
assert.equal(incrementallySavedRelations[0].kernelEventId, kernelEvent.eventId);
assert.equal(incrementallySavedRelations[0].kernelEventAt, kernelEvent.at);

console.log('Agent Semantic Tool to Kernel relation verification passed');
