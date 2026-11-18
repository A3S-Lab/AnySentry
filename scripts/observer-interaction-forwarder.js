'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const { DurableSpool } = require('./observer-durable-spool');

function enabled(value) {
  return /^(?:1|true|on|yes)$/iu.test(String(value || '').trim());
}

function bounded(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.max(min, Math.min(max, Math.trunc(parsed)))
    : fallback;
}

function text(value, limit) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized && !/[\u0000-\u001f\u007f]/u.test(normalized)
    ? normalized.slice(0, limit)
    : undefined;
}

function durationMs(value) {
  if (!value || typeof value !== 'object') return undefined;
  const seconds = Number(value.secs);
  const nanos = Number(value.nanos);
  if (!Number.isFinite(seconds) || seconds < 0 || !Number.isFinite(nanos) || nanos < 0) {
    return undefined;
  }
  return Math.max(0, Math.min(86_400_000, Math.round(seconds * 1_000 + nanos / 1_000_000)));
}

function providerName(value) {
  if (typeof value === 'string') return value.slice(0, 80);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const key = Object.keys(value)[0];
  return key ? key.slice(0, 80) : undefined;
}

function observedAtMillis(event) {
  const nanos = event?.observation?.observed_at_unix_nanos;
  if (typeof nanos === 'number' && Number.isFinite(nanos) && nanos > 0) {
    // Rust serializes u64 nanoseconds as a JSON number. That value exceeds JavaScript's safe
    // integer range, but converting it to milliseconds is still bounded and deterministic.
    // Falling back to Date.now() made the same raw Observer line produce a different immutable
    // payload after process restart, so a legitimate replay became a 409 conflict.
    const millis = Math.trunc(nanos / 1_000_000);
    if (Number.isSafeInteger(millis) && millis > 0) return millis;
  }
  if (typeof nanos === 'string' && /^\d{10,20}$/u.test(nanos)) {
    const millis = Number(BigInt(nanos) / 1_000_000n);
    if (Number.isSafeInteger(millis) && millis > 0) return millis;
  }
  return Date.now();
}

function isAgentInteractionClassification(classification) {
  return classification?.state === 'agent';
}

function interactionTarget(ingestTarget) {
  const target = new URL(ingestTarget.toString());
  if (!/\/interactions\/ingest$/u.test(target.pathname)) {
    const replaced = target.pathname.replace(
      /\/ingest(?:\/.*)?$/u,
      '/interactions/ingest',
    );
    target.pathname = replaced === target.pathname
      ? '/security-center/interactions/ingest'
      : replaced;
  }
  target.search = '';
  target.hash = '';
  return target;
}

function interactionContentTarget(ingestTarget) {
  const target = interactionTarget(ingestTarget);
  target.pathname = target.pathname.replace(/\/interactions\/ingest$/u, '/interactions/ingest-content');
  return target;
}

function stableSourceEventId(writerId, line) {
  return `ilse_${crypto
    .createHash('sha256')
    .update(writerId)
    .update('\0')
    .update(line)
    .digest('hex')
    .slice(0, 32)}`;
}

function namespaceFields(process, pid) {
  if (Number(process.pid) !== Number(pid ?? process.pid)) return {};
  return {
    ...(text(process.pid_namespace, 512) ? { pidNamespace: text(process.pid_namespace, 512) } : {}),
    ...(bounded(process.namespace_pid, 0, 0, 4_194_304) > 0
      ? { namespacePid: bounded(process.namespace_pid, 0, 0, 4_194_304) } : {}),
    ...(bounded(process.namespace_ppid, 0, 0, 4_194_304) > 0
      ? { namespacePpid: bounded(process.namespace_ppid, 0, 0, 4_194_304) } : {}),
  };
}

