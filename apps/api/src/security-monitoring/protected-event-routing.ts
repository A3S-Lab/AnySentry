import type { AgentClassification } from './types';

export type ProtectedEventRoute =
  | 'ordinary'
  | 'system_context'
  | 'security'
  | 'structural'
  | 'agent_conflict';

export interface ProtectedEventRoutingInput {
  eventKind: string;
  classification?: AgentClassification;
  conflict?: boolean;
  attributionEvidence?: readonly string[];
}

const STRUCTURAL_EVENT_KINDS = new Set(['ToolExec', 'ProcessExit']);
const AGENT_SEMANTIC_EVENT_KINDS = new Set(['AgentInvocation', 'AgentTool']);

function hasAuthenticatedAgentEvidence(values: readonly string[] | undefined): boolean {
  return (values ?? []).some((value) =>
    value === 'server:authenticated-agent-adapter'
    || value.startsWith('server:authenticated-agent-adapter:')
    || value.startsWith('correlation:agent_adapter:authenticated'));
}

/**
 * Resolve semantics that must be consumed before ordinary identity-based retention.
 *
 * This is deliberately independent from L1/L2/L3 routing. A structural route means that the
 * Process generation/tombstone must be durably updated before the large raw event can be omitted;
 * it does not turn a known non-Agent command into an Agent judgment candidate.
 */
export function resolveProtectedEventRoute(input: ProtectedEventRoutingInput): ProtectedEventRoute {
  if (input.eventKind === 'SystemContext') return 'system_context';
  if (input.eventKind === 'SecurityAction') return 'security';
  if (input.conflict) return 'agent_conflict';
  if (
    input.classification === 'non_agent'
    && AGENT_SEMANTIC_EVENT_KINDS.has(input.eventKind)
    && hasAuthenticatedAgentEvidence(input.attributionEvidence)
  ) {
    return 'agent_conflict';
  }
  if (input.classification === 'non_agent' && STRUCTURAL_EVENT_KINDS.has(input.eventKind)) {
    return 'structural';
  }
  return 'ordinary';
}
