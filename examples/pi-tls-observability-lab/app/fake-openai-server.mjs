import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import process from 'node:process';
import { ensureTestCertificates } from './generate-test-certs.mjs';

const FINAL_PROMPT_SENTINEL = 'PI_FINAL_PROMPT_SENTINEL_20260827';
const CANARY_SENTINEL = 'PI_CANARY_RESULT_SENTINEL_20260827';
const TOOL_RESULT_SENTINEL = 'PI_BASH_RESULT_SENTINEL_20260827';
const INTERNAL_RAG_SENTINEL = 'PI_INTERNAL_RAG_MUST_NOT_LEAK_20260827';
const fixtureKey = process.env.FIXTURE_API_KEY || 'fixture-key-not-secret';
const host = process.env.FIXTURE_HTTP_HOST || '127.0.0.1';
const httpPort = Number(process.env.FIXTURE_HTTP_PORT || 18080);
const httpsPort = Number(process.env.FIXTURE_HTTPS_PORT || 18443);
const tlsDirectory = process.env.FIXTURE_TLS_DIR || path.resolve('.runtime/tls');
const transcriptPath = process.env.FIXTURE_TRANSCRIPT_PATH || path.resolve('.runtime/results/fake-llm.ndjson');

let requestSequence = 0;
let writeChain = Promise.resolve();

function timestamp() {
  return {
    at: new Date().toISOString(),
    atUnixNs: (BigInt(Date.now()) * 1_000_000n).toString(),
    atMonotonicNs: process.hrtime.bigint().toString(),
  };
}

function bodyHash(raw) {
  return createHash('sha256').update(raw).digest('hex');
}

function record(event) {
  const line = `${JSON.stringify({ schemaVersion: 'anysentry.pi_fake_llm_event.v1', ...timestamp(), ...event })}\n`;
  writeChain = writeChain.then(() => appendFile(transcriptPath, line, { encoding: 'utf8', mode: 0o600 }));
  return writeChain;
}

function sendJson(response, status, value) {
  const payload = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    connection: 'keep-alive',
  });
  response.end(payload);
}

function collectBody(request, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        request.destroy(new Error('request body exceeds fixture limit'));
        return;
      }
      chunks.push(chunk);
    });
    request.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.once('error', reject);
  });
}

function toolMessages(body) {
  return Array.isArray(body.messages) ? body.messages.filter((message) => message?.role === 'tool') : [];
}

function requestStage(body) {
  const tools = toolMessages(body);
  if (tools.length === 0) return 'read';
  if (tools.length === 1 && tools[0]?.tool_call_id === 'call_read_fixture') return 'bash';
  if (
    tools.length === 2
    && tools[0]?.tool_call_id === 'call_read_fixture'
    && tools[1]?.tool_call_id === 'call_bash_fixture'
  ) return 'final';
  return 'unexpected';
}

function sseChunk(id, delta, finishReason = null, usage) {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'fixture-tool-model',
    choices: delta === undefined ? [] : [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  };
}

function responseChunks(stage, requestId) {
  if (stage === 'read') {
    return [
      sseChunk(requestId, { role: 'assistant' }),
      sseChunk(requestId, {
        tool_calls: [{
          index: 0,
          id: 'call_read_fixture',
          type: 'function',
          function: { name: 'read', arguments: '{"path":"' },
        }],
      }),
      sseChunk(requestId, {
        tool_calls: [{ index: 0, function: { arguments: 'canary.txt"}' } }],
      }),
      sseChunk(requestId, {}, 'tool_calls'),
      sseChunk(requestId, undefined, null, { prompt_tokens: 120, completion_tokens: 12, total_tokens: 132 }),
    ];
  }
  if (stage === 'bash') {
    const command = `printf '%s\\n' '${TOOL_RESULT_SENTINEL}' | tee -a tool-events.log`;
    const argumentsJson = JSON.stringify({ command });
    const split = Math.floor(argumentsJson.length / 2);
    return [
      sseChunk(requestId, { role: 'assistant' }),
      sseChunk(requestId, {
        tool_calls: [{
          index: 0,
          id: 'call_bash_fixture',
          type: 'function',
          function: { name: 'bash', arguments: argumentsJson.slice(0, split) },
        }],
      }),
      sseChunk(requestId, {
        tool_calls: [{ index: 0, function: { arguments: argumentsJson.slice(split) } }],
      }),
      sseChunk(requestId, {}, 'tool_calls'),
      sseChunk(requestId, undefined, null, { prompt_tokens: 180, completion_tokens: 18, total_tokens: 198 }),
    ];
  }
  return [
    sseChunk(requestId, { role: 'assistant' }),
    sseChunk(requestId, { content: 'Fixture complete: read -> ' }),
    sseChunk(requestId, { content: `bash; ${FINAL_PROMPT_SENTINEL}; ${CANARY_SENTINEL}; ${TOOL_RESULT_SENTINEL}` }),
    sseChunk(requestId, {}, 'stop'),
    sseChunk(requestId, undefined, null, { prompt_tokens: 240, completion_tokens: 24, total_tokens: 264 }),
  ];
}