function metadataEvent(observerEvent, context) {
  const llm = observerEvent?.event?.LlmCall;
  if (!llm || typeof llm !== 'object') return undefined;
  const process = observerEvent.process && typeof observerEvent.process === 'object'
    ? observerEvent.process
    : {};
  const latencyMs = durationMs(llm.latency);
  const ttftApproxMs = durationMs(llm.ttft);
  const sourceEventId = stableSourceEventId(context.writerId, context.line);
  return {
    schemaVersion: 'anysentry.interaction-metadata.v1',
    eventType: 'LlmTransportObserved',
    sourceEventId,
    collectorId: context.collectorId,
    observedAt: observedAtMillis(observerEvent),
    ...(text(context.agentInstanceId, 240)
      ? { agentInstanceId: text(context.agentInstanceId, 240) }
      : {}),
    ...(text(context.workspacePath, 500)
      ? { workspacePath: text(context.workspacePath, 500) }
      : {}),
    process: {
      ...namespaceFields(process, llm.pid),
      ...(text(process.host_id, 240) ? { hostId: text(process.host_id, 240) } : {}),
      ...(text(process.boot_id, 160) ? { bootId: text(process.boot_id, 160) } : {}),
      pid: bounded(llm.pid ?? process.pid, 0, 0, 4_194_304),
      ...(text(String(process.start_time_ticks || ''), 80)
        ? { startTimeTicks: text(String(process.start_time_ticks), 80) }
        : {}),
      ...(text(process.comm, 160) ? { comm: text(process.comm, 160) } : {}),
      ...(text(process.exe, 1_024) ? { exe: text(process.exe, 1_024) } : {}),
      ...(text(String(process.cgroup_id || ''), 160)
        ? { cgroupId: text(String(process.cgroup_id), 160) }
        : {}),
    },
    transport: {
      ...(text(llm.sni, 253) ? { sni: text(llm.sni, 253) } : {}),
      ...(providerName(observerEvent.provider)
        ? { provider: providerName(observerEvent.provider) }
        : {}),
      ...(text(String(llm.peer || ''), 160)
        ? { peer: text(String(llm.peer), 160) }
        : {}),
      protocol: 'unknown',
      requestBytes: bounded(llm.req_bytes, 0, 0, Number.MAX_SAFE_INTEGER),
      responseBytes: bounded(llm.resp_bytes, 0, 0, Number.MAX_SAFE_INTEGER),
      timingScope: llm.timing_scope === 'unavailable' ? 'unavailable' : 'connection',
      latencyAvailability: latencyMs === undefined ? 'unavailable' : 'available',
      ...(latencyMs === undefined ? {} : { latencyMs }),
      ttftAvailability: ttftApproxMs === undefined ? 'unavailable' : 'available',
      ...(ttftApproxMs === undefined ? {} : { ttftApproxMs }),
    },
    capture: {
      captureMethod: 'ebpf_transport',
      captureMode: 'metadata',
      captureCompleteness: 'unavailable',
      parseStatus: 'not_attempted',
      rawRetentionState: 'not_retained',
      presentationState: 'metadata_only',
    },
  };
}

function contentText(value) {
  if (typeof value !== 'string' || !value || value.includes('\u0000')) return undefined;
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.byteLength < 1 || bytes.byteLength > 256 * 1024) return undefined;
  return bytes.toString('utf8') === value ? value : undefined;
}

function interactionProcess(observerEvent, pid, tid) {
  const process = observerEvent?.process && typeof observerEvent.process === 'object'
    ? observerEvent.process
    : {};
  return {
    ...namespaceFields(process, pid),
    ...(text(process.host_id, 240) ? { hostId: text(process.host_id, 240) } : {}),
    ...(text(process.boot_id, 160) ? { bootId: text(process.boot_id, 160) } : {}),
    pid: bounded(pid ?? process.pid, 0, 0, 4_194_304),
    ...(bounded(tid, 0, 0, 4_194_304) > 0
      ? { tid: bounded(tid, 0, 0, 4_194_304) }
      : {}),
    ...(text(String(process.start_time_ticks || ''), 80)
      ? { startTimeTicks: text(String(process.start_time_ticks), 80) }
      : {}),
    ...(text(process.comm, 160) ? { comm: text(process.comm, 160) } : {}),
    ...(text(process.exe, 1_024) ? { exe: text(process.exe, 1_024) } : {}),
    ...(text(String(process.cgroup_id || ''), 160)
      ? { cgroupId: text(String(process.cgroup_id), 160) }
      : {}),
  };
}

function looksLikeA3sCodeProcess(process) {
  const comm = text(process?.comm, 160)?.toLocaleLowerCase() ?? '';
  const exe = text(process?.exe, 1_024)?.toLocaleLowerCase() ?? '';
  const exeBase = exe.split('/').pop() ?? '';
  if (exeBase === 'a3s-code' || comm === 'a3s-code') return true;
  if (comm === 'tokio-rt-worker' && exeBase === 'a3s') return true;
  if (exeBase === 'a3s' || comm === 'a3s') return true;
  return false;
}

