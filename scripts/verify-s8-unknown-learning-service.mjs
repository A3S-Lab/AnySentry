import assert from 'node:assert/strict';

import { UnknownLearningService } from '../apps/api/dist/security-monitoring/unknown-learning.service.js';

function event(id, at, overrides = {}) {
  return {
    schemaVersion: 'anysentry.agent_event.v1',
    eventId: id,
    at,
    eventKind: 'FileAccess',
    eventCategory: 'file',
    source: 'observer',
    subject: 'unknown file evidence',
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
    attributes: { path: '/workspace/src/index.ts' },
    classificationSemantics: {
      schemaVersion: 'anysentry.classification_semantics.v1',
      identityClassification: 'unknown',
      workloadRole: 'unknown',
      captureProfile: 'unknown_discovery',
      unknownReason: 'signature_miss',
    },
    process: {
      hostId: 'host-a', bootId: 'boot-a', pid: 42, ppid: 1, startTimeTicks: '9001', comm: 'node', exe: '/usr/bin/node',
    },
    attribution: {
      monitored: false,
      classification: 'unknown',
      physicalWorkloadId: 'docker:workload-a',
      workloadRef: { environment: 'docker', kind: 'container', containerName: 'service-a' },
      confidence: 0,
      reason: 'not_evaluated',
      source: 'none',
    },
    ...overrides,
  };
}

const start = 1_775_000_000_000;
const exactOnce = new UnknownLearningService({ windowMs: 60_000, maxFutureSkewMs: 60_000 });
let exactOnceResult = exactOnce.ingest([event('exactly-once', start)], start + 1);
assert.equal(exactOnceResult.clusteredEvents, 1);
assert.equal(exactOnce.listClusters()[0].exactCount, 1, 'one new event increments the exact count once');
exactOnceResult = exactOnce.ingest([event('exactly-once', start)], start + 2);
assert.equal(exactOnceResult.duplicateEvents, 1);
assert.equal(exactOnceResult.clusteredEvents, 0);
assert.equal(exactOnce.listClusters()[0].exactCount, 1, 'duplicate replay does not increment the exact count');

const protectedDedupe = new UnknownLearningService({
  windowMs: 60_000, maxDedupeEntries: 1, maxFutureSkewMs: 60_000,
});
const knownAgent = event('known-agent-must-not-consume-dedupe', start, {
  classificationSemantics: {
    schemaVersion: 'anysentry.classification_semantics.v1',
    identityClassification: 'confirmed_agent', workloadRole: 'agent', captureProfile: 'agent_full',
  },
  attribution: {
    monitored: true, classification: 'confirmed_agent', confidence: 1,
    reason: 'authoritative_anchor', source: 'process_graph',
  },
});
protectedDedupe.ingest([knownAgent], start + 1);
assert.equal(protectedDedupe.status().dedupeEntries, 0, 'Agent events cannot consume Unknown dedupe capacity');
assert.equal(protectedDedupe.ingest([event('real-unknown-after-agent', start + 2)], start + 3).clusteredEvents, 1);
assert.equal(protectedDedupe.status().dedupeEntries, 1);

const service = new UnknownLearningService({
  windowMs: 60_000,
  retentionWindows: 4,
  maxClusters: 4,
  maxFamilies: 2,
  maxReviews: 2,
  maxPolicies: 3,
  maxDedupeEntries: 100,
  maxIngestBatch: 100,
  maxFutureSkewMs: 60_000,
  firstSamples: 2,
  reservoirSamples: 3,
});

const firstBatch = Array.from({ length: 8 }, (_, index) => event(`first-${index}`, start + index));
let ingest = service.ingest(firstBatch, start + 10_000);
assert.equal(ingest.clusteredEvents, 8);
assert.equal(ingest.activeClusters, 1);
assert.equal(ingest.degraded, false);

