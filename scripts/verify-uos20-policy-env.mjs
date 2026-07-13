import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const policyModule = require(path.join(root, 'apps/api/dist/security-monitoring/policy-config.js'));
const { buildAcl, policyFromEnvironment } = policyModule;

assert.equal(typeof policyFromEnvironment, 'function', 'policyFromEnvironment must be exported');

const key = 'test-key-that-must-never-be-serialized';
const policy = policyFromEnvironment({
  ANYSENTRY_LLM_BASE_URL: 'http://llm.internal.example/v1/',
  ANYSENTRY_LLM_MODEL: 'customer-model',
  ANYSENTRY_LLM_API_KEY: key,
  ANYSENTRY_LLM_TIMEOUT: '47',
  ANYSENTRY_L3_ENABLED: 'true',
  ANYSENTRY_L3_TIMEOUT: '181',
});

assert.deepEqual(policy.llm, {
  url: 'http://llm.internal.example/v1',
  model: 'customer-model',
  timeoutS: 47,
});
assert.deepEqual(policy.agent, {
  bin: '/opt/anysentry/l3/l3-agent.mjs',
  skills: '/opt/anysentry/l3/skills',
  timeoutS: 181,
});
assert.equal(JSON.stringify(policy).includes(key), false, 'API key must not enter serializable policy');

const acl = buildAcl(policy, { llmApiKey: key });
assert.match(acl, /key = "test-key-that-must-never-be-serialized"/u);
assert.match(acl, /agent \{[\s\S]*timeout_s = 181[\s\S]*\}/u);

const disabled = policyFromEnvironment({
  ANYSENTRY_LLM_MODEL: 'unused-model',
  ANYSENTRY_LLM_API_KEY: key,
  ANYSENTRY_L3_ENABLED: 'true',
});
assert.equal(disabled.llm, null, 'L2 must stay disabled without a base URL');
assert.equal(disabled.agent, null, 'L3 must stay disabled without an LLM base URL');
assert.equal(JSON.stringify(disabled).includes(key), false, 'disabled policy must not expose API key');

console.log('UOS ARM64 environment policy verification passed');
