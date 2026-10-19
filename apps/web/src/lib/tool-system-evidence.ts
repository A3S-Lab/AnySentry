import type { LocalRecordDetail, LocalRecordTimelineEvent } from "./api/security-center";

export type SystemEvidence = NonNullable<LocalRecordDetail["systemEvidence"]>;
export type SystemEvent = SystemEvidence["events"][number];
export interface ToolEvidenceMatch {
  confirmed: SystemEvent[];
  candidates: SystemEvent[];
  commands: string[];
  ambiguousCallId: boolean;
  sessionAssociated?: boolean;
  checked?: boolean;
  evidencePartial?: boolean;
  status?: NonNullable<LocalRecordDetail["toolEvidence"]>["calls"][number]["status"];
}

// Static literals only; never evaluate a recorded program. These provide search candidates,
// not proof of execution. Dynamic expressions and compound-call ownership remain unknown.
export function literalToolCommands(call: LocalRecordTimelineEvent): string[] {
  const commands = new Set<string>();
  if (call.command?.trim()) commands.add(call.command.trim());
  const body = call.content?.slice(0, 200_000) ?? "";
  try {
    const value = JSON.parse(body);
    for (const key of ["cmd", "command"]) {
      if (typeof value?.[key] === "string" && value[key].trim()) commands.add(value[key].trim());
    }
  } catch { /* Raw code-mode payload, not JSON. */ }
  for (const match of body.matchAll(/\btools\.exec_command\s*\(\s*\{\s*cmd\s*:\s*("(?:\\.|[^"\\])*")\s*[,}]/g)) {
    try {
      const command = JSON.parse(match[1]);
      if (command.trim()) commands.add(command.trim());
    } catch { /* Unsupported literal stays unparsed. */ }
  }
  return [...commands];
}

/** Presentation index only; does not write or upgrade Session attribution. */
export function indexToolSystemEvidence(
  nativeSessionId: string,
  events: LocalRecordTimelineEvent[],
  evidence?: SystemEvidence,
  projection?: LocalRecordDetail["toolEvidence"],
) {
  const calls = events.filter((event) => event.kind === "tool_call");
  const byEvent = new Map<string, ToolEvidenceMatch>();
  const owners = new Map<string, LocalRecordTimelineEvent[]>();
  for (const call of calls) {
    if (call.callId) owners.set(call.callId, [...(owners.get(call.callId) ?? []), call]);
  }
  const scopeMatches = Boolean(evidence && evidence.binding.nativeSessionId === nativeSessionId);
  const systemEvents = scopeMatches ? [...new Map(evidence!.events.map((event) => [event.eventId, event])).values()] : [];
  const assigned = new Set<string>();
  const candidateIds = new Set<string>();
  for (const call of calls) {
    const match: ToolEvidenceMatch = {
      confirmed: [], candidates: [], commands: literalToolCommands(call),
      ambiguousCallId: Boolean(call.callId && owners.get(call.callId)!.length > 1),
      sessionAssociated: scopeMatches && systemEvents.length > 0,
      evidencePartial: scopeMatches && (evidence?.completeness === "partial" || Boolean(evidence?.page?.hasMore) || Boolean(projection?.partial)),
    };
    if (projection) {
      const row = scopeMatches && projection.nativeSessionId === nativeSessionId
        ? projection.calls.find(item => item.callEventId === call.eventId && item.callId === call.callId)
        : undefined;
      match.checked = Boolean(row);
      match.status = row?.status;
      if (row && !match.ambiguousCallId) {
        const confirmed = new Set(row.confirmedEventIds);
        const candidates = new Set(row.candidates.map(item => item.eventId));
        for (const event of systemEvents) {
          // The producer declaration stays independently visible; a candidate projection cannot
          // manufacture a trusted claim or override a conflicting call binding.
          if (confirmed.has(event.eventId) && event.toolCallBinding?.method === "authenticated_agent_adapter"
            && event.toolCallBinding.toolCallId === call.callId) {
            match.confirmed.push(event); assigned.add(event.eventId);
          } else if (candidates.has(event.eventId) && !event.toolCallBinding) {
            match.candidates.push(event); candidateIds.add(event.eventId);
          }
        }
      }
      byEvent.set(call.eventId, match);
      continue;
    }
    const results = events.filter((event) => event.kind === "tool_result"
      && call.callId && event.callId === call.callId
      && event.turnId === call.turnId && event.timestamp >= call.timestamp);
    const until = results.length ? Math.min(...results.map((event) => event.timestamp)) : undefined;
    for (const event of systemEvents) {
      const binding = event.toolCallBinding;
      if (binding) {
        // Never reuse a conflicting explicit claim as a command/time candidate.
        if (binding.method === "authenticated_agent_adapter" && binding.toolCallId === call.callId && !match.ambiguousCallId) {
          match.confirmed.push(event);
          assigned.add(event.eventId);
        }
        continue;
      }
      if (!match.ambiguousCallId && until !== undefined && event.eventKind === "ToolExec"
        && event.processInstanceKey && event.at >= call.timestamp - 250 && event.at <= until + 250
        && event.command && match.commands.includes(event.command.trim())) {
        match.candidates.push(event);
        candidateIds.add(event.eventId);
      }
    }
    byEvent.set(call.eventId, match);
  }
  return {
    byEvent, scopeMatches,
    confirmedEvents: assigned.size,
    candidateEvents: candidateIds.size,
    // Candidates remain unassigned. A single event may be a candidate for concurrent calls.
    unassigned: systemEvents.filter((event) => !assigned.has(event.eventId)),
  };
}
