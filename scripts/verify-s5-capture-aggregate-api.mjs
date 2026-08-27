#!/usr/bin/env node

import assert from 'node:assert/strict';
import { managementAuthHeaders, safeProbeId } from './probe-id.mjs';

const baseUrl = (
  process.env.ANYSENTRY_API_BASE ??
  process.env.API_BASE ??
  `http://127.0.0.1:${process.env.PORT ?? '29653'}/security-center`
).replace(/\/$/u, '');
const runId = safeProbeId('s5-aggregate-api');
const collectorId = `${runId}-collector`;

async function request(path, method = 'GET', body, headers = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...managementAuthHeaders(), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  let payload;
  try { payload = raw ? JSON.parse(raw) : undefined; } catch { payload = raw; }
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}: ${raw}`);
  return payload?.data ?? payload;
}

const source = await request('/sources', 'POST', {
  name: `${runId} Observer`,
  type: 'observer',
  enabled: true,
  requireToken: true,
  collectorId,
  owner: 'verify-s5-capture-aggregate-api',
  tags: [runId, 'capture-aggregate'],
});
assert(source.source?.sourceId && source.token, 'managed Observer Source returns a token');

const summary = {
  windowStartUnixNs: '1777000000000000000',
  windowEndUnixNs: '1777000001000000000',
  cgroupId: '4242',
  probe: 'file_access',
  effectiveAction: 'aggregate',
  qualifier: 1,
  profile: 'infrastructure_aggregate',
  epoch: 7001,
  policyVersion: 7,
  count: 123,
  bytes: 4096,
  authority: 'authoritative',
  reason: 'platform_infrastructure',
  terminal: false,
};
const line = JSON.stringify({
  identity: { agent: null, task: null, session: 'infra-container' },
  process: { host_id: 'node-a', boot_id: 'boot-a', cgroup_id: summary.cgroupId },
  event: { CaptureAggregate: summary },
});
const event = {
  line,
  sourceEventId: `${runId}-summary`,
  collectorId,
  nodeName: 'node-a',
  sourceType: 'observer',
  eventCategory: 'runtime',
  attributes: {
    captureAggregate: true,
    captureWindowStartUnixNs: summary.windowStartUnixNs,
    captureWindowEndUnixNs: summary.windowEndUnixNs,
    captureCgroupId: summary.cgroupId,
    captureProbe: summary.probe,
    captureEffectiveAction: summary.effectiveAction,
    captureQualifier: summary.qualifier,
    captureProfile: summary.profile,
    captureEpoch: summary.epoch,
    capturePolicyVersion: summary.policyVersion,
    captureCount: summary.count,
    captureBytes: summary.bytes,
    captureAuthority: summary.authority,
    captureReason: summary.reason,
    captureTerminal: summary.terminal,
  },
};

const anonymous = await request('/ingest/batch', 'POST', { events: [event] });
assert.equal(anonymous.acceptedEvents, 0, 'anonymous CaptureAggregate is not accepted');
assert.equal(anonymous.rejectedEvents, 1);
assert.equal(anonymous.items[0].reasonCode, 'source_rejected');

const accepted = await request('/ingest/batch', 'POST', { events: [event] }, {
  'x-anysentry-source-id': source.source.sourceId,
  'x-anysentry-ingest-token': source.token,
});
assert.equal(accepted.acceptedEvents, 1);
assert.equal(accepted.retainedEvents, 1);
assert.equal(accepted.rejectedEvents, 0);
assert(accepted.items[0].eventId);

const deadline = Date.now() + 5_000;
let stored;
do {
  const listed = await request('/events/list', 'POST', {
    timeType: 'last_30d',
    scope: 'raw',
    includeUnknown: true,
    noise: 'include',
    eventId: accepted.items[0].eventId,
    limit: 1,
  });
  stored = listed.items?.[0];
  if (stored) break;
  await new Promise((resolve) => setTimeout(resolve, 50));
} while (Date.now() < deadline);

assert(stored, 'retained CaptureAggregate is queryable');
assert.equal(stored.eventKind, 'CaptureAggregate');
assert.equal(stored.eventCategory, 'runtime');
assert.equal(stored.verdict, 'allow');
assert.equal(stored.attributes.captureAggregate, true);
assert.equal(stored.attributes.captureProbe, 'file_access');
assert.equal(stored.attributes.captureEffectiveAction, 'aggregate');
assert.equal(stored.attributes.captureCount, 123);
assert.equal(stored.attributes.captureBytes, 4096);
assert.equal(stored.attributes.captureEpoch, 7001);
assert.equal(stored.attributes.capturePolicyVersion, 7);

console.log('S5 trusted CaptureAggregate API E2E passed');
