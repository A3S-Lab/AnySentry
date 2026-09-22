#!/usr/bin/env node

/**
 * Candidate discovery + cold-start collection bound. Local contracts always run;
 * live HTTP runs when ANYSENTRY_API_BASE + ANYSENTRY_MANAGEMENT_TOKEN are set.
 *
 * Proves collection is not globally open and behavior-candidate scoring exists.
 * Does not arm capture grants or start labs.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
for (const script of ['verify-behavior-discovery.mjs', 'verify-filter-rule-snapshot.mjs']) {
  const child = spawnSync(process.execPath, [path.join(here, script)], { stdio: 'inherit' });
  assert.equal(child.status, 0, `${script} must pass`);
}

const require = createRequire(import.meta.url);
const { behaviorKey } = require('./observer-behavior-discovery.js');
assert.notEqual(
  behaviorKey(
    { process: { host_id: 'host-a', boot_id: 'boot-a', rootPid: 7, rootStartTimeTicks: '1' } },
    { physicalWorkloadId: 'k8s:test:pod-uid-1', rootPid: 7, rootStartTimeTicks: '1' },
  ),
  behaviorKey(
    { process: { host_id: 'host-a', boot_id: 'boot-a', rootPid: 7, rootStartTimeTicks: '2' } },
    { physicalWorkloadId: 'k8s:test:pod-uid-1', rootPid: 7, rootStartTimeTicks: '2' },
  ),
  'cold-start windows must be fenced by root start time',
);

console.log('verify-phase-candidate-coldstart-live: local contracts ok');

const base = process.env.ANYSENTRY_API_BASE?.replace(/\/$/u, '');
const token = process.env.ANYSENTRY_MANAGEMENT_TOKEN;
if (!base || !token) {
  console.log('verify-phase-candidate-coldstart-live: live HTTP skipped (set ANYSENTRY_API_BASE and ANYSENTRY_MANAGEMENT_TOKEN)');
  process.exit(0);
}

async function get(pathName, options = {}) {
  const response = await fetch(`${base}${pathName}`, {
    method: options.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'x-anysentry-admin-token': token,
      'x-anysentry-management-token': token,
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const raw = await response.json();
  if (!response.ok) {
    throw new Error(`${pathName} HTTP ${response.status} ${JSON.stringify(raw).slice(0, 240)}`);
  }
  return raw.data ?? raw;
}

const health = await get('/collectors/health', { method: 'POST', body: { timeType: 'last_1h' } });
const collector = health.items?.[0] ?? health;
const metrics = collector.filterMetrics ?? {};
assert.equal(health.filterMetricsReported ?? collector.filterMetricsReported, true);
assert.equal(metrics.filterMode, 'enforce');
assert.equal(metrics.captureProfileMode, 'enforce');
assert.equal(metrics.captureProfileControlPlaneState, 'ready');
assert.equal(metrics.unifiedProjectionState, 'ready');
assert.equal(metrics.filterRuleEnforceDrops, true);
assert.equal(metrics.retainNonAgent, false);
assert.notEqual(metrics.captureProfileActivationMode, 'global_full');
assert.ok(Number.isFinite(metrics.discoveryBudgetDropped));
assert.ok(metrics.discoveryBudgetDropped >= 0);

const projection = await get('/filter-rules/projections/forwarder');
const profiles = projection.captureProfiles ?? {};
assert.equal(profiles.infrastructure_aggregate?.file_access, 'drop', 'infrastructure FileAccess must stay drop unless granted');
assert.equal(profiles.unknown_discovery?.file_access, 'sample', 'unknown FileAccess must stay sampled, not lossless-open');
assert.equal(profiles.agent_full?.file_access, 'full');

const catalog = await get('/filter-rules/catalog?limit=200');
assert.ok((catalog.items ?? []).some((rule) => (
  rule.ruleId === 'fr_builtin_behavior_candidate' && rule.lifecycleStage === 'enforced'
)));

const snapshot = await get('/identity/snapshot');
assert.equal(snapshot.ready, true);
assert.ok((snapshot.entries?.length ?? 0) > 0);

console.log(JSON.stringify({
  schemaVersion: 'anysentry.phase_candidate_coldstart_live.v1',
  filterMode: metrics.filterMode,
  captureProfileMode: metrics.captureProfileMode,
  captureProfileActivationMode: metrics.captureProfileActivationMode,
  captureProfileActivationReason: metrics.captureProfileActivationReason,
  discoveryBudgetDropped: metrics.discoveryBudgetDropped,
  dockerEntries: metrics.dockerEntries,
  identityEntries: snapshot.entries.length,
  infrastructureFileAccess: profiles.infrastructure_aggregate.file_access,
  unknownFileAccess: profiles.unknown_discovery.file_access,
}, null, 2));
console.log('verify-phase-candidate-coldstart-live: live HTTP ok');
