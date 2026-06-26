import { useRequest } from "ahooks";
import {
  AlertTriangle,
  ArrowLeft,
  Bot,
  Brain,
  CheckCircle2,
  LoaderCircle,
  type LucideIcon,
  Plus,
  Save,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  type L1Rule,
  type L2Config,
  type L3Config,
  type PolicyConfig,
  type PolicyConfigResponse,
  type PolicyStatus,
  type RuleAction,
  type RuleKind,
  type SaeConfig,
  type SaeDictEntry,
  securityCenterApi,
  type SecuritySeverity,
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
const DEFAULT_SAE: Omit<SaeConfig, "dict"> = { enabled: true, escalateAt: 0.5, blockAt: 0.8 };

function formatRequestError(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message?: unknown }).message ?? "请求失败");
  }
  return "请求失败";
}

function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
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

// ── SAE section ──────────────────────────────────────────────────────────────
function SaeDictRow({
  entry,
  onChange,
  onRemove,
}: {
  entry: SaeDictEntry;
  onChange: (next: SaeDictEntry) => void;
  onRemove: () => void;
}) {
  return (
    <div className="grid grid-cols-[64px_minmax(0,1.3fr)_minmax(0,1fr)_88px_minmax(120px,0.8fr)_auto] items-center gap-2 rounded-md border border-white/10 bg-white/[0.03] px-2 py-2">
      <Input
        type="number"
        value={entry.id}
        onChange={(event) => onChange({ ...entry, id: Number(event.target.value) })}
        className="h-8 border-white/10 bg-white/5 text-xs"
        aria-label="特征 ID"
      />
      <Input
        value={entry.concept}
        onChange={(event) => onChange({ ...entry, concept: event.target.value })}
        placeholder="概念"
        className="h-8 border-white/10 bg-white/5 text-xs"
        aria-label="概念"
      />
      <Input
        value={entry.category}
        onChange={(event) => onChange({ ...entry, category: event.target.value })}
        placeholder="分类"
        className="h-8 border-white/10 bg-white/5 text-xs"
        aria-label="分类"
      />
      <Input
        type="number"
        step="0.01"
        value={entry.weight}
        onChange={(event) => onChange({ ...entry, weight: Number(event.target.value) })}
        className="h-8 border-white/10 bg-white/5 text-xs"
        aria-label="权重"
      />
      <SelectField
        value={entry.severity}
        onChange={(next) => onChange({ ...entry, severity: next })}
        options={SEVERITY_OPTIONS}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={onRemove}
        aria-label="删除特征"
        className="shrink-0 text-zinc-500 hover:bg-rose-500/10 hover:text-rose-200"
      >
        <Trash2 className="size-3.5" />
      </Button>
    </div>
  );
}

