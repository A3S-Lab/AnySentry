import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const { resolveJudgmentRoute } = require('../apps/api/dist/security-monitoring/identity-judgment-routing.js');
const { sanitizePolicy } = require('../apps/api/dist/security-monitoring/policy-config.js');
const { Sentry, fileAccess } = require('../apps/api/node_modules/@a3s-lab/sentry');

const policy = sanitizePolicy({});
assert.equal(policy.identity.candidatePipeline, 'full');
assert.deepEqual(resolveJudgmentRoute('confirmed_agent', policy), {
  classification: 'confirmed_agent',
  profile: 'full',
  maxTier: 'L1',
  reason: 'confirmed_agent_full',
  routingVersion: 'identity-routing.v1',
});
assert.equal(resolveJudgmentRoute('probable_agent', policy).profile, 'full');
assert.equal(resolveJudgmentRoute('unknown', policy).profile, 'l1_only');
assert.equal(resolveJudgmentRoute(undefined, policy).reason, 'unknown_l1_only');
assert.equal(resolveJudgmentRoute('non_agent', policy).profile, 'discard');

const candidateL1 = sanitizePolicy({ identity: { candidatePipeline: 'l1_only' } });
assert.equal(resolveJudgmentRoute('probable_agent', candidateL1).reason, 'candidate_agent_l1_only');

const full = sanitizePolicy({
  identity: { candidatePipeline: 'full' },
  llm: { url: 'http://127.0.0.1:1/v1', model: 'test', timeoutS: 1 },
  agent: { bin: '/opt/anysentry/l3-agent.mjs', skills: '/opt/anysentry/skills' },
});
assert.equal(resolveJudgmentRoute('confirmed_agent', full).maxTier, 'L3');
assert.equal(resolveJudgmentRoute('probable_agent', full).maxTier, 'L3');
assert.equal(resolveJudgmentRoute('unknown', full).maxTier, 'L1');

const sentry = Sentry.create('fail_closed = true\nllm { url = "http://127.0.0.1:1/v1" }');
assert.equal(typeof sentry.evaluateL1, 'function', 'local staged Sentry SDK must be installed');
const l1 = sentry.evaluateL1(fileAccess(1, '/home/u/.aws/credentials', false));
assert.equal(l1.l1Decision.verdict, 'escalate');
assert.equal(l1.nextTierEligible, true);

const worker = await readFile(new URL('../apps/api/src/security-monitoring/worker-main.ts', import.meta.url), 'utf8');
assert.match(worker, /input\.routing\.profile === 'l1_only'/);
assert.match(worker, /evaluateL1\.call/);
assert.match(worker, /input\.routing\.maxTier === 'L3'/);

console.log('PASS identity-aware judgment routing contracts');
