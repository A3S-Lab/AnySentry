import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile, readlink } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { writeInvocationFallback } from './pi-invocation-fallback.mjs';

const SCHEMA_VERSION = 'anysentry.agent_adapter_event.v1';
const DEFAULT_QUEUE_LIMIT = 256;
const DEFAULT_BATCH_SIZE = 32;
const DEFAULT_FLUSH_MS = 50;
const DEFAULT_TIMEOUT_MS = 3_000;

function text(value, limit = 512) {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > limit || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    return undefined;
  }
  return normalized;
}

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function pidNamespaceInode(value) {
  const match = typeof value === 'string' ? value.match(/^pid:\[(\d+)\]$/u) : undefined;
  return match?.[1];
}

function innermostNamespacePid(status) {
  const line = typeof status === 'string'
    ? status.split(/\r?\n/u).find((item) => item.startsWith('NSpid:'))
    : undefined;
  const ids = line?.slice('NSpid:'.length).trim().split(/\s+/u).filter((item) => /^\d+$/u.test(item));
  const value = Number(ids?.at(-1));
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function stableValue(value, depth = 0) {
  if (depth > 4) return '[depth-limited]';
  if (value === null || ['boolean', 'number', 'string'].includes(typeof value)) return value;
  if (Array.isArray(value)) return value.slice(0, 32).map((item) => stableValue(item, depth + 1));
  if (!value || typeof value !== 'object') return String(value);
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .slice(0, 64)
      .map(([key, item]) => [key, stableValue(item, depth + 1)]),
  );
}

function canonicalHash(value) {
  return sha256(JSON.stringify(stableValue(value)));
}

function redactSensitiveCommand(value) {
  return value
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^"'\s,}&]+/giu, '$1[redacted]')
    .replace(/(["']?(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password|passwd|credential)["']?\s*[:=]\s*["']?)[^"'\s,}&]+/giu, '$1[redacted]')
    .replace(/sk-[A-Za-z0-9_-]{12,}/gu, 'sk-[redacted]');
}

function safeCommandExecutable(command) {
  const first = command.trim().split(/\s+/u)[0];
  // An assignment such as OPENAI_API_KEY=... is data, not an executable, and may itself carry a
  // credential. Keep this display hint deliberately narrower than the command fingerprint.
  if (!first || first.includes('=') || !/^[A-Za-z0-9_+./-]{1,240}$/u.test(first)) return undefined;
  return path.basename(first);
}

function adapterEndpoint(raw) {
  const value = text(raw, 2_048);
  if (!value) return undefined;
  let url;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (!['http:', 'https:'].includes(url.protocol)) return undefined;
  if (/\/security-center\/ingest\/?$/u.test(url.pathname)) {
    url.pathname = url.pathname.replace(/\/ingest\/?$/u, '/ingest/events');
  }
  return url;
}

async function processFacts() {
  const facts = { pid: process.pid };
  try {
    facts.pidNamespace = pidNamespaceInode(await readlink('/proc/self/ns/pid'));
  } catch {}
  try {
    facts.namespacePid = innermostNamespacePid(await readFile('/proc/self/status', 'utf8')) ?? process.pid;
  } catch {
    facts.namespacePid = process.pid;
  }
  try {
    const stat = await readFile('/proc/self/stat', 'utf8');
    const close = stat.lastIndexOf(')');
    const fields = close >= 0 ? stat.slice(close + 1).trim().split(/\s+/u) : [];
    if (/^\d+$/u.test(fields[19] ?? '')) facts.startTimeTicks = fields[19];
  } catch {}
  try {
    facts.cgroup = (await readFile('/proc/self/cgroup', 'utf8')).trim().slice(0, 2_048);
  } catch {}
  try {
    facts.bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim().slice(0, 128);
  } catch {}
  try {
    facts.hostId = (await readFile('/etc/machine-id', 'utf8')).trim().slice(0, 128);
  } catch {}
  return facts;
}

function workspacePath(raw, cwd) {
  return text(raw, 500) ?? text(cwd, 500) ?? process.cwd();
}

function resolvedToolPath(args, cwd) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined;
  const candidate = text(args.path ?? args.file_path ?? args.file ?? args.directory, 4_096);
  if (!candidate) return undefined;
  return path.normalize(path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate));
}

