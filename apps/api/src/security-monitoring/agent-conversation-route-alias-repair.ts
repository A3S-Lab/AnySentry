/**
 * Pure helpers for conversation route-alias membership selection.
 * Kept dependency-free so verifiers can load this module without Nest dist.
 */

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

/** Minimal hop fence used by Design B parent/worker Thread separation. */
export function hopConversationFenceValue(hop?: string, agentIdHeader?: string): string {
  const normalizedHop = hop?.trim().toLowerCase();
  if (normalizedHop === 'orchestrator' || normalizedHop === 'worker') {
    return `\u0000hop:${normalizedHop}`;
  }
  const header = agentIdHeader?.trim().toLowerCase() ?? '';
  if (header.includes('orchestrator') || header.includes('worker')) {
    return `\u0000agent-id:${header}`;
  }
  return '';
}
