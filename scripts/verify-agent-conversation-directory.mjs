import assert from 'node:assert/strict';

import { projectAgentConversationDirectory } from '../apps/api/dist/security-monitoring/agent-conversation-directory.js';
import {
  projectAgentConversations,
  projectConversationTimeline,
} from '../apps/api/dist/security-monitoring/agent-conversation.js';
import {
  projectSemanticConversationTimeline,
  semanticItemsForInteraction,
} from '../apps/api/dist/security-monitoring/agent-semantic-timeline.js';

const coverage = (status = 'complete') => ({
  status,
  reasons: status === 'complete' ? [] : ['fixture_reason'],
  completeInteractions: status === 'complete' ? 1 : 0,
  partialInteractions: status === 'complete' ? 0 : 1,
});

const conversation = ({
  conversationId,
  agentAssetId,
  agentInstanceIds,
  product = 'codex-cli',
  workspacePath = '/workspace/repo',
  environment = 'docker',
  at,
  status = 'complete',
}) => ({
  conversationId,
  idSource: 'inferred',
  hasContent: status === 'complete',
  agentAssetId,
  agentInstanceIds,
  agentProduct: product,
  displayName: product,
  environment,
  classification: 'confirmed_agent',
  workspacePath,
  startedAtUnixNs: at,
  lastActivityAtUnixNs: at,
  firstPromptPreview: 'fixture prompt',
  turnCount: 1,
  modelCallCount: status === 'complete' ? 1 : 0,
  toolCallCount: 0,
  toolResultCount: 0,
  errorCount: status === 'complete' ? 0 : 1,
  models: status === 'complete' ? ['fixture-model'] : [],
  coverage: coverage(status),
});

const runtime = (
  agentInstanceId,
  runtimeState,
  product = 'codex',
  workspacePath = '/workspace/repo',
  physicalWorkloadId,
) => ({
  agentScopeId: 'scope-' + agentInstanceId,
  agentDisplayName: product,
  agentInstanceId,
  runtimeState,
  rootPid: 10,
  rootStartTimeTicks: '1',
  rootGeneration: 1,
  hostId: 'fixture-host',
  bootId: 'fixture-boot',
  workspacePath,
  physicalWorkloadId,
  discoveredAt: 1,
  lastSeenAt: 2,
  collectorId: 'fixture-collector',
  forwarderInstanceId: 'fixture-forwarder',
  leaseEpoch: 1,
  snapshotVersion: 1,
  snapshotHash: 'a'.repeat(64),
  filterMode: 'enforce',
  receivedAt: 2,
});

const items = projectAgentConversationDirectory([
  conversation({
    conversationId: 'cv-codex-a',
    agentAssetId: 'asset-codex-a',
    agentInstanceIds: ['instance-a'],
    environment: 'host',
    at: '1788000000000000001',
  }),
  conversation({
    conversationId: 'cv-codex-b',
    agentAssetId: 'asset-codex-b',
    agentInstanceIds: ['instance-b'],
    environment: 'unknown',
    at: '1788000000000000002',
  }),
  conversation({
    conversationId: 'cv-claude',
    agentAssetId: 'asset-claude',
    agentInstanceIds: ['instance-claude'],
    product: 'claude-code',
    at: '1788000000000000003',
  }),
], [
  runtime('instance-a', 'running'),
  runtime('instance-b', 'running'),
  runtime('instance-claude', 'exited', 'claude'),
  {
    ...runtime('instance-langchain', 'running', 'LangChain'),
    workspacePath: undefined,
    agentScopeId: 'langchain-runtime',
  },
], 'all');

assert.equal(items.length, 3);
const codex = items.find((item) => item.product === 'Codex');
const claude = items.find((item) => item.product === 'Claude Code');
const langchain = items.find((item) => item.product === 'LangChain');
assert(codex);
assert(claude);
assert(langchain);
assert.equal(codex.lifecycleState, 'running');
assert.equal(codex.environment, 'host');
assert.equal(codex.activeInstanceCount, 2);
assert.equal(codex.totalInstanceCount, 2);
assert.equal(codex.conversationCount, 2);
assert.deepEqual(codex.agentAssetIds.sort(), ['asset-codex-a', 'asset-codex-b']);
assert.equal(codex.conversations[0].conversationId, 'cv-codex-b');
assert.equal(claude.lifecycleState, 'historical');
assert.equal(langchain.lifecycleState, 'running');
assert.equal(langchain.conversationCount, 0);
assert.equal(langchain.conversations.length, 0);

