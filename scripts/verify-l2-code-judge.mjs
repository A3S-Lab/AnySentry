#!/usr/bin/env node

import assert from 'node:assert/strict';
import { L2CodeJudge, isL2CodeJudgeTimeout } from '../apps/api/dist/security-monitoring/l2-code-judge.js';
import { buildA3sCodeModelAcl, sharedModelConfig } from '../apps/api/dist/security-monitoring/a3s-code-model-config.js';

const state = { agents: 0, closes: 0, sessions: 0, sessionCloses: 0, calls: [], options: [] };
const judge = new L2CodeJudge({
  url: 'https://provider.example',
  model: 'model-x',
  key: 'test-key',
  timeoutMs: 1_000,
  agentFactory: async () => {
    state.agents += 1;
    return {
      sessionAsync: async (_workspace, options) => {
        state.sessions += 1;
        state.options.push(options);
        return {
          tool: async (name, args) => {
            state.calls.push({ name, args });
            return {
              exitCode: 0,
              output: JSON.stringify({ object: { verdict: 'block', severity: 'high', reason: 'credential theft' } }),
            };
          },
          closeAsync: async () => { state.sessionCloses += 1; },
        };
      },
      close: async () => { state.closes += 1; },
    };
  },
});

const decision = await judge.judge({
  observerLine: '{"event":{"ToolExec":{"argv":["cat","/etc/shadow"]}}}',
  eventKind: 'ToolExec',
  subject: 'cat /etc/shadow',
  actor: 'test-agent',
});
assert.deepEqual(decision, {
  verdict: 'block',
  severity: 'high',
  reason: 'L2: credential theft',
  tier: 'Llm',
});
assert.equal(state.agents, 1, 'one model configuration must reuse one A3S Code Agent');
assert.equal(state.sessions, 1, 'each stateless L2 request must use an isolated Session');
assert.equal(state.sessionCloses, 1, 'the isolated Session must close after the request');
assert.equal(state.calls[0].name, 'generate_object', 'L2 must use A3S Code structured generation');
assert.equal(state.calls[0].args.max_repair_attempts, 0, 'L2 must remain a single model request');
assert.equal(state.options[0].planningMode, 'disabled');
assert.equal(state.options[0].permissionPolicy.defaultDecision, 'deny');
assert.equal(state.options[0].continuationEnabled, false);
await judge.close();
assert.equal(state.closes, 1);

const timeoutJudge = new L2CodeJudge({
  url: 'https://provider.example',
  model: 'model-x',
  key: 'test-key',
  timeoutMs: 20,
  agentFactory: async () => ({
    sessionAsync: async () => ({
      tool: async () => new Promise(() => undefined),
      closeAsync: async () => undefined,
    }),
    close: async () => undefined,
  }),
});
await assert.rejects(
  () => timeoutJudge.judge({ observerLine: '{}', eventKind: 'ToolExec', subject: 'hang' }),
  isL2CodeJudgeTimeout,
);
await timeoutJudge.close();

const acl = buildA3sCodeModelAcl({
  id: 'verify',
  name: 'Verify',
  url: 'https://api.deepseek.com',
  model: 'deepseek-v4-flash',
  key: 'redacted',
});
assert.match(acl, /baseUrl = "https:\/\/api\.deepseek\.com"/);
assert.match(acl, /default_model = "openai\/deepseek-v4-flash"/);
assert.deepEqual(
  sharedModelConfig({
    A3S_SENTRY_LLM_URL: 'https://shared.example',
    A3S_SENTRY_LLM_MODEL: 'shared-model',
    A3S_SENTRY_LLM_KEY: 'shared-key',
    A3S_SENTRY_L3_URL: 'https://legacy.example',
  }),
  { url: 'https://shared.example', model: 'shared-model', key: 'shared-key' },
  'the shared model configuration must take precedence over legacy L3 overrides',
);

console.log('L2 A3S Code judge verification passed');