const secondBatchEvents = [
  event('second-a', start + 20_000),
  event('second-b', start + 20_001),
  event('second-a', start + 20_000),
];
ingest = service.ingest(secondBatchEvents, start + 30_000);
assert.equal(ingest.clusteredEvents, 2);
assert.equal(ingest.duplicateEvents, 1);
let family = service.listFamilies()[0];
assert.equal(family.countScope, 'retained_events');
assert.equal(family.exactCount, 10);
assert.equal(family.historicalWindows, 1);
assert.equal(family.clusters[0].firstSamples.length, 2);
assert.equal(family.clusters[0].reservoirSamples.length, 3);
const oneShot = new UnknownLearningService({
  windowMs: 60_000,
  maxFutureSkewMs: 60_000,
  firstSamples: 2,
  reservoirSamples: 3,
});
oneShot.ingest([...firstBatch, ...secondBatchEvents], start + 30_000);
assert.deepEqual(
  {
    first: oneShot.listClusters()[0].firstSamples.map((sample) => sample.eventId),
    reservoir: oneShot.listClusters()[0].reservoirSamples.map((sample) => sample.eventId),
  },
  {
    first: family.clusters[0].firstSamples.map((sample) => sample.eventId),
    reservoir: family.clusters[0].reservoirSamples.map((sample) => sample.eventId),
  },
  'incremental and one-shot clustering choose the same deterministic samples',
);

const familyId = family.familyId;
const externalFamilyView = service.listFamilies();
externalFamilyView[0].clusters[0].exactCount = 0;
assert.equal(service.listFamilies()[0].exactCount, 10, 'read APIs cannot mutate service state');

ingest = service.ingest([
  event('window-two-a', start + 61_000),
  event('window-two-b', start + 61_001),
], start + 62_000);
assert.equal(ingest.clusteredEvents, 2);
family = service.listFamilies().find((item) => item.familyId === familyId);
assert(family);
assert.equal(family.historicalWindows, 2);
assert.equal(family.exactCount, 12);
assert.notEqual(family.clusters[0].clusterId, family.clusters[1].clusterId);

const otherScope = (id, at, workload) => event(id, at, {
  attribution: {
    monitored: false,
    classification: 'unknown',
    physicalWorkloadId: workload,
    confidence: 0,
    reason: 'not_evaluated',
    source: 'none',
  },
});
ingest = service.ingest([
  otherScope('family-b', start + 62_100, 'docker:workload-b'),
  otherScope('family-c', start + 62_200, 'docker:workload-c'),
], start + 63_000);
assert.equal(ingest.clusteredEvents, 1);
assert.equal(ingest.overflowEvents, 1);
assert.equal(ingest.activeFamilies, 2);
assert.equal(ingest.degraded, true);

ingest = service.ingest([event('future', start + 200_000)], start + 64_000);
assert.equal(ingest.rejectedFutureEvent, 1);
assert.equal(ingest.clusteredEvents, 0);

let review = service.reviewFamily({
  familyId,
  decision: 'non_agent',
  actor: 'operator-a',
  reason: 'repeated business service file access',
  expectedRevision: 0,
  at: start + 70_000,
});
assert.equal(review.revision, 1);
assert.equal(service.listFamilies().find((item) => item.familyId === familyId).review, 'non_agent');
assert.throws(() => service.reviewFamily({
  familyId,
  decision: 'deferred',
  actor: 'stale-operator',
  reason: 'stale concurrent review',
  expectedRevision: 0,
  at: start + 70_001,
}), /review revision conflict/u);

assert.throws(() => service.createCandidate({
  familyId,
  desiredAction: 'drop',
  actor: 'operator-a',
  reason: 'unsafe action',
  at: start + 71_000,
}), /authoritative DROP is forbidden/u);

let policy = service.createCandidate({
  familyId,
  desiredAction: 'aggregate',
  actor: 'operator-a',
  reason: 'reviewed repetitive non-Agent family',
  at: start + 71_000,
});
assert.equal(policy.evidence.historicalWindows, 2);
assert.equal(policy.evidence.clusterCount, 12);
assert.equal(policy.evidence.countScope, 'retained_events');
assert.equal(policy.authority, 'recommendation_only');
assert.equal(policy.authoritativeDrop, false);

