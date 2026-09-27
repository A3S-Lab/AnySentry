#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const results = process.env.CLI_LAB_RESULTS_DIR || path.resolve('.runtime/results');
const lines = (await readFile(path.join(results, 'cli-provider.ndjson'), 'utf8'))
  .trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
const requests = lines.filter((item) => item.event === 'request_received');
const expectedProducts = process.argv.slice(2).length ? process.argv.slice(2) : ['codex', 'claude'];
for (const product of expectedProducts) {
  const productRequests = requests.filter((item) => item.product === product);
  assert.equal(productRequests.length, 2, `${product} request count`);
  assert.deepEqual(productRequests.map((item) => item.stage), ['tool', 'final']);
  const expectedTransport = product === 'codex' && process.env.CLI_LAB_CODEX_PROTOCOL !== 'https'
    ? 'http'
    : 'https';
  assert.ok(productRequests.every((item) => item.transport === expectedTransport));
  assert.ok(productRequests.every((item) => item.authorizationPresent === true));
  assert.ok(productRequests.every((item) => !Object.hasOwn(item, 'headers')));
  assert.ok(productRequests.every((item) => !item.rawBody.includes('fixture-key-not-secret')));
}
if (expectedProducts.includes('codex')) {
  assert.ok(requests.find((item) => item.product === 'codex' && item.stage === 'final')
    .rawBody.includes('CODEX_TOOL_RESULT_SENTINEL_20260827'));
}
if (expectedProducts.includes('claude')) {
  assert.ok(requests.find((item) => item.product === 'claude' && item.stage === 'final')
    .rawBody.includes('CLAUDE_TOOL_RESULT_SENTINEL_20260827'));
}
console.log(JSON.stringify({
  event: 'cli_tls_lab_verification',
  passed: true,
  codexRequests: expectedProducts.includes('codex') ? 2 : 0,
  claudeRequests: expectedProducts.includes('claude') ? 2 : 0,
  toolResultsReturnedToModel: true,
}));
