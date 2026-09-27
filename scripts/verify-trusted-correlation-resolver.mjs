#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  parseTrustedCorrelation,
  resolveTrustedCorrelation,
} from '../apps/api/dist/security-monitoring/trusted-correlation.js';
import { canonicalProcessInstanceId } from '../apps/api/dist/security-monitoring/process-instance-identity.js';

const eventContext = {
  tenantId: 'tenant-a',
  environmentId: 'prod',
  workspaceId: 'workspace-a',
  physicalWorkloadId: 'docker:node-a:container-a',
  agentScopeId: 'pi-agent',
};

const applicationTrust = {
  verification: 'server_verified',
  authenticated: true,
  authority: 'application',
  allowedClaims: ['application_trace'],
  bindings: {
    tenantId: 'tenant-a',
    environmentId: 'prod',
    physicalWorkloadId: 'docker:node-a:container-a',
  },
};

const adapterTrust = {
  verification: 'server_verified',
  authenticated: true,
  authority: 'agent_adapter',
  allowedClaims: ['agent_adapter'],
  bindings: {
    tenantId: 'tenant-a',
    environmentId: 'prod',
    workspaceId: 'workspace-a',
  },
};

const process = {
  authority: 'server_process_graph',
  processInstanceId: canonicalProcessInstanceId({
    trustedSourceId: 'source-a',
    hostId: 'host-a',
    bootId: 'boot-a',
    pid: 4200,
    startTimeTicks: '1000000',
  }),
  hostId: 'host-a',
  bootId: 'boot-a',
  pid: 4200,
  startTime: 'ticks:1000000',
};

const observations = {
  verification: 'server_observed',
  process,
  runtimeRoot: {
    authority: 'attested_observer',
    agentScopeId: 'pi-agent',
    rootKey: '["host-a","boot-a",4200,"1000000"]',
    agentInstanceId: 'legacy-runtime-a',
  },
  physicalWorkload: {
    authority: 'server_inventory',
    physicalWorkloadId: 'docker:node-a:container-a',
  },
};

const trustedApplication = resolveTrustedCorrelation({
  eventContext,
  sourceTrust: applicationTrust,
  claims: {
    application: {
      invocationId: 'invocation-a',
      traceId: 'otel-trace-a',
      scope: { tenantId: 'tenant-a', physicalWorkloadId: 'docker:node-a:container-a' },
    },
  },
  observations,
});
assert.equal(trustedApplication.method, 'application_trace');
assert.equal(trustedApplication.schemaVersion, 'anysentry.trusted_correlation.v1');
assert.equal(trustedApplication.scope, 'invocation');
assert.equal(trustedApplication.authority, 'authenticated_application');
assert.equal(trustedApplication.invocationId, 'invocation-a');
assert.equal(trustedApplication.traceOrigin, 'incoming');
assert.ok(trustedApplication.agentRootInstanceId);
assert.match(trustedApplication.processInstanceId, /^pri_[a-f0-9]{24}$/u);
assert.ok(trustedApplication.confidence >= 0 && trustedApplication.confidence <= 1);
assert.equal('traceId' in trustedApplication, false, 'new view must not replace the legacy traceId');
assert.equal('sessionId' in trustedApplication, false, 'new view must not replace the legacy sessionId');
assert.equal('agentId' in trustedApplication, false, 'new view must not replace the legacy agentId');
assert.equal('runId' in trustedApplication, false, 'new view must not replace the legacy runId');

const trustedTraceOnlyInput = {
  eventContext,
  sourceTrust: applicationTrust,
  claims: {
    application: {
      traceId: 'otel-trace-without-invocation',
    },
  },
  observations,
};
const trustedTraceOnly = resolveTrustedCorrelation(trustedTraceOnlyInput);
assert.equal(trustedTraceOnly.method, 'application_trace');
assert.equal(trustedTraceOnly.scope, 'event');
assert.equal(trustedTraceOnly.invocationId, undefined, 'a trusted Trace alone is not an Invocation claim');
assert.deepEqual(
  resolveTrustedCorrelation(trustedTraceOnlyInput),
  trustedTraceOnly,
  'resolver output must be deterministic for an identical input',
);

