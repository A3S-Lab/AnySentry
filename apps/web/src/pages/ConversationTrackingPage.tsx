import { useRequest } from "ahooks";
import {
  Activity,
  ArrowDownToLine,
  ArrowUpFromLine,
  Bot,
  Clock3,
  Database,
  Eye,
  EyeOff,
  LockKeyhole,
  LoaderCircle,
  MessageSquareText,
  Network,
  RadioTower,
  RefreshCw,
  Search,
  Server,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  UserRound,
  Waypoints,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { AdminTokenControl } from "@/components/custom/admin-token-control";
import { OperationalEmptyState } from "@/components/custom/operational-empty-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  getInteractionRawViewToken,
  setInteractionRawViewToken,
} from "@/lib/api/client";
import {
  type InteractionContentView,
  type InteractionContentObservation,
  type InteractionConversationSummary,
  securityCenterApi,
} from "@/lib/api/security-center";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const CONVERSATION_PAGE_SIZE = 40;

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

function bytes(value?: number) {
  const count = Number(value) || 0;
  if (count < 1024) return `${count} B`;
  if (count < 1024 * 1024) return `${(count / 1024).toFixed(1)} KiB`;
  return `${(count / (1024 * 1024)).toFixed(1)} MiB`;
}

function Metric({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string | number;
  icon: typeof Activity;
}) {
  return (
    <div className="min-w-0 rounded-lg border border-white/10 bg-white/[0.025] px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-[11px] text-zinc-500">
        <Icon className="size-3.5 text-teal-300/80" />
        <span>{label}</span>
      </div>
      <p className="mt-1 truncate font-mono text-lg font-semibold text-zinc-100">{value}</p>
    </div>
  );
}

function ConversationRow({
  item,
  active,
  onSelect,
}: {
  item: InteractionConversationSummary;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={cn(
        "w-full border-b border-white/[0.07] px-3 py-3 text-left transition-colors",
        active ? "bg-teal-400/[0.09]" : "hover:bg-white/[0.035]",
      )}
    >
      <div className="flex min-w-0 items-center justify-between gap-3">
        <span className="truncate text-sm font-semibold text-zinc-100">
          {item.agentInstanceId || item.provider || "观测进程"}
        </span>
        <span className="shrink-0 font-mono text-[10px] text-zinc-600">
          {dateTime(item.lastObservedAt)}
        </span>
      </div>
      <div className="mt-1.5 flex min-w-0 items-center gap-2 text-[11px] text-zinc-500">
        <span className="rounded border border-teal-400/20 bg-teal-500/10 px-1.5 py-0.5 text-teal-200">
          {item.runtimeType === "codex_app_server"
            ? "Codex Runtime"
            : item.provider || "Provider 未识别"}
        </span>
        <span className="truncate font-mono">
          {item.runtimeThreadId || item.processInstanceId}
        </span>
      </div>
      <div className="mt-2 flex items-center justify-between gap-3 text-[11px] text-zinc-600">
        <span>
          {item.instructionObservations} 条指令 · {item.responseObservations ?? 0} 条回复
        </span>
        <span
          className={cn(
            "inline-flex items-center gap-1",
            item.contentAvailable ? "text-emerald-300/80" : "text-zinc-500",
          )}
        >
          {item.contentAvailable ? (
            <LockKeyhole className="size-3" />
          ) : (
            <EyeOff className="size-3" />
          )}
          {item.contentAvailable ? "对话正文" : "正文未采集"}
        </span>
      </div>
    </button>
  );
}

