import assert from 'node:assert/strict';

import { projectAgentConversationDirectory } from '../apps/api/dist/security-monitoring/agent-conversation-directory.js';

const coverage = (status = 'complete') => ({
  status,
  reasons: status === 'complete' ? [] : ['fixture_reason'],
  completeInteractions: status === 'complete' ? 1 : 0,
  partialInteractions: status === 'complete' ? 0 : 1,
});

const conversation = ({
  conversationId,
  agentAssetId,
  agentInstanceIds,
  product = 'codex-cli',
  workspacePath = '/workspace/repo',
  environment = 'docker',
  at,
  status = 'complete',
}) => ({
  conversationId,
  idSource: 'inferred',
  hasContent: status === 'complete',
  agentAssetId,
  agentInstanceIds,
  agentProduct: product,
  displayName: product,
  environment,
  classification: 'confirmed_agent',
  workspacePath,
  startedAtUnixNs: at,
  lastActivityAtUnixNs: at,
  firstPromptPreview: 'fixture prompt',
  turnCount: 1,
  modelCallCount: status === 'complete' ? 1 : 0,
  toolCallCount: 0,
  toolResultCount: 0,
  errorCount: status === 'complete' ? 0 : 1,
  models: status === 'complete' ? ['fixture-model'] : [],
  coverage: coverage(status),
});

const runtime = (
  agentInstanceId,
  runtimeState,
  product = 'codex',
  workspacePath = '/workspace/repo',
  physicalWorkloadId,
) => ({
  agentScopeId: 'scope-' + agentInstanceId,
  agentDisplayName: product,
  agentInstanceId,
  runtimeState,
  rootPid: 10,
  rootStartTimeTicks: '1',
  rootGeneration: 1,
  hostId: 'fixture-host',
  bootId: 'fixture-boot',
  workspacePath,
  physicalWorkloadId,
  discoveredAt: 1,
  lastSeenAt: 2,
  collectorId: 'fixture-collector',
  forwarderInstanceId: 'fixture-forwarder',
  leaseEpoch: 1,
  snapshotVersion: 1,
  snapshotHash: 'a'.repeat(64),
  filterMode: 'enforce',
  receivedAt: 2,
});

const items = projectAgentConversationDirectory([
  conversation({
    conversationId: 'cv-codex-a',
    agentAssetId: 'asset-codex-a',
    agentInstanceIds: ['instance-a'],
    environment: 'host',
    at: '1788000000000000001',
  }),
  conversation({
    conversationId: 'cv-codex-b',
    agentAssetId: 'asset-codex-b',
    agentInstanceIds: ['instance-b'],
    environment: 'unknown',
    at: '1788000000000000002',
  }),
  conversation({
    conversationId: 'cv-claude',
    agentAssetId: 'asset-claude',
    agentInstanceIds: ['instance-claude'],
    product: 'claude-code',
    at: '1788000000000000003',
  }),
], [
  runtime('instance-a', 'running'),
  runtime('instance-b', 'running'),
  runtime('instance-claude', 'exited', 'claude'),
  {
    ...runtime('instance-langchain', 'running', 'LangChain'),
    workspacePath: undefined,
    agentScopeId: 'langchain-runtime',
  },
], 'all');

assert.equal(items.length, 3);
const codex = items.find((item) => item.product === 'Codex');
const claude = items.find((item) => item.product === 'Claude Code');
const langchain = items.find((item) => item.product === 'LangChain');
assert(codex);
assert(claude);
assert(langchain);
assert.equal(codex.lifecycleState, 'running');
assert.equal(codex.environment, 'host');
assert.equal(codex.activeInstanceCount, 2);
assert.equal(codex.totalInstanceCount, 2);
assert.equal(codex.conversationCount, 2);
assert.deepEqual(codex.agentAssetIds.sort(), ['asset-codex-a', 'asset-codex-b']);
assert.equal(codex.conversations[0].conversationId, 'cv-codex-b');
assert.equal(claude.lifecycleState, 'historical');
assert.equal(langchain.lifecycleState, 'running');
assert.equal(langchain.conversationCount, 0);
assert.equal(langchain.conversations.length, 0);

