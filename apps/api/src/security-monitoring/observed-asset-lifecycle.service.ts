import { createHash } from 'node:crypto';
import {
  ASSET_LIFECYCLE_FACT_SCHEMA,
  AssetBindingQuality,
  AssetExistenceState,
  AssetLifecycleFactDto,
  AssetLifecycleFactKind,
  EventSubjectBindingDto,
  ExistingAgentAssetProjection,
  ExistingEventProjection,
  ExistingKubeServiceProjection,
  OBSERVATION_COVERAGE_SCHEMA,
  OBSERVED_ASSET_DETAIL_SCHEMA,
  OBSERVED_ASSET_LIST_SCHEMA,
  OBSERVED_ASSET_SCHEMA,
  ObservationCoverageIntervalDto,
  ObservationCoverageTransitionInput,
  ObservationState,
  ObservedAgentIdentity,
  ObservedAssetBindingDto,
  ObservedAssetBindingInput,
  ObservedAssetCoreOptions,
  ObservedAssetDetailDto,
  ObservedAssetDto,
  ObservedAssetListDto,
  ObservedAssetListQuery,
  ObservedAssetRuntimeSummary,
  ObservedAssetSummaryDto,
  ObservedAssetUpsertInput,
  ObservedRuntimeDto,
  ObservedRuntimeState,
  ObservedRuntimeUpsertInput,
  ObservedWorkloadRole,
  SignalCoverageMatrix,
  StructuralLifecycleFactInput,
  SubjectAssetScope,
  SubjectAssetType,
} from './observed-asset-lifecycle.types';

const SUBJECT_TYPES: SubjectAssetType[] = ['agent', 'service', 'infrastructure', 'workload', 'ephemeral_process'];
const EXISTENCE_STATES: AssetExistenceState[] = ['discovered', 'active', 'inactive', 'retired'];
const IDENTITIES: ObservedAgentIdentity[] = ['confirmed_agent', 'probable_agent', 'unknown', 'non_agent'];
const ROLES: ObservedWorkloadRole[] = [
  'agent', 'anysentry_internal', 'platform_infrastructure', 'business_service', 'ordinary_process', 'unknown',
];
const OBSERVATION_STATES: ObservationState[] = ['full', 'structural', 'aggregate', 'sample', 'suppressed', 'degraded', 'gap'];
const BINDING_QUALITIES: AssetBindingQuality[] = ['exact', 'logical', 'ephemeral', 'weak', 'conflict', 'unassigned'];
const RUNTIME_STATES: ObservedRuntimeState[] = ['starting', 'current', 'idle', 'exited', 'lost', 'unknown'];
const SIGNAL_COVERAGES = new Set(['full', 'structural', 'aggregate', 'sample', 'drop', 'not_enabled', 'unknown']);

// Process Assets are a bounded read cache over durable event/lifecycle facts, not the durable
// history itself. Ten thousand entries cover the interactive recent set while avoiding a 50k-wide
// clone/reconcile surface under full-file process churn.
const DEFAULT_MAX_ASSETS = 10_000;
const DEFAULT_MAX_VERSIONS = 64;
const DEFAULT_MAX_FACTS = 256;
const DEFAULT_MAX_COVERAGE = 256;
const DEFAULT_MAX_BINDINGS = 128;
const DEFAULT_MAX_RUNTIMES = 128;

interface AssetVersion {
  revision: number;
  asset: ObservedAssetDto;
}

interface AssetEvictionCandidate {
  subjectAssetId: string;
  generation: number;
  typePriority: number;
  updatedAt: number;
}

interface CursorPayload {
  v: 1;
  snapshotRevision: number;
  lastSortAt: number;
  lastAssetId: string;
  filterHash: string;
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.trunc(parsed))) : fallback;
}

function clean(value: unknown, limit: number): string | undefined {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized ? normalized.slice(0, limit) : undefined;
}

function strings(values: readonly unknown[] | undefined, max: number, limit: number): string[] {
  return [...new Set((values ?? [])
    .map((value) => clean(value, limit))
    .filter((value): value is string => Boolean(value)))]
    .slice(0, max);
}

function epoch(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.round(value);
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.round(parsed);
  }
  return fallback;
}

function iso(value: number): string {
  return new Date(Math.max(0, Math.round(value))).toISOString();
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, stable(item)]));
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function boundedScope(scope: SubjectAssetScope | undefined): SubjectAssetScope {
  return {
    tenantId: clean(scope?.tenantId, 160),
    environmentId: clean(scope?.environmentId, 120),
    workspaceId: clean(scope?.workspaceId, 180),
    workspacePath: clean(scope?.workspacePath, 500),
    clusterId: clean(scope?.clusterId, 240),
    namespace: clean(scope?.namespace, 160),
    ownerKind: clean(scope?.ownerKind, 120),
    ownerName: clean(scope?.ownerName, 240),
    containerName: clean(scope?.containerName, 240),
    hostGroup: clean(scope?.hostGroup, 240),
    hostId: clean(scope?.hostId, 240),
    systemdUnit: clean(scope?.systemdUnit, 240),
  };
}

function emptyRuntimeSummary(): ObservedAssetRuntimeSummary {
  return { total: 0, starting: 0, current: 0, idle: 0, exited: 0, lost: 0, unknown: 0 };
}

function defaultObservation(type: SubjectAssetType): ObservationState {
  if (type === 'agent') return 'full';
  if (type === 'service' || type === 'infrastructure') return 'aggregate';
  return 'sample';
}

function captureProfileFor(type: SubjectAssetType, identity: ObservedAgentIdentity, role: ObservedWorkloadRole): string {
  if (identity === 'confirmed_agent') return 'agent_full';
  if (identity === 'probable_agent') return 'probable_investigation';
  if (role === 'anysentry_internal') return 'self_health';
  if (role === 'platform_infrastructure') return 'infrastructure_aggregate';
  if (role === 'business_service') return 'business_context';
  return type === 'ephemeral_process' ? 'unknown_discovery' : 'unknown_discovery';
}

function logicalKey(scope: SubjectAssetScope, value: string): string {
  return JSON.stringify(stable({ scope, value }));
}

export function stableSubjectAssetId(
  type: SubjectAssetType,
  scope: SubjectAssetScope,
  logicalIdentity: string,
): string {
  const prefix: Record<SubjectAssetType, string> = {
    agent: 'asset_agent',
    service: 'asset_service',
    infrastructure: 'asset_infra',
    workload: 'asset_workload',
    ephemeral_process: 'asset_process',
  };
  return `${prefix[type]}_${digest({ type, scope: boundedScope(scope), logicalIdentity }).slice(0, 24)}`;
}

function eventKinds(input: Record<string, number> | undefined): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [kind, rawCount] of Object.entries(input ?? {}).slice(0, 32)) {
    const key = clean(kind, 120);
    const count = boundedInteger(rawCount, 0, 0, Number.MAX_SAFE_INTEGER);
    if (key && count > 0) result[key] = count;
  }
  return result;
}

function zeroRecord<T extends string>(keys: readonly T[]): Record<T, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<T, number>;
}

function compareAsset(left: ObservedAssetDto, right: ObservedAssetDto): number {
  return left.subjectAssetId.localeCompare(right.subjectAssetId);
}

function sortAt(_asset: ObservedAssetDto): number {
  return 0;
}

function coverageKey(assetId: string, runtimeId?: string): string {
  return `${assetId}\0${runtimeId ?? ''}`;
}

function k8sPhysicalPrefix(value: string): string | undefined {
  const parts = value.split(':');
  return parts[0] === 'k8s' && parts.length >= 3
    ? parts.slice(0, 3).join(':')
    : undefined;
}

function relatedPhysicalWorkload(left: string, right: string): boolean {
  if (left === right) return true;
  const leftPrefix = k8sPhysicalPrefix(left);
  const rightPrefix = k8sPhysicalPrefix(right);
  return Boolean(leftPrefix && rightPrefix && leftPrefix === rightPrefix);
}

function bindingSemantic(input: ObservedAssetBindingInput): unknown {
  return {
    subjectAssetId: input.subjectAssetId,
    runtimeInstanceId: input.runtimeInstanceId,
    quality: input.quality,
    physicalWorkloadId: input.physicalWorkloadId,
    processInstanceKey: input.processInstanceKey,
    podUid: input.podUid,
    containerId: input.containerId,
    cgroupId: input.cgroupId,
    inventoryGeneration: input.inventoryGeneration,
    nodeId: input.nodeId,
    source: input.source,
    reasonCode: input.reasonCode ?? 'asset_binding',
  };
}

function coverageSemantic(input: ObservationCoverageTransitionInput, asset: ObservedAssetDto): unknown {
  return {
    subjectAssetId: input.subjectAssetId,
    runtimeInstanceId: input.runtimeInstanceId,
    identityRevision: asset.identity.revision,
    assetBindingRevision: asset.bindingRevision,
    captureProfile: input.captureProfile,
    signalCoverage: input.signalCoverage,
    completeness: input.completeness,
    observationState: input.observationState,
    reasonCode: input.reasonCode,
    ruleRefs: strings(input.ruleRefs, 32, 240).sort(),
  };
}

export class ObservedAssetCoreError extends Error {
  constructor(
    readonly code: 'not_found' | 'invalid_input' | 'invalid_cursor' | 'cursor_expired' | 'capacity_exceeded',
    message: string,
  ) {
    super(message);
  }
}

export interface ObservedAssetLifecycleStateDocument {
  schemaVersion: 'anysentry.observed_asset_lifecycle_state.v1';
  modelRevision: number;
  bindingRevision: number;
  cursorFloorRevision: number;
  unassignedEvents: number;
  updatedAt: number;
  assets: ObservedAssetDto[];
  runtimes: ObservedRuntimeDto[];
  bindings: ObservedAssetBindingDto[];
  lifecycleFacts: AssetLifecycleFactDto[];
  coverageIntervals: ObservationCoverageIntervalDto[];
  truncated: boolean;
}

/**
 * Pure Phase-B core for the unified asset read model.
 *
 * The class deliberately has no Nest/controller/storage dependencies. Existing Agent inventory,
 * K8s Service inventory, structural lifecycle facts, and event batches can be projected into it;
 * later wiring can persist the same DTOs without changing their state semantics.
 */
export class ObservedAssetLifecycleCore {
  private readonly clock: () => number;
  private readonly maxAssets: number;
  private readonly maxEphemeralAssets: number;
  private readonly maxVersionsPerAsset: number;
  private readonly maxFactsPerAsset: number;
  private readonly maxCoverageIntervalsPerScope: number;
  private readonly maxBindingsPerAsset: number;
  private readonly maxRuntimesPerAsset: number;

