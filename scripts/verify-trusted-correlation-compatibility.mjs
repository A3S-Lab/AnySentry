#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalizeEvent } from '../apps/api/dist/security-monitoring/streaming-normalizer.js';
import { correlationCaptureRollout } from '../apps/api/dist/security-monitoring/correlation-rollout.js';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));

assert.deepEqual(
  correlationCaptureRollout({}),
  {
    trustedCorrelation: 'off',
    captureProfile: 'legacy',
    unknownRetention: 'legacy',
  },
  'all independent rollout controls must preserve the legacy path by default',
);
assert.deepEqual(
  correlationCaptureRollout({
    ANYSENTRY_TRUSTED_CORRELATION_MODE: 'invalid',
    ANYSENTRY_CAPTURE_PROFILE_MODE: 'FULL',
    ANYSENTRY_UNKNOWN_RETENTION_MODE: 'drop',
  }),
  {
    trustedCorrelation: 'off',
    captureProfile: 'legacy',
    unknownRetention: 'legacy',
  },
  'invalid rollout controls must fail closed to the legacy path',
);
assert.deepEqual(
  correlationCaptureRollout({
    ANYSENTRY_TRUSTED_CORRELATION_MODE: 'shadow',
    ANYSENTRY_CAPTURE_PROFILE_MODE: 'shadow',
    ANYSENTRY_UNKNOWN_RETENTION_MODE: 'shadow',
  }),
  {
    trustedCorrelation: 'shadow',
    captureProfile: 'shadow',
    unknownRetention: 'shadow',
  },
  'each rollout control must be independently selectable',
);

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function contains(relativePath, expected, label) {
  const source = read(relativePath);
  assert.ok(source.includes(expected), label + ' (' + relativePath + ')');
}

const legacyEventFields = [
  'agentId: string;',
  'sessionId: string;',
  'traceId: string;',
  'spanId: string;',
  'runId: string;',
];
for (const field of legacyEventFields) {
  contains(
    'apps/api/src/security-monitoring/types.ts',
    field,
    'JudgedEvent must retain required legacy field ' + field,
  );
}

for (const column of [
  'agentId LowCardinality(String)',
  'sessionId String',
  'traceId String',
  'spanId String',
  'runId String',
  'agentIdentityKey String',
  'agentInstanceKey String',
]) {
  contains(
    'apps/api/src/security-monitoring/clickhouse-store.ts',
    column,
    'ClickHouse must retain legacy event column ' + column,
  );
}

contains(
  'apps/api/src/security-monitoring/streaming-normalizer.ts',
  'traceId: event.traceId,',
  'canonical v1 must preserve the legacy trace value',
);
contains(
  'apps/api/src/security-monitoring/sentry-judge.service.ts',
  'e.sessionId, e.traceId, e.runId, e.riskCategory',
  'existing Incident identity must keep the legacy trace key',
);
contains(
  'apps/api/src/security-monitoring/alerting.service.ts',
  "['event', event.workspacePath, canonicalAgentId, event.traceId, event.riskCategory]",
  'existing Alert deduplication must keep the legacy trace key',
);
contains(
  'streaming/flink/src/main/java/org/a3s/anysentry/streaming/AnySentryStreamJob.java',
  '.keyBy(AnySentryStreamJob::riskProfileEntityKey)',
  'Flink profile state must use the runtime-aware compatibility key',
);
contains(
  'streaming/flink/src/main/java/org/a3s/anysentry/streaming/AnySentryStreamJob.java',
  '? event.agentCorrelationId',
  'Flink profile state must retain agentCorrelationId as the legacy-event fallback',
);
contains(
  'streaming/flink/src/main/java/org/a3s/anysentry/streaming/BehaviorSignal.java',
  '+ ":" + (blank(sessionId) ? "no-session" : sessionId)',
  'existing Flink episode state must keep the legacy session component',
);
contains(
  'streaming/flink/src/main/java/org/a3s/anysentry/streaming/CanonicalEventParser.java',
  'new ObjectMapper()',
  'the strict Java reader boundary must remain visible until reader-first migration completes',
);

