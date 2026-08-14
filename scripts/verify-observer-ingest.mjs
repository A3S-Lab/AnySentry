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

async function rawJsonStatus(path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...managementAuthHeaders() },
    body,
  });
  await res.arrayBuffer();
  return res.status;
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
    origin: 'forwarder',
    filterMetricsReportedAt: at,
    nodeName: `${runId}-enriched-same-ms`,
    status: 'degraded',
    droppedEvents: 2,
    outputDropped: 3,
    errorCount: 4,
    filterMetrics: { scope: 'shadow', observed: 9 },
  });
  const sameMillisecondRaw = heartbeat({
    origin: 'raw_collector',
    nodeName: `${runId}-raw-same-ms`,
  });
  const sameMillisecondAggregation = new AggregationService({
    query: () => [],
    queryCollectorHeartbeats: () => [sameMillisecondEnriched, sameMillisecondRaw],
    collectorHeartbeatHeads: () => ({
      latest: [sameMillisecondRaw],
      latestMetrics: [sameMillisecondEnriched],
      latestRaw: [sameMillisecondRaw],
      latestForwarder: [sameMillisecondEnriched],
    }),
  }, {}, {}, {});
  const sameMillisecondHealth = sameMillisecondAggregation.collectorHealth({ timeType: 'last_30d', collectorId: sameMillisecondRaw.collectorId });
  assert(
    'same-millisecond raw heartbeat cannot erase Forwarder operational errors or enriched metrics',
    sameMillisecondHealth.items?.[0]?.nodeName === `${runId}-raw-same-ms` &&
      sameMillisecondHealth.items?.[0]?.state === 'degraded' &&
      sameMillisecondHealth.items?.[0]?.droppedEvents === 2 &&
      sameMillisecondHealth.items?.[0]?.outputDropped === 3 &&
      sameMillisecondHealth.items?.[0]?.errorCount === 4 &&
      sameMillisecondHealth.items?.[0]?.filterMetrics?.scope === 'shadow' &&
      sameMillisecondHealth.items?.[0]?.filterMetrics?.observed === 9 &&
      sameMillisecondHealth.items?.[0]?.windowErrorMaxima?.droppedEvents === 2 &&
      sameMillisecondHealth.items?.[0]?.windowErrorMaxima?.outputDropped === 3 &&
      sameMillisecondHealth.items?.[0]?.windowErrorMaxima?.errorCount === 4 &&
      sameMillisecondHealth.items?.[0]?.filterMetricsReported === true,
    sameMillisecondHealth,
  );

  const historicalInside = heartbeat({
    at: at - 2_000,
    origin: 'raw_collector',
    droppedEvents: 2,
    outputDropped: 3,
    errorCount: 4,
    execEvidence: {
      exec: 2,
      execTruncated: 1,
      execIncomplete: 1,
      execReassemblyTimeout: 0,
      shutdownFinal: false,
    },
  });
  const historicalAfterEnd = heartbeat({
    at: at - 500,
    origin: 'raw_collector',
    droppedEvents: 99,
    outputDropped: 99,
    errorCount: 99,
    execEvidence: {
      exec: 99,
      execTruncated: 99,
      execIncomplete: 99,
      execReassemblyTimeout: 99,
      shutdownFinal: true,
    },
  });
  const historicalAggregation = new AggregationService({
    query: () => [],
    queryCollectorHeartbeats: () => [historicalInside, historicalAfterEnd],
    collectorHeartbeatHeads: () => ({
      latest: [historicalAfterEnd],
      latestMetrics: [],
      latestRaw: [historicalAfterEnd],
      latestForwarder: [],
    }),
  }, {}, {}, {});
  const historicalHealth = historicalAggregation.collectorHealth({
    timeType: 'custom',
    startTime: new Date(at - 3_000).toISOString(),
    endTime: new Date(at - 1_000).toISOString(),
    collectorId: historicalInside.collectorId,
  });
  assert(
    'collector window error maxima exclude heartbeats after a custom end time',
    historicalHealth.items?.[0]?.windowErrorMaxima?.droppedEvents === 2 &&
      historicalHealth.items?.[0]?.windowErrorMaxima?.outputDropped === 3 &&
      historicalHealth.items?.[0]?.windowErrorMaxima?.errorCount === 4 &&
      historicalHealth.items?.[0]?.execEvidence?.reported === true &&
      historicalHealth.items?.[0]?.execEvidence?.latest?.exec === 2 &&
      historicalHealth.items?.[0]?.execEvidence?.window?.exec === 2 &&
      historicalHealth.items?.[0]?.execEvidence?.window?.execIncomplete === 1 &&
      historicalHealth.items?.[0]?.execEvidence?.window?.heartbeatCount === 1 &&
      historicalHealth.items?.[0]?.execEvidence?.window?.intervalSecs === 30 &&
      historicalHealth.items?.[0]?.execEvidence?.latest?.shutdownFinal === false &&
      historicalHealth.items?.[0]?.execEvidence?.window?.shutdownFinalCount === 0 &&
      historicalHealth.items?.[0]?.filterMetricsReported === false,
    historicalHealth,
  );

  const expiredAt = at - 4 * 60_000;
  const expiredEnriched = heartbeat({
    at: expiredAt,
    origin: 'forwarder',
    filterMetricsReportedAt: expiredAt,
    nodeName: `${runId}-expired-enriched`,
    filterMetrics: { scope: 'shadow', observed: 99 },
  });
  const currentRaw = heartbeat({
    at: at - 1_000,
    origin: 'raw_collector',
    nodeName: `${runId}-current-raw`,
  });
  const expiredAggregation = new AggregationService({
    query: () => [],
    queryCollectorHeartbeats: () => [expiredEnriched, currentRaw],
    collectorHeartbeatHeads: () => ({
      latest: [currentRaw],
      latestMetrics: [expiredEnriched],
      latestRaw: [currentRaw],
      latestForwarder: [expiredEnriched],
    }),
  }, {}, {}, {});
  const expiredHealth = expiredAggregation.collectorHealth({ timeType: 'last_30d', collectorId: currentRaw.collectorId });
  assert(
    'raw heartbeats cannot renew expired enriched filter metrics',
    expiredHealth.items?.[0]?.nodeName === `${runId}-current-raw` &&
      expiredHealth.items?.[0]?.filterMetrics?.scope === 'decoupled' &&
      expiredHealth.items?.[0]?.filterMetrics?.observed === 0 &&
      expiredHealth.items?.[0]?.filterMetricsReported === false,
    expiredHealth,
  );

  const noFilterForwarder = heartbeat({
    collectorId: `${runId}-no-filter-forwarder`,
    origin: 'forwarder',
    status: 'error',
    errorCount: 2,
    filterMetrics: undefined,
  });
  const noFilterAggregation = new AggregationService({
    query: () => [],
    queryCollectorHeartbeats: () => [noFilterForwarder],
    collectorHeartbeatHeads: () => ({
      latest: [noFilterForwarder],
      latestMetrics: [],
      latestRaw: [],
      latestForwarder: [noFilterForwarder],
    }),
  }, {}, {}, {});
  const noFilterHealth = noFilterAggregation.collectorHealth({
    timeType: 'last_30d', collectorId: noFilterForwarder.collectorId,
  });
  assert(
    'Forwarder heartbeat without filter metrics still drives operational health',
    noFilterHealth.items?.[0]?.state === 'degraded' &&
      noFilterHealth.items?.[0]?.errorCount === 2 &&
      noFilterHealth.items?.[0]?.filterMetrics?.scope === 'decoupled',
    noFilterHealth,
  );
}

