import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AuditService } from './audit.service';
import { ClickHouseStore } from './clickhouse-store';
import { builtinFilterRules, CAPTURE_PROFILE_ACTIONS, filterRuleDigest } from './filter-rule-builtins';
import {
  compileFilterRuleEvaluationIndex,
  compileFilterRuleProjection,
  effectIsDestructive,
  evaluateIndexedFilterRules,
  type FilterRuleEvaluationIndex,
  stageImpactForRule,
} from './filter-rule-engine';
import {
  CaptureProbeActions,
  FILTER_RULE_SCHEMA,
  FILTER_RULE_STATE_SCHEMA,
  FilterRuleActor,
  FilterRuleAuthority,
  FilterRuleCategory,
  FilterRuleCondition,
  FilterRuleConditionField,
  FilterRuleDomainVersions,
  FilterRuleDraftRequest,
  FilterRuleEffect,
  FilterRuleEvaluationContext,
  FilterRuleDecisionReceipt,
  FilterRuleKind,
  FilterRuleLifecycleStage,
  FilterRuleOperationRecord,
  FilterRulePreviewResult,
  FilterRuleProjection,
  FilterRuleRecord,
  FilterRuleStage,
  FilterRuleStateDocument,
  FilterRuleTransitionRequest,
} from './filter-rule.types';
import { RelationalBusinessStore } from './relational-business-store.service';

const CONFIG_KEY = 'filter_rule_state_v1';
const MAX_RULES = 2_000;
const MAX_REVISIONS = 10_000;
const MAX_OPERATIONS = 2_000;
const PREVIEW_TTL_MS = 5 * 60_000;
const ALLOWED_FIELDS = new Set<FilterRuleConditionField>([
  'process.comm', 'process.exe_basename', 'process.argv0_basename', 'process.argv_prefix',
  'identity.classification', 'identity.source_rule', 'workload.role', 'workload.placement', 'workload.cluster',
  'workload.namespace', 'workload.owner_kind', 'workload.owner_name', 'workload.container',
  'workload.service', 'workload.systemd_unit', 'workload.label', 'asset.id', 'runtime.id',
  'runtime.state', 'binding.quality', 'signal.name',
  'event.kind', 'event.probe', 'decision.conflict', 'control.stale',
  'decision.structural_risk',
]);
const CATEGORY_KINDS: Record<FilterRuleCategory, Set<FilterRuleKind>> = {
  agent_identity: new Set(['runtime_signature', 'non_agent_runtime_signature', 'agent_template', 'deployment_binding', 'reviewed_identity_binding', 'behavior_candidate']),
  infrastructure: new Set(['workload_role_binding']),
  capture_profile: new Set(['capture_profile', 'signal_enablement']),
  forwarder_retention: new Set(['semantic_retention']),
  api_retention: new Set(['persistence_retention']),
  safety_guardrail: new Set(['safety_guardrail']),
  investigation: new Set(['investigation_override']),
  learning_candidate: new Set(['learning_candidate']),
};

export class FilterRuleError extends Error {
  constructor(
    readonly code:
      | 'not_found'
      | 'invalid_rule'
      | 'invalid_transition'
      | 'revision_conflict'
      | 'authority_required'
      | 'capacity_exceeded'
      | 'persistence_unavailable',
    message: string,
  ) {
    super(message);
  }
}

