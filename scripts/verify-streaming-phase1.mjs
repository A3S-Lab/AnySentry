#!/usr/bin/env node

import assert from 'node:assert/strict';
import { canonicalizeEvent } from '../apps/api/dist/security-monitoring/streaming-normalizer.js';
import { isAgentStreamEvent, judgmentStreamEvent } from '../apps/api/dist/security-monitoring/streaming-queue.service.js';

function event(overrides = {}) {
  return {
    schemaVersion: 'anysentry.agent_event.v1',
    eventId: 'evt_source_record_1',
    sourceEventId: 'observer-source-event-1',
    at: 1_785_000_000_000,
    eventKind: 'ToolExec',
    eventCategory: 'tool',
    source: 'observer',
    subject: 'test event',
    workspacePath: '/workspace/project',
    agentId: 'a3s code',
    collectorId: 'collector-1',
    sourceId: 'source-1',
    sessionId: 'session-1',
    userId: 'user-1',
    traceId: 'trace-1',
    spanId: 'span-1',
    runId: 'run-1',
    verdict: 'allow',
    tier: 'L1',
    severity: 'low',
    reason: 'test',
    riskCategory: 'none',
    riskName: 'None',
    riskType: 'none',
    riskScore: 0,
    tokenCount: 0,
    latencyMs: 1,
    attributes: {
      tenantId: 'tenant-1',
      environmentId: 'test',
      collectorNode: 'node-1',
    },
    process: {
      pid: 1200,
      startTimeNs: '1200000000',
      hostId: 'node-1',
    },
    attribution: {
      monitored: true,
      agentScopeId: 'a3s code',
      agentDisplayName: 'a3s code',
      rootPid: 1200,
      confidence: 0.9,
      reason: 'process_lineage',
      source: 'process_graph',
    },
    ...overrides,
  };
}

function observer(kind, payload) {
  return JSON.stringify({ event: { [kind]: payload } });
}

const sensitiveRead = canonicalizeEvent(
  event({
    eventKind: 'FileAccess',
    subject: 'file /home/test/.ssh/id_rsa',
  }),
  observer('FileAccess', { path: '/home/test/.ssh/id_rsa' }),
);
assert.equal(sensitiveRead.schemaVersion, 'anysentry.canonical_event.v1');
assert.equal(sensitiveRead.operation, 'file_read');
assert.equal(sensitiveRead.resourceType, 'file');
assert.equal(sensitiveRead.sensitiveResource, true);
assert.equal(sensitiveRead.behaviorStage, 'credential_access');
assert.equal(sensitiveRead.synthetic, false);
assert.match(
  sensitiveRead.workspacePathFingerprint,
  /^sha256:[a-f0-9]{64}$/,
  'absolute local workspaces must be eligible for supply-chain matching',
);

const logicalWorkspace = canonicalizeEvent(
  event({
    eventId: 'evt_logical_workspace',
    sourceEventId: 'observer-logical-workspace',
    workspacePath: 'repo://example/workspace',
  }),
  observer('ToolExec', { argv: ['printf', 'ok'] }),
);
assert.equal(logicalWorkspace.workspacePath, 'repo://example/workspace');
assert.equal(
  logicalWorkspace.workspacePathFingerprint,
  '',
  'logical workspaces must remain streamable without being treated as local scan paths',
);

const encoded = canonicalizeEvent(
  event({
    eventId: 'evt_source_record_2',
    sourceEventId: 'observer-source-event-2',
    at: sensitiveRead.eventTime + 1_000,
  }),
  observer('ToolExec', { argv: ['base64', '/home/test/.ssh/id_rsa'] }),
);
assert.equal(encoded.operation, 'encode');
assert.equal(encoded.behaviorStage, 'transform');
assert.match(encoded.command, /^base64 /);

const egress = canonicalizeEvent(
  event({
    eventId: 'evt_source_record_3',
    sourceEventId: 'observer-source-event-3',
    at: sensitiveRead.eventTime + 2_000,
  }),
  observer('ToolExec', { argv: ['curl', 'https://example.com/upload'] }),
);
assert.equal(egress.operation, 'egress');
assert.equal(egress.destination, 'example.com');
assert.equal(egress.externalDestination, true);
assert.equal(egress.behaviorStage, 'external_egress');