async function verifyHotRingCapacityContract() {
  const previous = process.env.ANYSENTRY_EVENT_RING_MAX;
  process.env.ANYSENTRY_EVENT_RING_MAX = '1234';
  try {
    const { SentryJudgeService } = await import('../apps/api/dist/security-monitoring/sentry-judge.service.js');
    const judge = new SentryJudgeService({}, {}, { enabled: false }, {});
    const storage = judge.storageStatus();
    assert(
      'event hot ring has an explicit bounded and observable capacity',
      storage.hotRingCapacity === 1234 && storage.hotRingSize === 0,
      storage,
    );
    for (let index = 0; index < 1_500; index += 1) {
      judge.upsertMemory({ eventId: `ring-cap-${index}` }, false);
    }
    const boundedStorage = judge.storageStatus();
    assert(
      'event hot ring never retains more than its advertised capacity',
      boundedStorage.hotRingSize <= 1_234 &&
        judge.storeById.size === boundedStorage.hotRingSize &&
        !judge.storeById.has('ring-cap-0'),
      { ...boundedStorage, indexed: judge.storeById.size },
    );

    process.env.ANYSENTRY_EVENT_RING_MAX = '';
    const defaultJudge = new SentryJudgeService({}, {}, { enabled: false }, {});
    assert(
      'an empty hot-ring setting uses the safe 10,000-event default',
      defaultJudge.storageStatus().hotRingCapacity === 10_000,
      defaultJudge.storageStatus(),
    );
  } finally {
    if (previous === undefined) delete process.env.ANYSENTRY_EVENT_RING_MAX;
    else process.env.ANYSENTRY_EVENT_RING_MAX = previous;
  }
}

