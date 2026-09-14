#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { RelationalBusinessStore } = require('../apps/api/dist/security-monitoring/relational-business-store.service.js');
const store = Object.create(RelationalBusinessStore.prototype);
store.rawBatchQueue = [];
store.rawBatchTimer = undefined;
store.rawBatchFlushInFlight = undefined;
store.rawBatchMaxRows = 8;
store.rawBatchMaxBytes = 1024 * 1024;
store.rawBatchWindowMs = 5;
const calls = [];
store.saveRawObservationsNow = async (rows) => { calls.push(rows.length); return true; };
const row = (id) => ({ observationId: id, revision: 1 });
const keepAlive = new Promise((resolve) => setTimeout(resolve, 30));
const result = await Promise.all([
  store.saveRawObservations([row('a')]),
  store.saveRawObservations([row('b')]),
  store.saveRawObservations([row('c')]),
  keepAlive,
]);
const resultValues = result.slice(0, 3);
assert.deepEqual(resultValues, [true, true, true]);
assert.deepEqual(calls, [3]);
console.log('PASS relational raw writes coalesce into one bounded transaction call');
