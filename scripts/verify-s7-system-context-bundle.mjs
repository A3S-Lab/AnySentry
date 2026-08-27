import assert from 'node:assert/strict';
import {
  SYSTEM_CONTEXT_BUNDLE_SCHEMA_VERSION,
  buildSystemContextBundle,
} from '../apps/api/dist/security-monitoring/system-context-bundle.js';

const end = Date.parse('2026-08-20T12:00:00.000Z');
const start = end - 15 * 60_000;
const generatedAt = end + 30_000;

function evidence(sourceId, sourceKind, observedAt = end - 30_000, extra = {}) {
  return {
    sourceId,
    sourceKind,
    authority: sourceKind === 'agent_adapter' ? 'authenticated_agent_adapter' : 'attested_platform',
    recordId: `${sourceId}-record`,
    observedAt,
    freshnessTtlMs: 10 * 60_000,
    confidence: 0.98,
    associationMethod: 'exact_resource_identity',
    inferred: false,
    ...extra,
  };
}

function sourceStatus(domain, sourceId, sourceKind) {
  return {
    domain,
    sourceId,
    sourceKind,
    state: 'complete',
    checkedAt: generatedAt,
    lastObservedAt: end,
    freshnessTtlMs: 10 * 60_000,
    required: true,
    recordsRead: 10,
  };
}

const sourceStatuses = [
  sourceStatus('inventory', 'kube-inventory', 'kubernetes_inventory'),
  sourceStatus('tool_evidence', 'pi-adapter', 'agent_adapter'),
  sourceStatus('topology', 'observer-aggregate', 'observer_aggregate'),
  sourceStatus('metrics', 'prometheus-main', 'prometheus'),
  sourceStatus('alerts', 'alertmanager-main', 'alert_manager'),
  sourceStatus('changes', 'kube-deployments', 'deployment_controller'),
  sourceStatus('collection_quality', 'observer-accounting', 'observer'),
];

