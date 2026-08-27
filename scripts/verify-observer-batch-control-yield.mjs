#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const controller = readFileSync(new URL('../apps/api/src/security-monitoring/security-monitoring.controller.ts', import.meta.url), 'utf8');
const metrics = readFileSync(new URL('../apps/api/src/security-monitoring/platform-metrics.service.ts', import.meta.url), 'utf8');

assert.match(controller, /OBSERVER_BATCH_CONTROL_YIELD_EVERY\s*=\s*32/u);
assert.equal(
  [...controller.matchAll(/await yieldObserverBatchControl\(index\)/gu)].length,
  2,
  'both prepare and post-commit batch loops must yield to control requests',
);
assert.match(metrics, /anysentry_event_loop_lag_p99_seconds/u);
assert.match(metrics, /anysentry_event_loop_lag_max_seconds/u);

console.log('Observer batch control-plane scheduling contract verification passed');
