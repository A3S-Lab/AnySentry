import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const { WorkspaceDirectoryService } = await import(
  '../apps/api/dist/security-monitoring/workspace-directory.service.js'
);

const persisted = {
  workspaces: new Map(),
  bindings: new Map(),
};

const relational = {
  configured: () => false,
  isReady: () => true,
  loadWorkspaceDirectory: async () => [...persisted.workspaces.values()],
  loadAgentWorkspaceBindings: async () => [...persisted.bindings.values()],
  saveWorkspaceDirectory: async (records) => {
    for (const record of records) persisted.workspaces.set(record.workspaceId, structuredClone(record));
    return true;
  },
  saveAgentWorkspaceBindings: async (records) => {
    for (const record of records) persisted.bindings.set(record.bindingId, structuredClone(record));
    return true;
  },
};

const agentMetadata = {
  list: () => [],
  resolveEvent: (event) => ({
    agentAssetId: event.agentAssetId,
    effectiveClassification: event.effectiveClassification ?? 'probable_agent',
    metadata: event.metadataWorkspacePath
      ? { workspacePath: event.metadataWorkspacePath }
      : undefined,
  }),
};

const event = (eventId, workspacePath, at, options = {}) => ({
  eventId,
  at,
  workspacePath,
  sourceId: 'observer-a',
  collectorId: 'collector-a',
  agentAssetId: options.agentAssetId ?? 'agent-a',
  process: { hostId: 'host-a' },
  ...(options.agentWorkspacePath
    ? { attribution: { agentWorkspacePath: options.agentWorkspacePath } }
    : {}),
  ...(options.metadataWorkspacePath
    ? { metadataWorkspacePath: options.metadataWorkspacePath }
    : {}),
  ...(options.effectiveClassification
    ? { effectiveClassification: options.effectiveClassification }
    : {}),
});

const first = new WorkspaceDirectoryService(relational, agentMetadata);
await first.onModuleInit();

const oldWorkspace = first.observeEvent(event('evt-a', '/srv/repository-a', 1_000, {
  metadataWorkspacePath: '/srv/repository-a',
}));
const nextWorkspace = first.observeEvent(event('evt-b', '/srv/repository-b', 2_000, {
  metadataWorkspacePath: '/srv/repository-b',
}));
first.observeEvent(event('evt-c', '/srv/repository-a', 3_000, {
  metadataWorkspacePath: '/srv/repository-a',
}));

assert.ok(oldWorkspace?.workspaceId);
assert.ok(nextWorkspace?.workspaceId);
assert.notEqual(oldWorkspace.workspaceId, nextWorkspace.workspaceId);

let bindings = first.bindingHistory('agent-a');
assert.equal(bindings.length, 3, 'A → B → A must preserve three validity intervals');
assert.equal(bindings.filter((binding) => binding.validTo === undefined).length, 1);
assert.equal(
  bindings.find((binding) => binding.validTo === undefined)?.workspaceId,
  oldWorkspace.workspaceId,
);

first.observeEvent(event('evt-late', '/srv/repository-b', 1_500, {
  metadataWorkspacePath: '/srv/repository-b',
}));
bindings = first.bindingHistory('agent-a');
assert.equal(
  bindings.find((binding) => binding.validTo === undefined)?.workspaceId,
  oldWorkspace.workspaceId,
  'a late event must not replace the current Workspace',
);
const late = bindings.find((binding) =>
  binding.workspaceId === nextWorkspace.workspaceId && binding.validFrom === 1_500);
assert.ok(late?.validTo !== undefined && late.validTo < 3_000);

const rootWorkspace = '/srv/agent-root';
first.observeEvent(event('evt-root-a', '/tmp/task-a', 4_000, {
  agentAssetId: 'agent-root',
  agentWorkspacePath: rootWorkspace,
}));
first.observeEvent(event('evt-root-b', '/srv/unrelated-child-cwd', 5_000, {
  agentAssetId: 'agent-root',
  agentWorkspacePath: rootWorkspace,
}));
const rootBindings = first.bindingHistory('agent-root');
assert.equal(rootBindings.length, 1, 'child cwd changes must not create Workspace migrations');
assert.equal(rootBindings[0]?.workspacePath, rootWorkspace);
assert.equal(rootBindings[0]?.validTo, undefined);

const beforeUnknown = first.status();
first.observeEvent(event('evt-unknown', '/srv/not-an-agent', 6_000, {
  agentAssetId: 'agent-unknown',
  effectiveClassification: 'unknown',
}));
assert.deepEqual(first.status(), beforeUnknown, 'unknown processes must not enter the durable directory');

const beforeLegacyChild = first.status();
first.observeEvent(event('evt-legacy-child', '/srv/legacy-child-cwd', 6_500, {
  agentAssetId: 'agent-legacy-child',
}));
assert.deepEqual(
  first.status(),
  beforeLegacyChild,
  'legacy child events without stable root Workspace evidence must not create bindings',
);

const trustedPath = '/srv/trusted-repository';
const trustedFingerprint = `sha256:${createHash('sha256').update(trustedPath).digest('hex')}`;
first.registerWorkspace({
  workspaceId: 'wsp-trusted',
  repositoryId: 'repo-trusted',
  workspacePathFingerprint: trustedFingerprint,
  displayName: 'Trusted Repository',
  scannerId: 'scanner-a',
  registeredAt: 500,
  updatedAt: 2_500,
});
assert.equal(first.resolveWorkspaceId(trustedPath, 'scanner-a'), 'wsp-trusted');

await first.onModuleDestroy();
assert.ok(persisted.workspaces.size >= 3);
assert.ok(persisted.bindings.size >= 4);

const restored = new WorkspaceDirectoryService(relational, agentMetadata);
await restored.onModuleInit();
assert.equal(restored.status().workspaceCount, persisted.workspaces.size);
assert.equal(restored.status().bindingCount, persisted.bindings.size);
assert.equal(
  restored.bindingHistory('agent-a').find((binding) => binding.validTo === undefined)?.workspaceId,
  oldWorkspace.workspaceId,
  'restart must restore the same active Workspace association',
);
assert.equal(restored.resolveWorkspaceId(trustedPath, 'scanner-a'), 'wsp-trusted');
await restored.onModuleDestroy();

console.log('Workspace directory runtime verification passed');
