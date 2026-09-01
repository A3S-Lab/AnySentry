#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  resolveAgentConversationsV2,
} = require('../apps/api/dist/security-monitoring/agent-conversation-resolution-v2.js');
const {
  projectAgentConversations,
} = require('../apps/api/dist/security-monitoring/agent-conversation.js');
const {
  projectContextReplaySummaries,
  projectSemanticConversationTimeline,
} = require('../apps/api/dist/security-monitoring/agent-semantic-timeline.js');

const digest = (value) => createHash('sha256').update(value).digest('hex');
const content = (structured, messages = [], text) => {
  const body = JSON.stringify(structured);
  return {
    body,
    encoding: 'utf8',
    contentType: 'application/json',
    capturedBytes: Buffer.byteLength(body),
    decodedBytes: Buffer.byteLength(body),
    sha256: digest(body),
    completeness: 'complete',
    messages,
    structured,
    ...(text === undefined ? {} : { text }),
  };
};
const human = (id, turnId, value) => ({
  type: 'message',
  id,
  role: 'user',
  content: [{ type: 'input_text', text: value }],
  internal_chat_message_metadata_passthrough: {
    turn_id: turnId,
    content_item_kinds: ['user.text'],
  },
});
const developer = (id, value) => ({
  type: 'message',
  id,
  role: 'developer',
  content: [{ type: 'input_text', text: value }],
  internal_chat_message_metadata_passthrough: {
    content_item_kinds: ['model.base_instructions'],
  },
});
const toolOutput = (id, turnId, callId, value) => ({
  type: 'custom_tool_call_output',
  id,
  call_id: callId,
  output: value,
  internal_chat_message_metadata_passthrough: { turn_id: turnId },
});

function interaction({
  id,
  at,
  instance,
  request,
  responseId,
  previousResponseId,
  conversationId,
  providerConversationId,
  interactionType = 'model',
  toolCalls = [],
  toolResults = [],
  responseText = 'ok',
  path = '/backend-api/codex/responses',
  agentProduct = 'Codex',
  workspacePath = '/workspace/resolver-v2',
  statusCode = 200,
  completeness = 'complete',
  partialReasons = [],
  conversationCompleteness,
}) {
  const messages = (request.input ?? request.messages ?? []).map((item) => ({
    role: item.role ?? item.type ?? 'input',
    content: item.content ?? item.output ?? item,
    ...(item.id ? { sourceItemId: item.id } : {}),
    ...(item.call_id ? { toolCallId: item.call_id } : {}),
  }));
  return {
    schemaVersion: 'anysentry.agent_interaction.v1',
    interactionId: id,
    interactionType,
    at,
    workspacePath,
    agentAssetId: instance.includes('two') ? 'agent-alias-new' : 'agent-alias-old',
    agentInstanceId: instance,
    agentProduct,
    providerConversationId,
    providerResponseId: responseId,
    providerPreviousResponseId: previousResponseId,
    conversationId,
    conversationIdSource: conversationId ? 'provider' : undefined,
    conversationBindingVersion: conversationId ? 1 : undefined,
    detectedClassification: 'confirmed_agent',
    currentEffectiveClassification: 'confirmed_agent',
    process: {
      hostId: 'host-v2',
      bootId: 'boot-v2',
      pid: at % 100_000,
      ppid: 1,
      startTimeTicks: String(at),
      comm: 'codex',
      exe: '/usr/bin/codex',
      cwd: workspacePath,
    },
    connectionId: 'tls:' + id,
    transport: 'tls',
    protocol: interactionType === 'tool' ? 'http/1.1' : 'websocket-json',
    wireTemplateId: interactionType === 'tool' ? 'mcp-jsonrpc' : 'openai-responses',
    parseState: 'parsed',
    llmLikelihood: 'confirmed',
    conversationCompleteness,
    endpoint: 'gateway.invalid',
    method: 'POST',
    path,
    statusCode,
    model: interactionType === 'model' ? 'fixture-model' : undefined,
    startedAtUnixNs: String(BigInt(at) * 1_000_000n),
    requestCompleteAtUnixNs: String(BigInt(at + 1) * 1_000_000n),
    firstResponseAtUnixNs: String(BigInt(at + 2) * 1_000_000n),
    endedAtUnixNs: String(BigInt(at + 3) * 1_000_000n),
    durationNs: '3000000',
    timeQuality: 'collector_calibrated',
    request: content(request, messages),
    response: content(responseId ? { id: responseId, output: [] } : { result: {} }, [], responseText),
    toolCalls,
    toolResults,
    semanticParserId: 'observer.agent-interaction',
    semanticParserVersion: 1,
    completeness,
    partialReasons,
    captureSource: 'tls_uprobe_rustls',
    receivedAt: at + 4,
  };
}

