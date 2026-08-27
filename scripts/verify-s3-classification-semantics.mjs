#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  normalizeUnknownReasonCounts,
  parseClassificationSemantics,
  parseProcessLifecycleSource,
  parseUnknownReason,
  processContextWithoutLifecycle,
  visibleClassificationSemantics,
  visibleProcessContext,
  visibleUnknownReasonCounts,
} from '../apps/api/dist/security-monitoring/classification-semantics.js';
import { ClickHouseStore } from '../apps/api/dist/security-monitoring/clickhouse-store.js';
import { canonicalizeEvent } from '../apps/api/dist/security-monitoring/streaming-normalizer.js';

const previousMode = process.env.ANYSENTRY_UNKNOWN_RETENTION_MODE;

const valid = {
  schemaVersion: 'anysentry.classification_semantics.v1',
  identityClassification: 'unknown',
  workloadRole: 'unknown',
  captureProfile: 'unknown_discovery',
  unknownReason: 'snapshot_miss',
};

assert.deepEqual(parseClassificationSemantics(valid), valid);
assert.equal(parseClassificationSemantics({ ...valid, unknownReason: 'not_evaluated' }), undefined);
assert.deepEqual(
  parseClassificationSemantics({ ...valid, unknownReason: undefined }),
  {
    schemaVersion: valid.schemaVersion,
    identityClassification: valid.identityClassification,
    workloadRole: valid.workloadRole,
    captureProfile: valid.captureProfile,
  },
  'reason remains optional when no stronger fact is available',
);
assert.equal(parseUnknownReason('pid_reuse_ambiguous'), 'pid_reuse_ambiguous');
assert.equal(parseUnknownReason('pid:4242'), undefined);
assert.equal(parseProcessLifecycleSource('exec_tombstone'), 'exec_tombstone');
assert.equal(parseProcessLifecycleSource('producer_guess'), undefined);
assert.equal(parseClassificationSemantics({ ...valid, arbitrary: 'producer-data' }), undefined);
assert.equal(parseClassificationSemantics({
  ...valid,
  identityClassification: 'confirmed_agent',
}), undefined, 'Unknown reason is invalid on a non-Unknown identity');
assert.equal(parseClassificationSemantics({
  ...valid,
  identityClassification: 'confirmed_agent',
  workloadRole: 'agent',
  captureProfile: 'agent_full',
  unknownReason: null,
}), undefined, 'an explicitly present non-string reason is not a valid wire object');

const confirmed = {
  schemaVersion: 'anysentry.classification_semantics.v1',
  identityClassification: 'confirmed_agent',
  workloadRole: 'agent',
  captureProfile: 'agent_full',
};
assert.deepEqual(parseClassificationSemantics(confirmed), confirmed);
const probable = {
  schemaVersion: 'anysentry.classification_semantics.v1',
  identityClassification: 'probable_agent',
  workloadRole: 'agent',
  captureProfile: 'probable_investigation',
};
assert.deepEqual(parseClassificationSemantics(probable), probable);
assert.deepEqual(
  normalizeUnknownReasonCounts({ snapshot_miss: 3, signature_miss: 2.2, dynamic_pid_42: 99, policy_expired: -1 }),
  { snapshot_miss: 3, signature_miss: 2 },
  'heartbeat dimensions must remain on the closed Unknown-reason vocabulary',
);

process.env.ANYSENTRY_UNKNOWN_RETENTION_MODE = 'legacy';
assert.equal(visibleClassificationSemantics(valid), undefined);
assert.equal(visibleUnknownReasonCounts({ snapshot_miss: 3 }), undefined);
assert.equal(
  visibleProcessContext({ lifecycleSource: 'exec_tombstone', lifecycleReason: 'pid_reuse_ambiguous' }),
  undefined,
  'legacy rollback must not expose an empty process object after stripping S3-only fields',
);
assert.equal(
  processContextWithoutLifecycle({ lifecycleSource: 'exec_tombstone' }),
  undefined,
  'untrusted lifecycle-only input must not leave an empty process object',
);
process.env.ANYSENTRY_UNKNOWN_RETENTION_MODE = 'shadow';
assert.deepEqual(visibleClassificationSemantics(valid), valid);
assert.deepEqual(visibleUnknownReasonCounts({ snapshot_miss: 3 }), { snapshot_miss: 3 });
process.env.ANYSENTRY_UNKNOWN_RETENTION_MODE = 'enforce';
assert.deepEqual(visibleClassificationSemantics(valid), valid);
assert.deepEqual(visibleUnknownReasonCounts({ snapshot_miss: 3 }), { snapshot_miss: 3 });

function event(overrides = {}) {
  return {
    schemaVersion: 'anysentry.agent_event.v1',
    eventId: 'event-s3-classification-1',
    sourceEventId: 'source-event-s3-classification-1',
    at: 1_787_200_000_000,
    eventKind: 'FileAccess',
    eventCategory: 'file',
    source: 'observer',
    subject: 'S3 classification semantics test',
    workspacePath: '/workspace/s3',
    agentId: 'unknown',
    collectorId: 'collector-s3',
    sourceId: 'source-s3',
    sessionId: 'legacy-session-s3',
    userId: 'system',
    traceId: 'legacy-trace-s3',
    spanId: 'legacy-span-s3',
    runId: 'legacy-run-s3',
    decisionStatus: 'succeeded',
    decisionRevision: 1,
    decisionUpdatedAt: 1_787_200_000_010,
    verdict: 'allow',
    tier: 'Rules',
    severity: 'info',
    reason: 'classification semantics test',
    riskCategory: 'other',
    riskName: 'none',
    riskType: 'atomic',
    riskScore: 0,
    tokenCount: 0,
    latencyMs: 1,
    attributes: { tenantId: 'tenant-s3', environmentId: 'test', path: '/workspace/s3/file' },
    process: {
      hostId: 'host-s3',
      bootId: 'boot-s3',
      pid: 3100,
      ppid: 1,
      startTimeTicks: '3300',
      lifecycleSource: 'exec_tombstone',
      lifecycleReason: 'process_exited_before_enrichment',
    },
    attribution: {
      monitored: false,
      classification: 'unknown',
      confidence: 0,
      reason: 'not_evaluated',
      source: 'none',
      evidence: ['workload_snapshot:miss'],
    },
    classificationSemantics: valid,
    ...overrides,
  };
}

