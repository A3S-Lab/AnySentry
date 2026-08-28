import { Injectable } from '@nestjs/common';
import { basename } from 'node:path';
import { AgentMetadataService } from './agent-metadata.service';
import { correlationCaptureRollout } from './correlation-rollout';
import { FilterRuleCatalogService, FilterRuleError } from './filter-rule-catalog.service';
import { filterRuleDigest } from './filter-rule-builtins';
import {
  closedClassification,
  closedWorkloadRole,
  compileFilterRuleProjection,
  evaluateFilterRules,
  filterRuleEffectDescription,
  matchFilterRule,
} from './filter-rule-engine';
import {
  FILTER_RULE_CATEGORY_LABELS,
  FILTER_RULE_KIND_LABELS,
  FILTER_RULE_KIND_CATEGORIES,
  humanFilterRuleDetail,
  humanFilterRuleSummary,
  infrastructureFilterRule,
  reviewedIdentityFilterRule,
  unknownLearningFilterRule,
} from './filter-rule-governance';
import {
  FilterRuleActor,
  FilterRuleCatalogQuery,
  FilterRuleCatalogResult,
  FilterRuleCategory,
  FilterRuleCategorySummary,
  FilterRuleDecisionReceipt,
  FilterRuleDomainVersions,
  FilterRuleDraftRequest,
  FilterRuleEvaluationContext,
  FilterRuleExplainRequest,
  FilterRuleExplainResult,
  FilterRuleHumanDetail,
  FilterRuleHumanSummary,
  FilterRulePreviewResult,
  FilterRuleRecord,
  FilterRuleSimulationRequest,
  FilterRuleSimulationResult,
  FilterRuleStage,
  FilterRuleStageRuntimeNode,
  FilterRuleStageStatus,
  FilterRuleSystemStatus,
  FilterRuleTransitionRequest,
} from './filter-rule.types';
import { InfrastructureAssetSnapshotService } from './infrastructure-asset-snapshot.service';
import { InfrastructureRuleError, InfrastructureRuleService } from './infrastructure-rule.service';
import type {
  InfrastructureAssetDraftRequest,
  InfrastructureRuleHumanDetail,
  InfrastructureRuleImpactPreview,
  InfrastructureRuleOperationRecord,
  InfrastructureRuleRecord,
} from './infrastructure-rule.types';
import { KubeIdentityService } from './kube-identity.service';
import { ObservedAssetLifecycleService } from './observed-asset-lifecycle.read.service';
import type { ObservedAssetDetailReadResponse } from './observed-asset-lifecycle.read.service';
import { SentryJudgeService } from './sentry-judge.service';
import type { CollectorHeartbeatRecord, JudgedEvent } from './types';
import { UnknownLearningRuntimeService } from './unknown-learning-runtime.service';

const CATEGORY_ORDER: FilterRuleCategory[] = [
  'agent_identity',
  'infrastructure',
  'capture_profile',
  'forwarder_retention',
  'api_retention',
  'safety_guardrail',
  'investigation',
  'learning_candidate',
];
const STAGES: FilterRuleStage[] = ['f0', 'f1', 'f2', 'f3'];
const STAGE_LABELS: Record<FilterRuleStage, string> = {
  f0: '身份与上下文解析',
  f1: 'Ring 前采集过滤',
  f2: 'Forwarder 语义过滤',
  f3: 'API 入库与研判路由',
};
const CURSOR_MAX_BYTES = 2_048;

export class FilterRuleSystemError extends Error {
  constructor(
    readonly code: 'not_found' | 'invalid_cursor' | 'stale_cursor' | 'invalid_request',
    message: string,
  ) {
    super(message);
  }
}

