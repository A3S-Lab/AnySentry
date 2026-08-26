import { Inject, Injectable, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AuditService } from './audit.service';
import {
  CaptureProbeActions,
  CaptureProbeName,
  INFRASTRUCTURE_CAPTURE_INTENT_SCHEMA,
  INFRASTRUCTURE_MATERIALIZATION_SCHEMA,
  INFRASTRUCTURE_POLICY_SCHEMA,
  INFRASTRUCTURE_RULE_STATE_SCHEMA,
  InfrastructureFilterAction,
  InfrastructureFilterRuleEntry,
  InfrastructureCaptureIntentV1,
  InfrastructureAssetDraftRequest,
  InfrastructureAssetDraftResult,
  InfrastructureEventPolicyKind,
  InfrastructureInventoryWorkload,
  InfrastructureMaterializationReportRecord,
  InfrastructureMaterializationReportRequest,
  InfrastructurePolicySnapshot,
  InfrastructureRuleActor,
  InfrastructureRuleAuthority,
  InfrastructureRuleCreateRequest,
  InfrastructureRuleHumanDetail,
  InfrastructureRuleHumanListResult,
  InfrastructureRuleImpactPreview,
  InfrastructureRuleImpactPartialReason,
  InfrastructureRuleListResult,
  InfrastructureRuleOperationKind,
  InfrastructureRuleOperationListResult,
  InfrastructureRuleOperationRecord,
  InfrastructureRuleRecord,
  InfrastructureRuleSelector,
  InfrastructureRuleSourceType,
  InfrastructureRuleStage,
  InfrastructureRuleStateDocument,
  InfrastructureRuleTransitionRequest,
  InfrastructureRuleValidationRequest,
  InfrastructureRuleValidationResult,
  InfrastructureWorkloadRole,
  UnknownInfrastructureDraftRequest,
  UnknownInfrastructureDraftResult,
  UnknownInfrastructureRecommendationEvidence,
} from './infrastructure-rule.types';
import {
  INFRASTRUCTURE_ASSET_SNAPSHOT_PROVIDER,
  InfrastructureAssetSnapshotProvider,
  InfrastructureGovernanceAsset,
  InfrastructureGovernanceAssetSnapshot,
  humanIntentAction,
  humanProbePolicies,
  infrastructureRuleHumanDetail,
  infrastructureRuleHumanSummary,
} from './infrastructure-rule-governance';
import { RelationalBusinessStore } from './relational-business-store.service';
import { ClickHouseStore } from './clickhouse-store';

const CONFIG_KEY = 'infrastructure_rules_v1';
const MAX_RULES = 2_000;
const MAX_REVISIONS = 10_000;
const MAX_REPORTS = 200;
const MAX_OPERATIONS = 2_000;
const MAX_BINDINGS = 5_000;
const MAX_CAPTURE_PROFILE_ENTRIES = 50_000;
const MAX_VALIDATION_INVENTORY = 2_000;
const MAX_ENFORCED_MATCHES = 500;
const MAX_GOVERNANCE_ASSETS = 20_000;
const MAX_IMPACT_PARTIAL_REASONS = 32;
const MATERIALIZATION_TTL_MS = 120_000;
const POLICY_TTL_MS = 120_000;
const VALIDATION_TTL_MS = 5 * 60_000;
const AUTHORITATIVE_SOURCES = new Set<InfrastructureRuleSourceType>([
  'manual_review',
  'platform_inventory',
  'kubernetes',
  'docker',
  'operator',
]);
const INFRASTRUCTURE_WORKLOAD_ROLES = new Set<InfrastructureWorkloadRole>([
  'anysentry_internal',
  'platform_infrastructure',
  'business_service',
  'ordinary_process',
]);

const IMPACT_PARTIAL_REASONS = new Set<InfrastructureRuleImpactPartialReason>([
  'agent_event_inventory_partial',
  'agent_event_inventory_truncated',
  'agent_fact_not_in_current_runtime_inventory',
  'asset_snapshot_duplicate_collapsed',
  'lifecycle_current_presence_unverified',
  'observation_coverage_unavailable',
  'service_context_inventory_not_ready',
  'service_context_asset_unmapped',
  'service_context_metrics_unavailable',
  'service_context_stale',
  'continuity_evidence_unavailable',
]);

function impactPartialReason(value: unknown): value is InfrastructureRuleImpactPartialReason {
  return typeof value === 'string' && IMPACT_PARTIAL_REASONS.has(value as InfrastructureRuleImpactPartialReason);
}

const SOURCE_TYPES = new Set<InfrastructureRuleSourceType>([
  'manual_review',
  'platform_inventory',
  'kubernetes',
  'docker',
  'operator',
  'behavior_discovery',
  'imported',
]);
const INFRASTRUCTURE_FILTER_ACTIONS = new Set<InfrastructureFilterAction>(['keep', 'sample', 'drop']);
const CAPTURE_PROBE_NAMES: CaptureProbeName[] = [
  'exec', 'exit', 'tls', 'connect', 'dns', 'file_access', 'file_delete', 'llm', 'ssl', 'security', 'file_read',
];
const CAPTURE_PROBE_ACTIONS = new Set(['full', 'aggregate', 'sample', 'drop', 'not_enabled']);
const CAPTURE_INTENT_ACTIONS = new Set(['full', 'aggregate', 'sample', 'drop']);
const DEFAULT_EVENT_POLICIES: Record<string, InfrastructureFilterAction> = {
  default: 'drop',
  FileAccess: 'drop',
  FileDelete: 'drop',
  Egress: 'drop',
  Dns: 'drop',
  SslContent: 'drop',
  LlmCall: 'drop',
};
const PROBE_EVENT_POLICY: Partial<Record<CaptureProbeName, string>> = {
  tls: 'Egress',
  connect: 'Egress',
  dns: 'Dns',
  file_access: 'FileAccess',
  file_delete: 'FileDelete',
  llm: 'LlmCall',
  ssl: 'SslContent',
};

function text(value: unknown, limit: number): string | undefined {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized ? normalized.slice(0, limit) : undefined;
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.trunc(parsed))) : fallback;
}

function normalizeEventPolicies(value: unknown): InfrastructureRuleRecord['eventPolicies'] {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InfrastructureRuleError('invalid_selector', 'eventPolicies must be an object');
  }
  const allowed = new Set(Object.keys(DEFAULT_EVENT_POLICIES));
  const result: InfrastructureRuleRecord['eventPolicies'] = {};
  for (const [kind, action] of Object.entries(value)) {
    if (!allowed.has(kind) || !INFRASTRUCTURE_FILTER_ACTIONS.has(action as InfrastructureFilterAction)) {
      throw new InfrastructureRuleError(
        'invalid_selector',
        `eventPolicies.${kind} must be keep, sample, or drop for a supported event kind`,
      );
    }
    result[kind as keyof NonNullable<InfrastructureRuleRecord['eventPolicies']>] =
      action as InfrastructureFilterAction;
  }
  return result;
}

function normalizeCaptureIntent(value: unknown): InfrastructureCaptureIntentV1 | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InfrastructureRuleError('invalid_selector', 'captureIntent must be a versioned object');
  }
  const input = value as Record<string, unknown>;
  if (
    input.schemaVersion !== INFRASTRUCTURE_CAPTURE_INTENT_SCHEMA
    || typeof input.action !== 'string'
    || !CAPTURE_INTENT_ACTIONS.has(input.action)
    || Object.keys(input).some((field) => field !== 'schemaVersion' && field !== 'action')
  ) {
    throw new InfrastructureRuleError(
      'invalid_selector',
      `captureIntent must use ${INFRASTRUCTURE_CAPTURE_INTENT_SCHEMA} with full, aggregate, sample, or drop`,
    );
  }
  return {
    schemaVersion: INFRASTRUCTURE_CAPTURE_INTENT_SCHEMA,
    action: input.action as InfrastructureCaptureIntentV1['action'],
  };
}

function normalizeWorkloadRole(value: unknown): InfrastructureWorkloadRole | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !INFRASTRUCTURE_WORKLOAD_ROLES.has(value as InfrastructureWorkloadRole)) {
    throw new InfrastructureRuleError('invalid_selector', 'workloadRole must be a supported stable service or infrastructure role');
  }
  return value as InfrastructureWorkloadRole;
}

function validCaptureIntent(value: unknown): value is InfrastructureCaptureIntentV1 | undefined {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return input.schemaVersion === INFRASTRUCTURE_CAPTURE_INTENT_SCHEMA
    && typeof input.action === 'string'
    && CAPTURE_INTENT_ACTIONS.has(input.action)
    && Object.keys(input).every((field) => field === 'schemaVersion' || field === 'action');
}

function sameCaptureIntent(
  left: InfrastructureCaptureIntentV1 | undefined,
  right: InfrastructureCaptureIntentV1 | undefined,
): boolean {
  return left?.schemaVersion === right?.schemaVersion && left?.action === right?.action;
}

function captureIntentFilterAction(intent: InfrastructureCaptureIntentV1): InfrastructureFilterAction {
  if (intent.action === 'full') return 'keep';
  if (intent.action === 'drop') return 'drop';
  // The legacy Forwarder action vocabulary has no aggregate member. SAMPLE is the conservative
  // compatibility projection; the versioned Ring-before matrix below remains AGGREGATE.
  return 'sample';
}

function captureIntentProbeActions(intent: InfrastructureCaptureIntentV1): CaptureProbeActions {
  const actions = Object.fromEntries(CAPTURE_PROBE_NAMES.map((probe) => [probe, intent.action])) as CaptureProbeActions;
  actions.exec = 'full';
  actions.exit = 'full';
  actions.security = 'full';
  // Infrastructure deletes stay on the bounded Critical path unless the operator explicitly
  // requests FULL capture. This preserves path evidence without allowing a delete flood.
  if (intent.action !== 'full') actions.file_delete = 'sample';
  actions.file_read = 'not_enabled';
  return actions;
}

