import { useRequest } from "ahooks";
import dayjs from "dayjs";
import {
  Activity,
  ArrowLeft,
  BellRing,
  Bot,
  CalendarClock,
  Clock3,
  EyeOff,
  FileCheck2,
  FileText,
  GitBranch,
  LoaderCircle,
  RefreshCw,
  Route,
  Save,
  Search,
  ShieldAlert,
  Target,
  TerminalSquare,
  UserCheck,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AdminTokenControl } from "@/components/custom/admin-token-control";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  type AgentEventCategory,
  type AgentEventSource,
  type AgentCriticality,
  type AgentHealthState,
  type AgentInventoryItem,
  type AgentInventoryQuery,
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

interface AgentMetadataDraft {
  displayName: string;
  owner: string;
  team: string;
  environment: string;
  criticality: AgentCriticality | "";
  tags: string;
  note: string;
}

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
  params.set("workspacePath", agent.workspacePath);
  return params;
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
  active,
  onSelect,
}: {
  agent: AgentInventoryItem;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "grid w-full grid-cols-[92px_minmax(0,1fr)_70px_72px] items-center gap-3 border-b border-white/8 px-3 py-3 text-left transition hover:bg-white/[0.05]",
        active && "bg-teal-400/8",
      )}
    >
      <span className="font-mono text-xs text-zinc-500">{formatDate(agent.lastSeen)}</span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-zinc-100" title={agent.displayName || agent.agentId}>
          {agent.displayName || agent.agentId}
        </span>
        <span className="mt-0.5 block truncate font-mono text-[11px] text-zinc-600" title={agent.workspacePath}>
          {agent.owner ? `${agent.owner} · ` : ""}{agent.workspacePath}
        </span>
      </span>
      <span><Pill className={healthClass(agent.healthState)}>{HEALTH_LABEL[agent.healthState]}</Pill></span>
      <span className="text-right font-mono text-xs text-zinc-500">{agent.eventCount}</span>
    </button>
  );
}

