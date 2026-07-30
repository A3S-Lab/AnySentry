import { ClickHouseClient, createClient } from '@clickhouse/client';
import {
  DependencySnapshot,
  SupplyChainOverview,
  VulnerabilityAssessment,
  VulnerabilityFinding,
  WorkspaceRegistration,
  WorkspaceSnapshotBinding,
} from './supply-chain.types';

const WORKSPACES_TABLE = 'supply_chain_workspaces';
const SNAPSHOTS_TABLE = 'supply_chain_dependency_snapshots';
const BINDINGS_TABLE = 'supply_chain_workspace_snapshot_bindings';
const ASSESSMENTS_TABLE = 'supply_chain_vulnerability_assessments';
const FINDINGS_TABLE = 'supply_chain_vulnerability_findings';
const FAILURES_TABLE = 'supply_chain_assessment_failures';

const DDL = [
  `CREATE TABLE IF NOT EXISTS ${WORKSPACES_TABLE} (
    workspaceId String,
    repositoryId String,
    scannerId String,
    workspacePathFingerprint String,
    displayName String,
    sourceId String,
    environmentId String,
    registeredAt UInt64,
    updatedAt UInt64,
    recordVersion UInt64,
    schemaVersion LowCardinality(String),
    ts DateTime MATERIALIZED toDateTime(intDiv(updatedAt, 1000))
  ) ENGINE = ReplacingMergeTree(recordVersion)
  ORDER BY workspaceId`,
  `CREATE TABLE IF NOT EXISTS ${SNAPSHOTS_TABLE} (
    dependencySnapshotId String,
    componentSetDigest String,
    repositoryId String,
    workspaceId String,
    scannerId String,
    extractionPolicyVersion String,
    scannerName String,
    scannerVersion String,
    snapshotExtractionStatus LowCardinality(String),
    descriptorDigest String,
    components String,
    observedChangeAt UInt64,
    confirmedAt UInt64,
    warnings String,
    error String,
    schemaVersion LowCardinality(String),
    ts DateTime MATERIALIZED toDateTime(intDiv(confirmedAt, 1000))
  ) ENGINE = ReplacingMergeTree(confirmedAt)
  ORDER BY dependencySnapshotId`,
  `CREATE TABLE IF NOT EXISTS ${BINDINGS_TABLE} (
    workspaceId String,
    dependencySnapshotId String,
    state LowCardinality(String),
    validFrom UInt64,
    validTo UInt64,
    observedAt UInt64,
    recordVersion UInt64,
    schemaVersion LowCardinality(String),
    ts DateTime MATERIALIZED toDateTime(intDiv(recordVersion, 1000))
  ) ENGINE = ReplacingMergeTree(recordVersion)
  ORDER BY (workspaceId, dependencySnapshotId)`,
  `CREATE TABLE IF NOT EXISTS ${ASSESSMENTS_TABLE} (
    vulnerabilityAssessmentId String,
    dependencySnapshotId String,
    workspaceId String,
    assessedAt UInt64,
    assessmentStatus LowCardinality(String),
    intelligenceMode LowCardinality(String),
    intelligenceRevision String,
    queryCoverageDigest String,
    findingSetDigest String,
    plannedComponentCount UInt32,
    successfulComponentCount UInt32,
    failedComponentCount UInt32,
    failedComponentDigest String,
    schemaVersion LowCardinality(String),
    ts DateTime MATERIALIZED toDateTime(intDiv(assessedAt, 1000))
  ) ENGINE = ReplacingMergeTree(assessedAt)
  ORDER BY vulnerabilityAssessmentId`,
  `CREATE TABLE IF NOT EXISTS ${FINDINGS_TABLE} (
    findingId String,
    workspaceId String,
    dependencySnapshotId String,
    vulnerabilityAssessmentId String,
    component String,
    vulnerability String,
    status LowCardinality(String),
    closureReason LowCardinality(String),
    firstObservedAt UInt64,
    lastObservedAt UInt64,
    priority LowCardinality(String),
    priorityScore UInt8,
    deploymentStatus LowCardinality(String),
    shadow UInt8,
    recordVersion UInt64,
    ts DateTime MATERIALIZED toDateTime(intDiv(lastObservedAt, 1000))
  ) ENGINE = ReplacingMergeTree(recordVersion)
  ORDER BY findingId`,
  `CREATE TABLE IF NOT EXISTS ${FAILURES_TABLE} (
    vulnerabilityAssessmentId String,
    workspaceId String,
    dependencySnapshotId String,
    component String,
    error String,
    failedAt UInt64,
    failureId String,
    ts DateTime MATERIALIZED toDateTime(intDiv(failedAt, 1000))
  ) ENGINE = MergeTree
  ORDER BY (vulnerabilityAssessmentId, failureId)`,
];

