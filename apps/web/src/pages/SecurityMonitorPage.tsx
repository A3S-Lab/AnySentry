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
import { AgentAssetIdentityInline, AgentIdentityInline } from "@/components/custom/agent-identity";
import { useVChartTheme } from "@/components/custom/charts/vchart-theme";
import { type VChartSpec, VChartView } from "@/components/custom/vchart";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  type AgentEventCategory,
  type AgentEventList,
  type AgentEventListItem,
  type AgentInventory,
  type AgentInventoryItem,
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
  type StreamFindingList,
  type SupplyChainOverview,
  securityCenterApi,
  streamAgentObservability,
} from "@/lib/api/security-center";
import type { PolicyStatus } from "@/lib/api/security-center";
import { settleAll } from "@/lib/settle-all";
import { cn } from "@/lib/utils";

type TimelineTierFilter = "all" | AgentEventListItem["tier"];

type SecuritySectionKey =
  | "health"
  | "scan"
  | "performance"
  | "riskSummary"
  | "riskBreakdown"
  | "highestRisk"
  | "decisionFunnel"
  | "workspaceRisk"
  | "agentInventory"
  | "streamFindings"
  | "supplyChain"
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
  agentInventory: AgentInventory | null;
  streamFindings: StreamFindingList | null;
  supplyChain: SupplyChainOverview | null;
  events: AgentEventList | null;
  errors: Partial<Record<SecuritySectionKey, string>>;
}

type TimelineScope = "agent" | "raw";

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

