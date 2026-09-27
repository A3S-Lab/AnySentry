import assert from 'node:assert/strict';

process.env.ANYSENTRY_UNKNOWN_LEARNING_ENABLED = 'true';
process.env.ANYSENTRY_UNKNOWN_LEARNING_WINDOW_MS = '60000';
const { UnknownLearningRuntimeService } = await import(
  '../apps/api/dist/security-monitoring/unknown-learning-runtime.service.js'
);

function event(id, at) {
  return {
    schemaVersion: 'anysentry.agent_event.v1',
    eventId: id,
    at,
    eventKind: 'FileAccess',
    eventCategory: 'file',
    source: 'observer',
    subject: 'unknown runtime persistence fixture',
    workspacePath: '/workspace',
    agentId: 'unknown',
    sessionId: 'legacy',
    userId: 'uid:1000',
    traceId: 'legacy-trace',
    spanId: `span-${id}`,
    runId: 'legacy-run',
    verdict: 'allow',
    tier: 'Rules',
    severity: 'info',
    reason: 'observed',
    riskCategory: 'benign',
    riskName: 'Normal',
    riskType: 'atomic',
    riskScore: 0,
    tokenCount: 0,
    latencyMs: 1,
    attributes: { path: '/workspace/src/runtime.ts' },
    classificationSemantics: {
      schemaVersion: 'anysentry.classification_semantics.v1',
      identityClassification: 'unknown',
      workloadRole: 'unknown',
      captureProfile: 'unknown_discovery',
      unknownReason: 'signature_miss',
    },
    process: { hostId: 'host', bootId: 'boot', pid: 42, ppid: 1, startTimeTicks: '9001' },
    attribution: {
      monitored: false, classification: 'unknown', physicalWorkloadId: 'docker:runtime-fixture',
      confidence: 0, reason: 'not_evaluated', source: 'none',
    },
  };
}

let persisted;
let saves = 0;
const judge = {
  loadUnknownLearningState: async () => persisted,
  saveUnknownLearningState: async (state) => {
    saves += 1;
    persisted = structuredClone(state);
    return true;
  },
};

const start = Math.floor((Date.now() - 60_000) / 60_000) * 60_000;
const service = new UnknownLearningRuntimeService(judge);
await service.onModuleInit();
assert.equal(service.status().enabled, true);
assert.equal(service.status().persistenceIntervalMs, 30_000);
assert.equal(service.observe(event('runtime-event-1', start + 1_000)).clusteredEvents, 1);
assert.equal(service.observe(event('runtime-event-1', start + 1_000)).duplicateEvents, 1);
const family = service.listFamilies()[0];
assert.equal(family.exactCount, 1);
const review = service.reviewFamily({
  familyId: family.familyId, decision: 'non_agent', actor: 'operator', reason: 'verified service', expectedRevision: 0,
});
assert.equal(review.revision, 1);
let policy = service.createCandidate({
  familyId: family.familyId, desiredAction: 'aggregate', actor: 'operator', reason: 'candidate only',
});
policy = service.transition({
  policyId: policy.policyId, expectedRevision: policy.revision, to: 'shadow', actor: 'operator', reason: 'shadow first',
});
assert.equal(policy.stage, 'shadow');
await service.onModuleDestroy();
assert.equal(saves, 1);
assert.equal(persisted.schemaVersion, 'anysentry.unknown_learning_state.v1');

const restored = new UnknownLearningRuntimeService(judge);
await restored.onModuleInit();
assert.equal(restored.status().restored, true);
assert.equal(restored.listFamilies()[0].exactCount, 1);
assert.equal(restored.listFamilies()[0].review, 'non_agent');
assert.equal(restored.listPolicies()[0].stage, 'shadow');
assert.equal(restored.observe(event('runtime-event-1', start + 1_000)).duplicateEvents, 1);
const beforeOperational = restored.status();
for (const operationalKind of ['CaptureAggregate', 'SystemContext']) {
  const operational = {
    ...event(`${operationalKind}-operational`, start + 1_500),
    eventKind: operationalKind,
    eventCategory: 'runtime',
  };
  restored.observe(operational);
  assert.equal(
    restored.status().dedupeEntries,
    beforeOperational.dedupeEntries,
    `${operationalKind} cannot consume learning dedupe capacity even when malformed as Unknown`,
  );
  assert.equal(restored.listFamilies().length, 1, `${operationalKind} cannot create a learning family`);
}
const stableServiceUnknown = {
  ...event('stable-service-unknown', start + 1_600),
  classificationSemantics: {
    ...event('stable-service-unknown', start + 1_600).classificationSemantics,
    workloadRole: 'platform_infrastructure',
    captureProfile: 'infrastructure_aggregate',
  },
  attribution: {
    ...event('stable-service-unknown', start + 1_600).attribution,
    workloadRole: 'platform_infrastructure',
  },
};
restored.observe(stableServiceUnknown);
assert.equal(
  restored.status().dedupeEntries,
  beforeOperational.dedupeEntries,
  'a stable Service role stays out of the Agent Unknown discovery pool without fabricating non-Agent identity',
);
assert.equal(restored.listFamilies().length, 1);