const ALTER_DDL = [
  `ALTER TABLE ${WORKSPACES_TABLE} ADD COLUMN IF NOT EXISTS workspacePathFingerprint String AFTER scannerId`,
  `ALTER TABLE ${FINDINGS_TABLE} ADD COLUMN IF NOT EXISTS priority LowCardinality(String) DEFAULT 'P3' AFTER lastObservedAt`,
  `ALTER TABLE ${FINDINGS_TABLE} ADD COLUMN IF NOT EXISTS priorityScore UInt8 DEFAULT 0 AFTER priority`,
  `ALTER TABLE ${FINDINGS_TABLE} ADD COLUMN IF NOT EXISTS deploymentStatus LowCardinality(String) DEFAULT 'unknown' AFTER priorityScore`,
];

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

function findingFromRow(row: Record<string, unknown>): VulnerabilityFinding {
  const component = parseJson<VulnerabilityFinding['component']>(row.component, {
    relativeSourcePath: 'unknown',
    ecosystem: 'unknown',
    packageName: 'unknown',
    version: 'unknown',
    dependencyScope: 'unknown',
    direct: null,
  });
  const vulnerability = parseJson<VulnerabilityFinding['vulnerability']>(row.vulnerability, {
    id: 'unknown',
    modified: '',
    aliases: [],
  });
  const deploymentStatus = component.deploymentImages?.length ? 'confirmed' : 'unknown';
  const fallbackScore = Math.min(100, {
    critical: 80,
    high: 60,
    medium: 40,
    low: 20,
    unknown: 10,
  }[vulnerability.severityLevel ?? 'unknown']
    + (deploymentStatus === 'confirmed' ? 15 : 0)
    + (component.direct === true ? 5 : 0)
    + (component.dependencyScope === 'runtime' ? 5 : 0));
  const priorityScore = num(row.priorityScore) || fallbackScore;
  return {
    findingId: String(row.findingId ?? ''),
    workspaceId: String(row.workspaceId ?? ''),
    dependencySnapshotId: String(row.dependencySnapshotId ?? ''),
    vulnerabilityAssessmentId: String(row.vulnerabilityAssessmentId ?? ''),
    component,
    vulnerability,
    status: String(row.status ?? 'open') as VulnerabilityFinding['status'],
    closureReason: (String(row.closureReason ?? '') || undefined) as VulnerabilityFinding['closureReason'],
    firstObservedAt: num(row.firstObservedAt),
    lastObservedAt: num(row.lastObservedAt),
    priority: (String(row.priority || '') || (
      priorityScore >= 90 ? 'P0' : priorityScore >= 60 ? 'P1' : priorityScore >= 35 ? 'P2' : 'P3'
    )) as VulnerabilityFinding['priority'],
    priorityScore,
    deploymentStatus: (String(row.deploymentStatus || '') || deploymentStatus) as VulnerabilityFinding['deploymentStatus'],
    shadow: true,
  };
}

