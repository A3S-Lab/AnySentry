#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveProtectedEventRoute } = require('../apps/api/dist/security-monitoring/protected-event-routing.js');
const { processLifecycleFact } = require('../apps/api/dist/security-monitoring/process-lifecycle.js');

assert.equal(resolveProtectedEventRoute({ eventKind: 'SystemContext', classification: 'non_agent' }), 'system_context');
assert.equal(resolveProtectedEventRoute({ eventKind: 'SecurityAction', classification: 'non_agent' }), 'security');
assert.equal(resolveProtectedEventRoute({ eventKind: 'ToolExec', classification: 'non_agent' }), 'structural');
assert.equal(resolveProtectedEventRoute({ eventKind: 'ProcessExit', classification: 'non_agent' }), 'structural');
assert.equal(resolveProtectedEventRoute({ eventKind: 'FileAccess', classification: 'non_agent' }), 'ordinary');
assert.equal(resolveProtectedEventRoute({
  eventKind: 'AgentTool',
  classification: 'non_agent',
  attributionEvidence: ['server:authenticated-agent-adapter'],
}), 'agent_conflict');
assert.equal(resolveProtectedEventRoute({
  eventKind: 'AgentTool',
  classification: 'non_agent',
  attributionEvidence: ['producer:untrusted'],
}), 'ordinary');

const base = {
  eventId: 'evt-lifecycle-1',
  eventKind: 'ToolExec',
  at: 100,
  receivedAt: 200,
  source: 'observer',
  workspacePath: '/workspace',
  subjectAssetId: 'service:k8s:cluster-a:default:clickhouse',
  subjectAssetType: 'service',
  assetBindingQuality: 'logical',
  assetBindingRevision: 4,
  process: {
    hostId: 'host-a',
    bootId: 'boot-a',
    pid: 42,
    ppid: 1,
    startTimeTicks: '1234',
    exe: '/usr/bin/bash',
  },
  attribution: { physicalWorkloadId: 'container:abc' },
  attributes: {
    argv: 'sensitive raw command',
    path: '/secret/path',
    'anysentry.kernel.command_hash': 'a'.repeat(64),
  },
};
const exec = processLifecycleFact(base);
assert.equal(exec?.factKind, 'exec');
assert.equal(exec?.startTime, 'ticks:1234');
assert.equal(exec?.commandHash, 'a'.repeat(64));
assert.equal(exec?.physicalWorkloadId, 'container:abc');
assert.equal(exec?.subjectAssetId, 'service:k8s:cluster-a:default:clickhouse');
assert.equal(Object.hasOwn(exec ?? {}, 'argv'), false);
assert.equal(Object.hasOwn(exec ?? {}, 'path'), false);

const reused = processLifecycleFact({
  ...base,
  eventId: 'evt-lifecycle-2',
  process: { ...base.process, startTimeTicks: '5678' },
});
assert.notEqual(reused?.processInstanceKey, exec?.processInstanceKey, 'PID reuse must create a new Process generation');
const root = processLifecycleFact({
  ...base,
  eventId: 'evt-lifecycle-root',
  attribution: {
    ...base.attribution,
    agentInstanceId: 'runtime-agent-a',
    rootPid: 42,
  },
});
assert.equal(root?.rootProcess, true);
assert.equal(root?.runtimeInstanceId, 'runtime-agent-a');
assert.equal(processLifecycleFact({
  ...base,
  eventId: 'evt-lifecycle-weak',
  process: { ...base.process, startTimeTicks: undefined, startTimeNs: undefined },
}), undefined, 'missing process start must fail open instead of creating a weak lifecycle fact');

const exit = processLifecycleFact({
  ...base,
  eventId: 'evt-lifecycle-exit',
  eventKind: 'ProcessExit',
  attributes: { exit_code: 137, signal: 9 },
});
assert.equal(exit?.factKind, 'exit');
assert.equal(exit?.exitStatus, 137);
assert.equal(exit?.exitSignal, 9);

const cleanExit = processLifecycleFact({
  ...base,
  eventId: 'evt-lifecycle-clean-exit',
  eventKind: 'ProcessExit',
  attributes: { exit_code: 0, signal: 0 },
});
assert.equal(cleanExit?.exitStatus, 0, 'an observed clean exit must retain an explicit zero status');
assert.equal(cleanExit?.exitSignal, 0, 'an observed clean exit must retain an explicit zero signal');

const unknownExit = processLifecycleFact({
  ...base,
  eventId: 'evt-lifecycle-unknown-exit',
  eventKind: 'ProcessExit',
  attributes: {},
});
assert.equal(Object.hasOwn(unknownExit ?? {}, 'exitStatus'), false, 'missing exit status must not become a clean exit');
assert.equal(Object.hasOwn(unknownExit ?? {}, 'exitSignal'), false, 'missing exit signal must remain unknown');

console.log('Protected non-Agent routing and compact lifecycle verification passed');
