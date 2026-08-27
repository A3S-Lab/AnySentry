#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { managementAuthHeaders, safeProbeId } from './probe-id.mjs';

const baseUrl = (
  process.env.ANYSENTRY_API_BASE ??
  process.env.API_BASE ??
  `http://127.0.0.1:${process.env.PORT ?? '29653'}/security-center`
).replace(/\/$/u, '');
const runId = safeProbeId('s6-tool');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

async function request(path, method = 'GET', body, headers = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...managementAuthHeaders(),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  let payload;
  try { payload = raw ? JSON.parse(raw) : undefined; } catch { payload = raw; }
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}: ${raw}`);
  return payload?.data ?? payload;
}

async function createSource({ name, type, collectorId, workspacePath, authority, bindings }) {
  const result = await request('/sources', 'POST', {
    name,
    type,
    enabled: true,
    requireToken: true,
    collectorId,
    workspacePath,
    owner: 'verify-s6-tool-evidence-api',
    tags: [runId, 's6', 'tool-evidence'],
    correlationClaims: { enabled: true, authority, bindings },
  });
  assert(result.source?.sourceId && result.token, 'managed Source returns id and token');
  return result;
}

function sourceHeaders(source) {
  return {
    'x-anysentry-source-id': source.source.sourceId,
    authorization: `Bearer ${source.token}`,
  };
}

const now = Date.now();
const workspacePath = `/workspace/${runId}`;
const tenantId = `${runId}-tenant`;
const environmentId = `${runId}-environment`;
const invocationId = `${runId}-invocation`;
const adapterTraceId = sha256(invocationId).slice(0, 32);
const piProcess = {
  hostId: `${runId}-host`,
  bootId: `${runId}-boot`,
  pid: 52_000,
  ppid: 1,
  startTimeTicks: '700001',
  cwd: workspacePath,
  cgroup: `/docker/${'7'.repeat(64)}`,
  cgroupId: `${runId}-cgroup`,
  comm: 'pi',
  exe: '/usr/local/bin/pi',
};

const adapterSource = await createSource({
  name: `${runId} Pi adapter`,
  type: 'custom',
  workspacePath,
  authority: 'agent_adapter',
  bindings: {
    tenantIds: [tenantId],
    environmentIds: [environmentId],
    workspacePaths: [workspacePath],
  },
});
const collectorId = `${runId}-collector`;
const observerSource = await createSource({
  name: `${runId} Observer`,
  type: 'observer',
  collectorId,
  workspacePath,
  authority: 'observer_runtime',
  bindings: { collectorIds: [collectorId] },
});

function adapterToolEvent({ toolCallId, toolName, phase, at, resourcePath, command }) {
  const attributes = {
    'anysentry.adapter.schema': 'anysentry.agent_adapter_event.v1',
    'anysentry.adapter.runtime': 'pi',
    'anysentry.lifecycle.phase': phase,
    'gen_ai.operation.name': 'execute_tool',
    'gen_ai.tool.name': toolName,
    tenantId,
    environmentId,
    pid: piProcess.pid,
    startTimeTicks: piProcess.startTimeTicks,
    hostId: piProcess.hostId,
    bootId: piProcess.bootId,
    cgroup: piProcess.cgroup,
    ...(resourcePath ? {
      'anysentry.tool.resource_kind': 'file',
      'anysentry.tool.resource_path': resourcePath,
      'anysentry.tool.resource_hash': sha256(resourcePath),
    } : {}),
    ...(command ? {
      'anysentry.tool.resource_kind': 'command',
      'anysentry.tool.command_hash': sha256(command),
      'anysentry.tool.command_executable': command.split(/\s+/u)[0],
    } : {}),
  };
  return {
    id: `${runId}-${toolCallId}-${phase}`,
    at,
    eventKind: 'AgentTool',
    eventCategory: 'tool',
    activityContext: 'agent_action',
    subject: `Pi ${toolName} ${phase}`,
    workspacePath,
    agentId: 'pi-coding-agent',
    sessionId: `${runId}-session`,
    invocationId,
    toolCallId,
    traceId: adapterTraceId,
    spanId: sha256(`${adapterTraceId}\0${toolCallId}`).slice(0, 16),
    runId: invocationId,
    taskId: toolCallId,
    userId: 'uid:1000',
    pid: piProcess.pid,
    cwd: workspacePath,
    attributes,
  };
}

const writePath = `${workspacePath}/output.txt`;
const readPath = `${workspacePath}/input.txt`;
const command = `OPENAI_API_KEY=sk-s6-secret-value printf safe >> ${writePath}`;
const tools = [
  { toolCallId: `${runId}-read`, toolName: 'read', resourcePath: readPath, start: now + 10, end: now + 20 },
  { toolCallId: `${runId}-write`, toolName: 'write', resourcePath: writePath, start: now + 30, end: now + 60 },
  { toolCallId: `${runId}-bash`, toolName: 'bash', command, start: now + 70, end: now + 110 },
  { toolCallId: `${runId}-custom`, toolName: 'custom_remote', start: now + 120, end: now + 130 },
];
const invocationEvents = ['start', 'end'].map((phase, index) => ({
  id: `${runId}-invocation-${phase}`,
  at: phase === 'start' ? now : now + 140,
  eventKind: 'AgentInvocation',
  eventCategory: 'runtime',
  activityContext: 'agent_action',
  subject: `Pi invocation ${phase}`,
  workspacePath,
  agentId: 'pi-coding-agent',
  sessionId: `${runId}-session`,
  invocationId,
  traceId: adapterTraceId,
  spanId: sha256(`${adapterTraceId}\0invoke_agent`).slice(0, 16),
  runId: invocationId,
  pid: piProcess.pid,
  attributes: {
    'anysentry.adapter.schema': 'anysentry.agent_adapter_event.v1',
    'anysentry.adapter.runtime': 'pi',
    'anysentry.lifecycle.phase': phase,
    'gen_ai.operation.name': 'invoke_agent',
    tenantId,
    environmentId,
    pid: piProcess.pid,
    startTimeTicks: piProcess.startTimeTicks,
    hostId: piProcess.hostId,
    bootId: piProcess.bootId,
    sequence: index,
  },
}));
const adapterEvents = [invocationEvents[0], ...tools.flatMap((tool) => [
  adapterToolEvent({ ...tool, phase: 'start', at: tool.start }),
  adapterToolEvent({ ...tool, phase: 'end', at: tool.end }),
]), invocationEvents[1]];
const adapterIngest = await request('/ingest/events', 'POST', {
  sourceId: adapterSource.source.sourceId,
  sourceType: 'custom',
  workspacePath,
  events: adapterEvents,
}, sourceHeaders(adapterSource));
assert.equal(adapterIngest.acceptedEvents, adapterEvents.length, 'all Pi Tool span events are accepted');
assert(adapterIngest.items.every((item) => item.traceId === adapterTraceId), 'legacy traceId remains byte-for-byte unchanged');
assert(adapterIngest.items.every((item) => item.invocationId === invocationId),
  'authenticated Pi Invocation and read/write/bash/custom spans preserve one invocationId');

const adapterReplay = await request('/ingest/events', 'POST', {
  sourceId: adapterSource.source.sourceId,
  sourceType: 'custom',
  workspacePath,
  events: adapterEvents,
}, sourceHeaders(adapterSource));
assert.equal(adapterReplay.acceptedEvents, adapterEvents.length,
  'an exact external-id adapter replay is idempotently accepted');
assert(adapterReplay.items.every((item) => item.duplicate === true),
  'exact replay is explicitly marked duplicate without a new decision revision');
assert.deepEqual(
  adapterReplay.items.map((item) => item.eventId),
  adapterIngest.items.map((item) => item.eventId),
  'an exact replay returns the originally accepted event revisions',
);

await assert.rejects(
  request('/ingest/events', 'POST', {
    sourceId: adapterSource.source.sourceId,
    sourceType: 'custom',
    workspacePath,
    events: [{ ...invocationEvents[0], subject: 'conflicting reuse of the same producer id' }],
  }, sourceHeaders(adapterSource)),
  /-> 409:/u,
  'same external id with a different producer payload terminates with 409 and no new revision',
);

function observerAttribution() {
  return {
    monitored: true,
    classification: 'confirmed_agent',
    agentScopeId: 'pi',
    agentDisplayName: 'Pi',
    agentSessionId: `${runId}-runtime`,
    agentInstanceId: `${runId}-pi-root`,
    rootKey: `${piProcess.hostId}:${piProcess.bootId}:${piProcess.pid}:${piProcess.startTimeTicks}`,
    rootPid: piProcess.pid,
    rootStartTime: piProcess.startTimeTicks,
    confidence: 1,
    reason: 'authoritative_anchor',
    source: 'process_graph',
    evidence: ['observer:verified-runtime-root'],
  };
}

async function ingestObserverEvent({ id, at, kind, process, inner }) {
  const line = JSON.stringify({
    identity: { agent: 'pi', session: `${runId}-runtime`, task: process.pid },
    process,
    event: { [kind]: inner },
  });
  const result = await request('/ingest', 'POST', {
    line,
    sourceEventId: id,
    collectorId,
    nodeName: `${runId}-node`,
    sourceType: 'observer',
    workspacePath,
    process,
    attribution: observerAttribution(),
  }, sourceHeaders(observerSource));
  assert(result.accepted && result.eventId, `${kind} Observer evidence is retained`);
  return result;
}

await ingestObserverEvent({
  id: `${runId}-kernel-write`,
  at: now + 45,
  kind: 'FileAccess',
  process: piProcess,
  inner: { pid: piProcess.pid, uid: 1000, cwd: workspacePath, path: writePath },
});
const childProcess = {
  ...piProcess,
  pid: piProcess.pid + 1,
  ppid: piProcess.pid,
  startTimeTicks: '700002',
  comm: 'bash',
  exe: '/usr/bin/bash',
};
await ingestObserverEvent({
  id: `${runId}-kernel-bash`,
  at: now + 90,
  kind: 'ToolExec',
  process: childProcess,
  inner: { pid: childProcess.pid, ppid: childProcess.ppid, uid: 1000, cwd: workspacePath, argv: ['/bin/bash', '-c', command] },
});

const deadline = Date.now() + 10_000;
let evidence;
do {
  evidence = await request('/events/tool-evidence', 'POST', {
    timeType: 'last_30d',
    invocationId,
    workspacePath,
    limit: 1_000,
  });
  if (evidence.items?.length === tools.length) break;
  await new Promise((resolve) => setTimeout(resolve, 100));
} while (Date.now() < deadline);

assert.equal(evidence.schemaVersion, 'anysentry.tool_evidence.v1');
assert.equal(evidence.invocationId, invocationId);
if (evidence.items.length !== tools.length) {
  const observed = await request('/events/list', 'POST', {
    timeType: 'last_30d',
    scope: 'raw',
    includeUnknown: true,
    invocationId,
    limit: 100,
  });
  const firstEvent = await request('/events/list', 'POST', {
    timeType: 'last_30d',
    scope: 'raw',
    includeUnknown: true,
    eventId: adapterIngest.items[0].eventId,
    limit: 1,
  });
  console.error(JSON.stringify({ adapterIngest, evidence, observed, firstEvent }, null, 2));
}
assert.equal(evidence.items.length, 4, 'all read/write/bash/custom ToolCalls are present');
const byName = Object.fromEntries(evidence.items.map((item) => [item.toolName, item]));
assert.equal(byName.read.status, 'semantic_only');
assert.equal(byName.read.reason, 'kernel_read_not_captured');
assert.equal(byName.write.status, 'linked');
assert.deepEqual(byName.write.kernelEvidence.map((item) => item.linkMethod), ['same_process_resource']);
assert.equal(byName.bash.status, 'linked');
assert.deepEqual(byName.bash.kernelEvidence.map((item) => item.linkMethod), ['direct_child_command']);
assert.equal(byName.custom_remote.status, 'semantic_only');
assert.equal(evidence.ignoredUntrustedAdapterEvents, 0);

const health = await request('/healthz');
if (health.storage?.clickhouseReady) {
  const settleDelay = Math.max(0, tools.at(-1).end + 10_250 - Date.now());
  if (settleDelay > 0) await new Promise((resolve) => setTimeout(resolve, settleDelay));
  const relationSeed = await request('/events/tool-evidence', 'POST', {
    timeType: 'last_30d', invocationId, workspacePath, limit: 1_000,
  });
  assert.equal(relationSeed.items.length, tools.length);
}

const single = await request('/events/tool-evidence', 'POST', {
  timeType: 'last_30d',
  invocationId,
  toolCallId: `${runId}-write`,
  workspacePath,
});
assert.equal(single.items.length, 1, 'toolCallId narrows independently from invocationId');
assert.equal(single.items[0].toolName, 'write');
if (health.storage?.clickhouseReady) {
  assert.equal(single.dataSource, 'clickhouse_relation', 'settled ToolEvidence is served from the durable relation store');
  const latencies = [];
  for (let index = 0; index < 20; index += 1) {
    const startedAt = performance.now();
    const cold = await request('/events/tool-evidence', 'POST', {
      timeType: 'last_30d', invocationId, workspacePath, limit: 1_000,
    });
    latencies.push(performance.now() - startedAt);
    assert.equal(cold.dataSource, 'clickhouse_relation');
    assert.equal(cold.items.length, tools.length);
  }
  latencies.sort((left, right) => left - right);
  const p95 = latencies[Math.ceil(latencies.length * 0.95) - 1];
  assert(p95 < 2_000, `durable ToolEvidence P95 must remain below 2s, observed ${p95.toFixed(1)}ms`);
}

// A native OpenTelemetry GenAI Span is a single completed record. AnySentry's additive
// invocation extension supplies the business identity that the GenAI convention deliberately
// does not define; traceId remains an independent transport identity.
const otlpWorkspace = `${workspacePath}/otel`;
const otlpInvocationId = `${runId}-otlp-invocation`;
const otlpToolCallId = `${runId}-otlp-write`;
const otlpTraceId = sha256(`${runId}-otlp-trace`).slice(0, 32);
const otlpPath = `${otlpWorkspace}/output.txt`;
const otlpSource = await createSource({
  name: `${runId} OTel GenAI adapter`,
  type: 'otel',
  workspacePath: otlpWorkspace,
  authority: 'agent_adapter',
  bindings: {
    tenantIds: [tenantId],
    environmentIds: [environmentId],
    workspacePaths: [otlpWorkspace],
  },
});
const stringAttr = (key, value) => ({ key, value: { stringValue: value } });
const intAttr = (key, value) => ({ key, value: { intValue: String(value) } });
const otlpStart = Date.now();
const otlpEnd = otlpStart + 100;
const otlpIngest = await request('/ingest/otlp/v1/traces', 'POST', {
  sourceId: otlpSource.source.sourceId,
  sourceType: 'otel',
  workspacePath: otlpWorkspace,
  resourceSpans: [{
    resource: { attributes: [
      stringAttr('service.name', 'pi-otel'),
      stringAttr('tenantId', tenantId),
      stringAttr('environmentId', environmentId),
      stringAttr('host.id', piProcess.hostId),
      stringAttr('host.boot_id', piProcess.bootId),
      stringAttr('process.start_time_ticks', piProcess.startTimeTicks),
      intAttr('process.pid', piProcess.pid),
    ] },
    scopeSpans: [{ spans: [
      {
        traceId: otlpTraceId,
        spanId: sha256(`${runId}-invoke-span`).slice(0, 16),
        name: 'invoke_agent pi-otel',
        startTimeUnixNano: String(BigInt(otlpStart - 10) * 1_000_000n),
        endTimeUnixNano: String(BigInt(otlpEnd + 10) * 1_000_000n),
        attributes: [
          stringAttr('gen_ai.operation.name', 'invoke_agent'),
          stringAttr('gen_ai.agent.name', 'pi-otel'),
          stringAttr('anysentry.invocation.id', otlpInvocationId),
        ],
      },
      {
        traceId: otlpTraceId,
        spanId: sha256(`${runId}-tool-span`).slice(0, 16),
        parentSpanId: sha256(`${runId}-invoke-span`).slice(0, 16),
        name: 'execute_tool write',
        startTimeUnixNano: String(BigInt(otlpStart) * 1_000_000n),
        endTimeUnixNano: String(BigInt(otlpEnd) * 1_000_000n),
        attributes: [
          stringAttr('gen_ai.operation.name', 'execute_tool'),
          stringAttr('gen_ai.tool.name', 'write'),
          stringAttr('gen_ai.tool.call.id', otlpToolCallId),
          stringAttr('gen_ai.tool.call.arguments', '{"path":"/secret","content":"never-persist-this"}'),
          stringAttr('anysentry.invocation.id', otlpInvocationId),
          stringAttr('anysentry.tool.resource_hash', sha256(otlpPath)),
        ],
      },
    ] }],
  }],
}, sourceHeaders(otlpSource));
assert.equal(otlpIngest.acceptedEvents, 2, 'standard invoke_agent and execute_tool spans are accepted');
assert(otlpIngest.items.every((item) => item.traceId === otlpTraceId), 'OTLP traceId remains independent and unchanged');

await ingestObserverEvent({
  id: `${runId}-kernel-otlp-write`,
  at: otlpStart + 50,
  kind: 'FileAccess',
  process: piProcess,
  inner: { pid: piProcess.pid, uid: 1000, cwd: otlpWorkspace, path: otlpPath },
});
const otlpEvidence = await request('/events/tool-evidence', 'POST', {
  timeType: 'last_30d',
  invocationId: otlpInvocationId,
  workspacePath: otlpWorkspace,
});
assert.equal(otlpEvidence.items.length, 1);
assert.equal(otlpEvidence.items[0].toolCallId, otlpToolCallId);
assert.equal(otlpEvidence.items[0].status, 'linked');
assert.deepEqual(otlpEvidence.items[0].kernelEvidence.map((item) => item.linkMethod), ['same_process_resource']);

const otlpToolEvent = await request('/events/list', 'POST', {
  timeType: 'last_30d',
  eventId: otlpIngest.items[1].eventId,
  durable: false,
  includeUnknown: true,
  limit: 1,
});
assert.equal(otlpToolEvent.items[0].eventKind, 'AgentTool');
assert.equal(otlpToolEvent.items[0].eventCategory, 'tool');
assert.equal(otlpToolEvent.items[0].traceId, otlpTraceId);
assert.equal(otlpToolEvent.items[0].attributes['gen_ai.tool.call.arguments'], '[redacted]');

console.log('S6 trusted Tool evidence API E2E passed');
