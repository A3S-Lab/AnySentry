import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  SessionEventAttributionService,
} from '../apps/api/dist/security-monitoring/session-event-attribution.service.js';
import {
  ClickHouseStore,
} from '../apps/api/dist/security-monitoring/clickhouse-store.js';
import {
  eventSessionRelationId,
  SESSION_EVENT_ATTRIBUTION_ALGORITHM,
  SESSION_EVENT_ATTRIBUTION_VERSION,
} from '../apps/api/dist/security-monitoring/session-event-attribution.types.js';

const now = 1_800_000_000_000;

const fact = ({
  eventId,
  processInstanceKey,
  pid,
  ppid,
  namespacePpid,
  startTime,
  pidNamespace = 'pidns-a',
  runtimeInstanceId = 'agent-a',
  rootProcess = false,
  factKind = 'exec',
  at = now + pid,
}) => ({
  schemaVersion: 'anysentry.process_lifecycle_fact.v1',
  factId: `fact-${eventId}`,
  eventId,
  factKind,
  at,
  receivedAt: at,
  source: 'observer',
  sourceId: 'source-a',
  collectorId: 'collector-a',
  workspacePath: '/workspace',
  runtimeInstanceId,
  rootProcess,
  processInstanceKey,
  hostId: 'host-a',
  bootId: 'boot-a',
  pid,
  ...(ppid ? { ppid } : {}),
  pidNamespace,
  namespacePid: pid,
  ...(namespacePpid ? { namespacePpid } : {}),
  startTime,
});

const rootFact = fact({
  eventId: 'event-root',
  processInstanceKey: 'pri_111111111111111111111111',
  pid: 100,
  startTime: 'ticks:1000',
  rootProcess: true,
});
const childFact = fact({
  eventId: 'event-child',
  processInstanceKey: 'pri_222222222222222222222222',
  pid: 101,
  ppid: 100,
  namespacePpid: 100,
  startTime: 'ticks:1001',
});
const grandchildFact = fact({
  eventId: 'event-grandchild',
  processInstanceKey: 'pri_333333333333333333333333',
  pid: 102,
  ppid: 101,
  namespacePpid: 101,
  startTime: 'ticks:1002',
});
const namespacedSandboxFact = fact({
  eventId: 'event-namespaced-sandbox',
  processInstanceKey: 'pri_444444444444444444444444',
  pid: 103,
  ppid: 102,
  namespacePpid: 1,
  pidNamespace: 'pidns-bwrap',
  startTime: 'ticks:1003',
});
const unrelatedFact = fact({
  eventId: 'event-unrelated',
  processInstanceKey: 'pri_999999999999999999999999',
  pid: 999,
  startTime: 'ticks:9999',
  runtimeInstanceId: 'agent-other',
});

function judgedEvent(eventId, pid, at = now + pid, eventKind = 'ToolExec') {
  return {
    eventId,
    sourceEventId: eventId,
    eventKind,
    eventCategory: eventKind,
    source: 'observer',
    at,
    receivedAt: at,
    agentId: 'codex',
    workspacePath: '/workspace',
    sessionId: '',
    runId: '',
    traceId: '',
    spanId: '',
    subject: `/usr/bin/tool-${pid}`,
    process: { pid, ppid: pid === 101 ? 100 : undefined },
    attributes: { command: `/usr/bin/tool-${pid}` },
    verdict: 'allow',
    severity: 'info',
    tier: 'L1',
    riskScore: 0,
    reasons: [],
    decisionRevision: 3,
    decisionUpdatedAt: now + pid,
  };
}

function stores(facts, competingBindings = [], observedEvents = []) {
  const writes = {
    bindings: [],
    edges: [],
    results: [],
    relations: [],
    reconciliations: [],
    observedReads: [],
  };
  const factByEventId = new Map(facts.map((item) => [item.eventId, item]));
  const observedByEventId = new Map(observedEvents.map((item) => [item.event.eventId, item.event]));
  const clickhouse = {
    searchEvents: async () => [],
    readSessionProcessLifecycleCandidates: async () => facts,
    readSessionProcessFamilyFacts: async () => facts,
    readSessionProcessObservedEvents: async (input) => {
      writes.observedReads.push(input);
      return observedEvents;
    },
    eventsByIds: async (ids) => ids.map((id) =>
      observedByEventId.get(id) ?? judgedEvent(
        id,
        factByEventId.get(id)?.pid ?? 100,
        factByEventId.get(id)?.at,
      )),
  };
  const relational = {
    loadLatestSessionProcessBinding: async () => undefined,
    loadSessionProcessBindingForGeneration: async () => undefined,
    saveSessionProcessBindings: async (items) => {
      writes.bindings.push(...items);
      return true;
    },
    loadSessionProcessBindings: async () => competingBindings,
    saveProcessLineageEdges: async (items) => {
      writes.edges.push(...items);
      return true;
    },
    saveEventSessionAttributionResults: async (items) => {
      writes.results.push(...items);
      return true;
    },
    saveEventSessionRelations: async (items) => {
      writes.relations.push(...items);
      return true;
    },
    reconcileEventSessionRelations: async (results, relations, calculatedAt) => {
      writes.reconciliations.push({ results, relations, calculatedAt });
      return true;
    },
  };
  return { clickhouse, relational, writes };
}

const baseStores = stores([rootFact, childFact, unrelatedFact]);
const service = new SessionEventAttributionService(
  baseStores.clickhouse,
  baseStores.relational,
);
const binding = await service.resolveBinding({
  runtimeType: 'codex',
  nativeSessionId: 'native-session-a',
  matchedPid: 100,
  matchedStartTime: 'ticks:1000',
  validFrom: now,
}, { since: now - 1_000, until: now + 10_000 });
assert.ok(binding, 'FD + lifecycle facts must resolve without LLM request metadata');
assert.equal(binding.matchedOsProcessInstanceKey, rootFact.processInstanceKey);
assert.equal(binding.agentInstanceId, 'agent-a');
assert.match(binding.conversationId, /^conv_local_/u);

const exactCommand = '/usr/bin/printf UNIQUE_SESSION_MARKER';
const exactToolEvent = {
  ...judgedEvent('event-exact-tool', 301, now + 2_000),
  collectorId: 'collector-a',
  subject: exactCommand,
  workspacePath: '/workspace',
  process: {
    pid: 301,
    ppid: 300,
    hostId: 'host-a',
    bootId: 'boot-a',
    pidNamespace: 'pidns-tool',
    namespacePid: 2,
    namespacePpid: 1,
    startTimeTicks: '3001',
  },
};
const exactToolStores = stores([]);
exactToolStores.clickhouse.searchEvents = async () => [exactToolEvent];
const exactToolService = new SessionEventAttributionService(
  exactToolStores.clickhouse,
  exactToolStores.relational,
);
const exactToolBindings = await exactToolService.resolveBindingsFromExactToolExec({
  runtimeType: 'a3s_code',
  nativeSessionId: 'native-a3s-session',
  workspacePath: '/workspace',
  validFrom: now,
  validTo: now + 10_000,
  anchors: [{ command: exactCommand, since: now + 1_000, until: now + 3_000 }],
}, { persist: false });
assert.equal(exactToolBindings.length, 1);
assert.equal(exactToolBindings[0].method, 'tool_exec_exact');
assert.equal(exactToolBindings[0].matchedPid, 301);

// SQLite-backed OpenCode requires independent runtime evidence plus the complete kernel
// command hash; capped display subjects and a DB FD are not Session identity evidence.
const { createHash } = await import('node:crypto');
const openCodeHash = createHash('sha256').update(exactCommand).digest('hex');
const openCodeStores = stores([]);
let openCodeEvent = { ...exactToolEvent, subject: '/bin/bash -c [display truncated]',
  attribution: { ...exactToolEvent.attribution, agentScopeId: 'opencode' },
  attributes: { 'anysentry.kernel.command_hash': openCodeHash, exec_confirmed: true, argv_truncated: false, argv_incomplete: false } };
openCodeStores.clickhouse.searchEvents = async query => {
  assert.deepEqual(query.evidenceCommandHashes, [openCodeHash]);
  return [openCodeEvent];
};
const openCodeInput = { runtimeType: 'opencode', nativeSessionId: 'native-opencode', validFrom: now, validTo: now + 10_000,
  anchors: [{ command: exactCommand, since: now + 1_000, until: now + 3_000 }] };
