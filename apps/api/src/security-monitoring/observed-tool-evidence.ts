/**
 * Product-neutral Tool↔Kernel evidence from observed Interactions.
 *
 * Authenticated adapter AgentTool spans remain the S6 linker path. HTTP/tool
 * wire captures already carry invocationId + toolCalls; this projection turns
 * those records into the same EvidenceLink arbitration used by semantic
 * kernel relations. Time is only a search bound.
 */

import {
  buildSemanticKernelRelationBatch,
  type SemanticKernelRelationInput,
} from './agent-semantic-kernel-relation';
import { expectedNoKernelTool, toolContentCode } from './agent-tool-shape';
import type { ToolEvidenceItem, ToolEvidenceLinkMethod, ToolEvidenceReason } from './tool-evidence-linker';
import type * as T from './types';

export const OBSERVED_TOOL_EVIDENCE_VERSION = 1;
export const OBSERVED_KERNEL_EVENT_KINDS = [
  'ToolExec',
  'Egress',
  'FileAccess',
  'FileDelete',
  'Dns',
  'Tls',
] as const;
const KERNEL_SEARCH_SKEW_MS = 2_000;
const ALIAS_FOLD_WINDOW_MS = 60_000;

function text(value: unknown, limit = 512): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= limit ? trimmed : undefined;
}

function matchesInvocation(record: T.AgentInteractionRecord, invocationId: string): boolean {
  return [
    record.invocationId,
    record.runId,
    record.producerRunId,
    record.sessionId,
  ].some((value) => text(value, 512) === invocationId);
}

export function observedKernelSearchWindow(
  interactions: readonly T.AgentInteractionRecord[],
): { startMs: number; endMs: number } | undefined {
  const marks: number[] = [];
  const push = (value: unknown) => {
    if (typeof value === 'number' && Number.isFinite(value)) marks.push(value);
    if (typeof value === 'string') {
      const parsed = unixNsToMs(value, Number.NaN);
      if (Number.isFinite(parsed)) marks.push(parsed);
    }
  };
  for (const record of interactions) {
    push(record.at);
    push(record.startedAtUnixNs);
    push(record.endedAtUnixNs);
    for (const call of record.toolCalls) push(call.issuedAtUnixNs);
    for (const result of record.toolResults) push(result.observedAtUnixNs);
  }
  if (marks.length === 0) return undefined;
  return {
    startMs: Math.min(...marks) - KERNEL_SEARCH_SKEW_MS,
    endMs: Math.max(...marks) + KERNEL_SEARCH_SKEW_MS,
  };
}

function unixNs(value: string | undefined, fallbackMs: number): string {
  const explicit = text(value, 32);
  if (explicit) return explicit;
  try {
    return String(BigInt(Math.trunc(fallbackMs)) * 1_000_000n);
  } catch {
    return '1000000000';
  }
}

function unixNsToMs(value: string | undefined, fallbackMs: number): number {
  if (!value) return fallbackMs;
  try {
    return Number(BigInt(value) / 1_000_000n);
  } catch {
    return fallbackMs;
  }
}

function semanticStub(
  record: T.AgentInteractionRecord,
  kind: 'tool_call' | 'tool_result',
  toolCallId: string,
  name: string | undefined,
  content: unknown,
  atUnixNs: string,
): T.AgentSemanticEvent {
  return {
    semanticEventId: `se_obs_${kind}_${record.interactionId}_${toolCallId}`,
    conversationId: record.conversationId ?? '',
    segmentId: record.canonicalSessionId ?? record.sessionId ?? '',
    turnId: record.turnId ?? record.interactionId,
    actor: 'tool',
    kind,
    atUnixNs,
    ...(content !== undefined ? { content } : {}),
    toolCallId,
    ...(name ? { toolName: name } : {}),
    sourceInteractionIds: [record.interactionId],
    evidenceEventIds: [...(record.evidenceEventIds ?? [])],
    parserId: 'observed-tool-evidence',
    parserVersion: OBSERVED_TOOL_EVIDENCE_VERSION,
    correlationQuality: record.correlationQuality ?? 'inferred',
    completeness: 'complete',
    partialReasons: [],
    ...(record.workflowNode ? { workflowNode: record.workflowNode } : {}),
    ...(record.hop ? { hop: record.hop } : {}),
    ...(record.delegationId ? { delegationId: record.delegationId } : {}),
  };
}

