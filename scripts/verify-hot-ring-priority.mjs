#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  hotEvictionIndices,
  isHotProtectedEvent,
} = require('../apps/api/dist/security-monitoring/sentry-judge.service.js');

function event(eventId, eventKind = 'FileAccess', monitored = false, verdict = 'allow') {
  return {
    eventId,
    eventKind,
    verdict,
    attribution: { monitored },
  };
}

assert.equal(isHotProtectedEvent(event('tool', 'AgentTool')), true);
assert.equal(isHotProtectedEvent(event('agent-file', 'FileAccess', true)), true);
assert.equal(isHotProtectedEvent(event('security', 'SecurityAction')), true);
assert.equal(isHotProtectedEvent(event('risk', 'FileAccess', false, 'escalate')), true);
assert.equal(isHotProtectedEvent(event('bulk', 'FileAccess', false)), false);

const bulk = Array.from({ length: 801 }, (_, index) => event(`bulk-${index}`));
const protectedEvents = Array.from({ length: 200 }, (_, index) => event(`tool-${index}`, 'AgentTool'));
const mixed = [...bulk, ...protectedEvents];
const mixedEvictions = hotEvictionIndices(mixed, 1_000, 200, 100);
assert.equal(mixedEvictions.length, 100);
assert(mixedEvictions.every((index) => mixed[index].eventId.startsWith('bulk-')),
  'Bulk must be evicted before the protected reserve');
assert.equal(protectedEvents.every((item) => !mixedEvictions.some((index) => mixed[index] === item)), true);

const protectedOverflow = Array.from({ length: 1_001 }, (_, index) => event(`semantic-${index}`, 'AgentTool'));
const protectedEvictions = hotEvictionIndices(protectedOverflow, 1_000, 200, 100);
assert.equal(protectedEvictions.length, 100);
assert.deepEqual(protectedEvictions, Array.from({ length: 100 }, (_, index) => index),
  'when protected traffic exceeds its own reserve, the oldest protected facts are bounded');

console.log('API Hot Ring protected-reserve verification passed');
