#!/usr/bin/env node

// Regression: under bare systemd deployments (no A3S_OBSERVER_HOST_ID / A3S_NODE_NAME /
// NODE_NAME / K8S_NODE_NAME) the AgentAttributor host identity falls back to /etc/machine-id,
// while DockerDiscovery's own empty fallback was the literal 'local'. The collector lease
// registers with the attributor hostId, so every runtime snapshot carrying docker entries
// (hostId 'local', physicalWorkloadId 'docker:local:<id>') was rejected by the runtime-state
// API as identity_conflict and the control lane never became ready (UOS field report,
// 2026-10-10). The fix wires DockerDiscovery with `hostId: attributor.hostId` at the
// observer-forward.js construction site. This script pins the wiring, the default identity
// semantics, and the lease/snapshot invariant in both the bare-systemd and k3s shapes.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { AgentAttributor } = require('./observer-agent-attribution');
const { dockerSnapshot } = require('./observer-docker-discovery');

const HOST_ENV_KEYS = ['A3S_OBSERVER_HOST_ID', 'A3S_NODE_NAME', 'NODE_NAME', 'K8S_NODE_NAME'];
const savedEnv = new Map(HOST_ENV_KEYS.map((key) => [key, process.env[key]]));
const restoreEnv = () => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
};
const clearHostEnv = () => {
  for (const key of HOST_ENV_KEYS) delete process.env[key];
};

const machineId = (() => {
  try {
    return fs.readFileSync('/etc/machine-id', 'utf8').trim() || 'local-host';
  } catch {
    return 'local-host';
  }
})();

const containerId = 'f'.repeat(64);
const agentContainer = {
  Id: containerId,
  Names: ['/office-agent'],
  State: 'running',
  Labels: { 'anysentry.io/workload-kind': 'agent', 'anysentry.io/agent-id': 'office-agent' },
};

// The exact predicate the API applies in agent-runtime-state.service.ts recordSnapshot().
const foreignRoot = (entries, lease) =>
  entries.find((entry) => entry.hostId !== lease.hostId || entry.bootId !== lease.bootId);

try {
  // --- Bare systemd shape: no host identity env at all -------------------------------
  clearHostEnv();
  const attributor = new AgentAttributor({});
  assert.equal(attributor.hostId, machineId, 'attributor falls back to /etc/machine-id');
  assert.ok(attributor.bootId, 'attributor resolves a bootId');

  const lease = { hostId: attributor.hostId, bootId: attributor.bootId };

  // Fixed wiring: DockerDiscovery receives the attributor identity (observer-forward.js).
  const accepted = dockerSnapshot([agentContainer], {
    version: 1,
    hostId: attributor.hostId,
    bootId: attributor.bootId,
  });
  assert.equal(accepted.entries.length, 1);
  assert.equal(accepted.entries[0].hostId, lease.hostId);
  assert.equal(
    accepted.entries[0].physicalWorkloadId,
    `docker:${machineId}:${containerId}`,
    'docker identity is host-scoped, not the literal docker:local:*',
  );
  assert.equal(
    foreignRoot(accepted.entries, lease),
    undefined,
    'snapshot with lease-consistent docker identity must not trip identity_conflict',
  );

  // Negative control: the pre-fix wiring (env expression resolving to '') produced hostId
  // 'local', which the lease check rejects. This proves the regression is covered.
  const legacy = dockerSnapshot([agentContainer], {
    version: 1,
    hostId: process.env.A3S_OBSERVER_HOST_ID || '',
    bootId: attributor.bootId,
  });
  if (machineId !== 'local') {
    assert.equal(legacy.entries[0].hostId, 'local');
    assert.ok(
      foreignRoot(legacy.entries, lease),
      'pre-fix wiring must be detected as a foreign root',
    );
  }

  // --- k3s DaemonSet shape: NODE_NAME injected, behavior unchanged --------------------
  clearHostEnv();
  process.env.NODE_NAME = 'node-a';
  const k3sAttributor = new AgentAttributor({ hostId: process.env.A3S_OBSERVER_HOST_ID || process.env.A3S_NODE_NAME || process.env.NODE_NAME || '' });
  assert.equal(k3sAttributor.hostId, 'node-a');
  const k3sSnapshot = dockerSnapshot([agentContainer], {
    version: 1,
    hostId: k3sAttributor.hostId,
    bootId: k3sAttributor.bootId,
  });
  assert.equal(k3sSnapshot.entries[0].hostId, 'node-a', 'NODE_NAME deployments keep node identity');
  assert.equal(foreignRoot(k3sSnapshot.entries, { hostId: 'node-a', bootId: k3sAttributor.bootId }), undefined);

  // --- Pin the forwarder wiring at the source level -----------------------------------
  const forwarderSource = fs.readFileSync(path.join(__dirname, 'observer-forward.js'), 'utf8');
  const construction = forwarderSource.match(/new DockerDiscovery\(\{[\s\S]*?\}\)/);
  assert.ok(construction, 'DockerDiscovery construction site found in observer-forward.js');
  assert.ok(
    construction[0].includes('hostId: attributor.hostId'),
    'DockerDiscovery must be wired with the attributor (lease) host identity',
  );
  assert.ok(
    !construction[0].includes('hostId: process.env'),
    'DockerDiscovery must not re-derive host identity from raw env',
  );
} finally {
  restoreEnv();
}

console.log('docker hostId consistency verification passed');
