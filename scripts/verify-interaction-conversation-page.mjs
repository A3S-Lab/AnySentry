#!/usr/bin/env node

import assert from 'node:assert/strict';
import { InteractionService } from '../apps/api/dist/security-monitoring/interaction.service.js';

const at = Date.now();
const payloads = new Map();
for (const [id, sessionId, offset] of [
  ['mi_new1', 'sess_new', 400],
  ['mi_new2', 'sess_new', 300],
  ['mi_old1', 'sess_old', 200],
  ['mi_old2', 'sess_old', 100],
]) {
  payloads.set(id, JSON.stringify({
    interactionId: id,
    at: at - offset,
    path: '/v1/chat/completions',
    method: 'POST',
    endpoint: 'guard/v1',
    collectorId: 'collector',
    agentInstanceId: 'agent',
    sessionId,
    model: 'qwen',
    statusCode: 200,
    request: { body: JSON.stringify({ messages: [{ role: 'user', content: `question-${id}` }] }) },
    response: {
      body: JSON.stringify({
        object: 'chat.completion',
        choices: [{ message: { content: `answer-${id}` } }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      }),
    },
  }));
}
const indexRows = [...payloads.keys()].map((interactionId, index) => ({
  interactionId,
  sessionId: index < 2 ? 'sess_new' : 'sess_old',
  agentInstanceId: 'agent',
  at: at - index * 100,
}));
const fetched = [];
const indexQueries = [];
let pointReads = 0;
const clickhouse = {
  enabled: true,
  queryAgentInteractionIndex: async (query) => {
    indexQueries.push({ ...query });
    return indexRows.filter((row) => !query.sessionId || row.sessionId === query.sessionId);
  },
  queryAgentInteractionPayloadsByIds: async (ids) => {
    fetched.push([...ids]);
    return new Map(ids.map((id) => [id, payloads.get(id)]));
  },
  queryAgentInteractionPayloads: async () => {
    pointReads += 1;
    return [];
  },
  loadInteractionMetadata: async () => [],
};
const relational = {
  isReady: () => false,
  loadInteractionMetadata: async () => null,
};
const contents = {
  availableInteractionIds: async () => new Set(),
  directViewEnabled: () => true,
};
const service = new InteractionService(relational, clickhouse, contents);

const first = await service.conversations({ limit: 1 });
assert.equal(first.items.length, 1);
assert.equal(first.total, 2);
assert.equal(first.items[0].conversationId, 'uosconv:sess_new');
assert.equal(first.items[0].title, 'question-mi_new1');
assert.deepEqual(fetched.flat().sort(), ['mi_new1', 'mi_new2']);

const second = await service.conversations({ limit: 2 });
assert.equal(second.items.length, 2);
assert.equal(second.total, 2);
assert.deepEqual(fetched.flat().sort(), ['mi_new1', 'mi_new2', 'mi_old1', 'mi_old2']);

const beforeDetail = fetched.length;
const detail = await service.conversation('uosconv:sess_new');
assert.equal(detail.observations.length, 4, JSON.stringify({
  conversationIds: detail.observations.map((item) => item.conversationId),
  indexQueries,
}));
assert.ok(detail.observations.every((item) => item.contentAvailability === 'available'));
assert.equal(fetched.length, beforeDetail + 1, 'detail must batch all inline plaintext reads');
assert.deepEqual(fetched.at(-1).sort(), ['mi_new1', 'mi_new2'], JSON.stringify(fetched));
assert.equal(pointReads, 0, 'detail must not fan out into one ClickHouse query per observation');

console.log('Interaction conversation page verification passed');
