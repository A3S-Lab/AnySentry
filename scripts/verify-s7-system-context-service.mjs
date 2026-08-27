import assert from 'node:assert/strict';

import { SystemContextService } from '../apps/api/dist/security-monitoring/system-context.service.js';

const end = Date.now() - 1_000;
const start = end - 15 * 60_000;
const assetId = 'agent-asset-s7';
const workloadId = 'workload:agent-s7';

function contextEvent(id, factType, attributes, sourceId = 'managed-context-source') {
  return {
    schemaVersion: 'anysentry.agent_event.v1',
    eventId: id,
    at: end - 60_000,
    eventKind: 'SystemContext',
    eventCategory: 'runtime',
    source: 'api',
    subject: `${factType} context fact`,
    workspacePath: '/workspace/s7',
    agentId: 'context-producer',
    sourceId,
    sessionId: 'context-session',
    userId: 'system',
    traceId: 'legacy-context-trace',
    spanId: `span-${id}`,
    runId: 'context-run',
    verdict: 'allow',
    tier: 'Rules',
    severity: 'info',
    reason: 'observed',
    riskCategory: 'benign',
    riskName: 'Normal',
    riskType: 'atomic',
    riskScore: 0,
    tokenCount: 0,
    latencyMs: 1,
    attributes: {
      sourceId,
      'context.fact.type': factType,
      'context.source.kind': 'otel',
      'context.association.confidence': 0.99,
      'context.association.method': 'exact_resource_identity',
      ...attributes,
    },
    attribution: {
      monitored: false,
      classification: 'non_agent',
      confidence: 1,
      reason: 'not_agent',
      source: 'self_register',
      evidence: ['server:authenticated-system-context-source'],
    },
  };
}

const contextEvents = [
  contextEvent('resource-business', 'resource', {
    'context.resource.id': 'service:business-api',
    'context.resource.kind': 'service',
    'context.resource.role': 'business_service',
    'context.resource.name': 'business-api',
    'context.resource.namespace': 'production',
  }),
  contextEvent('resource-clickhouse', 'resource', {
    'context.resource.id': 'database:clickhouse',
    'context.resource.kind': 'database',
    'context.resource.role': 'platform_infrastructure',
    'context.resource.name': 'clickhouse',
  }),
  contextEvent('edge-agent-business', 'dependency', {
    'context.dependency.edge_id': 'edge:agent-business',
    'context.dependency.source_resource_id': workloadId,
    'context.dependency.target_resource_id': 'service:business-api',
    'context.dependency.relation': 'calls',
    'context.dependency.event_count': 50,
    'context.dependency.aggregated': true,
  }),
  contextEvent('edge-business-db', 'dependency', {
    'context.dependency.edge_id': 'edge:business-db',
    'context.dependency.source_resource_id': 'service:business-api',
    'context.dependency.target_resource_id': 'database:clickhouse',
    'context.dependency.relation': 'queries',
    'context.dependency.event_count': 200,
    'context.dependency.aggregated': true,
  }),
  contextEvent('metric-business-errors', 'metric', {
    'context.metric.id': 'metric:business-errors',
    'context.metric.resource_id': 'service:business-api',
    'context.metric.name': 'http.server.error_rate',
    'context.metric.value': 0.2,
    'context.metric.unit': 'ratio',
    'context.metric.kind': 'rate',
    'context.metric.status': 'anomalous',
  }),
  contextEvent('change-business-v2', 'change', {
    'context.change.id': 'change:business-v2',
    'context.change.resource_ids': 'service:business-api',
    'context.change.type': 'deployment',
    'context.change.summary': 'business-api rolled out v2',
  }),
  contextEvent('alert-business-errors', 'alert', {
    'context.alert.id': 'alert:business-errors',
    'context.alert.resource_ids': 'service:business-api',
    'context.alert.title': 'business-api error rate high',
    'context.alert.severity': 'high',
    'context.alert.status': 'open',
  }),
  contextEvent('untrusted-global-metric', 'metric', {
    'context.metric.id': 'metric:untrusted',
    'context.metric.resource_id': 'service:business-api',
    'context.metric.name': 'must.not.appear',
    'context.metric.value': 999,
  }, 'discovered-untrusted-source'),
  {
    ...contextEvent('missing-server-trust-marker', 'metric', {
      'context.metric.id': 'metric:retroactive-trust',
      'context.metric.resource_id': 'service:business-api',
      'context.metric.name': 'must.not.be.retroactively.trusted',
      'context.metric.value': 123,
    }),
    attribution: { monitored: false, classification: 'non_agent', reason: 'not_agent', source: 'none' },
  },
  {
    ...contextEvent('managed-other-workspace', 'metric', {
      'context.metric.id': 'metric:cross-workspace',
      'context.metric.resource_id': 'service:business-api',
      'context.metric.name': 'must.not.cross.workspace',
      'context.metric.value': 456,
    }),
    workspacePath: '/workspace/other-tenant',
  },
];

