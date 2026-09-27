export const OBSERVED_ASSET_SCHEMA = 'anysentry.observed_asset.v1' as const;
export const OBSERVED_ASSET_LIST_SCHEMA = 'anysentry.observed_asset_list.v1' as const;
export const OBSERVED_ASSET_DETAIL_SCHEMA = 'anysentry.observed_asset_detail.v1' as const;
export const OBSERVATION_COVERAGE_SCHEMA = 'anysentry.observation_coverage_interval.v1' as const;
export const ASSET_LIFECYCLE_FACT_SCHEMA = 'anysentry.asset_lifecycle_fact.v1' as const;

export type SubjectAssetType =
  | 'agent'
  | 'service'
  | 'infrastructure'
  | 'workload'
  | 'ephemeral_process';

export type AssetExistenceState = 'discovered' | 'active' | 'inactive' | 'retired';
export type ObservedRuntimeState = 'starting' | 'current' | 'idle' | 'exited' | 'lost' | 'unknown';
export type ObservedAgentIdentity = 'confirmed_agent' | 'probable_agent' | 'unknown' | 'non_agent';
export type ObservedWorkloadRole =
  | 'agent'
  | 'anysentry_internal'
  | 'platform_infrastructure'
  | 'business_service'
  | 'ordinary_process'
  | 'unknown';
export type AssetBindingQuality = 'exact' | 'logical' | 'ephemeral' | 'weak' | 'conflict' | 'unassigned';
export type ObservationState = 'full' | 'structural' | 'aggregate' | 'sample' | 'suppressed' | 'degraded' | 'gap';
export type SignalCoverage = 'full' | 'structural' | 'aggregate' | 'sample' | 'drop' | 'not_enabled' | 'unknown';
export type ObservationCompleteness = 'complete' | 'bounded' | 'partial' | 'degraded' | 'gap';

export type AssetLifecycleFactKind =
  | 'asset_discovered'
  | 'asset_activated'
  | 'asset_inactivated'
  | 'asset_retired'
  | 'asset_binding_changed'
  | 'runtime_started'
  | 'runtime_became_idle'
  | 'runtime_exited'
  | 'runtime_lost'
  | 'identity_decision_changed'
  | 'human_review_cleared'
  | 'capture_profile_changed'
  | 'rule_binding_changed'
  | 'observation_coverage_started'
  | 'observation_coverage_ended'
  | 'observation_gap_started'
  | 'observation_gap_ended';

export interface SubjectAssetScope {
  tenantId?: string;
  environmentId?: string;
  workspaceId?: string;
  workspacePath?: string;
  clusterId?: string;
  namespace?: string;
  ownerKind?: string;
  ownerName?: string;
  containerName?: string;
  hostGroup?: string;
  hostId?: string;
  systemdUnit?: string;
}

export interface VersionedIdentityState {
  classification: ObservedAgentIdentity;
  revision: number;
  source: string;
  effectiveAt: string;
}

export interface VersionedRoleState {
  role: ObservedWorkloadRole;
  revision: number;
  source: string;
  effectiveAt: string;
}

export interface ObservedAssetEventSummary {
  eventCount: number;
  lastEventAt?: string;
  eventKindCounts: Record<string, number>;
}

export interface ObservedAssetRuntimeSummary {
  total: number;
  starting: number;
  current: number;
  idle: number;
  exited: number;
  lost: number;
  unknown: number;
}

export interface ObservedAssetDto {
  schemaVersion: typeof OBSERVED_ASSET_SCHEMA;
  subjectAssetId: string;
  subjectAssetType: SubjectAssetType;
  canonicalIdentityVersion: 'observed_asset.v1';
  displayName: string;
  aliases: string[];
  logicalIdentityHash: string;
  scope: SubjectAssetScope;
  existenceState: AssetExistenceState;
  identity: VersionedIdentityState;
  role: VersionedRoleState;
  bindingQuality: AssetBindingQuality;
  bindingRevision: number;
  observationState: ObservationState;
  captureProfile?: string;
  runtimeSummary: ObservedAssetRuntimeSummary;
  eventSummary: ObservedAssetEventSummary;
  firstSeenAt: string;
  lastInventoryAt?: string;
  lastActivityAt?: string;
  inactiveAt?: string;
  retiredAt?: string;
  sources: string[];
  evidenceRefs: string[];
  modelRevision: number;
  updatedAt: string;
}

export interface ObservedAssetBindingDto {
  bindingId: string;
  subjectAssetId: string;
  runtimeInstanceId?: string;
  quality: AssetBindingQuality;
  revision: number;
  physicalWorkloadId?: string;
  processInstanceKey?: string;
  podUid?: string;
  containerId?: string;
  cgroupId?: string;
  inventoryGeneration?: number;
  nodeId?: string;
  source: string;
  reasonCode: string;
  validFrom: string;
  validTo?: string;
  evidenceRefs: string[];
}