function text(value: unknown, limit = 500): string | undefined {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized ? normalized.slice(0, limit) : undefined;
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function sourceEventArgv(event: JudgedEvent): string[] {
  for (const key of ['argv', 'process.argv', 'command.argv']) {
    const value = event.attributes[key];
    if (Array.isArray(value)) return value.map(String).slice(0, 64);
  }
  return [];
}

function probeForEventKind(kind: string | undefined): FilterRuleEvaluationContext['probe'] {
  if (kind === 'ToolExec') return 'exec';
  if (kind === 'ProcessExit') return 'exit';
  if (kind === 'FileAccess') return 'file_access';
  if (kind === 'FileDelete') return 'file_delete';
  if (kind === 'Dns') return 'dns';
  if (kind === 'Egress') return 'connect';
  if (kind === 'SslContent') return 'ssl';
  if (kind === 'LlmCall' || kind === 'LlmInteraction' || kind === 'AgentTool' || kind === 'AgentInvocation') return 'llm';
  if (kind === 'SecurityAction') return 'security';
  return undefined;
}

function outcomeText(receipt: FilterRuleDecisionReceipt): string {
  return receipt.outcome ? filterRuleEffectDescription(receipt.outcome) : receipt.failOpen ? 'Discovery-safe fail-open' : '无匹配动作';
}

function infrastructureOperation(operation: InfrastructureRuleOperationRecord) {
  return {
    operationId: operation.operationId,
    kind: operation.kind === 'asset_draft' ? 'create' as const : operation.kind,
    status: operation.status,
    ruleId: operation.ruleId,
    actorId: operation.actorId,
    requestedAt: operation.requestedAt,
    completedAt: operation.completedAt,
    previousRevision: operation.previousRevision,
    resultingRevision: operation.resultingRevision,
    reason: operation.reason,
    error: operation.error,
  };
}

@Injectable()
export class FilterRuleSystemService {
  constructor(
    private readonly catalog: FilterRuleCatalogService,
    private readonly infrastructure: InfrastructureRuleService,
    private readonly agentMetadata: AgentMetadataService,
    private readonly unknownLearning: UnknownLearningRuntimeService,
    private readonly kube: KubeIdentityService,
    private readonly judge: SentryJudgeService,
    private readonly assetSnapshot: InfrastructureAssetSnapshotService,
    private readonly observedAssets: ObservedAssetLifecycleService,
  ) {}

  catalogRules(): FilterRuleRecord[] {
    const rules = this.catalog.allRules();
    for (const record of this.infrastructure.catalogRecords()) {
      rules.push(infrastructureFilterRule(record, this.infrastructure.getHuman(record.ruleId)));
    }
    for (const record of this.agentMetadata.list()) {
      const rule = reviewedIdentityFilterRule(record);
      if (rule) rules.push(rule);
    }
    for (const policy of this.unknownLearning.catalogPolicies()) rules.push(unknownLearningFilterRule(policy));
    return rules;
  }

  versions(): { catalogVersion: string; domainVersions: FilterRuleDomainVersions; updatedAt: number } {
    const core = this.catalog.versions();
    const infrastructure = this.infrastructure.status();
    const infrastructureRules = this.infrastructure.catalogRecords();
    const infrastructureFingerprint = infrastructureRules.map((rule) => [
      rule.ruleId,
      rule.revision,
      rule.lifecycleStage,
      rule.updatedAt,
    ]);
    const reviewVersion = this.agentMetadata.identitySnapshotVersion();
    const reviewedAssets = this.agentMetadata.list();
    const policies = this.unknownLearning.catalogPolicies();
    const policyFingerprint = policies.map((policy) => [policy.policyId, policy.revision, policy.stage]);
    const learningVersion = Math.max(0, ...policies.map((policy) => policy.updatedAt));
    const catalogVersion = `frc_${filterRuleDigest([
      core.catalogVersion,
      infrastructure.policyVersion,
      infrastructureFingerprint,
      reviewVersion,
      policyFingerprint,
    ]).slice(0, 20)}`;
    return {
      catalogVersion,
      domainVersions: {
        identity: core.domainVersions.identity + reviewVersion + infrastructure.policyVersion + learningVersion,
        capture: core.domainVersions.capture + infrastructure.policyVersion,
        forwarder: core.domainVersions.forwarder + infrastructure.policyVersion,
        retention: core.domainVersions.retention,
      },
      updatedAt: Math.max(
        core.updatedAt,
        ...infrastructureRules.map((rule) => rule.updatedAt),
        ...reviewedAssets.map((record) => Date.parse(record.updatedAt)).filter(Number.isFinite),
        ...policies.map((policy) => policy.updatedAt),
        1,
      ),
    };
  }

  list(query: FilterRuleCatalogQuery = {}): FilterRuleCatalogResult {
    const version = this.versions();
    const q = text(query.q, 240)?.toLowerCase();
    const rules = this.catalogRules();
    const summaries = rules.map((rule) => this.summary(rule, version.domainVersions));
    const filtered = summaries.filter((rule) =>
      (!q || [rule.ruleId, rule.name, rule.description, rule.matcherText, rule.effectText, rule.sourceLabel]
        .some((value) => value.toLowerCase().includes(q)))
      && (!query.category || query.category === 'all' || rule.category === query.category)
      && (!query.kind || query.kind === 'all' || rule.ruleKind === query.kind)
      && (!query.stage || query.stage === 'all' || rule.stageImpacts.some((impact) => impact.stage === query.stage && impact.applicability !== 'not_applicable'))
      && (!query.lifecycleStage || query.lifecycleStage === 'all' || rule.lifecycleStage === query.lifecycleStage)
      && (!query.source || query.source === 'all' || rule.source.type === query.source)
      && (query.editable === undefined || rule.editable === query.editable));
    filtered.sort((left, right) =>
      CATEGORY_ORDER.indexOf(left.category) - CATEGORY_ORDER.indexOf(right.category)
      || Number(right.lifecycleStage === 'enforced') - Number(left.lifecycleStage === 'enforced')
      || right.priority - left.priority
      || left.name.localeCompare(right.name));
    const fingerprint = filterRuleDigest({
      q,
      category: query.category,
      kind: query.kind,
      stage: query.stage,
      lifecycleStage: query.lifecycleStage,
      source: query.source,
      editable: query.editable,
    }).slice(0, 20);
    const offset = this.decodeCursor(query.cursor, version.catalogVersion, fingerprint);
    const limit = integer(query.limit, 100, 1, 200);
    const items = filtered.slice(offset, offset + limit);
    const nextOffset = offset + items.length;
    return {
      items,
      total: filtered.length,
      nextCursor: nextOffset < filtered.length
        ? this.encodeCursor({ version: version.catalogVersion, fingerprint, offset: nextOffset })
        : undefined,
      catalogVersion: version.catalogVersion,
      domainVersions: version.domainVersions,
      categories: this.categorySummary(summaries),
      kinds: (Object.keys(FILTER_RULE_KIND_LABELS) as Array<keyof typeof FILTER_RULE_KIND_LABELS>).map((kind) => ({
        kind,
        label: FILTER_RULE_KIND_LABELS[kind],
        category: FILTER_RULE_KIND_CATEGORIES[kind],
        total: summaries.filter((summary) => summary.ruleKind === kind).length,
      })),
      updateTime: new Date(version.updatedAt).toISOString(),
    };
  }

  get(ruleId: string): FilterRuleHumanDetail {
    const version = this.versions();
    try {
      const rule = this.catalog.get(ruleId);
      return humanFilterRuleDetail({
        rule,
        versions: version.domainVersions,
        revisions: this.catalog.getRevisions(ruleId),
        operations: this.catalog.listOperations(ruleId),
        stats: this.stats(rule),
      });
    } catch (error) {
      if (!(error instanceof FilterRuleError) || error.code !== 'not_found') throw error;
    }
    if (ruleId.startsWith('ifr_')) {
      const raw = this.infrastructure.get(ruleId);
      const detail = this.infrastructure.getHuman(ruleId);
      const rule = infrastructureFilterRule(raw, detail);
      return humanFilterRuleDetail({
        rule,
        versions: version.domainVersions,
        revisions: detail.revisionHistory.map((revision) => ({
          ...rule,
          revision: revision.revision,
          lifecycleStage: revision.stage,
          authority: revision.authority,
          updatedAt: Date.parse(revision.updatedAt),
          approvedBy: revision.approvedBy,
        })),
        operations: detail.operationHistory.map(infrastructureOperation),
        stats: {
          matchedAssets: detail.matchedInstances,
          matchedInstances: detail.matchedInstances,
          matchedNodes: detail.matchedNodes,
          conflicts: detail.agentConflicts,
          lastAppliedAt: detail.lastControlUpdate,
        },
        materialization: {
          reports: detail.control.reports,
          acceptedBindings: detail.control.acceptedBindings,
          activeBindings: detail.control.activeBindings,
          nodes: [...detail.control.nodes],
          lastReportAt: detail.control.lastReportAt,
        },
      });
    }
    const dynamic = this.catalogRules().find((rule) => rule.ruleId === ruleId);
    if (!dynamic) throw new FilterRuleSystemError('not_found', 'filter rule not found');
    return humanFilterRuleDetail({ rule: dynamic, versions: version.domainVersions, stats: this.stats(dynamic) });
  }

  status(): FilterRuleSystemStatus {
    const version = this.versions();
    const rules = this.catalogRules();
    const stages = this.stageStatus(rules, version.domainVersions);
    const conflicts = rules.reduce((total, rule) => total + this.stats(rule).conflicts, 0);
    return {
      schemaVersion: 'anysentry.filter_rule_system_status.v1',
      catalogVersion: version.catalogVersion,
      domainVersions: version.domainVersions,
      totalRules: rules.length,
      editableRules: rules.filter((rule) => rule.editable).length,
      conflicts,
      degradedStages: stages.filter((stage) => stage.status !== 'ready').length,
      stages,
      updateTime: new Date().toISOString(),
    };
  }

  materializations() {
    const items = this.infrastructure.catalogRecords().map((record) => {
      const detail = this.infrastructure.getHuman(record.ruleId);
      return {
        ruleId: record.ruleId,
        revision: record.revision,
        name: record.name,
        stage: record.lifecycleStage,
        reports: detail.control.reports,
        acceptedBindings: detail.control.acceptedBindings,
        activeBindings: detail.control.activeBindings,
        conflicts: detail.control.conflicts,
        nodes: [...detail.control.nodes],
        lastReportAt: detail.control.lastReportAt,
      };
    });
    return { items, total: items.length, updateTime: new Date().toISOString() };
  }

  projection() {
    const version = this.versions();
    return compileFilterRuleProjection({
      rules: this.catalogRules(),
      catalogVersion: this.runtimeCatalogVersion(version.updatedAt),
      domainVersions: version.domainVersions,
    });
  }

  raw(ruleId: string) {
    if (ruleId.startsWith('ifr_')) return this.infrastructure.get(ruleId);
    return this.catalog.get(ruleId);
  }

  async explain(request: FilterRuleExplainRequest): Promise<FilterRuleExplainResult> {
    const eventId = text(request.eventId, 240);
    const assetId = text(request.assetId, 240);
    if (Boolean(eventId) === Boolean(assetId)) {
      throw new FilterRuleSystemError('invalid_request', 'provide exactly one eventId or assetId');
    }
    let context: FilterRuleEvaluationContext;
    let subject: FilterRuleExplainResult['subject'];
    let facts: FilterRuleExplainResult['context']['facts'];
    if (eventId) {
      const event = this.judge.findEvent(eventId) ?? await this.judge.storedEventById(eventId);
      if (!event) throw new FilterRuleSystemError('not_found', 'event not found');
      ({ context, facts } = this.eventContext(event));
      subject = { type: 'event', id: event.eventId, label: event.subject || `${event.eventKind} event` };
    } else {
      const snapshot = this.assetSnapshot.snapshot();
      const asset = snapshot.assets.find((candidate) => candidate.assetId === assetId);
      if (asset) {
        context = this.assetContext(asset, 'FileAccess');
        facts = [
          { label: 'Asset', value: asset.displayName, source: snapshot.provider },
          { label: 'Identity', value: asset.classification, source: snapshot.provider },
          { label: 'Role', value: asset.workloadRole, source: snapshot.provider },
          { label: 'Physical workload', value: asset.workload.physicalWorkloadId, source: snapshot.provider },
        ];
        subject = { type: 'asset', id: asset.assetId, label: asset.displayName };
      } else {
        await this.observedAssets.ensureAsset(assetId!);
        const detail = this.observedAssets.detail(assetId!);
        if (!detail) throw new FilterRuleSystemError('not_found', 'asset not found in the current server-owned asset model');
        ({ context, facts } = this.observedAssetContext(detail));
        subject = { type: 'asset', id: detail.asset.subjectAssetId, label: detail.asset.displayName };
      }
    }
    return this.explainContext(subject, context, facts);
  }

  example(exampleId: string): FilterRuleExplainResult {
    if (exampleId !== 'agent-infrastructure-conflict') {
      throw new FilterRuleSystemError('not_found', 'filter rule example not found');
    }
    return this.explainContext(
      {
        type: 'simulation',
        id: exampleId,
        label: 'ClickHouse 容器中启动 Codex 并访问文件',
      },
      {
        process: { comm: 'codex', exe: '/opt/bin/codex', argv: ['/opt/bin/codex', 'exec', 'id'] },
        identityClassification: 'probable_agent',
        workloadRole: 'platform_infrastructure',
        workload: {
          placement: 'kubernetes',
          cluster: 'default-cluster',
          namespace: 'anysentry',
          ownerKind: 'StatefulSet',
          ownerName: 'clickhouse',
          container: 'clickhouse',
          labels: { 'anysentry.io/workload-role': 'platform_infrastructure' },
        },
        assetId: 'example:clickhouse',
        runtimeId: 'example:codex-runtime',
        eventKind: 'FileAccess',
        probe: 'file_access',
        conflict: true,
      },
      [
        { label: 'Runtime Signature', value: 'commExact=codex', source: 'Agent Runtime Signature v2' },
        { label: 'Workload', value: 'Kubernetes / anysentry / StatefulSet clickhouse / clickhouse', source: 'server-owned Inventory' },
        { label: 'Identity', value: 'probable_agent', source: 'process_signature' },
        { label: 'Role', value: 'platform_infrastructure', source: 'Kubernetes Inventory' },
        { label: 'Conflict', value: 'Agent 与 Infrastructure 同时匹配', source: 'unified precedence' },
      ],
    );
  }

  async simulate(request: FilterRuleSimulationRequest): Promise<FilterRuleSimulationResult> {
    const sample = await this.simulationSample(request);
    return this.simulateSync(request, sample.contexts, sample.metadata);
  }

  createDraft(input: FilterRuleDraftRequest, actor: FilterRuleActor) {
    return this.catalog.createDraft(input, actor);
  }

  createInfrastructureDraft(input: InfrastructureAssetDraftRequest, actor: FilterRuleActor) {
    return this.infrastructure.createDraftFromAsset(input, actor);
  }

  async preview(ruleId: string, actor: FilterRuleActor): Promise<FilterRulePreviewResult> {
    if (ruleId.startsWith('ifr_')) {
      const preview = await this.infrastructure.impactPreview(ruleId, actor);
      return this.infrastructurePreview(preview);
    }
    const rule = this.catalog.get(ruleId);
    const evaluated = this.evaluateAssetMatches(rule);
    return this.catalog.preview(ruleId, actor, { serverOwned: true, ...evaluated });
  }

  async shadow(ruleId: string, input: FilterRuleTransitionRequest, actor: FilterRuleActor) {
    if (ruleId.startsWith('ifr_')) return this.infrastructure.shadow(ruleId, input, actor);
    return this.catalog.shadow(ruleId, input, actor);
  }

  async promote(ruleId: string, input: FilterRuleTransitionRequest, actor: FilterRuleActor) {
    if (ruleId.startsWith('ifr_')) return this.infrastructure.promote(ruleId, input, actor);
    return this.catalog.promote(ruleId, input, actor);
  }

  async revoke(ruleId: string, input: FilterRuleTransitionRequest, actor: FilterRuleActor) {
    if (ruleId.startsWith('ifr_')) return this.infrastructure.revoke(ruleId, input, actor);
    return this.catalog.revoke(ruleId, input, actor);
  }

  operations(ruleId?: string, limit = 200) {
    const core = this.catalog.listOperations(ruleId, limit);
    const infrastructure = this.infrastructure.listOperations({ ruleId, limit }).items.map(infrastructureOperation);
    const items = [...core, ...infrastructure]
      .sort((left, right) => right.requestedAt - left.requestedAt)
      .slice(0, integer(limit, 200, 1, 500));
    return { items, total: core.length + infrastructure.length, updateTime: new Date().toISOString() };
  }

  private summary(rule: FilterRuleRecord, versions: FilterRuleDomainVersions): FilterRuleHumanSummary {
    const summary = humanFilterRuleSummary(rule, versions, this.stats(rule));
    if (rule.management === 'adapter' && rule.category === 'infrastructure') {
      summary.stageImpacts = summary.stageImpacts.map((impact) => impact.stage === 'f3'
        ? { ...impact, applicability: rule.lifecycleStage === 'enforced' ? 'indirect' : impact.applicability, action: '作为 non-Agent/Role 上下文参与 API Retention', reason: 'F0/F1 的角色与采集事实被 F3 消费' }
        : impact);
    }
    return summary;
  }

  private stats(rule: FilterRuleRecord) {
    if (rule.ruleId.startsWith('ifr_')) {
      const detail = this.infrastructure.getHuman(rule.ruleId);
      return {
        matchedAssets: detail.matchedInstances,
        matchedInstances: detail.matchedInstances,
        matchedNodes: detail.matchedNodes,
        conflicts: detail.agentConflicts,
        lastAppliedAt: detail.lastControlUpdate,
      };
    }
    if (rule.ruleKind === 'reviewed_identity_binding') {
      return { matchedAssets: 1, matchedInstances: 1, matchedNodes: 0, conflicts: 0 };
    }
    return { matchedAssets: 0, matchedInstances: 0, matchedNodes: 0, conflicts: 0 };
  }

  private categorySummary(items: FilterRuleHumanSummary[]): FilterRuleCategorySummary[] {
    return CATEGORY_ORDER.map((category) => {
      const rules = items.filter((item) => item.category === category);
      return {
        category,
        label: FILTER_RULE_CATEGORY_LABELS[category],
        total: rules.length,
        enforced: rules.filter((rule) => rule.lifecycleStage === 'enforced').length,
        candidates: rules.filter((rule) => rule.lifecycleStage === 'draft' || rule.lifecycleStage === 'shadow').length,
        conflicts: rules.reduce((total, rule) => total + rule.conflicts, 0),
        editable: rules.filter((rule) => rule.editable).length,
      };
    });
  }

  private encodeCursor(value: { version: string; fingerprint: string; offset: number }): string {
    return Buffer.from(JSON.stringify(value)).toString('base64url');
  }

  private decodeCursor(cursor: string | undefined, version: string, fingerprint: string): number {
    if (!cursor) return 0;
    if (Buffer.byteLength(cursor, 'utf8') > CURSOR_MAX_BYTES) throw new FilterRuleSystemError('invalid_cursor', 'catalog cursor is too large');
    let parsed: { version?: unknown; fingerprint?: unknown; offset?: unknown };
    try {
      parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as typeof parsed;
    } catch {
      throw new FilterRuleSystemError('invalid_cursor', 'catalog cursor is malformed');
    }
    if (parsed.version !== version) throw new FilterRuleSystemError('stale_cursor', 'catalog changed; restart pagination');
    if (parsed.fingerprint !== fingerprint) throw new FilterRuleSystemError('invalid_cursor', 'catalog cursor does not match the current filters');
    return integer(parsed.offset, -1, -1, 100_000) >= 0
      ? Number(parsed.offset)
      : (() => { throw new FilterRuleSystemError('invalid_cursor', 'catalog cursor offset is invalid'); })();
  }

  private stageStatus(rules: FilterRuleRecord[], versions: FilterRuleDomainVersions): FilterRuleStageStatus[] {
    const heads = this.judge.collectorHeartbeatHeads().latestMetrics;
    const now = Date.now();
    const rollout = correlationCaptureRollout();
    const infrastructure = this.infrastructure.status();
    const desiredCatalogVersion = this.runtimeCatalogVersion(this.versions().updatedAt);
    const expectedIdentitySnapshotVersion = this.kube.snapshot().version + this.agentMetadata.identitySnapshotVersion();
    const stageNodes = (stage: FilterRuleStage): FilterRuleStageRuntimeNode[] => heads.map((heartbeat) => {
      const metrics = heartbeat.filterMetrics as typeof heartbeat.filterMetrics & {
        unifiedCatalogVersion?: number;
        unifiedIdentityVersion?: number;
        unifiedCaptureVersion?: number;
        unifiedForwarderVersion?: number;
        unifiedProjectionState?: string;
      };
      const centralIdentityFactVersion = metrics.identityKubernetesVersion
        ?? (metrics.dockerEnabled ? undefined : metrics.identitySnapshotVersion);
      const domainVersion = stage === 'f0'
        ? metrics.unifiedIdentityVersion
        : stage === 'f1'
          ? metrics.unifiedCaptureVersion
          : stage === 'f2'
            ? metrics.unifiedForwarderVersion
            : versions.retention;
      const desired = stage === 'f0'
        ? versions.identity
        : stage === 'f1'
          ? versions.capture
          : stage === 'f2'
            ? versions.forwarder
            : versions.retention;
      const stale = now - (heartbeat.filterMetricsReportedAt ?? heartbeat.at) > 120_000;
      const compatible = stage === 'f3' || (
        domainVersion === desired
        && metrics.unifiedCatalogVersion === desiredCatalogVersion
      );
      const identityFactsAligned = stage !== 'f0' || (
        metrics.identitySnapshotReady === true
        && metrics.identityErrors === 0
        && (!metrics.dockerEnabled || metrics.dockerReady)
        && centralIdentityFactVersion === expectedIdentitySnapshotVersion
      );
      const infrastructureAligned = (stage !== 'f1' && stage !== 'f2') || metrics.infrastructurePolicyVersion === infrastructure.policyVersion;
      const status: FilterRuleStageRuntimeNode['status'] = stale
        ? 'stale'
        : metrics.unifiedProjectionState === 'degraded'
          ? 'degraded'
          : compatible && identityFactsAligned && infrastructureAligned
            ? 'aligned'
            : 'drifted';
      const reason = domainVersion === undefined && stage !== 'f3'
        ? '等待统一 Stage Projection 回报；当前仍使用兼容投影'
        : status === 'aligned'
          ? '运行版本与目标版本一致'
          : stale
            ? '节点运行回报已过期'
            : metrics.unifiedProjectionState === 'degraded'
              ? '统一投影处于 LKG/degraded 状态'
              : !compatible
                ? `目标 Catalog/domain ${desiredCatalogVersion}/${desired}，运行 ${metrics.unifiedCatalogVersion ?? 'unknown'}/${domainVersion ?? 'unknown'}`
                : stage === 'f0' && !identityFactsAligned
                  ? `中央身份事实目标 ${expectedIdentitySnapshotVersion}，节点已加载 ${centralIdentityFactVersion ?? 'unknown'}，本地综合版本 ${metrics.identitySnapshotVersion}`
                  : !infrastructureAligned
                    ? `Infrastructure policy 目标 ${infrastructure.policyVersion}，节点已加载 ${metrics.infrastructurePolicyVersion ?? 'unknown'}`
                    : '运行上下文尚未对齐';
      return {
        nodeId: heartbeat.nodeName ?? heartbeat.collectorId,
        status,
        catalogVersion: metrics.unifiedCatalogVersion,
        domainVersion,
        factVersion: stage === 'f0' ? centralIdentityFactVersion : undefined,
        localFactVersion: stage === 'f0' ? metrics.identitySnapshotVersion : undefined,
        policyVersion: metrics.infrastructurePolicyVersion,
        epoch: metrics.filterRuleVersion,
        mode: stage === 'f1' ? metrics.captureProfileMode : stage === 'f2' ? metrics.filterMode : stage === 'f0' ? 'resolve' : rollout.unknownRetention,
        ruleEntries: metrics.filterRuleEntries,
        conflicts: metrics.filterRuleConflicts,
        lastReportedAt: new Date(heartbeat.filterMetricsReportedAt ?? heartbeat.at).toISOString(),
        reason,
      };
    });
    const metricTotal = (read: (metrics: CollectorHeartbeatRecord['filterMetrics']) => number | undefined) =>
      heads.reduce((total, heartbeat) => total + Math.max(0, Number(read(heartbeat.filterMetrics)) || 0), 0);
    return STAGES.map((stage) => {
      const nodes = stage === 'f3' ? [] : stageNodes(stage);
      const activeRules = rules.filter((rule) =>
        (rule.lifecycleStage === 'enforced' || rule.authority === 'immutable')
        && this.summary(rule, versions).stageImpacts.some((impact) => impact.stage === stage && impact.applicability !== 'not_applicable')).length;
      const status: FilterRuleStageStatus['status'] = stage === 'f3'
        ? 'ready'
        : !nodes.length ? 'unknown'
          : nodes.some((node) => node.status === 'drifted') ? 'drifted'
            : nodes.some((node) => node.status === 'degraded' || node.status === 'stale') ? 'degraded'
              : 'ready';
      const desiredVersion = stage === 'f0'
        ? `${versions.identity} / facts ${expectedIdentitySnapshotVersion}`
        : stage === 'f1' ? versions.capture : stage === 'f2' ? versions.forwarder : versions.retention;
      return {
        stage,
        label: STAGE_LABELS[stage],
        mode: stage === 'f1'
          ? rollout.captureProfile
          : stage === 'f2'
            ? heads[0]?.filterMetrics.filterMode ?? 'unknown'
            : stage === 'f3' ? rollout.unknownRetention : 'resolve',
        desiredVersion,
        activeRules,
        decisions: stage === 'f1'
          ? metricTotal((metrics) => metrics.captureAggregateDecisionAttempts)
          : stage === 'f2' ? metricTotal((metrics) => metrics.observed) : 0,
        suppressed: stage === 'f1'
          ? metricTotal((metrics) => metrics.infrastructurePolicyEnforced)
          : stage === 'f2'
            ? metricTotal((metrics) => metrics.filteredNonAgent + metrics.filteredUnknown + metrics.filteredNoise + metrics.discoveryBudgetDropped)
            : 0,
        aggregated: stage === 'f1'
          ? metricTotal((metrics) => metrics.captureAggregateOutputs)
          : stage === 'f2' ? metricTotal((metrics) => metrics.aggregatedFileEvents) : 0,
        lost: stage === 'f2'
          ? metricTotal((metrics) => metrics.queueDropped + (metrics.protectedQueueDropped ?? 0))
          : 0,
        status,
        reason: status === 'ready'
          ? '目标规则与运行投影一致'
          : status === 'unknown' ? '尚无当前运行节点回报' : '存在版本漂移、过期或降级节点',
        nodes,
      };
    });
  }

  private eventContext(event: JudgedEvent): { context: FilterRuleEvaluationContext; facts: FilterRuleExplainResult['context']['facts'] } {
    const workload = event.attribution?.workloadRef;
    const identity = closedClassification(event.classificationSemantics?.identityClassification ?? event.attribution?.classification);
    const role = closedWorkloadRole(event.classificationSemantics?.workloadRole);
    const context: FilterRuleEvaluationContext = {
      process: { comm: event.process?.comm, exe: event.process?.exe, argv: sourceEventArgv(event) },
      identityClassification: identity,
      workloadRole: role,
      workload: {
        placement: workload?.environment,
        namespace: workload?.namespace,
        ownerKind: workload?.ownerKind,
        ownerName: workload?.ownerName,
        container: workload?.containerName,
        service: workload?.name,
        systemdUnit: workload?.systemdUnit,
      },
      assetId: event.subjectAssetId,
      runtimeId: event.attribution?.agentInstanceId,
      eventKind: event.eventKind,
      probe: probeForEventKind(event.eventKind),
      conflict: event.attribution?.conflict === true || event.assetBindingQuality === 'conflict',
      stale: false,
    };
    return {
      context,
      facts: [
        { label: 'Identity', value: identity, source: event.attribution?.source ?? 'event' },
        { label: 'Workload role', value: role, source: 'classificationSemantics' },
        { label: 'Event kind', value: event.eventKind, source: event.source },
        ...(event.process?.comm ? [{ label: 'Process comm', value: event.process.comm, source: 'kernel' }] : []),
        ...(event.process?.exe ? [{ label: 'Executable', value: basename(event.process.exe), source: 'kernel' }] : []),
        ...(event.attribution?.physicalWorkloadId ? [{ label: 'Physical workload', value: event.attribution.physicalWorkloadId, source: event.attribution.source }] : []),
      ],
    };
  }

  private runtimeCatalogVersion(updatedAt: number): number {
    const timePart = Math.max(1, Math.trunc(updatedAt)) * 1_000;
    return Math.min(Number.MAX_SAFE_INTEGER, timePart + (this.catalog.versions().catalogVersion % 1_000));
  }

  private assetContext(asset: ReturnType<InfrastructureAssetSnapshotService['snapshot']>['assets'][number], eventKind = 'FileAccess'): FilterRuleEvaluationContext {
    return {
      identityClassification: asset.classification,
      workloadRole: asset.workloadRole,
      workload: {
        placement: asset.workload.placement,
        cluster: asset.workload.clusterId,
        namespace: asset.workload.namespace,
        ownerKind: asset.workload.ownerKind,
        ownerName: asset.workload.ownerName,
        container: asset.workload.containerName,
        service: asset.workload.serviceName,
        systemdUnit: asset.workload.systemdUnit,
        labels: asset.workload.labels,
      },
      assetId: asset.assetId,
      eventKind,
      probe: probeForEventKind(eventKind),
      conflict: asset.conflict === true || asset.sharedScope === true,
      stale: asset.continuity?.currentPresenceVerified !== true,
    };
  }

  private observedAssetContext(detail: ObservedAssetDetailReadResponse): {
    context: FilterRuleEvaluationContext;
    facts: FilterRuleExplainResult['context']['facts'];
  } {
    const asset = detail.asset;
    const runtime = detail.runtimes.find((candidate) => candidate.state === 'current' || candidate.state === 'starting')
      ?? detail.runtimes.find((candidate) => candidate.state !== 'exited' && candidate.state !== 'lost');
    const placement = runtime?.placement === 'kubernetes' || runtime?.placement === 'docker' || runtime?.placement === 'host'
      ? runtime.placement
      : undefined;
    const physicalWorkload = detail.bindings.find((binding) => !binding.validTo && binding.physicalWorkloadId)?.physicalWorkloadId;
    return {
      context: {
        identityClassification: closedClassification(asset.identity.classification),
        workloadRole: closedWorkloadRole(asset.role.role),
        workload: {
          placement,
          cluster: asset.scope.clusterId,
          namespace: asset.scope.namespace,
          ownerKind: asset.scope.ownerKind,
          ownerName: asset.scope.ownerName,
          container: asset.scope.containerName,
          systemdUnit: asset.scope.systemdUnit,
        },
        assetId: asset.subjectAssetId,
        runtimeId: runtime?.runtimeInstanceId,
        eventKind: 'FileAccess',
        probe: 'file_access',
        conflict: asset.bindingQuality === 'conflict',
        stale: asset.existenceState !== 'active',
      },
      facts: [
        { label: 'Asset', value: asset.displayName, source: 'observed_asset.v1' },
        { label: 'Identity', value: asset.identity.classification, source: asset.identity.source },
        { label: 'Role', value: asset.role.role, source: asset.role.source },
        { label: 'Binding quality', value: asset.bindingQuality, source: 'observed_asset.v1' },
        ...(physicalWorkload ? [{ label: 'Physical workload', value: physicalWorkload, source: 'server-owned binding' }] : []),
      ],
    };
  }

  private explainContext(
    subject: FilterRuleExplainResult['subject'],
    context: FilterRuleEvaluationContext,
    facts: FilterRuleExplainResult['context']['facts'],
  ): FilterRuleExplainResult {
    const versions = this.versions();
    const rules = this.catalogRules();
    const stages = STAGES.map((stage) => evaluateFilterRules({
      rules,
      context,
      stage,
      catalogVersion: this.catalog.versions().catalogVersion,
      domainVersions: versions.domainVersions,
      includeShadow: true,
    }));
    const winners = stages.flatMap((stage) => stage.winner ? [stage.winner.ruleId] : []);
    const related = stages.flatMap((stage) => stage.candidates.filter((candidate) => candidate.matched).map((candidate) => candidate.ruleId));
    return {
      schemaVersion: 'anysentry.filter_rule_explain.v1',
      subject,
      context: {
        identityClassification: context.identityClassification ?? 'unknown',
        workloadRole: context.workloadRole ?? 'unknown',
        eventKind: context.eventKind,
        probe: context.probe,
        conflict: context.conflict === true,
        facts,
      },
      stages,
      finalOutcome: outcomeText(stages.find((stage) => stage.stage === 'f3')!),
      winningRuleIds: [...new Set(winners)],
      relatedRuleIds: [...new Set(related)],
      warnings: stages.filter((stage) => stage.failOpen).map((stage) => `${stage.stage}: ${stage.reason}`),
      evaluatedAt: new Date().toISOString(),
    };
  }

  private evaluateAssetMatches(rule: FilterRuleRecord) {
    const snapshot = this.assetSnapshot.snapshot();
    const matched = snapshot.assets.filter((asset) => matchFilterRule(rule, this.assetContext(asset)).matched);
    return {
      matchedAssets: matched.length,
      matchedInstances: matched.reduce((total, asset) => total + asset.instanceCount, 0),
      matchedNodes: new Set(matched.flatMap((asset) => asset.nodeIds)).size,
      conflicts: matched.filter((asset) => asset.conflict || asset.sharedScope || asset.classification === 'confirmed_agent' || asset.classification === 'probable_agent').length,
      errors: [],
      warnings: [...(snapshot.errors ?? []), ...(snapshot.partialReasons ?? [])],
    };
  }

  private async simulationSample(request: FilterRuleSimulationRequest): Promise<{
    contexts: Array<{ id: string; label: string; context: FilterRuleEvaluationContext }>;
    metadata: FilterRuleSimulationResult['sample'];
  }> {
    if (request.context) {
      return {
        contexts: [{ id: 'simulation', label: '输入上下文', context: request.context }],
        metadata: { source: 'provided_context', evaluated: 1, hasMore: false, partial: false, reasons: [] },
      };
    }
    if (request.historyWindow) {
      const durations = { last_30m: 30 * 60_000, last_3h: 3 * 60 * 60_000, last_24h: 24 * 60 * 60_000 } as const;
      const duration = durations[request.historyWindow];
      if (!duration) throw new FilterRuleSystemError('invalid_request', 'historyWindow must be last_30m, last_3h, or last_24h');
      const untilMs = Date.now();
      const limit = integer(request.sampleLimit, 200, 1, 500);
      const page = await this.judge.searchStoredEventsPage({
        sinceMs: untilMs - duration,
        untilMs,
        monitoredOnly: false,
        limit,
      });
      if (!page.unavailable) {
        const contexts = page.events.map((event) => ({
          id: event.eventId,
          label: event.subject || `${event.eventKind} event`,
          context: this.eventContext(event).context,
        }));
        return {
          contexts,
          metadata: {
            source: 'historical_events',
            historyWindow: request.historyWindow,
            evaluated: contexts.length,
            hasMore: page.hasMore,
            partial: page.hasMore,
            reasons: page.hasMore ? ['historical_sample_truncated'] : [],
          },
        };
      }
      const fallback = this.assetSnapshot.snapshot().assets.map((asset) => ({
        id: asset.assetId,
        label: asset.displayName,
        context: this.assetContext(asset),
      }));
      return {
        contexts: fallback,
        metadata: {
          source: 'current_inventory',
          historyWindow: request.historyWindow,
          evaluated: fallback.length,
          hasMore: false,
          partial: true,
          reasons: ['historical_event_store_unavailable', 'fell_back_to_current_inventory'],
        },
      };
    }
    const contexts = this.assetSnapshot.snapshot().assets.map((asset) => ({
      id: asset.assetId,
      label: asset.displayName,
      context: this.assetContext(asset),
    }));
    return {
      contexts,
      metadata: { source: 'current_inventory', evaluated: contexts.length, hasMore: false, partial: false, reasons: [] },
    };
  }

  private simulateSync(
    request: FilterRuleSimulationRequest,
    contexts: Array<{ id: string; label: string; context: FilterRuleEvaluationContext }>,
    sample: FilterRuleSimulationResult['sample'],
  ): FilterRuleSimulationResult {
    let rule: FilterRuleRecord;
    if (request.draft) {
      const inspection = this.catalog.inspectDraft(request.draft);
      if (!inspection.valid || !inspection.rule) {
        throw new FilterRuleSystemError('invalid_request', inspection.errors.join('; '));
      }
      rule = inspection.rule;
    } else if (request.ruleId) {
      const found = this.catalogRules().find((candidate) => candidate.ruleId === request.ruleId);
      if (!found) throw new FilterRuleSystemError('not_found', 'filter rule not found');
      rule = found;
    } else {
      throw new FilterRuleSystemError('invalid_request', 'simulation requires ruleId or draft');
    }
    const versions = this.versions();
    const baseRules = this.catalogRules().filter((candidate) => candidate.ruleId !== rule.ruleId);
    const simulatedRule: FilterRuleRecord = {
      ...rule,
      lifecycleStage: 'enforced',
      authority: effectIsDestructiveForSimulation(rule) ? 'authoritative' : rule.authority,
    };
    const stageChanges: FilterRuleSimulationResult['stageChanges'] = [];
    const examples: FilterRuleSimulationResult['examples'] = [];
    for (const stage of STAGES) {
      const before: Record<string, number> = {};
      const after: Record<string, number> = {};
      let changed = 0;
      for (const item of contexts) {
        const beforeReceipt = evaluateFilterRules({ rules: baseRules, context: item.context, stage, catalogVersion: this.catalog.versions().catalogVersion, domainVersions: versions.domainVersions });
        const afterReceipt = evaluateFilterRules({ rules: [...baseRules, simulatedRule], context: item.context, stage, catalogVersion: this.catalog.versions().catalogVersion + 1, domainVersions: versions.domainVersions });
        const beforeText = outcomeText(beforeReceipt);
        const afterText = outcomeText(afterReceipt);
        before[beforeText] = (before[beforeText] ?? 0) + 1;
        after[afterText] = (after[afterText] ?? 0) + 1;
        if (beforeText !== afterText) {
          changed += 1;
          if (examples.length < 20) examples.push({ assetId: item.id, label: item.label, stage, before: beforeText, after: afterText });
        }
      }
      stageChanges.push({ stage, evaluated: contexts.length, changed, before, after });
    }
    const matched = contexts.filter((item) => matchFilterRule(rule, item.context).matched);
    const conflicts = matched.filter((item) => item.context.conflict).length;
    const preview: FilterRulePreviewResult = {
      ruleId: rule.ruleId,
      revision: rule.revision,
      valid: true,
      errors: [],
      warnings: [
        ...(matched.length ? [] : ['当前有界样本没有匹配对象']),
        ...sample.reasons,
      ],
      destructive: effectIsDestructiveForSimulation(rule),
      affectedStages: [...rule.consumerCapabilities],
      matchedAssets: matched.length,
      matchedInstances: matched.length,
      matchedNodes: 0,
      conflicts,
      canEnterShadow: rule.lifecycleStage === 'draft',
      canPromote: rule.lifecycleStage === 'shadow' && conflicts === 0,
      stageImpacts: this.summary(rule, versions.domainVersions).stageImpacts,
    };
    return {
      schemaVersion: 'anysentry.filter_rule_simulation.v1',
      preview,
      sample,
      stageChanges,
      examples,
      evaluatedAt: new Date().toISOString(),
    };
  }

  private infrastructurePreview(preview: InfrastructureRuleImpactPreview): FilterRulePreviewResult {
    return {
      ruleId: preview.ruleId,
      revision: preview.revision,
      valid: preview.valid,
      errors: [...preview.errors],
      warnings: [...preview.warnings],
      destructive: preview.expectedSignals.some((signal) => signal.action === 'drop'),
      affectedStages: ['f0', 'f1', 'f2', 'f3'],
      matchedAssets: preview.matchedAssets,
      matchedInstances: preview.matchedInstances,
      matchedNodes: preview.matchedNodes,
      conflicts: preview.agentConflicts + preview.sharedScopeConflicts,
      canEnterShadow: preview.canEnterShadow,
      canPromote: preview.canPromoteToEnforced,
      stageImpacts: this.get(preview.ruleId).stageImpacts,
    };
  }
}

function effectIsDestructiveForSimulation(rule: FilterRuleRecord): boolean {
  if (rule.effect.type === 'assign_capture_profile') return Object.values(rule.effect.probeActions).includes('drop');
  if (rule.effect.type === 'semantic_retention') return rule.effect.action === 'suppress';
  if (rule.effect.type === 'persistence_retention') return rule.effect.action === 'discard' || rule.effect.action === 'reject';
  return false;
}
