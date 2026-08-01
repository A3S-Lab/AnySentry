import { useRequest } from "ahooks";
import dayjs from "dayjs";
import {
  ArrowLeft,
  Clock3,
  FileText,
  GitBranch,
  LoaderCircle,
  RefreshCw,
  Search,
  ShieldAlert,
  TerminalSquare,
  UserCheck,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AdminTokenControl } from "@/components/custom/admin-token-control";
import { AgentIdentityInline, resolveAgentIdentity } from "@/components/custom/agent-identity";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  type AgentEventCategory,
  type AgentEventListItem,
  type AgentEventQuery,
  type AgentTimeline,
  type SecuritySeverity,
  type SecurityTimeType,
  type SecurityVerdict,
  securityCenterApi,
} from "@/lib/api/security-center";
import { cn } from "@/lib/utils";

const TIME_OPTIONS: Array<{ value: SecurityTimeType; label: string }> = [
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
  { value: "security", label: "安全" },
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
  security: "安全",
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
  if (!value) return "--";
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? value.replace(" ", "T") + "Z" : value;
  const parsed = dayjs(normalized);
  return parsed.isValid() ? parsed.format("MM-DD HH:mm:ss") : value;
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
    <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold", className)}>
      {children}
    </span>
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

function EventRow({
  event,
  active,
  onSelect,
}: {
  event: AgentEventListItem;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "grid w-full grid-cols-[88px_72px_minmax(0,1fr)_70px] items-center gap-3 border-b border-white/8 px-3 py-3 text-left transition hover:bg-white/[0.05]",
        active && "bg-teal-400/8",
      )}
    >
      <span className="font-mono text-xs text-zinc-500">{formatDate(event.at)}</span>
      <span>
        <Pill className={severityClass(event.severity)}>{CATEGORY_LABEL[event.eventCategory] ?? event.eventCategory}</Pill>
      </span>
      <span className="min-w-0">
        <AgentIdentityInline event={event} className="flex" />
        <span className="mt-0.5 block truncate text-[11px] text-zinc-500" title={event.subject}>
          {event.subject}
        </span>
      </span>
      <span className="flex justify-end">
        <Pill className={verdictClass(event.verdict)}>{VERDICT_LABEL[event.verdict]}</Pill>
      </span>
    </button>
  );
}

