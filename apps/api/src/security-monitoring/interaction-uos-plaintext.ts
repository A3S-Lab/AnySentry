/**
 * UOS plaintext adapter: project AnySentry's own observer plaintext interactions
 * (ClickHouse agent_interactions_v1, kprobe HTTP / openssl-uprobe TLS) into the
 * feat/agent-trace-observability interaction record model so the upstream
 * Conversation Tracking page renders real LLM request/response content.
 *
 * Dev/sim note: this source is read-only against our existing table and does not
 * touch the Kafka interaction lane, the encrypted content store, or the frozen
 * collection pipeline.
 */
import { createHash } from 'node:crypto';
import {
  INTERACTION_INSTRUCTION_SCHEMA,
  INTERACTION_RESPONSE_SCHEMA,
  type InteractionContentCapture,
  type InteractionConversationSummary,
  type InteractionInstructionRecord,
  type InteractionResponseRecord,
} from './interaction.types';

export const UOS_CONVERSATION_PREFIX = 'uosconv:';
export const UOS_CONTENT_SUFFIX = /:(?:in|out)$/u;

/** Rows hydrated from agent_interactions_v1 payload (schemaVersion anysentry.agent_interaction.v1). */
export interface UosInteractionRow {
  schemaVersion?: string;
  interactionId?: string;
  interactionType?: string;
  at?: number;
  workspacePath?: string;
  sourceId?: string;
  collectorId?: string;
  agentInstanceId?: string;
  agentProduct?: string;
  environmentId?: string;
  sessionId?: string;
  canonicalSessionId?: string;
  endpoint?: string;
  method?: string;
  path?: string;
  statusCode?: number;
  model?: string;
  transport?: string;
  tlsAdapterId?: string;
  startedAtUnixNs?: string;
  durationNs?: string;
  connectionId?: string;
  traceId?: string;
  runId?: string;
  routeShape?: string;
  wireTemplateId?: string;
  request?: { body?: string; capturedBytes?: number };
  response?: { body?: string; capturedBytes?: number };
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
}

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

/**
 * Tolerantly parse a stored payload. The current collector double-escapes the
 * request/response body strings (known issue, fix queued in D3), which makes a
 * strict JSON.parse fail; recover by unescaping the body spans one extra layer.
 */
export function parseUosPayload(payload: string): UosInteractionRow | undefined {
  try {
    const parsed = JSON.parse(payload) as UosInteractionRow;
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    // fall through to the tolerant path
  }
  try {
    const head = (key: string): string | undefined => {
      const match = new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)"`).exec(payload);
      return match ? match[1] : undefined;
    };
    const num = (key: string): number | undefined => {
      const match = new RegExp(`"${key}":("?)(\\d{1,20})\\1`).exec(payload);
      return match ? Number(match[2]) : undefined;
    };
    const bodySpan = (section: 'request' | 'response'): string | undefined => {
      // body terminates at the next content-object field ("encoding").
      const anchor = `"${section}":{"body":"`;
      const start = payload.indexOf(anchor);
      if (start < 0) return undefined;
      const from = start + anchor.length;
      const end = payload.indexOf('","encoding"', from);
      if (end < 0) return undefined;
      const escaped = payload.slice(from, end);
      // The collector applied a backslash-doubling pass but left quotes raw, which makes the
      // stored payload invalid JSON. Collapsing the doubled backslashes restores the once-escaped
      // body text (all quotes back to \" form), and one string-literal parse then returns the
      // original body. (Collector-side fix is queued in D3; keep this tolerant path regardless.)
      const collapsed = escaped.replace(/\\\\/g, '\\');
      return JSON.parse(`"${collapsed}"`) as string;
    };
    const row: UosInteractionRow = {
      schemaVersion: head('schemaVersion'),
      interactionId: head('interactionId'),
      interactionType: head('interactionType'),
      workspacePath: head('workspacePath'),
      sourceId: head('sourceId'),
      collectorId: head('collectorId'),
      agentInstanceId: head('agentInstanceId'),
      agentProduct: head('agentProduct'),
      sessionId: head('sessionId'),
      canonicalSessionId: head('canonicalSessionId'),
      endpoint: head('endpoint'),
      method: head('method'),
      path: head('path'),
      model: head('model'),
      transport: head('transport'),
      tlsAdapterId: head('tlsAdapterId'),
      startedAtUnixNs: head('startedAtUnixNs'),
      durationNs: head('durationNs'),
      connectionId: head('connectionId'),
      traceId: head('traceId'),
      runId: head('runId'),
      routeShape: head('routeShape'),
      wireTemplateId: head('wireTemplateId'),
      at: num('at'),
      statusCode: num('statusCode'),
      request: { body: bodySpan('request') },
      response: { body: bodySpan('response') },
    };
    return row.interactionId ? row : undefined;
  } catch {
    return undefined;
  }
}