  private readonly assets = new Map<string, ObservedAssetDto>();
  private readonly assetVersions = new Map<string, AssetVersion[]>();
  private readonly createdRevision = new Map<string, number>();
  private readonly runtimes = new Map<string, ObservedRuntimeDto>();
  private readonly runtimeKeysByAsset = new Map<string, Set<string>>();
  private readonly bindings = new Map<string, ObservedAssetBindingDto[]>();
  private readonly lifecycleFacts = new Map<string, AssetLifecycleFactDto[]>();
  private readonly factDedupe = new Map<string, string>();
  private readonly factRevisions = new Map<string, number>();
  private readonly coverageIntervals = new Map<string, ObservationCoverageIntervalDto[]>();
  private readonly coverageKeysByAsset = new Map<string, Set<string>>();
  private readonly physicalBindingIndex = new Map<string, Array<{
    assetId: string;
    bindingRevision: number;
    quality: AssetBindingQuality;
  }>>();
  private readonly processBindingIndex = new Map<string, { assetId: string; bindingRevision: number; quality: AssetBindingQuality }>();
  private readonly assetsWithEventSummary = new Set<string>();
  private readonly evictionGeneration = new Map<string, number>();
  private evictionHeap: AssetEvictionCandidate[] = [];
  private evictionSequence = 0;
  private ephemeralAssetCount = 0;

  private modelRevision = 0;
  private durableStateRevision = 0;
  private globalBindingRevision = 0;
  private telemetryRevision = 0;
  private cursorFloorRevision = 0;
  private unassignedEvents = 0;
  private updatedAt = 0;
  private summaryCache?: {
    snapshotRevision: number;
    telemetryRevision: number;
    value: ObservedAssetSummaryDto;
  };

  constructor(options: ObservedAssetCoreOptions = {}) {
    this.clock = options.now ?? Date.now;
    this.maxAssets = boundedInteger(options.maxAssets, DEFAULT_MAX_ASSETS, 1, 1_000_000);
    this.maxEphemeralAssets = boundedInteger(
      options.maxEphemeralAssets,
      Math.max(1, Math.floor(this.maxAssets * 0.8)),
      1,
      this.maxAssets,
    );
    this.maxVersionsPerAsset = boundedInteger(options.maxVersionsPerAsset, DEFAULT_MAX_VERSIONS, 2, 1_024);
    this.maxFactsPerAsset = boundedInteger(options.maxFactsPerAsset, DEFAULT_MAX_FACTS, 8, 10_000);
    this.maxCoverageIntervalsPerScope = boundedInteger(options.maxCoverageIntervalsPerScope, DEFAULT_MAX_COVERAGE, 4, 10_000);
    this.maxBindingsPerAsset = boundedInteger(options.maxBindingsPerAsset, DEFAULT_MAX_BINDINGS, 2, 10_000);
    this.maxRuntimesPerAsset = boundedInteger(options.maxRuntimesPerAsset, DEFAULT_MAX_RUNTIMES, 1, 10_000);
  }

  revision(): number {
    return this.modelRevision;
  }

  bindingRevision(): number {
    return this.globalBindingRevision;
  }

  /**
   * Revision of the low-frequency logical state persisted outside ClickHouse. Ephemeral Process
   * churn deliberately does not advance it; exact Process lifecycle truth remains in ClickHouse.
   */
  persistentRevision(): number {
    return this.durableStateRevision;
  }

  stateDocument(
    maxAssets = 5_000,
    options: { includeEphemeral?: boolean } = {},
  ): ObservedAssetLifecycleStateDocument {
    const persistableAssets = [...this.assets.values()]
      .filter((asset) => options.includeEphemeral === true || !this.isTransientReadAsset(asset));
    const assets = persistableAssets
      .sort(compareAsset)
      .slice(0, Math.max(1, Math.min(this.maxAssets, maxAssets)));
    const assetIds = new Set(assets.map((asset) => asset.subjectAssetId));
    return {
      schemaVersion: 'anysentry.observed_asset_lifecycle_state.v1',
      modelRevision: this.modelRevision,
      bindingRevision: this.globalBindingRevision,
      cursorFloorRevision: this.cursorFloorRevision,
      unassignedEvents: this.unassignedEvents,
      updatedAt: this.updatedAt,
      assets: clone(assets),
      runtimes: clone([...this.runtimes.values()].filter((runtime) => assetIds.has(runtime.subjectAssetId))),
      bindings: clone([...this.bindings.values()].flat().filter((binding) => assetIds.has(binding.subjectAssetId))),
      lifecycleFacts: clone([...this.lifecycleFacts.values()].flat().filter((fact) => assetIds.has(fact.subjectAssetId))),
      coverageIntervals: clone([...this.coverageIntervals.values()].flat().filter((interval) => assetIds.has(interval.subjectAssetId))),
      // Ephemeral Process assets are intentionally absent from the default durable mirror. They
      // must not make the logical-asset snapshot look truncated.
      truncated: persistableAssets.length > assets.length,
    };
  }

  restoreState(document: ObservedAssetLifecycleStateDocument): boolean {
    if (document?.schemaVersion !== 'anysentry.observed_asset_lifecycle_state.v1' || !Array.isArray(document.assets)) {
      return false;
    }
    this.assets.clear();
    this.assetVersions.clear();
    this.createdRevision.clear();
    this.runtimes.clear();
    this.runtimeKeysByAsset.clear();
    this.bindings.clear();
    this.lifecycleFacts.clear();
    this.factDedupe.clear();
    this.factRevisions.clear();
    this.coverageIntervals.clear();
    this.coverageKeysByAsset.clear();
    this.physicalBindingIndex.clear();
    this.processBindingIndex.clear();
    this.assetsWithEventSummary.clear();
    this.evictionGeneration.clear();
    this.evictionHeap = [];
    this.evictionSequence = 0;
    this.ephemeralAssetCount = 0;
    for (const asset of document.assets.slice(0, this.maxAssets)) {
      if (!asset?.subjectAssetId || asset.schemaVersion !== OBSERVED_ASSET_SCHEMA) continue;
      const restored = clone(asset);
      this.assets.set(restored.subjectAssetId, restored);
      if (restored.subjectAssetType === 'ephemeral_process') this.ephemeralAssetCount += 1;
      this.assetVersions.set(restored.subjectAssetId, [{ revision: restored.modelRevision, asset: clone(restored) }]);
      this.createdRevision.set(restored.subjectAssetId, restored.modelRevision);
      if (restored.eventSummary.eventCount > 0 || restored.lastActivityAt) {
        this.assetsWithEventSummary.add(restored.subjectAssetId);
      }
    }
    for (const runtime of (document.runtimes ?? []).slice(0, this.maxAssets * this.maxRuntimesPerAsset)) {
      if (!this.assets.has(runtime.subjectAssetId)) continue;
      const key = `${runtime.subjectAssetId}\0${runtime.runtimeInstanceId}`;
      this.runtimes.set(key, clone(runtime));
      const keys = this.runtimeKeysByAsset.get(runtime.subjectAssetId) ?? new Set<string>();
      keys.add(key);
      this.runtimeKeysByAsset.set(runtime.subjectAssetId, keys);
    }
    for (const binding of (document.bindings ?? []).slice(0, this.maxAssets * this.maxBindingsPerAsset)) {
      if (!this.assets.has(binding.subjectAssetId)) continue;
      const list = this.bindings.get(binding.subjectAssetId) ?? [];
      list.push(clone(binding));
      this.bindings.set(binding.subjectAssetId, list);
      if (!binding.validTo && binding.physicalWorkloadId) {
        const indexed = this.physicalBindingIndex.get(binding.physicalWorkloadId) ?? [];
        indexed.push({ assetId: binding.subjectAssetId, bindingRevision: binding.revision, quality: binding.quality });
        this.physicalBindingIndex.set(binding.physicalWorkloadId, indexed);
      }
      if (!binding.validTo && binding.processInstanceKey) {
        this.processBindingIndex.set(binding.processInstanceKey, {
          assetId: binding.subjectAssetId, bindingRevision: binding.revision, quality: binding.quality,
        });
      }
    }
    for (const fact of (document.lifecycleFacts ?? []).slice(0, this.maxAssets * this.maxFactsPerAsset)) {
      if (!this.assets.has(fact.subjectAssetId)) continue;
      const list = this.lifecycleFacts.get(fact.subjectAssetId) ?? [];
      list.push(clone(fact));
      this.lifecycleFacts.set(fact.subjectAssetId, list);
      this.factDedupe.set(`${fact.subjectAssetId}\0${fact.dedupeKey}`, fact.factId);
      this.factRevisions.set(fact.subjectAssetId, Math.max(this.factRevisions.get(fact.subjectAssetId) ?? 0, fact.revision));
    }
    for (const interval of (document.coverageIntervals ?? []).slice(0, this.maxAssets * this.maxCoverageIntervalsPerScope)) {
      if (!this.assets.has(interval.subjectAssetId)) continue;
      const key = coverageKey(interval.subjectAssetId, interval.runtimeInstanceId);
      const list = this.coverageIntervals.get(key) ?? [];
      list.push(clone(interval));
      this.coverageIntervals.set(key, list);
      const keys = this.coverageKeysByAsset.get(interval.subjectAssetId) ?? new Set<string>();
      keys.add(key);
      this.coverageKeysByAsset.set(interval.subjectAssetId, keys);
    }
    this.modelRevision = Math.max(Number(document.modelRevision) || 0, ...[...this.assets.values()].map((asset) => asset.modelRevision));
    this.durableStateRevision = this.modelRevision;
    this.globalBindingRevision = Math.max(Number(document.bindingRevision) || 0, 0);
    this.cursorFloorRevision = Math.max(Number(document.cursorFloorRevision) || 0, this.modelRevision);
    this.unassignedEvents = Math.max(0, Number(document.unassignedEvents) || 0);
    this.updatedAt = Math.max(0, Number(document.updatedAt) || 0);
    this.rebuildEvictionHeap();
    return true;
  }

