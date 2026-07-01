import { useRequest } from "ahooks";
import dayjs from "dayjs";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  BellRing,
  Bot,
  CalendarClock,
  Clock3,
  EyeOff,
  FileCheck2,
  Gauge,
  GitBranch,
  Layers3,
  LoaderCircle,
  Megaphone,
  type LucideIcon,
  Network,
  PlugZap,
  Radar,
  RadioTower,
  RefreshCw,
  Target,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  ShieldQuestion,
  Siren,
  Sparkles,
  TerminalSquare,
  Zap,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { AdminTokenControl } from "@/components/custom/admin-token-control";
import { useVChartTheme } from "@/components/custom/charts/vchart-theme";
import { type VChartSpec, VChartView } from "@/components/custom/vchart";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  type AgentEventCategory,
  type AgentEventList,
  type AgentEventListItem,
  type AgentObservability,
  type SecurityDecisionFunnel,
  type SecurityDecisionTier,
  type SecurityExplainabilityScan,
  type SecurityHealthCard,
  type SecurityHighestRiskSession,
  type SecurityPerformanceCard,
  type SecurityRiskBreakdown,
  type SecurityRiskCategory,
  type SecurityRiskDimension,
  type SecurityRiskLevel,
  type SecurityRiskSummary,
  type SecuritySeverity,
  type SecurityTimeFilter,
  type SecurityTimeType,
  type SecurityVerdict,
  type SecurityWorkspaceRiskDistribution,
  securityCenterApi,
  streamAgentObservability,
} from "@/lib/api/security-center";
import type { PolicyStatus } from "@/lib/api/security-center";
import { settleAll } from "@/lib/settle-all";
import { cn } from "@/lib/utils";

type SecuritySectionKey =
  | "health"
  | "scan"
  | "performance"
  | "riskSummary"
  | "riskBreakdown"
  | "highestRisk"
  | "decisionFunnel"
  | "workspaceRisk"
  | "events";

interface SecurityDashboardData {
  health: SecurityHealthCard | null;
  scan: SecurityExplainabilityScan | null;
  performance: SecurityPerformanceCard | null;
  riskSummary: SecurityRiskSummary | null;
  riskBreakdown: SecurityRiskBreakdown | null;
  highestRisk: SecurityHighestRiskSession | null;
  decisionFunnel: SecurityDecisionFunnel | null;
  workspaceRisk: SecurityWorkspaceRiskDistribution | null;
  events: AgentEventList | null;
  errors: Partial<Record<SecuritySectionKey, string>>;
}

const TIME_OPTIONS: Array<{ value: SecurityTimeType; label: string }> = [
  { value: "last_3h", label: "近3小时" },
  { value: "last_1d", label: "近一天" },
  { value: "last_7d", label: "近一周" },
  { value: "last_30d", label: "近一月" },
  { value: "custom", label: "自定义" },
];

const DEFAULT_FILTER: SecurityTimeFilter = { timeType: "last_3h" };
const EXPLAINABILITY_CHART_ANIMATION_MS = 2000;

const FALLBACK_BREAKDOWN_CATEGORY: SecurityRiskCategory = {
  totalCount: 0,
  items: [],
};

const RISK_TONE: Record<string, { label: string; text: string; bg: string; border: string; dot: string }> = {
  safe: {
    label: "安全",
    text: "text-emerald-200",
    bg: "bg-emerald-500/10",
    border: "border-emerald-400/30",
    dot: "bg-emerald-300",
  },
  low: {
    label: "低风险",
    text: "text-teal-200",
    bg: "bg-teal-500/10",
    border: "border-teal-400/30",
    dot: "bg-teal-300",
  },
  medium: {
    label: "中风险",
    text: "text-amber-200",
    bg: "bg-amber-500/10",
    border: "border-amber-400/30",
    dot: "bg-amber-300",
  },
  high: {
    label: "高风险",
    text: "text-orange-200",
    bg: "bg-orange-500/10",
    border: "border-orange-400/30",
    dot: "bg-orange-300",
  },
  critical: {
    label: "严重",
    text: "text-rose-200",
    bg: "bg-rose-500/10",
    border: "border-rose-400/30",
    dot: "bg-rose-300",
  },
  unknown: {
    label: "未知",
    text: "text-zinc-300",
    bg: "bg-zinc-500/10",
    border: "border-zinc-400/20",
    dot: "bg-zinc-400",
  },
};

const funnelColors = ["#2dd4bf", "#fbbf24", "#fb923c", "#fb7185"];
const summaryColors = ["#fb7185", "#fbbf24", "#2dd4bf", "#60a5fa"];
const EVENT_CATEGORY_LABEL: Record<AgentEventCategory, string> = {
  tool: "工具",
  network: "网络",
  file: "文件",
  llm: "LLM",
  security: "安全",
  process: "进程",
  runtime: "运行时",
  unknown: "未知",
};
const VERDICT_LABEL: Record<SecurityVerdict, string> = {
  allow: "放行",
  block: "阻断",
  escalate: "升级",
};

const RISK_DIMENSIONS: Array<Pick<SecurityRiskDimension, "dimensionCode" | "dimensionName">> = [
  { dimensionCode: "command_danger", dimensionName: "命令危险" },
  { dimensionCode: "prompt_injection", dimensionName: "提示词注入" },
  { dimensionCode: "data_leak", dimensionName: "数据泄露" },
  { dimensionCode: "jailbreak", dimensionName: "越狱绕过" },
  { dimensionCode: "communication_risk", dimensionName: "通信风险" },
  { dimensionCode: "systemic_risk", dimensionName: "系统性风险" },
];

const RISK_EVENT_NAMES: Record<string, string> = {
  cascadefailure: "级联失败",
  maliciousdissemination: "恶意传播",
  promptinjection: "提示词注入",
  jailbreakattempt: "越狱绕过",
  commanddanger: "命令危险",
  dataleak: "数据泄露",
  monitoringgap: "监控盲区",
  resourcepressure: "资源压力异常",
  policydrift: "策略漂移",
  policydriftafterrelease: "发布后策略漂移",
  sandboxegressattempt: "沙箱异常外联",
  agentloopresourcesurge: "智能体循环与资源突增",
  crossagentinjection: "跨智能体注入",
  crossagentcontextbleed: "跨智能体上下文串扰",
  maliciouspropagation: "恶意传播",
  privilegehandoff: "权限交接异常",
  contextleak: "上下文泄露",
  untrustedmcpoutput: "不可信 MCP 输出",
  toolabuse: "工具滥用",
  toolmisuse: "工具误用",
  toolpermissionescalation: "工具权限升级",
  secretexposure: "敏感信息暴露",
  secretincontextwindow: "上下文敏感信息",
  sensitivedata: "敏感数据",
};

function formatRequestError(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message?: unknown }).message ?? "请求失败");
  }
  return "请求失败";
}

async function loadSecurityDashboardData(filter: SecurityTimeFilter): Promise<SecurityDashboardData> {
  const scanFilter = { ...filter, seriesPoints: 36 };
  const { data, errors } = await settleAll(
    {
      health: securityCenterApi.healthCard(filter),
      scan: securityCenterApi.explainabilityScan(scanFilter),
      performance: securityCenterApi.performanceCard(filter),
      riskSummary: securityCenterApi.riskSummary(filter),
      riskBreakdown: securityCenterApi.riskBreakdown(filter),
      highestRisk: securityCenterApi.highestRiskSession(filter),
      decisionFunnel: securityCenterApi.decisionFunnel(filter),
      workspaceRisk: securityCenterApi.workspaceRiskDistribution(filter),
      events: securityCenterApi.agentEvents({ ...filter, limit: 36 }),
    },
    formatRequestError,
  );

  return enrichSecurityDashboardData({ ...data, errors });
}

