import dayjs from "dayjs";
import {
  Bot,
  Boxes,
  ArrowLeft,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  Clock3,
  Cpu,
  MessageSquareText,
  Settings2,
} from "lucide-react";

import type {
  AgentConversationSummary,
  AgentRuntimeInstanceRecord,
  LogicalAgentConversationDirectoryItemV3,
} from "@/lib/api/security-center";
import { cn } from "@/lib/utils";
import {
  formatDuration,
  formatTokenCount,
  formatTokenTotal,
  tokenCoverageText,
  usageForInstance,
} from "./agentUsage";

function runtimeId(instance: AgentRuntimeInstanceRecord) {
  return instance.canonicalAgentInstanceId ?? instance.agentInstanceId;
}

function nsDate(value?: string) {
  if (!value || !/^\d+$/u.test(value)) return "--";
  try {
    return dayjs(Number(BigInt(value) / 1_000_000n)).format("MM-DD HH:mm:ss");
  } catch {
    return "--";
  }
}

function Metric({
  label,
  value,
  detail,
}: {
  label: string;
  value: string | number;
  detail: string;
}) {
  return (
    <div className="border-r border-b border-white/8 bg-white/[0.018] px-4 py-3 last:border-r-0">
      <p className="text-[10px] font-medium uppercase tracking-[0.08em] text-zinc-600">{label}</p>
      <p className="mt-1 font-mono text-xl font-semibold text-zinc-100">{value}</p>
      <p className="mt-1 text-[11px] leading-4 text-zinc-500">{detail}</p>
    </div>
  );
}

function ThreadRow({
  thread,
  onSelect,
}: {
  thread: AgentConversationSummary;
  onSelect: (thread: AgentConversationSummary) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(thread)}
      className="flex min-h-14 w-full cursor-pointer items-center gap-3 border-b border-white/8 px-4 py-2.5 text-left transition-colors last:border-b-0 hover:bg-white/[0.035] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-400/70"
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded border border-teal-400/20 bg-teal-500/[0.07] text-teal-200">
        <MessageSquareText className="size-4" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-xs font-medium text-zinc-200">
            {thread.firstPromptPreview ?? "无正文摘要"}
          </span>
          {thread.agentInstanceIds.length > 1 ? (
            <span className="shrink-0 rounded border border-sky-400/20 bg-sky-500/[0.06] px-1.5 py-0.5 text-[9px] text-sky-100">
              {thread.agentInstanceIds.length} 段
            </span>
          ) : null}
        </span>
        <span className="mt-1 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] text-zinc-600">
          <span>{nsDate(thread.lastActivityAtUnixNs)}</span>
          <span>{thread.turnCount} 轮</span>
          <span>{thread.usage.modelCallCount} 调用</span>
          <span>{formatTokenTotal(thread.usage)} tokens</span>
          <span>{thread.toolCallCount} 工具</span>
          <span>{thread.coverage.status}</span>
        </span>
      </span>
      <ChevronRight className="size-4 shrink-0 text-zinc-700" aria-hidden="true" />
    </button>
  );
}

