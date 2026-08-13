#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mergeAttributionClassifications } = require('./observer-attribution-merge.js');

function probableProcess(overrides = {}) {
  return {
    state: 'agent',
    workspacePath: '/workspace/repository',
    workspaceSource: 'agent_root',
    workspaceConflict: false,
    attribution: {
      monitored: true,
      classification: 'probable_agent',
      confidence: 0.9,
      source: 'process_graph',
      reason: 'process_lineage',
      agentScopeId: 'codex',
      agentDisplayName: 'Codex',
      agentInstanceId: 'ari_process_codex_1',
      rootPid: 4_200,
      rootKey: '["host-a","boot-a",4200,"420"]',
      rootGeneration: 1,
      evidence: ['process_lineage:agent_root', 'shared:evidence'],
      ...overrides,
    },
  };
}

// Truth table: a Docker authoritative classification supplies the decision and physical workload,
// while a missing Docker runtime instance falls back to the compatible process-root instance.
{
  const process = probableProcess();
  const docker = {
    state: 'agent',
    attribution: {
      monitored: true,
      classification: 'confirmed_agent',
      confidence: 1,
      source: 'docker',
      reason: 'authoritative_anchor',
      agentScopeId: 'codex',
      agentDisplayName: 'Codex',
      physicalWorkloadId: 'docker:host-a:container-123',
      workloadRef: {
        environment: 'docker',
        kind: 'container',
        name: 'codex-agent',
        containerName: 'codex-agent',
      },
      evidence: ['shared:evidence', 'label:anysentry.io/workload-kind=agent'],
    },
  };
  const result = mergeAttributionClassifications(process, docker, undefined);
  assert.equal(result.state, 'agent');
  assert.equal(result.attribution.classification, 'confirmed_agent');
  assert.equal(result.attribution.confidence, 1);
  assert.equal(result.attribution.source, 'docker');
  assert.equal(result.attribution.reason, 'authoritative_anchor');
  assert.equal(result.attribution.agentInstanceId, 'ari_process_codex_1');
  assert.equal(result.attribution.rootPid, 4_200);
  assert.equal(result.attribution.rootKey, '["host-a","boot-a",4200,"420"]');
  assert.equal(result.attribution.rootGeneration, 1);
  assert.equal(result.attribution.physicalWorkloadId, 'docker:host-a:container-123');
  assert.deepEqual(result.attribution.workloadRef, docker.attribution.workloadRef);
  assert.equal(result.workspacePath, '/workspace/repository');
  assert.equal(result.workspaceSource, 'agent_root');
  assert.equal(result.workspaceConflict, false);
  assert.equal(result.attribution.evidence.filter((entry) => entry === 'shared:evidence').length, 1);

  result.attribution.workloadRef.name = 'mutated';
  assert.equal(docker.attribution.workloadRef.name, 'codex-agent', 'the merge must not alias nested input data');
}

// Truth table: a Kubernetes instance is authoritative for the instance/workload fields; process
// root coordinates remain available because Kubernetes does not provide them.
{
  const process = probableProcess();
  const kubernetes = {
    state: 'agent',
    attribution: {
      monitored: true,
      classification: 'confirmed_agent',
      confidence: 1,
      source: 'kubernetes',
      reason: 'authoritative_anchor',
      agentScopeId: 'codex',
      agentDisplayName: 'Codex',
      agentInstanceId: 'pod-uid-1/agent-container-id',
      physicalWorkloadId: 'k8s:node-a:pod-uid-1:agent-container-id',
      workloadRef: {
        environment: 'kubernetes',
        kind: 'pod',
        namespace: 'agents',
        podName: 'codex-0',
        podUid: 'pod-uid-1',
        containerName: 'agent',
      },
      evidence: ['label:anysentry.io/workload-kind=agent'],
    },
  };
  const result = mergeAttributionClassifications(process, kubernetes, undefined);
  assert.equal(result.attribution.agentInstanceId, 'pod-uid-1/agent-container-id');
  assert.equal(result.attribution.rootPid, 4_200);
  assert.equal(result.attribution.rootKey, '["host-a","boot-a",4200,"420"]');
  assert.equal(result.attribution.rootGeneration, 1);
  assert.equal(result.attribution.physicalWorkloadId, 'k8s:node-a:pod-uid-1:agent-container-id');
  assert.equal(result.attribution.workloadRef.environment, 'kubernetes');
  assert.equal(result.workspacePath, '/workspace/repository');
}

// Truth table: a template can make the decision and supplement display/template fields without
// erasing the lower-level process instance and root lifecycle coordinates.
{
  const process = probableProcess({ agentDisplayName: undefined });
  const template = {
    state: 'agent',
    templateId: 'registered-codex',
    attribution: {
      monitored: true,
      classification: 'confirmed_agent',
      confidence: 1,
      source: 'self_register',
      reason: 'authoritative_anchor',
      agentScopeId: 'codex',
      agentDisplayName: 'Registered Codex',
      registryVersion: 7,
      evidence: ['template:registered-codex'],
    },
  };
  const result = mergeAttributionClassifications(process, undefined, template);
  assert.equal(result.state, 'agent');
  assert.equal(result.templateId, 'registered-codex');
  assert.equal(result.attribution.classification, 'confirmed_agent');
  assert.equal(result.attribution.source, 'self_register');
  assert.equal(result.attribution.agentDisplayName, 'Registered Codex');
  assert.equal(result.attribution.agentInstanceId, 'ari_process_codex_1');
  assert.equal(result.attribution.rootPid, 4_200);
  assert.equal(result.attribution.registryVersion, 7);
}