const trustedAdapter = resolveTrustedCorrelation({
  eventContext,
  sourceTrust: adapterTrust,
  claims: {
    agentAdapter: {
      invocationId: 'adapter-invocation-a',
      toolCallId: 'tool-call-a',
      sessionId: 'adapter-session-a',
      traceId: 'adapter-trace-a',
    },
  },
  observations,
});
assert.equal(trustedAdapter.method, 'agent_adapter');
assert.equal(trustedAdapter.invocationId, 'adapter-invocation-a');
assert.equal(trustedAdapter.toolCallId, 'tool-call-a');
assert.equal(trustedAdapter.traceOrigin, 'adapter');

const untrustedSourceInput = {
  eventContext,
  sourceTrust: {
    ...applicationTrust,
    authenticated: false,
  },
  accepted: true,
  sourceId: 'accepted-source-is-not-trust',
  inboundAttribution: {
    invocationId: 'attacker-invocation',
    agentScopeId: 'pi-agent',
  },
  claims: {
    application: {
      invocationId: 'attacker-invocation',
      traceId: 'attacker-trace',
    },
  },
  observations,
};
const untrustedSource = resolveTrustedCorrelation(untrustedSourceInput);
assert.equal(untrustedSource.method, 'runtime_root');
assert.equal(untrustedSource.invocationId, undefined);
assert.notEqual(untrustedSource.authority, 'authenticated_application');
assert.deepEqual(untrustedSource.claimReceipts, [{
  kind: 'application_trace',
  decision: 'rejected',
  reason: 'source_unauthenticated',
}]);

const mismatchedClaim = resolveTrustedCorrelation({
  eventContext,
  sourceTrust: applicationTrust,
  claims: {
    application: {
      invocationId: 'cross-tenant-invocation',
      traceId: 'cross-tenant-trace',
      scope: { tenantId: 'tenant-b' },
    },
  },
  observations,
});
assert.equal(mismatchedClaim.method, 'runtime_root');
assert.equal(mismatchedClaim.invocationId, undefined);
assert.equal(mismatchedClaim.claimReceipts?.[0]?.reason, 'claim_scope_mismatch');

const mismatchedBinding = resolveTrustedCorrelation({
  eventContext,
  sourceTrust: {
    ...applicationTrust,
    bindings: { tenantId: 'tenant-a', environmentId: 'prod', physicalWorkloadId: 'docker:node-a:other-container' },
  },
  claims: { application: { invocationId: 'wrong-workload-invocation' } },
  observations,
});
assert.equal(mismatchedBinding.method, 'runtime_root');
assert.equal(mismatchedBinding.invocationId, undefined);
assert.equal(mismatchedBinding.claimReceipts?.[0]?.reason, 'binding_mismatch');

const incompleteBinding = resolveTrustedCorrelation({
  eventContext,
  sourceTrust: {
    ...applicationTrust,
    bindings: { tenantId: 'tenant-a', physicalWorkloadId: 'docker:node-a:container-a' },
  },
  claims: { application: { invocationId: 'missing-environment-binding' } },
  observations,
});
assert.equal(incompleteBinding.method, 'runtime_root');
assert.equal(incompleteBinding.claimReceipts?.[0]?.reason, 'binding_incomplete');

const legacySynthetic = resolveTrustedCorrelation({
  eventContext,
  sourceTrust: {
    ...applicationTrust,
    authenticated: false,
  },
  claims: { application: { traceId: 'synthetic:pid:time' } },
  legacy: { traceId: 'synthetic:pid:time', traceOrigin: 'legacy_synthetic' },
});
assert.equal(legacySynthetic.method, 'unassigned');
assert.equal(legacySynthetic.traceOrigin, 'legacy_synthetic');
assert.equal(legacySynthetic.invocationId, undefined);
assert.ok(legacySynthetic.provenance.includes('legacy_synthetic_trace'));

const runtimeFallback = resolveTrustedCorrelation({
  eventContext,
  sourceTrust: applicationTrust,
  observations,
});
assert.equal(runtimeFallback.method, 'runtime_root');
assert.equal(runtimeFallback.scope, 'runtime');
assert.equal(runtimeFallback.authority, 'attested_observer');
assert.equal(runtimeFallback.invocationId, undefined);
assert.equal(runtimeFallback.toolCallId, undefined);

