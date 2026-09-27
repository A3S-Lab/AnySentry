#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import process from 'node:process';
import { ensureTestCertificates } from '../../pi-tls-observability-lab/app/generate-test-certs.mjs';

const port = Number(process.env.CLI_LAB_HTTPS_PORT || 19443);
const httpPort = Number(process.env.CLI_LAB_HTTP_PORT || 19080);
const tlsDirectory = process.env.CLI_LAB_TLS_DIR || path.resolve('.runtime/tls');
const resultsDirectory = process.env.CLI_LAB_RESULTS_DIR || path.resolve('.runtime/results');
const transcriptPath = path.join(resultsDirectory, 'cli-provider.ndjson');
const apiKey = process.env.CLI_LAB_API_KEY || 'fixture-key-not-secret';
const CODEX_PROMPT = 'CODEX_FINAL_PROMPT_SENTINEL_20260827';
const CODEX_TOOL = 'CODEX_TOOL_RESULT_SENTINEL_20260827';
const CLAUDE_PROMPT = 'CLAUDE_FINAL_PROMPT_SENTINEL_20260827';
const CLAUDE_TOOL = 'CLAUDE_TOOL_RESULT_SENTINEL_20260827';
const LANGCHAIN_TOOL = 'LANGCHAIN_HTTP_TOOL_RESULT_20260829';
let writeChain = Promise.resolve();

function record(value) {
  const line = `${JSON.stringify({
    schemaVersion: 'anysentry.cli_tls_provider.v1',
    atUnixNs: (BigInt(Date.now()) * 1_000_000n).toString(),
    atMonotonicNs: process.hrtime.bigint().toString(),
    ...value,
  })}\n`;
  writeChain = writeChain.then(() => appendFile(transcriptPath, line, { encoding: 'utf8', mode: 0o600 }));
  return writeChain;
}

function collectBody(request, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    request.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > limit) request.destroy(new Error('fixture request too large'));
      else chunks.push(chunk);
    });
    request.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.once('error', reject);
  });
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    connection: 'keep-alive',
  });
  response.end(body);
}

function sendSse(response, events) {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  for (const event of events) {
    response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }
  response.end();
}

function completed(responseId, usage = { input_tokens: 10, output_tokens: 5, total_tokens: 15 }) {
  return {
    type: 'response.completed',
    response: {
      id: responseId,
      usage: {
        ...usage,
        input_tokens_details: null,
        output_tokens_details: null,
      },
    },
  };
}

function codexEvents(body) {
  const responseId = `resp_cli_${Date.now()}`;
  const hasToolResult = Array.isArray(body.input) && body.input.some((item) =>
    item?.type === 'function_call_output' && item?.call_id === 'call_codex_fixture');
  if (!hasToolResult) {
    return [
      { type: 'response.created', response: { id: responseId } },
      {
        type: 'response.output_item.done',
        item: {
          type: 'function_call',
          call_id: 'call_codex_fixture',
          name: 'exec_command',
          arguments: JSON.stringify({ cmd: `printf '%s\\n' '${CODEX_TOOL}'` }),
        },
      },
      completed(responseId),
    ];
  }
  return [
    { type: 'response.created', response: { id: responseId } },
    {
      type: 'response.output_item.done',
      item: {
        type: 'message',
        role: 'assistant',
        id: 'msg_codex_fixture',
        content: [{
          type: 'output_text',
          text: `Codex fixture complete; ${CODEX_PROMPT}; ${CODEX_TOOL}`,
        }],
      },
    },
    completed(responseId),
  ];
}

function anthropicMessageStart(messageId) {
  return {
    type: 'message_start',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      model: 'fixture-claude-model',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1 },
    },
  };
}

function claudeEvents(body) {
  const messageId = `msg_cli_${Date.now()}`;
  const hasToolResult = Array.isArray(body.messages) && body.messages.some((message) =>
    Array.isArray(message?.content) && message.content.some((block) =>
      block?.type === 'tool_result' && block?.tool_use_id === 'toolu_claude_fixture'));
  if (!hasToolResult) {
    return [
      anthropicMessageStart(messageId),
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_claude_fixture', name: 'Bash', input: {} },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify({ command: `printf '%s\\n' '${CLAUDE_TOOL}'` }),
        },
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ];
  }
  const text = `Claude fixture complete; ${CLAUDE_PROMPT}; ${CLAUDE_TOOL}`;
  return [
    anthropicMessageStart(messageId),
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 12 } },
    { type: 'message_stop' },
  ];
}

