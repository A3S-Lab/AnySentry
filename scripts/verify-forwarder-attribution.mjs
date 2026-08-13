#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AgentAttributor, containerIdFromCgroup } = require('./observer-agent-attribution.js');
const { ToolExecDeduper } = require('./observer-event-dedup.js');
const { DiscoveryBudget, WorkloadIdentityCache } = require('./observer-workload-filter.js');
const { InfrastructureRootResolver, staticRoots } = require('./observer-infrastructure-roots.js');

function observerEvent({
  agent = 'process',
  pid,
  ppid,
  comm,
  exe,
  startTimeNs,
  hostId,
  bootId,
  cwd = '/workspace',
  argv = [],
}) {
  return {
    identity: { agent, task: String(pid), session: null },
    process: { pid, ppid, comm, exe, startTimeNs, hostId, bootId, cwd },
    event: { ToolExec: { pid, ppid, uid: 1000, cwd, argv } },
  };
}

function processExitEvent(options, exitCode = 0, signal = 0) {
  const event = observerEvent({ ...options, argv: [] });
  event.event = { ProcessExit: { pid: options.pid, exit_code: exitCode, signal } };
  return event;
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

  assert.equal(judge.procs.get(950)?.state, 'unknown');
  assert.equal(judge.metrics().bootstrapProcReads, 4);
  assert.equal(judge.metrics().fallbackProcReads, 0);
  assert.equal(judge.metrics().ancestryProcReads, 0);

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
  const procs = new Map([
    [580, { pid: 580, tgid: 580, ppid: 1, startTime: '58', comm: 'worker', exe: '/usr/bin/worker', argv: 'worker' }],
  ]);
  const judge = new AgentAttributor({
    now: () => 1_000_000,
    readProc: (pid) => procs.get(pid),
  });
  const routine = observerEvent({
    pid: 580,
    ppid: undefined,
    comm: 'worker',
    exe: '/usr/bin/worker',
    startTimeNs: '58',
  });
  routine.event = { FileAccess: { pid: 580, path: '/workspace/result.txt', write: false } };
  assert.equal(judge.classify(routine).state, 'non_agent');
  assert.equal(judge.metrics().procReads, 1);
  assert.equal(judge.classify(routine).state, 'non_agent');
  assert.equal(judge.metrics().procReads, 1, 'a warm negative classification must not reread /proc');
  assert.equal(judge.metrics().cacheHits, 1);
}

{
  const procs = new Map([
    [800, { pid: 800, tgid: 800, ppid: 1, startTime: '80', comm: 'worker', exe: '/usr/bin/worker', argv: 'worker' }],
  ]);
  const judge = new AgentAttributor({
    now: () => 1_000_000,
    readProc: (pid) => procs.get(pid),
  });
  const first = judge.classify(observerEvent({
    pid: 801,
    ppid: 800,
    comm: 'helper',
    exe: '/usr/bin/helper',
    startTimeNs: '81',
    argv: ['helper'],
  }));
  assert.equal(first.state, 'non_agent');
  assert.equal(judge.metrics().ancestryProcReads, 1);
  const sibling = judge.classify(observerEvent({
    pid: 802,
    ppid: 800,
    comm: 'helper',
    exe: '/usr/bin/helper',
    startTimeNs: '82',
    argv: ['helper'],
  }));
  assert.equal(sibling.state, 'non_agent');
  assert.equal(
    judge.metrics().ancestryProcReads,
    1,
    'a recent cached parent chain must not reread /proc for every sibling event',
  );
}

{
  const judge = new AgentAttributor({
    now: () => 1_000_000,
    readProc: () => {
      throw new Error('complete numeric Observer process facts must not read /proc');
    },
  });
  const numericFacts = observerEvent({
    pid: 820,
    ppid: 1,
    comm: 'worker',
    exe: '/usr/bin/worker',
    startTimeNs: 82,
    argv: ['worker'],
  });
  numericFacts.process.cgroupId = 42;
  assert.equal(judge.classify(numericFacts).state, 'non_agent');
  assert.equal(judge.classify(numericFacts).state, 'non_agent');
  assert.equal(judge.metrics().cacheHits, 1);
  assert.equal(judge.metrics().procReads, 0);
}