const base = 1_788_500_000_000;
const continuityKey = 'stable-resume-key';
const h0 = human('msg-h0', 'turn-h0', 'initial prompt');
const h1 = human('msg-h1', 'turn-h1', 'what tools are available');
const h2 = human('msg-h2', 'turn-h2', 'run the connectivity test');
const h3 = human('msg-h3', 'turn-h3', 'resume the terminal session');
const context = {
  type: 'message',
  id: 'msg-context',
  role: 'user',
  content: [{ type: 'input_text', text: 'runtime instructions' }],
  internal_chat_message_metadata_passthrough: {
    turn_id: 'turn-h0',
    content_item_kinds: ['agents_md.instructions'],
  },
};

const seed = interaction({
  id: 'mi_v2_seed',
  at: base,
  instance: 'host-root:v2:one',
  conversationId: 'cv_seed_existing',
  responseId: 'resp-seed',
  request: {
    model: 'fixture-model',
    prompt_cache_key: continuityKey,
    input: [developer('msg-dev', 'developer instructions'), context, h0],
  },
  responseText: 'initial response',
});
const oldTurn = interaction({
  id: 'mi_v2_old_turn',
  at: base + 100,
  instance: 'host-root:v2:one',
  conversationId: 'cv_old_existing',
  responseId: 'resp-old-turn',
  previousResponseId: 'resp-seed',
  request: {
    model: 'fixture-model',
    prompt_cache_key: continuityKey,
    input: [h1],
  },
  responseText: 'tool summary',
});
const oldToolCall = interaction({
  id: 'mi_v2_old_tool_call',
  at: base + 200,
  instance: 'host-root:v2:one',
  conversationId: 'cv_old_existing',
  responseId: 'resp-tool-call',
  previousResponseId: 'resp-old-turn',
  request: {
    model: 'fixture-model',
    prompt_cache_key: continuityKey,
    input: [h2],
  },
  toolCalls: [{
    toolCallId: 'call-1',
    name: 'exec_command',
    arguments: { cmd: 'printf resolver-v2' },
    issuedAtUnixNs: String(BigInt(base + 202) * 1_000_000n),
  }],
  completeness: 'partial',
  partialReasons: [],
  conversationCompleteness: 'tool_pending',
  responseText: 'running a tool',
});
const oldToolResult = interaction({
  id: 'mi_v2_old_tool_result',
  at: base + 300,
  instance: 'host-root:v2:one',
  conversationId: 'cv_old_existing',
  responseId: 'resp-tool-result',
  previousResponseId: 'resp-tool-call',
  request: {
    model: 'fixture-model',
    prompt_cache_key: continuityKey,
    input: [toolOutput('tool-result-1', 'turn-h2', 'call-1', 'resolver-v2')],
  },
  toolResults: [{
    toolCallId: 'call-1',
    name: 'exec_command',
    content: 'resolver-v2',
    isError: false,
    observedAtUnixNs: String(BigInt(base + 300) * 1_000_000n),
  }],
  responseText: 'tool completed',
});
const resumed = interaction({
  id: 'mi_v2_resumed',
  at: base + 1_000,
  instance: 'host-root:v2:two',
  conversationId: 'cv_resume_existing',
  responseId: 'resp-resumed',
  request: {
    model: 'fixture-model',
    prompt_cache_key: continuityKey,
    input: [
      developer('msg-dev', 'developer instructions'),
      context,
      h0,
      { type: 'message', id: 'assistant-h0', role: 'assistant', content: 'initial response' },
      h1,
      { type: 'message', id: 'assistant-h1', role: 'assistant', content: 'tool summary' },
      h2,
      toolOutput('tool-result-1', 'turn-h2', 'call-1', 'resolver-v2'),
      h3,
    ],
  },
  toolResults: [{
    toolCallId: 'call-1',
    name: 'exec_command',
    content: 'resolver-v2',
    isError: false,
    observedAtUnixNs: String(BigInt(base + 1_000) * 1_000_000n),
  }],
  responseText: 'session resumed',
});
const initialize = interaction({
  id: 'mi_v2_initialize',
  at: base + 10,
  instance: 'host-root:v2:one',
  conversationId: 'cv_initialize_noise',
  interactionType: 'tool',
  path: '/mcp',
  request: { jsonrpc: '2.0', id: 0, method: 'initialize', params: {} },
});
const toolsList = interaction({
  id: 'mi_v2_tools_list',
  at: base + 20,
  instance: 'host-root:v2:one',
  conversationId: 'cv_tools_list_noise',
  interactionType: 'tool',
  path: '/mcp',
  request: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
});
const staleCanonicalControl = interaction({
  id: 'mi_v2_stale_canonical_control',
  at: base + 25,
  instance: 'host-root:v2:one',
  conversationId: 'cv_seed_existing',
  interactionType: 'tool',
  path: '/mcp',
  request: { jsonrpc: '2.0', id: 2, method: 'ping', params: {} },
});
const bootstrap = interaction({
  id: 'mi_v2_bootstrap',
  at: base + 30,
  instance: 'host-root:v2:one',
  conversationId: 'cv_bootstrap_noise',
  request: {
    model: 'fixture-model',
    prompt_cache_key: continuityKey,
    input: [developer('msg-bootstrap', 'tool definitions')],
  },
  responseId: 'resp-bootstrap',
});

