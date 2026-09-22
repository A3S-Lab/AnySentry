#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  unifiedFilterRuleLineage,
  observabilityCoverageLayers,
  toolEvidenceForInteractions,
  exactSessionPointReadCoverage,
  sessionResourceAliases,
  sessionResourceHydrated,
} = require('../apps/api/dist/security-monitoring/observability-coverage.js');
const {
  conversationCoverage,
} = require('../apps/api/dist/security-monitoring/agent-conversation.js');

const lineage = unifiedFilterRuleLineage({
  captureEpoch: '1789970499771011',
  attributes: {
    filterF2RuleId: 'fr_builtin_f2_agent_keep',
    filterF2RuleRevision: 1,
    filterF2Action: 'keep',
    filterRuleVersion: '1789970499771011',
    filterRuleCatalogVersion: '1789426459527001',
    captureProfile: 'agent_full',
  },
  filterRuleDecision: {
    stage: 'f3',
    catalogVersion: 1,
    ruleId: 'fr_builtin_f3_probable_agent_full',
    revision: 1,
    reason: 'candidate_agent_full',
  },
});
assert.equal(lineage.schemaVersion, 'anysentry.filter_rule_lineage.v1');
assert.equal(lineage.epoch, '1789970499771011');
assert.deepEqual(lineage.stages.map((item) => item.stage), ['f1', 'f2', 'f3']);
assert.equal(lineage.stages[1].catalogVersion, '1789426459527001');
assert.equal(lineage.stages[2].catalogVersion, 1);
assert.equal(lineage.stages[1].version, lineage.epoch);

const interactions = [
  {
    schemaVersion: 'anysentry.agent_interaction.v1',
    interactionId: 'mi_model',
    interactionType: 'model',
    at: 1_788_700_000_000,
    startedAtUnixNs: '1788700000000000000',
    workspacePath: 'agent://fixture',
    agentAssetId: 'agent-a',
    canonicalSessionId: 'sess_a',
    invocationId: 'run-a',
    runId: 'run-a',
    parseState: 'parsed',
    completeness: 'complete',
    conversationCompleteness: 'complete',
    statusCode: 200,
    partialReasons: [],
    toolCalls: [{ toolCallId: 'call-1', name: 'run_python', arguments: { code: 'print(1)' } }],
    toolResults: [{ toolCallId: 'call-1', content: { stdout: '1\n' }, isError: false }],
    currentEffectiveClassification: 'probable_agent',
    detectedClassification: 'probable_agent',
    connectionId: 'c1',
    transport: 'http',
    protocol: 'http',
  },
  {
    schemaVersion: 'anysentry.agent_interaction.v1',
    interactionId: 'mi_tool',
    interactionType: 'tool',
    at: 1_788_700_000_100,
    startedAtUnixNs: '1788700000100000000',
    workspacePath: 'agent://fixture',
    agentAssetId: 'agent-a',
    canonicalSessionId: 'sess_a',
    invocationId: 'run-a',
    runId: 'run-a',
    parseState: 'parsed',
    completeness: 'complete',
    conversationCompleteness: 'complete',
    statusCode: 200,
    partialReasons: [],
    kernelFactId: 'kf_tool',
    toolCalls: [{ toolCallId: 'http-1', name: 'http.code.execute', arguments: { code: 'print(1)' } }],
    toolResults: [{ toolCallId: 'http-1', content: { stdout: '1\n' }, isError: false }],
    currentEffectiveClassification: 'probable_agent',
    detectedClassification: 'probable_agent',
    connectionId: 'c2',
    transport: 'http',
    protocol: 'http',
  },
];
const layers = observabilityCoverageLayers(
  interactions,
  [{
    invocationId: 'run-a',
    toolCallId: 'http-1',
    toolName: 'http.code.execute',
    status: 'linked',
    reason: 'network_witness',
    adapterEventIds: [],
    kernelEvidence: [{ eventId: 'evt_e', eventKind: 'Egress', at: 1, linkMethod: 'network', confidence: 0.9 }],
  }, {
    invocationId: 'run-a',
    toolCallId: 'call-1',
    toolName: 'run_python',
    status: 'semantic_only',
    reason: 'no_matching_kernel_evidence',
    adapterEventIds: [],
    kernelEvidence: [],
  }],
  conversationCoverage(interactions),
);
assert.equal(layers.schemaVersion, 'anysentry.observability_coverage_layers.v1');
assert.equal(layers.plaintext.status, 'complete');
assert.equal(layers.kernel.status, 'partial');
assert.ok(layers.kernel.reasons.includes('tool_kernel_partial'));
assert.equal(layers.session.status, 'complete');
assert.deepEqual(layers.session.canonicalSessionIds, ['sess_a']);
assert.equal(layers.run.status, 'complete');
assert.deepEqual(layers.run.runIds, ['run-a']);
assert.notEqual(layers.plaintext.status, layers.kernel.status,
  'plaintext and kernel coverage must be independently reported');
