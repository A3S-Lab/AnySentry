#!/usr/bin/env node

import { readFile } from 'node:fs/promises';

const baseUrl = (process.env.ANYSENTRY_API_BASE ?? process.env.API_BASE ?? `http://127.0.0.1:${process.env.PORT ?? '29653'}/security-center`).replace(/\/$/, '');
const adminToken = (process.env.ANYSENTRY_ADMIN_TOKEN ?? process.env.ANYSENTRY_MANAGEMENT_TOKEN ?? '').trim();

function safeProbeId(prefix) {
  const numericTimestamp = Date.now()
    .toString(36)
    .replace(/[a-z]/g, (char) => String(char.charCodeAt(0) - 87));
  return `${prefix}-${numericTimestamp}-${process.pid}`;
}

const runId = safeProbeId('auth');
const expectedProtectedRoutes = [
  'PUT incidents/:incidentId',
  'PUT alerts/:alertId',
  'PUT remediations/:taskId',
  'PUT agents/:agentId/metadata',
  'POST sources',
  'PUT sources/:sourceId',
  'POST sources/:sourceId/rotate-token',
  'POST maintenance/windows',
  'PUT maintenance/windows/:windowId',
  'POST notifications/channels',
  'PUT notifications/channels/:channelId',
  'POST notifications/routes',
  'PUT notifications/routes/:routeId',
  'POST objectives',
  'PUT objectives/:objectiveId',
  'PUT config',
  'POST config/simulate',
];

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

async function request(path, method = 'GET', body, headers = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : undefined;
  } catch {
    payload = text;
  }
  return { res, payload: payload?.data ?? payload, rawPayload: payload, text };
}

function adminHeaders(token = adminToken) {
  return { 'x-anysentry-admin-token': token };
}

function sourceHeaders(token) {
  return { 'x-anysentry-ingest-token': token };
}

function setDifference(left, right) {
  return [...left].filter((item) => !right.has(item)).sort();
}

async function controllerProtectedRoutes() {
  const source = await readFile(new URL('../apps/api/src/security-monitoring/security-monitoring.controller.ts', import.meta.url), 'utf8');
  const lines = source.split(/\r?\n/);
  const routes = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/@(Post|Put|Patch|Delete|Get)\('([^']+)'\)/);
    if (!match) continue;
    const route = `${match[1].toUpperCase()} ${match[2]}`;
    const decoratorWindow = lines.slice(i + 1, i + 5);
    if (decoratorWindow.some((line) => line.includes('@RequireManagementAuth()'))) routes.push(route);
  }
  return routes.sort();
}

function protectedWriteProbes(id) {
  const now = Date.now();
  return [
    { route: 'PUT incidents/:incidentId', label: 'incident update', method: 'PUT', path: `/incidents/${id}-missing-incident`, body: { status: 'acknowledged', note: 'auth guard probe' } },
    { route: 'PUT alerts/:alertId', label: 'alert update', method: 'PUT', path: `/alerts/${id}-missing-alert`, body: { status: 'acknowledged', note: 'auth guard probe' } },
    { route: 'PUT remediations/:taskId', label: 'remediation update', method: 'PUT', path: `/remediations/${id}-missing-task`, body: { status: 'done', note: 'auth guard probe' } },
    { route: 'PUT agents/:agentId/metadata', label: 'agent metadata update', method: 'PUT', path: `/agents/${id}-metadata-agent/metadata`, body: { workspacePath: `repo://${id}/auth`, owner: `${id}-owner` } },
    { route: 'PUT sources/:sourceId', label: 'source update', method: 'PUT', path: `/sources/${id}-missing-source`, body: { name: `${id} source`, type: 'webhook', requireToken: true } },
    { route: 'POST sources/:sourceId/rotate-token', label: 'source token rotation', method: 'POST', path: `/sources/${id}-missing-source/rotate-token` },
    {
      route: 'POST maintenance/windows',
      label: 'maintenance create',
      method: 'POST',
      path: '/maintenance/windows',
      body: { title: `${id} maintenance`, targetType: 'source', targetId: `${id}-source`, startAt: new Date(now).toISOString(), endAt: new Date(now + 600_000).toISOString(), enabled: true },
    },
    { route: 'PUT maintenance/windows/:windowId', label: 'maintenance update', method: 'PUT', path: `/maintenance/windows/${id}-missing-window`, body: { enabled: false, note: 'auth guard probe' } },
    { route: 'POST notifications/channels', label: 'notification channel create', method: 'POST', path: '/notifications/channels', body: { name: `${id} channel`, type: 'webhook', enabled: true, webhookUrl: 'https://example.invalid/auth-probe' } },
    { route: 'PUT notifications/channels/:channelId', label: 'notification channel update', method: 'PUT', path: `/notifications/channels/${id}-missing-channel`, body: { name: `${id} channel updated`, enabled: false } },
    { route: 'POST notifications/routes', label: 'notification route create', method: 'POST', path: '/notifications/routes', body: { name: `${id} route`, enabled: true, channelIds: [], kinds: ['source'] } },
    { route: 'PUT notifications/routes/:routeId', label: 'notification route update', method: 'PUT', path: `/notifications/routes/${id}-missing-route`, body: { name: `${id} route updated`, enabled: false, channelIds: [], kinds: ['source'] } },
    { route: 'POST objectives', label: 'objective create', method: 'POST', path: '/objectives', body: { name: `${id} objective`, enabled: true, targetType: 'source', targetId: `${id}-source`, metric: 'active_alerts', comparator: 'lte', threshold: 0, severity: 'medium' } },
    { route: 'PUT objectives/:objectiveId', label: 'objective update', method: 'PUT', path: `/objectives/${id}-missing-objective`, body: { name: `${id} objective updated`, enabled: false, threshold: 1 } },
    { route: 'PUT config', label: 'policy update', method: 'PUT', path: '/config', body: {} },
    { route: 'POST config/simulate', label: 'policy simulation', method: 'POST', path: '/config/simulate', body: { timeType: 'last_30d', limit: 1, policy: {} } },
  ];
}