policy.stage = 'enforced';
assert.equal(service.getPolicy(policy.policyId).stage, 'candidate', 'policy reads are immutable copies');
policy = service.getPolicy(policy.policyId);
assert.throws(() => service.beginShadow(policy.policyId, policy.revision + 1, {
  actor: 'operator-a', reason: 'stale client', at: start + 72_000,
}), /revision conflict/u);
policy = service.beginShadow(policy.policyId, policy.revision, {
  actor: 'operator-a', reason: 'observe desired decisions only', at: start + 72_000,
});
assert.throws(() => service.validateReplay(policy.policyId, policy.revision, {
  actor: 'operator-a', reason: 'conflicting replay', replayEvents: 100, replayAgentConflicts: 1, at: start + 73_000,
}), /Agent conflicts/u);
assert.equal(service.getPolicy(policy.policyId).stage, 'shadow');
policy = service.validateReplay(policy.policyId, policy.revision, {
  actor: 'operator-a', reason: 'clean historical replay', replayEvents: 100, replayAgentConflicts: 0, at: start + 73_000,
});
policy = service.beginCanary(policy.policyId, policy.revision, {
  actor: 'operator-a',
  reason: 'one workload only',
  scope: { kind: 'physical_workload', value: 'docker:workload-a' },
  at: start + 74_000,
});
assert.equal(policy.evidence.canaryScope.kind, 'physical_workload');
assert.match(policy.evidence.canaryScope.valueHash, /^[a-f0-9]{32}$/u);
assert.equal(JSON.stringify(policy).includes('docker:workload-a'), false, 'raw canary scope is not retained');
assert.throws(() => service.enforceRecommendation(policy.policyId, policy.revision, {
  actor: 'operator-a', reason: 'bad Agent recall', canaryEvents: 100, canaryAgentRecall: 0.99, canaryCriticalDrops: 0, at: start + 75_000,
}), /exactly 100%/u);
policy = service.enforceRecommendation(policy.policyId, policy.revision, {
  actor: 'operator-a', reason: 'clean scoped canary', canaryEvents: 100, canaryAgentRecall: 1, canaryCriticalDrops: 0, at: start + 75_000,
});
assert.equal(policy.stage, 'enforced');
assert.deepEqual(service.listRecommendations(), [{
  policyId: policy.policyId,
  revision: policy.revision,
  familyId,
  action: 'aggregate',
  authority: 'recommendation_only',
  authoritativeDrop: false,
  eligibleForCentralReview: true,
}]);

review = service.reviewFamily({
  familyId,
  decision: 'agent',
  actor: 'operator-b',
  reason: 'new trusted Agent evidence supersedes the old review',
  expectedRevision: 1,
  at: start + 76_000,
});
assert.equal(review.revision, 2);
assert.equal(service.getPolicy(policy.policyId).stage, 'rolled_back', 'Agent review revokes an active recommendation');
assert.deepEqual(service.listRecommendations(), []);

const boundedDedupe = new UnknownLearningService({
  windowMs: 60_000,
  retentionWindows: 2,
  maxDedupeEntries: 2,
  maxIngestBatch: 10,
  maxFutureSkewMs: 60_000,
});
ingest = boundedDedupe.ingest([
  event('dedupe-a', start),
  event('dedupe-b', start + 1),
  event('dedupe-c', start + 2),
], start + 10);
assert.equal(ingest.clusteredEvents, 2);
assert.equal(ingest.rejectedDedupeCapacity, 1);
assert.equal(ingest.degraded, true);
assert.equal(boundedDedupe.status().dedupeEntries, 2);
ingest = boundedDedupe.ingest([event('dedupe-new-window', start + 3 * 60_000)], start + 3 * 60_000);
assert.equal(ingest.rejectedDedupeCapacity, 0, 'event-time pruning recovers a saturated dedupe table');
assert.equal(ingest.clusteredEvents, 1);
assert(boundedDedupe.status().activeClusters <= 2, 'retention keeps incremental cluster memory bounded');

const killSwitch = new UnknownLearningService({ windowMs: 60_000, maxFutureSkewMs: 60_000 });
killSwitch.ingest([event('kill-switch-family', start)], start + 1);
const killFamily = killSwitch.listFamilies()[0];
killSwitch.reviewFamily({
  familyId: killFamily.familyId,
  decision: 'non_agent',
  actor: 'operator-a',
  reason: 'review',
  expectedRevision: 0,
  at: start + 2,
});
const killPolicy = killSwitch.createCandidate({
  familyId: killFamily.familyId, desiredAction: 'sample', actor: 'operator-a', reason: 'candidate', at: start + 3,
});
const disabled = killSwitch.setEnabled(false, { actor: 'operator-a', reason: 'emergency stop', at: start + 4 });
assert.equal(disabled.enabled, false);
assert.equal(disabled.activePolicies, 0);
assert.equal(killSwitch.getPolicy(killPolicy.policyId).stage, 'rolled_back');
assert.deepEqual(killSwitch.listRecommendations(), []);
const disabledState = killSwitch.status();
const disabledClusters = killSwitch.listClusters();
const disabledIngest = killSwitch.ingest([event('must-not-grow-disabled-state', start + 10_000)], start + 10_001);
assert.equal(disabledIngest.skippedDisabledEvents, 1);
assert.equal(disabledIngest.clusteredEvents, 0);
assert.deepEqual(killSwitch.status(), disabledState, 'disabled ingest cannot advance any learning state');
assert.deepEqual(killSwitch.listClusters(), disabledClusters, 'disabled ingest preserves existing evidence read-only');
assert.throws(() => killSwitch.reviewFamily({
  familyId: killFamily.familyId,
  decision: 'deferred',
  actor: 'operator-a',
  reason: 'blocked mutation',
  expectedRevision: 1,
  at: start + 5,
}), /workflow is disabled/u);
assert.throws(() => killSwitch.createCandidate({
  familyId: killFamily.familyId, desiredAction: 'keep', actor: 'operator-a', reason: 'blocked', at: start + 5,
}), /workflow is disabled/u);

