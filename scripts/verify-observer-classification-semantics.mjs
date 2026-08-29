#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const {
  CAPTURE_PROFILES,
  CLASSIFICATION_SEMANTICS_SCHEMA,
  IDENTITY_CLASSIFICATIONS,
  UNKNOWN_REASONS,
  WORKLOAD_ROLES,
  classificationSemanticsEnvelope,
  resolveClassificationSemantics,
} = require('./observer-classification-semantics.js');
const { mergeAttributionClassifications } = require('./observer-attribution-merge.js');
const { WorkloadIdentityCache } = require('./observer-workload-filter.js');

const forwarder = fileURLToPath(new URL('./observer-forward.js', import.meta.url));

const expectedIdentity = ['confirmed_agent', 'probable_agent', 'non_agent', 'unknown'];
const expectedRoles = [
  'agent',
  'anysentry_internal',
  'platform_infrastructure',
  'business_service',
  'ordinary_process',
  'unknown',
];
const expectedCaptures = [
  'agent_full',
  'probable_investigation',
  'security_full',
  'investigation_full',
  'business_context',
  'infrastructure_aggregate',
  'unknown_discovery',
  'self_health',
];
const expectedUnknownReasons = [
  'snapshot_not_ready',
  'snapshot_miss',
  'container_identity_missing',
  'container_name_missing',
  'parent_missing',
  'process_exited_before_enrichment',
  'ancestry_incomplete',
  'pid_reuse_ambiguous',
  'signature_miss',
  'template_conflict',
  'policy_expired',
  'shared_scope_ambiguous',
  'unsupported_agent_adapter',
];

assert.deepEqual(IDENTITY_CLASSIFICATIONS, expectedIdentity);
assert.deepEqual(WORKLOAD_ROLES, expectedRoles);
assert.deepEqual(CAPTURE_PROFILES, expectedCaptures);
assert.deepEqual(UNKNOWN_REASONS, expectedUnknownReasons);

function observerEvent(kind = 'FileAccess', process = {}, payload = {}) {
  return {
    identity: { agent: 'producer-claim', task: String(process.pid ?? payload.pid ?? ''), session: 'producer-session' },
    process,
    event: { [kind]: payload },
    classificationSemantics: {
      schemaVersion: 'forged',
      identityClassification: 'confirmed_agent',
      workloadRole: 'agent',
      captureProfile: 'agent_full',
    },
  };
}

function classification(state, identity, options = {}) {
  return {
    state,
    ...(options.workloadRole ? { workloadRole: options.workloadRole } : {}),
    ...(options.captureProfile ? { captureProfile: options.captureProfile } : {}),
    ...(options.infrastructureFacts ? { infrastructureFacts: options.infrastructureFacts } : {}),
    attribution: {
      monitored: identity === 'confirmed_agent' || identity === 'probable_agent',
      classification: identity,
      confidence: identity === 'unknown' ? 0 : 1,
      source: options.source ?? 'test',
      reason: options.reason ?? 'not_evaluated',
      evidence: options.evidence ?? [],
      ...(options.physicalWorkloadId ? { physicalWorkloadId: options.physicalWorkloadId } : {}),
      ...(options.workloadRef ? { workloadRef: options.workloadRef } : {}),
      ...(options.conflict ? { conflict: true } : {}),
    },
  };
}

function semantic(input, event = observerEvent()) {
  return resolveClassificationSemantics(input, event);
}