function AttributeList({ event }: { event?: AgentEventListItem }) {
  const attrs = Object.entries(event?.attributes ?? {});
  if (attrs.length === 0) {
    return <div className="rounded-md border border-white/10 px-3 py-5 text-center text-xs text-zinc-500">暂无属性</div>;
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
  timeType,
  startTime,
  endTime,
}: {
  event?: AgentEventListItem;
  timeType: SecurityTimeType;
  startTime?: string;
  endTime?: string;
}) {
  if (!event) {
    return (
      <section className="rounded-[8px] border border-white/10 bg-[#111612]/92">
        <div className="flex min-h-[360px] items-center justify-center text-sm text-zinc-500">选择一个事件查看详情</div>
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
  const agentQs = new URLSearchParams({
    timeType,
    agentId: event.agentId,
    agentAssetId: event.agentAssetId,
    workspacePath: event.workspacePath,
    focus: "review",
    eventId: event.eventId,
  });
  if (startTime) agentQs.set("startTime", startTime);
  if (endTime) agentQs.set("endTime", endTime);

  return (
    <section className="rounded-[8px] border border-white/10 bg-[#111612]/92">
      <div className="flex min-h-12 items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <FileText className="size-4 shrink-0 text-teal-200" />
          <div className="min-w-0">
            <AgentIdentityInline event={event} showClassification />
            <p className="mt-0.5 truncate text-xs text-zinc-500" title={event.subject}>{event.subject}</p>
          </div>
        </div>
        <Pill className={severityClass(event.severity)}>{SEVERITY_LABEL[event.severity]}</Pill>
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
        </div>

        <div className="grid gap-3 sm:grid-cols-4">
          <div className="rounded-md border border-white/10 bg-white/[0.03] px-3 py-2">
            <p className="text-[11px] text-zinc-600">处置</p>
            <div className="mt-2"><Pill className={verdictClass(event.verdict)}>{VERDICT_LABEL[event.verdict]}</Pill></div>
          </div>
          <div className="rounded-md border border-white/10 bg-white/[0.03] px-3 py-2">
            <p className="text-[11px] text-zinc-600">风险分</p>
            <p className="mt-1 font-mono text-xl font-semibold text-zinc-100">{event.riskScore}</p>
          </div>
          <div className="rounded-md border border-white/10 bg-white/[0.03] px-3 py-2">
            <p className="text-[11px] text-zinc-600">Token</p>
            <p className="mt-1 font-mono text-xl font-semibold text-zinc-100">{event.tokenCount}</p>
          </div>
          <div className="rounded-md border border-white/10 bg-white/[0.03] px-3 py-2">
            <p className="text-[11px] text-zinc-600">延迟</p>
            <p className="mt-1 font-mono text-xl font-semibold text-zinc-100">{event.latencyMs}ms</p>
          </div>
        </div>

        <div className="flex flex-col gap-3 rounded-md border border-teal-400/20 bg-teal-500/[0.06] px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <UserCheck className="size-4 shrink-0 text-teal-200" />
              <p className="text-sm font-semibold text-zinc-100">
                {agentIdentity.classification === "unknown" ? "身份信息" : "归属智能体"}
              </p>
            </div>
            <p className="mt-1 text-xs leading-5 text-zinc-400">
              {agentIdentity.classification === "unknown"
                ? "当前身份尚未确认，可前往身份审核查看完整运行证据。"
                : "身份辅助审核与人工裁决在智能体资产中统一进行，本页保留采集时的单条事件证据。"}
            </p>
          </div>
          <Button asChild type="button" size="sm" className="h-8 shrink-0 bg-teal-400 text-slate-950 hover:bg-teal-300">
            <Link to={`/agents?${agentQs.toString()}`}>
              {agentIdentity.classification === "unknown" ? "进入身份审核" : "查看智能体资产"}
            </Link>
          </Button>
        </div>

        <div>
          <p className="mb-2 text-xs font-medium text-zinc-400">Agent 归因详情</p>
          <div className="grid gap-3 rounded-md border border-white/10 bg-white/[0.03] px-3 py-3 sm:grid-cols-2 xl:grid-cols-4">
            <FieldValue label="当前状态" value={agentIdentity.classificationLabel} />
            <FieldValue label="自动检测状态" value={
              event.detectedClassification === "confirmed_agent"
                ? "已确认 Agent"
                : event.detectedClassification === "probable_agent"
                  ? "候选 Agent"
                  : event.detectedClassification === "non_agent"
                    ? "已排除"
                    : "尚未识别"
            } />
            <FieldValue label="部署环境" value={agentIdentity.runtimeLabel ?? "未知"} />
            <FieldValue label="识别来源" value={event.attribution?.source ?? "none"} />
            <FieldValue label="置信度" value={event.attribution ? `${Math.round(event.attribution.confidence * 100)}%` : "0%"} />
            <FieldValue label="Agent Scope ID" value={event.attribution?.agentScopeId ?? "non-agent"} />
            <FieldValue label="Agent Instance ID" value={event.attribution?.agentInstanceId} />
            <FieldValue label="物理工作负载" value={event.attribution?.physicalWorkloadId} />
            <FieldValue label="归因原因" value={event.attribution?.reason ?? "not_evaluated"} />
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
          </div>
        </div>

        {event.attribution?.evidence?.length ? (
          <div>
            <p className="mb-2 text-xs font-medium text-zinc-400">Agent 识别证据</p>
            <div className="flex flex-wrap gap-2 rounded-md border border-white/10 bg-white/[0.03] px-3 py-3">
              {event.attribution.evidence.map((item) => (
                <code key={item} className="rounded border border-white/10 bg-[#0b0f0c] px-2 py-1 text-[11px] text-zinc-400">
                  {item}
                </code>
              ))}
            </div>
          </div>
        ) : null}

        <div>
          <p className="mb-2 text-xs font-medium text-zinc-400">判定原因</p>
          <div className="rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-zinc-300">{event.reason}</div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {event.agentId && event.workspacePath ? (
            <Button asChild size="sm" className="h-8 bg-amber-400 text-[#171006] hover:bg-amber-300">
              <Link to={`/agents?${agentQs.toString()}`}>
                <UserCheck className="size-3.5" />
                进入资产审核
              </Link>
            </Button>
          ) : null}
          <Button asChild size="sm" className="h-8 bg-teal-500 text-[#07100c] hover:bg-teal-400">
            <Link to={`/topology?${topologyQs.toString()}`}>
              <GitBranch className="size-3.5" />
              拓扑
            </Link>
          </Button>
          <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
            <Link to={`/evidence?${evidenceQs.toString()}`}>
              <FileText className="size-3.5" />
              证据包
            </Link>
          </Button>
        </div>

        <div>
          <p className="mb-2 text-xs font-medium text-zinc-400">归一化属性</p>
          <AttributeList event={event} />
        </div>

        <div>
          <p className="mb-2 text-xs font-medium text-zinc-400">Raw Preview</p>
          <pre className="max-h-56 overflow-auto rounded-md border border-white/10 bg-[#0b0f0c] p-3 text-[11px] leading-relaxed text-zinc-400">
            {event.rawPreview || "--"}
          </pre>
        </div>
      </div>
    </section>
  );
}

function TraceTimeline({ timeline, loading }: { timeline?: AgentTimeline; loading?: boolean }) {
  const items = timeline?.items ?? [];
  return (
    <section className="rounded-[8px] border border-white/10 bg-[#111612]/92">
      <div className="flex min-h-12 items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <GitBranch className="size-4 shrink-0 text-teal-200" />
          <h2 className="truncate text-sm font-semibold text-zinc-100">Trace 时间线</h2>
        </div>
        {loading ? <LoaderCircle className="size-4 animate-spin text-zinc-500" /> : <span className="text-xs text-zinc-500">{items.length} 步</span>}
      </div>
      {items.length === 0 ? (
        <div className="flex min-h-32 items-center justify-center text-sm text-zinc-500">暂无时间线</div>
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
                    <Pill className={severityClass(event.severity)}>{CATEGORY_LABEL[event.eventCategory]}</Pill>
                    <Pill className={verdictClass(event.verdict)}>{VERDICT_LABEL[event.verdict]}</Pill>
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
  const [searchParams, setSearchParams] = useSearchParams();
  const [timeType, setTimeType] = useState<SecurityTimeType>((searchParams.get("timeType") as SecurityTimeType) || "last_3h");
  const routeStartTime = searchParams.get("startTime") ?? "";
  const routeEndTime = searchParams.get("endTime") ?? "";
  const [sourceId, setSourceId] = useState(searchParams.get("sourceId") ?? "");
  const [collectorId, setCollectorId] = useState(searchParams.get("collectorId") ?? "");
  const [workspacePath, setWorkspacePath] = useState(searchParams.get("workspacePath") ?? "");
  const [agentId, setAgentId] = useState(searchParams.get("agentId") ?? "");
  const [agentAssetId, setAgentAssetId] = useState(searchParams.get("agentAssetId") ?? "");
  const [sessionId, setSessionId] = useState(searchParams.get("sessionId") ?? "");
  const [traceId, setTraceId] = useState(searchParams.get("traceId") ?? "");
  const [runId, setRunId] = useState(searchParams.get("runId") ?? "");
  const [eventKind, setEventKind] = useState(searchParams.get("eventKind") ?? "");
  const [eventCategory, setEventCategory] = useState<AgentEventCategory | "all">((searchParams.get("eventCategory") as AgentEventCategory) || "all");
  const [verdict, setVerdict] = useState<SecurityVerdict | "all">((searchParams.get("verdict") as SecurityVerdict) || "all");
  const [includeUnknown, setIncludeUnknown] = useState(searchParams.get("includeUnknown") !== "false");
  const [selectedEventId, setSelectedEventId] = useState(searchParams.get("eventId") ?? "");

  const query = useMemo<AgentEventQuery>(() => ({
    timeType,
    startTime: timeType === "custom" ? clean(routeStartTime) : undefined,
    endTime: timeType === "custom" ? clean(routeEndTime) : undefined,
    eventId: clean(selectedEventId),
    sourceId: clean(sourceId),
    collectorId: clean(collectorId),
    workspacePath: clean(workspacePath),
    agentId: clean(agentId),
    agentAssetId: clean(agentAssetId),
    sessionId: clean(sessionId),
    traceId: clean(traceId),
    runId: clean(runId),
    eventKind: clean(eventKind),
    eventCategory: eventCategory === "all" ? undefined : eventCategory,
    verdict: verdict === "all" ? undefined : verdict,
    scope: "raw",
    includeUnknown,
    durable: true,
    limit: 120,
  }), [agentAssetId, agentId, collectorId, eventCategory, eventKind, includeUnknown, routeEndTime, routeStartTime, runId, selectedEventId, sessionId, sourceId, timeType, traceId, verdict, workspacePath]);

  const { data, loading, refresh } = useRequest(() => securityCenterApi.agentEvents(query), {
    refreshDeps: [query],
    pollingInterval: 10000,
    pollingWhenHidden: false,
  });

  const selectedEvent = useMemo(() => {
    const items = data?.items ?? [];
    return items.find((event) => event.eventId === selectedEventId) ?? items[0];
  }, [data, selectedEventId]);

  const { data: timeline, loading: timelineLoading } = useRequest(
    () => selectedEvent
      ? securityCenterApi.agentTimeline({
          timeType,
          startTime: timeType === "custom" ? clean(routeStartTime) : undefined,
          endTime: timeType === "custom" ? clean(routeEndTime) : undefined,
          eventId: selectedEvent.eventId,
          traceId: selectedEvent.traceId,
          limit: 240,
        })
      : Promise.resolve({ traceId: "", items: [], updateTime: "" }),
    {
      refreshDeps: [routeEndTime, routeStartTime, selectedEvent?.traceId, timeType],
      pollingInterval: 10000,
      pollingWhenHidden: false,
    },
  );

  const selectEvent = (event: AgentEventListItem) => {
    const eventSourceId = event.sourceId ?? (typeof event.attributes.sourceId === "string" ? event.attributes.sourceId : undefined);
    const eventCollectorId = event.collectorId ?? (typeof event.attributes.collectorId === "string" ? event.attributes.collectorId : undefined);
    setSelectedEventId(event.eventId);
    const next = new URLSearchParams();
    next.set("timeType", timeType);
    if (timeType === "custom" && routeStartTime) next.set("startTime", routeStartTime);
    if (timeType === "custom" && routeEndTime) next.set("endTime", routeEndTime);
    next.set("eventId", event.eventId);
    next.set("traceId", event.traceId);
    next.set("runId", event.runId);
    next.set("eventKind", event.eventKind);
    if (eventSourceId ?? sourceId) next.set("sourceId", eventSourceId ?? sourceId);
    if (eventCollectorId ?? collectorId) next.set("collectorId", eventCollectorId ?? collectorId);
    if (workspacePath) next.set("workspacePath", workspacePath);
    if (agentId) next.set("agentId", agentId);
    next.set("agentAssetId", event.agentAssetId);
    if (sessionId) next.set("sessionId", sessionId);
    next.set("includeUnknown", String(includeUnknown));
    if (eventSourceId) setSourceId(eventSourceId);
    if (eventCollectorId) setCollectorId(eventCollectorId);
    setAgentAssetId(event.agentAssetId);
    setRunId(event.runId);
    setEventKind(event.eventKind);
    setSearchParams(next);
  };

  const clearFilters = () => {
    setAgentId("");
    setAgentAssetId("");
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
    setSelectedEventId("");
    setSearchParams({});
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
                <TerminalSquare className="size-5 shrink-0 text-teal-300" />
                <h1 className="truncate text-lg font-semibold tracking-normal text-zinc-50">事件检索</h1>
              </div>
              <p className="mt-0.5 truncate text-xs text-zinc-500">旁路事件 · Trace 时间线 · 风险证据</p>
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <AdminTokenControl compact />
            <Clock3 className="size-3.5" />
            <span>{data?.updateTime ? formatDate(data.updateTime) : "等待刷新"}</span>
          </div>
        </div>

        <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-4 2xl:grid-cols-6">
          <Select value={timeType} onValueChange={(next) => setTimeType(next as SecurityTimeType)}>
            <SelectTrigger className="h-9 border-white/10 bg-white/5 text-xs text-zinc-100"><SelectValue /></SelectTrigger>
            <SelectContent>
              {TIME_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
              {timeType === "custom" ? <SelectItem value="custom">自定义范围</SelectItem> : null}
            </SelectContent>
          </Select>
          <Input value={sourceId} onChange={(event) => setSourceId(event.target.value)} placeholder="sourceId" className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
          <Input value={collectorId} onChange={(event) => setCollectorId(event.target.value)} placeholder="collectorId" className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
          <Input value={workspacePath} onChange={(event) => setWorkspacePath(event.target.value)} placeholder="workspacePath" className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
          <Input value={agentId} onChange={(event) => setAgentId(event.target.value)} placeholder="agentId" className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
          <Input value={sessionId} onChange={(event) => setSessionId(event.target.value)} placeholder="sessionId" className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
          <Input value={traceId} onChange={(event) => setTraceId(event.target.value)} placeholder="traceId" className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
          <Input value={runId} onChange={(event) => setRunId(event.target.value)} placeholder="runId" className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
          <Input value={eventKind} onChange={(event) => setEventKind(event.target.value)} placeholder="eventKind" className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
          <Select value={eventCategory} onValueChange={(next) => setEventCategory(next as AgentEventCategory | "all")}>
            <SelectTrigger className="h-9 border-white/10 bg-white/5 text-xs text-zinc-100"><SelectValue /></SelectTrigger>
            <SelectContent>
              {CATEGORY_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={verdict} onValueChange={(next) => setVerdict(next as SecurityVerdict | "all")}>
            <SelectTrigger className="h-9 border-white/10 bg-white/5 text-xs text-zinc-100"><SelectValue /></SelectTrigger>
            <SelectContent>
              {VERDICT_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            aria-pressed={includeUnknown}
            onClick={() => setIncludeUnknown((value) => !value)}
            className={cn(
              "h-9 border text-xs",
              includeUnknown
                ? "border-teal-400/30 bg-teal-400/10 text-teal-100 hover:bg-teal-400/15"
                : "border-white/10 bg-white/5 text-zinc-400 hover:bg-white/10",
            )}
          >
            {includeUnknown ? "包含 Unknown" : "隐藏 Unknown"}
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={clearFilters} className="h-9 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
            <X className="size-3.5" />
            清除
          </Button>
          <Button type="button" size="sm" onClick={refresh} disabled={loading} className="h-9 bg-teal-500 text-[#07100c] hover:bg-teal-400">
            {loading ? <LoaderCircle className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            刷新
          </Button>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto grid w-full max-w-[1800px] gap-4 xl:grid-cols-[minmax(420px,0.9fr)_minmax(0,1.25fr)_minmax(360px,0.8fr)]">
          <section className="min-h-[620px] rounded-[8px] border border-white/10 bg-[#111612]/92">
            <div className="flex min-h-12 items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
              <div className="flex items-center gap-2">
                <Search className="size-4 text-teal-200" />
                <h2 className="text-sm font-semibold text-zinc-100">事件</h2>
              </div>
              <span className="text-xs text-zinc-500">{data ? `${data.total} 条` : "--"}</span>
            </div>
            {loading && !data ? (
              <div className="flex min-h-40 items-center justify-center text-sm text-zinc-500">
                <LoaderCircle className="mr-2 size-4 animate-spin" />
                加载事件...
              </div>
            ) : (data?.items?.length ?? 0) === 0 ? (
              <div className="flex min-h-40 items-center justify-center text-sm text-zinc-500">暂无事件</div>
            ) : (
              <div className="max-h-[calc(100vh-220px)] overflow-y-auto">
                {data?.items.map((event) => (
                  <EventRow
                    key={event.eventId}
                    event={event}
                    active={event.eventId === selectedEvent?.eventId}
                    onSelect={() => selectEvent(event)}
                  />
                ))}
              </div>
            )}
          </section>

          <EventDetail
            event={selectedEvent}
            timeType={timeType}
            startTime={timeType === "custom" ? routeStartTime : undefined}
            endTime={timeType === "custom" ? routeEndTime : undefined}
          />

          <div className="space-y-4">
            <section className="rounded-[8px] border border-white/10 bg-[#111612]/92 p-4">
              <div className="mb-3 flex items-center gap-2">
                <ShieldAlert className="size-4 text-rose-200" />
                <h2 className="text-sm font-semibold text-zinc-100">当前证据</h2>
              </div>
              <div className="grid gap-3">
                <FieldValue label="风险分类" value={selectedEvent?.riskCategory} />
                <FieldValue label="风险名称" value={selectedEvent?.riskName} />
                <FieldValue label="研判层级" value={selectedEvent?.tier} />
                <FieldValue label="父 Span" value={selectedEvent?.parentSpanId} />
              </div>
            </section>
            <TraceTimeline timeline={timeline} loading={timelineLoading} />
          </div>
        </div>
      </main>
    </div>
  );
}
