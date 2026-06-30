import { apiClient, apiRawFetch } from "@/lib/api/client";

function querySuffix(params: Record<string, string | number | undefined>) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    const text = String(value ?? "").trim();
    if (text) qs.set(key, text);
  }
  return qs.toString() ? `?${qs.toString()}` : "";
}

export type SecurityTimeType = "last_3h" | "last_1d" | "last_7d" | "last_30d" | "custom";
export type SecurityRiskLevel = "safe" | "low" | "medium" | "high" | "critical" | "unknown" | string;
export type SecurityPolicyAction = "allow" | "review" | "block" | string;

export interface SecurityTimeFilter {
  timeType?: SecurityTimeType;
  startTime?: string;
  endTime?: string;
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
export type AgentEventCategory = "tool" | "network" | "file" | "llm" | "security" | "process" | "runtime" | "unknown";
export type AgentEventAttributeValue = string | number | boolean;
export type IncidentStatus = "open" | "acknowledged" | "resolved";
export type AgentHealthState = "active" | "idle" | "stale" | "risky";
export type AgentCriticality = "low" | "medium" | "high" | "critical";
export type CollectorHealthState = "healthy" | "quiet" | "degraded" | "stale" | "down";
export type CollectorReportedStatus = "ok" | "degraded" | "error";
export type AlertStatus = "open" | "acknowledged" | "resolved" | "silenced";
export type AlertKind = "incident" | "collector" | "agent" | "event" | "source" | "coverage" | "objective" | "remediation";
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
export type AuditActorType = "system" | "operator" | "api";
export type AuditAction =
  | "policy.updated"
  | "policy.simulated"
  | "incident.updated"
  | "alert.updated"
  | "remediation.updated"
  | "agent.metadata.updated"
  | "maintenance.window.updated"
  | "notification.channel.updated"
  | "notification.route.updated"
  | "notification.delivery_failed"
  | "objective.updated"
  | "source.updated"
  | "source.token_rotated";
export type AuditResourceType = "policy" | "incident" | "alert" | "remediation" | "agent" | "maintenance" | "notification" | "objective" | "source";
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
  eventId?: string;
  sourceId?: string;
  collectorId?: string;
  agentId?: string;
  sessionId?: string;
  workspacePath?: string;
  traceId?: string;
  runId?: string;
  eventKind?: string;
  eventCategory?: AgentEventCategory;
  verdict?: SecurityVerdict;
  limit?: number;
}

export interface AgentEventListItem {
  schemaVersion: "anysentry.agent_event.v1";
  eventId: string;
  at: string;
  eventKind: string;
  eventCategory: AgentEventCategory;
  source: AgentEventSource;
  subject: string;
  workspacePath: string;
  agentId: string;
  collectorId?: string;
  sourceId?: string;
  sessionId: string;
  userId: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  runId: string;
  taskId?: string;
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
  rawPreview?: string;
}

export interface AgentEventList {
  items: AgentEventListItem[];
  total: number;
  updateTime: string;
}