let latestInventoryFilter;
const aggregation = {
  async storedAgentInventory(filter) {
    latestInventoryFilter = filter;
    return {
      items: [{
        agentId: 'codex', agentAssetId: assetId, workspacePath: '/workspace/s7', userId: 'uid:1000',
        detectedClassification: 'confirmed_agent', classification: 'confirmed_agent', runtime: 'docker',
        tags: [], instanceCount: 1, confidence: 1, attributionSource: 'process_graph', attributionEvidence: [],
        physicalWorkloadId: workloadId, agentInstanceId: 'runtime-s7', reviewIdentityKeys: [],
        firstSeen: new Date(start).toISOString(), lastSeen: new Date(end).toISOString(), lifecycleState: 'current',
        healthState: 'active', riskLevel: 'safe', riskLevelText: 'Safe', eventCount: 10, riskyEventCount: 1,
        openIncidentCount: 0, sessionCount: 1, runCount: 1, traceCount: 1, tokenCount: 0,
        avgLatencyMs: 1, lastEventSubject: 'context test', lastEventId: 'agent-event-s7',
        collectorIds: ['collector-s7'], eventCategoryCounts: {}, sourceCounts: {},
      }],
      total: 1, summary: {}, coverage: { partial: false }, updateTime: new Date(end).toISOString(),
    };
  },
  async agentToolEvidence() {
    return {
      items: [{
        invocationId: 'invocation-s7', toolCallId: 'tool-s7', toolName: 'write', status: 'linked',
        reason: 'exact_process_and_resource', startedAt: end - 5_000, endedAt: end - 4_000,
        adapterEventIds: ['adapter-tool-s7'], kernelEvidence: [{
          eventId: 'kernel-write-s7', eventKind: 'FileAccess', at: end - 4_500,
          linkMethod: 'same_process_resource', confidence: 1,
        }],
      }],
      partial: false,
    };
  },
  async storedAgentTopology() {
    return {
      nodes: [{
        nodeId: 'topology-agent', type: 'agent', label: 'Codex', agentAssetId: assetId,
        eventCount: 10, riskyEventCount: 1, lastSeen: new Date(end).toISOString(), riskLevel: 'safe', riskLevelText: 'Safe',
      }],
      edges: [], summary: {}, coverage: { partial: false }, updateTime: new Date(end).toISOString(),
    };
  },
  async storedAgentInstanceMetrics() {
    return {
      points: [{ statTime: new Date(end - 30_000).toISOString(), eventCount: 5, riskyEventCount: 1 }],
    };
  },
  async storedCollectorHealth() {
    return {
      items: [{
        collectorId: 'collector-s7', state: 'healthy', filterMetrics: { captureAggregateOutputs: 1 },
        droppedEvents: 0, outputDropped: 0,
        pipelineAccounting: { window: { collectorHandoffResidual: 0, logicalResidual: 0, ringDropped: 0, collectorDropped: 0, queueDropped: 0 } },
        lastHeartbeatAt: new Date(end - 10_000).toISOString(),
      }],
    };
  },
};

