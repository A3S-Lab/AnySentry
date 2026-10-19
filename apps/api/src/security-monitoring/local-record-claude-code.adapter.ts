import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import type {
  LocalRecordDetailMetrics,
  LocalRecordTimelineEvent,
  LocalRecordTokenUsage,
} from './local-record-tracking.types';

type JsonObject = Record<string, unknown>;

export interface ParsedClaudeCodeRecord {
  sessionId: string;
  title: string;
  cwd?: string;
  model?: string;
  modelProvider: 'anthropic';
  originator: 'claude-code';
  cliVersion?: string;
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

function emptyUsage(): LocalRecordTokenUsage {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  };
}

function addClaudeUsage(target: LocalRecordTokenUsage, raw: unknown): void {
  const usage = objectValue(raw);
  if (!usage) return;
  const input = numberValue(usage.input_tokens ?? usage.inputTokens);
  const output = numberValue(usage.output_tokens ?? usage.outputTokens);
  const cacheCreation = numberValue(
    usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens,
  );
  const cacheRead = numberValue(
    usage.cache_read_input_tokens ?? usage.cacheReadInputTokens,
  );
  target.inputTokens += input;
  target.cachedInputTokens += cacheCreation + cacheRead;
  target.outputTokens += output;
  target.totalTokens += input + cacheCreation + cacheRead + output;
}

function eventId(recordId: string, source: string): string {
  return createHash('sha256')
    .update(`${recordId}:claude_code:${source}`)
    .digest('hex')
    .slice(0, 24);
}

function contentBlocks(value: unknown): JsonObject[] {
  return Array.isArray(value)
    ? value.map(objectValue).filter((item): item is JsonObject => Boolean(item))
    : [];
}

function contentText(value: unknown): string | undefined {
  if (typeof value === 'string') return cleanText(value);
  const parts: string[] = [];
  for (const block of contentBlocks(value)) {
    const type = cleanText(block.type, 64);
    if (type === 'tool_use' || type === 'tool_result' || type === 'function_call') continue;
    const value = type === 'thinking'
      ? cleanText(block.thinking)
      : cleanText(block.text ?? block.content);
    if (value) parts.push(value);
  }
  return cleanText(parts.join('\n'));
}

function isToolResultContent(value: unknown): boolean {
  const blocks = contentBlocks(value);
  return blocks.length > 0 && blocks.every((block) => block.type === 'tool_result');
}

function isHumanPrompt(record: JsonObject, content: unknown, value: string): boolean {
  if (
    record.isMeta === true
    || record.sourceToolUseID !== undefined
    || record.sourceToolAssistantUUID !== undefined
    || record.attachment !== undefined
    || record.attachments !== undefined
    || record.image !== undefined
    || record.images !== undefined
  ) return false;
  const blocks = contentBlocks(content);
  if (blocks.length > 0 && blocks.every((block) =>
    ['attachment', 'document', 'file', 'image'].includes(String(block.type)))) return false;
  return ![
    '<local-command-caveat>',
    '<local-command-stdout>',
    '<system-reminder>',
    '<ide_opened_file>',
    '<ide_selection>',
  ].some((prefix) => value.startsWith(prefix));
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
    ...(cleanText(input.workdir ?? input.working_directory ?? input.cwd, 4_096)
      ? { workdir: cleanText(input.workdir ?? input.working_directory ?? input.cwd, 4_096) }
      : {}),
  };
}

function resultText(value: unknown): string | undefined {
  if (typeof value === 'string') return cleanText(value);
  if (Array.isArray(value)) {
    return cleanText(value.map((item) => {
      if (typeof item === 'string') return item;
      const object = objectValue(item);
      return cleanText(object?.text ?? object?.content) ?? '';
    }).filter(Boolean).join('\n'));
  }
  const object = objectValue(value);
  return cleanText(object?.text ?? object?.content ?? JSON.stringify(value));
}

