import {
  CaptureProbeActions,
  CaptureProbeName,
  InfrastructureCaptureIntentAction,
  InfrastructureEventPolicyKind,
  InfrastructureInventoryWorkload,
  InfrastructureRuleHumanDetail,
  InfrastructureRuleHumanProbePolicy,
  InfrastructureRuleHumanScopeField,
  InfrastructureRuleHumanSummary,
  InfrastructureRuleOperationRecord,
  InfrastructureRuleImpactPartialReason,
  InfrastructureRuleRecord,
  InfrastructureMaterializationReportRecord,
} from './infrastructure-rule.types';

export const INFRASTRUCTURE_ASSET_SNAPSHOT_PROVIDER = 'ANYSENTRY_INFRASTRUCTURE_ASSET_SNAPSHOT_PROVIDER';

export type InfrastructureAssetBindingQuality = 'exact' | 'logical' | 'ephemeral' | 'weak' | 'conflict';

export interface InfrastructureGovernanceContinuityEvidence {
  /** Current presence comes only from a server-owned Inventory or active Runtime snapshot. */
  currentPresenceVerified: boolean;
  /** True only when an active Observation Coverage interval was actually read. */
  observationCoverageAvailable: boolean;
  /** True only when an independently refreshed Service Context source is currently available. */
  serviceContextAvailable: boolean;
  partialReasons?: InfrastructureRuleImpactPartialReason[];
}

export interface InfrastructureGovernanceAsset {
  assetId: string;
  revision: number;
  displayName: string;
  assetType: 'service' | 'infrastructure' | 'workload';
  bindingQuality: InfrastructureAssetBindingQuality;
  workloadRole: 'anysentry_internal' | 'platform_infrastructure' | 'business_service' | 'ordinary_process' | 'unknown';
  classification: 'confirmed_agent' | 'probable_agent' | 'unknown' | 'non_agent';
  conflict?: boolean;
  sharedScope?: boolean;
  workload: InfrastructureInventoryWorkload;
  instanceCount: number;
  nodeIds: string[];
  recentLogicalEvents?: number;
  signalCounts?: Partial<Record<InfrastructureEventPolicyKind, number>>;
  continuity?: InfrastructureGovernanceContinuityEvidence;
}

export interface InfrastructureGovernanceAssetSnapshot {
  schemaVersion: 'anysentry.infrastructure_asset_snapshot.v1';
  provider: string;
  trusted: true;
  ready: boolean;
  destructiveReady: boolean;
  version: number;
  generatedAt: number;
  assets: InfrastructureGovernanceAsset[];
  errors?: string[];
  partialReasons?: string[];
}

export interface InfrastructureAssetSnapshotProvider {
  snapshot(): InfrastructureGovernanceAssetSnapshot | Promise<InfrastructureGovernanceAssetSnapshot>;
}

const PROBE_LABELS: Record<CaptureProbeName, string> = {
  exec: '进程启动',
  exit: '进程退出',
  tls: 'TLS 连接',
  connect: '网络连接',
  dns: 'DNS 查询',
  file_access: '文件访问',
  file_delete: '文件删除',
  llm: 'LLM 调用',
  ssl: 'SSL 内容',
  security: '安全事件',
  file_read: '文件只读打开',
};

const ACTION_LABELS = {
  full: '完整保留',
  aggregate: '聚合保留',
  sample: '有界采样',
  drop: '停止常规明细',
  not_enabled: '默认未启用',
} as const;

const INTENT_COPY: Record<InfrastructureCaptureIntentAction, { label: string; description: string }> = {
  full: { label: '保持完整采集', description: '保留该资产的完整信号，用于 Agent、安全或临时调查。' },
  aggregate: { label: '减少重复基础设施信号', description: '聚合重复文件和网络信号，同时保留安全与进程结构。' },
  sample: { label: '有界发现工作负载', description: '保留首批和周期样本，控制未知或候选对象的事件量。' },
  drop: { label: '停止已确认低价值信号', description: '仅在双人审批、Inventory 校验和控制面握手后停止常规明细。' },
};

