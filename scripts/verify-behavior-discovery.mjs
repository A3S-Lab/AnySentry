#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  BehavioralAgentDetector,
  behaviorKey,
  isServiceDataFile,
  isWorkspaceFile,
} = require('./observer-behavior-discovery');

let now = 1_000_000;
const detector = new BehavioralAgentDetector({
  now: () => now,
  threshold: 8,
  windowMs: 60_000,
  probableTtlMs: 120_000,
  maxWorkloads: 100,
});

function event(kind, payload, cgroupId = '77') {
  return {
    process: {
      host_id: 'node-a',
      boot_id: 'boot-a',
      pid: payload.pid ?? 100,
      start_time_ticks: '99',
      cgroup_id: cgroupId,
      cgroup: '0::/user.slice/agent.scope',
      comm: 'worker',
      exe: '/usr/local/bin/worker',
    },
    event: { [kind]: payload },
  };
}

const behaviorAttribution = {
  physicalWorkloadId: 'k8s:test:pod-uid-1',
  workloadRef: {
    environment: 'kubernetes',
    kind: 'pod',
    name: 'research-agent-7b8d9',
    namespace: 'default',
    podName: 'research-agent-7b8d9',
    containerName: 'agent',
    nodeName: 'node-a',
  },
};
const tool = event('ToolExec', { pid: 100, argv: ['python', 'tool.py'] });
assert.equal(
  behaviorKey(tool),
  'host:node-a:boot-a:cgroup:77',
  'behavior groups host activity by stable cgroup before PID',
);
assert.equal(
  detector.observe(tool, behaviorAttribution),
  undefined,
  'one generic tool is not an Agent',
);
const promoted = detector.observe(
  event('Egress', { pid: 100, host: 'api.openai.com' }),
  behaviorAttribution,
);
assert.equal(promoted.state, 'agent');
assert.equal(promoted.attribution.classification, 'probable_agent');
assert.equal(promoted.attribution.source, 'behavior');
assert.equal(promoted.attribution.agentDisplayName, 'research-agent-7b8d9');
assert.equal(promoted.attribution.workloadRef.podName, 'research-agent-7b8d9');
assert.equal(promoted.attribution.workloadRef.containerName, 'agent');
assert.match(promoted.attribution.evidence[0], /behavior:score=/);
const continued = detector.observe(
  event('ToolExec', { pid: 101, argv: ['curl', 'https://example.test'] }),
  behaviorAttribution,
);
assert.equal(continued.state, 'agent');

now += 61_000;
const hysteresis = detector.observe(
  event('FileAccess', { pid: 101, path: '/workspace/result.json' }),
  behaviorAttribution,
);
assert.equal(hysteresis.state, 'agent', 'a probable candidate survives one empty scoring window');

now += 121_000;
detector.prune();
assert.equal(detector.metrics().candidates, 0);

const generic = new BehavioralAgentDetector({ now: () => now, threshold: 8 });
for (let index = 0; index < 10; index++) {
  generic.observe(event('FileAccess', { pid: 200, path: `/tmp/cache-${index}` }, '88'));
}
assert.equal(generic.metrics().candidates, 0, 'file churn alone never creates an Agent');

const bounded = new BehavioralAgentDetector({
  now: () => now,
  threshold: 8,
  maxWorkloads: 100,
});
for (let index = 0; index < 150; index++) {
  bounded.observe(event('ToolExec', { pid: 300 + index, argv: ['true'] }, String(1_000 + index)));
}
assert.ok(bounded.metrics().workloads <= 100);
assert.ok(bounded.metrics().evicted > 0);

assert.equal(isServiceDataFile({ path: '/var/lib/clickhouse/store/abc/data.bin' }), true);
assert.equal(isServiceDataFile({ path: '/var/lib/postgresql/16/main/base/1' }), true);
assert.equal(isServiceDataFile({ path: '/var/lib/mysql/orders.ibd' }), true);
assert.equal(isServiceDataFile({ path: '/var/lib/redis/dump.rdb' }), true);
assert.equal(isServiceDataFile({ path: '/var/lib/kafka/data/topic-0/000000.log' }), true);
assert.equal(isServiceDataFile({ path: '/opt/apache-doris/be/storage/data/0/1.dat' }), true);
const customServicePaths = new BehavioralAgentDetector({
  serviceDataPaths: ['/srv/state/vector-db'],
}).serviceDataPaths;
assert.equal(isServiceDataFile({ path: '/srv/state/vector-db/segments/1' }, customServicePaths), true);
assert.equal(
  isServiceDataFile({ path: '/var/lib/clickhouse/store/abc/data.bin' }, customServicePaths),
  true,
  'custom service-state paths extend rather than replace safe defaults',
);
assert.equal(
  isWorkspaceFile({ path: '/var/lib/clickhouse/store/abc/data.bin' }),
  false,
  'service data is not Agent workspace evidence',
);
assert.equal(isWorkspaceFile({ path: '/workspace/src/index.ts' }), true);

