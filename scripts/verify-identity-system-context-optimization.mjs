#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const source = async (path) => readFile(new URL(path, root), 'utf8');
const [
  semantics,
  workloadFilter,
  capture,
  publisher,
  piAdapter,
  controller,
  kube,
  clickhouse,
  aggregation,
  context,
  prometheus,
  infrastructureRules,
  deployment,
] = await Promise.all([
  source('scripts/observer-classification-semantics.js'),
  source('scripts/observer-workload-filter.js'),
  source('scripts/observer-capture-profile-control.js'),
  source('scripts/observer-filter-rule-publisher.js'),
  source('examples/agent-runtime-lab/app/anysentry-pi-adapter.mjs'),
  source('apps/api/src/security-monitoring/security-monitoring.controller.ts'),
  source('apps/api/src/security-monitoring/kube-identity.service.ts'),
  source('apps/api/src/security-monitoring/clickhouse-store.ts'),
  source('apps/api/src/security-monitoring/aggregation.service.ts'),
  source('apps/api/src/security-monitoring/system-context.service.ts'),
  source('apps/api/src/security-monitoring/prometheus-context.service.ts'),
  source('apps/api/src/security-monitoring/infrastructure-rule.service.ts'),
  source('deploy/anysentry.yaml'),
]);

const checks = [
  ['three-axis semantics includes probable investigation',
    semantics.includes("'probable_investigation'") && semantics.includes('workloadRole')],
  ['stable service roles gate weak behavior discovery',
    workloadFilter.includes("['anysentry_internal', 'platform_infrastructure', 'business_service'].includes(role)")],
  ['probable capture has a fixed sample/full probe matrix',
    capture.includes('probable_investigation: Object.freeze') && capture.includes("file_access: 'sample'")],
  ['probable capture has independent TTL and capacity bounds',
    publisher.includes('maxProbableEntries') && publisher.includes('probableTtlMs') && publisher.includes('probableCapacityEvicted')],
  ['Pi Invocation follows outer agent lifecycle',
    piAdapter.includes("pi.on('agent_start'") && piAdapter.includes("pi.on('agent_end'")],
  ['authenticated semantic events merge only through server inventory',
    controller.includes('enrichAuthenticatedAgentSemantic') && controller.includes('serverClassificationObserved')],
  ['unmerged authenticated adapters use a closed Unknown reason',
    controller.includes("unknownReason: 'unsupported_agent_adapter'")],
  ['Kubernetes builds stable Service Assets and declared dependencies',
    kube.includes("schemaVersion: 'anysentry.service_inventory.v1'") &&
      kube.includes('kubernetes_declared_configuration') && kube.includes('declaredDependencyHosts') &&
      kube.includes('namespaceEndpointOwners')],
  ['ClickHouse and Redis have deterministic service-kind classification',
    kube.includes('clickhouse|postgres') && kube.includes('|redis|')],
  ['ToolEvidence queries use scalar process and hash columns',
    clickhouse.includes('processPidNamespace String') && clickhouse.includes('evidenceResourceHash') &&
      clickhouse.includes('idx_invocation_id')],
  ['ToolEvidence relation is restart-durable',
    clickhouse.includes("TOOL_EVIDENCE_RELATION_TABLE = 'tool_evidence_relations'") &&
      aggregation.includes("dataSource: 'clickhouse_relation'")],
  ['native OTLP Metrics enter authenticated System Context',
    controller.includes("@Post('ingest/otlp/v1/metrics')") && controller.includes('otlpMetricsToUniversal')],
  ['configured Prometheus facts are bounded and service-scoped',
    prometheus.includes('MAX_RESPONSE_BYTES') && prometheus.includes('metricsForAssets')],
  ['System Context consumes service inventory, metrics, topology and changes',
    context.includes('kubeResources') && context.includes('prometheusMetrics') && context.includes('kubeDependencies') && context.includes('kubeChanges')],
  ['stale coverage is reconciled before a new risk bundle',
    context.includes('observeCoverageList(currentCoverage.issues') && context.includes('resolveMissing: true')],
  ['Infrastructure control state survives API restarts without PostgreSQL',
    clickhouse.includes('loadPlatformConfig<T>') && clickhouse.includes('savePlatformConfig<T>') &&
      infrastructureRules.includes('this.ch.loadPlatformConfig<InfrastructureRuleStateDocument>') &&
      infrastructureRules.includes('this.ch.savePlatformConfig(CONFIG_KEY')],
  ['Kubernetes RBAC remains read-only while covering service inventory',
    deployment.includes('resources: ["pods", "services", "configmaps"]') &&
      deployment.includes('resources: ["replicasets"]') &&
      deployment.includes('verbs: ["get", "list", "watch"]')],
];

for (const [name, passed] of checks) {
  assert.equal(passed, true, name);
  console.log(`PASS ${name}`);
}
console.log(`Identity/System Context optimization contract passed (${checks.length} checks)`);
