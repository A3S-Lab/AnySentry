import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { IngestionSourceService } = await import(
  '../apps/api/dist/security-monitoring/ingestion-source.service.js'
);
const { AlertingService } = await import(
  '../apps/api/dist/security-monitoring/alerting.service.js'
);
const { RemediationService } = await import(
  '../apps/api/dist/security-monitoring/remediation.service.js'
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
  assert.equal(calls[0].length, 1, 'source persistence sends only the dirty source on the first flush');
  assert.equal(calls[1].length, 1, 'source persistence sends only the changed source on the queued flush');
  const callsAfterClean = calls.length;
  clearScheduledPersistence(sourceService);
  await sourceService.persist();
  assert.equal(calls.length, callsAfterClean, 'a clean source queue must not rewrite the full snapshot');
  assert.equal(sourceService.stateStatus().persistence.dirty, 0);
}

{
  const relational = {
    configured: () => true,
    isReady: () => true,
    saveIngestionSources: async () => false,
  };
  const sourceService = new IngestionSourceService(
    { enabled: true, saveIngestionSources: async () => undefined },
    {},
    relational,
  );
  sourceService.initialized = true;
  const created = sourceService.create({
    name: 'dirty-failure source',
    type: 'observer',
    enabled: true,
    requireToken: false,
  });
  clearScheduledPersistence(sourceService);
  await sourceService.persist();
  const persistence = sourceService.stateStatus().persistence;
  assert.equal(persistence.dirty, 1, 'failed source persistence keeps the dirty key for retry');
  assert.equal(persistence.failures, 1, 'failed source persistence is visible in status');
  assert.equal(persistence.retryScheduled, true, 'failed source persistence schedules one bounded retry');
  await sourceService.onModuleDestroy();
  assert.equal(sourceService.stateStatus().persistence.retryScheduled, false);
  assert(created.source.sourceId);
}

{
  const relationalCalls = [];
  const clickhouseCalls = [];
  const alerting = new AlertingService(
    {
      init: async () => false,
      saveAlertState: async (alerts) => clickhouseCalls.push(structuredClone(alerts)),
    },
    { activeFor: () => false },
    { config: () => ({ summary: { enabledChannels: 0 } }), dispatch: async () => 0 },
    { snapshot: () => [] },
    { get: () => undefined },
    {
      configured: () => true,
      isReady: () => true,
      saveAlerts: async (alerts) => {
        relationalCalls.push(structuredClone(alerts));
        return true;
      },
    },
  );
  alerting.initialized = true;
  const blocked = (eventId, at) => ({
    eventId,
    eventKind: 'ToolExec',
    eventCategory: 'tool',
    at,
    source: 'observer',
    sourceId: 'source-alert-fixture',
    subject: 'blocked command',
    verdict: 'block',
    tier: 'Rules',
    severity: 'critical',
    reason: 'blocked',
    riskCategory: 'command_danger',
    riskName: 'dangerous command',
    riskType: 'atomic',
    riskScore: 95,
    workspacePath: '/workspace/alert-fixture',
    agentId: 'alert-fixture',
    sessionId: 'session-alert-fixture',
    userId: 'fixture-user',
    traceId: 'trace-alert-fixture',
    runId: eventId,
    attributes: {},
  });
  alerting.observeEvent(blocked('alert-event-1', 1_000));
  clearScheduledPersistence(alerting);
  await alerting.persist();
  assert.equal(relationalCalls.length, 1);
  assert.equal(relationalCalls[0].length, 1, 'alert flush sends only the dirty alert');
  alerting.observeEvent(blocked('alert-event-2', 2_000));
  clearScheduledPersistence(alerting);
  await alerting.persist();
  assert.equal(relationalCalls.length, 2);
  assert.equal(relationalCalls[1].length, 1, 'alert update does not rewrite unrelated alerts');
  assert.equal(clickhouseCalls.at(-1).length, 1, 'ClickHouse keeps its complete compatibility snapshot');
  const alertCallsAfterClean = relationalCalls.length;
  clearScheduledPersistence(alerting);
  await alerting.persist();
  assert.equal(relationalCalls.length, alertCallsAfterClean, 'a clean alert queue must not rewrite the full snapshot');
  assert.equal(alerting.stateStatus().persistence.dirty, 0);
  const periodicTask = {
    taskId: 'periodic-remediation-fixture',
    sourceType: 'alert',
    status: 'open',
    severity: 'high',
    actionKind: 'investigate',
    title: 'periodic alert',
    description: 'unchanged periodic state',
    recommendedAction: 'inspect',
    createdAt: 1_000,
    updatedAt: 1_000,
    dueAt: '1970-01-01 00:00:00',
    labels: {},
    steps: [],
  };
  alerting.observeRemediation(periodicTask, 3_000);
  clearScheduledPersistence(alerting);
  await alerting.persist();
  const periodicCalls = relationalCalls.length;
  alerting.observeRemediation(periodicTask, 4_000);
  clearScheduledPersistence(alerting);
  await alerting.persist();
  assert.equal(relationalCalls.length, periodicCalls,
    'unchanged increment=false alert state must not be rewritten on every overdue scan');
  await alerting.onModuleDestroy();
}

