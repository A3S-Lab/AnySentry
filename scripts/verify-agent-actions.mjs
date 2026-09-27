#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AggregationService } = require('../apps/api/dist/security-monitoring/aggregation.service.js');

const now = Date.now();
const at = (offset) => new Date(now + offset).toISOString();

function event({
  eventId,
  toolName,
  toolCallId,
  phase,
  sourceId = 'adapter-a',
  invocationId = 'invocation-a',
  attributes = {},
}) {
  return {
    eventId,
    at: at(phase === 'start' ? 0 : 25),
    sourceId,
    agentAssetId: 'agent-canonical',
    agentAssetAliases: ['agent-legacy'],
    agentProduct: 'fixture-product',
    agentRuntimeInstanceId: 'runtime-exact-a',
    invocationId,
    toolCallId,
    subject: `Fixture ${toolName} ${phase}`,
    attributes: {
      'anysentry.lifecycle.phase': phase,
      'gen_ai.tool.name': toolName,
      ...attributes,
    },
  };
}

const semanticEvents = [
  event({ eventId: 'read-start', toolName: 'read', toolCallId: 'read-call', phase: 'start', attributes: { 'anysentry.tool.resource_path': '/workspace/input.txt' } }),
  event({ eventId: 'read-end', toolName: 'read', toolCallId: 'read-call', phase: 'end' }),
  event({ eventId: 'write-start', toolName: 'write', toolCallId: 'write-call', phase: 'start', attributes: { 'anysentry.tool.resource_path': '/workspace/output.txt' } }),
  event({ eventId: 'write-end', toolName: 'write', toolCallId: 'write-call', phase: 'end' }),
  event({ eventId: 'custom-start', toolName: 'custom_inventory', toolCallId: 'custom-call', phase: 'start' }),
  event({ eventId: 'custom-end', toolName: 'custom_inventory', toolCallId: 'custom-call', phase: 'end', attributes: { 'anysentry.tool.is_error': 'true' } }),
];

function result(items) {
  return {
    items,
    total: items.length,
    totalMode: 'exact',
    coverage: {
      requestedFrom: at(-1_000),
      requestedTo: at(1_000),
      snapshotAsOf: at(1_000),
      asOf: at(1_000),
      partial: false,
      source: 'clickhouse+hot_delta',
      totalMode: 'exact',
    },
  };
}

const calls = [];
const semanticContext = {
  storedAgentEvents: async (query) => {
    calls.push(query);
    return result(semanticEvents);
  },
  classificationResponseMeta: () => ({ classificationView: 'current_effective', reviewRevision: 4, assetBindingRevision: 7 }),
};
const actions = await AggregationService.prototype.storedAgentActions.call(semanticContext, {
  timeType: 'last_3h',
  agentAssetId: 'agent-canonical',
  agentInstanceId: 'runtime-exact-a',
  limit: 80,
});

assert.equal(calls.length, 1, 'the list path does not run per-action ToolEvidence queries');
assert.equal(calls[0].eventKind, 'AgentTool');
assert.equal(actions.items.length, 3, 'Tool start/end pairs collapse into three user actions');
assert.deepEqual(new Set(actions.items.map((item) => item.toolName)), new Set(['read', 'write', 'custom_inventory']));
assert.equal(actions.items.find((item) => item.toolName === 'custom_inventory').status, 'failed');
assert.equal(actions.items.find((item) => item.toolName === 'read').targetSummary, '/workspace/input.txt');
assert(actions.items.every((item) => item.origin === 'semantic'));
assert(actions.items.every((item) => item.evidenceState === 'available_on_demand'));
assert(actions.items.every((item) => item.semanticEventIds.length === 2));
assert.equal(actions.coverage.partial, false);

const otherSourceEvents = semanticEvents.map((item) => ({ ...item, sourceId: 'adapter-b' }));
const otherSourceContext = {
  ...semanticContext,
  storedAgentEvents: async () => result(otherSourceEvents),
};
const otherSourceActions = await AggregationService.prototype.storedAgentActions.call(otherSourceContext, {
  timeType: 'last_3h',
  agentAssetId: 'agent-canonical',
});
assert.notEqual(
  actions.items.find((item) => item.toolName === 'read').actionId,
  otherSourceActions.items.find((item) => item.toolName === 'read').actionId,
  'Source scope participates in the stable action key',
);

let fallbackCalls = 0;
const fallbackContext = {
  storedAgentEvents: async (query) => {
    fallbackCalls += 1;
    if (query.eventKind === 'AgentTool') return result([]);
    return result([
      {
        eventId: 'exec-one',
        at: at(50),
        eventKind: 'ToolExec',
        sourceId: 'observer-a',
        agentAssetId: 'agent-no-adapter',
        agentRuntimeInstanceId: 'runtime-root-b',
        subject: '/usr/bin/rg TODO',
        attributes: {},
        process: { comm: 'rg' },
      },
      {
        eventId: 'read-one',
        at: at(60),
        eventKind: 'FileAccess',
        sourceId: 'observer-a',
        agentAssetId: 'agent-no-adapter',
        agentRuntimeInstanceId: 'runtime-root-b',
        subject: 'file /workspace/README.md',
        attributes: { accessMode: 'read_only', path: '/workspace/README.md' },
      },
    ]);
  },
  classificationResponseMeta: () => ({ classificationView: 'current_effective', reviewRevision: 0 }),
};
const fallback = await AggregationService.prototype.storedAgentActions.call(fallbackContext, {
  timeType: 'last_3h',
  agentAssetId: 'agent-no-adapter',
});
assert.equal(fallbackCalls, 2);
assert.equal(fallback.items.length, 2);
assert.equal(fallback.items[0].origin, 'kernel_inferred');
assert.equal(fallback.items[0].evidenceState, 'runtime_level');
assert.equal(fallback.items[0].toolName, 'rg');
assert.equal(fallback.items[0].invocationId, undefined, 'runtime actions do not invent Invocation IDs');
assert.equal(fallback.items[1].operation, 'file_read');
assert.equal(fallback.items[1].toolName, 'read file');
assert.equal(fallback.items[1].targetSummary, '/workspace/README.md');

console.log('Agent Action aggregation verification passed');
