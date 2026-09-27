#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  buildLatestRevisionQuery,
  buildUnknownLearningReport,
  latestRevisionRows,
  parseQueryOutput,
  pathBucket,
} from './unknown-learning-report.mjs';

function event({
  eventId,
  revision = 1,
  updatedAt = revision,
  classification = 'unknown',
  repeatCount = 1,
  eventKind = 'FileAccess',
  node = 'node-a',
  cgroupId = '100',
  physicalWorkloadId = '',
  workloadRef = {},
  attributes = {},
  comm = 'worker',
  exe = '/usr/bin/worker',
}) {
  return {
    eventId,
    at: 1_700_000_000_000 + updatedAt,
    ingestedAt: 1_700_000_100_000 + updatedAt,
    decisionRevision: revision,
    decisionUpdatedAt: 1_700_000_000_000 + updatedAt,
    eventKind,
    collectorId: `${node}-collector`,
    attributes: JSON.stringify({ repeatCount, ...attributes }),
    process: JSON.stringify({ hostId: node, cgroupId, comm, exe }),
    attribution: JSON.stringify({
      classification,
      physicalWorkloadId: physicalWorkloadId || undefined,
      workloadRef,
    }),
    judgment: JSON.stringify({ classification }),
  };
}

const k8sRef = (pod, node) => ({
  environment: 'kubernetes',
  namespace: 'anysentry',
  ownerKind: 'StatefulSet',
  ownerName: 'clickhouse',
  containerName: 'clickhouse',
  containerImage: 'clickhouse@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  podUid: pod,
  nodeName: node,
});

const dockerAttributes = {
  composeProject: 'anysentry',
  composeService: 'redis',
  containerImage: 'redis@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
};

const rows = [
  event({ eventId: 'known-agent', classification: 'confirmed_agent', repeatCount: 20 }),
  event({
    eventId: 'k1', revision: 1, updatedAt: 1, repeatCount: 1, node: 'node-a', cgroupId: '101',
    physicalWorkloadId: 'k8s:prod-a:pod-a:container-a', workloadRef: k8sRef('pod-a', 'node-a'),
    attributes: { path: '/var/lib/clickhouse/tmp/old-part' }, comm: 'clickhouse', exe: '/usr/bin/clickhouse',
  }),
  event({
    eventId: 'k1', revision: 2, updatedAt: 2, repeatCount: 10, node: 'node-a', cgroupId: '101',
    physicalWorkloadId: 'k8s:prod-a:pod-a:container-a', workloadRef: k8sRef('pod-a', 'node-a'),
    attributes: { path: '/var/lib/clickhouse/store/new-part' }, comm: 'clickhouse', exe: '/usr/bin/clickhouse',
  }),
  event({
    eventId: 'k2', repeatCount: 5, node: 'node-b', cgroupId: '201',
    physicalWorkloadId: 'k8s:prod-a:pod-b:container-b', workloadRef: k8sRef('pod-b', 'node-b'),
    attributes: { path: '/var/lib/clickhouse/store/part-b' }, comm: 'clickhouse', exe: '/usr/bin/clickhouse',
  }),
  event({
    eventId: 'd1', repeatCount: 3, node: 'node-a', cgroupId: '301',
    physicalWorkloadId: 'docker:node-a:redis-a', workloadRef: { environment: 'docker', containerName: 'redis' },
    attributes: { ...dockerAttributes, path: '/var/lib/docker/volumes/redis-a/data' }, comm: 'redis-server', exe: '/usr/bin/redis-server',
  }),
  event({
    eventId: 'd2', repeatCount: 2, node: 'node-a', cgroupId: '302',
    physicalWorkloadId: 'docker:node-a:redis-b', workloadRef: { environment: 'docker', containerName: 'redis' },
    attributes: { ...dockerAttributes, path: '/var/lib/docker/volumes/redis-b/data' }, comm: 'redis-server', exe: '/usr/bin/redis-server',
  }),
  event({
    eventId: 'missing-physical', repeatCount: 4, node: 'node-c', cgroupId: '401',
    attributes: { path: '/tmp/unknown-output' }, comm: 'mystery', exe: '/opt/mystery',
  }),
  event({
    eventId: 'single-k8s', repeatCount: 6, node: 'node-a', cgroupId: '501',
    physicalWorkloadId: 'k8s:prod-a:api-pod:api-container',
    workloadRef: {
      environment: 'kubernetes', namespace: 'anysentry', ownerKind: 'Deployment', ownerName: 'api',
      containerName: 'api', podUid: 'api-pod', nodeName: 'node-a', containerImage: 'api:latest',
    },
    attributes: { path: '/workspace/cache/item' }, comm: 'node', exe: '/usr/bin/node',
  }),
  event({
    eventId: 'same-instance-a', node: 'node-a', cgroupId: '601', repeatCount: 1,
    physicalWorkloadId: 'docker:node-a:one-container',
    workloadRef: { environment: 'docker', containerName: 'one' },
    attributes: { composeProject: 'single', composeService: 'worker', path: '/run/a' },
  }),
  event({
    eventId: 'same-instance-b', node: 'node-a', cgroupId: '601', repeatCount: 1,
    physicalWorkloadId: 'docker:node-a:one-container',
    workloadRef: { environment: 'docker', containerName: 'one' },
    attributes: { composeProject: 'single', composeService: 'worker', path: '/run/b' },
  }),
];

