#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AgentAttributor, containerIdFromCgroup } = require('./observer-agent-attribution.js');
const { ToolExecDeduper } = require('./observer-event-dedup.js');
const { InfrastructureRootResolver, staticRoots } = require('./observer-infrastructure-roots.js');

function observerEvent({ agent = 'process', pid, ppid, comm, exe, startTimeNs, cwd = '/workspace', argv = [] }) {
  return {
    identity: { agent, task: String(pid), session: null },
    process: { pid, ppid, comm, exe, startTimeNs, cwd },
    event: { ToolExec: { pid, ppid, uid: 1000, cwd, argv } },
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
    [850, { pid: 850, tgid: 850, ppid: 1, startTime: '85', comm: 'a3s', exe: '/usr/bin/a3s', argv: 'a3s code', cwd: '/home/user/code' }],
    [851, { pid: 851, tgid: 851, ppid: 850, startTime: '86', comm: 'bash', exe: '/usr/bin/bash', argv: 'bash', cwd: '/tmp' }],
  ]);
  const gitRoots = new Map([
    ['/home/user/code/AnySentry/apps/api', '/home/user/code/AnySentry'],
    ['/home/user/code/Observer/src', '/home/user/code/Observer'],
  ]);
  const judge = new AgentAttributor({
    now: () => 1_000_000,
    listPids: () => [...procs.keys()],
    readProc: (pid) => procs.get(pid),
    findWorkspaceRoot: (cwd) => gitRoots.get(cwd),
  });
  judge.seedFromProc();

  const temporaryChild = judge.classify(observerEvent({
    pid: 851,
    ppid: 850,
    comm: 'bash',
    exe: '/usr/bin/bash',
    startTimeNs: '86',
    cwd: '/tmp/agent-task',
    argv: ['bash'],
  }));
  assert.equal(temporaryChild.workspacePath, '/home/user/code');
  assert.equal(temporaryChild.workspaceSource, 'agent_root');

  const anySentryChild = judge.classify(observerEvent({
    pid: 851,
    ppid: 850,
    comm: 'bash',
    exe: '/usr/bin/bash',
    startTimeNs: '86',
    cwd: '/home/user/code/AnySentry/apps/api',
    argv: ['bash'],
  }));
  assert.equal(anySentryChild.workspacePath, '/home/user/code/AnySentry');
  assert.equal(anySentryChild.workspaceSource, 'event_git_root');
  assert.equal(anySentryChild.workspaceConflict, false);

  const observerChild = judge.classify(observerEvent({
    pid: 851,
    ppid: 850,
    comm: 'bash',
    exe: '/usr/bin/bash',
    startTimeNs: '86',
    cwd: '/home/user/code/Observer/src',
    argv: ['bash'],
  }));
  assert.equal(observerChild.workspacePath, '/home/user/code/Observer');
  assert.equal(observerChild.workspaceSource, 'event_git_root');

  const conflictedChild = judge.classify(observerEvent({
    pid: 851,
    ppid: 850,
    comm: 'bash',
    exe: '/usr/bin/bash',
    startTimeNs: '86',
    cwd: '/opt/unrelated-service',
    argv: ['bash'],
  }));
  assert.equal(conflictedChild.workspacePath, undefined);
  assert.equal(conflictedChild.workspaceSource, 'conflict');
  assert.equal(conflictedChild.workspaceConflict, true);
  assert.equal(conflictedChild.attribution.conflict, true);

  procs.delete(851);
  const conflictWithoutCwd = judge.classify(observerEvent({
    pid: 851,
    ppid: 850,
    comm: 'bash',
    exe: '/bin/echo',
    startTimeNs: '86',
    cwd: '',
    argv: ['/bin/echo', 'done'],
  }));
  assert.equal(conflictWithoutCwd.workspacePath, undefined);
  assert.equal(conflictWithoutCwd.workspaceSource, 'conflict');
  assert.equal(conflictWithoutCwd.workspaceConflict, true);
  assert.equal(conflictWithoutCwd.attribution.conflict, true);
}

