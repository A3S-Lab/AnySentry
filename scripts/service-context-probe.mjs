#!/usr/bin/env node

import { createRequire } from 'node:module';
import process from 'node:process';
import { performance } from 'node:perf_hooks';

const require = createRequire('/app/package.json');
const Redis = require('ioredis');
const { Client: PostgresClient } = require('pg');

const intervalMs = Math.max(15_000, Math.min(300_000, Number(process.env.PROBE_INTERVAL_MS) || 60_000));
const sampleCount = Math.max(3, Math.min(20, Number(process.env.PROBE_SAMPLE_COUNT) || 5));
const contextUrl = new URL(process.env.ANYSENTRY_CONTEXT_URL || 'http://anysentry:29653/security-center/ingest/otlp/v1/metrics');
const sourceId = process.env.ANYSENTRY_CONTEXT_SOURCE_ID?.trim();
const sourceToken = process.env.ANYSENTRY_CONTEXT_TOKEN?.trim();
const clickhouseUrl = new URL(process.env.CLICKHOUSE_URL || 'http://clickhouse:8123');
const clickhouseUser = process.env.CLICKHOUSE_USER || 'default';
const clickhousePassword = process.env.CLICKHOUSE_PASSWORD || '';
const redisUrl = process.env.REDIS_URL || 'redis://redis:6379';
const postgresUrl = process.env.ANYSENTRY_DATABASE_URL;

if (!sourceId || !sourceToken || !postgresUrl) {
  throw new Error('system-context probe requires Source credentials and ANYSENTRY_DATABASE_URL');
}

let stopping = false;
let timer;

function log(event, fields = {}) {
  process.stdout.write(`${JSON.stringify({ at: Date.now(), component: 'system-context-probe', event, ...fields })}\n`);
}

async function measured(operation) {
  const durations = [];
  let failures = 0;
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const startedAt = performance.now();
    try {
      await operation();
    } catch {
      failures += 1;
    } finally {
      durations.push(Math.max(0, performance.now() - startedAt));
    }
  }
  durations.sort((left, right) => left - right);
  return {
    attempts: sampleCount,
    failures,
    errorRate: failures / sampleCount,
    p95Ms: Number(durations[Math.max(0, Math.ceil(durations.length * 0.95) - 1)].toFixed(3)),
  };
}

async function probeAnySentry() {
  return measured(async () => {
    const response = await fetch('http://anysentry:29653/security-center/healthz', { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`health returned ${response.status}`);
    const body = await response.json();
    if ((body?.data ?? body)?.status !== 'ok') throw new Error('health status is not ok');
  });
}

async function probeClickHouse() {
  const authorization = Buffer.from(`${clickhouseUser}:${clickhousePassword}`).toString('base64');
  return measured(async () => {
    const response = await fetch(clickhouseUrl, {
      method: 'POST',
      headers: { authorization: `Basic ${authorization}` },
      body: 'SELECT 1',
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok || (await response.text()).trim() !== '1') throw new Error(`ClickHouse probe returned ${response.status}`);
  });
}

async function probeRedis() {
  const client = new Redis(redisUrl, {
    lazyConnect: true,
    connectTimeout: 3_000,
    commandTimeout: 3_000,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  try {
    await client.connect();
    return await measured(async () => {
      if (await client.ping() !== 'PONG') throw new Error('Redis PING did not return PONG');
    });
  } finally {
    client.disconnect(false);
  }
}

async function probePostgres() {
  const client = new PostgresClient({
    connectionString: postgresUrl,
    connectionTimeoutMillis: 3_000,
    query_timeout: 3_000,
    statement_timeout: 3_000,
  });
  try {
    await client.connect();
    return await measured(async () => {
      const result = await client.query('SELECT 1 AS ready');
      if (result.rows[0]?.ready !== 1) throw new Error('Postgres probe did not return ready=1');
    });
  } finally {
    await client.end().catch(() => undefined);
  }
}

function attribute(key, value) {
  return { key, value: { stringValue: value } };
}

function gauge(name, unit, value, status, timeUnixNano) {
  return {
    name,
    unit,
    gauge: {
      dataPoints: [{
        timeUnixNano,
        asDouble: value,
        attributes: [
          attribute('anysentry.metric.status', status),
          attribute('anysentry.measurement.method', `active_probe_${sampleCount}_samples`),
        ],
      }],
    },
  };
}

function resourceMetrics(service, kind, assetId, prefix, result, timeUnixNano) {
  const status = result.failures > 0 ? 'anomalous' : 'normal';
  return {
    resource: {
      attributes: [
        attribute('service.name', service),
        attribute('service.namespace', 'anysentry'),
        attribute('deployment.environment.name', 'k3s-local'),
        attribute('anysentry.service.asset.id', assetId),
        attribute('anysentry.workload.role', 'anysentry_internal'),
        attribute('anysentry.service.kind', kind),
      ],
    },
    scopeMetrics: [{
      scope: { name: 'anysentry.service-context-probe' },
      metrics: [
        gauge(`${prefix}.error_rate`, '1', result.errorRate, status, timeUnixNano),
        gauge(`${prefix}.duration.p95`, 'ms', result.p95Ms, status, timeUnixNano),
      ],
    }],
  };
}

async function publish() {
  const [anysentry, clickhouse, redis, postgres] = await Promise.all([
    probeAnySentry(), probeClickHouse(), probeRedis(), probePostgres(),
  ]);
  const timeUnixNano = String(Date.now() * 1_000_000);
  const body = {
    resourceMetrics: [
      resourceMetrics('anysentry', 'service', 'service:k8s:default-cluster:anysentry:anysentry', 'anysentry.http.request', anysentry, timeUnixNano),
      resourceMetrics('clickhouse', 'database', 'service:k8s:default-cluster:anysentry:clickhouse', 'clickhouse.query', clickhouse, timeUnixNano),
      resourceMetrics('redis', 'database', 'service:k8s:default-cluster:anysentry:redis', 'redis.command', redis, timeUnixNano),
      resourceMetrics('postgres', 'database', 'service:k8s:default-cluster:anysentry:postgres', 'postgres.query', postgres, timeUnixNano),
    ],
  };
  const response = await fetch(contextUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${sourceToken}`,
      'x-anysentry-source-id': sourceId,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`OTLP ingest returned ${response.status}`);
  const payload = await response.json();
  const ack = payload?.data ?? payload;
  if (ack?.acceptedEvents !== 12 || ack?.rejectedEvents !== 0) throw new Error('OTLP ingest acknowledgement is incomplete');
  log('published', { acceptedEvents: 12, anysentry, clickhouse, redis, postgres });
}

async function loop() {
  if (stopping) return;
  try {
    await publish();
  } catch (error) {
    log('publish_failed', { reason: error instanceof Error ? error.message.slice(0, 240) : String(error) });
  }
  if (!stopping) timer = setTimeout(loop, intervalMs);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    stopping = true;
    if (timer) clearTimeout(timer);
    log('stopped', { signal });
  });
}

void loop();