async function streamResponse(response, stage, sequence, transport) {
  const requestId = `chatcmpl-fixture-${sequence}`;
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-request-id': requestId,
  });
  await record({ event: 'response_started', sequence, stage, transport, requestId });
  for (const [chunkIndex, chunk] of responseChunks(stage, requestId).entries()) {
    response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    await record({ event: 'response_chunk_sent', sequence, stage, transport, requestId, chunkIndex, chunk });
    await new Promise((resolve) => setTimeout(resolve, 8));
  }
  response.write('data: [DONE]\n\n');
  response.end();
  await record({ event: 'response_completed', sequence, stage, transport, requestId });
}

function createHandler(transport) {
  return async (request, response) => {
    try {
      const url = new URL(request.url || '/', `${transport}://fixture.invalid`);
      if (request.method === 'GET' && url.pathname === '/healthz') {
        sendJson(response, 200, { ok: true, transport });
        return;
      }
      if (request.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
        sendJson(response, 404, { error: { message: 'fixture route not found' } });
        return;
      }
      if (request.headers.authorization !== `Bearer ${fixtureKey}`) {
        await record({ event: 'request_rejected', transport, reason: 'authorization_mismatch' });
        sendJson(response, 401, { error: { message: 'fixture authorization mismatch' } });
        return;
      }

      const rawBody = await collectBody(request);
      let body;
      try {
        body = JSON.parse(rawBody);
      } catch {
        sendJson(response, 400, { error: { message: 'invalid JSON' } });
        return;
      }
      const sequence = ++requestSequence;
      const stage = requestStage(body);
      await record({
        event: 'request_received',
        sequence,
        stage,
        transport,
        method: request.method,
        path: url.pathname,
        authorizationPresent: true,
        bodyBytes: Buffer.byteLength(rawBody),
        bodySha256: bodyHash(rawBody),
        rawBody,
        body,
      });
      if (rawBody.includes(INTERNAL_RAG_SENTINEL)) {
        await record({ event: 'fixture_violation', sequence, stage, transport, reason: 'internal_rag_leaked' });
        sendJson(response, 422, { error: { message: 'internal RAG sentinel leaked into final request' } });
        return;
      }
      if (stage === 'read' && !rawBody.includes(FINAL_PROMPT_SENTINEL)) {
        sendJson(response, 422, { error: { message: 'final prompt sentinel missing' } });
        return;
      }
      if (stage === 'bash' && !rawBody.includes(CANARY_SENTINEL)) {
        sendJson(response, 422, { error: { message: 'read tool result missing from follow-up request' } });
        return;
      }
      if (stage === 'final' && !rawBody.includes(TOOL_RESULT_SENTINEL)) {
        sendJson(response, 422, { error: { message: 'bash tool result missing from follow-up request' } });
        return;
      }
      if (stage === 'unexpected') {
        sendJson(response, 409, { error: { message: 'unexpected tool sequence' } });
        return;
      }
      await streamResponse(response, stage, sequence, transport);
    } catch (error) {
      await record({ event: 'server_error', transport, message: error instanceof Error ? error.message : String(error) });
      if (!response.headersSent) sendJson(response, 500, { error: { message: 'fixture server error' } });
      else response.destroy();
    }
  };
}

await mkdir(path.dirname(transcriptPath), { recursive: true, mode: 0o700 });
const certificates = await ensureTestCertificates(tlsDirectory);
const [key, cert] = await Promise.all([
  readFile(certificates.serverKey),
  readFile(certificates.serverCert),
]);

const httpServer = http.createServer(createHandler('http'));
const httpsServer = https.createServer({ key, cert }, createHandler('https'));

await Promise.all([
  new Promise((resolve) => httpServer.listen(httpPort, host, resolve)),
  new Promise((resolve) => httpsServer.listen(httpsPort, host, resolve)),
]);
await record({ event: 'server_ready', host, httpPort, httpsPort });
console.log(JSON.stringify({ event: 'fake_llm_ready', host, httpPort, httpsPort, transcriptPath }));

async function shutdown(signal) {
  await record({ event: 'server_stopping', signal });
  await Promise.all([
    new Promise((resolve) => httpServer.close(resolve)),
    new Promise((resolve) => httpsServer.close(resolve)),
  ]);
  await writeChain;
  process.exit(0);
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
