import { createHash } from 'node:crypto';
import type { CaptureProfile } from './types';
import {
  CaptureProbeActions,
  FILTER_RULE_SCHEMA,
  FilterRuleCondition,
  FilterRuleEffect,
  FilterRuleRecord,
  FilterRuleStage,
} from './filter-rule.types';

const BUILTIN_AT = Date.parse('2026-08-25T00:00:00.000Z');

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonical(item)]));
}

export function filterRuleDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

interface BuiltinInput {
  ruleId: string;
  name: string;
  description: string;
  category: FilterRuleRecord['category'];
  ruleKind: FilterRuleRecord['ruleKind'];
  priority: number;
  matcher: FilterRuleRecord['matcher'];
  effect: FilterRuleEffect;
  stages: FilterRuleStage[];
  sourceRef?: string;
}

function builtin(input: BuiltinInput): FilterRuleRecord {
  const content = {
    schemaVersion: FILTER_RULE_SCHEMA,
    ruleId: input.ruleId,
    revision: 1,
    name: input.name,
    description: input.description,
    category: input.category,
    ruleKind: input.ruleKind,
    source: { type: 'builtin' as const, ref: input.sourceRef ?? input.ruleId, issuer: 'anysentry' },
    owner: 'anysentry-platform',
    management: 'builtin' as const,
    editable: false,
    lifecycleStage: 'enforced' as const,
    authority: 'immutable' as const,
    priority: input.priority,
    matcher: input.matcher,
    effect: input.effect,
    consumerCapabilities: input.stages,
    createdBy: 'anysentry-release',
    approvedBy: 'anysentry-release',
    createdAt: BUILTIN_AT,
    updatedAt: BUILTIN_AT,
    reason: 'software-versioned safety and compatibility rule',
  };
  return { ...content, contentHash: filterRuleDigest(content) };
}

export interface BuiltinRuntimeSignature {
  id: string;
  agentScopeId?: string;
  displayName: string;
  variants: Array<Partial<Record<'commExact' | 'exeBasename' | 'argv0Basename' | 'argvPrefix', string[]>>>;
}

export const BUILTIN_RUNTIME_SIGNATURE_VERSION = 3;
export const BUILTIN_RUNTIME_SIGNATURES: BuiltinRuntimeSignature[] = [
  { id: 'codex', displayName: 'Codex', variants: [{ commExact: ['codex'] }, { argv0Basename: ['codex'] }] },
  { id: 'pi', displayName: 'Pi', variants: [{ commExact: ['pi'] }, { argv0Basename: ['pi'] }] },
  {
    id: 'langchain-service', agentScopeId: 'langchain', displayName: 'LangChain',
    variants: [{
      argvPrefix: [
        'python /opt/anysentry-langchain-service/service.py',
        'python3 /opt/anysentry-langchain-service/service.py',
        '/opt/anysentry-langchain-service/.venv/bin/python /opt/anysentry-langchain-service/service.py',
      ],
    }],
  },
  {
    id: 'a3s-code', agentScopeId: 'a3s code', displayName: 'A3S Code',
    variants: [{ commExact: ['a3s', 'a3s-code', 'a3s code'] }, { argvPrefix: ['a3s code', 'a3s-code'] }],
  },
  {
    id: 'claude-code', agentScopeId: 'Claude Code', displayName: 'Claude Code',
    variants: [{ commExact: ['claude', 'claude-code', 'claude code'] }, { argv0Basename: ['claude', 'claude-code'] }],
  },
  {
    id: 'gemini-cli', displayName: 'Gemini CLI',
    variants: [{ commExact: ['gemini', 'gemini-cli', 'gemini cli'] }, { argv0Basename: ['gemini', 'gemini-cli'] }],
  },
  {
    id: 'kimi-cli', displayName: 'Kimi Code CLI',
    variants: [{ commExact: ['Kimi Code'] }, { argv0Basename: ['kimi', 'kimi-cli'] }],
  },
];

const signatureField = {
  commExact: 'process.comm',
  exeBasename: 'process.exe_basename',
  argv0Basename: 'process.argv0_basename',
  argvPrefix: 'process.argv_prefix',
} as const;

