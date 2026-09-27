import { apiClient } from "@/lib/api/client";

export type FilterRuleStage = "f0" | "f1" | "f2" | "f3";
export type FilterRuleCategory =
  | "agent_identity"
  | "infrastructure"
  | "capture_profile"
  | "forwarder_retention"
  | "api_retention"
  | "safety_guardrail"
  | "investigation"
  | "learning_candidate";
export type FilterRuleKind =
  | "runtime_signature"
  | "non_agent_runtime_signature"
  | "agent_template"
  | "deployment_binding"
  | "reviewed_identity_binding"
  | "behavior_candidate"
  | "workload_role_binding"
  | "capture_profile"
  | "signal_enablement"
  | "semantic_retention"
  | "persistence_retention"
  | "safety_guardrail"
  | "investigation_override"
  | "learning_candidate";
export type FilterRuleLifecycleStage = "draft" | "shadow" | "enforced" | "revoked";
export type FilterRuleAuthority = "candidate" | "authoritative" | "immutable" | "recommendation_only";
export type CaptureProfile =
  | "agent_full"
  | "probable_investigation"
  | "security_full"
  | "investigation_full"
  | "business_context"
  | "infrastructure_aggregate"
  | "unknown_discovery"
  | "self_health";
export type CaptureProbeName = "exec" | "exit" | "tls" | "connect" | "dns" | "file_access" | "file_delete" | "llm" | "ssl" | "security" | "file_read";
export type CaptureProbeAction = "full" | "aggregate" | "sample" | "drop" | "not_enabled";
export type CaptureProbeActions = Record<CaptureProbeName, CaptureProbeAction>;

export interface FilterRuleStageImpact {
  stage: FilterRuleStage;
  applicability: "active" | "indirect" | "not_applicable" | "pending" | "overridden" | "degraded";
  action: string;
  reason: string;
  version?: number | string;
}

