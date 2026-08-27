#!/usr/bin/env node

import assert from 'node:assert/strict';
import { canonicalizeEvent } from '../apps/api/dist/security-monitoring/streaming-normalizer.js';
import { managementAuthHeaders, safeProbeId } from './probe-id.mjs';

const baseUrl = (
  process.env.ANYSENTRY_API_BASE ??
  process.env.API_BASE ??
  `http://127.0.0.1:${process.env.PORT ?? '29653'}/security-center`
).replace(/\/$/, '');
const expectedMode = process.env.ANYSENTRY_S2_EXPECT_MODE ?? process.env.ANYSENTRY_TRUSTED_CORRELATION_MODE;
const runId = safeProbeId(`s2-${expectedMode ?? 'unset'}`);
const schemaVersion = 'anysentry.trusted_correlation.v1';

assert.ok(
  expectedMode === 'off' || expectedMode === 'shadow',
  'ANYSENTRY_S2_EXPECT_MODE must be either "off" or "shadow"',
);

function pass(message) {
  console.log(`PASS ${message}`);
}

function check(message, condition, details) {
  try {
    assert.ok(condition, message);
    pass(message);
  } catch (error) {
    if (details !== undefined) console.error(JSON.stringify(details, null, 2));
    throw error;
  }
}

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
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : undefined;
  } catch {
    payload = text;
  }
  if (!response.ok) {
    throw new Error(`${method} ${path} -> ${response.status}: ${text}`);
  }
  return payload?.data ?? payload;
}

function sourceHeaders(sourceId, token) {
  return {
    'x-anysentry-source-id': sourceId,
    'x-anysentry-ingest-token': token,
  };
}

async function createSemanticSource(authority, suffix, type) {
  const tenantId = `${runId}-tenant`;
  const environmentId = `${runId}-environment`;
  const workspacePath = `/workspace/${runId}/${suffix}`;
  const source = await request('/sources', 'POST', {
    name: `${runId} ${suffix}`,
    type,
    enabled: true,
    requireToken: true,
    workspacePath,
    owner: 'verify-s2-trusted-correlation-api',
    tags: [runId, 'contract-test', 'trusted-correlation'],
    correlationClaims: {
      enabled: true,
      authority,
      bindings: {
        tenantIds: [tenantId],
        environmentIds: [environmentId],
        workspacePaths: [workspacePath],
      },
    },
  });
  check(`${authority} Source creation returns a managed token`, Boolean(source.source?.sourceId && source.token), source);
  return {
    source: source.source,
    token: source.token,
    tenantId,
    environmentId,
    workspacePath,
  };
}

async function createObserverSource() {
  const collectorId = `${runId}-attested-collector`;
  const workspacePath = `/workspace/${runId}/observer`;
  const source = await request('/sources', 'POST', {
    name: `${runId} attested observer`,
    type: 'observer',
    enabled: true,
    requireToken: true,
    collectorId,
    workspacePath,
    owner: 'verify-s2-trusted-correlation-api',
    tags: [runId, 'contract-test', 'trusted-correlation'],
    correlationClaims: {
      enabled: true,
      authority: 'observer_runtime',
      bindings: { collectorIds: [collectorId] },
    },
  });
  check('observer runtime Source creation returns a managed token', Boolean(source.source?.sourceId && source.token), source);
  return { source: source.source, token: source.token, collectorId, workspacePath };
}

function semanticEvent(source, overrides = {}) {
  const suffix = overrides.suffix ?? 'event';
  return {
    kind: 'tool',
    sourceEventId: `${runId}-${suffix}`,
    agentId: `${runId}-agent`,
    // A normal semantic producer may report a collector for operations/accounting. It must not
    // become an implicit trust binding when this Source policy did not configure collectorIds.
    collectorId: `${runId}-${suffix}-semantic-collector`,
    workspacePath: source.workspacePath,
    sessionId: `${runId}-${suffix}-legacy-session`,
    runId: `${runId}-${suffix}-legacy-run`,
    userId: 'uid:1000',
    traceId: `${runId}-${suffix}-legacy-trace`,
    spanId: `${runId}-${suffix}-legacy-span`,
    invocationId: `${runId}-${suffix}-invocation`,
    toolCallId: `${runId}-${suffix}-tool-call`,
    argv: ['/usr/bin/printf', `${runId}-${suffix}`],
    attributes: {
      tenantId: source.tenantId,
      environmentId: source.environmentId,
      marker: `${runId}-${suffix}`,
    },
    ...overrides,
    suffix: undefined,
  };
}

async function ingestSemantic(source, event, sourceType = source.source.type) {
  const result = await request('/ingest/events', 'POST', {
    sourceId: source.source.sourceId,
    token: source.token,
    sourceType,
    workspacePath: event.workspacePath,
    events: [event],
  });
  check(
    `semantic event ${event.sourceEventId} remains accepted`,
    result.accepted === true &&
      result.acceptedEvents === 1 &&
      result.rejectedEvents === 0 &&
      result.items?.[0]?.accepted === true &&
      Boolean(result.items?.[0]?.eventId),
    result,
  );
  return result.items[0];
}

async function eventList(filter, overrides = {}) {
  return request('/events/list', 'POST', {
    timeType: 'last_30d',
    limit: 100,
    ...filter,
    ...overrides,
  });
}

