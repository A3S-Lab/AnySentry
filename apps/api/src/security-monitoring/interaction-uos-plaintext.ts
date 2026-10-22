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
    const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
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
  } catch {
    const salvaged = salvageTruncatedRequest(requestBody);
    return salvaged || requestBody.slice(0, 2_000);
  }
}

/** LLM-shaped traffic only: the whitelist captures every HTTP egress of the Agent containers,
 *  including business callbacks and IM traffic that must not become conversations. Rerank and
 *  embeddings endpoints are model-inference calls on the same gateway, so they count too. */
export function isLlmShapedRow(row: UosInteractionRow): boolean {
  const path = row.path ?? '';
  if (/(?:chat\/)?completions|generate_?content|responses(?:\.json)?$|\/(?:rerank|embeddings)$/iu.test(path)) return true;
  const response = row.response?.body ?? '';
  if (response.includes('chat.completion')) return true;
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

/** Reassemble assistant text from an OpenAI-compatible SSE stream or a plain JSON response. */
export function extractAssistantResponse(responseBody: string | undefined): string {
  if (!responseBody) return '';
  const trimmed = responseBody.trim();
  if (trimmed.startsWith('data:') || trimmed.includes('\ndata:')) {
    let assembled = '';
    let reasoning = '';
    let finishReason = '';
    const toolCalls = new Map<number, { name: string; arguments: string }>();
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
        // OpenAI-compatible tool-call streaming: arguments arrive fragmented per index;
        // assemble per index like AgentSight's SSE processor does.
        for (const call of choice?.delta?.tool_calls ?? []) {
          const slot = call.index ?? 0;
          const current = toolCalls.get(slot) ?? { name: '', arguments: '' };
          if (call.function?.name) current.name += call.function.name;
          if (call.function?.arguments) current.arguments += call.function.arguments;
          toolCalls.set(slot, current);
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
