import { useRequest } from "ahooks";
import dayjs from "dayjs";
import {
  ArrowLeft,
  BellRing,
  Bot,
  BriefcaseBusiness,
  CalendarClock,
  Clock3,
  EyeOff,
  FileCheck2,
  FileText,
  GitBranch,
  Layers3,
  LoaderCircle,
  RadioTower,
  RefreshCw,
  Route,
  Search,
  ShieldAlert,
  Target,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AdminTokenControl } from "@/components/custom/admin-token-control";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  type AgentCriticality,
  type AgentHealthState,
  type SecurityTimeType,
  type WorkspaceInventoryItem,
  type WorkspaceInventoryQuery,
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

const CRITICALITY_OPTIONS: Array<{ value: AgentCriticality | "all"; label: string }> = [
  { value: "all", label: "全部重要性" },
  { value: "critical", label: "关键" },
  { value: "high", label: "高" },
  { value: "medium", label: "中" },
  { value: "low", label: "低" },
];

const HEALTH_LABEL: Record<AgentHealthState, string> = {
  active: "活跃",
  idle: "空闲",
  stale: "失联",
  risky: "风险",
};

const CRITICALITY_LABEL: Record<AgentCriticality, string> = {
  low: "低",
  medium: "中",
  high: "高",
  critical: "关键",
};

function clean(value: string) {
  return value.trim() || undefined;
}

function formatDate(value?: string) {
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

function WorkspaceRow({ item, active, onSelect }: { item: WorkspaceInventoryItem; active: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "grid w-full grid-cols-[86px_minmax(0,1fr)_76px_64px_64px] items-center gap-3 border-b border-white/8 px-3 py-3 text-left transition hover:bg-white/[0.05]",
        active && "bg-teal-400/8",
      )}
    >
      <span className="font-mono text-xs text-zinc-500">{formatDate(item.lastSeen)}</span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-zinc-100" title={item.workspacePath}>{item.workspacePath}</span>
        <span className="mt-0.5 block truncate text-[11px] text-zinc-600" title={item.owner ?? item.team ?? ""}>
          {item.owner ?? item.team ?? item.environment ?? "unowned"}
        </span>
      </span>
      <span><Pill className={healthClass(item.healthState)}>{HEALTH_LABEL[item.healthState]}</Pill></span>
      <span className="text-right font-mono text-xs text-zinc-500">{item.agentCount}</span>
      <span className="text-right font-mono text-xs text-zinc-500">{item.eventCount}</span>
    </button>
  );
}

function workspaceParams(item: WorkspaceInventoryItem, timeType?: SecurityTimeType) {
  const params = new URLSearchParams();
  if (timeType) params.set("timeType", timeType);
  params.set("workspacePath", item.workspacePath);
  return params;
}

function workspaceAgentsHref(item: WorkspaceInventoryItem, timeType: SecurityTimeType) {
  return `/agents?${workspaceParams(item, timeType).toString()}`;
}

function workspaceEventsHref(item: WorkspaceInventoryItem, timeType: SecurityTimeType) {
  return `/events?${workspaceParams(item, timeType).toString()}`;
}

function workspaceEvidenceHref(item: WorkspaceInventoryItem, timeType: SecurityTimeType) {
  return `/evidence?${workspaceParams(item, timeType).toString()}`;
}

function workspaceCoverageHref(item: WorkspaceInventoryItem) {
  return `/coverage?${new URLSearchParams({ workspacePath: item.workspacePath }).toString()}`;
}

function workspaceTopologyHref(item: WorkspaceInventoryItem, timeType: SecurityTimeType) {
  const params = workspaceParams(item, timeType);
  return `/topology?${params.toString()}`;
}

function workspaceIncidentsHref(item: WorkspaceInventoryItem) {
  const params = workspaceParams(item);
  params.set("status", "open");
  return `/incidents?${params.toString()}`;
}

function workspaceAlertsHref(item: WorkspaceInventoryItem, timeType: SecurityTimeType) {
  const params = workspaceParams(item, timeType);
  params.set("status", "all");
  return `/alerts?${params.toString()}`;
}

function workspaceRemediationHref(item: WorkspaceInventoryItem) {
  return `/remediation?${workspaceParams(item, "last_7d").toString()}`;
}

function workspaceMaintenanceHref(item: WorkspaceInventoryItem) {
  const params = new URLSearchParams({ targetType: "workspace", targetId: item.workspacePath });
  return `/maintenance?${params.toString()}`;
}