assert.equal(layers.kernel.factCount, 1,
  'factCount must count linked kernel evidence, not only interaction.kernelFactId');

const closedAliasLayers = observabilityCoverageLayers(
  interactions,
  [{
    invocationId: 'run-a',
    toolCallId: 'http-1',
    toolName: 'http.code.execute',
    status: 'linked',
    reason: 'network_witness',
    adapterEventIds: [],
    kernelEvidence: [{ eventId: 'evt_e', eventKind: 'Egress', at: 1, linkMethod: 'network', confidence: 0.9 }],
  }, {
    invocationId: 'run-a',
    toolCallId: 'call-1',
    toolName: 'run_python',
    status: 'linked',
    reason: 'network_witness',
    adapterEventIds: [],
    kernelEvidence: [{ eventId: 'evt_e', eventKind: 'Egress', at: 1, linkMethod: 'network', confidence: 0.9 }],
  }, {
    invocationId: 'run-a',
    toolCallId: 'todo-1',
    toolName: 'write_todos',
    status: 'semantic_only',
    reason: 'no_kernel_event_expected',
    adapterEventIds: [],
    kernelEvidence: [],
  }],
  conversationCoverage(interactions),
);
assert.equal(closedAliasLayers.kernel.status, 'complete');
assert.equal(closedAliasLayers.kernel.factCount, 1);
assert.ok(!closedAliasLayers.kernel.reasons.includes('tool_kernel_unlinked'));

const pendingInteractions = structuredClone(interactions);
pendingInteractions[0].toolCalls = [{ toolCallId: 'call-pending', name: 'lookup_fixture', arguments: { key: 'canary' } }];
pendingInteractions[0].toolResults = [];
pendingInteractions[0].partialReasons = ['tool_result_pending'];
pendingInteractions[0].conversationCompleteness = 'tool_pending';
const pendingLayers = observabilityCoverageLayers(
  pendingInteractions,
  [],
  conversationCoverage(pendingInteractions),
);
assert.equal(pendingLayers.plaintext.status, 'partial');
assert.ok(pendingLayers.plaintext.reasons.includes('tool_result_pending'));
assert.equal(pendingLayers.session.status, 'complete');
assert.equal(pendingLayers.run.status, 'complete');
assert.notEqual(pendingLayers.plaintext.status, pendingLayers.session.status);

assert.equal(unifiedFilterRuleLineage({ attributes: {} }), undefined);

