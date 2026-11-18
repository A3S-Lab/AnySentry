import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sqlite3 from 'sqlite3';
import type { LocalRecordDetailMetrics, LocalRecordTimelineEvent, LocalRecordTokenUsage } from './local-record-tracking.types';

type Row = Record<string, unknown>;
const obj = (v: unknown): Row => v && typeof v === 'object' && !Array.isArray(v) ? v as Row : {};
const text = (v: unknown): string => typeof v === 'string' ? v.replace(/\u0000/gu, '') : '';
const num = (v: unknown): number => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
const cap = (s: string): string => s.length > 65536 ? `${s.slice(0, 65536)}\n…（内容已截断）` : s;
const MAX_ROWS = 4096;
const MAX_BYTES = 16 * 1024 * 1024;

export interface OpenCodeSession {
  sessionId: string; title: string; cwd?: string; cliVersion?: string;
  startedAt: number; updatedAt: number;
}
export interface ParsedOpenCodeRecord extends OpenCodeSession {
  model?: string; modelProvider?: string; originator: 'opencode'; fileBytes: number;
  partial: boolean; events: LocalRecordTimelineEvent[]; metrics: LocalRecordDetailMetrics;
}

/** SQLITE_OPEN_READONLY honours live WAL, unlike copying only the main DB or immutable=1.
 * A transaction keeps messages and their mutable tool parts in the same snapshot. */
async function snapshot<T>(path: string, read: (query: (sql: string, args?: unknown[]) => Promise<Row[]>) => Promise<T>): Promise<T> {
  try { return await readSnapshot(path, read); } catch (error) {
    const code = (error as { code?: string }).code ?? '';
    if (!code.startsWith('SQLITE_READONLY') && code !== 'SQLITE_CANTOPEN') throw error;
    // A cleanly closed WAL-mode DB can have no -wal/-shm files. SQLite still tries
    // to create those sidecars when reading it from a read-only mount. Only in that
    // case use a bounded private copy, after proving the main file stayed unchanged
    // and no WAL appeared during the copy. Never ignore a live WAL via immutable=1.
    const absentWal = async () => {
      try { await lstat(`${path}-wal`); return false; }
      catch (failure) { return (failure as { code?: string }).code === 'ENOENT'; }
    };
    const before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.size > 128n * 1024n * 1024n || !await absentWal()) throw error;
    const temporary = await mkdtemp(join(tmpdir(), 'anysentry-opencode-snapshot-'));
    try {
      const copy = join(temporary, 'opencode.db');
      await copyFile(path, copy);
      const after = await lstat(path, { bigint: true });
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || !await absentWal()) throw error;
      return await readSnapshot(copy, read);
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
}

async function readSnapshot<T>(path: string, read: (query: (sql: string, args?: unknown[]) => Promise<Row[]>) => Promise<T>): Promise<T> {
  const info = await lstat(path);
  if (!info.isFile()) throw new Error('OpenCode database is not a regular file');
  const db = await new Promise<sqlite3.Database>((resolve, reject) => {
    const value = new sqlite3.Database(path, sqlite3.OPEN_READONLY, error => error ? reject(error) : resolve(value));
  });
  db.configure('busyTimeout', 250);
  let expired = false;
  const timer = setTimeout(() => { expired = true; db.interrupt(); }, 3000);
  const query = (sql: string, args: unknown[] = []) => new Promise<Row[]>((resolve, reject) => {
    if (expired) return reject(new Error('OpenCode snapshot deadline exceeded'));
    db.all(sql, args, (error, rows: Row[]) => error ? reject(error) : resolve(rows));
  });
  try {
    await query('PRAGMA query_only = ON');
    await query('BEGIN');
    return await read(query);
  } finally {
    clearTimeout(timer);
    // Closing rolls back the read transaction without changing the source database.
    await new Promise<void>(resolve => db.close(() => resolve()));
  }
}

function session(row: Row): OpenCodeSession {
  return { sessionId: text(row.id), title: text(row.title) || 'OpenCode 会话',
    cwd: text(row.directory) || undefined, cliVersion: text(row.version) || undefined,
    startedAt: num(row.time_created), updatedAt: num(row.time_updated) };
}

