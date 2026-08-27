#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  INFRASTRUCTURE_RULES_SCHEMA,
  InfrastructureRuleSet,
  materializeCgroupFilterDecision,
  validateInfrastructureRuleDocument,
} = require('./observer-infrastructure-rules.js');

const createdAt = '2026-08-17T00:00:00.000Z';
const updatedAt = '2026-08-17T01:00:00.000Z';
const expiresAt = '2026-08-18T00:00:00.000Z';
const now = Date.parse('2026-08-17T12:00:00.000Z');

function audit(component) {
  return {
    createdBy: 'anysentry-platform-inventory',
    changeReason: `Known AnySentry test infrastructure: ${component}`,
    evidenceRefs: [`fixture:${component}`],
    ticketId: 'infrastructure-rules-v1',
  };
}

function dockerRule(id, composeService) {
  return {
    id,
    revision: 1,
    role: 'infrastructure',
    authority: 'authoritative',
    stage: 'enforce',
    selector: {
      type: 'docker',
      hostGroup: 'anysentry-dev',
      composeProject: 'anysentry',
      composeService,
    },
    eventPolicy: {
      FileAccess: 'drop',
      FileDelete: 'drop',
      Egress: 'drop',
      default: 'drop',
    },
    source: 'platform_inventory',
    reasonCode: 'known_anysentry_infrastructure',
    createdAt,
    updatedAt,
    expiresAt,
    audit: audit(composeService),
  };
}

function hostRule(id, systemdUnit, executable) {
  return {
    id,
    revision: 1,
    role: 'infrastructure',
    authority: 'authoritative',
    stage: 'enforce',
    selector: {
      type: 'host',
      hostGroup: 'anysentry-dev',
      systemdUnit,
      ...(executable ? { executable } : {}),
    },
    eventPolicy: { FileAccess: 'drop', FileDelete: 'drop', default: 'drop' },
    source: 'platform_inventory',
    reasonCode: 'known_host_infrastructure',
    createdAt,
    updatedAt,
    expiresAt,
    audit: audit(systemdUnit),
  };
}

const document = {
  schemaVersion: INFRASTRUCTURE_RULES_SCHEMA,
  version: 7,
  generatedAt: '2026-08-17T01:00:00.000Z',
  rules: [
    dockerRule('docker-clickhouse', 'clickhouse'),
    dockerRule('docker-kafka', 'kafka'),
    dockerRule('docker-redis', 'redis'),
    dockerRule('docker-flink-jobmanager', 'flink-jobmanager'),
    dockerRule('docker-anysentry-api', 'anysentry'),
    hostRule('host-docker-daemon', 'docker.service', '/usr/bin/dockerd'),
    hostRule('host-kubelet', 'kubelet.service', '/usr/bin/kubelet'),
    hostRule('host-k3s', 'k3s.service', '/usr/local/bin/k3s'),
    {
      id: 'k8s-coredns',
      revision: 1,
      role: 'infrastructure',
      authority: 'authoritative',
      stage: 'enforce',
      selector: {
        type: 'kubernetes',
        clusterId: 'default-cluster',
        namespace: 'kube-system',
        ownerKind: 'Deployment',
        ownerName: 'coredns',
        containerName: 'coredns',
      },
      eventPolicy: { FileAccess: 'drop', FileDelete: 'drop', Dns: 'drop', default: 'drop' },
      source: 'kubernetes',
      reasonCode: 'known_cluster_infrastructure',
      createdAt,
      updatedAt,
      expiresAt,
      audit: audit('coredns'),
    },
  ],
};

const ruleSet = new InfrastructureRuleSet(document);
assert.equal(ruleSet.snapshot().version, 7);
assert.equal(ruleSet.snapshot().schemaVersion, INFRASTRUCTURE_RULES_SCHEMA);
assert.equal('expiresAtMs' in ruleSet.snapshot().rules[0], false);

const dockerFixtures = [
  ['ClickHouse', 'clickhouse', '2001'],
  ['Kafka', 'kafka', '2002'],
  ['Redis', 'redis', '2003'],
  ['Flink', 'flink-jobmanager', '2004'],
  ['AnySentry', 'anysentry', '2005'],
];

for (const [component, composeService, cgroupId] of dockerFixtures) {
  const facts = {
    type: 'docker',
    hostGroup: 'anysentry-dev',
    labels: {
      'com.docker.compose.project': 'anysentry',
      'com.docker.compose.service': composeService,
    },
    physicalWorkloadId: `docker:host-a:${component.toLowerCase()}`,
  };
  const observerEvent = {
    process: { cgroupId, pid: 42 },
    event: { FileAccess: { pid: 42, path: `/var/lib/${composeService}/data`, write: true } },
  };
  const decision = ruleSet.materialize(observerEvent, facts, { now });
  assert.equal(decision.role, 'infrastructure', component);
  assert.equal(decision.classification, 'non_agent', component);
  assert.equal(decision.authority, 'authoritative', component);
  assert.equal(decision.stage, 'enforce', component);
  assert.equal(decision.action, 'drop', component);
  assert.equal(decision.scopeKey, `cgroup:${cgroupId}`, component);
  assert.equal(decision.documentVersion, 7, component);
  assert.ok(decision.audit.evidenceRefs.length > 0, component);
}

