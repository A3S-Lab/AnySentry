export const INFRASTRUCTURE_RULE_STATE_SCHEMA = 'anysentry.infrastructure_rule_state.v1' as const;
export const INFRASTRUCTURE_POLICY_SCHEMA = 'anysentry.infrastructure_policy_snapshot.v1' as const;
export const INFRASTRUCTURE_MATERIALIZATION_SCHEMA = 'anysentry.infrastructure_materialization_report.v1' as const;
export const INFRASTRUCTURE_CAPTURE_INTENT_SCHEMA = 'anysentry.infrastructure_capture_intent.v1' as const;

export type InfrastructurePlacement = 'kubernetes' | 'docker' | 'host';
export type InfrastructureRuleAuthority = 'candidate' | 'authoritative';
export type InfrastructureRuleStage = 'draft' | 'shadow' | 'enforced' | 'revoked';
export type InfrastructureFilterAction = 'keep' | 'sample' | 'drop';
export type CaptureProbeAction = 'full' | 'aggregate' | 'sample' | 'drop' | 'not_enabled';
export type CaptureProbeName =
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
export type CaptureProbeActions = Record<CaptureProbeName, CaptureProbeAction>;
export type InfrastructureCaptureIntentAction = 'full' | 'aggregate' | 'sample' | 'drop';
export type InfrastructureWorkloadRole = 'anysentry_internal' | 'platform_infrastructure' | 'business_service' | 'ordinary_process';
export interface InfrastructureCaptureIntentV1 {
  schemaVersion: typeof INFRASTRUCTURE_CAPTURE_INTENT_SCHEMA;
  action: InfrastructureCaptureIntentAction;
}
export type InfrastructureEventPolicyKind =
  | 'default'
  | 'FileAccess'
  | 'FileDelete'
  | 'Egress'
  | 'Dns'
  | 'SslContent'
  | 'LlmCall';
export type InfrastructureRuleSourceType =
  | 'manual_review'
  | 'platform_inventory'
  | 'kubernetes'
  | 'docker'
  | 'operator'
  | 'behavior_discovery'
  | 'imported';

export interface InfrastructureRuleSelector {
  placement: InfrastructurePlacement;
  nodeId?: string;
  clusterId?: string;
  namespace?: string;
  ownerKind?: string;
  ownerName?: string;
  serviceAccount?: string;
  composeProject?: string;
  serviceName?: string;
  containerName?: string;
  imageDigest?: string;
  systemdUnit?: string;
  configuredRoot?: string;
  labels: Record<string, string>;
}

export interface InfrastructureRuleSource {
  type: InfrastructureRuleSourceType;
  sourceRef?: string;
  issuer: string;
}

export interface InfrastructureRuleRecord {
  schemaVersion: 'anysentry.infrastructure_rule.v1';
  ruleId: string;
  revision: number;
  name: string;
  selector: InfrastructureRuleSelector;
  effect: 'infrastructure';
  source: InfrastructureRuleSource;
  authority: InfrastructureRuleAuthority;
  lifecycleStage: InfrastructureRuleStage;
  reasonCode: string;
  /** Stable logical role retained from server-owned Inventory; older records are inferred safely. */
  workloadRole?: InfrastructureWorkloadRole;
  priority: number;
  /**
   * Versioned Ring-before intent. When absent, eventPolicies retain their legacy v1 semantics,
   * including the historical default DROP behavior.
   */
  captureIntent?: InfrastructureCaptureIntentV1;
  eventPolicies?: Partial<Record<InfrastructureEventPolicyKind, InfrastructureFilterAction>>;
  createdAt: number;
  updatedAt: number;
  createdBy: string;
  approvedBy?: string;
  changeTicket?: string;
  contentHash: string;
}

export interface InfrastructureRuleStateDocument {
  schemaVersion: typeof INFRASTRUCTURE_RULE_STATE_SCHEMA;
  stateVersion: number;
  policyVersion: number;
  updatedAt: number;
  rules: InfrastructureRuleRecord[];
  revisions: InfrastructureRuleRecord[];
  materializationReports: InfrastructureMaterializationReportRecord[];
  operations?: InfrastructureRuleOperationRecord[];
}