function otlpAttr(key, value) {
  if (typeof value === 'number') return { key, value: { intValue: String(value) } };
  if (typeof value === 'boolean') return { key, value: { boolValue: value } };
  return { key, value: { stringValue: String(value) } };
}

async function main() {
  if (!adminToken) throw new Error('Set ANYSENTRY_ADMIN_TOKEN or ANYSENTRY_MANAGEMENT_TOKEN before running this verifier.');

  console.log(`AnySentry management auth verification against ${baseUrl}`);

  const health = await request('/healthz');
  assert('healthz reports management auth enabled without requiring a token', health.res.ok && health.payload?.managementAuth?.enabled === true, health.rawPayload);

  const controllerRoutes = await controllerProtectedRoutes();
  const expectedRouteSet = new Set(expectedProtectedRoutes);
  const controllerRouteSet = new Set(controllerRoutes);
  assert(
    'controller protected write route list matches management auth contract',
    setDifference(expectedRouteSet, controllerRouteSet).length === 0 && setDifference(controllerRouteSet, expectedRouteSet).length === 0,
    {
      expectedProtectedRoutes,
      controllerProtectedRoutes: controllerRoutes,
      missingInController: setDifference(expectedRouteSet, controllerRouteSet),
      unexpectedInController: setDifference(controllerRouteSet, expectedRouteSet),
    },
  );

  const protectedProbes = protectedWriteProbes(runId);
  const probedRouteSet = new Set(['POST sources', ...protectedProbes.map((probe) => probe.route)]);
  assert(
    'management auth runtime probes cover every protected write route',
    setDifference(expectedRouteSet, probedRouteSet).length === 0 && setDifference(probedRouteSet, expectedRouteSet).length === 0,
    {
      expectedProtectedRoutes,
      probedRoutes: [...probedRouteSet].sort(),
      missingRuntimeProbes: setDifference(expectedRouteSet, probedRouteSet),
      unexpectedRuntimeProbes: setDifference(probedRouteSet, expectedRouteSet),
    },
  );

  for (const probe of protectedProbes) {
    const missing = await request(probe.path, probe.method, probe.body);
    assert(`management ${probe.label} rejects missing admin token`, missing.res.status === 401, { route: probe.route, status: missing.res.status, payload: missing.rawPayload });

    const wrong = await request(probe.path, probe.method, probe.body, adminHeaders('wrong-admin-token'));
    assert(`management ${probe.label} rejects wrong admin token`, wrong.res.status === 401, { route: probe.route, status: wrong.res.status, payload: wrong.rawPayload });
  }

  const read = await request('/events/list', 'POST', { timeType: 'last_30d', limit: 5 });
  assert('read/list APIs remain available without management token', read.res.ok && Array.isArray(read.payload?.items), read.rawPayload);

  const currentPolicy = await request('/config');
  assert('policy config read remains available without management token', currentPolicy.res.ok && currentPolicy.payload?.status?.l1 === true, currentPolicy.rawPayload);

  const invalidPolicy = {
    rules: [{
      name: `${runId} invalid regex`,
      on: 'ToolExec',
      match: '[',
      verdict: 'block',
      severity: 'high',
      reason: 'invalid policy validation probe',
    }],
  };
  const invalidSimulation = await request('/config/simulate', 'POST', { timeType: 'last_30d', limit: 1, policy: invalidPolicy }, adminHeaders());
  assert('policy simulation rejects invalid regex with a client error', invalidSimulation.res.status === 400, invalidSimulation.rawPayload);

  const invalidPolicySave = await request('/config', 'PUT', invalidPolicy, adminHeaders());
  assert('policy update rejects invalid regex with a client error', invalidPolicySave.res.status === 400, invalidPolicySave.rawPayload);

  const afterInvalidPolicySave = await request('/config');
  assert(
    'invalid policy update does not replace the active policy',
    afterInvalidPolicySave.res.ok && JSON.stringify(afterInvalidPolicySave.payload?.policy) === JSON.stringify(currentPolicy.payload?.policy),
    { before: currentPolicy.rawPayload, after: afterInvalidPolicySave.rawPayload },
  );

  const ingest = await request('/ingest/events', 'POST', {
    sourceType: 'custom',
    sourceName: `${runId}-producer`,
    collectorId: `${runId}-collector`,
    workspacePath: `repo://${runId}`,
    events: [{ kind: 'tool', agentId: `${runId}-agent`, sessionId: `${runId}-session`, argv: ['id'], cwd: '/workspace' }],
  });
  assert('ingest APIs remain available without management token', ingest.res.ok && ingest.payload?.acceptedEvents === 1, ingest.rawPayload);

  const unauthCreate = await request('/sources', 'POST', {
    name: `${runId} unauthorized source`,
    type: 'webhook',
    requireToken: true,
  });
  assert('management create rejects missing admin token', unauthCreate.res.status === 401, unauthCreate.rawPayload);

  const wrongCreate = await request(
    '/sources',
    'POST',
    {
      name: `${runId} wrong-token source`,
      type: 'webhook',
      requireToken: true,
    },
    adminHeaders('wrong-admin-token'),
  );
  assert('management create rejects wrong admin token', wrongCreate.res.status === 401, wrongCreate.rawPayload);

  const created = await request(
    '/sources',
    'POST',
    {
      name: `${runId} managed source`,
      type: 'webhook',
      requireToken: true,
      collectorId: `${runId}-managed-collector`,
      workspacePath: `repo://${runId}/managed`,
      owner: 'verify-management-auth',
    },
    adminHeaders(),
  );
  const source = created.payload?.source;
  const sourceToken = created.payload?.token;
  assert('management create accepts valid admin token and returns a producer token', created.res.ok && Boolean(source?.sourceId && sourceToken), created.rawPayload);

  const sourceTokenAsAdmin = await request(
    `/sources/${encodeURIComponent(source.sourceId)}`,
    'PUT',
    {
      name: `${runId} source-token-is-not-admin`,
      type: 'webhook',
      requireToken: true,
    },
    { authorization: `Bearer ${sourceToken}` },
  );
  assert('producer source token is not accepted as management auth', sourceTokenAsAdmin.res.status === 401, sourceTokenAsAdmin.rawPayload);

  const protectedGenericIngest = await request(
    '/ingest/events',
    'POST',
    {
      sourceId: source.sourceId,
      sourceName: `${runId} managed source`,
      sourceType: 'webhook',
      collectorId: `${runId}-managed-collector`,
      workspacePath: `repo://${runId}/managed`,
      events: [
        {
          kind: 'tool',
          agentId: `${runId}-protected-generic-agent`,
          sessionId: `${runId}-protected-generic-session`,
          argv: ['id'],
          cwd: '/workspace',
        },
      ],
    },
    sourceHeaders(sourceToken),
  );
  assert('protected generic ingest accepts Source token without management token', protectedGenericIngest.res.ok && protectedGenericIngest.payload?.acceptedEvents === 1, protectedGenericIngest.rawPayload);

  const protectedOtelIngest = await request(
    '/ingest/otel',
    'POST',
    {
      sourceId: source.sourceId,
      sourceName: `${runId} managed source`,
      sourceType: 'otel',
      resourceLogs: [
        {
          resource: {
            attributes: [
              otlpAttr('service.name', `${runId}-protected-otel-agent`),
              otlpAttr('anysentry.workspace', `repo://${runId}/managed`),
              otlpAttr('service.instance.id', `${runId}-protected-otel-session`),
              otlpAttr('anysentry.collector.id', `${runId}-managed-collector`),
            ],
          },
          scopeLogs: [
            {
              logRecords: [
                {
                  body: { stringValue: 'bash -lc id' },
                  attributes: [
                    otlpAttr('anysentry.event.kind', 'tool'),
                    otlpAttr('process.command_line', 'bash -lc id'),
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    sourceHeaders(sourceToken),
  );
  assert('protected OTEL ingest accepts Source token without management token', protectedOtelIngest.res.ok && protectedOtelIngest.payload?.acceptedEvents === 1, protectedOtelIngest.rawPayload);

  const heartbeat = await request(
    '/collectors/heartbeat',
    'POST',
    {
      sourceId: source.sourceId,
      sourceName: `${runId} managed source`,
      sourceType: 'forwarder',
      collectorId: `${runId}-managed-collector`,
      workspacePath: `repo://${runId}/managed`,
      nodeName: `${runId}-managed-node`,
      status: 'ok',
      eventKindCounts: { ToolExec: 2 },
    },
    sourceHeaders(sourceToken),
  );
  assert('producer collector heartbeat accepts Source token without management token', heartbeat.res.ok && heartbeat.payload?.accepted === true && heartbeat.payload?.collectorId === `${runId}-managed-collector`, heartbeat.rawPayload);

  const updated = await request(
    `/sources/${encodeURIComponent(source.sourceId)}`,
    'PUT',
    {
      name: `${runId} managed source updated`,
      type: 'webhook',
      requireToken: true,
      collectorId: `${runId}-managed-collector`,
      workspacePath: `repo://${runId}/managed`,
      owner: 'verify-management-auth-updated',
    },
    { authorization: `Bearer ${adminToken}` },
  );
  assert('management update accepts Authorization bearer admin token', updated.res.ok && updated.payload?.source?.owner === 'verify-management-auth-updated', updated.rawPayload);

  const checkIn = await request(
    '/sources/check-in',
    'POST',
    {
      sourceId: source.sourceId,
      sourceName: `${runId} managed source updated`,
      sourceType: 'webhook',
      collectorId: `${runId}-managed-collector`,
      workspacePath: `repo://${runId}/managed`,
      status: 'ok',
    },
    {
      'x-anysentry-ingest-token': sourceToken,
    },
  );
  assert('producer check-in still accepts Source token without management token', checkIn.res.ok && checkIn.payload?.accepted === true, checkIn.rawPayload);

  const rotated = await request(`/sources/${encodeURIComponent(source.sourceId)}/rotate-token`, 'POST', undefined, adminHeaders());
  assert('management token rotation accepts valid admin header', rotated.res.ok && rotated.payload?.token && rotated.payload?.token !== sourceToken, rotated.rawPayload);

  const missingRotation = await request(`/sources/${encodeURIComponent(`${runId}-missing-source-valid-admin`)}/rotate-token`, 'POST', undefined, adminHeaders());
  assert('management token rotation rejects unknown source with valid admin header', missingRotation.res.status === 404, missingRotation.rawPayload);

  const missingMaintenanceUpdate = await request(
    `/maintenance/windows/${encodeURIComponent(`${runId}-missing-window-valid-admin`)}`,
    'PUT',
    { enabled: false, note: 'valid admin should not create maintenance windows through PUT' },
    adminHeaders(),
  );
  assert('management maintenance update rejects unknown window with valid admin header', missingMaintenanceUpdate.res.status === 404, missingMaintenanceUpdate.rawPayload);

  const missingChannelUpdate = await request(
    `/notifications/channels/${encodeURIComponent(`${runId}-missing-channel-valid-admin`)}`,
    'PUT',
    { name: `${runId} missing channel`, enabled: false },
    adminHeaders(),
  );
  assert('management notification channel update rejects unknown channel with valid admin header', missingChannelUpdate.res.status === 404, missingChannelUpdate.rawPayload);

  const missingRouteUpdate = await request(
    `/notifications/routes/${encodeURIComponent(`${runId}-missing-route-valid-admin`)}`,
    'PUT',
    { name: `${runId} missing route`, enabled: false, channelIds: [], kinds: ['source'] },
    adminHeaders(),
  );
  assert('management notification route update rejects unknown route with valid admin header', missingRouteUpdate.res.status === 404, missingRouteUpdate.rawPayload);

  const missingObjectiveUpdate = await request(
    `/objectives/${encodeURIComponent(`${runId}-missing-objective-valid-admin`)}`,
    'PUT',
    { name: `${runId} missing objective`, enabled: false, threshold: 1 },
    adminHeaders(),
  );
  assert('management objective update rejects unknown objective with valid admin header', missingObjectiveUpdate.res.status === 404, missingObjectiveUpdate.rawPayload);

  if (process.exitCode) {
    console.error('Management auth verification failed');
    process.exit(process.exitCode);
  }
  console.log(`Management auth verification passed for probe ${runId}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
