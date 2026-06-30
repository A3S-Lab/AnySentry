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
import { PolicyConfig } from './policy-config';
import { AgentMetadataRecord, AlertRecord, AuditRecord, CollectorHeartbeatRecord, Incident, IngestionSourceRecord, JudgedEvent, MaintenanceWindowRecord, NotificationState, ObjectiveRecord, RemediationRecord } from './types';

const TABLE = 'events';
// `at` is raw epoch-ms (matches the aggregator); `ts` is a derived DateTime only for TTL/partitioning.
const DDL = (table: string) => `CREATE TABLE IF NOT EXISTS ${table} (
  schemaVersion LowCardinality(String),
  eventId String,
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
  rawPreview String,
  ts DateTime MATERIALIZED toDateTime(intDiv(at, 1000))
) ENGINE = MergeTree
ORDER BY at
TTL ts + INTERVAL 90 DAY`;

const EVENT_ALTERS = [
  'ADD COLUMN IF NOT EXISTS schemaVersion LowCardinality(String) DEFAULT \'anysentry.agent_event.v1\'',
  'ADD COLUMN IF NOT EXISTS eventId String DEFAULT \'\'',
  'ADD COLUMN IF NOT EXISTS eventCategory LowCardinality(String) DEFAULT \'unknown\'',
  'ADD COLUMN IF NOT EXISTS source LowCardinality(String) DEFAULT \'observer\'',
  'ADD COLUMN IF NOT EXISTS collectorId String DEFAULT \'\'',
  'ADD COLUMN IF NOT EXISTS sourceId String DEFAULT \'\'',
  'ADD COLUMN IF NOT EXISTS traceId String DEFAULT \'\'',
  'ADD COLUMN IF NOT EXISTS spanId String DEFAULT \'\'',
  'ADD COLUMN IF NOT EXISTS parentSpanId String DEFAULT \'\'',
  'ADD COLUMN IF NOT EXISTS runId String DEFAULT \'\'',
  'ADD COLUMN IF NOT EXISTS taskId String DEFAULT \'\'',
  'ADD COLUMN IF NOT EXISTS attributes String DEFAULT \'{}\'',
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

type Row = Omit<JudgedEvent, 'actionKind' | 'actionTarget' | 'attributes' | 'collectorId' | 'sourceId' | 'parentSpanId' | 'taskId' | 'rawPreview'> & {
  actionKind: string;
  actionTarget: string;
  attributes: string;
  collectorId: string;
  sourceId: string;
  parentSpanId: string;
  taskId: string;
  rawPreview: string;
};
export type IncidentState = Pick<Incident, 'incidentId' | 'status' | 'owner' | 'note' | 'acknowledgedAt' | 'resolvedAt' | 'updatedAt'>;

function attrString(attributes: JudgedEvent['attributes'], key: string): string {
  const value = attributes[key];
  return value == null ? '' : String(value).trim();
}

function toRow(e: JudgedEvent): Row {
  return {
    schemaVersion: e.schemaVersion,
    eventId: e.eventId,
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
    rawPreview: e.rawPreview ?? '',
  };
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
    rawPreview: str(r.rawPreview) || undefined,
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
        query: `SELECT value FROM ${CONFIG_TABLE} FINAL WHERE key = 'agent_metadata' LIMIT 1`,
        format: 'JSONEachRow',
      });
      const rows = (await rs.json()) as Array<{ value: string }>;
      const parsed = rows.length ? (JSON.parse(rows[0].value) as unknown) : [];
      return Array.isArray(parsed) ? (parsed as AgentMetadataRecord[]) : [];
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
        values: [{ key: 'agent_metadata', value: JSON.stringify(records), updated_at: Date.now() }],
        format: 'JSONEachRow',
      });
    } catch (err) {
      console.error('[clickhouse] saveAgentMetadata failed:', (err as Error).message);
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
