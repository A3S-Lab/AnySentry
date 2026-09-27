#!/usr/bin/env node

/**
 * Observer inventory push + assistant apply_identity_rule chain.
 * Covers: trimmed docker inventory landing in the in-memory snapshot, classification/source
 * filters, process-signature visibility, and the createDraft -> preview -> shadow -> promote
 * chain where the assistant proposes and a different (chat user) actor enforces.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { ObserverInventoryService, OBSERVER_INVENTORY_SCHEMA } = require('./dist/security-monitoring/observer-inventory.service.js');
const { inspectWorkloads, buildIdentityDraft } = require('./dist/security-monitoring/assistant-workload-tools.js');
const { FilterRuleCatalogService } = require('./dist/security-monitoring/filter-rule-catalog.service.js');

// --- ObserverInventoryService ------------------------------------------------
const service = new ObserverInventoryService();
assert.throws(
  () => service.replace('src-a', { schemaVersion: 'wrong', entries: [] }),
  /observer_inventory/,
);

const push = {
  schemaVersion: OBSERVER_INVENTORY_SCHEMA,
  nodeName: 'node-a',
  generatedAt: '2026-09-23T00:00:00.000Z',
  entries: [
    {
      id: 'abc123def456',
      containerName: 'internal-agent',
      containerImage: 'registry.internal/agent:1.2',
      containerState: 'running',
      classification: 'unknown',
      labels: {
        'anysentry.io/workload-kind': 'agent',
        'app.kubernetes.io/name': 'must-not-leak',
        'secret.io/token': 'must-not-leak',
      },
      evidence: ['label_missing:anysentry.io/workload-kind'],
      processes: [{ comm: 'internal-agent', exeBasename: 'internal-agent' }],
    },
    {
      id: 'deadbeef9999',
      containerName: 'redis',
      classification: 'non_agent',
      evidence: [],
    },
  ],
};
const first = service.replace('src-a', push);
assert.equal(first.accepted, 2);
assert.equal(first.unchanged, false);
const keepalive = service.replace('src-a', push);
assert.equal(keepalive.unchanged, true, 'identical keepalive must not bump the snapshot version');
assert.equal(keepalive.version, first.version);

const entries = service.entries();
assert.equal(entries.length, 2);
const agent = entries.find((entry) => entry.containerName === 'internal-agent');
assert.equal(agent.source, 'docker');
assert.equal(agent.environment, 'docker');
assert.equal(agent.classification, 'unknown');
assert.deepEqual(agent.labels, { 'anysentry.io/workload-kind': 'agent' }, 'only anysentry.io/* labels cross the wire');
assert.deepEqual(agent.processes, [{ comm: 'internal-agent', exeBasename: 'internal-agent' }]);
assert.equal(agent.physicalWorkloadId, 'docker:abc123def456');

// nodeName filtering keeps other nodes' inventories out of a node-scoped snapshot.
assert.equal(service.entries('node-a').length, 2);
assert.equal(service.entries('node-b').length, 0);

// Stale sources drop out of the snapshot without waiting for a restart.
service.sources.get('src-a').receivedAt = Date.now() - 11 * 60_000;
assert.equal(service.entries().length, 0);

// --- inspectWorkloads filters + process visibility ---------------------------
const inspection = inspectWorkloads({
  ready: true,
  entries: [
    {
      ids: ['docker:x'],
      classification: 'unknown',
      physicalWorkloadId: 'docker:x',
      source: 'docker',
      environment: 'docker',
      containerName: 'internal-agent',
      processes: [{ comm: 'internal-agent', exeBasename: 'internal-agent' }],
      evidence: [],
    },
    {
      ids: ['k8s:y'],
      classification: 'non_agent',
      physicalWorkloadId: 'k8s:y',
      source: 'kubernetes',
      namespace: 'kube-system',
      podName: 'coredns',
      evidence: [],
    },
  ],
  classification: 'unknown',
  source: 'docker',
});
assert.equal(inspection.matched.length, 1);
assert.equal(inspection.matched[0].containerName, 'internal-agent');
assert.deepEqual(inspection.matched[0].processes, [{ comm: 'internal-agent', exeBasename: 'internal-agent' }]);

// q matches process names through the haystack.
const byProcess = inspectWorkloads({
  entries: inspection.matched.length ? [
    {
      ids: ['docker:x'],
      classification: 'unknown',
      physicalWorkloadId: 'docker:x',
      containerName: 'unlabeled-box',
      processes: [{ comm: 'internal-agent' }],
      evidence: [],
    },
  ] : [],
  q: 'internal-agent',
});
assert.equal(byProcess.matched.length, 1, 'q must match the reported process signature');

// --- assistant-style apply chain on the real catalog --------------------------
const persisted = [];
const auditRecords = [];
const relational = {
  isReady: () => true,
  loadPlatformConfig: async () => undefined,
  savePlatformConfig: async (key, record, updatedAt) => {
    persisted.push({ key, record: structuredClone(record), updatedAt });
    return true;
  },
};
const audit = { record: (record) => auditRecords.push(record) };
const catalog = new FilterRuleCatalogService(relational, audit);
const assistantActor = { type: 'system', id: 'anysentry-assistant', displayName: 'AnySentry assistant' };
const chatUser = { type: 'operator', id: 'operator' };

const draftInput = buildIdentityDraft({ comm: 'internal-agent', confirm: true }).draft;
const draft = await catalog.createDraft(draftInput, assistantActor);
assert.equal(draft.lifecycleStage, 'draft');
assert.equal(draft.createdBy, assistantActor.id);

// The governance preview must match the current revision, so it runs after shadow.
const shadow = await catalog.shadow(draft.ruleId, { expectedRevision: draft.revision, reason: 'assistant apply: shadow' }, assistantActor);
const preview = await catalog.preview(draft.ruleId, chatUser, { serverOwned: true, matchedAssets: 1, matchedInstances: 1, matchedNodes: 1 });
assert.equal(preview.valid, true);

// The assistant cannot enforce its own draft; the confirming chat user can.
await assert.rejects(
  catalog.promote(shadow.ruleId, { expectedRevision: shadow.revision, reason: 'self approval' }, assistantActor),
  (error) => error?.code === 'authority_required',
);
const enforced = await catalog.promote(shadow.ruleId, { expectedRevision: shadow.revision, reason: 'confirmed in chat' }, chatUser);
assert.equal(enforced.lifecycleStage, 'enforced');
assert.equal(enforced.authority, 'authoritative');

// The enforced signature enters the forwarder projection as enabled.
const runtime = catalog.projection().runtimeSignatures.runtimes.find((item) => item.ruleId === enforced.ruleId);
assert(runtime, 'enforced runtime signature must compile into the forwarder projection');
assert.equal(runtime.id, enforced.ruleId, 'catalog-created rules must project a registry-valid id');
assert.equal(runtime.enabled, true);
assert.deepEqual(runtime.variants, [{ commExact: ['internal-agent'] }]);
assert(persisted.length > 0, 'enforcement must be durable before publication');
assert(auditRecords.some((record) => record.action === 'filter_rule.promoted'));

// Container-scoped drafts route to agent_template and compile into the template projection with
// an observer-loadable agentId and deployment.
const templateDraft = await catalog.createDraft(
  buildIdentityDraft({ container: 'internal-agent-web', image: 'internal-agent-web:latest', confirm: true }).draft,
  assistantActor,
);
const templateShadow = await catalog.shadow(templateDraft.ruleId, { expectedRevision: templateDraft.revision, reason: 'assistant apply: shadow' }, assistantActor);
await catalog.preview(templateDraft.ruleId, chatUser, { serverOwned: true, matchedAssets: 1, matchedInstances: 1, matchedNodes: 1 });
await catalog.promote(templateShadow.ruleId, { expectedRevision: templateShadow.revision, reason: 'confirmed in chat' }, chatUser);
const template = catalog.projection().agentTemplates.templates.find((item) => item.ruleId === templateDraft.ruleId);
assert(template, 'enforced agent template must compile into the forwarder projection');
assert.equal(template.deployment, 'docker');
assert.equal(template.match.container, 'internal-agent-web');
assert.equal(template.match.image, 'internal-agent-web:latest');
assert(template.agentId, 'catalog-created templates must project an observer-loadable agentId');
assert.equal(template.classification, 'probable_agent');

// --- assistant per-request model config resolution --------------------------
{
  const { SecurityAssistantService } = require('./dist/security-monitoring/security-assistant.service.js');
  const stub = {};
  const fastReview = {
    get: (profile) => profile === 'fast_review' ? {
      url: 'https://llm.internal.example/v1',
      model: 'intranet-model-x',
      apiKey: 'test-key',
      timeoutS: 180,
      contextTokens: 65_536,
    } : null,
  };
  const svc = new SecurityAssistantService(stub, stub, stub, stub, stub, stub, stub, new ObserverInventoryService(), fastReview);
  const resolved = svc.resolveModelConfig();
  assert.equal(resolved.source, 'fast_review');
  assert.equal(resolved.model, 'intranet-model-x');
  assert.equal(resolved.timeoutMs, 180_000, 'page timeoutS drives the assistant budget');
  assert.match(resolved.acl, /intranet-model-x/);
  assert.match(resolved.acl, /llm\.internal\.example/);

  const envOnly = new SecurityAssistantService(stub, stub, stub, stub, stub, stub, stub, new ObserverInventoryService(), { get: () => null });
  const fallback = envOnly.resolveModelConfig();
  assert.equal(fallback.source, 'environment');
  assert.equal(fallback.timeoutMs, 90_000, 'env fallback keeps the legacy default budget');
  // Per-request resolution: the value is not frozen at construction.
  assert.notEqual(svc.resolveModelConfig().cacheKey, fallback.cacheKey);
}
console.log('verify-assistant-observer-inventory: ok');