const STAGE_LABELS = {
  draft: '草稿',
  shadow: '观察中',
  enforced: '已生效',
  revoked: '已停用',
} as const;

const SOURCE_LABELS: Record<InfrastructureRuleRecord['source']['type'], string> = {
  manual_review: '人工身份审核',
  platform_inventory: '平台资产清单',
  kubernetes: 'Kubernetes 资产清单',
  docker: 'Docker 资产清单',
  operator: '审核人员创建',
  behavior_discovery: '行为发现建议',
  imported: '兼容导入',
};

const REASON_LABELS: Record<string, string> = {
  platform_infrastructure: '已识别的平台基础设施常规信号',
  unknown_learning_recommendation: 'Unknown 学习经人工审核后的规则草稿',
  asset_review_capture_governance: '审核人员从受信资产创建的采集规则',
};

function field(code: string, label: string, value: string | undefined): InfrastructureRuleHumanScopeField | undefined {
  return value ? { code, label, value } : undefined;
}

function scopeFields(rule: InfrastructureRuleRecord): InfrastructureRuleHumanScopeField[] {
  const selector = rule.selector;
  const values = [
    field('node', '节点', selector.nodeId),
    field('cluster', '集群', selector.clusterId),
    field('namespace', '命名空间', selector.namespace),
    field('owner', '工作负载', [selector.ownerKind, selector.ownerName].filter(Boolean).join(' ') || undefined),
    field('service_account', 'ServiceAccount', selector.serviceAccount),
    field('compose_project', 'Compose 项目', selector.composeProject),
    field('service', '服务', selector.serviceName),
    field('container', '容器', selector.containerName),
    field('image', '镜像版本', selector.imageDigest),
    field('systemd', '系统服务', selector.systemdUnit),
    field('root', '受管根目录', selector.configuredRoot),
    ...Object.entries(selector.labels).map(([key, value]) => field(`label:${key}`, `标签 ${key}`, value)),
  ];
  return values.filter((item): item is InfrastructureRuleHumanScopeField => Boolean(item));
}

function scopeLabel(rule: InfrastructureRuleRecord, fields: InfrastructureRuleHumanScopeField[]): string {
  const placement = rule.selector.placement === 'kubernetes'
    ? 'Kubernetes'
    : rule.selector.placement === 'docker'
      ? 'Docker'
      : '主机服务';
  return [placement, ...fields.slice(0, 4).map((item) => item.value)].join(' / ');
}

export function humanIntentAction(rule: InfrastructureRuleRecord): InfrastructureCaptureIntentAction {
  if (rule.captureIntent) return rule.captureIntent.action;
  const actions = [rule.eventPolicies?.default ?? 'drop', ...Object.values(rule.eventPolicies ?? {})];
  if (actions.includes('drop')) return 'drop';
  if (actions.includes('sample')) return 'sample';
  return 'full';
}

export function humanProbePolicies(actions: CaptureProbeActions): InfrastructureRuleHumanProbePolicy[] {
  return (Object.keys(PROBE_LABELS) as CaptureProbeName[]).map((probe) => ({
    probe,
    label: PROBE_LABELS[probe],
    action: actions[probe],
    actionLabel: ACTION_LABELS[actions[probe]],
    protected: probe === 'exec' || probe === 'exit' || probe === 'security',
  }));
}

export interface InfrastructureRuleHumanContext {
  desiredProbeActions: CaptureProbeActions;
  reports: InfrastructureMaterializationReportRecord[];
  revisions: InfrastructureRuleRecord[];
  operations: InfrastructureRuleOperationRecord[];
  now?: number;
}

