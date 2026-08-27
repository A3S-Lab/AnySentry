import { useRequest } from "ahooks";
import dayjs from "dayjs";
import { liveSecuritySnapshotAsOf } from "@/lib/date-time";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  BadgeCheck,
  Ban,
  BellRing,
  Bot,
  CalendarClock,
  ChevronDown,
  Clock3,
  CircleCheck,
  EyeOff,
  FileCheck2,
  FileText,
  GitBranch,
  LoaderCircle,
  RefreshCw,
  Route,
  RotateCcw,
  Save,
  Search,
  Settings2,
  ShieldAlert,
  ShieldQuestion,
  Target,
  TerminalSquare,
  UserCheck,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AdminTokenControl } from "@/components/custom/admin-token-control";
import { OperationalEmptyState } from "@/components/custom/operational-empty-state";
import { AgentAssetIdentityInline } from "@/components/custom/agent-identity";
import { IdentityAiReview } from "@/components/custom/identity-ai-review";
import { useSecurityConsole } from "@/components/custom/security-console-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  type AgentEventCategory,
  type AgentEventSource,
  type AgentActionItem,
  type AgentClassification,
  type AgentCriticality,
  type AgentHealthState,
  type AgentInventoryItem,
  type AgentInventory,
  type AgentInventoryQuery,
  type QueryCoverage,
  type AgentRuntimeInstanceRecord,
  type AgentRuntimeState,
  type AgentActivityState,
  type SecurityTimeType,
  buildAgentRuntimeLookup,
  matchAgentRuntimeInstance,
  securityCenterApi,
} from "@/lib/api/security-center";
import { cn } from "@/lib/utils";

const TIME_OPTIONS: Array<{ value: SecurityTimeType; label: string }> = [
  { value: "last_30m", label: "近30分钟" },
  { value: "last_1h", label: "近1小时" },
  { value: "last_2h", label: "近2小时" },
  { value: "last_3h", label: "近3小时" },
  { value: "last_1d", label: "近一天" },
  { value: "last_7d", label: "近一周" },
  { value: "last_30d", label: "近一月" },
];

type AgentAssetRange = NonNullable<AgentInventoryQuery["assetRange"]>;
const ASSET_RANGE_OPTIONS: Array<{ value: AgentAssetRange; label: string }> = [
  { value: "current", label: "当前资产" },
  { value: "recent", label: "最近出现" },
  { value: "historical", label: "历史资产" },
  { value: "archived", label: "已归档" },
  { value: "all", label: "全部范围" },
];

const HEALTH_OPTIONS: Array<{ value: AgentHealthState | "all"; label: string }> = [
  { value: "all", label: "全部状态" },
  { value: "risky", label: "风险" },
  { value: "active", label: "活跃" },
  { value: "idle", label: "空闲" },
  { value: "stale", label: "失联" },
];

const HEALTH_LABEL: Record<AgentHealthState, string> = {
  active: "活跃",
  idle: "空闲",
  stale: "失联",
  risky: "风险",
};

const RUNTIME_STATE_LABEL: Record<AgentRuntimeState, string> = {
  running: "运行中",
  exited: "已退出",
  lost: "已丢失",
  unobserved: "未观测",
};

const ACTIVITY_STATE_LABEL: Record<AgentActivityState, string> = {
  active: "活跃",
  idle: "空闲",
};

const CRITICALITY_OPTIONS: Array<{ value: AgentCriticality | "unset"; label: string }> = [
  { value: "unset", label: "未设置" },
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
  { value: "critical", label: "关键" },
];

const CRITICALITY_LABEL: Record<AgentCriticality, string> = {
  low: "低",
  medium: "中",
  high: "高",
  critical: "关键",
};

const CLASSIFICATION_LABEL: Record<AgentClassification, string> = {
  confirmed_agent: "已确认 Agent",
  probable_agent: "候选 Agent",
  unknown: "尚未识别",
  non_agent: "已排除",
};

interface AgentMetadataDraft {
  displayName: string;
  owner: string;
  team: string;
  environment: string;
  criticality: AgentCriticality | "";
  tags: string;
  note: string;
}

type PendingReviewDecision = "confirmed_agent" | "unknown" | "non_agent" | "clear";

const CATEGORY_LABEL: Record<AgentEventCategory, string> = {
  tool: "工具",
  network: "网络",
  file: "文件",
  llm: "LLM",
  security: "安全",
  process: "进程",
  runtime: "运行时",
  unknown: "未知",
};

const SOURCE_LABEL: Record<AgentEventSource, string> = {
  observer: "Observer",
  synthetic: "Synthetic",
  api: "API",
};

function clean(value: string) {
  return value.trim() || undefined;
}

function formatDate(value?: string | number) {
  if (!value) return "--";
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed.format("MM-DD HH:mm:ss") : value;
}

function inventorySignature(data?: AgentInventory) {
  if (!data) return "";
  return [
    data.total,
    data.coverage.partial,
    data.coverage.partialReason ?? "full",
    data.coverage.source,
    ...data.items.map((agent) => [
      agent.agentAssetId,
      agent.agentInstanceId ?? "metadata",
      agent.classification,
      agent.lifecycleState,
      agent.eventCount,
      agent.lastSeen,
    ].join(":")),
  ].join("|");
}

function mergeCountRecords<T extends string>(
  items: AgentInventoryItem[],
  select: (item: AgentInventoryItem) => Record<T, number>,
) {
  const result = {} as Record<T, number>;
  for (const item of items) {
    const counts = select(item);
    for (const key of Object.keys(counts) as T[]) {
      result[key] = (result[key] ?? 0) + counts[key];
    }
  }
  return result;
}

function logicalAgentRows(items: AgentInventoryItem[]) {
  const byAsset = new Map<string, AgentInventoryItem[]>();
  for (const item of items) {
    const group = byAsset.get(item.agentAssetId) ?? [];
    group.push(item);
    byAsset.set(item.agentAssetId, group);
  }
  const classificationRank: Record<AgentClassification, number> = {
    confirmed_agent: 3,
    probable_agent: 2,
    unknown: 1,
    non_agent: 0,
  };
  const healthRank: Record<AgentHealthState, number> = { risky: 3, active: 2, idle: 1, stale: 0 };
  const riskRank: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1, safe: 0, unknown: -1 };
  return [...byAsset.values()].map((group) => {
    const latest = [...group].sort((left, right) => Date.parse(right.lastSeen) - Date.parse(left.lastSeen))[0];
    const identity = [...group].sort((left, right) => classificationRank[right.classification] - classificationRank[left.classification])[0];
    const health = [...group].sort((left, right) => healthRank[right.healthState] - healthRank[left.healthState])[0];
    const risk = [...group].sort((left, right) => (riskRank[right.riskLevel] ?? -1) - (riskRank[left.riskLevel] ?? -1))[0];
    const runtimeIds = new Set(group.map((item) => item.agentInstanceId).filter((value): value is string => Boolean(value)));
    const firstSeen = Math.min(...group.map((item) => Date.parse(item.firstSeen)).filter(Number.isFinite));
    const lastSeen = Math.max(...group.map((item) => Date.parse(item.lastSeen)).filter(Number.isFinite));
    return {
      ...latest,
      classification: identity.classification,
      detectedClassification: identity.detectedClassification,
      healthState: health.healthState,
      riskLevel: risk.riskLevel,
      riskLevelText: risk.riskLevelText,
      topRiskCategory: risk.topRiskCategory,
      topRiskName: risk.topRiskName,
      firstSeen: Number.isFinite(firstSeen) ? new Date(firstSeen).toISOString() : latest.firstSeen,
      lastSeen: Number.isFinite(lastSeen) ? new Date(lastSeen).toISOString() : latest.lastSeen,
      logicalInstanceCount: Math.max(runtimeIds.size, ...group.map((item) => item.logicalInstanceCount ?? 0)),
      instanceCount: runtimeIds.size,
      eventCount: group.reduce((total, item) => total + item.eventCount, 0),
      riskyEventCount: group.reduce((total, item) => total + item.riskyEventCount, 0),
      openIncidentCount: group.reduce((total, item) => total + item.openIncidentCount, 0),
      sessionCount: group.reduce((total, item) => total + item.sessionCount, 0),
      runCount: group.reduce((total, item) => total + item.runCount, 0),
      traceCount: group.reduce((total, item) => total + item.traceCount, 0),
      tokenCount: group.reduce((total, item) => total + item.tokenCount, 0),
      avgLatencyMs: group.reduce((total, item) => total + item.avgLatencyMs * item.eventCount, 0)
        / Math.max(1, group.reduce((total, item) => total + item.eventCount, 0)),
      eventCategoryCounts: mergeCountRecords(group, (item) => item.eventCategoryCounts),
      sourceCounts: mergeCountRecords(group, (item) => item.sourceCounts),
      agentAssetAliases: [...new Set(group.flatMap((item) => item.agentAssetAliases ?? []))],
      attributionEvidence: [...new Set(group.flatMap((item) => item.attributionEvidence))],
      reviewIdentityKeys: [...new Set(group.flatMap((item) => item.reviewIdentityKeys))],
    } satisfies AgentInventoryItem;
  });
}

