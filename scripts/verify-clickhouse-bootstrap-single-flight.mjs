#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const state = {
  clients: [],
  commands: [],
  queries: [],
  pings: [],
  targets: new Map(),
};

function targetKey(options) {
  return JSON.stringify([
    String(options.url ?? ''),
    String(options.database ?? ''),
    String(options.username ?? ''),
    String(options.password ?? ''),
  ]);
}

function configuredTarget(config, overrides = {}) {
  const key = JSON.stringify([config.url, config.database, config.username, config.password]);
  const target = {
    gate: undefined,
    failSchemaRuns: 0,
    failProgressRuns: 0,
    progressResponses: [],
    pingResponses: [],
    ...overrides,
  };
  state.targets.set(key, target);
  return target;
}

function databaseTargetFor(options) {
  const key = targetKey(options);
  const target = state.targets.get(key);
  assert.ok(target, `unexpected fake ClickHouse target: ${key}`);
  return { key, target };
}

function fakeCreateClient(options) {
  const client = {
    id: state.clients.length + 1,
    options: structuredClone(options),
    closed: false,
    role: options.database ? 'unclassified-database' : 'bootstrap',
    async command(commandOptions) {
      const { key, target } = options.database
        ? databaseTargetFor(options)
        : databaseTargetFor({ ...options, database: [...state.targets.keys()]
          .map((entry) => JSON.parse(entry))
          .find(([url, , username, password]) =>
            url === String(options.url ?? '') &&
            username === String(options.username ?? '') &&
            password === String(options.password ?? ''),
          )?.[1] });
      client.role = options.database ? 'schema' : 'bootstrap';
      state.commands.push({ clientId: client.id, key, query: commandOptions.query });
      if (/CREATE DATABASE IF NOT EXISTS/u.test(commandOptions.query) && target.gate) {
        await target.gate.promise;
      }
      if (options.database && /CREATE TABLE IF NOT EXISTS events/u.test(commandOptions.query)) {
        if (target.failSchemaRuns > 0) {
          target.failSchemaRuns -= 1;
          throw new Error('synthetic schema bootstrap failure');
        }
      }
      return { executed: true };
    },
    async query(queryOptions) {
      const { key, target } = databaseTargetFor(options);
      client.role = 'schema';
      state.queries.push({ clientId: client.id, key, ...queryOptions });
      if (/FROM config FINAL/u.test(queryOptions.query)) {
        return { async json() { return []; } };
      }
      assert.match(queryOptions.query, /FROM event_commit_facts/u,
        'startup hydration may only query the bounded commit journal or an exact schema marker');
      if (target.failProgressRuns > 0) {
        target.failProgressRuns -= 1;
        throw new Error('synthetic bounded progress hydration failure');
      }
      const rows = target.progressResponses.shift() ?? [];
      return { async json() { return structuredClone(rows); } };
    },
    async ping(pingOptions) {
      const { key, target } = databaseTargetFor(options);
      client.role = 'store';
      state.pings.push({ clientId: client.id, key, options: structuredClone(pingOptions) });
      const success = target.pingResponses.shift() ?? true;
      return success
        ? { success: true }
        : { success: false, error: new Error('synthetic restarted ClickHouse is unavailable') };
    },
    async insert() {
      return { executed: true };
    },
    async close() {
      client.closed = true;
    },
  };
  state.clients.push(client);
  return client;
}

// @clickhouse/client is resolved from the API package rather than the workspace root. Its CommonJS
// export is configurable, so replace the factory before loading the compiled store.
const apiRequire = createRequire(new URL('../apps/api/package.json', import.meta.url));
const clickhouseModule = apiRequire('@clickhouse/client');
Object.defineProperty(clickhouseModule, 'createClient', {
  configurable: true,
  enumerable: true,
  value: fakeCreateClient,
});

const { ClickHouseStore } = await import('../apps/api/dist/security-monitoring/clickhouse-store.js');

process.env.ANYSENTRY_CLICKHOUSE_INIT_ATTEMPTS = '1';
process.env.ANYSENTRY_CLICKHOUSE_INIT_RETRY_MS = '250';

function applyConfig(config) {
  process.env.CLICKHOUSE_URL = config.url;
  process.env.CLICKHOUSE_DB = config.database;
  process.env.CLICKHOUSE_USER = config.username;
  process.env.CLICKHOUSE_PASSWORD = config.password;
}

