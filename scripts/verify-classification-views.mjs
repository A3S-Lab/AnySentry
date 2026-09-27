#!/usr/bin/env node

import assert from 'node:assert/strict';

const { AggregationService, resolvedClassificationView } = await import(
  '../apps/api/dist/security-monitoring/aggregation.service.js'
);

assert.equal(resolvedClassificationView({}), 'as_observed');
assert.equal(resolvedClassificationView({ classificationView: 'as_observed' }), 'as_observed');
assert.equal(resolvedClassificationView({ classificationView: 'current_effective' }), 'current_effective');

const now = Date.now();
const event = {
  schemaVersion: 'anysentry.agent_event.v1',
  eventId: 'evt-classification-view',
  at: now - 1_000,
  eventKind: 'ToolExec',
  eventCategory: 'tool',
  source: 'observer',
  subject: '/usr/bin/pi run',
  workspacePath: 'repo://classification-view',
  agentId: 'pi-agent',
  subjectAssetId: 'service:k8s:cluster-a:default:pi-service',
  subjectAssetType: 'service',
  assetBindingQuality: 'logical',
  assetBindingRevision: 4,
  sessionId: 'session-a',
  userId: 'uid:1000',
  traceId: 'trace-a',
  spanId: 'span-a',
  runId: 'run-a',
  decisionStatus: 'succeeded',
  decisionRevision: 1,
  decisionUpdatedAt: now - 900,
  verdict: 'block',
  tier: 'Rules',
  severity: 'high',
  reason: 'historical risk result',
  riskCategory: 'command_danger',
  riskName: '危险命令执行',
  riskType: 'atomic',
  riskScore: 80,
  tokenCount: 0,
  latencyMs: 1,
  attributes: { argv: '/usr/bin/pi run' },
  attribution: {
    monitored: true,
    classification: 'confirmed_agent',
    confidence: 1,
    reason: 'authoritative_anchor',
    source: 'process_graph',
    evidence: ['fixture:as-observed-agent'],
  },
};

let currentClassification = 'non_agent';
let reviewRevision = 7;
const judge = {
  queryRange: () => [event],
  query: () => [event],
  committedEventProgress: () => [],
  storageStatus: () => ({ clickhouseReady: true }),
  searchStoredEventsPage: async () => ({ events: [event], hasMore: false, committedCutoffMs: now }),
};
const metadata = {
  resolveEvent: () => ({
    agentAssetId: 'agent_stable_asset',
    detectedName: 'pi-agent',
    detectedClassification: 'confirmed_agent',
    effectiveClassification: currentClassification,
    reviewRevision,
    reviewEffectiveAt: now,
  }),
  canonicalAgentAssetId: (value) => value,
  identitySnapshotVersion: () => reviewRevision,
};
const assetReviews = {
  current: () => currentClassification ? { decision: currentClassification } : undefined,
  version: () => 0,
};
const aggregation = new AggregationService(judge, metadata, {}, {}, {}, assetReviews);

const asObserved = aggregation.agentEvents({
  timeType: 'last_1h',
  scope: 'agent',
  classificationView: 'as_observed',
  noise: 'include',
});
assert.equal(asObserved.total, 1, 'the historical Agent remains in the as-observed Agent scope');
assert.equal(asObserved.classificationView, 'as_observed');
assert.equal(asObserved.reviewRevision, 7);
assert.equal(asObserved.items[0].asObservedClassification, 'confirmed_agent');
assert.equal(asObserved.items[0].currentEffectiveClassification, 'non_agent');
assert.equal(asObserved.items[0].effectiveClassification, 'confirmed_agent');
assert.equal(asObserved.items[0].verdict, 'block');
assert.equal(asObserved.items[0].reason, 'historical risk result');
const asObservedRisk = aggregation.riskSummary({
  timeType: 'last_1h', scope: 'agent', classificationView: 'as_observed',
});
const asObservedFunnel = aggregation.decisionFunnel({
  timeType: 'last_1h', scope: 'agent', classificationView: 'as_observed',
});
const asObservedTrend = aggregation.explainabilityScan({
  timeType: 'last_1h', scope: 'agent', classificationView: 'as_observed', seriesPoints: 8,
});
assert.equal(asObservedRisk.summaryCards.find((card) => card.riskTypeCode === 'atomic')?.eventCount, 1);
assert.equal(asObservedFunnel.tiers[0].count, asObserved.total, 'card and list use the same as-observed population');
assert.equal(asObservedTrend.waveSeries[0].riskSeries.reduce((sum, point) => sum + point.activationCount, 0), 1);
assert.equal(asObservedRisk.classificationView, 'as_observed');
assert.equal(asObservedFunnel.reviewRevision, 7);

