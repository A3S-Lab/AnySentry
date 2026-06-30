import { useRequest } from "ahooks";
import {
  AlertTriangle,
  ArrowLeft,
  BarChart3,
  Bot,
  CheckCircle2,
  LoaderCircle,
  type LucideIcon,
  Plus,
  Save,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
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
  type L3Config,
  type PolicyConfig,
  type PolicyConfigResponse,
  type PolicySimulationDiff,
  type PolicySimulationResult,
  type PolicyStatus,
  type RuleAction,
  type RuleKind,
  securityCenterApi,
  type SecuritySeverity,
  type SecurityTimeType,
  type SecurityVerdict,
} from "@/lib/api/security-center";
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
const DEFAULT_L3: L3Config = { bin: "a3s-code", skills: "" };

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
function Switch({ checked, onChange }: { checked: boolean; onChange: (next: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-teal-300/50",
        checked ? "border-teal-400/40 bg-teal-500/80" : "border-white/15 bg-white/10",
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

// ── L2 / L3 sections ─────────────────────────────────────────────────────────
function L2Section({ value, onChange }: { value: L2Config | null; onChange: (next: L2Config | null) => void }) {
  const enabled = value !== null;
  const config = value ?? DEFAULT_L2;

  return (
    <Panel
      title="L2 LLM 研判"
      icon={Zap}
      description="L1 规则升级时调用的 LLM 判官;后端不可达时优雅降级。需要可达的端点。"
      action={<Switch checked={enabled} onChange={(next) => onChange(next ? { ...DEFAULT_L2 } : null)} />}
    >
      {enabled ? (
        <div className="grid gap-4 p-4 md:grid-cols-2">
          <Field label="端点 URL (url)" hint="OpenAI 兼容的 /chat/completions 端点">
            <Input
              value={config.url}
              onChange={(event) => onChange({ ...config, url: event.target.value })}
              placeholder="https://llm.internal/v1/chat/completions"
              className="h-8 border-white/10 bg-white/5 font-mono text-xs"
            />
          </Field>
          <Field label="模型 (model)">
            <Input
              value={config.model}
              onChange={(event) => onChange({ ...config, model: event.target.value })}
              placeholder="例如 glm5.1-w4a8"
              className="h-8 border-white/10 bg-white/5 text-xs"
            />
          </Field>
          <Field label="超时秒数 (timeoutS)" hint="推理模型可能较慢,建议留足余量">
            <Input
              type="number"
              min={1}
              max={120}
              value={config.timeoutS}
              onChange={(event) => onChange({ ...config, timeoutS: Number(event.target.value) })}
              className="h-8 border-white/10 bg-white/5 text-xs"
            />
          </Field>
        </div>
      ) : (
        <div className="px-4 py-5 text-xs text-zinc-500">未启用 — 升级研判时将跳过 L2。开启后填写端点信息。</div>
      )}
    </Panel>
  );
}

function L3Section({ value, onChange }: { value: L3Config | null; onChange: (next: L3Config | null) => void }) {
  const enabled = value !== null;
  const config = value ?? DEFAULT_L3;

  return (
    <Panel
      title="L3 a3s-code 深判"
      icon={Bot}
      description="L1 规则升级时调用的 a3s-code 智能体;运行时需存在 a3s-code 二进制,缺失则优雅降级。"
      action={<Switch checked={enabled} onChange={(next) => onChange(next ? { ...DEFAULT_L3 } : null)} />}
    >
      {enabled ? (
        <div className="space-y-4 p-4">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="二进制路径 (bin)" hint="运行时中 a3s-code 可执行文件的路径或命令名">
              <Input
                value={config.bin}
                onChange={(event) => onChange({ ...config, bin: event.target.value })}
                placeholder="a3s-code"
                className="h-8 border-white/10 bg-white/5 font-mono text-xs"
              />
            </Field>
            <Field label="技能目录 (skills)">
              <Input
                value={config.skills}
                onChange={(event) => onChange({ ...config, skills: event.target.value })}
                placeholder="/etc/anysentry/skills"
                className="h-8 border-white/10 bg-white/5 font-mono text-xs"
              />
            </Field>
          </div>
          <div className="flex items-start gap-2 rounded-md border border-amber-400/25 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-100">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span>需要运行时中存在 a3s-code 二进制;若缺失,L3 将自动降级而不阻断流程。</span>
          </div>
        </div>
      ) : (
        <div className="px-4 py-5 text-xs text-zinc-500">未启用 — 升级研判时将跳过 L3。开启后填写二进制与技能目录。</div>
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
    { key: "l1", label: "L1 规则", icon: ShieldCheck },
    { key: "l2", label: "L2 LLM", icon: Zap },
    { key: "l3", label: "L3 深判", icon: Bot },
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
  const [draft, setDraft] = useState<PolicyConfig | null>(null);
  const [status, setStatus] = useState<PolicyStatus | null>(null);
  const [toast, setToast] = useState<{ kind: "success" | "error"; message: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [simulationTimeType, setSimulationTimeType] = useState<SecurityTimeType>("last_3h");
  const [simulation, setSimulation] = useState<PolicySimulationResult | null>(null);
  const [simulating, setSimulating] = useState(false);

  const applyResponse = useCallback((response: PolicyConfigResponse) => {
    setDraft(response.policy);
    setStatus(response.status);
  }, []);

  const { loading, error, refresh } = useRequest(() => securityCenterApi.getConfig(), {
    onSuccess: applyResponse,
  });

  // Auto-dismiss the toast a few seconds after it appears.
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  const update = useCallback(<K extends keyof PolicyConfig>(key: K, value: PolicyConfig[K]) => {
    setDraft((prev) => (prev ? { ...prev, [key]: value } : prev));
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

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-[#0b0f0c] text-zinc-100">
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
              <p className="mt-0.5 truncate text-xs text-zinc-500">L1 规则 · L2 LLM 研判 · L3 a3s-code 深判</p>
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
              <L2Section value={draft.llm} onChange={(next) => update("llm", next)} />
              <L3Section value={draft.agent} onChange={(next) => update("agent", next)} />
            </>
          ) : null}
        </div>
      </main>
    </div>
  );
}
