/**
 * P2 ToolCall ↔ ToolResult closure across Interactions in the same Session/Segment.
 * Projection-only: never mutates stored interaction rows; returns completeness overrides
 * and append-only RelationRevision / EvidenceLink records.
 */

import {
  createEvidenceLink,
  createRelationRevision,
  type EvidenceLink,
  type RelationRevision,
} from './canonical-observability';
import type { AgentInteractionRecord } from './types';

export const AGENT_TOOL_CLOSURE_VERSION = 1;

export interface ToolClosureMatch {
  toolCallId: string;
  callInteractionId: string;
  resultInteractionId: string;
  callAtUnixNs: string;
  resultAtUnixNs: string;
  firstSeen: boolean;
}

export interface ToolClosureProjection {
  interactionId: string;
  /** Observed completeness on the stored row (never mutated). */
  asObservedCompleteness?: AgentInteractionRecord['conversationCompleteness'];
  /** Effective completeness after cross-interaction ToolResult pairing. */
  currentEffectiveCompleteness?: AgentInteractionRecord['conversationCompleteness'];
  closedToolCallIds: string[];
}

export interface ToolClosureResult {
  matches: ToolClosureMatch[];
  projections: ToolClosureProjection[];
  evidenceLinks: EvidenceLink[];
  relationRevisions: RelationRevision[];
}

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : undefined;
}

function sessionScopeKey(interaction: AgentInteractionRecord): string {
  return [
    interaction.canonicalSessionId
      ?? interaction.sessionKey
      ?? interaction.sessionId
      ?? interaction.providerConversationId
      ?? 'unknown-session',
    interaction.agentAssetId ?? 'unknown-asset',
    interaction.canonicalAgentInstanceId
      ?? interaction.agentInstanceId
      ?? interaction.runtimeInstanceId
      ?? 'unknown-instance',
  ].join('\0');
}

function resultObservedAt(interaction: AgentInteractionRecord, toolCallId: string): string {
  const match = interaction.toolResults.find((result) => result.toolCallId === toolCallId);
  return text(match?.observedAtUnixNs, 32)
    ?? text(interaction.requestCompleteAtUnixNs, 32)
    ?? text(interaction.startedAtUnixNs, 32)
    ?? '1000000000';
}

function callIssuedAt(interaction: AgentInteractionRecord, toolCallId: string): string {
  const match = interaction.toolCalls.find((call) => call.toolCallId === toolCallId);
  return text(match?.issuedAtUnixNs, 32)
    ?? text(interaction.firstResponseAtUnixNs, 32)
    ?? text(interaction.startedAtUnixNs, 32)
    ?? '1000000000';
}

function isReplayTraffic(interaction: AgentInteractionRecord): boolean {
  return interaction.trafficRole === 'context_replay';
}

/**
 * Pair ToolCalls from earlier interactions with first-seen ToolResults later in the same
 * Session/Segment scope. Replay traffic can supply historical results but only the first
 * observation of a toolCallId counts as the closing result.
 */