const runningOnly = projectAgentConversationDirectory(
  items.flatMap((item) => item.conversations),
  [
    runtime('instance-a', 'running'),
    runtime('instance-b', 'running'),
    {
      ...runtime('instance-langchain', 'running', 'LangChain'),
      workspacePath: undefined,
      agentScopeId: 'langchain-runtime',
    },
  ],
  'running',
);
assert.equal(runningOnly.length, 2);
assert.deepEqual(runningOnly.map((item) => item.product).sort(), ['Codex', 'LangChain']);

const aliasFallback = projectAgentConversationDirectory([
  conversation({
    conversationId: 'cv-codex-legacy',
    agentAssetId: 'asset-codex-legacy',
    agentInstanceIds: ['legacy-instance-id'],
    at: '1788000000000000004',
  }),
], [runtime('current-runtime-id', 'running')], 'all');
assert.equal(aliasFallback[0].lifecycleState, 'running');
assert.equal(aliasFallback[0].activeInstanceCount, 1);

const syntheticDify = projectAgentConversationDirectory([
  conversation({
    conversationId: 'cv-dify-a',
    agentAssetId: 'asset-dify-a',
    agentInstanceIds: ['docker:fixture:dify-a'],
    product: 'dify-worker',
    workspacePath: 'agent://container-a',
    environment: 'host',
    at: '1788000000000000005',
  }),
  conversation({
    conversationId: 'cv-dify-b',
    agentAssetId: 'asset-dify-b',
    agentInstanceIds: ['docker:fixture:dify-b'],
    product: 'Dify',
    workspacePath: 'agent://container-b',
    environment: 'docker',
    at: '1788000000000000006',
  }),
], [
  runtime('docker:fixture:dify-a', 'running', 'Dify', null, 'docker:container-a'),
  runtime('docker:fixture:dify-b', 'running', 'dify-worker', null, 'docker:container-b'),
  runtime('docker:fixture:dify-c', 'running', 'Dify', null, 'docker:container-c'),
  runtime('docker:fixture:dify-d', 'running', 'Dify', null, 'docker:container-d'),
], 'all');
assert.equal(syntheticDify.length, 1);
assert.equal(syntheticDify[0].product, 'Dify');
assert.equal(syntheticDify[0].workspacePath, 'agent-scope:dify');
assert.equal(syntheticDify[0].environment, 'docker');
assert.equal(syntheticDify[0].groupingQuality, 'inferred');
assert.equal(syntheticDify[0].lifecycleState, 'running');
assert.equal(syntheticDify[0].activeInstanceCount, 4);
assert.equal(syntheticDify[0].totalInstanceCount, 4);
assert.equal(syntheticDify[0].conversationCount, 2);

const realWorkspaceIsolation = projectAgentConversationDirectory([
  conversation({
    conversationId: 'cv-dify-project-a',
    agentAssetId: 'asset-dify-project-a',
    agentInstanceIds: ['dify-project-a'],
    product: 'Dify',
    workspacePath: '/srv/project-a',
    environment: 'docker',
    at: '1788000000000000007',
  }),
  conversation({
    conversationId: 'cv-dify-project-b',
    agentAssetId: 'asset-dify-project-b',
    agentInstanceIds: ['dify-project-b'],
    product: 'Dify',
    workspacePath: '/srv/project-b',
    environment: 'docker',
    at: '1788000000000000008',
  }),
], [], 'all');
assert.equal(realWorkspaceIsolation.length, 2);
assert.deepEqual(
  realWorkspaceIsolation.map((item) => item.workspacePath).sort(),
  ['/srv/project-a', '/srv/project-b'],
);

