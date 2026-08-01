#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import process from 'node:process';
import {
  assertIdentityReviewProvider,
  buildIdentityReviewAcl,
  identityReviewModelConfig,
  parseIdentityReview,
} from '../apps/api/dist/security-monitoring/identity-review-agent.service.js';
import { IdentityEvidenceService } from '../apps/api/dist/security-monitoring/identity-evidence.service.js';
import { sanitizePolicy } from '../apps/api/dist/security-monitoring/policy-config.js';

const policy = {
  failClosed: false,
  speculate: 'off',
  rules: [],
  llm: { url: 'https://llm.example/v1/chat/completions', model: 'review-model', timeoutS: 60 },
  agent: null,
  identity: { candidatePipeline: 'full' },
};
const normalizedPolicy = sanitizePolicy(policy);
assert.equal(normalizedPolicy.llm?.url, 'https://llm.example/v1');
const config = identityReviewModelConfig(policy, {});
assert.equal(config.url, 'https://llm.example/v1');
assert.equal(config.model, 'review-model');
const acl = buildIdentityReviewAcl(config);
assert.match(acl, /default_model = "openai\/review-model"/u);
assert.match(acl, /baseUrl = "https:\/\/llm\.example\/v1"/u);
await assert.doesNotReject(() => assertIdentityReviewProvider(config, 1_000, async () => new Response('{"ok":true}', { status: 200 })));
await assert.rejects(
  () => assertIdentityReviewProvider(config, 1_000, async () => new Response('no healthy upstream', { status: 503 })),
  /模型当前不可用（HTTP 503: no healthy upstream）/u,
);

assert.deepEqual(
  parseIdentityReview(
    '{"verdict":"agent","confidence":0.2,"summary":"untrusted draft","reason":"draft","evidenceRefs":[]}\n' +
    '{"verdict":"not_agent","confidence":0.91,"summary":"database worker","reason":"fixed server loop without tool alternation","evidenceRefs":["events.json","/etc/shadow"]}',
    ['events.json'],
  ),
  {
    verdict: 'not_agent',
    confidence: 0.91,
    summary: 'database worker',
    reason: 'fixed server loop without tool alternation',
    evidenceRefs: ['events.json'],
  },
);
assert.throws(() => parseIdentityReview('{"verdict":"unknown"}', []), /no valid terminal JSON/u);

const procStat = await readFile(`/proc/${process.pid}/stat`, 'utf8');
const close = procStat.lastIndexOf(')');
const fields = procStat.slice(close + 2).trim().split(/\s+/u);
const startTimeTicks = fields[19];
const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
const event = {
  schemaVersion: 'anysentry.agent_event.v1',
  eventId: 'evt_identity_review_test',
  at: new Date().toISOString(),
  eventKind: 'ToolExec',
  eventCategory: 'tool',
  source: 'observer',
  subject: 'read-only identity review fixture',
  workspacePath: '/workspace/test',
  agentId: 'fixture-agent',
  agentAssetId: 'aga_fixture',
  detectedClassification: 'probable_agent',
  effectiveClassification: 'probable_agent',
  runtime: 'host',
  sessionId: 'session-fixture',
  userId: 'uid:1000',
  traceId: 'tr_fixture',
  spanId: 'sp_fixture',
  runId: 'run_fixture',
  verdict: 'allow',
  tier: 'Rules',
  severity: 'info',
  reason: 'observed',
  riskCategory: 'benign',
  riskName: '正常',
  riskType: 'atomic',
  riskScore: 0,
  tokenCount: 0,
  latencyMs: 1,
  attributes: {},
  process: { pid: process.pid, bootId, startTimeTicks },
};
const fakeAggregation = {
  storedAgentEvents: async () => ({ items: [event], total: 1, updateTime: new Date().toISOString() }),
  agentInventory: () => ({ items: [], total: 0, summary: {}, updateTime: new Date().toISOString() }),
};
const evidence = new IdentityEvidenceService(fakeAggregation);
const bundle = await evidence.stage({ targetType: 'event', eventId: event.eventId, timeType: 'last_3h' });
try {
  assert.deepEqual(bundle.refs.sort(), ['README.txt', 'events.json', 'processes.json', 'target.json']);
  const processes = JSON.parse(await readFile(`${bundle.workspace}/processes.json`, 'utf8'));
  assert.equal(processes[0].pid, process.pid);
  assert.equal(processes[0].validation, 'boot-and-start-time-match');
  assert.equal((await stat(bundle.workspace)).mode & 0o777, 0o500);
  assert.equal((await stat(`${bundle.workspace}/events.json`)).mode & 0o777, 0o400);
} finally {
  await bundle.cleanup();
}

const serviceSource = await readFile(new URL('../apps/api/src/security-monitoring/identity-review-agent.service.ts', import.meta.url), 'utf8');
assert.match(serviceSource, /deny: \['writeFile', 'editFile', 'patchFile', 'bash', 'git', 'webSearch', 'task', 'parallel_task', 'program', 'Skill', 'search_skills'\]/u);
assert.match(serviceSource, /allow: \['readFile', 'ls', 'glob', 'grep'\]/u);
assert.match(serviceSource, /defaultDecision: 'deny'/u);
assert.match(serviceSource, /ANYSENTRY_IDENTITY_REVIEW_TIMEOUT_MS, 120_000/u);
assert.match(serviceSource, /ANYSENTRY_IDENTITY_REVIEW_LLM_TIMEOUT_MS, 45_000/u);
assert.match(serviceSource, /ANYSENTRY_IDENTITY_REVIEW_PREFLIGHT_TIMEOUT_MS, 15_000/u);
assert.match(serviceSource, /circuitBreakerThreshold: 1/u);
assert.match(serviceSource, /new LocalWorkspaceBackend\(bundle\.workspace\)/u);
assert.doesNotMatch(serviceSource, /node:child_process|spawn\(|execFile\(|scripts\/l3-agent/iu, 'identity review must use the SDK, never a CLI process');

console.log('PASS read-only A3S Code SDK identity review contracts and evidence isolation');
