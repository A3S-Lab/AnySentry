#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import process from 'node:process';
import { ensureTestCertificates } from '../../pi-tls-observability-lab/app/generate-test-certs.mjs';

const port = boundedPort(process.env.CLI_LAB_PROXY_HTTPS_PORT, 19444);
const bindHost = process.env.CLI_LAB_PROXY_BIND_HOST || '127.0.0.1';
const tlsDirectory = process.env.CLI_LAB_TLS_DIR || path.resolve('.runtime/tls');
const resultsDirectory = process.env.CLI_LAB_RESULTS_DIR || path.resolve('.runtime/results');
const metadataPath = process.env.CLI_LAB_PROXY_METADATA_PATH
  || path.join(resultsDirectory, 'tls-front-metadata.ndjson');
const upstreamBase = requiredUrl('CLI_LAB_UPSTREAM_BASE_URL');
const forwardProxy = optionalUrl('CLI_LAB_UPSTREAM_PROXY_URL');
const maxRequestBytes = boundedBytes(process.env.CLI_LAB_PROXY_MAX_REQUEST_BYTES, 32 * 1024 * 1024);
const maxSseLineBytes = boundedBytes(process.env.CLI_LAB_PROXY_MAX_SSE_LINE_BYTES, 64 * 1024);
const hopByHopHeaders = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
let writeChain = Promise.resolve();

function boundedPort(raw, fallback) {
  const value = Number(raw || fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error('CLI_LAB_PROXY_HTTPS_PORT must be a valid TCP port');
  }
  return value;
}

function boundedBytes(raw, fallback) {
  const value = Number(raw || fallback);
  return Number.isSafeInteger(value) && value >= 1_024 ? value : fallback;
}

function requiredUrl(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`${name} must use http or https`);
  }
  parsed.username = '';
  parsed.password = '';
  parsed.hash = '';
  return parsed;
}

function optionalUrl(name) {
  const value = process.env[name]?.trim();
  if (!value) return undefined;
  const parsed = new URL(value);
  if (parsed.protocol !== 'http:') {
    throw new Error(`${name} currently supports only an HTTP forward proxy`);
  }
  parsed.hash = '';
  return parsed;
}

function sanitizedHeaders(headers, host) {
  const output = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!hopByHopHeaders.has(name.toLowerCase()) && value !== undefined) output[name] = value;
  }
  output.host = host;
  return output;
}

function upstreamUrl(incoming) {
  const target = new URL(upstreamBase.toString());
  const basePath = target.pathname.replace(/\/$/u, '');
  const incomingPath = incoming.pathname.startsWith('/') ? incoming.pathname : `/${incoming.pathname}`;
  target.pathname = basePath.endsWith('/v1') && incomingPath.startsWith('/v1/')
    ? `${basePath}${incomingPath.slice(3)}`
    : `${basePath}${incomingPath}`;
  target.search = incoming.search;
  return target;
}

function upstreamRequestOptions(target, request) {
  if (forwardProxy) {
    if (target.protocol !== 'http:') {
      throw new Error('HTTPS upstream over CONNECT is intentionally not implemented');
    }
    return {
      transport: http,
      options: {
        protocol: 'http:',
        hostname: forwardProxy.hostname,
        port: forwardProxy.port || 80,
        method: request.method,
        path: target.toString(),
        headers: sanitizedHeaders(request.headers, target.host),
      },
    };
  }
  return {
    transport: target.protocol === 'https:' ? https : http,
    options: {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      method: request.method,
      path: `${target.pathname}${target.search}`,
      headers: sanitizedHeaders(request.headers, target.host),
      servername: target.hostname,
    },
  };
}

function responseHeaders(headers) {
  const output = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!hopByHopHeaders.has(name.toLowerCase()) && value !== undefined) output[name] = value;
  }
  return output;
}

function recordMetadata(value) {
  const line = `${JSON.stringify({
    schemaVersion: 'anysentry.cli_tls_front_metadata.v1',
    atUnixNs: (BigInt(Date.now()) * 1_000_000n).toString(),
    ...value,
  })}\n`;
  writeChain = writeChain.then(() => appendFile(metadataPath, line, {
    encoding: 'utf8',
    mode: 0o600,
  }));
  return writeChain;
}

