#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AggregationService } from '../apps/api/dist/security-monitoring/aggregation.service.js';
import { ClickHouseStore } from '../apps/api/dist/security-monitoring/clickhouse-store.js';

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function fakeClient() {
  const state = {
    active: 0,
    maxActive: 0,
    calls: [],
    failNext: false,
  };
  return {
    state,
    client: {
      async query(options) {
        state.calls.push(options);
        state.active += 1;
        state.maxActive = Math.max(state.maxActive, state.active);
        await delay(2);
        if (state.failNext) {
          state.failNext = false;
          state.active -= 1;
          throw new Error('synthetic bounded dashboard read failure');
        }
        let consumed = false;
        return {
          async json() {
            try {
              await delay(2);
              return [];
            } finally {
              if (!consumed) {
                consumed = true;
                state.active -= 1;
              }
            }
          },
        };
      },
    },
  };
}

function assertBoundedSettings(call, { maxThreads = 2 } = {}) {
  assert.equal(call.clickhouse_settings?.max_threads, maxThreads);
  assert.equal(call.clickhouse_settings?.max_memory_usage, String(384 * 1024 * 1024));
  assert.equal(call.clickhouse_settings?.max_bytes_before_external_group_by, String(64 * 1024 * 1024));
  assert.equal(call.clickhouse_settings?.max_bytes_before_external_sort, String(64 * 1024 * 1024));
  assert.equal(call.clickhouse_settings?.min_bytes_to_use_direct_io, String(1024 * 1024));
  assert.equal(call.clickhouse_settings?.max_execution_time, 25);
}

function assertHydrateSettings(call) {
  assert.equal(call.clickhouse_settings?.max_threads, 1);
  assert.equal(call.clickhouse_settings?.max_memory_usage, String(640 * 1024 * 1024));
  assert.equal(call.clickhouse_settings?.max_block_size, '1024');
  assert.equal(call.clickhouse_settings?.preferred_block_size_bytes, String(1024 * 1024));
  assert.equal(call.clickhouse_settings?.min_bytes_to_use_direct_io, String(1024 * 1024));
  assert.equal(call.clickhouse_settings?.max_execution_time, 25);
}

function assertRecentSettings(call) {
  assertBoundedSettings(call, { maxThreads: 1 });
  assert.equal(call.clickhouse_settings?.max_block_size, '1024');
  assert.equal(call.clickhouse_settings?.preferred_block_size_bytes, String(1024 * 1024));
}

const store = new ClickHouseStore();
store.ready = true;
const fake = fakeClient();
store.client = fake.client;

const hydrated = await store.hydrate(100, 10_000);
assert.deepEqual(hydrated, []);
assert.equal(fake.state.calls.length, 1);
const hydrateCall = fake.state.calls[0];
assertHydrateSettings(hydrateCall);
assert.match(hydrateCall.query, /PREWHERE at >= \{since:UInt64\}[\s\S]*ORDER BY at DESC\s+LIMIT \{scanLimit:UInt32\} WITH TIES/u);
assert.match(hydrateCall.query, /ORDER BY at DESC, decisionUpdatedAt DESC\s+LIMIT 1 BY eventId\s+LIMIT \{limit:UInt32\}/u);
assert.doesNotMatch(hydrateCall.query, /ORDER BY at ASC/u);
assert.equal(fake.state.active, 0);

fake.state.calls.length = 0;
const recent = await store.recentWindowEvents(100, 200, 1_000, { monitoredOnly: true, tier: 'Llm' });
assert.deepEqual(recent, []);
assert.equal(fake.state.calls.length, 1);
const recentCall = fake.state.calls[0];
assertRecentSettings(recentCall);
assert.match(recentCall.query, /PREWHERE at >= \{since:UInt64\} AND at <= \{until:UInt64\}/u);
assert.match(recentCall.query, /WHERE JSONExtractBool\(attribution, 'monitored'\)/u);
assert.match(recentCall.query, /WHERE tier = \{tier:String\}/u);
assert.equal(recentCall.query_params.scanLimit, 15_000);
const boundedLimit = recentCall.query.indexOf('LIMIT {scanLimit:UInt32} WITH TIES');
const revisionSort = recentCall.query.indexOf('ORDER BY at DESC, decisionUpdatedAt DESC');
const revisionDedup = recentCall.query.indexOf('LIMIT 1 BY eventId');
const stableFilter = recentCall.query.indexOf("WHERE JSONExtractBool(attribution, 'monitored')");
const mutableFilter = recentCall.query.indexOf('WHERE tier = {tier:String}');
assert.ok(boundedLimit > 0, 'recent query must bound the primary-key scan');
assert.match(recentCall.query, /ORDER BY at DESC\s+LIMIT \{scanLimit:UInt32\} WITH TIES/u);
assert.ok(stableFilter > 0 && stableFilter < boundedLimit, 'stable monitored scope should narrow the bounded sample');
assert.ok(revisionSort > boundedLimit, 'revision sorting must happen only after the bounded primary-key scan');
assert.ok(revisionDedup > revisionSort, 'the latest lifecycle revision must be selected before filtering');
assert.ok(mutableFilter > revisionDedup, 'tier filtering must not resurrect an older lifecycle revision');
assert.equal(fake.state.active, 0);

