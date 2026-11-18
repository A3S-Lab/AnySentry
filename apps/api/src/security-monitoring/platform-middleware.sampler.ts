import Redis from 'ioredis';
import { Kafka, logLevel } from 'kafkajs';
import { Client } from 'pg';

export interface MiddlewarePoint {
  at: string;
  value: number;
}

export interface MiddlewareSeries {
  key: string;
  label: string;
  unit: string;
  points: MiddlewarePoint[];
}

export interface MiddlewareComponent {
  id: string;
  name: string;
  status: 'healthy' | 'warning' | 'critical' | 'unknown';
  message: string;
}

export interface MiddlewareView {
  components: MiddlewareComponent[];
  series: MiddlewareSeries[];
}

interface Sample {
  at: string;
  redisMemoryBytes?: number;
  redisEvictedKeys?: number;
  redisQueueDepth?: number;
  postgresConnections?: number;
  postgresDatabaseBytes?: number;
  clickhouseDiskPercent?: number;
  clickhouseRunningQueries?: number;
  kafkaLag?: number;
  redisStatus: MiddlewareComponent['status'];
  redisMessage: string;
  postgresStatus: MiddlewareComponent['status'];
  postgresMessage: string;
  clickhouseStatus: MiddlewareComponent['status'];
  clickhouseMessage: string;
  kafkaStatus: MiddlewareComponent['status'];
  kafkaMessage: string;
  collectors: MiddlewareComponent[];
}

const history: Sample[] = [];
const MAX_SAMPLES = 480;
let sampling = false;

