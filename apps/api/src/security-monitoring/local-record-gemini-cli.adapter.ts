import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type {
  LocalRecordDetailMetrics,
  LocalRecordTimelineEvent,
  LocalRecordTokenUsage,
} from './local-record-tracking.types';

type JsonObject = Record<string, unknown>;

export interface ParsedGeminiCliRecord {
  sessionId: string;
  title: string;
  cwd?: string;
  model?: string;
  modelProvider: 'google';
  originator: 'gemini-cli';
  startedAt: number;
  updatedAt: number;
  fileBytes: number;
  events: LocalRecordTimelineEvent[];
  metrics: LocalRecordDetailMetrics;
}

const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_CONTENT_CHARS = 64 * 1024;

function objectValue(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function cleanText(value: unknown, limit = MAX_CONTENT_CHARS): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/\u0000/gu, '').trim();
  if (!normalized) return undefined;
  return normalized.length <= limit
    ? normalized
    : `${normalized.slice(0, limit)}\n…（内容已截断）`;
}

function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
}

function timestampMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value < 10_000_000_000 ? value * 1_000 : value);
  }
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function contentText(value: unknown): string | undefined {
  if (typeof value === 'string') return cleanText(value);
  if (Array.isArray(value)) {
    return cleanText(value.flatMap((item) => {
      if (typeof item === 'string') return [item];
      const part = objectValue(item);
      const text = cleanText(part?.text);
      return text ? [text] : [];
    }).join('\n'));
  }
  const object = objectValue(value);
  return cleanText(object?.text ?? object?.content ?? object?.output);
}

function isFunctionResponseOnly(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every((item) => {
    const part = objectValue(item);
    return Boolean(part && (
      part.functionResponse !== undefined
      || part.function_response !== undefined
      || part.toolResponse !== undefined
    ));
  });
}

function isHumanPrompt(message: JsonObject, prompt: string): boolean {
  if (isFunctionResponseOnly(message.content)) return false;
  if (message.synthetic === true || message.isMeta === true) return false;
  const normalized = prompt.trimStart().toLocaleLowerCase();
  return ![
    '<session_context>',
    '<hook_context>',
    '<system-reminder>',
  ].some((prefix) => normalized.startsWith(prefix));
}

function emptyUsage(): LocalRecordTokenUsage {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  };
}

function addUsage(target: LocalRecordTokenUsage, raw: unknown): void {
  const usage = objectValue(raw);
  if (!usage) return;
  const input = numberValue(usage.input ?? usage.promptTokenCount);
  const output = numberValue(usage.output ?? usage.candidatesTokenCount);
  const cached = numberValue(usage.cached ?? usage.cachedContentTokenCount);
  const thoughts = numberValue(usage.thoughts ?? usage.thoughtsTokenCount);
  const total = numberValue(usage.total ?? usage.totalTokenCount);
  target.inputTokens += input;
  target.outputTokens += output;
  target.cachedInputTokens += cached;
  target.reasoningOutputTokens += thoughts;
  // Gemini's total is authoritative and already accounts for its cached/thought token
  // semantics. Only reconstruct it for older records that omit the total.
  target.totalTokens += total || input + output + thoughts;
}

function eventId(recordId: string, source: string): string {
  return createHash('sha256')
    .update(`${recordId}:gemini_cli:${source}`)
    .digest('hex')
    .slice(0, 24);
}

function status(value: unknown): 'observed' | 'success' | 'failure' | 'unknown' {
  const normalized = cleanText(value, 64)?.toLocaleLowerCase();
  if (['success', 'succeeded', 'ok', 'completed'].includes(normalized ?? '')) return 'success';
  if (['error', 'failed', 'failure', 'cancelled', 'canceled', 'rejected'].includes(normalized ?? '')) {
    return 'failure';
  }
  if (['scheduled', 'validating', 'executing', 'running'].includes(normalized ?? '')) return 'observed';
  return 'unknown';
}

function toolArguments(value: unknown): {
  content?: string;
  command?: string;
  workdir?: string;
} {
  const input = objectValue(value);
  if (!input) return {};
  const serialized = cleanText(JSON.stringify(input, null, 2));
  return {
    ...(serialized ? { content: serialized } : {}),
    ...(cleanText(input.command ?? input.cmd, 16 * 1024)
      ? { command: cleanText(input.command ?? input.cmd, 16 * 1024) }
      : {}),
    ...(cleanText(input.workdir ?? input.cwd ?? input.working_directory, 4_096)
      ? { workdir: cleanText(input.workdir ?? input.cwd ?? input.working_directory, 4_096) }
      : {}),
  };
}

/**
 * Gemini historically rewrote one JSON document per Session. Newer releases may append
 * JSONL metadata/message records. Normalize both without treating an incomplete final line as
 * corruption while the CLI is still writing.
 */