const processGraphRuntime = resolveTrustedCorrelation({
  eventContext,
  sourceTrust: applicationTrust,
  observations: {
    ...observations,
    runtimeRoot: {
      ...observations.runtimeRoot,
      authority: 'server_process_graph',
    },
  },
});
assert.equal(processGraphRuntime.method, 'runtime_root');
assert.equal(processGraphRuntime.authority, 'server_process_graph');

const workloadFallback = resolveTrustedCorrelation({
  eventContext,
  sourceTrust: applicationTrust,
  observations: {
    verification: 'server_observed',
    process,
    physicalWorkload: {
      authority: 'server_inventory',
      physicalWorkloadId: 'docker:node-a:container-a',
    },
  },
});
assert.equal(workloadFallback.method, 'physical_workload');
assert.equal(workloadFallback.scope, 'workload');
assert.equal(workloadFallback.authority, 'server_inventory');
assert.equal(workloadFallback.invocationId, undefined);
assert.equal(workloadFallback.toolCallId, undefined);

const rootA = runtimeFallback.agentRootInstanceId;
const rootB = resolveTrustedCorrelation({
  eventContext,
  sourceTrust: applicationTrust,
  observations: {
    ...observations,
    runtimeRoot: {
      ...observations.runtimeRoot,
      rootKey: '["host-a","boot-a",4300,"1000010"]',
    },
  },
}).agentRootInstanceId;
assert.ok(rootA && rootB);
assert.notEqual(rootA, rootB, 'two Agent roots in one container must not collapse');

const instanceScopedRootA = resolveTrustedCorrelation({
  eventContext,
  sourceTrust: applicationTrust,
  observations: {
    verification: 'server_observed',
    runtimeRoot: {
      authority: 'server_process_graph',
      agentScopeId: 'agent-a',
      agentInstanceId: 'shared-container-instance',
    },
  },
}).agentRootInstanceId;
const instanceScopedRootB = resolveTrustedCorrelation({
  eventContext,
  sourceTrust: applicationTrust,
  observations: {
    verification: 'server_observed',
    runtimeRoot: {
      authority: 'server_process_graph',
      agentScopeId: 'agent-b',
      agentInstanceId: 'shared-container-instance',
    },
  },
}).agentRootInstanceId;
assert.equal(instanceScopedRootA, undefined);
assert.equal(
  instanceScopedRootB,
  undefined,
  'Agent scope namespacing cannot make an ambiguous legacy agentInstanceId root-authoritative',
);

const samePidNextLifetime = resolveTrustedCorrelation({
  eventContext,
  sourceTrust: applicationTrust,
  observations: {
    verification: 'server_observed',
    process: {
      ...process,
      processInstanceId: canonicalProcessInstanceId({
        trustedSourceId: 'source-a',
        hostId: 'host-a',
        bootId: 'boot-a',
        pid: 4200,
        startTimeTicks: '2000000',
      }),
      startTime: 'ticks:2000000',
    },
  },
});
assert.notEqual(
  workloadFallback.processInstanceId,
  samePidNextLifetime.processInstanceId,
  'PID reuse must be separated by process start identity',
);
assert.match(samePidNextLifetime.processInstanceId, /^pri_[a-f0-9]{24}$/u);

const incompleteProcess = resolveTrustedCorrelation({
  eventContext,
  sourceTrust: applicationTrust,
  observations: {
    verification: 'server_observed',
    process: { authority: 'server_process_graph', hostId: 'host-a', pid: 4200, startTime: '2000000' },
  },
});
assert.equal(incompleteProcess.processInstanceId, undefined, 'partial process tuple must not claim an instance identity');

const inferredOnly = resolveTrustedCorrelation({
  eventContext,
  sourceTrust: applicationTrust,
  observations: {
    verification: 'server_observed',
    process,
    inferredEpisode: {
      episodeId: 'episode-nearby-a',
      reason: 'temporal_proximity',
      confidence: 0.95,
    },
  },
});
assert.equal(inferredOnly.method, 'inferred_episode');
assert.equal(inferredOnly.inferred, true);
assert.equal(inferredOnly.inferredEpisodeId, 'episode-nearby-a');
assert.equal(inferredOnly.invocationId, undefined, 'time proximity must never synthesize an invocation');
assert.equal(inferredOnly.confidence, 0.49, 'inference confidence must remain explicitly weak');

