import { createHash } from 'node:crypto';

import type * as T from './types';

export const SEMANTIC_PROJECTION_PARSER_ID = 'anysentry.agent-semantic-timeline';
export const SEMANTIC_PROJECTION_PARSER_VERSION = 1;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function messageText(value: unknown, depth = 0): string | undefined {
  if (depth > 6) return undefined;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const output = value
      .map((item) => messageText(item, depth + 1))
      .filter((item): item is string => Boolean(item))
      .join('');
    return output || undefined;
  }
  const item = record(value);
  if (!item) return undefined;
  const kind = text(item.type);
  if (kind && ![
    'message', 'text', 'output_text', 'input_text', 'content_block',
  ].includes(kind)) return undefined;
  return messageText(
    item.text ?? item.output_text ?? item.content ?? item.output,
    depth + 1,
  );
}

/**
 * Reproject model text from typed provider events when available. Older Observer revisions copied
 * every top-level SSE `delta`, including custom-tool input, into `response.text`; replaying the
 * structured event list here corrects historical rows without mutating their raw evidence.
 */
export function normalizedModelResponseText(
  interaction: T.AgentInteractionRecord,
): string | undefined {
  const structured = interaction.response.structured;
  if (!Array.isArray(structured)) {
    return text(interaction.response.text);
  }

  let recognizedStream = false;
  let responseDeltas = '';
  let anthropicDeltas = '';
  let chatDeltas = '';
  let terminalText: string | undefined;

  for (const rawEvent of structured) {
    const event = record(rawEvent);
    if (!event) continue;
    const eventType = text(event.type);
    if (eventType?.startsWith('response.')
      || eventType?.startsWith('content_block_')
      || eventType?.startsWith('message_')) recognizedStream = true;

    if (eventType === 'response.output_text.delta') {
      responseDeltas += text(event.delta) ?? '';
    } else if (eventType === 'response.output_text.done') {
      terminalText = text(event.text) ?? text(event.delta) ?? terminalText;
    } else if (eventType === 'response.output_item.done') {
      const item = record(event.item);
      if (item?.type === 'message') terminalText = messageText(item) ?? terminalText;
    } else if (eventType === 'response.completed' || eventType === 'response.done') {
      terminalText = messageText(record(event.response)?.output) ?? terminalText;
    } else if (eventType === 'content_block_start') {
      const block = record(event.content_block);
      if (block?.type === 'text') anthropicDeltas += text(block.text) ?? '';
    } else if (eventType === 'content_block_delta') {
      const delta = record(event.delta);
      if (delta?.type === 'text_delta' || (delta?.type === undefined && delta?.partial_json === undefined)) {
        anthropicDeltas += text(delta?.text) ?? '';
      }
    }

    if (Array.isArray(event.choices)) {
      recognizedStream = true;
      for (const rawChoice of event.choices) {
        const choice = record(rawChoice);
        const delta = record(choice?.delta);
        const message = record(choice?.message);
        chatDeltas += text(delta?.content) ?? '';
        terminalText = text(message?.content) ?? terminalText;
      }
    }
  }

  const projected = responseDeltas || anthropicDeltas || chatDeltas || terminalText;
  if (recognizedStream) return text(projected);
  return text(interaction.response.text);
}

function semanticItemId(interactionId: string, kind: string, sequence: number): string {
  return `si_${createHash('sha256')
    .update(`${interactionId}\u0000${kind}\u0000${sequence}`)
    .digest('hex')
    .slice(0, 24)}`;
}

function runtimeContextPart(value: unknown): boolean {
  const item = record(value);
  const valueText = typeof value === 'string'
    ? value.trim()
    : typeof item?.text === 'string' ? item.text.trim() : undefined;
  return Boolean(valueText && ['environment_context', 'system-reminder'].some((tag) =>
    valueText.startsWith(`<${tag}>`) && valueText.endsWith(`</${tag}>`)));
}

export function humanVisibleUserContent(content: unknown): unknown {
  if (!Array.isArray(content)) return runtimeContextPart(content) ? undefined : content;
  const visible = content.filter((part) =>
    record(part)?.type !== 'tool_result' && !runtimeContextPart(part));
  return visible.length ? visible : undefined;
}

