import { createHash } from 'node:crypto';

import type * as T from './types';
import {
  emptyAgentUsageSummary,
  rollupAgentUsageSummaries,
} from './agent-conversation';
import { resolveLogicalAgentDefinition } from './canonical-observability';

function normalized(value?: string): string {
  return (value ?? '').trim().toLowerCase().replace(/\s+/gu, ' ');
}

function canonicalProduct(value?: string): string {
  const product = normalized(value);
  if (/(?:^|[^a-z])codex(?:[^a-z]|$)/u.test(product)) return 'Codex';
  if (product.includes('claude')) return 'Claude Code';
  if (product.includes('kimi')) return 'Kimi Code';
  if (product.includes('langchain')) return 'LangChain';
  if (product.includes('dify')) return 'Dify';
  if (/(?:^|[^a-z])pi(?:[^a-z]|$)/u.test(product)) return 'Pi';
  return value?.trim() || 'Unknown Agent';
}

function isSyntheticWorkspace(value?: string): boolean {
  const workspace = value?.trim() ?? '';
  return !workspace
    || workspace === 'workspace:unknown'
    || workspace.startsWith('agent://')
    || workspace.startsWith('agent-scope:');
}

function canonicalWorkspace(value: string | undefined, product: string): string {
  const workspace = value?.trim().replace(/\/+$/u, '') ?? '';
  if (!isSyntheticWorkspace(workspace)) return workspace;
  const productScope = normalized(product)
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '') || 'unknown-agent';
  return 'agent-scope:' + productScope;
}

function canonicalEnvironment(
  environment: T.AgentConversationSummary['environment'],
  workspacePath: string,
  agentInstanceIds: string[] = [],
): T.AgentConversationSummary['environment'] {
  const instanceIdentities = agentInstanceIds.map(normalized);
  if (instanceIdentities.some((value) => /^(?:docker|container):/u.test(value))) {
    return 'docker';
  }
  if (instanceIdentities.some((value) => /^(?:kubernetes|k8s|pod):/u.test(value))) {
    return 'kubernetes';
  }
  if (environment !== 'unknown') return environment;
  if (instanceIdentities.some((value) => value.startsWith('host-root:'))) return 'host';
  if (/^agent:\/\/[a-f0-9]{12,64}$/iu.test(workspacePath)) return 'docker';
  if (workspacePath.startsWith('/')) return 'host';
  return 'unknown';
}

function fallbackLogicalAgentId(
  product: string,
  workspacePath: string,
  agentAssetId?: string,
): { id: string; quality: T.LogicalAgentConversationDirectoryItem['groupingQuality']; candidateId?: string; definitionFingerprint?: string; mode: NonNullable<T.LogicalAgentConversationDirectoryItem['logicalScopeMode']> } {
  const definition = resolveLogicalAgentDefinition({
    family: product,
    workspacePath,
  });
  if (definition.stable && definition.definition.logicalAgentId) {
    return {
      id: definition.definition.logicalAgentId,
      quality: 'strong',
      definitionFingerprint: definition.definition.definitionFingerprint,
      mode: definition.definition.logicalScopeMode,
    };
  }
  // Candidate IDs are intentionally not presented as confirmed LogicalAgent identities. Include
  // the observed asset as a bounded discriminator so two unresolved products in one workspace do
  // not silently merge while still allowing later review/registration to reconcile them.
  const baseCandidate = definition.candidateId
    ?? `lac_${createHash('sha256').update(`${product}\0${workspacePath}`).digest('hex').slice(0, 24)}`;
  // A real workspace without a registered definition is not enough evidence that two observed
  // assets are the same LogicalAgent.  Keep synthetic compatibility fixtures grouped, but add a
  // bounded asset discriminator for live unresolved observations so unrelated processes cannot be
  // silently merged under one candidate.  Registration can later reconcile these candidates.
  const candidate = !isSyntheticWorkspace(workspacePath) && agentAssetId
    ? `lac_${createHash('sha256').update(`${baseCandidate}\0asset\0${agentAssetId}`).digest('hex').slice(0, 24)}`
    : baseCandidate;
  return {
    id: `candidate:${candidate}`,
    candidateId: candidate,
    quality: 'unresolved',
    definitionFingerprint: definition.definition.definitionFingerprint,
    mode: 'unresolved',
  };
}

