#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ClickHouseStore } from '../apps/api/dist/security-monitoring/clickhouse-store.js';
import { AggregationService } from '../apps/api/dist/security-monitoring/aggregation.service.js';
import { canonicalizeEvent } from '../apps/api/dist/security-monitoring/streaming-normalizer.js';

const previousTrustedCorrelationMode = process.env.ANYSENTRY_TRUSTED_CORRELATION_MODE;
process.env.ANYSENTRY_TRUSTED_CORRELATION_MODE = 'shadow';

const storeSource = await readFile(
  new URL('../apps/api/src/security-monitoring/clickhouse-store.ts', import.meta.url),
  'utf8',
);

for (const definition of [
  "invocationId String DEFAULT ''",
  "toolCallId String DEFAULT ''",
  "processInstanceKey String DEFAULT ''",
  "correlationMethod LowCardinality(String) DEFAULT ''",
  'correlationConfidence Float32 DEFAULT 0',
  "processHostId String DEFAULT JSONExtractString(process, 'hostId')",
  "processBootId String DEFAULT JSONExtractString(process, 'bootId')",
  "processPidNamespace String DEFAULT JSONExtractString(process, 'pidNamespace')",
  'evidenceResourceHash String DEFAULT multiIf(',
  'evidenceCommandHash String DEFAULT multiIf(',
]) {
  assert.ok(storeSource.includes(definition), `fresh DDL must include ${definition}`);
  const column = definition.split(' ')[0];
  assert.ok(storeSource.includes(`ADD COLUMN IF NOT EXISTS ${column} `), `upgrade ALTER must include ${column}`);
}

const correlation = {
  schemaVersion: 'anysentry.trusted_correlation.v1',
  agentRootInstanceId: `agent-root:v1:${'a'.repeat(64)}`,
  invocationId: 'invocation-resolved-1',
  toolCallId: 'tool-call-resolved-1',
  processInstanceId: `pri_${'b'.repeat(24)}`,
  method: 'agent_adapter',
  scope: 'invocation',
  confidence: 0.975,
  authority: 'authenticated_agent_adapter',
  inferred: false,
  traceOrigin: 'adapter',
  identityVersion: 'trusted_correlation.v1',
  provenance: [
    'source_authenticated',
    'source_scope_bound',
    'adapter_invocation',
    'adapter_tool_call',
    'runtime_root_key',
    'process_tuple',
  ],
  claimReceipts: [{ kind: 'agent_adapter', decision: 'accepted', reason: 'authorized' }],
};

function event(overrides = {}) {
  return {
    schemaVersion: 'anysentry.agent_event.v1',
    eventId: 'event-s2-1',
    sourceEventId: 'source-event-s2-1',
    at: 1_787_100_000_000,
    eventKind: 'ToolExec',
    eventCategory: 'tool',
    source: 'observer',
    subject: 'trusted correlation persistence event',
    workspacePath: '/workspace/s2',
    agentId: 'pi',
    collectorId: 'collector-1',
    sourceId: 'source-1',
    sessionId: 'legacy-session-1',
    userId: 'user-1',
    traceId: 'legacy-trace-1',
    spanId: 'legacy-span-1',
    parentSpanId: 'legacy-parent-1',
    runId: 'legacy-run-1',
    decisionStatus: 'succeeded',
    decisionRevision: 1,
    decisionUpdatedAt: 1_787_100_000_010,
    verdict: 'allow',
    tier: 'Rules',
    severity: 'info',
    reason: 'trusted persistence test',
    riskCategory: 'other',
    riskName: 'none',
    riskType: 'atomic',
    riskScore: 0,
    tokenCount: 0,
    latencyMs: 1,
    attributes: {
      tenantId: 'tenant-1',
      environmentId: 'test',
      collectorNode: 'node-1',
    },
    process: {
      hostId: 'node-1',
      bootId: 'boot-1',
      pid: 4242,
      ppid: 1,
      startTimeTicks: '987654',
    },
    attribution: {
      monitored: true,
      classification: 'confirmed_agent',
      agentScopeId: 'pi',
      agentDisplayName: 'Pi',
      agentSessionId: 'attributed-legacy-session',
      agentInstanceId: 'legacy-runtime-1',
      rootPid: 4242,
      rootStartTime: '987654',
      confidence: 0.99,
      reason: 'process_lineage',
      source: 'process_graph',
    },
    ...overrides,
  };
}

