import assert from 'node:assert/strict';

import {
  buildUnknownClusters,
  createUnknownPolicyCandidate,
  transitionUnknownPolicy,
} from '../apps/api/dist/security-monitoring/unknown-learning.js';

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
const events = Array.from({ length: 20 }, (_, index) => event(`event-${index}`, start + index * 1_000));
events.push(event('network-cluster', start + 2_000, {
  eventKind: 'Egress',
  eventCategory: 'network',
  attributes: { peer: '10.2.3.44' },
}));
events.push(event('missing-reason', start + 3_000, {
  classificationSemantics: {
    schemaVersion: 'anysentry.classification_semantics.v1',
    identityClassification: 'unknown', workloadRole: 'unknown', captureProfile: 'unknown_discovery',
  },
}));
events.push(event('known-agent', start + 4_000, {
  classificationSemantics: {
    schemaVersion: 'anysentry.classification_semantics.v1',
    identityClassification: 'confirmed_agent', workloadRole: 'agent', captureProfile: 'agent_full',
  },
  attribution: { monitored: true, classification: 'confirmed_agent', confidence: 1, reason: 'authoritative_anchor', source: 'process_graph' },
}));

const initial = buildUnknownClusters(events);
assert.equal(initial.observedUnknownEvents, 22);
assert.equal(initial.clusteredEvents, 21);
assert.equal(initial.rejectedWithoutReason, 1);
assert.equal(initial.clusters.length, 2);
const fileCluster = initial.clusters.find((cluster) => cluster.eventKind === 'FileAccess');
assert(fileCluster);
assert.equal(fileCluster.exactCount, 20);
assert.equal(fileCluster.countScope, 'retained_events');
assert.equal(fileCluster.firstSamples.length, 3);
assert.equal(fileCluster.reservoirSamples.length, 8);
assert.match(fileCluster.familyId, /^ufam_[a-f0-9]{24}$/u);
assert.equal(fileCluster.targetBucket, 'workspace:source:ext:source');
assert.deepEqual(fileCluster.metadataCompleteness, {
  processIdentity: true,
  processAncestry: true,
  workloadIdentity: true,
  containerIdentity: true,
});
const networkCluster = initial.clusters.find((cluster) => cluster.eventKind === 'Egress');
assert.match(networkCluster.targetBucket, /^network:private-10:shard:[a-f0-9]{2}$/u);

const reversed = buildUnknownClusters([...events].reverse());
assert.deepEqual(
  reversed.clusters.map((cluster) => ({
    id: cluster.clusterId,
    count: cluster.exactCount,
    first: cluster.firstSamples.map((item) => item.eventId),
    reservoir: cluster.reservoirSamples.map((item) => item.eventId),
  })),
  initial.clusters.map((cluster) => ({
    id: cluster.clusterId,
    count: cluster.exactCount,
    first: cluster.firstSamples.map((item) => item.eventId),
    reservoir: cluster.reservoirSamples.map((item) => item.eventId),
  })),
  'clustering and deterministic reservoir samples do not depend on ingest order',
);

const reviewed = buildUnknownClusters(events, { reviews: { [fileCluster.clusterId]: 'non_agent' } });
const reviewedFile = reviewed.clusters.find((cluster) => cluster.clusterId === fileCluster.clusterId);
assert.equal(reviewedFile.review, 'non_agent');
let policy = createUnknownPolicyCandidate({
  cluster: reviewedFile,
  desiredAction: 'aggregate',
  actor: 'operator-a',
  reason: 'reviewed service repetition',
  at: start + 30_000,
});
assert.equal(policy.stage, 'candidate');
assert.equal(policy.evidence.countScope, 'retained_events');
policy = transitionUnknownPolicy(policy, { to: 'shadow', actor: 'operator-a', reason: 'begin observation', at: start + 31_000 });
assert.throws(() => transitionUnknownPolicy(policy, {
  to: 'replay_validated', actor: 'operator-a', reason: 'bad replay', replayEvents: 20, replayAgentConflicts: 1, at: start + 32_000,
}), /Agent conflicts/u);
policy = transitionUnknownPolicy(policy, {
  to: 'replay_validated', actor: 'operator-a', reason: 'replay clean', replayEvents: 20, replayAgentConflicts: 0, at: start + 32_000,
});
assert.throws(() => transitionUnknownPolicy(policy, {
  to: 'canary', actor: 'operator-a', reason: 'unscoped canary', at: start + 33_000,
}), /exact node or physical workload/u);
policy = transitionUnknownPolicy(policy, {
  to: 'canary', actor: 'operator-a', reason: 'one workload canary',
  canaryScope: { kind: 'physical_workload', value: 'docker:workload-a' }, at: start + 33_000,
});
assert.throws(() => transitionUnknownPolicy(policy, {
  to: 'enforced', actor: 'operator-a', reason: 'bad recall', canaryEvents: 100, canaryAgentRecall: 0.99, canaryCriticalDrops: 0, at: start + 34_000,
}), /100%/u);
policy = transitionUnknownPolicy(policy, {
  to: 'enforced', actor: 'operator-a', reason: 'canary clean', canaryEvents: 100, canaryAgentRecall: 1, canaryCriticalDrops: 0, at: start + 34_000,
});
assert.equal(policy.stage, 'enforced');
policy = transitionUnknownPolicy(policy, { to: 'rolled_back', actor: 'operator-a', reason: 'operator rollback', at: start + 35_000 });
assert.equal(policy.stage, 'rolled_back');
assert.throws(() => transitionUnknownPolicy(policy, { to: 'shadow', actor: 'operator-a', reason: 'reactivate', at: start + 36_000 }), /cannot be reactivated/u);
assert.throws(() => createUnknownPolicyCandidate({
  cluster: fileCluster, desiredAction: 'sample', actor: 'operator-a', reason: 'not reviewed', at: start,
}), /human-reviewed non-Agent/u);