async function waitForEvent(eventId, predicate = () => true, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  do {
    latest = await eventList({ eventId });
    const event = latest.items?.find((item) => item.eventId === eventId);
    if (event && predicate(event)) return { list: latest, event };
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error(`event ${eventId} did not satisfy the expected contract: ${JSON.stringify(latest)}`);
}

function correlationOf(event) {
  return event.correlation ?? event.attribution?.correlation;
}

function assertLegacyIdentity(event, expected) {
  check(
    `${expected.label} keeps every legacy identity field unchanged`,
    event.traceId === expected.traceId &&
      event.sessionId === expected.sessionId &&
      event.runId === expected.runId &&
      event.spanId === expected.spanId,
    { event, expected },
  );
}

function rejectedClaimReceipt(event) {
  return correlationOf(event)?.claimReceipts?.find((receipt) => receipt.decision === 'rejected');
}

function applicationClaimReceipts(event) {
  return correlationOf(event)?.claimReceipts?.filter((receipt) => receipt.kind === 'application_trace') ?? [];
}

function assertProtocolAccepted(label, result, expectedEvents = 1) {
  check(
    `${label} remains accepted by the legacy ingest path`,
    result.accepted === true &&
      result.acceptedEvents === expectedEvents &&
      result.rejectedEvents === 0 &&
      result.items?.length === expectedEvents &&
      result.items.every((item) => item.accepted === true && Boolean(item.eventId)),
    result,
  );
}

function assertApplicationClaimRejected(label, event) {
  const correlation = correlationOf(event);
  const receipts = applicationClaimReceipts(event);
  check(
    `${label} cannot elevate the normalized value to a trusted application claim`,
    event.invocationId === undefined &&
      event.toolCallId === undefined &&
      correlation?.method !== 'application_trace' &&
      correlation?.authority !== 'authenticated_application' &&
      !correlation?.provenance?.includes('application_trace') &&
      receipts.some((receipt) => receipt.decision === 'rejected' && receipt.reason !== 'authorized') &&
      !receipts.some((receipt) => receipt.decision === 'accepted'),
    event,
  );
}

async function verifyOffMode() {
  const application = await createSemanticSource('application', 'off-application', 'otel');
  const input = semanticEvent(application, {
    suffix: 'off',
    traceId: `${runId}-off-fixed-trace`,
    sessionId: `${runId}-off-fixed-session`,
    runId: `${runId}-off-fixed-run`,
    spanId: `${runId}-off-fixed-span`,
  });
  const accepted = await ingestSemantic(application, input, 'otel');
  const { event } = await waitForEvent(accepted.eventId);

  assertLegacyIdentity(event, {
    label: 'mode=off event',
    traceId: input.traceId,
    sessionId: input.sessionId,
    runId: input.runId,
    spanId: input.spanId,
  });
  check(
    'mode=off emits no additive trusted-correlation fields',
    !Object.hasOwn(event, 'invocationId') &&
      !Object.hasOwn(event, 'toolCallId') &&
      !Object.hasOwn(event, 'correlation') &&
      !Object.hasOwn(event.attribution ?? {}, 'correlation'),
    event,
  );
  const stats = await request('/stats');
  check(
    'mode=off keeps the legacy stats response free of trustedCorrelation',
    !Object.hasOwn(stats, 'trustedCorrelation'),
    stats,
  );
}

async function verifyApplicationAndAdapter(application, adapter) {
  const sharedTraceId = `${runId}-shared-legacy-trace`;
  const applicationInput = semanticEvent(application, {
    suffix: 'application-primary',
    traceId: sharedTraceId,
    invocationId: `${runId}-application-invocation`,
    toolCallId: undefined,
  });
  const siblingInput = semanticEvent(application, {
    suffix: 'application-sibling',
    traceId: sharedTraceId,
    invocationId: `${runId}-application-sibling-invocation`,
    toolCallId: undefined,
  });
  const adapterInput = semanticEvent(adapter, {
    suffix: 'adapter',
    traceId: `${runId}-adapter-legacy-trace`,
    invocationId: `${runId}-adapter-invocation`,
    toolCallId: `${runId}-adapter-tool-call`,
  });

  const [applicationAccepted, siblingAccepted, adapterAccepted] = await Promise.all([
    ingestSemantic(application, applicationInput, 'otel'),
    ingestSemantic(application, siblingInput, 'otel'),
    ingestSemantic(adapter, adapterInput, 'custom'),
  ]);
  const [{ event: applicationEvent }, { event: siblingEvent }, { event: adapterEvent }] = await Promise.all([
    waitForEvent(applicationAccepted.eventId, (event) => Boolean(correlationOf(event))),
    waitForEvent(siblingAccepted.eventId, (event) => Boolean(correlationOf(event))),
    waitForEvent(adapterAccepted.eventId, (event) => Boolean(correlationOf(event))),
  ]);

  const applicationCorrelation = correlationOf(applicationEvent);
  check(
    'shadow mode dual-writes authenticated application Invocation without rewriting Trace',
    applicationEvent.invocationId === applicationInput.invocationId &&
      applicationEvent.collectorId === applicationInput.collectorId &&
      applicationEvent.toolCallId === undefined &&
      applicationCorrelation?.schemaVersion === schemaVersion &&
      applicationCorrelation?.method === 'application_trace' &&
      applicationCorrelation?.scope === 'invocation' &&
      applicationCorrelation?.authority === 'authenticated_application' &&
      applicationCorrelation?.traceOrigin === 'incoming' &&
      applicationCorrelation?.invocationId === applicationInput.invocationId &&
      applicationCorrelation?.claimReceipts?.some((receipt) => receipt.kind === 'application_trace' && receipt.decision === 'accepted'),
    applicationEvent,
  );
  assertLegacyIdentity(applicationEvent, {
    label: 'trusted application event',
    traceId: applicationInput.traceId,
    sessionId: applicationInput.sessionId,
    runId: applicationInput.runId,
    spanId: applicationInput.spanId,
  });

  const adapterCorrelation = correlationOf(adapterEvent);
  check(
    'shadow mode dual-writes authenticated adapter Invocation and ToolCall',
    adapterEvent.invocationId === adapterInput.invocationId &&
      adapterEvent.collectorId === adapterInput.collectorId &&
      adapterEvent.toolCallId === adapterInput.toolCallId &&
      adapterCorrelation?.schemaVersion === schemaVersion &&
      adapterCorrelation?.method === 'agent_adapter' &&
      adapterCorrelation?.scope === 'invocation' &&
      adapterCorrelation?.authority === 'authenticated_agent_adapter' &&
      adapterCorrelation?.traceOrigin === 'adapter' &&
      adapterCorrelation?.invocationId === adapterInput.invocationId &&
      adapterCorrelation?.toolCallId === adapterInput.toolCallId &&
      adapterCorrelation?.claimReceipts?.some((receipt) => receipt.kind === 'agent_adapter' && receipt.decision === 'accepted'),
    adapterEvent,
  );
  assertLegacyIdentity(adapterEvent, {
    label: 'trusted adapter event',
    traceId: adapterInput.traceId,
    sessionId: adapterInput.sessionId,
    runId: adapterInput.runId,
    spanId: adapterInput.spanId,
  });

  return { applicationInput, applicationEvent, siblingEvent };
}

async function verifyRejectedClaims(application, trustedInvocationId) {
  const tokenlessEvent = {
    kind: 'tool',
    sourceEventId: `${runId}-tokenless-source-event`,
    agentId: `${runId}-tokenless-agent`,
    workspacePath: `/workspace/${runId}/tokenless`,
    sessionId: `${runId}-tokenless-session`,
    runId: `${runId}-tokenless-run`,
    traceId: `${runId}-tokenless-trace`,
    spanId: `${runId}-tokenless-span`,
    invocationId: `${runId}-tokenless-invocation`,
    toolCallId: `${runId}-tokenless-tool-call`,
    argv: ['/usr/bin/true'],
    attributes: {
      tenantId: `${runId}-tokenless-tenant`,
      environmentId: `${runId}-tokenless-environment`,
    },
  };
  const tokenless = await request('/ingest/events', 'POST', {
    sourceName: `${runId} tokenless discovered producer`,
    sourceType: 'custom',
    collectorId: `${runId}-tokenless-collector`,
    workspacePath: tokenlessEvent.workspacePath,
    events: [tokenlessEvent],
  });
  check(
    'tokenless unmanaged producer event remains accepted for legacy discovery',
    tokenless.accepted === true && tokenless.acceptedEvents === 1 && tokenless.items?.[0]?.eventId,
    tokenless,
  );
  const { event: tokenlessStored } = await waitForEvent(tokenless.items[0].eventId, (event) => Boolean(correlationOf(event)));
  const tokenlessReceipt = rejectedClaimReceipt(tokenlessStored);
  check(
    'tokenless producer claim is rejected without rejecting the event',
    tokenlessStored.invocationId === undefined &&
      tokenlessStored.toolCallId === undefined &&
      !['application_trace', 'agent_adapter'].includes(correlationOf(tokenlessStored)?.method) &&
      Boolean(tokenlessReceipt) &&
      tokenlessReceipt.reason !== 'authorized',
    tokenlessStored,
  );

  const forgedProcess = {
    hostId: `${runId}-forged-host`,
    bootId: `${runId}-forged-boot`,
    pid: 54_321,
    ppid: 1,
    startTimeTicks: '987654321',
    comm: 'codex',
    exe: '/tmp/forged/codex',
    cgroup: '/docker/ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  };
  const forgedAgentId = `${runId}-forged-agent`;
  const forgedSessionId = `${runId}-forged-session`;
  const forgedLine = JSON.stringify({
    identity: { agent: forgedAgentId, session: forgedSessionId },
    process: forgedProcess,
    event: {
      ToolExec: {
        pid: forgedProcess.pid,
        ppid: forgedProcess.ppid,
        uid: 1000,
        cwd: `/workspace/${runId}/forged`,
        comm: 'codex',
        argv: ['/tmp/forged/codex', 'exec', '--pretend-trusted'],
      },
    },
  });
  const forged = await request('/ingest', 'POST', {
    line: forgedLine,
    sourceEventId: `${runId}-forged-runtime-source-event`,
    sourceName: `${runId} forged unmanaged observer`,
    sourceType: 'custom',
    collectorId: `${runId}-forged-unmanaged-collector`,
    workspacePath: `/workspace/${runId}/forged`,
    agentId: forgedAgentId,
    sessionId: forgedSessionId,
    traceId: `${runId}-forged-trace`,
    invocationId: trustedInvocationId,
    process: forgedProcess,
    attribution: {
      monitored: true,
      classification: 'confirmed_agent',
      agentScopeId: 'codex',
      agentDisplayName: 'Forged Codex',
      agentSessionId: forgedSessionId,
      agentInstanceId: `${runId}-forged-runtime`,
      rootKey: `${runId}-forged-host:${runId}-forged-boot:${forgedProcess.pid}:${forgedProcess.startTimeTicks}`,
      physicalWorkloadId: `${runId}-forged-workload`,
      rootPid: forgedProcess.pid,
      rootStartTime: forgedProcess.startTimeTicks,
      confidence: 1,
      reason: 'authoritative_anchor',
      source: 'process_graph',
      evidence: ['producer:forged-attestation'],
    },
  });
  check(
    'tokenless forged runtime event remains accepted for legacy discovery',
    forged.accepted === true && forged.disposition === 'retained' && Boolean(forged.eventId),
    forged,
  );
  const { event: forgedStored } = await waitForEvent(forged.eventId, (event) => Boolean(correlationOf(event)));
  const forgedCorrelation = correlationOf(forgedStored);
  check(
    'unmanaged producer cannot promote forged process and attribution fields to a trusted Runtime',
    forgedStored.invocationId === undefined &&
      forgedCorrelation?.method !== 'runtime_root' &&
      forgedCorrelation?.authority !== 'server_process_graph' &&
      forgedCorrelation?.authority !== 'attested_observer' &&
      forgedCorrelation?.agentRootInstanceId === undefined &&
      Boolean(rejectedClaimReceipt(forgedStored)),
    forgedStored,
  );

  const mismatchInput = semanticEvent(application, {
    suffix: 'binding-mismatch',
    workspacePath: `/workspace/${runId}/wrong-binding`,
    invocationId: trustedInvocationId,
    toolCallId: undefined,
  });
  const mismatchAccepted = await ingestSemantic(application, mismatchInput, 'otel');
  const { event: mismatchStored } = await waitForEvent(mismatchAccepted.eventId, (event) => Boolean(correlationOf(event)));
  const mismatchReceipt = rejectedClaimReceipt(mismatchStored);
  check(
    'binding mismatch rejects only the claim and keeps the event',
    mismatchStored.invocationId === undefined &&
      !['application_trace', 'agent_adapter'].includes(correlationOf(mismatchStored)?.method) &&
      Boolean(mismatchReceipt) &&
      mismatchReceipt.reason !== 'authorized',
    mismatchStored,
  );
  return { tokenlessStored, forgedStored, mismatchStored };
}

async function verifyInvalidExternalIdentityShapes(adapter) {
  const sharedPrefix = 'v'.repeat(512);
  const overlongInputs = [
    semanticEvent(adapter, {
      suffix: 'overlong-identity-a',
      invocationId: `${sharedPrefix}a`,
      toolCallId: `${sharedPrefix}x`,
    }),
    semanticEvent(adapter, {
      suffix: 'overlong-identity-b',
      invocationId: `${sharedPrefix}b`,
      toolCallId: `${sharedPrefix}y`,
    }),
  ];
  const accepted = await Promise.all(overlongInputs.map((input) => ingestSemantic(adapter, input, 'custom')));
  const stored = await Promise.all(accepted.map((item) => waitForEvent(
    item.eventId,
    (event) => Boolean(correlationOf(event)),
  )));
  for (const { event } of stored) {
    const receipt = rejectedClaimReceipt(event);
    check(
      'an overlong producer identity is retained for legacy discovery but rejected as a trusted claim',
      event.invocationId === undefined &&
        event.toolCallId === undefined &&
        correlationOf(event)?.authority !== 'authenticated_agent_adapter' &&
        receipt?.kind === 'agent_adapter' &&
        receipt?.decision === 'rejected' &&
        receipt?.reason === 'invalid_claim',
      event,
    );
  }
  check(
    'two identities differing only after character 512 never collapse into one trusted Invocation',
    stored[0].event.eventId !== stored[1].event.eventId &&
      stored.every(({ event }) => correlationOf(event)?.invocationId === undefined),
    stored.map(({ event }) => event),
  );

  const malformedInput = semanticEvent(adapter, {
    suffix: 'malformed-identity-shapes',
    invocationId: { forged: `${runId}-object-invocation` },
    toolCallId: [`${runId}-array-tool-call`],
  });
  const malformedAccepted = await ingestSemantic(adapter, malformedInput, 'custom');
  const { event: malformedStored } = await waitForEvent(
    malformedAccepted.eventId,
    (event) => Boolean(correlationOf(event)),
  );
  check(
    'non-string Invocation/ToolCall input does not return 500 and cannot become trusted identity',
    malformedStored.invocationId === undefined &&
      malformedStored.toolCallId === undefined &&
      correlationOf(malformedStored)?.authority !== 'authenticated_agent_adapter' &&
      rejectedClaimReceipt(malformedStored)?.reason === 'invalid_claim',
    malformedStored,
  );
}

function otlpAttr(key, value) {
  if (typeof value === 'number') return { key, value: { intValue: String(value) } };
  if (typeof value === 'boolean') return { key, value: { boolValue: value } };
  return { key, value: { stringValue: String(value) } };
}

function protocolResourceAttributes(application, sessionId, suffix) {
  return [
    otlpAttr('service.name', `${runId}-${suffix}-agent`),
    otlpAttr('anysentry.workspace', application.workspacePath),
    otlpAttr('service.instance.id', sessionId),
    otlpAttr('tenantId', application.tenantId),
    otlpAttr('environmentId', application.environmentId),
  ];
}

async function verifyOtlpRawClaimBoundary(application) {
  const sessionId = `${runId}-otlp-raw-claim-session`;
  const rawTraceIds = [
    `sk-${'a'.repeat(32)}-${runId}-otlp-trace-a`,
    `sk-${'b'.repeat(32)}-${runId}-otlp-trace-b`,
  ];
  const traceResult = await request('/ingest/otlp/v1/traces', 'POST', {
    sourceId: application.source.sourceId,
    token: application.token,
    sourceType: 'otel',
    workspacePath: application.workspacePath,
    resourceSpans: [{
      resource: { attributes: protocolResourceAttributes(application, sessionId, 'otlp-trace') },
      scopeSpans: [{
        spans: rawTraceIds.map((traceId, index) => ({
          name: `${runId} raw OTLP trace ${index}`,
          traceId,
          spanId: `${runId}-otlp-span-${index}`,
          attributes: [
            otlpAttr('anysentry.event.kind', 'tool'),
            otlpAttr('process.command_line', `/usr/bin/printf ${index}`),
            otlpAttr('protocol', 's2-otlp-raw-trace-claim'),
          ],
        })),
      }],
    }],
  });
  assertProtocolAccepted('OTLP redaction-colliding Trace inputs', traceResult, rawTraceIds.length);
  const traceEvents = await Promise.all(traceResult.items.map((item) => waitForEvent(
    item.eventId,
    (event) => Boolean(correlationOf(event)),
  )));
  for (const { event } of traceEvents) {
    check(
      'OTLP keeps the legacy redacted Trace and Session representation',
      event.traceId === 'sk-[redacted]' && event.sessionId === sessionId,
      event,
    );
    assertApplicationClaimRejected('raw OTLP Trace differing from its redacted legacy value', event);
  }
  check(
    'distinct raw OTLP Trace claims that redact identically remain distinct untrusted events',
    traceEvents[0].event.eventId !== traceEvents[1].event.eventId &&
      traceEvents.every(({ event }) => event.traceId === 'sk-[redacted]'),
    traceEvents.map(({ event }) => event),
  );

  const overlongInvocationId = `${'i'.repeat(512)}x`;
  const overlongToolCallId = `${'t'.repeat(512)}x`;
  const overlongResult = await request('/ingest/otlp/v1/traces', 'POST', {
    sourceId: application.source.sourceId,
    token: application.token,
    sourceType: 'otel',
    workspacePath: application.workspacePath,
    invocationId: overlongInvocationId,
    toolCallId: overlongToolCallId,
    resourceSpans: [{
      resource: {
        attributes: protocolResourceAttributes(application, `${runId}-otlp-overlong-session`, 'otlp-overlong'),
      },
      scopeSpans: [{
        spans: [{
          name: `${runId} overlong OTLP semantic claims`,
          spanId: `${runId}-otlp-overlong-span`,
          attributes: [
            otlpAttr('anysentry.event.kind', 'tool'),
            otlpAttr('process.command_line', '/usr/bin/true'),
            otlpAttr('protocol', 's2-otlp-overlong-claim'),
          ],
        }],
      }],
    }],
  });
  assertProtocolAccepted('OTLP overlong Invocation/ToolCall input', overlongResult);
  const { event: overlongEvent } = await waitForEvent(
    overlongResult.items[0].eventId,
    (event) => Boolean(correlationOf(event)),
  );
  assertApplicationClaimRejected('overlong raw OTLP Invocation/ToolCall', overlongEvent);

  const workspacePrefix = `/workspace/${'w'.repeat(489)}`;
  const workspaceRaw = `${workspacePrefix}different-after-the-legacy-limit`;
  const workspaceSourceResult = await request('/sources', 'POST', {
    name: `${runId} OTLP item workspace boundary`,
    type: 'otel',
    enabled: true,
    requireToken: true,
    workspacePath: workspacePrefix,
    owner: 'verify-s2-trusted-correlation-api',
    tags: [runId, 'contract-test', 'trusted-correlation'],
    correlationClaims: {
      enabled: true,
      authority: 'application',
      bindings: {
        tenantIds: [application.tenantId],
        environmentIds: [application.environmentId],
        workspacePaths: [workspacePrefix],
      },
    },
  });
  const itemWorkspaceResult = await request('/ingest/otlp/v1/traces', 'POST', {
    sourceId: workspaceSourceResult.source.sourceId,
    token: workspaceSourceResult.token,
    sourceType: 'otel',
    resourceSpans: [{
      resource: {
        attributes: [
          otlpAttr('tenantId', application.tenantId),
          otlpAttr('environmentId', application.environmentId),
        ],
      },
      scopeSpans: [{
        spans: [{
          name: `${runId} item workspace identity boundary`,
          traceId: `${runId}-item-workspace-trace`,
          spanId: `${runId}-item-workspace-span`,
          attributes: [
            otlpAttr('anysentry.agent.id', `${runId}-item-workspace-agent`),
            otlpAttr('anysentry.workspace', workspaceRaw),
            otlpAttr('anysentry.session.id', `${runId}-item-workspace-session`),
            otlpAttr('anysentry.invocation.id', `${runId}-item-workspace-invocation`),
            otlpAttr('anysentry.event.kind', 'tool'),
            otlpAttr('process.command_line', '/usr/bin/true'),
          ],
        }],
      }],
    }],
  });
  assertProtocolAccepted('OTLP item-level overlong Workspace identity', itemWorkspaceResult);
  const { event: itemWorkspaceEvent } = await waitForEvent(
    itemWorkspaceResult.items[0].eventId,
    (event) => Boolean(correlationOf(event)),
  );
  check(
    'raw OTLP item Workspace cannot become trusted after legacy truncation matches a Source binding',
    itemWorkspaceEvent.workspacePath === workspacePrefix &&
      itemWorkspaceEvent.invocationId === undefined &&
      correlationOf(itemWorkspaceEvent)?.authority !== 'authenticated_application' &&
      applicationClaimReceipts(itemWorkspaceEvent).some((receipt) => receipt.decision === 'rejected'),
    itemWorkspaceEvent,
  );
}

async function verifyGenericCwdRawClaimBoundary(application) {
  const workspacePrefix = `/workspace/${'g'.repeat(489)}`;
  const workspaceRaw = `${workspacePrefix}different-after-the-legacy-limit`;
  const sourceResult = await request('/sources', 'POST', {
    name: `${runId} generic cwd workspace boundary`,
    type: 'otel',
    enabled: true,
    requireToken: true,
    owner: 'verify-s2-trusted-correlation-api',
    tags: [runId, 'contract-test', 'trusted-correlation'],
    correlationClaims: {
      enabled: true,
      authority: 'application',
      bindings: {
        tenantIds: [application.tenantId],
        environmentIds: [application.environmentId],
        workspacePaths: [workspacePrefix],
      },
    },
  });
  const result = await request('/ingest/events', 'POST', {
    sourceId: sourceResult.source.sourceId,
    token: sourceResult.token,
    sourceType: 'otel',
    events: [{
      kind: 'tool',
      sourceEventId: `${runId}-generic-cwd-workspace-boundary`,
      agentId: `${runId}-generic-cwd-agent`,
      sessionId: `${runId}-generic-cwd-session`,
      traceId: `${runId}-generic-cwd-trace`,
      invocationId: `${runId}-generic-cwd-invocation`,
      argv: ['/usr/bin/true'],
      attributes: {
        tenantId: application.tenantId,
        environmentId: application.environmentId,
        ...Object.fromEntries(Array.from(
          { length: 121 },
          (_, index) => [`filler.${String(index).padStart(3, '0')}`, index],
        )),
        cwd: workspaceRaw,
      },
    }],
  });
  assertProtocolAccepted('generic event with an overlong cwd-derived Workspace identity', result);
  const { event } = await waitForEvent(
    result.items[0].eventId,
    (candidate) => Boolean(correlationOf(candidate)),
  );
  check(
    'late raw generic cwd cannot become trusted after legacy truncation matches a Source binding',
    event.workspacePath === workspacePrefix &&
      event.invocationId === undefined &&
      correlationOf(event)?.authority !== 'authenticated_application' &&
      applicationClaimReceipts(event).some((receipt) => receipt.reason === 'binding_mismatch'),
    event,
  );

  const collectorPrefix = `collector-${'c'.repeat(170)}`;
  const collectorRaw = `${collectorPrefix}different-after-the-legacy-limit`;
  const collectorSourceResult = await request('/sources', 'POST', {
    name: `${runId} generic late collector boundary`,
    type: 'otel',
    enabled: true,
    requireToken: true,
    workspacePath: workspacePrefix,
    owner: 'verify-s2-trusted-correlation-api',
    tags: [runId, 'contract-test', 'trusted-correlation'],
    correlationClaims: {
      enabled: true,
      authority: 'application',
      bindings: {
        tenantIds: [application.tenantId],
        environmentIds: [application.environmentId],
        workspacePaths: [workspacePrefix],
        collectorIds: [collectorPrefix],
      },
    },
  });
  const collectorResult = await request('/ingest/events', 'POST', {
    sourceId: collectorSourceResult.source.sourceId,
    token: collectorSourceResult.token,
    sourceType: 'otel',
    workspacePath: workspacePrefix,
    events: [{
      kind: 'tool',
      sourceEventId: `${runId}-generic-late-collector-boundary`,
      agentId: `${runId}-generic-late-collector-agent`,
      workspacePath: workspacePrefix,
      traceId: `${runId}-generic-late-collector-trace`,
      invocationId: `${runId}-generic-late-collector-invocation`,
      argv: ['/usr/bin/true'],
      attributes: {
        tenantId: application.tenantId,
        environmentId: application.environmentId,
        ...Object.fromEntries(Array.from(
          { length: 121 },
          (_, index) => [`filler.${String(index).padStart(3, '0')}`, index],
        )),
        collectorId: collectorRaw,
      },
    }],
  });
  assertProtocolAccepted('generic event with a late overlong Collector identity', collectorResult);
  const { event: collectorEvent } = await waitForEvent(
    collectorResult.items[0].eventId,
    (candidate) => Boolean(correlationOf(candidate)),
  );
  check(
    'late raw generic collector cannot become trusted when the legacy attribute budget omits its binding',
    collectorEvent.invocationId === undefined &&
      correlationOf(collectorEvent)?.authority !== 'authenticated_application' &&
      applicationClaimReceipts(collectorEvent).some((receipt) => receipt.decision === 'rejected') &&
      !applicationClaimReceipts(collectorEvent).some((receipt) => receipt.decision === 'accepted'),
    collectorEvent,
  );

  const mixedResult = await request('/ingest/events', 'POST', [
    {
      sourceId: collectorSourceResult.source.sourceId,
      token: collectorSourceResult.token,
      sourceType: 'otel',
      collectorId: collectorRaw,
      workspacePath: workspacePrefix,
      kind: 'tool',
      sourceEventId: `${runId}-mixed-default-source-event`,
      agentId: `${runId}-mixed-default-agent`,
      traceId: `${runId}-mixed-default-trace`,
      argv: ['/usr/bin/true'],
      attributes: {
        tenantId: application.tenantId,
        environmentId: application.environmentId,
      },
    },
    {
      specversion: '1.0',
      id: `${runId}-mixed-default-cloudevent`,
      type: 'com.anysentry.agent.tool',
      source: 'webhook://s2-mixed-default-verifier',
      subject: `${runId}-mixed-default-cloud-agent`,
      data: {
        kind: 'tool',
        agentId: `${runId}-mixed-default-cloud-agent`,
        workspacePath: workspacePrefix,
        traceId: `${runId}-mixed-default-cloud-trace`,
        invocationId: `${runId}-mixed-default-cloud-invocation`,
        argv: ['/usr/bin/true'],
        attributes: {
          tenantId: application.tenantId,
          environmentId: application.environmentId,
        },
      },
    },
  ]);
  assertProtocolAccepted('mixed generic/CloudEvent array with a raw batch Collector default', mixedResult, 2);
  const { event: mixedCloudEvent } = await waitForEvent(
    mixedResult.items[1].eventId,
    (candidate) => Boolean(correlationOf(candidate)),
  );
  check(
    'raw batch Collector default cannot authenticate a later CloudEvent after legacy truncation',
    mixedCloudEvent.invocationId === undefined &&
      correlationOf(mixedCloudEvent)?.authority !== 'authenticated_application' &&
      applicationClaimReceipts(mixedCloudEvent).some((receipt) => receipt.reason === 'binding_mismatch'),
    mixedCloudEvent,
  );
}

async function verifyNormalizedAttributeKeyRawBoundary(application) {
  const canonicalTenantId = 'sk-[redacted]';
  const rawTenantId = `sk-${'z'.repeat(32)}-${runId}`;
  const workspacePath = `/workspace/${runId}/normalized-attribute-key`;
  const sourceResult = await request('/sources', 'POST', {
    name: `${runId} normalized attribute key boundary`,
    type: 'otel',
    enabled: true,
    requireToken: true,
    workspacePath,
    owner: 'verify-s2-trusted-correlation-api',
    tags: [runId, 'contract-test', 'trusted-correlation'],
    correlationClaims: {
      enabled: true,
      authority: 'application',
      bindings: {
        tenantIds: [canonicalTenantId],
        environmentIds: [application.environmentId],
        workspacePaths: [workspacePath],
      },
    },
  });

  const genericResult = await request('/ingest/events', 'POST', {
    sourceId: sourceResult.source.sourceId,
    token: sourceResult.token,
    sourceType: 'otel',
    workspacePath,
    events: [{
      kind: 'tool',
      sourceEventId: `${runId}-normalized-generic-attribute-key`,
      agentId: `${runId}-normalized-key-agent`,
      workspacePath,
      traceId: `${runId}-normalized-key-generic-trace`,
      invocationId: `${runId}-normalized-key-generic-invocation`,
      argv: ['/usr/bin/true'],
      attributes: {
        'tenantId ': rawTenantId,
        environmentId: application.environmentId,
      },
    }],
  });
  assertProtocolAccepted('generic event with a normalized attribute key', genericResult);
  const { event: genericEvent } = await waitForEvent(
    genericResult.items[0].eventId,
    (candidate) => Boolean(correlationOf(candidate)),
  );
  check(
    'generic raw attribute value remains untrusted when its trimmed key and redacted value match a binding',
    genericEvent.tenantId !== rawTenantId &&
      genericEvent.invocationId === undefined &&
      applicationClaimReceipts(genericEvent).some((receipt) => receipt.decision === 'rejected'),
    genericEvent,
  );

  const otlpResult = await request('/ingest/otlp/v1/traces', 'POST', {
    sourceId: sourceResult.source.sourceId,
    token: sourceResult.token,
    sourceType: 'otel',
    workspacePath,
    resourceSpans: [{
      resource: {
        attributes: [
          otlpAttr('service.name', `${runId}-normalized-key-otlp-agent`),
          otlpAttr('anysentry.workspace', workspacePath),
          otlpAttr('tenantId ', rawTenantId),
          otlpAttr('environmentId', application.environmentId),
        ],
      },
      scopeSpans: [{
        spans: [{
          name: `${runId} normalized OTLP attribute key`,
          traceId: `${runId}-normalized-key-otlp-trace`,
          spanId: `${runId}-normalized-key-otlp-span`,
          attributes: [
            otlpAttr('anysentry.invocation.id', `${runId}-normalized-key-otlp-invocation`),
            otlpAttr('anysentry.event.kind', 'tool'),
            otlpAttr('process.command_line', '/usr/bin/true'),
          ],
        }],
      }],
    }],
  });
  assertProtocolAccepted('OTLP event with a normalized attribute key', otlpResult);
  const { event: otlpEvent } = await waitForEvent(
    otlpResult.items[0].eventId,
    (candidate) => Boolean(correlationOf(candidate)),
  );
  assertApplicationClaimRejected('raw OTLP value behind a normalized attribute key', otlpEvent);

  const lateSourceResult = await request('/sources', 'POST', {
    name: `${runId} late OTLP attribute boundary`,
    type: 'otel',
    enabled: true,
    requireToken: true,
    workspacePath,
    owner: 'verify-s2-trusted-correlation-api',
    tags: [runId, 'contract-test', 'trusted-correlation'],
    correlationClaims: {
      enabled: true,
      authority: 'application',
      bindings: {
        tenantIds: ['default'],
        environmentIds: ['local'],
        workspacePaths: [workspacePath],
      },
    },
  });
  const lateAttributes = [
    otlpAttr('service.name', `${runId}-late-attribute-agent`),
    otlpAttr('anysentry.workspace', workspacePath),
    ...Array.from({ length: 121 }, (_, index) => otlpAttr(`filler.${String(index).padStart(3, '0')}`, index)),
    otlpAttr('tenantId ', rawTenantId),
  ];
  const lateResult = await request('/ingest/otlp/v1/traces', 'POST', {
    sourceId: lateSourceResult.source.sourceId,
    token: lateSourceResult.token,
    sourceType: 'otel',
    workspacePath,
    resourceSpans: [{
      resource: { attributes: lateAttributes },
      scopeSpans: [{
        spans: [{
          name: `${runId} late normalized OTLP attribute key`,
          traceId: `${runId}-late-normalized-key-trace`,
          spanId: `${runId}-late-normalized-key-span`,
          attributes: [
            otlpAttr('anysentry.invocation.id', `${runId}-late-normalized-key-invocation`),
            otlpAttr('anysentry.event.kind', 'tool'),
            otlpAttr('process.command_line', '/usr/bin/true'),
          ],
        }],
      }],
    }],
  });
  assertProtocolAccepted('OTLP event with a claim after the generic attribute limit', lateResult);
  const { event: lateEvent } = await waitForEvent(
    lateResult.items[0].eventId,
    (candidate) => Boolean(correlationOf(candidate)),
  );
  assertApplicationClaimRejected('late raw OTLP claim behind a normalized attribute key', lateEvent);

  const typedSourceResult = await request('/sources', 'POST', {
    name: `${runId} typed OTLP identity boundary`,
    type: 'otel',
    enabled: true,
    requireToken: true,
    workspacePath,
    owner: 'verify-s2-trusted-correlation-api',
    tags: [runId, 'contract-test', 'trusted-correlation'],
    correlationClaims: {
      enabled: true,
      authority: 'application',
      bindings: {
        tenantIds: ['123'],
        environmentIds: [application.environmentId],
        workspacePaths: [workspacePath],
      },
    },
  });
  const typedResult = await request('/ingest/otlp/v1/traces', 'POST', {
    sourceId: typedSourceResult.source.sourceId,
    token: typedSourceResult.token,
    sourceType: 'otel',
    workspacePath,
    resourceSpans: [{
      resource: {
        attributes: [
          otlpAttr('service.name', `${runId}-typed-otlp-agent`),
          otlpAttr('anysentry.workspace', workspacePath),
          otlpAttr('tenantId', 123),
          otlpAttr('environmentId', application.environmentId),
        ],
      },
      scopeSpans: [{
        spans: [{
          name: `${runId} typed OTLP identity`,
          traceId: `${runId}-typed-otlp-trace`,
          spanId: `${runId}-typed-otlp-span`,
          attributes: [
            otlpAttr('anysentry.invocation.id', 456),
            otlpAttr('anysentry.event.kind', 'tool'),
            otlpAttr('process.command_line', '/usr/bin/true'),
          ],
        }],
      }],
    }],
  });
  assertProtocolAccepted('OTLP event with typed non-string identity values', typedResult);
  const { event: typedEvent } = await waitForEvent(
    typedResult.items[0].eventId,
    (candidate) => Boolean(correlationOf(candidate)),
  );
  assertApplicationClaimRejected('typed OTLP intValue Invocation/Tenant', typedEvent);
}

async function verifyStructuredCloudEventRawClaimBoundary(application) {
  const rawTraceId = `sk-${'c'.repeat(40)}-${runId}-cloudevent-trace`;
  const rawSessionId = `${'s'.repeat(512)}x`;
  const traceResult = await request('/ingest/events', 'POST', {
    specversion: '1.0',
    id: `${runId}-s2-raw-claim-cloudevent`,
    type: 'com.anysentry.agent.tool',
    source: 'webhook://s2-trusted-correlation-verifier',
    subject: `${runId}-cloudevent-agent`,
    sourceId: application.source.sourceId,
    token: application.token,
    sourceType: 'otel',
    workspacePath: application.workspacePath,
    data: {
      kind: 'tool',
      agentId: `${runId}-cloudevent-agent`,
      workspacePath: application.workspacePath,
      sessionId: rawSessionId,
      traceId: rawTraceId,
      argv: ['/usr/bin/printf', 'structured-cloudevent'],
      attributes: {
        tenantId: application.tenantId,
        environmentId: application.environmentId,
        protocol: 's2-structured-cloudevent-raw-trace-session',
      },
    },
  });
  assertProtocolAccepted('structured CloudEvent redaction/truncation inputs', traceResult);
  const { event: traceEvent } = await waitForEvent(
    traceResult.items[0].eventId,
    (event) => Boolean(correlationOf(event)),
  );
  check(
    'structured CloudEvent keeps the legacy redacted Trace and truncated Session representation',
    traceEvent.traceId === 'sk-[redacted]' &&
      traceEvent.sessionId === rawSessionId.slice(0, 240) &&
      traceEvent.sessionId.length === 240,
    traceEvent,
  );
  assertApplicationClaimRejected(
    'raw structured CloudEvent Trace/Session differing from their cleaned legacy values',
    traceEvent,
  );

  const overlongInvocationId = `${'j'.repeat(512)}x`;
  const overlongToolCallId = `${'k'.repeat(512)}x`;
  const overlongResult = await request('/ingest/events', 'POST', {
    specversion: '1.0',
    id: `${runId}-s2-overlong-claim-cloudevent`,
    type: 'com.anysentry.agent.tool',
    source: 'webhook://s2-trusted-correlation-verifier',
    subject: `${runId}-cloudevent-overlong-agent`,
    sourceId: application.source.sourceId,
    token: application.token,
    sourceType: 'otel',
    workspacePath: application.workspacePath,
    data: {
      kind: 'tool',
      agentId: `${runId}-cloudevent-overlong-agent`,
      workspacePath: application.workspacePath,
      sessionId: `${runId}-cloudevent-overlong-session`,
      invocationId: overlongInvocationId,
      toolCallId: overlongToolCallId,
      argv: ['/usr/bin/true'],
      attributes: {
        tenantId: application.tenantId,
        environmentId: application.environmentId,
        protocol: 's2-structured-cloudevent-overlong-invocation-tool',
      },
    },
  });
  assertProtocolAccepted('structured CloudEvent overlong Invocation/ToolCall input', overlongResult);
  const { event: overlongEvent } = await waitForEvent(
    overlongResult.items[0].eventId,
    (event) => Boolean(correlationOf(event)),
  );
  assertApplicationClaimRejected('overlong raw structured CloudEvent Invocation/ToolCall', overlongEvent);
}

function observerLine({ agentScopeId, sessionId, pid, startTimeTicks, rootPid, cgroup, cwd = `/workspace/${runId}/observer` }) {
  return JSON.stringify({
    identity: { agent: agentScopeId, session: sessionId },
    process: {
      hostId: `${runId}-host`,
      bootId: `${runId}-boot`,
      pid,
      ppid: rootPid === pid ? 1 : rootPid,
      startTimeTicks,
      cgroup,
      cgroupId: `${runId}-shared-cgroup-id`,
      comm: 'pi-agent',
      exe: '/usr/local/bin/pi-agent',
    },
    event: {
      ToolExec: {
        pid,
        ppid: rootPid === pid ? 1 : rootPid,
        uid: 1000,
        cwd,
        argv: ['/usr/bin/printf', agentScopeId, startTimeTicks],
      },
    },
  });
}

async function verifyObserverCwdRawClaimBoundary(application) {
  const workspacePrefix = `/workspace/${'o'.repeat(489)}`;
  const workspaceRaw = `${workspacePrefix}different-after-the-legacy-limit`;
  const collectorId = `${runId}-cwd-bound-observer`;
  const sourceResult = await request('/sources', 'POST', {
    name: `${runId} observer cwd workspace boundary`,
    type: 'observer',
    enabled: true,
    requireToken: true,
    collectorId,
    owner: 'verify-s2-trusted-correlation-api',
    tags: [runId, 'contract-test', 'trusted-correlation'],
    correlationClaims: {
      enabled: true,
      authority: 'observer_runtime',
      bindings: {
        collectorIds: [collectorId],
        workspacePaths: [workspacePrefix],
      },
    },
  });
  const pid = 63_003;
  const startTimeTicks = '400004';
  const agentScopeId = `${runId}-cwd-bound-agent`;
  const sessionId = `${runId}-cwd-bound-session`;
  const cgroup = '/docker/1123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const line = observerLine({
    agentScopeId,
    sessionId,
    pid,
    startTimeTicks,
    rootPid: pid,
    cgroup,
    cwd: workspaceRaw,
  });
  const result = await request('/ingest', 'POST', {
    line,
    sourceEventId: `${runId}-observer-cwd-workspace-boundary`,
    collectorId,
    nodeName: `${runId}-node`,
    sourceType: 'observer',
    sessionId,
    process: {
      hostId: `${runId}-host`,
      bootId: `${runId}-boot`,
      pid,
      ppid: 1,
      startTimeTicks,
      cgroup,
      cgroupId: `${runId}-cwd-bound-cgroup-id`,
      comm: 'pi-agent',
      exe: '/usr/local/bin/pi-agent',
    },
    attribution: {
      monitored: true,
      classification: 'confirmed_agent',
      agentScopeId,
      agentDisplayName: agentScopeId,
      agentSessionId: sessionId,
      agentInstanceId: `${agentScopeId}:${pid}:${startTimeTicks}`,
      rootKey: `${runId}-host:${runId}-boot:${pid}:${startTimeTicks}`,
      rootPid: pid,
      rootStartTime: startTimeTicks,
      confidence: 1,
      reason: 'authoritative_anchor',
      source: 'process_graph',
      evidence: ['observer:verified-runtime-root'],
    },
  }, sourceHeaders(sourceResult.source.sourceId, sourceResult.token));
  check(
    'Observer event with a mismatched raw cwd remains retained by the legacy ingest path',
    result.accepted === true && result.disposition === 'retained' && Boolean(result.eventId),
    result,
  );
  const { event } = await waitForEvent(result.eventId, (candidate) => Boolean(correlationOf(candidate)));
  const correlation = correlationOf(event);
  check(
    'raw Observer cwd cannot be promoted to an attested Runtime after canonical truncation',
    correlation?.authority !== 'attested_observer' &&
      correlation?.method !== 'runtime_root' &&
      correlation?.agentRootInstanceId === undefined,
    event,
  );
}

