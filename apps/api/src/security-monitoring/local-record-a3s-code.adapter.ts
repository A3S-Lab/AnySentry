import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type {
  LocalRecordDetailMetrics,
  LocalRecordTimelineEvent,
  LocalRecordTokenUsage,
} from './local-record-tracking.types';

type JsonObject = Record<string, unknown>;

export interface ParsedA3sCodeRecord {
  sessionId: string;
  title: string;
  cwd?: string;
  model?: string;
  modelProvider?: string;
  originator: 'a3s-code-tui';
  startedAt: number;
  updatedAt: number;
  fileBytes: number;
  events: LocalRecordTimelineEvent[];
  metrics: LocalRecordDetailMetrics;
}

const MAX_A3S_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_CONTENT_CHARS = 64 * 1024;

function objectValue(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function text(value: unknown, limit = MAX_CONTENT_CHARS): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/\u0000/gu, '').trim();
  if (!normalized) return undefined;
  return normalized.length <= limit
    ? normalized
    : `${normalized.slice(0, limit)}\n…（内容已截断）`;
}

function numberValue(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
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

function addUsage(target: LocalRecordTokenUsage, raw: unknown): void {
  const usage = objectValue(raw);
  if (!usage) return;
  target.inputTokens += Math.max(0, numberValue(
    usage.prompt_tokens ?? usage.input_tokens,
  ) ?? 0);
  target.outputTokens += Math.max(0, numberValue(
    usage.completion_tokens ?? usage.output_tokens,
  ) ?? 0);
  target.cachedInputTokens += Math.max(0, numberValue(
    usage.cache_read_tokens ?? usage.cached_input_tokens,
  ) ?? 0);
  target.totalTokens += Math.max(0, numberValue(usage.total_tokens) ?? 0);
}

function stableEventId(recordId: string, source: string, sequence: number): string {
  return createHash('sha256')
    .update(`${recordId}:a3s_code:${source}:${sequence}`)
    .digest('hex')
    .slice(0, 24);
}

async function readJson(path: string): Promise<{ value: unknown; bytes: number } | undefined> {
  try {
    const details = await stat(path);
    if (!details.isFile() || details.size > MAX_A3S_SOURCE_BYTES) return undefined;
    return {
      value: JSON.parse(await readFile(path, 'utf8')) as unknown,
      bytes: details.size,
    };
  } catch {
    return undefined;
  }
}

function contentBlocks(value: unknown): JsonObject[] {
  return Array.isArray(value)
    ? value.map(objectValue).filter((item): item is JsonObject => Boolean(item))
    : [];
}

function contentText(value: unknown): string | undefined {
  const blocks = contentBlocks(value);
  return text(blocks
    .filter((block) => block.type === 'text')
    .map((block) => text(block.text) ?? '')
    .filter(Boolean)
    .join('\n'));
}

function toolArguments(value: string): {
  content?: string;
  command?: string;
  workdir?: string;
} {
  const raw = text(value);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    const object = objectValue(parsed);
    return {
      content: text(JSON.stringify(parsed, null, 2)),
      command: text(object?.command ?? object?.cmd, 16 * 1024),
      workdir: text(object?.workdir ?? object?.working_directory, 2_000),
    };
  } catch {
    return { content: raw };
  }
}

function statusFromExitCode(value: unknown): 'success' | 'failure' | 'unknown' {
  const code = numberValue(value);
  if (code === undefined) return 'unknown';
  return code === 0 ? 'success' : 'failure';
}

interface MutableTool {
  id: string;
  name: string;
  timestamp: number;
  input: string;
  output: string;
}

