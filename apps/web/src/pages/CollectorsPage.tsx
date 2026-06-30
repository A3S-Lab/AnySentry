import { useRequest } from "ahooks";
import dayjs from "dayjs";
import {
  ArrowLeft,
  BellRing,
  CalendarClock,
  Clock3,
  EyeOff,
  FileCheck2,
  FileText,
  GitBranch,
  LoaderCircle,
  Network,
  RadioTower,
  RefreshCw,
  Route,
  Search,
  ServerCog,
  ShieldAlert,
  Target,
  TerminalSquare,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AdminTokenControl } from "@/components/custom/admin-token-control";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  type AgentEventCategory,
  type CollectorHealthItem,
  type CollectorHealthQuery,
  type CollectorHealthState,
  type SecurityTimeType,
  securityCenterApi,
} from "@/lib/api/security-center";
import { cn } from "@/lib/utils";

const TIME_OPTIONS: Array<{ value: SecurityTimeType; label: string }> = [
  { value: "last_3h", label: "近3小时" },
  { value: "last_1d", label: "近一天" },
  { value: "last_7d", label: "近一周" },
  { value: "last_30d", label: "近一月" },
];

const STATE_OPTIONS: Array<{ value: CollectorHealthState | "all"; label: string }> = [
  { value: "all", label: "全部状态" },
  { value: "down", label: "断流" },
  { value: "stale", label: "陈旧" },
  { value: "degraded", label: "降级" },
  { value: "quiet", label: "静默" },
  { value: "healthy", label: "健康" },
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

function clean(value: string) {
  return value.trim() || undefined;
}

function formatDate(value?: string) {
  if (!value) return "--";
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed.format("MM-DD HH:mm:ss") : value;
}

function stateClass(state?: CollectorHealthState) {
  if (state === "down" || state === "stale") return "border-rose-400/30 bg-rose-500/10 text-rose-100";
  if (state === "degraded" || state === "quiet") return "border-amber-400/30 bg-amber-500/10 text-amber-100";
  return "border-teal-400/30 bg-teal-500/10 text-teal-100";
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

function collectorEventsHref(collector: CollectorHealthItem, timeType: SecurityTimeType) {
  const params = new URLSearchParams({ timeType, collectorId: collector.collectorId });
  return `/events?${params.toString()}`;
}

function collectorEvidenceHref(collector: CollectorHealthItem, timeType: SecurityTimeType) {
  const params = new URLSearchParams({ timeType, collectorId: collector.collectorId });
  return `/evidence?${params.toString()}`;
}

function collectorIncidentsHref(collector: CollectorHealthItem, timeType: SecurityTimeType) {
  const params = new URLSearchParams({ timeType, status: "open", collectorId: collector.collectorId });
  return `/incidents?${params.toString()}`;
}

function collectorAlertsHref(collector: CollectorHealthItem, timeType: SecurityTimeType) {
  const params = new URLSearchParams({ timeType, status: "all", kind: "collector", collectorId: collector.collectorId });
  return `/alerts?${params.toString()}`;
}

function collectorCoverageHref(collector: CollectorHealthItem) {
  const params = new URLSearchParams({ timeType: "last_7d", collectorId: collector.collectorId });
  if (collector.state === "down") params.set("type", "collector_down");
  else if (collector.state === "stale") params.set("type", "collector_stale");
  else if (collector.state === "degraded") params.set("type", "collector_degraded");
  else if (collector.state === "quiet") params.set("type", "collector_quiet");
  return `/coverage?${params.toString()}`;
}

function collectorTopologyHref(collector: CollectorHealthItem, timeType: SecurityTimeType) {
  const params = new URLSearchParams({ timeType, collectorId: collector.collectorId });
  return `/topology?${params.toString()}`;
}

function collectorRemediationHref(collector: CollectorHealthItem) {
  const params = new URLSearchParams({ timeType: "last_7d", collectorId: collector.collectorId });
  return `/remediation?${params.toString()}`;
}

function collectorMaintenanceHref(collector: CollectorHealthItem) {
  const params = new URLSearchParams({ targetType: "collector", targetId: collector.collectorId });
  return `/maintenance?${params.toString()}`;
}

function collectorObjectiveHref(collector: CollectorHealthItem) {
  const params = new URLSearchParams({ targetType: "collector", targetId: collector.collectorId, metric: "collector_down" });
  return `/objectives?${params.toString()}`;
}

function collectorNotificationHref(collector: CollectorHealthItem) {
  const params = new URLSearchParams({ collectorId: collector.collectorId, kind: "collector", minSeverity: "high" });
  return `/notifications?${params.toString()}`;
}

function CollectorRow({
  collector,
  active,
  onSelect,
}: {
  collector: CollectorHealthItem;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "grid w-full grid-cols-[92px_minmax(0,1fr)_72px_72px] items-center gap-3 border-b border-white/8 px-3 py-3 text-left transition hover:bg-white/[0.05]",
        active && "bg-teal-400/8",
      )}
    >
      <span className="font-mono text-xs text-zinc-500">{formatDate(collector.lastSeenAt)}</span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-zinc-100" title={collector.collectorId}>{collector.collectorId}</span>
        <span className="mt-0.5 block truncate font-mono text-[11px] text-zinc-600" title={collector.nodeName ?? collector.podName ?? ""}>
          {collector.nodeName ?? collector.podName ?? "--"}
        </span>
      </span>
      <span><Pill className={stateClass(collector.state)}>{collector.stateText}</Pill></span>
      <span className="text-right font-mono text-xs text-zinc-500">{collector.eventRatePerMin}/m</span>
    </button>
  );
}

