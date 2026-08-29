import { useDebounce, useRequest } from "ahooks";
import dayjs from "dayjs";
import {
  AlertTriangle,
  ArrowLeft,
  Bot,
  Braces,
  Check,
  ChevronRight,
  CircleCheck,
  CircleDashed,
  Clock3,
  Copy,
  FileJson,
  Gauge,
  ListTree,
  LoaderCircle,
  MessageSquareReply,
  MessageSquareText,
  RefreshCw,
  RotateCw,
  Search,
  Send,
  ShieldCheck,
  TerminalSquare,
  Wrench,
  X,
} from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, useSearchParams } from "react-router-dom";

import { useSecurityConsole } from "@/components/custom/security-console-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { liveSecuritySnapshotAsOf } from "@/lib/date-time";
import {
  type AgentClassification,
  type AgentConversationCoverageStatus,
  type AgentConversationEvent,
  type AgentConversationEventKind,
  type AgentConversationSummary,
  type AgentInteractionRecord,
  type LogicalAgentConversationDirectoryItem,
  securityCenterApi,
} from "@/lib/api/security-center";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const COVERAGE_OPTIONS: Array<{ value: AgentConversationCoverageStatus | "all"; label: string }> = [
  { value: "all", label: "全部覆盖" },
  { value: "complete", label: "正文完整" },
  { value: "partial", label: "正文部分" },
  { value: "no_final_response", label: "响应未结束" },
  { value: "attach_pending", label: "等待 Attach" },
  { value: "unsupported_tls_profile", label: "TLS Profile 不支持" },
  { value: "unsupported_protocol", label: "协议不支持" },
  { value: "discovery_pending", label: "正在发现 TLS" },
  { value: "metadata_only", label: "仅连接元数据" },
  { value: "transport_unparsed", label: "传输待解析" },
  { value: "template_unparsed", label: "模板待解析" },
  { value: "budget_limited", label: "采集预算受限" },
  { value: "asset_only", label: "仅资产证据" },
  { value: "no_activity", label: "无调用活动" },
];

const CLASSIFICATION_OPTIONS: Array<{ value: AgentClassification | "all"; label: string }> = [
  { value: "all", label: "全部身份" },
  { value: "confirmed_agent", label: "已确认 Agent" },
  { value: "probable_agent", label: "候选 Agent" },
];

const COVERAGE_LABEL: Record<AgentConversationCoverageStatus, string> = {
  complete: "完整",
  partial: "部分",
  attach_pending: "等待 Attach",
  unsupported_tls_profile: "Profile 不支持",
  unsupported_protocol: "协议不支持",
  discovery_pending: "正在发现",
  metadata_only: "仅元数据",
  transport_unparsed: "传输待解析",
  template_unparsed: "模板待解析",
  budget_limited: "预算受限",
  no_final_response: "响应未结束",
  asset_only: "仅资产",
  no_activity: "无活动",
};

const CLASSIFICATION_LABEL: Record<AgentClassification, string> = {
  confirmed_agent: "已确认",
  probable_agent: "候选",
  unknown: "未知",
  non_agent: "已排除",
};

const EVENT_LABEL: Record<AgentConversationEventKind, string> = {
  tool_result: "工具结果",
  model_request: "发送给 LLM",
  model_response: "LLM 回复",
  tool_call: "工具指令",
  external_tool: "外部工具",
  retry: "重试",
  error: "异常",
};

function clean(value: string) {
  return value.trim() || undefined;
}

function nsDate(value?: string, format = "MM-DD HH:mm:ss.SSS") {
  if (!value || !/^\d+$/u.test(value)) return "--";
  try {
    return dayjs(Number(BigInt(value) / 1_000_000n)).format(format);
  } catch {
    return "--";
  }
}