const content = (body, messages = []) => ({
  body,
  encoding: 'utf8',
  contentType: 'application/json',
  capturedBytes: body.length,
  decodedBytes: body.length,
  sha256: body.padEnd(64, '0').slice(0, 64),
  completeness: 'complete',
  messages,
});
const projectionInteraction = ({
  interactionId,
  at,
  requestBody,
  responseText,
  responseStructured,
  providerResponseId,
  providerPreviousResponseId,
  toolCalls = [],
  toolResults = [],
  completeness = 'complete',
  partialReasons = [],
  agentInstanceId = 'host-root:fixture:codex',
  agentProduct = 'Codex',
  workspacePath = '/workspace/codex',
  requestMessages,
}) => ({
  schemaVersion: 'anysentry.agent_interaction.v1',
  interactionId,
  interactionType: 'model',
  at,
  workspacePath,
  agentAssetId: 'agent-codex-projection',
  agentInstanceId,
  agentProduct,
  detectedClassification: 'confirmed_agent',
  currentEffectiveClassification: 'confirmed_agent',
  connectionId: 'tls:codex-projection',
  transport: 'tls',
  protocol: 'websocket-json',
  transportProtocol: 'websocket',
  wireTemplateId: 'openai-responses',
  parseState: 'parsed',
  llmLikelihood: 'confirmed',
  endpoint: 'fixture.invalid',
  method: 'POST',
  path: '/v1/responses',
  statusCode: 200,
  model: 'fixture-model',
  providerResponseId,
  providerPreviousResponseId,
  startedAtUnixNs: String(BigInt(at) * 1_000_000n),
  requestCompleteAtUnixNs: String(BigInt(at + 1) * 1_000_000n),
  firstResponseAtUnixNs: String(BigInt(at + 2) * 1_000_000n),
  endedAtUnixNs: String(BigInt(at + 3) * 1_000_000n),
  durationNs: '3000000',
  timeQuality: 'collector_calibrated',
  request: content(requestBody, requestMessages ?? [{
      role: toolResults.length ? 'custom_tool_call_output' : 'user',
      content: requestBody,
      ...(toolResults[0] ? { toolCallId: toolResults[0].toolCallId } : {}),
    }]),
  response: {
    ...content(responseText),
    text: responseText,
    ...(responseStructured ? { structured: responseStructured } : {}),
  },
  toolCalls,
  toolResults,
  completeness,
  partialReasons,
  captureSource: 'tls_uprobe_rustls',
  receivedAt: at + 4,
});

