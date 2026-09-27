#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fixture = JSON.parse(readFileSync(new URL('../test/fixtures/unified-filter-rule-golden-v1.json', import.meta.url), 'utf8'));
const { builtinFilterRules } = require('../apps/api/dist/security-monitoring/filter-rule-builtins.js');
const { compileFilterRuleProjection } = require('../apps/api/dist/security-monitoring/filter-rule-engine.js');
const { RuntimeSignatureRegistry } = require('./observer-agent-runtime-signatures.js');
const { UnifiedFilterPolicyRegistry } = require('./observer-unified-filter-policy.js');

assert.equal(fixture.schemaVersion, 'anysentry.filter_rule_golden.v1');
const input = fixture.projectionInput;
const now = Date.parse(input.now);
const projection = compileFilterRuleProjection({
  rules: builtinFilterRules(),
  catalogVersion: input.catalogVersion,
  domainVersions: input.domainVersions,
  now,
  ttlMs: input.ttlMs,
});
assert.equal(projection.contentHash, fixture.projection.contentHash, 'TypeScript compiler projection changed; review and deliberately update the golden fixture');
assert.equal(projection.intentHash, fixture.projection.intentHash, 'Forwarder semantic intent changed; review and deliberately update the golden fixture');
assert.deepEqual({
  runtimeSignatures: projection.runtimeSignatures.runtimes.length,
  agentTemplates: projection.agentTemplates.templates.length,
  identityRules: projection.identityRules.length,
  captureProfileRules: projection.captureProfileRules.length,
  signalEnablementRules: projection.signalEnablementRules.length,
  semanticRetentionRules: projection.semanticRetentionRules.length,
  persistenceRetentionRules: projection.persistenceRetentionRules.length,
  safetyGuardrails: projection.safetyGuardrails.length,
}, fixture.projection.counts);

const registry = new UnifiedFilterPolicyRegistry({ now: () => now + 1_000 });
const loaded = registry.replace(projection);
assert.equal(loaded.ok, true, loaded.error);
const signatures = new RuntimeSignatureRegistry(registry.runtimeSignatureDocument(), { source: 'golden-projection' });
assert.equal(signatures.match({ comm: 'codex' })?.agentId, fixture.expected.codexRuntime);

const unknown = {
  state: 'unknown',
  attribution: { monitored: false, classification: 'unknown', confidence: 0, reason: 'not_evaluated', source: 'none' },
  infrastructureFacts: {
    placement: 'kubernetes',
    labels: { 'anysentry.io/workload-kind': 'agent', 'anysentry.io/workload-role': 'agent' },
  },
};
const identity = registry.identityCandidates(
  { event: { ToolExec: { argv: ['node'] } }, process: { comm: 'node', exe: '/usr/bin/node' } },
  unknown,
);
assert(identity.some((candidate) => candidate.attribution.classification === fixture.expected.agentLabelClassification));
assert(identity.some((candidate) => candidate.workloadRole === fixture.expected.agentLabelRole));
const samplerIdentity = registry.identityCandidates(
  { event: { ToolExec: { pid: 99, argv: ['cpuUsage.sh'] } }, process: { comm: 'cpuUsage.sh' } },
  {
    state: 'unknown',
    attribution: { monitored: false, classification: 'unknown', confidence: 0, reason: 'not_evaluated', source: 'none' },
  },
).find((candidate) => candidate.ruleId === 'fr_builtin_non_agent_runtime_vscode_cpu_sampler');
assert.equal(samplerIdentity?.attribution.classification, fixture.expected.vscodeSamplerClassification);

const probable = {
  state: 'agent',
  attribution: { monitored: true, classification: 'probable_agent', confidence: 0.85, reason: 'hint_only', source: 'process_signature' },
};
assert.equal(registry.captureDecision(
  { event: { FileAccess: { path: '/workspace/a' } }, process: { comm: 'codex' } },
  probable,
)?.captureProfile, fixture.expected.probableCaptureProfile);

const infrastructure = {
  state: 'infrastructure',
  workloadRole: 'platform_infrastructure',
  attribution: { monitored: false, classification: 'non_agent', confidence: 1, reason: 'not_agent', source: 'kubernetes' },
};
assert.equal(registry.captureDecision(
  { event: { FileAccess: { path: '/var/lib/data' } }, process: { comm: 'clickhouse' } },
  infrastructure,
)?.captureProfile, fixture.expected.infrastructureCaptureProfile);
assert.equal(registry.semanticDecision(
  { event: { SecurityAction: { kind: 'finding' } }, process: { comm: 'clickhouse' } },
  infrastructure,
)?.ruleId, fixture.expected.securityF2RuleId);
assert.equal(registry.semanticDecision(
  { event: { FileAccess: { path: '/var/lib/data' } }, process: { comm: 'clickhouse' } },
  infrastructure,
)?.ruleId, fixture.expected.nonAgentF2RuleId);
assert.equal(registry.semanticDecision(
  { event: { ProcessExit: { pid: 42 } }, process: { comm: 'kafka-run-class' } },
  infrastructure,
)?.ruleId, fixture.expected.internalLifecycleF2RuleId);
assert.equal(registry.semanticDecision(
  { event: { ToolExec: { pid: 43, argv: ['tr'] } }, process: { comm: 'tr' } },
  {
    state: 'non_agent',
    attribution: {
      monitored: false, classification: 'non_agent', confidence: 1, source: 'process_graph',
      evidence: ['filter_rule:fr_builtin_non_agent_runtime_vscode_cpu_sampler:r1'],
    },
  },
)?.ruleId, fixture.expected.nonAgentFamilyF2RuleId);
assert.equal(registry.semanticDecision(
  { event: { FileAccess: { path: '/home/user/a' } }, process: { comm: 'cat' } },
  unknown,
)?.ruleId, fixture.expected.unknownF2RuleId);

console.log('PASS TypeScript compiler and Node Forwarder unified Filter Rule golden fixture');
