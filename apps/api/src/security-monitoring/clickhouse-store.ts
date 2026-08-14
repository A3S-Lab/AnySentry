// Durable event store backed by ClickHouse — the system of record for judged events.
//
// The dashboard serves reads from an in-memory hot ring (fast, synchronous aggregation); this store
// gives that ring durability: every judged event is written to ClickHouse (batched), and on boot the
// ring is hydrated back from ClickHouse so date windows survive restarts/rollouts. ClickHouse is a
// columnar TSDB — the right home for time-windowed event analytics as volume grows.
//
// Connection comes from env (CLICKHOUSE_URL/USER/PASSWORD/DB). If ClickHouse is unreachable the store
// degrades to in-memory-only (the dashboard keeps working; just no durability) rather than crashing.

import { ClickHouseClient, createClient, type ClickHouseSettings } from '@clickhouse/client';
import { PolicyConfig } from './policy-config';
import { AgentAttribution, AgentMetadataRecord, AlertRecord, AuditRecord, CollectorHeartbeatRecord, IdentityAiReviewRecord, Incident, IngestionSourceRecord, JudgedEvent, MaintenanceWindowRecord, NotificationState, ObjectiveRecord, ProcessContext, RemediationRecord } from './types';

const TABLE = 'events';
// `at` is raw epoch-ms (matches the aggregator); `ts` is a derived DateTime only for TTL/partitioning.
const DDL = (table: string) => `CREATE TABLE IF NOT EXISTS ${table} (
  schemaVersion LowCardinality(String),
  eventId String,
  sourceEventId String DEFAULT '',
  at UInt64,
  eventKind LowCardinality(String),
  eventCategory LowCardinality(String),
  source LowCardinality(String),
  subject String,
  workspacePath String,
  agentId LowCardinality(String),
  collectorId String,
  sourceId String,
  sessionId String,
  userId String,
  traceId String,
  spanId String,
  parentSpanId String,
  runId String,
  taskId String,
  decisionStatus LowCardinality(String) DEFAULT 'succeeded',
  evaluationId String DEFAULT '',
  policyVersion String DEFAULT '',
  decisionUpdatedAt UInt64 DEFAULT at,
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
  attributes String,
  process String DEFAULT '{}',
  attribution String DEFAULT '{}',
  judgment String DEFAULT '{}',
  rawPreview String,
  ts DateTime MATERIALIZED toDateTime(intDiv(at, 1000))
) ENGINE = MergeTree
ORDER BY at
TTL ts + INTERVAL 90 DAY`;

const EVENT_ALTERS = [
  'ADD COLUMN IF NOT EXISTS schemaVersion LowCardinality(String) DEFAULT \'anysentry.agent_event.v1\'',
  'ADD COLUMN IF NOT EXISTS eventId String DEFAULT \'\'',
  'ADD COLUMN IF NOT EXISTS sourceEventId String DEFAULT \'\'',
  'ADD COLUMN IF NOT EXISTS eventCategory LowCardinality(String) DEFAULT \'unknown\'',
  'ADD COLUMN IF NOT EXISTS source LowCardinality(String) DEFAULT \'observer\'',
  'ADD COLUMN IF NOT EXISTS collectorId String DEFAULT \'\'',
  'ADD COLUMN IF NOT EXISTS sourceId String DEFAULT \'\'',
  'ADD COLUMN IF NOT EXISTS traceId String DEFAULT \'\'',
  'ADD COLUMN IF NOT EXISTS spanId String DEFAULT \'\'',
  'ADD COLUMN IF NOT EXISTS parentSpanId String DEFAULT \'\'',
  'ADD COLUMN IF NOT EXISTS runId String DEFAULT \'\'',
  'ADD COLUMN IF NOT EXISTS taskId String DEFAULT \'\'',
  "ADD COLUMN IF NOT EXISTS decisionStatus LowCardinality(String) DEFAULT 'succeeded'",
  "ADD COLUMN IF NOT EXISTS evaluationId String DEFAULT ''",
  "ADD COLUMN IF NOT EXISTS policyVersion String DEFAULT ''",
  'ADD COLUMN IF NOT EXISTS decisionUpdatedAt UInt64 DEFAULT at',
  'ADD COLUMN IF NOT EXISTS attributes String DEFAULT \'{}\'',
  'ADD COLUMN IF NOT EXISTS process String DEFAULT \'{}\'',
  'ADD COLUMN IF NOT EXISTS attribution String DEFAULT \'{}\'',
  'ADD COLUMN IF NOT EXISTS judgment String DEFAULT \'{}\'',
  'ADD COLUMN IF NOT EXISTS rawPreview String DEFAULT \'\'',
];

// Singleton policy config (the config panels' persistence). ReplacingMergeTree keeps only the latest
// row per key; `FINAL` collapses to it on read.
const CONFIG_TABLE = 'config';
const CONFIG_DDL = `CREATE TABLE IF NOT EXISTS ${CONFIG_TABLE} (
  key String,
  value String,
  updated_at UInt64
) ENGINE = ReplacingMergeTree(updated_at)
ORDER BY key`;

// Dashboard reads must coexist with sustained Observer writes inside the bundled 2 GiB
// ClickHouse budget. Large window aggregations spill early and use at most two read threads;
// otherwise several dashboard panels can collectively consume the server budget and evict one
// another before any result is returned.
const BOUNDED_DASHBOARD_READ_SETTINGS: ClickHouseSettings = {
  max_threads: 2,
  max_memory_usage: String(384 * 1024 * 1024),
  max_bytes_before_external_group_by: String(64 * 1024 * 1024),
  max_bytes_before_external_sort: String(64 * 1024 * 1024),
  min_bytes_to_use_direct_io: String(1024 * 1024),
  max_execution_time: 25,
};

// Session/workspace queries materialize wider per-event state. Small blocks keep each below its
// query budget; running only these two one-thread reads together keeps the cold dashboard under
// the browser deadline without restoring the previous four-query fan-out.
const BOUNDED_DASHBOARD_DETAIL_READ_SETTINGS: ClickHouseSettings = {
  ...BOUNDED_DASHBOARD_READ_SETTINGS,
  max_threads: 1,
  max_block_size: '1024',
  preferred_block_size_bytes: String(1024 * 1024),
};

