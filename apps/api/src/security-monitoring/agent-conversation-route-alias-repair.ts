/**
 * Pure helpers for conversation route-alias membership selection.
 * Kept dependency-free so verifiers can load this module without Nest dist.
 */

import { createHash } from 'node:crypto';

function stableConversationId(value: string): string {
  return `cv_${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
}

export function repairEmptyRouteAliasConversationId(input: {
  requestedConversationId?: string;
  aliasCanonicalConversationId?: string;
  aliasMembershipIds: readonly string[];
  requestedMembershipIds: readonly string[];
}): string | undefined {
  const requested = input.requestedConversationId?.trim() || undefined;
  const aliasCanonical = input.aliasCanonicalConversationId?.trim() || undefined;
  const initial = aliasCanonical ?? requested;
  if (
    requested
    && aliasCanonical
    && aliasCanonical !== requested
    && input.aliasMembershipIds.length === 0
    && input.requestedMembershipIds.length > 0
  ) {
    return requested;
  }
  return initial;
}

/**
 * Keep Conversations independent when two Agent processes share run/session
 * identifiers across a hop. Any non-empty hop token is a fence; do not special-case
 * product names such as orchestrator/worker.
 */
export function hopConversationFenceValue(hop?: string, _agentIdHeader?: string): string {
  const normalizedHop = hop?.trim().toLowerCase();
  if (normalizedHop) {
    return `\u0000hop:${normalizedHop}`;
  }
  return '';
}

/**
 * Directory used to remint hop-scoped durable Thread ids as
 * bound + conversationId + hopFence. That key is not stored as a Thread, so
 * timeline point-reads need a route alias back to the durable id.
 */
export function boundHopRemintConversationId(
  conversationId: string | undefined,
  hop?: string,
  agentIdHeader?: string,
): string | undefined {
  const durable = conversationId?.trim();
  const fence = hopConversationFenceValue(hop, agentIdHeader);
  if (!durable || !fence) return undefined;
  return stableConversationId(`bound\0${durable}${fence}`);
}

/**
 * A directory/session-key Conversation that already has hop-local membership is
 * the point-read key. Do not replace it with a persisted Thread id that parent
 * and child hops can share through the same session/run/provider label.
 */
export function pointReadCanonicalConversationId(input: {
  requestedConversationId?: string;
  initialConversationId?: string;
  membershipCount: number;
  selectedConversationId?: string;
  projectionHasRequested?: boolean;
}): string | undefined {
  const requested = input.requestedConversationId?.trim() || undefined;
  const initial = input.initialConversationId?.trim() || undefined;
  const selected = input.selectedConversationId?.trim() || undefined;
  if (
    requested
    && initial === requested
    && input.membershipCount > 0
    && input.projectionHasRequested
  ) {
    return requested;
  }
  return selected ?? initial ?? requested;
}

export function hopLocalProjectionRecord<T extends {
  hop?: string;
  conversationId?: string;
  conversationIdSource?: string;
  conversationBindingVersion?: number;
}>(record: T): T {
  if (!record.hop?.trim()) return record;
  const next = { ...record };
  delete next.conversationId;
  delete next.conversationIdSource;
  delete next.conversationBindingVersion;
  return next;
}

export function shouldProjectHopLocal(records: readonly { hop?: string }[]): boolean {
  const hops = new Set(records
    .map((record) => record.hop?.trim())
    .filter((value): value is string => Boolean(value)));
  return hops.size === 1;
}

/** Storage-safe hop suffix for Thread logicalScopeKey. PostgreSQL TEXT cannot hold NUL. */
export function conversationHopScopeSuffix(hop?: string): string {
  const normalizedHop = hop?.trim().toLowerCase();
  return normalizedHop ? `|hop:${normalizedHop}` : '';
}

export function hopFromLogicalScopeKey(logicalScopeKey?: string): string | undefined {
  const match = logicalScopeKey?.match(/\|hop:([^|]+)$/u);
  return match?.[1];
}

/** Resolver hop-local Thread wins over a v1 projection id that can reuse a parent stamp. */
export function persistedMembershipConversationId(input: {
  resolverConversationId?: string;
  bindingConversationId?: string;
}): string | undefined {
  return input.resolverConversationId?.trim() || input.bindingConversationId?.trim() || undefined;
}

/**
 * A persisted Thread id that belongs to another hop is not this record's Canonical Thread.
 * Remint only when the loaded Thread is itself hop-stamped and disagrees. Hop-unscoped
 * legacy Threads stay on the stamp so directory session-key keys and hop-canon remint
 * still resolve; a missing Thread keeps a resolver hop-local membership id.
 */
export function hopAlignedConversationId(input: {
  conversationId?: string;
  hop?: string;
  threadLogicalScopeKey?: string;
}): string | undefined {
  const conversationId = input.conversationId?.trim() || undefined;
  if (!conversationId) return undefined;
  const recordHop = input.hop?.trim().toLowerCase() || undefined;
  const threadHop = hopFromLogicalScopeKey(input.threadLogicalScopeKey);
  if (recordHop && threadHop && threadHop !== recordHop) {
    return boundHopRemintConversationId(conversationId, recordHop) ?? conversationId;
  }
  return conversationId;
}
