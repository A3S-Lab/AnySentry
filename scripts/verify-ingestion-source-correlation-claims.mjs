import assert from 'node:assert/strict';

process.env.ANYSENTRY_TRUSTED_CORRELATION_MODE = 'shadow';

const {
  IngestionSourceService,
  authorizeCorrelationClaims,
  normalizeCorrelationClaimsPolicy,
} = await import('../apps/api/dist/security-monitoring/ingestion-source.service.js');

function service() {
  return new IngestionSourceService(
    {
      enabled: false,
      init: async () => false,
      loadIngestionSources: async () => [],
      saveIngestionSources: async () => false,
    },
    {
      recordSourceActivity: async () => undefined,
      latestSourceActivities: async () => [],
    },
    {
      isReady: () => false,
      saveIngestionSources: async () => false,
      loadIngestionSources: async () => [],
    },
  );
}

const bindings = {
  tenantIds: ['tenant-a'],
  environmentIds: ['production'],
  workspaceIds: ['workspace-a'],
  workspacePaths: ['/srv/agent-a'],
  collectorIds: ['collector-a'],
  physicalWorkloadIds: ['workload-a'],
  agentScopeIds: ['agent-a'],
};

const claim = {
  authority: 'agent_adapter',
  tenantId: 'tenant-a',
  environmentId: 'production',
  workspaceId: 'workspace-a',
  workspacePath: '/srv/agent-a',
  collectorId: 'collector-a',
  physicalWorkloadId: 'workload-a',
  agentScopeId: 'agent-a',
};

{
  const sources = service();
  const legacy = sources.create({
    name: 'legacy tokenless forwarder',
    type: 'forwarder',
    enabled: true,
    requireToken: false,
  });
  const resolved = sources.resolve({ sourceId: legacy.source.sourceId, type: 'forwarder' });
  assert.equal(resolved.accepted, true, 'legacy source acceptance must remain unchanged');
  assert.equal(resolved.reason, undefined);
  assert.equal(resolved.authenticated, false);
  assert.equal(resolved.authentication, 'none');
  assert.equal(resolved.claimAuthorization, false);
  assert.equal(resolved.claimAuthorizationReason, 'policy_disabled');
  assert.equal(Object.hasOwn(legacy.source, 'correlationClaims'), false, 'legacy API item must not gain an additive field while mode is off');
  assert.equal(Object.hasOwn(sources.snapshot()[0], 'correlationClaims'), false, 'legacy persisted record keeps the optional field absent');

  const unresolved = sources.resolve({});
  assert.equal(unresolved.accepted, true, 'unregistered legacy traffic remains accepted');
  assert.equal(unresolved.claimAuthorization, false);
  assert.equal(unresolved.claimAuthorizationReason, 'source_unresolved');
}