{
  const procs = new Map([
    [900, { pid: 900, tgid: 900, ppid: 1, startTime: '90', comm: 'codex', exe: '/usr/bin/codex', argv: 'codex', cwd: '/repos/project-a' }],
    [901, { pid: 901, tgid: 901, ppid: 900, startTime: '91', comm: 'bash', exe: '/usr/bin/bash', argv: 'bash -lc sleep 30', cwd: '/tmp' }],
    [902, { pid: 902, tgid: 902, ppid: 901, startTime: '92', comm: 'python3', exe: '/usr/bin/python3', argv: 'python3 worker.py', cwd: '/tmp' }],
    [950, { pid: 950, tgid: 950, ppid: 1, startTime: '95', comm: 'bash', exe: '/usr/bin/bash', argv: 'echo codex status' }],
  ]);
  const judge = new AgentAttributor({
    now: () => 1_000_000,
    listPids: () => [...procs.keys()],
    readProc: (pid) => procs.get(pid),
  });
  assert.deepEqual(judge.seedFromProc(), {
    scanned: 4,
    roots: 1,
    descendants: 2,
    infrastructureRoots: 0,
    infrastructureDescendants: 0,
  });

  const existingDescendant = judge.classify(observerEvent({ pid: 902, ppid: 0, comm: 'python3', exe: '/usr/bin/python3', startTimeNs: '92', cwd: '', argv: [] }));
  assert.equal(existingDescendant.state, 'agent');
  assert.equal(existingDescendant.attribution.agentScopeId, 'codex');
  assert.equal(existingDescendant.attribution.rootPid, 900);
  assert.equal(existingDescendant.workspacePath, '/repos/project-a');

  assert.equal(judge.procs.get(950), undefined);

}

{
  const procs = new Map([
    [960, { pid: 960, tgid: 960, ppid: 1, startTime: '96', comm: 'codex', exe: '/usr/bin/codex', argv: 'codex', cwd: '/repos/codex-workspace' }],
    [961, { pid: 961, tgid: 961, ppid: 960, startTime: '97', comm: 'bash', exe: '/usr/bin/bash', argv: 'bash -lc true', cwd: '/tmp' }],
    [970, { pid: 970, tgid: 970, ppid: 1, startTime: '98', comm: 'a3s', exe: '/usr/bin/a3s', argv: 'a3s code', cwd: '/repos/a3s-workspace' }],
    [971, { pid: 971, tgid: 971, ppid: 970, startTime: '99', comm: 'bash', exe: '/usr/bin/bash', argv: 'bash -lc true', cwd: '/tmp' }],
  ]);
  const judge = new AgentAttributor({
    now: () => 1_000_000,
    listPids: () => [...procs.keys()],
    readProc: (pid) => procs.get(pid),
  });
  judge.seedFromProc();

  const codexChild = judge.classify(observerEvent({
    pid: 961,
    ppid: 960,
    comm: 'bash',
    exe: '/usr/bin/bash',
    startTimeNs: '97',
    cwd: '',
    argv: ['bash', '-lc', 'true'],
  }));
  const a3sChild = judge.classify(observerEvent({
    pid: 971,
    ppid: 970,
    comm: 'bash',
    exe: '/usr/bin/bash',
    startTimeNs: '99',
    cwd: '',
    argv: ['bash', '-lc', 'true'],
  }));
  assert.equal(codexChild.workspacePath, '/repos/codex-workspace');
  assert.equal(a3sChild.workspacePath, '/repos/a3s-workspace');
  assert.notEqual(codexChild.workspacePath, a3sChild.workspacePath);
}

