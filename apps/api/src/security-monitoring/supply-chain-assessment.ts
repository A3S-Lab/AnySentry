import { randomUUID } from 'node:crypto';
import {
  failedComponentDigest,
  findingId,
  findingSetDigest,
  intelligenceRevision,
  queryCoverageDigest,
  vulnerabilityAssessmentId,
} from './supply-chain-normalizer';
import {
  AssessmentFailure,
  DependencyComponent,
  DependencySnapshot,
  OsvVulnerabilitySummary,
  VulnerabilityAssessment,
  VulnerabilityFinding,
} from './supply-chain.types';

type OsvBatchResult = {
  results?: Array<{
    vulns?: Array<{
      id?: string;
      modified?: string;
    }>;
  }>;
};

type OsvDetail = {
  id?: string;
  modified?: string;
  published?: string;
  withdrawn?: string;
  aliases?: string[];
  summary?: string;
  details?: string;
  database_specific?: Record<string, unknown>;
  severity?: Array<{
    type?: string;
    score?: string;
  }>;
  affected?: Array<{
    package?: {
      ecosystem?: string;
      name?: string;
    };
    severity?: Array<{
      type?: string;
      score?: string;
    }>;
    ranges?: Array<{
      events?: Array<{
        fixed?: string;
      }>;
    }>;
  }>;
};

type OsvAffected = NonNullable<OsvDetail['affected']>[number];
type OsvResolvedDetail = OsvVulnerabilitySummary & { affected?: OsvAffected[] };

const DEFAULT_OSV_API = 'https://api.osv.dev';
const QUERY_CHUNK_SIZE = 100;

function errorSummary(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split('\n')[0].slice(0, 500);
}

