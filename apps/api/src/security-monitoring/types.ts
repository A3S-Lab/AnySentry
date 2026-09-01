// Shapes shared by the judge, the aggregator, and the controller.
// Response shapes match the dashboard's API contract; every value is computed from live
// @a3s-lab/sentry judgments.

import type { TrustedCorrelationV1 } from './trusted-correlation';

export type {
  TrustedCorrelationAuthority,
  TrustedCorrelationClaimReceipt,
  TrustedCorrelationMethod,
  TrustedCorrelationScope,
  TrustedCorrelationTraceOrigin,
  TrustedCorrelationV1,
} from './trusted-correlation';

export interface SecurityTimeFilter {
  timeType?: 'last_30m' | 'last_1h' | 'last_2h' | 'last_3h' | 'last_1d' | 'last_7d' | 'last_30d' | 'custom';
  startTime?: string;
  endTime?: string;
  /**
   * Freeze all related queries at one instant. The browser reuses this value for every card and
   * drill-down until the operator refreshes, so a page never mixes several moving "now" values.
   */
  snapshotAsOf?: string;
  scope?: 'agent' | 'raw';
  /** Historical audit facts or the latest asset/review overlay. Defaults to as_observed. */
  classificationView?: ClassificationView;
}
export type ClassificationView = 'as_observed' | 'current_effective';
export type QueryTotalMode = 'exact' | 'estimated' | 'omitted';
export type QueryDataSource = 'clickhouse' | 'clickhouse+hot_delta' | 'clickhouse+redis_current' | 'memory_hot_ring';
export interface QueryCommitProgress {
  sourceId?: string;
  collectorId?: string;
  /** Greatest event time observed in a successful ClickHouse insert; not a completeness claim. */
  committedEventTime: string;
  /** Wall-clock time when that insert completed. */
  committedAt: string;
}
export interface QueryCoverage {
  requestedFrom: string;
  requestedTo: string;
  snapshotAsOf: string;
  /** Logical read snapshot used by this response; equal across one dashboard refresh. */
  asOf: string;
  dataFrom?: string;
  dataTo?: string;
  /**
   * Greatest event time observed in a successful relevant ClickHouse insert.
   * This is not an event-time watermark and does not prove that older events cannot arrive later.
   */
  observedDurableThrough?: string;
  /** @deprecated Compatibility alias for observedDurableThrough. */
  committedCutoff?: string;
  commitBoundaryKind?: 'observed_durable_high_water';
  commitProgress?: QueryCommitProgress[];
  commitProgressScope?: 'all_sources' | 'query_sources';
  lateDataPolicy?: 'commit_journal_revision_repair';
  completeness?: 'exact_as_observed' | 'exact_current_effective' | 'partial';
  watermark?: string;
  partial: boolean;
  partialReason?: 'hot_ring_only' | 'scan_limit' | 'storage_unavailable';
  source: QueryDataSource;
  totalMode: QueryTotalMode;
}
export interface ExplainabilityScanRequest extends SecurityTimeFilter {
  seriesPoints?: number;
}

export type Verdict = 'allow' | 'block' | 'escalate';
export type DecisionStatus = 'accepted' | 'pending' | 'running' | 'succeeded' | 'failed' | 'timeout';
export type Tier = 'Rules' | 'Llm' | 'Agent';
export type Severity = 'info' | 'low' | 'medium' | 'high' | 'critical';
export type RiskType = 'system' | 'communication' | 'atomic';
export type EventSource = 'observer' | 'synthetic' | 'api';
export type EventCategory = 'tool' | 'network' | 'file' | 'llm' | 'security' | 'process' | 'runtime' | 'unknown';
export type ActivityContext = 'agent_action' | 'platform_healthcheck' | 'collector_heartbeat';
export type ActivitySubtype =
  | 'docker_healthcheck'
  | 'k8s_exec_probe'
  | 'k8s_liveness_probe'
  | 'k8s_readiness_probe'
  | 'k8s_startup_probe'
  | 'observer_heartbeat';
export type PlatformHealthcheckSubtype = Exclude<ActivitySubtype, 'observer_heartbeat'>;
export interface PlatformHealthcheckSpec {
  activitySubtype: PlatformHealthcheckSubtype;
  argv: string[];
}
export type EventAttributeValue = string | number | boolean;
export type IncidentStatus = 'open' | 'acknowledged' | 'resolved';
export type AgentHealthState = 'active' | 'idle' | 'stale' | 'risky';
/** Event-history lifecycle used by inventory views; separate from root-process runtime state. */
export type AgentLifecycleState = 'current' | 'historical' | 'terminated';
/** Root-process lifecycle. This is intentionally separate from event-derived AgentHealthState. */
export type AgentRuntimeReportedState = 'running' | 'exited' | 'lost';
/** `unobserved` is derived by the API when a previously live forwarder stops reporting. */
export type AgentRuntimeState = AgentRuntimeReportedState | 'unobserved';
export type AgentActivityState = 'active' | 'idle';
/** Stable machine-readable outcomes for the runtime lease/snapshot control plane. */
export type AgentRuntimeAckReasonCode =
  | 'lease_not_found'
  | 'lease_epoch_stale'
  | 'lease_owner_mismatch'
  | 'stale_forwarder'
  | 'collector_conflict'
  | 'capacity_exceeded'
  | 'validation_error'
  | 'source_rejected'
  | 'service_unavailable'
  | 'snapshot_version_stale'
  | 'snapshot_version_conflict'
  | 'ready_regression'
  | 'identity_conflict'
  | 'generation_regression'
  | 'terminal_state_conflict'
  | 'awaiting_ready';
export type AgentCriticality = 'low' | 'medium' | 'high' | 'critical';
export type CollectorHealthState = 'healthy' | 'quiet' | 'degraded' | 'stale' | 'down';
export type CollectorHealthChannelState = 'healthy' | 'warning' | 'degraded' | 'unknown';
export interface CollectorHealthChannel {
  state: CollectorHealthChannelState;
  stateText: string;
  reasons: string[];
  consecutiveBad: number;
  consecutiveClean: number;
}
export type CollectorReportedStatus = 'ok' | 'degraded' | 'error';
export type AlertStatus = 'open' | 'acknowledged' | 'resolved' | 'silenced';
export type AlertKind = 'incident' | 'collector' | 'agent' | 'event' | 'judgment' | 'source' | 'coverage' | 'objective' | 'remediation';
export type AlertTimeMode = 'window' | 'backlog' | 'combined';
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
export type AgentClassification = 'confirmed_agent' | 'probable_agent' | 'unknown' | 'non_agent';
export type WorkloadRole =
  | 'agent'
  | 'anysentry_internal'
  | 'platform_infrastructure'
  | 'business_service'
  | 'ordinary_process'
  | 'unknown';
export type CaptureProfile =
  | 'agent_full'
  | 'probable_investigation'
  | 'security_full'
  | 'investigation_full'
  | 'business_context'
  | 'infrastructure_aggregate'
  | 'unknown_discovery'
  | 'self_health';
export type UnknownReason =
  | 'snapshot_not_ready'
  | 'snapshot_miss'
  | 'container_identity_missing'
  | 'container_name_missing'
  | 'parent_missing'
  | 'process_exited_before_enrichment'
  | 'ancestry_incomplete'
  | 'pid_reuse_ambiguous'
  | 'signature_miss'
  | 'template_conflict'
  | 'policy_expired'
  | 'shared_scope_ambiguous'
  | 'unsupported_agent_adapter';

export interface ClassificationSemanticsV1 {
  schemaVersion: 'anysentry.classification_semantics.v1';
  identityClassification: AgentClassification;
  workloadRole: WorkloadRole;
  captureProfile: CaptureProfile;
  unknownReason?: UnknownReason;
}
export type ProcessLifecycleSource = 'exec_process_key' | 'exec_tombstone';
export type ProcessGenerationLinkAuthority = 'forwarder_process_graph';
export type AgentReviewDecision = 'confirmed_agent' | 'unknown' | 'non_agent';
export interface AgentReviewRevisionRecord {
  revision: number;
  decision: AgentReviewDecision | 'clear';
  effectiveAt: number;
  reviewedBy?: string;
  note?: string;
  /** Keys on which this revision applies. A clear revision carries the keys it closes. */
  identityKeys: string[];
  /** Keys removed while another decision remains active on a narrower replacement scope. */
  clearedIdentityKeys?: string[];
  physicalWorkloadId?: string;
  agentInstanceId?: string;
  workloadRef?: AgentWorkloadRef;
}
export type JudgmentProfile = 'full' | 'l1_only' | 'discard';
export type JudgmentRouteReason =
  | 'confirmed_agent_full'
  | 'candidate_agent_full'
  | 'candidate_agent_l1_only'
  | 'unknown_l1_only'
  | 'non_agent_discarded'
  | 'non_agent_security_full'
  | 'non_agent_agent_conflict_full'
  | 'non_agent_structural_fallback';
export interface JudgmentRoutingSnapshot {
  classification: AgentClassification;
  profile: JudgmentProfile;
  maxTier: 'L1' | 'L2' | 'L3';
  reason: JudgmentRouteReason;
  routingVersion: string;
}
export interface EventJudgmentMetadata extends JudgmentRoutingSnapshot {
  policyVersion?: string;
  l1Verdict?: Verdict;
  nextTierEligible?: boolean;
  stopReason?: string;
  /** Unified F3 rule lineage. Additive and never accepted from an untrusted producer. */
  filterRuleDecision?: {
    schemaVersion: 'anysentry.filter_rule_decision_lineage.v1';
    stage: 'f3';
    catalogVersion: number;
    domainVersion: number;
    ruleId?: string;
    revision?: number;
    reason: string;
    failOpen: boolean;
  };
}
export type AgentAttributionSource = 'none' | 'process_graph' | 'cgroup' | 'systemd' | 'argv' | 'env' | 'self_register' | 'workspace_hint' | 'kubernetes' | 'docker' | 'behavior' | 'process_signature' | 'manual_review';
export type AgentAttributionReason = 'not_evaluated' | 'not_agent' | 'process_lineage' | 'authoritative_anchor' | 'hint_only' | 'conflict' | 'human_confirmed' | 'human_deferred' | 'human_rejected';

export interface ProcessContext {
  hostId?: string;
  bootId?: string;
  pid?: number;
  ppid?: number;
  /** PID namespace inode. String-encoded so identity comparison never loses u64 precision. */
  pidNamespace?: string;
  /** PID as observed inside pidNamespace (the last NSpid value). */
  namespacePid?: number;
  /** Parent PID inside pidNamespace; additive companion used for exact direct-child evidence. */
  namespacePpid?: number;
  startTimeTicks?: string;
  startTimeNs?: string;
  mountNamespace?: number;
  eventTimeNs?: string;
  comm?: string;
  exe?: string;
  cwd?: string;
  uid?: number;
  cgroup?: string;
  cgroupId?: string;
  systemdUnit?: string;
  /** Collector-resolved lifecycle provenance for short-lived ProcessExit facts. */
  lifecycleSource?: ProcessLifecycleSource;
  /** Closed reason when lifecycle ancestry deliberately remained unresolved. */
  lifecycleReason?: UnknownReason;
}

