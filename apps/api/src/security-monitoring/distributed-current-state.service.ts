import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import IORedis from 'ioredis';
import { CollectorHeartbeatRecord, IngestionSourceCurrentActivity } from './types';

const COLLECTOR_INDEX_KEY = 'anysentry:current:collectors';
const COLLECTOR_KEY_PREFIX = 'anysentry:current:collector:';
const SOURCE_INDEX_KEY = 'anysentry:current:sources';
const SOURCE_KEY_PREFIX = 'anysentry:current:source:';
const RECORD_COLLECTOR_HEARTBEAT = `
local current = redis.call('GET', KEYS[1])
if current then
  local ok, decoded = pcall(cjson.decode, current)
  if ok and tonumber(decoded.at or 0) > tonumber(ARGV[4]) then
    return 0
  end
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
redis.call('ZADD', KEYS[2], ARGV[4], ARGV[3])
redis.call('ZREMRANGEBYSCORE', KEYS[2], 0, ARGV[5])
return 1
`;
const RECORD_SOURCE_ACTIVITY = `
local current = redis.call('GET', KEYS[1])
local incoming = cjson.decode(ARGV[1])
local merged = incoming
if current then
  local ok, decoded = pcall(cjson.decode, current)
  if ok then
    merged = decoded
    merged.sourceId = incoming.sourceId
    merged.lastSeenAt = math.max(tonumber(decoded.lastSeenAt or 0), tonumber(incoming.lastSeenAt or 0))
    merged.lastEventAt = math.max(tonumber(decoded.lastEventAt or 0), tonumber(incoming.lastEventAt or 0))
    merged.lastHeartbeatAt = math.max(tonumber(decoded.lastHeartbeatAt or 0), tonumber(incoming.lastHeartbeatAt or 0))
    if tonumber(incoming.lastSeenAt or 0) >= tonumber(decoded.lastSeenAt or 0) then
      if incoming.collectorId then merged.collectorId = incoming.collectorId end
      if incoming.workspacePath then merged.workspacePath = incoming.workspacePath end
    end
  end
end
redis.call('SET', KEYS[1], cjson.encode(merged), 'EX', ARGV[2])
redis.call('ZADD', KEYS[2], tostring(merged.lastSeenAt), ARGV[3])
redis.call('ZREMRANGEBYSCORE', KEYS[2], 0, ARGV[5])
return 1
`;

function ttlSeconds(): number {
  const configured = Number(process.env.ANYSENTRY_CURRENT_STATE_TTL_SECS);
  if (!Number.isFinite(configured)) return 60 * 60;
  return Math.max(10 * 60, Math.min(7 * 24 * 60 * 60, Math.round(configured)));
}

function collectorKey(collectorId: string): string {
  return `${COLLECTOR_KEY_PREFIX}${encodeURIComponent(collectorId)}`;
}

function sourceKey(sourceId: string): string {
  return `${SOURCE_KEY_PREFIX}${encodeURIComponent(sourceId)}`;
}

function heartbeat(value: unknown): CollectorHeartbeatRecord | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Partial<CollectorHeartbeatRecord>;
  if (typeof record.collectorId !== 'string' || !record.collectorId.trim()) return undefined;
  if (!Number.isFinite(Number(record.at))) return undefined;
  return record as CollectorHeartbeatRecord;
}

function sourceActivity(value: unknown): IngestionSourceCurrentActivity | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Partial<IngestionSourceCurrentActivity>;
  if (typeof record.sourceId !== 'string' || !record.sourceId.trim()) return undefined;
  if (!Number.isFinite(Number(record.lastSeenAt))) return undefined;
  return {
    sourceId: record.sourceId,
    lastSeenAt: Number(record.lastSeenAt),
    lastEventAt: Number(record.lastEventAt) || undefined,
    lastHeartbeatAt: Number(record.lastHeartbeatAt) || undefined,
    collectorId: typeof record.collectorId === 'string' ? record.collectorId : undefined,
    workspacePath: typeof record.workspacePath === 'string' ? record.workspacePath : undefined,
  };
}