function enrichSecurityDashboardData(data: SecurityDashboardData): SecurityDashboardData {
  return {
    health: data.health,
    scan: data.scan,
    performance: data.performance,
    riskSummary: data.riskSummary,
    riskBreakdown: normalizeRiskBreakdown(data.riskBreakdown),
    highestRisk: normalizeHighestRiskSession(data.highestRisk),
    decisionFunnel: data.decisionFunnel,
    workspaceRisk: data.workspaceRisk,
    events: data.events,
    errors: data.errors,
  };
}

function normalizeRiskBreakdown(breakdown?: SecurityRiskBreakdown | null): SecurityRiskBreakdown | null {
  if (!breakdown) return breakdown ?? null;
  return {
    ...breakdown,
    systemRisks: normalizeRiskCategory(breakdown.systemRisks),
    communicationRisks: normalizeRiskCategory(breakdown.communicationRisks),
    singleAgentRisks: normalizeRiskCategory(breakdown.singleAgentRisks),
  };
}

function normalizeRiskCategory(category?: SecurityRiskCategory): SecurityRiskCategory {
  return {
    totalCount: category?.totalCount ?? 0,
    displayColor: category?.displayColor,
    items: (category?.items ?? []).map((item) => ({
      ...item,
      riskName: riskEventName(item.riskCode || item.riskName),
    })),
  };
}

function normalizeHighestRiskSession(session?: SecurityHighestRiskSession | null): SecurityHighestRiskSession | null {
  if (!session) return session ?? null;
  return {
    ...session,
    riskDimensions: normalizeRiskDimensions(session.riskDimensions ?? []),
  };
}

function normalizeRiskDimensions(dimensions: SecurityRiskDimension[]): SecurityRiskDimension[] {
  const normalized = RISK_DIMENSIONS.map((dimension) => ({ ...dimension, score: 0 }));
  for (const dimension of dimensions) {
    const index = riskDimensionIndex([dimension.dimensionCode, dimension.dimensionName].filter(Boolean).join(" "));
    normalized[index].score = Math.max(normalized[index].score, dimensionScore(dimension.score));
  }
  return normalized;
}

function riskEventName(code: string) {
  const value = code?.trim();
  if (!value) return "未分类风险事件";
  const mapped = RISK_EVENT_NAMES[riskKey(value)];
  if (mapped) return mapped;
  return /[一-鿿]/.test(value) ? value : "未分类风险事件";
}

function riskDimensionIndex(value: string) {
  const key = riskKey(value);
  if (
    key.includes("d4toolmisuse") ||
    key.includes("command") ||
    key.includes("permission") ||
    key.includes("tool") ||
    key.includes("命令") ||
    key.includes("工具") ||
    key.includes("权限") ||
    key.includes("危险")
  ) {
    return 0;
  }
  if (key.includes("d1promptinjection") || key.includes("prompt") || key.includes("提示词") || key.includes("注入")) {
    return 1;
  }
  if (
    key.includes("d3sensitivedata") ||
    key.includes("data") ||
    key.includes("secret") ||
    key.includes("sensitive") ||
    key.includes("privacy") ||
    key.includes("pii") ||
    key.includes("leak") ||
    key.includes("数据") ||
    key.includes("泄露") ||
    key.includes("敏感")
  ) {
    return 2;
  }
  if (key.includes("d2jailbreak") || key.includes("jailbreak") || key.includes("越狱") || key.includes("绕过")) {
    return 3;
  }
  if (
    key.includes("d5communication") ||
    key.includes("communication") ||
    key.includes("agent") ||
    key.includes("handoff") ||
    key.includes("context") ||
    key.includes("propagation") ||
    key.includes("dissemination") ||
    key.includes("mcp") ||
    key.includes("通信") ||
    key.includes("智能体") ||
    key.includes("上下文") ||
    key.includes("传播") ||
    key.includes("交接")
  ) {
    return 4;
  }
  if (
    key.includes("d6systemic") ||
    key.includes("system") ||
    key.includes("cascade") ||
    key.includes("policy") ||
    key.includes("resource") ||
    key.includes("sandbox") ||
    key.includes("monitoring") ||
    key.includes("loop") ||
    key.includes("系统") ||
    key.includes("级联") ||
    key.includes("策略") ||
    key.includes("资源") ||
    key.includes("沙箱") ||
    key.includes("监控") ||
    key.includes("循环")
  ) {
    return 5;
  }
  return 1;
}

function dimensionScore(score: number) {
  const value = Number(score);
  if (!Number.isFinite(value)) return 0;
  const normalized = value > 3 ? (value / 100) * 3 : value;
  return Number(clamp(normalized, 0, 3).toFixed(1));
}

function riskKey(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9一-鿿]+/g, "");
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function buildCustomFilter(start: string, end: string): SecurityTimeFilter {
  return {
    timeType: "custom",
    startTime: dayjs(start).startOf("day").toISOString(),
    endTime: dayjs(end).endOf("day").toISOString(),
  };
}

function formatNumber(value?: number, options?: Intl.NumberFormatOptions) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "--";
  return new Intl.NumberFormat("zh-CN", options).format(value);
}

function formatCompactNumber(value?: number) {
  return formatNumber(value, { notation: "compact", maximumFractionDigits: 1 });
}

function normalizePercent(value?: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  const normalized = Math.abs(value) <= 1 ? value * 100 : value;
  return Math.max(0, Math.min(100, normalized));
}

function formatPercent(value?: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "--";
  return `${normalizePercent(value).toFixed(normalizePercent(value) >= 10 ? 0 : 1)}%`;
}

function formatSignedPercent(value?: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "--";
  const normalized = Math.abs(value) <= 1 ? value * 100 : value;
  const sign = normalized > 0 ? "+" : "";
  return `${sign}${normalized.toFixed(Math.abs(normalized) >= 10 ? 0 : 1)}%`;
}

function formatDate(value?: string) {
  if (!value) return "--";
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed.format("MM-DD HH:mm:ss") : value;
}

function formatTimeLabel(value?: string) {
  if (!value) return "";
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed.format("HH:mm:ss") : value.slice(-8);
}

function healthState(score?: number, text?: string) {
  if (typeof score === "number") {
    if (score >= 90) return "safe";
    if (score >= 70) return "medium";
    return "critical";
  }
  if (text?.includes("正常")) return "safe";
  if (text?.includes("警告")) return "medium";
  if (text?.includes("异常") || text?.includes("错误")) return "critical";
  return "unknown";
}

function riskTone(level?: SecurityRiskLevel) {
  return RISK_TONE[String(level || "unknown").toLowerCase()] ?? RISK_TONE.unknown;
}

function severityLevel(severity?: SecuritySeverity): SecurityRiskLevel {
  if (severity === "info") return "safe";
  return severity ?? "unknown";
}

function verdictLevel(verdict?: SecurityVerdict): SecurityRiskLevel {
  if (verdict === "block") return "critical";
  if (verdict === "escalate") return "medium";
  if (verdict === "allow") return "safe";
  return "unknown";
}

function activeFilterLabel(filter: SecurityTimeFilter) {
  if (filter.timeType === "custom" && filter.startTime && filter.endTime) {
    return `${dayjs(filter.startTime).format("YYYY-MM-DD")} ~ ${dayjs(filter.endTime).format("YYYY-MM-DD")}`;
  }
  return TIME_OPTIONS.find((option) => option.value === (filter.timeType ?? "last_3h"))?.label ?? "近3小时";
}

