import assert from 'node:assert/strict';

import { ClickHouseStore } from '../apps/api/dist/security-monitoring/clickhouse-store.js';

const state = {
  schemaVersion: 'anysentry.unknown_learning_state.v1',
  exportedAt: Date.now(),
  enabled: false,
  watermarkMs: 0,
  totals: { observedUnknownEvents: 0, clusteredEvents: 0, duplicateEvents: 0, rejectedEvents: 0, overflowEvents: 0 },
  clusters: [], reviews: [], policies: [], dedupe: [],
};
let stored;
const storedVersions = [];
const fake = {
  async insert(options) {
    assert.equal(options.format, 'JSONEachRow');
    assert.equal(options.values[0].key, 'unknown_learning_state_v1');
    stored = options.values[0].value;
    storedVersions.push(options.values[0].updated_at);
  },
  async query(options) {
    assert.match(options.query, /key = 'unknown_learning_state_v1'/u);
    return { json: async () => stored ? [{ value: stored }] : [] };
  },
};
const store = new ClickHouseStore();
store.client = fake;
store.ready = true;
assert.equal(await store.saveUnknownLearningState(state), true);
assert.equal(await store.saveUnknownLearningState({ ...state, exportedAt: state.exportedAt + 1 }), true);
assert(storedVersions[1] > storedVersions[0], 'rapid state replacements use strictly monotonic ClickHouse versions');
assert.deepEqual(await store.loadUnknownLearningState(), { ...state, exportedAt: state.exportedAt + 1 });

const unavailable = new ClickHouseStore();
assert.equal(await unavailable.saveUnknownLearningState(state), false);
assert.equal(await unavailable.loadUnknownLearningState(), undefined);

const oversized = { ...state, padding: 'x'.repeat(16 * 1024 * 1024) };
assert.equal(await store.saveUnknownLearningState(oversized), false, 'storage guard rejects an oversized state row');
assert.deepEqual(
  await store.loadUnknownLearningState(),
  { ...state, exportedAt: state.exportedAt + 1 },
  'oversized rejection does not replace last good state',
);

console.log('S8 Unknown learning ClickHouse state verification passed');