const judge = {
  storageStatus: () => ({ clickhouseReady: false }),
  queryRecentRange: (_start, _end, limit) => {
    assert.equal(limit, 5_001, 'System Context hot reads are explicitly bounded');
    return contextEvents;
  },
};
const alerting = {
  list: () => ({ items: [{
    alertId: 'alert-agent-s7', title: 'Agent risk', severity: 'high', status: 'open',
    firstSeenAt: new Date(end - 2 * 60_000).toISOString(), lastSeenAt: new Date(end - 30_000).toISOString(),
  }, {
    alertId: 'alert-resolved-stale-s7', title: 'Recovered coverage', severity: 'high', status: 'resolved',
    firstSeenAt: new Date(end - 10 * 60_000).toISOString(), lastSeenAt: new Date(end - 9 * 60_000).toISOString(),
    resolvedAt: new Date(end - 8 * 60_000).toISOString(),
  }] }),
};
const audit = {
  list: () => ({ items: [{
    auditId: 'audit-agent-s7', action: 'agent.reviewed', summary: 'Agent review changed', at: new Date(end - 3 * 60_000).toISOString(),
  }] }),
};
const sources = {
  list: ({ sourceId }) => ({ items: sourceId === 'managed-context-source' ? [{
    sourceId, enabled: true, requireToken: true, discovered: false, tags: ['system-context'],
  }] : [] }),
};

const kubeItems = [
  { id: 'service:k8s:test:production:anysentry', name: 'anysentry', kind: 'service' },
  { id: 'service:k8s:test:production:clickhouse', name: 'clickhouse', kind: 'database' },
  { id: 'service:k8s:test:production:redis', name: 'redis', kind: 'database' },
].map((item) => ({
  serviceAssetId: item.id, name: item.name, namespace: 'production', clusterId: 'test', kind: item.kind,
  role: 'anysentry_internal', revision: `${item.name}-revision`, images: [`${item.name}:test`],
  replicas: { observed: 1, ready: 1 }, restarts: 0, phaseCounts: { Running: 1 },
  physicalWorkloadIds: item.name === 'anysentry' ? [workloadId] : [`workload:${item.name}`],
  runtimeInstanceIds: [`runtime:${item.name}`], endpointAliases: [item.name, `${item.name}.production.svc`],
  observedAt: end - 10_000,
  metrics: [
    { name: 'kubernetes.replicas.ready_ratio', value: 1, unit: 'ratio', category: 'availability', status: 'normal', observedAt: end - 10_000 },
    { name: 'kubernetes.memory.limit_bytes', value: 1024, unit: 'bytes', category: 'capacity', status: 'unknown', observedAt: end - 10_000 },
  ],
}));
const kube = {
  serviceInventory: () => ({
    schemaVersion: 'anysentry.service_inventory.v1', version: 1, generatedAt: new Date(end).toISOString(),
    ready: true, errors: 0, items: kubeItems,
    dependencies: [
      { edgeId: 'edge:kube-api-clickhouse', sourceServiceAssetId: kubeItems[0].serviceAssetId,
        targetServiceAssetId: kubeItems[1].serviceAssetId, relation: 'queries', source: 'kubernetes_declared_configuration', confidence: 1, observedAt: end - 10_000 },
      { edgeId: 'edge:kube-api-redis', sourceServiceAssetId: kubeItems[0].serviceAssetId,
        targetServiceAssetId: kubeItems[2].serviceAssetId, relation: 'queries', source: 'kubernetes_declared_configuration', confidence: 1, observedAt: end - 10_000 },
    ],
    changes: [{ changeId: 'change:kube-clickhouse-image', serviceAssetId: kubeItems[1].serviceAssetId,
      type: 'image', summary: 'ClickHouse image changed', revision: 'clickhouse-revision', at: end - 20_000 }],
  }),
  serviceForPhysicalWorkload: (id) => id === workloadId ? kubeItems[0] : undefined,
  resolveServiceEndpoint: () => undefined,
};
const prometheus = {
  metricsForAssets: () => [{
    metricId: 'prometheus:clickhouse-up', resourceId: kubeItems[1].serviceAssetId,
    name: 'prometheus.target.up', value: 1, unit: 'boolean', kind: 'gauge', status: 'normal',
    observedAt: end - 5_000, evidence: { sourceId: 'prometheus:test', sourceKind: 'prometheus',
      authority: 'configured_prometheus_api', recordId: 'target-clickhouse', observedAt: end - 5_000,
      freshnessTtlMs: 60_000, confidence: 1, associationMethod: 'prometheus_target_service_labels', inferred: false },
  }],
  sourceStatus: () => ({ domain: 'metrics', sourceId: 'prometheus:test', sourceKind: 'prometheus',
    state: 'complete', checkedAt: end, lastObservedAt: end - 5_000, freshnessTtlMs: 60_000, required: true }),
};

