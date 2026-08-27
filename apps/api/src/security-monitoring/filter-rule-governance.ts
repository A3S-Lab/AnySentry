import type { AgentMetadataListItem, CaptureProfile, WorkloadRole } from './types';
import type { UnknownPolicyCandidate } from './unknown-learning';
import type {
  InfrastructureRuleHumanDetail,
  InfrastructureRuleRecord,
  InfrastructureRuleSourceType,
} from './infrastructure-rule.types';
import { filterRuleDigest } from './filter-rule-builtins';
import {
  filterRuleEffectDescription,
  stageImpactForRule,
} from './filter-rule-engine';
import {
  FILTER_RULE_SCHEMA,
  FilterRuleCategory,
  FilterRuleCondition,
  FilterRuleDomainVersions,
  FilterRuleHumanDetail,
  FilterRuleHumanSummary,
  FilterRuleRecord,
  FilterRuleSourceType,
} from './filter-rule.types';

export const FILTER_RULE_CATEGORY_LABELS: Record<FilterRuleCategory, string> = {
  agent_identity: 'Agent 识别',
  infrastructure: 'Infrastructure 与服务',
  capture_profile: 'Capture Profile',
  forwarder_retention: 'Forwarder 语义保留',
  api_retention: 'API 入库与研判路由',
  safety_guardrail: '安全保护边界',
  investigation: '临时调查升档',
  learning_candidate: '学习候选',
};

export const FILTER_RULE_KIND_LABELS: Record<FilterRuleRecord['ruleKind'], string> = {
  runtime_signature: 'Runtime Signature',
  agent_template: 'Agent Template',
  deployment_binding: 'Deployment Binding',
  reviewed_identity_binding: '人工身份绑定',
  behavior_candidate: 'Behavior Candidate',
  workload_role_binding: 'Workload Role Binding',
  capture_profile: 'Capture Profile',
  signal_enablement: 'Signal Enablement',
  semantic_retention: 'Semantic Retention',
  persistence_retention: 'Persistence Retention',
  safety_guardrail: 'Safety Guardrail',
  investigation_override: 'Investigation Override',
  learning_candidate: 'Learning Candidate',
};

export const FILTER_RULE_KIND_CATEGORIES: Record<FilterRuleRecord['ruleKind'], FilterRuleCategory> = {
  runtime_signature: 'agent_identity',
  agent_template: 'agent_identity',
  deployment_binding: 'agent_identity',
  reviewed_identity_binding: 'agent_identity',
  behavior_candidate: 'agent_identity',
  workload_role_binding: 'infrastructure',
  capture_profile: 'capture_profile',
  signal_enablement: 'capture_profile',
  semantic_retention: 'forwarder_retention',
  persistence_retention: 'api_retention',
  safety_guardrail: 'safety_guardrail',
  investigation_override: 'investigation',
  learning_candidate: 'learning_candidate',
};

const SOURCE_LABELS: Record<FilterRuleSourceType, string> = {
  builtin: 'AnySentry 内置',
  operator: '审核人员创建',
  platform_inventory: '平台资产清单',
  kubernetes: 'Kubernetes Inventory',
  docker: 'Docker Inventory',
  manual_review: '人工身份审核',
  authenticated_adapter: '认证 Agent Adapter',
  behavior: '行为发现',
  unknown_learning: 'Unknown Learning',
  compatibility: '兼容导入',
};

export interface FilterRuleRuntimeStats {
  matchedAssets?: number;
  matchedInstances?: number;
  matchedNodes?: number;
  conflicts?: number;
  lastAppliedAt?: string;
}

function conditionValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join(', ');
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value ?? '存在');
}

export function humanFilterRuleSummary(
  rule: FilterRuleRecord,
  versions: FilterRuleDomainVersions,
  stats: FilterRuleRuntimeStats = {},
): FilterRuleHumanSummary {
  return {
    ruleId: rule.ruleId,
    revision: rule.revision,
    name: rule.name,
    description: rule.description,
    category: rule.category,
    categoryLabel: FILTER_RULE_CATEGORY_LABELS[rule.category],
    ruleKind: rule.ruleKind,
    kindLabel: FILTER_RULE_KIND_LABELS[rule.ruleKind],
    matcherText: rule.matcher.description,
    effectText: filterRuleEffectDescription(rule.effect),
    source: { ...rule.source },
    sourceLabel: SOURCE_LABELS[rule.source.type],
    owner: rule.owner,
    management: rule.management,
    editable: rule.editable,
    lifecycleStage: rule.lifecycleStage,
    authority: rule.authority,
    priority: rule.priority,
    stageImpacts: stageImpactForRule(rule, versions),
    createdBy: rule.createdBy,
    approvedBy: rule.approvedBy,
    createdAt: new Date(rule.createdAt).toISOString(),
    updatedAt: new Date(rule.updatedAt).toISOString(),
    reason: rule.reason,
    matchedAssets: stats.matchedAssets ?? 0,
    matchedInstances: stats.matchedInstances ?? 0,
    matchedNodes: stats.matchedNodes ?? 0,
    conflicts: stats.conflicts ?? 0,
    lastAppliedAt: stats.lastAppliedAt,
  };
}