{
  const relationalCalls = [];
  const clickhouseCalls = [];
  let observedOverdue = 0;
  const task = {
    taskId: 'remediation-single-flight',
    sourceType: 'alert',
    sourceId: 'alert-single-flight',
    status: 'open',
    severity: 'high',
    actionKind: 'investigate',
    title: 'single-flight remediation',
    description: 'bounded persistence fixture',
    recommendedAction: 'inspect',
    createdAt: 1_000,
    updatedAt: 1_000,
    labels: {},
    steps: [],
  };
  const remediation = new RemediationService(
    {
      enabled: true,
      init: async () => false,
      saveRemediationState: async (records) => clickhouseCalls.push(structuredClone(records)),
    },
    {
      incidents: () => ({ items: [] }),
      coverageOverview: () => ({ issues: [] }),
    },
    {
      list: () => ({ items: [] }),
      observeRemediation: () => { observedOverdue += 1; },
      reconcileRemediationOverdue: () => {},
      observeCoverageList: () => {},
      isActiveAlert: () => true,
      isVerificationSourceId: () => false,
    },
    {
      configured: () => true,
      isReady: () => true,
      loadRemediations: async () => [],
      saveRemediations: async (records) => {
        relationalCalls.push(structuredClone(records));
        return true;
      },
    },
  );
  remediation.state.set(task.taskId, structuredClone(task));
  remediation.initialized = true;
  const firstUpdate = remediation.update(task.taskId, { note: 'first update' });
  assert(firstUpdate);
  clearScheduledPersistence(remediation);
  await remediation.persist();
  assert.equal(relationalCalls.length, 1);
  assert.equal(relationalCalls[0].length, 1, 'remediation flush sends only the dirty task');

  // A second unchanged task must not be included in a later write.
  const untouched = { ...task, taskId: 'remediation-untouched' };
  remediation.state.set(untouched.taskId, structuredClone(untouched));
  remediation.state.set(task.taskId, { ...firstUpdate, note: 'second update', updatedAt: 2_000 });
  remediation.markTaskDirty(task.taskId);
  clearScheduledPersistence(remediation);
  await remediation.persist();
  assert.equal(relationalCalls.length, 2);
  assert.equal(relationalCalls[1].length, 1);
  assert.equal(relationalCalls[1][0].taskId, task.taskId);
  assert.equal(clickhouseCalls.at(-1).length, 2, 'ClickHouse keeps the complete remediation snapshot');

  // Overdue alert reconciliation is idempotent until a task fingerprint (or overdue boundary)
  // changes, so a GET/periodic scan cannot rewrite the same Alert repeatedly.
  remediation.overdueAlertSync.clear();
  remediation.syncOverdueAlerts(3_000);
  const firstOverdueSync = observedOverdue;
  remediation.syncOverdueAlerts(3_000);
  assert.equal(observedOverdue, firstOverdueSync);
  remediation.state.set(task.taskId, { ...remediation.state.get(task.taskId), note: 'changed state' });
  remediation.markTaskDirty(task.taskId);
  remediation.syncOverdueAlerts(3_000);
  assert.equal(observedOverdue, firstOverdueSync + 1);

  clearScheduledPersistence(remediation);
  await remediation.persist();
  const callsAfterClean = relationalCalls.length;
  clearScheduledPersistence(remediation);
  await remediation.persist();
  assert.equal(relationalCalls.length, callsAfterClean, 'a clean remediation queue must not rewrite the snapshot');
  assert.equal(remediation.stateStatus().persistence.dirty, 0);
  await remediation.onModuleDestroy();
}

{
  const remediation = new RemediationService(
    { enabled: true, saveRemediationState: async () => undefined },
    { incidents: () => ({ items: [] }), coverageOverview: () => ({ issues: [] }) },
    { list: () => ({ items: [] }), observeRemediation: () => {}, reconcileRemediationOverdue: () => {}, observeCoverageList: () => {}, isActiveAlert: () => true, isVerificationSourceId: () => false },
    { configured: () => true, isReady: () => true, saveRemediations: async () => false },
  );
  remediation.initialized = true;
  remediation.state.set('remediation-failure', {
    taskId: 'remediation-failure',
    sourceType: 'alert',
    status: 'open',
    severity: 'high',
    actionKind: 'investigate',
    title: 'failure fixture',
    description: 'failure fixture',
    recommendedAction: 'inspect',
    createdAt: 1,
    updatedAt: 1,
    labels: {},
    steps: [],
  });
  remediation.markTaskDirty('remediation-failure');
  clearScheduledPersistence(remediation);
  await remediation.persist();
  const persistence = remediation.stateStatus().persistence;
  assert.equal(persistence.dirty, 1);
  assert.equal(persistence.failures, 1);
  assert.equal(persistence.retryScheduled, true);
  await remediation.onModuleDestroy();
  assert.equal(remediation.stateStatus().persistence.retryScheduled, false);
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

const relationalSource = readFileSync(
  new URL('../apps/api/src/security-monitoring/relational-business-store.service.ts', import.meta.url),
  'utf8',
);
assert.match(relationalSource, /pool\.on\('connect',[\s\S]*client\.on\('error'/u,
  'every physical PostgreSQL client must retain an error listener while checked out');

console.log('Persistence single-flight verification passed');
