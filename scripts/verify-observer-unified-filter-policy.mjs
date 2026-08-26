#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { builtinFilterRules, filterRuleDigest } = require('../apps/api/dist/security-monitoring/filter-rule-builtins.js');
const { compileFilterRuleProjection } = require('../apps/api/dist/security-monitoring/filter-rule-engine.js');
const { RuntimeSignatureRegistry } = require('./observer-agent-runtime-signatures.js');
const { AgentTemplateRegistry } = require('./observer-agent-templates.js');
const { UnifiedFilterPolicyRegistry, buildRuleIndex, indexedCandidates } = require('./observer-unified-filter-policy.js');

const now = Date.parse('2026-08-25T12:00:00.000Z');
const projection = compileFilterRuleProjection({
  rules: builtinFilterRules(),
  catalogVersion: 11,
  domainVersions: { identity: 2, capture: 3, forwarder: 4, retention: 5 },
  now,
  ttlMs: 120_000,
});
const registry = new UnifiedFilterPolicyRegistry({ now: () => now + 1_000 });
const loaded = registry.replace(projection);
assert.equal(loaded.ok, true, loaded.error);
assert.equal(loaded.changed, true);
assert.equal(registry.metrics().state, 'ready');
assert.equal(registry.metrics().catalogVersion, 11);
assert.equal(registry.settings().retainUnknown, true);
assert.equal(registry.settings().retainNonAgent, false);
assert.equal(registry.settings().fileAggregationEnabled, true);

const signatures = registry.runtimeSignatureDocument();
assert.equal(signatures.runtimes.length, 6);
const signatureRegistry = new RuntimeSignatureRegistry(signatures, { source: 'unified-filter-rule' });
assert.equal(signatureRegistry.metrics().loaded, 6);
assert.equal(signatureRegistry.match({ comm: 'codex' })?.agentId, 'codex');
const templates = registry.agentTemplateDocument();
const templateRegistry = new AgentTemplateRegistry(templates);
assert.equal(templateRegistry.metrics().loaded, 0);

const baseUnknown = {
  state: 'unknown',
  attribution: { monitored: false, classification: 'unknown', confidence: 0, reason: 'not_evaluated', source: 'none' },
  infrastructureFacts: {
    placement: 'kubernetes',
    labels: { 'anysentry.io/workload-kind': 'agent', 'anysentry.io/workload-role': 'agent' },
  },
};
const agentCandidates = registry.identityCandidates(
  { event: { ToolExec: { argv: ['node'] } }, process: { comm: 'node', exe: '/usr/bin/node' } },
  baseUnknown,
);
assert(agentCandidates.some((candidate) => candidate.attribution.classification === 'confirmed_agent'));
assert(agentCandidates.some((candidate) => candidate.workloadRole === 'agent'));
assert(agentCandidates.every((candidate) => candidate.decisionReceipt?.schemaVersion === 'anysentry.filter_rule_decision_receipt.v1'));
assert(agentCandidates.every((candidate) => candidate.decisionReceipt?.stage === 'f0'));

const probable = {
  state: 'agent',
  attribution: { monitored: true, classification: 'probable_agent', confidence: 0.85, reason: 'hint_only', source: 'process_signature' },
};
const probableCapture = registry.captureDecision(
  { event: { FileAccess: { path: '/workspace/a' } }, process: { comm: 'codex', cgroupId: '100' } },
  probable,
);
assert.equal(probableCapture.captureProfile, 'probable_investigation');
assert.equal(probableCapture.desiredProbeActions.file_access, 'sample');
assert.equal(probableCapture.desiredProbeActions.security, 'full');
assert.equal(probableCapture.decisionReceipt.stage, 'f1');
assert.equal(probableCapture.decisionReceipt.winner.ruleId, probableCapture.ruleId);

const infrastructure = {
  state: 'infrastructure',
  workloadRole: 'platform_infrastructure',
  attribution: { monitored: false, classification: 'non_agent', confidence: 1, reason: 'not_agent', source: 'kubernetes' },
};
const infrastructureCapture = registry.captureDecision(
  { event: { FileAccess: { path: '/var/lib/data' } }, process: { comm: 'clickhouse', cgroupId: '101' } },
  infrastructure,
);
assert.equal(infrastructureCapture.captureProfile, 'infrastructure_aggregate');
assert.equal(infrastructureCapture.desiredProbeActions.file_access, 'aggregate');

