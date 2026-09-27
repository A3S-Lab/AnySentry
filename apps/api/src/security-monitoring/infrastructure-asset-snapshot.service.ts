import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AggregationService } from './aggregation.service';
import {
  InfrastructureAssetSnapshotProvider,
  InfrastructureGovernanceAsset,
  InfrastructureGovernanceAssetSnapshot,
} from './infrastructure-rule-governance';
import type {
  InfrastructureInventoryWorkload,
  InfrastructureRuleImpactPartialReason,
} from './infrastructure-rule.types';
import { KubeIdentityService, type KubeServiceAsset } from './kube-identity.service';
import type { AgentInventoryItem, WorkloadRole } from './types';
import { ObservedAssetReviewService } from './observed-asset-review.service';
import { AgentRuntimeStateService } from './agent-runtime-state.service';

const MAX_SNAPSHOT_ASSETS = 20_000;
const CONTINUITY_FRESHNESS_MS = 5 * 60_000;

function serviceContextEvidence(
  service: KubeServiceAsset | undefined,
  inventoryReady: boolean,
  inventoryErrors: number,
  now: number,
): { available: boolean; reasons: InfrastructureRuleImpactPartialReason[] } {
  if (!service) return { available: false, reasons: ['service_context_asset_unmapped'] };
  if (!inventoryReady || inventoryErrors > 0) {
    return { available: false, reasons: ['service_context_inventory_not_ready'] };
  }
  if (!Number.isFinite(service.observedAt) || service.observedAt <= 0 || now - service.observedAt > CONTINUITY_FRESHNESS_MS) {
    return { available: false, reasons: ['service_context_stale'] };
  }
  if (!service.metrics.length) {
    return { available: false, reasons: ['service_context_metrics_unavailable'] };
  }
  const hasFreshMetric = service.metrics.some((metric) =>
    Number.isFinite(metric.value)
    && Number.isFinite(metric.observedAt)
    && metric.observedAt > 0
    && now - metric.observedAt <= CONTINUITY_FRESHNESS_MS);
  return hasFreshMetric
    ? { available: true, reasons: [] }
    : { available: false, reasons: ['service_context_stale'] };
}

function revisionOf(value: unknown): number {
  return Math.max(1, Number.parseInt(
    createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 12),
    16,
  ));
}

function clusterFromPhysical(value: string): string | undefined {
  const match = value.match(/^k8s:([^:]+):/u);
  return match?.[1];
}

function relatedPhysicalWorkload(left: string, right: string): boolean {
  if (left === right) return true;
  const leftPrefix = k8sPhysicalPrefix(left);
  const rightPrefix = k8sPhysicalPrefix(right);
  return Boolean(leftPrefix && leftPrefix === rightPrefix);
}

function k8sPhysicalPrefix(value: string): string | undefined {
  const parts = value.split(':');
  return parts[0] === 'k8s' && parts.length >= 3 ? parts.slice(0, 3).join(':') : undefined;
}

function governanceRole(role: WorkloadRole): InfrastructureGovernanceAsset['workloadRole'] {
  if (
    role === 'anysentry_internal'
    || role === 'platform_infrastructure'
    || role === 'business_service'
    || role === 'ordinary_process'
  ) return role;
  return 'unknown';
}

