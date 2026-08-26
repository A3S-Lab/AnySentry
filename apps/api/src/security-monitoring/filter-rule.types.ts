import type {
  AgentClassification,
  CaptureProfile,
  WorkloadRole,
} from './types';

export const FILTER_RULE_SCHEMA = 'anysentry.filter_rule.v1' as const;
export const FILTER_RULE_STATE_SCHEMA = 'anysentry.filter_rule_state.v1' as const;
export const FILTER_RULE_PROJECTION_SCHEMA = 'anysentry.filter_rule_projection.v1' as const;
export const FILTER_RULE_DECISION_RECEIPT_SCHEMA = 'anysentry.filter_rule_decision_receipt.v1' as const;

export type FilterRuleStage = 'f0' | 'f1' | 'f2' | 'f3';
export type FilterRuleCategory =
  | 'agent_identity'
  | 'infrastructure'
  | 'capture_profile'
  | 'forwarder_retention'
  | 'api_retention'
  | 'safety_guardrail'
  | 'investigation'
  | 'learning_candidate';
export type FilterRuleKind =
  | 'runtime_signature'
  | 'agent_template'
  | 'deployment_binding'
  | 'reviewed_identity_binding'
  | 'behavior_candidate'
  | 'workload_role_binding'
  | 'capture_profile'
  | 'signal_enablement'
  | 'semantic_retention'
  | 'persistence_retention'
  | 'safety_guardrail'
  | 'investigation_override'
  | 'learning_candidate';
export type FilterRuleLifecycleStage = 'draft' | 'shadow' | 'enforced' | 'revoked';
export type FilterRuleAuthority = 'candidate' | 'authoritative' | 'immutable' | 'recommendation_only';
export type FilterRuleManagement = 'catalog' | 'adapter' | 'builtin';
export type FilterRuleSourceType =
  | 'builtin'
  | 'operator'
  | 'platform_inventory'
  | 'kubernetes'
  | 'docker'
  | 'manual_review'
  | 'authenticated_adapter'
  | 'behavior'
  | 'unknown_learning'
  | 'compatibility';

export type FilterRuleConditionField =
  | 'process.comm'
  | 'process.exe_basename'
  | 'process.argv0_basename'
  | 'process.argv_prefix'
  | 'identity.classification'
  | 'workload.role'
  | 'workload.placement'
  | 'workload.cluster'
  | 'workload.namespace'
  | 'workload.owner_kind'
  | 'workload.owner_name'
  | 'workload.container'
  | 'workload.service'
  | 'workload.systemd_unit'
  | 'workload.label'
  | 'asset.id'
  | 'runtime.id'
  | 'runtime.state'
  | 'binding.quality'
  | 'signal.name'
  | 'event.kind'
  | 'event.probe'
  | 'decision.conflict'
  | 'decision.structural_risk'
  | 'control.stale';
export type FilterRuleConditionOperator = 'equals' | 'one_of' | 'prefix' | 'present';

export interface FilterRuleCondition {
  field: FilterRuleConditionField;
  operator: FilterRuleConditionOperator;
  value?: string | boolean | string[];
  /** Required only when field=workload.label. */
  key?: string;
}

export interface FilterRuleMatcher {
  all?: FilterRuleCondition[];
  any?: FilterRuleCondition[];
  description: string;
}

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
export type CaptureProbeAction = 'full' | 'aggregate' | 'sample' | 'drop' | 'not_enabled';
export type CaptureProbeActions = Record<CaptureProbeName, CaptureProbeAction>;
export type ForwarderRetentionAction = 'keep' | 'aggregate' | 'sample' | 'suppress' | 'priority';
export type ApiRetentionAction =
  | 'retain_full'
  | 'retain_l1_only'
  | 'structural_consume'
  | 'store_aggregate'
  | 'discard'
  | 'reject';

export type FilterRuleEffect =
  | {
      type: 'emit_identity';
      classification: AgentClassification;
      confidence: number;
      captureProfile?: CaptureProfile;
    }
  | {
      type: 'assign_role';
      role: WorkloadRole;
      captureProfile?: CaptureProfile;
    }
  | {
      type: 'assign_capture_profile';
      captureProfile: CaptureProfile;
      probeActions: CaptureProbeActions;
    }
  | {
      type: 'enable_signal';
      signal: 'file_open_read';
      captureAction: 'full';
      scopeMode: 'exact_runtime_or_root';
      reasonCode: string;
    }
  | {
      type: 'semantic_retention';
      action: ForwarderRetentionAction;
      reasonCode: string;
    }
  | {
      type: 'persistence_retention';
      action: ApiRetentionAction;
      reasonCode: string;
    }
  | {
      type: 'protect';
      captureAction: 'full' | 'structural';
      forwarderAction: 'keep' | 'priority';
      persistenceAction: 'retain_full' | 'structural_consume';
      reasonCode: string;
    }
  | {
      type: 'investigation';
      captureProfile: 'investigation_full';
      expiresAt: string;
      reasonCode: string;
    }
  | {
      type: 'learning_recommendation';
      desiredAction: 'keep' | 'sample' | 'aggregate';
      reasonCode: string;
    };