const platformSandbox = canonicalizeEvent(
  event({
    eventId: 'evt_platform_sandbox',
    sourceEventId: 'observer-platform-sandbox',
    sessionId: 'codex-linux-san',
    riskCategory: 'command_danger',
  }),
  observer('ToolExec', {
    argv: ['bwrap', '--new-session', '--die-with-parent', '--unshare-user', '--unshare-net', '--ro-bind', '/bin', '/bin', '/usr/bin/true'],
  }),
);
assert.equal(platformSandbox.platformRuntime, true, 'managed bwrap confinement must not become an attack episode');
assert.match(
  platformSandbox.sessionId,
  /^ags_[a-f0-9]{24}$/,
  'generic process names must fall back to the stable Agent root session',
);

const rootChildOne = canonicalizeEvent(
  event({
    eventId: 'evt_root_child_1',
    sourceEventId: 'observer-root-child-1',
    agentId: 'base64',
    sessionId: 'base64',
    runId: 'base64',
    traceId: 'trace-child-1',
    process: {
      pid: 1201,
      ppid: 1200,
      startTimeNs: '1201000000',
      comm: 'base64',
      hostId: 'node-1',
    },
  }),
  observer('ToolExec', { argv: ['base64', '/home/test/.ssh/id_rsa'] }),
);
const rootChildTwo = canonicalizeEvent(
  event({
    eventId: 'evt_root_child_2',
    sourceEventId: 'observer-root-child-2',
    agentId: 'curl',
    sessionId: 'curl',
    runId: 'curl',
    traceId: 'trace-child-2',
    process: {
      pid: 1202,
      ppid: 1200,
      startTimeNs: '1202000000',
      comm: 'curl',
      hostId: 'node-1',
    },
  }),
  observer('ToolExec', { argv: ['curl', 'https://example.com/upload'] }),
);
assert.equal(
  rootChildOne.sessionId,
  rootChildTwo.sessionId,
  'different child processes and traces under one Agent root must share a logical session',
);
assert.equal(
  rootChildOne.agentInstanceId,
  rootChildTwo.agentInstanceId,
  'different child processes under one Agent root must share an Agent instance',
);

const attributedSession = canonicalizeEvent(
  event({
    eventId: 'evt_attributed_session',
    sourceEventId: 'observer-attributed-session',
    sessionId: 'bash',
    attributes: {
      tenantId: 'tenant-1',
      environmentId: 'test',
      collectorNode: 'node-1',
      agentTaskId: 'task-lower-priority',
    },
    attribution: {
      monitored: true,
      agentScopeId: 'a3s code',
      agentDisplayName: 'a3s code',
      agentSessionId: 'agent-session-explicit',
      rootPid: 1200,
      confidence: 0.9,
      reason: 'process_lineage',
      source: 'process_graph',
    },
  }),
  observer('ToolExec', { argv: ['printf', 'ok'] }),
);
assert.equal(
  attributedSession.sessionId,
  'agent-session-explicit',
  'trusted attribution.agentSessionId must have highest priority',
);

const explicitTaskSession = canonicalizeEvent(
  event({
    eventId: 'evt_explicit_task_session',
    sourceEventId: 'observer-explicit-task-session',
    sessionId: 'bash',
    attributes: {
      tenantId: 'tenant-1',
      environmentId: 'test',
      collectorNode: 'node-1',
      agentTaskId: 'agent-task-explicit',
    },
  }),
  observer('ToolExec', { argv: ['printf', 'ok'] }),
);
assert.equal(
  explicitTaskSession.sessionId,
  'agent-task-explicit',
  'an explicit Agent task ID must take priority over the root PID fallback',
);