function Panel({
  title,
  icon: Icon,
  action,
  children,
  className,
}: {
  title: string;
  icon: LucideIcon;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("rounded-[8px] border border-white/10 bg-[#111612]/92", className)}>
      <div className="flex min-h-12 items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-white/10 bg-white/5 text-teal-200">
            <Icon className="size-4" />
          </span>
          <h2 className="truncate text-sm font-semibold text-zinc-100">{title}</h2>
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

function EmptyState({ label }: { label: string }) {
  return <div className="flex min-h-28 items-center justify-center px-4 py-5 text-sm text-zinc-500">{label}</div>;
}

function InlineError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <div className="flex items-start gap-2 rounded-md border border-rose-400/25 bg-rose-500/10 px-3 py-2 text-xs text-rose-100">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
      <span className="line-clamp-2">{message}</span>
    </div>
  );
}

function StatusPill({ level, label }: { level?: SecurityRiskLevel; label?: string }) {
  const tone = riskTone(level);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold",
        tone.bg,
        tone.border,
        tone.text,
      )}
    >
      <span className={cn("size-1.5 rounded-full", tone.dot)} />
      {label || tone.label}
    </span>
  );
}

function MetricPanel({
  label,
  value,
  sub,
  icon: Icon,
  tone,
  footer,
  loading,
}: {
  label: string;
  value: string;
  sub: string;
  icon: LucideIcon;
  tone: string;
  footer?: ReactNode;
  loading?: boolean;
}) {
  return (
    <section className="min-h-[132px] rounded-[8px] border border-white/10 bg-[#111612]/92 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-xs font-medium text-zinc-400">{label}</p>
          <div className="mt-2 min-h-9">
            {loading ? (
              <LoaderCircle className="size-5 animate-spin text-zinc-500" />
            ) : (
              <p className="truncate text-3xl font-semibold leading-none tracking-normal text-zinc-50">{value}</p>
            )}
          </div>
        </div>
        <span className={cn("inline-flex size-10 shrink-0 items-center justify-center rounded-md border", tone)}>
          <Icon className="size-5" />
        </span>
      </div>
      <p className="mt-3 truncate text-xs text-zinc-500">{sub}</p>
      {footer ? <div className="mt-3">{footer}</div> : null}
    </section>
  );
}

function DashboardSection({ title, icon: Icon, children }: { title: string; icon: LucideIcon; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2 px-1">
        <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-white/10 bg-white/5 text-teal-200">
          <Icon className="size-3.5" />
        </span>
        <h2 className="text-sm font-semibold text-zinc-100">{title}</h2>
      </div>
      {children}
    </section>
  );
}

function MiniGauge({ value, color }: { value: number; color: string }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/8">
      <div
        className="h-full rounded-full transition-[width] duration-500"
        style={{ width: `${Math.max(0, Math.min(100, value))}%`, backgroundColor: color }}
      />
    </div>
  );
}

function SecurityHeader({
  filter,
  loading,
  lastUpdatedAt,
  customStart,
  customEnd,
  customError,
  onTimeTypeChange,
  onCustomStartChange,
  onCustomEndChange,
  onApplyCustomTime,
  onRefresh,
}: {
  filter: SecurityTimeFilter;
  loading: boolean;
  lastUpdatedAt?: string;
  customStart: string;
  customEnd: string;
  customError?: string;
  onTimeTypeChange: (value: SecurityTimeType) => void;
  onCustomStartChange: (value: string) => void;
  onCustomEndChange: (value: string) => void;
  onApplyCustomTime: () => void;
  onRefresh: () => void;
}) {
  const maxDate = dayjs().format("YYYY-MM-DD");

  return (
    <header className="shrink-0 border-b border-white/10 bg-[#0b0f0c] px-4 py-3 text-zinc-100">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <ShieldCheck className="size-5 shrink-0 text-teal-300" />
              <h1 className="truncate text-lg font-semibold tracking-normal text-zinc-50">安全监控中台</h1>
              <span className="hidden rounded-full border border-teal-300/25 bg-teal-400/10 px-2 py-0.5 text-[11px] font-semibold text-teal-100 sm:inline-flex">
                {activeFilterLabel(filter)}
              </span>
            </div>
            <p className="mt-0.5 truncate text-xs text-zinc-500">风险监控面板 · 会话决策漏斗 · 工作区风险分布</p>
          </div>
        </div>

        <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-end">
          <div className="flex items-center gap-2">
            <Select
              value={filter.timeType ?? "last_3h"}
              onValueChange={(value) => onTimeTypeChange(value as SecurityTimeType)}
            >
              <SelectTrigger className="h-9 w-[128px] border-white/10 bg-white/5 text-xs text-zinc-100">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TIME_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={onRefresh}
              disabled={loading}
              className="h-9 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10"
            >
              {loading ? (
                <LoaderCircle className="mr-1.5 size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="mr-1.5 size-3.5" />
              )}
              刷新
            </Button>
            <AdminTokenControl />
            <Button
              asChild
              variant="secondary"
              size="sm"
              className="h-9 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10"
            >
              <Link to="/sources">
                <PlugZap className="mr-1.5 size-3.5" />
                接入源
              </Link>
            </Button>
            <Button
              asChild
              variant="secondary"
              size="sm"
              className="h-9 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10"
            >
              <Link to="/collectors">
                <RadioTower className="mr-1.5 size-3.5" />
                采集链路
              </Link>
            </Button>
            <Button
              asChild
              variant="secondary"
              size="sm"
              className="h-9 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10"
            >
              <Link to="/agents">
                <Bot className="mr-1.5 size-3.5" />
                智能体资产
              </Link>
            </Button>
            <Button
              asChild
              variant="secondary"
              size="sm"
              className="h-9 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10"
            >
              <Link to="/workspaces">
                <Layers3 className="mr-1.5 size-3.5" />
                Workspace
              </Link>
            </Button>
            <Button
              asChild
              variant="secondary"
              size="sm"
              className="h-9 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10"
            >
              <Link to="/remediation">
                <FileCheck2 className="mr-1.5 size-3.5" />
                处置
              </Link>
            </Button>
            <Button
              asChild
              variant="secondary"
              size="sm"
              className="h-9 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10"
            >
              <Link to="/operator">
                <Zap className="mr-1.5 size-3.5" />
                AI Operator
              </Link>
            </Button>
            <Button
              asChild
              variant="secondary"
              size="sm"
              className="h-9 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10"
            >
              <Link to="/capabilities">
                <Sparkles className="mr-1.5 size-3.5" />
                API
              </Link>
            </Button>
            <Button
              asChild
              variant="secondary"
              size="sm"
              className="h-9 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10"
            >
              <Link to="/coverage">
                <EyeOff className="mr-1.5 size-3.5" />
                覆盖
              </Link>
            </Button>
            <Button
              asChild
              variant="secondary"
              size="sm"
              className="h-9 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10"
            >
              <Link to="/maintenance">
                <CalendarClock className="mr-1.5 size-3.5" />
                维护
              </Link>
            </Button>
            <Button
              asChild
              variant="secondary"
              size="sm"
              className="h-9 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10"
            >
              <Link to="/topology">
                <GitBranch className="mr-1.5 size-3.5" />
                拓扑
              </Link>
            </Button>
            <Button
              asChild
              variant="secondary"
              size="sm"
              className="h-9 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10"
            >
              <Link to="/objectives">
                <Target className="mr-1.5 size-3.5" />
                目标
              </Link>
            </Button>
            <Button
              asChild
              variant="secondary"
              size="sm"
              className="h-9 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10"
            >
              <Link to="/alerts">
                <BellRing className="mr-1.5 size-3.5" />
                告警
              </Link>
            </Button>
            <Button
              asChild
              variant="secondary"
              size="sm"
              className="h-9 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10"
            >
              <Link to="/notifications">
                <Megaphone className="mr-1.5 size-3.5" />
                通知
              </Link>
            </Button>
            <Button
              asChild
              variant="secondary"
              size="sm"
              className="h-9 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10"
            >
              <Link to="/incidents">
                <Siren className="mr-1.5 size-3.5" />
                Incident
              </Link>
            </Button>
            <Button
              asChild
              variant="secondary"
              size="sm"
              className="h-9 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10"
            >
              <Link to="/audit">
                <Clock3 className="mr-1.5 size-3.5" />
                审计
              </Link>
            </Button>
            <Button
              asChild
              variant="secondary"
              size="sm"
              className="h-9 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10"
            >
              <Link to="/admin/policy">
                <SlidersHorizontal className="mr-1.5 size-3.5" />
                策略配置
              </Link>
            </Button>
          </div>

          {filter.timeType === "custom" ? (
            <div className="flex flex-wrap items-center gap-2">
              <Input
                type="date"
                value={customStart}
                max={maxDate}
                onChange={(event) => onCustomStartChange(event.target.value)}
                className="h-9 w-[150px] border-white/10 bg-white/5 text-xs text-zinc-100"
              />
              <span className="text-xs text-zinc-500">至</span>
              <Input
                type="date"
                value={customEnd}
                max={maxDate}
                onChange={(event) => onCustomEndChange(event.target.value)}
                className="h-9 w-[150px] border-white/10 bg-white/5 text-xs text-zinc-100"
              />
              <Button
                type="button"
                size="sm"
                onClick={onApplyCustomTime}
                disabled={Boolean(customError)}
                className="h-9 bg-teal-500 text-[#07100c] hover:bg-teal-400"
              >
                应用
              </Button>
            </div>
          ) : null}

          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <Clock3 className="size-3.5" />
            <span>{lastUpdatedAt ? formatDate(lastUpdatedAt) : "等待刷新"}</span>
          </div>
        </div>
      </div>
      {customError ? <p className="mt-2 text-xs text-rose-200">{customError}</p> : null}
    </header>
  );
}

