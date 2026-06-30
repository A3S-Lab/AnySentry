import { useRequest } from "ahooks";
import dayjs from "dayjs";
import {
  ArrowLeft,
  Bot,
  BrainCircuit,
  Clock3,
  FileText,
  FolderTree,
  GitBranch,
  LoaderCircle,
  Network,
  RadioTower,
  RefreshCw,
  Search,
  ShieldAlert,
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
  type AgentTopologyEdge,
  type AgentTopologyNode,
  type AgentTopologyQuery,
  type SecurityRiskLevel,
  type SecuritySeverity,
  type SecurityTimeType,
  type TopologyNodeType,
  securityCenterApi,
} from "@/lib/api/security-center";
import { cn } from "@/lib/utils";

const TIME_OPTIONS: Array<{ value: SecurityTimeType; label: string }> = [
  { value: "last_3h", label: "近3小时" },
  { value: "last_1d", label: "近一天" },
  { value: "last_7d", label: "近一周" },
  { value: "last_30d", label: "近一月" },
];

const SCOPE_OPTIONS: Array<{ value: "all" | "risk"; label: string }> = [
  { value: "all", label: "全部关系" },
  { value: "risk", label: "仅风险" },
];

const NODE_LABEL: Record<TopologyNodeType, string> = {
  agent: "Agent",
  workspace: "Workspace",
  collector: "Collector",
  tool: "Tool",
  network: "Network",
  file: "File",
  llm: "LLM",
  security: "Security",
};

const SEVERITY_LABEL: Record<SecuritySeverity, string> = {
  info: "提示",
  low: "低",
  medium: "中",
  high: "高",
  critical: "严重",
};

function clean(value: string) {
  return value.trim() || undefined;
}

function formatDate(value?: string) {
  if (!value) return "--";
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed.format("MM-DD HH:mm:ss") : value;
}

function toneBySeverity(severity?: SecuritySeverity) {
  if (severity === "critical" || severity === "high") return "border-rose-400/30 bg-rose-500/10 text-rose-100";
  if (severity === "medium") return "border-amber-400/30 bg-amber-500/10 text-amber-100";
  if (severity === "low") return "border-teal-400/30 bg-teal-500/10 text-teal-100";
  return "border-white/10 bg-white/5 text-zinc-300";
}

function riskClass(level?: SecurityRiskLevel) {
  if (level === "critical" || level === "high") return "border-rose-400/30 bg-rose-500/10 text-rose-100";
  if (level === "medium") return "border-amber-400/30 bg-amber-500/10 text-amber-100";
  if (level === "low") return "border-teal-400/30 bg-teal-500/10 text-teal-100";
  return "border-white/10 bg-white/5 text-zinc-300";
}

function nodeTone(type?: TopologyNodeType) {
  if (type === "agent") return "border-teal-400/25 bg-teal-500/10 text-teal-100";
  if (type === "collector") return "border-sky-400/25 bg-sky-500/10 text-sky-100";
  if (type === "network") return "border-orange-400/25 bg-orange-500/10 text-orange-100";
  if (type === "file") return "border-amber-400/25 bg-amber-500/10 text-amber-100";
  if (type === "llm") return "border-violet-400/25 bg-violet-500/10 text-violet-100";
  if (type === "security") return "border-rose-400/25 bg-rose-500/10 text-rose-100";
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

function NodeIcon({ type }: { type: TopologyNodeType }) {
  const iconClass = "size-3.5";
  if (type === "agent") return <Bot className={iconClass} />;
  if (type === "workspace") return <FolderTree className={iconClass} />;
  if (type === "collector") return <RadioTower className={iconClass} />;
  if (type === "tool") return <TerminalSquare className={iconClass} />;
  if (type === "network") return <Network className={iconClass} />;
  if (type === "file") return <FileText className={iconClass} />;
  if (type === "llm") return <BrainCircuit className={iconClass} />;
  return <ShieldAlert className={iconClass} />;
}

function EdgeRow({
  edge,
  source,
  target,
  active,
  onSelect,
}: {
  edge: AgentTopologyEdge;
  source?: AgentTopologyNode;
  target?: AgentTopologyNode;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "grid w-full grid-cols-[86px_minmax(0,1fr)_70px_74px_76px] items-center gap-3 border-b border-white/8 px-3 py-3 text-left transition hover:bg-white/[0.05]",
        active && "bg-teal-400/8",
      )}
    >
      <span className="font-mono text-xs text-zinc-500">{formatDate(edge.lastSeen)}</span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-zinc-100" title={`${source?.label ?? edge.sourceNodeId} → ${target?.label ?? edge.targetNodeId}`}>
          {source?.label ?? edge.sourceNodeId} → {target?.label ?? edge.targetNodeId}
        </span>
        <span className="mt-0.5 block truncate text-[11px] text-zinc-600" title={edge.sampleSubject}>
          {edge.sampleSubject}
        </span>
      </span>
      <span><Pill className={nodeTone(target?.type)}>{target?.type ? NODE_LABEL[target.type] : edge.type}</Pill></span>
      <span><Pill className={toneBySeverity(edge.maxSeverity)}>{SEVERITY_LABEL[edge.maxSeverity]}</Pill></span>
      <span className="text-right font-mono text-xs text-zinc-500">{edge.riskyEventCount}/{edge.eventCount}</span>
    </button>
  );
}

