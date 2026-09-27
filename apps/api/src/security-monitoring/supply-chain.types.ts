export const SUPPLY_CHAIN_ASSESSMENT_QUEUE = 'anysentry-supply-chain-assessments';
export const SUPPLY_CHAIN_ASSESSMENT_WORKER_HEARTBEAT_KEY =
  'anysentry:supply-chain:assessment-worker:heartbeat';
export const SUPPLY_CHAIN_SCANNER_HEARTBEAT_PREFIX =
  'anysentry:supply-chain:scanner-heartbeat:';

export type SupplyChainStatus = 'complete' | 'partial' | 'failed';
export type WorkspaceSnapshotState = 'active' | 'snapshot_pending' | 'stale' | 'historical';
export type DependencyScope = 'runtime' | 'development' | 'optional' | 'build' | 'unknown';
export type VulnerabilitySeverity = 'critical' | 'high' | 'medium' | 'low' | 'unknown';
export type VulnerabilityPriority = 'P0' | 'P1' | 'P2' | 'P3';
export type DeploymentStatus = 'confirmed' | 'unknown';
export type VulnerabilityPriorityFactorCode =
  | 'severity'
  | 'deployed'
  | 'direct_dependency'
  | 'runtime_scope';
export type VulnerabilityRemediationAction =
  | 'upgrade_direct_dependency'
  | 'upgrade_parent_dependency'
  | 'upgrade_component'
  | 'update_deployed_artifact'
  | 'monitor_advisory';

export interface VulnerabilityPriorityFactor {
  code: VulnerabilityPriorityFactorCode;
  score: number;
  reason: string;
}

export interface VulnerabilityRemediation {
  action: VulnerabilityRemediationAction;
  summary: string;
  candidateFixedVersion?: string;
  requiresArtifactRebuild: boolean;
}

export interface DeploymentImageEvidence {
  reference: string;
  digest: string;
  componentSource: 'osv_image' | 'production_manifest';
}

export interface InstalledEnvironmentEvidence {
  kind: 'node_modules' | 'python_environment';
  relativePath: string;
}

export interface WorkspaceRegistration {
  schemaVersion: 'anysentry.workspace_registration.v1';
  repositoryId: string;
  workspaceId: string;
  scannerId: string;
  workspacePathFingerprint: string;
  displayName: string;
  sourceId?: string;
  environmentId?: string;
  registeredAt: number;
  updatedAt: number;
}

export interface RegisterWorkspaceRequest {
  repositoryId: string;
  workspaceId: string;
  scannerId: string;
  workspacePathFingerprint: string;
  displayName?: string;
  sourceId?: string;
  environmentId?: string;
}

export type ScanReason = 'initial' | 'dependency_descriptor_changed' | 'runtime_install' | 'manual' | 'retry';

export interface WorkspaceScanTask {
  schemaVersion: 'anysentry.workspace_scan_task.v1';
  taskId: string;
  workspaceId: string;
  scannerId: string;
  reason: ScanReason;
  status: 'pending' | 'leased' | 'completed' | 'failed';
  createdAt: number;
  updatedAt: number;
  leaseOwner?: string;
  leaseToken?: string;
  leaseExpiresAt?: number;
  attempt: number;
  resultDependencySnapshotId?: string;
  assessmentQueued?: boolean;
}

export interface ClaimScanTaskRequest {
  scannerId: string;
}

export interface ScanTaskHeartbeatRequest {
  scannerId: string;
  leaseToken: string;
}

export interface DependencyComponent {
  relativeSourcePath: string;
  ecosystem: string;
  packageName: string;
  version: string;
  dependencyScope: DependencyScope;
  direct: boolean | null;
  purl?: string;
  deploymentImages?: DeploymentImageEvidence[];
  installedEnvironments?: InstalledEnvironmentEvidence[];
}

export interface SubmitScanResultRequest {
  scannerId: string;
  leaseToken: string;
  extractionStatus: SupplyChainStatus;
  extractionPolicyVersion: string;
  scannerName: string;
  scannerVersion: string;
  descriptorDigest?: string;
  observedChangeAt?: number;
  components: DependencyComponent[];
  warnings?: string[];
  error?: string;
}

export interface DependencySnapshot {
  schemaVersion: 'anysentry.dependency_snapshot.v1';
  dependencySnapshotId: string;
  componentSetDigest: string;
  repositoryId: string;
  workspaceId: string;
  scannerId: string;
  extractionPolicyVersion: string;
  scannerName: string;
  scannerVersion: string;
  snapshotExtractionStatus: SupplyChainStatus;
  descriptorDigest?: string;
  components: DependencyComponent[];
  observedChangeAt: number;
  confirmedAt: number;
  warnings: string[];
  error?: string;
}

export interface WorkspaceSnapshotBinding {
  schemaVersion: 'anysentry.workspace_snapshot_binding.v1';
  workspaceId: string;
  dependencySnapshotId: string;
  state: WorkspaceSnapshotState;
  validFrom: number;
  validTo?: number;
  observedAt: number;
}