function CollectorDetail({ collector, timeType }: { collector?: CollectorHealthItem; timeType: SecurityTimeType }) {
  if (!collector) {
    return (
      <section className="rounded-[8px] border border-white/10 bg-[#111612]/92">
        <div className="flex min-h-[360px] items-center justify-center text-sm text-zinc-500">选择一个 Collector 查看采集详情</div>
      </section>
    );
  }

  const categoryRows = (Object.entries(collector.eventCategoryCounts) as Array<[AgentEventCategory, number]>)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1]);
  return (
    <section className="rounded-[8px] border border-white/10 bg-[#111612]/92">
      <div className="flex min-h-12 items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <RadioTower className="size-4 shrink-0 text-teal-200" />
          <h2 className="truncate text-sm font-semibold text-zinc-100">{collector.collectorId}</h2>
        </div>
        <Pill className={stateClass(collector.state)}>{collector.stateText}</Pill>
      </div>

      <div className="space-y-4 p-4">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <FieldValue label="Collector" value={collector.collectorId} />
          <FieldValue label="Node" value={collector.nodeName} />
          <FieldValue label="Namespace" value={collector.namespace} />
          <FieldValue label="Pod" value={collector.podName} />
          <FieldValue label="Version" value={collector.version} />
          <FieldValue label="Mode" value={collector.mode} />
          <FieldValue label="Last Heartbeat" value={formatDate(collector.lastHeartbeatAt)} />
          <FieldValue label="Attached Probes" value={collector.attachedProbes} />
          <FieldValue label="Features" value={collector.enabledFeatures.join(", ") || "--"} />
        </div>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetricTile label="窗口事件" value={collector.eventCount} tone="border-white/10 bg-white/[0.03] text-zinc-100" />
          <MetricTile label="速率" value={`${collector.eventRatePerMin}/m`} tone="border-teal-400/25 bg-teal-500/10 text-teal-100" />
          <MetricTile label="Agent 覆盖" value={collector.observedAgentCount} tone="border-amber-400/25 bg-amber-500/10 text-amber-100" />
          <MetricTile label="丢弃" value={collector.droppedEvents + collector.outputDropped} tone="border-rose-400/25 bg-rose-500/10 text-rose-100" />
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <FieldValue label="Ring Dropped" value={collector.droppedEvents} />
          <FieldValue label="Output Dropped" value={collector.outputDropped} />
          <FieldValue label="Queue Depth" value={collector.queueDepth} />
          <FieldValue label="Errors" value={collector.errorCount} />
          <FieldValue label="Workspaces" value={collector.observedWorkspaceCount} />
          <FieldValue label="Message" value={collector.message} />
        </div>

        <div className="rounded-md border border-white/10 bg-white/[0.03] p-3">
          <div className="mb-3 flex items-center gap-2">
            <TerminalSquare className="size-4 text-teal-200" />
            <h3 className="text-sm font-semibold text-zinc-100">事件类型</h3>
          </div>
          <div className="space-y-2">
            {categoryRows.length ? categoryRows.map(([category, count]) => (
              <CountBar key={category} label={CATEGORY_LABEL[category]} count={count} total={collector.eventCount} />
            )) : <p className="text-xs text-zinc-500">当前窗口没有事件</p>}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button asChild size="sm" className="h-8 bg-teal-500 text-[#07100c] hover:bg-teal-400">
            <Link to={collectorEventsHref(collector, timeType)}>
              <Search className="size-3.5" />
              事件
            </Link>
          </Button>
          <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
            <Link to={collectorEvidenceHref(collector, timeType)}>
              <FileText className="size-3.5" />
              Evidence
            </Link>
          </Button>
          <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
            <Link to={collectorIncidentsHref(collector, timeType)}>
              <ShieldAlert className="size-3.5" />
              Incident
            </Link>
          </Button>
          <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
            <Link to={collectorAlertsHref(collector, timeType)}>
              <BellRing className="size-3.5" />
              告警
            </Link>
          </Button>
          <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
            <Link to={collectorCoverageHref(collector)}>
              <EyeOff className="size-3.5" />
              覆盖
            </Link>
          </Button>
          <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
            <Link to={collectorTopologyHref(collector, timeType)}>
              <GitBranch className="size-3.5" />
              拓扑
            </Link>
          </Button>
          <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
            <Link to={collectorRemediationHref(collector)}>
              <FileCheck2 className="size-3.5" />
              处置
            </Link>
          </Button>
          <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
            <Link to={collectorMaintenanceHref(collector)}>
              <CalendarClock className="size-3.5" />
              维护
            </Link>
          </Button>
          <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
            <Link to={collectorObjectiveHref(collector)}>
              <Target className="size-3.5" />
              目标
            </Link>
          </Button>
          <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
            <Link to={collectorNotificationHref(collector)}>
              <Route className="size-3.5" />
              通知
            </Link>
          </Button>
        </div>
      </div>
    </section>
  );
}