function ruleEventAction(
  rule: InfrastructureRuleRecord,
  eventKind: string,
  agentKeepConflict = false,
): InfrastructureFilterAction {
  if (agentKeepConflict) return 'keep';
  const desired = rule.captureIntent
    ? captureIntentFilterAction(rule.captureIntent)
    : rule.eventPolicies?.[eventKind as keyof NonNullable<InfrastructureRuleRecord['eventPolicies']>]
      ?? rule.eventPolicies?.default
      ?? DEFAULT_EVENT_POLICIES[eventKind]
      ?? DEFAULT_EVENT_POLICIES.default;
  if (desired === 'drop' && (rule.authority !== 'authoritative' || rule.lifecycleStage !== 'enforced')) {
    return 'sample';
  }
  return desired;
}

function expectedCaptureProbeActions(
  rule: InfrastructureRuleRecord,
  agentKeepConflict = false,
): CaptureProbeActions {
  if (agentKeepConflict) {
    return Object.fromEntries(CAPTURE_PROBE_NAMES.map((probe) => [probe, 'full'])) as CaptureProbeActions;
  }
  if (rule.captureIntent) return captureIntentProbeActions(rule.captureIntent);
  const actions = Object.fromEntries(CAPTURE_PROBE_NAMES.map((probe) => {
    if (probe === 'exec' || probe === 'exit' || probe === 'security') return [probe, 'full'];
    const policyAction = ruleEventAction(rule, PROBE_EVENT_POLICY[probe] ?? 'default');
    return [probe, policyAction === 'keep' ? 'full' : policyAction];
  })) as CaptureProbeActions;
  // File deletion keeps bounded path evidence and exact summary counts in every contextual profile.
  actions.file_delete = 'sample';
  // File reads are an opt-in Agent signal, never an Infrastructure capture intent.
  actions.file_read = 'not_enabled';
  return actions;
}

function previewCaptureProbeActions(desired: CaptureProbeActions): CaptureProbeActions {
  return Object.fromEntries(CAPTURE_PROBE_NAMES.map((probe) => {
    if (desired[probe] !== 'drop') return [probe, desired[probe]];
    return [probe, probe === 'file_delete' || probe === 'llm' ? 'sample' : 'aggregate'];
  })) as CaptureProbeActions;
}

function validCaptureProbeActions(value: unknown): value is CaptureProbeActions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  const keys = new Set(entries.map(([key]) => key));
  const legacyCompatible = entries.length === CAPTURE_PROBE_NAMES.length - 1 && !keys.has('file_read');
  return (entries.length === CAPTURE_PROBE_NAMES.length || legacyCompatible)
    && CAPTURE_PROBE_NAMES.every((probe) => {
      const action = (value as Record<string, unknown>)[probe];
      if (probe === 'file_read' && action === undefined) return true;
      return typeof action === 'string' && CAPTURE_PROBE_ACTIONS.has(action);
    });
}

function sameCaptureProbeActions(left: CaptureProbeActions, right: CaptureProbeActions): boolean {
  return CAPTURE_PROBE_NAMES.every((probe) =>
    (probe === 'file_read' ? left[probe] ?? 'not_enabled' : left[probe])
      === (probe === 'file_read' ? right[probe] ?? 'not_enabled' : right[probe]));
}

function legacyActionForCapture(actions: CaptureProbeActions): InfrastructureFilterAction {
  return actions.file_access === 'full' ? 'keep' : 'sample';
}

function captureProfileEnvelopePresent(request: InfrastructureMaterializationReportRequest): boolean {
  return [
    request.snapshotContentHash,
    request.intentHash,
    request.activationMode,
    request.publisherInstanceId,
    request.expectedEntries,
    request.ack,
  ].some((value) => value !== undefined);
}

function materializationOperationIdentity(
  value: InfrastructureMaterializationReportRequest | InfrastructureMaterializationReportRecord,
): string {
  return digest({
    schemaVersion: value.schemaVersion,
    reportId: value.reportId,
    nodeId: value.nodeId,
    policyVersion: value.policyVersion,
    epoch: value.epoch,
    snapshotContentHash: value.snapshotContentHash,
    intentHash: value.intentHash,
    activationMode: value.activationMode,
    publisherInstanceId: value.publisherInstanceId,
    expectedEntries: value.expectedEntries,
    ack: value.ack,
    bindings: value.bindings,
    errors: value.errors ?? [],
  });
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => [key, stableValue(item)]),
  );
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function id(prefix: string, parts: unknown[]): string {
  return `${prefix}_${digest(parts).slice(0, 20)}`;
}

function labels(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>).slice(0, 20)) {
    const key = text(rawKey, 128);
    const item = text(rawValue, 256);
    if (key && item) result[key] = item;
  }
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right)));
}

function selectorField(value: unknown, limit = 240): string | undefined {
  return text(value, limit);
}

function selectorFromInventoryWorkload(workload: InfrastructureInventoryWorkload): InfrastructureRuleSelector {
  if (!['kubernetes', 'docker', 'host'].includes(workload?.placement)) {
    throw new InfrastructureRuleError('invalid_selector', 'an exact workload placement is required');
  }
  const physicalWorkloadId = text(workload?.physicalWorkloadId, 500);
  if (!physicalWorkloadId) {
    throw new InfrastructureRuleError('invalid_selector', 'an exact physicalWorkloadId is required');
  }
  if (workload.classification !== 'non_agent') {
    throw new InfrastructureRuleError(
      'invalid_selector',
      'Unknown recommendation bridge requires an inventory-confirmed non-Agent workload',
    );
  }
  const selector = normalizeInfrastructureSelector({
    placement: workload.placement,
    nodeId: workload.nodeId,
    clusterId: workload.clusterId,
    namespace: workload.namespace,
    ownerKind: workload.ownerKind,
    ownerName: workload.ownerName,
    serviceAccount: workload.serviceAccount,
    composeProject: workload.composeProject,
    serviceName: workload.serviceName,
    containerName: workload.containerName,
    imageDigest: workload.imageDigest,
    systemdUnit: workload.systemdUnit,
    configuredRoot: workload.configuredRoot,
    labels: workload.labels ?? {},
  });
  const errors = [
    ...infrastructureSelectorErrors(selector),
    ...infrastructureAuthoritativeSelectorErrors(selector),
  ];
  if (errors.length) throw new InfrastructureRuleError('invalid_selector', errors.join('; '));
  return selector;
}

function selectorFromGovernanceAsset(asset: InfrastructureGovernanceAsset): InfrastructureRuleSelector {
  const workload = asset.workload;
  if (!['kubernetes', 'docker', 'host'].includes(workload?.placement)) {
    throw new InfrastructureRuleError('invalid_selector', 'the server-owned asset has no exact placement');
  }
  if (!text(workload.physicalWorkloadId, 500)) {
    throw new InfrastructureRuleError('invalid_selector', 'the server-owned asset has no physical workload binding');
  }
  const selector = normalizeInfrastructureSelector({
    placement: workload.placement,
    nodeId: workload.nodeId,
    clusterId: workload.clusterId,
    namespace: workload.namespace,
    ownerKind: workload.ownerKind,
    ownerName: workload.ownerName,
    serviceAccount: workload.serviceAccount,
    composeProject: workload.composeProject,
    serviceName: workload.serviceName,
    containerName: workload.containerName,
    imageDigest: workload.imageDigest,
    systemdUnit: workload.systemdUnit,
    configuredRoot: workload.configuredRoot,
    labels: workload.labels ?? {},
  });
  const errors = [
    ...infrastructureSelectorErrors(selector),
    ...infrastructureAuthoritativeSelectorErrors(selector),
  ];
  if (errors.length) throw new InfrastructureRuleError('invalid_selector', errors.join('; '));
  return selector;
}

function recommendationEventPolicy(
  eventKind: string,
  desiredAction: UnknownInfrastructureRecommendationEvidence['desiredAction'],
): InfrastructureRuleRecord['eventPolicies'] {
  const mapped: Partial<Record<string, InfrastructureEventPolicyKind>> = {
    FileAccess: 'FileAccess',
    FileDelete: 'FileDelete',
    Egress: 'Egress',
    Dns: 'Dns',
    Tls: 'Egress',
    LlmCall: 'LlmCall',
    SslContent: 'SslContent',
  };
  const policy: InfrastructureRuleRecord['eventPolicies'] = { default: 'sample' };
  const key = mapped[eventKind];
  // Infrastructure v1 has keep/sample/drop actions. AGGREGATE remains a recommendation in bridge
  // provenance and conservatively becomes SAMPLE unless an operator explicitly requests a latent
  // DROP policy. The draft itself is non-destructive in either case.
  if (key) policy[key] = desiredAction === 'keep' ? 'keep' : 'sample';
  return policy;
}

const SELECTOR_PATTERN_SYNTAX = /[*?\[\]{}()|^$\\]/u;

function selectorPatternError(field: string, value: string | undefined): string | undefined {
  return value && SELECTOR_PATTERN_SYNTAX.test(value)
    ? `${field} must be an exact value; wildcard, glob, and regex syntax is not allowed`
    : undefined;
}

export function normalizeInfrastructureSelector(input: Partial<InfrastructureRuleSelector> | undefined): InfrastructureRuleSelector {
  const placement = input?.placement === 'kubernetes' || input?.placement === 'docker' || input?.placement === 'host'
    ? input.placement
    : 'kubernetes';
  return {
    placement,
    nodeId: selectorField(input?.nodeId),
    clusterId: selectorField(input?.clusterId),
    namespace: selectorField(input?.namespace),
    ownerKind: selectorField(input?.ownerKind, 120),
    ownerName: selectorField(input?.ownerName),
    serviceAccount: selectorField(input?.serviceAccount),
    composeProject: selectorField(input?.composeProject),
    serviceName: selectorField(input?.serviceName),
    containerName: selectorField(input?.containerName),
    imageDigest: selectorField(input?.imageDigest, 500),
    systemdUnit: selectorField(input?.systemdUnit),
    configuredRoot: selectorField(input?.configuredRoot, 500),
    labels: labels(input?.labels),
  };
}