const openCodeService = new SessionEventAttributionService(openCodeStores.clickhouse, openCodeStores.relational);
assert.equal((await openCodeService.resolveBindingsFromExactToolExec(openCodeInput, { persist: false })).length, 1);
openCodeEvent = { ...openCodeEvent, attributes: { ...openCodeEvent.attributes, argv_incomplete: true } };
assert.equal((await openCodeService.resolveBindingsFromExactToolExec(openCodeInput, { persist: false })).length, 0);
openCodeEvent = { ...openCodeEvent, attributes: { ...openCodeEvent.attributes, argv_incomplete: false },
  attribution: { ...openCodeEvent.attribution, agentScopeId: 'codex' } };
assert.equal((await openCodeService.resolveBindingsFromExactToolExec(openCodeInput, { persist: false })).length, 0);

// Claude does not hold its session jsonl open. Match the kernel hash of the bash -c script,
// not the 80-character display subject, and do not require the child comm to be claude.
const claudeScript = '/usr/bin/printf "%s\\n" "ANYSENTRY_CLAUDE_KERNEL_0923"; /usr/bin/sleep 3';
const claudeCommand = `/usr/bin/bash -c '${claudeScript}'`;
const claudeHash = createHash('sha256').update(claudeScript).digest('hex');
const claudeStores = stores([]);
const claudeEvent = {
  ...exactToolEvent,
  subject: '/usr/bin/bash -c /usr/bin/printf "%s\\n" "ANYSENTRY_CLAUDE_KERNEL',
  attribution: { ...exactToolEvent.attribution, agentScopeId: 'bash' },
  attributes: {
    'anysentry.kernel.command_hash': claudeHash,
    exec_confirmed: true,
    argv_truncated: false,
    argv_incomplete: false,
  },
};
claudeStores.clickhouse.searchEvents = async query => {
  assert.deepEqual(query.evidenceCommandHashes, [claudeHash]);
  return [claudeEvent];
};
const claudeService = new SessionEventAttributionService(claudeStores.clickhouse, claudeStores.relational);
assert.equal((await claudeService.resolveBindingsFromExactToolExec({
  runtimeType: 'claude_code',
  nativeSessionId: 'native-claude',
  workspacePath: '/workspace',
  validFrom: now,
  validTo: now + 10_000,
  anchors: [{ command: claudeCommand, since: now + 1_000, until: now + 3_000 }],
}, { persist: false })).length, 1);
claudeEvent.attributes = { ...claudeEvent.attributes, argv_truncated: true };
assert.equal((await claudeService.resolveBindingsFromExactToolExec({
  runtimeType: 'claude_code',
  nativeSessionId: 'native-claude',
  workspacePath: '/workspace',
  validFrom: now,
  validTo: now + 10_000,
  anchors: [{ command: claudeCommand, since: now + 1_000, until: now + 3_000 }],
}, { persist: false })).length, 0);

const ambiguousToolStores = stores([]);
ambiguousToolStores.clickhouse.searchEvents = async () => [
  exactToolEvent,
  {
    ...exactToolEvent,
    eventId: 'event-exact-tool-competing',
    process: { ...exactToolEvent.process, pid: 401, startTimeTicks: '4001' },
  },
];
const ambiguousToolBindings = await new SessionEventAttributionService(
  ambiguousToolStores.clickhouse,
  ambiguousToolStores.relational,
).resolveBindingsFromExactToolExec({
  runtimeType: 'a3s_code',
  nativeSessionId: 'native-a3s-ambiguous',
  workspacePath: '/workspace',
  validFrom: now,
  validTo: now + 10_000,
  anchors: [{ command: exactCommand, since: now + 1_000, until: now + 3_000 }],
}, { persist: false });
assert.equal(
  ambiguousToolBindings.length,
  0,
  'an exact command observed in competing process generations must remain unattributed',
);

const coldStartBinding = await service.resolveBinding({
  runtimeType: 'codex',
  nativeSessionId: 'native-session-cold-start',
  matchedPid: 100,
  matchedStartTime: 'ticks:1000',
  validFrom: now + 500,
}, { since: now - 1_000, until: now + 10_000 });
assert.equal(
  coldStartBinding?.validFrom,
  rootFact.at,
  'binding must begin at the exact process generation fact when Codex starts before Session JSONL',
);

const persistedGenerationStores = stores([]);
persistedGenerationStores.clickhouse.readSessionProcessLifecycleCandidates = async () => {
  throw new Error('a verified generation must not rescan ClickHouse candidates');
};
persistedGenerationStores.relational.loadSessionProcessBindingForGeneration = async () => binding;
const reusedGenerationBinding = await new SessionEventAttributionService(
  persistedGenerationStores.clickhouse,
  persistedGenerationStores.relational,
).resolveBinding({
  runtimeType: 'codex',
  nativeSessionId: binding.nativeSessionId,
  matchedPid: binding.matchedPid,
  matchedStartTime: binding.matchedStartTime,
  validFrom: binding.validFrom,
  method: binding.method,
  confidence: binding.confidence,
  observedIdentity: {
    hostId: binding.hostId,
    bootId: binding.bootId,
    processInstanceKey: binding.matchedOsProcessInstanceKey,
    pidNamespace: binding.pidNamespace,
  },
}, { since: now, until: now + 10_000 });
assert.equal(reusedGenerationBinding?.bindingId, binding.bindingId);
assert.equal(
  reusedGenerationBinding?.matchedOsProcessInstanceKey,
  binding.matchedOsProcessInstanceKey,
  'background reconciliation must reuse an exact durable PID generation binding',
);

for (const scope of [undefined, { hostId: 'another-host', bootId: binding.bootId },
  { hostId: binding.hostId, bootId: 'another-boot' }]) {
  const scopedStores = stores([]);
  scopedStores.relational.loadSessionProcessBindingForGeneration = async () => binding;
  const resolved = await new SessionEventAttributionService(
    scopedStores.clickhouse, scopedStores.relational,
  ).resolveBinding({
    runtimeType: 'codex', nativeSessionId: binding.nativeSessionId,
    matchedPid: binding.matchedPid, matchedStartTime: binding.matchedStartTime,
    validFrom: binding.validFrom,
    ...(scope ? { observedIdentity: {
      ...scope, processInstanceKey: 'different-scoped-process',
    } } : {}),
  }, { since: now, until: now + 10_000 });
  assert.notEqual(resolved?.bindingId, binding.bindingId,
    'PID/ticks alone or a foreign host/boot must never reuse the old binding');
}

const weakChildFact = {
  ...childFact,
  eventId: 'event-weak-child',
  factId: 'fact-event-weak-child',
  runtimeInstanceId: undefined,
};
const weakChildStores = stores([weakChildFact]);
const weakChildBinding = await new SessionEventAttributionService(
  weakChildStores.clickhouse,
  weakChildStores.relational,
).resolveBinding({
  runtimeType: 'codex',
  nativeSessionId: 'native-session-weak-child',
  matchedPid: 100,
  matchedStartTime: 'ticks:1000',
  validFrom: now,
}, { since: now - 1_000, until: now + 10_000 });
assert.equal(
  weakChildBinding,
  undefined,
  'PID/PPID/time-only children must not reconstruct a Session root without Observer runtime identity',
);

const competingRuntimeStores = stores([
  childFact,
  {
    ...childFact,
    eventId: 'event-competing-runtime-child',
    factId: 'fact-event-competing-runtime-child',
    processInstanceKey: 'pri_competing_runtime_child',
    pid: 104,
    startTime: 'ticks:1004',
    runtimeInstanceId: 'agent-other',
  },
]);
const competingRuntimeBinding = await new SessionEventAttributionService(
  competingRuntimeStores.clickhouse,
  competingRuntimeStores.relational,
).resolveBinding({
  runtimeType: 'codex',
  nativeSessionId: 'native-session-competing-runtime',
  matchedPid: 100,
  matchedStartTime: 'ticks:1000',
  validFrom: now,
}, { since: now - 1_000, until: now + 10_000 });
assert.equal(
  competingRuntimeBinding,
  undefined,
  'children from competing runtime instances must not reconstruct one Session root',
);