{
  const judge = attributor([
    { pid: 200, ppid: 1, startTime: '20', comm: 'systemd-worker', exe: '/usr/lib/systemd/systemd-worker', argv: '' },
    { pid: 201, ppid: 200, startTime: '21', comm: 'helper', exe: '/usr/bin/helper', argv: '' },
  ]);
  const result = judge.classify(observerEvent({ pid: 201, ppid: 200, comm: 'helper', exe: '/usr/bin/helper', startTimeNs: '21', argv: ['helper'] }));
  assert.equal(result.state, 'non_agent');
  assert.equal(result.attribution.classification, 'non_agent');
  assert.equal(result.attribution.source, 'process_graph');
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
  let now = 1_000_000;
  const judge = new AgentAttributor({
    now: () => now,
    readProc: () => undefined,
    tombstoneTtlMs: 5_000,
  });
  assert.equal(judge.classify(observerEvent({ pid: 600, ppid: 1, comm: 'codex', exe: '/usr/bin/codex', startTimeNs: '60', argv: ['codex'] })).state, 'agent');
  const exitEvent = observerEvent({ pid: 600, ppid: 1, comm: 'codex', exe: '/usr/bin/codex', startTimeNs: '60', argv: [] });
  exitEvent.event = { ProcessExit: { pid: 600, exit_code: 0, signal: 0 } };
  assert.equal(judge.classify(exitEvent).state, 'agent');
  assert.equal(judge.metrics().tombstones, 1);
  const late = observerEvent({ pid: 600, ppid: 999, comm: 'bash', exe: '/usr/bin/bash', startTimeNs: '60', argv: ['bash', '-c', 'echo late'] });
  assert.notEqual(
    judge.classify(late).state,
    'agent',
    'a root tombstone may deduplicate ProcessExit but must not revive the exited subtree',
  );
  const reused = judge.classify(observerEvent({ pid: 600, ppid: 999, comm: 'short-task', exe: '/usr/bin/short-task', startTimeNs: '', argv: ['short-task'] }));
  assert.equal(reused.state, 'unknown');
  now += 5_001;
  assert.equal(judge.metrics().tombstones, 0);
}

{
  const judge = new AgentAttributor({
    hostId: 'host-a',
    bootId: 'boot-a',
    readProc: () => undefined,
    listPids: () => [],
  });
  const base = { hostId: 'host-a', bootId: 'boot-a', pid: 2_000, startTime: '200' };
  const processKeys = new Set([
    judge.processKey(base),
    judge.processKey({ ...base, hostId: 'host-b' }),
    judge.processKey({ ...base, bootId: 'boot-b' }),
    judge.processKey({ ...base, pid: 2_001 }),
    judge.processKey({ ...base, startTime: '201' }),
  ]);
  assert.equal(
    processKeys.size,
    5,
    'host, boot, pid, and start time must each isolate a ProcessKey',
  );
  assert.equal(judge.processKey({ ...base, startTime: '' }), undefined);
}