function ExplainabilityWaveChart({ scan }: { scan?: SecurityExplainabilityScan | null }) {
  const chartTheme = useVChartTheme();
  const chartData = useMemo(() => {
    const series = scan?.waveSeries?.[0];
    const safe = series?.safeSeries ?? [];
    const risk = series?.riskSeries ?? [];
    return [
      ...safe.map((point) => ({
        id: `safe-${point.statTime}`,
        time: formatTimeLabel(point.statTime),
        type: "安全感知",
        value: point.value,
        activationCount: point.activationCount,
      })),
      ...risk.map((point) => ({
        id: `risk-${point.statTime}`,
        time: formatTimeLabel(point.statTime),
        type: "风险感知",
        value: point.value,
        activationCount: point.activationCount,
      })),
    ];
  }, [scan]);

  const spec = useMemo<VChartSpec>(
    () => ({
      type: "line",
      data: [{ id: "wave", values: chartData }],
      xField: "time",
      yField: "value",
      seriesField: "type",
      color: ["#2dd4bf", "#fb923c"],
      padding: { top: 12, right: 18, bottom: 4, left: 0 },
      animation: true,
      animationAppear: false,
      animationEnter: { duration: 260, easing: "linear" },
      animationExit: { duration: 260, easing: "linear" },
      animationUpdate: { duration: EXPLAINABILITY_CHART_ANIMATION_MS - 180, easing: "linear" },
      tooltip: {
        visible: true,
        mark: { title: { value: "time" } },
      },
      legends: {
        visible: true,
        orient: "bottom",
        padding: { top: 4 },
        item: {
          label: { style: { fill: chartTheme.axisLabel, fontSize: 11 } },
          shape: { style: { symbolType: "circle" } },
        },
      },
      axes: [
        {
          orient: "bottom",
          tick: { visible: false },
          domainLine: { visible: false },
          label: { style: { fill: chartTheme.axisSubLabel, fontSize: 10 } },
        },
        {
          orient: "left",
          min: 0,
          max: 100,
          tick: { visible: false },
          domainLine: { visible: false },
          grid: { visible: true, style: { stroke: "#233126", lineWidth: 1 } },
          label: { style: { fill: chartTheme.axisSubLabel, fontSize: 10 } },
        },
      ],
      line: { style: { curveType: "monotone", lineWidth: 3 } },
      point: { visible: false },
    }),
    [chartData, chartTheme],
  );

  if (chartData.length === 0) return <EmptyState label="暂无可解释波图数据" />;

  return (
    <div className="h-[250px] min-h-0">
      <VChartView spec={spec} />
    </div>
  );
}

function ExplainabilityPanel({ scan, error }: { scan?: SecurityExplainabilityScan | null; error?: string }) {
  const safeLatest = scan?.waveSeries?.[0]?.safeSeries?.at(-1)?.value ?? 0;
  const riskLatest = scan?.waveSeries?.[0]?.riskSeries?.at(-1)?.value ?? 0;

  return (
    <Panel title="脑际可解释扫描" icon={Radar}>
      <div className="grid gap-4 p-4 lg:grid-cols-[280px_minmax(0,1fr)]">
        <div className="flex flex-col items-center justify-center gap-4">
          <div className="w-full rounded-md border border-white/10 bg-white/[0.04] p-4">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-xs font-medium text-zinc-400">安全感知</span>
              <span className="font-mono text-4xl font-semibold text-zinc-50">
                {formatNumber(safeLatest, { maximumFractionDigits: 0 })}
              </span>
            </div>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/8">
              <div
                className="h-full rounded-full bg-teal-400 transition-[width] duration-500"
                style={{ width: `${Math.max(0, Math.min(100, safeLatest))}%` }}
              />
            </div>
            <div className="mt-3 flex items-center justify-between gap-3 text-[11px] text-zinc-500">
              <span>风险感知</span>
              <span className="font-mono text-zinc-300">{formatNumber(riskLatest, { maximumFractionDigits: 0 })}</span>
            </div>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/8">
              <div
                className="h-full rounded-full bg-rose-400 transition-[width] duration-500"
                style={{ width: `${Math.max(0, Math.min(100, riskLatest))}%` }}
              />
            </div>
          </div>
          <div className="grid w-full grid-cols-2 gap-3 text-center">
            <div>
              <p className="text-xs text-zinc-500">危险拦截</p>
              <p className="mt-1 text-xl font-semibold text-rose-100">{scan?.threatInterception ?? "--"}</p>
            </div>
            <div>
              <p className="text-xs text-zinc-500">活跃会话</p>
              <p className="mt-1 text-xl font-semibold text-teal-100">{scan?.sessionActiveCount ?? "--"}</p>
            </div>
          </div>
        </div>
        <div className="min-w-0">
          <div className="mb-3 grid gap-3 sm:grid-cols-2">
            <div>
              <div className="mb-1 flex items-center justify-between text-xs">
                <span className="text-zinc-500">安全感知</span>
                <span className="font-semibold text-teal-100">
                  {formatNumber(safeLatest, { maximumFractionDigits: 1 })}
                </span>
              </div>
              <MiniGauge value={safeLatest} color="#2dd4bf" />
            </div>
            <div>
              <div className="mb-1 flex items-center justify-between text-xs">
                <span className="text-zinc-500">风险感知</span>
                <span className="font-semibold text-orange-100">
                  {formatNumber(riskLatest, { maximumFractionDigits: 1 })}
                </span>
              </div>
              <MiniGauge value={riskLatest} color="#fb923c" />
            </div>
          </div>
          <InlineError message={error} />
          <ExplainabilityWaveChart scan={scan} />
        </div>
      </div>
    </Panel>
  );
}