  upsertAsset(input: ObservedAssetUpsertInput): ObservedAssetDto {
    const now = this.clock();
    const observedAt = epoch(input.observedAt, now);
    const firstSeenAt = epoch(input.firstSeenAt, observedAt);
    const scope = boundedScope(input.scope);
    const identityKey = clean(input.logicalIdentity, 1_000);
    if (!identityKey) throw new ObservedAssetCoreError('invalid_input', 'logicalIdentity is required');
    const subjectAssetId = clean(input.subjectAssetId, 240)
      ?? stableSubjectAssetId(input.subjectAssetType, scope, identityKey);
    const displayName = clean(input.displayName, 240);
    const source = clean(input.source, 160);
    if (!displayName || !source) throw new ObservedAssetCoreError('invalid_input', 'displayName and source are required');

    const previous = this.assets.get(subjectAssetId);
    if (!previous) this.ensureAssetCapacity(input.subjectAssetType);
    const requestedIdentity = input.identity ?? previous?.identity.classification ?? 'unknown';
    const identitySource = clean(input.identitySource, 160) ?? source;
    const identityEffectiveAt = epoch(input.identityEffectiveAt, observedAt);
    const identityChanged = Boolean(previous && (
      previous.identity.classification !== requestedIdentity || previous.identity.source !== identitySource
    ));
    const requestedRole = input.role ?? previous?.role.role ?? 'unknown';
    const roleSource = clean(input.roleSource, 160) ?? source;
    const roleEffectiveAt = epoch(input.roleEffectiveAt, observedAt);
    const roleChanged = Boolean(previous && (
      previous.role.role !== requestedRole || previous.role.source !== roleSource
    ));
    const inventoryObserved = input.inventoryObserved !== false;
    const existence = input.existenceState ?? previous?.existenceState ?? 'active';
    const next: ObservedAssetDto = {
      schemaVersion: OBSERVED_ASSET_SCHEMA,
      subjectAssetId,
      subjectAssetType: input.subjectAssetType,
      canonicalIdentityVersion: 'observed_asset.v1',
      displayName,
      aliases: strings([...(previous?.aliases ?? []), ...(input.aliases ?? [])], 32, 240)
        .filter((alias) => alias !== subjectAssetId),
      logicalIdentityHash: previous?.logicalIdentityHash ?? digest(logicalKey(scope, identityKey)).slice(0, 32),
      scope: { ...(previous?.scope ?? {}), ...scope },
      existenceState: existence,
      identity: {
        classification: requestedIdentity,
        revision: previous ? previous.identity.revision + Number(identityChanged) : 1,
        source: identitySource,
        effectiveAt: identityChanged || !previous ? iso(identityEffectiveAt) : previous.identity.effectiveAt,
      },
      role: {
        role: requestedRole,
        revision: previous ? previous.role.revision + Number(roleChanged) : 1,
        source: roleSource,
        effectiveAt: roleChanged || !previous ? iso(roleEffectiveAt) : previous.role.effectiveAt,
      },
      bindingQuality: previous?.bindingQuality ?? 'unassigned',
      bindingRevision: previous?.bindingRevision ?? 0,
      observationState: input.observationState ?? previous?.observationState ?? defaultObservation(input.subjectAssetType),
      captureProfile: clean(input.captureProfile, 120)
        ?? previous?.captureProfile
        ?? captureProfileFor(input.subjectAssetType, requestedIdentity, requestedRole),
      runtimeSummary: previous?.runtimeSummary ?? emptyRuntimeSummary(),
      eventSummary: previous?.eventSummary ?? { eventCount: 0, eventKindCounts: {} },
      firstSeenAt: previous?.firstSeenAt ?? iso(firstSeenAt),
      lastInventoryAt: inventoryObserved ? iso(observedAt) : previous?.lastInventoryAt,
      lastActivityAt: previous?.lastActivityAt,
      inactiveAt: existence === 'inactive' ? previous?.inactiveAt ?? iso(observedAt) : undefined,
      retiredAt: existence === 'retired' ? previous?.retiredAt ?? iso(observedAt) : undefined,
      sources: strings([...(previous?.sources ?? []), source], 16, 160),
      evidenceRefs: strings([...(previous?.evidenceRefs ?? []), ...(input.evidenceRefs ?? [])], 32, 500),
      modelRevision: previous?.modelRevision ?? 0,
      updatedAt: previous?.updatedAt ?? iso(observedAt),
    };
    return this.writeAsset(next, observedAt);
  }

  reconcileAgentAssets(items: ExistingAgentAssetProjection[]): ObservedAssetDto[] {
    const result: ObservedAssetDto[] = [];
    for (const item of items) {
      const lastAt = epoch(item.lastSeen, this.clock());
      const firstAt = epoch(item.firstSeen, lastAt);
      const asset = this.upsertAsset({
        subjectAssetId: item.agentAssetId,
        subjectAssetType: 'agent',
        logicalIdentity: item.agentAssetId,
        displayName: item.displayName ?? item.detectedName ?? item.agentId,
        aliases: item.agentAssetAliases,
        scope: { workspacePath: item.workspacePath },
        existenceState: item.lifecycleState === 'terminated' ? 'inactive' : 'active',
        identity: item.classification,
        identitySource: item.attributionSource ?? 'existing_agent_inventory',
        role: 'agent',
        roleSource: 'existing_agent_inventory',
        source: 'existing_agent_inventory',
        evidenceRefs: item.attributionEvidence,
        observedAt: lastAt,
        firstSeenAt: firstAt,
        inventoryObserved: false,
        observationState: item.classification === 'confirmed_agent' ? 'full' : 'sample',
      });
      this.setEventAggregate(asset.subjectAssetId, {
        count: boundedInteger(item.eventCount, 0, 0, Number.MAX_SAFE_INTEGER),
        at: lastAt,
        kinds: eventKinds(item.eventCategoryCounts),
      });
      if (item.agentInstanceId) {
        this.upsertRuntime({
          runtimeInstanceId: item.agentInstanceId,
          subjectAssetId: asset.subjectAssetId,
          placement: item.runtime === 'unknown' ? 'unknown' : item.runtime,
          state: item.lifecycleState === 'terminated' ? 'exited' : item.lifecycleState === 'current' ? 'current' : 'unknown',
          physicalWorkloadId: item.physicalWorkloadId,
          processInstanceKey: item.processInstanceKey,
          startedAt: firstAt,
          observedAt: lastAt,
          endedAt: item.lifecycleState === 'terminated' ? lastAt : undefined,
          source: 'existing_agent_inventory',
          reasonCode: item.lifecycleState === 'terminated' ? 'observed_root_exit' : 'agent_inventory_projection',
          evidenceRefs: item.attributionEvidence,
        });
      }
      if (item.physicalWorkloadId || item.processInstanceKey) {
        this.upsertBinding({
          subjectAssetId: asset.subjectAssetId,
          runtimeInstanceId: item.agentInstanceId,
          quality: item.physicalWorkloadId ? 'exact' : 'ephemeral',
          physicalWorkloadId: item.physicalWorkloadId,
          processInstanceKey: item.processInstanceKey,
          source: 'existing_agent_inventory',
          reasonCode: item.physicalWorkloadId ? 'exact_physical_workload' : 'exact_process_generation',
          effectiveAt: firstAt,
          evidenceRefs: item.attributionEvidence,
        });
      }
      result.push(this.requireAsset(asset.subjectAssetId));
    }
    return result;
  }

  reconcileKubeServices(items: ExistingKubeServiceProjection[]): ObservedAssetDto[] {
    const result: ObservedAssetDto[] = [];
    for (const item of items) {
      const observedAt = epoch(item.observedAt, this.clock());
      const logicalIdentity = [item.clusterId, item.namespace, item.ownerKind ?? item.kind ?? 'service', item.ownerName ?? item.name]
        .join(':');
      const asset = this.upsertAsset({
        subjectAssetId: item.serviceAssetId,
        subjectAssetType: 'service',
        logicalIdentity,
        displayName: item.name,
        scope: {
          clusterId: item.clusterId,
          namespace: item.namespace,
          ownerKind: item.ownerKind,
          ownerName: item.ownerName,
        },
        existenceState: 'active',
        identity: item.identity ?? 'unknown',
        identitySource: item.identitySource ?? 'kubernetes_inventory',
        identityEffectiveAt: item.identityEffectiveAt,
        role: item.role,
        roleSource: 'kubernetes_inventory',
        source: 'kubernetes_inventory',
        evidenceRefs: [
          item.revision ? `kubernetes:revision=${item.revision}` : undefined,
          item.ownerKind && item.ownerName ? `kubernetes:owner=${item.ownerKind}/${item.ownerName}` : undefined,
        ].filter((value): value is string => Boolean(value)),
        observedAt,
        inventoryObserved: true,
        observationState: 'aggregate',
        captureProfile: item.role === 'anysentry_internal' ? 'self_health'
          : item.role === 'business_service' ? 'business_context' : 'infrastructure_aggregate',
      });
      for (const runtimeInstanceId of strings(item.runtimeInstanceIds, this.maxRuntimesPerAsset, 500)) {
        this.upsertRuntime({
          runtimeInstanceId,
          subjectAssetId: asset.subjectAssetId,
          placement: 'kubernetes',
          state: 'current',
          observedAt,
          source: 'kubernetes_inventory',
          reasonCode: 'kubernetes_runtime_present',
        });
      }
      for (const physicalWorkloadId of strings(item.physicalWorkloadIds, this.maxBindingsPerAsset, 500)) {
        this.upsertBinding({
          subjectAssetId: asset.subjectAssetId,
          quality: 'exact',
          physicalWorkloadId,
          source: 'kubernetes_inventory',
          reasonCode: 'kubernetes_physical_workload',
          effectiveAt: observedAt,
        });
      }
      this.reconcileRuntimePresence(
        asset.subjectAssetId,
        strings(item.runtimeInstanceIds, this.maxRuntimesPerAsset, 500),
        'kubernetes',
        observedAt,
        'kubernetes_inventory',
      );
      result.push(this.requireAsset(asset.subjectAssetId));
    }
    return result;
  }

  reconcileRuntimePresence(
    subjectAssetId: string,
    currentRuntimeIds: string[],
    placement: ObservedRuntimeDto['placement'],
    observedAt: number,
    source: string,
  ): void {
    const current = new Set(currentRuntimeIds);
    for (const runtime of this.runtimesForAsset(subjectAssetId)) {
      if (
        runtime.placement !== placement
        || current.has(runtime.runtimeInstanceId)
        || runtime.state === 'exited'
        || runtime.state === 'lost'
      ) continue;
      this.applyLifecycleFact({
        factKind: 'runtime_lost',
        subjectAssetId,
        runtimeInstanceId: runtime.runtimeInstanceId,
        effectiveAt: observedAt,
        observedAt,
        source,
        reasonCode: 'inventory_generation_superseded',
        previousState: runtime.state,
        nextState: 'lost',
        dedupeKey: `runtime-presence:${source}:${runtime.runtimeInstanceId}:lost`,
      });
    }
  }

