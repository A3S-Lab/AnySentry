#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  detectPackageManagerInstall,
  parseRuntimeInstallEvent,
} from '../apps/api/dist/security-monitoring/supply-chain-install-trigger.js';

function observerLine(kind, payload, process = {}) {
  return JSON.stringify({
    process: { pid: payload.pid, startTimeNs: '1234', ...process },
    event: { [kind]: payload },
  });
}

const commands = [
  ['npm', ['/usr/bin/npm', 'install', '--no-save', 'lodash']],
  ['pnpm', ['pnpm', 'add', 'fastify']],
  ['yarn', ['yarn', 'install', '--immutable']],
  ['pip', ['python3', '-m', 'pip', 'install', 'requests']],
  ['cargo', ['cargo', 'add', 'serde']],
  ['go', ['go', 'get', 'golang.org/x/text']],
  ['composer', ['composer', 'require', 'vendor/package']],
  ['npm', ['bash', '-lc', 'cd /workspace && npm install --no-save lodash']],
];

for (const [expected, argv] of commands) {
  const event = parseRuntimeInstallEvent(observerLine('ToolExec', { pid: 42, argv }));
  assert.equal(event?.phase, 'started');
  assert.equal(event?.packageManager, expected);
  assert.equal(event?.pid, 42);
}

for (const argv of [
  ['npm', 'test'],
  ['printf', '%s', 'npm install lodash'],
  ['bash', '-lc', "printf '%s' 'pip install requests'"],
  ['cargo', 'test'],
  ['go', 'test', './...'],
]) {
  assert.equal(
    parseRuntimeInstallEvent(observerLine('ToolExec', { pid: 43, argv })),
    undefined,
    `ordinary command was misclassified: ${argv.join(' ')}`,
  );
}

assert.equal(detectPackageManagerInstall('cd /workspace && pnpm add zod'), 'pnpm');
assert.equal(detectPackageManagerInstall("printf '%s' 'pnpm add zod'"), undefined);

const success = parseRuntimeInstallEvent(observerLine(
  'ProcessExit',
  { pid: 42, exit_code: 0, signal: 0 },
));
assert.deepEqual(success, {
  phase: 'exited',
  pid: 42,
  startTimeTicks: undefined,
  startTimeNs: '1234',
  succeeded: true,
});

const observerV2Success = parseRuntimeInstallEvent(observerLine(
  'ProcessExit',
  { pid: 44, exit_code: 0, signal: 0 },
  { startTimeNs: undefined, start_time_ticks: 998877 },
));
assert.equal(observerV2Success?.startTimeTicks, '998877');
assert.equal(observerV2Success?.startTimeNs, undefined);

assert.equal(parseRuntimeInstallEvent(observerLine(
  'ProcessExit',
  { pid: 42, exit_code: 1, signal: 0 },
))?.succeeded, false);
assert.equal(parseRuntimeInstallEvent(observerLine(
  'ProcessExit',
  { pid: 42, exit_code: 0, signal: 9 },
))?.succeeded, false);

console.log('Supply-chain runtime install trigger verification passed');