/** Additive compatibility parser for persisted interactions created before Observer semantic v1. */
export function semanticItemsForInteraction(
  interaction: T.AgentInteractionRecord,
): T.AgentInteractionSemanticItem[] {
  if (interaction.semanticItems?.length) {
    return interaction.semanticItems.flatMap((item) => {
      if (item.kind !== 'user_message') return [item];
      const content = humanVisibleUserContent(item.content);
      return content === undefined ? [] : [{ ...item, content }];
    });
  }
  const items: T.AgentInteractionSemanticItem[] = [];
  const push = (
    actor: T.AgentInteractionSemanticActor,
    kind: T.AgentInteractionSemanticKind,
    origin: T.AgentInteractionSemanticItem['origin'],
    atUnixNs: string,
    content?: unknown,
    tool?: { toolCallId: string; toolName?: string },
  ) => {
    const sequenceNumber = items.length;
    items.push({
      semanticItemId: semanticItemId(interaction.interactionId, kind, sequenceNumber),
      actor,
      kind,
      phase: kind === 'model_progress' ? 'progress' : 'final',
      origin,
      atUnixNs,
      ...(content !== undefined ? { content } : {}),
      ...(tool?.toolCallId ? { toolCallId: tool.toolCallId } : {}),
      ...(tool?.toolName ? { toolName: tool.toolName } : {}),
      sequenceNumber,
      completeness: interaction.completeness === 'complete' ? 'complete' : 'partial',
      partialReasons: [...interaction.partialReasons],
    });
  };

  for (const message of interaction.request.messages ?? []) {
    if (!['user', 'human'].includes(message.role.toLowerCase())) continue;
    const content = humanVisibleUserContent(message.content);
    if (content !== undefined) {
      push('user', 'user_message', 'request', interaction.startedAtUnixNs, content);
    }
  }
  for (const result of interaction.toolResults) {
    push(
      'tool',
      'tool_result',
      'request',
      interaction.startedAtUnixNs,
      result.content,
      { toolCallId: result.toolCallId, ...(result.name ? { toolName: result.name } : {}) },
    );
  }
  const modelText = normalizedModelResponseText(interaction);
  if (modelText) {
    push(
      'model',
      interaction.toolCalls.length ? 'model_progress' : 'model_final',
      'response',
      interaction.firstResponseAtUnixNs,
      modelText,
    );
  }
  for (const call of interaction.toolCalls) {
    push(
      'tool',
      'tool_call',
      'response',
      call.issuedAtUnixNs ?? interaction.endedAtUnixNs,
      call.arguments,
      { toolCallId: call.toolCallId, toolName: call.name },
    );
  }
  return items;
}

function preview(value: unknown, limit = 320): string | undefined {
  let output: string | undefined;
  if (typeof value === 'string') output = value.replace(/\s+/gu, ' ').trim();
  else if (value !== undefined) {
    try {
      output = JSON.stringify(value);
    } catch {
      output = undefined;
    }
  }
  if (!output) return undefined;
  return output.length > limit ? `${output.slice(0, limit)}…` : output;
}

function semanticHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('hex');
}

function toolIdentity(name: string | undefined, content: unknown): {
  toolName: string;
  toolKind: T.AgentToolKind;
} {
  const nested = typeof content === 'string'
    ? content.match(/\btools\.([A-Za-z_][A-Za-z0-9_]*)/u)?.[1]
    : undefined;
  const raw = (nested ?? name ?? 'tool').trim();
  const normalized = raw.toLowerCase().replace(/[^a-z0-9]+/gu, '_');
  const toolKind: T.AgentToolKind = /(?:^|_)(?:exec|exec_command|bash|shell|terminal)(?:_|$)/u.test(normalized)
    ? 'bash'
    : /(?:^|_)(?:read|read_file|view)(?:_|$)/u.test(normalized)
      ? 'read'
      : /(?:^|_)(?:write|write_file|apply_patch|edit)(?:_|$)/u.test(normalized)
        ? 'write'
        : /(?:search|grep|find|web_search|search_query)/u.test(normalized)
          ? 'search'
          : /(?:^|_)mcp(?:_|$)/u.test(normalized)
            ? 'mcp'
            : /(?:^|_)skill(?:_|$)/u.test(normalized)
              ? 'skill'
              : /(?:http|fetch|request)/u.test(normalized)
                ? 'http'
                : /(?:python|javascript|code)/u.test(normalized) ? 'code' : 'other';
  return { toolName: raw, toolKind };
}