function looksLikeClaudeCodeProcess(process) {
  const comm = text(process?.comm, 160)?.toLocaleLowerCase() ?? '';
  const exe = text(process?.exe, 1_024)?.toLocaleLowerCase() ?? '';
  const exeBase = exe.split('/').pop() ?? '';
  return comm === 'claude'
    || exeBase === 'claude'
    || exeBase === 'claude.exe'
    || exe.includes('/@anthropic-ai/claude-code/');
}

function looksLikeGeminiCliProcess(process) {
  const comm = text(process?.comm, 160)?.toLocaleLowerCase() ?? '';
  const exe = text(process?.exe, 1_024)?.toLocaleLowerCase().replaceAll('\\', '/') ?? '';
  const exeBase = exe.split('/').pop() ?? '';
  return comm === 'gemini'
    || comm === 'gemini-cli'
    || exeBase === 'gemini'
    || exeBase === 'gemini-cli'
    || exe.includes('/@google/gemini-cli/');
}

function looksLikeKimiCodeProcess(process) {
  const comm = text(process?.comm, 160)?.toLocaleLowerCase() ?? '';
  const exe = text(process?.exe, 1_024)?.toLocaleLowerCase().replaceAll('\\', '/') ?? '';
  // The deployed CLI can be replaced while running, leaving an exe of "kimi.bak (deleted)".
  const exeBase = (exe.split('/').pop() ?? '').replace(/ \(deleted\)$/u, '');
  return comm === 'kimi'
    || comm === 'kimi-cli'
    || exeBase === 'kimi'
    || exeBase === 'kimi.bak'
    || exeBase === 'kimi-cli'
    || exe.includes('/.kimi-code/bin/');
}

