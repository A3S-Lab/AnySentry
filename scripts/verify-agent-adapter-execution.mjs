#!/usr/bin/env node

/**
 * Deterministic P0 checks: AgentAdapterManifest is executed at ingest for trafficRole,
 * identity hints, and toolNameView. Synthetic fixtures only — no credentials or prompts.
 * Run `pnpm build:api` first.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  DEFAULT_AGENT_ADAPTER_MANIFESTS,
} = require('../apps/api/dist/security-monitoring/canonical-observability.js');
const {
  applyAgentAdapter,
  classifyTraffic,
  extractIdentityHints,
  mapToolNameView,
  matchAgentAdapterManifest,
} = require('../apps/api/dist/security-monitoring/agent-adapter-execution.js');
const { trafficRoleForInteraction, resolveAgentConversationsV2 } = require(
  '../apps/api/dist/security-monitoring/agent-conversation-resolution-v2.js',
);
const { parseObserverAgentInteraction } = require(
  '../apps/api/dist/security-monitoring/agent-interaction.js',
);

const digest = (value) => createHash('sha256').update(value).digest('hex');
const nowNs = String(BigInt(Date.now()) * 1_000_000n);

const codex = matchAgentAdapterManifest({ product: 'Codex', comm: 'tokio-rt-worker' });
assert.equal(codex?.id, 'codex-cli', 'Codex product hint must select codex-cli');
const claude = matchAgentAdapterManifest({ product: 'Claude Code', comm: 'HTTP Client' });
assert.equal(claude?.id, 'claude-code', 'Claude Code product hint must select claude-code');
assert.equal(
  matchAgentAdapterManifest({ product: 'unknown-widget' }),
  undefined,
  'unknown product must not select a Manifest',
);

assert.equal(
  classifyTraffic(codex, { path: '/backend-api/plugins/list', wireTemplateId: undefined }),
  'control',
);
assert.equal(
  classifyTraffic(codex, { path: '/backend-api/codex/analytics-events/batch' }),
  'background',
);
assert.equal(
  classifyTraffic(codex, { path: '/v1/responses', wireTemplateId: 'openai-responses' }),
  'conversation',
);
assert.equal(
  classifyTraffic(claude, { path: '/v1/messages/count_tokens' }),
  'control',
);
assert.equal(
  classifyTraffic(claude, { path: '/v1/messages', wireTemplateId: 'anthropic-messages' }),
  'conversation',
);
// Domain must never participate in classifyTraffic (path-only contract).
assert.equal(
  classifyTraffic(codex, { path: '/unrelated', wireTemplateId: undefined }),
  undefined,
);

assert.equal(mapToolNameView(codex, 'shell'), 'shell');
assert.equal(mapToolNameView(codex, 'apply_patch'), 'file_edit');
assert.equal(mapToolNameView(codex, 'mcp__server__tool'), 'mcp');
assert.equal(mapToolNameView(claude, 'Bash'), 'shell');
assert.equal(mapToolNameView(claude, 'Edit'), 'file_edit');
assert.equal(mapToolNameView(claude, 'Task'), 'subagent');

const sessionId = '11111111-2222-4333-8444-555555555555';
const identityHints = extractIdentityHints(codex, {
  request: {
    body: '',
    encoding: 'utf8',
    contentType: 'application/json',
    capturedBytes: 0,
    decodedBytes: 0,
    sha256: digest(''),
    completeness: 'complete',
    structured: {
      client_metadata: {
        session_id: sessionId,
        thread_id: 'thread-fixture',
        turn_id: 'turn-fixture',
      },
      prompt_cache_key: 'cache-fixture',
    },
  },
  response: {
    body: '',
    encoding: 'utf8',
    contentType: 'application/json',
    capturedBytes: 0,
    decodedBytes: 0,
    sha256: digest(''),
    completeness: 'complete',
    structured: {},
  },
});
assert(identityHints.some((hint) => hint.entityType === 'session' && hint.value === sessionId));
assert(identityHints.some((hint) => hint.entityType === 'turn' && hint.value === 'turn-fixture'));

const baseInteraction = ({
  interactionId,
  agentProduct,
  path,
  wireTemplateId,
  interactionType = 'unparsed',
  toolCalls = [],
  structured = {},
}) => ({
  schemaVersion: 'anysentry.agent_interaction.v1',
  interactionId,
  interactionType,
  at: Date.now(),
  workspacePath: '/workspace/adapter-fixture',
  agentAssetId: `aa_${digest(agentProduct).slice(0, 24)}`,
  agentProduct,
  detectedClassification: 'confirmed_agent',
  currentEffectiveClassification: 'confirmed_agent',
  connectionId: 'conn-fixture',
  transport: 'tls',
  protocol: 'http/1.1',
  ...(wireTemplateId ? { wireTemplateId } : {}),
  endpoint: 'api.example.test',
  method: 'POST',
  path,
  statusCode: 200,
  startedAtUnixNs: nowNs,
  requestCompleteAtUnixNs: nowNs,
  firstResponseAtUnixNs: nowNs,
  endedAtUnixNs: nowNs,
  durationNs: '1',
  timeQuality: 'collector_calibrated',
  request: {
    body: '{}',
    encoding: 'utf8',
    contentType: 'application/json',
    capturedBytes: 2,
    decodedBytes: 2,
    sha256: digest('{}'),
    completeness: 'complete',
    structured,
  },
  response: {
    body: '{}',
    encoding: 'utf8',
    contentType: 'application/json',
    capturedBytes: 2,
    decodedBytes: 2,
    sha256: digest('{}'),
    completeness: 'complete',
    structured: {},
  },
  toolCalls,
  toolResults: [],
  completeness: interactionType === 'unparsed' ? 'partial' : 'complete',
  partialReasons: interactionType === 'unparsed' ? ['wire_template_unparsed'] : [],
  captureSource: 'observer',
  receivedAt: Date.now(),
  process: {
    pid: 4242,
    comm: agentProduct === 'codex' ? 'tokio-rt-worker' : 'HTTP Client',
    exe: agentProduct === 'codex'
      ? '/vendor/x86_64-unknown-linux-musl/bin/codex'
      : '/home/user/.local/share/claude/versions/2.1.263',
  },
});

const codexControl = applyAgentAdapter(baseInteraction({
  interactionId: `mi_${digest('codex-control').slice(0, 24)}`,
  agentProduct: 'codex',
  path: '/backend-api/plugins/installed',
}));
assert.equal(codexControl.agentAdapterId, 'codex-cli');
assert.equal(codexControl.trafficRole, 'control');
assert.equal(trafficRoleForInteraction(codexControl), 'control');

const codexConversation = applyAgentAdapter(baseInteraction({
  interactionId: `mi_${digest('codex-conversation').slice(0, 24)}`,
  agentProduct: 'codex',
  path: '/v1/responses',
  wireTemplateId: 'openai-responses',
  interactionType: 'model',
  toolCalls: [{ toolCallId: 'call_1', name: 'shell', arguments: { command: 'ls' } }],
  structured: {
    client_metadata: { session_id: sessionId, turn_id: 'turn-1' },
  },
}));
assert.equal(codexConversation.trafficRole, 'conversation');
assert.equal(codexConversation.toolCalls[0].canonicalKind, 'shell');
assert(codexConversation.conversationAnchors?.some((anchor) => anchor.kind === 'provider_conversation'));

const claudeControl = applyAgentAdapter(baseInteraction({
  interactionId: `mi_${digest('claude-control').slice(0, 24)}`,
  agentProduct: 'Claude Code',
  path: '/v1/messages/count_tokens',
}));
assert.equal(claudeControl.agentAdapterId, 'claude-code');
assert.equal(claudeControl.trafficRole, 'control');

const claudeConversation = applyAgentAdapter(baseInteraction({
  interactionId: `mi_${digest('claude-conversation').slice(0, 24)}`,
  agentProduct: 'claude-code',
  path: '/v1/messages',
  wireTemplateId: 'anthropic-messages',
  interactionType: 'model',
  toolCalls: [
    { toolCallId: 'toolu_1', name: 'Bash', arguments: { command: 'pwd' } },
    { toolCallId: 'toolu_2', name: 'Edit', arguments: { file_path: 'a.ts' } },
  ],
  structured: {
    metadata: { user_id: `session_${sessionId}` },
  },
}));
assert.equal(claudeConversation.trafficRole, 'conversation');
assert.equal(claudeConversation.toolCalls[0].canonicalKind, 'shell');
assert.equal(claudeConversation.toolCalls[1].canonicalKind, 'file_edit');

const resolution = resolveAgentConversationsV2([
  codexControl,
  codexConversation,
  claudeControl,
  claudeConversation,
]);
assert.equal(resolution.technicalActivities.length >= 2, true, 'control traffic must fold to technical activities');
assert(
  resolution.technicalActivities.some((activity) => activity.role === 'control'),
  'control technical activity expected',
);
assert(
  resolution.conversationRecords.every((record) =>
    record.trafficRole === 'conversation' || record.trafficRole === 'context_replay'),
  'human lane records must only include conversation/context_replay',
);
assert(
  !resolution.conversationRecords.some((item) => item.interactionId === codexControl.interactionId),
  'Codex control must not enter conversation records',
);
assert(
  !resolution.conversationRecords.some((item) => item.interactionId === claudeControl.interactionId),
  'Claude control must not enter conversation records',
);
assert(
  resolution.conversationRecords.some((item) => item.interactionId === codexConversation.interactionId),
  'Codex conversation must remain in the human lane',
);
assert(
  resolution.memberships.some((item) =>
    item.interactionId === codexControl.interactionId && item.technicalActivityId),
  'Codex control must have a technical membership',
);

// Ingest path: parseObserverAgentInteraction must invoke applyAgentAdapter.
const requestBody = JSON.stringify({
  model: 'fixture-model',
  client_metadata: { session_id: sessionId, turn_id: 'turn-ingest' },
});
const responseBody = JSON.stringify({ id: 'resp_fixture', output: [] });
const content = (body) => ({
  body,
  encoding: 'utf8',
  contentType: 'application/json',
  capturedBytes: Buffer.byteLength(body),
  decodedBytes: Buffer.byteLength(body),
  sha256: digest(body),
  completeness: 'complete',
  structured: JSON.parse(body),
});
const interactionId = `mi_${digest('ingest-adapter').slice(0, 24)}`;
const line = JSON.stringify({
  event: {
    LlmInteraction: {
      schemaVersion: 'anysentry.agent_interaction.v1',
      interactionId,
      interactionType: 'unparsed',
      connectionId: 'tls:fixture',
      endpoint: 'chatgpt.com',
      method: 'GET',
      path: '/backend-api/wham/settings',
      statusCode: 200,
      startedAtUnixNs: nowNs,
      requestCompleteAtUnixNs: nowNs,
      firstResponseAtUnixNs: nowNs,
      endedAtUnixNs: nowNs,
      durationNs: '1',
      timeQuality: 'collector_calibrated',
      transport: 'tls',
      protocol: 'http/1.1',
      request: content(requestBody),
      response: content(responseBody),
      toolCalls: [],
      toolResults: [],
      completeness: 'partial',
      partialReasons: ['wire_template_unparsed'],
      captureSource: 'observer',
    },
  },
});
const parsed = parseObserverAgentInteraction(line, {
  agentId: 'codex',
  workspacePath: '/workspace/adapter-fixture',
  receivedAt: Date.now(),
  attribution: {
    classification: 'confirmed_agent',
    agentDisplayName: 'Codex',
    agentScopeId: 'codex',
    source: 'process_signature',
    rootPid: 1001,
    evidence: ['process_signature:codex'],
  },
  process: {
    pid: 1001,
    hostId: 'host',
    bootId: 'boot',
    startTimeTicks: '10',
    comm: 'codex',
    exe: '/vendor/bin/codex',
  },
  classificationSemantics: { identityClassification: 'confirmed_agent' },
});
assert(parsed, 'ingest parse must succeed');
assert.equal(parsed.agentAdapterId, 'codex-cli');
assert.equal(parsed.trafficRole, 'control');

assert(
  DEFAULT_AGENT_ADAPTER_MANIFESTS.some((manifest) =>
    manifest.id === 'codex-cli' && Array.isArray(manifest.trafficRoles) && manifest.trafficRoles.length > 0),
  'codex-cli Manifest must declare trafficRoles',
);
assert(
  DEFAULT_AGENT_ADAPTER_MANIFESTS.some((manifest) =>
    manifest.id === 'claude-code' && Array.isArray(manifest.toolNameView) && manifest.toolNameView.length > 0),
  'claude-code Manifest must declare toolNameView',
);

console.log('verify-agent-adapter-execution: ok');
