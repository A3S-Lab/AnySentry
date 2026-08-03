#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  RuntimeModelClient,
  RuntimeModelConfigService,
} from '../apps/api/dist/security-monitoring/runtime-model-config.js';

const require = createRequire(import.meta.url);
const IORedis = require('../apps/api/node_modules/ioredis');

const redisUrl = process.env.ANYSENTRY_REDIS_URL;
if (!redisUrl) throw new Error('ANYSENTRY_REDIS_URL is required');
process.env.ANYSENTRY_ASYNC_JUDGE = 'on';
const marker = `runtime-only-${Date.now()}-must-not-persist`;
const registry = new RuntimeModelConfigService();
const client = new RuntimeModelClient('fast_review', {});

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting for runtime model Pub/Sub update');
}

try {
  await registry.onModuleInit();
  await client.initialize(redisUrl);
  const connection = {
    url: 'http://model.test/v1',
    model: 'runtime-test-model',
    apiKey: marker,
    timeoutS: 10,
    contextTokens: 16_384,
  };
  const pending = registry.rememberSuccessfulTest('fast_review', connection);
  const consumed = registry.consumeSuccessfulTest('fast_review', pending.testToken);
  const activated = await registry.activate('fast_review', consumed);
  const received = await waitFor(() => client.get()?.version === activated.version ? client.get() : null);
  assert.equal(received.apiKey, marker, 'worker cache must receive the ephemeral credential');
  assert.equal(JSON.stringify(registry.statuses()).includes(marker), false, 'public status must not expose the credential');

  const redis = new IORedis(redisUrl, { maxRetriesPerRequest: 1 });
  try {
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'COUNT', 500);
      cursor = next;
      for (const key of keys) {
        const dump = await redis.dump(key);
        assert.equal(dump?.includes(Buffer.from(marker)) ?? false, false, `credential persisted in Redis key ${key}`);
      }
    } while (cursor !== '0');
  } finally {
    redis.disconnect();
  }

  await registry.clear('fast_review');
  await waitFor(() => client.get() === null);
  console.log('Runtime model Pub/Sub and non-persistence verification passed');
} finally {
  await client.close();
  await registry.onModuleDestroy();
}