function contentEvent(observerEvent, context) {
  const request = observerEvent?.event?.LlmRequestObserved;
  if (!request || typeof request !== 'object') return undefined;
  const instruction = contentText(request.user_instruction);
  const host = text(request.host, 253);
  const requestPath = text(request.path, 1_024);
  const protocol = request.protocol === 'websocket' ? 'websocket' : 'http1';
  const process = interactionProcess(observerEvent, request.pid, request.tid);
  const kimiRuntime = looksLikeKimiCodeProcess(process)
    || looksLikeKimiCodeProcess(observerEvent?.process);
  // Kimi's chat-completions wire format carries no runtime Session id. Bind the observation to
  // the exact Process generation so the API can attribute it through the Session's process
  // binding instead of silently dropping the only sensitive-capture evidence Kimi produces.
  const processScopedSessionId = kimiRuntime && process.pid > 0
    ? `kimi-proc:${process.pid}:${process.startTimeTicks || 'unknown'}`.slice(0, 240)
    : undefined;
  const sessionId = text(request.session_id, 240) || processScopedSessionId;
  const threadId = text(request.thread_id, 240) || sessionId;
  if (!instruction || !sessionId || !threadId || !host || !requestPath) return undefined;
  const encoded = Buffer.from(instruction, 'utf8');
  const digest = crypto.createHash('sha256').update(encoded).digest('hex');
  const sourceEventId = stableSourceEventId(context.writerId, context.line);
  const provider = text(request.provider, 80) || providerName(observerEvent.provider);
  const turnId = text(request.turn_id, 240);
  const a3sRuntime = looksLikeA3sCodeProcess(process)
    || looksLikeA3sCodeProcess(observerEvent?.process);
  const claudeRuntime = looksLikeClaudeCodeProcess(process)
    || looksLikeClaudeCodeProcess(observerEvent?.process)
    || request.capture_method === 'ebpf_boringssl';
  const runtimeName = text(context.agentDisplayName, 160)?.toLocaleLowerCase() ?? '';
  const geminiRuntime = runtimeName === 'gemini cli'
    || looksLikeGeminiCliProcess(process)
    || looksLikeGeminiCliProcess(observerEvent?.process);
  const captureMethod = request.capture_method === 'ebpf_openssl'
    || request.capture_method === 'ebpf_tls'
      ? 'ebpf_openssl'
      : request.capture_method === 'ebpf_boringssl'
        ? 'ebpf_boringssl'
      : 'ebpf_rustls';
  return {
    schemaVersion: 'anysentry.interaction-instruction.v1',
    eventType: 'AgentInputObserved',
    sourceEventId,
    collectorId: context.collectorId,
    observedAt: observedAtMillis(observerEvent),
    ...(text(context.agentInstanceId, 240)
      ? { agentInstanceId: text(context.agentInstanceId, 240) }
      : {}),
    ...(text(context.workspacePath, 500)
      ? { workspacePath: text(context.workspacePath, 500) }
      : {}),
    ...(turnId ? { turn: { sourceTurnId: turnId } } : {}),
    process,
    runtime: {
      runtimeType: kimiRuntime
        ? 'kimi_cli_ebpf_openssl'
        : geminiRuntime
        ? 'gemini_cli_ebpf_openssl'
        : claudeRuntime
        ? 'claude_code_ebpf_tls'
        : a3sRuntime ? 'a3s_code_ebpf_tls' : 'codex_ebpf_rustls',
      threadId,
      sessionId,
      source: kimiRuntime
        ? 'anysentry_observer_ebpf_kimi_openssl'
        : geminiRuntime
        ? 'anysentry_observer_ebpf_gemini_openssl'
        : claudeRuntime
        ? 'anysentry_observer_ebpf_claude_boringssl'
        : a3sRuntime
          ? 'anysentry_observer_ebpf_a3s_tls'
          : 'anysentry_observer_ebpf_rustls',
      ...(provider ? { modelProvider: provider } : {}),
    },
    input: {
      protocol: kimiRuntime
        ? 'chat_completions_api'
        : geminiRuntime
        ? 'generate_content_api'
        : claudeRuntime ? 'messages_api' : 'responses_api',
      inputScope: 'llm_request_user_message',
      requestPath,
      transportProtocol: protocol,
      providerHost: host,
      endpointAttribution: [
        'observed_headers',
        'observed_handshake',
        'configured_endpoint',
        'configured_late_attach',
      ].includes(request.endpoint_attribution)
        ? request.endpoint_attribution
        : protocol === 'websocket'
          ? 'observed_handshake'
          : 'observed_headers',
      ...(text(request.request_kind, 120)
        ? { requestKind: text(request.request_kind, 120) }
        : {}),
      ...(text(request.window_id, 240) ? { windowId: text(request.window_id, 240) } : {}),
      ...(text(request.model, 160) ? { model: text(request.model, 160) } : {}),
    },
    capture: {
      captureMethod,
      captureProfile: ['exact_pid_runtime', 'exact_binary_runtime']
        .includes(request.capture_profile)
        ? request.capture_profile
        : 'exact_pid_runtime',
      captureMode: 'encrypted_full',
      captureCompleteness: ['complete', 'partial', 'truncated']
        .includes(request.capture_completeness)
        ? request.capture_completeness
        : 'complete',
      parseStatus: 'parsed',
      rawRetentionState: 'encrypted',
      presentationState: 'redacted',
    },
    userInstruction: {
      eventType: 'UserInstructionObserved',
      messageRole: 'user',
      contentBytes: encoded.byteLength,
      contentSha256: digest,
      content: instruction,
    },
  };
}

