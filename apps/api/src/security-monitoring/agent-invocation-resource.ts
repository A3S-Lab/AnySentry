import type * as T from './types';

export function agentInvocationKernelOwnership(
  kernel: T.ObservabilityCoverageLayers['kernel'] | undefined,
): T.AgentInvocationKernelOwnership {
  if ((kernel?.factCount ?? 0) > 0 && kernel?.status === 'complete') return 'owned';
  if (kernel?.reasons?.includes('no_kernel_event_expected')) return 'not_expected';
  return 'unlinked';
}

export function agentInvocationView(session: Pick<
  T.CanonicalSessionResource,
  'parentSessionId' | 'canonicalParentSessionId' | 'coverageLayers'
>): T.AgentInvocationView {
  const hasParent = Boolean(session.parentSessionId || session.canonicalParentSessionId);
  const kernel = session.coverageLayers?.kernel;
  if ((kernel?.factCount ?? 0) > 0) return hasParent ? 'child' : 'local';
  if (hasParent && kernel?.reasons?.includes('tool_kernel_unlinked')) return 'parent';
  return 'local';
}

/** Hop-fenced AgentInvocation projection. Parent views never import child KernelFact rows. */
export function projectAgentInvocation(input: {
  invocationId: string;
  session: T.CanonicalSessionResource;
}): T.CanonicalAgentInvocationResource {
  const view = agentInvocationView(input.session);
  const runId = input.session.coverageLayers?.run?.runIds?.[0];
  return {
    schemaVersion: 'anysentry.agent_invocation.v1',
    invocationId: input.invocationId,
    sessionId: input.session.sessionId,
    ...(input.session.conversationId ? { conversationId: input.session.conversationId } : {}),
    ...(runId ? { runId } : {}),
    ...(input.session.parentSessionId ? { parentSessionId: input.session.parentSessionId } : {}),
    ...(input.session.canonicalParentSessionId
      ? { canonicalParentSessionId: input.session.canonicalParentSessionId }
      : {}),
    view,
    kernelOwnership: agentInvocationKernelOwnership(input.session.coverageLayers?.kernel),
    ...(view === 'parent' && runId ? { childDeepLink: { runId } } : {}),
    coverage: input.session.coverage,
    ...(input.session.coverageLayers ? { coverageLayers: input.session.coverageLayers } : {}),
    sourceRefs: input.session.sourceRefs,
    resolutionRevision: input.session.resolutionRevision,
  };
}