{
  const judge = new AgentAttributor({
    hostId: 'host-two-roots',
    bootId: 'boot-two-roots',
    now: () => 2_000_000,
    readProc: () => undefined,
    listPids: () => [],
  });
  const first = judge.classify(observerEvent({
    pid: 2_100,
    ppid: 1,
    comm: 'codex',
    exe: '/usr/bin/codex',
    startTimeNs: '210',
    cwd: '/workspace/first',
    argv: ['codex'],
  }));
  const second = judge.classify(observerEvent({
    pid: 2_200,
    ppid: 1,
    comm: 'codex',
    exe: '/usr/bin/codex',
    startTimeNs: '220',
    cwd: '/workspace/second',
    argv: ['codex'],
  }));
  assert.equal(first.state, 'agent');
  assert.equal(second.state, 'agent');
  assert.equal(first.attribution.agentScopeId, 'codex');
  assert.equal(second.attribution.agentScopeId, 'codex');
  assert.ok(first.attribution.agentInstanceId, 'a discovered root must expose an instance ID');
  assert.ok(second.attribution.agentInstanceId, 'a discovered root must expose an instance ID');
  assert.notEqual(
    first.attribution.agentInstanceId,
    second.attribution.agentInstanceId,
    'two roots of the same Agent scope must remain separate instances',
  );
  assert.notEqual(first.attribution.rootKey, second.attribution.rootKey);
  assert.equal(judge.runtimeSnapshot().entries.filter((entry) => entry.agentScopeId === 'codex').length, 2);
}

{
  let now = 3_000_000;
  const judge = new AgentAttributor({
    hostId: 'host-generation',
    bootId: 'boot-generation',
    now: () => now,
    readProc: () => undefined,
    listPids: () => [],
  });
  const rootAEvent = {
    pid: 2_300,
    ppid: 1,
    comm: 'codex',
    exe: '/usr/bin/codex',
    startTimeNs: '230',
    cwd: '/workspace/root-a',
  };
  const rootBEvent = {
    pid: 2_400,
    ppid: 1,
    comm: 'codex',
    exe: '/usr/bin/codex',
    startTimeNs: '240',
    cwd: '/workspace/root-b',
  };
  const rootA = judge.classify(observerEvent({ ...rootAEvent, argv: ['codex'] }));
  const rootB = judge.classify(observerEvent({ ...rootBEvent, argv: ['codex'] }));
  const childAEvent = {
    pid: 2_301,
    ppid: 2_300,
    comm: 'bash',
    exe: '/usr/bin/bash',
    startTimeNs: '231',
    cwd: '/workspace/root-a',
    argv: ['bash', '-lc', 'echo first'],
  };
  const childBEvent = {
    pid: 2_401,
    ppid: 2_400,
    comm: 'bash',
    exe: '/usr/bin/bash',
    startTimeNs: '241',
    cwd: '/workspace/root-b',
    argv: ['bash', '-lc', 'echo second'],
  };
  const childA = judge.classify(observerEvent(childAEvent));
  const childB = judge.classify(observerEvent(childBEvent));
  assert.equal(childA.attribution.agentInstanceId, rootA.attribution.agentInstanceId);
  assert.equal(childB.attribution.agentInstanceId, rootB.attribution.agentInstanceId);

  const childABinding = judge.procs.get(2_301);
  const rootABeforeExit = judge.rootsByKey.get(rootA.attribution.rootKey);
  assert.equal(childABinding.rootGeneration, rootABeforeExit.generation);

  now += 10;
  const exited = judge.classify(processExitEvent(rootAEvent, 17, 0));
  assert.equal(exited.attribution.agentInstanceId, rootA.attribution.agentInstanceId);
  const rootAAfterExit = judge.rootsByKey.get(rootA.attribution.rootKey);
  assert.equal(rootAAfterExit.runtimeState, 'exited');
  assert.ok(rootAAfterExit.generation > childABinding.rootGeneration);

  const staleMissesBefore = judge.metrics().staleGenerationMisses;
  const orphanedChild = judge.classify(observerEvent({
    ...childAEvent,
    argv: ['bash', '-lc', 'echo after-root-exit'],
  }));
  assert.notEqual(
    orphanedChild.attribution?.agentInstanceId,
    rootA.attribution.agentInstanceId,
    'a descendant must not hit an exited root generation',
  );
  assert.ok(judge.metrics().staleGenerationMisses > staleMissesBefore);

  const unaffectedChild = judge.classify(observerEvent({
    ...childBEvent,
    argv: ['bash', '-lc', 'echo root-b-still-running'],
  }));
  assert.equal(unaffectedChild.state, 'agent');
  assert.equal(unaffectedChild.attribution.agentInstanceId, rootB.attribution.agentInstanceId);
  assert.equal(
    judge.runtimeSnapshot().entries.find(
      (entry) => entry.agentInstanceId === rootB.attribution.agentInstanceId,
    )?.runtimeState,
    'running',
  );
}