// Rollout contract: legacy/off/invalid remain byte-compatible. Shadow and enforce publish the
// same observational view; enforcement only changes retention in later stages.
const unknown = classification('unknown', 'unknown', { evidence: ['workload_snapshot:miss'] });
for (const value of [undefined, '', 'legacy', 'off', 'invalid']) {
  assert.deepEqual(
    classificationSemanticsEnvelope(unknown, observerEvent(), {
      ...(value === undefined ? {} : { ANYSENTRY_UNKNOWN_RETENTION_MODE: value }),
    }),
    {},
    `${value ?? 'unset'} must remain on the exact legacy envelope`,
  );
}
assert.deepEqual(
  classificationSemanticsEnvelope(unknown, observerEvent(), {
    ANYSENTRY_UNKNOWN_RETENTION_MODE: 'shadow',
  }),
  {
    classificationSemantics: {
      schemaVersion: CLASSIFICATION_SEMANTICS_SCHEMA,
      identityClassification: 'unknown',
      workloadRole: 'unknown',
      captureProfile: 'unknown_discovery',
      unknownReason: 'snapshot_miss',
    },
  },
);
assert.deepEqual(
  classificationSemanticsEnvelope(unknown, observerEvent(), {
    ANYSENTRY_UNKNOWN_RETENTION_MODE: 'enforce',
  }),
  classificationSemanticsEnvelope(unknown, observerEvent(), {
    ANYSENTRY_UNKNOWN_RETENTION_MODE: 'shadow',
  }),
  'enforce retains the same classification facts as shadow',
);

// Golden input -> identity/role/capture contracts.
const agentConflict = semantic(classification('agent', 'probable_agent', {
  workloadRole: 'platform_infrastructure',
  conflict: true,
  evidence: ['label:io.anysentry.observe=false'],
}));
assert.deepEqual(agentConflict, {
  schemaVersion: CLASSIFICATION_SEMANTICS_SCHEMA,
  identityClassification: 'probable_agent',
  workloadRole: 'platform_infrastructure',
  captureProfile: 'probable_investigation',
});
const inconsistentAgent = classification('agent', 'non_agent', { conflict: true });
assert.equal(semantic(inconsistentAgent).identityClassification, 'probable_agent');
assert.equal(semantic(inconsistentAgent).workloadRole, 'agent');
assert.equal(semantic(inconsistentAgent).captureProfile, 'probable_investigation');

const embeddedConfirmedAgent = semantic(classification('agent', 'confirmed_agent', {
  workloadRole: 'business_service',
}));
assert.equal(embeddedConfirmedAgent.workloadRole, 'business_service');
assert.equal(embeddedConfirmedAgent.captureProfile, 'agent_full');

assert.equal(
  semantic(
    classification('agent', 'confirmed_agent'),
    observerEvent('SecurityAction', { pid: 10, ppid: 1 }, { pid: 10, kind: 'setuid' }),
  ).captureProfile,
  'security_full',
);
assert.equal(
  semantic(classification('agent', 'confirmed_agent', { captureProfile: 'investigation_full' })).captureProfile,
  'investigation_full',
);

const internal = semantic(classification('non_agent', 'non_agent', {
  physicalWorkloadId: 'docker:host:internal',
  workloadRole: 'anysentry_internal',
  evidence: [
    'label:io.anysentry.observe=false',
    'label:anysentry.io/workload-role=anysentry_internal',
  ],
}));
assert.equal(internal.workloadRole, 'anysentry_internal');
assert.equal(internal.captureProfile, 'self_health');

const legacyExcluded = semantic(classification('non_agent', 'non_agent', {
  physicalWorkloadId: 'docker:host:third-party',
  evidence: ['label:io.anysentry.observe=false'],
}));
assert.equal(legacyExcluded.workloadRole, 'business_service');
assert.equal(legacyExcluded.captureProfile, 'business_context');
assert.equal(
  semantic(classification('unknown', 'unknown', { workloadRole: 'ANYSENTRY_INTERNAL' })).workloadRole,
  'unknown',
  'inventory role values are exact and a typo cannot silently become self inventory',
);

const infrastructure = semantic(classification('infrastructure', 'non_agent'));
assert.equal(infrastructure.workloadRole, 'platform_infrastructure');
assert.equal(infrastructure.captureProfile, 'infrastructure_aggregate');

const business = semantic(classification('non_agent', 'non_agent', {
  workloadRole: 'business_service',
  physicalWorkloadId: 'k8s:cluster:pod:container',
}));
assert.equal(business.workloadRole, 'business_service');
assert.equal(business.captureProfile, 'business_context');

const ordinary = semantic(classification('non_agent', 'non_agent'));
assert.equal(ordinary.workloadRole, 'ordinary_process');
assert.equal(ordinary.captureProfile, 'business_context');

