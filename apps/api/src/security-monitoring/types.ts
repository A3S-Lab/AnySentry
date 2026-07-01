// Shapes shared by the judge, the aggregator, and the controller.
// Response shapes match the dashboard's API contract; every value is computed from live
// @a3s-lab/sentry judgments.

export interface SecurityTimeFilter {
  timeType?: 'last_3h' | 'last_1d' | 'last_7d' | 'last_30d' | 'custom';
  startTime?: string;
  endTime?: string;
}
export interface ExplainabilityScanRequest extends SecurityTimeFilter {
  seriesPoints?: number;
}

export type Verdict = 'allow' | 'block' | 'escalate';
export type Tier = 'Rules' | 'Llm' | 'Agent';
export type Severity = 'info' | 'low' | 'medium' | 'high' | 'critical';
export type RiskType = 'system' | 'communication' | 'atomic';
export type EventSource = 'observer' | 'synthetic' | 'api';
export type EventCategory = 'tool' | 'network' | 'file' | 'llm' | 'security' | 'process' | 'runtime' | 'unknown';
export type EventAttributeValue = string | number | boolean;
export type IncidentStatus = 'open' | 'acknowledged' | 'resolved';
export type AgentHealthState = 'active' | 'idle' | 'stale' | 'risky';
export type AgentCriticality = 'low' | 'medium' | 'high' | 'critical';
export type CollectorHealthState = 'healthy' | 'quiet' | 'degraded' | 'stale' | 'down';
export type CollectorReportedStatus = 'ok' | 'degraded' | 'error';
export type AlertStatus = 'open' | 'acknowledged' | 'resolved' | 'silenced';
export type AlertKind = 'incident' | 'collector' | 'agent' | 'event' | 'source' | 'coverage' | 'objective' | 'remediation';
export type TopologyNodeType = 'agent' | 'workspace' | 'collector' | 'tool' | 'network' | 'file' | 'llm' | 'security';
export type TopologyEdgeType = 'runs_in' | 'observed_by' | 'executes' | 'connects' | 'resolves' | 'accesses' | 'calls_llm' | 'triggers';
export type MaintenanceTargetType = 'all' | 'workspace' | 'agent' | 'collector' | 'source';
export type MaintenanceStatus = 'active' | 'scheduled' | 'expired' | 'disabled';
export type NotificationChannelType = 'webhook';
export type NotificationDeliveryStatus = 'ok' | 'error' | 'not_sent';
export type ObjectiveTargetType = 'global' | 'workspace' | 'agent' | 'collector' | 'source';
export type ObjectiveMetric = 'coverage_score' | 'open_incidents' | 'active_alerts' | 'overdue_remediations' | 'risky_events' | 'stale_agents' | 'collector_down' | 'source_down';
export type ObjectiveComparator = 'lte' | 'gte';
export type ObjectiveStatus = 'ok' | 'breach' | 'disabled';
export type IngestionSourceType = 'observer' | 'forwarder' | 'webhook' | 'otel' | 'custom';
export type IngestionSourceStatus = 'active' | 'stale' | 'unused' | 'disabled';
export type SourceTokenRotationStatus = 'untracked' | 'fresh' | 'overdue';
export type CoverageIssueType =
  | 'collector_down'
  | 'collector_stale'
  | 'collector_degraded'
  | 'collector_quiet'
  | 'agent_stale'
  | 'agent_uncovered'
  | 'workspace_quiet'
  | 'missing_collector_heartbeat'
  | 'source_unused'
  | 'source_stale'
  | 'source_rejected'
  | 'source_token_rotation_due';