assert.equal(latestRevisionRows(rows).length, 9, 'latest revision fold must keep one row per eventId');
assert.equal(latestRevisionRows(rows).find((row) => row.eventId === 'k1').decisionRevision, 2);
assert.equal(pathBucket('/var/lib/clickhouse/store/part'), '/var/lib/clickhouse');
assert.equal(pathBucket('/tmp/example'), '/tmp');
assert.equal(pathBucket('relative.txt'), 'relative-or-opaque');

const report = buildUnknownLearningReport(rows);
assert.equal(report.before.totalEvents, 9);
assert.equal(report.before.totalWeightedEvents, 52);
assert.equal(report.before.unknownEvents, 8);
assert.equal(report.before.unknownWeightedEvents, 32);
assert.equal(report.before.unknownEventRatio, 0.888889);
assert.equal(report.before.unknownWeightedRatio, 0.615385);
assert.equal(report.after.suggestedUnknownEvents, 4);
assert.equal(report.after.suggestedUnknownWeightedEvents, 20);
assert.equal(report.after.remainingUnknownEvents, 4);
assert.equal(report.after.remainingUnknownWeightedEvents, 12);
assert.equal(report.after.projectedUnknownEventRatio, 0.444444);
assert.equal(report.after.projectedUnknownWeightedRatio, 0.230769);
assert.equal(report.after.projectedUnknownEventReductionRatio, 0.5);
assert.equal(report.after.projectedUnknownWeightedReductionRatio, 0.625);

assert.equal(report.candidateSuggestions.length, 2);
const [kubernetes, docker] = report.candidateSuggestions;
assert.equal(kubernetes.selector.placement, 'kubernetes');
assert.deepEqual(kubernetes.selector, {
  placement: 'kubernetes',
  clusterId: 'prod-a',
  namespace: 'anysentry',
  ownerKind: 'StatefulSet',
  ownerName: 'clickhouse',
  containerName: 'clickhouse',
  imageDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
});
assert.equal(kubernetes.evidence.weightedEvents, 15);
assert.equal(kubernetes.evidence.distinctNodes, 2);
assert.equal(docker.selector.placement, 'docker');
assert.equal(docker.selector.composeProject, 'anysentry');
assert.equal(docker.selector.serviceName, 'redis');
assert.equal(docker.evidence.distinctPhysicalWorkloads, 2);

for (const suggestion of report.candidateSuggestions) {
  assert.equal(suggestion.authority, 'candidate');
  assert.equal(suggestion.lifecycleStage, 'draft');
  assert.equal(suggestion.proposedFilterAction, 'sample');
  assert.equal(suggestion.source.type, 'behavior_discovery');
  assert.equal('comm' in suggestion.selector, false);
  assert.equal('exe' in suggestion.selector, false);
  assert.equal('path' in suggestion.selector, false);
}
const suggestionJson = JSON.stringify(report.candidateSuggestions);
assert.equal(suggestionJson.includes('"authoritative"'), false);
assert.equal(suggestionJson.includes('"drop"'), false);

assert.ok(report.reviewClusters.some((cluster) => cluster.reason === 'missing_physical_identity'));
assert.ok(report.reviewClusters.some((cluster) => cluster.reason === 'single_node_single_instance'));
assert.equal(report.candidateSuggestions.some((suggestion) => suggestion.selector.composeProject === 'single'), false);
assert.equal(report.dimensions.eventKind[0].weightedEvents, 32);
assert.equal(report.dimensions.pathBucket[0].pathBucket, '/var/lib/clickhouse');
assert.equal(report.dimensions.pathBucket[0].weightedEvents, 15);

const query = buildLatestRevisionQuery({
  database: 'anysentry',
  table: 'events',
  sinceMs: 1_700_000_000_000,
  limit: 123,
});
assert.match(query, /ORDER BY eventId ASC, decisionRevision DESC, decisionUpdatedAt DESC, ingestedAt DESC/u);
assert.match(query, /LIMIT 1 BY eventId/u);
assert.match(query, /LIMIT 123\s+FORMAT JSONEachRow/u);
assert.throws(() => buildLatestRevisionQuery({ database: 'bad-name', table: 'events' }), /plain identifiers/u);

assert.deepEqual(parseQueryOutput('{"eventId":"a"}\n{"eventId":"b"}\n'), [
  { eventId: 'a' },
  { eventId: 'b' },
]);
assert.deepEqual(parseQueryOutput(JSON.stringify({ data: [{ eventId: 'c' }] })), [{ eventId: 'c' }]);

console.log('Unknown learning report verification passed');
