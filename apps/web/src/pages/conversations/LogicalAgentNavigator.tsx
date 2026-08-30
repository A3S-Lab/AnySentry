import dayjs from "dayjs";
import { Bot, Boxes, ChevronRight, Cpu, MessageSquareText } from "lucide-react";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";

import type {
  AgentConversationSummary,
  AgentRuntimeInstanceRecord,
  LogicalAgentConversationDirectoryItem,
} from "@/lib/api/security-center";
import { cn } from "@/lib/utils";

function runtimeId(instance: AgentRuntimeInstanceRecord) {
  return instance.canonicalAgentInstanceId ?? instance.agentInstanceId;
}

function runtimeAliases(instance: AgentRuntimeInstanceRecord) {
  return new Set([
    runtimeId(instance),
    instance.agentInstanceId,
    ...(instance.agentInstanceAliases ?? []),
  ]);
}

function shortId(value: string) {
  const parts = value.split(":");
  const tail = parts.at(-1) ?? value;
  return tail.length > 14 ? tail.slice(-14) : tail;
}

function matchingInstances(
  agent: LogicalAgentConversationDirectoryItem,
  instances: AgentRuntimeInstanceRecord[],
) {
  const expected = new Set(agent.agentInstanceIds);
  return instances
    .filter((instance) => [...runtimeAliases(instance)].some((alias) => expected.has(alias)))
    .sort((left, right) => {
      const rank = (value: AgentRuntimeInstanceRecord) => value.runtimeState === "running"
        ? value.activityState === "active" ? 0 : 1
        : value.runtimeState === "unobserved" ? 2 : 3;
      return rank(left) - rank(right) || right.lastSeenAt - left.lastSeenAt;
    });
}

function lifecycleText(instance: AgentRuntimeInstanceRecord) {
  if (instance.runtimeState === "running") return instance.activityState === "active" ? "活动" : "空闲";
  if (instance.runtimeState === "unobserved") return "待确认";
  if (instance.runtimeState === "lost") return "失联";
  return "已退出";
}

function lifecycleTone(instance: AgentRuntimeInstanceRecord) {
  if (instance.runtimeState === "running" && instance.activityState === "active") return "bg-teal-300";
  if (instance.runtimeState === "running") return "bg-sky-300";
  if (instance.runtimeState === "unobserved") return "bg-amber-300";
  if (instance.runtimeState === "lost") return "bg-rose-300";
  return "bg-zinc-600";
}