function coverageRollup(
  conversations: T.AgentConversationSummary[],
): T.AgentConversationCoverage {
  const all = conversations.map((item) => item.coverage);
  const completeInteractions = all.reduce((sum, item) => sum + item.completeInteractions, 0);
  const partialInteractions = all.reduce((sum, item) => sum + item.partialInteractions, 0);
  const reasons = [...new Set(all.flatMap((item) => item.reasons))];
  const lastEvidenceAt = all
    .map((item) => item.lastEvidenceAt)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);
  let status: T.AgentConversationCoverageStatus = 'asset_only';
  if (all.length > 0 && all.every((item) => item.status === 'complete')) status = 'complete';
  else if (all.some((item) => item.status === 'transport_unparsed')) status = 'transport_unparsed';
  else if (all.some((item) => item.status === 'template_unparsed')) status = 'template_unparsed';
  else if (all.some((item) => item.status === 'budget_limited')) status = 'budget_limited';
  else if (all.some((item) => item.status === 'partial')) status = 'partial';
  else if (all.some((item) => item.status === 'no_final_response')) status = 'no_final_response';
  else if (all[0]) status = all[0].status;
  return {
    status,
    reasons,
    completeInteractions,
    partialInteractions,
    ...(lastEvidenceAt ? { lastEvidenceAt } : {}),
  };
}

function compareUnixNs(left?: string, right?: string): number {
  const leftNs = left && /^\d+$/u.test(left) ? BigInt(left) : 0n;
  const rightNs = right && /^\d+$/u.test(right) ? BigInt(right) : 0n;
  return leftNs === rightNs ? 0 : leftNs > rightNs ? -1 : 1;
}

function runtimeEnvironment(
  instance: T.AgentRuntimeInstanceRecord,
): T.LogicalAgentConversationDirectoryItem['environment'] {
  if (instance.workloadRef?.environment) return instance.workloadRef.environment;
  const physical = normalized(instance.physicalWorkloadId);
  if (physical.includes('docker') || physical.includes('container')) return 'docker';
  if (physical.includes('kubernetes') || physical.includes('pod')) return 'kubernetes';
  return 'host';
}

function runtimeWorkspace(instance: T.AgentRuntimeInstanceRecord, product: string): string {
  return canonicalWorkspace(
    instance.workspacePath
      ?? (instance.agentScopeId ? 'agent-scope:' + instance.agentScopeId : undefined),
    product,
  );
}

function runtimeMatchesLogicalScope(
  instance: T.AgentRuntimeInstanceRecord,
  conversation: T.AgentConversationSummary,
): boolean {
  // Product/workspace is only a physical fallback.  Once a conversation carries a registered or
  // terminal-scoped definition, a runtime without the same management identity is not allowed to
  // attach merely because it happens to use the same directory.
  const trustedLogicalAuthority = instance.logicalIdentityAuthority === 'management_registration';
  if (conversation.logicalAgentId
    && (!trustedLogicalAuthority || instance.logicalAgentId !== conversation.logicalAgentId)) return false;
  if (conversation.logicalDefinitionId
    && instance.logicalDefinitionId !== conversation.logicalDefinitionId) return false;
  if (conversation.tenantId && instance.tenantId !== conversation.tenantId) return false;
  if (conversation.ownerId && instance.ownerId !== conversation.ownerId) return false;
  const applicationDefinition = conversation.logicalScopeMode === 'workflow_definition'
    || conversation.logicalScopeMode === 'service_definition';
  // Workflow/service profile, deployment and environment are AgentInstance dimensions. They must
  // not prevent a runtime from joining the single LogicalAgent directory group; CLI registered
  // definitions still use profile as a logical-definition hint.
  if (!applicationDefinition && conversation.profile && instance.profile !== conversation.profile) return false;
  const terminal = conversation.terminalContextIds?.[0];
  if (conversation.logicalScopeMode === 'terminal' && instance.terminalContextId !== terminal) return false;
  return true;
}