function responseEvent(observerEvent, context) {
  const response = observerEvent?.event?.LlmResponseObserved;
  if (!response || typeof response !== 'object') return undefined;
  const host = text(response.host, 253);
  const requestPath = text(response.path, 1_024);
  const process = interactionProcess(observerEvent, response.pid, response.tid);
  const kimiRuntime = looksLikeKimiCodeProcess(process)
    || looksLikeKimiCodeProcess(observerEvent?.process);
  if (!kimiRuntime) return undefined;
  // Same process-generation binding as the request lane so request and response share one
  // conversation (threadId derives the evaluator-side conversationId).
  const sessionId = text(response.session_id, 240)
    || (process.pid > 0
      ? `kimi-proc:${process.pid}:${process.startTimeTicks || 'unknown'}`.slice(0, 240)
      : undefined);
  if (!sessionId || !host || !requestPath) return undefined;
  const toolCalls = Array.isArray(response.tool_calls)
    ? response.tool_calls.slice(0, 64).flatMap((call) => {
        const name = text(call?.name, 160);
        if (!name) return [];
        return [{ ...(text(call?.id, 240) ? { id: text(call.id, 240) } : {}), name }];
      })
    : undefined;
  // A pure tool-call answer has no text body. The tool-call payload (including arguments) is the
  // model's actual output, so it becomes the encrypted content instead of dropping the turn;
  // metadata keeps the redacted {id, name} summary for intent/execution cross-checks.
  const assistant = typeof response.assistant_content === 'string'
    && response.assistant_content.length > 0
    ? response.assistant_content
    : Array.isArray(response.tool_calls) && response.tool_calls.length > 0
      ? JSON.stringify(response.tool_calls)
      : '';
  if (!assistant) return undefined;
  const encoded = Buffer.from(assistant, 'utf8');
  const digest = crypto.createHash('sha256').update(encoded).digest('hex');
  const sourceEventId = stableSourceEventId(context.writerId, context.line);
  const provider = text(response.provider, 80) || providerName(observerEvent.provider);
  const captureMethod = response.capture_method === 'ebpf_openssl'
    || response.capture_method === 'ebpf_tls'
      ? 'ebpf_openssl'
      : response.capture_method === 'ebpf_boringssl'
        ? 'ebpf_boringssl'
      : 'ebpf_rustls';
  const body = {
    schemaVersion: 'anysentry.interaction-response.v1',
    eventType: 'AgentOutputObserved',
    sourceEventId,
    collectorId: context.collectorId,
    observedAt: observedAtMillis(observerEvent),
    ...(text(context.agentInstanceId, 240)
      ? { agentInstanceId: text(context.agentInstanceId, 240) }
      : {}),
    ...(text(context.workspacePath, 500)
      ? { workspacePath: text(context.workspacePath, 500) }
      : {}),
    ...(text(response.turn_id, 240)
      ? { turn: { sourceTurnId: text(response.turn_id, 240) } }
      : {}),
    process,
    runtime: {
      runtimeType: 'kimi_cli_ebpf_openssl',
      threadId: sessionId,
      sessionId,
      source: 'anysentry_observer_ebpf_kimi_openssl',
      ...(provider ? { modelProvider: provider } : {}),
    },
    output: {
      protocol: 'chat_completions_api',
      outputScope: 'llm_response_assistant_message',
      requestPath,
      transportProtocol: 'http1',
      providerHost: host,
      endpointAttribution: [
        'observed_headers',
        'observed_handshake',
        'configured_endpoint',
        'configured_late_attach',
      ].includes(response.endpoint_attribution)
        ? response.endpoint_attribution
        : 'observed_headers',
      ...(text(response.model, 160) ? { model: text(response.model, 160) } : {}),
      ...(bounded(response.status_code, 0, 100, 599) > 0
        ? { statusCode: bounded(response.status_code, 0, 100, 599) }
        : {}),
      ...(text(response.finish_reason, 80)
        ? { finishReason: text(response.finish_reason, 80) }
        : {}),
      ...(bounded(response.prompt_tokens, 0, 0, Number.MAX_SAFE_INTEGER) > 0
        ? { inputTokens: bounded(response.prompt_tokens, 0, 0, Number.MAX_SAFE_INTEGER) }
        : {}),
      ...(bounded(response.completion_tokens, 0, 0, Number.MAX_SAFE_INTEGER) > 0
        ? { outputTokens: bounded(response.completion_tokens, 0, 0, Number.MAX_SAFE_INTEGER) }
        : {}),
      ...(bounded(response.total_tokens, 0, 0, Number.MAX_SAFE_INTEGER) > 0
        ? { totalTokens: bounded(response.total_tokens, 0, 0, Number.MAX_SAFE_INTEGER) }
        : {}),
      ...(toolCalls?.length ? { toolCalls } : {}),
    },
    capture: {
      captureMethod,
      captureProfile: ['exact_pid_runtime', 'exact_binary_runtime']
        .includes(response.capture_profile)
        ? response.capture_profile
        : 'exact_pid_runtime',
      captureMode: 'encrypted_full',
      captureCompleteness: ['complete', 'partial', 'truncated']
        .includes(response.capture_completeness)
        ? response.capture_completeness
        : 'complete',
      parseStatus: 'parsed',
      rawRetentionState: 'encrypted',
      presentationState: 'redacted',
    },
    assistantResponse: {
      eventType: 'AssistantResponseObserved',
      messageRole: 'assistant',
      contentBytes: encoded.byteLength,
      contentSha256: digest,
      content: assistant,
    },
  };
  return body;
}

const SEALED_CONTENT_SCHEMA = 'anysentry.interaction-spool-sealed.v1';

function spoolEncryptionKey(sourceToken) {
  return crypto
    .createHash('sha256')
    .update('AnySentry Observer Interaction spool v1\0')
    .update(String(sourceToken || ''))
    .digest();
}