async function ingestRuntimeEvent(observer, spec) {
  const cgroup = '/docker/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const physicalWorkloadId = `${runId}-shared-container`;
  const line = observerLine({ ...spec, cgroup });
  const result = await request('/ingest', 'POST', {
    line,
    sourceEventId: `${runId}-${spec.suffix}`,
    collectorId: observer.collectorId,
    nodeName: `${runId}-node`,
    sourceType: 'observer',
    workspacePath: observer.workspacePath,
    sessionId: spec.sessionId,
    traceId: `${runId}-${spec.suffix}-legacy-trace`,
    runId: `${runId}-${spec.suffix}-legacy-run`,
    process: {
      hostId: `${runId}-host`,
      bootId: `${runId}-boot`,
      pid: spec.pid,
      ppid: spec.rootPid === spec.pid ? 1 : spec.rootPid,
      startTimeTicks: spec.startTimeTicks,
      cgroup,
      cgroupId: `${runId}-shared-cgroup-id`,
      comm: 'pi-agent',
      exe: '/usr/local/bin/pi-agent',
    },
    attribution: {
      monitored: true,
      classification: 'confirmed_agent',
      agentScopeId: spec.agentScopeId,
      agentDisplayName: spec.agentScopeId,
      agentSessionId: spec.sessionId,
      agentInstanceId: `${spec.agentScopeId}:${spec.pid}:${spec.startTimeTicks}`,
      rootKey: `${runId}-host:${runId}-boot:${spec.rootPid}:${spec.rootStartTime}`,
      physicalWorkloadId,
      workloadRef: {
        environment: 'docker',
        kind: 'container',
        name: 'shared-agent-container',
        containerName: 'shared-agent-container',
      },
      rootPid: spec.rootPid,
      rootStartTime: spec.rootStartTime,
      confidence: 1,
      reason: 'authoritative_anchor',
      source: 'process_graph',
      evidence: ['observer:verified-runtime-root'],
    },
  }, sourceHeaders(observer.source.sourceId, observer.token));
  check(
    `attested runtime event ${spec.suffix} is retained`,
    result.accepted === true && result.disposition === 'retained' && Boolean(result.eventId),
    result,
  );
  return waitForEvent(result.eventId, (event) => Boolean(correlationOf(event)));
}