function runtimeActivityUnixNs(instance: T.AgentRuntimeInstanceRecord): string {
  return (BigInt(instance.lastActivityAt ?? instance.lastSeenAt) * 1_000_000n).toString();
}

function runtimeCanonicalId(instance: T.AgentRuntimeInstanceRecord): string {
  return instance.canonicalAgentInstanceId ?? instance.agentInstanceId;
}

function runtimeIdentityIds(instance: T.AgentRuntimeInstanceRecord): string[] {
  return [...new Set([
    runtimeCanonicalId(instance),
    instance.agentInstanceId,
    ...(instance.agentInstanceAliases ?? []),
  ])];
}

function rollupInstanceUsage(
  conversations: readonly T.AgentConversationSummary[],
): T.AgentInstanceUsageSummary[] {
  const byInstance = new Map<string, T.AgentUsageSummary[]>();
  for (const conversation of conversations) {
    for (const usage of conversation.instanceUsage ?? []) {
      const summaries = byInstance.get(usage.agentInstanceId) ?? [];
      summaries.push(usage);
      byInstance.set(usage.agentInstanceId, summaries);
    }
  }
  return [...byInstance.entries()].map(([agentInstanceId, summaries]) => ({
    agentInstanceId,
    ...rollupAgentUsageSummaries(summaries),
  }));
}