function conversationFromSource(source: string): JsonObject | undefined {
  try {
    const parsed = objectValue(JSON.parse(source) as unknown);
    if (parsed) return parsed;
  } catch {
    // Fall through to the append-only JSONL reader.
  }

  const metadata: JsonObject = {};
  const messages: JsonObject[] = [];
  const messageIndex = new Map<string, number>();
  for (const rawLine of source.split('\n')) {
    if (!rawLine.trim()) continue;
    let record: JsonObject | undefined;
    try {
      record = objectValue(JSON.parse(rawLine) as unknown);
    } catch {
      continue;
    }
    if (!record) continue;
    const update = objectValue(record.$set);
    if (update) {
      Object.assign(metadata, update);
      if (Array.isArray(update.messages)) {
        messages.splice(0, messages.length);
        messageIndex.clear();
        for (const item of update.messages) {
          const message = objectValue(item);
          if (!message) continue;
          const id = cleanText(message.id, 512);
          if (id) messageIndex.set(id, messages.length);
          messages.push(message);
        }
      }
      continue;
    }
    const rewindTo = cleanText(record.$rewindTo, 512);
    if (rewindTo) {
      const index = messageIndex.get(rewindTo);
      if (index !== undefined) {
        messages.splice(index + 1);
        messageIndex.clear();
        messages.forEach((message, position) => {
          const id = cleanText(message.id, 512);
          if (id) messageIndex.set(id, position);
        });
      }
      continue;
    }
    if (cleanText(record.type, 64) && cleanText(record.id, 512)) {
      const id = cleanText(record.id, 512)!;
      const existing = messageIndex.get(id);
      if (existing === undefined) {
        messageIndex.set(id, messages.length);
        messages.push(record);
      } else {
        messages[existing] = record;
      }
      continue;
    }
    Object.assign(metadata, record);
    if (Array.isArray(record.messages)) {
      messages.splice(0, messages.length);
      messageIndex.clear();
      for (const item of record.messages) {
        const message = objectValue(item);
        if (!message) continue;
        const id = cleanText(message.id, 512);
        if (id) messageIndex.set(id, messages.length);
        messages.push(message);
      }
    }
  }
  return Object.keys(metadata).length > 0 || messages.length > 0
    ? { ...metadata, messages }
    : undefined;
}

