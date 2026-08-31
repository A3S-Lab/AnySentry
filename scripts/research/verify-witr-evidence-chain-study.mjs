#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';

const require = createRequire(import.meta.url);
const {
  resolveAgentConversationsV2,
} = require('../../apps/api/dist/security-monitoring/agent-conversation-resolution-v2.js');
const {
  buildSemanticKernelRelationBatch,
  buildSemanticKernelRelations,
} = require('../../apps/api/dist/security-monitoring/agent-semantic-kernel-relation.js');
const {
  processLifecycleFact,
} = require('../../apps/api/dist/security-monitoring/process-lifecycle.js');
const {
  AgentAttributor,
} = require('../observer-agent-attribution.js');

const BASE = 1_788_600_000_000;
const RUNTIME_ID = 'host-root:study:100:1000';
const baselineResults = JSON.parse(readFileSync(
  new URL('../../docs/witr-attribution-evidence-chain-assets/study-results.json', import.meta.url),
  'utf8',
));

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function capturedContent(structured) {
  const body = JSON.stringify(structured);
  return {
    body,
    encoding: 'utf8',
    contentType: 'application/json',
    capturedBytes: Buffer.byteLength(body),
    decodedBytes: Buffer.byteLength(body),
    sha256: digest(body),
    completeness: 'complete',
    messages: [],
    structured,
  };
}

function humanMessage(id, turnId, text) {
  return {
    type: 'message',
    id,
    role: 'user',
    content: [{ type: 'input_text', text }],
    internal_chat_message_metadata_passthrough: {
      turn_id: turnId,
      content_item_kinds: ['user.text'],
    },
  };
}

function interaction({ id, at, input, continuityKey, instance = RUNTIME_ID }) {
  const request = { model: 'study-model', prompt_cache_key: continuityKey, input };
  return {
    schemaVersion: 'anysentry.agent_interaction.v1',
    interactionId: id,
    interactionType: 'model',
    at,
    workspacePath: '/workspace/evidence-chain-study',
    tenantId: 'tenant-study',
    environmentId: 'environment-study',
    agentAssetId: 'agent-study',
    agentInstanceId: instance,
    agentProduct: 'Codex',
    detectedClassification: 'confirmed_agent',
    currentEffectiveClassification: 'confirmed_agent',
    process: {
      hostId: 'host-study',
      bootId: 'boot-study',
      pid: Math.trunc(at % 100_000) + 1,
      ppid: 1,
      startTimeTicks: String(at),
      comm: 'codex',
      exe: '/usr/bin/codex',
      cwd: '/workspace/evidence-chain-study',
    },
    connectionId: `tls:${id}`,
    transport: 'tls',
    protocol: 'http/1.1',
    wireTemplateId: 'openai-responses',
    parseState: 'parsed',
    llmLikelihood: 'confirmed',
    endpoint: 'gateway.invalid',
    method: 'POST',
    path: '/responses',
    statusCode: 200,
    model: 'study-model',
    startedAtUnixNs: String(BigInt(at) * 1_000_000n),
    requestCompleteAtUnixNs: String(BigInt(at + 1) * 1_000_000n),
    firstResponseAtUnixNs: String(BigInt(at + 2) * 1_000_000n),
    endedAtUnixNs: String(BigInt(at + 3) * 1_000_000n),
    durationNs: '3000000',
    timeQuality: 'collector_calibrated',
    request: capturedContent(request),
    response: capturedContent({ output: [] }),
    toolCalls: [],
    toolResults: [],
    semanticParserId: 'study',
    semanticParserVersion: 1,
    completeness: 'complete',
    partialReasons: [],
    captureSource: 'tls_uprobe_rustls',
    receivedAt: at + 4,
  };
}

function semanticToolCall({ id, callId, command, at = BASE + 100 }) {
  return {
    semanticEventId: id,
    conversationId: 'cv-study',
    segmentId: 'seg-study',
    turnId: 'turn-study',
    actor: 'tool',
    kind: 'tool_call',
    atUnixNs: String(BigInt(at) * 1_000_000n),
    content: { command },
    toolCallId: callId,
    toolName: 'exec_command',
    toolKind: 'bash',
    sourceInteractionIds: ['mi-study'],
    evidenceEventIds: ['evt-interaction-study'],
  };
}