function sealContentBody(body, key) {
  const iv = crypto.randomBytes(12);
  const aad = Buffer.from(`${SEALED_CONTENT_SCHEMA}\0${body.sourceEventId}`, 'utf8');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(body), 'utf8'),
    cipher.final(),
  ]);
  return {
    schemaVersion: SEALED_CONTENT_SCHEMA,
    lane: 'content',
    sourceEventId: body.sourceEventId,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

function unsealContentBody(envelope, key) {
  if (envelope?.schemaVersion !== SEALED_CONTENT_SCHEMA || envelope?.lane !== 'content') {
    return undefined;
  }
  const aad = Buffer.from(
    `${SEALED_CONTENT_SCHEMA}\0${String(envelope.sourceEventId || '')}`,
    'utf8',
  );
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(String(envelope.iv || ''), 'base64'),
  );
  decipher.setAAD(aad);
  decipher.setAuthTag(Buffer.from(String(envelope.tag || ''), 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(String(envelope.ciphertext || ''), 'base64')),
    decipher.final(),
  ]);
  try {
    return JSON.parse(plaintext.toString('utf8'));
  } finally {
    plaintext.fill(0);
  }
}

class InteractionForwarder {
  constructor(options) {
    this.enabled = enabled(process.env.ANYSENTRY_INTERACTIONS);
    this.writerId = options.writerId;
    this.collectorId = options.collectorId;
    this.sourceId = options.sourceId;
    this.sourceToken = options.sourceToken;
    this.target = new URL(
      process.env.ANYSENTRY_INTERACTION_INGEST_URL
      || interactionTarget(options.ingestTarget),
    );
    this.contentTarget = new URL(
      process.env.ANYSENTRY_INTERACTION_CONTENT_INGEST_URL
      || interactionContentTarget(options.ingestTarget),
    );
    this.spoolKey = spoolEncryptionKey(this.sourceToken);
    this.timeoutMs = bounded(
      process.env.ANYSENTRY_INTERACTION_HTTP_TIMEOUT_MS,
      10_000,
      500,
      120_000,
    );
    this.retryBaseMs = bounded(
      process.env.ANYSENTRY_INTERACTION_RETRY_BASE_MS,
      250,
      50,
      10_000,
    );
    this.retryMaxMs = bounded(
      process.env.ANYSENTRY_INTERACTION_RETRY_MAX_MS,
      30_000,
      this.retryBaseMs,
      300_000,
    );
    this.attempts = new Map();
    this.inflight = false;
    this.activeRequest = undefined;
    this.accepting = true;
    this.closed = false;
    this.timer = undefined;
    this.metrics = {
      observed: 0,
      spooled: 0,
      acknowledged: 0,
      retried: 0,
      rejected: 0,
      lostAtCapacity: 0,
      lossLedgerRotations: 0,
      lossLedgerFilesPruned: 0,
      lastError: undefined,
    };
    if (!this.enabled) return;
    if (!this.collectorId || !this.sourceId || !this.sourceToken) {
      this.enabled = false;
      this.metrics.lastError =
        'interaction forwarding requires collectorId, protected sourceId, and source token';
      console.error(`[observer-interaction] disabled: ${this.metrics.lastError}`);
      return;
    }
    const spoolPath =
      process.env.ANYSENTRY_INTERACTION_SPOOL_PATH
      || `${options.spoolPath}.interactions`;
    this.lossLedgerPath =
      process.env.ANYSENTRY_INTERACTION_LOSS_LEDGER_PATH
      || `${spoolPath}.loss.jsonl`;
    this.lossLedgerMaxFiles = bounded(
      process.env.ANYSENTRY_INTERACTION_LOSS_LEDGER_MAX_FILES,
      4,
      1,
      64,
    );
    this.spool = new DurableSpool({
      writerId: `${this.writerId}:interactions`,
      filePath: spoolPath,
      dlqPath: process.env.ANYSENTRY_INTERACTION_DLQ_PATH,
      maxRecords: process.env.ANYSENTRY_INTERACTION_SPOOL_MAX_RECORDS || 250_000,
      maxBytes:
        process.env.ANYSENTRY_INTERACTION_SPOOL_MAX_BYTES
        || 512 * 1024 * 1024,
      // LLM connection observations are low-frequency relative to kernel events. Sync each put
      // before returning so a host crash cannot erase the acknowledged local handoff.
      fsyncMode: process.env.ANYSENTRY_INTERACTION_SPOOL_FSYNC || 'always',
      fsyncMs: process.env.ANYSENTRY_INTERACTION_SPOOL_FSYNC_MS || 250,
    });
    this.pump();
  }

