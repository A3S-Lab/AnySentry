import { Injectable, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';

import type * as T from './types';
import type { AgentConversationProjection } from './agent-conversation';
import { humanVisibleUserContent } from './agent-semantic-timeline';
import { RelationalBusinessStore } from './relational-business-store.service';

export const AGENT_CONVERSATION_RESOLVER_VERSION = 1;

function normalized(value?: string): string {
  return value?.trim().toLowerCase().replace(/\s+/gu, ' ') ?? '';
}

function stableId(prefix: string, value: string): string {
  return `${prefix}_${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
}

function userLineage(record: T.AgentInteractionRecord): string[] {
  return (record.request.messages ?? [])
    .filter((message) => ['user', 'human'].includes(message.role.toLowerCase()))
    .map((message) => humanVisibleUserContent(message.content))
    .filter((content) => content !== undefined)
    .map((content) => createHash('sha256').update(canonicalJson(content)).digest('hex'));
}

function properPrefix(left: string[], right: string[]): boolean {
  return left.length > 0
    && left.length < right.length
    && left.every((value, index) => value === right[index]);
}

function equalLineage(left: string[], right: string[]): boolean {
  return left.length > 0
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function cliProduct(value?: string): boolean {
  const product = normalized(value);
  return ['codex', 'claude', 'pi', 'kimi'].some((candidate) => product.includes(candidate));
}

export function conversationLogicalScopeKey(record: T.AgentInteractionRecord): string {
  return stableId('ls', [
    normalized(record.agentProduct),
    normalized(record.workspacePath),
    normalized(record.process?.hostId),
  ].join('\u0000'));
}

function compareInteraction(left: T.AgentInteractionRecord, right: T.AgentInteractionRecord): number {
  return left.at - right.at || left.interactionId.localeCompare(right.interactionId);
}

function threadRank(source: T.AgentConversationThreadRecord['idSource']): number {
  return source === 'provider' ? 3 : source === 'runtime' ? 2 : 1;
}

@Injectable()
export class AgentConversationBindingService {
  private readonly bindings = new Map<string, T.AgentConversationBindingRecord>();
  private readonly threads = new Map<string, T.AgentConversationThreadRecord>();
  private readonly segments = new Map<string, T.ConversationInstanceSegment>();

  constructor(
    @Optional() private readonly relationalStore?: RelationalBusinessStore,
  ) {}

  async applyPersistedBindings(
    interactions: T.AgentInteractionRecord[],
  ): Promise<T.AgentInteractionRecord[]> {
    if (interactions.length === 0) return [];
    const interactionIds = interactions.map((record) => record.interactionId);
    if (this.relationalStore?.configured()) {
      const loadedBindings = await this.relationalStore.loadAgentConversationBindings(interactionIds);
      for (const binding of loadedBindings) {
        this.bindings.set(binding.interactionId, binding);
      }
      for (const thread of await this.relationalStore.loadAgentConversationThreads(
        loadedBindings.map((binding) => binding.logicalScopeKey),
      )) this.threads.set(thread.conversationId, thread);
      for (const segment of await this.relationalStore.loadAgentConversationSegments(
        loadedBindings.map((binding) => binding.conversationId),
      )) this.segments.set(segment.segmentId, segment);
    }

    const projected = interactions.map((record) => {
      const binding = this.bindings.get(record.interactionId);
      return binding
        ? {
            ...record,
            conversationId: binding.conversationId,
            conversationIdSource: 'inferred' as const,
            conversationBindingVersion: binding.resolverVersion,
            correlationQuality: binding.correlationQuality,
          }
        : { ...record };
    });
    const unbound = projected.filter((record) => !record.conversationId);
    const scopeKeys = [...new Set(unbound.map(conversationLogicalScopeKey))];
    if (scopeKeys.length && this.relationalStore?.configured()) {
      const loadedThreads = await this.relationalStore.loadAgentConversationThreads(scopeKeys);
      for (const thread of loadedThreads) {
        this.threads.set(thread.conversationId, thread);
      }
      for (const segment of await this.relationalStore.loadAgentConversationSegments(
        loadedThreads.map((thread) => thread.conversationId),
      )) this.segments.set(segment.segmentId, segment);
    }

    for (const record of unbound.sort(compareInteraction)) {
      const scope = conversationLogicalScopeKey(record);
      const lineage = userLineage(record);
      const resultIds = new Set(record.toolResults.map((result) => result.toolCallId));
      const candidates = [...this.threads.values()]
        .filter((thread) => thread.logicalScopeKey === scope)
        .map((thread) => {
          const sameInstance = Boolean(record.agentInstanceId
            && thread.agentInstanceIds.includes(record.agentInstanceId));
          const resolvesPending = thread.pendingToolCallIds.some((id) => resultIds.has(id));
          const sameRequest = thread.lastRequestSha256 === record.request.sha256;
          const extendedLineage = properPrefix(thread.userLineageHashes, lineage);
          const repeatedLineage = equalLineage(thread.userLineageHashes, lineage);
          let score = 0;
          const evidence: string[] = [];
          if (resolvesPending) {
            score += 100;
            evidence.push('tool_call_id');
          }
          if (sameRequest && sameInstance) {
            score += 80;
            evidence.push('request_sha256');
          }
          if (extendedLineage && (sameInstance || cliProduct(record.agentProduct))) {
            score += sameInstance ? 70 : 60;
            evidence.push(sameInstance ? 'same_instance_lineage' : 'cli_resume_lineage');
          } else if (sameInstance && repeatedLineage) {
            score += 40;
            evidence.push('same_instance_equal_lineage');
          }
          return { thread, score, evidence };
        })
        .filter((candidate) => candidate.score > 0)
        .sort((left, right) => {
          const score = right.score - left.score;
          if (score) return score;
          const lineage = right.thread.userLineageHashes.length
            - left.thread.userLineageHashes.length;
          if (lineage) return lineage;
          const rightAt = BigInt(right.thread.lastActivityAtUnixNs);
          const leftAt = BigInt(left.thread.lastActivityAtUnixNs);
          return rightAt === leftAt ? 0 : rightAt > leftAt ? -1 : 1;
        });
      const best = candidates[0];
      const tied = best && candidates[1]?.score === best.score
        && candidates[1].thread.userLineageHashes.length === best.thread.userLineageHashes.length;
      if (!best || tied) continue;
      record.conversationId = best.thread.conversationId;
      record.conversationIdSource = best.thread.idSource;
      record.conversationBindingVersion = AGENT_CONVERSATION_RESOLVER_VERSION;
      record.correlationQuality = best.evidence.includes('tool_call_id') ? 'exact' : 'strong';
    }
    return projected;
  }

  async persistProjection(projection: AgentConversationProjection): Promise<void> {
    const threads: T.AgentConversationThreadRecord[] = [];
    const segments: T.ConversationInstanceSegment[] = [];
    const bindings: T.AgentConversationBindingRecord[] = [];

    for (const summary of projection.summaries) {
      if (!summary.hasContent) continue;
      const records = [...(projection.interactionsByConversation.get(summary.conversationId) ?? [])]
        .sort(compareInteraction);
      if (records.length === 0) continue;
      const first = records[0];
      const last = records.at(-1)!;
      const logicalScopeKey = conversationLogicalScopeKey(first);
      const resolvedResultIds = new Set(records.flatMap((record) =>
        record.toolResults.map((result) => result.toolCallId)));
      const pendingToolCallIds = [...new Set(records.flatMap((record) =>
        record.toolCalls
          .map((call) => call.toolCallId)
          .filter((callId) => !resolvedResultIds.has(callId))))];
      const priorThread = this.threads.get(summary.conversationId);
      const latestLineage = userLineage(last);
      const thread: T.AgentConversationThreadRecord = {
        schemaVersion: 'anysentry.agent_conversation_thread.v1',
        conversationId: summary.conversationId,
        logicalScopeKey,
        idSource: priorThread && threadRank(priorThread.idSource) > threadRank(summary.idSource)
          ? priorThread.idSource
          : summary.idSource,
        agentProduct: summary.agentProduct,
        workspacePath: summary.workspacePath,
        ...(first.process?.hostId ? { hostId: first.process.hostId } : {}),
        agentInstanceIds: [...new Set([
          ...(priorThread?.agentInstanceIds ?? []),
          ...summary.agentInstanceIds,
        ])],
        userLineageHashes: latestLineage.length >= (priorThread?.userLineageHashes.length ?? 0)
          ? latestLineage
          : priorThread!.userLineageHashes,
        pendingToolCallIds,
        lastRequestSha256: last.request.sha256,
        startedAtUnixNs: priorThread
          && BigInt(priorThread.startedAtUnixNs) < BigInt(first.startedAtUnixNs)
          ? priorThread.startedAtUnixNs
          : first.startedAtUnixNs,
        lastActivityAtUnixNs: priorThread
          && BigInt(priorThread.lastActivityAtUnixNs) > BigInt(last.endedAtUnixNs)
          ? priorThread.lastActivityAtUnixNs
          : last.endedAtUnixNs,
        resolverVersion: AGENT_CONVERSATION_RESOLVER_VERSION,
        updatedAt: Math.max(last.receivedAt, priorThread?.updatedAt ?? 0),
      };
      threads.push(thread);
      this.threads.set(thread.conversationId, thread);

      const existingSegments = this.segmentsForConversation(summary.conversationId);
      const existingInteractionIds = new Set(records.map((record) => record.interactionId));
      const latestExisting = existingSegments.at(-1);
      const firstInstanceId = records[0].agentInstanceId ?? `unlinked:${records[0].interactionId}`;
      let segment: T.ConversationInstanceSegment | undefined = latestExisting
        && latestExisting.agentInstanceId === firstInstanceId
        && !existingInteractionIds.has(latestExisting.lastInteractionId)
        ? { ...latestExisting }
        : undefined;
      const reprojectsFromStart = existingSegments[0]?.firstInteractionId
        === records[0].interactionId;
      let nextOrdinal = reprojectsFromStart
        ? 0
        : existingSegments.reduce(
            (maximum, item) => Math.max(maximum, item.ordinal),
            0,
          );
      for (const record of records) {
        const instanceId = record.agentInstanceId ?? `unlinked:${record.interactionId}`;
        if (!segment || segment.agentInstanceId !== instanceId) {
          if (segment) segments.push(segment);
          nextOrdinal += 1;
          segment = {
            schemaVersion: 'anysentry.agent_conversation_segment.v1',
            segmentId: stableId(
              'seg',
              `${summary.conversationId}\u0000${instanceId}\u0000${record.interactionId}`,
            ),
            conversationId: summary.conversationId,
            agentInstanceId: instanceId,
            ordinal: nextOrdinal,
            startedAtUnixNs: record.startedAtUnixNs,
            firstInteractionId: record.interactionId,
            lastInteractionId: record.interactionId,
            interactionCount: 1,
            correlationQuality: record.correlationQuality ?? 'inferred',
            resolverVersion: AGENT_CONVERSATION_RESOLVER_VERSION,
            updatedAt: record.receivedAt,
          };
        } else {
          segment.lastInteractionId = record.interactionId;
          segment.interactionCount += 1;
          segment.updatedAt = Math.max(segment.updatedAt, record.receivedAt);
        }
        segment.endedAtUnixNs = record.endedAtUnixNs;
        bindings.push({
          schemaVersion: 'anysentry.agent_conversation_binding.v1',
          interactionId: record.interactionId,
          conversationId: summary.conversationId,
          segmentId: segment.segmentId,
          agentInstanceId: instanceId,
          logicalScopeKey,
          evidence: summary.idSource === 'provider'
            ? ['provider_conversation_or_response_chain']
            : summary.idSource === 'runtime'
              ? ['runtime_session']
              : ['runtime_root_and_message_lineage'],
          correlationQuality: summary.idSource === 'provider'
            ? 'exact'
            : summary.idSource === 'runtime' ? 'strong' : 'inferred',
          resolverVersion: AGENT_CONVERSATION_RESOLVER_VERSION,
          decidedAt: record.receivedAt,
          updatedAt: record.receivedAt,
        });
      }
      if (segment) segments.push(segment);
    }

    for (const segment of segments) this.segments.set(segment.segmentId, segment);
    for (const binding of bindings) this.bindings.set(binding.interactionId, binding);
    if (this.relationalStore?.configured()) {
      await this.relationalStore.saveAgentConversationResolution(threads, segments, bindings);
    }
  }

  segmentsForConversation(conversationId: string): T.ConversationInstanceSegment[] {
    return [...this.segments.values()]
      .filter((segment) => segment.conversationId === conversationId)
      .sort((left, right) => left.ordinal - right.ordinal)
      .map((segment) => ({ ...segment }));
  }
}
