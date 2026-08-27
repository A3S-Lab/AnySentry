import type {
  AgentAttributionSource,
  AgentClassification,
  EventSource,
  AgentInventory,
  AgentInventoryItem,
  AgentInventoryQuery,
  EventCategory,
  AgentMetadataListItem,
  AgentRuntimeInstanceRecord,
} from './types';
import { agentAssetIdForIdentityKey } from './agent-identity';
import { agentRuntimeIdentityAliasesFromAtoms } from './agent-semantic-identity';
import type {
  ObservedAssetDetailDto,
  ObservedAssetListDto,
  ObservedAssetDto,
} from './observed-asset-lifecycle.types';

export interface AgentDirectoryLifecycleSnapshot extends ObservedAssetListDto {
  activeSubjectAssetIds?: string[];
  readStatus: {
    partial: boolean;
    reasons: string[];
    modelRevision: number;
    reconciledAt: string;
  };
}

export interface AgentDirectoryRuntimeIdentityIndex {
  runtimeInstanceIds: ReadonlySet<string>;
  physicalWorkloadIds: ReadonlySet<string>;
  agentAssetIds: ReadonlySet<string>;
  retainedRuntimeCount: number;
}

function retainedByCurrentDirectory(runtime: AgentRuntimeInstanceRecord): boolean {
  // `unobserved` means the collector lease is temporarily unavailable, not that the root exited.
  // Keep the Asset visible until an explicit lost/exited transition or bounded state expiry.
  return runtime.runtimeState === 'running' || runtime.runtimeState === 'unobserved';
}

/** Build a strong-equivalence index without changing any legacy Runtime or Asset field. */
export function buildAgentDirectoryRuntimeIdentityIndex(
  runtimes: readonly AgentRuntimeInstanceRecord[],
): AgentDirectoryRuntimeIdentityIndex {
  const runtimeInstanceIds = new Set<string>();
  const physicalWorkloadIds = new Set<string>();
  const agentAssetIds = new Set<string>();
  let retainedRuntimeCount = 0;

  for (const runtime of runtimes) {
    if (!retainedByCurrentDirectory(runtime)) continue;
    retainedRuntimeCount += 1;
    const aliases = agentRuntimeIdentityAliasesFromAtoms({
      agentInstanceId: runtime.agentInstanceId,
      physicalWorkloadId: runtime.physicalWorkloadId,
      hostId: runtime.hostId,
      bootId: runtime.bootId,
      rootPid: runtime.rootPid,
      rootStartTime: runtime.rootStartTimeTicks,
    });
    for (const alias of aliases) {
      runtimeInstanceIds.add(alias);
      agentAssetIds.add(agentAssetIdForIdentityKey(alias));
    }
    if (runtime.physicalWorkloadId) physicalWorkloadIds.add(runtime.physicalWorkloadId);
  }

  return { runtimeInstanceIds, physicalWorkloadIds, agentAssetIds, retainedRuntimeCount };
}

function assetIdentityMatchesRuntimeIndex(
  asset: ObservedAssetDto,
  index: AgentDirectoryRuntimeIdentityIndex,
): boolean {
  return [asset.subjectAssetId, ...asset.aliases].some((identity) => index.agentAssetIds.has(identity));
}

export function lifecycleAgentHasCurrentRuntime(
  asset: ObservedAssetDto,
  detail: Pick<ObservedAssetDetailDto, 'runtimes' | 'bindings'> | undefined,
  index: AgentDirectoryRuntimeIdentityIndex,
): boolean {
  if (assetIdentityMatchesRuntimeIndex(asset, index)) return true;
  if (detail?.runtimes.some((runtime) =>
    index.runtimeInstanceIds.has(runtime.runtimeInstanceId)
    || Boolean(runtime.physicalWorkloadId && index.physicalWorkloadIds.has(runtime.physicalWorkloadId)))) {
    return true;
  }
  return detail?.bindings.some((binding) =>
    !binding.validTo
    && (
      Boolean(binding.runtimeInstanceId && index.runtimeInstanceIds.has(binding.runtimeInstanceId))
      || Boolean(binding.physicalWorkloadId && index.physicalWorkloadIds.has(binding.physicalWorkloadId))
    )) ?? false;
}

