#!/usr/bin/env node

import assert from 'node:assert/strict';
import { buildL3AgentAcl, L3AgentPool, isL3AgentTimeout } from '../apps/api/dist/security-monitoring/l3-agent-pool.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeSession {
  activeReject;

  constructor(state, options) {
    this.state = state;
    this.options = options;
  }

  async send(request) {
    this.state.requests.push(request);
    this.state.active += 1;
    this.state.maxActive = Math.max(this.state.maxActive, this.state.active);
    try {
      if (request.prompt === 'hang') {
        return await new Promise((_, reject) => {
          this.activeReject = reject;
        });
      }
      await delay(request.prompt === 'slow-invalid-json' ? 70 : 30);
      return { text: request.prompt };
    } finally {
      this.activeReject = undefined;
      this.state.active -= 1;
    }
  }

  async cancelAsync() {
    this.state.cancels += 1;
    this.activeReject?.(new Error('cancelled'));
    return Boolean(this.activeReject);
  }

  async closeAsync() {
    this.state.sessionCloses += 1;
  }
}

function fakeHarness() {
  const state = {
    agents: 0,
    agentCloses: 0,
    sessions: 0,
    sessionCloses: 0,
    cancels: 0,
    active: 0,
    maxActive: 0,
    requests: [],
    sessionOptions: [],
  };
  const agentFactory = async () => {
    state.agents += 1;
    return {
      sessionAsync: async (_workspace, options) => {
        state.sessions += 1;
        state.sessionOptions.push(options);
        return new FakeSession(state, options);
      },
      close: async () => {
        state.agentCloses += 1;
      },
    };
  };
  return { state, agentFactory };
}

async function verifyConcurrencyAndIsolation() {
  const { state, agentFactory } = fakeHarness();
  const pool = new L3AgentPool({ size: 4, timeoutMs: 1_000, agentFactory });
  await pool.initialize();
  await pool.prewarm('/skills/l3');
  const results = await Promise.all(['a', 'b', 'c', 'd', 'e'].map((prompt) => pool.run('/skills/l3', prompt)));

  assert.equal(state.agents, 1, 'one worker must create exactly one Agent');
  assert.equal(state.sessions, 4, 'pool must prewarm exactly four Sessions');
  assert.equal(state.maxActive, 4, 'four Sessions must run concurrently and the fifth request must wait');
  assert.deepEqual(results.map((result) => result.text).sort(), ['a', 'b', 'c', 'd', 'e']);
  assert.ok(state.requests.every((request) => Array.isArray(request.history) && request.history.length === 0), 'every request must supply explicit empty history');
  assert.ok(state.sessionOptions.every((options) => options.planningMode === 'disabled'), 'planning must remain disabled');
  assert.ok(state.sessionOptions.every((options) => options.skillDirs?.[0] === '/skills/l3'), 'every Session must load the configured skills directory');
  assert.ok(state.sessionOptions.every((options) => options.continuationEnabled === false && options.maxContinuationTurns === 0), 'continuation must be disabled');
  assert.ok(state.sessionOptions.every((options) => options.maxToolRounds === undefined), 'L3 must use the SDK default tool-round policy');
  assert.ok(state.sessionOptions.every((options) => options.autoParallel === false && options.manualDelegationEnabled === false), 'sub-agent fan-out must be disabled');
  assert.ok(state.sessionOptions.every((options) => options.maxExecutionTimeMs <= 1_000), 'Session execution must not exceed the outer timeout');

  await pool.close();
  assert.equal(state.agentCloses, 1, 'Agent must close once during shutdown');
}

async function verifyRotation() {
  const { state, agentFactory } = fakeHarness();
  const pool = new L3AgentPool({ size: 1, timeoutMs: 1_000, maxJobsPerSession: 2, agentFactory });
  await pool.prewarm('/skills/l3');
  await pool.run('/skills/l3', 'first');
  await pool.run('/skills/l3', 'second');
  await pool.run('/skills/l3', 'third');
  assert.equal(state.sessions, 2, 'a Session must be replaced after its job limit');
  await pool.close();
}