// UnknownReason is evidence-derived. Generic conflict and raw adapter claims cannot manufacture
// the two ambiguity/unsupported reasons.
const evidenceCases = [
  ['workload_snapshot:not_ready', 'snapshot_not_ready'],
  ['workload_snapshot:miss', 'snapshot_miss'],
  ['container_identity:missing', 'container_identity_missing'],
  ['container_name:missing', 'container_name_missing'],
  ['process_lineage:parent_missing', 'parent_missing'],
  ['process:exited_before_enrichment', 'process_exited_before_enrichment'],
  ['process_lineage:incomplete', 'ancestry_incomplete'],
  ['process_identity:pid_reuse_ambiguous', 'pid_reuse_ambiguous'],
  ['process_signature:miss', 'signature_miss'],
  ['template_ambiguous:one,two', 'template_conflict'],
  ['infrastructure_policy:expired', 'policy_expired'],
  ['shared_scope:ambiguous', 'shared_scope_ambiguous'],
  ['agent_adapter:unsupported', 'unsupported_agent_adapter'],
];
for (const [evidence, reason] of evidenceCases) {
  assert.equal(
    semantic(classification('unknown', 'unknown', { evidence: [evidence] }), observerEvent()).unknownReason,
    reason,
    evidence,
  );
}

const genericConflict = semantic(classification('unknown', 'unknown', {
  conflict: true,
  evidence: ['identity_conflict:workspace'],
}), observerEvent());
assert.equal(genericConflict.unknownReason, undefined);
assert.equal(
  semantic(classification('unknown', 'unknown', {
    evidence: ['shared_scope:ambiguous-but-not-the-closed-fact'],
  })).unknownReason,
  undefined,
);
const rawUnsupportedClaim = semantic(
  classification('unknown', 'unknown'),
  { ...observerEvent(), agentAdapter: { supported: false } },
);
assert.equal(rawUnsupportedClaim.unknownReason, undefined);

assert.equal(
  semantic(
    classification('unknown', 'unknown'),
    observerEvent('ProcessExit', { pid: 20 }, { pid: 20, exit_code: 0 }),
  ).unknownReason,
  'process_exited_before_enrichment',
);
assert.equal(
  semantic(
    classification('unknown', 'unknown', { evidence: ['workload_snapshot:miss'] }),
    observerEvent('ProcessExit', {
      pid: 20,
      lifecycle_reason: 'pid_reuse_ambiguous',
    }, { pid: 20, exit_code: 0 }),
  ).unknownReason,
  'pid_reuse_ambiguous',
  'Collector lifecycle facts take precedence over a generic inventory miss',
);
assert.equal(
  semantic(
    classification('unknown', 'unknown'),
    observerEvent('FileAccess', { pid: 21, ppid: 1, cgroup: '0::/docker/deadbeef' }, { pid: 21 }),
  ).unknownReason,
  'container_identity_missing',
);
assert.equal(
  semantic(
    classification('unknown', 'unknown', { physicalWorkloadId: 'docker:host:deadbeef' }),
    observerEvent('FileAccess', { pid: 22, ppid: 1 }, { pid: 22 }),
  ).unknownReason,
  'container_name_missing',
);
assert.equal(
  semantic(
    classification('unknown', 'unknown'),
    observerEvent('FileAccess', { pid: 23 }, { pid: 23 }),
  ).unknownReason,
  'parent_missing',
);
assert.equal(
  semantic(
    classification('unknown', 'unknown'),
    observerEvent('ToolExec', { pid: 24, ppid: 1, comm: 'custom-runner' }, { pid: 24, argv: ['custom-runner'] }),
  ).unknownReason,
  'signature_miss',
);

// Invalid explicit enum values are omitted rather than converted into unbounded reason strings.
const invalid = classification('unknown', 'unknown');
invalid.unknownReason = `dynamic-${'x'.repeat(4_096)}`;
assert.equal(semantic(invalid, observerEvent()).unknownReason, undefined);

