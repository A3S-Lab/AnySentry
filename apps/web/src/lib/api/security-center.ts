import { apiClient, apiRawFetch } from "@/lib/api/client";

function querySuffix(params: object) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    const text = String(value ?? "").trim();
    if (text) qs.set(key, text);
  }
  return qs.toString() ? `?${qs.toString()}` : "";
}

export type SecurityTimeType =
  | "last_30m"
  | "last_1h"
  | "last_2h"
  | "last_3h"
  | "last_1d"
  | "last_7d"
  | "last_30d"
  | "custom";
export type SecurityRiskLevel = "safe" | "low" | "medium" | "high" | "critical" | "unknown" | string;
export type SecurityPolicyAction = "allow" | "review" | "block" | string;

export type AgentClassification = "confirmed_agent" | "probable_agent" | "unknown" | "non_agent";
export interface EventJudgmentMetadata {
  classification: AgentClassification;
  profile: "full" | "l1_only" | "discard";
  maxTier: "L1" | "L2" | "L3";
  reason: "confirmed_agent_full" | "candidate_agent_full" | "candidate_agent_l1_only" | "unknown_l1_only" | "non_agent_discarded";
  routingVersion: string;
  policyVersion?: string;
  l1Verdict?: SecurityVerdict;
  nextTierEligible?: boolean;
  stopReason?: string;
}
export type AgentReviewDecision = "confirmed_agent" | "unknown" | "non_agent";
export type AgentAttributionSource = "none" | "process_graph" | "cgroup" | "systemd" | "argv" | "env" | "self_register" | "workspace_hint" | "kubernetes" | "docker" | "behavior" | "process_signature" | "manual_review";
export type AgentAttributionReason = "not_evaluated" | "not_agent" | "process_lineage" | "authoritative_anchor" | "hint_only" | "conflict" | "human_confirmed" | "human_deferred" | "human_rejected";

export interface ProcessContext {
  hostId?: string;
  bootId?: string;
  pid?: number;
  ppid?: number;
  startTimeTicks?: string;
  startTimeNs?: string;
  eventTimeNs?: string;
  comm?: string;
  exe?: string;
  cwd?: string;
  uid?: number;
  cgroup?: string;
  cgroupId?: string;
  systemdUnit?: string;
}

export interface AgentWorkloadRef {
  environment?: "kubernetes" | "docker" | "host";
  kind?: "pod" | "container" | "service" | "process" | "cgroup";
  name?: string;
  namespace?: string;
  podName?: string;
  podUid?: string;
  nodeName?: string;
  containerName?: string;
  containerImage?: string;
  ownerKind?: string;
  ownerName?: string;
  systemdUnit?: string;
  processName?: string;
  executable?: string;
}

export interface AgentAttribution {
  monitored: boolean;
  classification?: AgentClassification;
  agentScopeId?: string;
  agentDisplayName?: string;
  agentSessionId?: string;
  agentInstanceId?: string;
  physicalWorkloadId?: string;
  workloadRef?: AgentWorkloadRef;
  rootPid?: number;
  rootStartTime?: string;
  confidence: number;
  reason: AgentAttributionReason;
  source: AgentAttributionSource;
  conflict?: boolean;
  degraded?: boolean;
  evidence?: string[];
}

export interface SecurityTimeFilter {
  timeType?: SecurityTimeType;
  startTime?: string;
  endTime?: string;
  snapshotAsOf?: string;
  scope?: "agent" | "raw";
}
export type QueryTotalMode = "exact" | "estimated" | "omitted";
export type QueryDataSource = "clickhouse" | "clickhouse+hot_delta" | "clickhouse+redis_current" | "memory_hot_ring";
export interface QueryCommitProgress {
  sourceId?: string;
  collectorId?: string;
  committedEventTime: string;
  committedAt: string;
}
export interface QueryCoverage {
  requestedFrom: string;
  requestedTo: string;
  snapshotAsOf: string;
  asOf: string;
  dataFrom?: string;
  dataTo?: string;
  observedDurableThrough?: string;
  /** @deprecated Compatibility alias for observedDurableThrough. */
  committedCutoff?: string;
  commitBoundaryKind?: "observed_durable_high_water";
  commitProgress?: QueryCommitProgress[];
  commitProgressScope?: "all_sources" | "query_sources";
  lateDataPolicy?: "commit_journal_revision_repair";
  completeness?: "exact_as_observed" | "partial";
  watermark?: string;
  partial: boolean;
  partialReason?: "hot_ring_only" | "scan_limit" | "storage_unavailable";
  source: QueryDataSource;
  totalMode: QueryTotalMode;
}

export type SecurityAssistantLocale = "en" | "zh-CN";
export type SecurityAssistantMessageRole = "user" | "assistant";

export interface SecurityAssistantMessage {
  role: SecurityAssistantMessageRole;
  content: string;
}

export interface SecurityAssistantContext {
  path?: string;
  view?: string;
  timeType?: SecurityTimeType;
  startTime?: string;
  endTime?: string;
  agentId?: string;
  workspacePath?: string;
  eventId?: string;
  traceId?: string;
  incidentId?: string;
  alertId?: string;
}

export interface SecurityAssistantQuery {
  sessionId?: string;
  question: string;
  locale?: SecurityAssistantLocale;
  history?: SecurityAssistantMessage[];
  context?: SecurityAssistantContext;
}

export interface SecurityAssistantReference {
  kind: "event" | "alert" | "incident" | "episode" | "vulnerability" | "view";
  id: string;
  label: string;
  href: string;
}

export interface SecurityAssistantAnswer {
  sessionId: string;
  answer: string;
  model: string;
  elapsedMs: number;
  totalTokens: number;
  evidenceSummary: string;
  references: SecurityAssistantReference[];
  readOnly: true;
}

export interface SecurityHealthCard {
  healthScore: number;
  healthStatusText: string;
  tokenConsumptionTotal: number;
  tokenConsumptionUnit: string;
}

export interface SecurityWaveSeriesPoint {
  statTime: string;
  value: number;
  activationCount: number;
}

export interface SecurityWaveSeries {
  safeSeries: SecurityWaveSeriesPoint[];
  riskSeries: SecurityWaveSeriesPoint[];
}

export interface SecurityExplainabilityScan {
  waveSeries: SecurityWaveSeries[];
  threatInterception: string;
  sessionActiveCount: string;
  updateTime: string;
}

export interface SecurityPerformanceMetric {
  current: number;
  peak: number;
  avg: number;
}

export interface SecurityLatencyMetric {
  value: number;
  unit: string;
}

export interface SecurityPerformanceCard {
  componentRequestCount: SecurityPerformanceMetric;
  tps: SecurityPerformanceMetric;
  avgLatency: SecurityLatencyMetric;
  updateTime: string;
}

export interface SecurityRiskSummaryCard {
  riskTypeCode: string;
  riskTypeName: string;
  eventCount: number;
}

export interface SecurityRiskSummary {
  summaryCards: SecurityRiskSummaryCard[];
  updateTime: string;
}

export interface SecurityRiskBreakdownItem {
  riskCode: string;
  riskName: string;
  eventCount: number;
  changeRate: number;
}

export interface SecurityRiskCategory {
  totalCount: number;
  displayColor?: string;
  items: SecurityRiskBreakdownItem[];
}

export interface SecurityRiskBreakdown {
  systemRisks: SecurityRiskCategory;
  communicationRisks: SecurityRiskCategory;
  singleAgentRisks: SecurityRiskCategory;
  updateTime: string;
}

export interface SecurityRiskDimension {
  dimensionCode: string;
  dimensionName: string;
  score: number;
}

export interface SecurityHighestRiskSession {
  sessionId: string;
  userId: string;
  workspacePath: string;
  riskLevel: SecurityRiskLevel;
  riskLevelText: string;
  compositeScore: number;
  lastEventTime: string;
  riskDimensions: SecurityRiskDimension[];
  updateTime: string;
}

export interface SecurityDecisionTier {
  tierCode: string;
  tierName: string;
  count: number;
  percentage: number;
  slaDesc: string;
}

export interface SecurityDecisionFunnel {
  tiers: SecurityDecisionTier[];
  finalBlock: {
    count: number;
    percentage: number;
  };
  updateTime: string;
}

// 智能体可观测性:Agent Observability = Infra Metrics + Behavior Analytics。
export interface AgentObservability {
  health: { heartbeatOk: boolean; resourceUtil: number; errorRate: number; decisionLatencyMs: number };
  behavioral: { actionRate: number; decisionPattern: "baseline" | "drift"; stateTransitions: number; goalProgress: number };
  system: { agentCount: number; commThroughput: number; infraHealthy: boolean };
  updateTime: string;
}

export type PlatformMetricStatus = "healthy" | "warning" | "critical" | "unknown";
export type PlatformMetricSource = "prometheus" | "runtime_fallback";

export interface PlatformMetricPoint {
  at: string;
  value: number;
}

export interface PlatformMetricSeries {
  key: "cpu" | "memory" | "disk" | "network_rx" | "network_tx" | "api_p95" | "api_error_rate";
  label: string;
  unit: "%" | "B/s" | "ms";
  points: PlatformMetricPoint[];
}

export interface PlatformComponentMetric {
  id: string;
  name: string;
  kind: "service" | "node" | "scrape_target";
  status: PlatformMetricStatus;
  cpuPercent?: number;
  memoryBytes?: number;
  memoryLimitBytes?: number;
  memoryPercent?: number;
  lastSeen?: string;
  message?: string;
}

export interface PlatformMetricAnomaly {
  id: string;
  severity: "warning" | "critical";
  metric: string;
  subject: string;
  value: number;
  unit: "%" | "ms";
  threshold: number;
  message: string;
}

export interface PlatformMetricsOverview {
  schemaVersion: "anysentry.platform_metrics.v1";
  status: "ready" | "partial" | "unavailable";
  source: PlatformMetricSource;
  from: string;
  to: string;
  stepSeconds: number;
  updatedAt: string;
  summary: {
    nodeReady?: number;
    nodeTotal?: number;
    cpuPercent?: number;
    memoryPercent?: number;
    diskPercent?: number;
    networkRxBytesPerSecond?: number;
    networkTxBytesPerSecond?: number;
    apiP95Ms?: number;
    apiErrorRatePercent?: number;
    apiRequestRate?: number;
    componentAnomalies: number;
  };
  series: PlatformMetricSeries[];
  components: PlatformComponentMetric[];
  anomalies: PlatformMetricAnomaly[];
  message?: string;
}

export interface SecurityWorkspaceRiskItem {
  workspacePath: string;
  sessionCount: number;
  totalRiskScore: number;
  riskLevel: SecurityRiskLevel;
  riskLevelText: string;
}

export interface SecurityWorkspaceRiskDistribution {
  list: SecurityWorkspaceRiskItem[];
  updateTime: string;
}

export interface SecurityExplainabilityHealth {
  configured: boolean;
  ok: boolean;
  model: string;
  baseUrl?: string;
  status?: number;
  latencyMs?: number;
  checkedAt: string;
  message?: string;
}

export interface SecurityAuditMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface SecurityExplainabilityAuditRequest {
  model?: string;
  messages: SecurityAuditMessage[];
  sessionId?: string;
  traceId?: string;
  persist?: boolean;
}

export interface SecurityExplainabilityAuditResult {
  sampleId?: string;
  model: string;
  harmful: number;
  safety: number;
  riskScore: number;
  safetyScore: number;
  riskLevel: SecurityRiskLevel;
  policyAction: SecurityPolicyAction;
  detectedAt: string;
}

export interface SecurityExplainabilityScanRequest extends SecurityTimeFilter {
  seriesPoints?: number;
}

