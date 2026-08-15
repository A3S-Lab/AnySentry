#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  agentAssetIdForEvent,
  agentRuntimeInstanceIdForEvent,
  detectedAgentIdentity,
} = require('../apps/api/dist/security-monitoring/agent-identity.js');
const {
  AgentMetadataService,
} = require('../apps/api/dist/security-monitoring/agent-metadata.service.js');
const {
  AggregationService,
} = require('../apps/api/dist/security-monitoring/aggregation.service.js');
const {
  AgentAttributionService,
} = require('../apps/api/dist/security-monitoring/agent-attribution.service.js');

function event({
  agentId,
  pid,
  rootPid,
  rootStartTime = `root-${rootPid}`,
  workspacePath = '/home/user/security/AnySentry',
}) {
  return {
    schemaVersion: 'anysentry.agent_event.v1',
    eventId: `event-${pid}`,
    at: Date.now(),
    eventKind: 'ToolExec',
    eventCategory: 'tool',
    source: 'observer',
    subject: agentId,
    workspacePath,
    agentId,
    sessionId: 'session-4603.scope',
    userId: 'user',
    traceId: `trace-${pid}`,
    spanId: `span-${pid}`,
    runId: `run-${pid}`,
    verdict: 'allow',
    tier: 'Rules',
    severity: 'info',
    reason: 'fixture',
    riskCategory: 'other',
    riskName: 'fixture',
    riskType: 'atomic',
    riskScore: 0,
    tokenCount: 0,
    latencyMs: 0,
    attributes: {},
    process: {
      hostId: 'node-a',
      bootId: 'boot-a',
      pid,
      ppid: rootPid,
      startTimeTicks: String(pid * 10),
      comm: agentId,
      exe: `/usr/bin/${agentId}`,
      cwd: workspacePath,
      systemdUnit: 'session-4603.scope',
    },
    attribution: {
      monitored: true,
      classification: 'probable_agent',
      agentScopeId: 'codex',
      agentDisplayName: 'codex',
      rootPid,
      rootStartTime,
      confidence: 0.9,
      reason: 'process_lineage',
      source: 'process_graph',
      evidence: ['process_lineage:agent_root'],
      workloadRef: {
        environment: 'host',
        kind: 'process',
        processName: 'codex',
        executable: '/usr/bin/codex',
        systemdUnit: 'session-4603.scope',
      },
    },
  };
}

const rootOneShell = event({ agentId: 'bash', pid: 101, rootPid: 100 });
const rootOneCurl = event({ agentId: 'curl', pid: 102, rootPid: 100 });
const rootTwoShell = event({ agentId: 'bash', pid: 201, rootPid: 200 });
const rootOneOtherWorkspace = event({
  agentId: 'bash',
  pid: 103,
  rootPid: 100,
  workspacePath: '/home/user/security/Observer',
});
const reusedRootPid = event({
  agentId: 'bash',
  pid: 104,
  rootPid: 100,
  rootStartTime: 'new-root-100',
});

assert.equal(
  agentRuntimeInstanceIdForEvent(rootOneShell),
  agentRuntimeInstanceIdForEvent(rootOneCurl),
  'children of one root share one runtime instance',
);
assert.notEqual(
  agentRuntimeInstanceIdForEvent(rootOneShell),
  agentRuntimeInstanceIdForEvent(rootTwoShell),
  'two terminal roots remain two runtime instances',
);
assert.notEqual(
  agentRuntimeInstanceIdForEvent(rootOneShell),
  agentRuntimeInstanceIdForEvent(reusedRootPid),
  'PID reuse with a new start time creates a new runtime instance',
);

assert.equal(
  agentAssetIdForEvent(rootOneShell),
  agentAssetIdForEvent(rootOneCurl),
  'children of one Agent root share an asset ID even when raw process names differ',
);
assert.notEqual(
  agentAssetIdForEvent(rootOneShell),
  agentAssetIdForEvent(rootTwoShell),
  'separate Agent roots in one SSH scope remain separate assets',
);
assert.equal(
  agentAssetIdForEvent(rootOneShell),
  agentAssetIdForEvent(rootOneOtherWorkspace),
  'workspace changes are mutable Agent context and must not split one runtime instance',
);
assert.notEqual(
  agentAssetIdForEvent(rootOneShell),
  agentAssetIdForEvent(reusedRootPid),
  'PID reuse in one boot must not merge distinct Agent process instances',
);

