import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

const clickhouse = read('apps/api/src/security-monitoring/clickhouse-store.ts');
const aggregation = read('apps/api/src/security-monitoring/aggregation.service.ts');
const controller = read('apps/api/src/security-monitoring/security-monitoring.controller.ts');
const migration = read('scripts/materialize-event-query-columns.mjs');

for (const column of [
  'agentIdentityKey',
  'agentInstanceKey',
  'agentMonitored',
  'agentHasPhysicalIdentity',
  'agentHasRootIdentity',
]) {
  assert.match(clickhouse, new RegExp(`ADD COLUMN IF NOT EXISTS ${column}`));
  assert.match(migration, new RegExp(`'${column}'`));
}

assert.match(clickhouse, /agentWindowFacts\(/);
assert.match(clickhouse, /topologyWindowFacts\(/);
assert.match(clickhouse, /collector_heartbeats/);
assert.match(clickhouse, /GROUP BY eventId/);
assert.match(clickhouse, /decisionRevision UInt32 DEFAULT 1/);
assert.match(clickhouse, /tuple\(decisionRevision, decisionUpdatedAt, at\)/);
assert.match(clickhouse, /ORDER BY decisionRevision DESC, decisionUpdatedAt DESC, at DESC/);
assert.match(clickhouse, /groupUniqArray\(sessionId\) AS sessionKeys/);
assert.match(clickhouse, /groupUniqArray\(instanceKey\) AS instanceKeys/);
assert.ok(clickhouse.includes('private flushInFlight?: Promise<void>'));
assert.match(clickhouse, /const previous = this\.flushInFlight \?\? Promise\.resolve\(\)/);
assert.ok(clickhouse.includes('this.buf.length > 0'));
assert.match(clickhouse, /return undefined;/);
assert.match(aggregation, /async storedAgentInventory\(/);
assert.match(aggregation, /async storedAgentTopology\(/);
assert.match(aggregation, /async storedCollectorHealth\(/);
assert.match(aggregation, /const overlapEventIds = hotEvents/);
assert.match(aggregation, /new Set\(\[\.\.\.a\.sessionKeys, \.\.\.b\.sessionKeys\]\)/);
assert.match(aggregation, /foldLatestEventRevisions/);
assert.match(clickhouse, /eventId NOT IN \{excludedEventIds:Array\(String\)\}/);
assert.match(clickhouse, /batch queued for retry/);
assert.match(controller, /storedAgentInventory\(f\)/);
assert.match(controller, /storedAgentTopology\(f\)/);
assert.match(controller, /storedCollectorHealth\(f\)/);
assert.match(migration, /MATERIALIZE COLUMN/);
assert.match(migration, /mutations_sync/);

const judge = read('apps/api/src/security-monitoring/sentry-judge.service.ts');
assert.match(judge, /resultApplyLocks = new Map<string, Promise<void>>/);
assert.match(judge, /decisionRevision: 1/);
assert.match(judge, /decisionRevision = Math\.max\(/);
assert.match(judge, /decisionRevision,\s*decisionUpdatedAt:/);

console.log('Data lifecycle Phase 2 verification passed');