export function closeToolCallsAcrossInteractions(
  interactions: readonly AgentInteractionRecord[],
): ToolClosureResult {
  const ordered = [...interactions].sort((left, right) =>
    left.at - right.at
    || left.interactionId.localeCompare(right.interactionId));

  const openCalls = new Map<string, {
    toolCallId: string;
    interaction: AgentInteractionRecord;
    scope: string;
  }>();
  const firstResultForCall = new Map<string, {
    toolCallId: string;
    interaction: AgentInteractionRecord;
    scope: string;
  }>();
  const matches: ToolClosureMatch[] = [];

  for (const interaction of ordered) {
    const scope = sessionScopeKey(interaction);
    // Open new tool calls even on conversation rows that are still tool_pending.
    for (const call of interaction.toolCalls) {
      const toolCallId = text(call.toolCallId, 512);
      if (!toolCallId) continue;
      const key = `${scope}\0${toolCallId}`;
      if (!openCalls.has(key)) {
        openCalls.set(key, { toolCallId, interaction, scope });
      }
    }
    for (const result of interaction.toolResults) {
      const toolCallId = text(result.toolCallId, 512);
      if (!toolCallId) continue;
      const key = `${scope}\0${toolCallId}`;
      const open = openCalls.get(key);
      if (!open) continue;
      // Same-interaction pairing is already complete at parse time; still record first-seen
      // for projection when conversationCompleteness stayed tool_pending due to Observer timing.
      if (!firstResultForCall.has(key)) {
        firstResultForCall.set(key, { toolCallId, interaction, scope });
        matches.push({
          toolCallId,
          callInteractionId: open.interaction.interactionId,
          resultInteractionId: interaction.interactionId,
          callAtUnixNs: callIssuedAt(open.interaction, toolCallId),
          resultAtUnixNs: resultObservedAt(interaction, toolCallId),
          firstSeen: !isReplayTraffic(interaction) || open.interaction.interactionId !== interaction.interactionId,
        });
      }
    }
  }

  // Only first-seen results close a call. Drop accidental duplicate match rows.
  const uniqueMatches = [...new Map(
    matches.map((match) => [`${match.callInteractionId}\0${match.toolCallId}`, match]),
  ).values()];

  const closedByCallInteraction = new Map<string, string[]>();
  for (const match of uniqueMatches) {
    const list = closedByCallInteraction.get(match.callInteractionId) ?? [];
    list.push(match.toolCallId);
    closedByCallInteraction.set(match.callInteractionId, list);
  }

  const projections: ToolClosureProjection[] = ordered.map((interaction) => {
    const closed = closedByCallInteraction.get(interaction.interactionId) ?? [];
    const pendingIds = interaction.toolCalls
      .map((call) => text(call.toolCallId, 512))
      .filter((id): id is string => Boolean(id));
    const allClosed = pendingIds.length > 0
      && pendingIds.every((id) => closed.includes(id));
    const asObserved = interaction.conversationCompleteness;
    const currentEffective = allClosed && asObserved === 'tool_pending'
      ? 'complete' as const
      : asObserved;
    return {
      interactionId: interaction.interactionId,
      ...(asObserved ? { asObservedCompleteness: asObserved } : {}),
      ...(currentEffective ? { currentEffectiveCompleteness: currentEffective } : {}),
      closedToolCallIds: closed,
    };
  });

  const evidenceLinks: EvidenceLink[] = [];
  const relationRevisions: RelationRevision[] = [];
  for (const match of uniqueMatches) {
    const resultSemanticId = `sr_tool_result_${match.resultInteractionId}_${match.toolCallId}`;
    const link = createEvidenceLink({
      fromType: 'tool_call',
      fromId: match.toolCallId,
      toType: 'semantic_record',
      toId: resultSemanticId,
      relation: 'supports',
      method: 'explicit_id',
      confidence: 1,
      authority: 'attested_observer',
      evidenceRefs: [
        match.callInteractionId,
        match.resultInteractionId,
        match.toolCallId,
      ],
      algorithmVersion: `agent-tool-closure.v${AGENT_TOOL_CLOSURE_VERSION}`,
      status: 'confirmed',
      validFromUnixNs: match.resultAtUnixNs,
      resolutionRevision: 1,
    });
    evidenceLinks.push(link);
    relationRevisions.push(createRelationRevision({
      relation: link,
      revision: 1,
      decidedAtUnixNs: match.resultAtUnixNs,
      sourceRefs: link.evidenceRefs,
    }));
  }

  return { matches: uniqueMatches, projections, evidenceLinks, relationRevisions };
}

/** Lookup helper for Inspector / directory projection. */
export function projectedConversationCompleteness(
  result: ToolClosureResult,
  interactionId: string,
): AgentInteractionRecord['conversationCompleteness'] | undefined {
  return result.projections.find((item) => item.interactionId === interactionId)
    ?.currentEffectiveCompleteness;
}

export const TOOL_CALL_RECONSTRUCTED_FROM_REQUEST_HISTORY =
  'tool_call_reconstructed_from_request_history';

export interface HistoryToolCallReconstruction {
  toolCallId: string;
  name: string;
  arguments: unknown;
  sourceInteractionId: string;
  issuedAtUnixNs: string;
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requestPayload(interaction: AgentInteractionRecord): Record<string, unknown> | undefined {
  const structured = asRecord(interaction.request.structured);
  if (structured) return structured;
  return asRecord(parseJsonValue(interaction.request.body));
}

function parseToolArguments(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? {};
  const parsed = parseJsonValue(value);
  return parsed === undefined ? value : parsed;
}

/**
 * Lift assistant/tool_use/function_call entries from a later model request's message history.
 * Observer only extracts toolCalls from response bodies, so a missed prior model round leaves
 * orphan toolResults whose originating assistant tool_calls still appear in subsequent requests.
 */
export function extractAssistantToolCallsFromRequestPayload(
  payload: unknown,
): Array<{ toolCallId: string; name: string; arguments: unknown }> {
  const root = asRecord(payload);
  if (!root) return [];
  const buckets: unknown[] = [];
  if (Array.isArray(root.messages)) buckets.push(...root.messages);
  if (Array.isArray(root.input)) buckets.push(...root.input);

  const out: Array<{ toolCallId: string; name: string; arguments: unknown }> = [];
  const seen = new Set<string>();
  const push = (toolCallId: string | undefined, name: string | undefined, args: unknown) => {
    const id = text(toolCallId, 512);
    const toolName = text(name, 256) ?? 'unknown';
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push({ toolCallId: id, name: toolName, arguments: parseToolArguments(args) });
  };

  for (const entry of buckets) {
    const message = asRecord(entry);
    if (!message) continue;

    // OpenAI chat-completions / compatible assistants.
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const raw of message.tool_calls) {
        const call = asRecord(raw);
        if (!call) continue;
        const fn = asRecord(call.function);
        push(
          text(call.id, 512) ?? text(call.tool_call_id, 512),
          text(fn?.name, 256) ?? text(call.name, 256),
          fn?.arguments ?? call.arguments ?? call.input,
        );
      }
    }

