import { useRequest } from "ahooks";
import {
  Activity,
  ArrowLeft,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Clock3,
  Database,
  FileCode2,
  FileText,
  Gauge,
  GitBranch,
  HardDrive,
  History,
  LoaderCircle,
  ListTree,
  MessageSquareText,
  RefreshCw,
  Search,
  ShieldCheck,
  TerminalSquare,
  Timer,
  TriangleAlert,
  UserRound,
  Wrench,
  XCircle,
} from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { OperationalEmptyState } from "@/components/custom/operational-empty-state";
import { ToolSystemEvidence, SystemEventRows } from "@/components/custom/tool-system-evidence";
import type { SystemEvent, ToolEvidenceMatch } from "@/lib/tool-system-evidence";
import { LocalRecordAnalysis } from "@/components/custom/local-record-analysis";
import { LocalRecordTrace } from "@/components/custom/local-record-trace";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  type LocalRecordActivityStatus,
  type LocalRecordDetail,
  type LocalObservedLlmRequest,
  type LocalRecordProcessStatus,
  type LocalRecordSummary,
  type LocalRecordTimelineEvent,
  securityCenterApi,
} from "@/lib/api/security-center";
import { cn } from "@/lib/utils";
import { observerRequestScope, type ObserverRequestScope } from "@/lib/observer-request-scope";
import { indexToolSystemEvidence } from "@/lib/tool-system-evidence";

type DetailTab = "conversation" | "timeline" | "semantic_tree" | "link_awareness" | "trace" | "system_evidence" | "metrics";
type SemanticTreeFilter = "all" | "ai" | "tools";

const SYSTEM_EVIDENCE_BATCH_SIZE = 250;
const MAX_SYSTEM_EVIDENCE_EVENTS = 5_000;

interface SemanticTurn {
  key: string;
  turnId?: string;
  startedAt: number;
  completedAt?: number;
  events: SemanticTreeEventData[];
}

interface SemanticTreeEventData extends LocalRecordTimelineEvent {
  evidenceSource: "local_session" | "observer_ebpf";
  observerRequest?: LocalObservedLlmRequest;
  requestScope?: ObserverRequestScope;
}

const ACTIVITY_LABEL: Record<LocalRecordActivityStatus, string> = {
  active: "正在写入",
  recent: "近期写入",
  stopped: "历史记录",
};

const LIGHT_SELECT_ITEM_CLASS =
  "cursor-pointer text-slate-800 focus:bg-slate-100 focus:text-slate-950 data-[highlighted]:bg-slate-100 data-[highlighted]:text-slate-950";

const PROCESS_LABEL: Record<LocalRecordProcessStatus, string> = {
  running: "运行中",
  exited: "已退出",
  unknown: "未知",
};

function dateTime(value?: number) {
  if (!value) return "--";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function compactNumber(value?: number) {
  const count = Number(value) || 0;
  return new Intl.NumberFormat("zh-CN", {
    notation: count >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(count);
}

function bytes(value?: number) {
  const count = Number(value) || 0;
  if (count < 1024) return `${count} B`;
  if (count < 1024 ** 2) return `${(count / 1024).toFixed(1)} KiB`;
  if (count < 1024 ** 3) return `${(count / 1024 ** 2).toFixed(1)} MiB`;
  return `${(count / 1024 ** 3).toFixed(2)} GiB`;
}

function duration(value?: number) {
  const milliseconds = Math.max(0, Number(value) || 0);
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function elapsed(start?: number, end?: number) {
  if (!start || !end || end < start) return "--";
  return duration(end - start);
}

function KpiCard({
  label,
  value,
  caption,
  icon: Icon,
  tone = "teal",
}: {
  label: string;
  value: string | number;
  caption: string;
  icon: typeof Activity;
  tone?: "teal" | "blue" | "amber" | "violet";
}) {
  const toneClass = {
    teal: "border-teal-200 bg-teal-50 text-teal-700",
    blue: "border-sky-200 bg-sky-50 text-sky-700",
    amber: "border-amber-200 bg-amber-50 text-amber-700",
    violet: "border-violet-200 bg-violet-50 text-violet-700",
  }[tone];
  return (
    <div className="min-w-0 rounded-xl border border-slate-200 bg-white px-3.5 py-3 shadow-[0_8px_24px_rgba(15,23,42,0.06)]">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] text-slate-600">{label}</span>
        <span className={cn("rounded-md border p-1.5", toneClass)}>
          <Icon aria-hidden="true" className="size-3.5" />
        </span>
      </div>
      <div className="mt-1 font-mono text-xl font-semibold text-slate-950">{value}</div>
      <p className="mt-1 truncate text-[10px] text-slate-500">{caption}</p>
    </div>
  );
}

function ProcessStatusBadge({ item }: { item: LocalRecordSummary }) {
  const detail = item.processStatus === "running" && item.processPid
    ? item.processEvidence === "live_agent" || item.processEvidence === "sticky_binding"
      ? `Agent 进程 PID ${item.processPid} 仍在运行`
      : `精确关联 PID ${item.processPid}`
    : item.processStatus === "exited" && item.processPid
      ? `已观察到 PID ${item.processPid} 退出或切换 Session`
      : item.processPid && item.processEvidence === "ebpf_session_file"
        ? `Observer Session 文件写事件已绑定 PID ${item.processPid}；当前存活状态未知`
      : "尚未建立可信 Session 与 PID 绑定";
  return (
    <span
      title={detail}
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 whitespace-nowrap rounded border px-1.5 py-0.5 text-[9px] font-medium",
        item.processStatus === "running"
          ? "border-emerald-200 bg-emerald-50 text-emerald-700"
          : item.processStatus === "exited"
            ? "border-slate-200 bg-slate-100 text-slate-600"
            : "border-amber-200 bg-amber-50 text-amber-800",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          item.processStatus === "running"
            ? "bg-emerald-500"
            : item.processStatus === "exited"
              ? "bg-slate-400"
              : "bg-amber-500",
        )}
      />
      {PROCESS_LABEL[item.processStatus]}
    </span>
  );
}

function RecordActivityBadge({ status }: { status: LocalRecordActivityStatus }) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 whitespace-nowrap rounded border px-1.5 py-0.5 text-[9px]",
        status === "active"
          ? "border-sky-200 bg-sky-50 text-sky-700"
          : status === "recent"
            ? "border-amber-200 bg-amber-50 text-amber-800"
            : "border-slate-200 bg-white text-slate-500",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          status === "active"
            ? "bg-sky-500"
            : status === "recent"
              ? "bg-amber-500"
              : "bg-slate-400",
        )}
      />
      {ACTIVITY_LABEL[status]}
    </span>
  );
}

function adapterLabel(adapter: LocalRecordSummary["adapter"]): string {
  if (adapter === "a3s_code") return "A3S Code";
  if (adapter === "claude_code") return "Claude Code";
  if (adapter === "opencode") return "OpenCode";
  if (adapter === "kimi_cli") return "Kimi Code CLI";
  if (adapter === "gemini_cli") return "Gemini CLI";
  return "Codex";
}

function processBindingLabel(item: LocalRecordSummary): string {
  if (!item.processPid) return "未建立 Session↔PID 绑定";
  return item.processEvidence === "ebpf_session_file"
    ? `Session 写事件 · PID ${item.processPid}`
    : `Session FD · PID ${item.processPid}`;
}

function RecordOverviewCard({
  item,
  onOpen,
}: {
  item: LocalRecordSummary;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`打开 ${adapterLabel(item.adapter)} 会话：${item.title}`}
      className="w-full rounded-xl border border-slate-200 bg-white px-3.5 py-3 text-left shadow-sm transition-colors hover:border-teal-300 hover:bg-teal-50/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="truncate text-sm font-semibold text-slate-950">{adapterLabel(item.adapter)}</span>
          <ProcessStatusBadge item={item} />
          <RecordActivityBadge status={item.activityStatus} />
        </div>
        <span className="shrink-0 font-mono text-[10px] text-slate-500">
          {dateTime(item.updatedAt)}
        </span>
      </div>
      <p className="mt-2 line-clamp-2 text-xs leading-5 text-slate-800">{item.title}</p>
      <p className="mt-1.5 truncate font-mono text-[10px] text-slate-500">
        {item.cwd || "Workspace 未记录"}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-slate-600">
        <span>{item.model || item.modelProvider || "model 未知"}</span>
        <span>{compactNumber(item.tokenUsage.totalTokens)} Token</span>
        <span>{item.toolCallCount} 工具</span>
        <span>{bytes(item.fileBytes)}</span>
        {item.metricScope === "recent_window" ? (
          <span className="text-amber-700">窗口统计</span>
        ) : null}
        <ChevronRight aria-hidden="true" className="ml-auto size-3.5 text-slate-400" />
      </div>
    </button>
  );
}