{
  const procs = new Map([
    [1000, { pid: 1000, tgid: 1000, ppid: 1, startTime: '100', comm: 'java', exe: '/opt/java/bin/java', argv: 'kafka.Kafka' }],
    [1001, { pid: 1001, tgid: 1001, ppid: 1000, startTime: '101', comm: 'bash', exe: '/usr/bin/bash', argv: 'kafka-topics.sh --list' }],
    [1002, { pid: 1002, tgid: 1002, ppid: 1001, startTime: '102', comm: 'grep', exe: '/usr/bin/grep', argv: 'grep kafka' }],
  ]);
  const judge = new AgentAttributor({
    now: () => 1_000_000,
    listPids: () => [...procs.keys()],
    readProc: (pid) => procs.get(pid),
    infrastructureRoots: [{ pid: 1000, serviceName: 'kafka', containerId: 'abc123' }],
  });
  assert.deepEqual(judge.seedFromProc(), {
    scanned: 3,
    roots: 0,
    descendants: 0,
    infrastructureRoots: 1,
    infrastructureDescendants: 2,
  });

  const helper = judge.classify(observerEvent({
    pid: 1002,
    ppid: 1001,
    comm: 'grep',
    exe: '/usr/bin/grep',
    startTimeNs: '102',
    argv: ['grep', 'kafka'],
  }));
  assert.equal(helper.state, 'infrastructure');
  assert.equal(helper.serviceName, 'kafka');
  assert.equal(helper.containerId, 'abc123');

  const exitEvent = observerEvent({
    pid: 1002,
    ppid: 0,
    comm: 'grep',
    exe: '',
    startTimeNs: '102',
    argv: [],
  });
  exitEvent.event = { ProcessExit: { pid: 1002, exit_code: 0, signal: 0 } };
  const exited = judge.classify(exitEvent);
  assert.equal(exited.state, 'infrastructure');
  assert.equal(exited.serviceName, 'kafka');
}

{
  const containerId = 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
  assert.equal(
    containerIdFromCgroup(`0::/system.slice/docker-${containerId}.scope\n`),
    containerId,
  );
  const judge = new AgentAttributor({
    now: () => 1_000_000,
    readProc: () => undefined,
    infrastructureRoots: [{
      pid: 1100,
      serviceName: 'flink-taskmanager',
      containerId,
    }],
  });
  const healthcheck = observerEvent({
    pid: 1199,
    ppid: 9999,
    comm: 'bash',
    exe: '/usr/bin/bash',
    startTimeNs: '119',
    argv: ['bash', '-c', 'healthcheck'],
  });
  healthcheck.process.cgroup = `0::/system.slice/docker-${containerId}.scope`;
  const result = judge.classify(healthcheck);
  assert.equal(result.state, 'infrastructure');
  assert.equal(result.serviceName, 'flink-taskmanager');
  assert.equal(result.rootPid, 1100);
}

{
  assert.deepEqual(staticRoots('1200:kafka,1300:flink-taskmanager,bad'), [
    { pid: 1200, serviceName: 'kafka', source: 'environment' },
    { pid: 1300, serviceName: 'flink-taskmanager', source: 'environment' },
  ]);

  const listPath = `/containers/json?all=0&filters=${encodeURIComponent(JSON.stringify({ label: ['io.anysentry.observe=false'] }))}`;
  const resolver = new InfrastructureRootResolver({
    configuredRoots: [{ pid: 1400, serviceName: 'configured' }],
    fetchJson: async (requestPath) => {
      if (requestPath === listPath) {
        return [{ Id: 'abcdef1234567890', Names: ['/anysentry-kafka-1'], Labels: { 'io.anysentry.observe': 'false' } }];
      }
      if (requestPath === '/containers/abcdef1234567890/json') {
        return {
          State: { Pid: 1500, Running: true },
          Config: { Labels: { 'com.docker.compose.service': 'kafka' } },
        };
      }
      throw new Error(`unexpected Docker API path: ${requestPath}`);
    },
  });
  const resolved = await resolver.resolve();
  assert.equal(resolved.error, undefined);
  assert.equal(resolved.dockerContainers, 1);
  assert.deepEqual(resolved.roots, [
    { pid: 1400, serviceName: 'configured' },
    {
      pid: 1500,
      serviceName: 'kafka',
      containerId: 'abcdef1234567890',
      source: 'docker_label',
    },
  ]);
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

console.log('Forwarder attribution and deduplication verification passed.');
