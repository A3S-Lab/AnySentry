import { createHash } from 'node:crypto';
import type * as T from './types';
import { detectedAgentIdentity } from './agent-identity';
import {
  deriveAgentInstanceIdentity,
  deriveConnectionIdentity,
  deriveProcessGenerationKey,
  canonicalSessionIdForMembership,
  resolveLogicalAgentDefinition,
  resolveSessionIdentity,
} from './canonical-observability';
import { applyAgentAdapter } from './agent-adapter-execution';
import { serverTrustedCorrelationContext } from './trusted-correlation';
import { captureClassificationDecision } from './identity-judgment-routing';

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_LINE_BYTES = 14 * 1024 * 1024;
const MAX_DERIVED_JSON_BYTES = 512 * 1024;
const MAX_TOOL_ITEMS = 2_048;
const MAX_MESSAGES = 4_096;
const MAX_SEMANTIC_ITEMS = 4_096;
const MAX_CONVERSATION_ANCHORS = 512;
const COMPLETENESS = new Set<T.AgentInteractionCompleteness>([
  'complete', 'partial', 'truncated', 'redacted', 'reference_only', 'unavailable', 'unsupported',
]);
const PARSE_STATES = new Set<NonNullable<T.AgentInteractionRecord['parseState']>>([
  'parsed', 'partial', 'unparsed', 'ambiguous',
]);
const LLM_LIKELIHOODS = new Set<NonNullable<T.AgentInteractionRecord['llmLikelihood']>>([
  'confirmed', 'likely', 'unknown', 'unlikely',
]);
const TRANSPORT_COMPLETENESS = new Set<NonNullable<T.AgentInteractionRecord['transportCompleteness']>>([
  'complete', 'partial',
]);
const WIRE_COMPLETENESS = new Set<NonNullable<T.AgentInteractionRecord['wireCompleteness']>>([
  'complete', 'error', 'unknown', 'partial',
]);
const CONVERSATION_COMPLETENESS = new Set<NonNullable<T.AgentInteractionRecord['conversationCompleteness']>>([
  'complete', 'tool_pending', 'response_pending', 'partial',
]);
const SEMANTIC_ACTORS = new Set<T.AgentInteractionSemanticActor>(['user', 'model', 'tool']);
const SEMANTIC_KINDS = new Set<T.AgentInteractionSemanticKind>([
  'user_message', 'model_progress', 'model_final', 'tool_call', 'tool_result',
]);
const SEMANTIC_PHASES = new Set<NonNullable<T.AgentInteractionSemanticItem['phase']>>([
  'progress', 'final',
]);
const SEMANTIC_ORIGINS = new Set<T.AgentInteractionSemanticItem['origin']>([
  'request', 'response',
]);
const SEMANTIC_COMPLETENESS = new Set<T.AgentInteractionSemanticItem['completeness']>([
  'complete', 'partial', 'missing',
]);
const MESSAGE_ORIGINS = new Set<NonNullable<T.AgentInteractionMessage['messageOrigin']>>([
  'human_input', 'agent_context', 'developer_instruction', 'assistant_history', 'tool_history',
]);
const TRAFFIC_ROLES = new Set<NonNullable<T.AgentInteractionRecord['trafficRole']>>([
  'conversation', 'bootstrap', 'control', 'context_replay', 'tool_backend',
  'derived_metadata', 'retry', 'background', 'delegation', 'unclassified',
]);
const ANCHOR_KINDS = new Set<T.AgentConversationAnchorKind>([
  'provider_conversation', 'response_id', 'previous_response_id', 'continuity_key',
  'message_item_id', 'turn_id', 'tool_call_id',
]);
const ANCHOR_STRENGTHS = new Set<T.AgentConversationAnchor['strength']>([
  'exact', 'strong', 'supporting',
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function string(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > max || /[\u0000]/u.test(normalized)) return undefined;
  return normalized;
}

/** Keep endpoint metadata useful for correlation without persisting URL authority credentials or
 * query/fragment parameters.  This boundary is shared by Observer-decoded interactions, so a
 * legacy LlmInteraction line cannot bypass the OTLP/controller sanitizer. */
function sanitizeEndpoint(value: string): string {
  const input = value.trim().replace(/[\u0000-\u001f\u007f"'`,;]/gu, '').slice(0, 1_000);
  const withoutQuery = input.split(/[?#]/u)[0];
  const explicitScheme = /^[a-z][a-z0-9+.-]*:\/\//iu.test(withoutQuery);
  try {
    const parsed = new URL(explicitScheme ? withoutQuery : `http://${withoutQuery}`);
    const host = parsed.hostname.trim();
    if (!host) return withoutQuery.slice(0, 1_000);
    const authority = withoutQuery.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/iu)?.[1] ?? '';
    const authorityWithoutUser = authority.slice(authority.lastIndexOf('@') + 1);
    const explicitPort = authorityWithoutUser.match(/:(\d{1,5})$/u)?.[1];
    const portNumber = Number(parsed.port || explicitPort || '');
    const port = Number.isInteger(portNumber) && portNumber > 0 && portNumber <= 65_535
      ? String(portNumber) : '';
    const pathname = parsed.pathname && parsed.pathname !== '/'
      ? parsed.pathname.slice(0, 240)
      : parsed.pathname === '/' ? '/' : '';
    const protocol = explicitScheme ? parsed.protocol.replace(/:$/u, '') : '';
    return `${protocol ? `${protocol}://` : ''}${host}${port ? `:${port}` : ''}${pathname}`.slice(0, 1_000);
  } catch {
    const scheme = withoutQuery.match(/^([a-z][a-z0-9+.-]*:\/\/)(.*)$/iu);
    const prefix = scheme?.[1] ?? '';
    const rest = scheme?.[2] ?? withoutQuery;
    const slash = rest.indexOf('/');
    const authority = slash >= 0 ? rest.slice(0, slash) : rest;
    const path = slash >= 0 ? rest.slice(slash) : '';
    return `${prefix}${authority.slice(authority.lastIndexOf('@') + 1)}${path}`.slice(0, 1_000);
  }
}

function sanitizePath(value: string): string {
  return value.replace(/[?#].*$/u, '').slice(0, 2_000);
}

/**
 * Produce a bounded protocol route shape for grouping generic HTTP Agent requests. Dynamic
 * identifiers are replaced without depending on a framework, service name, tool name, or port;
 * the raw sanitized path remains the evidence of record.
 */
export function normalizeAgentRouteShape(value: string): string {
  const path = sanitizePath(value).trim();
  if (!path) return '';
  const segments = path.split('/').filter(Boolean).map((segment) => {
    let decoded = segment;
    try { decoded = decodeURIComponent(segment); } catch { /* preserve malformed evidence */ }
    if (
      /^\d{1,32}$/u.test(decoded)
      || /^[a-f0-9]{16,}$/iu.test(decoded)
      || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/iu.test(decoded)
      || /^(?:run|thread|session|request|trace|span)[-_][a-z0-9_-]{6,}$/iu.test(decoded)
    ) return ':param';
    return decoded.slice(0, 120);
  });
  return `/${segments.join('/')}`.slice(0, 512) || '/';
}

function strictRunIdentity(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(normalized)
    ? normalized : undefined;
}

function exactString(value: unknown, maxBytes: number): string | undefined {
  if (typeof value !== 'string' || Buffer.byteLength(value) > maxBytes) return undefined;
  return value;
}

function integer(value: unknown, min: number, max: number): number | undefined {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) return undefined;
  return number;
}

function unixNs(value: unknown): string | undefined {
  const text = string(value, 40);
  return text && /^\d{1,40}$/u.test(text) ? text : undefined;
}

function completeness(value: unknown): T.AgentInteractionCompleteness {
  return typeof value === 'string' && COMPLETENESS.has(value as T.AgentInteractionCompleteness)
    ? value as T.AgentInteractionCompleteness
    : 'partial';
}

function closedValue<TValue extends string>(value: unknown, allowed: Set<TValue>): TValue | undefined {
  return typeof value === 'string' && allowed.has(value as TValue) ? value as TValue : undefined;
}

function interactionSessionQuality(
  value: ReturnType<typeof resolveSessionIdentity>['quality'],
): T.SessionIdentityQuality {
  switch (value) {
    case 'confirmed': return 'confirmed';
    case 'strong': return 'strong';
    case 'ephemeral': return 'ephemeral';
    case 'conflict': return 'conflict';
    case 'inferred': return 'inferred';
    default: return 'unknown';
  }
}

function interactionAgentAssetId(
  meta: T.EventMeta,
  semanticIdentity: ReturnType<typeof detectedAgentIdentity>,
): string {
  const exactProcessRoot = semanticIdentity.agentRuntimeInstanceId.startsWith('host-root:')
    && Boolean(semanticIdentity.agentProduct);
  return exactProcessRoot
    ? semanticIdentity.agentAssetId
    : meta.subjectAssetId ?? semanticIdentity.agentAssetId;
}

function interactionEnvironment(meta: T.EventMeta): T.AgentInteractionRecord['environment'] {
  const environment = meta.attribution?.workloadRef?.environment;
  return environment === 'kubernetes' || environment === 'docker' || environment === 'host'
    ? environment
    : 'unknown';
}

function boundedJson(value: unknown, maxBytes = MAX_DERIVED_JSON_BYTES): unknown {
  if (value === undefined) return undefined;
  try {
    return Buffer.byteLength(JSON.stringify(value)) <= maxBytes ? value : undefined;
  } catch {
    return undefined;
  }
}

function providerConversationFromStructured(
  value: unknown,
  depth = 0,
): string | undefined {
  if (depth > 3) return undefined;
  const object = record(value);
  if (!object) return undefined;
  for (const key of ['conversation_id', 'thread_id', 'session_id']) {
    const candidate = string(object[key], 512);
    if (candidate) return candidate;
  }
  const metadata = record(object.metadata) ?? record(object.client_metadata);
  if (metadata) {
    const direct = providerConversationFromStructured(metadata, depth + 1);
    if (direct) return direct;
  }
  for (const key of ['user_id', 'turn_metadata']) {
    const nested = object[key];
    if (nested && typeof nested === 'object') {
      const candidate = providerConversationFromStructured(nested, depth + 1);
      if (candidate) return candidate;
    }
    if (typeof nested === 'string' && Buffer.byteLength(nested) <= 4 * 1024) {
      try {
        const candidate = providerConversationFromStructured(JSON.parse(nested), depth + 1);
        if (candidate) return candidate;
      } catch {
        // Metadata strings are optional; malformed auxiliary metadata must not reject the body.
      }
    }
  }
  return undefined;
}

function providerRunFromStructured(value: unknown, depth = 0): string | undefined {
  if (depth > 3) return undefined;
  const object = record(value);
  if (!object) return undefined;
  for (const key of ['workflow_run_id', 'run_id', 'invocation_id']) {
    const direct = string(object[key], 512);
    if (direct) return direct;
  }
  for (const key of ['data', 'workflow_run', 'metadata', 'result']) {
    const nested = providerRunFromStructured(object[key], depth + 1);
    if (nested) return nested;
  }
  return undefined;
}

function runtimeOnlySessionId(
  sessionId: string | undefined,
  runtimeSessionId: string | undefined,
  meta: T.EventMeta,
): boolean {
  if (!sessionId) return false;
  if (runtimeSessionId && sessionId === runtimeSessionId) return true;
  if (meta.sessionIdentityQuality === 'ephemeral'
    && meta.sessionIdSource !== 'provider'
    && sessionId === meta.sessionId) return true;
  // Common legacy container/runtime IDs are intentionally not promoted to provider anchors when
  // no explicit provider conversation field was emitted.
  return new Set(['', '-', 'none', 'null', 'unknown', 'legacy', 'default', 'main', 'mainthread', 'runtime']).has(sessionId.trim().toLowerCase())
    || /^(?:docker|container|k8s|pod|runtime|agent-runtime)[:_-]/iu.test(sessionId);
}

function providerSessionUsable(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return !new Set(['', '-', 'none', 'null', 'unknown', 'legacy', 'default', 'main', 'mainthread', 'runtime']).has(normalized)
    && !/^(?:docker|container|k8s|pod|runtime|agent-runtime)[:_-]/iu.test(value);
}

function interactionRawObservationId(envelope: Record<string, unknown>): string | undefined {
  const raw = record(envelope.rawObservation ?? envelope.raw_observation);
  return string(raw?.observationId, 240);
}

function interactionRawObservationRevision(envelope: Record<string, unknown>): number | undefined {
  const raw = record(envelope.rawObservation ?? envelope.raw_observation);
  const value = Number(raw?.revision);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function interactionConnectionFromEnvelope(
  envelope: Record<string, unknown>,
  input: Record<string, unknown>,
  process: T.ProcessContext | undefined,
  interactionId: string,
  connectionId: string,
  transport: 'http' | 'tls',
  transportProtocol: string | undefined,
): {
  bindQuality?: 'cookie' | 'fd' | 'unbound';
  socketFd?: number;
  socketCookie?: string;
  fdGeneration?: string;
  connectionIdentity?: T.ConnectionIdentity;
} {
  const raw = record(envelope.rawObservation ?? envelope.raw_observation);
  const fromRaw = record(raw?.connection ?? raw?.connectionIdentity);
  const bindQualityRaw = string(input.bindQuality, 32)?.toLowerCase();
  const bindQuality = bindQualityRaw === 'cookie' || bindQualityRaw === 'fd' || bindQualityRaw === 'unbound'
    ? bindQualityRaw
    : undefined;
  const socketFd = integer(input.socketFd ?? fromRaw?.fd, 0, 4_194_304);
  const socketCookie = string(input.socketCookie ?? fromRaw?.socketCookie, 240);
  const fdGeneration = string(input.fdGeneration ?? fromRaw?.fdGeneration, 240);
  const processGenerationKey = string(process?.processGenerationKey, 128)
    ?? string(fromRaw?.processGenerationKey, 128);
  const derived = processGenerationKey
    ? deriveConnectionIdentity({
      processGenerationKey,
      ...(socketCookie ? { socketCookie } : {}),
      ...(socketFd !== undefined && socketFd > 0 ? { fd: socketFd } : {}),
      ...(fdGeneration ? { fdGeneration } : {}),
      tlsContextId: connectionId.startsWith('tls:')
        ? `tlsctx_${connectionId.slice(4)}`
        : `tlsctx_${connectionId}`,
      transport: transportProtocol?.includes('websocket')
        ? 'websocket'
        : transport === 'tls' ? 'tls' : transport === 'http' ? 'http' : 'unknown',
      sourceRefs: [interactionId],
    })
    : undefined;
  return {
    ...(bindQuality ? { bindQuality } : {}),
    ...(socketFd !== undefined && socketFd > 0 ? { socketFd } : {}),
    ...(socketCookie ? { socketCookie } : {}),
    ...(fdGeneration ? { fdGeneration } : {}),
    ...(derived ? { connectionIdentity: derived } : {}),
  };
}

function decodedBody(body: string, encoding: 'utf8' | 'base64'): Buffer | undefined {
  if (encoding === 'utf8') return Buffer.from(body, 'utf8');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(body)) {
    return undefined;
  }
  const decoded = Buffer.from(body, 'base64');
  return decoded.toString('base64') === body ? decoded : undefined;
}

function content(value: unknown): T.AgentInteractionContent | undefined {
  const input = record(value);
  if (!input) return undefined;
  const body = exactString(input.body, MAX_BODY_BYTES);
  const encoding = input.encoding === 'base64' ? 'base64' : input.encoding === 'utf8' ? 'utf8' : undefined;
  const contentType = string(input.contentType, 240);
  const capturedBytes = integer(input.capturedBytes, 0, MAX_BODY_BYTES * 8);
  const decodedBytes = integer(input.decodedBytes, 0, MAX_BODY_BYTES * 8);
  const sha256 = string(input.sha256, 64);
  if (
    body === undefined || !encoding || !contentType || capturedBytes === undefined
    || decodedBytes === undefined || !sha256 || !/^[a-f0-9]{64}$/u.test(sha256)
  ) return undefined;
  const decoded = decodedBody(body, encoding);
  if (
    !decoded
    || decoded.length !== decodedBytes
    || createHash('sha256').update(decoded).digest('hex') !== sha256
  ) return undefined;
  const messages = Array.isArray(input.messages)
    ? input.messages.slice(0, MAX_MESSAGES).map((item): T.AgentInteractionMessage | undefined => {
        const message = record(item);
        const role = string(message?.role, 80);
        const messageContent = boundedJson(message?.content);
        if (!message || !role || messageContent === undefined) return undefined;
        return {
          role,
          content: messageContent,
          ...(string(message.name, 240) ? { name: string(message.name, 240) } : {}),
          ...(string(message.toolCallId, 512) ? { toolCallId: string(message.toolCallId, 512) } : {}),
          ...(string(message.sourceItemId, 512) ? { sourceItemId: string(message.sourceItemId, 512) } : {}),
          ...(string(message.turnId, 512) ? { turnId: string(message.turnId, 512) } : {}),
          ...(Array.isArray(message.contentItemKinds)
            ? {
                contentItemKinds: [...new Set(message.contentItemKinds
                  .map((kind) => string(kind, 160))
                  .filter((kind): kind is string => Boolean(kind)))]
                  .slice(0, 32),
              }
            : {}),
          ...(closedValue(message.messageOrigin, MESSAGE_ORIGINS)
            ? { messageOrigin: closedValue(message.messageOrigin, MESSAGE_ORIGINS) }
            : {}),
        };
      }).filter((item): item is T.AgentInteractionMessage => Boolean(item))
    : undefined;
  const responseText = exactString(input.text, MAX_BODY_BYTES);
  const structured = boundedJson(input.structured);
  return {
    body,
    encoding,
    contentType,
    capturedBytes,
    decodedBytes,
    sha256,
    completeness: completeness(input.completeness),
    ...(messages?.length ? { messages } : {}),
    ...(responseText !== undefined ? { text: responseText } : {}),
    ...(structured !== undefined ? { structured } : {}),
  };
}

function toolCalls(value: unknown): T.AgentInteractionToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_TOOL_ITEMS).map((item): T.AgentInteractionToolCall | undefined => {
    const input = record(item);
    const toolCallId = string(input?.toolCallId, 512);
    const name = string(input?.name, 240);
    const args = boundedJson(input?.arguments);
    if (!input || !toolCallId || !name || args === undefined) return undefined;
    return {
      toolCallId,
      name,
      arguments: args,
      ...(unixNs(input.issuedAtUnixNs) ? { issuedAtUnixNs: unixNs(input.issuedAtUnixNs) } : {}),
    };
  }).filter((item): item is T.AgentInteractionToolCall => Boolean(item));
}

function toolResults(value: unknown): T.AgentInteractionToolResult[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_TOOL_ITEMS).map((item): T.AgentInteractionToolResult | undefined => {
    const input = record(item);
    const toolCallId = string(input?.toolCallId, 512);
    const result = boundedJson(input?.content);
    if (!input || !toolCallId || result === undefined) return undefined;
    return {
      toolCallId,
      ...(string(input.name, 240) ? { name: string(input.name, 240) } : {}),
      content: result,
      ...(typeof input.isError === 'boolean' ? { isError: input.isError } : {}),
      ...(unixNs(input.observedAtUnixNs)
        ? { observedAtUnixNs: unixNs(input.observedAtUnixNs) }
        : {}),
    };
  }).filter((item): item is T.AgentInteractionToolResult => Boolean(item));
}

function tokenUsage(value: unknown): T.AgentInteractionTokenUsage | undefined {
  const input = record(value);
  if (
    !input
    || input.source !== 'provider_reported'
    || (input.completeness !== 'complete' && input.completeness !== 'partial')
    || typeof input.totalTokensDerived !== 'boolean'
  ) return undefined;
  const counters = {
    inputTokens: integer(input.inputTokens, 0, Number.MAX_SAFE_INTEGER),
    outputTokens: integer(input.outputTokens, 0, Number.MAX_SAFE_INTEGER),
    totalTokens: integer(input.totalTokens, 0, Number.MAX_SAFE_INTEGER),
    cachedInputTokens: integer(input.cachedInputTokens, 0, Number.MAX_SAFE_INTEGER),
    cacheCreationInputTokens: integer(
      input.cacheCreationInputTokens,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    reasoningOutputTokens: integer(input.reasoningOutputTokens, 0, Number.MAX_SAFE_INTEGER),
  };
  if (
    counters.inputTokens === undefined
    && counters.outputTokens === undefined
    && counters.totalTokens === undefined
  ) return undefined;
  return {
    source: 'provider_reported',
    completeness: input.completeness,
    ...Object.fromEntries(Object.entries(counters).filter(([, counter]) => counter !== undefined)),
    totalTokensDerived: input.totalTokensDerived,
  } as T.AgentInteractionTokenUsage;
}

function semanticItems(value: unknown): T.AgentInteractionSemanticItem[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_SEMANTIC_ITEMS)
    .map((item): T.AgentInteractionSemanticItem | undefined => {
      const input = record(item);
      const semanticItemId = string(input?.semanticItemId, 160);
      const actor = closedValue(input?.actor, SEMANTIC_ACTORS);
      const kind = closedValue(input?.kind, SEMANTIC_KINDS);
      const phase = closedValue(input?.phase, SEMANTIC_PHASES);
      const origin = closedValue(input?.origin, SEMANTIC_ORIGINS);
      const atUnixNs = unixNs(input?.atUnixNs);
      const itemCompleteness = closedValue(input?.completeness, SEMANTIC_COMPLETENESS);
      if (
        !input || !semanticItemId || !/^si_[a-f0-9]{24,64}$/u.test(semanticItemId)
        || !actor || !kind || !origin || !atUnixNs || !itemCompleteness
      ) return undefined;
      const content = boundedJson(input.content);
      const outputIndex = integer(input.outputIndex, 0, Number.MAX_SAFE_INTEGER);
      const contentIndex = integer(input.contentIndex, 0, Number.MAX_SAFE_INTEGER);
      const sequenceNumber = integer(input.sequenceNumber, 0, Number.MAX_SAFE_INTEGER);
      const partialReasons = Array.isArray(input.partialReasons)
        ? [...new Set(input.partialReasons
            .map((reason) => string(reason, 240))
            .filter((reason): reason is string => Boolean(reason)))]
            .slice(0, 64)
        : [];
      return {
        semanticItemId,
        actor,
        kind,
        ...(phase ? { phase } : {}),
        origin,
        atUnixNs,
        ...(content !== undefined ? { content } : {}),
        ...(string(input.toolCallId, 512) ? { toolCallId: string(input.toolCallId, 512) } : {}),
        ...(string(input.toolName, 240) ? { toolName: string(input.toolName, 240) } : {}),
        ...(string(input.sourceItemId, 512) ? { sourceItemId: string(input.sourceItemId, 512) } : {}),
        ...(string(input.turnId, 512) ? { turnId: string(input.turnId, 512) } : {}),
        ...(Array.isArray(input.contentItemKinds)
          ? {
              contentItemKinds: [...new Set(input.contentItemKinds
                .map((item) => string(item, 160))
                .filter((item): item is string => Boolean(item)))]
                .slice(0, 32),
            }
          : {}),
        ...(closedValue(input.messageOrigin, MESSAGE_ORIGINS)
          ? { messageOrigin: closedValue(input.messageOrigin, MESSAGE_ORIGINS) }
          : {}),
        ...(outputIndex !== undefined ? { outputIndex } : {}),
        ...(contentIndex !== undefined ? { contentIndex } : {}),
        ...(sequenceNumber !== undefined ? { sequenceNumber } : {}),
        completeness: itemCompleteness,
        partialReasons,
      };
    })
    .filter((item): item is T.AgentInteractionSemanticItem => Boolean(item));
}

function conversationAnchors(value: unknown): T.AgentConversationAnchor[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.slice(0, MAX_CONVERSATION_ANCHORS)
    .map((item): T.AgentConversationAnchor | undefined => {
      const input = record(item);
      const kind = closedValue(input?.kind, ANCHOR_KINDS);
      const namespace = string(input?.namespace, 160);
      const valueHash = string(input?.valueHash, 64);
      const strength = closedValue(input?.strength, ANCHOR_STRENGTHS);
      const sourcePath = string(input?.sourcePath, 240);
      if (!kind || !namespace || !valueHash || !/^[a-f0-9]{64}$/u.test(valueHash)
        || !strength || !sourcePath) return undefined;
      const key = `${kind}\u0000${namespace}\u0000${valueHash}`;
      if (seen.has(key)) return undefined;
      seen.add(key);
      return { kind, namespace, valueHash, strength, sourcePath };
    })
    .filter((item): item is T.AgentConversationAnchor => Boolean(item));
}

function unixNsToMs(value: string): number {
  try {
    return Number(BigInt(value) / 1_000_000n);
  } catch {
    return Date.now();
  }
}

function parsePlaintextEvidence(
  input: Record<string, unknown>,
  meta: T.EventMeta,
): T.AgentInteractionRecord | undefined {
  if (input.schemaVersion !== 'anysentry.agent_plaintext_evidence.v1') return undefined;
  const evidenceId = string(input.evidenceId, 160);
  const connectionId = string(input.connectionId, 240);
  const observedAtUnixNs = unixNs(input.observedAtUnixNs);
  const tlsAdapterId = string(input.tlsAdapterId, 160);
  const transportProtocol = string(input.transportProtocol, 80);
  const parseState = closedValue(input.parseState, PARSE_STATES);
  const llmLikelihood = closedValue(input.llmLikelihood, LLM_LIKELIHOODS);
  const schemaFingerprint = string(input.schemaFingerprint, 160);
  const capturedBytes = integer(input.capturedBytes, 0, MAX_BODY_BYTES * 8);
  const redactedSample = exactString(input.redactedSample, 64 * 1024);
  const sampleSha256 = string(input.sampleSha256, 64);
  if (
    !evidenceId || !/^pe_[a-f0-9]{24,64}$/u.test(evidenceId)
    || !connectionId || !observedAtUnixNs || !tlsAdapterId || !transportProtocol
    || parseState !== 'unparsed' || !llmLikelihood || capturedBytes === undefined
    || !sampleSha256 || !/^[a-f0-9]{64}$/u.test(sampleSha256)
  ) return undefined;

  const detected = meta.classificationSemantics?.identityClassification
    ?? meta.attribution?.classification
    ?? 'unknown';
  if (detected !== 'confirmed_agent' && detected !== 'probable_agent') return undefined;
  const classificationDecision = captureClassificationDecision(detected);
  const semanticIdentity = detectedAgentIdentity({
    agentId: meta.agentId,
    workspacePath: meta.workspacePath,
    sessionId: meta.sessionId,
    attributes: meta.attributes ?? {},
    process: meta.process,
    attribution: meta.attribution,
    logicalAgentId: meta.logicalAgentId,
    logicalAgentCandidateId: meta.logicalAgentCandidateId,
    logicalDefinitionId: meta.logicalDefinitionId,
    logicalScopeMode: meta.logicalScopeMode,
    logicalIdentityAuthority: meta.logicalIdentityAuthority,
    terminalContextId: meta.terminalContextId,
  });
  const body = redactedSample ?? '';
  const bodyBytes = Buffer.from(body, 'utf8');
  const emptyBytes = Buffer.alloc(0);
  const content = (
    bytes: Buffer,
    observedBytes: number,
  ): T.AgentInteractionContent => ({
    body: bytes.toString('utf8'),
    encoding: 'utf8',
    contentType: redactedSample === undefined ? 'application/octet-stream' : 'application/json',
    capturedBytes: observedBytes,
    decodedBytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    completeness: 'unsupported',
  });
  const direction = input.direction === 'read' ? 'read' : 'write';
  const reasons = Array.isArray(input.reasons)
    ? input.reasons
        .map((reason) => string(reason, 240))
        .filter((reason): reason is string => Boolean(reason))
        .slice(0, 64)
    : [];
  const rootPid = meta.attribution?.rootPid;
  const runtimeRole = meta.process?.pid && rootPid && meta.process.pid !== rootPid
    ? 'network_runtime'
    : 'agent_root';
  const runtimeSessionId = string(meta.sessionId, 512);
  const logical = resolveLogicalAgentDefinition({
    logicalAgentId: meta.logicalAgentId,
    family: semanticIdentity.agentProduct ?? meta.attribution?.agentDisplayName ?? meta.agentId,
    tenantId: typeof meta.attributes?.tenantId === 'string' ? meta.attributes.tenantId : undefined,
    ownerId: typeof meta.attributes?.ownerId === 'string' ? meta.attributes.ownerId : undefined,
    workspacePath: meta.workspacePath,
    profile: typeof meta.attributes?.profile === 'string' ? meta.attributes.profile : undefined,
    logicalScopeMode: meta.logicalScopeMode,
    terminalContextId: meta.terminalContextId ?? meta.process?.terminalContextId,
    sourceRefs: [
      meta.rawObservationId,
      meta.sourceEventId,
      typeof meta.attributes?.sourceId === 'string' ? meta.attributes.sourceId : undefined,
    ].filter((value): value is string => Boolean(value)),
    authority: meta.logicalIdentityAuthority === 'management_registration'
      ? 'management_registration' : 'inferred',
  });
  const runtimeInstanceId = semanticIdentity.agentRuntimeInstanceId;
  const processGenerationKey = meta.process?.processGenerationKey
    ?? deriveProcessGenerationKey({
      hostId: meta.process?.hostId,
      bootId: meta.process?.bootId,
      pid: meta.process?.pid ?? 0,
      startTimeTicks: meta.process?.startTimeTicks,
      startTimeNs: meta.process?.startTimeNs,
    });
  const canonicalInstance = deriveAgentInstanceIdentity({
    logicalAgentId: logical.definition.logicalAgentId,
    logicalDefinitionId: logical.definition.definitionId,
    logicalScopeMode: logical.definition.logicalScopeMode,
    deploymentId: meta.deploymentId,
    deploymentRevision: meta.deploymentRevision,
    environmentId: meta.environmentId,
    profile: typeof meta.attributes?.profile === 'string' ? meta.attributes.profile : undefined,
    profileVersion: typeof meta.attributes?.profileVersion === 'string' ? meta.attributes.profileVersion : undefined,
    processGenerationKey,
  });
  const sessionNamespaceKey = [
    meta.logicalAgentId,
    typeof meta.attributes?.tenantId === 'string' ? meta.attributes.tenantId : undefined,
    typeof meta.attributes?.ownerId === 'string' ? meta.attributes.ownerId : undefined,
    typeof meta.attributes?.sourceId === 'string' ? meta.attributes.sourceId : undefined,
    meta.workspacePath,
  ].filter(Boolean).join('\0');
  return applyAgentAdapter({
    schemaVersion: 'anysentry.agent_interaction.v1',
    interactionId: 'mi_' + evidenceId.slice(3),
    interactionType: 'unparsed',
    at: unixNsToMs(observedAtUnixNs),
    workspacePath: meta.workspacePath,
    sourceId: typeof meta.attributes?.sourceId === 'string' ? meta.attributes.sourceId : undefined,
    collectorId: typeof meta.attributes?.collectorId === 'string' ? meta.attributes.collectorId : undefined,
    agentAssetId: interactionAgentAssetId(meta, semanticIdentity),
    agentInstanceId: runtimeInstanceId,
    ...(canonicalInstance.agentInstanceId ? { canonicalAgentInstanceId: canonicalInstance.agentInstanceId } : {}),
    runtimeInstanceId,
    agentProduct: semanticIdentity.agentProduct ?? meta.attribution?.agentDisplayName ?? meta.agentId,
    environment: interactionEnvironment(meta),
    ...(runtimeSessionId ? { runtimeSessionId } : {}),
    ...(meta.rawObservationId ? { rawObservationId: meta.rawObservationId } : {}),
    ...(logical.definition.logicalAgentId ? { logicalAgentId: logical.definition.logicalAgentId } : {}),
    logicalIdentityAuthority: logical.definition.logicalIdentityAuthority,
    ...(!logical.stable && logical.candidateId ? { logicalAgentCandidateId: logical.candidateId } : {}),
    ...(logical.definition.logicalScopeMode ? { logicalScopeMode: logical.definition.logicalScopeMode } : {}),
    ...(logical.definition.definitionFingerprint ? { logicalDefinitionFingerprint: logical.definition.definitionFingerprint } : {}),
    ...(meta.terminalContextId || meta.process?.terminalContextId
      ? { terminalContextId: meta.terminalContextId ?? meta.process?.terminalContextId } : {}),
    sessionIdentityQuality: meta.sessionIdentityQuality ?? 'unknown',
    canonicalSessionId: canonicalSessionIdForMembership(
      runtimeSessionId || evidenceId,
      sessionNamespaceKey ? `scope_${createHash('sha256').update(sessionNamespaceKey).digest('hex')}` : undefined,
      evidenceId,
    ),
    ...(sessionNamespaceKey
      ? { sessionNamespaceKey: `scope_${createHash('sha256').update(sessionNamespaceKey).digest('hex')}` }
      : {}),
    sessionResolutionRevision: 1,
    ...(meta.sessionIdSource ? { sessionIdSource: meta.sessionIdSource } : {}),
    sessionMode: 'unknown',
    sessionLifecycle: 'new',
    runtimeRole,
    correlationQuality: meta.subjectAssetId && semanticIdentity.agentRuntimeInstanceId
      ? 'exact'
      : meta.subjectAssetId ? 'strong' : 'inferred',
    detectedClassification: detected,
    currentEffectiveClassification: classificationDecision.effective,
    ...(classificationDecision.candidateAutoPromoted ? { candidateAutoPromoted: true } : {}),
    process: meta.process,
    connectionId,
    transport: input.captureSource === 'tcp_plaintext' ? 'http' : 'tls',
    protocol: transportProtocol,
    tlsAdapterId,
    transportProtocol,
    parseState,
    llmLikelihood,
    ...(schemaFingerprint ? { schemaFingerprint } : {}),
    transportCompleteness: 'partial',
    wireCompleteness: 'unknown',
    conversationCompleteness: 'partial',
    endpoint: 'unknown',
    method: 'UNKNOWN',
    path: 'unknown',
    statusCode: 0,
    startedAtUnixNs: observedAtUnixNs,
    requestCompleteAtUnixNs: observedAtUnixNs,
    firstResponseAtUnixNs: observedAtUnixNs,
    endedAtUnixNs: observedAtUnixNs,
    durationNs: '0',
    timeQuality: 'collector_calibrated',
    request: direction === 'write'
      ? content(bodyBytes, capturedBytes)
      : content(emptyBytes, 0),
    response: direction === 'read'
      ? content(bodyBytes, capturedBytes)
      : content(emptyBytes, 0),
    toolCalls: [],
    toolResults: [],
    completeness: 'unsupported',
    partialReasons: [...new Set(['unparsed_plaintext_evidence', ...reasons])],
    captureSource: string(input.captureSource, 120) ?? 'unknown',
    receivedAt: meta.receivedAt ?? Date.now(),
  });
}

export function parseObserverAgentInteraction(
  line: string,
  meta: T.EventMeta,
): T.AgentInteractionRecord | undefined {
  if (Buffer.byteLength(line) > MAX_LINE_BYTES) return undefined;
  let envelope: Record<string, unknown>;
  try {
    envelope = record(JSON.parse(line)) ?? {};
  } catch {
    return undefined;
  }
  const event = record(envelope.event);
  const input = record(event?.LlmInteraction);
  if (!input) {
    const evidence = record(event?.AgentPlaintextEvidence);
    return evidence ? parsePlaintextEvidence(evidence, meta) : undefined;
  }
  if (input.schemaVersion !== 'anysentry.agent_interaction.v1') return undefined;

  const interactionId = string(input.interactionId, 160);
  const connectionId = string(input.connectionId, 240);
  const endpointValue = string(input.endpoint, 1_000);
  const endpoint = endpointValue ? sanitizeEndpoint(endpointValue) : undefined;
  const method = string(input.method, 24);
  const pathValue = string(input.path, 2_000);
  const path = pathValue ? sanitizePath(pathValue) : undefined;
  const startedAtUnixNs = unixNs(input.startedAtUnixNs);
  const requestCompleteAtUnixNs = unixNs(input.requestCompleteAtUnixNs);
  const firstResponseAtUnixNs = unixNs(input.firstResponseAtUnixNs);
  const endedAtUnixNs = unixNs(input.endedAtUnixNs);
  const durationNs = unixNs(input.durationNs);
  const request = content(input.request);
  const response = content(input.response);
  const usage = tokenUsage(input.usage);
  if (
    !interactionId || !/^mi_[a-f0-9]{24,64}$/u.test(interactionId)
    || !connectionId || !endpoint || !method || !path
    || !startedAtUnixNs || !requestCompleteAtUnixNs || !firstResponseAtUnixNs
    || !endedAtUnixNs || !durationNs || !request || !response
  ) return undefined;

  const process = meta.process;
  const detected = meta.classificationSemantics?.identityClassification
    ?? meta.attribution?.classification
    ?? 'unknown';
  if (detected !== 'confirmed_agent' && detected !== 'probable_agent') return undefined;
  const classificationDecision = captureClassificationDecision(detected);
  const semanticIdentity = detectedAgentIdentity({
    agentId: meta.agentId,
    workspacePath: meta.workspacePath,
    sessionId: meta.sessionId,
    attributes: meta.attributes ?? {},
    process,
    attribution: meta.attribution,
    logicalAgentId: meta.logicalAgentId,
    logicalAgentCandidateId: meta.logicalAgentCandidateId,
    logicalDefinitionId: meta.logicalDefinitionId,
    logicalScopeMode: meta.logicalScopeMode,
    logicalIdentityAuthority: meta.logicalIdentityAuthority,
    terminalContextId: meta.terminalContextId,
  });
  const agentAssetId = interactionAgentAssetId(meta, semanticIdentity);
  const partialReasons = Array.isArray(input.partialReasons)
    ? [...new Set(input.partialReasons
        .map((reason) => string(reason, 240))
        .filter((reason): reason is string => Boolean(reason)))]
        .slice(0, 64)
    : [];
  const statusCode = integer(input.statusCode, 0, 999) ?? 0;
  const receivedAt = meta.receivedAt ?? Date.now();
  const runtimeSessionId = string(meta.sessionId, 512);
  const traceId = string(input.traceId, 64);
  const trustedContext = serverTrustedCorrelationContext(meta);
  const trustedRunClaim = trustedContext?.sourceTrust?.authenticated
    && trustedContext.sourceTrust.allowedClaims.length > 0
    ? trustedContext.sourceTrust.authority === 'agent_adapter'
      ? trustedContext.claims?.agentAdapter?.runId
      : trustedContext.claims?.application?.runId
    : undefined;
  // The wire interaction may contain a producer `runId`, but a collector token alone only
  // authenticates transport.  Keep that value out of the canonical/compatibility record unless
  // the source's server-side application/Adapter claim policy explicitly authorized it.
  const wireRunId = string(input.runId, 512) ?? providerRunFromStructured(response.structured);
  const runId = strictRunIdentity(trustedRunClaim) ?? wireRunId;
  const runIdSource = runId
    ? strictRunIdentity(trustedRunClaim) ? 'producer' as const : 'legacy' as const
    : undefined;
  const sessionId = string(input.sessionId, 512);
  const invocationId = string(input.invocationId, 512);
  const explicitProviderConversationId = string(input.providerConversationId, 512);
  const structuredProviderConversationId = providerConversationFromStructured(request.structured);
  const responseProviderConversationId = providerConversationFromStructured(response.structured);
  const declaredSessionSource = input.sessionIdSource === 'provider'
    || input.sessionIdSource === 'authenticated_adapter'
    ? input.sessionIdSource
    : undefined;
  const explicitlyNonProviderSession = [
    'per_request',
    'legacy_observer_session',
    'legacy_agent_fallback',
    'legacy_task_fallback',
    'unresolved',
  ].includes(String(input.sessionIdSource))
    || input.sessionMode === 'per_request'
    || input.sessionMode === 'ephemeral'
    || input.serviceStateful === false;
  const providerCandidate = explicitProviderConversationId
    ?? structuredProviderConversationId
    ?? responseProviderConversationId
    ?? (declaredSessionSource ? sessionId : undefined)
    // A plaintext session_id is a provider anchor only when it is not the runtime/container
    // session copied by a legacy producer. Keep the raw field below for compatibility.
    ?? (!explicitlyNonProviderSession && !runtimeOnlySessionId(sessionId, runtimeSessionId, meta)
      ? sessionId : undefined);
  // Generic placeholders (`default`, `unknown`, etc.) are not continuity evidence. Treat them as
  // missing even when a service claims to be stateful; the resolver will create an explicit
  // ephemeral/per-request Session instead of merging unrelated POSTs.
  let providerConversationId = providerCandidate
    && providerSessionUsable(providerCandidate)
    ? providerCandidate : undefined;
  if (input.fork === true && providerConversationId
    && string(input.parentSessionId, 512) === providerConversationId) {
    // A fork request may echo the parent provider ID while the new ID is assigned server-side.
    // Keep the parent only in provenance, never as the child Thread's primary anchor.
    providerConversationId = undefined;
  }
  const providerResponseId = string(input.providerResponseId, 512);
  const providerPreviousResponseId = string(input.providerPreviousResponseId, 512);
  const trafficRole = closedValue(input.trafficRole, TRAFFIC_ROLES);
  const anchors = conversationAnchors(input.conversationAnchors);
  const tlsAdapterId = string(input.tlsAdapterId, 160);
  const transportProtocol = string(input.transportProtocol, 80);
  const wireTemplateId = string(input.wireTemplateId, 160);
  const parseState = closedValue(input.parseState, PARSE_STATES);
  const llmLikelihood = closedValue(input.llmLikelihood, LLM_LIKELIHOODS);
  const schemaFingerprint = string(input.schemaFingerprint, 160);
  const transportCompleteness = closedValue(input.transportCompleteness, TRANSPORT_COMPLETENESS);
  const wireCompleteness = closedValue(input.wireCompleteness, WIRE_COMPLETENESS);
  const conversationCompleteness = closedValue(
    input.conversationCompleteness,
    CONVERSATION_COMPLETENESS,
  );
  const conversationId = string(input.conversationId, 512);
  const conversationIdSource = input.conversationIdSource === 'provider'
    || input.conversationIdSource === 'runtime'
    || input.conversationIdSource === 'inferred'
    ? input.conversationIdSource
    : undefined;
  const rootPid = meta.attribution?.rootPid;
  const runtimeRole = process?.pid && rootPid && process.pid !== rootPid
    ? 'network_runtime'
    : 'agent_root';
  // `meta` is assembled by the authenticated ingest boundary.  A management registration is
  // authoritative there, so producer fields from the decoded line must not override it.  The
  // fallback to the line remains for direct/unit callers that intentionally operate outside the
  // Controller; production ingest always supplies the server-resolved value first.
  const serverDefinitionAuthority = meta.logicalIdentityAuthority === 'management_registration'
    || meta.logicalIdentityAuthority === 'authenticated_adapter';
  // The Controller marks an authenticated-but-unregistered (and tokenless) line as
  // `logicalScopeMode=unresolved`.  Lock that boundary too: a producer must not re-introduce its
  // own tenant/profile/definition fields merely because the semantic parser sees the original
  // line. Direct library callers that omit the marker retain the legacy hint parsing behavior.
  const identityBoundaryLocked = serverDefinitionAuthority
    || (meta.logicalScopeMode === 'unresolved' && !meta.logicalAgentId && !meta.logicalDefinitionId);
  const logicalAgentId = meta.logicalAgentId
    ?? (identityBoundaryLocked ? undefined : string(input.logicalAgentId, 240));
  const logicalDefinitionId = identityBoundaryLocked
    ? meta.logicalDefinitionId
    : string(input.logicalDefinitionId, 240) ?? string(input.definitionId, 240);
  const logicalScopeMode = identityBoundaryLocked
    ? meta.logicalScopeMode
    : (
    input.logicalScopeMode === 'terminal'
      || input.logicalScopeMode === 'workflow_definition'
      || input.logicalScopeMode === 'service_definition'
      || input.logicalScopeMode === 'registered_definition'
      || input.logicalScopeMode === 'unresolved'
      ? input.logicalScopeMode
      : undefined
  );
  const terminalContextId = meta.terminalContextId
    ?? (identityBoundaryLocked ? undefined : string(input.terminalContextId, 240))
    ?? process?.terminalContextId;
  const tenantId = (typeof meta.attributes?.tenantId === 'string'
    ? meta.attributes.tenantId : undefined)
    ?? (identityBoundaryLocked ? undefined : string(input.tenantId, 240));
  const ownerId = (typeof meta.attributes?.ownerId === 'string'
    ? meta.attributes.ownerId : undefined)
    ?? (identityBoundaryLocked ? undefined : string(input.ownerId, 240));
  const profile = (typeof meta.attributes?.profile === 'string'
    ? meta.attributes.profile : undefined)
    ?? (identityBoundaryLocked ? undefined : string(input.profile, 240));
  const profileVersion = (typeof meta.attributes?.profileVersion === 'string'
    ? meta.attributes.profileVersion : undefined)
    ?? (identityBoundaryLocked ? undefined : string(input.profileVersion, 120));
  const deploymentId = (typeof meta.attributes?.deploymentId === 'string'
    ? meta.attributes.deploymentId : undefined)
    ?? (identityBoundaryLocked ? undefined : string(input.deploymentId ?? input.deployment_id, 240));
  const deploymentRevision = (typeof meta.attributes?.deploymentRevision === 'string'
    ? meta.attributes.deploymentRevision : undefined)
    ?? (identityBoundaryLocked ? undefined : string(input.deploymentRevision ?? input.deployment_revision ?? input.revision, 120));
  const environmentId = meta.environmentId
    ?? (identityBoundaryLocked ? undefined : string(input.environmentId ?? input.environment_id, 240));
  const logical = resolveLogicalAgentDefinition({
    logicalAgentId,
    family: string(input.agentProduct, 160)
      ?? semanticIdentity.agentProduct
      ?? meta.attribution?.agentDisplayName
      ?? meta.agentId,
    tenantId,
    ownerId,
    workspacePath: meta.workspacePath,
    repositoryId: string(input.repositoryId, 240),
    profile,
    profileVersion,
    definitionId: logicalDefinitionId,
    definitionType: identityBoundaryLocked && meta.logicalDefinitionId
      ? (meta.logicalScopeMode === 'workflow_definition' ? 'workflow'
        : meta.logicalScopeMode === 'service_definition' ? 'service'
          : 'registered')
      : identityBoundaryLocked ? undefined
        : input.definitionType as ReturnType<typeof resolveLogicalAgentDefinition>['definition']['definitionType']
        ?? (logicalDefinitionId ? 'registered' : undefined),
    logicalScopeMode,
    terminalContextId,
    sourceRefs: [
      meta.rawObservationId,
      meta.sourceEventId,
      typeof meta.attributes?.sourceId === 'string' ? meta.attributes.sourceId : undefined,
    ].filter((value): value is string => Boolean(value)),
    authority: meta.logicalIdentityAuthority === 'management_registration'
      ? 'management_registration' : 'inferred',
  });
  const runtimeInstanceId = semanticIdentity.agentRuntimeInstanceId;
  const processGenerationKey = process?.processGenerationKey
    ?? deriveProcessGenerationKey({
      hostId: process?.hostId,
      bootId: process?.bootId,
      pid: process?.pid ?? 0,
      startTimeTicks: process?.startTimeTicks,
      startTimeNs: process?.startTimeNs,
    });
  const canonicalInstance = deriveAgentInstanceIdentity({
    logicalAgentId: logical.definition.logicalAgentId,
    logicalDefinitionId: logical.definition.definitionId,
    logicalScopeMode: logical.definition.logicalScopeMode,
    deploymentId,
    deploymentRevision,
    environmentId,
    profile,
    profileVersion,
    processGenerationKey,
  });
  const serviceStateful = input.sessionMode === 'per_request'
    || input.sessionMode === 'ephemeral'
    || input.serviceStateful === true
    || input.serviceStateful === false;
  const serviceStatefulHint: boolean | undefined = input.serviceStateful === true
    ? true
    : input.serviceStateful === false || input.sessionMode === 'per_request'
      ? false
      : undefined;
  const secureSessionScope = (
    (meta.logicalIdentityAuthority === 'management_registration'
      || meta.logicalIdentityAuthority === 'authenticated_adapter')
    && Boolean(logical.definition.logicalAgentId)
    && Boolean(tenantId || ownerId)
  )
    ? `scope_${createHash('sha256').update([
        logical.logicalScopeKey, tenantId, ownerId, environmentId, profile,
        profileVersion, deploymentId, deploymentRevision,
      ].map((value) => value ?? '').join('\0')).digest('hex')}`
    : undefined;
  // A namespace assembled only from producer-controlled product/workspace labels is not a
  // trustworthy cross-event boundary. Keep it for direct callers that explicitly provide
  // tenant/owner material, and for the authenticated management/adapter path; otherwise an
  // unscoped provider Session is deliberately event-local and reported as ephemeral.
  const sourceScopedNamespace = Boolean(
    typeof meta.attributes?.sourceId === 'string'
      && meta.attributes.sourceId.trim()
      && meta.workspacePath,
  );
  const namespaceEligible = (
    Boolean(tenantId || ownerId)
      && Boolean(logical.definition.logicalAgentId || logical.definition.definitionId)
      && (serverDefinitionAuthority || !identityBoundaryLocked)
  ) || sourceScopedNamespace;
  const sessionNamespaceHint = namespaceEligible ? [
    tenantId,
    ownerId,
    logical.definition.logicalAgentId,
    logical.definition.definitionId,
    semanticIdentity.agentProduct ?? meta.agentId,
    typeof meta.attributes?.sourceId === 'string' ? meta.attributes.sourceId : undefined,
    meta.workspacePath,
  ].filter(Boolean).join('\0') : '';
  const sessionNamespaceKey = secureSessionScope
    ?? (sessionNamespaceHint
      ? `scope_${createHash('sha256').update(sessionNamespaceHint).digest('hex')}`
      : undefined);
  const sessionResolution = resolveSessionIdentity({
    providerSessionId: providerConversationId,
    sessionId,
    runtimeSessionId,
    serviceStateful: serviceStateful ? serviceStatefulHint : undefined,
    requestId: interactionId,
    interactionId,
    agentInstanceId: runtimeInstanceId,
    resume: input.resume === true,
    fork: input.fork === true,
    parentSessionId: string(input.parentSessionId, 512),
    scopeKey: secureSessionScope,
    namespaceHint: sessionNamespaceHint,
  });
  const runtimeOnlySession = explicitlyNonProviderSession
    || runtimeOnlySessionId(sessionId, runtimeSessionId, meta);
  const canonicalSessionId = input.fork === true
    ? sessionResolution.sessionId
    : runtimeOnlySession
    ? sessionResolution.sessionId
    : sessionResolution.quality === 'ephemeral' && serviceStateful
      ? sessionResolution.sessionId
      // `providerConversationId` is a transport/continuity anchor and may legitimately differ
      // from an application Session (for example a workflow's session_id alongside an upstream
      // provider conversation). Preserve the explicit non-runtime Session as the compatibility
      // identity; the provider anchor remains available for resolver graph edges.
      : sessionId && !runtimeOnlySessionId(sessionId, runtimeSessionId, meta)
        ? sessionId
        : providerConversationId ?? sessionResolution.sessionId;
  const rawObservationId = interactionRawObservationId(envelope) ?? meta.rawObservationId;
  const rawObservationRevision = interactionRawObservationRevision(envelope) ?? meta.rawObservationRevision;
  // A provider/session anchor extracted from the authenticated wire body outranks a legacy
  // Observer envelope fallback (which may have copied the Agent name into meta.sessionId).
  const sessionIdentityQuality: T.SessionIdentityQuality = providerConversationId
    ? interactionSessionQuality(sessionResolution.quality)
    : meta.sessionIdentityQuality
      ?? (runtimeOnlySession ? 'ephemeral' : sessionId ? 'inferred' : sessionResolution.quality === 'ephemeral' ? 'ephemeral' : 'unknown');
  const parsed: T.AgentInteractionRecord = {
    schemaVersion: 'anysentry.agent_interaction.v1',
    interactionId,
    interactionType: input.interactionType === 'tool'
      ? 'tool'
      : input.interactionType === 'remote_agent'
        ? 'remote_agent'
        : input.interactionType === 'unparsed' ? 'unparsed' : 'model',
    at: unixNsToMs(startedAtUnixNs),
    workspacePath: meta.workspacePath,
    ...(tenantId ? { tenantId } : {}),
    ...(ownerId ? { ownerId } : {}),
    ...(profile ? { profile } : {}),
    ...(profileVersion ? { profileVersion } : {}),
    ...(deploymentId ? { deploymentId } : {}),
    ...(deploymentRevision ? { deploymentRevision } : {}),
    ...(environmentId ? { environmentId } : {}),
    sourceId: typeof meta.attributes?.sourceId === 'string' ? meta.attributes.sourceId : undefined,
    collectorId: typeof meta.attributes?.collectorId === 'string' ? meta.attributes.collectorId : undefined,
    agentAssetId,
    agentInstanceId: semanticIdentity.agentRuntimeInstanceId,
    ...(canonicalInstance.agentInstanceId ? { canonicalAgentInstanceId: canonicalInstance.agentInstanceId } : {}),
    runtimeInstanceId,
    agentProduct: semanticIdentity.agentProduct ?? meta.attribution?.agentDisplayName ?? meta.agentId,
    environment: interactionEnvironment(meta),
    ...(runtimeSessionId ? { runtimeSessionId } : {}),
    ...(rawObservationId ? { rawObservationId, sourceObservationIds: [rawObservationId] } : {}),
    ...(rawObservationRevision ? { rawObservationRevision } : {}),
    ...(logical.definition.logicalAgentId ? { logicalAgentId: logical.definition.logicalAgentId } : {}),
    logicalIdentityAuthority: logical.definition.logicalIdentityAuthority,
    ...(!logical.stable && logical.candidateId ? { logicalAgentCandidateId: logical.candidateId } : {}),
    ...(logical.definition.definitionId ? { logicalDefinitionId: logical.definition.definitionId } : {}),
    ...(logical.definition.logicalScopeMode ? { logicalScopeMode: logical.definition.logicalScopeMode } : {}),
    ...(logical.definition.definitionFingerprint ? { logicalDefinitionFingerprint: logical.definition.definitionFingerprint } : {}),
    ...(logical.definition.terminalContextId ? { terminalContextId: logical.definition.terminalContextId } : {}),
    ...(traceId ? { traceId } : {}),
    ...(runId ? { runId } : {}),
    ...(runIdSource ? { runIdSource } : {}),
    ...(canonicalSessionId ? { sessionId: canonicalSessionId } : {}),
    canonicalSessionId: sessionResolution.canonicalSessionId,
    ...(sessionNamespaceKey ? { sessionNamespaceKey } : {}),
    ...(sessionResolution.canonicalSessionKey ? { sessionKey: sessionResolution.canonicalSessionKey } : {}),
    ...(sessionResolution.providerSessionIdHash ? { providerSessionIdHash: sessionResolution.providerSessionIdHash } : {}),
    sessionIdentityQuality,
    ...(providerConversationId
      ? { sessionIdSource: 'provider' as const }
      // `legacy_agent_fallback` is retained on the compatibility EventMeta envelope so old
      // readers can diagnose its origin, but it must not leak into a parsed interaction as the
      // apparent Session source.  An exact runtime/process binding without a provider anchor is
      // still a valid machine-side observation; its human Session boundary is per-request.
      : (runtimeOnlySession || meta.sessionIdSource === 'legacy_agent_fallback')
        ? { sessionIdSource: 'per_request' as const }
        : meta.sessionIdSource
          ? { sessionIdSource: meta.sessionIdSource }
          : { sessionIdSource: sessionResolution.quality === 'ephemeral' ? 'per_request' as const : 'unresolved' as const }),
    sessionMode: input.sessionMode === 'per_request' || serviceStatefulHint === false
      ? 'per_request'
      : sessionResolution.quality === 'ephemeral'
        ? 'ephemeral'
      : runtimeOnlySession
      ? 'per_request'
      : input.sessionMode === 'resumable' || input.sessionMode === 'conversation'
      || input.sessionMode === 'per_request' || input.sessionMode === 'ephemeral'
      ? input.sessionMode
      : sessionResolution.mode,
    sessionLifecycle: sessionResolution.lifecycle,
    sessionResolutionRevision: 1,
    ...(sessionResolution.canonicalParentSessionId
      ? { canonicalParentSessionId: sessionResolution.canonicalParentSessionId }
      : {}),
    ...(sessionResolution.parentSessionId ? { parentSessionId: sessionResolution.parentSessionId } : string(input.parentSessionId, 512) ? { parentSessionId: string(input.parentSessionId, 512) } : {}),
    ...(string(input.hop, 120) ? { hop: string(input.hop, 120) } : {}),
    ...(string(input.workflowNode, 120) ? { workflowNode: string(input.workflowNode, 120) } : {}),
    ...(string(input.delegationId, 512) ? { delegationId: string(input.delegationId, 512) } : {}),
    ...(string(input.agentIdHeader, 240) ? { agentIdHeader: string(input.agentIdHeader, 240) } : {}),
    ...(invocationId ? { invocationId } : {}),
    ...(providerConversationId ? { providerConversationId } : {}),
    ...(providerResponseId ? { providerResponseId } : {}),
    ...(providerPreviousResponseId ? { providerPreviousResponseId } : {}),
    ...(trafficRole ? { trafficRole } : {}),
    ...(anchors.length ? { conversationAnchors: anchors } : {}),
    ...(conversationId ? { conversationId } : {}),
    ...(conversationIdSource ? { conversationIdSource } : {}),
    runtimeRole,
    correlationQuality: meta.subjectAssetId && semanticIdentity.agentRuntimeInstanceId
      ? 'exact'
      : meta.subjectAssetId ? 'strong' : 'inferred',
    detectedClassification: detected,
    currentEffectiveClassification: classificationDecision.effective,
    ...(classificationDecision.candidateAutoPromoted ? { candidateAutoPromoted: true } : {}),
    process,
    connectionId,
    ...interactionConnectionFromEnvelope(
      envelope,
      input,
      process,
      interactionId,
      connectionId,
      input.transport === 'tls' ? 'tls' : 'http',
      string(input.transportProtocol, 80),
    ),
    transport: input.transport === 'tls' ? 'tls' : 'http',
    protocol: string(input.protocol, 80) ?? 'unknown',
    ...(tlsAdapterId ? { tlsAdapterId } : {}),
    ...(transportProtocol ? { transportProtocol } : {}),
    ...(wireTemplateId ? { wireTemplateId } : {}),
    ...(parseState ? { parseState } : {}),
    ...(llmLikelihood ? { llmLikelihood } : {}),
    ...(schemaFingerprint ? { schemaFingerprint } : {}),
    ...(transportCompleteness ? { transportCompleteness } : {}),
    ...(wireCompleteness ? { wireCompleteness } : {}),
    ...(conversationCompleteness ? { conversationCompleteness } : {}),
    endpoint,
    method,
    path,
    routeShape: normalizeAgentRouteShape(path),
    statusCode,
    model: string(input.model, 500),
    startedAtUnixNs,
    requestCompleteAtUnixNs,
    firstResponseAtUnixNs,
    endedAtUnixNs,
    durationNs,
    timeQuality: string(input.timeQuality, 80) ?? 'unknown',
    request,
    response,
    ...(usage ? { usage } : {}),
    toolCalls: toolCalls(input.toolCalls),
    toolResults: toolResults(input.toolResults),
    ...(string(input.semanticParserId, 160)
      ? { semanticParserId: string(input.semanticParserId, 160) }
      : {}),
    ...(integer(input.semanticParserVersion, 1, 1_000_000) !== undefined
      ? { semanticParserVersion: integer(input.semanticParserVersion, 1, 1_000_000) }
      : {}),
    semanticItems: semanticItems(input.semanticItems),
    completeness: completeness(input.completeness),
    partialReasons,
    captureSource: string(input.captureSource, 120) ?? 'unknown',
    receivedAt,
  };
  // Manifest-driven trafficRole / identity / toolNameView. Product logic stays in declarations.
  return applyAgentAdapter(parsed);
}
