import { useRequest } from "ahooks";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  BarChart3,
  BellRing,
  Bot,
  CalendarClock,
  CheckCircle2,
  GitBranch,
  KeyRound,
  LayoutDashboard,
  LoaderCircle,
  type LucideIcon,
  Plus,
  Radar,
  Save,
  Search,
  ServerCog,
  ShieldCheck,
  ShieldAlert,
  Siren,
  SlidersHorizontal,
  Sparkles,
  TerminalSquare,
  Trash2,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { AdminTokenControl } from "@/components/custom/admin-token-control";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  type L1Rule,
  type L2Config,
  type DeepModelConfig,
  type L3Config,
  type ModelConnectionProfile,
  type ModelConnectionStatus,
  type PolicyConfig,
  type PolicyConfigResponse,
  type PolicyConnectivityResult,
  type PolicySimulationDiff,
  type PolicySimulationResult,
  type PolicyStatus,
  type RuleAction,
  type RuleKind,
  securityCenterApi,
  type SecuritySeverity,
  type SecurityTimeType,
  type SecurityVerdict,
  type SupplyChainControlConfig,
  type SupplyChainControlResponse,
} from "@/lib/api/security-center";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

// ── Option tables (labels are zh-CN to match the dashboard) ──────────────────
const RULE_KIND_OPTIONS: Array<{ value: RuleKind; label: string }> = [
  { value: "ToolExec", label: "工具执行 (ToolExec)" },
  { value: "Egress", label: "网络外联 (Egress)" },
  { value: "Dns", label: "DNS 解析 (Dns)" },
  { value: "FileAccess", label: "文件访问 (FileAccess)" },
  { value: "SslContent", label: "SSL 内容 (SslContent)" },
  { value: "SecurityAction", label: "安全动作 (SecurityAction)" },
];

const VERDICT_OPTIONS: Array<{ value: SecurityVerdict; label: string }> = [
  { value: "allow", label: "放行 (allow)" },
  { value: "block", label: "阻断 (block)" },
  { value: "escalate", label: "升级研判 (escalate)" },
];

const SEVERITY_OPTIONS: Array<{ value: SecuritySeverity; label: string }> = [
  { value: "info", label: "提示 (info)" },
  { value: "low", label: "低 (low)" },
  { value: "medium", label: "中 (medium)" },
  { value: "high", label: "高 (high)" },
  { value: "critical", label: "严重 (critical)" },
];

// A blank action ("") means the verdict alone governs (no kernel enforcement hook).
const ACTION_OPTIONS: Array<{ value: RuleAction; label: string }> = [
  { value: "", label: "无 (仅按 verdict)" },
  { value: "deny-exec", label: "拒绝执行 (deny-exec)" },
  { value: "deny-egress", label: "拒绝外联 (deny-egress)" },
  { value: "deny-file", label: "拒绝文件 (deny-file)" },
];

const SPECULATE_OPTIONS: Array<{ value: PolicyConfig["speculate"]; label: string }> = [
  { value: "off", label: "关闭 (off)" },
  { value: "low", label: "低 (low)" },
  { value: "medium", label: "中 (medium)" },
  { value: "high", label: "高 (high)" },
];

const TIME_OPTIONS: Array<{ value: SecurityTimeType; label: string }> = [
  { value: "last_30m", label: "近30分钟" },
  { value: "last_1h", label: "近1小时" },
  { value: "last_2h", label: "近2小时" },
  { value: "last_3h", label: "近3小时" },
  { value: "last_1d", label: "近一天" },
  { value: "last_7d", label: "近一周" },
  { value: "last_30d", label: "近一月" },
];

const SEVERITY_LABEL: Record<SecuritySeverity, string> = {
  info: "提示",
  low: "低",
  medium: "中",
  high: "高",
  critical: "严重",
};

const CHANGE_LABEL: Record<PolicySimulationDiff["changeType"], string> = {
  new_block: "新增阻断",
  removed_block: "移除阻断",
  new_escalation: "新增升级",
  removed_escalation: "移除升级",
  severity_increase: "等级升高",
  severity_decrease: "等级降低",
  verdict_changed: "判定变化",
};

const NEW_RULE: L1Rule = {
  name: "",
  on: "ToolExec",
  match: "",
  verdict: "escalate",
  severity: "medium",
  reason: "",
  action: "",
};

const DEFAULT_L2: L2Config = { url: "", model: "", timeoutS: 20 };
const DEFAULT_DEEP_MODEL: DeepModelConfig = { url: "", model: "", timeoutS: 90, contextTokens: 32768 };
const DEFAULT_L3: L3Config = { bin: "/opt/anysentry/l3-agent.mjs", skills: "/opt/anysentry/skills" };

interface ConnectivityViewState {
  loading: boolean;
  applying: boolean;
  result: PolicyConnectivityResult | null;
}

const EMPTY_CONNECTIVITY: Record<ModelConnectionProfile, ConnectivityViewState> = {
  fast_review: { loading: false, applying: false, result: null },
  deep_investigation: { loading: false, applying: false, result: null },
};

const MONITORING_NAV_ITEMS = [
  { view: "overview", label: "运行总览", description: "平台健康与实时状态", icon: Activity },
  { view: "scan", label: "实时扫描", description: "可解释扫描与研判漏斗", icon: Radar },
  { view: "risk", label: "风险态势", description: "风险分类与趋势分布", icon: Siren },
  { view: "stream", label: "复合研判", description: "Flink 连续行为关联", icon: Sparkles },
] as const;

const PLATFORM_NAV_ITEMS = [
  { view: "events", label: "运行链路", description: "无侵入事件时间线", icon: GitBranch },
  { view: "workspace", label: "会话与工作区", description: "Agent 与 Workspace 风险", icon: TerminalSquare },
] as const;

function formatRequestError(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message?: unknown }).message ?? "请求失败");
  }
  return "请求失败";
}