const baseInput = {
  focus: {
    agentAssetId: 'agent:codex-prod',
    agentRuntimeInstanceId: 'runtime:codex-prod:42',
    invocationId: 'invocation:deploy-42',
    physicalWorkloadId: 'workload:agent',
    evidence: evidence('pi-adapter', 'agent_adapter', end - 60_000, {
      associationMethod: 'trusted_invocation',
      confidence: 1,
    }),
  },
  window: { startMs: start, endMs: end },
  toolEvidence: [
    {
      agentAssetId: 'agent:codex-prod',
      agentRuntimeInstanceId: 'runtime:codex-prod:42',
      invocationId: 'invocation:deploy-42',
      toolCallId: 'tool:write-config',
      toolName: 'write',
      status: 'linked',
      reason: 'exact_process_and_resource',
      startedAt: end - 10 * 60_000,
      endedAt: end - 9 * 60_000,
      adapterEventIds: ['adapter:start', 'adapter:end'],
      relatedResourceIds: ['service:business-api'],
      kernelEvidence: [{
        eventId: 'kernel:file-write',
        eventKind: 'FileAccess',
        at: end - 9 * 60_000 + 1_000,
        linkMethod: 'same_process_resource',
        confidence: 1,
        evidence: evidence('observer-node-a', 'observer', end - 9 * 60_000 + 1_000),
      }],
      evidence: evidence('pi-adapter', 'agent_adapter', end - 9 * 60_000),
    },
    {
      agentAssetId: 'agent:other',
      invocationId: 'invocation:other',
      toolCallId: 'tool:unrelated',
      toolName: 'read',
      status: 'semantic_only',
      reason: 'kernel_read_not_captured',
      startedAt: end - 5 * 60_000,
      endedAt: end - 4 * 60_000,
      evidence: evidence('pi-adapter', 'agent_adapter'),
    },
  ],
  resources: [
    {
      resourceId: 'workload:agent',
      physicalWorkloadId: 'workload:agent',
      kind: 'agent_runtime',
      role: 'agent',
      name: 'codex-prod',
      namespace: 'agents',
      environment: 'production',
      validFrom: start - 60_000,
      evidence: evidence('kube-inventory', 'kubernetes_inventory', end - 2 * 60_000),
    },
    {
      resourceId: 'service:business-api',
      physicalWorkloadId: 'k8s:business-api',
      kind: 'service',
      role: 'business_service',
      name: 'business-api',
      namespace: 'production',
      environment: 'production',
      validFrom: start - 60_000,
      evidence: evidence('kube-inventory', 'kubernetes_inventory', end - 2 * 60_000),
    },
    {
      resourceId: 'database:clickhouse',
      physicalWorkloadId: 'k8s:clickhouse',
      kind: 'database',
      role: 'platform_infrastructure',
      name: 'clickhouse',
      namespace: 'data',
      environment: 'production',
      validFrom: start - 60_000,
      evidence: evidence('kube-inventory', 'kubernetes_inventory', end - 2 * 60_000),
    },
    {
      resourceId: 'service:storage',
      kind: 'service',
      role: 'platform_infrastructure',
      name: 'deep-storage',
      validFrom: start - 60_000,
      evidence: evidence('kube-inventory', 'kubernetes_inventory'),
    },
    {
      resourceId: 'service:unrelated',
      kind: 'service',
      role: 'business_service',
      name: 'unrelated-payments',
      validFrom: start - 60_000,
      evidence: evidence('kube-inventory', 'kubernetes_inventory'),
    },
  ],
  dependencies: [
    {
      edgeId: 'edge:agent-api',
      sourceResourceId: 'workload:agent',
      targetResourceId: 'service:business-api',
      relation: 'calls',
      firstObservedAt: start + 60_000,
      lastObservedAt: end - 4 * 60_000,
      eventCount: 51,
      aggregated: true,
      evidence: evidence('observer-aggregate', 'observer_aggregate', end - 4 * 60_000),
    },
    {
      edgeId: 'edge:api-clickhouse',
      sourceResourceId: 'service:business-api',
      targetResourceId: 'database:clickhouse',
      relation: 'queries',
      firstObservedAt: start + 2 * 60_000,
      lastObservedAt: end - 3 * 60_000,
      eventCount: 200,
      aggregated: true,
      evidence: evidence('otel-service-graph', 'otel', end - 3 * 60_000),
    },
    {
      edgeId: 'edge:clickhouse-storage',
      sourceResourceId: 'database:clickhouse',
      targetResourceId: 'service:storage',
      relation: 'stores',
      firstObservedAt: start + 2 * 60_000,
      lastObservedAt: end - 2 * 60_000,
      eventCount: 400,
      aggregated: true,
      evidence: evidence('otel-service-graph', 'otel', end - 2 * 60_000),
    },
    {
      edgeId: 'edge:unrelated',
      sourceResourceId: 'service:unrelated',
      targetResourceId: 'database:clickhouse',
      relation: 'queries',
      firstObservedAt: start,
      lastObservedAt: end,
      eventCount: 99_999,
      aggregated: true,
      evidence: evidence('otel-service-graph', 'otel'),
    },
  ],
  metrics: [
    {
      metricId: 'metric:api-errors',
      resourceId: 'service:business-api',
      name: 'http.server.error_rate',
      value: 0.23,
      unit: 'ratio',
      kind: 'rate',
      status: 'anomalous',
      observedAt: end - 60_000,
      evidence: evidence('prometheus-main', 'prometheus', end - 60_000),
    },
    {
      metricId: 'metric:clickhouse-latency',
      resourceId: 'database:clickhouse',
      name: 'query.latency.p95',
      value: 812,
      unit: 'ms',
      kind: 'histogram_summary',
      status: 'anomalous',
      observedAt: end - 50_000,
      evidence: evidence('prometheus-main', 'prometheus', end - 50_000),
    },
    {
      metricId: 'metric:unrelated',
      resourceId: 'service:unrelated',
      name: 'secret.cluster_metric',
      value: 1,
      kind: 'gauge',
      status: 'normal',
      observedAt: end - 10_000,
      evidence: evidence('prometheus-main', 'prometheus', end - 10_000),
    },
  ],
  alerts: [
    {
      alertId: 'alert:api-errors',
      resourceIds: ['service:business-api'],
      title: 'Business API error rate high',
      severity: 'high',
      status: 'open',
      firstSeenAt: end - 8 * 60_000,
      lastSeenAt: end - 30_000,
      evidence: evidence('alertmanager-main', 'alert_manager', end - 30_000),
    },
    {
      alertId: 'alert:unrelated',
      resourceIds: ['service:unrelated'],
      title: 'Unrelated alert must not leak into context',
      severity: 'critical',
      status: 'open',
      firstSeenAt: start,
      lastSeenAt: end,
      evidence: evidence('alertmanager-main', 'alert_manager'),
    },
  ],
  changes: [
    {
      changeId: 'change:api-v42',
      resourceIds: ['service:business-api'],
      type: 'deployment',
      summary: 'business-api rolled out image v42',
      at: end - 7 * 60_000,
      evidence: evidence('kube-deployments', 'deployment_controller', end - 7 * 60_000),
    },
    {
      changeId: 'change:unrelated',
      resourceIds: ['service:unrelated'],
      type: 'configuration',
      summary: 'unrelated secret configuration changed',
      at: end - 6 * 60_000,
      evidence: evidence('kube-deployments', 'deployment_controller', end - 6 * 60_000),
    },
  ],
  collectionQuality: [{
    collectorId: 'observer-node-a',
    windowStartMs: start,
    windowEndMs: end,
    rawKernelDetail: 'aggregated',
    accountingConserved: true,
    ringDropped: 0,
    collectorDropped: 0,
    queueDropped: 0,
    aggregateSummariesIncomplete: false,
    evidence: evidence('observer-accounting', 'observer', end),
  }],
  sourceStatus: sourceStatuses,
  limits: {
    maxHops: 2,
    maxResources: 10,
    maxDependencies: 10,
  },
};