export function observedToolRelationInputs(
  interactions: readonly T.AgentInteractionRecord[],
  invocationId: string,
  toolCallId?: string,
): SemanticKernelRelationInput[] {
  const id = invocationId.trim();
  if (!id) return [];
  const scoped = interactions
    .filter((record) => matchesInvocation(record, id))
    .sort((left, right) => left.at - right.at || left.interactionId.localeCompare(right.interactionId));
  const owners = new Map<string, {
    call: T.AgentInteractionToolCall;
    owner: T.AgentInteractionRecord;
    result?: T.AgentInteractionToolResult;
    resultOwner?: T.AgentInteractionRecord;
  }>();
  for (const record of scoped) {
    for (const call of record.toolCalls) {
      const callId = text(call.toolCallId, 512);
      if (!callId || (toolCallId && callId !== toolCallId)) continue;
      const prior = owners.get(callId);
      const preferTool = record.interactionType === 'tool'
        && prior?.owner.interactionType !== 'tool';
      if (!prior || preferTool) {
        owners.set(callId, {
          call,
          owner: record,
          result: prior?.result,
          resultOwner: prior?.resultOwner,
        });
      }
    }
    for (const result of record.toolResults) {
      const callId = text(result.toolCallId, 512);
      if (!callId || (toolCallId && callId !== toolCallId)) continue;
      const prior = owners.get(callId);
      if (!prior) continue;
      if (!prior.result || record.at >= (prior.resultOwner?.at ?? 0)) {
        prior.result = result;
        prior.resultOwner = record;
      }
    }
  }
  return [...owners.values()].map(({ call, owner, result, resultOwner }) => {
    const issued = unixNs(call.issuedAtUnixNs ?? owner.startedAtUnixNs, owner.at);
    const event = semanticStub(owner, 'tool_call', call.toolCallId, call.name, call.arguments, issued);
    const closed = result
      ? semanticStub(
        resultOwner ?? owner,
        'tool_result',
        call.toolCallId,
        result.name ?? call.name,
        result.content,
        unixNs(result.observedAtUnixNs ?? (resultOwner ?? owner).endedAtUnixNs, (resultOwner ?? owner).at),
      )
      : undefined;
    return { event, result: closed, interaction: owner };
  });
}

function mapLinkMethod(relation: T.AgentSemanticKernelRelation): ToolEvidenceLinkMethod {
  if (relation.linkMethod === 'resource') return 'same_process_resource';
  if (relation.linkMethod === 'command' && relation.lineageMethod === 'delegated_runtime') {
    return 'delegated_command';
  }
  if (relation.linkMethod === 'network' || relation.linkMethod === 'network_endpoint') {
    return 'network';
  }
  return 'direct_child_command';
}

function mapReason(
  status: ToolEvidenceItem['status'],
  methods: readonly ToolEvidenceLinkMethod[],
  options?: { expectedNoKernel?: boolean; candidatesTruncated?: boolean },
): ToolEvidenceReason {
  if (status === 'ambiguous') return 'overlapping_exact_claims';
  if (methods.includes('same_process_resource')) return 'exact_process_and_resource';
  if (methods.includes('delegated_command')) return 'delegated_command';
  if (methods.includes('direct_child_command')) return 'exact_child_and_command';
  if (methods.includes('network')) return 'network_witness';
  if (options?.expectedNoKernel) return 'no_kernel_event_expected';
  if (options?.candidatesTruncated) return 'candidates_truncated';
  return 'no_matching_kernel_evidence';
}

function sameObservedRuntime(
  left: T.AgentInteractionRecord,
  right: T.AgentInteractionRecord,
): boolean {
  const leftRuntime = left.runtimeInstanceId ?? left.canonicalAgentInstanceId ?? left.agentInstanceId;
  const rightRuntime = right.runtimeInstanceId ?? right.canonicalAgentInstanceId ?? right.agentInstanceId;
  return Boolean(leftRuntime && rightRuntime && leftRuntime === rightRuntime);
}

function hopCompatible(
  left: T.AgentInteractionRecord,
  right: T.AgentInteractionRecord,
): boolean {
  const leftHop = text(left.hop, 120);
  const rightHop = text(right.hop, 120);
  if (!leftHop || !rightHop || leftHop === rightHop) return true;
  return Boolean(text(left.delegationId) && left.delegationId === right.delegationId);
}

function isDelegatedHttpAlias(input: SemanticKernelRelationInput): boolean {
  if (input.interaction.interactionType === 'tool') return false;
  return Boolean(toolContentCode(input.event.content));
}

