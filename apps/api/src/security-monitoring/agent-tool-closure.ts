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