export interface FilterRuleSummary {
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
  source: { type: string; ref?: string; issuer?: string };
  sourceLabel: string;
  owner: string;
  management: "catalog" | "adapter" | "builtin";
  editable: boolean;
  lifecycleStage: FilterRuleLifecycleStage;
  authority: FilterRuleAuthority;
  priority: number;
  stageImpacts: FilterRuleStageImpact[];
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

export interface FilterRuleOperation {
  operationId: string;
  kind: "create" | "preview" | "shadow" | "promote" | "revoke";
  status: "pending" | "succeeded" | "failed";
  ruleId?: string;
  actorId: string;
  requestedAt: number;
  completedAt?: number;
  previousRevision?: number;
  resultingRevision?: number;
  reason?: string;
  error?: string;
}

export interface FilterRuleDetail extends FilterRuleSummary {
  predecessorRuleId?: string;
  matcher: { description: string; conditions: Array<{ field: string; operator: string; value: string }> };
  effect: {
    type: string;
    description: string;
    probeActions?: CaptureProbeActions;
    signal?: "file_open_read";
    defaultAction?: "not_enabled";
    captureAction?: "full";
    scopeMode?: "exact_runtime_or_root";
    reasonCode?: string;
  };
  revisions: Array<{ revision: number; lifecycleStage: FilterRuleLifecycleStage; authority: FilterRuleAuthority; updatedAt: string; approvedBy?: string }>;
  operations: FilterRuleOperation[];
  materialization: { reports: number; acceptedBindings: number; activeBindings: number; nodes: string[]; lastReportAt?: string };
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

export interface FilterRuleCatalog {
  items: FilterRuleSummary[];
  total: number;
  nextCursor?: string;
  catalogVersion: string;
  domainVersions: { identity: number; capture: number; forwarder: number; retention: number };
  categories: FilterRuleCategorySummary[];
  kinds: FilterRuleKindSummary[];
  updateTime: string;
}

export interface FilterRuleStageNode {
  nodeId: string;
  status: "aligned" | "drifted" | "degraded" | "stale";
  catalogVersion?: number;
  domainVersion?: number;
  factVersion?: number;
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
  status: "ready" | "degraded" | "drifted" | "unknown";
  reason: string;
  nodes: FilterRuleStageNode[];
}

export interface FilterRuleSystemStatus {
  schemaVersion: "anysentry.filter_rule_system_status.v1";
  catalogVersion: string;
  domainVersions: FilterRuleCatalog["domainVersions"];
  totalRules: number;
  editableRules: number;
  conflicts: number;
  degradedStages: number;
  stages: FilterRuleStageStatus[];
  updateTime: string;
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
  effect: { type: string; [key: string]: unknown };
  selected: boolean;
  overriddenBy?: string;
}

export interface FilterRuleDecisionReceipt {
  stage: FilterRuleStage;
  catalogVersion: number;
  domainVersion: number;
  evaluatedAt: string;
  candidates: FilterRuleCandidateReceipt[];
  winner?: FilterRuleCandidateReceipt;
  outcome?: { type: string; [key: string]: unknown };
  reason: string;
  failOpen: boolean;
}

export interface FilterRuleExplain {
  schemaVersion: "anysentry.filter_rule_explain.v1";
  subject: { type: "event" | "asset" | "simulation"; id: string; label: string };
  context: {
    identityClassification: string;
    workloadRole: string;
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

export interface FilterRulePreview {
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
  stageImpacts: FilterRuleStageImpact[];
}

export interface FilterRuleSimulation {
  schemaVersion: "anysentry.filter_rule_simulation.v1";
  preview: FilterRulePreview;
  sample: {
    source: "provided_context" | "current_inventory" | "historical_events";
    historyWindow?: "last_30m" | "last_3h" | "last_24h";
    evaluated: number;
    hasMore: boolean;
    partial: boolean;
    reasons: string[];
  };
  stageChanges: Array<{ stage: FilterRuleStage; evaluated: number; changed: number; before: Record<string, number>; after: Record<string, number> }>;
  examples: Array<{ assetId: string; label: string; stage: FilterRuleStage; before: string; after: string }>;
  evaluatedAt: string;
}

export interface FilterRuleCondition {
  field: string;
  operator: "equals" | "one_of" | "prefix" | "present";
  value?: string | boolean | string[];
  key?: string;
}

export interface FilterRuleDraft {
  name: string;
  description: string;
  category: FilterRuleCategory;
  ruleKind: FilterRuleKind;
  matcher: { all?: FilterRuleCondition[]; any?: FilterRuleCondition[]; description: string };
  effect: { type: string; [key: string]: unknown };
  priority?: number;
  reason: string;
  ticket?: string;
  predecessorRuleId?: string;
}

function queryString(query: Record<string, string | number | boolean | undefined>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== "") params.set(key, String(value));
  return params.toString();
}

export const filterRulesApi = {
  catalog: (query: Record<string, string | number | boolean | undefined>) =>
    apiClient.get<FilterRuleCatalog>(`/security-center/filter-rules/catalog?${queryString(query)}`),
  detail: (ruleId: string) =>
    apiClient.get<FilterRuleDetail>(`/security-center/filter-rules/${encodeURIComponent(ruleId)}`),
  status: () => apiClient.get<FilterRuleSystemStatus>("/security-center/filter-rules/stages/status"),
  explain: (body: { eventId?: string; assetId?: string }) =>
    apiClient.post<FilterRuleExplain>("/security-center/filter-rules/explain", body),
  example: () => apiClient.get<FilterRuleExplain>("/security-center/filter-rules/examples/agent-infrastructure-conflict"),
  simulate: (body: { ruleId?: string; draft?: FilterRuleDraft; context?: Record<string, unknown>; historyWindow?: "last_30m" | "last_3h" | "last_24h"; sampleLimit?: number }) =>
    apiClient.post<FilterRuleSimulation>("/security-center/filter-rules/simulate", body),
  createDraft: (draft: FilterRuleDraft) =>
    apiClient.post<{ rule: FilterRuleDetail }>("/security-center/filter-rules/drafts", draft),
  createInfrastructureDraft: (body: { assetId: string; intent: "full" | "aggregate" | "sample" | "drop"; name?: string; reason: string }) =>
    apiClient.post<{ rule: FilterRuleDetail }>("/security-center/filter-rules/drafts/from-asset", body),
  preview: (ruleId: string) =>
    apiClient.post<FilterRulePreview>(`/security-center/filter-rules/${encodeURIComponent(ruleId)}/preview`, {}),
  transition: (ruleId: string, action: "shadow" | "promote" | "revoke", body: { expectedRevision: number; reason: string }) =>
    apiClient.post<FilterRuleDetail>(`/security-center/filter-rules/${encodeURIComponent(ruleId)}/${action}`, body),
};
