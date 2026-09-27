#!/usr/bin/env node

import assert from 'node:assert/strict';

const [{ SentryJudgeService }, { DEFAULT_POLICY }, { processLifecycleFact }] = await Promise.all([
  import('../apps/api/dist/security-monitoring/sentry-judge.service.js'),
  import('../apps/api/dist/security-monitoring/policy-config.js'),
  import('../apps/api/dist/security-monitoring/process-lifecycle.js'),
]);

const judge = new SentryJudgeService(
  { observeEvent() {}, observeIncident() {}, observeJudgmentResult() {} },
  { attribute: (_meta, process) => ({
    monitored: false,
    classification: 'non_agent',
    confidence: 1,
    reason: 'not_agent',
    source: 'none',
    evidence: [],
    physicalWorkloadId: 'container:fixture',
    rootPid: process?.pid,
    rootStartTime: process?.startTimeTicks,
  }) },
  { enabled: false },
  {},
  {},
  {},
);
judge.applyPolicy(DEFAULT_POLICY);
judge.ch = {
  enabled: true,
  async writeProcessLifecycleFacts() { return true; },
};

const baseMeta = {
  workspacePath: '/workspace',
  agentId: 'infra-service',
  sessionId: 'infra-session',
  userId: 'uid:1000',
  source: 'observer',
  eventCategory: 'process',
  attributes: {},
  process: {
    hostId: 'host-a',
    bootId: 'boot-a',
    pid: 42,
    ppid: 1,
    startTimeTicks: '1234',
    exe: '/usr/bin/true',
  },
  attribution: {
    monitored: false,
    classification: 'non_agent',
    confidence: 1,
    reason: 'not_agent',
    source: 'none',
    evidence: [],
    physicalWorkloadId: 'container:fixture',
  },
};

const exec = judge.prepareAcceptWithDisposition(
  JSON.stringify({ event: { ToolExec: { pid: 42, argv: ['/usr/bin/true'] } } }),
  { ...baseMeta, eventKind: 'ToolExec' },
  1_000,
);
assert.equal(exec.disposition, 'structural_consumed');
assert.equal(exec.fact?.factKind, 'exec');

const exit = judge.prepareAcceptWithDisposition(
  JSON.stringify({ event: { ProcessExit: { pid: 42, exit_code: 137, signal: 9 } } }),
  { ...baseMeta, eventKind: 'ProcessExit', attributes: { exit_code: 137, signal: 9 } },
  1_001,
);
assert.equal(exit.disposition, 'structural_consumed');
assert.equal(exit.fact?.factKind, 'exit');
assert.equal(exit.fact?.exitStatus, 137);
assert.equal(exit.fact?.exitSignal, 9);

const dangerous = judge.prepareAcceptWithDisposition(
  JSON.stringify({ event: { ToolExec: { pid: 42, argv: ['/bin/rm', '-rf', '/'] } } }),
  { ...baseMeta, eventKind: 'ToolExec', attributes: { argv: '/bin/rm -rf /' } },
  1_002,
);
assert.equal(dangerous.disposition, 'retained', 'a dangerous non-Agent command must enter security judgment');

const security = judge.prepareAcceptWithDisposition(
  JSON.stringify({ event: { SecurityAction: { pid: 42, kind: 'ptrace' } } }),
  { ...baseMeta, eventKind: 'SecurityAction', eventCategory: 'security', attributes: { kind: 'ptrace' } },
  1_003,
);
assert.equal(security.disposition, 'retained');
assert.equal(security.event?.judgment?.reason, 'non_agent_security_full');

const adapterConflict = judge.prepareAcceptWithDisposition(
  JSON.stringify({ event: { AgentTool: { toolName: 'bash' } } }),
  {
    ...baseMeta,
    eventKind: 'AgentTool',
    eventCategory: 'tool',
    source: 'api',
    attribution: {
      ...baseMeta.attribution,
      source: 'manual_review',
      evidence: ['server:authenticated-agent-adapter'],
    },
  },
  1_004,
);
assert.equal(adapterConflict.disposition, 'retained');
assert.equal(adapterConflict.event?.judgment?.reason, 'non_agent_agent_conflict_full');

