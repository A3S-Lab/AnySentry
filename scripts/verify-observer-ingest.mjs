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

function observerLine(identity, event, process) {
  return JSON.stringify({ identity, ...(process ? { process } : {}), event });
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

async function waitForEvent(eventId, checks, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let latest = await eventById(eventId);
  while (!(latest.event && checks(latest.event)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    latest = await eventById(eventId);
  }
  return latest;
}

async function assertEvent(message, eventId, checks) {
  const { list, event } = await eventById(eventId);
  const ok = list.total === 1 && event?.eventId === eventId && checks(event);
  assert(message, ok, list);
}

async function createProtectedObserverSource(suffix = '') {
  const sourcePrefix = suffix ? `${runId}-${suffix}` : runId;
  const source = await request('/sources', 'POST', {
    name: `${sourcePrefix} observer forwarder`,
    type: 'observer',
    enabled: true,
    requireToken: true,
    collectorId: `${sourcePrefix}-collector`,
    workspacePath: `repo://${sourcePrefix}/observer`,
    owner: 'verify-observer-ingest',
    tags: [sourcePrefix, 'observer-verifier'],
  });
  assert(`${suffix ? 'isolated ' : ''}observer source creation returns managed token`, Boolean(source.source?.sourceId && source.token), source);
  return source;
}

async function verifyIdentitySnapshotContract() {
  const snapshot = await request(`/identity/snapshot?nodeName=${encodeURIComponent(`${runId}-node`)}`);
  assert(
    'identity snapshot exposes a versioned fail-open forwarder contract',
    snapshot.schemaVersion === 'anysentry.workload_identity_snapshot.v1' &&
      typeof snapshot.version === 'number' &&
      typeof snapshot.ready === 'boolean' &&
      Array.isArray(snapshot.entries) &&
      snapshot.nodeName === `${runId}-node`,
    snapshot,
  );
}

async function verifyCollectorMetricFreshnessContract() {
  const { AggregationService } = await import('../apps/api/dist/security-monitoring/aggregation.service.js');
  const at = Date.now();
  const heartbeat = (overrides = {}) => ({
    collectorId: `${runId}-freshness-collector`,
    at,
    status: 'ok',
    nodeName: `${runId}-freshness-node`,
    attachedProbes: 0,
    enabledFeatures: [],
    intervalSecs: 30,
    eventKindCounts: {},
    queueDepth: 0,
    droppedEvents: 0,
    outputDropped: 0,
    errorCount: 0,
    observedAgents: 0,
    filterMetrics: { scope: 'decoupled', observed: 0 },
    ...overrides,
  });

  const sameMillisecondEnriched = heartbeat({
    filterMetricsReportedAt: at,
    nodeName: `${runId}-enriched-same-ms`,
    filterMetrics: { scope: 'shadow', observed: 9 },
  });
  const sameMillisecondRaw = heartbeat({ nodeName: `${runId}-raw-same-ms` });
  const sameMillisecondAggregation = new AggregationService({
    query: () => [],
    queryCollectorHeartbeats: () => [sameMillisecondEnriched, sameMillisecondRaw],
    collectorHeartbeatHeads: () => ({ latest: [sameMillisecondRaw], latestMetrics: [sameMillisecondEnriched] }),
  }, {}, {}, {});
  const sameMillisecondHealth = sameMillisecondAggregation.collectorHealth({ timeType: 'last_30d', collectorId: sameMillisecondRaw.collectorId });
  assert(
    'same-millisecond raw heartbeat updates status while fresh enriched metrics remain selected',
    sameMillisecondHealth.items?.[0]?.nodeName === `${runId}-raw-same-ms` &&
      sameMillisecondHealth.items?.[0]?.filterMetrics?.scope === 'shadow' &&
      sameMillisecondHealth.items?.[0]?.filterMetrics?.observed === 9,
    sameMillisecondHealth,
  );

  const expiredAt = at - 4 * 60_000;
  const expiredEnriched = heartbeat({
    at: expiredAt,
    filterMetricsReportedAt: expiredAt,
    nodeName: `${runId}-expired-enriched`,
    filterMetrics: { scope: 'shadow', observed: 99 },
  });
  const currentRaw = heartbeat({ at: at - 1_000, nodeName: `${runId}-current-raw` });
  const expiredAggregation = new AggregationService({
    query: () => [],
    queryCollectorHeartbeats: () => [expiredEnriched, currentRaw],
    collectorHeartbeatHeads: () => ({ latest: [currentRaw], latestMetrics: [expiredEnriched] }),
  }, {}, {}, {});
  const expiredHealth = expiredAggregation.collectorHealth({ timeType: 'last_30d', collectorId: currentRaw.collectorId });
  assert(
    'raw heartbeats cannot renew expired enriched filter metrics',
    expiredHealth.items?.[0]?.nodeName === `${runId}-current-raw` &&
      expiredHealth.items?.[0]?.filterMetrics?.scope === 'decoupled' &&
      expiredHealth.items?.[0]?.filterMetrics?.observed === 0,
    expiredHealth,
  );
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
    {
      ToolExec: {
        pid: 1312,
        uid: 1001,
        cwd: '/workspace/project',
        argv: ['bash', '-lc', `echo observer-ok --token=${secret}`],
        argv_truncated: false,
        argv_incomplete: false,
        exec_confirmed: true,
        argv_source: 'proc_cmdline',
        captured_argc: 3,
        captured_bytes: 64,
        observed_argc: 3,
        observed_bytes: 96,
      },
    },
    {
      host_id: `${runId}-host`,
      boot_id: `${runId}-boot`,
      pid: 1312,
      ppid: 1200,
      start_time_ticks: 998877,
      comm: 'bash',
      exe: '/usr/bin/bash',
      cwd: '/workspace/project',
      cgroup_id: 18412,
      cgroup: '0::/user.slice/agent.scope',
    },
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
    event.attributes?.exec_confirmed === true &&
    event.attributes?.argv_source === 'proc_cmdline' &&
    event.attributes?.observed_argc === 3 &&
    event.attributes?.observed_bytes === 96 &&
    event.process?.hostId === `${runId}-host` &&
    event.process?.bootId === `${runId}-boot` &&
    event.process?.startTimeTicks === '998877' &&
    event.process?.cgroupId === '18412' &&
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

async function verifyIncompleteObserverEvidence(sourceId, token) {
  const line = observerLine(
    { agent: `${runId}-incomplete-agent`, session: `${runId}-incomplete-session`, task: 'incomplete-task' },
    {
      ToolExec: {
        pid: 1314,
        uid: 1001,
        cwd: '/workspace/project',
        argv: ['echo', 'safe-prefix'],
        argv_truncated: true,
        argv_incomplete: false,
        exec_confirmed: true,
        argv_source: 'kernel_fragments',
        captured_argc: 2,
        captured_bytes: 16,
        observed_argc: 2,
        observed_bytes: 16,
      },
    },
  );
  const result = await request('/ingest', 'POST', {
    line,
    collectorId: `${runId}-collector`,
    nodeName: `${runId}-node`,
    sourceType: 'observer',
    workspacePath: `repo://${runId}/incomplete`,
  }, sourceHeaders(sourceId, token));

  assert(
    'incomplete Observer argv is accepted for asynchronous judgment',
    result.accepted === true && Boolean(result.eventId) && (result.decisionStatus === 'pending' || result.decisionStatus === 'succeeded'),
    result,
  );
  if (!result.eventId) return;

  const { list, event } = await waitForEvent(result.eventId, (candidate) =>
    candidate.decisionStatus === 'succeeded' &&
    candidate.verdict === 'escalate' &&
    candidate.tier === 'Rules' &&
    String(candidate.reason).includes('incomplete ToolExec evidence'),
  );
  assert(
    'incomplete Observer argv is escalated at L1 instead of allowed',
    list.total === 1 && event?.eventId === result.eventId && event.decisionStatus === 'succeeded' && event.verdict === 'escalate' && event.tier === 'Rules' && String(event.reason).includes('incomplete ToolExec evidence'),
    list,
  );
}

async function verifyObserverBatch(sourceId, token) {
  const attribution = {
    monitored: true,
    classification: 'confirmed_agent',
    agentScopeId: `${runId}-batch-agent`,
    agentDisplayName: `${runId}-batch-agent`,
    agentInstanceId: 'pod-batch/container-batch',
    physicalWorkloadId: 'k8s:test:pod-batch:container-batch',
    confidence: 1,
    reason: 'authoritative_anchor',
    source: 'kubernetes',
    evidence: ['label:anysentry.io/workload-kind=agent'],
  };
  const events = [1711, 1712].map((pid) => ({
    line: observerLine(
      { agent: 'pod-batch', session: 'container-batch', task: String(pid) },
      {
        ToolExec: {
          pid,
          ppid: 1700,
          uid: 1000,
          cwd: '/workspace/batch',
          argv: ['echo', `batch-${pid}`],
        },
      },
    ),
    collectorId: `${runId}-collector`,
    nodeName: `${runId}-node`,
    sourceType: 'observer',
    attribution,
  }));
  const result = await request('/ingest/batch', 'POST', { events }, sourceHeaders(sourceId, token));
  assert(
    'observer batch ingest accepts and accounts for every envelope',
    result.accepted === true &&
      result.acceptedEvents === 2 &&
      result.rejectedEvents === 0 &&
      result.items?.length === 2 &&
      result.items.every((item) => item.accepted === true),
    result,
  );
  const eventId = result.items?.[0]?.eventId;
  if (!eventId) return;
  await assertEvent('observer batch preserves workload-first attribution evidence', eventId, (event) =>
    event.attribution?.classification === 'confirmed_agent' &&
    event.attribution?.agentScopeId === `${runId}-batch-agent` &&
    event.attribution?.physicalWorkloadId === 'k8s:test:pod-batch:container-batch' &&
    event.attribution?.evidence?.includes('label:anysentry.io/workload-kind=agent'),
  );
}

async function verifyInternalL3RecursionSuppressed(sourceId, token) {
  const line = observerLine(
    { agent: 'l3-worker-container', session: 'l3-worker-container', task: 'internal-l3-task' },
    {
      ToolExec: {
        pid: 1414,
        ppid: 1400,
        uid: 0,
        cwd: '/app',
        argv: [
          'node',
          '/opt/anysentry/l3-agent.mjs',
          '--skills',
          '/opt/anysentry/skills',
          '--json',
          '-p',
          'Investigate runtime event. Actor: a3s code. Signal: ToolExec.',
        ],
      },
    },
    {
      pid: 1414,
      ppid: 1400,
      comm: 'l3-agent.mjs',
      exe: '/usr/local/bin/node',
      cwd: '/app',
      cgroup: '0::/system.slice/docker-verifier.scope',
    },
  );
  const result = await request('/ingest', 'POST', {
    line,
    collectorId: `${runId}-collector`,
    nodeName: `${runId}-node`,
    sourceType: 'observer',
    workspacePath: `repo://${runId}/internal-l3`,
  }, sourceHeaders(sourceId, token));

  assert(
    'internal L3 ToolExec is recorded without entering the judgment queue',
    result.accepted === true && result.decisionStatus === 'succeeded' && result.tier === 'Rules' && result.verdict === 'allow' && String(result.reason).includes('recursive judgment suppressed'),
    result,
  );
  if (!result.eventId) return;
  await assertEvent('internal L3 audit record carries a trusted recursion-suppression marker', result.eventId, (event) =>
    event.decisionStatus === 'succeeded' &&
    event.attributes?.origin === 'l3-judge' &&
    event.attributes?.recursiveJudgmentSuppressed === true &&
    String(event.reason).includes('recursive judgment suppressed'),
  );

  const inProcessLine = observerLine(
    { agent: 'sentry-l3', session: 'pooled-l3-session', task: 'internal-pooled-l3-task' },
    { ToolExec: { pid: 1515, ppid: 1500, uid: 0, cwd: '/tmp', argv: ['bash', '-lc', 'inspect-event'] } },
    {
      pid: 1500,
      ppid: 1,
      comm: 'node',
      exe: '/usr/local/bin/node',
      cwd: '/app',
      cgroup: '0::/system.slice/docker-pooled-l3.scope',
    },
  );
  const inProcess = await request('/ingest', 'POST', {
    line: inProcessLine,
    collectorId: `${runId}-collector`,
    nodeName: `${runId}-node`,
    sourceType: 'observer',
    workspacePath: `repo://${runId}/internal-pooled-l3`,
  }, sourceHeaders(sourceId, token));
  assert(
    'in-process sentry-l3 activity is recorded without entering the judgment queue',
    inProcess.accepted === true && inProcess.decisionStatus === 'succeeded' && inProcess.tier === 'Rules' && inProcess.verdict === 'allow' && String(inProcess.reason).includes('recursive judgment suppressed'),
    inProcess,
  );
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
    filterMetrics: {
      scope: 'shadow',
      observed: 9,
      forwarded: 9,
      confirmedAgent: 2,
      probableAgent: 1,
      unknown: 3,
      nonAgent: 3,
      filteredNonAgent: 0,
      wouldFilterNonAgent: 3,
      filteredNoise: 0,
      wouldFilterNoise: 1,
      discoveryBudgetDropped: 0,
      wouldDiscoveryBudgetDrop: 1,
      e2eFilterReceipts: [
        {
          schema: 'anysentry.e2e_filter_receipt.v1',
          eventKind: 'ToolExec',
          markerSha256: 'a'.repeat(64),
          lineSha256: 'b'.repeat(64),
          physicalWorkloadId: 'docker:test:receipt',
          classification: 'unknown',
          filterReason: 'unknown',
          filteredAt: '2026-08-14T00:00:00.000Z',
        },
        {
          schema: 'anysentry.e2e_filter_receipt.v1',
          eventKind: 'ToolExec',
          markerSha256: 'c'.repeat(64),
          lineSha256: 'd'.repeat(65),
          classification: 'unknown',
          filterReason: 'unknown',
          filteredAt: 'not-a-date',
        },
      ],
      deduplicated: 0,
      queueDropped: 0,
      batches: 1,
      batchEvents: 9,
      identitySnapshotReady: true,
      identitySnapshotVersion: 7,
      identitySnapshotAgeSeconds: 2,
      identityCacheEntries: 12,
      identityCacheHits: 8,
      identityCacheMisses: 1,
      identityCandidateCacheEntries: 4,
      identityCgroupBindings: 3,
      identityCgroupHits: 7,
      identityCgroupMisses: 1,
      identityErrors: 0,
      dockerEnabled: true,
      dockerReady: true,
      dockerEntries: 4,
      dockerReconnects: 0,
      dockerErrors: 0,
      behaviorWorkloads: 3,
      behaviorCandidates: 1,
      behaviorPromoted: 1,
      behaviorEvicted: 0,
      templateLoaded: 2,
      templateInvalid: 0,
      templateMatches: 2,
      templateAmbiguous: 0,
      processCacheEntries: 8,
      processTombstones: 1,
      processClassifications: 12,
      processCacheHits: 10,
      processCacheMisses: 2,
      processProcReads: 1,
    },
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
      health.items?.[0]?.errorCount === 1 &&
      health.items?.[0]?.filterMetrics?.scope === 'shadow' &&
      health.items?.[0]?.filterMetrics?.wouldFilterNonAgent === 3 &&
      health.items?.[0]?.filterMetrics?.e2eFilterReceipts?.length === 1 &&
      health.items?.[0]?.filterMetrics?.e2eFilterReceipts?.[0]?.markerSha256 === 'a'.repeat(64) &&
      health.items?.[0]?.filterMetrics?.e2eFilterReceipts?.[0]?.lineSha256 === 'b'.repeat(64) &&
      health.items?.[0]?.filterMetrics?.behaviorCandidates === 1 &&
      health.items?.[0]?.filterMetrics?.processTombstones === 1 &&
      health.items?.[0]?.filterMetrics?.identityCgroupHits === 7 &&
      health.items?.[0]?.filterMetrics?.processProcReads === 1,
    health,
  );
}

async function verifyRawHeartbeatPreservesForwarderMetrics(sourceId, token) {
  // The Rust collector and the enriched Forwarder intentionally publish under the same
  // collector ID. Give the raw heartbeat a strictly later timestamp so this checks the
  // record selected by Collector health instead of accidentally reading the prior record.
  await new Promise((resolve) => setTimeout(resolve, 5));
  const line = observerLine(
    { agent: null, session: null },
    {
      CollectorHeartbeat: {
        node_name: `${runId}-node-raw-after-direct`,
        mode: 'observe',
        status: 'ok',
        interval_secs: 30,
        attached_probes: 11,
        enabled_features: ['exec'],
        exec: 5,
        observed_agents: 4,
      },
    },
  );
  const result = await request('/ingest', 'POST', {
    line,
    collectorId: `${runId}-collector`,
    sourceId,
    sourceName: `${runId} observer forwarder`,
    sourceType: 'observer',
    token,
    workspacePath: `repo://${runId}/observer`,
  });
  assert('later raw CollectorHeartbeat is accepted after enriched heartbeat', result.accepted === true && result.kind === 'collector-heartbeat', result);

  const health = await request('/collectors/health', 'POST', { timeType: 'last_30d', collectorId: `${runId}-collector`, limit: 5 });
  assert(
    'raw CollectorHeartbeat preserves the latest enriched Forwarder metrics',
    health.total === 1 &&
      health.items?.[0]?.nodeName === `${runId}-node-raw-after-direct` &&
      health.items?.[0]?.mode === 'observe' &&
      health.items?.[0]?.state === 'healthy' &&
      health.items?.[0]?.observedAgentCount === 4 &&
      health.items?.[0]?.attachedProbes === 11 &&
      health.items?.[0]?.filterMetrics?.scope === 'shadow' &&
      health.items?.[0]?.filterMetrics?.wouldFilterNonAgent === 3 &&
      health.items?.[0]?.filterMetrics?.e2eFilterReceipts?.length === 1 &&
      health.items?.[0]?.filterMetrics?.e2eFilterReceipts?.[0]?.lineSha256 === 'b'.repeat(64) &&
      health.items?.[0]?.filterMetrics?.identityCgroupHits === 7,
    health,
  );
}

async function verifyCollectorSourceIsolation(sourceId) {
  const other = await createProtectedObserverSource('other');
  const mismatchedDirect = await request('/collectors/heartbeat', 'POST', {
    sourceId: other.source.sourceId,
    token: other.token,
    sourceName: `${runId}-other observer forwarder`,
    sourceType: 'observer',
    collectorId: `${runId}-collector`,
    nodeName: `${runId}-wrong-source-direct`,
    filterMetrics: { scope: 'shadow', observed: 99, wouldFilterNonAgent: 99 },
  });
  assert(
    'protected Source cannot publish enriched metrics under another collector ID',
    mismatchedDirect.accepted === false &&
      mismatchedDirect.sourceId === other.source.sourceId &&
      mismatchedDirect.reason === 'source collector does not match heartbeat collector',
    mismatchedDirect,
  );

  const mismatchedRaw = await request('/ingest', 'POST', {
    line: observerLine(
      { agent: null, session: null },
      { CollectorHeartbeat: { node_name: `${runId}-wrong-source-raw`, mode: 'observe', exec: 77 } },
    ),
    collectorId: `${runId}-collector`,
    sourceId: other.source.sourceId,
    sourceName: `${runId}-other observer forwarder`,
    sourceType: 'observer',
    token: other.token,
  });
  assert(
    'protected Source cannot publish raw heartbeat under another collector ID',
    mismatchedRaw.accepted === false &&
      mismatchedRaw.sourceId === other.source.sourceId &&
      mismatchedRaw.reason === 'source collector does not match heartbeat collector',
    mismatchedRaw,
  );

  const ownCollectorId = `${runId}-other-collector`;
  const ownRaw = await request('/ingest', 'POST', {
    line: observerLine(
      { agent: null, session: null },
      { CollectorHeartbeat: { node_name: `${runId}-other-node`, mode: 'observe', exec: 1 } },
    ),
    collectorId: ownCollectorId,
    sourceId: other.source.sourceId,
    sourceName: `${runId}-other observer forwarder`,
    sourceType: 'observer',
    token: other.token,
  });
  assert('isolated Source can publish under its own collector ID', ownRaw.accepted === true && ownRaw.collectorId === ownCollectorId, ownRaw);

  const otherHealth = await request('/collectors/health', 'POST', { timeType: 'last_30d', collectorId: ownCollectorId, limit: 5 });
  assert(
    'raw heartbeat on isolated collector cannot inherit enriched metrics',
    otherHealth.total === 1 &&
      otherHealth.items?.[0]?.filterMetrics?.scope === 'decoupled' &&
      otherHealth.items?.[0]?.filterMetrics?.observed === 0 &&
      !otherHealth.items?.[0]?.filterMetrics?.e2eFilterReceipts?.length,
    otherHealth,
  );

  const primaryHealth = await request('/collectors/health', 'POST', { timeType: 'last_30d', collectorId: `${runId}-collector`, limit: 5 });
  assert(
    'rejected cross-Source heartbeats do not replace primary collector metrics',
    primaryHealth.total === 1 &&
      primaryHealth.items?.[0]?.filterMetrics?.wouldFilterNonAgent === 3 &&
      primaryHealth.items?.[0]?.filterMetrics?.e2eFilterReceipts?.[0]?.lineSha256 === 'b'.repeat(64),
    { sourceId, primaryHealth },
  );
}

async function verifyExplicitForwarderMetricsReplacePrevious(sourceId, token) {
  await new Promise((resolve) => setTimeout(resolve, 5));
  const result = await request('/collectors/heartbeat', 'POST', {
    sourceId,
    token,
    sourceName: `${runId} observer forwarder`,
    sourceType: 'observer',
    collectorId: `${runId}-collector`,
    nodeName: `${runId}-node-explicit-zero`,
    mode: 'observer-forwarder',
    status: 'ok',
    intervalSecs: 30,
    filterMetrics: {
      scope: 'shadow',
      filterMode: 'shadow',
      observed: 0,
      wouldFilterNonAgent: 0,
      e2eFilterReceipts: [],
    },
  });
  assert('new enriched heartbeat with explicit zero metrics is accepted', result.accepted === true, result);
  const health = await request('/collectors/health', 'POST', { timeType: 'last_30d', collectorId: `${runId}-collector`, limit: 5 });
  assert(
    'new enriched heartbeat replaces prior non-zero metrics and receipts',
    health.total === 1 &&
      health.items?.[0]?.nodeName === `${runId}-node-explicit-zero` &&
      health.items?.[0]?.filterMetrics?.scope === 'shadow' &&
      health.items?.[0]?.filterMetrics?.observed === 0 &&
      health.items?.[0]?.filterMetrics?.wouldFilterNonAgent === 0 &&
      !health.items?.[0]?.filterMetrics?.e2eFilterReceipts?.length,
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
  await verifyCollectorMetricFreshnessContract();
  await request('/stats');
  await verifyIdentitySnapshotContract();
  const { source, token } = await createProtectedObserverSource();
  await verifyRejectedObserverToken(source.sourceId);
  await verifyObserverToolEvent(source.sourceId, token);
  await verifyIncompleteObserverEvidence(source.sourceId, token);
  await verifyObserverBatch(source.sourceId, token);
  await verifyInternalL3RecursionSuppressed(source.sourceId, token);
  await verifyObserverLlmEndpoint(source.sourceId, token);
  await verifyRawCollectorHeartbeat(source.sourceId, token);
  await verifyDirectForwarderHeartbeat(source.sourceId, token);
  await verifyCollectorSourceIsolation(source.sourceId);
  await verifyRawHeartbeatPreservesForwarderMetrics(source.sourceId, token);
  await verifyExplicitForwarderMetricsReplacePrevious(source.sourceId, token);
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
