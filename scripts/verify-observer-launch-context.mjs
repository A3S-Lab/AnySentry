#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildLaunchContext } = require('./observer-launch-context.js');
const { SystemdLaunchEnricher } = require('./observer-systemd-enrichment.js');

const processTable = new Map([
  [1, { pid: 1, ppid: 0, startTime: '1', comm: 'systemd', exe: '/usr/lib/systemd/systemd' }],
  [200, { pid: 200, ppid: 1, startTime: '200', comm: 'sshd', exe: '/usr/sbin/sshd' }],
  [300, { pid: 300, ppid: 200, startTime: '300', comm: 'bash', exe: '/usr/bin/bash' }],
  [400, {
    pid: 400,
    ppid: 300,
    startTime: '400',
    comm: 'codex',
    exe: '/usr/bin/codex',
    cgroup: '0::/system.slice/codex-agent.service',
  }],
]);
const generationKey = (process) => process?.startTime
  ? `pgk_${createHash('sha256').update(JSON.stringify([
      'host-launch', 'boot-launch', process.pid, process.startTime,
    ])).digest('hex').slice(0, 24)}`
  : undefined;
const context = buildLaunchContext({
  ...processTable.get(400),
  hostId: 'host-launch',
  bootId: 'boot-launch',
}, {
  now: () => 1_788_600_000_000,
  generationKey,
  getProcess: (pid) => {
    const process = processTable.get(pid);
    return process ? { ...process, hostId: 'host-launch', bootId: 'boot-launch' } : undefined;
  },
  getEnvironment: (pid) => pid === 400 ? {
    SSH_CONNECTION: '203.0.113.8 52144 10.0.0.5 22',
    SSH_TTY: '/dev/pts/7',
    TMUX: '/tmp/tmux-1000/default,1234,0',
    SECRET_TOKEN: 'must-not-be-read-or-projected',
  } : {},
});

assert.deepEqual(context.path.map((node) => node.command), ['systemd', 'sshd', 'bash', 'codex']);
assert.deepEqual(
  context.origins.map((origin) => [origin.type, origin.name]),
  [
    ['service_manager', 'systemd'],
    ['ssh_session', 'sshd'],
    ['shell', 'bash'],
    ['systemd_unit', 'codex-agent.service'],
  ],
);
assert.equal(context.completeness, 'complete');
const sshOrigin = context.origins.find((origin) => origin.type === 'ssh_session');
assert.equal(sshOrigin.remoteAddress, '203.0.113.8');
assert.equal(sshOrigin.remotePort, 52144);
assert.equal(sshOrigin.localAddress, '10.0.0.5');
assert.equal(sshOrigin.localPort, 22);
assert.equal(sshOrigin.tty, '/dev/pts/7');
assert.equal(sshOrigin.terminalSession, 'tmux');
assert.equal(JSON.stringify(context).includes('must-not-be-read-or-projected'), false);
assert.equal(buildLaunchContext({ pid: 900, ppid: 1, comm: 'codex' }, {
  generationKey,
  getProcess: () => processTable.get(1),
}), undefined, 'an unverifiable root generation must omit optional LaunchContext');

let calls = 0;
const execFile = (_command, args, _options, callback) => {
  calls++;
  const unit = args[1];
  if (unit === 'codex-agent.service') {
    callback(null, [
      'Description=Codex Agent Runtime',
      'FragmentPath=/etc/systemd/system/codex-agent.service',
      'NRestarts=3',
      'TriggeredBy=codex-agent.timer',
      'Triggers=',
    ].join('\n'));
    return;
  }
  if (unit === 'codex-agent.timer') {
    callback(null, [
      'TimersCalendar=*-*-* 06,18:00:00',
      'LastTriggerUSec=1788590000000000',
      'NextElapseUSecRealtime=1788631200000000',
    ].join('\n'));
    return;
  }
  callback(new Error(`unexpected unit ${unit}`), '');
};
const enricher = new SystemdLaunchEnricher({
  execFile,
  now: () => 1_788_600_000_000,
  cacheTtlMs: 60_000,
});
const enriched = await enricher.enrichLaunchContext(context);
const systemd = enriched.origins.find((origin) => origin.type === 'systemd_unit');
assert.equal(systemd.description, 'Codex Agent Runtime');
assert.equal(systemd.unitFile, '/etc/systemd/system/codex-agent.service');
assert.equal(systemd.restartCount, 3);
assert.match(systemd.schedule, /codex-agent\.timer/u);
assert.match(systemd.schedule, /\*-\*-\* 06,18:00:00/u);

await enricher.enrichLaunchContext(context);
assert.equal(calls, 2, 'service and timer properties must be cached per unit');
assert.equal(enricher.metrics().cacheHits, 2);

console.log('Observer Launch Context and systemd enrichment verification passed.');
