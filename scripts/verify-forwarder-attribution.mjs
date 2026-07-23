#!/usr/bin/env node

import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { AgentAttributor } = require('./observer-agent-attribution.js');
const { ToolExecDeduper } = require('./observer-event-dedup.js');

function observerEvent({ agent = 'process', pid, ppid, comm, exe, startTimeNs, argv = [] }) {
  return {
    identity: { agent, task: String(pid), session: null },
    process: { pid, ppid, comm, exe, startTimeNs },
    event: { ToolExec: { pid, ppid, uid: 1000, cwd: '/workspace', argv } },
  };
}

function attributor(procEntries = []) {
  const procs = new Map(procEntries.map((entry) => [entry.pid, entry]));
  return new AgentAttributor({
    now: () => 1_000_000,
    readProc: (pid) => procs.get(pid),
  });
}

{
  const procs = new Map([
    [900, { pid: 900, tgid: 900, ppid: 1, startTime: '90', comm: 'codex', exe: '/usr/bin/codex', argv: 'codex' }],
    [901, { pid: 901, tgid: 901, ppid: 900, startTime: '91', comm: 'bash', exe: '/usr/bin/bash', argv: 'bash -lc sleep 30' }],
    [902, { pid: 902, tgid: 902, ppid: 901, startTime: '92', comm: 'python3', exe: '/usr/bin/python3', argv: 'python3 worker.py' }],
    [950, { pid: 950, tgid: 950, ppid: 1, startTime: '95', comm: 'bash', exe: '/usr/bin/bash', argv: 'echo codex status' }],
  ]);
  const judge = new AgentAttributor({
    now: () => 1_000_000,
    listPids: () => [...procs.keys()],
    readProc: (pid) => procs.get(pid),
  });
  assert.deepEqual(judge.seedFromProc(), { scanned: 4, roots: 1, descendants: 2 });

  const existingDescendant = judge.classify(observerEvent({ pid: 902, ppid: 0, comm: 'python3', exe: '/usr/bin/python3', startTimeNs: '92', argv: [] }));
  assert.equal(existingDescendant.state, 'agent');
  assert.equal(existingDescendant.attribution.agentScopeId, 'codex');
  assert.equal(existingDescendant.attribution.rootPid, 900);

  assert.equal(judge.procs.get(950), undefined);

}

{
  const judge = attributor();
  const root = judge.classify(observerEvent({ pid: 100, ppid: 1, comm: 'codex', exe: '/usr/local/bin/codex', startTimeNs: '10', argv: ['codex'] }));
  assert.equal(root.state, 'agent');
  assert.equal(root.attribution.agentScopeId, 'codex');

  const child = judge.classify(observerEvent({ pid: 101, ppid: 100, comm: 'bash', exe: '/usr/bin/bash', startTimeNs: '11', argv: ['bash', '-lc', 'rm /tmp/file'] }));
  assert.equal(child.state, 'agent');
  assert.equal(child.attribution.rootPid, 100);
  assert.equal(child.attribution.reason, 'process_lineage');
}

{
  const judge = attributor([
    { pid: 200, ppid: 1, startTime: '20', comm: 'systemd-worker', exe: '/usr/lib/systemd/systemd-worker', argv: '' },
    { pid: 201, ppid: 200, startTime: '21', comm: 'helper', exe: '/usr/bin/helper', argv: '' },
  ]);
  const result = judge.classify(observerEvent({ pid: 201, ppid: 200, comm: 'helper', exe: '/usr/bin/helper', startTimeNs: '21', argv: ['helper'] }));
  assert.equal(result.state, 'non_agent');
  assert.equal(result.attribution, undefined);
}

{
  const judge = attributor();
  const result = judge.classify(observerEvent({ pid: 301, ppid: 300, comm: 'short-task', exe: '/usr/bin/short-task', startTimeNs: '31', argv: ['short-task'] }));
  assert.equal(result.state, 'unknown');
  assert.equal(result.attribution.monitored, false);
  assert.equal(result.attribution.reason, 'not_evaluated');
}

{
  const judge = attributor();
  assert.equal(judge.classify(observerEvent({ pid: 400, ppid: 1, comm: 'codex', exe: '/usr/bin/codex', startTimeNs: 'old', argv: ['codex'] })).state, 'agent');
  const reused = judge.classify(observerEvent({ pid: 400, ppid: 1, comm: 'worker', exe: '/usr/bin/worker', startTimeNs: 'new', argv: ['worker'] }));
  assert.equal(reused.state, 'non_agent');
}

{
  const judge = attributor();
  const result = judge.classify(observerEvent({ pid: 500, ppid: 1, comm: 'tokio-rt-worker', exe: '/home/user/.local/bin/a3s', startTimeNs: '50', argv: [] }));
  assert.equal(result.state, 'agent');
  assert.equal(result.attribution.agentScopeId, 'a3s code');
}

{
  const judge = attributor();
  const prompt = 'Investigate runtime event. Actor: a3s code. Compare codex and claude code.';
  const result = judge.classify(observerEvent({
    pid: 550,
    ppid: 999,
    comm: 'node',
    exe: '/usr/local/bin/node',
    startTimeNs: '55',
    argv: ['node', '/opt/anysentry/l3-agent.mjs', '--json', '-p', prompt],
  }));
  assert.equal(result.state, 'unknown');
  assert.equal(result.attribution.agentScopeId, undefined);
}

