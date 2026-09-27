#!/usr/bin/env node

/**
 * Pollable Phase C/D/E/F0 readiness. Local contracts always run; live HTTP runs when
 * ANYSENTRY_API_BASE + ANYSENTRY_MANAGEMENT_TOKEN are set.
 *
 * The endpoint is in-process: it does not open collection, does not scan ClickHouse,
 * and does not promote candidate ifr_* drafts.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import process from 'node:process';

const require = createRequire(import.meta.url);
const { buildObservabilityReadiness } = require('../apps/api/dist/security-monitoring/observability-readiness.js');

const stages = (status) => [
  { stage: 'f0', label: 'identity', mode: 'resolve', desiredVersion: 1, activeRules: 1, decisions: 0, suppressed: 0, aggregated: 0, lost: 0, status, reason: '', nodes: [] },
  { stage: 'f1', label: 'capture', mode: 'preview', desiredVersion: 1, activeRules: 1, decisions: 0, suppressed: 0, aggregated: 0, lost: 0, status, reason: '', nodes: [] },
  { stage: 'f2', label: 'forward', mode: 'enforce', desiredVersion: 1, activeRules: 1, decisions: 0, suppressed: 0, aggregated: 0, lost: 0, status, reason: '', nodes: [] },
  { stage: 'f3', label: 'retain', mode: 'hash_only', desiredVersion: 1, activeRules: 1, decisions: 0, suppressed: 0, aggregated: 0, lost: 0, status, reason: '', nodes: [] },
];

const catalog = {
  schemaVersion: 'anysentry.filter_rule_system_status.v1',
  catalogVersion: 'cat',
  domainVersions: { identity: 1, capture: 1, forwarder: 1, retention: 1 },
  totalRules: 8,
  editableRules: 1,
  conflicts: 0,
  degradedStages: 0,
  stages: stages('ready'),
  updateTime: '2026-09-22T00:00:00.000Z',
};

const persistence = {
  asyncDerivedPersistenceDropped: 0,
  asyncRawPersistenceDropped: 0,
  asyncKernelPersistenceDropped: 0,
};

const ready = buildObservabilityReadiness({
  status: catalog,
  infrastructureRules: [{ ruleId: 'ifr_postgres', lifecycleStage: 'draft' }],
  persistence,
  generatedAt: '2026-09-22T00:00:00.000Z',
});
assert.equal(ready.schemaVersion, 'anysentry.observability_readiness.v1');
assert.equal(ready.ready, true);
assert.equal(ready.collection.globallyOpened, false);
assert.equal(ready.collection.candidateInfrastructureRules, 1);
assert.equal(ready.collection.enforcedInfrastructureRules, 0);
assert.equal(ready.phases.c.ready, true);
assert.equal(ready.phases.d.ready, true);
assert.equal(ready.phases.e.ready, true);
assert.equal(ready.phases.f0f3.ready, true);

const opened = buildObservabilityReadiness({
  status: { ...catalog, stages: catalog.stages.map((stage) => stage.stage === 'f2' ? { ...stage, mode: 'shadow' } : stage) },
  infrastructureRules: [{ ruleId: 'ifr_postgres', lifecycleStage: 'draft' }],
  persistence,
});
assert.equal(opened.ready, false);
assert.equal(opened.collection.globallyOpened, true);
assert.equal(opened.phases.e.ready, false);

const promoted = buildObservabilityReadiness({
  status: catalog,
  infrastructureRules: [{ ruleId: 'ifr_postgres', lifecycleStage: 'enforced' }],
  persistence,
});
assert.equal(promoted.ready, false);
assert.equal(promoted.collection.enforcedInfrastructureRules, 1);
assert.equal(promoted.phases.e.ready, false);
assert.equal(promoted.phases.f0f3.ready, false);

const dropped = buildObservabilityReadiness({
  status: catalog,
  infrastructureRules: [],
  persistence: { ...persistence, asyncDerivedPersistenceDropped: 1 },
});
assert.equal(dropped.ready, false);
assert.equal(dropped.persistence.unexpectedDerivedDrop, true);
assert.equal(dropped.phases.e.ready, false);

const drifted = buildObservabilityReadiness({
  status: { ...catalog, degradedStages: 1, stages: stages('drifted') },
  infrastructureRules: [],
  persistence,
});
assert.equal(drifted.ready, false);
assert.equal(drifted.phases.f0f3.ready, false);

console.log('verify-observability-readiness-live: local contracts ok');

const base = process.env.ANYSENTRY_API_BASE?.replace(/\/$/u, '');
const token = process.env.ANYSENTRY_MANAGEMENT_TOKEN;
if (!base || !token) {
  console.log('verify-observability-readiness-live: live HTTP skipped (set ANYSENTRY_API_BASE and ANYSENTRY_MANAGEMENT_TOKEN)');
  process.exit(0);
}

async function get(path) {
  const response = await fetch(`${base}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'x-anysentry-admin-token': token,
      'x-anysentry-management-token': token,
    },
  });
  const raw = await response.json();
  if (!response.ok) {
    throw new Error(`${path} HTTP ${response.status} ${JSON.stringify(raw).slice(0, 240)}`);
  }
  return raw.data ?? raw;
}

const deadline = Date.now() + Number(process.env.ANYSENTRY_READINESS_TIMEOUT_MS || 90_000);
let snapshot;
for (;;) {
  snapshot = await get('/v1/observability/readiness');
  if (snapshot.ready) break;
  if (Date.now() >= deadline) {
    throw new Error(`readiness still ${JSON.stringify({
      ready: snapshot.ready,
      collection: snapshot.collection,
      phases: snapshot.phases,
    })}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 3_000));
}
assert.equal(snapshot.schemaVersion, 'anysentry.observability_readiness.v1');
assert.equal(snapshot.collection.globallyOpened, false, 'readiness must not report a globally opened collection');
assert.equal(snapshot.collection.enforcedInfrastructureRules, 0, 'inventory candidates must stay unenforced');
assert.equal(snapshot.persistence.unexpectedDerivedDrop, false);
assert.equal(snapshot.persistence.asyncDerivedPersistenceDropped, 0);
assert.equal(snapshot.phases.c.ready, true);
assert.equal(snapshot.phases.d.ready, true);
assert.equal(snapshot.phases.e.ready, true);
assert.equal(snapshot.phases.f0f3.ready, true);
assert.equal(snapshot.ready, true);
assert.ok(snapshot.collection.candidateInfrastructureRules >= 0);

console.log(`verify-observability-readiness-live: live HTTP ok ready=${snapshot.ready} ifr=${snapshot.collection.candidateInfrastructureRules}`);
