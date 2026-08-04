import { AgentClassification, JudgmentRoutingSnapshot, Tier } from './types';
import { PolicyConfig, tierStatus } from './policy-config';

export const IDENTITY_ROUTING_VERSION = 'identity-routing.v1';

export function effectiveClassification(classification?: AgentClassification): AgentClassification {
  return classification ?? 'unknown';
}

export function resolveJudgmentRoute(
  classification: AgentClassification | undefined,
  policy: PolicyConfig,
  availableTiers: ReturnType<typeof tierStatus> = tierStatus(policy),
): JudgmentRoutingSnapshot {
  const resolved = effectiveClassification(classification);
  const status = availableTiers;
  if (resolved === 'non_agent') {
    return {
      classification: resolved,
      profile: 'discard',
      maxTier: 'L1',
      reason: 'non_agent_discarded',
      routingVersion: IDENTITY_ROUTING_VERSION,
    };
  }
  if (resolved === 'unknown' || (resolved === 'probable_agent' && policy.identity.candidatePipeline === 'l1_only')) {
    return {
      classification: resolved,
      profile: 'l1_only',
      maxTier: 'L1',
      reason: resolved === 'unknown' ? 'unknown_l1_only' : 'candidate_agent_l1_only',
      routingVersion: IDENTITY_ROUTING_VERSION,
    };
  }
  const maxTier: Tier = status.l3 ? 'Agent' : status.l2 ? 'Llm' : 'Rules';
  return {
    classification: resolved,
    profile: 'full',
    maxTier: maxTier === 'Agent' ? 'L3' : maxTier === 'Llm' ? 'L2' : 'L1',
    reason: resolved === 'confirmed_agent' ? 'confirmed_agent_full' : 'candidate_agent_full',
    routingVersion: IDENTITY_ROUTING_VERSION,
  };
}