export function infrastructureSelectorErrors(selector: InfrastructureRuleSelector): string[] {
  const errors: string[] = [];
  const commonScope = Boolean(selector.nodeId || selector.imageDigest || Object.keys(selector.labels).length);
  if (selector.placement === 'kubernetes') {
    if (!commonScope && !selector.clusterId && !selector.namespace && !selector.ownerName && !selector.containerName) {
      errors.push('kubernetes selector must constrain cluster, namespace, owner, container, image, node, or labels');
    }
  } else if (selector.placement === 'docker') {
    if (!commonScope && !selector.composeProject && !selector.serviceName && !selector.containerName) {
      errors.push('docker selector must constrain node, project, service, container, image, or labels');
    }
  } else if (!selector.nodeId || !selector.systemdUnit) {
    errors.push('host selector requires nodeId and an exact systemdUnit');
  }
  for (const [field, value] of Object.entries(selector).filter(([key]) => key !== 'labels')) {
    const error = selectorPatternError(field, typeof value === 'string' ? value : undefined);
    if (error) errors.push(error);
  }
  for (const [key, value] of Object.entries(selector.labels)) {
    const keyError = selectorPatternError(`label key ${key}`, key);
    const valueError = selectorPatternError(`label ${key}`, value);
    if (keyError) errors.push(keyError);
    if (valueError) errors.push(valueError);
  }
  return errors;
}

export function infrastructureAuthoritativeSelectorErrors(selector: InfrastructureRuleSelector): string[] {
  if (selector.placement === 'docker') {
    return (selector.composeProject && selector.serviceName)
      || (selector.containerName && selector.imageDigest)
      ? []
      : ['authoritative Docker selector requires exact composeProject+serviceName or containerName+imageDigest'];
  }
  if (selector.placement === 'kubernetes') {
    const required: Array<keyof InfrastructureRuleSelector> = [
      'clusterId',
      'namespace',
      'ownerKind',
      'ownerName',
      'containerName',
    ];
    const missing = required.filter((field) => !selector[field]);
    return missing.length
      ? [`authoritative Kubernetes selector requires exact ${missing.join(', ')}`]
      : [];
  }
  return selector.nodeId && selector.systemdUnit
    ? []
    : ['authoritative Host selector requires exact nodeId and systemdUnit'];
}

function fieldMatches(expected: string | undefined, actual: string | undefined): boolean {
  return expected === undefined || expected === actual;
}

export function infrastructureSelectorMatches(
  selector: InfrastructureRuleSelector,
  workload: InfrastructureInventoryWorkload,
): boolean {
  if (selector.placement !== workload.placement) return false;
  if (!fieldMatches(selector.nodeId, workload.nodeId)) return false;
  if (!fieldMatches(selector.clusterId, workload.clusterId)) return false;
  if (!fieldMatches(selector.namespace, workload.namespace)) return false;
  if (!fieldMatches(selector.ownerKind, workload.ownerKind)) return false;
  if (!fieldMatches(selector.ownerName, workload.ownerName)) return false;
  if (!fieldMatches(selector.serviceAccount, workload.serviceAccount)) return false;
  if (!fieldMatches(selector.composeProject, workload.composeProject)) return false;
  if (!fieldMatches(selector.serviceName, workload.serviceName)) return false;
  if (!fieldMatches(selector.containerName, workload.containerName)) return false;
  if (!fieldMatches(selector.imageDigest, workload.imageDigest)) return false;
  if (!fieldMatches(selector.systemdUnit, workload.systemdUnit)) return false;
  if (!fieldMatches(selector.configuredRoot, workload.configuredRoot)) return false;
  const workloadLabels = workload.labels ?? {};
  return Object.entries(selector.labels).every(([key, value]) => workloadLabels[key] === value);
}

export function effectiveInfrastructureAction(
  rule: Pick<InfrastructureRuleRecord, 'authority' | 'lifecycleStage' | 'captureIntent'>,
  agentKeepConflict = false,
): InfrastructureFilterAction {
  if (agentKeepConflict) return 'keep';
  if (rule.captureIntent) {
    const desired = captureIntentFilterAction(rule.captureIntent);
    if (desired !== 'drop') return desired;
  }
  return rule.authority === 'authoritative' && rule.lifecycleStage === 'enforced' ? 'drop' : 'sample';
}

function ruleHash(rule: Omit<InfrastructureRuleRecord, 'contentHash'>): string {
  return digest(rule);
}

function withHash(
  rule: Omit<InfrastructureRuleRecord, 'contentHash'> | InfrastructureRuleRecord,
): InfrastructureRuleRecord {
  const { contentHash: _contentHash, ...content } = rule as InfrastructureRuleRecord;
  return { ...content, contentHash: ruleHash(content) };
}

function validRuleHash(rule: InfrastructureRuleRecord): boolean {
  const { contentHash, ...content } = rule;
  return contentHash === ruleHash(content);
}

export class InfrastructureRuleError extends Error {
  constructor(
    readonly code: 'not_found' | 'invalid_selector' | 'invalid_transition' | 'authority_required' | 'revision_conflict' | 'invalid_report' | 'capacity_exceeded' | 'asset_provider_unavailable',
    message: string,
  ) {
    super(message);
  }
}

@Injectable()
export class InfrastructureRuleService implements OnModuleInit, OnModuleDestroy {
  private readonly ch = new ClickHouseStore();
  private readonly rules = new Map<string, InfrastructureRuleRecord>();
  private revisions: InfrastructureRuleRecord[] = [];
  private reports: InfrastructureMaterializationReportRecord[] = [];
  private operations: InfrastructureRuleOperationRecord[] = [];
  private readonly pendingDurabilityRuleIds = new Set<string>();
  private stateVersion = 0;
  private policyVersion = 0;
  private updatedAt = 0;
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly validations = new Map<string, {
    revision: number;
    at: number;
    valid: boolean;
    inventoryCount: number;
    matchedWorkloads: number;
    agentConflicts: number;
    serverOwned?: boolean;
    snapshotVersion?: number;
  }>();

  constructor(
    private readonly relational: RelationalBusinessStore,
    private readonly audit: AuditService,
    @Optional()
    @Inject(INFRASTRUCTURE_ASSET_SNAPSHOT_PROVIDER)
    private readonly assetProvider?: InfrastructureAssetSnapshotProvider,
  ) {}

  async onModuleInit(): Promise<void> {
    const [clickhouseSaved, relationalSaved] = await Promise.all([
      this.ch.init().then((ready) => ready
        ? this.ch.loadPlatformConfig<InfrastructureRuleStateDocument>(CONFIG_KEY)
        : undefined),
      this.relational.loadPlatformConfig<InfrastructureRuleStateDocument>(CONFIG_KEY),
    ]);
    const saved = [clickhouseSaved, relationalSaved]
      .filter((entry): entry is { record: InfrastructureRuleStateDocument; updatedAt: number } => Boolean(entry))
      .sort((left, right) => right.updatedAt - left.updatedAt)[0];
    if (saved?.record.schemaVersion === INFRASTRUCTURE_RULE_STATE_SCHEMA) this.restore(saved.record);
    if (saved) await this.persist();
  }

  async onModuleDestroy(): Promise<void> {
    await this.mutationTail.catch(() => undefined);
    await this.persist(true);
    await this.ch.close();
  }

  status() {
    return {
      schemaVersion: INFRASTRUCTURE_RULE_STATE_SCHEMA,
      rules: this.rules.size,
      revisions: this.revisions.length,
      reports: this.reports.length,
      operations: this.operations.length,
      stateVersion: this.stateVersion,
      policyVersion: this.policyVersion,
      postgresqlBacked: this.relational.isReady(),
      clickhouseMigrationCopy: this.ch.enabled,
      assetProviderConfigured: Boolean(this.assetProvider),
    };
  }

  list(query: { q?: string; stage?: InfrastructureRuleStage | 'all'; authority?: InfrastructureRuleAuthority | 'all'; source?: InfrastructureRuleSourceType | 'all'; limit?: number } = {}): InfrastructureRuleListResult {
    const q = text(query.q, 240)?.toLowerCase();
    const items = [...this.rules.values()]
      .filter((rule) =>
        (!query.stage || query.stage === 'all' || rule.lifecycleStage === query.stage) &&
        (!query.authority || query.authority === 'all' || rule.authority === query.authority) &&
        (!query.source || query.source === 'all' || rule.source.type === query.source) &&
        (!q || [rule.ruleId, rule.name, rule.reasonCode, rule.source.type, rule.source.sourceRef, JSON.stringify(rule.selector)]
          .some((value) => (value ?? '').toLowerCase().includes(q))),
      )
      .sort((left, right) => right.updatedAt - left.updatedAt || left.ruleId.localeCompare(right.ruleId));
    const limit = integer(query.limit, 200, 1, 500);
    return {
      items: items.slice(0, limit),
      total: items.length,
      stateVersion: this.stateVersion,
      policyVersion: this.policyVersion,
      updateTime: new Date(this.updatedAt || Date.now()).toISOString(),
    };
  }

  get(ruleId: string): InfrastructureRuleRecord {
    const rule = this.rules.get(ruleId);
    if (!rule) throw new InfrastructureRuleError('not_found', 'infrastructure rule not found');
    return rule;
  }

  /**
   * Internal adapter seam for the unified Filter Rule Catalog.
   *
   * This returns current logical revisions only. It is not an HTTP read model and deliberately
   * avoids the public list endpoint's page bound; the unified catalog applies its own cursor after
   * merging every typed rule source.
   */
  catalogRecords(): InfrastructureRuleRecord[] {
    return [...this.rules.values()]
      .sort((left, right) => right.updatedAt - left.updatedAt || left.ruleId.localeCompare(right.ruleId))
      .map((rule) => structuredClone(rule));
  }

  listHuman(query: { q?: string; stage?: InfrastructureRuleStage | 'all'; authority?: InfrastructureRuleAuthority | 'all'; source?: InfrastructureRuleSourceType | 'all'; limit?: number } = {}): InfrastructureRuleHumanListResult {
    const result = this.list(query);
    return {
      ...result,
      items: result.items.map((rule) => infrastructureRuleHumanSummary(rule, this.humanContext(rule))),
    };
  }

  getHuman(ruleId: string): InfrastructureRuleHumanDetail {
    const rule = this.get(ruleId);
    return infrastructureRuleHumanDetail(rule, this.humanContext(rule));
  }