const sequenceDetector = new BehavioralAgentDetector({
  now: () => now,
  threshold: 8,
  negativeMinAgeMs: 1_000,
});
assert.equal(
  sequenceDetector.observe(event('ToolExec', { pid: 500, argv: ['git', 'status'] }, '500')),
  undefined,
);
assert.equal(
  sequenceDetector.observe(event('Egress', { pid: 500, peer: '203.0.113.10', port: 443 }, '500')),
  undefined,
);
assert.equal(
  sequenceDetector.observe(event('ToolExec', { pid: 501, argv: ['npm', 'test'] }, '500')),
  undefined,
);
const sequenceCandidate = sequenceDetector.observe(
  event('FileAccess', { pid: 501, path: '/workspace/test-results.json' }, '500'),
);
assert.equal(sequenceCandidate?.state, 'agent');
assert.ok(
  sequenceCandidate.attribution.evidence.includes('behavior:agent_sequences=1'),
  'tool → decision/network → different tool → workspace forms one Agent sequence',
);

const dnsSequenceDetector = new BehavioralAgentDetector({
  now: () => now,
  threshold: 8,
  negativeMinAgeMs: 1_000,
});
dnsSequenceDetector.observe(event('ToolExec', { pid: 510, argv: ['git', 'status'] }, '510'));
dnsSequenceDetector.observe(event('Dns', { pid: 510, query: 'registry.example.test' }, '510'));
dnsSequenceDetector.observe(event('ToolExec', { pid: 511, argv: ['npm', 'test'] }, '510'));
const dnsSequenceCandidate = dnsSequenceDetector.observe(
  event('FileAccess', { pid: 511, path: '/workspace/dns-test-results.json' }, '510'),
);
assert.ok(
  dnsSequenceCandidate?.attribution.evidence.includes('behavior:agent_sequences=1'),
  'Observer-native Dns.query is a decision/network step in the Agent sequence',
);

const bulkActivity = new BehavioralAgentDetector({ now: () => now, threshold: 8 });
for (const argv of [
  ['find', '/data'],
  ['sort', '/data/index'],
  ['merge', '/data/part'],
  ['find', '/data'],
  ['sort', '/data/index'],
  ['merge', '/data/part'],
]) {
  bulkActivity.observe(event('ToolExec', { pid: 600, argv }, '600'));
}
for (let index = 0; index < 8; index++) {
  bulkActivity.observe(event('FileAccess', { pid: 600, path: `/data/part-${index}` }, '600'));
}
assert.equal(
  bulkActivity.metrics().candidates,
  0,
  'many exec/file events without a decision cycle are insufficient for Agent promotion',
);

for (const infrastructureName of [
  'ai-apm-ingest',
  'ai-apm-web',
  'anysentry-kafka-1',
  'ai-apm-doris-fe',
  'ai-apm-doris-be',
  'anysentry-clickhouse-1',
]) {
  const knownInfrastructure = new BehavioralAgentDetector({ now: () => now, threshold: 8 });
  const result = knownInfrastructure.observe(
    event('ToolExec', { pid: 650, argv: ['service', 'start'] }, `infra-${infrastructureName}`),
    {
      physicalWorkloadId: `docker:local:${infrastructureName}`,
      workloadRef: {
        environment: 'docker',
        kind: 'container',
        name: infrastructureName,
        containerName: infrastructureName,
      },
    },
  );
  assert.equal(result?.state, 'unknown', `${infrastructureName} must remain outside Agent scope`);
  assert.ok(
    result.attribution.evidence.includes('behavior:negative=known_infrastructure_workload'),
    `${infrastructureName} must carry explicit infrastructure negative evidence`,
  );
  assert.equal(knownInfrastructure.metrics().candidates, 0);
}

let infrastructureNow = now;
const infrastructureDetector = new BehavioralAgentDetector({
  now: () => infrastructureNow,
  threshold: 8,
  windowMs: 60_000,
  probableTtlMs: 180_000,
  negativeMinAgeMs: 60_000,
});
infrastructureDetector.observe(
  event('ToolExec', { pid: 700, argv: ['worker', 'query'] }, '700'),
  { physicalWorkloadId: 'k8s:test:database-container' },
);
const initialCandidate = infrastructureDetector.observe(
  event('Egress', { pid: 700, host: 'api.openai.com' }, '700'),
  { physicalWorkloadId: 'k8s:test:database-container' },
);
assert.equal(initialCandidate?.state, 'agent');
infrastructureNow += 61_000;
let infrastructureResult;
for (let index = 0; index < 6; index++) {
  const fileEvent = event('FileAccess', {
    pid: 700,
    path: `/var/lib/clickhouse/store/abc/merge-${index}.bin`,
  }, '700');
  const before = structuredClone(fileEvent);
  infrastructureResult = infrastructureDetector.observe(
    fileEvent,
    { physicalWorkloadId: 'k8s:test:database-container' },
  );
  assert.deepEqual(fileEvent, before, 'behavior classification must not mutate or delete the raw event');
}
assert.equal(infrastructureResult?.state, 'unknown');
assert.ok(
  infrastructureResult.attribution.evidence.includes('behavior:negative=service_data_pattern'),
);
assert.equal(
  infrastructureDetector.metrics().candidates,
  0,
  'strong infrastructure evidence clears probable TTL before its natural expiry',
);
assert.equal(infrastructureDetector.metrics().demoted, 1);

console.log('Behavior discovery verification passed');
