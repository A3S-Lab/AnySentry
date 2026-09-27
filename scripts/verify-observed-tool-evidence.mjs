#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  observedToolRelationInputs,
  observedKernelSearchWindow,
  projectObservedToolEvidence,
} = require('../apps/api/dist/security-monitoring/observed-tool-evidence.js');

const invocationId = 'run-observed-tool-1';
const callAt = 1_788_600_000_000;
const toolInteraction = {
  schemaVersion: 'anysentry.agent_interaction.v1',
  interactionId: 'mi_http_tool',
  interactionType: 'tool',
  at: callAt,
  workspacePath: 'agent://fixture',
  agentAssetId: 'agent-observed',
  agentInstanceId: 'docker:agent:1',
  invocationId,
  runId: invocationId,
  sessionId: invocationId,
  endpoint: 'python-sandbox:8080',
  connectionId: 'conn-observed',
  transport: 'http',
  protocol: 'http',
  detectedClassification: 'probable_agent',
  currentEffectiveClassification: 'probable_agent',
  evidenceEventIds: ['evt_http_plain'],
  startedAtUnixNs: String(BigInt(callAt) * 1_000_000n),
  endedAtUnixNs: String(BigInt(callAt + 80) * 1_000_000n),
  toolCalls: [{
    toolCallId: 'http-code-1',
    name: 'http.code.execute',
    arguments: { code: 'print(8 + 9)', timeout_ms: 4000 },
    issuedAtUnixNs: String(BigInt(callAt) * 1_000_000n),
  }],
  toolResults: [{
    toolCallId: 'http-code-1',
    name: 'http.code.execute',
    content: { stdout: '17\n', exit_code: 0 },
    isError: false,
    observedAtUnixNs: String(BigInt(callAt + 80) * 1_000_000n),
  }],
};
const modelInteraction = {
  ...toolInteraction,
  interactionId: 'mi_model_call',
  interactionType: 'model',
  endpoint: 'llm:443',
  evidenceEventIds: ['evt_llm_plain'],
  toolCalls: [{
    toolCallId: 'call-model-1',
    name: 'run_python',
    arguments: { code: 'print(8 + 9)' },
    issuedAtUnixNs: String(BigInt(callAt - 20) * 1_000_000n),
  }],
  toolResults: [],
};

const inputs = observedToolRelationInputs(
  [modelInteraction, toolInteraction],
  invocationId,
);
assert.equal(inputs.length, 2);
assert.equal(inputs.find((item) => item.event.toolCallId === 'http-code-1')?.interaction.interactionType, 'tool');
assert.deepEqual(
  inputs.find((item) => item.event.toolCallId === 'http-code-1')?.event.content,
  { code: 'print(8 + 9)', timeout_ms: 4000 },
);

const egress = {
  eventId: 'evt_tool_egress',
  at: new Date(callAt + 10).toISOString(),
  eventKind: 'Egress',
  subject: 'egress → python-sandbox:8080',
  agentRuntimeInstanceId: toolInteraction.agentInstanceId,
  agentRuntimeInstanceAliases: [toolInteraction.agentInstanceId],
  attributes: { host: 'python-sandbox', port: 8080 },
  verdict: 'allow',
  tier: 'Rules',
  severity: 'info',
  riskScore: 0,
  riskName: '正常',
  riskCategory: 'benign',
  reason: 'observed',
};
const exec = {
  ...egress,
  eventId: 'evt_tool_exec',
  eventKind: 'ToolExec',
  subject: 'python -c print(8 + 9)',
  agentRuntimeInstanceId: 'docker:python-sandbox:2',
  agentRuntimeInstanceAliases: [],
  attributes: { argv: 'python -c print(8 + 9)' },
  at: new Date(callAt + 25).toISOString(),
  attribution: {
    processGenerationKey: 'pgk_obs_child',
    parentProcessGenerationKey: 'pgk_obs_parent',
    parentLinkAuthority: 'forwarder_process_graph',
  },
};
const healthcheck = {
  ...exec,
  eventId: 'evt_healthcheck',
  subject: "python -c import urllib.request; urllib.request.urlopen('http://127.0.0.1/healthz')",
  attributes: {
    argv: "python -c import urllib.request; urllib.request.urlopen('http://127.0.0.1/healthz')",
  },
};

