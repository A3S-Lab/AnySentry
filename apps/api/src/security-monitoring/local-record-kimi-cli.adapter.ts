import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { LocalRecordDetailMetrics, LocalRecordTimelineEvent, LocalRecordTokenUsage } from './local-record-tracking.types';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {};
const text = (v: unknown): string => typeof v === 'string' ? v.replace(/\u0000/gu, '') : '';
const num = (v: unknown): number => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
const content = (v: unknown): string => typeof v === 'string' ? v : Array.isArray(v)
  ? v.map(x => text(obj(x).text)).filter(Boolean).join('\n') : text(obj(v).text);
const cap = (v: string): string => v.length > 65536 ? `${v.slice(0, 65536)}\n…（内容已截断）` : v;

export interface ParsedKimiCliRecord {
  sessionId: string;
  title: string;
  cwd?: string;
  model?: string;
  originator: 'kimi-cli';
  startedAt: number;
  updatedAt: number;
  fileBytes: number;
  partial: boolean;
  events: LocalRecordTimelineEvent[];
  metrics: LocalRecordDetailMetrics;
}

interface WireParseResult {
  events: LocalRecordTimelineEvent[];
  usage: LocalRecordTokenUsage;
  /** Distinct model aliases in time order; a mid-session switch keeps every hop. */
  models: string[];
  partial: boolean;
}

/**
 * Parse one wire.jsonl journal. `agentId` is '' for the session's main agent and the directory
 * name (`agent-0`, …) for subagent journals. Subagent events are namespaced (`agent-0:<turn>`)
 * and titled 子代理… so they never merge into the main Turn, matching the old protocol's rule
 * that SubagentEvents are not folded into the main Turn's tool calls.
 */