  listOperations(query: { ruleId?: string; limit?: number } = {}): InfrastructureRuleOperationListResult {
    const ruleId = text(query.ruleId, 240);
    const items = this.operations
      .filter((operation) => !ruleId || operation.ruleId === ruleId)
      .sort((left, right) => right.requestedAt - left.requestedAt || left.operationId.localeCompare(right.operationId));
    const limit = integer(query.limit, 100, 1, 500);
    return {
      items: items.slice(0, limit).map((operation) => ({ ...operation })),
      total: items.length,
      updateTime: new Date(this.updatedAt || Date.now()).toISOString(),
    };
  }

  getOperation(operationId: string): InfrastructureRuleOperationRecord {
    const normalized = text(operationId, 240);
    const operation = this.operations.find((item) => item.operationId === normalized);
    if (!operation) throw new InfrastructureRuleError('not_found', 'infrastructure rule operation not found');
    return { ...operation };
  }

  async createDraftFromAsset(
    request: InfrastructureAssetDraftRequest,
    actor: InfrastructureRuleActor,
  ): Promise<InfrastructureAssetDraftResult> {
    const snapshot = await this.trustedAssetSnapshot();
    const assetId = text(request.assetId, 240);
    const asset = snapshot.assets.find((item) => item.assetId === assetId);
    if (!asset) throw new InfrastructureRuleError('not_found', 'server-owned asset not found');
    if (
      request.expectedAssetRevision !== undefined &&
      integer(request.expectedAssetRevision, -1, -1, Number.MAX_SAFE_INTEGER) !== asset.revision
    ) {
      throw new InfrastructureRuleError('revision_conflict', 'asset revision does not match the server snapshot');
    }
    if (asset.bindingQuality !== 'exact' && asset.bindingQuality !== 'logical') {
      throw new InfrastructureRuleError('invalid_selector', 'asset binding is not stable enough for a reusable rule');
    }
    if (asset.conflict || asset.classification === 'confirmed_agent' || asset.classification === 'probable_agent') {
      throw new InfrastructureRuleError('authority_required', 'Agent or identity conflict requires KEEP/investigation, not an Infrastructure rule');
    }
    const intent = request.intent;
    if (!intent || !CAPTURE_INTENT_ACTIONS.has(intent)) {
      throw new InfrastructureRuleError('invalid_transition', 'a supported human capture intent is required');
    }
    if (intent === 'drop' && asset.classification !== 'non_agent') {
      throw new InfrastructureRuleError('authority_required', 'DROP draft requires a server-owned current non-Agent asset fact');
    }
    if (intent === 'drop' && snapshot.destructiveReady !== true) {
      throw new InfrastructureRuleError('asset_provider_unavailable', 'DROP draft requires a complete cross-runtime Agent inventory snapshot');
    }
    if (intent === 'drop' && asset.sharedScope) {
      throw new InfrastructureRuleError('authority_required', 'DROP draft cannot target a shared runtime scope');
    }
    if (
      (intent === 'aggregate' || intent === 'drop') &&
      asset.workloadRole === 'unknown'
    ) {
      throw new InfrastructureRuleError('authority_required', 'aggregate/drop requires a known service or infrastructure role');
    }
    const reason = text(request.reason, 500);
    if (!reason) throw new InfrastructureRuleError('invalid_transition', 'a bounded rule reason is required');
    const selector = selectorFromGovernanceAsset(asset);
    const sourceRef = `asset:${asset.assetId}:r${asset.revision}:intent:${intent}`;
    const existing = [...this.rules.values()].find((rule) =>
      rule.source.sourceRef === sourceRef &&
      rule.lifecycleStage !== 'revoked' &&
      rule.captureIntent?.action === intent);
    const operation = this.startOperation('asset_draft', actor, 'draft', reason, existing?.ruleId);
    try {
      const rule = existing ?? await this.create({
        name: text(request.name, 240) ?? `${asset.displayName} 采集规则`,
        selector,
        source: { type: 'operator', sourceRef, issuer: actor.id },
        reasonCode: 'asset_review_capture_governance',
        workloadRole: asset.workloadRole === 'unknown'
          ? undefined
          : asset.workloadRole,
        priority: request.priority,
        captureIntent: { schemaVersion: INFRASTRUCTURE_CAPTURE_INTENT_SCHEMA, action: intent },
        changeTicket: request.changeTicket,
      }, actor);
      const completed = await this.completeOperation(operation.operationId, {
        status: 'succeeded',
        ruleId: rule.ruleId,
        resultingRevision: rule.revision,
      });
      return {
        created: !existing,
        rule: this.getHuman(rule.ruleId),
        operation: completed,
        asset: { assetId: asset.assetId, revision: asset.revision, displayName: asset.displayName },
      };
    } catch (error) {
      await this.completeOperation(operation.operationId, {
        status: 'failed',
        errorCode: error instanceof InfrastructureRuleError ? error.code : 'internal_error',
        error: error instanceof Error ? error.message.slice(0, 500) : 'unknown error',
      });
      throw error;
    }
  }

  async impactPreview(
    ruleId: string,
    actor?: InfrastructureRuleActor,
  ): Promise<InfrastructureRuleImpactPreview> {
    const rule = this.get(ruleId);
    const snapshot = await this.trustedAssetSnapshot();
    const matches = snapshot.assets.filter((asset) => infrastructureSelectorMatches(rule.selector, asset.workload));
    const agentConflicts = matches.filter((asset) =>
      asset.conflict || asset.classification === 'confirmed_agent' || asset.classification === 'probable_agent');
    const sharedScopeConflicts = matches.filter((asset) => asset.sharedScope === true);
    const intent = humanIntentAction(rule);
    const matchedInstances = matches.reduce((total, asset) => total + asset.instanceCount, 0);
    const lifecycleContinuous = matches.length > 0 && matches.every((asset) =>
      asset.continuity?.currentPresenceVerified === true
      && asset.continuity.observationCoverageAvailable === true);
    const serviceContextContinuous = matches.length > 0 && matches.every((asset) =>
      asset.continuity?.currentPresenceVerified === true
      && asset.continuity.serviceContextAvailable === true);
    const partialReasons = [...new Set<InfrastructureRuleImpactPartialReason>([
      ...(snapshot.partialReasons ?? []).filter(impactPartialReason),
      ...matches.flatMap((asset) => asset.continuity?.partialReasons ?? []).filter(impactPartialReason),
      ...(matches.some((asset) => !asset.continuity) ? ['continuity_evidence_unavailable' as const] : []),
      ...(!lifecycleContinuous && !matches.some((asset) =>
        asset.continuity?.partialReasons?.includes('observation_coverage_unavailable'))
        ? ['continuity_evidence_unavailable' as const]
        : []),
      ...(!serviceContextContinuous && !matches.some((asset) =>
        asset.continuity?.partialReasons?.some((reason) => reason.startsWith('service_context_')))
        ? ['continuity_evidence_unavailable' as const]
        : []),
    ])].slice(0, MAX_IMPACT_PARTIAL_REASONS);
    const unconfirmedDropScopes = intent === 'drop'
      ? matches.filter((asset) => asset.classification !== 'non_agent')
      : [];
    const errors = [
      ...infrastructureSelectorErrors(rule.selector),
      ...(rule.lifecycleStage === 'shadow' || rule.lifecycleStage === 'enforced'
        ? infrastructureAuthoritativeSelectorErrors(rule.selector)
        : []),
    ];
    if (!matches.length) errors.push('server-owned asset snapshot has no matching workload');
    if (matches.length > MAX_ENFORCED_MATCHES || matchedInstances > MAX_ENFORCED_MATCHES) {
      errors.push('selector blast radius exceeds enforced v1 limit');
    }
    if (agentConflicts.length) errors.push('selector matches a current Agent or identity conflict; KEEP must win');
    if (unconfirmedDropScopes.length) errors.push('DROP selector requires every matched asset to be currently confirmed non-Agent');
    if (intent === 'drop' && snapshot.destructiveReady !== true) {
      errors.push('DROP requires a complete cross-runtime Agent inventory snapshot');
    }
    if (intent === 'drop' && !lifecycleContinuous) {
      errors.push('DROP requires verified current presence and active Observation Coverage for every matched asset');
    }
    if (intent === 'drop' && !serviceContextContinuous) {
      errors.push('DROP requires independently available Service Context for every matched asset');
    }
    if (intent === 'drop' && sharedScopeConflicts.length) errors.push('DROP selector matches a shared runtime scope');
    const warnings: string[] = [];
    if (sharedScopeConflicts.length && intent !== 'drop') warnings.push('shared runtime scopes will remain conservative');
    if (!lifecycleContinuous && intent !== 'drop') warnings.push('asset lifecycle continuity is partial or unavailable');
    if (!serviceContextContinuous && intent !== 'drop') warnings.push('Service Context continuity is partial or unavailable');
    const signalCounts: Partial<Record<InfrastructureEventPolicyKind, number>> = {};
    for (const asset of matches) {
      for (const [kind, count] of Object.entries(asset.signalCounts ?? {})) {
        if (!Number.isFinite(count) || Number(count) <= 0) continue;
        const key = kind as InfrastructureEventPolicyKind;
        signalCounts[key] = (signalCounts[key] ?? 0) + Math.round(Number(count));
      }
    }
    const valid = errors.length === 0;
    const canPromoteToEnforced =
      rule.lifecycleStage === 'shadow' &&
      AUTHORITATIVE_SOURCES.has(rule.source.type) &&
      valid;
    this.validations.set(rule.ruleId, {
      revision: rule.revision,
      at: Date.now(),
      valid,
      inventoryCount: snapshot.assets.length,
      matchedWorkloads: matches.length,
      agentConflicts: agentConflicts.length,
      serverOwned: true,
      snapshotVersion: snapshot.version,
    });
    const result: InfrastructureRuleImpactPreview = {
      ruleId: rule.ruleId,
      revision: rule.revision,
      snapshotVersion: snapshot.version,
      generatedAt: new Date(snapshot.generatedAt).toISOString(),
      provider: snapshot.provider,
      valid,
      errors,
      warnings,
      matchedAssets: matches.length,
      matchedInstances,
      matchedNodes: new Set(matches.flatMap((asset) => asset.nodeIds)).size,
      agentConflicts: agentConflicts.length,
      sharedScopeConflicts: sharedScopeConflicts.length,
      recentLogicalEvents: matches.every((asset) => asset.recentLogicalEvents !== undefined)
        ? matches.reduce((total, asset) => total + (asset.recentLogicalEvents ?? 0), 0)
        : undefined,
      signalCounts: Object.keys(signalCounts).length ? signalCounts : undefined,
      expectedSignals: humanProbePolicies(expectedCaptureProbeActions(rule)),
      lifecycleContinuous,
      serviceContextContinuous,
      partialReasons,
      canEnterShadow: rule.lifecycleStage === 'draft' && valid,
      canPromoteToEnforced,
    };
    if (actor) {
      this.audit.record({
        actor,
        action: 'infrastructure_rule.validated',
        resourceType: 'infrastructure-rule',
        resourceId: rule.ruleId,
        summary: `Server-owned impact preview: ${rule.name}`,
        result: valid ? 'success' : 'failure',
        details: {
          revision: rule.revision,
          snapshotVersion: snapshot.version,
          provider: snapshot.provider,
          matchedAssets: matches.length,
          matchedInstances: result.matchedInstances,
          agentConflicts: result.agentConflicts,
          sharedScopeConflicts: result.sharedScopeConflicts,
          lifecycleContinuous,
          serviceContextContinuous,
          partialReasons,
          errors,
        },
      });
    }
    return result;
  }