function PerformanceMetricPanel({
  performance,
  loading,
}: {
  performance?: SecurityPerformanceCard | null;
  loading?: boolean;
}) {
  const requestCount = performance?.componentRequestCount;
  const tps = performance?.tps;
  const latency = performance?.avgLatency;

  return (
    <>
      <MetricPanel
        label="组件请求数"
        value={formatCompactNumber(requestCount?.current)}
        sub={`峰值 ${formatCompactNumber(requestCount?.peak)} / 平均 ${formatCompactNumber(requestCount?.avg)}`}
        icon={Network}
        tone="border-sky-300/25 bg-sky-400/10 text-sky-200"
        loading={loading}
      />
      <MetricPanel
        label="实时 TPS"
        value={formatNumber(tps?.current, { maximumFractionDigits: 1 })}
        sub={`峰值 ${formatNumber(tps?.peak, { maximumFractionDigits: 1 })} / 平均 ${formatNumber(tps?.avg, { maximumFractionDigits: 1 })}`}
        icon={Zap}
        tone="border-amber-300/25 bg-amber-400/10 text-amber-200"
        loading={loading}
      />
      <MetricPanel
        label="平均响应延迟"
        value={`${formatNumber(latency?.value, { maximumFractionDigits: 1 })}${latency?.unit ?? "ms"}`}
        sub={performance?.updateTime ? `更新 ${formatDate(performance.updateTime)}` : "等待性能数据"}
        icon={Gauge}
        tone="border-sky-300/25 bg-sky-400/10 text-sky-200"
        loading={loading}
      />
    </>
  );
}

function TopMetrics({ data, loading }: { data?: SecurityDashboardData; loading?: boolean }) {
  const health = data?.health;
  const state = healthState(health?.healthScore, health?.healthStatusText);
  const tone = riskTone(state);

  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
      <MetricPanel
        label="健康状况"
        value={formatNumber(health?.healthScore, { maximumFractionDigits: 1 })}
        sub={health?.healthStatusText || "暂无健康状态"}
        icon={state === "critical" ? ShieldAlert : ShieldCheck}
        tone={cn(tone.border, tone.bg, tone.text)}
        loading={loading}
        footer={
          <MiniGauge
            value={health?.healthScore ?? 0}
            color={state === "critical" ? "#fb7185" : state === "medium" ? "#fbbf24" : "#2dd4bf"}
          />
        }
      />
      <MetricPanel
        label="Token 消耗量"
        value={`${formatCompactNumber(health?.tokenConsumptionTotal)} ${health?.tokenConsumptionUnit ?? ""}`.trim()}
        sub="当前筛选范围累计消耗"
        icon={Gauge}
        tone="border-teal-300/25 bg-teal-400/10 text-teal-200"
        loading={loading}
      />
      <PerformanceMetricPanel performance={data?.performance} loading={loading} />
    </div>
  );
}

