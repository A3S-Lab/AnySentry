import { AgentClassification, JudgmentRoutingSnapshot, Tier } from './types';
import { PolicyConfig, tierStatus } from './policy-config';

export const IDENTITY_ROUTING_VERSION = 'identity-routing.v1';

/**
 * Candidate observations are intentionally sampled with the same full-fidelity route as a
 * confirmed Agent by default.  This is a capture/judgment policy decision, not a business
 * identity assertion: callers must retain the original `probable_agent` value and provenance.
 *
 * Production can opt back into the historical lower-cost route with
 * `ANYSENTRY_CANDIDATE_EFFECTIVE_MODE=probable` (or `candidate`/`off`).  The default is
 * `confirmed`, which is required for the current discovery and verification workflow so that a
 * candidate has enough Kernel/plaintext evidence to be reviewed later.
 */
export type CandidateEffectiveMode = 'confirmed' | 'probable';

export function candidateEffectiveMode(
  env: NodeJS.ProcessEnv = process.env,
): CandidateEffectiveMode {
  const value = env.ANYSENTRY_CANDIDATE_EFFECTIVE_MODE?.trim().toLowerCase();
  return value === 'probable' || value === 'candidate' || value === 'off' || value === 'legacy'
    ? 'probable'
    : 'confirmed';
}

export function candidateAutoPromotionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return candidateEffectiveMode(env) === 'confirmed';
}

export interface CaptureClassificationDecision {
  observed: AgentClassification;
  effective: AgentClassification;
  candidateAutoPromoted: boolean;
  source: 'observed' | 'candidate_auto_promoted' | 'policy';
}

/**
 * Resolve the classification used for capture/judgment while retaining an audit-friendly view of
 * what the detector actually said.  This helper deliberately does not produce a LogicalAgent or
 * Session identity; those remain evidence-gated in the canonical resolver.
 */
export function captureClassificationDecision(
  classification?: AgentClassification,
  env: NodeJS.ProcessEnv = process.env,
): CaptureClassificationDecision {
  const observed = classification ?? 'unknown';
  const effective = effectiveClassification(observed, env);
  const candidateAutoPromoted = observed === 'probable_agent' && effective === 'confirmed_agent';
  return {
    observed,
    effective,
    candidateAutoPromoted,
    source: candidateAutoPromoted ? 'candidate_auto_promoted' : 'observed',
  };
}

export function effectiveClassification(
  classification?: AgentClassification,
  env: NodeJS.ProcessEnv = process.env,
): AgentClassification {
  const observed = classification ?? 'unknown';
  return observed === 'probable_agent' && candidateAutoPromotionEnabled(env)
    ? 'confirmed_agent'
    : observed;
}

export function resolveJudgmentRoute(
  classification: AgentClassification | undefined,
  policy: PolicyConfig,
  availableTiers: ReturnType<typeof tierStatus> = tierStatus(policy),
): JudgmentRoutingSnapshot {
  const observed = classification ?? 'unknown';
  const resolved = effectiveClassification(observed);
  const candidateAutoPromoted = observed === 'probable_agent' && resolved === 'confirmed_agent';
  const status = availableTiers;
  if (resolved === 'non_agent') {
    return {
      classification: observed,
      ...(resolved !== observed ? { effectiveClassification: resolved } : {}),
      profile: 'discard',
      maxTier: 'L1',
      reason: 'non_agent_discarded',
      routingVersion: IDENTITY_ROUTING_VERSION,
    };
  }
  if (resolved === 'unknown' || (resolved === 'probable_agent' && policy.identity.candidatePipeline === 'l1_only')) {
    return {
      classification: observed,
      ...(resolved !== observed ? { effectiveClassification: resolved } : {}),
      ...(candidateAutoPromoted ? { candidateAutoPromoted: true } : {}),
      profile: 'l1_only',
      maxTier: 'L1',
      reason: resolved === 'unknown' ? 'unknown_l1_only' : 'candidate_agent_l1_only',
      routingVersion: IDENTITY_ROUTING_VERSION,
    };
  }
  const maxTier: Tier = status.l3 ? 'Agent' : status.l2 ? 'Llm' : 'Rules';
  return {
    classification: observed,
    ...(resolved !== observed ? { effectiveClassification: resolved } : {}),
    ...(candidateAutoPromoted ? { candidateAutoPromoted: true } : {}),
    profile: 'full',
    maxTier: maxTier === 'Agent' ? 'L3' : maxTier === 'Llm' ? 'L2' : 'L1',
    reason: observed === 'confirmed_agent' ? 'confirmed_agent_full' : 'candidate_agent_full',
    routingVersion: IDENTITY_ROUTING_VERSION,
  };
}