export interface InfrastructureRuleCreateRequest {
  name?: string;
  selector?: Partial<InfrastructureRuleSelector>;
  source?: Partial<InfrastructureRuleSource>;
  reasonCode?: string;
  workloadRole?: InfrastructureWorkloadRole;
  priority?: number;
  captureIntent?: InfrastructureCaptureIntentV1;
  eventPolicies?: Partial<Record<InfrastructureEventPolicyKind, InfrastructureFilterAction>>;
  changeTicket?: string;
}

/**
 * Explicit management bridge from a fully reviewed S8 recommendation into the existing
 * Infrastructure Rule workflow. The operation creates only a candidate/draft rule; these fields
 * are evidence and optimistic-concurrency fences, not authority claims.
 */
export interface UnknownInfrastructureDraftRequest {
  expectedPolicyRevision?: number;
  expectedReviewRevision?: number;
  workload?: InfrastructureInventoryWorkload;
  name?: string;
  reason?: string;
  priority?: number;
  eventPolicies?: Partial<Record<InfrastructureEventPolicyKind, InfrastructureFilterAction>>;
  changeTicket?: string;
}

export interface UnknownInfrastructureRecommendationEvidence {
  policyId: string;
  policyRevision: number;
  familyId: string;
  clusterId: string;
  reviewRevision: number;
  desiredAction: 'keep' | 'sample' | 'aggregate';
  stableScope: string;
  eventKind: string;
}

export interface UnknownInfrastructureDraftResult {
  rule: InfrastructureRuleRecord;
  created: boolean;
  bridge: {
    policyId: string;
    policyRevision: number;
    familyId: string;
    reviewRevision: number;
    desiredAction: 'keep' | 'sample' | 'aggregate';
    physicalWorkloadIdHash: string;
    scopeBindingHash: string;
    /** Always false: this bridge operation never changes the returned rule's lifecycle stage. */
    operationDestructive: false;
  };
}

export interface InfrastructureInventoryWorkload {
  placement: InfrastructurePlacement;
  nodeId?: string;
  clusterId?: string;
  namespace?: string;
  ownerKind?: string;
  ownerName?: string;
  serviceAccount?: string;
  composeProject?: string;
  serviceName?: string;
  containerName?: string;
  imageDigest?: string;
  systemdUnit?: string;
  configuredRoot?: string;
  labels?: Record<string, string>;
  physicalWorkloadId: string;
  classification?: 'confirmed_agent' | 'probable_agent' | 'unknown' | 'non_agent';
}

export interface InfrastructureRuleValidationRequest {
  inventory?: InfrastructureInventoryWorkload[];
}

export interface InfrastructureRuleValidationResult {
  ruleId: string;
  revision: number;
  valid: boolean;
  errors: string[];
  warnings: string[];
  matchedWorkloads: number;
  matchedPhysicalWorkloadIds: string[];
  agentConflicts: number;
  agentConflictPhysicalWorkloadIds: string[];
  effectiveAction: InfrastructureFilterAction;
  canPromoteToEnforced: boolean;
}

export interface InfrastructureRuleTransitionRequest {
  expectedRevision?: number;
  reason?: string;
  changeTicket?: string;
}

export interface InfrastructureRuleListResult {
  items: InfrastructureRuleRecord[];
  total: number;
  stateVersion: number;
  policyVersion: number;
  updateTime: string;
}

export type InfrastructureRuleOperationKind = 'asset_draft' | 'shadow' | 'promote' | 'revoke';
export type InfrastructureRuleOperationStatus = 'pending' | 'succeeded' | 'failed';

export interface InfrastructureRuleOperationRecord {
  operationId: string;
  kind: InfrastructureRuleOperationKind;
  status: InfrastructureRuleOperationStatus;
  ruleId?: string;
  requestedAt: number;
  completedAt?: number;
  actorId: string;
  previousRevision?: number;
  resultingRevision?: number;
  previousStage?: InfrastructureRuleStage;
  targetStage: InfrastructureRuleStage;
  reason?: string;
  errorCode?: string;
  error?: string;
  persisted?: boolean;
}

