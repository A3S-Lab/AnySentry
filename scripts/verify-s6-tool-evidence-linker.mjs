import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { buildToolEvidenceBundle } from '../apps/api/dist/security-monitoring/tool-evidence-linker.js';
import { toolEvidenceHotPathTesting } from '../apps/api/dist/security-monitoring/aggregation.service.js';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const adapterCorrelation = (invocationId, toolCallId) => ({
  schemaVersion: 'anysentry.trusted_correlation.v1',
  identityVersion: 'trusted_correlation.v1',
  method: 'agent_adapter',
  scope: 'invocation',
  confidence: 1,
  authority: 'authenticated_agent_adapter',
  inferred: false,
  traceOrigin: 'adapter',
  provenance: [
    'source_authenticated',
    'source_scope_bound',
    'adapter_invocation',
    'adapter_tool_call',
  ],
  claimReceipts: [{ kind: 'agent_adapter', decision: 'accepted', reason: 'authorized' }],
  invocationId,
  toolCallId,
});

const observerCorrelation = (suffix) => ({
  schemaVersion: 'anysentry.trusted_correlation.v1',
  identityVersion: 'trusted_correlation.v1',
  method: 'runtime_root',
  scope: 'runtime',
  confidence: 1,
  authority: 'attested_observer',
  inferred: false,
  traceOrigin: 'none',
  provenance: ['runtime_root_key', 'process_tuple'],
  agentRootInstanceId: `agent-root:v1:${suffix.repeat(64).slice(0, 64)}`,
  processInstanceId: `pri_${suffix.repeat(24).slice(0, 24)}`,
});

function event(overrides = {}) {
  return {
    schemaVersion: 'anysentry.agent_event.v1',
    eventId: overrides.eventId ?? `event-${Math.random()}`,
    at: 1_775_000_000_000,
    eventKind: 'AgentTool',
    eventCategory: 'tool',
    source: 'api',
    subject: 'tool event',
    workspacePath: '/workspace',
    agentId: 'pi',
    sessionId: 'pi-session',
    userId: 'user',
    traceId: 'legacy-trace-stays-independent',
    spanId: 'span',
    runId: 'run',
    verdict: 'allow',
    tier: 'Rules',
    severity: 'info',
    reason: 'fixture',
    riskCategory: 'other',
    riskName: 'Other',
    riskType: 'atomic',
    riskScore: 0,
    tokenCount: 0,
    latencyMs: 1,
    attributes: {},
    ...overrides,
  };
}

const piProcess = {
  hostId: 'host-s6',
  bootId: 'boot-s6',
  pid: 4_200,
  ppid: 1,
  startTimeTicks: '9001',
  cwd: '/workspace',
};

function toolPair({ invocationId = 'invocation-s6', toolCallId, toolName, start, end, process = piProcess, attributes = {} }) {
  const correlation = adapterCorrelation(invocationId, toolCallId);
  const common = {
    eventKind: 'AgentTool',
    eventCategory: 'tool',
    invocationId,
    toolCallId,
    spanId: `span-${toolCallId}`,
    process,
    attribution: { monitored: true, confidence: 1, reason: 'human_confirmed', source: 'manual_review', correlation },
  };
  return [
    event({
      ...common,
      eventId: `${toolCallId}-start`,
      at: start,
      attributes: {
        'anysentry.lifecycle.phase': 'start',
        'gen_ai.tool.name': toolName,
        ...attributes,
      },
    }),
    event({
      ...common,
      eventId: `${toolCallId}-end`,
      at: end,
      attributes: {
        'anysentry.lifecycle.phase': 'end',
        'gen_ai.tool.name': toolName,
        ...attributes,
      },
    }),
  ];
}

function kernelEvent({ rootProcess = piProcess, ...overrides }) {
  return event({
    source: 'observer',
    attribution: {
      monitored: true,
      agentScopeId: 'pi',
      confidence: 1,
      reason: 'process_lineage',
      source: 'process_graph',
      rootPid: rootProcess.pid,
      rootStartTime: rootProcess.startTimeTicks,
      correlation: observerCorrelation('a'),
    },
    ...overrides,
  });
}

const base = 1_775_000_000_000;
const writePath = '/workspace/output.txt';
const bashCommand = 'printf safe >> /workspace/output.txt';
const semanticEvents = [
  ...toolPair({ toolCallId: 'read-1', toolName: 'read', start: base, end: base + 20, attributes: {
    'anysentry.tool.resource_hash': sha256('/workspace/input.txt'),
  } }),
  ...toolPair({ toolCallId: 'write-1', toolName: 'write', start: base + 100, end: base + 200, attributes: {
    'anysentry.tool.resource_hash': sha256(writePath),
  } }),
  ...toolPair({ toolCallId: 'bash-1', toolName: 'bash', start: base + 300, end: base + 500, attributes: {
    'anysentry.tool.command_hash': sha256(bashCommand),
  } }),
  ...toolPair({ toolCallId: 'custom-1', toolName: 'remote_inventory', start: base + 600, end: base + 650 }),
];

