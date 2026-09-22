/**
 * §11.4 read-path projections: one rule lineage with a shared epoch, and separate
 * plaintext / KernelFact / Session / Run coverage. Does not mutate stored rows.
 */

import type { ToolEvidenceItem } from './tool-evidence-linker';
import type * as T from './types';

export const OBSERVABILITY_COVERAGE_VERSION = 1;

function text(value: unknown, limit = 256): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const normalized = String(value).trim();
  return normalized && normalized.length <= limit ? normalized : undefined;
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

/** Keep KernelFact coverage scoped to the Interactions in this Thread/Session. */
export function toolEvidenceForInteractions(
  items: readonly ToolEvidenceItem[],
  interactions: readonly T.AgentInteractionRecord[],
): ToolEvidenceItem[] {
  const toolCallIds = new Set(interactions.flatMap((item) => [
    ...item.toolCalls.map((call) => text(call.toolCallId)),
    ...item.toolResults.map((result) => text(result.toolCallId)),
  ]).filter((value): value is string => Boolean(value)));
  if (toolCallIds.size === 0) {
    const invocationIds = new Set(interactions.flatMap((item) => [
      text(item.invocationId),
      text(item.runId),
      text(item.producerRunId),
    ]).filter((value): value is string => Boolean(value)));
    return items.filter((item) => invocationIds.has(item.invocationId));
  }
  return items.filter((item) => toolCallIds.has(item.toolCallId));
}

export function unifiedFilterRuleLineage(input: {
  captureEpoch?: string | number;
  captureProfile?: string | number;
  captureAction?: string | number;
  attributes?: Record<string, unknown>;
  filterRuleDecision?: {
    stage?: string;
    catalogVersion?: number;
    domainVersion?: number;
    ruleId?: string;
    revision?: number;
    reason?: string;
  };
}): T.UnifiedFilterRuleLineage | undefined {
  const attributes = input.attributes ?? {};
  const captureEpoch = text(input.captureEpoch)
    ?? text(attributes.captureEpoch)
    ?? text(attributes.filterRuleVersion);
  const stages: T.FilterRuleStageLineage[] = [];
  const f1Rule = text(attributes.filterF1RuleId) ?? text(input.captureProfile) ?? text(attributes.captureProfile);
  const f1Action = text(input.captureAction)
    ?? text(attributes.captureEffectiveAction)
    ?? text(attributes.filterAction);
  if (captureEpoch || f1Rule || f1Action) {
    stages.push({
      stage: 'f1',
      ...(f1Rule ? { ruleId: f1Rule } : {}),
      ...(f1Action ? { action: f1Action } : {}),
      ...(captureEpoch ? { version: captureEpoch } : {}),
    });
  }
  const f2Rule = text(attributes.filterF2RuleId);
  if (f2Rule || text(attributes.filterRuleCatalogVersion)) {
    stages.push({
      stage: 'f2',
      ...(f2Rule ? { ruleId: f2Rule } : {}),
      ...(Number.isFinite(Number(attributes.filterF2RuleRevision))
        ? { revision: Number(attributes.filterF2RuleRevision) }
        : {}),
      ...(text(attributes.filterF2Action) ? { action: text(attributes.filterF2Action) } : {}),
      ...(text(attributes.filterF2ReasonCode) ? { reason: text(attributes.filterF2ReasonCode) } : {}),
      ...(text(attributes.filterRuleCatalogVersion)
        ? { catalogVersion: text(attributes.filterRuleCatalogVersion) }
        : {}),
      ...(text(attributes.filterRuleVersion) ? { version: text(attributes.filterRuleVersion) } : {}),
    });
  }
  const f3 = input.filterRuleDecision;
  if (f3?.ruleId || f3?.reason || f3?.catalogVersion !== undefined) {
    stages.push({
      stage: 'f3',
      ...(f3.ruleId ? { ruleId: f3.ruleId } : {}),
      ...(f3.revision !== undefined ? { revision: f3.revision } : {}),
      ...(f3.reason ? { reason: f3.reason } : {}),
      ...(f3.catalogVersion !== undefined ? { catalogVersion: f3.catalogVersion } : {}),
    });
  }
  if (stages.length === 0) return undefined;
  return {
    schemaVersion: 'anysentry.filter_rule_lineage.v1',
    ...(captureEpoch ? { epoch: captureEpoch } : {}),
    stages,
  };
}

function layerStatus(
  present: number,
  total: number,
  empty: T.ObservabilityLayerStatus,
): T.ObservabilityLayerStatus {
  if (total <= 0) return empty;
  if (present <= 0) return empty;
  if (present < total) return 'partial';
  return 'complete';
}