const currentAgentScope = aggregation.agentEvents({
  timeType: 'last_1h',
  scope: 'agent',
  classificationView: 'current_effective',
  noise: 'include',
});
assert.equal(currentAgentScope.total, 0, 'a currently excluded asset leaves only the current Agent grouping');
assert.equal(currentAgentScope.classificationView, 'current_effective');
const currentRisk = aggregation.riskSummary({
  timeType: 'last_1h', scope: 'agent', classificationView: 'current_effective',
});
const currentFunnel = aggregation.decisionFunnel({
  timeType: 'last_1h', scope: 'agent', classificationView: 'current_effective',
});
const currentTrend = aggregation.explainabilityScan({
  timeType: 'last_1h', scope: 'agent', classificationView: 'current_effective', seriesPoints: 8,
});
assert.equal(currentRisk.summaryCards.reduce((sum, card) => sum + card.eventCount, 0), 0);
assert.equal(currentFunnel.tiers[0].count, 0, 'card and list use the same current-effective population');
assert.equal(currentTrend.waveSeries[0].riskSeries.reduce((sum, point) => sum + point.activationCount, 0), 0);
assert.equal(currentRisk.classificationView, 'current_effective');
const durableCurrentRisk = await aggregation.riskSummaryForWindow({
  timeType: 'last_1h', scope: 'agent', classificationView: 'current_effective',
});
const durableCurrentFunnel = await aggregation.decisionFunnelForWindow({
  timeType: 'last_1h', scope: 'agent', classificationView: 'current_effective',
});
assert.equal(durableCurrentRisk.summaryCards.reduce((sum, card) => sum + card.eventCount, 0), currentAgentScope.total);
assert.equal(durableCurrentFunnel.tiers[0].count, currentAgentScope.total);
assert.equal(durableCurrentRisk.coverage?.partial, false, 'current-effective cards use durable bounded overlay when available');

const currentRaw = aggregation.agentEvents({
  timeType: 'last_1h',
  scope: 'raw',
  classificationView: 'current_effective',
  noise: 'include',
});
assert.equal(currentRaw.total, 1);
assert.equal(currentRaw.items[0].effectiveClassification, 'non_agent');
assert.equal(currentRaw.items[0].asObservedClassification, 'confirmed_agent');
assert.equal(currentRaw.items[0].verdict, 'block', 'current grouping must not rewrite the historical verdict');
assert.equal(aggregation.agentEvents({
  timeType: 'last_1h', scope: 'raw', subjectAssetId: event.subjectAssetId, noise: 'include',
}).total, 1, 'subject asset predicate is applied before list slicing');
assert.equal(aggregation.agentEvents({
  timeType: 'last_1h', scope: 'raw', subjectAssetId: 'service:missing', noise: 'include',
}).total, 0);

currentClassification = undefined;
reviewRevision = 8;
const restored = aggregation.agentEvents({
  timeType: 'last_1h',
  scope: 'raw',
  classificationView: 'current_effective',
  noise: 'include',
});
assert.equal(restored.total, 1, 'clearing the overlay restores automatic Service identity without deleting history');
assert.equal(restored.reviewRevision, 8, 'response metadata fences caches by the latest review revision');
assert.equal(restored.items[0].effectiveClassification, 'unknown');
assert.equal(restored.items[0].verdict, 'block');

console.log('Classification view and immutable historical judgment verification passed');
