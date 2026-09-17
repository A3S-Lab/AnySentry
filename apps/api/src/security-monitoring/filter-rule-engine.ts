import { basename } from 'node:path';
import type { AgentClassification, CaptureProfile, WorkloadRole } from './types';
import {
  AgentRuntimeSignatureProjection,
  AgentTemplateProjection,
  FILTER_RULE_DECISION_RECEIPT_SCHEMA,
  FILTER_RULE_PROJECTION_SCHEMA,
  FilterRuleCandidateReceipt,
  FilterRuleCondition,
  FilterRuleDecisionReceipt,
  FilterRuleDomainVersions,
  FilterRuleEffect,
  FilterRuleEvaluationContext,
  FilterRuleHumanStageImpact,
  FilterRuleProjection,
  FilterRuleRecord,
  FilterRuleStage,
} from './filter-rule.types';
import {
  BUILTIN_RUNTIME_SIGNATURE_VERSION,
  BUILTIN_RUNTIME_SIGNATURES,
  CAPTURE_PROFILE_ACTIONS,
  filterRuleDigest,
} from './filter-rule-builtins';

const AUTHORITY_RANK: Record<FilterRuleRecord['authority'], number> = {
  immutable: 4,
  authoritative: 3,
  candidate: 2,
  recommendation_only: 1,
};