const resolution = resolveAgentConversationsV2([
  initialize,
  toolsList,
  staleCanonicalControl,
  bootstrap,
  seed,
  oldTurn,
  oldToolCall,
  oldToolResult,
  resumed,
], 42);

assert.equal(resolution.conversationRecords.length, 5);
assert.equal(resolution.technicalRecords.length, 4);
assert.deepEqual(
  [...new Set(resolution.technicalRecords.map((item) => item.trafficRole))].sort(),
  ['bootstrap', 'control'],
);
const canonicalIds = [...new Set(resolution.conversationRecords.map((item) => item.conversationId))];
assert.deepEqual(canonicalIds, ['cv_seed_existing']);
assert.equal(resolution.aliases.find((item) =>
  item.aliasConversationId === 'cv_old_existing')?.canonicalConversationId, 'cv_seed_existing');
assert.equal(resolution.aliases.find((item) =>
  item.aliasConversationId === 'cv_resume_existing')?.canonicalConversationId, 'cv_seed_existing');
assert.equal(resolution.aliases.find((item) =>
  item.aliasConversationId === 'cv_initialize_noise')?.targetType, 'technical_activity');
assert.equal(resolution.aliases.find((item) =>
  item.aliasConversationId === 'cv_seed_existing')?.targetType, 'conversation',
  'a proven Canonical Thread must outrank a stale control-flow alias using the same id');

const projection = projectAgentConversations(
  resolution.records,
  [],
  { timeType: 'last_30d', scope: 'agent', limit: 100 },
);
assert.equal(projection.summaries.length, 1);
assert.equal(projection.summaries[0].conversationId, 'cv_seed_existing');
assert.equal(projection.summaries[0].turnCount, 4);
assert.equal(projection.summaries[0].toolCallCount, 1);
assert.equal(projection.summaries[0].toolResultCount, 1);
assert.equal(projection.summaries[0].errorCount, 0);
assert.equal(projection.summaries[0].coverage.status, 'complete',
  'a later matching tool result must complete a tool_pending model Interaction');

const timeline = projectSemanticConversationTimeline(
  projection.summaries[0],
  projection.interactionsByConversation.get('cv_seed_existing'),
  [],
);
const events = timeline.flatMap((turn) => turn.events);
assert.deepEqual(
  events.filter((event) => event.kind === 'user_message').map((event) => event.contentPreview),
  ['initial prompt', 'what tools are available', 'run the connectivity test', 'resume the terminal session'],
);
assert.equal(events.filter((event) => event.kind === 'tool_call').length, 1);
assert.equal(events.filter((event) => event.kind === 'tool_result').length, 1);
assert.equal(timeline.flatMap((turn) => turn.diagnostics).length, 0);
const replay = projectContextReplaySummaries(
  projection.sourceInteractionsByConversation.get('cv_seed_existing'),
  [],
);
assert.equal(replay.length, 1);
assert.equal(replay[0].replayedUserMessages, 3);
assert.equal(replay[0].replayedToolResults, 1);
assert.equal(replay[0].newUserMessages, 1);