const kernelEvents = [
  kernelEvent({
    eventId: 'kernel-write',
    at: base + 150,
    eventKind: 'FileAccess',
    eventCategory: 'file',
    process: piProcess,
    attributes: { path: writePath, accessMode: 'write_only', write: true },
  }),
  kernelEvent({
    eventId: 'kernel-bash',
    at: base + 350,
    eventKind: 'ToolExec',
    eventCategory: 'tool',
    process: { ...piProcess, pid: 4_201, ppid: piProcess.pid, startTimeTicks: '9002' },
    attributes: {
      argv: `bash -c ${bashCommand}`,
      'anysentry.kernel.command_hash': sha256(bashCommand),
    },
    // Persistence may redact or truncate this preview; the attested digest above remains usable.
    rawPreview: JSON.stringify({ event: { ToolExec: { argv: ['/bin/bash', '-c', 'redacted'] } } }),
  }),
  // A direct child with the same PPID and command after parent PID reuse is not the same lineage.
  kernelEvent({
    rootProcess: { ...piProcess, startTimeTicks: 'reused-parent-generation' },
    eventId: 'kernel-bash-reused-parent',
    at: base + 360,
    eventKind: 'ToolExec',
    eventCategory: 'tool',
    process: { ...piProcess, pid: 4_202, ppid: piProcess.pid, startTimeTicks: '9003' },
    attributes: { 'anysentry.kernel.command_hash': sha256(bashCommand) },
  }),
  // Pure time proximity and the same PID are insufficient when the resource does not match.
  kernelEvent({
    eventId: 'kernel-other-file',
    at: base + 160,
    eventKind: 'FileAccess',
    eventCategory: 'file',
    process: piProcess,
    attributes: { path: '/workspace/unrelated.txt' },
  }),
  // PID reuse is isolated by start time even when the resource and timestamp match.
  kernelEvent({
    eventId: 'kernel-reused-pid',
    at: base + 160,
    eventKind: 'FileAccess',
    eventCategory: 'file',
    process: { ...piProcess, startTimeTicks: 'different-generation' },
    attributes: { path: writePath },
  }),
];

const forgedAdapter = event({
  eventId: 'forged-adapter',
  eventKind: 'AgentTool',
  invocationId: 'forged-invocation',
  toolCallId: 'forged-tool',
  attributes: { 'gen_ai.tool.name': 'write', 'anysentry.lifecycle.phase': 'start' },
});

const bundle = buildToolEvidenceBundle([...semanticEvents, ...kernelEvents, forgedAdapter]);
assert.equal(bundle.schemaVersion, 'anysentry.tool_evidence.v1');
assert.equal(bundle.ignoredUntrustedAdapterEvents, 1);
assert.equal(bundle.truncated, false);
assert.equal(bundle.items.length, 4);

const byTool = Object.fromEntries(bundle.items.map((item) => [item.toolCallId, item]));
assert.equal(byTool['read-1'].status, 'semantic_only');
assert.equal(byTool['read-1'].reason, 'kernel_read_not_captured');
assert.deepEqual(byTool['read-1'].kernelEvidence, []);

assert.equal(byTool['write-1'].status, 'linked');
assert.equal(byTool['write-1'].reason, 'exact_process_and_resource');
assert.deepEqual(byTool['write-1'].kernelEvidence.map((item) => item.eventId), ['kernel-write']);
assert.equal(byTool['write-1'].kernelEvidence[0].confidence, 1);

assert.equal(byTool['bash-1'].status, 'linked');
assert.equal(byTool['bash-1'].reason, 'exact_child_and_command');
assert.deepEqual(byTool['bash-1'].kernelEvidence.map((item) => item.eventId), ['kernel-bash']);
assert.equal(byTool['bash-1'].kernelEvidence[0].confidence, 0.98);

assert.equal(byTool['custom-1'].status, 'semantic_only');
assert.equal(byTool['custom-1'].reason, 'no_matching_kernel_evidence');