export function LogicalAgentNavigator({
  items,
  runtimeInstances,
  selectedLogicalAgentId,
  selectedInstanceId,
  selectedConversationId,
  loading,
  error,
  onSelectAgent,
  onSelectInstance,
  onSelectConversation,
}: {
  items: LogicalAgentConversationDirectoryItem[];
  runtimeInstances: AgentRuntimeInstanceRecord[];
  selectedLogicalAgentId?: string;
  selectedInstanceId?: string;
  selectedConversationId?: string;
  loading: boolean;
  error?: Error;
  onSelectAgent: (item: LogicalAgentConversationDirectoryItem) => void;
  onSelectInstance: (agent: LogicalAgentConversationDirectoryItem, instance: AgentRuntimeInstanceRecord) => void;
  onSelectConversation: (conversation: AgentConversationSummary) => void;
}) {
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const [expandedHistory, setExpandedHistory] = useState<Set<string>>(() => new Set());
  const ordered = useMemo(() => [
    ...items.filter((item) => item.lifecycleState !== "historical"),
    ...items.filter((item) => item.lifecycleState === "historical"),
  ], [items]);
  useEffect(() => {
    if (!selectedLogicalAgentId) return;
    const frame = window.requestAnimationFrame(() => {
      refs.current.get(selectedLogicalAgentId)?.scrollIntoView({ block: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [selectedLogicalAgentId]);
  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? ordered.length - 1
        : Math.min(ordered.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)));
    const next = ordered[nextIndex];
    if (!next) return;
    onSelectAgent(next);
    window.requestAnimationFrame(() => refs.current.get(next.logicalAgentId)?.focus());
  };

  const renderSection = (title: string, agents: LogicalAgentConversationDirectoryItem[]) => (
    <section aria-labelledby={`agent-section-${title}`}>
      <div className="sticky top-0 z-10 flex h-9 items-center justify-between border-y border-white/8 bg-[#0d120f]/95 px-3 backdrop-blur">
        <h3 id={`agent-section-${title}`} className="text-[11px] font-semibold text-zinc-300">{title}</h3>
        <span className="font-mono text-[10px] text-zinc-500">{agents.length}</span>
      </div>
      <div className="divide-y divide-white/8">
        {agents.map((agent) => {
          const index = ordered.indexOf(agent);
          const active = agent.logicalAgentId === selectedLogicalAgentId;
          const instances = matchingInstances(agent, runtimeInstances);
          const currentInstances = instances.filter((instance) =>
            instance.runtimeState === "running" || instance.runtimeState === "unobserved");
          const historicalInstances = instances.filter((instance) =>
            instance.runtimeState !== "running" && instance.runtimeState !== "unobserved");
          const historyExpanded = expandedHistory.has(agent.logicalAgentId);
          const displayedInstances = historyExpanded
            ? instances
            : [...currentInstances, ...historicalInstances.slice(0, 8)];
          const hiddenHistoryCount = Math.max(0, historicalInstances.length - 8);
          const visibleConversations = selectedInstanceId
            ? agent.conversations.filter((conversation) =>
                conversation.agentInstanceIds.includes(selectedInstanceId))
            : agent.conversations;
          return (
            <div key={agent.logicalAgentId} className={cn(active && "bg-white/[0.018]")}>
              <button
                ref={(node) => {
                  if (node) refs.current.set(agent.logicalAgentId, node);
                  else refs.current.delete(agent.logicalAgentId);
                }}
                type="button"
                role="option"
                aria-selected={active}
                tabIndex={active || (!selectedLogicalAgentId && index === 0) ? 0 : -1}
                onKeyDown={(event) => move(event, index)}
                onClick={() => onSelectAgent(agent)}
                className={cn(
                  "w-full cursor-pointer px-3 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-400/70",
                  active ? "bg-violet-400/[0.07]" : "hover:bg-white/[0.035]",
                )}
              >
                <span className="flex items-start gap-2.5">
                  <span className={cn(
                    "flex size-8 shrink-0 items-center justify-center rounded border",
                    agent.lifecycleState === "running"
                      ? "border-teal-400/25 bg-teal-500/10 text-teal-200"
                      : "border-zinc-500/20 bg-zinc-500/10 text-zinc-400",
                  )}>
                    <Bot className="size-4" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate text-xs font-semibold text-zinc-100">{agent.displayName}</span>
                      <span className="shrink-0 font-mono text-[10px] text-zinc-500">{agent.totalInstanceCount} 实例</span>
                    </span>
                    <span className="mt-0.5 block truncate font-mono text-[10px] text-zinc-500">{agent.product} · {agent.environment}</span>
                    <span className="mt-1.5 flex items-center justify-between gap-2 text-[10px] text-zinc-500">
                      <span className="truncate">{agent.workspacePath}</span>
                      <span className="shrink-0">{agent.conversationCount} 会话</span>
                    </span>
                  </span>
                </span>
              </button>

              {active ? (
                <div className="border-t border-violet-400/10 bg-black/10 px-2 py-2">
                  <div className="mb-1.5 flex items-center justify-between px-1 text-[10px] font-medium text-zinc-500">
                    <span className="flex items-center gap-1.5"><Cpu className="size-3" />运行实例</span>
                    <span>{instances.length || agent.totalInstanceCount}</span>
                  </div>
                  <div className="space-y-1">
                    {displayedInstances.length ? displayedInstances.map((instance) => {
                      const canonical = runtimeId(instance);
                      const selected = selectedInstanceId === canonical;
                      return (
                        <button
                          key={canonical}
                          type="button"
                          onClick={() => onSelectInstance(agent, instance)}
                          className={cn(
                            "flex min-h-11 w-full cursor-pointer items-center gap-2 rounded border px-2 py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/70",
                            selected
                              ? "border-sky-400/30 bg-sky-500/[0.09]"
                              : "border-transparent hover:border-white/10 hover:bg-white/[0.035]",
                          )}
                        >
                          <span className={cn("size-1.5 shrink-0 rounded-full", lifecycleTone(instance))} />
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center justify-between gap-2">
                              <span className="truncate font-mono text-[10px] text-zinc-300">#{shortId(canonical)}</span>
                              <span className="text-[10px] text-zinc-500">{lifecycleText(instance)}</span>
                            </span>
                            <span className="mt-0.5 block truncate text-[10px] text-zinc-600">
                              pid {instance.rootPid} · {dayjs(instance.lastSeenAt).format("MM-DD HH:mm")}
                            </span>
                          </span>
                        </button>
                      );
                    }) : (
                      <p className="px-2 py-2 text-[10px] leading-4 text-zinc-600">实例历史正在恢复；会话正文仍可按 Thread 查看。</p>
                    )}
                    {hiddenHistoryCount > 0 || historyExpanded && historicalInstances.length > 8 ? (
                      <button
                        type="button"
                        aria-expanded={historyExpanded}
                        onClick={() => setExpandedHistory((current) => {
                          const next = new Set(current);
                          if (next.has(agent.logicalAgentId)) next.delete(agent.logicalAgentId);
                          else next.add(agent.logicalAgentId);
                          return next;
                        })}
                        className="min-h-11 w-full cursor-pointer rounded border border-dashed border-white/10 px-2 text-[10px] text-zinc-500 transition-colors hover:border-violet-400/25 hover:bg-violet-500/[0.04] hover:text-zinc-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/70"
                      >
                        {historyExpanded ? "收起较早历史实例" : `展开另外 ${hiddenHistoryCount} 个历史实例`}
                      </button>
                    ) : null}
                  </div>

                  <div className="mb-1.5 mt-3 flex items-center justify-between px-1 text-[10px] font-medium text-zinc-500">
                    <span className="flex items-center gap-1.5"><MessageSquareText className="size-3" />对话线程</span>
                    <span>{visibleConversations.length}</span>
                  </div>
                  <div className="space-y-1">
                    {visibleConversations.slice(0, 20).map((conversation, conversationIndex) => (
                      <button
                        key={conversation.conversationId}
                        type="button"
                        onClick={() => onSelectConversation(conversation)}
                        className={cn(
                          "flex min-h-11 w-full cursor-pointer items-center gap-2 rounded border px-2 py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-400/70",
                          selectedConversationId === conversation.conversationId
                            ? "border-teal-400/25 bg-teal-500/[0.08]"
                            : "border-transparent hover:border-white/10 hover:bg-white/[0.035]",
                        )}
                      >
                        <Boxes className="size-3.5 shrink-0 text-zinc-500" aria-hidden="true" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[10px] font-medium text-zinc-300">
                            会话 {agent.conversations.length - conversationIndex}
                            {conversation.agentInstanceIds.length > 1 ? ` · ${conversation.agentInstanceIds.length} 段` : ""}
                          </span>
                          <span className="mt-0.5 block truncate text-[10px] text-zinc-600">
                            {conversation.firstPromptPreview ?? "无正文"}
                          </span>
                        </span>
                        <ChevronRight className="size-3 shrink-0 text-zinc-700" aria-hidden="true" />
                      </button>
                    ))}
                    {visibleConversations.length === 0 ? (
                      <p className="px-2 py-2 text-[10px] leading-4 text-zinc-600">该实例当前没有可见对话；清除实例筛选可查看整个 Agent。</p>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );

  return (
    <section className="h-full min-h-0 overflow-hidden border-r border-white/10 bg-[#0d120f]" aria-label="逻辑 Agent、运行实例与对话线程">
      <div className="flex h-12 items-center justify-between border-b border-white/10 px-3">
        <div className="flex items-center gap-2">
          <Boxes className="size-4 text-zinc-400" aria-hidden="true" />
          <h2 className="text-xs font-semibold text-zinc-200">Agent / 实例 / 会话</h2>
        </div>
        <span className="font-mono text-[10px] text-zinc-500">{items.length}</span>
      </div>
      <div className="h-[calc(100%-3rem)] overflow-y-auto" role="listbox" aria-label="运行中与历史 Agent">
        {loading && items.length === 0 ? (
          <div className="space-y-2 p-3" aria-label="正在加载 Agent 目录">
            {[0, 1, 2, 3].map((index) => <div key={index} className="h-20 animate-pulse rounded border border-white/5 bg-white/[0.025]" />)}
          </div>
        ) : error ? (
          <div className="m-3 rounded border border-rose-400/20 bg-rose-500/[0.06] p-3 text-xs leading-5 text-rose-100">
            <p className="font-semibold">Agent 目录加载失败</p>
            <p className="mt-1 text-rose-200/70">{error.message}</p>
          </div>
        ) : items.length === 0 ? (
          <div className="flex min-h-56 flex-col items-center justify-center px-5 text-center">
            <Bot className="size-7 text-zinc-600" aria-hidden="true" />
            <p className="mt-3 text-sm font-medium text-zinc-300">当前筛选下没有 Agent</p>
            <p className="mt-1 text-xs leading-5 text-zinc-500">扩大时间范围或清除筛选后重试。</p>
          </div>
        ) : (
          <>
            {renderSection("当前运行", ordered.filter((item) => item.lifecycleState !== "historical"))}
            {renderSection("历史 Agent", ordered.filter((item) => item.lifecycleState === "historical"))}
          </>
        )}
      </div>
    </section>
  );
}
