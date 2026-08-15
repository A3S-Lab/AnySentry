import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

const types = read('apps/api/src/security-monitoring/types.ts');
const controller = read('apps/api/src/security-monitoring/security-monitoring.controller.ts');
const aggregation = read('apps/api/src/security-monitoring/aggregation.service.ts');
const clickhouse = read('apps/api/src/security-monitoring/clickhouse-store.ts');
const header = read('apps/web/src/components/custom/security-console-header.tsx');
const eventsPage = read('apps/web/src/pages/AgentEventsPage.tsx');

assert.match(types, /snapshotAsOf\?: string/);
assert.match(types, /interface QueryCoverage/);
assert.match(types, /asOf: string/);
assert.match(types, /totalMode: QueryTotalMode/);
assert.match(controller, /f\.durable !== false \? this\.agg\.storedAgentEvents/);
assert.match(controller, /f\.durable !== false \? this\.agg\.storedAgentTimeline/);
assert.match(clickhouse, /LIMIT 1 BY eventId/);
assert.match(aggregation, /foldLatestEventRevisions/);
assert.match(aggregation, /source: hot\.length \? 'clickhouse\+hot_delta' : 'clickhouse'/);
assert.match(header, /params\.set\("snapshotAsOf"/);
assert.match(eventsPage, /snapshotAsOf: consoleTimeFilter\.snapshotAsOf/);
assert.match(eventsPage, /durable: true/);

console.log('Data lifecycle Phase 1 verification passed');
