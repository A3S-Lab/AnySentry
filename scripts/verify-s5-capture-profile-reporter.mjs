#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  CAPTURE_PROFILE_ACK_SCHEMA,
  CAPTURE_PROFILE_CAPABILITIES,
  FilterRulePublisher,
  digest,
} = require('./observer-filter-rules.js');
const { CaptureProfileReporter } = require('./observer-capture-profile-reporter.js');
const forwarderSource = fs.readFileSync(new URL('./observer-forward.js', import.meta.url), 'utf8');
assert(forwarderSource.includes('CAPTURE_PROFILE_REPORT_RESPONSE_MAX_BYTES'));
assert(/CAPTURE_PROFILE_REPORT_RESPONSE_MAX_BYTES,[\s\S]{0,240}?false,/u.test(forwarderSource),
  'Capture Profile materialization uses the bounded snapshot-scale response limit');

const now = Date.parse('2026-08-20T08:00:00.000Z');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'anysentry-s5-reporter-'));
const snapshotFile = path.join(directory, 'capture-profile.json');
const ackFile = path.join(directory, 'capture-profile.ack.json');
const publisher = new FilterRulePublisher({
  file: snapshotFile,
  ackFile,
  captureProfileMode: 'enforce',
  publisherInstanceId: 'publisher-forwarder-e2e',
  nodeId: 'node-a',
  collectorId: 'collector-a',
  hostBootId: 'boot-a',
  now: () => now,
  flushIntervalMs: 5_000,
});
publisher.synchronizePolicyDecisions([{
  scopeType: 'cgroup', scopeKey: 'cgroup:42', cgroupId: '42',
  classification: 'non_agent', authority: 'authoritative', action: 'drop',
  reasonCode: 'platform_infrastructure', source: 'platform_inventory',
  physicalWorkloadId: 'docker:node-a:clickhouse',
  ruleId: 'rule-clickhouse', ruleRevision: 3, policyVersion: 7,
  captureProfile: 'infrastructure_aggregate',
  desiredProbeActions: {
    exec: 'full', exit: 'full', tls: 'aggregate', connect: 'aggregate', dns: 'aggregate',
    file_access: 'drop', file_delete: 'sample', llm: 'aggregate', ssl: 'aggregate', security: 'full',
  },
  expiresAt: '2026-08-20T08:02:00.000Z',
}], 7);
publisher.flush();
const preview = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
const ack = {
  schemaVersion: CAPTURE_PROFILE_ACK_SCHEMA,
  status: 'applied', errors: [], downgrades: [],
  nodeId: 'node-a', collectorId: 'collector-a', collectorInstanceId: 'collector-instance-a',
  hostBootId: 'boot-a', publisherInstanceId: preview.publisherInstanceId,
  epoch: preview.epoch, policyVersion: preview.policyVersion,
  contentHash: preview.contentHash, intentHash: preview.intentHash,
  entriesApplied: preview.expectedEntries, appliedAt: new Date(now).toISOString(),
  capabilities: structuredClone(CAPTURE_PROFILE_CAPABILITIES),
  capabilitiesHash: digest(CAPTURE_PROFILE_CAPABILITIES),
  effectiveActionsHash: preview.effectiveActionsHash,
};
fs.writeFileSync(ackFile, `${JSON.stringify(ack)}\n`, { mode: 0o600 });

const reports = [];
const reporter = new CaptureProfileReporter({
  publisher,
  now: () => now,
  postReport(request, done) {
    reports.push(request);
    done(undefined, {
      ...request,
      accepted: true,
      reportId: 'central-report-a',
      filterRuleEntries: [{
        scopeKey: 'cgroup:42', cgroupId: '42',
        ruleId: 'rule-clickhouse', ruleRevision: 3,
        physicalWorkloadId: 'docker:node-a:clickhouse', action: 'drop',
      }],
    });
  },
});

assert.equal(reporter.poll().accepted, true);
assert.equal(reports.length, 1);
assert.match(reports[0].reportId, /^matr_[a-f0-9]{24}$/u);
assert.equal(
  publisher.materializationReport(ack)?.reportId,
  undefined,
  'an activated grant has no pending report to replay',
);
const active = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
assert.equal(active.activation.mode, 'enforce');
assert.equal(active.entries[0].action, 'sample', 'legacy v1 action remains safe after central acceptance');
assert.equal(active.entries[0].probeActions.file_access, 'drop');
assert.equal(active.activationGrant.collectorInstanceId, 'collector-instance-a');
assert.equal(active.activationGrant.previewContentHash, preview.contentHash);
assert.ok(active.epoch > preview.epoch);

reporter.poll();
assert.equal(reports.length, 1, 'the same ACK cannot re-report after the grant epoch is active');
assert.deepEqual(reporter.metrics(), {
  enabled: true,
  inFlight: false,
  retryAt: undefined,
  consecutiveFailures: 0,
  polls: 2,
  ackAccepted: 1,
  ackRejected: 0,
  reports: 1,
  reportErrors: 0,
  centralAccepted: 1,
  centralRejected: 0,
});

publisher.close();
reporter.close();
console.log('S5 Capture Profile Forwarder reporter mock E2E passed');
