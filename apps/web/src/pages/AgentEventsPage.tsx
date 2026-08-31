import { useRequest } from "ahooks";
import { formatSecurityDateTime, liveSecuritySnapshotAsOf } from "@/lib/date-time";
import {
  AlertTriangle,
  ArrowLeft,
  Clock3,
  FileText,
  GitBranch,
  LoaderCircle,
  RefreshCw,
  Search,
  ShieldAlert,
  SlidersHorizontal,
  TerminalSquare,
  UserCheck,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AdminTokenControl } from "@/components/custom/admin-token-control";
import { AgentIdentityInline, resolveAgentIdentity } from "@/components/custom/agent-identity";
import { ClassificationViewControl } from "@/components/custom/classification-view-control";
import { useSecurityConsole } from "@/components/custom/security-console-header";
import { AdaptiveVirtualList } from "@/components/performance/adaptive-virtual-list";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { assetHref } from "@/lib/asset-routes";
import {
  type AgentEventCategory,
  type AgentEventList,
  type AgentEventListItem,
  type AgentEventQuery,
  type AgentTimeline,
  type ClassificationView,
  type QueryCoverage,
  type SecuritySeverity,
  type SecurityTimeType,
  type SecurityVerdict,
  securityCenterApi,
} from "@/lib/api/security-center";
import { useI18n } from "@/lib/i18n";
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

const CATEGORY_OPTIONS: Array<{ value: AgentEventCategory | "all"; label: string }> = [
  { value: "all", label: "全部类型" },
  { value: "tool", label: "工具" },
  { value: "network", label: "网络" },
  { value: "file", label: "文件" },
  { value: "llm", label: "LLM" },
  { value: "security", label: "安全事件" },
  { value: "process", label: "进程" },
  { value: "runtime", label: "运行时" },
  { value: "unknown", label: "未知" },
];

const VERDICT_OPTIONS: Array<{ value: SecurityVerdict | "all"; label: string }> = [
  { value: "all", label: "全部处置" },
  { value: "allow", label: "放行" },
  { value: "escalate", label: "升级" },
  { value: "block", label: "阻断" },
];

const CATEGORY_LABEL: Record<AgentEventCategory, string> = {
  tool: "工具",
  network: "网络",
  file: "文件",
  llm: "LLM",
  security: "安全事件",
  process: "进程",
  runtime: "运行时",
  unknown: "未知",
};

const VERDICT_LABEL: Record<SecurityVerdict, string> = {
  allow: "放行",
  escalate: "升级",
  block: "阻断",
};

const SEVERITY_LABEL: Record<SecuritySeverity, string> = {
  info: "提示",
  low: "低",
  medium: "中",
  high: "高",
  critical: "严重",
};

function formatDate(value?: string) {
  return formatSecurityDateTime(value, "MM-DD HH:mm:ss", value || "--");
}

function shortId(value?: string) {
  if (!value) return "--";
  return value.length > 22 ? `${value.slice(0, 10)}...${value.slice(-7)}` : value;
}

function severityClass(severity?: SecuritySeverity) {
  if (severity === "critical" || severity === "high") return "border-rose-400/30 bg-rose-500/10 text-rose-100";
  if (severity === "medium") return "border-amber-400/30 bg-amber-500/10 text-amber-100";
  if (severity === "low") return "border-teal-400/30 bg-teal-500/10 text-teal-100";
  return "border-white/10 bg-white/5 text-zinc-300";
}

function verdictClass(verdict?: SecurityVerdict) {
  if (verdict === "block") return "border-rose-400/30 bg-rose-500/10 text-rose-100";
  if (verdict === "escalate") return "border-amber-400/30 bg-amber-500/10 text-amber-100";
  return "border-teal-400/30 bg-teal-500/10 text-teal-100";
}

function Pill({ children, className }: { children: string; className?: string }) {
  return (
    <span className={cn("inline-flex max-w-full items-center truncate rounded-full border px-2 py-0.5 text-[10px] font-semibold", className)}>
      {children}
    </span>
  );
}

function FieldValue({ label, value }: { label: string; value?: string | number }) {
  const { t } = useI18n();
  return (
    <div className="min-w-0">
      <p className="text-[11px] text-zinc-600">{t(label)}</p>
      <p className="mt-1 truncate font-mono text-xs text-zinc-300" title={String(value ?? "")}>
        {value ?? "--"}
      </p>
    </div>
  );
}

function eventListSignature(data?: AgentEventList) {
  if (!data) return "";
  return [
    data.total,
    data.coverage.partial,
    data.coverage.partialReason ?? "full",
    data.coverage.source,
    ...data.items.map((event) => `${event.eventId}:${event.decisionUpdatedAt ?? event.at}:${event.repeatCount ?? 1}`),
  ].join("|");
}

function CoverageBanner({ coverage }: { coverage?: QueryCoverage }) {
  if (!coverage) return null;
  return (
    <div className={cn(
      "border-b px-3 py-2 text-[11px] leading-5",
      coverage.partial
        ? "border-amber-400/15 bg-amber-500/[0.06] text-amber-100/80"
        : "border-white/8 bg-white/[0.02] text-zinc-500",
    )}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span>{coverage.partial ? "覆盖不完整" : "覆盖完整"}</span>
        <span>{`来源 ${coverage.source}`}</span>
        <span>{`数据 ${formatDate(coverage.dataFrom)} → ${formatDate(coverage.dataTo)}`}</span>
        <span>{`快照 ${formatDate(coverage.snapshotAsOf)}`}</span>
        {coverage.partialReason ? <span>{`原因 ${coverage.partialReason}`}</span> : null}
      </div>
    </div>
  );
}

