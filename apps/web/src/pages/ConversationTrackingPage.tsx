import { useDebounce, useRequest } from "ahooks";
import dayjs from "dayjs";
import {
  AlertTriangle,
  CircleCheck,
  CircleDashed,
  Clock3,
  LoaderCircle,
  MessageSquareText,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { useSecurityConsole } from "@/components/custom/security-console-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { liveSecuritySnapshotAsOf } from "@/lib/date-time";
import {
  type AgentClassification,
  type AgentConversationCoverageStatus,
  type AgentConversationSummary,
  type AgentRuntimeInstanceRecord,
  type AgentSemanticEvent,
  type LogicalAgentConversationDirectoryItemV3,
  securityCenterApi,
} from "@/lib/api/security-center";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { ConversationSemanticTimeline } from "./conversations/ConversationSemanticTimeline";
import { ConversationOverview } from "./conversations/ConversationOverview";
import { LogicalAgentNavigator } from "./conversations/LogicalAgentNavigator";
import { SemanticInteractionInspector } from "./conversations/SemanticInteractionInspector";
import { useResizableConversationPanels } from "./conversations/useResizableConversationPanels";

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

function clean(value: string) {
  return value.trim() || undefined;
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
  const selectedInstanceId = searchParams.get("instanceId") ?? "";
  const selectedConversationId = searchParams.get("conversationId") ?? "";
  const selectedEventId = searchParams.get("semanticEventId") ?? searchParams.get("eventId") ?? "";
  const selectedInteractionId = searchParams.get("interactionId") ?? "";
  const previousTopAgent = useRef<string>();
  const {
    containerRef: panelContainerRef,
    panelStyle,
    leftSeparatorProps,
    rightSeparatorProps,
  } = useResizableConversationPanels();

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
  }), [
    classification,
    consoleTimeFilter.endTime,
    consoleTimeFilter.snapshotAsOf,
    consoleTimeFilter.startTime,
    coverageStatus,
    query,
    scopedAgentAssetId,
    timeType,
  ]);

  const {
    data: directory,
    loading: conversationsLoading,
    error: conversationsError,
    refresh: refreshConversations,
  } = useRequest(() => securityCenterApi.agentConversationDirectoryV3(conversationQuery), {
    refreshDeps: [conversationQuery, refreshVersion],
    pollingInterval: 10_000,
    pollingWhenHidden: false,
  });

  const selectedLogicalAgent = useMemo(() => {
    const conversationOwner = selectedConversationId
      ? directory?.items.find((item) => item.userThreads.some((conversation) =>
          conversation.conversationId === selectedConversationId))
      : undefined;
    return conversationOwner
      ?? directory?.items.find((item) => item.logicalAgentId === selectedLogicalAgentId);
  }, [directory?.items, selectedConversationId, selectedLogicalAgentId]);
  const selectedConversation = useMemo(() => (
    selectedLogicalAgent?.userThreads.find((item) => item.conversationId === selectedConversationId)
    ?? directory?.items.flatMap((item) => item.userThreads)
      .find((item) => item.conversationId === selectedConversationId)
  ), [directory?.items, selectedConversationId, selectedLogicalAgent?.userThreads]);

  const updateRoute = (mutate: (next: URLSearchParams) => void, replace = false) => {
    const next = new URLSearchParams(searchParams);
    mutate(next);
    setSearchParams(next, { replace });
  };
  const clearEventSelection = (next: URLSearchParams) => {
    next.delete("semanticEventId");
    next.delete("eventId");
    next.delete("interactionId");
  };
  const selectConversation = (conversation: AgentConversationSummary, replace = false) => {
    if (!replace) setLiveFollow(false);
    updateRoute((next) => {
      const owner = directory?.items.find((item) => item.userThreads.some((candidate) =>
        candidate.conversationId === conversation.conversationId));
      if (owner) next.set("logicalAgentId", owner.logicalAgentId);
      next.set("conversationId", conversation.conversationId);
      next.delete("technicalActivityId");
      if (selectedInstanceId && !conversation.agentInstanceIds.includes(selectedInstanceId)) {
        next.delete("instanceId");
      }
      clearEventSelection(next);
    }, replace);
  };
  const selectLogicalAgent = (
    agent: LogicalAgentConversationDirectoryItemV3,
    replace = false,
  ) => {
    if (!replace) setLiveFollow(false);
    updateRoute((next) => {
      next.set("logicalAgentId", agent.logicalAgentId);
      next.delete("instanceId");
      next.delete("conversationId");
      next.delete("technicalActivityId");
      clearEventSelection(next);
    }, replace);
  };
  const selectRuntimeInstance = (
    agent: LogicalAgentConversationDirectoryItemV3,
    instance: AgentRuntimeInstanceRecord,
  ) => {
    setLiveFollow(false);
    const canonical = instance.canonicalAgentInstanceId ?? instance.agentInstanceId;
    updateRoute((next) => {
      next.set("logicalAgentId", agent.logicalAgentId);
      next.set("instanceId", canonical);
      next.delete("conversationId");
      next.delete("technicalActivityId");
      clearEventSelection(next);
    });
  };

  useEffect(() => {
    const top = directory?.items[0];
    if (!top) return;
    const conversationOwner = selectedConversationId
      ? directory.items.find((item) => item.userThreads.some((conversation) =>
          conversation.conversationId === selectedConversationId))
      : undefined;
    if (conversationOwner && conversationOwner.logicalAgentId !== selectedLogicalAgentId) {
      updateRoute((next) => next.set("logicalAgentId", conversationOwner.logicalAgentId), true);
      previousTopAgent.current = top.logicalAgentId;
      return;
    }
    const selectedExists = directory.items.some((item) => item.logicalAgentId === selectedLogicalAgentId);
    const followedPreviousTop = selectedLogicalAgentId === previousTopAgent.current;
    if (!selectedExists || (
      liveFollow
      && !selectedConversationId
      && !selectedInstanceId
      && followedPreviousTop
      && top.logicalAgentId !== selectedLogicalAgentId
    )) {
      selectLogicalAgent(top, true);
    }
    previousTopAgent.current = top.logicalAgentId;
  }, [directory?.items, liveFollow, selectedConversationId, selectedInstanceId, selectedLogicalAgentId]);

  const timelineClientKey = useMemo(() => JSON.stringify({
    conversationId: selectedConversationId,
    agentAssetId: selectedConversation?.agentAssetId ?? clean(scopedAgentAssetId),
    timeType,
    startTime: conversationQuery.startTime,
    endTime: conversationQuery.endTime,
    snapshotAsOf: conversationQuery.snapshotAsOf,
    refreshVersion,
  }), [
    conversationQuery.endTime,
    conversationQuery.snapshotAsOf,
    conversationQuery.startTime,
    refreshVersion,
    scopedAgentAssetId,
    selectedConversation?.agentAssetId,
    selectedConversationId,
    timeType,
  ]);
  const {
    data: timelineEnvelope,
    loading: timelineLoading,
    error: timelineError,
    refresh: refreshTimeline,
  } = useRequest(async () => ({
    clientKey: timelineClientKey,
    timeline: await securityCenterApi.agentConversationTimelineV3({
      ...conversationQuery,
      conversationId: selectedConversationId,
      agentAssetId: selectedConversation?.agentAssetId ?? clean(scopedAgentAssetId),
    }),
  }), {
    ready: Boolean(selectedConversationId),
    // Selection and URL state change immediately, while the client-key guard below removes the
    // prior Thread body. Debounce only the expensive server projection so rapid keyboard/mouse
    // switching produces one request for the final Thread instead of an unbounded request burst.
    debounceWait: 120,
    refreshDeps: [
      conversationQuery,
      refreshVersion,
      selectedConversation?.agentAssetId,
      selectedConversation?.hasContent,
      selectedConversationId,
    ],
    pollingInterval: 10_000,
    pollingWhenHidden: false,
  });
  const timeline = timelineEnvelope?.clientKey === timelineClientKey
    && (
      timelineEnvelope.timeline.requestedConversationId === selectedConversationId
      || timelineEnvelope.timeline.canonicalConversationId === selectedConversationId
    )
    ? timelineEnvelope.timeline
    : undefined;
  const timelinePending = Boolean(selectedConversationId && !timeline) || timelineLoading;
  useEffect(() => {
    const canonical = timeline?.canonicalConversationId;
    if (!canonical || canonical === selectedConversationId) return;
    updateRoute((next) => {
      next.set("conversationId", canonical);
      clearEventSelection(next);
    }, true);
  }, [selectedConversationId, timeline?.canonicalConversationId]);
  useEffect(() => {
    if (timeline?.redirectTarget?.type !== "technical_activity") return;
    const activity = directory?.items
      .flatMap((item) => item.technicalActivities.map((technical) => ({ item, technical })))
      .find(({ technical }) => technical.technicalActivityId === timeline.redirectTarget?.id);
    updateRoute((next) => {
      next.delete("conversationId");
      clearEventSelection(next);
      next.set("technicalActivityId", timeline.redirectTarget!.id);
      if (activity) {
        next.set("logicalAgentId", activity.item.logicalAgentId);
        if (activity.technical.agentInstanceId) {
          next.set("instanceId", activity.technical.agentInstanceId);
        }
      }
    }, true);
  }, [directory?.items, timeline?.redirectTarget?.id, timeline?.redirectTarget?.type]);
  const selectedEvent = useMemo(() => {
    const events = timeline?.turns.flatMap((turn) => turn.events) ?? [];
    return events.find((event) => event.semanticEventId === selectedEventId)
      ?? events.find((event) => event.sourceInteractionIds.includes(selectedInteractionId));
  }, [selectedEventId, selectedInteractionId, timeline?.turns]);
  const interactionClientKey = [
    selectedConversation?.agentAssetId ?? "",
    selectedEvent?.sourceInteractionIds[0] ?? "",
    timeType,
    consoleTimeFilter.startTime ?? "",
    consoleTimeFilter.endTime ?? "",
  ].join("\u0000");
  const {
    data: interactionEnvelope,
    loading: interactionLoading,
    refresh: refreshInteraction,
  } = useRequest(async () => ({
    clientKey: interactionClientKey,
    list: await securityCenterApi.agentInteractions({
      timeType,
      startTime: timeType === "custom" ? consoleTimeFilter.startTime : undefined,
      endTime: timeType === "custom" ? consoleTimeFilter.endTime : undefined,
      scope: "agent",
      classificationView: "current_effective",
      agentAssetId: selectedConversation?.agentAssetId,
      interactionId: selectedEvent?.sourceInteractionIds[0],
      limit: 1,
    }),
  }), {
    ready: Boolean(selectedEvent?.sourceInteractionIds[0]),
    refreshDeps: [
      selectedConversation?.agentAssetId,
      selectedEvent?.sourceInteractionIds[0],
      timeType,
      consoleTimeFilter.startTime,
      consoleTimeFilter.endTime,
    ],
  });

  const selectedInteraction = interactionEnvelope?.clientKey === interactionClientKey
    ? interactionEnvelope.list.items[0]
    : undefined;
  const evidenceClientKey = [
    timeline?.canonicalConversationId ?? selectedConversationId,
    selectedEvent?.semanticEventId ?? "",
    timeType,
  ].join("\u0000");
  const {
    data: evidenceEnvelope,
    loading: evidenceLoading,
  } = useRequest(async () => ({
    clientKey: evidenceClientKey,
    evidence: await securityCenterApi.agentSemanticEvidence({
      timeType,
      startTime: timeType === "custom" ? consoleTimeFilter.startTime : undefined,
      endTime: timeType === "custom" ? consoleTimeFilter.endTime : undefined,
      scope: "agent",
      classificationView: "current_effective",
      conversationId: timeline?.canonicalConversationId ?? selectedConversationId,
      semanticEventId: selectedEvent!.semanticEventId,
    }),
  }), {
    ready: Boolean(
      selectedEvent?.actor === "tool"
      && selectedConversationId
      && (timeline?.canonicalConversationId ?? selectedConversationId),
    ),
    refreshDeps: [evidenceClientKey],
  });
  const semanticEvidence = evidenceEnvelope?.clientKey === evidenceClientKey
    ? evidenceEnvelope.evidence
    : undefined;
  const selectEvent = (event: AgentSemanticEvent) => updateRoute((next) => {
    next.set("semanticEventId", event.semanticEventId);
    next.delete("eventId");
    if (event.sourceInteractionIds[0]) next.set("interactionId", event.sourceInteractionIds[0]);
    else next.delete("interactionId");
  });
  const closeInspector = () => updateRoute(clearEventSelection, true);
  const clearSelectionOnMobile = () => updateRoute((next) => {
    for (const key of ["logicalAgentId", "instanceId", "conversationId"]) next.delete(key);
    clearEventSelection(next);
  }, true);
  const setCoverage = (value: AgentConversationCoverageStatus | "all") => updateRoute((next) => {
    if (value === "all") next.delete("coverage");
    else next.set("coverage", value);
    for (const key of ["instanceId", "conversationId", "technicalActivityId"]) next.delete(key);
    clearEventSelection(next);
  }, true);
  const setClassification = (value: AgentClassification | "all") => updateRoute((next) => {
    if (value === "all") next.delete("classification");
    else next.set("classification", value);
    for (const key of ["instanceId", "conversationId", "technicalActivityId"]) next.delete(key);
    clearEventSelection(next);
  }, true);
  const clearFilters = () => {
    setQueryText("");
    updateRoute((next) => {
      for (const key of [
        "coverage", "classification", "agentAssetId", "logicalAgentId", "instanceId",
        "conversationId", "technicalActivityId", "semanticEventId", "eventId", "interactionId",
      ]) next.delete(key);
    }, true);
  };

  const completeCount = directory?.items.filter((item) => item.coverage.status === "complete").length ?? 0;
  const assetOnlyCount = directory?.items.filter((item) => item.conversationCount === 0).length ?? 0;
  const abnormalCount = directory?.items.filter((item) =>
    !["complete", "asset_only", "no_activity"].includes(item.coverage.status)).length ?? 0;

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-[#0b0f0c] text-zinc-100">
      <header className="shrink-0 border-b border-white/10 bg-[#0d120f] px-3 py-3 sm:px-4">
        <div className="flex flex-col gap-3 2xl:flex-row 2xl:items-center 2xl:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <MessageSquareText className="size-5 shrink-0 text-violet-300" aria-hidden="true" />
              <h1 className="truncate text-lg font-semibold tracking-normal text-zinc-50">{t("对话追踪")}</h1>
              <Pill className="border-white/10 bg-white/[0.035] text-zinc-400">semantic v{timeline?.parserVersion ?? 2}</Pill>
            </div>
            <p className="mt-1 truncate text-xs text-zinc-500">按逻辑 Agent、运行实例和 Thread 还原用户、模型、工具三类完整链路</p>
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
                selectedConversationId ? refreshTimeline() : Promise.resolve(),
                selectedEvent?.sourceInteractionIds[0] ? refreshInteraction() : Promise.resolve(),
              ])}
              disabled={conversationsLoading || timelinePending || interactionLoading}
              className="h-11 bg-violet-500 text-white hover:bg-violet-400 sm:h-9"
            >
              {conversationsLoading || timelinePending || interactionLoading
                ? <LoaderCircle className="size-3.5 animate-spin" />
                : <RefreshCw className="size-3.5" />}刷新
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
        <div
          ref={panelContainerRef}
          style={panelStyle}
          className="grid h-full min-h-0 grid-cols-1 md:grid-cols-[var(--conversation-left)_minmax(0,1fr)] xl:grid-cols-[var(--conversation-left)_minmax(480px,1fr)_var(--conversation-right)]"
        >
          <div className={cn(
            "relative min-h-0",
            selectedLogicalAgentId || selectedInstanceId || selectedConversationId ? "hidden md:block" : "block",
          )}>
            <LogicalAgentNavigator
              items={directory?.items ?? []}
              runtimeInstances={directory?.items.flatMap((item) => item.recentInstances) ?? []}
              selectedLogicalAgentId={selectedLogicalAgent?.logicalAgentId}
              selectedInstanceId={selectedInstanceId}
              selectedConversationId={selectedConversationId}
              loading={conversationsLoading}
              error={conversationsError}
              onSelectAgent={selectLogicalAgent}
              onSelectInstance={selectRuntimeInstance}
              onSelectConversation={selectConversation}
            />
            <div {...leftSeparatorProps} className="group absolute -right-1.5 top-0 z-30 hidden h-full w-3 cursor-col-resize touch-none items-center justify-center md:flex">
              <span className="h-full w-px bg-transparent transition-colors group-hover:bg-violet-400/50 group-focus-visible:bg-violet-300" />
            </div>
          </div>
          <div className={cn(
            "min-h-0",
            selectedLogicalAgentId || selectedInstanceId || selectedConversationId ? "block" : "hidden md:block",
            !selectedConversationId && "xl:col-span-2",
          )}>
            {selectedConversationId ? (
              <ConversationSemanticTimeline
                agent={selectedLogicalAgent}
                conversation={selectedConversation ?? timeline?.thread}
                turns={timeline?.turns ?? []}
                segments={timeline?.segments ?? []}
                selectedEventId={selectedEvent?.semanticEventId}
                loading={timelinePending}
                error={!timeline ? timelineError : undefined}
                contextReplaySummaries={timeline?.contextReplaySummaries ?? []}
                technicalActivities={timeline?.technicalActivitySummaries ?? []}
                onBack={clearSelectionOnMobile}
                onSelect={selectEvent}
                onSelectConversation={selectConversation}
              />
            ) : (
              <ConversationOverview
                agent={selectedLogicalAgent}
                instanceId={selectedInstanceId}
                onSelectConversation={selectConversation}
                onBack={clearSelectionOnMobile}
              />
            )}
          </div>
          <div className={cn("relative min-h-0", !selectedConversationId && "hidden")}>
            <div {...rightSeparatorProps} className="group absolute -left-1.5 top-0 z-30 hidden h-full w-3 cursor-col-resize touch-none items-center justify-center xl:flex">
              <span className="h-full w-px bg-transparent transition-colors group-hover:bg-violet-400/50 group-focus-visible:bg-violet-300" />
            </div>
            <SemanticInteractionInspector
              event={selectedEvent}
              interaction={selectedInteraction}
              loading={interactionLoading}
              semanticEvidence={semanticEvidence}
              evidenceLoading={evidenceLoading}
              onClose={closeInspector}
            />
          </div>
        </div>
      </main>
    </div>
  );
}
