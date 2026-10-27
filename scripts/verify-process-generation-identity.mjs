#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AgentAttributor } = require('./observer-agent-attribution.js');
const { legacyRootNameDocument } = require('./observer-agent-runtime-signatures.js');

const common = { hostId: 'generation-host', bootId: 'generation-boot', cgroupId: '900' };
const rootNs = '10000000000';
const bashNs = '10010000000';

function makeAttributor(options = {}) {
  return new AgentAttributor({
    hostId: common.hostId,
    bootId: common.bootId,
    rootNames: 'kimi',
    readProc: () => undefined,
    readStartTime: () => undefined,
    listPids: () => [],
    ...options,
  });
}

function exec(attributor, process, argv) {
  return attributor.classify({
    process: { ...common, ...process },
    event: { ToolExec: { pid: process.pid, ppid: process.ppid, argv } },
  });
}

function exit(attributor, process) {
  return attributor.classify({
    process: { ...common, ...process },
    event: { ProcessExit: { pid: process.pid, exit_code: 0, signal: 0 } },
  });
}

function root(attributor, identity = {}) {
  const result = exec(attributor, {
    pid: 10001,
    ppid: 1,
    comm: 'kimi',
    exe: '/opt/kimi',
    cwd: '/workspace',
    startBoottimeNs: rootNs,
    userHz: 100,
    ...identity,
  }, ['kimi']);
  assert.equal(result.state, 'agent');
}

{
  const attributor = makeAttributor();
  root(attributor);
  const parent = {
    pid: 10002,
    ppid: 10001,
    creationPpid: 10001,
    creationParentStartBoottimeNs: rootNs,
    startBoottimeNs: bashNs,
    userHz: 100,
    comm: 'bash',
    exe: '/app/cmain',
  };
  assert.equal(exec(attributor, parent, ['/app/cmain', '0']).state, 'agent');
  assert.equal(exec(attributor, {
    pid: 10003,
    ppid: 10002,
    creationPpid: 10002,
    creationParentStartBoottimeNs: bashNs,
    startBoottimeNs: '10020000000',
    userHz: 100,
    comm: 'gcc',
    exe: '/usr/bin/gcc',
  }, ['gcc', 'main.c']).state, 'agent', 'child follows exact parent generation');
  assert.equal(exec(attributor, {
    pid: 10004,
    ppid: 10002,
    creationPpid: 10002,
    creationParentStartBoottimeNs: '99999999999',
    startBoottimeNs: '10030000000',
    userHz: 100,
    comm: 'gcc',
    exe: '/usr/bin/gcc',
  }, ['gcc', 'other.c']).state, 'unknown', 'conflicting parent generation stays unresolved');
  const result = exit(attributor, {
    pid: 10002,
    startBoottimeNs: bashNs,
    userHz: 100,
    comm: 'cmain',
  });
  assert.equal(result.state, 'agent', 'short-lived exit keeps exact generation without /proc');
}

{
  const attributor = makeAttributor();
  root(attributor, { startBoottimeNs: undefined, startTimeTicks: '1000' });
  const result = exec(attributor, {
    pid: 10010,
    ppid: 10001,
    creationPpid: 10001,
    creationParentStartBoottimeNs: rootNs,
    startBoottimeNs: bashNs,
    userHz: 100,
    comm: 'bash',
    exe: '/usr/bin/git',
  }, ['git', 'log']);
  assert.equal(result.state, 'agent', 'ns parent identity matches legacy proc ticks using event USER_HZ');
}

{
  const attributor = makeAttributor();
  root(attributor);
  const process = {
    pid: 10020,
    ppid: 10001,
    creationPpid: 10001,
    creationParentStartBoottimeNs: rootNs,
    startBoottimeNs: '10100000000',
    userHz: 100,
    comm: 'bash',
    exe: '/bin/bash',
  };
  assert.equal(exec(attributor, process, ['bash']).state, 'agent');
  assert.equal(exec(attributor, { ...process, comm: 'cmain', exe: '/app/cmain' }, ['/app/cmain']).state, 'agent');
  assert.equal(exit(attributor, {
    pid: process.pid,
    startBoottimeNs: process.startBoottimeNs,
    userHz: 100,
    comm: 'cmain',
  }).state, 'agent', 'comm update does not create a new process generation');
}

{
  const attributor = makeAttributor();
  root(attributor);
  const process = {
    pid: 10030,
    ppid: 10001,
    creationPpid: 10001,
    creationParentStartBoottimeNs: rootNs,
    userHz: 100,
    comm: 'bash',
    exe: '/bin/bash',
  };
  assert.equal(exec(attributor, { ...process, startBoottimeNs: '11000000000' }, ['bash']).state, 'agent');
  const firstKey = attributor.procs.get(process.pid).processKey;
  assert.equal(exec(attributor, { ...process, startBoottimeNs: '12000000000' }, ['bash']).state, 'agent');
  const secondKey = attributor.procs.get(process.pid).processKey;
  assert.notEqual(firstKey, secondKey, 'simulated PID reuse creates separate generations');
}

{
  let now = 1000;
  const attributor = makeAttributor({ now: () => now, negativeTtlMs: 1 });
  root(attributor);
  assert.equal(exec(attributor, {
    pid: 10002,
    ppid: 10001,
    creationPpid: 10001,
    creationParentStartBoottimeNs: rootNs,
    startBoottimeNs: bashNs,
    userHz: 100,
    comm: 'bash',
    exe: '/bin/bash',
  }, ['bash']).state, 'agent');
  now += 10;
  assert.equal(exec(attributor, {
    pid: 10003,
    ppid: 10002,
    creationPpid: 10002,
    creationParentStartBoottimeNs: bashNs,
    startBoottimeNs: '10020000000',
    userHz: 100,
    comm: 'cmain',
    exe: '/app/polyglot/cmain',
  }, ['/app/polyglot/cmain', '1000']).state, 'agent',
  'expired negative TTL does not discard a generation-matched parent chain');
}

{
  const attributor = makeAttributor({ rootNames: 'other' });
  const parent = {
    pid: 10001,
    ppid: 99999,
    comm: 'kimi',
    exe: '/opt/kimi',
    cwd: '/workspace',
    startBoottimeNs: rootNs,
    userHz: 100,
  };
  assert.equal(exec(attributor, parent, ['kimi']).state, 'unknown', 'root is cached before its signature is configured');
  attributor.signatureRegistry.replace(legacyRootNameDocument('kimi'));
  assert.equal(exec(attributor, {
    pid: 10002,
    ppid: parent.pid,
    creationPpid: parent.pid,
    creationParentStartBoottimeNs: rootNs,
    startBoottimeNs: bashNs,
    userHz: 100,
    comm: 'bash',
    exe: '/usr/bin/gcc',
  }, ['gcc', '--version']).state, 'agent', 'cached unknown parent is re-evaluated without /proc');
  assert.equal(exec(attributor, {
    pid: 10003,
    ppid: parent.pid,
    creationPpid: parent.pid,
    creationParentStartBoottimeNs: '99999999999',
    startBoottimeNs: '10020000000',
    userHz: 100,
    comm: 'bash',
    exe: '/usr/bin/gcc',
  }, ['gcc', 'other.c']).state, 'unknown', 'signature re-evaluation does not ignore generation mismatch');
}

console.log('PASS: exact identity, parent generation, ticks compatibility, stable exec, simulated PID reuse, cached signature promotion');
