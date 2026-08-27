#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AggregationService } = require('../apps/api/dist/security-monitoring/aggregation.service.js');
const { AgentMetadataService } = require('../apps/api/dist/security-monitoring/agent-metadata.service.js');
const { agentRuntimeInstanceIdForEvent } = require('../apps/api/dist/security-monitoring/agent-identity.js');
const { ClickHouseStore } = require('../apps/api/dist/security-monitoring/clickhouse-store.js');

const now = Date.now();

function event(eventId, at, subject) {
  return {
    schemaVersion: 'anysentry.agent_event.v1',
    eventId,
    at,
    eventKind: 'ToolExec',
    eventCategory: 'tool',
    source: 'observer',
    subject,
    workspacePath: '/workspace',
    agentId: 'codex',
    sessionId: 'session',
    userId: 'user',
    traceId: 'trace',
    spanId: `span-${eventId}`,
    runId: 'run',
    verdict: 'allow',
    tier: 'Rules',
    severity: 'info',
    reason: 'fixture',
    riskCategory: 'other',
    riskName: 'fixture',
    riskType: 'atomic',
    riskScore: 0,
    tokenCount: 0,
    latencyMs: 1,
    attributes: {},
    process: {
      hostId: 'node-a', bootId: 'boot-a', pid: 100, ppid: 1,
      startTimeTicks: '1000', comm: 'codex', exe: '/usr/bin/codex', cwd: '/workspace',
    },
    attribution: {
      monitored: true,
      classification: 'confirmed_agent',
      agentScopeId: 'codex-prod',
      agentDisplayName: 'Codex Production',
      rootPid: 100,
      rootStartTime: '1000',
      confidence: 1,
      reason: 'authoritative_anchor',
      source: 'manual_review',
      evidence: ['manual_review:confirmed_agent'],
    },
  };
}

function fact(representativeEvent) {
  const instance = agentRuntimeInstanceIdForEvent(representativeEvent);
  return {
    identityKey: representativeEvent.eventId,
    representativeEvent,
    firstSeenAt: representativeEvent.at,
    lastSeenAt: representativeEvent.at,
    eventCount: 1,
    riskyEventCount: 0,
    sessionCount: 1,
    runCount: 1,
    traceCount: 1,
    sessionKeys: [representativeEvent.sessionId],
    runKeys: [representativeEvent.runId],
    traceKeys: [representativeEvent.traceId],
    collectorKeys: [],
    eventsWithoutCollector: 1,
    tokenCount: 0,
    latencyTotal: 1,
    instanceCount: 1,
    instanceKeys: [instance],
    worstSeverityRank: 0,
    eventCategoryCounts: { tool: 1 },
    sourceCounts: { observer: 1 },
    hasPhysicalIdentity: false,
    hasRootIdentity: true,
  };
}

const durable = event('durable-event', now - 2 * 60 * 60_000, 'durable command');
const pending = event('pending-event', now - 10_000, 'pending command');
let durableQueries = 0;
let pendingQueries = 0;
let durableUnavailable = false;
const judge = {
  storageStatus: () => ({ clickhouseReady: true }),
  committedEventCutoffMs: () => undefined,
  pendingStoredEvents: (start, end) => {
    pendingQueries += 1;
    return pending.at >= start && pending.at <= end ? [pending] : [];
  },
  queryRange: () => {
    throw new Error('the complete-boundary hot ring must not be used when no global cutoff exists');
  },
  agentWindowFacts: async () => {
    durableQueries += 1;
    return durableUnavailable ? null : [fact(durable)];
  },
  listIncidents: () => [],
  committedEventProgress: () => [],
};
const relationalStub = {
  initialize: async () => false,
  configured: () => false,
  loadAgentMetadata: async () => [],
  saveAgentMetadata: async () => undefined,
};
const metadata = new AgentMetadataService(relationalStub);
const aggregation = new AggregationService(judge, metadata, {}, {});
const result = await aggregation.storedAgentInventory({
  timeType: 'custom',
  startTime: new Date(now - 3 * 60 * 60_000).toISOString(),
  endTime: new Date(now).toISOString(),
  scope: 'agent',
  limit: 100,
});

assert.equal(durableQueries, 1);
assert.equal(pendingQueries, 1);
assert.equal(result.items.length, 1);
assert.equal(result.items[0].eventCount, 2);
assert.equal(result.coverage.source, 'clickhouse+hot_delta');
assert.equal(result.coverage.partial, false);
assert.notEqual(result.coverage.partialReason, 'hot_ring_only');

durableUnavailable = true;
const lastGood = await aggregation.storedAgentInventory({
  timeType: 'custom',
  startTime: new Date(now - 3 * 60 * 60_000).toISOString(),
  endTime: new Date(now).toISOString(),
  scope: 'agent',
  limit: 100,
});
assert.equal(lastGood.items[0].eventCount, 2, 'a busy durable reader preserves the complete last-good result');
assert.equal(lastGood.coverage.source, 'clickhouse+hot_delta');
assert.equal(lastGood.coverage.partial, true);
assert.equal(lastGood.coverage.partialReason, 'storage_unavailable');

const store = new ClickHouseStore();
store.ready = true;
store.enqueue(pending);
assert.deepEqual(store.pendingEvents(now - 60_000, now).map((item) => item.eventId), ['pending-event']);
assert.equal(store.pendingEvents(0, now - 60_001).length, 0);

console.log('Agent inventory durable history + pending overlay verification passed');
