#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { TextDecoder } from 'node:util';

const CONTENT_MAX_BYTES = 256 * 1024;
const DEFAULT_API_BASE = 'http://127.0.0.1:29653/security-center';
const DEFAULT_COLLECTOR_ID = 'codex-app-server-local';
const DEFAULT_CREDENTIALS_FILE = '.local/codex-conversation-observer.env';
const DEFAULT_STATE_FILE = '.local/codex-conversation-observer-state.json';
const DEFAULT_ADMIN_ENV_FILE = '.local/interaction-content.env';
const UTF8_FATAL_DECODER = new TextDecoder('utf-8', { fatal: true });

function positiveInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isSafeInteger(parsed)
    ? Math.max(minimum, Math.min(maximum, parsed))
    : fallback;
}

function enabled(value) {
  return /^(?:1|true|on|yes)$/iu.test(String(value ?? '').trim());
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function safeRuntimeLabel(value) {
  const normalized = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/gu, '')
    .trim()
    .slice(0, 160);
  return normalized || 'unknown';
}

function sessionSourceLabel(source) {
  if (typeof source === 'string') return safeRuntimeLabel(source);
  if (!source || typeof source !== 'object' || Array.isArray(source)) return 'unknown';
  if (typeof source.custom === 'string') return safeRuntimeLabel(`custom:${source.custom}`);
  if ('subAgent' in source) return 'subAgent';
  return 'unknown';
}

function truncateUtf8(value, maximum = CONTENT_MAX_BYTES) {
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.byteLength <= maximum) {
    return { content: value, completeness: 'complete', originalBytes: encoded.byteLength };
  }
  let end = maximum;
  while (end > 0) {
    try {
      const content = UTF8_FATAL_DECODER.decode(encoded.subarray(0, end));
      return {
        content,
        completeness: 'truncated',
        originalBytes: encoded.byteLength,
      };
    } catch {
      end -= 1;
    }
  }
  throw new Error('unable to produce a valid UTF-8 content prefix');
}

function userInputText(inputs) {
  const parts = [];
  for (const input of Array.isArray(inputs) ? inputs : []) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) continue;
    if (input.type === 'text' && typeof input.text === 'string') {
      parts.push(input.text);
    } else if (input.type === 'image' || input.type === 'localImage') {
      parts.push('[图片附件]');
    } else if (input.type === 'audio' || input.type === 'localAudio') {
      parts.push('[音频附件]');
    } else if (input.type === 'skill' && typeof input.name === 'string') {
      parts.push(`[Skill: ${input.name}]`);
    } else if (input.type === 'mention' && typeof input.name === 'string') {
      parts.push(`[Mention: ${input.name}]`);
    }
  }
  return parts.join('\n');
}

function runtimeIdentity(thread) {
  return {
    runtimeType: 'codex_app_server',
    threadId: String(thread.id),
    sessionId: String(thread.sessionId),
    source: sessionSourceLabel(thread.source),
    ...(typeof thread.cliVersion === 'string' && thread.cliVersion.trim()
      ? { cliVersion: safeRuntimeLabel(thread.cliVersion) }
      : {}),
    ...(typeof thread.modelProvider === 'string' && thread.modelProvider.trim()
      ? { modelProvider: safeRuntimeLabel(thread.modelProvider) }
      : {}),
  };
}

function contentMetadata(content) {
  const encoded = Buffer.from(content, 'utf8');
  return {
    contentBytes: encoded.byteLength,
    contentSha256: sha256(encoded),
  };
}

/**
 * Convert a persisted Codex Thread into immutable AnySentry content observations.
 *
 * Only terminal Turns are emitted. Reading an in-progress Agent message could observe a mutable
 * prefix and later conflict with the completed item under the same native item id.
 */
