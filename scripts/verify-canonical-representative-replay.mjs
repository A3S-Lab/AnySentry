#!/usr/bin/env node

/**
 * Replay-only acceptance for the four current representative object families.
 *
 * The records are synthetic, bounded, and contain no credentials or user transcript.  The
 * purpose is to exercise the same authenticated Observer ingest seam used by a Forwarder: an
 * immutable raw observation is committed before the compatibility Judge, semantic interactions
 * retain provider/session/run/tool fields, and independent KernelFacts remain queryable.  It is
 * intentionally not presented as evidence that a particular vendor binary was attached.
 */

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { localApiBase } from './local-api-base.mjs';

const base = await localApiBase(process.env.ANYSENTRY_API_BASE);
const adminToken = (process.env.ANYSENTRY_ADMIN_TOKEN
  ?? process.env.ANYSENTRY_MANAGEMENT_TOKEN
  ?? '').trim();
if (!adminToken) throw new Error('ANYSENTRY_ADMIN_TOKEN or ANYSENTRY_MANAGEMENT_TOKEN is required');

const runId = `canonical-replay-${Date.now()}-${process.pid}`;
// Keep every read in the same short custom window as the synthetic batch.  A broad historical
// window (for example last_30d) forces the compatibility conversation projector to compete with
// unrelated production history and can turn an otherwise bounded replay into a storage timeout.
// The API still reports partial coverage when the durable store is unavailable; this test is about
// the authenticated replay seam and must not manufacture a pass by widening the query.
const replayWindowStartMs = Date.now() - 60_000;
const replayWindow = () => ({
  timeType: 'custom',
  startTime: new Date(replayWindowStartMs).toISOString(),
  endTime: new Date(Date.now() + 60_000).toISOString(),
});
const digest = (value) => createHash('sha256').update(value).digest('hex');
const ns = (millis) => String(BigInt(millis) * 1_000_000n);