async function verifyPerJobMemoryIsolation() {
  const { state, agentFactory } = fakeHarness();
  const pool = new L3AgentPool({ size: 1, timeoutMs: 1_000, maxJobsPerSession: 1, agentFactory });
  await pool.prewarm('/skills/l3');
  await pool.run('/skills/l3', 'first-event');
  await pool.run('/skills/l3', 'second-event');
  assert.equal(state.agents, 1, 'memory isolation must retain one reusable Agent');
  assert.equal(state.sessions, 2, 'every event must receive a fresh Session');
  const memoryDirs = state.sessionOptions.map((options) => options.memoryStore?.dir);
  assert.ok(memoryDirs.every((dir) => typeof dir === 'string' && dir.includes('anysentry-l3-memory-')), 'every Session must use an explicit temporary FileMemoryStore');
  assert.equal(new Set(memoryDirs).size, memoryDirs.length, 'every Session must use a distinct Memory directory');
  await pool.close();
}

async function verifyTimeoutRecovery() {
  const { state, agentFactory } = fakeHarness();
  const pool = new L3AgentPool({ size: 1, timeoutMs: 50, agentFactory });
  await pool.prewarm('/skills/l3');
  await assert.rejects(() => pool.run('/skills/l3', 'hang'), isL3AgentTimeout);
  const recovered = await pool.run('/skills/l3', 'after-timeout');
  assert.equal(recovered.text, 'after-timeout');
  assert.equal(state.sessions, 2, 'a timed-out Session must be quarantined and replaced');
  assert.ok(state.cancels >= 1, 'timeout must cancel the active Session operation');
  assert.ok(state.sessionCloses >= 1, 'timeout must close the quarantined Session before its slot is reused');
  await pool.close();
}

async function verifyValidationFailureRecovery() {
  const { state, agentFactory } = fakeHarness();
  const pool = new L3AgentPool({ size: 1, timeoutMs: 10_000, executionTimeoutMs: 9_000, agentFactory });
  await pool.prewarm('/skills/l3');
  await assert.rejects(
    () => pool.run('/skills/l3', 'invalid-json', () => { throw new Error('L3 returned no JSON verdict'); }),
    /no JSON verdict/,
  );
  const recovered = await pool.run('/skills/l3', 'same-full-investigation');
  assert.equal(recovered.text, 'same-full-investigation');
  assert.equal(state.sessions, 2, 'a validation failure must replace the Session before the full retry');
  assert.ok(state.cancels >= 1 && state.sessionCloses >= 1, 'a validation failure must cancel and close the old Session');
  await pool.close();
}

async function verifyLatePartialResultIsTimeout() {
  const { agentFactory } = fakeHarness();
  const pool = new L3AgentPool({ size: 1, timeoutMs: 200, executionTimeoutMs: 50, agentFactory });
  await pool.prewarm('/skills/l3');
  await assert.rejects(
    () => pool.run('/skills/l3', 'slow-invalid-json', () => { throw new Error('L3 returned no JSON verdict'); }),
    isL3AgentTimeout,
  );
  await pool.close();
}

function verifyModelAclDoesNotCapOutput() {
  const acl = buildL3AgentAcl({
    A3S_SENTRY_L3_URL: 'https://example.invalid/v1',
    A3S_SENTRY_L3_KEY: 'test-key',
    A3S_SENTRY_L3_MODEL: 'test-model',
  });
  assert.doesNotMatch(acl, /\boutput\s*=/, 'L3 must leave the output limit to the model/provider');
  assert.match(acl, /context = 32768/, 'L3 model context must have a finite default');
}

verifyModelAclDoesNotCapOutput();
await verifyConcurrencyAndIsolation();
await verifyRotation();
await verifyPerJobMemoryIsolation();
await verifyTimeoutRecovery();
await verifyValidationFailureRecovery();
await verifyLatePartialResultIsTimeout();
console.log('L3 agent pool verification passed');