  observe(observerEvent, context) {
    if (!this.enabled || !this.accepting || this.closed || !this.spool) return false;
    const mappingContext = {
      writerId: this.writerId,
      collectorId: this.collectorId,
      line: context.line,
      agentInstanceId: context.agentInstanceId,
      workspacePath: context.workspacePath,
    };
    const content = contentEvent(observerEvent, mappingContext);
    const response = content ? undefined : responseEvent(observerEvent, mappingContext);
    const body = content || response || metadataEvent(observerEvent, mappingContext);
    if (!body) return false;
    this.metrics.observed += 1;
    if (body.process.pid <= 0) {
      this.recordLoss(body, 'missing_process_pid');
      return false;
    }
    if (this.spool.atCapacity()) {
      this.metrics.lostAtCapacity += 1;
      this.recordLoss(body, 'interaction_spool_capacity');
      return false;
    }
    const carriesContent = Boolean(content)
      || response?.assistantResponse?.content !== undefined;
    const queuedBody = carriesContent ? sealContentBody(body, this.spoolKey) : body;
    const inserted = this.spool.put({
      id: body.sourceEventId,
      body: queuedBody,
      priority: 3,
      queuedAt: Date.now(),
    });
    if (inserted) this.metrics.spooled += 1;
    this.pump();
    return inserted;
  }

  status() {
    return {
      enabled: this.enabled,
      target: this.target.toString(),
      contentTarget: this.contentTarget.toString(),
      captureMode: 'metadata_and_encrypted_content',
      accepting: this.accepting,
      inflight: this.inflight,
      ...(this.spool?.status() || {}),
      ...this.metrics,
    };
  }

  beginDrain() {
    this.accepting = false;
    this.pump();
    return this.hasPendingWork();
  }

  hasPendingWork() {
    if (!this.enabled || this.closed || !this.spool) return false;
    return this.inflight || Boolean(this.timer) || this.spool.status().records > 0;
  }

  close() {
    if (this.closed) return;
    this.accepting = false;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    // A forced shutdown must leave an unacknowledged put in the durable WAL. Destroying the
    // request is safe only after marking the instance closed: its asynchronous error callback
    // then skips ACK/DLQ/retry work instead of writing to an already closed spool.
    const activeRequest = this.activeRequest;
    this.activeRequest = undefined;
    activeRequest?.destroy(new Error('interaction forwarder closed before durable receipt'));
    this.spool?.close();
    this.spoolKey?.fill(0);
  }