{
  let now = 4_000_000;
  const liveStartTimes = new Map([[2_500, '250']]);
  const judge = new AgentAttributor({
    hostId: 'host-lost',
    bootId: 'boot-lost',
    now: () => now,
    readProc: () => undefined,
    readStartTime: (pid) => liveStartTimes.get(pid),
    livenessMissThreshold: 2,
    listPids: () => [],
  });
  const root = judge.classify(observerEvent({
    pid: 2_500,
    ppid: 1,
    comm: 'pi',
    exe: '/usr/bin/node',
    startTimeNs: '250',
    argv: ['pi'],
  }));
  const initialGeneration = root.attribution.rootGeneration;
  liveStartTimes.delete(2_500);

  now += 5_000;
  assert.deepEqual(judge.checkRootLiveness(), { checked: 1, lost: 0, checkedAt: now });
  assert.equal(
    judge.runtimeSnapshot().entries.find(
      (entry) => entry.agentInstanceId === root.attribution.agentInstanceId,
    )?.runtimeState,
    'running',
    'one missing liveness read is only suspect, not lost',
  );

  now += 5_000;
  assert.deepEqual(judge.checkRootLiveness(), { checked: 1, lost: 1, checkedAt: now });
  const lost = judge.runtimeSnapshot().entries.find(
    (entry) => entry.agentInstanceId === root.attribution.agentInstanceId,
  );
  assert.equal(lost.runtimeState, 'lost');
  assert.equal(lost.activityState, undefined);
  assert.ok(lost.rootGeneration > initialGeneration);
  assert.equal(judge.metrics().rootsLost, 1);

  liveStartTimes.set(2_500, '250');
  now += 1;
  const recovered = judge.classify(observerEvent({
    pid: 2_500,
    ppid: 1,
    comm: 'pi',
    exe: '/usr/bin/node',
    startTimeNs: '250',
    argv: ['pi'],
  }));
  assert.equal(recovered.state, 'agent');
  assert.equal(recovered.attribution.agentInstanceId, root.attribution.agentInstanceId);
  assert.ok(recovered.attribution.rootGeneration > lost.rootGeneration);
  assert.equal(
    judge.runtimeSnapshot().entries.find(
      (entry) => entry.agentInstanceId === root.attribution.agentInstanceId,
    )?.runtimeState,
    'running',
    'a lost root may recover only when the same complete ProcessKey is observed again',
  );
  assert.equal(judge.metrics().rootsRecovered, 1);
}

{
  let now = 5_000_000;
  let observedStart = '260';
  const judge = new AgentAttributor({
    hostId: 'host-pid-reuse',
    bootId: 'boot-pid-reuse',
    now: () => now,
    readProc: () => undefined,
    readStartTime: () => observedStart,
    livenessMissThreshold: 2,
    listPids: () => [],
  });
  const oldRoot = judge.classify(observerEvent({
    pid: 2_600,
    ppid: 1,
    comm: 'codex',
    exe: '/usr/bin/codex',
    startTimeNs: '260',
    argv: ['codex'],
  }));
  observedStart = '261';
  now += 1;
  const reusedRoot = judge.classify(observerEvent({
    pid: 2_600,
    ppid: 1,
    comm: 'codex',
    exe: '/usr/bin/codex',
    startTimeNs: '261',
    argv: ['codex'],
  }));
  assert.notEqual(reusedRoot.attribution.rootKey, oldRoot.attribution.rootKey);
  assert.notEqual(reusedRoot.attribution.agentInstanceId, oldRoot.attribution.agentInstanceId);
  assert.equal(judge.checkRootLiveness().lost, 1, 'a reused PID invalidates the old root immediately');
  const snapshot = judge.runtimeSnapshot().entries;
  assert.equal(
    snapshot.find((entry) => entry.agentInstanceId === oldRoot.attribution.agentInstanceId)?.runtimeState,
    'lost',
  );
  assert.equal(
    snapshot.find((entry) => entry.agentInstanceId === reusedRoot.attribution.agentInstanceId)?.runtimeState,
    'running',
  );
}