const partialObserverIdentityBinding = await service.resolveBinding({
  runtimeType: 'codex_ebpf_rustls',
  nativeSessionId: 'native-session-observer-partial-identity',
  conversationId: 'conv-observed-partial-identity',
  matchedPid: 100,
  matchedStartTime: 'ticks:1000',
  validFrom: now,
  observedIdentity: {
    // This key intentionally represents an Observer Interaction record produced without the
    // pid-namespace fields that are present on the lifecycle event.
    processInstanceKey: 'pri_partial_observer_tuple',
    hostId: 'host-a',
    bootId: 'boot-a',
  },
}, { since: now - 1_000, until: now + 10_000 });
assert.equal(
  partialObserverIdentityBinding?.matchedOsProcessInstanceKey,
  rootFact.processInstanceKey,
  'a partial Observer identity must reconcile to the unique namespace-complete lifecycle fact',
);
assert.equal(partialObserverIdentityBinding?.pidNamespace, 'pidns-a');

// A long-running Harbor root can age out of the lifecycle query window. Alternating
// complete FD metadata and legacy partial Interaction metadata must not split it.
const stableCandidate = {
  runtimeType: binding.runtimeType, nativeSessionId: binding.nativeSessionId,
  matchedPid: binding.matchedPid, matchedStartTime: binding.matchedStartTime,
  validFrom: binding.validFrom, method: binding.method,
  observedIdentity: { hostId: binding.hostId, bootId: binding.bootId,
    processInstanceKey: 'pri_legacy_partial' },
};
const stableService = new SessionEventAttributionService(
  persistedGenerationStores.clickhouse, persistedGenerationStores.relational,
);
for (let round = 0; round < 6; round += 1) {
  const result = await stableService.resolveBinding({ ...stableCandidate,
    observedIdentity: round % 2 ? stableCandidate.observedIdentity : {
      ...stableCandidate.observedIdentity, pidNamespace: binding.pidNamespace,
      processInstanceKey: binding.matchedOsProcessInstanceKey,
    },
  }, { since: now + 120_000, until: now + 240_000 });
  assert.equal(result?.bindingId, binding.bindingId, 'aged root must retain its complete binding');
  assert.equal(result?.matchedOsProcessInstanceKey, binding.matchedOsProcessInstanceKey);
}
for (const previous of [undefined, { ...binding, pidNamespace: undefined,
  matchedOsProcessInstanceKey: 'pri_legacy_partial' }]) {
  const missing = stores([]);
  missing.relational.loadSessionProcessBindingForGeneration = async () => previous;
  assert.equal(await new SessionEventAttributionService(missing.clickhouse, missing.relational)
    .resolveBinding(stableCandidate, { since: now, until: now + 10_000 }), undefined,
  'missing lifecycle or a weak historical binding cannot authorize a namespace-free identity');
}
for (const changed of [{ matchedStartTime: 'ticks:9999' }, { matchedPid: 999 },
  { collectorId: 'another-collector' }, { nativeSessionId: 'another-session' }]) {
  const guarded = stores([]);
  guarded.relational.loadSessionProcessBindingForGeneration = async () => binding;
  assert.equal(await new SessionEventAttributionService(guarded.clickhouse, guarded.relational)
    .resolveBinding({ ...stableCandidate, ...changed }, { since: now, until: now + 10_000 }),
  undefined, 'PID reuse and foreign Session/collector must not inherit the durable binding');
}
const conflictingNamespaces = stores([rootFact, { ...rootFact,
  eventId: 'other-namespace', pidNamespace: 'another-namespace',
  processInstanceKey: 'pri_other_namespace' }]);
assert.equal(await new SessionEventAttributionService(
  conflictingNamespaces.clickhouse, conflictingNamespaces.relational,
).resolveBinding(stableCandidate, { since: now, until: now + 10_000 }), undefined,
'multiple complete namespaces must remain ambiguous');
console.log('PASS six alternating metadata rounds, aged roots, weak history and scope guards');

const a3sFileStores = stores([rootFact, childFact]);
a3sFileStores.clickhouse.readSessionFileWriteEvents = async () => [{
  ...judgedEvent('event-a3s-session-write', 100, now + 20, 'FileAccess'),
  agentId: 'a3s code',
  collectorId: 'collector-a',
  process: {
    pid: 100,
    ppid: 1,
    hostId: 'host-a',
    bootId: 'boot-a',
    pidNamespace: 'pidns-a',
    startTimeTicks: '1000',
  },
  attribution: {
    agentScopeId: 'a3s code',
    agentInstanceId: 'agent-a',
  },
  attributes: {
    path: '/workspace/.a3s/tui/sessions/a3s-session.json',
    write: true,
    accessMode: 'write_only',
  },
}];
const a3sFileService = new SessionEventAttributionService(
  a3sFileStores.clickhouse,
  a3sFileStores.relational,
);
const a3sFileBinding = await a3sFileService.resolveBindingFromSessionFile({
  runtimeType: 'a3s_code',
  nativeSessionId: 'a3s-session',
  sessionPaths: ['/workspace/.a3s/tui/sessions/a3s-session.json'],
  validFrom: now,
}, { since: now - 1_000, until: now + 10_000 });
assert.ok(a3sFileBinding, 'an exact A3S Session write must recover the process generation');
assert.equal(a3sFileBinding.method, 'ebpf_session_file');
assert.equal(a3sFileBinding.runtimeType, 'a3s_code');
assert.equal(a3sFileBinding.matchedOsProcessInstanceKey, rootFact.processInstanceKey);
const firstA3sWriteEvents = await a3sFileStores.clickhouse.readSessionFileWriteEvents();
a3sFileStores.clickhouse.readSessionFileWriteEvents = async () => [
  ...firstA3sWriteEvents,
  {
    ...judgedEvent('event-a3s-competing-write', 101, now + 21, 'FileAccess'),
    agentId: 'a3s code',
    collectorId: 'collector-a',
    process: {
      pid: 101,
      ppid: 100,
      hostId: 'host-a',
      bootId: 'boot-a',
      pidNamespace: 'pidns-a',
      startTimeTicks: '1001',
    },
    attribution: { agentScopeId: 'a3s code', agentInstanceId: 'agent-a' },
    attributes: {
      path: '/workspace/.a3s/tui/sessions/a3s-session.json',
      write: true,
      accessMode: 'write_only',
    },
  },
];
assert.equal(await a3sFileService.resolveBindingFromSessionFile({
  runtimeType: 'a3s_code',
  nativeSessionId: 'a3s-session',
  sessionPaths: ['/workspace/.a3s/tui/sessions/a3s-session.json'],
  validFrom: now,
}, { since: now - 1_000, until: now + 10_000 }), undefined,
'multiple A3S Session writer generations must remain unbound');

const mixedUnitRoot = {
  ...rootFact,
  processInstanceKey: 'pri_mixed_unit_root',
  startTime: 'ns:10000000000',
};
const mixedUnitStores = stores([mixedUnitRoot, childFact]);
mixedUnitStores.clickhouse.readSessionFileWriteEvents = async () => [{
  ...judgedEvent('event-kimi-session-write', 100, now + 20, 'FileAccess'),
  agentId: 'kimi-cli',
  collectorId: 'collector-a',
  process: {
    pid: 100,
    ppid: 1,
    hostId: 'host-a',
    bootId: 'boot-a',
    startTimeTicks: '1000',
  },
  attribution: { agentScopeId: 'kimi-cli', agentInstanceId: 'agent-a' },
  attributes: {
    path: '/logs/agent/.kimi-code/sessions/wd_app/session-kimi/agents/main/wire.jsonl',
    write: true,
    accessMode: 'write_only',
  },
}];
const mixedUnitService = new SessionEventAttributionService(
  mixedUnitStores.clickhouse,
  mixedUnitStores.relational,
);
const mixedUnitBinding = await mixedUnitService.resolveBindingFromSessionFile({
  runtimeType: 'kimi_cli',
  nativeSessionId: 'session-kimi',
  sessionPaths: [],
  pathMarkers: ['/session-kimi/'],
  validFrom: now,
}, { since: now - 1_000, until: now + 10_000 });
assert.ok(mixedUnitBinding, 'Session ticks must match the same lifecycle generation in ns');
assert.equal(mixedUnitBinding.matchedStartTime, mixedUnitRoot.startTime);
assert.equal(mixedUnitBinding.matchedOsProcessInstanceKey, mixedUnitRoot.processInstanceKey);
assert.equal(await mixedUnitService.resolveBinding({
  runtimeType: 'kimi_cli',
  nativeSessionId: 'session-kimi',
  matchedPid: 100,
  matchedStartTime: 'ticks:1002',
  validFrom: now,
  observedIdentity: {
    processInstanceKey: 'pri_wrong_generation',
    hostId: 'host-a',
    bootId: 'boot-a',
  },
}, { since: now - 1_000, until: now + 10_000 }), undefined,
'a different tick generation must not be merged by unit compatibility');

