#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AttributionRepairResolver } = require('./observer-attribution-repair.js');

const root = await mkdtemp(path.join(tmpdir(), 'anysentry-attribution-repair-'));
try {
  await mkdir(path.join(root, 'net'), { recursive: true });
  for (const pid of [1, 100, 101, 200]) {
    await mkdir(path.join(root, String(pid), 'fd'), { recursive: true });
  }
  await writeFile(
    path.join(root, '101', 'environ'),
    'SSH_CONNECTION=198.51.100.9 41000 10.0.0.8 22\0SSH_TTY=/dev/pts/3\0SECRET_TOKEN=never-project-me\0',
  );
  await writeFile(
    path.join(root, 'net', 'tcp'),
    [
      '  sl  local_address rem_address st tx_queue tr retrnsmt uid timeout inode',
      '   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 424242',
      '   1: 0100007F:9C40 0100007F:1F90 01 00000000:00000000 00:00000000 00000000 1000 0 525252',
      '   2: 0100007F:9C41 0100007F:2328 01 00000000:00000000 00:00000000 00000000 1000 0 626262',
      '',
    ].join('\n'),
  );
  for (const name of ['tcp6', 'udp', 'udp6']) await writeFile(path.join(root, 'net', name), 'header\n');
  await symlink('socket:[424242]', path.join(root, '101', 'fd', '3'));
  await symlink('socket:[525252]', path.join(root, '200', 'fd', '3'));
  await symlink('socket:[626262]', path.join(root, '200', 'fd', '4'));

  const observedFile = path.join(root, 'workspace.txt');
  await writeFile(observedFile, 'fixture');
  await symlink(observedFile, path.join(root, '101', 'fd', '4'));

  const processes = new Map([
    [1, { pid: 1, ppid: 0, startTime: '1', comm: 'systemd', exe: '/usr/lib/systemd/systemd' }],
    [100, { pid: 100, ppid: 1, startTime: '100', comm: 'codex', exe: '/usr/bin/codex', cwd: '/workspace' }],
    [101, { pid: 101, ppid: 100, startTime: '101', comm: 'bash', exe: '/usr/bin/bash', cwd: '/workspace', argv: 'bash -lc serve' }],
    [200, { pid: 200, ppid: 1, startTime: '200', comm: 'postgres', exe: '/usr/bin/postgres', cwd: '/var/lib/postgresql' }],
  ]);
  const resolver = new AttributionRepairResolver({
    procRoot: root,
    hostId: 'host-repair',
    bootId: 'boot-repair',
    now: () => 1_788_600_000_000,
    listPids: () => [...processes.keys()],
    readProcess: (pid) => processes.get(pid),
    containerPid: (runtime, value) => runtime === 'docker' && value === 'agent-container' ? 101 : undefined,
  });

  const port = resolver.repair({ type: 'port', value: '8080' });
  assert.deepEqual(port.candidates.map((candidate) => candidate.pid), [101]);
  assert.equal(port.scan.matchMode, 'listener',
    'a listener must outrank unrelated clients connected to the same remote port');
  assert.equal(port.authority, 'userspace_snapshot');
  assert.equal(port.candidates[0].launchContext.origins
    .find((origin) => origin.type === 'ssh_session')?.remoteAddress, '198.51.100.9');
  assert.equal(JSON.stringify(port).includes('never-project-me'), false);
  assert.deepEqual(
    port.candidates[0].launchContext.path.map((node) => node.command),
    ['systemd', 'codex', 'bash'],
  );

  const outboundPort = resolver.repair({ type: 'port', value: '9000' });
  assert.deepEqual(outboundPort.candidates.map((candidate) => candidate.pid), [200]);
  assert.equal(outboundPort.scan.matchMode, 'connection_fallback');

  const file = resolver.repair({ type: 'file', value: observedFile });
  assert.deepEqual(file.candidates.map((candidate) => candidate.pid), [101]);

  const name = resolver.repair({ type: 'name', value: 'codex', exact: true });
  assert.deepEqual(name.candidates.map((candidate) => candidate.pid), [100]);

  const container = resolver.repair({ type: 'container', value: 'agent-container', runtime: 'docker' });
  assert.deepEqual(container.candidates.map((candidate) => candidate.pid), [101]);

  const missing = resolver.repair({ type: 'pid', value: '999' });
  assert.equal(missing.candidates[0].state, 'process_unavailable');
  assert.equal(missing.partial, true);

  const boundedResolver = new AttributionRepairResolver({
    procRoot: root,
    hostId: 'host-repair',
    bootId: 'boot-repair',
    maxProcesses: 2,
    listPids: () => [...processes.keys()],
    readProcess: (pid) => processes.get(pid),
  });
  const truncated = boundedResolver.repair({ type: 'name', value: 'postgres', exact: true });
  assert.equal(truncated.candidates.length, 0);
  assert.equal(truncated.scan.truncated, true);
  assert.equal(truncated.partial, true,
    'hitting the process bound must be visible instead of reporting a complete negative result');

  console.log('Observer on-demand attribution repair verification passed.');
} finally {
  await rm(root, { recursive: true, force: true });
}