const boundaryProjection = projectAgentConversations(
  [resumed],
  [],
  { timeType: 'last_30d', scope: 'agent', limit: 100 },
);
const boundarySummary = boundaryProjection.summaries.find((item) => item.hasContent);
assert.ok(boundarySummary);
const boundaryTimeline = projectSemanticConversationTimeline(
  boundarySummary,
  boundaryProjection.interactionsByConversation.get(boundarySummary.conversationId),
  [],
);
assert.deepEqual(
  boundaryTimeline.flatMap((turn) => turn.events)
    .filter((event) => event.kind === 'user_message')
    .map((event) => event.contentPreview),
  ['resume the terminal session'],
  'the first cumulative request inside a bounded window must not replay older user Turns',
);
assert.equal(boundaryTimeline.flatMap((turn) => turn.events)
  .filter((event) => event.kind === 'tool_result').length, 0,
  'tool results attached to boundary replay context must stay folded');
const boundaryReplay = projectContextReplaySummaries(
  boundaryProjection.sourceInteractionsByConversation.get(boundarySummary.conversationId),
  [],
);
assert.equal(boundaryReplay.length, 1);
assert.equal(boundaryReplay[0].replayedUserMessages, 3);
assert.equal(boundaryReplay[0].replayedToolResults, 1);
assert.equal(boundaryReplay[0].newUserMessages, 1);

const clientMetadataSessionId = 'session-observed-after-resume';
const h4 = human('msg-h4', 'turn-h4', 'continue from the first observed turn');
const clientMetadataResume = resolveAgentConversationsV2([
  interaction({
    id: 'mi_v2_client_metadata_prewarm',
    at: base + 1_050,
    instance: 'host-root:v2:resume-one',
    request: {
      type: 'response.create',
      generate: false,
      model: 'fixture-model',
      client_metadata: {
        session_id: clientMetadataSessionId,
        thread_id: clientMetadataSessionId,
        turn_id: '',
      },
      input: [
        developer('msg-resume-prewarm', 'resumed Thread instructions'),
        h0,
        h1,
        h2,
      ],
    },
    responseId: 'resp-client-metadata-prewarm',
    responseText: '',
  }),
  interaction({
    id: 'mi_v2_client_metadata_first_observed',
    at: base + 1_100,
    instance: 'host-root:v2:resume-one',
    request: {
      type: 'response.create',
      model: 'fixture-model',
      client_metadata: {
        session_id: clientMetadataSessionId,
        thread_id: clientMetadataSessionId,
        turn_id: 'turn-h3',
      },
      // The earlier portion was never observed by AnySentry. Only h3 is new at this boundary.
      input: [h0, h1, h2, h3],
    },
    responseId: 'resp-client-metadata-one',
    responseText: 'first observed response',
  }),
  interaction({
    id: 'mi_v2_client_metadata_next_observed',
    at: base + 1_200,
    instance: 'host-root:v2:resume-two',
    request: {
      type: 'response.create',
      model: 'fixture-model',
      client_metadata: {
        session_id: clientMetadataSessionId,
        thread_id: clientMetadataSessionId,
        turn_id: 'turn-h4',
      },
      input: [h0, h1, h2, h3, h4],
    },
    responseId: 'resp-client-metadata-two',
    responseText: 'next observed response',
  }),
]);
assert.equal(clientMetadataResume.technicalRecords.length, 1);
assert.equal(clientMetadataResume.technicalRecords[0].trafficRole, 'bootstrap',
  'a generate=false resume prewarm must stay outside the user-visible Thread');
assert.deepEqual(
  [...new Set(clientMetadataResume.conversationRecords
    .map((item) => item.providerConversationId))],
  [clientMetadataSessionId],
  'Responses client_metadata session/thread identity must become a provider Conversation anchor',
);
assert.equal(new Set(clientMetadataResume.conversationRecords
  .map((item) => item.conversationId)).size, 1,
  'a resumed session first observed mid-history must remain one Thread across Runtime instances');