  upsertRuntime(input: ObservedRuntimeUpsertInput): ObservedRuntimeDto {
    this.requireAsset(input.subjectAssetId);
    const runtimeId = clean(input.runtimeInstanceId, 500);
    const source = clean(input.source, 160);
    if (!runtimeId || !source) throw new ObservedAssetCoreError('invalid_input', 'runtimeInstanceId and source are required');
    const now = this.clock();
    const observedAt = epoch(input.observedAt, now);
    const key = `${input.subjectAssetId}\0${runtimeId}`;
    const previous = this.runtimes.get(key);
    const incomingTerminal = input.state === 'exited' || input.state === 'lost';
    const previousExited = previous?.state === 'exited';
    const previousLost = previous?.state === 'lost';
    if (previous && previousExited && !incomingTerminal) {
      // One Runtime ID is one immutable generation. Inventory replay cannot resurrect a generation
      // already ended by an exact Exit fact; a restart must use a new runtimeInstanceId.
      return clone(previous);
    }
    if (
      previous
      && previousLost
      && !incomingTerminal
      && observedAt <= Date.parse(previous.lastInventoryAt)
    ) return clone(previous);
    if (previous && incomingTerminal) {
      const endedAt = epoch(input.endedAt, observedAt);
      if (endedAt < Date.parse(previous.lastInventoryAt)) return clone(previous);
    }
    if (!previous && (this.runtimeKeysByAsset.get(input.subjectAssetId)?.size ?? 0) >= this.maxRuntimesPerAsset) {
      throw new ObservedAssetCoreError('capacity_exceeded', 'runtime capacity exceeded for asset');
    }
    const stateChanged = Boolean(previous && previous.state !== input.state);
    const next: ObservedRuntimeDto = {
      runtimeInstanceId: runtimeId,
      subjectAssetId: input.subjectAssetId,
      placement: input.placement ?? previous?.placement ?? 'unknown',
      state: input.state,
      physicalWorkloadId: clean(input.physicalWorkloadId, 500) ?? previous?.physicalWorkloadId,
      processInstanceKey: clean(input.processInstanceKey, 500) ?? previous?.processInstanceKey,
      podUid: clean(input.podUid, 240) ?? previous?.podUid,
      containerId: clean(input.containerId, 240) ?? previous?.containerId,
      cgroupId: clean(input.cgroupId, 40) ?? previous?.cgroupId,
      inventoryGeneration: Number.isSafeInteger(input.inventoryGeneration) && Number(input.inventoryGeneration) >= 0
        ? Number(input.inventoryGeneration) : previous?.inventoryGeneration,
      nodeId: clean(input.nodeId, 240) ?? previous?.nodeId,
      startedAt: previous?.startedAt ?? iso(epoch(input.startedAt, observedAt)),
      lastInventoryAt: iso(observedAt),
      endedAt: input.state === 'exited' || input.state === 'lost'
        ? iso(epoch(input.endedAt, observedAt)) : undefined,
      source,
      reasonCode: clean(input.reasonCode, 160) ?? 'runtime_inventory',
      evidenceRefs: strings([...(previous?.evidenceRefs ?? []), ...(input.evidenceRefs ?? [])], 32, 500),
      revision: previous?.revision ?? 1,
      updatedAt: iso(observedAt),
    };
    const semanticChanged = !previous || this.runtimeSemanticHash(previous) !== this.runtimeSemanticHash(next);
    next.revision = previous ? previous.revision + Number(semanticChanged) : 1;
    this.runtimes.set(key, next);
    const runtimeKeys = this.runtimeKeysByAsset.get(input.subjectAssetId) ?? new Set<string>();
    runtimeKeys.add(key);
    this.runtimeKeysByAsset.set(input.subjectAssetId, runtimeKeys);
    if (previous && !semanticChanged) return clone(next);
    if (stateChanged && (input.state === 'exited' || input.state === 'lost')) {
      this.closeBindingsForRuntime(input.subjectAssetId, runtimeId, observedAt, source);
    }
    if (!previous || stateChanged) {
      const kind: AssetLifecycleFactKind = input.state === 'exited' ? 'runtime_exited'
        : input.state === 'lost' ? 'runtime_lost'
          : input.state === 'idle' ? 'runtime_became_idle' : 'runtime_started';
      this.appendFact({
        factKind: kind,
        subjectAssetId: input.subjectAssetId,
        runtimeInstanceId: runtimeId,
        effectiveAt: input.state === 'exited' || input.state === 'lost' ? epoch(input.endedAt, observedAt) : epoch(input.startedAt, observedAt),
        observedAt,
        source,
        reasonCode: next.reasonCode,
        previousState: previous?.state,
        nextState: input.state,
        evidenceRefs: input.evidenceRefs,
        dedupeKey: `runtime:${runtimeId}:${next.revision}:${input.state}`,
      });
    }
    this.refreshRuntimeSummary(input.subjectAssetId, observedAt);
    return clone(next);
  }

  upsertBinding(input: ObservedAssetBindingInput): ObservedAssetBindingDto {
    const asset = this.requireAsset(input.subjectAssetId);
    const source = clean(input.source, 160);
    if (!source) throw new ObservedAssetCoreError('invalid_input', 'binding source is required');
    const at = epoch(input.effectiveAt, this.clock());
    const current = (this.bindings.get(input.subjectAssetId) ?? []).filter((binding) => !binding.validTo);
    const signature = digest(bindingSemantic(input));
    const same = current.find((binding) => digest(bindingSemantic({ ...binding, source: binding.source })) === signature);
    if (same) return clone(same);
    if ((this.bindings.get(input.subjectAssetId) ?? []).length >= this.maxBindingsPerAsset) {
      this.trimClosedBindings(input.subjectAssetId);
    }
    if ((this.bindings.get(input.subjectAssetId) ?? []).length >= this.maxBindingsPerAsset) {
      throw new ObservedAssetCoreError('capacity_exceeded', 'binding capacity exceeded for asset');
    }

    const nextRevision = asset.bindingRevision + 1;
    this.globalBindingRevision += 1;
    const closes = current.filter((binding) =>
      (input.runtimeInstanceId && binding.runtimeInstanceId === input.runtimeInstanceId)
      || (input.physicalWorkloadId && binding.physicalWorkloadId === input.physicalWorkloadId)
      || (input.processInstanceKey && binding.processInstanceKey === input.processInstanceKey));
    const all = this.bindings.get(input.subjectAssetId) ?? [];
    for (const binding of closes) {
      binding.validTo = iso(at);
      if (binding.physicalWorkloadId) {
        const remaining = (this.physicalBindingIndex.get(binding.physicalWorkloadId) ?? [])
          .filter((indexed) => indexed.assetId !== input.subjectAssetId);
        if (remaining.length) this.physicalBindingIndex.set(binding.physicalWorkloadId, remaining);
        else this.physicalBindingIndex.delete(binding.physicalWorkloadId);
      }
      if (binding.processInstanceKey) this.processBindingIndex.delete(binding.processInstanceKey);
    }
    const binding: ObservedAssetBindingDto = {
      bindingId: `binding_${digest([input.subjectAssetId, nextRevision, signature]).slice(0, 24)}`,
      subjectAssetId: input.subjectAssetId,
      runtimeInstanceId: clean(input.runtimeInstanceId, 500),
      quality: input.quality,
      revision: nextRevision,
      physicalWorkloadId: clean(input.physicalWorkloadId, 500),
      processInstanceKey: clean(input.processInstanceKey, 500),
      podUid: clean(input.podUid, 240),
      containerId: clean(input.containerId, 240),
      cgroupId: clean(input.cgroupId, 40),
      inventoryGeneration: Number.isSafeInteger(input.inventoryGeneration) && Number(input.inventoryGeneration) >= 0
        ? Number(input.inventoryGeneration) : undefined,
      nodeId: clean(input.nodeId, 240),
      source,
      reasonCode: clean(input.reasonCode, 160) ?? 'asset_binding',
      validFrom: iso(at),
      evidenceRefs: strings(input.evidenceRefs, 32, 500),
    };
    all.push(binding);
    this.bindings.set(input.subjectAssetId, all);
    if (binding.physicalWorkloadId) {
      const indexed = (this.physicalBindingIndex.get(binding.physicalWorkloadId) ?? [])
        .filter((candidate) => candidate.assetId !== input.subjectAssetId);
      indexed.push({ assetId: input.subjectAssetId, bindingRevision: nextRevision, quality: binding.quality });
      this.physicalBindingIndex.set(binding.physicalWorkloadId, indexed);
    }
    if (binding.processInstanceKey) {
      this.processBindingIndex.set(binding.processInstanceKey, {
        assetId: input.subjectAssetId, bindingRevision: nextRevision, quality: binding.quality,
      });
    }
    this.writeAsset({
      ...asset,
      bindingQuality: binding.quality,
      bindingRevision: nextRevision,
    }, at);
    this.appendFact({
      factKind: 'asset_binding_changed',
      subjectAssetId: input.subjectAssetId,
      runtimeInstanceId: binding.runtimeInstanceId,
      effectiveAt: at,
      observedAt: at,
      source,
      reasonCode: binding.reasonCode,
      previousState: closes.map((item) => item.bindingId).join(',') || undefined,
      nextState: binding.bindingId,
      evidenceRefs: binding.evidenceRefs,
      dedupeKey: `binding:${binding.bindingId}`,
    });
    return clone(binding);
  }