function toolResource(toolName, args, cwd, configuredWorkspace, commandMode) {
  const attributes = {
    'gen_ai.tool.name': text(toolName, 120) ?? 'unknown',
    'anysentry.tool.args_hash': canonicalHash(args),
  };
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    attributes['anysentry.tool.arg_keys'] = Object.keys(args).sort().slice(0, 32).join(',');
  }

  const resourcePath = resolvedToolPath(args, cwd);
  if (resourcePath) {
    attributes['anysentry.tool.resource_kind'] = 'file';
    attributes['anysentry.tool.resource_hash'] = sha256(resourcePath);
    const relative = path.relative(configuredWorkspace, resourcePath);
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
      attributes['anysentry.tool.resource_path'] = resourcePath.slice(0, 1_024);
      attributes['anysentry.tool.resource_scope'] = 'workspace';
    } else {
      attributes['anysentry.tool.resource_name'] = path.basename(resourcePath).slice(0, 240);
      attributes['anysentry.tool.resource_scope'] = 'external_hashed';
    }
  }

  const command = args && typeof args === 'object' && !Array.isArray(args)
    ? text(args.command ?? args.cmd, 16_384)
    : undefined;
  if (command) {
    attributes['anysentry.tool.resource_kind'] = 'command';
    attributes['anysentry.tool.command_hash'] = sha256(command);
    attributes['anysentry.tool.command_executable'] = safeCommandExecutable(command);
    if (commandMode === 'full') {
      attributes['anysentry.tool.command'] = redactSensitiveCommand(command).slice(0, 1_000);
    }
  }
  return attributes;
}

function resultMetadata(result) {
  let serialized = '';
  try {
    const encoded = JSON.stringify(result);
    if (typeof encoded === 'string') serialized = encoded;
  } catch {}
  return {
    'anysentry.tool.result_bytes': Buffer.byteLength(serialized),
    'anysentry.tool.result_hash': serialized ? sha256(serialized) : undefined,
  };
}

function configuration(env = process.env) {
  const endpoint = adapterEndpoint(env.ANYSENTRY_PI_ADAPTER_URL ?? env.ANYSENTRY_ADAPTER_URL ?? env.ANYSENTRY_INGEST_URL);
  const sourceId = text(env.ANYSENTRY_ADAPTER_SOURCE_ID ?? env.ANYSENTRY_SOURCE_ID, 240);
  let token = text(env.ANYSENTRY_ADAPTER_TOKEN ?? env.ANYSENTRY_INGEST_TOKEN, 4_096);
  const tokenFile = text(env.ANYSENTRY_ADAPTER_TOKEN_FILE, 4_096);
  if (!token && tokenFile) {
    try {
      token = text(readFileSync(tokenFile, 'utf8'), 4_096);
    } catch {}
  }
  return {
    enabled: Boolean(endpoint && sourceId && token),
    endpoint,
    sourceId,
    token,
    sourceType: text(env.ANYSENTRY_ADAPTER_SOURCE_TYPE, 80) ?? 'custom',
    agentId: text(env.AGENT_ID, 240) ?? 'pi-coding-agent',
    workspacePath: workspacePath(env.ANYSENTRY_WORKSPACE_PATH ?? env.AGENT_WORKSPACE, process.cwd()),
    tenantId: text(env.ANYSENTRY_TENANT_ID, 240) ?? 'default',
    environmentId: text(env.ANYSENTRY_ENVIRONMENT_ID, 240) ?? 'local',
    workspaceId: text(env.ANYSENTRY_WORKSPACE_ID, 240),
    physicalWorkloadId: text(env.ANYSENTRY_PHYSICAL_WORKLOAD_ID, 500),
    agentScopeId: text(env.ANYSENTRY_AGENT_SCOPE_ID, 500),
    collectorId: text(env.A3S_OBSERVER_COLLECTOR_ID ?? env.COLLECTOR_ID, 240),
    commandMode: text(env.ANYSENTRY_ADAPTER_COMMAND_MODE, 20) === 'full' ? 'full' : 'hash',
    queueLimit: boundedInteger(env.ANYSENTRY_ADAPTER_QUEUE_LIMIT, DEFAULT_QUEUE_LIMIT, 16, 4_096),
    batchSize: boundedInteger(env.ANYSENTRY_ADAPTER_BATCH_SIZE, DEFAULT_BATCH_SIZE, 1, 128),
    flushMs: boundedInteger(env.ANYSENTRY_ADAPTER_FLUSH_MS, DEFAULT_FLUSH_MS, 10, 5_000),
    timeoutMs: boundedInteger(env.ANYSENTRY_ADAPTER_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 250, 30_000),
  };
}