export interface ObservedRuntimeDto {
  runtimeInstanceId: string;
  subjectAssetId: string;
  placement: 'kubernetes' | 'docker' | 'host' | 'process' | 'unknown';
  state: ObservedRuntimeState;
  physicalWorkloadId?: string;
  processInstanceKey?: string;
  podUid?: string;
  containerId?: string;
  cgroupId?: string;
  inventoryGeneration?: number;
  nodeId?: string;
  startedAt: string;
  lastInventoryAt: string;
  endedAt?: string;
  source: string;
  reasonCode: string;
  evidenceRefs: string[];
  revision: number;
  updatedAt: string;
}

export interface AssetLifecycleFactDto {
  schemaVersion: typeof ASSET_LIFECYCLE_FACT_SCHEMA;
  factId: string;
  factKind: AssetLifecycleFactKind;
  subjectAssetId: string;
  runtimeInstanceId?: string;
  effectiveAt: string;
  observedAt: string;
  revision: number;
  source: string;
  reasonCode: string;
  previousState?: string;
  nextState?: string;
  identityRevision?: number;
  assetBindingRevision?: number;
  capturePolicyVersion?: number;
  captureEpoch?: string;
  evidenceRefs: string[];
  dedupeKey: string;
}

export interface SignalCoverageMatrix {
  exec: SignalCoverage;
  exit: SignalCoverage;
  security: SignalCoverage;
  file: SignalCoverage;
  /** Selective read-open coverage; absent only on state persisted before this additive signal. */
  fileRead?: SignalCoverage;
  network: SignalCoverage;
  llm: SignalCoverage;
}

export interface ObservationCoverageIntervalDto {
  schemaVersion: typeof OBSERVATION_COVERAGE_SCHEMA;
  intervalId: string;
  subjectAssetId: string;
  runtimeInstanceId?: string;
  state: 'active' | 'closed';
  startAt: string;
  endAt?: string;
  identityRevision: number;
  assetBindingRevision: number;
  captureProfile: string;
  capturePolicyVersion: number;
  firstCaptureEpoch: string;
  latestCaptureEpoch: string;
  signalCoverage: SignalCoverageMatrix;
  completeness: ObservationCompleteness;
  observationState: ObservationState;
  reasonCode: string;
  ruleRefs: string[];
  semanticCoverageHash: string;
  lastConfirmedAt: string;
  revision: number;
}

export interface ObservedAssetSummaryDto {
  totalAssets: number;
  byType: Record<SubjectAssetType, number>;
  byExistence: Record<AssetExistenceState, number>;
  byIdentity: Record<ObservedAgentIdentity, number>;
  byRole: Record<ObservedWorkloadRole, number>;
  byObservation: Record<ObservationState, number>;
  byBindingQuality: Record<AssetBindingQuality, number>;
  runtimeStates: Record<ObservedRuntimeState, number>;
  totalEvents: number;
  unassignedEvents: number;
  degradedOrGapAssets: number;
  modelRevision: number;
  updateTime: string;
}

export interface ObservedAssetListQuery {
  subjectAssetType?: SubjectAssetType | 'all';
  existenceState?: AssetExistenceState | 'all';
  identity?: ObservedAgentIdentity | 'all';
  role?: ObservedWorkloadRole | 'all';
  observationState?: ObservationState | 'all';
  bindingQuality?: AssetBindingQuality | 'all';
  q?: string;
  cursor?: string;
  limit?: number;
}

export interface ObservedAssetListDto {
  schemaVersion: typeof OBSERVED_ASSET_LIST_SCHEMA;
  items: ObservedAssetDto[];
  total: number;
  nextCursor?: string;
  snapshotRevision: number;
  summary: ObservedAssetSummaryDto;
  updateTime: string;
}

export interface ObservedAssetDetailDto {
  schemaVersion: typeof OBSERVED_ASSET_DETAIL_SCHEMA;
  asset: ObservedAssetDto;
  runtimes: ObservedRuntimeDto[];
  bindings: ObservedAssetBindingDto[];
  lifecycleFacts: AssetLifecycleFactDto[];
  observationCoverage: ObservationCoverageIntervalDto[];
  updateTime: string;
}

export interface ObservedAssetUpsertInput {
  subjectAssetId?: string;
  subjectAssetType: SubjectAssetType;
  logicalIdentity: string;
  displayName: string;
  aliases?: string[];
  scope?: SubjectAssetScope;
  existenceState?: AssetExistenceState;
  identity?: ObservedAgentIdentity;
  identitySource?: string;
  identityEffectiveAt?: number;
  role?: ObservedWorkloadRole;
  roleSource?: string;
  roleEffectiveAt?: number;
  source: string;
  evidenceRefs?: string[];
  observedAt?: number;
  firstSeenAt?: number;
  inventoryObserved?: boolean;
  observationState?: ObservationState;
  captureProfile?: string;
}