export function extractCodexConversationMessages(
  thread,
  {
    maxTurns = 500,
    includeCommentary = true,
    collectorId = DEFAULT_COLLECTOR_ID,
  } = {},
) {
  if (!thread || typeof thread !== 'object' || Array.isArray(thread)) {
    throw new Error('Codex thread/read returned no thread object');
  }
  if (typeof thread.id !== 'string' || typeof thread.sessionId !== 'string') {
    throw new Error('Codex thread has no stable thread/session identity');
  }
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  const start = Math.max(0, turns.length - Math.max(1, maxTurns));
  const selected = turns.slice(start);
  const runtime = runtimeIdentity(thread);
  const workspacePath =
    typeof thread.cwd === 'string' && thread.cwd.trim()
      ? thread.cwd.trim().slice(0, 500)
      : undefined;
  const agentInstanceId = `codex:${thread.id}`.slice(0, 240);
  const messages = [];
  let skippedInProgress = 0;
  let skippedEmpty = 0;

  selected.forEach((turn, selectedIndex) => {
    if (!turn || typeof turn !== 'object' || Array.isArray(turn)) return;
    if (turn.status === 'inProgress') {
      skippedInProgress += 1;
      return;
    }
    if (!['completed', 'interrupted', 'failed'].includes(turn.status)) return;
    if (typeof turn.id !== 'string' || !Array.isArray(turn.items)) return;
    const turnSequence = start + selectedIndex + 1;
    const startedAtSeconds = Number.isSafeInteger(turn.startedAt)
      ? turn.startedAt
      : Number.isSafeInteger(thread.createdAt)
        ? thread.createdAt + turnSequence
        : 1;
    const baseObservedAt = Math.max(1, startedAtSeconds * 1_000);

    turn.items.forEach((item, itemIndex) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return;
      if (typeof item.id !== 'string') return;
      const observedAt = baseObservedAt + itemIndex;
      if (item.type === 'userMessage') {
        const sourceText = userInputText(item.content);
        if (!sourceText.trim()) {
          skippedEmpty += 1;
          return;
        }
        const bounded = truncateUtf8(sourceText);
        const sourceEventId = `codex:${thread.id}:${turn.id}:${item.id}:user`;
        const envelope = {
          schemaVersion: 'anysentry.interaction-instruction.v1',
          eventType: 'AgentInputObserved',
          sourceEventId,
          collectorId,
          observedAt,
          agentInstanceId,
          ...(workspacePath ? { workspacePath } : {}),
          turn: {
            sourceTurnId: turn.id,
            sequence: turnSequence,
          },
          runtime,
          input: {
            protocol: 'codex_app_server',
            inputScope: 'codex_thread_user_message',
            itemId: item.id,
          },
          capture: {
            captureMethod: 'codex_app_server',
            captureProfile: 'runtime_adapter',
            captureMode: 'encrypted_full',
            captureCompleteness: bounded.completeness,
            parseStatus: 'parsed',
            rawRetentionState: 'encrypted',
            presentationState: 'redacted',
          },
          userInstruction: {
            eventType: 'UserInstructionObserved',
            messageRole: 'user',
            content: bounded.content,
            ...contentMetadata(bounded.content),
          },
        };
        messages.push({
          sourceEventId,
          turnId: turn.id,
          itemId: item.id,
          role: 'user',
          envelope,
          fingerprint: sha256(JSON.stringify(envelope)),
        });
        return;
      }
      if (item.type !== 'agentMessage' || typeof item.text !== 'string') return;
      const phase =
        item.phase === 'commentary' || item.phase === 'final_answer'
          ? item.phase
          : 'unknown';
      if (phase === 'commentary' && !includeCommentary) return;
      if (!item.text.trim()) {
        skippedEmpty += 1;
        return;
      }
      const bounded = truncateUtf8(item.text);
      const sourceEventId = `codex:${thread.id}:${turn.id}:${item.id}:assistant`;
      const envelope = {
        schemaVersion: 'anysentry.interaction-response.v1',
        eventType: 'AgentOutputObserved',
        sourceEventId,
        collectorId,
        observedAt,
        agentInstanceId,
        ...(workspacePath ? { workspacePath } : {}),
        turn: {
          sourceTurnId: turn.id,
          sequence: turnSequence,
        },
        runtime,
        output: {
          protocol: 'codex_app_server',
          outputScope: 'codex_thread_agent_message',
          itemId: item.id,
        },
        capture: {
          captureMethod: 'codex_app_server',
          captureProfile: 'runtime_adapter',
          captureMode: 'encrypted_full',
          captureCompleteness: bounded.completeness,
          parseStatus: 'parsed',
          rawRetentionState: 'encrypted',
          presentationState: 'redacted',
        },
        assistantResponse: {
          eventType: 'AssistantResponseObserved',
          messageRole: 'assistant',
          phase,
          content: bounded.content,
          ...contentMetadata(bounded.content),
        },
      };
      messages.push({
        sourceEventId,
        turnId: turn.id,
        itemId: item.id,
        role: 'assistant',
        phase,
        envelope,
        fingerprint: sha256(JSON.stringify(envelope)),
      });
    });
  });

  return {
    threadId: thread.id,
    sessionId: thread.sessionId,
    totalTurns: turns.length,
    inspectedTurns: selected.length,
    skippedInProgress,
    skippedEmpty,
    messages,
  };
}

