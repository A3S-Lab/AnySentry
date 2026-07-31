#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createServer } from 'node:http';

const baseUrl = (process.env.ANYSENTRY_API_BASE
  ?? 'http://127.0.0.1:29653/security-center').replace(/\/$/u, '');
const adminToken = process.env.ANYSENTRY_ADMIN_TOKEN?.trim();
const host = process.env.ANYSENTRY_IDENTITY_REVIEW_MOCK_HOST ?? '0.0.0.0';
const port = Number(process.env.ANYSENTRY_IDENTITY_REVIEW_MOCK_PORT ?? 18051);
const agentAssetId = process.env.ANYSENTRY_IDENTITY_REVIEW_ASSET_ID;
if (!agentAssetId) throw new Error('ANYSENTRY_IDENTITY_REVIEW_ASSET_ID is required');

const terminalDecision = JSON.stringify({
  verdict: 'agent',
  confidence: 0.88,
  summary: 'Candidate with a tool-execution identity sequence',
  reason: 'The bounded runtime snapshot associates repeated tool events with one candidate asset; this integration fixture validates the advisory path, not model quality.',
  evidenceRefs: ['target.json', 'events.json', 'processes.json'],
});

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ object: 'list', data: [{ id: 'glm-5.2', object: 'model' }] }));
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.statusCode = 404;
      response.end('not found');
      return;
    }
    const body = await readJson(request);
    assert.equal(body.model, 'glm-5.2');
    if (body.stream === true) {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      response.write(`data: ${JSON.stringify({
        id: 'identity-review-runtime',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [{ index: 0, delta: { role: 'assistant', content: terminalDecision }, finish_reason: null }],
      })}\n\n`);
      response.write(`data: ${JSON.stringify({
        id: 'identity-review-runtime',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      })}\n\n`);
      response.end('data: [DONE]\n\n');
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      id: 'identity-review-runtime',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: terminalDecision }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 32, completion_tokens: 40, total_tokens: 72 },
    }));
  } catch (error) {
    response.statusCode = 500;
    response.end(error instanceof Error ? error.message : String(error));
  }
});

async function request(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(adminToken ? { authorization: `Bearer ${adminToken}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : undefined;
  if (!response.ok) throw new Error(`${method} ${path} returned ${response.status}: ${text}`);
  return payload?.data ?? payload;
}

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, host, resolve);
});

try {
  const review = await request('/identity/ai-review', {
    method: 'POST',
    body: { targetType: 'agent', agentAssetId, timeType: 'last_3h' },
  });
  assert.equal(review.status, 'succeeded', JSON.stringify(review));
  assert.equal(review.provider, 'a3s-code-sdk');
  assert.equal(review.model, 'glm-5.2');
  assert.equal(review.verdict, 'agent');
  assert.equal(review.confidence, 0.88);
  assert.deepEqual(review.evidenceRefs, ['target.json', 'events.json', 'processes.json']);
  assert.ok(review.evidenceDigest);

  const history = await request(`/identity/ai-reviews?targetType=agent&agentAssetId=${encodeURIComponent(agentAssetId)}`);
  assert.equal(history.items?.[0]?.reviewId, review.reviewId, JSON.stringify(history));
  assert.equal(history.items?.[0]?.status, 'succeeded');

  console.log(JSON.stringify({
    reviewId: review.reviewId,
    agentAssetId,
    verdict: review.verdict,
    confidence: review.confidence,
    provider: review.provider,
    evidenceDigest: review.evidenceDigest,
  }, null, 2));
  console.log('Identity AI review runtime verification passed');
} finally {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