fake.state.calls.length = 0;
fake.state.maxActive = 0;
const histories = await Promise.all([
  store.dashboardWindowHistory(100, 200, 8),
  store.dashboardWindowHistory(300, 400, 8),
]);
assert.equal(histories.length, 2);
assert.equal(histories.filter(Boolean).length, 1, 'a different concurrent history window must fail fast');
assert.equal(histories.filter((history) => history?.countsApproximate === true).length, 1);
assert.equal(fake.state.calls.length, 4);
assert.equal(fake.state.maxActive, 1, 'dashboard queries and windows must execute one at a time');
for (const call of fake.state.calls) assertBoundedSettings(call);
for (let index = 0; index < fake.state.calls.length; index += 4) {
  const [dimensions, buckets, session, workspace] = fake.state.calls.slice(index, index + 4);
  assert.match(dimensions.query, /uniqCombined64\(eventId\) AS eventCount/u);
  assert.doesNotMatch(dimensions.query, /uniqExact/u);
  assert.match(buckets.query, /uniqCombined64If/u);
  assert.doesNotMatch(buckets.query, /uniqExact/u);
  assert.match(session.query, /PREWHERE sourceEvent\.at >= \{start:UInt64\}/u);
  assert.match(workspace.query, /uniqCombined64\(/u);
}

fake.state.calls.length = 0;
fake.state.failNext = true;
const originalConsoleError = console.error;
console.error = () => {};
try {
  assert.equal(await store.dashboardWindowHistory(500, 600, 8), null);
  const recovered = await Promise.race([
    store.dashboardWindowHistory(700, 800, 8),
    delay(1_000).then(() => { throw new Error('dashboard query slot was not released after failure'); }),
  ]);
  assert.ok(recovered, 'a later dashboard query must recover after a failed turn');
} finally {
  console.error = originalConsoleError;
}

const aggregationSource = await readFile(
  new URL('../apps/api/src/security-monitoring/aggregation.service.ts', import.meta.url),
  'utf8',
);
const eventWindowMethod = aggregationSource.slice(
  aggregationSource.indexOf('async agentEventsForWindow'),
  aggregationSource.indexOf('async storedAgentEvents'),
);
assert.match(eventWindowMethod, /filter\.agentAssetId/u);
assert.match(eventWindowMethod, /filter\.q/u);
assert.match(eventWindowMethod, /const history = hasDetailedFilter \? null : await this\.history\(filter\)/u);
assert.match(eventWindowMethod, /const totalApproximate = hasDetailedFilter \|\| !history/u);
assert.match(eventWindowMethod, /persisted\.length >= persistedLimit/u);

const apiTypesSource = await readFile(
  new URL('../apps/api/src/security-monitoring/types.ts', import.meta.url),
  'utf8',
);
const webApiSource = await readFile(
  new URL('../apps/web/src/lib/api/security-center.ts', import.meta.url),
  'utf8',
);
const agentEventsPageSource = await readFile(
  new URL('../apps/web/src/pages/AgentEventsPage.tsx', import.meta.url),
  'utf8',
);
const monitorPageSource = await readFile(
  new URL('../apps/web/src/pages/SecurityMonitorPage.tsx', import.meta.url),
  'utf8',
);
assert.match(apiTypesSource, /interface AgentEventList[\s\S]*totalApproximate\?: boolean/u);
assert.match(webApiSource, /interface AgentEventList[\s\S]*totalApproximate\?: boolean/u);
assert.match(agentEventsPageSource, /data\.totalApproximate \? "≈"/u);
assert.match(monitorPageSource, /events\.totalApproximate \? "≈"/u);

let historyCalls = 0;
const aggregation = new AggregationService(
  {
    dashboardWindowHistory() {
      historyCalls += 1;
      return Promise.resolve(null);
    },
  },
  {},
  {},
  {},
);
await aggregation.history({ timeType: 'last_1d' });
await aggregation.history({ timeType: 'last_1d' });
assert.equal(historyCalls, 1, 'a failed history query must be negatively cached for a short backoff');

let uniqueHistoryCalls = 0;
const unresolvedAggregation = new AggregationService(
  {
    dashboardWindowHistory() {
      uniqueHistoryCalls += 1;
      return new Promise(() => {});
    },
  },
  {},
  {},
  {},
);
for (let index = 0; index < 65; index += 1) {
  void unresolvedAggregation.history({
    timeType: 'custom',
    startTime: new Date(index * 60_000).toISOString(),
    endTime: new Date((index + 1) * 60_000).toISOString(),
  });
}
assert.equal(uniqueHistoryCalls, 64, 'in-flight custom windows must not grow the history cache without bound');

let detailedHistoryCalls = 0;
const detailedAggregation = new AggregationService(
  {
    recentPersistedEvents: async () => [],
    dashboardWindowHistory() {
      detailedHistoryCalls += 1;
      return Promise.resolve(null);
    },
  },
  {},
  {},
  {},
);
const detailed = await detailedAggregation.agentEventsForWindow({
  timeType: 'last_30d',
  q: 'e2e-marker',
  limit: 200,
});
assert.deepEqual(detailed.items, []);
assert.equal(detailed.total, 0);
assert.equal(detailed.totalApproximate, true);
assert.equal(detailedHistoryCalls, 0, 'a detailed marker query must not trigger unrelated history scans');

console.log('ClickHouse bounded dashboard query verification passed');
