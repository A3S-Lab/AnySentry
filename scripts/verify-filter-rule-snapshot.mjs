#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  FILTER_RULE_SNAPSHOT_SCHEMA,
  FilterRulePublisher,
  filterDecision,
} = require('./observer-filter-rules.js');

function event(cgroupId = '42') {
  return { process: { cgroupId, pid: 100 }, event: { FileAccess: { pid: 100, path: '/tmp/a', write: true } } };
}

const confirmed = filterDecision(event(), {
  state: 'agent',
  attribution: { classification: 'confirmed_agent', source: 'kubernetes', physicalWorkloadId: 'k8s:test' },
});
assert.equal(confirmed.action, 'keep');
assert.equal(confirmed.authority, 'authoritative');

const explicitNonAgent = filterDecision(event(), {
  state: 'non_agent',
  attribution: { classification: 'non_agent', source: 'manual_review' },
});
assert.equal(explicitNonAgent.action, 'drop');

const processNegative = filterDecision(event(), {
  state: 'non_agent',
  attribution: { classification: 'non_agent', source: 'process_graph' },
});
assert.equal(processNegative.action, 'sample');
assert.equal(filterDecision(event('invalid'), { state: 'unknown' }), undefined);

const shadowPublisher = new FilterRulePublisher({
  file: '/unused',
  enforceDrops: false,
  fs: { mkdirSync() {}, writeFileSync() {}, renameSync() {} },
});
const shadowDrop = shadowPublisher.observe(event(), {
  state: 'non_agent',
  attribution: { classification: 'non_agent', source: 'kubernetes' },
});
assert.equal(shadowDrop.action, 'sample', 'shadow mode must not publish an irreversible early drop');
shadowPublisher.close();

const stableSamplePublisher = new FilterRulePublisher({
  file: '/unused',
  fs: { mkdirSync() {}, writeFileSync() {}, renameSync() {} },
});
stableSamplePublisher.observe(event('84'), {
  state: 'unknown',
  attribution: { classification: 'unknown', source: 'none' },
});
const stableSampleVersion = stableSamplePublisher.metrics().version;
stableSamplePublisher.observe(event('84'), {
  state: 'non_agent',
  attribution: { classification: 'non_agent', source: 'process_graph' },
});
assert.equal(
  stableSamplePublisher.metrics().version,
  stableSampleVersion,
  'audit metadata changes must not reload a cgroup map when action and authority are unchanged',
);
stableSamplePublisher.close();

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'anysentry-filter-rules-'));
const file = path.join(directory, 'snapshot.json');
let now = Date.parse('2026-08-17T00:00:00Z');
const publisher = new FilterRulePublisher({ file, now: () => now, flushIntervalMs: 10, ttlMs: 1_000 });
publisher.observe(event(), { state: 'non_agent', attribution: { classification: 'non_agent', source: 'kubernetes' } });
const conflictDecision = publisher.observe(event(), { state: 'agent', attribution: { classification: 'probable_agent', source: 'process_graph' } });
assert.equal(conflictDecision.reasonCode, 'conflict_keep_preferred');
publisher.observe(event(), { state: 'agent', attribution: { classification: 'probable_agent', source: 'process_graph' } });
const stableVersion = publisher.metrics().version;
publisher.observe(event(), { state: 'agent', attribution: { classification: 'probable_agent', source: 'process_graph' } });
assert.equal(publisher.metrics().version, stableVersion, 'stable hot-path decisions must not rewrite the snapshot');
publisher.flush();
const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
assert.equal(snapshot.schemaVersion, FILTER_RULE_SNAPSHOT_SCHEMA);
assert.equal(snapshot.entries.length, 1);
assert.equal(snapshot.entries[0].action, 'keep', 'Agent keep must win a conflicting non-Agent drop');
assert.equal(snapshot.entries[0].reasonCode, 'conflict_keep_preferred');
assert.equal(snapshot.entries[0].epoch, snapshot.version);

const restoredPublisher = new FilterRulePublisher({ file, now: () => now, flushIntervalMs: 10, ttlMs: 1_000 });
assert.equal(restoredPublisher.metrics().version, snapshot.version, 'restart must preserve the monotonic epoch');
assert.equal(restoredPublisher.metrics().restored, 1, 'unexpired cgroup decisions should survive Forwarder restart');
restoredPublisher.observe(event('43'), { state: 'unknown', attribution: { classification: 'unknown', source: 'none' } });
assert.ok(restoredPublisher.metrics().version > snapshot.version, 'the next epoch must advance after restart');
restoredPublisher.close();

now += 1_001;
assert.equal(publisher.snapshot().entries.length, 0, 'expired rules must not remain active');
publisher.close();

console.log('Filter rule snapshot verification passed');