export interface FilterRuleSource {
  type: FilterRuleSourceType;
  ref?: string;
  issuer?: string;
}

export interface FilterRuleActor {
  type: 'system' | 'operator' | 'api';
  id: string;
  displayName?: string;
}

export interface FilterRuleRecord {
  schemaVersion: typeof FILTER_RULE_SCHEMA;
  ruleId: string;
  revision: number;
  name: string;
  description: string;
  category: FilterRuleCategory;
  ruleKind: FilterRuleKind;
  source: FilterRuleSource;
  owner: string;
  management: FilterRuleManagement;
  editable: boolean;
  lifecycleStage: FilterRuleLifecycleStage;
  authority: FilterRuleAuthority;
  priority: number;
  matcher: FilterRuleMatcher;
  effect: FilterRuleEffect;
  consumerCapabilities: FilterRuleStage[];
  createdBy: string;
  approvedBy?: string;
  createdAt: number;
  updatedAt: number;
  reason: string;
  ticket?: string;
  predecessorRuleId?: string;
  contentHash: string;
}

export interface FilterRuleOperationRecord {
  operationId: string;
  kind: 'create' | 'preview' | 'shadow' | 'promote' | 'revoke';
  status: 'pending' | 'succeeded' | 'failed';
  ruleId?: string;
  actorId: string;
  requestedAt: number;
  completedAt?: number;
  previousRevision?: number;
  resultingRevision?: number;
  reason?: string;
  error?: string;
}

export interface FilterRuleDomainVersions {
  identity: number;
  capture: number;
  forwarder: number;
  retention: number;
}

export interface FilterRuleStateDocument {
  schemaVersion: typeof FILTER_RULE_STATE_SCHEMA;
  catalogVersion: number;
  domainVersions: FilterRuleDomainVersions;
  updatedAt: number;
  rules: FilterRuleRecord[];
  revisions: FilterRuleRecord[];
  operations: FilterRuleOperationRecord[];
}

export interface FilterRuleEvaluationContext {
  process?: {
    comm?: string;
    exe?: string;
    argv?: string[];
  };
  identityClassification?: AgentClassification;
  workloadRole?: WorkloadRole;
  workload?: {
    placement?: 'kubernetes' | 'docker' | 'host';
    cluster?: string;
    namespace?: string;
    ownerKind?: string;
    ownerName?: string;
    container?: string;
    service?: string;
    systemdUnit?: string;
    labels?: Record<string, string>;
  };
  assetId?: string;
  runtimeId?: string;
  runtimeState?: 'starting' | 'current' | 'idle' | 'exited' | 'lost' | 'unknown';
  bindingQuality?: 'exact' | 'logical' | 'ephemeral' | 'weak' | 'conflict' | 'unassigned';
  signalName?: 'file_open_read';
  eventKind?: string;
  probe?: CaptureProbeName;
  conflict?: boolean;
  structuralRisk?: boolean;
  stale?: boolean;
}

export interface FilterRuleCandidateReceipt {
  ruleId: string;
  revision: number;
  name: string;
  category: FilterRuleCategory;
  ruleKind: FilterRuleKind;
  matched: boolean;
  failedConditions: string[];
  priority: number;
  effect: FilterRuleEffect;
  selected: boolean;
  overriddenBy?: string;
}

export interface FilterRuleDecisionReceipt {
  schemaVersion: typeof FILTER_RULE_DECISION_RECEIPT_SCHEMA;
  stage: FilterRuleStage;
  catalogVersion: number;
  domainVersion: number;
  evaluatedAt: string;
  candidates: FilterRuleCandidateReceipt[];
  winner?: FilterRuleCandidateReceipt;
  outcome?: FilterRuleEffect;
  reason: string;
  failOpen: boolean;
}

export type FilterRuleStageApplicability =
  | 'active'
  | 'indirect'
  | 'not_applicable'
  | 'pending'
  | 'overridden'
  | 'degraded';

export interface FilterRuleHumanStageImpact {
  stage: FilterRuleStage;
  applicability: FilterRuleStageApplicability;
  action: string;
  reason: string;
  version?: number | string;
}