export interface AgentWorkloadRef {
  environment?: 'kubernetes' | 'docker' | 'host';
  kind?: 'pod' | 'container' | 'service' | 'process' | 'cgroup';
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
  /** Forwarder-observed root ProcessKey. It remains additive and does not redefine agentInstanceId. */
  rootKey?: string;
  /** Stable Workspace of the Agent root process; distinct from an individual event's cwd. */
  agentWorkspacePath?: string;
  physicalWorkloadId?: string;
  workloadRef?: AgentWorkloadRef;
  rootPid?: number;
  rootStartTime?: string;
  /** Forwarder-observed concrete Process generation; trusted only after Source authentication. */
  processGenerationKey?: string;
  /** Exact parent generation observed by the Forwarder process graph. */
  parentProcessGenerationKey?: string;
  parentLinkAuthority?: ProcessGenerationLinkAuthority;
  confidence: number;
  reason: AgentAttributionReason;
  source: AgentAttributionSource;
  conflict?: boolean;
  degraded?: boolean;
  evidence?: string[];
  /** Server-resolved additive identity view; never accepted as producer authority. */
  correlation?: TrustedCorrelationV1;
}

export interface WorkloadIdentitySnapshotEntry {
  ids: string[];
  classification: AgentClassification;
  /** Explicit deployment/inventory role, independent from Agent identity classification. */
  workloadRole?: WorkloadRole;
  physicalWorkloadId: string;
  source?: 'kubernetes' | 'docker' | 'systemd' | 'host';
  attributionSource?: AgentAttributionSource;
  /** Persistent human-review generation; additive and ignored by legacy Forwarders. */
  reviewRevision?: number;
  /** Wall-clock boundary at which the human review became effective. */
  effectiveAt?: string;
  environment?: 'kubernetes' | 'docker' | 'host';
  agentScopeId?: string;
  agentDisplayName?: string;
  agentInstanceId?: string;
  namespace?: string;
  podName?: string;
  podUid?: string;
  nodeName?: string;
  containerName?: string;
  containerImage?: string;
  ownerKind?: string;
  ownerName?: string;
  labels?: Record<string, string>;
  systemdUnit?: string;
  /** Exact, platform-declared exec probes for this physical container only. */
  platformHealthchecks?: PlatformHealthcheckSpec[];
  evidence: string[];
}

export interface WorkloadIdentitySnapshot {
  schemaVersion: 'anysentry.workload_identity_snapshot.v1';
  version: number;
  generatedAt: string;
  ready: boolean;
  nodeName?: string;
  entries: WorkloadIdentitySnapshotEntry[];
  errors: number;
}

export type AgentLaunchOriginType =
  | 'service_manager'
  | 'systemd_unit'
  | 'ssh_session'
  | 'shell'
  | 'supervisor'
  | 'cron'
  | 'container';

export interface AgentLaunchPathNode {
  processGenerationKey?: string;
  pid: number;
  ppid: number;
  command: string;
  exe?: string;
  systemdUnit?: string;
}

export interface AgentLaunchOrigin {
  type: AgentLaunchOriginType;
  processGenerationKey?: string;
  pid: number;
  name: string;
  description?: string;
  unitFile?: string;
  restartCount?: number;
  schedule?: string;
  /** SSH allowlist projection only; the Forwarder never transmits the complete environment. */
  remoteAddress?: string;
  remotePort?: number;
  localAddress?: string;
  localPort?: number;
  tty?: string;
  terminalSession?: 'tmux' | 'screen';
}

export interface AgentLaunchContext {
  schemaVersion: 'anysentry.agent_launch_context.v1';
  rootProcessGenerationKey: string;
  observedAt: string;
  completeness: 'complete' | 'missing_parent' | 'cycle' | 'depth_limit' | 'process_domain_conflict';
  path: AgentLaunchPathNode[];
  origins: AgentLaunchOrigin[];
}

/**
 * One root-process instance reported by an observer forwarder.
 *
 * `agentScopeId` is a display/type label (for example, "codex"). Runtime identity is always
 * `agentInstanceId`, optionally joined to the existing asset model through `physicalWorkloadId`.
 */
export interface AgentRuntimeSnapshotEntry {
  agentScopeId: string;
  agentDisplayName?: string;
  agentInstanceId: string;
  physicalWorkloadId?: string;
  classification?: AgentClassification;
  runtimeState: AgentRuntimeReportedState;
  rootPid: number;
  rootStartTimeTicks: string;
  rootGeneration: number;
  hostId: string;
  bootId: string;
  comm?: string;
  exe?: string;
  workspacePath?: string;
  discoveredAt: string;
  lastSeenAt: string;
  lastActivityAt?: string;
  endedAt?: string;
  exitCode?: number;
  signal?: number;
  confidence?: number;
  source?: AgentAttributionSource;
  evidence?: string[];
  workloadRef?: AgentWorkloadRef;
  launchContext?: AgentLaunchContext;
}

export interface AgentRuntimeLeaseRequest {
  collectorId: string;
  forwarderInstanceId: string;
  hostId: string;
  bootId: string;
  forwarderPid: number;
  forwarderStartTimeTicks: string;
}

export interface AgentRuntimeLeaseAck {
  accepted: boolean;
  collectorId?: string;
  forwarderInstanceId?: string;
  leaseEpoch?: number;
  issuedAt: string;
  reasonCode?: AgentRuntimeAckReasonCode;
  reason?: string;
}

/** A complete, monotonically-versioned view produced by one forwarder process. */
export interface AgentRuntimeSnapshotRequest {
  schemaVersion: 'anysentry.agent_runtime_snapshot.v1';
  collectorId: string;
  forwarderInstanceId: string;
  leaseEpoch: number;
  snapshotVersion: number;
  generatedAt: string;
  ready: boolean;
  intervalSecs: number;
  filterMode?: 'shadow' | 'enforce';
  registryVersion?: number;
  registryHash?: string;
  registryMatcherHash?: string;
  entries: AgentRuntimeSnapshotEntry[];
}

export interface AgentRuntimeSnapshotAck {
  accepted: boolean;
  applied: boolean;
  duplicate: boolean;
  collectorId?: string;
  forwarderInstanceId?: string;
  leaseEpoch?: number;
  snapshotVersion?: number;
  snapshotHash?: string;
  ready: boolean;
  instanceCount: number;
  receivedAt: string;
  reasonCode?: AgentRuntimeAckReasonCode;
  reason?: string;
}

/** Sanitized in-memory record returned to aggregation/query consumers. Epoch values are millis. */
export interface AgentRuntimeInstanceRecord
  extends Omit<AgentRuntimeSnapshotEntry, 'runtimeState' | 'discoveredAt' | 'lastSeenAt' | 'lastActivityAt' | 'endedAt'> {
  /** Canonical exact root-process generation; V1 keeps `agentInstanceId` for wire compatibility. */
  canonicalAgentInstanceId?: string;
  /** Strong equivalent producer identifiers only; physical workload IDs are not runtime aliases. */
  agentInstanceAliases?: string[];
  collectorId: string;
  forwarderInstanceId: string;
  leaseEpoch: number;
  snapshotVersion: number;
  snapshotHash: string;
  filterMode: 'shadow' | 'enforce';
  registryVersion?: number;
  registryHash?: string;
  registryMatcherHash?: string;
  runtimeState: AgentRuntimeState;
  activityState?: AgentActivityState;
  discoveredAt: number;
  lastSeenAt: number;
  lastActivityAt?: number;
  endedAt?: number;
  receivedAt: number;
}

export interface AgentRuntimeStateQuery {
  collectorId?: string;
  forwarderInstanceId?: string;
  agentScopeId?: string;
  agentInstanceId?: string;
  physicalWorkloadId?: string;
  runtimeState?: AgentRuntimeState | 'all';
  activityState?: AgentActivityState | 'all';
  includeShadow?: boolean;
  limit?: number;
}

export interface AgentRuntimeStateSummary {
  totalInstances: number;
  runningInstances: number;
  activeInstances: number;
  idleInstances: number;
  exitedInstances: number;
  lostInstances: number;
  unobservedInstances: number;
  shadowInstances: number;
}

export interface AgentRuntimeStateList {
  items: AgentRuntimeInstanceRecord[];
  total: number;
  summary: AgentRuntimeStateSummary;
  updateTime: string;
}

export interface AgentRuntimeStateSummaryResponse {
  summary: AgentRuntimeStateSummary;
  updateTime: string;
}
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
  sourceEventId?: string;
  at: number; // epoch ms
  /** Exact source event time when an authenticated Collector supplied calibrated Unix nanoseconds. */
  eventAtUnixNs?: string;
  /** Exact Collector ring-receipt time; distinct from API/ClickHouse ingestion time. */
  receivedAtUnixNs?: string;
  receivedAt?: number;
  eventTimeQuality?: 'collector_calibrated' | 'producer_supplied' | 'api_received';
  /** Exact Ring-before decision generation. String encoded because the kernel value is u64. */
  captureEpoch?: string;
  captureProfileCode?: number;
  captureActionCode?: number;
  captureAuthorityCode?: number;
  captureDispositionCode?: number;
  captureSelected?: boolean;
  captureFlags?: number;
  capturePolicyVersion?: number;
  eventKind: string; // ToolExec | Egress | FileAccess | Dns | SslContent | SecurityAction
  eventCategory: EventCategory;
  activityContext?: ActivityContext;
  activitySubtype?: ActivitySubtype;
  source: EventSource;
  subject: string; // human summary of the event
  workspacePath: string;
  agentId: string;
  subjectAssetId?: string;
  subjectAssetType?: 'agent' | 'service' | 'infrastructure' | 'workload' | 'ephemeral_process';
  assetBindingQuality?: 'exact' | 'logical' | 'ephemeral' | 'weak' | 'conflict' | 'unassigned';
  assetBindingRevision?: number;
  assetBindingReason?: string;
  identityRevision?: number;
  collectorId?: string;
  sourceId?: string;
  sessionId: string;
  userId: string;
  traceId: string;
  /** Additive trusted invocation identity; never aliases or replaces traceId. */
  invocationId?: string;
  toolCallId?: string;
  spanId: string;
  parentSpanId?: string;
  runId: string;
  taskId?: string;
  decisionStatus?: DecisionStatus;
  evaluationId?: string;
  policyVersion?: string;
  /** Strictly increasing within one eventId. Timestamp is only a tie-breaker, never the revision. */
  decisionRevision?: number;
  decisionUpdatedAt?: number;
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
  /** Additive S3 identity/role/capture view. It is never a filtering authority. */
  classificationSemantics?: ClassificationSemanticsV1;
  process?: ProcessContext;
  attribution?: AgentAttribution;
  judgment?: EventJudgmentMetadata;
  rawPreview?: string;
}

export interface EventMeta {
  workspacePath: string;
  agentId: string;
  sessionId: string;
  userId: string;
  source?: EventSource;
  eventCategory?: EventCategory;
  activityContext?: ActivityContext;
  activitySubtype?: ActivitySubtype;
  traceId?: string;
  /** Producer claims. They are trusted only after server-side Source policy authorization. */
  invocationId?: string;
  toolCallId?: string;
  spanId?: string;
  parentSpanId?: string;
  runId?: string;
  taskId?: string;
  attributes?: Record<string, EventAttributeValue>;
  /** Forwarder-resolved S3 view; the server validates its closed schema before persistence. */
  classificationSemantics?: ClassificationSemanticsV1;
  process?: ProcessContext;
  attribution?: AgentAttribution;
  rawPreview?: string;
  tokenCount?: number;
  latencyMs?: number;
  subject?: string;
  eventKind?: string;
  sourceEventId?: string;
  subjectAssetId?: string;
  subjectAssetType?: JudgedEvent['subjectAssetType'];
  assetBindingQuality?: JudgedEvent['assetBindingQuality'];
  assetBindingRevision?: number;
  assetBindingReason?: string;
  identityRevision?: number;
  eventAtUnixNs?: string;
  receivedAtUnixNs?: string;
  receivedAt?: number;
  eventTimeQuality?: 'collector_calibrated' | 'producer_supplied' | 'api_received';
  captureEpoch?: string;
  captureProfileCode?: number;
  captureActionCode?: number;
  captureAuthorityCode?: number;
  captureDispositionCode?: number;
  captureSelected?: boolean;
  captureFlags?: number;
  capturePolicyVersion?: number;
}