function MessageObservationCard({
  observation,
  directViewEnabled,
  rawViewEnabled,
  rawViewToken,
  reason,
  onDeleted,
}: {
  observation: InteractionContentObservation;
  directViewEnabled: boolean;
  rawViewEnabled: boolean;
  rawViewToken: string;
  reason: string;
  onDeleted: () => void;
}) {
  const assistant = observation.eventType === "AgentOutputObserved";
  const messageMetadata = assistant
    ? observation.assistantResponse
    : observation.userInstruction;
  const streamScope = assistant
    ? observation.output.outputScope
    : observation.input.inputScope;
  const MessageIcon = assistant ? Bot : UserRound;
  const roleLabel = assistant
    ? observation.assistantResponse.phase === "commentary"
      ? "Agent 过程说明"
      : observation.assistantResponse.phase === "final_answer"
        ? "Agent 最终回复"
        : "Agent 回复"
    : "用户指令";
  const runtimeHistory = observation.capture.captureMethod === "codex_app_server";
  const cardRef = useRef<HTMLElement>(null);
  const [content, setContent] = useState<InteractionContentView>();
  const [autoLoadEligible, setAutoLoadEligible] = useState(false);
  const [loading, setLoading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleted, setDeleted] = useState(
    observation.contentAvailability === "deleted",
  );
  const [message, setMessage] = useState("");

  useEffect(() => {
    const unavailable = observation.contentAvailability === "deleted";
    setContent(undefined);
    setDeleted(unavailable);
    setMessage("");
  }, [observation.contentAvailability, observation.interactionId]);

  useEffect(() => {
    setAutoLoadEligible(false);
    if (!directViewEnabled || observation.contentAvailability === "deleted") {
      return undefined;
    }
    const node = cardRef.current;
    if (!node || !("IntersectionObserver" in window)) {
      setAutoLoadEligible(true);
      return undefined;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setAutoLoadEligible(true);
        observer.disconnect();
      },
      { rootMargin: "600px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [
    directViewEnabled,
    observation.contentAvailability,
    observation.interactionId,
  ]);

  useEffect(() => {
    const unavailable = observation.contentAvailability === "deleted";
    if (!directViewEnabled || !autoLoadEligible || unavailable) return undefined;
    const controller = new AbortController();
    let active = true;
    setLoading(true);
    void securityCenterApi
      .interactionContent(observation.interactionId, undefined, controller.signal)
      .then((result) => {
        if (!active) return;
        setContent(result);
        setMessage(`${roleLabel}已从本地加密存储自动加载。`);
      })
      .catch((error) => {
        if (!active) return;
        setContent(undefined);
        setMessage(error instanceof Error ? error.message : `${roleLabel}自动加载失败`);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [
    autoLoadEligible,
    directViewEnabled,
    observation.contentAvailability,
    observation.interactionId,
    roleLabel,
  ]);

  const authorization = () => {
    if (!rawViewEnabled) throw new Error("服务端 Raw View 尚未启用");
    if (!rawViewToken.trim()) throw new Error("请先填写并保存正文查看凭据");
    if (reason.trim().length < 12) throw new Error("请填写至少 12 个字符的查看原因");
    return { rawViewToken: rawViewToken.trim(), reason: reason.trim() };
  };

  const reveal = async () => {
    setMessage("");
    setLoading(true);
    try {
      const result = await securityCenterApi.interactionContent(
        observation.interactionId,
        directViewEnabled ? undefined : authorization(),
      );
      setContent(result);
      setMessage(
        directViewEnabled
          ? "正文已从本地加密存储重新加载。"
          : "正文已按授权从加密存储中读取，本次访问已写入审计日志。",
      );
    } catch (error) {
      setContent(undefined);
      setMessage(error instanceof Error ? error.message : "正文读取失败");
    } finally {
      setLoading(false);
    }
  };

  const remove = async () => {
    if (
      !window.confirm(
        `确认永久删除这条${roleLabel}正文？元数据与审计记录会保留，正文无法恢复。`,
      )
    ) {
      return;
    }
    setMessage("");
    setDeleting(true);
    try {
      await securityCenterApi.deleteInteractionContent(
        observation.interactionId,
        authorization(),
      );
      setContent(undefined);
      setDeleted(true);
      setMessage(`${roleLabel}正文已删除；关联元数据和删除审计仍保留。`);
      onDeleted();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "正文删除失败");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <article
      ref={cardRef}
      className={cn(
        "rounded-lg border p-3",
        assistant
          ? "border-sky-400/20 bg-sky-500/[0.04]"
          : "border-emerald-400/20 bg-emerald-500/[0.035]",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <MessageIcon
            className={cn("size-4", assistant ? "text-sky-300" : "text-emerald-300")}
            aria-hidden="true"
          />
          <span className="text-xs font-semibold text-zinc-100">{roleLabel}</span>
          <span
            className={cn(
              "rounded border px-1.5 py-0.5 text-[10px]",
              assistant
                ? "border-sky-400/20 bg-sky-500/10 text-sky-200"
                : "border-emerald-400/20 bg-emerald-500/10 text-emerald-200",
            )}
          >
            {runtimeHistory ? "Codex 原生历史" : "加密存储"}
          </span>
          <span className="rounded border border-white/10 px-1.5 py-0.5 text-[10px] text-zinc-500">
            {observation.capture.captureCompleteness}
          </span>
        </div>
        <time className="font-mono text-[10px] text-zinc-600">
          {dateTime(observation.observedAt)}
        </time>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-[11px] md:grid-cols-4">
        <div>
          <p className="text-zinc-600">采集边界</p>
          <p className="mt-0.5 font-mono text-zinc-300">
            {streamScope}
          </p>
        </div>
        <div>
          <p className="text-zinc-600">
            {observation.runtime ? "Runtime Thread" : "进程"}
          </p>
          <p className="mt-0.5 truncate font-mono text-zinc-300">
            {observation.runtime
              ? observation.runtime.threadId
              : `${observation.process?.comm || "process"} · PID ${
                  observation.process?.pid ?? "--"
                }`}
          </p>
        </div>
        <div>
          <p className="text-zinc-600">正文大小</p>
          <p className="mt-0.5 font-mono text-zinc-300">
            {bytes(messageMetadata.contentBytes)}
          </p>
        </div>
        <div>
          <p className="text-zinc-600">内容指纹</p>
          <p
            className="mt-0.5 truncate font-mono text-zinc-300"
            title={messageMetadata.contentSha256}
          >
            {messageMetadata.contentSha256.slice(0, 16)}…
          </p>
        </div>
      </div>

      <div className="mt-3 rounded-md border border-white/[0.08] bg-black/20 p-3">
        {deleted ? (
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <EyeOff className="size-4" aria-hidden="true" />
            正文已删除，仅保留不可逆指纹和观测元数据
          </div>
        ) : content ? (
          <>
            <div className="flex items-center justify-between gap-3">
              <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-emerald-200">
                <Eye className="size-3.5" aria-hidden="true" />
                {directViewEnabled ? "本地直接显示原文" : "已授权显示原文"}
              </span>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="h-7 border border-white/10 bg-white/5 px-2 text-[11px] text-zinc-300 hover:bg-white/10"
                onClick={() => {
                  setContent(undefined);
                  setMessage("正文已从当前页面隐藏。");
                }}
              >
                <X className="mr-1 size-3" aria-hidden="true" />
                隐藏
              </Button>
            </div>
            <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded border border-white/[0.07] bg-[#080b09] p-3 font-mono text-xs leading-5 text-zinc-200">
              {content.content}
            </pre>
          </>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="inline-flex items-center gap-1.5 text-xs font-medium text-zinc-300">
                {directViewEnabled ? (
                  <Eye className="size-3.5 text-emerald-300" aria-hidden="true" />
                ) : (
                  <LockKeyhole className="size-3.5 text-amber-300" aria-hidden="true" />
                )}
                {directViewEnabled
                  ? !autoLoadEligible
                    ? "滚动到此处后加载正文"
                    : loading
                    ? "正在加载正文"
                    : "正文已隐藏或加载失败"
                  : "正文默认不加载"}
              </p>
              <p className="mt-1 text-[11px] leading-5 text-zinc-600">
                {directViewEnabled
                  ? !autoLoadEligible
                    ? "为避免长对话并发读取，正文将在接近可见区域时自动解密。"
                    : "本机受控直显模式无需密钥；可以重新加载当前正文。"
                  : "查看需要管理密钥、独立正文凭据和调查原因；操作会完整审计。"}
              </p>
            </div>
            <Button
              type="button"
              size="sm"
              disabled={!rawViewEnabled || loading}
              onClick={() => void reveal()}
              className="h-8 bg-emerald-500 text-[#06110b] hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {loading ? (
                <LoaderCircle className="mr-1.5 size-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Eye className="mr-1.5 size-3.5" aria-hidden="true" />
              )}
              {directViewEnabled ? "重新显示正文" : "授权查看正文"}
            </Button>
          </div>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-white/[0.06] pt-2">
        <div className="flex flex-wrap items-center gap-2 text-[10px] text-zinc-600">
          <span>source: {observation.sourceId}</span>
          <span>retention: encrypted</span>
          <span>
            turn: {observation.turnSequence ?? observation.turnId?.slice(0, 16) ?? "未关联"}
          </span>
          <span>ref: {messageMetadata.contentRef}</span>
        </div>
        {!deleted && !directViewEnabled ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={!rawViewEnabled || deleting}
            onClick={() => void remove()}
            className="h-7 border border-red-400/20 bg-red-500/[0.06] px-2 text-[10px] text-red-200 hover:bg-red-500/10 disabled:opacity-40"
          >
            {deleting ? (
              <LoaderCircle className="mr-1 size-3 animate-spin" aria-hidden="true" />
            ) : (
              <Trash2 className="mr-1 size-3" aria-hidden="true" />
            )}
            删除正文
          </Button>
        ) : null}
      </div>
      <p className="mt-2 min-h-4 text-[11px] text-zinc-500" aria-live="polite">
        {message}
      </p>
    </article>
  );
}

export default function ConversationTrackingPage() {
  const { t } = useI18n();
  const [searchParams, setSearchParams] = useSearchParams();
  const [keyword, setKeyword] = useState("");
  const [rawViewToken, setRawViewTokenDraft] = useState(
    () => getInteractionRawViewToken(),
  );
  const [rawViewTokenSaved, setRawViewTokenSaved] = useState(
    () => Boolean(getInteractionRawViewToken()),
  );
  const [rawViewReason, setRawViewReason] = useState(
    "调查 Agent 指令与底层行为的关联",
  );
  const [visibleObservationCount, setVisibleObservationCount] = useState(
    CONVERSATION_PAGE_SIZE,
  );
  const selectedId = searchParams.get("conversationId") || "";
  const statusRequest = useRequest(() => securityCenterApi.interactionStatus(), {
    pollingInterval: 30_000,
    pollingWhenHidden: false,
  });
  const listRequest = useRequest(
    () => securityCenterApi.interactionConversations({ limit: 300 }),
    { pollingInterval: 15_000, pollingWhenHidden: false },
  );
  const detailRequest = useRequest(
    () => securityCenterApi.interactionConversation(selectedId),
    {
      ready: Boolean(selectedId),
      refreshDeps: [selectedId],
      pollingInterval: selectedId ? 15_000 : 0,
      pollingWhenHidden: false,
    },
  );

  const rows = useMemo(() => {
    const query = keyword.trim().toLowerCase();
    const items = listRequest.data?.items ?? [];
    if (!query) return items;
    return items.filter((item) =>
      [
        item.conversationId,
        item.agentInstanceId,
        item.processInstanceId,
        item.runtimeThreadId,
        item.workspacePath,
        item.provider,
        item.collectorId,
      ].some((value) => value?.toLowerCase().includes(query)),
    );
  }, [keyword, listRequest.data?.items]);

  useEffect(() => {
    if (selectedId || rows.length === 0) return;
    const next = new URLSearchParams(searchParams);
    next.set("conversationId", rows[0].conversationId);
    setSearchParams(next, { replace: true });
  }, [rows, searchParams, selectedId, setSearchParams]);

  useEffect(() => {
    setVisibleObservationCount(CONVERSATION_PAGE_SIZE);
  }, [selectedId]);

  const selectConversation = (conversationId: string) => {
    const next = new URLSearchParams(searchParams);
    next.set("conversationId", conversationId);
    setSearchParams(next);
  };

  const status = statusRequest.data;
  const detail = detailRequest.data;
  const visibleObservations = useMemo(() => {
    const observations = detail?.observations ?? [];
    return observations.slice(Math.max(0, observations.length - visibleObservationCount));
  }, [detail?.observations, visibleObservationCount]);
  const hiddenObservationCount = Math.max(
    0,
    (detail?.observations.length ?? 0) - visibleObservations.length,
  );

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-[#0b0f0c] text-zinc-100">
      <header className="shrink-0 border-b border-white/10 bg-[#0b0f0c] px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <MessageSquareText className="size-5 shrink-0 text-teal-300" />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="truncate text-lg font-semibold tracking-normal text-zinc-50">
                  {t("对话追踪")}
                </h1>
                <span
                  className={cn(
                    "rounded-full border px-2 py-0.5 text-[10px] font-semibold",
                    status?.directViewEnabled
                      ? "border-amber-400/25 bg-amber-500/10 text-amber-200"
                      : status?.contentCaptureAllowed
                      ? "border-emerald-400/25 bg-emerald-500/10 text-emerald-200"
                      : "border-teal-400/25 bg-teal-500/10 text-teal-200",
                  )}
                >
                  {status?.directViewEnabled
                    ? "本地对话直显"
                    : status?.contentCaptureAllowed
                      ? "受控对话正文"
                      : "源头元数据"}
                </span>
              </div>
              <p className="truncate text-[11px] text-zinc-600">
                {status?.directViewEnabled
                  ? "本机受控模式：自动展示 Codex 原生用户消息与 Agent 回复"
                  : status?.contentCaptureAllowed
                    ? "元数据持续观测；隔离 Fixture 对话可加密保存并按授权查看"
                    : "Agent → LLM 传输观测；当前不读取、解析或保存对话正文"}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {status?.directViewEnabled ? null : <AdminTokenControl compact />}
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="h-8 border border-white/10 bg-white/5 text-zinc-200 hover:bg-white/10"
              onClick={() => {
                statusRequest.refresh();
                listRequest.refresh();
                if (selectedId) detailRequest.refresh();
              }}
            >
              <RefreshCw
                className={cn(
                  "mr-1.5 size-3.5",
                  (statusRequest.loading || listRequest.loading || detailRequest.loading)
                    && "animate-spin",
                )}
              />
              刷新
            </Button>
          </div>
        </div>
      </header>
      <main
        className="min-h-0 flex-1 overflow-auto p-3 lg:overflow-hidden"
        aria-label={t("对话追踪")}
      >
        <section className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-4">
          <Metric
            label="通道状态"
            value={
              statusRequest.error
                ? "状态不可用"
                : !status
                  ? "检查中"
                  : !status.enabled
                ? "未启用"
                  : !status.ready
                    ? "接收不可用"
                    : status.projection.state === "degraded"
                      ? "投影降级"
                      : "正常"
            }
            icon={RadioTower}
          />
          <Metric label="本进程持久接收" value={status?.accepted ?? 0} icon={ShieldCheck} />
          <Metric label="本进程完成投影" value={status?.projected ?? 0} icon={Database} />
          <Metric
            label="观测会话"
            value={listRequest.data?.total ?? 0}
            icon={Waypoints}
          />
        </section>

        <section className="grid min-h-[640px] gap-3 lg:h-[calc(100%-84px)] lg:min-h-0 lg:grid-cols-[340px_minmax(0,1fr)]">
          <div className="flex min-h-[360px] flex-col overflow-hidden rounded-lg border border-white/10 bg-[#0e1310] lg:min-h-0">
            <div className="border-b border-white/10 p-3">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-zinc-600" />
                <Input
                  value={keyword}
                  onChange={(event) => setKeyword(event.target.value)}
                  placeholder="Agent、Provider、Workspace、Thread / 进程"
                  className="h-9 border-white/10 bg-black/20 pl-9 text-xs"
                />
              </div>
              <div className="mt-2 flex items-center justify-between text-[10px] text-zinc-600">
                <span>{rows.length} 个观测会话</span>
                <span>Kafka → PG / ClickHouse</span>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              {listRequest.loading && !listRequest.data ? (
                <div className="flex h-40 items-center justify-center gap-2 text-xs text-zinc-500">
                  <LoaderCircle className="size-4 animate-spin" />
                  加载传输观测
                </div>
              ) : rows.length > 0 ? (
                rows.map((item) => (
                  <ConversationRow
                    key={item.conversationId}
                    item={item}
                    active={item.conversationId === selectedId}
                    onSelect={() => selectConversation(item.conversationId)}
                  />
                ))
              ) : (
                <OperationalEmptyState
                  icon={MessageSquareText}
                  title={
                    listRequest.error
                      ? "会话投影加载失败"
                      : !status?.enabled
                        ? "Interaction 通道尚未启用"
                        : "尚未观测到 LLM 传输"
                  }
                  description={
                    listRequest.error
                      ? "检查管理凭据以及 PostgreSQL / ClickHouse 投影状态后重试。"
                      : !status?.enabled
                      ? "启用 Kafka Interaction 通道和 Observer 元数据转发后，这里会出现传输会话。"
                      : "当前为空只代表没有已投影的观测记录，不代表 Agent 没有对话。"
                  }
                />
              )}
            </div>
          </div>

          <div className="min-h-[460px] overflow-hidden rounded-lg border border-white/10 bg-[#0e1310] lg:min-h-0">
            {!selectedId ? (
              <OperationalEmptyState
                icon={Network}
                title="选择一个观测会话"
                description="查看 Agent 进程、LLM 目标、连接级时序和传输字节证据。"
              />
            ) : detailRequest.loading && !detail ? (
              <div className="flex h-full min-h-64 items-center justify-center gap-2 text-xs text-zinc-500">
                <LoaderCircle className="size-4 animate-spin" />
                加载会话证据
              </div>
            ) : !detail ? (
              <OperationalEmptyState
                icon={EyeOff}
                title="会话详情不可用"
                description="投影可能尚未完成，或当前管理凭据无权读取该记录。"
              />
            ) : (
              <div className="flex h-full min-h-0 flex-col">
                <div className="shrink-0 border-b border-white/10 px-4 py-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <h2 className="truncate text-sm font-semibold text-zinc-100">
                          {detail.conversation.agentInstanceId || "观测进程会话"}
                        </h2>
                        <span
                          className={cn(
                            "rounded border px-1.5 py-0.5 text-[10px]",
                            detail.conversation.contentAvailable
                              ? "border-emerald-400/25 bg-emerald-500/10 text-emerald-200"
                              : "border-amber-400/25 bg-amber-500/10 text-amber-200",
                          )}
                        >
                          {detail.conversation.completeTurns > 0
                            ? `${detail.conversation.completeTurns} 个完整 Turn`
                            : detail.conversation.contentAvailable
                              ? "部分对话"
                              : "正文未采集"}
                        </span>
                      </div>
                      <p className="mt-1 truncate font-mono text-[10px] text-zinc-600">
                        {detail.conversation.conversationId}
                      </p>
                    </div>
                    <div className="text-right text-[11px] text-zinc-500">
                      <p>{detail.observations.length} 条观测证据</p>
                      <p className="mt-1">{dateTime(detail.conversation.lastObservedAt)}</p>
                    </div>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4">
                    <Metric
                      label="完整 Turn / 指令"
                      value={`${detail.conversation.completeTurns ?? 0} / ${
                        detail.conversation.instructionObservations
                      }`}
                      icon={Server}
                    />
                    <Metric
                      label="LLM 请求字节"
                      value={bytes(detail.conversation.requestBytes)}
                      icon={ArrowUpFromLine}
                    />
                    <Metric
                      label="LLM 响应字节"
                      value={bytes(detail.conversation.responseBytes)}
                      icon={ArrowDownToLine}
                    />
                    <Metric
                      label="时序证据"
                      value={
                        detail.conversation.timingScope === "connection"
                          ? "连接级"
                          : "不可用"
                      }
                      icon={Clock3}
                    />
                  </div>
                </div>
                <div className="min-h-0 flex-1 overflow-auto p-4">
                  {detail.conversation.contentAvailable && !status?.directViewEnabled ? (
                    <section
                      className="mb-3 rounded-lg border border-amber-400/20 bg-amber-500/[0.045] p-3"
                      aria-label="正文授权"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <ShieldAlert className="size-4 text-amber-300" aria-hidden="true" />
                          <div>
                            <h3 className="text-xs font-semibold text-amber-100">正文授权</h3>
                            <p className="mt-0.5 text-[10px] text-zinc-600">
                              正文不会随列表或详情自动下载
                            </p>
                          </div>
                        </div>
                        <span
                          className={cn(
                            "rounded border px-2 py-0.5 text-[10px]",
                            status?.rawViewEnabled
                              ? "border-emerald-400/25 bg-emerald-500/10 text-emerald-200"
                              : "border-red-400/20 bg-red-500/[0.07] text-red-200",
                          )}
                        >
                          {status?.rawViewEnabled ? "服务端已启用" : "服务端未启用"}
                        </span>
                      </div>
                      <div className="mt-3 grid gap-2 md:grid-cols-[minmax(180px,0.7fr)_minmax(260px,1.3fr)_auto]">
                        <Input
                          type="password"
                          autoComplete="off"
                          value={rawViewToken}
                          onChange={(event) => {
                            setRawViewTokenDraft(event.target.value);
                            setRawViewTokenSaved(false);
                          }}
                          placeholder="独立正文查看凭据"
                          aria-label="独立正文查看凭据"
                          className="h-9 border-white/10 bg-black/20 font-mono text-xs"
                        />
                        <Input
                          value={rawViewReason}
                          onChange={(event) => setRawViewReason(event.target.value)}
                          placeholder="查看原因（至少 12 个字符）"
                          aria-label="正文查看原因"
                          className="h-9 border-white/10 bg-black/20 text-xs"
                        />
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          className="h-9 border border-white/10 bg-white/5 text-zinc-200 hover:bg-white/10"
                          onClick={() => {
                            setInteractionRawViewToken(rawViewToken);
                            setRawViewTokenSaved(Boolean(rawViewToken.trim()));
                          }}
                        >
                          <LockKeyhole className="mr-1.5 size-3.5" aria-hidden="true" />
                          {rawViewTokenSaved ? "凭据已保存" : "保存凭据"}
                        </Button>
                      </div>
                      <p className="mt-2 text-[10px] leading-4 text-zinc-600">
                        凭据仅保存在当前浏览器；每次查看或删除均携带原因并写入服务端审计。
                      </p>
                    </section>
                  ) : null}
                  <div className="mb-3 rounded-lg border border-sky-400/20 bg-sky-500/[0.07] px-3 py-2.5 text-xs leading-5 text-sky-100/80">
                    {status?.directViewEnabled
                      ? detail.conversation.runtimeType === "codex_app_server"
                        ? "当前为本机直显模式：正文来自 Codex App Server 持久化的原生 Thread / Turn 历史，包含真实用户消息、过程说明和最终回复。"
                        : "当前为本机直显模式：用户指令与 Agent stdout 回复会自动解密并按时间排列。"
                      : detail.conversation.contentAvailable
                        ? "对话正文来自受控 Agent stdin/stdout 观测边界；它表示 Runtime 实际输入输出，不等同于 Agent 最终发送给 LLM 的完整请求上下文。"
                        : "当前证据证明“这个 Agent 进程连接过 LLM Provider”，不证明用户输入了什么。"}
                    {" "}只有携带同一显式 Turn 证据的输入和回复才计为完整 Turn，未关联记录不会强行合并。
                    {" "}HTTP/2、WebSocket 和长连接的时延只显示为连接级，绝不冒充单次请求时延。
                  </div>
                  {hiddenObservationCount > 0 ? (
                    <div className="mb-3 flex items-center justify-center">
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        className="h-8 border border-white/10 bg-white/[0.04] px-3 text-[11px] text-zinc-300 hover:bg-white/[0.08]"
                        onClick={() =>
                          setVisibleObservationCount((count) =>
                            count + CONVERSATION_PAGE_SIZE
                          )
                        }
                      >
                        加载更早记录（还有 {hiddenObservationCount} 条）
                      </Button>
                    </div>
                  ) : detail.observations.length > CONVERSATION_PAGE_SIZE ? (
                    <p className="mb-3 text-center text-[10px] text-zinc-600">
                      已显示本次对话的全部 {detail.observations.length} 条记录
                    </p>
                  ) : null}
                  <ol className="relative space-y-3 border-l border-white/10 pl-5">
                    {visibleObservations.map((observation) => (
                      <li key={observation.interactionId} className="relative">
                        <span
                          className={cn(
                            "absolute -left-[25px] top-3 size-2.5 rounded-full border-2 border-[#0e1310]",
                            observation.eventType === "AgentInputObserved"
                              ? "bg-emerald-300"
                              : observation.eventType === "AgentOutputObserved"
                                ? "bg-sky-300"
                                : "bg-teal-300",
                          )}
                        />
                        {observation.eventType === "AgentInputObserved"
                        || observation.eventType === "AgentOutputObserved" ? (
                          <MessageObservationCard
                            observation={observation}
                            directViewEnabled={Boolean(status?.directViewEnabled)}
                            rawViewEnabled={Boolean(status?.rawViewEnabled)}
                            rawViewToken={rawViewToken}
                            reason={rawViewReason}
                            onDeleted={() => {
                              detailRequest.refresh();
                              listRequest.refresh();
                              statusRequest.refresh();
                            }}
                          />
                        ) : (
                          <article className="rounded-lg border border-white/[0.08] bg-black/15 p-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex items-center gap-2">
                              <Network className="size-4 text-teal-300" />
                              <span className="text-xs font-semibold text-zinc-200">
                                LLM 传输观测
                              </span>
                              <span className="rounded border border-white/10 px-1.5 py-0.5 text-[10px] text-zinc-500">
                                {observation.transport.protocol || "unknown"}
                              </span>
                            </div>
                            <time className="font-mono text-[10px] text-zinc-600">
                              {dateTime(observation.observedAt)}
                            </time>
                          </div>
                          <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-[11px] md:grid-cols-4">
                            <div>
                              <p className="text-zinc-600">目标</p>
                              <p className="mt-0.5 truncate font-mono text-zinc-300">
                                {observation.transport.sni || observation.transport.peer || "--"}
                              </p>
                            </div>
                            <div>
                              <p className="text-zinc-600">进程</p>
                              <p className="mt-0.5 truncate font-mono text-zinc-300">
                                {observation.process.comm || "process"} · PID {observation.process.pid}
                              </p>
                            </div>
                            <div>
                              <p className="text-zinc-600">连接时长</p>
                              <p className="mt-0.5 font-mono text-zinc-300">
                                {observation.transport.latencyAvailability === "available"
                                  ? `${observation.transport.latencyMs ?? 0} ms（连接级）`
                                  : "unavailable"}
                              </p>
                            </div>
                            <div>
                              <p className="text-zinc-600">传输量</p>
                              <p className="mt-0.5 font-mono text-zinc-300">
                                ↑ {bytes(observation.transport.requestBytes)} · ↓ {bytes(observation.transport.responseBytes)}
                              </p>
                            </div>
                          </div>
                          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-white/[0.06] pt-2 text-[10px] text-zinc-600">
                            <span>source: {observation.sourceId}</span>
                            <span>collector: {observation.collectorId}</span>
                            <span>retention: not_retained</span>
                            <span>parse: not_attempted</span>
                          </div>
                          </article>
                        )}
                      </li>
                    ))}
                  </ol>
                </div>
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