export async function parseClaudeCodeRecord(
  sessionPath: string,
  recordId: string,
): Promise<ParsedClaudeCodeRecord | undefined> {
  let details;
  let source: string;
  try {
    details = await stat(sessionPath);
    if (!details.isFile() || details.size > MAX_SOURCE_BYTES) return undefined;
    source = await readFile(sessionPath, 'utf8');
  } catch {
    return undefined;
  }

  const records: Array<{ line: number; value: JsonObject }> = [];
  for (const [index, rawLine] of source.split('\n').entries()) {
    if (!rawLine.trim()) continue;
    try {
      const value = objectValue(JSON.parse(rawLine) as unknown);
      if (value) records.push({ line: index + 1, value });
    } catch {
      // Claude appends JSONL in place; an incomplete final record is expected while running.
    }
  }
  if (records.length === 0) return undefined;

  let sessionId = basename(sessionPath, '.jsonl');
  let cwd: string | undefined;
  let model: string | undefined;
  let cliVersion: string | undefined;
  let startedAt = Math.trunc(details.birthtimeMs || details.mtimeMs);
  let updatedAt = Math.trunc(details.mtimeMs);
  let currentTurnId: string | undefined;
  let currentTurnStartedAt: number | undefined;
  let turnSequence = 0;
  let lastPromptId: string | undefined;
  let lastEventAt = startedAt;
  let fallbackPrompt: string | undefined;
  const events: LocalRecordTimelineEvent[] = [];
  const usage = emptyUsage();
  const seenUsage = new Set<string>();
  const assistantEvents = new Map<string, LocalRecordTimelineEvent>();
  const toolCalls = new Map<string, LocalRecordTimelineEvent>();

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
  const startPrompt = (prompt: string, record: JsonObject, timestamp: number, sourceOffset: number) => {
    const promptId = cleanText(record.promptId, 512);
    if (promptId && promptId === lastPromptId) return;
    closeTurn(timestamp, Math.max(1, sourceOffset - 1));
    turnSequence += 1;
    currentTurnId = promptId ?? `${sessionId}:turn:${turnSequence}`;
    currentTurnStartedAt = timestamp;
    lastPromptId = promptId;
    push(`turn:${currentTurnId}:start`, sourceOffset, {
      kind: 'turn_start', timestamp, turnId: currentTurnId, title: 'Turn 开始', status: 'observed',
    });
    push(`turn:${currentTurnId}:prompt`, sourceOffset + 1, {
      kind: 'user_message', timestamp, turnId: currentTurnId, role: 'user',
      phase: 'human_instruction', title: '用户指令', content: prompt, status: 'observed',
    });
  };

  for (const { line, value: record } of records) {
    const type = cleanText(record.type, 64);
    const timestamp = timestampMs(record.timestamp) ?? lastEventAt;
    updatedAt = Math.max(updatedAt, timestamp);
    sessionId = cleanText(record.sessionId ?? record.session_id, 512) ?? sessionId;
    cwd = cleanText(record.cwd, 4_096) ?? cwd;
    cliVersion = cleanText(record.version ?? record.cliVersion, 128) ?? cliVersion;
    const message = objectValue(record.message);
    const content = message?.content;
    const baseOffset = line * 100;

    if (type === 'queue-operation' && record.operation === 'enqueue') {
      fallbackPrompt = cleanText(record.content) ?? fallbackPrompt;
      continue;
    }
    if (type === 'last-prompt') {
      fallbackPrompt = cleanText(record.lastPrompt) ?? fallbackPrompt;
      continue;
    }
    if (type === 'user') {
      if (isToolResultContent(content) || record.toolUseResult !== undefined || record.tool_use_result !== undefined) {
        for (const [blockIndex, block] of contentBlocks(content).entries()) {
          if (block.type !== 'tool_result') continue;
          const callId = cleanText(block.tool_use_id, 512);
          const failed = block.is_error === true
            || objectValue(record.toolUseResult)?.is_error === true
            || objectValue(record.tool_use_result)?.is_error === true;
          const knownTool = callId ? toolCalls.get(callId) : undefined;
          if (knownTool) knownTool.status = failed ? 'failure' : 'success';
          push(`tool-result:${callId ?? `${line}:${blockIndex}`}`, baseOffset + blockIndex, {
            kind: 'tool_result', timestamp, turnId: knownTool?.turnId ?? currentTurnId,
            role: 'system', title: `${knownTool?.toolName ?? '工具'}结果`,
            toolName: knownTool?.toolName, callId,
            content: resultText(block.content), status: failed ? 'failure' : 'success',
          });
        }
        continue;
      }
      const prompt = contentText(content);
      if (prompt && isHumanPrompt(record, content, prompt)) {
        startPrompt(prompt, record, timestamp, baseOffset);
      }
      continue;
    }
    if (type === 'assistant') {
      model = cleanText(message?.model, 256) ?? model;
      const completionId = cleanText(message?.id ?? record.requestId ?? record.uuid, 512)
        ?? `${line}`;
      if (!seenUsage.has(completionId)) {
        addClaudeUsage(usage, message?.usage);
        seenUsage.add(completionId);
      }
      const response = contentText(content);
      if (response) {
        const existing = assistantEvents.get(completionId);
        if (existing) {
          if (!existing.content?.includes(response)) {
            existing.content = cleanText([existing.content, response].filter(Boolean).join('\n'));
          }
          existing.timestamp = Math.max(existing.timestamp, timestamp);
        } else {
          const created = push(`assistant:${completionId}`, baseOffset, {
            kind: 'assistant_message', timestamp, turnId: currentTurnId,
            role: 'assistant', title: 'Agent 回复', content: response, status: 'observed',
          });
          assistantEvents.set(completionId, created);
        }
      }
      for (const [blockIndex, block] of contentBlocks(content).entries()) {
        if (block.type !== 'tool_use') continue;
        const callId = cleanText(block.id, 512) ?? `${completionId}:${blockIndex}`;
        if (toolCalls.has(callId)) continue;
        const name = cleanText(block.name, 256) ?? 'tool';
        const args = toolArguments(block.input);
        const created = push(`tool:${callId}`, baseOffset + blockIndex + 1, {
          kind: 'tool_call', timestamp, turnId: currentTurnId, role: 'system',
          title: `调用 ${name}`, toolName: name, callId,
          ...(args.content ? { content: args.content } : {}),
          ...(args.command ? { command: args.command } : {}),
          ...(args.workdir ? { workdir: args.workdir } : {}),
          status: 'observed',
        });
        toolCalls.set(callId, created);
      }
      continue;
    }
    if (type === 'result') {
      const duration = numberValue(record.duration_ms);
      if (duration && currentTurnStartedAt !== undefined) {
        currentTurnStartedAt = Math.min(currentTurnStartedAt, timestamp - duration);
      }
      if (seenUsage.size === 0) {
        const modelUsage = objectValue(record.modelUsage);
        for (const [name, rawUsage] of Object.entries(modelUsage ?? {})) {
          model = model ?? name;
          addClaudeUsage(usage, rawUsage);
        }
      }
    }
  }

  if (!events.some((event) => event.kind === 'user_message') && fallbackPrompt) {
    startPrompt(fallbackPrompt, {}, startedAt, 1);
  }
  closeTurn(lastEventAt, (records.at(-1)?.line ?? 1) * 100 + 99);
  events.sort((left, right) => left.sourceOffset - right.sourceOffset);
  const prompts = events.filter((event) => event.kind === 'user_message');
  const assistants = events.filter((event) => event.kind === 'assistant_message');
  const calls = events.filter((event) => event.kind === 'tool_call');
  const results = events.filter((event) => event.kind === 'tool_result');
  const completed = events.filter((event) => event.kind === 'turn_complete');
  return {
    sessionId,
    title: cleanText(prompts[0]?.content, 180) ?? `Claude Code 记录 ${sessionId.slice(0, 8)}`,
    ...(cwd ? { cwd } : {}),
    ...(model ? { model } : {}),
    modelProvider: 'anthropic',
    originator: 'claude-code',
    ...(cliVersion ? { cliVersion } : {}),
    startedAt: Math.min(startedAt, ...events.map((event) => event.timestamp)),
    updatedAt: Math.max(updatedAt, ...events.map((event) => event.timestamp)),
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