const contentText = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === 'object' && 'text' in part ? String((part as { text?: unknown }).text ?? '') : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
};

/** The business backend sends placeholder user messages and embeds the real input in the
 *  system prompt's context block. Recover the embedded input for those.
 *  Patterns are line-anchored and reject a "准" follow character: mid-sentence prose like
 *  "以用户输入为准；" (subject to user input) must not be mistaken for an embedding marker. */
function embeddedUserInput(systemText: string): string {
  const patterns = [
    /^\s*用户原始输入(?:是|为|：|:)(?!准)\s*([^\n]{1,500})/mu,
    /^\s*用户输入(?:是|为|：|:)(?!准)\s*([^\n]{1,500})/mu,
    /^\s*用户的问题(?:是|为|：|:)(?!准)\s*([^\n]{1,500})/mu,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(systemText);
    if (match?.[1]?.trim()) return match[1].trim();
  }
  return '';
}

/** Tolerant salvage for capture-window-truncated request JSON: pull the last COMPLETE
 *  user/assistant message object and the model name without a full parse. */
function salvageTruncatedRequest(requestBody: string): string {
  const messageRe = /"role"\s*:\s*"(user|assistant)"\s*,\s*"content"\s*:\s*"((?:[^"\\]|\\.)*)"\s*[}\]]/gu;
  let last = '';
  for (const match of requestBody.matchAll(messageRe)) {
    try {
      const text = JSON.parse(`"${match[2]}"`) as string;
      if (text.trim()) last = text;
    } catch {
      // keep scanning; a later complete message may still parse
    }
  }
  return last;
}

/** Extract the user instruction text from an OpenAI-compatible request body. */
export function extractUserInstruction(requestBody: string | undefined): string {
  if (!requestBody) return '';
  try {
    const parsed = JSON.parse(requestBody) as {
      messages?: Array<{ role?: string; content?: unknown }>;
      query?: unknown;
      documents?: unknown;
      input?: unknown;
    };
    // Non-chat model calls on the same gateway: rerank (query+documents) and embeddings (input).
    if (!Array.isArray(parsed.messages)) {
      const rerank = rerankRequestText(parsed);
      if (rerank) return rerank;
      const embedding = embeddingRequestText(parsed);
      if (embedding) return embedding;
    }
    return instructionFromMessages(Array.isArray(parsed.messages) ? parsed.messages : []);
  } catch {
    // Capture-window truncation: salvage complete message elements first so array-content
    // blocks ({"content":[{"type":"text",...}]}) still yield the real instruction; fall
    // back to the regex salvage and finally the raw prefix.
    const salvagedMessages = salvageCompleteMessages(requestBody) as Array<{ role?: string; content?: unknown }>;
    if (salvagedMessages.length > 0) {
      const instruction = instructionFromMessages(salvagedMessages);
      if (instruction) return instruction;
    }
    const salvaged = salvageTruncatedRequest(requestBody);
    if (salvaged) return salvaged;
    // Even the first message is truncated (giant system prompt): recover the leading
    // text block — it names the node role, which beats dumping the raw JSON prefix.
    const blockText = /"text"\s*:\s*"((?:[^"\\]|\\.){4,300})/u.exec(requestBody);
    if (blockText?.[1]) {
      const recovered = blockText[1]
        .replace(/\\n/gu, ' ')
        .replace(/\\"/gu, '"')
        .replace(/\\\\/gu, '\\')
        .trim();
      if (recovered) return recovered;
    }
    return requestBody.slice(0, 2_000);
  }
}