const revisionStores = stores([rootFact, childFact]);
revisionStores.relational.loadLatestSessionProcessBinding = async () => binding;
const revisionService = new SessionEventAttributionService(
  revisionStores.clickhouse,
  revisionStores.relational,
);
const unchangedBinding = await revisionService.resolveBinding({
  runtimeType: 'codex',
  nativeSessionId: 'native-session-a',
  matchedPid: 100,
  matchedStartTime: 'ticks:1000',
  validFrom: now,
}, { since: now - 1_000, until: now + 10_000 });
assert.equal(unchangedBinding.bindingRevision, 1, 'unchanged binding must remain idempotent');
const closedBinding = await revisionService.resolveBinding({
  runtimeType: 'codex',
  nativeSessionId: 'native-session-a',
  matchedPid: 100,
  matchedStartTime: 'ticks:1000',
  validFrom: now,
  validTo: now + 5_000,
}, { since: now - 1_000, until: now + 10_000 });
assert.equal(closedBinding.bindingRevision, 2, 'semantic binding change must create a revision');

const childOnlyStores = stores([childFact]);
const childOnlyBinding = await new SessionEventAttributionService(
  childOnlyStores.clickhouse,
  childOnlyStores.relational,
).resolveBinding({
  runtimeType: 'codex',
  nativeSessionId: 'native-session-child-only',
  matchedPid: 100,
  matchedStartTime: 'ticks:1000',
  validFrom: now,
}, { since: now - 1_000, until: now + 10_000 });
assert.ok(
  childOnlyBinding,
  'a direct child fact must bind a Session whose FD-matched root emitted no lifecycle fact',
);
assert.notEqual(childOnlyBinding.matchedOsProcessInstanceKey, childFact.processInstanceKey);

const serviceTimeWindows = [
  { sinceMs: now - 500, untilMs: now + 500 },
  { sinceMs: now + 5_000, untilMs: now + 6_000 },
];
const evidence = await service.evidence(binding, {
  since: now - 1_000,
  until: now + 10_000,
}, serviceTimeWindows);
assert.deepEqual(
  baseStores.writes.observedReads[0]?.timeWindows,
  serviceTimeWindows,
  'Session attribution must forward Native Turn windows to the observed-event query',
);
assert.equal(evidence.counts.direct, 1);
assert.equal(evidence.counts.lineage, 1);
assert.equal(evidence.events.length, 2);
assert.ok(baseStores.writes.relations.every((item) => item.active));
assert.equal(baseStores.writes.reconciliations.length, 1);
assert.deepEqual(
  new Set(baseStores.writes.relations.map((item) => item.relation)),
  new Set(['DIRECT', 'LINEAGE']),
);

// Persisted relations are written incrementally and may contain only an older prefix/suffix of a
// busy Session. They must not shadow a bounded live read merely because at least one row exists.
const stalePersistedStores = stores([rootFact, childFact]);
let stalePersistedReads = 0;
stalePersistedStores.relational.loadActiveEventSessionRelations = async () => [{
  ...baseStores.writes.relations.find((item) => item.eventId === rootFact.eventId),
}];
stalePersistedStores.relational.loadProcessLineageEdgesForProcesses = async () => [];
stalePersistedStores.clickhouse.readSessionProcessObservedEvents = async (input) => {
  stalePersistedReads += 1;
  stalePersistedStores.writes.observedReads.push(input);
  return [];
};
const stalePersistedEvidence = await new SessionEventAttributionService(
  stalePersistedStores.clickhouse,
  stalePersistedStores.relational,
).evidence(
  binding,
  { since: now - 1_000, until: now + 10_000 },
  undefined,
  250,
  { persist: false },
);
assert.equal(stalePersistedReads, 1, 'interactive evidence must still execute its live family read');
assert.equal(stalePersistedEvidence.persistence, 'not_checked',
  'read-only computation must not report a database persistence failure');
assert.deepEqual(
  new Set(stalePersistedEvidence.events.map((item) => item.eventId)),
  new Set([rootFact.eventId, childFact.eventId]),
  'an incomplete persisted relation set must not hide newer family events',
);

const namespacedStores = stores([
  rootFact,
  childFact,
  grandchildFact,
  namespacedSandboxFact,
]);
const namespacedEvidence = await new SessionEventAttributionService(
  namespacedStores.clickhouse,
  namespacedStores.relational,
).evidence(binding, { since: now - 1_000, until: now + 10_000 });
assert.ok(
  namespacedEvidence.events.some((item) =>
    item.eventId === namespacedSandboxFact.eventId && item.relation === 'LINEAGE'),
  'a host-PID parent edge must survive a bwrap/container PID-namespace transition',
);
assert.equal(
  baseStores.writes.results.some((item) => item.eventId === 'event-unrelated'),
  false,
  'detail-page attribution must not write unrelated platform events as UNATTRIBUTED',
);

// A partial lifecycle projection must not suppress the compatibility read. Real Codex execution
// commonly projects the root and first sandbox process while deeper bwrap/command events remain
// available only in the immutable event table.
const hybridStore = new ClickHouseStore();
hybridStore.ready = true;
hybridStore.client = {
  query: async ({ query, query_params: params }) => {
    const values = params.values ?? [];
    let rows = [];
    if (query.includes('processInstanceKey IN')) {
      if (values.includes(rootFact.processInstanceKey)) rows.push(rootFact);
      if (values.includes(childFact.processInstanceKey)) rows.push(childFact);
    } else if (query.includes('ppid IN') && values.includes(rootFact.pid)) {
      rows = [childFact];
    }
    return { json: async () => rows };
  },
};
const legacyFrontiers = [];
const hybridLegacyCalls = [];
hybridStore.readLegacySessionProcessEventFacts = async ({
  processPids,
  parentPids,
  excludedEventIds,
}) => {
  legacyFrontiers.push([...parentPids]);
  hybridLegacyCalls.push({ processPids, parentPids, excludedEventIds });
  return parentPids.includes(childFact.pid) ? [grandchildFact] : [];
};
const recoveredFacts = [];
hybridStore.writeProcessLifecycleFacts = async (items) => {
  recoveredFacts.push(...items);
  return true;
};
const hybridFacts = await hybridStore.readSessionProcessFamilyFacts({
  rootProcessInstanceKey: rootFact.processInstanceKey,
  rootPid: rootFact.pid,
  hostId: rootFact.hostId,
  bootId: rootFact.bootId,
  pidNamespace: rootFact.pidNamespace,
  sinceMs: now - 1_000,
  untilMs: now + 10_000,
});
assert.deepEqual(
  new Set(hybridFacts.map((item) => item.eventId)),
  new Set(['event-root', 'event-child', 'event-grandchild']),
  'partial projections must be merged with raw-event descendants',
);
assert.ok(
  legacyFrontiers.some((pids) => pids.includes(childFact.pid)),
  'the compatibility walk must expand a projected child frontier',
);
assert.deepEqual(
  hybridLegacyCalls[0].processPids,
  [],
  'the hybrid compatibility read must not reload already-projected process events',
);
assert.ok(
  hybridLegacyCalls[0].excludedEventIds.includes(rootFact.eventId)
    && hybridLegacyCalls[0].excludedEventIds.includes(childFact.eventId),
  'the hybrid compatibility read must exclude already-projected event ids',
);
assert.deepEqual(
  recoveredFacts.map((item) => item.eventId),
  ['event-grandchild'],
  'only missing raw-event facts should be backfilled into the lifecycle projection',
);

// A long-lived root has many old direct children. A bounded page must reserve capacity for
// descendants of its newest children rather than exhausting the whole budget at depth one.
const busyStore = new ClickHouseStore();
busyStore.ready = true;
const oldSiblings = Array.from({length:80},(_,i)=>fact({eventId:`old-${i}`,
  processInstanceKey:`pri_${(i+1000).toString(16).padStart(24,'0')}`,pid:200+i,ppid:100,
  startTime:`ticks:${1100+i}`,at:now-1000+i}));