const bundle = buildSystemContextBundle(baseInput, generatedAt);
assert.equal(bundle.schemaVersion, SYSTEM_CONTEXT_BUNDLE_SCHEMA_VERSION);
assert.equal(bundle.focus.agentAssetId, 'agent:codex-prod');
assert.equal(bundle.focus.agentRuntimeInstanceId, 'runtime:codex-prod:42');
assert.equal(bundle.focus.invocationId, 'invocation:deploy-42');
assert.equal(bundle.toolEvidence.length, 1);
assert.equal(bundle.toolEvidence[0].toolCallId, 'tool:write-config');
assert.equal(bundle.toolEvidence[0].kernelEvidence[0].eventId, 'kernel:file-write');

assert.deepEqual(
  bundle.dependencies.map((edge) => [edge.edgeId, edge.hop]),
  [['edge:agent-api', 1], ['edge:api-clickhouse', 2]],
  'only the two-hop Agent → business API → ClickHouse path is selected',
);
assert.deepEqual(
  bundle.relatedResources.map((resource) => resource.resourceId),
  ['workload:agent', 'service:business-api', 'database:clickhouse'],
);
assert.equal(bundle.relatedResources.some((resource) => resource.resourceId === 'service:unrelated'), false);
assert.equal(bundle.relatedResources.some((resource) => resource.resourceId === 'service:storage'), false);
assert.deepEqual(bundle.metrics.map((metric) => metric.metricId).sort(), ['metric:api-errors', 'metric:clickhouse-latency']);
assert.deepEqual(bundle.alerts.map((alert) => alert.alertId), ['alert:api-errors']);
assert.deepEqual(bundle.changes.map((change) => change.changeId), ['change:api-v42']);
assert.equal(bundle.summary.businessServiceCount, 1);
assert.equal(bundle.summary.maxTopologyHop, 2);
assert.equal(bundle.summary.anomalousMetricCount, 2);
assert.equal(bundle.summary.activeAlertCount, 1);