const concurrentOne = resolveTrustedCorrelation({
  eventContext,
  sourceTrust: adapterTrust,
  claims: { agentAdapter: { invocationId: 'concurrent-1' } },
  observations,
});
const concurrentTwo = resolveTrustedCorrelation({
  eventContext,
  sourceTrust: adapterTrust,
  claims: { agentAdapter: { invocationId: 'concurrent-2' } },
  observations,
});
assert.equal(concurrentOne.processInstanceId, concurrentTwo.processInstanceId);
assert.notEqual(concurrentOne.invocationId, concurrentTwo.invocationId, 'trusted claims may split concurrent invocations on one PID');

const noClaimOne = resolveTrustedCorrelation({ eventContext, sourceTrust: adapterTrust, observations });
const noClaimTwo = resolveTrustedCorrelation({ eventContext, sourceTrust: adapterTrust, observations });
assert.equal(noClaimOne.method, 'runtime_root');
assert.equal(noClaimTwo.method, 'runtime_root');
assert.equal(noClaimOne.invocationId, undefined);
assert.equal(noClaimTwo.invocationId, undefined);
assert.deepEqual(noClaimOne, noClaimTwo, 'fallback output must be deterministic');

const oversizedClaim = resolveTrustedCorrelation({
  eventContext,
  sourceTrust: adapterTrust,
  claims: { agentAdapter: { invocationId: 'x'.repeat(513) } },
});
assert.equal(oversizedClaim.method, 'unassigned', 'oversized external identity text must fail closed');
assert.equal(oversizedClaim.invocationId, undefined);
assert.equal(oversizedClaim.claimReceipts?.[0]?.reason, 'invalid_claim');

const idPrefix = 'i'.repeat(512);
const oversizedClaimA = resolveTrustedCorrelation({
  eventContext,
  sourceTrust: adapterTrust,
  claims: { agentAdapter: { invocationId: `${idPrefix}a`, toolCallId: `${idPrefix}x` } },
});
const oversizedClaimB = resolveTrustedCorrelation({
  eventContext,
  sourceTrust: adapterTrust,
  claims: { agentAdapter: { invocationId: `${idPrefix}b`, toolCallId: `${idPrefix}y` } },
});
for (const rejected of [oversizedClaimA, oversizedClaimB]) {
  assert.equal(rejected.invocationId, undefined);
  assert.equal(rejected.toolCallId, undefined);
  assert.equal(rejected.claimReceipts?.[0]?.decision, 'rejected');
  assert.equal(rejected.claimReceipts?.[0]?.reason, 'invalid_claim');
}
assert.equal(
  [oversizedClaimA, oversizedClaimB].some((item) => item.authority === 'authenticated_agent_adapter'),
  false,
  'two IDs that differ only after byte 512 must be rejected, never truncated into one trusted identity',
);

for (const malformedClaims of [
  { agentAdapter: { invocationId: 42 } },
  { agentAdapter: { invocationId: { forged: true } } },
  { agentAdapter: { toolCallId: ['forged-tool'] } },
]) {
  let resolved;
  assert.doesNotThrow(() => {
    resolved = resolveTrustedCorrelation({
      eventContext,
      sourceTrust: adapterTrust,
      claims: malformedClaims,
    });
  });
  assert.equal(resolved.invocationId, undefined);
  assert.equal(resolved.toolCallId, undefined);
  assert.equal(resolved.claimReceipts?.[0]?.reason, 'invalid_claim');
}

const processFromTicks = resolveTrustedCorrelation({
  eventContext,
  observations: {
    verification: 'server_observed',
    process: {
      ...process,
      processInstanceId: canonicalProcessInstanceId({
        trustedSourceId: 'source-a', hostId: 'host-a', bootId: 'boot-a', pid: 4200, startTimeTicks: '1000000',
      }),
      startTime: 'ticks:1000000',
    },
  },
});
const processFromNs = resolveTrustedCorrelation({
  eventContext,
  observations: {
    verification: 'server_observed',
    process: {
      ...process,
      processInstanceId: canonicalProcessInstanceId({
        trustedSourceId: 'source-a', hostId: 'host-a', bootId: 'boot-a', pid: 4200, startTimeNs: '1000000',
      }),
      startTime: 'ns:1000000',
    },
  },
});
assert.ok(processFromTicks.processInstanceId && processFromNs.processInstanceId);
assert.notEqual(
  processFromTicks.processInstanceId,
  processFromNs.processInstanceId,
  'the process start clock kind must be part of ProcessInstance identity',
);