process.env.ANYSENTRY_UNKNOWN_RETENTION_MODE = 'legacy';
const canonicalReceivedAt = 1_787_200_000_100;
const legacyCanonical = canonicalizeEvent(event(), JSON.stringify({ event: { FileAccess: { path: '/workspace/s3/file' } } }), canonicalReceivedAt);
assert.equal(legacyCanonical.classificationSemantics, undefined);

process.env.ANYSENTRY_UNKNOWN_RETENTION_MODE = 'shadow';
const shadowCanonical = canonicalizeEvent(event(), JSON.stringify({ event: { FileAccess: { path: '/workspace/s3/file' } } }), canonicalReceivedAt);
assert.deepEqual(shadowCanonical.classificationSemantics, valid);
const { classificationSemantics: _shadowOnly, ...shadowLegacyFields } = shadowCanonical;
assert.deepEqual(shadowLegacyFields, legacyCanonical, 'S3 shadow must not change any existing canonical field');
process.env.ANYSENTRY_UNKNOWN_RETENTION_MODE = 'enforce';
const enforceCanonical = canonicalizeEvent(event(), JSON.stringify({ event: { FileAccess: { path: '/workspace/s3/file' } } }), canonicalReceivedAt);
assert.deepEqual(enforceCanonical, shadowCanonical, 'enforce and shadow expose the same S3 facts');

const storeSource = await readFile(
  new URL('../apps/api/src/security-monitoring/clickhouse-store.ts', import.meta.url),
  'utf8',
);
assert.ok(storeSource.includes("classificationSemantics String DEFAULT '{}'"));
assert.ok(storeSource.includes('ADD COLUMN IF NOT EXISTS classificationSemantics String DEFAULT'));
assert.ok(storeSource.includes('delete stableRevision.classificationSemantics'));

function fakeClickHouse() {
  const state = { inserts: [], queryRows: [] };
  return {
    state,
    client: {
      async insert(options) {
        state.inserts.push(structuredClone(options));
        return { executed: true, query_id: 's3-test', summary: {}, response_headers: {}, http_status: 200 };
      },
      async query() {
        return { async json() { return structuredClone(state.queryRows); } };
      },
      async close() {},
    },
  };
}

function storeFor(fake) {
  const store = new ClickHouseStore();
  Object.assign(store, {
    client: fake.client,
    ready: true,
    eventWriteRetryDeadlineMs: 500,
    eventWriteAttemptTimeoutMs: 500,
    eventWriteCloseDeadlineMs: 1_000,
    eventWriteRetryDelayMs: () => 0,
  });
  return store;
}

const fake = fakeClickHouse();
const store = storeFor(fake);
process.env.ANYSENTRY_UNKNOWN_RETENTION_MODE = 'shadow';
await store.insertNow(event());
assert.equal(fake.state.inserts.length, 1);
const persisted = fake.state.inserts[0].values[0];
assert.deepEqual(JSON.parse(persisted.classificationSemantics), valid);
assert.deepEqual(JSON.parse(persisted.process), event().process);
assert.equal(persisted.traceId, event().traceId);
assert.equal(persisted.sessionId, event().sessionId);

fake.state.queryRows = [persisted];
const shadowRoundTrip = await store.searchEvents({
  sinceMs: event().at - 1,
  untilMs: event().at + 1,
  eventId: event().eventId,
  limit: 10,
});
assert.deepEqual(shadowRoundTrip?.[0].classificationSemantics, valid);
assert.equal(shadowRoundTrip?.[0].process?.lifecycleSource, 'exec_tombstone');

process.env.ANYSENTRY_UNKNOWN_RETENTION_MODE = 'legacy';
const legacyRoundTrip = await store.searchEvents({
  sinceMs: event().at - 1,
  untilMs: event().at + 1,
  eventId: event().eventId,
  limit: 10,
});
assert.equal(legacyRoundTrip?.[0].classificationSemantics, undefined);
assert.equal(legacyRoundTrip?.[0].process?.lifecycleSource, undefined);
assert.equal(legacyRoundTrip?.[0].process?.lifecycleReason, undefined);

// Replaying the same immutable revision across a shadow -> legacy rollback must use the same
// semantic digest and must not create a revision conflict or a second insert.
await assert.doesNotReject(() => store.insertNow(event()));
assert.equal(fake.state.inserts.length, 1);

if (previousMode === undefined) delete process.env.ANYSENTRY_UNKNOWN_RETENTION_MODE;
else process.env.ANYSENTRY_UNKNOWN_RETENTION_MODE = previousMode;

console.log('S3 classification-semantics parser, rollback, persistence, and canonical contracts verified');
