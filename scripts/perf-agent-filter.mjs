#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AgentAttributor } = require('./observer-agent-attribution');
const { BehavioralAgentDetector } = require('./observer-behavior-discovery');
const { BoundedPriorityQueue } = require('./observer-priority-queue');
const { WorkloadIdentityCache } = require('./observer-workload-filter');

const iterations = Math.max(10_000, Number(process.env.ANYSENTRY_PERF_ITERATIONS) || 60_000);
const maxP99Micros = Math.max(1, Number(process.env.ANYSENTRY_PERF_MAX_P99_US) || 250);
const minThroughput = Math.max(1, Number(process.env.ANYSENTRY_PERF_MIN_EVENTS_PER_SEC) || 20_000);
const maxRssDeltaMb = Math.max(1, Number(process.env.ANYSENTRY_PERF_MAX_RSS_DELTA_MB) || 64);
const identityCount = 1_000;

function percentile(sorted, ratio) {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0;
}

function containerEvent(index) {
  const identityIndex = index % identityCount;
  const containerId = `container-${String(identityIndex).padStart(4, '0')}`;
  return {
    identity: { agent: `pod-${identityIndex}`, task: String(10_000 + identityIndex), session: containerId },
    process: {
      pid: 10_000 + identityIndex,
      ppid: 1,
      startTimeTicks: String(20_000 + identityIndex),
      cgroupId: 30_000 + identityIndex,
      comm: 'node',
      exe: '/usr/bin/node',
      cgroup: `0::/kubepods/pod-${identityIndex}/${containerId}`,
    },
    event: {
      FileAccess: {
        pid: 10_000 + identityIndex,
        path: `/workspace/result-${index % 64}.json`,
        write: index % 3 === 0,
      },
    },
  };
}

function hostEvent(index) {
  const pid = 50_000 + (index % 256);
  return {
    identity: { agent: 'codex', task: String(pid), session: null },
    process: {
      pid,
      ppid: 1,
      startTimeTicks: String(90_000 + pid),
      cgroupId: 1,
      comm: 'codex',
      exe: '/usr/bin/codex',
    },
    event: {
      ToolExec: {
        pid,
        ppid: 1,
        uid: 1_000,
        cwd: '/workspace',
        argv: ['codex', 'exec', `task-${index % 32}`],
      },
    },
  };
}

const snapshot = {
  schemaVersion: 'anysentry.workload_identity_snapshot.v1',
  version: 1,
  generatedAt: new Date().toISOString(),
  ready: true,
  errors: 0,
  entries: Array.from({ length: identityCount }, (_, index) => ({
    ids: [`container-${String(index).padStart(4, '0')}`],
    classification: index % 8 === 0 ? 'unknown' : 'confirmed_agent',
    physicalWorkloadId: `docker:perf:container-${index}`,
    ...(index % 8 === 0
      ? {}
      : {
          agentScopeId: `perf-agent-${index % 16}`,
          agentDisplayName: `Performance Agent ${index % 16}`,
        }),
    evidence: ['benchmark:generated'],
  })),
};

const workloadCache = new WorkloadIdentityCache({ maxEventKeys: identityCount * 2 });
assert.equal(workloadCache.replace(snapshot, 'benchmark'), true);
const attributor = new AgentAttributor({
  listPids: () => [],
  readProc: () => {
    throw new Error('warm Observer facts must not fall back to /proc');
  },
});
const behavior = new BehavioralAgentDetector({
  minScore: 99,
  minSignals: 99,
  maxWorkloads: identityCount,
});
const queue = new BoundedPriorityQueue(4_096, 5);

// Populate direct cgroup bindings and JIT-compile the representative paths before measuring.
for (let index = 0; index < identityCount; index++) workloadCache.classify(containerEvent(index));
for (let index = 0; index < 2_000; index++) attributor.classify(hostEvent(index));

const rssBefore = process.memoryUsage().rss;
const cpuBefore = process.cpuUsage();
const started = process.hrtime.bigint();
const latenciesNs = new Array(iterations);
let probableObservations = 0;

for (let index = 0; index < iterations; index++) {
  const eventStarted = process.hrtime.bigint();
  const event = index % 4 === 0 ? hostEvent(index) : containerEvent(index);
  const workload = workloadCache.classify(event);
  const base = workload ?? attributor.classify(event);
  const classification =
    base.state === 'unknown'
      ? behavior.observe(event, base.attribution) ?? base
      : base;
  if (classification.attribution?.classification === 'probable_agent') probableObservations++;
  const priority =
    classification.attribution?.classification === 'confirmed_agent'
      ? 4
      : classification.state === 'agent'
        ? 3
        : 2;
  queue.push(event, priority);
  if (queue.length >= 64) queue.take(64);
  latenciesNs[index] = Number(process.hrtime.bigint() - eventStarted);
}
queue.clear();

const elapsedNs = Number(process.hrtime.bigint() - started);
const cpu = process.cpuUsage(cpuBefore);
const rssDeltaBytes = Math.max(0, process.memoryUsage().rss - rssBefore);
latenciesNs.sort((left, right) => left - right);
const result = {
  iterations,
  throughputEventsPerSecond: Math.round((iterations * 1e9) / elapsedNs),
  latencyMicros: {
    p50: Number((percentile(latenciesNs, 0.5) / 1_000).toFixed(2)),
    p95: Number((percentile(latenciesNs, 0.95) / 1_000).toFixed(2)),
    p99: Number((percentile(latenciesNs, 0.99) / 1_000).toFixed(2)),
  },
  cpuMillis: Number(((cpu.user + cpu.system) / 1_000).toFixed(2)),
  rssDeltaMb: Number((rssDeltaBytes / 1024 / 1024).toFixed(2)),
  identity: workloadCache.metrics(),
  process: attributor.metrics(),
  behaviorProbableObservations: probableObservations,
  limits: {
    minThroughputEventsPerSecond: minThroughput,
    maxP99Micros,
    maxRssDeltaMb,
  },
};

assert.ok(
  result.throughputEventsPerSecond >= minThroughput,
  `throughput ${result.throughputEventsPerSecond}/s is below ${minThroughput}/s`,
);
assert.ok(
  result.latencyMicros.p99 <= maxP99Micros,
  `p99 ${result.latencyMicros.p99}us exceeds ${maxP99Micros}us`,
);
assert.ok(result.rssDeltaMb <= maxRssDeltaMb, `RSS delta ${result.rssDeltaMb}MiB exceeds ${maxRssDeltaMb}MiB`);
assert.equal(result.process.procReads, 0, 'warm process facts unexpectedly triggered /proc fallback');
assert.ok(result.identity.cgroupHits >= iterations / 2, 'stable cgroups did not use the direct binding');

console.log(JSON.stringify(result, null, 2));
