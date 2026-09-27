import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const { BehavioralAgentDetector } = require('./observer-behavior-discovery.js');
const { SentryJudgeService } = require('../apps/api/dist/security-monitoring/sentry-judge.service.js');
const { DEFAULT_POLICY } = require('../apps/api/dist/security-monitoring/policy-config.js');

const judge = new SentryJudgeService({}, {}, { enabled: false }, {}, {}, {});
judge.applyPolicy(DEFAULT_POLICY);
const now = Date.now();
const detector = new BehavioralAgentDetector({ now: () => now, threshold: 8, llmHostHints: [] });
const instances = new Set();

function prepare(kind, payload, attribution, generation, at = now) {
  const process = { hostId: 'fixture-host', bootId: 'fixture-boot', pid: generation,
    startTimeTicks: String(generation), processGenerationKey: `pgk_${String(generation).padStart(24, '0')}` };
  const meta = { workspacePath: '/workspace', agentId: 'opaque-service', sessionId: `session-${generation}`,
    runId: `run-${generation}`, userId: 'fixture', eventKind: kind, source: 'observer',
    process, attribution, attributes: {} };
  const outcome = judge.prepareAcceptWithDisposition(JSON.stringify({ event: { [kind]: payload } }), meta, at);
  assert.equal(outcome.disposition, 'retained');
  assert.equal(outcome.event.sessionId, meta.sessionId);
  assert.equal(outcome.event.runId, meta.runId);
  assert.equal(outcome.event.process.processGenerationKey, process.processGenerationKey);
  return outcome.event;
}

for (const generation of [41, 42]) {
  const attribution = { physicalWorkloadId: 'container:shared-workload',
    agentInstanceId: `runtime-${generation}`, processGenerationKey: `generation-${generation}` };
  const process = { host_id: 'fixture-host', boot_id: 'fixture-boot', pid: generation,
    start_time_ticks: String(generation), cgroup_id: '77' };
  const model = { process, event: { Egress: { peer: '192.0.2.1', path: '/v1/responses' } } };
  assert.equal(detector.observe(model, attribution), undefined);
  const candidate = detector.observe({ process, event: { ToolExec: { argv: ['opaque-action', 'run'] } } }, attribution);
  assert.equal(candidate?.attribution.classification, 'probable_agent');
  const event = prepare('Egress', { peer: '192.0.2.1', port: 443 }, candidate.attribution, generation);
  assert.equal(event.attribution.agentInstanceId, candidate.attribution.agentInstanceId);
  assert.equal(event.attribution.physicalWorkloadId, 'container:shared-workload');
  assert.equal(event.attribution.source, 'behavior');
  assert.equal(event.judgment.profile, 'full');
  instances.add(event.attribution.agentInstanceId);
}
assert.equal(instances.size, 2, 'two generations in the same workload remain separate API instances');

const unknown = { monitored: false, classification: 'unknown', source: 'none', confidence: 0, reason: 'not_evaluated' };
for (let index = 0; index < 50; index++) {
  const event = prepare('Egress', { peer: '192.0.2.1', port: 443 }, unknown, 99, now + index);
  assert.equal(event.attribution.classification, 'unknown', 'network volume alone cannot promote an API event');
  assert.equal(event.judgment.profile, 'l1_only');
}
const source = await readFile(new URL('../apps/api/src/security-monitoring/sentry-judge.service.ts', import.meta.url), 'utf8');
assert.doesNotMatch(source, /agentInstanceId:\s*['"]__behavior_candidate__['"]/u,
  'a rule sentinel must never replace an entity identity');
assert.doesNotMatch(source, /BehaviorCandidateRegistry/u, 'API must not run a second behavior detector');
console.log('PASS Forwarder candidate -> API identity boundary, two generations, full route, Unknown network burst');
