#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { BehavioralAgentDetector, behaviorKey } = require('./observer-behavior-discovery');

let now = 1_000_000;
const detector = new BehavioralAgentDetector({
  now: () => now,
  threshold: 8,
  windowMs: 60_000,
  probableTtlMs: 120_000,
  maxWorkloads: 100,
});

function event(kind, payload, cgroupId = '77') {
  return {
    process: {
      host_id: 'node-a',
      boot_id: 'boot-a',
      pid: payload.pid ?? 100,
      start_time_ticks: '99',
      cgroup_id: cgroupId,
      cgroup: '0::/user.slice/agent.scope',
    },
    event: { [kind]: payload },
  };
}

const tool = event('ToolExec', { pid: 100, argv: ['python', 'tool.py'] });
assert.equal(
  behaviorKey(tool),
  'host:node-a:boot-a:cgroup:77',
  'behavior groups host activity by stable cgroup before PID',
);
assert.equal(detector.observe(tool), undefined, 'one generic tool is not an Agent');
const promoted = detector.observe(event('Egress', { pid: 100, host: 'api.openai.com' }));
assert.equal(promoted.state, 'agent');
assert.equal(promoted.attribution.classification, 'probable_agent');
assert.equal(promoted.attribution.source, 'behavior');
assert.match(promoted.attribution.evidence[0], /behavior:score=/);
const continued = detector.observe(event('ToolExec', { pid: 101, argv: ['curl', 'https://example.test'] }));
assert.equal(continued.state, 'agent');

now += 61_000;
const hysteresis = detector.observe(event('FileAccess', { pid: 101, path: '/workspace/result.json' }));
assert.equal(hysteresis.state, 'agent', 'a probable candidate survives one empty scoring window');

now += 121_000;
detector.prune();
assert.equal(detector.metrics().candidates, 0);

const generic = new BehavioralAgentDetector({ now: () => now, threshold: 8 });
for (let index = 0; index < 10; index++) {
  generic.observe(event('FileAccess', { pid: 200, path: `/tmp/cache-${index}` }, '88'));
}
assert.equal(generic.metrics().candidates, 0, 'file churn alone never creates an Agent');

const bounded = new BehavioralAgentDetector({
  now: () => now,
  threshold: 8,
  maxWorkloads: 100,
});
for (let index = 0; index < 150; index++) {
  bounded.observe(event('ToolExec', { pid: 300 + index, argv: ['true'] }, String(1_000 + index)));
}
assert.ok(bounded.metrics().workloads <= 100);
assert.ok(bounded.metrics().evicted > 0);

console.log('Behavior discovery verification passed');