export function ConversationOverview({
  agent,
  instanceId,
  onSelectConversation,
  onBack,
}: {
  agent?: LogicalAgentConversationDirectoryItemV3;
  instanceId?: string;
  onSelectConversation: (thread: AgentConversationSummary) => void;
  onBack: () => void;
}) {
  if (!agent) {
    return (
      <section className="flex h-full items-center justify-center bg-[#0b0f0c] px-6 text-center" aria-label="Agent 运行概览">
        <div>
          <Boxes className="mx-auto size-8 text-zinc-700" aria-hidden="true" />
          <p className="mt-3 text-sm text-zinc-300">选择一个逻辑 Agent 查看整体运行状态</p>
          <p className="mt-2 text-xs leading-5 text-zinc-500">进入具体 Thread 后再查看完整用户、模型和工具时间线。</p>
        </div>
      </section>
    );
  }

  const instance = instanceId
    ? agent.recentInstances.find((candidate) => [
        runtimeId(candidate),
        candidate.agentInstanceId,
        ...(candidate.agentInstanceAliases ?? []),
      ].includes(instanceId))
    : undefined;
  const instanceAliases = new Set(instance
    ? [runtimeId(instance), instance.agentInstanceId, ...(instance.agentInstanceAliases ?? [])]
    : []);
  const threads = instance
    ? agent.userThreads.filter((thread) =>
        thread.agentInstanceIds.some((identity) => instanceAliases.has(identity)))
    : agent.userThreads;
  const technical = instance
    ? agent.technicalActivities.filter((activity) =>
        activity.agentInstanceId && instanceAliases.has(activity.agentInstanceId))
    : agent.technicalActivities;
  const usage = instance ? usageForInstance(agent.instanceUsage, instanceAliases) : agent.usage;
  const toolCallCount = threads.reduce((sum, thread) => sum + thread.toolCallCount, 0);
  const title = instance ? "运行实例概览" : "Agent 整体概览";
  const subtitle = instance
    ? "一次真实根进程承载的 Thread Segment、启动协商与覆盖状态"
    : "先看运行实例、用户 Thread 和技术活动，再进入具体对话";

  return (
    <section className="h-full min-h-0 overflow-y-auto bg-[#0b0f0c]" aria-label={title}>
      <header className="sticky top-0 z-10 flex min-h-16 items-center gap-3 border-b border-white/10 bg-[#0b0f0c]/95 px-4 py-3 backdrop-blur">
        <button
          type="button"
          onClick={onBack}
          aria-label="返回 Agent 目录"
          className="flex size-11 shrink-0 cursor-pointer items-center justify-center rounded text-zinc-400 hover:bg-white/5 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/70 md:hidden"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
        </button>
        <span className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded border",
          instance
            ? "border-sky-400/25 bg-sky-500/[0.08] text-sky-200"
            : "border-violet-400/25 bg-violet-500/[0.08] text-violet-200",
        )}>
          {instance ? <Cpu className="size-4" aria-hidden="true" /> : <Bot className="size-4" aria-hidden="true" />}
        </span>
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-zinc-100">{title} · {agent.displayName}</h2>
          <p className="mt-1 truncate text-[11px] text-zinc-500">{subtitle}</p>
        </div>
        {instance ? (
          <span className="ml-auto shrink-0 rounded border border-white/10 bg-white/[0.03] px-2 py-1 font-mono text-[10px] text-zinc-400">
            pid {instance.rootPid}
          </span>
        ) : null}
      </header>

      <div className="grid border-b border-white/8 sm:grid-cols-2 xl:grid-cols-4">
        <Metric
          label="Token 用量"
          value={formatTokenTotal(usage, false)}
          detail={usage.tokenCoverage === "unavailable"
            ? tokenCoverageText(usage)
            : `输入 ${formatTokenCount(usage.inputTokens)} · 输出 ${formatTokenCount(usage.outputTokens)} · ${tokenCoverageText(usage)}`}
        />
        <Metric
          label="模型调用"
          value={usage.modelCallCount}
          detail={`${usage.successfulModelCallCount} 成功 · ${usage.failedModelCallCount} 异常 · 均值 ${formatDuration(usage.averageDurationMs)}`}
        />
        <Metric label="用户 Thread" value={threads.length} detail="不包含 initialize 与 tools/list" />
        <Metric label="工具调用" value={toolCallCount} detail={`${technical.reduce((sum, item) => sum + item.interactionIds.length, 0)} 条启动/协商活动另行折叠`} />
      </div>

      <div className="grid min-h-0 xl:grid-cols-[minmax(0,1.25fr)_minmax(300px,0.75fr)]">
        <section className="border-r border-white/8" aria-labelledby="conversation-overview-threads">
          <div className="flex h-11 items-center justify-between border-b border-white/8 px-4">
            <h3 id="conversation-overview-threads" className="flex items-center gap-2 text-xs font-semibold text-zinc-300">
              <MessageSquareText className="size-3.5 text-teal-300" aria-hidden="true" />
              最近用户对话
            </h3>
            <span className="font-mono text-[10px] text-zinc-600">{threads.length}</span>
          </div>
          {threads.length ? threads.slice(0, 20).map((thread) => (
            <ThreadRow key={thread.conversationId} thread={thread} onSelect={onSelectConversation} />
          )) : (
            <div className="flex min-h-48 flex-col items-center justify-center px-5 text-center">
              <CircleDashed className="size-7 text-zinc-700" aria-hidden="true" />
              <p className="mt-3 text-xs text-zinc-400">该范围内没有用户可见 Thread</p>
              <p className="mt-1 text-[11px] leading-5 text-zinc-600">资产或技术活动仍可在右侧查看，不会制造空会话。</p>
            </div>
          )}
        </section>

        <section aria-labelledby="conversation-overview-technical">
          <div className="flex h-11 items-center justify-between border-b border-white/8 px-4">
            <h3 id="conversation-overview-technical" className="flex items-center gap-2 text-xs font-semibold text-zinc-300">
              <Settings2 className="size-3.5 text-violet-300" aria-hidden="true" />
              启动与能力协商
            </h3>
            <span className="font-mono text-[10px] text-zinc-600">{technical.length}</span>
          </div>
          {technical.length ? (
            <div className="divide-y divide-white/8">
              {technical.slice(0, 20).map((activity) => (
                <details key={activity.technicalActivityId} className="group px-4 py-3">
                  <summary className="flex min-h-8 cursor-pointer list-none items-center gap-2 text-xs text-zinc-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/70">
                    {activity.status === "complete"
                      ? <CheckCircle2 className="size-3.5 text-teal-300" aria-hidden="true" />
                      : <Clock3 className="size-3.5 text-amber-300" aria-hidden="true" />}
                    <span className="min-w-0 flex-1 truncate">{activity.role} · {activity.methods.join(", ")}</span>
                    <span className="font-mono text-[9px] text-zinc-600">{activity.interactionIds.length}</span>
                  </summary>
                  <div className="mt-2 border-l border-violet-400/20 pl-5 text-[10px] leading-5 text-zinc-500">
                    <p>{nsDate(activity.startedAtUnixNs)} → {nsDate(activity.endedAtUnixNs)}</p>
                    <p className="break-all font-mono text-zinc-600">{activity.paths.join(" · ")}</p>
                  </div>
                </details>
              ))}
            </div>
          ) : (
            <p className="px-4 py-8 text-center text-[11px] leading-5 text-zinc-600">
              当前没有单独的启动或控制流记录。
            </p>
          )}
        </section>
      </div>
    </section>
  );
}
