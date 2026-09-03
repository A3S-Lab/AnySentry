#!/usr/bin/env node

/**
 * Deterministic contract-level checks for the additive canonical observability seam.
 *
 * This script uses synthetic, non-sensitive values only. It does not contact an API, start a
 * workload, or write a repository artifact. Build the API first so the compiled contract module
 * is available under apps/api/dist.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const canonical = require('../apps/api/dist/security-monitoring/canonical-observability.js');
const { CanonicalObservabilityService } = require(
  '../apps/api/dist/security-monitoring/canonical-observability.service.js',
);

const {
  CANONICAL_SCHEMA_VERSIONS,
  RawObservationStore,
  SessionMembershipStore,
  deriveConnectionIdentity,
  validateConnectionIdentity,
  deriveProcessGenerationKey,
  rawObservationFromLine,
  resolveLogicalAgentDefinition,
  resolveSessionIdentity,
  canonicalParentSessionIdForMembership,
  trustedCanonicalSessionId,
  createEvidenceLink,
  createRelationRevision,
  validateCanonicalContract,
  validateRelationRevision,
  validateEvidenceLink,
  validateCoverageGap,
  validateRawObservation,
  validateLogicalAgentDefinition,
  validateSessionMembership,
} = canonical;

const hash = (value) => createHash('sha256').update(value).digest('hex');

const explicitA = resolveLogicalAgentDefinition({
  logicalAgentId: 'registered-codex-definition',
  family: 'codex',
  tenantId: 'tenant-a',
  ownerId: 'owner-a',
  workspacePath: '/workspace/project',
  profile: 'default',
  terminalContextId: 'terminal-a',
});
const envDefinition = resolveLogicalAgentDefinition({
  logicalAgentId: 'registered-workflow-definition',
  family: 'dify',
  tenantId: 'tenant-a',
  workspacePath: '/workspace/project',
  definitionId: 'workflow-a',
  definitionType: 'workflow',
  logicalScopeMode: 'workflow_definition',
  environmentId: 'production',
});
assert.equal(validateLogicalAgentDefinition(envDefinition.definition).ok, true);
assert.equal(validateLogicalAgentDefinition(envDefinition.definition).value.environmentId, 'production');
const explicitB = resolveLogicalAgentDefinition({
  logicalAgentId: 'registered-codex-definition',
  family: 'codex',
  tenantId: 'tenant-a',
  ownerId: 'owner-a',
  workspacePath: '/workspace/project',
  profile: 'default',
  terminalContextId: 'terminal-b',
});
assert.equal(explicitA.stable, true);
assert.equal(explicitA.logicalScopeKey, explicitB.logicalScopeKey,
  'terminal context must not split a registered definition by default');

const terminalA = resolveLogicalAgentDefinition({
  ...explicitA.definition,
  logicalAgentId: 'registered-codex-definition',
  logicalScopeMode: 'terminal',
  terminalContextId: 'terminal-a',
});
const terminalB = resolveLogicalAgentDefinition({
  ...explicitB.definition,
  logicalAgentId: 'registered-codex-definition',
  logicalScopeMode: 'terminal',
  terminalContextId: 'terminal-b',
});
assert.notEqual(terminalA.logicalScopeKey, terminalB.logicalScopeKey,
  'explicit terminal scope must split runtime definitions');
assert.notEqual(terminalA.definition.logicalAgentId, terminalB.definition.logicalAgentId,
  'terminal-scoped directory identities must be distinct');
const invalidTerminal = resolveLogicalAgentDefinition({
  logicalAgentId: 'registered-codex-definition',
  family: 'codex',
  logicalScopeMode: 'terminal',
});
assert.equal(invalidTerminal.stable, false,
  'terminal scope without a terminal context must remain unresolved');

const workflowA = resolveLogicalAgentDefinition({
  family: 'dify',
  tenantId: 'tenant-a',
  definitionId: 'workflow-1',
  definitionType: 'workflow',
  workspacePath: '/srv/dify',
  profile: 'production',
});
const workflowB = resolveLogicalAgentDefinition({
  family: 'dify',
  tenantId: 'tenant-a',
  definitionId: 'workflow-2',
  definitionType: 'workflow',
  workspacePath: '/srv/dify',
  profile: 'production',
});
assert.notEqual(workflowA.logicalScopeKey, workflowB.logicalScopeKey,
  'different workflow definitions must not merge');

const unresolved = resolveLogicalAgentDefinition({ family: 'unknown-cli', product: 'unknown-cli' });
assert.equal(unresolved.stable, false);
assert.equal(unresolved.definition.identityQuality, 'unresolved');
assert.match(unresolved.logicalScopeKey, /^candidate:lac_[a-f0-9]{24}$/u);

const processKey = deriveProcessGenerationKey({
  hostId: 'host-a', bootId: 'boot-a', pid: 42, startTimeTicks: '1000',
});
assert.match(processKey, /^pgk_[a-f0-9]{24}$/u);
assert.notEqual(processKey, deriveProcessGenerationKey({
  hostId: 'host-a', bootId: 'boot-a', pid: 42, startTimeTicks: '1001',
}), 'a restarted PID must receive a new generation');
const connection = deriveConnectionIdentity({
  processGenerationKey: processKey,
  socketCookie: 'socket-1',
  transport: 'tls',
  streamId: 'stream-1',
  sourceRefs: ['raw-1'],
});
assert.match(connection.connectionId, /^conn_[a-f0-9]{24}$/u);
assert.equal(connection.quality, 'exact');
assert.equal(validateConnectionIdentity(connection).ok, true);
const derivedConnection = deriveConnectionIdentity({ processGenerationKey: processKey, transport: 'tcp' });
assert.equal(validateConnectionIdentity(derivedConnection).ok, true,
  'a connection without an explicit raw ref retains a derived provenance marker');

const ephemeral = resolveSessionIdentity({
  serviceStateful: false,
  requestId: 'request-1',
  runtimeSessionId: 'container-id-must-not-be-provider-session',
});
assert.equal(ephemeral.quality, 'ephemeral');
assert.equal(ephemeral.mode, 'per_request');
assert.equal(ephemeral.providerSessionId, undefined);
const fork = resolveSessionIdentity({
  providerSessionId: 'vendor-session', interactionId: 'interaction-1', fork: true,
  scopeKey: 'scope-fixture',
});
assert.equal(fork.quality, 'confirmed');
assert.equal(fork.parentSessionId, undefined,
  'a fork with only a child provider ID must not self-link parentSessionId');
assert.equal(fork.reason, 'fork_without_parent');
assert.notEqual(fork.sessionId, 'vendor-session');
const scopedOpaqueProvider = resolveSessionIdentity({
  providerSessionId: 'sess_' + 'a'.repeat(24),
  scopeKey: 'scope-fixture',
});
assert.notEqual(scopedOpaqueProvider.canonicalSessionId, scopedOpaqueProvider.sessionId,
  'a provider cannot forge a canonical Session by imitating the opaque ID shape inside a trusted scope');
const unscopedNamespaceA = resolveSessionIdentity({
  providerSessionId: 'same-provider',
  namespaceHint: 'tenant-a\0workspace-a\0source-a',
});
const unscopedNamespaceB = resolveSessionIdentity({
  providerSessionId: 'same-provider',
  namespaceHint: 'tenant-a\0workspace-a\0source-a',
});
assert.equal(unscopedNamespaceA.canonicalSessionId, unscopedNamespaceB.canonicalSessionId,
  'NUL-delimited namespace hints must remain deterministic after sanitization');
assert.notEqual(unscopedNamespaceA.canonicalSessionId, resolveSessionIdentity({
  providerSessionId: 'same-provider',
  namespaceHint: 'tenant-b\0workspace-a\0source-a',
}).canonicalSessionId);
assert.equal(canonicalParentSessionIdForMembership('native-parent', undefined), undefined,
  'a compatibility parent without a stable namespace must stay unresolved');
assert.equal(canonicalParentSessionIdForMembership('sess_' + 'b'.repeat(24)), undefined,
  'an opaque-looking producer parent must not bypass the namespace fence');
const rehashedOpaqueParent = canonicalParentSessionIdForMembership('sess_' + 'b'.repeat(24), 'scope-fixture');
assert.match(rehashedOpaqueParent, /^sess_[a-f0-9]{24}$/u);
assert.notEqual(
  rehashedOpaqueParent,
  'sess_' + 'b'.repeat(24),
  'an opaque-looking provider parent is still HMAC-derived inside a trusted namespace',
);
assert.equal(trustedCanonicalSessionId('sess_' + 'b'.repeat(24)), 'sess_' + 'b'.repeat(24));
const parentMembership = validateSessionMembership({
  schemaVersion: 'anysentry.session_membership.v1',
  membershipId: 'sm_parent-fixture',
  sessionId: 'sess_' + 'a'.repeat(24),
  sessionKey: 'sess_' + 'a'.repeat(24),
  parentSessionId: 'sess_' + 'b'.repeat(24),
  canonicalParentSessionId: 'sess_' + 'b'.repeat(24),
  role: 'conversation',
  confidence: 'confirmed',
  evidence: ['interaction-parent-fixture'],
  resolverVersion: 'canonical-session-membership.v1',
  resolutionRevision: 1,
  validFromUnixNs: '1788000000000000000',
  sourceRefs: ['interaction-parent-fixture'],
});
assert.equal(parentMembership.ok, true);
assert.equal(parentMembership.value.canonicalParentSessionId, 'sess_' + 'b'.repeat(24));
const derivedMetadataMembership = validateSessionMembership({
  schemaVersion: 'anysentry.session_membership.v1',
  membershipId: 'sm_derived-metadata-fixture',
  sessionId: 'sess_' + 'c'.repeat(24),
  role: 'derived_metadata',
  confidence: 'unresolved',
  evidence: ['interaction-derived-metadata-fixture'],
  resolverVersion: 'canonical-session-membership.v1',
  resolutionRevision: 1,
  validFromUnixNs: '1788000000000000000',
  sourceRefs: ['interaction-derived-metadata-fixture'],
});
assert.equal(derivedMetadataMembership.ok, true,
  'technical/derived metadata roles remain representable in the canonical Session contract');
const unscopedForkA = resolveSessionIdentity({
  providerSessionId: 'same-provider', parentSessionId: 'native-parent', fork: true,
  interactionId: 'fork-a',
});
const unscopedForkB = resolveSessionIdentity({
  providerSessionId: 'same-provider', parentSessionId: 'native-parent', fork: true,
  interactionId: 'fork-b',
});
assert.equal(unscopedForkA.quality, 'ephemeral');
assert.equal(unscopedForkA.canonicalParentSessionId, undefined);
assert.equal(unscopedForkB.canonicalParentSessionId, undefined);
assert.notEqual(unscopedForkA.canonicalSessionId, unscopedForkB.canonicalSessionId,
  'without a stable namespace, fork lineage is retained as unresolved evidence only');
assert.notEqual(
  resolveSessionIdentity({ providerSessionId: 'sess_' + 'c'.repeat(24), interactionId: 'fork-a' }).canonicalSessionId,
  resolveSessionIdentity({ providerSessionId: 'sess_' + 'c'.repeat(24), interactionId: 'fork-b' }).canonicalSessionId,
  'opaque-looking provider IDs remain event-scoped without a trusted namespace',
);
const parentOnlyFork = resolveSessionIdentity({
  fork: true,
  parentSessionId: 'native-parent-only',
  interactionId: 'parent-only-fork',
  scopeKey: 'scope-fixture',
});
assert.equal(parentOnlyFork.lifecycle, 'fork');
assert.equal(parentOnlyFork.parentSessionId, 'native-parent-only');
assert.notEqual(parentOnlyFork.sessionId, parentOnlyFork.parentSessionId,
  'a fork signal with only a parent must derive a distinct child Session');
assert.notEqual(parentOnlyFork.canonicalSessionId, parentOnlyFork.canonicalParentSessionId);
const childWithoutParent = resolveSessionIdentity({
  providerSessionId: 'native-child-only', fork: true, scopeKey: 'scope-fixture',
});
assert.equal(childWithoutParent.lifecycle, 'fork');
assert.equal(childWithoutParent.parentSessionId, undefined,
  'a malformed fork without a parent must not self-link the child');
assert.equal(childWithoutParent.reason, 'fork_without_parent');

const raw = rawObservationFromLine('{"event":{"ToolExec":{"pid":42}}}', {
  sourceId: 'source-a', collectorId: 'collector-a', sourceType: 'kernel', eventKind: 'ToolExec',
  eventAtUnixNs: '1788000000000000000', receivedAtUnixNs: '1788000000000001000',
});
assert.equal(raw.schemaVersion, CANONICAL_SCHEMA_VERSIONS.rawObservation);
assert.equal(raw.source.sourceType, 'kernel');
assert.equal(validateRawObservation(raw).ok, true);
const nsProcessKey = deriveProcessGenerationKey({
  hostId: 'host-ns', bootId: 'boot-ns', pid: 43, startTimeNs: '1788000000000000123',
});
const nsRaw = rawObservationFromLine('{"event":{"Exec":{"pid":43}}}', {
  sourceId: 'source-ns', sourceType: 'kernel', eventKind: 'Exec',
  processGenerationKey: nsProcessKey, pid: 43, hostId: 'host-ns', bootId: 'boot-ns',
  startTimeNs: '1788000000000000123',
  eventAtUnixNs: '1788000000000000200', receivedAtUnixNs: '1788000000000000300',
});
assert.equal(validateRawObservation(nsRaw).ok, true,
  'a nanosecond process start marker is a valid alternative to Linux start ticks');
const conflictingConnection = {
  ...raw,
  process: {
    processGenerationKey: processKey,
    pid: 42,
    hostId: 'host-a',
    bootId: 'boot-a',
    startTimeTicks: '1000',
    firstSeenAtUnixNs: raw.eventAtUnixNs,
    sourceRefs: [raw.observationId],
  },
  connection: connection,
  connectionIdentity: { ...connection, streamId: 'different-stream' },
};
assert.equal(validateRawObservation(conflictingConnection).ok, false,
  'connection compatibility aliases cannot silently select one conflicting identity');
const processWithExitBeforeStart = {
  ...raw.process,
  exitedAtUnixNs: '1787999999999999000',
};
assert.equal(validateRawObservation({
  ...raw,
  process: processWithExitBeforeStart,
}).ok, false, 'a process exit before first observation is invalid');
assert.equal(validateRawObservation({ ...raw, payload: { ...raw.payload, sha256: '0'.repeat(64) } }).ok, false);

let now = 1_000;
const store = new RawObservationStore({ maxEntries: 2, maxBytes: 100_000, ttlMs: 100, now: () => now });
assert.equal(store.commit(raw).status, 'inserted');
assert.equal(store.commit(raw).status, 'duplicate');
assert.equal(store.commit({ ...raw, idempotencyKey: 'different', payload: { ...raw.payload, sha256: hash('different') } }).status, 'conflict');
const lateRevision = {
  ...raw,
  revision: 2,
  eventAtUnixNs: '1788000000000000003',
  receivedAtUnixNs: '1788000000000001003',
  payload: { ...raw.payload, sha256: hash('late-revision'), payloadRef: `sha256:${hash('late-revision')}` },
  idempotencyKey: raw.idempotencyKey,
};
assert.equal(store.commit(lateRevision).status, 'inserted',
  'the same transport idempotency key may carry an append-only later revision');
assert.equal(store.get(raw.observationId, 2)?.revision, 2);
const second = rawObservationFromLine('{"event":{"FileAccess":{"path":"/tmp/a"}}}', {
  sourceId: 'source-a', sourceType: 'kernel', eventKind: 'FileAccess',
  eventAtUnixNs: '1788000000000000001', receivedAtUnixNs: '1788000000000001001',
});
const third = rawObservationFromLine('{"event":{"FileAccess":{"path":"/tmp/b"}}}', {
  sourceId: 'source-a', sourceType: 'kernel', eventKind: 'FileAccess',
  eventAtUnixNs: '1788000000000000002', receivedAtUnixNs: '1788000000000001002',
});
assert.equal(store.commit(second).status, 'inserted');
assert.equal(store.commit(third).status, 'inserted');
assert.equal(store.stats().evicted, 2);
now += 101;
assert.equal(store.list().length, 0, 'TTL must expire bounded raw facts');
store.close();
assert.equal(store.stats().closed, true);

const service = new CanonicalObservabilityService();
const committed = await service.commitObserverLine(
  '{"event":{"SecurityAction":{"pid":42,"kind":"ptrace"}}}',
  {
    sourceId: 'source-a',
    collectorId: 'collector-a',
    sourceType: 'kernel',
    eventKind: 'SecurityAction',
    eventAtUnixNs: '1788000000000000100',
    receivedAtUnixNs: '1788000000000000200',
    processGenerationKey: processKey,
    pid: 42,
    hostId: 'host-a',
    bootId: 'boot-a',
    startTimeTicks: '1000',
  },
);
assert.equal(committed.result.status, 'inserted');
assert(committed.observation);
assert.equal(committed.observation.payload.body, undefined,
  'canonical raw lane must not retain an unprotected line body');
assert.equal(service.list().length, 1);
assert.equal(service.kernelFacts().length, 1,
  'kernel fact must remain available alongside the raw observation');
assert.equal(service.listGaps().length, 0);
service.close();

const relation = createEvidenceLink({
  fromType: 'tool_call',
  fromId: 'tool-fixture',
  toType: 'kernel_fact',
  toId: 'fact-fixture',
  relation: 'executes_as',
  method: 'process_generation',
  confidence: 0.98,
  authority: 'attested_observer',
  evidenceRefs: ['raw-fixture'],
  validFromUnixNs: '1788000000000000300',
});
const relationRevision = createRelationRevision({
  relation,
  revision: 1,
  decidedAtUnixNs: '1788000000000000400',
  sourceRefs: ['raw-fixture'],
});
assert.equal(validateRelationRevision(relationRevision).ok, true);
const relationRevisionTwo = createEvidenceLink({
  ...relation,
  resolutionRevision: 2,
});
assert.equal(relationRevisionTwo.linkId, relation.linkId,
  'late relation revisions must retain the logical EvidenceLink identity');
assert.equal(validateRelationRevision({
  ...relationRevision,
  revision: 2,
}).ok, false, 'outer relation revision must match nested EvidenceLink revision');
const noEvidenceRelation = createEvidenceLink({
  fromType: 'tool_call', fromId: 'tool-without-evidence', toType: 'kernel_fact',
  toId: 'unmatched-fact', relation: 'supports', method: 'none', validFromUnixNs: '1788000000000000500',
});
assert.deepEqual(noEvidenceRelation.evidenceRefs, ['no_evidence']);
assert.equal(noEvidenceRelation.status, 'coverage_gap');
assert.equal(validateEvidenceLink(noEvidenceRelation).ok, true);
const sessionMembership = {
  schemaVersion: CANONICAL_SCHEMA_VERSIONS.sessionMembership,
  membershipId: 'sm_fixture_membership',
  sessionId: 'sess_fixture_canonical',
  sessionKey: 'sess_' + 'a'.repeat(24),
  role: 'conversation',
  confidence: 'confirmed',
  evidence: ['interaction-fixture'],
  resolverVersion: 'canonical-session-membership.v1',
  resolutionRevision: 1,
  validFromUnixNs: '1788000000000000550',
  sourceRefs: ['interaction-fixture'],
};
assert.equal(validateCanonicalContract(sessionMembership).ok, true);
const membershipStore = new SessionMembershipStore({ maxEntries: 2, maxBytes: 100_000 });
assert.equal(membershipStore.append(sessionMembership).status, 'inserted');
assert.equal(membershipStore.append(sessionMembership).status, 'duplicate');
assert.equal(membershipStore.get('sm_fixture_membership')?.sessionKey, sessionMembership.sessionKey);
membershipStore.close();
const reversedGap = {
  schemaVersion: CANONICAL_SCHEMA_VERSIONS.coverageGap,
  gapId: 'gap-reversed', stage: 'transport', reason: 'timeout', scope: 'fixture', sourceRefs: ['raw-fixture'],
  firstSeenAtUnixNs: '1788000000000000600', lastSeenAtUnixNs: '1788000000000000500',
  droppedCount: 0, orphanedCount: 0, revision: 1,
};
assert.equal(validateCoverageGap(reversedGap).ok, false,
  'coverage windows must be monotonic');
const durableRaw = [];
const durableFacts = [];
const durableService = new CanonicalObservabilityService();
durableService.setSink({
  async saveRawObservations(items) { durableRaw.push(...items); return true; },
  async loadRawObservations() { return durableRaw; },
  async saveKernelFacts(items) { durableFacts.push(...items); return true; },
  async loadKernelFacts() { return durableFacts; },
});
const durableCommit = await durableService.commitObserverLine(
  '{"event":{"ToolExec":{"pid":42,"argv":["printf","fixture"]}}}',
  {
    sourceId: 'source-a',
    collectorId: 'collector-a',
    sourceType: 'kernel',
    eventKind: 'ToolExec',
    eventAtUnixNs: '1788000000000000500',
    receivedAtUnixNs: '1788000000000000600',
    processGenerationKey: processKey,
    pid: 42,
    hostId: 'host-a',
    bootId: 'boot-a',
  },
);
assert.equal(durableCommit.durable, true);
assert.equal(durableRaw.length, 1);
assert.equal(durableFacts.length, 1);
assert.equal((await durableService.listDurableKernelFacts()).length, 1);
durableService.close();

console.log('canonical observability contract verification passed');
