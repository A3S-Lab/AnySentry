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

console.log('Agent Semantic Tool to Kernel relation verification passed');