{
  const sources = service();
  const created = sources.create({
    name: 'trusted adapter',
    type: 'forwarder',
    enabled: true,
    requireToken: true,
    correlationClaims: { enabled: true, authority: 'agent_adapter', bindings },
  });
  assert.ok(created.token);

  const trusted = sources.resolve({
    sourceId: created.source.sourceId,
    token: created.token,
    type: 'forwarder',
    correlationClaim: claim,
  });
  assert.equal(trusted.accepted, true);
  assert.equal(trusted.authenticated, true);
  assert.equal(trusted.authentication, 'token');
  assert.equal(trusted.claimAuthorization, true);
  assert.equal(trusted.claimAuthorizationReason, 'authorized');
  assert.equal(trusted.claimAuthority, 'agent_adapter');

  const missingToken = sources.resolve({
    sourceId: created.source.sourceId,
    type: 'forwarder',
    correlationClaim: claim,
  });
  assert.equal(missingToken.accepted, false, 'legacy protected-source rejection must remain unchanged');
  assert.equal(missingToken.reason, 'source token required');
  assert.equal(missingToken.authenticated, false);
  assert.equal(missingToken.claimAuthorization, false);
  assert.equal(missingToken.claimAuthorizationReason, 'token_missing');

  const invalidToken = sources.resolve({
    sourceId: created.source.sourceId,
    token: 'wrong-token',
    type: 'forwarder',
    correlationClaim: claim,
  });
  assert.equal(invalidToken.accepted, false, 'legacy invalid-token rejection must remain unchanged');
  assert.equal(invalidToken.reason, 'invalid source token');
  assert.equal(invalidToken.authenticated, false);
  assert.equal(invalidToken.claimAuthorization, false);
  assert.equal(invalidToken.claimAuthorizationReason, 'token_invalid');

  for (const [field, value, reason] of [
    ['workspacePath', '/srv/other', 'workspace_binding_mismatch'],
    ['physicalWorkloadId', 'workload-other', 'workload_binding_mismatch'],
    ['agentScopeId', 'agent-other', 'agent_binding_mismatch'],
  ]) {
    const mismatched = sources.resolve({
      sourceId: created.source.sourceId,
      token: created.token,
      type: 'forwarder',
      correlationClaim: { ...claim, [field]: value },
    });
    assert.equal(mismatched.accepted, true, `${field} claim mismatch must not widen legacy rejection`);
    assert.equal(mismatched.claimAuthorization, false);
    assert.equal(mismatched.claimAuthorizationReason, reason);
  }

  const omittedRequiredScope = sources.resolve({
    sourceId: created.source.sourceId,
    token: created.token,
    type: 'forwarder',
    correlationClaim: { ...claim, tenantId: undefined },
  });
  assert.equal(omittedRequiredScope.accepted, true);
  assert.equal(omittedRequiredScope.claimAuthorization, false);
  assert.equal(omittedRequiredScope.claimAuthorizationReason, 'required_scope_missing');

  const omittedBoundAgent = sources.resolve({
    sourceId: created.source.sourceId,
    token: created.token,
    type: 'forwarder',
    correlationClaim: { ...claim, agentScopeId: undefined },
  });
  assert.equal(omittedBoundAgent.accepted, true);
  assert.equal(omittedBoundAgent.claimAuthorization, true, 'workspace/workload/agent are alternative proofs');
  assert.equal(omittedBoundAgent.claimAuthorizationReason, 'authorized');

  const agentOnlyAnchor = sources.resolve({
    sourceId: created.source.sourceId,
    token: created.token,
    type: 'forwarder',
    correlationClaim: {
      authority: 'agent_adapter',
      tenantId: 'tenant-a',
      environmentId: 'production',
      collectorId: 'collector-a',
      agentScopeId: 'agent-a',
    },
  });
  assert.equal(agentOnlyAnchor.claimAuthorization, true, 'one exact identity anchor is sufficient');

  sources.recordAccepted(trusted, 'event', {
    collectorId: 'learned-collector',
    workspacePath: '/learned/workspace',
  });
  const afterLearning = sources.snapshot().find((source) => source.sourceId === created.source.sourceId);
  assert.equal(afterLearning?.collectorId, 'learned-collector');
  assert.equal(afterLearning?.workspacePath, '/learned/workspace');
  assert.deepEqual(afterLearning?.correlationClaims?.bindings, bindings, 'legacy activity learning must not mutate trust bindings');

  const serialized = JSON.stringify(afterLearning);
  const restored = service();
  const record = restored.normalize(JSON.parse(serialized));
  restored.sources.set(record.sourceId, record);
  const restoredResolution = restored.resolve({
    sourceId: record.sourceId,
    token: created.token,
    type: 'forwarder',
    correlationClaim: claim,
  });
  assert.equal(restoredResolution.accepted, true);
  assert.equal(restoredResolution.claimAuthorization, true, 'persisted trust policy must survive normalization');
}

