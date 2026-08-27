#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import process from 'node:process';
import {
  blocksAutomaticInfrastructureConfirmation,
  buildIdentityReviewMessages,
  IdentityReviewAgentService,
  identityReviewModelConfig,
  parseIdentityReview,
  requestIdentityReview,
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
const config = identityReviewModelConfig(policy, {
  A3S_SENTRY_LLM_KEY: 'fast-review-test-key',
  A3S_SENTRY_L3_URL: 'https://must-not-be-used.example/v1',
  A3S_SENTRY_L3_MODEL: 'must-not-be-used',
  A3S_SENTRY_L3_KEY: 'deep-key-must-not-be-used',
});
assert.equal(config.url, 'https://llm.example/v1');
assert.equal(config.model, 'review-model');
assert.equal(config.key, 'fast-review-test-key');
const documents = {
  'target.json': '{"agentAssetId":"aga_fixture"}',
  'events.json': '[{"eventKind":"ToolExec","subject":"read file"}]',
  'processes.json': '[{"pid":123,"validation":"boot-and-start-time-match"}]',
};
const messages = buildIdentityReviewMessages(documents, 24_576);
assert.equal(messages.length, 2);
assert.match(messages[0].content, /Return exactly one JSON object/u);
assert.match(messages[1].content, /<<UNTRUSTED_EVIDENCE>>/u);
let requestCount = 0;
const directDecision = await requestIdentityReview(
  config,
  documents,
  Object.keys(documents),
  1_000,
  async (_input, init) => {
    requestCount += 1;
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, 'review-model');
    assert.equal(body.stream, false);
    assert.equal(body.reasoning_effort, 'none');
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.equal(body.messages.length, 2);
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: '{"verdict":"agent","confidence":0.88,"summary":"coding agent","reason":"alternating tool activity","evidenceRefs":["events.json"]}',
        },
      }],
    }), { status: 200 });
  },
);
assert.equal(requestCount, 1, 'identity review must make exactly one model request');
assert.equal(directDecision.verdict, 'agent');
assert.deepEqual(directDecision.evidenceRefs, ['events.json']);
await assert.rejects(
  () => requestIdentityReview(config, documents, Object.keys(documents), 1_000, async () => new Response('no healthy upstream', { status: 503 })),
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
const infrastructureCandidateEvent = {
  ...event,
  eventId: 'evt_identity_review_infrastructure',
  agentId: 'discovered-ai-apm-web',
  attribution: {
    monitored: true,
    classification: 'probable_agent',
    agentScopeId: 'discovered-ai-apm-web',
    agentDisplayName: 'ai-apm-web',
    physicalWorkloadId: 'docker:local:ai-apm-web',
    workloadRef: {
      environment: 'docker',
      kind: 'container',
      name: 'ai-apm-web',
      containerName: 'ai-apm-web',
      containerImage: 'databuffhub/ai-apm-web:test',
    },
    confidence: 0.88,
    reason: 'hint_only',
    source: 'behavior',
    evidence: [
      'behavior:score=18',
      'behavior:llm=0',
      'behavior:tools=28',
      'behavior:agent_sequences=11',
    ],
  },
};
assert.equal(
  blocksAutomaticInfrastructureConfirmation(infrastructureCandidateEvent),
  true,
  'a no-LLM observability service must never be auto-confirmed as an Agent',
);
assert.equal(
  blocksAutomaticInfrastructureConfirmation({
    ...infrastructureCandidateEvent,
    attribution: {
      ...infrastructureCandidateEvent.attribution,
      evidence: ['behavior:llm=1'],
    },
  }),
  false,
  'observed model activity prevents the no-LLM infrastructure gate from making a terminal decision',
);
const fakeAggregation = {
  storedAgentEvents: async () => ({ items: [event], total: 1, updateTime: new Date().toISOString() }),
  storedAgentInventory: async () => ({
    items: [{
      ...event,
      classification: 'probable_agent',
      reviewIdentityKeys: [],
      tags: [],
      attributionEvidence: [],
      eventCount: 1,
    }],
    total: 1,
    summary: {},
    updateTime: new Date().toISOString(),
  }),
};
const evidence = new IdentityEvidenceService(fakeAggregation);
const bundle = await evidence.stage({ targetType: 'event', eventId: event.eventId, timeType: 'last_3h' });
try {
  assert.deepEqual(bundle.refs.sort(), ['README.txt', 'events.json', 'processes.json', 'target.json']);
  assert.equal(JSON.parse(bundle.documents['processes.json'])[0].pid, process.pid);
  const processes = JSON.parse(await readFile(`${bundle.workspace}/processes.json`, 'utf8'));
  assert.equal(processes[0].pid, process.pid);
  assert.equal(processes[0].validation, 'boot-and-start-time-match');
  assert.equal((await stat(bundle.workspace)).mode & 0o777, 0o500);
  assert.equal((await stat(`${bundle.workspace}/events.json`)).mode & 0o777, 0o400);
} finally {
  await bundle.cleanup();
}

const previousAutoDelay = process.env.ANYSENTRY_IDENTITY_AUTO_REVIEW_DELAY_MS;
const previousAutoRetry = process.env.ANYSENTRY_IDENTITY_AUTO_REVIEW_RETRY_MS;
const originalFetch = globalThis.fetch;
process.env.ANYSENTRY_IDENTITY_AUTO_REVIEW_DELAY_MS = '1';
process.env.ANYSENTRY_IDENTITY_AUTO_REVIEW_RETRY_MS = '1000';
let automaticModelCalls = 0;
let automaticReviewCalls = 0;
let automaticApplied = false;
globalThis.fetch = async () => {
  automaticModelCalls += 1;
  return new Response(JSON.stringify({
    choices: [{
      message: {
        content: '{"verdict":"agent","confidence":0.85,"summary":"stable coding agent","reason":"bounded evidence shows repeated agent tool orchestration","evidenceRefs":["events.json"]}',
      },
    }],
  }), { status: 200 });
};
const automaticEvidence = {
  stage: async () => ({
    target: { targetType: 'agent', agentAssetId: 'agent_auto_fixture' },
    refs: Object.keys(documents),
    documents,
    digest: 'auto-digest',
    cleanup: async () => undefined,
  }),
};
const automaticJudge = {
  loadIdentityAiReviews: async () => [],
  appendIdentityAiReviewRevision: async () => true,
  getPolicy: () => ({ policy }),
};
const automaticRuntime = {
  isCallable: () => true,
  get: () => ({
    url: 'https://llm.example/v1',
    model: 'review-model',
    apiKey: 'runtime-key',
    contextTokens: 24_576,
  }),
};
const automaticMetadata = {
  resolveEvent: (candidateEvent) => {
    const infrastructure =
      candidateEvent.attribution?.workloadRef?.containerName === 'ai-apm-web';
    return {
      agentAssetId: infrastructure ? 'agent_auto_infrastructure' : 'agent_auto_fixture',
      detectedClassification: 'probable_agent',
      effectiveClassification: infrastructure
        ? 'probable_agent'
        : automaticApplied ? 'confirmed_agent' : 'probable_agent',
    };
  },
  logicalIdentityKeysForEvent: (candidateEvent) => [
    candidateEvent.attribution?.workloadRef?.containerName === 'ai-apm-web'
      ? 'logical:docker:test:ai-apm-web'
      : 'logical:host:test:codex',
  ],
  identityKeysForEvent: () => ['instance:host:test:pid:1'],
  review: () => {
    automaticReviewCalls += 1;
    automaticApplied = true;
    return { reviewDecision: 'confirmed_agent' };
  },
};
const automaticService = new IdentityReviewAgentService(
  automaticEvidence,
  automaticJudge,
  automaticRuntime,
  automaticMetadata,
);
try {
  await automaticService.onModuleInit();
  automaticService.considerCandidate({
    ...event,
    at: Date.now(),
    attribution: {
      monitored: true,
      classification: 'probable_agent',
      agentScopeId: 'codex',
      agentDisplayName: 'codex',
      agentWorkspacePath: '/workspace/test',
      confidence: 0.8,
      reason: 'hint_only',
      source: 'behavior',
    },
  }, () => undefined);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(automaticModelCalls, 1, 'a new stable candidate identity is reviewed exactly once');
  assert.equal(automaticReviewCalls, 1, 'a high-confidence model result is persisted as an Agent confirmation');

  automaticService.considerCandidate({
    ...event,
    eventId: 'evt_identity_review_restarted_instance',
    at: Date.now(),
    process: { ...event.process, pid: process.pid + 1 },
    attribution: {
      monitored: true,
      classification: 'probable_agent',
      agentScopeId: 'codex',
      agentDisplayName: 'codex',
      agentWorkspacePath: '/workspace/test',
      confidence: 0.8,
      reason: 'hint_only',
      source: 'behavior',
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(automaticModelCalls, 1, 'a trusted replacement instance inherits the stored logical identity');

  automaticService.considerCandidate(infrastructureCandidateEvent);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(automaticModelCalls, 1, 'explicit no-LLM infrastructure evidence skips automatic model review');
  assert.equal(automaticReviewCalls, 1, 'explicit infrastructure evidence cannot be persisted as Agent confirmation');
} finally {
  await automaticService.onModuleDestroy();
  globalThis.fetch = originalFetch;
  if (previousAutoDelay === undefined) delete process.env.ANYSENTRY_IDENTITY_AUTO_REVIEW_DELAY_MS;
  else process.env.ANYSENTRY_IDENTITY_AUTO_REVIEW_DELAY_MS = previousAutoDelay;
  if (previousAutoRetry === undefined) delete process.env.ANYSENTRY_IDENTITY_AUTO_REVIEW_RETRY_MS;
  else process.env.ANYSENTRY_IDENTITY_AUTO_REVIEW_RETRY_MS = previousAutoRetry;
}

const serviceSource = await readFile(new URL('../apps/api/src/security-monitoring/identity-review-agent.service.ts', import.meta.url), 'utf8');
assert.match(serviceSource, /ANYSENTRY_IDENTITY_REVIEW_TIMEOUT_MS, 45_000/u);
assert.match(serviceSource, /requestIdentityReview\(/u);
assert.match(serviceSource, /stream: false/u);
for (const forbidden of [
  'Agent.create',
  'sessionAsync',
  'maxToolRounds',
  'search_skills',
  'node:child_process',
  'spawn(',
  'execFile(',
  'scripts/l3-agent',
]) {
  assert.equal(
    serviceSource.includes(forbidden),
    false,
    `identity review must use one direct model request, never ${forbidden}`,
  );
}

console.log('PASS single-request identity review contracts and evidence isolation');