function RecordOverviewTable({
  items,
  onOpen,
}: {
  items: LocalRecordSummary[];
  onOpen: (recordId: string) => void;
}) {
  return (
    <>
      <div className="hidden min-h-0 overflow-auto lg:block">
        <div className="min-w-[1100px]">
          <div className="grid grid-cols-[105px_105px_150px_minmax(300px,1fr)_110px_80px_100px_120px_24px] items-center gap-3 border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-[10px] font-medium text-slate-500">
            <span>进程状态</span>
            <span>记录状态</span>
            <span>Agent / 模型</span>
            <span>会话首条指令</span>
            <span className="text-right">观测 Token</span>
            <span className="text-right">工具</span>
            <span className="text-right">记录大小</span>
            <span className="text-right">最近更新</span>
            <span />
          </div>
          {items.map((item) => (
            <button
              key={item.recordId}
              type="button"
              onClick={() => onOpen(item.recordId)}
              aria-label={`打开 ${adapterLabel(item.adapter)} 会话：${item.title}`}
              className="grid w-full grid-cols-[105px_105px_150px_minmax(300px,1fr)_110px_80px_100px_120px_24px] items-center gap-3 border-b border-slate-100 px-4 py-3 text-left transition-colors hover:bg-teal-50/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-600"
            >
              <span className="min-w-0">
                <ProcessStatusBadge item={item} />
                <span className="mt-1 block truncate font-mono text-[8px] text-slate-500">
                  {item.processPid ? `PID ${item.processPid}` : "PID 未知"}
                </span>
              </span>
              <span><RecordActivityBadge status={item.activityStatus} /></span>
              <span className="min-w-0">
                <span className="block truncate text-xs font-semibold text-slate-950">{adapterLabel(item.adapter)}</span>
                <span className="mt-0.5 block truncate font-mono text-[9px] text-slate-500">
                  {item.model || item.modelProvider || "model 未知"}
                </span>
              </span>
              <span className="min-w-0">
                <span className="block truncate text-xs font-medium text-slate-800">{item.title}</span>
                <span className="mt-1 block truncate font-mono text-[9px] text-slate-500">
                  {item.cwd || "Workspace 未记录"}
                </span>
              </span>
              <span className="text-right">
                <span className="block font-mono text-xs text-slate-800">
                  {compactNumber(item.tokenUsage.totalTokens)}
                </span>
                <span className="mt-0.5 block text-[8px] text-slate-500">
                  {item.metricScope === "recent_window" ? "窗口统计" : "完整统计"}
                </span>
              </span>
              <span className="text-right font-mono text-xs text-slate-700">
                {compactNumber(item.toolCallCount)}
              </span>
              <span className="text-right font-mono text-[10px] text-slate-600">
                {bytes(item.fileBytes)}
              </span>
              <span className="text-right font-mono text-[9px] text-slate-600">
                {dateTime(item.updatedAt)}
              </span>
              <ChevronRight aria-hidden="true" className="size-3.5 text-slate-400" />
            </button>
          ))}
        </div>
      </div>
      <div className="grid gap-2 p-3 lg:hidden">
        {items.map((item) => (
          <RecordOverviewCard
            key={item.recordId}
            item={item}
            onOpen={() => onOpen(item.recordId)}
          />
        ))}
      </div>
    </>
  );
}

function EventIcon({ event }: { event: LocalRecordTimelineEvent }) {
  const className = "size-4";
  if (event.kind === "user_message") return <UserRound className={className} />;
  if (event.kind === "assistant_message") return <Bot className={className} />;
  if (event.kind === "tool_call") return <TerminalSquare className={className} />;
  if (event.kind === "tool_result") {
    return event.status === "failure"
      ? <XCircle className={className} />
      : <CheckCircle2 className={className} />;
  }
  if (event.kind === "turn_complete") return <Clock3 className={className} />;
  return <CircleDot className={className} />;
}

function TimelineEvent({ event }: { event: LocalRecordTimelineEvent }) {
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  const preview = (event.command || event.content || event.title).slice(0, 500).replace(/\s+/g, " ").trim();
  const tone =
    event.kind === "user_message"
      ? "border-sky-200 bg-sky-50 text-sky-700"
      : event.kind === "assistant_message"
        ? "border-emerald-200 bg-emerald-50 text-emerald-700"
        : event.kind === "tool_call"
          ? "border-violet-200 bg-violet-50 text-violet-700"
          : event.status === "failure"
            ? "border-rose-200 bg-rose-50 text-rose-700"
            : "border-slate-200 bg-white text-slate-600";
  return (
    <article
      data-timeline-event={event.kind}
      className={cn(
        "relative min-w-0 overflow-hidden rounded-xl border",
        tone,
      )}
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={contentId}
        aria-label={`${expanded ? "收起" : "展开"} ${event.title} ${dateTime(event.timestamp)}`}
        onClick={() => setExpanded((value) => !value)}
        className="flex min-h-11 w-full min-w-0 items-center gap-2 px-3.5 py-2.5 text-left hover:bg-white/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-600"
      >
        <span aria-hidden="true" className="shrink-0"><EventIcon event={event} /></span>
        <span className="max-w-[40%] shrink-0 truncate text-xs font-semibold text-slate-950">{event.title}</span>
        {event.phase ? (
          <span className="hidden shrink-0 rounded border border-slate-200 bg-white/70 px-1.5 py-0.5 text-[9px] uppercase text-slate-600 sm:inline">
            {event.phase}
          </span>
        ) : null}
        {event.status === "failure" ? (
          <span className="shrink-0 rounded border border-rose-200 bg-rose-100 px-1.5 py-0.5 text-[9px] text-rose-700">
            失败
          </span>
        ) : null}
        <span data-timeline-preview className="min-w-0 flex-1 truncate text-xs text-slate-600">{preview}</span>
        <span className="hidden shrink-0 font-mono text-[10px] text-slate-500 sm:inline">
          {dateTime(event.timestamp)}
        </span>
        <ChevronRight aria-hidden="true" className={cn("size-3.5 shrink-0", expanded && "rotate-90")} />
      </button>
      <div id={contentId} hidden={!expanded}>
        {expanded ? (
          <div className="border-t border-slate-200/60 px-3.5 pb-3">
            <span className="mt-2 block font-mono text-[10px] text-slate-500 sm:hidden">{dateTime(event.timestamp)}</span>
            {event.command ? (
              <div className="mt-3 rounded-lg border border-violet-200 bg-white/80 px-3 py-2.5">
                <div className="mb-1.5 flex items-center gap-2 text-[10px] text-violet-700">
                  <TerminalSquare aria-hidden="true" className="size-3" />
                  <span>命令</span>
                  {event.workdir ? (
                    <span className="truncate font-mono text-slate-500">{event.workdir}</span>
                  ) : null}
                </div>
                <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-slate-800 [overflow-wrap:anywhere]">
                  {event.command}
                </pre>
              </div>
            ) : null}
            {event.content && event.content !== event.command ? (
              <pre
                className={cn(
                  "mt-3 whitespace-pre-wrap break-words text-xs leading-5 text-slate-700 [overflow-wrap:anywhere]",
                  (event.kind === "tool_call" || event.kind === "tool_result")
                    && "max-h-[360px] overflow-auto rounded-lg border border-slate-200 bg-white/80 p-3 font-mono text-[11px]",
                )}
              >
                {event.content}
              </pre>
            ) : null}
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[9px] text-slate-500">
              {event.turnId ? <span>turn {event.turnId.slice(0, 12)}</span> : null}
              {event.toolName ? <span>tool {event.toolName}</span> : null}
              {event.durationMs !== undefined ? <span>耗时 {duration(event.durationMs)}</span> : null}
              {event.timeToFirstTokenMs !== undefined ? (
                <span>TTFT {duration(event.timeToFirstTokenMs)}</span>
              ) : null}
              <span>offset {event.sourceOffset}</span>
            </div>
          </div>
        ) : null}
      </div>
    </article>
  );
}

function ConversationMessage({ event }: { event: LocalRecordTimelineEvent }) {
  const isUser = event.kind === "user_message";
  const roleLabel = isUser ? "用户指令" : "Agent 回复";
  const content = event.content?.trim() || event.title;

  return (
    <article
      data-conversation-role={isUser ? "user" : "assistant"}
      role="listitem"
      className={cn("flex w-full", isUser ? "justify-end" : "justify-start")}
      aria-label={`${roleLabel}，${dateTime(event.timestamp)}`}
    >
      <div
        data-conversation-bubble
        className={cn(
          "w-fit max-w-[92%] rounded-2xl px-4 py-3 shadow-sm",
          isUser
            ? "rounded-br-md bg-slate-950 text-white"
            : "rounded-bl-md border border-slate-200 bg-slate-100 text-slate-900",
        )}
      >
        <div
          className={cn(
            "mb-2 flex items-center justify-between gap-4 text-[10px]",
            isUser ? "text-slate-300" : "text-slate-500",
          )}
        >
          <span className="flex items-center gap-1.5 font-medium">
            {isUser ? (
              <UserRound aria-hidden="true" className="size-3.5" />
            ) : (
              <Bot aria-hidden="true" className="size-3.5" />
            )}
            {roleLabel}
          </span>
          <span className="shrink-0 font-mono">{dateTime(event.timestamp)}</span>
        </div>
        <div className="whitespace-pre-wrap break-words text-[13px] leading-6 [overflow-wrap:anywhere]">
          {content}
        </div>
        {event.turnId ? (
          <div
            className={cn(
              "mt-2 font-mono text-[9px]",
              isUser ? "text-slate-400" : "text-slate-500",
            )}
          >
            turn {event.turnId.slice(0, 12)}
          </div>
        ) : null}
      </div>
    </article>
  );
}

function semanticTurns(events: SemanticTreeEventData[]): SemanticTurn[] {
  const turns = new Map<string, SemanticTurn>();
  let activeTurnKey: string | undefined;

  for (const event of events) {
    if (event.kind === "turn_start") {
      activeTurnKey = event.turnId
        ? `turn:${event.turnId}`
        : `observed:${event.sourceOffset}`;
    } else if (event.turnId) {
      activeTurnKey = `turn:${event.turnId}`;
    }
    let key = event.turnId
      ? `turn:${event.turnId}`
      : activeTurnKey;
    if (!key) {
      key = `observed:${event.sourceOffset}`;
      activeTurnKey = key;
    }
    const existing = turns.get(key);
    const turn = existing ?? {
      key,
      turnId: event.turnId,
      startedAt: event.timestamp,
      events: [],
    };
    turn.events.push(event);
    turn.startedAt = Math.min(turn.startedAt, event.timestamp);
    if (event.kind === "turn_complete") {
      turn.completedAt = event.timestamp;
      activeTurnKey = undefined;
    }
    turns.set(key, turn);
  }

  return [...turns.values()].sort(
    (left, right) => left.startedAt - right.startedAt,
  );
}

function toolEvidenceHasDetail(match?: ToolEvidenceMatch) {
  if (!match) return false;
  return match.confirmed.length > 0
    || match.candidates.length > 0
    || Boolean(match.ambiguousCallId)
    || match.checked === false
    || match.status === "pending"
    || match.status === "unsupported";
}

