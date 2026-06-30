#!/usr/bin/env node

import { managementAuthHeaders, safeProbeId } from './probe-id.mjs';

const baseUrl = (process.env.ANYSENTRY_API_BASE ?? process.env.API_BASE ?? `http://127.0.0.1:${process.env.PORT ?? '29653'}/security-center`).replace(/\/$/, '');
const runId = safeProbeId('obs');

function fail(message, details) {
  console.error(`FAIL ${message}`);
  if (details !== undefined) console.error(JSON.stringify(details, null, 2));
  process.exitCode = 1;
}

function pass(message) {
  console.log(`PASS ${message}`);
}

function assert(message, condition, details) {
  if (condition) pass(message);
  else fail(message, details);
}

async function request(path, method = 'GET', body, headers = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
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
    throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  }
  return payload?.data ?? payload;
}

function observerLine(identity, event) {
  return JSON.stringify({ identity, event });
}

function sourceHeaders(sourceId, token) {
  return {
    'x-anysentry-source-id': sourceId,
    'x-anysentry-ingest-token': token,
  };
}

function leaks(value, needles) {
  const encoded = JSON.stringify(value);
  return needles.some((needle) => encoded.includes(needle));
}

async function eventById(eventId) {
  const list = await request('/events/list', 'POST', { timeType: 'last_30d', eventId, limit: 5 });
  return { list, event: list.items?.[0] };
}

async function assertEvent(message, eventId, checks) {
  const { list, event } = await eventById(eventId);
  const ok = list.total === 1 && event?.eventId === eventId && checks(event);
  assert(message, ok, list);
}

async function createProtectedObserverSource() {
  const source = await request('/sources', 'POST', {
    name: `${runId} observer forwarder`,
    type: 'observer',
    enabled: true,
    requireToken: true,
    collectorId: `${runId}-collector`,
    workspacePath: `repo://${runId}/observer`,
    owner: 'verify-observer-ingest',
    tags: [runId, 'observer-verifier'],
  });
  assert('observer source creation returns managed token', Boolean(source.source?.sourceId && source.token), source);
  return source;
}

async function verifyRejectedObserverToken(sourceId) {
  const line = observerLine(
    { agent: `${runId}-rejected-agent`, session: `${runId}-rejected-session`, task: 'rejected-task' },
    { ToolExec: { pid: 4242, uid: 1000, cwd: `/workspace/${runId}/rejected`, argv: ['id'] } },
  );
  const rejected = await request('/ingest', 'POST', {
    line,
    collectorId: `${runId}-collector`,
    nodeName: `${runId}-node`,
    sourceId,
    sourceName: `${runId} observer forwarder`,
    sourceType: 'observer',
    token: `${runId}-wrong-token`,
  });

  assert('observer /ingest rejects invalid source token', rejected.accepted === false && rejected.reason === 'invalid source token' && rejected.sourceId === sourceId, rejected);
  const sources = await request('/sources/list', 'POST', { sourceId, limit: 5 });
  assert('observer invalid token increments Source rejectedEvents', sources.total === 1 && sources.items?.[0]?.rejectedEvents >= 1 && sources.items?.[0]?.lastResult === 'rejected', sources);
}

async function verifyObserverToolEvent(sourceId, token) {
  const agentId = `${runId}-tool-agent`;
  const workspacePath = `repo://${runId}/observer-tool`;
  const secret = `${runId}-observer-password`;
  const apiKey = `sk-${runId.replace(/[^a-z0-9]/gi, '').padEnd(18, 'd')}`;
  const line = observerLine(
    { agent: agentId, session: `${runId}-tool-session`, task: 'task-tool' },
    { ToolExec: { pid: 1312, uid: 1001, cwd: '/workspace/project', argv: ['bash', '-lc', `echo observer-ok --token=${secret}`] } },
  );
  const result = await request('/ingest', 'POST', {
    line,
    collectorId: `${runId}-collector`,
    nodeName: `${runId}-node`,
    sourceName: `${runId} observer forwarder`,
    sourceType: 'observer',
    workspacePath,
    attributes: { password: secret, api_key: apiKey, token_count: 7 },
  }, sourceHeaders(sourceId, token));

  assert('observer /ingest accepts raw ToolExec line', result.accepted === true && result.eventId && result.sourceId === sourceId, result);
  await assertEvent('observer ToolExec event preserves source, collector, node, and raw evidence', result.eventId, (event) =>
    event.source === 'observer' &&
    event.eventKind === 'ToolExec' &&
    event.eventCategory === 'tool' &&
    event.agentId === agentId &&
    event.workspacePath === workspacePath &&
    event.sessionId === `${runId}-tool-session` &&
    event.runId === `${runId}-tool-session` &&
    event.taskId === 'task-tool' &&
    event.attributes?.sourceId === sourceId &&
    event.attributes?.collectorId === `${runId}-collector` &&
    event.attributes?.collectorNode === `${runId}-node` &&
    event.attributes?.observerKind === 'ToolExec' &&
    String(event.attributes?.argv ?? '').includes('observer-ok') &&
    String(event.attributes?.argv ?? '').includes('[redacted]') &&
    event.attributes?.password === '[redacted]' &&
    event.attributes?.api_key === '[redacted]' &&
    event.attributes?.token_count === 7 &&
    !leaks(event, [secret, apiKey]) &&
    (event.rawPreview ?? '').includes('ToolExec'),
  );
  return result.eventId;
}