export interface ExistingAgentAssetProjection {
  agentAssetId: string;
  agentAssetAliases?: string[];
  agentId: string;
  displayName?: string;
  detectedName?: string;
  classification: ObservedAgentIdentity;
  detectedClassification?: ObservedAgentIdentity;
  workspacePath?: string;
  runtime?: 'kubernetes' | 'docker' | 'host' | 'unknown';
  physicalWorkloadId?: string;
  agentInstanceId?: string;
  processInstanceKey?: string;
  firstSeen?: string | number;
  lastSeen?: string | number;
  lifecycleState?: 'current' | 'historical' | 'terminated';
  eventCount?: number;
  eventCategoryCounts?: Record<string, number>;
  attributionSource?: string;
  attributionEvidence?: string[];
}

export interface ExistingKubeServiceProjection {
  serviceAssetId: string;
  name: string;
  namespace: string;
  clusterId: string;
  kind?: 'service' | 'database' | 'queue';
  role: ObservedWorkloadRole;
  identity?: ObservedAgentIdentity;
  identitySource?: string;
  identityEffectiveAt?: number;
  ownerKind?: string;
  ownerName?: string;
  revision?: string;
  physicalWorkloadIds?: string[];
  runtimeInstanceIds?: string[];
  observedAt: number;
  replicas?: { observed: number; ready: number };
}

export interface ObservedRuntimeUpsertInput {
  runtimeInstanceId: string;
  subjectAssetId: string;
  placement?: ObservedRuntimeDto['placement'];
  state: ObservedRuntimeState;
  physicalWorkloadId?: string;
  processInstanceKey?: string;
  podUid?: string;
  containerId?: string;
  cgroupId?: string;
  inventoryGeneration?: number;
  nodeId?: string;
  startedAt?: number;
  observedAt?: number;
  endedAt?: number;
  source: string;
  reasonCode?: string;
  evidenceRefs?: string[];
}

export interface ObservedAssetBindingInput {
  subjectAssetId: string;
  runtimeInstanceId?: string;
  quality: AssetBindingQuality;
  physicalWorkloadId?: string;
  processInstanceKey?: string;
  podUid?: string;
  containerId?: string;
  cgroupId?: string;
  inventoryGeneration?: number;
  nodeId?: string;
  source: string;
  reasonCode?: string;
  effectiveAt?: number;
  evidenceRefs?: string[];
}

export interface StructuralLifecycleFactInput {
  factId?: string;
  dedupeKey?: string;
  factKind: AssetLifecycleFactKind;
  subjectAssetId: string;
  runtimeInstanceId?: string;
  effectiveAt?: number;
  observedAt?: number;
  source: string;
  reasonCode?: string;
  previousState?: string;
  nextState?: string;
  nextIdentity?: ObservedAgentIdentity;
  capturePolicyVersion?: number;
  captureEpoch?: string | number;
  evidenceRefs?: string[];
}

export interface ObservationCoverageTransitionInput {
  subjectAssetId: string;
  runtimeInstanceId?: string;
  effectiveAt?: number;
  confirmedAt?: number;
  captureProfile: string;
  capturePolicyVersion: number;
  captureEpoch: string | number;
  signalCoverage: SignalCoverageMatrix;
  completeness: ObservationCompleteness;
  observationState: ObservationState;
  reasonCode: string;
  ruleRefs?: string[];
}

export interface ExistingEventProjection {
  eventId: string;
  at: number;
  eventKind: string;
  subjectAssetId?: string;
  subjectAssetType?: SubjectAssetType;
  agentAssetId?: string;
  serviceAssetId?: string;
  physicalWorkloadId?: string;
  processInstanceKey?: string;
  bindingQuality?: AssetBindingQuality;
  identityClassification?: ObservedAgentIdentity;
  workloadRole?: ObservedWorkloadRole;
  authenticatedAgentSemantic?: boolean;
  displayName?: string;
  scope?: SubjectAssetScope;
}

export interface EventSubjectBindingDto {
  eventId: string;
  subjectAssetId?: string;
  subjectAssetType?: SubjectAssetType;
  assetBindingQuality: AssetBindingQuality;
  assetBindingRevision: number;
  reasonCode: string;
}

export interface ObservedAssetCoreOptions {
  now?: () => number;
  maxAssets?: number;
  /** Reserve durable capacity by capping transient Process projections independently. */
  maxEphemeralAssets?: number;
  maxVersionsPerAsset?: number;
  maxFactsPerAsset?: number;
  maxCoverageIntervalsPerScope?: number;
  maxBindingsPerAsset?: number;
  maxRuntimesPerAsset?: number;
}