/**
 * Resolve current membership from independent Runtime lifecycle facts. Window events are not an
 * input, so Hot Ring eviction cannot remove a still-running Agent from the Asset directory.
 */
export function currentAgentSubjectAssetIds(
  assets: readonly ObservedAssetDto[],
  runtimes: readonly AgentRuntimeInstanceRecord[],
  detailForAsset: (subjectAssetId: string) => Pick<ObservedAssetDetailDto, 'runtimes' | 'bindings'> | undefined,
): string[] {
  const index = buildAgentDirectoryRuntimeIdentityIndex(runtimes);
  return assets.flatMap((asset) => {
    if (assetIdentityMatchesRuntimeIndex(asset, index)) return [asset.subjectAssetId];
    return lifecycleAgentHasCurrentRuntime(asset, detailForAsset(asset.subjectAssetId), index)
      ? [asset.subjectAssetId]
      : [];
  });
}

function emptyCounts<T extends string>(keys: readonly T[]): Record<T, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<T, number>;
}

const EVENT_CATEGORIES: EventCategory[] = ['tool', 'network', 'file', 'llm', 'security', 'process', 'runtime', 'unknown'];
const EVENT_SOURCES: EventSource[] = ['observer', 'synthetic', 'api'];

function attributionSource(source: string): AgentAttributionSource {
  const normalized = source.toLowerCase();
  if (normalized.includes('manual') || normalized.includes('human')) return 'manual_review';
  if (normalized.includes('kubernetes')) return 'kubernetes';
  if (normalized.includes('docker')) return 'docker';
  if (normalized.includes('signature')) return 'process_signature';
  if (normalized.includes('behavior')) return 'behavior';
  if (normalized.includes('register') || normalized.includes('adapter')) return 'self_register';
  return 'none';
}

function metadataForAsset(
  asset: ObservedAssetDto,
  metadata: readonly AgentMetadataListItem[],
): AgentMetadataListItem | undefined {
  return metadata.find((item) =>
    item.agentAssetId === asset.subjectAssetId
    || asset.aliases.includes(item.agentAssetId)
    || item.agentAssetAliases?.includes(asset.subjectAssetId) === true,
  );
}

function runtimeForAsset(asset: ObservedAssetDto): AgentInventoryItem['runtime'] {
  if (asset.scope.clusterId || asset.scope.namespace) return 'kubernetes';
  if (asset.scope.containerName) return 'docker';
  if (asset.scope.hostId || asset.scope.systemdUnit) return 'host';
  return 'unknown';
}