  applyLifecycleFact(input: StructuralLifecycleFactInput): AssetLifecycleFactDto {
    const asset = this.requireAsset(input.subjectAssetId);
    const at = epoch(input.effectiveAt, this.clock());
    const observedAt = epoch(input.observedAt, this.clock());
    let nextAsset = asset;
    if (input.factKind === 'asset_discovered' || input.factKind === 'asset_activated') {
      nextAsset = this.writeAsset({ ...asset, existenceState: input.factKind === 'asset_discovered' ? 'discovered' : 'active', inactiveAt: undefined, retiredAt: undefined }, observedAt);
    } else if (input.factKind === 'asset_inactivated') {
      nextAsset = this.writeAsset({ ...asset, existenceState: 'inactive', inactiveAt: iso(at) }, observedAt);
    } else if (input.factKind === 'asset_retired') {
      nextAsset = this.writeAsset({ ...asset, existenceState: 'retired', retiredAt: iso(at) }, observedAt);
    } else if (input.factKind === 'identity_decision_changed' && input.nextIdentity) {
      nextAsset = this.writeAsset({
        ...asset,
        identity: {
          classification: input.nextIdentity,
          revision: asset.identity.revision + Number(asset.identity.classification !== input.nextIdentity),
          source: clean(input.source, 160) ?? 'lifecycle',
          effectiveAt: iso(at),
        },
      }, observedAt);
    }
    if (input.runtimeInstanceId && ['runtime_started', 'runtime_became_idle', 'runtime_exited', 'runtime_lost'].includes(input.factKind)) {
      const existing = this.runtimes.get(`${input.subjectAssetId}\0${input.runtimeInstanceId}`);
      if (existing) {
        const state: ObservedRuntimeState = input.factKind === 'runtime_started' ? 'current'
          : input.factKind === 'runtime_became_idle' ? 'idle'
            : input.factKind === 'runtime_exited' ? 'exited' : 'lost';
        const nextRuntime: ObservedRuntimeDto = {
          ...existing,
          state,
          lastInventoryAt: iso(observedAt),
          endedAt: state === 'exited' || state === 'lost' ? iso(at) : undefined,
          source: clean(input.source, 160) ?? existing.source,
          reasonCode: clean(input.reasonCode, 160) ?? existing.reasonCode,
          evidenceRefs: strings([...(existing.evidenceRefs ?? []), ...(input.evidenceRefs ?? [])], 32, 500),
          revision: existing.revision + Number(existing.state !== state),
          updatedAt: iso(observedAt),
        };
        this.runtimes.set(`${input.subjectAssetId}\0${input.runtimeInstanceId}`, nextRuntime);
        if (state === 'exited' || state === 'lost') {
          this.closeBindingsForRuntime(input.subjectAssetId, input.runtimeInstanceId, observedAt, input.source);
        }
        this.refreshRuntimeSummary(input.subjectAssetId, observedAt);
      }
    }
    const finalAsset = this.requireAsset(input.subjectAssetId);
    return this.appendFact({
      ...input,
      effectiveAt: at,
      observedAt,
      identityRevision: finalAsset.identity.revision,
      assetBindingRevision: finalAsset.bindingRevision,
      dedupeKey: input.dedupeKey ?? `${input.factKind}:${input.subjectAssetId}:${input.runtimeInstanceId ?? ''}:${at}`,
    });
  }

  activateCoverage(input: ObservationCoverageTransitionInput): ObservationCoverageIntervalDto {
    const asset = this.requireAsset(input.subjectAssetId);
    const at = epoch(input.effectiveAt, this.clock());
    const confirmedAt = epoch(input.confirmedAt, at);
    const epochText = String(input.captureEpoch).trim().slice(0, 40);
    if (!/^\d+$/u.test(epochText)) throw new ObservedAssetCoreError('invalid_input', 'captureEpoch must be unsigned decimal');
    const key = coverageKey(input.subjectAssetId, input.runtimeInstanceId);
    const intervals = this.coverageIntervals.get(key) ?? [];
    const active = [...intervals].reverse().find((interval) => interval.state === 'active');
    if (active && at < Date.parse(active.startAt)) {
      throw new ObservedAssetCoreError('invalid_input', 'coverage transition predates the active interval');
    }
    const semanticCoverageHash = digest(coverageSemantic(input, asset));
    if (active?.semanticCoverageHash === semanticCoverageHash) {
      const nextConfirmedAt = iso(confirmedAt);
      if (
        active.latestCaptureEpoch === epochText
        && active.capturePolicyVersion === input.capturePolicyVersion
        && active.lastConfirmedAt === nextConfirmedAt
      ) return clone(active);
      active.latestCaptureEpoch = epochText;
      active.capturePolicyVersion = input.capturePolicyVersion;
      active.lastConfirmedAt = nextConfirmedAt;
      this.telemetryRevision += 1;
      this.updatedAt = Math.max(this.updatedAt, confirmedAt);
      return clone(active);
    }
    if (active) {
      active.state = 'closed';
      active.endAt = iso(Math.max(Date.parse(active.startAt), at));
      active.revision += 1;
      this.appendFact({
        factKind: active.observationState === 'gap' ? 'observation_gap_ended' : 'observation_coverage_ended',
        subjectAssetId: input.subjectAssetId,
        runtimeInstanceId: input.runtimeInstanceId,
        effectiveAt: at,
        observedAt: confirmedAt,
        source: 'observation_coverage',
        reasonCode: input.reasonCode,
        previousState: active.intervalId,
        capturePolicyVersion: active.capturePolicyVersion,
        captureEpoch: active.latestCaptureEpoch,
        dedupeKey: `coverage:end:${active.intervalId}:${at}`,
      });
    }
    const interval: ObservationCoverageIntervalDto = {
      schemaVersion: OBSERVATION_COVERAGE_SCHEMA,
      intervalId: `coverage_${digest([key, semanticCoverageHash, at]).slice(0, 24)}`,
      subjectAssetId: input.subjectAssetId,
      runtimeInstanceId: clean(input.runtimeInstanceId, 500),
      state: 'active',
      startAt: iso(at),
      identityRevision: asset.identity.revision,
      assetBindingRevision: asset.bindingRevision,
      captureProfile: clean(input.captureProfile, 120) ?? 'unknown_discovery',
      capturePolicyVersion: boundedInteger(input.capturePolicyVersion, 0, 0, Number.MAX_SAFE_INTEGER),
      firstCaptureEpoch: epochText,
      latestCaptureEpoch: epochText,
      signalCoverage: this.signalCoverage(input.signalCoverage),
      completeness: input.completeness,
      observationState: input.observationState,
      reasonCode: clean(input.reasonCode, 160) ?? 'capture_profile',
      ruleRefs: strings(input.ruleRefs, 32, 240).sort(),
      semanticCoverageHash,
      lastConfirmedAt: iso(confirmedAt),
      revision: 1,
    };
    intervals.push(interval);
    while (intervals.length > this.maxCoverageIntervalsPerScope) {
      const index = intervals.findIndex((candidate) => candidate.state === 'closed');
      if (index < 0) break;
      intervals.splice(index, 1);
    }
    this.coverageIntervals.set(key, intervals);
    const coverageKeys = this.coverageKeysByAsset.get(input.subjectAssetId) ?? new Set<string>();
    coverageKeys.add(key);
    this.coverageKeysByAsset.set(input.subjectAssetId, coverageKeys);
    this.writeAsset({
      ...asset,
      observationState: interval.observationState,
      captureProfile: interval.captureProfile,
    }, confirmedAt);
    this.appendFact({
      factKind: interval.observationState === 'gap' ? 'observation_gap_started' : 'observation_coverage_started',
      subjectAssetId: input.subjectAssetId,
      runtimeInstanceId: input.runtimeInstanceId,
      effectiveAt: at,
      observedAt: confirmedAt,
      source: 'observation_coverage',
      reasonCode: interval.reasonCode,
      nextState: interval.intervalId,
      capturePolicyVersion: interval.capturePolicyVersion,
      captureEpoch: interval.firstCaptureEpoch,
      dedupeKey: `coverage:start:${interval.intervalId}`,
    });
    return clone(interval);
  }

  observeEvents(events: ExistingEventProjection[]): EventSubjectBindingDto[] {
    const results: EventSubjectBindingDto[] = [];
    for (const event of events) {
      let indexed: { assetId: string; bindingRevision: number; quality: AssetBindingQuality } | undefined;
      let reasonCode = 'unassigned_identity';
      const serviceRole = event.workloadRole === 'anysentry_internal'
        || event.workloadRole === 'platform_infrastructure'
        || event.workloadRole === 'business_service';
      const agentSemantic = event.authenticatedAgentSemantic === true
        || event.identityClassification === 'confirmed_agent'
        || event.identityClassification === 'probable_agent';
      if (event.subjectAssetId && this.assets.has(event.subjectAssetId)) {
        const asset = this.assets.get(event.subjectAssetId)!;
        indexed = { assetId: asset.subjectAssetId, bindingRevision: asset.bindingRevision, quality: event.bindingQuality ?? asset.bindingQuality };
        reasonCode = 'event_subject_asset';
      } else if (!serviceRole && event.agentAssetId && this.assets.has(event.agentAssetId)) {
        const asset = this.assets.get(event.agentAssetId)!;
        indexed = { assetId: asset.subjectAssetId, bindingRevision: asset.bindingRevision, quality: asset.bindingQuality };
        reasonCode = 'legacy_agent_asset_alias';
      } else if (event.serviceAssetId && this.assets.has(event.serviceAssetId)) {
        const asset = this.assets.get(event.serviceAssetId)!;
        indexed = { assetId: asset.subjectAssetId, bindingRevision: asset.bindingRevision, quality: asset.bindingQuality };
        reasonCode = 'service_asset_binding';
      } else if (event.physicalWorkloadId) {
        const physical = this.resolvePhysicalBinding(
          event.physicalWorkloadId,
          agentSemantic ? 'agent' : serviceRole ? 'service' : undefined,
        );
        indexed = physical.binding;
        if (physical.conflict) reasonCode = 'physical_scope_conflict';
        else if (indexed) reasonCode = physical.exact
          ? 'physical_workload_binding'
          : 'physical_workload_parent_binding';
      }
      if (!indexed && event.processInstanceKey) {
        indexed = this.processBindingIndex.get(event.processInstanceKey);
        if (indexed) reasonCode = 'process_generation_binding';
      }
      if (!indexed && event.processInstanceKey) {
        try {
          const scope = boundedScope(event.scope);
          const asset = this.upsertAsset({
            subjectAssetType: 'ephemeral_process',
            logicalIdentity: event.processInstanceKey,
            displayName: event.displayName ?? event.processInstanceKey,
            scope,
            existenceState: 'discovered',
            identity: 'unknown',
            role: 'ordinary_process',
            source: 'event_process_generation',
            observedAt: event.at,
            firstSeenAt: event.at,
            inventoryObserved: false,
            observationState: 'sample',
          });
          const binding = this.upsertBinding({
            subjectAssetId: asset.subjectAssetId,
            quality: 'ephemeral',
            processInstanceKey: event.processInstanceKey,
            source: 'event_process_generation',
            reasonCode: 'ephemeral_process_generation',
            effectiveAt: event.at,
          });
          indexed = { assetId: asset.subjectAssetId, bindingRevision: binding.revision, quality: binding.quality };
          reasonCode = 'ephemeral_process_created';
        } catch (error) {
          if (!(error instanceof ObservedAssetCoreError) || error.code !== 'capacity_exceeded') throw error;
          reasonCode = 'ephemeral_asset_capacity';
        }
      }
      if (!indexed) {
        this.unassignedEvents += 1;
        this.telemetryRevision += 1;
        results.push({
          eventId: event.eventId,
          assetBindingQuality: reasonCode === 'physical_scope_conflict' ? 'conflict' : 'unassigned',
          assetBindingRevision: 0,
          reasonCode,
        });
        continue;
      }
      this.mergeEventAggregate(indexed.assetId, { count: 1, at: event.at, kinds: { [event.eventKind]: 1 } });
      const asset = this.requireAsset(indexed.assetId);
      results.push({
        eventId: event.eventId,
        subjectAssetId: asset.subjectAssetId,
        subjectAssetType: asset.subjectAssetType,
        assetBindingQuality: indexed.quality,
        assetBindingRevision: indexed.bindingRevision,
        reasonCode,
      });
    }
    return results;
  }