export function foldObservedHttpToolAliases(
  items: readonly ToolEvidenceItem[],
  inputs: readonly SemanticKernelRelationInput[],
): ToolEvidenceItem[] {
  const byCallId = new Map(inputs.map((input) => [input.event.toolCallId, input]));
  const backends = items.filter((item) => {
    if (item.status !== 'linked') return false;
    return byCallId.get(item.toolCallId)?.interaction.interactionType === 'tool';
  });
  return items.map((item) => {
    if (item.status === 'linked' || item.reason === 'no_kernel_event_expected') return item;
    const input = byCallId.get(item.toolCallId);
    if (!input || !isDelegatedHttpAlias(input)) return item;
    const fingerprint = toolContentCode(input.event.content);
    const peers = backends
      .map((backend) => {
        const backendInput = byCallId.get(backend.toolCallId);
        if (!backendInput || !sameObservedRuntime(input.interaction, backendInput.interaction)) {
          return undefined;
        }
        if (!hopCompatible(input.interaction, backendInput.interaction)) return undefined;
        const backendFingerprint = toolContentCode(backendInput.event.content);
        if (fingerprint && backendFingerprint && fingerprint !== backendFingerprint) return undefined;
        const distance = Math.abs((backend.startedAt ?? 0) - (item.startedAt ?? 0));
        if (distance > ALIAS_FOLD_WINDOW_MS) return undefined;
        return { backend, distance };
      })
      .filter((entry): entry is { backend: ToolEvidenceItem; distance: number } => Boolean(entry))
      .sort((left, right) => left.distance - right.distance
        || left.backend.toolCallId.localeCompare(right.backend.toolCallId));
    if (peers.length === 0) return item;
    if (peers.length > 1 && peers[0]!.distance === peers[1]!.distance) return item;
    const winner = peers[0]!.backend;
    return {
      ...item,
      status: 'linked',
      reason: winner.reason,
      kernelEvidence: winner.kernelEvidence,
    };
  });
}

export function buildObservedToolEvidenceItems(
  invocationId: string,
  inputs: readonly SemanticKernelRelationInput[],
  relationsBySemanticEventId: ReadonlyMap<string, T.AgentSemanticKernelRelation[]>,
  coveragePartial = false,
): ToolEvidenceItem[] {
  return inputs.map((input) => {
    const relations = relationsBySemanticEventId.get(input.event.semanticEventId) ?? [];
    const linked = relations.filter((relation) =>
      Boolean(relation.kernelEventId)
      && ['linked_exact', 'linked_strong'].includes(relation.status));
    const ambiguous = relations.filter((relation) => relation.status === 'ambiguous');
    const kernelEvidence = linked
      .filter((relation): relation is T.AgentSemanticKernelRelation & { kernelEventId: string } =>
        Boolean(relation.kernelEventId))
      .map((relation) => ({
        eventId: relation.kernelEventId,
        eventKind: relation.kernelEventKind ?? 'ToolExec',
        at: unixNsToMs(
          typeof relation.kernelEventAt === 'string' && /^\d+$/u.test(relation.kernelEventAt)
            ? relation.kernelEventAt
            : undefined,
          Date.parse(relation.kernelEventAt ?? '') || input.interaction.at,
        ),
        linkMethod: mapLinkMethod(relation),
        confidence: relation.confidence,
      }))
      .sort((left, right) => left.at - right.at);
    const ambiguousKernelEventIds = [...new Set(ambiguous.flatMap((relation) => [
      ...(relation.competingKernelEventIds ?? []),
      ...(relation.kernelEventId ? [relation.kernelEventId] : []),
    ]))];
    const status: ToolEvidenceItem['status'] = kernelEvidence.length
      ? 'linked'
      : ambiguousKernelEventIds.length
        ? 'ambiguous'
        : 'semantic_only';
    return {
      invocationId,
      toolCallId: input.event.toolCallId ?? input.interaction.interactionId,
      toolName: input.event.toolName ?? 'unknown',
      startedAt: unixNsToMs(input.event.atUnixNs, input.interaction.at),
      ...(input.result
        ? { endedAt: unixNsToMs(input.result.atUnixNs, input.interaction.at) }
        : {}),
      status,
      reason: mapReason(status, kernelEvidence.map((item) => item.linkMethod), {
        expectedNoKernel: expectedNoKernelTool(
          [input.event.toolKind, input.event.toolName].filter(Boolean).join(' '),
          input.event.content,
        ),
        candidatesTruncated: coveragePartial,
      }),
      adapterEventIds: [...new Set([
        ...(input.interaction.evidenceEventIds ?? []),
        ...input.event.evidenceEventIds,
        ...(input.result?.evidenceEventIds ?? []),
      ])],
      kernelEvidence,
      ...(ambiguousKernelEventIds.length ? { ambiguousKernelEventIds } : {}),
    };
  }).sort((left, right) => (left.startedAt ?? 0) - (right.startedAt ?? 0));
}

export function projectObservedToolEvidence(
  invocationId: string,
  interactions: readonly T.AgentInteractionRecord[],
  candidates: readonly T.AgentEventListItem[],
  resolutionRevision: number,
  coveragePartial: boolean,
  toolCallId?: string,
): {
  inputs: SemanticKernelRelationInput[];
  items: ToolEvidenceItem[];
} {
  const inputs = observedToolRelationInputs(interactions, invocationId, toolCallId);
  const batch = buildSemanticKernelRelationBatch(
    inputs,
    [...candidates],
    resolutionRevision,
    coveragePartial,
  );
  return {
    inputs,
    items: foldObservedHttpToolAliases(
      buildObservedToolEvidenceItems(
        invocationId,
        inputs,
        batch.relationsBySemanticEventId,
        coveragePartial,
      ),
      inputs,
    ),
  };
}