const busyRows=[rootFact,...oldSiblings,childFact,grandchildFact];
busyStore.client={query:async({query,query_params:p})=>{
  let rows=busyRows.filter(f=>query.includes('processInstanceKey IN')?p.values.includes(f.processInstanceKey)
    :query.includes('ppid IN')?p.values.includes(f.ppid):p.values.includes(f.pid));
  if(query.includes('ORDER BY at DESC'))rows=rows.sort((a,b)=>b.at-a.at);
  return {json:async()=>rows.slice(0,p.rowLimit)};
}};
let busyCoverageLimited=false;
const recentFamily=await busyStore.readSessionProcessFamilyFacts({rootProcessInstanceKey:rootFact.processInstanceKey,
  rootPid:rootFact.pid,rootStartTime:rootFact.startTime,hostId:rootFact.hostId,bootId:rootFact.bootId,
  sinceMs:now-10000,untilMs:now+10000,limit:12,maxDepth:3,skipLegacyFallback:true,prioritizeRecent:true,
  onCoverageLimited:()=>{busyCoverageLimited=true;}});
assert.ok(recentFamily.some(f=>f.eventId===grandchildFact.eventId),'new command below sandbox remains visible in a busy family');
assert.ok(recentFamily.length<=12,'parallel column reads must not exceed the total fact budget');
assert.equal(busyCoverageLimited,true,'bounded branch selection must report partial coverage');
const limitedStores=stores([rootFact,childFact]);
limitedStores.clickhouse.readSessionProcessFamilyFacts=async input=>{
  input.onCoverageLimited();return [rootFact,childFact];
};
const limitedEvidence=await new SessionEventAttributionService(limitedStores.clickhouse,limitedStores.relational)
  .evidence(binding,{since:now-1000,until:now+10000},undefined,250);
assert.equal(limitedEvidence.persistence,'persisted');
assert.equal(limitedEvidence.completeness,'partial','successful writes cannot make a truncated walk complete');
assert.equal(limitedEvidence.page.processFamilyTruncated,true,'structural truncation must reach the UI');
assert.equal(limitedEvidence.page.hasMore,true,'an exhausted structural budget must allow loading more even when all discovered relations fit');

// Short-lived commands can emit a later exec revision without startTimeTicks. It may inherit an
// already-proven family generation only when PID, parent PID and lifetime select exactly one key.
const incompleteExecEvent = judgedEvent(
  'event-incomplete-short-exec',
  childFact.pid,
  childFact.at + 5,
  'ToolExec',
);
incompleteExecEvent.process = {
  pid: childFact.pid,
  ppid: childFact.ppid,
  hostId: childFact.hostId,
  bootId: childFact.bootId,
};
const incompleteStore = new ClickHouseStore();
incompleteStore.ready = true;
const observedWindowQueries = [];
incompleteStore.client = {
  query: async ({ query, query_params }) => {
    observedWindowQueries.push({ query, query_params });
    return ({
    json: async () => [{
      eventId: incompleteExecEvent.eventId,
      eventAt: incompleteExecEvent.at,
    }],
    });
  },
};
incompleteStore.loadEventsByIds = async () => [incompleteExecEvent];
const inheritedShortExec = await incompleteStore.readSessionProcessObservedEvents({
  processes: [{
    processInstanceKey: childFact.processInstanceKey,
    pid: childFact.pid,
    ppid: childFact.ppid,
    validFrom: childFact.at,
  }],
  hostId: childFact.hostId,
  bootId: childFact.bootId,
  pidNamespace: childFact.pidNamespace,
  sinceMs: now - 1_000,
  untilMs: now + 10_000,
});
assert.equal(
  inheritedShortExec?.[0]?.processInstanceKey,
  childFact.processInstanceKey,
  'an exact parent and lifetime may recover a short-lived exec missing startTimeTicks',
);
const ambiguousShortExec = await incompleteStore.readSessionProcessObservedEvents({
  processes: [
    {
      processInstanceKey: childFact.processInstanceKey,
      pid: childFact.pid,
      ppid: childFact.ppid,
      validFrom: childFact.at,
    },
    {
      processInstanceKey: 'pri_cccccccccccccccccccccccc',
      pid: childFact.pid,
      ppid: childFact.ppid,
      validFrom: childFact.at,
    },
  ],
  hostId: childFact.hostId,
  bootId: childFact.bootId,
  pidNamespace: childFact.pidNamespace,
  sinceMs: now - 1_000,
  untilMs: now + 10_000,
});
assert.equal(
  ambiguousShortExec?.length,
  0,
  'PID-only evidence must remain excluded when more than one generation is possible',
);
const queryCountBeforeWindows = observedWindowQueries.length;
await incompleteStore.readSessionProcessObservedEvents({
  processes: [{
    processInstanceKey: childFact.processInstanceKey,
    pid: childFact.pid,
    ppid: childFact.ppid,
    validFrom: childFact.at,
  }],
  hostId: childFact.hostId,
  bootId: childFact.bootId,
  pidNamespace: childFact.pidNamespace,
  sinceMs: now - 10_000,
  untilMs: now + 20_000,
  timeWindows: [
    { sinceMs: now - 5_000, untilMs: now - 1_000 },
    { sinceMs: now - 2_000, untilMs: now + 1_000 },
    { sinceMs: now + 10_000, untilMs: now + 12_000 },
  ],
});
const boundedWindowQueries = observedWindowQueries.slice(queryCountBeforeWindows);
assert.equal(
  boundedWindowQueries.length,
  2,
  'overlapping Turn windows must merge while idle gaps remain separate ClickHouse reads',
);
assert.deepEqual(
  boundedWindowQueries.map((item) => [
    item.query_params.sinceMs,
    item.query_params.untilMs,
  ]),
  [
    [now + 10_000, now + 12_000],
    [now - 5_000, now + 1_000],
  ],
  'Turn windows must be queried newest-first without expanding into idle time',
);
assert.ok(
  boundedWindowQueries.every((item) =>
    item.query.includes("'ToolExec', 'ProcessExit'")),
  'the observed-event read must include lifecycle events for sparse projections',
);

// A Rustls interaction may hash the Session process without namespace fields while a later
// eBPF event carries the complete namespace tuple. The exact PID + start-time generation must
// reconcile those keys instead of being discarded as unrelated evidence.
const namespaceEnrichedEvent = judgedEvent(
  'event-namespace-enriched',
  childFact.pid,
  childFact.at + 8,
  'ToolExec',
);
namespaceEnrichedEvent.process = {
  pid: childFact.pid,
  ppid: childFact.ppid,
  hostId: childFact.hostId,
  bootId: childFact.bootId,
  pidNamespace: childFact.pidNamespace,
  namespacePid: childFact.pid,
  namespacePpid: childFact.namespacePpid,
  startTimeTicks: childFact.startTime.slice('ticks:'.length),
};
const namespaceStore = new ClickHouseStore();
namespaceStore.ready = true;
namespaceStore.client = {
  query: async () => ({
    json: async () => [{
      eventId: namespaceEnrichedEvent.eventId,
      eventAt: namespaceEnrichedEvent.at,
    }],
  }),
};
namespaceStore.loadEventsByIds = async () => [namespaceEnrichedEvent];
const namespaceRead = await namespaceStore.readSessionProcessObservedEvents({
  processes: [{
    processInstanceKey: 'pri_partial_namespace_key',
    pid: childFact.pid,
    ppid: childFact.ppid,
    startTime: childFact.startTime,
    validFrom: childFact.at,
  }],
  hostId: childFact.hostId,
  bootId: childFact.bootId,
  sinceMs: now - 1_000,
  untilMs: now + 10_000,
});
assert.equal(
  namespaceRead?.[0]?.processInstanceKey,
  'pri_partial_namespace_key',
  'namespace-enriched events must reconcile to the Session generation key',
);