function fallbackItem(asset: ObservedAssetDto, metadata?: AgentMetadataListItem): AgentInventoryItem {
  const runtime = runtimeForAsset(asset);
  const activeRuntimeCount = (asset.runtimeSummary.current ?? 0) + (asset.runtimeSummary.starting ?? 0);
  const idleRuntimeCount = asset.runtimeSummary.idle ?? 0;
  const classification = asset.identity.classification;
  const lastSeen = asset.lastActivityAt ?? asset.lastInventoryAt ?? asset.updatedAt;
  const locationLabel = runtime === 'kubernetes'
    ? [asset.scope.namespace, asset.scope.ownerName, asset.scope.containerName].filter(Boolean).join('/')
    : runtime === 'docker'
      ? asset.scope.containerName
      : asset.scope.hostId ?? asset.scope.systemdUnit ?? asset.scope.workspacePath;
  return {
    agentId: metadata?.agentId ?? asset.displayName,
    agentAssetId: asset.subjectAssetId,
    agentAssetAliases: [...new Set([...asset.aliases, ...(metadata?.agentAssetAliases ?? [])])],
    workspacePath: metadata?.workspacePath ?? asset.scope.workspacePath ?? 'unknown',
    userId: '-',
    displayName: metadata?.displayName ?? asset.displayName,
    detectedName: asset.displayName,
    detectedClassification: classification,
    owner: metadata?.owner,
    team: metadata?.team,
    environment: metadata?.environment,
    criticality: metadata?.criticality,
    tags: metadata?.tags ?? [],
    note: metadata?.note,
    metadataUpdatedAt: metadata?.updatedAt,
    classification,
    runtime,
    locationLabel: locationLabel || undefined,
    instanceCount: asset.runtimeSummary.total ?? 0,
    logicalInstanceCount: asset.runtimeSummary.total ?? 0,
    confidence: classification === 'confirmed_agent' ? 1 : classification === 'probable_agent' ? 0.75 : 0,
    attributionSource: attributionSource(asset.identity.source),
    attributionEvidence: asset.sources.map((source) => `asset_lifecycle:${source}`).slice(-16),
    identityBindingQuality: asset.bindingQuality === 'exact' ? 'exact' : 'weak',
    identityReasonCode: `persistent_asset_directory:${asset.bindingQuality}`,
    workloadRef: metadata?.workloadRef ?? metadata?.reviewWorkloadRef ?? {
      environment: runtime === 'unknown' ? undefined : runtime,
      namespace: asset.scope.namespace,
      containerName: asset.scope.containerName,
      ownerKind: asset.scope.ownerKind,
      ownerName: asset.scope.ownerName,
      systemdUnit: asset.scope.systemdUnit,
    },
    reviewDecision: metadata?.reviewDecision,
    reviewedBy: metadata?.reviewedBy,
    reviewedAt: metadata?.reviewedAt,
    reviewNote: metadata?.reviewNote,
    reviewIdentityKeys: metadata?.identityKeys ?? metadata?.reviewIdentityKeys ?? [asset.subjectAssetId],
    firstSeen: asset.firstSeenAt,
    lastSeen,
    lifecycleState: asset.existenceState === 'retired' ? 'terminated' : activeRuntimeCount > 0 ? 'current' : 'historical',
    terminatedAt: asset.retiredAt,
    healthState: activeRuntimeCount > 0 ? 'active' : idleRuntimeCount > 0 ? 'idle' : 'stale',
    riskLevel: 'safe',
    riskLevelText: '安全',
    eventCount: 0,
    riskyEventCount: 0,
    openIncidentCount: 0,
    sessionCount: 0,
    runCount: 0,
    traceCount: 0,
    tokenCount: 0,
    avgLatencyMs: 0,
    lastEventSubject: '当前行为窗口无事件；资产由持久生命周期目录保留',
    eventCategoryCounts: emptyCounts(EVENT_CATEGORIES),
    sourceCounts: emptyCounts(EVENT_SOURCES),
  };
}

function isAgentClassification(classification: AgentClassification): boolean {
  return classification === 'confirmed_agent' || classification === 'probable_agent';
}

function fallbackMatches(item: AgentInventoryItem, filter: AgentInventoryQuery): boolean {
  const requestedAsset = filter.agentAssetId?.trim();
  const requestedAgent = filter.agentId?.trim();
  const workspace = filter.workspacePath?.trim();
  const q = filter.q?.trim().toLowerCase();
  if (filter.scope === 'agent' && !isAgentClassification(item.classification)) return false;
  if (!filter.includeUnclassified && !isAgentClassification(item.classification)) return false;
  if (requestedAsset && item.agentAssetId !== requestedAsset && !item.agentAssetAliases?.includes(requestedAsset)) return false;
  if (requestedAgent && item.agentId !== requestedAgent) return false;
  if (workspace && item.workspacePath !== workspace) return false;
  if (filter.agentInstanceId || filter.userId) return false;
  if (filter.healthState && filter.healthState !== 'all' && item.healthState !== filter.healthState) return false;
  if (filter.criticality && filter.criticality !== 'all' && item.criticality !== filter.criticality) return false;
  if (filter.owner && !(item.owner ?? '').toLowerCase().includes(filter.owner.trim().toLowerCase())) return false;
  if (filter.environment && !(item.environment ?? '').toLowerCase().includes(filter.environment.trim().toLowerCase())) return false;
  if (filter.tag && !item.tags.some((tag) => tag.toLowerCase().includes(filter.tag!.trim().toLowerCase()))) return false;
  return !q || [item.agentId, item.agentAssetId, item.displayName, item.workspacePath, item.locationLabel]
    .some((value) => value?.toLowerCase().includes(q));
}