export interface UniversalIngestEvent extends Partial<EventMeta> {
  id?: string;
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
  exit_code?: string | number;
  exitCode?: string | number;
  signal?: string | number;
  runtimeKind?: string;
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
  /** Exact authenticated external-id replay; no new event revision or side effect was created. */
  duplicate?: boolean;
  disposition?: 'retained' | 'discarded' | 'rejected' | 'retryable';
  /** True when the raw payload was omitted only after its compact lifecycle fact was durable. */
  structuralConsumed?: boolean;
  reasonCode?: string;
  reason?: string;
  eventId?: string;
  traceId?: string;
  invocationId?: string;
  toolCallId?: string;
  spanId?: string;
  runId?: string;
  verdict?: Verdict;
  tier?: Tier;
  severity?: Severity;
  riskCategory?: string;
  decisionStatus?: DecisionStatus;
  evaluationId?: string;
}
export interface UniversalIngestResult {
  accepted: boolean;
  sourceId?: string;
  acceptedEvents: number;
  rejectedEvents: number;
  items: UniversalIngestResultItem[];
}

export type ObserverBatchIngestDisposition = 'retained' | 'discarded' | 'rejected' | 'retryable';
export interface ObserverBatchIngestResultItem extends UniversalIngestResultItem {
  disposition: ObserverBatchIngestDisposition;
  reasonCode?: string;
  /** The event is durable, but at least one idempotent post-commit delivery still needs retry. */
  deliveryIncomplete?: boolean;
}
export interface ObserverBatchIngestResult {
  accepted: boolean;
  batchId?: string;
  payloadDigest?: string;
  acceptedEvents: number;
  retainedEvents: number;
  structuralEvents?: number;
  discardedEvents: number;
  rejectedEvents: number;
  retryableEvents: number;
  deliveryIncompleteEvents?: number;
  retryAfterMs?: number;
  items: ObserverBatchIngestResultItem[];
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

export interface ClassifiedResponseMeta {
  classificationView: ClassificationView;
  reviewRevision: number;
  assetBindingRevision?: number;
  coverage?: QueryCoverage;
}

export interface SecurityHealthCard extends ClassifiedResponseMeta {
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
export interface SecurityExplainabilityScan extends ClassifiedResponseMeta {
  waveSeries: Array<{ safeSeries: WaveSeriesPoint[]; riskSeries: WaveSeriesPoint[] }>;
  threatInterception: string;
  sessionActiveCount: string;
  updateTime: string;
}
export interface SecurityPerformanceCard extends ClassifiedResponseMeta {
  componentRequestCount: { current: number; peak: number; avg: number };
  tps: { current: number; peak: number; avg: number };
  avgLatency: { value: number; unit: string };
  updateTime: string;
}
export interface SecurityRiskSummary extends ClassifiedResponseMeta {
  summaryCards: Array<{ riskTypeCode: string; riskTypeName: string; eventCount: number }>;
  updateTime: string;
}
export interface RiskCategory {
  totalCount: number;
  displayColor?: string;
  items: Array<{ riskCode: string; riskName: string; eventCount: number; changeRate: number }>;
}
export interface SecurityRiskBreakdown extends ClassifiedResponseMeta {
  systemRisks: RiskCategory;
  communicationRisks: RiskCategory;
  singleAgentRisks: RiskCategory;
  updateTime: string;
}
export interface SecurityHighestRiskSession extends ClassifiedResponseMeta {
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
export interface SecurityDecisionFunnel extends ClassifiedResponseMeta {
  tiers: Array<{ tierCode: string; tierName: string; count: number; percentage: number; slaDesc: string }>;
  finalBlock: { count: number; percentage: number };
  updateTime: string;
}
export interface AgentObservability extends ClassifiedResponseMeta {
  health: { heartbeatOk: boolean; resourceUtil: number; errorRate: number; decisionLatencyMs: number };
  behavioral: { actionRate: number; decisionPattern: 'baseline' | 'drift'; stateTransitions: number; goalProgress: number };
  system: { agentCount: number; commThroughput: number; infraHealthy: boolean };
  coverage?: QueryCoverage;
  updateTime: string;
}
export type PlatformMetricStatus = 'healthy' | 'warning' | 'critical' | 'unknown';
export type PlatformMetricSource = 'prometheus' | 'runtime_fallback';

export interface PlatformMetricPoint {
  at: string;
  value: number;
}

export interface PlatformMetricSeries {
  key: 'cpu' | 'memory' | 'disk' | 'network_rx' | 'network_tx' | 'api_p95' | 'api_error_rate';
  label: string;
  unit: '%' | 'B/s' | 'ms';
  points: PlatformMetricPoint[];
}

export interface PlatformComponentMetric {
  id: string;
  name: string;
  kind: 'service' | 'node' | 'scrape_target';
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
  severity: 'warning' | 'critical';
  metric: string;
  subject: string;
  value: number;
  unit: '%' | 'ms';
  threshold: number;
  message: string;
}

export interface PlatformMetricsOverview {
  schemaVersion: 'anysentry.platform_metrics.v1';
  status: 'ready' | 'partial' | 'unavailable';
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

export interface SecurityWorkspaceRiskDistribution extends ClassifiedResponseMeta {
  list: Array<{ workspacePath: string; sessionCount: number; totalRiskScore: number; riskLevel: string; riskLevelText: string }>;
  updateTime: string;
}

export interface AgentEventQuery extends SecurityTimeFilter {
  scope?: 'agent' | 'raw';
  /** Raw-view visibility only. Defaults to true; Agent scope always excludes Unknown. */
  includeUnknown?: boolean;
  /** Bounded hot-ring preview for dashboard first paint; full history remains separately available. */
  preview?: boolean;
  /** Query the durable ClickHouse history instead of only the hot dashboard window. */
  durable?: boolean;
  noise?: 'hide' | 'include';
  eventId?: string;
  sourceId?: string;
  collectorId?: string;
  agentId?: string;
  agentAssetId?: string;
  subjectAssetId?: string;
  agentInstanceId?: string;
  sessionId?: string;
  workspacePath?: string;
  traceId?: string;
  /** Independent trusted-invocation predicate; traceId keeps its legacy meaning. */
  invocationId?: string;
  /** Independent authenticated ToolCall predicate; it never aliases taskId. */
  toolCallId?: string;
  runId?: string;
  eventKind?: string;
  eventCategory?: EventCategory;
  activityContext?: ActivityContext;
  verdict?: Verdict;
  tier?: Tier;
  q?: string;
  limit?: number;
  totalMode?: QueryTotalMode;
}
export interface AgentEventListItem {
  schemaVersion: 'anysentry.agent_event.v1';
  eventId: string;
  sourceEventId?: string;
  at: string;
  eventAtUnixNs?: string;
  receivedAtUnixNs?: string;
  receivedAt?: string;
  eventTimeQuality?: JudgedEvent['eventTimeQuality'];
  captureEpoch?: string;
  captureProfileCode?: number;
  captureActionCode?: number;
  captureAuthorityCode?: number;
  captureDispositionCode?: number;
  captureSelected?: boolean;
  captureFlags?: number;
  capturePolicyVersion?: number;
  eventKind: string;
  eventCategory: EventCategory;
  activityContext?: ActivityContext;
  activitySubtype?: ActivitySubtype;
  source: EventSource;
  subject: string;
  workspacePath: string;
  agentId: string;
  agentAssetId: string;
  agentAssetAliases?: string[];
  agentProduct?: string;
  agentRuntimeInstanceId?: string;
  agentRuntimeInstanceAliases?: string[];
  identityBindingQuality?: 'exact' | 'weak';
  identityReasonCode?: string;
  subjectAssetId?: string;
  subjectAssetType?: 'agent' | 'service' | 'infrastructure' | 'workload' | 'ephemeral_process';
  assetBindingQuality?: 'exact' | 'logical' | 'ephemeral' | 'weak' | 'conflict' | 'unassigned';
  assetBindingRevision?: number;
  assetBindingReason?: string;
  asObservedIdentityRevision?: number;
  displayName?: string;
  detectedName?: string;
  detectedClassification: AgentClassification;
  /** Immutable identity decision recorded when this event occurred. */
  asObservedClassification: AgentClassification;
  /** Latest asset/review overlay; it never changes verdict/tier/reason. */
  currentEffectiveClassification: AgentClassification;
  effectiveClassification: AgentClassification;
  currentReviewRevision?: number;
  currentReviewEffectiveAt?: string;
  runtime: 'kubernetes' | 'docker' | 'host' | 'unknown';
  locationLabel?: string;
  collectorId?: string;
  sourceId?: string;
  sessionId: string;
  userId: string;
  traceId: string;
  invocationId?: string;
  toolCallId?: string;
  correlation?: TrustedCorrelationV1;
  spanId: string;
  parentSpanId?: string;
  runId: string;
  taskId?: string;
  decisionStatus?: DecisionStatus;
  evaluationId?: string;
  policyVersion?: string;
  decisionRevision?: number;
  decisionUpdatedAt?: number;
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
  classificationSemantics?: ClassificationSemanticsV1;
  process?: ProcessContext;
  attribution?: AgentAttribution;
  judgment?: EventJudgmentMetadata;
  repeatCount?: number;
  lastAt?: string;
  rawPreview?: string;
}
export interface AgentEventList extends ClassifiedResponseMeta {
  items: AgentEventListItem[];
  total: number;
  totalMode: QueryTotalMode;
  coverage: QueryCoverage;
  totalApproximate?: boolean;
  storageFallback?: 'hot_ring';
  updateTime: string;
}
export interface AgentTimeline extends ClassifiedResponseMeta {
  traceId: string;
  runId?: string;
  sessionId?: string;
  items: AgentEventListItem[];
  total: number;
  hasMore: boolean;
  coverage: QueryCoverage;
  updateTime: string;
}

export type AgentActionOrigin = 'semantic' | 'kernel_inferred';
export type AgentActionStatus = 'running' | 'succeeded' | 'failed' | 'incomplete';
export interface AgentActionItem {
  actionId: string;
  origin: AgentActionOrigin;
  status: AgentActionStatus;
  agentAssetId: string;
  agentAssetAliases?: string[];
  sourceId?: string;
  agentProduct?: string;
  agentRuntimeInstanceId?: string;
  invocationId?: string;
  toolCallId?: string;
  toolName: string;
  operation: 'execute_tool' | 'kernel_exec' | 'file_access' | 'file_read' | 'file_write' | 'file_delete' | 'network_connect';
  targetSummary?: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  semanticEventIds: string[];
  fallbackEventId?: string;
  evidenceState: 'available_on_demand' | 'runtime_level';
  evidenceHref?: string;
}
export interface AgentActionList extends ClassifiedResponseMeta {
  items: AgentActionItem[];
  total: number;
  totalMode: QueryTotalMode;
  coverage: QueryCoverage;
  updateTime: string;
}

export type AgentInteractionCompleteness =
  | 'complete'
  | 'partial'
  | 'truncated'
  | 'redacted'
  | 'reference_only'
  | 'unavailable'
  | 'unsupported';

export interface AgentInteractionMessage {
  role: string;
  content: unknown;
  name?: string;
  toolCallId?: string;
  sourceItemId?: string;
  turnId?: string;
  contentItemKinds?: string[];
  messageOrigin?: 'human_input' | 'agent_context' | 'developer_instruction' | 'assistant_history' | 'tool_history';
}

export type AgentConversationAnchorKind =
  | 'provider_conversation'
  | 'response_id'
  | 'previous_response_id'
  | 'continuity_key'
  | 'message_item_id'
  | 'turn_id'
  | 'tool_call_id';

export interface AgentConversationAnchor {
  kind: AgentConversationAnchorKind;
  namespace: string;
  valueHash: string;
  strength: 'exact' | 'strong' | 'supporting';
  sourcePath: string;
}

export interface AgentInteractionToolCall {
  toolCallId: string;
  name: string;
  arguments: unknown;
  issuedAtUnixNs?: string;
}

export interface AgentInteractionToolResult {
  toolCallId: string;
  name?: string;
  content: unknown;
  isError: boolean;
  observedAtUnixNs?: string;
}

export type AgentInteractionSemanticActor = 'user' | 'model' | 'tool';
export type AgentInteractionSemanticKind =
  | 'user_message'
  | 'model_progress'
  | 'model_final'
  | 'tool_call'
  | 'tool_result';

export interface AgentInteractionSemanticItem {
  semanticItemId: string;
  actor: AgentInteractionSemanticActor;
  kind: AgentInteractionSemanticKind;
  phase?: 'progress' | 'final';
  origin: 'request' | 'response';
  atUnixNs: string;
  content?: unknown;
  toolCallId?: string;
  toolName?: string;
  sourceItemId?: string;
  turnId?: string;
  contentItemKinds?: string[];
  messageOrigin?: AgentInteractionMessage['messageOrigin'];
  outputIndex?: number;
  contentIndex?: number;
  sequenceNumber?: number;
  completeness: 'complete' | 'partial' | 'missing';
  partialReasons: string[];
}

export interface AgentInteractionContent {
  body: string;
  encoding: 'utf8' | 'base64';
  contentType: string;
  capturedBytes: number;
  decodedBytes: number;
  sha256: string;
  completeness: AgentInteractionCompleteness;
  messages?: AgentInteractionMessage[];
  text?: string;
  structured?: unknown;
}

export interface AgentInteractionTokenUsage {
  source: 'provider_reported';
  completeness: 'complete' | 'partial';
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokensDerived: boolean;
}

export interface AgentUsageSummary {
  modelCallCount: number;
  successfulModelCallCount: number;
  failedModelCallCount: number;
  tokenReportedModelCallCount: number;
  tokenCoverage: 'complete' | 'partial' | 'unavailable';
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningOutputTokens: number;
  totalDurationMs: number;
  averageDurationMs?: number;
}

export interface AgentInstanceUsageSummary extends AgentUsageSummary {
  agentInstanceId: string;
}

export interface AgentInteractionRecord {
  schemaVersion: 'anysentry.agent_interaction.v1';
  interactionId: string;
  interactionType: 'model' | 'tool' | 'unparsed';
  at: number;
  tenantId?: string;
  environmentId?: string;
  workspacePath: string;
  sourceId?: string;
  collectorId?: string;
  agentAssetId: string;
  agentInstanceId?: string;
  agentProduct?: string;
  environment?: 'kubernetes' | 'docker' | 'host' | 'unknown';
  runtimeSessionId?: string;
  providerConversationId?: string;
  providerResponseId?: string;
  providerPreviousResponseId?: string;
  trafficRole?: 'conversation' | 'bootstrap' | 'control' | 'context_replay'
    | 'tool_backend' | 'derived_metadata' | 'retry' | 'background' | 'unclassified';
  conversationAnchors?: AgentConversationAnchor[];
  evidenceEventIds?: string[];
  conversationId?: string;
  conversationIdSource?: 'provider' | 'runtime' | 'inferred';
  conversationBindingVersion?: number;
  turnId?: string;
  modelCallId?: string;
  attemptId?: string;
  runtimeRole?: 'agent_root' | 'network_runtime' | 'tool_runtime';
  correlationQuality?: 'exact' | 'strong' | 'inferred' | 'unlinked';
  detectedClassification: AgentClassification;
  currentEffectiveClassification: AgentClassification;
  process?: ProcessContext;
  connectionId: string;
  transport: 'http' | 'tls';
  protocol: string;
  tlsAdapterId?: string;
  transportProtocol?: string;
  wireTemplateId?: string;
  parseState?: 'parsed' | 'partial' | 'unparsed' | 'ambiguous';
  llmLikelihood?: 'confirmed' | 'likely' | 'unknown' | 'unlikely';
  schemaFingerprint?: string;
  transportCompleteness?: 'complete' | 'partial';
  wireCompleteness?: 'complete' | 'error' | 'unknown' | 'partial';
  conversationCompleteness?: 'complete' | 'tool_pending' | 'response_pending' | 'partial';
  endpoint: string;
  method: string;
  path: string;
  statusCode: number;
  model?: string;
  startedAtUnixNs: string;
  requestCompleteAtUnixNs: string;
  firstResponseAtUnixNs: string;
  endedAtUnixNs: string;
  durationNs: string;
  timeQuality: string;
  request: AgentInteractionContent;
  response: AgentInteractionContent;
  usage?: AgentInteractionTokenUsage;
  toolCalls: AgentInteractionToolCall[];
  toolResults: AgentInteractionToolResult[];
  semanticParserId?: string;
  semanticParserVersion?: number;
  semanticItems?: AgentInteractionSemanticItem[];
  completeness: AgentInteractionCompleteness;
  partialReasons: string[];
  captureSource: string;
  receivedAt: number;
}

export interface AgentInteractionQuery extends SecurityTimeFilter {
  agentAssetId?: string;
  agentInstanceId?: string;
  interactionId?: string;
  interactionType?: 'model' | 'tool' | 'unparsed';
  model?: string;
  transport?: 'http' | 'tls';
  tlsAdapterId?: string;
  transportProtocol?: string;
  wireTemplateId?: string;
  parseState?: 'parsed' | 'partial' | 'unparsed' | 'ambiguous';
  completeness?: AgentInteractionCompleteness;
  limit?: number;
}

export interface AgentInteractionList extends ClassifiedResponseMeta {
  items: AgentInteractionRecord[];
  total: number;
  totalMode: QueryTotalMode;
  coverage: QueryCoverage;
  dataSource: 'clickhouse' | 'hot_ring';
  updateTime: string;
}

export type AgentConversationCoverageStatus =
  | 'complete'
  | 'partial'
  | 'attach_pending'
  | 'unsupported_tls_profile'
  | 'unsupported_protocol'
  | 'discovery_pending'
  | 'metadata_only'
  | 'transport_unparsed'
  | 'template_unparsed'
  | 'budget_limited'
  | 'no_final_response'
  | 'asset_only'
  | 'no_activity';

export interface AgentConversationCoverage {
  status: AgentConversationCoverageStatus;
  reasons: string[];
  completeInteractions: number;
  partialInteractions: number;
  lastEvidenceAt?: string;
}

export interface AgentConversationThreadRecord {
  schemaVersion: 'anysentry.agent_conversation_thread.v1';
  conversationId: string;
  logicalScopeKey: string;
  idSource: 'provider' | 'runtime' | 'inferred';
  tenantId?: string;
  environmentId?: string;
  agentProduct: string;
  workspacePath: string;
  hostId?: string;
  agentInstanceIds: string[];
  userLineageHashes: string[];
  pendingToolCallIds: string[];
  lastRequestSha256?: string;
  startedAtUnixNs: string;
  lastActivityAtUnixNs: string;
  resolverVersion: number;
  updatedAt: number;
}

export interface ConversationInstanceSegment {
  schemaVersion: 'anysentry.agent_conversation_segment.v1';
  segmentId: string;
  conversationId: string;
  agentInstanceId: string;
  ordinal: number;
  startedAtUnixNs: string;
  endedAtUnixNs?: string;
  firstInteractionId: string;
  lastInteractionId: string;
  interactionCount: number;
  correlationQuality: 'exact' | 'strong' | 'inferred' | 'unlinked';
  resolverVersion: number;
  updatedAt: number;
}

export interface AgentConversationBindingRecord {
  schemaVersion: 'anysentry.agent_conversation_binding.v1';
  interactionId: string;
  conversationId: string;
  segmentId: string;
  agentInstanceId: string;
  logicalScopeKey: string;
  evidence: string[];
  correlationQuality: 'exact' | 'strong' | 'inferred';
  resolverVersion: number;
  decidedAt: number;
  updatedAt: number;
}

export interface AgentConversationQuery extends SecurityTimeFilter {
  agentAssetId?: string;
  agentInstanceId?: string;
  conversationId?: string;
  product?: string;
  classification?: AgentClassification;
  coverageStatus?: AgentConversationCoverageStatus;
  model?: string;
  q?: string;
  limit?: number;
}

export interface AgentConversationSummary {
  conversationId: string;
  idSource: 'provider' | 'runtime' | 'inferred';
  hasContent: boolean;
  agentAssetId: string;
  agentInstanceIds: string[];
  agentProduct: string;
  displayName: string;
  environment: 'kubernetes' | 'docker' | 'host' | 'unknown';
  classification: AgentClassification;
  workspacePath: string;
  startedAtUnixNs?: string;
  lastActivityAtUnixNs?: string;
  firstPromptPreview?: string;
  turnCount: number;
  modelCallCount: number;
  toolCallCount: number;
  toolResultCount: number;
  errorCount: number;
  models: string[];
  usage: AgentUsageSummary;
  instanceUsage: AgentInstanceUsageSummary[];
  coverage: AgentConversationCoverage;
}

export interface AgentConversationList extends ClassifiedResponseMeta {
  items: AgentConversationSummary[];
  total: number;
  totalMode: QueryTotalMode;
  coverage: QueryCoverage;
  dataSource: 'clickhouse' | 'hot_ring';
  updateTime: string;
}

export interface AgentConversationDirectoryQuery extends AgentConversationQuery {
  lifecycleScope?: 'running' | 'history' | 'all';
}

export interface LogicalAgentConversationDirectoryItem {
  logicalAgentId: string;
  groupingQuality: 'exact' | 'strong' | 'inferred' | 'unresolved';
  product: string;
  displayName: string;
  environment: 'kubernetes' | 'docker' | 'host' | 'unknown';
  workspacePath: string;
  lifecycleState: 'running' | 'unobserved' | 'historical';
  activeInstanceCount: number;
  totalInstanceCount: number;
  conversationCount: number;
  lastActivityAtUnixNs?: string;
  agentAssetIds: string[];
  agentInstanceIds: string[];
  conversations: AgentConversationSummary[];
  usage: AgentUsageSummary;
  instanceUsage: AgentInstanceUsageSummary[];
  coverage: AgentConversationCoverage;
}

export interface AgentConversationDirectoryList extends ClassifiedResponseMeta {
  items: LogicalAgentConversationDirectoryItem[];
  runningCount: number;
  historicalCount: number;
  total: number;
  totalMode: QueryTotalMode;
  coverage: QueryCoverage;
  dataSource: 'clickhouse' | 'hot_ring';
  updateTime: string;
}

export interface LogicalAgentConversationDirectoryItemV2
  extends LogicalAgentConversationDirectoryItem {
  instanceCounts: {
    active: number;
    idle: number;
    unobserved: number;
    exited: number;
    lost: number;
    total: number;
  };
  conversationCounts: {
    active: number;
    dormant: number;
    incomplete: number;
    total: number;
  };
  recentInstances: AgentRuntimeInstanceRecord[];
}

export interface AgentConversationDirectoryListV2
  extends Omit<AgentConversationDirectoryList, 'items'> {
  apiVersion: 2;
  items: LogicalAgentConversationDirectoryItemV2[];
}

export interface AgentRunTechnicalActivitySummary {
  technicalActivityId: string;
  agentAssetId: string;
  agentInstanceId?: string;
  role: 'bootstrap' | 'control' | 'tool_backend' | 'derived_metadata'
    | 'retry' | 'background' | 'unclassified';
  interactionIds: string[];
  startedAtUnixNs: string;
  endedAtUnixNs: string;
  methods: string[];
  paths: string[];
  status: 'complete' | 'partial' | 'failed';
}

export interface LogicalAgentConversationDirectoryItemV3
  extends LogicalAgentConversationDirectoryItemV2 {
  userThreads: AgentConversationSummary[];
  technicalActivities: AgentRunTechnicalActivitySummary[];
  technicalActivityCount: number;
}

export interface AgentConversationDirectoryListV3
  extends Omit<AgentConversationDirectoryListV2, 'apiVersion' | 'items'> {
  apiVersion: 3;
  resolutionRevision: number;
  items: LogicalAgentConversationDirectoryItemV3[];
}

export type LogicalAgentConversationDirectoryItemV4 = Omit<
  LogicalAgentConversationDirectoryItemV3,
  'conversations'
>;

export interface AgentConversationDirectoryListV4
  extends Omit<AgentConversationDirectoryListV3, 'apiVersion' | 'items'> {
  apiVersion: 4;
  items: LogicalAgentConversationDirectoryItemV4[];
}

export type AgentConversationEventKind =
  | 'tool_result'
  | 'model_request'
  | 'model_response'
  | 'tool_call'
  | 'external_tool'
  | 'retry'
  | 'error';

export interface AgentConversationEvent {
  eventId: string;
  kind: AgentConversationEventKind;
  sequence: number;
  atUnixNs: string;
  turnId: string;
  modelCallId?: string;
  attemptId?: string;
  attemptNumber?: number;
  interactionId?: string;
  parentEventId?: string;
  toolCallId?: string;
  title: string;
  contentPreview?: string;
  model?: string;
  toolName?: string;
  arguments?: unknown;
  result?: unknown;
  isError?: boolean;
  statusCode?: number;
  durationNs?: string;
  completeness: AgentInteractionCompleteness;
  correlationQuality: 'exact' | 'strong' | 'inferred' | 'unlinked';
  evidenceEventIds: string[];
}

export interface AgentConversationTimeline extends ClassifiedResponseMeta {
  conversation?: AgentConversationSummary;
  items: AgentConversationEvent[];
  interactionIds: string[];
  total: number;
  coverage: QueryCoverage;
  dataSource: 'clickhouse' | 'hot_ring';
  updateTime: string;
}

export type AgentConversationActor = 'user' | 'model' | 'tool';
export type AgentSemanticEventKind =
  | 'user_message'
  | 'model_progress'
  | 'model_final'
  | 'tool_call'
  | 'tool_result';
export type AgentToolKind =
  | 'bash'
  | 'read'
  | 'write'
  | 'search'
  | 'mcp'
  | 'skill'
  | 'http'
  | 'code'
  | 'other';

export interface AgentSemanticEvent {
  semanticEventId: string;
  conversationId: string;
  segmentId: string;
  turnId: string;
  actor: AgentConversationActor;
  kind: AgentSemanticEventKind;
  phase?: 'progress' | 'final';
  atUnixNs: string;
  endedAtUnixNs?: string;
  content?: unknown;
  contentPreview?: string;
  toolCallId?: string;
  toolName?: string;
  toolKind?: AgentToolKind;
  status?: 'pending' | 'running' | 'succeeded' | 'failed' | 'unknown';
  sourceInteractionIds: string[];
  sourceItemIds?: string[];
  sequenceNumber?: number;
  evidenceEventIds: string[];
  parserId: string;
  parserVersion: number;
  correlationQuality: 'exact' | 'strong' | 'inferred' | 'unlinked';
  completeness: 'complete' | 'partial' | 'missing';
  partialReasons: string[];
}

export interface AgentTimelineDiagnostic {
  diagnosticId: string;
  type: 'retry' | 'capture_gap' | 'parse_gap' | 'correlation_gap';
  severity: 'info' | 'warning' | 'error';
  message: string;
  attachedToEventId?: string;
  interactionId?: string;
}

export interface AgentConversationTurnV2 {
  turnId: string;
  ordinal: number;
  state: 'active' | 'complete' | 'incomplete';
  startedAtUnixNs: string;
  endedAtUnixNs?: string;
  events: AgentSemanticEvent[];
  diagnostics: AgentTimelineDiagnostic[];
}

export interface AgentConversationTimelineV2 extends ClassifiedResponseMeta {
  thread?: AgentConversationSummary;
  segments: ConversationInstanceSegment[];
  turns: AgentConversationTurnV2[];
  interactionIds: string[];
  parserId: string;
  parserVersion: number;
  dataSource: 'clickhouse' | 'hot_ring';
  coverage: QueryCoverage;
  updateTime: string;
}

export interface AgentContextReplaySummary {
  interactionId: string;
  segmentId?: string;
  atUnixNs: string;
  replayedUserMessages: number;
  replayedToolCalls: number;
  replayedToolResults: number;
  newUserMessages: number;
}

export interface AgentConversationTimelineV3 extends AgentConversationTimelineV2 {
  apiVersion: 3;
  requestKey: string;
  requestedConversationId: string;
  canonicalConversationId?: string;
  aliasFrom?: string;
  resolutionRevision: number;
  timelineVersion: 3;
  contextReplaySummaries: AgentContextReplaySummary[];
  technicalActivitySummaries: AgentRunTechnicalActivitySummary[];
  redirectTarget?: {
    type: 'conversation' | 'technical_activity';
    id: string;
  };
}

export type AgentSemanticKernelRelationStatus =
  | 'linked_exact'
  | 'linked_strong'
  | 'semantic_only'
  | 'ambiguous'
  | 'coverage_gap';

export interface AgentSemanticKernelRelation {
  schemaVersion: 'anysentry.agent_semantic_kernel_relation.v1';
  relationId: string;
  stableSemanticEventId: string;
  conversationId: string;
  turnId: string;
  toolInvocationId: string;
  kernelEventId?: string;
  kernelEventAt?: string;
  kernelEventKind?: string;
  kernelEventDecisionRevision?: number;
  status: AgentSemanticKernelRelationStatus;
  linkMethod?: 'command' | 'resource' | 'network';
  lineageMethod?: 'direct_runtime' | 'generation_parent' | 'legacy_pid_parent';
  competingToolInvocationIds?: string[];
  timeQuality?: 'exact' | 'bounded';
  confidence: number;
  authority: 'attested_tls_plaintext';
  relationVersion: 1 | 2;
  resolutionRevision: number;
  risk?: {
    verdict: Verdict;
    tier: Tier;
    severity: Severity;
    riskScore: number;
    riskName: string;
    riskCategory: string;
    reason: string;
  };
}

export interface AgentSemanticEvidenceResponse extends ClassifiedResponseMeta {
  schemaVersion: 'anysentry.agent_semantic_evidence.v1';
  semanticEventId: string;
  conversationId: string;
  toolInvocationId?: string;
  interactionIds: string[];
  interactionEvidenceEventIds: string[];
  relations: AgentSemanticKernelRelation[];
  kernelEvents: AgentEventListItem[];
  relationStatus: AgentSemanticKernelRelationStatus;
  evidenceBundleEventIds: string[];
  coverage: QueryCoverage;
  updateTime: string;
}

export interface AgentSemanticEvidenceQuery extends AgentConversationQuery {
  conversationId: string;
  semanticEventId: string;
}

export interface AgentKernelSemanticContextResponse {
  schemaVersion: 'anysentry.agent_kernel_semantic_context.v1';
  eventId: string;
  relations: AgentSemanticKernelRelation[];
  conversationLinks: Array<{
    conversationId: string;
    turnId: string;
    semanticEventId: string;
  }>;
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
  subjectAssetId?: string;
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
  subjectAssetId?: string;
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
export interface EvidenceBundle extends ClassifiedResponseMeta {
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
export interface EvidenceBundleExport extends ClassifiedResponseMeta {
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
  monitored?: boolean;
  agentScopeId?: string;
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
  assetRange?: 'current' | 'recent' | 'historical' | 'archived' | 'all';
  healthState?: AgentHealthState | 'all';
  criticality?: AgentCriticality | 'all';
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
export interface AgentMetadataRecord {
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
  reviewedAt?: number;
  reviewNote?: string;
  reviewIdentityKeys?: string[];
  reviewPhysicalWorkloadId?: string;
  reviewAgentInstanceId?: string;
  reviewWorkloadRef?: AgentWorkloadRef;
  /** Monotonic per-asset human-review revision, retained after a clear. */
  reviewRevision?: number;
  /** Effective wall-clock time of the latest review revision, including clear. */
  reviewEffectiveAt?: number;
  /** Bounded append-only history used to resolve late events against the review valid at event time. */
  reviewHistory?: AgentReviewRevisionRecord[];
  updatedAt: number;
}
export interface AgentMetadataListItem extends Omit<AgentMetadataRecord, 'updatedAt' | 'reviewedAt' | 'reviewEffectiveAt'> {
  updatedAt: string;
  reviewedAt?: string;
  reviewEffectiveAt?: string;
}
export interface AgentInventoryItem {
  agentId: string;
  agentAssetId: string;
  agentAssetAliases?: string[];
  /** Product/runtime family such as codex or pi; never a unique Asset key. */
  agentProduct?: string;
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
  runtime: 'kubernetes' | 'docker' | 'host' | 'unknown';
  locationLabel?: string;
  instanceCount: number;
  confidence: number;
  attributionSource: AgentAttributionSource;
  attributionEvidence: string[];
  physicalWorkloadId?: string;
  agentInstanceId?: string;
  agentInstanceAliases?: string[];
  identityBindingQuality?: 'exact' | 'weak';
  identityReasonCode?: string;
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
  lastEventId?: string;
  collectorIds?: string[];
  eventsWithoutCollector?: number;
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
  coverage: QueryCoverage;
  directory?: {
    source: 'observed_asset_lifecycle';
    snapshotRevision: number;
    totalAssets: number;
    partial: boolean;
    reasons: string[];
    reconciledAt: string;
  };
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
  coverage?: QueryCoverage;
  updateTime: string;
}

export type IdentityAiReviewTargetType = 'event' | 'agent';
export type IdentityAiVerdict = 'agent' | 'not_agent';
export type IdentityAiReviewStatus = 'running' | 'succeeded' | 'failed';
export interface IdentityAiReviewRequest extends SecurityTimeFilter {
  targetType: IdentityAiReviewTargetType;
  eventId?: string;
  agentAssetId?: string;
}
export interface IdentityAiReviewRecord {
  schemaVersion: 'anysentry.identity_ai_review.v1';
  reviewId: string;
  /** Monotonic lifecycle revision within one reviewId. */
  revision?: number;
  targetType: IdentityAiReviewTargetType;
  eventId?: string;
  agentAssetId: string;
  status: IdentityAiReviewStatus;
  verdict?: IdentityAiVerdict;
  confidence?: number;
  summary?: string;
  reason?: string;
  evidenceRefs: string[];
  evidenceDigest: string;
  model?: string;
  provider: 'direct-llm' | 'a3s-code-sdk';
  /** Automatic reviews are keyed by a stable logical identity, not by a transient PID instance. */
  automatic?: boolean;
  logicalIdentityKey?: string;
  appliedDecision?: AgentReviewDecision;
  appliedAt?: string;
  error?: string;
  createdAt: string;
  /** Time this lifecycle revision was produced. */
  updatedAt?: string;
  completedAt?: string;
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
export interface WorkspaceDirectoryRecord {
  workspaceId: string;
  workspacePath: string;
  workspacePathFingerprint: string;
  displayName: string;
  repositoryId?: string;
  sourceId?: string;
  environmentId?: string;
  nodeScope?: string;
  firstSeenAt: number;
  lastSeenAt: number;
  updatedAt: number;
}
export interface AgentWorkspaceBindingRecord {
  bindingId: string;
  agentAssetId: string;
  workspaceId: string;
  workspacePath: string;
  validFrom: number;
  validTo?: number;
  lastObservedAt: number;
  updatedAt: number;
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
  coverage?: QueryCoverage;
  updateTime: string;
}
export interface AgentMetadataUpdateRequest {
  workspacePath: string;
  agentAssetId?: string;
  displayName?: string;
  owner?: string;
  team?: string;
  environment?: string;
  criticality?: AgentCriticality | '';
  tags?: string[];
  note?: string;
  identityKeys?: string[];
  physicalWorkloadId?: string;
  agentInstanceId?: string;
  workloadRef?: AgentWorkloadRef;
}

export interface AgentReviewRequest {
  workspacePath: string;
  decision: AgentReviewDecision | 'clear';
  /** Optional during the compatibility rollout; when supplied it is a strict compare-and-set. */
  expectedRevision?: number;
  currentClassification?: AgentClassification;
  agentAssetId?: string;
  identityKeys?: string[];
  physicalWorkloadId?: string;
  agentInstanceId?: string;
  workloadRef?: AgentWorkloadRef;
  note?: string;
}

export interface AgentTopologyQuery extends SecurityTimeFilter {
  scope?: 'agent' | 'raw';
  edgeId?: string;
  eventId?: string;
  agentAssetId?: string;
  /** Select one concrete runtime while retaining the shared logical Agent identity. */
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
  coverage: QueryCoverage;
  updateTime: string;
}

export interface CollectorExecEvidenceMetrics {
  /** ToolExec events reported by the raw collector during this heartbeat interval. */
  exec: number;
  /** ToolExec events whose final argv evidence remained truncated. */
  execTruncated: number;
  /** ToolExec events whose final argv evidence remained incomplete. */
  execIncomplete: number;
  /** ToolExec reassemblies that timed out, including events later supplemented from /proc. */
  execReassemblyTimeout: number;
}
export interface CollectorExecEvidenceReport extends CollectorExecEvidenceMetrics {
  /** True only for the partial-window raw heartbeat flushed during graceful collector shutdown. */
  shutdownFinal: boolean;
}
export interface CollectorExecEvidenceHealth {
  /** Distinguishes a reported all-zero interval from a collector that does not expose the metrics. */
  reported: boolean;
  lastReportedAt?: string;
  latest?: CollectorExecEvidenceReport & { intervalSecs: number };
  /** Sums non-overlapping raw collector intervals whose heartbeat records fall in the query window. */
  window: CollectorExecEvidenceMetrics & {
    heartbeatCount: number;
    intervalSecs: number;
    shutdownFinalCount: number;
  };
}
export type CollectorHeartbeatOrigin = 'raw_collector' | 'forwarder';

/**
 * An independently versioned, additive accounting envelope. Its counters never change the
 * semantics of the legacy heartbeat fields above or below it.
 */
export type CollectorPipelineTemporality = 'delta' | 'cumulative';
export interface CollectorPipelineWindow {
  startedAtUnixMs: number;
  endedAtUnixMs: number;
}
export interface CollectorPipelineUnit {
  /** Observer ring records are physical records; absent on Forwarder-only envelopes. */
  ring?: 'physical_record';
  /** Forwarder input is a logical event; absent on Observer-only envelopes. */
  input?: 'logical_event';
  queue: 'logical_event';
}
export interface CollectorPipelineRingAccounting {
  ring: string;
  ringSubmitted: number;
  ringDropped: number;
  collectorReceived: number;
  /** Physical records admitted to the bounded Collector processing inbox (S4+). */
  collectorEnqueued?: number;
  /** Physical records deliberately dropped because that class-specific inbox was full (S4+). */
  collectorDropped?: number;
  logicalEvents: number;
  queueAdmitted: number;
  queueDropped: number;
}
export interface CollectorPipelineStageReasonAccounting {
  reason: string;
  count: number;
}
export interface CollectorPipelineStageAccounting {
  stage: string;
  count: number;
  reasons: CollectorPipelineStageReasonAccounting[];
}
export interface CollectorPipelineBacklog {
  queueEvents: number;
  queueBytes: number;
  inflightEvents: number;
  inflightBytes: number;
  retryEvents: number;
  retryBytes: number;
  outstandingEvents: number;
  outstandingBytes: number;
}
export interface CollectorPipelineAccounting {
  schemaVersion: 'anysentry.pipeline_accounting.v1';
  /** Optional during the Observer compatibility window; new writers identify their component. */
  producer?: string;
  /** Changes whenever a producer process starts, so sequence 1 cannot collide after restart. */
  producerInstanceId: string;
  sequence: number;
  window: CollectorPipelineWindow;
  temporality: CollectorPipelineTemporality;
  unit: CollectorPipelineUnit;
  rings?: CollectorPipelineRingAccounting[];
  stages?: CollectorPipelineStageAccounting[];
  /** A point-in-time gauge. Backlog values must never be summed as delta counters. */
  backlog?: CollectorPipelineBacklog;
}
export type CollectorPipelineContinuity =
  | 'initial'
  | 'continuous'
  | 'restart'
  | 'sequence_gap'
  | 'duplicate'
  | 'out_of_order'
  | 'temporality_change'
  | 'counter_reset';
export interface CollectorPipelineAccountingHealth {
  reported: true;
  lastReportedAt: string;
  latest: {
    producerInstanceId: string;
    sequence: number;
    temporality: CollectorPipelineTemporality;
    continuity: CollectorPipelineContinuity;
    backlog?: CollectorPipelineBacklog;
  };
  window: {
    heartbeatCount: number;
    acceptedWindowCount: number;
    producerCount: number;
    restartCount: number;
    sequenceGapCount: number;
    duplicateCount: number;
    outOfOrderCount: number;
    counterResetCount: number;
    ringSubmitted: number;
    ringDropped: number;
    collectorReceived: number;
    collectorEnqueued?: number;
    collectorDropped?: number;
    /** Received minus enqueued and explicitly dropped raw records; zero means handoff conservation. */
    collectorHandoffResidual?: number;
    logicalEvents: number;
    queueAdmitted: number;
    queueDropped: number;
    /** Submitted minus received physical records; an async backlog delta, not implicit loss. */
    physicalBacklogDelta: number;
    /** Logical events minus admitted and explicitly dropped events; zero means local conservation. */
    logicalResidual: number;
    stageCountResidual: number;
    exact: boolean;
  };
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
  /** Optional explicit semantics for the three legacy operational counters. */
  legacyCounterTemporality?: CollectorPipelineTemporality;
  observedAgents?: number;
  pipelineAccounting?: CollectorPipelineAccounting;
  filterMetrics?: CollectorFilterMetrics;
  fileFilterMetrics?: CollectorFileFilterMetrics;
  message?: string;
}
export interface CollectorRawHeartbeatRequest extends CollectorHeartbeatRequest {
  /** Raw collector-only argv/reassembly evidence quality; never an operational error counter. */
  execEvidence?: Partial<CollectorExecEvidenceReport>;
  /** Raw Collector-only S5 pre-ring accounting; Forwarder claims are ignored server-side. */
  captureProfileMetrics?: CollectorCaptureProfileMetrics;
}
export type CollectorCaptureProfileMode = 'legacy' | 'shadow' | 'enforce';
export type CollectorCaptureProfileActivationMode = 'shadow' | 'preview' | 'enforce';
export type CollectorCaptureProfileControlState = 'ready' | 'lkg_degraded';
export type CollectorCaptureProfileActivationReason =
  | 'rollout_mode'
  | 'awaiting_preview_ack'
  | 'local_ack_and_central_acceptance'
  | 'intent_changed'
  | 'ttl_refresh_requires_preview'
  | 'policy_scope_changed'
  | 'control_plane_unavailable'
  | 'activation_grant_expired'
  | 'scope_expired'
  | 'snapshot_capacity'
  | 'collector_generation_changed'
  | 'preview_generation_changed'
  | 'capture_profile_legacy'
  | 'snapshot_not_published'
  | 'snapshot_hash_invalid'
  | 'ack_schema_invalid'
  | 'ack_not_applied'
  | 'ack_has_errors'
  | 'ack_has_downgrades'
  | 'ack_node_mismatch'
  | 'ack_collector_mismatch'
  | 'ack_collector_instance_missing'
  | 'ack_boot_mismatch'
  | 'ack_publisher_mismatch'
  | 'ack_epoch_mismatch'
  | 'ack_policy_mismatch'
  | 'ack_content_hash_mismatch'
  | 'ack_intent_hash_mismatch'
  | 'ack_entry_count_mismatch'
  | 'ack_stale'
  | 'ack_capabilities_mismatch'
  | 'ack_capabilities_hash_invalid'
  | 'ack_effective_actions_mismatch'
  | 'other';
export interface CollectorFilterMetrics {
  /** @deprecated Compatibility marker for pre-decoupling forwarders. */
  scope: 'all' | 'shadow' | 'agent' | 'decoupled';
  /** True only for the Forwarder heartbeat emitted after its final snapshot and event drain. */
  shutdownFinal?: boolean;
  filterMode?: 'enforce' | 'shadow';
  retainUnknown?: boolean;
  retainNonAgent?: boolean;
  noisePolicy?: 'balanced' | 'include';
  observed: number;
  forwarded: number;
  confirmedAgent: number;
  probableAgent: number;
  unknown: number;
  /** Closed, low-cardinality S3 reason counts for this Forwarder delta window. */
  unknownReasonCounts?: Partial<Record<UnknownReason, number>>;
  nonAgent: number;
  filteredNonAgent: number;
  wouldFilterNonAgent: number;
  /** Unknown events suppressed by the broad retainUnknown policy (not discovery-budget pressure). */
  filteredUnknown: number;
  wouldFilterUnknown: number;
  filteredNoise: number;
  wouldFilterNoise: number;
  discoveryBudgetDropped: number;
  wouldDiscoveryBudgetDrop: number;
  /** Effective Collector pre-ring state: false when the explicit Unknown sample profile is active. */
  unknownFileLossless?: boolean;
  fileAggregationEnabled?: boolean;
  fileAggregationWindowMs?: number;
  fileAggregationPendingKeys?: number;
  fileAggregationCoalesced?: number;
  aggregatedFileEvents?: number;
  aggregationOutputs?: number;
  /** Trusted Collector summaries that traversed the Forwarder in this delta window. */
  captureAggregateOutputs?: number;
  /** Decision-op units represented by those summaries; never a physical event count. */
  captureAggregateDecisionAttempts?: number;
  captureProfileMode?: CollectorCaptureProfileMode;
  captureProfileActivationMode?: CollectorCaptureProfileActivationMode;
  captureProfileActivationReason?: CollectorCaptureProfileActivationReason;
  captureProfileControlPlaneState?: CollectorCaptureProfileControlState;
  captureProfileAckEnabled?: boolean;
  captureProfileAckAccepted?: number;
  captureProfileAckRejected?: number;
  captureProfileAckReplayIgnored?: number;
  captureProfileCentralAccepted?: number;
  captureProfileCentralRejected?: number;
  captureProfileActivationGrants?: number;
  captureProfileActivationRevoked?: number;
  captureProfileIntentChanges?: number;
  captureProfileTtlRefreshes?: number;
  captureProfileCoalescedTtlRefreshes?: number;
  captureProfileSemanticNoops?: number;
  captureProfileLkgDegraded?: number;
  captureProfileCapacityEvicted?: number;
  captureProfileCapacityAgentEvicted?: number;
  captureProfileOversizeSnapshots?: number;
  captureProfileReportInFlight?: boolean;
  captureProfileReportPosts?: number;
  captureProfileReportErrors?: number;
  captureProfileReportAccepted?: number;
  captureProfileReportRejected?: number;
  filterRulePublisherEnabled?: boolean;
  filterRuleEnforceDrops?: boolean;
  filterRuleVersion?: number;
  filterRuleEntries?: number;
  filterRuleWrites?: number;
  filterRuleErrors?: number;
  filterRuleConflicts?: number;
  unifiedCatalogVersion?: number;
  unifiedIdentityVersion?: number;
  unifiedCaptureVersion?: number;
  unifiedForwarderVersion?: number;
  unifiedRetentionVersion?: number;
  unifiedProjectionState?: 'bootstrap' | 'ready' | 'degraded';
  unifiedProjectionHash?: string;
  unifiedProjectionIntentHash?: string;
  unifiedProjectionLoads?: number;
  unifiedProjectionLoadErrors?: number;
  unifiedProjectionDegraded?: number;
  unifiedIdentityRules?: number;
  unifiedCaptureRules?: number;
  unifiedSemanticRules?: number;
  unifiedRuntimeSignatures?: number;
  unifiedAgentTemplates?: number;
  unifiedIdentityIndexBuckets?: number;
  unifiedCaptureIndexBuckets?: number;
  unifiedSemanticIndexBuckets?: number;
  unifiedMaxIndexBucketSize?: number;
  unifiedIdentityMatches?: number;
  unifiedCaptureMatches?: number;
  unifiedSemanticMatches?: number;
  unifiedSampleSuppressed?: number;
  infrastructure?: number;
  workspaceConflict?: number;
  infrastructurePolicyReady?: boolean;
  infrastructurePolicyVersion?: number;
  infrastructurePolicyRules?: number;
  infrastructurePolicyLoads?: number;
  infrastructurePolicyLoadErrors?: number;
  infrastructurePolicyMatches?: number;
  infrastructurePolicyWouldDrop?: number;
  infrastructurePolicyEnforced?: number;
  infrastructurePolicyAgentConflicts?: number;
  infrastructurePolicyMaterialized?: number;
  infrastructurePolicyExpiresInSeconds?: number;
  /** Test-only, bounded suppression receipts; absent outside explicitly armed lifecycle E2E. */
  e2eFilterReceipts?: Array<{
    schema: 'anysentry.e2e_filter_receipt.v1';
    eventKind: 'ToolExec';
    markerSha256: string;
    lineSha256: string;
    physicalWorkloadId?: string;
    classification: string;
    filterReason: string;
    filteredAt: string;
  }>;
  deduplicated: number;
  /** Live queue admissions that could not proceed but remain recoverable in the durable spool. */
  queueDropped: number;
  /** Queue-pressure records parked durably instead of being counted as permanent output loss. */
  queueParked?: number;
  /** Protected Agent/lifecycle/security evidence that could not enter the live queue. */
  protectedQueueDropped?: number;
  /** Closed, low-cardinality queue-loss classes; never contains an asset, path, PID or rule ID. */
  queueDroppedByClass?: Partial<Record<
    'tool_exec' | 'process_exit' | 'security' | 'collector_heartbeat' | 'capture_aggregate' | 'agent' | 'other',
    number
  >>;
  batches: number;
  batchEvents: number;
  /** Events first queued for an API-authorized backpressure retry in this heartbeat interval. */
  retryQueued?: number;
  /** Backpressure retry delivery attempts made in this heartbeat interval. */
  retryAttempts?: number;
  /** Retried events accepted or policy-discarded by the API in this heartbeat interval. */
  retryRecovered?: number;
  /** Retried events that reached a terminal outcome or exhausted their current online retry cycle. */
  retryExhausted?: number;
  /** Retry-exhausted events retained in the spool for a later bounded replay cycle. */
  retryParked?: number;
  /** Durable replay records examined/admitted/deferred during this heartbeat delta. */
  spoolReplayAttempts?: number;
  spoolReplayAdmitted?: number;
  spoolReplayDeferred?: number;
  /** Heartbeat delivery failures; intentionally separate from event output loss. */
  heartbeatDeliveryFailures?: number;
  /** Current independent control-plane lane state; counters remain cumulative diagnostics only. */
  controlPlaneState?: 'starting' | 'healthy' | 'degraded';
  controlPlaneFailedLanes?: Array<'identity' | 'filter_rules' | 'infrastructure_policy' | 'runtime_snapshot'>;
  controlPlaneStartingLanes?: Array<'identity' | 'filter_rules' | 'infrastructure_policy' | 'runtime_snapshot'>;
  controlPlaneLanes?: Partial<Record<
    'identity' | 'filter_rules' | 'infrastructure_policy' | 'runtime_snapshot',
    { lastSuccessAt?: string; lastFailureAt?: string; lastFailure?: string }
  >>;
  /** Current durable ownership state, including live and parked records. */
  spoolRecords?: number;
  spoolActiveRecords?: number;
  spoolParkedRecords?: number;
  spoolBytes?: number;
  spoolWalBytes?: number;
  spoolOldestAgeMs?: number;
  spoolAtCapacity?: boolean;
  spoolFsyncMode?: 'always' | 'periodic';
  /** Serialized bytes currently waiting in the ordinary priority queue. */
  queueBytes?: number;
  /** Events currently owned by active event-delivery requests. */
  inflightEvents?: number;
  inflightBytes?: number;
  inflightOldestAgeMs?: number;
  /** Events waiting for their next API-authorized retry attempt. */
  retryQueueDepth?: number;
  retryQueueBytes?: number;
  /** All retry-owned events, including retry requests currently in flight. */
  retryOutstandingEvents?: number;
  retryOutstandingBytes?: number;
  retryOldestAgeMs?: number;
  /** Total forwarder-owned events across pending, in-flight, and retry states. */
  outstandingEvents?: number;
  outstandingBytes?: number;
  outstandingOldestAgeMs?: number;
  outstandingEventLimit?: number;
  outstandingByteLimit?: number;
  protectedReserveEvents?: number;
  protectedReserveBytes?: number;
  identitySnapshotReady: boolean;
  /** Combined local discovery generation retained for compatibility (Kubernetes + Docker). */
  identitySnapshotVersion: number;
  /** Central API identity/snapshot generation; this is the version comparable with server intent. */
  identityKubernetesVersion?: number;
  /** Node-local Docker discovery generation; never compared to the central Kubernetes snapshot. */
  identityDockerVersion?: number;
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
  processLaunchContextProcReads?: number;
  processLaunchContextEnvironmentReads?: number;
  launchSystemdQueries?: number;
  launchSystemdCacheHits?: number;
  launchSystemdErrors?: number;
  launchSystemdCacheEntries?: number;
  processRootsDiscovered?: number;
  processRootsExited?: number;
  processRootsLost?: number;
  processRootsRecovered?: number;
  processRootLivenessChecks?: number;
  processRootLivenessMisses?: number;
  processStaleGenerationMisses?: number;
  runtimeSignatureVersion?: number;
  runtimeSignatureHash?: string;
  runtimeSignatureMatcherHash?: string;
  runtimeSignatureLoaded?: number;
  runtimeSignatureMatches?: number;
  runtimeSignatureMisses?: number;
  runtimeSignatureAmbiguous?: number;
  runtimeSignatureInvalid?: number;
  runtimeSignatureReloadAttempts?: number;
  runtimeSignatureReloadSuccesses?: number;
  runtimeSignatureReloadErrors?: number;
  runtimeSignatureLastGoodHash?: string;
  runtimeReconcileRequested?: number;
  runtimeReconcileRuns?: number;
  runtimeReconcileCoalesced?: number;
  runtimeReconcileErrors?: number;
  runtimeReconcileScanned?: number;
  runtimeReconcileInvalidated?: number;
  runtimeReconcileLastDurationMs?: number;
  runtimeSnapshotPosts?: number;
  runtimeSnapshotErrors?: number;
  /** Runtime snapshot attempts retried after a transient transport failure. */
  runtimeSnapshotRetries?: number;
  /** Transient runtime snapshot failures followed by a successful retry. */
  runtimeSnapshotRecovered?: number;
  runtimeLeaseEpoch?: number;
  runtimeLeaseAttempts?: number;
  runtimeLeaseErrors?: number;
  runtimeLeaseFenced?: boolean;
  runtimeSnapshotRejected?: number;
  runtimeSnapshotDuplicates?: number;
  lastRuntimeSnapshotAt?: string;
  lastRuntimeSnapshotError?: string;
  /** Sticky timestamp for the most recent terminal or exhausted snapshot failure. */
  lastRuntimeSnapshotFailureAt?: string;
  /** Sticky bounded reason for the most recent terminal or exhausted snapshot failure. */
  lastRuntimeSnapshotFailure?: string;
  /** Snapshot version associated with the most recent failure. */
  lastRuntimeSnapshotFailureVersion?: number;
  /** Sticky timestamp for the most recent transient snapshot retry. */
  lastRuntimeSnapshotRetryAt?: string;
  /** Sticky bounded reason that triggered the most recent retry. */
  lastRuntimeSnapshotRetryReason?: string;
}

/** Raw Observer ring-before filtering and per-ring loss counters; never merge with Forwarder metrics. */
export interface CollectorFileFilterMetrics {
  fileAccess: number;
  fileDelete: number;
  accessKept: number;
  accessUnknownKept?: number;
  accessSampled: number;
  accessDropped: number;
  accessSuppressed: number;
  deleteKept: number;
  deleteUnknownKept?: number;
  deleteDropped: number;
  ruleHits: number;
  ruleMisses: number;
  staleRules: number;
  accessRingDropped: number;
  deleteRingDropped: number;
  enabled: boolean;
  epoch: number;
  unknownPolicy?: 'keep' | 'sample';
}
export type CollectorCaptureProbeName =
  | 'exec'
  | 'exit'
  | 'tls'
  | 'connect'
  | 'dns'
  | 'file_access'
  | 'file_delete'
  | 'llm'
  | 'ssl'
  | 'security'
  | 'file_read';
export interface CollectorCaptureProbeMetrics {
  probe: CollectorCaptureProbeName;
  attempted: number;
  fullSelected: number;
  aggregateSelected: number;
  sampleSelected: number;
  sampleRejected: number;
  dropSelected: number;
  notEnabled: number;
  decisionError: number;
  /** Quality overlays; not terminal decision outcomes. */
  probeError: number;
  promotionError: number;
  aggregateError: number;
  /** True when at least one producer number could not be represented as an exact safe integer. */
  countersClamped: boolean;
  payloadSelected: number;
  payloadError: number;
  ringSubmitted: number;
  ringDropped: number;
  wouldFull: number;
  wouldAggregate: number;
  wouldSample: number;
  wouldDrop: number;
  ruleHit: number;
  ruleMiss: number;
  staleRule: number;
  promotionHit: number;
  /** Server-derived conservation checks over decision-op units. */
  decisionResidual: number;
  decisionConserved: boolean;
  /** Exec emits multiple physical records, so its payload/ring residual is intentionally absent. */
  payloadResidual?: number;
  payloadConserved?: boolean;
}
export interface CollectorCaptureProfileMetrics {
  mode: CollectorCaptureProfileMode;
  activeEpoch: number;
  destructiveEnabled: boolean;
  decisionUnit: 'decision_op';
  payloadUnit: 'single_record_candidate';
  deliveryUnit: 'physical_record';
  sampleNodeLimitPerWindow: number;
  aggregateKeys: number;
  aggregateEmitted: number;
  aggregateOutputRetried: number;
  aggregateCleaned: number;
  aggregateReadErrors: number;
  aggregateLedgerDegraded: boolean;
  countersClamped: boolean;
  decisionConserved: boolean;
  payloadConserved: boolean;
  probes: CollectorCaptureProbeMetrics[];
}
export interface CollectorHeartbeatRecord extends Required<Pick<CollectorRawHeartbeatRequest, 'collectorId' | 'status'>> {
  at: number;
  /** Server-filled on new records; optional only for persisted pre-classification history. */
  activityContext?: 'collector_heartbeat';
  activitySubtype?: 'observer_heartbeat';
  /** Server-assigned ingress provenance; absent only on records persisted before provenance existed. */
  origin?: CollectorHeartbeatOrigin;
  /** Set only when this record carried Forwarder-enriched filter metrics. */
  filterMetricsReportedAt?: number;
  /** Set only when a raw Observer heartbeat carried ring-before file-filter metrics. */
  fileFilterMetricsReportedAt?: number;
  /** Set only when a raw Observer heartbeat carried validated S5 pre-ring accounting. */
  captureProfileMetricsReportedAt?: number;
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
  legacyCounterTemporality?: CollectorPipelineTemporality;
  observedAgents: number;
  pipelineAccounting?: CollectorPipelineAccounting;
  /** Present only when this record originated from a raw CollectorHeartbeat with quality fields. */
  execEvidence?: CollectorExecEvidenceReport;
  filterMetrics: CollectorFilterMetrics;
  fileFilterMetrics?: CollectorFileFilterMetrics;
  captureProfileMetrics?: CollectorCaptureProfileMetrics;
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
  /** Current channel health; requested-window maxima remain independent historical evidence. */
  healthChannels: {
    capture: CollectorHealthChannel;
    delivery: CollectorHealthChannel;
    control: CollectorHealthChannel;
  };
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
  /** Maximum counter readings reported by heartbeat records in the requested health window. */
  windowErrorMaxima: {
    droppedEvents: number;
    outputDropped: number;
    errorCount: number;
  };
  execEvidence: CollectorExecEvidenceHealth;
  /** Absent for legacy heartbeats, preserving the old response contract byte-for-byte. */
  pipelineAccounting?: CollectorPipelineAccountingHealth;
  /** True only when filterMetrics came from a fresh Forwarder heartbeat, not the decoupled fallback. */
  filterMetricsReported: boolean;
  filterMetrics: CollectorFilterMetrics;
  /** True only when fileFilterMetrics came from a fresh raw Observer heartbeat. */
  fileFilterMetricsReported: boolean;
  fileFilterMetrics: CollectorFileFilterMetrics;
  /** Independent raw Collector S5 channel; never sourced from Forwarder filter metrics. */
  captureProfileMetricsReported: boolean;
  captureProfileMetrics?: CollectorCaptureProfileMetrics;
  message?: string;
  eventCategoryCounts: Record<EventCategory, number>;
}
export interface CollectorHealthSummary {
  totalCollectors: number;
  healthyCollectors: number;
  quietCollectors: number;
  warningCollectors: number;
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
  coverage?: QueryCoverage;
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
  /** Distinct evidence events retained for this alert. Platform-only alerts can legitimately be 0. */
  evidenceEventCount?: number;
  /** Bounded evidence identity set used to avoid counting the same event revision twice. */
  evidenceEventIds?: string[];
  lastNotificationAt?: number;
  labels: Record<string, string>;
  monitored?: boolean;
  agentScopeId?: string;
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
  status?: AlertStatus | 'active' | 'all';
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
  /**
   * window: alerts observed/updated in the selected time range;
   * backlog: currently active alerts regardless of age;
   * combined: legacy behavior that returns both.
   */
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

export type CorrelationClaimAuthority = 'application' | 'agent_adapter' | 'observer_runtime';

/**
 * Trust bindings are deliberately separate from the source's learned display identity
 * (`collectorId` / `workspacePath`). Runtime check-ins must never widen this allow-list.
 */
export interface IngestionSourceCorrelationClaimBindings {
  tenantIds: string[];
  environmentIds: string[];
  workspaceIds: string[];
  workspacePaths: string[];
  collectorIds: string[];
  physicalWorkloadIds: string[];
  agentScopeIds: string[];
}

export interface IngestionSourceCorrelationClaimsPolicy {
  enabled: boolean;
  authority?: CorrelationClaimAuthority;
  bindings: IngestionSourceCorrelationClaimBindings;
}

export interface IngestionSourceCorrelationClaimsPolicyInput {
  enabled?: boolean;
  authority?: CorrelationClaimAuthority;
  bindings?: Partial<IngestionSourceCorrelationClaimBindings>;
}

export type CorrelationClaimAuthorizationReason =
  | 'authorized'
  | 'source_unresolved'
  | 'source_disabled'
  | 'source_discovered'
  | 'policy_disabled'
  | 'policy_invalid'
  | 'protected_source_required'
  | 'token_missing'
  | 'token_invalid'
  | 'source_id_mismatch'
  | 'authority_missing'
  | 'authority_mismatch'
  | 'source_type_not_allowed'
  | 'claim_scope_missing'
  | 'required_scope_missing'
  | 'tenant_binding_missing'
  | 'tenant_binding_mismatch'
  | 'environment_binding_missing'
  | 'environment_binding_mismatch'
  | 'workspace_binding_missing'
  | 'workspace_binding_mismatch'
  | 'collector_binding_missing'
  | 'collector_binding_mismatch'
  | 'workload_binding_missing'
  | 'workload_binding_mismatch'
  | 'agent_binding_missing'
  | 'agent_binding_mismatch';

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
  correlationClaims?: IngestionSourceCorrelationClaimsPolicy;
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
export interface IngestionSourceCurrentActivity {
  sourceId: string;
  lastSeenAt: number;
  lastEventAt?: number;
  lastHeartbeatAt?: number;
  collectorId?: string;
  workspacePath?: string;
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
  correlationClaims?: IngestionSourceCorrelationClaimsPolicyInput;
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
  /** Maximum latest event facts replayed. The simulator is intentionally sampled, never full scan. */
  sampleLimit?: number;
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
export interface PolicySimulationResult extends ClassifiedResponseMeta {
  summary: PolicySimulationSummary;
  diffs: PolicySimulationDiff[];
  byAgent: PolicySimulationGroup[];
  byWorkspace: PolicySimulationGroup[];
  sampling: {
    strategy: 'latest_event_sample';
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
  includeBacklog?: boolean;
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

export type PlatformUserRole = 'administrator' | 'security_analyst' | 'operator' | 'viewer';
export type PlatformUserStatus = 'active' | 'disabled';
export type PlatformUserSource = 'local';
export interface PlatformUserRecord {
  schemaVersion: 'anysentry.platform_user.v1';
  userId: string;
  username: string;
  displayName: string;
  email?: string;
  team?: string;
  role: PlatformUserRole;
  status: PlatformUserStatus;
  source: PlatformUserSource;
  note?: string;
  createdAt: number;
  updatedAt: number;
  updatedBy: string;
}
export interface PlatformUserItem extends Omit<PlatformUserRecord, 'createdAt' | 'updatedAt'> {
  createdAt: string;
  updatedAt: string;
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
  role?: PlatformUserRole | 'all';
  status?: PlatformUserStatus | 'all';
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

export type AuditActorType = 'system' | 'operator' | 'api';
export type AuditAction =
  | 'policy.updated'
  | 'policy.simulated'
  | 'supply-chain.config.updated'
  | 'incident.updated'
  | 'alert.updated'
  | 'remediation.updated'
  | 'agent.metadata.updated'
  | 'agent.review.updated'
  | 'agent.review.cleared'
  | 'asset.review.updated'
  | 'asset.review.cleared'
  | 'agent.identity_ai_review.completed'
  | 'agent.interaction.content.read'
  | 'agent.conversation.content.list'
  | 'agent.conversation.content.read'
  | 'agent.semantic_evidence.read'
  | 'maintenance.window.updated'
  | 'notification.channel.updated'
  | 'notification.route.updated'
  | 'notification.delivery_failed'
  | 'objective.updated'
  | 'source.updated'
  | 'source.token_rotated'
  | 'user.updated'
  | 'infrastructure_rule.created'
  | 'infrastructure_rule.shadowed'
  | 'infrastructure_rule.promoted'
  | 'infrastructure_rule.revoked'
  | 'infrastructure_rule.validated'
  | 'infrastructure_rule.materialization_reported'
  | 'filter_rule.created'
  | 'filter_rule.shadowed'
  | 'filter_rule.promoted'
  | 'filter_rule.revoked'
  | 'filter_rule.previewed'
  | 'unknown_learning.reviewed'
  | 'unknown_learning.policy_updated'
  | 'unknown_learning.infrastructure_draft_created'
  | 'unknown_learning.infrastructure_draft_reused'
  | 'unknown_learning.infrastructure_draft_rejected'
  | 'unknown_learning.config_updated';
export type AuditResourceType = 'policy' | 'filter-rule' | 'infrastructure-rule' | 'unknown-learning' | 'supply-chain' | 'incident' | 'alert' | 'remediation' | 'agent' | 'asset' | 'event' | 'maintenance' | 'notification' | 'objective' | 'source' | 'user';
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

export type SecurityAssistantLocale = 'en' | 'zh-CN';
export type SecurityAssistantMessageRole = 'user' | 'assistant';

export interface SecurityAssistantMessage {
  role: SecurityAssistantMessageRole;
  content: string;
}

export interface SecurityAssistantContext {
  path?: string;
  view?: string;
  timeType?: SecurityTimeFilter['timeType'];
  startTime?: string;
  endTime?: string;
  agentId?: string;
  workspacePath?: string;
  eventId?: string;
  traceId?: string;
  /** Additive trusted-correlation selectors; legacy Trace/Session semantics remain unchanged. */
  agentAssetId?: string;
  agentInstanceId?: string;
  invocationId?: string;
  toolCallId?: string;
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
  kind: 'event' | 'alert' | 'incident' | 'episode' | 'vulnerability' | 'view';
  id: string;
  label: string;
  href: string;
}

export interface SecurityAssistantSystemContextSummary {
  status: 'complete' | 'partial';
  requested: boolean;
  agentAssetId?: string;
  bundleId?: string;
  confidence?: number;
  estimatedBytes?: number;
  reasonCodes: string[];
}

export interface SecurityAssistantAnswer {
  sessionId: string;
  answer: string;
  model: string;
  elapsedMs: number;
  totalTokens: number;
  evidenceSummary: string;
  /** Quality summary for the bounded System Context actually supplied to the risk assistant. */
  systemContext?: SecurityAssistantSystemContextSummary;
  references: SecurityAssistantReference[];
  readOnly: true;
}