async function verifyObserverLlmEndpoint(sourceId, token) {
  const agentId = `${runId}-llm-agent`;
  const workspacePath = `repo://${runId}/observer-llm`;
  const line = observerLine(
    { agent: agentId, session: `${runId}-llm-session`, task: 'task-llm' },
    { Egress: { pid: 1313, uid: 1001, cwd: '/workspace/project', peer: 'api.openai.com', port: 443 } },
  );
  const result = await request('/ingest', 'POST', {
    line,
    collectorId: `${runId}-collector`,
    nodeName: `${runId}-node`,
    sourceId,
    sourceName: `${runId} observer forwarder`,
    sourceType: 'observer',
    token,
    workspacePath,
  });

  assert('observer /ingest accepts raw Egress line to LLM endpoint', result.accepted === true && result.eventId, result);
  await assertEvent('observer LLM endpoint egress is normalized as LlmCall', result.eventId, (event) =>
    event.source === 'observer' &&
    event.eventKind === 'LlmCall' &&
    event.eventCategory === 'llm' &&
    event.agentId === agentId &&
    event.workspacePath === workspacePath &&
    event.subject.includes('api.openai.com') &&
    event.attributes?.observerKind === 'Egress' &&
    event.attributes?.peer === 'api.openai.com',
  );
  return result.eventId;
}

async function verifyRawCollectorHeartbeat(sourceId, token) {
  const line = observerLine(
    { agent: `${runId}-collector-agent`, session: `${runId}-collector-session` },
    {
      CollectorHeartbeat: {
        node_name: `${runId}-node`,
        namespace: 'anysentry-system',
        pod_name: `${runId}-pod`,
        mode: 'observer-forwarder',
        status: 'ok',
        interval_secs: 30,
        attached_probes: 7,
        enabled_features: ['exec', 'egress', 'dns', 'file'],
        exec: 3,
        dns: 2,
        egress: 1,
        observed_agents: 2,
      },
    },
  );
  const result = await request('/ingest', 'POST', {
    line,
    collectorId: `${runId}-collector`,
    nodeName: `${runId}-node-from-body`,
    sourceId,
    sourceName: `${runId} observer forwarder`,
    sourceType: 'observer',
    token,
    workspacePath: `repo://${runId}/observer`,
  });

  assert('observer /ingest accepts raw CollectorHeartbeat line and uses body collectorId', result.accepted === true && result.kind === 'collector-heartbeat' && result.collectorId === `${runId}-collector`, result);
  const health = await request('/collectors/health', 'POST', { timeType: 'last_30d', collectorId: `${runId}-collector`, limit: 5 });
  assert(
    'raw CollectorHeartbeat appears in Collector health with event counts',
    health.total === 1 &&
      health.items?.[0]?.collectorId === `${runId}-collector` &&
      health.items?.[0]?.state === 'healthy' &&
      health.items?.[0]?.eventCount === 6 &&
      health.items?.[0]?.observedAgentCount === 2 &&
      health.items?.[0]?.attachedProbes === 7,
    health,
  );
}

async function verifyDirectForwarderHeartbeat(sourceId, token) {
  const result = await request('/collectors/heartbeat', 'POST', {
    sourceId,
    token,
    sourceName: `${runId} observer forwarder`,
    sourceType: 'observer',
    collectorId: `${runId}-collector`,
    nodeName: `${runId}-node-direct`,
    workspacePath: `repo://${runId}/observer`,
    mode: 'observer-forwarder',
    status: 'degraded',
    intervalSecs: 30,
    eventKindCounts: { ToolExec: 2, Egress: 1 },
    queueDepth: 4,
    outputDropped: 1,
    errorCount: 1,
    observedAgents: 2,
    message: 'simulated forwarder pressure',
  });

  assert('direct forwarder heartbeat accepts Source token and updates collector', result.accepted === true && result.collectorId === `${runId}-collector` && result.sourceId === sourceId, result);
  const health = await request('/collectors/health', 'POST', { timeType: 'last_30d', collectorId: `${runId}-collector`, limit: 5 });
  assert(
    'direct forwarder heartbeat can mark Collector degraded',
    health.total === 1 &&
      health.items?.[0]?.collectorId === `${runId}-collector` &&
      health.items?.[0]?.state === 'degraded' &&
      health.items?.[0]?.queueDepth === 4 &&
      health.items?.[0]?.outputDropped === 1 &&
      health.items?.[0]?.errorCount === 1,
    health,
  );
}

async function verifySourceRollup(sourceId) {
  const sources = await request('/sources/list', 'POST', { sourceId, limit: 5 });
  const source = sources.items?.[0];
  assert(
    'observer Source rollup records accepted events, heartbeats, and rejection',
    sources.total === 1 &&
      source?.sourceId === sourceId &&
      source.acceptedEvents >= 2 &&
      source.acceptedHeartbeats >= 2 &&
      source.rejectedEvents >= 1 &&
      source.status === 'active' &&
      source.lastResult === 'accepted',
    sources,
  );
}

async function main() {
  console.log(`AnySentry observer ingest verification against ${baseUrl}`);
  await request('/stats');
  const { source, token } = await createProtectedObserverSource();
  await verifyRejectedObserverToken(source.sourceId);
  await verifyObserverToolEvent(source.sourceId, token);
  await verifyObserverLlmEndpoint(source.sourceId, token);
  await verifyRawCollectorHeartbeat(source.sourceId, token);
  await verifyDirectForwarderHeartbeat(source.sourceId, token);
  await verifySourceRollup(source.sourceId);

  if (process.exitCode) {
    console.error(`Observer ingest verification failed for probe ${runId}`);
    process.exit(process.exitCode);
  }
  console.log(`Observer ingest verification passed for probe ${runId}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