const standaloneDocker = new InfrastructureRuleSet({
  ...document,
  version: 8,
  rules: [{
    ...dockerRule('docker-kind-control-plane', 'unused'),
    selector: {
      type: 'docker',
      hostGroup: 'anysentry-dev',
      containerName: 'a3s-k8s-test-control-plane',
      imageDigest: `sha256:${'c'.repeat(64)}`,
    },
  }],
});
assert.equal(standaloneDocker.resolve({
  type: 'docker',
  hostGroup: 'anysentry-dev',
  containerName: 'a3s-k8s-test-control-plane',
  imageDigest: `sha256:${'c'.repeat(64)}`,
}, 'FileAccess', { now }).action, 'drop');

const aggregateIntent = {
  schemaVersion: 'anysentry.infrastructure_capture_intent.v1',
  action: 'aggregate',
};
const aggregateIntentSet = new InfrastructureRuleSet({
  ...document,
  version: 9,
  rules: [{
    ...dockerRule('docker-aggregate-clickhouse', 'clickhouse'),
    captureIntent: aggregateIntent,
    eventPolicy: {},
  }],
});
const aggregateResolution = aggregateIntentSet.resolve({
  type: 'docker',
  hostGroup: 'anysentry-dev',
  composeProject: 'anysentry',
  composeService: 'clickhouse',
}, 'FileAccess', { now });
assert.deepEqual(aggregateResolution.captureIntent, aggregateIntent);
assert.equal(aggregateResolution.action, 'sample',
  'the legacy post-Ring resolver must not turn AGGREGATE into DROP');
assert.equal(aggregateResolution.wouldAction, 'sample');
assert.throws(() => new InfrastructureRuleSet({
  ...document,
  version: 10,
  rules: [{
    ...dockerRule('docker-conflicting-intent', 'clickhouse'),
    captureIntent: aggregateIntent,
  }],
}), /eventPolicy conflicts with its versioned captureIntent/u,
'a local policy cannot hide a DROP override behind an AGGREGATE intent');

const hostFixtures = [
  ['Docker', 'docker.service', '/usr/bin/dockerd', '3001'],
  ['kubelet', 'kubelet.service', '/usr/bin/kubelet', '3002'],
  ['k3s', 'k3s.service', '/usr/local/bin/k3s', '3003'],
];
for (const [component, systemdUnit, executable, cgroupId] of hostFixtures) {
  const decision = ruleSet.materialize(
    { process: { cgroupId }, event: { FileAccess: { path: '/var/lib/runtime/state' } } },
    { type: 'host', hostGroup: 'anysentry-dev', systemdUnit, executable },
    { now },
  );
  assert.equal(decision.action, 'drop', component);
  assert.equal(decision.classification, 'non_agent', component);
}

const corednsFacts = {
  type: 'kubernetes',
  clusterId: 'default-cluster',
  namespace: 'kube-system',
  ownerKind: 'Deployment',
  ownerName: 'coredns',
  containerName: 'coredns',
  physicalWorkloadId: 'k8s:default-cluster:pod-coredns:container-coredns',
};
const coredns = ruleSet.materialize(
  { process: { cgroup_id: '4001' }, event: { FileAccess: { path: '/etc/coredns/Corefile' } } },
  corednsFacts,
  { now },
);
assert.equal(coredns.action, 'drop');
assert.equal(coredns.classification, 'non_agent');

for (const protectedKind of [
  'CollectorHeartbeat',
  'RuntimeSnapshot',
  'ContainerLifecycle',
  'PodLifecycle',
  'SecurityAction',
]) {
  const decision = ruleSet.resolve(corednsFacts, protectedKind, { now });
  assert.equal(decision.action, 'keep', `${protectedKind} must remain observable`);
}
assert.equal(ruleSet.resolve(corednsFacts, 'FileDelete', { now }).action, 'drop');
assert.equal(ruleSet.resolve(corednsFacts, 'ToolExec', { now }).action, 'keep');
assert.equal(ruleSet.resolve(corednsFacts, 'ProcessExit', { now }).action, 'keep');
assert.equal(ruleSet.resolve(corednsFacts, 'Dns', { now }).action, 'drop');

const candidateDocument = {
  schemaVersion: INFRASTRUCTURE_RULES_SCHEMA,
  version: 8,
  generatedAt: document.generatedAt,
  rules: [{
    ...dockerRule('candidate-clickhouse', 'clickhouse'),
    authority: 'candidate',
    stage: 'enforce',
    reasonCode: 'cross_node_infrastructure_candidate',
  }],
};
const candidateSet = new InfrastructureRuleSet(candidateDocument);
const candidate = candidateSet.materialize(
  { process: { cgroupId: '5001' }, event: { FileAccess: { path: '/var/lib/clickhouse/data' } } },
  {
    type: 'docker',
    hostGroup: 'anysentry-dev',
    composeProject: 'anysentry',
    composeService: 'clickhouse',
  },
  { now },
);
assert.equal(candidate.action, 'sample', 'candidate rules can never drop');
assert.equal(candidate.wouldAction, 'drop');
assert.equal(candidate.classification, 'unknown');
assert.equal(candidate.candidateRole, 'infrastructure');
const defensiveCandidate = materializeCgroupFilterDecision(
  { process: { cgroupId: '5002' }, event: { FileAccess: {} } },
  { ...candidate, action: 'drop', authority: 'candidate', facts: {} },
);
assert.equal(defensiveCandidate.action, 'sample', 'materialization must defensively downgrade candidate drop');

