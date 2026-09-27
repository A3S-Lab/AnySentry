import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

const currentState = read('apps/api/src/security-monitoring/distributed-current-state.service.ts');
const judge = read('apps/api/src/security-monitoring/sentry-judge.service.ts');
const aggregation = read('apps/api/src/security-monitoring/aggregation.service.ts');
const sources = read('apps/api/src/security-monitoring/ingestion-source.service.ts');
const controller = read('apps/api/src/security-monitoring/security-monitoring.controller.ts');
const moduleSource = read('apps/api/src/security-monitoring/security-monitoring.module.ts');
const types = read('apps/api/src/security-monitoring/types.ts');

assert.match(currentState, /class DistributedCurrentStateService/);
assert.match(currentState, /Redis only lets several API/);
assert.match(currentState, /tonumber\(decoded\.at or 0\) > tonumber\(ARGV\[4\]\)/);
assert.match(currentState, /redis\.call\('SET', KEYS\[1\], ARGV\[1\], 'EX', ARGV\[2\]\)/);
assert.match(currentState, /latestCollectorHeartbeats\(untilMs: number\)/);
assert.match(currentState, /RECORD_SOURCE_ACTIVITY/);
assert.match(currentState, /merged\.lastEventAt = math\.max/);
assert.match(currentState, /merged\.lastHeartbeatAt = math\.max/);
assert.match(currentState, /recordSourceActivity\(record: IngestionSourceCurrentActivity\)/);
assert.match(currentState, /latestSourceActivities\(untilMs: number\)/);
assert.match(currentState, /if \(!redis \|\| !this\.ready\) return \[\]/);

assert.match(moduleSource, /DistributedCurrentStateService/);
assert.match(judge, /void this\.currentState\.recordCollectorHeartbeat\(rec\)/);
assert.match(judge, /distributedLatestCollectorHeartbeats\(untilMs: number\)/);
assert.match(aggregation, /distributedLatestCollectorHeartbeats\(window\.endMs\)/);
assert.match(aggregation, /source: hasRedisCurrent/);
assert.match(sources, /void this\.currentState\.recordSourceActivity/);
assert.match(sources, /refreshDistributedCurrentState\(untilMs = Date\.now\(\)\)/);
assert.match(sources, /this\.currentStateTimer = setInterval/);
assert.match(controller, /await this\.sources\.refreshDistributedCurrentState\(\)/);
assert.match(types, /'clickhouse\+redis_current'/);

console.log('Data lifecycle Phase 4 verification passed');