// ── Small layout primitives (mirror the dashboard's Panel/Field styling) ─────
function Panel({
  title,
  icon: Icon,
  description,
  action,
  children,
}: {
  title: string;
  icon: LucideIcon;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-[8px] border border-white/10 bg-[#111612]/92">
      <div className="flex min-h-12 items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-white/10 bg-white/5 text-teal-200">
            <Icon className="size-4" />
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-zinc-100">{title}</h2>
            {description ? <p className="mt-0.5 truncate text-xs text-zinc-500">{description}</p> : null}
          </div>
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-zinc-400">{label}</span>
      {children}
      {hint ? <span className="text-[11px] text-zinc-600">{hint}</span> : null}
    </label>
  );
}

function IdentityJudgmentSection({
  value,
}: {
  value: PolicyConfig["identity"];
}) {
  return (
    <Panel title="身份研判路由" icon={Bot} description="身份保留、页面可见性与风险研判层级相互独立。">
      <div className="grid gap-4 p-4 lg:grid-cols-3">
        <div className="rounded-md border border-emerald-400/20 bg-emerald-400/5 p-3">
          <p className="text-sm font-medium text-emerald-100">已确认 Agent</p>
          <p className="mt-1 text-xs text-zinc-500">固定使用完整分级链路；只有上一层升级时才进入已配置的 L2/L3。</p>
        </div>
        <div className="rounded-md border border-amber-400/20 bg-amber-400/5 p-3">
          <p className="text-sm font-medium text-amber-100">候选 Agent</p>
          <p className="mt-1 text-xs leading-5 text-zinc-500">F3 保留路由已迁入统一过滤规则系统；这里保留兼容值 {value.candidatePipeline}，不再作为权威写入口。</p>
          <Link to="/filter-rules?view=category&category=api_retention" className="mt-3 inline-flex min-h-11 items-center text-xs font-semibold text-amber-200 underline decoration-amber-400/40 underline-offset-4">打开 API Retention 规则</Link>
        </div>
        <div className="rounded-md border border-zinc-400/20 bg-white/[0.03] p-3">
          <p className="text-sm font-medium text-zinc-200">尚未识别</p>
          <p className="mt-1 text-xs text-zinc-500">固定仅执行 L1；升级和高风险证据保留，但不调用 L2/L3。</p>
        </div>
      </div>
    </Panel>
  );
}

// A label + switch row. Reusable for tier-enable toggles and the global switch.
function ToggleRow({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  description?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm font-medium text-zinc-100">{label}</p>
        {description ? <p className="mt-0.5 text-xs text-zinc-500">{description}</p> : null}
      </div>
      <Switch checked={checked} onChange={onChange} />
    </div>
  );
}

// Minimal accessible switch — no extra dependency, matches the dark theme.
function Switch({
  checked,
  onChange,
  disabled = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-teal-300/50",
        checked ? "border-teal-400/40 bg-teal-500/80" : "border-white/15 bg-white/10",
        disabled && "cursor-not-allowed opacity-40",
      )}
    >
      <span
        className={cn(
          "inline-block size-3.5 rounded-full bg-white shadow-sm transition-transform",
          checked ? "translate-x-[18px]" : "translate-x-[3px]",
        )}
      />
    </button>
  );
}

function SelectField<T extends string>({
  value,
  onChange,
  options,
  className,
}: {
  value: T;
  onChange: (next: T) => void;
  options: Array<{ value: T; label: string }>;
  className?: string;
}) {
  // Radix Select forbids empty-string item values, so encode "" as a sentinel
  // on the way in and decode it back to "" on change.
  const NONE = "__none__";
  return (
    <Select value={value || NONE} onValueChange={(next) => onChange((next === NONE ? "" : next) as T)}>
      <SelectTrigger className={cn("h-8 border-white/10 bg-white/5 text-xs text-zinc-100", className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value || NONE} value={option.value || NONE}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function Toast({ kind, message, onClose }: { kind: "success" | "error"; message: string; onClose: () => void }) {
  const success = kind === "success";
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-md border px-3 py-2 text-xs",
        success ? "border-teal-400/30 bg-teal-500/10 text-teal-100" : "border-rose-400/25 bg-rose-500/10 text-rose-100",
      )}
    >
      {success ? (
        <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" />
      ) : (
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
      )}
      <span className="min-w-0 flex-1">{message}</span>
      <button type="button" onClick={onClose} className="shrink-0 text-current/70 hover:text-current">
        <X className="size-3.5" />
      </button>
    </div>
  );
}

function toneBySeverity(severity?: SecuritySeverity) {
  if (severity === "critical" || severity === "high") return "border-rose-400/30 bg-rose-500/10 text-rose-100";
  if (severity === "medium") return "border-amber-400/30 bg-amber-500/10 text-amber-100";
  if (severity === "low") return "border-teal-400/30 bg-teal-500/10 text-teal-100";
  return "border-white/10 bg-white/5 text-zinc-300";
}

function changeTone(change: PolicySimulationDiff["changeType"]) {
  if (change === "new_block" || change === "severity_increase") return "border-rose-400/30 bg-rose-500/10 text-rose-100";
  if (change === "removed_block" || change === "severity_decrease") return "border-teal-400/30 bg-teal-500/10 text-teal-100";
  if (change === "new_escalation") return "border-amber-400/30 bg-amber-500/10 text-amber-100";
  return "border-white/10 bg-white/5 text-zinc-300";
}

function Pill({ children, className }: { children: string; className?: string }) {
  return (
    <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold", className)}>
      {children}
    </span>
  );
}

function MetricTile({ label, value, tone }: { label: string; value: number | string; tone: string }) {
  return (
    <div className={cn("rounded-[8px] border px-3 py-2", tone)}>
      <p className="text-[11px] opacity-80">{label}</p>
      <p className="mt-1 truncate font-mono text-xl font-semibold">{value}</p>
    </div>
  );
}

// ── L1 rules editor ──────────────────────────────────────────────────────────
function RuleRow({
  rule,
  onChange,
  onRemove,
}: {
  rule: L1Rule;
  onChange: (next: L1Rule) => void;
  onRemove: () => void;
}) {
  const matchInvalid = useMemo(() => {
    if (!rule.match) return false;
    try {
      // The match field is a regex; surface obviously invalid patterns client-side.
      new RegExp(rule.match);
      return false;
    } catch {
      return true;
    }
  }, [rule.match]);

  return (
    <div className="space-y-3 rounded-md border border-white/10 bg-white/[0.03] p-3">
      <div className="flex items-center gap-3">
        <Input
          value={rule.name}
          onChange={(event) => onChange({ ...rule, name: event.target.value })}
          placeholder="规则名称"
          className="h-8 flex-1 border-white/10 bg-white/5 text-xs"
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onRemove}
          aria-label="删除规则"
          className="shrink-0 text-zinc-500 hover:bg-rose-500/10 hover:text-rose-200"
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="触发对象 (on)">
          <SelectField
            value={rule.on}
            onChange={(next) => onChange({ ...rule, on: next })}
            options={RULE_KIND_OPTIONS}
          />
        </Field>
        <Field label="判定 (verdict)">
          <SelectField
            value={rule.verdict}
            onChange={(next) => onChange({ ...rule, verdict: next })}
            options={VERDICT_OPTIONS}
          />
        </Field>
        <Field label="严重度 (severity)">
          <SelectField
            value={rule.severity}
            onChange={(next) => onChange({ ...rule, severity: next })}
            options={SEVERITY_OPTIONS}
          />
        </Field>
        <Field label="处置动作 (action)">
          <SelectField
            value={rule.action ?? ""}
            onChange={(next) => onChange({ ...rule, action: next })}
            options={ACTION_OPTIONS}
          />
        </Field>
      </div>
      <Field label="匹配正则 (match)" hint={matchInvalid ? undefined : "应用于所选触发对象的正则表达式"}>
        <Input
          value={rule.match}
          onChange={(event) => onChange({ ...rule, match: event.target.value })}
          placeholder="例如 ^rm\\s+-rf"
          className={cn(
            "h-8 border-white/10 bg-white/5 font-mono text-xs",
            matchInvalid && "border-rose-400/40 focus-visible:border-rose-400",
          )}
        />
      </Field>
      {matchInvalid ? <p className="text-[11px] text-rose-300">正则表达式无效</p> : null}
      <Field label="原因 (reason)">
        <Input
          value={rule.reason}
          onChange={(event) => onChange({ ...rule, reason: event.target.value })}
          placeholder="命中时记录的原因说明"
          className="h-8 border-white/10 bg-white/5 text-xs"
        />
      </Field>
    </div>
  );
}