function assignKernelEvents(turns: SemanticTurn[], events: SystemEvent[]) {
  const ordered = [...turns].sort((left, right) => left.startedAt - right.startedAt);
  const grouped = new Map<string, SystemEvent[]>();
  for (const turn of ordered) grouped.set(turn.key, []);
  if (!ordered.length) return grouped;
  const endOf = (turn: SemanticTurn) => turn.completedAt
    ?? turn.events.reduce((end, event) => Math.max(end, event.timestamp), turn.startedAt);
  const distance = (turn: SemanticTurn, at: number) => at < turn.startedAt
    ? turn.startedAt - at
    : at > endOf(turn) ? at - endOf(turn) : 0;
  for (const event of events) {
    const containing = ordered
      .filter((turn) => event.at >= turn.startedAt && event.at <= endOf(turn))
      .sort((left, right) => (endOf(left) - left.startedAt) - (endOf(right) - right.startedAt));
    const turn = containing[0] ?? ordered.reduce((best, item) =>
      distance(item, event.at) < distance(best, event.at) ? item : best);
    grouped.get(turn.key)?.push(event);
  }
  return grouped;
}

function KernelTimelineEvent({ event }: { event: SystemEvent }) {
  return (
    <article data-kernel-event={event.eventId} className="rounded-lg border border-amber-200 bg-amber-50/80 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2 text-[10px] text-amber-900">
        <TerminalSquare aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="font-semibold">内核事件</span>
        <span className="rounded border border-amber-200 bg-white px-1.5 py-0.5">{event.eventKind}</span>
        <span className="ml-auto font-mono text-amber-800">{dateTime(event.at)}</span>
      </div>
      <p className="mt-1 break-words font-mono text-[11px] leading-5 text-slate-800">{event.command || event.subject}</p>
      <p className="mt-1 font-mono text-[9px] text-slate-500">PID {event.pid ?? "未知"} · {event.relation}</p>
    </article>
  );
}

function semanticEventVisible(
  event: SemanticTreeEventData,
  filter: SemanticTreeFilter,
) {
  if (filter === "ai") {
    return event.kind === "user_message" || event.kind === "assistant_message";
  }
  if (filter === "tools") {
    return event.kind === "tool_call" || event.kind === "tool_result";
  }
  return true;
}

function SemanticTreeEvent({ event }: { event: SemanticTreeEventData }) {
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  const isPrompt = event.kind === "user_message";
  const isObserverPrompt =
    isPrompt && event.evidenceSource === "observer_ebpf";
  const collapsible = isObserverPrompt && (event.requestScope === "auto_review" || event.requestScope === "related_thread");
  const Header = collapsible ? "button" : "div";
  const isResponse = event.kind === "assistant_message";
  const isTool = event.kind === "tool_call";
  const isResult = event.kind === "tool_result";
  const nestedResult = isResult && Boolean(event.callId);
  const label = isObserverPrompt
    ? event.requestScope === "auto_review"
      ? "自动审核请求"
      : event.requestScope === "related_thread"
        ? "关联线程请求"
        : "模型请求"
    : isPrompt
      ? "用户指令（Session）"
    : isResponse
      ? "AI 响应"
      : isTool
        ? "工具调用"
        : isResult
          ? "工具结果"
          : event.kind === "turn_start"
            ? "Turn 开始"
            : "Turn 完成";
  const tone = isObserverPrompt
    ? "border-sky-200 bg-sky-50"
    : isPrompt || isResponse
      ? "border-emerald-200 bg-emerald-50"
      : isTool
        ? "border-violet-200 bg-violet-50"
        : event.status === "failure"
          ? "border-rose-200 bg-rose-50"
          : "border-slate-200 bg-white";
  const labelTone = isObserverPrompt
    ? "border-sky-200 bg-sky-100 text-sky-800"
    : isPrompt || isResponse
      ? "border-emerald-200 bg-emerald-100 text-emerald-800"
      : isTool
        ? "border-violet-200 bg-violet-100 text-violet-800"
        : event.status === "failure"
          ? "border-rose-200 bg-rose-100 text-rose-800"
          : "border-slate-200 bg-slate-100 text-slate-700";

  return (
    <div className={cn("relative", nestedResult && "ml-5")}>
      <span
        aria-hidden="true"
        className="absolute -left-[17px] top-5 h-px w-4 bg-slate-200"
      />
      <article
        data-semantic-kind={isObserverPrompt ? "observer_ai_prompt" : event.kind}
        data-evidence-source={event.evidenceSource}
        data-request-scope={event.requestScope}
        className={cn("rounded-lg border px-3 py-2.5", tone)}
      >
        <Header
          type={collapsible ? "button" : undefined}
          aria-expanded={collapsible ? expanded : undefined}
          aria-controls={collapsible ? contentId : undefined}
          onClick={collapsible ? () => setExpanded((value) => !value) : undefined}
          className={cn("flex min-w-0 flex-wrap items-center gap-2", collapsible && "w-full rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2")}
        >
          {collapsible ? <ChevronDown aria-hidden="true" className={cn("size-3.5 shrink-0 text-sky-700", !expanded && "-rotate-90")} /> : null}
          <span className={cn("rounded border px-1.5 py-0.5 text-[9px] font-semibold", labelTone)}>
            {label}
          </span>
          {isObserverPrompt ? (
            <>
              {event.observerRequest?.model ? (
                <span className="rounded border border-sky-200 bg-white/80 px-1.5 py-0.5 font-mono text-[9px] uppercase text-sky-800">
                  {event.observerRequest.model}
                </span>
              ) : null}
              <span className="rounded border border-slate-200 bg-white/80 px-1.5 py-0.5 text-[9px] font-semibold text-slate-700">
                REQUEST
              </span>
              <span className="rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-700">
                OBSERVED
              </span>
              <span className="rounded border border-slate-200 bg-white/80 px-1.5 py-0.5 font-mono text-[9px] text-slate-700">
                PID {event.observerRequest?.pid}
              </span>
            </>
          ) : null}
          {event.toolName ? (
            <span className="rounded border border-slate-200 bg-white/70 px-1.5 py-0.5 font-mono text-[9px] uppercase text-slate-600">
              {event.toolName}
            </span>
          ) : null}
          {isTool ? (
            <span className="rounded border border-amber-200 bg-amber-100 px-1.5 py-0.5 text-[9px] text-amber-800">
              声明执行
            </span>
          ) : null}
          {event.status === "failure" ? (
            <span className="text-[9px] text-rose-700">失败</span>
          ) : null}
          <span className="ml-auto shrink-0 font-mono text-[9px] text-slate-500">
            {dateTime(event.timestamp)}
          </span>
          {collapsible ? <span className="text-[10px] text-sky-700">{expanded ? "收起" : "展开"}</span> : null}
        </Header>
        <div id={contentId} hidden={collapsible && !expanded}>
        {isObserverPrompt && event.observerRequest ? (
          <div className="mt-2 space-y-2">
            {event.requestScope && event.requestScope !== "main" ? (
              <div className="space-y-1 font-mono text-[10px] text-slate-600 [overflow-wrap:anywhere]">
                <p>Thread：{event.observerRequest.threadId || "未记录"}</p>
                <p>Turn：{event.observerRequest.turnId || "未记录"}</p>
                <p>Interaction：{event.observerRequest.interactionId}</p>
              </div>
            ) : null}
            <div className="rounded-md border border-sky-200 bg-white/80 px-3 py-2.5">
              {event.observerRequest.contentAvailability === "available"
                && event.content !== undefined ? (
                  <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-5 text-slate-800">
                    {event.content}
                  </pre>
                ) : (
                  <p className="text-[10px] leading-5 text-amber-800">
                    Observer 已捕获请求元数据，但正文
                    {event.observerRequest.contentAvailability === "not_requested"
                      ? "尚未加载"
                      : event.observerRequest.contentAvailability === "not_authorized"
                      ? "未获本机直显授权"
                      : event.observerRequest.contentAvailability === "deleted"
                        ? "已按保留策略删除"
                        : "当前不可读取"}
                    。
                  </p>
                )}
            </div>
            <div className="grid gap-1.5 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-2 font-mono text-[9px] text-slate-600 sm:grid-cols-2">
              <span className="truncate">
                {event.observerRequest.protocol.toUpperCase()} · {event.observerRequest.providerHost}
              </span>
              <span className="truncate sm:text-right">
                {event.observerRequest.requestPath}
                {event.observerRequest.endpointAttribution === "configured_endpoint"
                  || event.observerRequest.endpointAttribution === "configured_late_attach"
                  ? " · 端点由受控配置归因"
                  : " · 端点已观测"}
              </span>
            </div>
          </div>
        ) : event.command ? (
          <div className="mt-2 rounded-md border border-violet-200 bg-white/80 px-2.5 py-2">
            <div className="mb-1 flex flex-wrap items-center gap-2 text-[9px] text-violet-700">
              <TerminalSquare aria-hidden="true" className="size-3" />
              <span>Tool Call 命令参数</span>
              {event.workdir ? (
                <span className="truncate font-mono text-slate-500">{event.workdir}</span>
              ) : null}
            </div>
            <pre className="max-h-44 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-5 text-slate-800">
              {event.command}
            </pre>
          </div>
        ) : event.content ? (
          <pre
            className={cn(
              "mt-2 max-h-52 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-5 text-slate-700",
              isResult && "rounded-md border border-slate-200 bg-white/80 p-2.5 font-mono text-[10px]",
            )}
          >
            {event.content}
          </pre>
        ) : (
          <p className="mt-1.5 text-[10px] text-slate-600">{event.title}</p>
        )}
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 font-mono text-[8px] text-slate-500">
          {event.callId ? <span>call {event.callId.slice(0, 16)}</span> : null}
          {isObserverPrompt && event.observerRequest ? (
            <>
              <span>AnySentry Observer · eBPF/Rustls</span>
              <span>sha256 {event.observerRequest.contentSha256.slice(0, 16)}</span>
              <span>{event.observerRequest.capture.completeness}</span>
            </>
          ) : (
            <span>Session offset {event.sourceOffset}</span>
          )}
        </div>
        </div>
      </article>
    </div>
  );
}

