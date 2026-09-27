#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  collectorHeartbeatFailureDelta,
  computeAsyncBacklogConservation,
  derivePipelineAccountingDelta,
  isKnownPipelineStageReason,
  normalizePipelineAccounting,
  summarizePipelineAccounting,
} = require('../apps/api/dist/security-monitoring/pipeline-accounting.js');

function ring(overrides = {}) {
  return {
    ring: 'exec',
    ringSubmitted: 10,
    ringDropped: 1,
    collectorReceived: 9,
    logicalEvents: 8,
    queueAdmitted: 7,
    queueDropped: 1,
    ...overrides,
  };
}

function s4Ring(overrides = {}) {
  return ring({ collectorEnqueued: 8, collectorDropped: 1, ...overrides });
}

function observer(sequence, overrides = {}) {
  return {
    schemaVersion: 'anysentry.pipeline_accounting.v1',
    producer: 'observer',
    producerInstanceId: 'observer:boot-a:123',
    sequence,
    window: { startedAtUnixMs: 1_700_000_000_000 + sequence * 1_000, endedAtUnixMs: 1_700_000_001_000 + sequence * 1_000 },
    temporality: 'delta',
    unit: { ring: 'physical_record', queue: 'logical_event' },
    rings: [ring()],
    ...overrides,
  };
}

function forwarder(sequence, overrides = {}) {
  return {
    schemaVersion: 'anysentry.pipeline_accounting.v1',
    producer: 'forwarder',
    producerInstanceId: 'forwarder:boot-a:456',
    sequence,
    window: { startedAtUnixMs: 1_700_000_010_000 + sequence * 1_000, endedAtUnixMs: 1_700_000_011_000 + sequence * 1_000 },
    temporality: 'delta',
    unit: { input: 'logical_event', queue: 'logical_event' },
    stages: [
      { stage: 'received', count: 8, reasons: [{ reason: 'input', count: 8 }] },
      { stage: 'queue_admitted', count: 7, reasons: [{ reason: 'event', count: 7 }] },
      { stage: 'queue_dropped', count: 1, reasons: [{ reason: 'queue_rejected', count: 1 }] },
    ],
    backlog: {
      queueEvents: 2,
      queueBytes: 200,
      inflightEvents: 1,
      inflightBytes: 100,
      retryEvents: 1,
      retryBytes: 80,
      outstandingEvents: 4,
      outstandingBytes: 380,
    },
    ...overrides,
  };
}

// Reader accepts the final millisecond contract and the bounded legacy nanosecond draft, while
// dropping unknown object fields rather than copying arbitrary high-cardinality data.
const legacyWindow = normalizePipelineAccounting(observer(1, {
  window: {
    startedAtUnixNs: '1700000001000000000',
    endedAtUnixNs: '1700000002000000000',
  },
  futureExtension: { path: '/must/not/be/persisted' },
}));
assert.deepEqual(legacyWindow.window, {
  startedAtUnixMs: 1_700_000_001_000,
  endedAtUnixMs: 1_700_000_002_000,
});
assert.equal('futureExtension' in legacyWindow, false);
assert.equal(normalizePipelineAccounting(undefined), undefined, 'legacy heartbeats remain valid without accounting');
assert.equal(
  normalizePipelineAccounting(observer(1, { rings: Array.from({ length: 33 }, (_, index) => ring({ ring: `ring-${index}` })) })),
  undefined,
  'oversized arrays must fail closed rather than look complete after truncation',
);
assert.equal(
  normalizePipelineAccounting(observer(1, { rings: [ring({ ringSubmitted: Number.MAX_SAFE_INTEGER + 1 })] })),
  undefined,
  'unsafe counters must not enter conservation arithmetic',
);
assert.equal(
  normalizePipelineAccounting(observer(1, { rings: [ring({ collectorEnqueued: 8 })] })),
  undefined,
  'S4 handoff counters are an all-or-nothing pair',
);
assert.deepEqual(
  normalizePipelineAccounting(observer(1, { rings: [s4Ring()] })).rings[0],
  s4Ring(),
  'S4 raw handoff counters survive the compatibility reader',
);

