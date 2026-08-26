import { useRequest } from "ahooks";
import dayjs from "dayjs";
import { formatSecurityDateTime, liveSecuritySnapshotAsOf, securityTimestampValue } from "@/lib/date-time";
import {
  Bot,
  BrainCircuit,
  Clock3,
  FileText,
  FolderTree,
  GitBranch,
  LoaderCircle,
  Maximize2,
  Minus,
  Network,
  Plus,
  RadioTower,
  RefreshCw,
  Search,
  ShieldAlert,
  TerminalSquare,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AdminTokenControl } from "@/components/custom/admin-token-control";
import { useSecurityConsole } from "@/components/custom/security-console-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  type AgentClassification,
  type AgentTopologyEdge,
  type AgentTopologyNode,
  type AgentTopologyQuery,
  type SecuritySeverity,
  type SecurityTimeType,
  type TopologyNodeType,
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

const SCOPE_OPTIONS: Array<{ value: "all" | "risk"; label: string }> = [
  { value: "risk", label: "仅风险关系" },
  { value: "all", label: "全部关系" },
];

type TopologyEventScope = "agent" | "raw";

function TopologyEventScopeTabs({
  value,
  onChange,
}: {
  value: TopologyEventScope;
  onChange: (value: TopologyEventScope) => void;
}) {
  const options: Array<{ value: TopologyEventScope; label: string }> = [
    { value: "agent", label: "Agent 相关" },
    { value: "raw", label: "全部观测" },
  ];

  return (
    <div className="inline-flex h-9 items-center rounded-md border border-white/10 bg-white/5 p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={cn(
            "h-8 min-w-20 rounded px-2.5 text-xs font-semibold transition-colors",
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

const CLASSIFICATION_LABEL: Record<AgentClassification, string> = {
  confirmed_agent: "已确认 Agent",
  probable_agent: "候选 Agent",
  unknown: "未知主体",
  non_agent: "非 Agent",
};

const EDGE_LABEL: Record<AgentTopologyEdge["type"], string> = {
  runs_in: "运行于",
  observed_by: "由其观测",
  executes: "调用",
  connects: "连接",
  resolves: "解析",
  accesses: "访问",
  calls_llm: "调用模型",
  triggers: "触发",
};

function clean(value: string) {
  return value.trim() || undefined;
}

function formatDate(value?: string) {
  return formatSecurityDateTime(value, "MM-DD HH:mm:ss", value || "--");
}

function toneBySeverity(severity?: SecuritySeverity) {
  if (severity === "critical" || severity === "high") return "border-rose-400/30 bg-rose-500/10 text-rose-100";
  if (severity === "medium") return "border-amber-400/30 bg-amber-500/10 text-amber-100";
  if (severity === "low") return "border-teal-400/30 bg-teal-500/10 text-teal-100";
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

function RelationTimelineRow({
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
        "grid w-full grid-cols-[92px_minmax(0,1fr)_86px_96px] items-center gap-3 border-b border-white/8 px-3 py-3 text-left transition hover:bg-white/[0.05]",
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
      <span><Pill className={nodeTone(target?.type)}>{EDGE_LABEL[edge.type]}</Pill></span>
      <span className="text-right">
        <span className="block font-mono text-xs text-zinc-300">{edge.riskyEventCount} 风险</span>
        <span className="mt-0.5 block text-[10px] text-zinc-600">{edge.eventCount} 总计</span>
      </span>
    </button>
  );
}

function AgentListItem({
  node,
  active,
  relationCount,
  onSelect,
}: {
  node: AgentTopologyNode;
  active: boolean;
  relationCount: number;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "w-full rounded-[8px] border px-3 py-3 text-left transition",
        active
          ? "border-teal-400/40 bg-teal-500/12"
          : "border-white/10 bg-white/[0.025] hover:border-white/20 hover:bg-white/[0.05]",
      )}
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <Bot className={cn("size-4 shrink-0", active ? "text-teal-200" : "text-zinc-500")} />
            <span className="truncate text-sm font-semibold text-zinc-100" title={node.label}>{node.label}</span>
            {node.classification ? (
              <Pill className={node.classification === "confirmed_agent"
                ? "border-teal-400/30 bg-teal-500/10 text-teal-100"
                : "border-amber-400/30 bg-amber-500/10 text-amber-100"}
              >
                {CLASSIFICATION_LABEL[node.classification]}
              </Pill>
            ) : null}
          </div>
          <p className="mt-1 truncate pl-6 text-[11px] text-zinc-600" title={node.workspacePath ?? node.subtitle}>
            {node.workspacePath ?? node.subtitle ?? "未归属 Workspace"}
          </p>
        </div>
        {node.riskyEventCount > 0 ? (
          <Pill className={toneBySeverity(node.riskLevel === "critical" ? "critical" : node.riskLevel === "high" ? "high" : node.riskLevel === "medium" ? "medium" : "low")}>
            {node.riskLevelText}
          </Pill>
        ) : null}
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2 text-center">
        <div className="rounded border border-white/8 bg-black/10 px-1 py-1.5">
          <p className="font-mono text-xs text-zinc-200">{relationCount}</p>
          <p className="text-[9px] text-zinc-600">关系</p>
        </div>
        <div className="rounded border border-white/8 bg-black/10 px-1 py-1.5">
          <p className="font-mono text-xs text-rose-200">{node.riskyEventCount}</p>
          <p className="text-[9px] text-zinc-600">风险事件</p>
        </div>
        <div className="rounded border border-white/8 bg-black/10 px-1 py-1.5">
          <p className="font-mono text-xs text-zinc-200">{node.eventCount}</p>
          <p className="text-[9px] text-zinc-600">总事件</p>
        </div>
      </div>
    </button>
  );
}

const GRAPH_WIDTH = 1260;
const GRAPH_NODE_WIDTH = 220;
const GRAPH_NODE_HEIGHT = 76;
const GRAPH_EDGE_LIMIT = 18;

type GraphPosition = { x: number; y: number };

function graphRiskTone(node: AgentTopologyNode) {
  if (node.riskyEventCount > 0) {
    if (node.riskLevel === "critical" || node.riskLevel === "high") {
      return "border-rose-400/60 bg-[#211216] text-rose-100 shadow-[0_0_24px_-14px_rgba(251,113,133,0.9)]";
    }
    return "border-amber-400/55 bg-[#211b10] text-amber-100 shadow-[0_0_24px_-14px_rgba(251,191,36,0.8)]";
  }
  return nodeTone(node.type);
}

function graphEdgeColor(edge: AgentTopologyEdge, selected: boolean) {
  if (selected) return "#2dd4bf";
  if (edge.maxSeverity === "critical" || edge.maxSeverity === "high") return "#fb7185";
  if (edge.maxSeverity === "medium") return "#f59e0b";
  if (edge.riskyEventCount > 0) return "#fbbf24";
  return "#64748b";
}

function SecurityTopologyCanvas({
  agent,
  edges,
  nodeById,
  selectedEdgeId,
  onSelect,
}: {
  agent?: AgentTopologyNode;
  edges: AgentTopologyEdge[];
  nodeById: Map<string, AgentTopologyNode>;
  selectedEdgeId?: string;
  onSelect: (edge: AgentTopologyEdge) => void;
}) {
  const [zoom, setZoom] = useState(0.85);
  const graph = useMemo(() => {
    const visibleEdges = [...edges]
      .sort((a, b) =>
        b.riskyEventCount - a.riskyEventCount
        || b.eventCount - a.eventCount
        || securityTimestampValue(b.lastSeen) - securityTimestampValue(a.lastSeen))
      .slice(0, GRAPH_EDGE_LIMIT);
    const visibleNodeIds = new Set(visibleEdges.flatMap((edge) => [edge.sourceNodeId, edge.targetNodeId]));
    if (agent) visibleNodeIds.add(agent.nodeId);
    const nodes = [...visibleNodeIds]
      .map((nodeId) => nodeById.get(nodeId))
      .filter((node): node is AgentTopologyNode => Boolean(node));
    const leftTypes = new Set<TopologyNodeType>(["workspace", "collector"]);
    const typeRank: Record<TopologyNodeType, number> = {
      workspace: 0,
      collector: 1,
      agent: 2,
      tool: 3,
      file: 4,
      network: 5,
      llm: 6,
      security: 7,
    };
    const counterpartSort = (a: AgentTopologyNode, b: AgentTopologyNode) =>
      typeRank[a.type] - typeRank[b.type]
      || b.riskyEventCount - a.riskyEventCount
      || b.eventCount - a.eventCount;
    const leftNodes = nodes.filter((node) => node.nodeId !== agent?.nodeId && leftTypes.has(node.type)).sort(counterpartSort);
    const rightNodes = nodes.filter((node) => node.nodeId !== agent?.nodeId && !leftTypes.has(node.type)).sort(counterpartSort);
    const largestColumn = Math.max(leftNodes.length, rightNodes.length, 1);
    const height = Math.max(520, largestColumn * 96 + 120);
    const positions = new Map<string, GraphPosition>();
    const distribute = (columnNodes: AgentTopologyNode[], x: number) => {
      if (columnNodes.length === 1) {
        positions.set(columnNodes[0].nodeId, { x, y: height / 2 - GRAPH_NODE_HEIGHT / 2 });
        return;
      }
      const top = 64;
      const available = height - top * 2 - GRAPH_NODE_HEIGHT;
      columnNodes.forEach((node, index) => {
        positions.set(node.nodeId, {
          x,
          y: top + (available * index) / Math.max(1, columnNodes.length - 1),
        });
      });
    };
    distribute(leftNodes, 70);
    distribute(rightNodes, GRAPH_WIDTH - GRAPH_NODE_WIDTH - 70);
    if (agent) positions.set(agent.nodeId, { x: GRAPH_WIDTH / 2 - GRAPH_NODE_WIDTH / 2, y: height / 2 - GRAPH_NODE_HEIGHT / 2 });
    return { visibleEdges, nodes, positions, height };
  }, [agent, edges, nodeById]);

  const edgeForNode = (nodeId: string) =>
    graph.visibleEdges.find((edge) => edge.sourceNodeId === nodeId || edge.targetNodeId === nodeId);

  return (
    <section className="overflow-hidden rounded-[8px] border border-white/10 bg-[#0c1110]">
      <div className="flex flex-col gap-3 border-b border-white/10 px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Network className="size-4 text-teal-200" />
            <h2 className="text-sm font-semibold text-zinc-100">AnySentry 运行时安全拓扑</h2>
            {agent ? <Pill className="border-teal-400/30 bg-teal-500/10 text-teal-100">{agent.label}</Pill> : null}
          </div>
          <p className="mt-1 text-[11px] text-zinc-600">
            Workspace / Collector → Agent → Tool / File / Network / LLM；关系来自真实观测事件，不等同于攻击链结论
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 text-[10px] text-zinc-500"><span className="size-2 rounded-full bg-rose-400" />高风险关系</span>
          <span className="inline-flex items-center gap-1.5 text-[10px] text-zinc-500"><span className="size-2 rounded-full bg-amber-400" />待关注关系</span>
          <span className="inline-flex items-center gap-1.5 text-[10px] text-zinc-500"><span className="size-2 rounded-full bg-slate-500" />普通关系</span>
          <div className="ml-2 inline-flex items-center rounded-md border border-white/10 bg-white/[0.03] p-0.5">
            <button
              type="button"
              title="缩小"
              onClick={() => setZoom((value) => Math.max(0.55, Number((value - 0.1).toFixed(2))))}
              className="inline-flex size-7 items-center justify-center rounded text-zinc-500 hover:bg-white/5 hover:text-zinc-200"
            >
              <Minus className="size-3.5" />
            </button>
            <button
              type="button"
              title="恢复默认缩放"
              onClick={() => setZoom(0.85)}
              className="inline-flex h-7 min-w-14 items-center justify-center gap-1 rounded px-2 font-mono text-[10px] text-zinc-400 hover:bg-white/5 hover:text-zinc-200"
            >
              <Maximize2 className="size-3" />
              {Math.round(zoom * 100)}%
            </button>
            <button
              type="button"
              title="放大"
              onClick={() => setZoom((value) => Math.min(1.3, Number((value + 0.1).toFixed(2))))}
              className="inline-flex size-7 items-center justify-center rounded text-zinc-500 hover:bg-white/5 hover:text-zinc-200"
            >
              <Plus className="size-3.5" />
            </button>
          </div>
        </div>
      </div>

      {!agent ? (
        <div className="flex min-h-[420px] items-center justify-center text-sm text-zinc-500">选择一个 Agent 查看安全关系图</div>
      ) : graph.visibleEdges.length === 0 ? (
        <div className="flex min-h-[420px] items-center justify-center text-sm text-zinc-500">当前筛选范围内没有可绘制关系</div>
      ) : (
        <div className="max-h-[680px] overflow-auto bg-[radial-gradient(circle_at_center,rgba(148,163,184,0.12)_1px,transparent_1px)] [background-size:24px_24px]">
          <div style={{ width: GRAPH_WIDTH * zoom, height: graph.height * zoom }}>
            <div
              className="relative"
              style={{
                width: GRAPH_WIDTH,
                height: graph.height,
                transform: `scale(${zoom})`,
                transformOrigin: "left top",
              }}
            >
              <svg className="absolute inset-0 size-full" viewBox={`0 0 ${GRAPH_WIDTH} ${graph.height}`} aria-hidden="true">
                <defs>
                  <marker id="topology-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="strokeWidth">
                    <path d="M0,0 L8,4 L0,8 Z" fill="context-stroke" />
                  </marker>
                </defs>
                {graph.visibleEdges.map((edge, index) => {
                  const source = graph.positions.get(edge.sourceNodeId);
                  const target = graph.positions.get(edge.targetNodeId);
                  if (!source || !target) return null;
                  const leftToRight = source.x < target.x;
                  const startX = leftToRight ? source.x + GRAPH_NODE_WIDTH : source.x;
                  const endX = leftToRight ? target.x : target.x + GRAPH_NODE_WIDTH;
                  const startY = source.y + GRAPH_NODE_HEIGHT / 2;
                  const endY = target.y + GRAPH_NODE_HEIGHT / 2;
                  const direction = leftToRight ? 1 : -1;
                  const bend = Math.max(80, Math.abs(endX - startX) * 0.42);
                  const path = `M ${startX} ${startY} C ${startX + direction * bend} ${startY}, ${endX - direction * bend} ${endY}, ${endX} ${endY}`;
                  const selected = edge.edgeId === selectedEdgeId;
                  const color = graphEdgeColor(edge, selected);
                  const labelX = (startX + endX) / 2;
                  const labelY = (startY + endY) / 2 - 7 + (index % 2 === 0 ? -3 : 3);
                  return (
                    <g key={edge.edgeId}>
                      <path
                        d={path}
                        fill="none"
                        stroke="transparent"
                        strokeWidth="14"
                        className="cursor-pointer"
                        onClick={() => onSelect(edge)}
                      />
                      <path
                        d={path}
                        fill="none"
                        stroke={color}
                        strokeWidth={selected ? 3 : 1.8}
                        strokeOpacity={selected ? 1 : 0.85}
                        markerEnd="url(#topology-arrow)"
                        className="pointer-events-none"
                      />
                      <text
                        x={labelX}
                        y={labelY}
                        textAnchor="middle"
                        fill={selected ? "#99f6e4" : "#a1a1aa"}
                        fontSize="11"
                        fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                        stroke="#0c1110"
                        strokeWidth="5"
                        paintOrder="stroke"
                        className="pointer-events-none"
                      >
                        {edge.riskyEventCount} 风险 · {edge.eventCount} 事件
                      </text>
                    </g>
                  );
                })}
              </svg>

              {graph.nodes.map((node) => {
                const position = graph.positions.get(node.nodeId);
                if (!position) return null;
                const relatedEdge = edgeForNode(node.nodeId);
                const active = node.nodeId === agent.nodeId || relatedEdge?.edgeId === selectedEdgeId;
                return (
                  <button
                    key={node.nodeId}
                    type="button"
                    disabled={!relatedEdge}
                    onClick={() => relatedEdge && onSelect(relatedEdge)}
                    title={`${NODE_LABEL[node.type]} · ${node.label}\n${node.subtitle ?? ""}`}
                    className={cn(
                      "absolute overflow-hidden rounded-xl border px-3 py-2.5 text-left transition",
                      graphRiskTone(node),
                      active && "ring-2 ring-teal-400/45",
                      relatedEdge && "hover:-translate-y-0.5 hover:brightness-110",
                    )}
                    style={{
                      left: position.x,
                      top: position.y,
                      width: GRAPH_NODE_WIDTH,
                      height: GRAPH_NODE_HEIGHT,
                    }}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-current/20 bg-black/20">
                        <NodeIcon type={node.type} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-semibold" title={node.label}>{node.label}</span>
                        <span className="mt-0.5 block truncate text-[10px] opacity-60">{NODE_LABEL[node.type]} · {node.subtitle ?? node.workspacePath ?? "运行时实体"}</span>
                      </span>
                    </div>
                    <div className="mt-2 flex items-center justify-between font-mono text-[10px]">
                      <span>{node.eventCount} 事件</span>
                      <span className={node.riskyEventCount > 0 ? "text-rose-200" : "opacity-60"}>{node.riskyEventCount} 风险</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {edges.length > GRAPH_EDGE_LIMIT ? (
        <div className="border-t border-white/8 px-4 py-2 text-right text-[10px] text-zinc-600">
          当前画布优先展示风险最高的 {GRAPH_EDGE_LIMIT} / {edges.length} 条关系，完整关系保留在下方列表
        </div>
      ) : null}
    </section>
  );
}

function RelationOverview({
  agent,
  edges,
  nodeById,
  selectedEdgeId,
  onSelect,
}: {
  agent?: AgentTopologyNode;
  edges: AgentTopologyEdge[];
  nodeById: Map<string, AgentTopologyNode>;
  selectedEdgeId?: string;
  onSelect: (edge: AgentTopologyEdge) => void;
}) {
  const grouped = useMemo(() => {
    const result = new Map<TopologyNodeType, Array<{ edge: AgentTopologyEdge; node?: AgentTopologyNode }>>();
    for (const edge of edges) {
      const source = nodeById.get(edge.sourceNodeId);
      const target = nodeById.get(edge.targetNodeId);
      const counterpart = source?.nodeId === agent?.nodeId ? target : source;
      const type = counterpart?.type ?? "security";
      const list = result.get(type) ?? [];
      list.push({ edge, node: counterpart });
      result.set(type, list);
    }
    return result;
  }, [agent?.nodeId, edges, nodeById]);
  const groupOrder: TopologyNodeType[] = ["workspace", "tool", "file", "network", "llm", "collector", "security", "agent"];

  return (
    <section className="min-w-0 rounded-[8px] border border-white/10 bg-[#111612]/92">
      <div className="flex min-h-12 items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <GitBranch className="size-4 shrink-0 text-teal-200" />
            <h2 className="truncate text-sm font-semibold text-zinc-100">
              {agent ? `${agent.label} 的关系概览` : "关系概览"}
            </h2>
          </div>
          {agent ? <p className="mt-1 truncate pl-6 text-[11px] text-zinc-600">{agent.workspacePath ?? agent.subtitle ?? "未归属 Workspace"}</p> : null}
        </div>
        <span className="shrink-0 text-xs text-zinc-500">{edges.length} 条关系</span>
      </div>
      {!agent ? (
        <div className="flex min-h-[360px] items-center justify-center px-6 text-center text-sm text-zinc-500">
          选择一个 Agent 查看关系
        </div>
      ) : edges.length === 0 ? (
        <div className="flex min-h-[360px] items-center justify-center px-6 text-center text-sm text-zinc-500">
          当前筛选范围内没有关系
        </div>
      ) : (
        <div className="max-h-[620px] space-y-4 overflow-y-auto p-4">
          {groupOrder.map((type) => {
            const items = grouped.get(type);
            if (!items?.length) return null;
            return (
              <div key={type}>
                <div className="mb-2 flex items-center gap-2">
                  <NodeIcon type={type} />
                  <h3 className="text-xs font-semibold text-zinc-300">{NODE_LABEL[type]}</h3>
                  <span className="text-[10px] text-zinc-600">{items.length}</span>
                </div>
                <div className="grid gap-2 md:grid-cols-2">
                  {items.map(({ edge, node }) => (
                    <button
                      key={edge.edgeId}
                      type="button"
                      onClick={() => onSelect(edge)}
                      className={cn(
                        "min-w-0 rounded-md border p-3 text-left transition",
                        edge.edgeId === selectedEdgeId
                          ? "border-teal-400/40 bg-teal-500/10"
                          : "border-white/10 bg-white/[0.025] hover:border-white/20 hover:bg-white/[0.05]",
                      )}
                    >
                      <div className="flex min-w-0 items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2">
                          <NodeIcon type={node?.type ?? "security"} />
                          <span className="truncate text-xs font-semibold text-zinc-100" title={node?.label}>{node?.label ?? "未知实体"}</span>
                        </div>
                        {edge.riskyEventCount > 0 ? <Pill className={toneBySeverity(edge.maxSeverity)}>{SEVERITY_LABEL[edge.maxSeverity]}</Pill> : null}
                      </div>
                      <p className="mt-1.5 truncate text-[11px] text-zinc-500" title={edge.sampleSubject}>
                        {EDGE_LABEL[edge.type]} · {edge.sampleSubject || "--"}
                      </p>
                      <div className="mt-2 flex items-center justify-between gap-3 text-[10px]">
                        <span className="text-rose-200">{edge.riskyEventCount} 风险</span>
                        <span className="text-zinc-600">{edge.eventCount} 总计 · {formatDate(edge.lastSeen)}</span>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
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
  eventScope,
}: {
  edge?: AgentTopologyEdge;
  source?: AgentTopologyNode;
  target?: AgentTopologyNode;
  timeType: SecurityTimeType;
  routeSourceId?: string;
  routeCollectorId?: string;
  routeWorkspacePath?: string;
  eventScope: TopologyEventScope;
}) {
  if (!edge) {
    return (
      <section className="rounded-[8px] border border-white/10 bg-[#111612]/92">
        <div className="flex min-h-[300px] items-center justify-center text-sm text-zinc-500">选择一条关系查看证据</div>
      </section>
    );
  }

  const eventQs = new URLSearchParams({ timeType, scope: eventScope });
  if (edge.sampleEventId) eventQs.set("eventId", edge.sampleEventId);
  const edgeAgentAssetId = source?.agentAssetId ?? target?.agentAssetId;
  const edgeAgentInstanceId = source?.agentInstanceId ?? target?.agentInstanceId;
  const edgeAgentId = source?.agentId ?? target?.agentId;
  const edgeWorkspacePath = source?.workspacePath ?? target?.workspacePath ?? routeWorkspacePath;
  const edgeCollectorId = source?.collectorId ?? target?.collectorId ?? routeCollectorId;
  if (edgeAgentAssetId) eventQs.set("agentAssetId", edgeAgentAssetId);
  else if (edgeAgentId) eventQs.set("agentId", edgeAgentId);
  if (edgeAgentInstanceId) eventQs.set("agentInstanceId", edgeAgentInstanceId);
  if (!edgeAgentAssetId && edgeWorkspacePath) eventQs.set("workspacePath", edgeWorkspacePath);
  if (edgeCollectorId) eventQs.set("collectorId", edgeCollectorId);
  if (routeSourceId) eventQs.set("sourceId", routeSourceId);
  const agentQs = new URLSearchParams();
  if (edgeAgentAssetId) agentQs.set("agentAssetId", edgeAgentAssetId);
  else if (edgeAgentId) agentQs.set("agentId", edgeAgentId);
  if (edgeAgentInstanceId) agentQs.set("selectedAgentInstanceId", edgeAgentInstanceId);
  if (!edgeAgentAssetId && edgeWorkspacePath) agentQs.set("workspacePath", edgeWorkspacePath);
  const collectorQs = new URLSearchParams();
  if (edgeCollectorId) collectorQs.set("collectorId", edgeCollectorId);
  const bundleQs = new URLSearchParams({ timeType });
  bundleQs.set("edgeId", edge.edgeId);
  if (edge.sampleEventId) bundleQs.set("eventId", edge.sampleEventId);
  if (edgeAgentId) bundleQs.set("agentId", edgeAgentId);
  if (edgeAgentInstanceId) bundleQs.set("agentInstanceId", edgeAgentInstanceId);
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
        <div className="grid gap-3 sm:grid-cols-2">
          <FieldValue label="来源实体" value={source?.label ?? edge.sourceNodeId} />
          <FieldValue label="目标实体" value={target?.label ?? edge.targetNodeId} />
          <FieldValue label="关系类型" value={EDGE_LABEL[edge.type]} />
          <FieldValue label="最近发生" value={formatDate(edge.lastSeen)} />
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <MetricTile label="总事件" value={edge.eventCount} tone="border-white/10 bg-white/[0.03] text-zinc-100" />
          <MetricTile label="风险事件" value={edge.riskyEventCount} tone="border-rose-400/25 bg-rose-500/10 text-rose-100" />
          <MetricTile label="最高等级" value={SEVERITY_LABEL[edge.maxSeverity]} tone="border-amber-400/25 bg-amber-500/10 text-amber-100" />
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

        <details className="rounded-md border border-white/10 bg-white/[0.02]">
          <summary className="cursor-pointer px-3 py-2 text-xs text-zinc-500 hover:text-zinc-300">技术详情</summary>
          <div className="grid gap-3 border-t border-white/8 px-3 py-3 sm:grid-cols-2">
            <FieldValue label="Edge ID" value={edge.edgeId} />
            <FieldValue label="Edge Type" value={edge.type} />
            <FieldValue label="Sample Event" value={edge.sampleEventId} />
            <FieldValue label="Source Node" value={edge.sourceNodeId} />
            <FieldValue label="Target Node" value={edge.targetNodeId} />
          </div>
        </details>

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
              查看事件
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
  const { filter: consoleTimeFilter, setTimeFilter } = useSecurityConsole();
  const [eventScope, setEventScope] = useState<TopologyEventScope>(
    searchParams.get("eventScope") === "raw" ? "raw" : "agent",
  );
  const timeType = consoleTimeFilter.timeType ?? "last_3h";
  const [scope, setScope] = useState<"all" | "risk">((searchParams.get("scope") as "all" | "risk") || "all");
  const [queryText, setQueryText] = useState(searchParams.get("q") ?? "");
  const [selectedEdgeId, setSelectedEdgeId] = useState(searchParams.get("edgeId") ?? "");
  const [selectedAgentNodeId, setSelectedAgentNodeId] = useState("");
  const scopedEventId = searchParams.get("eventId") ?? "";
  const scopedAgentAssetId = searchParams.get("agentAssetId") ?? "";
  const scopedAgentInstanceId = searchParams.get("agentInstanceId") ?? searchParams.get("selectedAgentInstanceId") ?? "";
  const scopedAgentId = searchParams.get("agentId") ?? "";
  const scopedWorkspacePath = searchParams.get("workspacePath") ?? "";
  const scopedCollectorId = searchParams.get("collectorId") ?? "";
  const scopedSourceId = searchParams.get("sourceId") ?? "";

  const query = useMemo<AgentTopologyQuery>(() => ({
    timeType,
    startTime: consoleTimeFilter.startTime,
    endTime: consoleTimeFilter.endTime,
    snapshotAsOf: consoleTimeFilter.snapshotAsOf,
    scope: eventScope,
    edgeId: clean(selectedEdgeId),
    eventId: clean(scopedEventId),
    agentAssetId: clean(scopedAgentAssetId),
    agentInstanceId: clean(scopedAgentInstanceId),
    agentId: clean(scopedAgentId),
    workspacePath: clean(scopedWorkspacePath),
    collectorId: clean(scopedCollectorId),
    sourceId: clean(scopedSourceId),
    includeBenign: scope === "all",
    q: clean(queryText),
    limit: 300,
  }), [consoleTimeFilter.endTime, consoleTimeFilter.snapshotAsOf, consoleTimeFilter.startTime, eventScope, queryText, scopedAgentAssetId, scopedAgentId, scopedAgentInstanceId, scopedCollectorId, scopedEventId, scopedSourceId, scopedWorkspacePath, scope, selectedEdgeId, timeType]);

  const { data, loading, refresh } = useRequest(() =>
    securityCenterApi.agentTopology({
      ...query,
      snapshotAsOf: liveSecuritySnapshotAsOf(
        timeType === "custom",
        consoleTimeFilter.snapshotAsOf,
      ),
    }), {
    refreshDeps: [query],
    pollingInterval: 10000,
    pollingWhenHidden: false,
  });

  const nodeById = useMemo(() => new Map((data?.nodes ?? []).map((node) => [node.nodeId, node])), [data]);
  const agents = useMemo(
    () => (data?.nodes ?? [])
      .filter((node) => node.type === "agent")
      .sort((a, b) => b.riskyEventCount - a.riskyEventCount || b.eventCount - a.eventCount || securityTimestampValue(b.lastSeen) - securityTimestampValue(a.lastSeen)),
    [data],
  );
  useEffect(() => {
    if (selectedAgentNodeId && agents.some((agent) => agent.nodeId === selectedAgentNodeId)) return;
    const scoped = scopedAgentAssetId
      ? agents.find((agent) =>
          agent.agentAssetId === scopedAgentAssetId &&
          (!scopedAgentInstanceId || agent.agentInstanceId === scopedAgentInstanceId)
        )
      : scopedAgentId
        ? agents.find((agent) =>
            agent.agentId === scopedAgentId &&
            (!scopedAgentInstanceId || agent.agentInstanceId === scopedAgentInstanceId) &&
            (!scopedWorkspacePath || agent.workspacePath === scopedWorkspacePath)
          )
      : undefined;
    setSelectedAgentNodeId(scoped?.nodeId ?? agents[0]?.nodeId ?? "");
  }, [agents, scopedAgentAssetId, scopedAgentId, scopedAgentInstanceId, scopedWorkspacePath, selectedAgentNodeId]);
  const selectedAgent = agents.find((agent) => agent.nodeId === selectedAgentNodeId);
  const agentEdges = useMemo(() => {
    const edges = data?.edges ?? [];
    if (!selectedAgentNodeId) return eventScope === "raw" ? edges : [];
    return edges.filter((edge) => edge.sourceNodeId === selectedAgentNodeId || edge.targetNodeId === selectedAgentNodeId);
  }, [data, eventScope, selectedAgentNodeId]);
  const selectedEdge = useMemo(() => {
    return agentEdges.find((edge) => edge.edgeId === selectedEdgeId) ?? agentEdges[0];
  }, [agentEdges, selectedEdgeId]);
  const relationCountByAgent = useMemo(() => {
    const counts = new Map<string, number>();
    for (const edge of data?.edges ?? []) {
      if (nodeById.get(edge.sourceNodeId)?.type === "agent") counts.set(edge.sourceNodeId, (counts.get(edge.sourceNodeId) ?? 0) + 1);
      if (nodeById.get(edge.targetNodeId)?.type === "agent") counts.set(edge.targetNodeId, (counts.get(edge.targetNodeId) ?? 0) + 1);
    }
    return counts;
  }, [data, nodeById]);
  const selectedRelationSummary = useMemo(() => {
    const counterpartNodes = agentEdges
      .flatMap((edge) => [nodeById.get(edge.sourceNodeId), nodeById.get(edge.targetNodeId)])
      .filter((node): node is AgentTopologyNode => Boolean(node && node.nodeId !== selectedAgentNodeId));
    const uniqueByType = (type: TopologyNodeType) => new Set(counterpartNodes.filter((node) => node.type === type).map((node) => node.nodeId)).size;
    return {
      riskyEdges: agentEdges.filter((edge) => edge.riskyEventCount > 0).length,
      networkTargets: uniqueByType("network"),
      fileAndLlmTargets: uniqueByType("file") + uniqueByType("llm"),
      latest: agentEdges.reduce((latest, edge) => Math.max(latest, securityTimestampValue(edge.lastSeen)), 0),
    };
  }, [agentEdges, nodeById, selectedAgentNodeId]);

  const selectEdge = (edge: AgentTopologyEdge) => {
    setSelectedEdgeId(edge.edgeId);
    const next = new URLSearchParams(searchParams);
    next.set("timeType", timeType);
    next.set("eventScope", eventScope);
    next.set("scope", scope);
    next.set("edgeId", edge.edgeId);
    if (clean(queryText)) next.set("q", queryText.trim());
    else next.delete("q");
    setSearchParams(next);
  };

  const selectAgent = (agent: AgentTopologyNode) => {
    setSelectedAgentNodeId(agent.nodeId);
    const nextEdge = (data?.edges ?? []).find((edge) => edge.sourceNodeId === agent.nodeId || edge.targetNodeId === agent.nodeId);
    setSelectedEdgeId(nextEdge?.edgeId ?? "");
  };

  const changeEventScope = (nextScope: TopologyEventScope) => {
    setEventScope(nextScope);
    setSelectedAgentNodeId("");
    setSelectedEdgeId("");
    const next = new URLSearchParams(searchParams);
    next.set("eventScope", nextScope);
    next.delete("edgeId");
    next.delete("eventId");
    setSearchParams(next);
  };

  const clearFilters = () => {
    setScope("all");
    setQueryText("");
    setSelectedAgentNodeId("");
    setSelectedEdgeId("");
    setSearchParams({ eventScope });
  };

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-[#0b0f0c] text-zinc-100">
      <header className="shrink-0 border-b border-white/10 bg-[#0b0f0c] px-4 py-3">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <GitBranch className="size-5 shrink-0 text-teal-300" />
                <h1 className="truncate text-lg font-semibold tracking-normal text-zinc-50">AnySentry 安全拓扑</h1>
              </div>
              <p className="mt-0.5 truncate text-xs text-zinc-500">Agent 运行时实体关系、行为流向与风险证据</p>
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <TopologyEventScopeTabs value={eventScope} onChange={changeEventScope} />
            <AdminTokenControl compact />
            <Clock3 className="size-3.5" />
            <span>{data?.updateTime ? formatDate(data.updateTime) : "等待刷新"}</span>
          </div>
        </div>

        <div className="mt-3 grid gap-2 md:grid-cols-[120px_130px_minmax(180px,1fr)_auto_auto]">
          <Select value={timeType} onValueChange={(next) => setTimeFilter({ timeType: next as SecurityTimeType })}>
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
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <MetricTile label={eventScope === "agent" ? "Agent 相关" : "观测主体"} value={agents.length} tone="border-teal-400/25 bg-teal-500/10 text-teal-100" />
            <MetricTile label="当前 Agent 风险关系" value={selectedRelationSummary.riskyEdges} tone="border-rose-400/25 bg-rose-500/10 text-rose-100" />
            <MetricTile label="当前 Agent 网络目标" value={selectedRelationSummary.networkTargets} tone="border-orange-400/25 bg-orange-500/10 text-orange-100" />
            <MetricTile label="当前 Agent 文件/LLM" value={selectedRelationSummary.fileAndLlmTargets} tone="border-violet-400/25 bg-violet-500/10 text-violet-100" />
            <MetricTile
              label="最近关系事件"
              value={selectedRelationSummary.latest ? formatSecurityDateTime(selectedRelationSummary.latest, "HH:mm:ss") : "--"}
              tone="border-white/10 bg-white/[0.03] text-zinc-100"
            />
          </div>

          <SecurityTopologyCanvas
            agent={selectedAgent}
            edges={agentEdges}
            nodeById={nodeById}
            selectedEdgeId={selectedEdge?.edgeId}
            onSelect={selectEdge}
          />

          <div className="grid items-start gap-4 xl:grid-cols-[280px_minmax(420px,1fr)_minmax(360px,0.85fr)]">
            <section className="rounded-[8px] border border-white/10 bg-[#111612]/92">
              <div className="flex min-h-12 items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
                <div className="flex items-center gap-2">
                  <Bot className="size-4 text-teal-200" />
                  <h2 className="text-sm font-semibold text-zinc-100">{eventScope === "agent" ? "Agent 相关" : "观测主体"}</h2>
                </div>
                <span className="text-xs text-zinc-500">{agents.length} 个</span>
              </div>
              {loading && !data ? (
                <div className="flex min-h-40 items-center justify-center text-sm text-zinc-500">
                  <LoaderCircle className="mr-2 size-4 animate-spin" />
                  加载拓扑...
                </div>
              ) : agents.length === 0 ? (
                <div className="flex min-h-40 items-center justify-center px-4 text-center text-sm text-zinc-500">
                  当前筛选范围内没有{eventScope === "agent" ? "Agent 相关" : "观测主体"}
                </div>
              ) : (
                <div className="max-h-[620px] space-y-2 overflow-y-auto p-3">
                  {agents.map((agent) => (
                    <AgentListItem
                      key={agent.nodeId}
                      node={agent}
                      active={agent.nodeId === selectedAgentNodeId}
                      relationCount={relationCountByAgent.get(agent.nodeId) ?? 0}
                      onSelect={() => selectAgent(agent)}
                    />
                  ))}
                </div>
              )}
            </section>

            <RelationOverview
              agent={selectedAgent}
              edges={agentEdges}
              nodeById={nodeById}
              selectedEdgeId={selectedEdge?.edgeId}
              onSelect={selectEdge}
            />

            <EdgeDetail
              edge={selectedEdge}
              source={selectedEdge ? nodeById.get(selectedEdge.sourceNodeId) : undefined}
              target={selectedEdge ? nodeById.get(selectedEdge.targetNodeId) : undefined}
              timeType={timeType}
              routeSourceId={scopedSourceId}
              routeCollectorId={scopedCollectorId}
              routeWorkspacePath={scopedWorkspacePath}
              eventScope={eventScope}
            />
          </div>

          <section className="rounded-[8px] border border-white/10 bg-[#111612]/92">
            <div className="flex min-h-12 items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
              <div className="flex items-center gap-2">
                <Clock3 className="size-4 text-teal-200" />
                <div>
                  <h2 className="text-sm font-semibold text-zinc-100">关系事件时间线</h2>
                  <p className="mt-0.5 text-[11px] text-zinc-600">
                    {selectedAgent ? `${selectedAgent.label} 在当前时间范围内的关系变化` : "选择 Agent 后查看时间线"}
                  </p>
                </div>
              </div>
              <span className="text-xs text-zinc-500">{agentEdges.length} 条</span>
            </div>
            {agentEdges.length === 0 ? (
              <div className="flex min-h-32 items-center justify-center text-sm text-zinc-500">暂无关系事件</div>
            ) : (
              <div className="max-h-[420px] overflow-y-auto">
                {[...agentEdges]
                  .sort((a, b) => securityTimestampValue(b.lastSeen) - securityTimestampValue(a.lastSeen))
                  .map((edge) => (
                    <RelationTimelineRow
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
        </div>
      </main>
    </div>
  );
}