restored.setEnabled(false, { actor: 'operator', reason: 'kill switch test' });
const before = restored.status();
const skipped = restored.observe(event('runtime-event-2', start + 2_000));
assert.equal(skipped.skippedDisabledEvents, 1);
assert.equal(restored.status().activeClusters, before.activeClusters);
await restored.onModuleDestroy();
assert.equal(persisted.enabled, false, 'persisted kill switch remains off across restart');

const invalidJudge = {
  loadUnknownLearningState: async () => ({ ...persisted, authoritativeDrop: true }),
  saveUnknownLearningState: async () => true,
};
const invalid = new UnknownLearningRuntimeService(invalidJudge);
await invalid.onModuleInit();
assert.equal(invalid.status().restored, false);
assert.equal(invalid.status().enabled, false, 'an invalid persisted control document disables learning fail-closed');
assert.match(invalid.status().restoreError, /unknown field authoritativeDrop/u);
assert.equal(invalid.listPolicies().length, 0, 'invalid state restore is atomic and fail closed');
assert.deepEqual(invalid.listRecommendations(), [], 'invalid restore cannot emit a recommendation');

process.env.ANYSENTRY_UNKNOWN_LEARNING_ENABLED = 'false';
let offLoads = 0;
const deploymentOff = new UnknownLearningRuntimeService({
  loadUnknownLearningState: async () => { offLoads += 1; return persisted; },
  saveUnknownLearningState: async () => true,
});
await deploymentOff.onModuleInit();
assert.equal(offLoads, 0, 'deployment kill switch preserves the exact legacy startup path');
assert.equal(deploymentOff.status().configuredEnabled, false);
assert.throws(
  () => deploymentOff.setEnabled(true, { actor: 'operator', reason: 'must not bypass deployment' }),
  /deployment kill switch/u,
);

process.env.ANYSENTRY_UNKNOWN_LEARNING_ENABLED = 'true';
const batched = new UnknownLearningRuntimeService({
  loadUnknownLearningState: async () => undefined,
  saveUnknownLearningState: async () => true,
});
await batched.onModuleInit();
const batchedResult = batched.observeMany([
  event('batched-event-1', start + 2_100),
  event('batched-event-2', start + 2_200),
  { ...event('batched-aggregate', start + 2_300), eventKind: 'CaptureAggregate' },
]);
assert.equal(batchedResult.observedUnknownEvents, 2, 'one delivery is clustered as one bounded batch');
assert.equal(batchedResult.clusteredEvents, 2);
assert.equal(batched.status().dedupeEntries, 2);
await batched.onModuleDestroy();

const pendingSaves = [];
const savedSnapshots = [];
const concurrent = new UnknownLearningRuntimeService({
  loadUnknownLearningState: async () => undefined,
  saveUnknownLearningState: (state) => new Promise((resolve) => {
    savedSnapshots.push(structuredClone(state));
    pendingSaves.push(resolve);
  }),
});
await concurrent.onModuleInit();
concurrent.observe(event('concurrent-dirty-event', start + 3_000));
const concurrentFamily = concurrent.listFamilies()[0];
const closing = concurrent.onModuleDestroy();
await new Promise((resolve) => setImmediate(resolve));
assert.equal(pendingSaves.length, 1, 'shutdown begins persistence of the first immutable revision');
concurrent.reviewFamily({
  familyId: concurrentFamily.familyId,
  decision: 'non_agent',
  actor: 'operator-concurrent',
  reason: 'mutation while first snapshot is in flight',
  expectedRevision: 0,
});
pendingSaves.shift()(true);
await new Promise((resolve) => setImmediate(resolve));
assert.equal(pendingSaves.length, 1, 'shutdown drains a newer dirty revision after the first write');
assert.equal(savedSnapshots.at(-1).reviews.length, 1, 'the drained snapshot contains the concurrent mutation');
pendingSaves.shift()(true);
await closing;
assert.equal(concurrent.status().dirty, false);

console.log('S8 Unknown learning runtime persistence verification passed');
