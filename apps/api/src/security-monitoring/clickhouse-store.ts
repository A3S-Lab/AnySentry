// Durable event store backed by ClickHouse — the system of record for judged events.
//
// The dashboard serves reads from an in-memory hot ring (fast, synchronous aggregation); this store
// gives that ring durability: every judged event is written to ClickHouse (batched), and on boot the
// ring is hydrated back from ClickHouse so date windows survive restarts/rollouts. ClickHouse is a
// columnar TSDB — the right home for time-windowed event analytics as volume grows.
//
// Connection comes from env (CLICKHOUSE_URL/USER/PASSWORD/DB). If ClickHouse is unreachable the store
// degrades to in-memory-only (the dashboard keeps working; just no durability) rather than crashing.

import { ClickHouseClient, createClient } from '@clickhouse/client';
import { JudgedEvent, SaeExplain } from './types';

const TABLE = 'events';
// `at` is raw epoch-ms (matches the aggregator); `ts` is a derived DateTime only for TTL/partitioning.
const DDL = (table: string) => `CREATE TABLE IF NOT EXISTS ${table} (
  at UInt64,
  eventKind LowCardinality(String),
  subject String,
  workspacePath String,
  agentId LowCardinality(String),
  sessionId String,
  userId String,
  verdict LowCardinality(String),
  tier LowCardinality(String),
  severity LowCardinality(String),
  reason String,
  actionKind String,
  actionTarget String,
  riskCategory LowCardinality(String),
  riskName String,
  riskType LowCardinality(String),
  riskScore Float64,
  tokenCount UInt64,
  latencyMs Float64,
  explain String,
  ts DateTime MATERIALIZED toDateTime(intDiv(at, 1000))
) ENGINE = MergeTree
ORDER BY at
TTL ts + INTERVAL 90 DAY`;

type Row = Omit<JudgedEvent, 'explain' | 'actionKind' | 'actionTarget'> & {
  actionKind: string;
  actionTarget: string;
  explain: string;
};

function toRow(e: JudgedEvent): Row {
  return {
    at: e.at,
    eventKind: e.eventKind,
    subject: e.subject,
    workspacePath: e.workspacePath,
    agentId: e.agentId,
    sessionId: e.sessionId,
    userId: e.userId,
    verdict: e.verdict,
    tier: e.tier,
    severity: e.severity,
    reason: e.reason,
    actionKind: e.actionKind ?? '',
    actionTarget: e.actionTarget ?? '',
    riskCategory: e.riskCategory,
    riskName: e.riskName,
    riskType: e.riskType,
    riskScore: e.riskScore,
    tokenCount: e.tokenCount,
    latencyMs: e.latencyMs,
    explain: e.explain ? JSON.stringify(e.explain) : '',
  };
}

function fromRow(r: Record<string, unknown>): JudgedEvent {
  const num = (v: unknown) => Number(v) || 0; // ClickHouse returns UInt64 as a string in JSON
  let explain: SaeExplain | undefined;
  const ex = r.explain as string;
  if (ex) {
    try {
      explain = JSON.parse(ex) as SaeExplain;
    } catch {
      explain = undefined;
    }
  }
  return {
    at: num(r.at),
    eventKind: String(r.eventKind),
    subject: String(r.subject),
    workspacePath: String(r.workspacePath),
    agentId: String(r.agentId),
    sessionId: String(r.sessionId),
    userId: String(r.userId),
    verdict: r.verdict as JudgedEvent['verdict'],
    tier: r.tier as JudgedEvent['tier'],
    severity: r.severity as JudgedEvent['severity'],
    reason: String(r.reason),
    actionKind: (r.actionKind as string) || undefined,
    actionTarget: (r.actionTarget as string) || undefined,
    riskCategory: String(r.riskCategory),
    riskName: String(r.riskName),
    riskType: r.riskType as JudgedEvent['riskType'],
    riskScore: num(r.riskScore),
    tokenCount: num(r.tokenCount),
    latencyMs: num(r.latencyMs),
    ...(explain ? { explain } : {}),
  };
}

export class ClickHouseStore {
  private client?: ClickHouseClient;
  private buf: Row[] = [];
  private flushTimer?: NodeJS.Timeout;
  private ready = false;

  get enabled(): boolean {
    return this.ready;
  }

  /** Connect + ensure the database/table exist. Returns false (degrade to in-memory) if unreachable. */
  async init(): Promise<boolean> {
    const url = process.env.CLICKHOUSE_URL;
    if (!url) return false;
    const database = process.env.CLICKHOUSE_DB || 'anysentry';
    try {
      // Create the database with a bootstrap client (no db bound), then connect to it.
      const boot = createClient({ url, username: process.env.CLICKHOUSE_USER || 'default', password: process.env.CLICKHOUSE_PASSWORD || '' });
      await boot.command({ query: `CREATE DATABASE IF NOT EXISTS ${database}` });
      await boot.close();
      this.client = createClient({ url, database, username: process.env.CLICKHOUSE_USER || 'default', password: process.env.CLICKHOUSE_PASSWORD || '' });
      await this.client.command({ query: DDL(TABLE) });
      this.flushTimer = setInterval(() => void this.flush(), 2000);
      this.ready = true;
      return true;
    } catch (err) {
      console.error('[clickhouse] init failed — running in-memory only:', (err as Error).message);
      this.ready = false;
      return false;
    }
  }

  /** Buffer one event; flush opportunistically when the batch is large. */
  enqueue(e: JudgedEvent): void {
    if (!this.ready) return;
    this.buf.push(toRow(e));
    if (this.buf.length >= 500) void this.flush();
  }

  async flush(): Promise<void> {
    if (!this.client || this.buf.length === 0) return;
    const values = this.buf;
    this.buf = [];
    try {
      await this.client.insert({ table: TABLE, values, format: 'JSONEachRow' });
    } catch (err) {
      console.error('[clickhouse] insert failed (dropping batch):', (err as Error).message);
    }
  }

  /** Load the most-recent `limit` events at/after `sinceMs`, oldest-first (to seed the hot ring). */
  async hydrate(sinceMs: number, limit: number): Promise<JudgedEvent[]> {
    if (!this.client) return [];
    try {
      const rs = await this.client.query({
        query: `SELECT * FROM (SELECT * FROM ${TABLE} WHERE at >= {since:UInt64} ORDER BY at DESC LIMIT {lim:UInt32}) ORDER BY at ASC`,
        query_params: { since: sinceMs, lim: limit },
        format: 'JSONEachRow',
      });
      const rows = (await rs.json()) as Array<Record<string, unknown>>;
      return rows.map(fromRow);
    } catch (err) {
      console.error('[clickhouse] hydrate failed:', (err as Error).message);
      return [];
    }
  }

  async close(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    await this.flush();
    await this.client?.close();
  }
}