const shadowSet = new InfrastructureRuleSet({
  ...candidateDocument,
  version: 9,
  rules: [{
    ...dockerRule('shadow-clickhouse', 'clickhouse'),
    stage: 'shadow',
  }],
});
const shadow = shadowSet.resolve({
  type: 'docker',
  hostGroup: 'anysentry-dev',
  composeProject: 'anysentry',
  composeService: 'clickhouse',
}, 'FileAccess', { now });
assert.equal(shadow.action, 'sample');
assert.equal(shadow.wouldAction, 'drop');
assert.equal(shadow.classification, 'unknown');
assert.equal(shadow.wouldClassification, 'non_agent');

const canarySet = new InfrastructureRuleSet({
  ...candidateDocument,
  version: 10,
  rules: [{
    ...dockerRule('canary-clickhouse', 'clickhouse'),
    stage: 'canary',
  }],
});
const canaryFacts = {
  type: 'docker',
  hostGroup: 'anysentry-dev',
  composeProject: 'anysentry',
  composeService: 'clickhouse',
};
assert.equal(canarySet.resolve(canaryFacts, 'FileAccess', { now }).action, 'sample');
assert.equal(canarySet.resolve(canaryFacts, 'FileAccess', { now, canaryEnabled: true }).action, 'drop');

const agentConflictSet = new InfrastructureRuleSet({
  ...document,
  version: 11,
  rules: [
    dockerRule('infra-conflict', 'clickhouse'),
    {
      ...dockerRule('agent-conflict', 'clickhouse'),
      role: 'agent',
      authority: 'candidate',
      stage: 'candidate',
      source: 'cross_node_learning',
      reasonCode: 'probable_agent_candidate',
      audit: {
        createdBy: 'candidate-engine',
        changeReason: 'Agent evidence conflicts with Infrastructure inventory',
        evidenceRefs: ['fixture:agent-conflict'],
      },
    },
  ],
});
const conflict = agentConflictSet.resolve(canaryFacts, 'FileAccess', { now });
assert.equal(conflict.role, 'agent');
assert.equal(conflict.classification, 'probable_agent');
assert.equal(conflict.action, 'keep', 'Agent keep must win every Infrastructure drop conflict');
assert.equal(conflict.conflict, true);
assert.equal(conflict.reasonCode, 'agent_keep_conflict');
assert.deepEqual(conflict.matchedRuleIds, ['agent-conflict', 'infra-conflict']);

const expired = new InfrastructureRuleSet({
  ...candidateDocument,
  version: 12,
  rules: [{
    ...dockerRule('expired-clickhouse', 'clickhouse'),
    createdAt: '2026-08-15T00:00:00.000Z',
    updatedAt: '2026-08-16T00:00:00.000Z',
    expiresAt: '2026-08-17T01:00:00.000Z',
  }],
});
assert.equal(expired.resolve(canaryFacts, 'FileAccess', { now }), undefined);
assert.equal(ruleSet.materialize(
  { process: { cgroupId: 'not-a-cgroup' }, event: { FileAccess: {} } },
  corednsFacts,
  { now },
), undefined);

assert.throws(() => validateInfrastructureRuleDocument({ ...document, schemaVersion: 'invalid' }));
assert.throws(() => validateInfrastructureRuleDocument({
  ...document,
  rules: [dockerRule('duplicate', 'clickhouse'), dockerRule('duplicate', 'redis')],
}), /duplicate rule id/u);
assert.throws(() => validateInfrastructureRuleDocument({
  ...document,
  rules: [{
    ...dockerRule('wildcard', 'clickhouse'),
    selector: { type: 'docker', hostGroup: '*', composeProject: 'anysentry', composeService: 'clickhouse' },
  }],
}), /exact value/u);
assert.throws(() => validateInfrastructureRuleDocument({
  ...document,
  rules: [{
    ...dockerRule('unstable-k8s', 'clickhouse'),
    selector: { type: 'kubernetes', clusterId: 'default-cluster', namespace: 'default' },
  }],
}), /ownerKind/u);
assert.throws(() => validateInfrastructureRuleDocument({
  ...document,
  rules: [{
    ...dockerRule('ephemeral-docker-selector', 'clickhouse'),
    selector: {
      type: 'docker',
      hostGroup: 'anysentry-dev',
      composeProject: 'anysentry',
      composeService: 'clickhouse',
      containerId: 'ephemeral-container-id',
    },
  }],
}), /unsupported field containerId/u);

console.log('Observer Infrastructure rules v1 verification passed');
