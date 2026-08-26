import { BadRequestException, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AggregationService } from './aggregation.service';
import {
  effectiveInfrastructureAction,
  infrastructureSelectorMatches,
  InfrastructureRuleService,
} from './infrastructure-rule.service';
import type {
  InfrastructureInventoryWorkload,
  InfrastructureRuleRecord,
  InfrastructureRuleSelector,
} from './infrastructure-rule.types';
import { KubeIdentityService } from './kube-identity.service';
import { canonicalProcessLifecycleIdentity, processLifecycleFact } from './process-lifecycle';
import { SentryJudgeService } from './sentry-judge.service';
import type { AgentEventList, AgentEventListItem, AgentTimeline, EventMeta, JudgedEvent } from './types';
import { AgentMetadataService } from './agent-metadata.service';
import {
  ObservedAssetReviewDecision,
  ObservedAssetReviewService,
} from './observed-asset-review.service';
import type { AuditActor } from './types';
import { AgentRuntimeStateService } from './agent-runtime-state.service';
import {
  ObservedAssetLifecycleCore,
  ObservedAssetCoreError,
  type ObservedAssetLifecycleStateDocument,
  stableSubjectAssetId,
} from './observed-asset-lifecycle.service';
import { RelationalBusinessStore } from './relational-business-store.service';
import type {
  AssetLifecycleFactDto,
  ExistingAgentAssetProjection,
  ExistingEventProjection,
  ExistingKubeServiceProjection,
  ObservationCoverageIntervalDto,
  ObservedAssetDetailDto,
  ObservedAssetListDto,
  ObservedAssetListQuery,
  ObservedAssetSummaryDto,
  ObservedAgentIdentity,
  ObservedRuntimeDto,
  ObservedWorkloadRole,
  SignalCoverageMatrix,
  SubjectAssetType,
} from './observed-asset-lifecycle.types';

export const OBSERVED_ASSET_READ_STATUS_SCHEMA = 'anysentry.observed_asset_read_status.v1' as const;
const AGENT_LIMIT = 500;
const EVENT_LIMIT = 120;
const SERVICE_LIMIT = 2_000;
const STRUCTURAL_FACT_LIMIT = 500;
const STRUCTURAL_WINDOW_MS = 10 * 60_000;
const RULE_LIMIT = 500;
const RECONCILE_TTL_MS = 60_000;

export type ObservedAssetPartialReason =
  | 'agent_inventory_partial'
  | 'agent_inventory_truncated'
  | 'agent_inventory_unavailable'
  | 'service_inventory_not_ready'
  | 'service_inventory_errors'
  | 'service_inventory_truncated'
  | 'event_window_partial'
  | 'event_window_truncated'
  | 'event_window_unavailable'
  | 'structural_lifecycle_partial'
  | 'unassigned_events'
  | 'shared_physical_scope'
  | 'observation_coverage_unavailable'
  | 'rule_match_incomplete'
  | 'rule_list_truncated'
  | 'asset_state_truncated'
  | 'asset_materialization_degraded'
  | 'cold_process_lifecycle_partial'
  | 'no_observed_assets';

export interface ObservedAssetReadStatus {
  schemaVersion: typeof OBSERVED_ASSET_READ_STATUS_SCHEMA;
  partial: boolean;
  reasons: ObservedAssetPartialReason[];
  sources: {
    agentInventory: { available: boolean; items: number; partial: boolean; source?: string };
    serviceInventory: { available: boolean; items: number; ready: boolean; errors: number };
    events: { available: boolean; items: number; total: number; partial: boolean; source?: string };
    structuralLifecycle: {
      exactFacts: number;
      unresolvedEvents: number;
      totalAvailable: number;
      truncated: boolean;
      hydratedFromStorage: boolean;
    };
  };
  modelRevision: number;
  reconciledAt: string;
}

interface CurrentAssetClassificationMeta {
  classificationView: 'current_effective';
  reviewRevision: number;
  assetBindingRevision: number;
}

export interface ObservedAssetListReadResponse extends ObservedAssetListDto, CurrentAssetClassificationMeta {
  readStatus: ObservedAssetReadStatus;
}

export interface ObservedAssetDetailReadResponse extends ObservedAssetDetailDto, CurrentAssetClassificationMeta {
  readStatus: ObservedAssetReadStatus;
}

export interface ObservedAssetTimelineResponse {
  schemaVersion: 'anysentry.observed_asset_timeline.v1';
  subjectAssetId: string;
  items: AssetLifecycleFactDto[];
  total: number;
  classificationView: 'current_effective';
  reviewRevision: number;
  assetBindingRevision: number;
  readStatus: ObservedAssetReadStatus;
  updateTime: string;
}

export interface ObservedAssetCoverageResponse {
  schemaVersion: 'anysentry.observed_asset_coverage.v1';
  subjectAssetId: string;
  current?: ObservationCoverageIntervalDto;
  items: ObservationCoverageIntervalDto[];
  total: number;
  classificationView: 'current_effective';
  reviewRevision: number;
  assetBindingRevision: number;
  readStatus: ObservedAssetReadStatus;
  updateTime: string;
}

export interface ObservedAssetRuleItem {
  ruleId: string;
  revision: number;
  name: string;
  lifecycleStage: InfrastructureRuleRecord['lifecycleStage'];
  authority: InfrastructureRuleRecord['authority'];
  source: InfrastructureRuleRecord['source']['type'];
  purpose: string;
  scopeLabel: string;
  captureResult: string;
  protectedSignals: string;
  effectiveAction: string;
  matchQuality: 'exact' | 'potential';
  matchedPhysicalWorkloadIds: string[];
  updatedAt: string;
  createdBy: string;
  approvedBy?: string;
}

export interface ObservedAssetRulesResponse {
  schemaVersion: 'anysentry.observed_asset_rules.v1';
  subjectAssetId: string;
  items: ObservedAssetRuleItem[];
  total: number;
  classificationView: 'current_effective';
  reviewRevision: number;
  assetBindingRevision: number;
  readStatus: ObservedAssetReadStatus;
  updateTime: string;
}

export interface ObservedAssetReviewImpactResponse {
  schemaVersion: 'anysentry.observed_asset_review_impact.v1';
  assetId: string;
  assetRevision: number;
  bindingRevision: number;
  reviewRevision: number;
  canReview: boolean;
  reasons: string[];
  scopeLabel: string;
  bindingQuality: string;
  currentIdentity: string;
  runtimeInstances: number;
  recentWindowEvents: number;
  observationState: string;
  matchedRules: number;
  actions: {
    markNonAgent: boolean;
    setPending: boolean;
    restoreAutomatic: boolean;
  };
  warning: string;
  updateTime: string;
}

function iso(value = Date.now()): string {
  return new Date(value).toISOString();
}

function parseApiTime(value: string | undefined): number {
  if (!value) return Number.NaN;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  return Date.parse(normalized);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function stableRevision(value: unknown): number {
  return Math.max(1, Number.parseInt(
    createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 12),
    16,
  ));
}

function relatedPhysicalWorkload(left: string, right: string): boolean {
  if (left === right) return true;
  const prefix = (value: string) => {
    const parts = value.split(':');
    return parts[0] === 'k8s' && parts.length >= 3 ? parts.slice(0, 3).join(':') : undefined;
  };
  const leftPrefix = prefix(left);
  return Boolean(leftPrefix && leftPrefix === prefix(right));
}