/** Shared instruction extraction over a message list (full parse or salvaged prefix). */
function instructionFromMessages(messages: Array<{ role?: string; content?: unknown }>): string {
  const users = messages
    .filter((message) => message?.role === 'user')
    .map((message) => contentText(message.content).trim())
    .filter(Boolean);
  if (users.length > 0) return users[users.length - 1];
  const systemTexts = messages
    .filter((message) => message?.role === 'system')
    .map((message) => contentText(message.content))
    .filter(Boolean);
  for (const systemText of systemTexts) {
    const embedded = embeddedUserInput(systemText);
    if (embedded) return embedded;
  }
  // Placeholder-pattern agents (intent parsers etc.) send a whitespace user message and put the
  // operative text in the system prompt; its first substantive line (skipping markdown headers
  // like "# Role") names the node role, which makes the best available title/summary.
  const firstSystem = systemTexts[0] ?? '';
  const lines = firstSystem.split('\n').map((line) => line.trim()).filter(Boolean);
  return lines.find((line) => !line.startsWith('#')) ?? lines[0] ?? '';
}

/** LLM-shaped traffic only: the whitelist captures every HTTP egress of the Agent containers,
 *  including business callbacks and IM traffic that must not become conversations. Rerank and
 *  embeddings endpoints are model-inference calls on the same gateway, so they count too. */