// Hydration reads wide rows rather than compact aggregates. A single read thread and small blocks
// keep both ClickHouse and the API startup peak bounded, while a separate 640 MiB query budget
// leaves measured headroom above the roughly 341 MiB production query peak.
const BOUNDED_HYDRATE_READ_SETTINGS: ClickHouseSettings = {
  ...BOUNDED_DASHBOARD_DETAIL_READ_SETTINGS,
  max_memory_usage: String(640 * 1024 * 1024),
};

// Recent event reads also materialize wide rows. Moving-window production samples exceeded the
// shared 384 MiB budget by up to 2.5 MiB, so only this path gets a measured 448 MiB ceiling while
// retaining one thread and small blocks.
const BOUNDED_RECENT_READ_SETTINGS: ClickHouseSettings = {
  ...BOUNDED_DASHBOARD_DETAIL_READ_SETTINGS,
  max_memory_usage: String(448 * 1024 * 1024),
};

type Row = Omit<JudgedEvent, 'actionKind' | 'actionTarget' | 'attributes' | 'process' | 'attribution' | 'judgment' | 'collectorId' | 'sourceId' | 'parentSpanId' | 'taskId' | 'rawPreview'> & {
  actionKind: string;
  actionTarget: string;
  attributes: string;
  process: string;
  attribution: string;
  judgment: string;
  collectorId: string;
  sourceId: string;
  parentSpanId: string;
  taskId: string;
  rawPreview: string;
};
export type IncidentState = Pick<Incident, 'incidentId' | 'status' | 'owner' | 'note' | 'acknowledgedAt' | 'resolvedAt' | 'updatedAt'>;
export interface StoredEventQuery {
  sinceMs: number;
  untilMs: number;
  eventId?: string;
  sourceId?: string;
  collectorId?: string;
  agentId?: string;
  sessionId?: string;
  workspacePath?: string;
  traceId?: string;
  runId?: string;
  eventKind?: string;
  eventCategory?: string;
  verdict?: string;
  tier?: string;
  limit: number;
}

export interface DashboardWindowDimensionRow {
  period: 'current' | 'previous';
  monitored: boolean;
  verdict: string;
  tier: string;
  riskType: string;
  riskCategory: string;
  riskName: string;
  eventCount: number;
  tokenCount: number;
  latencyTotal: number;
  riskScoreTotal: number;
}

export interface DashboardWindowBucketRow {
  bucketIndex: number;
  monitored: boolean;
  eventCount: number;
  blockedCount: number;
  escalatedCount: number;
  l2Count: number;
  l3Count: number;
  riskActivationCount: number;
  tokenCount: number;
  latencyTotal: number;
  riskScoreTotal: number;
}

export interface DashboardWindowHistory {
  /** Distinct counts use ClickHouse's bounded approximate aggregate to avoid an unbounded hash set. */
  countsApproximate: true;
  dimensions: DashboardWindowDimensionRow[];
  buckets: DashboardWindowBucketRow[];
  topSession?: {
    sessionId: string;
    userId: string;
    workspacePath: string;
    eventCount: number;
    riskyEventCount: number;
    riskScoreTotal: number;
    lastEventAt: number;
    dimensionCounts: Record<string, number>;
  };
  workspaces: Array<{
    workspacePath: string;
    sessionCount: number;
    totalRiskScore: number;
    worstSeverityRank: number;
  }>;
}

function attrString(attributes: JudgedEvent['attributes'], key: string): string {
  const value = attributes[key];
  return value == null ? '' : String(value).trim();
}

function toRow(e: JudgedEvent): Row {
  return {
    schemaVersion: e.schemaVersion,
    eventId: e.eventId,
    sourceEventId: e.sourceEventId ?? '',
    at: e.at,
    eventKind: e.eventKind,
    eventCategory: e.eventCategory,
    source: e.source,
    subject: e.subject,
    workspacePath: e.workspacePath,
    agentId: e.agentId,
    collectorId: e.collectorId?.trim() || attrString(e.attributes, 'collectorId'),
    sourceId: e.sourceId?.trim() || attrString(e.attributes, 'sourceId'),
    sessionId: e.sessionId,
    userId: e.userId,
    traceId: e.traceId,
    spanId: e.spanId,
    parentSpanId: e.parentSpanId ?? '',
    runId: e.runId,
    taskId: e.taskId ?? '',
    decisionStatus: e.decisionStatus ?? 'succeeded',
    evaluationId: e.evaluationId ?? '',
    policyVersion: e.policyVersion ?? '',
    decisionUpdatedAt: e.decisionUpdatedAt ?? e.at,
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
    attributes: JSON.stringify(e.attributes ?? {}),
    process: JSON.stringify(e.process ?? {}),
    attribution: JSON.stringify(e.attribution ?? {}),
    judgment: JSON.stringify(e.judgment ?? {}),
    rawPreview: e.rawPreview ?? '',
  };
}

function parseObject<T extends object>(value: unknown): T | undefined {
  const text = String(value ?? '').trim();
  if (!text || text === '{}') return undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as T) : undefined;
  } catch {
    return undefined;
  }
}