async function verifyCollectorHeartbeatProvenanceContract() {
  const [{ SentryJudgeService }, { AlertingService }] = await Promise.all([
    import('../apps/api/dist/security-monitoring/sentry-judge.service.js'),
    import('../apps/api/dist/security-monitoring/alerting.service.js'),
  ]);
  const observed = [];
  const seeded = [];
  const judge = new SentryJudgeService(
    {
      observeCollectorHeartbeat: (heartbeat) => observed.push(heartbeat),
      seedCollectorHeartbeat: (heartbeat) => seeded.push(heartbeat),
    },
    {},
    { enabled: false },
    {},
  );
  const raw = judge.recordCollectorHeartbeat({
    collectorId: `${runId}-raw-provenance`,
    mode: 'observe',
    intervalSecs: 30,
    eventKindCounts: { ToolExec: 3 },
    errorCount: 2,
    execEvidence: {
      exec: 3,
      execTruncated: 1,
      execIncomplete: 2,
      execReassemblyTimeout: 1,
      shutdownFinal: true,
    },
    filterMetrics: { scope: 'shadow', shutdownFinal: true, observed: 99 },
  }, 1_000, 'raw_collector');
  assert(
    'server-assigned raw provenance separates exec quality from operational health',
    raw.origin === 'raw_collector' &&
      raw.errorCount === 0 &&
      raw.execEvidence?.execIncomplete === 2 &&
      raw.execEvidence?.shutdownFinal === true &&
      raw.filterMetricsReportedAt === undefined &&
      raw.filterMetrics.scope === 'decoupled' &&
      raw.filterMetrics.shutdownFinal === false &&
      observed.at(-1)?.errorCount === 0,
    { raw, observed },
  );
  const forwarder = judge.recordCollectorHeartbeat({
    collectorId: `${runId}-forwarder-provenance`,
    errorCount: 2,
    execEvidence: {
      exec: 999,
      execTruncated: 999,
      execIncomplete: 999,
      execReassemblyTimeout: 999,
      shutdownFinal: true,
    },
    filterMetrics: { scope: 'shadow', shutdownFinal: true, observed: 1 },
  }, 2_000, 'forwarder');
  assert(
    'server-assigned forwarder provenance ignores raw-only evidence',
    forwarder.origin === 'forwarder' &&
      forwarder.errorCount === 2 &&
      forwarder.execEvidence === undefined &&
      forwarder.filterMetricsReportedAt === 2_000 &&
      forwarder.filterMetrics.shutdownFinal === true,
    forwarder,
  );

  const notificationsBeforeHydration = observed.length;
  const legacyRaw = judge.normalizeHydratedCollectorHeartbeat({
    ...raw,
    origin: undefined,
    mode: 'observe+extensions',
    execEvidence: undefined,
    errorCount: 1_899,
  });
  judge.addCollectorHeartbeat(legacyRaw, false, false);
  assert(
    'legacy raw hydration removes exec-incomplete fallback and never replays notifications',
      legacyRaw.origin === 'raw_collector' &&
      legacyRaw.errorCount === 0 &&
      observed.length === notificationsBeforeHydration &&
      seeded.at(-1)?.collectorId === legacyRaw.collectorId,
    { legacyRaw, observed: observed.length, notificationsBeforeHydration, seeded },
  );
  const legacyForwarder = judge.normalizeHydratedCollectorHeartbeat({
    ...raw,
    collectorId: `${runId}-legacy-forwarder-no-metrics`,
    origin: undefined,
    filterMetricsReportedAt: undefined,
    mode: 'observer-forwarder:shadow',
    status: 'error',
    errorCount: 2,
    execEvidence: undefined,
  });
  judge.addCollectorHeartbeat(legacyForwarder, false, false);
  const hydratedHeads = judge.collectorHeartbeatHeads();
  assert(
    'legacy Forwarder without filter metrics retains its operational provenance after hydration',
    legacyForwarder.origin === 'forwarder' &&
      legacyForwarder.errorCount === 2 &&
      hydratedHeads.latestForwarder.some((item) =>
        item.collectorId === legacyForwarder.collectorId && item.errorCount === 2),
    { legacyForwarder, hydratedHeads },
  );

  const inconsistentRaw = judge.recordCollectorHeartbeat({
    collectorId: `${runId}-inconsistent-raw-evidence`,
    mode: 'observe+extensions',
    eventKindCounts: { ToolExec: 1 },
    execEvidence: {
      exec: 1,
      execTruncated: 2,
      execIncomplete: 0,
      execReassemblyTimeout: 0,
      shutdownFinal: true,
    },
  }, 3_000, 'raw_collector');
  assert(
    'raw evidence whose quality counters exceed ToolExec count is not reported',
    inconsistentRaw.execEvidence === undefined,
    inconsistentRaw,
  );

  const alerting = new AlertingService(
    { activeFor: () => false },
    { dispatch: async () => 0, config: () => ({ summary: { enabledChannels: 0 } }) },
    { snapshot: () => [] },
    { get: () => undefined },
  );
  alerting.config.enabled = true;
  const alertCollector = `${runId}-origin-alert-collector`;
  const heartbeat = (origin, at, overrides = {}) => ({
    collectorId: alertCollector,
    at,
    origin,
    status: 'ok',
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
  const alertAt = Date.now();
  alerting.observeCollectorHeartbeat(heartbeat('forwarder', alertAt, { errorCount: 1 }));
  alerting.observeCollectorHeartbeat(heartbeat('raw_collector', alertAt + 1));
  let qualityAlerts = alerting.list({
    timeType: 'last_30d', collectorId: alertCollector, kind: 'collector', limit: 10,
  }).items.filter((item) => item.ruleId === 'collector.quality');
  assert(
    'clean raw heartbeat cannot resolve a Forwarder-origin quality alert',
    qualityAlerts.some((item) =>
      item.status === 'open' && item.labels?.heartbeatOrigin === 'forwarder'),
    qualityAlerts,
  );
  alerting.observeCollectorHeartbeat(heartbeat('raw_collector', alertAt + 2, { droppedEvents: 1 }));
  alerting.observeCollectorHeartbeat(heartbeat('forwarder', alertAt + 3));
  qualityAlerts = alerting.list({
    timeType: 'last_30d', collectorId: alertCollector, kind: 'collector', limit: 10,
  }).items.filter((item) => item.ruleId === 'collector.quality');
  assert(
    'quality recovery is isolated by heartbeat origin',
    qualityAlerts.some((item) =>
      item.status === 'resolved' && item.labels?.heartbeatOrigin === 'forwarder') &&
      qualityAlerts.some((item) =>
        item.status === 'open' && item.labels?.heartbeatOrigin === 'raw_collector'),
    qualityAlerts,
  );

  const hydratedCollector = `${runId}-hydrated-liveness-collector`;
  alerting.seedCollectorHeartbeat(heartbeat('forwarder', alertAt - 700_000, {
    collectorId: hydratedCollector,
  }));
  alerting.checkCollectorAvailability(alertAt);
  const availabilityAlerts = alerting.list({
    timeType: 'last_30d', collectorId: hydratedCollector, kind: 'collector', limit: 10,
  }).items.filter((item) => item.ruleId === 'collector.availability');
  assert(
    'hydration seeds collector liveness without replaying historical quality notifications',
    availabilityAlerts.some((item) => item.status === 'open'),
    availabilityAlerts,
  );
}

async function verifyJudgeDispositionContract() {
  const [{ SentryJudgeService }, { DEFAULT_POLICY }] = await Promise.all([
    import('../apps/api/dist/security-monitoring/sentry-judge.service.js'),
    import('../apps/api/dist/security-monitoring/policy-config.js'),
  ]);
  for (const enabled of [false, true]) {
    let enqueued = 0;
    const judge = new SentryJudgeService(
      { observeEvent: () => undefined, observeIncident: () => undefined },
      { attribute: () => undefined },
      { enabled, enqueueFast: async () => { enqueued += 1; } },
      { get: () => undefined },
    );
    judge.applyPolicy(DEFAULT_POLICY);
    const meta = {
      agentId: `${runId}-judge-agent`,
      workspacePath: `repo://${runId}/judge`,
      sessionId: `${runId}-judge-session`,
      userId: 'uid:1000',
      eventKind: 'ToolExec',
      eventCategory: 'tool',
      source: 'observer',
      attributes: {},
      attribution: {
        monitored: false,
        classification: 'non_agent',
        confidence: 1,
        reason: 'not_agent',
        source: 'none',
        evidence: [`test:${runId}`],
      },
    };
    const discarded = await judge.acceptWithDisposition('{}', meta);
    assert(
      `Judge ${enabled ? 'queued' : 'synchronous'} path distinguishes policy discard`,
      discarded.disposition === 'discarded' && discarded.reasonCode === 'non_agent_discarded',
      discarded,
    );
    const rejected = await judge.acceptWithDisposition('{}', {
      ...meta,
      eventKind: 'UnsupportedObserverEvent',
      eventCategory: 'unknown',
    });
    assert(
      `Judge ${enabled ? 'queued' : 'synchronous'} path distinguishes unsupported input`,
      rejected.disposition === 'rejected' && rejected.reasonCode === 'unsupported_or_unparseable',
      rejected,
    );
    if (enabled) {
      judge.ch.insertNow = async () => undefined;
      const retained = await judge.acceptWithDisposition('{}', {
        ...meta,
        attribution: { ...meta.attribution, classification: 'unknown', reason: 'not_evaluated', confidence: 0 },
      });
      assert(
        'Judge queued path retains and enqueues a supported event',
        retained.disposition === 'retained' && retained.event?.decisionStatus === 'pending' && enqueued === 1,
        { retained, enqueued },
      );
    }
  }
}

async function verifyRouteScopedBodyLimits() {
  const ordinaryStatus = await rawJsonStatus('/ingest', JSON.stringify({ padding: 'x'.repeat(120 * 1024) }));
  assert(
    'ordinary ingest keeps the narrow default JSON body limit',
    ordinaryStatus === 413,
    { status: ordinaryStatus },
  );

  const snapshotStatus = await rawJsonStatus(
    '/runtime/snapshot',
    JSON.stringify({ padding: 'x'.repeat(120 * 1024) }),
  );
  assert(
    'runtime snapshot payloads above 100 KiB reach controller validation',
    snapshotStatus !== 413,
    { status: snapshotStatus },
  );

  const oversizedBatchStatus = await rawJsonStatus(
    '/ingest/batch',
    JSON.stringify({ events: [], padding: 'x'.repeat(5 * 1024 * 1024) }),
  );
  assert(
    'observer batch body limit rejects payloads above 4 MiB',
    oversizedBatchStatus === 413,
    { status: oversizedBatchStatus },
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

async function verifyObserverDiscardDisposition() {
  const sourcePrefix = `${runId}-discard`;
  const { source, token } = await createProtectedObserverSource('discard');
  const collectorId = `${sourcePrefix}-collector`;
  const marker = `${sourcePrefix}-policy-discard`;
  const discardedEvent = (suffix) => ({
    line: observerLine(
      { agent: `${marker}-${suffix}`, session: marker, task: suffix },
      { ToolExec: { pid: 48_000 + suffix.length, uid: 1000, cwd: `/workspace/${marker}`, argv: ['/usr/bin/true', marker, suffix] } },
    ),
    sourceEventId: `${marker}-${suffix}`,
    collectorId,
    nodeName: `${sourcePrefix}-node`,
    attribution: {
      monitored: false,
      classification: 'non_agent',
      agentScopeId: `${marker}-scope`,
      confidence: 1,
      reason: 'not_agent',
      source: 'none',
      evidence: [`test:${marker}`],
    },
  });

  const single = await request('/ingest', 'POST', discardedEvent('single'), sourceHeaders(source.sourceId, token));
  assert(
    'single Observer policy discard preserves its compatibility boolean and explicit disposition',
    single.accepted === false &&
      single.disposition === 'discarded' &&
      single.retained === false &&
      single.reasonCode === 'non_agent_discarded' &&
      !single.eventId,
    single,
  );

  const mixed = await request('/ingest/batch', 'POST', {
    events: [
      discardedEvent('batch'),
      {
        line: `${marker}-not-json`,
        sourceEventId: `${marker}-invalid`,
        collectorId,
        nodeName: `${sourcePrefix}-node`,
      },
    ],
  }, sourceHeaders(source.sourceId, token));
  assert(
    'Observer batch ACK separates a deliberate discard from a hard rejection',
    mixed.accepted === true &&
      mixed.acceptedEvents === 1 &&
      mixed.retainedEvents === 0 &&
      mixed.discardedEvents === 1 &&
      mixed.rejectedEvents === 1 &&
      mixed.items?.[0]?.accepted === true &&
      mixed.items?.[0]?.disposition === 'discarded' &&
      mixed.items?.[0]?.reasonCode === 'non_agent_discarded' &&
      mixed.items?.[1]?.accepted === false &&
      mixed.items?.[1]?.disposition === 'rejected' &&
      mixed.items?.[1]?.reasonCode === 'unsupported_or_unparseable',
    mixed,
  );

  const allDiscarded = await request('/ingest/batch', 'POST', {
    events: [discardedEvent('all-a'), discardedEvent('all-b')],
  }, sourceHeaders(source.sourceId, token));
  assert(
    'an all-discarded Observer batch is transport-successful without retained events',
    allDiscarded.accepted === true &&
      allDiscarded.acceptedEvents === 2 &&
      allDiscarded.retainedEvents === 0 &&
      allDiscarded.discardedEvents === 2 &&
      allDiscarded.rejectedEvents === 0 &&
      allDiscarded.items?.every((item) => item.accepted === true && item.disposition === 'discarded'),
    allDiscarded,
  );

  const events = await request('/events/list', 'POST', { timeType: 'last_30d', q: marker, includeUnknown: true, limit: 20 });
  assert('policy-discarded Observer events never enter the event/L1 store', events.total === 0, events);
  const sources = await request('/sources/list', 'POST', { sourceId: source.sourceId, limit: 5 });
  const item = sources.items?.[0];
  assert(
    'policy discards count as consumed Source events while only malformed input counts as rejected',
    sources.total === 1 && item?.acceptedEvents === 4 && item?.rejectedEvents === 1 && item?.lastResult === 'accepted',
    sources,
  );
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
  const events = Array.from({ length: 24 }, (_, index) => 1711 + index).map((pid) => ({
    line: observerLine(
      { agent: 'pod-batch', session: 'container-batch', task: String(pid) },
      {
        ToolExec: {
          pid,
          ppid: 1700,
          uid: 1000,
          cwd: '/workspace/batch',
          argv: ['echo', `batch-${pid}`],
          padding: 'x'.repeat(6_000),
        },
      },
    ),
    collectorId: `${runId}-collector`,
    nodeName: `${runId}-node`,
    sourceType: 'observer',
    attribution,
  }));
  assert(
    'observer batch regression payload exceeds the old Express 100 KiB default',
    Buffer.byteLength(JSON.stringify({ events })) > 100 * 1024,
  );
  const result = await request('/ingest/batch', 'POST', { events }, sourceHeaders(sourceId, token));
  assert(
    'observer batch ingest accepts and accounts for every envelope',
    result.accepted === true &&
      result.acceptedEvents === events.length &&
      result.rejectedEvents === 0 &&
      result.items?.length === events.length &&
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
        exec_truncated: 1,
        exec_incomplete: 2,
        exec_reassembly_timeout: 1,
        shutdown_final: false,
        filter_metrics: { scope: 'shadow', shutdownFinal: true, runtimeSnapshotPosts: 999 },
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
      health.items?.[0]?.errorCount === 0 &&
      health.items?.[0]?.windowErrorMaxima?.errorCount === 0 &&
      health.items?.[0]?.observedAgentCount === 2 &&
      health.items?.[0]?.attachedProbes === 7 &&
      health.items?.[0]?.execEvidence?.reported === true &&
      health.items?.[0]?.execEvidence?.latest?.exec === 3 &&
      health.items?.[0]?.execEvidence?.latest?.execTruncated === 1 &&
      health.items?.[0]?.execEvidence?.latest?.execIncomplete === 2 &&
      health.items?.[0]?.execEvidence?.latest?.execReassemblyTimeout === 1 &&
      health.items?.[0]?.execEvidence?.latest?.shutdownFinal === false &&
      health.items?.[0]?.execEvidence?.latest?.intervalSecs === 30 &&
      health.items?.[0]?.execEvidence?.window?.heartbeatCount === 1 &&
      health.items?.[0]?.execEvidence?.window?.intervalSecs === 30 &&
      health.items?.[0]?.execEvidence?.window?.shutdownFinalCount === 0 &&
      health.items?.[0]?.filterMetrics?.scope === 'decoupled' &&
      health.items?.[0]?.filterMetrics?.shutdownFinal === false,
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
    droppedEvents: 2,
    outputDropped: 1,
    errorCount: 1,
    observedAgents: 2,
    execEvidence: {
      exec: 999,
      execTruncated: 999,
      execIncomplete: 999,
      execReassemblyTimeout: 999,
      shutdownFinal: true,
    },
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
      retryQueued: 5,
      retryAttempts: 4,
      retryRecovered: 3,
      retryExhausted: 1,
      queueBytes: 1234,
      inflightEvents: 2,
      inflightBytes: 567,
      inflightOldestAgeMs: 89,
      retryQueueDepth: 1,
      retryQueueBytes: 234,
      retryOutstandingEvents: 3,
      retryOutstandingBytes: 678,
      retryOldestAgeMs: 321,
      outstandingEvents: 7,
      outstandingBytes: 2479,
      outstandingOldestAgeMs: 654,
      outstandingEventLimit: 16_384,
      outstandingByteLimit: 64 * 1024 * 1024,
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
      runtimeSnapshotRetries: 2,
      runtimeSnapshotRecovered: 1,
      lastRuntimeSnapshotFailureAt: '2026-08-14T00:00:01.000Z',
      lastRuntimeSnapshotFailure: 'snapshot transport timed out',
      lastRuntimeSnapshotFailureVersion: 9,
      lastRuntimeSnapshotRetryAt: '2026-08-14T00:00:02.000Z',
      lastRuntimeSnapshotRetryReason: 'snapshot transport timed out',
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
      health.items?.[0]?.droppedEvents === 2 &&
      health.items?.[0]?.outputDropped === 1 &&
      health.items?.[0]?.errorCount === 1 &&
      health.items?.[0]?.windowErrorMaxima?.droppedEvents === 2 &&
      health.items?.[0]?.windowErrorMaxima?.outputDropped === 1 &&
      health.items?.[0]?.windowErrorMaxima?.errorCount === 1 &&
      health.items?.[0]?.filterMetrics?.scope === 'shadow' &&
      health.items?.[0]?.filterMetrics?.wouldFilterNonAgent === 3 &&
      health.items?.[0]?.filterMetrics?.e2eFilterReceipts?.length === 1 &&
      health.items?.[0]?.filterMetrics?.e2eFilterReceipts?.[0]?.markerSha256 === 'a'.repeat(64) &&
      health.items?.[0]?.filterMetrics?.e2eFilterReceipts?.[0]?.lineSha256 === 'b'.repeat(64) &&
      health.items?.[0]?.filterMetrics?.behaviorCandidates === 1 &&
      health.items?.[0]?.filterMetrics?.processTombstones === 1 &&
      health.items?.[0]?.filterMetrics?.identityCgroupHits === 7 &&
      health.items?.[0]?.filterMetrics?.processProcReads === 1 &&
      health.items?.[0]?.filterMetrics?.retryQueued === 5 &&
      health.items?.[0]?.filterMetrics?.retryAttempts === 4 &&
      health.items?.[0]?.filterMetrics?.retryRecovered === 3 &&
      health.items?.[0]?.filterMetrics?.retryExhausted === 1 &&
      health.items?.[0]?.filterMetrics?.queueBytes === 1234 &&
      health.items?.[0]?.filterMetrics?.inflightEvents === 2 &&
      health.items?.[0]?.filterMetrics?.inflightBytes === 567 &&
      health.items?.[0]?.filterMetrics?.inflightOldestAgeMs === 89 &&
      health.items?.[0]?.filterMetrics?.retryQueueDepth === 1 &&
      health.items?.[0]?.filterMetrics?.retryQueueBytes === 234 &&
      health.items?.[0]?.filterMetrics?.retryOutstandingEvents === 3 &&
      health.items?.[0]?.filterMetrics?.retryOutstandingBytes === 678 &&
      health.items?.[0]?.filterMetrics?.retryOldestAgeMs === 321 &&
      health.items?.[0]?.filterMetrics?.outstandingEvents === 7 &&
      health.items?.[0]?.filterMetrics?.outstandingBytes === 2479 &&
      health.items?.[0]?.filterMetrics?.outstandingOldestAgeMs === 654 &&
      health.items?.[0]?.filterMetrics?.outstandingEventLimit === 16_384 &&
      health.items?.[0]?.filterMetrics?.outstandingByteLimit === 64 * 1024 * 1024 &&
      health.items?.[0]?.filterMetrics?.runtimeSnapshotRetries === 2 &&
      health.items?.[0]?.filterMetrics?.runtimeSnapshotRecovered === 1 &&
      health.items?.[0]?.filterMetrics?.lastRuntimeSnapshotFailureAt === '2026-08-14T00:00:01.000Z' &&
      health.items?.[0]?.filterMetrics?.lastRuntimeSnapshotFailure === 'snapshot transport timed out' &&
      health.items?.[0]?.filterMetrics?.lastRuntimeSnapshotFailureVersion === 9 &&
      health.items?.[0]?.filterMetrics?.lastRuntimeSnapshotRetryAt === '2026-08-14T00:00:02.000Z' &&
      health.items?.[0]?.filterMetrics?.lastRuntimeSnapshotRetryReason === 'snapshot transport timed out' &&
      health.items?.[0]?.execEvidence?.window?.exec === 3,
    health,
  );
  assert(
    'enriched heartbeat without a shutdown-final marker defaults to false',
    health.items?.[0]?.filterMetrics?.shutdownFinal === false,
    health,
  );
}

async function verifyShutdownFinalHeartbeatIsPreserved(sourceId, token) {
  await new Promise((resolve) => setTimeout(resolve, 5));
  const result = await request('/collectors/heartbeat', 'POST', {
    sourceId,
    token,
    sourceName: `${runId} observer forwarder`,
    sourceType: 'observer',
    collectorId: `${runId}-collector`,
    nodeName: `${runId}-node-shutdown-final`,
    mode: 'observer-forwarder',
    status: 'ok',
    intervalSecs: 30,
    filterMetrics: {
      scope: 'shadow',
      filterMode: 'shadow',
      shutdownFinal: true,
      observed: 0,
    },
  });
  assert('enriched shutdown-final heartbeat is accepted', result.accepted === true, result);
  const health = await request('/collectors/health', 'POST', { timeType: 'last_30d', collectorId: `${runId}-collector`, limit: 5 });
  assert(
    'Collector health preserves an explicit shutdown-final marker',
    health.total === 1 &&
      health.items?.[0]?.nodeName === `${runId}-node-shutdown-final` &&
      health.items?.[0]?.filterMetrics?.shutdownFinal === true,
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
        exec: 4029,
        exec_truncated: 0,
        // Regression: evidence-quality loss must remain observable without becoming an
        // operational collector error (the real host shutdown run reported this exact value).
        exec_incomplete: 1899,
        exec_reassembly_timeout: 4,
        shutdown_final: true,
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
      health.items?.[0]?.state === 'degraded' &&
      health.items?.[0]?.observedAgentCount === 4 &&
      health.items?.[0]?.attachedProbes === 11 &&
      health.items?.[0]?.droppedEvents === 2 &&
      health.items?.[0]?.outputDropped === 1 &&
      health.items?.[0]?.errorCount === 1 &&
      health.items?.[0]?.windowErrorMaxima?.droppedEvents === 2 &&
      health.items?.[0]?.windowErrorMaxima?.outputDropped === 1 &&
      health.items?.[0]?.windowErrorMaxima?.errorCount === 1 &&
      health.items?.[0]?.execEvidence?.reported === true &&
      health.items?.[0]?.execEvidence?.latest?.exec === 4029 &&
      health.items?.[0]?.execEvidence?.latest?.execTruncated === 0 &&
      health.items?.[0]?.execEvidence?.latest?.execIncomplete === 1899 &&
      health.items?.[0]?.execEvidence?.latest?.execReassemblyTimeout === 4 &&
      health.items?.[0]?.execEvidence?.latest?.shutdownFinal === true &&
      health.items?.[0]?.execEvidence?.latest?.intervalSecs === 30 &&
      health.items?.[0]?.execEvidence?.window?.exec === 4032 &&
      health.items?.[0]?.execEvidence?.window?.execTruncated === 1 &&
      health.items?.[0]?.execEvidence?.window?.execIncomplete === 1901 &&
      health.items?.[0]?.execEvidence?.window?.execReassemblyTimeout === 5 &&
      health.items?.[0]?.execEvidence?.window?.heartbeatCount === 2 &&
      health.items?.[0]?.execEvidence?.window?.intervalSecs === 60 &&
      health.items?.[0]?.execEvidence?.window?.shutdownFinalCount === 1 &&
      health.items?.[0]?.filterMetrics?.scope === 'shadow' &&
      health.items?.[0]?.filterMetrics?.wouldFilterNonAgent === 3 &&
      health.items?.[0]?.filterMetrics?.e2eFilterReceipts?.length === 1 &&
      health.items?.[0]?.filterMetrics?.e2eFilterReceipts?.[0]?.lineSha256 === 'b'.repeat(64) &&
      health.items?.[0]?.filterMetrics?.identityCgroupHits === 7 &&
      health.items?.[0]?.filterMetrics?.runtimeSnapshotRetries === 2 &&
      health.items?.[0]?.filterMetrics?.runtimeSnapshotRecovered === 1 &&
      health.items?.[0]?.filterMetrics?.lastRuntimeSnapshotFailure === 'snapshot transport timed out' &&
      health.items?.[0]?.filterMetrics?.lastRuntimeSnapshotRetryReason === 'snapshot transport timed out',
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
  const mismatchedEnvelope = await request('/ingest', 'POST', {
    line: observerLine(
      { agent: null, session: null },
      {
        CollectorHeartbeat: {
          collector_id: `${runId}-collector`,
          node_name: `${runId}-conflicting-envelope`,
          mode: 'observe',
          exec: 1,
          exec_truncated: 0,
          exec_incomplete: 0,
          exec_reassembly_timeout: 0,
          shutdown_final: false,
        },
      },
    ),
    collectorId: ownCollectorId,
    sourceId: other.source.sourceId,
    sourceName: `${runId}-other observer forwarder`,
    sourceType: 'observer',
    token: other.token,
  });
  assert(
    'raw heartbeat rejects conflicting envelope and embedded collector IDs',
    mismatchedEnvelope.accepted === false &&
      mismatchedEnvelope.sourceId === other.source.sourceId &&
      mismatchedEnvelope.reason === 'heartbeat envelope collector does not match raw collector',
    mismatchedEnvelope,
  );

  const whitespaceEnvelope = await request('/ingest', 'POST', {
    line: observerLine(
      { agent: null, session: null },
      {
        CollectorHeartbeat: {
          collector_id: `${runId}-collector`,
          node_name: `${runId}-whitespace-envelope`,
          mode: 'observe+extensions',
          exec: 1,
          exec_truncated: 0,
          exec_incomplete: 0,
          exec_reassembly_timeout: 0,
          shutdown_final: false,
        },
      },
    ),
    collectorId: '   ',
    sourceId: other.source.sourceId,
    sourceName: `${runId}-other observer forwarder`,
    sourceType: 'observer',
    token: other.token,
  });
  assert(
    'blank envelope collector cannot bypass Source-to-raw collector isolation',
    whitespaceEnvelope.accepted === false &&
      whitespaceEnvelope.sourceId === other.source.sourceId &&
      whitespaceEnvelope.reason === 'source collector does not match heartbeat collector',
    whitespaceEnvelope,
  );

  const anonymousOuter = `${runId}-anonymous-envelope`;
  const anonymousInner = `${runId}-anonymous-raw`;
  const anonymousConflict = await request('/ingest', 'POST', {
    line: observerLine(
      { agent: null, session: null },
      {
        CollectorHeartbeat: {
          collector_id: anonymousInner,
          mode: 'observe+extensions',
          exec: 1,
          exec_truncated: 0,
          exec_incomplete: 0,
          exec_reassembly_timeout: 0,
          shutdown_final: false,
        },
      },
    ),
    collectorId: anonymousOuter,
    sourceType: 'observer',
    sourceName: `${runId}-anonymous-conflict`,
  });
  const [anonymousOuterSources, anonymousInnerSources, anonymousOuterAlerts, anonymousInnerAlerts] = await Promise.all([
    request('/sources/list', 'POST', { collectorId: anonymousOuter, limit: 5 }),
    request('/sources/list', 'POST', { collectorId: anonymousInner, limit: 5 }),
    request('/alerts/list', 'POST', { timeType: 'last_30d', collectorId: anonymousOuter, kind: 'source', status: 'all', limit: 5 }),
    request('/alerts/list', 'POST', { timeType: 'last_30d', collectorId: anonymousInner, kind: 'source', status: 'all', limit: 5 }),
  ]);
  assert(
    'anonymous conflicting envelope is rejected without Source or alert side effects',
    anonymousConflict.accepted === false &&
      anonymousConflict.reason === 'heartbeat envelope collector does not match raw collector' &&
      anonymousOuterSources.total === 0 &&
      anonymousInnerSources.total === 0 &&
      anonymousOuterAlerts.total === 0 &&
      anonymousInnerAlerts.total === 0,
    { anonymousConflict, anonymousOuterSources, anonymousInnerSources, anonymousOuterAlerts, anonymousInnerAlerts },
  );

  const longCollectorId = `${runId}-long-${'x'.repeat(220)}`;
  const canonicalLongCollectorId = longCollectorId.slice(0, 180);
  const longSource = await request('/sources', 'POST', {
    name: `${runId}-long-collector-source`,
    type: 'observer',
    enabled: true,
    requireToken: true,
    collectorId: longCollectorId,
  });
  const longRaw = await request('/ingest', 'POST', {
    line: observerLine(
      { agent: null, session: null },
      {
        CollectorHeartbeat: {
          collector_id: longCollectorId,
          mode: 'observe+extensions',
          exec: 1,
          exec_truncated: 0,
          exec_incomplete: 0,
          exec_reassembly_timeout: 0,
          shutdown_final: false,
        },
      },
    ),
    collectorId: longCollectorId,
    sourceId: longSource.source.sourceId,
    token: longSource.token,
  });
  assert(
    'envelope, raw heartbeat, Source, and persisted record share one collector ID length domain',
    longSource.source.collectorId === canonicalLongCollectorId &&
      longRaw.accepted === true &&
      longRaw.collectorId === canonicalLongCollectorId,
    { longSource, longRaw, canonicalLongCollectorId },
  );

  const identityLikeCollectorId = `${runId}-token=sk-collectoridentity1234`;
  const identityLikeSource = await request('/sources', 'POST', {
    name: `${runId}-identity-like-collector-source`,
    type: 'observer',
    enabled: true,
    requireToken: true,
    collectorId: identityLikeCollectorId,
  });
  const identityLikeRaw = await request('/ingest', 'POST', {
    line: observerLine(
      { agent: null, session: null },
      {
        CollectorHeartbeat: {
          collector_id: identityLikeCollectorId,
          mode: 'observe+extensions',
          exec: 1,
          exec_truncated: 0,
          exec_incomplete: 0,
          exec_reassembly_timeout: 0,
          shutdown_final: false,
        },
      },
    ),
    collectorId: identityLikeCollectorId,
    sourceId: identityLikeSource.source.sourceId,
    token: identityLikeSource.token,
  });
  const identityLikeDirect = await request('/collectors/heartbeat', 'POST', {
    collectorId: identityLikeCollectorId,
    sourceId: identityLikeSource.source.sourceId,
    token: identityLikeSource.token,
    mode: 'observer-forwarder:shadow',
    status: 'ok',
  });
  assert(
    'identity-like collector text is canonicalized without credential redaction drift',
    identityLikeSource.source.collectorId === identityLikeCollectorId &&
      identityLikeRaw.accepted === true &&
      identityLikeRaw.collectorId === identityLikeCollectorId &&
      identityLikeDirect.accepted === true &&
      identityLikeDirect.collectorId === identityLikeCollectorId,
    { identityLikeSource, identityLikeRaw, identityLikeDirect },
  );

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
      otherHealth.items?.[0]?.execEvidence?.reported === false &&
      otherHealth.items?.[0]?.execEvidence?.latest === undefined &&
      otherHealth.items?.[0]?.execEvidence?.window?.heartbeatCount === 0 &&
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
      shutdownFinal: false,
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
      health.items?.[0]?.state === 'healthy' &&
      health.items?.[0]?.droppedEvents === 0 &&
      health.items?.[0]?.outputDropped === 0 &&
      health.items?.[0]?.errorCount === 0 &&
      health.items?.[0]?.filterMetrics?.scope === 'shadow' &&
      health.items?.[0]?.filterMetrics?.observed === 0 &&
      health.items?.[0]?.filterMetrics?.wouldFilterNonAgent === 0 &&
      health.items?.[0]?.windowErrorMaxima?.droppedEvents === 2 &&
      health.items?.[0]?.windowErrorMaxima?.outputDropped === 1 &&
      health.items?.[0]?.windowErrorMaxima?.errorCount === 1 &&
      !health.items?.[0]?.filterMetrics?.e2eFilterReceipts?.length,
    health,
  );
  assert(
    'a subsequent explicit non-final heartbeat clears the shutdown-final marker',
    health.items?.[0]?.filterMetrics?.shutdownFinal === false,
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
  await verifyHotRingCapacityContract();
  await verifyCollectorHeartbeatProvenanceContract();
  await verifyJudgeDispositionContract();
  await verifyRouteScopedBodyLimits();
  await request('/stats');
  await verifyIdentitySnapshotContract();
  const { source, token } = await createProtectedObserverSource();
  await verifyRejectedObserverToken(source.sourceId);
  await verifyObserverDiscardDisposition();
  await verifyObserverToolEvent(source.sourceId, token);
  await verifyIncompleteObserverEvidence(source.sourceId, token);
  await verifyObserverBatch(source.sourceId, token);
  await verifyInternalL3RecursionSuppressed(source.sourceId, token);
  await verifyObserverLlmEndpoint(source.sourceId, token);
  await verifyRawCollectorHeartbeat(source.sourceId, token);
  await verifyDirectForwarderHeartbeat(source.sourceId, token);
  await verifyCollectorSourceIsolation(source.sourceId);
  await verifyRawHeartbeatPreservesForwarderMetrics(source.sourceId, token);
  await verifyShutdownFinalHeartbeatIsPreserved(source.sourceId, token);
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