    // Anthropic message content blocks (and OpenAI content-part variants).
    const content = message.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        const block = asRecord(part);
        if (!block) continue;
        if (block.type === 'tool_use' || block.type === 'tool_call' || block.type === 'function') {
          push(
            text(block.id, 512) ?? text(block.tool_call_id, 512),
            text(block.name, 256) ?? text(asRecord(block.function)?.name, 256),
            block.input ?? block.arguments ?? asRecord(block.function)?.arguments,
          );
        }
      }
    }

    // OpenAI Responses-style input items.
    if (message.type === 'function_call' || message.type === 'custom_tool_call') {
      push(
        text(message.call_id, 512) ?? text(message.id, 512),
        text(message.name, 256),
        message.arguments ?? message.input,
      );
    }
  }
  return out;
}

/**
 * Projection-only: for toolResults whose toolCallId was never observed as a response-issued
 * toolCall, reconstruct the missing assistant tool_calls from later request history and attach
 * them to the earliest interaction that still carries those calls in its request payload.
 */
export function reconstructMissingToolCallsFromRequestHistory(
  interactions: readonly AgentInteractionRecord[],
): HistoryToolCallReconstruction[] {
  const ordered = [...interactions].sort((left, right) =>
    left.at - right.at
    || left.interactionId.localeCompare(right.interactionId));
  const observedCallIds = new Set<string>();
  for (const interaction of ordered) {
    for (const call of interaction.toolCalls) {
      const id = text(call.toolCallId, 512);
      if (id) observedCallIds.add(id);
    }
  }
  const orphanResultIds = new Set<string>();
  for (const interaction of ordered) {
    for (const result of interaction.toolResults) {
      const id = text(result.toolCallId, 512);
      if (id && !observedCallIds.has(id)) orphanResultIds.add(id);
    }
  }
  if (!orphanResultIds.size) return [];

  const reconstructions: HistoryToolCallReconstruction[] = [];
  const claimed = new Set<string>();
  for (const interaction of ordered) {
    const payload = requestPayload(interaction);
    if (!payload) continue;
    for (const call of extractAssistantToolCallsFromRequestPayload(payload)) {
      if (!orphanResultIds.has(call.toolCallId) || claimed.has(call.toolCallId)) continue;
      claimed.add(call.toolCallId);
      let issuedAtUnixNs = interaction.startedAtUnixNs;
      try {
        // Keep reconstructed calls strictly before the request that replayed them so timeline
        // ordering places tool_call ahead of the paired tool_result (same-ns rank favors results).
        issuedAtUnixNs = String(BigInt(interaction.startedAtUnixNs) - 1_000_000n);
      } catch {
        /* keep interaction boundary */
      }
      reconstructions.push({
        toolCallId: call.toolCallId,
        name: call.name,
        arguments: call.arguments,
        sourceInteractionId: interaction.interactionId,
        issuedAtUnixNs,
      });
    }
  }
  return reconstructions;
}

/**
 * Return shallow-cloned interactions with reconstructed history toolCalls attached.
 * Never mutates the stored Observer rows.
 */