function fromRow(r: Record<string, unknown>): JudgedEvent {
  const num = (v: unknown) => Number(v) || 0; // ClickHouse returns UInt64 as a string in JSON
  const str = (v: unknown) => String(v ?? '');
  let attributes: JudgedEvent['attributes'] = {};
  try {
    attributes = JSON.parse(str(r.attributes) || '{}') as JudgedEvent['attributes'];
  } catch {
    attributes = {};
  }
  const at = num(r.at);
  const agentId = str(r.agentId);
  const sessionId = str(r.sessionId);
  const eventKind = str(r.eventKind);
  const collectorId = str(r.collectorId) || attrString(attributes, 'collectorId') || undefined;
  const sourceId = str(r.sourceId) || attrString(attributes, 'sourceId') || undefined;
  return {
    schemaVersion: (str(r.schemaVersion) || 'anysentry.agent_event.v1') as JudgedEvent['schemaVersion'],
    eventId: str(r.eventId) || `evt_${at}_${agentId}_${eventKind}`,
    sourceEventId: str(r.sourceEventId) || undefined,
    at,
    eventKind,
    eventCategory: (str(r.eventCategory) || 'unknown') as JudgedEvent['eventCategory'],
    source: (str(r.source) || 'observer') as JudgedEvent['source'],
    subject: str(r.subject),
    workspacePath: str(r.workspacePath),
    agentId,
    collectorId,
    sourceId,
    sessionId,
    userId: str(r.userId),
    traceId: str(r.traceId) || `tr_${agentId}_${sessionId}`,
    spanId: str(r.spanId) || `sp_${at}_${eventKind}`,
    parentSpanId: str(r.parentSpanId) || undefined,
    runId: str(r.runId) || sessionId,
    taskId: str(r.taskId) || undefined,
    decisionStatus: (str(r.decisionStatus) || 'succeeded') as JudgedEvent['decisionStatus'],
    evaluationId: str(r.evaluationId) || undefined,
    policyVersion: str(r.policyVersion) || undefined,
    decisionUpdatedAt: num(r.decisionUpdatedAt) || at,
    verdict: r.verdict as JudgedEvent['verdict'],
    tier: r.tier as JudgedEvent['tier'],
    severity: r.severity as JudgedEvent['severity'],
    reason: str(r.reason),
    actionKind: (r.actionKind as string) || undefined,
    actionTarget: (r.actionTarget as string) || undefined,
    riskCategory: str(r.riskCategory),
    riskName: str(r.riskName),
    riskType: r.riskType as JudgedEvent['riskType'],
    riskScore: num(r.riskScore),
    tokenCount: num(r.tokenCount),
    latencyMs: num(r.latencyMs),
    attributes,
    process: parseObject<ProcessContext>(r.process),
    attribution: parseObject<AgentAttribution>(r.attribution),
    judgment: parseObject<NonNullable<JudgedEvent['judgment']>>(r.judgment),
    rawPreview: str(r.rawPreview) || undefined,
  };
}

export class ClickHouseStore {
  private client?: ClickHouseClient;
  private buf: Row[] = [];
  private flushTimer?: NodeJS.Timeout;
  private ready = false;
  private dashboardQueryActive = false;
  // Share one equivalent wide read, but fail a different window closed to the hot-ring fallback.
  // This is an in-flight guard only: completed results are never cached here.
  private recentQueryInFlight?: {
    key: string;
    value: Promise<JudgedEvent[] | null>;
  };

