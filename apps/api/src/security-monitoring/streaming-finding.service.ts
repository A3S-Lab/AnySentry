import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ClickHouseClient, createClient } from '@clickhouse/client';
import {
  CompositeJudgmentFinding,
  CompositeRiskFinding,
  PersistedStreamFinding,
  RiskProfileFinding,
  StreamFindingList,
} from './streaming.types';
import { SecurityTimeFilter } from './types';

const PROFILE_TABLE = 'stream_risk_profiles';
const COMPOSITE_TABLE = 'stream_composite_risks';
const LEGACY_COMPOSITE_JUDGMENT_TABLE = 'stream_composite_judgments';
const COMPOSITE_JUDGMENT_TABLE = 'stream_composite_judgment_revisions';

const PROFILE_DDL = `CREATE TABLE IF NOT EXISTS ${PROFILE_TABLE} (
  profileId String,
  findingId String,
  version UInt64,
  tenantId String,
  environmentId String,
  workspaceId String,
  workspacePath String,
  agentCorrelationId String,
  agentType String,
  windowStart UInt64,
  windowEnd UInt64,
  calculatedAt UInt64,
  riskScore Float64,
  riskLevel LowCardinality(String),
  features String,
  hitRules String,
  ruleVersion String,
  shadow UInt8,
  ts DateTime MATERIALIZED toDateTime(intDiv(calculatedAt, 1000))
) ENGINE = ReplacingMergeTree(version)
ORDER BY profileId
TTL ts + INTERVAL 90 DAY`;

const COMPOSITE_DDL = `CREATE TABLE IF NOT EXISTS ${COMPOSITE_TABLE} (
  correlationId String,
  findingId String,
  version UInt64,
  tenantId String,
  environmentId String,
  workspaceId String,
  workspacePath String,
  agentCorrelationId String,
  agentType String,
  sessionId String,
  traceId String,
  ruleId String,
  ruleVersion String,
  windowStart UInt64,
  windowEnd UInt64,
  calculatedAt UInt64,
  evidenceScore Float64,
  severity LowCardinality(String),
  evidenceEventIds String,
  evidence String,
  reason String,
  shadow UInt8,
  ts DateTime MATERIALIZED toDateTime(intDiv(calculatedAt, 1000))
) ENGINE = ReplacingMergeTree(version)
ORDER BY correlationId
TTL ts + INTERVAL 90 DAY`;

const compositeJudgmentDdl = (table: string, orderBy: string) => `CREATE TABLE IF NOT EXISTS ${table} (
  episodeId String,
  findingId String,
  revision UInt64,
  recordVersion UInt64,
  evidenceFingerprint String,
  tenantId String,
  environmentId String,
  workspaceId String,
  workspacePath String,
  agentCorrelationId String,
  agentType String,
  sessionId String,
  traceIds String,
  windowStart UInt64,
  windowEnd UInt64,
  judgedAt UInt64,
  status LowCardinality(String),
  verdict LowCardinality(String),
  severity LowCardinality(String),
  confidence Float64,
  classification LowCardinality(String),
  attackType String,
  reason String,
  evidenceEventIds String,
  evidence String,
  model String,
  latencyMs UInt64,
  error String,
  ruleVersion LowCardinality(String),
  decisionSource LowCardinality(String),
  synthetic UInt8,
  shadow UInt8,
  ts DateTime MATERIALIZED toDateTime(intDiv(judgedAt, 1000))
) ENGINE = ReplacingMergeTree(recordVersion)
ORDER BY ${orderBy}
TTL ts + INTERVAL 90 DAY`;

const compositeJudgmentAlters = (table: string) => [
  `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS classification LowCardinality(String) AFTER confidence`,
  `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ruleVersion LowCardinality(String) AFTER error`,
  `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS decisionSource LowCardinality(String) AFTER ruleVersion`,
  `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS synthetic UInt8 AFTER decisionSource`,
];

const COMPOSITE_JUDGMENT_COLUMNS = [
  'episodeId', 'findingId', 'revision', 'recordVersion', 'evidenceFingerprint',
  'tenantId', 'environmentId', 'workspaceId', 'workspacePath', 'agentCorrelationId',
  'agentType', 'sessionId', 'traceIds', 'windowStart', 'windowEnd', 'judgedAt',
  'status', 'verdict', 'severity', 'confidence', 'classification', 'attackType',
  'reason', 'evidenceEventIds', 'evidence', 'model', 'latencyMs', 'error',
  'ruleVersion', 'decisionSource', 'synthetic', 'shadow',
].join(', ');

function parseJson<T>(value: unknown, fallback: T): T {
  try {
    return JSON.parse(String(value ?? '')) as T;
  } catch {
    return fallback;
  }
}

