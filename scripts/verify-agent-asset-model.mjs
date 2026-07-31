#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  agentAssetIdForEvent,
  detectedAgentIdentity,
} = require('../apps/api/dist/security-monitoring/agent-identity.js');
const {
  AgentMetadataService,
} = require('../apps/api/dist/security-monitoring/agent-metadata.service.js');

function event({
  agentId,
  pid,
  rootPid,
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

const detected = detectedAgentIdentity(rootOneShell);
assert.equal(detected.detectedName, 'codex');
assert.equal(detected.detectedClassification, 'probable_agent');
assert.equal(detected.runtime, 'host');
assert.equal(detected.locationLabel, 'security/AnySentry · PID 100');

const service = new AgentMetadataService();
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

console.log('Agent asset identity and immutable display-name overlay verification passed.');