export type SecurityVerdict = "allow" | "block" | "escalate";
export type SecuritySeverity = "info" | "low" | "medium" | "high" | "critical";
export type AgentEventSource = "observer" | "synthetic" | "api";
export type AgentDecisionStatus = "accepted" | "pending" | "running" | "succeeded" | "failed" | "timeout";
export type AgentEventCategory = "tool" | "network" | "file" | "llm" | "security" | "process" | "runtime" | "unknown";
export type AgentEventAttributeValue = string | number | boolean;
export type IncidentStatus = "open" | "acknowledged" | "resolved";
export type AgentHealthState = "active" | "idle" | "stale" | "risky";
export type AgentLifecycleState = "current" | "historical" | "terminated";
export type AgentCriticality = "low" | "medium" | "high" | "critical";
export type CollectorHealthState = "healthy" | "quiet" | "degraded" | "stale" | "down";
export type CollectorReportedStatus = "ok" | "degraded" | "error";
export type AlertStatus = "open" | "acknowledged" | "resolved" | "silenced";
export type AlertKind = "incident" | "collector" | "agent" | "event" | "judgment" | "source" | "coverage" | "objective" | "remediation";
export type AlertTimeMode = "window" | "backlog" | "combined";
export type TopologyNodeType = "agent" | "workspace" | "collector" | "tool" | "network" | "file" | "llm" | "security";
export type TopologyEdgeType = "runs_in" | "observed_by" | "executes" | "connects" | "resolves" | "accesses" | "calls_llm" | "triggers";
export type MaintenanceTargetType = "all" | "workspace" | "agent" | "collector" | "source";
export type MaintenanceStatus = "active" | "scheduled" | "expired" | "disabled";
export type NotificationChannelType = "webhook";
export type NotificationDeliveryStatus = "ok" | "error" | "not_sent";
export type ObjectiveTargetType = "global" | "workspace" | "agent" | "collector" | "source";
export type ObjectiveMetric = "coverage_score" | "open_incidents" | "active_alerts" | "overdue_remediations" | "risky_events" | "stale_agents" | "collector_down" | "source_down";
export type ObjectiveComparator = "lte" | "gte";
export type ObjectiveStatus = "ok" | "breach" | "disabled";
export type IngestionSourceType = "observer" | "forwarder" | "webhook" | "otel" | "custom";
export type IngestionSourceStatus = "active" | "stale" | "unused" | "disabled";
export type SourceTokenRotationStatus = "untracked" | "fresh" | "overdue";
export type PlatformUserRole = "administrator" | "security_analyst" | "operator" | "viewer";
export type PlatformUserStatus = "active" | "disabled";
export type PlatformUserSource = "local";
export type AuditActorType = "system" | "operator" | "api";
export type AuditAction =
  | "policy.updated"
  | "policy.simulated"
  | "incident.updated"
  | "alert.updated"
  | "remediation.updated"
  | "agent.metadata.updated"
  | "agent.review.updated"
  | "agent.review.cleared"
  | "agent.identity_ai_review.completed"
  | "maintenance.window.updated"
  | "notification.channel.updated"
  | "notification.route.updated"
  | "notification.delivery_failed"
  | "objective.updated"
  | "source.updated"
  | "source.token_rotated"
  | "user.updated";
export type AuditResourceType = "policy" | "incident" | "alert" | "remediation" | "agent" | "event" | "maintenance" | "notification" | "objective" | "source" | "user";
export type AuditResult = "success" | "failure";
export type CoverageIssueType =
  | "collector_down"
  | "collector_stale"
  | "collector_degraded"
  | "collector_quiet"
  | "agent_stale"
  | "agent_uncovered"
  | "workspace_quiet"
  | "missing_collector_heartbeat"
  | "source_unused"
  | "source_stale"
  | "source_rejected"
  | "source_token_rotation_due";

export interface AgentEventQuery extends SecurityTimeFilter {
  scope?: "agent" | "raw";
  /** Raw-view visibility only. Defaults to true; Agent scope always excludes Unknown. */
  includeUnknown?: boolean;
  /** Bounded hot-ring preview for dashboard first paint; full history remains separately available. */
  preview?: boolean;
  /** Query the durable ClickHouse history instead of only the hot dashboard window. */
  durable?: boolean;
  noise?: "hide" | "include";
  eventId?: string;
  sourceId?: string;
  collectorId?: string;
  agentId?: string;
  agentAssetId?: string;
  agentInstanceId?: string;
  sessionId?: string;
  workspacePath?: string;
  traceId?: string;
  runId?: string;
  eventKind?: string;
  eventCategory?: AgentEventCategory;
  verdict?: SecurityVerdict;
  tier?: "Rules" | "Llm" | "Agent";
  q?: string;
  limit?: number;
  totalMode?: QueryTotalMode;
}

export interface AgentEventListItem {
  schemaVersion: "anysentry.agent_event.v1";
  eventId: string;
  sourceEventId?: string;
  at: string;
  eventKind: string;
  eventCategory: AgentEventCategory;
  source: AgentEventSource;
  subject: string;
  workspacePath: string;
  agentId: string;
  agentAssetId: string;
  displayName?: string;
  detectedName?: string;
  detectedClassification: AgentClassification;
  effectiveClassification: AgentClassification;
  runtime: "kubernetes" | "docker" | "host" | "unknown";
  locationLabel?: string;
  collectorId?: string;
  sourceId?: string;
  sessionId: string;
  userId: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  runId: string;
  taskId?: string;
  decisionStatus?: AgentDecisionStatus;
  evaluationId?: string;
  policyVersion?: string;
  decisionUpdatedAt?: number;
  verdict: SecurityVerdict;
  tier: "Rules" | "Llm" | "Agent";
  severity: SecuritySeverity;
  reason: string;
  riskCategory: string;
  riskName: string;
  riskType: string;
  riskScore: number;
  tokenCount: number;
  latencyMs: number;
  attributes: Record<string, AgentEventAttributeValue>;
  process?: ProcessContext;
  attribution?: AgentAttribution;
  judgment?: EventJudgmentMetadata;
  repeatCount?: number;
  lastAt?: string;
  rawPreview?: string;
}

export interface AgentEventList {
  items: AgentEventListItem[];
  total: number;
  totalMode: QueryTotalMode;
  coverage: QueryCoverage;
  updateTime: string;
}

export interface StreamRiskProfileFinding {
  schemaVersion: "anysentry.stream_finding.v1";
  findingType: "risk_profile";
  findingId: string;
  profileId: string;
  version: number;
  tenantId: string;
  environmentId: string;
  workspaceId: string;
  workspacePath: string;
  agentCorrelationId: string;
  agentInstanceId: string;
  agentType: string;
  windowStart: number;
  windowEnd: number;
  calculatedAt: number;
  riskScore: number;
  riskLevel: SecurityRiskLevel;
  features: Record<string, number>;
  hitRules: string[];
  ruleVersion: string;
  shadow: true;
}

export interface StreamCompositeEvidence {
  eventId: string;
  sourceRecordId?: string;
  eventTime: number;
  eventKind: string;
  operation: string;
  subject: string;
  traceId?: string;
  sessionId?: string;
  resource?: string;
  destination?: string;
  dangerous?: boolean;
  sensitiveResource?: boolean;
  externalDestination?: boolean;
  failed?: boolean;
  command?: string;
  executable?: string;
  argvTruncated?: boolean;
  argvSource?: string;
  behaviorStage?: string;
  platformRuntime?: boolean;
  synthetic?: boolean;
  supplyChainWorkspaceId?: string;
  dependencySnapshotId?: string;
  vulnerabilityAssessmentId?: string;
  runtimeVulnerabilities?: Array<{
    findingId: string;
    dependencySnapshotId: string;
    vulnerabilityAssessmentId: string;
    ecosystem: string;
    packageName: string;
    version: string;
    vulnerabilityId: string;
    aliases: string[];
    confidence: "medium" | "high";
    matchBasis: string;
  }>;
  processIdentity?: {
    hostId?: string;
    containerId?: string;
    pid?: number;
    ppid?: number;
    rootPid?: number;
    startTimeNs?: string;
  };
  judgment?: {
    stage: "L1" | "L2" | "L3";
    status: "pending" | "succeeded" | "failed" | "timeout";
    verdict?: string;
    severity?: string;
    reason?: string;
    latencyMs: number;
    revision: number;
  };
}

export interface StreamCompositeRiskFinding {
  schemaVersion: "anysentry.stream_finding.v1";
  findingType: "composite_risk";
  findingId: string;
  correlationId: string;
  version: number;
  tenantId: string;
  environmentId: string;
  workspaceId: string;
  workspacePath: string;
  agentCorrelationId: string;
  agentInstanceId?: string;
  agentType: string;
  sessionId?: string;
  traceId?: string;
  ruleId: "sensitive-data-exfiltration";
  ruleVersion: "1";
  windowStart: number;
  windowEnd: number;
  calculatedAt: number;
  evidenceScore: number;
  severity: "high" | "critical";
  evidenceEventIds: string[];
  evidence: StreamCompositeEvidence[];
  reason: string;
  shadow: true;
}

export interface StreamFindingList {
  enabled: boolean;
  riskProfiles: StreamRiskProfileFinding[];
  compositeRisks: StreamCompositeRiskFinding[];
  compositeJudgments: Array<{
    schemaVersion: "anysentry.stream_finding.v1";
    findingType: "composite_judgment";
    findingId: string;
    episodeId: string;
    revision: number;
    evidenceFingerprint: string;
    tenantId: string;
    environmentId: string;
    workspaceId: string;
    workspacePath: string;
    agentCorrelationId: string;
    agentType: string;
    sessionId: string;
    traceIds: string[];
    windowStart: number;
    windowEnd: number;
    judgedAt: number;
    status: "pending" | "succeeded" | "failed" | "timeout" | "suppressed";
    verdict?: "allow" | "block";
    severity?: "low" | "medium" | "high" | "critical";
    confidence?: number;
    classification?: "benign" | "simulation" | "authorized_admin" | "suspicious" | "confirmed_attack";
    attackType?: string;
    reason?: string;
    evidenceEventIds: string[];
    evidence: StreamCompositeEvidence[];
    model: string;
    latencyMs: number;
    error?: string;
    updateRevision?: number;
    updateStatus?: "pending" | "failed" | "timeout";
    updateError?: string;
    updateJudgedAt?: number;
    ruleVersion: string;
    decisionSource: "deterministic_rule" | "composite_judge";
    synthetic: boolean;
    shadow: true;
  }>;
  updateTime: string;
}

export interface SupplyChainComponent {
  relativeSourcePath: string;
  ecosystem: string;
  packageName: string;
  version: string;
  dependencyScope: "runtime" | "development" | "optional" | "build" | "unknown";
  direct: boolean | null;
  purl?: string;
  deploymentImages?: Array<{
    reference: string;
    digest: string;
    componentSource: "osv_image" | "production_manifest";
  }>;
  installedEnvironments?: Array<{
    kind: "node_modules" | "python_environment";
    relativePath: string;
  }>;
}

export interface SupplyChainFinding {
  findingId: string;
  workspaceId: string;
  dependencySnapshotId: string;
  vulnerabilityAssessmentId: string;
  component: SupplyChainComponent;
  vulnerability: {
    id: string;
    canonicalId?: string;
    modified: string;
    published?: string;
    withdrawn?: string;
    aliases: string[];
    summary?: string;
    severity?: Array<{
      type: string;
      score: string;
      source?: string;
    }>;
    severityLevel?: "critical" | "high" | "medium" | "low" | "unknown";
    cvssScore?: number;
    cvssVector?: string;
    vendorSeverity?: "critical" | "high" | "medium" | "low" | "unknown";
    vendorSeveritySource?: string;
    impactDescription?: string;
    fixedVersions?: string[];
  };
  status: "open" | "closed" | "assessment_stale";
  closureReason?: "dependency_removed" | "version_changed" | "no_longer_affected" | "advisory_withdrawn";
  firstObservedAt: number;
  lastObservedAt: number;
  priority: "P0" | "P1" | "P2" | "P3";
  priorityScore: number;
  priorityFactors: Array<{
    code: "severity" | "deployed" | "direct_dependency" | "runtime_scope";
    score: number;
    reason: string;
  }>;
  deploymentStatus: "confirmed" | "unknown";
  remediation: {
    action:
      | "upgrade_direct_dependency"
      | "upgrade_parent_dependency"
      | "upgrade_component"
      | "update_deployed_artifact"
      | "monitor_advisory";
    summary: string;
    candidateFixedVersion?: string;
    requiresArtifactRebuild: boolean;
  };
  shadow: true;
}