async function workspaceFromProjectRegistry(
  sessionPath: string,
  projectIdentifier: string | undefined,
): Promise<string | undefined> {
  if (!projectIdentifier) return undefined;
  let directory = dirname(sessionPath);
  for (let depth = 0; depth < 6; depth += 1) {
    const registryPath = join(directory, 'projects.json');
    try {
      const details = await stat(registryPath);
      if (!details.isFile() || details.size > 2 * 1024 * 1024) return undefined;
      const registry = objectValue(JSON.parse(await readFile(registryPath, 'utf8')) as unknown);
      const projects = objectValue(registry?.projects);
      if (!projects) return undefined;
      return Object.entries(projects).find(([, identifier]) => identifier === projectIdentifier)?.[0];
    } catch {
      // Continue towards the global .gemini directory.
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}

export async function parseGeminiCliRecord(
  sessionPath: string,
  recordId: string,
): Promise<ParsedGeminiCliRecord | undefined> {
  let details;
  let source: string;
  try {
    details = await stat(sessionPath);
    if (!details.isFile() || details.size > MAX_SOURCE_BYTES) return undefined;
    source = await readFile(sessionPath, 'utf8');
  } catch {
    return undefined;
  }
  const root = conversationFromSource(source);
  if (!root) return undefined;
  const messages = Array.isArray(root.messages)
    ? root.messages.map(objectValue).filter((item): item is JsonObject => Boolean(item))
    : [];
  if (messages.length === 0 && !cleanText(root.sessionId, 512)) return undefined;

  const fileSessionId = basename(sessionPath).replace(/^session-/u, '').replace(/\.jsonl?$/u, '');
  const sessionId = cleanText(root.sessionId, 512) ?? fileSessionId;
  const projectIdentifier = cleanText(root.projectHash, 512);
  const cwd = cleanText(root.cwd ?? root.projectPath ?? root.workspace, 4_096)
    ?? await workspaceFromProjectRegistry(sessionPath, projectIdentifier);
  let startedAt = timestampMs(root.startTime) ?? Math.trunc(details.birthtimeMs || details.mtimeMs);
  let updatedAt = timestampMs(root.lastUpdated) ?? Math.trunc(details.mtimeMs);
  let model: string | undefined;
  let currentTurnId: string | undefined;
  let currentTurnStartedAt: number | undefined;
  let turnSequence = 0;
  let lastEventAt = startedAt;
  const events: LocalRecordTimelineEvent[] = [];
  const usage = emptyUsage();

  const push = (sourceKey: string, sourceOffset: number, event: Omit<LocalRecordTimelineEvent, 'eventId' | 'sourceOffset'>) => {
    const complete = { ...event, eventId: eventId(recordId, sourceKey), sourceOffset };
    events.push(complete);
    lastEventAt = Math.max(lastEventAt, complete.timestamp);
    return complete;
  };
  const closeTurn = (timestamp: number, sourceOffset: number) => {
    if (!currentTurnId || currentTurnStartedAt === undefined) return;
    push(`turn:${currentTurnId}:complete`, sourceOffset, {
      kind: 'turn_complete',
      timestamp: Math.max(timestamp, currentTurnStartedAt),
      turnId: currentTurnId,
      title: 'Turn 完成',
      status: 'success',
      durationMs: Math.max(0, timestamp - currentTurnStartedAt),
    });
  };

  for (const [messageIndex, message] of messages.entries()) {
    const type = cleanText(message.type, 64)?.toLocaleLowerCase();
    const timestamp = timestampMs(message.timestamp) ?? lastEventAt;
    const messageId = cleanText(message.id, 512) ?? `message-${messageIndex + 1}`;
    const baseOffset = (messageIndex + 1) * 1_000;
    startedAt = Math.min(startedAt, timestamp);
    updatedAt = Math.max(updatedAt, timestamp);

    if (type === 'user') {
      const prompt = contentText(message.displayContent) ?? contentText(message.content);
      if (!prompt || !isHumanPrompt(message, prompt)) continue;
      closeTurn(timestamp, Math.max(1, baseOffset - 1));
      turnSequence += 1;
      currentTurnId = `${sessionId}:turn:${turnSequence}:${messageId}`;
      currentTurnStartedAt = timestamp;
      push(`turn:${currentTurnId}:start`, baseOffset, {
        kind: 'turn_start', timestamp, turnId: currentTurnId, title: 'Turn 开始', status: 'observed',
      });
      push(`turn:${currentTurnId}:prompt`, baseOffset + 1, {
        kind: 'user_message', timestamp, turnId: currentTurnId, role: 'user',
        phase: 'human_instruction', title: '用户指令', content: prompt, status: 'observed',
      });
      continue;
    }

    if (type !== 'gemini' && type !== 'assistant' && type !== 'model') continue;
    model = cleanText(message.model, 256) ?? model;
    addUsage(usage, message.tokens);
    const response = contentText(message.displayContent) ?? contentText(message.content);
    if (response) {
      push(`assistant:${messageId}`, baseOffset, {
        kind: 'assistant_message', timestamp, turnId: currentTurnId,
        role: 'assistant', title: 'Agent 回复', content: response, status: 'observed',
      });
    }
    const toolCalls = Array.isArray(message.toolCalls)
      ? message.toolCalls.map(objectValue).filter((item): item is JsonObject => Boolean(item))
      : [];
    for (const [toolIndex, call] of toolCalls.entries()) {
      const callId = cleanText(call.id, 512) ?? `${messageId}:tool:${toolIndex + 1}`;
      const name = cleanText(call.name, 256) ?? 'tool';
      const toolAt = timestampMs(call.timestamp) ?? timestamp;
      const args = toolArguments(call.args ?? call.arguments);
      const resultStatus = status(call.status);
      push(`tool:${callId}`, baseOffset + toolIndex * 10 + 1, {
        kind: 'tool_call', timestamp: toolAt, turnId: currentTurnId, role: 'system',
        title: `调用 ${name}`, toolName: name, callId,
        ...(args.content ? { content: args.content } : {}),
        ...(args.command ? { command: args.command } : {}),
        ...(args.workdir ? { workdir: args.workdir } : {}),
        status: resultStatus === 'unknown' ? 'observed' : resultStatus,
      });
      const result = contentText(call.resultDisplay) ?? contentText(call.result);
      if (result || resultStatus === 'success' || resultStatus === 'failure') {
        push(`tool-result:${callId}`, baseOffset + toolIndex * 10 + 2, {
          kind: 'tool_result', timestamp: toolAt, turnId: currentTurnId, role: 'system',
          title: `${name}结果`, toolName: name, callId,
          ...(result ? { content: result } : {}),
          status: resultStatus,
        });
      }
    }
  }

  closeTurn(lastEventAt, (messages.length + 1) * 1_000 - 1);
  events.sort((left, right) => left.sourceOffset - right.sourceOffset);
  const prompts = events.filter((event) => event.kind === 'user_message');
  const assistants = events.filter((event) => event.kind === 'assistant_message');
  const calls = events.filter((event) => event.kind === 'tool_call');
  const results = events.filter((event) => event.kind === 'tool_result');
  const completed = events.filter((event) => event.kind === 'turn_complete');
  return {
    sessionId,
    title: cleanText(prompts[0]?.content, 180) ?? `Gemini CLI 记录 ${sessionId.slice(0, 8)}`,
    ...(cwd ? { cwd } : {}),
    ...(model ? { model } : {}),
    modelProvider: 'google',
    originator: 'gemini-cli',
    startedAt,
    updatedAt: Math.max(updatedAt, lastEventAt),
    fileBytes: details.size,
    events,
    metrics: {
      scope: 'full_record',
      scannedBytes: details.size,
      fileBytes: details.size,
      messageCount: prompts.length + assistants.length,
      userMessageCount: prompts.length,
      assistantMessageCount: assistants.length,
      turnCount: events.filter((event) => event.kind === 'turn_start').length,
      completeTurnCount: completed.length,
      toolCallCount: calls.length,
      toolResultCount: results.length,
      toolFailureCount: results.filter((event) => event.status === 'failure').length,
      completedDurationMs: completed.reduce((sum, event) => sum + (event.durationMs ?? 0), 0),
      tokenUsage: usage,
    },
  };
}
