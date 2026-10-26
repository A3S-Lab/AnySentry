#!/usr/bin/env node

import assert from 'node:assert/strict';
import { ClickHouseStore } from '../apps/api/dist/security-monitoring/clickhouse-store.js';
import { canonicalProcessLifecycleIdentity } from '../apps/api/dist/security-monitoring/process-lifecycle.js';
import { UosSystemEvidenceService } from '../apps/api/dist/security-monitoring/uos-system-evidence.service.js';

const conversationId = 'uosconv:sess_uos_system_evidence';
const nativeSessionId = 'sess_uos_system_evidence';
const interactionAt = Date.now() - 2_000;
const observedProcess = {
  hostId: 'host-uos-test',
  bootId: 'boot-uos-test',
  pid: 4242,
  ppid: 4000,
  pidNamespace: '4026532999',
  namespacePid: 42,
  startTimeTicks: '987654',
  processGenerationKey: 'pgk_uos_test_generation',
  comm: 'python',
  exe: '/usr/bin/python3',
};
const bindingProcessInstanceKey = canonicalProcessLifecycleIdentity(observedProcess).processInstanceKey;

function interaction(overrides = {}) {
  const row = {
    schemaVersion: 'anysentry.agent_interaction.v1',
    interactionId: 'mi_uos_system_evidence',
    at: interactionAt,
    sessionId: nativeSessionId,
    agentInstanceId: 'agent-uos-test',
    method: 'POST',
    path: '/v1/chat/completions',
    startedAtUnixNs: String(BigInt(interactionAt - 500) * 1_000_000n),
    process: observedProcess,
    ...overrides,
  };
  return {
    interactionId: row.interactionId,
    sessionId: row.sessionId,
    agentInstanceId: row.agentInstanceId,
    at: row.at,
    payload: JSON.stringify(row),
  };
}

function kernelEvent(eventId, at, overrides = {}) {
  return {
    eventId,
    at,
    eventKind: 'ToolExec',
    eventCategory: 'process',
    subject: 'exec /bin/ls',
    process: observedProcess,
    processInstanceKey: 'pri_original_from_events',
    attributes: { command: '/bin/ls' },
    attribution: {
      parentProcessGenerationKey: 'pgk_exact_parent',
      parentLinkAuthority: 'forwarder_process_graph',
    },
    verdict: 'allow',
    tier: 'Rules',
    severity: 'info',
    riskScore: 0,
    decisionRevision: 1,
    traceId: 'trace-uos-test',
    spanId: 'span-uos-test',
    ...overrides,
  };
}

function fixture(rows, events, statsResult = { totalEvents: events?.length ?? 0 }) {
  const calls = { interactions: [], searches: [], stats: [] };
  const clickhouse = {
    async queryAgentInteractionPayloads(input) {
      calls.interactions.push(input);
      return rows;
    },
    async searchEvents(input) {
      calls.searches.push(input);
      if (events === null) return null;
      return [...events].sort((a, b) => b.at - a.at).slice(0, input.limit);
    },
    async readUosProcessGenerationEventStats(input) {
      calls.stats.push(input);
      return typeof statsResult === 'function' ? statsResult() : statsResult;
    },
  };
  return { calls, service: new UosSystemEvidenceService(clickhouse) };
}

function assertEmpty(evidence) {
  assert.equal(evidence.schemaVersion, 'anysentry.local-session-system-evidence.v1');
  assert.equal(evidence.completeness, 'unavailable');
  assert.deepEqual(evidence.counts, {
    direct: 0, lineage: 0, ambiguous: 0, conflict: 0, unattributed: 0,
  });
  assert.deepEqual(evidence.events, []);
  assert.deepEqual(evidence.lineage, []);
  assert.deepEqual(evidence.exceptions, []);
  assert.equal(evidence.page.totalRelations, 0);
  assert.equal(evidence.page.hasMore, false);
}

const events = [
  kernelEvent('evt_exec', interactionAt - 100, { command: '/bin/ls' }),
  kernelEvent('evt_egress', interactionAt - 50, {
    eventKind: 'Egress',
    eventCategory: 'network',
    subject: 'Egress',
    attributes: { ip: '192.0.2.10', port: '18890' },
  }),
];

{
  const { calls, service } = fixture([interaction()], events);
  const evidence = await service.evidence(conversationId);
  assert.equal(evidence.binding.nativeSessionId, nativeSessionId);
  assert.equal(evidence.binding.method, 'observer_request');
  assert.equal(evidence.binding.matchedPid, observedProcess.pid);
  assert.equal(evidence.binding.matchedOsProcessInstanceKey, bindingProcessInstanceKey);
  assert.equal(evidence.binding.confidence, 1);
  assert.equal(evidence.evidenceScope, 'current_generation');
  assert.equal(evidence.completeness, 'complete_as_observed');
  assert.equal(evidence.counts.direct, 2);
  assert.equal(evidence.events.length, 2);
  assert.equal(evidence.events[0].eventId, 'evt_egress');
  assert.equal(evidence.events[0].subject, 'Egress → 192.0.2.10:18890');
  assert.equal(evidence.events[0].processInstanceKey, 'pri_original_from_events');
  assert.equal(evidence.events[0].relation, 'DIRECT');
  assert.equal(evidence.events[1].command, '/bin/ls');
  assert.equal(evidence.lineage.length, 1);
  assert.equal(evidence.lineage[0].parentProcessInstanceKey, 'pgk_exact_parent');
  assert.equal(evidence.lineage[0].childProcessInstanceKey, 'pri_original_from_events');
  assert.equal(calls.searches.length, 1);
  assert.equal(calls.searches[0].processPid, observedProcess.pid);
  assert.equal(calls.searches[0].processStartTimeTicks, observedProcess.startTimeTicks);
  assert.equal(calls.searches[0].processHostId, observedProcess.hostId);
  assert.equal(calls.searches[0].processBootId, observedProcess.bootId);
  assert.equal(calls.searches[0].processPidNamespace, observedProcess.pidNamespace);
  assert.equal(calls.searches[0].sinceMs, interactionAt - 500 - 30_000);
  assert.equal(calls.searches[0].untilMs, interactionAt + 30_000);
  assert.equal(calls.searches[0].limit, 251);
  assert.equal(calls.stats[0].untilMs >= interactionAt + 30_000, true);
}