function SaeSection({
  value,
  seed,
  onChange,
}: {
  value: SaeConfig | null;
  seed: SaeDictEntry[];
  onChange: (next: SaeConfig | null) => void;
}) {
  const enabled = Boolean(value?.enabled);
  const config: SaeConfig = value ?? { ...DEFAULT_SAE, dict: [] };

  // First enable seeds the dictionary from the server-provided seed.
  const enable = (next: boolean) => {
    if (!next) {
      onChange(value ? { ...value, enabled: false } : { ...DEFAULT_SAE, enabled: false, dict: [] });
      return;
    }
    const dict = config.dict.length > 0 ? config.dict : seed.map((entry) => ({ ...entry }));
    onChange({ ...DEFAULT_SAE, ...config, enabled: true, dict });
  };

  const nextId = useMemo(() => config.dict.reduce((max, entry) => Math.max(max, entry.id), 0) + 1, [config.dict]);

  const updateEntry = (index: number, entry: SaeDictEntry) => {
    onChange({ ...config, dict: config.dict.map((item, idx) => (idx === index ? entry : item)) });
  };
  const removeEntry = (index: number) => {
    onChange({ ...config, dict: config.dict.filter((_, idx) => idx !== index) });
  };
  const addEntry = () => {
    onChange({
      ...config,
      dict: [...config.dict, { id: nextId, concept: "", category: "", weight: 0.5, severity: "medium" }],
    });
  };

  return (
    <Panel
      title="SAE 模型输出可解释性"
      icon={Brain}
      description="AnySentry 自有的模型输出评分器:启用开关 + escalateAt/blockAt (0..1) + 特征字典。"
      action={<Switch checked={enabled} onChange={enable} />}
    >
      {enabled ? (
        <div className="space-y-4 p-4">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="升级阈值 (escalateAt)" hint="0..1,得分 ≥ 该值触发升级研判">
              <Input
                type="number"
                step="0.01"
                min={0}
                max={1}
                value={config.escalateAt}
                onChange={(event) => onChange({ ...config, escalateAt: clamp01(Number(event.target.value)) })}
                className="h-8 border-white/10 bg-white/5 text-xs"
              />
            </Field>
            <Field label="阻断阈值 (blockAt)" hint="0..1,得分 ≥ 该值直接阻断">
              <Input
                type="number"
                step="0.01"
                min={0}
                max={1}
                value={config.blockAt}
                onChange={(event) => onChange({ ...config, blockAt: clamp01(Number(event.target.value)) })}
                className="h-8 border-white/10 bg-white/5 text-xs"
              />
            </Field>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between gap-3">
              <p className="text-xs font-medium text-zinc-400">特征字典 (feature dictionary)</p>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={addEntry}
                className="h-7 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10"
              >
                <Plus className="size-3.5" />
                新增特征
              </Button>
            </div>
            {config.dict.length === 0 ? (
              <div className="rounded-md border border-dashed border-white/10 px-3 py-6 text-center text-xs text-zinc-500">
                字典为空 — 点击「新增特征」添加 id/concept/category/weight/severity。
              </div>
            ) : (
              <div className="space-y-2">
                <div className="grid grid-cols-[64px_minmax(0,1.3fr)_minmax(0,1fr)_88px_minmax(120px,0.8fr)_auto] gap-2 px-2 text-[11px] text-zinc-600">
                  <span>ID</span>
                  <span>概念</span>
                  <span>分类</span>
                  <span>权重</span>
                  <span>严重度</span>
                  <span />
                </div>
                {config.dict.map((entry, index) => (
                  <SaeDictRow
                    key={index}
                    entry={entry}
                    onChange={(next) => updateEntry(index, next)}
                    onRemove={() => removeEntry(index)}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="px-4 py-5 text-xs text-zinc-500">
          未启用 — 不对模型输出评分。开启后将从服务端种子字典自动填充 ({seed.length} 项)。
        </div>
      )}
    </Panel>
  );
}

// ── Tier status strip ────────────────────────────────────────────────────────
function StatusStrip({ status }: { status: PolicyStatus }) {
  const tiers: Array<{ key: keyof PolicyStatus; label: string; icon: LucideIcon }> = [
    { key: "l1", label: "L1 规则", icon: ShieldCheck },
    { key: "l2", label: "L2 LLM", icon: Zap },
    { key: "l3", label: "L3 深判", icon: Bot },
    { key: "sae", label: "SAE", icon: Brain },
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
  const [seed, setSeed] = useState<SaeDictEntry[]>([]);
  const [toast, setToast] = useState<{ kind: "success" | "error"; message: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const applyResponse = useCallback((response: PolicyConfigResponse) => {
    setDraft(response.policy);
    setStatus(response.status);
    if (response.saeDictSeed) setSeed(response.saeDictSeed);
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
              <p className="mt-0.5 truncate text-xs text-zinc-500">L1 规则 · L2 LLM 研判 · L3 a3s-code 深判 · SAE 评分</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {status ? <StatusStrip status={status} /> : null}
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

              <L1RulesSection rules={draft.rules} onChange={(next) => update("rules", next)} />
              <L2Section value={draft.llm} onChange={(next) => update("llm", next)} />
              <L3Section value={draft.agent} onChange={(next) => update("agent", next)} />
              <SaeSection value={draft.sae} seed={seed} onChange={(next) => update("sae", next)} />
            </>
          ) : null}
        </div>
      </main>
    </div>
  );
}