function num(value: unknown): number {
  return Number(value) || 0;
}
function nonNegativeFeatures(value: unknown): Record<string, number> {
  const features = parseJson<Record<string, number>>(value, {});
  return Object.fromEntries(
    Object.entries(features).map(([key, count]) => [key, Math.max(0, num(count))]),
  );
}


function sinceMs(filter: SecurityTimeFilter): number {
  const now = Date.now();
  if (filter.timeType === 'last_1d') return now - 24 * 60 * 60_000;
  if (filter.timeType === 'last_7d') return now - 7 * 24 * 60 * 60_000;
  if (filter.timeType === 'last_30d') return now - 30 * 24 * 60 * 60_000;
  if (filter.timeType === 'custom') {
    const parsed = Date.parse(filter.startTime ?? '');
    return Number.isFinite(parsed) ? parsed : now - 3 * 60 * 60_000;
  }
  return now - 3 * 60 * 60_000;
}

function compositeJudgmentFromRow(row: Record<string, unknown>): CompositeJudgmentFinding {
  return {
    schemaVersion: 'anysentry.stream_finding.v1',
    findingType: 'composite_judgment',
    findingId: String(row.findingId ?? ''),
    episodeId: String(row.episodeId ?? ''),
    revision: num(row.revision),
    evidenceFingerprint: String(row.evidenceFingerprint ?? ''),
    tenantId: String(row.tenantId ?? ''),
    environmentId: String(row.environmentId ?? ''),
    workspaceId: String(row.workspaceId ?? ''),
    workspacePath: String(row.workspacePath ?? ''),
    agentCorrelationId: String(row.agentCorrelationId ?? ''),
    agentType: String(row.agentType ?? ''),
    sessionId: String(row.sessionId ?? ''),
    traceIds: parseJson<string[]>(row.traceIds, []),
    windowStart: num(row.windowStart),
    windowEnd: num(row.windowEnd),
    judgedAt: num(row.judgedAt),
    status: String(row.status ?? 'failed') as CompositeJudgmentFinding['status'],
    verdict: (String(row.verdict ?? '') || undefined) as CompositeJudgmentFinding['verdict'],
    severity: (String(row.severity ?? '') || undefined) as CompositeJudgmentFinding['severity'],
    confidence: String(row.status ?? '') === 'succeeded' && row.confidence !== undefined
      ? num(row.confidence)
      : undefined,
    classification: (String(row.classification ?? '') || undefined) as CompositeJudgmentFinding['classification'],
    attackType: String(row.attackType ?? '') || undefined,
    reason: String(row.reason ?? '') || undefined,
    evidenceEventIds: parseJson<string[]>(row.evidenceEventIds, []),
    evidence: parseJson<CompositeJudgmentFinding['evidence']>(row.evidence, []),
    model: String(row.model ?? ''),
    latencyMs: num(row.latencyMs),
    error: String(row.error ?? '') || undefined,
    ruleVersion: String(row.ruleVersion ?? ''),
    decisionSource: String(row.decisionSource ?? '') === 'deterministic_rule'
      ? 'deterministic_rule'
      : 'composite_judge',
    synthetic: num(row.synthetic) === 1,
    shadow: true,
  };
}

export function collapseCompositeJudgmentRevisions(
  findings: CompositeJudgmentFinding[],
): CompositeJudgmentFinding[] {
  const episodes = new Map<string, CompositeJudgmentFinding[]>();
  for (const finding of findings) {
    const revisions = episodes.get(finding.episodeId) ?? [];
    revisions.push(finding);
    episodes.set(finding.episodeId, revisions);
  }
  return [...episodes.values()]
    .map((revisions) => {
      revisions.sort((a, b) => b.revision - a.revision || b.judgedAt - a.judgedAt);
      const latest = revisions[0];
      const latestSucceeded = revisions.find((item) => item.status === 'succeeded');
      if (!latestSucceeded || latest.status === 'succeeded' || latest.revision <= latestSucceeded.revision) {
        return latestSucceeded ?? latest;
      }
      if (latest.status === 'suppressed') return latestSucceeded;
      return {
        ...latestSucceeded,
        updateRevision: latest.revision,
        updateStatus: latest.status,
        updateError: latest.error,
        updateJudgedAt: latest.judgedAt,
      };
    })
    .sort((a, b) => (b.updateJudgedAt ?? b.judgedAt) - (a.updateJudgedAt ?? a.judgedAt));
}

export class StreamFindingStore {
  private client?: ClickHouseClient;
  private ready = false;

  get enabled(): boolean {
    return this.ready;
  }