function workspaceObjectiveHref(item: WorkspaceInventoryItem) {
  const params = new URLSearchParams({ targetType: "workspace", targetId: item.workspacePath, metric: "active_alerts" });
  return `/objectives?${params.toString()}`;
}

function workspaceNotificationHref(item: WorkspaceInventoryItem) {
  const params = workspaceParams(item);
  params.set("minSeverity", "high");
  return `/notifications?${params.toString()}`;
}

function WorkspaceDetail({ item, timeType }: { item?: WorkspaceInventoryItem; timeType: SecurityTimeType }) {
  if (!item) {
    return (
      <section className="rounded-[8px] border border-white/10 bg-[#111612]/92">
        <div className="flex min-h-[360px] items-center justify-center text-sm text-zinc-500">选择一个 Workspace 查看详情</div>
      </section>
    );
  }

  return (
    <section className="rounded-[8px] border border-white/10 bg-[#111612]/92">
      <div className="flex min-h-12 items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <BriefcaseBusiness className="size-4 shrink-0 text-teal-200" />
          <h2 className="truncate text-sm font-semibold text-zinc-100">{item.workspacePath}</h2>
        </div>
        <div className="flex items-center gap-2">
          {item.maintenanceActive ? <Pill className="border-indigo-400/30 bg-indigo-500/10 text-indigo-100">维护</Pill> : null}
          <Pill className={riskClass(item.riskLevel)}>{item.riskLevelText}</Pill>
          <Pill className={healthClass(item.healthState)}>{HEALTH_LABEL[item.healthState]}</Pill>
        </div>
      </div>

      <div className="space-y-4 p-4">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <FieldValue label="Workspace" value={item.workspacePath} />
          <FieldValue label="Owner" value={item.owner} />
          <FieldValue label="Team" value={item.team} />
          <FieldValue label="Environment" value={item.environment} />
          <FieldValue label="Criticality" value={item.criticality ? CRITICALITY_LABEL[item.criticality] : undefined} />
          <FieldValue label="Maintenance" value={item.maintenanceTitle} />
          <FieldValue label="First Seen" value={formatDate(item.firstSeen)} />
          <FieldValue label="Last Seen" value={formatDate(item.lastSeen)} />
          <FieldValue label="Last Event" value={item.lastEventSubject} />
        </div>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <MetricTile label="Agents" value={item.agentCount} tone="border-white/10 bg-white/[0.03] text-zinc-100" />
          <MetricTile label="风险事件" value={item.riskyEventCount} tone="border-amber-400/25 bg-amber-500/10 text-amber-100" />
          <MetricTile label="Open Incident" value={item.openIncidentCount} tone="border-rose-400/25 bg-rose-500/10 text-rose-100" />
          <MetricTile label="Collectors" value={item.collectorCount} tone="border-sky-400/25 bg-sky-500/10 text-sky-100" />
          <MetricTile label="平均延迟" value={`${item.avgLatencyMs}ms`} tone="border-teal-400/25 bg-teal-500/10 text-teal-100" />
        </div>

        <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
          <FieldValue label="Managed Agents" value={`${item.managedAgentCount}/${item.agentCount}`} />
          <FieldValue label="Active" value={item.activeAgentCount} />
          <FieldValue label="Idle" value={item.idleAgentCount} />
          <FieldValue label="Stale" value={item.staleAgentCount} />
          <FieldValue label="Risky" value={item.riskyAgentCount} />
          <FieldValue label="Top Risk" value={item.topRiskName ?? item.topRiskCategory} />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {item.criticality ? <Pill className={criticalityClass(item.criticality)}>重要性 {CRITICALITY_LABEL[item.criticality]}</Pill> : null}
          {item.environment ? <Pill className="border-sky-400/30 bg-sky-500/10 text-sky-100">{item.environment}</Pill> : null}
          {item.tags.map((tag) => <Pill key={tag} className="border-white/10 bg-white/5 text-zinc-200">{tag}</Pill>)}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button asChild size="sm" className="h-8 bg-teal-500 text-[#07100c] hover:bg-teal-400">
            <Link to={workspaceAgentsHref(item, timeType)}>
              <Bot className="size-3.5" />
              Agents
            </Link>
          </Button>
          <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
            <Link to={workspaceEventsHref(item, timeType)}>
              <Search className="size-3.5" />
              事件
            </Link>
          </Button>
          <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
            <Link to={workspaceEvidenceHref(item, timeType)}>
              <FileText className="size-3.5" />
              Evidence
            </Link>
          </Button>
          <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
            <Link to={workspaceCoverageHref(item)}>
              <EyeOff className="size-3.5" />
              覆盖
            </Link>
          </Button>
          <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
            <Link to={workspaceTopologyHref(item, timeType)}>
              <GitBranch className="size-3.5" />
              拓扑
            </Link>
          </Button>
          {item.openIncidentCount > 0 ? (
            <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
              <Link to={workspaceIncidentsHref(item)}>
                <ShieldAlert className="size-3.5" />
                Incident
              </Link>
            </Button>
          ) : null}
          <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
            <Link to={workspaceAlertsHref(item, timeType)}>
              <BellRing className="size-3.5" />
              告警
            </Link>
          </Button>
          <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
            <Link to={workspaceRemediationHref(item)}>
              <FileCheck2 className="size-3.5" />
              处置
            </Link>
          </Button>
          <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
            <Link to={workspaceMaintenanceHref(item)}>
              <CalendarClock className="size-3.5" />
              维护
            </Link>
          </Button>
          <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
            <Link to={workspaceObjectiveHref(item)}>
              <Target className="size-3.5" />
              目标
            </Link>
          </Button>
          <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
            <Link to={workspaceNotificationHref(item)}>
              <Route className="size-3.5" />
              通知
            </Link>
          </Button>
        </div>
      </div>
    </section>
  );
}