  private resolvePhysicalBinding(
    physicalWorkloadId: string,
    preferredType?: 'agent' | 'service',
  ): {
    binding?: { assetId: string; bindingRevision: number; quality: AssetBindingQuality };
    exact: boolean;
    conflict: boolean;
  } {
    const allRelated = [...this.physicalBindingIndex.entries()]
      .filter(([candidate]) => relatedPhysicalWorkload(candidate, physicalWorkloadId))
      .flatMap(([, bindings]) => bindings);
    const preferred = preferredType
      ? allRelated.filter((binding) => {
          const type = this.assets.get(binding.assetId)?.subjectAssetType;
          return preferredType === 'agent'
            ? type === 'agent'
            : type === 'service' || type === 'infrastructure';
        })
      : [];
    if (preferred.length) {
      const preferredAssets = new Set(preferred.map((binding) => binding.assetId));
      if (preferredAssets.size > 1) return { exact: false, conflict: true };
      const [binding] = preferred.sort((left, right) => right.bindingRevision - left.bindingRevision);
      return { binding, exact: this.physicalBindingIndex.get(physicalWorkloadId)?.includes(binding) ?? false, conflict: false };
    }
    const exact = this.physicalBindingIndex.get(physicalWorkloadId) ?? [];
    const exactAssets = new Set(exact.map((binding) => binding.assetId));
    if (exactAssets.size > 1) return { exact: true, conflict: true };
    if (exact.length) {
      const [binding] = [...exact].sort((left, right) => right.bindingRevision - left.bindingRevision);
      return { binding, exact: true, conflict: false };
    }
    const candidates = allRelated;
    const assetIds = new Set(candidates.map((binding) => binding.assetId));
    if (assetIds.size !== 1) return { exact: false, conflict: assetIds.size > 1 };
    const [binding] = candidates.sort((left, right) => right.bindingRevision - left.bindingRevision);
    return { binding, exact: false, conflict: false };
  }

  /** Replace the bounded read window's aggregate without retaining per-event identities. */
  reconcileEventSnapshot(events: ExistingEventProjection[]): EventSubjectBindingDto[] {
    const at = events.reduce((latest, event) => Math.max(latest, event.at), this.clock());
    for (const subjectAssetId of [...this.assetsWithEventSummary]) {
      const asset = this.assets.get(subjectAssetId);
      if (!asset) continue;
      if (asset.eventSummary.eventCount === 0 && !asset.lastActivityAt) continue;
      this.writeTelemetry({
        ...asset,
        eventSummary: { eventCount: 0, eventKindCounts: {} },
        lastActivityAt: undefined,
      }, at);
    }
    this.assetsWithEventSummary.clear();
    if (this.unassignedEvents !== 0) this.telemetryRevision += 1;
    this.unassignedEvents = 0;
    return this.observeEvents(events);
  }

  listAssets(query: ObservedAssetListQuery = {}): ObservedAssetListDto {
    const filterHash = this.filterHash(query);
    const cursor = query.cursor ? this.decodeCursor(query.cursor) : undefined;
    if (cursor && cursor.filterHash !== filterHash) {
      throw new ObservedAssetCoreError('invalid_cursor', 'cursor does not match query filters');
    }
    const snapshotRevision = cursor?.snapshotRevision ?? this.modelRevision;
    const snapshotAssets = this.assetsAtRevision(snapshotRevision);
    let items = snapshotAssets.filter((asset) => this.matchesQuery(asset, query));
    items.sort(compareAsset);
    const total = items.length;
    if (cursor) {
      items = items.filter((asset) => {
        const at = sortAt(asset);
        return at < cursor.lastSortAt
          || (at === cursor.lastSortAt && asset.subjectAssetId.localeCompare(cursor.lastAssetId) > 0);
      });
    }
    const limit = boundedInteger(query.limit, 50, 1, 200);
    const page = items.slice(0, limit);
    const hasMore = items.length > page.length;
    const last = page.at(-1);
    return {
      schemaVersion: OBSERVED_ASSET_LIST_SCHEMA,
      items: clone(page),
      total,
      ...(hasMore && last ? {
        nextCursor: this.encodeCursor({
          v: 1,
          snapshotRevision,
          lastSortAt: sortAt(last),
          lastAssetId: last.subjectAssetId,
          filterHash,
        }),
      } : {}),
      snapshotRevision,
      summary: this.summaryFromAssets(snapshotRevision, snapshotAssets),
      updateTime: iso(this.updatedAt || this.clock()),
    };
  }