function commandCount(config, pattern) {
  const key = JSON.stringify([config.url, config.database, config.username, config.password]);
  return state.commands.filter((call) => call.key === key && pattern.test(call.query)).length;
}

function queryCount(config) {
  const key = JSON.stringify([config.url, config.database, config.username, config.password]);
  return state.queries.filter((call) => call.key === key && /FROM event_commit_facts/u.test(call.query)).length;
}

const concurrentConfig = {
  url: 'http://clickhouse-single-flight:8123',
  database: 'single_flight',
  username: 'single-flight-user',
  password: 'single-flight-password',
};
const concurrentGate = deferred();
configuredTarget(concurrentConfig, {
  gate: concurrentGate,
  progressResponses: [[
    {
      sourceId: 'source-a',
      collectorId: 'collector-a',
      committedThrough: '1700000000100',
      committedAt: '1700000000200',
    },
    {
      sourceId: 'source-b',
      collectorId: 'collector-b',
      committedThrough: '1700000000300',
      committedAt: '1700000000400',
    },
  ]],
});
applyConfig(concurrentConfig);
const stores = Array.from({ length: 11 }, () => new ClickHouseStore());
const initializations = stores.map((store) => store.init());
await new Promise((resolve) => setImmediate(resolve));
assert.equal(
  commandCount(concurrentConfig, /CREATE DATABASE IF NOT EXISTS/u),
  1,
  'eleven concurrent stores must elect one database/schema bootstrap owner',
);
concurrentGate.resolve();
assert.deepEqual(await Promise.all(initializations), Array(11).fill(true));

assert.equal(commandCount(concurrentConfig, /CREATE TABLE IF NOT EXISTS events/u), 1);
assert.equal(queryCount(concurrentConfig), 1,
  'eleven concurrent stores must share one progress hydration');
const hydrationQuery = state.queries.find((call) =>
  /FROM event_commit_facts/u.test(call.query) && call.key === JSON.stringify([
    concurrentConfig.url,
    concurrentConfig.database,
    concurrentConfig.username,
    concurrentConfig.password,
  ]));
assert.ok(hydrationQuery);
assert.match(hydrationQuery.query, /FROM event_commit_facts/u);
assert.match(hydrationQuery.query, /LIMIT \{journalRows:UInt32\}/u);
assert.equal(hydrationQuery.query_params.journalRows, 100_000);
assert.equal(hydrationQuery.clickhouse_settings.max_threads, 1);
assert.equal(hydrationQuery.clickhouse_settings.max_memory_usage, String(128 * 1024 * 1024));
assert.doesNotMatch(hydrationQuery.query, /FROM events/u,
  'startup must not scan the historical events table');
assert.equal(state.pings.filter((call) => call.key === hydrationQuery.key).length, 11,
  'every store must validate its own credentialed database client');
assert.equal(new Set(stores.map((store) => store.client.id)).size, 11,
  'stores must retain independent clients');
for (const store of stores) {
  assert.equal(store.committedCutoffMs(), undefined,
    'a partial journal must not become a global durable boundary');
  assert.deepEqual(store.committedProgress(), [
    {
      sourceId: 'source-a',
      collectorId: 'collector-a',
      committedEventTimeMs: 1700000000100,
      committedAtMs: 1700000000200,
    },
    {
      sourceId: 'source-b',
      collectorId: 'collector-b',
      committedEventTimeMs: 1700000000300,
      committedAtMs: 1700000000400,
    },
  ]);
}

const firstStoreClient = stores[0].client;
await stores[0].close();
assert.equal(firstStoreClient.closed, true);
assert.equal(stores[1].enabled, true,
  'closing one store must not close another store client');
await Promise.all(stores.slice(1).map((store) => store.close()));

// Distinct credentials must never share a bootstrap, and one target's failure must neither poison
// another target nor remain cached after rejection.
const isolatedGood = {
  url: 'http://clickhouse-isolation:8123',
  database: 'isolated',
  username: 'isolated-user',
  password: 'good-password',
};
const isolatedBad = { ...isolatedGood, password: 'bad-password' };
configuredTarget(isolatedGood, { progressResponses: [[]] });
configuredTarget(isolatedBad, { failSchemaRuns: 1, progressResponses: [[]] });

applyConfig(isolatedBad);
const badStore = new ClickHouseStore();
const badInitialization = badStore.init();
applyConfig(isolatedGood);
const goodStore = new ClickHouseStore();
const goodInitialization = goodStore.init();
assert.equal(await badInitialization, false);
assert.equal(await goodInitialization, true);
assert.equal(commandCount(isolatedBad, /CREATE DATABASE IF NOT EXISTS/u), 1);
assert.equal(commandCount(isolatedGood, /CREATE DATABASE IF NOT EXISTS/u), 1);