const clientMetadataProjection = projectAgentConversations(
  clientMetadataResume.records,
  [],
  { timeType: 'last_30d', scope: 'agent', limit: 100 },
);
assert.equal(clientMetadataProjection.summaries.length, 1);
assert.equal(clientMetadataProjection.summaries[0].idSource, 'provider');
const clientMetadataTimeline = projectSemanticConversationTimeline(
  clientMetadataProjection.summaries[0],
  clientMetadataProjection.interactionsByConversation.get(
    clientMetadataProjection.summaries[0].conversationId,
  ),
  [],
);
assert.deepEqual(
  clientMetadataTimeline.flatMap((turn) => turn.events)
    .filter((event) => event.kind === 'user_message')
    .map((event) => event.contentPreview),
  ['resume the terminal session', 'continue from the first observed turn'],
  'only content observed after the collection boundary should become visible user Turns',
);

const explicitConflict = resolveAgentConversationsV2([
  interaction({
    id: 'mi_v2_conflict_a',
    at: base + 2_000,
    instance: 'host-root:v2:three',
    providerConversationId: 'provider-a',
    request: { model: 'fixture', prompt_cache_key: 'shared-cache', input: [human('a', 'a', 'A')] },
    responseId: 'a',
  }),
  interaction({
    id: 'mi_v2_conflict_b',
    at: base + 2_100,
    instance: 'host-root:v2:three',
    providerConversationId: 'provider-b',
    request: { model: 'fixture', prompt_cache_key: 'shared-cache', input: [human('b', 'b', 'B')] },
    responseId: 'b',
  }),
]);
assert.equal(new Set(explicitConflict.conversationRecords.map((item) => item.conversationId)).size, 2,
  'distinct explicit provider conversations must block a continuity-key merge');

const cumulative = resolveAgentConversationsV2([
  interaction({
    id: 'mi_v2_cumulative_a',
    at: base + 3_000,
    instance: 'host-root:v2:four',
    request: { model: 'fixture', messages: [{ role: 'user', content: 'one' }] },
    responseId: 'cum-a',
  }),
  interaction({
    id: 'mi_v2_cumulative_b',
    at: base + 3_100,
    instance: 'host-root:v2:five',
    request: {
      model: 'fixture',
      messages: [{ role: 'user', content: 'one' }, { role: 'user', content: 'two' }],
    },
    responseId: 'cum-b',
  }),
]);
assert.equal(new Set(cumulative.conversationRecords.map((item) => item.conversationId)).size, 1,
  'product-neutral cumulative human lineage must survive a process restart without product rules');

const retryRequest = {
  model: 'claude-fixture',
  messages: [{ role: 'user', content: 'one request that the provider retries' }],
};
const retries = resolveAgentConversationsV2([
  interaction({
    id: 'mi_v2_retry_a', at: base + 3_200, instance: 'host-root:retry:one',
    agentProduct: 'Claude Code', workspacePath: '/workspace/retry', request: retryRequest,
    providerConversationId: 'retry-thread',
    statusCode: 429, responseText: 'rate limited', completeness: 'partial',
    partialReasons: ['http_error'],
  }),
  interaction({
    id: 'mi_v2_retry_b', at: base + 3_300, instance: 'host-root:retry:one',
    agentProduct: 'Claude Code', workspacePath: '/workspace/retry', request: retryRequest,
    providerConversationId: 'retry-thread',
    statusCode: 429, responseText: 'rate limited', completeness: 'partial',
    partialReasons: ['http_error'],
  }),
  interaction({
    id: 'mi_v2_retry_c', at: base + 3_400, instance: 'host-root:retry:one',
    agentProduct: 'Claude Code', workspacePath: '/workspace/retry', request: retryRequest,
    providerConversationId: 'retry-thread',
    statusCode: 429, responseText: 'rate limited', completeness: 'partial',
    partialReasons: ['http_error'],
  }),
]);
const retryProjection = projectAgentConversations(
  retries.records,
  [],
  { timeType: 'last_30d', scope: 'agent', limit: 100 },
);
assert.equal(retryProjection.summaries.length, 1);
assert.equal(retryProjection.summaries[0].turnCount, 1,
  'byte-identical failed provider retries must remain one user Turn');