export interface FilterRuleHumanSummary {
  ruleId: string;
  revision: number;
  name: string;
  description: string;
  category: FilterRuleCategory;
  categoryLabel: string;
  ruleKind: FilterRuleKind;
  kindLabel: string;
  matcherText: string;
  effectText: string;
  source: FilterRuleSource;
  sourceLabel: string;
  owner: string;
  management: FilterRuleManagement;
  editable: boolean;
  lifecycleStage: FilterRuleLifecycleStage;
  authority: FilterRuleAuthority;
  priority: number;
  stageImpacts: FilterRuleHumanStageImpact[];
  createdBy: string;
  approvedBy?: string;
  createdAt: string;
  updatedAt: string;
  reason: string;
  matchedAssets: number;
  matchedInstances: number;
  matchedNodes: number;
  conflicts: number;
  lastAppliedAt?: string;
}

export interface FilterRuleHumanDetail extends FilterRuleHumanSummary {
  predecessorRuleId?: string;
  matcher: {
    description: string;
    conditions: Array<{ field: string; operator: string; value: string }>;
  };
  effect: {
    type: FilterRuleEffect['type'];
    description: string;
    probeActions?: CaptureProbeActions;
    signal?: 'file_open_read';
    defaultAction?: 'not_enabled';
    captureAction?: 'full';
    scopeMode?: 'exact_runtime_or_root';
    reasonCode?: string;
  };
  revisions: Array<{
    revision: number;
    lifecycleStage: FilterRuleLifecycleStage;
    authority: FilterRuleAuthority;
    updatedAt: string;
    approvedBy?: string;
  }>;
  operations: FilterRuleOperationRecord[];
  materialization: {
    reports: number;
    acceptedBindings: number;
    activeBindings: number;
    nodes: string[];
    lastReportAt?: string;
  };
  rawAvailable: boolean;
}

export interface FilterRuleCategorySummary {
  category: FilterRuleCategory;
  label: string;
  total: number;
  enforced: number;
  candidates: number;
  conflicts: number;
  editable: number;
}

export interface FilterRuleKindSummary {
  kind: FilterRuleKind;
  label: string;
  category: FilterRuleCategory;
  total: number;
}

export interface FilterRuleCatalogResult {
  items: FilterRuleHumanSummary[];
  total: number;
  nextCursor?: string;
  catalogVersion: string;
  domainVersions: FilterRuleDomainVersions;
  categories: FilterRuleCategorySummary[];
  kinds: FilterRuleKindSummary[];
  updateTime: string;
}

export interface FilterRuleCatalogQuery {
  q?: string;
  category?: FilterRuleCategory | 'all';
  kind?: FilterRuleKind | 'all';
  stage?: FilterRuleStage | 'all';
  lifecycleStage?: FilterRuleLifecycleStage | 'all';
  source?: FilterRuleSourceType | 'all';
  editable?: boolean;
  cursor?: string;
  limit?: number;
}

export interface FilterRuleDraftRequest {
  name?: string;
  description?: string;
  category?: FilterRuleCategory;
  ruleKind?: FilterRuleKind;
  matcher?: FilterRuleMatcher;
  effect?: FilterRuleEffect;
  consumerCapabilities?: FilterRuleStage[];
  priority?: number;
  reason?: string;
  ticket?: string;
  predecessorRuleId?: string;
}

export interface FilterRuleTransitionRequest {
  expectedRevision?: number;
  reason?: string;
  ticket?: string;
}

export interface FilterRulePreviewResult {
  ruleId: string;
  revision: number;
  valid: boolean;
  errors: string[];
  warnings: string[];
  destructive: boolean;
  affectedStages: FilterRuleStage[];
  matchedAssets: number;
  matchedInstances: number;
  matchedNodes: number;
  conflicts: number;
  canEnterShadow: boolean;
  canPromote: boolean;
  stageImpacts: FilterRuleHumanStageImpact[];
}

export interface FilterRuleStageRuntimeNode {
  nodeId: string;
  status: 'aligned' | 'drifted' | 'degraded' | 'stale';
  catalogVersion?: number;
  domainVersion?: number;
  /** Central identity fact version comparable to the API target. */
  factVersion?: number;
  /** Combined node-local Kubernetes + Docker discovery generation, shown only for diagnostics. */
  localFactVersion?: number;
  policyVersion?: number;
  epoch?: number;
  mode?: string;
  ruleEntries?: number;
  conflicts?: number;
  lastReportedAt?: string;
  reason?: string;
}

