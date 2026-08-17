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

function assertBoundedSettings(call, { maxThreads = 2, smallBlocks = false, maxMemoryMiB = 384 } = {}) {
  assert.equal(call.clickhouse_settings?.max_threads, maxThreads);
  assert.equal(call.clickhouse_settings?.max_memory_usage, String(maxMemoryMiB * 1024 * 1024));
  assert.equal(call.clickhouse_settings?.max_bytes_before_external_group_by, String(64 * 1024 * 1024));
  assert.equal(call.clickhouse_settings?.max_bytes_before_external_sort, String(64 * 1024 * 1024));
  assert.equal(call.clickhouse_settings?.min_bytes_to_use_direct_io, String(1024 * 1024));
  assert.equal(call.clickhouse_settings?.max_block_size, smallBlocks ? '1024' : undefined);
  assert.equal(call.clickhouse_settings?.preferred_block_size_bytes, smallBlocks ? String(1024 * 1024) : undefined);
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
  assertBoundedSettings(call, { maxThreads: 1, smallBlocks: true, maxMemoryMiB: 448 });
}

function assertEventSearchSettings(call) {
  assertBoundedSettings(call, { maxThreads: 1, smallBlocks: true, maxMemoryMiB: 512 });
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
const searched = await store.searchEvents({
  sinceMs: 100,
  untilMs: 200,
  sourceId: 'source-a',
  activityContext: 'agent_action',
  verdict: 'block',
  tier: 'Llm',
  limit: 100_000,
});
assert.deepEqual(searched, []);
assert.equal(fake.state.calls.length, 1);
const searchCall = fake.state.calls[0];
assertEventSearchSettings(searchCall);
assert.equal(searchCall.query_params.limit, 10_000,
  'durable search must cap complete-row materialization at 10k rows');
assert.equal(searchCall.query_params.scanLimit, 30_000);
assert.match(searchCall.query, /PREWHERE at >= \{since:UInt64\} AND at <= \{until:UInt64\}/u);
assert.match(searchCall.query, /WHERE sourceId = \{sourceId:String\}/u);
assert.match(searchCall.query, /\) = \{activityContext:String\}/u);
assert.match(searchCall.query, /activitySubtype IN \(/u);
assert.equal(searchCall.query_params.activityContext, 'agent_action');
assert.match(searchCall.query, /WHERE verdict = \{verdict:String\} AND tier = \{tier:String\}/u);
assert.match(searchCall.query, /_part AS selectedPart/u);
assert.match(searchCall.query, /_part_offset AS selectedPartOffset/u);
assert.match(searchCall.query, /FROM events AS e\s+PREWHERE[\s\S]*tuple\(e\.at, e\._part, e\._part_offset\) IN/u,
  'the physical locator set must be evaluated by the outer PREWHERE before wide columns are read');
assert.doesNotMatch(searchCall.query, /SELECT \*\s+FROM events\s+PREWHERE/u,
  'wide event columns must not participate in the bounded candidate sort');
assert.match(searchCall.query, /ORDER BY at DESC\s+LIMIT \{scanLimit:UInt32\} WITH TIES/u);
const searchStableFilter = searchCall.query.indexOf('WHERE sourceId = {sourceId:String}');
const searchBoundedLimit = searchCall.query.indexOf('LIMIT {scanLimit:UInt32} WITH TIES');
const searchRevisionSort = searchCall.query.indexOf('ORDER BY at DESC, decisionUpdatedAt DESC');
const searchRevisionDedup = searchCall.query.indexOf('LIMIT 1 BY eventId');
const searchMutableFilter = searchCall.query.indexOf('WHERE verdict = {verdict:String} AND tier = {tier:String}');
const searchSelectedLimit = searchCall.query.indexOf('LIMIT {limit:UInt32}');
const searchResultLimit = searchCall.query.lastIndexOf('LIMIT {limit:UInt32}');
assert.ok(searchStableFilter > 0 && searchStableFilter < searchBoundedLimit,
  'stable event filters must narrow the bounded primary-key sample');
assert.ok(searchRevisionSort > searchBoundedLimit,
  'event revision sorting must happen only after the bounded primary-key sample');
assert.ok(searchRevisionDedup > searchRevisionSort,
  'durable event search must select the latest lifecycle revision before mutable filtering');
assert.ok(searchMutableFilter > searchRevisionDedup,
  'verdict and tier filters must not resurrect an obsolete lifecycle revision');
assert.ok(searchSelectedLimit > searchMutableFilter,
  'the candidate limit must apply after lifecycle selection and mutable filtering');
assert.ok(searchResultLimit > searchSelectedLimit,
  'the same bound must be re-applied after complete rows are materialized');
assert.equal(searchCall.query.match(/LIMIT \{limit:UInt32\}/gu)?.length, 2,
  'durable search must bound both the locator set and the final complete-row result');
assert.equal(fake.state.active, 0);

fake.state.calls.length = 0;
const sameSearchInput = {
  sinceMs: 100,
  untilMs: 201,
  collectorId: 'collector-a',
  limit: 2_000,
};
const sameSearchA = store.searchEvents(sameSearchInput);
const sameSearchB = store.searchEvents({ ...sameSearchInput });
const [sameSearchRowsA, sameSearchRowsB] = await Promise.all([sameSearchA, sameSearchB]);
assert.equal(fake.state.calls.length, 1, 'equivalent concurrent durable searches must share one query');
assert.deepEqual(sameSearchRowsA, []);
assert.deepEqual(sameSearchRowsB, []);
assert.notStrictEqual(sameSearchRowsA, sameSearchRowsB, 'each durable-search caller must receive its own array');
assert.equal(fake.state.calls[0].query_params.scanLimit, 6_000);

fake.state.calls.length = 0;
const monitoredSearch = store.searchEvents({
  sinceMs: 100,
  untilMs: 201,
  monitoredOnly: true,
  limit: 2_000,
});
assert.equal(
  await store.searchEvents({
    sinceMs: 100,
    untilMs: 201,
    monitoredOnly: false,
    limit: 2_000,
  }),
  null,
  'raw and monitored-only searches must never share a differently shaped in-flight query',
);
assert.deepEqual(await monitoredSearch, []);
assert.equal(fake.state.calls.length, 1);

fake.state.calls.length = 0;
const occupiedSearch = store.searchEvents({ sinceMs: 100, untilMs: 202, limit: 2_000 });
assert.deepEqual(
  await store.searchEvents({ sinceMs: 100, untilMs: 203, limit: 2_000 }),
  null,
  'a different durable search must fail closed while one wide query is active',
);
assert.equal(
  await store.recentWindowEvents(100, 203, 1_000),
  null,
  'a durable search must exclude a concurrent recent wide read',
);
assert.equal(
  await store.dashboardWindowHistory(100, 203, 8),
  null,
  'a durable search must exclude concurrent dashboard history reads',
);
assert.deepEqual(await occupiedSearch, []);
assert.equal(fake.state.calls.length, 1, 'a busy durable search must not start a second wide query');
assert.deepEqual(
  await store.searchEvents({ sinceMs: 100, untilMs: 203, limit: 2_000 }),
  [],
  'a different durable search must recover after the active query settles',
);
assert.equal(fake.state.calls.length, 2);

fake.state.calls.length = 0;
fake.state.failNext = true;
const searchConsoleError = console.error;
console.error = () => {};
try {
  assert.equal(await store.searchEvents({ sinceMs: 100, untilMs: 204, limit: 2_000 }), null);
} finally {
  console.error = searchConsoleError;
}
assert.deepEqual(
  await store.searchEvents({ sinceMs: 100, untilMs: 205, limit: 2_000 }),
  [],
  'a failed durable search must release its in-flight slot',
);
assert.equal(fake.state.calls.length, 2);

fake.state.calls.length = 0;
const sameRecentA = store.recentWindowEvents(100, 201, 1_000, { monitoredOnly: true, tier: 'Llm' });
const sameRecentB = store.recentWindowEvents(100, 201, 1_000, { monitoredOnly: true, tier: 'Llm' });
const [sameRowsA, sameRowsB] = await Promise.all([sameRecentA, sameRecentB]);
assert.equal(fake.state.calls.length, 1, 'equivalent concurrent recent reads must share one query');
assert.deepEqual(sameRowsA, []);
assert.deepEqual(sameRowsB, []);
assert.notStrictEqual(sameRowsA, sameRowsB, 'each recent caller must receive its own array');

fake.state.calls.length = 0;
const occupiedRecent = store.recentWindowEvents(100, 202, 1_000, { monitoredOnly: true });
assert.equal(
  await store.recentWindowEvents(100, 203, 1_000, { monitoredOnly: true }),
  null,
  'a different recent window must fail fast while one query is active',
);
assert.deepEqual(await occupiedRecent, []);
assert.equal(fake.state.calls.length, 1, 'a busy recent window must not start a second query');
assert.deepEqual(
  await store.recentWindowEvents(100, 203, 1_000, { monitoredOnly: true }),
  [],
  'a different recent window must recover after the active query settles',
);
assert.equal(fake.state.calls.length, 2);

fake.state.calls.length = 0;
fake.state.failNext = true;
const recentConsoleError = console.error;
console.error = () => {};
try {
  const failedRecentA = store.recentWindowEvents(100, 204, 1_000);
  const failedRecentB = store.recentWindowEvents(100, 204, 1_000);
  assert.deepEqual(await Promise.all([failedRecentA, failedRecentB]), [null, null]);
} finally {
  console.error = recentConsoleError;
}
assert.deepEqual(await store.recentWindowEvents(100, 205, 1_000), [], 'a failed recent query must release its slot');
assert.equal(fake.state.calls.length, 2);

let releaseRecent;
let markRecentStarted;
const recentGate = new Promise((resolve) => { releaseRecent = resolve; });
const recentStarted = new Promise((resolve) => { markRecentStarted = resolve; });
store.client = {
  async query(options) {
    const isRecent = options.query.includes('LIMIT {scanLimit:UInt32} WITH TIES');
    return {
      async json() {
        if (isRecent) {
          markRecentStarted();
          await recentGate;
        }
        return [];
      },
    };
  },
};
const blockedRecent = store.recentWindowEvents(100, 206, 1_000);
await recentStarted;
assert.equal(
  await store.dashboardWindowHistory(100, 206, 8),
  null,
  'a recent wide read must exclude concurrent dashboard history reads',
);
assert.equal(
  await store.searchEvents({ sinceMs: 100, untilMs: 206, limit: 2_000 }),
  null,
  'a recent wide read must exclude a concurrent durable search',
);
releaseRecent();
assert.deepEqual(await blockedRecent, []);

let failRecentJson = true;
store.client = {
  async query() {
    return {
      async json() {
        if (failRecentJson) {
          failRecentJson = false;
          throw new Error('synthetic recent response failure');
        }
        return [];
      },
    };
  },
};
console.error = () => {};
try {
  assert.equal(await store.recentWindowEvents(100, 207, 1_000), null);
} finally {
  console.error = recentConsoleError;
}
assert.deepEqual(await store.recentWindowEvents(100, 208, 1_000), [], 'a response parse failure must release the recent slot');

store.client = fake.client;
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
assert.equal(fake.state.maxActive, 2, 'only the bounded session/workspace pair may overlap');
for (let index = 0; index < fake.state.calls.length; index += 4) {
  const [dimensions, buckets, session, workspace] = fake.state.calls.slice(index, index + 4);
  assertBoundedSettings(dimensions);
  assertBoundedSettings(buckets);
  assertBoundedSettings(session, { maxThreads: 1, smallBlocks: true });
  assertBoundedSettings(workspace, { maxThreads: 1, smallBlocks: true });
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
assert.match(apiTypesSource, /interface AgentEventList[\s\S]*storageFallback\?: 'hot_ring'/u);
assert.match(webApiSource, /interface AgentEventList[\s\S]*totalApproximate\?: boolean/u);
assert.match(webApiSource, /interface AgentEventList[\s\S]*storageFallback\?: "hot_ring"/u);
assert.match(agentEventsPageSource, /data\.totalApproximate \? "≈"/u);
assert.match(monitorPageSource, /events\.totalApproximate \? "≈"/u);
assert.match(webApiSource, /const DASHBOARD_HISTORY_TIMEOUT_MS = 45_000/u);
assert.match(webApiSource, /dashboardPost<SecurityExplainabilityScan>\("\/security-center\/top\/explainabilityScan", filter\)/u);
assert.match(webApiSource, /dashboardPost<AgentEventList>\("\/security-center\/events\/list", filter\)/u);

let releaseWorkspace;
let markWorkspaceStarted;
const workspaceGate = new Promise((resolve) => { releaseWorkspace = resolve; });
const workspaceStarted = new Promise((resolve) => { markWorkspaceStarted = resolve; });
store.client = {
  async query(options) {
    const isSession = options.query.includes('GROUP BY sessionLabel');
    const isWorkspace = options.query.includes('GROUP BY resolvedWorkspacePath');
    return {
      async json() {
        if (isSession) throw new Error('synthetic detail query failure');
        if (isWorkspace) {
          markWorkspaceStarted();
          await workspaceGate;
        }
        return [];
      },
    };
  },
};
console.error = () => {};
try {
  const failingWindow = store.dashboardWindowHistory(900, 1_000, 8);
  await workspaceStarted;
  assert.equal(
    await store.dashboardWindowHistory(1_100, 1_200, 8),
    null,
    'a failed detail sibling must not release the window slot while its peer is still running',
  );
  assert.equal(
    await store.recentWindowEvents(1_100, 1_200, 1_000),
    null,
    'dashboard history must exclude a concurrent recent wide read until every detail settles',
  );
  assert.equal(
    await store.searchEvents({ sinceMs: 1_100, untilMs: 1_200, limit: 2_000 }),
    null,
    'dashboard history must exclude a concurrent durable search until every detail settles',
  );
  releaseWorkspace();
  assert.equal(await failingWindow, null);
} finally {
  console.error = originalConsoleError;
}
store.client = fake.client;
assert.ok(await store.dashboardWindowHistory(1_300, 1_400, 8), 'the slot must release after both detail siblings settle');

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

const failedDurableAggregation = new AggregationService(
  {
    storageStatus: () => ({ clickhouseReady: true }),
    searchStoredEvents: async () => null,
    queryRange: () => [],
  },
  {},
  {},
  {},
);
const failedDurable = await failedDurableAggregation.storedAgentEvents({ timeType: 'last_30d', limit: 5 });
assert.deepEqual(failedDurable.items, []);
assert.equal(failedDurable.total, 0);
assert.equal(failedDurable.totalApproximate, true,
  'a failed or busy durable read must expose the hot-ring fallback as approximate');
assert.equal(failedDurable.storageFallback, 'hot_ring',
  'a failed or busy durable read must identify its fallback source');

const unavailableDurableAggregation = new AggregationService(
  {
    storageStatus: () => ({ clickhouseReady: false }),
    query: () => [],
  },
  {},
  {},
  {},
);
const unavailableDurable = await unavailableDurableAggregation.storedAgentEvents({ timeType: 'last_30d', limit: 5 });
assert.deepEqual(unavailableDurable.items, []);
assert.equal(unavailableDurable.totalApproximate, true,
  'an unavailable durable store must expose the hot-ring result as approximate');
assert.equal(unavailableDurable.storageFallback, 'hot_ring',
  'an unavailable durable store must identify its fallback source');

let timelineQuery;
const timelineAggregation = new AggregationService(
  {
    storageStatus: () => ({ clickhouseReady: true }),
    committedEventCutoffMs: () => undefined,
    searchStoredEventsPage: async (query) => {
      timelineQuery = query;
      return { events: [], hasMore: false };
    },
    queryRange: () => [],
  },
  {},
  {},
  {},
);
await timelineAggregation.storedAgentTimeline({
  timeType: 'last_30d',
  agentInstanceId: 'instance-a',
  eventKind: 'ToolExec',
  eventCategory: 'tool',
  activityContext: 'agent_action',
  limit: 25,
});
assert.equal(timelineQuery.agentInstanceId, 'instance-a');
assert.equal(timelineQuery.eventKind, 'ToolExec');
assert.equal(timelineQuery.eventCategory, 'tool');
assert.equal(timelineQuery.activityContext, 'agent_action');

let durableAggregationCalls = 0;
let markDurableAggregationStarted;
let releaseDurableAggregation;
const durableAggregationStarted = new Promise((resolve) => { markDurableAggregationStarted = resolve; });
const durableAggregationGate = new Promise((resolve) => { releaseDurableAggregation = resolve; });
const coalescingDurableAggregation = new AggregationService(
  {
    storageStatus: () => ({ clickhouseReady: true }),
    searchStoredEvents: async () => {
      durableAggregationCalls += 1;
      if (durableAggregationCalls > 1) return null;
      markDurableAggregationStarted();
      await durableAggregationGate;
      return [];
    },
    queryRange: () => [],
  },
  {},
  {},
  {},
);
const durableAggregationA = coalescingDurableAggregation.storedAgentEvents({
  timeType: 'last_30d',
  scope: 'raw',
  q: ' marker ',
  limit: 40,
});
await durableAggregationStarted;
const durableAggregationB = coalescingDurableAggregation.storedAgentEvents({
  timeType: 'last_30d',
  scope: 'raw',
  q: 'MARKER',
  limit: 40,
});
assert.equal(durableAggregationCalls, 1,
  'equivalent concurrent durable HTTP requests must resolve one moving window and share one result');
assert.equal((await coalescingDurableAggregation.storedAgentEvents({
  timeType: 'last_30d',
  q: 'marker',
  limit: 40,
})).storageFallback, 'hot_ring',
'omitted scope must not share the non-compacted result of an explicit raw request');
assert.equal((await coalescingDurableAggregation.storedAgentEvents({
  timeType: 'last_30d',
  scope: 'raw',
  eventKind: ' ',
  q: 'marker',
  limit: 40,
})).storageFallback, 'hot_ring',
'an eventKind used verbatim by filtering must not collide with an omitted eventKind');
assert.equal((await coalescingDurableAggregation.storedAgentEvents({
  timeType: 'last_30d',
  scope: 'raw',
  q: 'marker',
  limit: 40.4,
})).storageFallback, 'hot_ring',
'different pre-clamp numeric limits must not collide in the durable request key');
assert.equal((await coalescingDurableAggregation.storedAgentEvents({
  timeType: 'last_30d',
  scope: 'raw',
  agentInstanceId: 'instance-b',
  q: 'marker',
  limit: 40,
})).storageFallback, 'hot_ring',
'different concrete Agent instances must not share an in-flight durable result');
assert.equal((await coalescingDurableAggregation.storedAgentEvents({
  timeType: 'last_30d',
  scope: 'raw',
  snapshotAsOf: '2026-08-17T00:00:00.000Z',
  q: 'marker',
  limit: 40,
})).storageFallback, 'hot_ring',
'different dashboard snapshots must not share an in-flight durable result');
releaseDurableAggregation();
const [durableAggregationResultA, durableAggregationResultB] = await Promise.all([
  durableAggregationA,
  durableAggregationB,
]);
assert.equal(durableAggregationCalls, 6,
  'semantically different durable requests must not join the active request');
assert.equal(durableAggregationResultA.storageFallback, undefined);
assert.equal(durableAggregationResultB.storageFallback, undefined);
assert.deepEqual(durableAggregationResultA, durableAggregationResultB);
assert.notStrictEqual(durableAggregationResultA, durableAggregationResultB);
assert.notStrictEqual(durableAggregationResultA.items, durableAggregationResultB.items);

let durableAggregationFailureCalls = 0;
const recoveringDurableAggregation = new AggregationService(
  {
    storageStatus: () => ({ clickhouseReady: true }),
    searchStoredEvents: async () => {
      durableAggregationFailureCalls += 1;
      if (durableAggregationFailureCalls === 1) throw new Error('synthetic aggregation durable failure');
      return [];
    },
    queryRange: () => [],
  },
  {},
  {},
  {},
);
await assert.rejects(
  recoveringDurableAggregation.storedAgentEvents({ timeType: 'last_30d', scope: 'raw', limit: 5 }),
  /synthetic aggregation durable failure/u,
);
assert.equal(
  (await recoveringDurableAggregation.storedAgentEvents({ timeType: 'last_30d', scope: 'raw', limit: 5 })).storageFallback,
  undefined,
  'a failed coalesced durable request must release the aggregation in-flight entry',
);
assert.equal(durableAggregationFailureCalls, 2);

const pinnedEvent = {
  schemaVersion: 'anysentry.agent_event.v1',
  eventId: 'event-pinned',
  at: 201,
  eventKind: 'ToolExec',
  eventCategory: 'tool',
  source: 'observer',
  subject: 'pinned evidence',
  workspacePath: '/workspace',
  agentId: 'agent-a',
  collectorId: 'collector-current',
  sourceId: 'source-current',
  sessionId: 'session-a',
  userId: 'user-a',
  traceId: 'trace-a',
  spanId: 'span-a',
  runId: 'run-a',
  decisionStatus: 'succeeded',
  decisionUpdatedAt: 202,
  verdict: 'allow',
  tier: 'Rules',
  severity: 'info',
  reason: 'retained',
  riskCategory: 'other',
  riskName: 'none',
  riskType: 'atomic',
  riskScore: 0,
  tokenCount: 0,
  latencyMs: 0,
  attributes: {},
};
let pinnedStoredQuery;
const pinnedAggregation = new AggregationService(
  {
    storageStatus: () => ({ clickhouseReady: true }),
    searchStoredEvents: async (query) => {
      pinnedStoredQuery = query;
      return [pinnedEvent];
    },
    query: () => [pinnedEvent],
    queryRange: () => [],
  },
  {
    canonicalAgentAssetId: (value) => value,
    resolveEvent: () => ({
      agentAssetId: 'asset-a',
      displayName: 'Agent A',
      detectedName: 'Agent A',
      detectedClassification: 'probable_agent',
      effectiveClassification: 'probable_agent',
    }),
  },
  {},
  {},
);
const pinnedResult = await pinnedAggregation.storedAgentEvents({
  timeType: 'custom',
  startTime: '1970-01-01T00:00:00.100Z',
  endTime: '1970-01-01T00:00:00.200Z',
  eventId: pinnedEvent.eventId,
  sourceId: 'source-obsolete',
  verdict: 'block',
  tier: 'Agent',
  limit: 5,
});
assert.equal(pinnedResult.items[0]?.eventId, pinnedEvent.eventId,
  'a pinned evidence event must override stale list filters and the custom end time');
assert.equal(pinnedStoredQuery.eventId, pinnedEvent.eventId);
assert.equal(pinnedStoredQuery.sinceMs, 0);
assert.ok(pinnedStoredQuery.untilMs > pinnedEvent.at);
assert.equal(pinnedStoredQuery.sourceId, undefined);
assert.equal(pinnedStoredQuery.verdict, undefined);
assert.equal(pinnedStoredQuery.tier, undefined);

const customRangeCalls = [];
const customWindowAggregation = new AggregationService(
  {
    storageStatus: () => ({ clickhouseReady: true }),
    searchStoredEvents: async () => [],
    queryRange: (start, end) => {
      customRangeCalls.push([start, end]);
      return [];
    },
  },
  {},
  {},
  {},
);
const customWindowResult = await customWindowAggregation.storedAgentEvents({
  timeType: 'custom',
  startTime: '1970-01-01T00:00:00.100Z',
  endTime: '1970-01-01T00:00:00.200Z',
  limit: 5,
});
assert.deepEqual(customWindowResult.items, []);
assert.ok(customRangeCalls.length >= 1);
assert.ok(customRangeCalls.every(([start, end]) => start === 100 && end === 200),
  'custom durable hot-ring reads must preserve the closed requested interval');

console.log('ClickHouse bounded dashboard query verification passed');