function text(value: unknown, limit = 500): string | undefined {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized ? normalized.slice(0, limit) : undefined;
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function id(prefix: string, values: unknown[]): string {
  const hash = createHash('sha256');
  for (const value of values) hash.update(JSON.stringify(value ?? null)).update('\0');
  return `${prefix}_${hash.digest('hex').slice(0, 24)}`;
}

function withHash(record: Omit<FilterRuleRecord, 'contentHash'> | FilterRuleRecord): FilterRuleRecord {
  const { contentHash: _contentHash, ...content } = record as FilterRuleRecord;
  return { ...content, contentHash: filterRuleDigest(content) };
}

function validHash(record: FilterRuleRecord): boolean {
  const { contentHash, ...content } = record;
  return contentHash === filterRuleDigest(content);
}

function stageSet(kind: FilterRuleKind): FilterRuleStage[] {
  if (['runtime_signature', 'non_agent_runtime_signature', 'agent_template', 'deployment_binding', 'reviewed_identity_binding', 'behavior_candidate', 'workload_role_binding'].includes(kind)) {
    return ['f0', 'f1', 'f2', 'f3'];
  }
  if (kind === 'capture_profile') return ['f0', 'f1', 'f2'];
  if (kind === 'signal_enablement') return ['f0', 'f1', 'f2', 'f3'];
  if (kind === 'semantic_retention') return ['f2'];
  if (kind === 'persistence_retention') return ['f3'];
  if (kind === 'investigation_override') return ['f1', 'f2'];
  if (kind === 'learning_candidate') return ['f0'];
  return ['f1', 'f2', 'f3'];
}

function domainsForRule(rule: Pick<FilterRuleRecord, 'ruleKind'>): Array<keyof FilterRuleDomainVersions> {
  if (['runtime_signature', 'non_agent_runtime_signature', 'agent_template', 'deployment_binding', 'reviewed_identity_binding', 'behavior_candidate', 'workload_role_binding', 'learning_candidate'].includes(rule.ruleKind)) {
    return ['identity'];
  }
  if (rule.ruleKind === 'capture_profile') return ['capture', 'forwarder'];
  if (rule.ruleKind === 'signal_enablement') return ['identity', 'capture', 'forwarder', 'retention'];
  if (rule.ruleKind === 'semantic_retention') return ['forwarder'];
  if (rule.ruleKind === 'persistence_retention') return ['retention'];
  if (rule.ruleKind === 'investigation_override') return ['capture', 'forwarder'];
  return ['capture', 'forwarder', 'retention'];
}

function conditionHas(
  conditions: readonly FilterRuleCondition[],
  field: FilterRuleConditionField,
  expected?: string,
): boolean {
  return conditions.some((condition) => {
    if (condition.field !== field) return false;
    if (expected === undefined) return true;
    const values = Array.isArray(condition.value) ? condition.value : [condition.value];
    return values.some((value) => String(value ?? '').trim().toLowerCase() === expected);
  });
}

function validateCondition(condition: FilterRuleCondition, index: number): string[] {
  const errors: string[] = [];
  if (!condition || !ALLOWED_FIELDS.has(condition.field)) errors.push(`matcher condition ${index} has an unsupported field`);
  if (!['equals', 'one_of', 'prefix', 'present'].includes(condition?.operator)) errors.push(`matcher condition ${index} has an unsupported operator`);
  if (condition?.field === 'workload.label' && !text(condition.key, 128)) errors.push(`matcher condition ${index} requires a bounded label key`);
  if (condition?.field !== 'workload.label' && condition?.key !== undefined) errors.push(`matcher condition ${index} cannot carry a label key`);
  if (condition?.operator !== 'present') {
    const values = Array.isArray(condition?.value) ? condition.value : [condition?.value];
    if (!values.length || values.length > 32) errors.push(`matcher condition ${index} must contain 1..32 values`);
    for (const value of values) {
      if (typeof value === 'boolean') continue;
      const normalized = text(value, 500);
      if (!normalized) errors.push(`matcher condition ${index} contains an empty value`);
      if (normalized && /[?*\[\]{}()|^$\\]/u.test(normalized)) {
        errors.push(`matcher condition ${index} cannot contain glob or regex syntax`);
      }
    }
  }
  return errors;
}

function validateProbeActions(actions: CaptureProbeActions): string[] {
  const errors: string[] = [];
  const probes = ['exec', 'exit', 'tls', 'connect', 'dns', 'file_access', 'file_delete', 'llm', 'ssl', 'security', 'file_read'] as const;
  const keys = Object.keys(actions ?? {});
  if (keys.length !== probes.length || keys.some((key) => !probes.includes(key as typeof probes[number]))) {
    errors.push('capture profile must define the complete closed Probe matrix');
  }
  for (const probe of probes) {
    if (!['full', 'aggregate', 'sample', 'drop', 'not_enabled'].includes(actions?.[probe])) errors.push(`capture profile ${probe} has an invalid action`);
  }
  if (actions?.exec !== 'full' || actions?.exit !== 'full' || actions?.security !== 'full') {
    errors.push('Exec, Exit, and Security must remain FULL');
  }
  if (Object.values(actions ?? {}).includes('drop')) {
    errors.push('generic Capture Profile drafts cannot DROP; use an exact Infrastructure asset rule');
  }
  return errors;
}

function validateEffect(
  category: FilterRuleCategory,
  kind: FilterRuleKind,
  effect: FilterRuleEffect | undefined,
  conditions: readonly FilterRuleCondition[],
): string[] {
  const errors: string[] = [];
  if (!effect || typeof effect !== 'object') return ['a typed rule effect is required'];
  if (kind === 'runtime_signature') {
    if (effect.type !== 'emit_identity' || effect.classification !== 'probable_agent' || effect.confidence > 0.9) {
      errors.push('Runtime Signature may only emit probable_agent with confidence <= 0.9');
    }
    if (!conditions.some((condition) => condition.field.startsWith('process.'))) errors.push('Runtime Signature requires an exact process condition');
  } else if (kind === 'non_agent_runtime_signature') {
    if (effect.type !== 'emit_identity' || effect.classification !== 'non_agent' || effect.confidence !== 1) {
      errors.push('Non-Agent Runtime Signature must emit exact non_agent identity with confidence=1');
    }
    if (!conditions.some((condition) => condition.field.startsWith('process.'))) {
      errors.push('Non-Agent Runtime Signature requires an exact process condition');
    }
  } else if (kind === 'agent_template' || kind === 'deployment_binding' || kind === 'reviewed_identity_binding' || kind === 'behavior_candidate') {
    if (effect.type !== 'emit_identity') errors.push(`${kind} requires emit_identity`);
  } else if (kind === 'workload_role_binding') {
    if (effect.type !== 'assign_role') errors.push('workload_role_binding requires assign_role');
  } else if (kind === 'capture_profile') {
    if (effect.type !== 'assign_capture_profile') errors.push('capture_profile requires assign_capture_profile');
    else errors.push(...validateProbeActions(effect.probeActions));
  } else if (kind === 'signal_enablement') {
    if (
      effect.type !== 'enable_signal'
      || effect.signal !== 'file_open_read'
      || effect.captureAction !== 'full'
      || effect.scopeMode !== 'exact_runtime_or_root'
    ) errors.push('signal_enablement requires the exact file_open_read enablement effect');
    if (!conditionHas(conditions, 'identity.classification')) {
      errors.push('signal_enablement requires an Agent identity matcher');
    }
    if (!conditionHas(conditions, 'binding.quality', 'exact')) {
      errors.push('signal_enablement requires exact binding quality');
    }
  } else if (kind === 'semantic_retention') {
    if (effect.type !== 'semantic_retention') errors.push('semantic_retention requires its typed effect');
    if (effect.type === 'semantic_retention' && effect.action === 'suppress' && !conditionHas(conditions, 'identity.classification', 'non_agent')) {
      errors.push('Forwarder SUPPRESS requires an exact non_agent matcher');
    }
  } else if (kind === 'persistence_retention') {
    if (effect.type !== 'persistence_retention') errors.push('persistence_retention requires its typed effect');
    if (effect.type === 'persistence_retention' && ['discard', 'reject'].includes(effect.action) && !conditionHas(conditions, 'identity.classification', 'non_agent')) {
      errors.push('API DISCARD/REJECT requires an exact non_agent matcher');
    }
  } else if (kind === 'investigation_override') {
    if (effect.type !== 'investigation' || effect.captureProfile !== 'investigation_full') errors.push('investigation_override requires an investigation_full effect');
    const expiry = effect.type === 'investigation' ? Date.parse(effect.expiresAt) : Number.NaN;
    if (!Number.isFinite(expiry) || expiry <= Date.now() || expiry > Date.now() + 24 * 60 * 60_000) {
      errors.push('investigation override expiry must be within the next 24 hours');
    }
    if (!conditionHas(conditions, 'asset.id') && !conditionHas(conditions, 'runtime.id')) {
      errors.push('investigation override requires an exact Asset or Runtime scope');
    }
  } else if (kind === 'learning_candidate') {
    if (effect.type !== 'learning_recommendation') errors.push('learning_candidate requires a recommendation-only effect');
  } else if (kind === 'safety_guardrail' || category === 'safety_guardrail') {
    errors.push('Safety Guardrails are software-versioned and cannot be created through the management API');
  }
  return errors;
}

function validateDraft(input: FilterRuleDraftRequest): {
  category?: FilterRuleCategory;
  kind?: FilterRuleKind;
  errors: string[];
} {
  const category = input.category;
  const kind = input.ruleKind;
  const errors: string[] = [];
  if (!category || !Object.hasOwn(CATEGORY_KINDS, category)) errors.push('a supported rule category is required');
  if (!kind || !category || !CATEGORY_KINDS[category]?.has(kind)) errors.push('ruleKind is not valid for the selected category');
  const all = Array.isArray(input.matcher?.all) ? input.matcher!.all! : [];
  const any = Array.isArray(input.matcher?.any) ? input.matcher!.any! : [];
  const conditions = [...all, ...any];
  if (!text(input.matcher?.description, 1_000)) errors.push('a human matcher description is required');
  if (!conditions.length || conditions.length > 32) errors.push('matcher must contain 1..32 typed conditions');
  conditions.forEach((condition, index) => errors.push(...validateCondition(condition, index)));
  if (category && kind) errors.push(...validateEffect(category, kind, input.effect, conditions));
  if (!text(input.name, 240)) errors.push('a bounded rule name is required');
  if (!text(input.description, 1_000)) errors.push('a bounded rule description is required');
  if (!text(input.reason, 500)) errors.push('a bounded change reason is required');
  return { category, kind, errors: [...new Set(errors)] };
}

function normalizedDraft(input: FilterRuleDraftRequest): FilterRuleDraftRequest {
  const next = structuredClone(input);
  if (
    next.ruleKind === 'capture_profile'
    && next.effect?.type === 'assign_capture_profile'
    && Object.hasOwn(CAPTURE_PROFILE_ACTIONS, next.effect.captureProfile)
  ) {
    next.effect.probeActions = {
      ...structuredClone(CAPTURE_PROFILE_ACTIONS[next.effect.captureProfile]),
      ...(next.effect.probeActions ?? {}),
    };
  }
  return next;
}

@Injectable()
export class FilterRuleCatalogService implements OnModuleInit, OnModuleDestroy {
  private readonly ch = new ClickHouseStore();
  private readonly builtins = builtinFilterRules();
  private readonly rules = new Map<string, FilterRuleRecord>();
  private revisions: FilterRuleRecord[] = [];
  private operations: FilterRuleOperationRecord[] = [];
  private catalogVersion = 1;
  private domainVersions: FilterRuleDomainVersions = { identity: 1, capture: 1, forwarder: 1, retention: 1 };
  private updatedAt = 0;
  private readonly evaluationIndex = new Map<FilterRuleStage, { catalogVersion: number; index: FilterRuleEvaluationIndex }>();
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly validations = new Map<string, {
    revision: number;
    at: number;
    valid: boolean;
    destructive: boolean;
    serverOwned: boolean;
    matchedAssets: number;
    matchedInstances: number;
    matchedNodes: number;
    conflicts: number;
  }>();

  constructor(
    private readonly relational: RelationalBusinessStore,
    private readonly audit: AuditService,
  ) {}

  async onModuleInit(): Promise<void> {
    const [clickhouseSaved, relationalSaved] = await Promise.all([
      this.ch.init().then((ready) => ready
        ? this.ch.loadPlatformConfig<FilterRuleStateDocument>(CONFIG_KEY)
        : undefined),
      this.relational.loadPlatformConfig<FilterRuleStateDocument>(CONFIG_KEY),
    ]);
    const saved = [clickhouseSaved, relationalSaved]
      .filter((entry): entry is { record: FilterRuleStateDocument; updatedAt: number } => Boolean(entry))
      .sort((left, right) => right.updatedAt - left.updatedAt)[0];
    if (saved?.record.schemaVersion === FILTER_RULE_STATE_SCHEMA) this.restore(saved.record);
    if (saved) await this.persist();
  }

  async onModuleDestroy(): Promise<void> {
    await this.mutationTail.catch(() => undefined);
    await this.persist(true);
    await this.ch.close();
  }

  status() {
    return {
      schemaVersion: FILTER_RULE_STATE_SCHEMA,
      catalogVersion: this.catalogVersion,
      domainVersions: { ...this.domainVersions },
      builtinRules: this.builtins.length,
      managedRules: this.rules.size,
      revisions: this.revisions.length,
      operations: this.operations.length,
      updatedAt: new Date(this.updatedAt || Date.now()).toISOString(),
      postgresqlBacked: this.relational.isReady(),
      clickhouseMigrationCopy: this.ch.enabled,
    };
  }

  versions(): { catalogVersion: number; domainVersions: FilterRuleDomainVersions; updatedAt: number } {
    return {
      catalogVersion: this.catalogVersion,
      domainVersions: { ...this.domainVersions },
      updatedAt: this.updatedAt,
    };
  }

  allRules(): FilterRuleRecord[] {
    return [...this.builtins, ...this.rules.values()].map((rule) => structuredClone(rule));
  }

  managedRules(): FilterRuleRecord[] {
    return [...this.rules.values()].map((rule) => structuredClone(rule));
  }

  get(ruleId: string): FilterRuleRecord {
    const rule = this.rules.get(ruleId) ?? this.builtins.find((candidate) => candidate.ruleId === ruleId);
    if (!rule) throw new FilterRuleError('not_found', 'filter rule not found');
    return structuredClone(rule);
  }

  getRevisions(ruleId: string): FilterRuleRecord[] {
    const builtin = this.builtins.find((candidate) => candidate.ruleId === ruleId);
    if (builtin) return [structuredClone(builtin)];
    const revisions = this.revisions.filter((revision) => revision.ruleId === ruleId)
      .sort((left, right) => right.revision - left.revision);
    if (!revisions.length) this.get(ruleId);
    return revisions.map((revision) => structuredClone(revision));
  }

  listOperations(ruleId?: string, limit = 200): FilterRuleOperationRecord[] {
    return this.operations
      .filter((operation) => !ruleId || operation.ruleId === ruleId)
      .sort((left, right) => right.requestedAt - left.requestedAt)
      .slice(0, integer(limit, 200, 1, 500))
      .map((operation) => ({ ...operation }));
  }

  projection(now = Date.now()): FilterRuleProjection {
    return compileFilterRuleProjection({
      rules: this.allRules(),
      catalogVersion: this.catalogVersion,
      domainVersions: this.domainVersions,
      now,
    });
  }

  evaluate(stage: FilterRuleStage, context: FilterRuleEvaluationContext, includeShadow = false): FilterRuleDecisionReceipt {
    let indexed = this.evaluationIndex.get(stage);
    if (!indexed || indexed.catalogVersion !== this.catalogVersion) {
      indexed = {
        catalogVersion: this.catalogVersion,
        index: compileFilterRuleEvaluationIndex(
          [...this.builtins, ...this.rules.values()].filter((rule) => rule.consumerCapabilities.includes(stage)),
        ),
      };
      this.evaluationIndex.set(stage, indexed);
    }
    return evaluateIndexedFilterRules({
      index: indexed.index,
      context,
      stage,
      catalogVersion: this.catalogVersion,
      domainVersions: this.domainVersions,
      includeShadow,
    });
  }

  inspectDraft(input: FilterRuleDraftRequest): { valid: boolean; errors: string[]; rule?: FilterRuleRecord } {
    input = normalizedDraft(input);
    const validation = validateDraft(input);
    if (validation.errors.length || !validation.category || !validation.kind) {
      return { valid: false, errors: validation.errors };
    }
    const predecessorError = this.validatePredecessor(input, validation.category, validation.kind);
    if (predecessorError) return { valid: false, errors: [predecessorError] };
    const now = Date.now();
    const content = {
      schemaVersion: FILTER_RULE_SCHEMA,
      ruleId: `fr_preview_${filterRuleDigest(input).slice(0, 16)}`,
      revision: 1,
      name: text(input.name, 240)!,
      description: text(input.description, 1_000)!,
      category: validation.category,
      ruleKind: validation.kind,
      source: { type: 'operator' as const, ref: 'simulation', issuer: 'simulation' },
      owner: 'simulation',
      management: 'catalog' as const,
      editable: true,
      lifecycleStage: 'draft' as const,
      authority: 'candidate' as const,
      priority: integer(input.priority, 500, 1, 999),
      matcher: structuredClone(input.matcher!),
      effect: structuredClone(input.effect!),
      consumerCapabilities: stageSet(validation.kind),
      createdBy: 'simulation',
      createdAt: now,
      updatedAt: now,
      reason: text(input.reason, 500)!,
      ticket: text(input.ticket, 240),
      predecessorRuleId: text(input.predecessorRuleId, 240),
    };
    return { valid: true, errors: [], rule: withHash(content) };
  }

  createDraft(input: FilterRuleDraftRequest, actor: FilterRuleActor): Promise<FilterRuleRecord> {
    return this.mutate(async () => {
      input = normalizedDraft(input);
      const validation = validateDraft(input);
      if (validation.errors.length || !validation.category || !validation.kind) {
        throw new FilterRuleError('invalid_rule', validation.errors.join('; '));
      }
      if (this.rules.size >= MAX_RULES) throw new FilterRuleError('capacity_exceeded', 'filter rule capacity exceeded');
      const predecessorError = this.validatePredecessor(input, validation.category, validation.kind);
      if (predecessorError) throw new FilterRuleError('invalid_rule', predecessorError);
      const now = Date.now();
      const matcher = structuredClone(input.matcher!);
      const effect = structuredClone(input.effect!);
      const ruleId = id('fr', [now, this.catalogVersion, actor.id, input.name, matcher, effect]);
      const rule = withHash({
        schemaVersion: FILTER_RULE_SCHEMA,
        ruleId,
        revision: 1,
        name: text(input.name, 240)!,
        description: text(input.description, 1_000)!,
        category: validation.category,
        ruleKind: validation.kind,
        source: { type: 'operator', ref: `${validation.kind}:${ruleId}`, issuer: actor.id },
        owner: actor.id,
        management: 'catalog',
        editable: true,
        lifecycleStage: 'draft',
        authority: 'candidate',
        priority: integer(input.priority, 500, 1, 999),
        matcher,
        effect,
        consumerCapabilities: stageSet(validation.kind),
        createdBy: actor.id,
        createdAt: now,
        updatedAt: now,
        reason: text(input.reason, 500)!,
        ticket: text(input.ticket, 240),
        predecessorRuleId: text(input.predecessorRuleId, 240),
      });
      this.rules.set(rule.ruleId, rule);
      this.revisions.push(rule);
      this.bump(rule);
      const persisted = await this.persist();
      this.audit.record({
        actor,
        action: 'filter_rule.created',
        resourceType: 'filter-rule',
        resourceId: rule.ruleId,
        summary: `Created filter rule draft: ${rule.name}`,
        result: persisted ? 'success' : 'failure',
        details: { revision: rule.revision, category: rule.category, ruleKind: rule.ruleKind, stages: rule.consumerCapabilities },
      });
      await this.recordOperation('create', actor, rule, input.reason, 'succeeded');
      return structuredClone(rule);
    });
  }

  private validatePredecessor(
    input: FilterRuleDraftRequest,
    category: FilterRuleCategory,
    kind: FilterRuleKind,
  ): string | undefined {
    const predecessorRuleId = text(input.predecessorRuleId, 240);
    if (!predecessorRuleId) return undefined;
    let predecessor: FilterRuleRecord;
    try {
      predecessor = this.get(predecessorRuleId);
    } catch (error) {
      if (error instanceof FilterRuleError && error.code === 'not_found') return 'predecessor rule does not exist';
      throw error;
    }
    if (!predecessor.editable || predecessor.management !== 'catalog') {
      return 'built-in and compatibility rules can only be replaced by their authoritative source';
    }
    if (predecessor.category !== category || predecessor.ruleKind !== kind) {
      return 'successor rule must keep the predecessor category and rule kind';
    }
    if (predecessor.lifecycleStage === 'draft') return 'a draft cannot be used as a predecessor';
    return undefined;
  }

  preview(
    ruleId: string,
    actor: FilterRuleActor,
    input: {
      serverOwned?: boolean;
      matchedAssets?: number;
      matchedInstances?: number;
      matchedNodes?: number;
      conflicts?: number;
      errors?: string[];
      warnings?: string[];
    } = {},
  ): Promise<FilterRulePreviewResult> {
    return this.mutate(async () => {
      const rule = this.get(ruleId);
      if (!rule.editable) throw new FilterRuleError('invalid_transition', 'builtin and adapter rules are read-only');
      const draftValidation = validateDraft({
        name: rule.name,
        description: rule.description,
        category: rule.category,
        ruleKind: rule.ruleKind,
        matcher: rule.matcher,
        effect: rule.effect,
        reason: rule.reason,
      });
      const errors = [...draftValidation.errors, ...(input.errors ?? [])];
      const warnings = [...(input.warnings ?? [])];
      const destructive = effectIsDestructive(rule.effect);
      const matchedAssets = integer(input.matchedAssets, 0, 0, 20_000);
      const matchedInstances = integer(input.matchedInstances, 0, 0, 100_000);
      const matchedNodes = integer(input.matchedNodes, 0, 0, 10_000);
      const conflicts = integer(input.conflicts, 0, 0, 100_000);
      if (destructive && input.serverOwned !== true) errors.push('destructive preview requires server-owned Inventory');
      if (destructive && matchedAssets === 0) errors.push('destructive rule has no current stable asset match');
      if (destructive && conflicts > 0) errors.push('destructive rule conflicts with an Agent or ambiguous identity');
      if (!destructive && matchedAssets === 0) warnings.push('no current asset matched; rule can enter shadow but has no materialized effect');
      const valid = errors.length === 0;
      this.validations.set(rule.ruleId, {
        revision: rule.revision,
        at: Date.now(),
        valid,
        destructive,
        serverOwned: input.serverOwned === true,
        matchedAssets,
        matchedInstances,
        matchedNodes,
        conflicts,
      });
      const result: FilterRulePreviewResult = {
        ruleId: rule.ruleId,
        revision: rule.revision,
        valid,
        errors: [...new Set(errors)],
        warnings: [...new Set(warnings)],
        destructive,
        affectedStages: [...rule.consumerCapabilities],
        matchedAssets,
        matchedInstances,
        matchedNodes,
        conflicts,
        canEnterShadow: rule.lifecycleStage === 'draft' && valid,
        canPromote: rule.lifecycleStage === 'shadow' && valid,
        stageImpacts: stageImpactForRule(rule, this.domainVersions),
      };
      this.audit.record({
        actor,
        action: 'filter_rule.previewed',
        resourceType: 'filter-rule',
        resourceId: rule.ruleId,
        summary: `Previewed filter rule: ${rule.name}`,
        result: valid ? 'success' : 'failure',
        details: { revision: rule.revision, destructive, matchedAssets, matchedInstances, matchedNodes, conflicts, errors },
      });
      await this.recordOperation('preview', actor, rule, 'server-owned filter rule preview', valid ? 'succeeded' : 'failed', errors.join('; '));
      return result;
    });
  }

  shadow(ruleId: string, input: FilterRuleTransitionRequest, actor: FilterRuleActor): Promise<FilterRuleRecord> {
    return this.transition(ruleId, input, actor, 'shadow');
  }

  promote(ruleId: string, input: FilterRuleTransitionRequest, actor: FilterRuleActor): Promise<FilterRuleRecord> {
    return this.transition(ruleId, input, actor, 'enforced');
  }

  revoke(ruleId: string, input: FilterRuleTransitionRequest, actor: FilterRuleActor): Promise<FilterRuleRecord> {
    return this.transition(ruleId, input, actor, 'revoked');
  }

  private transition(
    ruleId: string,
    input: FilterRuleTransitionRequest,
    actor: FilterRuleActor,
    target: Exclude<FilterRuleLifecycleStage, 'draft'>,
  ): Promise<FilterRuleRecord> {
    return this.mutate(async () => {
      const current = this.get(ruleId);
      if (!current.editable || current.management !== 'catalog') throw new FilterRuleError('invalid_transition', 'builtin and adapter rules are read-only');
      if (input.expectedRevision !== undefined && integer(input.expectedRevision, -1, -1, Number.MAX_SAFE_INTEGER) !== current.revision) {
        throw new FilterRuleError('revision_conflict', 'filter rule revision does not match');
      }
      const reason = text(input.reason, 500);
      if (!reason) throw new FilterRuleError('invalid_transition', 'a bounded transition reason is required');
      if (target === 'shadow' && current.lifecycleStage !== 'draft') throw new FilterRuleError('invalid_transition', 'only a draft rule can enter shadow');
      if (target === 'enforced') {
        if (current.lifecycleStage !== 'shadow') throw new FilterRuleError('invalid_transition', 'only a shadow rule can be enforced');
        if (current.createdBy === actor.id) throw new FilterRuleError('authority_required', 'a different operator must approve the rule');
        const validation = this.validations.get(ruleId);
        if (!validation || validation.revision !== current.revision || !validation.valid || Date.now() - validation.at > PREVIEW_TTL_MS) {
          throw new FilterRuleError('authority_required', 'a recent valid server preview is required');
        }
        if (validation.destructive && (!validation.serverOwned || validation.matchedAssets === 0 || validation.conflicts > 0)) {
          throw new FilterRuleError('authority_required', 'destructive rule requires stable Inventory matches with zero Agent conflicts');
        }
      }
      if (target === 'revoked' && current.lifecycleStage === 'revoked') return current;
      const now = Date.now();
      const nextAuthority: FilterRuleAuthority = target === 'enforced' ? 'authoritative' : current.authority;
      const next = withHash({
        ...current,
        revision: current.revision + 1,
        lifecycleStage: target,
        authority: nextAuthority,
        approvedBy: target === 'enforced' ? actor.id : current.approvedBy,
        updatedAt: now,
        reason,
        ticket: text(input.ticket, 240) ?? current.ticket,
      });
      const before = current;
      const revisionLength = this.revisions.length;
      const previousCatalogVersion = this.catalogVersion;
      const previousDomainVersions = { ...this.domainVersions };
      const previousUpdatedAt = this.updatedAt;
      this.rules.set(ruleId, next);
      this.revisions.push(next);
      this.validations.delete(ruleId);
      this.bump(next);
      const persisted = await this.persist();
      if (target === 'enforced' && !persisted) {
        this.rules.set(ruleId, before);
        this.revisions = this.revisions.slice(0, revisionLength);
        this.catalogVersion = previousCatalogVersion;
        this.domainVersions = previousDomainVersions;
        this.updatedAt = previousUpdatedAt;
        throw new FilterRuleError('persistence_unavailable', 'enforced filter rule was not durable and was not published');
      }
      const operationKind = target === 'shadow' ? 'shadow' : target === 'enforced' ? 'promote' : 'revoke';
      const action = target === 'shadow' ? 'filter_rule.shadowed' : target === 'enforced' ? 'filter_rule.promoted' : 'filter_rule.revoked';
      this.audit.record({
        actor,
        action,
        resourceType: 'filter-rule',
        resourceId: next.ruleId,
        summary: `${operationKind} filter rule: ${next.name}`,
        result: persisted ? 'success' : 'failure',
        details: { previousRevision: current.revision, revision: next.revision, previousStage: current.lifecycleStage, stage: target, reason },
      });
      await this.recordOperation(operationKind, actor, next, reason, 'succeeded', undefined, current.revision);
      return structuredClone(next);
    });
  }

  private bump(rule: FilterRuleRecord): void {
    this.catalogVersion += 1;
    for (const domain of domainsForRule(rule)) this.domainVersions[domain] += 1;
    this.updatedAt = Date.now();
    this.evaluationIndex.clear();
    this.revisions = this.revisions.slice(-MAX_REVISIONS);
  }

  private async recordOperation(
    kind: FilterRuleOperationRecord['kind'],
    actor: FilterRuleActor,
    rule: FilterRuleRecord,
    reason: unknown,
    status: FilterRuleOperationRecord['status'],
    error?: string,
    previousRevision?: number,
  ): Promise<void> {
    const requestedAt = Date.now();
    this.operations.push({
      operationId: id('frop', [requestedAt, this.operations.length, actor.id, kind, rule.ruleId, rule.revision]),
      kind,
      status,
      ruleId: rule.ruleId,
      actorId: actor.id,
      requestedAt,
      completedAt: Date.now(),
      previousRevision,
      resultingRevision: rule.revision,
      reason: text(reason, 500),
      error: text(error, 500),
    });
    this.operations = this.operations.slice(-MAX_OPERATIONS);
    this.updatedAt = Date.now();
    await this.persist();
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationTail.catch(() => undefined).then(operation);
    this.mutationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private document(): FilterRuleStateDocument {
    return {
      schemaVersion: FILTER_RULE_STATE_SCHEMA,
      catalogVersion: this.catalogVersion,
      domainVersions: { ...this.domainVersions },
      updatedAt: this.updatedAt || Date.now(),
      rules: [...this.rules.values()],
      revisions: this.revisions.slice(-MAX_REVISIONS),
      operations: this.operations.slice(-MAX_OPERATIONS),
    };
  }

  private async persist(awaitMirror = false): Promise<boolean> {
    const document = this.document();
    const updatedAt = document.updatedAt;
    const relationalSaved = await this.relational.savePlatformConfig(CONFIG_KEY, document, updatedAt);
    if (relationalSaved && this.relational.isReady() && !awaitMirror) {
      setImmediate(() => {
        void this.ch.savePlatformConfig(CONFIG_KEY, document, updatedAt).catch((error) => {
          console.warn('[filter-rules] ClickHouse migration mirror failed:', (error as Error).message);
        });
      });
      return true;
    }
    const clickhouseSaved = await this.ch.savePlatformConfig(CONFIG_KEY, document, updatedAt);
    return relationalSaved || clickhouseSaved;
  }

  private restore(document: FilterRuleStateDocument): void {
    const restoredRevisions = Array.isArray(document.revisions) ? document.revisions : [];
    this.revisions = restoredRevisions
      .filter((rule) => rule?.schemaVersion === FILTER_RULE_SCHEMA && rule.management === 'catalog' && validHash(rule))
      .slice(-MAX_REVISIONS);
    const restoredRules = Array.isArray(document.rules) ? document.rules : [];
    for (const rule of restoredRules.slice(-MAX_RULES)) {
      if (
        rule?.schemaVersion !== FILTER_RULE_SCHEMA
        || rule.management !== 'catalog'
        || rule.editable !== true
        || rule.authority === 'immutable'
        || !validHash(rule)
      ) continue;
      this.rules.set(rule.ruleId, rule);
      if (!this.revisions.some((revision) => revision.ruleId === rule.ruleId && revision.revision === rule.revision)) {
        this.revisions.push(rule);
      }
    }
    this.catalogVersion = integer(document.catalogVersion, 1, 1, Number.MAX_SAFE_INTEGER);
    this.domainVersions = {
      identity: integer(document.domainVersions?.identity, 1, 1, Number.MAX_SAFE_INTEGER),
      capture: integer(document.domainVersions?.capture, 1, 1, Number.MAX_SAFE_INTEGER),
      forwarder: integer(document.domainVersions?.forwarder, 1, 1, Number.MAX_SAFE_INTEGER),
      retention: integer(document.domainVersions?.retention, 1, 1, Number.MAX_SAFE_INTEGER),
    };
    this.updatedAt = integer(document.updatedAt, Date.now(), 1, Number.MAX_SAFE_INTEGER);
    this.operations = (Array.isArray(document.operations) ? document.operations : []).slice(-MAX_OPERATIONS);
    this.evaluationIndex.clear();
    this.revisions = this.revisions.slice(-MAX_REVISIONS);
  }
}
