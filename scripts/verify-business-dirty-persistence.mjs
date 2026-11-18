import assert from 'node:assert/strict';

const build = process.env.ANYSENTRY_TEST_BUILD || 'dist';
const { AlertingService } = await import(`../apps/api/${build}/security-monitoring/alerting.service.js`);
const { RemediationService } = await import(`../apps/api/${build}/security-monitoring/remediation.service.js`);

async function verify({ Service, collection, persisted, id, saveMethod, fallbackMethod }) {
  const writes = [];
  const fallbacks = [];
  let saveResult = true;
  const first = { [id]: 'one', updatedAt: 1 };
  const second = { [id]: 'two', updatedAt: 1 };
  const service = Object.assign(Object.create(Service.prototype), {
    [collection]: new Map([['one', first], ['two', second]]),
    [persisted]: new Map(),
    persistRequested: false,
    relational: {
      async [saveMethod](records) {
        writes.push(records);
        return saveResult;
      },
    },
    ch: {
      async [fallbackMethod](records) { fallbacks.push(records); },
    },
  });

  await service.drainPersistence();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].length, 2, 'initial synchronization persists all records');
  assert.equal(fallbacks.length, 0, 'healthy PostgreSQL must not dual-write a large CH snapshot');

  await service.drainPersistence();
  assert.equal(writes.length, 1, 'an unchanged persistence cycle must be a complete no-op');

  const changed = { ...first, updatedAt: 2 };
  service[collection].set('one', changed);
  await service.drainPersistence();
  assert.deepEqual(writes.at(-1), [changed], 'only the changed immutable record is persisted');
  assert.equal(fallbacks.length, 0);

  const failed = { ...second, updatedAt: 3 };
  service[collection].set('two', failed);
  saveResult = false;
  await service.drainPersistence();
  assert.equal(fallbacks.length, 1, 'a PostgreSQL failure must retain the full CH fallback');
  assert.equal(fallbacks[0].length, 2);
  assert.notEqual(service[persisted].get('two'), failed, 'failed PG writes must remain dirty');
}

await verify({
  Service: AlertingService,
  collection: 'alerts',
  persisted: 'relationalPersistedAlerts',
  id: 'alertId',
  saveMethod: 'saveAlerts',
  fallbackMethod: 'saveAlertState',
});
await verify({
  Service: RemediationService,
  collection: 'state',
  persisted: 'relationalPersistedTasks',
  id: 'taskId',
  saveMethod: 'saveRemediations',
  fallbackMethod: 'saveRemediationState',
});

console.log('PASS: business persistence writes dirty rows and retains full ClickHouse failover');