function infoValue(text: string, key: string): number | undefined {
  const match = text.match(new RegExp(`^${key}:(.+)$`, 'm'));
  const value = Number(match?.[1]);
  return Number.isFinite(value) ? value : undefined;
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function probeRedis(): Promise<Pick<Sample, 'redisMemoryBytes' | 'redisEvictedKeys' | 'redisQueueDepth' | 'redisStatus' | 'redisMessage'>> {
  const url = process.env.ANYSENTRY_REDIS_URL?.trim();
  if (!url) {
    return { redisStatus: 'unknown', redisMessage: '未配置 Redis' };
  }
  const client = new Redis(url, {
    connectTimeout: 1200,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    lazyConnect: true,
  });
  try {
    await withTimeout(client.connect(), 1500);
    const [memory, stats] = await withTimeout(Promise.all([
      client.info('memory'),
      client.info('stats'),
    ]), 1500);
    const used = infoValue(memory, 'used_memory');
    const max = infoValue(memory, 'maxmemory') ?? 0;
    const evicted = infoValue(stats, 'evicted_keys') ?? 0;
    let depth = 0;
    let cursor = '0';
    let scanned = 0;
    do {
      const [next, keys] = await client.scan(cursor, 'MATCH', 'bull:*:wait', 'COUNT', 40);
      cursor = next;
      for (const key of keys) {
        depth += await client.llen(key);
        scanned += 1;
        if (scanned >= 20) break;
      }
    } while (cursor !== '0' && scanned < 20);
    const percent = max > 0 && used !== undefined ? (used / max) * 100 : undefined;
    const status = evicted > 0 || depth >= 10000 || (percent !== undefined && percent >= 85)
      ? (percent !== undefined && percent >= 95 ? 'critical' : 'warning')
      : 'healthy';
    const usedMb = used === undefined ? '--' : `${(used / 1024 / 1024).toFixed(0)} MiB`;
    return {
      redisMemoryBytes: used,
      redisEvictedKeys: evicted,
      redisQueueDepth: depth,
      redisStatus: status,
      redisMessage: `已用 ${usedMb} · 队列 ${depth} · 累计淘汰 ${evicted}`,
    };
  } catch (error) {
    return {
      redisStatus: 'critical',
      redisMessage: error instanceof Error ? error.message : 'Redis 不可用',
    };
  } finally {
    client.disconnect();
  }
}

async function probePostgres(): Promise<Pick<Sample, 'postgresConnections' | 'postgresDatabaseBytes' | 'postgresStatus' | 'postgresMessage'>> {
  const connectionString = process.env.ANYSENTRY_DATABASE_URL?.trim();
  if (!connectionString) {
    return { postgresStatus: 'unknown', postgresMessage: '未配置 Postgres' };
  }
  const client = new Client({ connectionString, connectionTimeoutMillis: 1500, query_timeout: 1500 });
  try {
    await withTimeout(client.connect(), 1800);
    const result = await client.query(`
      SELECT
        (SELECT count(*)::int FROM pg_stat_activity) AS connections,
        (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') AS max_connections,
        pg_database_size(current_database())::float8 AS bytes
    `);
    const row = result.rows[0] as { connections: number; max_connections: number; bytes: number };
    const percent = row.max_connections > 0 ? (row.connections / row.max_connections) * 100 : 0;
    return {
      postgresConnections: row.connections,
      postgresDatabaseBytes: row.bytes,
      postgresStatus: percent >= 95 ? 'critical' : percent >= 80 ? 'warning' : 'healthy',
      postgresMessage: `连接 ${row.connections}/${row.max_connections} · 库 ${(row.bytes / 1024 / 1024).toFixed(0)} MiB`,
    };
  } catch (error) {
    return {
      postgresStatus: 'critical',
      postgresMessage: error instanceof Error ? error.message : 'Postgres 不可用',
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function probeClickhouse(): Promise<Pick<Sample, 'clickhouseDiskPercent' | 'clickhouseRunningQueries' | 'clickhouseStatus' | 'clickhouseMessage'>> {
  const base = process.env.CLICKHOUSE_URL?.trim();
  if (!base) {
    return { clickhouseStatus: 'unknown', clickhouseMessage: '未配置 ClickHouse' };
  }
  const user = process.env.CLICKHOUSE_USER || 'anysentry';
  const password = process.env.CLICKHOUSE_PASSWORD || 'anysentry';
  const database = process.env.CLICKHOUSE_DB || 'anysentry';
  const query = `
    SELECT
      (SELECT sum(total_space) FROM system.disks) AS total_space,
      (SELECT sum(free_space) FROM system.disks) AS free_space,
      (SELECT value FROM system.metrics WHERE metric = 'Query') AS queries
    FORMAT JSON
  `;
  try {
    const response = await fetch(`${base.replace(/\/$/, '')}/?database=${encodeURIComponent(database)}`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`,
        'Content-Type': 'text/plain',
      },
      body: query,
      signal: AbortSignal.timeout(1800),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json() as { data?: Array<{ total_space: string; free_space: string; queries: string }> };
    const row = payload.data?.[0];
    const total = Number(row?.total_space);
    const free = Number(row?.free_space);
    const queries = Number(row?.queries);
    const percent = total > 0 ? ((total - free) / total) * 100 : undefined;
    return {
      clickhouseDiskPercent: percent,
      clickhouseRunningQueries: Number.isFinite(queries) ? queries : undefined,
      clickhouseStatus: percent !== undefined && percent >= 95 ? 'critical' : percent !== undefined && percent >= 85 ? 'warning' : 'healthy',
      clickhouseMessage: `磁盘 ${percent === undefined ? '--' : percent.toFixed(1)}% · 正在查询 ${Number.isFinite(queries) ? queries : '--'}`,
    };
  } catch (error) {
    return {
      clickhouseStatus: 'critical',
      clickhouseMessage: error instanceof Error ? error.message : 'ClickHouse 不可用',
    };
  }
}

async function probeKafka(): Promise<Pick<Sample, 'kafkaLag' | 'kafkaStatus' | 'kafkaMessage'>> {
  const brokers = (
    process.env.ANYSENTRY_INTERACTION_BOOTSTRAP_SERVERS
    || process.env.ANYSENTRY_STREAM_BOOTSTRAP_SERVERS
    || 'kafka:9092'
  ).split(',').map((item) => item.trim()).filter(Boolean);
  const topic = process.env.ANYSENTRY_INTERACTION_TOPIC?.trim() || 'anysentry.interactions.v1';
  const groupId = process.env.ANYSENTRY_INTERACTION_CONSUMER_GROUP?.trim() || 'anysentry-interaction-projection-v1';
  const kafka = new Kafka({
    clientId: 'anysentry-platform-middleware',
    brokers,
    connectionTimeout: 1200,
    requestTimeout: 1500,
    logLevel: logLevel.NOTHING,
  });
  const admin = kafka.admin();
  try {
    await withTimeout(admin.connect(), 1800);
    const [ends, committed] = await withTimeout(Promise.all([
      admin.fetchTopicOffsets(topic),
      admin.fetchOffsets({ groupId, topics: [topic] }),
    ]), 1800);
    const committedByPartition = new Map(
      (committed[0]?.partitions ?? []).map((item) => [item.partition, Number(item.offset)]),
    );
    let lag = 0;
    for (const item of ends) {
      const high = Number(item.high);
      const current = committedByPartition.get(item.partition);
      if (Number.isFinite(high) && current !== undefined && Number.isFinite(current) && current >= 0) {
        lag += Math.max(0, high - current);
      }
    }
    return {
      kafkaLag: lag,
      kafkaStatus: lag >= 5000 ? 'critical' : lag >= 1000 ? 'warning' : 'healthy',
      kafkaMessage: `主题 ${topic} · 消费积压 ${lag}`,
    };
  } catch (error) {
    return {
      kafkaStatus: 'critical',
      kafkaMessage: error instanceof Error ? error.message : 'Kafka 不可用',
    };
  } finally {
    await admin.disconnect().catch(() => undefined);
  }
}

async function probeCollectors(): Promise<MiddlewareComponent[]> {
  const targets = [
    ['prometheus', 'Prometheus', process.env.ANYSENTRY_PROMETHEUS_URL?.trim() || 'http://prometheus:9090', '/-/ready'],
    ['node-exporter', 'node-exporter', 'http://node-exporter:9100', '/metrics'],
    ['cadvisor', 'cAdvisor', 'http://cadvisor:8080', '/healthz'],
  ] as const;
  return Promise.all(targets.map(async ([id, name, base, path]) => {
    try {
      const response = await fetch(`${base.replace(/\/$/, '')}${path}`, { signal: AbortSignal.timeout(800) });
      return {
        id: `collector:${id}`,
        name,
        status: response.ok ? 'healthy' as const : 'critical' as const,
        message: response.ok ? '采集端在运行' : `HTTP ${response.status}`,
      };
    } catch {
      return { id: `collector:${id}`, name, status: 'critical' as const, message: '未运行' };
    }
  }));
}

async function sampleOnce(): Promise<void> {
  if (sampling) return;
  sampling = true;
  try {
    const [redis, postgres, clickhouse, kafka, collectors] = await Promise.all([
      withTimeout(probeRedis(), 10000).catch((error: unknown) => ({
        redisStatus: 'critical' as const,
        redisMessage: error instanceof Error ? error.message : 'Redis 不可用',
      })),
      withTimeout(probePostgres(), 4000).catch((error: unknown) => ({
        postgresStatus: 'critical' as const,
        postgresMessage: error instanceof Error ? error.message : 'Postgres 不可用',
      })),
      withTimeout(probeClickhouse(), 4000).catch((error: unknown) => ({
        clickhouseStatus: 'critical' as const,
        clickhouseMessage: error instanceof Error ? error.message : 'ClickHouse 不可用',
      })),
      withTimeout(probeKafka(), 4000).catch((error: unknown) => ({
        kafkaStatus: 'critical' as const,
        kafkaMessage: error instanceof Error ? error.message : 'Kafka 不可用',
      })),
      withTimeout(probeCollectors(), 4000).catch(() => []),
    ]);
    history.push({ at: new Date().toISOString(), ...redis, ...postgres, ...clickhouse, ...kafka, collectors });
    if (history.length > MAX_SAMPLES) history.splice(0, history.length - MAX_SAMPLES);
  } finally {
    sampling = false;
  }
}

function series(samples: Sample[], key: string, label: string, unit: string, pick: (sample: Sample) => number | undefined): MiddlewareSeries {
  return {
    key,
    label,
    unit,
    points: samples.flatMap((sample) => {
      const value = pick(sample);
      return value === undefined ? [] : [{ at: sample.at, value }];
    }),
  };
}

export async function middlewareView(fromMs: number): Promise<MiddlewareView> {
  if (history.length === 0) await sampleOnce();
  const samples = history.filter((sample) => Date.parse(sample.at) >= fromMs);
  const latest = samples.at(-1) ?? history.at(-1);
  const components: MiddlewareComponent[] = latest ? [
    { id: 'middleware:redis', name: 'Redis', status: latest.redisStatus, message: latest.redisMessage },
    { id: 'middleware:postgres', name: 'Postgres', status: latest.postgresStatus, message: latest.postgresMessage },
    { id: 'middleware:clickhouse', name: 'ClickHouse', status: latest.clickhouseStatus, message: latest.clickhouseMessage },
    { id: 'middleware:kafka', name: 'Kafka', status: latest.kafkaStatus, message: latest.kafkaMessage },
    ...latest.collectors,
  ] : [];
  return {
    components,
    series: [
      series(samples, 'redis_memory', 'Redis 内存', 'MiB', (sample) => sample.redisMemoryBytes === undefined ? undefined : sample.redisMemoryBytes / 1024 / 1024),
      series(samples, 'redis_queue', 'Redis 队列', '条', (sample) => sample.redisQueueDepth),
      series(samples, 'redis_evicted', 'Redis 累计淘汰', '次', (sample) => sample.redisEvictedKeys),
      series(samples, 'postgres_connections', 'Postgres 连接', '个', (sample) => sample.postgresConnections),
      series(samples, 'postgres_size', 'Postgres 库', 'MiB', (sample) => sample.postgresDatabaseBytes === undefined ? undefined : sample.postgresDatabaseBytes / 1024 / 1024),
      series(samples, 'clickhouse_disk', 'ClickHouse 磁盘', '%', (sample) => sample.clickhouseDiskPercent),
      series(samples, 'clickhouse_queries', 'ClickHouse 正在查询', '个', (sample) => sample.clickhouseRunningQueries),
      series(samples, 'kafka_lag', 'Kafka 积压', '条', (sample) => sample.kafkaLag),
    ],
  };
}

const timer = setInterval(() => { void sampleOnce(); }, 15_000);
timer.unref();
