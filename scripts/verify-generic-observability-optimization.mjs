#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const readinessSource = readFileSync(
  new URL('../apps/api/src/security-monitoring/observability-readiness.ts', import.meta.url),
  'utf8',
);
assert.match(readinessSource, /anysentry\.observability_readiness\.v1/);
assert.match(readinessSource, /globallyOpened/);
assert.match(readinessSource, /enforcedInfrastructureRules/);

const require = createRequire(import.meta.url);
const {
  observedAgentProduct,
  looksLikeSystemdUnit,
  inMemoryPlanTool,
  expectedNoKernelTool,
  toolDelegatedCode,
  toolContentCode,
} = require('../apps/api/dist/security-monitoring/agent-tool-shape.js');
const {
  bindInferredProducerRun,
} = require('../apps/api/dist/security-monitoring/agent-run-projection.js');
const {
  conversationCoverage,
} = require('../apps/api/dist/security-monitoring/agent-conversation.js');

assert.equal(looksLikeSystemdUnit('user@1001.service'), true);
assert.equal(looksLikeSystemdUnit('python'), false);
assert.equal(inMemoryPlanTool('write_todos'), true);
assert.equal(inMemoryPlanTool('http.code.execute'), false);
assert.equal(expectedNoKernelTool('write_todos', { todos: [{ content: 'plan' }] }), true);
assert.equal(expectedNoKernelTool('lookup_fixture', { key: 'canary' }), true);
assert.equal(expectedNoKernelTool('remember', { note: 'in-process' }), true);
assert.equal(expectedNoKernelTool('inventory_fingerprint', { task: 'undeclared' }), false);
assert.equal(expectedNoKernelTool('run_python', { code: 'print(1)' }), false);
assert.equal(expectedNoKernelTool('http.code.execute', { endpoint: 'http://127.0.0.1/execute' }), false);
assert.equal(expectedNoKernelTool('read_file', { path: '/tmp/x' }), false);
assert.equal(toolDelegatedCode({ code: 'print(8 + 9)', timeout_ms: 4000 }), 'print(8 + 9)');
assert.equal(toolDelegatedCode({ command: 'uname -p' }), undefined);
assert.equal(toolContentCode({ command: 'uname -p' }), 'uname -p');
assert.equal(observedAgentProduct({
  displayName: 'user@1001.service',
  agentId: 'user@1001.service',
  process: { comm: 'python', exe: '/usr/bin/python' },
}), 'python');
assert.equal(observedAgentProduct({
  semanticProduct: 'user@1001.service',
  displayName: 'user@1001.service',
}), undefined);

const empty = {
  schemaVersion: 'anysentry.agent_interaction.v1',
  interactionType: 'model',
  workspacePath: 'agent://fixture',
  agentAssetId: 'agent-host',
  agentInstanceId: 'container:python',
  runtimeInstanceId: 'container:python',
  connectionId: 'c1',
  transport: 'http',
  protocol: 'http',
  endpoint: '127.0.0.1:18082',
  method: 'POST',
  path: '/v1/chat/completions',
  statusCode: 200,
  at: 1_788_800_000_100,
  startedAtUnixNs: '1788800000100000000',
  requestCompleteAtUnixNs: '1788800000100000000',
  firstResponseAtUnixNs: '1788800000100000000',
  endedAtUnixNs: '1788800000100000000',
  durationNs: '1000',
  timeQuality: 'collector_calibrated',
  detectedClassification: 'probable_agent',
  currentEffectiveClassification: 'probable_agent',
  completeness: 'complete',
  partialReasons: [],
  toolCalls: [],
  toolResults: [],
  request: {
    body: '{}',
    encoding: 'utf8',
    contentType: 'application/json',
    capturedBytes: 2,
    decodedBytes: 2,
    sha256: 'a',
    completeness: 'complete',
  },
  response: {
    body: '{}',
    encoding: 'utf8',
    contentType: 'application/json',
    capturedBytes: 2,
    decodedBytes: 2,
    sha256: 'b',
    completeness: 'complete',
  },
};

const inbound = {
  ...empty,
  interactionId: 'mi_invoke',
  path: '/invoke',
  routeShape: '/invoke',
  at: 1_788_800_000_000,
  runId: 'lc_from_body',
  runIdSource: 'legacy',
};
const child = {
  ...empty,
  interactionId: 'mi_chat',
  path: '/v1/chat/completions',
};
const bound = bindInferredProducerRun([inbound, child]);
assert.equal(bound.find((item) => item.interactionId === 'mi_chat')?.producerRunId, 'lc_from_body');
assert.equal(bound.find((item) => item.interactionId === 'mi_invoke')?.runId, 'lc_from_body');

const otherRuntime = bindInferredProducerRun([
  inbound,
  { ...child, runtimeInstanceId: 'container:other', agentInstanceId: 'container:other' },
]);
assert.equal(otherRuntime[1]?.producerRunId, undefined,
  'inferred run must not cross runtime instances');

const recovered = conversationCoverage([{
  ...empty,
  interactionId: 'mi_recovered',
  interactionType: 'unparsed',
  completeness: 'partial',
  parseState: 'unparsed',
  partialReasons: ['wire_template_unparsed', 'wire_unknown', 'reassembly_idle_expire_incomplete'],
  request: {
    ...empty.request,
    structured: { input: 'hello' },
  },
  response: {
    ...empty.response,
    structured: { output: 'world' },
  },
}]);
assert.equal(recovered.status, 'complete');
assert.ok(!recovered.reasons.includes('wire_template_unparsed'));
assert.ok(!recovered.reasons.includes('reassembly_idle_expire_incomplete'));

console.log('verify-generic-observability-optimization: ok');
