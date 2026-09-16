#!/usr/bin/env node
/**
 * Session coverage must apply P2 cross-interaction ToolResult closure the same way
 * conversation directory does. Durable SemanticRecord rows may still say
 * tool_result_pending after a later interaction closed the call.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { conversationCoverage } = require('../apps/api/dist/security-monitoring/agent-conversation.js');

const base = {
  schemaVersion: 'anysentry.agent_interaction.v1',
  interactionType: 'model',
  at: Date.now(),
  startedAtUnixNs: '1789566630000000000',
  endedAtUnixNs: '1789566631000000000',
  workspacePath: 'agent://test',
  sourceId: 'src_test',
  collectorId: 'collector_test',
  agentAssetId: 'agent_test',
  agentInstanceId: 'instance_test',
  runtimeInstanceId: 'instance_test',
  environment: 'host',
  path: '/v1/chat/completions',
  method: 'POST',
  statusCode: 200,
  transportCompleteness: 'complete',
  wireCompleteness: 'complete',
  parseState: 'parsed',
  request: { body: '{}', encoding: 'utf8', contentType: 'application/json', capturedBytes: 2, decodedBytes: 2, sha256: 'a'.repeat(64), completeness: 'complete' },
  response: { body: '{}', encoding: 'utf8', contentType: 'application/json', capturedBytes: 2, decodedBytes: 2, sha256: 'b'.repeat(64), completeness: 'complete' },
  sessionId: 'run_session_coverage_tool_closure',
  canonicalSessionId: 'sess_session_coverage_tool_closure',
};

const call = {
  ...base,
  interactionId: 'mi_call_pending',
  completeness: 'partial',
  conversationCompleteness: 'tool_pending',
  partialReasons: ['tool_result_pending'],
  toolCalls: [{
    toolCallId: 'call_closure_1',
    name: 'run_in_sandbox',
    arguments: { code: 'print(1)' },
    issuedAtUnixNs: '1789566630500000000',
  }],
  toolResults: [],
};

const result = {
  ...base,
  interactionId: 'mi_result_closes',
  completeness: 'complete',
  conversationCompleteness: 'complete',
  partialReasons: [],
  toolCalls: [],
  toolResults: [{
    toolCallId: 'call_closure_1',
    content: '{"ok":true}',
    isError: false,
    observedAtUnixNs: '1789566630800000000',
  }],
};

const covered = conversationCoverage([call, result]);
assert.equal(covered.status, 'complete', 'P2 closure must make Session/conversation coverage complete');
assert.equal(covered.completeInteractions, 2);
assert.equal(covered.partialInteractions, 0);

const stillOpen = conversationCoverage([call]);
assert.equal(stillOpen.status, 'partial');
assert.equal(stillOpen.partialInteractions, 1);
assert.ok(stillOpen.reasons.includes('tool_result_pending'));

console.log('PASS session/conversation coverage applies P2 tool-closure across interactions');
