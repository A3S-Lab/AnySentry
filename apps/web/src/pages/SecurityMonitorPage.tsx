import { useRequest } from "ahooks";
import dayjs from "dayjs";
import { formatSecurityDateTime, parseSecurityTimestamp, securityTimestampValue } from "@/lib/date-time";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  BellRing,
  Bot,
  CalendarClock,
  ChartLine,
  ChevronDown,
  Cpu,
  EyeOff,
  FileCheck2,
  Gauge,
  GitBranch,
  HardDrive,
  Layers3,
  LayoutDashboard,
  LoaderCircle,
  MemoryStick,
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
  ServerCog,
  TerminalSquare,
  Wrench,
  Zap,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AdminTokenControl } from "@/components/custom/admin-token-control";
import { AgentAssetIdentityInline, AgentIdentityInline } from "@/components/custom/agent-identity";
import { useVChartTheme } from "@/components/custom/charts/vchart-theme";
import { type VChartSpec, VChartView } from "@/components/custom/vchart";
import { useSecurityConsole } from "@/components/custom/security-console-header";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  type AgentEventCategory,
  type AgentEventList,
  type AgentEventListItem,
  type AgentInventory,
  type AgentInventoryItem,
  type AgentInstanceMetricPoint,
  type AgentInstanceMetrics,
  type AgentObservability,
  type CollectorHealth,
  type PlatformMetricsOverview,
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
  type SecurityVerdict,
  type SecurityWorkspaceRiskDistribution,
  type StreamFindingList,
  type SupplyChainOverview,
  securityCenterApi,
  streamAgentObservability,
} from "@/lib/api/security-center";
import type { PolicyStatus } from "@/lib/api/security-center";
import { settleAll } from "@/lib/settle-all";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { WorkspaceAssetsView } from "@/pages/WorkspacesPage";

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
  | "supplyChain";

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
  errors: Partial<Record<SecuritySectionKey, string>>;
}

type TimelineScope = "agent" | "raw";
type DashboardView =
  | "overview"
  | "agentAssets"
  | "agentInstances"
  | "risk"
  | "stream"
  | "supplyChain"
  | "events"
  | "workspace";

const DASHBOARD_SNAPSHOT_QUANTUM_MS = 10_000;

function dashboardSnapshotAsOf(): string {
  return new Date(
    Math.floor(Date.now() / DASHBOARD_SNAPSHOT_QUANTUM_MS) * DASHBOARD_SNAPSHOT_QUANTUM_MS,
  ).toISOString();
}

const DASHBOARD_VIEWS: Array<{
  value: DashboardView;
  label: string;
  description: string;
  icon: LucideIcon;
}> = [
  { value: "overview", label: "运行总览", description: "平台健康与实时状态", icon: Activity },
  { value: "agentAssets", label: "Agent 列表", description: "Agent 清单与运行状态", icon: Bot },
  { value: "agentInstances", label: "Agent 态势", description: "实例活动与研判健康", icon: Activity },
  { value: "risk", label: "风险态势", description: "风险分类与趋势分布", icon: Siren },
  { value: "stream", label: "复合研判", description: "Flink 连续行为关联", icon: Sparkles },
  { value: "supplyChain", label: "供应链漏洞", description: "OSV 依赖漏洞资产", icon: ShieldAlert },
  { value: "events", label: "运行链路", description: "无侵入事件时间线", icon: GitBranch },
  { value: "workspace", label: "会话与工作区", description: "Agent 与 Workspace 风险", icon: TerminalSquare },
];

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

async function loadSecurityDashboardData(
  filter: SecurityTimeFilter,
  activeView: DashboardView,
  overviewScope: TimelineScope,
  scanScope: TimelineScope,
  riskBreakdownScope: TimelineScope,
  decisionFunnelScope: TimelineScope,
  workspaceRiskScope: TimelineScope,
): Promise<SecurityDashboardData> {
  const empty: SecurityDashboardData = {
    health: null,
    scan: null,
    performance: null,
    riskSummary: null,
    riskBreakdown: null,
    highestRisk: null,
    decisionFunnel: null,
    workspaceRisk: null,
    agentInventory: null,
    streamFindings: null,
    supplyChain: null,
    errors: {},
  };
  const overviewFilter = { ...filter, scope: overviewScope };
  const scanFilter = { ...filter, scope: scanScope, seriesPoints: 36 };

  if (activeView === "overview") {
    const { data, errors } = await settleAll({
      health: securityCenterApi.healthCard(overviewFilter),
      scan: securityCenterApi.explainabilityScan(scanFilter),
      performance: securityCenterApi.performanceCard(overviewFilter),
      decisionFunnel: securityCenterApi.decisionFunnel({ ...filter, scope: decisionFunnelScope }),
    }, formatRequestError);
    return enrichSecurityDashboardData({ ...empty, ...data, errors });
  }

  if (activeView === "risk") {
    const { data, errors } = await settleAll({
      riskSummary: securityCenterApi.riskSummary(filter),
      riskBreakdown: securityCenterApi.riskBreakdown({ ...filter, scope: riskBreakdownScope }),
    }, formatRequestError);
    return enrichSecurityDashboardData({ ...empty, ...data, errors });
  }

  if (activeView === "workspace") {
    const { data, errors } = await settleAll({
      highestRisk: securityCenterApi.highestRiskSession(filter),
      workspaceRisk: securityCenterApi.workspaceRiskDistribution({ ...filter, scope: workspaceRiskScope }),
    }, formatRequestError);
    return enrichSecurityDashboardData({ ...empty, ...data, errors });
  }

  if (activeView === "supplyChain") {
    const { data, errors } = await settleAll({
      supplyChain: securityCenterApi.supplyChainOverview(500),
    }, formatRequestError);
    return enrichSecurityDashboardData({ ...empty, ...data, errors });
  }

  return empty;
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
  return formatSecurityDateTime(value, "MM-DD HH:mm:ss", value || "--");
}

