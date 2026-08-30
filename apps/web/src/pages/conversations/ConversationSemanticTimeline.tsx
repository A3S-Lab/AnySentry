import {
  AlertTriangle,
  ArrowLeft,
  Bot,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  Clock3,
  MessageSquareText,
  TerminalSquare,
  UserRound,
  Wrench,
} from "lucide-react";
import { type ReactNode, useMemo } from "react";

import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type {
  AgentConversationSummary,
  AgentConversationTurnV2,
  AgentSemanticEvent,
  ConversationInstanceSegment,
  LogicalAgentConversationDirectoryItem,
} from "@/lib/api/security-center";
import { cn } from "@/lib/utils";

function nsDate(value?: string, format = "MM-DD HH:mm:ss.SSS") {
  if (!value || !/^\d+$/u.test(value)) return "--";
  try {
    const date = new Date(Number(BigInt(value) / 1_000_000n));
    const pad = (number: number, width = 2) => String(number).padStart(width, "0");
    const values: Record<string, string> = {
      MM: pad(date.getMonth() + 1),
      DD: pad(date.getDate()),
      HH: pad(date.getHours()),
      mm: pad(date.getMinutes()),
      ss: pad(date.getSeconds()),
      SSS: pad(date.getMilliseconds(), 3),
    };
    return Object.entries(values).reduce((output, [token, replacement]) =>
      output.replace(token, replacement), format);
  } catch {
    return "--";
  }
}

function Badge({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex min-h-5 items-center rounded border px-1.5 py-0.5 text-[10px] font-medium leading-none", className)}>
      {children}
    </span>
  );
}

function actorMeta(event: AgentSemanticEvent) {
  if (event.actor === "user") return {
    label: "用户",
    detail: "人工输入",
    icon: UserRound,
    tone: "border-sky-400/25 bg-sky-500/[0.06] text-sky-100",
    iconTone: "border-sky-400/25 bg-sky-500/10 text-sky-200",
  };
  if (event.actor === "model") return {
    label: "模型",
    detail: event.kind === "model_final" ? "最终回复" : "过程说明",
    icon: Bot,
    tone: "border-teal-400/25 bg-teal-500/[0.055] text-teal-100",
    iconTone: "border-teal-400/25 bg-teal-500/10 text-teal-200",
  };
  return {
    label: "工具",
    detail: event.toolName ?? event.toolKind ?? "Tool",
    icon: Wrench,
    tone: "border-violet-400/25 bg-violet-500/[0.055] text-violet-100",
    iconTone: "border-violet-400/25 bg-violet-500/10 text-violet-200",
  };
}

function ActorCard({
  event,
  selected,
  onSelect,
}: {
  event: AgentSemanticEvent;
  selected: boolean;
  onSelect: (event: AgentSemanticEvent) => void;
}) {
  const meta = actorMeta(event);
  const Icon = meta.icon;
  return (
    <button
      type="button"
      onClick={() => onSelect(event)}
      className={cn(
        "relative flex min-h-[76px] w-full cursor-pointer gap-3 rounded border px-3 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/70",
        meta.tone,
        selected ? "border-violet-300/55 bg-violet-400/[0.10]" : "hover:border-white/25 hover:bg-white/[0.045]",
      )}
    >
      <span className={cn("relative z-10 flex size-9 shrink-0 items-center justify-center rounded border", meta.iconTone)}>
        <Icon className="size-4" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold">{meta.label}</span>
          <Badge className="border-current/15 bg-black/10 text-current/80">{meta.detail}</Badge>
          {event.completeness !== "complete" ? <Badge className="border-amber-400/25 bg-amber-500/10 text-amber-100">部分</Badge> : null}
        </span>
        <span className="mt-1.5 line-clamp-5 block whitespace-pre-wrap break-words text-xs leading-5 text-zinc-200">
          {event.contentPreview ?? "该事件没有可展示的文字摘要；可在检查器查看结构化证据。"}
        </span>
        <span className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] text-zinc-500">
          <time>{nsDate(event.atUnixNs)}</time>
          <span>{event.correlationQuality}</span>
          <span>parser v{event.parserVersion}</span>
        </span>
      </span>
      <ChevronRight className="mt-2 size-4 shrink-0 text-zinc-600" aria-hidden="true" />
    </button>
  );
}