function signatureConditions(signature: BuiltinRuntimeSignature): FilterRuleCondition[] {
  return signature.variants.flatMap((variant) => Object.entries(variant).map(([field, values]) => ({
    field: signatureField[field as keyof typeof signatureField],
    operator: field === 'argvPrefix' ? 'prefix' as const : 'one_of' as const,
    value: values,
  })));
}

export const CAPTURE_PROFILE_ACTIONS: Record<CaptureProfile, CaptureProbeActions> = {
  agent_full: {
    exec: 'full', exit: 'full', tls: 'full', connect: 'full', dns: 'full',
    file_access: 'full', file_delete: 'full', llm: 'full', ssl: 'full', security: 'full', file_read: 'full',
  },
  investigation_full: {
    exec: 'full', exit: 'full', tls: 'full', connect: 'full', dns: 'full',
    file_access: 'full', file_delete: 'full', llm: 'full', ssl: 'full', security: 'full', file_read: 'full',
  },
  probable_investigation: {
    exec: 'full', exit: 'full', tls: 'sample', connect: 'sample', dns: 'sample',
    file_access: 'sample', file_delete: 'sample', llm: 'full', ssl: 'full', security: 'full', file_read: 'full',
  },
  security_full: {
    exec: 'full', exit: 'full', tls: 'sample', connect: 'full', dns: 'sample',
    file_access: 'sample', file_delete: 'full', llm: 'full', ssl: 'not_enabled', security: 'full', file_read: 'not_enabled',
  },
  business_context: {
    exec: 'full', exit: 'full', tls: 'aggregate', connect: 'aggregate', dns: 'aggregate',
    file_access: 'aggregate', file_delete: 'sample', llm: 'aggregate', ssl: 'not_enabled', security: 'full', file_read: 'not_enabled',
  },
  infrastructure_aggregate: {
    exec: 'full', exit: 'full', tls: 'aggregate', connect: 'aggregate', dns: 'aggregate',
    file_access: 'aggregate', file_delete: 'sample', llm: 'aggregate', ssl: 'not_enabled', security: 'full', file_read: 'not_enabled',
  },
  unknown_discovery: {
    exec: 'full', exit: 'full', tls: 'sample', connect: 'sample', dns: 'sample',
    file_access: 'sample', file_delete: 'sample', llm: 'full', ssl: 'not_enabled', security: 'full', file_read: 'not_enabled',
  },
  self_health: {
    exec: 'full', exit: 'full', tls: 'aggregate', connect: 'aggregate', dns: 'aggregate',
    file_access: 'aggregate', file_delete: 'sample', llm: 'aggregate', ssl: 'not_enabled', security: 'full', file_read: 'not_enabled',
  },
};

function identityCondition(value: string | string[]): FilterRuleCondition {
  return {
    field: 'identity.classification',
    operator: Array.isArray(value) ? 'one_of' : 'equals',
    value,
  };
}

function roleCondition(value: string | string[]): FilterRuleCondition {
  return {
    field: 'workload.role',
    operator: Array.isArray(value) ? 'one_of' : 'equals',
    value,
  };
}

function eventCondition(value: string | string[]): FilterRuleCondition {
  return { field: 'event.kind', operator: Array.isArray(value) ? 'one_of' : 'equals', value };
}

function profileRule(
  profile: CaptureProfile,
  name: string,
  condition: FilterRuleCondition,
  priority: number,
): FilterRuleRecord {
  return builtin({
    ruleId: `fr_builtin_capture_${profile}`,
    name,
    description: `选择 ${profile} 并为每个 Probe 生成闭集采集动作。`,
    category: 'capture_profile',
    ruleKind: 'capture_profile',
    priority,
    matcher: { all: [condition], description: condition.field === 'event.kind' ? `事件类型为 ${condition.value}` : `${condition.field} 为 ${condition.value}` },
    effect: { type: 'assign_capture_profile', captureProfile: profile, probeActions: CAPTURE_PROFILE_ACTIONS[profile] },
    stages: ['f0', 'f1', 'f2'],
    sourceRef: `capture-profile:${profile}`,
  });
}