// The local JSONL lane and Observer Rustls lane intentionally have independent conversation ids
// and environment/runtime labels. They still describe one Native Codex Session and must not turn
// every event in that Session process family into `multiple_active_sessions`.
const observedAliasBinding = {
  ...binding,
  bindingId: `${binding.bindingId}-observer-alias`,
  conversationId: 'conv_observed_fixture_alias',
  environmentId: 'infrastructure',
  runtimeType: 'codex_ebpf_rustls',
};
const aliasStores = stores(
  [rootFact, childFact],
  [binding, observedAliasBinding],
);
const aliasEvidence = await new SessionEventAttributionService(
  aliasStores.clickhouse,
  aliasStores.relational,
).evidence(observedAliasBinding, { since: now - 1_000, until: now + 10_000 });
assert.equal(aliasEvidence.counts.direct, 1);
assert.equal(aliasEvidence.counts.lineage, 1);
assert.equal(aliasEvidence.counts.ambiguous, 0);
assert.equal(aliasEvidence.events.length, 2);
assert.ok(
  aliasStores.writes.relations.every((item) =>
    item.conversationId === observedAliasBinding.conversationId),
  'definite relations must remain visible under the detail view conversation alias',
);
assert.ok(
  aliasStores.writes.results.every((item) =>
    item.status === 'DIRECT' || item.status === 'LINEAGE'),
  'one Native Session projected by local and Observer lanes must not become ambiguous',
);

const competingBinding = {
  ...binding,
  bindingId: `${binding.bindingId}-other`,
  conversationId: 'conversation-other',
  nativeSessionId: 'native-session-other',
};
const ambiguousStores = stores(
  [rootFact, childFact],
  [binding, competingBinding],
);
const ambiguousEvidence = await new SessionEventAttributionService(
  ambiguousStores.clickhouse,
  ambiguousStores.relational,
).evidence(binding, { since: now - 1_000, until: now + 10_000 });
assert.equal(ambiguousEvidence.events.length, 0);
assert.equal(ambiguousStores.writes.relations.length, 0);
assert.ok(
  ambiguousStores.writes.results.every((item) => item.status === 'AMBIGUOUS'),
  'concurrent Sessions on one process must not receive fabricated definite relations',
);

// A child Codex Session is a process-tree ownership boundary, not a concurrent claimant on every
// event in its parent Session. The closest proven Session root owns its root and descendants while
// the parent retains only events above that boundary.
const nestedSessionBinding = {
  ...binding,
  bindingId: `${binding.bindingId}-nested-session`,
  conversationId: 'conversation-nested-session',
  nativeSessionId: 'native-session-nested',
  matchedOsProcessInstanceKey: childFact.processInstanceKey,
  matchedPid: childFact.pid,
  matchedStartTime: childFact.startTime,
};

// The detail path must make the same ownership decisions without any writes.
for (const persist of [false, true]) {
  for (const reversed of [false, true]) {
    const context = reversed ? [competingBinding, binding] : [binding, competingBinding];
    const testStores = stores([rootFact, childFact], context);
    const evidence = await new SessionEventAttributionService(testStores.clickhouse, testStores.relational)
      .evidence(binding, { since: now - 1000, until: now + 10000 }, undefined, 250, { persist });
    assert.equal(evidence.events.length, 0, 'concurrent ownership is ambiguous in both paths');
    assert.equal(evidence.counts.ambiguous, 2);
    if (!persist) assert.equal(testStores.writes.relations.length, 0);
  }
  const testStores = stores([rootFact, childFact, grandchildFact], [binding, nestedSessionBinding]);
  const evidence = await new SessionEventAttributionService(testStores.clickhouse, testStores.relational)
    .evidence(binding, { since: now - 1000, until: now + 10000 }, undefined, 250, { persist });
  assert.deepEqual(evidence.events.map(item => item.eventId), [rootFact.eventId]);
}

for (const persist of [false, true]) {
  const testStores = stores([rootFact, childFact]);
  testStores.relational.loadSessionProcessBindings = async () => null;
  const evidence = await new SessionEventAttributionService(testStores.clickhouse, testStores.relational)
    .evidence(binding, { since: now - 1000, until: now + 10000 }, undefined, 250, { persist });
  assert.equal(evidence.events.length, 0, 'unavailable ownership context must fail closed');
  assert.equal(evidence.completeness, 'partial');
  assert.equal(evidence.counts.unattributed, 2);
  assert.equal(testStores.writes.results.length, 0, 'transient read failure must not supersede durable decisions');
  assert.equal(testStores.writes.reconciliations.length, 0);
}

for (const startTime of ['ticks:900', undefined, 'ns:1001']) {
  const testStores = stores([rootFact, { ...childFact, startTime }], [binding]);
  const evidence = await new SessionEventAttributionService(testStores.clickhouse, testStores.relational)
    .evidence(binding, { since: now - 1000, until: now + 10000 });
  assert.equal(evidence.counts.lineage, 0, 'unknown, mixed or reversed generations cannot prove lineage');
}
for (const startTime of ['ticks:1000', 'ticks:1001']) {
  const testStores = stores([rootFact, { ...childFact, startTime }], [binding]);
  const evidence = await new SessionEventAttributionService(testStores.clickhouse, testStores.relational)
    .evidence(binding, { since: now - 1000, until: now + 10000 });
  assert.equal(evidence.counts.lineage, 1, 'same-tick and later forks remain valid');
}
const foreignChildStores = stores([{ ...childFact, runtimeInstanceId: 'foreign-agent' }]);
assert.equal(await new SessionEventAttributionService(foreignChildStores.clickhouse, foreignChildStores.relational)
  .resolveBinding({ runtimeType: 'codex', nativeSessionId: 'foreign-child-test', matchedPid: 100,
    matchedStartTime: 'ticks:1000', validFrom: now, agentInstanceId: 'agent-a' },
  { since: now - 1000, until: now + 10000 }), undefined);

const mixedScopeStores = stores([
  childFact, { ...grandchildFact, ppid: 100, namespacePpid: 100 },
  { ...childFact, eventId: 'foreign-scope', factId: 'foreign-scope', hostId: 'host-other' },
]);
assert.equal(await new SessionEventAttributionService(mixedScopeStores.clickhouse, mixedScopeStores.relational)
  .resolveBinding({ runtimeType: 'codex', nativeSessionId: 'mixed-scope-test', matchedPid: 100,
    matchedStartTime: 'ticks:1000', validFrom: now, agentInstanceId: 'agent-a' },
  { since: now - 1000, until: now + 10000 }), undefined, 'majority volume cannot establish missing root scope');
const nestedSessionStores = stores(
  [rootFact, childFact, grandchildFact],
  [binding, nestedSessionBinding],
);
const nestedParentEvidence = await new SessionEventAttributionService(
  nestedSessionStores.clickhouse,
  nestedSessionStores.relational,
).evidence(binding, { since: now - 1_000, until: now + 10_000 });
assert.equal(nestedParentEvidence.counts.direct, 1);
assert.equal(nestedParentEvidence.counts.lineage, 0);
assert.equal(nestedParentEvidence.counts.ambiguous, 0);
assert.deepEqual(
  nestedParentEvidence.events.map((item) => item.eventId),
  [rootFact.eventId],
  'a parent Session detail must stop at a nested Session root',
);
assert.ok(
  nestedSessionStores.writes.relations
    .filter((item) => item.eventId !== rootFact.eventId)
    .every((item) => item.conversationId === nestedSessionBinding.conversationId),
  'nested Session root and descendant events must select the closest Session boundary',
);

const unboundNestedRootFact = {
  ...childFact,
  eventId: 'event-unbound-nested-root',
  factId: 'fact-event-unbound-nested-root',
  runtimeInstanceId: 'agent-unbound-nested',
  rootProcess: true,
};
const unboundNestedChildFact = {
  ...grandchildFact,
  eventId: 'event-unbound-nested-child',
  factId: 'fact-event-unbound-nested-child',
  runtimeInstanceId: 'agent-unbound-nested',
};
const unboundNestedStores = stores([
  rootFact,
  unboundNestedRootFact,
  unboundNestedChildFact,
]);
const unboundNestedEvidence = await new SessionEventAttributionService(
  unboundNestedStores.clickhouse,
  unboundNestedStores.relational,
).evidence(binding, { since: now - 1_000, until: now + 10_000 });
assert.equal(
  unboundNestedEvidence.counts.conflict,
  0,
  'an exact nested Observer root without its own Native Session remains family-local evidence',
);
assert.equal(unboundNestedEvidence.counts.lineage, 2);