const traceFallback = canonicalizeEvent(
  event({
    eventId: 'evt_trace_fallback',
    sourceEventId: 'observer-trace-fallback',
    agentId: 'curl',
    sessionId: 'curl',
    runId: 'curl',
    traceId: 'trace-fallback',
    process: {
      pid: 1300,
      startTimeNs: '1300000000',
      comm: 'curl',
      hostId: 'node-1',
    },
    attribution: {
      monitored: true,
      agentScopeId: 'a3s code',
      agentDisplayName: 'a3s code',
      confidence: 0.9,
      reason: 'process_lineage',
      source: 'process_graph',
    },
  }),
  observer('ToolExec', { argv: ['curl', 'https://example.com/upload'] }),
);
assert.equal(
  traceFallback.sessionId,
  'trace:trace-fallback',
  'trace must be used only when no Agent session, task, instance, or root PID is available',
);

assert.equal(
  sensitiveRead.agentCorrelationId,
  encoded.agentCorrelationId,
  'events from the same stable Agent scope must share a Flink key',
);
const replay = canonicalizeEvent(
  event({ eventId: 'evt_different_ingest_record' }),
  observer('FileAccess', { path: '/home/test/.ssh/id_rsa' }),
);
assert.equal(
  replay.eventId,
  sensitiveRead.eventId,
  'replayed source events must retain a deterministic canonical event ID',
);
assert.notEqual(
  canonicalizeEvent(
    event({ sourceEventId: 'observer-source-event-new' }),
    observer('FileAccess', { path: '/home/test/.ssh/id_rsa' }),
  ).eventId,
  sensitiveRead.eventId,
);
assert.equal(isAgentStreamEvent(event()), true);
assert.equal(isAgentStreamEvent(event({
  attribution: {
    monitored: false,
    confidence: 0,
    reason: 'not_evaluated',
    source: 'none',
  },
})), false, 'unattributed Observer events must not enter Flink');
assert.equal(isAgentStreamEvent(event({
  attribution: {
    monitored: true,
    confidence: 0.9,
    reason: 'conflict',
    source: 'process_graph',
    conflict: true,
  },
})), false, 'conflicted Agent attribution must not enter Flink');

const alternateCollector = canonicalizeEvent(
  event({ collectorId: 'collector-2', sourceId: 'source-2' }),
  observer('ToolExec', { argv: ['printf', 'ok'] }),
);
assert.equal(
  alternateCollector.workspaceId,
  sensitiveRead.workspaceId,
  'collector changes must not split the same workspace into separate risk assets',
);
assert.equal(
  alternateCollector.agentCorrelationId,
  sensitiveRead.agentCorrelationId,
  'collector changes must not split the same Agent and workspace risk asset',
);
const pseudoWorkspace = canonicalizeEvent(
  event({ workspacePath: 'agent://getconf' }),
  observer('ToolExec', { argv: ['getconf', 'ARG_MAX'] }),
);
assert.equal(pseudoWorkspace.workspacePath, '', 'agent pseudo paths must not become workspace assets');

const judgment = judgmentStreamEvent({
  schemaVersion: 'anysentry.decision_result.v1',
  evaluationId: 'eval-1',
  policyVersion: 'policy-1',
  event: event({
    eventId: 'evt_source_record_2',
    sourceEventId: 'observer-source-event-2',
    rawPreview: observer('ToolExec', { argv: ['base64', '/home/test/.ssh/id_rsa'] }),
  }),
  stage: 'L2',
  status: 'succeeded',
  decision: {
    verdict: 'block',
    tier: 'Llm',
    severity: 'high',
    reason: 'suspicious sequence',
    risk: { category: 'command_danger', name: 'Dangerous command' },
  },
  startedAt: 1_785_000_000_000,
  completedAt: 1_785_000_001_250,
  attempt: 1,
}, 1_785_000_002_000);
assert.equal(judgment.schemaVersion, 'anysentry.judgment_update.v1');
assert.equal(judgment.eventId, encoded.eventId);
assert.equal(judgment.agentCorrelationId, encoded.agentCorrelationId);
assert.equal(judgment.stage, 'L2');
assert.equal(judgment.verdict, 'block');
assert.equal(judgment.latencyMs, 1_250);

console.log('Streaming canonical and judgment contracts verification passed');