export function observabilityCoverageLayers(
  interactions: readonly T.AgentInteractionRecord[],
  toolEvidence: readonly ToolEvidenceItem[] = [],
  plaintextCoverage?: T.AgentConversationCoverage,
): T.ObservabilityCoverageLayers {
  const plaintext = plaintextCoverage ?? {
    status: interactions.length ? 'partial' : 'asset_only',
    reasons: interactions.length ? [] : ['no_plaintext_interaction'],
    completeInteractions: 0,
    partialInteractions: interactions.length,
  } as T.AgentConversationCoverage;
  const plaintextStatus: T.ObservabilityLayerStatus = plaintext.status === 'complete'
    ? 'complete'
    : plaintext.status === 'transport_unparsed'
      || plaintext.status === 'template_unparsed'
      || plaintext.status === 'unsupported_protocol'
      || plaintext.status === 'unsupported_tls_profile'
      ? 'unparsed'
      : plaintext.status === 'asset_only' || plaintext.status === 'no_activity'
        ? 'missing'
        : 'partial';
  const kernelFacts = interactions.filter((item) => text(item.kernelFactId)).length;
  const toolRows = interactions.filter((item) =>
    item.interactionType === 'tool' || item.toolCalls.length > 0);
  const linkedTools = toolEvidence.filter((item) => item.status === 'linked').length;
  const expectedNoKernel = toolEvidence.filter((item) =>
    item.reason === 'no_kernel_event_expected').length;
  const truncatedTools = toolEvidence.filter((item) =>
    item.reason === 'candidates_truncated').length;
  const unlinkedTools = toolEvidence.filter((item) =>
    item.status === 'semantic_only'
    && item.reason !== 'no_kernel_event_expected').length;
  const linkedFactIds = unique(toolEvidence.flatMap((item) =>
    item.kernelEvidence.map((evidence) => text(evidence.eventId))));
  let kernelStatus: T.ObservabilityLayerStatus = 'missing';
  const kernelReasons: string[] = [];
  if (toolEvidence.length > 0) {
    if (truncatedTools > 0) kernelReasons.push('candidates_truncated');
    if (linkedTools > 0 && unlinkedTools === 0) kernelStatus = 'complete';
    else if (linkedTools > 0) {
      kernelStatus = 'partial';
      kernelReasons.push('tool_kernel_partial');
    } else if (expectedNoKernel === toolEvidence.length) {
      kernelStatus = 'complete';
      kernelReasons.push('no_kernel_event_expected');
    } else {
      kernelStatus = 'unlinked';
      kernelReasons.push('tool_kernel_unlinked');
    }
  } else if (toolRows.length > 0 && kernelFacts === 0) {
    kernelStatus = 'unlinked';
    kernelReasons.push('tool_without_kernel_fact');
  } else if (kernelFacts > 0 && kernelFacts < interactions.length) {
    kernelStatus = 'partial';
    kernelReasons.push('kernel_fact_partial');
  } else if (kernelFacts > 0) {
    kernelStatus = 'complete';
  } else if (interactions.length === 0) {
    kernelStatus = 'missing';
    kernelReasons.push('no_kernel_fact');
  }

  const sessionIds = unique(interactions.map((item) =>
    text(item.canonicalSessionId) ?? text(item.sessionKey)));
  const sessionPresent = interactions.filter((item) =>
    text(item.canonicalSessionId) ?? text(item.sessionKey)).length;
  const sessionReasons: string[] = [];
  if (sessionIds.length > 1) sessionReasons.push('multiple_canonical_sessions');
  if (sessionPresent < interactions.length && interactions.length > 0) {
    sessionReasons.push('session_unresolved');
  }

  const runIds = unique(interactions.map((item) =>
    text(item.invocationId) ?? text(item.runId) ?? text(item.producerRunId)));
  const runPresent = interactions.filter((item) =>
    text(item.invocationId) ?? text(item.runId) ?? text(item.producerRunId)).length;
  const runReasons: string[] = [];
  if (runIds.length > 1) runReasons.push('multiple_runs');
  if (runPresent < interactions.length && interactions.length > 0) runReasons.push('run_unresolved');

  return {
    schemaVersion: 'anysentry.observability_coverage_layers.v1',
    plaintext: {
      status: plaintextStatus,
      reasons: plaintext.reasons,
      count: plaintext.completeInteractions,
    },
    kernel: {
      status: kernelStatus,
      reasons: kernelReasons,
      count: linkedTools || kernelFacts,
      factCount: linkedFactIds.length || kernelFacts,
    },
    session: {
      status: layerStatus(sessionPresent, interactions.length, 'missing'),
      reasons: sessionReasons,
      count: sessionPresent,
      canonicalSessionIds: sessionIds.slice(0, 8),
    },
    run: {
      status: layerStatus(runPresent, interactions.length, 'missing'),
      reasons: runReasons,
      count: runPresent,
      runIds: runIds.slice(0, 8),
    },
  };
}

/**
 * Exact Session/Run alias lookup must report the matched rows' own coverage.
 * Do not inherit list-window reasons from unrelated Sessions, and do not force
 * `partial` just because the deep link used a bounded alias retry.
 */
export function exactSessionPointReadCoverage(
  items: ReadonlyArray<{ coverage?: { status?: string; reasons?: readonly string[] } }>,
  source: string,
): { status: 'complete' | 'partial'; reasons: string[]; source: string } {
  const complete = items.length > 0
    && items.every((item) => item.coverage?.status === 'complete');
  return {
    status: complete ? 'complete' : 'partial',
    reasons: complete
      ? []
      : [...new Set(items.flatMap((item) => item.coverage?.reasons ?? []))]
        .filter(Boolean)
        .slice(0, 64),
    source,
  };
}

export function sessionResourceAliases(item: {
  sessionId?: string;
  canonicalSessionId?: string;
  conversationId?: string;
  sessionKey?: string;
  coverageLayers?: { run?: { runIds?: readonly string[] } };
}): string[] {
  return [...new Set([
    item.sessionId,
    item.canonicalSessionId,
    item.conversationId,
    item.sessionKey,
    ...(item.coverageLayers?.run?.runIds ?? []),
  ].filter((value): value is string => Boolean(value)))];
}

/** Membership-only stubs have an id but no semantic interactions. */
export function sessionResourceHydrated(item: {
  coverage?: { status?: string; completeInteractions?: number };
  interactionIds?: readonly string[];
}): boolean {
  return (item.coverage?.completeInteractions ?? 0) > 0
    || item.coverage?.status === 'complete';
}