async function verifyRuntimeSeparation(observer) {
  const [rootA, rootB, pidReuse] = await Promise.all([
    ingestRuntimeEvent(observer, {
      suffix: 'root-a',
      agentScopeId: `${runId}-agent-a`,
      sessionId: `${runId}-root-a-session`,
      pid: 61_001,
      rootPid: 61_001,
      startTimeTicks: '100001',
      rootStartTime: '100001',
    }),
    ingestRuntimeEvent(observer, {
      suffix: 'root-b',
      agentScopeId: `${runId}-agent-b`,
      sessionId: `${runId}-root-b-session`,
      pid: 62_002,
      rootPid: 62_002,
      startTimeTicks: '200002',
      rootStartTime: '200002',
    }),
    ingestRuntimeEvent(observer, {
      suffix: 'root-a-pid-reuse',
      agentScopeId: `${runId}-agent-a`,
      sessionId: `${runId}-root-a-reused-session`,
      pid: 61_001,
      rootPid: 61_001,
      startTimeTicks: '300003',
      rootStartTime: '300003',
    }),
  ]);
  const [a, b, reused] = [rootA.event, rootB.event, pidReuse.event];
  const [aCorrelation, bCorrelation, reusedCorrelation] = [a, b, reused].map(correlationOf);
  check(
    'two Agent roots in one physical container remain distinct Runtime identities',
    a.attribution?.physicalWorkloadId === b.attribution?.physicalWorkloadId &&
      aCorrelation?.method === 'runtime_root' &&
      bCorrelation?.method === 'runtime_root' &&
      aCorrelation?.authority === 'attested_observer' &&
      bCorrelation?.authority === 'attested_observer' &&
      Boolean(aCorrelation?.agentRootInstanceId) &&
      Boolean(bCorrelation?.agentRootInstanceId) &&
      aCorrelation.agentRootInstanceId !== bCorrelation.agentRootInstanceId,
    { a, b },
  );
  check(
    'PID reuse with a new process start cannot inherit the prior Process or Runtime identity',
    a.process?.pid === reused.process?.pid &&
      a.process?.startTimeTicks !== reused.process?.startTimeTicks &&
      Boolean(aCorrelation?.processInstanceId) &&
      Boolean(reusedCorrelation?.processInstanceId) &&
      aCorrelation.processInstanceId !== reusedCorrelation.processInstanceId &&
      aCorrelation.agentRootInstanceId !== reusedCorrelation.agentRootInstanceId,
    { a, reused },
  );
  const canonicalA = canonicalizeEvent(toJudgedEvent(a), '{}', Date.now());
  check(
    'trusted correlation references the existing Canonical ProcessInstance identity',
    aCorrelation?.processInstanceId === canonicalA.processIdentity.processInstanceId,
    { correlation: aCorrelation, processIdentity: canonicalA.processIdentity },
  );
}