function EventRow({
  event,
  active,
  onSelect,
}: {
  event: AgentEventListItem;
  active: boolean;
  onSelect: () => void;
}) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "grid min-w-0 w-full grid-cols-[68px_54px_minmax(0,1fr)_48px] items-center gap-2 overflow-hidden border-b border-white/8 px-3 py-3 text-left transition hover:bg-white/[0.05] sm:grid-cols-[88px_72px_minmax(0,1fr)_70px] sm:gap-3",
        active && "bg-teal-400/8",
      )}
    >
      <span className="min-w-0 font-mono text-xs text-zinc-500">{formatDate(event.at)}</span>
      <span className="min-w-0">
        <Pill className={severityClass(event.severity)}>{t(CATEGORY_LABEL[event.eventCategory] ?? event.eventCategory)}</Pill>
      </span>
      <span className="min-w-0">
        <AgentIdentityInline event={event} className="flex min-w-0" />
        <span className="mt-0.5 block truncate text-[11px] text-zinc-500" title={event.subject}>
          {event.subject}
        </span>
      </span>
      <span className="flex min-w-0 justify-end">
        <Pill className={verdictClass(event.verdict)}>{t(VERDICT_LABEL[event.verdict])}</Pill>
      </span>
    </button>
  );
}

function AttributeList({ event }: { event?: AgentEventListItem }) {
  const { t } = useI18n();
  const attrs = Object.entries(event?.attributes ?? {});
  if (attrs.length === 0) {
    return <div className="rounded-md border border-white/10 px-3 py-5 text-center text-xs text-zinc-500">{t("暂无属性")}</div>;
  }
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {attrs.map(([key, value]) => (
        <div key={key} className="min-w-0 rounded-md border border-white/10 bg-white/[0.03] px-3 py-2">
          <p className="truncate text-[11px] text-zinc-600" title={key}>{key}</p>
          <p className="mt-1 truncate font-mono text-xs text-zinc-300" title={String(value)}>{String(value)}</p>
        </div>
      ))}
    </div>
  );
}