  getAsset(subjectAssetId: string): ObservedAssetDetailDto | undefined {
    const asset = this.assets.get(subjectAssetId);
    if (!asset) return undefined;
    return {
      schemaVersion: OBSERVED_ASSET_DETAIL_SCHEMA,
      asset: clone(asset),
      runtimes: clone(this.runtimesForAsset(subjectAssetId)
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))),
      bindings: clone((this.bindings.get(subjectAssetId) ?? [])
        .sort((left, right) => right.revision - left.revision)),
      lifecycleFacts: clone((this.lifecycleFacts.get(subjectAssetId) ?? [])
        .sort((left, right) => Date.parse(left.effectiveAt) - Date.parse(right.effectiveAt) || left.revision - right.revision)),
      observationCoverage: clone([...(this.coverageKeysByAsset.get(subjectAssetId) ?? [])]
        .flatMap((key) => this.coverageIntervals.get(key) ?? [])
        .sort((left, right) => Date.parse(left.startAt) - Date.parse(right.startAt))),
      updateTime: iso(this.updatedAt || this.clock()),
    };
  }

  getAssetRecord(subjectAssetId: string): ObservedAssetDto | undefined {
    const asset = this.assets.get(subjectAssetId);
    return asset ? clone(asset) : undefined;
  }

  getRuntime(subjectAssetId: string, runtimeInstanceId: string): ObservedRuntimeDto | undefined {
    const runtime = this.runtimes.get(`${subjectAssetId}\0${runtimeInstanceId}`);
    return runtime ? clone(runtime) : undefined;
  }

  summary(snapshotRevision = this.modelRevision): ObservedAssetSummaryDto {
    const assets = this.assetsAtRevision(snapshotRevision);
    return this.summaryFromAssets(snapshotRevision, assets);
  }

  private summaryFromAssets(
    snapshotRevision: number,
    assets: readonly ObservedAssetDto[],
  ): ObservedAssetSummaryDto {
    if (
      this.summaryCache?.snapshotRevision === snapshotRevision &&
      this.summaryCache.telemetryRevision === this.telemetryRevision
    ) return clone(this.summaryCache.value);
    const byType = zeroRecord(SUBJECT_TYPES);
    const byExistence = zeroRecord(EXISTENCE_STATES);
    const byIdentity = zeroRecord(IDENTITIES);
    const byRole = zeroRecord(ROLES);
    const byObservation = zeroRecord(OBSERVATION_STATES);
    const byBindingQuality = zeroRecord(BINDING_QUALITIES);
    const runtimeStates = zeroRecord(RUNTIME_STATES);
    const assetIds = new Set(assets.map((asset) => asset.subjectAssetId));
    for (const asset of assets) {
      byType[asset.subjectAssetType] += 1;
      byExistence[asset.existenceState] += 1;
      byIdentity[asset.identity.classification] += 1;
      byRole[asset.role.role] += 1;
      byObservation[asset.observationState] += 1;
      byBindingQuality[asset.bindingQuality] += 1;
    }
    for (const runtime of this.runtimes.values()) {
      if (assetIds.has(runtime.subjectAssetId)) runtimeStates[runtime.state] += 1;
    }
    const value: ObservedAssetSummaryDto = {
      totalAssets: assets.length,
      byType,
      byExistence,
      byIdentity,
      byRole,
      byObservation,
      byBindingQuality,
      runtimeStates,
      totalEvents: assets.reduce((total, asset) => total + asset.eventSummary.eventCount, 0),
      unassignedEvents: this.unassignedEvents,
      degradedOrGapAssets: assets.filter((asset) => asset.observationState === 'degraded' || asset.observationState === 'gap').length,
      modelRevision: snapshotRevision,
      updateTime: iso(this.updatedAt || this.clock()),
    };
    this.summaryCache = {
      snapshotRevision,
      telemetryRevision: this.telemetryRevision,
      value: clone(value),
    };
    return value;
  }

  private requireAsset(subjectAssetId: string): ObservedAssetDto {
    const asset = this.assets.get(subjectAssetId);
    if (!asset) throw new ObservedAssetCoreError('not_found', `asset not found: ${subjectAssetId}`);
    return asset;
  }

  private writeAsset(input: ObservedAssetDto, at: number): ObservedAssetDto {
    const previous = this.assets.get(input.subjectAssetId);
    const comparable = (asset: ObservedAssetDto) => {
      const {
        modelRevision: _revision,
        updatedAt: _updatedAt,
        lastInventoryAt: _lastInventoryAt,
        ...value
      } = asset;
      return value;
    };
    if (previous && digest(comparable(previous)) === digest(comparable(input))) {
      const previousInventoryAt = previous.lastInventoryAt ? Date.parse(previous.lastInventoryAt) : -1;
      const inputInventoryAt = input.lastInventoryAt ? Date.parse(input.lastInventoryAt) : -1;
      if (inputInventoryAt > previousInventoryAt) {
        previous.lastInventoryAt = input.lastInventoryAt;
        const latest = this.assetVersions.get(previous.subjectAssetId)?.at(-1);
        if (latest) latest.asset.lastInventoryAt = input.lastInventoryAt;
        this.updatedAt = Math.max(this.updatedAt, at);
      }
      return previous;
    }
    const revision = this.bumpRevision(at);
    const next = clone({ ...input, modelRevision: revision, updatedAt: iso(at) });
    this.assets.set(next.subjectAssetId, next);
    if (!previous && next.subjectAssetType === 'ephemeral_process') this.ephemeralAssetCount += 1;
    const versions = this.assetVersions.get(next.subjectAssetId) ?? [];
    versions.push({ revision, asset: clone(next) });
    while (versions.length > this.maxVersionsPerAsset) {
      const removed = versions.shift();
      if (removed) this.cursorFloorRevision = Math.max(this.cursorFloorRevision, removed.revision);
    }
    this.assetVersions.set(next.subjectAssetId, versions);
    if (!this.createdRevision.has(next.subjectAssetId)) this.createdRevision.set(next.subjectAssetId, revision);
    this.markDurableStateChanged(next.subjectAssetId, revision, previous);
    this.trackEvictionCandidate(next);
    return next;
  }

  private mergeEventAggregate(
    subjectAssetId: string,
    input: { count: number; at: number; kinds: Record<string, number> },
  ): ObservedAssetDto {
    const asset = this.requireAsset(subjectAssetId);
    const counts = { ...asset.eventSummary.eventKindCounts };
    for (const [kind, count] of Object.entries(input.kinds)) {
      const key = clean(kind, 120) ?? 'unknown';
      if (!(key in counts) && Object.keys(counts).length >= 32) {
        counts.other = (counts.other ?? 0) + count;
      } else {
        counts[key] = (counts[key] ?? 0) + count;
      }
    }
    const previousLast = asset.eventSummary.lastEventAt ? Date.parse(asset.eventSummary.lastEventAt) : -1;
    const next = this.writeTelemetry({
      ...asset,
      eventSummary: {
        eventCount: asset.eventSummary.eventCount + input.count,
        lastEventAt: iso(Math.max(previousLast, input.at)),
        eventKindCounts: counts,
      },
      firstSeenAt: iso(Math.min(Date.parse(asset.firstSeenAt), input.at)),
      lastActivityAt: iso(Math.max(Date.parse(asset.lastActivityAt ?? asset.firstSeenAt), input.at)),
    }, input.at);
    this.assetsWithEventSummary.add(subjectAssetId);
    return next;
  }

  private setEventAggregate(
    subjectAssetId: string,
    input: { count: number; at: number; kinds: Record<string, number> },
  ): ObservedAssetDto {
    const asset = this.requireAsset(subjectAssetId);
    if (input.count <= 0 && Object.keys(input.kinds).length === 0) return asset;
    const next = this.writeTelemetry({
      ...asset,
      eventSummary: {
        eventCount: input.count,
        lastEventAt: input.count > 0 ? iso(input.at) : asset.eventSummary.lastEventAt,
        eventKindCounts: input.kinds,
      },
      firstSeenAt: iso(Math.min(Date.parse(asset.firstSeenAt), input.at)),
      lastActivityAt: input.count > 0 ? iso(input.at) : asset.lastActivityAt,
    }, input.at);
    this.assetsWithEventSummary.add(subjectAssetId);
    return next;
  }

  /** Event telemetry is mutable aggregate state, not a lifecycle revision or per-event history. */
  private writeTelemetry(input: ObservedAssetDto, at: number): ObservedAssetDto {
    const current = this.requireAsset(input.subjectAssetId);
    const next = clone({ ...input, modelRevision: current.modelRevision, updatedAt: iso(at) });
    this.assets.set(next.subjectAssetId, next);
    const versions = this.assetVersions.get(next.subjectAssetId) ?? [];
    const latest = versions.at(-1);
    if (latest) latest.asset = clone(next);
    this.telemetryRevision += 1;
    this.updatedAt = Math.max(this.updatedAt, at);
    this.trackEvictionCandidate(next);
    return next;
  }

  private appendFact(input: StructuralLifecycleFactInput & {
    effectiveAt: number;
    observedAt: number;
    identityRevision?: number;
    assetBindingRevision?: number;
    dedupeKey: string;
  }): AssetLifecycleFactDto {
    const dedupeIndexKey = `${input.subjectAssetId}\0${input.dedupeKey}`;
    const existingFactId = this.factDedupe.get(dedupeIndexKey);
    if (existingFactId) {
      const existing = (this.lifecycleFacts.get(input.subjectAssetId) ?? [])
        .find((fact) => fact.factId === existingFactId);
      if (existing) return clone(existing);
    }
    const source = clean(input.source, 160) ?? 'unknown';
    const nextRevision = (this.factRevisions.get(input.subjectAssetId) ?? 0) + 1;
    this.factRevisions.set(input.subjectAssetId, nextRevision);
    const factId = clean(input.factId, 240)
      ?? `fact_${digest([input.subjectAssetId, input.dedupeKey, nextRevision]).slice(0, 24)}`;
    const fact: AssetLifecycleFactDto = {
      schemaVersion: ASSET_LIFECYCLE_FACT_SCHEMA,
      factId,
      factKind: input.factKind,
      subjectAssetId: input.subjectAssetId,
      runtimeInstanceId: clean(input.runtimeInstanceId, 500),
      effectiveAt: iso(input.effectiveAt),
      observedAt: iso(input.observedAt),
      revision: nextRevision,
      source,
      reasonCode: clean(input.reasonCode, 160) ?? input.factKind,
      previousState: clean(input.previousState, 500),
      nextState: clean(input.nextState, 500),
      identityRevision: input.identityRevision ?? this.assets.get(input.subjectAssetId)?.identity.revision,
      assetBindingRevision: input.assetBindingRevision ?? this.assets.get(input.subjectAssetId)?.bindingRevision,
      capturePolicyVersion: input.capturePolicyVersion,
      captureEpoch: input.captureEpoch === undefined ? undefined : String(input.captureEpoch).slice(0, 40),
      evidenceRefs: strings(input.evidenceRefs, 32, 500),
      dedupeKey: clean(input.dedupeKey, 500) ?? digest(input),
    };
    const facts = this.lifecycleFacts.get(input.subjectAssetId) ?? [];
    facts.push(fact);
    while (facts.length > this.maxFactsPerAsset) {
      const removed = facts.shift();
      if (removed) this.factDedupe.delete(`${removed.subjectAssetId}\0${removed.dedupeKey}`);
    }
    this.lifecycleFacts.set(input.subjectAssetId, facts);
    this.factDedupe.set(dedupeIndexKey, fact.factId);
    const modelRevision = this.bumpRevision(input.observedAt);
    this.markDurableStateChanged(input.subjectAssetId, modelRevision);
    return clone(fact);
  }

  private refreshRuntimeSummary(subjectAssetId: string, at: number): void {
    const asset = this.requireAsset(subjectAssetId);
    const summary = emptyRuntimeSummary();
    for (const runtime of this.runtimesForAsset(subjectAssetId)) {
      summary.total += 1;
      summary[runtime.state] += 1;
    }
    this.writeAsset({ ...asset, runtimeSummary: summary }, at);
  }

  private runtimesForAsset(subjectAssetId: string): ObservedRuntimeDto[] {
    return [...(this.runtimeKeysByAsset.get(subjectAssetId) ?? [])]
      .map((key) => this.runtimes.get(key))
      .filter((runtime): runtime is ObservedRuntimeDto => Boolean(runtime));
  }

  private runtimeSemanticHash(runtime: ObservedRuntimeDto): string {
    const { lastInventoryAt: _lastInventoryAt, updatedAt: _updatedAt, revision: _revision, ...semantic } = runtime;
    return digest(semantic);
  }

  private signalCoverage(value: SignalCoverageMatrix): SignalCoverageMatrix {
    if (!value || Object.values(value).some((item) => !SIGNAL_COVERAGES.has(item))) {
      throw new ObservedAssetCoreError('invalid_input', 'signalCoverage contains an invalid action');
    }
    return {
      exec: value.exec,
      exit: value.exit,
      security: value.security,
      file: value.file,
      fileRead: value.fileRead ?? 'unknown',
      network: value.network,
      llm: value.llm,
    };
  }

  private trimClosedBindings(subjectAssetId: string): void {
    const bindings = this.bindings.get(subjectAssetId) ?? [];
    while (bindings.length >= this.maxBindingsPerAsset) {
      const index = bindings.findIndex((binding) => Boolean(binding.validTo));
      if (index < 0) break;
      bindings.splice(index, 1);
    }
  }

  private closeBindingsForRuntime(subjectAssetId: string, runtimeInstanceId: string, at: number, sourceValue: string): void {
    const all = this.bindings.get(subjectAssetId) ?? [];
    const closed = all.filter((binding) => binding.runtimeInstanceId === runtimeInstanceId && !binding.validTo);
    if (!closed.length) return;
    for (const binding of closed) {
      binding.validTo = iso(at);
      if (binding.physicalWorkloadId) {
        const remaining = (this.physicalBindingIndex.get(binding.physicalWorkloadId) ?? [])
          .filter((indexed) => indexed.assetId !== subjectAssetId);
        if (remaining.length) this.physicalBindingIndex.set(binding.physicalWorkloadId, remaining);
        else this.physicalBindingIndex.delete(binding.physicalWorkloadId);
      }
      if (binding.processInstanceKey) this.processBindingIndex.delete(binding.processInstanceKey);
    }
    const asset = this.requireAsset(subjectAssetId);
    const active = all.filter((binding) => !binding.validTo)
      .sort((left, right) => right.revision - left.revision);
    const bindingRevision = asset.bindingRevision + 1;
    this.globalBindingRevision += 1;
    this.writeAsset({
      ...asset,
      bindingQuality: active[0]?.quality ?? 'unassigned',
      bindingRevision,
    }, at);
    this.appendFact({
      factKind: 'asset_binding_changed',
      subjectAssetId,
      runtimeInstanceId,
      effectiveAt: at,
      observedAt: at,
      source: clean(sourceValue, 160) ?? 'runtime_lifecycle',
      reasonCode: 'runtime_binding_closed',
      previousState: closed.map((binding) => binding.bindingId).join(','),
      nextState: active[0]?.bindingId,
      assetBindingRevision: bindingRevision,
      dedupeKey: `binding:close:${runtimeInstanceId}:${bindingRevision}`,
    });
  }

  private ensureAssetCapacity(incomingType: SubjectAssetType): void {
    const ephemeralQuotaReached = incomingType === 'ephemeral_process'
      && this.ephemeralAssetCount >= this.maxEphemeralAssets;
    if (this.assets.size < this.maxAssets && !ephemeralQuotaReached) return;
    // Active ephemeral Process projections are reconstructible from durable lifecycle/event facts.
    // They may be evicted only to preserve the explicit transient quota or make room for a durable
    // Agent/Service/Infrastructure asset; ordinary steady-state eviction remains more conservative.
    const allowActiveEphemeral = ephemeralQuotaReached || incomingType !== 'ephemeral_process';
    let candidate = this.takeEvictionCandidate(allowActiveEphemeral);
    if (!candidate) {
      // Restore and compatibility paths may predate the heap. One bounded rebuild is preferable to
      // rejecting a new durable subject; the steady-state path remains O(log N).
      this.rebuildEvictionHeap();
      candidate = this.takeEvictionCandidate(allowActiveEphemeral);
    }
    if (!candidate) throw new ObservedAssetCoreError('capacity_exceeded', 'observed asset capacity exceeded');
    this.evictAsset(candidate.subjectAssetId);
    this.bumpRevision(this.clock());
    this.cursorFloorRevision = this.modelRevision;
  }

  /** Remove one asset and every bounded reverse/index reference to it as one capacity action. */
  private evictAsset(subjectAssetId: string): void {
    const removedAsset = this.assets.get(subjectAssetId);
    for (const key of this.runtimeKeysByAsset.get(subjectAssetId) ?? []) this.runtimes.delete(key);
    this.runtimeKeysByAsset.delete(subjectAssetId);
    for (const key of this.coverageKeysByAsset.get(subjectAssetId) ?? []) this.coverageIntervals.delete(key);
    this.coverageKeysByAsset.delete(subjectAssetId);
    for (const binding of this.bindings.get(subjectAssetId) ?? []) {
      if (binding.physicalWorkloadId) {
        const retained = (this.physicalBindingIndex.get(binding.physicalWorkloadId) ?? [])
          .filter((indexed) => indexed.assetId !== subjectAssetId);
        if (retained.length) this.physicalBindingIndex.set(binding.physicalWorkloadId, retained);
        else this.physicalBindingIndex.delete(binding.physicalWorkloadId);
      }
      if (binding.processInstanceKey && this.processBindingIndex.get(binding.processInstanceKey)?.assetId === subjectAssetId) {
        this.processBindingIndex.delete(binding.processInstanceKey);
      }
    }
    for (const fact of this.lifecycleFacts.get(subjectAssetId) ?? []) {
      this.factDedupe.delete(`${subjectAssetId}\0${fact.dedupeKey}`);
    }
    this.factRevisions.delete(subjectAssetId);
    this.bindings.delete(subjectAssetId);
    this.lifecycleFacts.delete(subjectAssetId);
    this.assetVersions.delete(subjectAssetId);
    this.createdRevision.delete(subjectAssetId);
    this.assets.delete(subjectAssetId);
    if (removedAsset?.subjectAssetType === 'ephemeral_process' && this.ephemeralAssetCount > 0) {
      this.ephemeralAssetCount -= 1;
    }
    this.assetsWithEventSummary.delete(subjectAssetId);
    this.evictionGeneration.delete(subjectAssetId);
  }

  private markDurableStateChanged(
    subjectAssetId: string,
    revision: number,
    previous?: ObservedAssetDto,
  ): void {
    const current = this.assets.get(subjectAssetId);
    if (
      current && this.isTransientReadAsset(current)
      && (!previous || this.isTransientReadAsset(previous))
    ) return;
    this.durableStateRevision = Math.max(this.durableStateRevision, revision);
  }

  private isTransientReadAsset(asset: ObservedAssetDto): boolean {
    return asset.subjectAssetType === 'ephemeral_process'
      || (
        asset.identity.source === 'historical_event_subject'
        && !asset.lastInventoryAt
      );
  }

  private isEvictableTransientAsset(asset: ObservedAssetDto): boolean {
    if (!this.isTransientReadAsset(asset)) return false;
    if (asset.existenceState === 'inactive' || asset.existenceState === 'retired') return true;
    // Ephemeral Process assets are a bounded read projection over durable event/lifecycle facts.
    // Without a current/starting Runtime they are not proof of a live workload and can be lazily
    // rematerialised from ClickHouse after eviction.
    return asset.subjectAssetType === 'ephemeral_process' &&
      asset.runtimeSummary.current === 0 &&
      asset.runtimeSummary.starting === 0;
  }

  private evictionBefore(left: AssetEvictionCandidate, right: AssetEvictionCandidate): boolean {
    return left.typePriority < right.typePriority ||
      (left.typePriority === right.typePriority && (
        left.updatedAt < right.updatedAt ||
        (left.updatedAt === right.updatedAt && left.subjectAssetId.localeCompare(right.subjectAssetId) < 0)
      ));
  }

  private pushEvictionCandidate(candidate: AssetEvictionCandidate): void {
    this.evictionHeap.push(candidate);
    let index = this.evictionHeap.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (!this.evictionBefore(this.evictionHeap[index], this.evictionHeap[parent])) break;
      [this.evictionHeap[index], this.evictionHeap[parent]] = [this.evictionHeap[parent], this.evictionHeap[index]];
      index = parent;
    }
  }

  private popEvictionCandidate(): AssetEvictionCandidate | undefined {
    const first = this.evictionHeap[0];
    const last = this.evictionHeap.pop();
    if (!first || !last || this.evictionHeap.length === 0) return first;
    this.evictionHeap[0] = last;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let next = index;
      if (left < this.evictionHeap.length && this.evictionBefore(this.evictionHeap[left], this.evictionHeap[next])) next = left;
      if (right < this.evictionHeap.length && this.evictionBefore(this.evictionHeap[right], this.evictionHeap[next])) next = right;
      if (next === index) break;
      [this.evictionHeap[index], this.evictionHeap[next]] = [this.evictionHeap[next], this.evictionHeap[index]];
      index = next;
    }
    return first;
  }

  private trackEvictionCandidate(asset: ObservedAssetDto): void {
    const generation = ++this.evictionSequence;
    this.evictionGeneration.set(asset.subjectAssetId, generation);
    if (asset.subjectAssetType === 'ephemeral_process' || this.isEvictableTransientAsset(asset)) {
      this.pushEvictionCandidate({
        subjectAssetId: asset.subjectAssetId,
        generation,
        typePriority: asset.subjectAssetType === 'ephemeral_process' ? 0 : 1,
        updatedAt: Date.parse(asset.updatedAt),
      });
    }
    if (this.evictionHeap.length > this.maxAssets * 4 + 1_024) this.rebuildEvictionHeap();
  }

  private rebuildEvictionHeap(): void {
    this.evictionHeap = [];
    for (const asset of this.assets.values()) {
      const generation = ++this.evictionSequence;
      this.evictionGeneration.set(asset.subjectAssetId, generation);
      if (asset.subjectAssetType !== 'ephemeral_process' && !this.isEvictableTransientAsset(asset)) continue;
      this.pushEvictionCandidate({
        subjectAssetId: asset.subjectAssetId,
        generation,
        typePriority: asset.subjectAssetType === 'ephemeral_process' ? 0 : 1,
        updatedAt: Date.parse(asset.updatedAt),
      });
    }
  }

  private takeEvictionCandidate(allowActiveEphemeral = false): ObservedAssetDto | undefined {
    for (let candidate = this.popEvictionCandidate(); candidate; candidate = this.popEvictionCandidate()) {
      if (this.evictionGeneration.get(candidate.subjectAssetId) !== candidate.generation) continue;
      const asset = this.assets.get(candidate.subjectAssetId);
      if (
        !asset
        || (!this.isEvictableTransientAsset(asset)
          && !(allowActiveEphemeral && asset.subjectAssetType === 'ephemeral_process'))
      ) continue;
      return asset;
    }
    return undefined;
  }

  private assetsAtRevision(revision: number): ObservedAssetDto[] {
    if (!Number.isSafeInteger(revision) || revision < 0 || revision > this.modelRevision) {
      throw new ObservedAssetCoreError('invalid_cursor', 'snapshot revision is invalid');
    }
    if (revision < this.cursorFloorRevision) {
      throw new ObservedAssetCoreError('cursor_expired', 'snapshot history is no longer retained');
    }
    const result: ObservedAssetDto[] = [];
    for (const [assetId, versions] of this.assetVersions) {
      const created = this.createdRevision.get(assetId) ?? Number.MAX_SAFE_INTEGER;
      if (created > revision) continue;
      let version: AssetVersion | undefined;
      for (let index = versions.length - 1; index >= 0; index -= 1) {
        if (versions[index].revision <= revision) {
          version = versions[index];
          break;
        }
      }
      if (!version) throw new ObservedAssetCoreError('cursor_expired', 'asset snapshot version was pruned');
      // This method is private and every public DTO clones only its bounded page/detail. Returning
      // immutable snapshot references avoids cloning tens of thousands of assets twice per list.
      result.push(version.asset);
    }
    return result;
  }

  private matchesQuery(asset: ObservedAssetDto, query: ObservedAssetListQuery): boolean {
    const q = clean(query.q, 240)?.toLowerCase();
    return (
      (!query.subjectAssetType || query.subjectAssetType === 'all' || asset.subjectAssetType === query.subjectAssetType)
      && (!query.existenceState || query.existenceState === 'all' || asset.existenceState === query.existenceState)
      && (!query.identity || query.identity === 'all' || asset.identity.classification === query.identity)
      && (!query.role || query.role === 'all' || asset.role.role === query.role)
      && (!query.observationState || query.observationState === 'all' || asset.observationState === query.observationState)
      && (!query.bindingQuality || query.bindingQuality === 'all' || asset.bindingQuality === query.bindingQuality)
      && (!q || [asset.subjectAssetId, asset.displayName, ...asset.aliases]
        .some((value) => value.toLowerCase().includes(q)))
    );
  }

  private filterHash(query: ObservedAssetListQuery): string {
    return digest({
      subjectAssetType: query.subjectAssetType ?? 'all',
      existenceState: query.existenceState ?? 'all',
      identity: query.identity ?? 'all',
      role: query.role ?? 'all',
      observationState: query.observationState ?? 'all',
      bindingQuality: query.bindingQuality ?? 'all',
      q: clean(query.q, 240)?.toLowerCase() ?? '',
    }).slice(0, 24);
  }

  private encodeCursor(cursor: CursorPayload): string {
    return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
  }

  private decodeCursor(value: string): CursorPayload {
    try {
      const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<CursorPayload>;
      if (
        parsed.v !== 1
        || !Number.isSafeInteger(parsed.snapshotRevision)
        || !Number.isFinite(parsed.lastSortAt)
        || !clean(parsed.lastAssetId, 240)
        || !/^[a-f0-9]{24}$/u.test(parsed.filterHash ?? '')
      ) throw new Error('invalid cursor fields');
      return parsed as CursorPayload;
    } catch {
      throw new ObservedAssetCoreError('invalid_cursor', 'cursor is invalid');
    }
  }

  private bumpRevision(at: number): number {
    if (this.modelRevision === Number.MAX_SAFE_INTEGER) {
      throw new ObservedAssetCoreError('capacity_exceeded', 'model revision exhausted');
    }
    this.modelRevision += 1;
    this.updatedAt = Math.max(this.updatedAt, at);
    return this.modelRevision;
  }
}