export function isLlmShapedRow(row: UosInteractionRow): boolean {
  const path = row.path ?? '';
  if (/(?:chat\/)?completions|generate_?content|responses(?:\.json)?$|\/(?:rerank|embeddings)$/iu.test(path)) return true;
  // Inference endpoints in every supported wire template (OpenAI-compatible chat,
  // Anthropic messages) are POSTs. Management-plane REST reads (model registry lookups,
  // config fetches) are GETs and must not become conversations.
  const method = (row.method ?? '').toUpperCase();
  if (method && method !== 'POST') return false;
  const response = row.response?.body ?? '';
  // Require the unescaped top-level object marker: a management envelope that embeds a
  // historical test completion quotes it escaped (\"object\":\"chat.completion\"),
  // which this pattern rejects.
  if (/"object"\s*:\s*"chat\.completion/u.test(response)) return true;
  const request = row.request?.body ?? '';
  return request.includes('"messages"') && /maas\.aliyuncs\.com|\/v1\//u.test(row.endpoint ?? '');
}

/** Reranker (bge-reranker /v1/rerank) request: query + candidate documents. */
function rerankRequestText(parsed: { query?: unknown; documents?: unknown }): string {
  if (typeof parsed.query !== 'string' || !Array.isArray(parsed.documents)) return '';
  const docs = parsed.documents
    .map((doc) => (typeof doc === 'string' ? doc : ''))
    .filter(Boolean);
  const previews = docs.slice(0, 5)
    .map((doc, index) => `${index + 1}. ${doc.length > 120 ? `${doc.slice(0, 120)}…` : doc}`);
  return `【重排查询】${parsed.query}\n候选文档 ${docs.length} 条：\n${previews.join('\n')}${docs.length > 5 ? '\n…' : ''}`;
}

/** Embeddings (/v1/embeddings) request: input string or string array. */
function embeddingRequestText(parsed: { input?: unknown }): string {
  const input = parsed.input;
  const items = Array.isArray(input) ? input : (typeof input === 'string' ? [input] : []);
  const texts = items.map((item) => (typeof item === 'string' ? item : '')).filter(Boolean);
  if (texts.length === 0) return '';
  const previews = texts.slice(0, 5)
    .map((text, index) => `${index + 1}. ${text.length > 120 ? `${text.slice(0, 120)}…` : text}`);
  return `【嵌入请求】共 ${texts.length} 条文本：\n${previews.join('\n')}${texts.length > 5 ? '\n…' : ''}`;
}

/** Reranker response: ranked results with relevance scores (never dump full documents). */
function rerankResponseText(parsed: {
  results?: Array<{ index?: number; relevance_score?: number; document?: { text?: string } }>;
  usage?: { total_tokens?: number };
}): string {
  const results = Array.isArray(parsed.results) ? parsed.results : [];
  if (results.length === 0) return '';
  const lines = results.slice(0, 5).map((result, order) => {
    const score = typeof result.relevance_score === 'number' ? result.relevance_score.toFixed(4) : '?';
    const text = result.document?.text ?? '';
    const preview = text.length > 80 ? `${text.slice(0, 80)}…` : text;
    return `${order + 1}. 文档#${result.index ?? '?'} 相关度 ${score} — ${preview}`;
  });
  const tokens = parsed.usage?.total_tokens;
  return `【重排结果】共 ${results.length} 条${tokens !== undefined ? `（tokens: ${tokens}）` : ''}：\n${lines.join('\n')}${results.length > 5 ? '\n…' : ''}`;
}

/** Embeddings response: vector count/dimensions only — the float arrays are never displayable. */
function embeddingResponseText(parsed: {
  data?: Array<{ embedding?: unknown }>;
  usage?: { total_tokens?: number; prompt_tokens?: number };
}): string {
  const data = Array.isArray(parsed.data) ? parsed.data : [];
  if (data.length === 0) return '';
  const first = data[0]?.embedding;
  const dims = Array.isArray(first) ? first.length : 0;
  const tokens = parsed.usage?.total_tokens ?? parsed.usage?.prompt_tokens;
  return `【嵌入向量】${data.length} 条${dims ? ` × ${dims} 维` : ''}${tokens !== undefined ? `（tokens: ${tokens}）` : ''}`;
}

export interface UosToolEvent {
  kind: 'call' | 'result';
  name: string;
  /** Arguments preview for calls, result content preview for results. */
  detail: string;
  toolCallId?: string;
  /** request_context = seen inside this request's message history; response = produced here. */
  source: 'request_context' | 'response';
}

const TOOL_EVENT_PREVIEW_MAX = 300;
const TOOL_EVENTS_MAX = 24;

const toolPreview = (value: string): string => {
  const compact = value.replace(/\s+/gu, ' ').trim();
  return compact.length > TOOL_EVENT_PREVIEW_MAX
    ? `${compact.slice(0, TOOL_EVENT_PREVIEW_MAX)}…`
    : compact;
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

type ToolCallSlot = { id: string; name: string; arguments: string };

/** OpenAI-compatible tool-call streaming: arguments arrive fragmented per index;
 *  assemble per index like AgentSight's SSE processor does. */
function accumulateStreamedToolCall(
  slots: Map<number, ToolCallSlot>,
  call: { index?: number; id?: string; function?: { name?: string; arguments?: string } },
): void {
  const slot = call.index ?? 0;
  const current = slots.get(slot) ?? { id: '', name: '', arguments: '' };
  if (call.id) current.id = call.id;
  if (call.function?.name) current.name += call.function.name;
  if (call.function?.arguments) current.arguments += call.function.arguments;
  slots.set(slot, current);
}

const argumentText = (value: unknown): string =>
  typeof value === 'string' ? value : value !== undefined ? JSON.stringify(value) : '';

/** Tool events from the request's message history. The observed agents submit each HTTP
 *  call under an ephemeral session id, so a single interaction must surface the whole
 *  chain that led to it — not only the tail after the last user message. Covers the
 *  OpenAI messages template (assistant.tool_calls / role:tool / legacy function_call)
 *  and the Anthropic blocks template (tool_use / tool_result content blocks). */
function historyToolEvents(messages: unknown[]): UosToolEvent[] {
  const events: UosToolEvent[] = [];
  for (const message of messages) {
    const record = asRecord(message);
    if (!record) continue;
    if (record.role === 'assistant') {
      for (const call of Array.isArray(record.tool_calls) ? record.tool_calls : []) {
        const entry = asRecord(call);
        const fn = asRecord(entry?.function);
        events.push({
          kind: 'call',
          name: String(fn?.name ?? entry?.name ?? ''),
          detail: toolPreview(argumentText(fn?.arguments ?? entry?.arguments)),
          ...(entry?.id ? { toolCallId: String(entry.id) } : {}),
          source: 'request_context',
        });
      }
      const legacy = asRecord(record.function_call);
      if (legacy) {
        events.push({
          kind: 'call',
          name: String(legacy.name ?? ''),
          detail: toolPreview(argumentText(legacy.arguments)),
          source: 'request_context',
        });
      }
    } else if (record.role === 'tool') {
      events.push({
        kind: 'result',
        name: String(record.name ?? ''),
        detail: toolPreview(contentText(record.content)),
        ...(record.tool_call_id ? { toolCallId: String(record.tool_call_id) } : {}),
        source: 'request_context',
      });
    }
    if (Array.isArray(record.content)) {
      for (const block of record.content) {
        const entry = asRecord(block);
        if (entry?.type === 'tool_use') {
          events.push({
            kind: 'call',
            name: String(entry.name ?? ''),
            detail: toolPreview(argumentText(entry.input)),
            ...(entry.id ? { toolCallId: String(entry.id) } : {}),
            source: 'request_context',
          });
        } else if (entry?.type === 'tool_result') {
          events.push({
            kind: 'result',
            name: '',
            detail: toolPreview(contentText(entry.content)),
            ...(entry.tool_use_id ? { toolCallId: String(entry.tool_use_id) } : {}),
            source: 'request_context',
          });
        }
      }
    }
  }
  return events;
}

/** Tool events produced by this response: OpenAI SSE deltas, OpenAI JSON message
 *  tool_calls/function_call, Anthropic streamed content blocks, Anthropic JSON blocks. */
function responseToolEvents(responseBody: string): UosToolEvent[] {
  const trimmed = responseBody.trim();
  if (!trimmed) return [];
  const toEvents = (slots: Map<number, ToolCallSlot>): UosToolEvent[] =>
    [...slots.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([, slot]) => ({
        kind: 'call' as const,
        name: slot.name,
        detail: toolPreview(slot.arguments),
        ...(slot.id ? { toolCallId: slot.id } : {}),
        source: 'response' as const,
      }));
  if (trimmed.startsWith('data:') || trimmed.includes('\ndata:')) {
    const openAi = new Map<number, ToolCallSlot>();
    const anthropic = new Map<number, ToolCallSlot>();
    for (const line of trimmed.split('\n')) {
      const clean = line.trim();
      if (!clean.startsWith('data:')) continue;
      const data = clean.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const chunk = JSON.parse(data) as Record<string, unknown>;
        const choice = asRecord((chunk.choices as unknown[] | undefined)?.[0]);
        const delta = asRecord(choice?.delta);
        for (const call of Array.isArray(delta?.tool_calls) ? delta.tool_calls : []) {
          accumulateStreamedToolCall(
            openAi,
            call as { index?: number; id?: string; function?: { name?: string; arguments?: string } },
          );
        }
        if (chunk.type === 'content_block_start') {
          const block = asRecord(chunk.content_block);
          if (block?.type === 'tool_use') {
            anthropic.set(Number(chunk.index ?? 0), {
              id: String(block.id ?? ''),
              name: String(block.name ?? ''),
              arguments: '',
            });
          }
        } else if (chunk.type === 'content_block_delta') {
          const blockDelta = asRecord(chunk.delta);
          if (blockDelta?.type === 'input_json_delta') {
            const current = anthropic.get(Number(chunk.index ?? 0));
            if (current) current.arguments += String(blockDelta.partial_json ?? '');
          }
        }
      } catch {
        // tolerate partial chunks at capture boundaries
      }
    }
    return [...toEvents(openAi), ...toEvents(anthropic)];
  }
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const events: UosToolEvent[] = [];
    const choice = asRecord((parsed.choices as unknown[] | undefined)?.[0]);
    const message = asRecord(choice?.message);
    for (const call of Array.isArray(message?.tool_calls) ? message.tool_calls : []) {
      const entry = asRecord(call);
      const fn = asRecord(entry?.function);
      events.push({
        kind: 'call',
        name: String(fn?.name ?? entry?.name ?? ''),
        detail: toolPreview(argumentText(fn?.arguments ?? entry?.arguments)),
        ...(entry?.id ? { toolCallId: String(entry.id) } : {}),
        source: 'response',
      });
    }
    const legacy = asRecord(message?.function_call);
    if (legacy) {
      events.push({
        kind: 'call',
        name: String(legacy.name ?? ''),
        detail: toolPreview(argumentText(legacy.arguments)),
        source: 'response',
      });
    }
    for (const block of Array.isArray(parsed.content) ? parsed.content : []) {
      const entry = asRecord(block);
      if (entry?.type === 'tool_use') {
        events.push({
          kind: 'call',
          name: String(entry.name ?? ''),
          detail: toolPreview(argumentText(entry.input)),
          ...(entry.id ? { toolCallId: String(entry.id) } : {}),
          source: 'response',
        });
      }
    }
    return events;
  } catch {
    return [];
  }
}