function EventDetail({
  event,
  loading,
  pinned,
  timeType,
  startTime,
  endTime,
}: {
  event?: AgentEventListItem;
  loading?: boolean;
  pinned?: boolean;
  timeType: SecurityTimeType;
  startTime?: string;
  endTime?: string;
}) {
  const { t } = useI18n();
  if (!event) {
    return (
      <section className="min-w-0 overflow-hidden rounded-[8px] border border-white/10 bg-[#0f131a]/92">
        <div className="flex min-h-[360px] items-center justify-center gap-2 px-6 text-center text-sm text-zinc-500">
          {loading ? <LoaderCircle className="size-4 animate-spin" /> : null}
          {t(loading ? "正在按稳定 Event ID 加载详情" : pinned ? "该事件不在当前页，且当前持久存储无法返回详情" : "选择一个事件查看详情")}
        </div>
      </section>
    );
  }

  const eventSourceId = event.sourceId ?? (typeof event.attributes.sourceId === "string" ? event.attributes.sourceId : undefined);
  const eventCollectorId = event.collectorId ?? (typeof event.attributes.collectorId === "string" ? event.attributes.collectorId : undefined);
  const agentIdentity = resolveAgentIdentity(event);
  const workload = agentIdentity.workload;
  const topologyQs = new URLSearchParams({
    timeType,
    eventId: event.eventId,
    agentId: event.agentId,
    workspacePath: event.workspacePath,
  });
  topologyQs.set("agentAssetId", event.agentAssetId);
  if (eventSourceId) topologyQs.set("sourceId", eventSourceId);
  if (eventCollectorId) topologyQs.set("collectorId", eventCollectorId);
  const evidenceQs = new URLSearchParams({
    timeType,
    eventId: event.eventId,
    traceId: event.traceId,
    runId: event.runId,
    sessionId: event.sessionId,
    agentId: event.agentId,
    workspacePath: event.workspacePath,
  });
  evidenceQs.set("agentAssetId", event.agentAssetId);
  if (eventSourceId) evidenceQs.set("sourceId", eventSourceId);
  if (eventCollectorId) evidenceQs.set("collectorId", eventCollectorId);
  const assetQs = new URLSearchParams({
    timeType,
    focus: "review",
    eventId: event.eventId,
  });
  if (startTime) assetQs.set("startTime", startTime);
  if (endTime) assetQs.set("endTime", endTime);
  const resolvedAssetId = event.subjectAssetId ?? (event.assetBindingQuality === undefined ? event.agentAssetId : undefined);

  return (
    <section className="min-w-0 overflow-hidden rounded-[8px] border border-white/10 bg-[#0f131a]/92">
      <div className="flex min-h-12 items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <FileText className="size-4 shrink-0 text-teal-200" />
          <div className="min-w-0">
            <AgentIdentityInline event={event} showClassification />
            <p className="mt-0.5 truncate text-xs text-zinc-500" title={event.subject}>{event.subject}</p>
          </div>
        </div>
        <Pill className={severityClass(event.severity)}>{t(SEVERITY_LABEL[event.severity])}</Pill>
      </div>
      <div className="space-y-4 p-4">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <FieldValue label="Event ID" value={event.eventId} />
          <FieldValue label="Trace ID" value={event.traceId} />
          <FieldValue label="Span ID" value={event.spanId} />
          <FieldValue label="Run ID" value={event.runId} />
          <FieldValue label="当前显示名" value={agentIdentity.name} />
          <FieldValue label="采集时名称" value={event.detectedName ?? event.attribution?.agentDisplayName} />
          <FieldValue label="原始执行者" value={event.agentId} />
          <FieldValue label="Agent 资产 ID" value={event.agentAssetId} />
          <FieldValue label="实例定位" value={event.locationLabel} />
          <FieldValue label="Collector" value={eventCollectorId} />
          <FieldValue label="Source ID" value={eventSourceId} />
          <FieldValue label="Session" value={event.sessionId} />
          <FieldValue label="Workspace" value={event.workspacePath} />
          <FieldValue label="Source" value={event.source} />
          <FieldValue label="Kind" value={event.eventKind} />
          <FieldValue label="活动语义" value={event.activityContext} />
          <FieldValue label="活动子类型" value={event.activitySubtype} />
        </div>

        <div className="grid gap-3 sm:grid-cols-4">
          <div className="rounded-md border border-white/10 bg-white/[0.03] px-3 py-2">
            <p className="text-[11px] text-zinc-600">{t("处置")}</p>
            <div className="mt-2"><Pill className={verdictClass(event.verdict)}>{t(VERDICT_LABEL[event.verdict])}</Pill></div>
          </div>
          <div className="rounded-md border border-white/10 bg-white/[0.03] px-3 py-2">
            <p className="text-[11px] text-zinc-600">{t("风险分")}</p>
            <p className="mt-1 font-mono text-xl font-semibold text-zinc-100">{event.riskScore}</p>
          </div>
          <div className="rounded-md border border-white/10 bg-white/[0.03] px-3 py-2">
            <p className="text-[11px] text-zinc-600">Token</p>
            <p className="mt-1 font-mono text-xl font-semibold text-zinc-100">{event.tokenCount}</p>
          </div>
          <div className="rounded-md border border-white/10 bg-white/[0.03] px-3 py-2">
            <p className="text-[11px] text-zinc-600">{t("延迟")}</p>
            <p className="mt-1 font-mono text-xl font-semibold text-zinc-100">{event.latencyMs}ms</p>
          </div>
        </div>

        <div className="flex flex-col gap-3 rounded-md border border-teal-400/20 bg-teal-500/[0.06] px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <UserCheck className="size-4 shrink-0 text-teal-200" />
              <p className="text-sm font-semibold text-zinc-100">
                {t(agentIdentity.classification === "unknown" ? "身份信息" : "归属智能体")}
              </p>
            </div>
            <p className="mt-1 text-xs leading-5 text-zinc-400">
              {t(agentIdentity.classification === "unknown"
                ? "当前身份尚未确认，可前往身份审核查看完整运行证据。"
                : "身份辅助审核与人工裁决在关联资产中统一进行，本页保留采集时的单条事件证据。")}
            </p>
          </div>
          {resolvedAssetId ? (
            <Button asChild type="button" size="sm" className="h-8 shrink-0 bg-teal-400 text-slate-950 hover:bg-teal-300">
              <Link to={assetHref(resolvedAssetId, assetQs)}>{t("查看关联资产")}</Link>
            </Button>
          ) : <span className="text-xs text-amber-200">{t("当前仅有 unassigned 调查分组")}</span>}
        </div>

        <div>
          <p className="mb-2 text-xs font-medium text-zinc-400">{t("Agent 归因详情")}</p>
          <div className="grid gap-3 rounded-md border border-white/10 bg-white/[0.03] px-3 py-3 sm:grid-cols-2 xl:grid-cols-4">
            <FieldValue label="当前状态" value={t(agentIdentity.classificationLabel)} />
            <FieldValue label="发生时身份" value={event.asObservedClassification} />
            <FieldValue label="当前有效身份" value={event.currentEffectiveClassification} />
            <FieldValue label="资产绑定" value={`${event.assetBindingQuality ?? "unassigned"} · r${event.assetBindingRevision ?? 0}`} />
            <FieldValue label="自动检测状态" value={
              event.detectedClassification === "confirmed_agent"
                ? t("已确认 Agent")
                : event.detectedClassification === "probable_agent"
                  ? t("候选 Agent")
                  : event.detectedClassification === "non_agent"
                    ? t("已排除")
                    : t("尚未识别")
            } />
            <FieldValue label="部署环境" value={agentIdentity.runtimeLabel ? t(agentIdentity.runtimeLabel) : t("未知")} />
            <FieldValue label="识别来源" value={event.attribution?.source ?? "none"} />
            <FieldValue label="置信度" value={event.attribution ? `${Math.round(event.attribution.confidence * 100)}%` : "0%"} />
            <FieldValue label="Agent Scope ID" value={event.attribution?.agentScopeId ?? "non-agent"} />
            <FieldValue label="Agent Instance ID" value={event.attribution?.agentInstanceId} />
            <FieldValue label="物理工作负载" value={event.attribution?.physicalWorkloadId} />
            <FieldValue label="归因原因" value={event.attribution?.reason ?? "not_evaluated"} />
            <FieldValue label="身份分类轴" value={event.classificationSemantics?.identityClassification} />
            <FieldValue label="工作负载角色" value={event.classificationSemantics?.workloadRole} />
            <FieldValue label="采集档位" value={event.classificationSemantics?.captureProfile} />
            <FieldValue label="Unknown 原因" value={event.classificationSemantics?.unknownReason} />
            <FieldValue label="Namespace" value={workload?.namespace} />
            <FieldValue label="Pod" value={workload?.podName} />
            <FieldValue label="容器" value={workload?.containerName} />
            <FieldValue label="镜像" value={workload?.containerImage} />
            <FieldValue label="节点" value={workload?.nodeName ?? event.process?.hostId} />
            <FieldValue label="Owner" value={[workload?.ownerKind, workload?.ownerName].filter(Boolean).join("/") || undefined} />
            <FieldValue label="本地服务" value={workload?.systemdUnit ?? event.process?.systemdUnit} />
            <FieldValue label="进程" value={workload?.processName ?? event.process?.comm} />
            <FieldValue label="可执行文件" value={workload?.executable ?? event.process?.exe} />
            <FieldValue label="Root PID" value={event.attribution?.rootPid} />
            <FieldValue label="Boot ID" value={event.process?.bootId} />
            <FieldValue label="PID" value={event.process?.pid} />
            <FieldValue label="PPID" value={event.process?.ppid} />
            <FieldValue label="进程启动 Ticks" value={event.process?.startTimeTicks} />
            <FieldValue label="Cgroup ID" value={event.process?.cgroupId} />
            <FieldValue label="生命周期事实" value={event.process?.lifecycleSource} />
            <FieldValue label="生命周期缺口" value={event.process?.lifecycleReason} />
          </div>
        </div>

        {event.attribution?.evidence?.length ? (
          <div>
            <p className="mb-2 text-xs font-medium text-zinc-400">{t("Agent 识别证据")}</p>
            <div className="flex flex-wrap gap-2 rounded-md border border-white/10 bg-white/[0.03] px-3 py-3">
              {event.attribution.evidence.map((item) => (
                <code key={item} className="rounded border border-white/10 bg-[#0a0d12] px-2 py-1 text-[11px] text-zinc-400">
                  {item}
                </code>
              ))}
            </div>
          </div>
        ) : null}

        <div>
          <p className="mb-2 text-xs font-medium text-zinc-400">{t("判定原因")}</p>
          <div className="rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-zinc-300">{event.reason}</div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button asChild size="sm" className="h-8 bg-teal-500 text-[#07100c] hover:bg-teal-400">
            <Link to={`/topology?${topologyQs.toString()}`}>
              <GitBranch className="size-3.5" />
              {t("拓扑")}
            </Link>
          </Button>
          <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
            <Link to={`/evidence?${evidenceQs.toString()}`}>
              <FileText className="size-3.5" />
              {t("证据包")}
            </Link>
          </Button>
        </div>

        <div>
          <p className="mb-2 text-xs font-medium text-zinc-400">{t("归一化属性")}</p>
          <AttributeList event={event} />
        </div>

        <div>
          <p className="mb-2 text-xs font-medium text-zinc-400">Raw Preview</p>
          <pre className="max-h-56 overflow-auto rounded-md border border-white/10 bg-[#0a0d12] p-3 text-[11px] leading-relaxed text-zinc-400">
            {event.rawPreview || "--"}
          </pre>
        </div>
      </div>
    </section>
  );
}