export interface SupplyChainOverview {
  enabled: boolean;
  runtimeCorrelationEnabled: boolean;
  workspaces: number;
  workspaceOptions: Array<{
    workspaceId: string;
    repositoryId: string;
    displayName: string;
    sourceId?: string;
    environmentId?: string;
  }>;
  activeSnapshots: number;
  openFindings: number;
  staleFindings: number;
  latestAssessmentAt?: number;
  findings: SupplyChainFinding[];
}

export interface SupplyChainScanTask {
  taskId: string;
  workspaceId: string;
  scannerId: string;
  reason: "initial" | "dependency_descriptor_changed" | "runtime_install" | "manual" | "retry";
  status: "pending" | "leased" | "completed" | "failed";
  createdAt: number;
  updatedAt: number;
  attempt: number;
}

export interface SupplyChainControlConfig {
  schemaVersion: "anysentry.supply_chain_control.v1";
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
  workspaceOptions: Array<{
    workspaceId: string;
    repositoryId: string;
    displayName: string;
    sourceId?: string;
    environmentId?: string;
    scannerId: string;
  }>;
  scanTasks?: SupplyChainScanTask[];
  runtimeAssessmentsQueued?: number;
}

export interface AgentTimeline {
  traceId: string;
  runId?: string;
  sessionId?: string;
  items: AgentEventListItem[];
  total: number;
  hasMore: boolean;
  coverage: QueryCoverage;
  updateTime: string;
}

export type EvidenceBundlePrimaryType = "event" | "incident" | "alert" | "remediation" | "objective" | "coverage" | "notification" | "maintenance" | "audit" | "topology" | "scope";

export interface EvidenceBundleQuery extends SecurityTimeFilter {
  auditId?: string;
  edgeId?: string;
  eventId?: string;
  incidentId?: string;
  alertId?: string;
  taskId?: string;
  objectiveId?: string;
  issueId?: string;
  deliveryId?: string;
  windowId?: string;
  workspacePath?: string;
  agentId?: string;
  collectorId?: string;
  sourceId?: string;
  traceId?: string;
  runId?: string;
  sessionId?: string;
  limit?: number;
}

export interface EvidenceBundleScope {
  primaryType: EvidenceBundlePrimaryType;
  primaryId?: string;
  auditId?: string;
  edgeId?: string;
  eventId?: string;
  incidentId?: string;
  alertId?: string;
  taskId?: string;
  objectiveId?: string;
  issueId?: string;
  deliveryId?: string;
  windowId?: string;
  workspacePath?: string;
  agentId?: string;
  collectorId?: string;
  sourceId?: string;
  traceId?: string;
  runId?: string;
  sessionId?: string;
}

export interface EvidenceBundleRiskCategory {
  riskCategory: string;
  riskName: string;
  eventCount: number;
}

export interface EvidenceBundleSummary {
  eventCount: number;
  incidentCount: number;
  alertCount: number;
  remediationCount: number;
  objectiveCount: number;
  notificationDeliveryCount: number;
  maintenanceWindowCount: number;
  coverageIssueCount: number;
  topologyNodeCount: number;
  topologyEdgeCount: number;
  auditCount: number;
  agentCount: number;
  workspaceCount: number;
  sourceCount: number;
  collectorCount: number;
  maxSeverity?: SecuritySeverity;
  riskCategories: EvidenceBundleRiskCategory[];
}

export interface EvidenceBundle {
  schemaVersion: "anysentry.evidence_bundle.v1";
  bundleId: string;
  generatedAt: string;
  scope: EvidenceBundleScope;
  summary: EvidenceBundleSummary;
  primary: {
    event?: AgentEventListItem;
    incident?: IncidentListItem;
    alert?: AlertListItem;
    remediation?: RemediationListItem;
    objective?: ObjectiveItem;
    coverageIssue?: CoverageIssue;
    notificationDelivery?: NotificationDeliveryItem;
    maintenanceWindow?: MaintenanceWindowItem;
    audit?: AuditListItem;
    topologyEdge?: AgentTopologyEdge;
  };
  timeline: AgentTimeline;
  events: AgentEventListItem[];
  incidents: IncidentListItem[];
  alerts: AlertListItem[];
  remediations: RemediationListItem[];
  objectives: ObjectiveItem[];
  notificationDeliveries: NotificationDeliveryItem[];
  maintenanceWindows: MaintenanceWindowItem[];
  coverageIssues: CoverageIssue[];
  topology: AgentTopology;
  agents: AgentInventoryItem[];
  workspaces: WorkspaceInventoryItem[];
  sources: IngestionSourceItem[];
  collectors: CollectorHealthItem[];
  audits: AuditListItem[];
}

export type EvidenceBundleExportFormat = "markdown";

export interface EvidenceBundleExportQuery extends EvidenceBundleQuery {
  format?: EvidenceBundleExportFormat;
}

export interface EvidenceBundleExport {
  schemaVersion: "anysentry.evidence_export.v1";
  bundleId: string;
  generatedAt: string;
  format: EvidenceBundleExportFormat;
  contentType: string;
  filename: string;
  contentSha256: string;
  scope: EvidenceBundleScope;
  summary: EvidenceBundleSummary;
  content: string;
}

export interface UniversalIngestEvent extends Partial<AgentEventQuery> {
  at?: string | number;
  timestamp?: string | number;
  kind?: string;
  category?: AgentEventCategory;
  collectorId?: string;
  nodeName?: string;
  source?: AgentEventSource;
  subject?: string;
  userId?: string;
  parentSpanId?: string;
  taskId?: string;
  tokenCount?: number;
  latencyMs?: number;
  pid?: string | number;
  uid?: string | number;
  cwd?: string;
  argv?: string[] | string;
  command?: string[] | string;
  peer?: string;
  port?: string | number;
  query?: string;
  path?: string;
  sni?: string;
  endpoint?: string;
  content?: string;
  data?: string;
  promptTokens?: string | number;
  completionTokens?: string | number;
  status?: string | number;
  attributes?: Record<string, unknown>;
  rawPreview?: string;
  raw?: unknown;
}

export interface UniversalIngestRequest {
  event?: UniversalIngestEvent;
  events?: UniversalIngestEvent[];
  specversion?: string;
  specVersion?: string;
  id?: string;
  type?: string;
  datacontenttype?: string;
  dataschema?: string;
  time?: string;
  data_base64?: string;
  data?: unknown;
  workspacePath?: string;
  agentId?: string;
  sessionId?: string;
  userId?: string;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  runId?: string;
  taskId?: string;
  source?: string;
  eventCategory?: AgentEventCategory;
  subject?: string;
  tokenCount?: number;
  latencyMs?: number;
  attributes?: Record<string, unknown>;
  rawPreview?: string;
  collectorId?: string;
  sourceId?: string;
  nodeName?: string;
  peer?: string;
  port?: string | number;
  sourceName?: string;
  sourceType?: IngestionSourceType;
  token?: string;
}

export type UniversalIngestBody = UniversalIngestRequest | UniversalIngestRequest[];

export interface UniversalIngestResultItem {
  index: number;
  accepted: boolean;
  reason?: string;
  eventId?: string;
  traceId?: string;
  spanId?: string;
  runId?: string;
  verdict?: SecurityVerdict;
  tier?: "Rules" | "Llm" | "Agent";
  severity?: SecuritySeverity;
  riskCategory?: string;
}

export interface UniversalIngestResult {
  accepted: boolean;
  sourceId?: string;
  acceptedEvents: number;
  rejectedEvents: number;
  items: UniversalIngestResultItem[];
}

export type SecurityCapabilityAction = "list" | "search" | "describe" | "execute";
export type SecurityCapabilityAutonomy = "suggest" | "guarded" | "auto";
export type SecurityCapabilityStage = "input" | "plan" | "tool" | "retrieval" | "memory" | "llm" | "output" | "feedback" | "runtime";
export type SecurityCapabilityPolicyAction = "allow" | "warn" | "require_approval" | "block";

export type SecurityApiOperationAction =
  | "list"
  | "get"
  | "create"
  | "update"
  | "delete"
  | "execute"
  | "download"
  | "stream"
  | "unknown";

export interface SecurityApiParameter {
  name: string;
  in?: "path" | "query" | "header" | "body";
  type: string;
  required: boolean;
  description: string;
  enum?: unknown[];
  default?: unknown;
  example?: unknown;
}

export interface SecurityApiOperation {
  name: string;
  description: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  operationId?: string;
  resource?: string;
  action?: SecurityApiOperationAction;
  tags?: string[];
  permissions?: string[];
  parameters?: SecurityApiParameter[];
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  pagination?: Record<string, unknown>;
  filterFields?: string[];
  sortFields?: string[];
  streaming?: Record<string, unknown>;
  rawResponse?: Record<string, unknown>;
  relatedOperations?: Array<Pick<SecurityApiOperation, "name" | "method" | "path" | "action">>;
  examples?: unknown[];
}

export interface SecurityApiModule {
  name: string;
  description: string;
  path: string;
  permissions?: string[];
  submodules?: SecurityApiModule[];
  operations?: SecurityApiOperation[];
}

export interface SecurityCapabilityConstraints {
  noNetworkActivity?: boolean;
  noDestructiveActions?: boolean;
  maxRiskLevel?: SecuritySeverity | "medium" | "high" | "critical";
  autonomy?: SecurityCapabilityAutonomy;
}

export interface SecurityRuntimeGuardParams extends Partial<UniversalIngestEvent> {
  autonomy?: SecurityCapabilityAutonomy;
  stage?: SecurityCapabilityStage | string;
  action?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown> | string;
  target?: string;
  resource?: string;
  input?: string;
  prompt?: string;
  output?: string;
  model?: string;
  labels?: Record<string, string | number | boolean>;
  evidence?: Record<string, unknown>;
  sourceId?: string;
  sourceName?: string;
  token?: string;
}

export interface SecurityCapabilityRequest {
  action?: SecurityCapabilityAction | string;
  category?: string;
  query?: string;
  module?: string;
  capabilityId?: string;
  operation?: string;
  params?: Record<string, unknown>;
  constraints?: SecurityCapabilityConstraints;
  dryRun?: boolean;
  sessionId?: string;
  shaped?: boolean | string;
}

export interface SecurityCapabilitySchemaIssue {
  path: string;
  message: string;
  severity: "error" | "warning";
}

export interface SecurityCapabilityDryRunResult {
  schemaVersion: "anysentry.progressive.dry_run.v1";
  valid: boolean;
  dryRun: true;
  module: string;
  operation: string;
  targetInScope: boolean;
  tokenVerified: boolean;
  decision: "allow" | "reject";
  constraints: SecurityCapabilityConstraints;
  schemaValid: boolean;
  schemaIssues: SecurityCapabilitySchemaIssue[];
  normalizedRequest: {
    action: "execute";
    module: string;
    operation: string;
    dryRun: true;
    params: Record<string, unknown>;
    constraints?: SecurityCapabilityConstraints;
    sessionId?: string;
    shaped?: boolean | string;
  };
}

export interface SecurityRuntimeGuardDecision {
  schemaVersion: "anysentry.progressive.runtime_guard.result.v1";
  module: "security-center";
  operation: "assessRuntimeAction";
  capabilityId?: "security.runtimeGuard";
  autonomy: SecurityCapabilityAutonomy;
  stage: SecurityCapabilityStage;
  policyAction: SecurityCapabilityPolicyAction;
  recommendedAction: "continue" | "review" | "stop";
  accepted: boolean;
  sourceId?: string;
  eventId?: string;
  traceId?: string;
  runId?: string;
  verdict?: SecurityVerdict;
  tier?: "Rules" | "Llm" | "Agent";
  severity?: SecuritySeverity;
  riskCategory?: string;
  reason?: string;
  evidence?: {
    eventId?: string;
    eventsHref?: string;
    bundleHint?: EvidenceBundleQuery;
  };
}