/** Capture-window-truncated request JSON never parses whole. Walk the messages array
 *  element by element (balanced braces, string-literal aware) and recover every COMPLETE
 *  message; the truncated tail element is dropped. */
function salvageCompleteMessages(requestBody: string): unknown[] {
  const anchor = /"messages"\s*:\s*\[/u.exec(requestBody);
  if (!anchor) return [];
  const messages: unknown[] = [];
  let index = anchor.index + anchor[0].length;
  const limit = requestBody.length;
  while (index < limit) {
    while (index < limit && /[\s,]/u.test(requestBody[index]!)) index += 1;
    if (requestBody[index] === ']' || requestBody[index] !== '{') break;
    let depth = 0;
    let inString = false;
    let escaped = false;
    const start = index;
    let end = -1;
    for (; index < limit; index += 1) {
      const ch = requestBody[index]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          end = index;
          break;
        }
      }
    }
    if (end < 0) break;
    try {
      messages.push(JSON.parse(requestBody.slice(start, end + 1)));
    } catch {
      // malformed element: keep scanning after it
    }
    index = end + 1;
  }
  return messages;
}

/** Tool-call timeline for one interaction: the in-progress chain recovered from the
 *  request context plus the calls this response itself made. Template-shape based —
 *  no model- or provider-specific branches. The same call id reappears in the next
 *  request's history, so identical events are de-duplicated here. */