const linked = projectObservedToolEvidence(
  invocationId,
  [modelInteraction, toolInteraction],
  [egress, exec, healthcheck],
  3,
  false,
);
const httpItem = linked.items.find((item) => item.toolCallId === 'http-code-1');
assert.ok(httpItem, 'observed HTTP tool call must appear in tool-evidence');
assert.equal(httpItem.status, 'linked');
assert.equal(httpItem.reason, 'delegated_command');
assert.equal(httpItem.kernelEvidence[0]?.eventId, exec.eventId);
assert.equal(httpItem.kernelEvidence[0]?.linkMethod, 'delegated_command');
assert.ok(!httpItem.kernelEvidence.some((item) => item.eventId === healthcheck.eventId),
  'unrelated healthcheck ToolExec must not own the code-execution tool');
assert.deepEqual(httpItem.adapterEventIds, ['evt_http_plain']);

const aliasItem = linked.items.find((item) => item.toolCallId === 'call-model-1');
assert.ok(aliasItem, 'model-lane code tool must appear in tool-evidence');
assert.equal(aliasItem.status, 'linked');
assert.equal(aliasItem.kernelEvidence[0]?.eventId, httpItem.kernelEvidence[0]?.eventId);

const search = observedKernelSearchWindow([modelInteraction, toolInteraction]);
assert.ok(search);
assert.ok(search.endMs - search.startMs < 60_000, 'kernel search must stay on the tool interval, not a 30m slab');

const todoInteraction = {
  ...toolInteraction,
  interactionId: 'mi_todo',
  toolCalls: [{
    toolCallId: 'todo-1',
    name: 'write_todos',
    arguments: { todos: [{ id: '1', content: 'plan' }] },
    issuedAtUnixNs: String(BigInt(callAt) * 1_000_000n),
  }],
  toolResults: [{
    toolCallId: 'todo-1',
    name: 'write_todos',
    content: { ok: true },
    isError: false,
    observedAtUnixNs: String(BigInt(callAt + 5) * 1_000_000n),
  }],
};
const todoProjected = projectObservedToolEvidence(
  invocationId,
  [todoInteraction],
  [egress],
  3,
  false,
);
assert.equal(todoProjected.items[0]?.status, 'semantic_only');
assert.equal(todoProjected.items[0]?.reason, 'no_kernel_event_expected');

const lookupInteraction = {
  ...toolInteraction,
  interactionId: 'mi_lookup',
  endpoint: undefined,
  toolCalls: [{
    toolCallId: 'lookup-1',
    name: 'lookup_fixture',
    arguments: { key: 'canary' },
    issuedAtUnixNs: String(BigInt(callAt) * 1_000_000n),
  }],
  toolResults: [{
    toolCallId: 'lookup-1',
    name: 'lookup_fixture',
    content: { value: 'ok' },
    isError: false,
    observedAtUnixNs: String(BigInt(callAt + 5) * 1_000_000n),
  }],
};
const lookupProjected = projectObservedToolEvidence(
  invocationId,
  [lookupInteraction],
  [egress],
  3,
  true,
);
assert.equal(lookupProjected.items[0]?.status, 'semantic_only');
assert.equal(lookupProjected.items[0]?.reason, 'no_kernel_event_expected');

const truncated = projectObservedToolEvidence(
  invocationId,
  [toolInteraction],
  [],
  3,
  true,
);
assert.equal(truncated.items[0]?.reason, 'candidates_truncated');

const otherInvocation = projectObservedToolEvidence(
  'run-other',
  [modelInteraction, toolInteraction],
  [egress, exec],
  3,
  false,
);
assert.equal(otherInvocation.items.length, 0);

console.log('verify-observed-tool-evidence: ok');