export interface SecurityNextActionPlanParams extends RemediationQuery {
  maxActions?: number;
  includeCompletedSteps?: boolean;
  owner?: string;
}

export interface SecurityNextActionPlanItem {
  actionId: string;
  taskId: string;
  rank: number;
  priority: "critical" | "high" | "medium" | "low";
  status: RemediationStatus;
  severity: SecuritySeverity;
  title: string;
  recommendedAction: string;
  actionKind: RemediationActionKind;
  sourceType: RemediationSourceType;
  sourceId: string;
  owner?: string;
  dueAt?: string;
  overdue: boolean;
  needsApproval: boolean;
  agentId?: string;
  workspacePath?: string;
  collectorId?: string;
  sourceIdentity?: string;
  eventId?: string;
  traceId?: string;
  objectiveId?: string;
  issueId?: string;
  evidence: {
    primaryType: EvidenceBundlePrimaryType;
    primaryId: string;
    eventId?: string;
    incidentId?: string;
    alertId?: string;
    taskId: string;
    objectiveId?: string;
    issueId?: string;
    bundleHint: EvidenceBundleQuery;
  };
  nextSteps: RemediationStep[];
}

export interface SecurityNextActionPlan {
  schemaVersion: "anysentry.progressive.next_action_plan.v1";
  module: "security-center";
  operation: "planNextActions";
  generatedAt: string;
  scope: {
    timeType?: SecurityTimeType;
    workspacePath?: string;
    agentId?: string;
    collectorId?: string;
    sourceId?: string;
    owner?: string;
    q?: string;
  };
  summary: {
    totalCandidates: number;
    returnedActions: number;
    criticalActions: number;
    overdueActions: number;
    approvalRequiredActions: number;
  };
  actions: SecurityNextActionPlanItem[];
}

export interface SecurityCapabilityResponse {
  schemaVersion: "anysentry.progressive.response.v1";
  protocol: "shuanos-progressive-api/source-compatible";
  action: SecurityCapabilityAction;
  success?: boolean;
  modules?: SecurityApiModule[];
  module?: SecurityApiModule | null;
  operation?: SecurityApiOperation;
  operations?: SecurityApiOperation[];
  result?: unknown;
  data?: unknown;
  view?: { url: string; width: number; height: number };
  compatibility?: {
    sourceImplementation: "os/apps/api/src/modules/kernel";
    dispatch: "module + operation + params";
    supportedActions: SecurityCapabilityAction[];
    shapedOptIn: boolean;
    legacyCapabilityAliases: Record<string, { module: string; operation: string }>;
  };
}

export interface IncidentQuery extends SecurityTimeFilter {
  incidentId?: string;
  status?: IncidentStatus | "all";
  severity?: SecuritySeverity | "all";
  workspacePath?: string;
  agentId?: string;
  collectorId?: string;
  sourceId?: string;
  sessionId?: string;
  traceId?: string;
  limit?: number;
}

export interface IncidentListItem {
  incidentId: string;
  status: IncidentStatus;
  severity: SecuritySeverity;
  title: string;
  description: string;
  openedAt: string;
  updatedAt: string;
  acknowledgedAt?: string;
  resolvedAt?: string;
  owner?: string;
  note?: string;
  workspacePath: string;
  agentId: string;
  collectorId?: string;
  sourceId?: string;
  sessionId: string;
  userId: string;
  traceId: string;
  runId: string;
  riskCategory: string;
  riskName: string;
  riskType: string;
  eventCount: number;
  lastEventId: string;
  lastEventAt: string;
  lastEventSubject: string;
  maxRiskScore: number;
}

export interface IncidentList {
  items: IncidentListItem[];
  total: number;
  summary: Record<IncidentStatus, number>;
  updateTime: string;
}

export interface IncidentUpdateRequest {
  status?: IncidentStatus;
  owner?: string;
  note?: string;
}

export interface AgentInventoryQuery extends SecurityTimeFilter {
  healthState?: AgentHealthState | "all";
  criticality?: AgentCriticality | "all";
  owner?: string;
  environment?: string;
  tag?: string;
  q?: string;
  agentId?: string;
  agentAssetId?: string;
  agentInstanceId?: string;
  workspacePath?: string;
  userId?: string;
  includeUnclassified?: boolean;
  limit?: number;
}

export interface AgentInventoryItem {
  agentId: string;
  agentAssetId: string;
  agentAssetAliases?: string[];
  workspacePath: string;
  userId: string;
  displayName?: string;
  detectedName?: string;
  detectedClassification: AgentClassification;
  owner?: string;
  team?: string;
  environment?: string;
  criticality?: AgentCriticality;
  tags: string[];
  note?: string;
  metadataUpdatedAt?: string;
  classification: AgentClassification;
  runtime: "kubernetes" | "docker" | "host" | "unknown";
  locationLabel?: string;
  instanceCount: number;
  confidence: number;
  attributionSource: AgentAttributionSource;
  attributionEvidence: string[];
  physicalWorkloadId?: string;
  agentInstanceId?: string;
  logicalInstanceCount?: number;
  hostId?: string;
  bootId?: string;
  rootPid?: number;
  rootStartTime?: string;
  workloadRef?: AgentWorkloadRef;
  reviewDecision?: AgentReviewDecision;
  reviewedBy?: string;
  reviewedAt?: string;
  reviewNote?: string;
  reviewIdentityKeys: string[];
  firstSeen: string;
  lastSeen: string;
  lifecycleState: AgentLifecycleState;
  terminatedAt?: string;
  healthState: AgentHealthState;
  riskLevel: SecurityRiskLevel;
  riskLevelText: string;
  eventCount: number;
  riskyEventCount: number;
  openIncidentCount: number;
  sessionCount: number;
  runCount: number;
  traceCount: number;
  tokenCount: number;
  avgLatencyMs: number;
  topRiskCategory?: string;
  topRiskName?: string;
  lastEventSubject: string;
  eventCategoryCounts: Record<AgentEventCategory, number>;
  sourceCounts: Record<AgentEventSource, number>;
}

export interface AgentInventorySummary {
  totalAgents: number;
  managedAgents: number;
  productionAgents: number;
  highCriticalityAgents: number;
  activeAgents: number;
  idleAgents: number;
  staleAgents: number;
  riskyAgents: number;
  openIncidentAgents: number;
  observedEventCount: number;
  riskyEventCount: number;
}

export interface AgentMetadataListItem {
  agentId: string;
  agentAssetId: string;
  agentAssetAliases?: string[];
  workspacePath: string;
  displayName?: string;
  owner?: string;
  team?: string;
  environment?: string;
  criticality?: AgentCriticality;
  tags: string[];
  note?: string;
  identityKeys?: string[];
  physicalWorkloadId?: string;
  agentInstanceId?: string;
  workloadRef?: AgentWorkloadRef;
  reviewDecision?: AgentReviewDecision;
  reviewedBy?: string;
  reviewedAt?: string;
  reviewNote?: string;
  reviewIdentityKeys?: string[];
  reviewPhysicalWorkloadId?: string;
  reviewAgentInstanceId?: string;
  reviewWorkloadRef?: AgentWorkloadRef;
  updatedAt: string;
}

export interface AgentMetadataList {
  items: AgentMetadataListItem[];
  updateTime: string;
}

export interface AgentMetadataUpdateRequest {
  workspacePath: string;
  agentAssetId?: string;
  displayName?: string;
  owner?: string;
  team?: string;
  environment?: string;
  criticality?: AgentCriticality | "";
  tags?: string[];
  note?: string;
  identityKeys?: string[];
  physicalWorkloadId?: string;
  agentInstanceId?: string;
  workloadRef?: AgentWorkloadRef;
}

export interface AgentReviewRequest {
  workspacePath: string;
  decision: AgentReviewDecision | "clear";
  currentClassification?: AgentClassification;
  agentAssetId?: string;
  identityKeys?: string[];
  physicalWorkloadId?: string;
  agentInstanceId?: string;
  workloadRef?: AgentWorkloadRef;
  note?: string;
}

export interface AgentInventory {
  items: AgentInventoryItem[];
  total: number;
  summary: AgentInventorySummary;
  coverage: QueryCoverage;
  updateTime: string;
}

export interface AgentInstanceMetricsQuery extends SecurityTimeFilter {
  agentAssetId: string;
  agentInstanceId?: string;
  seriesPoints?: number;
}

export interface AgentInstanceMetricPoint {
  statTime: string;
  eventCount: number;
  riskyEventCount: number;
  blockedCount: number;
  escalatedCount: number;
  toolCount: number;
  fileCount: number;
  networkCount: number;
  processCount: number;
  llmCount: number;
  l1Count: number;
  l2Count: number;
  l3Count: number;
  failedCount: number;
  timeoutCount: number;
  tokenCount: number;
  avgLatencyMs: number;
  maxRiskScore: number;
}

export interface AgentInstanceMetrics {
  agentAssetId: string;
  points: AgentInstanceMetricPoint[];
  eventCount: number;
  riskyEventCount: number;
  blockedCount: number;
  escalatedCount: number;
  tokenCount: number;
  avgLatencyMs: number;
  failedCount: number;
  timeoutCount: number;
  updateTime: string;
}

export type IdentityAiReviewTargetType = "event" | "agent";
export type IdentityAiVerdict = "agent" | "not_agent";
export interface IdentityAiReviewRequest extends SecurityTimeFilter {
  targetType: IdentityAiReviewTargetType;
  eventId?: string;
  agentAssetId?: string;
}
export interface IdentityAiReviewRecord {
  schemaVersion: "anysentry.identity_ai_review.v1";
  reviewId: string;
  targetType: IdentityAiReviewTargetType;
  eventId?: string;
  agentAssetId: string;
  status: "running" | "succeeded" | "failed";
  verdict?: IdentityAiVerdict;
  confidence?: number;
  summary?: string;
  reason?: string;
  evidenceRefs: string[];
  evidenceDigest: string;
  model?: string;
  provider: "direct-llm" | "a3s-code-sdk";
  automatic?: boolean;
  logicalIdentityKey?: string;
  appliedDecision?: AgentReviewDecision;
  appliedAt?: string;
  error?: string;
  createdAt: string;
  completedAt?: string;
}
export interface IdentityAiReviewList {
  items: IdentityAiReviewRecord[];
  updateTime: string;
}

export interface WorkspaceInventoryQuery extends SecurityTimeFilter {
  healthState?: AgentHealthState | "all";
  criticality?: AgentCriticality | "all";
  owner?: string;
  environment?: string;
  workspacePath?: string;
  q?: string;
  limit?: number;
}

export interface WorkspaceInventoryItem {
  workspaceId?: string;
  workspacePath: string;
  owner?: string;
  team?: string;
  environment?: string;
  criticality?: AgentCriticality;
  tags: string[];
  healthState: AgentHealthState;
  riskLevel: SecurityRiskLevel;
  riskLevelText: string;
  agentCount: number;
  managedAgentCount: number;
  activeAgentCount: number;
  idleAgentCount: number;
  staleAgentCount: number;
  riskyAgentCount: number;
  openIncidentCount: number;
  collectorCount: number;
  eventCount: number;
  riskyEventCount: number;
  sessionCount: number;
  runCount: number;
  traceCount: number;
  tokenCount: number;
  avgLatencyMs: number;
  topRiskCategory?: string;
  topRiskName?: string;
  firstSeen: string;
  lastSeen: string;
  lastEventSubject: string;
  maintenanceActive: boolean;
  maintenanceWindowId?: string;
  maintenanceTitle?: string;
}

