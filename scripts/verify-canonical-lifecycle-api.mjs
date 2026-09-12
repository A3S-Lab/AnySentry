#!/usr/bin/env node

/**
 * Authenticated, synthetic lifecycle verification against a running AnySentry API.
 *
 * The fixture covers two negative identity paths (legacy runtime fallback and an unregistered
 * producer claim) plus a registered definition that crosses a process restart, resumes the same
 * provider Session, and forks a distinct child Session.  The script prints metadata/counts only;
 * it never prints request/response bodies or tool arguments.
 *
 * Usage:
 *   ANYSENTRY_ADMIN_TOKEN=... node scripts/verify-canonical-lifecycle-api.mjs
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const base = (process.env.ANYSENTRY_API_BASE
  ?? 'http://127.0.0.1:32653/security-center').replace(/\/$/u, '');
const adminToken = (process.env.ANYSENTRY_ADMIN_TOKEN
  ?? process.env.ANYSENTRY_MANAGEMENT_TOKEN
  ?? '').trim();
if (!adminToken) throw new Error('ANYSENTRY_ADMIN_TOKEN or ANYSENTRY_MANAGEMENT_TOKEN is required');

const digest = (value) => createHash('sha256').update(value).digest('hex');
const ns = (millis) => String(BigInt(millis) * 1_000_000n);
const runId = `lifecycle-api-${Date.now()}-${process.pid}`;
const collectorId = `${runId}-collector`;
const workspacePath = `repo://${runId}/codex`;
const logicalAgentId = `${runId}-logical`;
const logicalDefinitionId = `${runId}-definition`;
const tenantId = `${runId}-tenant`;
const ownerId = `${runId}-owner`;

let source;

async function request(path, method = 'GET', body, token = adminToken, sourceAuth = false) {
  const headers = { 'content-type': 'application/json' };
  if (sourceAuth) {
    headers['x-anysentry-source-id'] = source?.source?.sourceId ?? '';
    headers['x-anysentry-ingest-token'] = token;
  } else if (token) {
    headers['x-anysentry-admin-token'] = token;
  }
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : undefined; } catch { payload = undefined; }
  return { response, payload: payload?.data ?? payload };
}

function content(value) {
  const body = JSON.stringify(value);
  return {
    body,
    encoding: 'utf8',
    contentType: 'application/json',
    capturedBytes: Buffer.byteLength(body),
    decodedBytes: Buffer.byteLength(body),
    sha256: digest(body),
    completeness: 'complete',
    structured: value,
  };
}

function processInfo(startTimeTicks, pid = 48_001) {
  return {
    hostId: `${runId}-host`,
    bootId: `${runId}-boot`,
    pid,
    ppid: 1,
    startTimeTicks: String(startTimeTicks),
    comm: 'codex',
    exe: '/opt/codex',
  };
}

function envelope({
  id,
  at,
  process,
  agent = 'codex',
  logical,
  definition,
  scopeMode = 'registered_definition',
  providerSessionId,
  sessionId,
  sessionIdSource,
  sessionMode,
  serviceStateful,
  resume = false,
  fork = false,
  parentSessionId,
  toolLoop = false,
  profile,
  profileVersion,
}) {
  const requestBody = {
    model: 'lifecycle-fixture-model',
    messages: [{ role: 'user', content: 'synthetic lifecycle check' }],
  };
  const responseBody = {
    id: `${id}-response`,
    choices: [{ message: { role: 'assistant', content: 'synthetic lifecycle result' } }],
  };
  const toolCallId = `${id}-tool`;
  const interaction = {
    schemaVersion: 'anysentry.agent_interaction.v1',
    interactionId: id,
    interactionType: 'model',
    pid: process.pid,
    connectionId: `${id}-connection`,
    transport: 'tls',
    protocol: 'http/1.1',
    tlsAdapterId: 'lifecycle-fixture',
    transportProtocol: 'http/1.1',
    wireTemplateId: 'openai-compatible',
    parseState: 'parsed',
    llmLikelihood: 'confirmed',
    transportCompleteness: 'complete',
    wireCompleteness: 'complete',
    conversationCompleteness: 'complete',
    endpoint: 'lifecycle-fixture.invalid',
    method: 'POST',
    path: '/v1/chat/completions',
    statusCode: 200,
    model: 'lifecycle-fixture-model',
    ...(providerSessionId ? { providerConversationId: providerSessionId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(sessionIdSource ? { sessionIdSource } : {}),
    ...(sessionMode ? { sessionMode } : {}),
    ...(serviceStateful !== undefined ? { serviceStateful } : {}),
    ...(resume ? { resume: true } : {}),
    ...(fork ? { fork: true } : {}),
    ...(parentSessionId ? { parentSessionId } : {}),
    ...(logical ? { logicalAgentId: logical } : {}),
    ...(definition ? { logicalDefinitionId: definition } : {}),
    logicalScopeMode: scopeMode,
    tenantId,
    ownerId,
    ...(profile ? { profile } : {}),
    ...(profileVersion ? { profileVersion } : {}),
    terminalContextId: `${runId}-terminal`,
    runId: `${runId}-run`,
    turnId: id,
    startedAtUnixNs: ns(at),
    requestCompleteAtUnixNs: ns(at + 1),
    firstResponseAtUnixNs: ns(at + 2),
    endedAtUnixNs: ns(at + 3),
    durationNs: '3000000',
    timeQuality: 'collector_calibrated',
    request: content(requestBody),
    response: content(responseBody),
    usage: { source: 'provider_reported', completeness: 'complete', inputTokens: 4, outputTokens: 2, totalTokens: 6, totalTokensDerived: false },
    toolCalls: toolLoop ? [{ toolCallId, name: 'shell', arguments: { command: 'printf lifecycle' }, issuedAtUnixNs: ns(at + 2) }] : [],
    toolResults: toolLoop ? [{ toolCallId, name: 'shell', content: { stdout: 'synthetic' }, isError: false, observedAtUnixNs: ns(at + 3) }] : [],
    semanticParserId: 'canonical-lifecycle-api',
    semanticParserVersion: 1,
    completeness: 'complete',
    partialReasons: [],
    captureSource: 'fixture_lifecycle_api',
  };
  return {
    line: JSON.stringify({
      eventAtUnixNs: ns(at),
      receivedAtUnixNs: ns(at + 1),
      identity: { agent, task: `${runId}-${id}` },
      process,
      event: { LlmInteraction: interaction },
    }),
    process,
  };
}

function sourceEvent(id, line, process, workspace = workspacePath) {
  return {
    line,
    sourceId: source.source.sourceId,
    token: source.token,
    collectorId,
    sourceType: 'observer',
    sourceEventId: `${runId}-${id}`,
    workspacePath: workspace,
    classificationSemantics: {
      schemaVersion: 'anysentry.classification_semantics.v1',
      identityClassification: 'confirmed_agent',
      workloadRole: 'agent',
      captureProfile: 'agent_full',
    },
    attribution: {
      monitored: true,
      classification: 'confirmed_agent',
      confidence: 1,
      reason: 'authoritative_anchor',
      source: 'self_register',
      agentScopeId: 'codex',
      agentDisplayName: 'Codex',
      agentInstanceId: `${runId}-${id}-runtime`,
      rootPid: process.pid,
      rootStartTime: process.startTimeTicks,
      evidence: ['canonical-lifecycle-api'],
    },
  };
}

function customWindow(start) {
  return {
    timeType: 'custom',
    startTime: new Date(start - 15_000).toISOString(),
    endTime: new Date(Date.now() + 120_000).toISOString(),
    scope: 'raw',
    limit: 500,
  };
}

async function eventually(label, fn, predicate, attempts = 30) {
  let latest;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    latest = await fn();
    if (predicate(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${label} did not become readable in the bounded wait`);
}

async function cleanup() {
  if (!source?.source?.sourceId) return;
  await request(`/sources/${encodeURIComponent(source.source.sourceId)}`, 'PUT', { enabled: false }).catch(() => undefined);
  await request('/agents/codex/metadata', 'PUT', {
    workspacePath,
    logicalAgentId: '',
    logicalDefinitionId: '',
    logicalScopeMode: 'unresolved',
    ingestionSourceId: '',
    registrationRef: '',
  }).catch(() => undefined);
}

const startedAt = Date.now();
try {
  const sourceResult = await request('/sources', 'POST', {
    name: `${runId} source`,
    type: 'observer',
    enabled: true,
    requireToken: true,
    collectorId,
    owner: 'canonical-lifecycle-api',
  });
  assert.equal(sourceResult.response.status, 201, `source create -> ${sourceResult.response.status}`);
  source = sourceResult.payload;
  assert(source?.source?.sourceId && source?.token, 'source token was not issued');

  const metadata = await request('/agents/codex/metadata', 'PUT', {
    workspacePath,
    logicalAgentId,
    logicalDefinitionId,
    logicalDefinitionType: 'registered',
    logicalScopeMode: 'registered_definition',
    tenantId,
    ownerId,
    ingestionSourceId: source.source.sourceId,
  });
  assert.equal(metadata.response.status, 200, `metadata -> ${metadata.response.status}`);

  const legacy = envelope({
    id: `mi_${digest(`${runId}-legacy`).slice(0, 24)}`,
    at: startedAt,
    process: processInfo(10_000),
    agent: 'runtime-only-lifecycle',
    logical: undefined,
    definition: undefined,
    scopeMode: 'unresolved',
    sessionId: `container-${runId}`,
    sessionIdSource: 'legacy_agent_fallback',
    sessionMode: 'resumable',
    serviceStateful: false,
  });
  const unregistered = envelope({
    id: `mi_${digest(`${runId}-unregistered`).slice(0, 24)}`,
    at: startedAt + 4,
    process: processInfo(10_001, 48_002),
    agent: 'unregistered-lifecycle',
    logical: `${runId}-forged-logical`,
    definition: `${runId}-forged-definition`,
    scopeMode: 'registered_definition',
    sessionId: `runtime-${runId}`,
    sessionIdSource: 'legacy_agent_fallback',
    sessionMode: 'resumable',
    serviceStateful: false,
  });
  const first = envelope({
    id: `mi_${digest(`${runId}-first`).slice(0, 24)}`,
    at: startedAt + 8,
    process: processInfo(20_000),
    logical: logicalAgentId,
    definition: logicalDefinitionId,
    providerSessionId: `${runId}-provider-session`,
    sessionId: `${runId}-provider-session`,
    sessionIdSource: 'provider',
    sessionMode: 'resumable',
    serviceStateful: true,
    toolLoop: true,
  });
  const resumed = envelope({
    id: `mi_${digest(`${runId}-resume`).slice(0, 24)}`,
    at: startedAt + 12,
    process: processInfo(20_001),
    logical: logicalAgentId,
    definition: logicalDefinitionId,
    providerSessionId: `${runId}-provider-session`,
    sessionId: `${runId}-provider-session`,
    sessionIdSource: 'provider',
    sessionMode: 'resumable',
    serviceStateful: true,
    resume: true,
  });
  const forked = envelope({
    id: `mi_${digest(`${runId}-fork`).slice(0, 24)}`,
    at: startedAt + 16,
    process: processInfo(20_002),
    logical: logicalAgentId,
    definition: logicalDefinitionId,
    providerSessionId: `${runId}-fork-session`,
    sessionId: `${runId}-fork-session`,
    sessionIdSource: 'provider',
    sessionMode: 'resumable',
    serviceStateful: true,
    fork: true,
    parentSessionId: `${runId}-provider-session`,
  });

  const events = [
    sourceEvent('legacy', legacy.line, legacy.process, `repo://${runId}/legacy`),
    sourceEvent('unregistered', unregistered.line, unregistered.process, `repo://${runId}/unregistered`),
    sourceEvent('first', first.line, first.process),
    sourceEvent('resume', resumed.line, resumed.process),
    sourceEvent('fork', forked.line, forked.process),
  ];
  const ingest = await request('/ingest/batch', 'POST', { batchId: runId, events });
  assert.equal(ingest.response.status, 201, `ingest -> ${ingest.response.status}`);
  assert.equal(ingest.payload?.acceptedEvents, events.length,
    `accepted=${ingest.payload?.acceptedEvents ?? 'unknown'}`);

  const interactions = await eventually(
    'lifecycle interactions',
    () => request('/agents/interactions', 'POST', customWindow(startedAt)),
    (result) => result.response.status === 200
      && (result.payload?.items ?? []).filter((item) => events.some((event) =>
        item.interactionId === JSON.parse(event.line).event.LlmInteraction.interactionId)).length >= events.length,
  );
  const items = interactions.payload.items ?? [];
  const interactionId = (fixture) => JSON.parse(fixture.line).event.LlmInteraction.interactionId;
  const observed = (fixture) => items.find((item) => item.interactionId === interactionId(fixture));
  const legacyObserved = observed(legacy);
  const unregisteredObserved = observed(unregistered);
  const firstObserved = observed(first);
  const resumedObserved = observed(resumed);
  const forkedObserved = observed(forked);
  assert(legacyObserved && unregisteredObserved && firstObserved && resumedObserved && forkedObserved,
    'all lifecycle interactions must be queryable');

  assert.equal(legacyObserved.sessionIdentityQuality, 'ephemeral');
  assert.equal(legacyObserved.sessionIdSource, 'per_request');
  assert.equal(legacyObserved.sessionMode, 'per_request');
  assert.equal(legacyObserved.providerConversationId, undefined);

  assert.equal(unregisteredObserved.logicalAgentId, undefined);
  assert(unregisteredObserved.logicalAgentCandidateId, 'unregistered producer must retain candidate identity');
  assert.equal(unregisteredObserved.logicalScopeMode, 'unresolved');

  assert(firstObserved.canonicalAgentInstanceId && resumedObserved.canonicalAgentInstanceId,
    'registered interactions must expose canonical AgentInstance IDs');
  assert.notEqual(firstObserved.agentInstanceId, resumedObserved.agentInstanceId,
    'a changed process start marker must create a new runtime AgentInstance');
  assert.notEqual(firstObserved.canonicalAgentInstanceId, resumedObserved.canonicalAgentInstanceId,
    'a changed process generation must create a new canonical AgentInstance');
  assert.equal(firstObserved.canonicalSessionId, resumedObserved.canonicalSessionId,
    'resume must continue the prior canonical Session');
  assert.equal(resumedObserved.sessionLifecycle, 'resume');
  assert.notEqual(forkedObserved.canonicalSessionId, firstObserved.canonicalSessionId,
    'fork must create a distinct canonical Session');
  assert.equal(forkedObserved.sessionLifecycle, 'fork');
  assert.equal(forkedObserved.parentSessionId, `${runId}-provider-session`);
  assert(forkedObserved.canonicalParentSessionId, 'fork must retain a canonical parent edge');

  // The canonical AgentInstance directory is fed by the Observer runtime snapshot lane.  Post
  // the three process generations through the same lease/snapshot contract before asserting the
  // entity read model; interaction records alone intentionally do not mint runtime rows.
  const forwarderInstanceId = `${runId}-forwarder`;
  const lease = await request('/runtime/lease', 'POST', {
    collectorId,
    forwarderInstanceId,
    hostId: first.process.hostId,
    bootId: first.process.bootId,
    forwarderPid: 49_001,
    forwarderStartTimeTicks: '4900100',
  }, source.token, true);
  assert.equal(lease.response.status, 200, `runtime lease -> ${lease.response.status}`);
  assert.equal(lease.payload?.accepted, true, lease.payload?.reason ?? 'runtime lease rejected');
  const runtimeEntry = (fixture, generation) => {
    const process = fixture.process;
    return {
      agentScopeId: 'codex',
      agentDisplayName: 'Codex',
      agentInstanceId: `${runId}-reported-${generation}`,
      logicalAgentId,
      logicalDefinitionId,
      logicalScopeMode: 'registered_definition',
      logicalIdentityAuthority: 'management_registration',
      tenantId,
      ownerId,
      physicalWorkloadId: `host:${process.hostId}:${process.bootId}:${process.pid}`,
      classification: 'probable_agent',
      runtimeState: 'running',
      rootPid: process.pid,
      rootStartTimeTicks: process.startTimeTicks,
      rootGeneration: generation,
      hostId: process.hostId,
      bootId: process.bootId,
      comm: process.comm,
      exe: process.exe,
      workspacePath,
      discoveredAt: new Date(startedAt + generation).toISOString(),
      lastSeenAt: new Date(startedAt + generation).toISOString(),
      lastActivityAt: new Date(startedAt + generation).toISOString(),
      confidence: 0.9,
      source: 'process_signature',
      evidence: [`fixture:${runId}`],
      workloadRef: { environment: 'host', kind: 'process', processName: 'codex', executable: process.exe },
    };
  };
  const snapshot = await request('/runtime/snapshot', 'POST', {
    schemaVersion: 'anysentry.agent_runtime_snapshot.v1',
    collectorId,
    forwarderInstanceId,
    leaseEpoch: lease.payload.leaseEpoch,
    snapshotVersion: 1,
    generatedAt: new Date(startedAt + 20).toISOString(),
    ready: true,
    intervalSecs: 1,
    filterMode: 'enforce',
    entries: [
      runtimeEntry(first, 1),
      runtimeEntry(resumed, 2),
      runtimeEntry(forked, 3),
    ],
  }, source.token, true);
  assert.equal(snapshot.response.status, 200, `runtime snapshot -> ${snapshot.response.status}`);
  assert.equal(snapshot.payload?.accepted, true, snapshot.payload?.reason ?? 'runtime snapshot rejected');
  assert.equal(snapshot.payload?.applied, true, snapshot.payload?.reason ?? 'runtime snapshot not applied');

  const runtimeIds = [firstObserved.agentInstanceId, resumedObserved.agentInstanceId, forkedObserved.agentInstanceId];
  const lifecycleInteractionIds = [interactionId(first), interactionId(resumed), interactionId(forked)];
  const [instanceResults, sessionsResult, ...membershipResults] = await Promise.all([
    Promise.all(runtimeIds.map((id) => request(
      `/v1/agent-instances/${encodeURIComponent(id)}?includeCoverage=true`,
    ))),
    Promise.all([
      request(`/v1/sessions/${encodeURIComponent(firstObserved.canonicalSessionId)}?includeCoverage=true`),
      request(`/v1/sessions/${encodeURIComponent(forkedObserved.canonicalSessionId)}?includeCoverage=true`),
    ]),
    ...lifecycleInteractionIds.map((id) => request(
      `/v1/session-memberships?limit=4&includeCoverage=true&interactionId=${encodeURIComponent(id)}`,
    )),
  ]);
  assert(instanceResults.every((result) => result.response.status === 200));
  assert(sessionsResult.every((result) => result.response.status === 200));
  assert(membershipResults.every((result) => result.response.status === 200));
  assert(instanceResults.every((result, index) =>
    result.payload?.item?.runtimeInstanceIds?.includes(runtimeIds[index])));
  assert(sessionsResult.every((result, index) =>
    result.payload?.item?.sessionId === [firstObserved.canonicalSessionId, forkedObserved.canonicalSessionId][index]));
  const lifecycleMemberships = membershipResults.flatMap((result) => result.payload?.items ?? []);
  const lifecycleIds = new Set(lifecycleInteractionIds);

  const [exactSessionResult, exactForkResult] = sessionsResult;
  const sessionProjection = {
    status: exactSessionResult.payload?.coverage?.status ?? 'unknown',
    dataSource: exactSessionResult.payload?.dataSource ?? 'unknown',
    reasons: exactSessionResult.payload?.coverage?.reasons ?? [],
  };
  const membershipPointResults = await Promise.all(lifecycleMemberships.map((membership) =>
    request(`/v1/session-memberships/${encodeURIComponent(membership.membershipId)}?resolutionRevision=${encodeURIComponent(String(membership.resolutionRevision))}`)));
  const membershipPointComplete = lifecycleMemberships.length === lifecycleIds.size
    && membershipPointResults.every((result) => result.response.status === 200
      && result.payload?.dataSource === 'canonical_session_membership_store'
      && result.payload?.coverage?.status === 'complete');
  const membershipPersistence = membershipPointComplete
    ? {
        status: 'complete',
        dataSource: 'canonical_session_membership_store',
        reasons: [],
        pointReadCount: membershipPointResults.length,
      }
    : {
        status: membershipResults.every((result) => result.payload?.coverage?.status === 'complete') ? 'complete' : 'partial',
        dataSource: membershipResults[0]?.payload?.dataSource ?? 'unknown',
        reasons: [
          ...membershipResults.flatMap((result) => result.payload?.coverage?.reasons ?? []),
          ...(lifecycleMemberships.length !== lifecycleIds.size ? ['lifecycle_membership_not_in_bounded_list'] : []),
          ...membershipPointResults.flatMap((result) => result.payload?.coverage?.reasons ?? []),
        ].filter((reason, index, reasons) => reasons.indexOf(reason) === index),
        pointReadCount: membershipPointResults.length,
      };
  const overallStatus = membershipPersistence.status === 'complete'
    && sessionProjection.status === 'complete' ? 'pass' : 'partial';

  await cleanup();
  console.log(JSON.stringify({
    schemaVersion: 'anysentry.canonical_lifecycle_api.v1',
    status: overallStatus,
    runId: digest(runId).slice(0, 16),
    acceptedEvents: events.length,
    lifecycleInteractions: 5,
    runtimeAgentInstances: 3,
    canonicalSessions: 2,
    persistedMemberships: lifecycleIds.size,
    persistence: { membership: membershipPersistence, sessionProjection },
    checks: ['legacy_fallback_ephemeral', 'unregistered_unresolved', 'restart_new_agent_instance', 'resume_same_session', 'fork_new_session'],
    note: 'synthetic authenticated API replay; no vendor or user payloads',
  }));
  if (overallStatus !== 'pass') process.exitCode = 1;
} catch (error) {
  await cleanup();
  throw error;
}