const competingProcess = { ...piProcess, pid: 5_000, startTimeTicks: 'other-root' };
const competingPath = '/workspace/shared.txt';
const competingTools = [
  ...toolPair({ toolCallId: 'write-a', toolName: 'write', start: base + 1_000, end: base + 1_200, process: competingProcess, attributes: {
    'anysentry.tool.resource_hash': sha256(competingPath),
  } }),
  ...toolPair({ toolCallId: 'write-b', toolName: 'write', start: base + 1_050, end: base + 1_250, process: competingProcess, attributes: {
    'anysentry.tool.resource_hash': sha256(competingPath),
  } }),
];
const competingKernel = kernelEvent({
  eventId: 'kernel-shared-write',
  at: base + 1_100,
  eventKind: 'FileAccess',
  eventCategory: 'file',
  process: competingProcess,
  attributes: { path: competingPath, accessMode: 'write_only', write: true },
});
const ambiguous = buildToolEvidenceBundle([...competingTools, competingKernel]);
assert.equal(ambiguous.items.length, 2);
assert(ambiguous.items.every((item) => item.status === 'ambiguous'));
assert(ambiguous.items.every((item) => item.reason === 'overlapping_exact_claims'));
assert(ambiguous.items.every((item) => item.kernelEvidence.length === 0));
assert(ambiguous.items.every((item) => item.ambiguousKernelEventIds?.[0] === 'kernel-shared-write'));

const sameResourceProcess = { ...piProcess, pid: 5_100, startTimeTicks: 'read-write-root' };
const sameResourcePath = '/workspace/read-write.txt';
const operationAware = buildToolEvidenceBundle([
  ...toolPair({ toolCallId: 'same-write', toolName: 'write', start: base + 1_500, end: base + 1_600,
    process: sameResourceProcess, attributes: { 'anysentry.tool.resource_hash': sha256(sameResourcePath) } }),
  ...toolPair({ toolCallId: 'same-read', toolName: 'read', start: base + 1_550, end: base + 1_650,
    process: sameResourceProcess, attributes: { 'anysentry.tool.resource_hash': sha256(sameResourcePath) } }),
  kernelEvent({ eventId: 'same-kernel-write', at: base + 1_575, eventKind: 'FileAccess', eventCategory: 'file',
    process: sameResourceProcess, attributes: { path: sameResourcePath, accessMode: 'write_only', write: true } }),
  kernelEvent({ eventId: 'same-kernel-read', at: base + 1_580, eventKind: 'FileAccess', eventCategory: 'file',
    process: sameResourceProcess, attributes: { path: sameResourcePath, accessMode: 'read_only', write: false } }),
]);
const operationAwareByTool = Object.fromEntries(operationAware.items.map((item) => [item.toolCallId, item]));
assert.deepEqual(operationAwareByTool['same-write'].kernelEvidence.map((item) => item.eventId), ['same-kernel-write']);
assert.deepEqual(operationAwareByTool['same-read'].kernelEvidence.map((item) => item.eventId), ['same-kernel-read']);
assert.equal(operationAwareByTool['same-write'].status, 'linked');
assert.equal(operationAwareByTool['same-read'].status, 'linked');

const otlpInvocation = 'otlp-invocation';
const otlpTool = event({
  eventId: 'otlp-tool-span',
  at: base + 2_000,
  eventKind: 'AgentTool',
  invocationId: otlpInvocation,
  toolCallId: 'otlp-write',
  process: piProcess,
  attribution: {
    monitored: true,
    confidence: 1,
    reason: 'human_confirmed',
    source: 'manual_review',
    correlation: adapterCorrelation(otlpInvocation, 'otlp-write'),
  },
  attributes: {
    'gen_ai.operation.name': 'execute_tool',
    'gen_ai.tool.name': 'write',
    'anysentry.span.start_at_ms': base + 2_000,
    'anysentry.span.end_at_ms': base + 2_050,
    'anysentry.tool.resource_hash': sha256('/workspace/otlp.txt'),
  },
});
const otlpInside = kernelEvent({
  eventId: 'otlp-kernel-inside',
  at: base + 2_025,
  eventKind: 'FileAccess',
  eventCategory: 'file',
  process: piProcess,
  attributes: { path: '/workspace/otlp.txt', accessMode: 'write_only', write: true },
});
const otlpOutside = kernelEvent({
  eventId: 'otlp-kernel-outside',
  at: base + 10_000,
  eventKind: 'FileAccess',
  eventCategory: 'file',
  process: piProcess,
  attributes: { path: '/workspace/otlp.txt', accessMode: 'write_only', write: true },
});
const otlpBundle = buildToolEvidenceBundle([otlpTool, otlpInside, otlpOutside]);
assert.deepEqual(otlpBundle.items[0].kernelEvidence.map((item) => item.eventId), ['otlp-kernel-inside']);

