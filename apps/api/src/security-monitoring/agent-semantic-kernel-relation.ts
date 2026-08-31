import { createHash } from 'node:crypto';

import type * as T from './types';

export const AGENT_SEMANTIC_KERNEL_RELATION_VERSION = 1;
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

function sameProcessDomain(
  left: T.AgentEventListItem,
  right: T.AgentEventListItem,
): boolean {
  if (left.process?.hostId && right.process?.hostId
    && left.process.hostId !== right.process.hostId) return false;
  if (left.process?.bootId && right.process?.bootId
    && left.process.bootId !== right.process.bootId) return false;
  return true;
}

function runtimeMatch(
  interaction: T.AgentInteractionRecord,
  candidate: T.AgentEventListItem,
  candidates: T.AgentEventListItem[],
): 'direct' | 'ancestry' | undefined {
  if (sameRuntime(interaction, candidate)) return 'direct';
  let current = candidate;
  const seen = new Set<number>();
  for (let depth = 0; depth < 8; depth += 1) {
    const parentPid = current.process?.ppid;
    if (!parentPid || seen.has(parentPid)) return undefined;
    seen.add(parentPid);
    const parents = candidates.filter((event) =>
      event.process?.pid === parentPid && sameProcessDomain(current, event));
    if (parents.some((parent) => sameRuntime(interaction, parent))) return 'ancestry';
    const parent = parents.find((event) => event.process?.ppid);
    if (!parent) return undefined;
    current = parent;
  }
  return undefined;
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

export function buildSemanticKernelRelations(
  event: T.AgentSemanticEvent,
  result: T.AgentSemanticEvent | undefined,
  interaction: T.AgentInteractionRecord,
  candidates: T.AgentEventListItem[],
  resolutionRevision: number,
  coveragePartial = false,
): T.AgentSemanticKernelRelation[] {
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
  const relations: T.AgentSemanticKernelRelation[] = [];
  for (const candidate of candidates) {
    if (!acceptedKinds.has(candidate.eventKind) || !withinWindow(event, result, candidate)) continue;
    const runtimeLink = runtimeMatch(interaction, candidate, candidates);
    if (!runtimeLink) continue;
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
    if (!linkMethod) continue;
    if (runtimeLink === 'ancestry') confidence = Math.min(confidence, 0.99);
    relations.push({
      schemaVersion: 'anysentry.agent_semantic_kernel_relation.v1',
      relationId: stableId('skr', event.semanticEventId + '\u0000' + candidate.eventId),
      stableSemanticEventId: event.semanticEventId,
      conversationId: event.conversationId,
      turnId: event.turnId,
      toolInvocationId: invocationId,
      kernelEventId: candidate.eventId,
      status: confidence === 1 ? 'linked_exact' : 'linked_strong',
      linkMethod,
      confidence,
      authority: 'attested_tls_plaintext',
      relationVersion: AGENT_SEMANTIC_KERNEL_RELATION_VERSION,
      resolutionRevision,
      risk: risk(candidate),
    });
  }
  if (relations.length) return relations.sort((left, right) =>
    (right.risk?.riskScore ?? 0) - (left.risk?.riskScore ?? 0)
    || (right.confidence - left.confidence)
    || (left.kernelEventId ?? '').localeCompare(right.kernelEventId ?? ''));
  return [{
    schemaVersion: 'anysentry.agent_semantic_kernel_relation.v1',
    relationId: stableId('skr', event.semanticEventId + '\u0000unlinked'),
    stableSemanticEventId: event.semanticEventId,
    conversationId: event.conversationId,
    turnId: event.turnId,
    toolInvocationId: invocationId,
    status: coveragePartial ? 'coverage_gap' : 'semantic_only',
    confidence: 0,
    authority: 'attested_tls_plaintext',
    relationVersion: AGENT_SEMANTIC_KERNEL_RELATION_VERSION,
    resolutionRevision,
  }];
}
