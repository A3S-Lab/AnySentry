#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const controllerSource = fs.readFileSync(
  new URL('../apps/api/src/security-monitoring/observed-asset-lifecycle.controller.ts', import.meta.url),
  'utf8',
);
const serviceSource = fs.readFileSync(
  new URL('../apps/api/src/security-monitoring/observed-asset-lifecycle.read.service.ts', import.meta.url),
  'utf8',
);
const moduleSource = fs.readFileSync(
  new URL('../apps/api/src/security-monitoring/security-monitoring.module.ts', import.meta.url),
  'utf8',
);

for (const contract of [
  /@Controller\('security-center\/assets'\)/u,
  /@Post\('list'\)/u,
  /@Get\(':assetId'\)/u,
  /@Get\(':assetId\/timeline'\)/u,
  /@Get\(':assetId\/coverage'\)/u,
  /@Get\(':assetId\/rules'\)/u,
  /@Post\(':assetId\/review-impact'\)/u,
  /@Put\(':assetId\/review'\)/u,
]) assert.match(controllerSource, contract);
assert.match(serviceSource, /aggregation\.agentInventory\(\{[\s\S]*?scope: 'raw'/u);
assert.match(serviceSource, /aggregation\.agentEvents\(\{[\s\S]*?scope: 'raw'/u);
assert.match(serviceSource, /kube\.serviceInventory\(\)/u);
assert.match(serviceSource, /processLifecycleFact\(/u);
assert.match(serviceSource, /judge\.processLifecycleFacts/u);
assert.match(serviceSource, /const STRUCTURAL_FACT_LIMIT = 500/u);
assert.match(serviceSource, /const STRUCTURAL_WINDOW_MS = 10 \* 60_000/u);
assert.match(serviceSource, /const RECONCILE_TTL_MS = 60_000/u);
assert.match(serviceSource, /const completedAt = Date\.now\(\)[\s\S]*?this\.lastReconciledAt = completedAt/u);
assert.match(serviceSource, /core\.getAssetRecord\(meta\.subjectAssetId\)/u);
assert.match(serviceSource, /core\.getRuntime\(meta\.subjectAssetId, processInstanceKey\)/u);
assert.match(serviceSource, /const eventById = new Map\(events\.items\.map/u);
assert.doesNotMatch(serviceSource, /events\.items\.find\(\(candidate\) => candidate\.eventId === binding\.eventId\)/u);
assert.match(serviceSource, /reconcileEventSnapshot\(/u);
assert.match(serviceSource, /observation_coverage_unavailable/u);
assert.match(moduleSource, /ObservedAssetLifecycleController/u);
assert.match(moduleSource, /ObservedAssetLifecycleService/u);
assert.match(moduleSource, /controllers:[\s\S]*ObservedAssetLifecycleController/u);
assert.match(moduleSource, /providers:[\s\S]*ObservedAssetLifecycleService/u);

if (process.argv.includes('--static-only')) {
  console.log('Observed Asset lifecycle API static verification passed');
  process.exit(0);
}

const require = createRequire(import.meta.url);
const { ObservedAssetLifecycleService } = require(
  '../apps/api/dist/security-monitoring/observed-asset-lifecycle.read.service.js'
);
const { ObservedAssetLifecycleController } = require(
  '../apps/api/dist/security-monitoring/observed-asset-lifecycle.controller.js'
);
const { processLifecycleFact } = require(
  '../apps/api/dist/security-monitoring/process-lifecycle.js'
);

const now = Date.parse('2026-08-22T12:00:00.000Z');
const workloadId = 'k8s:cluster-a:pod-clickhouse-1';
const clickhouseId = 'service:k8s:cluster-a:anysentry:clickhouse';
const agentId = 'agent_pi_asset';

const coverage = {
  requestedFrom: new Date(now - 30 * 60_000).toISOString(),
  requestedTo: new Date(now).toISOString(),
  snapshotAsOf: new Date(now).toISOString(),
  asOf: new Date(now).toISOString(),
  partial: true,
  partialReason: 'hot_ring_only',
  source: 'memory_hot_ring',
  totalMode: 'exact',
};
const aggregation = {
  agentInventory() {
    return {
      items: [{
        agentId: 'pi', agentAssetId: agentId, workspacePath: '/workspace/pi', userId: 'user',
        displayName: 'Pi Agent', detectedClassification: 'confirmed_agent', classification: 'confirmed_agent',
        tags: [], runtime: 'kubernetes', instanceCount: 1, confidence: 1,
        attributionSource: 'agent_adapter', attributionEvidence: ['authenticated-adapter'],
        physicalWorkloadId: 'k8s:cluster-a:pod-pi-1', agentInstanceId: 'container-pi-1',
        reviewIdentityKeys: [], firstSeen: new Date(now - 60_000).toISOString(),
        lastSeen: new Date(now).toISOString(), lifecycleState: 'current', healthState: 'active',
        riskLevel: 'none', riskLevelText: '正常', eventCount: 1, riskyEventCount: 0,
        openIncidentCount: 0, sessionCount: 1, runCount: 1, traceCount: 1, tokenCount: 0,
        avgLatencyMs: 0, lastEventSubject: 'pi tool', eventCategoryCounts: { tool: 1 },
        sourceCounts: { observer: 1 },
      }],
      total: 1,
      summary: {},
      coverage,
      updateTime: new Date(now).toISOString(),
    };
  },
  agentEvents() {
    return {
      items: [{
        schemaVersion: 'anysentry.agent_event.v1', eventId: 'capture-clickhouse', at: new Date(now).toISOString(),
        receivedAt: new Date(now + 10).toISOString(), captureEpoch: '7001', captureProfileCode: 6,
        capturePolicyVersion: 3,
        eventKind: 'CaptureAggregate', eventCategory: 'runtime', source: 'observer', subject: 'aggregate',
        workspacePath: 'unknown', agentId: 'unknown', agentAssetId: 'unknown-agent',
        detectedClassification: 'unknown', effectiveClassification: 'unknown', runtime: 'kubernetes',
        sessionId: 'session', userId: 'system', traceId: 'trace', spanId: 'span', runId: 'run',
        verdict: 'allow', tier: 'Rules', severity: 'info', reason: 'observed', riskCategory: 'benign',
        riskName: '正常', riskType: 'atomic', riskScore: 0, tokenCount: 0, latencyMs: 0,
        attributes: { captureEpoch: '7001' },
        attribution: {
          monitored: false, classification: 'unknown', physicalWorkloadId: workloadId,
          confidence: 0, reason: 'not_evaluated', source: 'kubernetes', evidence: [],
        },
      }, {
        schemaVersion: 'anysentry.agent_event.v1', eventId: 'evt-clickhouse-structural-exec-0', at: new Date(now - 500).toISOString(),
        receivedAt: new Date(now - 450).toISOString(), eventKind: 'ToolExec', eventCategory: 'process',
        source: 'observer', subject: '/usr/bin/clickhouse', workspacePath: '/workspace', agentId: 'unknown',
        agentAssetId: 'unknown-agent', subjectAssetId: clickhouseId, subjectAssetType: 'service',
        assetBindingQuality: 'exact', assetBindingRevision: 1, detectedClassification: 'unknown',
        asObservedClassification: 'unknown', currentEffectiveClassification: 'unknown', effectiveClassification: 'unknown',
        runtime: 'kubernetes', sessionId: 'session', userId: 'system', traceId: 'trace-exec', spanId: 'span-exec', runId: 'run',
        verdict: 'allow', tier: 'Rules', severity: 'info', reason: 'observed', riskCategory: 'benign',
        riskName: '正常', riskType: 'atomic', riskScore: 0, tokenCount: 0, latencyMs: 0, attributes: {},
        process: { hostId: 'node-a', bootId: 'boot-a', pid: 4242, startTimeTicks: '1234' },
        attribution: { monitored: false, classification: 'unknown', physicalWorkloadId: workloadId, confidence: 0, reason: 'not_evaluated', source: 'kubernetes', evidence: [] },
      }],
      total: 2,
      totalMode: 'exact',
      coverage,
      updateTime: new Date(now).toISOString(),
    };
  },
  async storedAgentEvents() {
    return this.agentEvents();
  },
};
const kube = {
  snapshot() {
    return { schemaVersion: 'anysentry.workload_identity_snapshot.v1', version: 1, generatedAt: new Date(now).toISOString(), ready: true, entries: [], errors: 0 };
  },
  serviceInventory() {
    return {
      schemaVersion: 'anysentry.service_inventory.v1', version: 1,
      generatedAt: new Date(now).toISOString(), ready: true, errors: 0,
      items: [{
        serviceAssetId: clickhouseId, name: 'clickhouse', namespace: 'anysentry', clusterId: 'cluster-a',
        kind: 'database', role: 'anysentry_internal', ownerKind: 'StatefulSet', ownerName: 'clickhouse',
        revision: 'revision-1', images: [], replicas: { observed: 1, ready: 1 }, restarts: 0,
        phaseCounts: { Running: 1 }, physicalWorkloadIds: [workloadId],
        runtimeInstanceIds: ['container-clickhouse-1'], endpointAliases: [], metrics: [], observedAt: now,
      }],
      dependencies: [], changes: [],
    };
  },
};
const rules = {
  list() {
    return {
      items: [{
        schemaVersion: 'anysentry.infrastructure_rule.v1', ruleId: 'rule-clickhouse', revision: 3,
        name: 'ClickHouse 常规噪声',
        selector: {
          placement: 'kubernetes', clusterId: 'cluster-a', namespace: 'anysentry',
          ownerKind: 'StatefulSet', ownerName: 'clickhouse', labels: {},
        },
        effect: 'infrastructure', source: { type: 'platform_inventory', issuer: 'system' },
        authority: 'authoritative', lifecycleStage: 'enforced', reasonCode: 'platform_infrastructure',
        priority: 100, captureIntent: { schemaVersion: 'anysentry.infrastructure_capture_intent.v1', action: 'aggregate' },
        createdAt: now - 60_000, updatedAt: now, createdBy: 'operator-a', approvedBy: 'operator-b',
        contentHash: 'a'.repeat(64),
      }],
      total: 1, stateVersion: 1, policyVersion: 1, updateTime: new Date(now).toISOString(),
    };
  },
};

const structuralFacts = Array.from({ length: 150 }, (_, index) => ({
  schemaVersion: 'anysentry.process_lifecycle_fact.v1',
  factId: `plf-clickhouse-exec-${index}`,
  eventId: `evt-clickhouse-structural-exec-${index}`,
  factKind: 'exec',
  at: now - 500 + index,
  receivedAt: now - 450 + index,
  source: 'observer',
  workspacePath: '/workspace',
  subjectAssetId: clickhouseId,
  subjectAssetType: 'service',
  assetBindingQuality: 'exact',
  assetBindingRevision: 1,
  processInstanceKey: `pri_${index.toString(16).padStart(24, '0')}`,
  physicalWorkloadId: workloadId,
  hostId: 'node-a',
  bootId: 'boot-a',
  pid: 4_242 + index,
  startTime: `ticks:${1_234 + index}`,
}));
const judge = {
  processLifecycleFactsPage: () => ({ items: structuralFacts, total: structuralFacts.length, truncated: false, hydratedFromStorage: true }),
};
const agentMetadata = { identitySnapshotVersion: () => 17 };
const assetReviews = { current: () => undefined, effectiveAt: () => undefined, latestRevision: () => 0, historyFor: () => [], allHistory: () => [], version: () => 0 };
const agentRuntimeState = { list: () => ({ items: [], total: 0 }) };
let persistedAssetState;
const relational = {
  loadPlatformConfig: async () => undefined,
  savePlatformConfig: async (_key, record) => { persistedAssetState = structuredClone(record); return true; },
};
const service = new ObservedAssetLifecycleService(aggregation, kube, rules, judge, agentMetadata, assetReviews, agentRuntimeState, relational);
await service.onModuleInit();
const listed = service.list({ limit: 20 });
assert.equal(listed.items.some((item) => item.subjectAssetId === clickhouseId), true);
assert.equal(listed.items.some((item) => item.subjectAssetId === agentId), true);
assert.equal(listed.readStatus.partial, true, 'hot-ring source is explicitly partial');
assert(listed.readStatus.reasons.includes('event_window_partial'));
assert.equal(listed.classificationView, 'current_effective');
assert.equal(listed.reviewRevision, 17);

const processMeta = {
  eventKind: 'ToolExec',
  workspacePath: '/workspace/cold-process',
  receivedAt: now + 20,
  process: {
    hostId: 'node-a', bootId: 'boot-a', pidNamespace: 'pid:[4026533000]',
    namespacePid: 7001, pid: 7001, startTimeTicks: '987654', comm: 'short-task',
  },
  attribution: {
    monitored: false, classification: 'unknown', confidence: 0,
    reason: 'not_evaluated', source: 'none', evidence: [],
  },
};
const beforeBindingRevision = service.modelRevision();
const boundProcess = service.bindIngestMeta(processMeta, now + 20);
assert.equal(boundProcess.subjectAssetType, 'ephemeral_process');
assert.equal(service.modelRevision(), beforeBindingRevision,
  'pre-persistence binding must not mutate the unified asset model');
assert.equal(service.detail(boundProcess.subjectAssetId), undefined,
  'a prepared but uncommitted Process must not appear as an asset');
assert.equal(service.materializeCommittedIngest(boundProcess, now + 20), true);
assert.equal(service.detail(boundProcess.subjectAssetId)?.asset.subjectAssetType, 'ephemeral_process');
const canonicalFact = processLifecycleFact({
  eventId: 'process-key-contract', eventKind: 'ToolExec', at: now + 20,
  source: 'observer', workspacePath: processMeta.workspacePath,
  process: processMeta.process, attribution: processMeta.attribution,
});
assert.equal(
  service.detail(boundProcess.subjectAssetId)?.bindings[0]?.processInstanceKey,
  canonicalFact?.processInstanceKey,
  'Asset binding and durable lifecycle facts share one canonical Process generation key',
);
const committedRevision = service.modelRevision();
assert.equal(service.materializeCommittedIngest(boundProcess, now + 20), true);
assert.equal(service.modelRevision(), committedRevision, 'committed materialization is idempotent');

const detail = service.detail(clickhouseId);
assert(detail);
assert.equal(detail.asset.eventSummary.eventKindCounts.CaptureAggregate, 1);
assert.equal(detail.asset.eventSummary.eventKindCounts.ToolExec, 150, 'durable structural facts survive raw-event omission');
assert.equal(detail.runtimes.some((runtime) => runtime.processInstanceKey?.startsWith('pri_')), false,
  'ordinary child Process facts must not be promoted into Runtime instances');
assert.equal(detail.runtimes.length, 1, 'more than 128 child Exec facts do not exhaust Runtime capacity');
assert.equal(detail.asset.existenceState, 'active');
const timeline = service.timeline(clickhouseId);
assert(timeline?.items.length);
const coverageResult = service.coverage(clickhouseId);
assert.equal(coverageResult?.current?.captureProfile, 'infrastructure_aggregate');
assert.equal(coverageResult?.current?.signalCoverage.file, 'aggregate');
assert.equal(coverageResult?.current?.signalCoverage.exec, 'structural');
const matchedRules = service.rules(clickhouseId);
assert.equal(matchedRules?.items[0].ruleId, 'rule-clickhouse');
assert.equal(matchedRules?.items[0].matchQuality, 'exact');
assert.equal('selector' in matchedRules.items[0], false, 'reviewer read API does not expose selector JSON');
const reviewImpact = service.reviewImpact(clickhouseId);
assert.equal(reviewImpact?.canReview, true);
assert.equal(reviewImpact?.actions.markNonAgent, true);
assert.match(reviewImpact?.warning ?? '', /不会删除历史事件/u);

const annotated = service.annotateEventList(aggregation.agentEvents());
assert.equal(annotated.items[0].subjectAssetId, clickhouseId);
assert.equal(annotated.items[0].subjectAssetType, 'service');
assert.equal(annotated.items[0].assetBindingQuality, 'exact');
assert(annotated.assetBindingRevision > 0);

const controller = new ObservedAssetLifecycleController(service);
assert.equal((await controller.detail(clickhouseId)).asset.subjectAssetId, clickhouseId);
assert.equal(controller.list({ limit: 20 }).total, service.list({ limit: 20 }).total);
await service.onModuleDestroy();
assert.equal(persistedAssetState?.schemaVersion, 'anysentry.observed_asset_lifecycle_state.v1');
assert(persistedAssetState.assets.some((asset) => asset.subjectAssetId === clickhouseId));

const coldServiceAssetId = 'service:k8s:cluster-a:retired:postgres';
const emptyCoverage = { ...coverage, partial: false, partialReason: undefined, source: 'clickhouse' };
const coldAggregation = {
  agentInventory: () => ({ items: [], total: 0, summary: {}, coverage: emptyCoverage, updateTime: new Date(now).toISOString() }),
  agentEvents: () => ({ items: [], total: 0, totalMode: 'exact', coverage: emptyCoverage, updateTime: new Date(now).toISOString() }),
  storedAgentEvents: () => { throw new Error('cold Asset hydration must not use dashboard hot/delta reads'); },
};
const coldKube = {
  snapshot: () => ({ schemaVersion: 'anysentry.workload_identity_snapshot.v1', version: 2, generatedAt: new Date(now).toISOString(), ready: true, entries: [], errors: 0 }),
  serviceInventory: () => ({ schemaVersion: 'anysentry.service_inventory.v1', version: 2, generatedAt: new Date(now).toISOString(), ready: true, errors: 0, items: [], dependencies: [], changes: [] }),
};
const coldEvent = {
  schemaVersion: 'anysentry.event.v1', eventId: 'cold-postgres-event', at: now - 20 * 24 * 60 * 60_000,
  receivedAt: now - 20 * 24 * 60 * 60_000 + 10, eventKind: 'CaptureAggregate', eventCategory: 'runtime',
  source: 'observer', subject: 'retired postgres aggregate', workspacePath: '/workspace/retired',
  agentId: 'unknown', sessionId: 'cold-session', userId: 'system', traceId: 'cold-trace', spanId: 'cold-span', runId: 'cold-run',
  attributes: {}, attribution: { monitored: false, classification: 'unknown', confidence: 0, reason: 'not_evaluated', source: 'kubernetes', evidence: [], physicalWorkloadId: 'k8s:cluster-a:retired-pod:old-container' },
  subjectAssetId: coldServiceAssetId, subjectAssetType: 'service', assetBindingQuality: 'exact', assetBindingRevision: 9,
  assetBindingReason: 'kubernetes_service_physical_binding', identityRevision: 1,
  classificationSemantics: { schemaVersion: 'anysentry.classification_semantics.v1', identityClassification: 'unknown', workloadRole: 'platform_infrastructure', captureProfile: 'infrastructure_aggregate' },
  verdict: 'allow', tier: 'Rules', severity: 'info', reason: 'observed', riskCategory: 'benign', riskName: '正常', riskType: 'atomic', riskScore: 0,
  tokenCount: 0, latencyMs: 0,
};
const coldJudge = {
  processLifecycleFactsPage: () => ({ items: [], total: 0, truncated: false, hydratedFromStorage: true }),
  searchStoredEventsPage: async () => ({ events: [coldEvent], hasMore: false, committedCutoffMs: now }),
  processLifecycleFactsForGeneration: async () => [],
};
const coldAssets = new ObservedAssetLifecycleService(
  coldAggregation, coldKube, { list: () => ({ items: [], total: 0, updateTime: new Date(now).toISOString() }) },
  coldJudge, agentMetadata, assetReviews, agentRuntimeState,
  { loadPlatformConfig: async () => undefined, savePlatformConfig: async () => true },
);
await coldAssets.onModuleInit();
assert.equal(await coldAssets.ensureAsset(coldServiceAssetId), true);
const coldDetail = coldAssets.detail(coldServiceAssetId);
assert.equal(coldDetail?.asset.existenceState, 'inactive');
assert.equal(coldDetail?.asset.bindingQuality, 'unassigned',
  'occurrence-time exact binding must not become a current review anchor');
assert.equal(coldDetail?.bindings.length, 0);
assert.equal(coldAssets.reviewImpact(coldServiceAssetId)?.canReview, false);
await coldAssets.onModuleDestroy();

const unavailableAssets = new ObservedAssetLifecycleService(
  coldAggregation, coldKube, { list: () => ({ items: [], total: 0, updateTime: new Date(now).toISOString() }) },
  { ...coldJudge, searchStoredEventsPage: async () => ({ events: [], hasMore: false, unavailable: true }) },
  agentMetadata, assetReviews, agentRuntimeState,
  { loadPlatformConfig: async () => undefined, savePlatformConfig: async () => true },
);
await unavailableAssets.onModuleInit();
assert.equal(await unavailableAssets.ensureAsset('asset-from-hot-fallback'), false,
  'storage unavailability must not hydrate an Asset from a dashboard hot fallback');
await unavailableAssets.onModuleDestroy();

console.log('Observed Asset lifecycle API/module verification passed');
