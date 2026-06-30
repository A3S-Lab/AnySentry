#!/usr/bin/env node

import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { managementAuthHeaders, safeProbeId } from './probe-id.mjs';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const baseUrl = (process.env.ANYSENTRY_API_BASE ?? process.env.API_BASE ?? `http://127.0.0.1:${process.env.PORT ?? '29653'}/security-center`).replace(/\/$/, '');
const runId = safeProbeId('fwd');
const pythonBin = process.env.PYTHON ?? 'python3';

function fail(message, details) {
  console.error(`FAIL ${message}`);
  if (details !== undefined) console.error(typeof details === 'string' ? details : JSON.stringify(details, null, 2));
  process.exitCode = 1;
}

function pass(message) {
  console.log(`PASS ${message}`);
}

function assert(message, condition, details) {
  if (condition) pass(message);
  else fail(message, details);
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function eventually(label, fn, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() < deadline) {
    lastValue = await fn();
    if (lastValue) return lastValue;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${label}. Last value: ${JSON.stringify(lastValue, null, 2)}`);
}

async function request(pathname, method = 'GET', body, headers = {}) {
  const res = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', ...managementAuthHeaders(), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : undefined;
  } catch {
    payload = text;
  }
  if (!res.ok) {
    throw new Error(`${method} ${pathname} -> ${res.status}: ${text}`);
  }
  return payload?.data ?? payload;
}

function observerLine(identity, event) {
  return JSON.stringify({ identity, event });
}

function forwarderEnv(source, fixture) {
  return {
    ...process.env,
    ANYSENTRY_INGEST_URL: `${baseUrl}/ingest`,
    ANYSENTRY_HEARTBEAT_URL: `${baseUrl}/collectors/heartbeat`,
    ANYSENTRY_HEARTBEAT_SECS: '1',
    ANYSENTRY_SOURCE_ID: source.source.sourceId,
    ANYSENTRY_SOURCE_NAME: source.source.name,
    ANYSENTRY_SOURCE_TYPE: 'observer',
    ANYSENTRY_INGEST_TOKEN: source.token,
    ANYSENTRY_WORKSPACE_PATH: fixture.workspacePath,
    A3S_OBSERVER_COLLECTOR_ID: fixture.collectorId,
    A3S_NODE_NAME: fixture.nodeName,
    FORWARD_DROP_PATHS: '/sys/,/proc/,/run/,/dev/',
    FORWARD_MAX_INFLIGHT: '4',
  };
}

function runForwarderProcess({ label, command, args }, source, fixture) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: forwarderEnv(source, fixture),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve({ stdout, stderr });
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error(`${label} forwarder timed out. stdout=${stdout} stderr=${stderr}`));
    }, 10000);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', (error) => finish(error));
    child.once('exit', (code, signal) => {
      if (code === 0) finish();
      else finish(new Error(`${label} forwarder exited with ${signal ?? code}. stdout=${stdout} stderr=${stderr}`));
    });

    child.stdin.write('observer startup log line\n');
    child.stdin.write(`${observerLine({ agent: fixture.agentId, session: `${fixture.label}-session`, task: 'tool-task' }, { ToolExec: { pid: 2201, uid: 1000, cwd: '/workspace/app', argv: ['bash', '-lc', `echo ${fixture.label}-tool`] } })}\n`);
    child.stdin.write(`${observerLine({ agent: fixture.agentId, session: `${fixture.label}-session`, task: 'noise-task' }, { FileAccess: { pid: 2202, uid: 1000, cwd: '/workspace/app', path: `/proc/${fixture.label}/status` } })}\n`);
    child.stdin.write(`${observerLine({ agent: fixture.agentId, session: `${fixture.label}-session`, task: 'egress-task' }, { Egress: { pid: 2203, uid: 1000, cwd: '/workspace/app', peer: 'api.openai.com', port: 443 } })}\n`);
    child.stdin.end();
  });
}

async function createSource(fixture) {
  const source = await request('/sources', 'POST', {
    name: `${runId} ${fixture.label} source`,
    type: 'observer',
    enabled: true,
    requireToken: true,
    collectorId: fixture.collectorId,
    workspacePath: fixture.workspacePath,
    owner: 'verify-forwarders',
    tags: [runId, fixture.label],
  });
  assert(`${fixture.label} source creation returns token`, Boolean(source.source?.sourceId && source.token), source);
  return source;
}

async function eventsFor(fixture) {
  return request('/events/list', 'POST', {
    timeType: 'last_30d',
    collectorId: fixture.collectorId,
    workspacePath: fixture.workspacePath,
    limit: 20,
  });
}

async function healthFor(fixture) {
  return request('/collectors/health', 'POST', {
    timeType: 'last_30d',
    collectorId: fixture.collectorId,
    limit: 10,
  });
}

async function sourceFor(sourceId) {
  return request('/sources/list', 'POST', { sourceId, limit: 5 });
}

async function verifyForwarder(entry, source, fixture) {
  const output = await runForwarderProcess(entry, source, fixture);
  assert(`${fixture.label} forwarder exits cleanly`, output.stderr.trim() === '', output.stderr);

  const eventList = await eventually(`${fixture.label} forwarded events`, async () => {
    const list = await eventsFor(fixture);
    const hasTool = list.items?.some((event) => event.eventKind === 'ToolExec' && event.agentId === fixture.agentId);
    const hasLlm = list.items?.some((event) => event.eventKind === 'LlmCall' && event.agentId === fixture.agentId && event.subject.includes('api.openai.com'));
    const hasNoise = list.items?.some((event) => event.eventKind === 'FileAccess' || event.attributes?.path === `/proc/${fixture.label}/status`);
    return list.total >= 2 && hasTool && hasLlm && !hasNoise ? list : undefined;
  });
  assert(
    `${fixture.label} forwarder sends observer events with Source and Collector identity while dropping noise`,
    eventList.total === 2 &&
      eventList.items.every((event) =>
        event.workspacePath === fixture.workspacePath &&
        event.attributes?.sourceId === source.source.sourceId &&
        event.attributes?.collectorId === fixture.collectorId &&
        event.attributes?.collectorNode === fixture.nodeName,
      ),
    eventList,
  );

  const health = await eventually(`${fixture.label} collector heartbeat`, async () => {
    const list = await healthFor(fixture);
    const item = list.items?.[0];
    return item?.collectorId === fixture.collectorId && item.eventCount >= 2 ? list : undefined;
  });
  assert(
    `${fixture.label} forwarder heartbeat reports event counts`,
    health.total === 1 &&
      health.items?.[0]?.collectorId === fixture.collectorId &&
      health.items?.[0]?.state === 'healthy' &&
      health.items?.[0]?.eventCount >= 2 &&
      health.items?.[0]?.eventCategoryCounts?.tool >= 1 &&
      health.items?.[0]?.eventCategoryCounts?.network >= 1,
    health,
  );

  const sources = await sourceFor(source.source.sourceId);
  const sourceItem = sources.items?.[0];
  assert(
    `${fixture.label} Source rollup records forwarder events and heartbeat`,
    sources.total === 1 &&
      sourceItem?.acceptedEvents >= 2 &&
      sourceItem?.acceptedHeartbeats >= 1 &&
      sourceItem?.status === 'active' &&
      sourceItem?.collectorId === fixture.collectorId &&
      sourceItem?.workspacePath === fixture.workspacePath,
    sources,
  );
}

async function verifyNodeForwarder() {
  const fixture = {
    label: `${runId}-node`,
    collectorId: `${runId}-node-collector`,
    nodeName: `${runId}-node-host`,
    workspacePath: `repo://${runId}/node-forwarder`,
    agentId: `${runId}-node-agent`,
  };
  const source = await createSource(fixture);
  await verifyForwarder({ label: 'node', command: process.execPath, args: ['scripts/observer-forward.js'] }, source, fixture);
}

async function verifyPythonForwarder() {
  const fixture = {
    label: `${runId}-python`,
    collectorId: `${runId}-python-collector`,
    nodeName: `${runId}-python-host`,
    workspacePath: `repo://${runId}/python-forwarder`,
    agentId: `${runId}-python-agent`,
  };
  const source = await createSource(fixture);
  await verifyForwarder({ label: 'python', command: pythonBin, args: ['scripts/observer-to-anysentry.py'] }, source, fixture);
}

async function main() {
  console.log(`AnySentry forwarder verification against ${baseUrl}`);
  await request('/stats');
  await verifyNodeForwarder();
  await verifyPythonForwarder();

  if (process.exitCode) {
    console.error(`Forwarder verification failed for probe ${runId}`);
    process.exit(process.exitCode);
  }
  console.log(`Forwarder verification passed for probe ${runId}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