export default function WorkspacesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [timeType, setTimeType] = useState<SecurityTimeType>((searchParams.get("timeType") as SecurityTimeType) || "last_3h");
  const [healthState, setHealthState] = useState<AgentHealthState | "all">((searchParams.get("healthState") as AgentHealthState) || "all");
  const [criticality, setCriticality] = useState<AgentCriticality | "all">((searchParams.get("criticality") as AgentCriticality) || "all");
  const [queryText, setQueryText] = useState(searchParams.get("q") ?? "");
  const [selectedWorkspacePath, setSelectedWorkspacePath] = useState(searchParams.get("workspacePath") ?? "");

  const query = useMemo<WorkspaceInventoryQuery>(() => ({
    timeType,
    healthState,
    criticality,
    workspacePath: clean(selectedWorkspacePath),
    q: clean(queryText),
    limit: 200,
  }), [criticality, healthState, queryText, selectedWorkspacePath, timeType]);

  const { data, loading, refresh } = useRequest(() => securityCenterApi.workspaceInventory(query), {
    refreshDeps: [query],
    pollingInterval: 10000,
    pollingWhenHidden: false,
  });

  const selectedWorkspace = useMemo(() => {
    const items = data?.items ?? [];
    return items.find((item) => item.workspacePath === selectedWorkspacePath) ?? items[0];
  }, [data, selectedWorkspacePath]);

  const selectWorkspace = (item: WorkspaceInventoryItem) => {
    setSelectedWorkspacePath(item.workspacePath);
    const next = new URLSearchParams();
    next.set("timeType", timeType);
    next.set("workspacePath", item.workspacePath);
    if (healthState !== "all") next.set("healthState", healthState);
    if (criticality !== "all") next.set("criticality", criticality);
    if (clean(queryText)) next.set("q", queryText.trim());
    setSearchParams(next);
  };

  const clearFilters = () => {
    setHealthState("all");
    setCriticality("all");
    setQueryText("");
    setSelectedWorkspacePath("");
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
                <BriefcaseBusiness className="size-5 shrink-0 text-teal-300" />
                <h1 className="truncate text-lg font-semibold tracking-normal text-zinc-50">Workspace 资产</h1>
              </div>
              <p className="mt-0.5 truncate text-xs text-zinc-500">服务域 · Owner · 覆盖 · 风险</p>
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <AdminTokenControl compact />
            <Clock3 className="size-3.5" />
            <span>{data?.updateTime ? formatDate(data.updateTime) : "等待刷新"}</span>
          </div>
        </div>

        <div className="mt-3 grid gap-2 md:grid-cols-[120px_130px_150px_minmax(180px,1fr)_auto_auto]">
          <Select value={timeType} onValueChange={(next) => setTimeType(next as SecurityTimeType)}>
            <SelectTrigger className="h-9 border-white/10 bg-white/5 text-xs text-zinc-100"><SelectValue /></SelectTrigger>
            <SelectContent>{TIME_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={healthState} onValueChange={(next) => setHealthState(next as AgentHealthState | "all")}>
            <SelectTrigger className="h-9 border-white/10 bg-white/5 text-xs text-zinc-100"><SelectValue /></SelectTrigger>
            <SelectContent>{HEALTH_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={criticality} onValueChange={(next) => setCriticality(next as AgentCriticality | "all")}>
            <SelectTrigger className="h-9 border-white/10 bg-white/5 text-xs text-zinc-100"><SelectValue /></SelectTrigger>
            <SelectContent>{CRITICALITY_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
          </Select>
          <Input value={queryText} onChange={(event) => setQueryText(event.target.value)} placeholder="workspace / owner / team / risk" className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
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
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
            <MetricTile label="Workspace" value={data?.summary.totalWorkspaces ?? 0} tone="border-white/10 bg-white/[0.03] text-zinc-100" />
            <MetricTile label="Agents" value={data?.summary.totalAgents ?? 0} tone="border-teal-400/25 bg-teal-500/10 text-teal-100" />
            <MetricTile label="风险域" value={data?.summary.riskyWorkspaces ?? 0} tone="border-rose-400/25 bg-rose-500/10 text-rose-100" />
            <MetricTile label="高重要性" value={data?.summary.highCriticalityWorkspaces ?? 0} tone="border-orange-400/25 bg-orange-500/10 text-orange-100" />
            <MetricTile label="维护中" value={data?.summary.maintainedWorkspaces ?? 0} tone="border-indigo-400/25 bg-indigo-500/10 text-indigo-100" />
            <MetricTile label="事件" value={data?.summary.observedEventCount ?? 0} tone="border-amber-400/25 bg-amber-500/10 text-amber-100" />
          </div>

          <div className="grid gap-4 xl:grid-cols-[minmax(560px,1fr)_minmax(0,1.2fr)]">
            <section className="min-h-[620px] rounded-[8px] border border-white/10 bg-[#111612]/92">
              <div className="flex min-h-12 items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
                <div className="flex items-center gap-2">
                  <Layers3 className="size-4 text-teal-200" />
                  <h2 className="text-sm font-semibold text-zinc-100">Workspaces</h2>
                </div>
                <span className="text-xs text-zinc-500">{data ? `${data.total} 个` : "--"}</span>
              </div>
              {loading && !data ? (
                <div className="flex min-h-40 items-center justify-center text-sm text-zinc-500">
                  <LoaderCircle className="mr-2 size-4 animate-spin" />
                  加载 Workspace...
                </div>
              ) : (data?.items?.length ?? 0) === 0 ? (
                <div className="flex min-h-40 items-center justify-center text-sm text-zinc-500">暂无 Workspace</div>
              ) : (
                <div className="max-h-[calc(100vh-300px)] overflow-y-auto">
                  {data?.items.map((item) => (
                    <WorkspaceRow
                      key={item.workspacePath}
                      item={item}
                      active={item.workspacePath === selectedWorkspace?.workspacePath}
                      onSelect={() => selectWorkspace(item)}
                    />
                  ))}
                </div>
              )}
            </section>

            <div className="space-y-4">
              <WorkspaceDetail item={selectedWorkspace} timeType={timeType} />
              <section className="rounded-[8px] border border-white/10 bg-[#111612]/92 p-4">
                <div className="mb-3 flex items-center gap-2">
                  <RadioTower className="size-4 text-sky-200" />
                  <h2 className="text-sm font-semibold text-zinc-100">管理概览</h2>
                </div>
                <div className="grid gap-3 sm:grid-cols-3">
                  <FieldValue label="Managed Workspaces" value={data?.summary.managedWorkspaces ?? 0} />
                  <FieldValue label="Production" value={data?.summary.productionWorkspaces ?? 0} />
                  <FieldValue label="Open Incidents" value={data?.summary.openIncidentCount ?? 0} />
                  <FieldValue label="Risk Events" value={data?.summary.riskyEventCount ?? 0} />
                  <FieldValue label="Active Workspaces" value={data?.summary.activeWorkspaces ?? 0} />
                  <FieldValue label="Stale Workspaces" value={data?.summary.staleWorkspaces ?? 0} />
                </div>
              </section>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