const ambiguousAgentInstanceOnly = resolveTrustedCorrelation({
  eventContext,
  observations: {
    verification: 'server_observed',
    runtimeRoot: {
      authority: 'server_process_graph',
      agentScopeId: 'pi-agent',
      agentInstanceId: 'container-level-legacy-instance',
    },
  },
});
assert.equal(
  ambiguousAgentInstanceOnly.agentRootInstanceId,
  undefined,
  'legacy agentInstanceId alone is not proof of a root-scoped Runtime identity',
);
assert.equal(ambiguousAgentInstanceOnly.method, 'unassigned');

for (const malformedObservations of [
  null,
  { verification: 'server_observed', process: 'forged-process' },
  {
    verification: 'server_observed',
    process: { authority: 'server_process_graph', hostId: ['host-a'], bootId: {}, pid: '4200', startTime: [] },
    runtimeRoot: { authority: 'server_process_graph', agentScopeId: {}, rootKey: [] },
  },
]) {
  let resolved;
  assert.doesNotThrow(() => {
    resolved = resolveTrustedCorrelation({
      eventContext,
      observations: malformedObservations,
    });
  });
  assert.equal(resolved.method, 'unassigned');
}

const validPersistedCorrelation = structuredClone(trustedAdapter);
assert.deepEqual(parseTrustedCorrelation(validPersistedCorrelation), validPersistedCorrelation);
assert.notEqual(
  parseTrustedCorrelation(validPersistedCorrelation),
  validPersistedCorrelation,
  'the public parser must return a bounded projection rather than the caller-owned object',
);

const forgedPersistedVariants = [
  { ...validPersistedCorrelation, method: 'forged_method' },
  { ...validPersistedCorrelation, authority: 'attested_observer' },
  { ...validPersistedCorrelation, scope: 'runtime' },
  { ...validPersistedCorrelation, confidence: Number.POSITIVE_INFINITY },
  { ...validPersistedCorrelation, invocationId: 'z'.repeat(513) },
  { ...validPersistedCorrelation, invocationId: { highCardinality: true } },
  { ...validPersistedCorrelation, toolCallId: ['forged-tool'] },
  { ...validPersistedCorrelation, provenance: Array.from({ length: 17 }, () => 'adapter_invocation') },
  {
    ...validPersistedCorrelation,
    claimReceipts: Array.from({ length: 5 }, () => ({
      kind: 'agent_adapter',
      decision: 'accepted',
      reason: 'authorized',
    })),
  },
  {
    ...validPersistedCorrelation,
    claimReceipts: [{ kind: 'agent_adapter', decision: 'accepted', reason: 'invalid_claim' }],
  },
  {
    ...validPersistedCorrelation,
    claimReceipts: [
      { kind: 'agent_adapter', decision: 'accepted', reason: 'authorized' },
      { kind: 'application_trace', decision: 'accepted', reason: 'authorized' },
    ],
  },
  {
    ...validPersistedCorrelation,
    processInstanceId: `pri_${'c'.repeat(24)}`,
    provenance: validPersistedCorrelation.provenance.filter((item) => item !== 'process_tuple'),
  },
  {
    ...validPersistedCorrelation,
    agentRootInstanceId: 'producer-controlled-root',
  },
  {
    ...validPersistedCorrelation,
    provenance: validPersistedCorrelation.provenance.filter((item) => item !== 'runtime_root_key'),
  },
];
for (const forged of forgedPersistedVariants) {
  let parsed;
  assert.doesNotThrow(() => { parsed = parseTrustedCorrelation(forged); });
  assert.equal(parsed, undefined, 'forged, malformed, or high-cardinality persisted correlation must fail closed');
}
for (const malformed of [null, [], 'forged', 42, { schemaVersion: 'anysentry.trusted_correlation.v1' }]) {
  let parsed;
  assert.doesNotThrow(() => { parsed = parseTrustedCorrelation(malformed); });
  assert.equal(parsed, undefined);
}

const immutableInput = structuredClone(untrustedSourceInput);
resolveTrustedCorrelation(untrustedSourceInput);
assert.deepEqual(untrustedSourceInput, immutableInput, 'resolver must not mutate input');

console.log('Trusted correlation resolver verification passed');