{
  let now = 6_000_000;
  const liveStartTimes = new Map([
    [2_700, '270'],
    [2_800, '280'],
  ]);
  const judge = new AgentAttributor({
    hostId: 'host-runtime-snapshot',
    bootId: 'boot-runtime-snapshot',
    now: () => now,
    readProc: () => undefined,
    readStartTime: (pid) => liveStartTimes.get(pid),
    livenessMissThreshold: 2,
    activityIdleMs: 1_000,
    listPids: () => [],
  });
  const exitedRootEvent = {
    pid: 2_700,
    ppid: 1,
    comm: 'Kimi Code',
    exe: '/usr/bin/python3',
    startTimeNs: '270',
    argv: ['Kimi Code'],
  };
  const exitedRoot = judge.classify(observerEvent(exitedRootEvent));
  const lostRoot = judge.classify(observerEvent({
    pid: 2_800,
    ppid: 1,
    comm: 'pi',
    exe: '/usr/bin/node',
    startTimeNs: '280',
    argv: ['pi'],
  }));

  let snapshot = judge.runtimeSnapshot();
  assert.equal(
    snapshot.entries.find((entry) => entry.agentInstanceId === exitedRoot.attribution.agentInstanceId)?.activityState,
    'active',
  );
  assert.equal(
    snapshot.entries.find((entry) => entry.agentInstanceId === lostRoot.attribution.agentInstanceId)?.activityState,
    'active',
  );

  now += 1_001;
  snapshot = judge.runtimeSnapshot();
  assert.equal(
    snapshot.entries.find((entry) => entry.agentInstanceId === exitedRoot.attribution.agentInstanceId)?.activityState,
    'idle',
  );
  assert.equal(
    snapshot.entries.find((entry) => entry.agentInstanceId === lostRoot.attribution.agentInstanceId)?.activityState,
    'idle',
  );

  now += 1;
  judge.classify(processExitEvent(exitedRootEvent, 0, 15));
  liveStartTimes.delete(2_800);
  judge.checkRootLiveness();
  now += 5_000;
  judge.checkRootLiveness();
  snapshot = judge.runtimeSnapshot();
  const exited = snapshot.entries.find(
    (entry) => entry.agentInstanceId === exitedRoot.attribution.agentInstanceId,
  );
  const lost = snapshot.entries.find(
    (entry) => entry.agentInstanceId === lostRoot.attribution.agentInstanceId,
  );
  assert.equal(exited.runtimeState, 'exited');
  assert.equal(exited.activityState, undefined);
  assert.equal(exited.exitCode, 0);
  assert.equal(exited.signal, 15);
  assert.ok(exited.endedAt);
  assert.equal(lost.runtimeState, 'lost');
  assert.equal(lost.activityState, undefined);
  assert.ok(lost.endedAt);
}

