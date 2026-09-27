#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { collectorLaunch, discoveryProjection } from './verify-real-agent-discovery-chain.mjs';

const require = createRequire(import.meta.url);
const { builtinFilterRules } = require('../apps/api/dist/security-monitoring/filter-rule-builtins.js');
const { compileFilterRuleProjection } = require('../apps/api/dist/security-monitoring/filter-rule-engine.js');
const { UnifiedFilterPolicyRegistry } = require('./observer-unified-filter-policy.js');
const { AgentTemplateRegistry } = require('./observer-agent-templates.js');
const { WorkloadIdentityCache } = require('./observer-workload-filter.js');
let now = Date.now();
const base = compileFilterRuleProjection({
  rules: builtinFilterRules(), catalogVersion: 17,
  domainVersions: { identity: 2, capture: 3, forwarder: 4, retention: 5 }, now,
});
const original = structuredClone(base);
const policy = new UnifiedFilterPolicyRegistry({ now: () => now });
for (let refresh = 0; refresh < 2; refresh++) {
  now += 1_000;
  const projection = discoveryProjection(base, now);
  const loaded = policy.replace(projection);
  assert.equal(loaded.ok, true, loaded.error);
  for (const field of ['captureProfileRules', 'signalEnablementRules', 'semanticRetentionRules',
    'persistenceRetentionRules', 'safetyGuardrails', 'forwarderSettings']) {
    assert.deepEqual(projection[field], base[field], `${field} must preserve real policy`);
  }
  const document = policy.agentTemplateDocument();
  const templates = new AgentTemplateRegistry(document);
  assert.equal(templates.metrics().invalid, 0);
  const docker = document.templates.find((item) => item.id === 'real-docker-template');
  const host = document.templates.find((item) => item.id === 'real-host-template');
  const cache = new WorkloadIdentityCache({ templateRegistry: templates });
  const id = 'a'.repeat(64);
  assert.equal(cache.replace({
    schemaVersion: 'anysentry.workload_identity_snapshot.v1', version: refresh + 1,
    ready: true, generatedAt: new Date(now).toISOString(), entries: [{
      ids: [id], source: 'docker', environment: 'docker', classification: 'unknown',
      containerName: docker.match.container, physicalWorkloadId: `docker:test:${id}`,
    }],
  }, 'docker'), true);
  const classified = cache.classify({
    identity: { session: id }, process: { cgroup: `0::/docker/${id}` },
    event: { ToolExec: { pid: 7, argv: ['sh', '-c', 'true'] } },
  });
  assert.equal(classified.attribution.agentScopeId, 'real-docker-template-agent');
  assert.equal(classified.attribution.classification, 'confirmed_agent');
  const hostClassified = templates.classifyEvent({
    process: { cgroup: '0::/user.slice', exe: '/usr/bin/dash' },
    event: { ToolExec: { argv: [host.match.command.slice(0, -1), '-c', 'true'] } },
  });
  assert.equal(hostClassified.attribution.agentScopeId, 'real-host-template-agent');
}
assert.deepEqual(base, original, 'fixture must not mutate the API projection');
const launch = collectorLaunch(12345, 'test-node', { sourceId: 'test', token: 'test' },
  'test', 'local:test', 'http://127.0.0.1:32653/security-center');
assert.equal(launch.env.ANYSENTRY_FILTER_RULE_PROJECTION_URL,
  'http://host.docker.internal:12345/filter-projection');
assert.equal(launch.env.ANYSENTRY_AGENT_TEMPLATES_JSON, undefined);
console.log('PASS real-discovery fixture keeps templates across unified policy refresh and preserves capture/retention');