function duration(value?: string) {
  if (!value || !/^\d+$/u.test(value)) return "--";
  try {
    const milliseconds = Number(BigInt(value) / 1_000_000n);
    if (milliseconds < 1) return `${Number(BigInt(value) / 1_000n)} μs`;
    if (milliseconds < 1_000) return `${milliseconds} ms`;
    return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 2 : 1)} s`;
  } catch {
    return "--";
  }
}

function safeJson(value: unknown) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value ?? "");
  }
}

function browserPreview(value: string, max = 200_000) {
  return value.length > max
    ? `${value.slice(0, max)}\n\n[浏览器预览已在 ${max.toLocaleString()} 字符处折叠；复制操作仍使用完整内容]`
    : value;
}

function Pill({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn(
      "inline-flex min-h-5 items-center rounded border px-1.5 py-0.5 text-[10px] font-medium leading-none",
      className,
    )}>
      {children}
    </span>
  );
}

function coverageClass(status: AgentConversationCoverageStatus) {
  if (status === "complete") return "border-teal-400/25 bg-teal-500/10 text-teal-100";
  if (status === "partial" || status === "no_final_response" || status === "attach_pending" || status === "discovery_pending" || status === "metadata_only") {
    return "border-amber-400/25 bg-amber-500/10 text-amber-100";
  }
  if (status === "unsupported_tls_profile" || status === "unsupported_protocol" || status === "transport_unparsed" || status === "template_unparsed" || status === "budget_limited") {
    return "border-rose-400/25 bg-rose-500/10 text-rose-100";
  }
  return "border-zinc-500/25 bg-zinc-500/10 text-zinc-300";
}

function CoverageBadge({ status }: { status: AgentConversationCoverageStatus }) {
  const Icon = status === "complete"
    ? CircleCheck
    : status === "asset_only" || status === "no_activity"
      ? CircleDashed
      : AlertTriangle;
  return (
    <Pill className={coverageClass(status)}>
      <Icon className="mr-1 size-3" aria-hidden="true" />
      {COVERAGE_LABEL[status]}
    </Pill>
  );
}

function eventIcon(kind: AgentConversationEventKind) {
  if (kind === "model_request") return Send;
  if (kind === "model_response") return MessageSquareReply;
  if (kind === "tool_call" || kind === "external_tool") return Wrench;
  if (kind === "tool_result") return TerminalSquare;
  if (kind === "retry") return RotateCw;
  return AlertTriangle;
}

function eventTone(kind: AgentConversationEventKind) {
  if (kind === "model_request") return "border-sky-400/20 bg-sky-500/[0.055] text-sky-100";
  if (kind === "model_response") return "border-teal-400/20 bg-teal-500/[0.055] text-teal-100";
  if (kind === "tool_call" || kind === "external_tool") return "border-violet-400/20 bg-violet-500/[0.055] text-violet-100";
  if (kind === "tool_result") return "border-cyan-400/20 bg-cyan-500/[0.045] text-cyan-100";
  return "border-amber-400/20 bg-amber-500/[0.055] text-amber-100";
}

function LogicalAgentDirectoryRail({
  items,
  selectedLogicalAgentId,
  loading,
  error,
  onSelect,
}: {
  items: LogicalAgentConversationDirectoryItem[];
  selectedLogicalAgentId?: string;
  loading: boolean;
  error?: Error;
  onSelect: (item: LogicalAgentConversationDirectoryItem) => void;
}) {
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const ordered = useMemo(() => [
    ...items.filter((item) => item.lifecycleState !== "historical"),
    ...items.filter((item) => item.lifecycleState === "historical"),
  ], [items]);
  const moveSelection = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? ordered.length - 1
        : Math.min(ordered.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)));
    const next = ordered[nextIndex];
    if (!next) return;
    onSelect(next);
    window.requestAnimationFrame(() => refs.current.get(next.logicalAgentId)?.focus());
  };
  const running = ordered.filter((item) => item.lifecycleState !== "historical");
  const history = ordered.filter((item) => item.lifecycleState === "historical");
  const renderSection = (
    title: string,
    sectionItems: LogicalAgentConversationDirectoryItem[],
    startIndex: number,
  ) => (
    <div>
      <div className="sticky top-0 z-10 flex h-9 items-center justify-between border-y border-white/8 bg-[#0d120f]/95 px-3 backdrop-blur">
        <span className="text-[11px] font-semibold text-zinc-300">{title}</span>
        <span className="font-mono text-[10px] text-zinc-500">{sectionItems.length}</span>
      </div>
      <div className="divide-y divide-white/8">
        {sectionItems.map((item, sectionIndex) => {
          const index = startIndex + sectionIndex;
          const active = item.logicalAgentId === selectedLogicalAgentId;
          const runningState = item.lifecycleState === "running";
          return (
            <button
              key={item.logicalAgentId}
              ref={(node) => {
                if (node) refs.current.set(item.logicalAgentId, node);
                else refs.current.delete(item.logicalAgentId);
              }}
              type="button"
              role="option"
              aria-selected={active}
              tabIndex={active || (!selectedLogicalAgentId && index === 0) ? 0 : -1}
              onKeyDown={(event) => moveSelection(event, index)}
              onClick={() => onSelect(item)}
              className={cn(
                "min-h-[108px] w-full cursor-pointer px-3 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-400/70",
                active ? "bg-teal-400/[0.08]" : "hover:bg-white/[0.035]",
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span className={cn(
                    "flex size-8 shrink-0 items-center justify-center rounded border",
                    runningState
                      ? "border-teal-400/25 bg-teal-500/10 text-teal-200"
                      : "border-zinc-500/20 bg-zinc-500/10 text-zinc-400",
                  )}>
                    <Bot className="size-4" aria-hidden="true" />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-xs font-semibold text-zinc-100">{item.displayName}</p>
                    <p className="mt-0.5 truncate font-mono text-[10px] text-zinc-500">{item.product} · {item.environment}</p>
                  </div>
                </div>
                <CoverageBadge status={item.coverage.status} />
              </div>
              <p className="mt-2 truncate text-[11px] text-zinc-400" title={item.workspacePath}>{item.workspacePath}</p>
              <div className="mt-2 flex items-center justify-between gap-2 text-[10px] text-zinc-500">
                <span className="flex min-w-0 items-center gap-1.5 truncate">
                  <span className={cn("size-1.5 shrink-0 rounded-full", runningState ? "bg-teal-300" : item.lifecycleState === "unobserved" ? "bg-amber-300" : "bg-zinc-600")} />
                  {runningState ? "运行中" : item.lifecycleState === "unobserved" ? "连接待确认" : "历史"}
                  <span>·</span>
                  {item.activeInstanceCount}/{item.totalInstanceCount} 实例
                  <span>·</span>
                  {item.conversationCount} 会话
                </span>
                <time className="shrink-0 font-mono">{nsDate(item.lastActivityAtUnixNs, "HH:mm:ss")}</time>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );

  return (
    <section className="h-full min-h-0 overflow-hidden border-r border-white/10 bg-[#0d120f]" aria-label="逻辑 Agent 目录">
      <div className="flex h-12 items-center justify-between border-b border-white/10 px-3">
        <div className="flex items-center gap-2">
          <ListTree className="size-4 text-zinc-400" aria-hidden="true" />
          <h2 className="text-xs font-semibold text-zinc-200">Agent 目录</h2>
        </div>
        <span className="font-mono text-[10px] text-zinc-500">{items.length}</span>
      </div>
      <div className="h-[calc(100%-3rem)] overflow-y-auto" role="listbox" aria-label="运行中与历史 Agent">
        {loading && items.length === 0 ? (
          <div className="space-y-2 p-3" aria-label="正在加载会话">
            {[0, 1, 2, 3, 4].map((index) => (
              <div key={index} className="h-[104px] animate-pulse rounded border border-white/5 bg-white/[0.025]" />
            ))}
          </div>
        ) : error ? (
          <div className="m-3 rounded border border-rose-400/20 bg-rose-500/[0.06] p-3 text-xs leading-5 text-rose-100">
            <p className="font-semibold">会话列表加载失败</p>
            <p className="mt-1 text-rose-200/70">{error.message}</p>
          </div>
        ) : items.length === 0 ? (
          <div className="flex min-h-56 flex-col items-center justify-center px-5 text-center">
            <MessageSquareText className="size-7 text-zinc-600" aria-hidden="true" />
            <p className="mt-3 text-sm font-medium text-zinc-300">当前筛选下没有 Agent 会话或资产</p>
            <p className="mt-1 text-xs leading-5 text-zinc-500">扩大时间范围或清除覆盖状态筛选后重试。</p>
          </div>
        ) : (
          <>
            {renderSection("运行中", running, 0)}
            {renderSection("历史 Agent", history, running.length)}
          </>
        )}
      </div>
    </section>
  );
}

function AssetOnlyState({ conversation }: { conversation: AgentConversationSummary }) {
  const observedPlaintext = ["metadata_only", "transport_unparsed", "template_unparsed", "budget_limited"]
    .includes(conversation.coverage.status);
  const agentParams = new URLSearchParams({
    timeType: "last_30d",
    selectedAgentAssetId: conversation.agentAssetId,
    assetRange: "all",
  });
  const eventParams = new URLSearchParams({
    timeType: "last_30d",
    agentAssetId: conversation.agentAssetId,
    scope: "agent",
  });
  return (
    <div className="flex min-h-[420px] flex-col items-center justify-center px-6 text-center">
      <span className="flex size-12 items-center justify-center rounded-lg border border-amber-400/20 bg-amber-500/[0.07] text-amber-200">
        <AlertTriangle className="size-5" aria-hidden="true" />
      </span>
      <h3 className="mt-4 text-sm font-semibold text-zinc-100">
        {observedPlaintext ? "已观察到 Agent 明文流，等待进一步解析" : "Agent 资产已识别，但没有模型明文"}
      </h3>
      <p className="mt-2 max-w-lg text-xs leading-5 text-zinc-500">
        {observedPlaintext
          ? "采集层已经看到 TLS 加密前/解密后的字节，但当前 transport 或 wire template 尚未完成。原始证据保持有界且不伪造模型会话。"
          : "当前窗口只有资产或行为证据。可能尚未发生 TLS 调用、候选函数仍在验证、采集预算受限，或确实没有模型调用。"}
      </p>
      <div className="mt-3 flex flex-wrap justify-center gap-2">
        {conversation.coverage.reasons.map((reason) => (
          <Pill key={reason} className="border-amber-400/20 bg-amber-500/[0.05] text-amber-100/80">{reason}</Pill>
        ))}
      </div>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        <Button asChild variant="secondary" size="sm" className="h-11 border border-white/10 bg-white/5 text-zinc-100 sm:h-9">
          <Link to={`/agents?${agentParams.toString()}`}><Bot className="size-3.5" />查看 Agent 资产</Link>
        </Button>
        <Button asChild variant="secondary" size="sm" className="h-11 border border-white/10 bg-white/5 text-zinc-100 sm:h-9">
          <Link to={`/events?${eventParams.toString()}`}><Gauge className="size-3.5" />查看行为与 Egress</Link>
        </Button>
      </div>
    </div>
  );
}

function Timeline({
  agent,
  conversation,
  events,
  selectedEventId,
  loading,
  error,
  onBack,
  onSelect,
  onSelectConversation,
}: {
  agent?: LogicalAgentConversationDirectoryItem;
  conversation?: AgentConversationSummary;
  events: AgentConversationEvent[];
  selectedEventId?: string;
  loading: boolean;
  error?: Error;
  onBack: () => void;
  onSelect: (event: AgentConversationEvent) => void;
  onSelectConversation: (conversation: AgentConversationSummary) => void;
}) {
  const turns = useMemo(() => {
    const grouped = new Map<string, AgentConversationEvent[]>();
    for (const event of events) {
      const list = grouped.get(event.turnId) ?? [];
      list.push(event);
      grouped.set(event.turnId, list);
    }
    return [...grouped.entries()];
  }, [events]);

  if (!conversation) {
    if (agent) {
      return (
        <section className="h-full min-h-0 bg-[#0b0f0c]" aria-label="运行中 Agent 诊断">
          <div className="flex min-h-16 items-center gap-3 border-b border-white/10 px-3 py-2 sm:px-4">
            <Button type="button" variant="ghost" size="icon" onClick={onBack} aria-label="返回 Agent 目录" className="size-11 text-zinc-400 hover:bg-white/5 hover:text-zinc-100 md:hidden">
              <ArrowLeft className="size-4" />
            </Button>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h2 className="truncate text-sm font-semibold text-zinc-100">{agent.displayName}</h2>
                <Pill className="border-teal-400/20 bg-teal-500/[0.07] text-teal-100">
                  {agent.lifecycleState === "running" ? "运行中" : "连接待确认"}
                </Pill>
              </div>
              <p className="mt-1 truncate font-mono text-[10px] text-zinc-500">{agent.workspacePath}</p>
            </div>
            <CoverageBadge status={agent.coverage.status} />
          </div>
          <div className="flex h-[calc(100%-4rem)] items-center justify-center px-6 text-center">
            <div className="max-w-lg">
              <CircleDashed className="mx-auto size-9 text-zinc-600" aria-hidden="true" />
              <h3 className="mt-4 text-sm font-semibold text-zinc-100">Agent 正在运行，尚无可展示的模型会话</h3>
              <p className="mt-2 text-xs leading-5 text-zinc-500">
                当前目录由 runtime snapshot 直接确认，不会为了填充页面伪造会话。发生模型调用后，会话会自动出现在这里；若只看到明文 metadata，覆盖状态会明确显示 transport 或 template 待解析。
              </p>
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                <Pill className="border-white/10 bg-white/[0.035] text-zinc-300">{agent.activeInstanceCount} 个活动实例</Pill>
                <Pill className="border-white/10 bg-white/[0.035] text-zinc-300">{agent.product}</Pill>
                <Pill className="border-white/10 bg-white/[0.035] text-zinc-300">{agent.environment}</Pill>
              </div>
            </div>
          </div>
        </section>
      );
    }
    return (
      <section className="flex h-full min-h-0 items-center justify-center bg-[#0b0f0c] px-6 text-center">
        <div>
          <MessageSquareText className="mx-auto size-8 text-zinc-700" aria-hidden="true" />
          <p className="mt-3 text-sm text-zinc-300">选择左侧会话查看 Agent 的模型与工具时间线</p>
        </div>
      </section>
    );
  }

  return (
    <section className="h-full min-h-0 overflow-hidden bg-[#0b0f0c]" aria-label="Agent 对话时间线">
      <div className="flex min-h-16 items-center gap-3 border-b border-white/10 px-3 py-2 sm:px-4">
        <Button type="button" variant="ghost" size="icon" onClick={onBack} aria-label="返回会话列表" className="size-11 text-zinc-400 hover:bg-white/5 hover:text-zinc-100 md:hidden">
          <ArrowLeft className="size-4" />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-sm font-semibold text-zinc-100">{agent?.displayName ?? conversation.displayName}</h2>
            <Pill className={conversation.classification === "confirmed_agent"
              ? "border-teal-400/20 bg-teal-500/[0.07] text-teal-100"
              : "border-amber-400/20 bg-amber-500/[0.07] text-amber-100"}>
              {CLASSIFICATION_LABEL[conversation.classification]}
            </Pill>
            <Pill className="border-white/10 bg-white/[0.035] text-zinc-400">{conversation.idSource}</Pill>
          </div>
          <p className="mt-1 truncate font-mono text-[10px] text-zinc-500" title={conversation.workspacePath}>
            {conversation.workspacePath} · {conversation.turnCount} 轮 · {conversation.modelCallCount} 次模型调用
          </p>
        </div>
        {agent && agent.conversations.length > 1 ? (
          <Select value={conversation.conversationId} onValueChange={(value) => {
            const next = agent.conversations.find((item) => item.conversationId === value);
            if (next) onSelectConversation(next);
          }}>
            <SelectTrigger className="hidden h-9 w-[220px] border-white/10 bg-white/[0.035] text-xs text-zinc-200 lg:flex" aria-label="切换当前 Agent 的会话">
              <SelectValue placeholder="选择会话" />
            </SelectTrigger>
            <SelectContent>
              {agent.conversations.map((item, index) => (
                <SelectItem key={item.conversationId} value={item.conversationId}>
                  {`会话 ${agent.conversations.length - index} · ${nsDate(item.startedAtUnixNs, "MM-DD HH:mm")} · ${item.firstPromptPreview ?? "无正文"}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        <CoverageBadge status={conversation.coverage.status} />
      </div>

      <div className="h-[calc(100%-4rem)] overflow-y-auto px-3 py-4 sm:px-5">
        {!conversation.hasContent ? (
          <AssetOnlyState conversation={conversation} />
        ) : loading && events.length === 0 ? (
          <div className="mx-auto max-w-3xl space-y-4" aria-label="正在加载时间线">
            {[0, 1, 2, 3].map((index) => <div key={index} className="h-24 animate-pulse rounded border border-white/5 bg-white/[0.025]" />)}
          </div>
        ) : error ? (
          <div className="mx-auto max-w-2xl rounded border border-rose-400/20 bg-rose-500/[0.06] p-4 text-xs leading-5 text-rose-100">
            <p className="font-semibold">会话时间线加载失败</p>
            <p className="mt-1 text-rose-200/70">{error.message}</p>
          </div>
        ) : turns.length === 0 ? (
          <div className="py-20 text-center text-sm text-zinc-500">该会话没有可组织的模型或工具事件。</div>
        ) : (
          <div className="mx-auto max-w-4xl space-y-5">
            {turns.map(([turnId, turnEvents], turnIndex) => (
              <section key={turnId} aria-labelledby={`${turnId}-heading`}>
                <div className="mb-2 flex items-center gap-3">
                  <span className="h-px flex-1 bg-white/8" />
                  <h3 id={`${turnId}-heading`} className="font-mono text-[10px] uppercase tracking-[0.14em] text-zinc-600">第 {turnIndex + 1} 轮</h3>
                  <span className="h-px flex-1 bg-white/8" />
                </div>
                <div className="relative space-y-2 before:absolute before:bottom-5 before:left-[17px] before:top-5 before:w-px before:bg-white/10">
                  {turnEvents.map((event) => {
                    const Icon = eventIcon(event.kind);
                    const active = selectedEventId === event.eventId;
                    return (
                      <button
                        key={event.eventId}
                        type="button"
                        onClick={() => onSelect(event)}
                        className={cn(
                          "relative flex min-h-[76px] w-full cursor-pointer gap-3 rounded border px-3 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-400/70",
                          eventTone(event.kind),
                          active ? "border-teal-300/45 bg-teal-400/[0.09]" : "hover:border-white/20 hover:bg-white/[0.045]",
                        )}
                      >
                        <span className="relative z-10 flex size-9 shrink-0 items-center justify-center rounded-full border border-current/20 bg-[#0b0f0c]">
                          <Icon className="size-4" aria-hidden="true" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <span className="text-xs font-semibold">{event.title}</span>
                            <Pill className="border-current/15 bg-black/10 text-current/80">{EVENT_LABEL[event.kind]}</Pill>
                            {event.attemptNumber && event.attemptNumber > 1 ? <Pill className="border-amber-400/20 bg-amber-500/10 text-amber-100">Attempt {event.attemptNumber}</Pill> : null}
                            {event.isError ? <Pill className="border-rose-400/25 bg-rose-500/10 text-rose-100">失败</Pill> : null}
                          </span>
                          {event.contentPreview ? (
                            <span className="mt-1.5 line-clamp-3 block whitespace-pre-wrap break-words text-xs leading-5 text-zinc-300">{event.contentPreview}</span>
                          ) : (
                            <span className="mt-1.5 block text-xs text-zinc-500">选择查看结构化内容和原始证据</span>
                          )}
                          <span className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] text-zinc-500">
                            <time>{nsDate(event.atUnixNs)}</time>
                            {event.model ? <span>{event.model}</span> : null}
                            {event.durationNs ? <span>{duration(event.durationNs)}</span> : null}
                            <span>{event.correlationQuality}</span>
                          </span>
                        </span>
                        <ChevronRight className="mt-2 size-4 shrink-0 text-zinc-600" aria-hidden="true" />
                      </button>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function CopyAction({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  };
  return (
    <Button type="button" variant="ghost" size="sm" onClick={() => void copy()} className="h-9 text-zinc-400 hover:bg-white/5 hover:text-zinc-100" aria-label={label}>
      {copied ? <Check className="size-3.5 text-teal-300" /> : <Copy className="size-3.5" />}
      {copied ? "已复制" : "复制"}
    </Button>
  );
}

function EvidenceField({ label, value }: { label: string; value?: ReactNode }) {
  return (
    <div className="min-w-0 border-b border-white/8 py-2 last:border-b-0">
      <dt className="text-[10px] uppercase tracking-[0.08em] text-zinc-600">{label}</dt>
      <dd className="mt-1 break-all font-mono text-[11px] leading-5 text-zinc-300">{value ?? "--"}</dd>
    </div>
  );
}

function InteractionInspector({
  event,
  interaction,
  loading,
  onClose,
}: {
  event?: AgentConversationEvent;
  interaction?: AgentInteractionRecord;
  loading: boolean;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"structured" | "raw" | "evidence">("structured");
  useEffect(() => setTab("structured"), [event?.eventId]);

  const structured = useMemo(() => {
    if (!event) return "";
    if (event.kind === "tool_call") return safeJson(event.arguments);
    if (event.kind === "tool_result" || event.kind === "external_tool") return safeJson(event.result ?? event.arguments);
    if (event.kind === "model_request") {
      return safeJson(interaction?.request.messages?.length
        ? interaction.request.messages
        : interaction?.request.structured ?? event.contentPreview);
    }
    if (event.kind === "model_response") return safeJson(interaction?.response.structured ?? interaction?.response.text ?? event.contentPreview);
    return event.contentPreview ?? "";
  }, [event, interaction]);

  if (!event) {
    return (
      <aside className="hidden h-full min-h-0 border-l border-white/10 bg-[#0d120f] xl:flex xl:items-center xl:justify-center" aria-label="事件检查器">
        <div className="px-6 text-center">
          <FileJson className="mx-auto size-7 text-zinc-700" aria-hidden="true" />
          <p className="mt-3 text-xs leading-5 text-zinc-500">选择一条模型或工具事件，查看完整正文、时间和采集证据。</p>
        </div>
      </aside>
    );
  }

  return (
    <>
      <button type="button" aria-label="关闭事件检查器" onClick={onClose} className="fixed inset-0 z-40 cursor-default bg-black/60 xl:hidden" />
      <aside className="fixed inset-x-3 bottom-3 top-20 z-50 min-h-0 overflow-hidden rounded-md border border-white/15 bg-[#0d120f] shadow-2xl xl:static xl:z-auto xl:h-full xl:rounded-none xl:border-y-0 xl:border-r-0 xl:shadow-none" aria-label="事件检查器">
        <div className="flex h-14 items-center gap-2 border-b border-white/10 px-3">
          <FileJson className="size-4 shrink-0 text-teal-300" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-xs font-semibold text-zinc-100">{event.title}</h2>
            <p className="mt-0.5 truncate font-mono text-[10px] text-zinc-600">#{event.sequence} · {event.eventId}</p>
          </div>
          <Button type="button" variant="ghost" size="icon" onClick={onClose} aria-label="关闭事件检查器" className="size-11 text-zinc-400 hover:bg-white/5 hover:text-zinc-100 xl:size-9">
            <X className="size-4" />
          </Button>
        </div>

        <div className="flex h-11 items-center border-b border-white/10 px-2" role="tablist" aria-label="检查器视图">
          {([
            ["structured", "结构化", Braces],
            ["raw", "原始", FileJson],
            ["evidence", "证据", ShieldCheck],
          ] as const).map(([value, label, Icon]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              onClick={() => setTab(value)}
              className={cn(
                "flex h-9 min-w-24 cursor-pointer items-center justify-center gap-1.5 border-b text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-400/70",
                tab === value ? "border-teal-300 text-teal-100" : "border-transparent text-zinc-500 hover:text-zinc-200",
              )}
            >
              <Icon className="size-3.5" aria-hidden="true" />{label}
            </button>
          ))}
        </div>

        <div className="h-[calc(100%-6.25rem)] overflow-y-auto p-3">
          {loading && !interaction ? (
            <div className="flex min-h-40 items-center justify-center gap-2 text-xs text-zinc-500"><LoaderCircle className="size-4 animate-spin" />正在读取完整 Interaction</div>
          ) : tab === "structured" ? (
            <div>
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="flex flex-wrap gap-2"><Pill className={eventTone(event.kind)}>{EVENT_LABEL[event.kind]}</Pill><Pill className="border-white/10 bg-white/[0.035] text-zinc-400">{event.completeness}</Pill></div>
                {structured ? <CopyAction value={structured} label="复制结构化内容" /> : null}
              </div>
              <pre className="max-h-[calc(100dvh-14rem)] overflow-auto whitespace-pre-wrap break-words rounded border border-white/8 bg-black/20 p-3 font-mono text-[11px] leading-5 text-zinc-300">{browserPreview(structured || "该事件没有结构化正文。")}</pre>
              {event.kind === "tool_result" && event.parentEventId ? <p className="mt-3 text-[11px] leading-5 text-zinc-500">该时间表示工具结果重新进入模型请求的可见边界；它不是 Agent 框架内部的精确执行结束时间。</p> : null}
            </div>
          ) : tab === "raw" ? (
            <div className="space-y-3">
              {!interaction ? <p className="py-12 text-center text-xs text-zinc-500">该事件没有关联的原始 Interaction。</p> : (
                <>
                  <details open className="rounded border border-white/8 bg-black/15">
                    <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-zinc-200">最终发送给 LLM / 工具的请求</summary>
                    <div className="border-t border-white/8 p-3">
                      <div className="mb-2 flex flex-wrap items-center gap-2 text-[10px] text-zinc-500"><span>{interaction.request.contentType}</span><span>{interaction.request.decodedBytes.toLocaleString()} bytes</span><span>{interaction.request.completeness}</span><CopyAction value={interaction.request.body} label="复制完整请求正文" /></div>
                      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-black/25 p-3 font-mono text-[11px] leading-5 text-zinc-300">{browserPreview(interaction.request.body)}</pre>
                    </div>
                  </details>
                  <details open className="rounded border border-white/8 bg-black/15">
                    <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-zinc-200">LLM / 工具返回给 Agent 的响应</summary>
                    <div className="border-t border-white/8 p-3">
                      <div className="mb-2 flex flex-wrap items-center gap-2 text-[10px] text-zinc-500"><span>{interaction.response.contentType}</span><span>{interaction.response.decodedBytes.toLocaleString()} bytes</span><span>{interaction.response.completeness}</span><CopyAction value={interaction.response.body} label="复制完整响应正文" /></div>
                      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-black/25 p-3 font-mono text-[11px] leading-5 text-zinc-300">{browserPreview(interaction.response.body)}</pre>
                    </div>
                  </details>
                </>
              )}
            </div>
          ) : (
            <dl className="rounded border border-white/8 bg-black/15 px-3">
              <EvidenceField label="Conversation" value={interaction?.conversationId ?? event.turnId.split(":turn:")[0]} />
              <EvidenceField label="Turn / Attempt" value={`${event.turnId} · ${event.attemptId ?? "--"}`} />
              <EvidenceField label="Interaction" value={event.interactionId} />
              <EvidenceField label="Agent Asset" value={interaction?.agentAssetId} />
              <EvidenceField label="Agent Instance" value={interaction?.agentInstanceId} />
              <EvidenceField label="Runtime Role" value={interaction?.runtimeRole ?? "agent_root"} />
              <EvidenceField label="Process" value={interaction?.process ? `pid ${interaction.process.pid} · ${interaction.process.comm ?? "--"}` : undefined} />
              <EvidenceField label="Transport" value={interaction ? `${interaction.transport} · ${interaction.protocol} · ${interaction.captureSource}` : undefined} />
              <EvidenceField label="TLS Adapter" value={interaction?.tlsAdapterId} />
              <EvidenceField label="Transport Decoder" value={interaction?.transportProtocol} />
              <EvidenceField label="Wire Template" value={interaction?.wireTemplateId ?? interaction?.parseState} />
              <EvidenceField label="Parse / Likelihood" value={interaction ? `${interaction.parseState ?? "legacy"} · ${interaction.llmLikelihood ?? "unknown"}` : undefined} />
              <EvidenceField label="Completeness" value={interaction ? `transport=${interaction.transportCompleteness ?? interaction.completeness} · wire=${interaction.wireCompleteness ?? interaction.completeness} · conversation=${interaction.conversationCompleteness ?? interaction.completeness}` : undefined} />
              <EvidenceField label="Schema Fingerprint" value={interaction?.schemaFingerprint} />
              <EvidenceField label="Endpoint" value={interaction ? `${interaction.endpoint}${interaction.path}` : undefined} />
              <EvidenceField label="Request Start" value={interaction ? nsDate(interaction.startedAtUnixNs) : nsDate(event.atUnixNs)} />
              <EvidenceField label="Request Complete" value={interaction ? nsDate(interaction.requestCompleteAtUnixNs) : undefined} />
              <EvidenceField label="First Response" value={interaction ? nsDate(interaction.firstResponseAtUnixNs) : undefined} />
              <EvidenceField label="Response End" value={interaction ? nsDate(interaction.endedAtUnixNs) : undefined} />
              <EvidenceField label="Request SHA-256" value={interaction?.request.sha256} />
              <EvidenceField label="Response SHA-256" value={interaction?.response.sha256} />
              <EvidenceField label="Correlation" value={event.correlationQuality} />
              {interaction ? (
                <EvidenceField label="下钻" value={<Link className="font-sans text-teal-200 hover:text-teal-100" to={`/events?${new URLSearchParams({ timeType: "last_30d", agentAssetId: interaction.agentAssetId, agentInstanceId: interaction.agentInstanceId ?? "", scope: "agent" }).toString()}`}>查看 Agent 原始行为与 Egress</Link>} />
              ) : null}
            </dl>
          )}
        </div>
      </aside>
    </>
  );
}

export default function ConversationTrackingPage() {
  const { t } = useI18n();
  const [searchParams, setSearchParams] = useSearchParams();
  const { filter: consoleTimeFilter, refreshVersion } = useSecurityConsole();
  const timeType = consoleTimeFilter.timeType ?? "last_3h";
  const [queryText, setQueryText] = useState("");
  const query = useDebounce(queryText, { wait: 300 });
  const [liveFollow, setLiveFollow] = useState(true);
  const coverageStatus = (searchParams.get("coverage") as AgentConversationCoverageStatus | null) ?? "all";
  const classification = (searchParams.get("classification") as AgentClassification | null) ?? "all";
  const scopedAgentAssetId = searchParams.get("agentAssetId") ?? "";
  const selectedLogicalAgentId = searchParams.get("logicalAgentId") ?? "";
  const selectedConversationId = searchParams.get("conversationId") ?? "";
  const selectedEventId = searchParams.get("eventId") ?? "";
  const selectedInteractionId = searchParams.get("interactionId") ?? "";
  const previousTopConversation = useRef<string>();

  const conversationQuery = useMemo(() => ({
    timeType,
    startTime: timeType === "custom" ? consoleTimeFilter.startTime : undefined,
    endTime: timeType === "custom" ? consoleTimeFilter.endTime : undefined,
    snapshotAsOf: liveSecuritySnapshotAsOf(timeType === "custom", consoleTimeFilter.snapshotAsOf),
    scope: "agent" as const,
    classificationView: "current_effective" as const,
    agentAssetId: clean(scopedAgentAssetId),
    coverageStatus: coverageStatus === "all" ? undefined : coverageStatus,
    classification: classification === "all" ? undefined : classification,
    q: clean(query),
    lifecycleScope: "all" as const,
    limit: 200,
  }), [classification, consoleTimeFilter.endTime, consoleTimeFilter.snapshotAsOf, consoleTimeFilter.startTime, coverageStatus, query, scopedAgentAssetId, timeType]);

  const {
    data: directory,
    loading: conversationsLoading,
    error: conversationsError,
    refresh: refreshConversations,
  } = useRequest(() => securityCenterApi.agentConversationDirectory(conversationQuery), {
    refreshDeps: [conversationQuery, refreshVersion],
    pollingInterval: 10_000,
    pollingWhenHidden: false,
  });

  const selectedLogicalAgent = useMemo(() => {
    const conversationOwner = selectedConversationId
      ? directory?.items.find((item) =>
          item.conversations.some((conversation) =>
            conversation.conversationId === selectedConversationId))
      : undefined;
    return conversationOwner
      ?? directory?.items.find((item) => item.logicalAgentId === selectedLogicalAgentId);
  }, [directory?.items, selectedConversationId, selectedLogicalAgentId]);
  const selectedConversation = useMemo(() => (
    selectedLogicalAgent?.conversations.find((item) => item.conversationId === selectedConversationId)
    ?? directory?.items.flatMap((item) => item.conversations)
      .find((item) => item.conversationId === selectedConversationId)
  ), [directory?.items, selectedConversationId, selectedLogicalAgent?.conversations]);

  const updateRoute = (mutate: (next: URLSearchParams) => void, replace = false) => {
    const next = new URLSearchParams(searchParams);
    mutate(next);
    setSearchParams(next, { replace });
  };

  const selectConversation = (conversation: AgentConversationSummary, replace = false) => {
    updateRoute((next) => {
      const owner = directory?.items.find((item) =>
        item.conversations.some((candidate) => candidate.conversationId === conversation.conversationId));
      if (owner) next.set("logicalAgentId", owner.logicalAgentId);
      next.set("conversationId", conversation.conversationId);
      next.delete("eventId");
      next.delete("interactionId");
    }, replace);
  };
  const selectLogicalAgent = (
    agent: LogicalAgentConversationDirectoryItem,
    replace = false,
  ) => {
    const nextConversation = agent.conversations.find((item) => item.hasContent)
      ?? agent.conversations[0];
    updateRoute((next) => {
      next.set("logicalAgentId", agent.logicalAgentId);
      if (nextConversation) next.set("conversationId", nextConversation.conversationId);
      else next.delete("conversationId");
      next.delete("eventId");
      next.delete("interactionId");
    }, replace);
  };

  useEffect(() => {
    const top = directory?.items[0];
    if (!top) return;
    const conversationOwner = selectedConversationId
      ? directory.items.find((item) =>
          item.conversations.some((conversation) =>
            conversation.conversationId === selectedConversationId))
      : undefined;
    if (conversationOwner && conversationOwner.logicalAgentId !== selectedLogicalAgentId) {
      updateRoute((next) => next.set("logicalAgentId", conversationOwner.logicalAgentId), true);
      previousTopConversation.current = top.logicalAgentId;
      return;
    }
    const selectedExists = directory.items.some((item) =>
      item.logicalAgentId === selectedLogicalAgentId);
    const followedPreviousTop = selectedLogicalAgentId
      && selectedLogicalAgentId === previousTopConversation.current;
    if (
      !selectedExists
      || (liveFollow && followedPreviousTop && top.logicalAgentId !== selectedLogicalAgentId)
    ) selectLogicalAgent(top, true);
    previousTopConversation.current = top.logicalAgentId;
  }, [directory?.items, liveFollow, selectedConversationId, selectedLogicalAgentId]);

  const {
    data: timeline,
    loading: timelineLoading,
    error: timelineError,
    refresh: refreshTimeline,
  } = useRequest(() => securityCenterApi.agentConversationTimeline({
    ...conversationQuery,
    conversationId: selectedConversationId,
    agentAssetId: selectedConversation?.agentAssetId ?? clean(scopedAgentAssetId),
  }), {
    ready: Boolean(selectedConversationId && selectedConversation?.hasContent),
    refreshDeps: [conversationQuery, refreshVersion, selectedConversation?.agentAssetId, selectedConversation?.hasContent, selectedConversationId],
    pollingInterval: 10_000,
    pollingWhenHidden: false,
  });

  const selectedEvent = useMemo(() => {
    const events = timeline?.items ?? [];
    return events.find((event) => event.eventId === selectedEventId) ?? events.find((event) => event.interactionId === selectedInteractionId);
  }, [selectedEventId, selectedInteractionId, timeline?.items]);

  const {
    data: interactionList,
    loading: interactionLoading,
    refresh: refreshInteraction,
  } = useRequest(() => securityCenterApi.agentInteractions({
    timeType,
    startTime: timeType === "custom" ? consoleTimeFilter.startTime : undefined,
    endTime: timeType === "custom" ? consoleTimeFilter.endTime : undefined,
    scope: "agent",
    classificationView: "current_effective",
    agentAssetId: selectedConversation?.agentAssetId,
    interactionId: selectedEvent?.interactionId,
    limit: 1,
  }), {
    ready: Boolean(selectedEvent?.interactionId),
    refreshDeps: [selectedConversation?.agentAssetId, selectedEvent?.interactionId, timeType, consoleTimeFilter.startTime, consoleTimeFilter.endTime],
  });

  const selectedInteraction = interactionList?.items[0];
  const selectEvent = (event: AgentConversationEvent) => updateRoute((next) => {
    next.set("eventId", event.eventId);
    if (event.interactionId) next.set("interactionId", event.interactionId);
    else next.delete("interactionId");
  });
  const closeInspector = () => updateRoute((next) => {
    next.delete("eventId");
    next.delete("interactionId");
  }, true);
  const clearSelectionOnMobile = () => updateRoute((next) => {
    next.delete("logicalAgentId");
    next.delete("conversationId");
    next.delete("eventId");
    next.delete("interactionId");
  }, true);
  const setCoverage = (value: AgentConversationCoverageStatus | "all") => updateRoute((next) => {
    if (value === "all") next.delete("coverage");
    else next.set("coverage", value);
    next.delete("conversationId");
    next.delete("eventId");
    next.delete("interactionId");
  }, true);
  const setClassification = (value: AgentClassification | "all") => updateRoute((next) => {
    if (value === "all") next.delete("classification");
    else next.set("classification", value);
    next.delete("conversationId");
    next.delete("eventId");
    next.delete("interactionId");
  }, true);
  const clearFilters = () => {
    setQueryText("");
    updateRoute((next) => {
      for (const key of ["coverage", "classification", "agentAssetId", "logicalAgentId", "conversationId", "eventId", "interactionId"]) next.delete(key);
    }, true);
  };

  const completeCount = directory?.items.filter((item) => item.coverage.status === "complete").length ?? 0;
  const assetOnlyCount = directory?.items.filter((item) => item.conversationCount === 0).length ?? 0;
  const abnormalCount = directory?.items.filter((item) => !["complete", "asset_only", "no_activity"].includes(item.coverage.status)).length ?? 0;

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-[#0b0f0c] text-zinc-100">
      <header className="shrink-0 border-b border-white/10 bg-[#0d120f] px-3 py-3 sm:px-4">
        <div className="flex flex-col gap-3 2xl:flex-row 2xl:items-center 2xl:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <MessageSquareText className="size-5 shrink-0 text-teal-300" aria-hidden="true" />
              <h1 className="truncate text-lg font-semibold tracking-normal text-zinc-50">{t("对话追踪")}</h1>
              <Pill className="border-white/10 bg-white/[0.035] text-zinc-400">{directory?.dataSource ?? "loading"}</Pill>
            </div>
            <p className="mt-1 truncate text-xs text-zinc-500">以 Agent 视角还原模型请求、回复、工具指令、工具结果与 TLS 证据</p>
          </div>

          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <div className="relative min-w-[220px] flex-1 2xl:w-[310px] 2xl:flex-none">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-zinc-600" aria-hidden="true" />
              <Input value={queryText} onChange={(event) => setQueryText(event.target.value)} placeholder="搜索 Agent、workspace、模型或正文摘要" aria-label="搜索对话" className="h-11 border-white/10 bg-white/[0.035] pl-9 text-xs text-zinc-100 sm:h-9" />
            </div>
            <Select value={coverageStatus} onValueChange={(value) => setCoverage(value as AgentConversationCoverageStatus | "all")}>
              <SelectTrigger className="h-11 w-[148px] border-white/10 bg-white/[0.035] text-xs text-zinc-100 sm:h-9"><SelectValue /></SelectTrigger>
              <SelectContent>{COVERAGE_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
            </Select>
            <Select value={classification} onValueChange={(value) => setClassification(value as AgentClassification | "all")}>
              <SelectTrigger className="h-11 w-[132px] border-white/10 bg-white/[0.035] text-xs text-zinc-100 sm:h-9"><SelectValue /></SelectTrigger>
              <SelectContent>{CLASSIFICATION_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
            </Select>
            <Button type="button" variant="secondary" size="sm" onClick={() => setLiveFollow((value) => !value)} aria-pressed={liveFollow} className={cn("h-11 border text-xs sm:h-9", liveFollow ? "border-teal-400/25 bg-teal-500/10 text-teal-100 hover:bg-teal-500/15" : "border-white/10 bg-white/5 text-zinc-400 hover:bg-white/10")}>
              <span className={cn("size-1.5 rounded-full", liveFollow ? "bg-teal-300" : "bg-zinc-600")} />实时跟随
            </Button>
            <Button type="button" variant="secondary" size="sm" onClick={clearFilters} className="h-11 border border-white/10 bg-white/5 text-zinc-300 hover:bg-white/10 sm:h-9"><X className="size-3.5" />清除</Button>
            <Button
              type="button"
              size="sm"
              onClick={() => void Promise.all([
                refreshConversations(),
                selectedConversation?.hasContent ? refreshTimeline() : Promise.resolve(),
                selectedEvent?.interactionId ? refreshInteraction() : Promise.resolve(),
              ])}
              disabled={conversationsLoading || timelineLoading || interactionLoading}
              className="h-11 bg-teal-500 text-[#07100c] hover:bg-teal-400 sm:h-9"
            >
              {conversationsLoading || timelineLoading || interactionLoading ? <LoaderCircle className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}刷新
            </Button>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-white/8 pt-2 text-[11px] text-zinc-500">
          <span className="flex items-center gap-1.5"><CircleCheck className="size-3.5 text-teal-300" />正文完整 <strong className="font-mono font-medium text-zinc-300">{completeCount}</strong></span>
          <span className="flex items-center gap-1.5"><CircleDashed className="size-3.5 text-zinc-500" />仅资产 <strong className="font-mono font-medium text-zinc-300">{assetOnlyCount}</strong></span>
          <span className="flex items-center gap-1.5"><AlertTriangle className="size-3.5 text-amber-300" />异常/部分 <strong className="font-mono font-medium text-zinc-300">{abnormalCount}</strong></span>
          <span className="ml-auto flex items-center gap-1.5"><Clock3 className="size-3.5" />{directory?.updateTime ? dayjs(directory.updateTime).format("MM-DD HH:mm:ss") : "等待数据"}</span>
        </div>
      </header>

      <main id="conversation-workspace" className="relative min-h-0 flex-1 overflow-hidden" aria-label="Agent 对话追踪工作区">
        <div className="grid h-full min-h-0 grid-cols-1 md:grid-cols-[320px_minmax(0,1fr)] xl:grid-cols-[320px_minmax(420px,1fr)_minmax(360px,0.78fr)]">
          <div className={cn("min-h-0", selectedConversationId ? "hidden md:block" : "block")}>
            <LogicalAgentDirectoryRail items={directory?.items ?? []} selectedLogicalAgentId={selectedLogicalAgent?.logicalAgentId} loading={conversationsLoading} error={conversationsError} onSelect={selectLogicalAgent} />
          </div>
          <div className={cn("min-h-0", selectedConversationId ? "block" : "hidden md:block")}>
            <Timeline agent={selectedLogicalAgent} conversation={selectedConversation} events={timeline?.items ?? []} selectedEventId={selectedEvent?.eventId} loading={timelineLoading} error={timelineError} onBack={clearSelectionOnMobile} onSelect={selectEvent} onSelectConversation={selectConversation} />
          </div>
          <InteractionInspector event={selectedEvent} interaction={selectedInteraction} loading={interactionLoading} onClose={closeInspector} />
        </div>
      </main>
    </div>
  );
}