{
  const judge = attributor();
  const result = judge.classify(observerEvent({
    pid: 560,
    ppid: 999,
    comm: 'launcher',
    exe: '/usr/bin/launcher',
    startTimeNs: '56',
    argv: ['/home/user/.local/bin/a3s', 'code'],
  }));
  assert.equal(result.state, 'agent');
  assert.equal(result.attribution.agentScopeId, 'a3s code');
}

{
  const judge = attributor([
    { pid: 700, tgid: 700, ppid: 1, startTime: '70', comm: 'a3s', exe: '/home/user/.local/bin/a3s', argv: 'a3s code' },
    { pid: 710, tgid: 700, ppid: 1, startTime: '70', comm: 'tokio-rt-worker', exe: '/usr/bin/worker', argv: '' },
    { pid: 711, tgid: 711, ppid: 710, startTime: '71', comm: 'bash', exe: '/usr/bin/bash', argv: "bash -c printf '%s'" },
  ]);
  const result = judge.classify(observerEvent({ pid: 711, ppid: 710, comm: 'bash', exe: '/usr/bin/bash', startTimeNs: '71', argv: ['bash', '-c', "printf '%s'"] }));
  assert.equal(result.state, 'agent');
  assert.equal(result.attribution.agentScopeId, 'a3s code');
  assert.equal(result.attribution.rootPid, 700);
  assert.equal(result.attribution.reason, 'process_lineage');
}

{
  const judge = attributor([
    { pid: 700, tgid: 700, ppid: 1, startTime: '70', comm: 'a3s', exe: '/home/user/.local/bin/a3s', argv: 'a3s code' },
    { pid: 710, tgid: 700, ppid: 1, startTime: '70', comm: 'tokio-rt-worker', exe: '/usr/bin/worker', argv: '' },
  ]);
  const exitEvent = observerEvent({ pid: 712, ppid: 1, comm: 'bash', exe: '/usr/bin/bash', startTimeNs: '', argv: [] });
  exitEvent.event = { ProcessExit: { pid: 712, exit_code: 0, signal: 0 } };
  assert.equal(judge.classify(exitEvent).state, 'non_agent');

  const execResult = judge.classify(observerEvent({ pid: 712, ppid: 710, comm: 'bash', exe: '/usr/bin/bash', startTimeNs: '', argv: ['bash', '-c', "printf '%s'"] }));
  assert.equal(execResult.state, 'agent');
  assert.equal(execResult.attribution.agentScopeId, 'a3s code');
  assert.equal(execResult.attribution.rootPid, 700);
}

{
  const judge = attributor();
  assert.equal(judge.classify(observerEvent({ pid: 600, ppid: 1, comm: 'codex', exe: '/usr/bin/codex', startTimeNs: '60', argv: ['codex'] })).state, 'agent');
  const exitEvent = observerEvent({ pid: 600, ppid: 1, comm: 'codex', exe: '/usr/bin/codex', startTimeNs: '60', argv: [] });
  exitEvent.event = { ProcessExit: { pid: 600, exit_code: 0, signal: 0 } };
  assert.equal(judge.classify(exitEvent).state, 'agent');
  const reused = judge.classify(observerEvent({ pid: 600, ppid: 999, comm: 'short-task', exe: '/usr/bin/short-task', startTimeNs: '', argv: ['short-task'] }));
  assert.equal(reused.state, 'unknown');
}

{
  let now = 1000;
  const deduper = new ToolExecDeduper({ windowMs: 5000, now: () => now });
  const event = observerEvent({ pid: 800, ppid: 700, comm: 'bash', exe: '/usr/bin/bash', argv: ['bash', '-c', 'echo one'] });
  assert.equal(deduper.isDuplicate(event), false);
  assert.equal(deduper.isDuplicate(event), true);

  const otherPid = observerEvent({ pid: 801, ppid: 700, comm: 'bash', exe: '/usr/bin/bash', argv: ['bash', '-c', 'echo one'] });
  assert.equal(deduper.isDuplicate(otherPid), false);
  const otherArgv = observerEvent({ pid: 800, ppid: 700, comm: 'bash', exe: '/usr/bin/bash', argv: ['bash', '-c', 'echo two'] });
  assert.equal(deduper.isDuplicate(otherArgv), false);

  now += 5001;
  assert.equal(deduper.isDuplicate(event), false);
}

{
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      requests.push({ path: req.url, body: JSON.parse(raw) });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"accepted":true}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');

  const child = spawn(process.execPath, [fileURLToPath(new URL('./observer-forward.js', import.meta.url))], {
    stdio: ['pipe', 'ignore', 'pipe'],
    env: {
      ...process.env,
      ANYSENTRY_INGEST_URL: `http://127.0.0.1:${address.port}/security-center/ingest`,
      ANYSENTRY_HEARTBEAT_SECS: '30',
      A3S_OBSERVER_COLLECTOR_ID: 'observer-test',
      FORWARD_SCOPE: 'all',
    },
  });
  let childError = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { childError += chunk; });
  child.stdin.end(`${JSON.stringify({
    event: {
      CollectorHeartbeat: {
        attached_probes: 8,
        enabled_features: ['exec', 'files', 'network'],
      },
    },
  })}\n`);
  const exitCode = await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error('forwarder test timed out')), 5000)),
  ]);
  server.close();
  assert.equal(exitCode, 0, childError);

  const heartbeat = requests
    .filter((request) => request.path === '/security-center/collectors/heartbeat')
    .map((request) => request.body)
    .find((body) => body.attachedProbes === 8);
  assert(heartbeat, 'forwarder heartbeat did not retain attachedProbes=8');
  assert.deepEqual(heartbeat.enabledFeatures, ['exec', 'files', 'network']);
}

console.log('Forwarder attribution and deduplication verification passed.');
