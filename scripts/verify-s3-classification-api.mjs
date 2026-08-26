#!/usr/bin/env node

import assert from 'node:assert/strict';
import { managementAuthHeaders, safeProbeId } from './probe-id.mjs';

const baseUrl = (
  process.env.ANYSENTRY_API_BASE
  ?? process.env.API_BASE
  ?? `http://127.0.0.1:${process.env.PORT ?? '29653'}/security-center`
).replace(/\/$/, '');
const expectedMode = process.env.ANYSENTRY_S3_EXPECT_MODE ?? process.env.ANYSENTRY_UNKNOWN_RETENTION_MODE;
const runId = safeProbeId(`s3-${expectedMode ?? 'unset'}`);

assert.ok(expectedMode === 'legacy' || expectedMode === 'shadow' || expectedMode === 'enforce');

async function request(path, method = 'GET', body, headers = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...managementAuthHeaders(), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  let payload;
  try {
    payload = raw ? JSON.parse(raw) : undefined;
  } catch {
    payload = raw;
  }
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}: ${raw}`);
  return payload?.data ?? payload;
}

async function waitForEvent(eventId) {
  const deadline = Date.now() + 10_000;
  let list;
  do {
    list = await request('/events/list', 'POST', {
      timeType: 'last_30d',
      scope: 'raw',
      includeUnknown: true,
      eventId,
      limit: 20,
    });
    const item = list.items?.find((candidate) => candidate.eventId === eventId);
    if (item) return item;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error(`event ${eventId} did not become visible: ${JSON.stringify(list)}`);
}

function line(suffix, lifecycleReason = 'pid_reuse_ambiguous') {
  return JSON.stringify({
    identity: { agent: 'unknown', task: '4310', session: `${runId}-legacy-session` },
    process: {
      host_id: `${runId}-host`,
      boot_id: `${runId}-boot`,
      pid: 4310,
      ppid: 0,
      cgroup_id: '4310',
      comm: 'custom-runner',
      lifecycle_reason: lifecycleReason,
    },
    event: { ProcessExit: { pid: 4310, exit_code: 0, signal: 0, marker: `${runId}-${suffix}` } },
  });
}

const validSemantics = {
  schemaVersion: 'anysentry.classification_semantics.v1',
  identityClassification: 'unknown',
  workloadRole: 'unknown',
  captureProfile: 'unknown_discovery',
  unknownReason: 'pid_reuse_ambiguous',
};
const collectorId = `${runId}-collector`;
const protectedSource = await request('/sources', 'POST', {
  name: `${runId} trusted forwarder`,
  type: 'observer',
  enabled: true,
  requireToken: true,
  collectorId,
  owner: 'verify-s3-classification-api',
  tags: [runId, 's3-classification'],
});
assert.ok(protectedSource.source?.sourceId && protectedSource.token);
const sourceHeaders = {
  'x-anysentry-source-id': protectedSource.source.sourceId,
  'x-anysentry-ingest-token': protectedSource.token,
};

const spoofed = await request('/ingest', 'POST', {
  line: line('untrusted-spoof'),
  sourceEventId: `${runId}-source-untrusted-spoof`,
  collectorId: `${runId}-untrusted-collector`,
  classificationSemantics: validSemantics,
  attribution: {
    monitored: false,
    classification: 'unknown',
    confidence: 0,
    reason: 'not_evaluated',
    source: 'none',
  },
});
assert.equal(spoofed.accepted, true, 'legacy tokenless ingestion remains accepted');
assert.equal(
  (await waitForEvent(spoofed.eventId)).classificationSemantics,
  undefined,
  'tokenless producers cannot publish the resolved S3 view',
);
assert.equal(
  (await waitForEvent(spoofed.eventId)).process?.lifecycleReason,
  undefined,
  'tokenless producers cannot publish Collector lifecycle provenance',
);

const lifecycleOnlySpoof = await request('/ingest', 'POST', {
  line: JSON.stringify({
    identity: { agent: 'unknown', session: `${runId}-lifecycle-only` },
    process: { lifecycle_source: 'exec_tombstone', lifecycle_reason: 'pid_reuse_ambiguous' },
    event: { FileAccess: { path: `/tmp/${runId}-lifecycle-only` } },
  }),
  sourceEventId: `${runId}-source-lifecycle-only-spoof`,
  collectorId: `${runId}-untrusted-collector`,
});
assert.equal(lifecycleOnlySpoof.accepted, true);
assert.equal(
  (await waitForEvent(lifecycleOnlySpoof.eventId)).process,
  undefined,
  'stripping untrusted S3-only provenance must preserve the legacy absent-process shape',
);

const legacyTraceId = `${runId}-legacy-trace`;
const ingested = await request('/ingest', 'POST', {
  line: line('valid'),
  sourceEventId: `${runId}-source-valid`,
  collectorId,
  traceId: legacyTraceId,
  classificationSemantics: validSemantics,
  attribution: {
    monitored: false,
    classification: 'unknown',
    confidence: 0,
    reason: 'not_evaluated',
    source: 'none',
    evidence: ['process_lineage:incomplete'],
  },
}, sourceHeaders);
assert.equal(ingested.accepted, true);
const event = await waitForEvent(ingested.eventId);
assert.equal(event.traceId, legacyTraceId, 'S3 must preserve the legacy Trace ID');

if (expectedMode !== 'legacy') {
  assert.deepEqual(event.classificationSemantics, validSemantics);
  assert.equal(event.process?.lifecycleReason, 'pid_reuse_ambiguous');
} else {
  assert.equal(event.classificationSemantics, undefined);
  assert.equal(event.process?.lifecycleSource, undefined);
  assert.equal(event.process?.lifecycleReason, undefined);
}

const mismatch = await request('/ingest', 'POST', {
  line: line('mismatch'),
  sourceEventId: `${runId}-source-mismatch`,
  collectorId,
  classificationSemantics: {
    ...validSemantics,
    identityClassification: 'confirmed_agent',
    workloadRole: 'agent',
    captureProfile: 'agent_full',
    unknownReason: undefined,
  },
  attribution: {
    monitored: false,
    classification: 'unknown',
    confidence: 0,
    reason: 'not_evaluated',
    source: 'none',
  },
}, sourceHeaders);
assert.equal(mismatch.accepted, true);
assert.equal((await waitForEvent(mismatch.eventId)).classificationSemantics, undefined);

const untrustedHeartbeatCollector = `${runId}-untrusted-heartbeat`;
await request('/collectors/heartbeat', 'POST', {
  collectorId: untrustedHeartbeatCollector,
  sourceType: 'forwarder',
  status: 'ok',
  intervalSecs: 30,
  filterMetrics: {
    scope: 'decoupled',
    observed: 1,
    forwarded: 1,
    confirmedAgent: 0,
    probableAgent: 0,
    unknown: 1,
    unknownReasonCounts: { snapshot_miss: 1 },
    nonAgent: 0,
    filteredNonAgent: 0,
    wouldFilterNonAgent: 0,
    filteredUnknown: 0,
    wouldFilterUnknown: 0,
    filteredNoise: 0,
    wouldFilterNoise: 0,
    discoveryBudgetDropped: 0,
    wouldDiscoveryBudgetDrop: 0,
  },
});
const untrustedCollectors = await request('/collectors/health', 'POST', {
  timeType: 'last_30m',
  collectorId: untrustedHeartbeatCollector,
  limit: 10,
});
assert.equal(
  untrustedCollectors.items?.[0]?.filterMetrics?.unknownReasonCounts,
  undefined,
  'tokenless heartbeats cannot publish resolved Unknown-reason counts',
);

const heartbeatCollector = collectorId;
const heartbeat = await request('/collectors/heartbeat', 'POST', {
  collectorId: heartbeatCollector,
  sourceType: 'observer',
  status: 'ok',
  intervalSecs: 30,
  filterMetrics: {
    scope: 'decoupled',
    observed: 7,
    forwarded: 7,
    confirmedAgent: 0,
    probableAgent: 0,
    unknown: 7,
    unknownReasonCounts: {
      snapshot_miss: 5,
      pid_reuse_ambiguous: 2,
      [`pid:${runId}:4310`]: 100,
    },
    nonAgent: 0,
    filteredNonAgent: 0,
    wouldFilterNonAgent: 0,
    filteredUnknown: 0,
    wouldFilterUnknown: 0,
    filteredNoise: 0,
    wouldFilterNoise: 0,
    discoveryBudgetDropped: 0,
    wouldDiscoveryBudgetDrop: 0,
  },
}, sourceHeaders);
assert.equal(heartbeat.accepted, true);
const collectors = await request('/collectors/health', 'POST', {
  timeType: 'last_30m',
  collectorId: heartbeatCollector,
  limit: 10,
});
const collector = collectors.items?.find((item) => item.collectorId === heartbeatCollector);
assert.ok(collector, JSON.stringify(collectors));
if (expectedMode !== 'legacy') {
  assert.deepEqual(collector.filterMetrics.unknownReasonCounts, {
    snapshot_miss: 5,
    pid_reuse_ambiguous: 2,
  });
} else {
  assert.equal(collector.filterMetrics.unknownReasonCounts, undefined);
}

console.log(`S3 classification API E2E passed in ${expectedMode} mode`);