function InventoryCoverageBanner({
  coverage,
  directory,
}: {
  coverage?: QueryCoverage;
  directory?: AgentInventory["directory"];
}) {
  if (!coverage && !directory) return null;
  return (
    <div className={cn(
      "rounded-md border px-3 py-2 text-[11px] leading-5",
      coverage?.partial || directory?.partial
        ? "border-amber-400/20 bg-amber-500/[0.06] text-amber-100/80"
        : "border-white/8 bg-white/[0.02] text-zinc-500",
    )}>
      {directory ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>{directory.partial ? "资产目录不完整" : "资产成员来自持久生命周期目录"}</span>
          <span>{`目录 r${directory.snapshotRevision}`}</span>
          <span>{`${directory.totalAssets} 个已保留 Agent 资产`}</span>
          {directory.reasons.length ? <span>{`原因 ${directory.reasons.join("、")}`}</span> : null}
        </div>
      ) : null}
      {coverage ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>{coverage.partial ? "行为统计覆盖不完整" : "行为统计覆盖完整"}</span>
          <span>{`来源 ${coverage.source}`}</span>
          <span>{`数据 ${formatDate(coverage.dataFrom)} → ${formatDate(coverage.dataTo)}`}</span>
          <span>{`快照 ${formatDate(coverage.snapshotAsOf)}`}</span>
          {coverage.partialReason ? <span>{`原因 ${coverage.partialReason}`}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

function healthClass(health?: AgentHealthState) {
  if (health === "risky") return "border-rose-400/30 bg-rose-500/10 text-rose-100";
  if (health === "active") return "border-teal-400/30 bg-teal-500/10 text-teal-100";
  if (health === "idle") return "border-amber-400/30 bg-amber-500/10 text-amber-100";
  return "border-white/10 bg-white/5 text-zinc-300";
}

function runtimeStateClass(state: AgentRuntimeState) {
  if (state === "running") return "border-teal-400/30 bg-teal-500/10 text-teal-100";
  if (state === "lost") return "border-rose-400/30 bg-rose-500/10 text-rose-100";
  if (state === "unobserved") return "border-amber-400/30 bg-amber-500/10 text-amber-100";
  return "border-slate-400/20 bg-slate-500/10 text-slate-300";
}

function activityStateClass(state: AgentActivityState) {
  return state === "active"
    ? "border-sky-400/30 bg-sky-500/10 text-sky-100"
    : "border-amber-400/30 bg-amber-500/10 text-amber-100";
}

function riskClass(level?: string) {
  if (level === "critical" || level === "high") return "border-rose-400/30 bg-rose-500/10 text-rose-100";
  if (level === "medium") return "border-amber-400/30 bg-amber-500/10 text-amber-100";
  if (level === "low") return "border-teal-400/30 bg-teal-500/10 text-teal-100";
  return "border-white/10 bg-white/5 text-zinc-300";
}

function criticalityClass(level?: AgentCriticality) {
  if (level === "critical") return "border-rose-400/30 bg-rose-500/10 text-rose-100";
  if (level === "high") return "border-orange-400/30 bg-orange-500/10 text-orange-100";
  if (level === "medium") return "border-amber-400/30 bg-amber-500/10 text-amber-100";
  if (level === "low") return "border-teal-400/30 bg-teal-500/10 text-teal-100";
  return "border-white/10 bg-white/5 text-zinc-300";
}

function classificationClass(classification: AgentClassification) {
  if (classification === "confirmed_agent") return "border-emerald-400/30 bg-emerald-500/10 text-emerald-100";
  if (classification === "probable_agent") return "border-amber-400/30 bg-amber-500/10 text-amber-100";
  if (classification === "non_agent") return "border-slate-500/30 bg-slate-500/10 text-slate-300";
  return "border-white/10 bg-white/5 text-zinc-400";
}

function agentPrimaryName(agent: AgentInventoryItem) {
  const customName = agent.displayName?.trim();
  if (customName) return customName;
  if (agent.detectedName?.trim()) return agent.detectedName.trim();
  const workload = agent.workloadRef;
  if (workload?.environment === "kubernetes") {
    const parts = [workload.namespace, workload.podName, workload.containerName]
      .map((part) => part?.trim())
      .filter((part): part is string => Boolean(part));
    if (parts.length) return parts.join("/");
  }
  if (workload?.environment === "docker" && workload.containerName?.trim()) {
    return workload.containerName.trim();
  }
  if (workload?.environment === "host") {
    const processName = workload.processName?.trim() || workload.name?.trim();
    if (processName && !processName.startsWith("session-")) return processName;
  }
  return agent.agentId;
}

function splitTags(value: string) {
  return [...new Set(value
    .split(/[,，\s]+/)
    .map((tag) => tag.trim())
    .filter(Boolean))]
    .slice(0, 24);
}

function draftFromAgent(agent?: AgentInventoryItem): AgentMetadataDraft {
  return {
    displayName: agent?.displayName ?? "",
    owner: agent?.owner ?? "",
    team: agent?.team ?? "",
    environment: agent?.environment ?? "",
    criticality: agent?.criticality ?? "",
    tags: agent?.tags?.join(", ") ?? "",
    note: agent?.note ?? "",
  };
}

function Pill({ children, className }: { children: string; className?: string }) {
  return (
    <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold", className)}>
      {children}
    </span>
  );
}

function RuntimeLifecyclePills({ runtime }: { runtime?: AgentRuntimeInstanceRecord }) {
  if (!runtime) return null;
  return (
    <>
      <Pill className={runtimeStateClass(runtime.runtimeState)}>
        {`生命周期 · ${RUNTIME_STATE_LABEL[runtime.runtimeState]}`}
      </Pill>
      {runtime.activityState ? (
        <Pill className={activityStateClass(runtime.activityState)}>
          {`活动 · ${ACTIVITY_STATE_LABEL[runtime.activityState]}`}
        </Pill>
      ) : null}
    </>
  );
}

function MetricTile({ label, value, tone }: { label: string; value: number | string; tone: string }) {
  return (
    <div className={cn("rounded-[8px] border px-4 py-3", tone)}>
      <p className="text-xs opacity-80">{label}</p>
      <p className="mt-1 truncate font-mono text-2xl font-semibold">{value}</p>
    </div>
  );
}

function FieldValue({ label, value }: { label: string; value?: string | number }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] text-zinc-600">{label}</p>
      <p className="mt-1 truncate font-mono text-xs text-zinc-300" title={String(value ?? "")}>
        {value ?? "--"}
      </p>
    </div>
  );
}

function countRows<T extends string>(counts: Record<T, number>, labels: Record<T, string>) {
  return (Object.entries(counts) as Array<[T, number]>)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => ({ key, label: labels[key] ?? key, count }));
}

function CountBar({ label, count, total }: { label: string; count: number; total: number }) {
  const width = total > 0 ? Math.max(5, Math.round((count / total) * 100)) : 0;
  return (
    <div className="grid grid-cols-[72px_minmax(0,1fr)_48px] items-center gap-2">
      <span className="truncate text-xs text-zinc-400" title={label}>{label}</span>
      <span className="h-1.5 overflow-hidden rounded-full bg-white/10">
        <span className="block h-full rounded-full bg-teal-300/70" style={{ width: `${width}%` }} />
      </span>
      <span className="text-right font-mono text-xs text-zinc-500">{count}</span>
    </div>
  );
}

function agentParams(agent: AgentInventoryItem, timeType?: SecurityTimeType) {
  const params = new URLSearchParams();
  if (timeType) params.set("timeType", timeType);
  params.set("agentId", agent.agentId);
  params.set("agentAssetId", agent.agentAssetId);
  if (agent.agentInstanceId) params.set("agentInstanceId", agent.agentInstanceId);
  params.set("workspacePath", agent.workspacePath);
  return params;
}

function matchesSelectedAgent(
  agent: AgentInventoryItem | undefined,
  agentAssetId: string,
  agentInstanceId: string,
  legacyAgentId: string,
  legacyWorkspacePath: string,
) {
  if (!agent) return false;
  if (agentAssetId) {
    return (
      (agent.agentAssetId === agentAssetId || agent.agentAssetAliases?.includes(agentAssetId) === true) &&
      (!agentInstanceId || agent.agentInstanceId === agentInstanceId)
    );
  }
  return Boolean(
    legacyAgentId &&
    agent.agentId === legacyAgentId &&
    (!legacyWorkspacePath || agent.workspacePath === legacyWorkspacePath),
  );
}

function agentEventsHref(agent: AgentInventoryItem, timeType: SecurityTimeType) {
  return `/events?${agentParams(agent, timeType).toString()}`;
}

function agentEvidenceHref(agent: AgentInventoryItem, timeType: SecurityTimeType) {
  return `/evidence?${agentParams(agent, timeType).toString()}`;
}

function agentTopologyHref(agent: AgentInventoryItem, timeType: SecurityTimeType) {
  const params = agentParams(agent, timeType);
  return `/topology?${params.toString()}`;
}

function agentIncidentsHref(agent: AgentInventoryItem, timeType: SecurityTimeType) {
  const params = agentParams(agent, timeType);
  params.set("status", "open");
  return `/incidents?${params.toString()}`;
}

function agentAlertsHref(agent: AgentInventoryItem, timeType: SecurityTimeType) {
  const params = agentParams(agent, timeType);
  params.set("status", "all");
  return `/alerts?${params.toString()}`;
}

function agentCoverageHref(agent: AgentInventoryItem) {
  const params = new URLSearchParams({ agentId: agent.agentId, workspacePath: agent.workspacePath });
  if (agent.healthState === "stale") params.set("type", "agent_stale");
  return `/coverage?${params.toString()}`;
}

function agentRemediationHref(agent: AgentInventoryItem) {
  return `/remediation?${agentParams(agent, "last_7d").toString()}`;
}

function agentMaintenanceHref(agent: AgentInventoryItem) {
  const targetId = `${agent.workspacePath}:${agent.agentId}`;
  const params = new URLSearchParams({ targetType: "agent", targetId });
  return `/maintenance?${params.toString()}`;
}

function agentObjectiveHref(agent: AgentInventoryItem) {
  const params = new URLSearchParams({ targetType: "agent", targetId: `${agent.workspacePath}:${agent.agentId}`, agentId: agent.agentId, workspacePath: agent.workspacePath, metric: "active_alerts" });
  return `/objectives?${params.toString()}`;
}

function agentNotificationHref(agent: AgentInventoryItem) {
  const params = agentParams(agent);
  params.set("kind", "agent");
  params.set("minSeverity", "high");
  return `/notifications?${params.toString()}`;
}

function actionEventHref(
  agent: AgentInventoryItem,
  eventId: string,
  timeType: SecurityTimeType,
  startTime?: string,
  endTime?: string,
) {
  const params = agentParams(agent, timeType);
  params.set("eventId", eventId);
  if (timeType === "custom" && startTime) params.set("startTime", startTime);
  if (timeType === "custom" && endTime) params.set("endTime", endTime);
  return `/events?${params.toString()}`;
}

