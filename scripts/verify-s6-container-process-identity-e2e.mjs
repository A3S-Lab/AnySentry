#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { readFile, readlink } from 'node:fs/promises';
import { promisify } from 'node:util';

import { buildToolEvidenceBundle } from '../apps/api/dist/security-monitoring/tool-evidence-linker.js';

const execFile = promisify(execFileCallback);
const image = process.env.ANYSENTRY_S6_AGENT_IMAGE ?? 'anysentry-agent-runtime-lab:s6-audit';
const containerName = `anysentry-s6-pidns-${process.pid}-${randomUUID().slice(0, 8)}`;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseStat(value) {
  const close = value.lastIndexOf(')');
  const fields = close >= 0 ? value.slice(close + 1).trim().split(/\s+/u) : [];
  return { ppid: Number(fields[1]), startTimeTicks: fields[19] };
}

function pidNamespace(value) {
  return value.match(/^pid:\[(\d+)\]$/u)?.[1];
}

function namespacePid(status) {
  const line = status.split(/\r?\n/u).find((item) => item.startsWith('NSpid:'));
  const value = Number(line?.slice('NSpid:'.length).trim().split(/\s+/u).at(-1));
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

async function hostProcess(pid) {
  try {
    const [stat, status, namespace, children] = await Promise.all([
      readFile(`/proc/${pid}/stat`, 'utf8'),
      readFile(`/proc/${pid}/status`, 'utf8'),
      readlink(`/proc/${pid}/ns/pid`),
      readFile(`/proc/${pid}/task/${pid}/children`, 'utf8'),
    ]);
    const parsed = parseStat(stat);
    return {
      pid,
      ppid: parsed.ppid,
      startTimeTicks: parsed.startTimeTicks,
      pidNamespace: pidNamespace(namespace),
      namespacePid: namespacePid(status),
      children: children.trim().split(/\s+/u).filter(Boolean).map(Number),
    };
  } catch (error) {
    if (error?.code !== 'EACCES' && error?.code !== 'EPERM') throw error;
    // Some hosts apply procfs ptrace restrictions to the invoking user. The production Observer is
    // privileged with hostPID, so model that exact read boundary in a short-lived helper container.
    const program = `
      import { readFile, readlink } from 'node:fs/promises';
      const pid = ${pid};
      const [stat, status, namespace, children] = await Promise.all([
        readFile('/proc/' + pid + '/stat', 'utf8'),
        readFile('/proc/' + pid + '/status', 'utf8'),
        readlink('/proc/' + pid + '/ns/pid'),
        readFile('/proc/' + pid + '/task/' + pid + '/children', 'utf8'),
      ]);
      console.log(JSON.stringify({ stat, status, namespace, children }));
    `;
    const { stdout } = await execFile('docker', [
      'run', '--rm', '--privileged', '--pid', 'host', '--user', '0', '--entrypoint', 'node', image,
      '--input-type=module', '-e', program,
    ]);
    const raw = JSON.parse(stdout.trim());
    const parsed = parseStat(raw.stat);
    return {
      pid,
      ppid: parsed.ppid,
      startTimeTicks: parsed.startTimeTicks,
      pidNamespace: pidNamespace(raw.namespace),
      namespacePid: namespacePid(raw.status),
      children: raw.children.trim().split(/\s+/u).filter(Boolean).map(Number),
    };
  }
}

const adapterCorrelation = (invocationId, toolCallId) => ({
  schemaVersion: 'anysentry.trusted_correlation.v1',
  identityVersion: 'trusted_correlation.v1',
  method: 'agent_adapter',
  scope: 'invocation',
  confidence: 1,
  authority: 'authenticated_agent_adapter',
  inferred: false,
  traceOrigin: 'adapter',
  provenance: ['source_authenticated', 'source_scope_bound', 'adapter_invocation', 'adapter_tool_call'],
  claimReceipts: [{ kind: 'agent_adapter', decision: 'accepted', reason: 'authorized' }],
  invocationId,
  toolCallId,
});

const observerCorrelation = {
  schemaVersion: 'anysentry.trusted_correlation.v1',
  identityVersion: 'trusted_correlation.v1',
  method: 'runtime_root',
  scope: 'runtime',
  confidence: 1,
  authority: 'attested_observer',
  inferred: false,
  traceOrigin: 'none',
  provenance: ['runtime_root_key', 'process_tuple'],
  agentRootInstanceId: `agent-root:v1:${'a'.repeat(64)}`,
  processInstanceId: `pri_${'b'.repeat(24)}`,
};

function judgedEvent(overrides) {
  return {
    schemaVersion: 'anysentry.agent_event.v1',
    eventId: overrides.eventId,
    at: overrides.at,
    eventKind: overrides.eventKind,
    eventCategory: overrides.eventCategory,
    source: overrides.source,
    subject: overrides.eventKind,
    workspacePath: '/workspace',
    agentId: 'pi',
    sessionId: 'docker-s6',
    userId: 'user',
    traceId: 'legacy-trace',
    spanId: overrides.spanId ?? 'span',
    runId: 'run',
    verdict: 'allow',
    tier: 'Rules',
    severity: 'info',
    reason: 'fixture',
    riskCategory: 'other',
    riskName: 'Other',
    riskType: 'atomic',
    riskScore: 0,
    tokenCount: 0,
    latencyMs: 1,
    attributes: overrides.attributes ?? {},
    process: overrides.process,
    attribution: overrides.attribution,
    invocationId: overrides.invocationId,
    toolCallId: overrides.toolCallId,
  };
}

function toolPair(process, invocationId, toolCallId, toolName, start, end, attributes) {
  const correlation = adapterCorrelation(invocationId, toolCallId);
  const common = {
    eventKind: 'AgentTool',
    eventCategory: 'tool',
    source: 'api',
    process,
    invocationId,
    toolCallId,
    attribution: { monitored: true, confidence: 1, reason: 'human_confirmed', source: 'manual_review', correlation },
  };
  return [
    judgedEvent({ ...common, eventId: `${toolCallId}-start`, at: start, attributes: { ...attributes, 'anysentry.lifecycle.phase': 'start', 'gen_ai.tool.name': toolName } }),
    judgedEvent({ ...common, eventId: `${toolCallId}-end`, at: end, attributes: { ...attributes, 'anysentry.lifecycle.phase': 'end', 'gen_ai.tool.name': toolName } }),
  ];
}

let created = false;
try {
  const containerProgram = `
    import { spawn } from 'node:child_process';
    import { __testing } from '/opt/agent-lab/app/anysentry-pi-adapter.mjs';
    const facts = await __testing.processFacts();
    const child = spawn('/bin/bash', ['-c', 'sleep 120'], { stdio: 'ignore' });
    console.log(JSON.stringify({ facts, childNamespacePid: child.pid }));
    setInterval(() => {}, 60000);
  `;
  await execFile('docker', [
    'run', '--detach', '--name', containerName, '--entrypoint', 'node', image,
    '--input-type=module', '-e', containerProgram,
  ]);
  created = true;

  let payload;
  for (let attempt = 0; attempt < 100 && !payload; attempt += 1) {
    const { stdout } = await execFile('docker', ['logs', containerName]);
    const line = stdout.split(/\r?\n/u).find((item) => item.startsWith('{'));
    if (line) payload = JSON.parse(line);
    else await sleep(50);
  }
  assert(payload?.facts, 'container adapter process facts are available');
  const { stdout: inspected } = await execFile('docker', ['inspect', '--format', '{{.State.Pid}}', containerName]);
  const hostPid = Number(inspected.trim());
  assert(Number.isSafeInteger(hostPid) && hostPid > 0);

  const hostRoot = await hostProcess(hostPid);
  const children = hostRoot.children;
  assert(children.length >= 1, 'container root has the real bash/sleep direct child');
  const hostChild = await hostProcess(children[0]);
  hostChild.namespacePpid = hostRoot.namespacePid;

  assert.notEqual(payload.facts.pid, hostPid, 'Docker uses a different inner and host PID');
  assert.equal(payload.facts.pidNamespace, hostRoot.pidNamespace);
  assert.equal(payload.facts.namespacePid, hostRoot.namespacePid);
  assert.equal(payload.facts.startTimeTicks, hostRoot.startTimeTicks);
  assert.equal(payload.childNamespacePid, hostChild.namespacePid);
  assert.equal(hostChild.pidNamespace, hostRoot.pidNamespace);

  const adapterProcess = {
    hostId: payload.facts.hostId,
    bootId: payload.facts.bootId,
    pid: payload.facts.pid,
    ppid: 0,
    startTimeTicks: payload.facts.startTimeTicks,
    pidNamespace: payload.facts.pidNamespace,
    namespacePid: payload.facts.namespacePid,
    cwd: '/workspace',
  };
  const observerRoot = {
    hostId: 'observer-node-name',
    bootId: payload.facts.bootId,
    ...hostRoot,
    cwd: '/workspace',
  };
  const observerChild = {
    hostId: 'observer-node-name',
    bootId: payload.facts.bootId,
    ...hostChild,
    cwd: '/workspace',
  };
  const rootAttribution = {
    monitored: true,
    confidence: 1,
    reason: 'process_lineage',
    source: 'process_graph',
    rootPid: hostPid,
    rootStartTime: hostRoot.startTimeTicks,
    correlation: observerCorrelation,
  };
  const now = Date.now();
  const path = '/workspace/container-e2e.txt';
  const command = 'sleep 120';
  const semantic = [
    ...toolPair(adapterProcess, 'docker-invocation', 'docker-write', 'write', now, now + 100, { 'anysentry.tool.resource_hash': sha256(path) }),
    ...toolPair(adapterProcess, 'docker-invocation', 'docker-bash', 'bash', now + 200, now + 300, { 'anysentry.tool.command_hash': sha256(command) }),
  ];
  const kernel = [
    judgedEvent({
      eventId: 'docker-kernel-write', at: now + 50, eventKind: 'FileAccess', eventCategory: 'file', source: 'observer',
      process: observerRoot, attribution: rootAttribution, attributes: { path },
    }),
    judgedEvent({
      eventId: 'docker-kernel-bash', at: now + 250, eventKind: 'ToolExec', eventCategory: 'tool', source: 'observer',
      process: observerChild, attribution: rootAttribution, attributes: { 'anysentry.kernel.command_hash': sha256(command) },
    }),
  ];
  const bundle = buildToolEvidenceBundle([...semantic, ...kernel]);
  const byTool = Object.fromEntries(bundle.items.map((item) => [item.toolCallId, item]));
  assert.deepEqual(byTool['docker-write'].kernelEvidence.map((item) => item.eventId), ['docker-kernel-write']);
  assert.deepEqual(byTool['docker-bash'].kernelEvidence.map((item) => item.eventId), ['docker-kernel-bash']);
  console.log('S6 Docker PID-namespace identity E2E passed');
} finally {
  if (created) await execFile('docker', ['rm', '--force', containerName]).catch(() => {});
}
