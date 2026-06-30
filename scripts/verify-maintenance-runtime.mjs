#!/usr/bin/env node

import { managementAuthHeaders, safeProbeId } from './probe-id.mjs';

const baseUrl = (process.env.ANYSENTRY_API_BASE ?? process.env.API_BASE ?? `http://127.0.0.1:${process.env.PORT ?? '29653'}/security-center`).replace(/\/$/, '');
const runId = safeProbeId('mnt');
const actorHeaders = {
  'x-anysentry-actor-type': 'operator',
  'x-anysentry-actor': `${runId}-operator`,
  'x-anysentry-actor-name': 'Maintenance Runtime Verifier',
  'x-forwarded-for': '198.51.100.45',
  'user-agent': 'anysentry-maintenance-runtime-verifier',
};

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

async function createSource() {
  const created = await request('/sources', 'POST', {
    name: `${runId} maintenance source`,
    type: 'webhook',
    enabled: true,
    requireToken: true,
    collectorId: `${runId}-collector`,
    workspacePath: `repo://${runId}/maintenance`,
    owner: 'maintenance-verifier',
    tags: [runId, 'maintenance-runtime'],
  }, actorHeaders);
  assert('maintenance source creation returns managed token', Boolean(created.source?.sourceId && created.token), created);
  return created;
}

async function checkIn(source, token, status, message) {
  const result = await request('/sources/check-in', 'POST', {
    sourceId: source.sourceId,
    sourceName: source.name,
    sourceType: 'webhook',
    collectorId: `${runId}-collector`,
    workspacePath: source.workspacePath,
    token,
    status,
    message,
  });
  assert(`source check-in ${status} is accepted`, result.accepted === true && result.sourceId === source.sourceId, result);
}

async function sourceAlert(sourceId, status) {
  return eventually(`source alert ${status}`, async () => {
    const list = await request('/alerts/list', 'POST', { timeType: 'last_30d', sourceId, status: 'all', kind: 'source', limit: 50 });
    const alert = list.items?.find((item) => item.sourceId === sourceId && item.ruleId === 'source.check_in_error' && (!status || item.status === status));
    return alert ? { list, alert } : undefined;
  });
}

async function activeAlerts(sourceId) {
  const list = await request('/alerts/list', 'POST', { timeType: 'last_30d', sourceId, status: 'all', kind: 'source', limit: 50 });
  return list.items?.filter((item) => item.sourceId === sourceId && item.ruleId === 'source.check_in_error' && ['open', 'acknowledged', 'silenced'].includes(item.status)) ?? [];
}

async function createActiveAlertsObjective(sourceId) {
  const objective = await request('/objectives', 'POST', {
    name: `${runId} maintenance alert objective`,
    enabled: true,
    targetType: 'source',
    targetId: sourceId,
    metric: 'active_alerts',
    comparator: 'lte',
    threshold: 0,
    severity: 'high',
    owner: 'maintenance-verifier',
    description: 'Maintenance window should suppress source health alert pressure.',
  }, actorHeaders);
  assert('maintenance Objective is created', Boolean(objective.objectiveId && objective.metric === 'active_alerts'), objective);
  return objective;
}

async function expectObjective(label, objectiveId, check) {
  const found = await eventually(label, async () => {
    const list = await request('/objectives/list', 'POST', { objectiveId, limit: 5 });
    const objective = list.items?.find((item) => item.objectiveId === objectiveId);
    return objective && check(objective) ? { list, objective } : undefined;
  });
  assert(label, true, found);
  return found.objective;
}

async function createMaintenanceWindow(sourceId) {
  const startAt = new Date(Date.now() - 60_000).toISOString();
  const endAt = new Date(Date.now() + 3_600_000).toISOString();
  const window = await request('/maintenance/windows', 'POST', {
    title: `${runId} active source maintenance`,
    targetType: 'source',
    targetId: sourceId,
    startAt,
    endAt,
    enabled: true,
    owner: 'maintenance-verifier',
    reason: 'runtime suppression verification',
    labels: { probe: runId },
  }, actorHeaders);
  assert('maintenance window starts active for Source', window.targetId === sourceId && window.status === 'active', window);
  return window;
}

async function disableMaintenanceWindow(windowId) {
  const disabled = await request(`/maintenance/windows/${encodeURIComponent(windowId)}`, 'PUT', {
    enabled: false,
    note: `${runId} maintenance disabled by verifier`,
  }, actorHeaders);
  assert('maintenance window update disables suppression', disabled.status === 'disabled' && disabled.enabled === false, disabled);
  return disabled;
}

async function main() {
  console.log(`AnySentry maintenance runtime verification against ${baseUrl}`);
  await request('/stats');
  const { source, token } = await createSource();
  await checkIn(source, token, 'ok', `${runId} source healthy before maintenance`);

  const objective = await createActiveAlertsObjective(source.sourceId);
  assert('active_alerts Objective starts ok before Source alert', objective.status === 'ok' && objective.currentValue === 0, objective);

  await checkIn(source, token, 'error', `${runId} source error before maintenance`);
  const opened = await sourceAlert(source.sourceId, 'open');
  assert('Source error opens alert before maintenance', opened.alert.status === 'open' && opened.alert.sourceId === source.sourceId, opened);
  await expectObjective(
    'Objective breaches before maintenance suppression',
    objective.objectiveId,
    (item) => item.status === 'breach' && item.currentValue >= 1 && item.evidence.includes('active alerts'),
  );

  const maintenance = await createMaintenanceWindow(source.sourceId);
  await checkIn(source, token, 'error', `${runId} source error during maintenance`);
  const resolved = await sourceAlert(source.sourceId, 'resolved');
  assert(
    'active maintenance resolves matching Source alert',
    resolved.alert.status === 'resolved' && resolved.alert.note === 'suppressed by maintenance window',
    resolved,
  );
  const suppressedActiveAlerts = await activeAlerts(source.sourceId);
  assert('maintenance leaves no active Source alert', suppressedActiveAlerts.length === 0, suppressedActiveAlerts);
  await expectObjective(
    'Objective recovers while maintenance suppresses alert',
    objective.objectiveId,
    (item) => item.status === 'ok' && item.currentValue === 0 && item.evidence.includes('0 active alerts'),
  );

  await disableMaintenanceWindow(maintenance.windowId);
  await checkIn(source, token, 'error', `${runId} source error after maintenance`);
  const reopened = await sourceAlert(source.sourceId, 'open');
  assert('Source alert reopens after maintenance is disabled', reopened.alert.status === 'open' && reopened.alert.sourceId === source.sourceId, reopened);
  await expectObjective(
    'Objective breaches again after maintenance is disabled',
    objective.objectiveId,
    (item) => item.status === 'breach' && item.currentValue >= 1 && item.evidence.includes('active alerts'),
  );

  if (process.exitCode) {
    console.error(`Maintenance runtime verification failed for probe ${runId}`);
    process.exit(process.exitCode);
  }
  console.log(`Maintenance runtime verification passed for probe ${runId}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