export interface FilterRuleStageStatus {
  stage: FilterRuleStage;
  label: string;
  mode: string;
  desiredVersion: number | string;
  activeRules: number;
  decisions: number;
  suppressed: number;
  aggregated: number;
  lost: number;
  status: 'ready' | 'degraded' | 'drifted' | 'unknown';
  reason: string;
  nodes: FilterRuleStageRuntimeNode[];
}

export interface FilterRuleSystemStatus {
  schemaVersion: 'anysentry.filter_rule_system_status.v1';
  catalogVersion: string;
  domainVersions: FilterRuleDomainVersions;
  totalRules: number;
  editableRules: number;
  conflicts: number;
  degradedStages: number;
  stages: FilterRuleStageStatus[];
  updateTime: string;
}

export interface AgentRuntimeSignatureProjection {
  id: string;
  agentScopeId?: string;
  displayName: string;
  enabled: boolean;
  variants: Array<Partial<Record<'commExact' | 'exeBasename' | 'argv0Basename' | 'argvPrefix', string[]>>>;
  ruleId: string;
  revision: number;
}

export interface AgentTemplateProjection {
  id: string;
  agentId?: string;
  displayName?: string;
  deployment: 'any' | 'host' | 'docker' | 'kubernetes';
  classification: AgentClassification;
  match: Record<string, string | Record<string, string>>;
  ruleId: string;
  revision: number;
}

export interface FilterRuleProjection {
  schemaVersion: typeof FILTER_RULE_PROJECTION_SCHEMA;
  catalogVersion: number;
  domainVersions: FilterRuleDomainVersions;
  generatedAt: string;
  expiresAt: string;
  /** Semantic F0/F1/F2 intent; unlike contentHash it excludes transport TTL timestamps and F3-only state. */
  intentHash: string;
  contentHash: string;
  runtimeSignatures: {
    schemaVersion: 'anysentry.agent_runtime_signatures.v1';
    version: number;
    runtimes: AgentRuntimeSignatureProjection[];
  };
  agentTemplates: {
    schemaVersion: 'anysentry.agent_templates.v1';
    version: number;
    templates: AgentTemplateProjection[];
  };
  identityRules: FilterRuleRecord[];
  captureProfiles: Record<CaptureProfile, CaptureProbeActions>;
  captureProfileRules: FilterRuleRecord[];
  signalEnablementRules: FilterRuleRecord[];
  semanticRetentionRules: FilterRuleRecord[];
  persistenceRetentionRules: FilterRuleRecord[];
  safetyGuardrails: FilterRuleRecord[];
  forwarderSettings: {
    filterMode: 'enforce';
    retainUnknown: true;
    retainNonAgent: false;
    noisePolicy: 'balanced';
    fileAggregationEnabled: true;
    fileAggregationWindowMs: number;
  };
}

export interface FilterRuleExplainRequest {
  eventId?: string;
  assetId?: string;
}

export interface FilterRuleSimulationRequest {
  ruleId?: string;
  draft?: FilterRuleDraftRequest;
  context?: FilterRuleEvaluationContext;
  historyWindow?: 'last_30m' | 'last_3h' | 'last_24h';
  sampleLimit?: number;
}

export interface FilterRuleSimulationResult {
  schemaVersion: 'anysentry.filter_rule_simulation.v1';
  preview: FilterRulePreviewResult;
  sample: {
    source: 'provided_context' | 'current_inventory' | 'historical_events';
    historyWindow?: 'last_30m' | 'last_3h' | 'last_24h';
    evaluated: number;
    hasMore: boolean;
    partial: boolean;
    reasons: string[];
  };
  stageChanges: Array<{
    stage: FilterRuleStage;
    evaluated: number;
    changed: number;
    before: Record<string, number>;
    after: Record<string, number>;
  }>;
  examples: Array<{
    assetId: string;
    label: string;
    stage: FilterRuleStage;
    before: string;
    after: string;
  }>;
  evaluatedAt: string;
}

export interface FilterRuleExplainResult {
  schemaVersion: 'anysentry.filter_rule_explain.v1';
  subject: {
    type: 'event' | 'asset' | 'simulation';
    id: string;
    label: string;
  };
  context: {
    identityClassification: AgentClassification;
    workloadRole: WorkloadRole;
    eventKind?: string;
    probe?: CaptureProbeName;
    conflict: boolean;
    facts: Array<{ label: string; value: string; source: string }>;
  };
  stages: FilterRuleDecisionReceipt[];
  finalOutcome: string;
  winningRuleIds: string[];
  relatedRuleIds: string[];
  warnings: string[];
  evaluatedAt: string;
}