// The merge boundary rejects a stale/forged resolved view; the Forwarder recomputes it after the
// final Agent-vs-Infrastructure arbitration.
const forgedCandidate = classification('agent', 'confirmed_agent');
forgedCandidate.classificationSemantics = {
  schemaVersion: 'forged',
  identityClassification: 'non_agent',
  workloadRole: 'platform_infrastructure',
  captureProfile: 'infrastructure_aggregate',
};
assert.equal(
  Object.hasOwn(mergeAttributionClassifications(forgedCandidate), 'classificationSemantics'),
  false,
);

// Workload snapshot roles are propagated only after strict closed-set validation.
const roleCache = new WorkloadIdentityCache({ readProcCgroup: () => '' });
assert.equal(roleCache.replace({
  schemaVersion: 'anysentry.workload_identity_snapshot.v1',
  version: 1,
  generatedAt: new Date().toISOString(),
  ready: true,
  errors: 0,
  entries: [
    {
      ids: ['valid-role-container'],
      classification: 'non_agent',
      workloadRole: 'business_service',
      physicalWorkloadId: 'docker:test:valid-role-container',
      source: 'docker',
      environment: 'docker',
      containerName: 'orders',
      evidence: ['inventory:service'],
    },
    {
      ids: ['invalid-role-container'],
      classification: 'unknown',
      workloadRole: 'tenant-123-dynamic-role',
      physicalWorkloadId: 'docker:test:invalid-role-container',
      source: 'docker',
      environment: 'docker',
      containerName: 'unclassified',
      evidence: ['inventory:unknown'],
    },
  ],
}), true);
const classifiedValidRole = roleCache.classify({
  identity: { agent: 'runtime', task: '30', session: 'valid-role-container' },
  process: { pid: 30, ppid: 1 },
  event: { ToolExec: { pid: 30, ppid: 1, argv: ['true'] } },
});
assert.equal(classifiedValidRole.workloadRole, 'business_service');
const classifiedInvalidRole = roleCache.classify({
  identity: { agent: 'runtime', task: '31', session: 'invalid-role-container' },
  process: { pid: 31, ppid: 1 },
  event: { ToolExec: { pid: 31, ppid: 1, argv: ['true'] } },
});
assert.equal(Object.hasOwn(classifiedInvalidRole, 'workloadRole'), false);

const reviewedRoleCache = new WorkloadIdentityCache({ readProcCgroup: () => '' });
assert.equal(reviewedRoleCache.replace({
  schemaVersion: 'anysentry.workload_identity_snapshot.v1',
  version: 1,
  generatedAt: new Date().toISOString(),
  ready: true,
  errors: 0,
  entries: [{
    ids: ['reviewed-internal-container'],
    classification: 'non_agent',
    attributionSource: 'manual_review',
    physicalWorkloadId: 'docker:test:reviewed-internal-container',
    evidence: ['manual_review:non_agent'],
  }],
}, 'manual-review'), true);
assert.equal(reviewedRoleCache.replace({
  schemaVersion: 'anysentry.workload_identity_snapshot.v1',
  version: 2,
  generatedAt: new Date().toISOString(),
  ready: true,
  errors: 0,
  entries: [{
    ids: ['reviewed-internal-container'],
    classification: 'unknown',
    workloadRole: 'anysentry_internal',
    attributionSource: 'kubernetes',
    physicalWorkloadId: 'k8s:test:reviewed-internal-container',
    evidence: ['label:anysentry.io/workload-role=anysentry_internal'],
  }],
}, 'kubernetes'), true);
const reviewedInternal = reviewedRoleCache.classify({
  identity: { agent: 'runtime', task: '32', session: 'reviewed-internal-container' },
  process: { pid: 32, ppid: 1 },
  event: { ToolExec: { pid: 32, ppid: 1, argv: ['true'] } },
});
assert.equal(reviewedInternal.state, 'non_agent', 'manual review remains authoritative for identity');
assert.equal(
  reviewedInternal.workloadRole,
  'anysentry_internal',
  'exact platform role supplements rather than overwrites the manual identity decision',
);