function legacyEvent() {
  return {
    schemaVersion: 'anysentry.agent_event.v1',
    eventId: 'legacy-record-1',
    sourceEventId: 'legacy-source-event-1',
    at: 1_787_000_000_000,
    eventKind: 'ToolExec',
    eventCategory: 'tool',
    source: 'observer',
    subject: 'legacy compatibility event',
    workspacePath: '/workspace/compatibility',
    agentId: 'compat-agent',
    collectorId: 'compat-collector',
    sourceId: 'compat-source',
    sessionId: 'legacy-session',
    userId: 'compat-user',
    traceId: 'legacy-trace',
    spanId: 'legacy-span',
    parentSpanId: 'legacy-parent',
    runId: 'legacy-run',
    verdict: 'allow',
    tier: 'L1',
    severity: 'low',
    reason: 'compatibility fixture',
    riskCategory: 'none',
    riskName: 'None',
    riskType: 'none',
    riskScore: 0,
    tokenCount: 0,
    latencyMs: 1,
    attributes: {
      tenantId: 'compat-tenant',
      environmentId: 'compat-environment',
      collectorNode: 'compat-node',
    },
    process: {
      hostId: 'compat-node',
      bootId: 'compat-boot',
      pid: 4242,
      ppid: 1,
      startTimeTicks: '987654',
      mountNamespace: 4026531840,
    },
    attribution: {
      monitored: true,
      classification: 'confirmed_agent',
      agentScopeId: 'compat-agent',
      agentDisplayName: 'Compatibility Agent',
      agentSessionId: 'trusted-legacy-session',
      agentInstanceId: 'legacy-runtime-instance',
      rootPid: 4242,
      rootStartTime: '987654',
      confidence: 0.99,
      reason: 'process_lineage',
      source: 'process_graph',
    },
  };
}

const observerLine = JSON.stringify({
  event: {
    ToolExec: {
      pid: 4242,
      ppid: 1,
      uid: 1000,
      cwd: '/workspace/compatibility',
      argv: ['printf', 'compatibility'],
    },
  },
});

const baseline = canonicalizeEvent(legacyEvent(), observerLine, 1_787_000_000_100);
const additiveInput = legacyEvent();
additiveInput.invocationId = 'claimed-invocation';
additiveInput.toolCallId = 'claimed-tool-call';
additiveInput.correlation = {
  schemaVersion: 'anysentry.trusted_correlation.v1',
  invocationId: 'resolved-invocation',
  method: 'application_trace',
  scope: 'invocation',
  confidence: 1,
  inferred: false,
};
additiveInput.attribution = {
  ...additiveInput.attribution,
  correlation: additiveInput.correlation,
};
const withAdditiveClaims = canonicalizeEvent(
  additiveInput,
  observerLine,
  1_787_000_000_100,
);

function legacyCanonicalIdentity(event) {
  return {
    eventId: event.eventId,
    sourceEventId: event.sourceEventId,
    sourceRecordId: event.sourceRecordId,
    claimedAgentId: event.claimedAgentId,
    agentInstanceId: event.agentInstanceId,
    agentCorrelationId: event.agentCorrelationId,
    sessionId: event.sessionId,
    traceId: event.traceId,
    spanId: event.spanId,
    processInstanceId: event.processIdentity.processInstanceId,
  };
}

assert.deepEqual(
  legacyCanonicalIdentity(withAdditiveClaims),
  legacyCanonicalIdentity(baseline),
  'additive correlation claims must not mutate the canonical legacy identity',
);
assert.equal(baseline.traceId, 'legacy-trace');
assert.equal(baseline.spanId, 'legacy-span');
assert.equal(baseline.sessionId, 'trusted-legacy-session');

console.log('Trusted correlation compatibility baseline verification passed');
