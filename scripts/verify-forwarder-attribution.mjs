#!/usr/bin/env node

import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { AgentAttributor, containerIdFromCgroup } = require('./observer-agent-attribution.js');
const { ToolExecDeduper } = require('./observer-event-dedup.js');
const { DiscoveryBudget, WorkloadIdentityCache } = require('./observer-workload-filter.js');
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
  assert.equal(judge.classify(late).state, 'agent', 'a late event reuses the matching process tombstone');
  const reused = judge.classify(observerEvent({ pid: 600, ppid: 999, comm: 'short-task', exe: '/usr/bin/short-task', startTimeNs: '', argv: ['short-task'] }));
  assert.equal(reused.state, 'unknown');
  now += 5_001;
  assert.equal(judge.metrics().tombstones, 0);
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
