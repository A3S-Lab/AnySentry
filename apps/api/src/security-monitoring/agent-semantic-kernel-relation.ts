import { createHash } from 'node:crypto';

import type * as T from './types';

export const AGENT_SEMANTIC_KERNEL_RELATION_VERSION = 2;
const CLOCK_SKEW_MS = 2_000;
const OPEN_TOOL_WINDOW_MS = 30 * 60_000;

function stableId(prefix: string, value: string): string {
  return prefix + '_' + createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function text(value: unknown, limit = 16_384): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= limit ? normalized : undefined;
}

function unixNsToMs(value: string): number {
  try {
    return Number(BigInt(value) / 1_000_000n);
  } catch {
    return Number.NaN;
  }
}

function normalizedCommand(value: string): string {
  return value
    .trim()
    .replace(/^\/(?:usr\/)?bin\/(?:ba)?sh\s+-(?:l)?c\s+/u, '')
    .replace(/^['"]|['"]$/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function nestedString(value: unknown, keys: string[], depth = 0): string | undefined {
  if (depth > 6) return undefined;
  const object = record(value);
  if (!object) return undefined;
  for (const key of keys) {
    const direct = text(object[key]);
    if (direct) return direct;
  }
  for (const child of Object.values(object)) {
    if (!child || typeof child !== 'object') continue;
    const nested = nestedString(child, keys, depth + 1);
    if (nested) return nested;
  }
  return undefined;
}

function quotedField(value: string, field: string): string | undefined {
  const pattern = new RegExp(
    "(?:[\"']?" + field + "[\"']?)\\s*:\\s*(\"(?:\\\\.|[^\"\\\\])*\")",
    'u',
  );
  const match = value.match(pattern)?.[1];
  if (!match) return undefined;
  try {
    return JSON.parse(match);
  } catch {
    return undefined;
  }
}

function toolCommand(event: T.AgentSemanticEvent): string | undefined {
  if (typeof event.content === 'string') {
    try {
      const parsed = JSON.parse(event.content);
      const nested = nestedString(parsed, ['cmd', 'command', 'script']);
      if (nested) return nested;
    } catch {
      // Custom tools commonly encode a JavaScript orchestration snippet rather than JSON.
    }
    return quotedField(event.content, 'cmd')
      ?? quotedField(event.content, 'command')
      ?? quotedField(event.content, 'script');
  }
  return nestedString(event.content, ['cmd', 'command', 'script']);
}

function toolResource(event: T.AgentSemanticEvent): string | undefined {
  if (typeof event.content === 'string') {
    try {
      const parsed = JSON.parse(event.content);
      const nested = nestedString(parsed, ['path', 'file', 'filePath', 'resource']);
      if (nested) return nested;
    } catch {
      // Fall through to bounded quoted-field extraction.
    }
    return quotedField(event.content, 'path') ?? quotedField(event.content, 'filePath');
  }
  return nestedString(event.content, ['path', 'file', 'filePath', 'resource']);
}

function toolHost(event: T.AgentSemanticEvent): string | undefined {
  const raw = typeof event.content === 'string'
    ? text(event.content)
    : nestedString(event.content, ['url', 'uri', 'endpoint', 'host']);
  if (!raw) return undefined;
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return text(raw, 512)?.toLowerCase();
  }
}

function candidatePath(event: T.AgentEventListItem): string | undefined {
  return text(event.attributes.path, 4_096)
    ?? text(event.attributes.filePath, 4_096)
    ?? text(event.attributes.resourcePath, 4_096)
    ?? text(event.subject.match(/(?:^|\s)(\/[^\s]+)/u)?.[1], 4_096);
}

function candidateHost(event: T.AgentEventListItem): string | undefined {
  return text(event.attributes.host, 512)?.toLowerCase()
    ?? text(event.attributes.serverAddress, 512)?.toLowerCase()
    ?? text(event.attributes['server.address'], 512)?.toLowerCase()
    ?? text(event.attributes.hostname, 512)?.toLowerCase();
}

function sameRuntime(
  interaction: T.AgentInteractionRecord,
  candidate: T.AgentEventListItem,
): boolean {
  if (!interaction.agentInstanceId || !candidate.agentRuntimeInstanceId) return false;
  if (candidate.agentRuntimeInstanceId === interaction.agentInstanceId) return true;
  return candidate.agentRuntimeInstanceAliases?.includes(interaction.agentInstanceId) === true;
}

type RuntimeLink = 'direct_runtime' | 'generation_parent' | 'legacy_pid_parent';

interface CandidateIndex {
  byGeneration: Map<string, T.AgentEventListItem[]>;
  byPidDomain: Map<string, T.AgentEventListItem[]>;
}

export interface SemanticKernelRelationInput {
  event: T.AgentSemanticEvent;
  result?: T.AgentSemanticEvent;
  interaction: T.AgentInteractionRecord;
}

export interface SemanticKernelRelationBatchResult {
  relationsBySemanticEventId: Map<string, T.AgentSemanticKernelRelation[]>;
  allRelations: T.AgentSemanticKernelRelation[];
}

export interface SemanticKernelRelationWindow {
  startMs: number;
  endMs: number;
}

function semanticEventAtMs(event: T.AgentSemanticEvent): number {
  return Number(BigInt(event.atUnixNs) / 1_000_000n);
}

/** Cover every competing Tool interval so a complete batch can safely replace persisted owners. */
export function semanticKernelRelationBatchWindow(
  inputs: SemanticKernelRelationInput[],
  fallback: SemanticKernelRelationInput,
): SemanticKernelRelationWindow {
  const bounded = inputs.length ? inputs.slice(0, 1_000) : [fallback];
  return {
    startMs: Math.max(0, Math.min(...bounded.map(({ event }) => semanticEventAtMs(event))) - CLOCK_SKEW_MS),
    endMs: Math.max(...bounded.map(({ event, result }) => result
      ? semanticEventAtMs(result)
      : semanticEventAtMs(event) + OPEN_TOOL_WINDOW_MS)) + CLOCK_SKEW_MS,
  };
}

function trustedProcessGenerationKey(
  event: T.AgentEventListItem,
  field: 'processGenerationKey' | 'parentProcessGenerationKey',
): string | undefined {
  const correlation = event.correlation ?? event.attribution?.correlation;
  if (
    !correlation ||
    correlation.inferred ||
    !['attested_observer', 'server_process_graph'].includes(correlation.authority)
  ) return undefined;
  if (
    field === 'parentProcessGenerationKey' &&
    event.attribution?.parentLinkAuthority !== 'forwarder_process_graph'
  ) return undefined;
  const value = text(event.attribution?.[field], 64);
  return value && /^pgk_[a-f0-9]{24}$/u.test(value) ? value : undefined;
}

function processDomainPidKey(event: T.AgentEventListItem, pid = event.process?.pid): string | undefined {
  if (!Number.isSafeInteger(pid) || Number(pid) <= 0) return undefined;
  const hostId = text(event.process?.hostId, 512);
  const bootId = text(event.process?.bootId, 512);
  if (!hostId || !bootId) return undefined;
  return [hostId, bootId, Number(pid)].join('\u0000');
}

function addIndex(
  index: Map<string, T.AgentEventListItem[]>,
  key: string | undefined,
  event: T.AgentEventListItem,
): void {
  if (!key) return;
  const values = index.get(key) ?? [];
  values.push(event);
  index.set(key, values);
}

function buildCandidateIndex(candidates: T.AgentEventListItem[]): CandidateIndex {
  const index: CandidateIndex = {
    byGeneration: new Map(),
    byPidDomain: new Map(),
  };
  for (const candidate of candidates) {
    addIndex(
      index.byGeneration,
      trustedProcessGenerationKey(candidate, 'processGenerationKey'),
      candidate,
    );
    addIndex(index.byPidDomain, processDomainPidKey(candidate), candidate);
  }
  return index;
}

function hasGenerationEvidence(event: T.AgentEventListItem): boolean {
  return Boolean(
    trustedProcessGenerationKey(event, 'processGenerationKey') ||
    trustedProcessGenerationKey(event, 'parentProcessGenerationKey') ||
    text(event.process?.startTimeTicks, 512) ||
    text(event.process?.startTimeNs, 512),
  );
}

function generationRuntimeMatch(
  interaction: T.AgentInteractionRecord,
  candidate: T.AgentEventListItem,
  index: CandidateIndex,
): RuntimeLink | undefined {
  let parentKey = trustedProcessGenerationKey(candidate, 'parentProcessGenerationKey');
  if (!parentKey) return undefined;
  const seen = new Set<string>();
  for (let depth = 0; depth < 8; depth += 1) {
    if (seen.has(parentKey)) return undefined;
    seen.add(parentKey);
    const parents = index.byGeneration.get(parentKey) ?? [];
    if (parents.some((parent) => sameRuntime(interaction, parent))) return 'generation_parent';
    parentKey = parents
      .map((parent) => trustedProcessGenerationKey(parent, 'parentProcessGenerationKey'))
      .find((value): value is string => Boolean(value));
    if (!parentKey) return undefined;
  }
  return undefined;
}

function legacyPidRuntimeMatch(
  interaction: T.AgentInteractionRecord,
  candidate: T.AgentEventListItem,
  index: CandidateIndex,
): RuntimeLink | undefined {
  let current = candidate;
  const seen = new Set<string>();
  for (let depth = 0; depth < 8; depth += 1) {
    const parentKey = processDomainPidKey(current, current.process?.ppid);
    if (!parentKey || seen.has(parentKey)) return undefined;
    seen.add(parentKey);
    const parents = (index.byPidDomain.get(parentKey) ?? [])
      .filter((parent) => !hasGenerationEvidence(parent));
    if (parents.some((parent) => sameRuntime(interaction, parent))) return 'legacy_pid_parent';
    const parent = parents.find((event) => event.process?.ppid);
    if (!parent) return undefined;
    current = parent;
  }
  return undefined;
}

function runtimeMatch(
  interaction: T.AgentInteractionRecord,
  candidate: T.AgentEventListItem,
  index: CandidateIndex,
): RuntimeLink | undefined {
  if (sameRuntime(interaction, candidate)) return 'direct_runtime';
  const exact = generationRuntimeMatch(interaction, candidate, index);
  if (exact) return exact;
  // A current-generation fact without a verified parent key is a coverage gap. Falling back to a
  // same-PID event would cross PID reuse and recreate the false ancestry this relation is meant to
  // prevent. Legacy rows with no generation evidence retain the old bounded PID walk at lower
  // confidence.
  if (hasGenerationEvidence(candidate)) return undefined;
  return legacyPidRuntimeMatch(interaction, candidate, index);
}

function withinWindow(
  event: T.AgentSemanticEvent,
  result: T.AgentSemanticEvent | undefined,
  candidate: T.AgentEventListItem,
): boolean {
  const start = unixNsToMs(event.atUnixNs);
  const resultAt = result ? unixNsToMs(result.atUnixNs) : Number.NaN;
  const end = Number.isFinite(resultAt) ? resultAt : start + OPEN_TOOL_WINDOW_MS;
  const at = Date.parse(candidate.at);
  return Number.isFinite(start) && Number.isFinite(at)
    && at >= start - CLOCK_SKEW_MS
    && at <= end + CLOCK_SKEW_MS;
}

function risk(event: T.AgentEventListItem): NonNullable<T.AgentSemanticKernelRelation['risk']> {
  return {
    verdict: event.verdict,
    tier: event.tier,
    severity: event.severity,
    riskScore: event.riskScore,
    riskName: event.riskName,
    riskCategory: event.riskCategory,
    reason: event.reason,
  };
}

export function toolInvocationId(
  event: T.AgentSemanticEvent,
  interaction: T.AgentInteractionRecord,
): string {
  return stableId('ti', [
    interaction.agentInstanceId ?? interaction.agentAssetId,
    event.toolCallId ?? event.semanticEventId,
    interaction.interactionId,
  ].join('\u0000'));
}

function potentialRelation(
  input: SemanticKernelRelationInput,
  candidate: T.AgentEventListItem,
  index: CandidateIndex,
  resolutionRevision: number,
): T.AgentSemanticKernelRelation | undefined {
  const { event, result, interaction } = input;
  const invocationId = toolInvocationId(event, interaction);
  const command = toolCommand(event);
  const resource = toolResource(event);
  const host = toolHost(event);
  const normalizedTool = (event.toolKind ?? event.toolName ?? 'other').toLowerCase();
  const acceptedKinds = /bash|exec|shell/u.test(normalizedTool)
    ? new Set(['ToolExec'])
    : /read|write|edit|file/u.test(normalizedTool)
      ? new Set(['FileAccess', 'FileDelete'])
      : /search|http|fetch|network/u.test(normalizedTool)
        ? new Set(['Egress', 'Dns', 'Tls'])
        : new Set(['ToolExec', 'FileAccess', 'FileDelete', 'Egress', 'Dns', 'Tls']);
  if (!acceptedKinds.has(candidate.eventKind) || !withinWindow(event, result, candidate)) {
    return undefined;
  }

  // Content is cheaper and more selective than ancestry. Filter it first so generation-safe
  // lineage does not turn a bounded query into repeated full-candidate scans.
  let linkMethod: T.AgentSemanticKernelRelation['linkMethod'];
  let confidence = 0;
  if (command && candidate.eventKind === 'ToolExec') {
    const expected = normalizedCommand(command);
    const observed = normalizedCommand(candidate.subject);
    if (expected && observed && (
      expected === observed || observed.includes(expected) || expected.includes(observed)
    )) {
      linkMethod = 'command';
      confidence = expected === observed ? 1 : 0.98;
    }
  }
  if (!linkMethod && resource && ['FileAccess', 'FileDelete'].includes(candidate.eventKind)) {
    const expected = resource.replace(/\/+/gu, '/');
    const observed = candidatePath(candidate)?.replace(/\/+/gu, '/');
    if (observed && observed === expected) {
      linkMethod = 'resource';
      confidence = 1;
    }
  }
  if (!linkMethod && host && ['Egress', 'Dns', 'Tls'].includes(candidate.eventKind)) {
    const observed = candidateHost(candidate);
    if (observed && (observed === host || observed.endsWith('.' + host) || host.endsWith('.' + observed))) {
      linkMethod = 'network';
      confidence = 0.98;
    }
  }
  if (!linkMethod) return undefined;

  const runtimeLink = runtimeMatch(interaction, candidate, index);
  if (!runtimeLink) return undefined;
  if (runtimeLink === 'generation_parent') confidence = Math.min(confidence, 0.99);
  if (runtimeLink === 'legacy_pid_parent') confidence = Math.min(confidence, 0.75);
  return {
    schemaVersion: 'anysentry.agent_semantic_kernel_relation.v1',
    relationId: stableId('skr', event.semanticEventId + '\u0000' + candidate.eventId),
    stableSemanticEventId: event.semanticEventId,
    conversationId: event.conversationId,
    turnId: event.turnId,
    toolInvocationId: invocationId,
    kernelEventId: candidate.eventId,
    status: confidence === 1 ? 'linked_exact' : 'linked_strong',
    linkMethod,
    lineageMethod: runtimeLink,
    confidence,
    authority: 'attested_tls_plaintext',
    relationVersion: AGENT_SEMANTIC_KERNEL_RELATION_VERSION,
    resolutionRevision,
    risk: risk(candidate),
  };
}

function unlinkedRelation(
  input: SemanticKernelRelationInput,
  resolutionRevision: number,
  coveragePartial: boolean,
): T.AgentSemanticKernelRelation {
  const invocationId = toolInvocationId(input.event, input.interaction);
  return {
    schemaVersion: 'anysentry.agent_semantic_kernel_relation.v1',
    relationId: stableId('skr', input.event.semanticEventId + '\u0000unlinked'),
    stableSemanticEventId: input.event.semanticEventId,
    conversationId: input.event.conversationId,
    turnId: input.event.turnId,
    toolInvocationId: invocationId,
    status: coveragePartial ? 'coverage_gap' : 'semantic_only',
    confidence: 0,
    authority: 'attested_tls_plaintext',
    relationVersion: AGENT_SEMANTIC_KERNEL_RELATION_VERSION,
    resolutionRevision,
  };
}

function sortRelations(relations: T.AgentSemanticKernelRelation[]): T.AgentSemanticKernelRelation[] {
  return relations.sort((left, right) =>
    (right.risk?.riskScore ?? 0) - (left.risk?.riskScore ?? 0)
    || (right.confidence - left.confidence)
    || (left.kernelEventId ?? '').localeCompare(right.kernelEventId ?? ''));
}

export function buildSemanticKernelRelationBatch(
  inputs: SemanticKernelRelationInput[],
  candidates: T.AgentEventListItem[],
  resolutionRevision: number,
  coveragePartial = false,
): SemanticKernelRelationBatchResult {
  const boundedInputs = inputs.slice(0, 1_000);
  const index = buildCandidateIndex(candidates);
  const potentialBySemantic = new Map<string, T.AgentSemanticKernelRelation[]>();
  const ownersByKernel = new Map<string, Set<string>>();
  const invocationBySemantic = new Map<string, string>();

  for (const input of boundedInputs) {
    const semanticId = input.event.semanticEventId;
    invocationBySemantic.set(semanticId, toolInvocationId(input.event, input.interaction));
    const relations = candidates
      .map((candidate) => potentialRelation(input, candidate, index, resolutionRevision))
      .filter((relation): relation is T.AgentSemanticKernelRelation => Boolean(relation));
    potentialBySemantic.set(semanticId, relations);
    for (const relation of relations) {
      if (!relation.kernelEventId) continue;
      const owners = ownersByKernel.get(relation.kernelEventId) ?? new Set<string>();
      owners.add(semanticId);
      ownersByKernel.set(relation.kernelEventId, owners);
    }
  }

  const relationsBySemanticEventId = new Map<string, T.AgentSemanticKernelRelation[]>();
  for (const input of boundedInputs) {
    const semanticId = input.event.semanticEventId;
    const resolved = (potentialBySemantic.get(semanticId) ?? []).map((relation) => {
      const owners = relation.kernelEventId
        ? ownersByKernel.get(relation.kernelEventId) ?? new Set<string>()
        : new Set<string>();
      if (owners.size <= 1) return relation;
      return {
        ...relation,
        status: 'ambiguous' as const,
        confidence: 0,
        risk: undefined,
        competingToolInvocationIds: [...owners]
          .map((owner) => invocationBySemantic.get(owner))
          .filter((value): value is string => Boolean(value))
          .sort(),
      };
    });
    relationsBySemanticEventId.set(
      semanticId,
      resolved.length
        ? sortRelations(resolved)
        : [unlinkedRelation(input, resolutionRevision, coveragePartial)],
    );
  }

  return {
    relationsBySemanticEventId,
    allRelations: [...relationsBySemanticEventId.values()].flat(),
  };
}

export function buildSemanticKernelRelations(
  event: T.AgentSemanticEvent,
  result: T.AgentSemanticEvent | undefined,
  interaction: T.AgentInteractionRecord,
  candidates: T.AgentEventListItem[],
  resolutionRevision: number,
  coveragePartial = false,
): T.AgentSemanticKernelRelation[] {
  return buildSemanticKernelRelationBatch(
    [{ event, result, interaction }],
    candidates,
    resolutionRevision,
    coveragePartial,
  ).relationsBySemanticEventId.get(event.semanticEventId) ?? [];
}
