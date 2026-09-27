import { BadRequestException, Injectable } from '@nestjs/common';
import { AggregationService } from './aggregation.service';
import { AlertingService } from './alerting.service';
import { AuditService } from './audit.service';
import { foldLatestEventRevisions } from './event-revision';
import { IngestionSourceService } from './ingestion-source.service';
import { KubeIdentityService } from './kube-identity.service';
import { PrometheusContextService } from './prometheus-context.service';
import { SentryJudgeService } from './sentry-judge.service';
import {
  buildSystemContextBundle,
  systemContextBundleLimits,
  type SystemContextAlertFact,
  type SystemContextBundle,
  type SystemContextBundleLimitsInput,
  type SystemContextChangeFact,
  type SystemContextCollectionQualityFact,
  type SystemContextDependencyFact,
  type SystemContextEvidenceInput,
  type SystemContextMetricFact,
  type SystemContextResourceFact,
  type SystemContextSourceKind,
  type SystemContextSourceStatusInput,
  type SystemContextToolEvidenceFact,
} from './system-context-bundle';
import { resolveTimeWindow } from './time-window';
import type { AgentEventListItem, JudgedEvent, SecurityTimeFilter } from './types';

export interface SystemContextQuery extends SecurityTimeFilter {
  agentAssetId: string;
  /** Optional defense-in-depth selectors; the Asset must still resolve inside both when supplied. */
  agentId?: string;
  workspacePath?: string;
  agentInstanceId?: string;
  invocationId?: string;
  toolCallId?: string;
  limits?: SystemContextBundleLimitsInput;
}

const CONTEXT_EVENT_KIND = 'SystemContext';
const CONTEXT_SOURCE_KINDS = new Set<SystemContextSourceKind>([
  'kubernetes_inventory', 'docker_inventory', 'systemd_inventory', 'agent_adapter',
  'observer', 'observer_aggregate', 'prometheus', 'otel', 'alert_manager',
  'deployment_controller', 'audit_log', 'clickhouse', 'custom',
]);
const RESOURCE_KINDS = new Set<SystemContextResourceFact['kind']>([
  'agent_runtime', 'service', 'database', 'queue', 'external_endpoint', 'host',
  'container', 'pod', 'systemd_unit', 'unknown',
]);
const WORKLOAD_ROLES = new Set<SystemContextResourceFact['role']>([
  'agent', 'anysentry_internal', 'platform_infrastructure', 'business_service',
  'ordinary_process', 'unknown',
]);
const DEPENDENCY_RELATIONS = new Set<SystemContextDependencyFact['relation']>([
  'calls', 'connects', 'queries', 'publishes', 'consumes', 'resolves', 'stores', 'unknown',
]);
const METRIC_KINDS = new Set<SystemContextMetricFact['kind']>(['gauge', 'counter', 'rate', 'histogram_summary']);
const METRIC_STATUSES = new Set<SystemContextMetricFact['status']>(['normal', 'anomalous', 'unknown']);
const ALERT_SEVERITIES = new Set<SystemContextAlertFact['severity']>(['info', 'low', 'medium', 'high', 'critical']);
const ALERT_STATUSES = new Set<SystemContextAlertFact['status']>(['open', 'acknowledged', 'resolved', 'silenced']);
const CHANGE_TYPES = new Set<SystemContextChangeFact['type']>([
  'deployment', 'configuration', 'image', 'restart', 'scale', 'policy', 'unknown',
]);
const CONTEXT_EVENT_READ_LIMIT = 5_000;
const CONTEXT_SOURCE_LOOKUP_LIMIT = 128;
const CONTEXT_TRUST_EVIDENCE = 'server:authenticated-system-context-source';

function text(value: unknown, limit = 500): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= limit ? normalized : undefined;
}

function number(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function boolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return undefined;
}

function attr(event: JudgedEvent, key: string): unknown {
  return event.attributes[key];
}

function attrText(event: JudgedEvent, key: string, limit = 500): string | undefined {
  return text(attr(event, key), limit);
}

function sourceKind(event: JudgedEvent): SystemContextSourceKind {
  const candidate = attrText(event, 'context.source.kind', 80) as SystemContextSourceKind | undefined;
  return candidate && CONTEXT_SOURCE_KINDS.has(candidate) ? candidate : 'custom';
}

function evidenceForEvent(event: JudgedEvent): SystemContextEvidenceInput {
  return {
    sourceId: event.sourceId ?? attrText(event, 'sourceId', 240) ?? 'unknown-source',
    sourceKind: sourceKind(event),
    authority: 'authenticated_ingestion_source',
    recordId: event.eventId,
    observedAt: event.at,
    freshnessTtlMs: number(attr(event, 'context.freshness.ttl_ms')),
    confidence: Math.max(0, Math.min(1, number(attr(event, 'context.association.confidence')) ?? 1)),
    associationMethod: attrText(event, 'context.association.method', 120) ?? 'source_declared_resource_identity',
    inferred: boolean(attr(event, 'context.association.inferred')) ?? false,
  };
}

