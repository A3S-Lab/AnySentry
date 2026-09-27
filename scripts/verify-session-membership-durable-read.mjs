#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { CanonicalObservabilityService } = require('../apps/api/dist/security-monitoring/canonical-observability.service.js');
const { SecurityMonitoringController } = require('../apps/api/dist/security-monitoring/security-monitoring.controller.js');
const { RelationalBusinessStore } = require('../apps/api/dist/security-monitoring/relational-business-store.service.js');

const membership = {
  schemaVersion: 'anysentry.session_membership.v1',
  membershipId: 'sm_durable-read-fixture',
  sessionId: `sess_${'a'.repeat(24)}`,
  sessionKey: `sess_${'a'.repeat(24)}`,
  interactionId: 'mi_durable-read-fixture',
  role: 'conversation',
  confidence: 'confirmed',
  evidence: ['interaction-fixture'],
  resolverVersion: 'canonical-session-membership.v1',
  resolutionRevision: 1,
  validFromUnixNs: '1788000000000000000',
  sourceRefs: ['interaction-fixture'],
};

async function check({ sink, hot, latest = false, accept }) {
  const service = new CanonicalObservabilityService();
  try {
    if (hot) assert.equal(service.sessionMemberships.append(hot).status, 'inserted');
    service.setSink(sink);
    const controller = Object.create(SecurityMonitoringController.prototype);
    controller.canonicalObservability = service;
    // Read failure can occur after readiness was sampled. A healthy snapshot must not mask it.
    controller.relational = { configured: () => true, isReady: () => true };
    await accept(() => controller.canonicalSessionMembership(membership.membershipId, latest ? undefined : '1'));
  } finally {
    service.close();
  }
}

const partial = async (read) => {
  const result = await read();
  assert.equal(result.item.membershipId, membership.membershipId);
  assert.equal(result.coverage.status, 'partial', 'hot fallback is not proof of durable membership');
  assert.equal(result.dataSource, 'memory_hot_ring');
};
await check({ sink: { loadSessionMemberships: async () => [] }, hot: membership, accept: partial });
await check({ sink: undefined, hot: membership, accept: partial });
await check({ sink: { loadSessionMemberships: async () => { throw new Error('synthetic postgres temporarily unavailable'); } }, hot: membership, accept: partial });
await check({ sink: { loadSessionMemberships: async () => { throw new Error('synthetic postgres temporarily unavailable'); } }, accept: async (read) => {
  await assert.rejects(read, (error) => error.getStatus() === 503);
} });
await check({ sink: { loadSessionMemberships: async () => [] }, accept: async (read) => {
  await assert.rejects(read, (error) => error.getStatus() === 404);
} });
await check({ sink: { loadSessionMemberships: async (query) => {
  assert.deepEqual(query.membershipIds, [membership.membershipId]);
  assert.equal(query.resolutionRevision, 1);
  assert.equal(query.strictRead, true);
  assert.equal(query.limit, 1);
  return [membership];
} }, hot: { ...membership, resolutionRevision: 2 }, accept: async (read) => {
  const result = await read();
  assert.equal(result.item.resolutionRevision, 1, 'exact revision never falls through to a newer hot revision');
  assert.equal(result.coverage.status, 'complete');
  assert.equal(result.dataSource, 'canonical_session_membership_store');
} });
await check({ sink: { loadSessionMemberships: async () => [membership] }, hot: { ...membership, resolutionRevision: 2 }, latest: true, accept: partial });

// The relational reader historically returns [] on failures for compatibility. Point reads
// opt in to failure propagation so the controller can distinguish unavailable from missing.
const store = Object.create(RelationalBusinessStore.prototype);
store.initialize = async () => false;
await assert.rejects(() => store.loadSessionMemberships({ strictRead: true }));
assert.deepEqual(await store.loadSessionMemberships(), []);
store.initialize = async () => true;
store.pool = { query: async () => { throw new Error('synthetic query failure'); } };
store.markUnavailable = () => {};
await assert.rejects(() => store.loadSessionMemberships({ strictRead: true }));
assert.deepEqual(await store.loadSessionMemberships(), []);

console.log('PASS membership durable point reads, exact revisions, hot fallback and outage coverage');
