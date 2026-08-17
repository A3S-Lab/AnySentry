import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

const [
  store,
  sources,
  maintenance,
  notifications,
  objectives,
  judge,
  controller,
] = await Promise.all([
  read('apps/api/src/security-monitoring/relational-business-store.service.ts'),
  read('apps/api/src/security-monitoring/ingestion-source.service.ts'),
  read('apps/api/src/security-monitoring/maintenance-window.service.ts'),
  read('apps/api/src/security-monitoring/notification.service.ts'),
  read('apps/api/src/security-monitoring/objective.service.ts'),
  read('apps/api/src/security-monitoring/sentry-judge.service.ts'),
  read('apps/api/src/security-monitoring/security-monitoring.controller.ts'),
]);

for (const [table, identity] of [
  ['anysentry_ingestion_sources', 'source_id'],
  ['anysentry_maintenance_windows', 'window_id'],
  ['anysentry_notification_channels', 'channel_id'],
  ['anysentry_notification_routes', 'route_id'],
  ['anysentry_objectives', 'objective_id'],
]) {
  assert.match(store, new RegExp(`'${table}', '${identity}'`));
  assert.match(store, new RegExp(`CREATE TABLE IF NOT EXISTS \\$\\{table\\}`));
}
assert.match(store, /CREATE TABLE IF NOT EXISTS anysentry_platform_configs/);
assert.match(store, /config_key TEXT PRIMARY KEY/);
assert.match(store, /WHERE EXCLUDED\.updated_at >= anysentry_platform_configs\.updated_at/);

for (const [source, load, save] of [
  [sources, 'loadIngestionSources', 'saveIngestionSources'],
  [maintenance, 'loadMaintenanceWindows', 'saveMaintenanceWindows'],
  [objectives, 'loadObjectives', 'saveObjectives'],
]) {
  assert.match(source, new RegExp(`this\\.relational\\.${load}\\(\\)`));
  assert.match(source, new RegExp(`this\\.relational\\.${save}\\(records\\)`));
  assert.match(source, /refreshRelationalState/);
  assert.match(source, /postgresqlBacked: this\.relational\.isReady\(\)/);
}

assert.match(notifications, /this\.relational\.loadNotificationChannels\(\)/);
assert.match(notifications, /this\.relational\.loadNotificationRoutes\(\)/);
assert.match(notifications, /this\.relational\.saveNotificationChannels\(channels\)/);
assert.match(notifications, /this\.relational\.saveNotificationRoutes\(routes\)/);
// Phase 9 moved immutable delivery history to append-only ClickHouse facts. Phase 8 continues to
// own the mutable channel/route contract and must not require deliveries in its config snapshot.
assert.match(notifications, /deliveries: \[\]/);
assert.match(notifications, /appendNotificationDeliveryFacts\(deliveryFacts\)/);
assert.doesNotMatch(store, /saveNotificationDeliveries/);

assert.match(judge, /this\.relational\.loadPolicyConfig\(\)/);
assert.match(judge, /this\.relational\.savePolicyConfig\(config, this\.policyUpdatedAt\)/);
assert.match(judge, /refreshRelationalPolicy/);
assert.match(judge, /saved\.updatedAt <= this\.policyUpdatedAt/);

for (const status of [
  'ingestionSources: this.sources.stateStatus()',
  'maintenanceWindows: this.maintenance.stateStatus()',
  'notifications: this.notifications.stateStatus()',
  'objectives: this.objectives.stateStatus()',
  'policyConfig: this.judge.policyStateStatus()',
]) {
  assert.match(controller, new RegExp(status.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}

console.log('Data lifecycle Phase 8 verification passed');
