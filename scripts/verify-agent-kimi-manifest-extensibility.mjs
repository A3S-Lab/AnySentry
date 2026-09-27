#!/usr/bin/env node

/**
 * P4 extensibility regression: adding Kimi Manifest must not change Codex/Claude
 * adapter behavior, and Kimi must be selected by product/exe hints alone.
 * Run `pnpm build:api` first.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  DEFAULT_AGENT_ADAPTER_MANIFESTS,
} = require('../apps/api/dist/security-monitoring/canonical-observability.js');
const {
  applyAgentAdapter,
  classifyTraffic,
  mapToolNameView,
  matchAgentAdapterManifest,
  normalizeExecArgv,
} = require('../apps/api/dist/security-monitoring/agent-adapter-execution.js');

const kimi = matchAgentAdapterManifest({ product: 'Kimi Code', comm: 'kimi' });
assert.equal(kimi?.id, 'kimi-cli', 'Kimi product hint must select kimi-cli Manifest');
assert.equal(
  matchAgentAdapterManifest({ argv0: '/usr/local/bin/kimi-cli' })?.id,
  'kimi-cli',
);

assert.equal(
  classifyTraffic(kimi, { path: '/v1/chat/completions', wireTemplateId: 'openai-chat' }),
  'conversation',
);
assert.equal(classifyTraffic(kimi, { path: '/v1/models' }), 'control');
assert.equal(mapToolNameView(kimi, 'Bash'), 'shell');
assert.equal(mapToolNameView(kimi, 'apply_patch'), 'file_edit');
assert.equal(
  normalizeExecArgv(kimi, ['bash', '-lc', 'ls']),
  'ls',
);

// Codex/Claude selection and traffic roles must remain byte-stable after Kimi addition.
const codex = matchAgentAdapterManifest({ product: 'Codex', comm: 'tokio-rt-worker' });
const claude = matchAgentAdapterManifest({ product: 'Claude Code', comm: 'HTTP Client' });
assert.equal(codex?.id, 'codex-cli');
assert.equal(claude?.id, 'claude-code');
assert.equal(
  classifyTraffic(codex, { path: '/v1/responses', wireTemplateId: 'openai-responses' }),
  'conversation',
);
assert.equal(
  classifyTraffic(claude, { path: '/v1/messages', wireTemplateId: 'anthropic-messages' }),
  'conversation',
);
assert.equal(mapToolNameView(codex, 'shell'), 'shell');
assert.equal(mapToolNameView(claude, 'Bash'), 'shell');

const ids = DEFAULT_AGENT_ADAPTER_MANIFESTS.map((manifest) => manifest.id);
assert.ok(ids.includes('kimi-cli'));
assert.ok(ids.includes('codex-cli'));
assert.ok(ids.includes('claude-code'));
assert.equal(new Set(ids).size, ids.length, 'Manifest ids must stay unique');

const applied = applyAgentAdapter({
  schemaVersion: 'anysentry.agent_interaction.v1',
  interactionId: 'mi_' + 'a'.repeat(24),
  interactionType: 'model',
  at: Date.now(),
  workspacePath: '/workspace',
  agentAssetId: 'aa_kimi',
  agentProduct: 'Kimi Code',
  detectedClassification: 'confirmed_agent',
  currentEffectiveClassification: 'confirmed_agent',
  connectionId: 'tls:1',
  transport: 'tls',
  protocol: 'http/1.1',
  endpoint: 'api.moonshot.cn',
  method: 'POST',
  path: '/v1/chat/completions',
  statusCode: 200,
  startedAtUnixNs: '1000000000',
  requestCompleteAtUnixNs: '1000000001',
  firstResponseAtUnixNs: '1000000002',
  endedAtUnixNs: '1000000003',
  durationNs: '3',
  timeQuality: 'collector_calibrated',
  request: { body: '', encoding: 'utf8', contentType: 'application/json', capturedBytes: 0, decodedBytes: 0, sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' },
  response: { body: '', encoding: 'utf8', contentType: 'application/json', capturedBytes: 0, decodedBytes: 0, sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' },
  toolCalls: [{ toolCallId: 'call_1', name: 'Bash', arguments: { command: 'ls' } }],
  toolResults: [],
  completeness: 'partial',
  partialReasons: [],
  captureSource: 'tls',
  receivedAt: Date.now(),
  wireTemplateId: 'openai-chat',
  process: { comm: 'kimi', exe: '/usr/bin/kimi' },
});
assert.equal(applied.agentAdapterId, 'kimi-cli');
assert.equal(applied.trafficRole, 'conversation');
assert.equal(applied.toolCalls[0].canonicalKind, 'shell');

console.log('verify-agent-kimi-manifest-extensibility: ok');