function L1RulesSection({ rules, onChange }: { rules: L1Rule[]; onChange: (next: L1Rule[]) => void }) {
  const updateRule = (index: number, next: L1Rule) => {
    onChange(rules.map((rule, idx) => (idx === index ? next : rule)));
  };
  const removeRule = (index: number) => {
    onChange(rules.filter((_, idx) => idx !== index));
  };

  return (
    <Panel
      title="L1 规则"
      icon={ShieldCheck}
      description="自定义规则在内置防护之上叠加 — 你只会新增规则,不会丢失内置防护。"
      action={
        <Button
          type="button"
          size="sm"
          onClick={() => onChange([...rules, { ...NEW_RULE }])}
          className="h-8 bg-teal-500 text-[#07100c] hover:bg-teal-400"
        >
          <Plus className="size-3.5" />
          新增规则
        </Button>
      }
    >
      <div className="space-y-3 p-4">
        {rules.length === 0 ? (
          <div className="rounded-md border border-dashed border-white/10 px-3 py-8 text-center text-xs text-zinc-500">
            尚无自定义规则 — 内置防护仍然生效。点击「新增规则」添加叠加规则。
          </div>
        ) : (
          rules.map((rule, index) => (
            <RuleRow
              // Index-keyed: rules are an ordered editable list without stable ids.
              key={index}
              rule={rule}
              onChange={(next) => updateRule(index, next)}
              onRemove={() => removeRule(index)}
            />
          ))
        )}
      </div>
    </Panel>
  );
}

