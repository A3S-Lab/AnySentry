#!/usr/bin/env node

import { managementAuthHeaders, safeProbeId } from './probe-id.mjs';

const baseUrl = (process.env.ANYSENTRY_API_BASE ?? process.env.API_BASE ?? `http://127.0.0.1:${process.env.PORT ?? '29653'}/security-center`).replace(/\/$/, '');
const runId = safeProbeId('cov');
const actorHeaders = {
  'x-anysentry-actor-type': 'operator',
  'x-anysentry-actor': `${runId}-operator`,
  'x-anysentry-actor-name': 'Coverage Runtime Verifier',
  'x-forwarded-for': '198.51.100.46',
  'user-agent': 'anysentry-coverage-runtime-verifier',
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

async function createUnusedSource() {
  const created = await request('/sources', 'POST', {
    name: `${runId} unused coverage source`,
    type: 'webhook',
    enabled: true,
    requireToken: true,
    collectorId: `${runId}-collector`,
    workspacePath: `repo://${runId}/coverage`,
    owner: 'coverage-verifier',
    tags: [runId, 'coverage-runtime'],
  }, actorHeaders);
  assert('coverage source creation returns managed token', Boolean(created.source?.sourceId && created.token), created);
  return created.source;
}

async function createTokenRotationSource() {
  const created = await request('/sources', 'POST', {
    name: `${runId} token rotation source`,
    type: 'webhook',
    enabled: true,
    requireToken: true,
    tokenRotationDays: 0,
    collectorId: `${runId}-token-collector`,
    workspacePath: `repo://${runId}/token-rotation`,
    owner: 'coverage-verifier',
    tags: [runId, 'coverage-runtime', 'token-rotation'],
  }, actorHeaders);
  assert(
    'token rotation source creation returns managed token and overdue metadata',
    Boolean(created.source?.sourceId && created.token) &&
      created.source.tokenRotationStatus === 'overdue',
    created,
  );
  return created;
}

async function coverageForSource(sourceId) {
  return request('/coverage/overview', 'POST', {
    timeType: 'last_30d',
    sourceId,
    type: 'source_unused',
    limit: 20,
  });
}

async function tokenRotationCoverageForSource(sourceId) {
  return request('/coverage/overview', 'POST', {
    timeType: 'last_30d',
    sourceId,
    type: 'source_token_rotation_due',
    limit: 20,
  });
}

async function coverageAlertForIssue(sourceId, issueId, status) {
  return eventually(`coverage alert ${status}`, async () => {
    const list = await request('/alerts/list', 'POST', {
      timeType: 'last_30d',
      sourceId,
      kind: 'coverage',
      status: 'all',
      issueId,
      limit: 50,
    });
    const alert = list.items?.find((item) => item.ruleId === 'coverage.issue' && item.labels?.issueId === issueId && (!status || item.status === status));
    return alert ? { list, alert } : undefined;
  });
}

async function sourceUnusedIssue(sourceId, suppressed) {
  return eventually(`source_unused coverage issue suppressed=${suppressed}`, async () => {
    const coverage = await coverageForSource(sourceId);
    const issue = coverage.issues?.find((item) => item.sourceId === sourceId && item.type === 'source_unused');
    return issue && Boolean(issue.suppressedByMaintenance) === suppressed ? { coverage, issue } : undefined;
  });
}

async function createMaintenanceWindow(sourceId) {
  const startAt = new Date(Date.now() - 60_000).toISOString();
  const endAt = new Date(Date.now() + 3_600_000).toISOString();
  const window = await request('/maintenance/windows', 'POST', {
    title: `${runId} coverage maintenance`,
    targetType: 'source',
    targetId: sourceId,
    startAt,
    endAt,
    enabled: true,
    owner: 'coverage-verifier',
    reason: 'coverage runtime suppression verification',
    labels: { probe: runId },
  }, actorHeaders);
  assert('coverage maintenance window starts active', window.targetId === sourceId && window.status === 'active', window);
  return window;
}

async function disableMaintenanceWindow(windowId) {
  const disabled = await request(`/maintenance/windows/${encodeURIComponent(windowId)}`, 'PUT', {
    enabled: false,
    note: `${runId} coverage maintenance disabled`,
  }, actorHeaders);
  assert('coverage maintenance window can be disabled', disabled.status === 'disabled' && disabled.enabled === false, disabled);
  return disabled;
}

async function verifySourceTokenRotationCoverage() {
  const created = await createTokenRotationSource();
  const source = created.source;
  const token = created.token;
  const checkedIn = await request('/sources/check-in', 'POST', {
    sourceId: source.sourceId,
    sourceName: source.name,
    sourceType: source.type,
    token,
    collectorId: source.collectorId,
    workspacePath: source.workspacePath,
    status: 'ok',
  });
  assert('token rotation source check-in is accepted before coverage evaluation', checkedIn.accepted === true && checkedIn.sourceId === source.sourceId, checkedIn);

  const overdueSourceList = await request('/sources/list', 'POST', { sourceId: source.sourceId, limit: 5 });
  const overdueSource = overdueSourceList.items?.find((item) => item.sourceId === source.sourceId);
  assert(
    'Source list exposes overdue token rotation state',
    overdueSource?.tokenRotationStatus === 'overdue' &&
      overdueSource.tokenRotationDueAt &&
      overdueSourceList.summary.tokenRotationOverdueSources >= 1,
    overdueSourceList,
  );

  const coverage = await eventually('source_token_rotation_due coverage issue', async () => {
    const next = await tokenRotationCoverageForSource(source.sourceId);
    const issue = next.issues?.find((item) => item.sourceId === source.sourceId && item.type === 'source_token_rotation_due');
    return issue ? { coverage: next, issue } : undefined;
  });
  assert(
    'overdue Source token creates actionable coverage issue',
    coverage.issue.severity === 'medium' &&
      coverage.issue.labels?.tokenRotationDays === '0' &&
      coverage.coverage.summary.issueCount >= 1 &&
      coverage.coverage.summary.unhealthySources >= 1 &&
      coverage.coverage.summary.coverageScore < 100,
    coverage,
  );
  const coverageAlert = await coverageAlertForIssue(source.sourceId, coverage.issue.issueId, 'open');
  assert(
    'overdue Source token creates Coverage alert',
    coverageAlert.alert.kind === 'coverage' &&
      coverageAlert.alert.ruleId === 'coverage.issue' &&
      coverageAlert.alert.sourceId === source.sourceId &&
      coverageAlert.alert.owner === source.owner &&
      coverageAlert.alert.labels?.type === 'source_token_rotation_due',
    coverageAlert,
  );

  const policyRelaxed = await request(`/sources/${encodeURIComponent(source.sourceId)}`, 'PUT', {
    tokenRotationDays: 365,
  }, actorHeaders);
  assert('Source token rotation policy can be extended', policyRelaxed.source?.tokenRotationDays === 365, policyRelaxed);

  const rotated = await request(`/sources/${encodeURIComponent(source.sourceId)}/rotate-token`, 'POST', undefined, actorHeaders);
  assert(
    'Source token rotation refreshes token age and status',
    Boolean(rotated.token) &&
      rotated.source.tokenRotationDays === 365 &&
      rotated.source.tokenRotationStatus === 'fresh' &&
      rotated.source.tokenIssuedAt,
    rotated,
  );

  const recovered = await tokenRotationCoverageForSource(source.sourceId);
  assert(
    'freshly rotated Source token clears token rotation coverage issue',
    !recovered.issues?.some((item) => item.sourceId === source.sourceId && item.type === 'source_token_rotation_due'),
    recovered,
  );
  const resolvedCoverageAlert = await coverageAlertForIssue(source.sourceId, coverage.issue.issueId, 'resolved');
  assert('freshly rotated Source token resolves Coverage alert', resolvedCoverageAlert.alert.status === 'resolved', resolvedCoverageAlert);
}

async function main() {
  console.log(`AnySentry coverage runtime verification against ${baseUrl}`);
  await request('/stats');
  const source = await createUnusedSource();

  const before = await sourceUnusedIssue(source.sourceId, false);
  assert(
    'unused Source creates actionable coverage issue and score penalty',
    before.issue.severity === 'medium' &&
      before.coverage.summary.issueCount >= 1 &&
      before.coverage.summary.suppressedIssues === 0 &&
      before.coverage.summary.coverageScore < 100,
    before,
  );

  const maintenance = await createMaintenanceWindow(source.sourceId);
  const suppressed = await sourceUnusedIssue(source.sourceId, true);
  assert(
    'active maintenance suppresses coverage issue and removes actionable score penalty',
    suppressed.issue.maintenanceWindowId === maintenance.windowId &&
      suppressed.coverage.summary.issueCount === 0 &&
      suppressed.coverage.summary.suppressedIssues >= 1 &&
      suppressed.coverage.summary.coverageScore === 100,
    suppressed,
  );

  await disableMaintenanceWindow(maintenance.windowId);
  const after = await sourceUnusedIssue(source.sourceId, false);
  assert(
    'disabled maintenance makes coverage issue actionable again',
    after.coverage.summary.issueCount >= 1 &&
      after.coverage.summary.suppressedIssues === 0 &&
      after.coverage.summary.coverageScore === before.coverage.summary.coverageScore,
    after,
  );

  await verifySourceTokenRotationCoverage();

  if (process.exitCode) {
    console.error(`Coverage runtime verification failed for probe ${runId}`);
    process.exit(process.exitCode);
  }
  console.log(`Coverage runtime verification passed for probe ${runId}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
