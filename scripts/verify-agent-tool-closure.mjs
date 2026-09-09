#!/usr/bin/env node

/**
 * Deterministic P2 checks: cross-Interaction ToolCall↔ToolResult closure and
 * Manifest execArgvNormalizer. Synthetic fixtures only.
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
  matchAgentAdapterManifest,
  normalizeExecArgv,
} = require('../apps/api/dist/security-monitoring/agent-adapter-execution.js');
const {
  closeToolCallsAcrossInteractions,
  projectedConversationCompleteness,
} = require('../apps/api/dist/security-monitoring/agent-tool-closure.js');
const {
  buildSemanticKernelRelations,
} = require('../apps/api/dist/security-monitoring/agent-semantic-kernel-relation.js');

const digest = (value) => createHash('sha256').update(value).digest('hex');
const now = Date.now();
const ns = (ms) => String(BigInt(ms) * 1_000_000n);

const codex = matchAgentAdapterManifest({ product: 'Codex' });
const claude = matchAgentAdapterManifest({ product: 'Claude Code' });
assert.ok(codex && claude);

assert.equal(
  normalizeExecArgv(codex, ['bash', '-lc', 'ls -la /tmp']),
  'ls -la /tmp',
);
assert.equal(
  normalizeExecArgv(codex, 'codex-linux-sandbox bash -lc echo hi'),
  'echo hi',
);
assert.equal(
  normalizeExecArgv(claude, `bash -c 'eval "npm test" && pwd -P >| /tmp/claude-snap-123'`),
  'npm test',
);
assert.equal(
  normalizeExecArgv(claude, `eval 'cat README.md'; pwd -P > /tmp/out`),
  'cat README.md',
);

const sessionId = 'sess_p2_tool_closure_fixture';
const callId = 'toolu_bash_001';
const baseInteraction = {
  schemaVersion: 'anysentry.agent_interaction.v1',
  interactionType: 'model',
  workspacePath: '/workspace',
  agentAssetId: 'aa_p2',
  agentProduct: 'Claude Code',
  agentInstanceId: 'ari_p2',
  canonicalSessionId: sessionId,
  sessionId,
  detectedClassification: 'confirmed_agent',
  currentEffectiveClassification: 'confirmed_agent',
  connectionId: 'tls:1',
  transport: 'tls',
  protocol: 'http/1.1',
  endpoint: 'api.anthropic.com',
  method: 'POST',
  path: '/v1/messages',
  statusCode: 200,
  timeQuality: 'collector_calibrated',
  request: { body: '', encoding: 'utf8', contentType: 'application/json', capturedBytes: 0, decodedBytes: 0, sha256: digest('') },
  response: { body: '', encoding: 'utf8', contentType: 'application/json', capturedBytes: 0, decodedBytes: 0, sha256: digest('') },
  completeness: 'partial',
  partialReasons: ['tool_result_pending'],
  captureSource: 'tls',
  trafficRole: 'conversation',
};

const callInteraction = {
  ...baseInteraction,
  interactionId: `mi_${digest('p2-call').slice(0, 24)}`,
  at: now,
  startedAtUnixNs: ns(now),
  requestCompleteAtUnixNs: ns(now + 1),
  firstResponseAtUnixNs: ns(now + 2),
  endedAtUnixNs: ns(now + 3),
  durationNs: '3000000',
  receivedAt: now,
  conversationCompleteness: 'tool_pending',
  toolCalls: [{ toolCallId: callId, name: 'Bash', arguments: { command: 'npm test' } }],
  toolResults: [],
};

const resultInteraction = {
  ...baseInteraction,
  interactionId: `mi_${digest('p2-result').slice(0, 24)}`,
  at: now + 10_000,
  startedAtUnixNs: ns(now + 10_000),
  requestCompleteAtUnixNs: ns(now + 10_001),
  firstResponseAtUnixNs: ns(now + 10_002),
  endedAtUnixNs: ns(now + 10_003),
  durationNs: '3000000',
  receivedAt: now + 10_000,
  conversationCompleteness: 'complete',
  completeness: 'complete',
  partialReasons: [],
  toolCalls: [],
  toolResults: [{
    toolCallId: callId,
    name: 'Bash',
    content: { stdout: 'ok' },
    isError: false,
    observedAtUnixNs: ns(now + 10_001),
  }],
};

const replay = {
  ...resultInteraction,
  interactionId: `mi_${digest('p2-replay').slice(0, 24)}`,
  at: now + 20_000,
  trafficRole: 'context_replay',
  receivedAt: now + 20_000,
};

const closure = closeToolCallsAcrossInteractions([callInteraction, resultInteraction, replay]);
assert.equal(closure.matches.length, 1);
assert.equal(closure.matches[0].toolCallId, callId);
assert.equal(closure.matches[0].callInteractionId, callInteraction.interactionId);
assert.equal(closure.matches[0].resultInteractionId, resultInteraction.interactionId);
assert.equal(closure.evidenceLinks.length, 1);
assert.equal(closure.evidenceLinks[0].method, 'explicit_id');
assert.equal(closure.evidenceLinks[0].status, 'confirmed');
assert.equal(closure.evidenceLinks[0].toType, 'semantic_record');
assert.equal(closure.relationRevisions.length, 1);
assert.equal(
  projectedConversationCompleteness(closure, callInteraction.interactionId),
  'complete',
);

const orphan = closeToolCallsAcrossInteractions([callInteraction]);
assert.equal(orphan.matches.length, 0);
assert.equal(
  projectedConversationCompleteness(orphan, callInteraction.interactionId),
  'tool_pending',
);

// Adapter-normalized argv must let Claude Bash match a shell-snapshot-wrapped ToolExec.
const semanticEvent = {
  schemaVersion: 'anysentry.agent_semantic_event.v1',
  semanticEventId: `se_${digest('p2-se').slice(0, 24)}`,
  kind: 'tool_call',
  atUnixNs: ns(now + 2),
  toolCallId: callId,
  toolName: 'Bash',
  toolKind: 'shell',
  content: JSON.stringify({ command: 'npm test' }),
};
const toolExec = {
  eventId: 'ev_exec_1',
  kernelFactId: 'kf_exec_1',
  eventKind: 'ToolExec',
  at: new Date(now + 3_000).toISOString(),
  eventAtUnixNs: ns(now + 3_000),
  agentRuntimeInstanceId: 'ari_p2',
  agentRuntimeInstanceAliases: [],
  attributes: {
    argv: `bash -c 'eval "npm test"; pwd -P >| /tmp/claude-snap-xyz'`,
    argv_truncated: false,
    argv_incomplete: false,
  },
  subject: 'bash -c eval…',
  verdict: 'allow',
  tier: 'L1',
  severity: 'low',
  riskScore: 1,
  riskName: 'fixture',
  riskCategory: 'command',
  reason: 'fixture',
};
const relations = buildSemanticKernelRelations(
  semanticEvent,
  {
    schemaVersion: 'anysentry.agent_semantic_event.v1',
    semanticEventId: `se_${digest('p2-result-se').slice(0, 24)}`,
    kind: 'tool_result',
    atUnixNs: ns(now + 10_001),
    toolCallId: callId,
    toolName: 'Bash',
  },
  {
    ...callInteraction,
    agentInstanceId: 'ari_p2',
  },
  [toolExec],
  1,
);
assert.ok(
  relations.some((relation) =>
    relation.kernelEventId === 'ev_exec_1' && relation.linkMethod === 'command'),
  'normalized Claude argv must link Bash ToolCall to ToolExec',
);

// ---------------------------------------------------------------------------
// History replay: orphan toolResults whose assistant tool_calls only appear in
// a later request.messages history (missed prior model LlmInteraction).
// ---------------------------------------------------------------------------
const {
  reconstructMissingToolCallsFromRequestHistory,
  projectInteractionsWithReconstructedHistoryToolCalls,
  TOOL_CALL_RECONSTRUCTED_FROM_REQUEST_HISTORY,
} = require('../apps/api/dist/security-monitoring/agent-tool-closure.js');
const {
  projectSemanticConversationTimeline,
} = require('../apps/api/dist/security-monitoring/agent-semantic-timeline.js');

const orphanBashId = 'call_orphan_bash_001';
const orphanMcpId = 'call_orphan_mcp_001';
const laterCallId = 'call_later_bash_002';

const orphanResultOnly = {
  ...baseInteraction,
  interactionId: `mi_${digest('hist-orphan-result').slice(0, 24)}`,
  at: now + 30_000,
  startedAtUnixNs: ns(now + 30_000),
  requestCompleteAtUnixNs: ns(now + 30_001),
  firstResponseAtUnixNs: ns(now + 30_002),
  endedAtUnixNs: ns(now + 30_003),
  durationNs: '3000000',
  receivedAt: now + 30_000,
  conversationCompleteness: 'complete',
  completeness: 'complete',
  partialReasons: [],
  path: '/v1/chat/completions',
  toolCalls: [{
    toolCallId: laterCallId,
    name: 'run_bash',
    arguments: { command: 'date' },
    issuedAtUnixNs: ns(now + 30_002),
  }],
  toolResults: [
    {
      toolCallId: orphanBashId,
      name: 'run_bash',
      content: { ok: false, exit_code: 126 },
      isError: true,
      observedAtUnixNs: ns(now + 30_001),
    },
    {
      toolCallId: orphanMcpId,
      name: 'call_mcp_tool',
      content: { ok: true, tool_name: 'get_lab_fact' },
      isError: false,
      observedAtUnixNs: ns(now + 30_001),
    },
  ],
  request: {
    body: '',
    encoding: 'utf8',
    contentType: 'application/json',
    capturedBytes: 0,
    decodedBytes: 0,
    sha256: digest('hist-req'),
    completeness: 'complete',
    structured: {
      model: 'deepseek',
      messages: [
        {
          role: 'assistant',
          tool_calls: [
            {
              type: 'function',
              id: orphanBashId,
              function: {
                name: 'run_bash',
                arguments: '{"command":"echo hi; uname -a"}',
              },
            },
            {
              type: 'function',
              id: orphanMcpId,
              function: {
                name: 'call_mcp_tool',
                arguments: '{"tool_name":"get_lab_fact"}',
              },
            },
          ],
        },
        { role: 'tool', tool_call_id: orphanBashId, content: '{"ok":false}' },
        { role: 'tool', tool_call_id: orphanMcpId, content: '{"ok":true}' },
        { role: 'user', content: 'continue' },
      ],
    },
  },
};

const before = reconstructMissingToolCallsFromRequestHistory([orphanResultOnly]);
assert.equal(before.length, 2);
assert.deepEqual(
  before.map((item) => item.toolCallId).sort(),
  [orphanBashId, orphanMcpId].sort(),
);
assert.equal(before[0].sourceInteractionId, orphanResultOnly.interactionId);
assert.ok(BigInt(before[0].issuedAtUnixNs) < BigInt(orphanResultOnly.startedAtUnixNs));

const projected = projectInteractionsWithReconstructedHistoryToolCalls([orphanResultOnly]);
assert.equal(projected.length, 1);
assert.equal(projected[0].toolCalls.length, 3);
assert.ok(projected[0].partialReasons.includes(TOOL_CALL_RECONSTRUCTED_FROM_REQUEST_HISTORY));
assert.ok(projected[0].toolCalls.some((call) => call.toolCallId === orphanBashId && call.name === 'run_bash'));

const histClosure = closeToolCallsAcrossInteractions(projected);
assert.equal(
  histClosure.matches.filter((match) =>
    match.toolCallId === orphanBashId || match.toolCallId === orphanMcpId).length,
  2,
);

const histSummary = {
  schemaVersion: 'anysentry.agent_conversation.v1',
  conversationId: 'cv_hist_replay',
  agentAssetId: 'aa_p2',
  agentProduct: 'LangGraph',
  title: 'history replay',
  groupingQuality: 'exact',
  hasContent: true,
  status: 'active',
  interactionCount: 1,
  modelInteractionCount: 1,
  toolCallCount: 3,
  toolResultCount: 2,
  coverage: { completeness: 'partial', partial: true, reasons: [] },
};
const histTimeline = projectSemanticConversationTimeline(histSummary, [orphanResultOnly], []);
const histEvents = histTimeline.flatMap((turn) => turn.events);
const histCallIds = histEvents
  .filter((event) => event.kind === 'tool_call')
  .map((event) => event.toolCallId);
assert.ok(histCallIds.includes(orphanBashId), 'timeline must surface reconstructed bash tool_call');
assert.ok(histCallIds.includes(orphanMcpId), 'timeline must surface reconstructed mcp tool_call');
const orphanBashCall = histEvents.find((event) =>
  event.kind === 'tool_call' && event.toolCallId === orphanBashId);
assert.equal(orphanBashCall?.status, 'failed');
const orphanMcpCall = histEvents.find((event) =>
  event.kind === 'tool_call' && event.toolCallId === orphanMcpId);
assert.equal(orphanMcpCall?.status, 'succeeded');

// ---------------------------------------------------------------------------
// HTTP tool capture evidence: semantic tool_call inherits HTTP evidenceEventIds
// when Observer stamped the same toolCallId on /bash or /mcp.
// ---------------------------------------------------------------------------
const {
  linkHttpToolCaptureEvidence,
} = require('../apps/api/dist/security-monitoring/agent-tool-closure.js');

const sharedCallId = 'call_http_linked_001';
const modelWithCall = {
  ...baseInteraction,
  interactionId: `mi_${digest('http-model').slice(0, 24)}`,
  at: now + 40_000,
  startedAtUnixNs: ns(now + 40_000),
  requestCompleteAtUnixNs: ns(now + 40_001),
  responseCompleteAtUnixNs: ns(now + 40_002),
  endedAtUnixNs: ns(now + 40_003),
  evidenceEventIds: ['ev_model_plain'],
  request: {
    ...baseInteraction.request,
    bodyPreview: JSON.stringify({
      messages: [{
        role: 'assistant',
        tool_calls: [{
          id: sharedCallId,
          type: 'function',
          function: { name: 'run_bash', arguments: '{"command":"uname"}' },
        }],
      }],
    }),
  },
  response: { ...baseInteraction.response, bodyPreview: '{}' },
  toolCalls: [{
    toolCallId: sharedCallId,
    name: 'run_bash',
    arguments: { command: 'uname' },
    issuedAtUnixNs: ns(now + 40_000),
  }],
  toolResults: [],
};
const httpToolCapture = {
  ...baseInteraction,
  interactionId: `mi_${digest('http-tool').slice(0, 24)}`,
  interactionType: 'tool',
  at: now + 40_100,
  startedAtUnixNs: ns(now + 40_100),
  requestCompleteAtUnixNs: ns(now + 40_101),
  responseCompleteAtUnixNs: ns(now + 40_102),
  endedAtUnixNs: ns(now + 40_103),
  evidenceEventIds: ['ev_http_bash_req', 'ev_http_bash_rsp'],
  toolName: 'http.bash.execute',
  toolCalls: [{
    toolCallId: sharedCallId,
    name: 'http.bash.execute',
    arguments: { command: 'uname' },
    issuedAtUnixNs: ns(now + 40_100),
  }],
  toolResults: [],
  request: { ...baseInteraction.request, bodyPreview: '{"command":"uname"}' },
  response: { ...baseInteraction.response, bodyPreview: '{"ok":true}' },
};

const httpLinks = linkHttpToolCaptureEvidence([modelWithCall, httpToolCapture]);
assert.equal(httpLinks.byToolCallId.get(sharedCallId)?.httpInteractionId, httpToolCapture.interactionId);
assert.deepEqual(
  httpLinks.byToolCallId.get(sharedCallId)?.evidenceEventIds,
  ['ev_http_bash_req', 'ev_http_bash_rsp'],
);

const httpSummary = {
  ...histSummary,
  conversationId: 'cv_http_evidence',
  interactionCount: 2,
  modelInteractionCount: 1,
  toolCallCount: 1,
  toolResultCount: 0,
};
const httpTimeline = projectSemanticConversationTimeline(
  httpSummary,
  [modelWithCall, httpToolCapture],
  [],
);
const linkedCall = httpTimeline.flatMap((turn) => turn.events)
  .find((event) => event.kind === 'tool_call' && event.toolCallId === sharedCallId);
assert.ok(linkedCall, 'timeline must keep model tool_call');
assert.ok(
  linkedCall.evidenceEventIds.includes('ev_http_bash_req')
  && linkedCall.evidenceEventIds.includes('ev_model_plain'),
  'tool_call must union HTTP capture evidence with model evidence',
);
assert.ok(
  linkedCall.sourceInteractionIds.includes(httpToolCapture.interactionId),
  'tool_call must cite HTTP interaction as source',
);

console.log('verify-agent-tool-closure: ok');