const retryTimeline = projectSemanticConversationTimeline(
  retryProjection.summaries[0],
  retryProjection.interactionsByConversation.get(retryProjection.summaries[0].conversationId),
  [],
);
assert.equal(retryTimeline.length, 1);
assert.equal(retryTimeline[0].events.filter((event) => event.kind === 'user_message').length, 1);
assert.deepEqual(
  retryTimeline[0].diagnostics
    .filter((diagnostic) => diagnostic.type === 'retry')
    .map((diagnostic) => diagnostic.message),
  ['模型请求发生重试 · Attempt 2', '模型请求发生重试 · Attempt 3'],
);

const legacyDockerProjection = projectAgentConversations([
  interaction({
    id: 'mi_v2_legacy_docker', at: base + 3_500, instance: 'host-root:legacy-docker:one',
    agentProduct: 'Pi', workspacePath: 'agent://0123456789ab',
    providerConversationId: 'legacy-docker-thread',
    request: { model: 'fixture', messages: [{ role: 'user', content: 'legacy container' }] },
    responseId: 'legacy-docker-response',
  }),
], [], { timeType: 'last_30d', scope: 'agent', limit: 100 });
assert.equal(legacyDockerProjection.summaries[0].environment, 'docker',
  'legacy agent:// container workspaces must migrate to the Docker environment');

const legacyHostWorkerProjection = projectAgentConversations([
  interaction({
    id: 'mi_v2_legacy_host_worker', at: base + 3_550, instance: 'host-root:legacy-host:one',
    agentProduct: 'Generic CLI', workspacePath: 'agent://runtime-worker',
    providerConversationId: 'legacy-host-worker-thread',
    request: { model: 'fixture', messages: [{ role: 'user', content: 'legacy host worker' }] },
    responseId: 'legacy-host-worker-response',
  }),
], [], { timeType: 'last_30d', scope: 'agent', limit: 100 });
assert.equal(legacyHostWorkerProjection.summaries[0].environment, 'host',
  'a non-container agent:// workspace with host-root evidence must remain Host');

const hostResumeAcrossMissingWorkspace = resolveAgentConversationsV2([
  interaction({
    id: 'mi_v2_host_resume_explicit', at: base + 3_600, instance: 'host-root:resume:one',
    workspacePath: '/tmp/explicit-workspace', conversationId: 'cv_host_resume_explicit',
    request: {
      model: 'fixture', prompt_cache_key: 'host-resume-continuity',
      input: [human('host-resume-h0', 'host-resume-t0', 'first host turn')],
    },
    responseId: 'host-resume-response-1',
  }),
  interaction({
    id: 'mi_v2_host_resume_synthetic', at: base + 3_700, instance: 'host-root:resume:two',
    workspacePath: 'agent://runtime-worker', conversationId: 'cv_host_resume_synthetic',
    previousResponseId: 'host-resume-response-1', responseId: 'host-resume-response-2',
    request: {
      model: 'fixture', prompt_cache_key: 'host-resume-continuity',
      input: [
        human('host-resume-h0', 'host-resume-t0', 'first host turn'),
        human('host-resume-h1', 'host-resume-t1', 'resumed host turn'),
      ],
    },
  }),
]);
assert.equal(new Set(hostResumeAcrossMissingWorkspace.conversationRecords
  .map((item) => item.conversationId)).size, 1,
  'strong continuity evidence must bridge one missing/synthetic workspace');
assert.equal(hostResumeAcrossMissingWorkspace.aliases.find((item) =>
  item.aliasConversationId === 'cv_host_resume_synthetic')?.canonicalConversationId,
  'cv_host_resume_explicit');

const conflictingExplicitWorkspaces = resolveAgentConversationsV2([
  interaction({
    id: 'mi_v2_workspace_a', at: base + 3_800, instance: 'host-root:workspace:a',
    workspacePath: '/workspace/a', request: {
      model: 'fixture', prompt_cache_key: 'colliding-continuity',
      messages: [{ role: 'user', content: 'workspace A' }],
    }, responseId: 'workspace-a',
  }),
  interaction({
    id: 'mi_v2_workspace_b', at: base + 3_900, instance: 'host-root:workspace:b',
    workspacePath: '/workspace/b', request: {
      model: 'fixture', prompt_cache_key: 'colliding-continuity',
      messages: [{ role: 'user', content: 'workspace B' }],
    }, responseId: 'workspace-b',
  }),
]);
assert.equal(new Set(conflictingExplicitWorkspaces.conversationRecords
  .map((item) => item.conversationId)).size, 2,
  'different explicit workspaces must remain a hard Thread boundary');