export function projectAgentConversationDirectory(
  conversations: T.AgentConversationSummary[],
  runtimeInstances: T.AgentRuntimeInstanceRecord[],
  lifecycleScope: T.AgentConversationDirectoryQuery['lifecycleScope'] = 'all',
): T.LogicalAgentConversationDirectoryItem[] {
  const groups = new Map<string, T.AgentConversationSummary[]>();
  for (const conversation of conversations) {
    const product = canonicalProduct(conversation.agentProduct);
    const rawWorkspacePath = conversation.workspacePath?.trim().replace(/\/+$/u, '') ?? '';
    const environment = canonicalEnvironment(
      conversation.environment,
      rawWorkspacePath,
      conversation.agentInstanceIds,
    );
    const workspacePath = canonicalWorkspace(rawWorkspacePath, product);
    const definition = resolveLogicalAgentDefinition({
      logicalAgentId: conversation.logicalAgentId,
      family: conversation.agentProduct ?? product,
      tenantId: conversation.tenantId,
      ownerId: conversation.ownerId,
      workspacePath,
      definitionId: conversation.logicalDefinitionId,
      profile: conversation.profile,
      profileVersion: conversation.profileVersion,
      logicalScopeMode: conversation.logicalScopeMode,
      terminalContextId: conversation.terminalContextIds?.[0],
      authority: conversation.logicalIdentityAuthority === 'management_registration'
        || conversation.logicalIdentityAuthority === 'authenticated_adapter'
        ? conversation.logicalIdentityAuthority : 'inferred',
    });
    const fallback = definition.stable && definition.definition.logicalAgentId
      ? { id: definition.definition.logicalAgentId, quality: 'strong' as const, mode: definition.definition.logicalScopeMode, definitionFingerprint: definition.definition.definitionFingerprint }
      : fallbackLogicalAgentId(product, workspacePath, conversation.agentAssetId);
    const trustedLogical = conversation.logicalIdentityAuthority === 'management_registration'
      || conversation.logicalIdentityAuthority === 'authenticated_adapter';
    const id = trustedLogical && conversation.logicalAgentId ? conversation.logicalAgentId : fallback.id;
    // Explicit registration IDs are scoped by tenant/owner. Keep the public ID unchanged for
    // deep-link compatibility, but include a stable definition fence in the grouping key so two
    // tenants reusing a short registration ID cannot be merged. Workflow/service definitions are
    // logical objects across test/prod revisions; their profile/deployment fields belong to the
    // AgentInstance fan-out and are intentionally excluded from this directory key.
    const applicationDefinition = conversation.logicalScopeMode === 'workflow_definition'
      || conversation.logicalScopeMode === 'service_definition';
    const directoryDefinitionKey = applicationDefinition
      ? [
          conversation.tenantId ?? '',
          conversation.ownerId ?? '',
          conversation.logicalScopeMode ?? '',
          conversation.logicalAgentId ?? '',
          conversation.logicalDefinitionId ?? '',
          rawWorkspacePath,
          conversation.logicalScopeMode === 'terminal'
            ? conversation.terminalContextIds?.[0] ?? '' : '',
        ].join('\0')
      : definition.definition.definitionFingerprint;
    const groupKey = trustedLogical && conversation.logicalAgentId
      // Deployment/environment/revision are AgentInstance fences, not LogicalAgent boundaries.
      // Keep them in each conversation/runtime summary while grouping all instances of one
      // registered definition under a single directory item.
      ? `registered\0${directoryDefinitionKey}`
      : id;
    const items = groups.get(groupKey) ?? [];
    items.push(conversation);
    groups.set(groupKey, items);
  }

  const consumedRuntime = new Set<string>();
  const directory = [...groups.entries()].map(([groupKey, grouped]) => {
    const conversations = [...grouped].sort((left, right) =>
      compareUnixNs(left.lastActivityAtUnixNs, right.lastActivityAtUnixNs)
      || left.conversationId.localeCompare(right.conversationId));
    const first = conversations[0];
    const product = canonicalProduct(first.agentProduct);
    const rawWorkspacePath = first.workspacePath?.trim().replace(/\/+$/u, '') ?? '';
    const environment = canonicalEnvironment(
      first.environment,
      rawWorkspacePath,
      first.agentInstanceIds,
    );
    const workspacePath = canonicalWorkspace(rawWorkspacePath, product);
    const agentInstanceIds = [...new Set(conversations.flatMap((item) => item.agentInstanceIds))];
    const agentAssetIds = [...new Set(conversations.map((item) => item.agentAssetId))];
    const instanceSet = new Set(agentInstanceIds);
    const matchingRuntime = runtimeInstances.filter((instance) => {
      if (runtimeIdentityIds(instance).some((identity) => instanceSet.has(identity))) return true;
      if (!runtimeMatchesLogicalScope(instance, first)) return false;
      const runtimeProduct = canonicalProduct(instance.agentDisplayName);
      return runtimeProduct === product
        && runtimeEnvironment(instance) === environment
        && runtimeWorkspace(instance, runtimeProduct) === workspacePath;
    });
    for (const instance of matchingRuntime) {
      instanceSet.add(runtimeCanonicalId(instance));
      consumedRuntime.add(runtimeCanonicalId(instance));
    }
    const running = matchingRuntime.filter((instance) => instance.runtimeState === 'running');
    const unobserved = matchingRuntime.filter((instance) => instance.runtimeState === 'unobserved');
    const lifecycleState: T.LogicalAgentConversationDirectoryItem['lifecycleState'] = running.length
      ? 'running'
      : unobserved.length ? 'unobserved' : 'historical';
    const canonicalDefinition = resolveLogicalAgentDefinition({
      logicalAgentId: first.logicalAgentId,
      family: first.agentProduct ?? product,
      tenantId: first.tenantId,
      ownerId: first.ownerId,
      workspacePath,
      definitionId: first.logicalDefinitionId,
      profile: first.profile,
      profileVersion: first.profileVersion,
      logicalScopeMode: first.logicalScopeMode,
      terminalContextId: first.terminalContextIds?.[0],
      authority: first.logicalIdentityAuthority === 'management_registration'
        || first.logicalIdentityAuthority === 'authenticated_adapter'
        ? first.logicalIdentityAuthority : 'inferred',
    });
    const trustedFirstLogical = first.logicalIdentityAuthority === 'management_registration'
      || first.logicalIdentityAuthority === 'authenticated_adapter';
    const idInfo = trustedFirstLogical && first.logicalAgentId
      ? { id: first.logicalAgentId, quality: 'strong' as const, mode: canonicalDefinition.definition.logicalScopeMode, definitionFingerprint: canonicalDefinition.definition.definitionFingerprint }
      : fallbackLogicalAgentId(product, workspacePath, first.agentAssetId);
    const id = trustedFirstLogical && first.logicalAgentId ? first.logicalAgentId : idInfo.id;
    return {
      logicalAgentId: id,
      // Keep the legacy synthetic-workspace label readable during migration while exposing the
      // stronger `logicalScopeMode=unresolved`/candidateId fields to canonical consumers.
      groupingQuality: idInfo.quality === 'unresolved' && isSyntheticWorkspace(workspacePath)
        ? 'inferred'
        : idInfo.quality,
      ...(canonicalDefinition.definition.definitionId ? { logicalDefinitionId: canonicalDefinition.definition.definitionId } : {}),
      logicalScopeMode: idInfo.mode,
      ...(idInfo.definitionFingerprint ? { definitionFingerprint: idInfo.definitionFingerprint } : {}),
      ...(idInfo.candidateId ? { candidateId: idInfo.candidateId } : {}),
      product,
      displayName: first.displayName || product + ' · ' + workspacePath,
      environment,
      workspacePath,
      lifecycleState,
      activeInstanceCount: running.length + unobserved.length,
      totalInstanceCount: Math.max(instanceSet.size, 1),
      conversationCount: conversations.filter((item) => item.hasContent).length,
      lastActivityAtUnixNs: conversations
        .map((item) => item.lastActivityAtUnixNs)
        .filter((value): value is string => Boolean(value))
        .sort((left, right) => compareUnixNs(left, right))[0],
      agentAssetIds,
      agentInstanceIds: [...instanceSet],
      conversations,
      usage: rollupAgentUsageSummaries(conversations.map((item) =>
        item.usage ?? emptyAgentUsageSummary())),
      instanceUsage: rollupInstanceUsage(conversations),
      coverage: coverageRollup(conversations),
      terminalContextIds: [...new Set(conversations.flatMap((item) => item.terminalContextIds ?? []))].slice(0, 256),
    } satisfies T.LogicalAgentConversationDirectoryItem;
  });

  const runtimeGroups = new Map<string, T.AgentRuntimeInstanceRecord[]>();
  for (const instance of runtimeInstances) {
    if (consumedRuntime.has(runtimeCanonicalId(instance))) continue;
    const product = canonicalProduct(instance.agentDisplayName);
    const environment = runtimeEnvironment(instance);
    const workspacePath = runtimeWorkspace(instance, product);
    const definition = resolveLogicalAgentDefinition({
      logicalAgentId: instance.logicalAgentId,
      family: instance.agentDisplayName ?? product,
      tenantId: instance.tenantId,
      ownerId: instance.ownerId,
      workspacePath,
      definitionId: instance.logicalDefinitionId,
      profile: instance.profile,
      profileVersion: instance.profileVersion,
      logicalScopeMode: instance.logicalScopeMode,
      terminalContextId: instance.terminalContextId,
      authority: instance.logicalIdentityAuthority === 'management_registration'
        ? 'management_registration' : 'inferred',
    });
    const trustedRuntimeLogical = instance.logicalIdentityAuthority === 'management_registration';
    const idInfo = trustedRuntimeLogical && definition.stable && definition.definition.logicalAgentId
      ? { id: definition.definition.logicalAgentId, quality: 'strong' as const, mode: definition.definition.logicalScopeMode, definitionFingerprint: definition.definition.definitionFingerprint }
      : fallbackLogicalAgentId(product, workspacePath, instance.agentInstanceId);
    const id = trustedRuntimeLogical && instance.logicalAgentId ? instance.logicalAgentId : idInfo.id;
    const applicationDefinition = instance.logicalScopeMode === 'workflow_definition'
      || instance.logicalScopeMode === 'service_definition';
    const runtimeDefinitionKey = applicationDefinition
      ? [
          instance.tenantId ?? '',
          instance.ownerId ?? '',
          instance.logicalScopeMode ?? '',
          instance.logicalAgentId ?? '',
          instance.logicalDefinitionId ?? '',
          workspacePath,
          instance.logicalScopeMode === 'terminal' ? instance.terminalContextId ?? '' : '',
        ].join('\0')
      : definition.definition.definitionFingerprint;
    const groupKey = trustedRuntimeLogical && instance.logicalAgentId
      ? `registered\0${runtimeDefinitionKey}\0${instance.tenantId ?? ''}\0${instance.ownerId ?? ''}\0${instance.logicalScopeMode ?? ''}\0${instance.logicalAgentId}\0${instance.terminalContextId ?? ''}${applicationDefinition ? '' : `\0${instance.profile ?? ''}\0${instance.profileVersion ?? ''}\0${instance.deploymentId ?? ''}\0${instance.deploymentRevision ?? ''}`}`
      : id;
    const items = runtimeGroups.get(groupKey) ?? [];
    items.push(instance);
    runtimeGroups.set(groupKey, items);
  }
  for (const [groupKey, instances] of runtimeGroups) {
    const first = instances[0];
    const product = canonicalProduct(first.agentDisplayName);
    const environment = runtimeEnvironment(first);
    const workspacePath = runtimeWorkspace(first, product);
    const definition = resolveLogicalAgentDefinition({
      logicalAgentId: first.logicalAgentId,
      family: first.agentDisplayName ?? product,
      tenantId: first.tenantId,
      ownerId: first.ownerId,
      workspacePath,
      definitionId: first.logicalDefinitionId,
      profile: first.profile,
      profileVersion: first.profileVersion,
      logicalScopeMode: first.logicalScopeMode,
      terminalContextId: first.terminalContextId,
      authority: first.logicalIdentityAuthority === 'management_registration'
        ? 'management_registration' : 'inferred',
    });
    const trustedFirstRuntimeLogical = first.logicalIdentityAuthority === 'management_registration';
    const idInfo = trustedFirstRuntimeLogical && first.logicalAgentId
      ? { id: first.logicalAgentId, quality: 'strong' as const, mode: definition.definition.logicalScopeMode, definitionFingerprint: definition.definition.definitionFingerprint }
      : fallbackLogicalAgentId(product, workspacePath, first.agentInstanceId);
    const id = trustedFirstRuntimeLogical && first.logicalAgentId ? first.logicalAgentId : idInfo.id;
    const running = instances.filter((instance) => instance.runtimeState === 'running');
    const unobserved = instances.filter((instance) => instance.runtimeState === 'unobserved');
    const lifecycleState: T.LogicalAgentConversationDirectoryItem['lifecycleState'] = running.length
      ? 'running'
      : unobserved.length ? 'unobserved' : 'historical';
    const lastActivityAtUnixNs = instances
      .map(runtimeActivityUnixNs)
      .sort((left, right) => compareUnixNs(left, right))[0];
    directory.push({
      logicalAgentId: id,
      groupingQuality: idInfo.quality === 'unresolved' && isSyntheticWorkspace(workspacePath)
        ? 'inferred'
        : idInfo.quality,
      logicalScopeMode: idInfo.mode,
      ...(first.logicalDefinitionId ? { logicalDefinitionId: first.logicalDefinitionId } : {}),
      ...(idInfo.definitionFingerprint ? { definitionFingerprint: idInfo.definitionFingerprint } : {}),
      ...(idInfo.candidateId ? { candidateId: idInfo.candidateId } : {}),
      product,
      displayName: first.agentDisplayName || product + ' · ' + workspacePath,
      environment,
      workspacePath,
      lifecycleState,
      activeInstanceCount: running.length + unobserved.length,
      totalInstanceCount: instances.length,
      conversationCount: 0,
      lastActivityAtUnixNs,
      agentAssetIds: [],
      agentInstanceIds: [...new Set(instances.map(runtimeCanonicalId))],
      conversations: [],
      usage: emptyAgentUsageSummary(),
      instanceUsage: [],
      coverage: {
        status: 'asset_only',
        reasons: ['runtime_instance_without_conversation'],
        completeInteractions: 0,
        partialInteractions: 0,
        lastEvidenceAt: new Date(
          Math.max(...instances.map((instance) => instance.lastSeenAt)),
        ).toISOString(),
      },
      terminalContextIds: [...new Set(instances
        .map((item) => item.terminalContextId)
        .filter((value): value is string => Boolean(value)))],
    });
  }

  return directory
    .filter((item) =>
      lifecycleScope === 'all'
      || (lifecycleScope === 'running'
        ? item.lifecycleState !== 'historical'
        : item.lifecycleState === 'historical'))
    .sort((left, right) => {
      const rank = (state: T.LogicalAgentConversationDirectoryItem['lifecycleState']) =>
        state === 'running' ? 0 : state === 'unobserved' ? 1 : 2;
      return rank(left.lifecycleState) - rank(right.lifecycleState)
        || left.product.localeCompare(right.product)
        || compareUnixNs(left.lastActivityAtUnixNs, right.lastActivityAtUnixNs)
        || left.logicalAgentId.localeCompare(right.logicalAgentId);
    });
}