function ToolStepCard({
  call,
  result,
  selectedEventId,
  onSelect,
}: {
  call?: AgentSemanticEvent;
  result?: AgentSemanticEvent;
  selectedEventId?: string;
  onSelect: (event: AgentSemanticEvent) => void;
}) {
  const primary = call ?? result!;
  const selected = selectedEventId === call?.semanticEventId || selectedEventId === result?.semanticEventId;
  const failed = result?.status === "failed";
  const status = failed ? "失败" : result ? "成功" : "等待结果";
  return (
    <button
      type="button"
      onClick={() => onSelect(result ?? call!)}
      className={cn(
        "relative flex min-h-[84px] w-full cursor-pointer gap-3 rounded border border-violet-400/25 bg-violet-500/[0.055] px-3 py-3 text-left text-violet-100 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/70",
        selected ? "border-violet-300/55 bg-violet-400/[0.11]" : "hover:border-white/25 hover:bg-white/[0.045]",
      )}
    >
      <span className="relative z-10 flex size-9 shrink-0 items-center justify-center rounded border border-violet-400/25 bg-violet-500/10 text-violet-200">
        <Wrench className="size-4" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold">工具</span>
          <Badge className="border-violet-300/20 bg-black/10 text-violet-100">{primary.toolKind ?? "other"}</Badge>
          <span className="font-mono text-[10px] text-violet-200/80">{primary.toolName ?? "Tool"}</span>
          <Badge className={failed
            ? "border-rose-400/25 bg-rose-500/10 text-rose-100"
            : result
              ? "border-teal-400/25 bg-teal-500/10 text-teal-100"
              : "border-amber-400/25 bg-amber-500/10 text-amber-100"}>
            {status}
          </Badge>
        </span>
        {call ? (
          <span className="mt-1.5 block whitespace-pre-wrap break-words text-xs leading-5 text-zinc-200">
            {call.contentPreview ?? "工具参数未形成可读摘要"}
          </span>
        ) : (
          <span className="mt-1.5 block text-xs text-amber-100/80">调用证据缺失，但观察到工具结果。</span>
        )}
        {result ? (
          <span className="mt-2 block border-t border-violet-300/10 pt-2">
            <span className="mb-1 flex items-center gap-1.5 text-[10px] font-medium text-zinc-500">
              <TerminalSquare className="size-3" aria-hidden="true" />结果
            </span>
            <span className="line-clamp-4 block whitespace-pre-wrap break-words text-xs leading-5 text-zinc-300">
              {result.contentPreview ?? "工具结果没有可读摘要"}
            </span>
          </span>
        ) : null}
        <span className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] text-zinc-500">
          <time>{nsDate(call?.atUnixNs ?? result?.atUnixNs)}</time>
          {result ? <time>→ {nsDate(result.atUnixNs)}</time> : null}
          <span>{primary.toolCallId ?? "unlinked"}</span>
        </span>
      </span>
      <ChevronRight className="mt-2 size-4 shrink-0 text-zinc-600" aria-hidden="true" />
    </button>
  );
}

