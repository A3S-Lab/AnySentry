#!/usr/bin/env node

import assert from 'node:assert/strict';

import { SecurityAssistantService } from '../apps/api/dist/security-monitoring/security-assistant.service.js';

const assetId = 'agent_asset_context_unit';
const workspacePath = '/workspace/context-unit';
const buildCalls = [];
const bundle = {
  schemaVersion: 'anysentry.system_context_bundle.v1',
  bundleId: 'scb_context_unit',
  generatedAt: new Date().toISOString(),
  focus: { agentAssetId: assetId },
  window: { startTime: new Date(Date.now() - 60_000).toISOString(), endTime: new Date().toISOString() },
  limits: { maxHops: 2, maxBytes: 64 * 1_024 },
  toolEvidence: [],
  relatedResources: [{ resourceId: 'service:business-api', role: 'business_service' }],
  dependencies: [],
  metrics: [{ metricId: 'metric:error-rate', name: 'http.server.error_rate', value: 0.23, status: 'anomalous' }],
  alerts: [],
  changes: [],
  collectionQuality: [],
  summary: { businessServiceCount: 1, maxTopologyHop: 2 },
  quality: {
    status: 'partial',
    confidence: 0.78,
    reasons: [{ code: 'source_partial' }],
    domains: [{ domain: 'metrics', state: 'partial' }],
    output: { truncated: false, estimatedBytes: 4_096 },
  },
};

const aggregation = {
  healthCardForWindow: () => ({ healthScore: 99 }),
  riskSummaryForWindow: () => ({ total: 1 }),
  decisionFunnelForWindow: () => ({ observed: 1 }),
  agentEventsForWindow: () => ({
    items: [{
      eventId: 'evt-context-unit', eventKind: 'ToolExec', agentId: 'codex', agentAssetId: assetId,
      workspacePath, traceId: 'legacy-trace-must-stay-legacy',
    }],
  }),
  incidents: () => ({ items: [] }),
};
const alerting = { list: () => ({ items: [] }) };
const streamFindings = { list: () => ({ compositeJudgments: [] }) };
const supplyChain = { overview: () => ({ findings: [] }) };
const systemContext = {
  build: async (query) => {
    buildCalls.push(structuredClone(query));
    return structuredClone(bundle);
  },
};

const service = new SecurityAssistantService(
  aggregation,
  alerting,
  streamFindings,
  supplyChain,
  systemContext,
);
const context = service.sanitizeContext({
  path: '/agents',
  timeType: 'last_30d',
  agentId: 'codex',
  agentAssetId: assetId,
  agentInstanceId: 'runtime-context-unit',
  invocationId: 'invocation-context-unit',
  toolCallId: 'tool-context-unit',
  workspacePath,
  traceId: 'legacy-trace-must-stay-legacy',
});
const collected = await service.collectEvidence(context);
assert.equal(buildCalls.length, 1);
assert.deepEqual(buildCalls[0], {
  timeType: 'last_30d',
  startTime: '',
  endTime: '',
  scope: 'raw',
  agentId: 'codex',
  workspacePath,
  agentAssetId: assetId,
  agentInstanceId: 'runtime-context-unit',
  invocationId: 'invocation-context-unit',
  toolCallId: 'tool-context-unit',
  limits: {
    maxWindowMs: 24 * 60 * 60_000,
    maxHops: 2,
    maxTools: 16,
    maxKernelEvidencePerTool: 16,
    maxResources: 24,
    maxDependencies: 32,
    maxMetrics: 32,
    maxMetricsPerResource: 8,
    maxAlerts: 16,
    maxChanges: 16,
    maxCollectionQuality: 8,
    maxSources: 24,
    maxBytes: 64 * 1_024,
  },
});
assert.equal(collected.snapshot.context.traceId, 'legacy-trace-must-stay-legacy');
assert.equal(Object.hasOwn(buildCalls[0], 'traceId'), false, 'legacy Trace is not rewritten into System Context identity');
assert.equal(collected.snapshot.systemContext.status, 'partial');
assert.equal(collected.snapshot.systemContext.bundle.bundleId, bundle.bundleId);
assert(collected.snapshot.systemContext.reasonCodes.includes('source_partial'));
assert(collected.snapshot.systemContext.reasonCodes.includes('domain_metrics_partial'));
assert(collected.references.some((reference) => reference.id === bundle.bundleId && reference.href.includes(assetId)));
const summary = service.systemContextSummary(collected.snapshot);
assert.deepEqual(summary, {
  status: 'partial', requested: true, agentAssetId: assetId, bundleId: bundle.bundleId,
  confidence: 0.78, estimatedBytes: 4_096,
  reasonCodes: ['source_partial', 'domain_metrics_partial'],
});

buildCalls.length = 0;
const inferred = await service.collectEvidence(service.sanitizeContext({
  timeType: 'last_3h', agentId: 'codex', workspacePath,
}));
assert.equal(buildCalls.length, 1);
assert.equal(buildCalls[0].agentAssetId, assetId, 'one bounded scoped event can resolve one exact Asset');
assert.equal(inferred.snapshot.systemContext.agentAssetId, assetId);

buildCalls.length = 0;
const overview = await service.collectEvidence(service.sanitizeContext({ timeType: 'last_3h' }));
assert.equal(buildCalls.length, 0, 'an unscoped overview never selects an arbitrary Agent for context');
assert.deepEqual(overview.snapshot.systemContext, {
  status: 'partial', requested: false, reasonCodes: ['agent_asset_not_selected'],
});

const unavailable = new SecurityAssistantService(
  aggregation,
  alerting,
  streamFindings,
  supplyChain,
  { build: async () => { throw new Error('storage detail must not leak'); } },
);
const failed = await unavailable.collectEvidence(context);
assert.deepEqual(failed.snapshot.systemContext, {
  status: 'partial', requested: true, agentAssetId: assetId, reasonCodes: ['system_context_unavailable'],
});
assert(failed.snapshot.unavailableSources.includes('systemContext'));
assert.equal(JSON.stringify(failed.snapshot).includes('storage detail must not leak'), false);

console.log('S7 Assistant bounded System Context consumption verification passed');