  async init(): Promise<boolean> {
    if (this.ready) return true;
    const url = process.env.CLICKHOUSE_URL;
    if (!url) return false;
    const database = process.env.CLICKHOUSE_DB || 'anysentry';
    const username = process.env.CLICKHOUSE_USER || 'default';
    const password = process.env.CLICKHOUSE_PASSWORD || '';
    try {
      const boot = createClient({ url, username, password });
      await boot.command({ query: `CREATE DATABASE IF NOT EXISTS ${database}` });
      await boot.close();
      this.client = createClient({ url, database, username, password });
      await this.client.command({ query: PROFILE_DDL });
      await this.client.command({ query: COMPOSITE_DDL });
      await this.client.command({
        query: compositeJudgmentDdl(LEGACY_COMPOSITE_JUDGMENT_TABLE, 'episodeId'),
      });
      for (const query of compositeJudgmentAlters(LEGACY_COMPOSITE_JUDGMENT_TABLE)) {
        await this.client.command({ query });
      }
      await this.client.command({
        query: compositeJudgmentDdl(COMPOSITE_JUDGMENT_TABLE, '(episodeId, revision)'),
      });
      for (const query of compositeJudgmentAlters(COMPOSITE_JUDGMENT_TABLE)) {
        await this.client.command({ query });
      }
      const revisionCountResult = await this.client.query({
        query: `SELECT count() AS count FROM ${COMPOSITE_JUDGMENT_TABLE}`,
        format: 'JSONEachRow',
      });
      const revisionCountRows = await revisionCountResult.json() as Array<{ count?: string | number }>;
      if (num(revisionCountRows[0]?.count) === 0) {
        await this.client.command({
          query: `INSERT INTO ${COMPOSITE_JUDGMENT_TABLE} (${COMPOSITE_JUDGMENT_COLUMNS})
            SELECT ${COMPOSITE_JUDGMENT_COLUMNS} FROM ${LEGACY_COMPOSITE_JUDGMENT_TABLE}`,
        });
      }
      this.ready = true;
      return true;
    } catch (error) {
      console.error('[streaming] finding store init failed', error instanceof Error ? error.message : String(error));
      await this.client?.close();
      this.client = undefined;
      return false;
    }
  }

  async upsert(finding: PersistedStreamFinding): Promise<void> {
    if (!this.client || !this.ready) throw new Error('stream finding store is unavailable');
    if (finding.findingType === 'risk_profile') {
      await this.client.insert({
        table: PROFILE_TABLE,
        values: [{
          ...finding,
          features: JSON.stringify(finding.features),
          hitRules: JSON.stringify(finding.hitRules),
          shadow: 1,
          schemaVersion: undefined,
          findingType: undefined,
        }],
        format: 'JSONEachRow',
      });
      return;
    }
    if (finding.findingType === 'composite_risk') {
      await this.client.insert({
        table: COMPOSITE_TABLE,
        values: [{
          ...finding,
          sessionId: finding.sessionId ?? '',
          traceId: finding.traceId ?? '',
          evidenceEventIds: JSON.stringify(finding.evidenceEventIds),
          evidence: JSON.stringify(finding.evidence),
          shadow: 1,
          schemaVersion: undefined,
          findingType: undefined,
        }],
        format: 'JSONEachRow',
      });
      return;
    }
    await this.client.insert({
      table: COMPOSITE_JUDGMENT_TABLE,
      values: [{
        ...finding,
        recordVersion: finding.judgedAt,
        traceIds: JSON.stringify(finding.traceIds),
        verdict: finding.verdict ?? '',
        severity: finding.severity ?? '',
        confidence: finding.confidence ?? 0,
        classification: finding.classification ?? '',
        attackType: finding.attackType ?? '',
        reason: finding.reason ?? '',
        evidenceEventIds: JSON.stringify(finding.evidenceEventIds),
        evidence: JSON.stringify(finding.evidence),
        error: finding.error ?? '',
        ruleVersion: finding.ruleVersion,
        decisionSource: finding.decisionSource,
        synthetic: finding.synthetic ? 1 : 0,
        shadow: 1,
        schemaVersion: undefined,
        findingType: undefined,
      }],
      format: 'JSONEachRow',
    });
  }