export default function CollectorsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [timeType, setTimeType] = useState<SecurityTimeType>((searchParams.get("timeType") as SecurityTimeType) || "last_3h");
  const [state, setState] = useState<CollectorHealthState | "all">((searchParams.get("state") as CollectorHealthState) || "all");
  const [queryText, setQueryText] = useState(searchParams.get("q") ?? "");
  const [selectedCollectorId, setSelectedCollectorId] = useState(searchParams.get("collectorId") ?? "");

  const query = useMemo<CollectorHealthQuery>(() => ({
    timeType,
    state,
    collectorId: clean(selectedCollectorId),
    q: clean(queryText),
    limit: 200,
  }), [queryText, selectedCollectorId, state, timeType]);

  const { data, loading, refresh } = useRequest(() => securityCenterApi.collectorHealth(query), {
    refreshDeps: [query],
    pollingInterval: 10000,
    pollingWhenHidden: false,
  });

  const selectedCollector = useMemo(() => {
    const items = data?.items ?? [];
    return items.find((item) => item.collectorId === selectedCollectorId) ?? items[0];
  }, [data, selectedCollectorId]);

  const selectCollector = (collector: CollectorHealthItem) => {
    setSelectedCollectorId(collector.collectorId);
    const next = new URLSearchParams();
    next.set("timeType", timeType);
    next.set("collectorId", collector.collectorId);
    if (state !== "all") next.set("state", state);
    if (clean(queryText)) next.set("q", queryText.trim());
    setSearchParams(next);
  };

  const clearFilters = () => {
    setState("all");
    setQueryText("");
    setSelectedCollectorId("");
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
                <RadioTower className="size-5 shrink-0 text-teal-300" />
                <h1 className="truncate text-lg font-semibold tracking-normal text-zinc-50">采集链路健康</h1>
              </div>
              <p className="mt-0.5 truncate text-xs text-zinc-500">Observer 心跳 · 节点覆盖 · 丢数与静默</p>
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <AdminTokenControl compact />
            <Clock3 className="size-3.5" />
            <span>{data?.updateTime ? formatDate(data.updateTime) : "等待刷新"}</span>
          </div>
        </div>

        <div className="mt-3 grid gap-2 md:grid-cols-[120px_130px_minmax(180px,1fr)_auto_auto]">
          <Select value={timeType} onValueChange={(next) => setTimeType(next as SecurityTimeType)}>
            <SelectTrigger className="h-9 border-white/10 bg-white/5 text-xs text-zinc-100"><SelectValue /></SelectTrigger>
            <SelectContent>{TIME_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={state} onValueChange={(next) => setState(next as CollectorHealthState | "all")}>
            <SelectTrigger className="h-9 border-white/10 bg-white/5 text-xs text-zinc-100"><SelectValue /></SelectTrigger>
            <SelectContent>{STATE_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
          </Select>
          <Input value={queryText} onChange={(event) => setQueryText(event.target.value)} placeholder="collector / node / pod" className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
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
        <div className="mx-auto flex w-full max-w-[1800px] flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <MetricTile label="Collector" value={data?.summary.totalCollectors ?? 0} tone="border-white/10 bg-white/[0.03] text-zinc-100" />
            <MetricTile label="健康" value={data?.summary.healthyCollectors ?? 0} tone="border-teal-400/25 bg-teal-500/10 text-teal-100" />
            <MetricTile label="降级" value={(data?.summary.degradedCollectors ?? 0) + (data?.summary.quietCollectors ?? 0)} tone="border-amber-400/25 bg-amber-500/10 text-amber-100" />
            <MetricTile label="断流" value={(data?.summary.downCollectors ?? 0) + (data?.summary.staleCollectors ?? 0)} tone="border-rose-400/25 bg-rose-500/10 text-rose-100" />
            <MetricTile label="窗口事件" value={data?.summary.observedEventCount ?? 0} tone="border-sky-400/25 bg-sky-500/10 text-sky-100" />
          </div>

          <div className="grid gap-4 xl:grid-cols-[minmax(460px,0.9fr)_minmax(0,1.4fr)]">
            <section className="min-h-[620px] rounded-[8px] border border-white/10 bg-[#111612]/92">
              <div className="flex min-h-12 items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
                <div className="flex items-center gap-2">
                  <Network className="size-4 text-teal-200" />
                  <h2 className="text-sm font-semibold text-zinc-100">Collectors</h2>
                </div>
                <span className="text-xs text-zinc-500">{data ? `${data.total} 个` : "--"}</span>
              </div>
              {loading && !data ? (
                <div className="flex min-h-40 items-center justify-center text-sm text-zinc-500">
                  <LoaderCircle className="mr-2 size-4 animate-spin" />
                  加载采集器...
                </div>
              ) : (data?.items?.length ?? 0) === 0 ? (
                <div className="flex min-h-40 items-center justify-center text-sm text-zinc-500">暂无 Collector 心跳</div>
              ) : (
                <div className="max-h-[calc(100vh-300px)] overflow-y-auto">
                  {data?.items.map((collector) => (
                    <CollectorRow
                      key={collector.collectorId}
                      collector={collector}
                      active={collector.collectorId === selectedCollector?.collectorId}
                      onSelect={() => selectCollector(collector)}
                    />
                  ))}
                </div>
              )}
            </section>

            <div className="space-y-4">
              <CollectorDetail collector={selectedCollector} timeType={timeType} />
              <section className="rounded-[8px] border border-white/10 bg-[#111612]/92 p-4">
                <div className="mb-3 flex items-center gap-2">
                  <ServerCog className="size-4 text-teal-200" />
                  <h2 className="text-sm font-semibold text-zinc-100">采集覆盖</h2>
                </div>
                <div className="grid gap-3 sm:grid-cols-3">
                  <FieldValue label="With Heartbeat" value={data?.summary.collectorsWithHeartbeat ?? 0} />
                  <FieldValue label="Observed Agents" value={data?.summary.observedAgentCount ?? 0} />
                  <FieldValue label="Healthy Ratio" value={`${data?.summary.totalCollectors ? Math.round(((data.summary.healthyCollectors ?? 0) / data.summary.totalCollectors) * 100) : 0}%`} />
                </div>
              </section>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
