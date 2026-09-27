#!/usr/bin/env node

/**
 * Local, deterministic checks for the canonical identity/session contract.  Values are synthetic
 * and deliberately contain no credentials or real prompts.  Run `pnpm build:api` first.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const canonical = require('../apps/api/dist/security-monitoring/canonical-observability.js');
const resolver = require('../apps/api/dist/security-monitoring/agent-conversation-resolution-v2.js');
const interactionParser = require('../apps/api/dist/security-monitoring/agent-interaction.js');
const { AgentMetadataService } = require('../apps/api/dist/security-monitoring/agent-metadata.service.js');
const {
  CanonicalObservabilityService,
  asyncCommitLostGaps,
} = require('../apps/api/dist/security-monitoring/canonical-observability.service.js');
const { captureClassificationDecision } = require('../apps/api/dist/security-monitoring/identity-judgment-routing.js');
const { semanticProjectionTesting } = require('../apps/api/dist/security-monitoring/security-monitoring.controller.js');

const {
  RawObservationStore,
  deriveConnectionIdentity,
  deriveProcessGenerationKey,
  normalizeKernelFact,
  KernelFactStore,
  validateKernelFact,
  rawObservationFromLine,
  resolveLogicalAgentDefinition,
  validateLogicalAgentDefinition,
  resolveSessionIdentity,
  deriveAgentInstanceIdentity,
  createEvidenceLink,
  validateRawObservation,
} = canonical;
assert.equal(
  interactionParser.normalizeAgentRouteShape('/runs/thread-abc123/nodes/42?stream=true'),
  '/runs/:param/nodes/:param',
  'generic HTTP route shape removes request-specific identifiers without using service names',
);
assert.equal(
  interactionParser.normalizeAgentRouteShape('/invoke'),
  '/invoke',
  'stable route segments remain unchanged',
);
assert.equal(
  interactionParser.normalizeAgentRouteShape('/runs/123/nodes/550e8400-e29b-41d4-a716-446655440000'),
  '/runs/:param/nodes/:param',
  'numeric and UUID route identifiers are normalized generically',
);
assert.doesNotThrow(
  () => interactionParser.normalizeAgentRouteShape('/runs/%E0%A4%A'),
  'malformed percent encoding cannot break interaction parsing',
);
const digest = (value) => createHash('sha256').update(value).digest('hex');

const semanticFixture = (eventKind, attributes = {}) => ({
  eventId: `evt-semantic-${eventKind}`,
  eventKind,
  at: 1_788_000_000_000,
  eventAtUnixNs: '1788000000000000000000',
  receivedAt: 1_788_000_000_001,
  subject: eventKind,
  agentId: 'fixture-adapter',
  workspacePath: '/workspace/semantic-fixture',
  sessionId: 'sess-fixture',
  canonicalSessionId: 'sess_fixture_canonical',
  sessionIdSource: 'per_request',
  sessionIdentityQuality: 'ephemeral',
  sessionMode: 'per_request',
  runId: 'producer-run-fixture',
  runIdSource: 'producer',
  turnId: 'turn-fixture',
  invocationId: 'invocation-fixture',
  toolCallId: 'tool-fixture',
  attributes,
  process: { pid: 42, hostId: 'fixture-host', bootId: 'fixture-boot', startTimeTicks: '100' },
  attribution: { agentInstanceId: 'runtime-fixture', workloadRef: { environment: 'host' } },
  rawObservationId: 'ro_fixture',
  sessionResolutionRevision: 1,
  identityRevision: 1,
  latencyMs: 10,
});

// The universal semantic classifier is shared by the ingest gate, canonical SemanticRecord and
// compatibility Interaction projection. Exercise aliases that commonly arrive from OTLP/adapter
// producers so a new spelling cannot populate only one evidence lane.
for (const [kind, expected] of [
  ['function_call', 'tool_call'], ['execute_tool', 'tool_call'],
  ['function_result', 'tool_result'], ['node_result', 'tool_result'],
  ['LlmApi', 'llm_call'], ['LlmInteraction', 'llm_call'],
  ['user_input', 'user_message'], ['assistant_message', 'model_message'],
]) {
  assert.equal(semanticProjectionTesting.universalSemanticKindClass(kind), expected, `${kind} semantic alias`);
  const event = semanticFixture(kind, { 'gen_ai.tool.call.id': 'tool-fixture' });
  const records = semanticProjectionTesting.canonicalSemanticRecordForEvent(event, 'authenticated_adapter');
  assert(records.some((record) => record.kind === (expected === 'tool_call' ? 'tool_call' : expected === 'tool_result' ? 'tool_result' : expected === 'llm_call' ? 'llm_call' : 'message')),
    `${kind} must create a canonical SemanticRecord`);
  const interaction = semanticProjectionTesting.canonicalInteractionForSemanticEvent(event);
  if (expected === 'tool_call') assert.equal(interaction.toolCalls.length, 1, `${kind} ToolCall projection`);
  if (expected === 'tool_result') assert.equal(interaction.toolResults.length, 1, `${kind} ToolResult projection`);
  if (expected === 'llm_call' || expected === 'model_message') assert(interaction.semanticItems.some((item) => item.actor === 'model'), `${kind} model projection`);
}
const standardModelAliasInteraction = semanticProjectionTesting.canonicalInteractionForSemanticEvent(
  semanticFixture('LlmApi', { 'gen_ai.request.model': 'fixture-model' }),
);
assert.equal(standardModelAliasInteraction.model, 'fixture-model',
  'standard GenAI model attributes must survive application semantic projection');
const unknownResultInteraction = semanticProjectionTesting.canonicalInteractionForSemanticEvent(
  semanticFixture('ToolResult', { 'anysentry.tool.call.id': 'tool-unknown', 'anysentry.tool.status': 'UNSET' }),
);
assert.equal(unknownResultInteraction.toolResults[0]?.isError, undefined,
  'UNSET ToolResult status must remain unknown rather than implicit success');
const placeholderHints = semanticProjectionTesting.semanticToolHints(
  semanticFixture('AgentTool', { 'anysentry.tool.call.id': 'tool-placeholder', 'anysentry.endpoint': 'application://semantic-event' }),
);
assert.equal(placeholderHints.endpoint, undefined, 'non-network endpoint schemes must not become relation hints');
const singleSlashPlaceholderHints = semanticProjectionTesting.semanticToolHints(
  semanticFixture('AgentTool', { 'anysentry.tool.call.id': 'tool-placeholder-single', 'anysentry.endpoint': 'application:/semantic-event' }),
);
assert.equal(singleSlashPlaceholderHints.endpoint, undefined, 'single-slash non-network URI schemes must not become relation hints');

const registeredA = resolveLogicalAgentDefinition({
  logicalAgentId: 'definition-alpha', family: 'generic-agent', tenantId: 'tenant-a', ownerId: 'owner-a',
  workspacePath: '/workspace/a', profile: 'default', terminalContextId: 'tty-a',
});
assert.equal(validateLogicalAgentDefinition(registeredA.definition).ok, true,
  'resolver output must satisfy its canonical definition contract even without explicit sourceRefs');
const registeredB = resolveLogicalAgentDefinition({
  logicalAgentId: 'definition-alpha', family: 'generic-agent', tenantId: 'tenant-a', ownerId: 'owner-a',
  workspacePath: '/workspace/a', profile: 'default', terminalContextId: 'tty-b',
});
assert.equal(registeredA.stable, true);
assert.equal(registeredA.logicalScopeKey, registeredB.logicalScopeKey);
const terminalA = resolveLogicalAgentDefinition({ ...registeredA.definition, logicalScopeMode: 'terminal', terminalContextId: 'tty-a' });
const terminalB = resolveLogicalAgentDefinition({ ...registeredB.definition, logicalScopeMode: 'terminal', terminalContextId: 'tty-b' });
assert.notEqual(terminalA.logicalScopeKey, terminalB.logicalScopeKey);
const workflowA = resolveLogicalAgentDefinition({ family: 'workflow', tenantId: 'tenant-a', definitionId: 'wf-a', definitionType: 'workflow' });
const workflowB = resolveLogicalAgentDefinition({ family: 'workflow', tenantId: 'tenant-a', definitionId: 'wf-b', definitionType: 'workflow' });
assert.equal(workflowA.stable, true);
assert.notEqual(workflowA.logicalScopeKey, workflowB.logicalScopeKey);
const unresolved = resolveLogicalAgentDefinition({ family: 'unknown-cli' });
assert.equal(unresolved.stable, false);
assert.equal(unresolved.definition.identityQuality, 'unresolved');

const processA = deriveProcessGenerationKey({ hostId: 'host-a', bootId: 'boot-a', pid: 42, startTimeTicks: '100' });
const processB = deriveProcessGenerationKey({ hostId: 'host-a', bootId: 'boot-a', pid: 42, startTimeTicks: '101' });
assert.match(processA, /^pgk_[a-f0-9]{24}$/u);
assert.notEqual(processA, processB);
const connection = deriveConnectionIdentity({ processGenerationKey: processA, socketCookie: 'socket-a', transport: 'tls', streamId: 'stream-1', sourceRefs: ['raw-a'] });
assert.equal(connection.quality, 'exact');
const kernel = normalizeKernelFact({
  kind: 'exec', observedAtUnixNs: '1788000000000000000', sourceRefs: ['raw-a'],
  processGenerationKey: processA, status: 'observed', eventId: 'evt-a',
});
assert.equal(validateKernelFact(kernel).ok, true);
let kernelNow = 10_000;
const kernelStore = new KernelFactStore({ maxEntries: 1, ttlMs: 100, now: () => kernelNow });
assert.equal(kernelStore.append(kernel).status, 'inserted');
assert.equal(kernelStore.append(kernel).status, 'duplicate');

const ephemeralOne = resolveSessionIdentity({ serviceStateful: false, requestId: 'post-1', runtimeSessionId: 'container-abc' });
const ephemeralTwo = resolveSessionIdentity({ serviceStateful: false, requestId: 'post-2', runtimeSessionId: 'container-abc' });
assert.equal(ephemeralOne.mode, 'per_request');
assert.equal(ephemeralOne.providerSessionId, undefined);
assert.notEqual(ephemeralOne.sessionId, ephemeralTwo.sessionId);
const statelessLegacyOne = resolveSessionIdentity({
  serviceStateful: false,
  sessionId: 'legacy-session-reused-by-service',
  requestId: 'post-legacy-1',
});
const statelessLegacyTwo = resolveSessionIdentity({
  serviceStateful: false,
  sessionId: 'legacy-session-reused-by-service',
  requestId: 'post-legacy-2',
});
assert.equal(statelessLegacyOne.mode, 'per_request',
  'an explicit stateless service boundary overrides a legacy session fallback');
assert.equal(statelessLegacyOne.quality, 'ephemeral');
assert.equal(statelessLegacyOne.source, 'ephemeral');
assert.notEqual(statelessLegacyOne.sessionId, statelessLegacyTwo.sessionId,
  'reused legacy session labels must not merge stateless POSTs');
const statelessProvider = resolveSessionIdentity({
  serviceStateful: false,
  providerSessionId: 'provider-label-reused-by-stateless-service',
  requestId: 'post-provider-1',
});
assert.equal(statelessProvider.mode, 'ephemeral');
assert.equal(statelessProvider.quality, 'ephemeral');
assert.equal(statelessProvider.providerSessionId, 'provider-label-reused-by-stateless-service',
  'an explicit provider anchor remains visible even when the service default is stateless');
const scopedStatelessProvider = resolveSessionIdentity({
  serviceStateful: false,
  providerSessionId: 'provider-thread',
  requestId: 'post-provider-scoped',
  scopeKey: 'tenant-a|service-a',
});
assert.equal(scopedStatelessProvider.mode, 'resumable',
  'an explicit scoped provider thread can resume even when POSTs default to stateless');
const pidLike = resolveSessionIdentity({ sessionId: '4242' });
const podLike = resolveSessionIdentity({ sessionId: 'pod-abc' });
assert.equal(pidLike.quality, 'ephemeral', 'PID-looking session IDs must not become provider sessions');
assert.equal(podLike.quality, 'ephemeral', 'pod-looking session IDs must not become provider sessions');
const resumed = resolveSessionIdentity({ providerSessionId: 'vendor-session', resume: true, scopeKey: 'scope-fixture' });
assert.equal(resumed.quality, 'confirmed');
assert.equal(resumed.lifecycle, 'resume');
assert.equal(resumed.mode, 'resumable');
const mintedProvider = resolveSessionIdentity({
  providerSessionId: '88cdd095-2a34-4bdc-945d-59f3a5ca1697',
  namespaceHint: 'source-a\0/workspace/a',
  requestId: 'post-mint-1',
});
assert.equal(mintedProvider.mode, 'conversation',
  'a server-minted provider thread without resume/stateful is not a claimed resume');
assert.notEqual(mintedProvider.mode, 'resumable');
const forked = resolveSessionIdentity({ providerSessionId: 'vendor-session', interactionId: 'fork-1', fork: true, scopeKey: 'scope-fixture' });
assert.equal(forked.parentSessionId, undefined,
  'a fork with only a child provider ID must not self-link its parent');
assert.equal(forked.reason, 'fork_without_parent');
assert.notEqual(forked.sessionId, resumed.sessionId);
const numericProvider = resolveSessionIdentity({ providerSessionId: '12345', scopeKey: 'scope-fixture' });
assert.equal(numericProvider.quality, 'confirmed', 'numeric provider IDs remain valid when explicitly typed');
const scopedOpaqueProvider = resolveSessionIdentity({
  providerSessionId: 'sess_' + 'a'.repeat(24),
  scopeKey: 'scope-fixture',
});
assert.notEqual(scopedOpaqueProvider.canonicalSessionId, scopedOpaqueProvider.sessionId,
  'a provider cannot forge a canonical Session by imitating the opaque ID shape');
const unscopedProvider = resolveSessionIdentity({ providerSessionId: 'same-provider-id' });
assert.equal(unscopedProvider.quality, 'ephemeral',
  'a provider ID without a stable namespace must not claim durable Session continuity');
assert.equal(unscopedProvider.mode, 'ephemeral');
assert.equal(unscopedProvider.canonicalSessionKey, undefined,
  'a provider session without a tenant/logical scope must not get a cross-tenant join key');
const unscopedForkA = resolveSessionIdentity({
  providerSessionId: 'same-provider-id', parentSessionId: 'same-parent', fork: true,
  interactionId: 'fork-a',
});
const unscopedForkB = resolveSessionIdentity({
  providerSessionId: 'same-provider-id', parentSessionId: 'same-parent', fork: true,
  interactionId: 'fork-b',
});
assert.equal(unscopedForkA.quality, 'ephemeral');
assert.equal(unscopedForkA.canonicalParentSessionId, undefined,
  'an unscoped native parent must remain unresolved rather than become event-specific lineage');
assert.equal(unscopedForkB.canonicalParentSessionId, undefined);
assert.notEqual(unscopedForkA.canonicalSessionId, unscopedForkB.canonicalSessionId,
  'unscoped fork children must be isolated by interaction');
const tenantAProvider = resolveSessionIdentity({
  providerSessionId: 'same-provider-id', namespaceHint: 'tenant-a|logical-a|source-a',
});
const tenantBProvider = resolveSessionIdentity({
  providerSessionId: 'same-provider-id', namespaceHint: 'tenant-b|logical-b|source-b',
});
assert.notEqual(tenantAProvider.canonicalSessionId, tenantBProvider.canonicalSessionId,
  'unscoped provider IDs must not produce cross-tenant canonical Session IDs');
assert.equal(
  tenantAProvider.canonicalSessionId,
  resolveSessionIdentity({ providerSessionId: 'same-provider-id', namespaceHint: 'tenant-a|logical-a|source-a' }).canonicalSessionId,
  'the same unresolved namespace should be deterministic within a process');
assert.match(tenantAProvider.providerSessionIdHash, /^[a-f0-9]{64}$/u);
assert.notEqual(
  deriveAgentInstanceIdentity({ logicalAgentId: 'logical-a', processGenerationKey: processA }).agentInstanceId,
  deriveAgentInstanceIdentity({ logicalAgentId: 'logical-a', processGenerationKey: processB }).agentInstanceId,
  'a new process generation must create a new functional AgentInstance');

const raw = rawObservationFromLine('{"event":{"Exec":{"pid":42}}}', {
  sourceId: 'source-a', collectorId: 'collector-a', sourceType: 'kernel', eventKind: 'Exec',
  eventAtUnixNs: '1788000000000000000', receivedAtUnixNs: '1788000000000001000',
});
assert.equal(validateRawObservation(raw).ok, true);
assert.equal(validateRawObservation({ ...raw, payload: { ...raw.payload, sha256: '0'.repeat(64) } }).ok, false);
let now = 10_000;
const store = new RawObservationStore({ maxEntries: 2, maxBytes: 100_000, ttlMs: 100, now: () => now });
assert.equal(store.append(raw).status, 'inserted');
assert.equal(store.append(raw).status, 'duplicate');
assert.equal(store.stats().duplicates, 1);

const request = { model: 'fixture', messages: [{ role: 'user', content: 'synthetic' }] };
const response = { choices: [{ message: { role: 'assistant', content: 'ok' } }] };
const body = (value) => {
  const serialized = JSON.stringify(value);
  return {
    body: serialized, encoding: 'utf8', contentType: 'application/json',
    capturedBytes: Buffer.byteLength(serialized), decodedBytes: Buffer.byteLength(serialized),
    sha256: digest(serialized), completeness: 'complete', structured: value,
  };
};
const line = JSON.stringify({
  rawObservation: raw,
  event: { LlmInteraction: {
    schemaVersion: 'anysentry.agent_interaction.v1', interactionId: 'mi_' + digest('parser').slice(0, 24),
    interactionType: 'model', connectionId: 'conn_fixture', transport: 'tls', protocol: 'http/1.1',
    endpoint: 'fixture.invalid', method: 'POST', path: '/v1/chat/completions', statusCode: 200,
    startedAtUnixNs: raw.eventAtUnixNs, requestCompleteAtUnixNs: raw.eventAtUnixNs,
    firstResponseAtUnixNs: raw.eventAtUnixNs, endedAtUnixNs: raw.eventAtUnixNs, durationNs: '1',
    timeQuality: 'collector_calibrated', request: body(request), response: body(response),
    toolCalls: [], toolResults: [], completeness: 'complete', partialReasons: [], captureSource: 'tls_uprobe',
  } },
});
const parsed = interactionParser.parseObserverAgentInteraction(line, {
  workspacePath: '/workspace/a', agentId: 'generic-agent', sessionId: 'container-abc', userId: 'synthetic',
  sessionIdentityQuality: 'ephemeral', sessionIdSource: 'legacy_agent_fallback',
  classificationSemantics: { schemaVersion: 'anysentry.classification_semantics.v1', identityClassification: 'confirmed_agent', workloadRole: 'agent', captureProfile: 'agent_full' },
  process: { hostId: 'host-a', bootId: 'boot-a', pid: 42, startTimeTicks: '100', comm: 'agent', exe: '/bin/agent' },
  attribution: { monitored: true, classification: 'confirmed_agent', confidence: 1, reason: 'authoritative_anchor', source: 'self_register', agentScopeId: 'generic-agent', agentInstanceId: 'runtime-a' },
});
assert.ok(parsed);
assert.equal(parsed.providerConversationId, undefined, 'runtime fallback must not become provider Conversation');
assert.equal(parsed.rawObservationId, raw.observationId);
assert.equal(parsed.sessionIdentityQuality, 'ephemeral',
  'exact runtime evidence without a provider anchor must remain ephemeral');
assert.equal(parsed.sessionIdSource, 'per_request',
  'runtime-only evidence must not retain legacy_agent_fallback as a durable Session source');
assert.equal(parsed.sessionMode, 'ephemeral');

const metadata = new AgentMetadataService(
  { loadAgentMetadata: async () => [], saveAgentMetadata: async () => true },
  { configured: () => false, initialize: async () => false, loadAgentMetadata: async () => [], saveAgentMetadata: async () => true },
);
const registered = metadata.update('generic-agent', {
  workspacePath: '/workspace/a', logicalAgentId: 'definition-alpha', logicalDefinitionId: 'app-alpha',
  logicalDefinitionType: 'registered', logicalScopeMode: 'registered_definition',
  tenantId: 'tenant-a', ownerId: 'owner-a', profile: 'default', profileVersion: '1',
  identityKeys: ['definition-alpha'],
});
assert.equal(registered.logicalAgentId, 'definition-alpha');
assert.equal(metadata.resolveRegisteredDefinition('/workspace/a', 'generic-agent')?.logicalAgentId, 'definition-alpha');

const pidOnlyRaw = rawObservationFromLine('{"event":{"ToolExec":{"pid":42}}}', {
  sourceId: 'source-a', collectorId: 'collector-a', sourceType: 'kernel', eventKind: 'ToolExec',
  processGenerationKey: 'pgk_' + 'a'.repeat(24), pid: 42, hostId: 'host-a', bootId: 'boot-a',
});
assert.equal(pidOnlyRaw.process, undefined,
  'a PID-only process generation must be downgraded out of the raw identity');
assert.equal(pidOnlyRaw.processGenerationKey, undefined,
  'a downgraded PID-only generation must not retain a top-level stable alias');
assert.equal(validateRawObservation({
  ...raw,
  processGenerationKey: 'pgk_' + 'a'.repeat(24),
  pid: 42,
  hostId: 'host-a',
  bootId: 'boot-a',
}).ok, false,
  'a manually supplied PID-only process generation must be rejected');

const providerSessionRequest = { conversation_id: 'provider-session-fixture', messages: [{ role: 'user', content: 'session' }] };
const providerSessionBody = body(providerSessionRequest);
const providerSessionLine = JSON.stringify({
  event: { LlmInteraction: {
    schemaVersion: 'anysentry.agent_interaction.v1', interactionId: 'mi_' + digest('provider-session').slice(0, 24),
    interactionType: 'model', connectionId: 'conn_provider-session', transport: 'http', protocol: 'http/1.1',
    endpoint: 'https://fixture-user:fixture-secret@fixture.invalid/v1/chat?token=fixture-secret#frag', method: 'POST', path: '/v1/chat/completions?token=fixture-secret', statusCode: 200,
    startedAtUnixNs: raw.eventAtUnixNs, requestCompleteAtUnixNs: raw.eventAtUnixNs,
    firstResponseAtUnixNs: raw.eventAtUnixNs, endedAtUnixNs: raw.eventAtUnixNs, durationNs: '1',
    timeQuality: 'collector_calibrated', request: providerSessionBody, response: body(response),
    toolCalls: [], toolResults: [], completeness: 'complete', partialReasons: [], captureSource: 'fixture',
  } },
});
const providerSessionParsed = interactionParser.parseObserverAgentInteraction(providerSessionLine, {
  workspacePath: '/workspace/a', agentId: 'generic-agent', sessionId: '', userId: 'synthetic',
  classificationSemantics: { schemaVersion: 'anysentry.classification_semantics.v1', identityClassification: 'confirmed_agent', workloadRole: 'agent', captureProfile: 'agent_full' },
  process: { hostId: 'host-a', bootId: 'boot-a', pid: 42, startTimeTicks: '100', comm: 'agent', exe: '/bin/agent' },
  attribution: { monitored: true, classification: 'confirmed_agent', confidence: 1, reason: 'authoritative_anchor', source: 'self_register', agentScopeId: 'generic-agent', agentInstanceId: 'runtime-a' },
});
assert.equal(providerSessionParsed?.providerConversationId, 'provider-session-fixture');
assert.equal(providerSessionParsed?.sessionId, 'provider-session-fixture',
  'provider conversation ID must populate the canonical Session when legacy meta has no session');
assert.equal(providerSessionParsed?.endpoint, 'https://fixture.invalid/v1/chat',
  'Observer-decoded endpoint metadata must drop URL userinfo/query/fragment');
assert.equal(providerSessionParsed?.path, '/v1/chat/completions',
  'Observer-decoded request paths must not retain query parameters');

// A real Observer-decoded provider anchor may upgrade the compatibility fallback only when the
// authenticated source supplies a stable namespace.  The source/workspace tuple is sufficient
// for a bounded local namespace, but the provider/native ID alone must remain event-ephemeral.
const scopedProviderSessionParsed = interactionParser.parseObserverAgentInteraction(providerSessionLine, {
  workspacePath: '/workspace/a', agentId: 'generic-agent', sessionId: 'container-abc', userId: 'synthetic',
  sessionIdentityQuality: 'ephemeral', sessionIdSource: 'legacy_agent_fallback',
  attributes: { sourceId: 'source-a' },
  classificationSemantics: { schemaVersion: 'anysentry.classification_semantics.v1', identityClassification: 'confirmed_agent', workloadRole: 'agent', captureProfile: 'agent_full' },
  process: { hostId: 'host-a', bootId: 'boot-a', pid: 42, startTimeTicks: '100', comm: 'agent', exe: '/bin/agent' },
  attribution: { monitored: true, classification: 'confirmed_agent', confidence: 1, reason: 'authoritative_anchor', source: 'self_register', agentScopeId: 'generic-agent', agentInstanceId: 'runtime-a' },
});
assert.equal(scopedProviderSessionParsed?.providerConversationId, 'provider-session-fixture');
assert.equal(scopedProviderSessionParsed?.sessionIdentityQuality, 'strong',
  'an authenticated source/workspace namespace must upgrade a real provider anchor to strong');
assert.equal(scopedProviderSessionParsed?.sessionMode, 'conversation',
  'Observer-extracted thread_id with a source/workspace namespace is continuity, not a claimed resume');
assert.equal(scopedProviderSessionParsed?.sessionIdSource, 'provider');

const candidateDecision = captureClassificationDecision('probable_agent');
assert.equal(candidateDecision.observed, 'probable_agent');
assert.equal(candidateDecision.effective, 'confirmed_agent');
assert.equal(candidateDecision.candidateAutoPromoted, true,
  'candidate capture defaults to confirmed fidelity without changing observed provenance');

// Parser/Adapter failure must not erase the machine lane. A malformed semantic extension still
// yields an immutable RawObservation, an independent KernelFact, and a visible CoverageGap.
const degradedService = new CanonicalObservabilityService();
const degraded = await degradedService.commitObserverLine(
  JSON.stringify({ rawObservation: { schemaVersion: 'invalid', payload: {} }, event: { ToolExec: { pid: 42 } } }),
  {
    sourceId: 'source-degraded',
    collectorId: 'collector-degraded',
    sourceType: 'kernel',
    eventKind: 'ToolExec',
    processGenerationKey: processA,
    pid: 42,
    ppid: 1,
    hostId: 'host-a',
    bootId: 'boot-a',
    startTimeTicks: '100',
  },
);
assert.equal(degraded.result.status, 'inserted');
assert(degraded.kernelFact, 'KernelFact must survive a parser failure');
assert(degradedService.kernelStats().entries >= 1);
assert(degradedService.gapStats().entries >= 1);
assert(degradedService.listGaps(20).some((gap) => gap.reason === 'parser_failed'));
degradedService.close();

// Coverage diagnostics are intentionally metadata-only.  A producer can place a credential in an
// innocuous key (`endpoint`, `peer`, `target`), so value-level URL/query/userinfo detection must
// hash it before the gap is exposed to API consumers.
const scopedGapService = new CanonicalObservabilityService();
scopedGapService.setSink({
  saveRawObservations: async () => false,
});
const firstStorage = rawObservationFromLine('{"event":{"Exec":{"pid":42}}}', {
  sourceId: 'source-a', collectorId: 'collector-a', sourceType: 'kernel', eventKind: 'Exec',
  eventAtUnixNs: '1788000000000000000', receivedAtUnixNs: '1788000000000001000',
});
const secondStorage = rawObservationFromLine('{"event":{"Exec":{"pid":43}}}', {
  sourceId: 'source-a', collectorId: 'collector-a', sourceType: 'kernel', eventKind: 'Exec',
  eventAtUnixNs: '1788000000000002000', receivedAtUnixNs: '1788000000000003000',
});
assert.notEqual(firstStorage.observationId, secondStorage.observationId);
await scopedGapService.commit(firstStorage);
await scopedGapService.commit(secondStorage);
const storageGaps = scopedGapService.listGaps(20).filter((gap) => gap.reason === 'storage_unavailable');
assert.equal(
  new Set(storageGaps.map((gap) => gap.gapId)).size,
  1,
  'storage gaps must collapse to source/collector, not one row per observationId',
);
assert.match(String(storageGaps.at(-1)?.scope), /source-a/);
scopedGapService.close();

assert.equal(
  asyncCommitLostGaps([{
    sourceId: 'source-a',
    collectorId: 'collector-a',
    clickhouseEventAtMs: 1_000,
    postgresEventAtMs: 999,
    commitBatchId: 'batch-a',
  }]).length,
  0,
  'async-commit slack must ignore sub-second ClickHouse/Postgres skew',
);
const lost = asyncCommitLostGaps([{
  sourceId: 'source-a',
  collectorId: 'collector-a',
  clickhouseEventAtMs: 5_000,
  postgresEventAtMs: 1_000,
  commitBatchId: 'batch-lost',
}]);
assert.equal(lost.length, 1);
assert.equal(lost[0].reason, 'async_commit_lost');
assert.equal(lost[0].details.coverage, 'partial');
assert.equal(lost[0].details.lostMs, 4_000);
assert.match(lost[0].scope, /source-a\/collector-a/);

const gapService = new CanonicalObservabilityService();
const sensitiveGap = gapService.recordGap(
  'transport',
  'unsupported_protocol',
  'fixture-endpoint',
  { endpoint: 'https://fixture-user:fixture-value@example.invalid/path?fixture_param=redacted', peer: 'api.example.invalid' },
);
assert.match(String(sensitiveGap.details?.endpoint), /^hash:[a-f0-9]{24}$/u,
  'URL-like coverage detail values must be hashed');
assert.equal(String(sensitiveGap.details?.endpoint).includes('fixture-value'), false,
  'coverage details must not retain URL userinfo/query secrets');
assert.equal(sensitiveGap.details?.peer, 'api.example.invalid',
  'ordinary bounded diagnostic values remain readable');
gapService.close();

// Forward/reverse canonical EvidenceLink lookups must work from the bounded hot store even when
// the compatibility PostgreSQL relation projector is absent.  Newer revisions supersede older
// rows for the same logical edge in forward reads; explicit link GETs can still request history.
const linkService = new CanonicalObservabilityService();
const linkBase = createEvidenceLink({
  fromType: 'tool_call',
  fromId: 'ti_canonical-fixture',
  toType: 'kernel_fact',
  toId: 'kf_canonical-fixture',
  relation: 'executes_as',
  method: 'process_generation',
  authority: 'inferred',
  evidenceRefs: ['se_canonicalfixture0000000000000000', 'evt_canonical-fixture'],
  status: 'strong',
  confidence: 0.8,
  validFromUnixNs: '1788000000000000000',
  resolutionRevision: 1,
});
const linkRevision = { ...linkBase, resolutionRevision: 2, status: 'ambiguous', confidence: 0 };
assert.equal((await linkService.commitEvidenceLinks([linkBase, linkRevision])).accepted, 2);
const byRef = await linkService.listDurableEvidenceLinksByEvidenceRef('se_canonicalfixture0000000000000000', 10);
assert.equal(byRef.length, 1, 'forward EvidenceLink lookup must collapse to the latest revision');
assert.equal(byRef[0].resolutionRevision, 2);
assert.equal(byRef[0].status, 'ambiguous');
const byTarget = await linkService.listDurableEvidenceLinksForTargetId('kf_canonical-fixture', 10);
assert.equal(byTarget.length, 1, 'reverse KernelFact lookup must retain the canonical link');
assert.equal(byTarget[0].linkId, linkBase.linkId);
linkService.close();

const degradedLinkService = new CanonicalObservabilityService();
await degradedLinkService.commitEvidenceLinks([linkBase]);
degradedLinkService.setSink({
  loadEvidenceLinks: async () => { throw new Error('synthetic store outage'); },
});
const degradedLinkRead = await degradedLinkService.readDurableEvidenceLinksForTargetId('kf_canonical-fixture', 10);
assert.equal(degradedLinkRead.degraded, true, 'canonical link sink failure must be surfaced as degraded');
assert.equal(degradedLinkRead.source, 'memory_hot_ring');
assert(degradedLinkRead.reasons.includes('canonical_evidence_link_projection_unavailable'));
degradedLinkService.close();

const unavailableLinkService = new CanonicalObservabilityService();
await unavailableLinkService.commitEvidenceLinks([linkBase]);
unavailableLinkService.setSink({
  loadEvidenceLinks: async () => [],
  isEvidenceLinksReadAvailable: () => false,
});
const unavailableLinkRead = await unavailableLinkService.readDurableEvidenceLinksForTargetId('kf_canonical-fixture', 10);
assert.equal(unavailableLinkRead.degraded, true, 'a sink that reports unavailable must degrade canonical reads');
assert(unavailableLinkRead.reasons.includes('canonical_evidence_link_projection_unavailable'));
unavailableLinkService.close();

console.log('canonical observability identity/session verification passed');