function fakeClickHouse() {
  const state = { inserts: [], queries: [], queryRows: [] };
  return {
    state,
    client: {
      async insert(options) {
        state.inserts.push(structuredClone(options));
        return { executed: true, query_id: 's2-test', summary: {}, response_headers: {}, http_status: 200 };
      },
      async query(options) {
        state.queries.push(structuredClone(options));
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

const trustedEvent = event({
  // Deliberately inconsistent convenience values prove the resolver-owned object wins.
  invocationId: 'producer-convenience-must-not-win',
  toolCallId: 'producer-tool-convenience-must-not-win',
  attribution: { ...event().attribution, correlation },
});
const fake = fakeClickHouse();
const store = storeFor(fake);
await store.insertNow(trustedEvent);
assert.equal(fake.state.inserts.length, 1);
const persisted = fake.state.inserts[0].values[0];
assert.equal(persisted.traceId, 'legacy-trace-1');
assert.equal(persisted.invocationId, correlation.invocationId);
assert.equal(persisted.toolCallId, correlation.toolCallId);
assert.equal(persisted.processInstanceKey, correlation.processInstanceId);
assert.equal(persisted.correlationMethod, correlation.method);
assert.equal(persisted.correlationConfidence, correlation.confidence);
assert.equal(persisted.processHostId, 'node-1');
assert.equal(persisted.processBootId, 'boot-1');
assert.equal(persisted.processPid, 4242);

const untrusted = event({
  eventId: 'event-untrusted-claim',
  sourceEventId: 'source-event-untrusted-claim',
  invocationId: 'raw-top-level-invocation',
  toolCallId: 'raw-top-level-tool',
  attributes: {
    ...event().attributes,
    invocationId: 'raw-attribute-invocation',
    toolCallId: 'raw-attribute-tool',
  },
});
await store.insertNow(untrusted);
const untrustedRow = fake.state.inserts[1].values[0];
assert.equal(untrustedRow.invocationId, '', 'unresolved producer invocation claims must not be persisted');
assert.equal(untrustedRow.toolCallId, '', 'unresolved producer tool claims must not be persisted');

const forgedCorrelation = {
  ...correlation,
  authority: 'server_inventory',
  provenance: Array.from({ length: 17 }, () => 'adapter_invocation'),
};
const forgedPersistedEvent = event({
  eventId: 'event-forged-persisted-correlation',
  sourceEventId: 'source-event-forged-persisted-correlation',
  invocationId: 'forged-top-level-invocation',
  toolCallId: { forged: true },
  attribution: { ...event().attribution, correlation: forgedCorrelation },
});
await assert.doesNotReject(() => store.insertNow(forgedPersistedEvent));
const forgedPersistedRow = fake.state.inserts[2].values[0];
assert.equal(forgedPersistedRow.invocationId, '', 'invalid nested correlation must not reach an indexed identity column');
assert.equal(forgedPersistedRow.toolCallId, '', 'malformed producer ToolCall data must fail closed without failing ingestion');
assert.equal(forgedPersistedRow.correlationMethod, '');

fake.state.queryRows = [persisted];
const roundTrip = await store.searchEvents({
  sinceMs: trustedEvent.at - 1,
  untilMs: trustedEvent.at + 1,
  eventId: trustedEvent.eventId,
  limit: 10,
});
assert.equal(roundTrip?.length, 1);
assert.equal(roundTrip?.[0].invocationId, correlation.invocationId);
assert.equal(roundTrip?.[0].toolCallId, correlation.toolCallId);
assert.deepEqual(roundTrip?.[0].attribution?.correlation, correlation);
assert.equal(roundTrip?.[0].traceId, trustedEvent.traceId);
assert.equal(roundTrip?.[0].sessionId, trustedEvent.sessionId);
assert.equal(roundTrip?.[0].runId, trustedEvent.runId);

const legacyRow = structuredClone(persisted);
delete legacyRow.invocationId;
delete legacyRow.toolCallId;
delete legacyRow.processInstanceKey;
delete legacyRow.correlationMethod;
delete legacyRow.correlationConfidence;
legacyRow.attribution = JSON.stringify(event().attribution);
fake.state.queryRows = [legacyRow];
const legacyRoundTrip = await store.searchEvents({
  sinceMs: trustedEvent.at - 1,
  untilMs: trustedEvent.at + 1,
  eventId: trustedEvent.eventId,
  limit: 10,
});
assert.equal(legacyRoundTrip?.[0].invocationId, undefined);
assert.equal(legacyRoundTrip?.[0].toolCallId, undefined);
assert.equal(legacyRoundTrip?.[0].attribution?.correlation, undefined);
assert.equal(legacyRoundTrip?.[0].traceId, trustedEvent.traceId);

const forgedRoundTripRow = {
  ...persisted,
  eventId: 'event-forged-round-trip',
  sourceEventId: 'source-event-forged-round-trip',
  invocationId: 'forged-index-invocation',
  toolCallId: 'forged-index-tool',
  correlationMethod: 'agent_adapter',
  correlationConfidence: 1,
  attribution: JSON.stringify({ ...event().attribution, correlation: forgedCorrelation }),
};
fake.state.queryRows = [forgedRoundTripRow];
let forgedRoundTrip;
await assert.doesNotReject(async () => {
  forgedRoundTrip = await store.searchEvents({
    sinceMs: trustedEvent.at - 1,
    untilMs: trustedEvent.at + 1,
    eventId: forgedRoundTripRow.eventId,
    limit: 10,
  });
});
assert.equal(forgedRoundTrip?.[0].invocationId, undefined);
assert.equal(forgedRoundTrip?.[0].toolCallId, undefined);
assert.equal(forgedRoundTrip?.[0].attribution?.correlation, undefined);

const inconsistentProjectionRow = {
  ...persisted,
  eventId: 'event-inconsistent-correlation-projection',
  sourceEventId: 'source-event-inconsistent-correlation-projection',
  invocationId: 'narrow-column-does-not-match-resolver-object',
};
fake.state.queryRows = [inconsistentProjectionRow];
const inconsistentProjection = await store.searchEvents({
  sinceMs: trustedEvent.at - 1,
  untilMs: trustedEvent.at + 1,
  eventId: inconsistentProjectionRow.eventId,
  limit: 10,
});
assert.equal(inconsistentProjection?.[0].invocationId, undefined);
assert.equal(inconsistentProjection?.[0].toolCallId, undefined);
assert.equal(
  inconsistentProjection?.[0].attribution?.correlation,
  undefined,
  'a valid nested object with inconsistent indexed projections must fail closed at the persistence boundary',
);

process.env.ANYSENTRY_TRUSTED_CORRELATION_MODE = 'off';
fake.state.queryRows = [persisted];
const persistedAfterRollback = await store.searchEvents({
  sinceMs: trustedEvent.at - 1,
  untilMs: trustedEvent.at + 1,
  eventId: trustedEvent.eventId,
  limit: 10,
});
assert.equal(persistedAfterRollback?.[0].invocationId, undefined);
assert.equal(persistedAfterRollback?.[0].toolCallId, undefined);
assert.equal(persistedAfterRollback?.[0].attribution?.correlation, undefined);
assert.equal(persistedAfterRollback?.[0].traceId, trustedEvent.traceId);
assert.equal(persistedAfterRollback?.[0].sessionId, trustedEvent.sessionId);
assert.equal(persistedAfterRollback?.[0].runId, trustedEvent.runId);
process.env.ANYSENTRY_TRUSTED_CORRELATION_MODE = 'shadow';

fake.state.queryRows = [];
fake.state.queries.length = 0;
await store.searchEvents({
  sinceMs: trustedEvent.at - 1,
  untilMs: trustedEvent.at + 1,
  invocationId: correlation.invocationId,
  limit: 10,
});
const invocationQuery = fake.state.queries[0];
assert.match(invocationQuery.query, /invocationId = \{invocationId:String\}/u);
assert.equal(invocationQuery.query_params.invocationId, correlation.invocationId);
assert.equal(invocationQuery.query_params.traceId, undefined);

fake.state.queries.length = 0;
await store.searchEvents({
  sinceMs: trustedEvent.at - 1,
  untilMs: trustedEvent.at + 1,
  traceId: trustedEvent.traceId,
  limit: 10,
});
const traceQuery = fake.state.queries[0];
assert.match(traceQuery.query, /traceId = \{traceId:String\}/u);
assert.equal(traceQuery.query_params.traceId, trustedEvent.traceId);
assert.equal(traceQuery.query_params.invocationId, undefined);
await store.close();

const observerLine = JSON.stringify({
  event: { ToolExec: { pid: 4242, ppid: 1, cwd: '/workspace/s2', argv: ['printf', 'ok'] } },
});
const baseline = canonicalizeEvent(event(), observerLine, trustedEvent.at + 100);
const canonicalTrusted = canonicalizeEvent(trustedEvent, observerLine, trustedEvent.at + 100);
const legacyCanonicalIdentity = (value) => ({
  eventId: value.eventId,
  sourceEventId: value.sourceEventId,
  sourceRecordId: value.sourceRecordId,
  claimedAgentId: value.claimedAgentId,
  agentInstanceId: value.agentInstanceId,
  agentCorrelationId: value.agentCorrelationId,
  sessionId: value.sessionId,
  traceId: value.traceId,
  spanId: value.spanId,
  processInstanceId: value.processIdentity.processInstanceId,
});
assert.deepEqual(
  legacyCanonicalIdentity(canonicalTrusted),
  legacyCanonicalIdentity(baseline),
  'trusted correlation must be additive to every canonical v1 legacy identity field',
);
const withoutCorrelation = structuredClone(canonicalTrusted);
delete withoutCorrelation.invocationId;
delete withoutCorrelation.toolCallId;
delete withoutCorrelation.correlation;
assert.deepEqual(
  withoutCorrelation,
  baseline,
  'canonical correlation rollout must leave every pre-existing canonical v1 value unchanged',
);
assert.equal(canonicalTrusted.invocationId, correlation.invocationId);
assert.equal(canonicalTrusted.toolCallId, correlation.toolCallId);
assert.deepEqual(canonicalTrusted.correlation, correlation);

const canonicalUntrusted = canonicalizeEvent(untrusted, observerLine, trustedEvent.at + 100);
assert.equal(canonicalUntrusted.invocationId, undefined);
assert.equal(canonicalUntrusted.toolCallId, undefined);
assert.equal(canonicalUntrusted.correlation, undefined);

let canonicalMalformed;
assert.doesNotThrow(() => {
  canonicalMalformed = canonicalizeEvent(
    forgedPersistedEvent,
    observerLine,
    trustedEvent.at + 100,
  );
});
assert.equal(canonicalMalformed.invocationId, undefined);
assert.equal(canonicalMalformed.toolCallId, undefined);
assert.equal(canonicalMalformed.correlation, undefined);

// Simulate a runtime rollback from shadow to off while already-persisted shadow rows remain.
// Both public DTO and canonical stream boundaries must hide the additive view immediately.
process.env.ANYSENTRY_TRUSTED_CORRELATION_MODE = 'off';
const canonicalAfterRollback = canonicalizeEvent(trustedEvent, observerLine, trustedEvent.at + 100);
const canonicalLegacyAfterRollback = canonicalizeEvent(event(), observerLine, trustedEvent.at + 100);
assert.deepEqual(
  canonicalAfterRollback,
  canonicalLegacyAfterRollback,
  'mode=off must restore the exact legacy canonical path even for a historical shadow event',
);

const historicalShadowEvent = event({
  at: Date.now() - 1_000,
  eventId: 'event-historical-shadow-public-read',
  sourceEventId: 'source-event-historical-shadow-public-read',
  invocationId: correlation.invocationId,
  toolCallId: correlation.toolCallId,
  attribution: { ...event().attribution, correlation },
});
const offAggregation = new AggregationService(
  {
    query: () => [historicalShadowEvent],
    queryRange: () => [historicalShadowEvent],
    committedEventProgress: () => [],
  },
  {
    identitySnapshotVersion: () => 0,
    resolveEvent: () => ({
      agentAssetId: 'asset-s2',
      displayName: 'Pi',
      detectedName: 'Pi',
      detectedClassification: 'confirmed_agent',
      effectiveClassification: 'confirmed_agent',
    }),
  },
  {},
  {},
  {},
);
const legacyPublicRead = offAggregation.agentEvents({
  timeType: 'last_30d',
  scope: 'raw',
  limit: 10,
});
assert.equal(legacyPublicRead.items.length, 1);
assert.equal(legacyPublicRead.items[0].invocationId, undefined);
assert.equal(legacyPublicRead.items[0].toolCallId, undefined);
assert.equal(legacyPublicRead.items[0].correlation, undefined);
assert.equal(legacyPublicRead.items[0].attribution?.correlation, undefined);
const disabledInvocationRead = offAggregation.agentEvents({
  timeType: 'last_30d',
  scope: 'raw',
  invocationId: correlation.invocationId,
  limit: 10,
});
assert.deepEqual(
  disabledInvocationRead.items,
  legacyPublicRead.items,
  'mode=off must ignore the unknown additive invocationId predicate and preserve the exact legacy result',
);
assert.equal(disabledInvocationRead.total, legacyPublicRead.total);

process.env.ANYSENTRY_TRUSTED_CORRELATION_MODE = 'shadow';

const offFake = fakeClickHouse();
const shadowFake = fakeClickHouse();
const offStore = storeFor(offFake);
const shadowStore = storeFor(shadowFake);
await offStore.insertNow(event());
await shadowStore.insertNow(event({ attribution: { ...event().attribution, correlation } }));
const token = (item) => item.inserts[0].clickhouse_settings.insert_deduplication_token;
const offPersisted = structuredClone(offFake.state.inserts[0].values[0]);
delete offPersisted.ingestedAt;
delete offPersisted.invocationId;
delete offPersisted.toolCallId;
delete offPersisted.processInstanceKey;
delete offPersisted.processHostId;
delete offPersisted.processBootId;
delete offPersisted.processPid;
delete offPersisted.processPpid;
delete offPersisted.processPidNamespace;
delete offPersisted.processNamespacePid;
delete offPersisted.processNamespacePpid;
delete offPersisted.processStartTimeTicks;
delete offPersisted.processStartTimeNs;
delete offPersisted.evidenceResourceHash;
delete offPersisted.evidenceCommandHash;
delete offPersisted.correlationMethod;
delete offPersisted.correlationConfidence;
// S3 classification semantics is another additive projection. The stable retry token deliberately
// removes it alongside S2 correlation so an old immutable event keeps its pre-rollout identity.
delete offPersisted.classificationSemantics;
const expectedLegacyOffToken = `event-${createHash('sha256')
  .update('revisions\0')
  .update(JSON.stringify(offPersisted))
  .update('\n')
  .digest('hex')}`;
assert.equal(token(offFake.state), expectedLegacyOffToken, 'legacy events must retain the pre-S2 token algorithm');
assert.equal(
  token(offFake.state),
  token(shadowFake.state),
  'off/shadow retries of one immutable revision must use the same deduplication token',
);
await assert.rejects(
  offStore.insertNow(event({ reason: 'a real decision conflict' })),
  (error) => error?.code === 'ANYSENTRY_EVENT_REVISION_CONFLICT',
);
await assert.rejects(
  shadowStore.insertNow(event({
    attribution: { ...event().attribution, correlation },
    judgment: { stages: [{ stage: 'L1', verdict: 'block' }] },
  })),
  (error) => error?.code === 'ANYSENTRY_EVENT_REVISION_CONFLICT',
  'evidence changes must remain conflict-protected',
);
await offStore.close();
await shadowStore.close();

if (previousTrustedCorrelationMode === undefined) {
  delete process.env.ANYSENTRY_TRUSTED_CORRELATION_MODE;
} else {
  process.env.ANYSENTRY_TRUSTED_CORRELATION_MODE = previousTrustedCorrelationMode;
}

console.log('S2 persistence and canonical reader-first verification passed');