const detected = detectedAgentIdentity(rootOneShell);
assert.equal(detected.detectedName, 'codex');
assert.equal(detected.detectedClassification, 'probable_agent');
assert.equal(detected.runtime, 'host');
assert.equal(detected.locationLabel, 'security/AnySentry · PID 100');

const relationalStub = {
  initialize: async () => false,
  configured: () => false,
  loadAgentMetadata: async () => [],
  saveAgentMetadata: async () => undefined,
};
const service = new AgentMetadataService(relationalStub);
const originalAttribution = structuredClone(rootOneShell.attribution);
service.update('codex', {
  workspacePath: rootOneShell.workspacePath,
  agentAssetId: detected.agentAssetId,
  displayName: '安全研发 Codex',
  identityKeys: ['host:node-a:boot-a:root:100'],
  workloadRef: rootOneShell.attribution.workloadRef,
});

const resolved = service.resolveEvent(rootOneCurl);
assert.equal(resolved.agentAssetId, detected.agentAssetId);
assert.equal(resolved.displayName, '安全研发 Codex');
assert.equal(resolved.detectedName, 'codex');
assert.equal(resolved.detectedClassification, 'probable_agent');
assert.equal(resolved.effectiveClassification, 'probable_agent');
assert.deepEqual(
  rootOneShell.attribution,
  originalAttribution,
  'query-time display metadata never mutates collected attribution evidence',
);

const confirmedEvent = event({ agentId: 'confirmed-root', pid: 301, rootPid: 300 });
confirmedEvent.attribution.classification = 'confirmed_agent';
confirmedEvent.attribution.agentScopeId = 'confirmed-agent';
confirmedEvent.attribution.agentDisplayName = 'confirmed-agent';
confirmedEvent.attribution.physicalWorkloadId = 'host:node-a:boot-a:root:300';

const candidateEvent = event({ agentId: 'candidate-root', pid: 401, rootPid: 400 });
candidateEvent.attribution.agentScopeId = 'candidate-agent';
candidateEvent.attribution.agentDisplayName = 'candidate-agent';
candidateEvent.attribution.physicalWorkloadId = 'host:node-a:boot-a:root:400';
candidateEvent.verdict = 'block';
candidateEvent.severity = 'critical';
candidateEvent.riskScore = 99;

const candidateChild = event({ agentId: 'bash', pid: 402, rootPid: 400 });
candidateChild.attribution.agentScopeId = 'candidate-agent';
candidateChild.attribution.agentDisplayName = 'candidate-agent';
candidateChild.attribution.physicalWorkloadId = 'host:node-a:boot-a:root:400';

const unknownEvent = event({ agentId: 'unknown-root', pid: 501, rootPid: 500 });
unknownEvent.attribution.monitored = false;
unknownEvent.attribution.classification = 'unknown';
unknownEvent.attribution.agentScopeId = undefined;
unknownEvent.attribution.agentDisplayName = undefined;
unknownEvent.attribution.physicalWorkloadId = 'host:node-a:boot-a:root:500';

const nonAgentEvent = event({ agentId: 'database', pid: 601, rootPid: 600 });
nonAgentEvent.attribution.monitored = false;
nonAgentEvent.attribution.classification = 'non_agent';
nonAgentEvent.attribution.agentScopeId = undefined;
nonAgentEvent.attribution.agentDisplayName = undefined;
nonAgentEvent.attribution.physicalWorkloadId = 'host:node-a:boot-a:root:600';

const ephemeralChildCandidate = event({
  agentId: 'bwrap',
  pid: 651,
  rootPid: 651,
  rootStartTime: 'sandbox-child-651',
});
ephemeralChildCandidate.process.comm = 'bwrap';
ephemeralChildCandidate.process.exe = '/usr/bin/bwrap';
ephemeralChildCandidate.attribution.agentScopeId = 'codex';
ephemeralChildCandidate.attribution.agentDisplayName = 'codex';
ephemeralChildCandidate.attribution.physicalWorkloadId = undefined;
ephemeralChildCandidate.attribution.agentInstanceId = undefined;
ephemeralChildCandidate.attribution.workloadRef = undefined;
ephemeralChildCandidate.attribution.evidence = ['process_lineage:cached_agent_root'];