async function verifyIndependentInvocationQuery(applicationInput, applicationEvent, siblingEvent, rejectedEvents) {
  const byInvocation = await eventList({ invocationId: applicationInput.invocationId });
  check(
    'invocationId is an independent exact query predicate',
    byInvocation.items?.length === 1 &&
      byInvocation.items[0].eventId === applicationEvent.eventId &&
      byInvocation.items[0].invocationId === applicationInput.invocationId &&
      byInvocation.items.every((event) => event.traceId === applicationInput.traceId),
    byInvocation,
  );
  check(
    'rejected producer claims cannot enter an invocationId result set',
    rejectedEvents.every((event) => !byInvocation.items?.some((item) => item.eventId === event.eventId)),
    { byInvocation, rejectedEvents },
  );

  const byLegacyTrace = await eventList({ traceId: applicationInput.traceId });
  check(
    'legacy traceId query semantics remain independent from Invocation grouping',
    byLegacyTrace.items?.some((event) => event.eventId === applicationEvent.eventId) &&
      byLegacyTrace.items?.some((event) => event.eventId === siblingEvent.eventId) &&
      byLegacyTrace.items?.every((event) => event.traceId === applicationInput.traceId),
    byLegacyTrace,
  );
}

function toJudgedEvent(event) {
  const at = Date.parse(`${String(event.at).replace(' ', 'T')}Z`);
  return { ...event, at: Number.isFinite(at) ? at : Date.now() };
}

