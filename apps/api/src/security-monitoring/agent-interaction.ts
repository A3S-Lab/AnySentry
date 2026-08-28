import { createHash } from 'node:crypto';
import type * as T from './types';
import { detectedAgentIdentity } from './agent-identity';

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_LINE_BYTES = 14 * 1024 * 1024;
const MAX_DERIVED_JSON_BYTES = 512 * 1024;
const MAX_TOOL_ITEMS = 2_048;
const MAX_MESSAGES = 4_096;
const COMPLETENESS = new Set<T.AgentInteractionCompleteness>([
  'complete', 'partial', 'truncated', 'redacted', 'reference_only', 'unavailable', 'unsupported',
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

function unixNsToMs(value: string): number {
  try {
    return Number(BigInt(value) / 1_000_000n);
  } catch {
    return Date.now();
  }
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
  if (!input || input.schemaVersion !== 'anysentry.agent_interaction.v1') return undefined;

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
  const agentAssetId = meta.subjectAssetId ?? semanticIdentity.agentAssetId;
  const partialReasons = Array.isArray(input.partialReasons)
    ? [...new Set(input.partialReasons
        .map((reason) => string(reason, 240))
        .filter((reason): reason is string => Boolean(reason)))]
        .slice(0, 64)
    : [];
  const statusCode = integer(input.statusCode, 0, 999) ?? 0;
  const receivedAt = meta.receivedAt ?? Date.now();
  return {
    schemaVersion: 'anysentry.agent_interaction.v1',
    interactionId,
    interactionType: input.interactionType === 'tool' ? 'tool' : 'model',
    at: unixNsToMs(startedAtUnixNs),
    workspacePath: meta.workspacePath,
    sourceId: typeof meta.attributes?.sourceId === 'string' ? meta.attributes.sourceId : undefined,
    collectorId: typeof meta.attributes?.collectorId === 'string' ? meta.attributes.collectorId : undefined,
    agentAssetId,
    agentInstanceId: semanticIdentity.agentRuntimeInstanceId,
    agentProduct: semanticIdentity.agentProduct ?? meta.attribution?.agentDisplayName ?? meta.agentId,
    detectedClassification: detected,
    currentEffectiveClassification: detected,
    process,
    connectionId,
    transport: input.transport === 'tls' ? 'tls' : 'http',
    protocol: string(input.protocol, 80) ?? 'unknown',
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
    completeness: completeness(input.completeness),
    partialReasons,
    captureSource: string(input.captureSource, 120) ?? 'unknown',
    receivedAt,
  };
}
