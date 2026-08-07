#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testDeepInvestigationConnection, testFastReviewConnection } from '../apps/api/dist/security-monitoring/judgment-connectivity.js';
import { sanitizeRuntimeModelConnection } from '../apps/api/dist/security-monitoring/runtime-model-config.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const fast = sanitizeRuntimeModelConnection({
  url: 'https://user:password@provider.example/v1/chat/completions?secret=query',
  model: 'model-fast',
  apiKey: 'verify-fast-secret',
  timeoutS: 20,
  contextTokens: 16_384,
}, 'fast_review');
assert.equal(fast.url, 'https://provider.example/v1');
assert.equal(fast.apiKey, 'verify-fast-secret');

let l2Closed = 0;
let l2Options;
const fastResult = await testFastReviewConnection(fast, (options) => {
  l2Options = options;
  return {
    judge: async () => ({ verdict: 'allow', severity: 'info', reason: 'ok', tier: 'Llm' }),
    close: async () => { l2Closed += 1; },
  };
});
assert.equal(fastResult.ok, true);
assert.equal(fastResult.profile, 'fast_review');
assert.equal(l2Options.key, 'verify-fast-secret');
assert.equal(l2Closed, 1);
assert.equal(JSON.stringify(fastResult).includes('verify-fast-secret'), false);

const unauthorized = await testFastReviewConnection(fast, () => ({
  judge: async () => { throw new Error('HTTP 401 unauthorized'); },
  close: async () => undefined,
}));
assert.equal(unauthorized.status, 'unauthorized');

const deep = sanitizeRuntimeModelConnection({
  url: 'https://deep.example/v1', model: 'model-deep', apiKey: 'verify-deep-secret', timeoutS: 30, contextTokens: 32_768,
}, 'deep_investigation');
let deepOptions;
let deepSkills;
let deepClosed = 0;
const deepResult = await testDeepInvestigationConnection(deep, '/skills', (options) => {
  deepOptions = options;
  return {
    initialize: async () => undefined,
    run: async (skills, _prompt, validate) => {
      deepSkills = skills;
      const text = '{"verdict":"allow","severity":"low","reason":"connectivity ok"}';
      validate?.(text);
      return { text, poolWaitMs: 0, agentRunMs: 1 };
    },
    close: async () => { deepClosed += 1; },
  };
});
assert.equal(deepResult.ok, true);
assert.equal(deepResult.profile, 'deep_investigation');
assert.equal(deepOptions.modelConfig.key, 'verify-deep-secret');
assert.equal(deepSkills, '/skills');
assert.equal(deepClosed, 1);
assert.equal(JSON.stringify(deepResult).includes('verify-deep-secret'), false);

const controller = fs.readFileSync(path.join(root, 'apps/api/src/security-monitoring/security-monitoring.controller.ts'), 'utf8');
const runtime = fs.readFileSync(path.join(root, 'apps/api/src/security-monitoring/runtime-model-config.ts'), 'utf8');
const worker = fs.readFileSync(path.join(root, 'apps/api/src/security-monitoring/worker-main.ts'), 'utf8');
const identity = fs.readFileSync(path.join(root, 'apps/api/src/security-monitoring/identity-review-agent.service.ts'), 'utf8');
const page = fs.readFileSync(path.join(root, 'apps/web/src/pages/PolicyConfigPage.tsx'), 'utf8');
assert.match(controller, /model-connections\/test/u);
assert.match(controller, /rememberSuccessfulTest/u);
assert.match(controller, /consumeSuccessfulTest/u);
assert.match(runtime, /publisher\.publish\(RUNTIME_MODEL_UPDATE_CHANNEL/u);
assert.doesNotMatch(runtime, /\.set\([^\n]*apiKey/u, 'credentials must not be written into Redis keys');
assert.match(worker, /RuntimeModelClient/u);
assert.match(identity, /get\('fast_review'\)/u);
assert.doesNotMatch(identity, /A3S_SENTRY_L3_KEY/u);
assert.match(page, /快速研判模型/u);
assert.match(page, /深度研判模型/u);
assert.match(page, /type="password"/u);
assert.match(page, /state=\{connectivity\.fast_review \?\? EMPTY_CONNECTIVITY\.fast_review\}/u);
assert.match(page, /state=\{connectivity\.deep_investigation \?\? EMPTY_CONNECTIVITY\.deep_investigation\}/u);
assert.doesNotMatch(page, /connectivity=\{connectivity\./u, 'connection controls must receive the state prop they render');
assert.doesNotMatch(page, /localStorage[^\n]*apiKey/iu);

console.log('Runtime model connection verification passed');