export interface InfrastructureRuleHumanScopeField {
  code: string;
  label: string;
  value: string;
}

export interface InfrastructureRuleHumanProbePolicy {
  probe: CaptureProbeName;
  label: string;
  action: CaptureProbeAction;
  actionLabel: string;
  protected: boolean;
}

export interface InfrastructureRuleHumanSummary {
  ruleId: string;
  revision: number;
  name: string;
  scope: {
    placement: InfrastructurePlacement;
    label: string;
    fields: InfrastructureRuleHumanScopeField[];
  };
  intent: {
    action: InfrastructureCaptureIntentAction;
    label: string;
    description: string;
    destructive: boolean;
  };
  protectedSignals: InfrastructureRuleHumanProbePolicy[];
  status: {
    stage: InfrastructureRuleStage;
    label: string;
    authority: InfrastructureRuleAuthority;
    destructiveActive: boolean;
  };
  sourceLabel: string;
  reasonLabel: string;
  priority: number;
  createdBy: string;
  approvedBy?: string;
  createdAt: string;
  updatedAt: string;
  matchedNodes: number;
  matchedInstances: number;
  agentConflicts: number;
  lastControlUpdate?: string;
  latestOperation?: InfrastructureRuleOperationRecord;
}

export interface InfrastructureRuleHumanDetail extends InfrastructureRuleHumanSummary {
  operationHistory: InfrastructureRuleOperationRecord[];
  revisionHistory: Array<{
    revision: number;
    stage: InfrastructureRuleStage;
    authority: InfrastructureRuleAuthority;
    updatedAt: string;
    approvedBy?: string;
  }>;
  control: {
    reports: number;
    acceptedBindings: number;
    activeBindings: number;
    conflicts: number;
    nodes: string[];
    lastReportAt?: string;
  };
}

export interface InfrastructureRuleHumanListResult {
  items: InfrastructureRuleHumanSummary[];
  total: number;
  stateVersion: number;
  policyVersion: number;
  updateTime: string;
}

export interface InfrastructureAssetDraftRequest {
  assetId?: string;
  expectedAssetRevision?: number;
  intent?: InfrastructureCaptureIntentAction;
  name?: string;
  reason?: string;
  priority?: number;
  changeTicket?: string;
}

export interface InfrastructureAssetDraftResult {
  created: boolean;
  rule: InfrastructureRuleHumanDetail;
  operation: InfrastructureRuleOperationRecord;
  asset: {
    assetId: string;
    revision: number;
    displayName: string;
  };
}

export type InfrastructureRuleImpactPartialReason =
  | 'agent_event_inventory_partial'
  | 'agent_event_inventory_truncated'
  | 'agent_fact_not_in_current_runtime_inventory'
  | 'asset_snapshot_duplicate_collapsed'
  | 'lifecycle_current_presence_unverified'
  | 'observation_coverage_unavailable'
  | 'service_context_inventory_not_ready'
  | 'service_context_asset_unmapped'
  | 'service_context_metrics_unavailable'
  | 'service_context_stale'
  | 'continuity_evidence_unavailable';

export interface InfrastructureRuleImpactPreview {
  ruleId: string;
  revision: number;
  snapshotVersion: number;
  generatedAt: string;
  provider: string;
  valid: boolean;
  errors: string[];
  warnings: string[];
  matchedAssets: number;
  matchedInstances: number;
  matchedNodes: number;
  agentConflicts: number;
  sharedScopeConflicts: number;
  recentLogicalEvents?: number;
  signalCounts?: Partial<Record<InfrastructureEventPolicyKind, number>>;
  expectedSignals: InfrastructureRuleHumanProbePolicy[];
  lifecycleContinuous: boolean;
  serviceContextContinuous: boolean;
  partialReasons: InfrastructureRuleImpactPartialReason[];
  canEnterShadow: boolean;
  canPromoteToEnforced: boolean;
}

export interface InfrastructureRuleOperationListResult {
  items: InfrastructureRuleOperationRecord[];
  total: number;
  updateTime: string;
}

