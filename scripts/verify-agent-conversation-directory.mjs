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

const runtime = (agentInstanceId, runtimeState, product = 'codex') => ({
  agentScopeId: 'scope-' + agentInstanceId,
  agentDisplayName: product,
  agentInstanceId,
  runtimeState,
  rootPid: 10,
  rootStartTimeTicks: '1',
  rootGeneration: 1,
  hostId: 'fixture-host',
  bootId: 'fixture-boot',
  workspacePath: '/workspace/repo',
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
    at: '1788000000000000001',
  }),
  conversation({
    conversationId: 'cv-codex-b',
    agentAssetId: 'asset-codex-b',
    agentInstanceIds: ['instance-b'],
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
], 'all');

assert.equal(items.length, 2);
const codex = items.find((item) => item.product === 'Codex');
const claude = items.find((item) => item.product === 'Claude Code');
assert(codex);
assert(claude);
assert.equal(codex.lifecycleState, 'running');
assert.equal(codex.activeInstanceCount, 2);
assert.equal(codex.totalInstanceCount, 2);
assert.equal(codex.conversationCount, 2);
assert.deepEqual(codex.agentAssetIds.sort(), ['asset-codex-a', 'asset-codex-b']);
assert.equal(codex.conversations[0].conversationId, 'cv-codex-b');
assert.equal(claude.lifecycleState, 'historical');

const runningOnly = projectAgentConversationDirectory(
  items.flatMap((item) => item.conversations),
  [runtime('instance-a', 'running'), runtime('instance-b', 'running')],
  'running',
);
assert.equal(runningOnly.length, 1);
assert.equal(runningOnly[0].product, 'Codex');

console.log('agent conversation directory verification passed');
