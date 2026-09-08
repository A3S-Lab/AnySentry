import { createHash } from 'node:crypto';

import type * as T from './types';
import { createEvidenceLink, type EvidenceLink } from './canonical-observability';
import { matchAgentAdapterManifest, normalizeExecArgv } from './agent-adapter-execution';
import { agentRuntimeInstanceIdsEquivalent } from './agent-identity';

export const AGENT_SEMANTIC_KERNEL_RELATION_VERSION = 4;
const CLOCK_SKEW_MS = 2_000;
/** Open-call fallback when ToolResult is still missing. Keep far shorter than a wall-clock
 *  session so late unrelated ToolExec/File/Egress cannot attach to a sticky pending ToolCall. */
const OPEN_TOOL_WINDOW_MS = 5 * 60_000;
const SHELL_TOOL_PATTERN = /(?:^|[\s._-])(?:bash|exec|shell)(?:$|[\s._-])/u;
const FILE_TOOL_PATTERN = /(?:^|[\s._-])(?:read|write|edit|file)(?:$|[\s._-])/u;
const NETWORK_TOOL_PATTERN = /(?:^|[\s._-])(?:search|http|fetch|network)(?:$|[\s._-])/u;
/** Remote code-block sandboxes exec a fixed runner; semantic tools carry code/endpoint, not argv. */
const SANDBOX_TOOL_PATTERN = /sandbox/u;
const SANDBOX_RUNNER_PATTERN = /(?:^|[\s/])runner\.py(?:\s|$)/u;
// Only an explicitly network-shaped endpoint may correlate a semantic ToolCall with an
// Observer Egress/DNS/TLS fact.  Compatibility projections use `application://semantic-event`
// when a span has no endpoint; treating that placeholder as a host would allow an unrelated
// connection whose name happens to be `semantic-event` to become a false positive.
const NETWORK_ENDPOINT_PROTOCOLS = new Set(['http:', 'https:', 'ws:', 'wss:', 'grpc:', 'grpcs:', 'tcp:', 'tls:']);

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

function candidateEventAtMs(event: T.AgentEventListItem): number {
  if (event.eventAtUnixNs) {
    const precise = unixNsToMs(event.eventAtUnixNs);
    if (Number.isFinite(precise)) return precise;
  }
  const at = text(event.at, 128);
  if (!at) return Number.NaN;
  // ClickHouse's historical display field is `YYYY-MM-DD HH:mm:ss` without a zone. It denotes
  // UTC, but Date.parse otherwise interprets it in the API process's local timezone.
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/u.test(at)
    ? at.replace(' ', 'T') + 'Z'
    : at;
  return Date.parse(normalized);
}

function adapterManifestFor(interaction: T.AgentInteractionRecord | undefined) {
  if (!interaction) return undefined;
  return matchAgentAdapterManifest({
    product: interaction.agentProduct,
    displayName: interaction.agentProduct,
    comm: interaction.process?.comm,
    exe: interaction.process?.exe,
  });
}