export function humanFilterRuleDetail(input: {
  rule: FilterRuleRecord;
  versions: FilterRuleDomainVersions;
  revisions?: FilterRuleRecord[];
  operations?: FilterRuleHumanDetail['operations'];
  stats?: FilterRuleRuntimeStats;
  materialization?: FilterRuleHumanDetail['materialization'];
}): FilterRuleHumanDetail {
  const summary = humanFilterRuleSummary(input.rule, input.versions, input.stats);
  return {
    ...summary,
    predecessorRuleId: input.rule.predecessorRuleId,
    matcher: {
      description: input.rule.matcher.description,
      conditions: [...(input.rule.matcher.all ?? []), ...(input.rule.matcher.any ?? [])].map((condition) => ({
        field: condition.key ? `${condition.field}[${condition.key}]` : condition.field,
        operator: condition.operator,
        value: conditionValue(condition.value),
      })),
    },
    effect: {
      type: input.rule.effect.type,
      description: filterRuleEffectDescription(input.rule.effect),
      probeActions: input.rule.effect.type === 'assign_capture_profile'
        ? { ...input.rule.effect.probeActions }
        : undefined,
      ...(input.rule.effect.type === 'enable_signal'
        ? {
            signal: input.rule.effect.signal,
            defaultAction: 'not_enabled' as const,
            captureAction: input.rule.effect.captureAction,
            scopeMode: input.rule.effect.scopeMode,
            reasonCode: input.rule.effect.reasonCode,
          }
        : {}),
    },
    revisions: (input.revisions ?? [input.rule]).map((revision) => ({
      revision: revision.revision,
      lifecycleStage: revision.lifecycleStage,
      authority: revision.authority,
      updatedAt: new Date(revision.updatedAt).toISOString(),
      approvedBy: revision.approvedBy,
    })),
    operations: (input.operations ?? []).map((operation) => ({ ...operation })),
    materialization: input.materialization ?? {
      reports: 0,
      acceptedBindings: 0,
      activeBindings: 0,
      nodes: [],
    },
    rawAvailable: input.rule.management === 'catalog' && input.rule.editable,
  };
}

function infrastructureSource(type: InfrastructureRuleSourceType): FilterRuleSourceType {
  if (type === 'kubernetes') return 'kubernetes';
  if (type === 'docker') return 'docker';
  if (type === 'manual_review') return 'manual_review';
  if (type === 'operator') return 'operator';
  if (type === 'behavior_discovery') return 'behavior';
  if (type === 'platform_inventory') return 'platform_inventory';
  return 'compatibility';
}

function infrastructureConditions(rule: InfrastructureRuleRecord): FilterRuleRecord['matcher']['all'] {
  const selector = rule.selector;
  const pairs: Array<[FilterRuleCondition['field'], string | undefined]> = [
    ['workload.placement', selector.placement],
    ['workload.cluster', selector.clusterId],
    ['workload.namespace', selector.namespace],
    ['workload.owner_kind', selector.ownerKind],
    ['workload.owner_name', selector.ownerName],
    ['workload.container', selector.containerName],
    ['workload.service', selector.serviceName],
    ['workload.systemd_unit', selector.systemdUnit],
  ];
  return [
    ...pairs.filter((pair): pair is [typeof pair[0], string] => Boolean(pair[1]))
      .map(([field, value]) => ({ field, operator: 'equals' as const, value })),
    ...Object.entries(selector.labels).map(([key, value]) => ({
      field: 'workload.label' as const,
      key,
      operator: 'equals' as const,
      value,
    })),
  ];
}

export function infrastructureFilterRule(
  rule: InfrastructureRuleRecord,
  detail: InfrastructureRuleHumanDetail,
): FilterRuleRecord {
  const inferredSelf = detail.scope.fields.some((field) =>
    field.value.toLowerCase().includes('anysentry') || field.value.toLowerCase().includes('a3s'));
  const role: WorkloadRole = rule.workloadRole ?? (inferredSelf ? 'anysentry_internal' : 'platform_infrastructure');
  const profile: CaptureProfile = role === 'anysentry_internal'
    ? 'self_health'
    : role === 'business_service' || role === 'ordinary_process'
      ? 'business_context'
      : 'infrastructure_aggregate';
  const content = {
    schemaVersion: FILTER_RULE_SCHEMA,
    ruleId: rule.ruleId,
    revision: rule.revision,
    name: rule.name,
    description: detail.intent.description,
    category: 'infrastructure' as const,
    ruleKind: 'workload_role_binding' as const,
    source: { type: infrastructureSource(rule.source.type), ref: rule.source.sourceRef, issuer: rule.source.issuer },
    owner: rule.createdBy,
    management: 'adapter' as const,
    editable: true,
    lifecycleStage: rule.lifecycleStage,
    authority: rule.authority,
    priority: rule.priority,
    matcher: { all: infrastructureConditions(rule), description: detail.scope.label },
    effect: { type: 'assign_role' as const, role, captureProfile: profile },
    consumerCapabilities: ['f0', 'f1', 'f2', 'f3'] as const,
    createdBy: rule.createdBy,
    approvedBy: rule.approvedBy,
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
    reason: detail.reasonLabel,
    ticket: rule.changeTicket,
  };
  return { ...content, consumerCapabilities: [...content.consumerCapabilities], contentHash: filterRuleDigest(content) };
}