const service = new SystemContextService(aggregation, judge, alerting, audit, sources, kube, prometheus);
const bundle = await service.build({
  timeType: 'custom', startTime: new Date(start).toISOString(), endTime: new Date(end).toISOString(),
  snapshotAsOf: new Date(end).toISOString(), workspacePath: '/workspace/s7',
  agentAssetId: assetId, agentInstanceId: 'runtime-s7',
  invocationId: 'invocation-s7', toolCallId: 'tool-s7',
});

assert.equal(bundle.focus.agentAssetId, assetId);
assert.equal(bundle.focus.invocationId, 'invocation-s7');
assert.equal(bundle.toolEvidence.length, 1);
assert.equal(bundle.toolEvidence[0].kernelEvidence[0].eventId, 'kernel-write-s7');
assert(bundle.relatedResources.some((item) => item.resourceId === 'service:business-api'));
assert(bundle.relatedResources.some((item) => item.resourceId === 'database:clickhouse'));
assert.deepEqual(bundle.dependencies.map((item) => item.edgeId).sort(), [
  'edge:agent-business', 'edge:business-db', 'edge:kube-api-clickhouse', 'edge:kube-api-redis',
]);
assert(bundle.metrics.some((item) => item.name === 'http.server.error_rate' && item.status === 'anomalous'));
assert(!bundle.metrics.some((item) => item.name === 'must.not.appear'), 'unmanaged Source facts are excluded');
assert(!bundle.metrics.some((item) => item.name === 'must.not.be.retroactively.trusted'), 'server ingest marker is required');
assert(!bundle.metrics.some((item) => item.name === 'must.not.cross.workspace'), 'managed facts remain workspace scoped');
assert(bundle.alerts.some((item) => item.alertId === 'alert-agent-s7'));
assert(!bundle.alerts.some((item) => item.alertId === 'alert-resolved-stale-s7'), 'resolved stale alerts do not enter a new risk bundle');
assert(bundle.alerts.some((item) => item.alertId === 'alert:business-errors'));
assert(bundle.changes.some((item) => item.changeId === 'change:business-v2'));
assert(bundle.relatedResources.some((item) => item.resourceId === kubeItems[1].serviceAssetId && item.kind === 'database'));
assert(bundle.relatedResources.some((item) => item.resourceId === kubeItems[2].serviceAssetId && item.name === 'redis'));
assert(bundle.metrics.some((item) => item.resourceId === kubeItems[1].serviceAssetId && item.name === 'kubernetes.replicas.ready_ratio'));
assert(bundle.metrics.some((item) => item.resourceId === kubeItems[1].serviceAssetId && item.name === 'prometheus.target.up'));
assert(bundle.changes.some((item) => item.changeId === 'change:kube-clickhouse-image'));
assert(bundle.collectionQuality.some((item) => item.rawKernelDetail === 'mixed' && item.accountingConserved));
assert.equal(bundle.summary.businessServiceCount, 1);
assert.equal(bundle.summary.maxTopologyHop, 2);
assert(bundle.quality.reasons.some((item) => item.code === 'source_partial' && item.sourceId === 'anysentry-system-context-event-feed'));
assert.equal(latestInventoryFilter.workspacePath, '/workspace/s7');
assert.equal(latestInventoryFilter.agentAssetId, undefined, 'workspace-scoped context lookup does not use asset pin bypass semantics');
assert.equal(latestInventoryFilter.limit, 100);
await assert.rejects(
  service.build({ timeType: 'last_3h', workspacePath: '/workspace/other', agentAssetId: assetId }),
  /agentAssetId was not observed/u,
  'System Context never lets an asset pin bypass an explicit workspace boundary',
);

const clampedBundle = await service.build({
  timeType: 'last_30d',
  snapshotAsOf: new Date(end).toISOString(),
  agentAssetId: assetId,
  limits: { maxWindowMs: 60 * 60_000 },
});
assert.equal(latestInventoryFilter.timeType, 'custom');
assert.equal(Date.parse(latestInventoryFilter.startTime), end - 60 * 60_000);
assert.equal(Date.parse(latestInventoryFilter.endTime), end);
assert.equal(latestInventoryFilter.agentAssetId, assetId, 'asset pin remains available when no workspace boundary is requested');
assert.equal(Date.parse(clampedBundle.window.startAt), end - 60 * 60_000);
assert.equal(clampedBundle.window.clamped, true, 'requested window remains visible after pre-query clamping');

console.log('S7 System Context query orchestration verification passed');