export interface InfrastructurePolicySnapshot {
  schemaVersion: typeof INFRASTRUCTURE_POLICY_SCHEMA;
  policyVersion: number;
  generatedAt: string;
  expiresAt: string;
  contentHash: string;
  rules: InfrastructureRuleRecord[];
}

export interface InfrastructureMaterializedBindingInput {
  ruleId: string;
  ruleRevision: number;
  physicalWorkloadId: string;
  runtimeObjectUid?: string;
  containerId?: string;
  cgroupId: string;
  inventoryGeneration?: number;
  agentKeepConflict?: boolean;
  action: InfrastructureFilterAction;
  effectiveAction?: InfrastructureFilterAction;
  captureProfile?:
    | 'agent_full'
    | 'probable_investigation'
    | 'security_full'
    | 'investigation_full'
    | 'business_context'
    | 'infrastructure_aggregate'
    | 'unknown_discovery'
    | 'self_health';
  captureIntent?: InfrastructureCaptureIntentV1;
  probeActions?: CaptureProbeActions;
  desiredProbeActions?: CaptureProbeActions;
  expiresAt?: string;
}

export interface CaptureProfileAckV1 {
  schemaVersion?: 'anysentry.capture_profile_ack.v1';
  nodeId?: string;
  collectorId?: string;
  collectorInstanceId?: string;
  hostBootId?: string;
  publisherInstanceId?: string;
  epoch?: number;
  policyVersion?: number;
  contentHash?: string;
  intentHash?: string;
  entriesApplied?: number;
  appliedAt?: string;
  status?: 'applied' | 'degraded' | 'rejected';
  errors?: string[];
  downgrades?: unknown[];
  capabilities?: {
    schemaVersions?: string[];
    probeNames?: string[];
    probeActions?: string[];
    captureProfileModes?: string[];
    activationGrantV1?: boolean;
    selectiveFileRead?: boolean;
  };
  capabilitiesHash?: string;
  effectiveActionsHash?: string;
}

export interface InfrastructureMaterializationReportRequest {
  schemaVersion?: typeof INFRASTRUCTURE_MATERIALIZATION_SCHEMA;
  reportId?: string;
  nodeId?: string;
  policyVersion?: number;
  epoch?: number;
  snapshotContentHash?: string;
  intentHash?: string;
  activationMode?: 'preview';
  publisherInstanceId?: string;
  expectedEntries?: number;
  ack?: CaptureProfileAckV1;
  bindings?: InfrastructureMaterializedBindingInput[];
  errors?: string[];
}

export interface InfrastructureFilterRuleEntry {
  scopeType: 'cgroup';
  scopeKey: string;
  cgroupId: string;
  classification: 'confirmed_agent' | 'non_agent';
  authority: InfrastructureRuleAuthority;
  action: InfrastructureFilterAction;
  effectiveAction?: InfrastructureFilterAction;
  captureProfile?: InfrastructureMaterializedBindingInput['captureProfile'];
  captureIntent?: InfrastructureCaptureIntentV1;
  probeActions?: CaptureProbeActions;
  desiredProbeActions?: CaptureProbeActions;
  reasonCode: string;
  source: InfrastructureRuleSourceType;
  physicalWorkloadId: string;
  ruleId: string;
  ruleRevision: number;
  policyVersion: number;
  materializationId: string;
  epoch: number;
  expiresAt: string;
}

export interface InfrastructureMaterializationReportRecord {
  schemaVersion: typeof INFRASTRUCTURE_MATERIALIZATION_SCHEMA;
  reportId: string;
  nodeId: string;
  policyVersion: number;
  epoch: number;
  accepted: true;
  snapshotContentHash?: string;
  intentHash?: string;
  activationMode?: 'preview';
  publisherInstanceId?: string;
  expectedEntries?: number;
  ack?: CaptureProfileAckV1;
  reportedAt: number;
  bindings: InfrastructureMaterializedBindingInput[];
  filterRuleEntries: InfrastructureFilterRuleEntry[];
  conflicts: number;
  errors: string[];
}

export interface InfrastructureRuleActor {
  id: string;
  displayName?: string;
  type: 'system' | 'operator' | 'api';
}
