import { useRequest } from "ahooks";
import dayjs from "dayjs";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  type AgentEventCategory,
  type AgentEventSource,
  type AgentClassification,
  type AgentCriticality,
  type AgentHealthState,
  type AgentInventoryItem,
  type AgentInventoryQuery,
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
  { value: "last_3h", label: "近3小时" },
  { value: "last_1d", label: "近一天" },
  { value: "last_7d", label: "近一周" },
  { value: "last_30d", label: "近一月" },
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

type PendingReviewDecision = "confirmed_agent" | "unknown" | "non_agent";

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
  params.set("workspacePath", agent.workspacePath);
  return params;
}

function matchesSelectedAgent(
  agent: AgentInventoryItem | undefined,
  agentAssetId: string,
  legacyAgentId: string,
  legacyWorkspacePath: string,
) {
  if (!agent) return false;
  if (agentAssetId) {
    return agent.agentAssetId === agentAssetId || agent.agentAssetAliases?.includes(agentAssetId) === true;
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
      : pendingReview === "unknown"
        ? {
            title:
              agent.classification === "probable_agent"
                ? "证据不足，降为未知"
                : agent.classification === "non_agent"
                  ? "重新纳入观察"
                  : "撤销确认，重新观察",
            description:
              agent.classification === "non_agent"
                ? "恢复后 Collector 将重新转发该稳定身份的事件，并从尚未识别状态继续观察。历史排除记录不会删除。"
                : "该身份将进入尚未识别状态并继续采集，已有事件、原始分类和人工审核记录保持不变。",
            action:
              agent.classification === "non_agent"
                ? "确认重新观察"
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
          <FieldValue label="资产 ID" value={agent.agentAssetId} />
          <FieldValue label="实例定位" value={agent.locationLabel} />
          <FieldValue label="运行实例" value={agent.instanceCount} />
          <FieldValue label="Workspace" value={agent.workspacePath} />
          <FieldValue label="User" value={agent.userId} />
          <FieldValue label="First Seen" value={formatDate(agent.firstSeen)} />
          <FieldValue label="Last Seen" value={formatDate(agent.lastSeen)} />
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
                  onClick={() => onRequestReview("unknown")}
                  className="h-8 text-zinc-400 hover:bg-white/5 hover:text-zinc-100"
                >
                  <RotateCcw className="size-3.5" />
                  {agent.classification === "probable_agent"
                    ? "证据不足，降为未知"
                    : agent.classification === "non_agent"
                      ? "重新纳入观察"
                      : "撤销确认，重新观察"}
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
  const [scope, setScope] = useState<"agent" | "raw">(searchParams.get("scope") === "raw" ? "raw" : "agent");
  const [timeType, setTimeType] = useState<SecurityTimeType>((searchParams.get("timeType") as SecurityTimeType) || "last_3h");
  const routeStartTime = searchParams.get("startTime") ?? "";
  const routeEndTime = searchParams.get("endTime") ?? "";
  const [healthState, setHealthState] = useState<AgentHealthState | "all">((searchParams.get("healthState") as AgentHealthState) || "all");
  const [queryText, setQueryText] = useState(searchParams.get("q") ?? "");
  const selectedAgentAssetId = searchParams.get("selectedAgentAssetId") ?? searchParams.get("agentAssetId") ?? "";
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
  const reviewFocused = searchParams.get("focus") === "review";
  const reviewSourceEventId = searchParams.get("eventId") ?? "";

  const query = useMemo<AgentInventoryQuery>(() => ({
    timeType,
    scope,
    startTime: timeType === "custom" ? clean(routeStartTime) : undefined,
    endTime: timeType === "custom" ? clean(routeEndTime) : undefined,
    healthState,
    q: clean(queryText),
    userId: clean(userId),
    limit: 200,
  }), [healthState, queryText, routeEndTime, routeStartTime, scope, timeType, userId]);

  const { data, loading, error: listError, refresh: refreshList } = useRequest(() => securityCenterApi.agentInventory(query), {
    refreshDeps: [query],
    pollingInterval: 10000,
    pollingWhenHidden: false,
  });

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
    agentAssetId: clean(selectedAgentAssetId),
    agentId: selectedAgentAssetId ? undefined : clean(legacySelectedAgentId),
    workspacePath: selectedAgentAssetId ? undefined : clean(legacySelectedWorkspacePath),
    includeUnclassified: hasPinnedSelection,
    limit: 1,
  }), [hasPinnedSelection, legacySelectedAgentId, legacySelectedWorkspacePath, routeEndTime, routeStartTime, selectedAgentAssetId, timeType]);
  const {
    data: detailData,
    loading: detailLoading,
    error: detailError,
    refresh: refreshDetail,
  } = useRequest(() => securityCenterApi.agentInventory(detailQuery), {
    ready: hasPinnedSelection,
    refreshDeps: [detailQuery],
    pollingInterval: 10000,
    pollingWhenHidden: false,
  });

  const selectedAgent = useMemo(() => {
    const items = data?.items ?? [];
    if (hasPinnedSelection) {
      const detailAgent = detailData?.items?.[0];
      return matchesSelectedAgent(
        detailAgent,
        selectedAgentAssetId,
        legacySelectedAgentId,
        legacySelectedWorkspacePath,
      ) ? detailAgent : undefined;
    }
    return items[0];
  }, [data, detailData, hasPinnedSelection, legacySelectedAgentId, legacySelectedWorkspacePath, selectedAgentAssetId]);
  const selectedRuntime = useMemo(
    () => selectedAgent ? matchAgentRuntimeInstance(selectedAgent, runtimeLookup) : undefined,
    [runtimeLookup, selectedAgent],
  );
  const classificationCounts = useMemo(() => {
    const counts: Partial<Record<AgentClassification, number>> = {};
    for (const item of data?.items ?? []) {
      counts[item.classification] = (counts[item.classification] ?? 0) + 1;
    }
    return counts;
  }, [data?.items]);
  const reviewSourceEventHref = useMemo(() => {
    if (!reviewSourceEventId || !selectedAgent) return undefined;
    const params = new URLSearchParams({
      timeType,
      eventId: reviewSourceEventId,
      agentAssetId: selectedAgent.agentAssetId,
    });
    if (timeType === "custom" && routeStartTime) params.set("startTime", routeStartTime);
    if (timeType === "custom" && routeEndTime) params.set("endTime", routeEndTime);
    return `/events?${params.toString()}`;
  }, [reviewSourceEventId, routeEndTime, routeStartTime, selectedAgent, timeType]);

  useEffect(() => {
    if (!hasPinnedSelection || !selectedAgent || (selectedAgentAssetId && selectedAgent.agentAssetId === selectedAgentAssetId)) return;
    const next = new URLSearchParams(searchParams);
    next.delete("agentId");
    next.delete("agentAssetId");
    next.delete("workspacePath");
    next.set("selectedAgentAssetId", selectedAgent.agentAssetId);
    setSearchParams(next, { replace: true });
    setReviewNotice("该资产身份已归一，当前展示其唯一资产记录。");
  }, [hasPinnedSelection, searchParams, selectedAgent, selectedAgentAssetId, setSearchParams]);

  useEffect(() => {
    setMetadataDraft(draftFromAgent(selectedAgent));
  }, [
    selectedAgent?.agentId,
    selectedAgent?.agentAssetId,
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
  }, [reviewFocused, selectedAgent?.agentAssetId]);

  const selectAgent = (agent: AgentInventoryItem) => {
    setPendingReview(null);
    setReviewError("");
    setReviewNotice("");
    const next = new URLSearchParams(searchParams);
    next.set("timeType", timeType);
    next.set("scope", scope);
    if (timeType === "custom" && routeStartTime) next.set("startTime", routeStartTime);
    if (timeType === "custom" && routeEndTime) next.set("endTime", routeEndTime);
    next.delete("agentId");
    next.delete("agentAssetId");
    next.delete("workspacePath");
    next.delete("focus");
    next.delete("eventId");
    next.set("selectedAgentAssetId", agent.agentAssetId);
    if (healthState !== "all") next.set("healthState", healthState);
    if (clean(queryText)) next.set("q", queryText.trim());
    if (clean(userId)) next.set("userId", userId.trim());
    setSearchParams(next);
  };

  const changeScope = (nextScope: "agent" | "raw") => {
    setScope(nextScope);
    setPendingReview(null);
    const next = new URLSearchParams(searchParams);
    next.set("scope", nextScope);
    next.delete("agentId");
    next.delete("agentAssetId");
    next.delete("selectedAgentAssetId");
    next.delete("workspacePath");
    next.delete("focus");
    next.delete("eventId");
    setSearchParams(next);
  };

  const clearFilters = () => {
    setHealthState("all");
    setQueryText("");
    setUserId("");
    setPendingReview(null);
    setReviewError("");
    setReviewNotice("");
    setSearchParams({});
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
            : selectedAgent.classification === "non_agent"
              ? "已重新纳入观察，Collector 将恢复转发该身份的事件。"
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
              <Link to="/">
                <ArrowLeft className="size-3.5" />
                返回
              </Link>
            </Button>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Bot className="size-5 shrink-0 text-teal-300" />
                <h1 className="truncate text-lg font-semibold tracking-normal text-zinc-50">智能体资产</h1>
              </div>
              <p className="mt-0.5 truncate text-xs text-zinc-500">已确认与候选 Agent · 事件聚合 · 人工身份审核</p>
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <AdminTokenControl compact />
            {runtimeError ? (
              <span className="text-amber-300" title="生命周期接口暂不可用；资产健康状态仍按原事件窗口计算">
                生命周期暂不可用
              </span>
            ) : null}
            <Clock3 className="size-3.5" />
            <span>{data?.updateTime ? formatDate(data.updateTime) : "等待刷新"}</span>
          </div>
        </div>

        <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-[auto_120px_130px_minmax(160px,0.8fr)_minmax(180px,1fr)_auto_auto]">
          <div className="flex h-9 items-center rounded-md border border-white/10 bg-white/[0.03] p-1">
            <button type="button" onClick={() => changeScope("agent")} className={cn("h-7 rounded px-3 text-xs text-zinc-500", scope === "agent" && "bg-teal-500/15 text-teal-100")}>Agent 资产</button>
            <button type="button" onClick={() => changeScope("raw")} className={cn("h-7 rounded px-3 text-xs text-zinc-500", scope === "raw" && "bg-white/10 text-zinc-100")}>全部资产</button>
          </div>
          <Select value={timeType} onValueChange={(next) => setTimeType(next as SecurityTimeType)}>
            <SelectTrigger className="h-9 border-white/10 bg-white/5 text-xs text-zinc-100"><SelectValue /></SelectTrigger>
            <SelectContent>
              {TIME_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
              {timeType === "custom" ? <SelectItem value="custom">自定义范围</SelectItem> : null}
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
            刷新
          </Button>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto flex w-full max-w-[1800px] flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <MetricTile label="资产" value={data?.summary.totalAgents ?? 0} tone="border-white/10 bg-white/[0.03] text-zinc-100" />
            <MetricTile label="活跃" value={data?.summary.activeAgents ?? 0} tone="border-teal-400/25 bg-teal-500/10 text-teal-100" />
            <MetricTile label="风险" value={data?.summary.riskyAgents ?? 0} tone="border-rose-400/25 bg-rose-500/10 text-rose-100" />
            <MetricTile label="失联" value={data?.summary.staleAgents ?? 0} tone="border-zinc-400/20 bg-zinc-500/10 text-zinc-100" />
            <MetricTile label="事件" value={data?.summary.observedEventCount ?? 0} tone="border-amber-400/25 bg-amber-500/10 text-amber-100" />
          </div>

          <div className="grid gap-4 xl:grid-cols-[minmax(460px,0.9fr)_minmax(0,1.4fr)]">
            <section className="min-h-[620px] rounded-[8px] border border-white/10 bg-[#111612]/92">
              <div className="flex min-h-12 items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
                <div className="flex items-center gap-2">
                  <Activity className="size-4 text-teal-200" />
                  <h2 className="text-sm font-semibold text-zinc-100">智能体资产</h2>
                </div>
                <span className="text-xs text-zinc-500">{data ? `${data.total} 个` : "--"}</span>
              </div>
              {loading && !data ? (
                <div className="flex min-h-40 items-center justify-center text-sm text-zinc-500">
                  <LoaderCircle className="mr-2 size-4 animate-spin" />
                  加载资产...
                </div>
              ) : listError ? (
                <div className="flex min-h-40 items-center justify-center px-6 text-center text-sm text-rose-300">
                  智能体资产加载失败，请刷新重试
                </div>
              ) : (data?.items?.length ?? 0) === 0 ? (
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
                  {data?.items.map((agent, index, items) => {
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
              {hasPinnedSelection && detailError ? (
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
                  <FieldValue label="Open Incident Agents" value={data?.summary.openIncidentAgents ?? 0} />
                  <FieldValue label="Risk Events" value={data?.summary.riskyEventCount ?? 0} />
                  <FieldValue label="Idle Agents" value={data?.summary.idleAgents ?? 0} />
                  <FieldValue label="Managed Agents" value={data?.summary.managedAgents ?? 0} />
                  <FieldValue label="Production Agents" value={data?.summary.productionAgents ?? 0} />
                  <FieldValue label="High Criticality" value={data?.summary.highCriticalityAgents ?? 0} />
                </div>
              </section>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
