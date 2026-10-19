import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
require('reflect-metadata');
const { Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const build = process.env.ANYSENTRY_TEST_BUILD || 'dist';
const { RelationalBusinessStore } = await import(`../apps/api/${build}/security-monitoring/relational-business-store.service.js`);
const { SentryJudgeService } = await import(`../apps/api/${build}/security-monitoring/sentry-judge.service.js`);
const { AlertingService } = await import(`../apps/api/${build}/security-monitoring/alerting.service.js`);
const { RemediationService } = await import(`../apps/api/${build}/security-monitoring/remediation.service.js`);
const order = [];
let latest = 0;
let clickhouseOpen = true;
const relational = new RelationalBusinessStore();
relational.ready = true;
relational.pool = { end: async () => { order.push('postgres-close'); } };
const save = name => async () => {
  assert.equal(latest, 1, 'all producer destroy hooks must finish before final persistence');
  assert.equal(relational.isReady(), true, 'PostgreSQL must outlive final business saves');
  assert.equal(clickhouseOpen, true, 'ClickHouse must outlive final business saves');
  order.push(name);
};
const judge = Object.assign(Object.create(SentryJudgeService.prototype), {
  onModuleInit: async () => {}, incidents: new Map(),
  persistIncidentState: save('incident-save'),
  drainDecisionRevisionWrites: save('revision-drain'),
  ch: { close: async () => { clickhouseOpen = false; order.push('clickhouse-close'); } },
});
const alert = Object.assign(Object.create(AlertingService.prototype), {
  onModuleInit: async () => {}, persist: save('alert-save'),
});
const remediation = Object.assign(Object.create(RemediationService.prototype), {
  onModuleInit: async () => {}, persist: save('remediation-save'),
});
const producer = { onModuleDestroy: async () => {
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(clickhouseOpen, true);
  assert.equal(relational.isReady(), true);
  latest = 1;
  order.push('producer-stopped');
} };
class FixtureModule {}
Module({ providers: [relational, judge, alert, remediation, producer].map((value, i) => ({ provide: `fixture-${i}`, useValue: value })) })(FixtureModule);
const app = await NestFactory.createApplicationContext(FixtureModule, { logger: false });
await app.close();
for (const operation of ['incident-save', 'revision-drain', 'alert-save', 'remediation-save']) {
  assert.ok(order.indexOf(operation) > order.indexOf('producer-stopped'));
  assert.ok(order.indexOf(operation) < order.indexOf('postgres-close'));
  assert.ok(order.indexOf(operation) < order.indexOf('clickhouse-close'));
}
assert.equal(await relational.initialize(), false, 'a late timer must not reopen the closed pool');
console.log('PASS: real Nest lifecycle / real service hooks:', order.join(' -> '));