async function request(path, method = 'GET', body, headers = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-anysentry-admin-token': adminToken,
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : undefined; } catch { payload = undefined; }
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}`);
  return payload?.data ?? payload;
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

const definitions = [
  { id: 'codex', product: 'codex', logical: 'la-replay-codex', definition: 'codex-definition', mode: 'registered_definition', session: 'session-codex-replay' },
  { id: 'claude-code', product: 'claude-code', logical: 'la-replay-claude', definition: 'claude-definition', mode: 'registered_definition', session: 'session-claude-replay' },
  { id: 'dify', product: 'dify', logical: 'la-replay-dify', definition: 'workflow-definition', mode: 'workflow_definition', session: undefined },
  { id: 'langchain-langgraph', product: 'langgraph', logical: 'la-replay-langgraph', definition: 'graph-definition', mode: 'service_definition', session: 'thread-langgraph-replay' },
];

function requestShape(definition, turn, hasResult) {
  const text = `${definition.id} synthetic turn ${turn}`;
  if (definition.id === 'codex') {
    return { model: 'replay-model', input: [{ role: 'user', content: text }, ...(hasResult ? [{ type: 'function_call_output', call_id: `call-${definition.id}`, output: 'replay-result' }] : [])] };
  }
  if (definition.id === 'claude-code') {
    return { model: 'replay-model', messages: [{ role: 'user', content: [{ type: 'text', text }] }, ...(hasResult ? [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: `call-${definition.id}`, content: 'replay-result' }] }] : [])] };
  }
  if (definition.id === 'dify') {
    return { inputs: { query: text }, response_mode: 'streaming', user: 'replay-user' };
  }
  return { thread_id: definition.session, messages: [{ role: 'user', content: text }, ...(hasResult ? [{ role: 'tool', tool_call_id: `call-${definition.id}`, content: 'replay-result' }] : [])] };
}

function responseShape(definition, turn, hasResult) {
  const callId = `call-${definition.id}`;
  if (definition.id === 'codex') {
    return hasResult
      ? { id: `resp-${definition.id}-final`, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'replay final response' }] }] }
      : { id: `resp-${definition.id}-tool`, output: [{ type: 'function_call', call_id: callId, name: 'exec_command', arguments: '{"cmd":"printf replay"}' }] };
  }
  if (definition.id === 'claude-code') {
    return hasResult
      ? { id: `msg-${definition.id}-final`, type: 'message', role: 'assistant', content: [{ type: 'text', text: 'replay final response' }] }
      : { id: `msg-${definition.id}-tool`, type: 'message', role: 'assistant', content: [{ type: 'tool_use', id: callId, name: 'Bash', input: { command: 'printf replay' } }] };
  }
  if (definition.id === 'dify') {
    return { data: { event: 'workflow_finished', workflow_run_id: `workflow-run-${turn}`, status: 'succeeded', outputs: { text: 'replay final response' } } };
  }
  return hasResult
    ? { id: `run-${definition.id}-final`, messages: [{ role: 'assistant', content: 'replay final response' }] }
    : { id: `run-${definition.id}-tool`, messages: [{ role: 'assistant', tool_calls: [{ id: callId, type: 'function', function: { name: 'lookup_fixture', arguments: '{"key":"replay"}' } }] }] };
}

function interactionLine(
  definition,
  turn,
  instance,
  terminalContextId,
  hasResult,
  closeToolLoop = false,
) {
  const at = Date.now() + turn;
  const interactionId = `mi_${digest(`${runId}\0${definition.id}\0${turn}`).slice(0, 24)}`;
  const request = requestShape(definition, turn, hasResult);
  const response = responseShape(definition, turn, hasResult);
  const callId = `call-${definition.id}`;
  const line = {
    eventAtUnixNs: ns(at),
    receivedAtUnixNs: ns(at + 1),
    identity: { agent: definition.product, task: `${runId}-${definition.id}-${turn}` },
    process: {
      hostId: 'goal-host', bootId: 'goal-boot', pid: 40_000 + turn + definitions.indexOf(definition) * 100,
      ppid: 1, startTimeTicks: String(900_000 + turn), comm: definition.product,
      exe: `/opt/replay/${definition.product}`,
    },
    event: {
      LlmInteraction: {
        schemaVersion: 'anysentry.agent_interaction.v1',
        interactionId,
        interactionType: 'model',
        pid: 40_000 + turn + definitions.indexOf(definition) * 100,
        connectionId: `tls:replay-${definition.id}-${turn}`,
        transport: 'tls',
        protocol: 'http/1.1',
        tlsAdapterId: 'fixture-replay',
        transportProtocol: 'http/1.1',
        wireTemplateId: definition.id === 'claude-code' ? 'anthropic-messages' : 'openai-compatible',
        parseState: 'parsed',
        llmLikelihood: 'confirmed',
        transportCompleteness: 'complete',
        wireCompleteness: 'complete',
        conversationCompleteness: 'complete',
        endpoint: 'replay.invalid',
        method: 'POST',
        path: definition.id === 'claude-code' ? '/v1/messages' : '/v1/chat/completions',
        statusCode: 200,
        model: 'replay-model',
        ...(definition.session ? { providerConversationId: definition.session, sessionId: definition.session } : {}),
        providerResponseId: `response-${definition.id}-${turn}`,
        ...(turn > 1 ? { providerPreviousResponseId: `response-${definition.id}-${turn - 1}` } : {}),
        runId: `${runId}-${definition.id}-run-${turn}`,
        logicalAgentId: definition.logical,
        logicalDefinitionId: definition.definition,
        logicalScopeMode: definition.mode,
        tenantId: 'goal-tenant',
        ownerId: 'goal-owner',
        profile: turn === 1 ? 'test' : 'production',
        terminalContextId,
        sessionMode: definition.session ? 'resumable' : 'per_request',
        sessionIdSource: definition.session ? 'provider' : 'per_request',
        serviceStateful: Boolean(definition.session),
        resume: Boolean(definition.session && turn > 1),
        startedAtUnixNs: ns(at),
        requestCompleteAtUnixNs: ns(at + 1),
        firstResponseAtUnixNs: ns(at + 2),
        endedAtUnixNs: ns(at + 3),
        durationNs: '3000000',
        timeQuality: 'collector_calibrated',
        request: content(request),
        response: content(response),
        usage: { source: 'provider_reported', completeness: 'complete', inputTokens: 12, outputTokens: 6, totalTokens: 18, totalTokensDerived: false },
        // Dify Workflow/Chatflow POSTs are stateless when no conversation_id is present. Keep
        // each POST in its own Session, but make the first synthetic POST a complete semantic
        // ToolCall→ToolResult loop so the replay can verify the evidence relation without asking
        // the resolver to merge two independent Sessions.
        toolCalls: (!hasResult || closeToolLoop)
          ? [{ toolCallId: callId, name: definition.id === 'claude-code' ? 'Bash' : 'lookup_fixture', arguments: { command: 'printf replay' }, issuedAtUnixNs: ns(at + 2) }]
          : [],
        toolResults: (hasResult || closeToolLoop)
          ? [{
              toolCallId: callId,
              name: 'replay-tool',
              content: 'replay-result',
              isError: false,
              observedAtUnixNs: ns(at + (closeToolLoop ? 3 : 1)),
            }]
          : [],
        semanticParserId: 'canonical-replay',
        semanticParserVersion: 1,
        completeness: 'complete',
        partialReasons: [],
        captureSource: 'fixture_replay',
      },
    },
  };
  return { interactionId, line, process: line.process };
}

function kernelLine(definition, turn, process) {
  const at = Date.now() + turn + 10;
  return JSON.stringify({
    eventAtUnixNs: ns(at),
    receivedAtUnixNs: ns(at + 1),
    identity: { agent: definition.product, task: `${runId}-${definition.id}-kernel-${turn}` },
    process: { ...process, pid: process.pid + 50_000, ppid: process.pid },
    event: { ToolExec: { execId: `${runId}-${definition.id}-${turn}`, pid: process.pid + 50_000, ppid: process.pid, argv: ['printf', 'replay'], cwd: '/tmp' } },
  });
}

let source;
let cleanupStarted = false;
const cleanup = async () => {
  if (cleanupStarted) return;
  cleanupStarted = true;
  if (source?.source?.sourceId) {
    await request(`/sources/${encodeURIComponent(source.source.sourceId)}`, 'PUT', { enabled: false }).catch(() => undefined);
  }
  // Metadata has no destructive delete API by design. Clear the temporary logical registration so
  // a failed/repeated replay cannot leave a stable definition behind; the retained synthetic
  // event facts remain useful for the current process and are bounded by the API hot stores.
  for (const definition of definitions) {
    const workspacePath = `repo://${runId}/${definition.id}`;
    await request(`/agents/${encodeURIComponent(definition.product)}/metadata`, 'PUT', {
      workspacePath,
      logicalAgentId: '',
      logicalDefinitionId: '',
      logicalScopeMode: 'unresolved',
      ingestionSourceId: '',
      registrationRef: '',
    }).catch(() => undefined);
  }
};