{
  process.env.ANYSENTRY_TRUSTED_CORRELATION_MODE = 'shadow';
  const enabled = service();
  const created = enabled.create({
    name: 'rollback-safe trusted adapter',
    type: 'forwarder',
    enabled: true,
    requireToken: true,
    correlationClaims: { enabled: true, authority: 'agent_adapter', bindings },
  });
  const persisted = JSON.parse(JSON.stringify(enabled.snapshot()[0]));

  process.env.ANYSENTRY_TRUSTED_CORRELATION_MODE = 'off';
  const disabled = service();
  const restored = disabled.normalize(persisted);
  disabled.sources.set(restored.sourceId, restored);
  assert.deepEqual(
    disabled.snapshot()[0].correlationClaims?.bindings,
    bindings,
    'kill switch must preserve the persisted Source policy internally',
  );
  assert.equal(
    Object.hasOwn(disabled.list({ sourceId: restored.sourceId }).items[0], 'correlationClaims'),
    false,
    'kill switch must hide additive Source policy fields from legacy read models',
  );
  disabled.update(restored.sourceId, {
    correlationClaims: {
      enabled: true,
      authority: 'application',
      bindings: { tenantIds: ['attacker-overwrite'] },
    },
  });
  assert.deepEqual(
    disabled.snapshot()[0].correlationClaims?.bindings,
    bindings,
    'policy mutation while disabled must be ignored without erasing the last-known configuration',
  );

  process.env.ANYSENTRY_TRUSTED_CORRELATION_MODE = 'shadow';
  const reenabled = disabled.resolve({
    sourceId: restored.sourceId,
    token: created.token,
    type: 'forwarder',
    correlationClaim: claim,
  });
  assert.equal(reenabled.claimAuthorization, true, 're-enabling must restore the persisted policy without rewriting data');
}

{
  const sources = service();
  const observer = sources.create({
    name: 'trusted observer runtime',
    type: 'observer',
    enabled: true,
    requireToken: true,
    correlationClaims: {
      enabled: true,
      authority: 'observer_runtime',
      bindings: {
        collectorIds: ['collector-runtime'],
        tenantIds: ['not-required-for-runtime'],
        workspacePaths: ['/srv/runtime'],
        physicalWorkloadIds: ['runtime-workload'],
        agentScopeIds: ['runtime-agent'],
      },
    },
  });
  const exact = sources.resolve({
    sourceId: observer.source.sourceId,
    token: observer.token,
    type: 'observer',
    correlationClaim: {
      authority: 'observer_runtime',
      collectorId: 'collector-runtime',
      tenantId: 'not-required-for-runtime',
      workspacePath: '/srv/runtime',
      physicalWorkloadId: 'runtime-workload',
      agentScopeId: 'runtime-agent',
    },
  });
  assert.equal(exact.accepted, true);
  assert.equal(exact.claimAuthorization, true, 'observer runtime requires its collector and every configured scope');
  const tenantMismatch = sources.resolve({
    sourceId: observer.source.sourceId,
    token: observer.token,
    type: 'observer',
    correlationClaim: {
      authority: 'observer_runtime',
      collectorId: 'collector-runtime',
      tenantId: 'other-tenant',
      workspacePath: '/srv/runtime',
      physicalWorkloadId: 'runtime-workload',
      agentScopeId: 'runtime-agent',
    },
  });
  assert.equal(tenantMismatch.accepted, true);
  assert.equal(tenantMismatch.claimAuthorization, false);
  assert.equal(tenantMismatch.claimAuthorizationReason, 'tenant_binding_mismatch');
  const missingAgent = sources.resolve({
    sourceId: observer.source.sourceId,
    token: observer.token,
    type: 'observer',
    correlationClaim: {
      authority: 'observer_runtime',
      collectorId: 'collector-runtime',
      tenantId: 'not-required-for-runtime',
      workspacePath: '/srv/runtime',
      physicalWorkloadId: 'runtime-workload',
    },
  });
  assert.equal(missingAgent.accepted, true);
  assert.equal(missingAgent.claimAuthorization, false, 'every configured observer scope must be present');
  assert.equal(missingAgent.claimAuthorizationReason, 'agent_binding_missing');
  const mismatch = sources.resolve({
    sourceId: observer.source.sourceId,
    token: observer.token,
    type: 'observer',
    correlationClaim: {
      authority: 'observer_runtime',
      collectorId: 'collector-other',
      tenantId: 'not-required-for-runtime',
      workspacePath: '/srv/runtime',
      physicalWorkloadId: 'runtime-workload',
      agentScopeId: 'runtime-agent',
    },
  });
  assert.equal(mismatch.accepted, true);
  assert.equal(mismatch.claimAuthorization, false);
  assert.equal(mismatch.claimAuthorizationReason, 'collector_binding_mismatch');
}

