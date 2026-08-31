#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildSemanticKernelRelations,
  toolInvocationId,
} = require('../apps/api/dist/security-monitoring/agent-semantic-kernel-relation.js');

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

console.log('Agent Semantic Tool to Kernel relation verification passed');