const assertOneThread = (records, label) => {
  const resolved = resolveAgentConversationsV2(records);
  assert.equal(new Set(resolved.conversationRecords.map((item) => item.conversationId)).size, 1, label);
  return resolved;
};

const claude = assertOneThread([
  interaction({
    id: 'mi_v2_claude_a', at: base + 4_000, instance: 'host-root:claude:one',
    agentProduct: 'Claude Code', workspacePath: '/workspace/claude',
    request: { model: 'claude', messages: [{ role: 'user', content: 'inspect files' }] },
    responseId: 'claude-a',
    toolCalls: [{ toolCallId: 'toolu-1', name: 'Read', arguments: { path: 'a.txt' } }],
  }),
  interaction({
    id: 'mi_v2_claude_b', at: base + 4_100, instance: 'host-root:claude:two',
    agentProduct: 'Claude Code', workspacePath: '/workspace/claude',
    request: {
      model: 'claude',
      messages: [
        { role: 'user', content: 'inspect files' },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu-1', content: 'ok' }] },
        { role: 'user', content: 'continue after resume' },
      ],
    },
    responseId: 'claude-b',
    toolResults: [{ toolCallId: 'toolu-1', name: 'Read', content: 'ok', isError: false }],
  }),
], 'Claude cumulative Messages and tool_use lineage must survive a new Runtime instance');
assert.equal(claude.conversationRecords.length, 2);

assertOneThread([
  interaction({
    id: 'mi_v2_pi_a', at: base + 5_000, instance: 'host-root:pi:one',
    agentProduct: 'Pi', workspacePath: '/workspace/pi', providerConversationId: 'pi-conversation',
    request: { model: 'pi-model', messages: [{ role: 'user', content: 'pi one' }] }, responseId: 'pi-a',
  }),
  interaction({
    id: 'mi_v2_pi_b', at: base + 5_100, instance: 'host-root:pi:two',
    agentProduct: 'Pi', workspacePath: '/workspace/pi', providerConversationId: 'pi-conversation',
    request: { model: 'pi-model', messages: [{ role: 'user', content: 'pi two' }] }, responseId: 'pi-b',
  }),
], 'Pi explicit conversation identity must cross Runtime instances');

assertOneThread([
  interaction({
    id: 'mi_v2_kimi_a', at: base + 6_000, instance: 'host-root:kimi:one',
    agentProduct: 'Kimi CLI', workspacePath: '/workspace/kimi',
    request: { model: 'kimi', messages: [{ role: 'user', content: 'kimi one' }] }, responseId: 'kimi-a',
  }),
  interaction({
    id: 'mi_v2_kimi_b', at: base + 6_100, instance: 'host-root:kimi:two',
    agentProduct: 'Kimi CLI', workspacePath: '/workspace/kimi',
    request: { model: 'kimi', messages: [{ role: 'user', content: 'kimi one' }, { role: 'user', content: 'kimi two' }] }, responseId: 'kimi-b',
  }),
], 'Kimi-like cumulative lineage must use the generic resolver');

for (const [product, workspace, conversationId] of [
  ['Dify', '/workspace/dify', 'dify-conversation'],
  ['LangChain', '/workspace/langchain', 'langchain-thread'],
]) {
  assertOneThread([
    interaction({
      id: 'mi_v2_' + product.toLowerCase() + '_a', at: base + 7_000,
      instance: 'host-root:' + product.toLowerCase() + ':one', agentProduct: product,
      workspacePath: workspace, providerConversationId: conversationId,
      request: { model: 'workflow-model', messages: [{ role: 'user', content: 'first run' }] }, responseId: product + '-a',
    }),
    interaction({
      id: 'mi_v2_' + product.toLowerCase() + '_b', at: base + 7_100,
      instance: 'host-root:' + product.toLowerCase() + ':two', agentProduct: product,
      workspacePath: workspace, providerConversationId: conversationId,
      request: { model: 'workflow-model', messages: [{ role: 'user', content: 'second run' }] }, responseId: product + '-b',
    }),
  ], product + ' conversation/thread identity must remain distinct from execution Run identity');
}

console.log('Agent Conversation Resolver V2 verification passed');