export async function discoverOpenCodeSessions(path: string, limit = 500): Promise<OpenCodeSession[]> {
  try {
    return await snapshot(path, async query => {
      // Only the supported v1 projection is accepted. Never treat an unknown schema as a transcript.
      await query('SELECT id, session_id, data FROM message LIMIT 0');
      await query('SELECT id, message_id, session_id, data FROM part LIMIT 0');
      const rows = await query('SELECT id, title, directory, version, time_created, time_updated FROM session ORDER BY time_updated DESC, id DESC LIMIT ?',
        [Math.min(2000, Math.max(1, Math.trunc(limit)))]);
      return rows.map(session).filter(value => Boolean(value.sessionId));
    });
  } catch { return []; }
}

export async function parseOpenCodeRecord(path: string, nativeSessionId: string, recordId: string): Promise<ParsedOpenCodeRecord | undefined> {
  try {
    return await snapshot(path, async query => {
      const [rawSession] = await query('SELECT id, title, directory, version, time_created, time_updated FROM session WHERE id = ?', [nativeSessionId]);
      if (!rawSession) return undefined;
      const meta = session(rawSession);
      let bytes = 0, partial = false;
      // Bound individual cells before transferring them out of SQLite, then bound total payload.
      const readRows = async (table: 'message' | 'part') => {
        const rows: Row[] = [];
        for (let offset = 0; offset <= MAX_ROWS; offset += 64) {
          const batch = await query(`SELECT id, ${table === 'part' ? 'message_id,' : ''} time_created, time_updated,
            length(CAST(data AS BLOB)) AS bytes, substr(data, 1, 65537) AS data FROM ${table}
            WHERE session_id = ? ORDER BY time_created DESC, id DESC LIMIT 64 OFFSET ?`, [nativeSessionId, offset]);
          for (const row of batch) {
            if (rows.length >= MAX_ROWS || bytes + num(row.bytes) > MAX_BYTES) { partial = true; return rows.reverse(); }
            bytes += num(row.bytes);
            if (num(row.bytes) > 65536) { partial = true; continue; }
            try { row.value = obj(JSON.parse(text(row.data))); } catch { partial = true; continue; }
            rows.push(row);
          }
          if (batch.length < 64) break;
        }
        return rows.reverse();
      };
      const messages = await readRows('message');
      const parts = await readRows('part');
      const events: LocalRecordTimelineEvent[] = [];
      const usage: LocalRecordTokenUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 };
      const byMessage = new Map<string, Row[]>();
      for (const part of parts) {
        const key = text(part.message_id);
        byMessage.set(key, [...(byMessage.get(key) ?? []), part]);
      }
      const push = (key: string, timestamp: number, event: Omit<LocalRecordTimelineEvent, 'eventId' | 'sourceOffset' | 'timestamp'>) => {
        events.push({ ...event, timestamp, sourceOffset: 0,
          eventId: createHash('sha256').update(`${recordId}:opencode:${key}:${event.kind}`).digest('hex').slice(0, 24) });
      };
      let model: string | undefined, modelProvider: string | undefined;
      const userIds = new Set(messages.filter(row => obj(row.value).role === 'user').map(row => text(row.id)));
      const complete = new Map<string, { key: string; at: number; start: number }>();
      for (const message of messages) {
        const data = obj(message.value), id = text(message.id), time = obj(data.time);
        const at = num(time.created) || num(message.time_created);
        const isUser = data.role === 'user';
        if (!isUser && data.role !== 'assistant') { partial = true; continue; }
        // parentID is the native user message/Turn, not the previous assistant step.
        const turnId = isUser ? id : text(data.parentID) || undefined;
        if (!isUser && (!turnId || !userIds.has(turnId))) partial = true;
        const messageParts = byMessage.get(id) ?? [];
        if (isUser) push(id, at, { kind: 'turn_start', turnId, title: 'Turn 开始', status: 'observed' });
        const body = messageParts.map(row => obj(row.value)).filter(part => part.type === 'text' && part.ignored !== true)
          .map(part => text(part.text)).join('\n');
        if (body) push(id, at, { kind: isUser ? 'user_message' : 'assistant_message', turnId,
          role: isUser ? 'user' : 'assistant', ...(isUser ? { phase: 'human_instruction' } : {}),
          title: isUser ? '用户指令' : 'AI 回复', content: cap(body), status: 'observed' });
        if (!isUser) {
          model = text(data.modelID) || model; modelProvider = text(data.providerID) || modelProvider;
          const tokens = obj(data.tokens), cache = obj(tokens.cache);
          usage.inputTokens += num(tokens.input) + num(cache.read) + num(cache.write);
          usage.cachedInputTokens += num(cache.read) + num(cache.write);
          usage.outputTokens += num(tokens.output); usage.reasoningOutputTokens += num(tokens.reasoning);
          if (turnId && num(time.completed) && data.finish && !['tool-calls', 'unknown'].includes(text(data.finish)) && !data.error) {
            complete.set(turnId, { key: id, at: num(time.completed), start: at });
          }
        }
        for (const row of messageParts) {
          const part = obj(row.value);
          if (part.type !== 'tool') continue;
          const state = obj(part.state), input = obj(state.input), toolTime = obj(state.time);
          const start = num(toolTime.start), end = num(toolTime.end), callId = text(part.callID) || undefined;
          const toolName = text(part.tool), key = text(row.id);
          // Pending inputs have not executed. No fabricated command/timing anchor.
          const command = toolName === 'bash' && start && state.status !== 'pending' ? text(input.command) : '';
          push(key, start || num(row.time_created) || at, { kind: 'tool_call', turnId, callId, toolName,
            title: '工具调用', content: cap(JSON.stringify(input)), status: 'observed',
            ...(!start || state.status === 'pending' ? { phase: 'tool_pending' } : {}),
            ...(command && command.length <= 65536 ? { command } : {}),
            ...(text(input.workdir) || meta.cwd ? { workdir: text(input.workdir) || meta.cwd } : {}) });
          if (state.status === 'completed' || state.status === 'error') {
            if (!end) partial = true;
            const failed = state.status === 'error' || (typeof obj(state.metadata).exit === 'number' && obj(state.metadata).exit !== 0);
            push(key, end || num(row.time_updated), { kind: 'tool_result', turnId, callId, toolName,
              title: '工具结果', content: cap(text(state.output) || text(state.error)), status: failed ? 'failure' : 'success',
              ...(start && end ? { durationMs: Math.max(0, end - start) } : {}) });
          }
        }
      }
      for (const [turnId, value] of complete) {
        const start = events.find(event => event.kind === 'turn_start' && event.turnId === turnId)?.timestamp ?? value.start;
        push(value.key, value.at, { kind: 'turn_complete', turnId, title: 'Turn 完成', status: 'observed', durationMs: Math.max(0, value.at - start) });
      }
      // Snapshot cursors are local to the current projection. Native IDs remain stable when
      // streaming parts change or an earlier pending tool receives its result.
      events.sort((a, b) => a.timestamp - b.timestamp);
      events.forEach((event, i) => { event.sourceOffset = i; });
      usage.totalTokens = usage.inputTokens + usage.outputTokens + usage.reasoningOutputTokens;
      const count = (kind: string) => events.filter(event => event.kind === kind).length;
      const metrics: LocalRecordDetailMetrics = { scope: partial ? 'recent_window' : 'full_record', scannedBytes: bytes, fileBytes: bytes,
        messageCount: count('user_message') + count('assistant_message'), userMessageCount: count('user_message'), assistantMessageCount: count('assistant_message'),
        turnCount: count('turn_start'), completeTurnCount: count('turn_complete'), toolCallCount: count('tool_call'), toolResultCount: count('tool_result'),
        toolFailureCount: events.filter(event => event.kind === 'tool_result' && event.status === 'failure').length,
        completedDurationMs: events.filter(event => event.kind === 'turn_complete').reduce((sum, event) => sum + (event.durationMs ?? 0), 0), tokenUsage: usage };
      return { ...meta, title: events.find(event => event.kind === 'user_message')?.content?.slice(0, 160) || meta.title,
        model, modelProvider, originator: 'opencode', fileBytes: bytes, partial, events, metrics };
    });
  } catch { return undefined; }
}
