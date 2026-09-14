import assert from 'node:assert/strict';
import { BehaviorAgentScorer } from '../apps/api/dist/security-monitoring/behavior-agent-scorer.js';

const event = (eventId, eventKind, processGenerationKey = 'host:boot:pg-1', at = 1_000) => ({
  schemaVersion: 'anysentry.agent_event.v1', eventId, at, eventKind, eventCategory: 'runtime',
  subject: eventKind, workspacePath: '/', agentId: 'unknown', sessionId: 's', userId: 'u',
  traceId: eventId, spanId: eventId, runId: eventId, verdict: 'allow', tier: 'Rules', severity: 'info',
  reason: '', riskCategory: '', riskName: '', riskType: 'system', riskScore: 0, tokenCount: 0,
  latencyMs: 0, attributes: {}, process: { processGenerationKey },
});

const scorer = new BehaviorAgentScorer({ windowMs: 60_000, threshold: 8, maxScopes: 2, ttlMs: 120_000 });
assert.equal(scorer.observe(event('1', 'LlmCall'), 1_000).candidate, false);
assert.equal(scorer.observe(event('2', 'ToolExec'), 1_001).score, 7);
assert.equal(scorer.observe(event('3', 'Egress'), 1_002).candidate, true);
assert.equal(scorer.observe(event('4', 'LlmCall', 'host:boot:pg-2'), 1_003).candidate, false);
assert.equal(scorer.observe({ ...event('5', 'LlmCall'), activityContext: 'platform_healthcheck' }, 1_004).candidate, false);
assert.equal(scorer.observe(event('6', 'LlmCall', 'host:boot:pg-1', 62_000), 62_000).score, 4, 'new window resets score');
console.log('PASS bounded generic behavior candidate scorer');