const normalizedForwarder = normalizePipelineAccounting(forwarder(1, {
  unknownExtension: true,
  stages: [
    { stage: 'received', count: 2, reasons: [{ reason: 'input', count: 2 }] },
    { stage: 'future_bounded_stage', count: 1, reasons: [{ reason: 'future_reason', count: 1 }] },
  ],
}));
assert.equal(normalizedForwarder.backlog.outstandingEvents, 4);
assert.equal(normalizedForwarder.stages.length, 2);
assert.equal(isKnownPipelineStageReason('received', 'input'), true);
assert.equal(isKnownPipelineStageReason('queue_dropped', 'protected_reserve'), true);
assert.equal(isKnownPipelineStageReason('queue_dropped', 'wal_pending_capacity'), true);
assert.equal(isKnownPipelineStageReason('future_bounded_stage', 'future_reason'), false);
const unknownExtensionHealth = summarizePipelineAccounting([{
  at: 1_700_000_011_000,
  pipelineAccounting: normalizedForwarder,
}]);
assert.equal(
  JSON.stringify(unknownExtensionHealth).includes('future_bounded_stage'),
  false,
  'unknown bounded extensions remain readable in the record but never become health labels',
);

// Delta producers are counted at most once. Restarts have a new producer ID; gaps remain usable
// but are explicitly incomplete instead of silently disappearing.
const first = normalizePipelineAccounting(observer(1));
const firstResult = derivePipelineAccountingDelta(undefined, first);
assert.equal(firstResult.accepted, true);
assert.equal(firstResult.continuity, 'initial');
assert.equal(derivePipelineAccountingDelta(first, first).continuity, 'duplicate');
const gap = normalizePipelineAccounting(observer(3));
const gapResult = derivePipelineAccountingDelta(first, gap);
assert.equal(gapResult.accepted, true);
assert.equal(gapResult.complete, false);
assert.equal(gapResult.continuity, 'sequence_gap');
const restarted = normalizePipelineAccounting(observer(1, { producerInstanceId: 'observer:boot-b:999' }));
assert.equal(derivePipelineAccountingDelta(first, restarted).continuity, 'restart');

// Cumulative compatibility uses the producer/sequence baseline and never interprets a reset as a
// huge delta.
const cumulativeOne = normalizePipelineAccounting(observer(1, {
  temporality: 'cumulative',
  rings: [ring({ ringSubmitted: 100, ringDropped: 4, collectorReceived: 98, logicalEvents: 80, queueAdmitted: 78, queueDropped: 2 })],
}));
const cumulativeTwo = normalizePipelineAccounting(observer(2, {
  temporality: 'cumulative',
  rings: [ring({ ringSubmitted: 112, ringDropped: 5, collectorReceived: 109, logicalEvents: 90, queueAdmitted: 87, queueDropped: 3 })],
}));
assert.equal(derivePipelineAccountingDelta(undefined, cumulativeOne).accepted, false, 'first cumulative sample is a baseline');
const cumulativeDelta = derivePipelineAccountingDelta(cumulativeOne, cumulativeTwo);
assert.equal(cumulativeDelta.accepted, true);
assert.equal(cumulativeDelta.delta.rings[0].ringSubmitted, 12);
assert.equal(cumulativeDelta.delta.rings[0].ringDropped, 1);
const cumulativeReset = normalizePipelineAccounting(observer(3, {
  temporality: 'cumulative',
  rings: [ring({ ringSubmitted: 2, ringDropped: 0, collectorReceived: 2, logicalEvents: 2, queueAdmitted: 2, queueDropped: 0 })],
}));
assert.equal(derivePipelineAccountingDelta(cumulativeTwo, cumulativeReset).continuity, 'counter_reset');

const health = summarizePipelineAccounting([
  { at: 1_700_000_001_000, pipelineAccounting: first },
  { at: 1_700_000_001_100, pipelineAccounting: first },
  { at: 1_700_000_003_000, pipelineAccounting: gap },
  { at: 1_700_000_004_000, pipelineAccounting: restarted },
  { at: 1_700_000_012_000, pipelineAccounting: normalizePipelineAccounting(forwarder(1)) },
]);
assert.equal(health.window.heartbeatCount, 5);
assert.equal(health.window.acceptedWindowCount, 4);
assert.equal(health.window.producerCount, 3);
assert.equal(health.window.restartCount, 1);
assert.equal(health.window.sequenceGapCount, 1);
assert.equal(health.window.duplicateCount, 1);
assert.equal(health.window.logicalResidual, 0);
assert.equal(health.window.stageCountResidual, 0);
assert.equal(health.window.exact, false, 'a detected gap must remain visible even when equations balance');
assert.equal(health.latest.continuity, 'initial', 'the Observer and Forwarder are separate producer lanes, not restarts');
assert.equal(health.latest.backlog.outstandingEvents, 4, 'backlog is the latest gauge, never a summed delta');

