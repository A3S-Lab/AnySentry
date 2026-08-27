#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AgentMetadataService } = require('../apps/api/dist/security-monitoring/agent-metadata.service.js');

const containerId = 'c'.repeat(64);
const assetId = 'agent_temporal_review';
const workspacePath = '/workspace/temporal-review';
const service = new AgentMetadataService();
const event = {
  workspacePath,
  agentId: 'temporal-agent',
  sessionId: 'temporal-session',
  userId: 'uid:1000',
  attribution: {
    monitored: false,
    classification: 'unknown',
    physicalWorkloadId: `container:${containerId}`,
    confidence: 0,
    reason: 'not_evaluated',
    source: 'behavior',
  },
};

const first = service.review('temporal-agent', {
  workspacePath,
  agentAssetId: assetId,
  decision: 'non_agent',
  currentClassification: 'unknown',
  expectedRevision: 0,
  identityKeys: [containerId],
}, 'temporal-reviewer', 2_000);
assert.equal(first.reviewRevision, 1);
assert.equal(first.reviewHistory[0].effectiveAt, 2_000);

assert.equal(
  service.applyReview(event, 1_999).attribution.classification,
  'unknown',
  'an event before the review boundary keeps its automatic identity',
);
assert.equal(
  service.applyReview(event, 2_000).attribution.classification,
  'non_agent',
  'the review becomes effective inclusively at its persisted boundary',
);
assert.equal(
  service.applyReview(event).attribution.classification,
  'non_agent',
  'omitting eventAt preserves the current-review compatibility behavior',
);
assert.equal(service.resolveEvent(event, 1_999).effectiveClassification, 'unknown');
assert.equal(service.resolveEvent(event, 2_000).effectiveClassification, 'non_agent');
assert.equal(service.resolveEvent(event).effectiveClassification, 'non_agent');

const cleared = service.review('temporal-agent', {
  workspacePath,
  agentAssetId: assetId,
  decision: 'clear',
  currentClassification: 'non_agent',
  expectedRevision: 1,
}, 'temporal-reviewer', 3_000);
assert.equal(cleared.reviewRevision, 2);
assert.equal(cleared.reviewDecision, undefined);
assert.equal(cleared.reviewEffectiveAt, new Date(3_000).toISOString().slice(0, 19).replace('T', ' '));
assert.equal(cleared.reviewHistory.at(-1).decision, 'clear');
assert.equal(cleared.reviewHistory.at(-1).effectiveAt, 3_000);
assert.deepEqual(cleared.reviewHistory.at(-1).identityKeys, [containerId]);

assert.equal(
  service.applyReview(event, 2_999).attribution.classification,
  'non_agent',
  'clear must not retroactively erase the review valid before its boundary',
);
assert.equal(
  service.applyReview(event, 3_000).attribution.classification,
  'unknown',
  'events at or after clear use automatic identity again',
);
assert.equal(
  service.applyReview(event).attribution.source,
  'behavior',
  'current compatibility lookup restores the original automatic source after clear',
);

assert.throws(
  () => service.review('temporal-agent', {
    workspacePath,
    agentAssetId: assetId,
    decision: 'confirmed_agent',
    currentClassification: 'unknown',
    expectedRevision: 2,
    identityKeys: [containerId],
  }, 'temporal-reviewer', 2_500),
  /effective time must be monotonic/u,
  'review boundaries cannot move backwards',
);

const restored = new AgentMetadataService();
const persistedRecord = structuredClone([...service.records.values()][0]);
restored.storeNormalized(persistedRecord);
assert.equal(restored.applyReview(event, 2_500).attribution.classification, 'non_agent');
assert.equal(restored.applyReview(event, 3_500).attribution.classification, 'unknown');
assert.equal(restored.list()[0].reviewRevision, 2);
assert.equal(restored.list()[0].reviewHistory.length, 2);

console.log('PASS Agent review effective-time history and clear recovery');