// Every resolved view remains a low-cardinality enum-only object even with high-cardinality input.
const allResolved = [
  agentConflict,
  internal,
  infrastructure,
  business,
  ordinary,
  ...evidenceCases.map(([evidence]) => semantic(classification('unknown', 'unknown', {
    evidence: [evidence, `dynamic:${'z'.repeat(2_000)}`],
  }))),
];
for (const resolved of allResolved) {
  assert.deepEqual(
    Object.keys(resolved).sort(),
    ['captureProfile', 'identityClassification', 'schemaVersion', 'unknownReason', 'workloadRole']
      .filter((key) => resolved[key] !== undefined)
      .sort(),
  );
  assert.ok(expectedIdentity.includes(resolved.identityClassification));
  assert.ok(expectedRoles.includes(resolved.workloadRole));
  assert.ok(expectedCaptures.includes(resolved.captureProfile));
  if (resolved.unknownReason) assert.ok(expectedUnknownReasons.includes(resolved.unknownReason));
  assert.ok(JSON.stringify(resolved).length < 400, 'resolved semantics must not carry IDs/evidence');
}

function eventLine() {
  return JSON.stringify({
    identity: { agent: 'runtime', task: '40', session: 'semantic-container' },
    process: {
      host_id: 'semantic-host',
      boot_id: 'semantic-boot',
      pid: 40,
      ppid: 1,
      start_time_ticks: '400',
      comm: 'orders',
      exe: '/srv/orders',
      cgroup_id: '40',
      cgroup: '0::/docker/semantic-container',
    },
    event: { ToolExec: { pid: 40, ppid: 1, argv: ['/srv/orders'] } },
    classificationSemantics: {
      schemaVersion: 'forged',
      identityClassification: 'confirmed_agent',
      workloadRole: 'agent',
      captureProfile: 'agent_full',
    },
  });
}