export function builtinFilterRules(): FilterRuleRecord[] {
  const runtimeRules = BUILTIN_RUNTIME_SIGNATURES.map((signature) => builtin({
    ruleId: `fr_builtin_agent_runtime_${signature.id}`,
    name: `${signature.displayName} Runtime Signature`,
    description: '使用精确进程签名发现 Agent Root；单独命中最高只产生 probable_agent。',
    category: 'agent_identity',
    ruleKind: 'runtime_signature',
    priority: 700,
    matcher: {
      any: signatureConditions(signature),
      description: signatureConditions(signature)
        .map((condition) => `${condition.field} ${condition.operator} ${Array.isArray(condition.value) ? condition.value.join(', ') : condition.value}`)
        .join('；'),
    },
    effect: { type: 'emit_identity', classification: 'probable_agent', confidence: 0.85, captureProfile: 'probable_investigation' },
    stages: ['f0', 'f1', 'f2', 'f3'],
    sourceRef: `runtime-signature:${signature.id}:v${BUILTIN_RUNTIME_SIGNATURE_VERSION}`,
  }));

  const nonAgentRuntimeRules = [builtin({
    ruleId: 'fr_builtin_non_agent_runtime_vscode_cpu_sampler',
    name: 'VS Code CPU Sampler Process Family',
    description: '精确识别 VS Code Server cpuUsage.sh 采样器根；负身份按 ProcessKey 父链传播，不按 tr/cut/grep 等通用工具名全局降级。',
    category: 'agent_identity', ruleKind: 'non_agent_runtime_signature', priority: 780,
    matcher: {
      any: [
        { field: 'process.comm', operator: 'one_of', value: ['cpuUsage.sh', 'cpuUsage.s'] },
        { field: 'process.exe_basename', operator: 'one_of', value: ['cpuUsage.sh', 'cpuUsage.s'] },
        { field: 'process.argv0_basename', operator: 'one_of', value: ['cpuUsage.sh', 'cpuUsage.s'] },
      ],
      description: '进程 comm、exe basename 或 argv0 basename 精确等于 cpuUsage.sh（含内核定长截断 cpuUsage.s）',
    },
    effect: { type: 'emit_identity', classification: 'non_agent', confidence: 1, captureProfile: 'business_context' },
    stages: ['f0', 'f1', 'f2', 'f3'],
    sourceRef: 'non-agent-runtime-signature:vscode-cpu-sampler:v1',
  })];

  const deploymentRules = [
    builtin({
      ruleId: 'fr_builtin_kubernetes_agent_label',
      name: 'Kubernetes Agent Workload Label',
      description: 'Kubernetes Inventory 对明确 Agent workload/container 标签建立强身份事实。',
      category: 'agent_identity', ruleKind: 'deployment_binding', priority: 900,
      matcher: {
        all: [{ field: 'workload.placement', operator: 'equals', value: 'kubernetes' }, { field: 'workload.label', key: 'anysentry.io/workload-kind', operator: 'equals', value: 'agent' }],
        description: 'Kubernetes 标签 anysentry.io/workload-kind=agent，且容器绑定无歧义',
      },
      effect: { type: 'emit_identity', classification: 'confirmed_agent', confidence: 1, captureProfile: 'agent_full' },
      stages: ['f0', 'f1', 'f2', 'f3'], sourceRef: 'kubernetes-label:anysentry.io/workload-kind=agent',
    }),
    builtin({
      ruleId: 'fr_builtin_docker_agent_label',
      name: 'Docker Agent Workload Label',
      description: 'Docker Inventory 对明确 Agent container 标签建立强身份事实。',
      category: 'agent_identity', ruleKind: 'deployment_binding', priority: 900,
      matcher: {
        all: [{ field: 'workload.placement', operator: 'equals', value: 'docker' }, { field: 'workload.label', key: 'anysentry.io/workload-kind', operator: 'equals', value: 'agent' }],
        description: 'Docker 标签 anysentry.io/workload-kind=agent',
      },
      effect: { type: 'emit_identity', classification: 'confirmed_agent', confidence: 1, captureProfile: 'agent_full' },
      stages: ['f0', 'f1', 'f2', 'f3'], sourceRef: 'docker-label:anysentry.io/workload-kind=agent',
    }),
    builtin({
      ruleId: 'fr_builtin_non_agent_workload_label',
      name: 'Explicit Non-Agent Workload Label',
      description: '精确 Inventory 标签可以建立 non-Agent 身份事实，但不能绕过安全 Guardrail。',
      category: 'agent_identity', ruleKind: 'deployment_binding', priority: 820,
      matcher: {
        all: [{ field: 'workload.label', key: 'anysentry.io/workload-kind', operator: 'one_of', value: ['non-agent', 'non_agent', 'infrastructure'] }],
        description: 'anysentry.io/workload-kind 明确标记 non-Agent 或 Infrastructure',
      },
      effect: { type: 'emit_identity', classification: 'non_agent', confidence: 1 },
      stages: ['f0', 'f1', 'f2', 'f3'], sourceRef: 'inventory-label:non-agent',
    }),
    ...([
      ['anysentry_internal', 'self_health'],
      ['platform_infrastructure', 'infrastructure_aggregate'],
      ['business_service', 'business_context'],
      ['ordinary_process', 'business_context'],
      ['agent', 'agent_full'],
    ] as const).map(([role, captureProfile]) => builtin({
      ruleId: `fr_builtin_workload_role_${role}`,
      name: `Workload Role: ${role}`,
      description: '工作负载角色与 Agent 身份独立，用于选择服务上下文采集档位。',
      category: 'infrastructure', ruleKind: 'workload_role_binding', priority: 760,
      matcher: {
        all: [{ field: 'workload.label', key: 'anysentry.io/workload-role', operator: 'equals', value: role }],
        description: `标签 anysentry.io/workload-role=${role}`,
      },
      effect: { type: 'assign_role', role, captureProfile },
      stages: ['f0', 'f1', 'f2', 'f3'], sourceRef: `inventory-label:workload-role=${role}`,
    })),
    builtin({
      ruleId: 'fr_builtin_authenticated_agent_adapter',
      name: 'Authenticated Agent Adapter',
      description: '认证 Adapter 与服务端 Inventory 绑定成功后产生强 Agent 事实。',
      category: 'agent_identity', ruleKind: 'deployment_binding', priority: 930,
      matcher: { all: [{ field: 'runtime.id', operator: 'equals', value: '__authenticated_adapter__' }], description: 'Source policy=agent_adapter 且服务端 Inventory 绑定成功' },
      effect: { type: 'emit_identity', classification: 'confirmed_agent', confidence: 1, captureProfile: 'agent_full' },
      stages: ['f0', 'f1', 'f2', 'f3'], sourceRef: 'source-policy:agent-adapter',
    }),
    builtin({
      ruleId: 'fr_builtin_behavior_candidate',
      name: 'Behavior Discovery Candidate',
      description: '有界行为发现只能产生临时候选，不得直接成为 authoritative 规则。',
      category: 'agent_identity', ruleKind: 'behavior_candidate', priority: 620,
      matcher: { all: [{ field: 'runtime.id', operator: 'equals', value: '__behavior_candidate__' }], description: '稳定工作负载内出现闭集 Agent 行为特征且未被 Inventory 排除' },
      effect: { type: 'emit_identity', classification: 'probable_agent', confidence: 0.7, captureProfile: 'probable_investigation' },
      stages: ['f0', 'f1', 'f2', 'f3'], sourceRef: 'behavior-discovery:v1',
    }),
  ];

  const profileRules = [
    profileRule('agent_full', 'Confirmed Agent Full Capture', identityCondition('confirmed_agent'), 920),
    profileRule('probable_investigation', 'Probable Agent Investigation', identityCondition('probable_agent'), 720),
    profileRule('security_full', 'Security Event Full Evidence', eventCondition('SecurityAction'), 1000),
    profileRule('investigation_full', 'Explicit Investigation Override', { field: 'runtime.id', operator: 'equals', value: '__investigation__' }, 950),
    profileRule('business_context', 'Business Service Context', roleCondition(['business_service', 'ordinary_process']), 560),
    profileRule('infrastructure_aggregate', 'Infrastructure Aggregate', roleCondition('platform_infrastructure'), 600),
    profileRule('unknown_discovery', 'Unknown Discovery', identityCondition('unknown'), 400),
    profileRule('self_health', 'AnySentry Self Health', roleCondition('anysentry_internal'), 650),
  ];

  const signalEnablementRules = [
    builtin({
      ruleId: 'fr_guardrail_agent_file_read_enable',
      name: 'Agent File Read Evidence Enablement',
      description: '仅为具有精确 Runtime/Root 绑定的候选或确认 Agent 启用只读打开证据；stale、map miss 和共享范围不扩大。',
      category: 'capture_profile',
      ruleKind: 'signal_enablement',
      priority: 925,
      matcher: {
        all: [
          identityCondition(['confirmed_agent', 'probable_agent']),
          { field: 'binding.quality', operator: 'equals', value: 'exact' },
          { field: 'runtime.state', operator: 'one_of', value: ['starting', 'current', 'idle'] },
          { field: 'signal.name', operator: 'equals', value: 'file_open_read' },
        ],
        description: '候选或确认 Agent，且事件能够精确绑定当前 Runtime/Root',
      },
      effect: {
        type: 'enable_signal',
        signal: 'file_open_read',
        captureAction: 'full',
        scopeMode: 'exact_runtime_or_root',
        reasonCode: 'agent_file_read_enabled',
      },
      stages: ['f0', 'f1', 'f2', 'f3'],
      sourceRef: 'capture-signal:file_open_read:v1',
    }),
  ];

  const forwarderRules = [
    builtin({
      ruleId: 'fr_builtin_f2_agent_keep', name: 'F2 Agent Evidence Keep',
      description: 'confirmed/probable Agent 的语义事件在 Forwarder 保留。',
      category: 'forwarder_retention', ruleKind: 'semantic_retention', priority: 900,
      matcher: { all: [identityCondition(['confirmed_agent', 'probable_agent'])], description: '身份为 confirmed_agent 或 probable_agent' },
      effect: { type: 'semantic_retention', action: 'keep', reasonCode: 'agent_evidence_keep' }, stages: ['f2'],
    }),
    builtin({
      ruleId: 'fr_builtin_f2_unknown_keep', name: 'F2 Unknown Discovery Keep',
      description: 'Unknown 默认保留，以继续发现和学习。',
      category: 'forwarder_retention', ruleKind: 'semantic_retention', priority: 500,
      matcher: { all: [identityCondition('unknown')], description: '身份为 unknown' },
      effect: { type: 'semantic_retention', action: 'keep', reasonCode: 'unknown_discovery_keep' }, stages: ['f2'],
    }),
    builtin({
      ruleId: 'fr_builtin_f2_non_agent_suppress', name: 'F2 Non-Agent Routine Suppression',
      description: '已确认 non-Agent 的普通明细在 Forwarder 抑制，受保护事件除外。',
      category: 'forwarder_retention', ruleKind: 'semantic_retention', priority: 700,
      matcher: { all: [identityCondition('non_agent')], description: '身份为 non_agent 且不是受保护事件' },
      effect: { type: 'semantic_retention', action: 'suppress', reasonCode: 'non_agent' }, stages: ['f2'],
    }),
    builtin({
      ruleId: 'fr_builtin_f2_infrastructure_aggregate', name: 'F2 Infrastructure Coalescing',
      description: 'Infrastructure 重复文件/网络信号优先聚合，避免逐条转发。',
      category: 'forwarder_retention', ruleKind: 'semantic_retention', priority: 680,
      matcher: { all: [roleCondition(['platform_infrastructure', 'anysentry_internal'])], description: '角色为 Infrastructure 或 AnySentry Self' },
      effect: { type: 'semantic_retention', action: 'aggregate', reasonCode: 'infrastructure_aggregate' }, stages: ['f2'],
    }),
    builtin({
      ruleId: 'fr_builtin_f2_trusted_infrastructure_lifecycle_suppress',
      name: 'F2 Trusted Infrastructure Lifecycle Suppression',
      description: '仅对同时具备可信 non-Agent 身份和 Infrastructure/Self 角色的 Exec/Exit 抑制逐条转发；Agent、Unknown、冲突和 stale 控制状态仍由更高优先级 Guardrail 放行。',
      category: 'forwarder_retention', ruleKind: 'semantic_retention', priority: 1150,
      matcher: {
        all: [
          identityCondition('non_agent'),
          roleCondition(['platform_infrastructure', 'anysentry_internal']),
          eventCondition(['ToolExec', 'ProcessExit']),
        ],
        description: '可信 non_agent 且工作负载角色为 platform_infrastructure/anysentry_internal 的 ToolExec 或 ProcessExit',
      },
      effect: { type: 'semantic_retention', action: 'suppress', reasonCode: 'non_agent' },
      stages: ['f2'],
      sourceRef: 'trusted-infrastructure-lifecycle:v1',
    }),
    builtin({
      ruleId: 'fr_builtin_f2_trusted_non_agent_family_lifecycle_suppress',
      name: 'F2 Trusted Non-Agent Family Lifecycle Suppression',
      description: '对不可编辑的可信 Non-Agent 进程族及其 ProcessKey 后代抑制逐条 Exec/Exit；规则来源必须精确匹配，通用工具名不会单独触发。',
      category: 'forwarder_retention', ruleKind: 'semantic_retention', priority: 1150,
      matcher: {
        all: [
          identityCondition('non_agent'),
          { field: 'identity.source_rule', operator: 'equals', value: 'fr_builtin_non_agent_runtime_vscode_cpu_sampler' },
          eventCondition(['ToolExec', 'ProcessExit']),
        ],
        description: 'non_agent 身份来自可信 VS Code CPU sampler 进程族规则，且事件为 ToolExec/ProcessExit',
      },
      effect: { type: 'semantic_retention', action: 'suppress', reasonCode: 'non_agent' },
      stages: ['f2'],
      sourceRef: 'trusted-non-agent-family-lifecycle:v1',
    }),
    builtin({
      ruleId: 'fr_builtin_f2_priority_control', name: 'F2 Protected Priority Lane',
      description: '控制面、生命周期、安全和 Agent 证据进入受保护优先队列。',
      category: 'forwarder_retention', ruleKind: 'semantic_retention', priority: 1000,
      matcher: { any: [eventCondition(['CollectorHeartbeat', 'RuntimeSnapshot', 'ContainerLifecycle', 'PodLifecycle', 'SecurityAction', 'ToolExec', 'ProcessExit'])], description: '控制面、安全或结构化生命周期事件' },
      effect: { type: 'semantic_retention', action: 'priority', reasonCode: 'protected_priority_lane' }, stages: ['f2'],
    }),
  ];

  const apiRules = [
    builtin({
      ruleId: 'fr_builtin_f3_confirmed_agent_full', name: 'F3 Confirmed Agent Full',
      description: 'confirmed Agent 完整入库并允许进入当前可用最高研判层。',
      category: 'api_retention', ruleKind: 'persistence_retention', priority: 900,
      matcher: { all: [identityCondition('confirmed_agent')], description: '身份为 confirmed_agent' },
      effect: { type: 'persistence_retention', action: 'retain_full', reasonCode: 'confirmed_agent_full' }, stages: ['f3'],
    }),
    builtin({
      ruleId: 'fr_builtin_f3_probable_agent_full', name: 'F3 Probable Agent Full',
      description: '当前批准策略下 probable Agent 完整入库；采集精度仍由 probable profile 有界控制。',
      category: 'api_retention', ruleKind: 'persistence_retention', priority: 800,
      matcher: { all: [identityCondition('probable_agent')], description: '身份为 probable_agent' },
      effect: { type: 'persistence_retention', action: 'retain_full', reasonCode: 'candidate_agent_full' }, stages: ['f3'],
    }),
    builtin({
      ruleId: 'fr_builtin_f3_unknown_l1', name: 'F3 Unknown L1 Only',
      description: 'Unknown 保留最小事实并只进入 L1，避免直接放大模型成本。',
      category: 'api_retention', ruleKind: 'persistence_retention', priority: 500,
      matcher: { all: [identityCondition('unknown')], description: '身份为 unknown' },
      effect: { type: 'persistence_retention', action: 'retain_l1_only', reasonCode: 'unknown_l1_only' }, stages: ['f3'],
    }),
    builtin({
      ruleId: 'fr_builtin_f3_non_agent_structural', name: 'F3 Non-Agent Process Structure',
      description: 'non-Agent Exec/Exit 先写入最小 Process generation/tombstone，再省略大原始事件。',
      category: 'api_retention', ruleKind: 'persistence_retention', priority: 850,
      matcher: { all: [identityCondition('non_agent'), eventCondition(['ToolExec', 'ProcessExit'])], description: 'non_agent 的 ToolExec 或 ProcessExit' },
      effect: { type: 'persistence_retention', action: 'structural_consume', reasonCode: 'non_agent_structural_consumed' }, stages: ['f3'],
    }),
    builtin({
      ruleId: 'fr_builtin_f3_non_agent_discard', name: 'F3 Non-Agent Routine Discard',
      description: '已确认 non-Agent 的普通原始事件不进入事件主表，安全和结构化规则优先。',
      category: 'api_retention', ruleKind: 'persistence_retention', priority: 700,
      matcher: { all: [identityCondition('non_agent')], description: '身份为 non_agent 且无更高优先级保护' },
      effect: { type: 'persistence_retention', action: 'discard', reasonCode: 'non_agent_discarded' }, stages: ['f3'],
    }),
  ];

  const guardrails = [
    builtin({
      ruleId: 'fr_guardrail_security_full', name: 'Security Evidence Always Full',
      description: 'SecurityAction 在任何身份下完整采集、优先转发并完整入库。',
      category: 'safety_guardrail', ruleKind: 'safety_guardrail', priority: 1200,
      matcher: { all: [eventCondition('SecurityAction')], description: '事件类型为 SecurityAction' },
      effect: { type: 'protect', captureAction: 'full', forwarderAction: 'priority', persistenceAction: 'retain_full', reasonCode: 'security_evidence_full' },
      stages: ['f1', 'f2', 'f3'],
    }),
    builtin({
      ruleId: 'fr_guardrail_agent_conflict_keep', name: 'Agent Conflict Fail-Open',
      description: 'Agent/Infrastructure 或身份冲突时选择 Agent FULL/KEEP，不执行 destructive。',
      category: 'safety_guardrail', ruleKind: 'safety_guardrail', priority: 1190,
      matcher: { all: [{ field: 'decision.conflict', operator: 'equals', value: true }], description: '存在身份或工作负载冲突' },
      effect: { type: 'protect', captureAction: 'full', forwarderAction: 'keep', persistenceAction: 'retain_full', reasonCode: 'conflict_keep_preferred' },
      stages: ['f1', 'f2', 'f3'],
    }),
    builtin({
      ruleId: 'fr_guardrail_structural_risk_full', name: 'Risky Process Structure Full Evidence',
      description: 'non-Agent Exec 的本地 L1 判断非 allow 时保留原始命令并进入完整研判。',
      category: 'safety_guardrail', ruleKind: 'safety_guardrail', priority: 1195,
      matcher: { all: [{ field: 'decision.structural_risk', operator: 'equals', value: true }], description: '结构化 Exec 的本地 L1 结果需要完整研判' },
      effect: { type: 'protect', captureAction: 'full', forwarderAction: 'priority', persistenceAction: 'retain_full', reasonCode: 'non_agent_structural_risk_full' },
      stages: ['f3'],
    }),
    builtin({
      ruleId: 'fr_guardrail_control_stale', name: 'Stale Control Fail-Open',
      description: '策略过期、版本不一致、未 ACK 或未 grant 时回退到 discovery-safe。',
      category: 'safety_guardrail', ruleKind: 'safety_guardrail', priority: 1180,
      matcher: { all: [{ field: 'control.stale', operator: 'equals', value: true }], description: '控制面 stale、版本漂移或授权不完整' },
      effect: { type: 'protect', captureAction: 'full', forwarderAction: 'keep', persistenceAction: 'retain_full', reasonCode: 'control_fail_open' },
      stages: ['f1', 'f2', 'f3'],
    }),
    builtin({
      ruleId: 'fr_guardrail_lifecycle_structure', name: 'Process Lifecycle Structure',
      description: 'Exec/Exit 不因普通身份规则丢失；non-Agent 可在 API 结构化消费。',
      category: 'safety_guardrail', ruleKind: 'safety_guardrail', priority: 1100,
      matcher: { all: [eventCondition(['ToolExec', 'ProcessExit'])], description: '事件类型为 ToolExec 或 ProcessExit' },
      effect: { type: 'protect', captureAction: 'structural', forwarderAction: 'priority', persistenceAction: 'structural_consume', reasonCode: 'process_lifecycle_protected' },
      stages: ['f1', 'f2'],
    }),
  ];

  return [...runtimeRules, ...nonAgentRuntimeRules, ...deploymentRules, ...profileRules, ...signalEnablementRules, ...forwarderRules, ...apiRules, ...guardrails];
}