const containerAdapterProcess = {
  ...piProcess,
  hostId: 'container-machine-id',
  pid: 1,
  ppid: 0,
  pidNamespace: '4026532441',
  namespacePid: 1,
  startTimeTicks: 'container-root-start',
};
const containerObserverRoot = {
  ...piProcess,
  hostId: 'observer-node-name',
  pid: 52_000,
  ppid: 1,
  pidNamespace: '4026532441',
  namespacePid: 1,
  startTimeTicks: 'container-root-start',
};
const containerPath = '/workspace/container.txt';
const containerCommand = 'printf container-safe';
const containerSemantic = [
  ...toolPair({
    invocationId: 'container-invocation',
    toolCallId: 'container-write',
    toolName: 'write',
    start: base + 20_000,
    end: base + 20_100,
    process: containerAdapterProcess,
    attributes: { 'anysentry.tool.resource_hash': sha256(containerPath) },
  }),
  ...toolPair({
    invocationId: 'container-invocation',
    toolCallId: 'container-bash',
    toolName: 'bash',
    start: base + 20_200,
    end: base + 20_300,
    process: containerAdapterProcess,
    attributes: { 'anysentry.tool.command_hash': sha256(containerCommand) },
  }),
];
const containerKernel = [
  kernelEvent({
    rootProcess: containerObserverRoot,
    eventId: 'container-kernel-write',
    at: base + 20_050,
    eventKind: 'FileAccess',
    eventCategory: 'file',
    process: containerObserverRoot,
    attributes: { path: containerPath, accessMode: 'write_only', write: true },
  }),
  kernelEvent({
    rootProcess: containerObserverRoot,
    eventId: 'container-kernel-bash',
    at: base + 20_250,
    eventKind: 'ToolExec',
    eventCategory: 'tool',
    process: {
      ...containerObserverRoot,
      pid: 52_001,
      ppid: containerObserverRoot.pid,
      namespacePid: 2,
      namespacePpid: containerAdapterProcess.namespacePid,
      startTimeTicks: 'container-child-start',
    },
    attributes: { 'anysentry.kernel.command_hash': sha256(containerCommand) },
  }),
  kernelEvent({
    rootProcess: { ...containerObserverRoot, pid: 52_999 },
    eventId: 'container-kernel-bash-wrong-root',
    at: base + 20_250,
    eventKind: 'ToolExec',
    eventCategory: 'tool',
    process: {
      ...containerObserverRoot,
      pid: 52_002,
      ppid: containerObserverRoot.pid,
      namespacePid: 3,
      namespacePpid: containerAdapterProcess.namespacePid,
      startTimeTicks: 'container-wrong-root-child',
    },
    attributes: { 'anysentry.kernel.command_hash': sha256(containerCommand) },
  }),
  // Same inner PID/start text in a different PID namespace is a different process instance.
  kernelEvent({
    rootProcess: containerObserverRoot,
    eventId: 'other-namespace-write',
    at: base + 20_050,
    eventKind: 'FileAccess',
    eventCategory: 'file',
    process: { ...containerObserverRoot, pidNamespace: '4026532999' },
    attributes: { path: containerPath, accessMode: 'write_only', write: true },
  }),
];
const containerBundle = buildToolEvidenceBundle([...containerSemantic, ...containerKernel]);
const containerByTool = Object.fromEntries(containerBundle.items.map((item) => [item.toolCallId, item]));
assert.deepEqual(containerByTool['container-write'].kernelEvidence.map((item) => item.eventId), ['container-kernel-write']);
assert.deepEqual(containerByTool['container-bash'].kernelEvidence.map((item) => item.eventId), ['container-kernel-bash']);

const hotScope = {
  bootId: 'hot-boot', pid: 1, startTimeTicks: 'hot-root-start',
  pidNamespace: '4026533999', namespacePid: 1,
};
const hotExact = {
  eventKind: 'FileAccess',
  process: {
    ...hotScope, pid: 91_001,
  },
};
const hotDirectChild = {
  eventKind: 'ToolExec',
  process: {
    bootId: hotScope.bootId, pid: 91_002, ppid: 91_001, startTimeTicks: 'hot-child-start',
    pidNamespace: hotScope.pidNamespace, namespacePid: 2, namespacePpid: 1,
  },
};
const hotPidReuse = {
  eventKind: 'FileAccess',
  process: {
    ...hotExact.process, startTimeTicks: 'reused-generation',
  },
};
const noise = Array.from({ length: 12_000 }, (_, index) => ({
  eventKind: 'FileAccess',
  process: {
    bootId: 'noise-boot', pid: index + 10, startTimeTicks: `noise-${index}`,
    pidNamespace: 'noise-namespace', namespacePid: index + 10,
  },
}));
assert.equal(toolEvidenceHotPathTesting.toolKernelEventInProcessScope(hotExact, [hotScope]), true);
assert.equal(toolEvidenceHotPathTesting.toolKernelEventInProcessScope(hotDirectChild, [hotScope]), true);
assert.equal(toolEvidenceHotPathTesting.toolKernelEventInProcessScope(hotPidReuse, [hotScope]), false);
assert.equal(noise.some((candidate) =>
  toolEvidenceHotPathTesting.toolKernelEventInProcessScope(candidate, [hotScope])), false,
'unrelated high-volume hot-ring noise is removed before the linker candidate cap');

console.log('S6 Tool↔kernel evidence linker verification passed');
