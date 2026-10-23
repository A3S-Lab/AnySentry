/**
 * Conversation-as-LocalRecord adapter: renders the feat/agent-trace LocalRecordTracking
 * presentation on top of the UOS plaintext conversation lane (agent_interactions_v1 via
 * /security-center/conversations*). No CLI/local-session data is involved; every field is
 * derived from observer-captured LLM HTTP plaintext.
 */
import {
  securityCenterApi,
  type InteractionConversationDetail,
  type InteractionToolEvent,
  type InteractionConversationList,
  type InteractionConversationSummary,
  type LocalObservedLlmRequest,
  type LocalRecordDetail,
  type LocalRecordList,
  type LocalRecordSummary,
  type LocalRecordTimelineEvent,
  type LocalRecordTrackingStatus,
} from "@/lib/api/security-center";

const ADAPTER = "langchain_http" as const;

function activityStatus(lastObservedAt: number): LocalRecordSummary["activityStatus"] {
  const ageMs = Date.now() - lastObservedAt;
  // UOS plaintext interactions are completed units (exported after [DONE]); nothing is "still
  // writing" unless traffic arrived within the last minute. Anything older is a finished record
  // that merely saw recent activity — the page badge must not suggest an open stream.
  if (ageMs < 60_000) return "active";
  if (ageMs < 24 * 3_600_000) return "recent";
  return "stopped";
}

function emptyTokenUsage() {
  return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 };
}

function toRecordSummary(item: InteractionConversationSummary): LocalRecordSummary {
  const anchor = item.conversationId.replace(/^uosconv:/, "");
  return {
    recordId: item.conversationId,
    adapter: ADAPTER,
    sessionId: anchor,
    title: item.title ?? `${item.provider ?? "LLM"} 会话 ${anchor.slice(0, 12)}`,
    ...(item.workspacePath ? { cwd: item.workspacePath } : {}),
    modelProvider: item.provider,
    startedAt: item.firstObservedAt,
    updatedAt: item.lastObservedAt,
    fileBytes: item.requestBytes + item.responseBytes,
    processStatus: "unknown",
    processEvidence: "not_observed",
    activityStatus: activityStatus(item.lastObservedAt),
    metricScope: "full_record",
    userMessageCount: item.instructionObservations,
    assistantMessageCount: item.responseObservations,
    completeTurnCount: item.completeTurns,
    toolCallCount: item.toolCallCount ?? 0,
    toolFailureCount: 0,
    tokenUsage: item.tokenUsage
      ? { ...emptyTokenUsage(), ...item.tokenUsage }
      : emptyTokenUsage(),
  };
}

function synthesizedStatus(items: LocalRecordSummary[]): LocalRecordTrackingStatus {
  return {
    schemaVersion: "anysentry.local-record-tracking-status.v1",
    enabled: true,
    adapter: "multi",
    adapters: [ADAPTER],
    rootConfigured: true,
    rootAccessible: true,
    recordCount: items.length,
    readMode: "bounded_read_only",
    contentSource: "local_session_files",
    systemEvidence: "unavailable",
    processObservation: {
      schemaVersion: "anysentry.local-record-process-observation.v1",
      enabled: false,
      bound: 0,
      unbound: items.length,
      scanErrors: 0,
    },
  } as LocalRecordTrackingStatus;
}

export async function conversationRecordList(query: { limit?: number } = {}): Promise<LocalRecordList> {
  const list: InteractionConversationList = await securityCenterApi.interactionConversations({
    limit: query.limit ?? 300,
  });
  const items = list.items.map(toRecordSummary);
  const count = (predicate: (item: LocalRecordSummary) => boolean) => items.filter(predicate).length;
  return {
    schemaVersion: "anysentry.local-record-list.v1",
    status: synthesizedStatus(items),
    items,
    total: list.total,
    aggregates: {
      runningProcesses: 0,
      exitedRecords: 0,
      unknownProcessRecords: items.length,
      activeRecords: count((item) => item.activityStatus === "active"),
      recentRecords: count((item) => item.activityStatus === "recent"),
      totalBytes: items.reduce((sum, item) => sum + item.fileBytes, 0),
      observedTokens: items.reduce((sum, item) => sum + item.tokenUsage.totalTokens, 0),
      observedToolCalls: items.reduce((sum, item) => sum + item.toolCallCount, 0),
    },
    updateTime: list.updateTime,
  };
}

type InteractionObservation = InteractionConversationDetail["observations"][number];

function toToolTimelineEvent(
  tool: InteractionToolEvent,
  observation: InteractionObservation,
  index: number,
  order: number,
): LocalRecordTimelineEvent {
  return {
    eventId: `${observation.interactionId}:tool:${order}`,
    kind: tool.kind === "call" ? "tool_call" : "tool_result",
    timestamp: observation.observedAt,
    role: "assistant",
    title: tool.kind === "call"
      ? `工具调用 · ${tool.name || "unnamed"}`
      : `工具返回 · ${tool.name || "unnamed"}`,
    content: tool.detail,
    toolName: tool.name || undefined,
    callId: tool.toolCallId,
    status: "observed",
    sourceOffset: index,
  };
}