function withoutTrustedCorrelation(event) {
  const baseline = structuredClone(event);
  delete baseline.invocationId;
  delete baseline.toolCallId;
  delete baseline.correlation;
  if (baseline.attribution) delete baseline.attribution.correlation;
  return baseline;
}

function verifyCanonicalCompatibility(applicationEvent) {
  const additiveEvent = toJudgedEvent(applicationEvent);
  const baselineEvent = withoutTrustedCorrelation(additiveEvent);
  const line = JSON.stringify({
    identity: { agent: additiveEvent.agentId, session: additiveEvent.sessionId },
    event: { ToolExec: { pid: 70_001, ppid: 1, uid: 1000, cwd: additiveEvent.workspacePath, argv: ['/usr/bin/true'] } },
  });
  const receivedAt = Date.now();
  const baseline = canonicalizeEvent(baselineEvent, line, receivedAt);
  const additive = canonicalizeEvent(additiveEvent, line, receivedAt);
  check(
    'canonical dual-write leaves agentCorrelationId, agentInstanceId, sessionId, traceId, spanId, and process identity unchanged',
    additive.agentCorrelationId === baseline.agentCorrelationId &&
      additive.agentInstanceId === baseline.agentInstanceId &&
      additive.sessionId === baseline.sessionId &&
      additive.traceId === baseline.traceId &&
      additive.spanId === baseline.spanId &&
      additive.processIdentity.processInstanceId === baseline.processIdentity.processInstanceId,
    { baseline, additive },
  );
  check(
    'canonical stream projects trusted Invocation additively',
    additive.invocationId === applicationEvent.invocationId &&
      additive.correlation?.schemaVersion === schemaVersion &&
      baseline.invocationId === undefined &&
      baseline.correlation === undefined,
    { baseline, additive },
  );
}