export function extractToolEvents(
  requestBody: string | undefined,
  responseBody: string | undefined,
): UosToolEvent[] {
  const events: UosToolEvent[] = [];
  const request = (requestBody ?? '').trim();
  if (request) {
    let messages: unknown[] | undefined;
    try {
      const parsed = JSON.parse(request) as { messages?: unknown[] };
      if (Array.isArray(parsed.messages)) messages = parsed.messages;
    } catch {
      // capture-window truncation: salvage the complete prefix of the messages array
      messages = salvageCompleteMessages(request);
    }
    if (messages) events.push(...historyToolEvents(messages));
  }
  events.push(...responseToolEvents(responseBody ?? ''));
  const seen = new Set<string>();
  const unique: UosToolEvent[] = [];
  for (const event of events) {
    const key = `${event.kind}:${event.toolCallId ?? `${event.name}:${event.detail.slice(0, 64)}`}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(event);
  }
  // Over budget: keep the most recent events — they are the chain that produced this call.
  return unique.length > TOOL_EVENTS_MAX ? unique.slice(unique.length - TOOL_EVENTS_MAX) : unique;
}

/** Reassemble assistant text from an OpenAI-compatible SSE stream or a plain JSON response. */
export function extractAssistantResponse(responseBody: string | undefined): string {
  if (!responseBody) return '';
  const trimmed = responseBody.trim();
  if (trimmed.startsWith('data:') || trimmed.includes('\ndata:')) {
    let assembled = '';
    let reasoning = '';
    let finishReason = '';
    const toolCalls = new Map<number, ToolCallSlot>();
    for (const line of trimmed.split('\n')) {
      const clean = line.trim();
      if (!clean.startsWith('data:')) continue;
      const data = clean.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const chunk = JSON.parse(data) as {
          choices?: Array<{
            delta?: {
              content?: string;
              tool_calls?: Array<{
                index?: number;
                id?: string;
                function?: { name?: string; arguments?: string };
              }>;
            };
            message?: { content?: string };
            finish_reason?: string | null;
          }>;
        };
        const choice = chunk.choices?.[0];
        const delta = choice?.delta as { content?: string; reasoning_content?: string } | undefined;
        if (delta?.reasoning_content) reasoning += delta.reasoning_content;
        if (delta?.content) assembled += delta.content;
        else if (choice?.message?.content) assembled += choice.message.content;
        for (const call of choice?.delta?.tool_calls ?? []) {
          accumulateStreamedToolCall(toolCalls, call);
        }
        if (choice?.finish_reason) finishReason = choice.finish_reason;
      } catch {
        // tolerate partial chunks at capture boundaries
      }
    }
    let body = reasoning
      ? `[推理过程]\n${reasoning}${assembled ? `\n\n[最终回复]\n${assembled}` : ''}`
      : assembled;
    if (toolCalls.size > 0) {
      const rendered = [...toolCalls.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, call]) => {
          const args = call.arguments.length > 600 ? `${call.arguments.slice(0, 600)}…` : call.arguments;
          return `[工具调用] ${call.name || '(unnamed)'}(${args})`;
        })
        .join('\n');
      body = body ? `${body}\n${rendered}` : rendered;
    }
    // Structured-output nodes (intent parsers etc.) answer with a bare JSON object; pretty-print
    // it so the bubble reads as fields instead of one opaque line. Prose replies pass through.
    if (!reasoning && toolCalls.size === 0 && body.trimStart().startsWith('{')) {
      try {
        return JSON.stringify(JSON.parse(body), null, 2);
      } catch {
        // not pure JSON — keep the assembled text
      }
    }
    return finishReason && !body ? `(finish_reason: ${finishReason})` : body;
  }
  try {
    const parsed = JSON.parse(trimmed) as {
      choices?: Array<{ message?: { content?: string } }>;
      results?: Array<{ index?: number; relevance_score?: number; document?: { text?: string } }>;
      data?: Array<{ embedding?: unknown }>;
      usage?: { total_tokens?: number; prompt_tokens?: number };
    };
    // Non-chat model responses on the same gateway: rerank scores / embedding vectors.
    const rerank = rerankResponseText(parsed);
    if (rerank) return rerank;
    const embedding = embeddingResponseText(parsed);
    if (embedding) return embedding;
    const content = parsed.choices?.[0]?.message?.content ?? '';
    if (content.trimStart().startsWith('{')) {
      try {
        return JSON.stringify(JSON.parse(content), null, 2);
      } catch {
        // keep raw content
      }
    }
    return content;
  } catch {
    return trimmed.slice(0, 2_000);
  }
}

export function uosConversationId(row: UosInteractionRow): string {
  const anchor = row.sessionId || row.canonicalSessionId || row.agentInstanceId || row.interactionId || 'unknown';
  return `${UOS_CONVERSATION_PREFIX}${anchor}`;
}

export function uosConversationAnchor(conversationId: string): string {
  return conversationId.startsWith(UOS_CONVERSATION_PREFIX)
    ? conversationId.slice(UOS_CONVERSATION_PREFIX.length)
    : conversationId;
}

export function isUosContentInteractionId(interactionId: string): boolean {
  return UOS_CONTENT_SUFFIX.test(interactionId) && interactionId.startsWith('mi_');
}

export function uosBaseInteractionId(interactionId: string): string {
  return interactionId.replace(UOS_CONTENT_SUFFIX, '');
}

const capture = (row: UosInteractionRow): InteractionContentCapture => ({
  captureMethod: row.tlsAdapterId ? 'ebpf_openssl' : 'ebpf_rustls',
  captureProfile: 'exact_pid_runtime',
  captureMode: 'encrypted_full',
  captureCompleteness: 'partial',
  parseStatus: 'parsed',
  rawRetentionState: 'encrypted',
  presentationState: 'redacted',
});

const endpointHost = (endpoint: string | undefined): string => {
  if (!endpoint) return '';
  const match = /^([^/]+)/u.exec(endpoint);
  return match?.[1] ?? '';
};

/** Map one plaintext interaction row into the upstream instruction+response record pair. */
export function uosRowToRecords(
  row: UosInteractionRow,
): Array<InteractionInstructionRecord | InteractionResponseRecord> {
  if (!row.interactionId || !row.at) return [];
  const conversationId = uosConversationId(row);
  const observedAt = Number(row.at);
  const base = {
    sourceEventId: `uos_plaintext:${row.interactionId}`,
    collectorId: row.collectorId ?? 'unknown',
    observedAt,
    ...(row.agentInstanceId ? { agentInstanceId: row.agentInstanceId } : {}),
    ...(row.workspacePath ? { workspacePath: row.workspacePath } : {}),
    conversationId,
    sourceId: row.sourceId ?? 'uos_plaintext',
    tenantId: 'tenant_default',
    processInstanceId: row.agentInstanceId ?? row.collectorId ?? 'unknown',
    turnCorrelation: 'unassigned' as const,
    acceptedAt: observedAt,
  };
  const requestPath = row.path ?? '/';
  const providerHost = endpointHost(row.endpoint);
  const protocol = 'chat_completions_api' as const;

  const instruction = extractUserInstruction(row.request?.body);
  const response = extractAssistantResponse(row.response?.body);
  const records: Array<InteractionInstructionRecord | InteractionResponseRecord> = [];
  records.push({
    ...base,
    schemaVersion: INTERACTION_INSTRUCTION_SCHEMA,
    eventType: 'AgentInputObserved',
    interactionId: `${row.interactionId}:in`,
    input: {
      protocol,
      inputScope: 'llm_request_user_message',
      requestPath,
      transportProtocol: 'http1',
      providerHost,
      endpointAttribution: 'observed_headers',
      ...(row.model ? { model: row.model } : {}),
    },
    capture: capture(row),
    userInstruction: {
      eventType: 'UserInstructionObserved',
      messageRole: 'user',
      contentBytes: Buffer.byteLength(instruction),
      contentSha256: sha256(instruction),
      contentRef: `uos://${row.interactionId}/request`,
    },
  });
  records.push({
    ...base,
    schemaVersion: INTERACTION_RESPONSE_SCHEMA,
    eventType: 'AgentOutputObserved',
    interactionId: `${row.interactionId}:out`,
    output: {
      protocol,
      outputScope: 'llm_response_assistant_message',
      requestPath,
      transportProtocol: 'http1',
      providerHost,
      endpointAttribution: 'observed_headers',
      ...(row.model ? { model: row.model } : {}),
      ...(row.statusCode ? { statusCode: row.statusCode } : {}),
      ...(row.usage?.inputTokens !== undefined ? { inputTokens: row.usage.inputTokens } : {}),
      ...(row.usage?.outputTokens !== undefined ? { outputTokens: row.usage.outputTokens } : {}),
      ...(row.usage?.totalTokens !== undefined ? { totalTokens: row.usage.totalTokens } : {}),
    },
    capture: capture(row),
    assistantResponse: {
      eventType: 'AssistantResponseObserved',
      messageRole: 'assistant',
      phase: 'final_answer',
      contentBytes: Buffer.byteLength(response),
      contentSha256: sha256(response),
      contentRef: `uos://${row.interactionId}/response`,
    },
  });
  return records;
}

export type { InteractionConversationSummary };