/**
 * Distributed, short-lived current state.
 *
 * ClickHouse remains the source of historical heartbeat facts. Redis only lets several API
 * replicas agree on the latest Collector state between ClickHouse flushes. Every operation is
 * best-effort: a Redis outage must never reject an Observer event or heartbeat.
 */
@Injectable()
export class DistributedCurrentStateService implements OnModuleInit, OnModuleDestroy {
  private redis?: IORedis;
  private ready = false;
  private readonly ttl = ttlSeconds();

  async onModuleInit(): Promise<void> {
    const url = process.env.ANYSENTRY_REDIS_URL?.trim();
    if (!url) return;
    const redis = new IORedis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 2_000,
      commandTimeout: 2_000,
    });
    redis.on('error', () => undefined);
    try {
      await redis.connect();
      await redis.ping();
      this.redis = redis;
      this.ready = true;
    } catch (error) {
      redis.disconnect();
      console.warn('[current-state] Redis unavailable; using local/ClickHouse fallback:', error instanceof Error ? error.message : String(error));
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.ready = false;
    if (this.redis) await this.redis.quit().catch(() => this.redis?.disconnect());
    this.redis = undefined;
  }

  isReady(): boolean {
    return this.ready;
  }

  async recordCollectorHeartbeat(record: CollectorHeartbeatRecord): Promise<void> {
    const redis = this.redis;
    if (!redis || !this.ready) return;
    try {
      await redis.eval(
        RECORD_COLLECTOR_HEARTBEAT,
        2,
        collectorKey(record.collectorId),
        COLLECTOR_INDEX_KEY,
        JSON.stringify(record),
        String(this.ttl),
        record.collectorId,
        String(record.at),
        String(Date.now() - this.ttl * 1_000),
      );
    } catch {
      // Current-state replication is deliberately non-blocking. ClickHouse and the local hot
      // snapshot remain available while Redis recovers.
    }
  }

  async latestCollectorHeartbeats(untilMs: number): Promise<CollectorHeartbeatRecord[]> {
    const redis = this.redis;
    if (!redis || !this.ready) return [];
    try {
      const collectorIds = await redis.zrangebyscore(COLLECTOR_INDEX_KEY, '-inf', untilMs);
      if (!collectorIds.length) return [];
      const values = await redis.mget(collectorIds.map(collectorKey));
      return values
        .map((value) => {
          if (!value) return undefined;
          try {
            return heartbeat(JSON.parse(value));
          } catch {
            return undefined;
          }
        })
        .filter((record): record is CollectorHeartbeatRecord => Boolean(record && record.at <= untilMs));
    } catch {
      return [];
    }
  }

  async recordSourceActivity(record: IngestionSourceCurrentActivity): Promise<void> {
    const redis = this.redis;
    if (!redis || !this.ready) return;
    try {
      await redis.eval(
        RECORD_SOURCE_ACTIVITY,
        2,
        sourceKey(record.sourceId),
        SOURCE_INDEX_KEY,
        JSON.stringify(record),
        String(this.ttl),
        record.sourceId,
        String(record.lastSeenAt),
        String(Date.now() - this.ttl * 1_000),
      );
    } catch {
      // Source configuration and durable activity history remain available while Redis recovers.
    }
  }

  async latestSourceActivities(untilMs: number): Promise<IngestionSourceCurrentActivity[]> {
    const redis = this.redis;
    if (!redis || !this.ready) return [];
    try {
      const sourceIds = await redis.zrangebyscore(SOURCE_INDEX_KEY, '-inf', untilMs);
      if (!sourceIds.length) return [];
      const values = await redis.mget(sourceIds.map(sourceKey));
      return values
        .map((value) => {
          if (!value) return undefined;
          try {
            return sourceActivity(JSON.parse(value));
          } catch {
            return undefined;
          }
        })
        .filter((record): record is IngestionSourceCurrentActivity => Boolean(record && record.lastSeenAt <= untilMs));
    } catch {
      return [];
    }
  }
}
