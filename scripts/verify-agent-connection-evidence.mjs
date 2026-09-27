#!/usr/bin/env node

/**
 * Deterministic P1 checks: ConnectionIdentity bind fields ingest + emitted_by
 * EvidenceLink via connection_stream. Synthetic fixtures only.
 * Run `pnpm build:api` first.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  deriveConnectionIdentity,
  deriveProcessGenerationKey,
} = require('../apps/api/dist/security-monitoring/canonical-observability.js');
const {
  connectionIdentityFromInteraction,
  endpointFromNetworkFacts,
  linkLlmCallToNetworkFacts,
  networkFactFromSecurityEvent,
} = require('../apps/api/dist/security-monitoring/agent-connection-evidence.js');

const digest = (value) => createHash('sha256').update(value).digest('hex');
const nowNs = String(BigInt(Date.now()) * 1_000_000n);
const pgk = deriveProcessGenerationKey({
  hostId: 'host-p1',
  bootId: 'boot-p1',
  pid: 4242,
  startTimeTicks: '100',
});

const exact = deriveConnectionIdentity({
  processGenerationKey: pgk,
  socketCookie: 'abcd1234',
  fd: 17,
  fdGeneration: '3',
  tlsContextId: 'tlsctx_deadbeef',
  transport: 'websocket',
  sourceRefs: ['mi_test'],
});
assert.equal(exact?.quality, 'exact');
assert.equal(exact?.socketCookie, 'abcd1234');
assert.equal(exact?.fd, 17);

const interaction = {
  schemaVersion: 'anysentry.agent_interaction.v1',
  interactionId: `mi_${digest('p1-interaction').slice(0, 24)}`,
  interactionType: 'model',
  at: Date.now(),
  workspacePath: '/workspace',
  agentAssetId: 'aa_test',
  detectedClassification: 'confirmed_agent',
  currentEffectiveClassification: 'confirmed_agent',
  process: { pid: 4242, processGenerationKey: pgk },
  connectionId: 'tls:deadbeef',
  bindQuality: 'cookie',
  socketFd: 17,
  socketCookie: 'abcd1234',
  fdGeneration: '3',
  transport: 'tls',
  transportProtocol: 'websocket',
  protocol: 'websocket-json',
  endpoint: 'unknown',
  method: 'GET',
  path: '/backend-api/codex',
  statusCode: 101,
  startedAtUnixNs: nowNs,
  requestCompleteAtUnixNs: nowNs,
  firstResponseAtUnixNs: nowNs,
  endedAtUnixNs: nowNs,
  durationNs: '1',
  timeQuality: 'collector_calibrated',
  request: { body: '', encoding: 'utf8', contentType: 'application/json', capturedBytes: 0, decodedBytes: 0, sha256: digest('') },
  response: { body: '', encoding: 'utf8', contentType: 'application/json', capturedBytes: 0, decodedBytes: 0, sha256: digest('') },
  toolCalls: [],
  toolResults: [],
  completeness: 'complete',
  partialReasons: [],
  captureSource: 'tls',
  receivedAt: Date.now(),
};

const identity = connectionIdentityFromInteraction(interaction);
assert.ok(identity);
assert.equal(identity.quality, 'exact');
assert.equal(identity.fd, 17);
assert.equal(identity.socketCookie, 'abcd1234');

const egress = networkFactFromSecurityEvent({
  eventId: 'ev_egress_1',
  kernelFactId: 'kf_egress_1',
  eventKind: 'Egress',
  eventAtUnixNs: nowNs,
  process: { pid: 4242, processGenerationKey: pgk },
  attributes: {
    peer: '10.0.0.1',
    port: 443,
    fd: 17,
    fdGeneration: '3',
    sni: 'chatgpt.com',
  },
});
assert.ok(egress);
assert.equal(egress.fd, 17);
assert.equal(egress.sni, 'chatgpt.com');

const links = linkLlmCallToNetworkFacts({
  interaction: { ...interaction, connectionIdentity: identity },
  facts: [egress],
});
assert.equal(links.length, 1);
assert.equal(links[0].relation, 'emitted_by');
assert.equal(links[0].method, 'connection_stream');
assert.equal(links[0].toId, 'kf_egress_1');
assert.ok(links[0].confidence >= 0.95);
assert.ok(['confirmed', 'strong'].includes(links[0].status));

const endpoint = endpointFromNetworkFacts(links, [egress]);
assert.equal(endpoint, 'chatgpt.com');

const cookieMismatch = linkLlmCallToNetworkFacts({
  interaction: { ...interaction, connectionIdentity: identity },
  facts: [{ ...egress, fd: 99, socketCookie: 'zzzz', fdGeneration: '9' }],
});
assert.equal(cookieMismatch.length, 0, 'unrelated fd/cookie must not link');

const ambiguous = linkLlmCallToNetworkFacts({
  interaction: { ...interaction, connectionIdentity: identity },
  facts: [
    egress,
    { ...egress, eventId: 'ev_egress_2', kernelFactId: 'kf_egress_2' },
  ],
});
assert.equal(ambiguous.length, 2);
assert.ok(ambiguous.every((link) => link.status === 'ambiguous'));

console.log('verify-agent-connection-evidence: ok');