function langchainResponse(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const hasToolResult = messages.some((message) =>
    message?.role === 'tool' && message?.tool_call_id === 'call_langchain_fixture');
  if (!hasToolResult) {
    return {
      id: `chatcmpl_fixture_${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1_000),
      model: 'fixture-chat-model',
      choices: [{
        index: 0,
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_langchain_fixture',
            type: 'function',
            function: { name: 'lookup_fixture', arguments: JSON.stringify({ key: 'canary' }) },
          }],
        },
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
  }
  const prompt = [...messages].reverse().find((message) => message?.role === 'user')?.content ?? '';
  return {
    id: `chatcmpl_fixture_${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1_000),
    model: 'fixture-chat-model',
    choices: [{
      index: 0,
      finish_reason: 'stop',
      message: {
        role: 'assistant',
        content: `${String(prompt)}\n\n${LANGCHAIN_TOOL}`,
      },
    }],
    usage: { prompt_tokens: 15, completion_tokens: 10, total_tokens: 25 },
  };
}

await mkdir(resultsDirectory, { recursive: true, mode: 0o700 });
const certificates = await ensureTestCertificates(tlsDirectory);
const [key, cert] = await Promise.all([readFile(certificates.serverKey), readFile(certificates.serverCert)]);
const handler = async (request, response) => {
  try {
    const url = new URL(request.url || '/', 'https://fixture.invalid');
    if (request.method === 'GET' && url.pathname === '/healthz') {
      sendJson(response, 200, { ok: true });
      return;
    }
    if (request.method !== 'POST' || ![
      '/v1/responses',
      '/v1/messages',
      '/v1/chat/completions',
    ].includes(url.pathname)) {
      sendJson(response, 404, { error: { message: 'fixture route not found' } });
      return;
    }
    const authorized = request.headers.authorization === `Bearer ${apiKey}`
      || request.headers['x-api-key'] === apiKey;
    if (!authorized) {
      await record({ event: 'request_rejected', path: url.pathname, authorizationPresent: Boolean(request.headers.authorization || request.headers['x-api-key']) });
      sendJson(response, 401, { error: { message: 'fixture authorization mismatch' } });
      return;
    }
    const rawBody = await collectBody(request);
    const body = JSON.parse(rawBody);
    const product = url.pathname.endsWith('/responses')
      ? 'codex'
      : url.pathname.endsWith('/chat/completions') ? 'langchain' : 'claude';
    const stage = product === 'codex'
      ? (Array.isArray(body.input) && body.input.some((item) => item?.type === 'function_call_output') ? 'final' : 'tool')
      : product === 'langchain'
        ? (Array.isArray(body.messages) && body.messages.some((message) => message?.role === 'tool') ? 'final' : 'tool')
        : (Array.isArray(body.messages) && body.messages.some((message) => Array.isArray(message?.content) && message.content.some((block) => block?.type === 'tool_result')) ? 'final' : 'tool');
    await record({
      event: 'request_received',
      product,
      stage,
      transport: request.socket.encrypted ? 'https' : 'http',
      method: request.method,
      path: url.pathname,
      authorizationPresent: true,
      bodyBytes: Buffer.byteLength(rawBody),
      bodySha256: createHash('sha256').update(rawBody).digest('hex'),
      rawBody,
      body,
    });
    if (product === 'langchain') {
      const chatResponse = langchainResponse(body);
      sendJson(response, 200, chatResponse);
      await record({ event: 'response_completed', product, stage, response: chatResponse });
      return;
    }
    const events = product === 'codex' ? codexEvents(body) : claudeEvents(body);
    sendSse(response, events);
    await record({ event: 'response_completed', product, stage, events });
  } catch (error) {
    await record({ event: 'server_error', message: error instanceof Error ? error.message : String(error) });
    if (!response.headersSent) sendJson(response, 500, { error: { message: 'fixture server error' } });
    else response.destroy();
  }
};

const httpsServer = https.createServer({ key, cert }, handler);
const httpServer = http.createServer(handler);

await Promise.all([
  new Promise((resolve) => httpsServer.listen(port, '127.0.0.1', resolve)),
  new Promise((resolve) => httpServer.listen(httpPort, '127.0.0.1', resolve)),
]);
console.log(JSON.stringify({ event: 'cli_tls_fixture_ready', port, httpPort, transcriptPath }));

async function shutdown(signal) {
  await record({ event: 'server_stopping', signal });
  await Promise.all([
    new Promise((resolve) => httpsServer.close(resolve)),
    new Promise((resolve) => httpServer.close(resolve)),
  ]);
  await writeChain;
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
