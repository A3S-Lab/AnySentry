#!/usr/bin/env node

import { createServer } from 'node:http';
import { managementAuthHeaders, safeProbeId } from './probe-id.mjs';

const baseUrl = (process.env.ANYSENTRY_API_BASE ?? process.env.API_BASE ?? `http://127.0.0.1:${process.env.PORT ?? '29653'}/security-center`).replace(/\/$/, '');
const runId = safeProbeId('ntf');
const eventProbeMarker = `${runId}-critical-event-probe`;
const eventPolicyRuleName = `${runId} critical event notification probe`;
const configTextSecret = `${runId}-notification-config-secret`;
const configTextApiKey = `sk-${runId.replace(/[^a-z0-9_-]/gi, '')}-notification-config-key`;
const actorHeaders = {
  'x-anysentry-actor-type': 'operator',
  'x-anysentry-actor': `${runId}-operator`,
  'x-anysentry-actor-name': 'Notification Verifier',
  'x-forwarded-for': '198.51.100.43',
  'user-agent': 'anysentry-notification-verifier',
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

function endpointPreviewRecords(config) {
  return [
    ...(config.channels ?? []).flatMap((channel) => (channel.endpointPreview ? [{ kind: 'channel', id: channel.channelId, endpointPreview: channel.endpointPreview }] : [])),
    ...(config.deliveries ?? []).flatMap((delivery) => (delivery.endpointPreview ? [{ kind: 'delivery', id: delivery.deliveryId, endpointPreview: delivery.endpointPreview }] : [])),
  ];
}

function endpointPreviewIsRedacted(record, secret) {
  const preview = record.endpointPreview;
  return typeof preview === 'string' && !preview.includes(secret) && (preview === '[invalid-url]' || /^https?:\/\/[^/?#]+(?:\/\.\.\.)?$/.test(preview));
}

function notificationConfigTextRecords(config) {
  const records = [];
  for (const channel of config.channels ?? []) {
    for (const field of ['name', 'description', 'lastError']) {
      if (channel[field]) records.push({ kind: 'channel', id: channel.channelId, field, value: String(channel[field]) });
    }
    for (const [key, value] of Object.entries(channel.labels ?? {})) {
      records.push({ kind: 'channel', id: channel.channelId, field: `labels.${key}`, value: String(value) });
    }
  }
  for (const route of config.routes ?? []) {
    for (const field of ['name', 'description', 'q']) {
      if (route[field]) records.push({ kind: 'route', id: route.routeId, field, value: String(route[field]) });
    }
  }
  for (const delivery of config.deliveries ?? []) {
    for (const field of ['alertTitle', 'channelName', 'routeName', 'error']) {
      if (delivery[field]) records.push({ kind: 'delivery', id: delivery.deliveryId, field, value: String(delivery[field]) });
    }
  }
  return records;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function escapeRegex(value) {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
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

async function webhookDelivery(webhook, label, predicate, timeoutMs = 8000) {
  return eventually(label, async () => webhook.deliveries.find(predicate), timeoutMs);
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

async function startWebhook(name) {
  const deliveries = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      let payload;
      try {
        payload = body ? JSON.parse(body) : undefined;
      } catch {
        payload = body;
      }
      deliveries.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body,
        payload,
        at: Date.now(),
      });
      res.statusCode = 204;
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error(`Unable to bind ${name} webhook`);
  return {
    deliveries,
    url: `http://127.0.0.1:${address.port}/${name}`,
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

async function createSource() {
  const created = await request('/sources', 'POST', {
    name: `${runId} notification source`,
    type: 'webhook',
    enabled: true,
    requireToken: true,
    collectorId: `${runId}-collector`,
    workspacePath: `repo://${runId}/notifications`,
    owner: 'notification-verifier',
    team: `${runId}-source-team`,
    tags: [runId, 'notification-dispatch'],
  }, actorHeaders);
  assert('notification source creation returns managed token', Boolean(created.source?.sourceId && created.token), created);
  return created;
}

async function createRemediationSource() {
  const created = await request('/sources', 'POST', {
    name: `${runId} remediation notification source`,
    type: 'webhook',
    enabled: true,
    requireToken: true,
    collectorId: `${runId}-remediation-collector`,
    workspacePath: `repo://${runId}/remediation-notifications`,
    owner: `${runId}-remediation-owner`,
    team: `${runId}-remediation-team`,
    tags: [runId, 'notification-dispatch', 'remediation'],
  }, actorHeaders);
  assert('remediation notification source creation returns managed token', Boolean(created.source?.sourceId && created.token), created);
  return created;
}

async function createCoverageSource() {
  const created = await request('/sources', 'POST', {
    name: `${runId} coverage notification source`,
    type: 'webhook',
    enabled: true,
    requireToken: true,
    tokenRotationDays: 0,
    collectorId: `${runId}-coverage-collector`,
    workspacePath: `repo://${runId}/coverage-notifications`,
    owner: `${runId}-coverage-owner`,
    team: `${runId}-coverage-team`,
    tags: [runId, 'notification-dispatch', 'coverage'],
  }, actorHeaders);
  assert('coverage notification source creation returns managed token', Boolean(created.source?.sourceId && created.token), created);
  return created;
}

async function createCollectorSource() {
  const created = await request('/sources', 'POST', {
    name: `${runId} collector notification source`,
    type: 'webhook',
    enabled: true,
    requireToken: true,
    collectorId: `${runId}-collector-health`,
    workspacePath: `repo://${runId}/collector-notifications`,
    owner: `${runId}-collector-owner`,
    team: `${runId}-collector-team`,
    tags: [runId, 'notification-dispatch', 'collector'],
  }, actorHeaders);
  assert('collector notification source creation returns managed token', Boolean(created.source?.sourceId && created.token), created);
  return created;
}

async function createEventSource() {
  const created = await request('/sources', 'POST', {
    name: `${runId} event notification source`,
    type: 'webhook',
    enabled: true,
    requireToken: true,
    collectorId: `${runId}-event-collector`,
    workspacePath: `repo://${runId}/event-notifications`,
    owner: `${runId}-event-owner`,
    team: `${runId}-event-team`,
    tags: [runId, 'notification-dispatch', 'event'],
  }, actorHeaders);
  assert('event notification source creation returns managed token', Boolean(created.source?.sourceId && created.token), created);
  return created;
}

async function configureNotifications(sourceId, remediationSourceId, matchingUrl, sourceOwnerUrl, sourceTeamUrl, agentOwnerUrl, agentTeamUrl, remediationUrl, brokenUrl, quietUrl, owners) {
  const matchingChannel = await request('/notifications/channels', 'POST', {
    name: `${runId} matching webhook`,
    type: 'webhook',
    enabled: true,
    webhookUrl: matchingUrl,
    labels: { probe: runId, role: 'matching' },
  }, actorHeaders);
  const sourceOwnerChannel = await request('/notifications/channels', 'POST', {
    name: `${runId} source owner webhook`,
    type: 'webhook',
    enabled: true,
    webhookUrl: sourceOwnerUrl,
    labels: { probe: runId, role: 'source-owner' },
  }, actorHeaders);
  const sourceTeamChannel = await request('/notifications/channels', 'POST', {
    name: `${runId} source team webhook`,
    type: 'webhook',
    enabled: true,
    webhookUrl: sourceTeamUrl,
    labels: { probe: runId, role: 'source-team' },
  }, actorHeaders);
  const agentOwnerChannel = await request('/notifications/channels', 'POST', {
    name: `${runId} agent owner webhook`,
    type: 'webhook',
    enabled: true,
    webhookUrl: agentOwnerUrl,
    labels: { probe: runId, role: 'agent-owner' },
  }, actorHeaders);
  const agentTeamChannel = await request('/notifications/channels', 'POST', {
    name: `${runId} agent team webhook`,
    type: 'webhook',
    enabled: true,
    webhookUrl: agentTeamUrl,
    labels: { probe: runId, role: 'agent-team' },
  }, actorHeaders);
  const remediationChannel = await request('/notifications/channels', 'POST', {
    name: `${runId} remediation webhook`,
    type: 'webhook',
    enabled: true,
    webhookUrl: remediationUrl,
    labels: { probe: runId, role: 'remediation' },
  }, actorHeaders);
  const brokenChannel = await request('/notifications/channels', 'POST', {
    name: `${runId} broken webhook`,
    type: 'webhook',
    enabled: true,
    webhookUrl: brokenUrl,
    labels: { probe: runId, role: 'broken' },
  }, actorHeaders);
  const quietChannel = await request('/notifications/channels', 'POST', {
    name: `${runId} quiet webhook authorization: Bearer ${configTextSecret}`,
    type: 'webhook',
    enabled: true,
    webhookUrl: quietUrl,
    description: `${runId} quiet channel api_key=${configTextApiKey}`,
    labels: { probe: runId, role: 'quiet', credential: `password=${configTextSecret}` },
  }, actorHeaders);
  assert('notification channels are created', Boolean(matchingChannel.channelId && sourceOwnerChannel.channelId && sourceTeamChannel.channelId && agentOwnerChannel.channelId && agentTeamChannel.channelId && remediationChannel.channelId && brokenChannel.channelId && quietChannel.channelId), { matchingChannel, sourceOwnerChannel, sourceTeamChannel, agentOwnerChannel, agentTeamChannel, remediationChannel, brokenChannel, quietChannel });

  const matchingRoute = await request('/notifications/routes', 'POST', {
    name: `${runId} source health route`,
    enabled: true,
    channelIds: [matchingChannel.channelId],
    minSeverity: 'high',
    kinds: ['source'],
    sourceId,
    q: runId,
  }, actorHeaders);
  const sourceOwnerRoute = await request('/notifications/routes', 'POST', {
    name: `${runId} source owner route`,
    enabled: true,
    channelIds: [sourceOwnerChannel.channelId],
    minSeverity: 'high',
    kinds: ['source'],
    owner: owners.sourceOwner,
    q: runId,
  }, actorHeaders);
  const sourceTeamRoute = await request('/notifications/routes', 'POST', {
    name: `${runId} source team route`,
    enabled: true,
    channelIds: [sourceTeamChannel.channelId],
    minSeverity: 'high',
    kinds: ['source'],
    team: owners.sourceTeam,
    q: runId,
  }, actorHeaders);
  const agentOwnerRoute = await request('/notifications/routes', 'POST', {
    name: `${runId} agent owner route`,
    enabled: true,
    channelIds: [agentOwnerChannel.channelId],
    minSeverity: 'high',
    kinds: ['incident'],
    owner: owners.agentOwner,
    q: runId,
  }, actorHeaders);
  const agentTeamRoute = await request('/notifications/routes', 'POST', {
    name: `${runId} agent team route`,
    enabled: true,
    channelIds: [agentTeamChannel.channelId],
    minSeverity: 'high',
    kinds: ['incident'],
    team: owners.agentTeam,
    q: runId,
  }, actorHeaders);
  const remediationRoute = await request('/notifications/routes', 'POST', {
    name: `${runId} remediation overdue route`,
    enabled: true,
    channelIds: [remediationChannel.channelId],
    minSeverity: 'medium',
    kinds: ['remediation'],
    sourceId: remediationSourceId,
    owner: owners.remediationOwner,
  }, actorHeaders);
  const brokenRoute = await request('/notifications/routes', 'POST', {
    name: `${runId} broken delivery route`,
    enabled: true,
    channelIds: [brokenChannel.channelId],
    minSeverity: 'high',
    kinds: ['source'],
    sourceId,
    q: runId,
  }, actorHeaders);
  const quietRoute = await request('/notifications/routes', 'POST', {
    name: `${runId} unmatched route token=${configTextSecret}`,
    enabled: true,
    channelIds: [quietChannel.channelId],
    minSeverity: 'high',
    kinds: ['source'],
    sourceId: `${sourceId}-not-this-one`,
    owner: `${runId}-notification-owner`,
    q: `${runId}-never-match authorization: Bearer ${configTextSecret}`,
    description: `${runId} quiet route api_key=${configTextApiKey}`,
  }, actorHeaders);
  assert(
    'notification routes are created with source, owner, and team filters',
    matchingRoute.sourceId === sourceId &&
      sourceOwnerRoute.owner === owners.sourceOwner &&
      sourceTeamRoute.team === owners.sourceTeam &&
      agentOwnerRoute.owner === owners.agentOwner &&
      agentTeamRoute.team === owners.agentTeam &&
      remediationRoute.sourceId === remediationSourceId &&
      remediationRoute.owner === owners.remediationOwner &&
      remediationRoute.kinds?.includes('remediation') &&
      brokenRoute.sourceId === sourceId &&
      quietRoute.sourceId !== sourceId,
    { matchingRoute, sourceOwnerRoute, sourceTeamRoute, agentOwnerRoute, agentTeamRoute, remediationRoute, brokenRoute, quietRoute },
  );
  return { matchingChannel, sourceOwnerChannel, sourceTeamChannel, agentOwnerChannel, agentTeamChannel, remediationChannel, brokenChannel, quietChannel, matchingRoute, sourceOwnerRoute, sourceTeamRoute, agentOwnerRoute, agentTeamRoute, remediationRoute, brokenRoute, quietRoute };
}

async function triggerSourceAlert(source, token) {
  const result = await request('/sources/check-in', 'POST', {
    sourceId: source.sourceId,
    sourceName: source.name,
    sourceType: 'webhook',
    collectorId: `${runId}-collector`,
    workspacePath: `repo://${runId}/notifications`,
    token,
    status: 'error',
    message: `${runId} dispatch check-in error`,
  });
  assert('source check-in error is accepted for notification dispatch', result.accepted === true, result);
}

async function triggerSourceRecovery(source, token) {
  const result = await request('/sources/check-in', 'POST', {
    sourceId: source.sourceId,
    sourceName: source.name,
    sourceType: 'webhook',
    collectorId: `${runId}-collector`,
    workspacePath: `repo://${runId}/notifications`,
    token,
    status: 'ok',
    message: `${runId} dispatch check-in recovered`,
  });
  assert('source check-in recovery is accepted for notification dispatch', result.accepted === true, result);
}

async function triggerObjectiveRecovery(source, token, objectiveId) {
  await triggerSourceRecovery(source, token);
  return eventually('recovered objective after source heartbeat', async () => {
    const list = await request('/objectives/list', 'POST', { timeType: 'last_30d', objectiveId, limit: 20 });
    const objective = list.items?.find((item) => item.objectiveId === objectiveId && item.status === 'ok');
    return objective ? { list, objective } : undefined;
  });
}

async function alertWithNotification(sourceId) {
  return eventually('notified source alert', async () => {
    const list = await request('/alerts/list', 'POST', { timeType: 'last_30d', sourceId, status: 'all', kind: 'source', limit: 50 });
    const alert = list.items?.find((item) => item.sourceId === sourceId && item.ruleId === 'source.check_in_error' && item.lastNotificationAt);
    return alert ? { list, alert } : undefined;
  });
}

async function resolvedAlertWithNotification(sourceId, alertId) {
  return eventually('resolved source alert notification', async () => {
    const list = await request('/alerts/list', 'POST', { timeType: 'last_30d', sourceId, status: 'all', kind: 'source', limit: 50 });
    const alert = list.items?.find((item) => item.alertId === alertId && item.sourceId === sourceId && item.ruleId === 'source.check_in_error' && item.status === 'resolved' && item.resolvedAt && item.lastNotificationAt);
    return alert ? { list, alert } : undefined;
  });
}

async function manualAlertStateWithNotification(sourceId, alertId, status) {
  return eventually(`manual ${status} source alert notification`, async () => {
    const list = await request('/alerts/list', 'POST', { timeType: 'last_30d', sourceId, status: 'all', kind: 'source', limit: 50 });
    const alert = list.items?.find((item) => item.alertId === alertId && item.sourceId === sourceId && item.ruleId === 'source.check_in_error' && item.status === status && item.lastNotificationAt);
    return alert ? { list, alert } : undefined;
  });
}

async function channelStatus(channelId) {
  return eventually('notification channel delivery status', async () => {
    const config = await request(`/notifications/config?channelId=${encodeURIComponent(channelId)}`);
    const channel = config.channels?.find((item) => item.channelId === channelId);
    return channel?.lastStatus === 'ok' && channel.lastSentAt ? { config, channel } : undefined;
  });
}

async function deliveryRecord(channelId, alertId, action) {
  return eventually(`notification delivery record ${channelId}`, async () => {
    const config = await request(`/notifications/config?channelId=${encodeURIComponent(channelId)}&alertId=${encodeURIComponent(alertId)}&limit=20`);
    const delivery = config.deliveries?.find((item) => item.channelId === channelId && item.alertId === alertId && (!action || item.action === action));
    return delivery ? { config, delivery } : undefined;
  });
}

async function deliveryRecordByQuery(label, query, predicate) {
  return eventually(label, async () => {
    const params = new URLSearchParams({ ...query, limit: '20' });
    const config = await request(`/notifications/config?${params.toString()}`);
    const delivery = config.deliveries?.find(predicate);
    return delivery ? { config, delivery } : undefined;
  });
}

async function deliveryFailureAudit(deliveryId) {
  return eventually(`notification delivery failure audit ${deliveryId}`, async () => {
    const audit = await request('/audit/list', 'POST', {
      timeType: 'last_30d',
      resourceType: 'notification',
      resourceId: deliveryId,
      action: 'notification.delivery_failed',
      limit: 20,
    });
    const item = audit.items?.find((record) => record.resourceId === deliveryId && record.action === 'notification.delivery_failed');
    return item ? { audit, item } : undefined;
  });
}

async function installCriticalEventPolicy() {
  const current = await request('/config');
  const policy = current.policy ?? {};
  const rules = Array.isArray(policy.rules) ? policy.rules : [];
  const nextPolicy = {
    ...policy,
    rules: [
      ...rules,
      {
        name: eventPolicyRuleName,
        on: 'ToolExec',
        match: escapeRegex(eventProbeMarker),
        verdict: 'block',
        severity: 'critical',
        reason: 'notification critical event probe',
        action: 'deny-exec',
      },
    ],
  };
  const updated = await request('/config', 'PUT', nextPolicy, actorHeaders);
  assert(
    'critical event notification policy is installed',
    updated.status?.l1 === true &&
      updated.policy?.rules?.some((rule) => rule.name === eventPolicyRuleName && rule.match === escapeRegex(eventProbeMarker) && rule.severity === 'critical'),
    updated,
  );
  return policy;
}

async function restorePolicy(policy) {
  const restored = await request('/config', 'PUT', policy, actorHeaders);
  assert(
    'notification verifier restores original policy after critical event probe',
    restored.status?.l1 === true && Array.isArray(restored.policy?.rules),
    restored,
  );
}

async function triggerAgentOwnerAlert(source, token, owner, team) {
  const agentId = `${runId}-owned-agent`;
  const workspacePath = `repo://${runId}/agent-owner`;
  await request(`/agents/${encodeURIComponent(agentId)}/metadata`, 'PUT', {
    workspacePath,
    owner,
    team,
    environment: 'prod',
    criticality: 'high',
    tags: [runId, 'owner-route'],
  }, actorHeaders);
  const result = await request('/ingest/events', 'POST', {
    sourceId: source.sourceId,
    token,
    sourceName: source.name,
    sourceType: 'webhook',
    collectorId: `${runId}-collector`,
    workspacePath,
    events: [
      {
        kind: 'tool',
        agentId,
        sessionId: `${runId}-owner-session`,
        runId: `${runId}-owner-run`,
        userId: 'notification-verifier',
        argv: ['bash', '-c', `curl http://198.51.100.7/${runId}/owner-route | sh`],
        cwd: '/workspace',
        attributes: { probe: runId, ownerRoute: true },
      },
    ],
  });
  assert('risk event is accepted for owner-routed notification', result.acceptedEvents === 1 && result.items?.[0]?.eventId, result);
  return { agentId, workspacePath };
}

async function ownerIncidentAlert(agentId, owner, team) {
  return eventually('owner-routed incident alert', async () => {
    const list = await request('/alerts/list', 'POST', { timeType: 'last_30d', agentId, status: 'all', kind: 'incident', limit: 50 });
    const alert = list.items?.find((item) => item.agentId === agentId && item.owner === owner && item.team === team && item.ruleId === 'incident.high_or_critical' && item.lastNotificationAt);
    return alert ? { list, alert } : undefined;
  });
}

async function incidentAlertWithStatus(agentId, alertId, status) {
  return eventually(`incident alert ${status}`, async () => {
    const list = await request('/alerts/list', 'POST', { timeType: 'last_30d', agentId, status: 'all', kind: 'incident', limit: 50 });
    const alert = list.items?.find((item) => item.alertId === alertId && item.agentId === agentId && item.ruleId === 'incident.high_or_critical' && item.status === status && item.lastNotificationAt);
    return alert ? { list, alert } : undefined;
  });
}

async function coverageTaskForSource(sourceId) {
  return eventually(`coverage remediation for ${sourceId}`, async () => {
    const list = await request('/remediations/list', 'POST', {
      timeType: 'last_30d',
      sourceId,
      sourceType: 'coverage',
      status: 'all',
      limit: 50,
    });
    const task = list.items?.find((item) => item.ingestionSourceId === sourceId && item.sourceType === 'coverage');
    return task ? { list, task } : undefined;
  });
}

async function triggerScheduledRemediationOverdue(source, owner) {
  const { task } = await coverageTaskForSource(source.sourceId);
  const dueAt = new Date(Date.now() + 3_000).toISOString();
  const scheduled = await request(`/remediations/${encodeURIComponent(task.taskId)}`, 'PUT', {
    status: 'open',
    owner,
    note: `${runId} notification remediation overdue`,
    dueAt,
  }, actorHeaders);
  assert(
    'remediation notification task is scheduled for background overdue scan',
    scheduled.status === 'open' &&
      scheduled.owner === owner &&
      scheduled.dueAt === dueAt.slice(0, 19).replace('T', ' '),
    scheduled,
  );
  return { taskId: task.taskId, dueAt };
}

async function remediationAlertWithNotification(taskId, owner) {
  return eventually('notified remediation overdue alert', async () => {
    const list = await request('/alerts/list', 'POST', { timeType: 'last_30d', kind: 'remediation', status: 'all', taskId, limit: 50 });
    const alert = list.items?.find((item) => item.ruleId === 'remediation.overdue' && item.labels?.taskId === taskId && item.owner === owner && item.lastNotificationAt);
    return alert ? { list, alert } : undefined;
  }, 12000);
}

async function remediationAlertWithStatus(taskId, status) {
  return eventually(`remediation overdue alert ${status}`, async () => {
    const list = await request('/alerts/list', 'POST', { timeType: 'last_30d', kind: 'remediation', status: 'all', taskId, limit: 50 });
    const alert = list.items?.find((item) => item.ruleId === 'remediation.overdue' && item.labels?.taskId === taskId && item.status === status);
    return alert ? { list, alert } : undefined;
  }, 12000);
}

async function configureCoverageNotification(sourceId, coverageUrl) {
  const coverageChannel = await request('/notifications/channels', 'POST', {
    name: `${runId} coverage webhook`,
    type: 'webhook',
    enabled: true,
    webhookUrl: coverageUrl,
    labels: { probe: runId, role: 'coverage' },
  }, actorHeaders);
  const coverageRoute = await request('/notifications/routes', 'POST', {
    name: `${runId} coverage alert route`,
    enabled: true,
    channelIds: [coverageChannel.channelId],
    minSeverity: 'medium',
    kinds: ['coverage'],
    sourceId,
  }, actorHeaders);
  assert('coverage notification route is created', coverageRoute.kinds?.includes('coverage') && coverageRoute.sourceId === sourceId, { coverageChannel, coverageRoute });
  return { coverageChannel, coverageRoute };
}

async function configureCollectorNotification(collectorId, collectorUrl) {
  const collectorChannel = await request('/notifications/channels', 'POST', {
    name: `${runId} collector webhook`,
    type: 'webhook',
    enabled: true,
    webhookUrl: collectorUrl,
    labels: { probe: runId, role: 'collector' },
  }, actorHeaders);
  const collectorRoute = await request('/notifications/routes', 'POST', {
    name: `${runId} collector health route`,
    enabled: true,
    channelIds: [collectorChannel.channelId],
    minSeverity: 'high',
    kinds: ['collector'],
    collectorId,
    q: runId,
  }, actorHeaders);
  assert('collector notification route is created', collectorRoute.kinds?.includes('collector') && collectorRoute.collectorId === collectorId, { collectorChannel, collectorRoute });
  return { collectorChannel, collectorRoute };
}

async function configureEventNotification(sourceId, eventUrl) {
  const eventChannel = await request('/notifications/channels', 'POST', {
    name: `${runId} event webhook`,
    type: 'webhook',
    enabled: true,
    webhookUrl: eventUrl,
    labels: { probe: runId, role: 'event' },
  }, actorHeaders);
  const eventRoute = await request('/notifications/routes', 'POST', {
    name: `${runId} critical event route`,
    enabled: true,
    channelIds: [eventChannel.channelId],
    minSeverity: 'high',
    kinds: ['event'],
    sourceId,
  }, actorHeaders);
  assert('event notification route is created', eventRoute.kinds?.includes('event') && eventRoute.sourceId === sourceId, { eventChannel, eventRoute });
  return { eventChannel, eventRoute };
}

async function configureObjectiveNotification(sourceId, objectiveUrl) {
  const objectiveChannel = await request('/notifications/channels', 'POST', {
    name: `${runId} objective webhook`,
    type: 'webhook',
    enabled: true,
    webhookUrl: objectiveUrl,
    labels: { probe: runId, role: 'objective' },
  }, actorHeaders);
  const objectiveRoute = await request('/notifications/routes', 'POST', {
    name: `${runId} objective breach route`,
    enabled: true,
    channelIds: [objectiveChannel.channelId],
    minSeverity: 'high',
    kinds: ['objective'],
    sourceId,
    q: runId,
  }, actorHeaders);
  assert('objective notification route is created', objectiveRoute.kinds?.includes('objective') && objectiveRoute.sourceId === sourceId, { objectiveChannel, objectiveRoute });
  return { objectiveChannel, objectiveRoute };
}

async function triggerObjectiveAlert(sourceId) {
  const objective = await request('/objectives', 'POST', {
    name: `${runId} notification objective`,
    enabled: true,
    targetType: 'source',
    targetId: sourceId,
    metric: 'source_down',
    comparator: 'lte',
    threshold: 0,
    severity: 'high',
    owner: `${runId}-objective-owner`,
    description: `${runId} objective notification dispatch`,
  }, actorHeaders);
  assert(
    'objective notification trigger creates breached objective',
    objective.objectiveId && objective.status === 'breach' && objective.targetId === sourceId && objective.metric === 'source_down',
    objective,
  );
  return objective;
}

async function objectiveAlertWithNotification(objectiveId, sourceId) {
  return eventually('notified objective breach alert', async () => {
    const list = await request('/alerts/list', 'POST', { timeType: 'last_30d', sourceId, status: 'all', kind: 'objective', objectiveId, limit: 50 });
    const alert = list.items?.find((item) => item.ruleId === 'objective.breach' && item.labels?.objectiveId === objectiveId && item.sourceId === sourceId && item.lastNotificationAt);
    return alert ? { list, alert } : undefined;
  });
}

async function objectiveAlertWithStatus(objectiveId, sourceId, status) {
  return eventually(`objective breach alert ${status}`, async () => {
    const list = await request('/alerts/list', 'POST', { timeType: 'last_30d', sourceId, status: 'all', kind: 'objective', objectiveId, limit: 50 });
    const alert = list.items?.find((item) => item.ruleId === 'objective.breach' && item.labels?.objectiveId === objectiveId && item.sourceId === sourceId && item.status === status);
    return alert ? { list, alert } : undefined;
  });
}

async function triggerEventAlert(source, token) {
  const agentId = `${runId}-event-agent`;
  const workspacePath = source.workspacePath ?? `repo://${runId}/event-notifications`;
  const result = await request('/ingest/events', 'POST', {
    sourceId: source.sourceId,
    token,
    sourceName: source.name,
    sourceType: source.type,
    collectorId: source.collectorId,
    workspacePath,
    events: [
      {
        kind: 'tool',
        agentId,
        sessionId: `${runId}-event-session`,
        runId: `${runId}-event-run`,
        userId: 'notification-verifier',
        argv: ['bash', '-lc', `echo ${eventProbeMarker}`],
        cwd: '/workspace',
        attributes: { probe: runId, notificationRoute: 'event' },
      },
    ],
  });
  assert('critical blocked event is accepted for notification dispatch', result.acceptedEvents === 1 && result.items?.[0]?.eventId && result.items?.[0]?.verdict === 'block' && result.items?.[0]?.severity === 'critical', result);
  return { agentId, workspacePath, eventId: result.items[0].eventId };
}

async function eventAlertWithNotification(eventId, sourceId) {
  return eventually('notified critical event alert', async () => {
    const list = await request('/alerts/list', 'POST', { timeType: 'last_30d', sourceId, status: 'all', kind: 'event', eventId, limit: 50 });
    const alert = list.items?.find((item) => item.ruleId === 'event.critical_block' && item.eventId === eventId && item.sourceId === sourceId && item.lastNotificationAt);
    return alert ? { list, alert } : undefined;
  });
}

async function triggerCollectorAlert(source, token) {
  const result = await request('/collectors/heartbeat', 'POST', {
    sourceId: source.sourceId,
    token,
    sourceName: source.name,
    sourceType: source.type,
    collectorId: source.collectorId,
    workspacePath: source.workspacePath,
    nodeName: `${runId}-collector-node`,
    status: 'error',
    errorCount: 2,
    queueDepth: 7,
    droppedEvents: 1,
    message: `${runId} collector notification degraded`,
  });
  assert('collector heartbeat error is accepted for notification dispatch', result.accepted === true && result.collectorId === source.collectorId, result);
}

async function collectorAlertWithNotification(collectorId) {
  return eventually('notified collector health alert', async () => {
    const list = await request('/alerts/list', 'POST', { timeType: 'last_30d', collectorId, status: 'all', kind: 'collector', q: runId, limit: 50 });
    const alert = list.items?.find((item) => item.ruleId === 'collector.quality' && item.collectorId === collectorId && item.lastNotificationAt);
    return alert ? { list, alert } : undefined;
  });
}

async function triggerCoverageAlert(source, token) {
  const checkedIn = await request('/sources/check-in', 'POST', {
    sourceId: source.sourceId,
    sourceName: source.name,
    sourceType: source.type,
    token,
    collectorId: source.collectorId,
    workspacePath: source.workspacePath,
    status: 'ok',
  });
  assert('coverage notification source check-in is accepted', checkedIn.accepted === true && checkedIn.sourceId === source.sourceId, checkedIn);

  const coverage = await request('/coverage/overview', 'POST', {
    timeType: 'last_30d',
    sourceId: source.sourceId,
    type: 'source_token_rotation_due',
    limit: 20,
  });
  const issue = coverage.issues?.find((item) => item.sourceId === source.sourceId && item.type === 'source_token_rotation_due');
  assert('coverage notification trigger creates token rotation issue', issue?.severity === 'medium' && issue.issueId, { coverage, issue });
  return issue;
}

async function coverageAlertWithNotification(sourceId, issueId) {
  return eventually('notified coverage alert', async () => {
    const list = await request('/alerts/list', 'POST', { timeType: 'last_30d', sourceId, status: 'all', kind: 'coverage', issueId, limit: 50 });
    const alert = list.items?.find((item) => item.sourceId === sourceId && item.ruleId === 'coverage.issue' && item.labels?.issueId === issueId && item.lastNotificationAt);
    return alert ? { list, alert } : undefined;
  });
}

async function triggerCoverageRecovery(sourceId, issueId) {
  const updated = await request(`/sources/${encodeURIComponent(sourceId)}`, 'PUT', {
    tokenRotationDays: 30,
    note: `${runId} coverage notification recovery policy`,
  }, actorHeaders);
  assert('coverage notification source rotation policy is extended for recovery', updated.source?.sourceId === sourceId && updated.source?.tokenRotationDays === 30, updated);
  const rotated = await request(`/sources/${encodeURIComponent(sourceId)}/rotate-token`, 'POST', undefined, actorHeaders);
  assert('coverage notification source token rotation is accepted for recovery', rotated.source?.sourceId === sourceId && rotated.token, rotated);
  const coverage = await request('/coverage/overview', 'POST', {
    timeType: 'last_30d',
    sourceId,
    type: 'source_token_rotation_due',
    limit: 20,
  });
  const issue = coverage.issues?.find((item) => item.issueId === issueId);
  assert('coverage notification token rotation clears scoped issue', !issue, { coverage, issueId });
  return rotated;
}

async function coverageAlertWithStatus(sourceId, issueId, status) {
  return eventually(`coverage alert ${status}`, async () => {
    const list = await request('/alerts/list', 'POST', { timeType: 'last_30d', sourceId, status: 'all', kind: 'coverage', issueId, limit: 50 });
    const alert = list.items?.find((item) => item.sourceId === sourceId && item.ruleId === 'coverage.issue' && item.labels?.issueId === issueId && item.status === status);
    return alert ? { list, alert } : undefined;
  });
}

async function main() {
  console.log(`AnySentry notification dispatch verification against ${baseUrl}`);
  await request('/stats');

  const webhookSecret = `${runId}-webhook-secret`;
  const matchingWebhook = await startWebhook(`${runId}/matching/${webhookSecret}`);
  const sourceOwnerWebhook = await startWebhook(`${runId}/source-owner/${webhookSecret}`);
  const sourceTeamWebhook = await startWebhook(`${runId}/source-team/${webhookSecret}`);
  const agentOwnerWebhook = await startWebhook(`${runId}/agent-owner/${webhookSecret}`);
  const agentTeamWebhook = await startWebhook(`${runId}/agent-team/${webhookSecret}`);
  const remediationWebhook = await startWebhook(`${runId}/remediation/${webhookSecret}`);
  const coverageWebhook = await startWebhook(`${runId}/coverage/${webhookSecret}`);
  const collectorWebhook = await startWebhook(`${runId}/collector/${webhookSecret}`);
  const eventWebhook = await startWebhook(`${runId}/event/${webhookSecret}`);
  const objectiveWebhook = await startWebhook(`${runId}/objective/${webhookSecret}`);
  const quietWebhook = await startWebhook(`${runId}/quiet/${webhookSecret}`);

  try {
    const { source, token } = await createSource();
    const { source: remediationSource, token: remediationToken } = await createRemediationSource();
    const { source: coverageSource, token: coverageToken } = await createCoverageSource();
    const { source: collectorSource, token: collectorToken } = await createCollectorSource();
    const { source: eventSource, token: eventToken } = await createEventSource();
    const agentOwner = `${runId}-agent-owner`;
    const agentTeam = `${runId}-agent-team`;
    const brokenUrl = `http://127.0.0.1:9/${runId}/broken/${webhookSecret}`;
    const { matchingChannel, sourceOwnerChannel, sourceTeamChannel, agentOwnerChannel, agentTeamChannel, remediationChannel, brokenChannel, quietChannel, matchingRoute, agentOwnerRoute, agentTeamRoute, remediationRoute, brokenRoute, quietRoute } = await configureNotifications(
      source.sourceId,
      remediationSource.sourceId,
      `${matchingWebhook.url}/${webhookSecret}`,
      `${sourceOwnerWebhook.url}/${webhookSecret}`,
      `${sourceTeamWebhook.url}/${webhookSecret}`,
      `${agentOwnerWebhook.url}/${webhookSecret}`,
      `${agentTeamWebhook.url}/${webhookSecret}`,
      `${remediationWebhook.url}/${webhookSecret}`,
      brokenUrl,
      `${quietWebhook.url}/${webhookSecret}`,
      { sourceOwner: source.owner, sourceTeam: source.team, agentOwner, agentTeam, remediationOwner: remediationSource.owner },
    );
    const { coverageChannel, coverageRoute } = await configureCoverageNotification(coverageSource.sourceId, `${coverageWebhook.url}/${webhookSecret}`);
    const { collectorChannel, collectorRoute } = await configureCollectorNotification(collectorSource.collectorId, `${collectorWebhook.url}/${webhookSecret}`);
    const { eventChannel, eventRoute } = await configureEventNotification(eventSource.sourceId, `${eventWebhook.url}/${webhookSecret}`);
    const { objectiveChannel, objectiveRoute } = await configureObjectiveNotification(source.sourceId, `${objectiveWebhook.url}/${webhookSecret}`);

    const objective = await triggerObjectiveAlert(source.sourceId);
    const objectiveDelivery = await eventually('objective breach webhook delivery', () => objectiveWebhook.deliveries[0]);
    assert('objective notification webhook receives exactly one breach alert', objectiveWebhook.deliveries.length === 1, objectiveWebhook.deliveries);
    assert(
      'objective route receives objective breach payload',
      objectiveDelivery.method === 'POST' &&
        objectiveDelivery.payload?.schemaVersion === 'anysentry.alert.v1' &&
        objectiveDelivery.payload?.action === 'opened' &&
        objectiveDelivery.payload?.route?.channelId === objectiveChannel.channelId &&
        objectiveDelivery.payload?.route?.routeId === objectiveRoute.routeId &&
        objectiveDelivery.payload?.alert?.kind === 'objective' &&
        objectiveDelivery.payload?.alert?.ruleId === 'objective.breach' &&
        objectiveDelivery.payload?.alert?.sourceId === source.sourceId &&
        objectiveDelivery.payload?.alert?.owner === objective.owner &&
        objectiveDelivery.payload?.alert?.labels?.objectiveId === objective.objectiveId &&
        objectiveDelivery.payload?.alert?.labels?.metric === 'source_down',
      objectiveDelivery,
    );
    const encodedObjectivePayload = JSON.stringify(objectiveDelivery.payload);
    assert('objective notification payload does not leak source token or webhook secret', !encodedObjectivePayload.includes(token) && !encodedObjectivePayload.includes(webhookSecret), objectiveDelivery.payload);
    const notifiedObjectiveAlert = await objectiveAlertWithNotification(objective.objectiveId, source.sourceId);
    assert('objective breach alert records last notification timestamp', notifiedObjectiveAlert.alert.lastNotificationAt && notifiedObjectiveAlert.alert.status === 'open', notifiedObjectiveAlert);
    const objectiveDeliveryRecord = await deliveryRecord(objectiveChannel.channelId, notifiedObjectiveAlert.alert.alertId);
    assert(
      'objective notification delivery log records routed alert',
      objectiveDeliveryRecord.delivery.status === 'ok' &&
        objectiveDeliveryRecord.delivery.routeId === objectiveRoute.routeId &&
        objectiveDeliveryRecord.delivery.alertKind === 'objective' &&
        objectiveDeliveryRecord.delivery.sourceId === source.sourceId &&
        objectiveDeliveryRecord.delivery.objectiveId === objective.objectiveId,
      objectiveDeliveryRecord,
    );
    const objectiveDeliveryByObjective = await deliveryRecordByQuery(
      'notification config filters delivery rows by objectiveId',
      { objectiveId: objective.objectiveId },
      (item) => item.deliveryId === objectiveDeliveryRecord.delivery.deliveryId && item.objectiveId === objective.objectiveId,
    );
    assert('objectiveId notification filter returns the objective delivery', objectiveDeliveryByObjective.delivery.deliveryId === objectiveDeliveryRecord.delivery.deliveryId, objectiveDeliveryByObjective);

    await triggerCollectorAlert(collectorSource, collectorToken);
    const collectorDelivery = await eventually('collector health webhook delivery', () => collectorWebhook.deliveries[0]);
    assert('collector notification webhook receives exactly one health alert', collectorWebhook.deliveries.length === 1, collectorWebhook.deliveries);
    assert(
      'collector route receives collector health payload',
      collectorDelivery.method === 'POST' &&
        collectorDelivery.payload?.schemaVersion === 'anysentry.alert.v1' &&
        collectorDelivery.payload?.action === 'opened' &&
        collectorDelivery.payload?.route?.channelId === collectorChannel.channelId &&
        collectorDelivery.payload?.route?.routeId === collectorRoute.routeId &&
        collectorDelivery.payload?.alert?.kind === 'collector' &&
        collectorDelivery.payload?.alert?.ruleId === 'collector.quality' &&
        collectorDelivery.payload?.alert?.collectorId === collectorSource.collectorId &&
        collectorDelivery.payload?.alert?.labels?.status === 'error' &&
        collectorDelivery.payload?.alert?.labels?.errorCount === '2',
      collectorDelivery,
    );
    const encodedCollectorPayload = JSON.stringify(collectorDelivery.payload);
    assert('collector notification payload does not leak source token or webhook secret', !encodedCollectorPayload.includes(collectorToken) && !encodedCollectorPayload.includes(webhookSecret), collectorDelivery.payload);
    const notifiedCollectorAlert = await collectorAlertWithNotification(collectorSource.collectorId);
    assert('collector health alert records last notification timestamp', notifiedCollectorAlert.alert.lastNotificationAt && notifiedCollectorAlert.alert.status === 'open', notifiedCollectorAlert);
    const collectorDeliveryRecord = await deliveryRecord(collectorChannel.channelId, notifiedCollectorAlert.alert.alertId);
    assert(
      'collector notification delivery log records routed alert',
      collectorDeliveryRecord.delivery.status === 'ok' &&
        collectorDeliveryRecord.delivery.routeId === collectorRoute.routeId &&
        collectorDeliveryRecord.delivery.alertKind === 'collector' &&
        collectorDeliveryRecord.delivery.collectorId === collectorSource.collectorId,
      collectorDeliveryRecord,
    );

    const originalPolicy = await installCriticalEventPolicy();
    let eventSignal;
    try {
      eventSignal = await triggerEventAlert(eventSource, eventToken);
    } finally {
      await restorePolicy(originalPolicy);
    }
    const eventDelivery = await eventually('critical event webhook delivery', () => eventWebhook.deliveries[0]);
    assert('event notification webhook receives exactly one critical event alert', eventWebhook.deliveries.length === 1, eventWebhook.deliveries);
    assert(
      'event route receives critical block payload',
      eventDelivery.method === 'POST' &&
        eventDelivery.payload?.schemaVersion === 'anysentry.alert.v1' &&
        eventDelivery.payload?.action === 'opened' &&
        eventDelivery.payload?.route?.channelId === eventChannel.channelId &&
        eventDelivery.payload?.route?.routeId === eventRoute.routeId &&
        eventDelivery.payload?.alert?.kind === 'event' &&
        eventDelivery.payload?.alert?.ruleId === 'event.critical_block' &&
        eventDelivery.payload?.alert?.sourceId === eventSource.sourceId &&
        eventDelivery.payload?.alert?.agentId === eventSignal.agentId &&
        eventDelivery.payload?.alert?.eventId === eventSignal.eventId &&
        eventDelivery.payload?.alert?.labels?.verdict === 'block' &&
        eventDelivery.payload?.alert?.labels?.eventKind === 'ToolExec',
      eventDelivery,
    );
    const encodedEventPayload = JSON.stringify(eventDelivery.payload);
    assert('event notification payload does not leak source token or webhook secret', !encodedEventPayload.includes(eventToken) && !encodedEventPayload.includes(webhookSecret), eventDelivery.payload);
    const notifiedEventAlert = await eventAlertWithNotification(eventSignal.eventId, eventSource.sourceId);
    assert('critical event alert records last notification timestamp', notifiedEventAlert.alert.lastNotificationAt && notifiedEventAlert.alert.status === 'open', notifiedEventAlert);
    const eventDeliveryRecord = await deliveryRecord(eventChannel.channelId, notifiedEventAlert.alert.alertId);
    assert(
      'event notification delivery log records routed alert',
      eventDeliveryRecord.delivery.status === 'ok' &&
        eventDeliveryRecord.delivery.routeId === eventRoute.routeId &&
        eventDeliveryRecord.delivery.alertKind === 'event' &&
        eventDeliveryRecord.delivery.sourceId === eventSource.sourceId &&
        eventDeliveryRecord.delivery.agentId === eventSignal.agentId &&
        eventDeliveryRecord.delivery.eventId === eventSignal.eventId,
      eventDeliveryRecord,
    );
    const eventDeliveryByEvent = await deliveryRecordByQuery(
      'notification config filters delivery rows by eventId',
      { eventId: eventSignal.eventId },
      (item) => item.deliveryId === eventDeliveryRecord.delivery.deliveryId && item.eventId === eventSignal.eventId,
    );
    assert('eventId notification filter returns the event delivery', eventDeliveryByEvent.delivery.deliveryId === eventDeliveryRecord.delivery.deliveryId, eventDeliveryByEvent);

    await triggerSourceAlert(source, token);
    const delivery = await eventually('matching webhook delivery', () => matchingWebhook.deliveries[0]);
    const sourceOwnerDelivery = await eventually('source owner webhook delivery', () => sourceOwnerWebhook.deliveries[0]);
    const sourceTeamDelivery = await eventually('source team webhook delivery', () => sourceTeamWebhook.deliveries[0]);
    await sleep(500);

    assert('matching notification webhook receives exactly one alert', matchingWebhook.deliveries.length === 1, matchingWebhook.deliveries);
    assert('source owner notification webhook receives exactly one alert', sourceOwnerWebhook.deliveries.length === 1, sourceOwnerWebhook.deliveries);
    assert('source team notification webhook receives exactly one alert', sourceTeamWebhook.deliveries.length === 1, sourceTeamWebhook.deliveries);
    assert('unmatched notification route does not dispatch', quietWebhook.deliveries.length === 0, quietWebhook.deliveries);
    assert(
      'notification webhook receives source alert payload',
      delivery.method === 'POST' &&
        delivery.payload?.schemaVersion === 'anysentry.alert.v1' &&
        delivery.payload?.action === 'opened' &&
        delivery.payload?.route?.channelId === matchingChannel.channelId &&
        delivery.payload?.route?.routeId === matchingRoute.routeId &&
        delivery.payload?.alert?.sourceId === source.sourceId &&
        delivery.payload?.alert?.kind === 'source' &&
        delivery.payload?.alert?.ruleId === 'source.check_in_error' &&
        delivery.payload?.alert?.severity === 'high' &&
        delivery.payload?.alert?.status === 'open' &&
        delivery.payload?.alert?.owner === source.owner &&
        delivery.payload?.alert?.team === source.team,
      delivery,
    );
    assert(
      'source owner route receives owner-populated source alert payload',
      sourceOwnerDelivery.payload?.route?.channelId === sourceOwnerChannel.channelId &&
        sourceOwnerDelivery.payload?.alert?.sourceId === source.sourceId &&
        sourceOwnerDelivery.payload?.alert?.owner === source.owner &&
        sourceOwnerDelivery.payload?.alert?.kind === 'source',
      sourceOwnerDelivery,
    );
    assert(
      'source team route receives team-populated source alert payload',
      sourceTeamDelivery.payload?.route?.channelId === sourceTeamChannel.channelId &&
        sourceTeamDelivery.payload?.alert?.sourceId === source.sourceId &&
        sourceTeamDelivery.payload?.alert?.team === source.team &&
        sourceTeamDelivery.payload?.alert?.kind === 'source',
      sourceTeamDelivery,
    );
    const encodedPayload = JSON.stringify(delivery.payload);
    const encodedOwnerPayload = JSON.stringify(sourceOwnerDelivery.payload);
    const encodedTeamPayload = JSON.stringify(sourceTeamDelivery.payload);
    assert('notification payload does not leak source token or webhook secret', !encodedPayload.includes(token) && !encodedPayload.includes(webhookSecret) && !encodedOwnerPayload.includes(token) && !encodedOwnerPayload.includes(webhookSecret) && !encodedTeamPayload.includes(token) && !encodedTeamPayload.includes(webhookSecret), { delivery: delivery.payload, sourceOwnerDelivery: sourceOwnerDelivery.payload, sourceTeamDelivery: sourceTeamDelivery.payload });

    const notifiedAlert = await alertWithNotification(source.sourceId);
    assert('alert records owner, team, and last notification timestamp', notifiedAlert.alert.lastNotificationAt && notifiedAlert.alert.status === 'open' && notifiedAlert.alert.owner === source.owner && notifiedAlert.alert.team === source.team, notifiedAlert);
    const matchingDeliveryRecord = await deliveryRecord(matchingChannel.channelId, notifiedAlert.alert.alertId);
    const encodedDeliveryRecord = JSON.stringify(matchingDeliveryRecord);
    assert(
      'notification delivery log records source alert route and channel',
      matchingDeliveryRecord.delivery.status === 'ok' &&
        matchingDeliveryRecord.delivery.channelId === matchingChannel.channelId &&
        matchingDeliveryRecord.delivery.routeId === matchingRoute.routeId &&
        matchingDeliveryRecord.delivery.alertId === notifiedAlert.alert.alertId &&
        matchingDeliveryRecord.delivery.alertKind === 'source' &&
        matchingDeliveryRecord.delivery.alertRuleId === 'source.check_in_error' &&
        matchingDeliveryRecord.config.summary.okDeliveries >= 1 &&
        !encodedDeliveryRecord.includes(token) &&
        !encodedDeliveryRecord.includes(webhookSecret),
      matchingDeliveryRecord,
    );
    const brokenDeliveryRecord = await deliveryRecord(brokenChannel.channelId, notifiedAlert.alert.alertId);
    const encodedBrokenDeliveryRecord = JSON.stringify(brokenDeliveryRecord);
    assert(
      'notification delivery log records webhook errors without leaking secrets',
      brokenDeliveryRecord.delivery.status === 'error' &&
        brokenDeliveryRecord.delivery.channelId === brokenChannel.channelId &&
        brokenDeliveryRecord.delivery.routeId === brokenRoute.routeId &&
        brokenDeliveryRecord.delivery.alertId === notifiedAlert.alert.alertId &&
        brokenDeliveryRecord.delivery.alertKind === 'source' &&
        brokenDeliveryRecord.config.summary.errorDeliveries >= 1 &&
        !encodedBrokenDeliveryRecord.includes(token) &&
        !encodedBrokenDeliveryRecord.includes(webhookSecret),
      brokenDeliveryRecord,
    );
    const brokenDeliveryAudit = await deliveryFailureAudit(brokenDeliveryRecord.delivery.deliveryId);
    const encodedBrokenDeliveryAudit = JSON.stringify(brokenDeliveryAudit);
    assert(
      'notification delivery failures are recorded in audit without leaking secrets',
      brokenDeliveryAudit.item.result === 'failure' &&
        brokenDeliveryAudit.item.resourceType === 'notification' &&
        brokenDeliveryAudit.item.resourceId === brokenDeliveryRecord.delivery.deliveryId &&
        brokenDeliveryAudit.item.details?.deliveryId === brokenDeliveryRecord.delivery.deliveryId &&
        brokenDeliveryAudit.item.details?.alertId === notifiedAlert.alert.alertId &&
        brokenDeliveryAudit.item.details?.channelId === brokenChannel.channelId &&
        brokenDeliveryAudit.item.details?.routeId === brokenRoute.routeId &&
        brokenDeliveryAudit.item.details?.sourceId === source.sourceId &&
        brokenDeliveryAudit.item.details?.workspacePath === source.workspacePath &&
        brokenDeliveryAudit.item.details?.status === 'error' &&
        !encodedBrokenDeliveryAudit.includes(token) &&
        !encodedBrokenDeliveryAudit.includes(webhookSecret),
      brokenDeliveryAudit,
    );

    const recoveredObjective = await triggerObjectiveRecovery(source, token, objective.objectiveId);
    assert('objective notification source_down recovers after source heartbeat', recoveredObjective.objective.status === 'ok', recoveredObjective);
    const resolvedDelivery = await eventually('resolved source webhook delivery', () => matchingWebhook.deliveries[1]);
    assert('matching notification webhook receives resolved source alert', matchingWebhook.deliveries.length === 2, matchingWebhook.deliveries);
    assert(
      'notification webhook receives resolved source alert payload',
      resolvedDelivery.method === 'POST' &&
        resolvedDelivery.payload?.schemaVersion === 'anysentry.alert.v1' &&
        resolvedDelivery.payload?.action === 'resolved' &&
        resolvedDelivery.payload?.route?.channelId === matchingChannel.channelId &&
        resolvedDelivery.payload?.route?.routeId === matchingRoute.routeId &&
        resolvedDelivery.payload?.alert?.alertId === notifiedAlert.alert.alertId &&
        resolvedDelivery.payload?.alert?.sourceId === source.sourceId &&
        resolvedDelivery.payload?.alert?.kind === 'source' &&
        resolvedDelivery.payload?.alert?.ruleId === 'source.check_in_error' &&
        resolvedDelivery.payload?.alert?.status === 'resolved' &&
        resolvedDelivery.payload?.alert?.resolvedAt,
      resolvedDelivery,
    );
    const encodedResolvedPayload = JSON.stringify(resolvedDelivery.payload);
    assert('resolved notification payload does not leak source token or webhook secret', !encodedResolvedPayload.includes(token) && !encodedResolvedPayload.includes(webhookSecret), resolvedDelivery.payload);
    const resolvedAlert = await resolvedAlertWithNotification(source.sourceId, notifiedAlert.alert.alertId);
    assert('resolved source alert records recovery notification timestamp', resolvedAlert.alert.status === 'resolved' && resolvedAlert.alert.resolvedAt && resolvedAlert.alert.lastNotificationAt, resolvedAlert);
    const resolvedDeliveryRecord = await deliveryRecord(matchingChannel.channelId, notifiedAlert.alert.alertId, 'resolved');
    const encodedResolvedDeliveryRecord = JSON.stringify(resolvedDeliveryRecord);
    assert(
      'notification delivery log records resolved source alert route and channel',
      resolvedDeliveryRecord.delivery.status === 'ok' &&
        resolvedDeliveryRecord.delivery.action === 'resolved' &&
        resolvedDeliveryRecord.delivery.channelId === matchingChannel.channelId &&
        resolvedDeliveryRecord.delivery.routeId === matchingRoute.routeId &&
        resolvedDeliveryRecord.delivery.alertId === notifiedAlert.alert.alertId &&
        resolvedDeliveryRecord.delivery.alertKind === 'source' &&
        resolvedDeliveryRecord.delivery.alertRuleId === 'source.check_in_error' &&
        !encodedResolvedDeliveryRecord.includes(token) &&
        !encodedResolvedDeliveryRecord.includes(webhookSecret),
      resolvedDeliveryRecord,
    );
    const objectiveResolvedDelivery = await eventually('resolved objective webhook delivery', () => objectiveWebhook.deliveries[1]);
    assert('objective notification webhook receives resolved breach alert', objectiveWebhook.deliveries.length === 2, objectiveWebhook.deliveries);
    assert(
      'objective route receives resolved breach payload',
      objectiveResolvedDelivery.method === 'POST' &&
        objectiveResolvedDelivery.payload?.schemaVersion === 'anysentry.alert.v1' &&
        objectiveResolvedDelivery.payload?.action === 'resolved' &&
        objectiveResolvedDelivery.payload?.route?.channelId === objectiveChannel.channelId &&
        objectiveResolvedDelivery.payload?.route?.routeId === objectiveRoute.routeId &&
        objectiveResolvedDelivery.payload?.alert?.alertId === notifiedObjectiveAlert.alert.alertId &&
        objectiveResolvedDelivery.payload?.alert?.kind === 'objective' &&
        objectiveResolvedDelivery.payload?.alert?.status === 'resolved' &&
        objectiveResolvedDelivery.payload?.alert?.resolvedAt &&
        objectiveResolvedDelivery.payload?.alert?.labels?.objectiveId === objective.objectiveId,
      objectiveResolvedDelivery,
    );
    const encodedObjectiveResolvedPayload = JSON.stringify(objectiveResolvedDelivery.payload);
    assert('resolved objective notification payload does not leak source token or webhook secret', !encodedObjectiveResolvedPayload.includes(token) && !encodedObjectiveResolvedPayload.includes(webhookSecret), objectiveResolvedDelivery.payload);
    const resolvedObjectiveAlert = await objectiveAlertWithStatus(objective.objectiveId, source.sourceId, 'resolved');
    assert('resolved objective alert records recovery notification state', resolvedObjectiveAlert.alert.resolvedAt && resolvedObjectiveAlert.alert.lastNotificationAt, resolvedObjectiveAlert);
    const objectiveResolvedDeliveryRecord = await deliveryRecord(objectiveChannel.channelId, notifiedObjectiveAlert.alert.alertId, 'resolved');
    assert(
      'objective notification delivery log records resolved breach alert',
      objectiveResolvedDeliveryRecord.delivery.status === 'ok' &&
        objectiveResolvedDeliveryRecord.delivery.action === 'resolved' &&
        objectiveResolvedDeliveryRecord.delivery.routeId === objectiveRoute.routeId &&
        objectiveResolvedDeliveryRecord.delivery.objectiveId === objective.objectiveId,
      objectiveResolvedDeliveryRecord,
    );

    const manuallyReopenedAlert = await request(`/alerts/${encodeURIComponent(notifiedAlert.alert.alertId)}`, 'PUT', {
      status: 'open',
      owner: source.owner,
      note: `${runId} manual reopen notification`,
    }, actorHeaders);
    assert('manual alert reopen is accepted for notification dispatch', manuallyReopenedAlert.status === 'open' && manuallyReopenedAlert.alertId === notifiedAlert.alert.alertId && !manuallyReopenedAlert.resolvedAt, manuallyReopenedAlert);
    const manualReopenDelivery = await eventually('manual reopened source webhook delivery', () => matchingWebhook.deliveries[2]);
    assert('matching notification webhook receives manual reopened source alert', matchingWebhook.deliveries.length === 3, matchingWebhook.deliveries);
    assert(
      'notification webhook receives manual reopened source alert payload',
      manualReopenDelivery.method === 'POST' &&
        manualReopenDelivery.payload?.schemaVersion === 'anysentry.alert.v1' &&
        manualReopenDelivery.payload?.action === 'reopened' &&
        manualReopenDelivery.payload?.route?.channelId === matchingChannel.channelId &&
        manualReopenDelivery.payload?.route?.routeId === matchingRoute.routeId &&
        manualReopenDelivery.payload?.alert?.alertId === notifiedAlert.alert.alertId &&
        manualReopenDelivery.payload?.alert?.sourceId === source.sourceId &&
        manualReopenDelivery.payload?.alert?.kind === 'source' &&
        manualReopenDelivery.payload?.alert?.ruleId === 'source.check_in_error' &&
        manualReopenDelivery.payload?.alert?.status === 'open',
      manualReopenDelivery,
    );
    const encodedManualReopenPayload = JSON.stringify(manualReopenDelivery.payload);
    assert('manual reopened notification payload does not leak source token or webhook secret', !encodedManualReopenPayload.includes(token) && !encodedManualReopenPayload.includes(webhookSecret), manualReopenDelivery.payload);
    const manualReopenedAlert = await manualAlertStateWithNotification(source.sourceId, notifiedAlert.alert.alertId, 'open');
    assert('manual reopened source alert records notification timestamp', manualReopenedAlert.alert.status === 'open' && manualReopenedAlert.alert.lastNotificationAt, manualReopenedAlert);
    const manualReopenDeliveryRecord = await deliveryRecord(matchingChannel.channelId, notifiedAlert.alert.alertId, 'reopened');
    assert(
      'notification delivery log records manual reopened source alert',
      manualReopenDeliveryRecord.delivery.status === 'ok' &&
        manualReopenDeliveryRecord.delivery.action === 'reopened' &&
        manualReopenDeliveryRecord.delivery.routeId === matchingRoute.routeId &&
        manualReopenDeliveryRecord.delivery.alertId === notifiedAlert.alert.alertId,
      manualReopenDeliveryRecord,
    );

    const manuallyResolvedAlert = await request(`/alerts/${encodeURIComponent(notifiedAlert.alert.alertId)}`, 'PUT', {
      status: 'resolved',
      owner: source.owner,
      note: `${runId} manual resolve notification`,
    }, actorHeaders);
    assert('manual alert resolve is accepted for notification dispatch', manuallyResolvedAlert.status === 'resolved' && manuallyResolvedAlert.alertId === notifiedAlert.alert.alertId && manuallyResolvedAlert.resolvedAt, manuallyResolvedAlert);
    const manualResolveDelivery = await eventually('manual resolved source webhook delivery', () => matchingWebhook.deliveries[3]);
    assert('matching notification webhook receives manual resolved source alert', matchingWebhook.deliveries.length === 4, matchingWebhook.deliveries);
    assert(
      'notification webhook receives manual resolved source alert payload',
      manualResolveDelivery.method === 'POST' &&
        manualResolveDelivery.payload?.schemaVersion === 'anysentry.alert.v1' &&
        manualResolveDelivery.payload?.action === 'resolved' &&
        manualResolveDelivery.payload?.route?.channelId === matchingChannel.channelId &&
        manualResolveDelivery.payload?.route?.routeId === matchingRoute.routeId &&
        manualResolveDelivery.payload?.alert?.alertId === notifiedAlert.alert.alertId &&
        manualResolveDelivery.payload?.alert?.sourceId === source.sourceId &&
        manualResolveDelivery.payload?.alert?.kind === 'source' &&
        manualResolveDelivery.payload?.alert?.ruleId === 'source.check_in_error' &&
        manualResolveDelivery.payload?.alert?.status === 'resolved' &&
        manualResolveDelivery.payload?.alert?.resolvedAt,
      manualResolveDelivery,
    );
    const encodedManualResolvePayload = JSON.stringify(manualResolveDelivery.payload);
    assert('manual resolved notification payload does not leak source token or webhook secret', !encodedManualResolvePayload.includes(token) && !encodedManualResolvePayload.includes(webhookSecret), manualResolveDelivery.payload);
    const manualResolvedAlert = await manualAlertStateWithNotification(source.sourceId, notifiedAlert.alert.alertId, 'resolved');
    assert('manual resolved source alert records notification timestamp', manualResolvedAlert.alert.status === 'resolved' && manualResolvedAlert.alert.resolvedAt && manualResolvedAlert.alert.lastNotificationAt, manualResolvedAlert);
    const manualResolveDeliveryRecord = await deliveryRecord(matchingChannel.channelId, notifiedAlert.alert.alertId, 'resolved');
    assert(
      'notification delivery log records manual resolved source alert',
      manualResolveDeliveryRecord.delivery.status === 'ok' &&
        manualResolveDeliveryRecord.delivery.action === 'resolved' &&
        manualResolveDeliveryRecord.delivery.routeId === matchingRoute.routeId &&
        manualResolveDeliveryRecord.delivery.alertId === notifiedAlert.alert.alertId,
      manualResolveDeliveryRecord,
    );

    const ownerRisk = await triggerAgentOwnerAlert(source, token, agentOwner, agentTeam);
    const agentOwnerDelivery = await eventually('agent owner webhook delivery', () => agentOwnerWebhook.deliveries[0]);
    const agentTeamDelivery = await eventually('agent team webhook delivery', () => agentTeamWebhook.deliveries[0]);
    assert(
      'agent owner route receives owner-populated incident alert payload',
      agentOwnerDelivery.payload?.route?.channelId === agentOwnerChannel.channelId &&
        agentOwnerDelivery.payload?.alert?.kind === 'incident' &&
        agentOwnerDelivery.payload?.alert?.agentId === ownerRisk.agentId &&
        agentOwnerDelivery.payload?.alert?.owner === agentOwner,
      agentOwnerDelivery,
    );
    assert(
      'agent team route receives team-populated incident alert payload',
      agentTeamDelivery.payload?.route?.channelId === agentTeamChannel.channelId &&
        agentTeamDelivery.payload?.alert?.kind === 'incident' &&
        agentTeamDelivery.payload?.alert?.agentId === ownerRisk.agentId &&
        agentTeamDelivery.payload?.alert?.team === agentTeam,
      agentTeamDelivery,
    );
    const ownerAlert = await ownerIncidentAlert(ownerRisk.agentId, agentOwner, agentTeam);
    assert('incident alert inherits Agent metadata owner and team for routing', ownerAlert.alert.owner === agentOwner && ownerAlert.alert.team === agentTeam && ownerAlert.alert.lastNotificationAt, ownerAlert);
    assert('owner-routed incident alert links the source incident', Boolean(ownerAlert.alert.incidentId), ownerAlert);

    const resolvedIncident = await request(`/incidents/${encodeURIComponent(ownerAlert.alert.incidentId)}`, 'PUT', {
      status: 'resolved',
      owner: agentOwner,
      note: `${runId} incident resolved for notification lifecycle`,
    }, actorHeaders);
    assert('manual incident resolve is accepted for notification dispatch', resolvedIncident.status === 'resolved' && resolvedIncident.incidentId === ownerAlert.alert.incidentId && resolvedIncident.resolvedAt, resolvedIncident);
    const agentOwnerResolvedDelivery = await eventually('agent owner resolved incident webhook delivery', () => agentOwnerWebhook.deliveries[1]);
    const agentTeamResolvedDelivery = await eventually('agent team resolved incident webhook delivery', () => agentTeamWebhook.deliveries[1]);
    assert('agent owner and team webhooks receive resolved incident alert', agentOwnerWebhook.deliveries.length === 2 && agentTeamWebhook.deliveries.length === 2, { agentOwner: agentOwnerWebhook.deliveries, agentTeam: agentTeamWebhook.deliveries });
    assert(
      'agent owner route receives resolved incident alert payload',
      agentOwnerResolvedDelivery.payload?.schemaVersion === 'anysentry.alert.v1' &&
        agentOwnerResolvedDelivery.payload?.action === 'resolved' &&
        agentOwnerResolvedDelivery.payload?.route?.channelId === agentOwnerChannel.channelId &&
        agentOwnerResolvedDelivery.payload?.route?.routeId === agentOwnerRoute.routeId &&
        agentOwnerResolvedDelivery.payload?.alert?.kind === 'incident' &&
        agentOwnerResolvedDelivery.payload?.alert?.alertId === ownerAlert.alert.alertId &&
        agentOwnerResolvedDelivery.payload?.alert?.incidentId === ownerAlert.alert.incidentId &&
        agentOwnerResolvedDelivery.payload?.alert?.status === 'resolved' &&
        agentOwnerResolvedDelivery.payload?.alert?.resolvedAt,
      agentOwnerResolvedDelivery,
    );
    assert(
      'agent team route receives resolved incident alert payload',
      agentTeamResolvedDelivery.payload?.schemaVersion === 'anysentry.alert.v1' &&
        agentTeamResolvedDelivery.payload?.action === 'resolved' &&
        agentTeamResolvedDelivery.payload?.route?.channelId === agentTeamChannel.channelId &&
        agentTeamResolvedDelivery.payload?.route?.routeId === agentTeamRoute.routeId &&
        agentTeamResolvedDelivery.payload?.alert?.kind === 'incident' &&
        agentTeamResolvedDelivery.payload?.alert?.alertId === ownerAlert.alert.alertId &&
        agentTeamResolvedDelivery.payload?.alert?.incidentId === ownerAlert.alert.incidentId &&
        agentTeamResolvedDelivery.payload?.alert?.status === 'resolved' &&
        agentTeamResolvedDelivery.payload?.alert?.resolvedAt,
      agentTeamResolvedDelivery,
    );
    const encodedResolvedIncidentPayloads = JSON.stringify({ agentOwnerResolvedDelivery: agentOwnerResolvedDelivery.payload, agentTeamResolvedDelivery: agentTeamResolvedDelivery.payload });
    assert('resolved incident notification payloads do not leak source token or webhook secret', !encodedResolvedIncidentPayloads.includes(token) && !encodedResolvedIncidentPayloads.includes(webhookSecret), { agentOwnerResolvedDelivery: agentOwnerResolvedDelivery.payload, agentTeamResolvedDelivery: agentTeamResolvedDelivery.payload });
    const resolvedIncidentAlert = await incidentAlertWithStatus(ownerRisk.agentId, ownerAlert.alert.alertId, 'resolved');
    assert('resolved incident alert records notification timestamp', resolvedIncidentAlert.alert.status === 'resolved' && resolvedIncidentAlert.alert.resolvedAt && resolvedIncidentAlert.alert.lastNotificationAt, resolvedIncidentAlert);
    const resolvedIncidentDeliveryRecord = await deliveryRecord(agentOwnerChannel.channelId, ownerAlert.alert.alertId, 'resolved');
    assert(
      'notification delivery log records resolved incident alert',
      resolvedIncidentDeliveryRecord.delivery.status === 'ok' &&
        resolvedIncidentDeliveryRecord.delivery.action === 'resolved' &&
        resolvedIncidentDeliveryRecord.delivery.routeId === agentOwnerRoute.routeId &&
        resolvedIncidentDeliveryRecord.delivery.alertKind === 'incident' &&
        resolvedIncidentDeliveryRecord.delivery.incidentId === ownerAlert.alert.incidentId &&
        resolvedIncidentDeliveryRecord.delivery.agentId === ownerRisk.agentId,
      resolvedIncidentDeliveryRecord,
    );

    const reopenedIncident = await request(`/incidents/${encodeURIComponent(ownerAlert.alert.incidentId)}`, 'PUT', {
      status: 'open',
      owner: agentOwner,
      note: `${runId} incident reopened for notification lifecycle`,
    }, actorHeaders);
    assert('manual incident reopen is accepted for notification dispatch', reopenedIncident.status === 'open' && reopenedIncident.incidentId === ownerAlert.alert.incidentId && !reopenedIncident.resolvedAt, reopenedIncident);
    const agentOwnerReopenedDelivery = await eventually('agent owner reopened incident webhook delivery', () => agentOwnerWebhook.deliveries[2]);
    const agentTeamReopenedDelivery = await eventually('agent team reopened incident webhook delivery', () => agentTeamWebhook.deliveries[2]);
    assert('agent owner and team webhooks receive reopened incident alert', agentOwnerWebhook.deliveries.length === 3 && agentTeamWebhook.deliveries.length === 3, { agentOwner: agentOwnerWebhook.deliveries, agentTeam: agentTeamWebhook.deliveries });
    assert(
      'agent owner route receives reopened incident alert payload',
      agentOwnerReopenedDelivery.payload?.schemaVersion === 'anysentry.alert.v1' &&
        agentOwnerReopenedDelivery.payload?.action === 'reopened' &&
        agentOwnerReopenedDelivery.payload?.route?.channelId === agentOwnerChannel.channelId &&
        agentOwnerReopenedDelivery.payload?.route?.routeId === agentOwnerRoute.routeId &&
        agentOwnerReopenedDelivery.payload?.alert?.kind === 'incident' &&
        agentOwnerReopenedDelivery.payload?.alert?.alertId === ownerAlert.alert.alertId &&
        agentOwnerReopenedDelivery.payload?.alert?.incidentId === ownerAlert.alert.incidentId &&
        agentOwnerReopenedDelivery.payload?.alert?.status === 'open',
      agentOwnerReopenedDelivery,
    );
    assert(
      'agent team route receives reopened incident alert payload',
      agentTeamReopenedDelivery.payload?.schemaVersion === 'anysentry.alert.v1' &&
        agentTeamReopenedDelivery.payload?.action === 'reopened' &&
        agentTeamReopenedDelivery.payload?.route?.channelId === agentTeamChannel.channelId &&
        agentTeamReopenedDelivery.payload?.route?.routeId === agentTeamRoute.routeId &&
        agentTeamReopenedDelivery.payload?.alert?.kind === 'incident' &&
        agentTeamReopenedDelivery.payload?.alert?.alertId === ownerAlert.alert.alertId &&
        agentTeamReopenedDelivery.payload?.alert?.incidentId === ownerAlert.alert.incidentId &&
        agentTeamReopenedDelivery.payload?.alert?.status === 'open',
      agentTeamReopenedDelivery,
    );
    const encodedReopenedIncidentPayloads = JSON.stringify({ agentOwnerReopenedDelivery: agentOwnerReopenedDelivery.payload, agentTeamReopenedDelivery: agentTeamReopenedDelivery.payload });
    assert('reopened incident notification payloads do not leak source token or webhook secret', !encodedReopenedIncidentPayloads.includes(token) && !encodedReopenedIncidentPayloads.includes(webhookSecret), { agentOwnerReopenedDelivery: agentOwnerReopenedDelivery.payload, agentTeamReopenedDelivery: agentTeamReopenedDelivery.payload });
    const reopenedIncidentAlert = await incidentAlertWithStatus(ownerRisk.agentId, ownerAlert.alert.alertId, 'open');
    assert('reopened incident alert records notification timestamp', reopenedIncidentAlert.alert.status === 'open' && reopenedIncidentAlert.alert.lastNotificationAt, reopenedIncidentAlert);
    const reopenedIncidentDeliveryRecord = await deliveryRecord(agentOwnerChannel.channelId, ownerAlert.alert.alertId, 'reopened');
    assert(
      'notification delivery log records reopened incident alert',
      reopenedIncidentDeliveryRecord.delivery.status === 'ok' &&
        reopenedIncidentDeliveryRecord.delivery.action === 'reopened' &&
        reopenedIncidentDeliveryRecord.delivery.routeId === agentOwnerRoute.routeId &&
        reopenedIncidentDeliveryRecord.delivery.alertKind === 'incident' &&
        reopenedIncidentDeliveryRecord.delivery.incidentId === ownerAlert.alert.incidentId &&
        reopenedIncidentDeliveryRecord.delivery.agentId === ownerRisk.agentId,
      reopenedIncidentDeliveryRecord,
    );
    const incidentDeliveryFilter = await eventually('notification config filters delivery rows by incidentId', async () => {
      const config = await request(`/notifications/config?incidentId=${encodeURIComponent(ownerAlert.alert.incidentId)}&limit=20`);
      const actions = new Set(config.deliveries?.filter((item) => item.alertId === ownerAlert.alert.alertId && item.incidentId === ownerAlert.alert.incidentId).map((item) => item.action));
      return actions.has('resolved') && actions.has('reopened') ? { config, actions: [...actions] } : undefined;
    });
    assert('incidentId notification filter returns resolved and reopened incident deliveries', incidentDeliveryFilter.actions.includes('resolved') && incidentDeliveryFilter.actions.includes('reopened'), incidentDeliveryFilter);

    const coverageIssue = await triggerCoverageAlert(coverageSource, coverageToken);
    const coverageDelivery = await webhookDelivery(
      coverageWebhook,
      'coverage token rotation webhook delivery',
      (item) =>
        item.payload?.action === 'opened' &&
        item.payload?.alert?.labels?.issueId === coverageIssue.issueId &&
        item.payload?.alert?.labels?.type === 'source_token_rotation_due',
    );
    assert('coverage notification webhook receives token rotation alert', Boolean(coverageDelivery), coverageWebhook.deliveries);
    assert(
      'coverage route receives coverage alert payload',
      coverageDelivery.method === 'POST' &&
        coverageDelivery.payload?.schemaVersion === 'anysentry.alert.v1' &&
        coverageDelivery.payload?.action === 'opened' &&
        coverageDelivery.payload?.route?.channelId === coverageChannel.channelId &&
        coverageDelivery.payload?.route?.routeId === coverageRoute.routeId &&
        coverageDelivery.payload?.alert?.kind === 'coverage' &&
        coverageDelivery.payload?.alert?.ruleId === 'coverage.issue' &&
        coverageDelivery.payload?.alert?.sourceId === coverageSource.sourceId &&
        coverageDelivery.payload?.alert?.owner === coverageSource.owner &&
        coverageDelivery.payload?.alert?.labels?.issueId === coverageIssue.issueId &&
        coverageDelivery.payload?.alert?.labels?.type === 'source_token_rotation_due',
      coverageDelivery,
    );
    const encodedCoveragePayload = JSON.stringify(coverageDelivery.payload);
    assert('coverage notification payload does not leak source token or webhook secret', !encodedCoveragePayload.includes(coverageToken) && !encodedCoveragePayload.includes(webhookSecret), coverageDelivery.payload);
    const notifiedCoverageAlert = await coverageAlertWithNotification(coverageSource.sourceId, coverageIssue.issueId);
    assert('coverage alert records last notification timestamp', notifiedCoverageAlert.alert.lastNotificationAt && notifiedCoverageAlert.alert.status === 'open', notifiedCoverageAlert);
    const coverageDeliveryRecord = await deliveryRecord(coverageChannel.channelId, notifiedCoverageAlert.alert.alertId);
    assert(
      'coverage notification delivery log records routed alert',
      coverageDeliveryRecord.delivery.status === 'ok' &&
        coverageDeliveryRecord.delivery.routeId === coverageRoute.routeId &&
        coverageDeliveryRecord.delivery.alertKind === 'coverage' &&
        coverageDeliveryRecord.delivery.sourceId === coverageSource.sourceId &&
        coverageDeliveryRecord.delivery.issueId === coverageIssue.issueId &&
        (!notifiedCoverageAlert.alert.eventId || coverageDeliveryRecord.delivery.eventId === notifiedCoverageAlert.alert.eventId),
      coverageDeliveryRecord,
    );
    const coverageDeliveryByIssue = await deliveryRecordByQuery(
      'notification config filters delivery rows by issueId',
      { issueId: coverageIssue.issueId },
      (item) => item.deliveryId === coverageDeliveryRecord.delivery.deliveryId && item.issueId === coverageIssue.issueId,
    );
    assert('issueId notification filter returns the coverage delivery', coverageDeliveryByIssue.delivery.deliveryId === coverageDeliveryRecord.delivery.deliveryId, coverageDeliveryByIssue);
    const openCoverageBundle = await request('/evidence/bundle', 'POST', { timeType: 'last_30d', issueId: coverageIssue.issueId, limit: 20 });
    assert(
      'coverage evidence bundle includes primary issue and notification delivery correlation',
      openCoverageBundle.scope?.primaryType === 'coverage' &&
        openCoverageBundle.scope?.issueId === coverageIssue.issueId &&
        openCoverageBundle.primary?.coverageIssue?.issueId === coverageIssue.issueId &&
        openCoverageBundle.notificationDeliveries?.some((item) => item.issueId === coverageIssue.issueId && item.deliveryId === coverageDeliveryRecord.delivery.deliveryId),
      openCoverageBundle,
    );
    const rotatedCoverageSource = await triggerCoverageRecovery(coverageSource.sourceId, coverageIssue.issueId);
    const coverageResolvedDelivery = await webhookDelivery(
      coverageWebhook,
      'resolved coverage token rotation webhook delivery',
      (item) =>
        item.payload?.action === 'resolved' &&
        item.payload?.alert?.alertId === notifiedCoverageAlert.alert.alertId &&
        item.payload?.alert?.labels?.issueId === coverageIssue.issueId,
    );
    assert('coverage notification webhook receives resolved token rotation alert', Boolean(coverageResolvedDelivery), coverageWebhook.deliveries);
    assert(
      'coverage route receives resolved alert payload',
      coverageResolvedDelivery.method === 'POST' &&
        coverageResolvedDelivery.payload?.schemaVersion === 'anysentry.alert.v1' &&
        coverageResolvedDelivery.payload?.action === 'resolved' &&
        coverageResolvedDelivery.payload?.route?.channelId === coverageChannel.channelId &&
        coverageResolvedDelivery.payload?.route?.routeId === coverageRoute.routeId &&
        coverageResolvedDelivery.payload?.alert?.alertId === notifiedCoverageAlert.alert.alertId &&
        coverageResolvedDelivery.payload?.alert?.kind === 'coverage' &&
        coverageResolvedDelivery.payload?.alert?.status === 'resolved' &&
        coverageResolvedDelivery.payload?.alert?.resolvedAt &&
        coverageResolvedDelivery.payload?.alert?.labels?.issueId === coverageIssue.issueId,
      coverageResolvedDelivery,
    );
    const encodedCoverageResolvedPayload = JSON.stringify(coverageResolvedDelivery.payload);
    assert('resolved coverage notification payload does not leak source token, rotated token, or webhook secret', !encodedCoverageResolvedPayload.includes(coverageToken) && !encodedCoverageResolvedPayload.includes(rotatedCoverageSource.token) && !encodedCoverageResolvedPayload.includes(webhookSecret), coverageResolvedDelivery.payload);
    const resolvedCoverageAlert = await coverageAlertWithStatus(coverageSource.sourceId, coverageIssue.issueId, 'resolved');
    assert('resolved coverage alert records recovery notification state', resolvedCoverageAlert.alert.resolvedAt && resolvedCoverageAlert.alert.lastNotificationAt, resolvedCoverageAlert);
    const coverageResolvedDeliveryRecord = await deliveryRecord(coverageChannel.channelId, notifiedCoverageAlert.alert.alertId, 'resolved');
    assert(
      'coverage notification delivery log records resolved alert',
      coverageResolvedDeliveryRecord.delivery.status === 'ok' &&
        coverageResolvedDeliveryRecord.delivery.action === 'resolved' &&
        coverageResolvedDeliveryRecord.delivery.routeId === coverageRoute.routeId &&
        coverageResolvedDeliveryRecord.delivery.sourceId === coverageSource.sourceId &&
        coverageResolvedDeliveryRecord.delivery.issueId === coverageIssue.issueId,
      coverageResolvedDeliveryRecord,
    );

    const scheduledRemediation = await triggerScheduledRemediationOverdue(remediationSource, remediationSource.owner);
    const remediationDelivery = await eventually('remediation overdue webhook delivery', () => remediationWebhook.deliveries[0], 12000);
    assert('remediation notification webhook receives exactly one overdue alert', remediationWebhook.deliveries.length === 1, remediationWebhook.deliveries);
    assert(
      'remediation route receives overdue alert payload',
      remediationDelivery.method === 'POST' &&
        remediationDelivery.payload?.schemaVersion === 'anysentry.alert.v1' &&
        remediationDelivery.payload?.action === 'opened' &&
        remediationDelivery.payload?.route?.channelId === remediationChannel.channelId &&
        remediationDelivery.payload?.route?.routeId === remediationRoute.routeId &&
        remediationDelivery.payload?.alert?.kind === 'remediation' &&
        remediationDelivery.payload?.alert?.ruleId === 'remediation.overdue' &&
        remediationDelivery.payload?.alert?.sourceId === remediationSource.sourceId &&
        remediationDelivery.payload?.alert?.owner === remediationSource.owner &&
        remediationDelivery.payload?.alert?.labels?.taskId === scheduledRemediation.taskId,
      remediationDelivery,
    );
    const encodedRemediationPayload = JSON.stringify(remediationDelivery.payload);
    assert('remediation notification payload does not leak source token or webhook secret', !encodedRemediationPayload.includes(remediationToken) && !encodedRemediationPayload.includes(webhookSecret), remediationDelivery.payload);
    const notifiedRemediationAlert = await remediationAlertWithNotification(scheduledRemediation.taskId, remediationSource.owner);
    assert('remediation overdue alert records last notification timestamp', notifiedRemediationAlert.alert.lastNotificationAt && notifiedRemediationAlert.alert.status === 'open', notifiedRemediationAlert);
    const remediationDeliveryRecord = await deliveryRecord(remediationChannel.channelId, notifiedRemediationAlert.alert.alertId);
    assert(
      'remediation notification delivery log records routed alert',
      remediationDeliveryRecord.delivery.status === 'ok' &&
        remediationDeliveryRecord.delivery.routeId === remediationRoute.routeId &&
        remediationDeliveryRecord.delivery.alertKind === 'remediation' &&
        remediationDeliveryRecord.delivery.sourceId === remediationSource.sourceId &&
        remediationDeliveryRecord.delivery.taskId === scheduledRemediation.taskId,
      remediationDeliveryRecord,
    );
    const remediationDeliveryByTask = await deliveryRecordByQuery(
      'notification config filters delivery rows by taskId',
      { taskId: scheduledRemediation.taskId },
      (item) => item.deliveryId === remediationDeliveryRecord.delivery.deliveryId && item.taskId === scheduledRemediation.taskId,
    );
    assert('taskId notification filter returns the remediation delivery', remediationDeliveryByTask.delivery.deliveryId === remediationDeliveryRecord.delivery.deliveryId, remediationDeliveryByTask);
    const completedRemediation = await request(`/remediations/${encodeURIComponent(scheduledRemediation.taskId)}`, 'PUT', {
      status: 'done',
      owner: remediationSource.owner,
      note: `${runId} remediation completed for notification lifecycle`,
    }, actorHeaders);
    assert('remediation completion is accepted for notification dispatch', completedRemediation.status === 'done' && completedRemediation.taskId === scheduledRemediation.taskId && completedRemediation.completedAt, completedRemediation);
    const remediationResolvedDelivery = await eventually('resolved remediation webhook delivery', () => remediationWebhook.deliveries[1], 12000);
    assert('remediation notification webhook receives resolved alert', remediationWebhook.deliveries.length === 2, remediationWebhook.deliveries);
    assert(
      'remediation route receives resolved alert payload',
      remediationResolvedDelivery.method === 'POST' &&
        remediationResolvedDelivery.payload?.schemaVersion === 'anysentry.alert.v1' &&
        remediationResolvedDelivery.payload?.action === 'resolved' &&
        remediationResolvedDelivery.payload?.route?.channelId === remediationChannel.channelId &&
        remediationResolvedDelivery.payload?.route?.routeId === remediationRoute.routeId &&
        remediationResolvedDelivery.payload?.alert?.alertId === notifiedRemediationAlert.alert.alertId &&
        remediationResolvedDelivery.payload?.alert?.kind === 'remediation' &&
        remediationResolvedDelivery.payload?.alert?.status === 'resolved' &&
        remediationResolvedDelivery.payload?.alert?.resolvedAt &&
        remediationResolvedDelivery.payload?.alert?.labels?.taskId === scheduledRemediation.taskId,
      remediationResolvedDelivery,
    );
    const encodedRemediationResolvedPayload = JSON.stringify(remediationResolvedDelivery.payload);
    assert('resolved remediation notification payload does not leak source token or webhook secret', !encodedRemediationResolvedPayload.includes(remediationToken) && !encodedRemediationResolvedPayload.includes(webhookSecret), remediationResolvedDelivery.payload);
    const resolvedRemediationAlert = await remediationAlertWithStatus(scheduledRemediation.taskId, 'resolved');
    assert('resolved remediation alert records completion notification state', resolvedRemediationAlert.alert.resolvedAt && resolvedRemediationAlert.alert.lastNotificationAt, resolvedRemediationAlert);
    const remediationResolvedDeliveryRecord = await deliveryRecord(remediationChannel.channelId, notifiedRemediationAlert.alert.alertId, 'resolved');
    assert(
      'remediation notification delivery log records resolved alert',
      remediationResolvedDeliveryRecord.delivery.status === 'ok' &&
        remediationResolvedDeliveryRecord.delivery.action === 'resolved' &&
        remediationResolvedDeliveryRecord.delivery.routeId === remediationRoute.routeId &&
        remediationResolvedDeliveryRecord.delivery.taskId === scheduledRemediation.taskId,
      remediationResolvedDeliveryRecord,
    );

    const objectiveBundle = await request('/evidence/bundle', 'POST', { timeType: 'last_30d', objectiveId: objective.objectiveId, limit: 20 });
    assert('objective evidence bundle includes objective notification delivery correlation', objectiveBundle.notificationDeliveries?.some((item) => item.objectiveId === objective.objectiveId && item.deliveryId === objectiveDeliveryRecord.delivery.deliveryId) && objectiveBundle.notificationDeliveries?.some((item) => item.objectiveId === objective.objectiveId && item.action === 'resolved'), objectiveBundle.notificationDeliveries);
    const eventBundle = await request('/evidence/bundle', 'POST', { timeType: 'last_30d', eventId: eventSignal.eventId, limit: 20 });
    assert('event evidence bundle includes event notification delivery correlation', eventBundle.notificationDeliveries?.some((item) => item.eventId === eventSignal.eventId && item.deliveryId === eventDeliveryRecord.delivery.deliveryId), eventBundle.notificationDeliveries);
    const incidentBundle = await request('/evidence/bundle', 'POST', { timeType: 'last_30d', incidentId: ownerAlert.alert.incidentId, limit: 20 });
    assert('incident evidence bundle includes lifecycle notification deliveries', incidentBundle.notificationDeliveries?.some((item) => item.incidentId === ownerAlert.alert.incidentId && item.action === 'resolved') && incidentBundle.notificationDeliveries?.some((item) => item.incidentId === ownerAlert.alert.incidentId && item.action === 'reopened'), incidentBundle.notificationDeliveries);
    const coverageBundle = await request('/evidence/bundle', 'POST', { timeType: 'last_30d', issueId: coverageIssue.issueId, limit: 20 });
    assert('coverage evidence bundle includes lifecycle notification deliveries', coverageBundle.notificationDeliveries?.some((item) => item.issueId === coverageIssue.issueId && item.deliveryId === coverageDeliveryRecord.delivery.deliveryId) && coverageBundle.notificationDeliveries?.some((item) => item.issueId === coverageIssue.issueId && item.action === 'resolved'), coverageBundle.notificationDeliveries);
    const remediationBundle = await request('/evidence/bundle', 'POST', { timeType: 'last_30d', taskId: scheduledRemediation.taskId, limit: 20 });
    assert('remediation evidence bundle includes task notification delivery correlation', remediationBundle.notificationDeliveries?.some((item) => item.taskId === scheduledRemediation.taskId && item.deliveryId === remediationDeliveryRecord.delivery.deliveryId) && remediationBundle.notificationDeliveries?.some((item) => item.taskId === scheduledRemediation.taskId && item.action === 'resolved'), remediationBundle.notificationDeliveries);

    const sentChannel = await channelStatus(matchingChannel.channelId);
    const sentSourceOwnerChannel = await channelStatus(sourceOwnerChannel.channelId);
    const sentSourceTeamChannel = await channelStatus(sourceTeamChannel.channelId);
    const sentAgentOwnerChannel = await channelStatus(agentOwnerChannel.channelId);
    const sentAgentTeamChannel = await channelStatus(agentTeamChannel.channelId);
    const sentRemediationChannel = await channelStatus(remediationChannel.channelId);
    const sentCoverageChannel = await channelStatus(coverageChannel.channelId);
    const sentCollectorChannel = await channelStatus(collectorChannel.channelId);
    const sentEventChannel = await channelStatus(eventChannel.channelId);
    const sentObjectiveChannel = await channelStatus(objectiveChannel.channelId);
    const brokenChannelConfig = await request(`/notifications/config?channelId=${encodeURIComponent(brokenChannel.channelId)}`);
    const brokenChannelState = brokenChannelConfig.channels?.find((item) => item.channelId === brokenChannel.channelId);
    const notificationConfig = await request(`/notifications/config?channelId=${encodeURIComponent(quietChannel.channelId)}`);
    const quietRouteConfig = await request(`/notifications/config?routeId=${encodeURIComponent(quietRoute.routeId)}`);
    const quietChannelState = notificationConfig.channels?.find((item) => item.channelId === quietChannel.channelId);
    assert('matching notification channel records ok delivery', sentChannel.channel.lastStatus === 'ok' && Boolean(sentChannel.channel.lastSentAt), sentChannel);
    assert('owner and team notification channels record ok delivery', sentSourceOwnerChannel.channel.lastStatus === 'ok' && sentSourceTeamChannel.channel.lastStatus === 'ok' && sentAgentOwnerChannel.channel.lastStatus === 'ok' && sentAgentTeamChannel.channel.lastStatus === 'ok', { sentSourceOwnerChannel, sentSourceTeamChannel, sentAgentOwnerChannel, sentAgentTeamChannel });
    assert('remediation notification channel records ok delivery', sentRemediationChannel.channel.lastStatus === 'ok' && Boolean(sentRemediationChannel.channel.lastSentAt), sentRemediationChannel);
    assert('coverage notification channel records ok delivery', sentCoverageChannel.channel.lastStatus === 'ok' && Boolean(sentCoverageChannel.channel.lastSentAt), sentCoverageChannel);
    assert('collector notification channel records ok delivery', sentCollectorChannel.channel.lastStatus === 'ok' && Boolean(sentCollectorChannel.channel.lastSentAt), sentCollectorChannel);
    assert('event notification channel records ok delivery', sentEventChannel.channel.lastStatus === 'ok' && Boolean(sentEventChannel.channel.lastSentAt), sentEventChannel);
    assert('objective notification channel records ok delivery', sentObjectiveChannel.channel.lastStatus === 'ok' && Boolean(sentObjectiveChannel.channel.lastSentAt), sentObjectiveChannel);
    assert('broken notification channel records error delivery', brokenChannelState?.lastStatus === 'error' && Boolean(brokenChannelState?.lastError), brokenChannelConfig);
    assert('unmatched notification channel remains unsent', !quietChannelState?.lastSentAt && !quietChannelState?.lastStatus && notificationConfig.deliveries?.length === 0, notificationConfig);
    const endpointPreviews = [
      sentChannel.config,
      sentSourceOwnerChannel.config,
      sentSourceTeamChannel.config,
      sentAgentOwnerChannel.config,
      sentAgentTeamChannel.config,
      sentRemediationChannel.config,
      sentCoverageChannel.config,
      sentCollectorChannel.config,
      sentEventChannel.config,
      sentObjectiveChannel.config,
      brokenChannelConfig,
      notificationConfig,
    ].flatMap(endpointPreviewRecords);
    assert(
      'notification endpoint previews redact webhook path secrets',
      endpointPreviews.length >= 12 && endpointPreviews.every((record) => endpointPreviewIsRedacted(record, webhookSecret)),
      endpointPreviews,
    );
    const configTextRecords = [notificationConfig, quietRouteConfig].flatMap(notificationConfigTextRecords);
    assert(
      'notification config text fields redact free-text credentials',
      configTextRecords.some((record) => record.value.includes('[redacted]')) &&
        configTextRecords.every((record) => !record.value.includes(configTextSecret) && !record.value.includes(configTextApiKey)),
      configTextRecords,
    );
  } finally {
    await Promise.allSettled([matchingWebhook.close(), sourceOwnerWebhook.close(), sourceTeamWebhook.close(), agentOwnerWebhook.close(), agentTeamWebhook.close(), remediationWebhook.close(), coverageWebhook.close(), collectorWebhook.close(), eventWebhook.close(), objectiveWebhook.close(), quietWebhook.close()]);
  }

  if (process.exitCode) {
    console.error(`Notification dispatch verification failed for probe ${runId}`);
    process.exit(process.exitCode);
  }
  console.log(`Notification dispatch verification passed for probe ${runId}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