const securityDecision = registry.semanticDecision(
  { event: { SecurityAction: { kind: 'finding' } }, process: { comm: 'clickhouse' } },
  infrastructure,
);
assert.equal(securityDecision.action, 'priority');
assert.equal(securityDecision.ruleId, 'fr_guardrail_security_full');
const nonAgentDecision = registry.semanticDecision(
  { event: { FileAccess: { path: '/var/lib/data' } }, process: { comm: 'clickhouse' } },
  infrastructure,
);
assert.equal(nonAgentDecision.action, 'suppress');
assert.equal(nonAgentDecision.ruleId, 'fr_builtin_f2_non_agent_suppress');
assert.equal(nonAgentDecision.decisionReceipt.stage, 'f2');
assert.equal(nonAgentDecision.decisionReceipt.winner.ruleId, nonAgentDecision.ruleId);
const unknownDecision = registry.semanticDecision(
  { event: { FileAccess: { path: '/home/user/a' } }, process: { comm: 'cat' } },
  baseUnknown,
);
assert.equal(unknownDecision.action, 'keep');

for (let index = 0; index < 20; index += 1) assert.equal(registry.shouldKeepSample('cgroup:1'), true);
assert.equal(registry.shouldKeepSample('cgroup:1'), false);

assert.equal(registry.replace(projection).changed, false);
const ttlRefresh = compileFilterRuleProjection({
  rules: builtinFilterRules(),
  catalogVersion: 11,
  domainVersions: { identity: 2, capture: 3, forwarder: 4, retention: 5 },
  now: now + 30_000,
  ttlMs: 120_000,
});
assert.notEqual(ttlRefresh.contentHash, projection.contentHash, 'transport hash must cover refreshed timestamps');
assert.equal(ttlRefresh.intentHash, projection.intentHash, 'TTL refresh must preserve semantic intent hash');
assert.equal(registry.replace(ttlRefresh).changed, false, 'TTL refresh must not rebuild the runtime projection');
assert.equal(registry.metrics().contentHash, ttlRefresh.contentHash);
assert.equal(registry.metrics().intentHash, ttlRefresh.intentHash);
const corrupt = structuredClone(projection);
corrupt.forwarderSettings.retainUnknown = false;
assert.equal(registry.replace(corrupt).ok, false);
assert.match(registry.metrics().lastError, /contentHash mismatch/u);
registry.degrade('control plane test outage');
assert.equal(registry.metrics().degraded, 1);

const semanticTemplate = builtinFilterRules().find((rule) => rule.ruleId === 'fr_builtin_f2_unknown_keep');
assert(semanticTemplate);
const denseSemanticRules = Array.from({ length: 1_900 }, (_, index) => {
  const { contentHash: _ignored, ...base } = semanticTemplate;
  const content = {
    ...base,
    ruleId: `fr_dense_semantic_${String(index).padStart(4, '0')}`,
    name: `Dense semantic ${index}`,
    matcher: {
      all: [{ field: 'process.comm', operator: 'equals', value: `dense-service-${index}` }],
      description: `process.comm=dense-service-${index}`,
    },
    priority: 750,
    updatedAt: now,
  };
  return { ...content, contentHash: filterRuleDigest(content) };
});
const denseIndex = buildRuleIndex(denseSemanticRules);
const denseContext = {
  process: { comm: 'dense-service-1777', exe: '', argv: [] },
  identityClassification: 'non_agent', workloadRole: 'business_service',
  workload: { placement: '', cluster: '', namespace: '', ownerKind: '', ownerName: '', container: '', service: '', systemdUnit: '', labels: {} },
  assetId: '', runtimeId: '', eventKind: 'FileAccess', probe: 'file_access', conflict: false, structuralRisk: false, stale: false,
};
assert.equal(indexedCandidates(denseIndex, denseContext).length, 1, 'Observer F2 must index exact fields instead of scanning 1,900 rules');
assert.equal(denseIndex.bucketCount, 1_900);
assert.equal(denseIndex.maxBucketSize, 1);

const denseProjection = compileFilterRuleProjection({
  rules: [...builtinFilterRules(), ...denseSemanticRules],
  catalogVersion: 12,
  domainVersions: { identity: 2, capture: 3, forwarder: 5, retention: 5 },
  now,
  ttlMs: 120_000,
});
const denseRegistry = new UnifiedFilterPolicyRegistry({ now: () => now + 1_000 });
assert.equal(denseRegistry.replace(denseProjection).ok, true);
const denseDecision = denseRegistry.semanticDecision(
  { event: { FileAccess: { path: '/srv/dense' } }, process: { comm: 'dense-service-1777' } },
  infrastructure,
);
assert.equal(denseDecision.ruleId, 'fr_dense_semantic_1777');
assert(denseRegistry.metrics().semanticIndexBuckets >= 1_900);
assert(denseRegistry.metrics().maxIndexBucketSize < 20);

console.log('PASS Observer unified projection validation, identity, capture, semantic retention, and LKG state');