export function enrichAgentConversationDirectoryV2(
  directory: T.LogicalAgentConversationDirectoryItem[],
  runtimeInstances: T.AgentRuntimeInstanceRecord[],
  now = Date.now(),
): T.LogicalAgentConversationDirectoryItemV2[] {
  return directory.map((agent) => {
    const identities = new Set(agent.agentInstanceIds);
    const instances = runtimeInstances
      .filter((instance) => runtimeIdentityIds(instance).some((identity) => identities.has(identity)))
      .sort((left, right) => right.lastSeenAt - left.lastSeenAt);
    const contentConversations = agent.conversations.filter((conversation) => conversation.hasContent);
    const activeConversations = contentConversations.filter((conversation) => {
      if (!conversation.lastActivityAtUnixNs) return false;
      try {
        return now - Number(BigInt(conversation.lastActivityAtUnixNs) / 1_000_000n) <= 5 * 60_000;
      } catch {
        return false;
      }
    }).length;
    return {
      ...agent,
      instanceCounts: {
        active: instances.filter((instance) =>
          instance.runtimeState === 'running' && instance.activityState === 'active').length,
        idle: instances.filter((instance) =>
          instance.runtimeState === 'running' && instance.activityState === 'idle').length,
        unobserved: instances.filter((instance) => instance.runtimeState === 'unobserved').length,
        exited: instances.filter((instance) => instance.runtimeState === 'exited').length,
        lost: instances.filter((instance) => instance.runtimeState === 'lost').length,
        total: instances.length,
      },
      conversationCounts: {
        active: activeConversations,
        dormant: Math.max(0, contentConversations.length - activeConversations),
        incomplete: contentConversations.filter((conversation) =>
          conversation.coverage.status !== 'complete').length,
        total: contentConversations.length,
      },
      recentInstances: instances.slice(0, 100),
    };
  });
}
