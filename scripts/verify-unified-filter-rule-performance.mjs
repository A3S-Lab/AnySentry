#!/usr/bin/env node

import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { builtinFilterRules } = require('../apps/api/dist/security-monitoring/filter-rule-builtins.js');
const {
  compileFilterRuleEvaluationIndex,
  evaluateIndexedFilterRules,
  filterRuleIndexCandidates,
} = require('../apps/api/dist/security-monitoring/filter-rule-engine.js');
const { FilterRuleSystemService } = require('../apps/api/dist/security-monitoring/filter-rule-system.service.js');

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}

const base = builtinFilterRules().find((rule) => rule.ruleId === 'fr_builtin_agent_runtime_codex');
assert(base);
const rules = Array.from({ length: 2_000 }, (_, index) => ({
  ...base,
  ruleId: `fr_perf_${String(index).padStart(4, '0')}`,
  name: `Performance rule ${index}`,
  description: `Exact bounded performance rule ${index}`,
  matcher: {
    all: [{ field: 'process.comm', operator: 'equals', value: `performance-runtime-${index}` }],
    description: `process.comm=performance-runtime-${index}`,
  },
  consumerCapabilities: ['f0'],
}));
const versions = { identity: 1, capture: 1, forwarder: 1, retention: 1 };
const context = {
  process: { comm: 'performance-runtime-1777' },
  identityClassification: 'unknown',
  workloadRole: 'unknown',
};

const indexStarted = performance.now();
const index = compileFilterRuleEvaluationIndex(rules);
const indexBuildMs = performance.now() - indexStarted;
assert.equal(filterRuleIndexCandidates(index, context).length, 1);
for (let warmup = 0; warmup < 200; warmup += 1) {
  evaluateIndexedFilterRules({ index, context, stage: 'f0', catalogVersion: 1, domainVersions: versions });
}
const evaluationSamples = [];
for (let iteration = 0; iteration < 5_000; iteration += 1) {
  const started = performance.now();
  const receipt = evaluateIndexedFilterRules({ index, context, stage: 'f0', catalogVersion: 1, domainVersions: versions });
  evaluationSamples.push(performance.now() - started);
  assert.equal(receipt.winner?.ruleId, 'fr_perf_1777');
}
const evaluatorP95Ms = percentile(evaluationSamples, 0.95);

const asset = {
  assetId: 'asset:performance',
  revision: 1,
  displayName: 'Performance asset',
  assetType: 'service',
  bindingQuality: 'logical',
  workloadRole: 'unknown',
  classification: 'unknown',
  sharedScope: false,
  workload: {
    placement: 'kubernetes', clusterId: 'cluster-a', namespace: 'default', ownerKind: 'Deployment',
    ownerName: 'performance', containerName: 'performance', physicalWorkloadId: 'k8s:cluster-a:performance',
  },
  instanceCount: 1,
  nodeIds: ['node-a'],
  continuity: { currentPresenceVerified: true, observationCoverageAvailable: true, serviceContextAvailable: true, partialReasons: [] },
};
const catalog = {
  allRules: () => rules,
  versions: () => ({ catalogVersion: 1, domainVersions: versions, updatedAt: 1 }),
};
const infrastructure = {
  status: () => ({ stateVersion: 0, policyVersion: 0 }),
  catalogRecords: () => [],
  listOperations: () => ({ items: [] }),
};
const system = new FilterRuleSystemService(
  catalog,
  infrastructure,
  { list: () => [], identitySnapshotVersion: () => 0 },
  { listPolicies: () => [], catalogPolicies: () => [] },
  {},
  {},
  { snapshot: () => ({ provider: 'performance-fixture', assets: [asset] }) },
  { ensureAsset: async () => false, detail: () => undefined },
);

for (let warmup = 0; warmup < 3; warmup += 1) system.list({ limit: 100 });
const catalogSamples = [];
for (let iteration = 0; iteration < 25; iteration += 1) {
  const started = performance.now();
  const page = system.list({ limit: 100 });
  catalogSamples.push(performance.now() - started);
  assert.equal(page.total, 2_000);
  assert.equal(page.items.length, 100);
}
const catalogP95Ms = percentile(catalogSamples, 0.95);

for (let warmup = 0; warmup < 3; warmup += 1) await system.explain({ assetId: asset.assetId });
const explainSamples = [];
for (let iteration = 0; iteration < 20; iteration += 1) {
  const started = performance.now();
  const explained = await system.explain({ assetId: asset.assetId });
  explainSamples.push(performance.now() - started);
  assert.equal(explained.stages.length, 4);
}
const explainP95Ms = percentile(explainSamples, 0.95);

assert(indexBuildMs < 1_000, `2,000-rule index build ${indexBuildMs.toFixed(2)}ms exceeded 1s`);
assert(evaluatorP95Ms < 10, `indexed evaluator P95 ${evaluatorP95Ms.toFixed(2)}ms exceeded 10ms`);
assert(catalogP95Ms < 2_000, `catalog P95 ${catalogP95Ms.toFixed(2)}ms exceeded PRD 2s`);
assert(explainP95Ms < 1_000, `Explain P95 ${explainP95Ms.toFixed(2)}ms exceeded PRD 1s`);

console.log(JSON.stringify({
  logicalRules: rules.length,
  indexBuildMs: Number(indexBuildMs.toFixed(3)),
  evaluatorP95Ms: Number(evaluatorP95Ms.toFixed(3)),
  catalogP95Ms: Number(catalogP95Ms.toFixed(3)),
  explainP95Ms: Number(explainP95Ms.toFixed(3)),
  selectedCandidates: filterRuleIndexCandidates(index, context).length,
  indexBuckets: index.bucketCount,
  maxIndexBucketSize: index.maxBucketSize,
}, null, 2));
console.log('PASS unified Filter Rule 2,000-rule performance bounds');