const allEvidence = [
  bundle.focus.evidence,
  ...bundle.toolEvidence.map((item) => item.evidence),
  ...bundle.toolEvidence.flatMap((item) => item.kernelEvidence.map((kernel) => kernel.evidence)),
  ...bundle.relatedResources.map((item) => item.evidence),
  ...bundle.dependencies.map((item) => item.evidence),
  ...bundle.metrics.map((item) => item.evidence),
  ...bundle.alerts.map((item) => item.evidence),
  ...bundle.changes.map((item) => item.evidence),
  ...bundle.collectionQuality.map((item) => item.evidence),
];
assert.ok(allEvidence.every((item) => item.source.sourceId && item.observedAt));
assert.ok(allEvidence.every((item) => item.freshness.state === 'fresh'));
assert.ok(allEvidence.every((item) => item.association.confidence >= 0 && item.association.confidence <= 1));
assert.ok(bundle.quality.confidence > 0.9);
assert.equal(bundle.quality.domains.every((domain) => domain.state === 'complete'), true);
assert.equal(bundle.quality.status, 'partial', 'aggregated raw syscalls are an explicit limitation, not missing service context');
assert.ok(bundle.quality.reasons.some((reason) => reason.code === 'raw_kernel_detail_aggregated'));
assert.equal(bundle.quality.reasons.some((reason) => reason.code === 'source_status_missing'), false);
assert.equal(bundle.quality.output.estimatedBytes, Buffer.byteLength(JSON.stringify(bundle), 'utf8'));

const requestedWideTopology = buildSystemContextBundle({
  ...baseInput,
  limits: { ...baseInput.limits, maxHops: 99 },
}, generatedAt);
assert.equal(requestedWideTopology.limits.maxHops, 2, 'callers cannot widen risk context beyond two hops');
assert.deepEqual(
  requestedWideTopology.dependencies.map((edge) => edge.edgeId),
  ['edge:agent-api', 'edge:api-clickhouse'],
);

const missingResourceEdge = buildSystemContextBundle({
  ...baseInput,
  dependencies: [...baseInput.dependencies, {
    edgeId: 'edge:orphan',
    sourceResourceId: 'workload:agent',
    targetResourceId: 'service:not-in-inventory',
    relation: 'calls',
    firstObservedAt: start,
    lastObservedAt: end,
    eventCount: 1,
    aggregated: true,
    evidence: evidence('observer-aggregate', 'observer_aggregate'),
  }],
}, generatedAt);
const selectedResourceIds = new Set(missingResourceEdge.relatedResources.map((resource) => resource.resourceId));
assert.equal(missingResourceEdge.dependencies.some((edge) => edge.edgeId === 'edge:orphan'), false);
assert(missingResourceEdge.dependencies.every((edge) =>
  selectedResourceIds.has(edge.sourceResourceId) && selectedResourceIds.has(edge.targetResourceId)
), 'every output dependency has both endpoint resources');
assert(missingResourceEdge.quality.reasons.some((reason) =>
  reason.code === 'invalid_fact' && reason.domain === 'topology'
));

const long = 'x'.repeat(1_000);
const boundedInput = {
  ...baseInput,
  metrics: Array.from({ length: 80 }, (_, index) => ({
    metricId: `metric:bounded:${index}`,
    resourceId: index % 2 ? 'service:business-api' : 'database:clickhouse',
    name: `metric.${index}.${long}`,
    value: index,
    unit: long,
    kind: 'gauge',
    status: index % 3 === 0 ? 'anomalous' : 'normal',
    observedAt: end - index,
    evidence: evidence(`prometheus-${long}`, 'prometheus', end - index, {
      recordId: `record-${index}-${long}`,
      authority: `authority-${long}`,
      associationMethod: `method-${long}`,
    }),
  })),
  limits: {
    ...baseInput.limits,
    maxMetrics: 80,
    maxMetricsPerResource: 32,
    maxBytes: 32 * 1_024,
  },
};
const bounded = buildSystemContextBundle(boundedInput, generatedAt);
assert.ok(Buffer.byteLength(JSON.stringify(bounded), 'utf8') <= bounded.limits.maxBytes);
assert.equal(bounded.quality.output.truncated, true);
assert.ok(bounded.quality.reasons.some((reason) => reason.code === 'byte_budget'));
assert.ok(bounded.quality.bounds.metrics.included < 64);
assert.equal(bounded.quality.bounds.metrics.truncated, true);