function LiveObservabilityPanel({
  observability,
  connected,
}: {
  observability?: AgentObservability | null;
  connected: boolean;
}) {
  const heartbeatLevel: SecurityRiskLevel = observability?.health.heartbeatOk ? "safe" : connected ? "critical" : "unknown";
  const driftLevel: SecurityRiskLevel = observability?.behavioral.decisionPattern === "drift" ? "medium" : "safe";
  const statusLabel = connected ? `实时 ${formatTimeLabel(observability?.updateTime)}` : "连接中";
  const items = [
    {
      label: "心跳",
      value: observability ? (observability.health.heartbeatOk ? "在线" : "异常") : "--",
      sub: `决策延迟 ${formatNumber(observability?.health.decisionLatencyMs, { maximumFractionDigits: 0 })}ms`,
      icon: RadioTower,
      tone: heartbeatLevel,
    },
    {
      label: "错误率",
      value: formatPercent(observability?.health.errorRate),
      sub: `资源利用 ${formatPercent(observability?.health.resourceUtil)}`,
      icon: AlertTriangle,
      tone: observability && observability.health.errorRate > 10 ? "medium" : "safe",
    },
    {
      label: "吞吐",
      value: formatNumber(observability?.system.commThroughput, { maximumFractionDigits: 1 }),
      sub: `智能体 ${formatNumber(observability?.system.agentCount, { maximumFractionDigits: 0 })}`,
      icon: Network,
      tone: observability?.system.infraHealthy === false ? "medium" : "safe",
    },
    {
      label: "行为态势",
      value: observability?.behavioral.decisionPattern === "drift" ? "漂移" : observability ? "基线" : "--",
      sub: `动作率 ${formatNumber(observability?.behavioral.actionRate, { maximumFractionDigits: 1 })}`,
      icon: Activity,
      tone: driftLevel,
    },
    {
      label: "状态迁移",
      value: formatNumber(observability?.behavioral.stateTransitions, { maximumFractionDigits: 0 }),
      sub: `目标进度 ${formatPercent(observability?.behavioral.goalProgress)}`,
      icon: GitBranch,
      tone: "low",
    },
  ];

  return (
    <Panel title="实时智能体可观测性" icon={RadioTower} action={<StatusPill level={connected ? "safe" : "unknown"} label={statusLabel} />}>
      <div className="grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-5">
        {items.map((item) => {
          const tone = riskTone(item.tone);
          const Icon = item.icon;
          return (
            <div key={item.label} className="min-h-[108px] rounded-[8px] border border-white/10 bg-white/[0.03] p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium text-zinc-500">{item.label}</p>
                  <p className="mt-2 truncate text-2xl font-semibold leading-none tracking-normal text-zinc-50">{item.value}</p>
                </div>
                <span className={cn("inline-flex size-9 shrink-0 items-center justify-center rounded-md border", tone.border, tone.bg, tone.text)}>
                  <Icon className="size-4" />
                </span>
              </div>
              <p className="mt-3 truncate text-xs text-zinc-500">{item.sub}</p>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

function RiskSummaryPanels({ summary }: { summary?: SecurityRiskSummary | null }) {
  const cards = summary?.summaryCards ?? [];
  if (cards.length === 0) {
    return (
      <Panel title="风险层级总览" icon={Layers3}>
        <EmptyState label="暂无风险总览数据" />
      </Panel>
    );
  }

  return (
    <div className="grid gap-3 md:grid-cols-3">
      {cards.map((card, index) => (
        <MetricPanel
          key={card.riskTypeCode || card.riskTypeName}
          label={card.riskTypeName || card.riskTypeCode}
          value={formatNumber(card.eventCount)}
          sub={card.riskTypeCode || "风险类型"}
          icon={index === 0 ? Siren : index === 1 ? Activity : ShieldQuestion}
          tone="border-white/10 bg-white/5 text-zinc-100"
          footer={
            <MiniGauge
              value={Math.min(100, (card.eventCount / Math.max(1, cards[0]?.eventCount ?? 1)) * 100)}
              color={summaryColors[index % summaryColors.length]}
            />
          }
        />
      ))}
    </div>
  );
}

function RiskCategoryColumn({
  title,
  category,
  color,
}: {
  title: string;
  category?: SecurityRiskCategory;
  color: string;
}) {
  const items = category?.items ?? [];

  return (
    <div className="min-w-0">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-zinc-100">{title}</p>
          <p className="mt-0.5 text-xs text-zinc-500">总计 {formatNumber(category?.totalCount ?? 0)} 个事件</p>
        </div>
        <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
      </div>
      {items.length === 0 ? (
        <div className="rounded-md border border-white/10 px-3 py-6 text-center text-xs text-zinc-500">暂无风险项</div>
      ) : (
        <div className="max-h-[310px] space-y-2 overflow-y-auto pr-1">
          {items.map((item) => {
            const change = Math.abs(item.changeRate) <= 1 ? item.changeRate * 100 : item.changeRate;
            return (
              <div
                key={item.riskCode}
                className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 rounded-md border border-white/10 bg-white/[0.03] px-3 py-2.5 transition hover:bg-white/[0.06]"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm text-zinc-200">{riskEventName(item.riskCode || item.riskName)}</p>
                  <p className="mt-0.5 truncate text-[11px] text-zinc-600">{item.riskCode}</p>
                </div>
                <span className="tabular-nums text-sm font-semibold text-zinc-100">
                  {formatNumber(item.eventCount)}
                </span>
                <span
                  className={cn(
                    "min-w-[54px] text-right text-xs tabular-nums",
                    change > 0 ? "text-rose-200" : change < 0 ? "text-teal-200" : "text-zinc-500",
                  )}
                >
                  {formatSignedPercent(item.changeRate)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function RiskBreakdownPanel({ breakdown, error }: { breakdown?: SecurityRiskBreakdown | null; error?: string }) {
  const data = breakdown ?? {
    systemRisks: FALLBACK_BREAKDOWN_CATEGORY,
    communicationRisks: FALLBACK_BREAKDOWN_CATEGORY,
    singleAgentRisks: FALLBACK_BREAKDOWN_CATEGORY,
    updateTime: "",
  };

  return (
    <Panel
      title="风险分层拆解"
      icon={BarChart3}
      action={<span className="text-xs text-zinc-500">{data.updateTime ? formatDate(data.updateTime) : "--"}</span>}
    >
      <div className="space-y-3 p-4">
        <InlineError message={error} />
        <div className="grid gap-5 lg:grid-cols-3">
          <RiskCategoryColumn title="系统级涌现风险" category={data.systemRisks} color="#fb7185" />
          <RiskCategoryColumn title="智能体间通信风险" category={data.communicationRisks} color="#fbbf24" />
          <RiskCategoryColumn title="单智能体原子风险" category={data.singleAgentRisks} color="#2dd4bf" />
        </div>
      </div>
    </Panel>
  );
}

function RadarChart({ dimensions }: { dimensions: SecurityRiskDimension[] }) {
  const chartDimensions = normalizeRiskDimensions(dimensions);
  const center = 110;
  const radius = 72;
  const maxScore = 3;

  const angleFor = (index: number) => (Math.PI * 2 * index) / chartDimensions.length - Math.PI / 2;
  const pointFor = (index: number, value: number) => {
    const angle = angleFor(index);
    const bounded = Math.max(0, Math.min(maxScore, value));
    const distance = (bounded / maxScore) * radius;
    return {
      x: center + Math.cos(angle) * distance,
      y: center + Math.sin(angle) * distance,
    };
  };

  const gridPolygons = [0.2, 0.4, 0.6, 0.8, 1].map((scale) =>
    chartDimensions
      .map((_, index) => {
        const angle = angleFor(index);
        return `${center + Math.cos(angle) * radius * scale},${center + Math.sin(angle) * radius * scale}`;
      })
      .join(" "),
  );
  const dataPoints = chartDimensions.map((dimension, index) => pointFor(index, dimension.score));
  const polygon = dataPoints.map((point) => `${point.x},${point.y}`).join(" ");

  return (
    <svg viewBox="0 0 220 220" role="img" aria-label="最高风险会话六维雷达图" className="h-full w-full">
      {gridPolygons.map((points) => (
        <polygon key={points} points={points} fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="1" />
      ))}
      {chartDimensions.map((dimension, index) => {
        const edge = pointFor(index, maxScore);
        const angle = angleFor(index);
        const labelX = center + Math.cos(angle) * (radius + 23);
        const labelY = center + Math.sin(angle) * (radius + 23);
        return (
          <g key={dimension.dimensionCode}>
            <line x1={center} y1={center} x2={edge.x} y2={edge.y} stroke="rgba(255,255,255,0.1)" />
            <text
              x={labelX}
              y={labelY}
              textAnchor={Math.abs(Math.cos(angle)) < 0.25 ? "middle" : Math.cos(angle) > 0 ? "start" : "end"}
              dominantBaseline="middle"
              fill="#a1a1aa"
              fontSize="9"
            >
              {dimension.dimensionName}
            </text>
          </g>
        );
      })}
      <polygon points={polygon} fill="rgba(251,113,133,0.22)" stroke="#fb7185" strokeWidth="2" />
      {dataPoints.map((point, index) => (
        <circle key={chartDimensions[index].dimensionCode} cx={point.x} cy={point.y} r="3.5" fill="#fecdd3">
          <title>
            {chartDimensions[index].dimensionName}: {chartDimensions[index].score}
          </title>
        </circle>
      ))}
    </svg>
  );
}

function HighestRiskPanel({ session }: { session?: SecurityHighestRiskSession | null }) {
  const hasSession = Boolean(session?.sessionId);
  const tone = riskTone(session?.riskLevel);

  return (
    <Panel
      title="风险最高会话"
      icon={TerminalSquare}
      action={hasSession ? <StatusPill level={session?.riskLevel} label={session?.riskLevelText} /> : null}
    >
      {hasSession && session ? (
        <div className="grid gap-3 p-4 md:grid-cols-[190px_minmax(0,1fr)]">
          <div className="h-[220px]">
            <RadarChart dimensions={session.riskDimensions ?? []} />
          </div>
          <div className="min-w-0 space-y-3">
            <div>
              <p className="text-xs text-zinc-500">综合风险评分</p>
              <p className={cn("mt-1 text-4xl font-semibold leading-none", tone.text)}>
                {formatNumber(session.compositeScore, { maximumFractionDigits: 1 })}
              </p>
            </div>
            <div className="space-y-2 text-xs">
              <InfoRow label="会话" value={session.sessionId} />
              <InfoRow label="用户" value={session.userId} />
              <InfoRow label="工作区" value={session.workspacePath} />
              <InfoRow label="最后事件" value={formatDate(session.lastEventTime)} />
            </div>
            <Button asChild size="sm" className="h-8 bg-rose-400 text-[#16080b] hover:bg-rose-300">
              <a href="#">打开会话</a>
            </Button>
          </div>
        </div>
      ) : (
        <EmptyState label="暂无风险会话" />
      )}
    </Panel>
  );
}

function InfoRow({ label, value }: { label: string; value?: string }) {
  return (
    <div className="grid grid-cols-[64px_minmax(0,1fr)] gap-3">
      <span className="text-zinc-600">{label}</span>
      <span className="truncate text-zinc-300" title={value}>
        {value || "--"}
      </span>
    </div>
  );
}

// Map a funnel tier to the policy tier it represents (l2/l3), so we can gate it
// against the configured status. L1 and the final-block row are never gated.
// Always-on strip showing which judge tiers are configured — makes the config page's effect on the
// dashboard immediate + obvious (a tier flips 未配置 → 已启用 the moment you save + come back).
function TierStatusStrip({ status }: { status?: PolicyStatus | null }) {
  const tiers: Array<{ key: keyof PolicyStatus; label: string }> = [
    { key: "l1", label: "L1 规则" },
    { key: "l2", label: "L2 LLM 研判" },
    { key: "l3", label: "L3 深判" },
  ];
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-[10px] border border-white/10 bg-[#111612]/80 px-4 py-2.5">
      <span className="mr-1 text-xs font-medium text-zinc-400">研判层级</span>
      {tiers.map(({ key, label }) => {
        const on = Boolean(status?.[key]);
        return (
          <span
            key={key}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs",
              on ? "border-teal-400/30 bg-teal-400/10 text-teal-200" : "border-white/10 bg-white/[0.03] text-zinc-500",
            )}
          >
            <span className={cn("size-1.5 rounded-full", on ? "bg-teal-400" : "bg-zinc-600")} />
            {label}
            <span className="text-[10px] opacity-70">{on ? "已启用" : "未配置"}</span>
          </span>
        );
      })}
      <Link to="/admin/policy" className="ml-auto text-xs text-teal-300 hover:text-teal-200">
        配置 →
      </Link>
    </div>
  );
}

function funnelTierKey(tier: SecurityDecisionTier): "l2" | "l3" | null {
  const code = `${tier.tierCode ?? ""} ${tier.tierName ?? ""}`.toLowerCase();
  if (code.includes("l3")) return "l3";
  if (code.includes("l2")) return "l2";
  return null;
}

function DecisionFunnelPanel({
  funnel,
  status,
}: {
  funnel?: SecurityDecisionFunnel | null;
  status?: PolicyStatus | null;
}) {
  const tiers = funnel?.tiers ?? [];

  return (
    <Panel title="决策层级漏斗" icon={Layers3}>
      {tiers.length === 0 && !funnel?.finalBlock ? (
        <EmptyState label="暂无决策漏斗数据" />
      ) : (
        <div className="space-y-3 p-4">
          {tiers.map((tier, index) => {
            const percent = normalizePercent(tier.percentage);
            // Gate L2/L3 rows by configured status: hide when status is known and
            // the tier is off; L1 and unrecognized tiers always render.
            const tierKey = funnelTierKey(tier);
            const unconfigured = Boolean(status && tierKey && !status[tierKey]);
            if (unconfigured) {
              return (
                <div key={tier.tierCode} className="space-y-1.5 opacity-60">
                  <div className="flex items-center justify-between gap-3 text-xs">
                    <span className="min-w-0 truncate font-semibold text-zinc-400">
                      {tier.tierCode} · {tier.tierName}
                    </span>
                    <span className="shrink-0 rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] text-zinc-500">
                      未配置
                    </span>
                  </div>
                  <div className="relative h-8 overflow-hidden rounded-md border border-dashed border-white/10 bg-white/[0.03]" />
                </div>
              );
            }
            return (
              <div key={tier.tierCode} className="space-y-1.5">
                <div className="flex items-center justify-between gap-3 text-xs">
                  <span className="min-w-0 truncate font-semibold text-zinc-200">
                    {tier.tierCode} · {tier.tierName}
                  </span>
                  <span className="shrink-0 tabular-nums text-zinc-400">
                    {formatCompactNumber(tier.count)} / {formatPercent(tier.percentage)}
                  </span>
                </div>
                <div className="relative h-8 overflow-hidden rounded-md bg-white/8">
                  <div
                    className="flex h-full items-center justify-between rounded-md px-3 text-[11px] font-semibold text-[#06100c] transition-[width] duration-500"
                    style={{
                      width: `${Math.max(12, percent)}%`,
                      backgroundColor: funnelColors[index % funnelColors.length],
                    }}
                  >
                    <span className="truncate">{tier.slaDesc}</span>
                  </div>
                </div>
              </div>
            );
          })}
          <div className="mt-4 rounded-md border border-rose-300/20 bg-rose-400/10 px-3 py-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-semibold text-rose-100">最终阻断</span>
              <span className="text-sm font-semibold text-rose-100">
                {formatCompactNumber(funnel?.finalBlock?.count)} · {formatPercent(funnel?.finalBlock?.percentage)}
              </span>
            </div>
          </div>
        </div>
      )}
    </Panel>
  );
}

function shortId(value?: string) {
  if (!value) return "--";
  return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

function eventDetailHref(event: AgentEventListItem) {
  const qs = new URLSearchParams({
    eventId: event.eventId,
    traceId: event.traceId,
    timeType: "last_3h",
  });
  return `/events?${qs.toString()}`;
}

function EventCellPill({ event }: { event: AgentEventListItem }) {
  const tone = riskTone(severityLevel(event.severity));
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold", tone.bg, tone.border, tone.text)}>
      <span className={cn("size-1.5 rounded-full", tone.dot)} />
      {EVENT_CATEGORY_LABEL[event.eventCategory] ?? event.eventCategory}
    </span>
  );
}

function VerdictPill({ verdict }: { verdict: SecurityVerdict }) {
  const tone = riskTone(verdictLevel(verdict));
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold", tone.bg, tone.border, tone.text)}>
      <span className={cn("size-1.5 rounded-full", tone.dot)} />
      {VERDICT_LABEL[verdict] ?? verdict}
    </span>
  );
}

function AgentEventTimelinePanel({ events, error }: { events?: AgentEventList | null; error?: string }) {
  const items = events?.items ?? [];

  return (
    <Panel
      title="无侵入事件时间线"
      icon={GitBranch}
      action={
        <div className="flex items-center gap-3">
          <span className="text-xs text-zinc-500">{events ? `${formatNumber(events.total)} 条` : "--"}</span>
          <Link to="/events" className="text-xs text-teal-300 hover:text-teal-200">查看全部</Link>
        </div>
      }
    >
      <div className="space-y-3 p-4">
        <InlineError message={error} />
        {items.length === 0 ? (
          <EmptyState label="暂无事件明细" />
        ) : (
          <div className="overflow-x-auto">
            <div className="grid min-w-[980px] grid-cols-[96px_88px_minmax(240px,1.4fr)_minmax(150px,0.9fr)_minmax(150px,0.9fr)_82px_76px] gap-3 border-b border-white/10 pb-2 text-xs text-zinc-500">
              <span>时间</span>
              <span>类型</span>
              <span>事件</span>
              <span>智能体 / 会话</span>
              <span>Trace / Span</span>
              <span className="text-right">风险</span>
              <span className="text-center">处置</span>
            </div>
            <div className="min-w-[980px] divide-y divide-white/8">
              {items.map((event) => (
                <Link
                  key={event.eventId}
                  to={eventDetailHref(event)}
                  className="grid grid-cols-[96px_88px_minmax(240px,1.4fr)_minmax(150px,0.9fr)_minmax(150px,0.9fr)_82px_76px] items-center gap-3 py-3 text-sm"
                >
                  <span className="font-mono text-xs text-zinc-500">{formatDate(event.at)}</span>
                  <span className="flex min-w-0">
                    <EventCellPill event={event} />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate font-medium text-zinc-100" title={event.subject}>
                      {event.subject}
                    </p>
                    <p className="mt-0.5 truncate text-[11px] text-zinc-600" title={event.reason}>
                      {event.eventKind} · {riskEventName(event.riskCategory)} · {event.source}
                    </p>
                  </div>
                  <div className="min-w-0 font-mono text-xs">
                    <p className="truncate text-zinc-300" title={event.agentId}>{event.agentId}</p>
                    <p className="mt-0.5 truncate text-zinc-600" title={event.sessionId}>{event.sessionId}</p>
                  </div>
                  <div className="min-w-0 font-mono text-xs">
                    <p className="truncate text-zinc-300" title={event.traceId}>{shortId(event.traceId)}</p>
                    <p className="mt-0.5 truncate text-zinc-600" title={event.spanId}>{shortId(event.spanId)}</p>
                  </div>
                  <span className="text-right font-mono text-sm font-semibold tabular-nums text-zinc-100">
                    {formatNumber(event.riskScore, { maximumFractionDigits: 0 })}
                  </span>
                  <span className="flex justify-center">
                    <VerdictPill verdict={event.verdict} />
                  </span>
                </Link>
              ))}
            </div>
          </div>
        )}
      </div>
    </Panel>
  );
}

function WorkspaceRiskPanel({ workspaceRisk }: { workspaceRisk?: SecurityWorkspaceRiskDistribution | null }) {
  const list = workspaceRisk?.list ?? [];

  return (
    <Panel title="工作区风险分布" icon={Bot}>
      {list.length === 0 ? (
        <EmptyState label="暂无工作区风险数据" />
      ) : (
        <div className="max-h-[420px] overflow-y-auto p-4">
          <div className="grid min-w-[640px] grid-cols-[minmax(220px,1fr)_110px_120px_110px] gap-3 border-b border-white/10 pb-2 text-xs text-zinc-500">
            <span>工作区</span>
            <span className="text-right">会话数</span>
            <span className="text-right">累计风险</span>
            <span className="text-right">等级</span>
          </div>
          <div className="min-w-[640px] divide-y divide-white/8">
            {list.map((item) => (
              <div
                key={item.workspacePath}
                className="grid grid-cols-[minmax(220px,1fr)_110px_120px_110px] items-center gap-3 py-3 text-sm"
              >
                <span className="truncate font-medium text-zinc-200" title={item.workspacePath}>
                  {item.workspacePath}
                </span>
                <span className="text-right tabular-nums text-zinc-400">{formatNumber(item.sessionCount)}</span>
                <span className="text-right tabular-nums text-zinc-100">
                  {formatNumber(item.totalRiskScore, { maximumFractionDigits: 1 })}
                </span>
                <span className="flex justify-end">
                  <StatusPill level={item.riskLevel} label={item.riskLevelText} />
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Panel>
  );
}

export default function SecurityMonitorPage() {
  const [filter, setFilter] = useState<SecurityTimeFilter>(DEFAULT_FILTER);
  const [customStart, setCustomStart] = useState(() => dayjs().subtract(1, "day").format("YYYY-MM-DD"));
  const [customEnd, setCustomEnd] = useState(() => dayjs().format("YYYY-MM-DD"));
  const [observability, setObservability] = useState<AgentObservability | null>(null);
  const [observabilityConnected, setObservabilityConnected] = useState(false);

  const customError = useMemo(() => {
    if (filter.timeType !== "custom") return undefined;
    if (!customStart || !customEnd) return "请选择开始和结束日期";
    if (dayjs(customEnd).isBefore(dayjs(customStart), "day")) return "结束日期不能早于开始日期";
    if (dayjs(customEnd).isAfter(dayjs(), "day")) return "结束日期不能晚于今天";
    return undefined;
  }, [customEnd, customStart, filter.timeType]);

  const requestFilter = useMemo(() => filter, [filter]);
  const { data, loading, refresh } = useRequest(() => loadSecurityDashboardData(requestFilter), {
    refreshDeps: [requestFilter],
    pollingInterval: 10000,
    pollingWhenHidden: false,
  });
  useEffect(() => {
    const controller = new AbortController();
    setObservability(null);
    setObservabilityConnected(false);
    streamAgentObservability(
      requestFilter,
      (next) => {
        setObservability(next);
        setObservabilityConnected(true);
      },
      controller.signal,
    );
    return () => controller.abort();
  }, [requestFilter]);
  // Tier status drives conditional rendering for L2/L3 funnel rows. Polled so a
  // Save reflects without a full reload.
  const { data: policyConfig } = useRequest(() => securityCenterApi.getConfig(), {
    pollingInterval: 30000,
    pollingWhenHidden: false,
    refreshOnWindowFocus: true, // returning from the config page reflects immediately
  });
  const status = policyConfig?.status ?? null;
  const lastUpdatedAt =
    observability?.updateTime ||
    data?.scan?.updateTime ||
    data?.performance?.updateTime ||
    data?.riskSummary?.updateTime ||
    data?.riskBreakdown?.updateTime ||
    data?.highestRisk?.updateTime ||
    data?.decisionFunnel?.updateTime ||
    data?.workspaceRisk?.updateTime ||
    data?.events?.updateTime;

  const handleTimeTypeChange = (value: SecurityTimeType) => {
    if (value === "custom") {
      setFilter(buildCustomFilter(customStart, customEnd));
      return;
    }
    setFilter({ timeType: value });
  };

  const applyCustomTime = () => {
    if (customError) return;
    setFilter(buildCustomFilter(customStart, customEnd));
  };

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-[#0b0f0c] text-zinc-100">
      <SecurityHeader
        filter={filter}
        loading={loading}
        lastUpdatedAt={lastUpdatedAt}
        customStart={customStart}
        customEnd={customEnd}
        customError={customError}
        onTimeTypeChange={handleTimeTypeChange}
        onCustomStartChange={setCustomStart}
        onCustomEndChange={setCustomEnd}
        onApplyCustomTime={applyCustomTime}
        onRefresh={refresh}
      />

      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto flex w-full max-w-[1680px] flex-col gap-4">
          <TierStatusStrip status={status} />

          <DashboardSection title="运行总览" icon={Activity}>
            <div className="space-y-3">
              <TopMetrics data={data} loading={loading && !data} />
              <LiveObservabilityPanel observability={observability} connected={observabilityConnected} />
            </div>
          </DashboardSection>

          <DashboardSection title="实时扫描" icon={Radar}>
            <div className="grid gap-4 xl:grid-cols-[minmax(0,1.65fr)_minmax(360px,0.95fr)]">
              <ExplainabilityPanel scan={data?.scan} error={data?.errors.scan} />
              <DecisionFunnelPanel funnel={data?.decisionFunnel} status={status} />
            </div>
          </DashboardSection>

          <DashboardSection title="风险态势" icon={Siren}>
            <div className="space-y-4">
              <RiskSummaryPanels summary={data?.riskSummary} />
              <RiskBreakdownPanel breakdown={data?.riskBreakdown} error={data?.errors.riskBreakdown} />
            </div>
          </DashboardSection>

          <DashboardSection title="运行链路" icon={GitBranch}>
            <AgentEventTimelinePanel events={data?.events} error={data?.errors.events} />
          </DashboardSection>

          <DashboardSection title="会话与工作区" icon={TerminalSquare}>
            <div className="grid gap-4 xl:grid-cols-[minmax(360px,0.9fr)_minmax(0,1.6fr)]">
              <HighestRiskPanel session={data?.highestRisk} />
              <WorkspaceRiskPanel workspaceRisk={data?.workspaceRisk} />
            </div>
          </DashboardSection>
        </div>
      </main>
    </div>
  );
}