function formatTimeLabel(value?: string) {
  return formatSecurityDateTime(value, "HH:mm:ss", value?.slice(-8) ?? "");
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

function Panel({
  title,
  subtitle,
  icon: Icon,
  action,
  children,
  className,
}: {
  title: string;
  subtitle?: ReactNode;
  icon: LucideIcon;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const { t } = useI18n();
  return (
    <section className={cn("rounded-[8px] border border-[#232a37] bg-[#0f131a]", className)}>
      <div className="flex min-h-12 items-center justify-between gap-3 border-b border-[#232a37] px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-white/10 bg-white/5 text-teal-200">
            <Icon className="size-4" />
          </span>
          <h2 className="truncate text-sm font-semibold text-zinc-100">{t(title)}</h2>
          {subtitle ? <span className="truncate text-[10px] text-zinc-600">{subtitle}</span> : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

function EmptyState({ label }: { label: string }) {
  const { t } = useI18n();
  return <div className="flex min-h-28 items-center justify-center px-4 py-5 text-sm text-zinc-500">{t(label)}</div>;
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
  const { t } = useI18n();
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
      {t(label || tone.label)}
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
  const { t } = useI18n();
  return (
    <section className="min-h-[132px] rounded-[8px] border border-[#232a37] bg-[#0f131a] p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-xs font-medium text-zinc-400">{t(label)}</p>
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
      <p className="mt-3 truncate text-xs text-zinc-500">{t(sub)}</p>
      {footer ? <div className="mt-3">{footer}</div> : null}
    </section>
  );
}

function DashboardSection({
  title,
  icon: Icon,
  action,
  children,
}: {
  title: string;
  icon: LucideIcon;
  action?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3 px-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-white/10 bg-white/5 text-teal-200">
            <Icon className="size-3.5" />
          </span>
          <h2 className="truncate text-sm font-semibold text-zinc-100">{t(title)}</h2>
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

function DashboardViewNavigation({
  value,
  supplyChainEnabled,
  onChange,
}: {
  value: DashboardView;
  supplyChainEnabled: boolean;
  onChange: (value: DashboardView) => void;
}) {
  const { t } = useI18n();
  const items = DASHBOARD_VIEWS.filter((item) => item.value !== "supplyChain" || supplyChainEnabled);
  const overviewItems = items.filter((item) =>
    ["overview", "scan", "risk", "stream", "workspace"].includes(item.value),
  );
  const platformItems = items.filter((item) =>
    item.value === "events",
  );
  const governanceItems = items.filter((item) => item.value === "supplyChain");
  const renderDesktopItem = (item: (typeof items)[number]) => {
    const Icon = item.icon;
    const active = item.value === value;
    return (
      <button
        key={item.value}
        type="button"
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex w-full items-start gap-2.5 rounded-md border px-2.5 py-2 text-left transition-colors",
          active
            ? "border-transparent bg-[#1c222d] text-[#e8ecf3] shadow-[inset_2px_0_0_#f97316]"
            : "border-transparent text-[#b6bdcc] hover:bg-[#151a23] hover:text-[#e8ecf3]",
        )}
        onClick={() => onChange(item.value)}
      >
        <span
          className={cn(
            "mt-0.5 inline-flex size-5 shrink-0 items-center justify-center",
            active ? "text-[#f97316]" : "text-[#818a9c]",
          )}
        >
          <Icon className="size-3.5" />
        </span>
        <span className="min-w-0">
          <span className="block text-xs font-semibold leading-[1.45]">{t(item.label)}</span>
          <span className={cn("mt-0.5 block text-[10.5px] leading-4", active ? "text-[#818a9c]" : "text-[#5b6373]")}>
            {t(item.description)}
          </span>
        </span>
      </button>
    );
  };
  return (
    <>
      <aside className="hidden h-full w-[220px] shrink-0 overflow-y-auto rounded-lg border border-[#232a37] bg-[#0f131a] p-1.5 lg:block">
        <nav className="space-y-1" aria-label={t("安全监控模块")}>
          <p className="flex items-center gap-2 px-3 pb-1 pt-3 text-[10px] font-bold uppercase tracking-[0.1em] text-[#5b6373]">
            <LayoutDashboard className="size-3.5" />
            {t("概览")}
          </p>
          {overviewItems.map(renderDesktopItem)}
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
          {platformItems.map(renderDesktopItem)}
          <Link
            to="/agents"
            className="flex w-full items-start gap-2.5 rounded-md border border-transparent px-2.5 py-2 text-left text-[#b6bdcc] transition-colors hover:bg-[#151a23] hover:text-[#e8ecf3]"
          >
            <span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center text-[#818a9c]">
              <Bot className="size-3.5" />
            </span>
            <span className="block text-xs font-semibold leading-[1.45]">{t("Agent 列表")}</span>
          </Link>
          <Link
            to="/workspaces"
            className="flex w-full items-start gap-2.5 rounded-md border border-transparent px-2.5 py-2 text-left text-[#b6bdcc] transition-colors hover:bg-[#151a23] hover:text-[#e8ecf3]"
          >
            <span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center text-[#818a9c]">
              <Layers3 className="size-3.5" />
            </span>
            <span className="block text-xs font-semibold leading-[1.45]">Workspace</span>
          </Link>

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
          <Link
            to="/admin/policy"
            className="flex w-full items-start gap-2.5 rounded-md border border-transparent px-2.5 py-2 text-left text-[#b6bdcc] transition-colors hover:bg-[#151a23] hover:text-[#e8ecf3]"
          >
            <span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center text-[#818a9c]">
              <SlidersHorizontal className="size-3.5" />
            </span>
            <span className="min-w-0">
              <span className="block text-xs font-semibold leading-[1.45]">{t("策略配置")}</span>
              <span className="mt-0.5 block text-[10.5px] leading-4 text-[#5b6373]">{t("L1 / L2 / L3 研判策略")}</span>
            </span>
          </Link>

          {governanceItems.length > 0 ? (
            <>
              <p className="mt-3 flex items-center gap-2 border-t border-[#232a37] px-3 pb-1 pt-4 text-[10px] font-bold uppercase tracking-[0.1em] text-[#5b6373]">
                <ShieldAlert className="size-3.5" />
                {t("安全治理")}
              </p>
              {governanceItems.map(renderDesktopItem)}
            </>
          ) : null}

          <p className="mt-3 flex items-center gap-2 border-t border-[#232a37] px-3 pb-1 pt-4 text-[10px] font-bold uppercase tracking-[0.1em] text-[#5b6373]">
            <SlidersHorizontal className="size-3.5" />
            {t("管理")}
          </p>
          <AdminTokenControl navigation />
        </nav>
      </aside>

      <nav
        className="flex shrink-0 gap-2 overflow-x-auto rounded-lg border border-[#232a37] bg-[#0f131a] p-2 lg:hidden"
        aria-label={t("安全监控模块")}
      >
        {items.map((item) => {
          const Icon = item.icon;
          const active = item.value === value;
          return (
            <button
              key={item.value}
              type="button"
              aria-current={active ? "page" : undefined}
              className={cn(
                "inline-flex shrink-0 items-center gap-1.5 rounded-md border px-3 py-2 text-xs transition-colors",
                active
                  ? "border-[#f97316]/40 bg-[#f97316]/15 text-[#e8ecf3]"
                  : "border-[#232a37] bg-[#151a23] text-[#818a9c]",
              )}
              onClick={() => onChange(item.value)}
            >
              <Icon className="size-3.5" />
              {t(item.label)}
            </button>
          );
        })}
        <Link
          to="/agents"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-[#232a37] bg-[#151a23] px-3 py-2 text-xs text-[#818a9c]"
        >
          <Bot className="size-3.5" />
          {t("Agent 列表")}
        </Link>
        <Link
          to="/workspaces"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-[#232a37] bg-[#151a23] px-3 py-2 text-xs text-[#818a9c]"
        >
          <Layers3 className="size-3.5" />
          Workspace
        </Link>
        <Link
          to="/alerts"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-[#232a37] bg-[#151a23] px-3 py-2 text-xs text-[#818a9c]"
        >
          <BellRing className="size-3.5" />
          {t("告警")}
        </Link>
        <Link
          to="/maintenance"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-[#232a37] bg-[#151a23] px-3 py-2 text-xs text-[#818a9c]"
        >
          <CalendarClock className="size-3.5" />
          {t("维护")}
        </Link>
        <Link
          to="/admin/policy"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-[#232a37] bg-[#151a23] px-3 py-2 text-xs text-[#818a9c]"
        >
          <SlidersHorizontal className="size-3.5" />
          {t("策略配置")}
        </Link>
      </nav>
    </>
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

function ExplainabilityWaveChart({ scan }: { scan?: SecurityExplainabilityScan | null }) {
  const { t } = useI18n();
  const chartTheme = useVChartTheme();
  const chartData = useMemo(() => {
    const series = scan?.waveSeries?.[0];
    const safe = series?.safeSeries ?? [];
    const risk = series?.riskSeries ?? [];
    return [
      ...safe.map((point) => ({
        id: `safe-${point.statTime}`,
        time: formatTimeLabel(point.statTime),
        type: t("安全感知"),
        value: point.value,
        activationCount: point.activationCount,
      })),
      ...risk.map((point) => ({
        id: `risk-${point.statTime}`,
        time: formatTimeLabel(point.statTime),
        type: t("风险感知"),
        value: point.value,
        activationCount: point.activationCount,
      })),
    ];
  }, [scan, t]);

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

function ExplainabilityPanel({
  scan,
  error,
  scope,
  onScopeChange,
}: {
  scan?: SecurityExplainabilityScan | null;
  error?: string;
  scope: TimelineScope;
  onScopeChange: (scope: TimelineScope) => void;
}) {
  const { t } = useI18n();
  const safeLatest = scan?.waveSeries?.[0]?.safeSeries?.at(-1)?.value ?? 0;
  const riskLatest = scan?.waveSeries?.[0]?.riskSeries?.at(-1)?.value ?? 0;

  return (
    <Panel
      title="安全风险趋势"
      icon={Radar}
      action={<TimelineScopeTabs value={scope} onChange={onScopeChange} />}
    >
      <div className="grid gap-4 p-4 lg:grid-cols-[280px_minmax(0,1fr)]">
        <div className="flex flex-col items-center justify-center gap-4">
          <div className="w-full rounded-md border border-white/10 bg-white/[0.04] p-4">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-xs font-medium text-zinc-400">{t("安全感知")}</span>
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
              <span>{t("风险感知")}</span>
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
              <p className="text-xs text-zinc-500">{t("危险拦截")}</p>
              <p className="mt-1 text-xl font-semibold text-rose-100">{scan?.threatInterception ?? "--"}</p>
            </div>
            <div>
              <p className="text-xs text-zinc-500">{t("活跃会话")}</p>
              <p className="mt-1 text-xl font-semibold text-teal-100">{scan?.sessionActiveCount ?? "--"}</p>
            </div>
          </div>
        </div>
        <div className="min-w-0">
          <div className="mb-3 grid gap-3 sm:grid-cols-2">
            <div>
              <div className="mb-1 flex items-center justify-between text-xs">
                <span className="text-zinc-500">{t("安全感知")}</span>
                <span className="font-semibold text-teal-100">
                  {formatNumber(safeLatest, { maximumFractionDigits: 1 })}
                </span>
              </div>
              <MiniGauge value={safeLatest} color="#2dd4bf" />
            </div>
            <div>
              <div className="mb-1 flex items-center justify-between text-xs">
                <span className="text-zinc-500">{t("风险感知")}</span>
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
  const { locale } = useI18n();
  const requestCount = performance?.componentRequestCount;
  const tps = performance?.tps;
  const latency = performance?.avgLatency;

  return (
    <>
      <MetricPanel
        label="组件请求数"
        value={formatCompactNumber(requestCount?.current)}
        sub={locale === "en"
          ? `Peak ${formatCompactNumber(requestCount?.peak)} / Avg ${formatCompactNumber(requestCount?.avg)}`
          : `峰值 ${formatCompactNumber(requestCount?.peak)} / 平均 ${formatCompactNumber(requestCount?.avg)}`}
        icon={Network}
        tone="border-sky-300/25 bg-sky-400/10 text-sky-200"
        loading={loading}
      />
      <MetricPanel
        label="实时 TPS"
        value={formatNumber(tps?.current, { maximumFractionDigits: 1 })}
        sub={locale === "en"
          ? `Peak ${formatNumber(tps?.peak, { maximumFractionDigits: 1 })} / Avg ${formatNumber(tps?.avg, { maximumFractionDigits: 1 })}`
          : `峰值 ${formatNumber(tps?.peak, { maximumFractionDigits: 1 })} / 平均 ${formatNumber(tps?.avg, { maximumFractionDigits: 1 })}`}
        icon={Zap}
        tone="border-amber-300/25 bg-amber-400/10 text-amber-200"
        loading={loading}
      />
      <MetricPanel
        label="平均响应延迟"
        value={`${formatNumber(latency?.value, { maximumFractionDigits: 1 })}${latency?.unit ?? "ms"}`}
        sub={performance?.updateTime
          ? `${locale === "en" ? "Updated" : "更新"} ${formatDate(performance.updateTime)}`
          : "等待性能数据"}
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

function PlatformMiniSparkline({ values, color }: { values: number[]; color: string }) {
  const points = values.slice(-18);
  if (points.length < 2) return null;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = Math.max(max - min, 1);
  const width = 44;
  const height = 18;
  const padding = 2;
  const path = points.map((value, index) => {
    const x = padding + (index / (points.length - 1)) * (width - padding * 2);
    const y = padding + ((max - value) / range) * (height - padding * 2);
    return `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-[18px] w-11 shrink-0 overflow-visible"
      aria-hidden="true"
    >
      <path
        d={path}
        fill="none"
        stroke={color}
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ filter: `drop-shadow(0 0 4px ${color})` }}
      />
    </svg>
  );
}

function PlatformTrendEndLabels({ data }: { data?: PlatformMetricsOverview }) {
  const labels = [
    {
      key: "disk",
      value: data?.summary.diskPercent,
      tone: "border-amber-400/30 bg-amber-400/10 text-amber-200",
    },
    {
      key: "cpu",
      value: data?.summary.cpuPercent,
      tone: "border-sky-400/30 bg-sky-400/10 text-sky-200",
    },
    {
      key: "memory",
      value: data?.summary.memoryPercent,
      tone: "border-teal-400/30 bg-teal-400/10 text-teal-200",
    },
  ]
    .flatMap((item) => typeof item.value === "number"
      ? [{
        ...item,
        value: item.value,
        top: clamp(8 + (100 - normalizePercent(item.value)) * 0.78, 8, 84),
      }]
      : [])
    .sort((a, b) => a.top - b.top);

  for (let index = 1; index < labels.length; index += 1) {
    labels[index].top = Math.max(labels[index].top, labels[index - 1].top + 11);
  }
  const overflow = labels.length ? Math.max(0, labels[labels.length - 1].top - 84) : 0;

  return (
    <div className="pointer-events-none absolute inset-0" aria-hidden="true">
      {labels.map((item) => (
        <span
          key={item.key}
          className={cn(
            "absolute right-1 -translate-y-1/2 rounded-md border px-2 py-1 font-mono text-[11px] font-semibold tabular-nums shadow-lg backdrop-blur-sm",
            item.tone,
          )}
          style={{ top: `${item.top - overflow}%` }}
        >
          {formatPercent(item.value)}
        </span>
      ))}
    </div>
  );
}

function PlatformResourceSummary({
  data,
  loading,
}: {
  data?: PlatformMetricsOverview;
  loading?: boolean;
}) {
  const chartTheme = useVChartTheme();
  const seriesValues = useMemo(
    () => Object.fromEntries(
      (data?.series ?? []).map((series) => [
        series.key,
        series.points.map((point) => point.value),
      ]),
    ) as Record<string, number[]>,
    [data],
  );
  const metrics = [
    {
      label: "节点",
      value: data?.summary.nodeTotal === undefined ? "--" : `${data.summary.nodeReady ?? 0}/${data.summary.nodeTotal}`,
      icon: Layers3,
      iconTone: "border-sky-400/15 bg-sky-500/10 text-sky-300",
      valueTone: "text-zinc-100",
    },
    {
      label: "CPU",
      value: formatPercent(data?.summary.cpuPercent),
      icon: Cpu,
      iconTone: "border-sky-400/15 bg-sky-500/10 text-sky-300",
      valueTone: "text-zinc-100",
      sparkline: seriesValues.cpu,
      color: "#38bdf8",
    },
    {
      label: "内存",
      value: formatPercent(data?.summary.memoryPercent),
      icon: MemoryStick,
      iconTone: "border-teal-400/15 bg-teal-500/10 text-teal-300",
      valueTone: "text-zinc-100",
      sparkline: seriesValues.memory,
      color: "#2dd4bf",
    },
    {
      label: "磁盘",
      value: formatPercent(data?.summary.diskPercent),
      icon: HardDrive,
      iconTone: "border-amber-400/15 bg-amber-500/10 text-amber-300",
      valueTone: "text-zinc-100",
      sparkline: seriesValues.disk,
      color: "#fbbf24",
    },
    {
      label: "API P95",
      value: data?.summary.apiP95Ms === undefined ? "--" : `${formatNumber(data.summary.apiP95Ms, { maximumFractionDigits: 0 })}ms`,
      icon: Gauge,
      iconTone: "border-violet-400/15 bg-violet-500/10 text-violet-300",
      valueTone: "text-zinc-100",
      sparkline: seriesValues.api_p95,
      color: "#8b5cf6",
    },
    {
      label: "组件异常",
      value: data ? formatNumber(data.summary.componentAnomalies) : "--",
      icon: AlertTriangle,
      iconTone: data?.summary.componentAnomalies
        ? "border-rose-400/20 bg-rose-500/10 text-rose-300"
        : "border-white/10 bg-white/[0.04] text-zinc-500",
      valueTone: data?.summary.componentAnomalies ? "text-rose-400" : "text-zinc-100",
    },
  ];
  const resourceTrendData = useMemo(() => {
    const resourceSeries = data?.series.filter((series) => ["cpu", "memory", "disk"].includes(series.key)) ?? [];
    const includesDate = data ? Date.parse(data.to) - Date.parse(data.from) > 6 * 60 * 60 * 1000 : false;
    return resourceSeries.flatMap((series) => series.points.map((point) => ({
      time: formatSecurityDateTime(point.at, includesDate ? "MM-DD HH:mm" : "HH:mm:ss", "--"),
      metric: series.label,
      value: Math.round(point.value * 10) / 10,
    })));
  }, [data]);
  const resourceTrendSpec = useMemo<VChartSpec>(
    () => ({
      type: "line",
      data: [{ id: "platform-resource-trend", values: resourceTrendData }],
      xField: "time",
      yField: "value",
      seriesField: "metric",
      color: ["#38bdf8", "#2dd4bf", "#fbbf24"],
      padding: { top: 8, right: 72, bottom: 6, left: 2 },
      animation: false,
      tooltip: {
        visible: true,
        mark: { title: { value: "time" } },
      },
      legends: { visible: false },
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
          grid: {
            visible: true,
            style: { stroke: "#202938", lineWidth: 1, lineDash: [4, 4] },
          },
          label: {
            formatMethod: (value: string | number) => `${value}%`,
            style: { fill: chartTheme.axisSubLabel, fontSize: 10 },
          },
        },
      ],
      line: { style: { lineWidth: 2 } },
      point: { visible: false },
    }),
    [chartTheme, resourceTrendData],
  );
  return (
    <Panel
      title="平台资源"
      subtitle={data?.source === "prometheus" ? "Prometheus 实时指标" : "运行时局部指标"}
      icon={ServerCog}
      action={(
        <Link to="/platform" className="text-[11px] font-medium text-teal-300 hover:text-teal-200">
          查看平台监控 →
        </Link>
      )}
      className="w-full min-w-0 max-w-full overflow-hidden shadow-[0_0_28px_rgba(56,189,248,0.025)]"
    >
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6">
        {metrics.map((metric) => {
          const Icon = metric.icon;
          return (
            <div
              key={metric.label}
              className="flex min-h-[88px] min-w-0 items-center gap-2.5 border-r border-[#232a37] px-3 py-3 last:border-r-0"
            >
              <span className={cn(
                "inline-flex size-8 shrink-0 items-center justify-center rounded-md border",
                metric.iconTone,
              )}>
                <Icon className="size-4" aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[11px] font-medium text-zinc-500">{metric.label}</p>
                <div className="mt-1 flex min-w-0 items-end justify-between gap-2">
                  <p className={cn(
                    "truncate font-mono text-lg font-semibold tabular-nums",
                    metric.valueTone,
                  )}>
                    {loading && !data ? <span className="text-zinc-700">···</span> : metric.value}
                  </p>
                  {metric.sparkline?.length ? (
                    <PlatformMiniSparkline values={metric.sparkline} color={metric.color ?? "#38bdf8"} />
                  ) : null}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <div className="border-t border-[#232a37] px-4 pb-3 pt-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <ChartLine className="size-4 text-sky-300" aria-hidden="true" />
            <p className="text-xs font-semibold text-zinc-200">资源趋势</p>
          </div>
          <div className="flex items-center gap-4 text-[11px] text-zinc-400" aria-label="资源趋势图例">
            {[
              ["CPU", "bg-sky-400"],
              ["内存", "bg-teal-400"],
              ["磁盘", "bg-amber-400"],
            ].map(([label, tone]) => (
              <span key={label} className="inline-flex items-center gap-1.5">
                <span className={cn("size-2 rounded-full", tone)} />
                {label}
              </span>
            ))}
            <span className="inline-flex items-center gap-1 text-zinc-500">
              · 当前时间范围
              <ChevronDown className="size-3" aria-hidden="true" />
            </span>
          </div>
        </div>
        <div
          className="relative mt-2 h-[220px] min-h-0 w-full max-w-full overflow-hidden"
          aria-label="平台 CPU、内存与磁盘使用率趋势"
        >
          {loading && !data ? (
            <div className="flex h-full items-center justify-center text-[11px] text-zinc-600">
              <LoaderCircle className="mr-2 size-3.5 animate-spin" />
              加载平台资源趋势
            </div>
          ) : resourceTrendData.length > 3 ? (
            <>
              <VChartView spec={resourceTrendSpec} />
              <PlatformTrendEndLabels data={data} />
            </>
          ) : (
            <div className="flex h-full items-center justify-center text-[11px] text-zinc-600">
              时间序列尚未就绪
            </div>
          )}
        </div>
      </div>
      {data?.message ? (
        <p className="border-t border-[#232a37] px-3 py-1.5 text-[10px] text-amber-200/70">{data.message}</p>
      ) : null}
    </Panel>
  );
}

function LiveObservabilityPanel({
  observability,
  connected,
}: {
  observability?: AgentObservability | null;
  connected: boolean;
}) {
  const { locale, t } = useI18n();
  const heartbeatLevel: SecurityRiskLevel = observability?.health.heartbeatOk ? "safe" : connected ? "critical" : "unknown";
  const driftLevel: SecurityRiskLevel = observability?.behavioral.decisionPattern === "drift" ? "medium" : "safe";
  const statusLabel = connected
    ? `${locale === "en" ? "Live" : "实时"} ${formatTimeLabel(observability?.updateTime)}`
    : "连接中";
  const items = [
    {
      label: "心跳",
      value: observability ? (observability.health.heartbeatOk ? "在线" : "异常") : "--",
      sub: `${locale === "en" ? "Decision latency" : "决策延迟"} ${formatNumber(observability?.health.decisionLatencyMs, { maximumFractionDigits: 0 })}ms`,
      icon: RadioTower,
      tone: heartbeatLevel,
    },
    {
      label: "错误率",
      value: formatPercent(observability?.health.errorRate),
      sub: `${locale === "en" ? "Event activity" : "事件活跃度"} ${formatPercent(observability?.health.resourceUtil)}`,
      icon: AlertTriangle,
      tone: observability && observability.health.errorRate > 10 ? "medium" : "safe",
    },
    {
      label: "吞吐",
      value: formatNumber(observability?.system.commThroughput, { maximumFractionDigits: 1 }),
      sub: `${locale === "en" ? "Agents" : "智能体"} ${formatNumber(observability?.system.agentCount, { maximumFractionDigits: 0 })}`,
      icon: Network,
      tone: observability?.system.infraHealthy === false ? "medium" : "safe",
    },
    {
      label: "行为态势",
      value: observability?.behavioral.decisionPattern === "drift" ? "漂移" : observability ? "基线" : "--",
      sub: `${locale === "en" ? "Action rate" : "动作率"} ${formatNumber(observability?.behavioral.actionRate, { maximumFractionDigits: 1 })}`,
      icon: Activity,
      tone: driftLevel,
    },
    {
      label: "状态迁移",
      value: formatNumber(observability?.behavioral.stateTransitions, { maximumFractionDigits: 0 }),
      sub: `${locale === "en" ? "Goal progress" : "目标进度"} ${formatPercent(observability?.behavioral.goalProgress)}`,
      icon: GitBranch,
      tone: "low",
    },
  ];

  return (
    <Panel
      title="实时智能体可观测性"
      icon={RadioTower}
      action={<StatusPill level={connected ? "safe" : "unknown"} label={statusLabel} />}
      className="w-full min-w-0 max-w-full"
    >
      <div className="grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-5">
        {items.map((item) => {
          const tone = riskTone(item.tone);
          const Icon = item.icon;
          return (
            <div key={item.label} className="min-h-[108px] rounded-[8px] border border-white/10 bg-white/[0.03] p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium text-zinc-500">{t(item.label)}</p>
                  <p className="mt-2 truncate text-2xl font-semibold leading-none tracking-normal text-zinc-50">{t(item.value)}</p>
                </div>
                <span className={cn("inline-flex size-9 shrink-0 items-center justify-center rounded-md border", tone.border, tone.bg, tone.text)}>
                  <Icon className="size-4" />
                </span>
              </div>
              <p className="mt-3 truncate text-xs text-zinc-500">{t(item.sub)}</p>
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
  const { t } = useI18n();
  const items = category?.items ?? [];

  return (
    <div className="min-w-0">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-zinc-100">{t(title)}</p>
          <p className="mt-0.5 text-xs text-zinc-500">
            {t("总计")} {formatNumber(category?.totalCount ?? 0)} {t("个事件")}
          </p>
        </div>
        <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
      </div>
      {items.length === 0 ? (
        <div className="rounded-md border border-white/10 px-3 py-6 text-center text-xs text-zinc-500">{t("暂无风险项")}</div>
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
                  <p className="truncate text-sm text-zinc-200">{t(riskEventName(item.riskCode || item.riskName))}</p>
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
  download: "下载文件",
  chmod: "修改文件权限",
  encode: "编码数据",
  compress: "压缩数据",
  copy: "复制数据",
  egress: "建立外部连接",
  persistence_activate: "激活持久化配置",
  sandbox_probe: "探测沙箱边界",
  privilege_change: "尝试权限转换",
  target_discovery: "枚举破坏目标",
  destroy: "破坏文件或数据",
  remote_connect: "连接远程主机",
  remote_execute: "远程执行命令",
  remote_copy: "向远程主机复制数据",
  execute: "执行命令",
  observe: "观测事件",
};

const STREAM_ATTACK_TYPE_LABELS: Record<string, string> = {
  "download-and-execute": "下载后执行候选",
  download_execute: "下载后执行候选",
  "sensitive-data-exfiltration": "敏感数据外传候选",
  sensitive_data_exfiltration: "敏感数据外传候选",
  "known-vulnerability-exploitation": "已知漏洞利用候选",
  "persistence-installation": "持久化安装候选",
  persistence_installation: "持久化安装候选",
  "sandbox-privilege-breakout": "沙箱逃逸 / 权限突破候选",
  sandbox_privilege_breakout: "沙箱逃逸 / 权限突破候选",
  "destructive-behavior": "破坏性行为候选",
  destructive_behavior: "破坏性行为候选",
  "lateral-movement": "横向移动候选",
  lateral_movement: "横向移动候选",
};

function cvssExplanation(vector?: string) {
  if (!vector) {
    return {
      attackCondition: "OSV 未提供结构化攻击条件",
      impact: "需结合漏洞说明人工确认影响",
    };
  }
  const metrics: Record<string, string> = Object.fromEntries(
    vector.split("/").slice(1).map((part) => part.split(":")),
  );
  const accessLabels: Record<string, string> = {
    N: "可通过网络触发",
    A: "需相邻网络",
    L: "需本地访问",
    P: "需物理访问",
  };
  const privilegeLabels: Record<string, string> = {
    N: "无需预先权限",
    L: "需要低权限",
    H: "需要高权限",
  };
  const access = accessLabels[metrics.AV] ?? "攻击入口未知";
  const privilege = privilegeLabels[metrics.PR] ?? "权限条件未知";
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
  const { locale, t } = useI18n();
  const [showAll, setShowAll] = useState(false);
  const [priorityFilter, setPriorityFilter] = useState<"all" | "P0" | "P1" | "P2" | "P3" | "runtime">("all");
  const [selectedWorkspace, setSelectedWorkspace] = useState("all");
  const [scanningWorkspace, setScanningWorkspace] = useState("");
  const [scanFeedback, setScanFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const workspaceOptions = useMemo(() => {
    if (overview?.workspaceOptions?.length) return overview.workspaceOptions;
    return [...new Set((overview?.findings ?? []).map((finding) => finding.workspaceId))].map((workspaceId) => ({
      workspaceId,
      repositoryId: workspaceId,
      displayName: workspaceId,
    }));
  }, [overview?.findings, overview?.workspaceOptions]);
  const workspaceNames = useMemo(
    () => new Map(workspaceOptions.map((workspace) => [workspace.workspaceId, workspace.displayName])),
    [workspaceOptions],
  );
  const workspaceFindingCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const finding of overview?.findings ?? []) {
      counts.set(finding.workspaceId, (counts.get(finding.workspaceId) ?? 0) + 1);
    }
    return counts;
  }, [overview?.findings]);
  const findings = useMemo(() => {
    const runtimeEvidence = new Map<string, "observed" | "attack_chain">();
    for (const judgment of streamFindings?.compositeJudgments ?? []) {
      const attackChain = (judgment.ruleVersion === "supply-chain-exploit-v1"
        || judgment.ruleVersion === "supply-chain-temporal-v2")
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
    return (overview?.findings ?? [])
      .filter((finding) => selectedWorkspace === "all" || finding.workspaceId === selectedWorkspace)
      .map((finding) => {
      const exploitability = runtimeEvidence.get(finding.findingId) ?? "not_observed";
      const score = Math.min(
        100,
        finding.priorityScore + (exploitability === "attack_chain" ? 15 : exploitability === "observed" ? 5 : 0),
      );
      return {
        finding,
        exploitability,
        runtimeScore: exploitability === "attack_chain" ? 15 : exploitability === "observed" ? 5 : 0,
        priorityScore: score,
        priority: score >= 90 ? "P0" : score >= 60 ? "P1" : score >= 35 ? "P2" : "P3",
      };
    }).sort((left, right) => (
      right.priorityScore - left.priorityScore
      || right.finding.lastObservedAt - left.finding.lastObservedAt
    ));
  }, [overview?.findings, selectedWorkspace, streamFindings?.compositeJudgments]);
  if (!overview?.enabled) return null;
  const filteredFindings = findings.filter((item) => (
    priorityFilter === "all"
      ? true
      : priorityFilter === "runtime"
        ? item.exploitability !== "not_observed"
        : item.priority === priorityFilter
  ));
  const visibleFindings = showAll ? filteredFindings : filteredFindings.slice(0, 4);
  const highPriorityCount = findings.filter((item) => item.priority === "P0" || item.priority === "P1").length;
  const runtimeExposureCount = findings.filter((item) => item.exploitability !== "not_observed").length;
  const severityLabel = {
    critical: "严重",
    high: "高危",
    medium: "中危",
    low: "低危",
    unknown: "未知",
  };
  const requestWorkspaceScan = async () => {
    if (selectedWorkspace === "all") return;
    setScanningWorkspace(selectedWorkspace);
    setScanFeedback(null);
    try {
      const response = await securityCenterApi.scanSupplyChainWorkspace(selectedWorkspace);
      const workspaceName = workspaceNames.get(selectedWorkspace) ?? selectedWorkspace;
      setScanFeedback({
        type: "success",
        message: `已提交 ${workspaceName} 的扫描任务 ${response.task.taskId}。Workspace Scanner 领取后会更新依赖快照与 OSV 评估。`,
      });
    } catch (scanError) {
      setScanFeedback({
        type: "error",
        message: scanError instanceof Error ? scanError.message : "提交扫描任务失败",
      });
    } finally {
      setScanningWorkspace("");
    }
  };
  return (
    <Panel
      title="OSV 依赖漏洞资产"
      icon={ShieldAlert}
      action={(
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-zinc-600/50 bg-zinc-800/50 px-2.5 py-1 text-[11px] text-zinc-300">
            {t("当前资产快照 · 不受顶部时间范围影响")}
          </span>
          {overview.runtimeCorrelationEnabled && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-teal-400/30 bg-teal-400/10 px-2.5 py-1 text-[11px] text-teal-200">
              <GitBranch className="size-3" />
              {t("运行时关联已启用")}
            </span>
          )}
          <span className="inline-flex items-center gap-1.5 rounded-full border border-sky-400/30 bg-sky-400/10 px-2.5 py-1 text-[11px] text-sky-200">
            <EyeOff className="size-3" />
            {t("治理提醒 · 不代表漏洞正在被利用")}
          </span>
        </div>
      )}
    >
      <div className="space-y-4 p-4">
        <InlineError message={error} />
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-white/10 bg-white/[0.025] px-3 py-2.5">
          <div>
            <p className="text-[11px] font-medium text-zinc-300">{t("Workspace 范围")}</p>
            <p className="mt-0.5 text-[10px] text-zinc-600">
              {t("选择具体工作副本后，漏洞数量、优先级和列表同步过滤")}
            </p>
          </div>
          <div className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto">
            <Select
              value={selectedWorkspace}
              onValueChange={(value) => {
                setSelectedWorkspace(value);
                setPriorityFilter("all");
                setShowAll(false);
                setScanFeedback(null);
              }}
            >
              <SelectTrigger className="h-8 w-full border-white/10 bg-black/20 text-xs text-zinc-300 sm:w-[320px]">
                <SelectValue placeholder={t("选择 Workspace")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("全部 Workspace")} ({overview.openFindings})</SelectItem>
                {workspaceOptions.map((workspace) => (
                  <SelectItem key={workspace.workspaceId} value={workspace.workspaceId}>
                    {workspace.displayName}（{workspaceFindingCounts.get(workspace.workspaceId) ?? 0}）
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="outline"
              className="h-8 border-teal-400/30 bg-teal-400/5 px-3 text-xs text-teal-200 hover:bg-teal-400/10 hover:text-teal-100"
              disabled={selectedWorkspace === "all" || Boolean(scanningWorkspace)}
              title={t(selectedWorkspace === "all" ? "请先选择一个具体 Workspace" : "重新提取依赖并刷新 OSV 漏洞评估")}
              onClick={() => void requestWorkspaceScan()}
            >
              {scanningWorkspace ? (
                <LoaderCircle className="mr-1.5 size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="mr-1.5 size-3.5" />
              )}
              {t(scanningWorkspace ? "提交中" : "重新扫描")}
            </Button>
          </div>
        </div>
        {scanFeedback && (
          <div
            className={cn(
              "rounded-md border px-3 py-2 text-[11px]",
              scanFeedback.type === "success"
                ? "border-teal-400/25 bg-teal-400/[0.07] text-teal-200"
                : "border-red-400/25 bg-red-400/[0.07] text-red-200",
            )}
          >
            {scanFeedback.message}
          </div>
        )}
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-6">
          {[
            {
              label: "可信 Workspace",
              value: selectedWorkspace === "all" ? overview.workspaces : 1,
              detail: selectedWorkspace === "all"
                ? "按节点工作副本注册"
                : workspaceNames.get(selectedWorkspace) ?? selectedWorkspace,
            },
            { label: "有效依赖快照", value: overview.activeSnapshots, detail: "仅完整提取可生效" },
            { label: "开放漏洞", value: findings.length, detail: selectedWorkspace === "all" ? "全部 Workspace" : "当前 Workspace" },
            { label: "P0 / P1", value: highPriorityCount, detail: "优先处理的治理项" },
            { label: "运行中暴露", value: runtimeExposureCount, detail: "观察到组件运行或攻击链" },
            {
              label: "情报状态异常",
              value: findings.filter((item) => item.finding.status === "assessment_stale").length,
              detail: overview.latestAssessmentAt
                ? `最近评估 ${formatSecurityDateTime(overview.latestAssessmentAt, "MM-DD HH:mm")}`
                : "尚未完成评估",
            },
          ].map((item) => (
            <div key={item.label} className="rounded-md border border-white/10 bg-white/[0.025] px-3 py-2.5">
              <p className="text-[11px] text-zinc-500">{t(item.label)}</p>
              <p className="mt-1 text-lg font-semibold tabular-nums text-zinc-100">{item.value}</p>
              <p className="mt-0.5 text-[10px] text-zinc-600">{t(item.detail)}</p>
            </div>
          ))}
        </div>
        {findings.length === 0 ? (
          <EmptyState label="当前组件快照未发现已知漏洞" />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              {([
                ["all", `${locale === "en" ? "All" : "全部"} ${findings.length}`],
                ["P0", `P0 ${findings.filter((item) => item.priority === "P0").length}`],
                ["P1", `P1 ${findings.filter((item) => item.priority === "P1").length}`],
                ["P2", `P2 ${findings.filter((item) => item.priority === "P2").length}`],
                ["P3", `P3 ${findings.filter((item) => item.priority === "P3").length}`],
                ["runtime", `${t("运行中暴露")} ${runtimeExposureCount}`],
              ] as const).map(([value, label]) => (
                <Button
                  key={value}
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setPriorityFilter(value);
                    setShowAll(false);
                  }}
                  className={cn(
                    "h-7 border-white/10 px-2.5 text-[10px]",
                    priorityFilter === value
                      ? "bg-teal-400/10 text-teal-200"
                      : "bg-white/[0.025] text-zinc-400 hover:bg-white/[0.06]",
                  )}
                >
                  {label}
                </Button>
              ))}
            </div>
            {filteredFindings.length === 0 ? (
              <EmptyState label="当前筛选条件下没有漏洞治理项" />
            ) : (
            <div className="grid gap-3 xl:grid-cols-2">
            {visibleFindings.map(({ finding, exploitability, runtimeScore, priority, priorityScore }) => {
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
                        {t(stale ? "情报待刷新" : "存在已知漏洞")}
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
                        {t(finding.component.direct === true ? "直接依赖" : finding.component.direct === false ? "传递依赖" : "依赖层级未知")}
                      </span>
                    </div>
                    <div className="mt-3 rounded-md border border-white/[0.06] bg-white/[0.02] p-2.5">
                      <p className="text-[10px] font-medium text-zinc-500">{t("漏洞原因与影响")}</p>
                      <p className="mt-1.5 line-clamp-4 text-xs leading-5 text-zinc-300">
                        {finding.vulnerability.impactDescription
                          || finding.vulnerability.summary
                          || t("OSV 未提供漏洞原因说明")}
                      </p>
                      <div className="mt-2 grid gap-1 text-[10px] text-zinc-500">
                        <p><span className="text-zinc-600">{t("攻击条件：")}</span>{cvss.attackCondition}</p>
                        <p><span className="text-zinc-600">{t("安全影响：")}</span>{cvss.impact}</p>
                      </div>
                    </div>
                    {finding.vulnerability.aliases.length > 0 && (
                      <p className="mt-2 truncate text-[10px] text-zinc-600">
                        {t("别名")} {finding.vulnerability.aliases.join(" · ")}
                      </p>
                    )}
                    <div className="mt-3 grid gap-2 border-t border-white/[0.07] pt-3 sm:grid-cols-2">
                      <div>
                        <p className="text-[10px] text-zinc-600">{t("厂商严重度 / CVSS")}</p>
                        <p className="mt-1 text-[11px] text-zinc-300">
                          {t(severityLabel[finding.vulnerability.severityLevel ?? "unknown"])}
                          {finding.vulnerability.cvssScore !== undefined
                            ? ` · ${finding.vulnerability.cvssScore.toFixed(1)}`
                            : ` · ${t("暂无数值")}`}
                        </p>
                        {finding.vulnerability.vendorSeveritySource && (
                          <p className="mt-1 text-[9px] text-zinc-600">
                            {finding.vulnerability.vendorSeveritySource} {t("评级")}
                          </p>
                        )}
                        {finding.vulnerability.cvssVector && (
                          <p className="mt-1 truncate text-[9px] text-zinc-600" title={finding.vulnerability.cvssVector}>
                            {finding.vulnerability.cvssVector}
                          </p>
                        )}
                      </div>
                      <div>
                        <p className="text-[10px] text-zinc-600">{t("可用修复版本")}</p>
                        <p className="mt-1 truncate text-[11px] text-zinc-300">
                          {finding.vulnerability.fixedVersions?.length
                            ? finding.vulnerability.fixedVersions.slice(0, 3).join(" · ")
                            : t("OSV 未提供明确修复版本")}
                        </p>
                      </div>
                      <div>
                        <p className="text-[10px] text-zinc-600">{t("实际部署")}</p>
                        <p className={cn("mt-1 text-[11px]", deployed ? "text-teal-200" : "text-zinc-400")}>
                          {image
                            ? t("镜像内已确认")
                            : installedEnvironment
                              ? installedEnvironment.kind === "python_environment"
                                ? t("Workspace Python 环境已安装")
                                : t("Workspace node_modules 已安装")
                              : t("源码存在 · 部署状态未知")}
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
                        <p className="text-[10px] text-zinc-600">{t("运行时可利用性")}</p>
                        <p className={cn(
                          "mt-1 text-[11px]",
                          exploitability === "attack_chain"
                            ? "text-rose-200"
                            : exploitability === "observed" ? "text-amber-200" : "text-zinc-400",
                        )}>
                          {exploitability === "attack_chain"
                            ? t("已形成疑似利用链")
                            : exploitability === "observed"
                              ? t("已观察到组件运行证据")
                              : t("尚未观察到运行证据")}
                        </p>
                      </div>
                    </div>
                    <div className="mt-3 grid gap-2 border-t border-white/[0.07] pt-3 lg:grid-cols-2">
                      <div className="rounded-md border border-white/[0.06] bg-white/[0.02] p-2.5">
                        <p className="text-[10px] font-medium text-zinc-500">{t("优先级依据")}</p>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {(finding.priorityFactors ?? []).map((factor) => (
                            <span
                              key={factor.code}
                              title={factor.reason}
                              className="rounded border border-white/[0.08] bg-black/20 px-1.5 py-1 text-[9px] text-zinc-400"
                            >
                              {factor.code === "severity"
                                ? t("漏洞严重度")
                                : factor.code === "deployed"
                                  ? t("实际部署")
                                  : factor.code === "direct_dependency"
                                    ? t("直接依赖")
                                    : t("运行时依赖")} +{factor.score}
                            </span>
                          ))}
                          {runtimeScore > 0 && (
                            <span className="rounded border border-rose-400/20 bg-rose-400/[0.07] px-1.5 py-1 text-[9px] text-rose-200">
                              {t(exploitability === "attack_chain" ? "疑似利用链" : "运行证据")} +{runtimeScore}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="rounded-md border border-teal-400/15 bg-teal-400/[0.04] p-2.5">
                        <p className="text-[10px] font-medium text-teal-200">{t("建议处置")}</p>
                        <p className="mt-1.5 text-[11px] leading-5 text-zinc-300">
                          {exploitability === "attack_chain"
                            ? locale === "en"
                              ? "Review the related process and evidence chain first, isolate the affected runtime, then upgrade the component and rebuild the artifact after confirmation."
                              : "优先核查对应进程与证据链，隔离受影响运行环境；确认后再升级组件并重建制品。"
                            : finding.remediation?.action === "upgrade_direct_dependency"
                              ? locale === "en" ? "Upgrade the direct dependency, regenerate the lockfile, and run a full scan." : "升级直接依赖并重新生成锁文件，完成后触发一次完整扫描。"
                              : finding.remediation?.action === "upgrade_parent_dependency"
                                ? locale === "en" ? "Upgrade the parent dependency or add a safe version override, then verify the transitive dependency tree." : "升级引入该组件的顶层依赖或增加安全版本覆盖，再验证传递依赖树。"
                                : finding.remediation?.action === "update_deployed_artifact"
                                  ? locale === "en" ? "Update the component or base image, rebuild the artifact, and scan the new image digest." : "更新组件或基础镜像，重新构建制品，并扫描新的镜像摘要。"
                                  : finding.remediation?.action === "upgrade_component"
                                    ? locale === "en" ? "Upgrade to a compatible safe version and confirm closure with a full scan." : "升级到兼容的安全版本，并通过完整扫描确认漏洞已关闭。"
                                    : locale === "en" ? "No specific fix is available; monitor the advisory and reduce component exposure." : "当前情报没有明确修复版本；持续跟踪公告并减少组件暴露面。"}
                        </p>
                        {finding.remediation?.candidateFixedVersion && (
                          <p className="mt-1.5 text-[10px] text-teal-300">
                            {t("OSV 修复候选")}：{finding.remediation.candidateFixedVersion}
                            {finding.remediation.requiresArtifactRebuild ? ` · ${t("需要重建制品")}` : ""}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-3 border-t border-white/[0.07] pt-3 text-[10px] text-zinc-600">
                    <span className="min-w-0 truncate" title={finding.workspaceId}>
                      Workspace {workspaceNames.get(finding.workspaceId) ?? finding.workspaceId}
                    </span>
                    <span>{t("评估")} {formatSecurityDateTime(finding.lastObservedAt, "MM-DD HH:mm")}</span>
                  </div>
                </div>
              );
            })}
            </div>
            )}
            {filteredFindings.length > 4 && (
              <div className="flex justify-center">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setShowAll((value) => !value)}
                  className="border-white/10 bg-white/[0.025] text-xs text-zinc-300 hover:bg-white/[0.06]"
                >
                  {showAll ? t("收起漏洞") : `${t("显示全部漏洞")}（${filteredFindings.length}）`}
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
  const timestamp = parseSecurityTimestamp(value);
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
    selectedAgentAssetId: agent.agentAssetId,
  });
  if (agent.agentInstanceId) query.set("selectedAgentInstanceId", agent.agentInstanceId);
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

function agentInstanceEventsHref(agent: AgentInventoryItem, filter: SecurityTimeFilter) {
  const query = new URLSearchParams({
    timeType: filter.timeType ?? "last_3h",
    agentAssetId: agent.agentAssetId,
  });
  if (agent.agentInstanceId) query.set("agentInstanceId", agent.agentInstanceId);
  if (filter.startTime) query.set("startTime", filter.startTime);
  if (filter.endTime) query.set("endTime", filter.endTime);
  return `/events?${query.toString()}`;
}

function agentRuntimeSelectionKey(agent: AgentInventoryItem): string {
  return `${agent.agentAssetId}\0${agent.agentInstanceId ?? "metadata"}`;
}

type AgentInstanceView = "cards" | "trends";

interface AgentMetricSeries {
  label: string;
  color: string;
  value: (point: AgentInstanceMetricPoint) => number;
}

function AgentInstanceLineChart({
  title,
  subtitle,
  points,
  series,
}: {
  title: string;
  subtitle: string;
  points: AgentInstanceMetricPoint[];
  series: AgentMetricSeries[];
}) {
  const { t } = useI18n();
  const chartTheme = useVChartTheme();
  const chartData = useMemo(
    () => points.flatMap((point) => series.map((item) => ({
      time: formatTimeLabel(point.statTime),
      type: t(item.label),
      value: item.value(point),
    }))),
    [points, series, t],
  );
  const spec = useMemo<VChartSpec>(
    () => ({
      type: "line",
      data: [{ id: "agent-instance-metrics", values: chartData }],
      xField: "time",
      yField: "value",
      seriesField: "type",
      color: series.map((item) => item.color),
      padding: { top: 8, right: 14, bottom: 4, left: 0 },
      animation: false,
      tooltip: {
        visible: true,
        mark: { title: { value: "time" } },
      },
      legends: {
        visible: true,
        orient: "bottom",
        padding: { top: 4 },
        item: {
          label: { style: { fill: chartTheme.axisLabel, fontSize: 10 } },
          shape: { style: { symbolType: "circle" } },
        },
      },
      axes: [
        {
          orient: "bottom",
          tick: { visible: false },
          domainLine: { visible: false },
          label: { style: { fill: chartTheme.axisSubLabel, fontSize: 9 } },
        },
        {
          orient: "left",
          min: 0,
          tick: { visible: false },
          domainLine: { visible: false },
          grid: { visible: true, style: { stroke: "#202733", lineWidth: 1 } },
          label: { style: { fill: chartTheme.axisSubLabel, fontSize: 9 } },
        },
      ],
      line: { style: { curveType: "monotone", lineWidth: 2 } },
      point: { visible: false },
    }),
    [chartData, chartTheme, series],
  );

  return (
    <div className="min-w-0 rounded-lg border border-[#232a37] bg-black/10">
      <div className="border-b border-[#232a37] px-3.5 py-3">
        <h4 className="text-xs font-semibold text-zinc-200">{t(title)}</h4>
        <p className="mt-0.5 text-[10px] text-zinc-600">{t(subtitle)}</p>
      </div>
      <div
        className="h-[220px] min-h-0 px-2 pb-2 pt-1"
        aria-label={`${t(title)}：${t(subtitle)}`}
      >
        {chartData.length > 0 ? <VChartView spec={spec} /> : <EmptyState label="暂无实例时间序列" />}
      </div>
    </div>
  );
}

const AGENT_INSTANCE_BEHAVIOR: Array<{
  key: AgentEventCategory;
  label: string;
  color: string;
}> = [
  { key: "tool", label: "工具", color: "bg-teal-300" },
  { key: "file", label: "文件", color: "bg-sky-300" },
  { key: "network", label: "网络", color: "bg-orange-300" },
  { key: "process", label: "进程", color: "bg-violet-300" },
  { key: "llm", label: "LLM", color: "bg-pink-300" },
];

function agentInstanceLifecycleLabel(agent: AgentInventoryItem): string {
  if (agent.lifecycleState === "current") return "当前窗口";
  if (agent.lifecycleState === "terminated") return "已结束";
  return "历史窗口";
}

function AgentInstanceOverviewCard({
  agent,
  filter,
}: {
  agent: AgentInventoryItem;
  filter: SecurityTimeFilter;
}) {
  const { t } = useI18n();
  const tone = riskTone(agent.riskLevel);
  const behaviorTotal = AGENT_INSTANCE_BEHAVIOR.reduce(
    (total, item) => total + (agent.eventCategoryCounts[item.key] ?? 0),
    0,
  );

  return (
    <article
      className={cn(
        "min-w-0 overflow-hidden rounded-lg border bg-white/[0.025]",
        tone.border,
      )}
      style={{ contentVisibility: "auto", containIntrinsicSize: "300px" }}
    >
      <div className="flex items-start justify-between gap-3 border-b border-white/[0.07] px-3.5 py-3">
        <AgentAssetIdentityInline agent={agent} showClassification className="min-w-0" />
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <StatusPill level={agent.riskLevel} label={agent.riskLevelText} />
          <span className={cn(
            "rounded border px-1.5 py-0.5 text-[9px] font-medium",
            agent.lifecycleState === "current"
              ? "border-teal-400/25 bg-teal-400/10 text-teal-200"
              : agent.lifecycleState === "terminated"
                ? "border-zinc-500/25 bg-zinc-500/10 text-zinc-400"
                : "border-amber-400/25 bg-amber-400/10 text-amber-200",
          )}>
            {t(agentInstanceLifecycleLabel(agent))}
          </span>
        </div>
      </div>

      <div className="space-y-3 p-3.5">
        <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-[10px]">
          <div className="min-w-0">
            <p className="text-zinc-600">{t("窗口实例")}</p>
            <p className="mt-0.5 truncate font-mono text-zinc-400" title={agent.agentInstanceId || agent.agentAssetId}>
              {agent.agentInstanceId || "metadata-only"}
            </p>
          </div>
          <div>
            <p className="text-zinc-600">{t("Root PID")}</p>
            <p className="mt-0.5 font-mono text-zinc-400">{agent.rootPid ?? "--"}</p>
          </div>
          <div className="min-w-0">
            <p className="text-zinc-600">{t("首次观测")}</p>
            <p className="mt-0.5 truncate font-mono text-zinc-400">{formatDate(agent.firstSeen)}</p>
          </div>
          <div className="min-w-0">
            <p className="text-zinc-600">{t("最近活动")}</p>
            <p className="mt-0.5 truncate font-mono text-zinc-400">{formatDate(agent.lastSeen)}</p>
          </div>
        </div>

        <div className="grid grid-cols-4 gap-1.5">
          {[
            { label: "事件", value: formatCompactNumber(agent.eventCount), tone: "text-zinc-100" },
            { label: "风险", value: formatCompactNumber(agent.riskyEventCount), tone: "text-rose-200" },
            { label: "延迟", value: `${formatNumber(agent.avgLatencyMs)}ms`, tone: "text-sky-200" },
            { label: "Token", value: formatCompactNumber(agent.tokenCount), tone: "text-amber-200" },
          ].map((item) => (
            <div key={item.label} className="min-w-0 rounded-md border border-white/[0.07] bg-black/15 px-2 py-2">
              <p className="truncate text-[9px] text-zinc-600">{t(item.label)}</p>
              <p className={cn("mt-0.5 truncate text-sm font-semibold tabular-nums", item.tone)}>{item.value}</p>
            </div>
          ))}
        </div>

        <div className="rounded-md border border-white/[0.07] bg-black/15 p-2.5">
          <div className="mb-2 flex items-center justify-between gap-3">
            <p className="text-[10px] font-medium text-zinc-400">{t("行为构成")}</p>
            <p className="text-[9px] text-zinc-600">
              {t("会话")} {formatNumber(agent.sessionCount)} · Trace {formatNumber(agent.traceCount)}
            </p>
          </div>
          <div className="grid grid-cols-5 gap-1.5">
            {AGENT_INSTANCE_BEHAVIOR.map((item) => {
              const value = agent.eventCategoryCounts[item.key] ?? 0;
              const width = behaviorTotal > 0 ? Math.max(value > 0 ? 5 : 0, (value / behaviorTotal) * 100) : 0;
              return (
                <div key={item.key} className="min-w-0">
                  <div className="mb-1 flex items-center justify-between gap-1 text-[9px]">
                    <span className="truncate text-zinc-600">{t(item.label)}</span>
                    <span className="tabular-nums text-zinc-400">{formatCompactNumber(value)}</span>
                  </div>
                  <div className="h-1 overflow-hidden rounded-full bg-white/[0.06]">
                    <div className={cn("h-full rounded-full", item.color)} style={{ width: `${width}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-white/[0.07] pt-3">
          <p className="min-w-0 truncate text-[10px] text-zinc-600" title={agent.lastEventSubject || ""}>
            {agent.lastEventSubject || t("暂无活动摘要")}
          </p>
          <Link
            to={agentInstanceEventsHref(agent, filter)}
            className="shrink-0 text-[10px] font-medium text-teal-300 hover:text-teal-200"
          >
            {t("查看窗口事件")} →
          </Link>
        </div>
      </div>
    </article>
  );
}

function AgentInstanceTrendsPanel({
  inventory,
  inventoryError,
  inventoryLoading,
  filter,
}: {
  inventory?: AgentInventory | null;
  inventoryError?: string;
  inventoryLoading?: boolean;
  filter: SecurityTimeFilter;
}) {
  const { locale, t } = useI18n();
  const [view, setView] = useState<AgentInstanceView>("cards");
  const agents = useMemo(
    () => (inventory?.items ?? [])
      .filter((agent) => agent.classification !== "non_agent")
      .sort((a, b) =>
        Number(b.lifecycleState === "current") - Number(a.lifecycleState === "current")
        || Number(b.healthState === "active") - Number(a.healthState === "active")
        || securityTimestampValue(b.lastSeen) - securityTimestampValue(a.lastSeen)
      ),
    [inventory],
  );
  const [selectedAgentKey, setSelectedAgentKey] = useState("");

  useEffect(() => {
    if (agents.length === 0) {
      setSelectedAgentKey("");
      return;
    }
    if (!agents.some((agent) => agentRuntimeSelectionKey(agent) === selectedAgentKey)) {
      setSelectedAgentKey(agentRuntimeSelectionKey(agents[0]));
    }
  }, [agents, selectedAgentKey]);

  const selectedAgent = agents.find((agent) => agentRuntimeSelectionKey(agent) === selectedAgentKey) ?? agents[0];
  const { data: metrics, loading: metricsLoading, error: metricsError } = useRequest<AgentInstanceMetrics, []>(
    () => securityCenterApi.agentInstanceMetrics({
      ...filter,
      scope: "agent",
      agentAssetId: selectedAgent?.agentAssetId ?? "",
      agentInstanceId: selectedAgent?.agentInstanceId,
      seriesPoints: 36,
    }),
    {
      ready: view === "trends" && Boolean(selectedAgent?.agentAssetId),
      refreshDeps: [
        view,
        selectedAgent?.agentAssetId,
        selectedAgent?.agentInstanceId,
        filter.timeType,
        filter.startTime,
        filter.endTime,
        filter.snapshotAsOf,
      ],
      pollingInterval: 15000,
      pollingWhenHidden: false,
    },
  );

  const activitySeries = useMemo<AgentMetricSeries[]>(() => [
    { label: "总事件", color: "#2dd4bf", value: (point) => point.eventCount },
    { label: "风险事件", color: "#fb7185", value: (point) => point.riskyEventCount },
  ], []);
  const behaviorSeries = useMemo<AgentMetricSeries[]>(() => [
    { label: "工具", color: "#2dd4bf", value: (point) => point.toolCount },
    { label: "文件", color: "#60a5fa", value: (point) => point.fileCount },
    { label: "网络", color: "#fb923c", value: (point) => point.networkCount },
    { label: "进程", color: "#a78bfa", value: (point) => point.processCount },
    { label: "LLM", color: "#f472b6", value: (point) => point.llmCount },
  ], []);
  const judgmentSeries = useMemo<AgentMetricSeries[]>(() => [
    { label: "L1", color: "#2dd4bf", value: (point) => point.l1Count },
    { label: "L2", color: "#fbbf24", value: (point) => point.l2Count },
    { label: "L3", color: "#fb923c", value: (point) => point.l3Count },
    { label: "异常", color: "#fb7185", value: (point) => point.failedCount + point.timeoutCount },
  ], []);

  const currentCount = agents.filter((agent) => agent.lifecycleState === "current").length;
  const riskyCount = agents.filter((agent) => agent.riskyEventCount > 0).length;
  const eventCount = agents.reduce((total, agent) => total + agent.eventCount, 0);
  const weightedLatency = eventCount > 0
    ? Math.round(agents.reduce((total, agent) => total + agent.avgLatencyMs * agent.eventCount, 0) / eventCount)
    : 0;

  return (
    <Panel
      title="Agent 态势"
      icon={Bot}
      action={(
        <div className="flex items-center gap-2">
          <span className="hidden text-[10px] text-zinc-500 sm:inline">
            {t("每个运行窗口独立展示")} · {formatNumber(inventory?.total ?? agents.length)}
          </span>
          <div
            role="group"
            aria-label={t("Agent 态势视图")}
            className="inline-flex rounded-md border border-white/10 bg-black/20 p-0.5"
          >
            {([
              { value: "cards", label: "卡片", icon: LayoutDashboard },
              { value: "trends", label: "趋势", icon: BarChart3 },
            ] as const).map((item) => {
              const Icon = item.icon;
              const selected = view === item.value;
              return (
                <button
                  key={item.value}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setView(item.value)}
                  className={cn(
                    "inline-flex h-7 items-center gap-1.5 rounded px-2 text-[10px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-300/60",
                    selected
                      ? "bg-teal-400/15 text-teal-200"
                      : "text-zinc-500 hover:bg-white/[0.05] hover:text-zinc-300",
                  )}
                >
                  <Icon className="size-3" aria-hidden="true" />
                  {t(item.label)}
                </button>
              );
            })}
          </div>
        </div>
      )}
    >
      <div className="space-y-4 p-4">
        <InlineError
          message={inventoryError || (view === "trends" && metricsError
            ? formatRequestError(metricsError)
            : undefined)}
        />
        {inventoryLoading && !inventory ? (
          <div className="flex min-h-32 items-center justify-center gap-2 text-xs text-zinc-500">
            <LoaderCircle className="size-4 animate-spin" />
            {t("正在加载 Agent 运行窗口…")}
          </div>
        ) : agents.length === 0 ? (
          <EmptyState label="暂无 Agent 实例数据" />
        ) : (
          <>
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              {[
                { label: "运行窗口", value: agents.length, detail: "每个终端 / Agent 进程独立" },
                { label: "当前活跃", value: currentCount, detail: "仍在当前生命周期内" },
                { label: "存在风险", value: riskyCount, detail: "窗口内包含风险事件" },
                { label: "事件 / 平均延迟", value: formatCompactNumber(eventCount), detail: `${formatNumber(weightedLatency)}ms` },
              ].map((item) => (
                <div key={item.label} className="rounded-md border border-white/10 bg-white/[0.025] px-3 py-2.5">
                  <p className="text-[10px] text-zinc-600">{t(item.label)}</p>
                  <p className="mt-1 text-lg font-semibold tabular-nums text-zinc-100">{item.value}</p>
                  <p className="mt-0.5 text-[10px] text-zinc-600">{t(item.detail)}</p>
                </div>
              ))}
            </div>
            {view === "cards" ? (
              <div className="grid gap-3 xl:grid-cols-2 2xl:grid-cols-3">
                {agents.map((agent) => (
                  <AgentInstanceOverviewCard
                    key={agentRuntimeSelectionKey(agent)}
                    agent={agent}
                    filter={filter}
                  />
                ))}
              </div>
            ) : (
              <>
                <div className="grid gap-3 lg:grid-cols-[minmax(260px,1.2fr)_repeat(4,minmax(118px,0.65fr))]">
                  <div className="rounded-lg border border-[#232a37] bg-black/10 p-3">
                    <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-zinc-600">
                      {t("选择 Agent 实例")}
                    </p>
                    <Select
                      value={selectedAgent ? agentRuntimeSelectionKey(selectedAgent) : ""}
                      onValueChange={setSelectedAgentKey}
                    >
                      <SelectTrigger className="h-auto min-h-10 border-white/10 bg-[#151a23] py-2 text-left">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {agents.map((agent) => (
                          <SelectItem
                            key={agentRuntimeSelectionKey(agent)}
                            value={agentRuntimeSelectionKey(agent)}
                          >
                            {(agent.displayName || agent.agentId)} · {agent.locationLabel || agent.workspacePath || agent.agentAssetId.slice(0, 12)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {selectedAgent && (
                      <div className="mt-3">
                        <AgentAssetIdentityInline agent={selectedAgent} showClassification className="min-w-0" />
                      </div>
                    )}
                  </div>
                  {[
                    { label: "总事件", value: metrics?.eventCount, tone: "text-zinc-50" },
                    { label: "风险事件", value: metrics?.riskyEventCount, tone: "text-rose-200" },
                    {
                      label: "平均延迟",
                      value: metrics ? `${formatNumber(metrics.avgLatencyMs)}ms` : "--",
                      tone: "text-sky-200",
                      raw: true,
                    },
                    { label: "Token", value: metrics?.tokenCount, tone: "text-amber-200" },
                  ].map((item) => (
                    <div key={item.label} className="rounded-lg border border-[#232a37] bg-black/10 p-3">
                      <p className="text-[10px] text-zinc-600">{t(item.label)}</p>
                      <p className={cn("mt-2 text-2xl font-semibold tabular-nums", item.tone)}>
                        {metricsLoading
                          ? "…"
                          : item.raw
                            ? item.value
                            : formatCompactNumber(item.value as number | undefined)}
                      </p>
                    </div>
                  ))}
                </div>
                <div className="flex flex-wrap items-center gap-2 text-[10px] text-zinc-500">
                  <span className="rounded border border-white/10 bg-white/[0.03] px-2 py-1">
                    {t("阻断")} {formatNumber(metrics?.blockedCount)}
                  </span>
                  <span className="rounded border border-white/10 bg-white/[0.03] px-2 py-1">
                    {t("升级")} {formatNumber(metrics?.escalatedCount)}
                  </span>
                  <span className="rounded border border-white/10 bg-white/[0.03] px-2 py-1">
                    {t("异常")} {formatNumber((metrics?.failedCount ?? 0) + (metrics?.timeoutCount ?? 0))}
                  </span>
                  {selectedAgent && (
                    <Link
                      to={agentInstanceEventsHref(selectedAgent, filter)}
                      className="font-medium text-teal-300 hover:text-teal-200 sm:ml-auto"
                    >
                      {t("查看窗口事件")} →
                    </Link>
                  )}
                  {metrics?.updateTime && (
                    <span className={cn(selectedAgent ? "" : "sm:ml-auto")}>
                      {locale === "en" ? "Updated" : "更新"} {formatDate(metrics.updateTime)}
                    </span>
                  )}
                </div>
                <div className="grid gap-4 xl:grid-cols-3">
                  <AgentInstanceLineChart
                    title="活动与风险"
                    subtitle="实例事件量与风险事件变化"
                    points={metrics?.points ?? []}
                    series={activitySeries}
                  />
                  <AgentInstanceLineChart
                    title="行为构成"
                    subtitle="工具、文件、网络、进程与 LLM 活动"
                    points={metrics?.points ?? []}
                    series={behaviorSeries}
                  />
                  <AgentInstanceLineChart
                    title="研判链路"
                    subtitle="L1、L2、L3 与异常结果"
                    points={metrics?.points ?? []}
                    series={judgmentSeries}
                  />
                </div>
              </>
            )}
          </>
        )}
      </div>
    </Panel>
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
  return [
    profile.tenantId,
    profile.environmentId,
    profile.agentInstanceId || `legacy:${profile.agentCorrelationId}`,
  ].join(":");
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
  const contributions: Array<{
    key: string;
    label: string;
    value: number;
    score: number;
  }> = weighted.map(([key, weight, cap]) => ({
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

type CompositeJudgment = StreamFindingList["compositeJudgments"][number];

interface CompositeIncidentView {
  latest: CompositeJudgment;
  occurrences: CompositeJudgment[];
  firstSeenAt: number;
  lastSeenAt: number;
}

function compositeIncidentIdentity(judgment: CompositeJudgment): string {
  const entityAnchors = [...new Set(judgment.evidence.flatMap((item) => [
    item.resource,
    item.destination,
    ...(item.runtimeVulnerabilities ?? []).map((match) =>
      `${match.ecosystem}:${match.packageName}@${match.version}:${match.vulnerabilityId}`),
  ]).filter((value): value is string => Boolean(value?.trim())))]
    .sort()
    .join("|");
  return [
    judgment.synthetic ? "synthetic" : "production",
    judgment.tenantId,
    judgment.environmentId,
    judgment.agentCorrelationId,
    judgment.workspaceId,
    judgment.sessionId,
    judgment.ruleVersion,
    judgment.attackType ?? "none",
    entityAnchors,
  ].join("\0");
}

function groupCompositeIncidents(judgments: CompositeJudgment[]): CompositeIncidentView[] {
  const incidentGapMs = 10 * 60_000;
  const groups = new Map<string, CompositeIncidentView[]>();
  for (const judgment of [...judgments].sort((left, right) => left.windowStart - right.windowStart)) {
    const key = compositeIncidentIdentity(judgment);
    const incidents = groups.get(key) ?? [];
    const current = incidents[incidents.length - 1];
    if (current && judgment.windowStart - current.lastSeenAt <= incidentGapMs) {
      current.occurrences.push(judgment);
      current.lastSeenAt = Math.max(current.lastSeenAt, judgment.windowEnd);
      if ((judgment.updateJudgedAt ?? judgment.judgedAt) >=
        (current.latest.updateJudgedAt ?? current.latest.judgedAt)) {
        current.latest = judgment;
      }
    } else {
      incidents.push({
        latest: judgment,
        occurrences: [judgment],
        firstSeenAt: judgment.windowStart,
        lastSeenAt: judgment.windowEnd,
      });
    }
    groups.set(key, incidents);
  }
  return [...groups.values()].flat()
    .sort((left, right) => right.lastSeenAt - left.lastSeenAt);
}

function AgentRiskOverviewPanel({
  inventory,
  findings,
  inventoryError,
  findingsError,
  inventoryLoading = false,
  filter,
  assetsOnly = false,
}: {
  inventory?: AgentInventory | null;
  findings?: StreamFindingList | null;
  inventoryError?: string;
  findingsError?: string;
  inventoryLoading?: boolean;
  filter: SecurityTimeFilter;
  assetsOnly?: boolean;
}) {
  const { locale, t } = useI18n();
  const [view, setView] = useState<AgentRiskView>("assets");
  const [tab, setTab] = useState<StreamPanelTab>("profiles");
  const [showSafe, setShowSafe] = useState(false);
  const [showSynthetic, setShowSynthetic] = useState(false);
  const [visibleAgentCount, setVisibleAgentCount] = useState(8);
  const agentAssets = useMemo(() => (inventory?.items ?? [])
    .filter((agent) => agent.classification === "confirmed_agent" || agent.classification === "probable_agent")
    .sort((a, b) =>
      AGENT_CLASSIFICATION_ORDER[a.classification] - AGENT_CLASSIFICATION_ORDER[b.classification]
      || (AGENT_RISK_ORDER[a.riskLevel] ?? 6) - (AGENT_RISK_ORDER[b.riskLevel] ?? 6)
      || b.openIncidentCount - a.openIncidentCount
      || b.riskyEventCount - a.riskyEventCount
      || securityTimestampValue(b.lastSeen) - securityTimestampValue(a.lastSeen)), [inventory?.items]);
  const visibleAgentAssets = agentAssets.slice(0, visibleAgentCount);
  const agentAssetTotal = inventory?.summary.totalAgents ?? agentAssets.length;
  const agentInstancesById = useMemo(() => new Map(
    agentAssets
      .filter((agent) => Boolean(agent.agentInstanceId))
      .map((agent) => [agent.agentInstanceId as string, agent]),
  ), [agentAssets]);
  const profileViews = useMemo(() => {
    const groups = new Map<string, StreamFindingList["riskProfiles"]>();
    for (const profile of findings?.riskProfiles ?? []) {
      const key = streamProfileKey(profile);
      const history = groups.get(key) ?? [];
      history.push(profile);
      groups.set(key, history);
    }
    return [...groups.values()]
      .flatMap((history) => {
        history.sort((a, b) => b.calculatedAt - a.calculatedAt);
        const profile = history[0];
        return profile ? [{ profile, previousScore: history[1]?.riskScore }] : [];
      })
      .sort((a, b) => Math.max(0, b.profile.riskScore) - Math.max(0, a.profile.riskScore));
  }, [findings?.riskProfiles]);
  const riskyProfiles = profileViews.filter(({ profile }) => profile.riskLevel !== "safe" || profile.riskScore > 0);
  const safeProfiles = profileViews.filter(({ profile }) => profile.riskLevel === "safe" && profile.riskScore <= 0);
  const visibleProfiles = showSafe ? profileViews : riskyProfiles;
  const compositeRisks = findings?.compositeRisks ?? [];
  const compositeJudgments = findings?.compositeJudgments ?? [];
  const legacyCompositeJudgments = compositeJudgments.filter((item) =>
    item.ruleVersion === "composite-risk-v2" || item.ruleVersion === "supply-chain-exploit-v1");
  const currentCompositeJudgments = compositeJudgments.filter((item) =>
    item.ruleVersion !== "composite-risk-v2" && item.ruleVersion !== "supply-chain-exploit-v1");
  const syntheticEpisodes = currentCompositeJudgments.filter((item) => item.synthetic);
  const suppressedEpisodes = currentCompositeJudgments.filter((item) =>
    item.status === "suppressed" || item.error === "Historical episode suppressed before model evaluation");
  const productionCompositeJudgments = currentCompositeJudgments.filter((item) =>
    !item.synthetic && !suppressedEpisodes.includes(item));
  const visibleCompositeJudgments = currentCompositeJudgments.filter((item) =>
    !suppressedEpisodes.includes(item) && (!item.synthetic || showSynthetic));
  const visibleCompositeIncidents = useMemo(
    () => groupCompositeIncidents(visibleCompositeJudgments),
    [visibleCompositeJudgments],
  );
  const productionCompositeIncidents = useMemo(
    () => groupCompositeIncidents(productionCompositeJudgments),
    [productionCompositeJudgments],
  );
  const blockedEpisodes = productionCompositeIncidents.filter(({ latest: item }) =>
    item.status === "succeeded" && item.classification === "confirmed_attack" && item.verdict === "block");
  const failedEpisodes = productionCompositeIncidents.filter(({ latest: item }) =>
    item.status === "failed" || item.status === "timeout" || item.updateStatus === "failed" || item.updateStatus === "timeout");
  const pendingEpisodes = productionCompositeIncidents.filter(({ latest: item }) =>
    item.status === "pending" || item.updateStatus === "pending");
  const latestCalculatedAt = Math.max(
    0,
    ...profileViews.map(({ profile }) => profile.calculatedAt),
    ...compositeRisks.map((risk) => risk.calculatedAt),
    ...productionCompositeJudgments.map((judgment) => judgment.updateJudgedAt ?? judgment.judgedAt),
  );
  const ruleVersions = [...new Set(profileViews.map(({ profile }) => profile.ruleVersion).filter(Boolean))];
  const tabs: Array<{ key: StreamPanelTab; label: string; count?: number }> = [
    { key: "profiles", label: "风险画像", count: riskyProfiles.length },
    { key: "composites", label: "复合攻击链", count: productionCompositeIncidents.length },
    { key: "runtime", label: "流处理状态" },
  ];

  return (
    <Panel
      title={assetsOnly ? "Agent 列表" : "智能体风险概览"}
      icon={assetsOnly ? Bot : Sparkles}
      action={
        <Link to={allAgentsHref(filter)} className="text-xs text-teal-300 transition hover:text-teal-200">
          {t("查看全部智能体")} →
        </Link>
      }
    >
      <div className="space-y-4 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-zinc-500">{t("集中查看智能体身份、运行状态与近期关联风险")}</p>
          {!assetsOnly && (
            <div className="inline-flex rounded-md border border-white/10 bg-black/20 p-1" aria-label="智能体风险概览视角">
              {([
                { key: "assets" as const, label: t("Agent 列表"), count: agentAssetTotal },
                { key: "window" as const, label: t("Flink 风险画像"), count: profileViews.length },
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
          )}
        </div>

        {assetsOnly || view === "assets" ? (
          <div className="space-y-4">
            <InlineError message={inventoryError} />
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              {[
                { label: "运行实例", value: agentAssetTotal, detail: "逻辑身份共享、运行窗口独立" },
                { label: "活跃", value: inventory?.summary.activeAgents ?? 0, detail: "当前时间范围内有活动" },
                { label: "存在风险", value: inventory?.summary.riskyAgents ?? 0, detail: "包含风险事件" },
                { label: "待处理风险", value: inventory?.summary.openIncidentAgents ?? 0, detail: "需要进一步处置" },
              ].map((item) => (
                <div key={item.label} className="rounded-md border border-white/10 bg-white/[0.025] px-3 py-2.5">
                  <p className="text-[11px] text-zinc-500">{item.label}</p>
                  <p className="mt-1 text-lg font-semibold tabular-nums text-zinc-100">
                    {inventoryLoading && !inventory ? "--" : formatNumber(item.value)}
                  </p>
                  <p className="mt-0.5 text-[10px] text-zinc-600">{item.detail}</p>
                </div>
              ))}
            </div>

            {inventoryLoading && !inventory ? (
              <div className="flex min-h-28 items-center justify-center gap-2 text-xs text-zinc-500">
                <LoaderCircle className="size-4 animate-spin" />
                正在加载精确 Agent 统计…
              </div>
            ) : agentAssets.length === 0 ? (
              <EmptyState label="暂无已确认或候选智能体" />
            ) : (
              <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-4">
                {visibleAgentAssets.map((agent) => (
                  <AgentOverviewCard key={agentRuntimeSelectionKey(agent)} agent={agent} filter={filter} />
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
                进入 Agent 列表 →
              </Link>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <InlineError message={findingsError} />
            {!findings?.enabled ? (
              <div className="rounded-md border border-dashed border-white/10 px-4 py-10 text-center">
                <p className="text-sm font-medium text-zinc-300">{t("流式分析当前未启用")}</p>
                <p className="mt-1 text-xs text-zinc-600">{t("现有 L1 / L2 / L3 研判链路不受影响")}</p>
              </div>
            ) : (
              <>
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              {[
                { label: "Flink 风险画像实体", value: profileViews.length, detail: "每个 Agent 运行实例独立画像" },
                { label: "风险画像", value: riskyProfiles.length, detail: locale === "en" ? `${safeProfiles.length} safe profiles hidden` : `${safeProfiles.length} 个安全画像已折叠` },
                { label: "高风险攻击链", value: blockedEpisodes.length, detail: locale === "en" ? `${pendingEpisodes.length} pending / ${failedEpisodes.length} abnormal` : `${pendingEpisodes.length} 待研判 / ${failedEpisodes.length} 异常` },
                { label: "最新计算", value: latestCalculatedAt ? dayjs(latestCalculatedAt).format("HH:mm:ss") : "--", detail: latestCalculatedAt ? dayjs(latestCalculatedAt).format("MM-DD") : "暂无结果" },
              ].map((item) => (
                <div key={item.label} className="rounded-md border border-white/10 bg-white/[0.025] px-3 py-2.5">
                  <p className="text-[11px] text-zinc-500">{t(item.label)}</p>
                  <p className="mt-1 text-lg font-semibold tabular-nums text-zinc-100">{item.value}</p>
                  <p className="mt-0.5 text-[10px] text-zinc-600">{t(item.detail)}</p>
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
                  {t(item.label)}{item.count === undefined ? "" : " · " + item.count}
                </button>
              ))}
            </div>

            {tab === "profiles" && (
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-zinc-100">{t("Flink Agent 实例风险画像")}</p>
                    <p className="mt-0.5 text-xs text-zinc-500">{t("每个运行窗口按稳定实例 ID 独立画像；同名、同 Workspace 不合并")}</p>
                  </div>
                  {safeProfiles.length > 0 && (
                    <button type="button" onClick={() => setShowSafe((value) => !value)} className="text-xs text-teal-300 hover:text-teal-200">
                      {showSafe ? t("隐藏安全资产") : `${t("显示安全资产")}（${safeProfiles.length}）`}
                    </button>
                  )}
                </div>
                {visibleProfiles.length === 0 ? (
                  <EmptyState label={safeProfiles.length ? "当前没有风险画像" : "暂无时间窗风险画像"} />
                ) : (
                  <div className="grid gap-3 xl:grid-cols-2">
                    {visibleProfiles.map(({ profile, previousScore }) => {
                      const workspacePath = streamWorkspacePath(profile.workspacePath);
                      const agentInstance = agentInstancesById.get(profile.agentInstanceId);
                      const contributions = streamScoreContributions(profile);
                      const score = Math.max(0, profile.riskScore);
                      const delta = previousScore === undefined ? undefined : score - Math.max(0, previousScore);
                      const tone = riskTone(profile.riskLevel);
                      const query = new URLSearchParams({ agentId: profile.agentType });
                      if (workspacePath) query.set("workspacePath", workspacePath);
                      if (profile.agentInstanceId) query.set("agentInstanceId", profile.agentInstanceId);
                      return (
                        <div key={streamProfileKey(profile)} className={cn("rounded-lg border bg-white/[0.025] p-4", tone.border)}>
                          <div className="flex items-start justify-between gap-4">
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <Bot className="size-4 text-teal-300" />
                                <p className="truncate text-sm font-semibold text-zinc-100">
                                  {agentInstance?.displayName || profile.agentType} · {t(streamWorkspaceName(workspacePath))}
                                </p>
                              </div>
                              <p className="mt-1 truncate text-[11px] text-zinc-500" title={workspacePath || t("未绑定规范 Workspace")}>
                                {workspacePath || t("未绑定规范 Workspace")}
                              </p>
                              <p className="mt-0.5 truncate text-[10px] text-zinc-600" title={profile.agentInstanceId || profile.agentCorrelationId}>
                                {profile.agentInstanceId
                                  ? `${t("实例 ID")} ${profile.agentInstanceId.slice(0, 20)}${agentInstance?.rootPid ? ` · Root PID ${agentInstance.rootPid}` : ""}`
                                  : `${t("旧版逻辑画像")} · ${profile.agentCorrelationId.slice(0, 16)}`}
                              </p>
                            </div>
                            <div className="text-right">
                              <div className="flex items-baseline justify-end gap-1.5">
                                <span className={cn("text-2xl font-semibold tabular-nums", tone.text)}>{formatNumber(score)}</span>
                                {delta !== undefined && delta !== 0 && <span className={cn("text-[10px]", delta > 0 ? "text-rose-300" : "text-emerald-300")}>{delta > 0 ? "+" : ""}{formatNumber(delta)}</span>}
                              </div>
                              <span className={cn("text-[10px]", tone.text)}>{t(tone.label)}</span>
                            </div>
                          </div>

                          <div className="mt-3 rounded-md border border-white/[0.07] bg-black/20 p-3">
                            <p className="text-[11px] font-medium text-zinc-400">{t("风险分数贡献")}</p>
                            {contributions.length === 0 ? (
                              <p className="mt-2 text-xs text-zinc-600">{t("当前窗口没有风险加分项")}</p>
                            ) : (
                              <div className="mt-2 space-y-1.5">
                                {contributions.slice(0, 4).map((item) => (
                                  <div key={item.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 text-[11px]">
                                    <span className="truncate text-zinc-400">{t(item.label)} · {formatNumber(item.value)}</span>
                                    <span className="font-medium tabular-nums text-amber-200">+{formatNumber(item.score)}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>

                          <div className="mt-3 grid grid-cols-2 gap-1.5 sm:grid-cols-4">
                            {["toolExecCount1m", "dangerousCommandCount1m", "sensitiveFileCount5m", "externalEgressCount5m"].map((key) => (
                              <div key={key} className="rounded border border-white/[0.07] px-2 py-1.5">
                                <p className="truncate text-[9px] text-zinc-600">{t(STREAM_FEATURE_LABELS[key])}</p>
                                <p className="mt-0.5 text-xs tabular-nums text-zinc-300">{formatNumber(streamFeatureValue(profile.features, key))}</p>
                              </div>
                            ))}
                          </div>

                          <div className="mt-3 flex flex-wrap gap-1.5">
                            {profile.hitRules.length === 0 ? (
                              <span className="text-[10px] text-zinc-600">{t("未命中复合规则")}</span>
                            ) : profile.hitRules.map((rule) => (
                              <span key={rule} className="rounded border border-amber-400/20 bg-amber-400/10 px-2 py-1 text-[10px] text-amber-200" title={rule}>
                                {t(STREAM_RULE_LABELS[rule] ?? rule)}
                              </span>
                            ))}
                          </div>
                          <div className="mt-3 flex items-center justify-between gap-3 border-t border-white/[0.07] pt-3 text-[10px] text-zinc-600">
                            <span>{dayjs(profile.windowStart).format("HH:mm:ss")} — {dayjs(profile.windowEnd).format("HH:mm:ss")} · {t("规则")} {profile.ruleVersion || "--"}</span>
                            <Link to={"/events?" + query.toString()} className="text-teal-300 hover:text-teal-200">{t("查看事件")} →</Link>
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
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-zinc-100">{t("行为片段复合研判")}</p>
                    <p className="mt-0.5 text-xs text-zinc-500">{t("Flink 聚合连续行为；完整确定性证据直接研判，歧义证据只调用一次模型；结论仅用于旁路告警")}</p>
                  </div>
                  {syntheticEpisodes.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setShowSynthetic((value) => !value)}
                      className="text-xs text-teal-300 hover:text-teal-200"
                    >
                      {showSynthetic
                        ? t("隐藏测试 Episode")
                        : `${t("显示测试 Episode")}（${syntheticEpisodes.length}）`}
                    </button>
                  )}
                </div>
                {visibleCompositeIncidents.length === 0 ? (
                  <EmptyState label="当前窗口暂无复合研判结果" />
                ) : visibleCompositeIncidents.map((incident) => {
                  const judgment = incident.latest;
                  const workspacePath = streamWorkspacePath(judgment.workspacePath);
                  const query = new URLSearchParams();
                  if (judgment.traceIds[0]) query.set("traceId", judgment.traceIds[0]);
                  const blocked = judgment.status === "succeeded" && judgment.verdict === "block";
                  const failed = judgment.status === "failed" || judgment.status === "timeout";
                  const pending = judgment.status === "pending";
                  const updatePending = judgment.updateStatus === "pending";
                  const suspicious = judgment.status === "succeeded" && judgment.classification === "suspicious";
                  const border = pending ? "border-violet-400/25 bg-violet-400/[0.04]" : blocked ? "border-rose-400/25 bg-rose-400/[0.04]" : failed || suspicious ? "border-amber-400/25 bg-amber-400/[0.04]" : "border-emerald-400/20 bg-emerald-400/[0.03]";
                  const title = pending ? t("等待复合研判") : failed
                    ? judgment.status === "timeout" ? "复合研判超时" : "复合研判失败"
                    : blocked ? judgment.attackType === "known-vulnerability-exploitation"
                      ? "高置信度供应链攻击"
                      : judgment.attackType && judgment.attackType !== "none"
                        ? t(STREAM_ATTACK_TYPE_LABELS[judgment.attackType] ?? judgment.attackType)
                        : "已确认攻击链"
                    : judgment.classification === "suspicious"
                      ? t(STREAM_ATTACK_TYPE_LABELS[judgment.attackType ?? ""] ?? "可疑行为链")
                    : judgment.classification === "authorized_admin" ? "已识别授权运维"
                    : judgment.classification === "simulation"
                      ? `${t(STREAM_ATTACK_TYPE_LABELS[judgment.attackType ?? ""] ?? "攻击链")} · ${t("测试演练")}`
                    : "未发现攻击链";
                  const resultLabel = pending ? "待研判" : failed
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
                            <p className="text-sm font-semibold text-zinc-100">{t(title)}</p>
                          </div>
                          <p className="mt-1 text-[11px] text-zinc-500">{judgment.agentType} · {t(streamWorkspaceName(workspacePath))} · {judgment.sessionId || t("无会话 ID")}</p>
                          <p className="mt-0.5 text-[10px] text-zinc-700">Episode {judgment.episodeId.slice(0, 18)} · {t("修订")} {judgment.revision}</p>
                          {incident.occurrences.length > 1 && (
                            <p className="mt-1 text-[10px] text-teal-300">
                              {t("同一行为链重复发生")} {incident.occurrences.length} {t("次")} · {t("首次")} {formatSecurityDateTime(incident.firstSeenAt, "HH:mm:ss")} · {t("最近")} {formatSecurityDateTime(incident.lastSeenAt, "HH:mm:ss")}
                            </p>
                          )}
                          {judgment.updateRevision !== undefined && (
                            <p className={cn(
                              "mt-1 text-[10px]",
                              updatePending ? "text-violet-300" : "text-amber-300",
                            )}>
                              {t("修订")} {judgment.updateRevision}{" "}
                              {t(updatePending ? "正在重新研判，当前保留上一条有效结论" : judgment.updateStatus === "timeout"
                                ? "研判超时，当前保留上一条有效结论"
                                : "研判失败，当前保留上一条有效结论")}
                            </p>
                          )}
                        </div>
                        <div className="text-right">
                          <span className={cn(
                            "inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold",
                            pending ? "border-violet-400/30 bg-violet-400/10 text-violet-200" : blocked ? "border-rose-400/30 bg-rose-400/10 text-rose-200" : failed || suspicious ? "border-amber-400/30 bg-amber-400/10 text-amber-200" : "border-emerald-400/30 bg-emerald-400/10 text-emerald-200",
                          )}>
                            {t(resultLabel)}
                          </span>
                          {judgment.confidence !== undefined && <p className="mt-1 text-[10px] text-zinc-600">{t("置信度")} {Math.round(judgment.confidence * 100)}%</p>}
                        </div>
                      </div>
                      <div className="mt-4 grid gap-2 md:grid-cols-3">
                        {judgment.evidence.map((evidence, index) => (
                          <div key={evidence.eventId} className="relative rounded-md border border-white/10 bg-black/20 p-3">
                            <div className="flex items-center justify-between gap-2">
                              <span className="flex size-5 items-center justify-center rounded-full bg-white/10 text-[10px] text-zinc-300">{index + 1}</span>
                              <span className="text-[10px] text-zinc-600">{dayjs(evidence.eventTime).format("HH:mm:ss")}</span>
                            </div>
                            <p className="mt-2 text-xs font-medium text-zinc-200">{t(STREAM_OPERATION_LABELS[evidence.operation] ?? evidence.operation)}</p>
                            <p className="mt-1 line-clamp-2 text-[11px] text-zinc-500" title={evidence.subject}>{evidence.subject}</p>
                            {evidence.runtimeVulnerabilities?.map((match) => (
                              <p key={`${match.findingId}-${match.vulnerabilityId}`} className="mt-2 rounded border border-rose-400/20 bg-rose-400/[0.06] px-2 py-1 text-[10px] text-rose-200">
                                {match.packageName}@{match.version} · {match.vulnerabilityId} · {t(match.confidence === "high" ? "高置信匹配" : "中置信匹配")}
                              </p>
                            ))}
                            {evidence.judgment && (
                              <p className="mt-2 text-[10px] text-zinc-600">
                                {evidence.judgment.stage} · {evidence.judgment.status} · {evidence.judgment.verdict || t("无结论")}
                              </p>
                            )}
                          </div>
                        ))}
                      </div>
                      <div className="mt-3 flex items-center justify-between gap-3 border-t border-white/[0.07] pt-3 text-[10px] text-zinc-600">
                        <div className="min-w-0">
                          <p className="text-zinc-400">{judgment.reason || judgment.error || t("没有返回复合研判原因")}</p>
                          <p className="mt-1">
                            {pending
                              ? `${t("规则")} ${judgment.ruleVersion || "--"} · ${t("排队中")}`
                              : judgment.decisionSource === "deterministic_rule"
                                ? `${t("确定性规则直判")} · ${judgment.ruleVersion || "--"} · ${formatNumber(judgment.latencyMs)}ms`
                                : `${t("模型")} ${judgment.model || "--"} · ${t("规则")} ${judgment.ruleVersion || "--"} · ${formatNumber(judgment.latencyMs)}ms`}
                            {" · "}{dayjs(judgment.windowStart).format("HH:mm:ss")}—{dayjs(judgment.windowEnd).format("HH:mm:ss")}
                          </p>
                        </div>
                        {judgment.traceIds[0] && <Link to={"/events?" + query.toString()} className="shrink-0 text-teal-300 hover:text-teal-200">{t("查看证据链")} →</Link>}
                      </div>
                      {incident.occurrences.length > 1 && (
                        <details className="mt-2 border-t border-white/[0.05] pt-2 text-[10px] text-zinc-600">
                          <summary className="cursor-pointer text-teal-300 hover:text-teal-200">
                            {t("查看事件")} {incident.occurrences.length} {t("个不可变 Episode")}
                          </summary>
                          <div className="mt-2 space-y-1">
                            {incident.occurrences.map((occurrence) => (
                              <p key={`${occurrence.episodeId}-${occurrence.revision}`}>
                                {dayjs(occurrence.windowStart).format("MM-DD HH:mm:ss")} · {occurrence.episodeId} · {occurrence.status}
                              </p>
                            ))}
                          </div>
                        </details>
                      )}
                    </div>
                  );
                })}
                {suppressedEpisodes.length > 0 && (
                  <p className="text-[10px] text-zinc-700">
                    {suppressedEpisodes.length} {t("过期或历史回放 Episode 已折叠；这些记录未调用模型，也不计入研判失败。")}
                  </p>
                )}
                {syntheticEpisodes.length > 0 && !showSynthetic && (
                  <p className="text-[10px] text-zinc-700">
                    {syntheticEpisodes.length} {t("合成测试 Episode 已折叠；测试结果不计入资产风险和攻击链统计。")}
                  </p>
                )}
                {compositeRisks.length > 0 && (
                  <p className="text-[10px] text-zinc-700">{t("历史规则候选")} {compositeRisks.length} {t("条已保留在存储中，新版不再将其作为最终复合攻击链。")}</p>
                )}
                {legacyCompositeJudgments.length > 0 && (
                  <p className="text-[10px] text-zinc-700">
                    {legacyCompositeJudgments.length} {t("旧版窗口研判记录已折叠；历史审计数据仍保留，新事件不再进入该链路。")}
                  </p>
                )}
              </div>
            )}

            {tab === "runtime" && (
              <div className="space-y-3">
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                  {[
                    { label: "结果消费", value: findings.enabled ? "正常" : "未连接", detail: "AnySentry 已读取流式结果" },
                    { label: "运行模式", value: "Shadow", detail: "不进入同步阻断链路" },
                    { label: "结果总数", value: findings.riskProfiles.length + visibleCompositeIncidents.length, detail: findings.riskProfiles.length + " 画像 / " + visibleCompositeIncidents.length + " 复合 Incident" },
                    { label: "规则版本", value: ruleVersions.join(", ") || "--", detail: "画像输出携带的规则版本" },
                  ].map((item) => (
                    <div key={item.label} className="rounded-md border border-white/10 bg-white/[0.025] p-3">
                      <p className="text-[11px] text-zinc-500">{t(item.label)}</p>
                      <p className="mt-1 text-lg font-semibold text-zinc-100">{t(String(item.value))}</p>
                      <p className="mt-1 text-[10px] text-zinc-600">{t(item.detail)}</p>
                    </div>
                  ))}
                </div>
                <div className="flex gap-3 rounded-md border border-amber-400/20 bg-amber-400/[0.05] p-3">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-300" />
                  <div>
                    <p className="text-xs font-medium text-amber-100">{t("深度运行指标尚未接入查询接口")}</p>
                    <p className="mt-1 text-[11px] leading-5 text-zinc-500">{t("Checkpoint、Watermark、Kafka Lag 与 DLQ 数量目前不能从本页面可靠读取，因此不展示虚构的健康值。下一步应由 Flink / Redpanda 指标接口提供真实数据。")}</p>
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
  const { t } = useI18n();
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
              <p className="text-xs text-zinc-500">{t("综合风险评分")}</p>
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
              <a href="#">{t("打开会话")}</a>
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
  const { t } = useI18n();
  return (
    <div className="grid grid-cols-[64px_minmax(0,1fr)] gap-3">
      <span className="text-zinc-600">{t(label)}</span>
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
function TierStatusStrip({
  status,
  collectorHealth,
  collectorHealthLoading = false,
  collectorHealthError = false,
}: {
  status?: PolicyStatus | null;
  collectorHealth?: CollectorHealth | null;
  collectorHealthLoading?: boolean;
  collectorHealthError?: boolean;
}) {
  const { t } = useI18n();
  const tiers: Array<{ key: keyof PolicyStatus; label: string }> = [
    { key: "l1", label: "L1 规则" },
    { key: "l2", label: "L2 LLM 研判" },
    { key: "l3", label: "L3 深判" },
  ];
  const collectorSummary = collectorHealth?.summary;
  const collectorTotal = collectorSummary?.totalCollectors ?? 0;
  const collectorOnline = (collectorSummary?.healthyCollectors ?? 0) + (collectorSummary?.quietCollectors ?? 0);
  const collectorDown = collectorSummary?.downCollectors ?? 0;
  const collectorAbnormal = (collectorSummary?.degradedCollectors ?? 0)
    + (collectorSummary?.staleCollectors ?? 0)
    + collectorDown;
  const observerState = collectorHealthLoading && !collectorHealth
    ? "loading"
    : collectorHealthError
      ? "unknown"
      : collectorTotal === 0 || collectorDown === collectorTotal
        ? "offline"
        : collectorAbnormal > 0
          ? "partial"
          : "online";
  const observerLabel = observerState === "loading"
    ? "检测中"
    : observerState === "unknown"
      ? "状态未知"
      : observerState === "offline"
        ? "未连接"
        : observerState === "partial"
          ? "部分异常"
          : "正常";
  const observerHealthy = observerState === "online";
  const observerWarn = observerState === "partial" || observerState === "loading";
  const observerTitle = collectorTotal > 0
    ? t(`Collector ${collectorOnline}/${collectorTotal} 在线${collectorAbnormal > 0 ? `，${collectorAbnormal} 个异常` : ""}`)
    : t("未发现有效的 Observer Collector 心跳");
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-[10px] border border-[#232a37] bg-[#0f131a] px-4 py-2.5">
      <span className="mr-1 text-xs font-medium text-zinc-400">{t("观测与研判")}</span>
      <span
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs",
          observerHealthy
            ? "border-teal-400/30 bg-teal-400/10 text-teal-200"
            : observerWarn
              ? "border-amber-400/30 bg-amber-400/10 text-amber-200"
              : "border-rose-400/30 bg-rose-400/10 text-rose-200",
        )}
        title={observerTitle}
      >
        <RadioTower className="size-3" />
        Observer
        <span className="text-[10px] opacity-75">{t(observerLabel)}</span>
      </span>
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
            {t(label)}
            <span className="text-[10px] opacity-70">{t(on ? "已启用" : "未启用")}</span>
          </span>
        );
      })}
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
  const { t } = useI18n();
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
                      {t("未配置")}
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
              <span className="text-sm font-semibold text-rose-100">{t("最终阻断")}</span>
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
  const { t } = useI18n();
  const tone = riskTone(severityLevel(event.severity));
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold", tone.bg, tone.border, tone.text)}>
      <span className={cn("size-1.5 rounded-full", tone.dot)} />
      {t(EVENT_CATEGORY_LABEL[event.eventCategory] ?? event.eventCategory)}
    </span>
  );
}

function VerdictPill({ verdict }: { verdict: SecurityVerdict }) {
  const { t } = useI18n();
  const tone = riskTone(verdictLevel(verdict));
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold", tone.bg, tone.border, tone.text)}>
      <span className={cn("size-1.5 rounded-full", tone.dot)} />
      {t(VERDICT_LABEL[verdict] ?? verdict)}
    </span>
  );
}

const SENTRY_TIER_META: Record<AgentEventListItem["tier"], { label: string; title: string; className: string }> = {
  Rules: { label: "L1", title: "L1 · 规则引擎", className: "border-zinc-600/60 bg-zinc-500/10 text-zinc-300" },
  Llm: { label: "L2", title: "L2 · LLM 研判", className: "border-amber-500/40 bg-amber-500/10 text-amber-200" },
  Agent: { label: "L3", title: "L3 · 智能体深判", className: "border-rose-500/40 bg-rose-500/10 text-rose-200" },
};

function SentryTierPill({ event }: { event: AgentEventListItem }) {
  const { t } = useI18n();
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
          {t(statusMeta.label)}
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
  const { t } = useI18n();
  const options: Array<{ value: TimelineScope; label: string }> = [
    { value: "agent", label: "Agent 相关" },
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
          {t(option.label)}
        </button>
      ))}
    </div>
  );
}

function timelineEventListFingerprint(events: AgentEventList): string {
  return events.items
    .map((event) => [
      event.eventId,
      event.decisionRevision ?? 0,
      event.decisionStatus ?? "",
      event.verdict,
      event.riskScore,
    ].join(":"))
    .join("|");
}

function AgentEventTimelinePanel({
  events,
  loading,
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
  loading: boolean;
  error?: string;
  scope: TimelineScope;
  tier: TimelineTierFilter;
  includeUnknown: boolean;
  timeFilter: SecurityTimeFilter;
  onScopeChange: (value: TimelineScope) => void;
  onTierChange: (value: TimelineTierFilter) => void;
  onIncludeUnknownChange: (value: boolean) => void;
}) {
  const { locale, t } = useI18n();
  const [displayedEvents, setDisplayedEvents] = useState<AgentEventList | null>(events ?? null);
  const [pendingEvents, setPendingEvents] = useState<AgentEventList | null>(null);
  const visibleEvents = displayedEvents ?? events ?? null;
  const items = visibleEvents?.items ?? [];
  const pendingNewEventCount = useMemo(() => {
    if (!pendingEvents) return 0;
    const visibleIds = new Set(items.map((event) => event.eventId));
    return pendingEvents.items.filter((event) => !visibleIds.has(event.eventId)).length;
  }, [items, pendingEvents]);

  useEffect(() => {
    if (!events) return;
    if (!displayedEvents) {
      setDisplayedEvents(events);
      setPendingEvents(null);
      return;
    }
    if (timelineEventListFingerprint(events) !== timelineEventListFingerprint(displayedEvents)) {
      setPendingEvents(events);
    }
  }, [displayedEvents, events]);

  const loadPendingEvents = () => {
    if (!pendingEvents) return;
    setDisplayedEvents(pendingEvents);
    setPendingEvents(null);
  };

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
            <SelectTrigger className="h-8 w-[112px] border-white/10 bg-white/5 text-xs text-zinc-100" aria-label={locale === "en" ? "Filter judgment tier" : "筛选研判层级"}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{locale === "en" ? "All tiers" : "全部研判"}</SelectItem>
              <SelectItem value="Rules">L1</SelectItem>
              <SelectItem value="Llm">L2</SelectItem>
              <SelectItem value="Agent">L3</SelectItem>
            </SelectContent>
          </Select>
          {pendingEvents ? (
            <button
              type="button"
              onClick={loadPendingEvents}
              className="h-8 rounded-md border border-sky-400/30 bg-sky-400/10 px-2.5 text-xs font-semibold text-sky-200 transition-colors hover:bg-sky-400/15"
              aria-live="polite"
            >
              {pendingNewEventCount > 0
                ? `${pendingNewEventCount}${pendingNewEventCount === pendingEvents.items.length ? "+" : ""} 条新事件`
                : "事件状态已更新"}
            </button>
          ) : null}
          <span className="text-xs text-zinc-500">
            {visibleEvents ? `${formatNumber(visibleEvents.total)}${visibleEvents.totalMode === "estimated" ? "+" : ""} ${locale === "en" ? "events" : "条"}` : "--"}
          </span>
          <Link to="/events" className="text-xs text-teal-300 hover:text-teal-200">{t("查看全部")}</Link>
        </div>
      }
    >
      <div className="space-y-3 p-4">
        <InlineError message={error} />
        {loading && !visibleEvents ? (
          <div className="flex min-h-28 items-center justify-center gap-2 text-xs text-zinc-500">
            <LoaderCircle className="size-4 animate-spin" />
            正在加载所选时间范围的事件…
          </div>
        ) : items.length === 0 ? (
          <EmptyState label="暂无事件明细" />
        ) : (
          <div className="overflow-x-auto">
            <div className="grid min-w-[1140px] grid-cols-[96px_88px_minmax(240px,1.4fr)_minmax(150px,0.9fr)_minmax(150px,0.9fr)_66px_82px_76px_62px] gap-3 border-b border-white/10 pb-2 text-xs text-zinc-500">
              <span>{locale === "en" ? "Time" : "时间"}</span>
              <span>{locale === "en" ? "Type" : "类型"}</span>
              <span>{locale === "en" ? "Event" : "事件"}</span>
              <span>Agent</span>
              <span>Trace / Span</span>
              <span className="text-center">{locale === "en" ? "Tier" : "研判"}</span>
              <span className="text-right">{locale === "en" ? "Risk" : "风险"}</span>
              <span className="text-center">{locale === "en" ? "Action" : "处置"}</span>
              <span className="text-right">{locale === "en" ? "Details" : "详情"}</span>
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
                      {event.eventKind} · {t(riskEventName(event.riskCategory))} · {event.source}
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
  const { locale, t } = useI18n();
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
        <h3 className="text-sm font-semibold text-zinc-100">{t(title)}</h3>
        <p className="mt-0.5 text-xs text-zinc-500">{t(description)}</p>
      </div>
      {items.length === 0 ? (
        <EmptyState label={emptyLabel} />
      ) : (
        <div className="max-h-[420px] overflow-auto p-4">
          <div className="grid min-w-[520px] grid-cols-[minmax(180px,1fr)_72px_96px_86px] gap-3 border-b border-white/10 pb-2 text-xs text-zinc-500">
            <span>{t(pathLabel)}</span>
            <span className="text-right">{locale === "en" ? "Sessions" : "会话数"}</span>
            <span className="text-right">{locale === "en" ? "Cumulative Risk" : "累计风险"}</span>
            <span className="text-right">{locale === "en" ? "Level" : "等级"}</span>
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
  const [searchParams] = useSearchParams();
  const requestedView = searchParams.get("view");
  const normalizedRequestedView = requestedView === "agentMonitoring"
    ? "agentAssets"
    : requestedView;
  const { filter, refreshVersion } = useSecurityConsole();
  const activeView: DashboardView = (
    DASHBOARD_VIEWS.some((item) => item.value === normalizedRequestedView)
      ? normalizedRequestedView as DashboardView
      : "overview"
  );
  const [timelineScope, setTimelineScope] = useState<TimelineScope>("agent");
  const [timelineTier, setTimelineTier] = useState<TimelineTierFilter>("all");
  const [timelineIncludeUnknown, setTimelineIncludeUnknown] = useState(true);
  const [overviewScope, setOverviewScope] = useState<TimelineScope>("agent");
  const [scanScope, setScanScope] = useState<TimelineScope>("agent");
  const [riskBreakdownScope, setRiskBreakdownScope] = useState<TimelineScope>("agent");
  const [decisionFunnelScope, setDecisionFunnelScope] = useState<TimelineScope>("agent");
  const [workspaceRiskScope, setWorkspaceRiskScope] = useState<TimelineScope>("agent");
  const [observability, setObservability] = useState<AgentObservability | null>(null);
  const [observabilityConnected, setObservabilityConnected] = useState(false);

  const requestFilter = useMemo(() => filter, [filter]);
  const timelineContextKey = [
    requestFilter.timeType ?? "last_3h",
    requestFilter.startTime ?? "",
    requestFilter.endTime ?? "",
    requestFilter.snapshotAsOf ?? "",
    timelineScope,
    timelineTier,
    timelineIncludeUnknown ? "include-unknown" : "hide-unknown",
    refreshVersion,
  ].join("|");
  const needsDashboardData = ["overview", "risk", "supplyChain", "workspace"].includes(activeView);
  const needsAgentInventory = ["agentAssets", "agentInstances", "stream"].includes(activeView);
  const needsStreamFindings = ["agentAssets", "stream", "supplyChain"].includes(activeView);
  const { data, loading } = useRequest(() => {
    // Relative ranges are live views. Keep one snapshot across every request in
    // this polling cycle, but advance it on the next cycle. Reusing the
    // snapshotAsOf captured in the URL would make a "last 3 hours" dashboard
    // repeatedly query the same historical endpoint forever.
    const cycleFilter = requestFilter.timeType === "custom"
      ? requestFilter
      : { ...requestFilter, snapshotAsOf: dashboardSnapshotAsOf() };
    return loadSecurityDashboardData(
      cycleFilter,
      activeView,
      overviewScope,
      scanScope,
      riskBreakdownScope,
      decisionFunnelScope,
      workspaceRiskScope,
    );
  }, {
    ready: needsDashboardData,
    refreshDeps: [activeView, requestFilter, refreshVersion, overviewScope, scanScope, riskBreakdownScope, decisionFunnelScope, workspaceRiskScope],
    pollingInterval: 10000,
    pollingWhenHidden: false,
  });
  const {
    data: agentInventory,
    loading: agentInventoryLoading,
    error: agentInventoryRequestError,
  } = useRequest(() => {
    const cycleFilter = requestFilter.timeType === "custom"
      ? requestFilter
      : { ...requestFilter, snapshotAsOf: dashboardSnapshotAsOf() };
    return securityCenterApi.agentInventory({
      ...cycleFilter,
      limit: activeView === "agentInstances" ? 500 : 32,
    });
  }, {
    ready: needsAgentInventory,
    refreshDeps: [activeView, requestFilter, refreshVersion],
    pollingInterval: 10000,
    pollingWhenHidden: false,
  });
  const {
    data: streamFindings,
    error: streamFindingsRequestError,
  } = useRequest(() => {
    const cycleFilter = requestFilter.timeType === "custom"
      ? requestFilter
      : { ...requestFilter, snapshotAsOf: dashboardSnapshotAsOf() };
    return securityCenterApi.streamFindings({ ...cycleFilter, limit: 100 });
  }, {
    ready: needsStreamFindings,
    refreshDeps: [activeView, requestFilter, refreshVersion],
    pollingInterval: 10000,
    pollingWhenHidden: false,
  });
  const {
    data: timelineResponse,
    loading: timelineRequestLoading,
    error: timelineRequestError,
  } = useRequest(() => {
    const cycleFilter = requestFilter.timeType === "custom"
      ? requestFilter
      : { ...requestFilter, snapshotAsOf: dashboardSnapshotAsOf() };
    return securityCenterApi.agentEvents({
      ...cycleFilter,
      scope: timelineScope,
      includeUnknown: timelineIncludeUnknown,
      ...(timelineTier === "all" ? {} : { tier: timelineTier }),
      limit: 36,
    }).then((events) => ({ contextKey: timelineContextKey, events }));
  }, {
    ready: activeView === "events",
    refreshDeps: [timelineContextKey],
    pollingInterval: 10000,
    pollingWhenHidden: false,
  });
  const timelineEvents = timelineResponse?.contextKey === timelineContextKey
    ? timelineResponse.events
    : undefined;
  useEffect(() => {
    if (activeView !== "overview") {
      setObservability(null);
      setObservabilityConnected(false);
      return;
    }
    const controller = new AbortController();
    setObservability(null);
    setObservabilityConnected(false);
    const streamFilter = requestFilter.timeType === "custom"
      ? requestFilter
      : { ...requestFilter, snapshotAsOf: undefined };
    streamAgentObservability(
      { ...streamFilter, scope: overviewScope },
      (next) => {
        setObservability(next);
        setObservabilityConnected(true);
      },
      controller.signal,
    );
    return () => controller.abort();
  }, [activeView, overviewScope, requestFilter]);
  // Tier status drives conditional rendering for L2/L3 funnel rows. Polled so a
  // Save reflects without a full reload.
  const { data: policyConfig } = useRequest(() => securityCenterApi.getConfig(), {
    pollingInterval: 30000,
    pollingWhenHidden: false,
    refreshOnWindowFocus: true, // returning from the config page reflects immediately
  });
  const {
    data: collectorHealth,
    loading: collectorHealthLoading,
    error: collectorHealthRequestError,
  } = useRequest(() => securityCenterApi.collectorHealth({ timeType: "last_3h", limit: 100 }), {
    refreshDeps: [refreshVersion],
    pollingInterval: 10000,
    pollingWhenHidden: false,
    refreshOnWindowFocus: true,
  });
  const platformRange = requestFilter.timeType === "custom"
    || requestFilter.timeType === "last_7d"
    || requestFilter.timeType === "last_30d"
    ? "last_1d"
    : requestFilter.timeType ?? "last_1h";
  const {
    data: platformMetrics,
    loading: platformMetricsLoading,
  } = useRequest(() => securityCenterApi.platformMetrics(platformRange), {
    ready: activeView === "overview",
    refreshDeps: [platformRange, refreshVersion],
    pollingInterval: 15000,
    pollingWhenHidden: false,
  });
  const status = policyConfig?.status ?? null;
  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-[#0a0d12] text-zinc-100">
      <main className="min-h-0 flex-1 overflow-hidden px-4 py-4">
        <div className="mx-auto h-full w-full max-w-[1680px]">
          <div className="h-full min-w-0 overflow-y-auto pr-1">
            <div className="flex flex-col gap-4">
              <TierStatusStrip
                status={status}
                collectorHealth={collectorHealth}
                collectorHealthLoading={collectorHealthLoading}
                collectorHealthError={Boolean(collectorHealthRequestError)}
              />

              {activeView === "overview" && (
                <DashboardSection
                  title="运行总览"
                  icon={Activity}
                  action={<TimelineScopeTabs value={overviewScope} onChange={setOverviewScope} />}
                >
                  <div className="w-full min-w-0 max-w-full space-y-4">
                    <TopMetrics data={data} loading={loading && !data} />
                    <PlatformResourceSummary data={platformMetrics} loading={platformMetricsLoading} />
                    <LiveObservabilityPanel observability={observability} connected={observabilityConnected} />
                    <div className="border-t border-[#232a37] pt-4">
                      <DashboardSection title="实时扫描" icon={Radar}>
                        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.65fr)_minmax(360px,0.95fr)]">
                          <ExplainabilityPanel
                            scan={data?.scan}
                            error={data?.errors.scan}
                            scope={scanScope}
                            onScopeChange={setScanScope}
                          />
                          <DecisionFunnelPanel
                            funnel={data?.decisionFunnel}
                            status={status}
                            scope={decisionFunnelScope}
                            onScopeChange={setDecisionFunnelScope}
                          />
                        </div>
                      </DashboardSection>
                    </div>
                  </div>
                </DashboardSection>
              )}

              {activeView === "agentAssets" && (
                <AgentRiskOverviewPanel
                  inventory={agentInventory}
                  findings={streamFindings}
                  inventoryError={agentInventoryRequestError ? formatRequestError(agentInventoryRequestError) : undefined}
                  findingsError={streamFindingsRequestError ? formatRequestError(streamFindingsRequestError) : undefined}
                  inventoryLoading={agentInventoryLoading}
                  filter={filter}
                  assetsOnly
                />
              )}

              {activeView === "agentInstances" && (
                <AgentInstanceTrendsPanel
                  inventory={agentInventory}
                  inventoryError={agentInventoryRequestError ? formatRequestError(agentInventoryRequestError) : undefined}
                  inventoryLoading={agentInventoryLoading}
                  filter={requestFilter}
                />
              )}

              {activeView === "risk" && (
                <DashboardSection title="风险态势" icon={Siren}>
                  <div className="space-y-4">
                    <RiskSummaryPanels summary={data?.riskSummary} />
                    <RiskBreakdownPanel breakdown={data?.riskBreakdown} error={data?.errors.riskBreakdown} scope={riskBreakdownScope} onScopeChange={setRiskBreakdownScope} />
                  </div>
                </DashboardSection>
              )}

              {activeView === "stream" && (
                <DashboardSection title="流式复合研判" icon={Sparkles}>
                  <AgentRiskOverviewPanel
                    inventory={agentInventory}
                    findings={streamFindings}
                    inventoryError={agentInventoryRequestError ? formatRequestError(agentInventoryRequestError) : undefined}
                    findingsError={streamFindingsRequestError ? formatRequestError(streamFindingsRequestError) : undefined}
                    inventoryLoading={agentInventoryLoading}
                    filter={filter}
                  />
                </DashboardSection>
              )}

              {activeView === "supplyChain" && data?.supplyChain?.enabled && (
                <DashboardSection title="供应链漏洞资产" icon={ShieldAlert}>
                  <SupplyChainPanel
                    overview={data.supplyChain}
                    streamFindings={streamFindings}
                    error={data.errors.supplyChain}
                  />
                </DashboardSection>
              )}

              {activeView === "events" && (
                <DashboardSection title="运行链路" icon={GitBranch}>
                  <AgentEventTimelinePanel
                    key={timelineContextKey}
                    events={timelineEvents}
                    loading={timelineRequestLoading}
                    error={timelineRequestError ? formatRequestError(timelineRequestError) : undefined}
                    scope={timelineScope}
                    tier={timelineTier}
                    includeUnknown={timelineIncludeUnknown}
                    timeFilter={filter}
                    onScopeChange={setTimelineScope}
                    onTierChange={setTimelineTier}
                    onIncludeUnknownChange={setTimelineIncludeUnknown}
                  />
                </DashboardSection>
              )}

              {activeView === "workspace" && (
                <DashboardSection title="会话与工作区" icon={TerminalSquare}>
                  <div className="space-y-4">
                    <div className="grid gap-4 xl:grid-cols-[minmax(360px,0.9fr)_minmax(0,1.6fr)]">
                      <HighestRiskPanel session={data?.highestRisk} />
                      <WorkspaceRiskPanel workspaceRisk={data?.workspaceRisk} scope={workspaceRiskScope} onScopeChange={setWorkspaceRiskScope} />
                    </div>
                    <WorkspaceAssetsView embedded timeFilter={requestFilter} />
                  </div>
                </DashboardSection>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
