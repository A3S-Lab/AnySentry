#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const matrixPath = path.join(repoRoot, 'fixtures/s0-compatibility/consumer-matrix.v1.json');
const goldenPath = path.join(repoRoot, 'fixtures/s0-compatibility/golden-events.v1.json');

function json(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function deepMerge(base, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const output = { ...(base ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    output[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? deepMerge(output[key], value)
      : value;
  }
  return output;
}

function valueAt(value, dottedPath) {
  return dottedPath.split('.').reduce((current, key) => current?.[key], value);
}

const matrix = json(matrixPath);
assert.equal(matrix.schemaVersion, 'anysentry.s0_consumer_matrix.v1');
assert.equal(matrix.futureAdditiveFields.status, 'planned_not_implemented_in_s0');

const requiredConsumers = [
  'observer',
  'forwarder',
  'api',
  'clickhouse',
  'kafka',
  'flink',
  'web',
  'alert',
  'incident',
  'evidence',
  'remediation',
];
assert.deepEqual(
  matrix.consumers.map((consumer) => consumer.id).sort(),
  [...requiredConsumers].sort(),
  'consumer matrix must cover the complete S0 list',
);
for (const consumer of matrix.consumers) {
  assert.ok(consumer.reads.length, `${consumer.id} must declare reads`);
  assert.ok(consumer.writes.length, `${consumer.id} must declare writes`);
  assert.ok(consumer.compatibilityPromise, `${consumer.id} must declare its compatibility promise`);
  assert.ok(consumer.switchingGate, `${consumer.id} must declare its switching gate`);
  for (const sourcePath of consumer.sourcePaths) {
    assert.ok(fs.existsSync(path.resolve(repoRoot, sourcePath)), `${consumer.id} source path is missing: ${sourcePath}`);
  }
}

let canonicalizeEvent;
try {
  ({ canonicalizeEvent } = await import('../apps/api/dist/security-monitoring/streaming-normalizer.js'));
} catch (error) {
  throw new Error('API build output is required; run `pnpm build:api` before this verifier.', { cause: error });
}

const golden = json(goldenPath);
assert.equal(golden.schemaVersion, 'anysentry.s0_golden_events.v1');
assert.deepEqual(
  [...new Set(golden.cases.map((fixtureCase) => fixtureCase.environment))].sort(),
  ['docker', 'host', 'kubernetes'],
  'golden replay must cover Host, Docker and Kubernetes',
);

const requiredTags = [
  'pid_reuse',
  'same_container_two_agents',
  'incoming_trace',
  'legacy_synthetic_trace',
  'unknown',
  'replay',
];
const tags = new Set(golden.cases.flatMap((fixtureCase) => fixtureCase.tags));
for (const tag of requiredTags) assert.ok(tags.has(tag), `golden replay is missing ${tag}`);

const actualByCase = {};
for (const fixtureCase of golden.cases) {
  const event = deepMerge(golden.baseEvent, fixtureCase.eventPatch);
  const actual = canonicalizeEvent(event, JSON.stringify(fixtureCase.observerLine), fixtureCase.receivedAt);
  actualByCase[fixtureCase.id] = actual;

  assert.equal(actual.sourceEventId, event.sourceEventId, `${fixtureCase.id} sourceEventId changed`);
  assert.equal(actual.sourceRecordId, event.eventId, `${fixtureCase.id} source record changed`);
  assert.equal(actual.traceId, event.traceId, `${fixtureCase.id} traceId changed`);
  assert.equal(actual.spanId, event.spanId, `${fixtureCase.id} spanId changed`);
  assert.equal(actual.receivedAt, fixtureCase.receivedAt, `${fixtureCase.id} receive time changed`);

  const expected = golden.expectedByCase[fixtureCase.id];
  assert.ok(expected, `${fixtureCase.id} has no expected snapshot`);
  for (const [field, value] of Object.entries(expected)) {
    assert.equal(valueAt(actual, field), value, `${fixtureCase.id} changed ${field}`);
  }
}
assert.equal(
  Object.keys(golden.expectedByCase).length,
  golden.cases.length,
  'every expected snapshot must correspond to one input case',
);

for (const relation of golden.relations) {
  const leftSeparator = relation.left.indexOf('.');
  const rightSeparator = relation.right.indexOf('.');
  const leftCase = relation.left.slice(0, leftSeparator);
  const rightCase = relation.right.slice(0, rightSeparator);
  const left = valueAt(actualByCase[leftCase], relation.left.slice(leftSeparator + 1));
  const right = valueAt(actualByCase[rightCase], relation.right.slice(rightSeparator + 1));
  if (relation.operator === 'equal') assert.equal(left, right, relation.name);
  else if (relation.operator === 'notEqual') assert.notEqual(left, right, relation.name);
  else assert.fail(`unsupported relation operator: ${relation.operator}`);
}

console.log(`S0 compatibility fixtures passed: ${matrix.consumers.length} consumers, ${golden.cases.length} golden events`);