function parseKimiWireSource(
  source: string,
  recordId: string,
  sessionId: string,
  agentId: string,
): WireParseResult {
  const events: LocalRecordTimelineEvent[] = [];
  const usage: LocalRecordTokenUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 };
  const sub = agentId !== '';
  const tag = (title: string) => sub ? `子代理 ${title}` : title;
  let turnId: string | undefined;
  let turnAt = 0;
  let offset = 0;
  let partial = false;
  let stream: LocalRecordTimelineEvent | undefined;
  let currentCall: LocalRecordTimelineEvent | undefined;
  let currentArgs = '';
  const models: string[] = [];
  const noteModel = (value: unknown) => {
    const alias = text(value);
    if (alias && !models.includes(alias)) models.push(alias);
  };
  const calls = new Map<string, LocalRecordTimelineEvent>();
  const seenUsage = new Set<string>();
  const push = (at: number, event: Omit<LocalRecordTimelineEvent, 'eventId' | 'sourceOffset' | 'timestamp'>) => {
    const result = { ...event, timestamp: at, sourceOffset: offset * 4 + (event.kind === 'user_message' ? 1 : 0),
      ...(sub ? { agentId } : {}),
      eventId: createHash('sha256').update(`${recordId}:kimi:${agentId}:${offset}:${event.kind}`).digest('hex').slice(0, 24) };
    events.push(result); return result;
  };
  const finishCall = () => {
    if (!currentCall) return;
    currentCall.content = cap(currentArgs);
    try {
      const args = obj(JSON.parse(currentArgs));
      // Preserve the raw command: hash comparison depends on whitespace, too.
      const command = text(args.command ?? args.cmd);
      if (command && command.length <= 65536) currentCall.command = command;
      const cwd = text(args.cwd ?? args.workdir);
      if (cwd) currentCall.workdir = cwd;
    } catch { /* In-flight tool arguments are not executable evidence. */ }
    currentCall = undefined; currentArgs = '';
  };
  const wireTurn = (id: string) => sub ? `${agentId}:${id}` : id;
  for (const line of source.split('\n')) {
    const lineOffset = offset;
    offset += Buffer.byteLength(line) + 1;
    if (!line.trim()) continue;
    let raw: Obj;
    try { raw = obj(JSON.parse(line)); } catch { partial = true; continue; }
    if (raw.type === 'metadata') continue;
    const envelope = obj(raw.message);
    const envelopeType = text(envelope.type);
    if (!envelopeType && text(raw.type).includes('.')) {
      // Wire protocol 1.5 (kimi-code): dotted top-level types, `time` in epoch ms, no envelope.
      const ts15 = typeof raw.time === 'number' ? raw.time : Date.parse(text(raw.time));
      if (!Number.isFinite(ts15)) { partial = true; continue; }
      const at = Math.trunc(ts15);
      const nextOffset = offset; offset = lineOffset;
      const type15 = text(raw.type);
      const turnOf = (value: unknown) => value === undefined || value === null ? '' : String(value);
      if (type15 !== 'context.append_loop_event') stream = undefined;
      if (type15 === 'turn.prompt') {
        const id = turnOf(raw.turnId) || `${sessionId}:wire:${offset}`;
        // agent.turn.started for the same turn arrives first; do not duplicate the boundary.
        if (wireTurn(id) !== turnId) {
          turnId = wireTurn(id); turnAt = at; calls.clear();
          push(at, { kind: 'turn_start', turnId, title: tag('Turn 开始'), status: 'observed' });
        }
        const inputText = Array.isArray(raw.input)
          ? raw.input.map(part => text(obj(part).text)).filter(Boolean).join('\n') : content(raw.input);
        // A subagent's prompt is a delegated task, not a human instruction to the session;
        // subagent journals also omit origin.kind, so accept any non-empty prompt there.
        if ((sub || text(obj(raw.origin).kind) === 'user') && inputText) {
          push(at, { kind: 'user_message', turnId, role: 'user',
            phase: sub ? 'subagent_task' : 'human_instruction',
            title: sub ? '子代理任务' : '用户指令', content: cap(inputText), status: 'observed' });
        }
      } else if (type15 === 'agent.turn.started') {
        const id = turnOf(raw.turnId);
        if (id && wireTurn(id) !== turnId) {
          turnId = wireTurn(id); turnAt = at; calls.clear();
          push(at, { kind: 'turn_start', turnId, title: tag('Turn 开始'), status: 'observed' });
        }
      } else if (type15 === 'turn.ended') {
        const id = turnOf(raw.turnId);
        const wid = id ? wireTurn(id) : turnId;
        const reason = text(raw.reason);
        // cancelled is an interrupted turn, not a failure; keep the distinction visible.
        if (wid) push(at, { kind: 'turn_complete', turnId: wid,
          title: tag(reason === 'cancelled' ? 'Turn 已取消' : 'Turn 完成'),
          status: reason === 'cancelled' ? 'unknown' : reason && reason !== 'completed' ? 'failure' : 'observed',
          durationMs: num(raw.durationMs) || Math.max(0, at - turnAt) });
        if (!wid || wid === turnId) turnId = undefined;
      } else if (type15 === 'turn.step.interrupted') {
        const wid = turnOf(raw.turnId) ? wireTurn(turnOf(raw.turnId)) : turnId;
        const reason = text(raw.reason);
        const message = text(raw.message);
        push(at, { kind: 'system_event', turnId: wid || undefined,
          title: tag('Turn 中断'), content: cap(message || reason),
          status: reason === 'error' ? 'failure' : 'unknown' });
      } else if (type15 === 'context.append_loop_event') {
        const event = obj(raw.event);
        const loopType = text(event.type);
        const loopTurn = turnOf(event.turnId) ? wireTurn(turnOf(event.turnId)) : turnId;
        if (loopType === 'content.part') {
          const part = obj(event.part);
          const partText = text(part.text);
          if (text(part.type) === 'text' && partText) {
            if (stream && stream.turnId === loopTurn) stream.content = cap((stream.content ?? '') + partText);
            else stream = push(at, { kind: 'assistant_message', turnId: loopTurn || undefined, role: 'assistant', title: tag('AI 回复'), content: cap(partText), status: 'observed' });
          }
          // `think` parts are model-internal reasoning, not reply content.
        } else if (loopType === 'tool.call') {
          const args = obj(event.args);
          const id = text(event.toolCallId);
          const call = push(at, { kind: 'tool_call', turnId: loopTurn || undefined, callId: id || undefined,
            toolName: text(event.name), title: tag('工具调用'), status: 'observed',
            content: cap(JSON.stringify(args)) });
          // Preserve the raw command: hash comparison depends on whitespace, too.
          const command = text(args.command ?? args.cmd);
          if (command && command.length <= 65536) call.command = command;
          const cwd = text(args.cwd ?? args.workdir);
          if (cwd) call.workdir = cwd;
          if (id) calls.set(id, call);
        } else if (loopType === 'tool.result') {
          const id = text(event.toolCallId);
          const result = obj(event.result);
          const call = calls.get(id);
          push(at, { kind: 'tool_result', turnId: call?.turnId ?? (loopTurn || undefined), callId: id || undefined,
            toolName: call?.toolName, title: tag('工具结果'), content: cap(content(result.output) || text(result.message)),
            status: result.isError === true ? 'failure'
              : result.isError === false || 'output' in result || 'message' in result ? 'success' : 'unknown',
            ...(call ? { durationMs: Math.max(0, at - call.timestamp) } : {}) });
        }
      } else if (type15 === 'usage.record') {
        const scope = text(raw.usageScope);
        // Subagent usage is journaled only in the subagent's own wire (verified against a live
        // session: the main wire carries no subagent usage echo), so summing wires never
        // double-counts.
        if (!scope || scope === 'turn') {
          const token = obj(raw.usage);
          usage.inputTokens += num(token.inputOther) + num(token.inputCacheRead) + num(token.inputCacheCreation);
          usage.cachedInputTokens += num(token.inputCacheRead) + num(token.inputCacheCreation);
          usage.outputTokens += num(token.output);
        }
      } else if (type15 === 'llm.request' || type15 === 'profile.bind' || type15 === 'config.update') {
        noteModel(raw.modelAlias ?? raw.model);
      }
      offset = nextOffset;
      continue;
    }
    const payload = obj(envelope.payload);
    const type = envelopeType === 'ContentPart' && payload.type === 'text' ? 'TextPart' : envelopeType;
    const ts = typeof raw.timestamp === 'number' ? raw.timestamp * (raw.timestamp < 1e10 ? 1000 : 1) : Date.parse(text(raw.timestamp));
    if (!Number.isFinite(ts) || !type) { partial = true; continue; }
    const at = Math.trunc(ts);
    const nextOffset = offset; offset = lineOffset;
    if (type !== 'TextPart') stream = undefined;
    if (!['ToolCallPart', 'ToolCall'].includes(type)) finishCall();
    if (type === 'TurnBegin') {
      // Wire versions without a native turn id get a stable local boundary id.
      turnId = wireTurn(text(payload.turn_id) || `${sessionId}:wire:${offset}`);
      turnAt = at; calls.clear();
      push(at, { kind: 'turn_start', turnId, title: tag('Turn 开始'), status: 'observed' });
      push(at, { kind: 'user_message', turnId, role: 'user',
        phase: sub ? 'subagent_task' : 'human_instruction',
        title: sub ? '子代理任务' : '用户指令', content: cap(content(payload.user_input)), status: 'observed' });
    } else if (type === 'SteerInput') {
      push(at, { kind: 'user_message', turnId, role: 'user', phase: sub ? 'subagent_task' : 'human_instruction', title: sub ? '子代理任务' : '追加用户指令', content: cap(content(payload.user_input)), status: 'observed' });
    } else if (type === 'TurnEnd') {
      if (turnId) push(at, { kind: 'turn_complete', turnId, title: tag('Turn 完成'), status: 'observed', durationMs: Math.max(0, at - turnAt) });
      turnId = undefined;
    } else if (type === 'TextPart') {
      const part = text(payload.text);
      if (part && stream && stream.turnId === turnId) stream.content = cap((stream.content ?? '') + part);
      else if (part) stream = push(at, { kind: 'assistant_message', turnId, role: 'assistant', title: tag('AI 回复'), content: cap(part), status: 'observed' });
    } else if (type === 'ToolCall') {
      finishCall();
      const fn = obj(payload.function);
      const id = text(payload.id);
      currentArgs = text(fn.arguments);
      currentCall = push(at, { kind: 'tool_call', turnId, callId: id || undefined, toolName: text(fn.name), title: tag('工具调用'), status: 'observed' });
      if (id) calls.set(id, currentCall);
    } else if (type === 'ToolCallPart') {
      if (currentCall) currentArgs += text(payload.arguments_part);
      else partial = true;
    } else if (type === 'ToolResult') {
      const id = text(payload.tool_call_id);
      const value = obj(payload.return_value);
      const call = calls.get(id);
      push(at, { kind: 'tool_result', turnId: call?.turnId ?? turnId, callId: id || undefined,
        toolName: call?.toolName, title: tag('工具结果'), content: cap(content(value.output) || text(value.message)),
        status: value.is_error === true ? 'failure' : value.is_error === false ? 'success' : 'unknown',
        ...(call ? { durationMs: Math.max(0, at - call.timestamp) } : {}) });
    } else if (type === 'StatusUpdate') {
      const token = obj(payload.token_usage);
      const key = text(payload.message_id);
      if (Object.keys(token).length && (!key || !seenUsage.has(key))) {
        if (key) seenUsage.add(key);
        usage.inputTokens += num(token.input_other) + num(token.input_cache_read) + num(token.input_cache_creation);
        usage.cachedInputTokens += num(token.input_cache_read) + num(token.input_cache_creation);
        usage.outputTokens += num(token.output);
      }
      const limit = num(payload.max_context_tokens);
      if (limit) usage.contextWindow = limit;
      noteModel(payload.model);
    }
    // SubagentEvent is intentionally not folded into the main Turn's tool calls.
    offset = nextOffset;
  }
  finishCall();
  usage.totalTokens = usage.inputTokens + usage.outputTokens;
  return { events, usage, models, partial };
}