const ACTION_STATUS_LABEL: Record<AgentActionItem["status"], string> = {
  running: "执行中",
  succeeded: "已完成",
  failed: "失败",
  incomplete: "仅内核证据",
};

function actionStatusClass(status: AgentActionItem["status"]) {
  if (status === "failed") return "border-rose-400/30 bg-rose-500/10 text-rose-100";
  if (status === "succeeded") return "border-teal-400/30 bg-teal-500/10 text-teal-100";
  if (status === "running") return "border-sky-400/30 bg-sky-500/10 text-sky-100";
  return "border-amber-400/30 bg-amber-500/10 text-amber-100";
}

function formatDuration(durationMs?: number) {
  if (durationMs === undefined) return "--";
  if (durationMs < 1_000) return `${durationMs}ms`;
  return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)}s`;
}

function AgentActionEvidence({
  action,
  agent,
  timeType,
  startTime,
  endTime,
}: {
  action: AgentActionItem;
  agent: AgentInventoryItem;
  timeType: SecurityTimeType;
  startTime?: string;
  endTime?: string;
}) {
  const semanticAction = Boolean(action.invocationId && action.toolCallId);
  const { data, loading, error, refresh } = useRequest(
    () => securityCenterApi.agentToolEvidence({
      timeType,
      startTime: timeType === "custom" ? startTime : undefined,
      endTime: timeType === "custom" ? endTime : undefined,
      scope: "agent",
      durable: true,
      agentAssetId: agent.agentAssetId,
      agentInstanceId: action.agentRuntimeInstanceId ?? agent.agentInstanceId,
      sourceId: action.sourceId,
      invocationId: action.invocationId!,
      toolCallId: action.toolCallId,
      limit: 1_000,
    }),
    {
      ready: semanticAction,
      refreshDeps: [action.actionId, agent.agentAssetId, timeType, startTime, endTime],
      loadingDelay: 160,
    },
  );
  const evidence = data?.items.find((item) => item.toolCallId === action.toolCallId);

  if (!semanticAction) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/8 bg-amber-500/[0.035] px-4 py-3 text-xs leading-5 text-zinc-400">
        <span>该行为由精确 Agent Runtime 下的内核事件推断，只能归因到 Runtime，未虚构 Invocation 或 ToolCall。</span>
        {action.fallbackEventId ? (
          <Link to={actionEventHref(agent, action.fallbackEventId, timeType, startTime, endTime)} className="shrink-0 font-medium text-teal-200 hover:text-teal-100">查看原始事件</Link>
        ) : null}
      </div>
    );
  }

  return (
    <div className="border-t border-white/8 bg-black/10 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-medium text-zinc-300">关联证据</span>
          {evidence ? (
            <Pill className={cn(
              evidence.status === "linked"
                ? "border-teal-400/30 bg-teal-500/10 text-teal-100"
                : evidence.status === "ambiguous"
                  ? "border-rose-400/30 bg-rose-500/10 text-rose-100"
                  : "border-amber-400/30 bg-amber-500/10 text-amber-100",
            )}>
              {evidence.status === "linked" ? "已严格关联" : evidence.status === "ambiguous" ? "证据冲突" : "仅语义记录"}
            </Pill>
          ) : null}
          {data?.partial ? <Pill className="border-amber-400/30 bg-amber-500/10 text-amber-100">证据覆盖不完整</Pill> : null}
          {data ? <span className="font-mono text-[11px] text-zinc-600">{data.dataSource}</span> : null}
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={refresh} disabled={loading} className="h-7 text-zinc-400 hover:bg-white/5 hover:text-zinc-100">
          <RefreshCw className={cn("size-3", loading && "animate-spin")} />
          刷新证据
        </Button>
      </div>
      {error ? (
        <p className="mt-2 text-xs text-rose-200">{error.message || "证据关联加载失败"}</p>
      ) : loading && !data ? (
        <p className="mt-2 flex items-center gap-2 text-xs text-zinc-500"><LoaderCircle className="size-3.5 animate-spin" />正在按 Invocation、进程与资源强证据关联</p>
      ) : !evidence ? (
        <p className="mt-2 text-xs leading-5 text-zinc-500">
          当前快照未返回该 ToolCall 的关联结果{data?.partialReasons?.length ? `：${data.partialReasons.join("、")}` : ""}。
        </p>
      ) : (
        <div className="mt-2 space-y-2">
          <p className="text-xs leading-5 text-zinc-500">
            {evidence.status === "linked"
              ? `通过 ${evidence.reason} 关联 ${evidence.kernelEvidence.length} 条内核证据；没有使用单独的时间邻近进行猜测。`
              : evidence.status === "ambiguous"
                ? "多个强声明竞争同一证据，系统保留冲突而不强行归因。"
                : evidence.reason === "kernel_read_not_captured"
                  ? "工具语义已确认，但当前读取能力或采集窗口没有提供对应内核 read-open 证据。"
                  : "工具语义已确认，当前没有满足严格条件的本机内核证据。"}
          </p>
          {evidence.kernelEvidence.map((item) => (
            <div key={item.eventId} className="grid gap-2 rounded border border-white/8 bg-white/[0.025] px-3 py-2 text-[11px] sm:grid-cols-[100px_minmax(0,1fr)_auto] sm:items-center">
              <span className="font-mono text-zinc-500">{formatDate(item.at)}</span>
              <span className="min-w-0 truncate text-zinc-300">{`${item.eventKind} · ${item.linkMethod} · confidence ${item.confidence.toFixed(2)}`}</span>
              <Link to={actionEventHref(agent, item.eventId, timeType, startTime, endTime)} className="font-medium text-teal-200 hover:text-teal-100">查看原始事件</Link>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AgentActionTrace({
  agent,
  timeType,
  startTime,
  endTime,
}: {
  agent: AgentInventoryItem;
  timeType: SecurityTimeType;
  startTime?: string;
  endTime?: string;
}) {
  const [selectedAction, setSelectedAction] = useState<AgentActionItem>();
  const { data, loading, error, refresh } = useRequest(
    () => securityCenterApi.agentActions({
      timeType,
      startTime: timeType === "custom" ? startTime : undefined,
      endTime: timeType === "custom" ? endTime : undefined,
      scope: "agent",
      durable: true,
      noise: "hide",
      agentAssetId: agent.agentAssetId,
      agentInstanceId: agent.agentInstanceId,
      limit: 80,
    }),
    {
      refreshDeps: [agent.agentAssetId, agent.agentInstanceId, timeType, startTime, endTime],
      loadingDelay: 200,
    },
  );
  const actions = data?.items ?? [];
  const toolEventCount = agent.eventCategoryCounts.tool ?? 0;

  useEffect(() => {
    setSelectedAction(undefined);
  }, [agent.agentAssetId, agent.agentInstanceId, timeType, startTime, endTime]);

  return (
    <section className="overflow-hidden rounded-md border border-white/10 bg-white/[0.03]">
      <div className="flex flex-col gap-3 border-b border-white/10 px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <TerminalSquare className="size-4 shrink-0 text-teal-200" />
            <h3 className="text-sm font-semibold text-zinc-100">Agent 行为追踪</h3>
            <Pill className="border-white/10 bg-white/5 text-zinc-300">{`${toolEventCount} 条语义/工具事件`}</Pill>
          </div>
          <p className="mt-1 text-xs leading-5 text-zinc-500">
            SDK/Adapter 的 ToolCall 是顶层行为，文件、进程和网络事件作为内核证据嵌套展示；无 Adapter 时只推断到精确 Runtime，不伪造 ToolCall。
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="font-mono text-[11px] text-zinc-500">
            {data ? `当前 ${actions.length}${data.totalMode === "exact" ? `/${data.total}` : "+"} 个行为` : "--"}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={refresh}
            disabled={loading}
            className="h-8 text-zinc-400 hover:bg-white/5 hover:text-zinc-100"
          >
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
            刷新
          </Button>
          <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
            <Link to={agentEventsHref(agent, timeType)}>
              <Search className="size-3.5" />
              全部事件
            </Link>
          </Button>
        </div>
      </div>

      {error ? (
        <div className="flex items-start gap-2 px-3 py-4 text-xs text-rose-200">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>{error.message || "Agent 行为加载失败"}</span>
        </div>
      ) : loading && !data ? (
        <div className="flex items-center justify-center gap-2 px-3 py-8 text-xs text-zinc-500">
          <LoaderCircle className="size-4 animate-spin" />
          正在聚合该 Agent 的语义行为与 Runtime 证据
        </div>
      ) : actions.length === 0 ? (
        <div className="px-3 py-8 text-center text-xs text-zinc-500">当前行为窗口没有可聚合的 Agent 行为</div>
      ) : (
        <div className="max-h-[520px] divide-y divide-white/8 overflow-y-auto">
          {data?.coverage?.partial ? (
            <div className="flex items-start gap-2 bg-amber-500/[0.05] px-3 py-2 text-[11px] leading-5 text-amber-100/80">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span>{`行为数据覆盖不完整：${data.coverage.partialReason ?? "存储或扫描范围受限"}；当前来源 ${data.coverage.source}。`}</span>
            </div>
          ) : null}
          {actions.map((action) => {
            const active = selectedAction?.actionId === action.actionId;
            return (
              <article key={action.actionId} className={cn("transition-colors", active && "bg-teal-400/[0.035]")}>
                <button
                  type="button"
                  aria-expanded={active}
                  onClick={() => setSelectedAction(active ? undefined : action)}
                  className="grid min-h-14 w-full gap-2 px-3 py-3 text-left hover:bg-white/[0.025] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-300/60 md:grid-cols-[110px_minmax(0,1fr)_auto]"
                >
                  <div className="font-mono text-[11px] text-zinc-500">
                    <p>{formatDate(action.startedAt)}</p>
                    <p className="mt-1">{formatDuration(action.durationMs)}</p>
                  </div>
                  <div className="min-w-0">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <code className="break-all text-xs font-semibold leading-5 text-zinc-100">{action.toolName}</code>
                      <Pill className={action.origin === "semantic" ? "border-violet-400/25 bg-violet-500/10 text-violet-100" : "border-amber-400/25 bg-amber-500/10 text-amber-100"}>
                        {action.origin === "semantic" ? "语义行为" : "内核推断"}
                      </Pill>
                    </div>
                    <p className="mt-1 truncate text-[11px] text-zinc-500" title={action.targetSummary}>
                      {action.targetSummary ?? (action.origin === "semantic" ? "工具未暴露目标摘要" : "Runtime 级执行证据")}
                    </p>
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] text-zinc-600">
                      {action.invocationId ? <span>{`inv ${action.invocationId}`}</span> : <span>invocation 未知</span>}
                      {action.toolCallId ? <span>{`tool ${action.toolCallId}`}</span> : null}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 md:justify-end">
                    <Pill className={actionStatusClass(action.status)}>{ACTION_STATUS_LABEL[action.status]}</Pill>
                    <ChevronDown className={cn("size-4 text-zinc-500 transition-transform", active && "rotate-180")} />
                  </div>
                </button>
                {active ? (
                  <AgentActionEvidence
                    key={action.actionId}
                    action={selectedAction}
                    agent={agent}
                    timeType={timeType}
                    startTime={startTime}
                    endTime={endTime}
                  />
                ) : null}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function AgentRow({
  agent,
  runtime,
  active,
  onSelect,
}: {
  agent: AgentInventoryItem;
  runtime?: AgentRuntimeInstanceRecord;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "grid w-full grid-cols-[92px_minmax(0,1fr)_134px_72px] items-center gap-3 border-b border-white/8 px-3 py-3 text-left transition hover:bg-white/[0.05]",
        active && "bg-teal-400/8",
      )}
    >
      <span className="font-mono text-xs text-zinc-500">{formatDate(agent.lastSeen)}</span>
      <span className="min-w-0">
        <AgentAssetIdentityInline agent={agent} />
        {agent.owner ? <span className="ml-3 mt-0.5 block truncate text-[10px] text-zinc-600">{agent.owner}</span> : null}
      </span>
      <span className="flex flex-col items-start gap-1">
        <Pill className={healthClass(agent.healthState)}>{HEALTH_LABEL[agent.healthState]}</Pill>
        <RuntimeLifecyclePills runtime={runtime} />
      </span>
      <span className="text-right font-mono text-xs text-zinc-500">{agent.eventCount}</span>
    </button>
  );
}

function AgentDetail({
  agent,
  runtime,
  timeType,
  startTime,
  endTime,
  draft,
  saving,
  reviewing,
  pendingReview,
  reviewError,
  reviewNotice,
  reviewFocused,
  reviewSourceEventHref,
  onDraftChange,
  onSaveMetadata,
  onRequestReview,
  onCancelReview,
  onConfirmReview,
}: {
  agent?: AgentInventoryItem;
  runtime?: AgentRuntimeInstanceRecord;
  timeType: SecurityTimeType;
  startTime?: string;
  endTime?: string;
  draft: AgentMetadataDraft;
  saving: boolean;
  reviewing: boolean;
  pendingReview: PendingReviewDecision | null;
  reviewError?: string;
  reviewNotice?: string;
  reviewFocused: boolean;
  reviewSourceEventHref?: string;
  onDraftChange: (patch: Partial<AgentMetadataDraft>) => void;
  onSaveMetadata: () => void;
  onRequestReview: (decision: PendingReviewDecision) => void;
  onCancelReview: () => void;
  onConfirmReview: () => void;
}) {
  if (!agent) {
    return (
      <section className="rounded-[8px] border border-white/10 bg-[#111612]/92">
        <div className="flex min-h-[360px] items-center justify-center text-sm text-zinc-500">选择一个智能体查看资产详情</div>
      </section>
    );
  }

  const categoryRows = countRows(agent.eventCategoryCounts, CATEGORY_LABEL);
  const sourceRows = countRows(agent.sourceCounts, SOURCE_LABEL);
  const primaryName = agentPrimaryName(agent);
  const configuredMetadataCount = [
    agent.displayName,
    agent.owner,
    agent.team,
    agent.environment,
    agent.criticality,
    agent.note,
    agent.tags.length > 0 ? agent.tags.join(",") : "",
  ].filter(Boolean).length;
  const reviewConfirmation = pendingReview === "confirmed_agent"
    ? {
        title: "确认 Agent 身份",
        description: agent.workloadRef?.systemdUnit?.startsWith("session-")
          ? "该裁决将作用于当前运行范围，其中可能包含多个智能体进程、终端和普通命令。请先核对工作负载与识别证据。"
          : "确认后，后续同一稳定身份的事件将按已确认 Agent 归因，历史事件保持不变。",
        action: "确认是 Agent",
        actionClassName: "bg-emerald-500 text-[#07100c] hover:bg-emerald-400",
      }
    : pendingReview === "non_agent"
      ? {
          title: "确认标记为非 Agent",
          description: "只有尚未识别的稳定身份可以被排除。Collector 将停止转发后续常规事件；历史证据、裁决记录和抑制计数仍会保留。",
          action: "确认标记非 Agent",
          actionClassName: "bg-slate-200 text-slate-950 hover:bg-white",
        }
      : pendingReview === "clear"
        ? {
            title: "恢复自动识别",
            description: "清除当前人工身份覆盖并保留审核历史。Inventory、签名、认证 Adapter 和 Behavior 会重新参与识别；若全局过滤规则仍匹配，采集档位可能不会立即变化。",
            action: "确认恢复自动识别",
            actionClassName: "bg-zinc-200 text-zinc-950 hover:bg-white",
          }
        : pendingReview === "unknown"
        ? {
            title:
              agent.classification === "probable_agent"
                ? "证据不足，降为未知"
                : agent.classification === "non_agent"
                  ? "设为待确认"
                  : "撤销确认，设为待确认",
            description:
              agent.classification === "non_agent"
                ? "这会继续保留人工覆盖，只把当前结论改为待确认；它不等于恢复自动识别，也不保证改变 Ring 前采集档位。"
                : "该身份将进入尚未识别状态并继续采集，已有事件、原始分类和人工审核记录保持不变。",
            action:
              agent.classification === "non_agent"
                ? "确认设为待确认"
                : agent.classification === "probable_agent"
                  ? "确认降为未知"
                  : "确认撤销",
            actionClassName: "bg-zinc-200 text-zinc-950 hover:bg-white",
          }
        : undefined;

  return (
    <section className="rounded-[8px] border border-white/10 bg-[#111612]/92">
      <div className="flex min-h-12 items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Bot className="size-4 shrink-0 text-teal-200" />
          <AgentAssetIdentityInline agent={agent} showClassification />
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Pill className={riskClass(agent.riskLevel)}>{agent.riskLevelText}</Pill>
          <Pill className={healthClass(agent.healthState)}>{HEALTH_LABEL[agent.healthState]}</Pill>
          <RuntimeLifecyclePills runtime={runtime} />
        </div>
      </div>

      <div className="space-y-4 p-4">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <FieldValue label="当前显示名" value={primaryName} />
          <FieldValue label="采集时名称" value={agent.detectedName ?? agent.agentId} />
          <FieldValue label="原始 Scope" value={agent.agentId} />
          <FieldValue label="逻辑 Agent ID" value={agent.agentAssetId} />
          <FieldValue label="实例定位" value={agent.locationLabel} />
          <FieldValue label="运行实例 ID" value={agent.agentInstanceId} />
          <FieldValue label="Root PID" value={agent.rootPid} />
          <FieldValue label="Root Start" value={agent.rootStartTime} />
          <FieldValue
            label="实例状态"
            value={agent.lifecycleState === "current" ? "当前实例" : agent.lifecycleState === "terminated" ? "已结束" : "历史实例"}
          />
          <FieldValue label="同逻辑 Agent 实例" value={agent.logicalInstanceCount ?? agent.instanceCount} />
          <FieldValue label="Workspace" value={agent.workspacePath} />
          <FieldValue label="User" value={agent.userId} />
          <FieldValue label="First Seen" value={formatDate(agent.firstSeen)} />
          <FieldValue label="Last Seen" value={formatDate(agent.lastSeen)} />
          {agent.terminatedAt ? <FieldValue label="Ended At" value={formatDate(agent.terminatedAt)} /> : null}
          <FieldValue label="Last Event" value={agent.lastEventSubject} />
          <FieldValue label="生命周期" value={runtime ? RUNTIME_STATE_LABEL[runtime.runtimeState] : "未关联"} />
          <FieldValue label="活动状态" value={runtime?.activityState ? ACTIVITY_STATE_LABEL[runtime.activityState] : "--"} />
          <FieldValue label="根进程" value={runtime ? `PID ${runtime.rootPid} · generation ${runtime.rootGeneration}` : "--"} />
          <FieldValue label="Runtime Last Seen" value={runtime ? formatDate(runtime.lastSeenAt) : "--"} />
        </div>

        <IdentityAiReview
          targetType="agent"
          agentAssetId={agent.agentAssetId}
          timeType={timeType}
          startTime={startTime}
          endTime={endTime}
        />

        <div
          id="agent-review"
          className={cn(
            "scroll-mt-4 rounded-md border border-amber-400/20 bg-amber-500/[0.06] p-3 transition-shadow",
            reviewFocused && "ring-1 ring-amber-300/50 ring-offset-2 ring-offset-[#111612]",
          )}
        >
          <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <UserCheck className="size-4 text-amber-200" />
                <h3 className="text-sm font-semibold text-zinc-100">人工身份裁决</h3>
                <Pill className={classificationClass(agent.classification)}>{CLASSIFICATION_LABEL[agent.classification]}</Pill>
                {reviewSourceEventHref ? (
                  <Link
                    to={reviewSourceEventHref}
                    className="inline-flex items-center gap-1 text-[11px] font-semibold text-teal-300 hover:text-teal-200"
                  >
                    <Search className="size-3" />
                    返回来源事件
                  </Link>
                ) : null}
              </div>
              <p className="mt-2 text-xs leading-5 text-zinc-400">
                显示名和身份裁决相互独立，原始事件始终保留。候选可确认或降为未知；只有尚未识别的稳定身份才能标记为非 Agent。
              </p>
              {agent.workloadRef?.systemdUnit?.startsWith("session-") ? (
                <p className="mt-1 text-xs leading-5 text-amber-200/80">
                  当前身份覆盖整个 {agent.workloadRef.systemdUnit}，其中可能包含多个智能体进程、终端和普通命令；细粒度进程树拆分完成前请谨慎裁决。
                </p>
              ) : null}
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-zinc-500">
                <span>physical={agent.physicalWorkloadId ?? "--"}</span>
                <span>instance={agent.agentInstanceId ?? "--"}</span>
                <span>keys={agent.reviewIdentityKeys.length}</span>
                {agent.agentAssetAliases?.length ? <span>aliases={agent.agentAssetAliases.length}</span> : null}
                <span>source={agent.attributionSource}</span>
              </div>
              {agent.reviewDecision ? (
                <p className="mt-2 text-xs text-zinc-400">
                  人工结论：{CLASSIFICATION_LABEL[agent.reviewDecision]}
                  {agent.reviewedBy ? ` · ${agent.reviewedBy}` : ""}
                  {agent.reviewedAt ? ` · ${formatDate(agent.reviewedAt)}` : ""}
                </p>
              ) : null}
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              {(agent.classification === "probable_agent" || agent.classification === "unknown") ? (
                <Button
                  type="button"
                  size="sm"
                  disabled={reviewing || Boolean(pendingReview)}
                  onClick={() => onRequestReview("confirmed_agent")}
                  className="h-8 bg-emerald-500 text-[#07100c] hover:bg-emerald-400"
                >
                  {reviewing ? <LoaderCircle className="size-3.5 animate-spin" /> : <BadgeCheck className="size-3.5" />}
                  确认是 Agent
                </Button>
              ) : null}
              {agent.classification === "unknown" ? (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={reviewing || Boolean(pendingReview)}
                  onClick={() => onRequestReview("non_agent")}
                  className="h-8 border border-slate-400/20 bg-slate-500/10 text-slate-200 hover:bg-slate-500/20"
                >
                  <Ban className="size-3.5" />
                  标记为非 Agent
                </Button>
              ) : null}
              {agent.classification !== "unknown" ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={reviewing || Boolean(pendingReview)}
                  onClick={() => onRequestReview(agent.classification === "non_agent" ? "clear" : "unknown")}
                  className="h-8 text-zinc-400 hover:bg-white/5 hover:text-zinc-100"
                >
                  <RotateCcw className="size-3.5" />
                  {agent.classification === "probable_agent"
                    ? "证据不足，降为未知"
                    : agent.classification === "non_agent"
                      ? "恢复自动识别"
                      : "撤销确认，重新观察"}
                </Button>
              ) : null}
              {agent.classification === "non_agent" ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={reviewing || Boolean(pendingReview)}
                  onClick={() => onRequestReview("unknown")}
                  className="h-8 text-zinc-500 hover:bg-white/5 hover:text-zinc-200"
                >
                  设为待确认
                </Button>
              ) : null}
            </div>
          </div>
          {reviewNotice ? (
            <div className="mt-3 flex items-start gap-2 rounded-md border border-emerald-400/20 bg-emerald-500/10 px-3 py-2 text-xs leading-5 text-emerald-100">
              <CircleCheck className="mt-0.5 size-3.5 shrink-0" />
              <span>{reviewNotice}</span>
            </div>
          ) : null}
          {reviewError ? (
            <div className="mt-3 flex items-start gap-2 rounded-md border border-rose-400/20 bg-rose-500/10 px-3 py-2 text-xs leading-5 text-rose-100">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span>{reviewError}</span>
            </div>
          ) : null}
          {reviewConfirmation ? (
            <div
              role="group"
              aria-label="确认人工身份裁决"
              className="mt-3 rounded-md border border-amber-300/25 bg-[#17150d] px-3 py-3"
            >
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div className="flex min-w-0 items-start gap-2.5">
                  <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border border-amber-300/25 bg-amber-400/10">
                    <ShieldQuestion className="size-3.5 text-amber-200" />
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-zinc-100">{reviewConfirmation.title}</p>
                    <p className="mt-1 text-xs leading-5 text-zinc-400">{reviewConfirmation.description}</p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center justify-end gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={reviewing}
                    onClick={onCancelReview}
                    className="h-8 text-zinc-400 hover:bg-white/5 hover:text-zinc-100"
                  >
                    返回
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={reviewing}
                    onClick={onConfirmReview}
                    className={cn("h-8", reviewConfirmation.actionClassName)}
                  >
                    {reviewing ? <LoaderCircle className="size-3.5 animate-spin" /> : <BadgeCheck className="size-3.5" />}
                    {reviewConfirmation.action}
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
        </div>

        <details className="group rounded-md border border-white/10 bg-white/[0.03]">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-3 [&::-webkit-details-marker]:hidden">
            <div className="flex min-w-0 items-center gap-2">
              <Settings2 className="size-4 shrink-0 text-teal-200" />
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-zinc-100">身份信息配置</h3>
                <p className="mt-0.5 truncate text-[11px] text-zinc-500">
                  {configuredMetadataCount > 0
                    ? `已配置 ${configuredMetadataCount} 项${agent.owner ? ` · ${agent.owner}` : ""}${agent.environment ? ` · ${agent.environment}` : ""}`
                    : "未配置 · 展开后设置显示名、归属与环境"}
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {agent.metadataUpdatedAt ? <span className="hidden font-mono text-[11px] text-zinc-600 sm:inline">{formatDate(agent.metadataUpdatedAt)}</span> : null}
              <ChevronDown className="size-4 text-zinc-500 transition-transform group-open:rotate-180" />
            </div>
          </summary>
          <div className="border-t border-white/10 p-3">
            <div className="grid gap-3 md:grid-cols-3">
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-zinc-400">显示名</span>
                <Input value={draft.displayName} onChange={(event) => onDraftChange({ displayName: event.target.value })} className="h-9 border-white/10 bg-white/5 text-xs" />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-zinc-400">负责人</span>
                <Input value={draft.owner} onChange={(event) => onDraftChange({ owner: event.target.value })} className="h-9 border-white/10 bg-white/5 text-xs" />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-zinc-400">团队</span>
                <Input value={draft.team} onChange={(event) => onDraftChange({ team: event.target.value })} className="h-9 border-white/10 bg-white/5 text-xs" />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-zinc-400">环境</span>
                <Input value={draft.environment} onChange={(event) => onDraftChange({ environment: event.target.value })} placeholder="prod / staging / dev" className="h-9 border-white/10 bg-white/5 text-xs" />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-zinc-400">重要性</span>
                <Select value={draft.criticality || "unset"} onValueChange={(next) => onDraftChange({ criticality: next === "unset" ? "" : next as AgentCriticality })}>
                  <SelectTrigger className="h-9 border-white/10 bg-white/5 text-xs text-zinc-100"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CRITICALITY_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-zinc-400">标签</span>
                <Input value={draft.tags} onChange={(event) => onDraftChange({ tags: event.target.value })} placeholder="pci, prod, external" className="h-9 border-white/10 bg-white/5 text-xs" />
              </label>
            </div>
            <div className="mt-3 grid gap-3 md:grid-cols-[minmax(0,1fr)_auto]">
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-zinc-400">备注</span>
                <Input value={draft.note} onChange={(event) => onDraftChange({ note: event.target.value })} className="h-9 border-white/10 bg-white/5 text-xs" />
              </label>
              <Button type="button" onClick={onSaveMetadata} disabled={saving} className="mt-5 h-9 bg-teal-500 text-[#07100c] hover:bg-teal-400">
                {saving ? <LoaderCircle className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
                保存
              </Button>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {agent.criticality ? <Pill className={criticalityClass(agent.criticality)}>{`重要性 ${CRITICALITY_LABEL[agent.criticality]}`}</Pill> : null}
              {agent.environment ? <Pill className="border-sky-400/30 bg-sky-500/10 text-sky-100">{agent.environment}</Pill> : null}
              {agent.tags.map((tag) => <Pill key={tag} className="border-white/10 bg-white/5 text-zinc-200">{tag}</Pill>)}
            </div>
          </div>
        </details>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetricTile label="事件" value={agent.eventCount} tone="border-white/10 bg-white/[0.03] text-zinc-100" />
          <MetricTile label="风险事件" value={agent.riskyEventCount} tone="border-amber-400/25 bg-amber-500/10 text-amber-100" />
          <MetricTile label="Open Incident" value={agent.openIncidentCount} tone="border-rose-400/25 bg-rose-500/10 text-rose-100" />
          <MetricTile label="平均延迟" value={`${agent.avgLatencyMs}ms`} tone="border-teal-400/25 bg-teal-500/10 text-teal-100" />
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <FieldValue label="Sessions" value={agent.sessionCount} />
          <FieldValue label="Runs" value={agent.runCount} />
          <FieldValue label="Traces" value={agent.traceCount} />
          <FieldValue label="Token" value={agent.tokenCount} />
          <FieldValue label="Top Risk" value={agent.topRiskName ?? "--"} />
          <FieldValue label="Risk Code" value={agent.topRiskCategory ?? "--"} />
        </div>

        <AgentActionTrace
          agent={agent}
          timeType={timeType}
          startTime={startTime}
          endTime={endTime}
        />

        <div className="grid gap-4 xl:grid-cols-2">
          <div className="rounded-md border border-white/10 bg-white/[0.03] p-3">
            <div className="mb-3 flex items-center gap-2">
              <TerminalSquare className="size-4 text-teal-200" />
              <h3 className="text-sm font-semibold text-zinc-100">事件类型</h3>
            </div>
            <div className="space-y-2">
              {categoryRows.length ? categoryRows.map((row) => (
                <CountBar key={row.key} label={row.label} count={row.count} total={agent.eventCount} />
              )) : <p className="text-xs text-zinc-500">暂无事件</p>}
            </div>
          </div>

          <div className="rounded-md border border-white/10 bg-white/[0.03] p-3">
            <div className="mb-3 flex items-center gap-2">
              <GitBranch className="size-4 text-teal-200" />
              <h3 className="text-sm font-semibold text-zinc-100">来源</h3>
            </div>
            <div className="space-y-2">
              {sourceRows.length ? sourceRows.map((row) => (
                <CountBar key={row.key} label={row.label} count={row.count} total={agent.eventCount} />
              )) : <p className="text-xs text-zinc-500">暂无来源</p>}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button asChild size="sm" className="h-8 bg-teal-500 text-[#07100c] hover:bg-teal-400">
            <Link to={agentEventsHref(agent, timeType)}>
              <Search className="size-3.5" />
              事件
            </Link>
          </Button>
          <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
            <Link to={agentEvidenceHref(agent, timeType)}>
              <FileText className="size-3.5" />
              Evidence
            </Link>
          </Button>
          <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
            <Link to={agentTopologyHref(agent, timeType)}>
              <GitBranch className="size-3.5" />
              拓扑
            </Link>
          </Button>
          <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
            <Link to={agentIncidentsHref(agent, timeType)}>
              <ShieldAlert className="size-3.5" />
              Incident
            </Link>
          </Button>
          <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
            <Link to={agentAlertsHref(agent, timeType)}>
              <BellRing className="size-3.5" />
              告警
            </Link>
          </Button>
          <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
            <Link to={agentCoverageHref(agent)}>
              <EyeOff className="size-3.5" />
              覆盖
            </Link>
          </Button>
          <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
            <Link to={agentRemediationHref(agent)}>
              <FileCheck2 className="size-3.5" />
              处置
            </Link>
          </Button>
          <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
            <Link to={agentMaintenanceHref(agent)}>
              <CalendarClock className="size-3.5" />
              维护
            </Link>
          </Button>
          <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
            <Link to={agentObjectiveHref(agent)}>
              <Target className="size-3.5" />
              目标
            </Link>
          </Button>
          <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
            <Link to={agentNotificationHref(agent)}>
              <Route className="size-3.5" />
              通知
            </Link>
          </Button>
        </div>
      </div>
    </section>
  );
}

export default function AgentsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { filter: consoleTimeFilter, setTimeFilter } = useSecurityConsole();
  const [scope, setScope] = useState<"agent" | "raw">(searchParams.get("scope") === "raw" ? "raw" : "agent");
  const timeType = consoleTimeFilter.timeType ?? "last_3h";
  const routeStartTime = consoleTimeFilter.startTime ?? "";
  const routeEndTime = consoleTimeFilter.endTime ?? "";
  const [healthState, setHealthState] = useState<AgentHealthState | "all">((searchParams.get("healthState") as AgentHealthState) || "all");
  const [assetRange, setAssetRange] = useState<AgentAssetRange>(
    ASSET_RANGE_OPTIONS.some((option) => option.value === searchParams.get("assetRange"))
      ? searchParams.get("assetRange") as AgentAssetRange
      : "current",
  );
  const [queryText, setQueryText] = useState(searchParams.get("q") ?? "");
  const selectedAgentAssetId = searchParams.get("selectedAgentAssetId") ?? searchParams.get("agentAssetId") ?? "";
  const selectedAgentInstanceId = searchParams.get("selectedAgentInstanceId") ?? searchParams.get("agentInstanceId") ?? "";
  const legacySelectedAgentId = selectedAgentAssetId ? "" : searchParams.get("agentId") ?? "";
  const legacySelectedWorkspacePath = selectedAgentAssetId ? "" : searchParams.get("workspacePath") ?? "";
  const hasPinnedSelection = Boolean(selectedAgentAssetId || legacySelectedAgentId);
  const [userId, setUserId] = useState(searchParams.get("userId") ?? "");
  const [metadataDraft, setMetadataDraft] = useState<AgentMetadataDraft>(() => draftFromAgent());
  const [savingMetadata, setSavingMetadata] = useState(false);
  const [reviewingAgent, setReviewingAgent] = useState(false);
  const [pendingReview, setPendingReview] = useState<PendingReviewDecision | null>(null);
  const [reviewError, setReviewError] = useState("");
  const [reviewNotice, setReviewNotice] = useState("");
  const [visibleData, setVisibleData] = useState<AgentInventory>();
  const [pendingData, setPendingData] = useState<AgentInventory>();
  const [selectedAgentSnapshot, setSelectedAgentSnapshot] = useState<AgentInventoryItem>();
  const reviewFocused = searchParams.get("focus") === "review";
  const reviewSourceEventId = searchParams.get("eventId") ?? "";

  const query = useMemo<AgentInventoryQuery>(() => ({
    timeType,
    scope,
    assetRange,
    startTime: timeType === "custom" ? clean(routeStartTime) : undefined,
    endTime: timeType === "custom" ? clean(routeEndTime) : undefined,
    snapshotAsOf: consoleTimeFilter.snapshotAsOf,
    healthState,
    q: clean(queryText),
    userId: clean(userId),
    limit: 200,
  }), [assetRange, consoleTimeFilter.snapshotAsOf, healthState, queryText, routeEndTime, routeStartTime, scope, timeType, userId]);

  const queryKey = useMemo(() => JSON.stringify(query), [query]);
  const { data: incomingSnapshot, loading, error: listError, refresh: refreshList } = useRequest(async () => ({
    queryKey,
    data: await securityCenterApi.agentDirectory({
      ...query,
      snapshotAsOf: liveSecuritySnapshotAsOf(
        timeType === "custom",
        consoleTimeFilter.snapshotAsOf,
      ),
    }),
  }), {
    refreshDeps: [query],
    pollingInterval: 10000,
    pollingWhenHidden: false,
  });

  useEffect(() => {
    setVisibleData(undefined);
    setPendingData(undefined);
  }, [queryKey]);

  useEffect(() => {
    if (!incomingSnapshot || incomingSnapshot.queryKey !== queryKey) return;
    if (!visibleData) {
      setVisibleData(incomingSnapshot.data);
      return;
    }
    if (inventorySignature(incomingSnapshot.data) !== inventorySignature(visibleData)) {
      setPendingData(incomingSnapshot.data);
    }
  }, [incomingSnapshot, queryKey, visibleData]);

  const {
    data: runtimeData,
    error: runtimeError,
    refresh: refreshRuntime,
  } = useRequest(() => securityCenterApi.agentRuntimeInstances({ includeShadow: true, limit: 4096 }), {
    pollingInterval: 10000,
    pollingWhenHidden: false,
  });
  const runtimeLookup = useMemo(
    () => buildAgentRuntimeLookup(runtimeData?.items ?? [], {
      complete: Boolean(runtimeData && runtimeData.total === runtimeData.items.length),
    }),
    [runtimeData],
  );

  const detailQuery = useMemo<AgentInventoryQuery>(() => ({
    timeType,
    startTime: timeType === "custom" ? clean(routeStartTime) : undefined,
    endTime: timeType === "custom" ? clean(routeEndTime) : undefined,
    snapshotAsOf: consoleTimeFilter.snapshotAsOf,
    agentAssetId: clean(selectedAgentAssetId),
    agentInstanceId: clean(selectedAgentInstanceId),
    agentId: selectedAgentAssetId ? undefined : clean(legacySelectedAgentId),
    workspacePath: selectedAgentAssetId ? undefined : clean(legacySelectedWorkspacePath),
    includeUnclassified: hasPinnedSelection,
    limit: 1,
  }), [consoleTimeFilter.snapshotAsOf, hasPinnedSelection, legacySelectedAgentId, legacySelectedWorkspacePath, routeEndTime, routeStartTime, selectedAgentAssetId, selectedAgentInstanceId, timeType]);
  const {
    data: detailData,
    loading: detailLoading,
    error: detailError,
    refresh: refreshDetail,
  } = useRequest(() =>
    securityCenterApi.agentInventory({
      ...detailQuery,
      snapshotAsOf: liveSecuritySnapshotAsOf(
        timeType === "custom",
        consoleTimeFilter.snapshotAsOf,
      ),
    }), {
    ready: hasPinnedSelection,
    refreshDeps: [detailQuery],
  });

  const logicalAgents = useMemo(() => logicalAgentRows(visibleData?.items ?? []), [visibleData?.items]);
  const pendingAgentCount = useMemo(() => {
    if (!pendingData) return 0;
    const visibleIds = new Set(logicalAgents.map((agent) => agent.agentAssetId));
    return logicalAgentRows(pendingData.items).filter((agent) => !visibleIds.has(agent.agentAssetId)).length;
  }, [logicalAgents, pendingData]);
  const selectedAgent = useMemo(() => {
    if (hasPinnedSelection) {
      const detailAgent = detailData?.items?.[0];
      const exactDetail = matchesSelectedAgent(
        detailAgent,
        selectedAgentAssetId,
        selectedAgentInstanceId,
        legacySelectedAgentId,
        legacySelectedWorkspacePath,
      ) ? detailAgent : undefined;
      const lastGood = matchesSelectedAgent(
        selectedAgentSnapshot,
        selectedAgentAssetId,
        selectedAgentInstanceId,
        legacySelectedAgentId,
        legacySelectedWorkspacePath,
      ) ? selectedAgentSnapshot : undefined;
      const visible = logicalAgents.find((agent) => matchesSelectedAgent(
        agent,
        selectedAgentAssetId,
        "",
        legacySelectedAgentId,
        legacySelectedWorkspacePath,
      ));
      return exactDetail ?? lastGood ?? visible;
    }
    return undefined;
  }, [detailData, hasPinnedSelection, legacySelectedAgentId, legacySelectedWorkspacePath, logicalAgents, selectedAgentAssetId, selectedAgentInstanceId, selectedAgentSnapshot]);
  const selectedRuntime = useMemo(
    () => selectedAgent ? matchAgentRuntimeInstance(selectedAgent, runtimeLookup) : undefined,
    [runtimeLookup, selectedAgent],
  );
  const classificationCounts = useMemo(() => {
    const counts: Partial<Record<AgentClassification, number>> = {};
    for (const item of logicalAgents) {
      counts[item.classification] = (counts[item.classification] ?? 0) + 1;
    }
    return counts;
  }, [logicalAgents]);
  const logicalHealthSummary = useMemo(() => ({
    active: logicalAgents.filter((agent) => agent.healthState === "active").length,
    risky: logicalAgents.filter((agent) => agent.healthState === "risky").length,
    stale: logicalAgents.filter((agent) => agent.healthState === "stale").length,
  }), [logicalAgents]);
  const reviewSourceEventHref = useMemo(() => {
    if (!reviewSourceEventId || !selectedAgent) return undefined;
    const params = new URLSearchParams({
      timeType,
      eventId: reviewSourceEventId,
      agentAssetId: selectedAgent.agentAssetId,
    });
    if (selectedAgent.agentInstanceId) params.set("agentInstanceId", selectedAgent.agentInstanceId);
    if (timeType === "custom" && routeStartTime) params.set("startTime", routeStartTime);
    if (timeType === "custom" && routeEndTime) params.set("endTime", routeEndTime);
    return `/events?${params.toString()}`;
  }, [reviewSourceEventId, routeEndTime, routeStartTime, selectedAgent, timeType]);

  useEffect(() => {
    const detailAgent = detailData?.items?.[0];
    if (detailAgent && matchesSelectedAgent(
      detailAgent,
      selectedAgentAssetId,
      selectedAgentInstanceId,
      legacySelectedAgentId,
      legacySelectedWorkspacePath,
    )) {
      setSelectedAgentSnapshot(detailAgent);
    }
  }, [detailData, legacySelectedAgentId, legacySelectedWorkspacePath, selectedAgentAssetId, selectedAgentInstanceId]);

  useEffect(() => {
    if (
      !hasPinnedSelection ||
      !selectedAgent ||
      (
        selectedAgentAssetId &&
        selectedAgent.agentAssetId === selectedAgentAssetId &&
        (!selectedAgentInstanceId || selectedAgent.agentInstanceId === selectedAgentInstanceId)
      )
    ) return;
    const next = new URLSearchParams(searchParams);
    next.delete("agentId");
    next.delete("agentAssetId");
    next.delete("workspacePath");
    next.set("selectedAgentAssetId", selectedAgent.agentAssetId);
    if (selectedAgent.agentInstanceId) next.set("selectedAgentInstanceId", selectedAgent.agentInstanceId);
    setSearchParams(next, { replace: true });
    setReviewNotice("逻辑 Agent 身份已归一；当前仍按独立运行实例展示。");
  }, [hasPinnedSelection, searchParams, selectedAgent, selectedAgentAssetId, selectedAgentInstanceId, setSearchParams]);

  useEffect(() => {
    setMetadataDraft(draftFromAgent(selectedAgent));
  }, [
    selectedAgent?.agentId,
    selectedAgent?.agentAssetId,
    selectedAgent?.agentInstanceId,
    selectedAgent?.workspacePath,
    selectedAgent?.displayName,
    selectedAgent?.owner,
    selectedAgent?.team,
    selectedAgent?.environment,
    selectedAgent?.criticality,
    selectedAgent?.metadataUpdatedAt,
    selectedAgent?.note,
    selectedAgent?.tags.join("|"),
  ]);

  useEffect(() => {
    if (!reviewFocused || !selectedAgent) return;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById("agent-review")?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [reviewFocused, selectedAgent?.agentAssetId, selectedAgent?.agentInstanceId]);

  const selectAgent = (agent: AgentInventoryItem) => {
    setPendingReview(null);
    setReviewError("");
    setReviewNotice("");
    setSelectedAgentSnapshot(agent);
    const next = new URLSearchParams(searchParams);
    next.set("timeType", timeType);
    next.set("scope", scope);
    if (timeType === "custom" && routeStartTime) next.set("startTime", routeStartTime);
    if (timeType === "custom" && routeEndTime) next.set("endTime", routeEndTime);
    next.delete("agentId");
    next.delete("agentAssetId");
    next.delete("workspacePath");
    next.delete("agentInstanceId");
    next.delete("focus");
    next.delete("eventId");
    next.set("selectedAgentAssetId", agent.agentAssetId);
    if (agent.agentInstanceId) next.set("selectedAgentInstanceId", agent.agentInstanceId);
    else next.delete("selectedAgentInstanceId");
    if (healthState !== "all") next.set("healthState", healthState);
    if (assetRange !== "current") next.set("assetRange", assetRange);
    if (clean(queryText)) next.set("q", queryText.trim());
    if (clean(userId)) next.set("userId", userId.trim());
    setSearchParams(next);
  };

  const changeScope = (nextScope: "agent" | "raw") => {
    setScope(nextScope);
    setPendingReview(null);
    setSelectedAgentSnapshot(undefined);
    const next = new URLSearchParams(searchParams);
    next.set("scope", nextScope);
    next.delete("agentId");
    next.delete("agentAssetId");
    next.delete("selectedAgentAssetId");
    next.delete("selectedAgentInstanceId");
    next.delete("workspacePath");
    next.delete("focus");
    next.delete("eventId");
    setSearchParams(next);
  };

  const clearFilters = () => {
    setHealthState("all");
    setAssetRange("current");
    setQueryText("");
    setUserId("");
    setPendingReview(null);
    setReviewError("");
    setReviewNotice("");
    setSelectedAgentSnapshot(undefined);
    setVisibleData(undefined);
    setPendingData(undefined);
    setSearchParams({});
  };

  const loadPendingAssets = () => {
    if (!pendingData) return;
    setVisibleData(pendingData);
    setPendingData(undefined);
  };

  const resumeAssetDirectory = () => {
    setSelectedAgentSnapshot(undefined);
    if (pendingData) loadPendingAssets();
    const next = new URLSearchParams(searchParams);
    next.delete("selectedAgentAssetId");
    next.delete("selectedAgentInstanceId");
    next.delete("agentAssetId");
    next.delete("agentInstanceId");
    next.delete("agentId");
    next.delete("workspacePath");
    next.delete("focus");
    next.delete("eventId");
    setSearchParams(next, { replace: true });
  };

  const saveMetadata = async () => {
    if (!selectedAgent) return;
    setSavingMetadata(true);
    try {
      await securityCenterApi.updateAgentMetadata(selectedAgent.agentId, {
        workspacePath: selectedAgent.workspacePath,
        agentAssetId: selectedAgent.agentAssetId,
        displayName: metadataDraft.displayName,
        owner: metadataDraft.owner,
        team: metadataDraft.team,
        environment: metadataDraft.environment,
        criticality: metadataDraft.criticality,
        tags: splitTags(metadataDraft.tags),
        note: metadataDraft.note,
        identityKeys: selectedAgent.reviewIdentityKeys,
        physicalWorkloadId: selectedAgent.physicalWorkloadId,
        agentInstanceId: selectedAgent.agentInstanceId,
        workloadRef: selectedAgent.workloadRef,
      });
      await Promise.all([refreshList(), refreshDetail()]);
    } finally {
      setSavingMetadata(false);
    }
  };

  const requestReview = (decision: PendingReviewDecision) => {
    setReviewError("");
    setReviewNotice("");
    setPendingReview(decision);
  };

  const cancelReview = () => {
    if (reviewingAgent) return;
    setPendingReview(null);
    setReviewError("");
  };

  const reviewAgent = async () => {
    if (!selectedAgent || !pendingReview) return;
    const decision = pendingReview;
    setReviewingAgent(true);
    setReviewError("");
    setReviewNotice("");
    try {
      await securityCenterApi.reviewAgent(selectedAgent.agentId, {
        workspacePath: selectedAgent.workspacePath,
        decision,
        currentClassification: selectedAgent.classification,
        agentAssetId: selectedAgent.agentAssetId,
        identityKeys: selectedAgent.reviewIdentityKeys,
        physicalWorkloadId: selectedAgent.physicalWorkloadId,
        agentInstanceId: selectedAgent.agentInstanceId,
        workloadRef: selectedAgent.workloadRef,
        note: metadataDraft.note,
      });
      await Promise.all([refreshList(), refreshDetail()]);
      setPendingReview(null);
      setReviewNotice(
        decision === "confirmed_agent"
          ? "已确认 Agent 身份，新的归因快照将同步给 Collector。"
          : decision === "non_agent"
            ? "已标记为非 Agent；历史事件保留，后续常规事件将按稳定身份抑制。"
            : decision === "clear"
              ? "已清除人工覆盖并恢复自动识别；历史审核与观测缺口保留，当前采集档位仍以实际规则状态为准。"
              : selectedAgent.classification === "non_agent"
                ? "已设为待确认；人工覆盖仍存在，不等于恢复自动识别。"
              : "已降为尚未识别并继续采集，历史证据保持不变。",
      );
    } catch (error) {
      setReviewError(error instanceof Error ? error.message : "身份裁决失败，请稍后重试。");
    } finally {
      setReviewingAgent(false);
    }
  };

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-[#0b0f0c] text-zinc-100">
      <header className="shrink-0 border-b border-white/10 bg-[#0b0f0c] px-4 py-3">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <Button asChild variant="secondary" size="sm" className="h-9 shrink-0 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
              <Link to="/?view=agentAssets">
                <ArrowLeft className="size-3.5" />
                返回
              </Link>
            </Button>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Bot className="size-5 shrink-0 text-teal-300" />
                <h1 className="truncate text-lg font-semibold tracking-normal text-zinc-50">智能体资产</h1>
              </div>
              <p className="mt-0.5 truncate text-xs text-zinc-500">持久逻辑资产目录 · Runtime 分层 · 行为窗口只影响统计，不决定资产是否存在</p>
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <AdminTokenControl compact />
            {runtimeError ? (
              <span className="text-amber-300" title="生命周期接口暂不可用；资产健康状态仍按原事件窗口计算">
                生命周期暂不可用
              </span>
            ) : null}
            {listError && visibleData ? <span className="text-amber-300">目录更新失败，继续显示上次快照</span> : null}
            <Clock3 className="size-3.5" />
            <span>{visibleData?.updateTime ? formatDate(visibleData.updateTime) : "等待刷新"}</span>
          </div>
        </div>

        <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-[auto_120px_120px_130px_minmax(160px,0.8fr)_minmax(180px,1fr)_auto_auto]">
          <div className="flex h-9 items-center rounded-md border border-white/10 bg-white/[0.03] p-1">
            <button type="button" onClick={() => changeScope("agent")} className={cn("h-7 rounded px-3 text-xs text-zinc-500", scope === "agent" && "bg-teal-500/15 text-teal-100")}>Agent 资产</button>
            <button type="button" onClick={() => changeScope("raw")} className={cn("h-7 rounded px-3 text-xs text-zinc-500", scope === "raw" && "bg-white/10 text-zinc-100")}>全部资产</button>
          </div>
          <Select value={timeType} onValueChange={(next) => setTimeFilter({ timeType: next as SecurityTimeType })}>
            <SelectTrigger className="h-9 border-white/10 bg-white/5 text-xs text-zinc-100"><SelectValue /></SelectTrigger>
            <SelectContent>
              {TIME_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
              {timeType === "custom" ? <SelectItem value="custom">自定义范围</SelectItem> : null}
            </SelectContent>
          </Select>
          <Select value={assetRange} onValueChange={(next) => setAssetRange(next as AgentAssetRange)}>
            <SelectTrigger className="h-9 border-white/10 bg-white/5 text-xs text-zinc-100"><SelectValue /></SelectTrigger>
            <SelectContent>
              {ASSET_RANGE_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={healthState} onValueChange={(next) => setHealthState(next as AgentHealthState | "all")}>
            <SelectTrigger className="h-9 border-white/10 bg-white/5 text-xs text-zinc-100"><SelectValue /></SelectTrigger>
            <SelectContent>
              {HEALTH_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <Input value={userId} onChange={(event) => setUserId(event.target.value)} placeholder="userId" className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
          <Input value={queryText} onChange={(event) => setQueryText(event.target.value)} placeholder="agent / workspace / risk" className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
          <Button type="button" variant="secondary" size="sm" onClick={clearFilters} className="h-9 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
            <X className="size-3.5" />
            清除
          </Button>
          <Button type="button" size="sm" onClick={() => { void Promise.all([refreshList(), refreshRuntime(), hasPinnedSelection ? refreshDetail() : Promise.resolve()]); }} disabled={loading || detailLoading} className="h-9 bg-teal-500 text-[#07100c] hover:bg-teal-400">
            {loading || detailLoading ? <LoaderCircle className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            检查更新
          </Button>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto flex w-full max-w-[1800px] flex-col gap-4">
          <InventoryCoverageBanner coverage={visibleData?.coverage} directory={visibleData?.directory} />

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
            <MetricTile label="逻辑 Agent" value={logicalAgents.length} tone="border-violet-400/20 bg-violet-500/[0.07] text-violet-100" />
            <MetricTile label="运行实例" value={visibleData?.summary.totalAgents ?? 0} tone="border-white/10 bg-white/[0.03] text-zinc-100" />
            <MetricTile label="活跃" value={logicalHealthSummary.active} tone="border-teal-400/25 bg-teal-500/10 text-teal-100" />
            <MetricTile label="风险" value={logicalHealthSummary.risky} tone="border-rose-400/25 bg-rose-500/10 text-rose-100" />
            <MetricTile label="失联" value={logicalHealthSummary.stale} tone="border-zinc-400/20 bg-zinc-500/10 text-zinc-100" />
            <MetricTile label="行为窗口事件" value={visibleData?.summary.observedEventCount ?? 0} tone="border-amber-400/25 bg-amber-500/10 text-amber-100" />
          </div>

          <div className="grid gap-4 xl:grid-cols-[minmax(460px,0.9fr)_minmax(0,1.4fr)]">
            <section className="min-h-[620px] rounded-[8px] border border-white/10 bg-[#111612]/92">
              <div className="flex min-h-12 flex-wrap items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
                <div className="flex items-center gap-2">
                  <Activity className="size-4 text-teal-200" />
                  <h2 className="text-sm font-semibold text-zinc-100">智能体资产目录</h2>
                  <Pill className={hasPinnedSelection ? "border-amber-400/25 bg-amber-500/10 text-amber-100" : "border-teal-400/25 bg-teal-500/10 text-teal-100"}>
                    {hasPinnedSelection ? "检查模式" : "实时监听"}
                  </Pill>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {pendingData ? (
                    <Button type="button" variant="secondary" size="sm" onClick={loadPendingAssets} className="h-8 border border-teal-400/25 bg-teal-500/10 text-teal-100 hover:bg-teal-500/15">
                      {pendingAgentCount > 0 ? `${pendingAgentCount} 个新资产` : "资产快照已变化"} · 加载
                    </Button>
                  ) : null}
                  {hasPinnedSelection ? (
                    <Button type="button" variant="ghost" size="sm" onClick={resumeAssetDirectory} className="h-8 text-zinc-400 hover:bg-white/5 hover:text-zinc-100">退出检查</Button>
                  ) : null}
                  <span className="text-xs text-zinc-500">{visibleData ? `${logicalAgents.length} 个逻辑资产 · ${visibleData.total} 个实例` : "--"}</span>
                </div>
              </div>
              {loading && !visibleData ? (
                <div className="flex min-h-40 items-center justify-center text-sm text-zinc-500">
                  <LoaderCircle className="mr-2 size-4 animate-spin" />
                  加载资产...
                </div>
              ) : listError && !visibleData ? (
                <div className="flex min-h-40 items-center justify-center px-6 text-center text-sm text-rose-300">
                  智能体资产加载失败，请刷新重试
                </div>
              ) : logicalAgents.length === 0 ? (
                <OperationalEmptyState
                  icon={Bot}
                  title={healthState !== "all" || clean(queryText) || clean(userId)
                    ? "没有符合当前筛选条件的智能体"
                    : scope === "agent" ? "当前没有已确认或候选 Agent 资产" : "当前窗口没有资产"}
                  description={scope === "agent"
                    ? "这里只展示已确认和候选 Agent。请检查 Collector 在线状态，或切换“全部资产”排查 Unknown 与 Non-Agent 记录。"
                    : "扩大时间范围，或检查接入源与 Collector 是否持续上报事件。"}
                  primary={{ label: "检查采集链路", href: "/collectors" }}
                  secondary={{ label: "查看 Workspace", href: "/workspaces" }}
                />
              ) : (
                <div className="max-h-[calc(100vh-300px)] overflow-y-auto">
                  {logicalAgents.map((agent, index, items) => {
                    const previous = items[index - 1];
                    const startsSection = !previous || previous.classification !== agent.classification;
                    return (
                      <div key={agent.agentAssetId}>
                        {startsSection ? (
                          <div className="sticky top-0 z-10 flex items-center justify-between border-b border-white/8 bg-[#111612]/95 px-3 py-2 backdrop-blur">
                            <span className={cn(
                              "text-[11px] font-semibold",
                              agent.classification === "confirmed_agent"
                                ? "text-emerald-200"
                                : agent.classification === "probable_agent"
                                  ? "text-amber-200"
                                  : "text-zinc-400",
                            )}>
                              {CLASSIFICATION_LABEL[agent.classification]}
                            </span>
                            <span className="text-[10px] text-zinc-600">
                              {classificationCounts[agent.classification] ?? 0} 个
                            </span>
                          </div>
                        ) : null}
                        <AgentRow
                          agent={agent}
                          runtime={matchAgentRuntimeInstance(agent, runtimeLookup)}
                          active={agent.agentAssetId === selectedAgent?.agentAssetId}
                          onSelect={() => selectAgent(agent)}
                        />
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            <div className="space-y-4">
              {hasPinnedSelection && detailError && !selectedAgent ? (
                <section className="rounded-[8px] border border-rose-400/20 bg-[#111612]/92">
                  <div className="flex min-h-[360px] items-center justify-center px-6 text-center text-sm text-rose-300">指定智能体资产加载失败，请刷新重试</div>
                </section>
              ) : hasPinnedSelection && detailLoading && !selectedAgent ? (
                <section className="rounded-[8px] border border-white/10 bg-[#111612]/92">
                  <div className="flex min-h-[360px] items-center justify-center text-sm text-zinc-500"><LoaderCircle className="mr-2 size-4 animate-spin" />加载资产详情...</div>
                </section>
              ) : hasPinnedSelection && !detailLoading && !selectedAgent ? (
                <section className="rounded-[8px] border border-white/10 bg-[#111612]/92">
                  <div className="flex min-h-[360px] items-center justify-center px-6 text-center text-sm text-zinc-500">未找到指定智能体资产；该资产可能已合并或不在当前访问范围</div>
                </section>
              ) : <AgentDetail
                agent={selectedAgent}
                runtime={selectedRuntime}
                timeType={timeType}
                startTime={timeType === "custom" ? routeStartTime : undefined}
                endTime={timeType === "custom" ? routeEndTime : undefined}
                draft={metadataDraft}
                saving={savingMetadata}
                reviewing={reviewingAgent}
                pendingReview={pendingReview}
                reviewError={reviewError}
                reviewNotice={reviewNotice}
                reviewFocused={reviewFocused}
                reviewSourceEventHref={reviewSourceEventHref}
                onDraftChange={(patch) => setMetadataDraft((current) => ({ ...current, ...patch }))}
                onSaveMetadata={saveMetadata}
                onRequestReview={requestReview}
                onCancelReview={cancelReview}
                onConfirmReview={reviewAgent}
              />}
              <section className="rounded-[8px] border border-white/10 bg-[#111612]/92 p-4">
                <div className="mb-3 flex items-center gap-2">
                  <AlertTriangle className="size-4 text-amber-200" />
                  <h2 className="text-sm font-semibold text-zinc-100">风险覆盖</h2>
                </div>
                <div className="grid gap-3 sm:grid-cols-3">
                  <FieldValue label="Open Incident Agents" value={visibleData?.summary.openIncidentAgents ?? 0} />
                  <FieldValue label="Risk Events" value={visibleData?.summary.riskyEventCount ?? 0} />
                  <FieldValue label="Idle Agents" value={visibleData?.summary.idleAgents ?? 0} />
                  <FieldValue label="Managed Agents" value={visibleData?.summary.managedAgents ?? 0} />
                  <FieldValue label="Production Agents" value={visibleData?.summary.productionAgents ?? 0} />
                  <FieldValue label="High Criticality" value={visibleData?.summary.highCriticalityAgents ?? 0} />
                </div>
              </section>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