function assetRangeMatches(
  asset: ObservedAssetDto,
  metadata: AgentMetadataListItem | undefined,
  filter: AgentInventoryQuery,
  activeRuntime: boolean,
): boolean {
  const range = filter.assetRange ?? 'current';
  // An automatically copied display name is not management intent. Only an explicit review or
  // ownership metadata keeps an inactive Asset in the current directory.
  const managed = Boolean(metadata?.reviewDecision || metadata?.owner || metadata?.team);
  const lastSeen = Date.parse(asset.lastActivityAt ?? asset.lastInventoryAt ?? asset.updatedAt);
  if (range === 'all') return true;
  if (range === 'archived') return asset.existenceState === 'retired';
  if (range === 'historical') return asset.existenceState !== 'retired' && !activeRuntime;
  if (range === 'recent') {
    return asset.existenceState !== 'retired'
      && (activeRuntime || managed || (Number.isFinite(lastSeen) && Date.now() - lastSeen <= 30 * 24 * 60 * 60_000));
  }
  return asset.existenceState !== 'retired' && activeRuntime;
}

function lifecycleAliasComponents(assets: readonly ObservedAssetDto[]): ObservedAssetDto[][] {
  const parent = new Map<string, string>();
  const ensure = (identity: string) => {
    if (!parent.has(identity)) parent.set(identity, identity);
  };
  const find = (identity: string): string => {
    ensure(identity);
    const current = parent.get(identity)!;
    if (current === identity) return identity;
    const root = find(current);
    parent.set(identity, root);
    return root;
  };
  const union = (left: string, right: string) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
  };

  for (const asset of assets) {
    ensure(asset.subjectAssetId);
    for (const alias of asset.aliases) union(asset.subjectAssetId, alias);
  }
  const components = new Map<string, ObservedAssetDto[]>();
  for (const asset of assets) {
    const root = find(asset.subjectAssetId);
    const group = components.get(root) ?? [];
    group.push(asset);
    components.set(root, group);
  }
  return [...components.values()];
}

function explicitManagementRank(asset: ObservedAssetDto, metadata: readonly AgentMetadataListItem[]): number {
  const direct = metadata.find((item) => item.agentAssetId === asset.subjectAssetId);
  if (!direct) return 0;
  if (direct.reviewDecision) return 3;
  if (direct.owner || direct.team) return 2;
  if (direct.note || direct.tags.length > 0) return 1;
  return 0;
}

function preferredLifecycleAsset(
  component: readonly ObservedAssetDto[],
  metadata: readonly AgentMetadataListItem[],
): ObservedAssetDto {
  const subjectIds = new Set(component.map((asset) => asset.subjectAssetId));
  const bindingRank: Record<ObservedAssetDto['bindingQuality'], number> = {
    exact: 6,
    logical: 5,
    ephemeral: 4,
    weak: 3,
    conflict: 2,
    unassigned: 1,
  };
  const classificationRank: Record<ObservedAssetDto['identity']['classification'], number> = {
    confirmed_agent: 4,
    probable_agent: 3,
    unknown: 2,
    non_agent: 1,
  };
  return [...component].sort((left, right) => {
    const management = explicitManagementRank(right, metadata) - explicitManagementRank(left, metadata);
    if (management !== 0) return management;
    // The canonical read-model row owns legacy subject IDs as outbound aliases. Prefer it over
    // the old one-way row even when the old row predates reverse-alias materialization.
    const rightOwnedAliases = right.aliases.filter((alias) => subjectIds.has(alias)).length;
    const leftOwnedAliases = left.aliases.filter((alias) => subjectIds.has(alias)).length;
    return rightOwnedAliases - leftOwnedAliases
      || bindingRank[right.bindingQuality] - bindingRank[left.bindingQuality]
      || classificationRank[right.identity.classification] - classificationRank[left.identity.classification]
      || right.modelRevision - left.modelRevision
      || Date.parse(left.firstSeenAt) - Date.parse(right.firstSeenAt)
      || left.subjectAssetId.localeCompare(right.subjectAssetId);
  })[0];
}