const judge = {
  query: () => [
    confirmedEvent,
    candidateEvent,
    candidateChild,
    unknownEvent,
    nonAgentEvent,
    ephemeralChildCandidate,
  ],
  listIncidents: () => [],
  committedEventProgress: () => [],
};
const aggregation = new AggregationService(judge, service, {}, {});
let inventory = aggregation.agentInventory({ timeType: 'last_3h', limit: 100 });
assert.equal(
  inventory.items.length,
  2,
  'unreviewed short helper processes without root evidence stay in audit events but not Agent assets',
);
assert.equal(inventory.items[0].classification, 'confirmed_agent', 'confirmed assets sort before higher-risk candidates');
assert.equal(inventory.items[1].classification, 'probable_agent');
assert.equal(inventory.items[1].eventCount, 2, 'one Agent asset aggregates events with different raw process names');

{
  const fallbackAttribution = new AgentAttributionService();
  const unresolved = fallbackAttribution.attribute(
    {
      agentId: 'codex',
      sessionId: 'claimed-session',
      workspacePath: '/home/user/security/AnySentry',
      attributes: {},
    },
    {
      pid: 998_001,
      ppid: 1,
      startTimeTicks: '9980010',
      comm: 'bwrap',
      exe: '/usr/bin/bwrap',
      cwd: '/home/user/security/AnySentry',
    },
    Date.now(),
  );
  assert.equal(
    unresolved.monitored,
    false,
    'a claimed Agent label must not promote an unrelated process into a new Agent root',
  );
}
assert.equal(inventory.items[1].instanceCount, 1);

const windowOne = event({
  agentId: 'a3s code',
  pid: 801,
  rootPid: 800,
  rootStartTime: 'window-one-start',
  workspacePath: '/home/user/code',
});
windowOne.eventId = 'window-one-event';
windowOne.at = Date.now() - 2_000;
windowOne.attribution.agentScopeId = 'a3s code';
windowOne.attribution.agentDisplayName = 'a3s code';
windowOne.process.pid = 800;
windowOne.process.ppid = 1;
windowOne.process.comm = 'a3s';
windowOne.process.exe = '/usr/bin/a3s';

const windowTwo = structuredClone(windowOne);
windowTwo.eventId = 'window-two-event';
windowTwo.at += 1_000;
windowTwo.sessionId = 'session-window-two';
windowTwo.traceId = 'trace-window-two';
windowTwo.spanId = 'span-window-two';
windowTwo.runId = 'run-window-two';
windowTwo.process.pid = 900;
windowTwo.process.startTimeTicks = '9000';
windowTwo.attribution.rootPid = 900;
windowTwo.attribution.rootStartTime = 'window-two-start';

const windowOneRuntimeId = agentRuntimeInstanceIdForEvent(windowOne);
const windowTwoRuntimeId = agentRuntimeInstanceIdForEvent(windowTwo);
assert.notEqual(windowOneRuntimeId, windowTwoRuntimeId);

const runtimeService = new AgentMetadataService(relationalStub);
const windowOneDetected = detectedAgentIdentity(windowOne);
runtimeService.review('a3s code', {
  workspacePath: windowOne.workspacePath,
  decision: 'confirmed_agent',
  currentClassification: 'probable_agent',
  agentAssetId: windowOneDetected.agentAssetId,
  identityKeys: runtimeService.identityKeysForEvent(windowOne),
  physicalWorkloadId: windowOne.attribution.physicalWorkloadId,
  agentInstanceId: windowOneRuntimeId,
  workloadRef: windowOne.attribution.workloadRef,
}, 'security-reviewer');

const reviewedWindowTwo = runtimeService.applyReview(windowTwo);
assert.equal(reviewedWindowTwo.attribution?.classification, 'confirmed_agent');
assert.equal(
  agentRuntimeInstanceIdForEvent(reviewedWindowTwo),
  windowTwoRuntimeId,
  'logical review inheritance must preserve the newly observed runtime identity',
);
assert.notEqual(
  reviewedWindowTwo.attribution?.agentInstanceId,
  windowOneRuntimeId,
  'the first reviewed window instance ID must not be copied to later windows',
);