{
  const judge = new AgentAttributor({
    hostId: 'host-runtime-placement',
    bootId: 'boot-runtime-placement',
    now: () => 6_500_000,
    readProc: () => undefined,
    listPids: () => [],
  });
  const processResult = judge.classify(observerEvent({
    pid: 2_900,
    ppid: 1,
    comm: 'codex',
    exe: '/usr/bin/codex',
    startTimeNs: '290',
    argv: ['codex'],
  }));
  assert.equal(judge.enrichRuntimeRoot(processResult, {
    state: 'agent',
    attribution: {
      monitored: true,
      classification: 'confirmed_agent',
      agentScopeId: 'workload-codex',
      agentInstanceId: 'pod-a/container-a',
      physicalWorkloadId: 'k8s:cluster-a:pod-a:container-a',
      workloadRef: {
        environment: 'kubernetes',
        kind: 'pod',
        namespace: 'agents',
        podName: 'codex-a',
      },
      confidence: 1,
      source: 'kubernetes',
      conflict: true,
      evidence: ['identity_conflict:agentScopeId'],
    },
  }), true);
  const runtime = judge.runtimeSnapshot().entries[0];
  assert.equal(
    runtime.agentInstanceId,
    processResult.attribution.agentInstanceId,
    'workload enrichment must not replace the ProcessKey-derived runtime instance ID',
  );
  assert.equal(runtime.agentScopeId, 'codex');
  assert.equal(runtime.classification, 'confirmed_agent');
  assert.equal(runtime.physicalWorkloadId, 'k8s:cluster-a:pod-a:container-a');
  assert.equal(runtime.source, 'kubernetes');
  assert.deepEqual(runtime.workloadRef, {
    environment: 'kubernetes',
    kind: 'pod',
    namespace: 'agents',
    podName: 'codex-a',
  });
  assert.ok(runtime.evidence.includes('identity_conflict:agentScopeId'));
}

{
  const procs = new Map(Array.from({ length: 260 }, (_, index) => {
    const pid = 3_000 + index;
    return [pid, {
      pid,
      tgid: pid,
      ppid: 1,
      startTime: String(pid * 10),
      comm: index === 259 ? 'codex' : 'worker',
      exe: index === 259 ? '/usr/bin/codex' : '/usr/bin/worker',
      argv: index === 259 ? 'codex' : 'worker',
      cwd: '/workspace',
    }];
  }));
  let yields = 0;
  const judge = new AgentAttributor({
    hostId: 'host-batched-reconcile',
    bootId: 'boot-batched-reconcile',
    now: () => 7_000_000,
    listPids: () => [...procs.keys()],
    readProc: (pid) => procs.get(pid),
  });
  const result = await judge.reconcileFromProcBatched({
    batchSize: 64,
    yieldNow: async () => { yields += 1; },
  });
  assert.equal(result.scanned, 260);
  assert.equal(result.roots, 1);
  assert.ok(yields >= 8, 'large reconciliation must yield between read and attribution batches');
  assert.equal(judge.runtimeSnapshot().entries[0]?.agentScopeId, 'codex');
}

{
  const noBuiltinHints = new AgentAttributor({
    builtinHintsEnabled: false,
    rootNames: '',
    readProc: () => undefined,
    listPids: () => [],
  });
  const a3sCode = noBuiltinHints.classify(observerEvent({
    pid: 880,
    ppid: 1,
    comm: 'a3s',
    exe: '/usr/local/bin/a3s',
    argv: ['a3s', 'code'],
  }));
  const claudeCode = noBuiltinHints.classify(observerEvent({
    pid: 881,
    ppid: 1,
    comm: 'claude',
    exe: '/usr/local/bin/claude',
    argv: ['claude', 'code'],
  }));
  assert.notEqual(a3sCode.state, 'agent', 'a3s code must not match when built-in hints are disabled');
  assert.notEqual(claudeCode.state, 'agent', 'Claude Code must not match when built-in hints are disabled');
}

