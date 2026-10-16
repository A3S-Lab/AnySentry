#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  deliveryEvaluation,
  evaluateCollectorCaptureHeartbeat,
  stabilizeCollectorHealthChannel,
} = require('../apps/api/dist/security-monitoring/aggregation.service.js');

const evaluation = (severity, reasons = []) => ({ severity, reasons });

assert.equal(stabilizeCollectorHealthChannel([], 'recovering').state, 'unknown');

const oneTransient = stabilizeCollectorHealthChannel([
  evaluation(1, ['control_runtime_snapshot_failed']),
  evaluation(0),
], 'recovering');
assert.equal(oneTransient.state, 'warning');
assert.equal(oneTransient.consecutiveBad, 1);

const persistent = stabilizeCollectorHealthChannel([
  evaluation(1, ['control_runtime_snapshot_failed']),
  evaluation(1, ['control_runtime_snapshot_failed']),
  evaluation(0),
], 'recovering');
assert.equal(persistent.state, 'degraded');
assert.equal(persistent.consecutiveBad, 2);

const hardFailure = stabilizeCollectorHealthChannel([
  evaluation(2, ['spool_backlog_over_slo']),
  evaluation(0),
], 'recovering');
assert.equal(hardFailure.state, 'degraded');

const oneClean = stabilizeCollectorHealthChannel([
  evaluation(0),
  evaluation(1, ['control_runtime_snapshot_failed']),
], 'recovering');
assert.equal(oneClean.state, 'warning');
assert.deepEqual(oneClean.reasons, ['recovering']);

const twoClean = stabilizeCollectorHealthChannel([
  evaluation(0),
  evaluation(0),
  evaluation(1, ['control_runtime_snapshot_failed']),
], 'recovering');
assert.equal(twoClean.state, 'healthy');
assert.equal(twoClean.consecutiveClean, 2);

const rawHeartbeat = (droppedEvents, ringOverrides = {}) => ({
  origin: 'raw_collector',
  status: 'ok',
  droppedEvents,
  outputDropped: 0,
  errorCount: 0,
  pipelineAccounting: {
    rings: [{ ringDropped: 0, collectorDropped: 0, queueDropped: 0, ...ringOverrides }],
  },
});

// Raw Collector compatibility counters are cumulative. An unchanged historical count is a clean
// current window; only a new delta or typed ring loss may degrade capture health.
const historicalLoss = rawHeartbeat(10_766);
const unchangedHistoricalLoss = evaluateCollectorCaptureHeartbeat(
  historicalLoss,
  rawHeartbeat(10_766),
);
assert.equal(unchangedHistoricalLoss.severity, 0);
assert.deepEqual(unchangedHistoricalLoss.reasons, []);

const newLegacyLoss = evaluateCollectorCaptureHeartbeat(
  rawHeartbeat(10_767),
  historicalLoss,
);
assert.equal(newLegacyLoss.severity, 2);
assert.deepEqual(newLegacyLoss.reasons, ['capture_pipeline_loss']);

const typedRingLoss = evaluateCollectorCaptureHeartbeat(
  rawHeartbeat(10_766, { collectorDropped: 1 }),
  historicalLoss,
);
assert.equal(typedRingLoss.severity, 2);
assert.deepEqual(typedRingLoss.reasons, ['capture_pipeline_loss']);

console.log('Collector capture/delivery/control health hysteresis verification passed');

// Window-scoped ring accounting: historical cumulative ring overflow with no new delta must
// not keep the capture channel degraded (aggregation.service.ts:265 comment now enforced).
const ringHistoricalOverflow = evaluateCollectorCaptureHeartbeat(
  rawHeartbeat(10_766, { ringDropped: 42 }),
  rawHeartbeat(10_766, { ringDropped: 42 }),
);
assert.equal(ringHistoricalOverflow.severity, 0);
assert.deepEqual(ringHistoricalOverflow.reasons, []);

const ringNewOverflow = evaluateCollectorCaptureHeartbeat(
  rawHeartbeat(10_766, { ringDropped: 43 }),
  rawHeartbeat(10_766, { ringDropped: 42 }),
);
assert.equal(ringNewOverflow.severity, 2);
assert.deepEqual(ringNewOverflow.reasons, ['capture_pipeline_loss']);

// Delivery channel: collector outputDropped is process-lifetime cumulative (temporality
// marker), so an unchanged total must not report permanent output loss; a fresh increment must.
const cumulativeDelivery = (outputDropped) => ({
  origin: 'raw_collector',
  status: 'ok',
  droppedEvents: 0,
  outputDropped,
  errorCount: 0,
  legacyCounterTemporality: 'cumulative',
});
const unchangedDeliveryLoss = deliveryEvaluation(
  cumulativeDelivery(915),
  cumulativeDelivery(915),
);
assert.equal(unchangedDeliveryLoss.severity, 0);
assert.deepEqual(unchangedDeliveryLoss.reasons, []);

const newDeliveryLoss = deliveryEvaluation(
  cumulativeDelivery(916),
  cumulativeDelivery(915),
);
assert.equal(newDeliveryLoss.severity, 2);
assert.deepEqual(newDeliveryLoss.reasons, ['permanent_output_loss']);

// A delta-source forwarder keeps its existing semantics: the value is already per-window.
const forwarderDelivery = deliveryEvaluation({
  origin: 'forwarder',
  status: 'ok',
  droppedEvents: 0,
  outputDropped: 3,
  errorCount: 0,
  legacyCounterTemporality: 'delta',
});
assert.equal(forwarderDelivery.severity, 2);
assert.deepEqual(forwarderDelivery.reasons, ['permanent_output_loss']);

console.log('Collector ring/delivery window-delta verification passed');