/** One judged event: a sentry Decision joined with the event's source metadata. */
export interface JudgedEvent {
  schemaVersion: 'anysentry.agent_event.v1';
  eventId: string;
  at: number; // epoch ms
  eventKind: string; // ToolExec | Egress | FileAccess | Dns | SslContent | SecurityAction
  eventCategory: EventCategory;
  source: EventSource;
  subject: string; // human summary of the event
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
  verdict: Verdict;
  tier: Tier;
  severity: Severity;
  reason: string;
  actionKind?: string; // DenyEgress | DenyFile | DenyExec
  actionTarget?: string;
  riskCategory: string; // command_danger | data_leak | prompt_injection | ...
  riskName: string; // human label for the category
  riskType: RiskType;
  riskScore: number; // 0-100
  tokenCount: number;
  latencyMs: number;
  attributes: Record<string, EventAttributeValue>;
  rawPreview?: string;
}

export interface EventMeta {
  workspacePath: string;
  agentId: string;
  sessionId: string;
  userId: string;
  source?: EventSource;
  eventCategory?: EventCategory;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  runId?: string;
  taskId?: string;
  attributes?: Record<string, EventAttributeValue>;
  rawPreview?: string;
  tokenCount?: number;
  latencyMs?: number;
  subject?: string;
  eventKind?: string;
}

export interface UniversalIngestEvent extends Partial<EventMeta> {
  at?: string | number;
  timestamp?: string | number;
  kind?: string;
  category?: EventCategory;
  collectorId?: string;
  nodeName?: string;
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
  raw?: unknown;
}
export interface UniversalIngestRequest extends Partial<EventMeta> {
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
  collectorId?: string;
  sourceId?: string;
  nodeName?: string;
  sourceName?: string;
  sourceType?: IngestionSourceType;
  token?: string;
}
export type UniversalIngestBody = UniversalIngestRequest | Array<UniversalIngestRequest & Record<string, unknown>>;
export interface UniversalIngestResultItem {
  index: number;
  accepted: boolean;
  reason?: string;
  eventId?: string;
  traceId?: string;
  spanId?: string;
  runId?: string;
  verdict?: Verdict;
  tier?: Tier;
  severity?: Severity;
  riskCategory?: string;
}
export interface UniversalIngestResult {
  accepted: boolean;
  sourceId?: string;
  acceptedEvents: number;
  rejectedEvents: number;
  items: UniversalIngestResultItem[];
}

export type SecurityCapabilityAction = 'list' | 'search' | 'describe' | 'execute';
export type SecurityCapabilityAutonomy = 'suggest' | 'guarded' | 'auto';
export type SecurityCapabilityStage = 'input' | 'plan' | 'tool' | 'retrieval' | 'memory' | 'llm' | 'output' | 'feedback' | 'runtime';
export type SecurityCapabilityPolicyAction = 'allow' | 'warn' | 'require_approval' | 'block';

export type SecurityApiOperationAction =
  | 'list'
  | 'get'
  | 'create'
  | 'update'
  | 'delete'
  | 'execute'
  | 'download'
  | 'stream'
  | 'unknown';