function idList(value: string | undefined): string[] {
  if (!value) return [];
  return [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))].slice(0, 32);
}

function closed<T extends string>(value: string | undefined, allowed: ReadonlySet<T>, fallback: T): T {
  return value && allowed.has(value as T) ? value as T : fallback;
}

function contextFacts(events: JudgedEvent[]): {
  resources: SystemContextResourceFact[];
  dependencies: SystemContextDependencyFact[];
  metrics: SystemContextMetricFact[];
  alerts: SystemContextAlertFact[];
  changes: SystemContextChangeFact[];
} {
  const resources: SystemContextResourceFact[] = [];
  const dependencies: SystemContextDependencyFact[] = [];
  const metrics: SystemContextMetricFact[] = [];
  const alerts: SystemContextAlertFact[] = [];
  const changes: SystemContextChangeFact[] = [];
  for (const event of events) {
    const type = attrText(event, 'context.fact.type', 40);
    const evidence = evidenceForEvent(event);
    if (type === 'resource') {
      const resourceId = attrText(event, 'context.resource.id', 240);
      const name = attrText(event, 'context.resource.name', 240);
      if (!resourceId || !name) continue;
      resources.push({
        resourceId,
        kind: closed(attrText(event, 'context.resource.kind', 80), RESOURCE_KINDS, 'unknown'),
        role: closed(attrText(event, 'context.resource.role', 80), WORKLOAD_ROLES, 'unknown'),
        name,
        namespace: attrText(event, 'context.resource.namespace', 240),
        environment: attrText(event, 'context.resource.environment', 120),
        physicalWorkloadId: attrText(event, 'context.resource.physical_workload_id', 240),
        validFrom: number(attr(event, 'context.resource.valid_from_ms')) ?? event.at,
        validTo: number(attr(event, 'context.resource.valid_to_ms')),
        evidence,
      });
      continue;
    }
    if (type === 'dependency') {
      const sourceResourceId = attrText(event, 'context.dependency.source_resource_id', 240);
      const targetResourceId = attrText(event, 'context.dependency.target_resource_id', 240);
      if (!sourceResourceId || !targetResourceId) continue;
      dependencies.push({
        edgeId: attrText(event, 'context.dependency.edge_id', 240) ?? event.eventId,
        sourceResourceId,
        targetResourceId,
        relation: closed(attrText(event, 'context.dependency.relation', 80), DEPENDENCY_RELATIONS, 'unknown'),
        firstObservedAt: number(attr(event, 'context.dependency.first_observed_at_ms')) ?? event.at,
        lastObservedAt: number(attr(event, 'context.dependency.last_observed_at_ms')) ?? event.at,
        eventCount: Math.max(1, Math.trunc(number(attr(event, 'context.dependency.event_count')) ?? 1)),
        aggregated: boolean(attr(event, 'context.dependency.aggregated')) ?? false,
        evidence,
      });
      continue;
    }
    if (type === 'metric') {
      const resourceId = attrText(event, 'context.metric.resource_id', 240);
      const name = attrText(event, 'context.metric.name', 240);
      const value = number(attr(event, 'context.metric.value'));
      if (!resourceId || !name || value === undefined) continue;
      metrics.push({
        metricId: attrText(event, 'context.metric.id', 240) ?? event.eventId,
        resourceId,
        name,
        value,
        unit: attrText(event, 'context.metric.unit', 80),
        kind: closed(attrText(event, 'context.metric.kind', 80), METRIC_KINDS, 'gauge'),
        status: closed(attrText(event, 'context.metric.status', 80), METRIC_STATUSES, 'unknown'),
        observedAt: number(attr(event, 'context.metric.observed_at_ms')) ?? event.at,
        evidence,
      });
      continue;
    }
    if (type === 'alert') {
      const resourceIds = idList(attrText(event, 'context.alert.resource_ids', 2_000));
      const title = attrText(event, 'context.alert.title', 500);
      if (!resourceIds.length || !title) continue;
      alerts.push({
        alertId: attrText(event, 'context.alert.id', 240) ?? event.eventId,
        resourceIds,
        agentAssetId: attrText(event, 'context.alert.agent_asset_id', 240),
        title,
        severity: closed(attrText(event, 'context.alert.severity', 40), ALERT_SEVERITIES, 'info'),
        status: closed(attrText(event, 'context.alert.status', 40), ALERT_STATUSES, 'open'),
        firstSeenAt: number(attr(event, 'context.alert.first_seen_at_ms')) ?? event.at,
        lastSeenAt: number(attr(event, 'context.alert.last_seen_at_ms')) ?? event.at,
        evidence,
      });
      continue;
    }
    if (type === 'change') {
      const resourceIds = idList(attrText(event, 'context.change.resource_ids', 2_000));
      const summary = attrText(event, 'context.change.summary', 500);
      if (!resourceIds.length || !summary) continue;
      changes.push({
        changeId: attrText(event, 'context.change.id', 240) ?? event.eventId,
        resourceIds,
        agentAssetId: attrText(event, 'context.change.agent_asset_id', 240),
        type: closed(attrText(event, 'context.change.type', 80), CHANGE_TYPES, 'unknown'),
        summary,
        at: number(attr(event, 'context.change.at_ms')) ?? event.at,
        evidence,
      });
    }
  }
  return { resources, dependencies, metrics, alerts, changes };
}

