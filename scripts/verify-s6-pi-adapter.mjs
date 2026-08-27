import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import anySentryPiAdapter, {
  __testing,
} from '../examples/agent-runtime-lab/app/anysentry-pi-adapter.mjs';
import {
  deliverInvocationFallback,
  invocationFallbackPath,
  writeInvocationFallback,
} from '../examples/agent-runtime-lab/app/pi-invocation-fallback.mjs';

const received = [];
const headers = [];
const server = http.createServer((request, response) => {
  let body = '';
  request.setEncoding('utf8');
  request.on('data', (chunk) => { body += chunk; });
  request.on('end', () => {
    const parsed = JSON.parse(body);
    received.push(...parsed.events);
    headers.push(request.headers);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      code: 0,
      data: {
        accepted: true,
        acceptedEvents: parsed.events.length,
        items: parsed.events.map((_, index) => ({ index, accepted: true })),
      },
    }));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert(address && typeof address === 'object');

Object.assign(process.env, {
  ANYSENTRY_PI_ADAPTER_URL: `http://127.0.0.1:${address.port}/security-center/ingest`,
  ANYSENTRY_ADAPTER_SOURCE_ID: 'source-s6-pi-adapter',
  ANYSENTRY_ADAPTER_TOKEN: 'test-token-never-in-body',
  ANYSENTRY_WORKSPACE_PATH: '/workspace',
  ANYSENTRY_TENANT_ID: 'tenant-s6',
  ANYSENTRY_ENVIRONMENT_ID: 'test',
  ANYSENTRY_AGENT_SCOPE_ID: 'agent-scope-s6',
  AGENT_ID: 'pi-s6-agent',
  ANYSENTRY_ADAPTER_FLUSH_MS: '10',
});

const handlers = new Map();
const pi = {
  on(name, handler) {
    handlers.set(name, handler);
  },
};
await anySentryPiAdapter(pi);

for (const name of [
  'agent_start',
  'turn_start',
  'tool_execution_start',
  'tool_execution_end',
  'turn_end',
  'agent_end',
  'session_shutdown',
]) {
  assert.equal(typeof handlers.get(name), 'function', `Pi adapter registers ${name}`);
}

const context = {
  cwd: '/workspace',
  sessionManager: { getSessionId: () => 'pi-session-s6' },
};
await handlers.get('agent_start')({ type: 'agent_start' }, context);
await handlers.get('turn_start')({ turnIndex: 7, timestamp: 1_775_000_000_000 }, context);

const toolCases = [
  ['read-call', 'read', { path: '/workspace/canary.txt' }, { content: 'secret-read-result' }, false],
  ['write-call', 'write', { path: '/workspace/output.txt', content: 'secret-write-content' }, { ok: true }, false],
  ['bash-call', 'bash', { command: 'printf sk-super-secret >> /workspace/output.txt' }, { stdout: 'secret-command-result' }, false],
  ['custom-call', 'custom_inventory', { account: 'sk-private-account', query: 'production' }, { rows: ['secret-row'] }, false],
];
for (const [toolCallId, toolName, args, result, isError] of toolCases.slice(0, 2)) {
  await handlers.get('tool_execution_start')({ toolCallId, toolName, args }, context);
  await handlers.get('tool_execution_end')({ toolCallId, toolName, result, isError }, context);
}
await handlers.get('turn_end')({ turnIndex: 7, toolResults: toolCases.slice(0, 2).map(() => ({})) }, context);
await handlers.get('turn_start')({ turnIndex: 8, timestamp: 1_775_000_001_000 }, context);
for (const [toolCallId, toolName, args, result, isError] of toolCases.slice(2)) {
  await handlers.get('tool_execution_start')({ toolCallId, toolName, args }, context);
  await handlers.get('tool_execution_end')({ toolCallId, toolName, result, isError }, context);
}
await handlers.get('turn_end')({ turnIndex: 8, toolResults: toolCases.slice(2).map(() => ({})) }, context);
await handlers.get('agent_end')({ type: 'agent_end', messages: [{ role: 'assistant' }] }, context);

// A second outer Agent run in the same Conversation receives a new Invocation. Model turns inside
// either run never rotate it.
await handlers.get('agent_start')({ type: 'agent_start' }, context);
await handlers.get('turn_start')({ turnIndex: 9, timestamp: 1_775_000_002_000 }, context);
await handlers.get('turn_end')({ turnIndex: 9, toolResults: [] }, context);
await handlers.get('agent_end')({ type: 'agent_end', messages: [] }, context);
await handlers.get('session_shutdown')({ reason: 'quit' }, context);
await new Promise((resolve) => setTimeout(resolve, 25));
server.close();

assert.equal(received.length, 12, 'two invocation pairs and four tool span pairs are emitted');
assert(headers.every((item) => item.authorization === 'Bearer test-token-never-in-body'));
const serialized = JSON.stringify(received);
for (const secret of [
  'test-token-never-in-body',
  'secret-read-result',
  'secret-write-content',
  'sk-super-secret',
  'secret-command-result',
  'sk-private-account',
  'secret-row',
]) {
  assert(!serialized.includes(secret), `adapter payload does not contain ${secret}`);
}

const invocations = received.filter((event) => event.eventKind === 'AgentInvocation');
assert.equal(invocations.length, 4);
assert.equal(invocations[0].invocationId, invocations[1].invocationId);
assert.equal(invocations[0].traceId, invocations[1].traceId);
assert.equal(invocations[0].spanId, invocations[1].spanId);
assert.equal(invocations[0].attributes['gen_ai.operation.name'], 'invoke_agent');
assert.notEqual(invocations[0].invocationId, invocations[2].invocationId);
assert.equal(invocations[2].invocationId, invocations[3].invocationId);
assert.equal(invocations[1].attributes['anysentry.agent.final_turn_index'], 8);

for (const [toolCallId, toolName] of toolCases) {
  const pair = received.filter((event) => event.toolCallId === toolCallId);
  assert.equal(pair.length, 2, `${toolName} emits start/end`);
  assert.equal(pair[0].invocationId, invocations[0].invocationId);
  assert.equal(pair[0].traceId, invocations[0].traceId);
  assert.equal(pair[0].spanId, pair[1].spanId, `${toolName} lifecycle is one logical span`);
  assert.equal(pair[0].parentSpanId, invocations[0].spanId);
  assert.equal(pair[0].attributes['gen_ai.tool.name'], toolName);
  assert.equal(pair[0].attributes['gen_ai.operation.name'], 'execute_tool');
  assert.equal(pair[0].attributes['gen_ai.tool.call.id'], toolCallId);
  assert.equal(pair[0].attributes['gen_ai.conversation.id'], 'pi-session-s6');
  assert.equal(pair[1].attributes['anysentry.tool.is_error'], false);
  assert.equal(typeof pair[1].attributes['anysentry.tool.result_hash'], 'string');
}

const readStart = received.find((event) => event.toolCallId === 'read-call' && event.attributes['anysentry.lifecycle.phase'] === 'start');
assert.equal(readStart.attributes['anysentry.tool.resource_path'], '/workspace/canary.txt');
assert.equal(readStart.attributes['anysentry.tool.resource_scope'], 'workspace');
assert.equal(readStart.attributes.pid, process.pid, 'adapter emits the existing ProcessContext pid alias');
assert.equal(readStart.attributes.hostId, readStart.attributes['host.id']);
assert.equal(readStart.attributes.bootId, readStart.attributes['host.boot_id']);
assert.equal(readStart.attributes.startTimeTicks, readStart.attributes['process.start_time_ticks']);
assert.equal(readStart.attributes.pidNamespace, readStart.attributes['process.pid_namespace']);
assert.equal(readStart.attributes.namespacePid, readStart.attributes['process.namespace_pid']);
const bashStart = received.find((event) => event.toolCallId === 'bash-call' && event.attributes['anysentry.lifecycle.phase'] === 'start');
assert.equal(bashStart.attributes['anysentry.tool.command_executable'], 'printf');
assert.equal(typeof bashStart.attributes['anysentry.tool.command_hash'], 'string');
assert.equal(bashStart.attributes['anysentry.tool.command'], undefined);

assert.equal(__testing.adapterEndpoint('invalid-url'), undefined, 'invalid endpoint disables adapter instead of crashing Pi');
assert.equal(__testing.toolResource('read', { path: '/outside/secret.txt' }, '/workspace', '/workspace', 'hash')['anysentry.tool.resource_path'], undefined);
assert.equal(__testing.toolResource('read', { path: '/outside/secret.txt' }, '/workspace', '/workspace', 'hash')['anysentry.tool.resource_scope'], 'external_hashed');
const assignedSecretCommand = 'OPENAI_API_KEY=sk-1234567890abcdef node agent.mjs';
const assignedSecret = __testing.toolResource('bash', { command: assignedSecretCommand }, '/workspace', '/workspace', 'hash');
assert.equal(assignedSecret['anysentry.tool.command_executable'], undefined, 'an environment assignment is never exposed as an executable');
assert.equal(assignedSecret['anysentry.tool.command'], undefined, 'hash mode never emits a command');
assert.equal(assignedSecret['anysentry.tool.command_hash'].length, 64);
const explicitFull = __testing.toolResource('bash', { command: assignedSecretCommand }, '/workspace', '/workspace', 'full');
assert(!explicitFull['anysentry.tool.command'].includes('sk-1234567890abcdef'), 'explicit full mode still redacts known credentials');
assert(explicitFull['anysentry.tool.command'].includes('[redacted]'));
assert.deepEqual(__testing.resultMetadata(undefined), {
  'anysentry.tool.result_bytes': 0,
  'anysentry.tool.result_hash': undefined,
}, 'undefined custom-tool results are metadata-safe and never crash the adapter');
assert.equal(__testing.pidNamespaceInode('pid:[4026532441]'), '4026532441');
assert.equal(__testing.pidNamespaceInode('not-a-pid-namespace'), undefined);
assert.equal(__testing.innermostNamespacePid('Name:\tnode\nNSpid:\t42000\t1\n'), 1);

const originalFetch = globalThis.fetch;
const senderConfig = {
  enabled: true,
  endpoint: new URL('http://127.0.0.1:1/security-center/ingest/events'),
  sourceId: 'sender-test-source',
  token: 'sender-test-token',
  sourceType: 'custom',
  collectorId: 'sender-test-collector',
  workspacePath: '/workspace',
  queueLimit: 16,
  batchSize: 4,
  flushMs: 5_000,
  timeoutMs: 1_000,
};
try {
  let attempts = 0;
  globalThis.fetch = async (_url, options) => {
    attempts += 1;
    const body = JSON.parse(options.body);
    if (attempts === 1) return { ok: false, status: 503 };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        accepted: true,
        acceptedEvents: body.events.length,
        items: body.events.map((_, index) => ({ index, accepted: true })),
      }),
    };
  };
  const retrying = new __testing.BoundedSender(senderConfig);
  retrying.enqueue({ id: 'retry-stable-event' });
  await retrying.flush();
  assert.equal(retrying.queue.length, 1, 'transient failure retains the exact event for retry');
  assert.equal(retrying.consecutiveFailures, 1);
  if (retrying.timer) clearTimeout(retrying.timer);
  retrying.timer = undefined;
  await retrying.flush();
  assert.equal(retrying.queue.length, 0, 'unwrapped success acknowledgement drains the retry');
  assert.equal(retrying.consecutiveFailures, 0);
  assert.equal(attempts, 2);
  await retrying.close();

  globalThis.fetch = async () => ({ ok: false, status: 409 });
  const conflicting = new __testing.BoundedSender(senderConfig);
  conflicting.enqueue({ id: 'terminal-conflict' });
  await conflicting.flush();
  assert.equal(conflicting.queue.length, 0, 'a producer id conflict is terminal and never storms the API');
  assert.equal(conflicting.dropped, 1);
  assert.equal(conflicting.failures, 1);
  await conflicting.close();

  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    return body.events.length === 3
      ? {
          ok: true,
          status: 200,
          json: async () => ({
            acceptedEvents: 1,
            items: [
              { index: 0, accepted: true, disposition: 'retained' },
              { index: 1, accepted: false, disposition: 'retryable' },
              { index: 2, accepted: false, disposition: 'rejected' },
            ],
          }),
        }
      : {
          ok: true,
          status: 200,
          json: async () => ({
            acceptedEvents: body.events.length,
            items: body.events.map((_, index) => ({ index, accepted: true, disposition: 'retained' })),
          }),
        };
  };
  const positional = new __testing.BoundedSender(senderConfig);
  positional.enqueue({ id: 'accepted-prefix' });
  positional.enqueue({ id: 'retry-only-this-item' });
  positional.enqueue({ id: 'terminal-rejection' });
  await positional.flush();
  assert.deepEqual(positional.queue.map((item) => item.id), ['retry-only-this-item'],
    '200 per-item ACK retries only explicit retryable items without duplicating its accepted prefix');
  assert.equal(positional.dropped, 1, 'terminal per-item rejection is bounded and not retried');
  if (positional.timer) clearTimeout(positional.timer);
  positional.timer = undefined;
  await positional.flush();
  assert.equal(positional.queue.length, 0);
  await positional.close();
} finally {
  globalThis.fetch = originalFetch;
}