  create(input: InfrastructureRuleCreateRequest, actor: InfrastructureRuleActor): Promise<InfrastructureRuleRecord> {
    return this.mutate(() => this.createInside(input, actor));
  }

  createUnknownRecommendationDraft(
    input: {
      recommendation: UnknownInfrastructureRecommendationEvidence;
      request: UnknownInfrastructureDraftRequest & { workload: InfrastructureInventoryWorkload };
    },
    actor: InfrastructureRuleActor,
  ): Promise<UnknownInfrastructureDraftResult> {
    return this.mutate(async () => {
      const recommendation = input.recommendation;
      if (
        !/^upol_[a-f0-9]{24}$/u.test(recommendation.policyId)
        || !/^ufam_[a-f0-9]{24}$/u.test(recommendation.familyId)
        || !/^ucl_[a-f0-9]{24}$/u.test(recommendation.clusterId)
        || !Number.isSafeInteger(recommendation.policyRevision) || recommendation.policyRevision <= 0
        || !Number.isSafeInteger(recommendation.reviewRevision) || recommendation.reviewRevision <= 0
        || !['keep', 'sample', 'aggregate'].includes(recommendation.desiredAction)
        || !/^workload:[a-f0-9]{32}$/u.test(recommendation.stableScope)
      ) {
        throw new InfrastructureRuleError('invalid_transition', 'invalid Unknown recommendation bridge evidence');
      }
      const bridgeReason = text(input.request.reason, 500);
      if (!bridgeReason) {
        throw new InfrastructureRuleError('invalid_transition', 'a bounded bridge reason is required');
      }
      const workload = input.request.workload;
      const physicalWorkloadId = text(workload.physicalWorkloadId, 500);
      if (!physicalWorkloadId) {
        throw new InfrastructureRuleError('invalid_selector', 'an exact physicalWorkloadId is required');
      }
      const physicalWorkloadIdHash = sha256Text(physicalWorkloadId).slice(0, 32);
      if (recommendation.stableScope !== `workload:${physicalWorkloadIdHash}`) {
        throw new InfrastructureRuleError(
          'invalid_selector',
          'inventory physicalWorkloadId does not match Unknown recommendation scope',
        );
      }
      const selector = selectorFromInventoryWorkload(workload);
      const eventPolicies = normalizeEventPolicies({
        ...recommendationEventPolicy(recommendation.eventKind, recommendation.desiredAction),
        ...(input.request.eventPolicies ?? {}),
      });
      const scopeBindingHash = digest({ physicalWorkloadId, selector }).slice(0, 32);
      const bridgeBase = `unknown-learning:${recommendation.policyId}:r${recommendation.policyRevision}:scope:${scopeBindingHash}`;
      const intentHash = digest({
        familyId: recommendation.familyId,
        reviewRevision: recommendation.reviewRevision,
        desiredAction: recommendation.desiredAction,
        selector,
        eventPolicies,
        priority: integer(input.request.priority, 100, 0, 1_000),
      }).slice(0, 24);
      const sourceRef = `${bridgeBase}:intent:${intentHash}`;
      const related = [...this.rules.values()].filter((rule) =>
        rule.source.sourceRef?.startsWith(`${bridgeBase}:intent:`));
      const existing = related.find((rule) => rule.source.sourceRef === sourceRef);
      const bridge = {
        policyId: recommendation.policyId,
        policyRevision: recommendation.policyRevision,
        familyId: recommendation.familyId,
        reviewRevision: recommendation.reviewRevision,
        desiredAction: recommendation.desiredAction,
        physicalWorkloadIdHash,
        scopeBindingHash,
        operationDestructive: false as const,
      };
      if (existing) return { rule: existing, created: false, bridge };
      if (related.length) {
        throw new InfrastructureRuleError(
          'revision_conflict',
          'Unknown recommendation was already bridged with a different Infrastructure draft intent',
        );
      }
      const rule = await this.createInside({
        name: text(input.request.name, 240) ?? `Unknown recommendation ${recommendation.familyId.slice(-8)}`,
        selector,
        source: {
          type: 'manual_review',
          sourceRef,
          issuer: actor.id,
        },
        reasonCode: 'unknown_learning_recommendation',
        workloadRole: 'ordinary_process',
        priority: input.request.priority,
        eventPolicies,
        changeTicket: input.request.changeTicket,
      }, actor, {
        unknownPolicyId: recommendation.policyId,
        unknownPolicyRevision: recommendation.policyRevision,
        unknownFamilyId: recommendation.familyId,
        unknownReviewRevision: recommendation.reviewRevision,
        unknownDesiredAction: recommendation.desiredAction,
        scopeBindingHash,
        bridgeReason,
      });
      if (
        rule.lifecycleStage !== 'draft'
        || rule.authority !== 'candidate'
        || effectiveInfrastructureAction(rule) !== 'sample'
      ) {
        throw new InfrastructureRuleError('invalid_transition', 'Unknown bridge did not create a safe candidate draft');
      }
      return { rule, created: true, bridge };
    });
  }

  shadow(ruleId: string, input: InfrastructureRuleTransitionRequest, actor: InfrastructureRuleActor): Promise<InfrastructureRuleRecord> {
    return this.transitionWithOperation(ruleId, input, actor, 'shadow', 'shadow');
  }

  promote(ruleId: string, input: InfrastructureRuleTransitionRequest, actor: InfrastructureRuleActor): Promise<InfrastructureRuleRecord> {
    return this.transitionWithOperation(ruleId, input, actor, 'enforced', 'promote');
  }

  revoke(ruleId: string, input: InfrastructureRuleTransitionRequest, actor: InfrastructureRuleActor): Promise<InfrastructureRuleRecord> {
    return this.transitionWithOperation(ruleId, input, actor, 'revoked', 'revoke');
  }

  validate(
    ruleId: string,
    request: InfrastructureRuleValidationRequest = {},
    actor?: InfrastructureRuleActor,
  ): InfrastructureRuleValidationResult {
    const rule = this.get(ruleId);
    const errors = infrastructureSelectorErrors(rule.selector);
    if (rule.lifecycleStage === 'shadow' && AUTHORITATIVE_SOURCES.has(rule.source.type)) {
      errors.push(...infrastructureAuthoritativeSelectorErrors(rule.selector));
    }
    const inventory = Array.isArray(request.inventory)
      ? request.inventory.slice(0, MAX_VALIDATION_INVENTORY)
      : [];
    const matches = inventory.filter((workload) => infrastructureSelectorMatches(rule.selector, workload));
    const conflicts = matches.filter((workload) =>
      workload.classification === 'confirmed_agent' || workload.classification === 'probable_agent');
    const warnings: string[] = [];
    if (!inventory.length) warnings.push('no inventory supplied; selector blast radius was not previewed');
    if (matches.length > MAX_ENFORCED_MATCHES) errors.push('selector blast radius exceeds enforced v1 limit');
    if (conflicts.length) errors.push('selector matches a known Agent workload; keep must win');
    warnings.push('client-supplied inventory preview is diagnostic only; use server-owned impact preview before promotion');
    const canPromoteToEnforced = false;
    const result = {
      ruleId,
      revision: rule.revision,
      valid: errors.length === 0,
      errors,
      warnings,
      matchedWorkloads: matches.length,
      matchedPhysicalWorkloadIds: matches.map((workload) => workload.physicalWorkloadId).slice(0, 500),
      agentConflicts: conflicts.length,
      agentConflictPhysicalWorkloadIds: conflicts.map((workload) => workload.physicalWorkloadId).slice(0, 500),
      effectiveAction: effectiveInfrastructureAction(rule),
      canPromoteToEnforced,
    };
    if (actor) {
      this.validations.set(ruleId, {
        revision: rule.revision,
        at: Date.now(),
        valid: result.valid,
        inventoryCount: inventory.length,
        matchedWorkloads: result.matchedWorkloads,
        agentConflicts: result.agentConflicts,
        serverOwned: false,
      });
      this.audit.record({
        actor,
        action: 'infrastructure_rule.validated',
        resourceType: 'infrastructure-rule',
        resourceId: ruleId,
        summary: `Infrastructure rule validated: ${rule.name}`,
        result: result.valid ? 'success' : 'failure',
        details: {
          revision: rule.revision,
          matchedWorkloads: result.matchedWorkloads,
          agentConflicts: result.agentConflicts,
          effectiveAction: result.effectiveAction,
          canPromoteToEnforced: result.canPromoteToEnforced,
          errors: result.errors,
        },
      });
    }
    return result;
  }