function eventAt(value: { at: string; eventAtUnixNs?: string }): number {
  if (value.eventAtUnixNs && /^\d+$/u.test(value.eventAtUnixNs)) {
    try {
      const millis = BigInt(value.eventAtUnixNs) / 1_000_000n;
      if (millis <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(millis);
    } catch {}
  }
  const parsed = parseApiTime(value.at);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function receivedAt(value: { receivedAt?: string }): number | undefined {
  const parsed = parseApiTime(value.receivedAt);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function profileName(code: number | undefined): string | undefined {
  const names: Record<number, string> = {
    1: 'unknown_discovery',
    2: 'agent_full',
    3: 'investigation_full',
    4: 'security_full',
    5: 'business_context',
    6: 'infrastructure_aggregate',
    7: 'self_health',
    8: 'probable_investigation',
  };
  return code === undefined ? undefined : names[code];
}

function coverageForProfile(profile: string): {
  matrix: SignalCoverageMatrix;
  observationState: 'full' | 'aggregate' | 'sample';
} {
  if (profile === 'agent_full' || profile === 'investigation_full') {
    return {
      matrix: { exec: 'full', exit: 'full', security: 'full', file: 'full', fileRead: 'full', network: 'full', llm: 'full' },
      observationState: 'full',
    };
  }
  if (profile === 'probable_investigation') {
    return {
      matrix: { exec: 'structural', exit: 'structural', security: 'full', file: 'sample', fileRead: 'full', network: 'sample', llm: 'full' },
      observationState: 'sample',
    };
  }
  if (profile === 'security_full') {
    return {
      matrix: { exec: 'full', exit: 'full', security: 'full', file: 'full', fileRead: 'not_enabled', network: 'full', llm: 'full' },
      observationState: 'full',
    };
  }
  if (profile === 'infrastructure_aggregate' || profile === 'business_context' || profile === 'self_health') {
    return {
      matrix: { exec: 'structural', exit: 'structural', security: 'full', file: 'aggregate', fileRead: 'not_enabled', network: 'aggregate', llm: 'aggregate' },
      observationState: 'aggregate',
    };
  }
  return {
    matrix: { exec: 'structural', exit: 'structural', security: 'full', file: 'sample', fileRead: 'not_enabled', network: 'sample', llm: 'sample' },
    observationState: 'sample',
  };
}

function selectorScopeLabel(selector: InfrastructureRuleSelector): string {
  if (selector.placement === 'kubernetes') {
    return [
      'Kubernetes', selector.clusterId, selector.namespace,
      selector.ownerKind && selector.ownerName ? `${selector.ownerKind} ${selector.ownerName}` : selector.ownerName,
      selector.containerName ? `container ${selector.containerName}` : undefined,
    ].filter(Boolean).join(' / ');
  }
  if (selector.placement === 'docker') {
    return [
      'Docker', selector.nodeId,
      selector.composeProject && selector.serviceName ? `${selector.composeProject}/${selector.serviceName}` : selector.serviceName,
      selector.containerName ? `container ${selector.containerName}` : undefined,
    ].filter(Boolean).join(' / ');
  }
  return ['Host', selector.nodeId, selector.systemdUnit].filter(Boolean).join(' / ');
}

function captureResult(rule: InfrastructureRuleRecord): string {
  if (rule.captureIntent) {
    const labels = { full: '完整采集', aggregate: '聚合重复信号', sample: '有界采样', drop: '停止已批准低价值信号' };
    return labels[rule.captureIntent.action];
  }
  const actions = unique(Object.values(rule.eventPolicies ?? {}));
  if (!actions.length) return '使用兼容基础设施采集策略';
  return actions.map((action) => action === 'keep' ? '保留' : action === 'sample' ? '有界采样' : '丢弃').join('、');
}

function potentialSelectorMatch(selector: InfrastructureRuleSelector, workload: InfrastructureInventoryWorkload): boolean {
  if (selector.placement !== workload.placement) return false;
  const pairs: Array<[string | undefined, string | undefined]> = [
    [selector.nodeId, workload.nodeId],
    [selector.clusterId, workload.clusterId],
    [selector.namespace, workload.namespace],
    [selector.ownerKind, workload.ownerKind],
    [selector.ownerName, workload.ownerName],
    [selector.composeProject, workload.composeProject],
    [selector.serviceName, workload.serviceName],
    [selector.containerName, workload.containerName],
    [selector.imageDigest, workload.imageDigest],
    [selector.systemdUnit, workload.systemdUnit],
    [selector.configuredRoot, workload.configuredRoot],
  ];
  return pairs.every(([expected, actual]) => !expected || !actual || expected === actual);
}

@Injectable()
export class ObservedAssetLifecycleService implements OnModuleInit, OnModuleDestroy {
  private readonly core = new ObservedAssetLifecycleCore();
  private lastReconciledAt = 0;
  private lastStatus?: ObservedAssetReadStatus;
  private lastEventBindings = new Map<string, {
    subjectAssetId?: string;
    subjectAssetType?: 'agent' | 'service' | 'infrastructure' | 'workload' | 'ephemeral_process';
    assetBindingQuality: 'exact' | 'logical' | 'ephemeral' | 'weak' | 'conflict' | 'unassigned';
    assetBindingRevision: number;
    reasonCode: string;
  }>();
  private statePersistTimer?: NodeJS.Timeout;
  private statePersistenceReady = false;
  private restoredStateTruncated = false;
  private persistedStateRevision = -1;
  private committedMaterializationDegraded = false;
  private coldProcessLifecyclePartial = false;

  constructor(
    private readonly aggregation: AggregationService,
    private readonly kube: KubeIdentityService,
    private readonly infrastructureRules: InfrastructureRuleService,
    private readonly judge: SentryJudgeService,
    private readonly agentMetadata: AgentMetadataService,
    private readonly assetReviews: ObservedAssetReviewService,
    private readonly agentRuntimeState: AgentRuntimeStateService,
    private readonly relational: RelationalBusinessStore,
  ) {}

  async onModuleInit(): Promise<void> {
    const saved = await this.relational.loadPlatformConfig<ObservedAssetLifecycleStateDocument>(
      'observed_asset_lifecycle_state_v1',
    );
    if (saved?.record && this.core.restoreState(saved.record)) {
      this.restoredStateTruncated = saved.record.truncated === true;
      this.persistedStateRevision = this.core.persistentRevision();
    }
    this.statePersistenceReady = true;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.statePersistTimer) clearTimeout(this.statePersistTimer);
    this.statePersistTimer = undefined;
    await this.persistState();
  }

  list(query: ObservedAssetListQuery): ObservedAssetListReadResponse {
    const status = this.reconcile();
    return { ...this.core.listAssets(query), ...this.currentClassificationMeta(), readStatus: status };
  }

  detail(assetId: string): ObservedAssetDetailReadResponse | undefined {
    const status = this.reconcile();
    const detail = this.core.getAsset(assetId);
    return detail ? { ...detail, ...this.currentClassificationMeta(), readStatus: status } : undefined;
  }

  /**
   * Recreate a cold subject from its persisted event binding when it has aged out of the bounded
   * in-memory projection. This keeps an event-to-asset deep link useful without retaining every
   * process generation in PostgreSQL.
   */
  async ensureAsset(assetId: string): Promise<boolean> {
    this.reconcile();
    if (this.core.getAsset(assetId)) return true;
    const queryUntil = Date.now();
    const querySince = Math.max(0, queryUntil - 30 * 24 * 60 * 60_000);
    // This is intentionally a ClickHouse-only seam. Dashboard durable reads may merge hot delta or
    // fall back to the in-memory ring; neither is sufficient to publish a cold Asset.
    const stored = await this.judge.searchStoredEventsPage({
      sinceMs: querySince,
      untilMs: queryUntil,
      monitoredOnly: false,
      subjectAssetId: assetId,
      limit: 1,
    });
    if (stored.unavailable) return false;
    const event = stored.events.find((candidate) => candidate.subjectAssetId === assetId);
    if (!event?.subjectAssetType) return false;
    const observedAt = event.at;
    if (event.subjectAssetType === 'ephemeral_process') {
      const identity = canonicalProcessLifecycleIdentity(event.process, event.attribution);
      if (!identity) return false;
      const processFacts = await this.judge.processLifecycleFactsForGeneration(
        identity.processInstanceKey,
        querySince,
        queryUntil,
        1_000,
      );
      const latestFact = processFacts?.at(-1);
      const terminalExit = latestFact?.factKind === 'exit' ? latestFact : undefined;
      if (!processFacts || !terminalExit) this.coldProcessLifecyclePartial = true;
      try {
        this.core.upsertAsset({
          subjectAssetId: assetId,
          subjectAssetType: 'ephemeral_process',
          logicalIdentity: identity.processInstanceKey,
          displayName: event.subject || `Process ${identity.pid}`,
          scope: { hostId: identity.hostId },
          // A cold historical occurrence is not proof that the Process is still running. Keep it
          // evictable and show an unknown Runtime unless an exact durable Exit is available.
          existenceState: 'inactive',
          identity: 'unknown',
          role: 'ordinary_process',
          source: 'durable_event_subject',
          observedAt,
          inventoryObserved: false,
          observationState: 'structural',
        });
        this.core.upsertBinding({
          subjectAssetId: assetId,
          runtimeInstanceId: identity.processInstanceKey,
          quality: 'ephemeral',
          processInstanceKey: identity.processInstanceKey,
          physicalWorkloadId: event.attribution?.physicalWorkloadId,
          source: 'durable_event_subject',
          reasonCode: terminalExit ? 'cold_process_exact_exit' : 'cold_process_state_unknown',
          effectiveAt: observedAt,
        });
        this.core.upsertRuntime({
          runtimeInstanceId: identity.processInstanceKey,
          subjectAssetId: assetId,
          placement: 'process',
          state: terminalExit ? 'exited' : 'unknown',
          physicalWorkloadId: event.attribution?.physicalWorkloadId,
          processInstanceKey: identity.processInstanceKey,
          startedAt: processFacts?.find((fact) => fact.factKind === 'exec')?.at ?? observedAt,
          observedAt: terminalExit?.receivedAt ?? event.receivedAt ?? observedAt,
          endedAt: terminalExit?.at,
          source: 'durable_event_subject',
          reasonCode: terminalExit ? 'cold_process_exact_exit' : 'cold_process_state_unknown',
          evidenceRefs: terminalExit ? [terminalExit.factId, terminalExit.eventId] : [event.eventId],
        });
        return true;
      } catch (error) {
        if (error instanceof ObservedAssetCoreError
          && (error.code === 'capacity_exceeded' || error.code === 'not_found')) return false;
        throw error;
      }
    }
    const subjectAssetType = event.subjectAssetType as SubjectAssetType;
    const currentReview = this.assetReviews.current(assetId);
    const observedIdentity = currentReview?.decision
      ?? (subjectAssetType === 'agent' ? event.attribution?.classification : 'unknown');
    const identity: ObservedAgentIdentity = observedIdentity === 'confirmed_agent'
      || observedIdentity === 'probable_agent'
      || observedIdentity === 'non_agent'
      ? observedIdentity
      : 'unknown';
    const semanticRole = event.classificationSemantics?.workloadRole;
    const role: ObservedWorkloadRole = semanticRole === 'agent'
      || semanticRole === 'anysentry_internal'
      || semanticRole === 'platform_infrastructure'
      || semanticRole === 'business_service'
      || semanticRole === 'ordinary_process'
      ? semanticRole
      : subjectAssetType === 'agent' ? 'agent' : 'unknown';
    try {
      this.core.upsertAsset({
        subjectAssetId: assetId,
        subjectAssetType,
        logicalIdentity: assetId,
        displayName: event.subject || assetId,
        scope: {
          workspacePath: event.workspacePath,
          hostId: event.process?.hostId,
          namespace: event.attribution?.workloadRef?.namespace,
          ownerKind: event.attribution?.workloadRef?.ownerKind,
          ownerName: event.attribution?.workloadRef?.ownerName,
          containerName: event.attribution?.workloadRef?.containerName,
          systemdUnit: event.process?.systemdUnit ?? event.attribution?.workloadRef?.systemdUnit,
        },
        // An occurrence-time exact binding is historical evidence, not proof that the workload is
        // currently present. Current Inventory reconciliation must reactivate and bind this asset.
        existenceState: 'inactive',
        identity,
        role,
        source: 'historical_event_subject',
        evidenceRefs: [
          `durable-event:${event.eventId}`,
          `historical-binding:${event.assetBindingQuality ?? 'unassigned'}`,
        ],
        observedAt,
        inventoryObserved: false,
        observationState: profileName(event.captureProfileCode)
          ? coverageForProfile(profileName(event.captureProfileCode)!).observationState
          : 'structural',
        captureProfile: profileName(event.captureProfileCode),
      });
      // Do not turn the event's occurrence-time exact binding into a current open-ended binding.
      // The event itself remains the immutable as-observed evidence; current review stays disabled
      // until Kube/Docker/Host/Agent Runtime inventory confirms a stable logical target.
      return true;
    } catch (error) {
      if (error instanceof ObservedAssetCoreError
        && (error.code === 'capacity_exceeded' || error.code === 'not_found')) return false;
      throw error;
    }
  }

  timeline(assetId: string, limit = 200): ObservedAssetTimelineResponse | undefined {
    const detail = this.detail(assetId);
    if (!detail) return undefined;
    const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limit) || 200));
    const items = detail.lifecycleFacts.slice(-boundedLimit);
    return {
      schemaVersion: 'anysentry.observed_asset_timeline.v1',
      subjectAssetId: assetId,
      items,
      total: detail.lifecycleFacts.length,
      ...this.currentClassificationMeta(),
      readStatus: detail.readStatus,
      updateTime: iso(),
    };
  }

  coverage(assetId: string, limit = 200): ObservedAssetCoverageResponse | undefined {
    const detail = this.detail(assetId);
    if (!detail) return undefined;
    const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limit) || 200));
    const items = detail.observationCoverage.slice(-boundedLimit);
    const current = [...detail.observationCoverage].reverse().find((interval) => interval.state === 'active');
    const readStatus = detail.observationCoverage.length
      ? detail.readStatus
      : this.withReasons(detail.readStatus, ['observation_coverage_unavailable']);
    return {
      schemaVersion: 'anysentry.observed_asset_coverage.v1',
      subjectAssetId: assetId,
      current,
      items,
      total: detail.observationCoverage.length,
      ...this.currentClassificationMeta(),
      readStatus,
      updateTime: iso(),
    };
  }

  rules(assetId: string): ObservedAssetRulesResponse | undefined {
    const detail = this.detail(assetId);
    if (!detail) return undefined;
    const listed = this.infrastructureRules.list({ limit: RULE_LIMIT });
    const candidates = this.inventoryCandidates(detail);
    let incomplete = candidates.length === 0;
    const items: ObservedAssetRuleItem[] = [];
    for (const rule of listed.items) {
      const exact = candidates.filter((candidate) => infrastructureSelectorMatches(rule.selector, candidate));
      const potential = exact.length ? [] : candidates.filter((candidate) => potentialSelectorMatch(rule.selector, candidate));
      if (!exact.length && !potential.length) continue;
      if (!exact.length) incomplete = true;
      items.push({
        ruleId: rule.ruleId,
        revision: rule.revision,
        name: rule.name,
        lifecycleStage: rule.lifecycleStage,
        authority: rule.authority,
        source: rule.source.type,
        purpose: rule.reasonCode,
        scopeLabel: selectorScopeLabel(rule.selector),
        captureResult: captureResult(rule),
        protectedSignals: '安全事件完整保留；进程启动和退出保留结构',
        effectiveAction: effectiveInfrastructureAction(rule),
        matchQuality: exact.length ? 'exact' : 'potential',
        matchedPhysicalWorkloadIds: unique(exact.map((candidate) => candidate.physicalWorkloadId)).slice(0, 100),
        updatedAt: iso(rule.updatedAt),
        createdBy: rule.createdBy,
        approvedBy: rule.approvedBy,
      });
    }
    items.sort((left, right) =>
      Number(right.matchQuality === 'exact') - Number(left.matchQuality === 'exact')
      || Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
      || left.ruleId.localeCompare(right.ruleId));
    const reasons: ObservedAssetPartialReason[] = [];
    if (incomplete) reasons.push('rule_match_incomplete');
    if (listed.total > listed.items.length) reasons.push('rule_list_truncated');
    return {
      schemaVersion: 'anysentry.observed_asset_rules.v1',
      subjectAssetId: assetId,
      items,
      total: items.length,
      ...this.currentClassificationMeta(),
      readStatus: this.withReasons(detail.readStatus, reasons),
      updateTime: listed.updateTime,
    };
  }

  summary(): {
    summary: ObservedAssetSummaryDto;
    readStatus: ObservedAssetReadStatus;
    classificationView: 'current_effective';
    reviewRevision: number;
    assetBindingRevision: number;
  } {
    const readStatus = this.reconcile();
    return { summary: this.core.summary(), ...this.currentClassificationMeta(), readStatus };
  }

  modelRevision(): number {
    this.reconcile();
    return this.core.revision();
  }

  bindingRevision(): number {
    this.reconcile();
    return this.core.bindingRevision();
  }

  bindIngestMeta(meta: EventMeta, eventAt?: number): EventMeta {
    const physicalWorkloadId = meta.attribution?.physicalWorkloadId?.trim();
    const classification = meta.attribution?.classification ?? 'unknown';
    const evidence = meta.attribution?.evidence ?? [];
    const strongAgent = classification === 'confirmed_agent'
      || classification === 'probable_agent'
      || meta.attribution?.conflict === true
      || evidence.some((item) => item.startsWith('server:authenticated-agent-adapter'));
    if (strongAgent) {
      const resolved = this.agentMetadata.resolveEvent(meta as JudgedEvent, eventAt);
      return {
        ...meta,
        subjectAssetId: resolved.agentAssetId,
        subjectAssetType: 'agent',
        assetBindingQuality: resolved.reviewConflict ? 'conflict' : physicalWorkloadId ? 'exact' : 'logical',
        assetBindingRevision: stableRevision([
          resolved.agentAssetId,
          physicalWorkloadId ?? '',
          meta.attribution?.agentInstanceId ?? '',
          meta.attribution?.rootStartTime ?? '',
          meta.process?.bootId ?? '',
          meta.process?.startTimeTicks ?? meta.process?.startTimeNs ?? '',
        ]),
        assetBindingReason: resolved.reviewConflict ? 'agent_identity_conflict' : 'agent_identity_binding',
        identityRevision: resolved.reviewRevision ?? 1,
      };
    }

    if (physicalWorkloadId) {
      const resolution = this.kube.resolveServiceForPhysicalWorkload(physicalWorkloadId);
      if (resolution.asset) {
        const service = resolution.asset;
        const review = eventAt === undefined || !resolution.ready
          ? undefined
          : this.assetReviews.effectiveAt(service.serviceAssetId, eventAt);
        return {
          ...meta,
          ...(review ? {
            attribution: {
              ...(meta.attribution ?? {
                monitored: false,
                confidence: 0,
                reason: 'not_evaluated' as const,
                source: 'none' as const,
              }),
              monitored: false,
              classification: review.decision,
              reason: review.decision === 'non_agent' ? 'human_rejected' : 'human_deferred',
              source: 'manual_review',
              evidence: [...evidence, `manual_asset_review:revision=${review.revision}`].slice(-16),
            },
          } : {}),
          subjectAssetId: service.serviceAssetId,
          subjectAssetType: 'service',
          assetBindingQuality: 'exact',
          assetBindingRevision: stableRevision([
            service.serviceAssetId,
            service.revision,
            service.physicalWorkloadIds,
          ]),
          assetBindingReason: resolution.ready
            ? 'kubernetes_service_physical_binding'
            : 'kubernetes_service_lkg_binding_review_not_applied',
          identityRevision: review?.revision ?? 1,
        };
      }
      if (resolution.ambiguous) {
        return {
          ...meta,
          assetBindingQuality: 'conflict',
          assetBindingRevision: 0,
          assetBindingReason: 'service_physical_scope_conflict',
        };
      }
    }

    const process = meta.process;
    const processIdentity = canonicalProcessLifecycleIdentity(process, meta.attribution);
    if (process && processIdentity) {
      const subjectAssetId = stableSubjectAssetId('ephemeral_process', {
        hostId: process.hostId,
      }, processIdentity.processInstanceKey);
      return {
        ...meta,
        subjectAssetId,
        subjectAssetType: 'ephemeral_process',
        assetBindingQuality: 'ephemeral',
        // One ephemeral asset represents exactly one immutable process generation, so its
        // canonical binding starts at revision one. Core materialization happens only after the
        // event or compact lifecycle fact has committed durably.
        assetBindingRevision: 1,
        assetBindingReason: 'exact_process_generation',
        identityRevision: 1,
      };
    }
    return {
      ...meta,
      assetBindingQuality: 'unassigned',
      assetBindingRevision: 0,
      assetBindingReason: 'no_stable_asset_binding',
      identityRevision: 1,
    };
  }

  /**
   * Publish an exact process subject into the bounded read model after its event/fact is durable.
   * This method is idempotent and deliberately does not mirror high-cardinality process state to
   * the PostgreSQL logical-asset snapshot; ClickHouse process_lifecycle_facts is its durable truth.
   */
  materializeCommittedIngest(meta: EventMeta, eventAt?: number): boolean {
    if (meta.subjectAssetType !== 'ephemeral_process' || !meta.subjectAssetId) return true;
    const process = meta.process;
    const processIdentity = canonicalProcessLifecycleIdentity(process, meta.attribution);
    if (!process || !processIdentity) {
      this.committedMaterializationDegraded = true;
      return false;
    }
    const expectedAssetId = stableSubjectAssetId('ephemeral_process', {
      hostId: process.hostId,
    }, processIdentity.processInstanceKey);
    if (expectedAssetId !== meta.subjectAssetId) {
      this.committedMaterializationDegraded = true;
      return false;
    }
    const processInstanceKey = processIdentity.processInstanceKey;
    const effectiveAt = eventAt ?? meta.receivedAt ?? Date.now();
    const existingAsset = this.core.getAssetRecord(meta.subjectAssetId);
    const existingRuntime = this.core.getRuntime(meta.subjectAssetId, processInstanceKey);
    const existingRuntimeAt = Math.max(
      existingRuntime?.lastInventoryAt ? Date.parse(existingRuntime.lastInventoryAt) : -1,
      existingRuntime?.endedAt ? Date.parse(existingRuntime.endedAt) : -1,
    );
    const staleLifecycle = Number.isFinite(existingRuntimeAt) && existingRuntimeAt > effectiveAt;
    const preserveTerminalExit = existingRuntime?.state === 'exited' && meta.eventKind !== 'ProcessExit';
    const requestedExistence = staleLifecycle || preserveTerminalExit
      ? existingAsset?.existenceState ?? 'inactive'
      : meta.eventKind === 'ProcessExit' ? 'inactive' : 'discovered';
    try {
      this.core.upsertAsset({
        subjectAssetId: meta.subjectAssetId,
        subjectAssetType: 'ephemeral_process',
        logicalIdentity: processInstanceKey,
        displayName: process.comm ?? process.exe ?? `Process ${process.pid}`,
        scope: { hostId: process.hostId },
        existenceState: requestedExistence,
        identity: 'unknown',
        role: 'ordinary_process',
        source: 'committed_process_generation',
        observedAt: effectiveAt,
        inventoryObserved: false,
        observationState: 'structural',
      });
      this.core.upsertBinding({
        subjectAssetId: meta.subjectAssetId,
        runtimeInstanceId: processInstanceKey,
        quality: 'ephemeral',
        processInstanceKey,
        physicalWorkloadId: meta.attribution?.physicalWorkloadId,
        source: 'committed_process_generation',
        reasonCode: 'exact_process_generation',
        effectiveAt,
      });
      this.core.upsertRuntime({
        runtimeInstanceId: processInstanceKey,
        subjectAssetId: meta.subjectAssetId,
        placement: 'process',
        state: meta.eventKind === 'ProcessExit' ? 'exited' : 'current',
        physicalWorkloadId: meta.attribution?.physicalWorkloadId,
        processInstanceKey,
        startedAt: effectiveAt,
        // Runtime ordering is event-time based. Receipt time is not allowed to revive a generation
        // after a newer exact Exit merely because an old event arrived late.
        observedAt: effectiveAt,
        endedAt: meta.eventKind === 'ProcessExit' ? effectiveAt : undefined,
        source: 'committed_process_generation',
        reasonCode: meta.eventKind === 'ProcessExit' ? 'exact_process_exit' : 'exact_process_exec',
      });
      return true;
    } catch (error) {
      if (error instanceof ObservedAssetCoreError
        && (error.code === 'capacity_exceeded' || error.code === 'not_found')) {
        this.committedMaterializationDegraded = true;
        return false;
      }
      this.committedMaterializationDegraded = true;
      console.warn('[observed-assets] committed process materialization failed', {
        eventKind: meta.eventKind,
        subjectAssetId: meta.subjectAssetId,
        error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
      });
      return false;
    }
  }

  private reviewSafety(detail: ObservedAssetDetailReadResponse): {
    complete: boolean;
    strongAgentEvidence: boolean;
    reasons: string[];
  } {
    const physicalIds = new Set(detail.bindings
      .filter((binding) => !binding.validTo && binding.physicalWorkloadId)
      .map((binding) => binding.physicalWorkloadId!));
    const kube = this.kube.snapshot();
    const runtimes = this.agentRuntimeState.list({ includeShadow: true, limit: 100_000 });
    const complete = kube.ready && kube.errors === 0 && runtimes.total === runtimes.items.length;
    const kubeAgent = kube.entries.some((entry) =>
      [...physicalIds].some((physical) => relatedPhysicalWorkload(physical, entry.physicalWorkloadId))
      && (entry.classification === 'confirmed_agent' || entry.classification === 'probable_agent'));
    const runtimeAgent = runtimes.items.some((runtime) =>
      Boolean(runtime.physicalWorkloadId && [...physicalIds].some((physical) =>
        relatedPhysicalWorkload(physical, runtime.physicalWorkloadId!)))
      && runtime.runtimeState !== 'exited'
      && runtime.runtimeState !== 'lost'
      && (runtime.classification === 'confirmed_agent' || runtime.classification === 'probable_agent'));
    const semanticAgent = (detail.asset.eventSummary.eventKindCounts.AgentTool ?? 0) > 0
      || (detail.asset.eventSummary.eventKindCounts.AgentInvocation ?? 0) > 0;
    const strongAgentEvidence = detail.asset.subjectAssetType === 'agent' || kubeAgent || runtimeAgent || semanticAgent;
    return {
      complete,
      strongAgentEvidence,
      reasons: [
        ...(!complete ? ['identity_inventory_partial'] : []),
        ...(kubeAgent ? ['kubernetes_agent_binding'] : []),
        ...(runtimeAgent ? ['active_agent_runtime'] : []),
        ...(semanticAgent ? ['authenticated_agent_semantic_evidence'] : []),
      ],
    };
  }

  reviewImpact(assetId: string): ObservedAssetReviewImpactResponse | undefined {
    const detail = this.detail(assetId);
    if (!detail) return undefined;
    const currentReview = this.assetReviews.current(assetId);
    const supportedAssetType = detail.asset.subjectAssetType !== 'agent';
    const stable = supportedAssetType && (
      detail.asset.bindingQuality === 'exact' || detail.asset.bindingQuality === 'logical'
    );
    const conflict = detail.asset.bindingQuality === 'conflict';
    const safety = this.reviewSafety(detail);
    const reasons: string[] = [];
    if (!stable) reasons.push('binding_not_stable');
    if (!supportedAssetType) reasons.push('use_agent_identity_review');
    if (conflict) reasons.push('identity_conflict');
    if (detail.readStatus.partial) reasons.push('asset_snapshot_partial');
    reasons.push(...safety.reasons);
    const matchedRules = this.rules(assetId)?.items.length ?? 0;
    return {
      schemaVersion: 'anysentry.observed_asset_review_impact.v1',
      assetId,
      assetRevision: detail.asset.modelRevision,
      bindingRevision: detail.asset.bindingRevision,
      reviewRevision: this.assetReviews.latestRevision(assetId),
      canReview: stable && !conflict,
      reasons,
      scopeLabel: [
        detail.asset.scope.clusterId,
        detail.asset.scope.namespace,
        detail.asset.scope.ownerName,
        detail.asset.scope.hostId,
        detail.asset.scope.systemdUnit,
      ].filter(Boolean).join(' / ') || detail.asset.displayName,
      bindingQuality: detail.asset.bindingQuality,
      currentIdentity: detail.asset.identity.classification,
      runtimeInstances: detail.runtimes.filter((runtime) => runtime.state !== 'exited' && runtime.state !== 'lost').length,
      recentWindowEvents: detail.asset.eventSummary.eventCount,
      observationState: detail.asset.observationState,
      matchedRules,
      actions: {
        markNonAgent: stable
          && !conflict
          && safety.complete
          && !safety.strongAgentEvidence
          && detail.asset.identity.classification === 'unknown',
        setPending: stable && !conflict && detail.asset.identity.classification !== 'unknown',
        restoreAutomatic: Boolean(currentReview),
      },
      warning: '身份审核不会删除历史事件，也不会单独保证 Ring 前采集档位变化；全局规则和当前物理绑定仍需独立校验。',
      updateTime: iso(),
    };
  }

  async reviewAsset(
    assetId: string,
    input: {
      decision?: ObservedAssetReviewDecision;
      expectedReviewRevision?: number;
      expectedBindingRevision?: number;
      effectiveAt?: number;
      reason?: string;
    },
    actor: Partial<AuditActor>,
  ) {
    const detail = this.detail(assetId);
    if (!detail) return undefined;
    if (detail.asset.subjectAssetType === 'agent') {
      throw new BadRequestException('Agent assets must use the Agent identity review workflow');
    }
    const decision = input.decision;
    const classification = detail.asset.identity.classification;
    if (
      decision === 'non_agent'
      && (classification === 'confirmed_agent' || classification === 'probable_agent')
    ) {
      throw new BadRequestException('Agent candidates must move to pending review before non-Agent exclusion');
    }
    if (decision === 'non_agent') {
      const safety = this.reviewSafety(detail);
      if (!safety.complete) throw new BadRequestException('current Agent inventory is incomplete; non-Agent review is blocked');
      if (safety.strongAgentEvidence) {
        throw new BadRequestException(`strong Agent evidence blocks non-Agent review: ${safety.reasons.join(', ')}`);
      }
    }
    if (decision === 'clear' && !this.assetReviews.current(assetId)) {
      throw new BadRequestException('asset has no active manual review to clear');
    }
    const result = await this.assetReviews.review(detail.asset, input, actor);
    this.lastReconciledAt = 0;
    this.reconcile(true);
    const reconciled = this.core.getAsset(assetId);
    if (reconciled) {
      this.core.applyLifecycleFact({
        factKind: result.decision === 'clear' ? 'human_review_cleared' : 'identity_decision_changed',
        subjectAssetId: assetId,
        effectiveAt: result.effectiveAt,
        observedAt: result.reviewedAt,
        source: 'human_asset_review',
        reasonCode: result.decision === 'clear' ? 'restore_automatic_identification' : `manual_${result.decision}`,
        previousState: detail.asset.identity.classification,
        nextState: reconciled.asset.identity.classification,
        ...(result.decision === 'clear' ? {} : { nextIdentity: result.decision }),
        evidenceRefs: [`asset-review:${assetId}:r${result.revision}`],
        dedupeKey: `asset-review:${result.globalRevision}`,
      });
      const activeCoverage = [...reconciled.observationCoverage].reverse().find((interval) => interval.state === 'active');
      if (activeCoverage) {
        this.core.activateCoverage({
          subjectAssetId: assetId,
          runtimeInstanceId: activeCoverage.runtimeInstanceId,
          effectiveAt: result.effectiveAt,
          confirmedAt: result.reviewedAt,
          captureProfile: activeCoverage.captureProfile,
          capturePolicyVersion: activeCoverage.capturePolicyVersion,
          captureEpoch: activeCoverage.latestCaptureEpoch,
          signalCoverage: activeCoverage.signalCoverage,
          completeness: activeCoverage.completeness,
          observationState: activeCoverage.observationState,
          reasonCode: result.decision === 'clear' ? 'review_cleared_reconcile' : 'identity_review_changed',
          ruleRefs: activeCoverage.ruleRefs,
        });
      }
    }
    return {
      review: result,
      asset: this.core.getAsset(assetId)?.asset,
      impact: this.reviewImpact(assetId),
    };
  }

  annotateEventList(list: AgentEventList): AgentEventList {
    this.reconcile();
    return {
      ...list,
      items: this.annotatedEventItems(list.items),
      assetBindingRevision: this.core.bindingRevision(),
    };
  }

  annotateTimeline(timeline: AgentTimeline): AgentTimeline {
    this.reconcile();
    return {
      ...timeline,
      items: this.annotatedEventItems(timeline.items),
      assetBindingRevision: this.core.bindingRevision(),
    };
  }

  private annotatedEventItems(items: AgentEventListItem[]): AgentEventListItem[] {
    return items.map((event) => {
      if (event.subjectAssetId || event.assetBindingQuality) return event;
      const binding = this.lastEventBindings.get(event.eventId);
      if (!binding) {
        return {
          ...event,
          assetBindingQuality: 'unassigned' as const,
          assetBindingRevision: 0,
          assetBindingReason: 'outside_bounded_asset_snapshot',
        };
      }
      return {
        ...event,
        subjectAssetId: binding.subjectAssetId,
        subjectAssetType: binding.subjectAssetType,
        assetBindingQuality: binding.assetBindingQuality,
        assetBindingRevision: binding.assetBindingRevision,
        assetBindingReason: `legacy_current_binding_fallback:${binding.reasonCode}`,
      };
    });
  }

  /** Request-time bounded reconciliation. Related list/detail subrequests share one recent view. */
  reconcile(force = false): ObservedAssetReadStatus {
    const now = Date.now();
    if (!force && this.lastStatus && now - this.lastReconciledAt < RECONCILE_TTL_MS) {
      return structuredClone(this.lastStatus);
    }
    const reasons: ObservedAssetPartialReason[] = [];
    let agentInventory: ReturnType<AggregationService['agentInventory']> | undefined;
    let events: ReturnType<AggregationService['agentEvents']> | undefined;
    let serviceInventory: ReturnType<KubeIdentityService['serviceInventory']> | undefined;

    try {
      serviceInventory = this.kube.serviceInventory();
      const services = serviceInventory.items.slice(0, SERVICE_LIMIT).map((service): ExistingKubeServiceProjection => {
        const review = this.assetReviews.current(service.serviceAssetId);
        return {
          ...service,
          ...(review ? {
            identity: review.decision,
            identitySource: 'human_asset_review',
            identityEffectiveAt: review.effectiveAt,
          } : {}),
        };
      });
      if (serviceInventory.ready && serviceInventory.errors === 0) {
        this.core.reconcileKubeServices(services);
      }
      if (!serviceInventory.ready) reasons.push('service_inventory_not_ready');
      if (serviceInventory.errors > 0) reasons.push('service_inventory_errors');
      if (serviceInventory.items.length > services.length) reasons.push('service_inventory_truncated');
    } catch {
      reasons.push('service_inventory_not_ready');
    }

    try {
      agentInventory = this.aggregation.agentInventory({
        timeType: 'last_30m', scope: 'raw', includeUnclassified: true, limit: AGENT_LIMIT,
      });
      const agents = agentInventory.items
        .map((item): ExistingAgentAssetProjection => {
          const review = this.assetReviews.current(item.agentAssetId);
          return {
            ...item,
            ...(review ? { classification: review.decision, reviewDecision: review.decision } : {}),
            // The bounded event snapshot below owns event aggregation. Avoid counting the same hot
            // facts once from AgentInventory and again from the raw event projection.
            eventCount: 0,
            eventCategoryCounts: {},
            processInstanceKey: undefined,
          };
        })
        .filter((item) =>
          item.classification !== 'unknown'
          || Boolean(item.physicalWorkloadId || item.agentInstanceId)
          || item.attributionSource === 'manual_review')
        .slice(0, AGENT_LIMIT);
      this.core.reconcileAgentAssets(agents);
      if (agentInventory.coverage?.partial) reasons.push('agent_inventory_partial');
      if (agentInventory.total > agentInventory.items.length || agentInventory.items.length >= AGENT_LIMIT) {
        reasons.push('agent_inventory_truncated');
      }
    } catch {
      reasons.push('agent_inventory_unavailable');
    }

    for (const review of this.assetReviews.allHistory()) {
      if (!this.core.getAsset(review.assetId)) continue;
      this.core.applyLifecycleFact({
        factKind: review.decision === 'clear' ? 'human_review_cleared' : 'identity_decision_changed',
        subjectAssetId: review.assetId,
        effectiveAt: review.effectiveAt,
        observedAt: review.reviewedAt,
        source: 'human_asset_review',
        reasonCode: review.decision === 'clear' ? 'restore_automatic_identification' : `manual_${review.decision}`,
        nextState: review.decision,
        evidenceRefs: [`asset-review:${review.assetId}:r${review.revision}`],
        dedupeKey: `asset-review:${review.globalRevision}`,
      });
    }

    let exactFacts = 0;
    let unresolvedEvents = 0;
    let structuralTotalAvailable = 0;
    let structuralTruncated = false;
    let structuralHydratedFromStorage = false;
    try {
      const structuralPage = this.judge.processLifecycleFactsPage(
        now - STRUCTURAL_WINDOW_MS,
        now,
        STRUCTURAL_FACT_LIMIT,
      );
      const structuralFacts = structuralPage.items;
      structuralTotalAvailable = structuralPage.total;
      structuralTruncated = structuralPage.truncated;
      structuralHydratedFromStorage = structuralPage.hydratedFromStorage;
      events = this.aggregation.agentEvents({
        timeType: 'last_30m', scope: 'raw', includeUnknown: true, noise: 'include', limit: EVENT_LIMIT,
      });
      const lifecycleByEvent = new Map<string, ReturnType<typeof processLifecycleFact>>(
        structuralFacts.map((fact) => [fact.eventId, fact]),
      );
      const durableLifecycleEventIds = new Set(lifecycleByEvent.keys());
      exactFacts = structuralFacts.length;
      const projections: ExistingEventProjection[] = structuralFacts.map((fact) => ({
        eventId: fact.eventId,
        at: fact.at,
        eventKind: fact.factKind === 'exit' ? 'ProcessExit' : 'ToolExec',
        subjectAssetId: fact.subjectAssetId,
        subjectAssetType: fact.subjectAssetType,
        bindingQuality: fact.assetBindingQuality,
        physicalWorkloadId: fact.physicalWorkloadId,
        processInstanceKey: fact.processInstanceKey,
        displayName: `Process ${fact.pid}`,
        scope: { workspacePath: fact.workspacePath, hostId: fact.hostId },
      }));
      projections.push(...events.items.map((event): ExistingEventProjection => {
        const at = eventAt(event);
        const lifecycle = lifecycleByEvent.get(event.eventId) ?? processLifecycleFact({
          eventId: event.eventId,
          sourceEventId: event.sourceEventId,
          eventKind: event.eventKind,
          at,
          receivedAt: receivedAt(event),
          source: event.source,
          sourceId: event.sourceId,
          collectorId: event.collectorId,
          workspacePath: event.workspacePath,
          process: event.process,
          attribution: event.attribution,
          attributes: event.attributes,
        });
        lifecycleByEvent.set(event.eventId, lifecycle);
        if (lifecycle && !durableLifecycleEventIds.has(event.eventId)) exactFacts += 1;
        else if (event.eventKind === 'ToolExec' || event.eventKind === 'ProcessExit') unresolvedEvents += 1;
        return {
          eventId: event.eventId,
          at,
          eventKind: event.eventKind,
          subjectAssetId: event.subjectAssetId,
          subjectAssetType: event.subjectAssetType,
          bindingQuality: event.assetBindingQuality,
          agentAssetId: event.agentAssetId,
          identityClassification: event.asObservedClassification ?? event.detectedClassification,
          workloadRole: event.classificationSemantics?.workloadRole,
          authenticatedAgentSemantic: (event.eventKind === 'AgentTool' || event.eventKind === 'AgentInvocation')
            && (event.attribution?.evidence ?? []).some((evidence) => evidence.startsWith('server:authenticated-agent-adapter')),
          physicalWorkloadId: event.attribution?.physicalWorkloadId,
          processInstanceKey: lifecycle?.processInstanceKey ?? event.correlation?.processInstanceId,
          displayName: event.displayName ?? event.detectedName ?? event.subject,
          scope: {
            workspacePath: event.workspacePath,
            hostId: event.process?.hostId,
            namespace: event.attribution?.workloadRef?.namespace,
            ownerKind: event.attribution?.workloadRef?.ownerKind,
            ownerName: event.attribution?.workloadRef?.ownerName,
            containerName: event.attribution?.workloadRef?.containerName,
            systemdUnit: event.process?.systemdUnit ?? event.attribution?.workloadRef?.systemdUnit,
          },
        };
      }));
      const dedupedProjections = [...new Map(projections.map((projection) => [projection.eventId, projection])).values()];
      const bindings = this.core.reconcileEventSnapshot(dedupedProjections);
      const eventById = new Map(events.items.map((event) => [event.eventId, event]));
      this.lastEventBindings = new Map(bindings.map((binding) => [binding.eventId, {
        subjectAssetId: binding.subjectAssetId,
        subjectAssetType: binding.subjectAssetType,
        assetBindingQuality: binding.assetBindingQuality,
        assetBindingRevision: binding.assetBindingRevision,
        reasonCode: binding.reasonCode,
      }]));
      for (const binding of bindings) {
        if (!binding.subjectAssetId) continue;
        const lifecycle = lifecycleByEvent.get(binding.eventId);
        if (!lifecycle) continue;
        const detail = this.core.getAsset(binding.subjectAssetId);
        if (!detail) continue;
        const event = eventById.get(binding.eventId);
        const isEphemeral = detail.asset.subjectAssetType === 'ephemeral_process';
        const isAgentRoot = Boolean(
          (
            event
            && event.attribution?.rootPid
            && event.process?.pid === event.attribution.rootPid
            && event.attribution.agentInstanceId
          )
          || (lifecycle.rootProcess === true && lifecycle.runtimeInstanceId),
        );
        if (!isEphemeral && !isAgentRoot) continue;
        const runtimeInstanceId = isAgentRoot
          ? event?.attribution?.agentInstanceId ?? lifecycle.runtimeInstanceId!
          : lifecycle.processInstanceKey;
        this.core.upsertRuntime({
          runtimeInstanceId,
          subjectAssetId: binding.subjectAssetId,
          placement: isAgentRoot ? event?.runtime ?? 'unknown' : 'process',
          state: lifecycle.factKind === 'exit' ? 'exited' : 'current',
          physicalWorkloadId: lifecycle.physicalWorkloadId,
          processInstanceKey: lifecycle.processInstanceKey,
          startedAt: lifecycle.at,
          observedAt: lifecycle.receivedAt,
          endedAt: lifecycle.factKind === 'exit' ? lifecycle.at : undefined,
          source: 'structural_process_fact',
          reasonCode: lifecycle.factKind === 'exit' ? 'exact_process_exit' : 'exact_process_exec',
          evidenceRefs: [lifecycle.factId, lifecycle.eventId],
        });
        if (isEphemeral) {
          this.core.upsertBinding({
            subjectAssetId: binding.subjectAssetId,
            runtimeInstanceId,
            quality: 'ephemeral',
            physicalWorkloadId: lifecycle.physicalWorkloadId,
            processInstanceKey: lifecycle.processInstanceKey,
            source: 'structural_process_fact',
            reasonCode: 'exact_process_generation',
            effectiveAt: lifecycle.at,
            evidenceRefs: [lifecycle.factId],
          });
        }
      }
      const bindingByEvent = new Map(bindings.map((binding) => [binding.eventId, binding]));
      const latestCoverageEvent = new Map<string, AgentEventListItem>();
      for (const event of events.items) {
        const binding = bindingByEvent.get(event.eventId);
        const profile = profileName(event.captureProfileCode);
        if (!binding?.subjectAssetId || !event.captureEpoch || !profile) continue;
        const previous = latestCoverageEvent.get(binding.subjectAssetId);
        if (!previous || eventAt(event) > eventAt(previous)) {
          latestCoverageEvent.set(binding.subjectAssetId, event);
        }
      }
      for (const [subjectAssetId, event] of latestCoverageEvent) {
        const profile = profileName(event.captureProfileCode)!;
        const coverage = coverageForProfile(profile);
        const transitionAt = eventAt(event);
        const activeCoverage = [...(this.core.getAsset(subjectAssetId)?.observationCoverage ?? [])]
          .reverse()
          .find((interval) => interval.state === 'active');
        if (activeCoverage && transitionAt < Date.parse(activeCoverage.startAt)) {
          // Late old-epoch facts remain queryable as event evidence but cannot move the current
          // observation boundary backwards.
          continue;
        }
        this.core.activateCoverage({
          subjectAssetId,
          effectiveAt: transitionAt,
          confirmedAt: receivedAt(event) ?? transitionAt,
          captureProfile: profile,
          capturePolicyVersion: event.capturePolicyVersion ?? 0,
          captureEpoch: event.captureEpoch!,
          signalCoverage: coverage.matrix,
          completeness: event.capturePolicyVersion === undefined ? 'partial' : 'bounded',
          observationState: coverage.observationState,
          reasonCode: event.capturePolicyVersion === undefined
            ? 'event_capture_decision_policy_version_unavailable'
            : 'event_capture_decision',
          ruleRefs: [],
        });
      }
      if (events.coverage.partial) reasons.push('event_window_partial');
      if (events.total > events.items.length || events.items.length >= EVENT_LIMIT) reasons.push('event_window_truncated');
      if (unresolvedEvents > 0) reasons.push('structural_lifecycle_partial');
      if (structuralTruncated) reasons.push('structural_lifecycle_partial');
    } catch {
      reasons.push('event_window_unavailable');
    }

    const summary = this.core.summary();
    if (summary.unassignedEvents > 0) reasons.push('unassigned_events');
    if (this.sharedPhysicalScope(serviceInventory?.items ?? [], agentInventory?.items ?? [])) {
      reasons.push('shared_physical_scope');
    }
    if (summary.totalAssets === 0) reasons.push('no_observed_assets');
    if (this.restoredStateTruncated) reasons.push('asset_state_truncated');
    if (this.committedMaterializationDegraded) reasons.push('asset_materialization_degraded');
    if (this.coldProcessLifecyclePartial) reasons.push('cold_process_lifecycle_partial');
    const uniqueReasons = unique(reasons);
    const completedAt = Date.now();
    const status: ObservedAssetReadStatus = {
      schemaVersion: OBSERVED_ASSET_READ_STATUS_SCHEMA,
      partial: uniqueReasons.length > 0,
      reasons: uniqueReasons,
      sources: {
        agentInventory: {
          available: Boolean(agentInventory),
          items: agentInventory?.items.length ?? 0,
          partial: agentInventory?.coverage?.partial ?? true,
          source: agentInventory?.coverage?.source,
        },
        serviceInventory: {
          available: Boolean(serviceInventory),
          items: serviceInventory?.items.length ?? 0,
          ready: serviceInventory?.ready ?? false,
          errors: serviceInventory?.errors ?? 0,
        },
        events: {
          available: Boolean(events),
          items: events?.items.length ?? 0,
          total: events?.total ?? 0,
          partial: events?.coverage.partial ?? true,
          source: events?.coverage.source,
        },
        structuralLifecycle: {
          exactFacts,
          unresolvedEvents,
          totalAvailable: structuralTotalAvailable,
          truncated: structuralTruncated,
          hydratedFromStorage: structuralHydratedFromStorage,
        },
      },
      modelRevision: this.core.revision(),
      reconciledAt: iso(completedAt),
    };
    this.lastStatus = status;
    // TTL starts when the expensive reconciliation has completed. Starting it before the work
    // meant any run slower than the TTL was already stale on return and every follow-up request
    // immediately repeated the same full projection.
    this.lastReconciledAt = completedAt;
    this.persistStateSoon();
    return structuredClone(status);
  }

  private persistStateSoon(): void {
    if (!this.statePersistenceReady || this.statePersistTimer) return;
    if (this.persistedStateRevision === this.core.persistentRevision()) return;
    this.statePersistTimer = setTimeout(() => {
      this.statePersistTimer = undefined;
      void this.persistState();
    }, 500);
    this.statePersistTimer.unref?.();
  }

  private async persistState(): Promise<boolean> {
    if (!this.statePersistenceReady) return false;
    const persistentRevision = this.core.persistentRevision();
    const document = this.core.stateDocument();
    const saved = await this.relational.savePlatformConfig(
      'observed_asset_lifecycle_state_v1',
      document,
      document.updatedAt || Date.now(),
    );
    if (saved) {
      this.persistedStateRevision = persistentRevision;
      this.restoredStateTruncated = document.truncated;
      if (this.core.persistentRevision() !== persistentRevision) this.persistStateSoon();
    }
    return saved;
  }

  private withReasons(status: ObservedAssetReadStatus, reasons: ObservedAssetPartialReason[]): ObservedAssetReadStatus {
    const merged = unique([...status.reasons, ...reasons]);
    return { ...structuredClone(status), partial: merged.length > 0, reasons: merged };
  }

  private currentClassificationMeta(): CurrentAssetClassificationMeta {
    return {
      classificationView: 'current_effective',
      reviewRevision: Math.min(
        Number.MAX_SAFE_INTEGER,
        this.agentMetadata.identitySnapshotVersion() + this.assetReviews.version(),
      ),
      assetBindingRevision: this.core.bindingRevision(),
    };
  }

  private inventoryCandidates(detail: ObservedAssetDetailDto): InfrastructureInventoryWorkload[] {
    const placements = unique(detail.runtimes.map((runtime) => runtime.placement));
    const inferredPlacement = detail.asset.scope.clusterId ? 'kubernetes'
      : detail.asset.scope.systemdUnit ? 'host'
        : placements.includes('docker') ? 'docker'
          : placements.includes('host') ? 'host' : undefined;
    if (!inferredPlacement) return [];
    const activeBindings = detail.bindings.filter((binding) => !binding.validTo && binding.physicalWorkloadId);
    const physicals = activeBindings.length ? activeBindings.map((binding) => binding.physicalWorkloadId!) : [`asset:${detail.asset.subjectAssetId}`];
    return physicals.slice(0, 100).map((physicalWorkloadId): InfrastructureInventoryWorkload => ({
      placement: inferredPlacement,
      nodeId: detail.asset.scope.hostId ?? detail.asset.scope.hostGroup,
      clusterId: detail.asset.scope.clusterId,
      namespace: detail.asset.scope.namespace,
      ownerKind: detail.asset.scope.ownerKind,
      ownerName: detail.asset.scope.ownerName,
      serviceName: detail.asset.displayName,
      containerName: detail.asset.scope.containerName,
      systemdUnit: detail.asset.scope.systemdUnit,
      physicalWorkloadId,
      classification: detail.asset.identity.classification,
    }));
  }

  private sharedPhysicalScope(
    services: Array<{ physicalWorkloadIds: string[] }>,
    agents: Array<{ physicalWorkloadId?: string }>,
  ): boolean {
    const servicePhysical = new Set(services.flatMap((service) => service.physicalWorkloadIds));
    return agents.some((agent) => Boolean(agent.physicalWorkloadId && servicePhysical.has(agent.physicalWorkloadId)));
  }
}