{
  const sources = service();
  const discovered = sources.resolve({
    collectorId: 'unmanaged-collector',
    sourceName: 'unmanaged observer',
    type: 'observer',
    correlationClaim: {
      authority: 'observer_runtime',
      collectorId: 'unmanaged-collector',
    },
  });
  assert.equal(discovered.accepted, true, 'tokenless discovered sources must keep legacy acceptance');
  assert.equal(discovered.source?.discovered, true);
  assert.equal(discovered.claimAuthorization, false);
  assert.equal(discovered.claimAuthorizationReason, 'source_discovered');
}

{
  const sources = service();
  const incompatible = sources.create({
    name: 'observer cannot assert application authority',
    type: 'observer',
    enabled: true,
    requireToken: true,
    correlationClaims: {
      enabled: true,
      authority: 'application',
      bindings: { collectorIds: ['collector-a'] },
    },
  });
  const resolution = sources.resolve({
    sourceId: incompatible.source.sourceId,
    token: incompatible.token,
    type: 'observer',
    correlationClaim: { authority: 'application', collectorId: 'collector-a' },
  });
  assert.equal(resolution.accepted, true);
  assert.equal(resolution.claimAuthorization, false);
  assert.equal(resolution.claimAuthorizationReason, 'source_type_not_allowed');
}

{
  const overlong = normalizeCorrelationClaimsPolicy({
    enabled: true,
    authority: 'application',
    bindings: {
      tenantIds: Array.from({ length: 100 }, (_, index) => `tenant-${index}${'x'.repeat(200)}`),
    },
  });
  assert.deepEqual(overlong.bindings.tenantIds, [], 'overlong identity bindings must fail closed, not truncate');

  const normalized = normalizeCorrelationClaimsPolicy({
    enabled: true,
    authority: 'application',
    bindings: {
      tenantIds: Array.from({ length: 100 }, (_, index) => `tenant-${index}`),
    },
  });
  assert.equal(normalized.bindings.tenantIds.length, 64, 'binding cardinality must be bounded');
  assert.ok(normalized.bindings.tenantIds.every((value) => value.length <= 160));
  assert.deepEqual(normalizeCorrelationClaimsPolicy(undefined), {
    enabled: false,
    authority: undefined,
    bindings: {
      tenantIds: [],
      environmentIds: [],
      workspaceIds: [],
      workspacePaths: [],
      collectorIds: [],
      physicalWorkloadIds: [],
      agentScopeIds: [],
    },
  });

  const direct = authorizeCorrelationClaims({
    source: {
      sourceId: 'direct-source',
      name: 'direct source',
      type: 'otel',
      enabled: true,
      requireToken: true,
      correlationClaims: { enabled: true, authority: 'application', bindings: normalized.bindings },
      tags: [],
      discovered: false,
      createdAt: 1,
      updatedAt: 1,
      acceptedEvents: 0,
      acceptedHeartbeats: 0,
      rejectedEvents: 0,
    },
    tokenProvided: true,
    tokenMatched: true,
    claim: { authority: 'application' },
  });
  assert.equal(direct.claimAuthorization, false);
  assert.equal(direct.claimAuthorizationReason, 'policy_invalid');

  const validWorkspaceAlternativePolicy = normalizeCorrelationClaimsPolicy({
    enabled: true,
    authority: 'application',
    bindings: {
      tenantIds: ['tenant-a'],
      environmentIds: ['production'],
      workspaceIds: ['workspace-a'],
      workspacePaths: ['/srv/agent-a'],
    },
  });
  const workspaceIdOnly = authorizeCorrelationClaims({
    source: {
      sourceId: 'application-source',
      name: 'application source',
      type: 'otel',
      enabled: true,
      requireToken: true,
      correlationClaims: validWorkspaceAlternativePolicy,
      tags: [],
      discovered: false,
      createdAt: 1,
      updatedAt: 1,
      acceptedEvents: 0,
      acceptedHeartbeats: 0,
      rejectedEvents: 0,
    },
    tokenProvided: true,
    tokenMatched: true,
    claim: {
      authority: 'application',
      tenantId: 'tenant-a',
      environmentId: 'production',
      workspaceId: 'workspace-a',
    },
  });
  assert.equal(workspaceIdOnly.claimAuthorization, true, 'workspace id and path are alternative binding proofs');
}

console.log('ingestion source correlation-claim authorization contract passed');