  async list(filter: SecurityTimeFilter, limit = 30): Promise<StreamFindingList> {
    if (!this.client || !this.ready) {
      return { enabled: false, riskProfiles: [], compositeRisks: [], compositeJudgments: [], updateTime: new Date().toISOString() };
    }
    const since = sinceMs(filter);
    const safeLimit = Math.max(1, Math.min(200, limit));
    const [profileResult, compositeResult, compositeJudgmentResult] = await Promise.all([
      this.client.query({
        query: `SELECT * FROM ${PROFILE_TABLE} FINAL WHERE calculatedAt >= {since:UInt64} ORDER BY calculatedAt DESC LIMIT {limit:UInt32}`,
        query_params: { since, limit: safeLimit },
        format: 'JSONEachRow',
      }),
      this.client.query({
        query: `SELECT * FROM ${COMPOSITE_TABLE} FINAL WHERE calculatedAt >= {since:UInt64} ORDER BY calculatedAt DESC LIMIT {limit:UInt32}`,
        query_params: { since, limit: safeLimit },
        format: 'JSONEachRow',
      }),
      this.client.query({
        query: `SELECT * FROM ${COMPOSITE_JUDGMENT_TABLE} FINAL
          WHERE judgedAt >= {since:UInt64}
            AND ruleVersion IN ('composite-risk-v2', 'supply-chain-exploit-v1')
            AND episodeId IN (
              SELECT episodeId FROM ${COMPOSITE_JUDGMENT_TABLE} FINAL
              WHERE judgedAt >= {since:UInt64}
                AND ruleVersion IN ('composite-risk-v2', 'supply-chain-exploit-v1')
              GROUP BY episodeId
              ORDER BY max(judgedAt) DESC
              LIMIT {limit:UInt32}
            )
          ORDER BY episodeId, revision DESC, judgedAt DESC`,
        query_params: { since, limit: safeLimit },
        format: 'JSONEachRow',
      }),
    ]);
    const profileRows = await profileResult.json() as Array<Record<string, unknown>>;
    const compositeRows = await compositeResult.json() as Array<Record<string, unknown>>;
    const compositeJudgmentRows = await compositeJudgmentResult.json() as Array<Record<string, unknown>>;
    const riskProfiles = profileRows.map<RiskProfileFinding>((row) => ({
      schemaVersion: 'anysentry.stream_finding.v1',
      findingType: 'risk_profile',
      findingId: String(row.findingId ?? ''),
      profileId: String(row.profileId ?? ''),
      version: num(row.version),
      tenantId: String(row.tenantId ?? ''),
      environmentId: String(row.environmentId ?? ''),
      workspaceId: String(row.workspaceId ?? ''),
      workspacePath: String(row.workspacePath ?? ''),
      agentCorrelationId: String(row.agentCorrelationId ?? ''),
      agentType: String(row.agentType ?? ''),
      windowStart: num(row.windowStart),
      windowEnd: num(row.windowEnd),
      calculatedAt: num(row.calculatedAt),
      riskScore: num(row.riskScore),
      riskLevel: String(row.riskLevel ?? 'safe') as RiskProfileFinding['riskLevel'],
      features: nonNegativeFeatures(row.features),
      hitRules: parseJson<string[]>(row.hitRules, []),
      ruleVersion: String(row.ruleVersion ?? ''),
      shadow: true,
    })).filter((profile) =>
      !/^flink-\d+-/i.test(profile.agentType) && !profile.workspacePath.startsWith('repo://flink-'));
    const compositeRisks: CompositeRiskFinding[] = compositeRows.map((row) => ({
      schemaVersion: 'anysentry.stream_finding.v1',
      findingType: 'composite_risk',
      findingId: String(row.findingId ?? ''),
      correlationId: String(row.correlationId ?? ''),
      version: num(row.version),
      tenantId: String(row.tenantId ?? ''),
      environmentId: String(row.environmentId ?? ''),
      workspaceId: String(row.workspaceId ?? ''),
      workspacePath: String(row.workspacePath ?? ''),
      agentCorrelationId: String(row.agentCorrelationId ?? ''),
      agentType: String(row.agentType ?? ''),
      sessionId: String(row.sessionId ?? '') || undefined,
      traceId: String(row.traceId ?? '') || undefined,
      ruleId: 'sensitive-data-exfiltration',
      ruleVersion: '1',
      windowStart: num(row.windowStart),
      windowEnd: num(row.windowEnd),
      calculatedAt: num(row.calculatedAt),
      evidenceScore: num(row.evidenceScore),
      severity: String(row.severity ?? 'high') as CompositeRiskFinding['severity'],
      evidenceEventIds: parseJson<string[]>(row.evidenceEventIds, []),
      evidence: parseJson<CompositeRiskFinding['evidence']>(row.evidence, []),
      reason: String(row.reason ?? ''),
      shadow: true,
    }));
    const compositeJudgments = collapseCompositeJudgmentRevisions(
      compositeJudgmentRows.map(compositeJudgmentFromRow),
    ).slice(0, safeLimit);
    return { enabled: true, riskProfiles, compositeRisks, compositeJudgments, updateTime: new Date().toISOString() };
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = undefined;
    this.ready = false;
  }
}

@Injectable()
export class StreamingFindingService implements OnModuleInit, OnModuleDestroy {
  private readonly store = new StreamFindingStore();

  async onModuleInit(): Promise<void> {
    if (process.env.ANYSENTRY_STREAMING === 'on') await this.store.init();
  }

  list(filter: SecurityTimeFilter, limit?: number): Promise<StreamFindingList> {
    return this.store.list(filter, limit);
  }

  get enabled(): boolean {
    return this.store.enabled;
  }

  async onModuleDestroy(): Promise<void> {
    await this.store.close();
  }
}