export interface FilterRuleEvaluationIndex {
  rules: FilterRuleRecord[];
  buckets: Map<string, Set<string>>;
  fallbackRuleIds: Set<string>;
  bucketCount: number;
  maxBucketSize: number;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function normalized(value: unknown): string {
  return text(value).toLowerCase();
}

function indexKey(field: FilterRuleCondition['field'], value: unknown, labelKey?: string): string {
  return `${field}\u0000${labelKey ?? ''}\u0000${normalized(value)}`;
}

function argv(context: FilterRuleEvaluationContext): string[] {
  return Array.isArray(context.process?.argv) ? context.process!.argv.map(text).filter(Boolean) : [];
}

function contextValue(
  condition: FilterRuleCondition,
  context: FilterRuleEvaluationContext,
): string | boolean | undefined {
  switch (condition.field) {
    case 'process.comm': return context.process?.comm;
    case 'process.exe_basename': return context.process?.exe ? basename(context.process.exe) : undefined;
    case 'process.argv0_basename': return argv(context)[0] ? basename(argv(context)[0]) : undefined;
    case 'process.argv_prefix': return argv(context).join(' ');
    case 'identity.classification': return context.identityClassification;
    case 'identity.source_rule': return context.identitySourceRule;
    case 'workload.role': return context.workloadRole;
    case 'workload.placement': return context.workload?.placement;
    case 'workload.cluster': return context.workload?.cluster;
    case 'workload.namespace': return context.workload?.namespace;
    case 'workload.owner_kind': return context.workload?.ownerKind;
    case 'workload.owner_name': return context.workload?.ownerName;
    case 'workload.container': return context.workload?.container;
    case 'workload.service': return context.workload?.service;
    case 'workload.systemd_unit': return context.workload?.systemdUnit;
    case 'workload.label': return condition.key ? context.workload?.labels?.[condition.key] : undefined;
    case 'asset.id': return context.assetId;
    case 'runtime.id': return context.runtimeId;
    case 'runtime.state': return context.runtimeState;
    case 'binding.quality': return context.bindingQuality;
    case 'signal.name': return context.signalName;
    case 'event.kind': return context.eventKind;
    case 'event.probe': return context.probe;
    case 'decision.conflict': return context.conflict === true;
    case 'decision.structural_risk': return context.structuralRisk === true;
    case 'control.stale': return context.stale === true;
    default: return undefined;
  }
}

function conditionIndexKeys(condition: FilterRuleCondition): string[] {
  if (condition.operator !== 'equals' && condition.operator !== 'one_of') return [];
  const values = Array.isArray(condition.value) ? condition.value : [condition.value];
  return values
    .filter((value) => value !== undefined && text(value) !== '')
    .map((value) => indexKey(condition.field, value, condition.key));
}

function ruleIndexKeys(rule: Pick<FilterRuleRecord, 'matcher'>): string[] {
  const allAnchors = (rule.matcher.all ?? [])
    .map(conditionIndexKeys)
    .filter((keys) => keys.length)
    .sort((left, right) => left.length - right.length);
  if (allAnchors.length) return allAnchors[0];
  const any = rule.matcher.any ?? [];
  if (!any.length) return [];
  const anyAnchors = any.map(conditionIndexKeys);
  return anyAnchors.every((keys) => keys.length) ? [...new Set(anyAnchors.flat())] : [];
}

function contextIndexKeys(context: FilterRuleEvaluationContext): string[] {
  const values: Array<[FilterRuleCondition['field'], unknown]> = [
    ['process.comm', context.process?.comm],
    ['process.exe_basename', context.process?.exe ? basename(context.process.exe) : undefined],
    ['process.argv0_basename', argv(context)[0] ? basename(argv(context)[0]) : undefined],
    ['process.argv_prefix', argv(context).join(' ')],
    ['identity.classification', context.identityClassification],
    ['identity.source_rule', context.identitySourceRule],
    ['workload.role', context.workloadRole],
    ['workload.placement', context.workload?.placement],
    ['workload.cluster', context.workload?.cluster],
    ['workload.namespace', context.workload?.namespace],
    ['workload.owner_kind', context.workload?.ownerKind],
    ['workload.owner_name', context.workload?.ownerName],
    ['workload.container', context.workload?.container],
    ['workload.service', context.workload?.service],
    ['workload.systemd_unit', context.workload?.systemdUnit],
    ['asset.id', context.assetId],
    ['runtime.id', context.runtimeId],
    ['runtime.state', context.runtimeState],
    ['binding.quality', context.bindingQuality],
    ['signal.name', context.signalName],
    ['event.kind', context.eventKind],
    ['event.probe', context.probe],
    ['decision.conflict', context.conflict === true],
    ['decision.structural_risk', context.structuralRisk === true],
    ['control.stale', context.stale === true],
  ];
  const keys = values
    .filter(([, value]) => value !== undefined && text(value) !== '')
    .map(([field, value]) => indexKey(field, value));
  for (const [key, value] of Object.entries(context.workload?.labels ?? {})) {
    if (text(value)) keys.push(indexKey('workload.label', value, key));
  }
  return [...new Set(keys)];
}

export function compileFilterRuleEvaluationIndex(rules: readonly FilterRuleRecord[]): FilterRuleEvaluationIndex {
  const cloned = rules.map((rule) => rule);
  const buckets = new Map<string, Set<string>>();
  const fallbackRuleIds = new Set<string>();
  let maxBucketSize = 0;
  for (const rule of cloned) {
    const keys = ruleIndexKeys(rule);
    if (!keys.length) {
      fallbackRuleIds.add(rule.ruleId);
      continue;
    }
    for (const key of keys) {
      const bucket = buckets.get(key) ?? new Set<string>();
      bucket.add(rule.ruleId);
      buckets.set(key, bucket);
      maxBucketSize = Math.max(maxBucketSize, bucket.size);
    }
  }
  return { rules: cloned, buckets, fallbackRuleIds, bucketCount: buckets.size, maxBucketSize };
}

export function filterRuleIndexCandidates(
  index: FilterRuleEvaluationIndex,
  context: FilterRuleEvaluationContext,
): FilterRuleRecord[] {
  const candidateIds = new Set(index.fallbackRuleIds);
  for (const key of contextIndexKeys(context)) {
    for (const ruleId of index.buckets.get(key) ?? []) candidateIds.add(ruleId);
  }
  return index.rules.filter((rule) => candidateIds.has(rule.ruleId));
}

function conditionMatches(condition: FilterRuleCondition, context: FilterRuleEvaluationContext): boolean {
  const actual = contextValue(condition, context);
  if (condition.operator === 'present') return actual !== undefined && text(actual) !== '';
  if (actual === undefined) return false;
  if (typeof condition.value === 'boolean') return actual === condition.value;
  const actualValue = normalized(actual);
  const expected = Array.isArray(condition.value)
    ? condition.value.map(normalized)
    : [normalized(condition.value)];
  if (condition.operator === 'equals' || condition.operator === 'one_of') {
    return expected.includes(actualValue);
  }
  if (condition.operator === 'prefix') {
    return expected.some((value) => actualValue === value || actualValue.startsWith(`${value} `));
  }
  return false;
}

function conditionText(condition: FilterRuleCondition): string {
  const key = condition.key ? `[${condition.key}]` : '';
  const value = Array.isArray(condition.value) ? condition.value.join(', ') : String(condition.value ?? '存在');
  return `${condition.field}${key} ${condition.operator} ${value}`;
}

export function matchFilterRule(
  rule: Pick<FilterRuleRecord, 'matcher'>,
  context: FilterRuleEvaluationContext,
): { matched: boolean; failedConditions: string[] } {
  const failedConditions: string[] = [];
  for (const condition of rule.matcher.all ?? []) {
    if (!conditionMatches(condition, context)) failedConditions.push(conditionText(condition));
  }
  const any = rule.matcher.any ?? [];
  if (any.length && !any.some((condition) => conditionMatches(condition, context))) {
    failedConditions.push(`任一条件：${any.map(conditionText).join('；')}`);
  }
  return { matched: failedConditions.length === 0, failedConditions };
}

function effectApplies(effect: FilterRuleEffect, stage: FilterRuleStage): boolean {
  if (effect.type === 'emit_identity' || effect.type === 'assign_role') return stage === 'f0';
  if (effect.type === 'assign_capture_profile') return stage === 'f0' || stage === 'f1' || stage === 'f2';
  if (effect.type === 'enable_signal') return true;
  if (effect.type === 'semantic_retention') return stage === 'f2';
  if (effect.type === 'persistence_retention') return stage === 'f3';
  if (effect.type === 'protect') return stage === 'f1' || stage === 'f2' || stage === 'f3';
  if (effect.type === 'investigation') return stage === 'f1' || stage === 'f2';
  return false;
}

export function domainVersionForStage(versions: FilterRuleDomainVersions, stage: FilterRuleStage): number {
  if (stage === 'f0') return versions.identity;
  if (stage === 'f1') return versions.capture;
  if (stage === 'f2') return versions.forwarder;
  return versions.retention;
}

function effectiveRules(rules: readonly FilterRuleRecord[], includeShadow: boolean, now = Date.now()): FilterRuleRecord[] {
  return rules.filter((rule) =>
    (
      rule.authority === 'immutable'
      || rule.lifecycleStage === 'enforced'
      || (includeShadow && rule.lifecycleStage === 'shadow')
    )
    && (rule.effect.type !== 'investigation' || Date.parse(rule.effect.expiresAt) > now));
}

export function evaluateFilterRules(input: {
  rules: readonly FilterRuleRecord[];
  context: FilterRuleEvaluationContext;
  stage: FilterRuleStage;
  catalogVersion: number;
  domainVersions: FilterRuleDomainVersions;
  includeShadow?: boolean;
  now?: number;
}): FilterRuleDecisionReceipt {
  const now = input.now ?? Date.now();
  const ruleById = new Map(input.rules.map((rule) => [rule.ruleId, rule]));
  const candidates: FilterRuleCandidateReceipt[] = effectiveRules(input.rules, input.includeShadow === true, now)
    .filter((rule) => rule.consumerCapabilities.includes(input.stage) && effectApplies(rule.effect, input.stage))
    .map((rule) => {
      const result = matchFilterRule(rule, input.context);
      return {
        ruleId: rule.ruleId,
        revision: rule.revision,
        name: rule.name,
        category: rule.category,
        ruleKind: rule.ruleKind,
        matched: result.matched,
        failedConditions: result.failedConditions,
        priority: rule.priority,
        effect: rule.effect,
        selected: false,
      };
    })
    .sort((left, right) => {
      const leftRule = ruleById.get(left.ruleId)!;
      const rightRule = ruleById.get(right.ruleId)!;
      return right.priority - left.priority
        || AUTHORITY_RANK[rightRule.authority] - AUTHORITY_RANK[leftRule.authority]
        || left.ruleId.localeCompare(right.ruleId);
    });
  const winner = candidates.find((candidate) => candidate.matched);
  if (winner) {
    winner.selected = true;
    for (const candidate of candidates) {
      if (candidate !== winner && candidate.matched) candidate.overriddenBy = winner.ruleId;
    }
  }
  const failOpen = !winner && (input.stage === 'f1' || input.stage === 'f2');
  return {
    schemaVersion: FILTER_RULE_DECISION_RECEIPT_SCHEMA,
    stage: input.stage,
    catalogVersion: input.catalogVersion,
    domainVersion: domainVersionForStage(input.domainVersions, input.stage),
    evaluatedAt: new Date(now).toISOString(),
    candidates,
    winner,
    outcome: winner?.effect,
    reason: winner
      ? `规则 ${winner.name} 以优先级 ${winner.priority} 获胜`
      : failOpen
        ? '没有可信规则命中，按 discovery-safe fail-open'
        : '没有规则命中',
    failOpen,
  };
}

export function evaluateIndexedFilterRules(input: {
  index: FilterRuleEvaluationIndex;
  context: FilterRuleEvaluationContext;
  stage: FilterRuleStage;
  catalogVersion: number;
  domainVersions: FilterRuleDomainVersions;
  includeShadow?: boolean;
  now?: number;
}): FilterRuleDecisionReceipt {
  return evaluateFilterRules({
    rules: filterRuleIndexCandidates(input.index, input.context),
    context: input.context,
    stage: input.stage,
    catalogVersion: input.catalogVersion,
    domainVersions: input.domainVersions,
    includeShadow: input.includeShadow,
    now: input.now,
  });
}

export function filterRuleEffectDescription(effect: FilterRuleEffect): string {
  if (effect.type === 'emit_identity') return `产生 ${effect.classification} 身份事实（置信度 ${effect.confidence}）`;
  if (effect.type === 'assign_role') return `设置角色 ${effect.role}${effect.captureProfile ? `，建议 ${effect.captureProfile}` : ''}`;
  if (effect.type === 'assign_capture_profile') return `选择 ${effect.captureProfile} Capture Profile`;
  if (effect.type === 'enable_signal') return `为精确 Runtime/Root 启用 ${effect.signal}（${effect.reasonCode}）`;
  if (effect.type === 'semantic_retention') return `Forwarder ${effect.action}（${effect.reasonCode}）`;
  if (effect.type === 'persistence_retention') return `API ${effect.action}（${effect.reasonCode}）`;
  if (effect.type === 'protect') return `F1 ${effect.captureAction} / F2 ${effect.forwarderAction} / F3 ${effect.persistenceAction}`;
  if (effect.type === 'investigation') return `临时升档 ${effect.captureProfile} 至 ${effect.expiresAt}`;
  return `学习候选建议 ${effect.desiredAction}`;
}

export function stageImpactForRule(
  rule: FilterRuleRecord,
  versions: FilterRuleDomainVersions,
): FilterRuleHumanStageImpact[] {
  const stages: FilterRuleStage[] = ['f0', 'f1', 'f2', 'f3'];
  return stages.map((stage) => {
    const expired = rule.effect.type === 'investigation' && Date.parse(rule.effect.expiresAt) <= Date.now();
    const identityDependency = stage !== 'f0'
      && (rule.effect.type === 'emit_identity' || rule.effect.type === 'assign_role');
    const capable = rule.consumerCapabilities.includes(stage) && effectApplies(rule.effect, stage);
    const pending = rule.lifecycleStage === 'draft' || rule.lifecycleStage === 'shadow';
    const active = rule.lifecycleStage === 'enforced' || rule.authority === 'immutable';
    return {
      stage,
      applicability: expired ? 'not_applicable' : identityDependency ? 'indirect' : !capable ? 'not_applicable' : pending ? 'pending' : active ? 'active' : 'not_applicable',
      action: expired ? '临时调查已到期' : identityDependency ? '作为身份/角色上下文参与本阶段决策' : capable ? filterRuleEffectDescription(rule.effect) : '不适用',
      reason: expired
        ? 'TTL 已到期；规则不会进入运行投影，历史 revision 仍保留'
        : identityDependency
        ? 'F0 产生的事实被该阶段的 Capture/Retention 规则消费'
        : !capable
        ? '该规则类型不会编译到此阶段'
        : pending
          ? `规则处于 ${rule.lifecycleStage}，只计算 would-effect`
          : rule.lifecycleStage === 'revoked'
            ? '规则已停用'
            : '已进入当前阶段编译视图',
      version: domainVersionForStage(versions, stage),
    };
  });
}

function customSignature(rule: FilterRuleRecord): AgentRuntimeSignatureProjection | undefined {
  if (rule.ruleKind !== 'runtime_signature' || rule.effect.type !== 'emit_identity') return undefined;
  const variants: AgentRuntimeSignatureProjection['variants'] = [];
  const fieldMap: Partial<Record<FilterRuleCondition['field'], keyof AgentRuntimeSignatureProjection['variants'][number]>> = {
    'process.comm': 'commExact',
    'process.exe_basename': 'exeBasename',
    'process.argv0_basename': 'argv0Basename',
    'process.argv_prefix': 'argvPrefix',
  };
  for (const condition of [...(rule.matcher.all ?? []), ...(rule.matcher.any ?? [])]) {
    const field = fieldMap[condition.field];
    if (!field || (condition.operator !== 'equals' && condition.operator !== 'one_of' && condition.operator !== 'prefix')) continue;
    const values = Array.isArray(condition.value) ? condition.value : [text(condition.value)];
    if (values.length) variants.push({ [field]: values });
  }
  if (!variants.length) return undefined;
  return {
    id: rule.source.ref?.replace(/^runtime-signature:/u, '').replace(/:v\d+$/u, '') || rule.ruleId,
    displayName: rule.name.replace(/ Runtime Signature$/u, ''),
    enabled: rule.lifecycleStage === 'enforced',
    variants,
    ruleId: rule.ruleId,
    revision: rule.revision,
  };
}

function builtinSignatureProjection(rule: FilterRuleRecord): AgentRuntimeSignatureProjection | undefined {
  const id = rule.source.ref?.match(/^runtime-signature:([^:]+):v\d+$/u)?.[1];
  if (!id) return undefined;
  const definition = BUILTIN_RUNTIME_SIGNATURES.find((signature) => signature.id === id);
  if (!definition) return undefined;
  return {
    ...definition,
    enabled: true,
    variants: definition.variants.map((variant) => ({ ...variant })),
    ruleId: rule.ruleId,
    revision: rule.revision,
  };
}

function templateProjection(rule: FilterRuleRecord): AgentTemplateProjection | undefined {
  if (rule.ruleKind !== 'agent_template' || rule.effect.type !== 'emit_identity') return undefined;
  const match: Record<string, string | Record<string, string>> = {};
  const labels: Record<string, string> = {};
  let deployment: AgentTemplateProjection['deployment'] = 'any';
  const fieldMap: Partial<Record<FilterRuleCondition['field'], string>> = {
    'workload.namespace': 'namespace',
    'workload.owner_name': 'owner',
    'workload.container': 'container',
    'workload.service': 'pod',
    'workload.systemd_unit': 'systemdUnit',
    'process.exe_basename': 'executable',
    'process.argv_prefix': 'command',
  };
  for (const condition of rule.matcher.all ?? []) {
    const value = Array.isArray(condition.value) ? condition.value[0] : text(condition.value);
    if (!value) continue;
    if (condition.field === 'workload.placement' && ['host', 'docker', 'kubernetes'].includes(value)) {
      deployment = value as AgentTemplateProjection['deployment'];
    } else if (condition.field === 'workload.label' && condition.key) labels[condition.key] = value;
    else if (fieldMap[condition.field]) match[fieldMap[condition.field]!] = value;
  }
  if (Object.keys(labels).length) match.labels = labels;
  return {
    id: rule.source.ref?.replace(/^agent-template:/u, '') || rule.ruleId,
    displayName: rule.name,
    deployment,
    classification: rule.effect.classification,
    match,
    ruleId: rule.ruleId,
    revision: rule.revision,
  };
}

export function compileFilterRuleProjection(input: {
  rules: readonly FilterRuleRecord[];
  catalogVersion: number;
  domainVersions: FilterRuleDomainVersions;
  now?: number;
  ttlMs?: number;
}): FilterRuleProjection {
  const now = input.now ?? Date.now();
  const ttlMs = Math.max(5_000, Math.min(300_000, input.ttlMs ?? 120_000));
  const active = effectiveRules(input.rules, false, now);
  const runtimeSignatures = active
    .filter((rule) => rule.ruleKind === 'runtime_signature')
    .map((rule) => builtinSignatureProjection(rule) ?? customSignature(rule))
    .filter((rule): rule is AgentRuntimeSignatureProjection => Boolean(rule));
  const templates = active.map(templateProjection).filter((rule): rule is AgentTemplateProjection => Boolean(rule));
  const captureProfiles = structuredClone(CAPTURE_PROFILE_ACTIONS);
  for (const rule of active
    .filter((candidate) => candidate.effect.type === 'assign_capture_profile')
    .sort((left, right) => left.priority - right.priority)) {
    if (rule.effect.type === 'assign_capture_profile') {
      captureProfiles[rule.effect.captureProfile] = { ...rule.effect.probeActions };
    }
  }
  const content = {
    schemaVersion: FILTER_RULE_PROJECTION_SCHEMA,
    catalogVersion: input.catalogVersion,
    domainVersions: { ...input.domainVersions },
    generatedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
    runtimeSignatures: {
      schemaVersion: 'anysentry.agent_runtime_signatures.v1' as const,
      version: Math.max(BUILTIN_RUNTIME_SIGNATURE_VERSION, input.domainVersions.identity),
      runtimes: runtimeSignatures,
    },
    agentTemplates: {
      schemaVersion: 'anysentry.agent_templates.v1' as const,
      version: input.domainVersions.identity,
      templates,
    },
    identityRules: active.filter((rule) => [
      'non_agent_runtime_signature',
      'deployment_binding',
      'reviewed_identity_binding',
      'behavior_candidate',
      'workload_role_binding',
    ].includes(rule.ruleKind)),
    captureProfiles,
    captureProfileRules: active.filter((rule) => rule.ruleKind === 'capture_profile' || rule.ruleKind === 'investigation_override'),
    signalEnablementRules: active.filter((rule) => rule.ruleKind === 'signal_enablement'),
    semanticRetentionRules: active.filter((rule) => rule.ruleKind === 'semantic_retention'),
    persistenceRetentionRules: active.filter((rule) => rule.ruleKind === 'persistence_retention'),
    safetyGuardrails: active.filter((rule) => rule.ruleKind === 'safety_guardrail'),
    forwarderSettings: {
      filterMode: 'enforce' as const,
      retainUnknown: true as const,
      retainNonAgent: false as const,
      noisePolicy: 'balanced' as const,
      fileAggregationEnabled: true as const,
      fileAggregationWindowMs: 100,
    },
  };
  const intentHash = filterRuleDigest({
    schemaVersion: content.schemaVersion,
    domainVersions: {
      identity: content.domainVersions.identity,
      capture: content.domainVersions.capture,
      forwarder: content.domainVersions.forwarder,
    },
    runtimeSignatures: content.runtimeSignatures,
    agentTemplates: content.agentTemplates,
    identityRules: content.identityRules,
    captureProfiles: content.captureProfiles,
    captureProfileRules: content.captureProfileRules,
    signalEnablementRules: content.signalEnablementRules,
    semanticRetentionRules: content.semanticRetentionRules,
    safetyGuardrails: content.safetyGuardrails,
    forwarderSettings: content.forwarderSettings,
  });
  const projection = { ...content, intentHash };
  return { ...projection, contentHash: filterRuleDigest(projection) };
}

export function effectIsDestructive(effect: FilterRuleEffect): boolean {
  if (effect.type === 'assign_capture_profile') return Object.values(effect.probeActions).includes('drop');
  if (effect.type === 'semantic_retention') return effect.action === 'suppress';
  if (effect.type === 'persistence_retention') return effect.action === 'discard' || effect.action === 'reject';
  return false;
}

export function closedClassification(value: unknown): AgentClassification {
  return value === 'confirmed_agent' || value === 'probable_agent' || value === 'non_agent' ? value : 'unknown';
}

export function closedWorkloadRole(value: unknown): WorkloadRole {
  return value === 'agent' || value === 'anysentry_internal' || value === 'platform_infrastructure'
    || value === 'business_service' || value === 'ordinary_process' ? value : 'unknown';
}

export function closedCaptureProfile(value: unknown): CaptureProfile {
  return Object.hasOwn(CAPTURE_PROFILE_ACTIONS, String(value))
    ? value as CaptureProfile
    : 'unknown_discovery';
}