applyConfig(isolatedBad);
assert.equal(await badStore.init(), true,
  'a failed target bootstrap must be evicted so the next init can retry');
assert.equal(commandCount(isolatedBad, /CREATE DATABASE IF NOT EXISTS/u), 2);
await Promise.all([badStore.close(), goodStore.close()]);

// A bounded journal read is optional query metadata. If ClickHouse can apply schema and answer a
// credentialed ping, startup must fail closed to no progress instead of falling back to memory-only.
const progressFailureConfig = {
  url: 'http://clickhouse-progress-failure:8123',
  database: 'progress_failure',
  username: 'progress-user',
  password: 'progress-password',
};
configuredTarget(progressFailureConfig, { failProgressRuns: 1 });
applyConfig(progressFailureConfig);
const progressFailureStore = new ClickHouseStore();
assert.equal(await progressFailureStore.init(), true,
  'optional progress hydration failure must not block a usable ClickHouse client');
assert.equal(progressFailureStore.committedCutoffMs(), undefined);
assert.deepEqual(progressFailureStore.committedProgress(), []);
await progressFailureStore.close();

// A later reconnect must run a fresh bootstrap, verify the new client, preserve higher in-process
// progress, and remain unready when the restarted server fails the credentialed SELECT ping.
const reconnectConfig = {
  url: 'http://clickhouse-reconnect:8123',
  database: 'reconnect',
  username: 'reconnect-user',
  password: 'reconnect-password',
};
const reconnectTarget = configuredTarget(reconnectConfig, {
  progressResponses: [
    [{ sourceId: 'source-r', collectorId: 'collector-r', committedThrough: 500, committedAt: 600 }],
    [{ sourceId: 'source-r', collectorId: 'collector-r', committedThrough: 100, committedAt: 200 }],
    [{ sourceId: 'source-r', collectorId: 'collector-r', committedThrough: 650, committedAt: 650 }],
    [{ sourceId: 'source-r', collectorId: 'collector-r', committedThrough: 700, committedAt: 800 }],
  ],
  pingResponses: [true, true, false, true],
});
applyConfig(reconnectConfig);
const reconnectStore = new ClickHouseStore();
assert.equal(await reconnectStore.init(), true);
reconnectStore.committedThroughMs = 900;

reconnectStore.ready = false;
assert.equal((await reconnectStore.connect()).ok, true);
assert.deepEqual(reconnectStore.committedProgress(), [{
  sourceId: 'source-r',
  collectorId: 'collector-r',
  committedEventTimeMs: 500,
  committedAtMs: 600,
}], 'a stale reconnect snapshot must not regress source progress');
assert.equal(reconnectStore.committedThroughMs, 900,
  'a reconnect must not erase a higher in-process observed maximum');
assert.equal(reconnectStore.committedCutoffMs(), undefined,
  'an observed maximum must remain hidden until a complete-backfill marker exists');

reconnectStore.ready = false;
const unavailableReconnect = await reconnectStore.connect();
assert.equal(unavailableReconnect.ok, false);
assert.match(unavailableReconnect.error, /restarted ClickHouse is unavailable/u);
assert.equal(reconnectStore.enabled, false,
  'a lazy client must not be marked ready until its credentialed SELECT ping succeeds');
assert.deepEqual(reconnectStore.committedProgress(), [{
  sourceId: 'source-r',
  collectorId: 'collector-r',
  committedEventTimeMs: 500,
  committedAtMs: 600,
}], 'a failed reconnect must not mutate progress');

assert.equal((await reconnectStore.connect()).ok, true);
assert.deepEqual(reconnectStore.committedProgress(), [{
  sourceId: 'source-r',
  collectorId: 'collector-r',
  committedEventTimeMs: 700,
  committedAtMs: 800,
}]);
assert.equal(commandCount(reconnectConfig, /CREATE DATABASE IF NOT EXISTS/u), 4,
  'each later reconnect must validate/rebuild against the current ClickHouse generation');
assert.equal(queryCount(reconnectConfig), 4,
  'each later reconnect must hydrate a fresh bounded journal snapshot');
assert.equal(reconnectTarget.progressResponses.length, 0);
await reconnectStore.close();

console.log('ClickHouse bootstrap single-flight verification passed');