function topologyResourceKind(type: string): SystemContextResourceFact['kind'] {
  if (type === 'agent') return 'agent_runtime';
  if (type === 'collector') return 'host';
  if (type === 'network' || type === 'llm') return 'external_endpoint';
  return 'unknown';
}

function topologyRelation(type: string): SystemContextDependencyFact['relation'] {
  if (type === 'connects') return 'connects';
  if (type === 'resolves') return 'resolves';
  if (type === 'calls_llm' || type === 'executes') return 'calls';
  return 'unknown';
}

function isoMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function latestFinite(values: Array<number | undefined>): number | undefined {
  const finiteValues = values.filter((value): value is number => Number.isFinite(value));
  return finiteValues.length ? Math.max(...finiteValues) : undefined;
}

@Injectable()
export class SystemContextService {
  constructor(
    private readonly aggregation: AggregationService,
    private readonly judge: SentryJudgeService,
    private readonly alerting: AlertingService,
    private readonly audit: AuditService,
    private readonly sources: IngestionSourceService,
    private readonly kube: KubeIdentityService,
    private readonly prometheus: PrometheusContextService,
  ) {}

  private managedContextEvents(
    events: JudgedEvent[],
    workspacePath: string,
  ): { events: JudgedEvent[]; truncated: boolean } {
    const managed = new Map<string, boolean>();
    const accepted: JudgedEvent[] = [];
    let truncated = false;
    for (const event of events) {
      if (event.eventKind !== CONTEXT_EVENT_KIND || event.workspacePath !== workspacePath) continue;
      // Current Source metadata alone is insufficient: a record written before a Source received
      // this capability must not become trusted retroactively. The server-only ingest marker binds
      // the fact to the authorization decision made when that immutable event was accepted.
      if (
        event.attribution?.monitored !== false ||
        event.attribution?.classification !== 'non_agent' ||
        !event.attribution.evidence?.includes(CONTEXT_TRUST_EVIDENCE)
      ) continue;
      const sourceId = event.sourceId ?? attrText(event, 'sourceId', 240);
      if (!sourceId) continue;
      const cached = managed.get(sourceId);
      if (cached !== undefined) {
        if (cached) accepted.push(event);
        continue;
      }
      // Context queries are not a Source-directory scan. Cap distinct Source lookups and surface
      // the omitted producers as partial coverage rather than silently claiming completeness.
      if (managed.size >= CONTEXT_SOURCE_LOOKUP_LIMIT) {
        truncated = true;
        continue;
      }
      const source = this.sources.list({ sourceId, limit: 1 }).items[0];
      const trusted = Boolean(
        source && source.sourceId === sourceId && source.enabled && source.requireToken &&
        !source.discovered && source.tags.includes('system-context'),
      );
      managed.set(sourceId, trusted);
      if (trusted) accepted.push(event);
    }
    return { events: accepted, truncated };
  }