/** Wire is the timestamped execution journal. Context alone cannot prove execution times. */
export async function parseKimiCliRecord(path: string, recordId: string): Promise<ParsedKimiCliRecord | undefined> {
  let source: string;
  let size: number;
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > 64 * 1024 * 1024) return undefined;
    source = await readFile(path, 'utf8'); size = Buffer.byteLength(source);
  } catch { return undefined; }
  const isWire15Layout = basename(dirname(path)) === 'main' && basename(dirname(dirname(path))) === 'agents';
  const sessionDir = isWire15Layout ? dirname(dirname(dirname(path))) : dirname(path);
  const sessionId = basename(sessionDir);
  const main = parseKimiWireSource(source, recordId, sessionId, '');
  if (!main.events.length) return undefined;
  // kimi-code runs subagents as same-process loops with their own journals under
  // agents/<agentId>/wire.jsonl. One process tree means one evidence chain: fold subagent
  // journals into the session record instead of creating sibling records that would all
  // compete for the same process binding.
  const wires = [main];
  let fileBytes = size;
  if (isWire15Layout) {
    const agentsDir = dirname(dirname(path));
    let names: string[] = [];
    try {
      names = (await readdir(agentsDir, { withFileTypes: true }))
        .filter((item) => item.isDirectory() && item.name !== 'main')
        .map((item) => item.name)
        .sort();
    } catch { names = []; }
    for (const name of names) {
      try {
        const subPath = join(agentsDir, name, 'wire.jsonl');
        const info = await stat(subPath);
        if (!info.isFile() || info.size > 64 * 1024 * 1024) continue;
        const subSource = await readFile(subPath, 'utf8');
        const parsed = parseKimiWireSource(subSource, recordId, sessionId, name);
        if (!parsed.events.length) continue;
        fileBytes += Buffer.byteLength(subSource);
        wires.push(parsed);
      } catch { /* A missing/unreadable subagent journal does not invalidate the main Wire. */ }
    }
  }
  const events = wires.length === 1
    ? main.events
    : wires.flatMap((wire) => wire.events).sort((left, right) => left.timestamp - right.timestamp);
  const usage = wires.reduce((total, wire) => ({
    inputTokens: total.inputTokens + wire.usage.inputTokens,
    outputTokens: total.outputTokens + wire.usage.outputTokens,
    cachedInputTokens: total.cachedInputTokens + wire.usage.cachedInputTokens,
    reasoningOutputTokens: total.reasoningOutputTokens + wire.usage.reasoningOutputTokens,
    totalTokens: total.totalTokens + wire.usage.totalTokens,
    ...(total.contextWindow || wire.usage.contextWindow
      ? { contextWindow: total.contextWindow ?? wire.usage.contextWindow } : {}),
  }), { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 } as LocalRecordTokenUsage);
  const seenModels = [...main.models];
  for (const wire of wires.slice(1)) {
    for (const alias of wire.models) if (!seenModels.includes(alias)) seenModels.push(alias);
  }
  // A mid-session model switch is reported as `old → new` instead of silently relabeling
  // every earlier Turn with the final alias.
  let model: string | undefined = seenModels.length ? seenModels.join(' → ') : undefined;
  const partial = wires.some((wire) => wire.partial);
  let cwd: string | undefined;
  // Metadata only; never read config.toml, credentials, or resolve arbitrary indexed paths.
  try {
    const metaPath = join(sessionDir, 'metadata.json');
    if ((await stat(metaPath)).size < 1024 * 1024) {
      const meta = obj(JSON.parse(await readFile(metaPath, 'utf8')));
      cwd = text(meta.work_dir ?? meta.workDir ?? meta.cwd) || undefined;
      model = text(meta.model) || model;
    }
  } catch { /* Old versions keep workspace metadata outside the session. */ }
  if (!cwd) {
    // kimi-code (protocol 1.5) keeps workspace metadata in state.json next to agents/.
    try {
      const statePath = join(sessionDir, 'state.json');
      if ((await stat(statePath)).size < 1024 * 1024) {
        const state = obj(JSON.parse(await readFile(statePath, 'utf8')));
        cwd = text(state.cwd ?? state.work_dir ?? state.workDir) || undefined;
      }
    } catch { /* Missing optional state.json does not invalidate Wire evidence. */ }
  }
  if (!cwd) {
    try {
      const registryPath = join(dirname(dirname(dirname(sessionDir))), 'kimi.json');
      if ((await stat(registryPath)).size <= 2 * 1024 * 1024) {
        const registry = obj(JSON.parse(await readFile(registryPath, 'utf8')));
        const key = basename(dirname(sessionDir));
        if (Array.isArray(registry.work_dirs)) for (const value of registry.work_dirs) {
          const item = obj(value), directory = text(item.path);
          if (!directory.startsWith('/')) continue;
          const hash = createHash('md5').update(directory).digest('hex');
          if (key === hash || key === `${text(item.kaos)}_${hash}`) { cwd = directory; break; }
        }
      }
    } catch { /* Missing optional workspace registry does not invalidate Wire evidence. */ }
  }
  const count = (kind: string) => events.filter(e => e.kind === kind).length;
  const metrics: LocalRecordDetailMetrics = {
    scope: partial ? 'recent_window' : 'full_record', scannedBytes: fileBytes, fileBytes,
    messageCount: count('user_message') + count('assistant_message'),
    // Delegated subagent tasks are not human instructions to the session.
    userMessageCount: events.filter(e => e.kind === 'user_message' && e.phase !== 'subagent_task').length,
    assistantMessageCount: count('assistant_message'), turnCount: count('turn_start'), completeTurnCount: count('turn_complete'),
    toolCallCount: count('tool_call'), toolResultCount: count('tool_result'),
    toolFailureCount: events.filter(e => e.kind === 'tool_result' && e.status === 'failure').length,
    completedDurationMs: events.filter(e => e.kind === 'turn_complete').reduce((n, e) => n + (e.durationMs ?? 0), 0), tokenUsage: usage,
  };
  return { sessionId,
    title: events.find(e => e.kind === 'user_message' && e.phase !== 'subagent_task')?.content?.slice(0, 160)
      ?? events.find(e => e.kind === 'user_message')?.content?.slice(0, 160)
      ?? 'Kimi Code CLI 会话',
    cwd, model, originator: 'kimi-cli', startedAt: events[0].timestamp, updatedAt: events.at(-1)!.timestamp,
    fileBytes, partial, events, metrics };
}