  private tryAcquireDashboardQuerySlot(): (() => void) | null {
    if (this.dashboardQueryActive) return null;
    this.dashboardQueryActive = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.dashboardQueryActive = false;
    };
  }

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
      for (const alter of EVENT_ALTERS) await this.client.command({ query: `ALTER TABLE ${TABLE} ${alter}` });
      await this.client.command({ query: CONFIG_DDL });
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
  /** Persist one lifecycle revision before acknowledging queue work. */
  async insertNow(e: JudgedEvent): Promise<void> {
    if (!this.client || !this.ready) throw new Error('ClickHouse is not ready');
    await this.client.insert({ table: TABLE, values: [toRow(e)], format: 'JSONEachRow' });
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
    const safeLimit = Math.max(1, Math.min(100_000, Math.round(limit)));
    try {
      const rs = await this.client.query({
        // Bound the primary-key scan before revision ordering, but keep every row at the cutoff
        // timestamp so lifecycle revisions cannot be split. Server-side dedup means the API parses
        // only the hot-ring result instead of three times as many wide JSON rows during startup.
        query: `
          SELECT *
          FROM (
            SELECT *
            FROM ${TABLE}
            PREWHERE at >= {since:UInt64}
            ORDER BY at DESC
            LIMIT {scanLimit:UInt32} WITH TIES
          )
          ORDER BY at DESC, decisionUpdatedAt DESC
          LIMIT 1 BY eventId
          LIMIT {limit:UInt32}`,
        query_params: {
          since: sinceMs,
          scanLimit: Math.min(safeLimit * 3, 300_000),
          limit: safeLimit,
        },
        clickhouse_settings: BOUNDED_HYDRATE_READ_SETTINGS,
        format: 'JSONEachRow',
      });
      const rows = (await rs.json()) as Array<Record<string, unknown>>;
      const latest = new Map<string, JudgedEvent>();
      for (const event of rows.map(fromRow)) {
        const previous = latest.get(event.eventId);
        if (!previous || (event.decisionUpdatedAt ?? event.at) >= (previous.decisionUpdatedAt ?? previous.at)) latest.set(event.eventId, event);
      }
      return [...latest.values()].sort((a, b) => a.at - b.at).slice(-safeLimit);
    } catch (err) {
      console.error('[clickhouse] hydrate failed:', (err as Error).message);
      return [];
    }
  }

  /** Read the latest persisted events from a bounded interval for dashboard timelines. */
  async recentWindowEvents(
    sinceMs: number,
    untilMs: number,
    limit: number,
    options: { monitoredOnly?: boolean; tier?: string } = {},
  ): Promise<JudgedEvent[] | null> {
    if (!this.client || !this.ready) return null;
    const client = this.client;
    const safeLimit = Math.max(1, Math.min(5_000, Math.round(limit)));
    const monitoredOnly = Boolean(options.monitoredOnly);
    const tier = options.tier ?? '';
    const queryKey = JSON.stringify([String(sinceMs), String(untilMs), safeLimit, monitoredOnly, tier]);
    const current = this.recentQueryInFlight;
    if (current) {
      if (current.key !== queryKey) return null;
      const shared = await current.value;
      return shared ? [...shared] : null;
    }
    // Attribution is copied unchanged into every judgment revision, so monitored can safely narrow
    // the primary-key sample. Tier changes across L1/L2/L3 and must be filtered only after the
    // latest revision is selected.
    const scanFilters = monitoredOnly ? ["JSONExtractBool(attribution, 'monitored')"] : [];
    const latestFilters = tier ? ['tier = {tier:String}'] : [];
    const value = (async (): Promise<JudgedEvent[] | null> => {
      try {
        const rs = await client.query({
          query: `
          SELECT *
          FROM (
            SELECT *
            FROM (
              SELECT *
              FROM ${TABLE}
              PREWHERE at >= {since:UInt64} AND at <= {until:UInt64}
              ${scanFilters.length ? `WHERE ${scanFilters.join(' AND ')}` : ''}
              ORDER BY at DESC
              LIMIT {scanLimit:UInt32} WITH TIES
            )
            ORDER BY at DESC, decisionUpdatedAt DESC
            LIMIT 1 BY eventId
          )
          ${latestFilters.length ? `WHERE ${latestFilters.join(' AND ')}` : ''}
          ORDER BY at DESC, decisionUpdatedAt DESC
          LIMIT {limit:UInt32}`,
          query_params: {
            since: sinceMs,
            until: untilMs,
            tier,
            scanLimit: tier ? 15_000 : Math.min(15_000, safeLimit * 3),
            limit: safeLimit,
          },
          clickhouse_settings: BOUNDED_RECENT_READ_SETTINGS,
          format: 'JSONEachRow',
        });
        return (await rs.json() as Array<Record<string, unknown>>).map(fromRow);
      } catch (error) {
        console.error('[clickhouse] recent dashboard events query failed:', (error as Error).message);
        return null;
      }
    })();
    this.recentQueryInFlight = { key: queryKey, value };
    try {
      const rows = await value;
      return rows ? [...rows] : null;
    } finally {
      if (this.recentQueryInFlight?.value === value) this.recentQueryInFlight = undefined;
    }
  }

  /**
   * Aggregate the complete persisted interval instead of the bounded in-memory hot ring. The latest
   * decision revision is selected per eventId before grouping, so a pending event later judged by
   * L2/L3 is counted once with its final state.
   */
  async dashboardWindowHistory(startMs: number, endMs: number, bucketCount = 180): Promise<DashboardWindowHistory | null> {
    if (!this.client || !this.ready) return null;
    const spanMs = Math.max(1, endMs - startMs);
    const queryStartMs = Math.max(0, startMs - spanMs);
    const buckets = Math.max(1, Math.min(360, Math.round(bucketCount)));
    const bucketMs = Math.max(1, Math.ceil(spanMs / buckets));
    const latestMonitored = `
      SELECT
        eventId,
        argMax(sourceEvent.at, sourceEvent.decisionUpdatedAt) AS eventAt,
        argMax(sourceEvent.agentId, sourceEvent.decisionUpdatedAt) AS agentId,
        argMax(sourceEvent.sessionId, sourceEvent.decisionUpdatedAt) AS sessionId,
        argMax(sourceEvent.userId, sourceEvent.decisionUpdatedAt) AS userId,
        argMax(sourceEvent.workspacePath, sourceEvent.decisionUpdatedAt) AS workspacePath,
        argMax(sourceEvent.verdict, sourceEvent.decisionUpdatedAt) AS verdict,
        argMax(sourceEvent.severity, sourceEvent.decisionUpdatedAt) AS severity,
        argMax(sourceEvent.riskCategory, sourceEvent.decisionUpdatedAt) AS riskCategory,
        argMax(sourceEvent.riskScore, sourceEvent.decisionUpdatedAt) AS riskScore,
        argMax(sourceEvent.process, sourceEvent.decisionUpdatedAt) AS process,
        argMax(sourceEvent.attribution, sourceEvent.decisionUpdatedAt) AS attribution
      FROM ${TABLE} AS sourceEvent
      PREWHERE sourceEvent.at >= {start:UInt64} AND sourceEvent.at <= {end:UInt64}
      WHERE JSONExtractBool(sourceEvent.attribution, 'monitored')
      GROUP BY eventId
      HAVING JSONExtractBool(attribution, 'monitored')`;
    // AggregationService already coalesces the same window. A different concurrent full-window
    // request must fall back to the hot ring instead of building an unbounded queue of heavy reads.
    const release = this.tryAcquireDashboardQuerySlot();
    if (!release) return null;
    try {
      const queryRows = async (
        query: string,
        queryParams: Record<string, string | number>,
        settings = BOUNDED_DASHBOARD_READ_SETTINGS,
      ): Promise<Array<Record<string, unknown>>> => {
        const result = await this.client!.query({
          query,
          query_params: queryParams,
          clickhouse_settings: settings,
          format: 'JSONEachRow',
        });
        return await result.json() as Array<Record<string, unknown>>;
      };
      const dimensionRows = await queryRows(
        `
            SELECT
              if(at < {start:UInt64}, 'previous', 'current') AS period,
              JSONExtractBool(attribution, 'monitored') AS monitored,
              verdict,
              tier,
              riskType,
              riskCategory,
              argMax(riskName, decisionUpdatedAt) AS riskName,
              uniqCombined64(eventId) AS eventCount,
              sum(tokenCount) AS tokenCount,
              sum(latencyMs) AS latencyTotal,
              sum(riskScore) AS riskScoreTotal
            FROM ${TABLE}
            PREWHERE at >= {queryStart:UInt64} AND at <= {end:UInt64}
            WHERE decisionStatus IN ('succeeded', 'failed', 'timeout')
            GROUP BY period, monitored, verdict, tier, riskType, riskCategory`,
        { queryStart: queryStartMs, start: startMs, end: endMs },
      );
      const bucketRowsRaw = await queryRows(
        `
            SELECT
              least({bucketCount:UInt32} - 1, intDiv(at - {start:UInt64}, {bucketMs:UInt64})) AS bucketIndex,
              JSONExtractBool(attribution, 'monitored') AS monitored,
              uniqCombined64(eventId) AS eventCount,
              uniqCombined64If(eventId, verdict = 'block' AND decisionStatus IN ('succeeded', 'failed', 'timeout')) AS blockedCount,
              uniqCombined64If(eventId, verdict = 'escalate' AND decisionStatus IN ('succeeded', 'failed', 'timeout')) AS escalatedCount,
              uniqCombined64If(eventId, tier IN ('Llm', 'Agent') AND decisionStatus IN ('succeeded', 'failed', 'timeout')) AS l2Count,
              uniqCombined64If(eventId, tier = 'Agent' AND decisionStatus IN ('succeeded', 'failed', 'timeout')) AS l3Count,
              uniqCombined64If(eventId, verdict != 'allow' AND decisionStatus IN ('succeeded', 'failed', 'timeout')) AS riskActivationCount,
              sumIf(tokenCount, decisionStatus IN ('succeeded', 'failed', 'timeout')) AS tokenCount,
              sumIf(latencyMs, decisionStatus IN ('succeeded', 'failed', 'timeout')) AS latencyTotal,
              sumIf(riskScore, decisionStatus IN ('succeeded', 'failed', 'timeout')) AS riskScoreTotal
            FROM ${TABLE}
            PREWHERE at >= {start:UInt64} AND at <= {end:UInt64}
            GROUP BY bucketIndex, monitored
            ORDER BY bucketIndex`,
        { queryStart: queryStartMs, start: startMs, end: endMs, bucketCount: buckets, bucketMs },
      );
      const [sessionResult, workspaceResult] = await Promise.allSettled([
        queryRows(
          `
            SELECT
              if(
                JSONExtractString(attribution, 'agentSessionId') != '',
                JSONExtractString(attribution, 'agentSessionId'),
                if(
                  JSONExtractString(attribution, 'agentDisplayName') != '',
                  JSONExtractString(attribution, 'agentDisplayName'),
                  if(JSONExtractString(attribution, 'agentScopeId') != '', JSONExtractString(attribution, 'agentScopeId'), agentId)
                )
              ) AS sessionLabel,
              argMax(userId, eventAt) AS userId,
              argMax(
                if(
                  JSONExtractString(process, 'cwd') != '',
                  JSONExtractString(process, 'cwd'),
                  if(
                    JSONExtractString(attribution, 'agentScopeId') != '',
                    concat('agent://', JSONExtractString(attribution, 'agentScopeId')),
                    workspacePath
                  )
                ),
                eventAt
              ) AS resolvedWorkspacePath,
              count() AS eventCount,
              countIf(verdict != 'allow') AS riskyEventCount,
              sum(riskScore) AS riskScoreTotal,
              max(eventAt) AS lastEventAt,
              countIf(verdict != 'allow' AND riskCategory = 'command_danger') AS commandDanger,
              countIf(verdict != 'allow' AND riskCategory = 'prompt_injection') AS promptInjection,
              countIf(verdict != 'allow' AND riskCategory IN ('data_leak', 'secret_exfil')) AS dataLeak,
              countIf(verdict != 'allow' AND riskCategory = 'communication_risk') AS communicationRisk,
              countIf(verdict != 'allow' AND riskCategory IN ('systemic_risk', 'privilege_escalation')) AS systemicRisk
            FROM (${latestMonitored})
            GROUP BY sessionLabel
            ORDER BY riskScoreTotal DESC
            LIMIT 1`,
          { start: startMs, end: endMs },
          BOUNDED_DASHBOARD_DETAIL_READ_SETTINGS,
        ),
        queryRows(
          `
            SELECT
              if(
                JSONExtractString(process, 'cwd') != '',
                JSONExtractString(process, 'cwd'),
                if(
                  JSONExtractString(attribution, 'agentScopeId') != '',
                  concat('agent://', JSONExtractString(attribution, 'agentScopeId')),
                  workspacePath
                )
              ) AS resolvedWorkspacePath,
              uniqCombined64(
                if(
                  JSONExtractString(attribution, 'agentSessionId') != '',
                  JSONExtractString(attribution, 'agentSessionId'),
                  if(JSONExtractString(attribution, 'agentScopeId') != '', JSONExtractString(attribution, 'agentScopeId'), sessionId)
                )
              ) AS sessionCount,
              sum(riskScore) AS totalRiskScore,
              maxIf(
                multiIf(severity = 'critical', 4, severity = 'high', 3, severity = 'medium', 2, severity = 'low', 1, 0),
                verdict != 'allow'
              ) AS worstSeverityRank
            FROM (${latestMonitored})
            GROUP BY resolvedWorkspacePath
            ORDER BY totalRiskScore DESC
            LIMIT 500`,
          { start: startMs, end: endMs },
          BOUNDED_DASHBOARD_DETAIL_READ_SETTINGS,
        ),
      ]);
      if (sessionResult.status === 'rejected') throw sessionResult.reason;
      if (workspaceResult.status === 'rejected') throw workspaceResult.reason;
      const sessionRows = sessionResult.value;
      const workspaceRows = workspaceResult.value;
      const num = (value: unknown): number => Number(value) || 0;
      const dimensions = dimensionRows.map<DashboardWindowDimensionRow>((row) => ({
        period: String(row.period) === 'previous' ? 'previous' : 'current',
        monitored: Boolean(num(row.monitored)),
        verdict: String(row.verdict ?? ''),
        tier: String(row.tier ?? ''),
        riskType: String(row.riskType ?? ''),
        riskCategory: String(row.riskCategory ?? ''),
        riskName: String(row.riskName ?? ''),
        eventCount: num(row.eventCount),
        tokenCount: num(row.tokenCount),
        latencyTotal: num(row.latencyTotal),
        riskScoreTotal: num(row.riskScoreTotal),
      }));
      const bucketRows = bucketRowsRaw.map<DashboardWindowBucketRow>((row) => ({
        bucketIndex: num(row.bucketIndex),
        monitored: Boolean(num(row.monitored)),
        eventCount: num(row.eventCount),
        blockedCount: num(row.blockedCount),
        escalatedCount: num(row.escalatedCount),
        l2Count: num(row.l2Count),
        l3Count: num(row.l3Count),
        riskActivationCount: num(row.riskActivationCount),
        tokenCount: num(row.tokenCount),
        latencyTotal: num(row.latencyTotal),
        riskScoreTotal: num(row.riskScoreTotal),
      }));
      const top = sessionRows[0];
      const topSession = top ? {
        sessionId: String(top.sessionLabel ?? ''),
        userId: String(top.userId ?? ''),
        workspacePath: String(top.resolvedWorkspacePath ?? ''),
        eventCount: num(top.eventCount),
        riskyEventCount: num(top.riskyEventCount),
        riskScoreTotal: num(top.riskScoreTotal),
        lastEventAt: num(top.lastEventAt),
        dimensionCounts: {
          command_danger: num(top.commandDanger),
          prompt_injection: num(top.promptInjection),
          data_leak: num(top.dataLeak),
          jailbreak: num(top.promptInjection),
          communication_risk: num(top.communicationRisk),
          systemic_risk: num(top.systemicRisk),
        },
      } : undefined;
      const workspaces = workspaceRows.map((row) => ({
        workspacePath: String(row.resolvedWorkspacePath ?? ''),
        sessionCount: num(row.sessionCount),
        totalRiskScore: num(row.totalRiskScore),
        worstSeverityRank: num(row.worstSeverityRank),
      }));
      return { countsApproximate: true, dimensions, buckets: bucketRows, topSession, workspaces };
    } catch (error) {
      console.error('[clickhouse] dashboard window aggregation failed:', (error as Error).message);
      return null;
    } finally {
      release();
    }
  }

  /** Query durable event history. Identity visibility is deliberately applied by the service
   * after current human-review metadata is resolved; a mutable review decision must never be
   * baked into this immutable evidence query. */
  async searchEvents(input: StoredEventQuery): Promise<JudgedEvent[]> {
    if (!this.client) return [];
    const conditions = ['at >= {since:UInt64}', 'at <= {until:UInt64}'];
    const queryParams: Record<string, string | number> = { since: input.sinceMs, until: input.untilMs };
    const fields: Array<[keyof StoredEventQuery, string]> = [
      ['eventId', 'eventId'],
      ['sourceId', 'sourceId'],
      ['collectorId', 'collectorId'],
      ['agentId', 'agentId'],
      ['sessionId', 'sessionId'],
      ['workspacePath', 'workspacePath'],
      ['traceId', 'traceId'],
      ['runId', 'runId'],
      ['eventKind', 'eventKind'],
      ['eventCategory', 'eventCategory'],
      ['verdict', 'verdict'],
      ['tier', 'tier'],
    ];
    for (const [key, column] of fields) {
      const value = input[key];
      if (typeof value !== 'string' || !value.trim()) continue;
      conditions.push(`${column} = {${String(key)}:String}`);
      queryParams[String(key)] = value.trim();
    }
    const rowLimit = Math.max(1, Math.min(100_000, input.limit));
    queryParams.limit = rowLimit;
    try {
      const rs = await this.client.query({
        query: `SELECT * FROM ${TABLE} WHERE ${conditions.join(' AND ')} ORDER BY at DESC, decisionUpdatedAt DESC LIMIT {limit:UInt32}`,
        query_params: queryParams,
        format: 'JSONEachRow',
      });
      const rows = (await rs.json()) as Array<Record<string, unknown>>;
      const latest = new Map<string, JudgedEvent>();
      for (const row of rows) {
        const event = fromRow(row);
        if (!latest.has(event.eventId)) latest.set(event.eventId, event);
      }
      return [...latest.values()].sort((a, b) => b.at - a.at);
    } catch (err) {
      console.error('[clickhouse] event search failed:', (err as Error).message);
      return [];
    }
  }

  /** Load the persisted judge policy (the singleton config row), or null if none/unreachable. */
  async loadConfig(): Promise<PolicyConfig | null> {
    if (!this.client) return null;
    try {
      const rs = await this.client.query({
        query: `SELECT value FROM ${CONFIG_TABLE} FINAL WHERE key = 'policy' LIMIT 1`,
        format: 'JSONEachRow',
      });
      const rows = (await rs.json()) as Array<{ value: string }>;
      return rows.length ? (JSON.parse(rows[0].value) as PolicyConfig) : null;
    } catch (err) {
      console.error('[clickhouse] loadConfig failed:', (err as Error).message);
      return null;
    }
  }

  /** Persist the judge policy (survives restarts). No-op if ClickHouse is unconfigured/down. */
  async saveConfig(config: PolicyConfig): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.insert({
        table: CONFIG_TABLE,
        values: [{ key: 'policy', value: JSON.stringify(config), updated_at: Date.now() }],
        format: 'JSONEachRow',
      });
    } catch (err) {
      console.error('[clickhouse] saveConfig failed:', (err as Error).message);
    }
  }

  async loadIncidentState(): Promise<Record<string, IncidentState>> {
    if (!this.client) return {};
    try {
      const rs = await this.client.query({
        query: `SELECT value FROM ${CONFIG_TABLE} FINAL WHERE key = 'incident_state' LIMIT 1`,
        format: 'JSONEachRow',
      });
      const rows = (await rs.json()) as Array<{ value: string }>;
      return rows.length ? (JSON.parse(rows[0].value) as Record<string, IncidentState>) : {};
    } catch (err) {
      console.error('[clickhouse] loadIncidentState failed:', (err as Error).message);
      return {};
    }
  }

  async saveIncidentState(incidents: Incident[]): Promise<void> {
    if (!this.client) return;
    const state: Record<string, IncidentState> = {};
    for (const i of incidents) {
      if (i.status !== 'open' || i.owner || i.note || i.acknowledgedAt || i.resolvedAt) {
        state[i.incidentId] = {
          incidentId: i.incidentId,
          status: i.status,
          owner: i.owner,
          note: i.note,
          acknowledgedAt: i.acknowledgedAt,
          resolvedAt: i.resolvedAt,
          updatedAt: i.updatedAt,
        };
      }
    }
    try {
      await this.client.insert({
        table: CONFIG_TABLE,
        values: [{ key: 'incident_state', value: JSON.stringify(state), updated_at: Date.now() }],
        format: 'JSONEachRow',
      });
    } catch (err) {
      console.error('[clickhouse] saveIncidentState failed:', (err as Error).message);
    }
  }

  async loadAlertState(): Promise<AlertRecord[]> {
    if (!this.client) return [];
    try {
      const rs = await this.client.query({
        query: `SELECT value FROM ${CONFIG_TABLE} FINAL WHERE key = 'alert_state' LIMIT 1`,
        format: 'JSONEachRow',
      });
      const rows = (await rs.json()) as Array<{ value: string }>;
      return rows.length ? (JSON.parse(rows[0].value) as AlertRecord[]) : [];
    } catch (err) {
      console.error('[clickhouse] loadAlertState failed:', (err as Error).message);
      return [];
    }
  }

  async saveAlertState(alerts: AlertRecord[]): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.insert({
        table: CONFIG_TABLE,
        values: [{ key: 'alert_state', value: JSON.stringify(alerts), updated_at: Date.now() }],
        format: 'JSONEachRow',
      });
    } catch (err) {
      console.error('[clickhouse] saveAlertState failed:', (err as Error).message);
    }
  }

  async loadRemediationState(): Promise<RemediationRecord[]> {
    if (!this.client) return [];
    try {
      const rs = await this.client.query({
        query: `SELECT value FROM ${CONFIG_TABLE} FINAL WHERE key = 'remediation_state' LIMIT 1`,
        format: 'JSONEachRow',
      });
      const rows = (await rs.json()) as Array<{ value: string }>;
      return rows.length ? (JSON.parse(rows[0].value) as RemediationRecord[]) : [];
    } catch (err) {
      console.error('[clickhouse] loadRemediationState failed:', (err as Error).message);
      return [];
    }
  }

  async saveRemediationState(tasks: RemediationRecord[]): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.insert({
        table: CONFIG_TABLE,
        values: [{ key: 'remediation_state', value: JSON.stringify(tasks), updated_at: Date.now() }],
        format: 'JSONEachRow',
      });
    } catch (err) {
      console.error('[clickhouse] saveRemediationState failed:', (err as Error).message);
    }
  }

  async loadAuditLog(): Promise<AuditRecord[]> {
    if (!this.client) return [];
    try {
      const rs = await this.client.query({
        query: `SELECT value FROM ${CONFIG_TABLE} FINAL WHERE key = 'audit_log' LIMIT 1`,
        format: 'JSONEachRow',
      });
      const rows = (await rs.json()) as Array<{ value: string }>;
      const parsed = rows.length ? (JSON.parse(rows[0].value) as unknown) : [];
      return Array.isArray(parsed) ? (parsed as AuditRecord[]) : [];
    } catch (err) {
      console.error('[clickhouse] loadAuditLog failed:', (err as Error).message);
      return [];
    }
  }

  async saveAuditLog(records: AuditRecord[]): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.insert({
        table: CONFIG_TABLE,
        values: [{ key: 'audit_log', value: JSON.stringify(records), updated_at: Date.now() }],
        format: 'JSONEachRow',
      });
    } catch (err) {
      console.error('[clickhouse] saveAuditLog failed:', (err as Error).message);
    }
  }

  async loadAgentMetadata(): Promise<AgentMetadataRecord[]> {
    if (!this.client) return [];
    try {
      const rs = await this.client.query({
        query: `SELECT key, value FROM ${CONFIG_TABLE} FINAL WHERE key IN ('agent_metadata', 'agent_metadata_v2') ORDER BY key DESC LIMIT 1`,
        format: 'JSONEachRow',
      });
      const rows = (await rs.json()) as Array<{ key: string; value: string }>;
      const parsed = rows.length ? (JSON.parse(rows[0].value) as unknown) : [];
      if (Array.isArray(parsed)) return parsed as AgentMetadataRecord[];
      if (
        parsed &&
        typeof parsed === 'object' &&
        (parsed as { schemaVersion?: unknown }).schemaVersion === 'anysentry.agent_metadata.v2' &&
        Array.isArray((parsed as { assets?: unknown }).assets)
      ) {
        return (parsed as { assets: AgentMetadataRecord[] }).assets;
      }
      return [];
    } catch (err) {
      console.error('[clickhouse] loadAgentMetadata failed:', (err as Error).message);
      return [];
    }
  }

  async saveAgentMetadata(records: AgentMetadataRecord[]): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.insert({
        table: CONFIG_TABLE,
        values: [{
          key: 'agent_metadata_v2',
          value: JSON.stringify({ schemaVersion: 'anysentry.agent_metadata.v2', assets: records }),
          updated_at: Date.now(),
        }],
        format: 'JSONEachRow',
      });
    } catch (err) {
      console.error('[clickhouse] saveAgentMetadata failed:', (err as Error).message);
    }
  }

  async loadIdentityAiReviews(): Promise<IdentityAiReviewRecord[]> {
    if (!this.client) return [];
    try {
      const rs = await this.client.query({
        query: `SELECT value FROM ${CONFIG_TABLE} FINAL WHERE key = 'identity_ai_reviews' LIMIT 1`,
        format: 'JSONEachRow',
      });
      const rows = (await rs.json()) as Array<{ value: string }>;
      const parsed = rows.length ? (JSON.parse(rows[0].value) as unknown) : [];
      return Array.isArray(parsed) ? (parsed as IdentityAiReviewRecord[]) : [];
    } catch (err) {
      console.error('[clickhouse] loadIdentityAiReviews failed:', (err as Error).message);
      return [];
    }
  }

  async saveIdentityAiReviews(records: IdentityAiReviewRecord[]): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.insert({
        table: CONFIG_TABLE,
        values: [{ key: 'identity_ai_reviews', value: JSON.stringify(records.slice(-1_000)), updated_at: Date.now() }],
        format: 'JSONEachRow',
      });
    } catch (err) {
      console.error('[clickhouse] saveIdentityAiReviews failed:', (err as Error).message);
    }
  }

  async loadMaintenanceWindows(): Promise<MaintenanceWindowRecord[]> {
    if (!this.client) return [];
    try {
      const rs = await this.client.query({
        query: `SELECT value FROM ${CONFIG_TABLE} FINAL WHERE key = 'maintenance_windows' LIMIT 1`,
        format: 'JSONEachRow',
      });
      const rows = (await rs.json()) as Array<{ value: string }>;
      const parsed = rows.length ? (JSON.parse(rows[0].value) as unknown) : [];
      return Array.isArray(parsed) ? (parsed as MaintenanceWindowRecord[]) : [];
    } catch (err) {
      console.error('[clickhouse] loadMaintenanceWindows failed:', (err as Error).message);
      return [];
    }
  }

  async saveMaintenanceWindows(records: MaintenanceWindowRecord[]): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.insert({
        table: CONFIG_TABLE,
        values: [{ key: 'maintenance_windows', value: JSON.stringify(records), updated_at: Date.now() }],
        format: 'JSONEachRow',
      });
    } catch (err) {
      console.error('[clickhouse] saveMaintenanceWindows failed:', (err as Error).message);
    }
  }

  async loadNotificationState(): Promise<NotificationState> {
    if (!this.client) return { channels: [], routes: [], deliveries: [] };
    try {
      const rs = await this.client.query({
        query: `SELECT value FROM ${CONFIG_TABLE} FINAL WHERE key = 'notification_state' LIMIT 1`,
        format: 'JSONEachRow',
      });
      const rows = (await rs.json()) as Array<{ value: string }>;
      const parsed = rows.length ? (JSON.parse(rows[0].value) as Partial<NotificationState>) : {};
      return {
        channels: Array.isArray(parsed.channels) ? parsed.channels : [],
        routes: Array.isArray(parsed.routes) ? parsed.routes : [],
        deliveries: Array.isArray(parsed.deliveries) ? parsed.deliveries : [],
      };
    } catch (err) {
      console.error('[clickhouse] loadNotificationState failed:', (err as Error).message);
      return { channels: [], routes: [], deliveries: [] };
    }
  }

  async saveNotificationState(state: NotificationState): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.insert({
        table: CONFIG_TABLE,
        values: [{ key: 'notification_state', value: JSON.stringify(state), updated_at: Date.now() }],
        format: 'JSONEachRow',
      });
    } catch (err) {
      console.error('[clickhouse] saveNotificationState failed:', (err as Error).message);
    }
  }

  async loadObjectives(): Promise<ObjectiveRecord[]> {
    if (!this.client) return [];
    try {
      const rs = await this.client.query({
        query: `SELECT value FROM ${CONFIG_TABLE} FINAL WHERE key = 'objective_state' LIMIT 1`,
        format: 'JSONEachRow',
      });
      const rows = (await rs.json()) as Array<{ value: string }>;
      const parsed = rows.length ? (JSON.parse(rows[0].value) as unknown) : [];
      return Array.isArray(parsed) ? (parsed as ObjectiveRecord[]) : [];
    } catch (err) {
      console.error('[clickhouse] loadObjectives failed:', (err as Error).message);
      return [];
    }
  }

  async saveObjectives(records: ObjectiveRecord[]): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.insert({
        table: CONFIG_TABLE,
        values: [{ key: 'objective_state', value: JSON.stringify(records), updated_at: Date.now() }],
        format: 'JSONEachRow',
      });
    } catch (err) {
      console.error('[clickhouse] saveObjectives failed:', (err as Error).message);
    }
  }

  async loadIngestionSources(): Promise<IngestionSourceRecord[]> {
    if (!this.client) return [];
    try {
      const rs = await this.client.query({
        query: `SELECT value FROM ${CONFIG_TABLE} FINAL WHERE key = 'source_state' LIMIT 1`,
        format: 'JSONEachRow',
      });
      const rows = (await rs.json()) as Array<{ value: string }>;
      const parsed = rows.length ? (JSON.parse(rows[0].value) as unknown) : [];
      return Array.isArray(parsed) ? (parsed as IngestionSourceRecord[]) : [];
    } catch (err) {
      console.error('[clickhouse] loadIngestionSources failed:', (err as Error).message);
      return [];
    }
  }

  async saveIngestionSources(records: IngestionSourceRecord[]): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.insert({
        table: CONFIG_TABLE,
        values: [{ key: 'source_state', value: JSON.stringify(records), updated_at: Date.now() }],
        format: 'JSONEachRow',
      });
    } catch (err) {
      console.error('[clickhouse] saveIngestionSources failed:', (err as Error).message);
    }
  }

  async loadCollectorHeartbeats(): Promise<CollectorHeartbeatRecord[]> {
    if (!this.client) return [];
    try {
      const rs = await this.client.query({
        query: `SELECT value FROM ${CONFIG_TABLE} FINAL WHERE key = 'collector_heartbeats' LIMIT 1`,
        format: 'JSONEachRow',
      });
      const rows = (await rs.json()) as Array<{ value: string }>;
      const parsed = rows.length ? (JSON.parse(rows[0].value) as unknown) : [];
      return Array.isArray(parsed) ? (parsed as CollectorHeartbeatRecord[]) : [];
    } catch (err) {
      console.error('[clickhouse] loadCollectorHeartbeats failed:', (err as Error).message);
      return [];
    }
  }

  async saveCollectorHeartbeats(records: CollectorHeartbeatRecord[]): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.insert({
        table: CONFIG_TABLE,
        values: [{ key: 'collector_heartbeats', value: JSON.stringify(records), updated_at: Date.now() }],
        format: 'JSONEachRow',
      });
    } catch (err) {
      console.error('[clickhouse] saveCollectorHeartbeats failed:', (err as Error).message);
    }
  }

  async close(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    await this.flush();
    await this.client?.close();
  }
}