function eventsFromRuns(
  recordId: string,
  runs: unknown[],
  fallbackTimestamp: number,
  usage: LocalRecordTokenUsage,
): LocalRecordTimelineEvent[] {
  const events: LocalRecordTimelineEvent[] = [];
  let sequence = 0;
  const push = (source: string, event: Omit<LocalRecordTimelineEvent, 'eventId' | 'sourceOffset'>) => {
    sequence += 1;
    events.push({
      ...event,
      eventId: stableEventId(recordId, source, sequence),
      sourceOffset: sequence,
    });
  };

  for (const [runIndex, rawRun] of runs.entries()) {
    const run = objectValue(rawRun);
    if (!run) continue;
    const snapshot = objectValue(run.snapshot);
    if (!snapshot) continue;
    const turnId = text(snapshot.id, 512) ?? `a3s-run-${runIndex + 1}`;
    const startedAt = timestampMs(snapshot.created_at_ms) ?? fallbackTimestamp;
    const completedAt = timestampMs(snapshot.updated_at_ms) ?? startedAt;
    push(`run:${turnId}:start`, {
      kind: 'turn_start',
      timestamp: startedAt,
      turnId,
      title: 'Run 开始',
      status: 'observed',
    });
    const prompt = text(snapshot.prompt);
    if (prompt) {
      push(`run:${turnId}:prompt`, {
        kind: 'user_message',
        timestamp: startedAt,
        turnId,
        role: 'user',
        phase: 'human_instruction',
        title: '用户指令',
        content: prompt,
        status: 'observed',
      });
    }

    const activeTools = new Map<string, MutableTool>();
    let currentToolId: string | undefined;
    for (const [eventIndex, rawEnvelope] of (Array.isArray(run.events) ? run.events : []).entries()) {
      const envelope = objectValue(rawEnvelope);
      const event = objectValue(envelope?.event);
      const type = text(event?.type, 128);
      const eventTimestamp = timestampMs(envelope?.timestamp_ms) ?? startedAt + eventIndex;
      if (type === 'turn_end') addUsage(usage, event?.usage);
      if (type === 'tool_start') {
        const id = text(event?.id, 512) ?? `${turnId}:tool:${eventIndex}`;
        const tool: MutableTool = {
          id,
          name: text(event?.name, 256) ?? 'tool',
          timestamp: eventTimestamp,
          input: '',
          output: '',
        };
        activeTools.set(id, tool);
        currentToolId = id;
        continue;
      }
      if (type === 'tool_input_delta' && currentToolId) {
        const tool = activeTools.get(currentToolId);
        if (tool && typeof event?.delta === 'string') tool.input += event.delta;
        continue;
      }
      if (type === 'tool_output_delta' && currentToolId) {
        const tool = activeTools.get(currentToolId);
        if (tool && typeof event?.delta === 'string') tool.output += event.delta;
        continue;
      }
      if (type === 'tool_end') {
        const id = text(event?.id, 512) ?? currentToolId;
        const tool = id ? activeTools.get(id) : undefined;
        const name = text(event?.name, 256) ?? tool?.name ?? 'tool';
        const args = toolArguments(tool?.input ?? '');
        push(`run:${turnId}:tool:${id ?? eventIndex}`, {
          kind: 'tool_call',
          timestamp: tool?.timestamp ?? eventTimestamp,
          turnId,
          role: 'system',
          title: `调用 ${name}`,
          toolName: name,
          callId: id,
          ...(args.content ? { content: args.content } : {}),
          ...(args.command ? { command: args.command } : {}),
          ...(args.workdir ? { workdir: args.workdir } : {}),
          status: 'observed',
        });
        const output = text(event?.output) ?? text(tool?.output);
        const resultStatus = statusFromExitCode(event?.exit_code);
        push(`run:${turnId}:tool-result:${id ?? eventIndex}`, {
          kind: 'tool_result',
          timestamp: eventTimestamp,
          turnId,
          role: 'system',
          title: `${name}结果`,
          toolName: name,
          callId: id,
          ...(output ? { content: output } : {}),
          status: resultStatus,
        });
        if (id) activeTools.delete(id);
        currentToolId = [...activeTools.keys()].at(-1);
        continue;
      }
      if (type === 'subagent_start') {
        const taskId = text(event?.task_id, 512) ?? `subagent-${eventIndex}`;
        const agent = text(event?.agent, 128) ?? 'subagent';
        push(`run:${turnId}:subagent:${taskId}`, {
          kind: 'tool_call',
          timestamp: eventTimestamp,
          turnId,
          role: 'system',
          phase: 'agent_internal_instruction',
          title: `启动 Subagent · ${agent}`,
          toolName: `subagent:${agent}`,
          callId: taskId,
          content: text(event?.description),
          status: 'observed',
        });
        continue;
      }
      if (type === 'subagent_end') {
        const taskId = text(event?.task_id, 512) ?? `subagent-${eventIndex}`;
        const agent = text(event?.agent, 128) ?? 'subagent';
        push(`run:${turnId}:subagent-result:${taskId}`, {
          kind: 'tool_result',
          timestamp: eventTimestamp,
          turnId,
          role: 'system',
          phase: 'agent_internal_instruction',
          title: `Subagent 完成 · ${agent}`,
          toolName: `subagent:${agent}`,
          callId: taskId,
          content: text(event?.output),
          status: event?.success === false ? 'failure' : 'success',
        });
      }
    }

    const result = text(snapshot.result_text);
    if (result) {
      push(`run:${turnId}:response`, {
        kind: 'assistant_message',
        timestamp: completedAt,
        turnId,
        role: 'assistant',
        title: 'Agent 回复',
        content: result,
        status: 'observed',
      });
    }
    const runStatus = text(snapshot.status, 64)?.toLocaleLowerCase();
    push(`run:${turnId}:complete`, {
      kind: 'turn_complete',
      timestamp: completedAt,
      turnId,
      title: 'Run 完成',
      status: ['failed', 'error', 'cancelled', 'canceled'].includes(runStatus ?? '')
        ? 'failure'
        : 'success',
      durationMs: Math.max(0, completedAt - startedAt),
    });
  }
  return events;
}