const callId = 'call-cross-interaction';
const projectedToolLoop = projectAgentConversations([
  projectionInteraction({
    interactionId: 'mi-tool-pending',
    at: 1_788_060_000_000,
    requestBody: 'USER_TOOL_REQUEST',
    responseText: 'TOOL_WILL_RUN',
    providerResponseId: 'resp-tool-pending',
    toolCalls: [{
      toolCallId: callId,
      name: 'exec',
      arguments: { cmd: 'printf fixture' },
      issuedAtUnixNs: '1788060000002000000',
    }],
    completeness: 'partial',
    partialReasons: ['tool_result_pending'],
  }),
  projectionInteraction({
    interactionId: 'mi-tool-result-final',
    at: 1_788_060_000_010,
    requestBody: 'TOOL_RESULT_FIXTURE',
    responseText: 'FINAL_RESPONSE_FIXTURE',
    providerResponseId: 'resp-tool-final',
    providerPreviousResponseId: 'resp-tool-pending',
    toolResults: [{
      toolCallId: callId,
      content: 'TOOL_RESULT_FIXTURE',
      isError: false,
      observedAtUnixNs: '1788060000010000000',
    }],
  }),
], [], { timeType: 'last_30d', scope: 'agent', limit: 20 });
assert.equal(projectedToolLoop.summaries.length, 1);
const resolvedToolLoop = projectedToolLoop.summaries[0];
assert.equal(resolvedToolLoop.toolCallCount, 1);
assert.equal(resolvedToolLoop.toolResultCount, 1);
assert.equal(resolvedToolLoop.errorCount, 0);
assert.equal(resolvedToolLoop.coverage.status, 'complete');
assert.deepEqual(resolvedToolLoop.coverage.reasons, []);
assert.deepEqual(
  projectConversationTimeline(
    resolvedToolLoop,
    projectedToolLoop.interactionsByConversation.get(resolvedToolLoop.conversationId),
  ).map((item) => item.kind),
  ['model_request', 'model_response', 'tool_call', 'tool_result', 'model_request', 'model_response'],
);
const semanticToolLoop = projectSemanticConversationTimeline(
  resolvedToolLoop,
  projectedToolLoop.interactionsByConversation.get(resolvedToolLoop.conversationId),
  [{
    schemaVersion: 'anysentry.agent_conversation_segment.v1',
    segmentId: 'seg-semantic-fixture',
    conversationId: resolvedToolLoop.conversationId,
    agentInstanceId: 'host-root:fixture:codex',
    ordinal: 1,
    startedAtUnixNs: '1788060000000000000',
    endedAtUnixNs: '1788060000013000000',
    firstInteractionId: 'mi-tool-pending',
    lastInteractionId: 'mi-tool-result-final',
    interactionCount: 2,
    correlationQuality: 'exact',
    resolverVersion: 1,
    updatedAt: 1_788_060_000_014,
  }],
);
assert.deepEqual(
  semanticToolLoop.flatMap((turn) => turn.events.map((event) => event.kind)),
  ['user_message', 'model_progress', 'tool_call', 'tool_result', 'model_final'],
  'the semantic timeline must keep the final model reply separate from the tool result',
);
assert.deepEqual(
  [...new Set(semanticToolLoop.flatMap((turn) => turn.events.map((event) => event.actor)))].sort(),
  ['model', 'tool', 'user'],
);
assert.equal(semanticToolLoop.flatMap((turn) => turn.diagnostics).length, 0,
  'a later matching tool result must resolve the earlier tool-pending diagnostic');

const cumulativeClaudeResults = projectAgentConversations([
  projectionInteraction({
    interactionId: 'mi-claude-result-first',
    at: 1_788_060_050_000,
    requestBody: 'CLAUDE_TOOL_RESULT_FIRST',
    responseText: 'CLAUDE_CONTINUES',
    providerResponseId: 'msg-claude-first',
    toolResults: [{
      toolCallId: 'toolu-cumulative-1',
      content: [{ type: 'text', text: 'CUMULATIVE_RESULT' }],
      isError: false,
      observedAtUnixNs: '1788060050000000000',
    }],
  }),
  projectionInteraction({
    interactionId: 'mi-claude-result-repeated',
    at: 1_788_060_050_010,
    requestBody: 'CLAUDE_TOOL_RESULT_REPEATED',
    responseText: 'CLAUDE_FINAL',
    providerResponseId: 'msg-claude-final',
    providerPreviousResponseId: 'msg-claude-first',
    toolResults: [{
      toolCallId: 'toolu-cumulative-1',
      content: [{ type: 'text', text: 'CUMULATIVE_RESULT' }],
      isError: false,
      observedAtUnixNs: '1788060050010000000',
    }],
  }),
], [], { timeType: 'last_30d', scope: 'agent', limit: 20 });
assert.equal(cumulativeClaudeResults.summaries.length, 1);
assert.equal(cumulativeClaudeResults.summaries[0].toolResultCount, 1,
  'a cumulative provider request must not duplicate an identical tool result');
assert.equal(
  projectConversationTimeline(
    cumulativeClaudeResults.summaries[0],
    cumulativeClaudeResults.interactionsByConversation.get(
      cumulativeClaudeResults.summaries[0].conversationId,
    ),
  ).filter((item) => item.kind === 'tool_result').length,
  1,
);