{
  const { calls, service } = fixture([interaction()], events);
  const evidence = await service.evidence(conversationId, 1);
  assert.equal(evidence.events.length, 1);
  assert.equal(evidence.counts.direct, 2);
  assert.equal(evidence.page.requestedLimit, 1);
  assert.equal(evidence.page.totalRelations, 2);
  assert.equal(evidence.page.hasMore, true);
  assert.equal(evidence.completeness, 'partial');
  assert.equal(calls.searches[0].limit, 2, 'read one sentinel row beyond the requested page');
}

{
  const { service } = fixture([interaction()], events, { totalEvents: 2, exitedAt: interactionAt });
  const evidence = await service.evidence(conversationId);
  assert.equal(evidence.evidenceScope, 'historical_reconstructed');
}

{
  const { service } = fixture([interaction()], events, null);
  const evidence = await service.evidence(conversationId);
  assert.equal(evidence.completeness, 'partial');
  assert.equal(evidence.evidenceScope, undefined);
  assert.equal(evidence.counts.direct, 2, 'degraded stats must not invent a global total');
}

{
  const { service } = fixture([interaction()], []);
  const evidence = await service.evidence(conversationId);
  assertEmpty(evidence);
  assert.equal(evidence.binding.matchedPid, observedProcess.pid);
}

{
  const { calls, service } = fixture([], []);
  const evidence = await service.evidence(conversationId);
  assertEmpty(evidence);
  assert.equal(evidence.binding.matchedPid, 0);
  assert.equal(calls.searches.length, 0, 'unknown conversations must not scan events');
  assert.equal(calls.stats.length, 0, 'unknown conversations must not scan generation stats');
}

{
  const second = interaction({
    interactionId: 'mi_uos_second_generation',
    process: { ...observedProcess, startTimeTicks: '987655' },
  });
  const { calls, service } = fixture([interaction(), second], events);
  assertEmpty(await service.evidence(conversationId));
  assert.equal(calls.searches.length, 0, 'multiple generations must fail closed before event reads');
}

{
  const missingStart = interaction({ process: { ...observedProcess, startTimeTicks: undefined } });
  const { calls, service } = fixture([missingStart], events);
  assertEmpty(await service.evidence(conversationId));
  assert.equal(calls.searches.length, 0);
}

{
  const wrongGeneration = events.map((event) => ({
    ...event,
    process: { ...observedProcess, startTimeTicks: 'different' },
  }));
  const { service } = fixture([interaction()], wrongGeneration, { totalEvents: 2 });
  assertEmpty(await service.evidence(conversationId));
}

{
  const store = new ClickHouseStore();
  store.ready = true;
  const queries = [];
  store.client = {
    async query(options) {
      queries.push(options);
      return { async json() { return [{ totalEvents: '7', exitedAt: '123456' }]; } };
    },
  };
  const stats = await store.readUosProcessGenerationEventStats({
    processPid: observedProcess.pid,
    processStartTimeTicks: observedProcess.startTimeTicks,
    processHostId: observedProcess.hostId,
    processBootId: observedProcess.bootId,
    processPidNamespace: observedProcess.pidNamespace,
    sinceMs: 100,
    displayUntilMs: 200,
    untilMs: 300,
  });
  assert.deepEqual(stats, { totalEvents: 7, exitedAt: 123456 });
  assert.equal(queries.length, 1);
  assert.match(queries[0].query, /PREWHERE at >= \{sinceMs:UInt64\} AND at <= \{untilMs:UInt64\}/u);
  assert.match(queries[0].query, /processPid = \{processPid:UInt64\}/u);
  assert.match(queries[0].query, /processStartTimeTicks = \{processStartTimeTicks:String\}/u);
  assert.match(queries[0].query, /processHostId = \{processHostId:String\}/u);
  assert.match(queries[0].query, /processBootId = \{processBootId:String\}/u);
  assert.match(queries[0].query, /processPidNamespace = \{processPidNamespace:String\}/u);
  assert.match(queries[0].query, /uniqExactIf\(eventId, at <= \{displayUntilMs:UInt64\}\)/u);
  assert.match(queries[0].query, /maxIf\(at, eventKind = 'ProcessExit'\)/u);
  assert.match(queries[0].query, /LIMIT 1/u);
  assert.equal(queries[0].clickhouse_settings.max_result_rows, '1');
  assert.deepEqual(queries[0].query_params, {
    processPid: observedProcess.pid,
    processStartTimeTicks: observedProcess.startTimeTicks,
    sinceMs: 100,
    displayUntilMs: 200,
    untilMs: 300,
    processHostId: observedProcess.hostId,
    processBootId: observedProcess.bootId,
    processPidNamespace: observedProcess.pidNamespace,
  });
}

console.log('UOS system evidence verification passed');