function fallbackEventsFromMessages(
  recordId: string,
  messages: unknown[],
  timestamp: number,
): LocalRecordTimelineEvent[] {
  const events: LocalRecordTimelineEvent[] = [];
  let sequence = 0;
  const turnId = `${recordId}:session`;
  for (const rawMessage of messages) {
    const message = objectValue(rawMessage);
    const role = text(message?.role, 32);
    const blocks = contentBlocks(message?.content);
    const messageText = contentText(message?.content);
    if (messageText && (role === 'user' || role === 'assistant')) {
      sequence += 1;
      events.push({
        eventId: stableEventId(recordId, 'message', sequence),
        kind: role === 'user' ? 'user_message' : 'assistant_message',
        timestamp: timestamp + sequence,
        turnId,
        role,
        phase: role === 'user' ? 'origin_unverified' : undefined,
        title: role === 'user' ? '用户/内部指令（来源未确认）' : 'Agent 回复',
        content: messageText,
        status: 'observed',
        sourceOffset: sequence,
      });
    }
    for (const block of blocks) {
      if (block.type !== 'tool_use') continue;
      sequence += 1;
      const name = text(block.name, 256) ?? 'tool';
      const input = block.input;
      const args = toolArguments(typeof input === 'string' ? input : JSON.stringify(input ?? {}));
      events.push({
        eventId: stableEventId(recordId, 'message-tool', sequence),
        kind: 'tool_call',
        timestamp: timestamp + sequence,
        turnId,
        role: 'system',
        title: `调用 ${name}`,
        toolName: name,
        callId: text(block.id, 512),
        content: args.content,
        command: args.command,
        workdir: args.workdir,
        status: 'observed',
        sourceOffset: sequence,
      });
    }
  }
  return events;
}