const externalAgentEvent = judgedEvent('event-external-agent', 101, now + 140, 'Egress');
externalAgentEvent.process = {
  pid: 101,
  ppid: 100,
  hostId: 'host-a',
  bootId: 'boot-a',
  pidNamespace: 'pidns-a',
  namespacePid: 101,
  startTimeTicks: '1001',
};
externalAgentEvent.attribution = {
  agentInstanceId: 'agent-other',
  rootPid: 999,
  rootStartTime: '9999',
};
const conflictStores = stores(
  [rootFact, childFact],
  [binding],
  [{ event: externalAgentEvent, processInstanceKey: childFact.processInstanceKey }],
);
await new SessionEventAttributionService(
  conflictStores.clickhouse,
  conflictStores.relational,
).evidence(binding, { since: now - 1_000, until: now + 10_000 });
assert.equal(
  conflictStores.writes.results.find((item) => item.eventId === externalAgentEvent.eventId)?.status,
  'CONFLICT',
);
assert.equal(
  conflictStores.writes.relations.some((item) => item.eventId === externalAgentEvent.eventId),
  false,
  'an Agent root outside the proven Session process family must not receive a definite relation',
);

const staleConflictingBinding = {
  ...binding,
  bindingId: `${binding.bindingId}-stale-conflicting`,
  agentInstanceId: 'agent-b',
  validFrom: binding.validFrom - 1_000,
};
const validCandidateStores = stores(
  [rootFact, childFact],
  [binding, staleConflictingBinding],
);
const validCandidateEvidence = await new SessionEventAttributionService(
  validCandidateStores.clickhouse,
  validCandidateStores.relational,
).evidence(binding, { since: now - 1_000, until: now + 10_000 });
assert.equal(
  validCandidateEvidence.counts.conflict,
  0,
  'a stale identity-mismatched candidate must not veto a valid exact-generation binding',
);
assert.ok(
  validCandidateStores.writes.results.every((item) =>
    item.status === 'DIRECT' || item.status === 'LINEAGE'),
  'a valid binding must win over a stale conflicting candidate for the same conversation',
);

const egressEvent = judgedEvent('event-egress', 101, now + 150, 'Egress');
egressEvent.process = {
  pid: 101,
  ppid: 100,
  hostId: 'host-a',
  bootId: 'boot-a',
  pidNamespace: 'pidns-a',
  namespacePid: 101,
  startTimeTicks: '1001',
};
egressEvent.attribution = {
  agentInstanceId: 'agent-a',
  correlation: { processInstanceId: childFact.processInstanceKey },
};
const genericStores = stores(
  [rootFact, childFact],
  [binding],
  [{ event: egressEvent, processInstanceKey: childFact.processInstanceKey }],
);
const deleteEvent = {
  ...egressEvent,
  eventId: 'event-file-delete',
  eventKind: 'FileDelete',
  subject: 'FileDelete',
  attributes: { path: 'observer-delete.txt' },
};
const deleteStores = stores([rootFact, childFact], [binding], [
  { event: deleteEvent, processInstanceKey: childFact.processInstanceKey },
]);
const deleteEvidence = await new SessionEventAttributionService(
  deleteStores.clickhouse, deleteStores.relational,
).evidence(binding, { since: now - 1_000, until: now + 10_000 });
assert.equal(deleteEvidence.events.find(item => item.eventId === deleteEvent.eventId)?.subject,
  'delete observer-delete.txt', 'historical FileDelete metadata must retain its resource in Session evidence');
assert.equal(deleteEvent.subject, 'FileDelete', 'presentation must not rewrite persisted source evidence');
const genericEvidence = await new SessionEventAttributionService(
  genericStores.clickhouse,
  genericStores.relational,
).evidence(binding, { since: now - 1_000, until: now + 10_000 });
assert.ok(
  genericEvidence.events.some((item) => item.eventId === 'event-egress'),
  'captured Egress evidence from an exact Session process generation must be related',
);

// Observer can initially anchor the Agent to a launcher and later re-root the same live process
// generation after that launcher exits. A changed ari_* that is emitted by the exact Session
// process (and inherited by its descendants) is a family-local identity alias, not a conflict.
const reRootedDirectEvent = judgedEvent('event-rerooted-direct', 100, now + 160, 'Egress');
reRootedDirectEvent.process = {
  pid: 100,
  hostId: 'host-a',
  bootId: 'boot-a',
  pidNamespace: 'pidns-a',
  namespacePid: 100,
  startTimeTicks: '1000',
};
reRootedDirectEvent.attribution = {
  agentInstanceId: 'agent-rerooted',
  rootPid: 100,
  rootStartTime: '1000',
};
const reRootedChildEvent = judgedEvent('event-rerooted-child', 101, now + 170, 'Egress');
reRootedChildEvent.process = {
  pid: 101,
  ppid: 100,
  hostId: 'host-a',
  bootId: 'boot-a',
  pidNamespace: 'pidns-a',
  namespacePid: 101,
  startTimeTicks: '1001',
};
reRootedChildEvent.attribution = {
  agentInstanceId: 'agent-rerooted',
  rootPid: 100,
  rootStartTime: '1000',
};
const reRootedStores = stores(
  [rootFact, childFact],
  [binding],
  [
    { event: reRootedDirectEvent, processInstanceKey: rootFact.processInstanceKey },
    { event: reRootedChildEvent, processInstanceKey: childFact.processInstanceKey },
  ],
);
const reRootedEvidence = await new SessionEventAttributionService(
  reRootedStores.clickhouse,
  reRootedStores.relational,
).evidence(binding, { since: now - 1_000, until: now + 10_000 });
assert.equal(
  reRootedEvidence.counts.conflict,
  0,
  'a family-local Observer root transition must not create an Agent identity conflict',
);
assert.ok(
  reRootedStores.writes.results
    .filter((item) => item.eventId.startsWith('event-rerooted-'))
    .every((item) => item.status === 'DIRECT' || item.status === 'LINEAGE'),
  're-rooted events must retain their exact process-family attribution',
);

// A shell can exec Kimi without changing PID/start time. Keep its prior identity separate,
// while still treating mismatches after the exact self-root observation as conflicts.
const bootstrapRoot = { ...rootFact, runtimeInstanceId: 'launcher-agent', rootProcess: false };
const bootstrapChild = { ...childFact, runtimeInstanceId: 'launcher-agent', at: now + 110 };
const transitionEvent = (id, pid, at, runtime, rootPid, kind = 'ToolExec') => ({
  ...judgedEvent(id, pid, at, kind),
  process: { pid, ppid: pid === 101 ? 100 : 99, hostId: 'host-a', bootId: 'boot-a',
    pidNamespace: 'pidns-a', startTimeTicks: pid === 100 ? '1000' : '1001' },
  attribution: { agentInstanceId: runtime, rootPid, rootStartTime: rootPid === 100 ? '1000' : '9999' },
});
const bootstrapExec = transitionEvent(rootFact.eventId, 100, rootFact.at, 'launcher-agent', 999);
const bootstrapChildExec = transitionEvent(childFact.eventId, 101, bootstrapChild.at, 'launcher-agent', 999);
const ownIdentity = transitionEvent('own-identity', 100, now + 200, binding.agentInstanceId, 100, 'FileAccess');
const laterMismatch = transitionEvent('late-mismatch', 100, now + 260, 'launcher-agent', 999, 'Egress');
const wrapTransition = (event) => ({ event, processInstanceKey: event.process.pid === 100
  ? rootFact.processInstanceKey : childFact.processInstanceKey });
const transitionInput = [bootstrapExec, bootstrapChildExec, ownIdentity, laterMismatch];
const transitionSnapshot = JSON.stringify(transitionInput);
const transitionStores = stores([bootstrapRoot, bootstrapChild], [binding], transitionInput.map(wrapTransition));
const transitionEvidence = await new SessionEventAttributionService(transitionStores.clickhouse, transitionStores.relational)
  .evidence(binding, { since: now - 1000, until: now + 10000 });