function SemanticTreePanel({
  detail,
  events,
  hasMore,
  olderLoading,
  onLoadOlder,
  contentLoading,
  contentError,
  onRetryContent,
  linkAwareness = false,
  evidenceLoading = false,
  evidenceError = false,
}: {
  detail: LocalRecordDetail;
  events: LocalRecordTimelineEvent[];
  hasMore: boolean;
  olderLoading: boolean;
  onLoadOlder: () => void;
  contentLoading: boolean;
  contentError: boolean;
  onRetryContent: () => void;
  linkAwareness?: boolean;
  evidenceLoading?: boolean;
  evidenceError?: boolean;
}) {
  const [filter, setFilter] = useState<SemanticTreeFilter>("all");
  const [collapsedTurns, setCollapsedTurns] = useState<Set<string>>(
    () => new Set(),
  );
  const semanticEvents = useMemo<SemanticTreeEventData[]>(() => {
    const sessionEvents = events.map((event) => ({
      ...event,
      evidenceSource: "local_session" as const,
    }));
    const observerEvents = detail.observedLlmRequests.map(
      (request): SemanticTreeEventData => ({
        eventId: request.interactionId,
        kind: "user_message",
        timestamp: request.observedAt,
        ...(request.turnId ? { turnId: request.turnId } : {}),
        role: "user",
        title: "Observer 捕获的模型请求用户消息",
        ...(request.content !== undefined ? { content: request.content } : {}),
        status: "observed",
        sourceOffset: 0,
        evidenceSource: "observer_ebpf",
        observerRequest: request,
        requestScope: observerRequestScope(request, detail.record.sessionId),
      }),
    );
    return [...sessionEvents, ...observerEvents].sort(
      (left, right) =>
        left.timestamp - right.timestamp
        || (
          left.evidenceSource === right.evidenceSource
            ? left.eventId.localeCompare(right.eventId)
            : left.evidenceSource === "local_session" ? -1 : 1
        ),
    );
  }, [detail.observedLlmRequests, detail.record.sessionId, events]);
  const relatedRequests = useMemo(() => semanticEvents.filter((event) =>
    event.requestScope === "auto_review" || event.requestScope === "related_thread"), [semanticEvents]);
  const turns = useMemo(() => semanticTurns(semanticEvents.filter((event) =>
    !event.requestScope || event.requestScope === "main"))
    // Boundaries still determine grouping, but are not content cards in this tab.
    .map((turn) => ({
      ...turn,
      events: turn.events.filter((event) =>
        event.kind !== "turn_start" && event.kind !== "turn_complete"),
    }))
    .filter((turn) => turn.events.length > 0), [semanticEvents]);
  const semanticEventCount = turns.reduce((count, turn) => count + turn.events.length, 0) + relatedRequests.length;
  const promptCount = detail.observedLlmRequests.length;
  const responseCount = events.filter((event) => event.kind === "assistant_message").length;
  const toolCount = events.filter((event) => event.kind === "tool_call").length;
  const observerEvidence = detail.provenance.observerRequestEvidence;
  const toolEvidence = useMemo(() => linkAwareness
    ? indexToolSystemEvidence(detail.record.sessionId, events, detail.systemEvidence, detail.toolEvidence)
    : undefined, [linkAwareness, detail.record.sessionId, events, detail.systemEvidence, detail.toolEvidence]);
  const kernelByTurn = useMemo(() => {
    if (!linkAwareness || detail.systemEvidence?.binding.nativeSessionId !== detail.record.sessionId) {
      return new Map<string, SystemEvent[]>();
    }
    return assignKernelEvents(turns, detail.systemEvidence.events);
  }, [linkAwareness, detail.record.sessionId, detail.systemEvidence, turns]);
  function toggleTurn(key: string) {
    setCollapsedTurns((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <div data-link-awareness={linkAwareness || undefined} data-observer-evidence={observerEvidence} className="mx-auto max-w-6xl space-y-3">
      {contentLoading ? (
        <p role="status" aria-live="polite" className="text-xs text-slate-600">正在加载模型请求正文…</p>
      ) : contentError ? (
        <div role="alert" className="flex items-center gap-2 text-xs text-amber-800">
          正文请求失败；已加载内容保留，尚未加载的正文可重试。
          <Button variant="outline" size="sm" onClick={onRetryContent}>重试正文</Button>
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <DetailMetric label="模型请求" value={compactNumber(promptCount)} caption="已加载 Observer 请求记录" />
        <DetailMetric label="AI 响应" value={compactNumber(responseCount)} caption="Session 可见回复" />
        <DetailMetric label="工具调用" value={compactNumber(toolCount)} caption="Agent 声明记录" />
        <DetailMetric
          label="进程状态"
          value={PROCESS_LABEL[detail.record.processStatus]}
          caption={
            processBindingLabel(detail.record)
          }
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 shadow-sm">
        <div className="flex items-center gap-1">
          {([
            ["all", "全部关系"],
            ["ai", "仅 AI"],
            ["tools", "仅工具"],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
              className={cn(
                "rounded-md px-2.5 py-1.5 text-[10px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400",
                filter === value
                  ? "bg-cyan-100 text-cyan-800"
                  : "text-slate-600 hover:bg-slate-100 hover:text-slate-900",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        {hasMore ? (
          <Button
            variant="outline"
            size="sm"
            onClick={onLoadOlder}
            disabled={olderLoading}
            className="h-7 border-slate-200 bg-white text-[10px] text-slate-700 hover:bg-slate-50"
          >
            {olderLoading ? (
              <LoaderCircle aria-hidden="true" className="mr-1.5 size-3 animate-spin" />
            ) : (
              <ChevronDown aria-hidden="true" className="mr-1.5 size-3 rotate-180" />
            )}
            加载更早关系
          </Button>
        ) : null}
      </div>

      <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-3.5 py-3">
          <span className="rounded-md border border-teal-200 bg-teal-50 p-1.5 text-teal-700">
            <FileCode2 aria-hidden="true" className="size-4" />
          </span>
          <div className="min-w-0">
            <h3 className="truncate text-xs font-semibold text-slate-950">{adapterLabel(detail.record.adapter)} Session</h3>
            <p className="truncate font-mono text-[9px] text-slate-500">
              {detail.record.sessionId} · {detail.record.processPid
                ? `PID ${detail.record.processPid}`
                : "PID 未知"}
            </p>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-1.5 text-[9px] text-slate-600">
            <span className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5">已加载 {turns.length} 个分组</span>
            {relatedRequests.length > 0 ? (
              <span className="rounded border border-sky-200 bg-sky-50 px-1.5 py-0.5">{relatedRequests.length} 条独立请求</span>
            ) : null}
            <span className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5">{semanticEventCount} 语义事件</span>
          </div>
        </div>

        {turns.length > 0 ? (
          <div className="space-y-3 p-3">
            {[...turns].reverse().map((turn, index) => {
              const turnEvents = turn.events.filter((event) =>
                semanticEventVisible(event, filter));
              const kernel = filter === "ai" ? [] : (kernelByTurn.get(turn.key) ?? []);
              const collapsed = collapsedTurns.has(turn.key);
              if (turnEvents.length === 0 && kernel.length === 0) return null;
              const timeline = [
                ...turnEvents.map((event) => ({ kind: "semantic" as const, at: event.timestamp, id: event.eventId, event })),
                ...kernel.map((event) => ({ kind: "kernel" as const, at: event.at, id: event.eventId, event })),
              ].sort((left, right) => left.at - right.at || left.id.localeCompare(right.id));
              return (
                <section
                  key={turn.key}
                  className="rounded-lg border border-slate-200 bg-slate-50/70"
                >
                  <button
                    type="button"
                    data-semantic-turn={turn.key}
                    aria-expanded={!collapsed}
                    onClick={() => toggleTurn(turn.key)}
                    className="flex w-full items-center gap-2 px-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-400"
                  >
                    <ChevronDown
                      aria-hidden="true"
                      className={cn(
                        "size-3.5 text-slate-500 transition-transform",
                        collapsed && "-rotate-90",
                      )}
                    />
                    <GitBranch aria-hidden="true" className="size-3.5 text-cyan-700" />
                    <span className="text-[11px] font-semibold text-slate-800">
                      {turn.turnId ? "Turn 分组" : "未确认 Turn 分组"} {turns.length - index}
                    </span>
                    {turn.turnId ? (
                      <span className="truncate font-mono text-[9px] text-slate-500">
                        {turn.turnId}
                      </span>
                    ) : (
                      <span className="text-[9px] text-amber-700">Turn ID 未记录</span>
                    )}
                    <span className="ml-auto shrink-0 text-[9px] text-slate-500">
                      {timeline.length} 事件 · {dateTime(turn.startedAt)}
                    </span>
                  </button>
                  {!collapsed ? (
                    <div className="ml-6 space-y-2 border-l border-slate-200 px-4 pb-3">
                      {timeline.map((item) => item.kind === "kernel" ? (
                        <KernelTimelineEvent key={item.id} event={item.event} />
                      ) : (
                        <div key={item.id} className="space-y-1.5">
                          <SemanticTreeEvent event={item.event} />
                          {linkAwareness && item.event.kind === "tool_call" && toolEvidenceHasDetail(toolEvidence?.byEvent.get(item.event.eventId)) ? <ToolSystemEvidence call={item.event} match={toolEvidence?.byEvent.get(item.event.eventId)} loading={evidenceLoading} error={evidenceError} /> : null}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </section>
              );
            })}
          </div>
        ) : (
          <OperationalEmptyState
            appearance="light"
            icon={GitBranch}
            title={relatedRequests.length > 0 ? "当前窗口没有主对话 Turn" : "当前窗口没有关系节点"}
            description={relatedRequests.length > 0 ? "已捕获的自动审核或关联线程请求在下方独立保留。" : hasMore ? "加载更早记录后可继续构建 Session 关系树。" : "源 Session 没有可关联事件。"}
          />
        )}
      </section>
      {relatedRequests.length > 0 && filter !== "tools" ? (
        <section data-related-requests aria-label="自动审核请求／关联线程" className="rounded-xl border border-sky-200 bg-white shadow-sm">
          <div className="border-b border-sky-100 px-3.5 py-3">
            <h3 className="text-xs font-semibold text-sky-900">自动审核请求／关联线程</h3>
          </div>
          <div className="space-y-2 p-3 pl-6">
            {relatedRequests.map((event) => <SemanticTreeEvent key={event.eventId} event={event} />)}
          </div>
        </section>
      ) : null}
      {linkAwareness && toolEvidence && filter !== "ai" ? <details data-unassigned-system-evidence className="rounded-xl border border-slate-200 bg-white">
        <summary className="cursor-pointer px-3.5 py-3 text-[11px] font-semibold text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-400">Session 系统证据 · 尚未确认属于某个 Tool Call（{toolEvidence.unassigned.length} 条）</summary>
        <div className="space-y-2 border-t border-slate-200 p-3">
          <SystemEventRows events={toolEvidence.unassigned} />
        </div>
      </details> : null}
    </div>
  );
}

function DetailMetric({
  label,
  value,
  caption,
}: {
  label: string;
  value: string;
  caption?: string;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2.5 shadow-sm">
      <p className="text-[10px] text-slate-600">{label}</p>
      <p className="mt-1 font-mono text-sm font-semibold text-slate-950">{value}</p>
      {caption ? <p className="mt-1 text-[9px] text-slate-500">{caption}</p> : null}
    </div>
  );
}

function SystemEvidencePanel({
  detail,
  loadingMore,
  onLoadMore,
}: {
  detail: LocalRecordDetail;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  const evidence = detail.systemEvidence;
  if (!evidence) {
    return (
      <OperationalEmptyState
        appearance="light"
        icon={GitBranch}
        title="尚未建立系统证据归属"
        description="需要 Session FD 精确绑定与同一进程代际的 Observer 生命周期事实；不会按名称、Workspace 或时间接近强行归属。"
      />
    );
  }
  const totalRelations = evidence.page?.totalRelations
    ?? evidence.counts.direct + evidence.counts.lineage;
  const loadedRelations = evidence.page?.loadedRelations ?? evidence.events.length;
  const unavailableEvents = evidence.page?.unavailableEvents ?? 0;
  const canLoadMore = Boolean(evidence.page?.hasMore)
    && (evidence.page?.requestedLimit ?? evidence.events.length) < MAX_SYSTEM_EVIDENCE_EVENTS;
  const processGroups = new Map<number | string, typeof evidence.events>();
  for (const event of evidence.events) {
    const key = event.pid ?? event.processInstanceKey;
    const values = processGroups.get(key) ?? [];
    values.push(event);
    processGroups.set(key, values);
  }
  const riskTone = (severity: string, verdict: string) => {
    if (verdict === "block" || severity === "critical") return "border-rose-300 bg-rose-50 text-rose-800";
    if (severity === "high") return "border-orange-300 bg-orange-50 text-orange-800";
    if (severity === "medium") return "border-amber-300 bg-amber-50 text-amber-800";
    return "border-slate-200 bg-slate-50 text-slate-700";
  };
  return (
    <div data-system-evidence className="mx-auto max-w-6xl space-y-3">
      <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-start gap-3 border-b border-slate-200 px-3.5 py-3">
          <span className="rounded-md border border-cyan-200 bg-cyan-50 p-1.5 text-cyan-700">
            <GitBranch aria-hidden="true" className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-xs font-semibold text-slate-950">Session 系统证据树</h3>
              <span className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[9px] text-slate-600">
                {evidence.completeness === "complete_as_observed" ? "观测范围完整" : evidence.completeness === "partial" ? "部分结果" : "证据不可用"}
              </span>
              {evidence.evidenceScope === "historical_persisted" ? (
                <span className="rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[9px] text-amber-800">
                  历史持久证据
                </span>
              ) : evidence.evidenceScope === "historical_reconstructed" ? (
                <span className="rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[9px] text-amber-800">
                  历史精确重建
                </span>
              ) : evidence.evidenceScope === "mixed" ? (
                <span className="rounded border border-sky-200 bg-sky-50 px-1.5 py-0.5 text-[9px] text-sky-800">
                  当前与历史证据
                </span>
              ) : null}
              {evidence.persistence === "degraded" ? (
                <span role="status" className="rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[9px] text-amber-800">
                  持久化降级
                </span>
              ) : null}
              {evidence.persistence === "not_checked" ? (
                <span className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[9px] text-slate-600"
                  title="本次只读计算未核验持久关系，不表示数据库写入失败。">
                  持久化状态未核验
                </span>
              ) : null}
            </div>
            <p className="mt-1 truncate font-mono text-[9px] text-slate-500">
              {evidence.conversationId} · root PID {evidence.binding.matchedPid} · rev {evidence.binding.bindingRevision}
            </p>
          </div>
        </div>
        <div className="grid grid-cols-2 divide-x divide-y divide-slate-200 md:grid-cols-5 md:divide-y-0">
          <DetailMetric label="直接归属" value={compactNumber(evidence.counts.direct)} caption="精确 Session 进程" />
          <DetailMetric label="血缘归属" value={compactNumber(evidence.counts.lineage)} caption="可信后代进程" />
          <DetailMetric label="歧义" value={compactNumber(evidence.counts.ambiguous)} caption="不进入确定证据树" />
          <DetailMetric label="冲突" value={compactNumber(evidence.counts.conflict)} caption="Agent 身份不一致" />
          <DetailMetric label="未归属" value={compactNumber(evidence.counts.unattributed)} caption={evidence.startupContext?.length ? `含 ${evidence.startupContext.length} 条身份切换前的启动上下文` : "保留原因，不强行吸收"} />
        </div>
      </section>

      {evidence.startupContext?.length ? (
        <details data-startup-context className="rounded-xl border border-slate-200 bg-slate-50 text-slate-700">
          <summary className="cursor-pointer px-3.5 py-3 text-[11px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500">
            启动上下文 · 身份切换前 {evidence.startupContext.length} 条事件
          </summary>
          <div className="space-y-2 border-t border-slate-200 px-3.5 py-3">
            {evidence.startupContext.map((item) => (
              <div key={item.eventId} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px]">
                <span className="font-mono">{dateTime(item.at)}</span>
                <span className="break-all font-mono">{item.eventId}</span>
                <span className="break-all">此前身份：{item.previousAgentInstanceId}</span>
              </div>
            ))}
          </div>
        </details>
      ) : null}

      {evidence.exceptions.length > 0 ? (
        <section className="rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-[11px] font-semibold text-amber-900">需要复核的归属结果</h3>
            <span className="font-mono text-[9px] text-amber-800">
              显示 {Math.min(20, evidence.exceptions.length)} / {evidence.exceptions.length}
            </span>
          </div>
          <div className="mt-2 space-y-1.5">
            {evidence.exceptions.slice(0, 20).map((item) => (
              <div key={item.resultId} className="flex items-center gap-2 font-mono text-[9px] text-amber-900">
                <span className="rounded border border-amber-300 bg-white/60 px-1.5 py-0.5">{item.status}</span>
                <span className="truncate">{item.eventId}</span>
                <span className="ml-auto shrink-0 font-sans text-amber-800" title={item.reason}>{item.reason === "agent_identity_conflict" ? "事件的 Agent 身份与会话不一致" : item.reason === "multiple_active_sessions" ? "多个活动会话竞争归属" : item.reason}</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section
        data-system-evidence-events={evidence.events.length}
        data-system-evidence-loaded-relations={loadedRelations}
        className="rounded-xl border border-slate-200 bg-white shadow-sm"
      >
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-3.5 py-3">
          <div>
            <h3 className="text-xs font-semibold text-slate-950">确定证据</h3>
            <p className="mt-0.5 text-[9px] text-slate-500">
              已展示 {evidence.events.length} 条事件 · 已回查最新 {loadedRelations} / {totalRelations} 条确定关系
              {unavailableEvents > 0 ? ` · ${unavailableEvents} 条源事件当前不可回查` : ""}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="font-mono text-[9px] text-slate-500">
              DIRECT / LINEAGE
            </span>
            {canLoadMore ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onLoadMore}
                disabled={loadingMore}
                className="h-7 border-slate-200 bg-white px-2.5 text-[10px] text-slate-700 hover:bg-slate-50"
              >
                {loadingMore ? (
                  <LoaderCircle aria-hidden="true" className="mr-1.5 size-3 animate-spin" />
                ) : (
                  <ChevronDown aria-hidden="true" className="mr-1.5 size-3" />
                )}
                再加载 {SYSTEM_EVIDENCE_BATCH_SIZE} 条关系
              </Button>
            ) : null}
          </div>
        </div>
        {evidence.events.length > 0 ? (
          <div className="divide-y divide-slate-200">
            {[...processGroups.entries()].map(([processKey, events]) => (
              <div key={String(processKey)} className="grid grid-cols-[150px_minmax(0,1fr)]">
                <div className="border-r border-slate-200 bg-slate-50/70 px-3 py-3">
                  <div className="flex items-center gap-1.5 text-[10px] font-semibold text-slate-800">
                    <TerminalSquare aria-hidden="true" className="size-3.5 text-cyan-700" />
                    PID {typeof processKey === "number" ? processKey : "未知"}
                  </div>
                  <p className="mt-1 font-mono text-[8px] text-slate-500">{events[0]?.processInstanceKey}</p>
                  <p className="mt-1 text-[9px] text-slate-500">{events.length} 条确定事件</p>
                </div>
                <div className="min-w-0 divide-y divide-slate-100">
                  {events.map((event) => (
                    <a
                      key={event.relationId}
                      href={`/events?eventId=${encodeURIComponent(event.eventId)}`}
                      className="grid min-h-14 grid-cols-[88px_92px_minmax(0,1fr)_86px_24px] items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-400"
                    >
                      <span className="font-mono text-[9px] text-slate-500">{dateTime(event.at)}</span>
                      <span className="text-[10px] font-medium text-slate-700">{event.eventKind}</span>
                      <span className="min-w-0">
                        <span className="block truncate text-[10px] font-medium text-slate-900">{event.subject}</span>
                        <span className="mt-0.5 block truncate font-mono text-[8px] text-slate-500">
                          {event.command || event.eventId}
                        </span>
                      </span>
                      <span className={cn("justify-self-start rounded border px-1.5 py-0.5 text-[9px]", riskTone(event.severity, event.verdict))}>
                        {event.riskScore} · {event.verdict}
                      </span>
                      <ChevronRight aria-hidden="true" className="size-3.5 text-slate-400" />
                    </a>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <OperationalEmptyState
            appearance="light"
            icon={TerminalSquare}
            title="当前会话没有确定的 Observer 单事件"
            description="可能尚未产生 ToolExec / ProcessExit，或进程血缘证据不足；系统不会用时间接近替代确定归属。"
          />
        )}
      </section>
    </div>
  );
}

export default function LocalRecordTrackingPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [search, setSearch] = useState("");
  const [adapterFilter, setAdapterFilter] = useState<"all" | "codex" | "a3s_code" | "claude_code" | "gemini_cli" | "kimi_cli" | "opencode">("all");
  const [activityFilter, setActivityFilter] = useState<LocalRecordActivityStatus | "all">("all");
  const [processFilter, setProcessFilter] = useState<LocalRecordProcessStatus | "all">("all");
  const selectedRecordId = searchParams.get("record") ?? "";
  const [detailTab, setDetailTab] = useState<DetailTab>("conversation");
  const [olderEvents, setOlderEvents] = useState<LocalRecordTimelineEvent[]>([]);
  const [olderBeforeOffset, setOlderBeforeOffset] = useState<number | undefined>();
  const [olderHasMore, setOlderHasMore] = useState<boolean | undefined>();
  const [evidenceLimit, setEvidenceLimit] = useState(SYSTEM_EVIDENCE_BATCH_SIZE);

  const listRequest = useRequest(
    () => securityCenterApi.localRecords({ limit: 300 }),
    {
      pollingInterval: 15_000,
      pollingWhenHidden: false,
      retryCount: 5,
      retryInterval: 1_500,
    },
  );
  const detailRequest = useRequest(
    () => securityCenterApi.localRecord(selectedRecordId, {
      limit: 250,
      includeSystemEvidence: false,
      // Keep the first render small. Observer metadata remains visible in the semantic-tree
      // counters; encrypted request bodies are fetched only when that tab is opened.
      includeObservedLlmRequests: true,
      includeObservedLlmRequestContent: false,
    }),
    {
      ready: Boolean(selectedRecordId),
      refreshDeps: [selectedRecordId],
      pollingInterval: 15_000,
      pollingWhenHidden: false,
      cacheKey: `local-record-detail:${selectedRecordId}`,
      // A fresh-cache return skips ahooks onFinally after cancelling its polling timer.
      // Revalidate on refresh so a quick click cannot freeze native events indefinitely.
      staleTime: 0,
    },
  );
  const observerContentRequest = useRequest(
    () => securityCenterApi.localRecord(selectedRecordId, {
      limit: 1,
      includeSystemEvidence: false,
      includeObservedLlmRequests: true,
      includeObservedLlmRequestContent: true,
    }),
    {
      ready: Boolean(selectedRecordId) && (detailTab === "semantic_tree" || detailTab === "link_awareness" || detailTab === "trace"),
      refreshDeps: [selectedRecordId, detailRequest.data?.observedLlmRequests.map((request) => request.interactionId).join(",")],
      cacheKey: `local-record-observer-content:${selectedRecordId}`,
      // Keep cached data visible, but refresh/retry must actually revalidate permissions/body state.
      staleTime: 0,
    },
  );
  const systemEvidenceRequest = useRequest(
    () => securityCenterApi.localRecordSystemEvidence(selectedRecordId, {
      evidenceLimit,
    }),
    {
      ready: Boolean(selectedRecordId) && (detailTab === "system_evidence" || detailTab === "link_awareness" || detailTab === "trace" || detailTab === "metrics"),
      refreshDeps: [selectedRecordId, evidenceLimit],
      cacheKey: `local-record-system-evidence:${selectedRecordId}:${evidenceLimit}`,
      // A normal conversation keeps producing events after this tab was opened. Re-read late
      // arrivals and resumed generations without requiring the user to refresh each tool call.
      pollingInterval: 15_000,
      pollingWhenHidden: false,
      // Explicit refresh/retry must revalidate, not return a recently cached success.
      staleTime: 0,
    },
  );
  const olderRequest = useRequest(
    (recordId: string, beforeOffset: number) =>
      securityCenterApi.localRecord(recordId, {
        limit: 250,
        beforeOffset,
        includeSystemEvidence: false,
      }),
    { manual: true },
  );

  const allItems = listRequest.data?.items ?? [];
  const filteredItems = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return allItems.filter((item) => {
      if (adapterFilter !== "all" && item.adapter !== adapterFilter) return false;
      if (activityFilter !== "all" && item.activityStatus !== activityFilter) return false;
      if (processFilter !== "all" && item.processStatus !== processFilter) return false;
      if (!query) return true;
      return [
        item.title,
        item.cwd,
        item.model,
        item.sessionId,
        item.originator,
        adapterLabel(item.adapter),
      ]
        .filter((value): value is string => Boolean(value))
        .some((value) => value.toLocaleLowerCase().includes(query));
    });
  }, [activityFilter, adapterFilter, allItems, processFilter, search]);

  function openRecord(recordId: string) {
    const next = new URLSearchParams(searchParams);
    next.set("record", recordId);
    setSearchParams(next);
  }

  function returnToOverview() {
    const next = new URLSearchParams(searchParams);
    next.delete("record");
    setSearchParams(next);
  }

  useEffect(() => {
    setDetailTab("conversation");
    setOlderEvents([]);
    setOlderBeforeOffset(undefined);
    setOlderHasMore(undefined);
    setEvidenceLimit(SYSTEM_EVIDENCE_BATCH_SIZE);
  }, [selectedRecordId]);

  const baseDetail = detailRequest.data?.record.recordId === selectedRecordId
    ? detailRequest.data
    : undefined;
  const evidenceDetail = systemEvidenceRequest.data?.record.recordId === selectedRecordId
    ? systemEvidenceRequest.data
    : undefined;
  const observerContentDetail = observerContentRequest.data?.record.recordId === selectedRecordId
    ? observerContentRequest.data
    : undefined;
  const detail = useMemo(() => {
    if (!baseDetail) return undefined;
    const withObserverContent = observerContentDetail
      ? {
          ...baseDetail,
          observedLlmRequests: baseDetail.observedLlmRequests.map((request) =>
            observerContentDetail.observedLlmRequests.find((content) => content.interactionId === request.interactionId)
              ?? request),
          provenance: {
            ...baseDetail.provenance,
            observerRequestEvidence: observerContentDetail.provenance.observerRequestEvidence,
            ebpfIncluded:
              baseDetail.provenance.ebpfIncluded
              || observerContentDetail.provenance.ebpfIncluded,
          },
        }
      : baseDetail;
    if (!evidenceDetail) return withObserverContent;
    return {
      ...withObserverContent,
      record: evidenceDetail.record,
      ...(evidenceDetail.systemEvidence
        ? { systemEvidence: evidenceDetail.systemEvidence }
        : {}),
      toolEvidence: evidenceDetail.toolEvidence,
      provenance: {
        ...withObserverContent.provenance,
        ebpfIncluded:
          baseDetail.provenance.ebpfIncluded
          || evidenceDetail.provenance.ebpfIncluded,
      },
    };
  }, [baseDetail, evidenceDetail, observerContentDetail]);
  const events = useMemo(() => {
    const deduplicated = new Map<string, LocalRecordTimelineEvent>();
    for (const event of [...olderEvents, ...(detail?.events ?? [])]) {
      deduplicated.set(event.eventId, event);
    }
    return [...deduplicated.values()].sort(
      (left, right) => left.sourceOffset - right.sourceOffset,
    );
  }, [detail?.events, olderEvents]);
  const visibleEvents = useMemo(() => {
    if (detailTab === "conversation") {
      return events.filter(
        (event) => event.kind === "user_message" || event.kind === "assistant_message",
      );
    }
    return events;
  }, [detailTab, events]);
  const nextBeforeOffset =
    olderBeforeOffset ?? detail?.page.nextBeforeOffset;
  const hasMore = olderHasMore ?? detail?.page.hasMore ?? false;

  async function loadOlder() {
    if (!selectedRecordId || nextBeforeOffset === undefined || olderRequest.loading) return;
    const page = await olderRequest.runAsync(selectedRecordId, nextBeforeOffset);
    setOlderEvents((current) => [...page.events, ...current]);
    setOlderBeforeOffset(page.page.nextBeforeOffset);
    setOlderHasMore(page.page.hasMore);
  }

  function refreshAll() {
    setOlderEvents([]);
    setOlderBeforeOffset(undefined);
    setOlderHasMore(undefined);
    listRequest.refresh();
    if (selectedRecordId) detailRequest.refresh();
    if (selectedRecordId && (detailTab === "semantic_tree" || detailTab === "link_awareness" || detailTab === "trace")) observerContentRequest.refresh();
    if (selectedRecordId && (detailTab === "system_evidence" || detailTab === "link_awareness" || detailTab === "trace")) {
      systemEvidenceRequest.refresh();
    }
  }

  function loadMoreSystemEvidence() {
    const total = detail?.systemEvidence?.page?.processFamilyTruncated
      ? MAX_SYSTEM_EVIDENCE_EVENTS
      : detail?.systemEvidence?.page?.totalRelations ?? MAX_SYSTEM_EVIDENCE_EVENTS;
    setEvidenceLimit((current) => Math.min(
      MAX_SYSTEM_EVIDENCE_EVENTS,
      total,
      current + SYSTEM_EVIDENCE_BATCH_SIZE,
    ));
  }

  const status = listRequest.data?.status;
  const aggregates = listRequest.data?.aggregates;
  const listUnavailable = Boolean(listRequest.error && !listRequest.data);
  const initialListLoading = listRequest.loading && !listRequest.data;

  return (
    <div className={cn("flex h-full min-h-0 flex-col overflow-hidden bg-slate-50 text-slate-900", selectedRecordId && detailTab === "trace" && "max-lg:overflow-y-auto")}>
      <header className="shrink-0 border-b border-slate-200 bg-white px-4 py-3 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="rounded-lg border border-teal-200 bg-teal-50 p-2 text-teal-700">
              <History aria-hidden="true" className="size-5" />
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-lg font-semibold text-slate-950">记录追踪</h1>
                <span className="rounded-full border border-teal-200 bg-teal-50 px-2 py-0.5 text-[10px] text-teal-700">
                  本地只读
                </span>
                <span
                  className={cn(
                    "rounded-full border px-2 py-0.5 text-[10px]",
                    detail?.provenance.ebpfIncluded
                      ? "border-cyan-200 bg-cyan-50 text-cyan-700"
                      : "border-amber-200 bg-amber-50 text-amber-800",
                  )}
                >
                  {detail?.provenance.ebpfIncluded ? "Observer eBPF 已关联" : "eBPF 待关联"}
                </span>
                <span
                  className={cn(
                    "rounded-full border px-2 py-0.5 text-[10px]",
                    status?.processObservation.available
                      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                      : "border-slate-200 bg-slate-50 text-slate-600",
                  )}
                >
                  {status?.processObservation.available ? "进程 FD 已关联" : "进程状态未知"}
                </span>
              </div>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={refreshAll}
            disabled={listRequest.loading}
            className="border-slate-200 bg-white text-slate-700 shadow-sm hover:bg-slate-50"
          >
            <RefreshCw className={cn("mr-1.5 size-3.5", listRequest.loading && "animate-spin")} />
            刷新
          </Button>
        </div>
      </header>

      <div className="grid shrink-0 grid-cols-2 gap-2 border-b border-slate-200 bg-slate-50 px-4 py-3 md:grid-cols-3 xl:grid-cols-6">
        <KpiCard
          label="读取状态"
          value={
            initialListLoading
              ? "连接中"
              : listUnavailable
                ? "读取失败"
                : status?.rootAccessible
                  ? "正常"
                  : status?.enabled
                    ? "不可访问"
                    : "未启用"
          }
          caption={
            listUnavailable
              ? "API 暂不可用，正在自动重试"
              : status?.rootDisplay || "等待本地 Session 目录"
          }
          icon={ShieldCheck}
        />
        <KpiCard
          label="本地记录"
          value={compactNumber(listRequest.data?.total)}
          caption={status?.adapter === "multi" ? "多 Agent Session" : status?.adapter ? `${adapterLabel(status.adapter)} Session` : "Agent Session"}
          icon={Database}
          tone="blue"
        />
        <KpiCard
          label="运行中进程"
          value={
            status?.processObservation.available
              ? compactNumber(aggregates?.runningProcesses)
              : "--"
          }
          caption={
            status?.processObservation.available
              ? `${compactNumber(aggregates?.exitedRecords)} 已退出 · ${compactNumber(aggregates?.unknownProcessRecords)} 未知`
              : "宿主机进程证据未启用"
          }
          icon={CircleDot}
        />
        <KpiCard
          label="记录活跃"
          value={compactNumber(aggregates?.activeRecords)}
          caption={`5 分钟内写入 · ${compactNumber(aggregates?.recentRecords)} 条近期写入`}
          icon={Activity}
        />
        <KpiCard
          label="已观测 Token"
          value={compactNumber(aggregates?.observedTokens)}
          caption={`本地文件 ${bytes(aggregates?.totalBytes)}`}
          icon={Gauge}
          tone="violet"
        />
        <KpiCard
          label="摘要工具调用"
          value={compactNumber(aggregates?.observedToolCalls)}
          caption="各 Session 摘要窗口累计"
          icon={Wrench}
          tone="amber"
        />
      </div>

      {listUnavailable ? (
        <div className="m-4 rounded-xl border border-rose-200 bg-rose-50 p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-rose-800">
            <TriangleAlert aria-hidden="true" className="size-4" />
            本地记录 API 暂时不可用
          </div>
          <p className="mt-2 text-xs leading-5 text-rose-900">
            {listRequest.error?.message || "连接失败"}。页面正在自动重试，也可以点击右上角刷新。
          </p>
        </div>
      ) : !listRequest.loading && status && (!status.enabled || !status.rootAccessible) ? (
        <div className="m-4 rounded-xl border border-amber-200 bg-amber-50 p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-amber-800">
            <TriangleAlert aria-hidden="true" className="size-4" />
            本地记录源尚不可用
          </div>
          <p className="mt-2 text-xs leading-5 text-amber-900">
            {status.lastError || (
              status.enabled
                ? "已启用读取，但容器内没有挂载可访问的 Agent sessions 目录。"
                : "设置 ANYSENTRY_LOCAL_RECORD_TRACKING=on，并以只读方式挂载 Codex、A3S Code、Claude Code 或 Gemini CLI Session 目录。"
            )}
          </p>
        </div>
      ) : null}

      {!selectedRecordId ? (
        <section
          data-record-overview
          className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden px-4 py-4"
        >
          <div className="shrink-0 rounded-xl border border-slate-200 bg-white shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 px-4 py-3">
              <div className="flex min-w-0 items-start gap-3">
                <span className="rounded-lg border border-teal-200 bg-teal-50 p-2 text-teal-700">
                  <Database aria-hidden="true" className="size-4" />
                </span>
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-sm font-semibold text-slate-950">Agent 会话全景</h2>
                    <span className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[9px] text-slate-600">
                      {filteredItems.length} / {allItems.length} 条
                    </span>
                  </div>
                </div>
              </div>
              <span className="rounded-full border border-sky-200 bg-sky-50 px-2 py-1 text-[9px] text-sky-700">
                点击记录进入详情
              </span>
            </div>
            <div className="flex flex-col gap-2 p-3 md:flex-row md:items-center">
              <div className="relative min-w-0 flex-1">
                <Search
                  aria-hidden="true"
                  className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-slate-400"
                />
                <Input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  aria-label="搜索本地 Agent 会话"
                  placeholder="搜索 Agent、首条指令、Workspace、模型或 Session"
                  className="h-9 border-slate-200 bg-white pl-9 text-xs text-slate-900 placeholder:text-slate-400 focus-visible:ring-teal-600"
                />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  value={adapterFilter}
                  onValueChange={(value) =>
                    setAdapterFilter(
                      value as
                        | "all"
                        | "codex"
                        | "a3s_code"
                        | "claude_code"
                        | "gemini_cli"
                        | "kimi_cli"
                        | "opencode",
                    )
                  }
                >
                  <SelectTrigger
                    aria-label="按 Agent 类型筛选"
                    className="h-9 w-[148px] border-slate-200 bg-white text-xs text-slate-900 focus-visible:ring-teal-600"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="border-slate-200 bg-white text-slate-900 shadow-md">
                    <SelectItem value="all" className={LIGHT_SELECT_ITEM_CLASS}>
                      全部 Agent
                    </SelectItem>
                    <SelectItem value="codex" className={LIGHT_SELECT_ITEM_CLASS}>
                      Codex
                    </SelectItem>
                    <SelectItem value="a3s_code" className={LIGHT_SELECT_ITEM_CLASS}>
                      A3S Code
                    </SelectItem>
                    <SelectItem value="claude_code" className={LIGHT_SELECT_ITEM_CLASS}>
                      Claude Code
                    </SelectItem>
                    <SelectItem value="gemini_cli" className={LIGHT_SELECT_ITEM_CLASS}>
                      Gemini CLI
                    </SelectItem>
                    <SelectItem value="kimi_cli" className={LIGHT_SELECT_ITEM_CLASS}>
                      Kimi Code CLI
                    </SelectItem>
                    <SelectItem value="opencode" className={LIGHT_SELECT_ITEM_CLASS}>
                      OpenCode
                    </SelectItem>
                  </SelectContent>
                </Select>
                <Select
                  value={processFilter}
                  onValueChange={(value) =>
                    setProcessFilter(value as LocalRecordProcessStatus | "all")
                  }
                >
                  <SelectTrigger
                    aria-label="按进程状态筛选"
                    className="h-9 w-[120px] border-slate-200 bg-white text-xs text-slate-900 focus-visible:ring-teal-600"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="border-slate-200 bg-white text-slate-900 shadow-md">
                    <SelectItem value="all" className={LIGHT_SELECT_ITEM_CLASS}>
                      全部进程
                    </SelectItem>
                    <SelectItem value="running" className={LIGHT_SELECT_ITEM_CLASS}>
                      {PROCESS_LABEL.running}
                    </SelectItem>
                    <SelectItem value="exited" className={LIGHT_SELECT_ITEM_CLASS}>
                      {PROCESS_LABEL.exited}
                    </SelectItem>
                    <SelectItem value="unknown" className={LIGHT_SELECT_ITEM_CLASS}>
                      {PROCESS_LABEL.unknown}
                    </SelectItem>
                  </SelectContent>
                </Select>
                <Select
                  value={activityFilter}
                  onValueChange={(value) =>
                    setActivityFilter(value as LocalRecordActivityStatus | "all")
                  }
                >
                  <SelectTrigger
                    aria-label="按记录状态筛选"
                    className="h-9 w-[120px] border-slate-200 bg-white text-xs text-slate-900 focus-visible:ring-teal-600"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="border-slate-200 bg-white text-slate-900 shadow-md">
                    <SelectItem value="all" className={LIGHT_SELECT_ITEM_CLASS}>
                      全部记录
                    </SelectItem>
                    <SelectItem value="active" className={LIGHT_SELECT_ITEM_CLASS}>
                      {ACTIVITY_LABEL.active}
                    </SelectItem>
                    <SelectItem value="recent" className={LIGHT_SELECT_ITEM_CLASS}>
                      {ACTIVITY_LABEL.recent}
                    </SelectItem>
                    <SelectItem value="stopped" className={LIGHT_SELECT_ITEM_CLASS}>
                      {ACTIVITY_LABEL.stopped}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
            {listRequest.loading && allItems.length === 0 ? (
              <div className="flex h-full min-h-52 items-center justify-center gap-2 text-xs text-slate-600">
                <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
                正在读取本地记录
              </div>
            ) : listUnavailable ? (
              <OperationalEmptyState
                appearance="light"
                icon={TriangleAlert}
                title="本地记录 API 连接失败"
                description="服务恢复后页面会自动重试；也可以点击右上角刷新。"
              />
            ) : filteredItems.length > 0 ? (
              <div className="h-full overflow-y-auto">
                <RecordOverviewTable items={filteredItems} onOpen={openRecord} />
              </div>
            ) : (
              <OperationalEmptyState
                appearance="light"
                icon={FileText}
                title="没有匹配的本地记录"
                description="调整搜索条件，或确认本机 Agent sessions 目录已经只读挂载。"
              />
            )}
          </div>
        </section>
      ) : (
        <main
          data-record-detail
          className={cn("flex min-h-0 min-w-0 flex-1 flex-col bg-slate-50", (detailTab === "trace" || detailTab === "metrics") && "max-lg:flex-none")}
        >
          <div className="shrink-0 border-b border-slate-200 bg-white px-4 py-2.5">
            <Button
              variant="outline"
              size="sm"
              onClick={returnToOverview}
              className="h-8 border-slate-200 bg-white text-[11px] text-slate-700 shadow-sm hover:bg-slate-50"
            >
              <ArrowLeft aria-hidden="true" className="mr-1.5 size-3.5" />
              返回记录全景
            </Button>
          </div>
          {detailRequest.loading && !detail ? (
            <div className="flex flex-1 items-center justify-center gap-2 text-sm text-slate-600">
              <LoaderCircle className="size-5 animate-spin" />
              正在解析 Session 窗口
            </div>
          ) : detailRequest.error ? (
            <OperationalEmptyState
              appearance="light"
              icon={TriangleAlert}
              title="本地记录读取失败"
              description={detailRequest.error.message}
            />
          ) : detail ? (
            <>
              <div className="shrink-0 border-b border-slate-200 bg-white px-4 py-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="max-w-4xl truncate text-sm font-semibold text-slate-950">
                        {detail.record.title}
                      </h2>
                      <ProcessStatusBadge item={detail.record} />
                      <RecordActivityBadge status={detail.record.activityStatus} />
                      <span className="rounded border border-teal-200 bg-teal-50 px-1.5 py-0.5 text-[9px] text-teal-700">
                        {detail.record.model || adapterLabel(detail.record.adapter)}
                      </span>
                      <span className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[9px] text-slate-600">
                        {detail.metrics.scope === "full_record" ? "完整统计" : "窗口统计"}
                      </span>
                    </div>
                    <p className="mt-1 truncate font-mono text-[10px] text-slate-500">
                      {detail.record.cwd || "Workspace 未记录"} · {detail.record.sessionId}
                    </p>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-right">
                    <div>
                      <p className="text-[9px] text-slate-500">Token</p>
                      <p className="font-mono text-xs text-slate-800">
                        {compactNumber(detail.record.tokenUsage.totalTokens)}
                      </p>
                    </div>
                    <div>
                      <p className="text-[9px] text-slate-500">工具</p>
                      <p className="font-mono text-xs text-slate-800">{detail.metrics.toolCallCount}</p>
                    </div>
                    <div>
                      <p className="text-[9px] text-slate-500">更新</p>
                      <p className="font-mono text-xs text-slate-800">{dateTime(detail.record.updatedAt)}</p>
                    </div>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {([
                    ["conversation", "对话记录", MessageSquareText],
                    ["trace", "Trace", ListTree],
                    ["link_awareness", "链路感知", Activity],
                    ["system_evidence", "内核事件", ShieldCheck],
                    ["timeline", "对话时间线", MessageSquareText],
                    ["semantic_tree", "会话 & 模型请求", GitBranch],
                    ["metrics", "分析", Gauge],
                  ] as const).map(([value, label, Icon]) => (
                    <button
                      key={value}
                      type="button"
                      data-detail-tab={value}
                      aria-pressed={detailTab === value}
                      onClick={() => setDetailTab(value)}
                      className={cn(
                        "flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-400",
                        detailTab === value
                          ? "border-teal-300 bg-teal-50 text-teal-800"
                          : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50 hover:text-slate-900",
                      )}
                    >
                      <Icon className="size-3.5" />
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div className={cn("min-h-0 flex-1 overflow-y-auto px-4 py-4", (detailTab === "trace" || detailTab === "metrics") && "max-lg:flex-none max-lg:overflow-visible")}>
                {detailTab === "metrics" ? (
                  <LocalRecordAnalysis
                    key={detail.record.recordId}
                    detail={detail}
                    events={events}
                    hasMore={hasMore && nextBeforeOffset !== undefined}
                    olderLoading={olderRequest.loading}
                    onLoadOlder={() => void loadOlder()}
                    evidenceLoading={systemEvidenceRequest.loading}
                    evidenceError={Boolean(systemEvidenceRequest.error)}
                    onRetryEvidence={() => systemEvidenceRequest.refresh()}
                    onLoadMoreEvidence={loadMoreSystemEvidence}
                  />
                ) : detailTab === "trace" ? (
                  <LocalRecordTrace
                    key={detail.record.recordId}
                    detail={detail}
                    events={events}
                    hasMore={hasMore && nextBeforeOffset !== undefined}
                    olderLoading={olderRequest.loading}
                    onLoadOlder={() => void loadOlder()}
                    evidenceLoading={systemEvidenceRequest.loading}
                    evidenceError={Boolean(systemEvidenceRequest.error)}
                    contentLoading={observerContentRequest.loading}
                    contentError={Boolean(observerContentRequest.error)}
                    onRetryEvidence={() => systemEvidenceRequest.refresh()}
                    onRetryContent={() => observerContentRequest.refresh()}
                    onLoadMoreEvidence={loadMoreSystemEvidence}
                  />
                ) : detailTab === "semantic_tree" || detailTab === "link_awareness" ? (
                  <SemanticTreePanel
                    key={detail.record.recordId}
                    detail={detail}
                    events={events}
                    hasMore={hasMore && nextBeforeOffset !== undefined}
                    olderLoading={olderRequest.loading}
                    onLoadOlder={() => void loadOlder()}
                    contentLoading={observerContentRequest.loading}
                    contentError={Boolean(observerContentRequest.error)}
                    onRetryContent={() => observerContentRequest.refresh()}
                    linkAwareness={detailTab === "link_awareness"}
                    evidenceLoading={systemEvidenceRequest.loading}
                    evidenceError={Boolean(systemEvidenceRequest.error)}
                  />
                ) : detailTab === "system_evidence" ? (
                  systemEvidenceRequest.loading && !evidenceDetail ? (
                    <section
                      aria-busy="true"
                      aria-live="polite"
                      className="mx-auto flex min-h-48 max-w-6xl items-center justify-center rounded-xl border border-slate-200 bg-white shadow-sm"
                    >
                      <div className="text-center text-xs text-slate-600">
                        <LoaderCircle aria-hidden="true" className="mx-auto mb-2 size-5 animate-spin text-teal-600" />
                        <p className="font-medium text-slate-800">正在计算系统证据归属</p>
                        <p className="mt-1 text-[10px] text-slate-500">对话内容已就绪，证据结果会在此区域独立加载。</p>
                      </div>
                    </section>
                  ) : systemEvidenceRequest.error && !evidenceDetail ? (
                    <div className="mx-auto max-w-6xl">
                      <OperationalEmptyState
                        appearance="light"
                        icon={TriangleAlert}
                        title="系统证据读取失败"
                        description={systemEvidenceRequest.error.message}
                      />
                    </div>
                  ) : (
                    <SystemEvidencePanel
                      detail={detail}
                      loadingMore={systemEvidenceRequest.loading}
                      onLoadMore={loadMoreSystemEvidence}
                    />
                  )
                ) : (
                  <div className="w-full min-w-0 space-y-3">
                    {hasMore && nextBeforeOffset !== undefined ? (
                      <div className="flex justify-center">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void loadOlder()}
                          disabled={olderRequest.loading}
                          className="border-slate-200 bg-white text-slate-700 shadow-sm hover:bg-slate-50"
                        >
                          {olderRequest.loading ? (
                            <LoaderCircle className="mr-1.5 size-3.5 animate-spin" />
                          ) : (
                            <ChevronDown className="mr-1.5 size-3.5 rotate-180" />
                          )}
                          加载更早记录
                        </Button>
                      </div>
                    ) : null}
                    {visibleEvents.length > 0 && detailTab === "conversation" ? (
                      <div
                        data-conversation-transcript
                        role="list"
                        aria-label="本地 Session 对话记录"
                        className="space-y-4 rounded-2xl border border-slate-200 bg-white p-3 shadow-sm sm:p-5"
                      >
                        {visibleEvents.map((event) => (
                          <ConversationMessage key={event.eventId} event={event} />
                        ))}
                      </div>
                    ) : visibleEvents.length > 0 ? (
                      visibleEvents.map((event) => (
                        <TimelineEvent key={event.eventId} event={event} />
                      ))
                    ) : (
                      <OperationalEmptyState
                        appearance="light"
                        icon={MessageSquareText}
                        title={
                          detailTab === "conversation"
                            ? "当前窗口没有对话正文"
                            : "当前窗口没有可展示记录"
                        }
                        description={hasMore ? "可以继续加载更早的 Session 窗口。" : "源 Session 没有对应语义事件。"}
                      />
                    )}
                  </div>
                )}
              </div>
              <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-slate-200 bg-white px-4 py-2 text-[9px] text-slate-500">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="flex items-center gap-1"><HardDrive className="size-3" />源文件 {bytes(detail.record.fileBytes)}</span>
                  <span className="flex items-center gap-1"><FileText className="size-3" />本页扫描 {bytes(detail.metrics.scannedBytes)}</span>
                  <span className="flex items-center gap-1"><Timer className="size-3" />记录跨度 {elapsed(detail.record.startedAt, detail.record.updatedAt)}</span>
                </div>
              </footer>
            </>
          ) : null}
        </main>
      )}
    </div>
  );
}
