#!/usr/bin/env node

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const observerImage = process.env.ANYSENTRY_S6_OBSERVER_IMAGE ?? 'anysentry-observer-collector:s6-audit';
const agentImage = process.env.ANYSENTRY_S6_AGENT_IMAGE ?? 'anysentry-agent-runtime-lab:s6-audit';
const suffix = `${process.pid}-${randomUUID().slice(0, 8)}`;
const observerName = `anysentry-s6-observer-${suffix}`;
const agentName = `anysentry-s6-agent-${suffix}`;
const marker = `s6-pidns-${suffix}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function ndjson(output) {
  return output.split(/\r?\n/u).flatMap((line) => {
    if (!line.startsWith('{')) return [];
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

async function remove(name) {
  await execFile('docker', ['rm', '--force', name]).catch(() => {});
}

let observerCreated = false;
let agentCreated = false;
try {
  await execFile('docker', [
    'run', '--detach', '--name', observerName, '--privileged', '--pid', 'host',
    '--env', 'A3S_OBSERVER_JSON=1',
    '--env', `A3S_OBSERVER_COLLECTOR_ID=s6-pidns-${suffix}`,
    '--volume', '/sys:/sys:ro',
    observerImage,
  ]);
  observerCreated = true;

  await sleep(1_000);
  const inspected = await execFile('docker', ['inspect', '--format', '{{.State.Running}}', observerName]);
  if (inspected.stdout.trim() !== 'true') {
    const logs = await execFile('docker', ['logs', '--tail', '200', observerName]);
    throw new Error(`Observer exited before probe: ${logs.stdout}${logs.stderr}`);
  }

  const command = `printf ${marker} >/workspace/${marker}.txt; sleep 120 & wait`;
  await execFile('docker', [
    'run', '--detach', '--name', agentName, '--entrypoint', '/bin/bash', agentImage,
    '-c', command,
  ]);
  agentCreated = true;
  const { stdout: hostPidText } = await execFile('docker', ['inspect', '--format', '{{.State.Pid}}', agentName]);
  const hostPid = Number(hostPidText.trim());
  assert(Number.isSafeInteger(hostPid) && hostPid > 0);
  const { stdout: innerFactsText } = await execFile('docker', [
    'exec', agentName, '/bin/bash', '-c', "printf '%s|%s' \"$(readlink /proc/1/ns/pid)\" \"$(awk '/^NSpid:/{print $NF}' /proc/1/status)\"",
  ]);
  const [namespaceLink, innerPidText] = innerFactsText.trim().split('|');
  const namespaceInode = namespaceLink.match(/^pid:\[(\d+)\]$/u)?.[1];
  const innerPid = Number(innerPidText);
  assert(namespaceInode && Number.isSafeInteger(innerPid) && innerPid > 0);
  assert.notEqual(hostPid, innerPid, 'the fixture must exercise a real PID namespace');

  let rootExec;
  let childExec;
  for (let attempt = 0; attempt < 5 && (!rootExec || !childExec); attempt += 1) {
    await sleep(500);
    // Tail/since are essential here: the Observer sees the verifier's own docker CLI execs, so an
    // unbounded `docker logs` polling loop would amplify its own output indefinitely.
    const { stdout } = await execFile(
      'docker',
      ['logs', '--since', '15s', '--tail', '5000', observerName],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    const events = ndjson(stdout);
    rootExec = events.find((item) => (
      item?.event?.ToolExec?.argv?.some((arg) => String(arg).includes(marker)) &&
      item?.process?.pid === hostPid
    ));
    childExec = events.find((item) => (
      item?.event?.ToolExec?.argv?.[0]?.split('/').at(-1) === 'sleep' &&
      item?.process?.ppid === hostPid
    ));
  }
  assert(rootExec, 'Collector emits the container root ToolExec');
  assert(childExec, 'Collector emits the container direct-child ToolExec');
  assert.equal(rootExec.process.pid_namespace, namespaceInode);
  assert.equal(rootExec.process.namespace_pid, innerPid);
  assert.equal(typeof rootExec.process.start_time_ticks, 'number');
  assert.equal(childExec.process.pid_namespace, namespaceInode);
  assert.equal(childExec.process.namespace_ppid, innerPid);
  assert.equal(typeof childExec.process.namespace_pid, 'number');
  assert(childExec.process.namespace_pid > innerPid);
  console.log('S6 real Observer Docker PID-namespace E2E passed');
} finally {
  if (agentCreated) await remove(agentName);
  if (observerCreated) await remove(observerName);
}