const persisted = new UnknownLearningService({
  windowMs: 60_000,
  retentionWindows: 4,
  firstSamples: 2,
  reservoirSamples: 3,
  maxFutureSkewMs: 60_000,
});
persisted.ingest([event('persisted-event', start)], start + 1);
const persistedFamily = persisted.listFamilies()[0];
persisted.reviewFamily({
  familyId: persistedFamily.familyId,
  decision: 'non_agent',
  actor: 'operator-persistence',
  reason: 'stable reviewed family',
  expectedRevision: 0,
  at: start + 2,
});
let persistedPolicy = persisted.createCandidate({
  familyId: persistedFamily.familyId,
  desiredAction: 'aggregate',
  actor: 'operator-persistence',
  reason: 'persist the guarded workflow',
  at: start + 3,
});
persistedPolicy = persisted.beginShadow(persistedPolicy.policyId, persistedPolicy.revision, {
  actor: 'operator-persistence', reason: 'persisted shadow', at: start + 4,
});
const exported = persisted.exportState(start + 5);
assert.equal(exported.schemaVersion, 'anysentry.unknown_learning_state.v1');
assert.equal(exported.dedupe.semantics, 'bounded_sha256_event_ids_within_retained_event_time');
assert.equal(JSON.stringify(exported).includes('persisted-event'), true, 'sample evidence may retain its bounded event ID');
assert(exported.dedupe.entries.every((entry) => /^[a-f0-9]{64}$/u.test(entry.eventIdHash)), 'dedupe persists hashes only');

const restored = new UnknownLearningService({
  windowMs: 60_000,
  retentionWindows: 4,
  firstSamples: 2,
  reservoirSamples: 3,
  maxFutureSkewMs: 60_000,
});
let restore = restored.restoreState(JSON.stringify(exported));
assert.deepEqual(restore.pruned, {
  expiredClusters: 0,
  capacityClusters: 0,
  reviews: 0,
  policies: 0,
  dedupeEntries: 0,
});
assert.equal(restored.listClusters()[0].exactCount, 1);
assert.equal(restored.listFamilies()[0].review, 'non_agent');
assert.equal(restored.getPolicy(persistedPolicy.policyId).stage, 'shadow');
assert.equal(restored.getPolicy(persistedPolicy.policyId).evidence.reviewRevision, 1);
let restoredIngest = restored.ingest([event('persisted-event', start)], start + 6);
assert.equal(restoredIngest.duplicateEvents, 1);
assert.equal(restored.listClusters()[0].exactCount, 1, 'restart dedupe prevents fixed-window count inflation');
restoredIngest = restored.ingest([event('persisted-event-new', start + 7)], start + 8);
assert.equal(restoredIngest.clusteredEvents, 1);
assert.equal(restored.listClusters()[0].exactCount, 2, 'fixed-window exact count resumes from restored state');
const locallyDisabledRestore = new UnknownLearningService({
  enabled: false,
  windowMs: 60_000,
  retentionWindows: 4,
  firstSamples: 2,
  reservoirSamples: 3,
  maxFutureSkewMs: 60_000,
});
const locallyDisabledResult = locallyDisabledRestore.restoreState(exported);
assert.equal(locallyDisabledResult.status.enabled, false, 'restore cannot override a local kill switch');
assert.equal(locallyDisabledResult.status.activePolicies, 0);
assert.equal(locallyDisabledResult.pruned.policies, 1, 'active recommendations are discarded fail-closed');