export function ConversationSemanticTimeline({
  agent,
  conversation,
  turns,
  segments,
  selectedEventId,
  loading,
  error,
  onBack,
  onSelect,
  onSelectConversation,
}: {
  agent?: LogicalAgentConversationDirectoryItem;
  conversation?: AgentConversationSummary;
  turns: AgentConversationTurnV2[];
  segments: ConversationInstanceSegment[];
  selectedEventId?: string;
  loading: boolean;
  error?: Error;
  onBack: () => void;
  onSelect: (event: AgentSemanticEvent) => void;
  onSelectConversation: (conversation: AgentConversationSummary) => void;
}) {
  const allEvents = useMemo(() => turns.flatMap((turn) => turn.events), [turns]);
  const callById = useMemo(() => new Map(allEvents
    .filter((event) => event.kind === "tool_call" && event.toolCallId)
    .map((event) => [event.toolCallId!, event])), [allEvents]);
  const resultById = useMemo(() => new Map(allEvents
    .filter((event) => event.kind === "tool_result" && event.toolCallId)
    .map((event) => [event.toolCallId!, event])), [allEvents]);

  if (!conversation) {
    return (
      <section className="flex h-full min-h-0 items-center justify-center bg-[#0b0f0c] px-6 text-center" aria-label="Agent 对话时间线">
        <div className="max-w-lg">
          <MessageSquareText className="mx-auto size-8 text-zinc-700" aria-hidden="true" />
          <p className="mt-3 text-sm text-zinc-300">{agent ? "该 Agent 当前没有可展示的模型对话" : "选择左侧 Agent、实例或会话查看完整链路"}</p>
          {agent ? <p className="mt-2 text-xs leading-5 text-zinc-500">已识别 {agent.totalInstanceCount} 个实例；发生模型调用后会自动形成对话线程。</p> : null}
        </div>
      </section>
    );
  }

  return (
    <section className="h-full min-h-0 overflow-hidden bg-[#0b0f0c]" aria-label="Agent 对话时间线">
      <div className="flex min-h-16 items-center gap-3 border-b border-white/10 px-3 py-2 sm:px-4">
        <Button type="button" variant="ghost" size="icon" onClick={onBack} aria-label="返回 Agent 目录" className="size-11 text-zinc-400 hover:bg-white/5 hover:text-zinc-100 md:hidden">
          <ArrowLeft className="size-4" />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-sm font-semibold text-zinc-100">{agent?.displayName ?? conversation.displayName}</h2>
            <Badge className="border-white/10 bg-white/[0.035] text-zinc-400">Thread</Badge>
            <Badge className="border-sky-400/20 bg-sky-500/[0.06] text-sky-100">{segments.length} 实例段</Badge>
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
      </div>

      <div className="h-[calc(100%-4rem)] overflow-y-auto px-3 py-4 sm:px-5">
        {loading && turns.length === 0 ? (
          <div className="mx-auto max-w-4xl space-y-3" aria-label="正在加载语义时间线">
            {[0, 1, 2, 3].map((index) => <div key={index} className="h-24 animate-pulse rounded border border-white/5 bg-white/[0.025]" />)}
          </div>
        ) : error ? (
          <div className="mx-auto max-w-2xl rounded border border-rose-400/20 bg-rose-500/[0.06] p-4 text-xs leading-5 text-rose-100">
            <p className="font-semibold">语义时间线加载失败</p>
            <p className="mt-1 text-rose-200/70">{error.message}</p>
          </div>
        ) : !conversation.hasContent || turns.length === 0 ? (
          <div className="flex min-h-[420px] flex-col items-center justify-center px-6 text-center">
            <CircleDashed className="size-9 text-zinc-600" aria-hidden="true" />
            <p className="mt-3 text-sm font-medium text-zinc-300">该 Thread 暂无可组织的用户、模型或工具事件</p>
            <p className="mt-1 max-w-lg text-xs leading-5 text-zinc-500">资产和原始 TLS 证据仍然保留；页面不会用结构化工具参数伪造模型回复。</p>
          </div>
        ) : (
          <div className="mx-auto max-w-4xl space-y-5">
            {turns.map((turn) => (
              <section key={turn.turnId} aria-labelledby={`${turn.turnId}-heading`}>
                <div className="mb-2 flex items-center gap-3">
                  <span className="h-px flex-1 bg-white/8" />
                  <h3 id={`${turn.turnId}-heading`} className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.12em] text-zinc-600">
                    第 {turn.ordinal} 轮
                    {turn.state === "complete" ? <CheckCircle2 className="size-3 text-teal-400" /> : <AlertTriangle className="size-3 text-amber-400" />}
                  </h3>
                  <span className="h-px flex-1 bg-white/8" />
                </div>
                <div className="relative space-y-2 before:absolute before:bottom-5 before:left-[17px] before:top-5 before:w-px before:bg-white/10">
                  {turn.events.map((event) => {
                    if (event.kind === "tool_result" && event.toolCallId && callById.has(event.toolCallId)) return null;
                    if (event.kind === "tool_call") {
                      return (
                        <ToolStepCard
                          key={event.semanticEventId}
                          call={event}
                          result={event.toolCallId ? resultById.get(event.toolCallId) : undefined}
                          selectedEventId={selectedEventId}
                          onSelect={onSelect}
                        />
                      );
                    }
                    if (event.kind === "tool_result") {
                      return <ToolStepCard key={event.semanticEventId} result={event} selectedEventId={selectedEventId} onSelect={onSelect} />;
                    }
                    return <ActorCard key={event.semanticEventId} event={event} selected={selectedEventId === event.semanticEventId} onSelect={onSelect} />;
                  })}
                  {turn.diagnostics.map((diagnostic) => (
                    <div key={diagnostic.diagnosticId} className="flex min-h-10 items-center gap-2 rounded border border-amber-400/15 bg-amber-500/[0.035] px-3 py-2 text-[11px] text-amber-100/80">
                      <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
                      <span className="min-w-0 flex-1">采集诊断 · {diagnostic.message}</span>
                      <Clock3 className="size-3 text-amber-200/40" aria-hidden="true" />
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