const pollutedResponsesProjection = projectAgentConversations([
  projectionInteraction({
    interactionId: 'mi-old-responses-tool-delta',
    at: 1_788_060_075_000,
    requestBody: 'RUN_OLD_CUSTOM_TOOL',
    responseText: 'tools.exec_command({"cmd":"pwd"})',
    responseStructured: [{
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'custom_tool_call', call_id: 'call-old-delta', name: 'exec' },
    }, {
      type: 'response.custom_tool_call_input.delta',
      output_index: 0,
      delta: 'tools.exec_command({"cmd":"pwd"})',
    }, {
      type: 'response.completed',
      response: { id: 'resp-old-delta' },
    }],
    providerResponseId: 'resp-old-delta',
    toolCalls: [{
      toolCallId: 'call-old-delta',
      name: 'exec',
      arguments: 'tools.exec_command({"cmd":"pwd"})',
      issuedAtUnixNs: '1788060075002000000',
    }],
  }),
], [], { timeType: 'last_30d', scope: 'agent', limit: 20 });
const pollutedTimeline = projectConversationTimeline(
  pollutedResponsesProjection.summaries[0],
  pollutedResponsesProjection.interactionsByConversation.get(
    pollutedResponsesProjection.summaries[0].conversationId,
  ),
);
assert.equal(pollutedTimeline.some((item) => item.kind === 'model_response'), false,
  'historical custom-tool delta bytes must not be displayed as a model reply');
assert.equal(pollutedTimeline.some((item) => item.kind === 'tool_call'), true);

const injectedContextInteraction = projectionInteraction({
  interactionId: 'mi-injected-context-filter',
  at: 1_788_060_080_000,
  requestBody: 'VISIBLE_HUMAN_PROMPT',
  responseText: 'VISIBLE_MODEL_REPLY',
  requestMessages: [
    { role: 'user', content: [{ type: 'input_text', text: '<environment_context>injected</environment_context>' }] },
    { role: 'user', content: [{ type: 'input_text', text: 'VISIBLE_HUMAN_PROMPT' }] },
  ],
});
injectedContextInteraction.semanticItems = [{
  semanticItemId: 'si_111111111111111111111111',
  actor: 'user',
  kind: 'user_message',
  phase: 'final',
  origin: 'request',
  atUnixNs: injectedContextInteraction.startedAtUnixNs,
  content: [{ type: 'input_text', text: '<environment_context>injected</environment_context>' }],
  completeness: 'complete',
  partialReasons: [],
}, {
  semanticItemId: 'si_222222222222222222222222',
  actor: 'user',
  kind: 'user_message',
  phase: 'final',
  origin: 'request',
  atUnixNs: injectedContextInteraction.startedAtUnixNs,
  content: [{ type: 'input_text', text: 'VISIBLE_HUMAN_PROMPT' }],
  completeness: 'complete',
  partialReasons: [],
}];
const visibleUserItems = semanticItemsForInteraction(injectedContextInteraction)
  .filter((item) => item.kind === 'user_message');
assert.equal(visibleUserItems.length, 1,
  'framework-injected environment_context must not be displayed as a human message');
assert.match(JSON.stringify(visibleUserItems[0].content), /VISIBLE_HUMAN_PROMPT/u);

const crossDaySameProcess = projectAgentConversations([
  projectionInteraction({
    interactionId: 'mi-cross-day-first',
    at: 1_788_100_000_000,
    requestBody: 'CROSS_DAY_FIRST',
    responseText: 'FIRST_REPLY',
    requestMessages: [{ role: 'user', content: 'CROSS_DAY_FIRST' }],
  }),
  projectionInteraction({
    interactionId: 'mi-cross-day-second',
    at: 1_788_100_000_000 + 25 * 60 * 60 * 1_000,
    requestBody: 'CROSS_DAY_SECOND',
    responseText: 'SECOND_REPLY',
    requestMessages: [
      { role: 'user', content: 'CROSS_DAY_FIRST' },
      { role: 'user', content: 'CROSS_DAY_SECOND' },
    ],
  }),
], [], { timeType: 'last_30d', scope: 'agent', limit: 20 });
assert.equal(crossDaySameProcess.summaries.length, 1,
  'idle time alone must not split a still-running CLI thread');
assert.equal(crossDaySameProcess.summaries[0].turnCount, 2);