const s4Health = summarizePipelineAccounting([{
  at: 1_700_000_020_000,
  pipelineAccounting: normalizePipelineAccounting(observer(1, {
    producerInstanceId: 'observer:s4:1',
    rings: [s4Ring()],
  })),
}]);
assert.equal(s4Health.window.collectorEnqueued, 8);
assert.equal(s4Health.window.collectorDropped, 1);
assert.equal(s4Health.window.collectorHandoffResidual, 0);
assert.equal(s4Health.window.exact, true);
const brokenS4Health = summarizePipelineAccounting([{
  at: 1_700_000_021_000,
  pipelineAccounting: normalizePipelineAccounting(observer(1, {
    producerInstanceId: 'observer:s4:broken',
    rings: [s4Ring({ collectorDropped: 0 })],
  })),
}]);
assert.equal(brokenS4Health.window.collectorHandoffResidual, 1);
assert.equal(brokenS4Health.window.exact, false);
const rollingUpgradeHealth = summarizePipelineAccounting([
  {
    at: 1_700_000_021_500,
    pipelineAccounting: normalizePipelineAccounting(observer(1, {
      producerInstanceId: 'observer:legacy',
    })),
  },
  {
    at: 1_700_000_022_000,
    pipelineAccounting: normalizePipelineAccounting(observer(1, {
      producerInstanceId: 'observer:s4:2',
      rings: [s4Ring()],
    })),
  },
]);
assert.equal(rollingUpgradeHealth.window.collectorReceived, 18);
assert.equal(rollingUpgradeHealth.window.collectorHandoffResidual, 0);
assert.equal(
  rollingUpgradeHealth.window.exact,
  true,
  'legacy windows remain compatible while S4 handoff conservation covers only reporting rings',
);

assert.deepEqual(
  computeAsyncBacklogConservation({ opening: 3, admitted: 5, completed: 4, dropped: 1, closing: 3 }),
  { expectedClosing: 3, residual: 0, conserved: true },
);
assert.equal(
  computeAsyncBacklogConservation({ opening: 3, admitted: 5, completed: 4, dropped: 1, closing: 4 }).conserved,
  false,
);

// Two adjacent Forwarder intervals that each report one drop must each alert with delta=1. Raw
// collector counters retain cumulative/reset behavior. Explicit temporality wins during rollout.
const forwarderPrevious = { origin: 'forwarder', droppedEvents: 0, outputDropped: 1, errorCount: 1 };
const forwarderCurrent = { origin: 'forwarder', droppedEvents: 0, outputDropped: 1, errorCount: 1 };
assert.deepEqual(collectorHeartbeatFailureDelta(forwarderCurrent, forwarderPrevious), {
  droppedDelta: 1,
  errorDelta: 1,
});
assert.deepEqual(collectorHeartbeatFailureDelta(
  { origin: 'raw_collector', droppedEvents: 7, outputDropped: 4, errorCount: 0 },
  { droppedEvents: 5, outputDropped: 3, errorCount: 0 },
), { droppedDelta: 3, errorDelta: 0 });
assert.deepEqual(collectorHeartbeatFailureDelta(
  { origin: 'raw_collector', droppedEvents: 1, outputDropped: 0, errorCount: 0 },
  { droppedEvents: 7, outputDropped: 4, errorCount: 0 },
), { droppedDelta: 1, errorDelta: 0 });
assert.deepEqual(collectorHeartbeatFailureDelta(
  { origin: 'forwarder', legacyCounterTemporality: 'cumulative', droppedEvents: 0, outputDropped: 11, errorCount: 4 },
  { droppedEvents: 0, outputDropped: 9, errorCount: 3 },
), { droppedDelta: 2, errorDelta: 1 });

console.log('Pipeline accounting verification passed');
