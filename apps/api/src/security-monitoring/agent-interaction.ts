import { createHash } from 'node:crypto';
import type * as T from './types';
import { detectedAgentIdentity } from './agent-identity';

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
  'conversation', 'bootstrap', 'control', 'context_replay', 'background', 'unclassified',
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
      isError: input.isError === true,
      ...(unixNs(input.observedAtUnixNs)
        ? { observedAtUnixNs: unixNs(input.observedAtUnixNs) }
        : {}),
    };
  }).filter((item): item is T.AgentInteractionToolResult => Boolean(item));
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
  const semanticIdentity = detectedAgentIdentity({
    agentId: meta.agentId,
    workspacePath: meta.workspacePath,
    sessionId: meta.sessionId,
    attributes: meta.attributes ?? {},
    process: meta.process,
    attribution: meta.attribution,
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
  return {
    schemaVersion: 'anysentry.agent_interaction.v1',
    interactionId: 'mi_' + evidenceId.slice(3),
    interactionType: 'unparsed',
    at: unixNsToMs(observedAtUnixNs),
    workspacePath: meta.workspacePath,
    sourceId: typeof meta.attributes?.sourceId === 'string' ? meta.attributes.sourceId : undefined,
    collectorId: typeof meta.attributes?.collectorId === 'string' ? meta.attributes.collectorId : undefined,
    agentAssetId: interactionAgentAssetId(meta, semanticIdentity),
    agentInstanceId: semanticIdentity.agentRuntimeInstanceId,
    agentProduct: semanticIdentity.agentProduct ?? meta.attribution?.agentDisplayName ?? meta.agentId,
    environment: interactionEnvironment(meta),
    ...(runtimeSessionId ? { runtimeSessionId } : {}),
    runtimeRole,
    correlationQuality: meta.subjectAssetId && semanticIdentity.agentRuntimeInstanceId
      ? 'exact'
      : meta.subjectAssetId ? 'strong' : 'inferred',
    detectedClassification: detected,
    currentEffectiveClassification: detected,
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
  };
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
  const endpoint = string(input.endpoint, 1_000);
  const method = string(input.method, 24);
  const path = string(input.path, 2_000);
  const startedAtUnixNs = unixNs(input.startedAtUnixNs);
  const requestCompleteAtUnixNs = unixNs(input.requestCompleteAtUnixNs);
  const firstResponseAtUnixNs = unixNs(input.firstResponseAtUnixNs);
  const endedAtUnixNs = unixNs(input.endedAtUnixNs);
  const durationNs = unixNs(input.durationNs);
  const request = content(input.request);
  const response = content(input.response);
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
  const semanticIdentity = detectedAgentIdentity({
    agentId: meta.agentId,
    workspacePath: meta.workspacePath,
    sessionId: meta.sessionId,
    attributes: meta.attributes ?? {},
    process,
    attribution: meta.attribution,
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
  const providerConversationId = string(input.providerConversationId, 512);
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
  return {
    schemaVersion: 'anysentry.agent_interaction.v1',
    interactionId,
    interactionType: input.interactionType === 'tool'
      ? 'tool'
      : input.interactionType === 'unparsed' ? 'unparsed' : 'model',
    at: unixNsToMs(startedAtUnixNs),
    workspacePath: meta.workspacePath,
    sourceId: typeof meta.attributes?.sourceId === 'string' ? meta.attributes.sourceId : undefined,
    collectorId: typeof meta.attributes?.collectorId === 'string' ? meta.attributes.collectorId : undefined,
    agentAssetId,
    agentInstanceId: semanticIdentity.agentRuntimeInstanceId,
    agentProduct: semanticIdentity.agentProduct ?? meta.attribution?.agentDisplayName ?? meta.agentId,
    environment: interactionEnvironment(meta),
    ...(runtimeSessionId ? { runtimeSessionId } : {}),
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
    currentEffectiveClassification: detected,
    process,
    connectionId,
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
}
