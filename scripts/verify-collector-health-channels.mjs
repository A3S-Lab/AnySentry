#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { stabilizeCollectorHealthChannel } = require('../apps/api/dist/security-monitoring/aggregation.service.js');

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

console.log('Collector capture/delivery/control health hysteresis verification passed');
