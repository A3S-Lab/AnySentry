import { correlationCaptureRollout } from './correlation-rollout';
import { parseTrustedCorrelation } from './trusted-correlation';

/** Read-only projection of an existing server-validated claim. Never infer from PID/time/argv. */
export function systemToolCallBinding(correlation: unknown) {
  if (correlationCaptureRollout().trustedCorrelation === 'off') return undefined;
  const trusted = parseTrustedCorrelation(correlation);
  if (!trusted || trusted.method !== 'agent_adapter'
    || trusted.authority !== 'authenticated_agent_adapter'
    || trusted.inferred || !trusted.toolCallId) return undefined;
  return {
    method: 'authenticated_agent_adapter' as const,
    toolCallId: trusted.toolCallId,
    ...(trusted.invocationId ? { invocationId: trusted.invocationId } : {}),
  };
}
