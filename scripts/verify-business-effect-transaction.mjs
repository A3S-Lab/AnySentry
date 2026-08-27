import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { RelationalBusinessStore } = require(
  '../apps/api/dist/security-monitoring/relational-business-store.service.js',
);
const { AlertingService } = require(
  '../apps/api/dist/security-monitoring/alerting.service.js',
);

function transactionStore(failAlerts = false) {
  const statements = [];
  const client = {
    async query(sql) {
      const text = String(sql);
      statements.push(text.trim());
      if (text.includes('SELECT status, lease_owner')) {
        return { rows: [{ status: 'pending', lease_owner: 'test-owner' }], rowCount: 1 };
      }
      if (failAlerts && text.includes('INSERT INTO anysentry_alerts')) {
        throw new Error('simulated alert persistence failure');
      }
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  const store = new RelationalBusinessStore();
  store.ready = true;
  store.effectOwnerId = 'test-owner';
  store.pool = { connect: async () => client };
  return { store, statements };
}

const successful = transactionStore();
assert.equal(
  await successful.store.commitBusinessEffect(
    'effect-success',
    [{ incidentId: 'inc-success' }],
    [{ alertId: 'alt-success' }],
    1_000,
  ),
  true,
);
assert.equal(successful.statements[0], 'BEGIN');
assert.ok(successful.statements.some((sql) => sql.includes('INSERT INTO anysentry_incidents')));
assert.ok(successful.statements.some((sql) => sql.includes('INSERT INTO anysentry_alerts')));
const ledgerUpdate = successful.statements.findIndex((sql) =>
  sql.startsWith('UPDATE anysentry_business_effects'));
const incidentWrite = successful.statements.findIndex((sql) =>
  sql.includes('INSERT INTO anysentry_incidents'));
const alertWrite = successful.statements.findIndex((sql) =>
  sql.includes('INSERT INTO anysentry_alerts'));
assert.ok(ledgerUpdate > incidentWrite && ledgerUpdate > alertWrite);
assert.equal(successful.statements.at(-1), 'COMMIT');

const failed = transactionStore(true);
assert.equal(
  await failed.store.commitBusinessEffect(
    'effect-failure',
    [{ incidentId: 'inc-failure' }],
    [{ alertId: 'alt-failure' }],
    2_000,
  ),
  false,
);
assert.ok(failed.statements.includes('ROLLBACK'));
assert.equal(
  failed.statements.some((sql) => sql.startsWith('UPDATE anysentry_business_effects')),
  false,
  'ledger must not be marked applied after mutable state persistence fails',
);

let notifications = 0;
const alerting = new AlertingService(
  { init: async () => false, saveAlertState: async () => undefined },
  { activeFor: () => false },
  {
    config: () => ({ summary: { enabledChannels: 1 } }),
    dispatch: async () => {
      notifications += 1;
      return 1;
    },
  },
  { snapshot: () => [] },
  { get: () => undefined },
  { isReady: () => true, saveAlerts: async () => true, loadAlerts: async () => [] },
);
const event = {
  eventId: 'evt-effect-rollback',
  eventKind: 'ToolExec',
  eventCategory: 'tool',
  at: 3_000,
  source: 'observer',
  sourceId: 'source',
  subject: 'blocked command',
  verdict: 'block',
  tier: 'Rules',
  severity: 'critical',
  reason: 'blocked',
  riskCategory: 'command_danger',
  riskName: '危险命令执行',
  riskType: 'atomic',
  riskScore: 95,
  workspacePath: '/workspace',
  agentId: 'agent',
  traceId: 'trace',
  attributes: {},
};
const incident = {
  incidentId: 'inc-effect-rollback',
  status: 'open',
  severity: 'critical',
  title: 'incident',
  description: 'blocked',
  openedAt: 3_000,
  updatedAt: 3_000,
  workspacePath: '/workspace',
  agentId: 'agent',
  traceId: 'trace',
  riskCategory: 'command_danger',
  riskName: '危险命令执行',
  riskType: 'atomic',
  eventCount: 1,
  lastEventId: event.eventId,
  lastEventAt: 3_000,
  lastEventSubject: event.subject,
  maxRiskScore: 95,
};
const mutation = alerting.prepareDurableBusinessEffects(event, incident);
assert.ok(mutation.records.length > 0);
assert.equal(notifications, 0, 'notifications must wait for the durable transaction');
mutation.rollback();
assert.equal(alerting.alerts.size, 0);
assert.equal(alerting.incidents.size, 0);
assert.equal(notifications, 0);

const committedMutation = alerting.prepareDurableBusinessEffects(event, incident);
committedMutation.commit();
await new Promise((resolve) => setImmediate(resolve));
assert.ok(notifications > 0, 'notifications may run only after a durable commit');

console.log('business-effect atomic commit and rollback contracts verified');