function TraceTimeline({ timeline, loading }: { timeline?: AgentTimeline; loading?: boolean }) {
  const { t } = useI18n();
  const items = timeline?.items ?? [];
  return (
    <section className="min-w-0 overflow-hidden rounded-[8px] border border-white/10 bg-[#0f131a]/92">
      <div className="flex min-h-12 items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <GitBranch className="size-4 shrink-0 text-teal-200" />
          <h2 className="truncate text-sm font-semibold text-zinc-100">{t("Trace 时间线")}</h2>
        </div>
        {loading ? <LoaderCircle className="size-4 animate-spin text-zinc-500" /> : <span className="text-xs text-zinc-500">{items.length} {t("步")}</span>}
      </div>
      <CoverageBanner coverage={timeline?.coverage} />
      {items.length === 0 ? (
        <div className="flex min-h-32 items-center justify-center text-sm text-zinc-500">{t("暂无时间线")}</div>
      ) : (
        <div className="max-h-[520px] overflow-y-auto p-4">
          <div className="space-y-3">
            {items.map((event, index) => (
              <div key={event.eventId} className="grid grid-cols-[28px_minmax(0,1fr)] gap-3">
                <div className="flex flex-col items-center">
                  <span className="flex size-6 items-center justify-center rounded-full border border-teal-400/30 bg-teal-500/10 font-mono text-[10px] text-teal-100">
                    {index + 1}
                  </span>
                  {index < items.length - 1 ? <span className="mt-1 h-full min-h-8 w-px bg-white/10" /> : null}
                </div>
                <div className="min-w-0 rounded-md border border-white/10 bg-white/[0.03] px-3 py-2">
                  <div className="flex items-center justify-between gap-3">
                    <p className="truncate text-sm font-medium text-zinc-100" title={event.subject}>{event.subject}</p>
                    <span className="shrink-0 font-mono text-[11px] text-zinc-500">{formatDate(event.at)}</span>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Pill className={severityClass(event.severity)}>{t(CATEGORY_LABEL[event.eventCategory])}</Pill>
                    <Pill className={verdictClass(event.verdict)}>{t(VERDICT_LABEL[event.verdict])}</Pill>
                    <span className="font-mono text-[11px] text-zinc-600">{shortId(event.spanId)}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function clean(value: string) {
  return value.trim() || undefined;
}

export default function AgentEventsPage() {
  const { t } = useI18n();
  const [searchParams, setSearchParams] = useSearchParams();
  const { filter: consoleTimeFilter, setTimeFilter } = useSecurityConsole();
  const timeType = consoleTimeFilter.timeType ?? "last_3h";
  const routeStartTime = consoleTimeFilter.startTime ?? "";
  const routeEndTime = consoleTimeFilter.endTime ?? "";
  const [sourceId, setSourceId] = useState(searchParams.get("sourceId") ?? "");
  const [collectorId, setCollectorId] = useState(searchParams.get("collectorId") ?? "");
  const [workspacePath, setWorkspacePath] = useState(searchParams.get("workspacePath") ?? "");
  const [agentId, setAgentId] = useState(searchParams.get("agentId") ?? "");
  const [agentAssetId, setAgentAssetId] = useState(searchParams.get("agentAssetId") ?? "");
  const [subjectAssetId, setSubjectAssetId] = useState(searchParams.get("subjectAssetId") ?? "");
  const [agentInstanceId, setAgentInstanceId] = useState(searchParams.get("agentInstanceId") ?? "");
  const [sessionId, setSessionId] = useState(searchParams.get("sessionId") ?? "");
  const [traceId, setTraceId] = useState(searchParams.get("traceId") ?? "");
  const [runId, setRunId] = useState(searchParams.get("runId") ?? "");
  const [eventKind, setEventKind] = useState(searchParams.get("eventKind") ?? "");
  const [eventCategory, setEventCategory] = useState<AgentEventCategory | "all">((searchParams.get("eventCategory") as AgentEventCategory) || "all");
  const [verdict, setVerdict] = useState<SecurityVerdict | "all">((searchParams.get("verdict") as SecurityVerdict) || "all");
  const [includeUnknown, setIncludeUnknown] = useState(searchParams.get("includeUnknown") !== "false");
  const [classificationView, setClassificationView] = useState<ClassificationView>(
    searchParams.get("classificationView") === "current_effective" ? "current_effective" : "as_observed",
  );
  const [selectedEventId, setSelectedEventId] = useState(searchParams.get("eventId") ?? "");
  const [selectedEventSnapshot, setSelectedEventSnapshot] = useState<AgentEventListItem>();
  const [inspectMode, setInspectMode] = useState(Boolean(searchParams.get("eventId")));
  const [visibleData, setVisibleData] = useState<AgentEventList>();
  const [pendingData, setPendingData] = useState<AgentEventList>();
  const [advancedFiltersOpen, setAdvancedFiltersOpen] = useState(() => [
    "sourceId", "collectorId", "workspacePath", "agentId", "sessionId", "traceId", "runId", "eventKind", "eventCategory", "verdict",
  ].some((key) => Boolean(searchParams.get(key))) || searchParams.get("includeUnknown") === "false");
  const advancedFilterCount = [sourceId, collectorId, workspacePath, agentId, sessionId, traceId, runId, eventKind]
    .filter((value) => value.trim()).length
    + Number(eventCategory !== "all")
    + Number(verdict !== "all")
    + Number(!includeUnknown);

  const query = useMemo<AgentEventQuery>(() => ({
    timeType,
    startTime: timeType === "custom" ? clean(routeStartTime) : undefined,
    endTime: timeType === "custom" ? clean(routeEndTime) : undefined,
    snapshotAsOf: consoleTimeFilter.snapshotAsOf,
    sourceId: clean(sourceId),
    collectorId: clean(collectorId),
    workspacePath: clean(workspacePath),
    agentId: clean(agentId),
    agentAssetId: clean(agentAssetId),
    subjectAssetId: clean(subjectAssetId),
    agentInstanceId: clean(agentInstanceId),
    sessionId: clean(sessionId),
    traceId: clean(traceId),
    runId: clean(runId),
    eventKind: clean(eventKind),
    eventCategory: eventCategory === "all" ? undefined : eventCategory,
    verdict: verdict === "all" ? undefined : verdict,
    scope: "raw",
    classificationView,
    includeUnknown,
    durable: true,
    limit: 120,
  }), [agentAssetId, agentId, agentInstanceId, classificationView, collectorId, consoleTimeFilter.snapshotAsOf, eventCategory, eventKind, includeUnknown, routeEndTime, routeStartTime, runId, sessionId, sourceId, subjectAssetId, timeType, traceId, verdict, workspacePath]);

  const queryKey = useMemo(() => JSON.stringify(query), [query]);
  const { data: incomingSnapshot, loading, error, refresh } = useRequest(async () => ({
    queryKey,
    data: await securityCenterApi.agentEvents({
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
    if (eventListSignature(incomingSnapshot.data) !== eventListSignature(visibleData)) {
      setPendingData(incomingSnapshot.data);
    }
  }, [incomingSnapshot, queryKey, visibleData]);

  const selectedEvent = selectedEventSnapshot?.eventId === selectedEventId
    ? selectedEventSnapshot
    : undefined;
  const pendingEventCount = useMemo(() => {
    if (!pendingData) return 0;
    const visibleIds = new Set(visibleData?.items.map((event) => event.eventId) ?? []);
    return pendingData.items.filter((event) => !visibleIds.has(event.eventId)).length;
  }, [pendingData, visibleData]);

  const { data: pinnedDetailData, loading: pinnedDetailLoading } = useRequest(
    () => securityCenterApi.agentEvents({
      timeType,
      startTime: timeType === "custom" ? clean(routeStartTime) : undefined,
      endTime: timeType === "custom" ? clean(routeEndTime) : undefined,
      snapshotAsOf: visibleData?.coverage.snapshotAsOf ?? consoleTimeFilter.snapshotAsOf,
      eventId: selectedEventId,
      scope: "raw",
      classificationView,
      includeUnknown: true,
      durable: true,
      limit: 1,
    }),
    {
      ready: Boolean(selectedEventId && !selectedEvent),
      refreshDeps: [classificationView, selectedEventId, timeType, routeStartTime, routeEndTime],
    },
  );

  useEffect(() => {
    const event = pinnedDetailData?.items.find((item) => item.eventId === selectedEventId);
    if (event) setSelectedEventSnapshot(event);
  }, [pinnedDetailData, selectedEventId]);

  const { data: timeline, loading: timelineLoading } = useRequest(
    () => selectedEvent
      ? securityCenterApi.agentTimeline({
          timeType,
          startTime: timeType === "custom" ? clean(routeStartTime) : undefined,
          endTime: timeType === "custom" ? clean(routeEndTime) : undefined,
          snapshotAsOf: visibleData?.coverage.snapshotAsOf ?? consoleTimeFilter.snapshotAsOf,
          eventId: selectedEvent.eventId,
          traceId: selectedEvent.traceId,
          subjectAssetId: clean(subjectAssetId),
          classificationView,
          durable: true,
          limit: 240,
        })
      : Promise.resolve({
          traceId: "",
          items: [],
          total: 0,
          hasMore: false,
          coverage: {
            requestedFrom: "",
            requestedTo: "",
            snapshotAsOf: "",
            asOf: "",
            partial: false,
            source: "memory_hot_ring" as const,
            totalMode: "exact" as const,
          },
          classificationView,
          reviewRevision: 0,
          updateTime: "",
        }),
    {
      refreshDeps: [classificationView, routeEndTime, routeStartTime, selectedEvent?.eventId, subjectAssetId, timeType, visibleData?.coverage.snapshotAsOf],
    },
  );
  const { data: semanticContext, loading: semanticContextLoading } = useRequest(
    () => securityCenterApi.agentKernelSemanticContext(selectedEvent!.eventId),
    {
      ready: Boolean(selectedEvent?.eventId),
      refreshDeps: [selectedEvent?.eventId],
    },
  );

  const selectEvent = (event: AgentEventListItem) => {
    setSelectedEventId(event.eventId);
    setSelectedEventSnapshot(event);
    setInspectMode(true);
    const next = new URLSearchParams(searchParams);
    next.set("eventId", event.eventId);
    setSearchParams(next);
  };

  const loadPendingEvents = () => {
    if (!pendingData) return;
    setVisibleData(pendingData);
    setPendingData(undefined);
  };

  const resumeLive = () => {
    setInspectMode(false);
    setSelectedEventId("");
    setSelectedEventSnapshot(undefined);
    if (pendingData) loadPendingEvents();
    const next = new URLSearchParams(searchParams);
    next.delete("eventId");
    setSearchParams(next, { replace: true });
  };

  const clearFilters = () => {
    setAgentId("");
    setAgentAssetId("");
    setSubjectAssetId("");
    setAgentInstanceId("");
    setSourceId("");
    setCollectorId("");
    setWorkspacePath("");
    setSessionId("");
    setTraceId("");
    setRunId("");
    setEventKind("");
    setEventCategory("all");
    setVerdict("all");
    setIncludeUnknown(true);
    setClassificationView("as_observed");
    setSelectedEventId("");
    setSelectedEventSnapshot(undefined);
    setInspectMode(false);
    setVisibleData(undefined);
    setPendingData(undefined);
    setAdvancedFiltersOpen(false);
    setSearchParams({});
  };

  const changeClassificationView = (value: ClassificationView) => {
    setClassificationView(value);
    if (selectedEventId) setSelectedEventSnapshot(undefined);
    const next = new URLSearchParams(searchParams);
    next.set("classificationView", value);
    setSearchParams(next, { replace: true });
  };

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-[#0a0d12] text-zinc-100">
      <header className="shrink-0 border-b border-white/10 bg-[#0a0d12] px-4 py-3">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <Button asChild variant="secondary" size="sm" className="h-11 shrink-0 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10 sm:h-9">
              <Link to="/">
                <ArrowLeft className="size-3.5" />
                {t("返回")}
              </Link>
            </Button>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <TerminalSquare className="size-5 shrink-0 text-teal-300" />
                <h1 className="truncate text-lg font-semibold tracking-normal text-zinc-50">{t("事件检索")}</h1>
              </div>
              <p className="mt-0.5 truncate text-xs text-zinc-500">{t("统一资产关联 · Trace 时间线 · 风险结论保持不可变")}</p>
            </div>
          </div>
          <div className="flex flex-wrap items-start gap-3 text-xs text-zinc-500">
            <ClassificationViewControl value={classificationView} onChange={changeClassificationView} />
            <AdminTokenControl compact />
            {error && visibleData ? <span className="inline-flex min-h-9 items-center text-amber-200">后台更新失败，继续显示上次快照</span> : null}
            <span className="inline-flex min-h-9 items-center gap-1"><Clock3 className="size-3.5" />{visibleData?.updateTime ? formatDate(visibleData.updateTime) : t("等待刷新")}</span>
          </div>
        </div>

        <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-4 2xl:grid-cols-6">
          <Select value={timeType} onValueChange={(next) => setTimeFilter({ timeType: next as SecurityTimeType })}>
            <SelectTrigger className="h-11 border-white/10 bg-white/5 text-xs text-zinc-100 sm:h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              {TIME_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{t(option.label)}</SelectItem>)}
              {timeType === "custom" ? <SelectItem value="custom">{t("自定义范围")}</SelectItem> : null}
            </SelectContent>
          </Select>
          <Input value={subjectAssetId} onChange={(event) => setSubjectAssetId(event.target.value)} placeholder="subjectAssetId" className="h-11 border-white/10 bg-white/5 font-mono text-xs sm:h-9" />
          <div className="grid grid-cols-2 gap-2 md:contents">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              aria-expanded={advancedFiltersOpen}
              aria-controls="event-advanced-filters"
              onClick={() => setAdvancedFiltersOpen((value) => !value)}
              className="min-h-11 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10 md:hidden"
            >
              <SlidersHorizontal className="size-3.5" />
              {t("更多筛选")}{advancedFilterCount ? ` ${advancedFilterCount}` : ""}
            </Button>
            <Button type="button" size="sm" onClick={refresh} disabled={loading} className="min-h-11 bg-teal-500 text-[#07100c] hover:bg-teal-400 md:min-h-9">
              {loading ? <LoaderCircle className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
              {t("检查更新")}
            </Button>
          </div>
          <div
            id="event-advanced-filters"
            className={advancedFiltersOpen
              ? "grid max-h-[45dvh] gap-2 overflow-y-auto overscroll-contain pr-1 md:contents"
              : "hidden md:contents"}
          >
            <Input value={sourceId} onChange={(event) => setSourceId(event.target.value)} placeholder="sourceId" className="h-11 border-white/10 bg-white/5 font-mono text-xs sm:h-9" />
            <Input value={collectorId} onChange={(event) => setCollectorId(event.target.value)} placeholder="collectorId" className="h-11 border-white/10 bg-white/5 font-mono text-xs sm:h-9" />
            <Input value={workspacePath} onChange={(event) => setWorkspacePath(event.target.value)} placeholder="workspacePath" className="h-11 border-white/10 bg-white/5 font-mono text-xs sm:h-9" />
            <Input value={agentId} onChange={(event) => setAgentId(event.target.value)} placeholder="agentId" className="h-11 border-white/10 bg-white/5 font-mono text-xs sm:h-9" />
            <Input value={sessionId} onChange={(event) => setSessionId(event.target.value)} placeholder="sessionId" className="h-11 border-white/10 bg-white/5 font-mono text-xs sm:h-9" />
            <Input value={traceId} onChange={(event) => setTraceId(event.target.value)} placeholder="traceId" className="h-11 border-white/10 bg-white/5 font-mono text-xs sm:h-9" />
            <Input value={runId} onChange={(event) => setRunId(event.target.value)} placeholder="runId" className="h-11 border-white/10 bg-white/5 font-mono text-xs sm:h-9" />
            <Input value={eventKind} onChange={(event) => setEventKind(event.target.value)} placeholder="eventKind" className="h-11 border-white/10 bg-white/5 font-mono text-xs sm:h-9" />
            <Select value={eventCategory} onValueChange={(next) => setEventCategory(next as AgentEventCategory | "all")}>
              <SelectTrigger className="h-11 border-white/10 bg-white/5 text-xs text-zinc-100 sm:h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                {CATEGORY_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{t(option.label)}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={verdict} onValueChange={(next) => setVerdict(next as SecurityVerdict | "all")}>
              <SelectTrigger className="h-11 border-white/10 bg-white/5 text-xs text-zinc-100 sm:h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                {VERDICT_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{t(option.label)}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              aria-pressed={includeUnknown}
              onClick={() => setIncludeUnknown((value) => !value)}
              className={cn(
                "h-11 border text-xs sm:h-9",
                includeUnknown
                  ? "border-teal-400/30 bg-teal-400/10 text-teal-100 hover:bg-teal-400/15"
                  : "border-white/10 bg-white/5 text-zinc-400 hover:bg-white/10",
              )}
            >
              {t(includeUnknown ? "包含 Unknown" : "隐藏 Unknown")}
            </Button>
            <Button type="button" variant="secondary" size="sm" onClick={clearFilters} className="h-11 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10 sm:h-9">
              <X className="size-3.5" />
              {t("清除")}
            </Button>
          </div>
        </div>
      </header>

      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto grid min-w-0 w-full max-w-[1800px] gap-4 xl:grid-cols-[minmax(420px,0.9fr)_minmax(0,1.25fr)_minmax(360px,0.8fr)]">
          <section className="min-h-[620px] min-w-0 overflow-hidden rounded-[8px] border border-white/10 bg-[#0f131a]/92">
            <div className="flex min-h-12 flex-wrap items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
              <div className="flex items-center gap-2">
                <Search className="size-4 text-teal-200" />
                <h2 className="text-sm font-semibold text-zinc-100">{t("事件")}</h2>
                <Pill className={inspectMode ? "border-amber-400/25 bg-amber-500/10 text-amber-100" : "border-teal-400/25 bg-teal-500/10 text-teal-100"}>
                  {inspectMode ? t("检查模式") : t("实时监听")}
                </Pill>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                {pendingData ? (
                  <Button type="button" variant="secondary" size="sm" onClick={loadPendingEvents} className="h-8 border border-teal-400/25 bg-teal-500/10 text-teal-100 hover:bg-teal-500/15">
                    {pendingEventCount > 0 ? `${pendingEventCount} 条新事件` : "快照已变化"} · 加载
                  </Button>
                ) : null}
                {inspectMode ? (
                  <Button type="button" variant="ghost" size="sm" onClick={resumeLive} className="h-8 text-zinc-400 hover:bg-white/5 hover:text-zinc-100">退出检查</Button>
                ) : null}
                <span
                  className="text-xs text-zinc-500"
                  title={visibleData?.totalApproximate ? t("大窗口使用有界近似去重统计") : undefined}
                  aria-label={visibleData ? `${visibleData.totalApproximate ? `${t("约")} ` : ""}${visibleData.total} ${t("条事件")}` : undefined}
                >
                  {visibleData ? `${visibleData.totalApproximate ? "≈" : ""}${visibleData.total} ${t("条")}` : "--"}
                </span>
              </div>
            </div>
            <CoverageBanner coverage={visibleData?.coverage} />
            {loading && !visibleData ? (
              <div className="flex min-h-40 items-center justify-center text-sm text-zinc-500">
                <LoaderCircle className="mr-2 size-4 animate-spin" />
                {t("加载事件...")}
              </div>
            ) : error && !visibleData ? (
              <div className="flex min-h-40 flex-col items-center justify-center px-6 text-center">
                <AlertTriangle className="size-5 text-rose-300" />
                <p className="mt-2 text-sm text-rose-200">{t("事件加载失败")}</p>
                <p className="mt-1 text-xs leading-5 text-zinc-500">{t(error.message || "请检查 API 与采集链路")}</p>
              </div>
            ) : (visibleData?.items?.length ?? 0) === 0 ? (
              <div className="flex min-h-40 items-center justify-center text-sm text-zinc-500">{t("暂无事件")}</div>
            ) : (
              <AdaptiveVirtualList
                items={visibleData?.items ?? []}
                getKey={(event) => event.eventId}
                estimateSize={76}
                threshold={100}
                className="max-h-[calc(100vh-220px)] overflow-y-auto"
                renderItem={(event) => (
                  <EventRow
                    event={event}
                    active={event.eventId === selectedEvent?.eventId}
                    onSelect={() => selectEvent(event)}
                  />
                )}
              />
            )}
          </section>

          <EventDetail
            event={selectedEvent}
            loading={Boolean(selectedEventId && !selectedEvent && pinnedDetailLoading)}
            pinned={Boolean(selectedEventId)}
            timeType={timeType}
            startTime={timeType === "custom" ? routeStartTime : undefined}
            endTime={timeType === "custom" ? routeEndTime : undefined}
          />

          <div className="space-y-4">
            <section className="rounded-[8px] border border-white/10 bg-[#0f131a]/92 p-4">
              <div className="mb-3 flex items-center gap-2">
                <ShieldAlert className="size-4 text-rose-200" />
                <h2 className="text-sm font-semibold text-zinc-100">{t("当前证据")}</h2>
              </div>
              <div className="grid gap-3">
                <FieldValue label="风险分类" value={selectedEvent?.riskCategory} />
                <FieldValue label="风险名称" value={selectedEvent?.riskName ? t(selectedEvent.riskName) : undefined} />
                <FieldValue label="研判层级" value={selectedEvent?.tier} />
                <FieldValue label="父 Span" value={selectedEvent?.parentSpanId} />
                {semanticContextLoading ? (
                  <p className="flex items-center gap-2 text-xs text-zinc-500"><LoaderCircle className="size-3.5 animate-spin" />正在读取关联 Agent 对话</p>
                ) : semanticContext?.conversationLinks.length ? (
                  <div className="rounded border border-violet-400/15 bg-violet-500/[0.04] p-3">
                    <p className="text-[10px] uppercase tracking-[0.08em] text-zinc-600">关联 Agent 对话</p>
                    <div className="mt-2 space-y-1">
                      {semanticContext.conversationLinks.map((link) => (
                        <Link
                          key={`${link.conversationId}:${link.semanticEventId}`}
                          to={`/conversations?${new URLSearchParams({
                            timeType,
                            conversationId: link.conversationId,
                            semanticEventId: link.semanticEventId,
                          }).toString()}`}
                          className="flex min-h-9 items-center text-xs font-medium text-violet-200 hover:text-violet-100"
                        >
                          查看触发该内核行为的 Thread / Turn
                        </Link>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            </section>
            <TraceTimeline timeline={selectedEvent && timeline?.traceId === selectedEvent.traceId ? timeline : undefined} loading={Boolean(selectedEvent && timelineLoading)} />
          </div>
        </div>
      </main>
    </div>
  );
}