export interface AgentTimeline {
  traceId: string;
  runId?: string;
  sessionId?: string;
  items: AgentEventListItem[];
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
  source?: AgentEventSource;
  eventCategory?: AgentEventCategory;
  subject?: string;
  tokenCount?: number;
  latencyMs?: number;
  attributes?: Record<string, unknown>;
  rawPreview?: string;
  collectorId?: string;
  sourceId?: string;
  nodeName?: string;
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

export type SecurityCapabilityAction = "list" | "search" | "describe" | "execute" | "poll" | "subscribe" | "approve";
export type SecurityCapabilityTier = "L0" | "L1" | "L2" | "L3" | "L4" | "L5";
export type SecurityCapabilityAutonomy = "suggest" | "guarded" | "auto";
export type SecurityCapabilityStage = "input" | "plan" | "tool" | "retrieval" | "memory" | "llm" | "output" | "feedback" | "runtime";
export type SecurityCapabilityPolicyAction = "allow" | "warn" | "require_approval" | "block";
export type SecurityCapabilityRunStatus = "queued" | "running" | "needs_approval" | "completed" | "failed" | "cancelled" | "expired";

export interface SecurityCapabilitySchemaRef {
  $id: string;
  integrity: string;
}

export interface SecurityCapabilityOperation {
  operation: string;
  summary: string;
  inputSchemaRef: SecurityCapabilitySchemaRef;
  outputSchemaRef: SecurityCapabilitySchemaRef;
  async: boolean;
}

export interface SecurityCapabilitySummary {
  capabilityId: string;
  name: string;
  version: string;
  tier: SecurityCapabilityTier;
  category: string;
  vendorId?: string;
}

export interface SecurityCapabilityManifest extends SecurityCapabilitySummary {
  modes: string[];
  requires: Record<string, boolean>;
  dataPolicy: Record<string, string | boolean>;
  executionLocale: "local-anysentry" | "customer-vpc" | "on-prem" | "vendor-sandbox" | "tee-enclave";
  operations: SecurityCapabilityOperation[];
}

export interface SecurityCapabilityEngagement {
  engagementId?: string;
  customerId?: string;
  tenantId?: string;
  allowedTargets?: string[];
  forbiddenTargets?: string[];
  allowedModes?: string[];
  expiresAt?: string;
  approvalToken?: string;
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
  tier?: SecurityCapabilityTier | string;
  query?: string;
  capabilityId?: string;
  operation?: string;
  params?: Record<string, unknown>;
  engagement?: SecurityCapabilityEngagement;
  constraints?: SecurityCapabilityConstraints;
  dryRun?: boolean;
  runId?: string;
  decision?: "approve" | "reject" | string;
  approver?: string;
  approvalToken?: string;
  note?: string;
}

export interface SecurityRuntimeGuardDecision {
  schemaVersion: "anysentry.acp.runtime_guard.result.v1";
  capabilityId: "security.runtimeGuard";
  operation: "assessAction";
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

export interface SecurityCapabilityResponse {
  schemaVersion: "anysentry.acp.response.v1";
  protocol: "acp/0.1-compatible";
  action: SecurityCapabilityAction;
  capabilities?: SecurityCapabilitySummary[];
  capability?: SecurityCapabilityManifest;
  operations?: SecurityCapabilityOperation[];
  result?: unknown;
  runId?: string;
  status?: SecurityCapabilityRunStatus | "not_required" | "available";
  eventStream?: {
    endpoint: string;
    note: string;
  };
  compatibility?: {
    shuanOsProgressiveApi: string;
    supportedActions: SecurityCapabilityAction[];
    riskTiers: SecurityCapabilityTier[];
    auth: {
      implemented: string[];
      planned: string[];
    };
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
  workspacePath?: string;
  userId?: string;
  limit?: number;
}

export interface AgentInventoryItem {
  agentId: string;
  workspacePath: string;
  userId: string;
  displayName?: string;
  owner?: string;
  team?: string;
  environment?: string;
  criticality?: AgentCriticality;
  tags: string[];
  note?: string;
  metadataUpdatedAt?: string;
  firstSeen: string;
  lastSeen: string;
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
  workspacePath: string;
  displayName?: string;
  owner?: string;
  team?: string;
  environment?: string;
  criticality?: AgentCriticality;
  tags: string[];
  note?: string;
  updatedAt: string;
}

export interface AgentMetadataList {
  items: AgentMetadataListItem[];
  updateTime: string;
}

export interface AgentMetadataUpdateRequest {
  workspacePath: string;
  displayName?: string;
  owner?: string;
  team?: string;
  environment?: string;
  criticality?: AgentCriticality | "";
  tags?: string[];
  note?: string;
}

export interface AgentInventory {
  items: AgentInventoryItem[];
  total: number;
  summary: AgentInventorySummary;
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
  edgeId?: string;
  eventId?: string;
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
  agentId?: string;
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
  message?: string;
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
  lastNotificationAt?: string;
  labels: Record<string, string>;
}

export interface AlertListQuery extends SecurityTimeFilter {
  alertId?: string;
  status?: AlertStatus | "all";
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
  incidentAlerts: number;
  collectorAlerts: number;
  agentAlerts: number;
  eventAlerts: number;
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

export interface L3Config {
  bin: string;
  skills: string;
}

export interface PolicyConfig {
  failClosed: boolean;
  speculate: "off" | "low" | "medium" | "high";
  rules: L1Rule[];
  llm: L2Config | null;
  agent: L3Config | null;
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
  events: {
    total: number;
    distinctAgents: number;
    distinctSessions: number;
  };
  policy: PolicyStatus;
}

export const securityCenterApi = {
  healthz: () => apiClient.get<PlatformHealth>("/security-center/healthz"),
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
  agentEvents: (filter: AgentEventQuery) =>
    apiClient.post<AgentEventList>("/security-center/events/list", filter),
  agentTimeline: (filter: AgentEventQuery) =>
    apiClient.post<AgentTimeline>("/security-center/events/timeline", filter),
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
  securityCapabilities: (query: Pick<SecurityCapabilityRequest, "action" | "category" | "tier" | "query" | "capabilityId" | "runId"> = { action: "list" }) =>
    apiClient.get<SecurityCapabilityResponse>(
      `/security-center/capabilities${querySuffix({
        action: query.action,
        category: query.category,
        tier: query.tier,
        query: query.query,
        capabilityId: query.capabilityId,
        runId: query.runId,
      })}`,
    ),
  executeSecurityCapability: (body: SecurityCapabilityRequest) =>
    apiClient.post<SecurityCapabilityResponse>("/security-center/capabilities", body),
  runtimeGuard: (params: SecurityRuntimeGuardParams, body: Omit<SecurityCapabilityRequest, "action" | "capabilityId" | "operation" | "params"> = {}) =>
    apiClient.post<SecurityCapabilityResponse>("/security-center/capabilities", {
      ...body,
      action: "execute",
      capabilityId: "security.runtimeGuard",
      operation: "assessAction",
      params,
    }),
  runtimeGuardWithHeaders: (
    params: SecurityRuntimeGuardParams,
    headers: HeadersInit,
    body: Omit<SecurityCapabilityRequest, "action" | "capabilityId" | "operation" | "params"> = {},
  ) =>
    apiClient.postWithHeaders<SecurityCapabilityResponse>(
      "/security-center/capabilities",
      {
        ...body,
        action: "execute",
        capabilityId: "security.runtimeGuard",
        operation: "assessAction",
        params,
      },
      headers,
    ),
  incidents: (filter: IncidentQuery) =>
    apiClient.post<IncidentList>("/security-center/incidents/list", filter),
  updateIncident: (incidentId: string, body: IncidentUpdateRequest) =>
    apiClient.put<IncidentListItem>(`/security-center/incidents/${encodeURIComponent(incidentId)}`, body),
  agentMetadata: () => apiClient.get<AgentMetadataList>("/security-center/agents/metadata"),
  updateAgentMetadata: (agentId: string, body: AgentMetadataUpdateRequest) =>
    apiClient.put<AgentMetadataListItem>(`/security-center/agents/${encodeURIComponent(agentId)}/metadata`, body),
  alerts: (filter: AlertListQuery) =>
    apiClient.post<AlertList>("/security-center/alerts/list", filter),
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
  auditLog: (filter: AuditQuery) =>
    apiClient.post<AuditList>("/security-center/audit/list", filter),
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