  pump(delayMs = 0) {
    if (!this.enabled || this.closed || this.inflight || this.timer || !this.spool) return;
    if (delayMs > 0) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.pump();
      }, delayMs);
      this.timer.unref();
      return;
    }
    const record = this.spool.available(new Set(), 1)[0];
    if (!record) return;
    let deliveryBody;
    let deliveryTarget = this.target;
    try {
      if (record.body?.schemaVersion === SEALED_CONTENT_SCHEMA) {
        deliveryBody = unsealContentBody(record.body, this.spoolKey);
        deliveryTarget = this.contentTarget;
      } else {
        // Backward-compatible replay of metadata WAL entries written before content support.
        deliveryBody = record.body;
      }
      if (!deliveryBody?.sourceEventId) {
        throw new Error('interaction spool record could not be decrypted or has no sourceEventId');
      }
    } catch (error) {
      this.metrics.lastError = String(error?.message || error).slice(0, 500);
      this.retry(record, error);
      return;
    }
    this.inflight = true;
    this.post(deliveryBody, deliveryTarget, (error, receipt, permanent) => {
      this.inflight = false;
      if (this.closed) return;
      if (!error && receipt?.accepted === true && receipt?.kafkaDurable === true) {
        if (receipt.sourceEventId !== deliveryBody.sourceEventId) {
          this.retry(record, new Error('durable receipt sourceEventId mismatch'));
          return;
        }
        this.spool.ack([record.id]);
        this.attempts.delete(record.id);
        this.metrics.acknowledged += 1;
        this.metrics.lastError = undefined;
        this.pump();
        return;
      }
      if (permanent) {
        this.spool.deadLetter([record], error?.message || 'permanent interaction rejection');
        this.attempts.delete(record.id);
        this.metrics.rejected += 1;
        this.metrics.lastError = error?.message;
        this.pump();
        return;
      }
      this.retry(record, error || new Error('interaction durable receipt was not returned'));
    });
  }

  retry(record, error) {
    const attempt = (this.attempts.get(record.id) || 0) + 1;
    this.attempts.set(record.id, attempt);
    this.metrics.retried += 1;
    this.metrics.lastError = String(error?.message || error).slice(0, 500);
    const delayMs = Math.min(this.retryMaxMs, this.retryBaseMs * (2 ** Math.min(attempt - 1, 16)));
    this.pump(Math.max(1, Math.round(delayMs * (0.8 + Math.random() * 0.4))));
  }

  post(body, requestTarget, done) {
    const payload = Buffer.from(JSON.stringify(body));
    const transport = requestTarget.protocol === 'https:' ? https : http;
    let settled = false;
    const finish = (error, receipt, permanent) => {
      if (settled) return;
      settled = true;
      this.activeRequest = undefined;
      done(error, receipt, permanent);
    };
    const request = transport.request(
      {
        protocol: requestTarget.protocol,
        hostname: requestTarget.hostname,
        port: requestTarget.port || undefined,
        path: `${requestTarget.pathname}${requestTarget.search}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': payload.byteLength,
          'X-AnySentry-Source-Id': this.sourceId,
          'X-AnySentry-Ingest-Token': this.sourceToken,
        },
      },
      (response) => {
        const chunks = [];
        let bytes = 0;
        response.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes <= 1024 * 1024) chunks.push(chunk);
        });
        response.on('end', () => {
          const status = Number(response.statusCode || 0);
          let parsed;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          } catch {}
          const receipt = parsed?.data && typeof parsed.data === 'object' ? parsed.data : parsed;
          if (status >= 200 && status < 300) {
            finish(undefined, receipt, false);
            return;
          }
          const message =
            typeof parsed?.message === 'string'
              ? parsed.message
              : `interaction HTTP ${status || 'unknown'}`;
          const retryable =
            status === 0 || status === 408 || status === 425 || status === 429 || status >= 500;
          finish(new Error(message), undefined, !retryable);
        });
      },
    );
    this.activeRequest = request;
    request.setTimeout(this.timeoutMs, () => request.destroy(new Error('interaction request timed out')));
    request.on('error', (error) => finish(error, undefined, false));
    request.end(payload);
  }

  recordLoss(body, reason) {
    if (!this.lossLedgerPath) return;
    try {
      fs.mkdirSync(path.dirname(this.lossLedgerPath), { recursive: true, mode: 0o700 });
      if (fs.existsSync(this.lossLedgerPath)) {
        const size = fs.statSync(this.lossLedgerPath).size;
        if (size >= 16 * 1024 * 1024) {
          const oldest = `${this.lossLedgerPath}.${this.lossLedgerMaxFiles}`;
          if (fs.existsSync(oldest)) {
            fs.unlinkSync(oldest);
            this.metrics.lossLedgerFilesPruned += 1;
          }
          for (let index = this.lossLedgerMaxFiles - 1; index >= 1; index -= 1) {
            const from = `${this.lossLedgerPath}.${index}`;
            if (fs.existsSync(from)) {
              fs.renameSync(from, `${this.lossLedgerPath}.${index + 1}`);
            }
          }
          fs.renameSync(this.lossLedgerPath, `${this.lossLedgerPath}.1`);
          this.metrics.lossLedgerRotations += 1;
        }
      }
      fs.appendFileSync(
        this.lossLedgerPath,
        `${JSON.stringify({
          schemaVersion: 'anysentry.interaction-loss.v1',
          sourceEventId: body.sourceEventId,
          observedAt: body.observedAt,
          collectorId: body.collectorId,
          process: body.process,
          reason,
          recordedAt: Date.now(),
        })}\n`,
        { encoding: 'utf8', mode: 0o600 },
      );
    } catch (error) {
      this.metrics.lastError = `loss ledger unavailable: ${error.message}`;
    }
  }
}

module.exports = {
  InteractionForwarder,
  contentEvent,
  responseEvent,
  durationMs,
  interactionContentTarget,
  interactionTarget,
  isAgentInteractionClassification,
  looksLikeA3sCodeProcess,
  looksLikeKimiCodeProcess,
  metadataEvent,
  observedAtMillis,
  providerName,
  sealContentBody,
  stableSourceEventId,
  unsealContentBody,
};
