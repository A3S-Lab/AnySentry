#!/usr/bin/env node

/**
 * Local HTTP contract check for the additive Canonical entity GET resources.  All data is
 * synthetic and bounded; the script never contacts a vendor API and never writes a repository
 * credential.  Run through verify-deep-links-local.mjs so the API uses an isolated process.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const base = (process.env.ANYSENTRY_API_BASE
  ?? `http://127.0.0.1:${process.env.PORT ?? '29654'}/security-center`).replace(/\/$/u, '');
const adminToken = (process.env.ANYSENTRY_ADMIN_TOKEN
  ?? process.env.ANYSENTRY_MANAGEMENT_TOKEN
  ?? '').trim();
if (!adminToken) throw new Error('ANYSENTRY_ADMIN_TOKEN or ANYSENTRY_MANAGEMENT_TOKEN is required');

const runId = `canonical-entity-${Date.now()}-${process.pid}`;
const digest = (value) => createHash('sha256').update(value).digest('hex');
const unixNs = (ms) => String(BigInt(ms) * 1_000_000n);

async function request(path, method = 'GET', body, token = adminToken, options = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) {
    if (options.auth === 'source') {
      headers['x-anysentry-source-id'] = source?.source?.sourceId ?? '';
      headers['x-anysentry-ingest-token'] = token;
    } else {
      headers['x-anysentry-admin-token'] = token;
    }
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

const content = (value) => {
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
};

const at = Date.now();
const logicalAgentId = `${runId}-logical`;
const logicalDefinitionId = `${runId}-definition`;
const workspacePath = `repo://${runId}/codex`;
const collectorId = `${runId}-collector`;
const runtimeId = `${runId}-runtime`;
const processInfo = {
  hostId: `${runId}-host`,
  bootId: `${runId}-boot`,
  pid: 46_001,
  ppid: 1,
  startTimeTicks: '4600100',
  comm: 'codex',
  exe: '/opt/codex',
};
const requestBody = { model: 'entity-fixture-model', messages: [{ role: 'user', content: 'synthetic entity check' }] };
const responseBody = { id: `${runId}-response`, choices: [{ message: { role: 'assistant', content: 'synthetic final' } }] };
const interactionId = `mi_${digest(`${runId}-interaction`).slice(0, 24)}`;
const toolCallId = `${runId}-tool`;
const line = JSON.stringify({
  eventAtUnixNs: unixNs(at),
  receivedAtUnixNs: unixNs(at + 1),
  identity: { agent: 'codex', task: runId },
  process: processInfo,
  event: {
    LlmInteraction: {
      schemaVersion: 'anysentry.agent_interaction.v1',
      interactionId,
      interactionType: 'model',
      pid: processInfo.pid,
      connectionId: `${runId}-connection`,
      transport: 'http',
      protocol: 'http/1.1',
      endpoint: 'entity-fixture.invalid',
      method: 'POST',
      path: '/v1/chat/completions',
      statusCode: 200,
      model: 'entity-fixture-model',
      providerConversationId: `${runId}-provider-session`,
      sessionId: `${runId}-provider-session`,
      runId: `${runId}-run`,
      turnId: `${runId}-turn`,
      logicalAgentId,
      logicalDefinitionId,
      logicalScopeMode: 'registered_definition',
      tenantId: `${runId}-tenant`,
      ownerId: `${runId}-owner`,
      profile: 'default',
      terminalContextId: `${runId}-terminal`,
      sessionMode: 'resumable',
      sessionIdSource: 'provider',
      serviceStateful: true,
      startedAtUnixNs: unixNs(at),
      requestCompleteAtUnixNs: unixNs(at + 1),
      firstResponseAtUnixNs: unixNs(at + 2),
      endedAtUnixNs: unixNs(at + 3),
      durationNs: '3000000',
      timeQuality: 'collector_calibrated',
      request: content(requestBody),
      response: content(responseBody),
      usage: { source: 'provider_reported', completeness: 'complete', inputTokens: 4, outputTokens: 2, totalTokens: 6, totalTokensDerived: false },
      toolCalls: [{ toolCallId, name: 'shell', arguments: { command: 'printf synthetic' }, issuedAtUnixNs: unixNs(at + 2) }],
      toolResults: [{ toolCallId, name: 'shell', content: { stdout: 'synthetic' }, isError: false, observedAtUnixNs: unixNs(at + 3) }],
      semanticParserId: 'entity-fixture',
      semanticParserVersion: 1,
      completeness: 'complete',
      partialReasons: [],
      captureSource: 'fixture',
    },
  },
});

let source;
try {
  const sourceResult = await request('/sources', 'POST', {
    name: `${runId} source`, type: 'observer', enabled: true, requireToken: true, collectorId,
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
    tenantId: `${runId}-tenant`,
    ownerId: `${runId}-owner`,
    profile: 'default',
    ingestionSourceId: source.source.sourceId,
    agentInstanceId: runtimeId,
    physicalWorkloadId: `host:${processInfo.hostId}:${processInfo.bootId}:${runtimeId}`,
  });
  assert.equal(metadata.response.status, 200, `metadata -> ${metadata.response.status}`);

  const lease = await request('/runtime/lease', 'POST', {
    collectorId,
    forwarderInstanceId: `${runId}-forwarder`,
    hostId: processInfo.hostId,
    bootId: processInfo.bootId,
    forwarderPid: 46_002,
    forwarderStartTimeTicks: '4600200',
  }, source.token, { auth: 'source' });
  assert.equal(lease.response.status, 200);
  assert.equal(lease.payload?.accepted, true, lease.payload?.reason);

  const runtimeSnapshot = await request('/runtime/snapshot', 'POST', {
    schemaVersion: 'anysentry.agent_runtime_snapshot.v1',
    collectorId,
    forwarderInstanceId: `${runId}-forwarder`,
    leaseEpoch: lease.payload.leaseEpoch,
    snapshotVersion: 1,
    generatedAt: new Date(at).toISOString(),
    ready: true,
    intervalSecs: 1,
    filterMode: 'enforce',
    entries: [{
      agentScopeId: 'codex',
      agentDisplayName: 'Codex',
      agentInstanceId: runtimeId,
      logicalAgentId,
      logicalDefinitionId,
      logicalScopeMode: 'registered_definition',
      logicalIdentityAuthority: 'management_registration',
      tenantId: `${runId}-tenant`,
      ownerId: `${runId}-owner`,
      profile: 'default',
      physicalWorkloadId: `host:${processInfo.hostId}:${processInfo.bootId}:${runtimeId}`,
      classification: 'probable_agent',
      runtimeState: 'running',
      rootPid: processInfo.pid,
      rootStartTimeTicks: processInfo.startTimeTicks,
      rootGeneration: 1,
      hostId: processInfo.hostId,
      bootId: processInfo.bootId,
      comm: processInfo.comm,
      exe: processInfo.exe,
      workspacePath,
      discoveredAt: new Date(at).toISOString(),
      lastSeenAt: new Date(at).toISOString(),
      lastActivityAt: new Date(at).toISOString(),
      confidence: 0.8,
      source: 'process_signature',
      evidence: [`fixture:${runId}`],
      workloadRef: { environment: 'host', kind: 'process', processName: 'codex', executable: processInfo.exe },
    }],
  }, source.token, { auth: 'source' });
  assert.equal(runtimeSnapshot.response.status, 200);
  assert.equal(runtimeSnapshot.payload?.accepted, true, runtimeSnapshot.payload?.reason);

  const ingest = await request('/ingest/batch', 'POST', {
    batchId: runId,
    events: [{
      line,
      sourceId: source.source.sourceId,
      token: source.token,
      collectorId,
      sourceType: 'observer',
      sourceEventId: `${runId}-event`,
      workspacePath,
      classificationSemantics: {
        schemaVersion: 'anysentry.classification_semantics.v1',
        identityClassification: 'probable_agent',
        workloadRole: 'agent',
        captureProfile: 'probable_investigation',
      },
      attribution: {
        monitored: true,
        classification: 'probable_agent',
        confidence: 0.85,
        reason: 'hint_only',
        source: 'process_signature',
        agentScopeId: 'codex',
        agentInstanceId: runtimeId,
        rootPid: processInfo.pid,
        rootStartTime: processInfo.startTimeTicks,
        evidence: [`fixture:${runId}`],
      },
    }],
  }, source.token, { auth: 'source' });
  assert.equal(ingest.response.status, 201, `ingest -> ${ingest.response.status}`);
  assert.equal(ingest.payload?.acceptedEvents, 1, JSON.stringify(ingest.payload));

  const get = async (path) => {
    const result = await request(path);
    assert.equal(result.response.status, 200, `${path} -> ${result.response.status}`);
    return result.payload;
  };
  const contracts = await get('/v1/observability/contracts');
  assert.equal(contracts.rawObservation, 'anysentry.raw_observation.v1');
  assert.equal(contracts.agentInstance, 'anysentry.agent_instance.v1');

  // Liveness is deliberately independent of storage/projection work. Keep this assertion next
  // to the Canonical GET contract so a deployment cannot switch probes to an unimplemented path.
  const livez = await request('/livez', 'GET', undefined, '');
  assert.equal(livez.response.status, 200, 'livez must be public and O(1)');
  assert.equal(livez.payload?.schemaVersion, 'anysentry.livez.v1');
  assert.equal(livez.payload?.status, 'ok');

  const logical = await get(`/v1/logical-agents?logicalAgentId=${encodeURIComponent(logicalAgentId)}&limit=1&revision=1`);
  assert.equal(logical.schemaVersion, 'anysentry.logical_agent.list.v1');
  assert.equal(logical.items.length, 1);
  assert.equal(logical.items[0].logicalAgentId, logicalAgentId);
  assert.equal(logical.items[0].tenantId, `${runId}-tenant`);
  assert.equal(typeof logical.pagination.hasMore, 'boolean');
  assert(logical.coverage && logical.revision >= 1, 'LogicalAgent coverage/revision missing');

  const instances = await get(`/v1/agent-instances?limit=10`);
  assert.equal(instances.schemaVersion, 'anysentry.agent_instance.list.v1');
  assert(instances.items.some((item) => item.logicalAgentId === logicalAgentId), 'AgentInstance projection missing');
  const instance = instances.items.find((item) => item.logicalAgentId === logicalAgentId);
  const scopedInstances = await get(`/v1/agent-instances?tenantId=${encodeURIComponent(`${runId}-tenant`)}&limit=10`);
  assert(scopedInstances.items.some((item) => item.agentInstanceId === instance.agentInstanceId), 'AgentInstance tenant scope missing');
  const sourceScopedInstances = await get(`/v1/agent-instances?sourceId=${encodeURIComponent(source.source.sourceId)}&limit=10`);
  assert(sourceScopedInstances.items.some((item) => item.agentInstanceId === instance.agentInstanceId), 'AgentInstance source scope missing');
  const instanceDetail = await get(`/v1/agent-instances/${encodeURIComponent(instance.agentInstanceId)}`);
  assert.equal(instanceDetail.item.agentInstanceId, instance.agentInstanceId);

  const runtimes = await get(`/v1/runtime-instances?limit=10`);
  assert.equal(runtimes.schemaVersion, 'anysentry.runtime_instance.list.v1');
  assert(runtimes.items.some((item) => item.runtimeInstanceId === runtimeId), 'RuntimeInstance projection missing');
  assert.equal(runtimes.items.find((item) => item.runtimeInstanceId === runtimeId)?.sourceId, source.source.sourceId);
  const scopedRuntimes = await get(`/v1/runtime-instances?tenantId=${encodeURIComponent(`${runId}-tenant`)}&limit=10`);
  assert(scopedRuntimes.items.some((item) => item.runtimeInstanceId === runtimeId), 'RuntimeInstance tenant scope missing');
  const collectorScopedRuntimes = await get(`/v1/runtime-instances?collectorId=${encodeURIComponent(collectorId)}&limit=10`);
  assert(collectorScopedRuntimes.items.some((item) => item.runtimeInstanceId === runtimeId), 'RuntimeInstance collector scope missing');
  const sourceScopedRuntimes = await get(`/v1/runtime-instances?sourceId=${encodeURIComponent(source.source.sourceId)}&limit=10`);
  assert(sourceScopedRuntimes.items.some((item) => item.runtimeInstanceId === runtimeId), 'RuntimeInstance source scope missing');
  const runtimeDetail = await get(`/v1/runtime-instances/${encodeURIComponent(runtimeId)}`);
  assert.equal(runtimeDetail.item.runtimeInstanceId, runtimeId);

  const sessions = await get(`/v1/sessions?logicalAgentId=${encodeURIComponent(logicalAgentId)}&limit=10`);
  assert.equal(sessions.schemaVersion, 'anysentry.session.list.v1');
  assert(sessions.items.length > 0, 'Session projection missing');
  const session = sessions.items[0];
  const sessionDetail = await get(`/v1/sessions/${encodeURIComponent(session.sessionId)}`);
  assert.equal(sessionDetail.item.sessionId, session.sessionId);
  const sessionCoverage = await get(`/v1/sessions/${encodeURIComponent(session.sessionId)}/coverage`);
  assert(sessionCoverage.coverage, 'Session coverage endpoint missing coverage');
  const sessionTimeline = await get(`/v1/sessions/${encodeURIComponent(session.sessionId)}/timeline?limit=20`);
  assert(sessionTimeline.timeline, 'Session timeline endpoint missing timeline');
  const toolEvent = sessionTimeline.timeline.turns
    .flatMap((turn) => turn.events)
    .find((event) => event.kind === 'tool_call' && event.toolCallId === toolCallId);
  assert(toolEvent?.semanticEventId?.startsWith('se_'), 'timeline tool semantic event missing');
  const semanticRecords = await get('/v1/semantic-records?limit=500');
  const durableToolRecord = semanticRecords.items.find((item) => item.kind === 'tool_call' && item.toolCallId === toolCallId);
  assert(durableToolRecord?.semanticRecordId?.startsWith('sr_'), 'durable tool semantic record missing');
  const timelineEvidence = await get(`/v1/semantic-events/${encodeURIComponent(toolEvent.semanticEventId)}/evidence`);
  assert.equal(timelineEvidence.requestedSemanticEventId, toolEvent.semanticEventId);
  assert.equal(timelineEvidence.resolvedSemanticEventId, toolEvent.semanticEventId);
  assert(timelineEvidence.aliasCandidates?.includes(durableToolRecord.semanticRecordId)
    || timelineEvidence.aliasOf === durableToolRecord.semanticRecordId,
  'timeline durable semantic alias missing');
  if (timelineEvidence.relationStatus === 'ambiguous') {
    assert.equal(timelineEvidence.coverage.status, 'partial');
  }
  assert(timelineEvidence.evidence || timelineEvidence.coverage.status !== 'complete', 'timeline semantic evidence missing');
  const durableEvidence = await get(`/v1/semantic-events/${encodeURIComponent(durableToolRecord.semanticRecordId)}/evidence`);
  assert.equal(durableEvidence.requestedSemanticEventId, durableToolRecord.semanticRecordId);
  assert.equal(durableEvidence.resolvedSemanticEventId, toolEvent.semanticEventId);
  assert.equal(durableEvidence.aliasOf, durableToolRecord.semanticRecordId);
  const kernelFacts = await get('/v1/kernel-facts?limit=1');
  const kernelFact = kernelFacts.items?.[0];
  if (kernelFact?.factId) {
    const kernelContext = await get(`/v1/kernel-facts/${encodeURIComponent(kernelFact.factId)}/context`);
    assert(kernelContext.coverage, 'KernelFact context must expose coverage metadata');
    assert(kernelContext.context?.eventId, 'KernelFact context must retain the fact event identity');
  }
  const expiredTimelineEvidence = await get('/v1/semantic-events/se_000000000000000000000000/evidence');
  assert.equal(expiredTimelineEvidence.relationStatus, 'coverage_gap');
  assert.equal(expiredTimelineEvidence.coverage.status, 'partial');
  const instanceSessions = await get(`/v1/agent-instances/${encodeURIComponent(instance.agentInstanceId)}/sessions?limit=10`);
  assert(instanceSessions.items.some((item) => item.sessionId === session.sessionId), 'AgentInstance session projection missing');

  // Cursor pagination is opaque and must not duplicate the first page.
  const firstPage = await get('/v1/runtime-instances?limit=1');
  if (firstPage.pagination.nextCursor) {
    const secondPage = await get(`/v1/runtime-instances?limit=1&cursor=${encodeURIComponent(firstPage.pagination.nextCursor)}`);
    assert.notEqual(secondPage.items[0]?.runtimeInstanceId, firstPage.items[0]?.runtimeInstanceId);
  }

  const unauthenticated = await request('/v1/logical-agents?limit=1', 'GET', undefined, '');
  assert.equal(unauthenticated.response.status, 401, 'Canonical entity GET must enforce management auth');

  // Candidate provenance is preserved while the effective read/capture classification is promoted.
  const interactionsResult = await request('/agents/interactions', 'POST', { timeType: 'last_30d', scope: 'raw', limit: 500 });
  assert.equal(interactionsResult.response.status, 200);
  const interactions = interactionsResult.payload;
  const observed = interactions.items.find((item) => item.interactionId === interactionId);
  if (observed) {
    assert.equal(observed.detectedClassification, 'probable_agent');
    assert.equal(observed.currentEffectiveClassification, 'confirmed_agent');
    assert.equal(observed.candidateAutoPromoted, true);
  }

  await request(`/agents/${encodeURIComponent('codex')}/metadata`, 'PUT', {
    workspacePath,
    logicalAgentId: '',
    logicalDefinitionId: '',
    logicalScopeMode: 'unresolved',
    ingestionSourceId: '',
    registrationRef: '',
    agentInstanceId: '',
    physicalWorkloadId: '',
  });
  await request(`/sources/${encodeURIComponent(source.source.sourceId)}`, 'PUT', { enabled: false });
  console.log(JSON.stringify({
    schemaVersion: 'anysentry.canonical_entity_get.v1',
    status: 'pass',
    resources: { logicalAgents: logical.items.length, agentInstances: instances.items.length, runtimeInstances: runtimes.items.length, sessions: sessions.items.length },
    revision: Math.max(logical.revision, instances.revision, runtimes.revision, sessions.revision),
  }));
} catch (error) {
  if (source?.source?.sourceId) await request(`/sources/${encodeURIComponent(source.source.sourceId)}`, 'PUT', { enabled: false }).catch(() => undefined);
  throw error;
}
