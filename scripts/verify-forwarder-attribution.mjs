#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AgentAttributor } = require('./observer-agent-attribution.js');
const { ToolExecDeduper } = require('./observer-event-dedup.js');
const { DiscoveryBudget, WorkloadIdentityCache } = require('./observer-workload-filter.js');

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

  assert.equal(judge.procs.get(950)?.state, 'unknown');
  assert.equal(judge.metrics().bootstrapProcReads, 4);
  assert.equal(judge.metrics().fallbackProcReads, 0);
  assert.equal(judge.metrics().ancestryProcReads, 0);

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