const fallbackRequests = [];
const fallbackServer = http.createServer((request, response) => {
  let body = '';
  request.setEncoding('utf8');
  request.on('data', (chunk) => { body += chunk; });
  request.on('end', () => {
    fallbackRequests.push({ headers: request.headers, body: JSON.parse(body) });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      code: 0,
      data: {
        acceptedEvents: 1,
        items: [{ index: 0, accepted: true, eventId: 'evt-fallback-test' }],
      },
    }));
  });
});
await new Promise((resolve) => fallbackServer.listen(0, '127.0.0.1', resolve));
const fallbackAddress = fallbackServer.address();
assert(fallbackAddress && typeof fallbackAddress === 'object');
const fallbackDirectory = await mkdtemp(path.join(os.tmpdir(), 'anysentry-pi-fallback-'));
const fallbackPid = 424_242;
const fallbackEnv = {
  ANYSENTRY_PI_FALLBACK_DIR: fallbackDirectory,
  ANYSENTRY_PI_ADAPTER_URL: `http://127.0.0.1:${fallbackAddress.port}/security-center/ingest/events`,
  ANYSENTRY_ADAPTER_SOURCE_ID: 'fallback-source',
  ANYSENTRY_ADAPTER_TOKEN: 'fallback-token-never-on-disk',
};
const fallbackEvent = {
  id: 'pi-fallback-end',
  at: 1_775_000_004_000,
  eventKind: 'AgentInvocation',
  eventCategory: 'runtime',
  subject: 'Pi agent invocation incomplete',
  agentId: 'pi-s6-agent',
  sessionId: 'pi-session-s6',
  invocationId: 'pi-invocation:fallback',
  runId: 'pi-invocation:fallback',
  workspacePath: '/workspace',
  attributes: {
    'anysentry.adapter.schema': 'anysentry.agent_adapter_event.v1',
    'anysentry.lifecycle.phase': 'end',
    'anysentry.agent.incomplete': true,
    'anysentry.agent.incomplete_reason': 'process_exit_without_lifecycle_end',
  },
};
assert.equal(writeInvocationFallback({
  sourceId: 'fallback-source',
  sourceType: 'custom',
  workspacePath: '/workspace',
  event: fallbackEvent,
}, fallbackPid, fallbackEnv), true);
const pendingPath = invocationFallbackPath(fallbackPid, fallbackEnv);
const pending = await readFile(pendingPath, 'utf8');
assert(!pending.includes('fallback-token-never-on-disk'), 'pending lifecycle fallback never stores credentials');
assert.equal((await deliverInvocationFallback(fallbackPid, fallbackEnv)).delivered, true);
assert.equal(fallbackRequests.length, 1);
assert.equal(fallbackRequests[0].headers.authorization, 'Bearer fallback-token-never-on-disk');
assert.deepEqual(fallbackRequests[0].body.events, [fallbackEvent]);
await assert.rejects(readFile(pendingPath, 'utf8'), (error) => error?.code === 'ENOENT');
await new Promise((resolve) => fallbackServer.close(resolve));
await rm(fallbackDirectory, { recursive: true, force: true });

console.log('S6 Pi adapter verification passed');