  async build(query: SystemContextQuery): Promise<SystemContextBundle> {
    const agentAssetId = text(query.agentAssetId, 240);
    if (!agentAssetId) throw new BadRequestException('a valid agentAssetId is required');
    const requestedWindow = resolveTimeWindow(query);
    const limits = systemContextBundleLimits(query.limits);
    const queryStartMs = Math.max(
      requestedWindow.startMs,
      requestedWindow.endMs - limits.maxWindowMs,
    );
    const window = {
      ...requestedWindow,
      startMs: queryStartMs,
      spanMs: Math.max(1, requestedWindow.endMs - queryStartMs),
    };
    // Clamp before touching any backing plane. Letting the Builder crop a 30-day query after all
    // stores had already scanned it would satisfy the response shape but not the operational bound.
    const boundedQuery: SystemContextQuery = {
      ...query,
      timeType: 'custom',
      startTime: new Date(window.startMs).toISOString(),
      endTime: new Date(window.endMs).toISOString(),
      snapshotAsOf: new Date(window.endMs).toISOString(),
    };
    const requestedWorkspacePath = text(query.workspacePath, 500);
    const inventory = await this.aggregation.storedAgentInventory({
      ...boundedQuery,
      scope: 'raw',
      // Asset-pinned read models intentionally keep the primary object even when contextual
      // filters differ. When workspace is explicit, query that bounded workspace first and match
      // the canonical Asset locally; otherwise the pin would bypass the trust boundary.
      agentAssetId: requestedWorkspacePath ? undefined : agentAssetId,
      workspacePath: requestedWorkspacePath,
      limit: requestedWorkspacePath ? 100 : 2,
    });
    const agent = inventory.items.find((item) =>
      item.agentAssetId === agentAssetId &&
      (!requestedWorkspacePath || item.workspacePath === requestedWorkspacePath));
    if (!agent) throw new BadRequestException('agentAssetId was not observed in the requested window');
    const physicalWorkloadId = agent.physicalWorkloadId;
    const focusResourceId = physicalWorkloadId ?? `agent-asset:${agentAssetId}`;
    const kubeInventory = this.kube.serviceInventory();
    // Kubernetes snapshots represent current state. They may enrich a current investigation, but
    // must never be projected backwards into an older historical window as if they existed then.
    const kubeInventoryApplicable = window.endMs >= Date.now() - 5 * 60_000;
    const kubeAssets = kubeInventoryApplicable ? kubeInventory.items : [];
    const kubeAssetById = new Map(kubeAssets.map((asset) => [asset.serviceAssetId, asset]));
    const agentServiceAsset = this.kube.serviceForPhysicalWorkload(physicalWorkloadId);
    const kubeResources: SystemContextResourceFact[] = kubeAssets.map((asset) => ({
      resourceId: asset.serviceAssetId,
      kind: asset.kind,
      role: asset.role,
      name: asset.name,
      namespace: asset.namespace,
      environment: `kubernetes:${asset.clusterId}`,
      physicalWorkloadId: asset.physicalWorkloadIds[0],
      validFrom: window.startMs,
      validTo: window.endMs,
      evidence: {
        sourceId: `kubernetes:${asset.clusterId}`,
        sourceKind: 'kubernetes_inventory',
        authority: 'server_inventory',
        recordId: asset.serviceAssetId,
        observedAt: asset.observedAt,
        freshnessTtlMs: 5 * 60_000,
        confidence: asset.role === 'unknown' ? 0.7 : 1,
        associationMethod: 'stable_kubernetes_service_identity',
        inferred: asset.role === 'unknown',
      },
    }));
    const kubeMetrics: SystemContextMetricFact[] = kubeAssets.flatMap((asset) =>
      asset.metrics.map((metric) => ({
        metricId: `${asset.serviceAssetId}:${metric.name}`,
        resourceId: asset.serviceAssetId,
        name: metric.name,
        value: metric.value,
        unit: metric.unit,
        kind: 'gauge',
        status: metric.status,
        observedAt: metric.observedAt,
        evidence: {
          sourceId: `kubernetes:${asset.clusterId}`,
          sourceKind: 'kubernetes_inventory',
          authority: 'server_inventory',
          recordId: `${asset.serviceAssetId}:${metric.name}`,
          observedAt: metric.observedAt,
          freshnessTtlMs: 5 * 60_000,
          confidence: 1,
          associationMethod: `kubernetes_${metric.category}_fact`,
          inferred: false,
        },
      })),
    );
    const prometheusMetrics = this.prometheus.metricsForAssets(kubeAssets, window.endMs);
    const kubeDependencies: SystemContextDependencyFact[] = kubeInventoryApplicable
      ? kubeInventory.dependencies.map((edge) => ({
          edgeId: edge.edgeId,
          sourceResourceId: edge.sourceServiceAssetId,
          targetResourceId: edge.targetServiceAssetId,
          relation: edge.relation,
          firstObservedAt: edge.observedAt,
          lastObservedAt: edge.observedAt,
          eventCount: 1,
          aggregated: true,
          evidence: {
            sourceId: 'kubernetes-declared-dependencies',
            sourceKind: 'kubernetes_inventory',
            authority: 'server_inventory',
            recordId: edge.edgeId,
            observedAt: edge.observedAt,
            freshnessTtlMs: 5 * 60_000,
            confidence: edge.confidence,
            associationMethod: edge.source,
            inferred: false,
          },
        }))
      : [];
    const kubeChanges: SystemContextChangeFact[] = kubeInventory.changes
      .filter((change) => change.at >= window.startMs && change.at <= window.endMs)
      .map((change) => ({
        changeId: change.changeId,
        resourceIds: [change.serviceAssetId],
        type: change.type,
        summary: change.summary,
        at: change.at,
        evidence: {
          sourceId: 'kubernetes-workload-watch',
          sourceKind: 'deployment_controller',
          authority: 'server_inventory',
          recordId: change.revision,
          observedAt: change.at,
          freshnessTtlMs: Math.max(5 * 60_000, window.spanMs),
          confidence: 1,
          associationMethod: 'kubernetes_revision_transition',
          inferred: false,
        },
      }));

    // ClickHouseStore deliberately allows one wide event read at a time. Run these bounded views
    // sequentially so the context request never makes its own queries fail fast against that slot.
    const toolResponse = query.invocationId
      ? await this.aggregation.agentToolEvidence({
          ...boundedQuery,
          scope: 'raw',
          invocationId: query.invocationId,
          toolCallId: query.toolCallId,
          agentAssetId,
          workspacePath: agent.workspacePath,
          limit: 1_000,
        })
      : undefined;
    const topology = await this.aggregation.storedAgentTopology({
      ...boundedQuery,
      scope: 'raw',
      agentAssetId,
      agentInstanceId: query.agentInstanceId,
      includeBenign: true,
      limit: 2_000,
    });
    const instanceMetrics = await this.aggregation.storedAgentInstanceMetrics({
      ...boundedQuery,
      agentAssetId,
      agentInstanceId: query.agentInstanceId,
      seriesPoints: 24,
    });

    const durablePage = this.judge.storageStatus().clickhouseReady
      ? await this.judge.searchStoredEventsPage({
          sinceMs: window.startMs,
          untilMs: window.endMs,
          eventKind: CONTEXT_EVENT_KIND,
          workspacePath: agent.workspacePath,
          limit: 5_000,
        })
      : { events: [], hasMore: false, unavailable: true };
    const hotCandidates = this.judge.queryRecentRange(
      window.startMs,
      window.endMs,
      CONTEXT_EVENT_READ_LIMIT + 1,
    );
    const hotReadTruncated = hotCandidates.length > CONTEXT_EVENT_READ_LIMIT;
    const hot = hotCandidates
      .slice(-CONTEXT_EVENT_READ_LIMIT)
      .filter((event) => event.workspacePath === agent.workspacePath);
    const managedContext = this.managedContextEvents(
      foldLatestEventRevisions([...durablePage.events, ...hot]),
      agent.workspacePath,
    );
    const contextEvents = managedContext.events;
    const contextReadPartial = Boolean(
      durablePage.hasMore || durablePage.unavailable || hotReadTruncated || managedContext.truncated
    );
    const contextReadReason = durablePage.unavailable
      ? 'context_storage_unavailable'
      : durablePage.hasMore || hotReadTruncated
        ? 'context_event_scan_limit'
        : managedContext.truncated
          ? 'context_source_lookup_limit'
          : undefined;
    const provided = contextFacts(contextEvents);

    const nodeResourceId = new Map<string, string>();
    const topologyResources: SystemContextResourceFact[] = topology.nodes.map((node) => {
      const endpointService = node.type === 'network'
        ? this.kube.resolveServiceEndpoint(node.label, agent.workloadRef?.namespace) ??
          this.kube.resolveServiceEndpoint(node.label)
        : undefined;
      const mappedService = endpointService
        ? kubeAssetById.get(endpointService.serviceAssetId) ?? endpointService
        : undefined;
      const resourceId = node.type === 'agent' && node.agentAssetId === agentAssetId
        ? focusResourceId
        : mappedService?.serviceAssetId ?? node.nodeId;
      nodeResourceId.set(node.nodeId, resourceId);
      const observedAt = isoMs(node.lastSeen) ?? window.endMs;
      if (mappedService) {
        return {
          resourceId,
          kind: mappedService.kind,
          role: mappedService.role,
          name: mappedService.name,
          namespace: mappedService.namespace,
          environment: `kubernetes:${mappedService.clusterId}`,
          physicalWorkloadId: mappedService.physicalWorkloadIds[0],
          validFrom: window.startMs,
          validTo: window.endMs,
          evidence: {
            sourceId: `kubernetes:${mappedService.clusterId}`,
            sourceKind: 'kubernetes_inventory',
            authority: 'server_inventory',
            recordId: mappedService.serviceAssetId,
            observedAt: mappedService.observedAt,
            freshnessTtlMs: 5 * 60_000,
            confidence: 1,
            associationMethod: 'event_endpoint_to_kubernetes_service',
            inferred: false,
          },
        };
      }
      return {
        resourceId,
        kind: topologyResourceKind(node.type),
        role: node.type === 'agent' ? 'agent' : 'unknown',
        name: node.label,
        physicalWorkloadId: node.type === 'agent' ? physicalWorkloadId : undefined,
        validFrom: window.startMs,
        validTo: window.endMs,
        evidence: {
          sourceId: 'anysentry-event-topology',
          sourceKind: 'clickhouse',
          authority: 'server_event_projection',
          recordId: node.nodeId,
          observedAt,
          freshnessTtlMs: Math.max(60_000, window.spanMs),
          confidence: node.type === 'agent' ? 1 : 0.7,
          associationMethod: 'event_topology_projection',
          inferred: node.type !== 'agent',
        },
      };
    });
    const topologyDependencies: SystemContextDependencyFact[] = topology.edges.flatMap((edge) => {
      const sourceResourceId = nodeResourceId.get(edge.sourceNodeId);
      const targetResourceId = nodeResourceId.get(edge.targetNodeId);
      if (!sourceResourceId || !targetResourceId) return [];
      const observedAt = isoMs(edge.lastSeen) ?? window.endMs;
      const inventoryMapped = kubeAssetById.has(targetResourceId);
      return [{
        edgeId: edge.edgeId,
        sourceResourceId,
        targetResourceId,
        relation: topologyRelation(edge.type),
        firstObservedAt: window.startMs,
        lastObservedAt: observedAt,
        eventCount: edge.eventCount,
        aggregated: true,
        evidence: {
          sourceId: 'anysentry-event-topology',
          sourceKind: 'clickhouse',
          authority: 'server_event_projection',
          recordId: edge.edgeId,
          observedAt,
          freshnessTtlMs: Math.max(60_000, window.spanMs),
          confidence: inventoryMapped ? 0.95 : 0.7,
          associationMethod: inventoryMapped
            ? 'aggregated_event_edge_with_exact_endpoint_inventory'
            : 'aggregated_event_edge',
          inferred: !inventoryMapped,
        },
      }];
    });

    const toolEvidence: SystemContextToolEvidenceFact[] = (toolResponse?.items ?? []).map((tool) => ({
      agentAssetId,
      agentRuntimeInstanceId: query.agentInstanceId,
      invocationId: tool.invocationId,
      toolCallId: tool.toolCallId,
      toolName: tool.toolName,
      status: tool.status,
      reason: tool.reason,
      startedAt: tool.startedAt,
      endedAt: tool.endedAt,
      adapterEventIds: tool.adapterEventIds,
      kernelEvidence: tool.kernelEvidence.map((item) => ({
        ...item,
        evidence: {
          sourceId: 'anysentry-observer-evidence',
          sourceKind: 'observer',
          authority: 'attested_observer',
          recordId: item.eventId,
          observedAt: item.at,
          freshnessTtlMs: Math.max(60_000, window.spanMs),
          confidence: item.confidence,
          associationMethod: item.linkMethod,
          inferred: false,
        },
      })),
      evidence: {
        sourceId: 'anysentry-agent-adapter',
        sourceKind: 'agent_adapter',
        authority: 'authenticated_agent_adapter',
        recordId: tool.adapterEventIds[0],
        observedAt: tool.endedAt ?? tool.startedAt ?? window.endMs,
        freshnessTtlMs: Math.max(60_000, window.spanMs),
        confidence: tool.status === 'linked' ? 1 : tool.status === 'ambiguous' ? 0.5 : 0.8,
        associationMethod: tool.reason,
        inferred: false,
      },
    }));

    const metricFacts: SystemContextMetricFact[] = instanceMetrics.points.slice(-24).map((point, index) => ({
      metricId: `agent-events:${agentAssetId}:${index}:${point.statTime}`,
      resourceId: focusResourceId,
      name: 'anysentry.agent.event_count',
      value: point.eventCount,
      unit: 'events',
      kind: 'gauge',
      status: point.riskyEventCount > 0 ? 'anomalous' : 'normal',
      observedAt: Date.parse(point.statTime),
      evidence: {
        sourceId: 'anysentry-event-metrics',
        sourceKind: 'clickhouse',
        authority: 'server_event_projection',
        recordId: point.statTime,
        observedAt: Date.parse(point.statTime),
        freshnessTtlMs: Math.max(60_000, window.spanMs),
        confidence: 1,
        associationMethod: 'exact_agent_asset',
        inferred: false,
      },
    }));

    const focusAt = toolEvidence.length
      ? Math.max(...toolEvidence.map((item) => item.endedAt ?? item.startedAt ?? window.endMs))
      : window.endMs;
    const coverageAggregation = this.aggregation as AggregationService & {
      storedCoverageOverview?: (filter: import('./types').CoverageQuery) => Promise<import('./types').CoverageOverview>;
    };
    if (typeof coverageAggregation.storedCoverageOverview === 'function') {
      const currentCoverage = await coverageAggregation.storedCoverageOverview({
        ...boundedQuery,
        workspacePath: agent.workspacePath,
        agentId: agent.agentId,
        limit: 500,
      });
      if (currentCoverage.coverage?.partial !== true) {
        this.alerting.observeCoverageList(currentCoverage.issues, Date.now(), {
          resolveMissing: true,
          scope: { workspacePath: agent.workspacePath, agentId: agent.agentId },
        });
      }
    }
    const alertItems = this.alerting.list({
      ...boundedQuery,
      timeMode: 'combined',
      status: 'all',
      agentId: agent.agentId,
      workspacePath: agent.workspacePath,
      limit: 100,
    }).items.filter((item) => {
      const firstSeenAt = Date.parse(item.firstSeenAt);
      const resolvedAt = item.resolvedAt ? Date.parse(item.resolvedAt) : undefined;
      return firstSeenAt <= focusAt && !(resolvedAt !== undefined && resolvedAt <= focusAt);
    });
    const alertFacts: SystemContextAlertFact[] = alertItems.map((item) => ({
      alertId: item.alertId,
      resourceIds: [focusResourceId],
      agentAssetId,
      title: item.title,
      severity: item.severity,
      // A later resolution must not rewrite the state at the focused Invocation time.
      status: item.status === 'resolved' ? 'open' : item.status,
      firstSeenAt: Date.parse(item.firstSeenAt),
      lastSeenAt: Date.parse(item.lastSeenAt),
      evidence: {
        sourceId: 'anysentry-alerting',
        sourceKind: 'alert_manager',
        authority: 'server_alert_projection',
        recordId: item.alertId,
        observedAt: Date.parse(item.lastSeenAt),
        freshnessTtlMs: Math.max(60_000, window.spanMs),
        confidence: 1,
        associationMethod: 'exact_agent_asset',
        inferred: false,
      },
    }));

    const auditItems = this.audit.list({
      ...boundedQuery,
      resourceType: 'agent',
      resourceId: agent.agentId,
      limit: 100,
    }).items;
    const changeFacts: SystemContextChangeFact[] = auditItems.map((item) => ({
      changeId: item.auditId,
      resourceIds: [focusResourceId],
      agentAssetId,
      type: item.action.includes('policy') ? 'policy' : 'configuration',
      summary: item.summary,
      at: Date.parse(item.at),
      evidence: {
        sourceId: 'anysentry-audit',
        sourceKind: 'audit_log',
        authority: 'server_audit_record',
        recordId: item.auditId,
        observedAt: Date.parse(item.at),
        freshnessTtlMs: Math.max(60_000, window.spanMs),
        confidence: 1,
        associationMethod: 'exact_agent_resource',
        inferred: false,
      },
    }));

    const collectionQuality: SystemContextCollectionQualityFact[] = [];
    for (const collectorId of (agent.collectorIds ?? []).slice(0, 8)) {
      const health = await this.aggregation.storedCollectorHealth({
        ...boundedQuery,
        collectorId,
        state: 'all',
        limit: 1,
      });
      const item = health.items[0];
      if (!item) continue;
      const accounting = item.pipelineAccounting?.window;
      // These S5 counters are additive during a rolling API/Forwarder upgrade. The cast keeps S7
      // source-compatible with an older API reader; absence is explicitly treated as unknown/zero.
      const captureMetrics = item.filterMetrics as typeof item.filterMetrics & {
        captureAggregateOutputs?: number;
        captureProfileLkgDegraded?: number;
        captureProfileAckRejected?: number;
      };
      collectionQuality.push({
        collectorId,
        windowStartMs: window.startMs,
        windowEndMs: window.endMs,
        rawKernelDetail: captureMetrics.captureAggregateOutputs ? 'mixed' : 'full',
        accountingConserved: accounting
          ? (accounting.collectorHandoffResidual ?? 0) === 0 && accounting.logicalResidual === 0
          : false,
        ringDropped: accounting?.ringDropped ?? item.droppedEvents,
        collectorDropped: accounting?.collectorDropped ?? 0,
        queueDropped: accounting?.queueDropped ?? item.outputDropped,
        aggregateSummariesIncomplete: Boolean(
          captureMetrics.captureProfileLkgDegraded || captureMetrics.captureProfileAckRejected,
        ),
        evidence: {
          sourceId: collectorId,
          sourceKind: 'observer',
          authority: 'collector_pipeline_accounting',
          recordId: item.lastHeartbeatAt,
          observedAt: isoMs(item.lastHeartbeatAt) ?? window.endMs,
          freshnessTtlMs: 3 * 60_000,
          confidence: accounting ? 1 : 0.5,
          associationMethod: 'exact_collector_id',
          inferred: false,
        },
      });
    }

    const sourceStatus: SystemContextSourceStatusInput[] = [
      {
        domain: 'inventory', sourceId: 'anysentry-kubernetes-service-inventory', sourceKind: 'kubernetes_inventory',
        state: !kubeInventoryApplicable
          ? 'partial'
          : kubeInventory.ready
            ? 'complete'
            : 'partial',
        checkedAt: window.endMs,
        lastObservedAt: latestFinite(kubeAssets.map((item) => item.observedAt)),
        freshnessTtlMs: 5 * 60_000,
        required: true,
        reason: !kubeInventoryApplicable
          ? 'current_inventory_not_projected_into_historical_window'
          : kubeInventory.ready
            ? undefined
            : 'kubernetes_inventory_partial',
      },
      {
        domain: 'inventory', sourceId: 'anysentry-agent-inventory', sourceKind: 'clickhouse',
        state: agent ? 'complete' : 'unavailable', checkedAt: window.endMs,
        lastObservedAt: Date.parse(agent.lastSeen), freshnessTtlMs: Math.max(60_000, window.spanMs), required: true,
      },
      {
        domain: 'tool_evidence', sourceId: 'anysentry-tool-evidence', sourceKind: 'agent_adapter',
        state: query.invocationId ? (toolResponse?.partial ? 'partial' : 'complete') : 'partial',
        checkedAt: window.endMs, lastObservedAt: toolEvidence.at(-1)?.endedAt, freshnessTtlMs: Math.max(60_000, window.spanMs),
        required: Boolean(query.invocationId), reason: query.invocationId ? undefined : 'invocation_not_selected',
      },
      {
        domain: 'topology', sourceId: 'anysentry-event-topology', sourceKind: 'clickhouse',
        state: topology.coverage.partial ? 'partial' : 'complete', checkedAt: window.endMs,
        lastObservedAt: topology.edges.length ? Math.max(...topology.edges.map((edge) => isoMs(edge.lastSeen) ?? 0)) : undefined,
        freshnessTtlMs: Math.max(60_000, window.spanMs), required: true,
      },
      {
        domain: 'metrics', sourceId: 'anysentry-otel-context-metrics', sourceKind: 'otel',
        state: provided.metrics.length ? (contextReadPartial ? 'partial' : 'complete') : 'partial',
        checkedAt: window.endMs, lastObservedAt: latestFinite(provided.metrics.map((item) => item.observedAt)),
        freshnessTtlMs: 5 * 60_000, required: true,
        truncated: contextReadPartial,
        reason: contextReadReason ?? (provided.metrics.length ? undefined : 'external_service_metrics_unavailable'),
      },
      this.prometheus.sourceStatus(window.endMs),
      {
        domain: 'metrics', sourceId: 'anysentry-kubernetes-service-metrics', sourceKind: 'kubernetes_inventory',
        state: kubeMetrics.length ? (kubeInventory.ready ? 'complete' : 'partial') : 'partial',
        checkedAt: window.endMs,
        lastObservedAt: latestFinite(kubeMetrics.map((item) => item.observedAt)),
        freshnessTtlMs: 5 * 60_000,
        required: true,
        reason: kubeMetrics.length ? undefined : 'kubernetes_service_metrics_unavailable',
      },
      {
        domain: 'alerts', sourceId: 'anysentry-alerting', sourceKind: 'alert_manager',
        state: 'complete', checkedAt: window.endMs,
        lastObservedAt: alertFacts.length ? Math.max(...alertFacts.map((item) => item.lastSeenAt)) : undefined,
        freshnessTtlMs: Math.max(60_000, window.spanMs), required: false,
      },
      {
        domain: 'changes', sourceId: 'anysentry-context-changes', sourceKind: 'deployment_controller',
        state: provided.changes.length ? (contextReadPartial ? 'partial' : 'complete') : 'partial',
        checkedAt: window.endMs, lastObservedAt: latestFinite(provided.changes.map((item) => item.at)),
        freshnessTtlMs: Math.max(60_000, window.spanMs), required: true,
        truncated: contextReadPartial,
        reason: contextReadReason ?? (provided.changes.length ? undefined : 'deployment_change_feed_unavailable'),
      },
      {
        domain: 'collection_quality', sourceId: 'anysentry-pipeline-accounting', sourceKind: 'observer',
        state: collectionQuality.length ? 'complete' : 'partial', checkedAt: window.endMs,
        lastObservedAt: collectionQuality.at(-1)?.windowEndMs, freshnessTtlMs: 3 * 60_000, required: true,
      },
      ...(['inventory', 'topology', 'metrics', 'alerts', 'changes'] as const).map((domain): SystemContextSourceStatusInput => ({
        domain,
        sourceId: 'anysentry-system-context-event-feed',
        sourceKind: 'custom',
        state: contextReadPartial ? 'partial' : 'complete',
        checkedAt: window.endMs,
        lastObservedAt: latestFinite(contextEvents.map((event) => event.at)),
        freshnessTtlMs: Math.max(60_000, window.spanMs),
        required: false,
        truncated: contextReadPartial,
        recordsRead: contextEvents.length,
        reason: contextReadReason,
      })),
    ];

    return buildSystemContextBundle({
      focus: {
        agentAssetId,
        agentRuntimeInstanceId: query.agentInstanceId ?? agent.agentInstanceId,
        invocationId: query.invocationId,
        toolCallId: query.toolCallId,
        physicalWorkloadId,
        relatedResourceIds: [
          focusResourceId,
          ...(agentServiceAsset ? [agentServiceAsset.serviceAssetId] : []),
        ],
        evidence: {
          sourceId: 'anysentry-agent-inventory',
          sourceKind: 'clickhouse',
          authority: 'server_identity_projection',
          recordId: agent.lastEventId,
          observedAt: Date.parse(agent.lastSeen),
          freshnessTtlMs: Math.max(60_000, window.spanMs),
          confidence: agent.confidence,
          associationMethod: 'agent_asset_resolver',
          inferred: false,
        },
      },
      window: { startMs: requestedWindow.startMs, endMs: requestedWindow.endMs },
      expectedDomains: query.invocationId
        ? ['inventory', 'tool_evidence', 'topology', 'metrics', 'alerts', 'changes', 'collection_quality']
        : ['inventory', 'topology', 'metrics', 'alerts', 'changes', 'collection_quality'],
      toolEvidence,
      // Authenticated service-context facts must enter the bounded candidate set before noisy
      // kernel-derived topology and built-in Agent series. Otherwise a busy Runtime can consume
      // the scan budget and erase the very business context that remains after raw syscalls are
      // aggregated. The builder still enforces every per-domain and total byte limit.
      resources: [...provided.resources, ...kubeResources, ...topologyResources],
      dependencies: [...provided.dependencies, ...kubeDependencies, ...topologyDependencies],
      metrics: [...provided.metrics, ...prometheusMetrics, ...kubeMetrics, ...metricFacts],
      alerts: [
        ...provided.alerts.filter((item) => item.status !== 'resolved' && item.firstSeenAt <= focusAt),
        ...alertFacts,
      ],
      changes: [...provided.changes, ...kubeChanges, ...changeFacts],
      collectionQuality,
      sourceStatus,
      limits: query.limits,
    }, requestedWindow.endMs);
  }
}

export const __testing = { contextFacts };
