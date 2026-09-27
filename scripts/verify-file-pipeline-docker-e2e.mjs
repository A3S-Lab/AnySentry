#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const baseUrl = (process.env.ANYSENTRY_API_BASE ?? 'http://127.0.0.1:29653/security-center').replace(/\/$/u, '');
const count = Math.max(16, Math.min(256, Number(process.env.ANYSENTRY_E2E_FILE_COUNT) || 128));
const runId = `file-e2e-${Date.now()}-${process.pid}`;
const collectorId = `${runId}-collector`;
const workspacePath = `/workspace/${runId}`;

async function request(pathname, method = 'GET', body, headers = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  let payload;
  try { payload = raw ? JSON.parse(raw) : undefined; } catch { payload = raw; }
  if (!response.ok) throw new Error(`${method} ${pathname} -> ${response.status}: ${raw}`);
  return payload?.data ?? payload;
}

const created = await request('/sources', 'POST', {
  name: `${runId} source`,
  type: 'observer',
  enabled: true,
  requireToken: true,
  collectorId,
  workspacePath,
  owner: 'verify-file-pipeline-docker-e2e',
  tags: [runId],
});
assert.ok(created.source?.sourceId && created.token, 'managed Observer source token is unavailable');

const events = Array.from({ length: count }, (_, index) => {
  const pid = 40_000 + index;
  const line = JSON.stringify({
    identity: { agent: 'file-e2e-agent', task: String(pid), session: `${runId}-container` },
    process: {
      host_id: 'modules-e2e-host',
      boot_id: 'modules-e2e-boot',
      pid,
      ppid: 1,
      start_time_ticks: String(100_000 + index),
      comm: 'file-e2e-agent',
      exe: '/usr/local/bin/file-e2e-agent',
      cgroup_id: '424242',
      cgroup: `0::/docker/${runId}-container`,
    },
    event: {
      FileAccess: {
        pid,
        path: `/tmp/${runId}-${index}.tmp`,
        write: true,
        repeat_count: index === 0 ? 10 : 1,
        first_event_at: new Date(Date.now() - 50).toISOString(),
        last_event_at: new Date().toISOString(),
        aggregation_window_ms: 100,
      },
    },
  });
  return {
    line,
    collectorId,
    sourceId: created.source.sourceId,
    sourceEventId: `${runId}-${index}`,
    workspacePath,
    agentId: 'file-e2e-agent',
    sessionId: runId,
    attribution: {
      monitored: true,
      classification: 'confirmed_agent',
      agentScopeId: 'file-e2e-agent',
      agentInstanceId: `${runId}-instance`,
      physicalWorkloadId: `docker:modules:${runId}-container`,
      confidence: 1,
      reason: 'authoritative_anchor',
      source: 'manual_review',
      evidence: ['e2e:confirmed-agent'],
    },
  };
});

const eventJson = JSON.stringify(events);
const payloadDigest = createHash('sha256').update(eventJson).digest('hex');
const batchId = `batch-${createHash('sha256').update(runId).digest('hex').slice(0, 24)}`;
const headers = {
  'x-anysentry-source-id': created.source.sourceId,
  'x-anysentry-ingest-token': created.token,
};
const ack = await request('/ingest/batch', 'POST', { batchId, payloadDigest, events }, headers);
assert.equal(ack.batchId, batchId);
assert.equal(ack.payloadDigest, payloadDigest);
assert.equal(ack.acceptedEvents, count);
assert.equal(ack.retainedEvents, count);
assert.equal(ack.rejectedEvents, 0);
assert.equal(ack.retryableEvents, 0);
assert.equal(ack.items.length, count);
assert.ok(ack.items.every((item, index) => item.index === index && item.disposition === 'retained'));

// Replaying the exact envelope must remain transport-successful and idempotent.
const replay = await request('/ingest/batch', 'POST', { batchId, payloadDigest, events }, headers);
assert.equal(replay.acceptedEvents, count);
assert.equal(replay.payloadDigest, payloadDigest);

const deadline = Date.now() + 20_000;
let stored;
while (Date.now() < deadline) {
  stored = await request('/events/list', 'POST', {
    timeType: 'last_1h',
    collectorId,
    workspacePath,
    scope: 'agent',
    limit: Math.min(500, count + 10),
  });
  if ((stored.items?.length ?? 0) >= count) break;
  await new Promise((resolve) => setTimeout(resolve, 250));
}
assert.ok((stored?.items?.length ?? 0) >= count, 'durable Agent events did not become queryable');

console.log(JSON.stringify({
  status: 'passed',
  runId,
  collectorId,
  sourceId: created.source.sourceId,
  batchId,
  payloadDigest,
  events: count,
  retainedEvents: ack.retainedEvents,
  replayAcceptedEvents: replay.acceptedEvents,
}, null, 2));