function agentWorkload(item: AgentInventoryItem): InfrastructureInventoryWorkload | undefined {
  const physicalWorkloadId = item.physicalWorkloadId?.trim();
  if (!physicalWorkloadId) return undefined;
  const ref = item.workloadRef;
  if (item.runtime === 'kubernetes' && ref?.namespace && ref.ownerKind && ref.ownerName) {
    return {
      placement: 'kubernetes',
      nodeId: ref.nodeName ?? item.hostId,
      namespace: ref.namespace,
      ownerKind: ref.ownerKind,
      ownerName: ref.ownerName,
      containerName: ref.containerName,
      physicalWorkloadId,
      classification: item.classification,
    };
  }
  if (item.runtime === 'docker' && ref?.containerName) {
    return {
      placement: 'docker',
      nodeId: ref.nodeName ?? item.hostId,
      containerName: ref.containerName,
      // A mutable image tag is intentionally not promoted to imageDigest. Selector validation will
      // fail closed unless a stable Compose or exact digest identity exists.
      physicalWorkloadId,
      classification: item.classification,
    };
  }
  const systemdUnit = ref?.systemdUnit;
  if (item.runtime === 'host' && item.hostId && systemdUnit?.endsWith('.service')) {
    return {
      placement: 'host',
      nodeId: item.hostId,
      systemdUnit,
      physicalWorkloadId,
      classification: item.classification,
    };
  }
  return undefined;
}

/**
 * Server-owned adapter used only for rule governance. It compiles the same authenticated
 * Inventory/Agent read models used by the unified asset page into the narrower destructive-rule
 * snapshot contract; clients never supply selectors, cgroups, or workload lists.
 */
@Injectable()
export class InfrastructureAssetSnapshotService implements InfrastructureAssetSnapshotProvider {
  constructor(
    private readonly aggregation: AggregationService,
    private readonly kube: KubeIdentityService,
    private readonly assetReviews: ObservedAssetReviewService,
    private readonly agentRuntime: AgentRuntimeStateService,
  ) {}