export interface SecurityApiParameter {
  name: string;
  in?: 'path' | 'query' | 'header' | 'body';
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
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
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
  relatedOperations?: Array<Pick<SecurityApiOperation, 'name' | 'method' | 'path' | 'action'>>;
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
  maxRiskLevel?: Severity | 'medium' | 'high' | 'critical';
  autonomy?: SecurityCapabilityAutonomy;
}
export interface SecurityRuntimeGuardParams extends Partial<EventMeta> {
  autonomy?: SecurityCapabilityAutonomy;
  stage?: SecurityCapabilityStage | string;
  action?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown> | string;
  command?: string[] | string;
  target?: string;
  resource?: string;
  input?: string;
  prompt?: string;
  output?: string;
  model?: string;
  labels?: Record<string, EventAttributeValue>;
  evidence?: Record<string, unknown>;
  collectorId?: string;
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
  severity: 'error' | 'warning';
}
export interface SecurityCapabilityDryRunResult {
  schemaVersion: 'anysentry.progressive.dry_run.v1';
  valid: boolean;
  dryRun: true;
  module: string;
  operation: string;
  targetInScope: boolean;
  tokenVerified: boolean;
  decision: 'allow' | 'reject';
  constraints: SecurityCapabilityConstraints;
  schemaValid: boolean;
  schemaIssues: SecurityCapabilitySchemaIssue[];
  normalizedRequest: {
    action: 'execute';
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
  schemaVersion: 'anysentry.progressive.runtime_guard.result.v1';
  module: 'security-center';
  operation: 'assessRuntimeAction';
  /** Legacy alias for callers that still correlate old capabilityId-shaped decisions. */
  capabilityId?: 'security.runtimeGuard';
  autonomy: SecurityCapabilityAutonomy;
  stage: SecurityCapabilityStage;
  policyAction: SecurityCapabilityPolicyAction;
  recommendedAction: 'continue' | 'review' | 'stop';
  accepted: boolean;
  sourceId?: string;
  eventId?: string;
  traceId?: string;
  runId?: string;
  verdict?: Verdict;
  tier?: Tier;
  severity?: Severity;
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
  priority: 'critical' | 'high' | 'medium' | 'low';
  status: RemediationStatus;
  severity: Severity;
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
  schemaVersion: 'anysentry.progressive.next_action_plan.v1';
  module: 'security-center';
  operation: 'planNextActions';
  generatedAt: string;
  scope: {
    timeType?: SecurityTimeFilter['timeType'];
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
  schemaVersion: 'anysentry.progressive.response.v1';
  protocol: 'shuanos-progressive-api/source-compatible';
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
    sourceImplementation: 'os/apps/api/src/modules/kernel';
    dispatch: 'module + operation + params';
    supportedActions: SecurityCapabilityAction[];
    shapedOptIn: boolean;
    legacyCapabilityAliases: Record<string, { module: string; operation: string }>;
  };
}

// ---- Response DTOs (identical field names to the frontend) ----

export interface SecurityHealthCard {
  healthScore: number;
  healthStatusText: string;
  tokenConsumptionTotal: number;
  tokenConsumptionUnit: string;
}
export interface WaveSeriesPoint {
  statTime: string;
  value: number;
  activationCount: number;
}
export interface SecurityExplainabilityScan {
  waveSeries: Array<{ safeSeries: WaveSeriesPoint[]; riskSeries: WaveSeriesPoint[] }>;
  threatInterception: string;
  sessionActiveCount: string;
  updateTime: string;
}
export interface SecurityPerformanceCard {
  componentRequestCount: { current: number; peak: number; avg: number };
  tps: { current: number; peak: number; avg: number };
  avgLatency: { value: number; unit: string };
  updateTime: string;
}
export interface SecurityRiskSummary {
  summaryCards: Array<{ riskTypeCode: string; riskTypeName: string; eventCount: number }>;
  updateTime: string;
}
export interface RiskCategory {
  totalCount: number;
  displayColor?: string;
  items: Array<{ riskCode: string; riskName: string; eventCount: number; changeRate: number }>;
}
export interface SecurityRiskBreakdown {
  systemRisks: RiskCategory;
  communicationRisks: RiskCategory;
  singleAgentRisks: RiskCategory;
  updateTime: string;
}
export interface SecurityHighestRiskSession {
  sessionId: string;
  userId: string;
  workspacePath: string;
  riskLevel: string;
  riskLevelText: string;
  compositeScore: number;
  lastEventTime: string;
  riskDimensions: Array<{ dimensionCode: string; dimensionName: string; score: number }>;
  updateTime: string;
}
export interface SecurityDecisionFunnel {
  tiers: Array<{ tierCode: string; tierName: string; count: number; percentage: number; slaDesc: string }>;
  finalBlock: { count: number; percentage: number };
  updateTime: string;
}
export interface AgentObservability {
  health: { heartbeatOk: boolean; resourceUtil: number; errorRate: number; decisionLatencyMs: number };
  behavioral: { actionRate: number; decisionPattern: 'baseline' | 'drift'; stateTransitions: number; goalProgress: number };
  system: { agentCount: number; commThroughput: number; infraHealthy: boolean };
  updateTime: string;
}
export interface SecurityWorkspaceRiskDistribution {
  list: Array<{ workspacePath: string; sessionCount: number; totalRiskScore: number; riskLevel: string; riskLevelText: string }>;
  updateTime: string;
}

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
  eventCategory?: EventCategory;
  verdict?: Verdict;
  limit?: number;
}
export interface AgentEventListItem {
  schemaVersion: 'anysentry.agent_event.v1';
  eventId: string;
  at: string;
  eventKind: string;
  eventCategory: EventCategory;
  source: EventSource;
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
  verdict: Verdict;
  tier: Tier;
  severity: Severity;
  reason: string;
  riskCategory: string;
  riskName: string;
  riskType: RiskType;
  riskScore: number;
  tokenCount: number;
  latencyMs: number;
  attributes: Record<string, EventAttributeValue>;
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

export type EvidenceBundlePrimaryType = 'event' | 'incident' | 'alert' | 'remediation' | 'objective' | 'coverage' | 'notification' | 'maintenance' | 'audit' | 'topology' | 'scope';
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
  maxSeverity?: Severity;
  riskCategories: EvidenceBundleRiskCategory[];
}
export interface EvidenceBundle {
  schemaVersion: 'anysentry.evidence_bundle.v1';
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
export type EvidenceBundleExportFormat = 'markdown';
export interface EvidenceBundleExportQuery extends EvidenceBundleQuery {
  format?: EvidenceBundleExportFormat;
}
export interface EvidenceBundleExport {
  schemaVersion: 'anysentry.evidence_export.v1';
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

export interface Incident {
  incidentId: string;
  status: IncidentStatus;
  severity: Severity;
  title: string;
  description: string;
  openedAt: number;
  updatedAt: number;
  acknowledgedAt?: number;
  resolvedAt?: number;
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
  riskType: RiskType;
  eventCount: number;
  lastEventId: string;
  lastEventAt: number;
  lastEventSubject: string;
  maxRiskScore: number;
}
export interface IncidentListItem extends Omit<Incident, 'openedAt' | 'updatedAt' | 'acknowledgedAt' | 'resolvedAt'> {
  openedAt: string;
  updatedAt: string;
  acknowledgedAt?: string;
  resolvedAt?: string;
}
export interface IncidentQuery extends SecurityTimeFilter {
  incidentId?: string;
  status?: IncidentStatus | 'all';
  severity?: Severity | 'all';
  workspacePath?: string;
  agentId?: string;
  collectorId?: string;
  sourceId?: string;
  sessionId?: string;
  traceId?: string;
  limit?: number;
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
  healthState?: AgentHealthState | 'all';
  criticality?: AgentCriticality | 'all';
  owner?: string;
  environment?: string;
  tag?: string;
  q?: string;
  agentId?: string;
  workspacePath?: string;
  userId?: string;
  limit?: number;
}
export interface AgentMetadataRecord {
  agentId: string;
  workspacePath: string;
  displayName?: string;
  owner?: string;
  team?: string;
  environment?: string;
  criticality?: AgentCriticality;
  tags: string[];
  note?: string;
  updatedAt: number;
}
export interface AgentMetadataListItem extends Omit<AgentMetadataRecord, 'updatedAt'> {
  updatedAt: string;
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
  riskLevel: string;
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
  eventCategoryCounts: Record<EventCategory, number>;
  sourceCounts: Record<EventSource, number>;
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
export interface AgentInventory {
  items: AgentInventoryItem[];
  total: number;
  summary: AgentInventorySummary;
  updateTime: string;
}

export interface WorkspaceInventoryQuery extends SecurityTimeFilter {
  healthState?: AgentHealthState | 'all';
  criticality?: AgentCriticality | 'all';
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
  riskLevel: string;
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
export interface AgentMetadataUpdateRequest {
  workspacePath: string;
  displayName?: string;
  owner?: string;
  team?: string;
  environment?: string;
  criticality?: AgentCriticality | '';
  tags?: string[];
  note?: string;
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
  riskLevel: string;
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
  maxSeverity: Severity;
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
export interface CollectorHeartbeatRecord extends Required<Pick<CollectorHeartbeatRequest, 'collectorId' | 'status'>> {
  at: number;
  nodeName?: string;
  namespace?: string;
  podName?: string;
  version?: string;
  mode?: string;
  attachedProbes: number;
  enabledFeatures: string[];
  intervalSecs: number;
  eventKindCounts: Record<string, number>;
  queueDepth: number;
  droppedEvents: number;
  outputDropped: number;
  errorCount: number;
  observedAgents: number;
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
  state?: CollectorHealthState | 'all';
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
  eventCategoryCounts: Record<EventCategory, number>;
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
  severity?: Severity | 'all';
  type?: CoverageIssueType | 'all';
  q?: string;
  limit?: number;
}
export interface CoverageIssue {
  issueId: string;
  type: CoverageIssueType;
  severity: Severity;
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

export interface MaintenanceWindowRecord {
  windowId: string;
  title: string;
  targetType: MaintenanceTargetType;
  targetId: string;
  startAt: number;
  endAt: number;
  enabled: boolean;
  reason?: string;
  owner?: string;
  note?: string;
  labels: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}
export interface MaintenanceWindowItem extends Omit<MaintenanceWindowRecord, 'startAt' | 'endAt' | 'createdAt' | 'updatedAt'> {
  startAt: string;
  endAt: string;
  createdAt: string;
  updatedAt: string;
  status: MaintenanceStatus;
}
export interface MaintenanceWindowQuery extends SecurityTimeFilter {
  windowId?: string;
  status?: MaintenanceStatus | 'all';
  targetType?: MaintenanceTargetType | 'all';
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
  severity: Severity;
  cooldownSecs: number;
  description: string;
}
export interface AlertRecord {
  alertId: string;
  dedupeKey: string;
  ruleId: string;
  kind: AlertKind;
  status: AlertStatus;
  severity: Severity;
  title: string;
  description: string;
  firstSeenAt: number;
  lastSeenAt: number;
  updatedAt: number;
  acknowledgedAt?: number;
  resolvedAt?: number;
  silencedUntil?: number;
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
  lastNotificationAt?: number;
  labels: Record<string, string>;
}
export interface AlertListItem extends Omit<AlertRecord, 'firstSeenAt' | 'lastSeenAt' | 'updatedAt' | 'acknowledgedAt' | 'resolvedAt' | 'silencedUntil' | 'lastNotificationAt'> {
  firstSeenAt: string;
  lastSeenAt: string;
  updatedAt: string;
  acknowledgedAt?: string;
  resolvedAt?: string;
  silencedUntil?: string;
  lastNotificationAt?: string;
}
export interface AlertListQuery extends SecurityTimeFilter {
  alertId?: string;
  status?: AlertStatus | 'all';
  severity?: Severity | 'all';
  kind?: AlertKind | 'all';
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
  incidentMinSeverity: Severity;
  eventMinSeverity: Severity;
  agentOpenIncidentThreshold: number;
  collectorStaleAfterSecs: number;
  collectorDownAfterSecs: number;
  sourceStaleAfterSecs: number;
  sourceDownAfterSecs: number;
}

export interface NotificationChannelRecord {
  channelId: string;
  name: string;
  type: NotificationChannelType;
  enabled: boolean;
  webhookUrl?: string;
  description?: string;
  labels: Record<string, string>;
  createdAt: number;
  updatedAt: number;
  lastSentAt?: number;
  lastStatus?: NotificationDeliveryStatus;
  lastError?: string;
}
export interface NotificationChannelItem extends Omit<NotificationChannelRecord, 'webhookUrl' | 'createdAt' | 'updatedAt' | 'lastSentAt'> {
  endpointPreview?: string;
  readOnly?: boolean;
  createdAt: string;
  updatedAt: string;
  lastSentAt?: string;
}
export interface NotificationRouteRecord {
  routeId: string;
  name: string;
  enabled: boolean;
  channelIds: string[];
  minSeverity?: Severity;
  kinds: AlertKind[];
  workspacePath?: string;
  agentId?: string;
  collectorId?: string;
  sourceId?: string;
  owner?: string;
  team?: string;
  q?: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
}
export interface NotificationRouteItem extends Omit<NotificationRouteRecord, 'createdAt' | 'updatedAt'> {
  createdAt: string;
  updatedAt: string;
}
export type NotificationDeliveryAction = 'opened' | 'reopened' | 'resolved';
export interface NotificationDeliveryRecord {
  deliveryId: string;
  alertId: string;
  alertRuleId: string;
  alertKind: AlertKind;
  alertSeverity: Severity;
  alertTitle: string;
  channelId: string;
  channelName: string;
  routeId?: string;
  routeName?: string;
  action: NotificationDeliveryAction;
  status: NotificationDeliveryStatus;
  sentAt: number;
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
export interface NotificationDeliveryItem extends Omit<NotificationDeliveryRecord, 'sentAt'> {
  sentAt: string;
}
export interface NotificationState {
  channels: NotificationChannelRecord[];
  routes: NotificationRouteRecord[];
  deliveries?: NotificationDeliveryRecord[];
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
  minSeverity?: Severity | '';
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
  kind?: AlertKind | 'all';
  minSeverity?: Severity | 'all';
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

export interface ObjectiveRecord {
  objectiveId: string;
  name: string;
  enabled: boolean;
  targetType: ObjectiveTargetType;
  targetId?: string;
  metric: ObjectiveMetric;
  comparator: ObjectiveComparator;
  threshold: number;
  severity: Severity;
  owner?: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
}
export interface ObjectiveItem extends Omit<ObjectiveRecord, 'createdAt' | 'updatedAt'> {
  createdAt: string;
  updatedAt: string;
  status: ObjectiveStatus;
  currentValue: number;
  evaluatedAt: string;
  evidence: string;
}
export interface ObjectiveQuery extends SecurityTimeFilter {
  objectiveId?: string;
  status?: ObjectiveStatus | 'all';
  targetType?: ObjectiveTargetType | 'all';
  targetId?: string;
  metric?: ObjectiveMetric | 'all';
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
  severity?: Severity;
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

export interface IngestionSourceRecord {
  sourceId: string;
  name: string;
  type: IngestionSourceType;
  enabled: boolean;
  requireToken: boolean;
  tokenHash?: string;
  tokenPreview?: string;
  tokenIssuedAt?: number;
  tokenRotationDays?: number;
  collectorId?: string;
  workspacePath?: string;
  owner?: string;
  team?: string;
  environment?: string;
  tags: string[];
  note?: string;
  discovered: boolean;
  createdAt: number;
  updatedAt: number;
  lastSeenAt?: number;
  lastEventAt?: number;
  lastHeartbeatAt?: number;
  acceptedEvents: number;
  acceptedHeartbeats: number;
  rejectedEvents: number;
  lastResult?: 'accepted' | 'rejected';
  lastError?: string;
}
export interface IngestionSourceItem extends Omit<IngestionSourceRecord, 'createdAt' | 'updatedAt' | 'lastSeenAt' | 'lastEventAt' | 'lastHeartbeatAt' | 'tokenHash' | 'tokenIssuedAt'> {
  createdAt: string;
  updatedAt: string;
  tokenIssuedAt?: string;
  tokenRotationDueAt?: string;
  tokenAgeSecs?: number;
  tokenRotationStatus: SourceTokenRotationStatus;
  lastSeenAt?: string;
  lastSignalAt?: string;
  lastEventAt?: string;
  lastHeartbeatAt?: string;
  status: IngestionSourceStatus;
  statusText: string;
  ageSecs?: number;
}
export interface IngestionSourceQuery {
  sourceId?: string;
  collectorId?: string;
  workspacePath?: string;
  status?: IngestionSourceStatus | 'all';
  type?: IngestionSourceType | 'all';
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
  status?: 'ok' | 'error';
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
  | 'new_block'
  | 'removed_block'
  | 'new_escalation'
  | 'removed_escalation'
  | 'severity_increase'
  | 'severity_decrease'
  | 'verdict_changed';
export type RemediationStatus = 'open' | 'in_progress' | 'blocked' | 'done' | 'dismissed';
export type RemediationSourceType = 'incident' | 'alert' | 'coverage';
export type RemediationActionKind = 'investigate' | 'collector' | 'source' | 'policy' | 'credential' | 'network' | 'file' | 'ownership';
export interface PolicySimulationRequest extends SecurityTimeFilter {
  policy?: unknown;
  limit?: number;
}
export interface PolicySimulationDecision {
  verdict: Verdict;
  tier: Tier;
  severity: Severity;
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
  maxSeverity: Severity;
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
export interface RemediationRecord {
  taskId: string;
  sourceType: RemediationSourceType;
  sourceId: string;
  status: RemediationStatus;
  severity: Severity;
  actionKind: RemediationActionKind;
  title: string;
  description: string;
  recommendedAction: string;
  createdAt: number;
  updatedAt: number;
  dueAt?: number;
  owner?: string;
  note?: string;
  completedAt?: number;
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
export interface RemediationListItem extends Omit<RemediationRecord, 'createdAt' | 'updatedAt' | 'dueAt' | 'completedAt'> {
  createdAt: string;
  updatedAt: string;
  dueAt?: string;
  completedAt?: string;
}
export interface RemediationQuery extends SecurityTimeFilter {
  taskId?: string;
  incidentId?: string;
  alertId?: string;
  eventId?: string;
  objectiveId?: string;
  issueId?: string;
  status?: RemediationStatus | 'all';
  severity?: Severity | 'all';
  sourceType?: RemediationSourceType | 'all';
  actionKind?: RemediationActionKind | 'all';
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

export type AuditActorType = 'system' | 'operator' | 'api';
export type AuditAction =
  | 'policy.updated'
  | 'policy.simulated'
  | 'incident.updated'
  | 'alert.updated'
  | 'remediation.updated'
  | 'agent.metadata.updated'
  | 'maintenance.window.updated'
  | 'notification.channel.updated'
  | 'notification.route.updated'
  | 'notification.delivery_failed'
  | 'objective.updated'
  | 'source.updated'
  | 'source.token_rotated';
export type AuditResourceType = 'policy' | 'incident' | 'alert' | 'remediation' | 'agent' | 'maintenance' | 'notification' | 'objective' | 'source';
export type AuditResult = 'success' | 'failure';
export interface AuditActor {
  type: AuditActorType;
  id: string;
  displayName?: string;
  sourceIp?: string;
  userAgent?: string;
}
export interface AuditRecord {
  schemaVersion: 'anysentry.audit.v1';
  auditId: string;
  at: number;
  actor: AuditActor;
  action: AuditAction;
  resourceType: AuditResourceType;
  resourceId: string;
  summary: string;
  result: AuditResult;
  details: Record<string, unknown>;
}
export interface AuditListItem extends Omit<AuditRecord, 'at'> {
  at: string;
}
export interface AuditQuery extends SecurityTimeFilter {
  auditId?: string;
  action?: AuditAction | 'all';
  resourceType?: AuditResourceType | 'all';
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