  policySnapshot(now = Date.now()): InfrastructurePolicySnapshot {
    const rules = [...this.rules.values()]
      .filter((rule) =>
        (rule.lifecycleStage === 'shadow' || rule.lifecycleStage === 'enforced')
        && !this.pendingDurabilityRuleIds.has(rule.ruleId))
      .sort((left, right) => right.priority - left.priority || left.ruleId.localeCompare(right.ruleId));
    const contentHash = digest({ policyVersion: this.policyVersion, rules: rules.map((rule) => ({ ruleId: rule.ruleId, revision: rule.revision, contentHash: rule.contentHash })) });
    return {
      schemaVersion: INFRASTRUCTURE_POLICY_SCHEMA,
      policyVersion: this.policyVersion,
      generatedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + POLICY_TTL_MS).toISOString(),
      contentHash,
      rules,
    };
  }

  reportMaterialization(
    request: InfrastructureMaterializationReportRequest,
    actor: InfrastructureRuleActor,
  ): Promise<InfrastructureMaterializationReportRecord> {
    return this.mutate(async () => {
      const nodeId = text(request.nodeId, 240);
      const policyVersion = integer(request.policyVersion, -1, -1, Number.MAX_SAFE_INTEGER);
      const epoch = integer(request.epoch, -1, -1, Number.MAX_SAFE_INTEGER);
      const bindings = Array.isArray(request.bindings) ? request.bindings.slice(0, MAX_BINDINGS) : [];
      if (!nodeId || policyVersion < 0 || policyVersion > this.policyVersion || epoch < 0) {
        throw new InfrastructureRuleError('invalid_report', 'materialization report nodeId, policyVersion, or epoch is invalid');
      }
      if ((request.bindings?.length ?? 0) > MAX_BINDINGS) {
        throw new InfrastructureRuleError('capacity_exceeded', 'materialization binding capacity exceeded');
      }
      const reportErrors: string[] = [];
      const captureProfileReport = captureProfileEnvelopePresent(request);
      const snapshotContentHash = text(request.snapshotContentHash, 64);
      const intentHash = text(request.intentHash, 64);
      const publisherInstanceId = text(request.publisherInstanceId, 240);
      const expectedEntries = integer(request.expectedEntries, -1, -1, MAX_CAPTURE_PROFILE_ENTRIES);
      const ack = request.ack;
      if (captureProfileReport) {
        const hashPattern = /^[a-f0-9]{64}$/u;
        const capabilities = ack?.capabilities;
        const includesAll = (actual: unknown, required: string[]) =>
          Array.isArray(actual) && required.every((item) => actual.includes(item));
        const appliedAt = Date.parse(ack?.appliedAt ?? '');
        if (request.schemaVersion !== INFRASTRUCTURE_MATERIALIZATION_SCHEMA) {
          reportErrors.push('Capture Profile report schemaVersion is invalid');
        }
        if (
          request.activationMode !== 'preview'
          || !snapshotContentHash || !hashPattern.test(snapshotContentHash)
          || !intentHash || !hashPattern.test(intentHash)
          || !publisherInstanceId
          || expectedEntries < 0
        ) {
          reportErrors.push('Capture Profile report envelope is incomplete');
        }
        if (
          ack?.schemaVersion !== 'anysentry.capture_profile_ack.v1'
          || ack.status !== 'applied'
          || !Array.isArray(ack.errors) || ack.errors.length !== 0
          || !Array.isArray(ack.downgrades) || ack.downgrades.length !== 0
          || text(ack.nodeId, 240) !== nodeId
          || !text(ack.collectorId, 240)
          || !text(ack.collectorInstanceId, 240)
          || !text(ack.hostBootId, 240)
          || text(ack.publisherInstanceId, 240) !== publisherInstanceId
          || Number(ack.epoch) !== epoch
          || Number(ack.policyVersion) !== policyVersion
          || text(ack.contentHash, 64) !== snapshotContentHash
          || text(ack.intentHash, 64) !== intentHash
          || Number(ack.entriesApplied) !== expectedEntries
          || !Number.isFinite(appliedAt)
          || appliedAt > Date.now() + 30_000
          || Date.now() - appliedAt > MATERIALIZATION_TTL_MS
          || !capabilities || typeof capabilities !== 'object'
          || !hashPattern.test(text(ack.capabilitiesHash, 64) ?? '')
          || text(ack.capabilitiesHash, 64) !== digest(capabilities)
          || !hashPattern.test(text(ack.effectiveActionsHash, 64) ?? '')
        ) {
          reportErrors.push('Capture Profile ACK binding is invalid');
        }
        if (
          capabilities?.activationGrantV1 !== true
          || !includesAll(capabilities.schemaVersions, ['anysentry.filter_rule_snapshot.v1'])
          || !includesAll(
            capabilities.probeNames,
            capabilities.selectiveFileRead === true
              ? CAPTURE_PROBE_NAMES
              : CAPTURE_PROBE_NAMES.filter((probe) => probe !== 'file_read'),
          )
          || !includesAll(capabilities.probeActions, ['full', 'aggregate', 'sample', 'drop'])
          || (capabilities.selectiveFileRead === true
            && !includesAll(capabilities.probeActions, ['not_enabled']))
          || !includesAll(capabilities.captureProfileModes, ['shadow', 'enforce'])
        ) {
          reportErrors.push('Capture Profile ACK capabilities are incomplete');
        }
        if (!Array.isArray(request.errors) || request.errors.length !== 0 || bindings.length === 0) {
          reportErrors.push('Capture Profile report must contain bindings and no errors');
        }
      }
      const entriesByScope = new Map<string, InfrastructureFilterRuleEntry>();
      let conflicts = 0;
      const reportedAt = Date.now();
      for (const binding of bindings) {
        const rule = this.rules.get(binding.ruleId);
        if (!rule || rule.revision !== integer(binding.ruleRevision, -1, -1, Number.MAX_SAFE_INTEGER)) {
          reportErrors.push(`binding references unknown rule revision: ${binding.ruleId}`);
          continue;
        }
        if (rule.lifecycleStage !== 'shadow' && rule.lifecycleStage !== 'enforced') {
          reportErrors.push(`binding references unpublished rule: ${binding.ruleId}`);
          continue;
        }
        const cgroupId = text(binding.cgroupId, 20);
        if (!cgroupId || !/^\d{1,20}$/u.test(cgroupId) || BigInt(cgroupId) <= 0n) {
          reportErrors.push(`binding has invalid cgroupId: ${binding.ruleId}`);
          continue;
        }
        const physicalWorkloadId = text(binding.physicalWorkloadId, 500);
        if (!physicalWorkloadId) {
          reportErrors.push(`binding has no physicalWorkloadId: ${binding.ruleId}`);
          continue;
        }
        const expectedAction = ruleEventAction(rule, 'FileAccess', binding.agentKeepConflict === true);
        if (binding.action !== expectedAction) {
          reportErrors.push(`binding action ${binding.action} is not allowed for ${binding.ruleId}; expected ${expectedAction}`);
          continue;
        }
        if (captureProfileReport) {
          const expectedDesired = expectedCaptureProbeActions(rule, binding.agentKeepConflict === true);
          const expectedEffective = previewCaptureProbeActions(expectedDesired);
          const expectedProfile = binding.agentKeepConflict
            ? 'agent_full'
            : binding.captureProfile === 'self_health'
              ? 'self_health'
              : 'infrastructure_aggregate';
          if (
            !sameCaptureIntent(binding.captureIntent, rule.captureIntent)
            || !validCaptureProbeActions(binding.desiredProbeActions)
            || !sameCaptureProbeActions(binding.desiredProbeActions, expectedDesired)
            || !validCaptureProbeActions(binding.probeActions)
            || !sameCaptureProbeActions(binding.probeActions, expectedEffective)
            || binding.effectiveAction !== legacyActionForCapture(expectedEffective)
            || binding.captureProfile !== expectedProfile
          ) {
            reportErrors.push(`binding Capture Profile actions are not allowed for ${binding.ruleId}`);
            continue;
          }
        }
        if (binding.agentKeepConflict) conflicts++;
        const scopeKey = `cgroup:${cgroupId}`;
        const expiresAtMs = Date.parse(binding.expiresAt ?? '');
        if (captureProfileReport && (!Number.isFinite(expiresAtMs) || expiresAtMs <= reportedAt)) {
          reportErrors.push(`binding has expired before Central acceptance: ${binding.ruleId}`);
          continue;
        }
        // One accepted report is one atomic control-plane observation. Give all accepted bindings
        // the same bounded report TTL so staggered local discovery timestamps cannot force dozens
        // of node-wide Preview/ACK/Grant cycles for an unchanged policy.
        const expiresAt = new Date(reportedAt + MATERIALIZATION_TTL_MS).toISOString();
        const materializationId = id('mat', [nodeId, policyVersion, epoch, rule.ruleId, rule.revision, physicalWorkloadId, cgroupId]);
        const entry: InfrastructureFilterRuleEntry = {
          scopeType: 'cgroup',
          scopeKey,
          cgroupId,
          classification: binding.agentKeepConflict ? 'confirmed_agent' : 'non_agent',
          authority: binding.agentKeepConflict ? 'authoritative' : rule.authority,
          action: expectedAction,
          ...(captureProfileReport ? {
            effectiveAction: binding.effectiveAction,
            captureProfile: binding.captureProfile,
            ...(rule.captureIntent ? { captureIntent: rule.captureIntent } : {}),
            probeActions: binding.probeActions,
            desiredProbeActions: binding.desiredProbeActions,
          } : {}),
          reasonCode: binding.agentKeepConflict ? 'conflict_keep_preferred' : rule.lifecycleStage === 'shadow' ? `shadow_${rule.reasonCode}` : rule.reasonCode,
          source: rule.source.type,
          physicalWorkloadId,
          ruleId: rule.ruleId,
          ruleRevision: rule.revision,
          policyVersion,
          materializationId,
          epoch,
          expiresAt,
        };
        const previous = entriesByScope.get(scopeKey);
        const rank = (action: InfrastructureFilterAction) => action === 'keep' ? 3 : action === 'drop' ? 2 : 1;
        if (previous && previous.action !== entry.action) conflicts++;
        if (!previous || rank(entry.action) > rank(previous.action)) entriesByScope.set(scopeKey, entry);
      }
      if (reportErrors.length) {
        this.audit.record({
          actor,
          action: 'infrastructure_rule.materialization_reported',
          resourceType: 'infrastructure-rule',
          resourceId: nodeId,
          summary: 'Infrastructure materialization report rejected',
          result: 'failure',
          details: { policyVersion, epoch, errors: reportErrors },
        });
        throw new InfrastructureRuleError('invalid_report', reportErrors.join('; '));
      }
      const report: InfrastructureMaterializationReportRecord = {
        schemaVersion: INFRASTRUCTURE_MATERIALIZATION_SCHEMA,
        reportId: text(request.reportId, 240) ?? id('matr', [nodeId, policyVersion, epoch, reportedAt]),
        nodeId,
        policyVersion,
        epoch,
        accepted: true,
        ...(captureProfileReport ? {
          snapshotContentHash,
          intentHash,
          activationMode: 'preview',
          publisherInstanceId,
          expectedEntries,
          ack,
        } : {}),
        reportedAt,
        bindings,
        filterRuleEntries: [...entriesByScope.values()].sort((left, right) => left.scopeKey.localeCompare(right.scopeKey)),
        conflicts,
        errors: (request.errors ?? []).map((error) => text(error, 500)).filter((error): error is string => Boolean(error)).slice(0, 100),
      };
      const previousReport = this.reports.find((item) => item.reportId === report.reportId);
      if (previousReport) {
        if (materializationOperationIdentity(previousReport) !== materializationOperationIdentity(report)) {
          throw new InfrastructureRuleError(
            'invalid_report',
            'materialization reportId is already bound to a different preview operation',
          );
        }
        // A response can be lost after the first durable acceptance. Returning the original record
        // neither extends its authority TTL nor creates another audit/state revision, and lets the
        // publisher finish the exact same generation-bound grant handshake.
        return structuredClone(previousReport);
      }
      this.reports = [...this.reports.filter((item) => item.reportId !== report.reportId), report]
        .sort((left, right) => right.reportedAt - left.reportedAt)
        .slice(0, MAX_REPORTS);
      this.stateVersion++;
      this.updatedAt = reportedAt;
      const persisted = await this.persist();
      this.audit.record({
        actor,
        action: 'infrastructure_rule.materialization_reported',
        resourceType: 'infrastructure-rule',
        resourceId: report.reportId,
        summary: `Infrastructure materialization accepted for ${nodeId}`,
        details: { policyVersion, epoch, bindings: bindings.length, entries: report.filterRuleEntries.length, conflicts, persisted },
      });
      return report;
    });
  }

  private humanContext(rule: InfrastructureRuleRecord) {
    return {
      desiredProbeActions: expectedCaptureProbeActions(rule),
      reports: this.reports,
      revisions: this.revisions,
      operations: this.operations,
    };
  }

  private async trustedAssetSnapshot(): Promise<InfrastructureGovernanceAssetSnapshot> {
    if (!this.assetProvider) {
      throw new InfrastructureRuleError(
        'asset_provider_unavailable',
        'server-owned asset snapshot provider is not configured',
      );
    }
    let snapshot: InfrastructureGovernanceAssetSnapshot;
    try {
      snapshot = await this.assetProvider.snapshot();
    } catch (error) {
      throw new InfrastructureRuleError(
        'asset_provider_unavailable',
        `server-owned asset snapshot failed: ${error instanceof Error ? error.message.slice(0, 300) : 'unknown error'}`,
      );
    }
    if (
      snapshot?.schemaVersion !== 'anysentry.infrastructure_asset_snapshot.v1' ||
      snapshot.trusted !== true ||
      snapshot.ready !== true ||
      typeof snapshot.destructiveReady !== 'boolean' ||
      !Number.isSafeInteger(snapshot.version) ||
      snapshot.version < 0 ||
      !Number.isSafeInteger(snapshot.generatedAt) ||
      snapshot.generatedAt <= 0 ||
      snapshot.generatedAt > Date.now() + 30_000 ||
      Date.now() - snapshot.generatedAt > VALIDATION_TTL_MS ||
      !Array.isArray(snapshot.assets) ||
      snapshot.assets.length > MAX_GOVERNANCE_ASSETS ||
      (snapshot.partialReasons !== undefined && (
        !Array.isArray(snapshot.partialReasons)
        || snapshot.partialReasons.length > MAX_IMPACT_PARTIAL_REASONS
        || snapshot.partialReasons.some((reason) => !impactPartialReason(reason))
      )) ||
      (snapshot.errors?.length ?? 0) > 0
    ) {
      throw new InfrastructureRuleError(
        'asset_provider_unavailable',
        'server-owned asset snapshot is unavailable, stale, malformed, or reports errors',
      );
    }
    const ids = new Set<string>();
    for (const asset of snapshot.assets) {
      const assetId = text(asset?.assetId, 240);
      if (
        !assetId ||
        ids.has(assetId) ||
        !Number.isSafeInteger(asset.revision) ||
        asset.revision <= 0 ||
        !text(asset.displayName, 240) ||
        !['exact', 'logical', 'ephemeral', 'weak', 'conflict'].includes(asset.bindingQuality) ||
        !Number.isSafeInteger(asset.instanceCount) ||
        asset.instanceCount < 0 ||
        asset.instanceCount > MAX_GOVERNANCE_ASSETS ||
        !Array.isArray(asset.nodeIds) ||
        asset.nodeIds.length > MAX_ENFORCED_MATCHES ||
        asset.nodeIds.some((nodeId) => !text(nodeId, 240)) ||
        !text(asset.workload?.physicalWorkloadId, 500) ||
        (asset.continuity !== undefined && (
          typeof asset.continuity.currentPresenceVerified !== 'boolean'
          || typeof asset.continuity.observationCoverageAvailable !== 'boolean'
          || typeof asset.continuity.serviceContextAvailable !== 'boolean'
          || (asset.continuity.partialReasons !== undefined && (
            !Array.isArray(asset.continuity.partialReasons)
            || asset.continuity.partialReasons.length > MAX_IMPACT_PARTIAL_REASONS
            || asset.continuity.partialReasons.some((reason) => !impactPartialReason(reason))
          ))
        ))
      ) {
        throw new InfrastructureRuleError('asset_provider_unavailable', 'server-owned asset snapshot contains an invalid asset');
      }
      ids.add(assetId);
    }
    return snapshot;
  }

  private startOperation(
    kind: InfrastructureRuleOperationKind,
    actor: InfrastructureRuleActor,
    targetStage: InfrastructureRuleStage,
    reason?: string,
    ruleId?: string,
    current?: InfrastructureRuleRecord,
  ): InfrastructureRuleOperationRecord {
    const requestedAt = Date.now();
    const operation: InfrastructureRuleOperationRecord = {
      operationId: id('ifop', [requestedAt, kind, actor.id, ruleId, this.stateVersion, this.operations.length]),
      kind,
      status: 'pending',
      ruleId,
      requestedAt,
      actorId: actor.id,
      previousRevision: current?.revision,
      previousStage: current?.lifecycleStage,
      targetStage,
      reason: text(reason, 500),
    };
    this.operations = [...this.operations, operation].slice(-MAX_OPERATIONS);
    return operation;
  }

  private async completeOperation(
    operationId: string,
    result: Partial<Pick<
      InfrastructureRuleOperationRecord,
      'status' | 'ruleId' | 'resultingRevision' | 'errorCode' | 'error' | 'persisted'
    >>,
  ): Promise<InfrastructureRuleOperationRecord> {
    const index = this.operations.findIndex((operation) => operation.operationId === operationId);
    if (index < 0) throw new InfrastructureRuleError('not_found', 'infrastructure operation not found');
    const next: InfrastructureRuleOperationRecord = {
      ...this.operations[index],
      ...result,
      status: result.status ?? 'failed',
      completedAt: Date.now(),
    };
    this.operations[index] = next;
    this.stateVersion++;
    this.updatedAt = next.completedAt!;
    const persisted = await this.persist();
    next.persisted = persisted;
    this.operations[index] = next;
    if (persisted) await this.persist();
    return { ...next };
  }

  private async createInside(
    input: InfrastructureRuleCreateRequest,
    actor: InfrastructureRuleActor,
    auditDetails: Record<string, unknown> = {},
  ): Promise<InfrastructureRuleRecord> {
    if (this.rules.size >= MAX_RULES) {
      throw new InfrastructureRuleError('capacity_exceeded', 'infrastructure rule capacity exceeded');
    }
    const selector = normalizeInfrastructureSelector(input.selector);
    const errors = infrastructureSelectorErrors(selector);
    if (errors.length) throw new InfrastructureRuleError('invalid_selector', errors.join('; '));
    const captureIntent = normalizeCaptureIntent(input.captureIntent);
    const workloadRole = normalizeWorkloadRole(input.workloadRole);
    if (captureIntent && input.eventPolicies !== undefined) {
      throw new InfrastructureRuleError(
        'invalid_selector',
        'captureIntent and legacy eventPolicies cannot be combined in one rule',
      );
    }
    const now = Date.now();
    const sourceType = SOURCE_TYPES.has(input.source?.type as InfrastructureRuleSourceType)
      ? input.source?.type as InfrastructureRuleSourceType
      : 'imported';
    const name = text(input.name, 240) ?? `Infrastructure ${sourceType}`;
    const ruleId = id('ifr', [now, ++this.stateVersion, actor.id, name, selector]);
    const rule = withHash({
      schemaVersion: 'anysentry.infrastructure_rule.v1',
      ruleId,
      revision: 1,
      name,
      selector,
      effect: 'infrastructure',
      source: {
        type: sourceType,
        sourceRef: text(input.source?.sourceRef, 500),
        issuer: actor.id,
      },
      // Creation is permanently candidate/draft. Authority can only be granted later by a
      // different approver after shadow inventory validation.
      authority: 'candidate',
      lifecycleStage: 'draft',
      reasonCode: text(input.reasonCode, 120) ?? 'platform_infrastructure',
      ...(workloadRole ? { workloadRole } : {}),
      priority: integer(input.priority, 100, 0, 1_000),
      ...(captureIntent ? { captureIntent } : {}),
      ...(!captureIntent ? { eventPolicies: normalizeEventPolicies(input.eventPolicies) } : {}),
      createdAt: now,
      updatedAt: now,
      createdBy: actor.id,
      changeTicket: text(input.changeTicket, 240),
    });
    this.rules.set(ruleId, rule);
    this.revisions.push(rule);
    this.revisions = this.revisions.slice(-MAX_REVISIONS);
    this.updatedAt = now;
    const persisted = await this.persist();
    this.auditRule('infrastructure_rule.created', rule, actor, persisted, {
      selector: rule.selector,
      captureIntent: rule.captureIntent,
      ...auditDetails,
    });
    return rule;
  }

  private async transitionWithOperation(
    ruleId: string,
    input: InfrastructureRuleTransitionRequest,
    actor: InfrastructureRuleActor,
    target: Exclude<InfrastructureRuleStage, 'draft'>,
    kind: Extract<InfrastructureRuleOperationKind, 'shadow' | 'promote' | 'revoke'>,
  ): Promise<InfrastructureRuleRecord> {
    const current = this.get(ruleId);
    const operation = this.startOperation(kind, actor, target, input.reason, ruleId, current);
    try {
      if (target === 'enforced') await this.impactPreview(ruleId, actor);
      const rule = await this.transition(ruleId, input, actor, target);
      await this.completeOperation(operation.operationId, {
        status: 'succeeded',
        ruleId: rule.ruleId,
        resultingRevision: rule.revision,
      });
      return rule;
    } catch (error) {
      await this.completeOperation(operation.operationId, {
        status: 'failed',
        ruleId,
        errorCode: error instanceof InfrastructureRuleError ? error.code : 'internal_error',
        error: error instanceof Error ? error.message.slice(0, 500) : 'unknown error',
      });
      throw error;
    }
  }

  private transition(
    ruleId: string,
    input: InfrastructureRuleTransitionRequest,
    actor: InfrastructureRuleActor,
    target: Exclude<InfrastructureRuleStage, 'draft'>,
  ): Promise<InfrastructureRuleRecord> {
    return this.mutate(async () => {
      const current = this.get(ruleId);
      if (input.expectedRevision !== undefined && integer(input.expectedRevision, -1, -1, Number.MAX_SAFE_INTEGER) !== current.revision) {
        throw new InfrastructureRuleError('revision_conflict', 'infrastructure rule revision does not match');
      }
      if (target === 'shadow' && current.lifecycleStage !== 'draft') {
        throw new InfrastructureRuleError('invalid_transition', 'only a draft rule can enter shadow');
      }
      if (target === 'enforced') {
        if (current.lifecycleStage !== 'shadow') throw new InfrastructureRuleError('invalid_transition', 'only a shadow rule can be enforced');
        if (!AUTHORITATIVE_SOURCES.has(current.source.type)) {
          throw new InfrastructureRuleError('authority_required', 'candidate source cannot enforce an Infrastructure drop');
        }
        if (current.createdBy === actor.id) {
          throw new InfrastructureRuleError('authority_required', 'a different operator must approve enforced Infrastructure drop');
        }
        const selectorErrors = infrastructureAuthoritativeSelectorErrors(current.selector);
        if (selectorErrors.length) {
          throw new InfrastructureRuleError('authority_required', selectorErrors.join('; '));
        }
        const validation = this.validations.get(ruleId);
        if (
          !validation ||
          validation.serverOwned !== true ||
          validation.revision !== current.revision ||
          Date.now() - validation.at > VALIDATION_TTL_MS ||
          !validation.valid ||
          validation.inventoryCount === 0 ||
          validation.matchedWorkloads === 0 ||
          validation.agentConflicts > 0
        ) {
          throw new InfrastructureRuleError(
            'authority_required',
            'current shadow revision requires a recent inventory validation with no Agent conflicts',
          );
        }
      }
      if (target === 'revoked' && current.lifecycleStage === 'revoked') return current;
      const now = Date.now();
      const previousValidation = this.validations.get(ruleId);
      const previousStateVersion = this.stateVersion;
      const previousPolicyVersion = this.policyVersion;
      const previousUpdatedAt = this.updatedAt;
      const previousRevisionsLength = this.revisions.length;
      const next = withHash({
        ...current,
        revision: current.revision + 1,
        lifecycleStage: target,
        authority: target === 'enforced' ? 'authoritative' : current.authority,
        approvedBy: target === 'enforced' ? actor.id : current.approvedBy,
        changeTicket: text(input.changeTicket, 240) ?? current.changeTicket,
        updatedAt: now,
      });
      this.rules.set(ruleId, next);
      this.validations.delete(ruleId);
      this.revisions.push(next);
      this.revisions = this.revisions.slice(-MAX_REVISIONS);
      this.stateVersion++;
      this.policyVersion++;
      this.updatedAt = now;
      if (target === 'enforced') this.pendingDurabilityRuleIds.add(ruleId);
      const persisted = await this.persist();
      this.pendingDurabilityRuleIds.delete(ruleId);
      if (target === 'enforced' && !persisted) {
        this.rules.set(ruleId, current);
        this.revisions = this.revisions.slice(0, previousRevisionsLength);
        this.stateVersion = previousStateVersion;
        this.policyVersion = previousPolicyVersion;
        this.updatedAt = previousUpdatedAt;
        if (previousValidation) this.validations.set(ruleId, previousValidation);
        throw new InfrastructureRuleError(
          'asset_provider_unavailable',
          'enforced rule revision was not durable and was not published',
        );
      }
      const action = target === 'shadow'
        ? 'infrastructure_rule.shadowed'
        : target === 'enforced'
          ? 'infrastructure_rule.promoted'
          : 'infrastructure_rule.revoked';
      this.auditRule(action, next, actor, persisted, {
        previousRevision: current.revision,
        previousStage: current.lifecycleStage,
        reason: text(input.reason, 500),
      });
      return next;
    });
  }

  private auditRule(
    action: 'infrastructure_rule.created' | 'infrastructure_rule.shadowed' | 'infrastructure_rule.promoted' | 'infrastructure_rule.revoked',
    rule: InfrastructureRuleRecord,
    actor: InfrastructureRuleActor,
    persisted: boolean,
    details: Record<string, unknown>,
  ): void {
    this.audit.record({
      actor,
      action,
      resourceType: 'infrastructure-rule',
      resourceId: rule.ruleId,
      summary: `${action}: ${rule.name}`,
      details: {
        revision: rule.revision,
        lifecycleStage: rule.lifecycleStage,
        authority: rule.authority,
        source: rule.source.type,
        contentHash: rule.contentHash,
        persisted,
        ...details,
      },
    });
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationTail.catch(() => undefined).then(operation);
    this.mutationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private document(): InfrastructureRuleStateDocument {
    return {
      schemaVersion: INFRASTRUCTURE_RULE_STATE_SCHEMA,
      stateVersion: this.stateVersion,
      policyVersion: this.policyVersion,
      updatedAt: this.updatedAt || Date.now(),
      rules: [...this.rules.values()],
      revisions: this.revisions.slice(-MAX_REVISIONS),
      materializationReports: this.reports.slice(0, MAX_REPORTS),
      operations: this.operations.slice(-MAX_OPERATIONS),
    };
  }

  private async persist(awaitMigrationMirror = false): Promise<boolean> {
    const document = this.document();
    const updatedAt = this.updatedAt || Date.now();
    const relationalSaved = await this.relational.savePlatformConfig(CONFIG_KEY, document, updatedAt);
    if (relationalSaved && this.relational.isReady() && !awaitMigrationMirror) {
      // PostgreSQL is the authoritative mutable-state store. A Capture Profile grant may proceed
      // once that write is durable; waiting for the optional ClickHouse migration mirror made the
      // 5-second control request contend with full-file event inserts. Mirror after the response,
      // while shutdown still explicitly waits for both stores above.
      setImmediate(() => {
        void this.ch.savePlatformConfig(CONFIG_KEY, document, updatedAt).catch((error) => {
          console.warn('[infrastructure-rules] ClickHouse migration mirror failed:', (error as Error).message);
        });
      });
      return true;
    }
    const clickhouseSaved = await this.ch.savePlatformConfig(CONFIG_KEY, document, updatedAt);
    return relationalSaved || clickhouseSaved;
  }

  private restore(document: InfrastructureRuleStateDocument): void {
    const validRevisions = (Array.isArray(document.revisions) ? document.revisions : [])
      .filter((rule): rule is InfrastructureRuleRecord =>
        rule?.schemaVersion === 'anysentry.infrastructure_rule.v1' &&
        validCaptureIntent(rule.captureIntent) &&
        !(rule.captureIntent && rule.eventPolicies !== undefined) &&
        validRuleHash(rule) &&
        infrastructureSelectorErrors(rule.selector).length === 0 &&
        (rule.authority !== 'authoritative' || AUTHORITATIVE_SOURCES.has(rule.source.type)) &&
        (rule.lifecycleStage !== 'enforced' || rule.authority === 'authoritative'))
      .slice(-MAX_REVISIONS);
    this.revisions = validRevisions;
    for (const rule of validRevisions) {
      const current = this.rules.get(rule.ruleId);
      if (!current || rule.revision > current.revision) this.rules.set(rule.ruleId, rule);
    }
    this.reports = (Array.isArray(document.materializationReports) ? document.materializationReports : [])
      .filter((report) => report?.schemaVersion === INFRASTRUCTURE_MATERIALIZATION_SCHEMA)
      .sort((left, right) => right.reportedAt - left.reportedAt)
      .slice(0, MAX_REPORTS);
    this.operations = (Array.isArray(document.operations) ? document.operations : [])
      .filter((operation): operation is InfrastructureRuleOperationRecord =>
        Boolean(
          operation &&
          typeof operation.operationId === 'string' &&
          ['asset_draft', 'shadow', 'promote', 'revoke'].includes(operation.kind) &&
          ['pending', 'succeeded', 'failed'].includes(operation.status) &&
          Number.isSafeInteger(operation.requestedAt) &&
          operation.requestedAt > 0,
        ))
      .map((operation) => operation.status === 'pending'
        ? {
            ...operation,
            status: 'failed' as const,
            completedAt: Date.now(),
            errorCode: 'operation_interrupted',
            error: 'API restarted before the rule operation completed',
          }
        : operation)
      .sort((left, right) => left.requestedAt - right.requestedAt)
      .slice(-MAX_OPERATIONS);
    this.stateVersion = integer(document.stateVersion, 0, 0, Number.MAX_SAFE_INTEGER);
    this.policyVersion = integer(document.policyVersion, 0, 0, Number.MAX_SAFE_INTEGER);
    this.updatedAt = integer(document.updatedAt, Date.now(), 0, Number.MAX_SAFE_INTEGER);
  }
}