function NodeChip({ node }: { node: AgentTopologyNode }) {
  return (
    <div className={cn("min-w-0 rounded-[8px] border px-3 py-2", nodeTone(node.type))}>
      <div className="flex min-w-0 items-center gap-2">
        <NodeIcon type={node.type} />
        <span className="truncate text-xs font-semibold" title={node.label}>{node.label}</span>
      </div>
      <div className="mt-1 flex items-center justify-between gap-2">
        <span className="truncate text-[10px] opacity-70" title={node.subtitle ?? NODE_LABEL[node.type]}>{node.subtitle ?? NODE_LABEL[node.type]}</span>
        <span className="font-mono text-[10px] opacity-80">{node.riskyEventCount}/{node.eventCount}</span>
      </div>
    </div>
  );
}

function TopologyMap({ nodes, edges }: { nodes: AgentTopologyNode[]; edges: AgentTopologyEdge[] }) {
  const agents = nodes.filter((node) => node.type === "agent").slice(0, 8);
  const targetsByAgent = new Map<string, AgentTopologyNode[]>();
  for (const edge of edges) {
    const source = nodes.find((node) => node.nodeId === edge.sourceNodeId);
    const target = nodes.find((node) => node.nodeId === edge.targetNodeId);
    if (!source || !target || source.type !== "agent") continue;
    const list = targetsByAgent.get(source.nodeId) ?? [];
    if (!list.some((node) => node.nodeId === target.nodeId)) list.push(target);
    targetsByAgent.set(source.nodeId, list);
  }

  return (
    <section className="rounded-[8px] border border-white/10 bg-[#111612]/92">
      <div className="flex min-h-12 items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
        <div className="flex items-center gap-2">
          <GitBranch className="size-4 text-teal-200" />
          <h2 className="text-sm font-semibold text-zinc-100">关系图</h2>
        </div>
        <span className="text-xs text-zinc-500">{nodes.length} nodes / {edges.length} edges</span>
      </div>
      {nodes.length === 0 ? (
        <div className="flex min-h-40 items-center justify-center text-sm text-zinc-500">暂无关系</div>
      ) : (
        <div className="space-y-3 p-4">
          {agents.length ? agents.map((agent) => (
            <div key={agent.nodeId} className="grid gap-3 rounded-md border border-white/10 bg-white/[0.03] p-3 md:grid-cols-[minmax(180px,0.35fr)_minmax(0,1fr)]">
              <NodeChip node={agent} />
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {(targetsByAgent.get(agent.nodeId) ?? []).slice(0, 9).map((target) => <NodeChip key={target.nodeId} node={target} />)}
                {(targetsByAgent.get(agent.nodeId) ?? []).length === 0 ? <p className="flex items-center text-xs text-zinc-500">仅有资产/采集关系</p> : null}
              </div>
            </div>
          )) : (
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {nodes.slice(0, 12).map((node) => <NodeChip key={node.nodeId} node={node} />)}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function EdgeDetail({
  edge,
  source,
  target,
  timeType,
  routeSourceId,
  routeCollectorId,
  routeWorkspacePath,
}: {
  edge?: AgentTopologyEdge;
  source?: AgentTopologyNode;
  target?: AgentTopologyNode;
  timeType: SecurityTimeType;
  routeSourceId?: string;
  routeCollectorId?: string;
  routeWorkspacePath?: string;
}) {
  if (!edge) {
    return (
      <section className="rounded-[8px] border border-white/10 bg-[#111612]/92">
        <div className="flex min-h-[300px] items-center justify-center text-sm text-zinc-500">选择一条关系查看证据</div>
      </section>
    );
  }

  const eventQs = new URLSearchParams();
  if (edge.sampleEventId) eventQs.set("eventId", edge.sampleEventId);
  const edgeAgentId = source?.agentId ?? target?.agentId;
  const edgeWorkspacePath = source?.workspacePath ?? target?.workspacePath ?? routeWorkspacePath;
  const edgeCollectorId = source?.collectorId ?? target?.collectorId ?? routeCollectorId;
  if (edgeAgentId) eventQs.set("agentId", edgeAgentId);
  if (edgeWorkspacePath) eventQs.set("workspacePath", edgeWorkspacePath);
  if (edgeCollectorId) eventQs.set("collectorId", edgeCollectorId);
  if (routeSourceId) eventQs.set("sourceId", routeSourceId);
  const agentQs = new URLSearchParams();
  if (edgeAgentId) agentQs.set("agentId", edgeAgentId);
  if (edgeWorkspacePath) agentQs.set("workspacePath", edgeWorkspacePath);
  const collectorQs = new URLSearchParams();
  if (edgeCollectorId) collectorQs.set("collectorId", edgeCollectorId);
  const bundleQs = new URLSearchParams({ timeType });
  bundleQs.set("edgeId", edge.edgeId);
  if (edge.sampleEventId) bundleQs.set("eventId", edge.sampleEventId);
  if (edgeAgentId) bundleQs.set("agentId", edgeAgentId);
  if (edgeWorkspacePath) bundleQs.set("workspacePath", edgeWorkspacePath);
  if (edgeCollectorId) bundleQs.set("collectorId", edgeCollectorId);
  if (routeSourceId) bundleQs.set("sourceId", routeSourceId);

  return (
    <section className="rounded-[8px] border border-white/10 bg-[#111612]/92">
      <div className="flex min-h-12 items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <GitBranch className="size-4 shrink-0 text-teal-200" />
          <h2 className="truncate text-sm font-semibold text-zinc-100">{source?.label ?? edge.sourceNodeId} → {target?.label ?? edge.targetNodeId}</h2>
        </div>
        <Pill className={toneBySeverity(edge.maxSeverity)}>{SEVERITY_LABEL[edge.maxSeverity]}</Pill>
      </div>

      <div className="space-y-4 p-4">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <FieldValue label="Edge ID" value={edge.edgeId} />
          <FieldValue label="Type" value={edge.type} />
          <FieldValue label="Last Seen" value={formatDate(edge.lastSeen)} />
          <FieldValue label="Source" value={source?.label ?? edge.sourceNodeId} />
          <FieldValue label="Target" value={target?.label ?? edge.targetNodeId} />
          <FieldValue label="Sample Event" value={edge.sampleEventId} />
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <MetricTile label="事件" value={edge.eventCount} tone="border-white/10 bg-white/[0.03] text-zinc-100" />
          <MetricTile label="风险事件" value={edge.riskyEventCount} tone="border-rose-400/25 bg-rose-500/10 text-rose-100" />
          <MetricTile label="风险类型" value={edge.riskCategories.length} tone="border-amber-400/25 bg-amber-500/10 text-amber-100" />
        </div>

        <div>
          <p className="mb-2 text-xs font-medium text-zinc-400">最近样本</p>
          <div className="rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-zinc-300">{edge.sampleSubject}</div>
        </div>

        {edge.riskCategories.length ? (
          <div className="rounded-md border border-white/10 bg-white/[0.03] p-3">
            <div className="mb-2 flex items-center gap-2">
              <ShieldAlert className="size-4 text-rose-200" />
              <h3 className="text-sm font-semibold text-zinc-100">风险分类</h3>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {edge.riskCategories.map((risk) => (
                <div key={risk.riskCategory} className="min-w-0 rounded-md border border-white/10 bg-[#111612]/70 px-3 py-2">
                  <p className="truncate text-xs font-medium text-zinc-100" title={risk.riskName}>{risk.riskName}</p>
                  <p className="mt-1 font-mono text-[11px] text-zinc-500">{risk.riskCategory} · {risk.eventCount}</p>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button asChild size="sm" className="h-8 bg-teal-500 text-[#07100c] hover:bg-teal-400">
            <Link to={`/evidence?${bundleQs.toString()}`}>
              <FileText className="size-3.5" />
              证据包
            </Link>
          </Button>
          <Button asChild size="sm" className="h-8 bg-teal-500 text-[#07100c] hover:bg-teal-400">
            <Link to={`/events?${eventQs.toString()}`}>
              <Search className="size-3.5" />
              事件
            </Link>
          </Button>
          {edgeAgentId ? (
            <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
              <Link to={`/agents?${agentQs.toString()}`}>
                <Bot className="size-3.5" />
                Agent
              </Link>
            </Button>
          ) : null}
          {collectorQs.toString() ? (
            <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
              <Link to={`/collectors?${collectorQs.toString()}`}>
                <RadioTower className="size-3.5" />
                Collector
              </Link>
            </Button>
          ) : null}
        </div>
      </div>
    </section>
  );
}

export default function TopologyPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [timeType, setTimeType] = useState<SecurityTimeType>((searchParams.get("timeType") as SecurityTimeType) || "last_3h");
  const [scope, setScope] = useState<"all" | "risk">((searchParams.get("scope") as "all" | "risk") || "all");
  const [queryText, setQueryText] = useState(searchParams.get("q") ?? "");
  const [selectedEdgeId, setSelectedEdgeId] = useState(searchParams.get("edgeId") ?? "");
  const scopedEventId = searchParams.get("eventId") ?? "";
  const scopedAgentId = searchParams.get("agentId") ?? "";
  const scopedWorkspacePath = searchParams.get("workspacePath") ?? "";
  const scopedCollectorId = searchParams.get("collectorId") ?? "";
  const scopedSourceId = searchParams.get("sourceId") ?? "";

  const query = useMemo<AgentTopologyQuery>(() => ({
    timeType,
    edgeId: clean(selectedEdgeId),
    eventId: clean(scopedEventId),
    agentId: clean(scopedAgentId),
    workspacePath: clean(scopedWorkspacePath),
    collectorId: clean(scopedCollectorId),
    sourceId: clean(scopedSourceId),
    includeBenign: scope === "all",
    q: clean(queryText),
    limit: 300,
  }), [queryText, scopedAgentId, scopedCollectorId, scopedEventId, scopedSourceId, scopedWorkspacePath, scope, selectedEdgeId, timeType]);

  const { data, loading, refresh } = useRequest(() => securityCenterApi.agentTopology(query), {
    refreshDeps: [query],
    pollingInterval: 10000,
    pollingWhenHidden: false,
  });

  const nodeById = useMemo(() => new Map((data?.nodes ?? []).map((node) => [node.nodeId, node])), [data]);
  const selectedEdge = useMemo(() => {
    const edges = data?.edges ?? [];
    return edges.find((edge) => edge.edgeId === selectedEdgeId) ?? edges[0];
  }, [data, selectedEdgeId]);

  const selectEdge = (edge: AgentTopologyEdge) => {
    setSelectedEdgeId(edge.edgeId);
    const next = new URLSearchParams();
    next.set("timeType", timeType);
    next.set("scope", scope);
    next.set("edgeId", edge.edgeId);
    const source = nodeById.get(edge.sourceNodeId);
    const target = nodeById.get(edge.targetNodeId);
    const edgeAgentId = source?.agentId ?? target?.agentId;
    const edgeWorkspacePath = source?.workspacePath ?? target?.workspacePath ?? scopedWorkspacePath;
    const edgeCollectorId = source?.collectorId ?? target?.collectorId ?? scopedCollectorId;
    if (edgeAgentId) next.set("agentId", edgeAgentId);
    if (edgeWorkspacePath) next.set("workspacePath", edgeWorkspacePath);
    if (edgeCollectorId) next.set("collectorId", edgeCollectorId);
    if (scopedSourceId) next.set("sourceId", scopedSourceId);
    if (clean(queryText)) next.set("q", queryText.trim());
    setSearchParams(next);
  };

  const clearFilters = () => {
    setScope("all");
    setQueryText("");
    setSelectedEdgeId("");
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
                <GitBranch className="size-5 shrink-0 text-teal-300" />
                <h1 className="truncate text-lg font-semibold tracking-normal text-zinc-50">智能体拓扑</h1>
              </div>
              <p className="mt-0.5 truncate text-xs text-zinc-500">Agent · Collector · Tool · Network · File · LLM</p>
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
          <Select value={scope} onValueChange={(next) => setScope(next as "all" | "risk")}>
            <SelectTrigger className="h-9 border-white/10 bg-white/5 text-xs text-zinc-100"><SelectValue /></SelectTrigger>
            <SelectContent>{SCOPE_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
          </Select>
          <Input value={queryText} onChange={(event) => setQueryText(event.target.value)} placeholder="agent / endpoint / file / risk" className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
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
            <MetricTile label="Agent" value={data?.summary.agentCount ?? 0} tone="border-teal-400/25 bg-teal-500/10 text-teal-100" />
            <MetricTile label="Collector" value={data?.summary.collectorCount ?? 0} tone="border-sky-400/25 bg-sky-500/10 text-sky-100" />
            <MetricTile label="工具" value={data?.summary.toolTargetCount ?? 0} tone="border-white/10 bg-white/[0.03] text-zinc-100" />
            <MetricTile label="网络" value={data?.summary.externalEndpointCount ?? 0} tone="border-orange-400/25 bg-orange-500/10 text-orange-100" />
            <MetricTile label="文件/LLM" value={(data?.summary.fileTargetCount ?? 0) + (data?.summary.llmEndpointCount ?? 0)} tone="border-violet-400/25 bg-violet-500/10 text-violet-100" />
            <MetricTile label="风险边" value={data?.summary.riskyEdgeCount ?? 0} tone="border-rose-400/25 bg-rose-500/10 text-rose-100" />
          </div>

          <TopologyMap nodes={data?.nodes ?? []} edges={data?.edges ?? []} />

          <div className="grid gap-4 xl:grid-cols-[minmax(560px,1fr)_minmax(0,1.15fr)]">
            <section className="min-h-[560px] rounded-[8px] border border-white/10 bg-[#111612]/92">
              <div className="flex min-h-12 items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
                <div className="flex items-center gap-2">
                  <Network className="size-4 text-teal-200" />
                  <h2 className="text-sm font-semibold text-zinc-100">关系边</h2>
                </div>
                <span className="text-xs text-zinc-500">{data ? `${data.summary.edgeCount} 条` : "--"}</span>
              </div>
              {loading && !data ? (
                <div className="flex min-h-40 items-center justify-center text-sm text-zinc-500">
                  <LoaderCircle className="mr-2 size-4 animate-spin" />
                  加载拓扑...
                </div>
              ) : (data?.edges?.length ?? 0) === 0 ? (
                <div className="flex min-h-40 items-center justify-center text-sm text-zinc-500">暂无关系</div>
              ) : (
                <div className="max-h-[calc(100vh-300px)] overflow-y-auto">
                  {data?.edges.map((edge) => (
                    <EdgeRow
                      key={edge.edgeId}
                      edge={edge}
                      source={nodeById.get(edge.sourceNodeId)}
                      target={nodeById.get(edge.targetNodeId)}
                      active={edge.edgeId === selectedEdge?.edgeId}
                      onSelect={() => selectEdge(edge)}
                    />
                  ))}
                </div>
              )}
            </section>

            <EdgeDetail
              edge={selectedEdge}
              source={selectedEdge ? nodeById.get(selectedEdge.sourceNodeId) : undefined}
              target={selectedEdge ? nodeById.get(selectedEdge.targetNodeId) : undefined}
              timeType={timeType}
              routeSourceId={scopedSourceId}
              routeCollectorId={scopedCollectorId}
              routeWorkspacePath={scopedWorkspacePath}
            />
          </div>
        </div>
      </main>
    </div>
  );
}