function normalizedCommand(
  value: string,
  interaction?: T.AgentInteractionRecord,
): string {
  const adapted = normalizeExecArgv(adapterManifestFor(interaction), value);
  return adapted
    .trim()
    .replace(/^\/(?:usr\/)?bin\/(?:ba)?sh\s+-(?:l)?c\s+/u, '')
    .replace(/^['"]|['"]$/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function candidateCommand(event: T.AgentEventListItem): string | undefined {
  // `subject` is deliberately a short dashboard summary and can end before an Agent shell's
  // actual `eval <tool command>` suffix. The observer keeps the bounded execve argv separately;
  // use it only when the collector explicitly says that no argument bytes or fragments are
  // missing, otherwise retain the conservative summary-only behavior.
  const argvComplete = event.attributes.argv_truncated !== true
    && event.attributes.argv_incomplete !== true;
  return (argvComplete ? text(event.attributes.argv, 65_536) : undefined)
    ?? text(event.subject, 65_536);
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

function toolMarker(event: T.AgentSemanticEvent): string | undefined {
  if (typeof event.content === 'string') {
    try {
      const parsed = JSON.parse(event.content);
      const nested = nestedString(parsed, ['marker']);
      if (nested) return nested;
    } catch {
      // Fall through.
    }
    return quotedField(event.content, 'marker');
  }
  return nestedString(event.content, ['marker']);
}

function toolHost(event: T.AgentSemanticEvent): string | undefined {
  const raw = typeof event.content === 'string'
    ? text(event.content)
    : nestedString(event.content, ['url', 'uri', 'endpoint', 'host']);
  if (!raw) return undefined;
  try {
    const scheme = raw.match(/^([a-z][a-z0-9+.-]*):/iu)?.[1]?.toLowerCase();
    const hostPortLike = /^[^/:?#\s]+:\d{1,5}(?:[/?#]|$)/u.test(raw);
    const explicitScheme = raw.includes('://');
    if (scheme && !hostPortLike && (!explicitScheme || !NETWORK_ENDPOINT_PROTOCOLS.has(`${scheme}:`))) return undefined;
    const parsed = new URL(explicitScheme ? raw : `http://${raw}`);
    if (explicitScheme && !NETWORK_ENDPOINT_PROTOCOLS.has(parsed.protocol)) return undefined;
    return parsed.hostname.toLowerCase();
  } catch {
    return text(raw, 512)?.toLowerCase();
  }
}

function parsedInteractionEndpoint(interaction: T.AgentInteractionRecord): URL | undefined {
  // Application/OTLP semantic Tool spans are kept in the legacy model lane so the existing
  // conversation timeline remains compatible.  Their explicit `semanticOnly` + ToolCall shape
  // is still a trusted endpoint hint for correlation; ordinary model calls must not enter this
  // path merely because they carry a provider URL.
  if (interaction.interactionType !== 'tool'
    && !(interaction.semanticOnly === true && interaction.toolCalls.length > 0)) return undefined;
  const endpoint = text(interaction.endpoint, 1_000);
  if (!endpoint || endpoint === 'unknown') return undefined;
  try {
    const parsed = new URL(endpoint.includes('://') ? endpoint : `http://${endpoint}`);
    return NETWORK_ENDPOINT_PROTOCOLS.has(parsed.protocol) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function interactionEndpointHost(interaction: T.AgentInteractionRecord): string | undefined {
  return parsedInteractionEndpoint(interaction)?.hostname.toLowerCase();
}

function interactionEndpointPort(interaction: T.AgentInteractionRecord): number | undefined {
  const parsed = parsedInteractionEndpoint(interaction);
  if (!parsed) return undefined;
  const explicit = Number(parsed.port);
  if (Number.isSafeInteger(explicit) && explicit > 0 && explicit <= 65_535) return explicit;
  // Host headers commonly omit :443/:80. TLS plaintext / uprobe captures still need the
  // transport port so a logical service name (tool-mock) can fall back to a unique same-runtime
  // Egress fact when DNS/SNI did not preserve the hostname on the Kernel row.
  const capture = String(interaction.captureSource ?? '').toLowerCase();
  const transport = String(interaction.transport ?? interaction.protocol ?? '').toLowerCase();
  if (
    parsed.protocol === 'https:'
    || parsed.protocol === 'wss:'
    || parsed.protocol === 'tls:'
    || capture.includes('tls')
    || transport === 'tls'
    || transport.includes('tls')
  ) {
    return 443;
  }
  if (parsed.protocol === 'http:' || parsed.protocol === 'ws:') return 80;
  return undefined;
}

function kernelEventAtMs(relation: T.AgentSemanticKernelRelation): number {
  const at = text(relation.kernelEventAt, 128);
  if (!at) return Number.NaN;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/u.test(at)
    ? `${at.replace(' ', 'T')}Z`
    : at;
  return Date.parse(normalized);
}

/** When several same-port ClusterIP Egress facts compete for a Host-only Tool endpoint, keep the
 * uniquely nearest Kernel event instead of marking every competitor ambiguous. */
function preferUniqueNearestNetworkEndpoint(
  callAtMs: number,
  relations: T.AgentSemanticKernelRelation[],
): T.AgentSemanticKernelRelation[] {
  if (relations.length <= 1) return relations;
  if (!relations.every((relation) => relation.linkMethod === 'network_endpoint')) return relations;
  if (!Number.isFinite(callAtMs)) return relations;
  const ranked = relations
    .map((relation) => {
      const at = kernelEventAtMs(relation);
      return {
        relation,
        distance: Number.isFinite(at) ? Math.abs(at - callAtMs) : Number.POSITIVE_INFINITY,
      };
    })
    .sort((left, right) => left.distance - right.distance
      || (left.relation.kernelEventId ?? '').localeCompare(right.relation.kernelEventId ?? ''));
  const best = ranked[0];
  const second = ranked[1];
  if (!best || best.distance === Number.POSITIVE_INFINITY) return relations;
  if (second && second.distance === best.distance) return relations;
  return [best.relation];
}

/** Custom-tool lineage fallbacks can see many same-runtime helper execs (healthchecks). Keep the
 * uniquely nearest ToolExec to the ToolCall instant when every candidate is process_lineage. */
function preferUniqueNearestProcessLineage(
  callAtMs: number,
  relations: T.AgentSemanticKernelRelation[],
): T.AgentSemanticKernelRelation[] {
  if (relations.length <= 1) return relations;
  if (!relations.every((relation) => relation.linkMethod === 'process_lineage')) return relations;
  if (!Number.isFinite(callAtMs)) return relations;
  const ranked = relations
    .map((relation) => {
      const at = kernelEventAtMs(relation);
      return {
        relation,
        distance: Number.isFinite(at) ? Math.abs(at - callAtMs) : Number.POSITIVE_INFINITY,
      };
    })
    .sort((left, right) => left.distance - right.distance
      || (left.relation.kernelEventId ?? '').localeCompare(right.relation.kernelEventId ?? ''));
  const best = ranked[0];
  const second = ranked[1];
  if (!best || best.distance === Number.POSITIVE_INFINITY) return relations;
  if (second && second.distance === best.distance) return relations;
  return [best.relation];
}

function candidatePort(event: T.AgentEventListItem): number | undefined {
  for (const value of [
    event.attributes.port,
    event.attributes.serverPort,
    event.attributes.destinationPort,
  ]) {
    const port = Number(value);
    if (Number.isSafeInteger(port) && port > 0 && port <= 65_535) return port;
  }
  const port = Number(event.subject.match(/:(\d{1,5})(?:\s|$)/u)?.[1]);
  return Number.isSafeInteger(port) && port > 0 && port <= 65_535 ? port : undefined;
}

function candidatePath(event: T.AgentEventListItem): string | undefined {
  return text(event.attributes.path, 4_096)
    ?? text(event.attributes.filePath, 4_096)
    ?? text(event.attributes.resourcePath, 4_096)
    ?? text(event.subject.match(/(?:^|\s)(\/[^\s]+)/u)?.[1], 4_096);
}

function candidateHost(event: T.AgentEventListItem): string | undefined {
  const dnsQuery = event.eventKind === 'Dns'
    ? text(event.attributes.query, 512) ?? text(event.attributes['dns.question.name'], 512)
    : undefined;
  return (dnsQuery ?? text(event.attributes.host, 512))?.replace(/\.$/u, '').toLowerCase()
    ?? text(event.attributes.serverAddress, 512)?.toLowerCase()
    ?? text(event.attributes['server.address'], 512)?.toLowerCase()
    ?? text(event.attributes.peer, 512)?.toLowerCase()
    ?? text(event.attributes['network.peer.address'], 512)?.toLowerCase()
    ?? text(event.attributes.sni, 512)?.replace(/\.$/u, '').toLowerCase()
    ?? text(event.attributes.hostname, 512)?.toLowerCase();
}

function sameRuntime(
  interaction: T.AgentInteractionRecord,
  candidate: T.AgentEventListItem,
): boolean {
  if (!interaction.agentInstanceId || !candidate.agentRuntimeInstanceId) return false;
  const requested = interaction.agentInstanceId;
  const candidates = [
    candidate.agentRuntimeInstanceId,
    ...(candidate.agentRuntimeInstanceAliases ?? []),
  ];
  return candidates.some((value) => agentRuntimeInstanceIdsEquivalent(requested, value));
}

type RuntimeLink =
  | 'direct_runtime'
  | 'generation_parent'
  | 'legacy_pid_parent'
  | 'delegated_runtime';

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

function sandboxTool(event: T.AgentSemanticEvent): boolean {
  const normalized = [event.toolKind, event.toolName]
    .filter((value): value is string => Boolean(value))
    .join(' ')
    .toLowerCase();
  if (SANDBOX_TOOL_PATTERN.test(normalized)) return true;
  const endpoint = toolHost(event)
    ?? (typeof event.content === 'string' ? text(event.content, 512) : nestedString(event.content, ['endpoint', 'url']));
  return Boolean(endpoint && /sandbox/iu.test(endpoint));
}

function sandboxRunnerExec(candidate: T.AgentEventListItem): boolean {
  if (candidate.eventKind !== 'ToolExec') return false;
  const command = candidateCommand(candidate) ?? '';
  return SANDBOX_RUNNER_PATTERN.test(command);
}

/**
 * Cross-Pod HTTP sandboxes do not share process generation with the calling Agent. Require a
 * same-runtime network witness for the tool endpoint plus a uniquely nearest runner.py ToolExec
 * in-window before accepting ownership without direct runtime equivalence.
 */
function delegatedSandboxRuntime(
  input: SemanticKernelRelationInput,
  candidate: T.AgentEventListItem,
  allCandidates: readonly T.AgentEventListItem[],
): boolean {
  if (!sandboxTool(input.event) || !sandboxRunnerExec(candidate)) return false;
  const host = toolHost(input.event) ?? interactionEndpointHost(input.interaction);
  const endpointPort = interactionEndpointPort(input.interaction);
  const hasNetworkWitness = allCandidates.some((event) => {
    if (!['Egress', 'Dns', 'Tls'].includes(event.eventKind)) return false;
    if (!sameRuntime(input.interaction, event)) return false;
    if (!withinWindow(input.event, input.result, event)) return false;
    const observed = candidateHost(event);
    const hostMatches = Boolean(
      host && observed && (observed === host || observed.endsWith('.' + host) || host.endsWith('.' + observed)),
    );
    const portMatches = endpointPort !== undefined
      && event.eventKind === 'Egress'
      && candidatePort(event) === endpointPort;
    return hostMatches || portMatches;
  });
  if (!hasNetworkWitness) return false;
  const callAt = unixNsToMs(input.event.atUnixNs);
  if (!Number.isFinite(callAt)) return false;
  const runners = allCandidates
    .filter((event) => sandboxRunnerExec(event) && withinWindow(input.event, input.result, event))
    .map((event) => ({ event, distance: Math.abs(candidateEventAtMs(event) - callAt) }))
    .filter((entry) => Number.isFinite(entry.distance))
    .sort((left, right) => left.distance - right.distance || left.event.eventId.localeCompare(right.event.eventId));
  if (runners.length === 0) return false;
  if (runners.length > 1 && runners[0]!.distance === runners[1]!.distance) return false;
  return runners[0]!.event.eventId === candidate.eventId;
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
  const at = candidateEventAtMs(candidate);
  return Number.isFinite(start) && Number.isFinite(at)
    && at >= start - CLOCK_SKEW_MS
    && at <= end + CLOCK_SKEW_MS;
}

/**
 * Generic custom / undeclared tools often lack HTTP routes and argv-shaped arguments. Attribute a
 * ToolExec that is a direct child of the Agent root (or any same-runtime ToolExec when rootPid is
 * unavailable) inside the ToolCall→ToolResult window. Batch arbitration keeps this as a unique
 * fallback only — never when a stronger content match exists.
 */
function processLineageCandidate(
  input: SemanticKernelRelationInput,
  candidate: T.AgentEventListItem,
): boolean {
  if (!input.result || candidate.eventKind !== 'ToolExec') return false;
  const normalizedTool = [input.event.toolKind, input.event.toolName]
    .filter((value): value is string => Boolean(value))
    .join(' ')
    .toLowerCase() || 'other';
  if (SHELL_TOOL_PATTERN.test(normalizedTool) && toolCommand(input.event)) return false;
  if (FILE_TOOL_PATTERN.test(normalizedTool) && toolResource(input.event)) return false;
  if (NETWORK_TOOL_PATTERN.test(normalizedTool)) return false;
  if (sandboxTool(input.event)) return false;
  const rootPid = candidate.attribution?.rootPid;
  const ppid = candidate.process?.ppid;
  if (Number.isSafeInteger(rootPid) && Number.isSafeInteger(ppid) && ppid !== rootPid) {
    return false;
  }
  const callAt = unixNsToMs(input.event.atUnixNs);
  const resultAt = unixNsToMs(input.result.atUnixNs);
  const candidateAt = candidateEventAtMs(candidate);
  return Number.isFinite(callAt)
    && Number.isFinite(resultAt)
    && Number.isFinite(candidateAt)
    && candidateAt >= callAt - CLOCK_SKEW_MS
    && candidateAt <= resultAt + CLOCK_SKEW_MS;
}

function shellBootstrapCandidate(
  input: SemanticKernelRelationInput,
  candidate: T.AgentEventListItem,
): boolean {
  const normalizedTool = (input.event.toolKind ?? input.event.toolName ?? '').toLowerCase();
  if (!input.result || !SHELL_TOOL_PATTERN.test(normalizedTool)) return false;
  if (candidate.eventKind !== 'ToolExec') return false;
  const shell = (candidate.process?.comm ?? '').toLowerCase();
  if (!['bash', 'sh', 'dash', 'zsh', 'fish'].includes(shell)) return false;
  const rootPid = candidate.attribution?.rootPid;
  if (!Number.isSafeInteger(rootPid) || candidate.process?.ppid !== rootPid) return false;
  const callAt = unixNsToMs(input.event.atUnixNs);
  const resultAt = unixNsToMs(input.result.atUnixNs);
  const candidateAt = candidateEventAtMs(candidate);
  return Number.isFinite(callAt)
    && Number.isFinite(resultAt)
    && Number.isFinite(candidateAt)
    && candidateAt >= callAt - CLOCK_SKEW_MS
    && candidateAt <= resultAt + CLOCK_SKEW_MS;
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

function semanticRelationAuthority(
  interaction: T.AgentInteractionRecord,
): T.AgentSemanticKernelRelation['authority'] {
  if (interaction.semanticOnly === true
    || interaction.captureSource === 'authenticated_application_event'
    || interaction.protocol === 'application-semantic') {
    return 'authenticated_adapter';
  }
  return 'attested_tls_plaintext';
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
  allCandidates: readonly T.AgentEventListItem[] = [],
): T.AgentSemanticKernelRelation | undefined {
  const { event, result, interaction } = input;
  const invocationId = toolInvocationId(event, interaction);
  const command = toolCommand(event);
  const resource = toolResource(event);
  const marker = toolMarker(event);
  const host = toolHost(event) ?? interactionEndpointHost(interaction);
  const endpointPort = interactionEndpointPort(interaction);
  const normalizedTool = [event.toolKind, event.toolName]
    .filter((value): value is string => Boolean(value))
    .join(' ')
    .toLowerCase() || 'other';
  const acceptedKinds = SHELL_TOOL_PATTERN.test(normalizedTool)
    ? new Set(['ToolExec'])
    : FILE_TOOL_PATTERN.test(normalizedTool)
      ? new Set(['FileAccess', 'FileDelete'])
      : NETWORK_TOOL_PATTERN.test(normalizedTool)
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
    const expected = normalizedCommand(command, interaction);
    const observedCommand = candidateCommand(candidate);
    const observed = observedCommand ? normalizedCommand(observedCommand, interaction) : '';
    if (expected && observed && (
      expected === observed || observed.includes(expected) || expected.includes(observed)
    )) {
      linkMethod = 'command';
      confidence = expected === observed
        ? 1
        : observed.includes(expected)
          ? 0.98
          : 0.85;
    }
  }
  // Undeclared custom tools often only publish an opaque marker; treat argv/subject containment as
  // a content match so healthcheck noise cannot win process_lineage uniqueness.
  if (!linkMethod && marker && candidate.eventKind === 'ToolExec') {
    const observed = candidateCommand(candidate) ?? '';
    if (observed.includes(marker)) {
      linkMethod = 'command';
      confidence = 0.96;
    }
  }
  if (!linkMethod && sandboxTool(event) && sandboxRunnerExec(candidate)) {
    // Semantic sandbox tools publish code/endpoint, not the remote runner argv. Bind the fixed
    // runner.py exec when delegated runtime evidence is available below.
    linkMethod = 'command';
    confidence = 0.92;
  }
  if (!linkMethod && resource && ['FileAccess', 'FileDelete'].includes(candidate.eventKind)) {
    const expected = resource.replace(/\/+/gu, '/').replace(/\/$/u, '') || resource;
    const observed = candidatePath(candidate)?.replace(/\/+/gu, '/').replace(/\/$/u, '');
    if (observed) {
      if (observed === expected) {
        linkMethod = 'resource';
        confidence = 1;
      } else if (!expected.startsWith('/') && observed.endsWith('/' + expected)) {
        // Agents often pass workspace-relative paths while Observer records the absolute path.
        linkMethod = 'resource';
        confidence = 0.98;
      }
    }
  }
  if (!linkMethod && host && ['Egress', 'Dns', 'Tls'].includes(candidate.eventKind)) {
    const observed = candidateHost(candidate);
    const hostMatches = Boolean(observed && (observed === host || observed.endsWith('.' + host) || host.endsWith('.' + observed)));
    // A logical endpoint with an explicit port must not claim a same-host connection on a
    // different port.  ClusterIP/service-name differences may still use the bounded
    // endpoint-port fallback below when the host itself is not equal.
    const portMatches = endpointPort === undefined
      || candidate.eventKind !== 'Egress'
      || candidatePort(candidate) === endpointPort;
    if (hostMatches && portMatches) {
      linkMethod = 'network';
      confidence = 0.98;
    }
  }
  if (!linkMethod && endpointPort && candidate.eventKind === 'Egress'
    && candidatePort(candidate) === endpointPort) {
    // Kubernetes/service-mesh Egress observes a resolved ClusterIP while HTTP preserves the
    // logical service name. Exact endpoint port plus Runtime and unique-candidate arbitration is
    // the strongest transport fact available without depending on cluster DNS configuration.
    linkMethod = 'network_endpoint';
    confidence = 0.95;
  }
  if (!linkMethod && command && shellBootstrapCandidate(input, candidate)) {
    // Some Agent shells receive the actual command over stdin after an exec-time environment
    // snapshot. Builtins therefore have no second execve containing the semantic command. Admit
    // only the exact direct-child shell here; the batch resolver below requires it to be the sole
    // fallback candidate for this Tool invocation.
    linkMethod = 'shell_bootstrap';
    confidence = 0.95;
  }
  if (!linkMethod && processLineageCandidate(input, candidate)) {
    // Undeclared / custom tools: no HTTP route and no cmd/path/url argument to match. Attribute
    // the unique same-runtime ToolExec that is a direct Agent-root child in the call→result window.
    linkMethod = 'process_lineage';
    confidence = 0.9;
  }
  if (!linkMethod) return undefined;

  let runtimeLink = runtimeMatch(interaction, candidate, index);
  if (!runtimeLink && delegatedSandboxRuntime(input, candidate, allCandidates)) {
    runtimeLink = 'delegated_runtime';
  }
  if (!runtimeLink) return undefined;
  if (runtimeLink === 'generation_parent') confidence = Math.min(confidence, 0.99);
  if (runtimeLink === 'legacy_pid_parent') confidence = Math.min(confidence, 0.75);
  if (runtimeLink === 'delegated_runtime') confidence = Math.min(confidence, 0.9);
  const canonicalLink = createEvidenceLink({
    fromType: 'tool_call',
    fromId: invocationId,
    // KernelFact is the only durable target identity available here.  Event kind still selects
    // the relation (`file_effect`/`network_effect`), but an `evt_*` or `kf_*` value must not be
    // mislabeled as a File/Network entity until those entity IDs have their own contracts.
    toType: 'kernel_fact',
    toId: candidate.kernelFactId ?? candidate.eventId,
    relation: candidate.eventKind === 'ToolExec' ? 'executes_as'
      : candidate.eventKind === 'FileAccess' || candidate.eventKind === 'FileDelete' ? 'file_effect'
        : 'network_effect',
    method: linkMethod === 'network_endpoint'
      ? 'network'
      : linkMethod === 'shell_bootstrap' || linkMethod === 'process_lineage'
        ? 'process_generation'
        : linkMethod,
    confidence,
    // The Observer attests the underlying event, but this edge is still a server-side content /
    // lineage match. Keep the canonical EvidenceLink authority inferred; the legacy relation's
    // `attested_tls_plaintext` field separately records that the semantic ToolCall came from
    // captured plaintext.
    authority: 'inferred',
    evidenceRefs: [
      interaction.rawObservationId,
      ...(interaction.sourceObservationIds ?? []),
      candidate.rawObservationId,
      candidate.eventId,
    ].filter((value): value is string => Boolean(value)),
    algorithmVersion: `semantic-kernel-relation.v${AGENT_SEMANTIC_KERNEL_RELATION_VERSION}`,
    status: confidence === 1 ? 'confirmed' : 'strong',
    // Kernel event timestamps are ISO strings in the legacy read model; use the semantic event
    // timestamp as the canonical Unix-ns validity anchor and retain the legacy value separately.
    validFromUnixNs: event.atUnixNs,
    resolutionRevision,
  });
  return {
    schemaVersion: 'anysentry.agent_semantic_kernel_relation.v1',
    relationId: stableId('skr', event.semanticEventId + '\u0000' + candidate.eventId),
    stableSemanticEventId: event.semanticEventId,
    conversationId: event.conversationId,
    turnId: event.turnId,
    toolInvocationId: invocationId,
    kernelEventId: candidate.eventId,
    ...(candidate.kernelFactId ? { kernelFactId: candidate.kernelFactId } : {}),
    kernelEventAt: candidate.at,
    kernelEventKind: candidate.eventKind,
    ...(candidate.decisionRevision !== undefined
      ? { kernelEventDecisionRevision: candidate.decisionRevision }
      : {}),
    status: confidence === 1 ? 'linked_exact' : 'linked_strong',
    linkMethod,
    lineageMethod: runtimeLink,
    timeQuality: result ? 'exact' : 'bounded',
    confidence,
    authority: semanticRelationAuthority(input.interaction),
    relationVersion: AGENT_SEMANTIC_KERNEL_RELATION_VERSION,
    resolutionRevision,
    evidenceLinkId: canonicalLink.linkId,
    algorithmVersion: canonicalLink.algorithmVersion,
    sourceRefs: canonicalLink.evidenceRefs,
    validFromUnixNs: canonicalLink.validFromUnixNs,
    relationRevision: resolutionRevision,
    risk: risk(candidate),
  };
}

function unlinkedRelation(
  input: SemanticKernelRelationInput,
  resolutionRevision: number,
  coveragePartial: boolean,
): T.AgentSemanticKernelRelation {
  const invocationId = toolInvocationId(input.event, input.interaction);
  // Keep the unresolved relation on the exact same canonical-link identity path as linked and
  // ambiguous relations.  The previous `supports`/source-only link differed from
  // `canonicalEvidenceLinkForRelation`'s `executes_as`/semantic-id link, so a late re-projection
  // could leave an older unmatched EvidenceLink as the only durable row even though the latest
  // relation revision had been computed.  The unresolved edge is still explicit and has zero
  // confidence; this only makes its revision and bidirectional locator stable.
  const canonicalLink = createEvidenceLink({
    fromType: 'tool_call',
    fromId: invocationId,
    toType: 'kernel_fact',
    toId: `unmatched:${input.event.semanticEventId}`,
    relation: 'executes_as',
    method: 'none',
    confidence: 0,
    authority: 'inferred',
    evidenceRefs: [
      ...(input.interaction.sourceObservationIds ?? []),
      input.event.semanticEventId,
    ],
    algorithmVersion: `semantic-kernel-relation.v${AGENT_SEMANTIC_KERNEL_RELATION_VERSION}`,
    status: coveragePartial ? 'coverage_gap' : 'unmatched',
    validFromUnixNs: input.interaction.startedAtUnixNs,
    resolutionRevision,
  });
  return {
    schemaVersion: 'anysentry.agent_semantic_kernel_relation.v1',
    relationId: stableId('skr', input.event.semanticEventId + '\u0000unlinked'),
    stableSemanticEventId: input.event.semanticEventId,
    conversationId: input.event.conversationId,
    turnId: input.event.turnId,
    toolInvocationId: invocationId,
    status: coveragePartial ? 'coverage_gap' : 'semantic_only',
    confidence: 0,
    authority: semanticRelationAuthority(input.interaction),
    relationVersion: AGENT_SEMANTIC_KERNEL_RELATION_VERSION,
    resolutionRevision,
    evidenceLinkId: canonicalLink.linkId,
    algorithmVersion: canonicalLink.algorithmVersion,
    sourceRefs: canonicalLink.evidenceRefs,
    validFromUnixNs: canonicalLink.validFromUnixNs,
    relationRevision: resolutionRevision,
  };
}

function sortRelations(relations: T.AgentSemanticKernelRelation[]): T.AgentSemanticKernelRelation[] {
  return relations.sort((left, right) =>
    (right.risk?.riskScore ?? 0) - (left.risk?.riskScore ?? 0)
    || (right.confidence - left.confidence)
    || (left.kernelEventId ?? '').localeCompare(right.kernelEventId ?? ''));
}

function canonicalLinkForRelation(
  relation: T.AgentSemanticKernelRelation,
  status: 'ambiguous' | 'unmatched' | 'coverage_gap',
  competingRefs: string[] = [],
) {
  const toType: 'kernel_fact' = 'kernel_fact';
  const method = relation.linkMethod === 'network_endpoint'
    ? 'network' as const
    : relation.linkMethod === 'shell_bootstrap' || relation.linkMethod === 'process_lineage'
      ? 'process_generation' as const
      : relation.linkMethod === 'command' || relation.linkMethod === 'resource'
        ? relation.linkMethod
        : 'none' as const;
  return createEvidenceLink({
    fromType: 'tool_call',
    fromId: relation.toolInvocationId,
    toType,
    toId: relation.kernelFactId ?? relation.kernelEventId ?? `unmatched:${relation.stableSemanticEventId}`,
    relation: relation.kernelEventKind === 'FileAccess' || relation.kernelEventKind === 'FileDelete'
      ? 'file_effect'
      : relation.kernelEventKind === 'Egress' || relation.kernelEventKind === 'Dns' || relation.kernelEventKind === 'Tls'
        ? 'network_effect' : 'supports',
    method,
    confidence: 0,
    authority: 'inferred',
    evidenceRefs: [...(relation.sourceRefs ?? []), ...competingRefs],
    algorithmVersion: relation.algorithmVersion ?? `semantic-kernel-relation.v${AGENT_SEMANTIC_KERNEL_RELATION_VERSION}`,
    status,
    // Keep the canonical timestamp contract valid even for old relation rows that predate
    // `validFromUnixNs`; the epoch fallback is explicit coverage metadata, not event time.
    validFromUnixNs: relation.validFromUnixNs ?? '1000000000',
    resolutionRevision: relation.relationRevision ?? relation.resolutionRevision,
  });
}

/** Public projection helper shared by ingest-time and API readers.  It is intentionally
 * product-neutral: the relation already carries the normalized Kernel event kind/method. */
export function canonicalEvidenceLinkForRelation(
  relation: T.AgentSemanticKernelRelation,
): EvidenceLink {
  const toType: EvidenceLink['toType'] = 'kernel_fact';
  const method: EvidenceLink['method'] = relation.linkMethod === 'network_endpoint'
    ? 'network'
    : relation.linkMethod === 'shell_bootstrap' || relation.linkMethod === 'process_lineage'
      ? 'process_generation'
      : relation.linkMethod === 'command' || relation.linkMethod === 'resource'
        ? relation.linkMethod : 'none';
  const status: EvidenceLink['status'] = relation.status === 'linked_exact'
    ? 'confirmed'
    : relation.status === 'linked_strong' ? 'strong'
      : relation.status === 'ambiguous' ? 'ambiguous'
        : relation.status === 'coverage_gap' ? 'coverage_gap' : 'unmatched';
  return createEvidenceLink({
    fromType: 'tool_call',
    fromId: relation.toolInvocationId,
    toType,
    toId: relation.kernelFactId ?? relation.kernelEventId ?? `unmatched:${relation.stableSemanticEventId}`,
    relation: relation.kernelEventKind === 'FileAccess' || relation.kernelEventKind === 'FileDelete'
      ? 'file_effect'
      : relation.kernelEventKind === 'Egress' || relation.kernelEventKind === 'Dns' || relation.kernelEventKind === 'Tls'
        ? 'network_effect' : 'executes_as',
    method,
    confidence: status === 'confirmed' ? 1 : status === 'strong' ? relation.confidence : 0,
    authority: 'inferred',
    evidenceRefs: [...(relation.sourceRefs ?? []), relation.stableSemanticEventId],
    algorithmVersion: relation.algorithmVersion ?? `semantic-kernel-relation.v${relation.relationVersion}`,
    status,
    validFromUnixNs: relation.validFromUnixNs ?? '1000000000',
    resolutionRevision: relation.relationRevision ?? relation.resolutionRevision,
  });
}

export function canonicalEvidenceLinksForRelations(
  relations: readonly T.AgentSemanticKernelRelation[],
): EvidenceLink[] {
  return relations.map(canonicalEvidenceLinkForRelation);
}

export function buildSemanticKernelRelationBatch(
  inputs: SemanticKernelRelationInput[],
  candidates: T.AgentEventListItem[],
  resolutionRevision: number,
  coveragePartial = false,
): SemanticKernelRelationBatchResult {
  const boundedInputs = inputs.slice(0, 1_000);
  const index = buildCandidateIndex(candidates);
  // Keep every highest-scoring candidate for a semantic ToolCall.  Older code discarded ties and
  // returned a synthetic `semantic_only` row, which hid the very Kernel facts an operator needs to
  // review.  The canonical contract requires competing candidates to remain explicit and
  // ambiguous; ownership arbitration below only marks them, never deletes them.
  const potentialBySemantic = new Map<string, T.AgentSemanticKernelRelation[]>();
  const ownersByKernel = new Map<string, Set<string>>();
  const invocationBySemantic = new Map<string, string>();

  for (const input of boundedInputs) {
    const semanticId = input.event.semanticEventId;
    invocationBySemantic.set(semanticId, toolInvocationId(input.event, input.interaction));
    const potential = candidates
      .map((candidate) => potentialRelation(input, candidate, index, resolutionRevision, candidates))
      .filter((relation): relation is T.AgentSemanticKernelRelation => Boolean(relation));
    const contentRelations = potential.filter((relation) =>
      !['shell_bootstrap', 'network_endpoint', 'process_lineage'].includes(relation.linkMethod ?? ''));
    const boundedFallbacks = potential.filter((relation) =>
      ['shell_bootstrap', 'network_endpoint', 'process_lineage'].includes(relation.linkMethod ?? ''));
    const strongestContentConfidence = contentRelations.reduce(
      (highest, relation) => Math.max(highest, relation.confidence),
      0,
    );
    const strongestContent = contentRelations.filter((relation) =>
      relation.confidence === strongestContentConfidence);
    const strongestFallbackConfidence = boundedFallbacks.reduce(
      (highest, relation) => Math.max(highest, relation.confidence),
      0,
    );
    const strongestFallbacks = boundedFallbacks.filter((relation) =>
      relation.confidence === strongestFallbackConfidence);
    const relations = contentRelations.length > 0
      // One semantic Tool action has one primary Kernel owner. A complete command match outranks
      // descendant subcommands; equal-strength candidates are retained and marked ambiguous in
      // the result projection rather than being silently replaced by a no-kernel row.
      ? strongestContent
      : preferUniqueNearestProcessLineage(
        semanticEventAtMs(input.event),
        preferUniqueNearestNetworkEndpoint(semanticEventAtMs(input.event), strongestFallbacks),
      );
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
    const candidatesForSemantic = potentialBySemantic.get(semanticId) ?? [];
    const resolved = candidatesForSemantic.map((relation) => {
      const owners = relation.kernelEventId
        ? ownersByKernel.get(relation.kernelEventId) ?? new Set<string>()
        : new Set<string>();
      const localCompetition = candidatesForSemantic.length > 1;
      if (owners.size <= 1 && !localCompetition) return relation;
      const competingKernelEventIds = [
        ...new Set(candidatesForSemantic
          .map((candidate) => candidate.kernelEventId)
          .filter((value): value is string => Boolean(value))),
      ].sort();
      return {
        ...relation,
        status: 'ambiguous' as const,
        confidence: 0,
        risk: undefined,
        competingToolInvocationIds: [...owners]
          .map((owner) => invocationBySemantic.get(owner))
          .filter((value): value is string => Boolean(value))
          .sort(),
        ...(competingKernelEventIds.length > 0 ? { competingKernelEventIds } : {}),
        ...(() => {
          const link = canonicalLinkForRelation(
            relation,
            'ambiguous',
            [
              ...[...owners]
                .map((owner) => invocationBySemantic.get(owner))
                .filter((value): value is string => Boolean(value)),
              ...competingKernelEventIds,
            ],
          );
          return {
            evidenceLinkId: link.linkId,
            algorithmVersion: link.algorithmVersion,
            sourceRefs: link.evidenceRefs,
            validFromUnixNs: link.validFromUnixNs,
          };
        })(),
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