const resumedAcrossProcesses = projectAgentConversations([
  projectionInteraction({
    interactionId: 'mi-resume-old-process',
    at: 1_788_200_000_000,
    requestBody: 'RESUME_FIRST',
    responseText: 'OLD_PROCESS_REPLY',
    agentInstanceId: 'host-root:fixture:old-process',
    requestMessages: [{ role: 'user', content: 'RESUME_FIRST' }],
  }),
  projectionInteraction({
    interactionId: 'mi-resume-new-process',
    at: 1_788_200_100_000,
    requestBody: 'RESUME_SECOND',
    responseText: 'NEW_PROCESS_REPLY',
    agentInstanceId: 'host-root:fixture:new-process',
    requestMessages: [
      { role: 'user', content: 'RESUME_FIRST' },
      { role: 'user', content: 'RESUME_SECOND' },
    ],
  }),
], [], { timeType: 'last_30d', scope: 'agent', limit: 20 });
assert.equal(resumedAcrossProcesses.summaries.length, 1,
  'a strictly extended CLI lineage must resume the prior Thread across process generations');
assert.deepEqual(
  resumedAcrossProcesses.summaries[0].agentInstanceIds.sort(),
  ['host-root:fixture:new-process', 'host-root:fixture:old-process'],
);

const freshRestartSamePrompt = projectAgentConversations([
  projectionInteraction({
    interactionId: 'mi-fresh-old-process',
    at: 1_788_300_000_000,
    requestBody: 'REPEATED_FIRST_PROMPT',
    responseText: 'OLD_FRESH_REPLY',
    agentInstanceId: 'host-root:fixture:fresh-old',
    requestMessages: [{ role: 'user', content: 'REPEATED_FIRST_PROMPT' }],
  }),
  projectionInteraction({
    interactionId: 'mi-fresh-new-process',
    at: 1_788_300_100_000,
    requestBody: 'REPEATED_FIRST_PROMPT',
    responseText: 'NEW_FRESH_REPLY',
    agentInstanceId: 'host-root:fixture:fresh-new',
    requestMessages: [{ role: 'user', content: 'REPEATED_FIRST_PROMPT' }],
  }),
], [], { timeType: 'last_30d', scope: 'agent', limit: 20 });
assert.equal(freshRestartSamePrompt.summaries.length, 2,
  'an equal one-message lineage is ambiguous and must not merge two process generations');

const unresolvedToolLoop = projectAgentConversations([
  projectionInteraction({
    interactionId: 'mi-unresolved-tool-call',
    at: 1_788_060_100_000,
    requestBody: 'UNRESOLVED_TOOL_REQUEST',
    responseText: 'UNRESOLVED_TOOL_WILL_RUN',
    providerResponseId: 'resp-unresolved-tool',
    toolCalls: [{
      toolCallId: 'call-still-pending',
      name: 'exec',
      arguments: { cmd: 'printf pending' },
      issuedAtUnixNs: '1788060100002000000',
    }],
  }),
], [], { timeType: 'last_30d', scope: 'agent', limit: 20 });
const unresolvedSummary = unresolvedToolLoop.summaries[0];
assert.equal(unresolvedSummary.errorCount, 1);
assert.equal(unresolvedSummary.coverage.status, 'partial');
assert.deepEqual(unresolvedSummary.coverage.reasons, ['tool_result_pending']);
assert.equal(
  projectConversationTimeline(
    unresolvedSummary,
    unresolvedToolLoop.interactionsByConversation.get(unresolvedSummary.conversationId),
  ).at(-1).kind,
  'error',
);
const unresolvedSemanticTimeline = projectSemanticConversationTimeline(
  unresolvedSummary,
  unresolvedToolLoop.interactionsByConversation.get(unresolvedSummary.conversationId),
  [],
);
assert.equal(
  unresolvedSemanticTimeline.flatMap((turn) => turn.diagnostics)
    .some((diagnostic) => diagnostic.type === 'capture_gap'
      && diagnostic.message.includes('90 秒')),
  true,
  'a stale unresolved tool call must become an explicit capture gap',
);

console.log('agent conversation directory verification passed');