/**
 * Membership comes from the persisted Asset Lifecycle. Window facts only enrich behavior metrics;
 * an empty behavior window can therefore never delete a previously discovered Agent Asset.
 */
export function mergePersistentAgentDirectory(
  window: AgentInventory,
  lifecycle: AgentDirectoryLifecycleSnapshot,
  metadata: readonly AgentMetadataListItem[],
  filter: AgentInventoryQuery,
): AgentInventory {
  const includeWindow = filter.assetRange !== 'historical' && filter.assetRange !== 'archived';
  const windowItems = includeWindow ? window.items : [];
  const represented = new Set(windowItems.flatMap((item) => [item.agentAssetId, ...(item.agentAssetAliases ?? [])]));
  // Alias relations are undirected equivalence edges in the current read model. If the active
  // canonical Asset lists an old ID as an alias, suppress that old lifecycle row even when the
  // old row predates the reverse alias field.
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const asset of lifecycle.items) {
      if (!represented.has(asset.subjectAssetId) && !asset.aliases.some((alias) => represented.has(alias))) continue;
      for (const identity of [asset.subjectAssetId, ...asset.aliases]) {
        if (represented.has(identity)) continue;
        represented.add(identity);
        expanded = true;
      }
    }
  }
  const activeSubjectAssetIds = new Set(lifecycle.activeSubjectAssetIds ?? []);
  const fallback = lifecycleAliasComponents(
    lifecycle.items.filter((asset) => asset.subjectAssetType === 'agent'),
  )
    .filter((component) => !component.some((asset) => represented.has(asset.subjectAssetId)))
    .flatMap((component) => {
      const asset = preferredLifecycleAsset(component, metadata);
      const record = metadataForAsset(asset, metadata);
      const activeRuntime = component.some((candidate) => activeSubjectAssetIds.has(candidate.subjectAssetId));
      if (!assetRangeMatches(asset, record, filter, activeRuntime)) return [];
      const item = fallbackItem(asset, record);
      item.agentAssetAliases = [...new Set([
        ...(item.agentAssetAliases ?? []),
        ...component.flatMap((candidate) => [candidate.subjectAssetId, ...candidate.aliases]),
      ])].filter((identity) => identity !== item.agentAssetId);
      return [item];
    })
    .filter((item) => fallbackMatches(item, filter));
  const items = [...windowItems, ...fallback];
  return {
    ...window,
    items,
    total: items.length,
    summary: {
      totalAgents: items.length,
      managedAgents: items.filter((item) => Boolean(item.owner || item.team || item.displayName)).length,
      productionAgents: items.filter((item) => ['prod', 'production'].includes((item.environment ?? '').toLowerCase())).length,
      highCriticalityAgents: items.filter((item) => item.criticality === 'high' || item.criticality === 'critical').length,
      activeAgents: items.filter((item) => item.healthState === 'active').length,
      idleAgents: items.filter((item) => item.healthState === 'idle').length,
      staleAgents: items.filter((item) => item.healthState === 'stale').length,
      riskyAgents: items.filter((item) => item.healthState === 'risky').length,
      openIncidentAgents: items.filter((item) => item.openIncidentCount > 0).length,
      observedEventCount: items.reduce((total, item) => total + item.eventCount, 0),
      riskyEventCount: items.reduce((total, item) => total + item.riskyEventCount, 0),
    },
    directory: {
      source: 'observed_asset_lifecycle',
      snapshotRevision: lifecycle.snapshotRevision,
      totalAssets: lifecycle.total,
      partial: lifecycle.readStatus.partial,
      reasons: lifecycle.readStatus.reasons,
      reconciledAt: lifecycle.readStatus.reconciledAt,
    },
    updateTime: new Date().toISOString(),
  };
}