export async function parseA3sCodeRecord(
  sessionPath: string,
  recordId: string,
): Promise<ParsedA3sCodeRecord | undefined> {
  const mainRead = await readJson(sessionPath);
  const root = objectValue(mainRead?.value);
  if (!root || !mainRead) return undefined;
  if (!objectValue(root.session) && !text(root.id, 512)) return undefined;
  // A3S Code v1 wraps the payload in a top-level `session` object. Keep the
  // flat shape for older records already present on disk.
  const session = objectValue(root.session) ?? root;
  const fileName = basename(sessionPath);
  const sessionId = text(session.id, 512) ?? basename(fileName, '.json');
  const sessionDirectory = dirname(sessionPath);
  // Flat layouts keep companions next to the session file. A3S v1 nests the
  // canonical document under `v1/sessions/` while runs/traces stay at the
  // sessions root and are keyed by `session.id`.
  const sessionsRoot =
    basename(sessionDirectory) === 'sessions'
    && basename(dirname(sessionDirectory)) === 'v1'
      ? dirname(dirname(sessionDirectory))
      : sessionDirectory;
  const companionNames = [...new Set([
    fileName,
    `${sessionId}.json`,
  ])];
  const companionFolders = ['runs', 'traces', 'subagent_tasks', 'verification'] as const;
  const companionReads = await Promise.all(
    companionFolders.map(async (folder) => {
      for (const name of companionNames) {
        for (const base of [sessionsRoot, sessionDirectory]) {
          const read = await readJson(join(base, folder, name));
          if (read) return read;
        }
      }
      return undefined;
    }),
  );
  const [runsRead, tracesRead, subagentsRead, verificationRead] = companionReads;
  const startedAt = timestampMs(session.created_at) ?? Date.now();
  const updatedAt = timestampMs(session.updated_at) ?? startedAt;
  const usage = emptyUsage();
  const runs = Array.isArray(runsRead?.value)
    ? runsRead.value
    : Array.isArray(root.run_records)
      ? root.run_records
      : Array.isArray(session.run_records)
        ? session.run_records
        : [];
  const events = runs.length > 0
    ? eventsFromRuns(recordId, runs, startedAt, usage)
    : fallbackEventsFromMessages(
        recordId,
        Array.isArray(session.messages)
          ? session.messages
          : Array.isArray(root.messages)
            ? root.messages
            : [],
        startedAt,
      );
  if (usage.totalTokens === 0) addUsage(usage, session.total_usage ?? root.total_usage);
  const promptEvents = events.filter((event) => event.kind === 'user_message');
  const assistantEvents = events.filter((event) => event.kind === 'assistant_message');
  const toolCalls = events.filter((event) => event.kind === 'tool_call');
  const toolResults = events.filter((event) => event.kind === 'tool_result');
  const completed = events.filter((event) => event.kind === 'turn_complete');
  const config = objectValue(session.config);
  const contextUsage = objectValue(session.context_usage);
  const contextWindow = numberValue(contextUsage?.max_tokens);
  if (contextWindow && contextWindow > 0) usage.contextWindow = contextWindow;
  const totalBytes = [mainRead, runsRead, tracesRead, subagentsRead, verificationRead]
    .reduce((sum, item) => sum + (item?.bytes ?? 0), 0);
  const completedDurationMs = completed.reduce(
    (sum, event) => sum + (event.durationMs ?? 0),
    0,
  );
  const metrics: LocalRecordDetailMetrics = {
    scope: 'full_record',
    scannedBytes: totalBytes,
    fileBytes: totalBytes,
    messageCount: promptEvents.length + assistantEvents.length,
    userMessageCount: promptEvents.length,
    assistantMessageCount: assistantEvents.length,
    turnCount: events.filter((event) => event.kind === 'turn_start').length,
    completeTurnCount: completed.length,
    toolCallCount: toolCalls.length,
    toolResultCount: toolResults.length,
    toolFailureCount: toolResults.filter((event) => event.status === 'failure').length,
    completedDurationMs,
    tokenUsage: usage,
  };
  const firstPrompt = promptEvents[0]?.content;
  return {
    sessionId,
    title: text(firstPrompt, 180) ?? `A3S Code 记录 ${sessionId.slice(0, 8)}`,
    cwd: text(config?.workspace, 4_096),
    model: text(session.model_name, 256),
    modelProvider: text(objectValue(config?.model)?.provider, 128),
    originator: 'a3s-code-tui',
    startedAt,
    updatedAt: Math.max(
      updatedAt,
      ...events.map((event) => event.timestamp).filter(Number.isFinite),
    ),
    fileBytes: totalBytes,
    events,
    metrics,
  };
}