const runningOnly = projectAgentConversationDirectory(
  items.flatMap((item) => item.conversations),
  [
    runtime('instance-a', 'running'),
    runtime('instance-b', 'running'),
    {
      ...runtime('instance-langchain', 'running', 'LangChain'),
      workspacePath: undefined,
      agentScopeId: 'langchain-runtime',
    },
  ],
  'running',
);
assert.equal(runningOnly.length, 2);
assert.deepEqual(runningOnly.map((item) => item.product).sort(), ['Codex', 'LangChain']);

const aliasFallback = projectAgentConversationDirectory([
  conversation({
    conversationId: 'cv-codex-legacy',
    agentAssetId: 'asset-codex-legacy',
    agentInstanceIds: ['legacy-instance-id'],
    at: '1788000000000000004',
  }),
], [runtime('current-runtime-id', 'running')], 'all');
assert.equal(aliasFallback[0].lifecycleState, 'running');
assert.equal(aliasFallback[0].activeInstanceCount, 1);

const syntheticDify = projectAgentConversationDirectory([
  conversation({
    conversationId: 'cv-dify-a',
    agentAssetId: 'asset-dify-a',
    agentInstanceIds: ['dify-instance-a'],
    product: 'dify-worker',
    workspacePath: 'agent://container-a',
    environment: 'docker',
    at: '1788000000000000005',
  }),
  conversation({
    conversationId: 'cv-dify-b',
    agentAssetId: 'asset-dify-b',
    agentInstanceIds: ['dify-instance-b'],
    product: 'Dify',
    workspacePath: 'agent://container-b',
    environment: 'docker',
    at: '1788000000000000006',
  }),
], [
  runtime('dify-instance-a', 'running', 'Dify', null, 'docker:container-a'),
  runtime('dify-instance-b', 'running', 'dify-worker', null, 'docker:container-b'),
  runtime('dify-instance-c', 'running', 'Dify', null, 'docker:container-c'),
  runtime('dify-instance-d', 'running', 'Dify', null, 'docker:container-d'),
], 'all');
assert.equal(syntheticDify.length, 1);
assert.equal(syntheticDify[0].product, 'Dify');
assert.equal(syntheticDify[0].workspacePath, 'agent-scope:dify');
assert.equal(syntheticDify[0].environment, 'docker');
assert.equal(syntheticDify[0].groupingQuality, 'inferred');
assert.equal(syntheticDify[0].lifecycleState, 'running');
assert.equal(syntheticDify[0].activeInstanceCount, 4);
assert.equal(syntheticDify[0].totalInstanceCount, 4);
assert.equal(syntheticDify[0].conversationCount, 2);

const realWorkspaceIsolation = projectAgentConversationDirectory([
  conversation({
    conversationId: 'cv-dify-project-a',
    agentAssetId: 'asset-dify-project-a',
    agentInstanceIds: ['dify-project-a'],
    product: 'Dify',
    workspacePath: '/srv/project-a',
    environment: 'docker',
    at: '1788000000000000007',
  }),
  conversation({
    conversationId: 'cv-dify-project-b',
    agentAssetId: 'asset-dify-project-b',
    agentInstanceIds: ['dify-project-b'],
    product: 'Dify',
    workspacePath: '/srv/project-b',
    environment: 'docker',
    at: '1788000000000000008',
  }),
], [], 'all');
assert.equal(realWorkspaceIsolation.length, 2);
assert.deepEqual(
  realWorkspaceIsolation.map((item) => item.workspacePath).sort(),
  ['/srv/project-a', '/srv/project-b'],
);

console.log('agent conversation directory verification passed');
