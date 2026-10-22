import type { LocalRecordDetail, LocalRecordTimelineEvent } from "./api/security-center";
import { observerRequestScope } from "./observer-request-scope.ts";

export type TraceRowType = "TURN" | "MODEL" | "TOOL" | "MESSAGE" | "SYSTEM";
export interface LocalTraceRow {
  id: string;
  type: TraceRowType;
  name: string;
  at?: number;
  endAt?: number;
  durationMs?: number;
  input?: string;
  output?: string;
  status: string;
  source: string;
  sessionId: string;
  turnId?: string;
  traceId?: string;
  callId?: string;
  eventId?: string;
  model?: string;
  pid?: number;
  association?: string;
  metadata: Record<string, unknown>;
}

const validTime = (at?: number) => at !== undefined && Number.isFinite(at) && at > 0 ? at : undefined;
const pairKey = (e: LocalRecordTimelineEvent) => e.callId ? JSON.stringify([e.turnId ?? null, e.callId]) : undefined;
const duration = (start?: number, end?: number) => start !== undefined && end !== undefined && end >= start ? end - start : undefined;

/** Read-only display projection. Row IDs are UI identities, never invented trace/span IDs. */
export function buildLocalTraceRows(detail: LocalRecordDetail, loadedEvents = detail.events): LocalTraceRow[] {
  const events = [...new Map(loadedEvents.map(e => [e.eventId, e])).values()].sort((a, b) => a.sourceOffset - b.sourceOffset);
  const sessionId = detail.record.sessionId;
  const rows: LocalTraceRow[] = [];
  const groups = new Map<string, LocalRecordTimelineEvent[]>();
  const pairs = new Map<string, { calls: LocalRecordTimelineEvent[]; results: LocalRecordTimelineEvent[] }>();
  for (const e of events) {
    if (e.turnId) groups.set(e.turnId, [...(groups.get(e.turnId) ?? []), e]);
    const key = pairKey(e);
    if (key && (e.kind === "tool_call" || e.kind === "tool_result")) {
      const pair = pairs.get(key) ?? { calls: [], results: [] };
      pair[e.kind === "tool_call" ? "calls" : "results"].push(e);
      pairs.set(key, pair);
    }
  }
  for (const [turnId, group] of groups) {
    const starts = group.filter(e => e.kind === "turn_start");
    const ends = group.filter(e => e.kind === "turn_complete");
    const start = starts.length === 1 ? starts[0] : undefined;
    const end = ends.length === 1 ? ends[0] : undefined;
    const partial = !start || !end;
    const failed = group.some(e => e.kind === "tool_result" && e.status === "failure");
    rows.push({ id: `turn:${turnId}`, type: "TURN", name: "Turn 汇总", sessionId, turnId,
      at: validTime(start?.timestamp ?? group[0]?.timestamp), endAt: validTime(end?.timestamp),
      durationMs: start && end ? duration(validTime(start.timestamp), validTime(end.timestamp)) : undefined,
      input: group.filter(e => e.kind === "user_message").map(e => e.content ?? "").join("\n\n") || undefined,
      output: group.filter(e => e.kind === "assistant_message").map(e => e.content ?? "").join("\n\n") || undefined,
      status: end ? failed ? "完成 · 含失败工具" : "已结束" : "边界未齐", source: "本地会话 · 汇总",
      metadata: { projection: "loaded_turn_summary", partial, turnId,
        toolCalls: group.filter(e => e.kind === "tool_call").length,
        sourceEventIds: group.map(e => e.eventId), durationSource: start && end ? "turn_boundaries" : "unavailable" },
    });
  }
  const pairedResults = new Set<string>();
  for (const e of events.filter(e => e.kind === "tool_call")) {
    const pair = pairs.get(pairKey(e) ?? "");
    // Duplicate IDs or a partial window stay separate rather than joining across a Turn.
    const result = pair?.calls.length === 1 && pair.results.length === 1
      && pair.results[0].sourceOffset > e.sourceOffset ? pair.results[0] : undefined;
    if (result) pairedResults.add(result.eventId);
    const scopeMatches = detail.toolEvidence?.nativeSessionId === sessionId
      && detail.systemEvidence?.binding.nativeSessionId === sessionId;
    const projection = scopeMatches ? detail.toolEvidence?.calls.find(c => c.callEventId === e.eventId && c.callId === e.callId) : undefined;
    const association = !projection ? "未核验" : projection.status === "confirmed" ? "已确认"
      : projection.status === "candidate" ? `候选 ${projection.candidates.length} 条`
        : projection.status === "ambiguous" ? "关联歧义" : "尚未关联";
    rows.push({ id: `tool:${e.eventId}`, type: "TOOL", name: e.toolName ?? e.title,
      sessionId, turnId: e.turnId, callId: e.callId, eventId: e.eventId,
      at: validTime(e.timestamp), endAt: validTime(result?.timestamp),
      durationMs: result ? result.durationMs ?? duration(validTime(e.timestamp), validTime(result.timestamp)) : undefined,
      input: e.content ?? e.command, output: result?.content,
      status: result?.status === "failure" ? "失败" : result?.status === "success" ? "成功" : result ? "结果状态未知" : "结果未加载",
      source: "本地会话", association,
      metadata: { sourceOffset: e.sourceOffset, resultEventId: result?.eventId, resultOffset: result?.sourceOffset,
        command: e.command, workdir: e.workdir, pairing: result ? "unique_turn_and_call_id" : "unresolved",
        systemAssociation: projection ?? null, declaredStatus: e.status },
    });
  }
  for (const e of events) {
    if (e.kind === "tool_result" && !pairedResults.has(e.eventId)) {
      rows.push({ id: `result:${e.eventId}`, type: "TOOL", name: `${e.toolName ?? "工具"} · 独立结果`,
        sessionId, turnId: e.turnId, callId: e.callId, eventId: e.eventId, at: validTime(e.timestamp),
        output: e.content, status: e.status === "failure" ? "失败" : "调用未配对", source: "本地会话",
        metadata: { sourceOffset: e.sourceOffset, pairing: "unresolved", declaredStatus: e.status },
      });
    } else if (e.kind === "user_message" || e.kind === "assistant_message") {
      rows.push({ id: `message:${e.eventId}`, type: "MESSAGE", name: e.kind === "user_message" ? "用户指令" : "AI 回复",
        sessionId, turnId: e.turnId, eventId: e.eventId, at: validTime(e.timestamp),
        input: e.kind === "user_message" ? e.content : undefined, output: e.kind === "assistant_message" ? e.content : undefined,
        status: "已记录", source: "本地会话", metadata: { role: e.role, phase: e.phase, sourceOffset: e.sourceOffset },
      });
    }
  }
  for (const request of new Map(detail.observedLlmRequests.map(r => [r.interactionId, r])).values()) {
    const scope = observerRequestScope(request, sessionId);
    rows.push({ id: `request:${request.interactionId}`, type: "MODEL",
      name: scope === "auto_review" ? "自动审核请求" : scope === "related_thread" ? "关联线程请求" : "模型请求",
      sessionId: request.sessionId, turnId: request.turnId, eventId: request.interactionId,
      at: validTime(request.observedAt), model: request.model, pid: request.pid,
      input: request.contentAvailability === "available" ? request.content : undefined,
      status: "已观测", source: "Observer", association: scope === "main" ? "主会话请求" : "独立请求",
      metadata: { ...request, content: undefined, requestScope: scope, responseAvailability: "not_collected" },
    });
  }
  if (detail.systemEvidence?.binding.nativeSessionId === sessionId) {
    const evidence = detail.systemEvidence;
    for (const e of new Map(evidence.events.map(e => [e.eventId, e])).values()) {
      rows.push({ id: `system:${e.eventId}`, type: "SYSTEM", name: e.eventKind, at: validTime(e.at),
        sessionId, eventId: e.eventId, traceId: e.traceId, pid: e.pid,
        callId: e.toolCallBinding?.toolCallId, input: e.command ?? e.subject, status: e.verdict || "已观测",
        source: "Observer", association: e.toolCallBinding ? "可信调用绑定" : "会话级归属",
        metadata: { ...e, bindingId: evidence.binding.bindingId, evidenceScope: evidence.evidenceScope },
      });
    }
    for (const e of evidence.startupContext ?? []) {
      rows.push({ id: `startup:${e.eventId}`, type: "SYSTEM", name: "启动上下文", at: validTime(e.at),
        sessionId, eventId: e.eventId, source: "归因结果", status: "身份切换前", association: "未归属",
        metadata: { ...e, reason: "before_agent_identity_transition" },
      });
    }
    for (const e of evidence.exceptions) {
      rows.push({ id: `exception:${e.resultId}`, type: "SYSTEM", name: "归属待复核", sessionId,
        eventId: e.eventId, source: "归因结果", status: e.status === "CONFLICT" ? "身份冲突" : "归属歧义",
        association: "未确认", metadata: { ...e },
      });
    }
  }
  return rows.sort((a, b) => (b.at ?? -Infinity) - (a.at ?? -Infinity) || a.id.localeCompare(b.id));
}
