#!/usr/bin/env node
'use strict';

const http = require('node:http');
const https = require('node:https');

const listenPort = Math.max(1, Number(process.env.LEGACY_INGEST_PROXY_PORT || 29654));
const target = new URL(
  process.env.ANYSENTRY_LEGACY_INGEST_URL
    || process.env.ANYSENTRY_INGEST_URL
    || 'http://host.docker.internal:29653/security-center/ingest',
);
const maxBodyBytes = Math.max(1024, Number(process.env.LEGACY_INGEST_MAX_BODY_BYTES || 8 * 1024 * 1024));
const concurrency = Math.max(1, Math.min(32, Number(process.env.LEGACY_INGEST_CONCURRENCY || 8)));
const allowedAgentIds = new Set(
  String(process.env.ANYSENTRY_LEGACY_AGENT_IDS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);

function prepareEvent(event) {
  const attribution = event?.attribution && typeof event.attribution === 'object'
    ? event.attribution
    : {};
  const agentId = typeof attribution.agentScopeId === 'string'
    ? attribution.agentScopeId.trim()
    : '';
  if (allowedAgentIds.size > 0 && !allowedAgentIds.has(agentId)) return undefined;
  if (!agentId) return event;

  const workloadName = attribution.workloadRef?.containerName
    || attribution.workloadRef?.name
    || agentId;
  return {
    ...event,
    agentId,
    workspacePath: `docker/${workloadName}`,
  };
}

function postEvent(event) {
  return new Promise((resolve) => {
    const body = JSON.stringify(event);
    const transport = target.protocol === 'https:' ? https : http;
    const request = transport.request({
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
      timeout: 10_000,
    }, (response) => {
      response.resume();
      response.once('end', () => resolve((response.statusCode || 500) < 400));
    });
    request.once('timeout', () => request.destroy(new Error('legacy ingest timeout')));
    request.once('error', () => resolve(false));
    request.end(body);
  });
}

async function postInWorkers(events) {
  let cursor = 0;
  let accepted = 0;
  let skipped = 0;
  async function worker() {
    while (cursor < events.length) {
      const index = cursor;
      cursor += 1;
      const event = prepareEvent(events[index]);
      if (!event) {
        skipped += 1;
      } else if (await postEvent(event)) {
        accepted += 1;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, events.length) }, () => worker()));
  return { accepted, skipped };
}

const server = http.createServer((request, response) => {
  if (request.method !== 'POST') {
    response.writeHead(405).end();
    return;
  }

  let size = 0;
  let raw = '';
  request.setEncoding('utf8');
  request.on('data', (chunk) => {
    size += Buffer.byteLength(chunk);
    if (size > maxBodyBytes) {
      request.destroy();
      return;
    }
    raw += chunk;
  });
  request.on('end', async () => {
    let events;
    try {
      const parsed = JSON.parse(raw);
      events = Array.isArray(parsed.events) ? parsed.events : [];
    } catch {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ accepted: false, reason: 'invalid JSON' }));
      return;
    }

    const { accepted: acceptedEvents, skipped: skippedEvents } = await postInWorkers(events);
    const rejectedEvents = events.length - acceptedEvents - skippedEvents;
    response.writeHead(rejectedEvents === 0 ? 200 : 502, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      accepted: acceptedEvents > 0,
      acceptedEvents,
      skippedEvents,
      rejectedEvents,
      mode: 'legacy-single-ingest-adapter',
    }));
  });
});

server.listen(listenPort, '127.0.0.1', () => {
  process.stderr.write(
    `[legacy-ingest-proxy] listening=127.0.0.1:${listenPort}; target=${target.toString()}; concurrency=${concurrency}\n`,
  );
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2_000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