function sseObserver(limit) {
  let pending = '';
  const eventTypes = [];
  const seen = new Set();
  let terminalSeen = false;
  let truncatedLineCount = 0;

  const observeType = (value) => {
    const type = value?.trim();
    if (!type || type.length > 160) return;
    if (!seen.has(type) && eventTypes.length < 256) {
      seen.add(type);
      eventTypes.push(type);
    }
    if (['response.completed', 'response.failed', 'response.incomplete', 'message_stop'].includes(type)) {
      terminalSeen = true;
    }
  };

  return {
    push(chunk) {
      pending += chunk.toString('utf8');
      for (;;) {
        const newline = pending.indexOf('\n');
        if (newline < 0) break;
        const line = pending.slice(0, newline).replace(/\r$/u, '');
        pending = pending.slice(newline + 1);
        if (line.length > limit) {
          truncatedLineCount += 1;
          continue;
        }
        if (line.startsWith('event:')) {
          observeType(line.slice(6));
          continue;
        }
        if (!line.startsWith('data:')) continue;
        const type = line.slice(5).match(/"type"\s*:\s*"([^"\\]{1,160})"/u)?.[1];
        if (type) observeType(type);
      }
      if (pending.length > limit) {
        pending = '';
        truncatedLineCount += 1;
      }
    },
    result() {
      return { eventTypes, terminalSeen, truncatedLineCount };
    },
  };
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

await mkdir(resultsDirectory, { recursive: true, mode: 0o700 });
const certificates = await ensureTestCertificates(tlsDirectory);
const [key, cert] = await Promise.all([
  readFile(certificates.serverKey),
  readFile(certificates.serverCert),
]);

const server = https.createServer({
  key,
  cert,
  minVersion: 'TLSv1.2',
  ALPNProtocols: ['http/1.1'],
}, (request, response) => {
  const incoming = new URL(request.url || '/', 'https://tls-front.invalid');
  if (request.method === 'GET' && incoming.pathname === '/healthz') {
    sendJson(response, 200, { ok: true, protocol: 'http/1.1' });
    return;
  }

  const requestId = randomUUID();
  const startedAt = process.hrtime.bigint();
  const requestHash = createHash('sha256');
  const responseHash = createHash('sha256');
  let requestBytes = 0;
  let responseBytes = 0;
  let firstResponseAt;
  let target;
  let upstream;
  try {
    target = upstreamUrl(incoming);
    upstream = upstreamRequestOptions(target, request);
  } catch {
    sendJson(response, 502, { error: { message: 'TLS front routing failed' } });
    return;
  }

  const sse = sseObserver(maxSseLineBytes);
  const upstreamRequest = upstream.transport.request(upstream.options, (upstreamResponse) => {
    firstResponseAt = process.hrtime.bigint();
    response.writeHead(upstreamResponse.statusCode || 502, responseHeaders(upstreamResponse.headers));
    upstreamResponse.on('data', (chunk) => {
      responseBytes += chunk.length;
      responseHash.update(chunk);
      sse.push(chunk);
      if (!response.write(chunk)) upstreamResponse.pause();
    });
    response.on('drain', () => upstreamResponse.resume());
    upstreamResponse.once('end', () => {
      response.end();
      const endedAt = process.hrtime.bigint();
      const sseResult = sse.result();
      void recordMetadata({
        event: 'exchange_completed',
        requestId,
        method: request.method,
        path: incoming.pathname,
        incomingProtocol: 'https/http1',
        upstreamProtocol: target.protocol.replace(':', ''),
        forwardProxyUsed: Boolean(forwardProxy),
        statusCode: upstreamResponse.statusCode || 0,
        contentType: String(upstreamResponse.headers['content-type'] || ''),
        requestBytes,
        requestSha256: requestHash.digest('hex'),
        responseBytes,
        responseSha256: responseHash.digest('hex'),
        firstResponseNs: firstResponseAt ? (firstResponseAt - startedAt).toString() : undefined,
        durationNs: (endedAt - startedAt).toString(),
        ...sseResult,
      });
    });
    upstreamResponse.once('error', () => response.destroy());
  });

  upstreamRequest.once('error', () => {
    if (!response.headersSent) sendJson(response, 502, { error: { message: 'TLS front upstream failed' } });
    else response.destroy();
    void recordMetadata({
      event: 'exchange_failed',
      requestId,
      method: request.method,
      path: incoming.pathname,
      requestBytes,
      responseBytes,
      durationNs: (process.hrtime.bigint() - startedAt).toString(),
    });
  });
  request.on('data', (chunk) => {
    requestBytes += chunk.length;
    if (requestBytes > maxRequestBytes) {
      upstreamRequest.destroy(new Error('request exceeds TLS front limit'));
      request.destroy();
      return;
    }
    requestHash.update(chunk);
    if (!upstreamRequest.write(chunk)) request.pause();
  });
  upstreamRequest.on('drain', () => request.resume());
  request.once('end', () => upstreamRequest.end());
  request.once('error', () => upstreamRequest.destroy());
});

server.listen(port, bindHost, () => {
  console.log(JSON.stringify({
    event: 'cli_tls_front_ready',
    bindHost,
    port,
    protocol: 'https/http1',
    metadataPath,
    forwardProxyUsed: Boolean(forwardProxy),
  }));
});

async function shutdown(signal) {
  await new Promise((resolve) => server.close(resolve));
  await recordMetadata({ event: 'front_stopped', signal });
  await writeChain;
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