// ── Model connections ───────────────────────────────────────────────────────
function ConnectionControl({
  profile,
  state,
  active,
  apiKey,
  onApiKeyChange,
  onTest,
  onApply,
  onClear,
}: {
  profile: ModelConnectionProfile;
  state: ConnectivityViewState;
  active?: ModelConnectionStatus;
  apiKey: string;
  onApiKeyChange: (next: string) => void;
  onTest: (profile: ModelConnectionProfile) => void;
  onApply: (profile: ModelConnectionProfile) => void;
  onClear: (profile: ModelConnectionProfile) => void;
}) {
  const result = state.result;
  const configured = active?.state === "active";
  const connected = configured && active.callable;
  const tone = result && !result.ok
    ? "border-rose-400/25 bg-rose-500/10 text-rose-100"
    : connected || result?.ok
      ? "border-teal-400/25 bg-teal-500/10 text-teal-100"
      : "border-white/10 bg-white/[0.03] text-zinc-400";
  return (
    <div className="space-y-3 rounded-md border border-white/10 bg-black/10 p-3">
      <Field label="API Key" hint="仅用于本次测试与当前服务运行；不写入策略、数据库、日志或浏览器存储。服务重启后需重新配置。">
        <Input
          type="password"
          autoComplete="new-password"
          value={apiKey}
          onChange={(event) => onApiKeyChange(event.target.value)}
          placeholder={configured ? "已配置运行时凭据；输入新 Key 可替换" : "输入 API Key"}
          className="h-8 border-white/10 bg-white/5 font-mono text-xs"
        />
      </Field>
      <div className={cn("flex flex-col gap-3 rounded-md border px-3 py-3 lg:flex-row lg:items-center lg:justify-between", tone)}>
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs font-semibold">
            {state.loading || state.applying ? <LoaderCircle className="size-3.5 animate-spin" />
              : result && !result.ok ? <AlertTriangle className="size-3.5" />
                : connected || result?.ok ? <CheckCircle2 className="size-3.5" /> : <KeyRound className="size-3.5" />}
            <span>{state.loading ? "正在验证连接…" : state.applying ? "正在应用…" : result?.message ?? (connected ? "运行时连接已生效" : configured ? active?.message ?? "模型 API 当前不可用" : "尚未配置运行时凭据")}</span>
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] opacity-75">
            {result ? <><span>{result.model}</span><span>{result.latencyMs} ms</span><span className="break-all">{result.endpoint}</span></>
              : configured ? <><span>{active?.model}</span><span>{active?.source === "environment" ? "部署配置" : "页面配置"}</span><span className="break-all">{active?.endpoint}</span></>
                : <span>请先测试，成功后再应用</span>}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {configured ? <Button type="button" size="sm" variant="ghost" onClick={() => onClear(profile)} className="h-8 text-xs text-zinc-300 hover:bg-white/10">清除凭据</Button> : null}
          <Button type="button" size="sm" variant="secondary" disabled={state.loading || state.applying || !apiKey.trim()} onClick={() => onTest(profile)} className="h-8 border border-white/10 bg-white/5 text-xs text-zinc-100 hover:bg-white/10">
            {state.loading ? <LoaderCircle className="size-3.5 animate-spin" /> : <Zap className="size-3.5" />}测试连接
          </Button>
          {result?.ok && result.testToken ? (
            <Button type="button" size="sm" disabled={state.applying} onClick={() => onApply(profile)} className="h-8 bg-teal-500 text-xs text-[#07100c] hover:bg-teal-400">应用配置</Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

interface ConnectionActions {
  state: ConnectivityViewState;
  active?: ModelConnectionStatus;
  apiKey: string;
  onApiKeyChange: (next: string) => void;
  onTest: (profile: ModelConnectionProfile) => void;
  onApply: (profile: ModelConnectionProfile) => void;
  onClear: (profile: ModelConnectionProfile) => void;
}

function FastReviewSection({ value, onChange, state, ...actions }: { value: L2Config | null; onChange: (next: L2Config | null) => void } & ConnectionActions) {
  const enabled = value !== null;
  const config = value ?? DEFAULT_L2;
  return (
    <Panel title="快速研判模型" icon={Zap} description="用于快速结构化风险研判，并复用于 AI 身份辅助审核的模型连接。两类任务的会话、提示词和权限相互隔离。" action={<Switch checked={enabled} onChange={(next) => onChange(next ? { ...DEFAULT_L2 } : null)} />}>
      {enabled ? <div className="space-y-4 p-4">
        <div className="grid gap-4 md:grid-cols-3">
          <Field label="API 基础 URL" hint="填写到 /v1；完整接口地址会自动规范化。"><Input value={config.url} onChange={(event) => onChange({ ...config, url: event.target.value })} placeholder="https://api.example.com/v1" className="h-8 border-white/10 bg-white/5 font-mono text-xs" /></Field>
          <Field label="模型名称"><Input value={config.model} onChange={(event) => onChange({ ...config, model: event.target.value })} placeholder="model-id" className="h-8 border-white/10 bg-white/5 text-xs" /></Field>
          <Field label="单次超时（秒）"><Input type="number" min={1} max={600} value={config.timeoutS} onChange={(event) => onChange({ ...config, timeoutS: Number(event.target.value) })} className="h-8 border-white/10 bg-white/5 text-xs" /></Field>
        </div>
        <ConnectionControl profile="fast_review" state={state} {...actions} />
      </div> : <div className="px-4 py-5 text-xs text-zinc-500">未启用 — 仅保留基础规则研判，AI 身份辅助审核不可用。</div>}
    </Panel>
  );
}

function DeepReviewSection({ model, agent, onModelChange, onAgentChange, state, ...actions }: { model: DeepModelConfig | null; agent: L3Config | null; onModelChange: (next: DeepModelConfig | null) => void; onAgentChange: (next: L3Config | null) => void } & ConnectionActions) {
  const enabled = model !== null && agent !== null;
  const config = model ?? DEFAULT_DEEP_MODEL;
  const agentConfig = agent ?? DEFAULT_L3;
  const toggle = (next: boolean) => { onModelChange(next ? { ...DEFAULT_DEEP_MODEL } : null); onAgentChange(next ? { ...DEFAULT_L3 } : null); };
  return (
    <Panel title="深度研判模型" icon={Bot} description="仅用于安全智能体的深度调查。它拥有独立连接、上下文预算和受限技能会话，不与快速研判共享凭据。" action={<Switch checked={enabled} onChange={toggle} />}>
      {enabled ? <div className="space-y-4 p-4">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <Field label="API 基础 URL"><Input value={config.url} onChange={(event) => onModelChange({ ...config, url: event.target.value })} placeholder="https://api.example.com/v1" className="h-8 border-white/10 bg-white/5 font-mono text-xs" /></Field>
          <Field label="模型名称"><Input value={config.model} onChange={(event) => onModelChange({ ...config, model: event.target.value })} placeholder="model-id" className="h-8 border-white/10 bg-white/5 text-xs" /></Field>
          <Field label="任务超时（秒）"><Input type="number" min={1} max={600} value={config.timeoutS} onChange={(event) => onModelChange({ ...config, timeoutS: Number(event.target.value) })} className="h-8 border-white/10 bg-white/5 text-xs" /></Field>
          <Field label="上下文上限"><Input type="number" min={4096} max={262144} value={config.contextTokens} onChange={(event) => onModelChange({ ...config, contextTokens: Number(event.target.value) })} className="h-8 border-white/10 bg-white/5 text-xs" /></Field>
          <Field label="安全技能目录" hint="深度调查只能使用该目录中的受限技能。"><Input value={agentConfig.skills} onChange={(event) => onAgentChange({ ...agentConfig, skills: event.target.value })} placeholder="/opt/anysentry/skills" className="h-8 border-white/10 bg-white/5 font-mono text-xs" /></Field>
        </div>
        <ConnectionControl profile="deep_investigation" state={state} {...actions} />
      </div> : <div className="px-4 py-5 text-xs text-zinc-500">未启用 — 风险升级到深度调查时会明确记录“未配置”，不会伪装为完整研判成功。</div>}
    </Panel>
  );
}

function ReadinessPill({ label, ready }: { label: string; ready: boolean }) {
  return (
    <span className={cn(
      "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold",
      ready
        ? "border-teal-400/30 bg-teal-500/10 text-teal-100"
        : "border-amber-400/25 bg-amber-500/10 text-amber-100",
    )}>
      <span className={cn("size-1.5 rounded-full", ready ? "bg-teal-300" : "bg-amber-300")} />
      {label}
    </span>
  );
}

function SupplyChainSection({
  value,
  draft,
  loading,
  saving,
  onChange,
  onSave,
  onScan,
  onDisable,
  onRefresh,
}: {
  value: SupplyChainControlResponse | null;
  draft: SupplyChainControlConfig | null;
  loading: boolean;
  saving: boolean;
  onChange: (next: SupplyChainControlConfig) => void;
  onSave: () => void;
  onScan: () => void;
  onDisable: () => void;
  onRefresh: () => void;
}) {
  const readiness = value?.readiness;
  const workspaces = value?.workspaceOptions ?? [];
  const selected = new Set(draft?.selectedWorkspaceIds ?? []);
  const effectiveSelected = selected.size > 0
    ? selected
    : new Set(workspaces.map((workspace) => workspace.workspaceId));
  const toggleWorkspace = (workspaceId: string) => {
    if (!draft) return;
    const next = new Set(effectiveSelected);
    if (next.has(workspaceId)) {
      if (next.size === 1) return;
      next.delete(workspaceId);
    }
    else next.add(workspaceId);
    onChange({ ...draft, selectedWorkspaceIds: [...next] });
  };

  return (
    <Panel
      title="供应链漏洞"
      icon={ShieldAlert}
      description="OSV 依赖漏洞资产；基础组件常驻空闲，启用后才扫描和刷新情报。"
      action={
        <ReadinessPill
          label={draft?.enabled ? "已启用" : "未启用"}
          ready={Boolean(draft?.enabled && readiness?.serviceReady)}
        />
      }
    >
      {loading && !value ? (
        <div className="flex min-h-28 items-center justify-center text-xs text-zinc-500">
          <LoaderCircle className="mr-2 size-4 animate-spin" />
          检查供应链运行环境…
        </div>
      ) : draft && readiness ? (
        <div className="space-y-5 p-4">
          <div className="flex flex-wrap gap-2">
            <ReadinessPill label="API 与存储" ready={readiness.serviceReady} />
            <ReadinessPill label="Scanner 凭据" ready={readiness.scannerAuthConfigured} />
            <ReadinessPill
              label={`Workspace Scanner ${readiness.scanners.some((scanner) => scanner.online) ? "在线" : "离线"}`}
              ready={readiness.scanners.some((scanner) => scanner.online)}
            />
            <ReadinessPill label="OSV Assessment Worker" ready={readiness.assessmentWorkerOnline} />
            <ReadinessPill label="运行时关联" ready={readiness.runtimeCorrelationAvailable} />
          </div>

          {readiness.issues.length ? (
            <div className="rounded-md border border-amber-400/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
              {readiness.issues.join("；")}
            </div>
          ) : (
            <div className="rounded-md border border-teal-400/25 bg-teal-500/10 px-3 py-2 text-xs text-teal-100">
              运行环境已就绪，可以启用并扫描所选 Workspace。
            </div>
          )}

          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-md border border-white/10 bg-white/[0.03] p-3">
              <ToggleRow
                label="每日刷新 OSV 漏洞情报"
                description="依赖未变化时不重复提取组件，只刷新已保存组件的漏洞情报。"
                checked={draft.dailyRefreshEnabled}
                onChange={(next) => onChange({ ...draft, dailyRefreshEnabled: next })}
              />
            </div>
            <div className="rounded-md border border-white/10 bg-white/[0.03] p-3">
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-zinc-100">运行时漏洞利用关联</p>
                  <p className="mt-0.5 text-xs text-zinc-500">将漏洞快照送入 Flink，与 Agent 运行证据关联。</p>
                </div>
                <Switch
                  checked={draft.runtimeCorrelationEnabled}
                  disabled={!readiness.runtimeCorrelationAvailable}
                  onChange={(next) => onChange({ ...draft, runtimeCorrelationEnabled: next })}
                />
              </div>
            </div>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-zinc-100">扫描 Workspace</p>
                <p className="mt-0.5 text-xs text-zinc-500">只扫描已由可信 Workspace Scanner 注册的本地工作副本。</p>
              </div>
              <span className="text-[11px] text-zinc-500">
                已选 {effectiveSelected.size} / {workspaces.length}
              </span>
            </div>
            {workspaces.length ? (
              <div className="grid gap-2 md:grid-cols-2">
                {workspaces.map((workspace) => {
                  const scanner = readiness.scanners.find((item) => item.scannerId === workspace.scannerId);
                  const checked = effectiveSelected.has(workspace.workspaceId);
                  return (
                    <button
                      key={workspace.workspaceId}
                      type="button"
                      onClick={() => toggleWorkspace(workspace.workspaceId)}
                      className={cn(
                        "flex items-start justify-between gap-3 rounded-md border px-3 py-3 text-left transition-colors",
                        checked
                          ? "border-teal-400/30 bg-teal-500/10"
                          : "border-white/10 bg-white/[0.03] hover:bg-white/[0.06]",
                      )}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-zinc-100">{workspace.displayName}</span>
                        <span className="mt-0.5 block truncate font-mono text-[11px] text-zinc-500">{workspace.workspaceId}</span>
                      </span>
                      <span className={cn(
                        "mt-0.5 shrink-0 text-[11px]",
                        scanner?.online ? "text-teal-300" : "text-amber-300",
                      )}>
                        {scanner?.online ? "Scanner 在线" : "Scanner 离线"}
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="rounded-md border border-dashed border-white/10 px-3 py-6 text-center text-xs text-zinc-500">
                尚无可信 Workspace。请先安装并启动 Workspace Scanner 完成注册。
              </div>
            )}
          </div>

          <div className="flex flex-wrap justify-end gap-2 border-t border-white/10 pt-4">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onRefresh}
              disabled={saving}
              className="h-8 text-zinc-400 hover:bg-white/10 hover:text-zinc-100"
            >
              刷新状态
            </Button>
            {draft.enabled ? (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={onDisable}
                  disabled={saving}
                  className="h-8 text-rose-200 hover:bg-rose-500/10"
                >
                  停用
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={onSave}
                  disabled={saving}
                  className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10"
                >
                  保存设置
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={onScan}
                  disabled={saving || effectiveSelected.size === 0}
                  className="h-8 bg-teal-500 text-[#07100c] hover:bg-teal-400"
                >
                  {saving ? <LoaderCircle className="size-3.5 animate-spin" /> : <Radar className="size-3.5" />}
                  扫描所选 Workspace
                </Button>
              </>
            ) : (
              <Button
                type="button"
                size="sm"
                onClick={onScan}
                disabled={saving || effectiveSelected.size === 0}
                className="h-8 bg-teal-500 text-[#07100c] hover:bg-teal-400"
              >
                {saving ? <LoaderCircle className="size-3.5 animate-spin" /> : <ShieldCheck className="size-3.5" />}
                启用并执行首次扫描
              </Button>
            )}
          </div>
        </div>
      ) : (
        <div className="px-4 py-5 text-xs text-rose-200">供应链配置加载失败，请刷新状态后重试。</div>
      )}
    </Panel>
  );
}

function SimulationDiffRow({ diff }: { diff: PolicySimulationDiff }) {
  const eventQs = new URLSearchParams();
  eventQs.set("eventId", diff.eventId);
  eventQs.set("agentId", diff.agentId);
  eventQs.set("workspacePath", diff.workspacePath);
  return (
    <div className="grid grid-cols-[88px_minmax(0,1fr)_86px_86px_64px] items-center gap-3 border-b border-white/8 px-3 py-3">
      <span className="font-mono text-xs text-zinc-500">{diff.at.slice(5)}</span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-zinc-100" title={diff.subject}>{diff.subject}</span>
        <span className="mt-0.5 block truncate font-mono text-[11px] text-zinc-600" title={`${diff.agentId} / ${diff.workspacePath}`}>
          {diff.agentId} / {diff.eventKind}
        </span>
      </span>
      <span><Pill className={changeTone(diff.changeType)}>{CHANGE_LABEL[diff.changeType]}</Pill></span>
      <span><Pill className={toneBySeverity(diff.simulated.severity)}>{SEVERITY_LABEL[diff.simulated.severity]}</Pill></span>
      <Button asChild variant="ghost" size="icon-sm" className="justify-self-end text-zinc-400 hover:bg-white/10 hover:text-zinc-100">
        <Link to={`/events?${eventQs.toString()}`} aria-label="查看事件">
          <Search className="size-3.5" />
        </Link>
      </Button>
    </div>
  );
}

function SimulationPanel({
  timeType,
  result,
  loading,
  onTimeTypeChange,
  onRun,
}: {
  timeType: SecurityTimeType;
  result: PolicySimulationResult | null;
  loading: boolean;
  onTimeTypeChange: (next: SecurityTimeType) => void;
  onRun: () => void;
}) {
  return (
    <Panel
      title="策略回放"
      icon={BarChart3}
      description="用当前草稿重放历史事件,预估保存后的阻断与升级变化。"
      action={
        <div className="flex items-center gap-2">
          <SelectField value={timeType} onChange={onTimeTypeChange} options={TIME_OPTIONS} className="w-[116px]" />
          <Button
            type="button"
            size="sm"
            onClick={onRun}
            disabled={loading}
            className="h-8 bg-teal-500 text-[#07100c] hover:bg-teal-400"
          >
            {loading ? <LoaderCircle className="size-3.5 animate-spin" /> : <BarChart3 className="size-3.5" />}
            模拟影响
          </Button>
        </div>
      }
    >
      <div className="space-y-4 p-4">
        {result ? (
          <>
            <div className={`rounded-md border px-3 py-2 text-xs ${
              result.sampling.truncated
                ? "border-amber-400/25 bg-amber-500/10 text-amber-100"
                : "border-teal-400/20 bg-teal-500/10 text-teal-100"
            }`}>
              策略回放使用最近事件样本：已取 {result.sampling.sampledEvents} / 上限 {result.sampling.sampleLimit} 条
              {result.sampling.truncated
                ? "。所选时间范围数据更多，结果仅代表该有界样本。"
                : "。当前时间范围未发生样本截断。"}
            </div>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
              <MetricTile label="已评估" value={result.summary.evaluatedEvents} tone="border-white/10 bg-white/[0.03] text-zinc-100" />
              <MetricTile label="变化事件" value={result.summary.changedEvents} tone="border-amber-400/25 bg-amber-500/10 text-amber-100" />
              <MetricTile label="新增阻断" value={result.summary.newBlocks} tone="border-rose-400/25 bg-rose-500/10 text-rose-100" />
              <MetricTile label="移除阻断" value={result.summary.removedBlocks} tone="border-teal-400/25 bg-teal-500/10 text-teal-100" />
              <MetricTile label="影响 Agent" value={result.summary.affectedAgents} tone="border-sky-400/25 bg-sky-500/10 text-sky-100" />
              <MetricTile label="跳过" value={result.summary.skippedEvents} tone="border-white/10 bg-white/5 text-zinc-300" />
            </div>

            <div className="grid gap-4 xl:grid-cols-2">
              <div className="rounded-md border border-white/10 bg-white/[0.03] p-3">
                <div className="mb-2 text-xs font-semibold text-zinc-100">Top Agents</div>
                <div className="space-y-2">
                  {result.byAgent.length ? result.byAgent.slice(0, 6).map((item) => (
                    <div key={item.key} className="grid grid-cols-[minmax(0,1fr)_58px_58px_58px] gap-2 text-xs">
                      <span className="truncate text-zinc-400" title={item.key}>{item.key}</span>
                      <span className="text-right font-mono text-rose-200">{item.newBlocks}</span>
                      <span className="text-right font-mono text-teal-200">{item.removedBlocks}</span>
                      <span className="text-right font-mono text-amber-200">{item.newEscalations}</span>
                    </div>
                  )) : <p className="text-xs text-zinc-500">无影响</p>}
                </div>
              </div>
              <div className="rounded-md border border-white/10 bg-white/[0.03] p-3">
                <div className="mb-2 text-xs font-semibold text-zinc-100">Top Workspaces</div>
                <div className="space-y-2">
                  {result.byWorkspace.length ? result.byWorkspace.slice(0, 6).map((item) => (
                    <div key={item.key} className="grid grid-cols-[minmax(0,1fr)_58px_58px_58px] gap-2 text-xs">
                      <span className="truncate text-zinc-400" title={item.key}>{item.key}</span>
                      <span className="text-right font-mono text-rose-200">{item.newBlocks}</span>
                      <span className="text-right font-mono text-teal-200">{item.removedBlocks}</span>
                      <span className="text-right font-mono text-amber-200">{item.newEscalations}</span>
                    </div>
                  )) : <p className="text-xs text-zinc-500">无影响</p>}
                </div>
              </div>
            </div>

            <div className="overflow-hidden rounded-md border border-white/10 bg-white/[0.03]">
              <div className="flex min-h-10 items-center justify-between gap-3 border-b border-white/10 px-3">
                <h3 className="text-xs font-semibold text-zinc-100">事件差异</h3>
                <span className="text-[11px] text-zinc-500">{result.updateTime}</span>
              </div>
              {result.diffs.length ? (
                <div className="max-h-[360px] overflow-y-auto">
                  {result.diffs.map((diff) => <SimulationDiffRow key={`${diff.eventId}:${diff.changeType}`} diff={diff} />)}
                </div>
              ) : (
                <div className="px-3 py-8 text-center text-xs text-zinc-500">当前窗口内没有策略差异</div>
              )}
            </div>
          </>
        ) : (
          <div className="rounded-md border border-dashed border-white/10 px-3 py-8 text-center text-xs text-zinc-500">
            修改草稿后运行模拟,保存前查看影响面。
          </div>
        )}
      </div>
    </Panel>
  );
}

// ── Tier status strip ────────────────────────────────────────────────────────
function StatusStrip({ status }: { status: PolicyStatus }) {
  const tiers: Array<{ key: keyof PolicyStatus; label: string; icon: LucideIcon }> = [
    { key: "l1", label: "基础规则", icon: ShieldCheck },
    { key: "l2", label: "快速研判", icon: Zap },
    { key: "l3", label: "深度研判", icon: Bot },
  ];
  return (
    <div className="flex flex-wrap items-center gap-2">
      {tiers.map(({ key, label, icon: Icon }) => {
        const on = status[key];
        return (
          <span
            key={key}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold",
              on
                ? "border-teal-400/30 bg-teal-500/10 text-teal-100"
                : "border-white/10 bg-white/5 text-zinc-500",
            )}
          >
            <Icon className="size-3.5" />
            {label}
            <span className={cn("size-1.5 rounded-full", on ? "bg-teal-300" : "bg-zinc-600")} />
          </span>
        );
      })}
    </div>
  );
}

export default function PolicyConfigPage() {
  const { t } = useI18n();
  const [draft, setDraft] = useState<PolicyConfig | null>(null);
  const [status, setStatus] = useState<PolicyStatus | null>(null);
  const [toast, setToast] = useState<{ kind: "success" | "error"; message: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [simulationTimeType, setSimulationTimeType] = useState<SecurityTimeType>("last_3h");
  const [simulation, setSimulation] = useState<PolicySimulationResult | null>(null);
  const [simulating, setSimulating] = useState(false);
  const [supplyChain, setSupplyChain] = useState<SupplyChainControlResponse | null>(null);
  const [supplyDraft, setSupplyDraft] = useState<SupplyChainControlConfig | null>(null);
  const [savingSupplyChain, setSavingSupplyChain] = useState(false);
  const [connectivity, setConnectivity] = useState<Record<ModelConnectionProfile, ConnectivityViewState>>(EMPTY_CONNECTIVITY);
  const [connections, setConnections] = useState<PolicyConfigResponse["connections"] | null>(null);
  const [apiKeys, setApiKeys] = useState<Record<ModelConnectionProfile, string>>({ fast_review: "", deep_investigation: "" });

  const applyResponse = useCallback((response: PolicyConfigResponse) => {
    setDraft(response.policy);
    setStatus(response.status);
    setConnections(response.connections);
  }, []);

  const { loading, error, refresh } = useRequest(() => securityCenterApi.getConfig(), {
    onSuccess: applyResponse,
  });
  const {
    loading: supplyChainLoading,
    refresh: refreshSupplyChain,
  } = useRequest(() => securityCenterApi.supplyChainConfig(), {
    onSuccess: (response) => {
      setSupplyChain(response);
      setSupplyDraft(response.config);
    },
  });

  // Auto-dismiss the toast a few seconds after it appears.
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  const update = useCallback(<K extends keyof PolicyConfig>(key: K, value: PolicyConfig[K]) => {
    setDraft((prev) => (prev ? { ...prev, [key]: value } : prev));
    if (key === "llm") setConnectivity((prev) => ({ ...prev, fast_review: EMPTY_CONNECTIVITY.fast_review }));
    if (key === "agent" || key === "deepModel") setConnectivity((prev) => ({ ...prev, deep_investigation: EMPTY_CONNECTIVITY.deep_investigation }));
  }, []);

  const handleConnectivityTest = useCallback(async (profile: ModelConnectionProfile) => {
    if (!draft) return;
    const config = profile === "fast_review" ? draft.llm : draft.deepModel;
    if (!config) return;
    setConnectivity((prev) => ({ ...prev, [profile]: { ...(prev[profile] ?? EMPTY_CONNECTIVITY[profile]), loading: true, result: null } }));
    try {
      const result = await securityCenterApi.testModelConnection({
        profile,
        url: config.url,
        model: config.model,
        apiKey: apiKeys[profile],
        timeoutS: config.timeoutS,
        contextTokens: profile === "deep_investigation" ? draft.deepModel?.contextTokens ?? 32768 : 16384,
      });
      setConnectivity((prev) => ({ ...prev, [profile]: { loading: false, applying: false, result } }));
    } catch (testError) {
      setConnectivity((prev) => ({ ...prev, [profile]: { ...(prev[profile] ?? EMPTY_CONNECTIVITY[profile]), loading: false } }));
      setToast({ kind: "error", message: `连接测试失败：${formatRequestError(testError)}` });
    }
  }, [apiKeys, draft]);

  const handleApplyConnection = useCallback(async (profile: ModelConnectionProfile) => {
    const token = connectivity[profile]?.result?.testToken;
    if (!token) return;
    setConnectivity((prev) => ({ ...prev, [profile]: { ...(prev[profile] ?? EMPTY_CONNECTIVITY[profile]), applying: true } }));
    try {
      const response = await securityCenterApi.applyModelConnection(profile, token);
      setStatus(response.status);
      setConnections(response.connections);
      setDraft((previous) => previous
        ? profile === "fast_review"
          ? { ...previous, llm: response.policy.llm }
          : { ...previous, deepModel: response.policy.deepModel, agent: response.policy.agent }
        : response.policy);
      setApiKeys((prev) => ({ ...prev, [profile]: "" }));
      setConnectivity((prev) => ({ ...prev, [profile]: EMPTY_CONNECTIVITY[profile] }));
      setToast({ kind: "success", message: `${profile === "fast_review" ? "快速研判模型" : "深度研判模型"}已实时生效` });
    } catch (applyError) {
      setConnectivity((prev) => ({ ...prev, [profile]: { ...(prev[profile] ?? EMPTY_CONNECTIVITY[profile]), applying: false } }));
      setToast({ kind: "error", message: `应用失败：${formatRequestError(applyError)}` });
    }
  }, [connectivity]);

  const handleClearConnection = useCallback(async (profile: ModelConnectionProfile) => {
    try {
      const response = await securityCenterApi.clearModelConnection(profile);
      setStatus(response.status);
      setConnections(response.connections);
      setApiKeys((prev) => ({ ...prev, [profile]: "" }));
      setConnectivity((prev) => ({ ...prev, [profile]: EMPTY_CONNECTIVITY[profile] }));
      setToast({ kind: "success", message: "运行时凭据已清除" });
    } catch (clearError) {
      setToast({ kind: "error", message: `清除失败：${formatRequestError(clearError)}` });
    }
  }, []);

  const handleApiKeyChange = useCallback((profile: ModelConnectionProfile, next: string) => {
    setApiKeys((prev) => ({ ...prev, [profile]: next }));
    setConnectivity((prev) => ({ ...prev, [profile]: EMPTY_CONNECTIVITY[profile] }));
  }, []);

  const handleSave = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const response = await securityCenterApi.setConfig(draft);
      applyResponse(response);
      setToast({ kind: "success", message: "策略已保存并生效" });
    } catch (saveError) {
      setToast({ kind: "error", message: `保存失败:${formatRequestError(saveError)}` });
    } finally {
      setSaving(false);
    }
  };

  const handleSimulate = async () => {
    if (!draft) return;
    setSimulating(true);
    try {
      const result = await securityCenterApi.simulateConfig({
        timeType: simulationTimeType,
        policy: draft,
        limit: 120,
      });
      setSimulation(result);
      setToast({ kind: "success", message: "策略模拟完成" });
    } catch (simulateError) {
      setToast({ kind: "error", message: `模拟失败:${formatRequestError(simulateError)}` });
    } finally {
      setSimulating(false);
    }
  };

  const applySupplyChainConfig = async (
    enabled: boolean,
    runInitialScan: boolean,
  ) => {
    if (!supplyDraft) return;
    setSavingSupplyChain(true);
    try {
      const response = await securityCenterApi.updateSupplyChainConfig({
        ...supplyDraft,
        enabled,
        runInitialScan,
      });
      setSupplyChain(response);
      setSupplyDraft(response.config);
      const queued = response.scanTasks?.length ?? 0;
      setToast({
        kind: "success",
        message: runInitialScan
          ? `供应链扫描已启用，已提交 ${queued} 个 Workspace 扫描任务`
          : enabled ? "供应链配置已保存" : "供应链扫描已停用，历史结果仍然保留",
      });
    } catch (supplyError) {
      setToast({ kind: "error", message: `供应链配置失败:${formatRequestError(supplyError)}` });
      await refreshSupplyChain();
    } finally {
      setSavingSupplyChain(false);
    }
  };

  return (
    <div className="flex h-full w-full overflow-hidden bg-[#0a0d12] text-zinc-100">
      <aside className="hidden">
        <nav className="space-y-1" aria-label={t("安全监控模块")}>
          <p className="flex items-center gap-2 px-3 pb-1 pt-3 text-[10px] font-bold uppercase tracking-[0.1em] text-[#5b6373]">
            <LayoutDashboard className="size-3.5" />
            {t("概览")}
          </p>
          {MONITORING_NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.view}
                to={`/?view=${item.view}`}
                className="flex w-full items-start gap-2.5 rounded-md border border-transparent px-2.5 py-2 text-left text-[#b6bdcc] transition-colors hover:bg-[#151a23] hover:text-[#e8ecf3]"
              >
                <span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center text-[#818a9c]">
                  <Icon className="size-3.5" />
                </span>
                <span className="min-w-0">
                  <span className="block text-xs font-semibold leading-[1.45]">{t(item.label)}</span>
                  <span className="mt-0.5 block text-[10.5px] leading-4 text-[#5b6373]">{t(item.description)}</span>
                </span>
              </Link>
            );
          })}
          <Link
            to="/alerts"
            className="flex w-full items-start gap-2.5 rounded-md border border-transparent px-2.5 py-2 text-left text-[#b6bdcc] transition-colors hover:bg-[#151a23] hover:text-[#e8ecf3]"
          >
            <span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center text-[#818a9c]">
              <BellRing className="size-3.5" />
            </span>
            <span className="min-w-0">
              <span className="block text-xs font-semibold leading-[1.45]">{t("告警")}</span>
              <span className="mt-0.5 block text-[10.5px] leading-4 text-[#5b6373]">{t("活跃告警与处置")}</span>
            </span>
          </Link>

          <p className="mt-3 flex items-center gap-2 border-t border-[#232a37] px-3 pb-1 pt-4 text-[10px] font-bold uppercase tracking-[0.1em] text-[#5b6373]">
            <ServerCog className="size-3.5" />
            {t("平台监控")}
          </p>
          {PLATFORM_NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.view}
                to={`/?view=${item.view}`}
                className="flex w-full items-start gap-2.5 rounded-md border border-transparent px-2.5 py-2 text-left text-[#b6bdcc] transition-colors hover:bg-[#151a23] hover:text-[#e8ecf3]"
              >
                <span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center text-[#818a9c]">
                  <Icon className="size-3.5" />
                </span>
                <span className="min-w-0">
                  <span className="block text-xs font-semibold leading-[1.45]">{t(item.label)}</span>
                  <span className="mt-0.5 block text-[10.5px] leading-4 text-[#5b6373]">{t(item.description)}</span>
                </span>
              </Link>
            );
          })}

          <p className="mt-3 flex items-center gap-2 border-t border-[#232a37] px-3 pb-1 pt-4 text-[10px] font-bold uppercase tracking-[0.1em] text-[#5b6373]">
            <Wrench className="size-3.5" />
            {t("运维")}
          </p>
          <Link
            to="/maintenance"
            className="flex w-full items-start gap-2.5 rounded-md border border-transparent px-2.5 py-2 text-left text-[#b6bdcc] transition-colors hover:bg-[#151a23] hover:text-[#e8ecf3]"
          >
            <span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center text-[#818a9c]">
              <CalendarClock className="size-3.5" />
            </span>
            <span className="block text-xs font-semibold leading-[1.45]">{t("维护")}</span>
          </Link>
          <div
            aria-current="page"
            className="flex w-full items-start gap-2.5 rounded-md border border-transparent bg-[#1c222d] px-2.5 py-2 text-left text-[#e8ecf3] shadow-[inset_2px_0_0_#f97316]"
          >
            <span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center text-[#f97316]">
              <SlidersHorizontal className="size-3.5" />
            </span>
            <span className="min-w-0">
              <span className="block text-xs font-semibold leading-[1.45]">{t("策略配置")}</span>
              <span className="mt-0.5 block text-[10.5px] leading-4 text-[#818a9c]">{t("L1 / L2 / L3 研判策略")}</span>
            </span>
          </div>

          <p className="mt-3 flex items-center gap-2 border-t border-[#232a37] px-3 pb-1 pt-4 text-[10px] font-bold uppercase tracking-[0.1em] text-[#5b6373]">
            <ShieldAlert className="size-3.5" />
            {t("安全治理")}
          </p>
          <Link
            to="/?view=supplyChain"
            className="flex w-full items-start gap-2.5 rounded-md border border-transparent px-2.5 py-2 text-left text-[#b6bdcc] transition-colors hover:bg-[#151a23] hover:text-[#e8ecf3]"
          >
            <span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center text-[#818a9c]">
              <ShieldAlert className="size-3.5" />
            </span>
            <span className="min-w-0">
              <span className="block text-xs font-semibold leading-[1.45]">{t("供应链漏洞")}</span>
              <span className="mt-0.5 block text-[10.5px] leading-4 text-[#5b6373]">{t("OSV 依赖漏洞资产")}</span>
            </span>
          </Link>

          <p className="mt-3 flex items-center gap-2 border-t border-[#232a37] px-3 pb-1 pt-4 text-[10px] font-bold uppercase tracking-[0.1em] text-[#5b6373]">
            <SlidersHorizontal className="size-3.5" />
            {t("管理")}
          </p>
          <AdminTokenControl navigation />
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <header className="shrink-0 border-b border-white/10 bg-[#0b0f0c] px-4 py-3">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <Button
              asChild
              variant="secondary"
              size="sm"
              className="h-9 shrink-0 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10"
            >
              <Link to="/">
                <ArrowLeft className="size-3.5" />
                返回
              </Link>
            </Button>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Sparkles className="size-5 shrink-0 text-teal-300" />
                <h1 className="truncate text-lg font-semibold tracking-normal text-zinc-50">策略配置</h1>
              </div>
              <p className="mt-0.5 truncate text-xs text-zinc-500">基础规则 · 快速研判 · 深度研判</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {status ? <StatusStrip status={status} /> : null}
            <AdminTokenControl compact />
            <Button
              type="button"
              onClick={handleSave}
              disabled={saving || loading || !draft}
              className="h-9 bg-teal-500 text-[#07100c] hover:bg-teal-400"
            >
              {saving ? <LoaderCircle className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
              保存
            </Button>
          </div>
        </div>
        {toast ? (
          <div className="mt-3">
            <Toast kind={toast.kind} message={toast.message} onClose={() => setToast(null)} />
          </div>
        ) : null}
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-4">
          {loading && !draft ? (
            <div className="flex min-h-40 items-center justify-center text-sm text-zinc-500">
              <LoaderCircle className="mr-2 size-4 animate-spin" />
              加载策略配置…
            </div>
          ) : error && !draft ? (
            <div className="flex min-h-40 flex-col items-center justify-center gap-3 text-sm text-rose-200">
              <span>{`加载失败:${formatRequestError(error)}`}</span>
              <Button
                type="button"
                size="sm"
                onClick={refresh}
                className="border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10"
              >
                重试
              </Button>
            </div>
          ) : draft ? (
            <>
              <Panel title="全局设置" icon={ShieldCheck} description="全局研判行为与推测式并发深度。">
                <div className="space-y-4 p-4">
                  <ToggleRow
                    label="失败时阻断 (failClosed)"
                    description="研判管线异常时,默认阻断而非放行。"
                    checked={draft.failClosed}
                    onChange={(next) => update("failClosed", next)}
                  />
                  <div className="max-w-xs">
                    <Field label="推测式并发 (speculate)" hint="提前并发执行上层研判以降低延迟。">
                      <SelectField
                        value={draft.speculate}
                        onChange={(next) => update("speculate", next)}
                        options={SPECULATE_OPTIONS}
                      />
                    </Field>
                  </div>
                </div>
              </Panel>

              <SimulationPanel
                timeType={simulationTimeType}
                result={simulation}
                loading={simulating}
                onTimeTypeChange={setSimulationTimeType}
                onRun={handleSimulate}
              />

              <L1RulesSection rules={draft.rules} onChange={(next) => update("rules", next)} />
              <IdentityJudgmentSection value={draft.identity} />
              <FastReviewSection
                value={draft.llm}
                onChange={(next) => update("llm", next)}
                state={connectivity.fast_review ?? EMPTY_CONNECTIVITY.fast_review}
                active={connections?.fast_review}
                apiKey={apiKeys.fast_review}
                onApiKeyChange={(next) => handleApiKeyChange("fast_review", next)}
                onTest={handleConnectivityTest}
                onApply={handleApplyConnection}
                onClear={handleClearConnection}
              />
              <DeepReviewSection
                model={draft.deepModel}
                agent={draft.agent}
                onModelChange={(next) => update("deepModel", next)}
                onAgentChange={(next) => update("agent", next)}
                state={connectivity.deep_investigation ?? EMPTY_CONNECTIVITY.deep_investigation}
                active={connections?.deep_investigation}
                apiKey={apiKeys.deep_investigation}
                onApiKeyChange={(next) => handleApiKeyChange("deep_investigation", next)}
                onTest={handleConnectivityTest}
                onApply={handleApplyConnection}
                onClear={handleClearConnection}
              />
              <SupplyChainSection
                value={supplyChain}
                draft={supplyDraft}
                loading={supplyChainLoading}
                saving={savingSupplyChain}
                onChange={setSupplyDraft}
                onSave={() => void applySupplyChainConfig(true, false)}
                onScan={() => void applySupplyChainConfig(true, true)}
                onDisable={() => void applySupplyChainConfig(false, false)}
                onRefresh={() => void refreshSupplyChain()}
              />
            </>
          ) : null}
        </div>
      </main>
      </div>
    </div>
  );
}
