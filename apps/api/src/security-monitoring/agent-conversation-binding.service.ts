import { Injectable, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';

import type * as T from './types';
import type { AgentConversationProjection } from './agent-conversation';
import { humanVisibleUserContent } from './agent-semantic-timeline';
import {
  AGENT_CONVERSATION_RESOLVER_V2,
  type ConversationMembershipV2,
  type ConversationResolutionV2,
  type ConversationRouteAliasV1,
  type TechnicalActivityProjection,
  conversationAnchorsForInteraction,
  conversationLogicalScopeKeyV2,
  resolveAgentConversationsV2,
} from './agent-conversation-resolution-v2';
import { RelationalBusinessStore } from './relational-business-store.service';

export const AGENT_CONVERSATION_RESOLVER_VERSION = AGENT_CONVERSATION_RESOLVER_V2;

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

function syntheticWorkspace(value?: string): boolean {
  const workspace = value?.trim().replace(/\/+$/u, '') ?? '';
  return !workspace
    || workspace === 'workspace:unknown'
    || workspace.startsWith('agent://')
    || workspace.startsWith('agent-scope:');
}

function preferredWorkspace(current: string, remembered?: string): string {
  return remembered && !syntheticWorkspace(remembered) && syntheticWorkspace(current)
    ? remembered
    : current;
}

function anchorKindsCompatible(
  current: T.AgentConversationAnchorKind,
  stored: T.AgentConversationAnchorKind,
): boolean {
  if (current === 'previous_response_id' && stored === 'response_id') return true;
  return current === stored && [
    'provider_conversation',
    'continuity_key',
    'response_id',
    'message_item_id',
    'turn_id',
    'tool_call_id',
  ].includes(current);
}

function anchorScore(kind: T.AgentConversationAnchorKind): number {
  switch (kind) {
    case 'provider_conversation': return 140;
    case 'previous_response_id':
    case 'response_id': return 130;
    case 'tool_call_id': return 120;
    case 'continuity_key': return 100;
    case 'turn_id': return 90;
    case 'message_item_id': return 80;
    default: return 0;
  }
}

function sameThreadDomain(
  record: T.AgentInteractionRecord,
  thread: T.AgentConversationThreadRecord,
): boolean {
  if (normalized(record.tenantId) && normalized(thread.tenantId)
    && normalized(record.tenantId) !== normalized(thread.tenantId)) return false;
  if (normalized(record.environmentId) && normalized(thread.environmentId)
    && normalized(record.environmentId) !== normalized(thread.environmentId)) return false;
  if (normalized(record.agentProduct) !== normalized(thread.agentProduct)) return false;
  if (normalized(record.process?.hostId) && normalized(thread.hostId)
    && normalized(record.process?.hostId) !== normalized(thread.hostId)) return false;
  return syntheticWorkspace(record.workspacePath)
    || syntheticWorkspace(thread.workspacePath)
    || normalized(record.workspacePath) === normalized(thread.workspacePath);
}

function segmentEnd(segment: T.ConversationInstanceSegment): bigint {
  return BigInt(segment.endedAtUnixNs ?? segment.startedAtUnixNs);
}

function segmentContains(
  outer: T.ConversationInstanceSegment,
  inner: T.ConversationInstanceSegment,
): boolean {
  return outer.agentInstanceId === inner.agentInstanceId
    && BigInt(outer.startedAtUnixNs) <= BigInt(inner.startedAtUnixNs)
    && segmentEnd(outer) >= segmentEnd(inner);
}

function segmentPreferred(
  left: T.ConversationInstanceSegment,
  right: T.ConversationInstanceSegment,
): boolean {
  const leftDuration = segmentEnd(left) - BigInt(left.startedAtUnixNs);
  const rightDuration = segmentEnd(right) - BigInt(right.startedAtUnixNs);
  return leftDuration > rightDuration
    || (leftDuration === rightDuration && left.interactionCount > right.interactionCount)
    || (leftDuration === rightDuration
      && left.interactionCount === right.interactionCount
      && left.updatedAt > right.updatedAt)
    || (leftDuration === rightDuration
      && left.interactionCount === right.interactionCount
      && left.updatedAt === right.updatedAt
      && left.segmentId < right.segmentId);
}

function collapseContainedSegments(
  segments: T.ConversationInstanceSegment[],
): T.ConversationInstanceSegment[] {
  return segments
    .filter((candidate) => !segments.some((other) =>
      other.segmentId !== candidate.segmentId
      && segmentContains(other, candidate)
      && (
        !segmentContains(candidate, other)
        || segmentPreferred(other, candidate)
      )))
    .sort((left, right) => {
      const leftStart = BigInt(left.startedAtUnixNs);
      const rightStart = BigInt(right.startedAtUnixNs);
      return leftStart === rightStart
        ? left.ordinal - right.ordinal || left.segmentId.localeCompare(right.segmentId)
        : leftStart < rightStart ? -1 : 1;
    })
    .map((segment, index) => ({ ...segment, ordinal: index + 1 }));
}

@Injectable()
export class AgentConversationBindingService {
  private readonly bindings = new Map<string, T.AgentConversationBindingRecord>();
  private readonly threads = new Map<string, T.AgentConversationThreadRecord>();
  private readonly segments = new Map<string, T.ConversationInstanceSegment>();
  private readonly routeAliases = new Map<string, ConversationRouteAliasV1>();
  private readonly technicalActivities = new Map<string, TechnicalActivityProjection>();
  private readonly membershipsV2 = new Map<string, ConversationMembershipV2>();
  private pendingResolution?: ConversationResolutionV2;
  private resolutionRevision = 0;

  constructor(
    @Optional() private readonly relationalStore?: RelationalBusinessStore,
  ) {}

  private async bindByPersistedAnchors(
    records: T.AgentInteractionRecord[],
  ): Promise<void> {
    if (!records.length || !this.relationalStore?.configured()) return;
    for (const record of records) {
      record.conversationAnchors = conversationAnchorsForInteraction(record);
    }
    const matches = await this.relationalStore.loadAgentConversationMembershipsByAnchors(
      records.flatMap((record) => record.conversationAnchors ?? []),
    );
    const conversationIds = [...new Set(matches
      .map((match) => match.membership.canonicalConversationId)
      .filter((value): value is string => Boolean(value)))];
    for (const thread of await this.relationalStore.loadAgentConversationThreadsByIds(
      conversationIds,
    )) this.threads.set(thread.conversationId, thread);
    for (const segment of await this.relationalStore.loadAgentConversationSegments(
      conversationIds,
    )) this.segments.set(segment.segmentId, segment);
    const byHash = new Map<string, typeof matches>();
    for (const match of matches) {
      const anchor = match.anchor.anchor;
      const key = `${anchor.namespace}\u0000${anchor.valueHash}`;
      const values = byHash.get(key) ?? [];
      values.push(match);
      byHash.set(key, values);
    }
    for (const record of records) {
      const candidates = new Map<string, {
        thread: T.AgentConversationThreadRecord;
        anchors: Map<string, number>;
        evidence: Set<string>;
        exact: boolean;
      }>();
      for (const current of record.conversationAnchors ?? []) {
        const key = `${current.namespace}\u0000${current.valueHash}`;
        for (const match of byHash.get(key) ?? []) {
          const stored = match.anchor.anchor;
          if (!anchorKindsCompatible(current.kind, stored.kind)) continue;
          const canonical = this.canonicalConversationId(
            match.membership.canonicalConversationId!,
          );
          const thread = this.threads.get(canonical);
          if (!thread || !sameThreadDomain(record, thread)) continue;
          const candidate = candidates.get(canonical) ?? {
            thread,
            anchors: new Map<string, number>(),
            evidence: new Set<string>(),
            exact: false,
          };
          const anchorKey = `${current.kind}\u0000${current.namespace}\u0000${current.valueHash}`;
          candidate.anchors.set(
            anchorKey,
            Math.max(candidate.anchors.get(anchorKey) ?? 0, anchorScore(current.kind)),
          );
          candidate.evidence.add(
            current.kind === 'previous_response_id' && stored.kind === 'response_id'
              ? 'previous_response_id:response_id'
              : current.kind,
          );
          candidate.exact ||= current.strength === 'exact' && stored.strength === 'exact';
          candidates.set(canonical, candidate);
        }
      }
      const ranked = [...candidates.entries()].map(([conversationId, candidate]) => ({
        conversationId,
        ...candidate,
        score: [...candidate.anchors.values()].reduce((sum, score) => sum + score, 0),
      })).sort((left, right) =>
        right.score - left.score
        || right.anchors.size - left.anchors.size
        || left.conversationId.localeCompare(right.conversationId));
      const best = ranked[0];
      const tied = best && ranked[1]?.score === best.score
        && ranked[1].anchors.size === best.anchors.size;
      if (!best || tied || best.score < 80) continue;
      record.conversationId = best.conversationId;
      record.conversationIdSource = best.thread.idSource;
      record.conversationBindingVersion = AGENT_CONVERSATION_RESOLVER_VERSION;
      record.correlationQuality = best.exact ? 'exact' : 'strong';
      record.workspacePath = preferredWorkspace(record.workspacePath, best.thread.workspacePath);
    }
  }

  async applyPersistedBindings(
    interactions: T.AgentInteractionRecord[],
  ): Promise<T.AgentInteractionRecord[]> {
    if (interactions.length === 0) return [];
    const interactionIds = interactions.map((record) => record.interactionId);
    if (this.relationalStore?.configured()) {
      const loadedMemberships = await this.relationalStore
        .loadAgentConversationMembershipsV2?.(interactionIds) ?? [];
      for (const membership of loadedMemberships) {
        this.membershipsV2.set(membership.interactionId, membership);
      }
      const loadedBindings = await this.relationalStore.loadAgentConversationBindings(interactionIds);
      for (const binding of loadedBindings) {
        this.bindings.set(binding.interactionId, binding);
      }
      for (const thread of await this.relationalStore.loadAgentConversationThreads(
        loadedBindings.map((binding) => binding.logicalScopeKey),
      )) this.threads.set(thread.conversationId, thread);
      for (const thread of await this.relationalStore.loadAgentConversationThreadsByIds([
        ...loadedBindings.map((binding) => binding.conversationId),
        ...loadedMemberships
          .map((membership) => membership.canonicalConversationId)
          .filter((value): value is string => Boolean(value)),
      ])) this.threads.set(thread.conversationId, thread);
      for (const segment of await this.relationalStore.loadAgentConversationSegments(
        loadedBindings.map((binding) => binding.conversationId),
      )) this.segments.set(segment.segmentId, segment);
      const aliasIds = [...new Set([
        ...loadedBindings.map((binding) => binding.conversationId),
        ...loadedMemberships
          .map((membership) => membership.canonicalConversationId)
          .filter((value): value is string => Boolean(value)),
      ])];
      for (const alias of await this.relationalStore
        .loadAgentConversationRouteAliases?.(aliasIds) ?? []) {
        this.routeAliases.set(alias.aliasConversationId, alias);
      }
    }

    const projected = interactions.map((record) => {
      const binding = this.bindings.get(record.interactionId);
      const membership = this.membershipsV2.get(record.interactionId);
      const boundConversationId = membership?.canonicalConversationId
        ?? binding?.conversationId;
      const canonicalConversationId = boundConversationId
        ? this.canonicalConversationId(boundConversationId)
        : undefined;
      const thread = canonicalConversationId
        ? this.threads.get(canonicalConversationId)
        : undefined;
      return {
        ...record,
        ...(thread ? {
          workspacePath: preferredWorkspace(record.workspacePath, thread.workspacePath),
        } : {}),
        ...(canonicalConversationId ? { conversationId: canonicalConversationId } : {}),
        ...(canonicalConversationId ? { conversationIdSource: 'inferred' as const } : {}),
        ...(membership?.role ? { trafficRole: membership.role } : {}),
        ...(membership || binding
          ? {
              conversationBindingVersion: membership?.resolverVersion ?? binding!.resolverVersion,
              correlationQuality: membership?.confidence ?? binding!.correlationQuality,
            }
          : {}),
      };
    });
    const unbound = projected.filter((record) => !record.conversationId);
    await this.bindByPersistedAnchors(unbound);
    const remainingUnbound = unbound.filter((record) => !record.conversationId);
    const scopeKeys = [...new Set(remainingUnbound.map(conversationLogicalScopeKey))];
    if (scopeKeys.length && this.relationalStore?.configured()) {
      const loadedThreads = await this.relationalStore.loadAgentConversationThreads(scopeKeys);
      for (const thread of loadedThreads) {
        this.threads.set(thread.conversationId, thread);
      }
      for (const segment of await this.relationalStore.loadAgentConversationSegments(
        loadedThreads.map((thread) => thread.conversationId),
      )) this.segments.set(segment.segmentId, segment);
    }

    for (const record of remainingUnbound.sort(compareInteraction)) {
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
    const resolution = resolveAgentConversationsV2(projected);
    this.pendingResolution = resolution;
    this.resolutionRevision = Math.max(this.resolutionRevision, resolution.resolutionRevision);
    for (const alias of resolution.aliases) this.routeAliases.set(alias.aliasConversationId, alias);
    for (const activity of resolution.technicalActivities) {
      this.technicalActivities.set(activity.technicalActivityId, activity);
    }
    for (const membership of resolution.memberships) {
      this.membershipsV2.set(membership.interactionId, membership);
    }
    return resolution.records;
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
      const resolvedResultIds = new Set(records.flatMap((record) =>
        record.toolResults.map((result) => result.toolCallId)));
      const pendingToolCallIds = [...new Set(records.flatMap((record) =>
        record.toolCalls
          .map((call) => call.toolCallId)
          .filter((callId) => !resolvedResultIds.has(callId))))];
      const priorThread = this.threads.get(summary.conversationId);
      const workspacePath = preferredWorkspace(summary.workspacePath, priorThread?.workspacePath);
      const logicalScopeKey = conversationLogicalScopeKey({ ...first, workspacePath });
      const latestLineage = userLineage(last);
      const thread: T.AgentConversationThreadRecord = {
        schemaVersion: 'anysentry.agent_conversation_thread.v1',
        conversationId: summary.conversationId,
        logicalScopeKey,
        idSource: priorThread && threadRank(priorThread.idSource) > threadRank(summary.idSource)
          ? priorThread.idSource
          : summary.idSource,
        ...(first.tenantId ?? priorThread?.tenantId
          ? { tenantId: first.tenantId ?? priorThread?.tenantId }
          : {}),
        ...(first.environmentId ?? priorThread?.environmentId
          ? { environmentId: first.environmentId ?? priorThread?.environmentId }
          : {}),
        agentProduct: summary.agentProduct,
        workspacePath,
        ...(first.process?.hostId ?? priorThread?.hostId
          ? { hostId: first.process?.hostId ?? priorThread?.hostId }
          : {}),
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
      const pending = this.pendingResolution;
      if (pending) {
        const bindingByInteraction = new Map(bindings.map((binding) => [
          binding.interactionId,
          binding,
        ]));
        const memberships = pending.memberships.map((membership) => {
          const binding = bindingByInteraction.get(membership.interactionId);
          return binding && membership.canonicalConversationId
            ? {
                ...membership,
                canonicalConversationId: binding.conversationId,
                segmentId: binding.segmentId,
              }
            : membership;
        });
        const anchors = pending.records.flatMap((record) =>
          (record.conversationAnchors ?? []).map((anchor) => ({
            interactionId: record.interactionId,
            logicalScopeKey: conversationLogicalScopeKeyV2(record),
            observedAt: record.receivedAt,
            anchor,
          })));
        await this.relationalStore.saveAgentConversationResolutionV2?.(
          anchors,
          memberships,
          pending.aliases,
          pending.technicalActivities,
        );
      }
    }
  }

  segmentsForConversation(conversationId: string): T.ConversationInstanceSegment[] {
    const canonical = this.canonicalConversationId(conversationId);
    return collapseContainedSegments([...this.segments.values()]
      .filter((segment) => segment.conversationId === canonical));
  }

  routeAlias(conversationId: string): ConversationRouteAliasV1 | undefined {
    const alias = this.routeAliases.get(conversationId);
    return alias ? { ...alias, evidence: [...alias.evidence] } : undefined;
  }

  async resolveRouteAlias(conversationId: string): Promise<ConversationRouteAliasV1 | undefined> {
    const remembered = this.routeAlias(conversationId);
    if (remembered || !this.relationalStore?.configured()) return remembered;
    const loaded = await this.relationalStore.loadAgentConversationRouteAliases?.([conversationId]) ?? [];
    for (const alias of loaded) this.routeAliases.set(alias.aliasConversationId, alias);
    return this.routeAlias(conversationId);
  }

  canonicalConversationId(conversationId: string): string {
    let current = conversationId;
    const seen = new Set<string>();
    while (!seen.has(current)) {
      seen.add(current);
      const alias = this.routeAliases.get(current);
      if (!alias || alias.targetType !== 'conversation' || !alias.canonicalConversationId) break;
      current = alias.canonicalConversationId;
    }
    return current;
  }

  listTechnicalActivities(agentInstanceId?: string): TechnicalActivityProjection[] {
    return [...this.technicalActivities.values()]
      .filter((activity) => !agentInstanceId || activity.agentInstanceId === agentInstanceId)
      .sort((left, right) => BigInt(left.startedAtUnixNs) < BigInt(right.startedAtUnixNs) ? -1 : 1)
      .map((activity) => ({
        ...activity,
        interactionIds: [...activity.interactionIds],
        methods: [...activity.methods],
        paths: [...activity.paths],
      }));
  }

  currentResolutionRevision(): number {
    return this.resolutionRevision;
  }
}