export interface OsvVulnerabilitySummary {
  id: string;
  canonicalId?: string;
  modified: string;
  published?: string;
  withdrawn?: string;
  aliases: string[];
  summary?: string;
  details?: string;
  databaseSpecific?: Record<string, unknown>;
  severity?: Array<{
    type: string;
    score: string;
    source?: string;
  }>;
  severityLevel?: VulnerabilitySeverity;
  cvssScore?: number;
  cvssVector?: string;
  vendorSeverity?: VulnerabilitySeverity;
  vendorSeveritySource?: string;
  impactDescription?: string;
  fixedVersions?: string[];
}

export interface VulnerabilityFinding {
  findingId: string;
  workspaceId: string;
  dependencySnapshotId: string;
  vulnerabilityAssessmentId: string;
  component: DependencyComponent;
  vulnerability: OsvVulnerabilitySummary;
  status: 'open' | 'closed' | 'assessment_stale';
  closureReason?: 'dependency_removed' | 'version_changed' | 'no_longer_affected' | 'advisory_withdrawn';
  firstObservedAt: number;
  lastObservedAt: number;
  priority: VulnerabilityPriority;
  priorityScore: number;
  priorityFactors: VulnerabilityPriorityFactor[];
  deploymentStatus: DeploymentStatus;
  remediation: VulnerabilityRemediation;
  shadow: true;
}

export interface AssessmentFailure {
  component: DependencyComponent;
  error: string;
}

export interface VulnerabilityAssessment {
  schemaVersion: 'anysentry.vulnerability_assessment.v1';
  vulnerabilityAssessmentId: string;
  dependencySnapshotId: string;
  workspaceId: string;
  assessedAt: number;
  assessmentStatus: SupplyChainStatus;
  intelligenceMode: 'online' | 'offline';
  intelligenceRevision: string;
  queryCoverageDigest: string;
  findingSetDigest: string;
  plannedComponentCount: number;
  successfulComponentCount: number;
  failedComponentCount: number;
  failedComponentDigest: string;
  findings: VulnerabilityFinding[];
  failures: AssessmentFailure[];
}

export interface SupplyChainAssessmentJob {
  schemaVersion: 'anysentry.supply_chain_assessment_job.v1';
  jobId: string;
  workspaceId: string;
  dependencySnapshotId: string;
  reason: 'snapshot_confirmed' | 'intelligence_refresh' | 'retry' | 'manual';
  queuedAt: number;
}

export interface SupplyChainControlConfig {
  schemaVersion: 'anysentry.supply_chain_control.v1';
  enabled: boolean;
  dailyRefreshEnabled: boolean;
  runtimeCorrelationEnabled: boolean;
  selectedWorkspaceIds: string[];
  updatedAt: number;
}

export interface SupplyChainRuntimeReadiness {
  serviceReady: boolean;
  scannerAuthConfigured: boolean;
  assessmentWorkerOnline: boolean;
  runtimeCorrelationAvailable: boolean;
  readyForInitialScan: boolean;
  scanners: Array<{
    scannerId: string;
    online: boolean;
    lastSeenAt?: number;
    workspaceIds: string[];
  }>;
  issues: string[];
}

export interface SupplyChainControlResponse {
  config: SupplyChainControlConfig;
  readiness: SupplyChainRuntimeReadiness;
  workspaceOptions: Array<Pick<
    WorkspaceRegistration,
    'workspaceId' | 'repositoryId' | 'displayName' | 'sourceId' | 'environmentId'
  > & { scannerId: string }>;
  scanTasks?: WorkspaceScanTask[];
  runtimeAssessmentsQueued?: number;
}

export interface SupplyChainOverview {
  enabled: boolean;
  runtimeCorrelationEnabled: boolean;
  workspaces: number;
  workspaceOptions: Array<Pick<
    WorkspaceRegistration,
    'workspaceId' | 'repositoryId' | 'displayName' | 'sourceId' | 'environmentId'
  >>;
  activeSnapshots: number;
  openFindings: number;
  staleFindings: number;
  latestAssessmentAt?: number;
  findings: VulnerabilityFinding[];
}

export interface SupplyChainRuntimeVulnerability {
  findingId: string;
  ecosystem: string;
  packageName: string;
  version: string;
  dependencyScope: DependencyScope;
  direct: boolean | null;
  purl?: string;
  vulnerabilityId: string;
  aliases: string[];
  summary?: string;
}

export interface SupplyChainRuntimeContext {
  schemaVersion: 'anysentry.supply_chain_runtime_context.v1';
  workspaceId: string;
  workspacePathFingerprint: string;
  dependencySnapshotId: string;
  vulnerabilityAssessmentId: string;
  assessedAt: number;
  assessmentStatus: SupplyChainStatus;
  intelligenceRevision: string;
  findings: SupplyChainRuntimeVulnerability[];
  shadow: true;
}