const oneHugeTool = buildSystemContextBundle({
  ...baseInput,
  toolEvidence: [{
    ...baseInput.toolEvidence[0],
    reason: long,
    kernelEvidence: Array.from({ length: 64 }, (_, index) => ({
      eventId: `kernel:${index}:${long}`,
      eventKind: long,
      at: end - 30_000 + index,
      linkMethod: long,
      confidence: 1,
      evidence: evidence(`observer-${index}-${long}`, 'observer', end - 30_000 + index, {
        recordId: `record-${index}-${long}`,
        authority: `authority-${long}`,
        associationMethod: `method-${long}`,
      }),
    })),
  }],
  limits: {
    ...baseInput.limits,
    maxKernelEvidencePerTool: 256,
    maxBytes: 32 * 1_024,
  },
}, generatedAt);
assert.ok(Buffer.byteLength(JSON.stringify(oneHugeTool), 'utf8') <= oneHugeTool.limits.maxBytes);
assert.equal(oneHugeTool.quality.output.estimatedBytes, Buffer.byteLength(JSON.stringify(oneHugeTool), 'utf8'));
assert.equal(oneHugeTool.quality.output.truncated, true);
assert(oneHugeTool.quality.reasons.some((reason) => reason.code === 'byte_budget'));
assert((oneHugeTool.toolEvidence[0]?.kernelEvidence.length ?? 0) < 64, 'inner Tool evidence is budgeted');
const oneHugeToolResources = new Set(oneHugeTool.relatedResources.map((resource) => resource.resourceId));
assert(oneHugeTool.dependencies.every((edge) =>
  oneHugeToolResources.has(edge.sourceResourceId) && oneHugeToolResources.has(edge.targetResourceId)
));

const clamped = buildSystemContextBundle({
  ...baseInput,
  window: { startMs: end - 30 * 24 * 60 * 60_000, endMs: end },
  limits: { ...baseInput.limits, maxWindowMs: 60 * 60_000 },
}, generatedAt);
assert.equal(Date.parse(clamped.window.startAt), end - 60 * 60_000);
assert.equal(clamped.window.clamped, true);
assert.ok(clamped.quality.reasons.some((reason) => reason.code === 'time_window_clamped'));

const historicalGeneratedAt = end + 24 * 60 * 60_000;
const historical = buildSystemContextBundle({
  ...baseInput,
  sourceStatus: sourceStatuses.map((status) => ({
    ...status,
    checkedAt: historicalGeneratedAt,
    lastObservedAt: historicalGeneratedAt,
  })),
}, historicalGeneratedAt);
assert.equal(
  historical.metrics.every((metric) => metric.evidence.freshness.state === 'fresh'),
  true,
  'fact freshness is evaluated at the historical context window, not wall-clock age',
);
assert.equal(historical.quality.sources.every((source) => source.freshness.state === 'fresh'), true);

const futureOnly = buildSystemContextBundle({
  ...baseInput,
  window: {
    startMs: generatedAt + 24 * 60 * 60_000,
    endMs: generatedAt + 25 * 60 * 60_000,
  },
}, generatedAt);
assert.ok(Date.parse(futureOnly.window.startAt) <= Date.parse(futureOnly.window.endAt));
assert.equal(futureOnly.window.clamped, true);

const noSeed = buildSystemContextBundle({
  ...baseInput,
  focus: {
    ...baseInput.focus,
    physicalWorkloadId: undefined,
    relatedResourceIds: undefined,
    invocationId: undefined,
  },
  toolEvidence: [],
}, generatedAt);
assert.equal(noSeed.dependencies.length, 0);
assert.equal(noSeed.relatedResources.length, 0);
assert.ok(noSeed.quality.reasons.some((reason) => reason.code === 'topology_seed_missing'));

assert.throws(() => buildSystemContextBundle({
  ...baseInput,
  focus: { ...baseInput.focus, agentAssetId: ' ' },
}, generatedAt), /requires agentAssetId/);

console.log('S7 system context bundle verification passed');