const ordinary = judge.prepareAcceptWithDisposition(
  JSON.stringify({ event: { FileAccess: { pid: 42, path: '/tmp/noise' } } }),
  { ...baseMeta, eventKind: 'FileAccess', eventCategory: 'file', attributes: { path: '/tmp/noise' } },
  1_005,
);
assert.equal(ordinary.disposition, 'discarded');
assert.equal(ordinary.reasonCode, 'non_agent_discarded');

judge.ch = { enabled: false };
const degraded = judge.prepareAcceptWithDisposition(
  JSON.stringify({ event: { ToolExec: { pid: 42, argv: ['/usr/bin/true'] } } }),
  { ...baseMeta, eventKind: 'ToolExec' },
  1_006,
);
assert.equal(degraded.disposition, 'retained', 'lifecycle-store degradation must retain the raw event');
assert.equal(degraded.event?.judgment?.reason, 'non_agent_structural_fallback');

const trustedGraphAttribution = {
  ...baseMeta.attribution,
  processGenerationKey: 'pgk_111111111111111111111111',
  parentProcessGenerationKey: 'pgk_222222222222222222222222',
  parentLinkAuthority: 'forwarder_process_graph',
  correlation: {
    schemaVersion: 'anysentry.trusted_correlation.v1',
    identityVersion: 'trusted_correlation.v1',
    method: 'runtime_root',
    scope: 'runtime',
    confidence: 0.92,
    authority: 'server_process_graph',
    inferred: false,
    traceOrigin: 'none',
    provenance: ['runtime_root_key', 'process_tuple'],
    agentRootInstanceId: `agent-root:v1:${'a'.repeat(64)}`,
    processInstanceId: `pri_${'b'.repeat(24)}`,
  },
};
const linkedFact = processLifecycleFact({
  eventId: 'event-process-generation-link',
  eventKind: 'ToolExec',
  at: 1_007,
  source: 'observer',
  workspacePath: baseMeta.workspacePath,
  process: baseMeta.process,
  attribution: trustedGraphAttribution,
});
assert.equal(linkedFact?.processGenerationKey, trustedGraphAttribution.processGenerationKey);
assert.equal(linkedFact?.parentProcessGenerationKey, trustedGraphAttribution.parentProcessGenerationKey);
assert.equal(linkedFact?.parentLinkAuthority, 'forwarder_process_graph');

const missingParentAuthorityFact = processLifecycleFact({
  eventId: 'event-process-generation-link-without-parent-authority',
  eventKind: 'ToolExec',
  at: 1_007,
  source: 'observer',
  workspacePath: baseMeta.workspacePath,
  process: baseMeta.process,
  attribution: {
    ...trustedGraphAttribution,
    parentLinkAuthority: undefined,
  },
});
assert.equal(missingParentAuthorityFact?.processGenerationKey, trustedGraphAttribution.processGenerationKey);
assert.equal(missingParentAuthorityFact?.parentProcessGenerationKey, undefined,
  'an exact parent generation must retain its declared graph authority');
assert.equal(missingParentAuthorityFact?.parentLinkAuthority, undefined);

const untrustedGraphFact = processLifecycleFact({
  eventId: 'event-untrusted-process-generation-link',
  eventKind: 'ToolExec',
  at: 1_008,
  source: 'api',
  workspacePath: baseMeta.workspacePath,
  process: baseMeta.process,
  attribution: {
    ...trustedGraphAttribution,
    correlation: undefined,
  },
});
assert.equal(untrustedGraphFact?.processGenerationKey, undefined);
assert.equal(untrustedGraphFact?.parentProcessGenerationKey, undefined);

console.log('PASS protected non-Agent API routing and structural lifecycle consumption');