export interface WorkspaceInventorySummary {
  totalWorkspaces: number;
  managedWorkspaces: number;
  productionWorkspaces: number;
  highCriticalityWorkspaces: number;
  activeWorkspaces: number;
  staleWorkspaces: number;
  riskyWorkspaces: number;
  maintainedWorkspaces: number;
  totalAgents: number;
  openIncidentCount: number;
  observedEventCount: number;
  riskyEventCount: number;
}

export interface WorkspaceInventory {
  items: WorkspaceInventoryItem[];
  total: number;
  summary: WorkspaceInventorySummary;
  updateTime: string;
}

export interface AgentTopologyQuery extends SecurityTimeFilter {
  scope?: "agent" | "raw";
  edgeId?: string;
  eventId?: string;
  agentAssetId?: string;
  agentInstanceId?: string;
  agentId?: string;
  workspacePath?: string;
  collectorId?: string;
  sourceId?: string;
  q?: string;
  includeBenign?: boolean;
  limit?: number;
}

export interface AgentTopologyNode {
  nodeId: string;
  type: TopologyNodeType;
  label: string;
  subtitle?: string;
  agentAssetId?: string;
  agentInstanceId?: string;
  agentId?: string;
  classification?: AgentClassification;
  workspacePath?: string;
  collectorId?: string;
  riskLevel: SecurityRiskLevel;
  riskLevelText: string;
  eventCount: number;
  riskyEventCount: number;
  lastSeen: string;
}

export interface AgentTopologyRiskCategory {
  riskCategory: string;
  riskName: string;
  eventCount: number;
}

export interface AgentTopologyEdge {
  edgeId: string;
  sourceNodeId: string;
  targetNodeId: string;
  type: TopologyEdgeType;
  label: string;
  eventCount: number;
  riskyEventCount: number;
  maxSeverity: SecuritySeverity;
  lastSeen: string;
  sampleEventId: string;
  sampleSubject: string;
  riskCategories: AgentTopologyRiskCategory[];
}

export interface AgentTopologySummary {
  agentCount: number;
  workspaceCount: number;
  collectorCount: number;
  toolTargetCount: number;
  externalEndpointCount: number;
  fileTargetCount: number;
  llmEndpointCount: number;
  securityTargetCount: number;
  nodeCount: number;
  edgeCount: number;
  riskyEdgeCount: number;
}

export interface AgentTopology {
  nodes: AgentTopologyNode[];
  edges: AgentTopologyEdge[];
  summary: AgentTopologySummary;
  coverage: QueryCoverage;
  updateTime: string;
}

export interface CollectorHeartbeatRequest {
  collectorId?: string;
  sourceId?: string;
  sourceName?: string;
  sourceType?: IngestionSourceType;
  token?: string;
  workspacePath?: string;
  nodeName?: string;
  namespace?: string;
  podName?: string;
  version?: string;
  mode?: string;
  status?: CollectorReportedStatus;
  attachedProbes?: number;
  enabledFeatures?: string[];
  intervalSecs?: number;
  eventKindCounts?: Record<string, number>;
  queueDepth?: number;
  droppedEvents?: number;
  outputDropped?: number;
  errorCount?: number;
  observedAgents?: number;
  filterMetrics?: CollectorFilterMetrics;
  message?: string;
}

export interface CollectorFilterMetrics {
  /** @deprecated Compatibility marker for pre-decoupling forwarders. */
  scope: "all" | "shadow" | "agent" | "decoupled";
  filterMode?: "enforce" | "shadow";
  retainUnknown?: boolean;
  retainNonAgent?: boolean;
  noisePolicy?: "balanced" | "include";
  observed: number;
  forwarded: number;
  confirmedAgent: number;
  probableAgent: number;
  unknown: number;
  nonAgent: number;
  filteredNonAgent: number;
  wouldFilterNonAgent: number;
  filteredNoise: number;
  wouldFilterNoise: number;
  discoveryBudgetDropped: number;
  wouldDiscoveryBudgetDrop: number;
  deduplicated: number;
  queueDropped: number;
  batches: number;
  batchEvents: number;
  identitySnapshotReady: boolean;
  identitySnapshotVersion: number;
  identitySnapshotAgeSeconds: number;
  identityCacheEntries: number;
  identityCacheHits: number;
  identityCacheMisses: number;
  identityCandidateCacheEntries: number;
  identityCgroupBindings: number;
  identityCgroupHits: number;
  identityCgroupMisses: number;
  identityErrors: number;
  dockerEnabled: boolean;
  dockerReady: boolean;
  dockerEntries: number;
  dockerReconnects: number;
  dockerErrors: number;
  behaviorWorkloads: number;
  behaviorCandidates: number;
  behaviorPromoted: number;
  behaviorEvicted: number;
  templateLoaded: number;
  templateInvalid: number;
  templateMatches: number;
  templateAmbiguous: number;
  processCacheEntries: number;
  processTombstones: number;
  processClassifications: number;
  processCacheHits: number;
  processCacheMisses: number;
  processProcReads: number;
  processBootstrapProcReads: number;
  processFallbackProcReads: number;
  processAncestryProcReads: number;
}

export interface CollectorHeartbeatAck {
  accepted: boolean;
  collectorId: string;
  sourceId?: string;
  receivedAt: string;
  reason?: string;
}

export interface CollectorHealthQuery extends SecurityTimeFilter {
  state?: CollectorHealthState | "all";
  q?: string;
  collectorId?: string;
  nodeName?: string;
  limit?: number;
}

export interface CollectorHealthItem {
  collectorId: string;
  nodeName?: string;
  namespace?: string;
  podName?: string;
  version?: string;
  mode?: string;
  state: CollectorHealthState;
  stateText: string;
  firstSeen?: string;
  lastEventAt?: string;
  lastHeartbeatAt?: string;
  lastSeenAt?: string;
  eventCount: number;
  eventRatePerMin: number;
  riskyEventCount: number;
  observedAgentCount: number;
  observedWorkspaceCount: number;
  attachedProbes: number;
  enabledFeatures: string[];
  queueDepth: number;
  droppedEvents: number;
  outputDropped: number;
  errorCount: number;
  filterMetrics: CollectorFilterMetrics;
  message?: string;
  eventCategoryCounts: Record<AgentEventCategory, number>;
}

export interface CollectorHealthSummary {
  totalCollectors: number;
  healthyCollectors: number;
  quietCollectors: number;
  degradedCollectors: number;
  staleCollectors: number;
  downCollectors: number;
  collectorsWithHeartbeat: number;
  observedEventCount: number;
  observedAgentCount: number;
}

export interface CollectorHealth {
  items: CollectorHealthItem[];
  total: number;
  summary: CollectorHealthSummary;
  coverage: QueryCoverage;
  updateTime: string;
}

export interface CoverageQuery extends SecurityTimeFilter {
  issueId?: string;
  agentId?: string;
  workspacePath?: string;
  collectorId?: string;
  sourceId?: string;
  severity?: SecuritySeverity | "all";
  type?: CoverageIssueType | "all";
  q?: string;
  limit?: number;
}

export interface CoverageIssue {
  issueId: string;
  type: CoverageIssueType;
  severity: SecuritySeverity;
  title: string;
  description: string;
  detectedAt: string;
  lastSeenAt?: string;
  agentId?: string;
  workspacePath?: string;
  collectorId?: string;
  sourceId?: string;
  nodeName?: string;
  evidenceEventId?: string;
  evidenceSubject?: string;
  recommendedAction: string;
  suppressedByMaintenance?: boolean;
  maintenanceWindowId?: string;
  maintenanceTitle?: string;
  labels: Record<string, string>;
}

export interface CoverageSummary {
  coverageScore: number;
  statusText: string;
  issueCount: number;
  criticalIssues: number;
  highIssues: number;
  mediumIssues: number;
  lowIssues: number;
  suppressedIssues: number;
  observedAgents: number;
  coveredAgents: number;
  uncoveredAgents: number;
  staleAgents: number;
  totalCollectors: number;
  activeCollectors: number;
  degradedCollectors: number;
  downCollectors: number;
  totalSources: number;
  activeSources: number;
  unhealthySources: number;
  eventsWithoutCollector: number;
  observedWorkspaces: number;
}

export interface CoverageOverview {
  summary: CoverageSummary;
  issues: CoverageIssue[];
  updateTime: string;
}