export function projectInteractionsWithReconstructedHistoryToolCalls(
  interactions: readonly AgentInteractionRecord[],
): AgentInteractionRecord[] {
  const reconstructions = reconstructMissingToolCallsFromRequestHistory(interactions);
  if (!reconstructions.length) {
    return [...interactions].sort((left, right) =>
      left.at - right.at
      || left.interactionId.localeCompare(right.interactionId));
  }
  const byInteraction = new Map<string, HistoryToolCallReconstruction[]>();
  for (const item of reconstructions) {
    const list = byInteraction.get(item.sourceInteractionId) ?? [];
    list.push(item);
    byInteraction.set(item.sourceInteractionId, list);
  }
  return [...interactions]
    .sort((left, right) =>
      left.at - right.at
      || left.interactionId.localeCompare(right.interactionId))
    .map((interaction) => {
      const extra = byInteraction.get(interaction.interactionId);
      if (!extra?.length) return interaction;
      return {
        ...interaction,
        toolCalls: [
          ...extra.map((item) => ({
            toolCallId: item.toolCallId,
            name: item.name,
            arguments: item.arguments,
            issuedAtUnixNs: item.issuedAtUnixNs,
          })),
          ...interaction.toolCalls,
        ],
        partialReasons: [...new Set([
          ...interaction.partialReasons,
          TOOL_CALL_RECONSTRUCTED_FROM_REQUEST_HISTORY,
        ])],
      };
    });
}

export const AGENT_HTTP_TOOL_EVIDENCE_VERSION = 1;

export interface HttpToolCaptureLink {
  toolCallId: string;
  modelInteractionId: string;
  httpInteractionId: string;
  evidenceEventIds: string[];
}

/**
 * Projection-only: attach HTTP tool-route capture evidence (/bash/execute, /mcp, …)
 * onto semantic tool_calls that share the same toolCallId (Observer x-anysentry-tool-call-id).
 */
export function linkHttpToolCaptureEvidence(
  interactions: readonly AgentInteractionRecord[],
): {
  byToolCallId: Map<string, HttpToolCaptureLink>;
  evidenceLinks: EvidenceLink[];
  relationRevisions: RelationRevision[];
} {
  const ordered = [...interactions].sort((left, right) =>
    left.at - right.at
    || left.interactionId.localeCompare(right.interactionId));

  type HttpHit = {
    interactionId: string;
    evidenceEventIds: string[];
    scope: string;
    at: number;
  };
  const httpByCall = new Map<string, HttpHit>();
  for (const interaction of ordered) {
    if (interaction.interactionType !== 'tool') continue;
    const scope = sessionScopeKey(interaction);
    const evidenceEventIds = [...(interaction.evidenceEventIds ?? [])]
      .map((id) => text(id, 128))
      .filter((id): id is string => Boolean(id));
    for (const call of interaction.toolCalls) {
      const toolCallId = text(call.toolCallId, 512);
      if (!toolCallId) continue;
      const key = `${scope}\0${toolCallId}`;
      const prior = httpByCall.get(key);
      if (!prior || interaction.at < prior.at) {
        httpByCall.set(key, {
          interactionId: interaction.interactionId,
          evidenceEventIds,
          scope,
          at: interaction.at,
        });
      }
    }
  }

  const byToolCallId = new Map<string, HttpToolCaptureLink>();
  const evidenceLinks: EvidenceLink[] = [];
  const relationRevisions: RelationRevision[] = [];
  for (const interaction of ordered) {
    if (interaction.interactionType === 'tool') continue;
    const scope = sessionScopeKey(interaction);
    for (const call of interaction.toolCalls) {
      const toolCallId = text(call.toolCallId, 512);
      if (!toolCallId || byToolCallId.has(toolCallId)) continue;
      const hit = httpByCall.get(`${scope}\0${toolCallId}`);
      if (!hit) continue;
      const link: HttpToolCaptureLink = {
        toolCallId,
        modelInteractionId: interaction.interactionId,
        httpInteractionId: hit.interactionId,
        evidenceEventIds: hit.evidenceEventIds,
      };
      byToolCallId.set(toolCallId, link);
      if (!hit.evidenceEventIds.length) continue;
      const evidence = createEvidenceLink({
        fromType: 'tool_call',
        fromId: toolCallId,
        toType: 'semantic_record',
        toId: `sr_http_tool_${hit.interactionId}_${toolCallId}`,
        relation: 'supports',
        method: 'explicit_id',
        confidence: 1,
        authority: 'attested_observer',
        evidenceRefs: [
          interaction.interactionId,
          hit.interactionId,
          toolCallId,
          ...hit.evidenceEventIds.slice(0, 8),
        ],
        algorithmVersion: `agent-http-tool-evidence.v${AGENT_HTTP_TOOL_EVIDENCE_VERSION}`,
        status: 'confirmed',
        validFromUnixNs: callIssuedAt(interaction, toolCallId),
        resolutionRevision: 1,
      });
      evidenceLinks.push(evidence);
      relationRevisions.push(createRelationRevision({
        relation: evidence,
        revision: 1,
        decidedAtUnixNs: callIssuedAt(interaction, toolCallId),
        sourceRefs: evidence.evidenceRefs,
      }));
    }
  }

  return { byToolCallId, evidenceLinks, relationRevisions };
}