function semanticToolResult(call, at = BASE + 600) {
  return {
    ...call,
    semanticEventId: `${call.semanticEventId}-result`,
    kind: 'tool_result',
    atUnixNs: String(BigInt(at) * 1_000_000n),
  };
}

function kernelEvent({
  eventId,
  subject,
  pid,
  ppid,
  startTimeTicks,
  runtimeId,
  at = BASE + 200,
  processGenerationKey,
  parentProcessGenerationKey,
}) {
  return {
    eventId,
    at: new Date(at).toISOString(),
    eventKind: 'ToolExec',
    subject,
    agentRuntimeInstanceId: runtimeId,
    agentRuntimeInstanceAliases: [],
    correlation: { authority: 'server_process_graph', inferred: false },
    attribution: {
      ...(processGenerationKey ? { processGenerationKey } : {}),
      ...(parentProcessGenerationKey ? {
        parentProcessGenerationKey,
        parentLinkAuthority: 'forwarder_process_graph',
      } : {}),
    },
    process: {
      hostId: 'host-study',
      bootId: 'boot-study',
      pid,
      ppid,
      startTimeTicks,
    },
    attributes: {},
    verdict: 'allow',
    tier: 'Rules',
    severity: 'info',
    riskScore: 0,
    riskName: 'study',
    riskCategory: 'other',
    reason: 'study fixture',
  };
}

function processInstanceKey(process) {
  return `pk:${digest([
    process.hostId,
    process.bootId,
    process.pid,
    process.startTimeTicks,
  ].join('\0')).slice(0, 24)}`;
}