const multiWindowAggregation = new AggregationService({
  query: () => [runtimeService.applyReview(windowOne), reviewedWindowTwo],
  listIncidents: () => [],
  committedEventProgress: () => [],
}, runtimeService, {}, {});
const multiWindowInventory = multiWindowAggregation.agentInventory({
  timeType: 'last_3h',
  scope: 'agent',
  limit: 100,
});
const a3sInstances = multiWindowInventory.items.filter((item) =>
  item.displayName === 'a3s code' || item.detectedName === 'a3s code'
);
assert.equal(
  a3sInstances.length,
  2,
  `two a3s code windows are displayed as two runtime instances: ${JSON.stringify(
    multiWindowInventory.items.map((item) => ({
      agentId: item.agentId,
      displayName: item.displayName,
      detectedName: item.detectedName,
      assetId: item.agentAssetId,
      instanceId: item.agentInstanceId,
      classification: item.classification,
      events: item.eventCount,
    })),
  )}`,
);
assert.equal(
  new Set(a3sInstances.map((item) => item.agentAssetId)).size,
  1,
  'runtime windows share one reviewed logical Agent identity',
);
assert.equal(
  new Set(a3sInstances.map((item) => item.agentInstanceId)).size,
  2,
  'each runtime window retains its own instance identity',
);
assert.deepEqual(
  a3sInstances.map((item) => item.eventCount).sort((a, b) => a - b),
  [1, 1],
  'commands are counted within their own runtime instance',
);
assert.ok(
  a3sInstances.every((item) => item.logicalInstanceCount === 2),
  'each runtime row reports both siblings under the logical Agent',
);
const multiWindowTopology = multiWindowAggregation.agentTopology({
  timeType: 'last_3h',
  scope: 'agent',
  includeBenign: true,
  limit: 100,
});
const a3sTopologyInstances = multiWindowTopology.nodes.filter((node) =>
  node.type === 'agent' &&
  node.agentAssetId === a3sInstances[0].agentAssetId
);
assert.equal(
  a3sTopologyInstances.length,
  2,
  `topology must preserve both runtime windows under one logical Agent identity: ${JSON.stringify(
    multiWindowTopology.nodes.map((node) => ({
      type: node.type,
      label: node.label,
      assetId: node.agentAssetId,
      instanceId: node.agentInstanceId,
      nodeId: node.nodeId,
    })),
  )}`,
);
assert.equal(
  new Set(a3sTopologyInstances.map((node) => node.agentInstanceId)).size,
  2,
  'topology Agent nodes expose distinct runtime instance IDs',
);
const riskOnlyTopology = multiWindowAggregation.agentTopology({
  timeType: 'last_3h',
  scope: 'agent',
  includeBenign: false,
  limit: 100,
});
assert.equal(
  riskOnlyTopology.nodes.filter((node) => node.type === 'agent').length,
  2,
  'risk-only relationship filtering must not hide healthy Agent runtime instances from the roster',
);
const focusedRuntime = multiWindowAggregation.agentInventory({
  timeType: 'last_3h',
  scope: 'agent',
  agentAssetId: a3sInstances[0].agentAssetId,
  agentInstanceId: a3sInstances[0].agentInstanceId,
  limit: 10,
});
assert.equal(focusedRuntime.items.length, 1, 'runtime deep links resolve exactly one window');
assert.equal(focusedRuntime.items[0].eventCount, 1);