// Truth table: an explicit workload non-agent decision cannot be promoted by a probable process
// signature. Root facts remain auditable but monitored/state follow the authoritative decision.
{
  const workload = {
    state: 'non_agent',
    attribution: {
      monitored: false,
      classification: 'non_agent',
      confidence: 1,
      source: 'docker',
      reason: 'not_agent',
      physicalWorkloadId: 'docker:host-a:database-1',
      workloadRef: { environment: 'docker', kind: 'container', name: 'database' },
      evidence: ['label:anysentry.io/workload-kind=non-agent'],
    },
  };
  const result = mergeAttributionClassifications(probableProcess(), workload, undefined);
  assert.equal(result.state, 'non_agent');
  assert.equal(result.attribution.monitored, false);
  assert.equal(result.attribution.classification, 'non_agent');
  assert.equal(result.attribution.confidence, 1);
  assert.equal(result.attribution.source, 'docker');
  assert.equal(result.attribution.reason, 'not_agent');
  assert.equal(result.attribution.rootPid, 4_200);
  assert.equal(result.attribution.agentInstanceId, 'ari_process_codex_1');
}

// Truth table: conflicting Agent scopes/display names are explicit. The authoritative workload
// Scope wins, and the process instance is not attached to that different Scope.
{
  const workloadEvidence = Array.from({ length: 20 }, (_, index) => `workload:evidence:${index}`);
  const workload = {
    state: 'agent',
    attribution: {
      monitored: true,
      classification: 'confirmed_agent',
      confidence: 1,
      source: 'kubernetes',
      reason: 'authoritative_anchor',
      agentScopeId: 'research-agent',
      agentDisplayName: 'Research Agent',
      physicalWorkloadId: 'k8s:node-a:pod-2:container-2',
      workloadRef: { environment: 'kubernetes', kind: 'pod', podName: 'research-agent-0' },
      evidence: ['shared:evidence', ...workloadEvidence],
    },
  };
  const result = mergeAttributionClassifications(probableProcess(), workload, undefined);
  assert.equal(result.attribution.agentScopeId, 'research-agent');
  assert.equal(result.attribution.agentDisplayName, 'Research Agent');
  assert.equal(result.attribution.agentInstanceId, undefined);
  assert.equal(result.attribution.conflict, true);
  assert.ok(result.attribution.evidence.some((entry) => entry.startsWith('identity_conflict:agentScopeId:')));
  assert.ok(result.attribution.evidence.some((entry) => entry.startsWith('identity_conflict:agentDisplayName:')));
  assert.ok(result.attribution.evidence.length <= 16);
  assert.equal(new Set(result.attribution.evidence).size, result.attribution.evidence.length);
}

// Workspace conflicts survive an otherwise authoritative container classification.
{
  const process = probableProcess();
  process.workspacePath = undefined;
  process.workspaceSource = 'conflict';
  process.workspaceConflict = true;
  process.attribution.conflict = true;
  const workload = {
    state: 'agent',
    attribution: {
      classification: 'confirmed_agent',
      confidence: 1,
      source: 'docker',
      reason: 'authoritative_anchor',
      agentScopeId: 'codex',
      evidence: ['label:anysentry.io/workload-kind=agent'],
    },
  };
  const result = mergeAttributionClassifications(process, workload, undefined);
  assert.equal(result.workspacePath, undefined);
  assert.equal(result.workspaceSource, 'conflict');
  assert.equal(result.workspaceConflict, true);
  assert.equal(result.attribution.conflict, true);
}

// Infrastructure remains a separate, unconditional drop decision.
{
  const infrastructure = {
    state: 'infrastructure',
    rootPid: 1_000,
    serviceName: 'observer-forwarder',
    containerId: 'forwarder-container',
    reason: 'infrastructure_root',
    source: 'docker_label',
  };
  const workload = {
    state: 'agent',
    attribution: {
      classification: 'confirmed_agent',
      confidence: 1,
      source: 'kubernetes',
      reason: 'authoritative_anchor',
    },
  };
  assert.deepEqual(
    mergeAttributionClassifications(infrastructure, workload, undefined),
    infrastructure,
  );
}

assert.equal(mergeAttributionClassifications(undefined, undefined, undefined), undefined);

{
  const hostNonAgent = {
    state: 'non_agent',
    attribution: {
      monitored: false,
      classification: 'non_agent',
      confidence: 1,
      source: 'process_graph',
      reason: 'not_agent',
      evidence: ['process_lineage:pid1'],
    },
  };
  const unknownContainer = {
    state: 'unknown',
    attribution: {
      monitored: false,
      classification: 'unknown',
      confidence: 0,
      source: 'docker',
      reason: 'not_evaluated',
      physicalWorkloadId: 'docker:host:unlabeled',
      evidence: ['label_missing:anysentry.io/workload-kind'],
    },
  };
  assert.equal(
    mergeAttributionClassifications(hostNonAgent, unknownContainer)?.state,
    'unknown',
    'unknown container identity must not be downgraded by a host process-graph result',
  );
}

console.log('Observer attribution field-merge verification passed.');