export function reviewedIdentityFilterRule(record: AgentMetadataListItem): FilterRuleRecord | undefined {
  if (!record.reviewDecision || !record.reviewRevision || !record.reviewEffectiveAt) return undefined;
  const classification = record.reviewDecision;
  const conditions: FilterRuleRecord['matcher']['all'] = [];
  if (record.reviewPhysicalWorkloadId) conditions.push({ field: 'asset.id', operator: 'equals', value: record.agentAssetId });
  else if (record.reviewAgentInstanceId) conditions.push({ field: 'runtime.id', operator: 'equals', value: record.reviewAgentInstanceId });
  else if (record.agentAssetId) conditions.push({ field: 'asset.id', operator: 'equals', value: record.agentAssetId });
  if (!conditions.length) return undefined;
  const updatedAt = Date.parse(record.reviewEffectiveAt);
  const content = {
    schemaVersion: FILTER_RULE_SCHEMA,
    ruleId: `fr_review_${filterRuleDigest([record.agentAssetId, record.reviewRevision]).slice(0, 24)}`,
    revision: record.reviewRevision,
    name: `${record.displayName ?? record.agentId} 人工身份绑定`,
    description: '人工审核只绑定可证明的稳定资产或 Runtime，不使用裸进程名。',
    category: 'agent_identity' as const,
    ruleKind: 'reviewed_identity_binding' as const,
    source: { type: 'manual_review' as const, ref: `agent-asset:${record.agentAssetId}`, issuer: record.reviewedBy },
    owner: record.reviewedBy ?? 'operator',
    management: 'adapter' as const,
    editable: false,
    lifecycleStage: 'enforced' as const,
    authority: 'authoritative' as const,
    priority: 880,
    matcher: { all: conditions, description: `稳定资产 ${record.agentAssetId}` },
    effect: { type: 'emit_identity' as const, classification, confidence: 1, ...(classification === 'confirmed_agent' ? { captureProfile: 'agent_full' as const } : {}) },
    consumerCapabilities: ['f0', 'f1', 'f2', 'f3'] as const,
    createdBy: record.reviewedBy ?? 'operator',
    approvedBy: record.reviewedBy,
    createdAt: updatedAt,
    updatedAt,
    reason: record.reviewNote ?? 'human reviewed identity',
  };
  return { ...content, consumerCapabilities: [...content.consumerCapabilities], contentHash: filterRuleDigest(content) };
}

function unknownStage(stage: UnknownPolicyCandidate['stage']): FilterRuleRecord['lifecycleStage'] {
  if (stage === 'candidate') return 'draft';
  if (stage === 'shadow' || stage === 'replay_validated' || stage === 'canary') return 'shadow';
  if (stage === 'enforced') return 'enforced';
  return 'revoked';
}

export function unknownLearningFilterRule(policy: UnknownPolicyCandidate): FilterRuleRecord {
  const content = {
    schemaVersion: FILTER_RULE_SCHEMA,
    ruleId: policy.policyId,
    revision: policy.revision,
    name: `Unknown Learning ${policy.familyId.slice(-8)}`,
    description: '经人工审核和有界回放/Canary 的 recommendation-only 学习候选。',
    category: 'learning_candidate' as const,
    ruleKind: 'learning_candidate' as const,
    source: { type: 'unknown_learning' as const, ref: `family:${policy.familyId}`, issuer: policy.createdBy },
    owner: policy.createdBy,
    management: 'adapter' as const,
    editable: false,
    lifecycleStage: unknownStage(policy.stage),
    authority: 'recommendation_only' as const,
    priority: 300,
    matcher: { all: [{ field: 'asset.id' as const, operator: 'equals' as const, value: `family:${policy.familyId}` }], description: `Unknown family ${policy.familyId} 的稳定 scope` },
    effect: { type: 'learning_recommendation' as const, desiredAction: policy.desiredAction, reasonCode: 'unknown_learning_recommendation' },
    consumerCapabilities: ['f0'] as const,
    createdBy: policy.createdBy,
    createdAt: policy.createdAt,
    updatedAt: policy.updatedAt,
    reason: policy.audit.at(-1)?.reason ?? 'unknown learning recommendation',
  };
  return { ...content, consumerCapabilities: [...content.consumerCapabilities], contentHash: filterRuleDigest(content) };
}

export function profileForRole(role: WorkloadRole): CaptureProfile {
  if (role === 'agent') return 'agent_full';
  if (role === 'anysentry_internal') return 'self_health';
  if (role === 'platform_infrastructure') return 'infrastructure_aggregate';
  if (role === 'business_service' || role === 'ordinary_process') return 'business_context';
  return 'unknown_discovery';
}