const parentIx = [{
  ...interactions[1],
  interactionId: 'mi_parent_tool',
  canonicalSessionId: 'sess_parent',
  invocationId: 'shared-run',
  runId: 'shared-run',
  toolCalls: [{ toolCallId: 'parent-http', name: 'http.code.execute', arguments: { code: 'print(1)' } }],
  toolResults: [{ toolCallId: 'parent-http', content: { stdout: '1\n' }, isError: false }],
}];
const childIx = [{
  ...interactions[1],
  interactionId: 'mi_child_tool',
  canonicalSessionId: 'sess_child',
  invocationId: 'shared-run',
  runId: 'shared-run',
  toolCalls: [{ toolCallId: 'child-http', name: 'http.code.execute', arguments: { code: 'print(2)' } }],
  toolResults: [{ toolCallId: 'child-http', content: { stdout: '2\n' }, isError: false }],
}];
const sharedRunItems = [
  {
    invocationId: 'shared-run',
    toolCallId: 'parent-http',
    toolName: 'http.code.execute',
    status: 'linked',
    reason: 'network_witness',
    adapterEventIds: [],
    kernelEvidence: [{ eventId: 'evt_p', eventKind: 'Egress', at: 1, linkMethod: 'network', confidence: 0.9 }],
  },
  {
    invocationId: 'shared-run',
    toolCallId: 'child-http',
    toolName: 'http.code.execute',
    status: 'linked',
    reason: 'network_witness',
    adapterEventIds: [],
    kernelEvidence: [{ eventId: 'evt_c', eventKind: 'Egress', at: 2, linkMethod: 'network', confidence: 0.9 }],
  },
];
assert.deepEqual(
  toolEvidenceForInteractions(sharedRunItems, parentIx).map((item) => item.toolCallId),
  ['parent-http'],
);
assert.deepEqual(
  toolEvidenceForInteractions(sharedRunItems, childIx).map((item) => item.toolCallId),
  ['child-http'],
);
const parentLayers = observabilityCoverageLayers(
  parentIx,
  toolEvidenceForInteractions(sharedRunItems, parentIx),
  conversationCoverage(parentIx),
);
assert.equal(parentLayers.kernel.status, 'complete');
assert.equal(parentLayers.kernel.count, 1);
assert.deepEqual(parentLayers.session.canonicalSessionIds, ['sess_parent']);

const noCallIx = [{
  ...interactions[0],
  interactionId: 'mi_no_call',
  invocationId: 'run-x',
  runId: 'run-x',
  toolCalls: [],
  toolResults: [],
}];
const fallbackItems = [
  {
    invocationId: 'run-x',
    toolCallId: 'any',
    toolName: 'http.code.execute',
    status: 'linked',
    reason: 'network_witness',
    adapterEventIds: [],
    kernelEvidence: [],
  },
  {
    invocationId: 'run-y',
    toolCallId: 'other',
    toolName: 'http.code.execute',
    status: 'linked',
    reason: 'network_witness',
    adapterEventIds: [],
    kernelEvidence: [],
  },
];
assert.deepEqual(
  toolEvidenceForInteractions(fallbackItems, noCallIx).map((item) => item.invocationId),
  ['run-x'],
);

assert.deepEqual(
  exactSessionPointReadCoverage([
    { coverage: { status: 'complete', reasons: [] } },
  ], 'clickhouse'),
  { status: 'complete', reasons: [], source: 'clickhouse' },
);
assert.deepEqual(
  exactSessionPointReadCoverage([
    { coverage: { status: 'complete', reasons: [] } },
    { coverage: { status: 'partial', reasons: ['tool_result_pending'] } },
  ], 'clickhouse'),
  { status: 'partial', reasons: ['tool_result_pending'], source: 'clickhouse' },
);
assert.equal(
  exactSessionPointReadCoverage([], 'clickhouse').status,
  'partial',
);
assert.equal(sessionResourceHydrated({ coverage: { status: 'partial', completeInteractions: 0 }, interactionIds: ['mi_1'] }), false);
assert.equal(sessionResourceHydrated({ coverage: { status: 'complete', completeInteractions: 3 }, interactionIds: ['mi_1'] }), true);
assert.deepEqual(
  sessionResourceAliases({
    sessionId: '70141be3-4eb2-4aa0-ae03-5a049019a827',
    conversationId: 'cv_096f6b1d7c4920c0bfba899e',
    coverageLayers: { run: { runIds: ['70141be3-4eb2-4aa0-ae03-5a049019a827'] } },
  }).sort(),
  ['70141be3-4eb2-4aa0-ae03-5a049019a827', 'cv_096f6b1d7c4920c0bfba899e'].sort(),
);

console.log('verify-observability-coverage: ok');