export class SupplyChainStore {
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
      for (const query of DDL) await this.client.command({ query });
      for (const query of ALTER_DDL) await this.client.command({ query });
      this.ready = true;
      return true;
    } catch (error) {
      console.error('[supply-chain] store init failed', error instanceof Error ? error.message : String(error));
      await this.client?.close();
      this.client = undefined;
      return false;
    }
  }

  private requireClient(): ClickHouseClient {
    if (!this.client || !this.ready) throw new Error('supply-chain store is unavailable');
    return this.client;
  }

  async upsertWorkspace(workspace: WorkspaceRegistration): Promise<void> {
    await this.requireClient().insert({
      table: WORKSPACES_TABLE,
      values: [{
        ...workspace,
        sourceId: workspace.sourceId ?? '',
        environmentId: workspace.environmentId ?? '',
        recordVersion: workspace.updatedAt,
      }],
      format: 'JSONEachRow',
    });
  }

  async workspace(workspaceId: string): Promise<WorkspaceRegistration | undefined> {
    const result = await this.requireClient().query({
      query: `SELECT * FROM ${WORKSPACES_TABLE} FINAL WHERE workspaceId = {workspaceId:String} LIMIT 1`,
      query_params: { workspaceId },
      format: 'JSONEachRow',
    });
    const [row] = await result.json() as Array<Record<string, unknown>>;
    if (!row) return undefined;
    return {
      schemaVersion: 'anysentry.workspace_registration.v1',
      repositoryId: String(row.repositoryId),
      workspaceId: String(row.workspaceId),
      scannerId: String(row.scannerId),
      workspacePathFingerprint: String(row.workspacePathFingerprint),
      displayName: String(row.displayName),
      sourceId: String(row.sourceId || '') || undefined,
      environmentId: String(row.environmentId || '') || undefined,
      registeredAt: num(row.registeredAt),
      updatedAt: num(row.updatedAt),
    };
  }

  async workspaceByPathFingerprint(workspacePathFingerprint: string): Promise<WorkspaceRegistration | undefined> {
    const result = await this.requireClient().query({
      query: `SELECT workspaceId FROM ${WORKSPACES_TABLE} FINAL
        WHERE workspacePathFingerprint = {workspacePathFingerprint:String}
        ORDER BY updatedAt DESC LIMIT 1`,
      query_params: { workspacePathFingerprint },
      format: 'JSONEachRow',
    });
    const [row] = await result.json() as Array<Record<string, unknown>>;
    return row ? this.workspace(String(row.workspaceId)) : undefined;
  }

  async insertSnapshot(snapshot: DependencySnapshot): Promise<void> {
    await this.requireClient().insert({
      table: SNAPSHOTS_TABLE,
      values: [{
        ...snapshot,
        descriptorDigest: snapshot.descriptorDigest ?? '',
        components: JSON.stringify(snapshot.components),
        warnings: JSON.stringify(snapshot.warnings),
        error: snapshot.error ?? '',
      }],
      format: 'JSONEachRow',
    });
  }

  async snapshot(dependencySnapshotId: string): Promise<DependencySnapshot | undefined> {
    const result = await this.requireClient().query({
      query: `SELECT * FROM ${SNAPSHOTS_TABLE} FINAL
        WHERE dependencySnapshotId = {dependencySnapshotId:String} LIMIT 1`,
      query_params: { dependencySnapshotId },
      format: 'JSONEachRow',
    });
    const [row] = await result.json() as Array<Record<string, unknown>>;
    if (!row) return undefined;
    return {
      schemaVersion: 'anysentry.dependency_snapshot.v1',
      dependencySnapshotId: String(row.dependencySnapshotId),
      componentSetDigest: String(row.componentSetDigest),
      repositoryId: String(row.repositoryId),
      workspaceId: String(row.workspaceId),
      scannerId: String(row.scannerId),
      extractionPolicyVersion: String(row.extractionPolicyVersion),
      scannerName: String(row.scannerName),
      scannerVersion: String(row.scannerVersion),
      snapshotExtractionStatus: String(row.snapshotExtractionStatus) as DependencySnapshot['snapshotExtractionStatus'],
      descriptorDigest: String(row.descriptorDigest || '') || undefined,
      components: parseJson(row.components, []),
      observedChangeAt: num(row.observedChangeAt),
      confirmedAt: num(row.confirmedAt),
      warnings: parseJson(row.warnings, []),
      error: String(row.error || '') || undefined,
    };
  }

  async activeBinding(workspaceId: string): Promise<WorkspaceSnapshotBinding | undefined> {
    const result = await this.requireClient().query({
      query: `SELECT * FROM ${BINDINGS_TABLE} FINAL
        WHERE workspaceId = {workspaceId:String} AND state IN ('active', 'snapshot_pending')
        ORDER BY recordVersion DESC LIMIT 1`,
      query_params: { workspaceId },
      format: 'JSONEachRow',
    });
    const [row] = await result.json() as Array<Record<string, unknown>>;
    if (!row) return undefined;
    return {
      schemaVersion: 'anysentry.workspace_snapshot_binding.v1',
      workspaceId: String(row.workspaceId),
      dependencySnapshotId: String(row.dependencySnapshotId),
      state: String(row.state) as WorkspaceSnapshotBinding['state'],
      validFrom: num(row.validFrom),
      validTo: num(row.validTo) || undefined,
      observedAt: num(row.observedAt),
    };
  }

  async activateSnapshot(snapshot: DependencySnapshot): Promise<void> {
    const client = this.requireClient();
    const current = await this.activeBinding(snapshot.workspaceId);
    const now = snapshot.confirmedAt;
    const rows: Array<Record<string, unknown>> = [];
    if (current && current.dependencySnapshotId !== snapshot.dependencySnapshotId) {
      rows.push({
        ...current,
        state: 'historical',
        validTo: now,
        recordVersion: now,
      });
    }
    rows.push({
      schemaVersion: 'anysentry.workspace_snapshot_binding.v1',
      workspaceId: snapshot.workspaceId,
      dependencySnapshotId: snapshot.dependencySnapshotId,
      state: 'active',
      validFrom: current?.dependencySnapshotId === snapshot.dependencySnapshotId
        ? current.validFrom
        : snapshot.observedChangeAt,
      validTo: 0,
      observedAt: snapshot.confirmedAt,
      recordVersion: now,
    });
    await client.insert({ table: BINDINGS_TABLE, values: rows, format: 'JSONEachRow' });
  }

  async markSnapshotPending(workspaceId: string, observedAt: number): Promise<void> {
    const current = await this.activeBinding(workspaceId);
    if (!current) return;
    await this.requireClient().insert({
      table: BINDINGS_TABLE,
      values: [{
        ...current,
        state: 'snapshot_pending',
        validTo: 0,
        observedAt,
        recordVersion: observedAt,
      }],
      format: 'JSONEachRow',
    });
  }

  async activeSnapshots(): Promise<DependencySnapshot[]> {
    const result = await this.requireClient().query({
      query: `SELECT s.* FROM (
          SELECT * FROM ${SNAPSHOTS_TABLE} FINAL
        ) AS s
        INNER JOIN (
          SELECT workspaceId, dependencySnapshotId FROM ${BINDINGS_TABLE} FINAL WHERE state = 'active'
        ) AS b ON s.workspaceId = b.workspaceId AND s.dependencySnapshotId = b.dependencySnapshotId`,
      format: 'JSONEachRow',
    });
    const rows = await result.json() as Array<Record<string, unknown>>;
    return Promise.all(rows.map((row) => this.snapshot(String(row.dependencySnapshotId))))
      .then((snapshots) => snapshots.filter((snapshot): snapshot is DependencySnapshot => Boolean(snapshot)));
  }

  async latestAssessmentAt(dependencySnapshotId: string): Promise<number | undefined> {
    const result = await this.requireClient().query({
      query: `SELECT max(assessedAt) AS assessedAt FROM ${ASSESSMENTS_TABLE}
        WHERE dependencySnapshotId = {dependencySnapshotId:String}`,
      query_params: { dependencySnapshotId },
      format: 'JSONEachRow',
    });
    const [row] = await result.json() as Array<Record<string, unknown>>;
    return num(row?.assessedAt) || undefined;
  }

  async currentFindings(workspaceId: string): Promise<VulnerabilityFinding[]> {
    const result = await this.requireClient().query({
      query: `SELECT * FROM ${FINDINGS_TABLE} FINAL WHERE workspaceId = {workspaceId:String}`,
      query_params: { workspaceId },
      format: 'JSONEachRow',
    });
    return (await result.json() as Array<Record<string, unknown>>).map(findingFromRow);
  }

  async insertAssessment(assessment: VulnerabilityAssessment): Promise<void> {
    const client = this.requireClient();
    await client.insert({
      table: ASSESSMENTS_TABLE,
      values: [{
        ...assessment,
        findings: undefined,
        failures: undefined,
      }],
      format: 'JSONEachRow',
    });
    if (assessment.failures.length > 0) {
      await client.insert({
        table: FAILURES_TABLE,
        values: assessment.failures.map((failure, index) => ({
          vulnerabilityAssessmentId: assessment.vulnerabilityAssessmentId,
          workspaceId: assessment.workspaceId,
          dependencySnapshotId: assessment.dependencySnapshotId,
          component: JSON.stringify(failure.component),
          error: failure.error.slice(0, 1_000),
          failedAt: assessment.assessedAt,
          failureId: `${assessment.vulnerabilityAssessmentId}-${index}`,
        })),
        format: 'JSONEachRow',
      });
    }
    await this.reconcileFindings(assessment);
  }

  private async reconcileFindings(assessment: VulnerabilityAssessment): Promise<void> {
    const previous = await this.currentFindings(assessment.workspaceId);
    const previousById = new Map(previous.map((finding) => [finding.findingId, finding]));
    const current = assessment.findings.map((finding) => ({
      ...finding,
      firstObservedAt: previousById.get(finding.findingId)?.firstObservedAt ?? finding.firstObservedAt,
    }));
    const nextById = new Map(current.map((finding) => [finding.findingId, finding]));
    const rows: VulnerabilityFinding[] = [...current];
    if (assessment.assessmentStatus === 'complete') {
      const snapshot = await this.snapshot(assessment.dependencySnapshotId);
      const components = snapshot?.components ?? [];
      for (const old of previous) {
        if (nextById.has(old.findingId) || old.status === 'closed') continue;
        const samePackage = components.filter((component) =>
          component.ecosystem === old.component.ecosystem
          && component.packageName === old.component.packageName);
        const sameVersion = samePackage.some((component) => component.version === old.component.version);
        rows.push({
          ...old,
          vulnerabilityAssessmentId: assessment.vulnerabilityAssessmentId,
          dependencySnapshotId: assessment.dependencySnapshotId,
          status: 'closed',
          closureReason: sameVersion
            ? 'no_longer_affected'
            : samePackage.length > 0 ? 'version_changed' : 'dependency_removed',
          lastObservedAt: assessment.assessedAt,
        });
      }
    } else {
      for (const old of previous) {
        if (nextById.has(old.findingId) || old.status === 'closed') continue;
        rows.push({
          ...old,
          vulnerabilityAssessmentId: assessment.vulnerabilityAssessmentId,
          status: 'assessment_stale',
          closureReason: undefined,
          lastObservedAt: assessment.assessedAt,
        });
      }
    }
    if (rows.length === 0) return;
    await this.requireClient().insert({
      table: FINDINGS_TABLE,
      values: rows.map((finding) => ({
        ...finding,
        component: JSON.stringify(finding.component),
        vulnerability: JSON.stringify(finding.vulnerability),
        closureReason: finding.closureReason ?? '',
        shadow: 1,
        recordVersion: assessment.assessedAt,
      })),
      format: 'JSONEachRow',
    });
  }

  async overview(limit = 100): Promise<SupplyChainOverview> {
    if (!this.ready) {
      return {
        enabled: false,
        runtimeCorrelationEnabled: false,
        workspaces: 0,
        activeSnapshots: 0,
        openFindings: 0,
        staleFindings: 0,
        findings: [],
      };
    }
    const safeLimit = Math.max(1, Math.min(500, limit));
    const [workspaceResult, bindingResult, assessmentResult, findingCountResult, findingResult] = await Promise.all([
      this.requireClient().query({
        query: `SELECT count() AS count FROM ${WORKSPACES_TABLE} FINAL`,
        format: 'JSONEachRow',
      }),
      this.requireClient().query({
        query: `SELECT count() AS count FROM ${BINDINGS_TABLE} FINAL WHERE state = 'active'`,
        format: 'JSONEachRow',
      }),
      this.requireClient().query({
        query: `SELECT max(assessedAt) AS assessedAt FROM ${ASSESSMENTS_TABLE}`,
        format: 'JSONEachRow',
      }),
      this.requireClient().query({
        query: `SELECT
          countIf(status = 'open') AS openFindings,
          countIf(status = 'assessment_stale') AS staleFindings
          FROM ${FINDINGS_TABLE} FINAL`,
        format: 'JSONEachRow',
      }),
      this.requireClient().query({
        query: `SELECT * FROM ${FINDINGS_TABLE} FINAL
          WHERE status IN ('open', 'assessment_stale')
          ORDER BY priorityScore DESC, lastObservedAt DESC LIMIT {limit:UInt32}`,
        query_params: { limit: safeLimit },
        format: 'JSONEachRow',
      }),
    ]);
    const workspaceRows = await workspaceResult.json() as Array<Record<string, unknown>>;
    const bindingRows = await bindingResult.json() as Array<Record<string, unknown>>;
    const assessmentRows = await assessmentResult.json() as Array<Record<string, unknown>>;
    const findingCountRows = await findingCountResult.json() as Array<Record<string, unknown>>;
    const findings = (await findingResult.json() as Array<Record<string, unknown>>)
      .map(findingFromRow)
      .map((finding) => ({
        ...finding,
        vulnerability: {
          ...finding.vulnerability,
          impactDescription: finding.vulnerability.impactDescription
            ?? (String(finding.vulnerability.summary || finding.vulnerability.details || '')
              .replace(/\s+/gu, ' ')
              .trim()
              .slice(0, 1_200)
            || undefined),
          details: undefined,
          databaseSpecific: undefined,
        },
      }));
    return {
      enabled: true,
      runtimeCorrelationEnabled: false,
      workspaces: num(workspaceRows[0]?.count),
      activeSnapshots: num(bindingRows[0]?.count),
      openFindings: num(findingCountRows[0]?.openFindings),
      staleFindings: num(findingCountRows[0]?.staleFindings),
      latestAssessmentAt: num(assessmentRows[0]?.assessedAt) || undefined,
      findings,
    };
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = undefined;
    this.ready = false;
  }
}
