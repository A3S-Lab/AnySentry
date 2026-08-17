import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

const [
  store,
  incidents,
  alerts,
  remediations,
  controller,
  moduleSource,
] = await Promise.all([
  read('apps/api/src/security-monitoring/relational-business-store.service.ts'),
  read('apps/api/src/security-monitoring/sentry-judge.service.ts'),
  read('apps/api/src/security-monitoring/alerting.service.ts'),
  read('apps/api/src/security-monitoring/remediation.service.ts'),
  read('apps/api/src/security-monitoring/security-monitoring.controller.ts'),
  read('apps/api/src/security-monitoring/security-monitoring.module.ts'),
]);

for (const [table, identity] of [
  ['anysentry_incidents', 'incident_id'],
  ['anysentry_alerts', 'alert_id'],
  ['anysentry_remediations', 'task_id'],
]) {
  assert.match(store, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  assert.match(store, new RegExp(`${identity} TEXT PRIMARY KEY`));
}

assert.match(store, /loadIncidents/);
assert.match(store, /saveIncidents/);
assert.match(store, /loadAlerts/);
assert.match(store, /saveAlerts/);
assert.match(store, /loadRemediations/);
assert.match(store, /saveRemediations/);
assert.match(store, /await client\.query\('BEGIN'\)/);
assert.match(store, /await client\.query\('COMMIT'\)/);
assert.match(store, /await client\.query\('ROLLBACK'\)/);
assert.match(store, /WHERE EXCLUDED\.updated_at >= anysentry_incidents\.updated_at/);
assert.match(store, /WHERE EXCLUDED\.updated_at >= anysentry_alerts\.updated_at/);
assert.match(store, /WHERE EXCLUDED\.updated_at >= anysentry_remediations\.updated_at/);

assert.match(moduleSource, /RelationalBusinessStore/);

assert.match(incidents, /private readonly relational: RelationalBusinessStore/);
assert.match(incidents, /this\.relational\.loadIncidents\(\)/);
assert.match(incidents, /this\.relational\.saveIncidents\(records\)/);
assert.match(incidents, /this\.ch\.saveIncidentState\(\[\.\.\.this\.incidents\.values\(\)\]\)/);
assert.match(incidents, /refreshRelationalIncidents/);
assert.match(incidents, /incidentStateStatus/);

assert.match(alerts, /private readonly relational: RelationalBusinessStore/);
assert.match(alerts, /this\.relational\.loadAlerts\(\)/);
assert.match(alerts, /this\.relational\.saveAlerts\(alerts\)/);
assert.match(alerts, /this\.ch\.saveAlertState\(alerts\)/);
assert.match(alerts, /refreshRelational/);
assert.match(alerts, /if \(!cur \|\| rec\.updatedAt >= cur\.updatedAt\)/);
assert.match(alerts, /stateStatus/);

assert.match(remediations, /private readonly relational: RelationalBusinessStore/);
assert.match(remediations, /this\.relational\.loadRemediations\(\)/);
assert.match(remediations, /this\.relational\.saveRemediations\(tasks\)/);
assert.match(remediations, /this\.ch\.saveRemediationState\(tasks\)/);
assert.match(remediations, /record\.updatedAt >= current\.updatedAt/);
assert.match(remediations, /refreshRelational/);
assert.match(remediations, /stateStatus/);

assert.match(controller, /incidents: this\.judge\.incidentStateStatus\(\)/);
assert.match(controller, /alerts: this\.alerting\.stateStatus\(\)/);
assert.match(controller, /remediations: this\.remediation\.stateStatus\(\)/);

console.log('Data lifecycle Phase 7 verification passed');