async function verifyShadowMetrics() {
  const stats = await request('/stats');
  const correlation = stats.trustedCorrelation;
  const rejectedClaims = correlation?.rejectedClaimsByReason;
  const rejectedTotal = rejectedClaims && typeof rejectedClaims === 'object'
    ? Object.values(rejectedClaims).reduce((sum, value) => sum + Number(value || 0), 0)
    : 0;
  check(
    'shadow stats expose bounded trusted-correlation coverage and classification dimensions',
    correlation?.mode === 'shadow' &&
      Number.isFinite(correlation.coverage) &&
      correlation.coverage > 0 &&
      correlation.coverage <= 1 &&
      correlation.byMethod &&
      typeof correlation.byMethod === 'object' &&
      !Array.isArray(correlation.byMethod) &&
      correlation.byAuthority &&
      typeof correlation.byAuthority === 'object' &&
      !Array.isArray(correlation.byAuthority) &&
      rejectedClaims &&
      typeof rejectedClaims === 'object' &&
      !Array.isArray(rejectedClaims),
    stats,
  );
  check(
    'shadow stats reflect both trusted semantic samples and rejected claims',
    correlation.trustedInvocation >= 3 &&
      correlation.byMethod.application_trace >= 2 &&
      correlation.byMethod.agent_adapter >= 1 &&
      correlation.byAuthority.authenticated_application >= 2 &&
      correlation.byAuthority.authenticated_agent_adapter >= 1 &&
      rejectedTotal >= 2,
    stats,
  );
}