function AgentDetail({
  agent,
  timeType,
  draft,
  saving,
  onDraftChange,
  onSaveMetadata,
}: {
  agent?: AgentInventoryItem;
  timeType: SecurityTimeType;
  draft: AgentMetadataDraft;
  saving: boolean;
  onDraftChange: (patch: Partial<AgentMetadataDraft>) => void;
  onSaveMetadata: () => void;
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

  return (
    <section className="rounded-[8px] border border-white/10 bg-[#111612]/92">
      <div className="flex min-h-12 items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Bot className="size-4 shrink-0 text-teal-200" />
          <h2 className="truncate text-sm font-semibold text-zinc-100">{agent.agentId}</h2>
        </div>
        <div className="flex items-center gap-2">
          <Pill className={riskClass(agent.riskLevel)}>{agent.riskLevelText}</Pill>
          <Pill className={healthClass(agent.healthState)}>{HEALTH_LABEL[agent.healthState]}</Pill>
        </div>
      </div>

      <div className="space-y-4 p-4">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <FieldValue label="Agent" value={agent.agentId} />
          <FieldValue label="Workspace" value={agent.workspacePath} />
          <FieldValue label="User" value={agent.userId} />
          <FieldValue label="Owner" value={agent.owner} />
          <FieldValue label="Team" value={agent.team} />
          <FieldValue label="Environment" value={agent.environment} />
          <FieldValue label="First Seen" value={formatDate(agent.firstSeen)} />
          <FieldValue label="Last Seen" value={formatDate(agent.lastSeen)} />
          <FieldValue label="Last Event" value={agent.lastEventSubject} />
        </div>

        <div className="rounded-md border border-white/10 bg-white/[0.03] p-3">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <UserCheck className="size-4 text-teal-200" />
              <h3 className="text-sm font-semibold text-zinc-100">资产管理</h3>
            </div>
            {agent.metadataUpdatedAt ? <span className="font-mono text-[11px] text-zinc-600">{formatDate(agent.metadataUpdatedAt)}</span> : null}
          </div>
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
            {agent.criticality ? <Pill className={criticalityClass(agent.criticality)}>重要性 {CRITICALITY_LABEL[agent.criticality]}</Pill> : null}
            {agent.environment ? <Pill className="border-sky-400/30 bg-sky-500/10 text-sky-100">{agent.environment}</Pill> : null}
            {agent.tags.map((tag) => <Pill key={tag} className="border-white/10 bg-white/5 text-zinc-200">{tag}</Pill>)}
          </div>
        </div>

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
  const [timeType, setTimeType] = useState<SecurityTimeType>((searchParams.get("timeType") as SecurityTimeType) || "last_3h");
  const [healthState, setHealthState] = useState<AgentHealthState | "all">((searchParams.get("healthState") as AgentHealthState) || "all");
  const [queryText, setQueryText] = useState(searchParams.get("q") ?? "");
  const [selectedAgentId, setSelectedAgentId] = useState(searchParams.get("agentId") ?? "");
  const [selectedWorkspacePath, setSelectedWorkspacePath] = useState(searchParams.get("workspacePath") ?? "");
  const [userId, setUserId] = useState(searchParams.get("userId") ?? "");
  const [metadataDraft, setMetadataDraft] = useState<AgentMetadataDraft>(() => draftFromAgent());
  const [savingMetadata, setSavingMetadata] = useState(false);

  const query = useMemo<AgentInventoryQuery>(() => ({
    timeType,
    healthState,
    q: clean(queryText),
    agentId: clean(selectedAgentId),
    workspacePath: clean(selectedWorkspacePath),
    userId: clean(userId),
    limit: 200,
  }), [healthState, queryText, selectedAgentId, selectedWorkspacePath, timeType, userId]);

  const { data, loading, refresh } = useRequest(() => securityCenterApi.agentInventory(query), {
    refreshDeps: [query],
    pollingInterval: 10000,
    pollingWhenHidden: false,
  });

  const selectedAgent = useMemo(() => {
    const items = data?.items ?? [];
    return items.find((item) => item.agentId === selectedAgentId && item.workspacePath === selectedWorkspacePath) ?? items[0];
  }, [data, selectedAgentId, selectedWorkspacePath]);

  useEffect(() => {
    setMetadataDraft(draftFromAgent(selectedAgent));
  }, [
    selectedAgent?.agentId,
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

  const selectAgent = (agent: AgentInventoryItem) => {
    setSelectedAgentId(agent.agentId);
    setSelectedWorkspacePath(agent.workspacePath);
    const next = new URLSearchParams();
    next.set("timeType", timeType);
    next.set("agentId", agent.agentId);
    next.set("workspacePath", agent.workspacePath);
    if (healthState !== "all") next.set("healthState", healthState);
    if (clean(queryText)) next.set("q", queryText.trim());
    if (clean(userId)) next.set("userId", userId.trim());
    setSearchParams(next);
  };

  const clearFilters = () => {
    setHealthState("all");
    setQueryText("");
    setSelectedAgentId("");
    setSelectedWorkspacePath("");
    setUserId("");
    setSearchParams({});
  };

  const saveMetadata = async () => {
    if (!selectedAgent) return;
    setSavingMetadata(true);
    try {
      await securityCenterApi.updateAgentMetadata(selectedAgent.agentId, {
        workspacePath: selectedAgent.workspacePath,
        displayName: metadataDraft.displayName,
        owner: metadataDraft.owner,
        team: metadataDraft.team,
        environment: metadataDraft.environment,
        criticality: metadataDraft.criticality,
        tags: splitTags(metadataDraft.tags),
        note: metadataDraft.note,
      });
      await refresh();
    } finally {
      setSavingMetadata(false);
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
              <p className="mt-0.5 truncate text-xs text-zinc-500">旁路发现 · 活跃度 · Incident 暴露面</p>
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <AdminTokenControl compact />
            <Clock3 className="size-3.5" />
            <span>{data?.updateTime ? formatDate(data.updateTime) : "等待刷新"}</span>
          </div>
        </div>

        <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-[120px_130px_minmax(160px,0.8fr)_minmax(180px,1fr)_auto_auto]">
          <Select value={timeType} onValueChange={(next) => setTimeType(next as SecurityTimeType)}>
            <SelectTrigger className="h-9 border-white/10 bg-white/5 text-xs text-zinc-100"><SelectValue /></SelectTrigger>
            <SelectContent>
              {TIME_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
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
          <Button type="button" size="sm" onClick={refresh} disabled={loading} className="h-9 bg-teal-500 text-[#07100c] hover:bg-teal-400">
            {loading ? <LoaderCircle className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
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
                  <h2 className="text-sm font-semibold text-zinc-100">Agents</h2>
                </div>
                <span className="text-xs text-zinc-500">{data ? `${data.total} 个` : "--"}</span>
              </div>
              {loading && !data ? (
                <div className="flex min-h-40 items-center justify-center text-sm text-zinc-500">
                  <LoaderCircle className="mr-2 size-4 animate-spin" />
                  加载资产...
                </div>
              ) : (data?.items?.length ?? 0) === 0 ? (
                <div className="flex min-h-40 items-center justify-center text-sm text-zinc-500">暂无资产</div>
              ) : (
                <div className="max-h-[calc(100vh-300px)] overflow-y-auto">
                  {data?.items.map((agent) => (
                    <AgentRow
                      key={`${agent.workspacePath}:${agent.agentId}`}
                      agent={agent}
                      active={agent.agentId === selectedAgent?.agentId && agent.workspacePath === selectedAgent?.workspacePath}
                      onSelect={() => selectAgent(agent)}
                    />
                  ))}
                </div>
              )}
            </section>

            <div className="space-y-4">
              <AgentDetail
                agent={selectedAgent}
                timeType={timeType}
                draft={metadataDraft}
                saving={savingMetadata}
                onDraftChange={(patch) => setMetadataDraft((current) => ({ ...current, ...patch }))}
                onSaveMetadata={saveMetadata}
              />
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