async function postBatch(
  components: DependencyComponent[],
  apiBase: string,
  timeoutMs: number,
): Promise<OsvBatchResult> {
  const response = await fetch(`${apiBase.replace(/\/$/, '')}/v1/querybatch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      queries: components.map((component) => ({
        package: {
          ecosystem: component.ecosystem,
          name: component.packageName,
        },
        version: component.version,
      })),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`OSV querybatch returned HTTP ${response.status}`);
  return await response.json() as OsvBatchResult;
}

async function getDetail(
  vulnerabilityId: string,
  fallbackModified: string,
  apiBase: string,
  timeoutMs: number,
): Promise<OsvResolvedDetail> {
  try {
    const response = await fetch(
      `${apiBase.replace(/\/$/, '')}/v1/vulns/${encodeURIComponent(vulnerabilityId)}`,
      { signal: AbortSignal.timeout(timeoutMs) },
    );
    if (!response.ok) throw new Error(`OSV detail returned HTTP ${response.status}`);
    const detail = await response.json() as OsvDetail;
    return {
      id: String(detail.id || vulnerabilityId),
      modified: String(detail.modified || fallbackModified || ''),
      published: detail.published ? String(detail.published) : undefined,
      withdrawn: detail.withdrawn ? String(detail.withdrawn) : undefined,
      aliases: Array.isArray(detail.aliases)
        ? detail.aliases.map(String).filter(Boolean).sort()
        : [],
      summary: detail.summary ? String(detail.summary).slice(0, 2_000) : undefined,
      details: detail.details ? String(detail.details).slice(0, 8_000) : undefined,
      databaseSpecific: detail.database_specific,
      severity: normalizeSeverity(detail.severity),
      affected: Array.isArray(detail.affected) ? detail.affected : undefined,
    };
  } catch {
    return {
      id: vulnerabilityId,
      modified: fallbackModified,
      aliases: [],
    };
  }
}

function normalizeSeverity(value: OsvDetail['severity']): OsvVulnerabilitySummary['severity'] {
  if (!Array.isArray(value)) return undefined;
  const normalized = value
    .map((entry) => ({
      type: String(entry?.type || '').trim(),
      score: String(entry?.score || '').trim(),
    }))
    .filter((entry) => entry.type && entry.score);
  return normalized.length > 0 ? normalized : undefined;
}

function roundUpCvss(value: number): number {
  return Math.ceil((value - Number.EPSILON) * 10) / 10;
}

function cvssV3Score(vector: string): number | undefined {
  if (!/^CVSS:3\.[01]\//u.test(vector)) return undefined;
  const metrics = Object.fromEntries(vector.split('/').slice(1).map((part) => part.split(':')));
  const av = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 }[metrics.AV];
  const ac = { L: 0.77, H: 0.44 }[metrics.AC];
  const ui = { N: 0.85, R: 0.62 }[metrics.UI];
  const scopeChanged = metrics.S === 'C';
  const pr = scopeChanged
    ? { N: 0.85, L: 0.68, H: 0.5 }[metrics.PR]
    : { N: 0.85, L: 0.62, H: 0.27 }[metrics.PR];
  const impactMetric = (value: string | undefined): number | undefined => (
    { N: 0, L: 0.22, H: 0.56 }[value as 'N' | 'L' | 'H']
  );
  const confidentiality = impactMetric(metrics.C);
  const integrity = impactMetric(metrics.I);
  const availability = impactMetric(metrics.A);
  if ([av, ac, ui, pr, confidentiality, integrity, availability].some((value) => value === undefined)) {
    return undefined;
  }
  const iss = 1 - ((1 - confidentiality!) * (1 - integrity!) * (1 - availability!));
  const impact = scopeChanged
    ? 7.52 * (iss - 0.029) - 3.25 * ((iss - 0.02) ** 15)
    : 6.42 * iss;
  if (impact <= 0) return 0;
  const exploitability = 8.22 * av! * ac! * pr! * ui!;
  return Math.min(10, roundUpCvss(scopeChanged
    ? 1.08 * (impact + exploitability)
    : impact + exploitability));
}

function severityLevel(
  vulnerability: OsvResolvedDetail,
  vendorSeverity: OsvVulnerabilitySummary['vendorSeverity'],
  cvssScore: number | undefined,
): OsvVulnerabilitySummary['severityLevel'] {
  const databaseSeverity = String(vulnerability.databaseSpecific?.severity || '').toLowerCase();
  if (databaseSeverity === 'critical' || databaseSeverity === 'high'
    || databaseSeverity === 'medium' || databaseSeverity === 'low') {
    return databaseSeverity;
  }
  if (vendorSeverity && vendorSeverity !== 'unknown') return vendorSeverity;
  if (cvssScore === undefined) return 'unknown';
  if (cvssScore >= 9) return 'critical';
  if (cvssScore >= 7) return 'high';
  if (cvssScore >= 4) return 'medium';
  if (cvssScore > 0) return 'low';
  return 'unknown';
}

function vulnerabilityForComponent(
  vulnerability: OsvResolvedDetail,
  component: DependencyComponent,
): OsvVulnerabilitySummary {
  const affected = (vulnerability.affected ?? []).filter((entry) => (
    String(entry.package?.ecosystem || '').toLowerCase() === component.ecosystem.toLowerCase()
    && String(entry.package?.name || '') === component.packageName
  ));
  const severity = [
    ...(vulnerability.severity ?? []),
    ...affected.flatMap((entry) => normalizeSeverity(entry.severity) ?? []),
  ];
  const uniqueSeverity = [...new Map(severity.map((entry) => [
    `${entry.type}\u0000${entry.score}`,
    entry,
  ])).values()];
  const scoredVectors = uniqueSeverity
    .filter((entry) => entry.score.startsWith('CVSS:'))
    .map((entry) => ({ vector: entry.score, score: cvssV3Score(entry.score) }))
    .sort((left, right) => (right.score ?? -1) - (left.score ?? -1));
  const cvssVector = scoredVectors[0]?.vector;
  const cvssScore = scoredVectors[0]?.score;
  const vendorEntry = uniqueSeverity.find((entry) => (
    !entry.score.startsWith('CVSS:')
    && ['critical', 'high', 'medium', 'low'].includes(entry.score.toLowerCase())
  ));
  const vendorSeverity = vendorEntry?.score.toLowerCase() as OsvVulnerabilitySummary['vendorSeverity'];
  const fixedVersions = [...new Set(affected.flatMap((entry) => (
    entry.ranges ?? []
  )).flatMap((range) => (
    range.events ?? []
  )).map((event) => String(event.fixed || '').trim()).filter(Boolean))].sort();
  const { affected: _affected, ...summary } = vulnerability;
  return {
    ...summary,
    severity: uniqueSeverity.length > 0 ? uniqueSeverity : undefined,
    severityLevel: severityLevel(vulnerability, vendorSeverity, cvssScore),
    cvssScore,
    cvssVector,
    vendorSeverity,
    vendorSeveritySource: vendorEntry?.type,
    impactDescription: String(summary.summary || summary.details || '')
      .replace(/\s+/gu, ' ')
      .trim()
      .slice(0, 1_200) || undefined,
    fixedVersions: fixedVersions.length > 0 ? fixedVersions : undefined,
  };
}

function findingPriority(
  component: DependencyComponent,
  vulnerability: OsvVulnerabilitySummary,
): Pick<VulnerabilityFinding, 'priority' | 'priorityScore' | 'deploymentStatus'> {
  const deploymentStatus = component.deploymentImages?.length || component.installedEnvironments?.length
    ? 'confirmed'
    : 'unknown';
  const score = Math.min(100, {
    critical: 80,
    high: 60,
    medium: 40,
    low: 20,
    unknown: 10,
  }[vulnerability.severityLevel ?? 'unknown']
    + (deploymentStatus === 'confirmed' ? 15 : 0)
    + (component.direct === true ? 5 : 0)
    + (component.dependencyScope === 'runtime' ? 5 : 0));
  return {
    priorityScore: score,
    priority: score >= 90 ? 'P0' : score >= 60 ? 'P1' : score >= 35 ? 'P2' : 'P3',
    deploymentStatus,
  };
}

async function queryChunk(
  components: DependencyComponent[],
  apiBase: string,
  timeoutMs: number,
): Promise<{
  successful: DependencyComponent[];
  failures: AssessmentFailure[];
  matches: Array<{ component: DependencyComponent; vulnerabilities: Array<{ id: string; modified: string }> }>;
}> {
  try {
    const batch = await postBatch(components, apiBase, timeoutMs);
    if (!Array.isArray(batch.results) || batch.results.length !== components.length) {
      throw new Error('OSV querybatch returned an incomplete result set');
    }
    return {
      successful: components,
      failures: [],
      matches: components.map((component, index) => ({
        component,
        vulnerabilities: (batch.results?.[index]?.vulns ?? [])
          .filter((vulnerability) => vulnerability.id)
          .map((vulnerability) => ({
            id: String(vulnerability.id),
            modified: String(vulnerability.modified ?? ''),
          })),
      })),
    };
  } catch (batchError) {
    if (components.length === 1) {
      return {
        successful: [],
        failures: [{ component: components[0], error: errorSummary(batchError) }],
        matches: [],
      };
    }
    const individual = await Promise.all(components.map(async (component) => {
      try {
        const response = await postBatch([component], apiBase, timeoutMs);
        const result = response.results?.[0];
        if (!result) throw new Error('OSV querybatch returned no result');
        return {
          component,
          vulnerabilities: (result.vulns ?? [])
            .filter((vulnerability) => vulnerability.id)
            .map((vulnerability) => ({
              id: String(vulnerability.id),
              modified: String(vulnerability.modified ?? ''),
            })),
        };
      } catch (error) {
        return { component, error: errorSummary(error) };
      }
    }));
    return {
      successful: individual.filter((item) => !('error' in item)).map((item) => item.component),
      failures: individual
        .filter((item): item is { component: DependencyComponent; error: string } => 'error' in item)
        .map((item) => ({ component: item.component, error: item.error })),
      matches: individual
        .filter((item): item is {
          component: DependencyComponent;
          vulnerabilities: Array<{ id: string; modified: string }>;
        } => 'vulnerabilities' in item)
        .map((item) => ({ component: item.component, vulnerabilities: item.vulnerabilities })),
    };
  }
}

type ChunkQueryResult = Awaited<ReturnType<typeof queryChunk>>;

export async function assessDependencySnapshot(
  snapshot: DependencySnapshot,
  options: {
    apiBase?: string;
    timeoutMs?: number;
    assessedAt?: number;
    intelligenceMode?: 'online' | 'offline';
    intelligenceRevision?: string;
  } = {},
): Promise<VulnerabilityAssessment> {
  const apiBase = options.apiBase || process.env.ANYSENTRY_OSV_API_URL || DEFAULT_OSV_API;
  const timeoutMs = Math.max(
    1_000,
    options.timeoutMs ?? Number(process.env.ANYSENTRY_OSV_REQUEST_TIMEOUT_MS || 20_000),
  );
  const assessedAt = options.assessedAt ?? Date.now();
  const configuredMode = options.intelligenceMode
    ?? (process.env.ANYSENTRY_OSV_INTELLIGENCE_MODE === 'offline' ? 'offline' : 'online');
  const offlineRevision = options.intelligenceRevision
    ?? process.env.ANYSENTRY_OSV_DATA_REVISION;
  if (configuredMode === 'offline' && !offlineRevision?.trim()) {
    throw new Error('ANYSENTRY_OSV_DATA_REVISION is required in offline intelligence mode');
  }
  const chunks: DependencyComponent[][] = [];
  for (let index = 0; index < snapshot.components.length; index += QUERY_CHUNK_SIZE) {
    chunks.push(snapshot.components.slice(index, index + QUERY_CHUNK_SIZE));
  }
  const results: ChunkQueryResult[] = [];
  for (const chunk of chunks) results.push(await queryChunk(chunk, apiBase, timeoutMs));
  const successful = results.flatMap((result) => result.successful);
  const failures = results.flatMap((result) => result.failures);
  const matches = results.flatMap((result) => result.matches);
  const detailKeys = new Map<string, string>();
  for (const match of matches) {
    for (const vulnerability of match.vulnerabilities) {
      detailKeys.set(vulnerability.id, vulnerability.modified);
    }
  }
  const detailEntries: Array<readonly [string, OsvResolvedDetail]> = [];
  const detailKeysArray = [...detailKeys];
  for (let index = 0; index < detailKeysArray.length; index += 8) {
    detailEntries.push(...await Promise.all(
      detailKeysArray.slice(index, index + 8).map(async ([id, modified]) => [
        id,
        await getDetail(id, modified, apiBase, timeoutMs),
      ] as const),
    ));
  }
  const details = new Map(detailEntries);
  const advisoryParent = new Map<string, string>();
  const root = (id: string): string => {
    const parent = advisoryParent.get(id);
    if (!parent || parent === id) {
      advisoryParent.set(id, id);
      return id;
    }
    const resolved = root(parent);
    advisoryParent.set(id, resolved);
    return resolved;
  };
  const connect = (left: string, right: string): void => {
    const leftRoot = root(left);
    const rightRoot = root(right);
    if (leftRoot === rightRoot) return;
    const [first, second] = [leftRoot, rightRoot].sort();
    advisoryParent.set(second, first);
  };
  for (const vulnerability of details.values()) {
    root(vulnerability.id);
    for (const alias of vulnerability.aliases) connect(vulnerability.id, alias);
  }
  const assessmentId = vulnerabilityAssessmentId(
    snapshot.dependencySnapshotId,
    assessedAt,
    randomUUID(),
  );
  const priorFindings = new Map<string, VulnerabilityFinding>();
  const findings: VulnerabilityFinding[] = [];
  for (const match of matches) {
    for (const reference of match.vulnerabilities) {
      const resolved = details.get(reference.id) ?? {
        id: reference.id,
        modified: reference.modified,
        aliases: [],
        severityLevel: 'unknown' as const,
      };
      const vulnerability = vulnerabilityForComponent(resolved, match.component);
      const canonicalAdvisory = root(vulnerability.id);
      const id = findingId(snapshot.workspaceId, match.component, canonicalAdvisory);
      if (priorFindings.has(id)) continue;
      const finding: VulnerabilityFinding = {
        findingId: id,
        workspaceId: snapshot.workspaceId,
        dependencySnapshotId: snapshot.dependencySnapshotId,
        vulnerabilityAssessmentId: assessmentId,
        component: match.component,
        vulnerability,
        status: vulnerability.withdrawn ? 'closed' : 'open',
        closureReason: vulnerability.withdrawn ? 'advisory_withdrawn' : undefined,
        firstObservedAt: assessedAt,
        lastObservedAt: assessedAt,
        ...findingPriority(match.component, vulnerability),
        shadow: true,
      };
      priorFindings.set(id, finding);
      findings.push(finding);
    }
  }
  const status = failures.length === 0
    ? 'complete'
    : successful.length > 0 ? 'partial' : 'failed';
  const vulnerabilityValues = [...details.values()];
  return {
    schemaVersion: 'anysentry.vulnerability_assessment.v1',
    vulnerabilityAssessmentId: assessmentId,
    dependencySnapshotId: snapshot.dependencySnapshotId,
    workspaceId: snapshot.workspaceId,
    assessedAt,
    assessmentStatus: status,
    intelligenceMode: configuredMode,
    intelligenceRevision: configuredMode === 'offline'
      ? offlineRevision!.trim()
      : intelligenceRevision(vulnerabilityValues),
    queryCoverageDigest: queryCoverageDigest(
      snapshot.components,
      successful,
      failures.map((failure) => failure.component),
    ),
    findingSetDigest: findingSetDigest(findings),
    plannedComponentCount: snapshot.components.length,
    successfulComponentCount: successful.length,
    failedComponentCount: failures.length,
    failedComponentDigest: failedComponentDigest(failures.map((failure) => failure.component)),
    findings,
    failures,
  };
}
