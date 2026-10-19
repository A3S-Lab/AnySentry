import assert from 'node:assert/strict';

const build = process.env.ANYSENTRY_TEST_BUILD || 'dist';
const { SentryJudgeService } = await import(
  `../apps/api/${build}/security-monitoring/sentry-judge.service.js`
);

const incident = (updatedAt) => ({
  incidentId: 'incident-1',
  status: 'open',
  severity: 'high',
  title: 'fixture',
  description: 'fixture',
  openedAt: 1,
  updatedAt,
  workspacePath: '/fixture',
  agentId: 'agent-1',
  riskCategory: 'fixture',
  riskName: 'fixture',
  riskType: 'behavioral',
  eventCount: updatedAt,
  lastEventId: `event-${updatedAt}`,
  lastEventAt: updatedAt,
  lastEventSubject: 'fixture',
  maxRiskScore: 76,
  monitored: true,
});

const relationalWrites = [];
const projectionWrites = [];
let releaseFirst;
const firstWriteBlocked = new Promise((resolve) => { releaseFirst = resolve; });
const judge = Object.assign(Object.create(SentryJudgeService.prototype), {
  incidents: new Map([['incident-1', incident(100)]]),
  pendingIncidentPersistence: new Map(),
  incidentProjectionDirty: false,
  relational: {
    async saveIncidents(records) {
      relationalWrites.push(records.map((record) => record.updatedAt));
      if (relationalWrites.length === 1) await firstWriteBlocked;
      return true;
    },
  },
  ch: {
    async saveIncidentState(records) {
      projectionWrites.push(records.map((record) => record.updatedAt));
    },
  },
});

for (let version = 1; version <= 100; version += 1) {
  judge.scheduleIncidentPersistence([incident(version)]);
}
const draining = judge.flushIncidentPersistence();
await new Promise((resolve) => setTimeout(resolve, 10));
assert.deepEqual(relationalWrites, [[100]], 'the first burst must retain only its newest revision');

judge.incidents.set('incident-1', incident(101));
judge.scheduleIncidentPersistence([incident(101)]);
releaseFirst();
await draining;
assert.deepEqual(relationalWrites, [[100], [101]], 'an update arriving during a write must drain next');
assert.equal(projectionWrites.length, 2, 'each committed coalesced cycle publishes one projection');

for (let index = 0; index < 100; index += 1) judge.scheduleIncidentProjection();
await judge.flushIncidentPersistence();
assert.equal(relationalWrites.length, 2, 'projection-only changes must not repeat PostgreSQL writes');
assert.equal(projectionWrites.length, 3, '100 projection requests must collapse into one write');

judge.incidents.set('incident-1', incident(102));
await judge.persistIncidentState([incident(102)]);
assert.deepEqual(relationalWrites.at(-1), [102], 'explicit flush must persist the final revision');
assert.deepEqual(projectionWrites.at(-1), [102], 'explicit flush must project the final revision');

console.log('PASS: incident persistence is newest-wins, singleflight, coalesced, and flushable');