export class CodexAppServerClient {
  constructor({
    codexBinary = process.env.CODEX_BIN?.trim() || 'codex',
    requestTimeoutMs = 20_000,
  } = {}) {
    this.codexBinary = codexBinary;
    this.requestTimeoutMs = requestTimeoutMs;
    this.child = undefined;
    this.lines = undefined;
    this.nextId = 1;
    this.pending = new Map();
    this.stderrTail = '';
  }

  async start() {
    if (this.child) return;
    this.child = spawn(this.codexBinary, ['app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stderr.on('data', (chunk) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString('utf8')}`.slice(-4_000);
    });
    this.child.once('exit', (code, signal) => {
      const error = new Error(
        `Codex app-server exited before shutdown (code=${code}, signal=${signal})`,
      );
      for (const waiter of this.pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
      this.pending.clear();
      this.child = undefined;
    });
    this.lines = readline.createInterface({ input: this.child.stdout });
    this.lines.on('line', (line) => this.onLine(line));
    await this.request('initialize', {
      clientInfo: {
        name: 'anysentry_codex_conversation_observer',
        title: 'AnySentry Codex Conversation Observer',
        version: '0.1.0',
      },
    });
    this.notify('initialized', {});
  }

  onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id === undefined || message.id === null) return;
    const waiter = this.pending.get(message.id);
    if (!waiter) return;
    this.pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) {
      waiter.reject(new Error(`Codex app-server RPC error: ${JSON.stringify(message.error)}`));
    } else {
      waiter.resolve(message.result);
    }
  }

  request(method, params = {}) {
    if (!this.child?.stdin.writable) {
      return Promise.reject(new Error('Codex app-server is not writable'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `Codex app-server ${method} timed out${
              this.stderrTail ? `; stderr tail: ${this.stderrTail}` : ''
            }`,
          ),
        );
      }, this.requestTimeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
    });
  }

  notify(method, params = {}) {
    if (!this.child?.stdin.writable) return;
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  async readThread(threadId) {
    const result = await this.request('thread/read', {
      threadId,
      includeTurns: true,
    });
    if (!result?.thread) throw new Error(`Codex thread ${threadId} was not found`);
    return result.thread;
  }

  async close() {
    const child = this.child;
    if (!child) return;
    this.lines?.close();
    child.stdin.end();
    const exited = new Promise((resolve) => child.once('exit', resolve));
    const forced = new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        resolve();
      }, 1_000);
      timer.unref();
    });
    await Promise.race([exited, forced]);
    this.child = undefined;
  }
}

