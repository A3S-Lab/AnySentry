import { createHash } from 'node:crypto';

import type * as T from './types';

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

function canonicalWorkspace(value?: string): string {
  const workspace = value?.trim().replace(/\/+$/u, '') ?? '';
  return workspace || 'workspace:unknown';
}

function logicalAgentId(
  product: string,
  environment: T.AgentConversationSummary['environment'],
  workspacePath: string,
): string {
  const hash = createHash('sha256')
    .update('anysentry.logical_agent.v1\0')
    .update(product.toLowerCase())
    .update('\0')
    .update(environment)
    .update('\0')
    .update(workspacePath)
    .digest('hex')
    .slice(0, 24);
  return 'la_' + hash;
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

function runtimeWorkspace(instance: T.AgentRuntimeInstanceRecord): string {
  return canonicalWorkspace(
    instance.workspacePath
      ?? (instance.agentScopeId ? 'agent-scope:' + instance.agentScopeId : undefined),
  );
}

function runtimeActivityUnixNs(instance: T.AgentRuntimeInstanceRecord): string {
  return (BigInt(instance.lastActivityAt ?? instance.lastSeenAt) * 1_000_000n).toString();
}

export function projectAgentConversationDirectory(
  conversations: T.AgentConversationSummary[],
  runtimeInstances: T.AgentRuntimeInstanceRecord[],
  lifecycleScope: T.AgentConversationDirectoryQuery['lifecycleScope'] = 'all',
): T.LogicalAgentConversationDirectoryItem[] {
  const groups = new Map<string, T.AgentConversationSummary[]>();
  for (const conversation of conversations) {
    const product = canonicalProduct(conversation.agentProduct);
    const workspacePath = canonicalWorkspace(conversation.workspacePath);
    const id = logicalAgentId(product, conversation.environment, workspacePath);
    const items = groups.get(id) ?? [];
    items.push(conversation);
    groups.set(id, items);
  }

  const consumedRuntime = new Set<string>();
  const directory = [...groups.entries()].map(([id, grouped]) => {
    const conversations = [...grouped].sort((left, right) =>
      compareUnixNs(left.lastActivityAtUnixNs, right.lastActivityAtUnixNs)
      || left.conversationId.localeCompare(right.conversationId));
    const first = conversations[0];
    const product = canonicalProduct(first.agentProduct);
    const workspacePath = canonicalWorkspace(first.workspacePath);
    const agentInstanceIds = [...new Set(conversations.flatMap((item) => item.agentInstanceIds))];
    const agentAssetIds = [...new Set(conversations.map((item) => item.agentAssetId))];
    const instanceSet = new Set(agentInstanceIds);
    let matchingRuntime = runtimeInstances.filter((instance) =>
      instanceSet.has(instance.agentInstanceId));
    if (matchingRuntime.length === 0) {
      matchingRuntime = runtimeInstances.filter((instance) =>
        runtimeWorkspace(instance) === workspacePath
        && canonicalProduct(instance.agentDisplayName) === product);
    }
    for (const instance of matchingRuntime) {
      instanceSet.add(instance.agentInstanceId);
      consumedRuntime.add(instance.agentInstanceId);
    }
    const running = matchingRuntime.filter((instance) => instance.runtimeState === 'running');
    const unobserved = matchingRuntime.filter((instance) => instance.runtimeState === 'unobserved');
    const lifecycleState: T.LogicalAgentConversationDirectoryItem['lifecycleState'] = running.length
      ? 'running'
      : unobserved.length ? 'unobserved' : 'historical';
    return {
      logicalAgentId: id,
      groupingQuality: workspacePath === 'workspace:unknown' ? 'inferred' : 'strong',
      product,
      displayName: first.displayName || product + ' · ' + workspacePath,
      environment: first.environment,
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
      coverage: coverageRollup(conversations),
    } satisfies T.LogicalAgentConversationDirectoryItem;
  });

  const runtimeGroups = new Map<string, T.AgentRuntimeInstanceRecord[]>();
  for (const instance of runtimeInstances) {
    if (consumedRuntime.has(instance.agentInstanceId)) continue;
    const product = canonicalProduct(instance.agentDisplayName);
    const environment = runtimeEnvironment(instance);
    const workspacePath = runtimeWorkspace(instance);
    const id = logicalAgentId(product, environment, workspacePath);
    const items = runtimeGroups.get(id) ?? [];
    items.push(instance);
    runtimeGroups.set(id, items);
  }
  for (const [id, instances] of runtimeGroups) {
    const first = instances[0];
    const product = canonicalProduct(first.agentDisplayName);
    const environment = runtimeEnvironment(first);
    const workspacePath = runtimeWorkspace(first);
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
      groupingQuality: workspacePath === 'workspace:unknown' ? 'inferred' : 'strong',
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
      agentInstanceIds: instances.map((instance) => instance.agentInstanceId),
      conversations: [],
      coverage: {
        status: 'asset_only',
        reasons: ['runtime_instance_without_conversation'],
        completeInteractions: 0,
        partialInteractions: 0,
        lastEvidenceAt: new Date(
          Math.max(...instances.map((instance) => instance.lastSeenAt)),
        ).toISOString(),
      },
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