try {
source = await request('/sources', 'POST', {
  name: `${runId} source`, type: 'observer', enabled: true, requireToken: true,
  collectorId: `${runId}-collector`, owner: 'canonical-replay',
});
assert(source?.source?.sourceId && source?.token, 'managed source creation failed');

// A collector token authenticates transport only.  Register each logical definition through the
// management plane before replay so the test exercises the intended authority path; the line
// itself carries deliberately different identity hints and must be overridden by this registry.
for (const definition of definitions) {
  const workspacePath = `repo://${runId}/${definition.id}`;
  await request(`/agents/${encodeURIComponent(definition.product)}/metadata`, 'PUT', {
    workspacePath,
    logicalAgentId: definition.logical,
    logicalDefinitionId: definition.definition,
    logicalDefinitionType: definition.mode === 'workflow_definition' ? 'workflow'
      : definition.mode === 'service_definition' ? 'service' : 'registered',
    logicalScopeMode: definition.mode,
    tenantId: 'goal-tenant',
    ownerId: 'goal-owner',
    profile: 'test',
    profileVersion: 'v1',
    ingestionSourceId: source.source.sourceId,
  });
}

const events = [];
const expected = new Map();
for (const definition of definitions) {
  const first = interactionLine(
    definition,
    1,
    `${runId}-${definition.id}-instance-a`,
    `${runId}-terminal-a`,
    false,
    definition.id === 'dify',
  );
  const second = interactionLine(definition, 2, `${runId}-${definition.id}-instance-b`, `${runId}-terminal-b`, true);
  // The two CLI/service rounds deliberately use different process generations while preserving
  // a provider session where the application contract supplies one. Dify has two independent
  // per-request calls and therefore no provider session anchor.
  events.push(
    // The producer hints intentionally do not match the registered values.  They are useful for
    // proving that a Source token cannot move an event between logical definitions.
    { line: JSON.stringify({ ...first.line, logicalAgentId: `producer-hint-${definition.id}`, logicalDefinitionId: `producer-definition-${definition.id}`, logicalScopeMode: 'terminal', terminalContextId: `${runId}-producer-terminal` }), sourceId: source.source.sourceId, token: source.token, collectorId: `${runId}-collector`, sourceType: 'observer', sourceEventId: `${runId}-${definition.id}-interaction-1`, workspacePath: `repo://${runId}/${definition.id}`, classificationSemantics: { schemaVersion: 'anysentry.classification_semantics.v1', identityClassification: 'confirmed_agent', workloadRole: 'agent', captureProfile: 'agent_full' }, attribution: { monitored: true, classification: 'confirmed_agent', confidence: 1, reason: 'authoritative_anchor', source: 'self_register', agentScopeId: `producer-hint-${definition.id}`, agentDisplayName: definition.product, agentInstanceId: first.process.pid.toString(), rootPid: first.process.pid, rootStartTime: first.process.startTimeTicks, evidence: ['canonical-replay'] } },
    { line: JSON.stringify({ ...second.line, logicalAgentId: `producer-hint-${definition.id}`, logicalDefinitionId: `producer-definition-${definition.id}`, logicalScopeMode: 'terminal', terminalContextId: `${runId}-producer-terminal` }), sourceId: source.source.sourceId, token: source.token, collectorId: `${runId}-collector`, sourceType: 'observer', sourceEventId: `${runId}-${definition.id}-interaction-2`, workspacePath: `repo://${runId}/${definition.id}`, classificationSemantics: { schemaVersion: 'anysentry.classification_semantics.v1', identityClassification: 'confirmed_agent', workloadRole: 'agent', captureProfile: 'agent_full' }, attribution: { monitored: true, classification: 'confirmed_agent', confidence: 1, reason: 'authoritative_anchor', source: 'self_register', agentScopeId: `producer-hint-${definition.id}`, agentDisplayName: definition.product, agentInstanceId: second.process.pid.toString(), rootPid: second.process.pid, rootStartTime: second.process.startTimeTicks, evidence: ['canonical-replay'] } },
    { line: kernelLine(definition, 1, first.process), sourceId: source.source.sourceId, token: source.token, collectorId: `${runId}-collector`, sourceType: 'observer', sourceEventId: `${runId}-${definition.id}-kernel-1`, workspacePath: `repo://${runId}/${definition.id}`, classificationSemantics: { schemaVersion: 'anysentry.classification_semantics.v1', identityClassification: 'confirmed_agent', workloadRole: 'agent', captureProfile: 'agent_full' }, attribution: { monitored: true, classification: 'confirmed_agent', confidence: 1, reason: 'authoritative_anchor', source: 'self_register', agentScopeId: `producer-hint-${definition.id}`, agentDisplayName: definition.product, agentInstanceId: first.process.pid.toString(), rootPid: first.process.pid, rootStartTime: first.process.startTimeTicks, evidence: ['canonical-replay'] } },
  );
  expected.set(definition.id, { session: definition.session, logical: definition.logical });
}

// One authenticated-but-unregistered producer attempts to self-assign a stable definition.  The
// Source token should authenticate delivery while the resulting interaction remains a candidate.
const unregistered = interactionLine({
  id: 'unregistered-agent', product: 'unregistered-agent', logical: 'la-forged',
  definition: 'forged-definition', mode: 'registered_definition', session: 'forged-session',
}, 1, `${runId}-unregistered-instance`, `${runId}-unregistered-terminal`, false);
const unregisteredWorkspace = `repo://${runId}/unregistered`;
events.push({
  line: JSON.stringify({
    ...unregistered.line,
    logicalAgentId: 'la-forged-by-producer',
    logicalDefinitionId: 'forged-definition-by-producer',
    logicalScopeMode: 'registered_definition',
    tenantId: 'forged-tenant',
    ownerId: 'forged-owner',
    profile: 'forged-profile',
  }),
  sourceId: source.source.sourceId,
  token: source.token,
  collectorId: `${runId}-collector`,
  sourceType: 'observer',
  sourceEventId: `${runId}-unregistered-interaction`,
  workspacePath: unregisteredWorkspace,
  classificationSemantics: { schemaVersion: 'anysentry.classification_semantics.v1', identityClassification: 'confirmed_agent', workloadRole: 'agent', captureProfile: 'agent_full' },
  attribution: { monitored: true, classification: 'confirmed_agent', confidence: 1, reason: 'authoritative_anchor', source: 'self_register', agentScopeId: 'la-forged-by-producer', agentDisplayName: 'unregistered-agent', agentInstanceId: unregistered.process.pid.toString(), rootPid: unregistered.process.pid, rootStartTime: unregistered.process.startTimeTicks, evidence: ['canonical-replay-unregistered'] },
});

const ingest = await request('/ingest/batch', 'POST', { batchId: runId, events });
assert.equal(ingest.acceptedEvents, events.length, JSON.stringify({ accepted: ingest.acceptedEvents, rejected: ingest.rejectedEvents }));

const raw = await request('/v1/raw-observations?limit=200');
const kernel = await request('/v1/kernel-facts?limit=200');
const gaps = await request('/v1/coverage-gaps?limit=200');
assert(raw.items?.length >= events.length, 'raw observations were not retained');
assert(kernel.items?.length >= definitions.length, 'KernelFacts were not retained independently');
assert(raw.items.every((item) => item.payload?.body === undefined), 'canonical raw lane leaked a body');
assert(gaps.items?.every((gap) => gap.schemaVersion === 'anysentry.coverage_gap.v1'), 'invalid coverage gap projection');

const interactions = await request('/agents/interactions', 'POST', { ...replayWindow(), scope: 'raw', limit: 200 });
const byProduct = new Map();
for (const item of interactions.items ?? []) {
  const key = item.agentProduct?.toLowerCase();
  if (definitions.some((definition) => definition.product === key || definition.id === key)) {
    const list = byProduct.get(key) ?? [];
    list.push(item);
    byProduct.set(key, list);
  }
}
for (const definition of definitions) {
  const candidates = [...byProduct.entries()]
    .filter(([key]) => key === definition.product || key === definition.id)
    .flatMap(([, values]) => values);
  assert(candidates.length >= 2, `${definition.id} replay interactions missing`);
  assert(candidates.some((item) => item.toolCalls.length > 0), `${definition.id} ToolCall missing`);
  assert(candidates.some((item) => item.toolResults.length > 0), `${definition.id} ToolResult missing`);
  if (definition.id === 'dify') {
    assert(candidates.some((item) => item.toolCalls.length > 0 && item.toolResults.length > 0),
      'Dify stateless POST fixture must keep ToolCall and ToolResult in one Interaction');
  }
  if (definition.session) assert(candidates.some((item) => item.providerConversationId === definition.session), `${definition.id} provider session missing`);
  else assert(candidates.every((item) => item.sessionMode === 'per_request'), `${definition.id} per-request session boundary missing`);
}
const unregisteredInteraction = (interactions.items ?? []).find((item) => item.interactionId === unregistered.interactionId);
assert(unregisteredInteraction, 'unregistered producer interaction missing');
assert.equal(unregisteredInteraction.logicalAgentId, undefined, 'unregistered producer minted a stable LogicalAgent');
assert(unregisteredInteraction.logicalAgentCandidateId, 'unregistered producer lost its candidate identity');

// Exercise the canonical semantic/evidence/session projections through the same read APIs used by
// the UI.  The point lookups are intentionally ID-based so a late relation revision cannot be
// confused with a broad time-window result.
const semantic = await request('/v1/semantic-records?limit=500');
assert(semantic.items?.length >= definitions.length, 'canonical semantic records were not retained');
assert(semantic.items.every((item) => item.payloadRef && !Object.prototype.hasOwnProperty.call(item, 'body')),
  'semantic projection must remain hash/ref-only');
for (const definition of definitions) {
  assert(semantic.items.some((item) => item.logicalAgentId === definition.logical),
    `${definition.id} canonical logical semantic record missing`);
}

const conversations = await request('/agents/conversations', 'POST', { ...replayWindow(), scope: 'agent', limit: 200 });
const evidenceLinkIds = new Set();
for (const definition of definitions) {
  const summaries = (conversations.items ?? []).filter((item) => item.logicalAgentId === definition.logical);
  assert(summaries.length > 0, `${definition.id} canonical conversation summary missing`);
  let summary;
  let timeline;
  let toolEvent;
  for (const candidate of summaries) {
    const candidateTimeline = await request('/agents/conversations/timeline-v3', 'POST', {
      ...replayWindow(), scope: 'agent', conversationId: candidate.conversationId,
    });
    const candidateToolEvent = (candidateTimeline.turns ?? []).flatMap((turn) => turn.events ?? [])
      .find((event) => event.kind === 'tool_call');
    if (candidateToolEvent) {
      summary = candidate;
      timeline = candidateTimeline;
      toolEvent = candidateToolEvent;
      break;
    }
  }
  assert(toolEvent, `${definition.id} timeline ToolCall missing`);
  const evidence = await request('/agents/semantic-events/evidence', 'POST', {
    ...replayWindow(), scope: 'agent', conversationId: summary.conversationId,
    semanticEventId: toolEvent.semanticEventId,
  });
  assert(evidence.relations?.length > 0, `${definition.id} semantic evidence relation missing`);
  for (const relation of evidence.relations) if (relation.evidenceLinkId) evidenceLinkIds.add(relation.evidenceLinkId);
}
const links = await request('/v1/evidence-links?limit=500');
for (const linkId of evidenceLinkIds) {
  const link = links.items?.find((item) => item.linkId === linkId);
  assert(link, `canonical EvidenceLink ${linkId} missing`);
  assert(link.evidenceRefs?.length > 0, 'EvidenceLink sourceRefs must be non-empty');
}
const memberships = await request('/v1/session-memberships?limit=500');
assert(memberships.items?.length >= definitions.length, 'canonical SessionMembership projection missing');
assert(memberships.items.every((item) => item.sessionId && item.sourceRefs?.length),
  'canonical SessionMembership must retain session and source provenance');

await cleanup();
console.log(JSON.stringify({
  schemaVersion: 'anysentry.canonical_representative_replay.v1',
  status: 'pass',
  runId: digest(runId).slice(0, 16),
  sourceId: digest(source.source.sourceId).slice(0, 16),
  objects: definitions.map((definition) => definition.id),
  ingestedEvents: events.length,
  rawObservations: raw.items.length,
  kernelFacts: kernel.items.length,
  coverageGaps: gaps.items.length,
  interactions: interactions.items?.length ?? 0,
  semanticRecords: semantic.items?.length ?? 0,
  evidenceLinks: links.items?.length ?? 0,
  sessionMemberships: memberships.items?.length ?? 0,
  note: 'synthetic authenticated replay; not vendor-binary attach evidence',
}));
} catch (error) {
  await cleanup();
  throw error;
}
