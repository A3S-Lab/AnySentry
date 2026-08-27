import assert from 'node:assert/strict';

const { IngestionSourceService } = await import(
  '../apps/api/dist/security-monitoring/ingestion-source.service.js'
);
const { WorkspaceDirectoryService } = await import(
  '../apps/api/dist/security-monitoring/workspace-directory.service.js'
);
const { RelationalBusinessStore } = await import(
  '../apps/api/dist/security-monitoring/relational-business-store.service.js'
);

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function eventually(message, predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

function clearScheduledPersistence(service) {
  if (service.persistTimer) clearTimeout(service.persistTimer);
  service.persistTimer = undefined;
}

{
  const relational = new RelationalBusinessStore();
  relational.ready = true;
  relational.pool = {
    connect: async () => {
      throw new Error('synthetic pool checkout timeout');
    },
  };
  const binding = {
    bindingId: 'single-flight-binding',
    agentAssetId: 'single-flight-agent',
    workspaceId: 'single-flight-workspace',
    workspacePath: '/srv/single-flight',
    validFrom: 100,
    lastObservedAt: 100,
    updatedAt: 100,
  };
  assert.equal(
    await relational.saveAgentWorkspaceBindings([binding]),
    false,
    'a Workspace binding pool-checkout timeout must use the migration fallback',
  );
  assert.equal(
    await relational.saveBusinessRecords(
      [{ id: 'single-flight-object' }],
      'save synthetic records',
      (record) => record.id,
      async () => undefined,
    ),
    false,
    'a generic business-state pool-checkout timeout must use the migration fallback',
  );
}

{
  const calls = [];
  const gates = [];
  let active = 0;
  let maximumActive = 0;
  const relational = {
    isReady: () => true,
    saveIngestionSources: async (records) => {
      const gate = deferred();
      gates.push(gate);
      calls.push(structuredClone(records));
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await gate.promise;
      active -= 1;
      return true;
    },
  };
  const sourceService = new IngestionSourceService({}, {}, relational);
  sourceService.ch = { saveIngestionSources: async () => undefined };

  const created = sourceService.create({
    name: 'single-flight source v1',
    type: 'observer',
    enabled: true,
    requireToken: false,
  });
  const firstPersist = sourceService.persist();
  assert.equal(calls.length, 1);

  sourceService.update(created.source.sourceId, { name: 'single-flight source v2' });
  const queuedPersist = sourceService.persist();
  assert.strictEqual(queuedPersist, firstPersist, 'overlapping source saves must share one promise');
  assert.equal(calls.length, 1, 'a second source transaction must not start while the first is active');

  gates[0].resolve();
  await eventually('the queued source snapshot was not persisted', () => calls.length === 2);
  assert.equal(calls[1][0]?.name, 'single-flight source v2');
  gates[1].resolve();
  await queuedPersist;
  assert.equal(maximumActive, 1, 'source persistence transactions must be serialized');
}

{
  const workspaceCalls = [];
  const bindingCalls = [];
  const gates = [];
  const relational = {
    configured: () => false,
    isReady: () => true,
    saveWorkspaceDirectory: async (records) => {
      const gate = deferred();
      gates.push(gate);
      workspaceCalls.push(structuredClone(records));
      await gate.promise;
      return true;
    },
    saveAgentWorkspaceBindings: async (records) => {
      const callIndex = bindingCalls.length;
      bindingCalls.push(structuredClone(records));
      await gates[callIndex].promise;
      return true;
    },
  };
  const directory = new WorkspaceDirectoryService(relational, {});

  directory.observeAssociation('single-flight-agent', '/srv/single-flight', 100, 'node-a');
  clearScheduledPersistence(directory);
  const firstPersist = directory.persist();
  assert.equal(workspaceCalls.length, 1);
  assert.equal(bindingCalls.length, 1);

  directory.observeAssociation('single-flight-agent', '/srv/single-flight', 200, 'node-a');
  clearScheduledPersistence(directory);
  const queuedPersist = directory.persist();
  assert.strictEqual(queuedPersist, firstPersist, 'overlapping directory saves must share one promise');
  assert.equal(workspaceCalls.length, 1, 'a second directory transaction must wait for the first');
  assert.equal(bindingCalls.length, 1, 'a second binding transaction must wait for the first');

  gates[0].resolve();
  await eventually('the queued Workspace snapshot was not persisted', () => workspaceCalls.length === 2);
  assert.equal(workspaceCalls[1][0]?.lastSeenAt, 200);
  assert.equal(bindingCalls[1][0]?.lastObservedAt, 200);
  gates[1].resolve();
  await queuedPersist;
  assert.equal(directory.dirtyWorkspaceIds.size, 0);
  assert.equal(directory.dirtyBindingIds.size, 0);
}

console.log('Persistence single-flight verification passed');
