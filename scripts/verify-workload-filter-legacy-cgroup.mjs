#!/usr/bin/env node

// Regression: legacy perf-kprobe collectors report cgroupId '0' for every event. The workload
// identity cache must not treat '0' as a discriminating key — otherwise all legacy events share
// one cgroup binding and inherit whichever container identity resolved first (UOS hybrid field
// report, 2026-10-09). Covers the '0' guard, per-pid candidate caching, and candidateCache
// invalidation on snapshot replace.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { WorkloadIdentityCache } = require('./observer-workload-filter');

const idA = 'a'.repeat(64);
const idB = 'b'.repeat(64);

function snapshot(version) {
  return {
    schemaVersion: 'anysentry.workload_identity_snapshot.v1',
    ready: true,
    version,
    entries: [
      { ids: [idA], classification: 'confirmed_agent', physicalWorkloadId: `docker:local:${idA}`, agentScopeId: 'office-agent' },
      { ids: [idB], classification: 'confirmed_agent', physicalWorkloadId: `docker:local:${idB}`, agentScopeId: 'payments-agent' },
    ],
  };
}

const pidCgroups = new Map([
  [101, `0::/docker/${idA}`],
  [202, `0::/docker/${idB}`],
]);
const cache = new WorkloadIdentityCache({ readProcCgroup: (pid) => pidCgroups.get(pid) ?? '' });
assert.equal(cache.replace(snapshot(1), 'docker'), true);

const eventFor = (pid) => ({
  process: { pid, cgroupId: '0', comm: 'python' },
  event: { ToolExec: { pid, argv: ['python', 'serve.py'] } },
});

const firstA = cache.classify(eventFor(101));
assert.equal(firstA.state, 'agent');
assert.equal(firstA.attribution.agentScopeId, 'office-agent', 'pid 101 belongs to container A');

// Pre-fix this returned office-agent: the shared '0' cgroup binding from pid 101 was reused.
const firstB = cache.classify(eventFor(202));
assert.equal(firstB.state, 'agent');
assert.equal(firstB.attribution.agentScopeId, 'payments-agent', 'pid 202 belongs to container B, not the first-bound container');

// Cache hits for the same pids stay stable.
assert.equal(cache.classify(eventFor(101)).attribution.agentScopeId, 'office-agent');
assert.equal(cache.classify(eventFor(202)).attribution.agentScopeId, 'payments-agent');

// A snapshot replace must drop pid-keyed candidates too: container ids recycle.
pidCgroups.set(101, `0::/docker/${idB}`);
assert.equal(cache.replace(snapshot(2), 'docker'), true);
const rebound = cache.classify(eventFor(101));
assert.equal(rebound.attribution.agentScopeId, 'payments-agent', 'snapshot replace invalidates pid-keyed identity candidates');

// A real cgroup id without container evidence returns no classification and writes no binding.
const modern = new WorkloadIdentityCache({ readProcCgroup: () => '' });
modern.replace(snapshot(3), 'docker');
const cgroupMiss = modern.classify({ process: { pid: 303, cgroupId: '424242', comm: 'python' }, event: { ToolExec: { pid: 303 } } });
assert.equal(cgroupMiss, undefined, 'events without container evidence stay unclassified');
assert.equal(modern.cgroupBindings.has('424242'), false, 'misses are not cached as bindings');
assert.equal(modern.cgroupBindings.has('0'), false, 'the 0 key is never written');

console.log('verify-workload-filter-legacy-cgroup: all assertions passed');