function semanticEventId(
  conversationId: string,
  interactionId: string,
  item: T.AgentInteractionSemanticItem,
): string {
  return `se_${createHash('sha256')
    .update(`${conversationId}\u0000${interactionId}\u0000${item.semanticItemId}`)
    .digest('hex')
    .slice(0, 24)}`;
}

function compareSemanticEvent(left: T.AgentSemanticEvent, right: T.AgentSemanticEvent): number {
  const leftAt = BigInt(left.atUnixNs);
  const rightAt = BigInt(right.atUnixNs);
  if (leftAt !== rightAt) return leftAt < rightAt ? -1 : 1;
  const rank: Record<T.AgentSemanticEventKind, number> = {
    user_message: 10,
    tool_result: 20,
    model_progress: 30,
    model_final: 30,
    tool_call: 40,
  };
  return rank[left.kind] - rank[right.kind]
    || left.semanticEventId.localeCompare(right.semanticEventId);
}

export function projectSemanticConversationTimeline(
  conversation: T.AgentConversationSummary,
  interactions: T.AgentInteractionRecord[],
  segments: T.ConversationInstanceSegment[],
): T.AgentConversationTurnV2[] {
  const ordered = [...interactions].sort((left, right) =>
    left.at - right.at || left.interactionId.localeCompare(right.interactionId));
  const segmentByInteraction = new Map<string, string>();
  for (const interaction of ordered) {
    const interactionAt = BigInt(interaction.startedAtUnixNs);
    const matching = segments.filter((segment) =>
      segment.agentInstanceId === interaction.agentInstanceId);
    const segment = matching.find((candidate) => {
      const startedAt = BigInt(candidate.startedAtUnixNs);
      const endedAt = candidate.endedAtUnixNs ? BigInt(candidate.endedAtUnixNs) : undefined;
      return interactionAt >= startedAt && (endedAt === undefined || interactionAt <= endedAt);
    }) ?? matching.at(-1);
    if (segment) segmentByInteraction.set(interaction.interactionId, segment.segmentId);
  }

  const calls = new Map<string, T.AgentSemanticEvent>();
  const resultKeys = new Set<string>();
  const resolvedToolCallIds = new Set(ordered.flatMap((interaction) =>
    interaction.toolResults.map((result) => result.toolCallId)));
  let previousUserLineage: string[] = [];
  const turns = new Map<string, {
    ordinal: number;
    events: T.AgentSemanticEvent[];
    diagnostics: T.AgentTimelineDiagnostic[];
    startedAtUnixNs: string;
    endedAtUnixNs: string;
  }>();

  for (const interaction of ordered) {
    const turnId = interaction.turnId ?? `${conversation.conversationId}:turn:1`;
    const turn = turns.get(turnId) ?? {
      ordinal: turns.size + 1,
      events: [],
      diagnostics: [],
      startedAtUnixNs: interaction.startedAtUnixNs,
      endedAtUnixNs: interaction.endedAtUnixNs,
    };
    turn.endedAtUnixNs = interaction.endedAtUnixNs;
    turns.set(turnId, turn);
    const semanticItems = semanticItemsForInteraction(interaction);
    const userItems = semanticItems.filter((item) => item.kind === 'user_message');
    const userHashes = userItems.map((item) => semanticHash(item.content));
    let firstNewUser = 0;
    while (
      firstNewUser < previousUserLineage.length
      && firstNewUser < userHashes.length
      && previousUserLineage[firstNewUser] === userHashes[firstNewUser]
    ) firstNewUser += 1;
    if (userHashes.length) previousUserLineage = userHashes;

    for (const item of semanticItems) {
      if (item.kind === 'user_message' && userItems.indexOf(item) < firstNewUser) continue;
      if (item.kind === 'tool_result') {
        const resultKey = `${item.toolCallId ?? 'unlinked'}\u0000${semanticHash(item.content)}`;
        if (resultKeys.has(resultKey)) continue;
        resultKeys.add(resultKey);
      }
      if (item.kind === 'tool_call' && item.toolCallId && calls.has(item.toolCallId)) continue;
      const segmentId = segmentByInteraction.get(interaction.interactionId)
        ?? segments[0]?.segmentId
        ?? `seg_unlinked_${interaction.interactionId}`;
      const tool = item.actor === 'tool'
        ? toolIdentity(item.toolName, item.content)
        : undefined;
      const pairedResult = item.kind === 'tool_call' && item.toolCallId
        ? ordered.some((record) => record.toolResults.some((result) =>
            result.toolCallId === item.toolCallId))
        : false;
      const event: T.AgentSemanticEvent = {
        semanticEventId: semanticEventId(conversation.conversationId, interaction.interactionId, item),
        conversationId: conversation.conversationId,
        segmentId,
        turnId,
        actor: item.actor,
        kind: item.kind,
        ...(item.phase ? { phase: item.phase } : {}),
        atUnixNs: item.atUnixNs,
        ...(item.content !== undefined ? { content: item.content } : {}),
        ...(preview(item.content) ? { contentPreview: preview(item.content) } : {}),
        ...(item.toolCallId ? { toolCallId: item.toolCallId } : {}),
        ...(tool ? { toolName: tool.toolName, toolKind: tool.toolKind } : {}),
        ...(item.kind === 'tool_call'
          ? { status: pairedResult ? 'succeeded' as const : 'pending' as const }
          : item.kind === 'tool_result'
            ? { status: interaction.toolResults.find((result) =>
                result.toolCallId === item.toolCallId)?.isError ? 'failed' as const : 'succeeded' as const }
            : {}),
        sourceInteractionIds: [interaction.interactionId],
        sourceItemIds: [item.sourceItemId ?? item.semanticItemId],
        parserId: interaction.semanticParserId ?? SEMANTIC_PROJECTION_PARSER_ID,
        parserVersion: interaction.semanticParserVersion ?? SEMANTIC_PROJECTION_PARSER_VERSION,
        correlationQuality: interaction.correlationQuality ?? 'inferred',
        completeness: item.completeness,
        partialReasons: [...item.partialReasons],
      };
      turn.events.push(event);
      if (item.kind === 'tool_call' && item.toolCallId) calls.set(item.toolCallId, event);
    }

    if (interaction.attemptId?.endsWith(':attempt:2')) {
      turn.diagnostics.push({
        diagnosticId: `diag_retry_${interaction.interactionId}`,
        type: 'retry',
        severity: 'info',
        message: '模型请求发生重试',
        interactionId: interaction.interactionId,
      });
    }
    const unresolvedToolCall = interaction.toolCalls.some((call) =>
      !resolvedToolCallIds.has(call.toolCallId));
    const resolvedToolPending = interaction.statusCode < 400
      && interaction.toolCalls.length > 0
      && !unresolvedToolCall
      && (
        interaction.conversationCompleteness === 'tool_pending'
        || interaction.partialReasons.includes('tool_result_pending')
      )
      && interaction.transportCompleteness !== 'partial'
      && (interaction.wireCompleteness === undefined || interaction.wireCompleteness === 'complete')
      && interaction.partialReasons.every((reason) => reason === 'tool_result_pending');
    if (
      interaction.statusCode >= 400
      || (interaction.completeness !== 'complete' && !resolvedToolPending)
    ) {
      turn.diagnostics.push({
        diagnosticId: `diag_gap_${interaction.interactionId}`,
        type: interaction.parseState && interaction.parseState !== 'parsed' ? 'parse_gap' : 'capture_gap',
        severity: interaction.statusCode >= 400 ? 'error' : 'warning',
        message: interaction.statusCode >= 400
          ? `模型请求失败（HTTP ${interaction.statusCode}）`
          : interaction.partialReasons.join('、') || '该次交互的采集证据不完整',
        interactionId: interaction.interactionId,
      });
    }
  }

  return [...turns.entries()].map(([turnId, turn]) => ({
    turnId,
    ordinal: turn.ordinal,
    state: turn.diagnostics.some((item) => item.severity !== 'info') ? 'incomplete' : 'complete',
    startedAtUnixNs: turn.startedAtUnixNs,
    endedAtUnixNs: turn.endedAtUnixNs,
    events: turn.events.sort(compareSemanticEvent),
    diagnostics: turn.diagnostics,
  }));
}