export function infrastructureRuleHumanSummary(
  rule: InfrastructureRuleRecord,
  context: InfrastructureRuleHumanContext,
): InfrastructureRuleHumanSummary {
  const fields = scopeFields(rule);
  const intentAction = humanIntentAction(rule);
  const reports = context.reports.filter((report) => report.bindings.some((binding) => binding.ruleId === rule.ruleId));
  const bindings = reports.flatMap((report) => report.bindings.filter((binding) => binding.ruleId === rule.ruleId));
  const nodes = new Set(reports.map((report) => report.nodeId));
  const latestReport = [...reports].sort((left, right) => right.reportedAt - left.reportedAt)[0];
  const latestOperation = context.operations
    .filter((operation) => operation.ruleId === rule.ruleId)
    .sort((left, right) => right.requestedAt - left.requestedAt)[0];
  return {
    ruleId: rule.ruleId,
    revision: rule.revision,
    name: rule.name,
    scope: { placement: rule.selector.placement, label: scopeLabel(rule, fields), fields },
    intent: {
      action: intentAction,
      ...INTENT_COPY[intentAction],
      destructive: intentAction === 'drop',
    },
    protectedSignals: humanProbePolicies(context.desiredProbeActions),
    status: {
      stage: rule.lifecycleStage,
      label: STAGE_LABELS[rule.lifecycleStage],
      authority: rule.authority,
      destructiveActive: intentAction === 'drop' && rule.authority === 'authoritative' && rule.lifecycleStage === 'enforced',
    },
    sourceLabel: SOURCE_LABELS[rule.source.type],
    reasonLabel: REASON_LABELS[rule.reasonCode] ?? `规则原因：${rule.reasonCode.replaceAll('_', ' ')}`,
    priority: rule.priority,
    createdBy: rule.createdBy,
    approvedBy: rule.approvedBy,
    createdAt: new Date(rule.createdAt).toISOString(),
    updatedAt: new Date(rule.updatedAt).toISOString(),
    matchedNodes: nodes.size,
    matchedInstances: new Set(bindings.map((binding) => binding.physicalWorkloadId)).size,
    agentConflicts: bindings.filter((binding) => binding.agentKeepConflict === true).length,
    lastControlUpdate: latestReport ? new Date(latestReport.reportedAt).toISOString() : undefined,
    latestOperation: latestOperation ? { ...latestOperation } : undefined,
  };
}

export function infrastructureRuleHumanDetail(
  rule: InfrastructureRuleRecord,
  context: InfrastructureRuleHumanContext,
): InfrastructureRuleHumanDetail {
  const summary = infrastructureRuleHumanSummary(rule, context);
  const reports = context.reports.filter((report) => report.bindings.some((binding) => binding.ruleId === rule.ruleId));
  const bindings = reports.flatMap((report) => report.bindings.filter((binding) => binding.ruleId === rule.ruleId));
  const now = context.now ?? Date.now();
  return {
    ...summary,
    operationHistory: context.operations
      .filter((operation) => operation.ruleId === rule.ruleId)
      .sort((left, right) => right.requestedAt - left.requestedAt)
      .map((operation) => ({ ...operation })),
    revisionHistory: context.revisions
      .filter((revision) => revision.ruleId === rule.ruleId)
      .sort((left, right) => right.revision - left.revision)
      .map((revision) => ({
        revision: revision.revision,
        stage: revision.lifecycleStage,
        authority: revision.authority,
        updatedAt: new Date(revision.updatedAt).toISOString(),
        approvedBy: revision.approvedBy,
      })),
    control: {
      reports: reports.length,
      acceptedBindings: bindings.length,
      activeBindings: bindings.filter((binding) => Date.parse(binding.expiresAt ?? '') > now).length,
      conflicts: reports.reduce((total, report) => total + report.conflicts, 0),
      nodes: [...new Set(reports.map((report) => report.nodeId))].sort(),
      lastReportAt: reports.length
        ? new Date(Math.max(...reports.map((report) => report.reportedAt))).toISOString()
        : undefined,
    },
  };
}