async function verifyShadowMode() {
  const [application, adapter, observer] = await Promise.all([
    createSemanticSource('application', 'application', 'otel'),
    createSemanticSource('agent_adapter', 'adapter', 'custom'),
    createObserverSource(),
  ]);
  const { applicationInput, applicationEvent, siblingEvent } = await verifyApplicationAndAdapter(application, adapter);
  const rejected = await verifyRejectedClaims(application, applicationInput.invocationId);
  await verifyInvalidExternalIdentityShapes(adapter);
  await verifyOtlpRawClaimBoundary(application);
  await verifyGenericCwdRawClaimBoundary(application);
  await verifyNormalizedAttributeKeyRawBoundary(application);
  await verifyStructuredCloudEventRawClaimBoundary(application);
  await verifyObserverCwdRawClaimBoundary(application);
  await verifyRuntimeSeparation(observer);
  await verifyIndependentInvocationQuery(
    applicationInput,
    applicationEvent,
    siblingEvent,
    [rejected.tokenlessStored, rejected.forgedStored, rejected.mismatchStored],
  );
  verifyCanonicalCompatibility(applicationEvent);
  await verifyShadowMetrics();
}

if (expectedMode === 'off') await verifyOffMode();
else await verifyShadowMode();

console.log(`S2 trusted-correlation API contract verification passed (mode=${expectedMode})`);
