#!/usr/bin/env node

/**
 * Local contract check for management metadata identity fences. Values are synthetic and the
 * verifier uses no network or credentials. Build the API first.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AgentMetadataService } = require(
  '../apps/api/dist/security-monitoring/agent-metadata.service.js',
);

const clickhouse = {
  init: async () => false,
  loadAgentMetadata: async () => [],
  saveAgentMetadata: async () => true,
};
const relational = {
  initialize: async () => false,
  configured: () => false,
  loadAgentMetadata: async () => [],
  saveAgentMetadata: async () => true,
};
const service = new AgentMetadataService(clickhouse, relational);
const workspacePath = `/workspace/metadata-boundary-${Date.now()}`;

service.update('shared-agent', {
  workspacePath,
  logicalAgentId: 'logical-a',
  logicalDefinitionId: 'definition-a',
  logicalDefinitionType: 'registered',
  logicalScopeMode: 'registered_definition',
  tenantId: 'tenant-a',
  ownerId: 'owner-a',
  profile: 'profile-a',
  ingestionSourceId: 'source-a',
});
service.update('shared-agent', {
  workspacePath,
  logicalAgentId: 'logical-b',
  logicalDefinitionId: 'definition-b',
  logicalDefinitionType: 'registered',
  logicalScopeMode: 'registered_definition',
  tenantId: 'tenant-b',
  ownerId: 'owner-b',
  profile: 'profile-b',
  ingestionSourceId: 'source-b',
});

const items = service.list().filter((item) => item.workspacePath === workspacePath);
assert.equal(items.length, 2, 'different tenant/definition registrations must remain distinct');
assert.deepEqual(
  new Set(items.map((item) => item.logicalAgentId)),
  new Set(['logical-a', 'logical-b']),
);
assert.equal(
  service.resolveRegisteredDefinition('/workspace/other', 'other-agent', items[0].agentAssetId, {
    tenantId: 'tenant-a',
    sourceId: 'source-a',
  }),
  undefined,
  'an asset alias cannot promote a definition across workspace/agent boundaries',
);
assert.throws(
  () => service.update('other-agent', {
    workspacePath,
    agentAssetId: items[0].agentAssetId,
    displayName: 'cross-agent mutation attempt',
  }),
  /workspace or agent/u,
  'a metadata mutation cannot reuse another Agent asset in the same workspace',
);
assert.equal(
  service.list().filter((item) => item.workspacePath === workspacePath).length,
  2,
  'a rejected cross-agent mutation leaves both registrations intact',
);

assert(service.resolveRegisteredDefinition(workspacePath, 'shared-agent', undefined, {
  tenantId: 'tenant-a',
  sourceId: 'source-a',
}).logicalAgentId === 'logical-a');
assert(service.resolveRegisteredDefinition(workspacePath, 'shared-agent', undefined, {
  tenantId: 'tenant-b',
  sourceId: 'source-b',
}).logicalAgentId === 'logical-b');
assert.equal(
  service.resolveRegisteredDefinition(workspacePath, 'shared-agent', undefined, {
    tenantId: 'tenant-mismatch',
    sourceId: 'source-a',
  }),
  undefined,
  'a mismatched tenant must not inherit a sole/legacy registration',
);

const workflowWorkspace = `${workspacePath}/dify-workflow`;
const workflowBase = {
  workspacePath: workflowWorkspace,
  logicalAgentId: 'dify-logical-workflow',
  logicalDefinitionId: 'dify-workflow-definition',
  logicalDefinitionType: 'workflow',
  logicalScopeMode: 'workflow_definition',
  tenantId: 'tenant-workflow',
  ownerId: 'owner-workflow',
  ingestionSourceId: 'source-workflow',
};
service.update('dify', { ...workflowBase, profile: 'test', profileVersion: 'v1' });
service.update('dify', { ...workflowBase, profile: 'production', profileVersion: 'v1' });
const workflowItems = service.list().filter((item) => item.workspacePath === workflowWorkspace);
assert.equal(workflowItems.length, 2,
  'Dify test/production profile records must not overwrite one another');
assert.deepEqual(new Set(workflowItems.map((item) => item.profile)), new Set(['test', 'production']));

const environmentWorkspace = `${workspacePath}/dify-environment`;
const environmentBase = {
  workspacePath: environmentWorkspace,
  logicalAgentId: 'dify-logical-environment-fixture',
  logicalDefinitionId: 'dify-environment-definition',
  logicalDefinitionType: 'workflow',
  logicalScopeMode: 'workflow_definition',
  tenantId: 'tenant-environment',
  ownerId: 'owner-environment',
  profile: 'shared-profile',
  ingestionSourceId: 'source-environment',
};
service.update('dify', { ...environmentBase, environmentId: 'test' });
service.update('dify', { ...environmentBase, environmentId: 'production' });
const environmentItems = service.list().filter((item) => item.workspacePath === environmentWorkspace);
assert.equal(environmentItems.length, 2,
  'Dify test/production environments must remain distinct AgentInstance registrations');
const testEnvironmentDefinition = service.resolveRegisteredDefinition(environmentWorkspace, 'dify', undefined, {
  tenantId: 'tenant-environment', sourceId: 'source-environment', environmentId: 'test',
});
const productionEnvironmentDefinition = service.resolveRegisteredDefinition(environmentWorkspace, 'dify', undefined, {
  tenantId: 'tenant-environment', sourceId: 'source-environment', environmentId: 'production',
});
assert.equal(testEnvironmentDefinition.environmentId, 'test');
assert.equal(productionEnvironmentDefinition.environmentId, 'production');
assert.equal(testEnvironmentDefinition.logicalAgentId, productionEnvironmentDefinition.logicalAgentId,
  'environment/deployment is an AgentInstance fence, not a new LogicalAgent definition');
assert.equal(testEnvironmentDefinition.definitionFingerprint, productionEnvironmentDefinition.definitionFingerprint,
  'the same registered workflow definition keeps one logical fingerprint across environments');

const definitionOnlyWorkspace = `${workspacePath}/definition-only`;
const definitionOnlyBase = {
  workspacePath: definitionOnlyWorkspace,
  logicalDefinitionId: 'shared-workflow-definition',
  logicalDefinitionType: 'workflow',
  logicalScopeMode: 'workflow_definition',
  ownerId: 'owner-definition-only',
  ingestionSourceId: 'source-definition-only',
};
service.update('dify', { ...definitionOnlyBase, tenantId: 'tenant-definition-a', profile: 'test' });
service.update('dify', { ...definitionOnlyBase, tenantId: 'tenant-definition-b', profile: 'production' });
const definitionOnlyItems = service.list().filter((item) => item.workspacePath === definitionOnlyWorkspace);
assert.equal(definitionOnlyItems.length, 2,
  'a definition-only registration must remain tenant/profile scoped');

await service.onModuleDestroy();
console.log('Agent metadata identity-boundary verification passed');
