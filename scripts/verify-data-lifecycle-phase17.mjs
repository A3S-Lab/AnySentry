import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const {
  reusableFactSlices,
} = require('../apps/api/dist/security-monitoring/aggregation.service.js');
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

// Millisecond-precision snapshots keep their exact head and tail while only complete buckets
// become reusable across refreshes.
assert.deepEqual(
  reusableFactSlices(1_001, 29_999, 25_000, 10_000),
  {
    fullStartMs: 10_000,
    fullEndExclusiveMs: 20_000,
    head: { startMs: 1_001, endMs: 9_999 },
    tail: { startMs: 20_000, endMs: 29_999 },
  },
);

// Fully aligned closed ranges do not need exact boundary queries.
assert.deepEqual(
  reusableFactSlices(10_000, 29_999, 30_000, 10_000),
  {
    fullStartMs: 10_000,
    fullEndExclusiveMs: 30_000,
    head: undefined,
    tail: undefined,
  },
);

// A range shorter than one full bucket remains exact and never pollutes the reusable cache.
assert.deepEqual(
  reusableFactSlices(1_001, 5_000, 5_001, 10_000),
  {
    fullStartMs: 10_000,
    fullEndExclusiveMs: 10_000,
    head: { startMs: 1_001, endMs: 5_000 },
    tail: undefined,
  },
);

const aggregation = await read(
  'apps/api/src/security-monitoring/aggregation.service.ts',
);
assert.match(aggregation, /new BoundedHistoryQueryGate\(4\)/);
assert.equal(
  [...aggregation.matchAll(/const slices = reusableFactSlices\(/g)].length,
  3,
);
assert.match(
  aggregation,
  /this\.historyQueryGate\.run\(\(\) =>\s*this\.judge\.agentWindowFacts/,
);
assert.match(
  aggregation,
  /this\.historyQueryGate\.run\(\(\) =>\s*this\.judge\.workspaceWindowFacts/,
);
assert.match(
  aggregation,
  /this\.historyQueryGate\.run\(\(\) =>\s*this\.judge\.topologyWindowFacts/,
);

console.log('Data lifecycle Phase 17 verification passed');