const bounded = buildUnknownClusters(events, { maxClusters: 1 });
assert.equal(bounded.truncated, true);
assert.equal(bounded.overflowEvents, 21 - bounded.clusteredEvents);

const nextWindow = buildUnknownClusters([
  event('next-window', start + 6 * 60_000),
]);
assert.equal(nextWindow.clusters[0].familyId, fileCluster.familyId, 'family identity is stable across time windows');
assert.notEqual(nextWindow.clusters[0].clusterId, fileCluster.clusterId, 'window identity is distinct');

const reversedBounded = buildUnknownClusters([...events].reverse(), { maxClusters: 1 });
assert.deepEqual(
  reversedBounded.clusters.map((cluster) => cluster.clusterId),
  bounded.clusters.map((cluster) => cluster.clusterId),
  'bounded cluster admission is deterministic for a batch',
);

const unsafeIdentity = buildUnknownClusters([event('identity-conflict', start, {
  attribution: {
    monitored: true,
    classification: 'confirmed_agent',
    physicalWorkloadId: 'docker:workload-a',
    confidence: 1,
    reason: 'authoritative_anchor',
    source: 'process_graph',
  },
})]);
assert.equal(unsafeIdentity.rejectedUnsafeIdentity, 1);
assert.equal(unsafeIdentity.clusteredEvents, 0);

for (const operationalKind of ['CaptureAggregate', 'SystemContext']) {
  const operational = buildUnknownClusters([event(`operational-${operationalKind}`, start, {
    eventKind: operationalKind,
    eventCategory: 'runtime',
  })]);
  assert.equal(operational.observedUnknownEvents, 0, `${operationalKind} is not Unknown learning input`);
  assert.equal(operational.clusteredEvents, 0, `${operationalKind} cannot become an Other family`);
}

const noScope = buildUnknownClusters([event('no-scope', start, {
  process: undefined,
  attribution: { monitored: false, classification: 'unknown', confidence: 0, reason: 'not_evaluated', source: 'none' },
})]);
assert.equal(noScope.rejectedWithoutStableScope, 1);

assert.throws(() => createUnknownPolicyCandidate({
  cluster: reviewedFile,
  desiredAction: 'drop',
  actor: 'operator-a',
  reason: 'unsafe runtime forgery',
  at: start,
}), /authoritative DROP is forbidden/u);

const forgedPolicy = { ...policy, stage: 'enforced', authority: 'authoritative', authoritativeDrop: true };
assert.throws(() => transitionUnknownPolicy(forgedPolicy, {
  to: 'rolled_back', actor: 'operator-a', reason: 'reject unsafe imported state', at: start + 37_000,
}), /invalid or unsafe Unknown policy state/u);

const highCardinality = Array.from({ length: 10_001 }, (_, index) => event(`cardinality-${index}`, start, {
  attribution: {
    monitored: false,
    classification: 'unknown',
    physicalWorkloadId: `docker:untrusted-${index}`,
    confidence: 0,
    reason: 'not_evaluated',
    source: 'none',
  },
}));
const nanBound = buildUnknownClusters(highCardinality, { maxClusters: Number.NaN });
assert.equal(nanBound.clusters.length, 10_000, 'NaN cannot bypass the default cluster bound');
assert.equal(nanBound.overflowEvents, 1);
assert.throws(() => buildUnknownClusters(events, { maxEvents: 1 }), /batch exceeds 1 events/u);

console.log('S8 Unknown clustering and guarded policy workflow verification passed');