function parseEnvFile(filename) {
  if (!fs.existsSync(filename)) return {};
  const values = {};
  for (const line of fs.readFileSync(filename, 'utf8').split(/\r?\n/u)) {
    const clean = line.trim();
    if (!clean || clean.startsWith('#')) continue;
    const separator = clean.indexOf('=');
    if (separator < 1) continue;
    const key = clean.slice(0, separator).trim();
    let value = clean.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function atomicPrivateWrite(filename, content) {
  const directory = path.dirname(filename);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const temporary = `${filename}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, filename);
  fs.chmodSync(filename, 0o600);
}

function safeApiError(payload, status) {
  const candidate =
    payload && typeof payload === 'object'
      ? payload.message ?? payload.error ?? payload.reason
      : undefined;
  return typeof candidate === 'string'
    ? candidate.slice(0, 500)
    : `HTTP ${status}`;
}

async function requestJson(url, { method = 'GET', headers = {}, body } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  let parsed;
  try {
    parsed = raw ? JSON.parse(raw) : undefined;
  } catch {
    parsed = undefined;
  }
  const payload = parsed?.data ?? parsed;
  if (!response.ok) {
    const error = new Error(
      `${method} ${new URL(url).pathname} failed: ${safeApiError(payload, response.status)}`,
    );
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function requestJsonWithRetry(
  url,
  request,
  {
    attempts = 8,
    initialDelayMs = 500,
    maximumDelayMs = 15_000,
    onRetry,
  } = {},
) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await requestJson(url, request);
    } catch (error) {
      lastError = error;
      const status = Number(error?.status);
      const transient =
        [408, 425, 429, 500, 502, 503, 504].includes(status)
        || /(?:temporar|timeout|unavailable|backpressure)/iu.test(
          error instanceof Error ? error.message : String(error),
        );
      if (!transient || attempt === attempts) throw error;
      const delayMs = Math.min(
        maximumDelayMs,
        initialDelayMs * (2 ** (attempt - 1)),
      );
      onRetry?.({ attempt, delayMs, status });
      await sleep(delayMs);
    }
  }
  throw lastError;
}

async function sourceCredentials({
  apiBase,
  credentialsFile,
  adminEnvFile,
  collectorId,
  threadId,
}) {
  const existing = parseEnvFile(credentialsFile);
  if (existing.ANYSENTRY_SOURCE_ID && existing.ANYSENTRY_INGEST_TOKEN) {
    return {
      sourceId: existing.ANYSENTRY_SOURCE_ID,
      token: existing.ANYSENTRY_INGEST_TOKEN,
      collectorId: existing.ANYSENTRY_COLLECTOR_ID || collectorId,
    };
  }
  const adminFromFile = parseEnvFile(adminEnvFile);
  const adminToken =
    process.env.ANYSENTRY_ADMIN_TOKEN?.trim()
    || process.env.ANYSENTRY_MANAGEMENT_TOKEN?.trim()
    || adminFromFile.ANYSENTRY_ADMIN_TOKEN;
  if (!adminToken) {
    throw new Error(
      `no source credentials exist at ${credentialsFile} and no local management token is available`,
    );
  }
  const created = await requestJson(`${apiBase}/sources`, {
    method: 'POST',
    headers: { 'x-anysentry-admin-token': adminToken },
    body: {
      name: `Codex conversation adapter ${threadId.slice(0, 8)}`,
      type: 'forwarder',
      enabled: true,
      requireToken: true,
      collectorId,
      owner: 'AnySentry Codex runtime adapter',
      tags: ['codex', 'conversation', 'runtime-adapter'],
    },
  });
  if (!created?.source?.sourceId || !created.token) {
    throw new Error('AnySentry source bootstrap did not return a protected source token');
  }
  atomicPrivateWrite(
    credentialsFile,
    [
      '# Generated for the local Codex conversation adapter. Never commit this file.',
      `ANYSENTRY_SOURCE_ID=${created.source.sourceId}`,
      `ANYSENTRY_INGEST_TOKEN=${created.token}`,
      `ANYSENTRY_COLLECTOR_ID=${collectorId}`,
      '',
    ].join('\n'),
  );
  return {
    sourceId: created.source.sourceId,
    token: created.token,
    collectorId,
  };
}

function loadCursor(filename, threadId) {
  if (!fs.existsSync(filename)) {
    return {
      schemaVersion: 'anysentry.codex-conversation-cursor.v1',
      threadId,
      uploaded: {},
    };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (
      parsed?.schemaVersion !== 'anysentry.codex-conversation-cursor.v1'
      || parsed.threadId !== threadId
      || !parsed.uploaded
      || typeof parsed.uploaded !== 'object'
      || Array.isArray(parsed.uploaded)
    ) {
      throw new Error('cursor identity does not match the selected thread');
    }
    return parsed;
  } catch (error) {
    throw new Error(
      `invalid Codex conversation cursor ${filename}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function saveCursor(filename, cursor) {
  const entries = Object.entries(cursor.uploaded);
  const boundedEntries = entries.length > 50_000 ? entries.slice(-50_000) : entries;
  atomicPrivateWrite(
    filename,
    `${JSON.stringify({
      ...cursor,
      uploaded: Object.fromEntries(boundedEntries),
      updatedAt: new Date().toISOString(),
    }, null, 2)}\n`,
  );
}

async function uploadMessages({
  apiBase,
  credentials,
  cursor,
  cursorFile,
  extracted,
  concurrency = 1,
  retryAttempts = 8,
  uploadDelayMs = 50,
}) {
  let uploaded = 0;
  let duplicates = 0;
  const pending = [];
  for (const message of extracted.messages) {
    const previous = cursor.uploaded[message.sourceEventId];
    if (previous === message.fingerprint) {
      duplicates += 1;
      continue;
    }
    if (previous && previous !== message.fingerprint) {
      throw new Error(
        `completed Codex item changed after checkpoint: ${message.sourceEventId}`,
      );
    }
    pending.push(message);
  }

  let nextIndex = 0;
  let failure;
  const worker = async () => {
    while (!failure && nextIndex < pending.length) {
      const message = pending[nextIndex];
      nextIndex += 1;
      try {
        const receipt = await requestJsonWithRetry(
          `${apiBase}/interactions/ingest-content`,
          {
            method: 'POST',
            headers: {
              'x-anysentry-source-id': credentials.sourceId,
              'x-anysentry-ingest-token': credentials.token,
            },
            body: message.envelope,
          },
          {
            attempts: retryAttempts,
            onRetry: ({ attempt, delayMs, status }) => {
              process.stdout.write(
                `${JSON.stringify({
                  event: 'codex_conversation_upload_retry',
                  threadId: extracted.threadId,
                  attempt,
                  delayMs,
                  status,
                })}\n`,
              );
            },
          },
        );
        if (
          receipt?.accepted !== true
          || receipt.sourceEventId !== message.sourceEventId
          || receipt.kafkaDurable !== true
          || receipt.contentStoreDurable !== true
        ) {
          throw new Error(
            `AnySentry returned an incomplete durable receipt for ${message.sourceEventId}`,
          );
        }
        cursor.uploaded[message.sourceEventId] = message.fingerprint;
        saveCursor(cursorFile, cursor);
        uploaded += 1;
        if (uploaded % 50 === 0 || uploaded === pending.length) {
          process.stdout.write(
            `${JSON.stringify({
              event: 'codex_conversation_upload_progress',
              threadId: extracted.threadId,
              uploaded,
              pending: pending.length,
            })}\n`,
          );
        }
        if (uploadDelayMs > 0) await sleep(uploadDelayMs);
      } catch (error) {
        failure ??= error;
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(1, concurrency), Math.max(1, pending.length)) },
      () => worker(),
    ),
  );
  if (failure) throw failure;
  return { uploaded, duplicates };
}

function parseArguments(argv) {
  const options = {
    watch: argv.includes('--watch'),
    dryRun: argv.includes('--dry-run'),
  };
  const value = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  options.threadId =
    value('--thread')
    || process.env.ANYSENTRY_CODEX_THREAD_ID?.trim()
    || process.env.CODEX_THREAD_ID?.trim();
  options.apiBase = (
    value('--api-base')
    || process.env.ANYSENTRY_API_BASE
    || DEFAULT_API_BASE
  ).replace(/\/$/u, '');
  options.credentialsFile = path.resolve(
    value('--credentials-file')
      || process.env.ANYSENTRY_CODEX_CONVERSATION_CREDENTIALS_FILE
      || DEFAULT_CREDENTIALS_FILE,
  );
  options.cursorFile = path.resolve(
    value('--cursor-file')
      || process.env.ANYSENTRY_CODEX_CONVERSATION_STATE_FILE
      || DEFAULT_STATE_FILE,
  );
  options.adminEnvFile = path.resolve(
    process.env.ANYSENTRY_INTERACTION_CONTENT_ENV_FILE
      || DEFAULT_ADMIN_ENV_FILE,
  );
  options.collectorId =
    process.env.ANYSENTRY_CODEX_CONVERSATION_COLLECTOR_ID?.trim()
    || DEFAULT_COLLECTOR_ID;
  options.pollMs = positiveInteger(
    value('--poll-ms') || process.env.ANYSENTRY_CODEX_CONVERSATION_POLL_MS,
    10_000,
    1_000,
    60_000,
  );
  options.maxTurns = positiveInteger(
    value('--max-turns') || process.env.ANYSENTRY_CODEX_MAX_TURNS,
    500,
    1,
    5_000,
  );
  options.includeCommentary = !enabled(
    process.env.ANYSENTRY_CODEX_EXCLUDE_COMMENTARY,
  );
  options.uploadConcurrency = positiveInteger(
    process.env.ANYSENTRY_CODEX_UPLOAD_CONCURRENCY,
    1,
    1,
    4,
  );
  options.uploadRetryAttempts = positiveInteger(
    process.env.ANYSENTRY_CODEX_UPLOAD_RETRY_ATTEMPTS,
    8,
    1,
    16,
  );
  options.uploadDelayMs = positiveInteger(
    process.env.ANYSENTRY_CODEX_UPLOAD_DELAY_MS,
    50,
    0,
    5_000,
  );
  return options;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runCodexConversationObserver(options) {
  if (!options.threadId) {
    throw new Error(
      'select one exact conversation with --thread, ANYSENTRY_CODEX_THREAD_ID, or CODEX_THREAD_ID',
    );
  }
  let client = new CodexAppServerClient();
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    let credentials;
    let cursor;
    const totals = {
      scans: 0,
      discovered: 0,
      uploaded: 0,
      duplicates: 0,
      skippedInProgress: 0,
    };
    do {
      try {
        await client.start();
        const thread = await client.readThread(options.threadId);
        const extracted = extractCodexConversationMessages(thread, {
          maxTurns: options.maxTurns,
          includeCommentary: options.includeCommentary,
          collectorId: options.collectorId,
        });
        totals.scans += 1;
        totals.discovered = extracted.messages.length;
        totals.skippedInProgress = extracted.skippedInProgress;
        let scanUploaded = 0;
        let scanDuplicates = 0;
        if (!options.dryRun) {
          credentials ??= await sourceCredentials({
            apiBase: options.apiBase,
            credentialsFile: options.credentialsFile,
            adminEnvFile: options.adminEnvFile,
            collectorId: options.collectorId,
            threadId: options.threadId,
          });
          if (credentials.collectorId !== options.collectorId) {
            throw new Error(
              `configured source collector ${credentials.collectorId} does not match ${options.collectorId}`,
            );
          }
          cursor ??= loadCursor(options.cursorFile, options.threadId);
          const result = await uploadMessages({
            apiBase: options.apiBase,
            credentials,
            cursor,
            cursorFile: options.cursorFile,
            extracted,
            concurrency: options.uploadConcurrency,
            retryAttempts: options.uploadRetryAttempts,
            uploadDelayMs: options.uploadDelayMs,
          });
          scanUploaded = result.uploaded;
          scanDuplicates = result.duplicates;
          totals.uploaded += result.uploaded;
          totals.duplicates = result.duplicates;
        }
        const reportScan =
          !options.watch
          || totals.scans === 1
          || scanUploaded > 0
          || totals.scans % 20 === 0;
        if (reportScan) {
          process.stdout.write(
            `${JSON.stringify({
              event: 'codex_conversation_scan',
              threadId: options.threadId,
              totalTurns: extracted.totalTurns,
              inspectedTurns: extracted.inspectedTurns,
              messages: extracted.messages.length,
              skippedInProgress: extracted.skippedInProgress,
              uploaded: scanUploaded,
              totalUploaded: totals.uploaded,
              checkpointDuplicates: scanDuplicates,
              dryRun: options.dryRun,
            })}\n`,
          );
        }
      } catch (error) {
        if (!options.watch || stopping) throw error;
        process.stderr.write(
          `${JSON.stringify({
            event: 'codex_conversation_scan_retry',
            threadId: options.threadId,
            retryInMs: options.pollMs,
            errorName:
              error instanceof Error && error.name ? safeRuntimeLabel(error.name) : 'Error',
            ...(Number.isSafeInteger(Number(error?.status))
              ? { status: Number(error.status) }
              : {}),
          })}\n`,
        );
        await client.close().catch(() => undefined);
        client = new CodexAppServerClient();
      }
      if (!options.watch || stopping) break;
      await sleep(options.pollMs);
    } while (!stopping);
    return totals;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    await client.close();
  }
}

const invokedDirectly =
  process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  runCodexConversationObserver(parseArguments(process.argv.slice(2))).catch((error) => {
    process.stderr.write(
      `[codex-conversation-observer] fatal: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  });
}