assert.equal(transitionEvidence.counts.conflict, 1, 'a late foreign identity must remain a conflict');
assert.equal(transitionEvidence.counts.unattributed, 2);
assert.deepEqual(transitionEvidence.startupContext.map(x => x.eventId), [rootFact.eventId, childFact.eventId]);
assert.deepEqual(transitionEvidence.events.map(x => x.eventId), ['own-identity']);
assert.equal(transitionEvidence.exceptions[0].eventId, 'late-mismatch');
assert.equal(JSON.stringify(transitionInput), transitionSnapshot, 'never rewrite the captured identity');
assert.ok(transitionStores.writes.results.filter(x => [rootFact.eventId, childFact.eventId].includes(x.eventId))
  .every(x => x.status === 'UNATTRIBUTED' && x.reason === 'before_agent_identity_transition'));

for (const invalidAnchor of [undefined, { ...ownIdentity, eventKind: 'ProcessExit' },
  { ...ownIdentity, attribution: { ...ownIdentity.attribution, rootStartTime: '2000' } },
  { ...ownIdentity, process: { ...ownIdentity.process, pid: 101 } },
  { ...ownIdentity, at: bootstrapExec.at }]) {
  const invalidStores = stores([bootstrapRoot, bootstrapChild], [binding],
    [bootstrapExec, bootstrapChildExec, ...(invalidAnchor ? [invalidAnchor] : [])].map(wrapTransition));
  const invalidEvidence = await new SessionEventAttributionService(invalidStores.clickhouse, invalidStores.relational)
    .evidence(binding, { since: now - 1000, until: now + 10000 });
  assert.equal(invalidEvidence.startupContext?.length ?? 0, 0,
    'missing, exit-only, wrong-generation, child-only, or simultaneous claims cannot prove a startup transition');
  assert.ok(invalidEvidence.exceptions.some(x => x.eventId === rootFact.eventId));
}

const oldExit = fact({
  eventId: 'event-old-exit',
  processInstanceKey: rootFact.processInstanceKey,
  pid: 100,
  startTime: 'ticks:1000',
  factKind: 'exit',
  at: now + 300,
});
const reusedParent = fact({
  eventId: 'event-reused-parent',
  processInstanceKey: 'pri_aaaaaaaaaaaaaaaaaaaaaaaa',
  pid: 100,
  startTime: 'ticks:2000',
  at: now + 500,
});
const reusedChild = fact({
  eventId: 'event-reused-child',
  processInstanceKey: 'pri_bbbbbbbbbbbbbbbbbbbbbbbb',
  pid: 103,
  ppid: 100,
  namespacePpid: 100,
  startTime: 'ticks:2001',
  at: now + 600,
});
const reusedEdges = service.lineageEdges(
  [rootFact, oldExit, reusedParent, reusedChild],
  [binding],
);
assert.equal(
  reusedEdges.find((item) => item.childProcessInstanceKey === reusedChild.processInstanceKey)
    ?.parentProcessInstanceKey,
  reusedParent.processInstanceKey,
  'PID reuse must select the live process generation, not the exited Session root',
);
const missingGenerationEdges = service.lineageEdges(
  [rootFact, oldExit, reusedChild],
  [binding],
);
assert.equal(
  missingGenerationEdges.some((item) => item.childProcessInstanceKey === reusedChild.processInstanceKey),
  false,
  'a missing reused parent generation must remain unattributed after the old generation exited',
);

const cappedFacts = Array.from({ length: 260 }, (_, index) => fact({
  eventId: `event-cap-${String(index).padStart(3, '0')}`,
  processInstanceKey: rootFact.processInstanceKey,
  pid: 100,
  startTime: 'ticks:1000',
  rootProcess: true,
  at: now + 1_000 + index,
}));
const capStores = stores(cappedFacts, [binding]);
const cappedEvidence = await new SessionEventAttributionService(
  capStores.clickhouse,
  capStores.relational,
).evidence(binding, { since: now - 1_000, until: now + 10_000 });
assert.equal(cappedEvidence.events.length, 250);
assert.equal(cappedEvidence.counts.direct, 260);
assert.deepEqual(cappedEvidence.page, {
  requestedLimit: 250,
  totalRelations: 260,
  processFamilyTruncated: false,
  loadedRelations: 250,
  returnedEvents: 250,
  unavailableEvents: 0,
  totalLineageEdges: 0,
  returnedLineageEdges: 0,
  hasMore: true,
});
assert.equal(cappedEvidence.events[0].eventId, 'event-cap-259');
assert.equal(cappedEvidence.events.at(-1).eventId, 'event-cap-010');
assert.equal(
  cappedEvidence.completeness,
  'complete_as_observed',
  'view pagination must not downgrade the underlying attribution completeness',
);

const relationV1 = eventSessionRelationId({
  eventId: 'event-root',
  conversationId: binding.conversationId,
  bindingRevision: 1,
});
const relationV2 = eventSessionRelationId({
  eventId: 'event-root',
  conversationId: binding.conversationId,
  bindingRevision: 2,
});
assert.notEqual(relationV1, relationV2);
const imageBash = fact({
  eventId: 'event-image-bash',
  processInstanceKey: 'pri_bashbashbashbashbashbash',
  pid: 200,
  ppid: 50,
  namespacePpid: 50,
  startTime: 'ticks:5000',
  at: now + 1000,
});
const imagePrintf = fact({
  eventId: 'event-image-printf',
  processInstanceKey: 'pri_printfprintfprintfprintf',
  pid: 201,
  ppid: 200,
  namespacePpid: 200,
  startTime: 'ticks:5001',
  at: now + 1100,
});
const imageReplacement = fact({
  eventId: 'event-image-uname',
  processInstanceKey: 'pri_unameunameunameunameuname',
  pid: 200,
  ppid: 50,
  namespacePpid: 50,
  startTime: 'ticks:5000',
  pidNamespace: '',
  at: now + 1300,
});
const imageWrapper = fact({
  eventId: 'event-image-wrapper',
  processInstanceKey: 'pri_wrapperwrapperwrapperwrap',
  pid: 50,
  startTime: 'ticks:4990',
  at: now + 900,
});
const imageEdges = service.lineageEdges(
  [imageWrapper, imageBash, imagePrintf, imageReplacement],
  [binding],
);
assert.equal(
  imageEdges.find((item) => item.childProcessInstanceKey === imageReplacement.processInstanceKey)
    ?.parentProcessInstanceKey,
  imageBash.processInstanceKey,
  'an in-place exec must continue the same PID and start time',
);
assert.equal(
  imageEdges.find((item) => item.childProcessInstanceKey === imagePrintf.processInstanceKey)
    ?.parentProcessInstanceKey,
  imageBash.processInstanceKey,
  'a forked child must stay under the original image',
);
assert.equal(
  imageEdges.some((item) =>
    item.childProcessInstanceKey === imageReplacement.processInstanceKey
    && item.parentProcessInstanceKey === imageWrapper.processInstanceKey),
  false,
  'an in-place exec must not be attributed to the parent shell',
);

assert.equal(SESSION_EVENT_ATTRIBUTION_ALGORITHM, 'session_process_lineage');
assert.equal(SESSION_EVENT_ATTRIBUTION_VERSION, 13);

const pageSource = await readFile(
  resolve('apps/web/src/pages/LocalRecordTrackingPage.tsx'),
  'utf8',
);
assert.match(pageSource, /Session 系统证据树/u);

console.log(JSON.stringify({
  ok: true,
  resolvedWithoutLlmCapture: true,
  resolvedFromDirectChild: Boolean(childOnlyBinding),
  direct: evidence.counts.direct,
  lineage: evidence.counts.lineage,
  hybridProjectionRecovered: recoveredFacts.length,
  nativeSessionAliasesFolded: true,
  partialObserverIdentityReconciled: true,
  pidNamespaceTransitionAttributed: true,
  shortExecGenerationRecovered: inheritedShortExec?.length === 1,
  concurrentSessionStatus: 'AMBIGUOUS',
  nestedSessionBoundary: true,
  unboundNestedRootAccepted: true,
  identityConflictStatus: 'CONFLICT',
  validCandidateOverridesStaleConflict: true,
  familyLocalRootTransitionAccepted: true,
  pidReuseGuard: true,
  genericEvidenceRelated: genericEvidence.events.some((item) => item.eventKind === 'Egress'),
  newestEventCap: cappedEvidence.events.length,
  definiteRelationStatuses: ['DIRECT', 'LINEAGE'],
  algorithm: SESSION_EVENT_ATTRIBUTION_ALGORITHM,
  version: SESSION_EVENT_ATTRIBUTION_VERSION,
}, null, 2));