{
  const cache = new WorkloadIdentityCache({ now: () => 10_000 });
  assert.equal(cache.replace({
    schemaVersion: 'anysentry.workload_identity_snapshot.v1',
    version: 7,
    generatedAt: '2026-07-29T00:00:00.000Z',
    ready: true,
    errors: 0,
    entries: [
      {
        ids: ['agent-container-full', 'agent-contai'],
        classification: 'confirmed_agent',
        physicalWorkloadId: 'k8s:test:pod-1:agent-container-full',
        agentScopeId: 'claw-agent',
        agentDisplayName: 'claw-agent',
        agentInstanceId: 'pod-1/agent-container-full',
        source: 'kubernetes',
        environment: 'kubernetes',
        namespace: 'research',
        podName: 'research-agent-7b8d9',
        podUid: 'pod-1',
        nodeName: 'node-a',
        containerName: 'agent',
        containerImage: 'company/research-agent:latest',
        evidence: ['label:anysentry.io/workload-kind=agent'],
      },
      {
        ids: ['sidecar-container-full', 'sidecar-cont'],
        classification: 'non_agent',
        physicalWorkloadId: 'k8s:test:pod-1:sidecar-container-full',
        evidence: ['container:agent'],
      },
    ],
  }), true);

  const genericAgent = observerEvent({
    agent: 'pod-1',
    pid: 901,
    ppid: 1,
    comm: 'node',
    exe: '/usr/bin/node',
    startTimeNs: '901',
    argv: ['node', 'server.js'],
  });
  genericAgent.identity.session = 'agent-container-full';
  genericAgent.process.cgroup = '0::/kubepods/podpod-1/agent-container-full';
  const agentResult = cache.classify(genericAgent);
  assert.equal(agentResult.state, 'agent');
  assert.equal(agentResult.attribution.classification, 'confirmed_agent');
  assert.equal(agentResult.attribution.agentScopeId, 'claw-agent');
  assert.deepEqual(agentResult.attribution.workloadRef, {
    environment: 'kubernetes',
    kind: 'pod',
    name: 'research-agent-7b8d9',
    namespace: 'research',
    podName: 'research-agent-7b8d9',
    podUid: 'pod-1',
    nodeName: 'node-a',
    containerName: 'agent',
    containerImage: 'company/research-agent:latest',
  });
  assert.equal(cache.classify(structuredClone(genericAgent)).state, 'agent');
  assert.equal(cache.metrics().cgroupHits, 1, 'a stable cgroup must use its direct identity binding');

  const sidecar = structuredClone(genericAgent);
  sidecar.identity.session = 'sidecar-container-full';
  const sidecarResult = cache.classify(sidecar);
  assert.equal(sidecarResult.state, 'non_agent');
  assert.equal(sidecarResult.attribution.classification, 'non_agent');
  assert.equal(cache.metrics().hits, 3);
}

{
  const cache = new WorkloadIdentityCache();
  const containerEvent = observerEvent({
    agent: 'pod-unknown',
    pid: 910,
    ppid: 1,
    comm: 'codex',
    exe: '/usr/bin/codex',
    argv: ['codex'],
  });
  containerEvent.identity.session = 'missing-container';
  containerEvent.process.cgroup = '0::/kubepods/podpod-unknown/missing-container';
  const result = cache.classify(containerEvent);
  assert.equal(result.state, 'unknown');
  assert.equal(result.attribution.degraded, true);
  assert.equal(result.attribution.evidence[0], 'workload_snapshot:not_ready');

  const hostEvent = observerEvent({
    pid: 911,
    ppid: 1,
    comm: 'codex',
    exe: '/usr/bin/codex',
    argv: ['codex'],
  });
  assert.equal(cache.classify(hostEvent), undefined);
}

{
  let now = 1_000;
  const budget = new DiscoveryBudget({ limit: 2, windowMs: 1_000, now: () => now });
  const fileEvent = observerEvent({
    agent: 'pod-budget',
    pid: 920,
    ppid: 1,
    comm: 'worker',
    exe: '/usr/bin/worker',
  });
  fileEvent.identity.session = 'container-budget';
  fileEvent.event = { FileAccess: { pid: 920, path: '/tmp/a', write: true } };
  assert.equal(budget.allow(fileEvent), true);
  assert.equal(budget.allow(fileEvent), true);
  assert.equal(budget.allow(fileEvent), false);
  now += 1_001;
  assert.equal(budget.allow(fileEvent), true);
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