function toTimelineEvents(observation: InteractionObservation, index: number): LocalRecordTimelineEvent[] {
  if (observation.eventType === "AgentInputObserved") {
    const events: LocalRecordTimelineEvent[] = [{
      eventId: observation.interactionId,
      kind: "user_message",
      timestamp: observation.observedAt,
      role: "user",
      title: "用户指令",
      content: observation.content,
      status: "observed",
      ...(observation.rawBody ? { rawBody: observation.rawBody } : {}),
      ...(observation.rawMeta ? { rawMeta: observation.rawMeta } : {}),
      sourceOffset: index,
    }];
    // The tool timeline normally rides the response observation; it lands here only when
    // the response was never captured, so render it right after the instruction bubble.
    let order = 0;
    for (const tool of observation.toolEvents ?? []) {
      events.push(toToolTimelineEvent(tool, observation, index, order));
      order += 1;
    }
    return events;
  }
  if (observation.eventType === "AgentOutputObserved") {
    const output = observation.output;
    const model = output.protocol !== "native_stdio" && output.protocol !== "codex_app_server"
      ? output.model
      : undefined;
    const tools = observation.toolEvents ?? [];
    const events: LocalRecordTimelineEvent[] = [];
    // The in-progress chain recovered from the request context precedes the reply bubble;
    // the calls this response itself made follow it.
    let order = 0;
    for (const tool of tools) {
      if (tool.source !== "request_context") continue;
      events.push(toToolTimelineEvent(tool, observation, index, order));
      order += 1;
    }
    events.push({
      eventId: observation.interactionId,
      kind: "assistant_message",
      timestamp: observation.observedAt,
      role: "assistant",
      title: model ? `模型回复 · ${model}` : "模型回复",
      content: observation.content,
      status: "observed",
      ...(observation.rawBody ? { rawBody: observation.rawBody } : {}),
      ...(observation.rawMeta ? { rawMeta: observation.rawMeta } : {}),
      sourceOffset: index,
    });
    for (const tool of tools) {
      if (tool.source !== "response") continue;
      events.push(toToolTimelineEvent(tool, observation, index, order));
      order += 1;
    }
    return events;
  }
  return [];
}

/** A tool call reappears in the next request's message history; keep the first sighting
 *  (by call id when present) so multi-turn chains render each call exactly once. */
function dedupeToolEvents(events: LocalRecordTimelineEvent[]): LocalRecordTimelineEvent[] {
  const seen = new Set<string>();
  return events.filter((event) => {
    if (event.kind !== "tool_call" && event.kind !== "tool_result") return true;
    const key = `${event.kind}:${event.callId ?? `${event.toolName ?? ""}:${(event.content ?? "").slice(0, 64)}`}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function toObservedLlmRequest(observation: InteractionObservation): LocalObservedLlmRequest | null {
  if (observation.eventType !== "AgentOutputObserved") return null;
  const output = observation.output;
  if (output.protocol === "native_stdio" || output.protocol === "codex_app_server") return null;
  const assistant = observation.assistantResponse;
  return {
    interactionId: observation.interactionId,
    observedAt: observation.observedAt,
    pid: 0,
    protocol: output.transportProtocol,
    providerHost: output.providerHost,
    requestPath: output.requestPath,
    endpointAttribution: output.endpointAttribution,
    model: output.model,
    sessionId: observation.conversationId.replace(/^uosconv:/, ""),
    threadId: observation.conversationId,
    content: observation.content,
    contentBytes: assistant.contentBytes,
    contentSha256: assistant.contentSha256,
    contentAvailability: observation.contentAvailability === "available" ? "available" : "unavailable",
    capture: {
      method: "ebpf_openssl",
      profile: "exact_pid_runtime",
      completeness: "partial",
      parseStatus: "parsed",
    },
  };
}

export async function conversationRecordDetail(
  recordId: string,
  _options: Record<string, unknown> = {},
): Promise<LocalRecordDetail | null> {
  const detail: InteractionConversationDetail | null = await securityCenterApi
    .interactionConversation(recordId)
    .catch(() => null);
  if (!detail) return null;
  const record = toRecordSummary(detail.conversation);
  const events = dedupeToolEvents(detail.observations
    .flatMap((observation, index) => toTimelineEvents(observation, index)));
  const observedLlmRequests = detail.observations
    .map(toObservedLlmRequest)
    .filter((request): request is LocalObservedLlmRequest => Boolean(request));
  const metrics = {
    scope: "full_record" as const,
    scannedBytes: record.fileBytes,
    fileBytes: record.fileBytes,
    messageCount: record.userMessageCount + record.assistantMessageCount,
    userMessageCount: record.userMessageCount,
    assistantMessageCount: record.assistantMessageCount,
    turnCount: record.completeTurnCount,
    completeTurnCount: record.completeTurnCount,
    toolCallCount: events.filter((event) => event.kind === "tool_call").length,
    toolResultCount: events.filter((event) => event.kind === "tool_result").length,
    toolFailureCount: 0,
    completedDurationMs: Math.max(0, detail.conversation.lastObservedAt - detail.conversation.firstObservedAt),
    tokenUsage: record.tokenUsage,
  };
  const contentObserved = detail.observations.some(
    (observation) => observation.contentAvailability === "available",
  );
  return {
    schemaVersion: "anysentry.local-record-detail.v1",
    record,
    events,
    observedLlmRequests,
    metrics,
    page: {
      beforeOffset: events.length,
      hasMore: false,
      returnedEvents: events.length,
      scannedFromOffset: 0,
      scannedToOffset: events.length,
      truncatedLines: 0,
    },
    provenance: {
      source: "langchain_http_plaintext",
      captureMethod: "ebpf_plaintext",
      readOnly: true,
      ebpfIncluded: true,
      observerRequestEvidence: contentObserved ? "observed" : "not_observed",
      observerSource: "anysentry_observer",
      toolSemantics: "agent_declared",
    },
    updateTime: new Date().toISOString(),
  } as unknown as LocalRecordDetail;
}

/** System evidence is wired to the kernel-event lane in phase 2; empty for now. */
export async function conversationRecordSystemEvidence(
  recordId: string,
  options: Record<string, unknown> = {},
): Promise<LocalRecordDetail | null> {
  return conversationRecordDetail(recordId, options);
}