export interface MaintenanceWindowItem {
  windowId: string;
  title: string;
  targetType: MaintenanceTargetType;
  targetId: string;
  startAt: string;
  endAt: string;
  enabled: boolean;
  status: MaintenanceStatus;
  reason?: string;
  owner?: string;
  note?: string;
  labels: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface MaintenanceWindowQuery extends SecurityTimeFilter {
  windowId?: string;
  status?: MaintenanceStatus | "all";
  targetType?: MaintenanceTargetType | "all";
  targetId?: string;
  q?: string;
  limit?: number;
}

export interface MaintenanceWindowUpdateRequest {
  title?: string;
  targetType?: MaintenanceTargetType;
  targetId?: string;
  startAt?: string;
  endAt?: string;
  enabled?: boolean;
  reason?: string;
  owner?: string;
  note?: string;
  labels?: Record<string, string>;
}

export interface MaintenanceWindowSummary {
  totalWindows: number;
  activeWindows: number;
  scheduledWindows: number;
  expiredWindows: number;
  disabledWindows: number;
}

export interface MaintenanceWindowList {
  items: MaintenanceWindowItem[];
  total: number;
  summary: MaintenanceWindowSummary;
  updateTime: string;
}

export interface AlertRule {
  ruleId: string;
  name: string;
  kind: AlertKind;
  enabled: boolean;
  severity: SecuritySeverity;
  cooldownSecs: number;
  description: string;
}

export interface AlertListItem {
  alertId: string;
  dedupeKey: string;
  ruleId: string;
  kind: AlertKind;
  status: AlertStatus;
  severity: SecuritySeverity;
  title: string;
  description: string;
  firstSeenAt: string;
  lastSeenAt: string;
  updatedAt: string;
  acknowledgedAt?: string;
  resolvedAt?: string;
  silencedUntil?: string;
  owner?: string;
  team?: string;
  note?: string;
  workspacePath?: string;
  agentId?: string;
  sessionId?: string;
  userId?: string;
  traceId?: string;
  runId?: string;
  incidentId?: string;
  eventId?: string;
  collectorId?: string;
  sourceId?: string;
  nodeName?: string;
  riskCategory?: string;
  riskName?: string;
  sourceSummary: string;
  occurrenceCount: number;
  evidenceEventCount?: number;
  evidenceEventIds?: string[];
  lastNotificationAt?: string;
  labels: Record<string, string>;
  monitored?: boolean;
  agentScopeId?: string;
}

export interface AlertListQuery extends SecurityTimeFilter {
  alertId?: string;
  status?: AlertStatus | "active" | "all";
  severity?: SecuritySeverity | "all";
  kind?: AlertKind | "all";
  q?: string;
  workspacePath?: string;
  agentId?: string;
  collectorId?: string;
  sourceId?: string;
  incidentId?: string;
  eventId?: string;
  taskId?: string;
  objectiveId?: string;
  issueId?: string;
  timeMode?: AlertTimeMode;
  limit?: number;
}

export interface AlertListSummary {
  totalAlerts: number;
  activeAlerts: number;
  openAlerts: number;
  acknowledgedAlerts: number;
  silencedAlerts: number;
  resolvedAlerts: number;
  criticalAlerts: number;
  highAlerts: number;
  urgentActiveAlerts: number;
  unassignedActiveAlerts: number;
  incidentAlerts: number;
  collectorAlerts: number;
  agentAlerts: number;
  eventAlerts: number;
  judgmentAlerts: number;
  sourceAlerts: number;
  coverageAlerts: number;
  objectiveAlerts: number;
  remediationAlerts: number;
}

export interface AlertList {
  items: AlertListItem[];
  total: number;
  summary: AlertListSummary;
  rules: AlertRule[];
  webhookConfigured: boolean;
  updateTime: string;
}

export interface AlertUpdateRequest {
  status?: AlertStatus;
  owner?: string;
  note?: string;
  silenceMinutes?: number;
}

export interface AlertConfig {
  enabled: boolean;
  webhookConfigured: boolean;
  webhookCooldownSecs: number;
  incidentMinSeverity: SecuritySeverity;
  eventMinSeverity: SecuritySeverity;
  agentOpenIncidentThreshold: number;
  collectorStaleAfterSecs: number;
  collectorDownAfterSecs: number;
  sourceStaleAfterSecs: number;
  sourceDownAfterSecs: number;
}

export interface NotificationChannelItem {
  channelId: string;
  name: string;
  type: NotificationChannelType;
  enabled: boolean;
  endpointPreview?: string;
  readOnly?: boolean;
  description?: string;
  labels: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  lastSentAt?: string;
  lastStatus?: NotificationDeliveryStatus;
  lastError?: string;
}

export interface NotificationRouteItem {
  routeId: string;
  name: string;
  enabled: boolean;
  channelIds: string[];
  minSeverity?: SecuritySeverity;
  kinds: AlertKind[];
  workspacePath?: string;
  agentId?: string;
  collectorId?: string;
  sourceId?: string;
  owner?: string;
  team?: string;
  q?: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

export interface NotificationDeliveryItem {
  deliveryId: string;
  alertId: string;
  alertRuleId: string;
  alertKind: AlertKind;
  alertSeverity: SecuritySeverity;
  alertTitle: string;
  channelId: string;
  channelName: string;
  routeId?: string;
  routeName?: string;
  action: "opened" | "reopened" | "resolved";
  status: NotificationDeliveryStatus;
  sentAt: string;
  durationMs?: number;
  error?: string;
  endpointPreview?: string;
  workspacePath?: string;
  agentId?: string;
  collectorId?: string;
  sourceId?: string;
  incidentId?: string;
  eventId?: string;
  taskId?: string;
  objectiveId?: string;
  issueId?: string;
  owner?: string;
  team?: string;
}

export interface NotificationChannelUpdateRequest {
  name?: string;
  type?: NotificationChannelType;
  enabled?: boolean;
  webhookUrl?: string;
  description?: string;
  labels?: Record<string, string>;
}

export interface NotificationRouteUpdateRequest {
  name?: string;
  enabled?: boolean;
  channelIds?: string[];
  minSeverity?: SecuritySeverity | "";
  kinds?: AlertKind[];
  workspacePath?: string;
  agentId?: string;
  collectorId?: string;
  sourceId?: string;
  owner?: string;
  team?: string;
  q?: string;
  description?: string;
}

export interface NotificationConfigSummary {
  totalChannels: number;
  enabledChannels: number;
  totalRoutes: number;
  enabledRoutes: number;
  totalDeliveries: number;
  okDeliveries: number;
  errorDeliveries: number;
  notSentDeliveries: number;
  legacyWebhookConfigured: boolean;
}

export interface NotificationConfigQuery {
  channelId?: string;
  routeId?: string;
  kind?: AlertKind | "all";
  minSeverity?: SecuritySeverity | "all";
  workspacePath?: string;
  agentId?: string;
  collectorId?: string;
  sourceId?: string;
  owner?: string;
  team?: string;
  deliveryId?: string;
  alertId?: string;
  incidentId?: string;
  eventId?: string;
  taskId?: string;
  objectiveId?: string;
  issueId?: string;
  limit?: number;
}

export interface NotificationConfig {
  channels: NotificationChannelItem[];
  routes: NotificationRouteItem[];
  deliveries: NotificationDeliveryItem[];
  summary: NotificationConfigSummary;
  updateTime: string;
}

export interface ObjectiveItem {
  objectiveId: string;
  name: string;
  enabled: boolean;
  targetType: ObjectiveTargetType;
  targetId?: string;
  metric: ObjectiveMetric;
  comparator: ObjectiveComparator;
  threshold: number;
  severity: SecuritySeverity;
  owner?: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  status: ObjectiveStatus;
  currentValue: number;
  evaluatedAt: string;
  evidence: string;
}

export interface ObjectiveQuery extends SecurityTimeFilter {
  objectiveId?: string;
  status?: ObjectiveStatus | "all";
  targetType?: ObjectiveTargetType | "all";
  targetId?: string;
  metric?: ObjectiveMetric | "all";
  q?: string;
  limit?: number;
}

export interface ObjectiveUpdateRequest {
  name?: string;
  enabled?: boolean;
  targetType?: ObjectiveTargetType;
  targetId?: string;
  metric?: ObjectiveMetric;
  comparator?: ObjectiveComparator;
  threshold?: number;
  severity?: SecuritySeverity;
  owner?: string;
  description?: string;
}

export interface ObjectiveSummary {
  totalObjectives: number;
  enabledObjectives: number;
  okObjectives: number;
  breachedObjectives: number;
  disabledObjectives: number;
  highSeverityBreaches: number;
}

export interface ObjectiveList {
  items: ObjectiveItem[];
  total: number;
  summary: ObjectiveSummary;
  updateTime: string;
}

export interface IngestionSourceItem {
  sourceId: string;
  name: string;
  type: IngestionSourceType;
  enabled: boolean;
  requireToken: boolean;
  tokenPreview?: string;
  tokenIssuedAt?: string;
  tokenRotationDueAt?: string;
  tokenRotationDays?: number;
  tokenAgeSecs?: number;
  tokenRotationStatus: SourceTokenRotationStatus;
  collectorId?: string;
  workspacePath?: string;
  owner?: string;
  team?: string;
  environment?: string;
  tags: string[];
  note?: string;
  discovered: boolean;
  createdAt: string;
  updatedAt: string;
  lastSeenAt?: string;
  lastSignalAt?: string;
  lastEventAt?: string;
  lastHeartbeatAt?: string;
  acceptedEvents: number;
  acceptedHeartbeats: number;
  rejectedEvents: number;
  lastResult?: "accepted" | "rejected";
  lastError?: string;
  status: IngestionSourceStatus;
  statusText: string;
  ageSecs?: number;
}

export interface IngestionSourceQuery {
  sourceId?: string;
  collectorId?: string;
  workspacePath?: string;
  status?: IngestionSourceStatus | "all";
  type?: IngestionSourceType | "all";
  includeVerification?: boolean;
  q?: string;
  limit?: number;
}

export interface IngestionSourceUpdateRequest {
  name?: string;
  type?: IngestionSourceType;
  enabled?: boolean;
  requireToken?: boolean;
  collectorId?: string;
  workspacePath?: string;
  owner?: string;
  team?: string;
  environment?: string;
  tags?: string[];
  note?: string;
  tokenRotationDays?: number;
}

export interface IngestionSourceMutationResult {
  source: IngestionSourceItem;
  token?: string;
}

export interface IngestionSourceCheckInRequest {
  sourceId?: string;
  sourceName?: string;
  sourceType?: IngestionSourceType;
  token?: string;
  collectorId?: string;
  workspacePath?: string;
  status?: "ok" | "error";
  message?: string;
}

export interface IngestionSourceCheckInAck {
  accepted: boolean;
  sourceId?: string;
  receivedAt: string;
  reason?: string;
}

export interface IngestionSourceSummary {
  totalSources: number;
  enabledSources: number;
  protectedSources: number;
  activeSources: number;
  staleSources: number;
  unusedSources: number;
  disabledSources: number;
  discoveredSources: number;
  tokenRotationOverdueSources: number;
  rejectedEvents: number;
}

export interface IngestionSourceList {
  items: IngestionSourceItem[];
  total: number;
  summary: IngestionSourceSummary;
  updateTime: string;
}

export type PolicySimulationChangeType =
  | "new_block"
  | "removed_block"
  | "new_escalation"
  | "removed_escalation"
  | "severity_increase"
  | "severity_decrease"
  | "verdict_changed";
export type RemediationStatus = "open" | "in_progress" | "blocked" | "done" | "dismissed";
export type RemediationSourceType = "incident" | "alert" | "coverage";
export type RemediationActionKind = "investigate" | "collector" | "source" | "policy" | "credential" | "network" | "file" | "ownership";

export interface PolicySimulationRequest extends SecurityTimeFilter {
  policy?: unknown;
  limit?: number;
}

export interface PolicySimulationDecision {
  verdict: SecurityVerdict;
  tier: "Rules" | "Llm" | "Agent";
  severity: SecuritySeverity;
  reason: string;
}

export interface PolicySimulationDiff {
  eventId: string;
  at: string;
  eventKind: string;
  subject: string;
  agentId: string;
  workspacePath: string;
  traceId: string;
  riskCategory: string;
  riskName: string;
  current: PolicySimulationDecision;
  simulated: PolicySimulationDecision;
  changeType: PolicySimulationChangeType;
}

export interface PolicySimulationGroup {
  key: string;
  eventCount: number;
  newBlocks: number;
  removedBlocks: number;
  newEscalations: number;
  maxSeverity: SecuritySeverity;
}

export interface PolicySimulationSummary {
  evaluatedEvents: number;
  skippedEvents: number;
  changedEvents: number;
  newBlocks: number;
  removedBlocks: number;
  newEscalations: number;
  removedEscalations: number;
  severityIncreases: number;
  severityDecreases: number;
  affectedAgents: number;
  affectedWorkspaces: number;
}

export interface PolicySimulationResult {
  summary: PolicySimulationSummary;
  diffs: PolicySimulationDiff[];
  byAgent: PolicySimulationGroup[];
  byWorkspace: PolicySimulationGroup[];
  sampling: {
    strategy: "latest_event_sample";
    sampleLimit: number;
    sampledEvents: number;
    truncated: boolean;
  };
  coverage: QueryCoverage;
  updateTime: string;
}

export interface RemediationStep {
  stepId: string;
  title: string;
  detail?: string;
  done: boolean;
}

export interface RemediationListItem {
  taskId: string;
  sourceType: RemediationSourceType;
  sourceId: string;
  status: RemediationStatus;
  severity: SecuritySeverity;
  actionKind: RemediationActionKind;
  title: string;
  description: string;
  recommendedAction: string;
  createdAt: string;
  updatedAt: string;
  dueAt?: string;
  owner?: string;
  note?: string;
  completedAt?: string;
  agentId?: string;
  workspacePath?: string;
  collectorId?: string;
  ingestionSourceId?: string;
  nodeName?: string;
  incidentId?: string;
  alertId?: string;
  eventId?: string;
  traceId?: string;
  steps: RemediationStep[];
  labels: Record<string, string>;
}

export interface RemediationQuery extends SecurityTimeFilter {
  includeBacklog?: boolean;
  taskId?: string;
  incidentId?: string;
  alertId?: string;
  eventId?: string;
  objectiveId?: string;
  issueId?: string;
  status?: RemediationStatus | "all";
  severity?: SecuritySeverity | "all";
  sourceType?: RemediationSourceType | "all";
  actionKind?: RemediationActionKind | "all";
  q?: string;
  workspacePath?: string;
  agentId?: string;
  collectorId?: string;
  sourceId?: string;
  limit?: number;
}

export interface RemediationSummary {
  totalTasks: number;
  activeTasks: number;
  openTasks: number;
  inProgressTasks: number;
  blockedTasks: number;
  doneTasks: number;
  dismissedTasks: number;
  overdueTasks: number;
  highPriorityTasks: number;
  incidentTasks: number;
  alertTasks: number;
  coverageTasks: number;
}

export interface RemediationList {
  items: RemediationListItem[];
  total: number;
  summary: RemediationSummary;
  updateTime: string;
}

export interface RemediationUpdateRequest {
  status?: RemediationStatus;
  owner?: string;
  note?: string;
  dueAt?: string;
  completedStepIds?: string[];
}

export interface PlatformUserItem {
  schemaVersion: "anysentry.platform_user.v1";
  userId: string;
  username: string;
  displayName: string;
  email?: string;
  team?: string;
  role: PlatformUserRole;
  status: PlatformUserStatus;
  source: PlatformUserSource;
  note?: string;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
}

export interface PlatformRoleDefinition {
  role: PlatformUserRole;
  label: string;
  description: string;
  permissions: string[];
  userCount: number;
}

export interface PlatformUserQuery {
  q?: string;
  role?: PlatformUserRole | "all";
  status?: PlatformUserStatus | "all";
  limit?: number;
}

export interface PlatformUserSummary {
  totalUsers: number;
  activeUsers: number;
  disabledUsers: number;
  administratorUsers: number;
}

export interface PlatformUserList {
  items: PlatformUserItem[];
  roles: PlatformRoleDefinition[];
  total: number;
  summary: PlatformUserSummary;
  authenticationRequired: false;
  authorizationEnforced: false;
  updateTime: string;
}

export interface PlatformUserUpdateRequest {
  username?: string;
  displayName?: string;
  email?: string;
  team?: string;
  role?: PlatformUserRole;
  status?: PlatformUserStatus;
  note?: string;
}

export interface AuditActor {
  type: AuditActorType;
  id: string;
  displayName?: string;
  sourceIp?: string;
  userAgent?: string;
}

export interface AuditListItem {
  schemaVersion: "anysentry.audit.v1";
  auditId: string;
  at: string;
  actor: AuditActor;
  action: AuditAction;
  resourceType: AuditResourceType;
  resourceId: string;
  summary: string;
  result: AuditResult;
  details: Record<string, unknown>;
}

export interface AuditQuery extends SecurityTimeFilter {
  auditId?: string;
  action?: AuditAction | "all";
  resourceType?: AuditResourceType | "all";
  resourceId?: string;
  actorId?: string;
  q?: string;
  limit?: number;
}

export interface AuditSummary {
  totalRecords: number;
  policyActions: number;
  agentActions: number;
  maintenanceActions: number;
  notificationActions: number;
  objectiveActions: number;
  sourceActions: number;
  userActions: number;
  incidentActions: number;
  alertActions: number;
  remediationActions: number;
  failureActions: number;
}

export interface AuditList {
  items: AuditListItem[];
  total: number;
  summary: AuditSummary;
  updateTime: string;
}

// ── Policy config (L1/L2/L3) ────────────────────────────────────────────────
// Mirrors the AnySentry sentry policy surface served by /security-center/config.
export type RuleKind = "ToolExec" | "Egress" | "Dns" | "FileAccess" | "SslContent" | "SecurityAction";
export type RuleAction = "" | "deny-exec" | "deny-egress" | "deny-file";
// Verdict/Severity reuse the existing SecurityVerdict/SecuritySeverity unions.

export interface L1Rule {
  name: string;
  on: RuleKind;
  match: string;
  verdict: SecurityVerdict;
  severity: SecuritySeverity;
  reason: string;
  action?: RuleAction;
}

export interface L2Config {
  url: string;
  model: string;
  timeoutS: number;
}

export interface DeepModelConfig extends L2Config {
  contextTokens: number;
}

export interface L3Config {
  bin: string;
  skills: string;
}

export interface IdentityJudgmentPolicy {
  candidatePipeline: "full" | "l1_only";
}

export interface PolicyConfig {
  failClosed: boolean;
  speculate: "off" | "low" | "medium" | "high";
  rules: L1Rule[];
  llm: L2Config | null;
  deepModel: DeepModelConfig | null;
  agent: L3Config | null;
  identity: IdentityJudgmentPolicy;
}

// A null tier (llm/agent) means "not configured".
export interface PolicyStatus {
  l1: boolean;
  l2: boolean;
  l3: boolean;
}

export interface PolicyConfigResponse {
  policy: PolicyConfig;
  status: PolicyStatus;
  connections: ModelConnectionStatuses;
}

export type ModelConnectionProfile = "fast_review" | "deep_investigation";
export type PolicyConnectivityStatus =
  | "connected"
  | "unauthorized"
  | "rate_limited"
  | "timeout"
  | "unreachable"
  | "invalid_response";

export interface PolicyConnectivityResult {
  schemaVersion: "anysentry.judgment_connectivity_result.v2";
  profile: ModelConnectionProfile;
  ok: boolean;
  status: PolicyConnectivityStatus;
  checkedAt: string;
  latencyMs: number;
  runtime: "api-a3s-code-sdk";
  endpoint: string;
  model: string;
  message: string;
  testToken?: string;
  expiresAt?: string;
}

export interface ModelConnectionStatus {
  profile: ModelConnectionProfile;
  state: "active" | "missing_credential";
  keyConfigured: boolean;
  callable: boolean;
  connectivityStatus?: PolicyConnectivityStatus;
  checkedAt?: string;
  latencyMs?: number;
  message?: string;
  source?: "runtime" | "environment";
  endpoint?: string;
  model?: string;
  timeoutS?: number;
  contextTokens?: number;
  appliedAt?: string;
  version?: string;
}

export interface ModelConnectionStatuses {
  fast_review: ModelConnectionStatus;
  deep_investigation: ModelConnectionStatus;
}

export interface ModelConnectionTestInput {
  profile: ModelConnectionProfile;
  url: string;
  model: string;
  apiKey: string;
  timeoutS: number;
  contextTokens: number;
}

export interface PlatformHealth {
  schemaVersion: "anysentry.health.v1";
  status: "ok";
  service: string;
  uptimeSeconds: number;
  storage: {
    mode: "clickhouse" | "memory";
    clickhouseConfigured: boolean;
    clickhouseReady: boolean;
  };
  managementAuth?: {
    enabled: boolean;
  };
  supplyChain?: {
    enabled: boolean;
  };
  events: {
    total: number;
    distinctAgents: number;
    distinctSessions: number;
  };
  historyFactCache?: {
    schemaVersion: "anysentry.history-cache.v1";
    caches: Array<{
      name: string;
      buckets: number;
      facts: number;
      estimatedBytes: number;
      evictions: number;
      budgetRejects: number;
      journalResets: number;
    }>;
    totals: {
      buckets: number;
      facts: number;
      estimatedBytes: number;
      evictions: number;
      budgetRejects: number;
      journalResets: number;
    };
  };
  dashboardBucketSnapshots?: {
    schemaVersion: "anysentry.dashboard-bucket-snapshots.v1";
    enabled: boolean;
    hits: number;
    misses: number;
    invalidated: number;
    exactRanges: number;
    writtenBuckets: number;
    fallbackErrors: number;
  };
  policy: PolicyStatus;
}

export const securityCenterApi = {
  healthz: (signal?: AbortSignal) =>
    apiClient.get<PlatformHealth>("/security-center/healthz", { signal }),
  platformMetrics: (range: SecurityTimeType = "last_1h") =>
    apiClient.get<PlatformMetricsOverview>(`/security-center/platform/metrics${querySuffix({ range })}`),
  assistantQuery: (body: SecurityAssistantQuery) =>
    apiClient.postLong<SecurityAssistantAnswer>("/security-center/assistant/query", body),
  healthCard: (filter: SecurityTimeFilter) =>
    apiClient.post<SecurityHealthCard>("/security-center/top/healthCard", filter),
  explainabilityScan: (filter: SecurityExplainabilityScanRequest) =>
    apiClient.post<SecurityExplainabilityScan>("/security-center/top/explainabilityScan", filter),
  performanceCard: (filter: SecurityTimeFilter) =>
    apiClient.post<SecurityPerformanceCard>("/security-center/top/performanceCard", filter),
  riskSummary: (filter: SecurityTimeFilter) =>
    apiClient.post<SecurityRiskSummary>("/security-center/risks/summary", filter),
  riskBreakdown: (filter: SecurityTimeFilter) =>
    apiClient.post<SecurityRiskBreakdown>("/security-center/risks/breakdown", filter),
  highestRiskSession: (filter: SecurityTimeFilter) =>
    apiClient.post<SecurityHighestRiskSession>("/security-center/sessions/highestRisk", filter),
  decisionFunnel: (filter: SecurityTimeFilter) =>
    apiClient.post<SecurityDecisionFunnel>("/security-center/sessions/decisionFunnel", filter),
  agentObservability: (filter: SecurityTimeFilter) =>
    apiClient.post<AgentObservability>("/security-center/sessions/agentObservability", filter),
  workspaceRiskDistribution: (filter: SecurityTimeFilter) =>
    apiClient.post<SecurityWorkspaceRiskDistribution>("/security-center/sessions/workspaceRiskDistribution", filter),
  agentEvents: (filter: AgentEventQuery, signal?: AbortSignal) =>
    apiClient.post<AgentEventList>("/security-center/events/list", filter, { signal }),
  runIdentityAiReview: (body: IdentityAiReviewRequest) =>
    apiClient.post<IdentityAiReviewRecord>("/security-center/identity/ai-review", body),
  identityAiReviews: (query: { targetType?: IdentityAiReviewTargetType; eventId?: string; agentAssetId?: string }) => {
    const params = new URLSearchParams();
    if (query.targetType) params.set("targetType", query.targetType);
    if (query.eventId) params.set("eventId", query.eventId);
    if (query.agentAssetId) params.set("agentAssetId", query.agentAssetId);
    return apiClient.get<IdentityAiReviewList>(`/security-center/identity/ai-reviews?${params.toString()}`);
  },
  agentTimeline: (filter: AgentEventQuery) =>
    apiClient.post<AgentTimeline>("/security-center/events/timeline", filter),
  streamFindings: (filter: SecurityTimeFilter & { limit?: number }) =>
    apiClient.post<StreamFindingList>("/security-center/stream/findings", filter),
  supplyChainOverview: (limit = 100) =>
    apiClient.get<SupplyChainOverview>(`/security-center/supply-chain/overview?limit=${limit}`),
  supplyChainConfig: () =>
    apiClient.get<SupplyChainControlResponse>("/security-center/supply-chain/config"),
  updateSupplyChainConfig: (body: Partial<SupplyChainControlConfig> & { runInitialScan?: boolean }) =>
    apiClient.put<SupplyChainControlResponse>("/security-center/supply-chain/config", body),
  scanSupplyChainWorkspace: (workspaceId: string) =>
    apiClient.post<{ task: SupplyChainScanTask }>(
      `/security-center/supply-chain/workspaces/${encodeURIComponent(workspaceId)}/scan`,
      { reason: "manual" },
    ),
  evidenceBundle: (filter: EvidenceBundleQuery) =>
    apiClient.post<EvidenceBundle>("/security-center/evidence/bundle", filter),
  evidenceExport: (filter: EvidenceBundleExportQuery) =>
    apiClient.post<EvidenceBundleExport>("/security-center/evidence/export", filter),
  ingestEvents: (body: UniversalIngestBody) =>
    apiClient.post<UniversalIngestResult>("/security-center/ingest/events", body),
  ingestEventsWithHeaders: (body: UniversalIngestBody, headers: HeadersInit) =>
    apiClient.postWithHeaders<UniversalIngestResult>("/security-center/ingest/events", body, headers),
  ingestOtel: (body: unknown) =>
    apiClient.post<UniversalIngestResult>("/security-center/ingest/otel", body),
  ingestOtlpLogs: (body: unknown) =>
    apiClient.post<UniversalIngestResult>("/security-center/ingest/otlp/v1/logs", body),
  ingestOtlpTraces: (body: unknown) =>
    apiClient.post<UniversalIngestResult>("/security-center/ingest/otlp/v1/traces", body),
  securityCapabilities: (query: Pick<SecurityCapabilityRequest, "action" | "category" | "query" | "module" | "operation" | "capabilityId" | "shaped"> = { action: "list" }) =>
    apiClient.get<SecurityCapabilityResponse | SecurityApiModule[] | SecurityApiModule | SecurityApiOperation[] | SecurityApiOperation>(
      `/security-center/capabilities${querySuffix({
        action: query.action,
        category: query.category,
        query: query.query,
        module: query.module,
        operation: query.operation,
        capabilityId: query.capabilityId,
        shaped: query.shaped,
      })}`,
    ),
  executeSecurityCapability: (body: SecurityCapabilityRequest) =>
    apiClient.post<SecurityCapabilityResponse | unknown>("/security-center/capabilities", body),
  runtimeGuard: (params: SecurityRuntimeGuardParams, body: Omit<SecurityCapabilityRequest, "action" | "module" | "operation" | "params"> = {}) =>
    apiClient.post<SecurityRuntimeGuardDecision | SecurityCapabilityDryRunResult | SecurityCapabilityResponse>("/security-center/capabilities", {
      ...body,
      action: "execute",
      module: "security-center",
      operation: "assessRuntimeAction",
      params,
    }),
  runtimeGuardWithHeaders: (
    params: SecurityRuntimeGuardParams,
    headers: HeadersInit,
    body: Omit<SecurityCapabilityRequest, "action" | "module" | "operation" | "params"> = {},
  ) =>
    apiClient.postWithHeaders<SecurityRuntimeGuardDecision | SecurityCapabilityDryRunResult | SecurityCapabilityResponse>(
      "/security-center/capabilities",
      {
        ...body,
        action: "execute",
        module: "security-center",
        operation: "assessRuntimeAction",
        params,
      },
      headers,
    ),
  nextActionPlan: (params: SecurityNextActionPlanParams, body: Omit<SecurityCapabilityRequest, "action" | "module" | "operation" | "params"> = {}) =>
    apiClient.post<SecurityNextActionPlan | SecurityCapabilityDryRunResult | SecurityCapabilityResponse>("/security-center/capabilities", {
      ...body,
      action: "execute",
      module: "security-center",
      operation: "planNextActions",
      params,
    }),
  evidenceBundleCapability: (params: EvidenceBundleQuery, body: Omit<SecurityCapabilityRequest, "action" | "module" | "operation" | "params"> = {}) =>
    apiClient.post<EvidenceBundle | SecurityCapabilityDryRunResult | SecurityCapabilityResponse>("/security-center/capabilities", {
      ...body,
      action: "execute",
      module: "security-center",
      operation: "buildEvidenceBundle",
      params,
    }),
  incidents: (filter: IncidentQuery) =>
    apiClient.post<IncidentList>("/security-center/incidents/list", filter),
  updateIncident: (incidentId: string, body: IncidentUpdateRequest) =>
    apiClient.put<IncidentListItem>(`/security-center/incidents/${encodeURIComponent(incidentId)}`, body),
  agentMetadata: () => apiClient.get<AgentMetadataList>("/security-center/agents/metadata"),
  updateAgentMetadata: (agentId: string, body: AgentMetadataUpdateRequest) =>
    apiClient.put<AgentMetadataListItem>(`/security-center/agents/${encodeURIComponent(agentId)}/metadata`, body),
  reviewAgent: (agentId: string, body: AgentReviewRequest) =>
    apiClient.put<AgentMetadataListItem>(`/security-center/agents/${encodeURIComponent(agentId)}/review`, body),
  alerts: (filter: AlertListQuery, signal?: AbortSignal) =>
    apiClient.post<AlertList>("/security-center/alerts/list", filter, { signal }),
  updateAlert: (alertId: string, body: AlertUpdateRequest) =>
    apiClient.put<AlertListItem>(`/security-center/alerts/${encodeURIComponent(alertId)}`, body),
  alertConfig: () => apiClient.get<AlertConfig>("/security-center/alerts/config"),
  notificationConfig: (filter: NotificationConfigQuery = {}) =>
    apiClient.get<NotificationConfig>(`/security-center/notifications/config${querySuffix(filter)}`),
  createNotificationChannel: (body: NotificationChannelUpdateRequest) =>
    apiClient.post<NotificationChannelItem>("/security-center/notifications/channels", body),
  updateNotificationChannel: (channelId: string, body: NotificationChannelUpdateRequest) =>
    apiClient.put<NotificationChannelItem>(`/security-center/notifications/channels/${encodeURIComponent(channelId)}`, body),
  createNotificationRoute: (body: NotificationRouteUpdateRequest) =>
    apiClient.post<NotificationRouteItem>("/security-center/notifications/routes", body),
  updateNotificationRoute: (routeId: string, body: NotificationRouteUpdateRequest) =>
    apiClient.put<NotificationRouteItem>(`/security-center/notifications/routes/${encodeURIComponent(routeId)}`, body),
  objectives: (filter: ObjectiveQuery) =>
    apiClient.post<ObjectiveList>("/security-center/objectives/list", filter),
  createObjective: (body: ObjectiveUpdateRequest) =>
    apiClient.post<ObjectiveItem>("/security-center/objectives", body),
  updateObjective: (objectiveId: string, body: ObjectiveUpdateRequest) =>
    apiClient.put<ObjectiveItem>(`/security-center/objectives/${encodeURIComponent(objectiveId)}`, body),
  platformUsers: (filter: PlatformUserQuery = {}) =>
    apiClient.post<PlatformUserList>("/security-center/users/list", filter),
  createPlatformUser: (body: PlatformUserUpdateRequest) =>
    apiClient.post<PlatformUserItem>("/security-center/users", body),
  updatePlatformUser: (userId: string, body: PlatformUserUpdateRequest) =>
    apiClient.put<PlatformUserItem>(`/security-center/users/${encodeURIComponent(userId)}`, body),
  ingestionSources: (filter: IngestionSourceQuery) =>
    apiClient.post<IngestionSourceList>("/security-center/sources/list", filter),
  createIngestionSource: (body: IngestionSourceUpdateRequest) =>
    apiClient.post<IngestionSourceMutationResult>("/security-center/sources", body),
  updateIngestionSource: (sourceId: string, body: IngestionSourceUpdateRequest) =>
    apiClient.put<IngestionSourceMutationResult>(`/security-center/sources/${encodeURIComponent(sourceId)}`, body),
  rotateIngestionSourceToken: (sourceId: string) =>
    apiClient.post<IngestionSourceMutationResult>(`/security-center/sources/${encodeURIComponent(sourceId)}/rotate-token`, {}),
  ingestionSourceCheckIn: (body: IngestionSourceCheckInRequest) =>
    apiClient.post<IngestionSourceCheckInAck>("/security-center/sources/check-in", body),
  remediations: (filter: RemediationQuery) =>
    apiClient.post<RemediationList>("/security-center/remediations/list", filter),
  updateRemediation: (taskId: string, body: RemediationUpdateRequest) =>
    apiClient.put<RemediationListItem>(`/security-center/remediations/${encodeURIComponent(taskId)}`, body),
  agentInventory: (filter: AgentInventoryQuery) =>
    apiClient.post<AgentInventory>("/security-center/agents/inventory", filter),
  agentInstanceMetrics: (filter: AgentInstanceMetricsQuery) =>
    apiClient.post<AgentInstanceMetrics>("/security-center/agents/instance-metrics", filter),
  workspaceInventory: (filter: WorkspaceInventoryQuery) =>
    apiClient.post<WorkspaceInventory>("/security-center/workspaces/inventory", filter),
  agentTopology: (filter: AgentTopologyQuery) =>
    apiClient.post<AgentTopology>("/security-center/agents/topology", filter),
  collectorHeartbeat: (body: CollectorHeartbeatRequest) =>
    apiClient.post<CollectorHeartbeatAck>("/security-center/collectors/heartbeat", body),
  collectorHealth: (filter: CollectorHealthQuery) =>
    apiClient.post<CollectorHealth>("/security-center/collectors/health", filter),
  coverageOverview: (filter: CoverageQuery) =>
    apiClient.post<CoverageOverview>("/security-center/coverage/overview", filter),
  maintenanceWindows: (filter: MaintenanceWindowQuery) =>
    apiClient.post<MaintenanceWindowList>("/security-center/maintenance/list", filter),
  createMaintenanceWindow: (body: MaintenanceWindowUpdateRequest) =>
    apiClient.post<MaintenanceWindowItem>("/security-center/maintenance/windows", body),
  updateMaintenanceWindow: (windowId: string, body: MaintenanceWindowUpdateRequest) =>
    apiClient.put<MaintenanceWindowItem>(`/security-center/maintenance/windows/${encodeURIComponent(windowId)}`, body),
  auditLog: (filter: AuditQuery, signal?: AbortSignal) =>
    apiClient.post<AuditList>("/security-center/audit/list", filter, { signal }),
  explainabilityHealth: () => apiClient.get<SecurityExplainabilityHealth>("/open/security/explainability/health"),
  explainabilityAudit: (body: SecurityExplainabilityAuditRequest) =>
    apiClient.post<SecurityExplainabilityAuditResult>("/open/security/explainability/audit", body),
  openExplainabilityScan: (filter: SecurityExplainabilityScanRequest) =>
    apiClient.post<SecurityExplainabilityScan>("/open/security/explainability/scan", filter),
  // Policy config: load current L1/L2/L3 policy and its tier status.
  getConfig: () => apiClient.get<PolicyConfigResponse>("/security-center/config"),
  // Persist a full or partial PolicyConfig; the server sanitizes + applies it
  // and returns the resulting policy + tier status.
  setConfig: (policy: Partial<PolicyConfig>) =>
    apiClient.put<PolicyConfigResponse>("/security-center/config", policy),
  testModelConnection: (input: ModelConnectionTestInput) =>
    apiClient.post<PolicyConnectivityResult>("/security-center/config/model-connections/test", input),
  applyModelConnection: (profile: ModelConnectionProfile, testToken: string) =>
    apiClient.put<PolicyConfigResponse>(`/security-center/config/model-connections/${profile}`, { testToken }),
  clearModelConnection: (profile: ModelConnectionProfile) =>
    apiClient.post<PolicyConfigResponse>(`/security-center/config/model-connections/${profile}/clear`, {}),
  simulateConfig: (body: PolicySimulationRequest) =>
    apiClient.post<PolicySimulationResult>("/security-center/config/simulate", body),
};

/**
 * 订阅智能体可观测性指标的 SSE 实时推送(服务端每 3s 推一帧,前端不轮询)。
 * 走 fetch + ReadableStream(apiRawFetch)。断线自动重连(退避≤5s);abort signal 关闭即停。
 * 每帧 `data:` JSON → onData。
 */
export function streamAgentObservability(
  filter: SecurityTimeFilter,
  onData: (data: AgentObservability) => void,
  signal: AbortSignal,
): void {
  const qs = new URLSearchParams();
  if (filter.timeType) qs.set("timeType", filter.timeType);
  if (filter.startTime) qs.set("startTime", filter.startTime);
  if (filter.endTime) qs.set("endTime", filter.endTime);
  if (filter.scope) qs.set("scope", filter.scope);
  const url = `/security-center/sessions/agentObservability/stream${qs.toString() ? `?${qs.toString()}` : ""}`;

  const consumeBlock = (block: string) => {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("");
    if (!data) return;
    try {
      const parsed = JSON.parse(data);
      // 服务端某一拍取数失败会推 { error: true };忽略,保留上一帧。
      if (parsed && typeof parsed === "object" && !("error" in parsed)) onData(parsed as AgentObservability);
    } catch {
      // 半帧 / 心跳行,忽略。
    }
  };

  const run = async () => {
    for (let attempt = 0; ; attempt += 1) {
      if (signal.aborted) return;
      try {
        const res = await apiRawFetch(url, { method: "GET", headers: { Accept: "text/event-stream" }, signal });
        if (res.ok && res.body) {
          attempt = 0; // 连上即重置退避
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          while (true) {
            const { value, done } = await reader.read();
            buffer += decoder.decode(value, { stream: !done });
            const blocks = buffer.split("\n\n");
            buffer = blocks.pop() ?? "";
            blocks.forEach(consumeBlock);
            if (done) break;
          }
        } else if (res.status >= 400 && res.status < 500) {
          return; // 4xx(鉴权/不存在)不会因重试恢复
        }
      } catch (error) {
        if ((error as Error)?.name === "AbortError") return;
      }
      if (signal.aborted) return;
      await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * (attempt + 1), 5000)));
    }
  };
  void run();
}