  snapshot(): InfrastructureGovernanceAssetSnapshot {
    const now = Date.now();
    const serviceInventory = this.kube.serviceInventory();
    const workloadInventory = this.kube.snapshot();
    const runtimeInventory = this.agentRuntime.list({ includeShadow: true, limit: 100_000 });
    const agentInventory = this.aggregation.agentInventory({
      timeType: 'last_30m',
      scope: 'raw',
      includeUnclassified: true,
      limit: 500,
    });
    const authoritativeAgentPhysical = new Set([
      ...workloadInventory.entries
        .filter((entry) => entry.classification === 'confirmed_agent' || entry.classification === 'probable_agent')
        .map((entry) => entry.physicalWorkloadId),
      ...runtimeInventory.items
        .filter((entry) =>
          entry.runtimeState !== 'exited'
          && entry.runtimeState !== 'lost'
          && (entry.classification === 'confirmed_agent' || entry.classification === 'probable_agent'))
        .map((entry) => entry.physicalWorkloadId),
    ].filter((value): value is string => Boolean(value)));
    const agentPhysical = new Set([
      ...authoritativeAgentPhysical,
      ...agentInventory.items
        .filter((item) => item.classification === 'confirmed_agent' || item.classification === 'probable_agent')
        .map((item) => item.physicalWorkloadId?.trim()),
    ]
      .filter((value): value is string => Boolean(value)));
    const servicePhysical = new Set(serviceInventory.items.flatMap((asset) => asset.physicalWorkloadIds));
    const serviceForPhysical = (physicalWorkloadId: string) => serviceInventory.items.find((asset) =>
      asset.physicalWorkloadIds.some((candidate) => relatedPhysicalWorkload(candidate, physicalWorkloadId)));
    const currentPhysicalWorkloads = [
      ...workloadInventory.entries.map((entry) => entry.physicalWorkloadId),
      ...runtimeInventory.items
        .filter((entry) => entry.runtimeState !== 'exited' && entry.runtimeState !== 'lost')
        .map((entry) => entry.physicalWorkloadId),
    ].filter((value): value is string => Boolean(value));
    const currentPresence = (physicalWorkloadId: string) => currentPhysicalWorkloads.some((candidate) =>
      relatedPhysicalWorkload(candidate, physicalWorkloadId));
    const continuity = (
      presenceVerified: boolean,
      service: KubeServiceAsset | undefined,
    ): NonNullable<InfrastructureGovernanceAsset['continuity']> => {
      const context = serviceContextEvidence(service, serviceInventory.ready, serviceInventory.errors, now);
      const partialReasons: InfrastructureRuleImpactPartialReason[] = [
        ...(!presenceVerified ? ['lifecycle_current_presence_unverified' as const] : []),
        'observation_coverage_unavailable',
        ...context.reasons,
      ];
      return {
        currentPresenceVerified: presenceVerified,
        // This provider does not read Observation Coverage intervals. Inventory presence alone is
        // not enough to claim a continuous lifecycle across a rule/epoch transition.
        observationCoverageAvailable: false,
        serviceContextAvailable: context.available,
        partialReasons: [...new Set(partialReasons)],
      };
    };
    const assets: InfrastructureGovernanceAsset[] = [];

    for (const service of serviceInventory.items) {
      const physicalWorkloadId = service.physicalWorkloadIds[0];
      if (!physicalWorkloadId) continue;
      const review = this.assetReviews.current(service.serviceAssetId);
      const serviceEntries = workloadInventory.entries
        .filter((entry) => service.physicalWorkloadIds.some((physical) =>
          relatedPhysicalWorkload(physical, entry.physicalWorkloadId)));
      const nodeIds = [...new Set(serviceEntries
        .map((entry) => entry.nodeName)
        .filter((value): value is string => Boolean(value)))];
      const containerNames = [...new Set(serviceEntries
        .map((entry) => entry.containerName)
        .filter((value): value is string => Boolean(value)))];
      assets.push({
        assetId: service.serviceAssetId,
        revision: revisionOf([
          service.revision,
          service.physicalWorkloadIds,
          service.runtimeInstanceIds,
          review?.globalRevision ?? 0,
        ]),
        displayName: service.name,
        assetType: service.kind === 'service' ? 'service' : 'infrastructure',
        bindingQuality: 'logical',
        workloadRole: governanceRole(service.role),
        classification: review?.decision ?? 'unknown',
        sharedScope: service.physicalWorkloadIds.some((id) =>
          [...agentPhysical].some((agentId) => relatedPhysicalWorkload(id, agentId))),
        workload: {
          placement: 'kubernetes',
          clusterId: service.clusterId,
          namespace: service.namespace,
          ownerKind: service.ownerKind,
          ownerName: service.ownerName,
          serviceName: service.name,
          containerName: containerNames.length === 1 ? containerNames[0] : undefined,
          physicalWorkloadId,
          classification: review?.decision ?? 'unknown',
        },
        instanceCount: service.runtimeInstanceIds.length || service.physicalWorkloadIds.length,
        nodeIds,
        continuity: continuity(
          serviceEntries.length > 0
            && service.physicalWorkloadIds.some((physical) => currentPresence(physical)),
          service,
        ),
      });
    }

    for (const entry of workloadInventory.entries) {
      if (entry.classification !== 'confirmed_agent' && entry.classification !== 'probable_agent') continue;
      const service = serviceForPhysical(entry.physicalWorkloadId);
      const placement = entry.environment ?? entry.source;
      let workload: InfrastructureInventoryWorkload | undefined;
      if (placement === 'kubernetes') {
        workload = {
          placement,
          nodeId: entry.nodeName,
          clusterId: service?.clusterId ?? clusterFromPhysical(entry.physicalWorkloadId),
          namespace: entry.namespace ?? service?.namespace,
          ownerKind: entry.ownerKind ?? service?.ownerKind,
          ownerName: entry.ownerName ?? service?.ownerName,
          serviceName: service?.name,
          containerName: entry.containerName,
          physicalWorkloadId: entry.physicalWorkloadId,
          classification: entry.classification,
        };
      } else if (placement === 'host' && entry.nodeName && entry.systemdUnit) {
        workload = {
          placement: 'host',
          nodeId: entry.nodeName,
          systemdUnit: entry.systemdUnit,
          physicalWorkloadId: entry.physicalWorkloadId,
          classification: entry.classification,
        };
      } else if (placement === 'docker' && entry.containerName) {
        workload = {
          placement: 'docker',
          nodeId: entry.nodeName,
          containerName: entry.containerName,
          physicalWorkloadId: entry.physicalWorkloadId,
          classification: entry.classification,
        };
      }
      if (!workload) continue;
      assets.push({
        assetId: `guard:${revisionOf([entry.physicalWorkloadId, entry.agentInstanceId, entry.agentScopeId])}`,
        revision: revisionOf([workloadInventory.version, entry.reviewRevision ?? 0, entry.physicalWorkloadId]),
        displayName: entry.agentDisplayName ?? entry.agentScopeId ?? entry.containerName ?? 'Agent runtime',
        assetType: 'workload',
        bindingQuality: 'exact',
        workloadRole: 'unknown',
        classification: entry.classification,
        conflict: true,
        sharedScope: [...servicePhysical].some((id) => relatedPhysicalWorkload(id, entry.physicalWorkloadId)),
        workload,
        instanceCount: 1,
        nodeIds: [entry.nodeName].filter((value): value is string => Boolean(value)),
        continuity: continuity(true, service),
      });
    }

    for (const runtime of runtimeInventory.items) {
      if (
        !runtime.physicalWorkloadId
        || runtime.runtimeState === 'exited'
        || runtime.runtimeState === 'lost'
        || (runtime.classification !== 'confirmed_agent' && runtime.classification !== 'probable_agent')
      ) continue;
      const service = serviceForPhysical(runtime.physicalWorkloadId);
      const ref = runtime.workloadRef;
      const placement = ref?.environment ?? (service ? 'kubernetes' : 'host');
      const workload: InfrastructureInventoryWorkload = placement === 'kubernetes'
        ? {
            placement,
            nodeId: ref?.nodeName ?? runtime.hostId,
            clusterId: service?.clusterId ?? clusterFromPhysical(runtime.physicalWorkloadId),
            namespace: ref?.namespace ?? service?.namespace,
            ownerKind: ref?.ownerKind ?? service?.ownerKind,
            ownerName: ref?.ownerName ?? service?.ownerName,
            serviceName: service?.name,
            containerName: ref?.containerName,
            physicalWorkloadId: runtime.physicalWorkloadId,
            classification: runtime.classification,
          }
        : placement === 'docker'
          ? {
              placement,
              nodeId: ref?.nodeName ?? runtime.hostId,
              containerName: ref?.containerName,
              physicalWorkloadId: runtime.physicalWorkloadId,
              classification: runtime.classification,
            }
          : {
              placement: 'host',
              nodeId: runtime.hostId,
              systemdUnit: ref?.systemdUnit,
              physicalWorkloadId: runtime.physicalWorkloadId,
              classification: runtime.classification,
            };
      assets.push({
        assetId: `guard:runtime:${runtime.agentInstanceId}`,
        revision: revisionOf([runtime.snapshotVersion, runtime.receivedAt, runtime.rootGeneration]),
        displayName: runtime.agentDisplayName ?? runtime.agentScopeId,
        assetType: 'workload',
        bindingQuality: 'exact',
        workloadRole: 'unknown',
        classification: runtime.classification,
        conflict: true,
        sharedScope: [...servicePhysical].some((id) => relatedPhysicalWorkload(id, runtime.physicalWorkloadId!)),
        workload,
        instanceCount: 1,
        nodeIds: [workload.nodeId].filter((value): value is string => Boolean(value)),
        continuity: continuity(true, service),
      });
    }

    for (const item of agentInventory.items) {
      const workload = agentWorkload(item);
      if (!workload) continue;
      const review = this.assetReviews.current(item.agentAssetId);
      const classification = review?.decision ?? item.classification;
      assets.push({
        assetId: item.agentAssetId,
        revision: Math.max(1, Number(item.reviewedAt ? Date.parse(item.reviewedAt) : Date.parse(item.metadataUpdatedAt ?? item.lastSeen)) || 1),
        displayName: item.displayName ?? item.detectedName ?? item.agentId,
        assetType: 'workload',
        bindingQuality: item.reviewDecision || review ? 'exact' : 'ephemeral',
        workloadRole: classification === 'confirmed_agent' || classification === 'probable_agent'
          ? 'unknown'
          : 'ordinary_process',
        classification,
        conflict: item.attributionEvidence.some((evidence) => evidence.includes('conflict')),
        sharedScope: [...servicePhysical].some((id) => relatedPhysicalWorkload(id, workload.physicalWorkloadId)),
        workload: { ...workload, classification },
        instanceCount: Math.max(1, item.instanceCount),
        nodeIds: [workload.nodeId].filter((value): value is string => Boolean(value)),
        recentLogicalEvents: item.eventCount,
        continuity: continuity(currentPresence(workload.physicalWorkloadId), serviceForPhysical(workload.physicalWorkloadId)),
      });
    }

    const uniqueAssets = [...new Map(assets.map((asset) => [asset.assetId, asset])).values()]
      .slice(0, MAX_SNAPSHOT_ASSETS);
    const errors: string[] = [];
    const partialReasons: string[] = [];
    if (!serviceInventory.ready) errors.push('service_inventory_not_ready');
    if (serviceInventory.errors > 0) errors.push('service_inventory_errors');
    if (!workloadInventory.ready) errors.push('workload_identity_inventory_not_ready');
    if (workloadInventory.errors > 0) errors.push('workload_identity_inventory_errors');
    if (runtimeInventory.total !== runtimeInventory.items.length) errors.push('agent_runtime_inventory_truncated');
    if (agentInventory.coverage.partial) partialReasons.push('agent_event_inventory_partial');
    if (agentInventory.total > agentInventory.items.length || agentInventory.items.length >= 500) {
      partialReasons.push('agent_event_inventory_truncated');
    }
    const uncoveredAgentFacts = agentInventory.items.filter((item) =>
      (item.classification === 'confirmed_agent' || item.classification === 'probable_agent')
      && (!item.physicalWorkloadId || ![...authoritativeAgentPhysical].some((physical) =>
        relatedPhysicalWorkload(physical, item.physicalWorkloadId!))));
    if (uncoveredAgentFacts.length) partialReasons.push('agent_fact_not_in_current_runtime_inventory');
    if (assets.length > MAX_SNAPSHOT_ASSETS) errors.push('asset_snapshot_capacity_exceeded');
    if (assets.length > uniqueAssets.length) partialReasons.push('asset_snapshot_duplicate_collapsed');
    const sourceTimes = [
      Date.parse(serviceInventory.generatedAt),
      Date.parse(workloadInventory.generatedAt),
      Date.parse(runtimeInventory.updateTime),
    ].filter(Number.isFinite);
    const generatedAt = sourceTimes.length ? Math.min(...sourceTimes) : 0;
    const destructiveReady = errors.length === 0
      && generatedAt > 0
      && now - generatedAt <= 5 * 60_000
      && uncoveredAgentFacts.length === 0
      && (
        authoritativeAgentPhysical.size > 0
        || (!agentInventory.coverage.partial && agentInventory.total === agentInventory.items.length)
      );
    return {
      schemaVersion: 'anysentry.infrastructure_asset_snapshot.v1',
      provider: 'anysentry.observed_asset.server.v1',
      trusted: true,
      ready: serviceInventory.ready && errors.length === 0,
      destructiveReady,
      version: revisionOf([
        serviceInventory.version,
        workloadInventory.version,
        runtimeInventory.items.map((item) => [item.agentInstanceId, item.snapshotVersion, item.runtimeState]),
        this.assetReviews.version(),
      ]),
      generatedAt,
      assets: uniqueAssets,
      ...(errors.length ? { errors } : {}),
      ...(partialReasons.length ? { partialReasons } : {}),
    };
  }
}