function selfEventLine(kind, payload) {
  return JSON.stringify({
    identity: { agent: 'runtime', task: '41', session: 'semantic-container' },
    process: {
      host_id: 'semantic-host',
      boot_id: 'semantic-boot',
      pid: 41,
      ppid: 1,
      start_time_ticks: '401',
      comm: 'anysentry-worker',
      exe: '/app/anysentry-worker',
      cgroup_id: '41',
      cgroup: '0::/docker/semantic-container',
    },
    event: { [kind]: payload },
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function within(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runForwarder(mode, options = {}) {
  const batches = [];
  const snapshotRequested = deferred();
  const server = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url.startsWith('/security-center/identity/snapshot')) {
      snapshotRequested.resolve();
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        schemaVersion: 'anysentry.workload_identity_snapshot.v1',
        version: 1,
        generatedAt: new Date().toISOString(),
        ready: true,
        errors: 0,
        entries: [{
          ids: ['semantic-container'],
          classification: 'non_agent',
          workloadRole: options.workloadRole ?? 'business_service',
          physicalWorkloadId: 'docker:semantic-host:semantic-container',
          source: 'docker',
          environment: 'docker',
          containerName: 'orders',
          evidence: ['inventory:business-service'],
        }],
      }));
      return;
    }
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const parsed = body ? JSON.parse(body) : {};
      response.writeHead(200, { 'Content-Type': 'application/json' });
      if (request.url === '/security-center/ingest/batch') {
        const events = parsed.events ?? [];
        batches.push(...events);
        response.end(JSON.stringify({
          code: 200,
          message: 'Success',
          data: {
            accepted: events.length > 0,
            acceptedEvents: events.length,
            rejectedEvents: 0,
            retryableEvents: 0,
            items: events.map((_, index) => ({ index, accepted: true })),
          },
        }));
      } else if (request.url === '/security-center/runtime/lease') {
        response.end('{"accepted":true,"leaseEpoch":1}');
      } else if (request.url === '/security-center/runtime/snapshot') {
        response.end('{"accepted":true,"applied":true,"duplicate":false}');
      } else {
        response.end('{"accepted":true}');
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}/security-center`;
  const child = spawn(process.execPath, [forwarder], {
    env: {
      ...process.env,
      ANYSENTRY_UNKNOWN_RETENTION_MODE: mode,
      ANYSENTRY_INGEST_URL: `${base}/ingest`,
      ANYSENTRY_BATCH_INGEST_URL: `${base}/ingest/batch`,
      ANYSENTRY_HEARTBEAT_URL: `${base}/collectors/heartbeat`,
      ANYSENTRY_IDENTITY_SNAPSHOT_URL: `${base}/identity/snapshot`,
      ANYSENTRY_AGENT_RUNTIME_SNAPSHOT_URL: `${base}/runtime/snapshot`,
      ANYSENTRY_AGENT_RUNTIME_LEASE_URL: `${base}/runtime/lease`,
      ANYSENTRY_IDENTITY_SNAPSHOT_SECS: '0.02',
      ANYSENTRY_HEARTBEAT_SECS: '0',
      ANYSENTRY_INFRASTRUCTURE_POLICY_SECS: '0',
      ANYSENTRY_DOCKER_DISCOVERY: 'off',
      ANYSENTRY_INFRA_FILTER: 'off',
      ANYSENTRY_BEHAVIOR_DISCOVERY: 'off',
      ANYSENTRY_AGENT_TEMPLATES_JSON: '[]',
      FORWARD_FILTER_MODE: options.filterMode ?? 'shadow',
      FORWARD_RETAIN_NON_AGENT: options.retainNonAgent ?? 'true',
      FORWARD_BATCH_SIZE: '1',
      FORWARD_BATCH_FLUSH_MS: '1',
      A3S_OBSERVER_COLLECTOR_ID: 'classification-semantics-contract',
    },
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  try {
    await within(snapshotRequested.promise, 3_000, `${mode} snapshot`);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const lines = options.lines ?? [eventLine()];
    child.stdin.end(`${lines.join('\n')}\n`);
    const exitCode = await within(new Promise((resolve) => child.once('exit', resolve)), 7_000, `${mode} exit`);
    assert.equal(exitCode, 0, stderr);
    if (options.expectedCount !== undefined) {
      assert.equal(batches.length, options.expectedCount, stderr);
    } else {
      assert.equal(batches.length, 1, stderr);
    }
    return options.returnAll ? batches : batches[0];
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    await new Promise((resolve) => server.close(resolve));
  }
}

const legacyForwarded = await runForwarder('legacy');
const shadowForwarded = await runForwarder('shadow');
const enforceForwarded = await runForwarder('enforce');
assert.equal(Object.hasOwn(legacyForwarded, 'classificationSemantics'), false);
assert.deepEqual(shadowForwarded.classificationSemantics, {
  schemaVersion: CLASSIFICATION_SEMANTICS_SCHEMA,
  identityClassification: 'non_agent',
  workloadRole: 'business_service',
  captureProfile: 'business_context',
});
assert.notEqual(shadowForwarded.classificationSemantics.schemaVersion, 'forged');
assert.deepEqual(
  enforceForwarded.classificationSemantics,
  shadowForwarded.classificationSemantics,
  'enforce keeps the same observational classification view as shadow',
);
const {
  classificationSemantics: _shadowOnly,
  sourceEventId: _shadowProcessScopedId,
  observedAt: _shadowObservedAt,
  ...shadowLegacyFields
} = shadowForwarded;
const {
  sourceEventId: _legacyProcessScopedId,
  observedAt: _legacyObservedAt,
  ...legacyComparableFields
} = legacyForwarded;
assert.deepEqual(
  shadowLegacyFields,
  legacyComparableFields,
  'shadow must dual-write only; legacy keep/drop and envelope fields remain identical',
);

const enforcedSelf = await runForwarder('enforce', {
  workloadRole: 'anysentry_internal',
  filterMode: 'enforce',
  retainNonAgent: 'false',
  lines: [
    selfEventLine('SecurityAction', { pid: 41, kind: 'ptrace', detail: 7 }),
    selfEventLine('FileAccess', { pid: 41, path: '/app/cache.tmp', write: true }),
  ],
  expectedCount: 1,
  returnAll: true,
});
assert.equal(
  JSON.parse(enforcedSelf[0].line).event.SecurityAction.kind,
  'ptrace',
  'self inventory must retain SecurityAction even when broad non-Agent filtering is enforced',
);
assert.equal(
  enforcedSelf[0].classificationSemantics.captureProfile,
  'security_full',
  'retained self SecurityAction is explicitly marked as high-fidelity security evidence',
);

console.log('observer classification semantics checks passed');