async function loadSecurityDashboardData(filter: SecurityTimeFilter, timelineScope: TimelineScope, timelineTier: TimelineTierFilter, timelineIncludeUnknown: boolean, riskBreakdownScope: TimelineScope, decisionFunnelScope: TimelineScope, workspaceRiskScope: TimelineScope): Promise<SecurityDashboardData> {
  const scanFilter = { ...filter, seriesPoints: 36 };
  const { data, errors } = await settleAll(
    {
      health: securityCenterApi.healthCard(filter),
      scan: securityCenterApi.explainabilityScan(scanFilter),
      performance: securityCenterApi.performanceCard(filter),
      riskSummary: securityCenterApi.riskSummary(filter),
      riskBreakdown: securityCenterApi.riskBreakdown({ ...filter, scope: riskBreakdownScope }),
      highestRisk: securityCenterApi.highestRiskSession(filter),
      decisionFunnel: securityCenterApi.decisionFunnel({ ...filter, scope: decisionFunnelScope }),
      workspaceRisk: securityCenterApi.workspaceRiskDistribution({ ...filter, scope: workspaceRiskScope }),
      agentInventory: securityCenterApi.agentInventory({ ...filter, limit: 32 }),
      streamFindings: securityCenterApi.streamFindings({ ...filter, limit: 30 }),
      supplyChain: securityCenterApi.supplyChainOverview(500),
      events: securityCenterApi.agentEvents({ ...filter, scope: timelineScope, includeUnknown: timelineIncludeUnknown, ...(timelineTier === "all" ? {} : { tier: timelineTier }), limit: 36 }),
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
    agentInventory: data.agentInventory,
    streamFindings: data.streamFindings,
    supplyChain: data.supplyChain,
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
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? value.replace(" ", "T") + "Z" : value;
  const parsed = dayjs(normalized);
  return parsed.isValid() ? parsed.format("MM-DD HH:mm:ss") : value;
}

function formatTimeLabel(value?: string) {
  if (!value) return "";
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? value.replace(" ", "T") + "Z" : value;
  const parsed = dayjs(normalized);
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

function RiskBreakdownPanel({
  breakdown,
  error,
  scope,
  onScopeChange,
}: {
  breakdown?: SecurityRiskBreakdown | null;
  error?: string;
  scope: TimelineScope;
  onScopeChange: (value: TimelineScope) => void;
}) {
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
      action={
        <div className="flex items-center gap-3">
          <TimelineScopeTabs value={scope} onChange={onScopeChange} />
          <span className="text-xs text-zinc-500">{data.updateTime ? formatDate(data.updateTime) : "--"}</span>
        </div>
      }
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

const STREAM_FEATURE_LABELS: Record<string, string> = {
  toolExecCount1m: "工具调用 / 1分钟",
  dangerousCommandCount1m: "危险命令 / 1分钟",
  failedCount1m: "执行失败 / 1分钟",
  sensitiveFileCount5m: "敏感文件 / 5分钟",
  transformCount5m: "编码压缩 / 5分钟",
  externalEgressCount5m: "外部连接 / 5分钟",
  distinctSessionCount5m: "活跃会话 / 5分钟",
  distinctDestinationCount5m: "外联目标 / 5分钟",
};

const STREAM_RULE_LABELS: Record<string, string> = {
  "high-command-rate": "高频工具调用",
  "repeated-dangerous-command": "重复危险命令",
  "sensitive-access-with-egress": "敏感访问伴随外联",
  "continued-after-block": "阻断后持续尝试",
};

const STREAM_OPERATION_LABELS: Record<string, string> = {
  file_read: "读取敏感文件",
  file_write: "写入文件",
  encode: "编码数据",
  compress: "压缩数据",
  copy: "复制数据",
  egress: "建立外部连接",
  execute: "执行命令",
  observe: "观测事件",
};

function cvssExplanation(vector?: string) {
  if (!vector) {
    return {
      attackCondition: "OSV 未提供结构化攻击条件",
      impact: "需结合漏洞说明人工确认影响",
    };
  }
  const metrics = Object.fromEntries(vector.split("/").slice(1).map((part) => part.split(":")));
  const access = {
    N: "可通过网络触发",
    A: "需相邻网络",
    L: "需本地访问",
    P: "需物理访问",
  }[metrics.AV] ?? "攻击入口未知";
  const privilege = {
    N: "无需预先权限",
    L: "需要低权限",
    H: "需要高权限",
  }[metrics.PR] ?? "权限条件未知";
  const interaction = metrics.UI === "N" ? "无需用户交互" : metrics.UI === "R" ? "需要用户交互" : "交互条件未知";
  const impactParts = [
    metrics.C === "H" ? "机密性高影响" : metrics.C === "L" ? "机密性低影响" : "",
    metrics.I === "H" ? "完整性高影响" : metrics.I === "L" ? "完整性低影响" : "",
    metrics.A === "H" ? "可用性高影响" : metrics.A === "L" ? "可用性低影响" : "",
  ].filter(Boolean);
  return {
    attackCondition: `${access} · ${privilege} · ${interaction}`,
    impact: impactParts.length > 0 ? impactParts.join(" · ") : "CVSS 未标记机密性、完整性或可用性影响",
  };
}

function SupplyChainPanel({
  overview,
  streamFindings,
  error,
}: {
  overview?: SupplyChainOverview | null;
  streamFindings?: StreamFindingList | null;
  error?: string;
}) {
  const [showAll, setShowAll] = useState(false);
  const findings = useMemo(() => {
    const runtimeEvidence = new Map<string, "observed" | "attack_chain">();
    for (const judgment of streamFindings?.compositeJudgments ?? []) {
      const attackChain = judgment.ruleVersion === "supply-chain-exploit-v1"
        && (judgment.classification === "suspicious" || judgment.classification === "confirmed_attack");
      for (const evidence of judgment.evidence) {
        for (const vulnerability of evidence.runtimeVulnerabilities ?? []) {
          const existing = runtimeEvidence.get(vulnerability.findingId);
          runtimeEvidence.set(
            vulnerability.findingId,
            attackChain || existing === "attack_chain" ? "attack_chain" : "observed",
          );
        }
      }
    }
    return (overview?.findings ?? []).map((finding) => {
      const exploitability = runtimeEvidence.get(finding.findingId) ?? "not_observed";
      const score = Math.min(
        100,
        finding.priorityScore + (exploitability === "attack_chain" ? 15 : exploitability === "observed" ? 5 : 0),
      );
      return {
        finding,
        exploitability,
        priorityScore: score,
        priority: score >= 90 ? "P0" : score >= 60 ? "P1" : score >= 35 ? "P2" : "P3",
      };
    }).sort((left, right) => (
      right.priorityScore - left.priorityScore
      || right.finding.lastObservedAt - left.finding.lastObservedAt
    ));
  }, [overview?.findings, streamFindings?.compositeJudgments]);
  if (!overview?.enabled) return null;
  const visibleFindings = showAll ? findings : findings.slice(0, 4);
  const severityLabel = {
    critical: "严重",
    high: "高危",
    medium: "中危",
    low: "低危",
    unknown: "未知",
  };
  return (
    <Panel
      title="OSV 依赖漏洞资产"
      icon={ShieldAlert}
      action={(
        <div className="flex flex-wrap items-center gap-2">
          {overview.runtimeCorrelationEnabled && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-teal-400/30 bg-teal-400/10 px-2.5 py-1 text-[11px] text-teal-200">
              <GitBranch className="size-3" />
              运行时关联已启用
            </span>
          )}
          <span className="inline-flex items-center gap-1.5 rounded-full border border-sky-400/30 bg-sky-400/10 px-2.5 py-1 text-[11px] text-sky-200">
            <EyeOff className="size-3" />
            治理提醒 · 不代表漏洞正在被利用
          </span>
        </div>
      )}
    >
      <div className="space-y-4 p-4">
        <InlineError message={error} />
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {[
            { label: "可信 Workspace", value: overview.workspaces, detail: "按节点工作副本注册" },
            { label: "有效依赖快照", value: overview.activeSnapshots, detail: "仅完整提取可生效" },
            { label: "开放漏洞", value: overview.openFindings, detail: "漏洞治理提醒" },
            {
              label: "情报状态异常",
              value: overview.staleFindings,
              detail: overview.latestAssessmentAt
                ? `最近评估 ${dayjs(overview.latestAssessmentAt).format("MM-DD HH:mm")}`
                : "尚未完成评估",
            },
          ].map((item) => (
            <div key={item.label} className="rounded-md border border-white/10 bg-white/[0.025] px-3 py-2.5">
              <p className="text-[11px] text-zinc-500">{item.label}</p>
              <p className="mt-1 text-lg font-semibold tabular-nums text-zinc-100">{item.value}</p>
              <p className="mt-0.5 text-[10px] text-zinc-600">{item.detail}</p>
            </div>
          ))}
        </div>
        {findings.length === 0 ? (
          <EmptyState label="当前组件快照未发现已知漏洞" />
        ) : (
          <>
            <div className="grid gap-3 xl:grid-cols-2">
            {visibleFindings.map(({ finding, exploitability, priority, priorityScore }) => {
              const stale = finding.status === "assessment_stale";
              const deployed = finding.deploymentStatus === "confirmed";
              const image = finding.component.deploymentImages?.[0];
              const installedEnvironment = finding.component.installedEnvironments?.[0];
              const cvss = cvssExplanation(finding.vulnerability.cvssVector);
              return (
                <div
                  key={finding.findingId}
                  className={cn(
                    "rounded-lg border bg-white/[0.025] p-4",
                    stale ? "border-amber-400/25" : "border-rose-400/25",
                  )}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-zinc-100">
                        {finding.component.packageName} · {finding.component.version}
                      </p>
                      <p className="mt-1 truncate text-[11px] text-zinc-500">
                        {finding.component.ecosystem} · {finding.component.relativeSourcePath}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <span className={cn(
                        "rounded-full border px-2 py-1 text-[10px] font-semibold",
                        priority === "P0" || priority === "P1"
                          ? "border-rose-400/30 bg-rose-400/10 text-rose-200"
                          : priority === "P2"
                            ? "border-amber-400/30 bg-amber-400/10 text-amber-200"
                            : "border-zinc-500/30 bg-zinc-500/10 text-zinc-300",
                      )}>
                        {priority} · {priorityScore}
                      </span>
                      <span className={cn(
                        "rounded-full border px-2 py-1 text-[10px]",
                        stale
                          ? "border-amber-400/25 bg-amber-400/10 text-amber-200"
                          : "border-rose-400/25 bg-rose-400/10 text-rose-200",
                      )}>
                        {stale ? "情报待刷新" : "存在已知漏洞"}
                      </span>
                    </div>
                  </div>
                  <div className="mt-3 rounded-md border border-white/[0.07] bg-black/20 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <a
                        href={`https://osv.dev/vulnerability/${encodeURIComponent(finding.vulnerability.id)}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs font-medium text-sky-300 hover:text-sky-200"
                      >
                        {finding.vulnerability.id}
                      </a>
                      <span className="text-[10px] text-zinc-600">
                        {finding.component.direct === true ? "直接依赖" : finding.component.direct === false ? "传递依赖" : "依赖层级未知"}
                      </span>
                    </div>
                    <div className="mt-3 rounded-md border border-white/[0.06] bg-white/[0.02] p-2.5">
                      <p className="text-[10px] font-medium text-zinc-500">漏洞原因与影响</p>
                      <p className="mt-1.5 line-clamp-4 text-xs leading-5 text-zinc-300">
                        {finding.vulnerability.impactDescription
                          || finding.vulnerability.summary
                          || "OSV 未提供漏洞原因说明"}
                      </p>
                      <div className="mt-2 grid gap-1 text-[10px] text-zinc-500">
                        <p><span className="text-zinc-600">攻击条件：</span>{cvss.attackCondition}</p>
                        <p><span className="text-zinc-600">安全影响：</span>{cvss.impact}</p>
                      </div>
                    </div>
                    {finding.vulnerability.aliases.length > 0 && (
                      <p className="mt-2 truncate text-[10px] text-zinc-600">
                        别名 {finding.vulnerability.aliases.join(" · ")}
                      </p>
                    )}
                    <div className="mt-3 grid gap-2 border-t border-white/[0.07] pt-3 sm:grid-cols-2">
                      <div>
                        <p className="text-[10px] text-zinc-600">厂商严重度 / CVSS</p>
                        <p className="mt-1 text-[11px] text-zinc-300">
                          {severityLabel[finding.vulnerability.severityLevel ?? "unknown"]}
                          {finding.vulnerability.cvssScore !== undefined
                            ? ` · ${finding.vulnerability.cvssScore.toFixed(1)}`
                            : " · 暂无数值"}
                        </p>
                        {finding.vulnerability.vendorSeveritySource && (
                          <p className="mt-1 text-[9px] text-zinc-600">
                            {finding.vulnerability.vendorSeveritySource} 评级
                          </p>
                        )}
                        {finding.vulnerability.cvssVector && (
                          <p className="mt-1 truncate text-[9px] text-zinc-600" title={finding.vulnerability.cvssVector}>
                            {finding.vulnerability.cvssVector}
                          </p>
                        )}
                      </div>
                      <div>
                        <p className="text-[10px] text-zinc-600">可用修复版本</p>
                        <p className="mt-1 truncate text-[11px] text-zinc-300">
                          {finding.vulnerability.fixedVersions?.length
                            ? finding.vulnerability.fixedVersions.slice(0, 3).join(" · ")
                            : "OSV 未提供明确修复版本"}
                        </p>
                      </div>
                      <div>
                        <p className="text-[10px] text-zinc-600">实际部署</p>
                        <p className={cn("mt-1 text-[11px]", deployed ? "text-teal-200" : "text-zinc-400")}>
                          {image
                            ? "镜像内已确认"
                            : installedEnvironment
                              ? installedEnvironment.kind === "python_environment"
                                ? "Workspace Python 环境已安装"
                                : "Workspace node_modules 已安装"
                              : "源码存在 · 部署状态未知"}
                        </p>
                        {image && (
                          <p className="mt-1 truncate text-[9px] text-zinc-600" title={image.reference}>
                            {image.reference}
                          </p>
                        )}
                        {!image && installedEnvironment && (
                          <p className="mt-1 truncate text-[9px] text-zinc-600" title={installedEnvironment.relativePath}>
                            {installedEnvironment.relativePath}
                          </p>
                        )}
                      </div>
                      <div>
                        <p className="text-[10px] text-zinc-600">运行时可利用性</p>
                        <p className={cn(
                          "mt-1 text-[11px]",
                          exploitability === "attack_chain"
                            ? "text-rose-200"
                            : exploitability === "observed" ? "text-amber-200" : "text-zinc-400",
                        )}>
                          {exploitability === "attack_chain"
                            ? "已形成疑似利用链"
                            : exploitability === "observed"
                              ? "已观察到组件运行证据"
                              : "尚未观察到运行证据"}
                        </p>
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-3 border-t border-white/[0.07] pt-3 text-[10px] text-zinc-600">
                    <span>Workspace {finding.workspaceId}</span>
                    <span>评估 {dayjs(finding.lastObservedAt).format("MM-DD HH:mm")}</span>
                  </div>
                </div>
              );
            })}
            </div>
            {findings.length > 4 && (
              <div className="flex justify-center">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setShowAll((value) => !value)}
                  className="border-white/10 bg-white/[0.025] text-xs text-zinc-300 hover:bg-white/[0.06]"
                >
                  {showAll ? "收起漏洞" : `显示全部漏洞（${findings.length}）`}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </Panel>
  );
}

type AgentRiskView = "assets" | "window";
type StreamPanelTab = "profiles" | "composites" | "runtime";

const AGENT_CLASSIFICATION_ORDER: Record<AgentInventoryItem["classification"], number> = {
  confirmed_agent: 0,
  probable_agent: 1,
  unknown: 2,
  non_agent: 3,
};

const AGENT_RISK_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  safe: 4,
  unknown: 5,
};

function agentActivityLabel(value: string): string {
  const timestamp = dayjs(value);
  if (!timestamp.isValid()) return "时间未知";
  const minutes = Math.max(0, dayjs().diff(timestamp, "minute"));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function agentAssetHref(agent: AgentInventoryItem, filter: SecurityTimeFilter): string {
  const query = new URLSearchParams({
    timeType: filter.timeType ?? "last_3h",
    agentId: agent.agentId,
    agentAssetId: agent.agentAssetId,
    workspacePath: agent.workspacePath,
  });
  if (filter.startTime) query.set("startTime", filter.startTime);
  if (filter.endTime) query.set("endTime", filter.endTime);
  return `/agents?${query.toString()}`;
}

function allAgentsHref(filter: SecurityTimeFilter): string {
  const query = new URLSearchParams({ timeType: filter.timeType ?? "last_3h" });
  if (filter.startTime) query.set("startTime", filter.startTime);
  if (filter.endTime) query.set("endTime", filter.endTime);
  return `/agents?${query.toString()}`;
}

function AgentOverviewCard({ agent, filter }: { agent: AgentInventoryItem; filter: SecurityTimeFilter }) {
  const tone = riskTone(agent.riskLevel);
  return (
    <Link
      to={agentAssetHref(agent, filter)}
      className={cn(
        "group flex min-h-[190px] flex-col rounded-lg border bg-white/[0.025] p-3.5 transition hover:-translate-y-0.5 hover:bg-white/[0.045] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-300/60",
        tone.border,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <AgentAssetIdentityInline agent={agent} showClassification className="min-w-0" />
        <StatusPill level={agent.riskLevel} label={agent.riskLevelText} />
      </div>

      <div className="mt-3 grid grid-cols-3 gap-1.5">
        {[
          { label: "事件", value: agent.eventCount },
          { label: "风险事件", value: agent.riskyEventCount },
          { label: "待处理风险", value: agent.openIncidentCount },
        ].map((item) => (
          <div key={item.label} className="rounded-md border border-white/[0.07] bg-black/15 px-2 py-2">
            <p className="truncate text-[9px] text-zinc-600">{item.label}</p>
            <p className="mt-0.5 text-sm font-semibold tabular-nums text-zinc-200">{formatNumber(item.value)}</p>
          </div>
        ))}
      </div>

      <div className="mt-3 min-h-10 rounded-md border border-white/[0.07] bg-black/15 px-2.5 py-2">
        <p className="text-[9px] text-zinc-600">{agent.riskyEventCount > 0 ? "最近风险" : "最近活动"}</p>
        <p className="mt-0.5 line-clamp-1 text-[11px] text-zinc-400" title={agent.lastEventSubject || "暂无活动摘要"}>
          {agent.lastEventSubject || "暂无活动摘要"}
        </p>
      </div>

      <div className="mt-auto flex items-center justify-between gap-3 pt-3 text-[10px] text-zinc-600">
        <span>最近活动 {agentActivityLabel(agent.lastSeen)}</span>
        <span className="font-medium text-teal-300 transition group-hover:text-teal-200">查看详情 →</span>
      </div>
    </Link>
  );
}

function streamWorkspacePath(value: string): string {
  const path = value.trim();
  return !path || path.toLowerCase().startsWith("agent://") ? "" : path.replace(new RegExp("/+$"), "");
}

function streamWorkspaceName(path: string): string {
  if (!path) return "未归属 Workspace";
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

function streamProfileKey(profile: StreamFindingList["riskProfiles"][number]): string {
  return [profile.environmentId, profile.agentType, streamWorkspacePath(profile.workspacePath) || "unassigned"].join(":");
}

function streamFeatureValue(features: Record<string, number>, key: string): number {
  return Math.max(0, Number(features[key]) || 0);
}

function streamScoreContributions(profile: StreamFindingList["riskProfiles"][number]) {
  const weighted = [
    ["dangerousCommandCount1m", 5, 25],
    ["sensitiveFileCount5m", 10, 25],
    ["externalEgressCount5m", 8, 20],
    ["transformCount5m", 5, 15],
  ] as const;
  const contributions = weighted.map(([key, weight, cap]) => ({
    key,
    label: STREAM_FEATURE_LABELS[key],
    value: streamFeatureValue(profile.features, key),
    score: Math.min(cap, streamFeatureValue(profile.features, key) * weight),
  }));
  const toolExecCount = streamFeatureValue(profile.features, "toolExecCount1m");
  const failedCount = streamFeatureValue(profile.features, "failedCount1m");
  if (toolExecCount >= 20) contributions.push({ key: "toolExecCount1m", label: STREAM_FEATURE_LABELS.toolExecCount1m, value: toolExecCount, score: 10 });
  if (failedCount >= 5) contributions.push({ key: "failedCount1m", label: STREAM_FEATURE_LABELS.failedCount1m, value: failedCount, score: 5 });
  return contributions.filter((item) => item.score > 0).sort((a, b) => b.score - a.score);
}

function AgentRiskOverviewPanel({
  inventory,
  findings,
  inventoryError,
  findingsError,
  filter,
}: {
  inventory?: AgentInventory | null;
  findings?: StreamFindingList | null;
  inventoryError?: string;
  findingsError?: string;
  filter: SecurityTimeFilter;
}) {
  const [view, setView] = useState<AgentRiskView>("assets");
  const [tab, setTab] = useState<StreamPanelTab>("profiles");
  const [showSafe, setShowSafe] = useState(false);
  const [visibleAgentCount, setVisibleAgentCount] = useState(8);
  const agentAssets = useMemo(() => (inventory?.items ?? [])
    .filter((agent) => agent.classification === "confirmed_agent" || agent.classification === "probable_agent")
    .sort((a, b) =>
      AGENT_CLASSIFICATION_ORDER[a.classification] - AGENT_CLASSIFICATION_ORDER[b.classification]
      || (AGENT_RISK_ORDER[a.riskLevel] ?? 6) - (AGENT_RISK_ORDER[b.riskLevel] ?? 6)
      || b.openIncidentCount - a.openIncidentCount
      || b.riskyEventCount - a.riskyEventCount
      || dayjs(b.lastSeen).valueOf() - dayjs(a.lastSeen).valueOf()), [inventory?.items]);
  const visibleAgentAssets = agentAssets.slice(0, visibleAgentCount);
  const agentAssetTotal = inventory?.summary.totalAgents ?? agentAssets.length;
  const profileViews = useMemo(() => {
    const groups = new Map<string, StreamFindingList["riskProfiles"]>();
    for (const profile of findings?.riskProfiles ?? []) {
      const key = streamProfileKey(profile);
      const history = groups.get(key) ?? [];
      history.push(profile);
      groups.set(key, history);
    }
    return [...groups.values()]
      .map((history) => {
        history.sort((a, b) => b.calculatedAt - a.calculatedAt);
        return { profile: history[0], previousScore: history[1]?.riskScore };
      })
      .filter((item): item is { profile: StreamFindingList["riskProfiles"][number]; previousScore?: number } => Boolean(item.profile))
      .sort((a, b) => Math.max(0, b.profile.riskScore) - Math.max(0, a.profile.riskScore));
  }, [findings?.riskProfiles]);
  const riskyProfiles = profileViews.filter(({ profile }) => profile.riskLevel !== "safe" || profile.riskScore > 0);
  const safeProfiles = profileViews.filter(({ profile }) => profile.riskLevel === "safe" && profile.riskScore <= 0);
  const visibleProfiles = showSafe ? profileViews : riskyProfiles;
  const compositeRisks = findings?.compositeRisks ?? [];
  const compositeJudgments = findings?.compositeJudgments ?? [];
  const syntheticEpisodes = compositeJudgments.filter((item) => item.synthetic);
  const suppressedEpisodes = compositeJudgments.filter((item) =>
    item.status === "suppressed" || item.error === "Historical episode suppressed before model evaluation");
  const visibleCompositeJudgments = compositeJudgments.filter((item) =>
    !item.synthetic && !suppressedEpisodes.includes(item));
  const blockedEpisodes = visibleCompositeJudgments.filter((item) =>
    item.status === "succeeded" && item.classification === "confirmed_attack" && item.verdict === "block");
  const failedEpisodes = visibleCompositeJudgments.filter((item) =>
    item.status === "failed" || item.status === "timeout" || item.updateStatus === "failed" || item.updateStatus === "timeout");
  const pendingEpisodes = visibleCompositeJudgments.filter((item) =>
    item.status === "pending" || item.updateStatus === "pending");
  const latestCalculatedAt = Math.max(
    0,
    ...profileViews.map(({ profile }) => profile.calculatedAt),
    ...compositeRisks.map((risk) => risk.calculatedAt),
    ...visibleCompositeJudgments.map((judgment) => judgment.updateJudgedAt ?? judgment.judgedAt),
  );
  const tabs: Array<{ key: StreamPanelTab; label: string; count?: number }> = [
    { key: "profiles", label: "风险画像", count: riskyProfiles.length },
    { key: "composites", label: "关联研判", count: visibleCompositeJudgments.length },
    { key: "runtime", label: "分析状态" },
  ];

  return (
    <Panel
      title="智能体风险概览"
      icon={Sparkles}
      action={
        <Link to={allAgentsHref(filter)} className="text-xs text-teal-300 transition hover:text-teal-200">
          查看全部智能体 →
        </Link>
      }
    >
      <div className="space-y-4 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-zinc-500">集中查看智能体身份、运行状态与近期关联风险</p>
          <div className="inline-flex rounded-md border border-white/10 bg-black/20 p-1" aria-label="智能体风险概览视角">
            {([
              { key: "assets" as const, label: "智能体资产", count: agentAssetTotal },
              { key: "window" as const, label: "时间窗分析", count: profileViews.length },
            ]).map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => setView(item.key)}
                aria-pressed={view === item.key}
                className={cn(
                  "rounded px-3 py-1.5 text-xs transition",
                  view === item.key ? "bg-teal-300/15 text-teal-100 shadow-sm" : "text-zinc-500 hover:text-zinc-300",
                )}
              >
                {item.label} · {item.count}
              </button>
            ))}
          </div>
        </div>

        {view === "assets" ? (
          <div className="space-y-4">
            <InlineError message={inventoryError} />
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              {[
                { label: "智能体", value: agentAssetTotal, detail: "已确认与候选身份" },
                { label: "活跃", value: inventory?.summary.activeAgents ?? 0, detail: "当前时间范围内有活动" },
                { label: "存在风险", value: inventory?.summary.riskyAgents ?? 0, detail: "包含风险事件" },
                { label: "待处理风险", value: inventory?.summary.openIncidentAgents ?? 0, detail: "需要进一步处置" },
              ].map((item) => (
                <div key={item.label} className="rounded-md border border-white/10 bg-white/[0.025] px-3 py-2.5">
                  <p className="text-[11px] text-zinc-500">{item.label}</p>
                  <p className="mt-1 text-lg font-semibold tabular-nums text-zinc-100">{formatNumber(item.value)}</p>
                  <p className="mt-0.5 text-[10px] text-zinc-600">{item.detail}</p>
                </div>
              ))}
            </div>

            {agentAssets.length === 0 ? (
              <EmptyState label="暂无已确认或候选智能体" />
            ) : (
              <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-4">
                {visibleAgentAssets.map((agent) => (
                  <AgentOverviewCard key={agent.agentAssetId} agent={agent} filter={filter} />
                ))}
              </div>
            )}

            <div className="flex flex-wrap items-center justify-center gap-4 border-t border-white/[0.07] pt-3">
              {agentAssets.length > 8 && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setVisibleAgentCount((count) => count >= agentAssets.length ? 8 : Math.min(agentAssets.length, count + 8))}
                  className="border-white/10 bg-white/[0.025] text-xs text-zinc-300 hover:bg-white/[0.06]"
                >
                  {visibleAgentCount >= agentAssets.length ? "收起" : `显示更多（剩余 ${agentAssets.length - visibleAgentAssets.length}）`}
                </Button>
              )}
              <Link to={allAgentsHref(filter)} className="text-xs text-teal-300 hover:text-teal-200">
                进入智能体资产 →
              </Link>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <InlineError message={findingsError} />
            <div className="flex justify-end">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-violet-400/30 bg-violet-400/10 px-2.5 py-1 text-[11px] text-violet-200">
                <EyeOff className="size-3" />
                观察模式 · 不影响系统操作
              </span>
            </div>
            {!findings?.enabled ? (
              <div className="rounded-md border border-dashed border-white/10 px-4 py-10 text-center">
                <p className="text-sm font-medium text-zinc-300">时间窗分析暂不可用</p>
                <p className="mt-1 text-xs text-zinc-600">智能体资产和常规风险检测不受影响</p>
              </div>
            ) : (
              <>
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              {[
                { label: "智能体画像", value: profileViews.length, detail: "按智能体与工作区汇总" },
                { label: "风险画像", value: riskyProfiles.length, detail: safeProfiles.length + " 个安全画像已折叠" },
                { label: "高风险关联", value: blockedEpisodes.length, detail: pendingEpisodes.length + " 条等待分析 / " + failedEpisodes.length + " 条异常" },
                { label: "最新分析", value: latestCalculatedAt ? dayjs(latestCalculatedAt).format("HH:mm:ss") : "--", detail: latestCalculatedAt ? dayjs(latestCalculatedAt).format("MM-DD") : "暂无结果" },
              ].map((item) => (
                <div key={item.label} className="rounded-md border border-white/10 bg-white/[0.025] px-3 py-2.5">
                  <p className="text-[11px] text-zinc-500">{item.label}</p>
                  <p className="mt-1 text-lg font-semibold tabular-nums text-zinc-100">{item.value}</p>
                  <p className="mt-0.5 text-[10px] text-zinc-600">{item.detail}</p>
                </div>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-1 border-b border-white/10">
              {tabs.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setTab(item.key)}
                  className={cn(
                    "border-b-2 px-3 py-2 text-xs transition-colors",
                    tab === item.key ? "border-teal-300 text-teal-200" : "border-transparent text-zinc-500 hover:text-zinc-300",
                  )}
                >
                  {item.label}{item.count === undefined ? "" : " · " + item.count}
                </button>
              ))}
            </div>

            {tab === "profiles" && (
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-zinc-100">智能体窗口画像</p>
                    <p className="mt-0.5 text-xs text-zinc-500">同名智能体通过工作区和运行环境区分，分数展示可解释贡献</p>
                  </div>
                  {safeProfiles.length > 0 && (
                    <button type="button" onClick={() => setShowSafe((value) => !value)} className="text-xs text-teal-300 hover:text-teal-200">
                      {showSafe ? "隐藏安全资产" : "显示安全资产（" + safeProfiles.length + "）"}
                    </button>
                  )}
                </div>
                {visibleProfiles.length === 0 ? (
                  <EmptyState label={safeProfiles.length ? "当前没有风险画像" : "暂无时间窗风险画像"} />
                ) : (
                  <div className="grid gap-3 xl:grid-cols-2">
                    {visibleProfiles.map(({ profile, previousScore }) => {
                      const workspacePath = streamWorkspacePath(profile.workspacePath);
                      const contributions = streamScoreContributions(profile);
                      const score = Math.max(0, profile.riskScore);
                      const delta = previousScore === undefined ? undefined : score - Math.max(0, previousScore);
                      const tone = riskTone(profile.riskLevel);
                      const query = new URLSearchParams({ agentId: profile.agentType });
                      if (workspacePath) query.set("workspacePath", workspacePath);
                      return (
                        <div key={streamProfileKey(profile)} className={cn("rounded-lg border bg-white/[0.025] p-4", tone.border)}>
                          <div className="flex items-start justify-between gap-4">
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <Bot className="size-4 text-teal-300" />
                                <p className="truncate text-sm font-semibold text-zinc-100">{profile.agentType} · {streamWorkspaceName(workspacePath)}</p>
                              </div>
                              <p className="mt-1 truncate text-[11px] text-zinc-500" title={workspacePath || "未识别工作区"}>
                                {workspacePath || "未识别工作区"}
                              </p>
                            </div>
                            <div className="text-right">
                              <div className="flex items-baseline justify-end gap-1.5">
                                <span className={cn("text-2xl font-semibold tabular-nums", tone.text)}>{formatNumber(score)}</span>
                                {delta !== undefined && delta !== 0 && <span className={cn("text-[10px]", delta > 0 ? "text-rose-300" : "text-emerald-300")}>{delta > 0 ? "+" : ""}{formatNumber(delta)}</span>}
                              </div>
                              <span className={cn("text-[10px]", tone.text)}>{tone.label}</span>
                            </div>
                          </div>

                          <div className="mt-3 rounded-md border border-white/[0.07] bg-black/20 p-3">
                            <p className="text-[11px] font-medium text-zinc-400">风险分数贡献</p>
                            {contributions.length === 0 ? (
                              <p className="mt-2 text-xs text-zinc-600">当前时间窗没有风险加分项</p>
                            ) : (
                              <div className="mt-2 space-y-1.5">
                                {contributions.slice(0, 4).map((item) => (
                                  <div key={item.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 text-[11px]">
                                    <span className="truncate text-zinc-400">{item.label} · {formatNumber(item.value)}</span>
                                    <span className="font-medium tabular-nums text-amber-200">+{formatNumber(item.score)}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>

                          <div className="mt-3 grid grid-cols-2 gap-1.5 sm:grid-cols-4">
                            {["toolExecCount1m", "dangerousCommandCount1m", "sensitiveFileCount5m", "externalEgressCount5m"].map((key) => (
                              <div key={key} className="rounded border border-white/[0.07] px-2 py-1.5">
                                <p className="truncate text-[9px] text-zinc-600">{STREAM_FEATURE_LABELS[key]}</p>
                                <p className="mt-0.5 text-xs tabular-nums text-zinc-300">{formatNumber(streamFeatureValue(profile.features, key))}</p>
                              </div>
                            ))}
                          </div>

                          <div className="mt-3 flex flex-wrap gap-1.5">
                            {profile.hitRules.length === 0 ? (
                              <span className="text-[10px] text-zinc-600">未发现关联风险</span>
                            ) : profile.hitRules.map((rule) => (
                              <span key={rule} className="rounded border border-amber-400/20 bg-amber-400/10 px-2 py-1 text-[10px] text-amber-200" title={rule}>
                                {STREAM_RULE_LABELS[rule] ?? rule}
                              </span>
                            ))}
                          </div>
                          <div className="mt-3 flex items-center justify-between gap-3 border-t border-white/[0.07] pt-3 text-[10px] text-zinc-600">
                            <span>分析时段 {dayjs(profile.windowStart).format("HH:mm:ss")} — {dayjs(profile.windowEnd).format("HH:mm:ss")}</span>
                            <Link to={"/events?" + query.toString()} className="text-teal-300 hover:text-teal-200">查看事件 →</Link>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {tab === "composites" && (
              <div className="space-y-3">
                <div>
                  <p className="text-sm font-semibold text-zinc-100">关联行为研判</p>
                  <p className="mt-0.5 text-xs text-zinc-500">系统根据一段时间内的连续行为进行关联分析，帮助识别单条事件中不明显的风险。</p>
                </div>
                {visibleCompositeJudgments.length === 0 ? (
                  <EmptyState label="当前时间窗暂无关联研判结果" />
                ) : visibleCompositeJudgments.map((judgment) => {
                  const workspacePath = streamWorkspacePath(judgment.workspacePath);
                  const query = new URLSearchParams();
                  if (judgment.traceIds[0]) query.set("traceId", judgment.traceIds[0]);
                  const blocked = judgment.status === "succeeded" && judgment.verdict === "block";
                  const failed = judgment.status === "failed" || judgment.status === "timeout";
                  const pending = judgment.status === "pending";
                  const updatePending = judgment.updateStatus === "pending";
                  const suspicious = judgment.status === "succeeded" && judgment.classification === "suspicious";
                  const border = pending ? "border-violet-400/25 bg-violet-400/[0.04]" : blocked ? "border-rose-400/25 bg-rose-400/[0.04]" : failed || suspicious ? "border-amber-400/25 bg-amber-400/[0.04]" : "border-emerald-400/20 bg-emerald-400/[0.03]";
                  const title = pending ? "等待关联研判" : failed
                    ? judgment.status === "timeout" ? "关联研判超时" : "关联研判失败"
                    : blocked ? judgment.attackType === "known-vulnerability-exploitation"
                      ? "高置信度供应链风险"
                      : judgment.attackType && judgment.attackType !== "none" ? judgment.attackType : "已确认高风险行为"
                    : judgment.classification === "suspicious" ? "发现可疑关联"
                    : judgment.classification === "authorized_admin" ? "已识别授权操作"
                    : judgment.classification === "simulation" ? "已识别测试行为"
                    : "未发现关联风险";
                  const resultLabel = pending ? "等待研判" : failed
                    ? judgment.status === "timeout" ? "超时" : "失败"
                    : blocked ? "高风险"
                    : judgment.classification === "suspicious" ? "可疑关联"
                    : judgment.classification === "authorized_admin" ? "授权操作"
                    : judgment.classification === "simulation" ? "测试行为"
                    : "安全";
                  return (
                    <div key={`${judgment.episodeId}-${judgment.revision}`} className={cn("rounded-lg border p-4", border)}>
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <div className="flex items-center gap-2">
                            <GitBranch className={cn("size-4", pending ? "text-violet-300" : blocked ? "text-rose-300" : failed || suspicious ? "text-amber-300" : "text-emerald-300")} />
                            <p className="text-sm font-semibold text-zinc-100">{title}</p>
                          </div>
                          <p className="mt-1 text-[11px] text-zinc-500">{judgment.agentType} · {streamWorkspaceName(workspacePath)} · {judgment.sessionId || "无会话 ID"}</p>
                          <p className="mt-0.5 text-[10px] text-zinc-700">关联记录 {judgment.episodeId.slice(0, 18)} · 第 {judgment.revision} 次分析</p>
                          {judgment.updateRevision !== undefined && (
                            <p className={cn(
                              "mt-1 text-[10px]",
                              updatePending ? "text-violet-300" : "text-amber-300",
                            )}>
                              第 {judgment.updateRevision} 次分析
                              {updatePending ? "正在进行，当前保留上一条有效结论" : judgment.updateStatus === "timeout"
                                ? "超时，当前保留上一条有效结论"
                                : "失败，当前保留上一条有效结论"}
                            </p>
                          )}
                        </div>
                        <div className="text-right">
                          <span className={cn(
                            "inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold",
                            pending ? "border-violet-400/30 bg-violet-400/10 text-violet-200" : blocked ? "border-rose-400/30 bg-rose-400/10 text-rose-200" : failed || suspicious ? "border-amber-400/30 bg-amber-400/10 text-amber-200" : "border-emerald-400/30 bg-emerald-400/10 text-emerald-200",
                          )}>
                            {resultLabel}
                          </span>
                          {judgment.confidence !== undefined && <p className="mt-1 text-[10px] text-zinc-600">置信度 {Math.round(judgment.confidence * 100)}%</p>}
                        </div>
                      </div>
                      <div className="mt-4 grid gap-2 md:grid-cols-3">
                        {judgment.evidence.map((evidence, index) => (
                          <div key={evidence.eventId} className="relative rounded-md border border-white/10 bg-black/20 p-3">
                            <div className="flex items-center justify-between gap-2">
                              <span className="flex size-5 items-center justify-center rounded-full bg-white/10 text-[10px] text-zinc-300">{index + 1}</span>
                              <span className="text-[10px] text-zinc-600">{dayjs(evidence.eventTime).format("HH:mm:ss")}</span>
                            </div>
                            <p className="mt-2 text-xs font-medium text-zinc-200">{STREAM_OPERATION_LABELS[evidence.operation] ?? evidence.operation}</p>
                            <p className="mt-1 line-clamp-2 text-[11px] text-zinc-500" title={evidence.subject}>{evidence.subject}</p>
                            {evidence.runtimeVulnerabilities?.map((match) => (
                              <p key={`${match.findingId}-${match.vulnerabilityId}`} className="mt-2 rounded border border-rose-400/20 bg-rose-400/[0.06] px-2 py-1 text-[10px] text-rose-200">
                                {match.packageName}@{match.version} · {match.vulnerabilityId} · {match.confidence === "high" ? "高置信匹配" : "中置信匹配"}
                              </p>
                            ))}
                            {evidence.judgment && (
                              <p className="mt-2 text-[10px] text-zinc-600">
                                {evidence.judgment.stage} · {evidence.judgment.status} · {evidence.judgment.verdict || "无结论"}
                              </p>
                            )}
                          </div>
                        ))}
                      </div>
                      <div className="mt-3 flex items-center justify-between gap-3 border-t border-white/[0.07] pt-3 text-[10px] text-zinc-600">
                        <div className="min-w-0">
                          <p className="text-zinc-400">{judgment.reason || judgment.error || "暂无关联研判说明"}</p>
                          <p className="mt-1">
                            {pending
                              ? "等待分析"
                              : `分析耗时 ${formatNumber(judgment.latencyMs)}ms`}
                            {" · 分析时段 "}{dayjs(judgment.windowStart).format("HH:mm:ss")}—{dayjs(judgment.windowEnd).format("HH:mm:ss")}
                          </p>
                        </div>
                        {judgment.traceIds[0] && <Link to={"/events?" + query.toString()} className="shrink-0 text-teal-300 hover:text-teal-200">查看相关事件 →</Link>}
                      </div>
                    </div>
                  );
                })}
                {suppressedEpisodes.length > 0 && (
                  <p className="text-[10px] text-zinc-700">
                    已折叠 {suppressedEpisodes.length} 条过期或历史回放记录；这些记录未进入关联研判，也不计入异常。
                  </p>
                )}
                {syntheticEpisodes.length > 0 && (
                  <p className="text-[10px] text-zinc-700">
                    已折叠 {syntheticEpisodes.length} 条测试记录；测试结果不计入资产风险和关联统计。
                  </p>
                )}
                {compositeRisks.length > 0 && (
                  <p className="text-[10px] text-zinc-700">已保留 {compositeRisks.length} 条历史候选记录，不作为当前关联研判结论。</p>
                )}
              </div>
            )}

            {tab === "runtime" && (
              <div className="space-y-3">
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                  {[
                    { label: "服务状态", value: findings.enabled ? "正常" : "暂不可用", detail: "分析结果已同步" },
                    { label: "风险画像", value: findings.riskProfiles.length, detail: "按智能体与工作区汇总" },
                    { label: "关联研判", value: visibleCompositeJudgments.length, detail: "连续行为分析结果" },
                    { label: "等待研判", value: pendingEpisodes.length, detail: failedEpisodes.length + " 条分析异常" },
                  ].map((item) => (
                    <div key={item.label} className="rounded-md border border-white/10 bg-white/[0.025] p-3">
                      <p className="text-[11px] text-zinc-500">{item.label}</p>
                      <p className="mt-1 text-lg font-semibold text-zinc-100">{item.value}</p>
                      <p className="mt-1 text-[10px] text-zinc-600">{item.detail}</p>
                    </div>
                  ))}
                </div>
                <div className="flex gap-3 rounded-md border border-amber-400/20 bg-amber-400/[0.05] p-3">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-300" />
                  <div>
                    <p className="text-xs font-medium text-amber-100">部分分析指标暂未提供</p>
                    <p className="mt-1 text-[11px] leading-5 text-zinc-500">当前仅展示可以可靠读取的分析结果和更新时间，不完整的运行指标不会作为健康判断依据。</p>
                  </div>
                </div>
              </div>
            )}
              </>
            )}
          </div>
        )}
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
  scope,
  onScopeChange,
}: {
  funnel?: SecurityDecisionFunnel | null;
  status?: PolicyStatus | null;
  scope: TimelineScope;
  onScopeChange: (value: TimelineScope) => void;
}) {
  const tiers = funnel?.tiers ?? [];

  return (
    <Panel
      title="决策层级漏斗"
      icon={Layers3}
      action={<TimelineScopeTabs value={scope} onChange={onScopeChange} />}
    >
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

function eventDetailHref(event: AgentEventListItem, timeFilter: SecurityTimeFilter) {
  const qs = new URLSearchParams({
    eventId: event.eventId,
    timeType: timeFilter.timeType ?? "last_3h",
  });
  if (timeFilter.startTime) qs.set("startTime", timeFilter.startTime);
  if (timeFilter.endTime) qs.set("endTime", timeFilter.endTime);
  if (event.traceId) qs.set("traceId", event.traceId);
  if (event.runId) qs.set("runId", event.runId);
  if (event.sessionId) qs.set("sessionId", event.sessionId);
  if (event.agentId) qs.set("agentId", event.agentId);
  if (event.agentAssetId) qs.set("agentAssetId", event.agentAssetId);
  if (event.workspacePath) qs.set("workspacePath", event.workspacePath);
  if (event.eventKind) qs.set("eventKind", event.eventKind);
  const sourceId =
    event.sourceId ??
    (typeof event.attributes.sourceId === "string" ? event.attributes.sourceId : undefined);
  const collectorId =
    event.collectorId ??
    (typeof event.attributes.collectorId === "string" ? event.attributes.collectorId : undefined);
  if (sourceId) qs.set("sourceId", sourceId);
  if (collectorId) qs.set("collectorId", collectorId);
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

const SENTRY_TIER_META: Record<AgentEventListItem["tier"], { label: string; title: string; className: string }> = {
  Rules: { label: "L1", title: "L1 · 规则引擎", className: "border-zinc-600/60 bg-zinc-500/10 text-zinc-300" },
  Llm: { label: "L2", title: "L2 · LLM 研判", className: "border-amber-500/40 bg-amber-500/10 text-amber-200" },
  Agent: { label: "L3", title: "L3 · 智能体深判", className: "border-rose-500/40 bg-rose-500/10 text-rose-200" },
};

function SentryTierPill({ event }: { event: AgentEventListItem }) {
  if (event.decisionStatus && event.decisionStatus !== "succeeded") {
    const statusMeta = {
      accepted: { label: "已接收", title: "事件已接收，等待进入研判队列", className: "border-sky-500/40 bg-sky-500/10 text-sky-200" },
      pending: { label: event.tier === "Llm" ? "L2→L3" : "待研判", title: event.reason, className: "border-cyan-500/40 bg-cyan-500/10 text-cyan-200" },
      running: { label: "研判中", title: "安全研判正在执行", className: "border-cyan-500/40 bg-cyan-500/10 text-cyan-200" },
      failed: { label: "失败", title: event.reason, className: "border-rose-500/40 bg-rose-500/10 text-rose-200" },
      timeout: { label: "超时", title: event.reason, className: "border-orange-500/40 bg-orange-500/10 text-orange-200" },
    }[event.decisionStatus];
    if (statusMeta) {
      return (
        <span title={statusMeta.title} className={cn("inline-flex h-6 min-w-10 items-center justify-center rounded border px-2 text-[10px] font-semibold", statusMeta.className)}>
          {statusMeta.label}
        </span>
      );
    }
  }
  const meta = SENTRY_TIER_META[event.tier];
  return (
    <span
      title={meta.title}
      className={cn("inline-flex h-6 min-w-10 items-center justify-center rounded border px-2 font-mono text-[11px] font-semibold", meta.className)}
    >
      {meta.label}
    </span>
  );
}

function TimelineScopeTabs({
  value,
  onChange,
}: {
  value: TimelineScope;
  onChange: (value: TimelineScope) => void;
}) {
  const options: Array<{ value: TimelineScope; label: string }> = [
    { value: "agent", label: "已识别 Agent" },
    { value: "raw", label: "全部观测" },
  ];

  return (
    <div className="inline-flex h-8 items-center rounded-md border border-white/10 bg-white/5 p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={cn(
            "h-7 min-w-20 rounded px-2.5 text-xs font-semibold transition-colors",
            value === option.value
              ? "bg-teal-400/20 text-teal-100"
              : "text-zinc-500 hover:bg-white/5 hover:text-zinc-200",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function AgentEventTimelinePanel({
  events,
  error,
  scope,
  tier,
  includeUnknown,
  timeFilter,
  onScopeChange,
  onTierChange,
  onIncludeUnknownChange,
}: {
  events?: AgentEventList | null;
  error?: string;
  scope: TimelineScope;
  tier: TimelineTierFilter;
  includeUnknown: boolean;
  timeFilter: SecurityTimeFilter;
  onScopeChange: (value: TimelineScope) => void;
  onTierChange: (value: TimelineTierFilter) => void;
  onIncludeUnknownChange: (value: boolean) => void;
}) {
  const items = events?.items ?? [];

  return (
    <Panel
      title="无侵入事件时间线"
      icon={GitBranch}
      action={
        <div className="flex items-center gap-3">
          <TimelineScopeTabs value={scope} onChange={onScopeChange} />
          {scope === "raw" ? (
            <button
              type="button"
              aria-pressed={includeUnknown}
              onClick={() => onIncludeUnknownChange(!includeUnknown)}
              className={cn(
                "h-8 rounded-md border px-2.5 text-xs font-semibold transition-colors",
                includeUnknown
                  ? "border-teal-400/30 bg-teal-400/10 text-teal-100"
                  : "border-white/10 bg-white/5 text-zinc-500 hover:text-zinc-200",
              )}
            >
              {includeUnknown ? "包含 Unknown" : "隐藏 Unknown"}
            </button>
          ) : null}
          <Select value={tier} onValueChange={(value) => onTierChange(value as TimelineTierFilter)}>
            <SelectTrigger className="h-8 w-[112px] border-white/10 bg-white/5 text-xs text-zinc-100" aria-label="筛选研判层级">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部研判</SelectItem>
              <SelectItem value="Rules">L1</SelectItem>
              <SelectItem value="Llm">L2</SelectItem>
              <SelectItem value="Agent">L3</SelectItem>
            </SelectContent>
          </Select>
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
            <div className="grid min-w-[1140px] grid-cols-[96px_88px_minmax(240px,1.4fr)_minmax(150px,0.9fr)_minmax(150px,0.9fr)_66px_82px_76px_62px] gap-3 border-b border-white/10 pb-2 text-xs text-zinc-500">
              <span>时间</span>
              <span>类型</span>
              <span>事件</span>
              <span>Agent</span>
              <span>Trace / Span</span>
              <span className="text-center">研判</span>
              <span className="text-right">风险</span>
              <span className="text-center">处置</span>
              <span className="text-right">操作</span>
            </div>
            <div className="min-w-[1140px] divide-y divide-white/8">
              {items.map((event) => (
                <Link
                  key={event.eventId}
                  to={eventDetailHref(event, timeFilter)}
                  className="group grid grid-cols-[96px_88px_minmax(240px,1.4fr)_minmax(150px,0.9fr)_minmax(150px,0.9fr)_66px_82px_76px_62px] items-center gap-3 py-3 text-sm transition hover:bg-white/[0.03]"
                >
                  <span className="font-mono text-xs text-zinc-500">{formatDate(event.at)}</span>
                  <span className="flex min-w-0">
                    <EventCellPill event={event} />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate font-medium text-zinc-100" title={event.subject}>
                      {event.subject}
                      {event.repeatCount && event.repeatCount > 1 ? <span className="ml-2 rounded border border-white/10 bg-white/5 px-1.5 py-0.5 text-[10px] text-zinc-400">x{event.repeatCount}</span> : null}
                    </p>
                    <p className="mt-0.5 truncate text-[11px] text-zinc-600" title={event.reason}>
                      {event.eventKind} · {riskEventName(event.riskCategory)} · {event.source}
                    </p>
                  </div>
                  <div className="min-w-0 text-xs">
                    <AgentIdentityInline event={event} />
                  </div>
                  <div className="min-w-0 font-mono text-xs">
                    <p className="truncate text-zinc-300" title={event.traceId}>{shortId(event.traceId)}</p>
                    <p className="mt-0.5 truncate text-zinc-600" title={event.spanId}>{shortId(event.spanId)}</p>
                  </div>
                  <span className="flex justify-center">
                    <SentryTierPill event={event} />
                  </span>
                  <span className="text-right font-mono text-sm font-semibold tabular-nums text-zinc-100">
                    {formatNumber(event.riskScore, { maximumFractionDigits: 0 })}
                  </span>
                  <span className="flex justify-center">
                    <VerdictPill verdict={event.verdict} />
                  </span>
                  <span className="text-right text-xs font-semibold text-teal-300 transition group-hover:text-teal-200">
                    详情 →
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

function WorkspaceRiskPanel({
  workspaceRisk,
  scope,
  onScopeChange,
}: {
  workspaceRisk?: SecurityWorkspaceRiskDistribution | null;
  scope: TimelineScope;
  onScopeChange: (value: TimelineScope) => void;
}) {
  const list = workspaceRisk?.list ?? [];
  const agentRisk = list.filter((item) => item.workspacePath.startsWith("agent://"));
  const directoryRisk = list.filter((item) => !item.workspacePath.startsWith("agent://"));

  const renderRiskDistribution = (
    title: string,
    description: string,
    items: typeof list,
    emptyLabel: string,
    pathLabel: string,
  ) => (
    <div className="min-w-0 rounded-lg border border-white/10 bg-black/10">
      <div className="border-b border-white/10 px-4 py-3">
        <h3 className="text-sm font-semibold text-zinc-100">{title}</h3>
        <p className="mt-0.5 text-xs text-zinc-500">{description}</p>
      </div>
      {items.length === 0 ? (
        <EmptyState label={emptyLabel} />
      ) : (
        <div className="max-h-[420px] overflow-auto p-4">
          <div className="grid min-w-[520px] grid-cols-[minmax(180px,1fr)_72px_96px_86px] gap-3 border-b border-white/10 pb-2 text-xs text-zinc-500">
            <span>{pathLabel}</span>
            <span className="text-right">会话数</span>
            <span className="text-right">累计风险</span>
            <span className="text-right">等级</span>
          </div>
          <div className="min-w-[520px] divide-y divide-white/8">
            {items.map((item) => {
              const displayName = item.workspacePath.startsWith("agent://")
                ? item.workspacePath.slice("agent://".length)
                : item.workspacePath;
              return (
                <div
                  key={item.workspacePath}
                  className="grid grid-cols-[minmax(180px,1fr)_72px_96px_86px] items-center gap-3 py-3 text-sm"
                >
                  <span className="truncate font-medium text-zinc-200" title={item.workspacePath}>
                    {displayName}
                  </span>
                  <span className="text-right tabular-nums text-zinc-400">{formatNumber(item.sessionCount)}</span>
                  <span className="text-right tabular-nums text-zinc-100">
                    {formatNumber(item.totalRiskScore, { maximumFractionDigits: 1 })}
                  </span>
                  <span className="flex justify-end">
                    <StatusPill level={item.riskLevel} label={item.riskLevelText} />
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );

  return (
    <Panel
      title="Agent 与工作区风险分布"
      icon={Bot}
      action={<TimelineScopeTabs value={scope} onChange={onScopeChange} />}
    >
      {list.length === 0 ? (
        <EmptyState label="暂无 Agent 与工作区风险数据" />
      ) : (
        <div className="grid gap-4 p-4 lg:grid-cols-2">
          {renderRiskDistribution(
            "Agent 风险分布",
            "未绑定明确工作目录的 Agent 风险归属",
            agentRisk,
            "暂无 Agent 风险数据",
            "Agent",
          )}
          {renderRiskDistribution(
            "工作区风险分布",
            "按真实工作目录聚合会话与风险",
            directoryRisk,
            "暂无工作区风险数据",
            "工作目录",
          )}
        </div>
      )}
    </Panel>
  );
}

export default function SecurityMonitorPage() {
  const [filter, setFilter] = useState<SecurityTimeFilter>(DEFAULT_FILTER);
  const [timelineScope, setTimelineScope] = useState<TimelineScope>("raw");
  const [timelineTier, setTimelineTier] = useState<TimelineTierFilter>("all");
  const [timelineIncludeUnknown, setTimelineIncludeUnknown] = useState(true);
  const [riskBreakdownScope, setRiskBreakdownScope] = useState<TimelineScope>("agent");
  const [decisionFunnelScope, setDecisionFunnelScope] = useState<TimelineScope>("agent");
  const [workspaceRiskScope, setWorkspaceRiskScope] = useState<TimelineScope>("agent");
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
  const { data, loading, refresh } = useRequest(() => loadSecurityDashboardData(requestFilter, timelineScope, timelineTier, timelineIncludeUnknown, riskBreakdownScope, decisionFunnelScope, workspaceRiskScope), {
    refreshDeps: [requestFilter, timelineScope, timelineTier, timelineIncludeUnknown, riskBreakdownScope, decisionFunnelScope, workspaceRiskScope],
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
    data?.streamFindings?.updateTime ||
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
              <DecisionFunnelPanel
                funnel={data?.decisionFunnel}
                status={status}
                scope={decisionFunnelScope}
                onScopeChange={setDecisionFunnelScope}
              />
            </div>
          </DashboardSection>

          <DashboardSection title="风险态势" icon={Siren}>
            <div className="space-y-4">
              <RiskSummaryPanels summary={data?.riskSummary} />
              <RiskBreakdownPanel breakdown={data?.riskBreakdown} error={data?.errors.riskBreakdown} scope={riskBreakdownScope} onScopeChange={setRiskBreakdownScope} />
            </div>
          </DashboardSection>

          <DashboardSection title="智能体监测" icon={Sparkles}>
            <AgentRiskOverviewPanel
              inventory={data?.agentInventory}
              findings={data?.streamFindings}
              inventoryError={data?.errors.agentInventory}
              findingsError={data?.errors.streamFindings}
              filter={filter}
            />
          </DashboardSection>

          {data?.supplyChain?.enabled && (
            <DashboardSection title="供应链漏洞资产" icon={ShieldAlert}>
              <SupplyChainPanel
                overview={data.supplyChain}
                streamFindings={data.streamFindings}
                error={data.errors.supplyChain}
              />
            </DashboardSection>
          )}

          <DashboardSection title="运行链路" icon={GitBranch}>
            <AgentEventTimelinePanel
              events={data?.events}
              error={data?.errors.events}
              scope={timelineScope}
              tier={timelineTier}
              includeUnknown={timelineIncludeUnknown}
              timeFilter={filter}
              onScopeChange={setTimelineScope}
              onTierChange={setTimelineTier}
              onIncludeUnknownChange={setTimelineIncludeUnknown}
            />
          </DashboardSection>

          <DashboardSection title="会话与工作区" icon={TerminalSquare}>
            <div className="grid gap-4 xl:grid-cols-[minmax(360px,0.9fr)_minmax(0,1.6fr)]">
              <HighestRiskPanel session={data?.highestRisk} />
              <WorkspaceRiskPanel workspaceRisk={data?.workspaceRisk} scope={workspaceRiskScope} onScopeChange={setWorkspaceRiskScope} />
            </div>
          </DashboardSection>
        </div>
      </main>
    </div>
  );
}
