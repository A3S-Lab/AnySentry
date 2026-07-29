#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  AgentTemplateRegistry,
  loadTemplateDocument,
} = require('./observer-agent-templates');

const registry = new AgentTemplateRegistry({
  templates: [
    {
      id: 'simple-docker',
      agentId: 'claw',
      deployment: 'docker',
      name: 'claw',
    },
    {
      id: 'k8s-review',
      agentId: 'review-agent',
      deployment: 'kubernetes',
      match: {
        namespace: 'agents-*',
        pod: 'review-*',
        container: 'agent',
      },
    },
    {
      id: 'host-service',
      agentId: 'host-agent',
      deployment: 'host',
      match: {
        systemdUnit: 'host-agent*.service',
      },
    },
    {
      id: 'explicit-infra',
      deployment: 'kubernetes',
      classification: 'non_agent',
      match: {
        namespace: 'monitoring',
        pod: 'prometheus-*',
      },
    },
  ],
});

const docker = registry.classifyEntry({
  source: 'docker',
  environment: 'docker',
  containerName: '/production-claw-worker',
  containerImage: 'company/claw:latest',
});
assert.equal(docker.state, 'agent');
assert.equal(docker.attribution.classification, 'confirmed_agent');
assert.equal(docker.attribution.agentScopeId, 'claw');
assert.equal(docker.attribution.source, 'self_register');

const k8s = registry.classifyEntry({
  source: 'kubernetes',
  environment: 'kubernetes',
  namespace: 'agents-production',
  podName: 'review-7b8c',
  containerName: 'agent',
});
assert.equal(k8s.state, 'agent');
assert.equal(k8s.attribution.agentScopeId, 'review-agent');

const sidecar = registry.classifyEntry({
  source: 'kubernetes',
  environment: 'kubernetes',
  namespace: 'agents-production',
  podName: 'review-7b8c',
  containerName: 'metrics',
});
assert.equal(sidecar, undefined);

const host = registry.classifyEvent({
  process: {
    pid: 42,
    comm: 'node',
    exe: '/usr/bin/node',
    cgroup: '0::/system.slice/host-agent-2.service',
  },
  event: { ToolExec: { pid: 42, argv: ['node', 'server.js'] } },
});
assert.equal(host.state, 'agent');
assert.equal(host.attribution.agentScopeId, 'host-agent');

const infra = registry.classifyEntry({
  source: 'kubernetes',
  environment: 'kubernetes',
  namespace: 'monitoring',
  podName: 'prometheus-server-0',
  containerName: 'prometheus',
});
assert.equal(infra.state, 'non_agent');
assert.equal(infra.attribution.classification, 'non_agent');

const unknown = registry.classifyEntry({
  source: 'kubernetes',
  environment: 'kubernetes',
  namespace: 'agents-production',
  podName: 'new-unknown-runtime',
  containerName: 'runtime',
});
assert.equal(unknown, undefined);

const loaded = loadTemplateDocument({
  env: {
    ANYSENTRY_AGENT_TEMPLATES_JSON: JSON.stringify([
      { id: 'inline', agentId: 'inline-agent', deployment: 'host', name: 'inline-agent' },
    ]),
  },
});
assert.equal(loaded.templates.length, 1);
assert.equal(loaded.schemaVersion, 'anysentry.agent_templates.v1');

const ambiguous = new AgentTemplateRegistry({
  templates: [
    { id: 'a', agentId: 'agent-a', deployment: 'docker', name: 'shared' },
    { id: 'b', agentId: 'agent-b', deployment: 'docker', name: 'shared' },
  ],
}).classifyEntry({
  source: 'docker',
  environment: 'docker',
  containerName: 'shared',
});
assert.equal(ambiguous.state, 'unknown');
assert.match(ambiguous.attribution.evidence[0], /template_ambiguous/);

console.log('Agent template verification passed');