function normalizedCommand(value) {
  return value
    .trim()
    .replace(/^\/(?:usr\/)?bin\/(?:ba)?sh\s+-(?:l)?c\s+/u, '')
    .replace(/^["']|["']$/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function prototypeGenerationSafeRuntimeMatch(interactionRecord, candidate, candidates) {
  if (candidate.agentRuntimeInstanceId === interactionRecord.agentInstanceId) return true;
  const byKey = new Map(candidates
    .filter((item) => item.process?.processInstanceKey)
    .map((item) => [item.process.processInstanceKey, item]));
  let current = candidate;
  const seen = new Set();
  for (let depth = 0; depth < 8; depth += 1) {
    const parentKey = current.process?.parentProcessInstanceKey;
    if (!parentKey || seen.has(parentKey)) return false;
    seen.add(parentKey);
    const parent = byKey.get(parentKey);
    if (!parent) return false;
    if (parent.agentRuntimeInstanceId === interactionRecord.agentInstanceId) return true;
    current = parent;
  }
  return false;
}

function prototypeExclusiveOwnership(toolRelations) {
  const owners = new Map();
  for (const item of toolRelations) {
    for (const relation of item.relations) {
      if (!relation.kernelEventId) continue;
      const values = owners.get(relation.kernelEventId) ?? [];
      values.push({ toolCallId: item.toolCallId, toolInvocationId: relation.toolInvocationId });
      owners.set(relation.kernelEventId, values);
    }
  }
  return toolRelations.map((item) => {
    const competing = item.relations.flatMap((relation) => owners.get(relation.kernelEventId) ?? []);
    return competing.length > 1
      ? { toolCallId: item.toolCallId, status: 'ambiguous', competingToolCalls: competing.map((value) => value.toolCallId) }
      : { toolCallId: item.toolCallId, status: item.relations[0]?.status ?? 'semantic_only' };
  });
}

function prototypeContinuityBarrier(records) {
  const humanIds = records.map((record) => new Set(
    record.request.structured.input
      .filter((item) => item.role === 'user')
      .map((item) => item.id),
  ));
  const shared = [...humanIds[0]].some((id) => humanIds[1].has(id));
  return shared
    ? { conversationCount: 1, reason: 'shared_human_history' }
    : { conversationCount: records.length, reason: 'continuity_collision_without_shared_history' };
}

function observerEvent({ pid, ppid, startTimeNs, comm, exe, argv, cwd = '/workspace/evidence-chain-study' }) {
  return {
    identity: { agent: comm, task: String(pid) },
    process: {
      hostId: 'host-study',
      bootId: 'boot-study',
      pid,
      ppid,
      startTimeNs,
      comm,
      exe,
      cwd,
    },
    event: { ToolExec: { pid, ppid, uid: 1000, cwd, argv } },
  };
}

function prototypeLaunchContext(targetPid, processTable) {
  const chain = [];
  const seen = new Set();
  let pid = targetPid;
  while (pid && !seen.has(pid) && chain.length < 32) {
    seen.add(pid);
    const process = processTable.get(pid);
    if (!process) break;
    chain.push(process);
    pid = process.ppid;
  }
  chain.reverse();
  const originCandidates = [];
  const add = (type, process) => {
    if (!originCandidates.some((item) => item.type === type)) {
      originCandidates.push({ type, pid: process.pid, command: process.comm });
    }
  };
  for (const process of chain) {
    const command = process.comm.toLowerCase();
    if (command === 'systemd' || command === 'init') add('service_manager', process);
    if (command === 'sshd' || command.startsWith('sshd:')) add('ssh_session', process);
    if (['bash', 'sh', 'zsh', 'fish'].includes(command)) add('shell', process);
    if (['pm2', 'supervisord', 's6', 'runsv', 'tini'].includes(command)) add('supervisor', process);
  }
  return {
    path: chain.map((process) => ({ pid: process.pid, ppid: process.ppid, command: process.comm })),
    originCandidates,
    completeness: pid === 0 || chain[0]?.pid === 1 ? 'complete' : 'missing_parent',
  };
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function benchmarkRelationBuilders(toolCall, result, interactionRecord, candidates) {
  const currentSamples = [];
  const proposedSamples = [];
  const expected = normalizedCommand(toolCall.content.command);
  for (let attempt = 0; attempt < 7; attempt += 1) {
    let started = performance.now();
    buildSemanticKernelRelations(toolCall, result, interactionRecord, candidates, 99, false);
    currentSamples.push(performance.now() - started);

    started = performance.now();
    const matchingCommands = candidates.filter((candidate) =>
      candidate.eventKind === 'ToolExec' && normalizedCommand(candidate.subject).includes(expected));
    const withKeys = candidates.map((candidate) => ({
      ...candidate,
      process: candidate.process
        ? { ...candidate.process, processInstanceKey: processInstanceKey(candidate.process) }
        : undefined,
    }));
    const byEventId = new Map(withKeys.map((candidate) => [candidate.eventId, candidate]));
    for (const candidate of matchingCommands) {
      prototypeGenerationSafeRuntimeMatch(
        interactionRecord,
        byEventId.get(candidate.eventId),
        withKeys,
      );
    }
    proposedSamples.push(performance.now() - started);
  }
  return {
    candidateCount: candidates.length,
    implementationMedianMs: Number(median(currentSamples).toFixed(3)),
    commandFirstIndexedPrototypeMedianMs: Number(median(proposedSamples).toFixed(3)),
  };
}

// Scene 1: one continuity key is reused by two divergent, otherwise unanchored conversations.
const continuityKey = 'shared-runtime-cache-key';
const conversationA = interaction({
  id: 'mi-continuity-a',
  at: BASE,
  continuityKey,
  input: [humanMessage('msg-a', 'turn-a', 'investigate service A')],
});
const conversationB = interaction({
  id: 'mi-continuity-b',
  at: BASE + 10,
  continuityKey,
  input: [humanMessage('msg-b', 'turn-b', 'deploy service B')],
});
const currentConversationResolution = resolveAgentConversationsV2(
  [conversationA, conversationB],
  100,
);
const currentConversationCount = new Set(
  currentConversationResolution.conversationRecords.map((record) => record.conversationId),
).size;
assert.equal(
  currentConversationCount,
  2,
  'the implementation must keep divergent continuity histories in separate Conversations',
);
const proposedConversationResolution = prototypeContinuityBarrier([conversationA, conversationB]);
assert.equal(proposedConversationResolution.conversationCount, 2);

// Scene 2: an old Agent parent PID is reused by an unrelated process generation.
const command = '/usr/bin/printf generation-marker';
const pidReuseCall = semanticToolCall({
  id: 'se-pid-reuse',
  callId: 'call-pid-reuse',
  command,
});
const oldParent = kernelEvent({
  eventId: 'evt-parent-old-agent-generation',
  subject: '/usr/bin/codex parent-old',
  pid: 220,
  ppid: 100,
  startTimeTicks: '1000',
  runtimeId: RUNTIME_ID,
  processGenerationKey: `pgk_${'a'.repeat(24)}`,
  at: BASE + 50,
});
const newParent = kernelEvent({
  eventId: 'evt-parent-new-unrelated-generation',
  subject: '/usr/bin/unrelated parent-new',
  pid: 220,
  ppid: 1,
  startTimeTicks: '2000',
  runtimeId: 'runtime-unrelated',
  processGenerationKey: `pgk_${'b'.repeat(24)}`,
  at: BASE + 150,
});
const reusedPidChild = kernelEvent({
  eventId: 'evt-child-of-reused-parent',
  subject: command,
  pid: 221,
  ppid: 220,
  startTimeTicks: '2001',
  runtimeId: 'runtime-unrelated',
  processGenerationKey: `pgk_${'c'.repeat(24)}`,
  parentProcessGenerationKey: newParent.attribution.processGenerationKey,
  at: BASE + 200,
});
const currentPidReuseRelations = buildSemanticKernelRelations(
  pidReuseCall,
  semanticToolResult(pidReuseCall),
  { interactionId: 'mi-study', agentAssetId: 'agent-study', agentInstanceId: RUNTIME_ID },
  [reusedPidChild, oldParent, newParent],
  101,
  false,
);
assert.equal(currentPidReuseRelations[0].kernelEventId, undefined);
assert.equal(currentPidReuseRelations[0].status, 'semantic_only');
const proposedPidReuseMatch = prototypeGenerationSafeRuntimeMatch(
  { agentInstanceId: RUNTIME_ID },
  reusedPidChild,
  [reusedPidChild, oldParent, newParent],
);
assert.equal(
  proposedPidReuseMatch,
  false,
  'the generation-safe prototype must follow the new parent rather than the old same-PID Agent',
);

// Scene 3: two concurrent identical Tool Calls both claim one Kernel Event today.
const sharedKernelEvent = kernelEvent({
  eventId: 'evt-one-exec-two-tools',
  subject: command,
  pid: 301,
  ppid: 100,
  startTimeTicks: '3001',
  runtimeId: RUNTIME_ID,
});
const duplicateToolA = semanticToolCall({ id: 'se-duplicate-a', callId: 'call-duplicate-a', command });
const duplicateToolB = semanticToolCall({ id: 'se-duplicate-b', callId: 'call-duplicate-b', command });
const currentOwnershipBatch = buildSemanticKernelRelationBatch([
  {
    event: duplicateToolA,
    result: semanticToolResult(duplicateToolA),
    interaction: { interactionId: 'mi-study', agentAssetId: 'agent-study', agentInstanceId: RUNTIME_ID },
  },
  {
    event: duplicateToolB,
    result: semanticToolResult(duplicateToolB),
    interaction: { interactionId: 'mi-study', agentAssetId: 'agent-study', agentInstanceId: RUNTIME_ID },
  },
], [sharedKernelEvent], 102, false);
const relationA = currentOwnershipBatch.relationsBySemanticEventId.get(duplicateToolA.semanticEventId);
const relationB = currentOwnershipBatch.relationsBySemanticEventId.get(duplicateToolB.semanticEventId);
assert.equal(relationA[0].kernelEventId, sharedKernelEvent.eventId);
assert.equal(relationB[0].kernelEventId, sharedKernelEvent.eventId);
assert.equal(relationA[0].status, 'ambiguous');
assert.equal(relationB[0].status, 'ambiguous');
const proposedOwnership = prototypeExclusiveOwnership([
  { toolCallId: duplicateToolA.toolCallId, relations: relationA },
  { toolCallId: duplicateToolB.toolCallId, relations: relationB },
]);
assert.deepEqual(proposedOwnership.map((item) => item.status), ['ambiguous', 'ambiguous']);

// Scene 4: process attribution finds the Agent root but discards the launch chain above it.
const processTable = new Map([
  [1, { pid: 1, ppid: 0, startTime: '1', comm: 'systemd', exe: '/usr/lib/systemd/systemd', argv: 'systemd' }],
  [200, { pid: 200, ppid: 1, startTime: '200', comm: 'sshd', exe: '/usr/sbin/sshd', argv: 'sshd: user@pts/1' }],
  [300, { pid: 300, ppid: 200, startTime: '300', comm: 'bash', exe: '/usr/bin/bash', argv: 'bash' }],
  [400, { pid: 400, ppid: 300, startTime: '400', comm: 'codex', exe: '/usr/bin/codex', argv: 'codex' }],
  [500, { pid: 500, ppid: 400, startTime: '500', comm: 'bash', exe: '/usr/bin/bash', argv: 'bash -lc id' }],
]);
const attributor = new AgentAttributor({
  hostId: 'host-study',
  bootId: 'boot-study',
  now: () => BASE,
  readProc: (pid) => processTable.get(pid),
  listPids: () => [],
});
const currentLaunchAttribution = attributor.classify(observerEvent({
  pid: 500,
  ppid: 400,
  startTimeNs: '500',
  comm: 'bash',
  exe: '/usr/bin/bash',
  argv: ['bash', '-lc', 'id'],
}));
assert.equal(currentLaunchAttribution.state, 'agent');
assert.equal(currentLaunchAttribution.attribution.rootPid, 400);
const currentLaunchContext = attributor.runtimeSnapshot().entries[0].launchContext;
assert.deepEqual(
  currentLaunchContext.path.map((item) => item.command),
  ['systemd', 'sshd', 'bash', 'codex'],
);
assert.equal(
  currentLaunchAttribution.attribution.parentProcessGenerationKey,
  currentLaunchContext.rootProcessGenerationKey,
  'the Tool process edge must connect the Root Launch Context to the final child generation',
);
const proposedLaunchContext = prototypeLaunchContext(500, processTable);
assert.deepEqual(
  proposedLaunchContext.path.map((item) => item.command),
  ['systemd', 'sshd', 'bash', 'codex', 'bash'],
);

// Scene 5: current lifecycle fact records a bare PPID but no parent generation key.
const currentLifecycleFact = processLifecycleFact({
  eventId: 'evt-lifecycle-child',
  eventKind: 'ToolExec',
  at: BASE + 200,
  receivedAt: BASE + 205,
  source: 'observer',
  workspacePath: '/workspace/evidence-chain-study',
  process: {
    hostId: 'host-study',
    bootId: 'boot-study',
    pid: 221,
    ppid: 220,
    startTimeTicks: '2001',
    comm: 'printf',
    exe: '/usr/bin/printf',
  },
  attribution: {
    monitored: true,
    classification: 'probable_agent',
    agentScopeId: 'codex',
    agentInstanceId: RUNTIME_ID,
    rootPid: 100,
    confidence: 0.9,
    reason: 'process_lineage',
    source: 'process_graph',
    processGenerationKey: reusedPidChild.attribution.processGenerationKey,
    parentProcessGenerationKey: newParent.attribution.processGenerationKey,
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
  },
});
assert.ok(currentLifecycleFact);
assert.equal(currentLifecycleFact.ppid, 220);
assert.equal(
  currentLifecycleFact.parentProcessGenerationKey,
  newParent.attribution.processGenerationKey,
);
const proposedLineageEdge = {
  schemaVersion: 'anysentry.process_lineage_edge.v1',
  childProcessInstanceKey: currentLifecycleFact.processInstanceKey,
  parentProcessGenerationKey: newParent.attribution.processGenerationKey,
  authority: 'observer_exec_generation',
  observedAt: BASE + 200,
};
const currentLifecycleBytes = Buffer.byteLength(JSON.stringify(currentLifecycleFact));
const launchContextBytes = Buffer.byteLength(JSON.stringify(proposedLaunchContext));

const performanceCandidates = Array.from({ length: 1_500 }, (_, index) => kernelEvent({
  eventId: `evt-performance-${index}`,
  subject: `/usr/bin/printf unrelated-${index}`,
  pid: 10_000 + index,
  ppid: index === 0 ? 1 : 9_999 + index,
  startTimeTicks: String(10_000 + index),
  runtimeId: 'runtime-unrelated',
  at: BASE + 200,
}));
performanceCandidates.push(sharedKernelEvent);
const benchmark = benchmarkRelationBuilders(
  duplicateToolA,
  semanticToolResult(duplicateToolA),
  { interactionId: 'mi-study', agentAssetId: 'agent-study', agentInstanceId: RUNTIME_ID },
  performanceCandidates,
);
const baselineMedianMs = Number(baselineResults.benchmark.currentMedianMs);
assert.ok(
  benchmark.implementationMedianMs <= baselineMedianMs,
  `the indexed implementation median ${benchmark.implementationMedianMs}ms exceeded the saved baseline ${baselineMedianMs}ms`,
);

const result = {
  schemaVersion: 'anysentry.witr_evidence_chain_implementation.v1',
  baselineCommit: '05597c5109ebef999cf1fcbcc78a50d301516f81',
  implementationBranch: 'research/witr-attribution-evidence-chain',
  scenes: {
    continuityCollision: {
      baseline: baselineResults.scenes.continuityCollision.current,
      implemented: {
        conversationCount: currentConversationCount,
        collisionEvidence: currentConversationResolution.memberships
          .flatMap((membership) => membership.evidence)
          .includes('continuity_collision_without_shared_history'),
        outcome: 'divergent Human histories remain separate despite one reused continuity key',
      },
      target: proposedConversationResolution,
    },
    reusedParentPid: {
      baseline: baselineResults.scenes.reusedParentPid.current,
      implemented: {
        status: currentPidReuseRelations[0].status,
        linkedKernelEventId: currentPidReuseRelations[0].kernelEventId,
        outcome: 'the exact new parent generation blocks the old same-PID Agent parent',
      },
      target: {
        matched: proposedPidReuseMatch,
        outcome: 'exact parent ProcessInstanceKey follows the new unrelated generation',
      },
    },
    duplicateToolOwnership: {
      baseline: baselineResults.scenes.duplicateToolOwnership.current,
      implemented: {
        toolAStatus: relationA[0].status,
        toolBStatus: relationB[0].status,
        sharedKernelEventId: sharedKernelEvent.eventId,
        competingToolInvocationCount: relationA[0].competingToolInvocationIds.length,
      },
      target: proposedOwnership,
    },
    launchContext: {
      baseline: baselineResults.scenes.launchContext.current,
      implemented: {
        agentRootPid: currentLaunchAttribution.attribution.rootPid,
        attributionSource: currentLaunchAttribution.attribution.source,
        evidence: currentLaunchAttribution.attribution.evidence,
        launchPathAvailable: true,
        launchContext: currentLaunchContext,
        toolProcessEdge: {
          processGenerationKey: currentLaunchAttribution.attribution.processGenerationKey,
          parentProcessGenerationKey: currentLaunchAttribution.attribution.parentProcessGenerationKey,
          authority: currentLaunchAttribution.attribution.parentLinkAuthority,
        },
        reconstructedPath: [
          ...currentLaunchContext.path.map((item) => item.command),
          'bash',
        ],
      },
      target: proposedLaunchContext,
    },
    lifecycleParentIdentity: {
      baseline: baselineResults.scenes.lifecycleParentIdentity.current,
      implemented: {
        processInstanceKey: currentLifecycleFact.processInstanceKey,
        processGenerationKey: currentLifecycleFact.processGenerationKey,
        ppid: currentLifecycleFact.ppid,
        parentProcessGenerationKey: currentLifecycleFact.parentProcessGenerationKey,
        parentLinkAuthority: currentLifecycleFact.parentLinkAuthority,
        jsonBytes: currentLifecycleBytes,
      },
      target: {
        ...proposedLineageEdge,
        jsonBytes: Buffer.byteLength(JSON.stringify(proposedLineageEdge)),
        additiveFieldBytes: baselineResults.scenes.lifecycleParentIdentity.proposed.additiveFieldBytes,
        launchContextFixtureBytes: launchContextBytes,
      },
    },
  },
  benchmark: {
    ...benchmark,
    savedBaselineMedianMs: baselineMedianMs,
    speedupAgainstSavedBaseline: Number((baselineMedianMs / benchmark.implementationMedianMs).toFixed(2)),
  },
  notes: [
    'The baseline object is preserved in study-results.json; this output exercises the native implementation.',
    'The timing result is a local synthetic command-linking microbenchmark, not a production capacity claim.',
    'LaunchContext is stored once per Agent Root; the final Tool process is connected by its parent generation edge rather than duplicating the full path on every event.',
  ],
};

console.log(JSON.stringify(
  process.env.ANYSENTRY_STUDY_OUTPUT === 'benchmark' ? result.benchmark : result,
  null,
  2,
));