class BoundedSender {
  constructor(config) {
    this.config = config;
    this.queue = [];
    this.timer = undefined;
    this.inflight = false;
    this.dropped = 0;
    this.failures = 0;
    this.consecutiveFailures = 0;
  }

  enqueue(event) {
    if (!this.config.enabled) return false;
    if (this.queue.length >= this.config.queueLimit) {
      this.queue.shift();
      this.dropped += 1;
    }
    this.queue.push(event);
    this.schedule();
    return true;
  }

  schedule(delayMs = this.config.flushMs) {
    if (this.timer || this.inflight) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, delayMs);
    this.timer.unref?.();
  }

  async flush() {
    if (this.inflight || !this.queue.length || !this.config.enabled) return;
    this.inflight = true;
    const events = this.queue.splice(0, this.config.batchSize);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    timeout.unref?.();
    let nextDelayMs = this.config.flushMs;
    try {
      const response = await fetch(this.config.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.token}`,
          'x-anysentry-source-id': this.config.sourceId,
        },
        body: JSON.stringify({
          sourceId: this.config.sourceId,
          sourceType: this.config.sourceType,
          collectorId: this.config.collectorId,
          workspacePath: this.config.workspacePath,
          events,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        if (![408, 425, 429].includes(response.status) && response.status < 500) {
          // A 409 means this producer id was already durably bound to another payload. Retrying it
          // can never change that fact and previously amplified four Pi start events into thousands
          // of API conflicts. Preserve the first accepted revision and terminate this duplicate.
          this.failures += events.length;
          this.dropped += events.length;
          this.consecutiveFailures = 0;
          return;
        }
        throw new Error(`adapter ingest returned ${response.status}`);
      }
      const body = await response.json();
      const ack = body?.data ?? body;
      const accepted = Number(ack?.acceptedEvents);
      if (!Number.isSafeInteger(accepted) || accepted < 0 || accepted > events.length) {
        throw new Error('adapter ingest returned an invalid acknowledgement');
      }
      if (Array.isArray(ack?.items)) {
        if (
          ack.items.length !== events.length
          || ack.items.some((item) => !item || typeof item !== 'object' || typeof item.accepted !== 'boolean')
          || ack.items.filter((item) => item.accepted).length !== accepted
        ) {
          throw new Error('adapter ingest returned inconsistent item acknowledgements');
        }
        const retryEvents = ack.items.flatMap((item, index) =>
          !item.accepted && item.disposition === 'retryable' ? [events[index]] : []);
        const terminalRejected = ack.items.filter((item) =>
          !item.accepted && item.disposition !== 'retryable').length;
        this.failures += terminalRejected + retryEvents.length;
        this.dropped += terminalRejected;
        if (retryEvents.length) {
          this.consecutiveFailures += 1;
          nextDelayMs = Math.min(
            5_000,
            Math.max(250, this.config.flushMs) * (2 ** Math.min(5, this.consecutiveFailures - 1)),
          );
          const combined = [...retryEvents, ...this.queue];
          const overflow = Math.max(0, combined.length - this.config.queueLimit);
          this.queue = combined.slice(0, this.config.queueLimit);
          this.dropped += overflow;
        } else {
          this.consecutiveFailures = 0;
        }
      } else if (accepted !== events.length) {
        // Without positional items a partial count cannot prove which semantic events were
        // accepted. Retry the immutable whole batch instead of guessing or reordering it.
        throw new Error('adapter ingest returned a partial acknowledgement without items');
      } else {
        this.consecutiveFailures = 0;
      }
    } catch {
      this.failures += events.length;
      this.consecutiveFailures += 1;
      nextDelayMs = Math.min(
        5_000,
        Math.max(250, this.config.flushMs) * (2 ** Math.min(5, this.consecutiveFailures - 1)),
      );
      const combined = [...events, ...this.queue];
      const overflow = Math.max(0, combined.length - this.config.queueLimit);
      this.queue = combined.slice(0, this.config.queueLimit);
      this.dropped += overflow;
    } finally {
      clearTimeout(timeout);
      this.inflight = false;
      if (this.queue.length) this.schedule(nextDelayMs);
    }
  }

  async close() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const deadline = Date.now() + this.config.timeoutMs;
    while ((this.queue.length || this.inflight) && Date.now() < deadline) {
      await this.flush();
      if (this.inflight) await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

function adapterEvent(state, details) {
  const at = details.at ?? Date.now();
  const traceId = details.traceId ?? sha256(`${state.sessionId}\0${details.invocationId}`).slice(0, 32);
  const spanId = sha256(`${traceId}\0${details.toolCallId ?? details.operation}`).slice(0, 16);
  const attributes = Object.fromEntries(Object.entries({
    'anysentry.adapter.schema': SCHEMA_VERSION,
    'anysentry.adapter.runtime': 'pi',
    'anysentry.lifecycle.phase': details.phase,
    'gen_ai.operation.name': details.operation,
    'gen_ai.agent.name': state.config.agentId,
    'gen_ai.conversation.id': state.sessionId,
    'gen_ai.tool.call.id': details.toolCallId,
    'process.pid': state.processFacts.pid,
    'process.pid_namespace': state.processFacts.pidNamespace,
    'process.namespace_pid': state.processFacts.namespacePid,
    'process.start_time_ticks': state.processFacts.startTimeTicks,
    'process.cgroup': state.processFacts.cgroup,
    'host.id': state.processFacts.hostId,
    'host.boot_id': state.processFacts.bootId,
    // Keep the OTel spellings above and also emit AnySentry's existing ProcessContext aliases.
    // These are producer claims, not Observer attestation; the API trust resolver keeps those
    // authorities separate while the evidence linker can compare the exact process tuple.
    pid: state.processFacts.pid,
    pidNamespace: state.processFacts.pidNamespace,
    namespacePid: state.processFacts.namespacePid,
    startTimeTicks: state.processFacts.startTimeTicks,
    cgroup: state.processFacts.cgroup,
    hostId: state.processFacts.hostId,
    bootId: state.processFacts.bootId,
    tenantId: state.config.tenantId,
    environmentId: state.config.environmentId,
    workspaceId: state.config.workspaceId,
    physicalWorkloadId: state.config.physicalWorkloadId,
    agentScopeId: state.config.agentScopeId,
    ...details.attributes,
  }).filter(([, value]) => value !== undefined));
  return {
    id: `pi_${sha256(`${state.sessionId}\0${details.invocationId}\0${details.toolCallId ?? ''}\0${details.phase}\0${at}`).slice(0, 24)}`,
    at,
    eventKind: details.eventKind,
    eventCategory: details.eventCategory,
    activityContext: 'agent_action',
    subject: details.subject,
    workspacePath: state.config.workspacePath,
    agentId: state.config.agentId,
    sessionId: state.sessionId,
    invocationId: details.invocationId,
    toolCallId: details.toolCallId,
    traceId,
    spanId,
    parentSpanId: details.parentSpanId,
    runId: details.invocationId,
    taskId: details.toolCallId,
    pid: state.processFacts.pid,
    cwd: details.cwd,
    collectorId: state.config.collectorId,
    attributes,
  };
}

export default async function anySentryPiAdapter(pi) {
  const config = configuration();
  if (!config.enabled) return;
  const sender = new BoundedSender(config);
  const facts = await processFacts();
  const activeTools = new Map();
  const state = {
    config,
    processFacts: facts,
    sessionId: undefined,
    currentInvocation: undefined,
    invocationSpanId: undefined,
    invocationSequence: 0,
    currentTurnIndex: undefined,
  };

  function ensureSession(ctx) {
    state.sessionId = text(ctx.sessionManager.getSessionId(), 512)
      ?? state.sessionId
      ?? `pi-session-${randomUUID()}`;
    return state.sessionId;
  }

  function startInvocation(ctx, at = Date.now(), turnIndex) {
    const sessionId = ensureSession(ctx);
    if (state.currentInvocation) return state.currentInvocation;
    state.invocationSequence += 1;
    state.currentInvocation = `pi-invocation:${sha256(`${sessionId}\0${state.invocationSequence}\0${Math.trunc(at)}`).slice(0, 40)}`;
    const traceId = sha256(`${sessionId}\0${state.currentInvocation}`).slice(0, 32);
    state.invocationSpanId = sha256(`${traceId}\0invoke_agent`).slice(0, 16);
    sender.enqueue(adapterEvent(state, {
      at,
      eventKind: 'AgentInvocation',
      eventCategory: 'runtime',
      operation: 'invoke_agent',
      phase: 'start',
      invocationId: state.currentInvocation,
      traceId,
      subject: 'Pi agent invocation started',
      cwd: ctx.cwd,
      attributes: {
        ...(Number.isSafeInteger(turnIndex) ? { 'anysentry.agent.initial_turn_index': turnIndex } : {}),
      },
    }));
    return state.currentInvocation;
  }

  function endInvocation(ctx, options = {}) {
    if (!state.currentInvocation) return;
    const invocationId = state.currentInvocation;
    sender.enqueue(adapterEvent(state, {
      at: options.at ?? Date.now(),
      eventKind: 'AgentInvocation',
      eventCategory: 'runtime',
      operation: 'invoke_agent',
      phase: 'end',
      invocationId,
      subject: options.incomplete ? 'Pi agent invocation incomplete' : 'Pi agent invocation completed',
      cwd: ctx?.cwd ?? state.config.workspacePath,
      attributes: {
        ...(Number.isSafeInteger(state.currentTurnIndex)
          ? { 'anysentry.agent.final_turn_index': state.currentTurnIndex }
          : {}),
        ...(Number.isSafeInteger(options.messageCount)
          ? { 'anysentry.agent.message_count': options.messageCount }
          : {}),
        ...(options.incomplete ? {
          'anysentry.agent.incomplete': true,
          'anysentry.agent.incomplete_reason': text(options.reason, 120) ?? 'session_shutdown',
        } : {}),
      },
    }));
    state.currentInvocation = undefined;
    state.invocationSpanId = undefined;
    state.currentTurnIndex = undefined;
  }

  // Some Pi CLI paths use process.exit() without publishing agent_end/session_shutdown. Async
  // network delivery is impossible from an exit handler, so persist one bounded, token-free end
  // event for the parent pi-loop to deliver before it starts another child.
  process.once('exit', () => {
    if (!state.currentInvocation) return;
    const invocationId = state.currentInvocation;
    writeInvocationFallback({
      sourceId: config.sourceId,
      sourceType: config.sourceType,
      workspacePath: config.workspacePath,
      event: adapterEvent(state, {
        at: Date.now(),
        eventKind: 'AgentInvocation',
        eventCategory: 'runtime',
        operation: 'invoke_agent',
        phase: 'end',
        invocationId,
        subject: 'Pi agent invocation incomplete',
        cwd: config.workspacePath,
        attributes: {
          ...(Number.isSafeInteger(state.currentTurnIndex)
            ? { 'anysentry.agent.final_turn_index': state.currentTurnIndex }
            : {}),
          'anysentry.agent.incomplete': true,
          'anysentry.agent.incomplete_reason': 'process_exit_without_lifecycle_end',
        },
      }),
    });
  });

  pi.on('agent_start', (_event, ctx) => {
    startInvocation(ctx);
  });

  pi.on('turn_start', (event, ctx) => {
    state.currentTurnIndex = Number.isSafeInteger(event.turnIndex) ? event.turnIndex : undefined;
    // Compatibility fallback for an older Pi event sequence that omits agent_start. It creates
    // one outer Invocation and intentionally does not rotate it at turn_end.
    startInvocation(ctx, event.timestamp ?? Date.now(), event.turnIndex);
  });

  pi.on('tool_execution_start', (event, ctx) => {
    const invocationId = startInvocation(ctx);
    const startedAt = Date.now();
    const attributes = toolResource(event.toolName, event.args, ctx.cwd, config.workspacePath, config.commandMode);
    activeTools.set(event.toolCallId, { invocationId, startedAt, attributes, cwd: ctx.cwd });
    sender.enqueue(adapterEvent(state, {
      at: startedAt,
      eventKind: 'AgentTool',
      eventCategory: 'tool',
      operation: 'execute_tool',
      phase: 'start',
      invocationId,
      toolCallId: event.toolCallId,
      parentSpanId: state.invocationSpanId,
      subject: `Pi tool ${text(event.toolName, 120) ?? 'unknown'} started`,
      cwd: ctx.cwd,
      attributes,
    }));
  });

  pi.on('tool_execution_end', (event, ctx) => {
    ensureSession(ctx);
    const active = activeTools.get(event.toolCallId);
    activeTools.delete(event.toolCallId);
    const endedAt = Date.now();
    const invocationId = active?.invocationId ?? startInvocation(ctx);
    sender.enqueue(adapterEvent(state, {
      at: endedAt,
      eventKind: 'AgentTool',
      eventCategory: 'tool',
      operation: 'execute_tool',
      phase: 'end',
      invocationId,
      toolCallId: event.toolCallId,
      parentSpanId: state.invocationSpanId,
      subject: `Pi tool ${text(event.toolName, 120) ?? 'unknown'} ${event.isError ? 'failed' : 'completed'}`,
      cwd: active?.cwd ?? ctx.cwd,
      attributes: {
        ...active?.attributes,
        ...resultMetadata(event.result),
        'anysentry.tool.is_error': event.isError,
        'anysentry.tool.duration_ms': active ? Math.max(0, endedAt - active.startedAt) : undefined,
      },
    }));
  });

  pi.on('turn_end', (event, ctx) => {
    ensureSession(ctx);
    state.currentTurnIndex = Number.isSafeInteger(event.turnIndex)
      ? event.turnIndex
      : state.currentTurnIndex;
  });

  pi.on('agent_end', (event, ctx) => {
    endInvocation(ctx, {
      messageCount: Array.isArray(event.messages) ? event.messages.length : undefined,
    });
  });

  pi.on('session_shutdown', async (event, ctx) => {
    endInvocation(ctx, {
      incomplete: true,
      reason: event?.reason ?? 'session_shutdown',
    });
    await sender.close();
  });
}

export const __testing = {
  BoundedSender,
  adapterEndpoint,
  canonicalHash,
  configuration,
  innermostNamespacePid,
  pidNamespaceInode,
  processFacts,
  redactSensitiveCommand,
  resultMetadata,
  safeCommandExecutable,
  toolResource,
};