const disabledExport = killSwitch.exportState(start + 6);
const disabledRestore = new UnknownLearningService({ windowMs: 60_000, maxFutureSkewMs: 60_000 });
restore = disabledRestore.restoreState(disabledExport);
assert.equal(restore.status.enabled, false, 'a persisted kill switch never auto-restarts');
const disabledRestoredState = disabledRestore.status();
assert.equal(disabledRestore.ingest([event('disabled-after-restart', start + 20_000)], start + 20_001).skippedDisabledEvents, 1);
assert.deepEqual(disabledRestore.status(), disabledRestoredState);

const maliciousTarget = new UnknownLearningService({
  windowMs: 60_000,
  retentionWindows: 4,
  firstSamples: 2,
  reservoirSamples: 3,
  maxFutureSkewMs: 60_000,
});
maliciousTarget.ingest([event('atomic-sentinel', start)], start + 1);
const sentinelState = maliciousTarget.exportState(start + 2);
const authoritativeForgery = structuredClone(exported);
authoritativeForgery.policies[0].authoritativeDrop = true;
assert.throws(() => maliciousTarget.restoreState(authoritativeForgery), /invalid or unsafe Unknown policy state/u);
assert.deepEqual(maliciousTarget.exportState(start + 2), sentinelState, 'failed restore is atomic');
const illegalStage = structuredClone(exported);
illegalStage.policies[0].stage = 'authoritative';
assert.throws(() => maliciousTarget.restoreState(illegalStage), /invalid or unsafe Unknown policy state/u);
const openSchemaForgery = structuredClone(exported);
openSchemaForgery.unexpectedAuthority = 'drop';
assert.throws(() => maliciousTarget.restoreState(openSchemaForgery), /unknown field unexpectedAuthority/u);
const nestedOpenSchemaForgery = structuredClone(exported);
nestedOpenSchemaForgery.policies[0].evidence.unexpected = 1;
assert.throws(() => maliciousTarget.restoreState(nestedOpenSchemaForgery), /unknown field unexpected/u);

const capacitySource = new UnknownLearningService({
  windowMs: 60_000,
  retentionWindows: 4,
  maxClusters: 3,
  maxFamilies: 3,
  maxReviews: 3,
  maxPolicies: 3,
  maxDedupeEntries: 3,
  maxFutureSkewMs: 60_000,
});
capacitySource.ingest([
  otherScope('capacity-a', start, 'docker:capacity-a'),
  otherScope('capacity-b', start + 1, 'docker:capacity-b'),
  otherScope('capacity-c', start + 2, 'docker:capacity-c'),
], start + 3);
const capacityFamilies = capacitySource.listFamilies();
for (let index = 0; index < 2; index += 1) {
  capacitySource.reviewFamily({
    familyId: capacityFamilies[index].familyId,
    decision: 'non_agent',
    actor: 'capacity-reviewer',
    reason: `capacity review ${index}`,
    expectedRevision: 0,
    at: start + 4 + index,
  });
  capacitySource.createCandidate({
    familyId: capacityFamilies[index].familyId,
    desiredAction: 'sample',
    actor: 'capacity-reviewer',
    reason: `capacity candidate ${index}`,
    at: start + 6 + index,
  });
}
const overCapacityState = capacitySource.exportState(start + 10);
const capacityRestore = new UnknownLearningService({
  windowMs: 60_000,
  retentionWindows: 4,
  maxClusters: 1,
  maxFamilies: 1,
  maxReviews: 1,
  maxPolicies: 1,
  maxDedupeEntries: 1,
  maxFutureSkewMs: 60_000,
});
restore = capacityRestore.restoreState(overCapacityState);
assert.equal(restore.status.activeClusters, 1);
assert.equal(restore.status.activeFamilies, 1);
assert.equal(restore.status.dedupeEntries, 1);
assert.equal(restore.status.reviews, 1);
assert.equal(restore.status.policies, 1);
assert.equal(restore.status.activePolicies, 1);
assert.equal(restore.pruned.capacityClusters, 2);
assert.equal(restore.pruned.reviews, 1);
assert.equal(restore.pruned.policies, 1);
assert.equal(restore.pruned.dedupeEntries, 2);

console.log('S8 bounded Unknown learning service verification passed');