const candidateAsset = inventory.items[1];
service.review(candidateAsset.agentId, {
  workspacePath: candidateAsset.workspacePath,
  decision: 'unknown',
  currentClassification: 'probable_agent',
  agentAssetId: candidateAsset.agentAssetId,
  identityKeys: candidateAsset.reviewIdentityKeys,
  physicalWorkloadId: candidateAsset.physicalWorkloadId,
  agentInstanceId: candidateAsset.agentInstanceId,
  workloadRef: candidateAsset.workloadRef,
}, 'security-reviewer');
aggregation.invalidateWindowCache();
assert.equal(
  service.resolveEvent(confirmedEvent).effectiveClassification,
  'confirmed_agent',
  JSON.stringify(service.resolveEvent(confirmedEvent)),
);
assert.equal(
  service.resolveEvent(candidateEvent).effectiveClassification,
  'unknown',
  JSON.stringify(service.resolveEvent(candidateEvent)),
);
inventory = aggregation.agentInventory({ timeType: 'last_3h', limit: 100 });
assert.equal(
  inventory.items.length,
  1,
  `an Agent returned to unknown leaves the primary asset inventory: ${JSON.stringify(inventory.items.map((item) => ({
    asset: item.agentAssetId,
    classification: item.classification,
    physical: item.physicalWorkloadId,
  })))}`,
);
const focusedUnknown = aggregation.agentInventory({
  timeType: 'last_3h',
  agentAssetId: candidateAsset.agentAssetId,
  includeUnclassified: true,
  limit: 10,
});
assert.equal(focusedUnknown.items.length, 1, 'a focused review can still reopen an unknown identity');
assert.equal(focusedUnknown.items[0].classification, 'unknown');

const dockerContainerId = 'f6611c0768c2c33910118357d8c0702cde43b9723a620caabf63313d93611f8b';
const dockerEvent = event({
  agentId: 'docker-a3s-code-loop',
  pid: 701,
  rootPid: 700,
  workspacePath: 'docker/anysentry-test-a3s-code',
});
dockerEvent.attribution.agentScopeId = 'docker-a3s-code-loop';
dockerEvent.attribution.agentDisplayName = 'docker-a3s-code-loop';
dockerEvent.attribution.physicalWorkloadId = `docker:node-a:${dockerContainerId}`;
dockerEvent.attribution.agentInstanceId = `container:${dockerContainerId}`;
dockerEvent.attribution.workloadRef = {
  environment: 'docker',
  kind: 'container',
  containerName: 'docker-a3s-code-loop',
};
const dockerAssetId = agentAssetIdForEvent(dockerEvent);
const dockerIdentityKeys = service.identityKeysForEvent(dockerEvent);
const legacyMetadataAssetId = require('../apps/api/dist/security-monitoring/agent-identity.js')
  .agentAssetIdForIdentityKey('unknown\0f6611c0768c2');
const dockerMetadata = service.review('f6611c0768c2', {
  workspacePath: 'unknown',
  decision: 'confirmed_agent',
  currentClassification: 'probable_agent',
  identityKeys: dockerIdentityKeys,
  physicalWorkloadId: dockerEvent.attribution.physicalWorkloadId,
  agentInstanceId: dockerEvent.attribution.agentInstanceId,
  workloadRef: dockerEvent.attribution.workloadRef,
}, 'security-reviewer');
assert.equal(dockerMetadata.agentAssetId, dockerAssetId, 'legacy review metadata derives the event-backed canonical asset ID');
assert.equal(service.canonicalAgentAssetId(legacyMetadataAssetId), dockerAssetId, 'legacy metadata-only asset links resolve to the canonical asset');

const dockerAggregation = new AggregationService({
  query: () => [dockerEvent],
  listIncidents: () => [],
  committedEventProgress: () => [],
}, service, {}, {});
const dockerInventory = dockerAggregation.agentInventory({ timeType: 'last_3h', limit: 100 });
assert.equal(dockerInventory.items.filter((item) => item.agentAssetId === dockerAssetId).length, 1, 'event and human review produce one Agent asset');
const dockerItem = dockerInventory.items.find((item) => item.agentAssetId === dockerAssetId);
assert.equal(dockerItem?.workspacePath, dockerEvent.workspacePath, 'observed workspace is not overwritten by legacy review metadata');
assert.equal(dockerItem?.agentId, 'docker-a3s-code-loop', 'detected Agent name is not overwritten by a legacy review key');
const legacyDeepLink = dockerAggregation.agentInventory({
  timeType: 'last_3h',
  agentAssetId: legacyMetadataAssetId,
  agentId: 'f6611c0768c2',
  workspacePath: 'unknown',
  includeUnclassified: true,
  limit: 1,
});
assert.equal(legacyDeepLink.items[0]?.agentAssetId, dockerAssetId, 'asset selection wins over stale display and workspace parameters');
assert.equal(legacyDeepLink.items[0]?.eventCount, 1);

console.log('Agent asset identity and immutable display-name overlay verification passed.');
