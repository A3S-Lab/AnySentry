import { createHash } from 'node:crypto';

import type * as T from './types';

export const AGENT_CONVERSATION_RESOLVER_V2 = 2;

export type ConversationMembershipRole =
  | 'conversation'
  | 'bootstrap'
  | 'control'
  | 'context_replay'
  | 'background'
  | 'unclassified';

export interface ConversationRouteAliasV1 {
  schemaVersion: 'anysentry.agent_conversation_route_alias.v1';
  aliasConversationId: string;
  targetType: 'conversation' | 'technical_activity';
  targetId: string;
  canonicalConversationId?: string;
  technicalActivityId?: string;
  reason:
    | 'provider_chain_merge'
    | 'continuity_anchor_merge'
    | 'replay_lineage_merge'
    | 'control_activity_fold';
  evidence: string[];
  resolverVersion: typeof AGENT_CONVERSATION_RESOLVER_V2;
  resolutionRevision: number;
  createdAt: number;
}

export interface TechnicalActivityProjection {
  technicalActivityId: string;
  agentAssetId: string;
  agentInstanceId?: string;
  role: Exclude<ConversationMembershipRole, 'conversation' | 'context_replay'>;
  interactionIds: string[];
  startedAtUnixNs: string;
  endedAtUnixNs: string;
  methods: string[];
  paths: string[];
  status: 'complete' | 'partial' | 'failed';
}

export interface ConversationMembershipV2 {
  schemaVersion: 'anysentry.agent_conversation_membership.v2';
  membershipId: string;
  interactionId: string;
  canonicalConversationId?: string;
  technicalActivityId?: string;
  segmentId?: string;
  role: ConversationMembershipRole;
  logicalScopeKey: string;
  resolutionRevision: number;
  resolverVersion: typeof AGENT_CONVERSATION_RESOLVER_V2;
  confidence: 'exact' | 'strong' | 'inferred' | 'unlinked';
  evidence: string[];
  decidedAt: number;
}

export interface ConversationResolutionV2 {
  records: T.AgentInteractionRecord[];
  conversationRecords: T.AgentInteractionRecord[];
  technicalRecords: T.AgentInteractionRecord[];
  aliases: ConversationRouteAliasV1[];
  technicalActivities: TechnicalActivityProjection[];
  memberships: ConversationMembershipV2[];
  resolutionRevision: number;
}

interface HumanMessageIdentity {
  sourceItemId?: string;
  turnId?: string;
  content: unknown;
}

const CONTROL_METHODS = new Set([
  'initialize',
  'notifications/initialized',
  'ping',
  'tools/list',
  'resources/list',
  'resources/templates/list',
  'prompts/list',
  'completion/complete',
  'logging/setLevel',
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function text(value: unknown, limit = 512): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= limit && !normalized.includes('\u0000')
    ? normalized
    : undefined;
}

function normalized(value?: string): string {
  return value?.trim().toLowerCase().replace(/\s+/gu, ' ') ?? '';
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const object = value as Record<string, unknown>;
  return '{' + Object.keys(object).sort().map((key) =>
    JSON.stringify(key) + ':' + canonicalJson(object[key])).join(',') + '}';
}

function stableId(prefix: string, value: string): string {
  return prefix + '_' + sha256(value).slice(0, 24);
}

function anchorHash(kind: T.AgentConversationAnchorKind, value: string): string {
  return sha256(kind + '\u0000' + value);
}

function requestObject(interaction: T.AgentInteractionRecord): Record<string, unknown> | undefined {
  const structured = record(interaction.request.structured);
  if (structured) return structured;
  if (interaction.request.encoding !== 'utf8' || !interaction.request.body.trim().startsWith('{')) {
    return undefined;
  }
  try {
    return record(JSON.parse(interaction.request.body));
  } catch {
    return undefined;
  }
}

function metadataObject(item: Record<string, unknown>): Record<string, unknown> | undefined {
  return record(item.internal_chat_message_metadata_passthrough)
    ?? record(item.metadata)
    ?? record(item._meta);
}

function contentItemKinds(item: Record<string, unknown>): string[] {
  const values = metadataObject(item)?.content_item_kinds;
  if (!Array.isArray(values)) return [];
  return [...new Set(values
    .map((value) => text(value, 160))
    .filter((value): value is string => Boolean(value)))]
    .slice(0, 32);
}

function messageOrigin(
  role: string,
  kinds: string[],
  content: unknown,
): T.AgentInteractionMessage['messageOrigin'] {
  const normalizedRole = role.toLowerCase();
  if (normalizedRole === 'user' || normalizedRole === 'human') {
    if (Array.isArray(content) && content.length > 0 && content.every((part) =>
      record(part)?.type === 'tool_result')) return 'tool_history';
    if (kinds.length === 0 || kinds.some((kind) =>
      kind === 'user.text' || kind.startsWith('user.'))) return 'human_input';
    return 'agent_context';
  }
  if (normalizedRole === 'developer' || normalizedRole === 'system') {
    return 'developer_instruction';
  }
  if (normalizedRole === 'assistant') return 'assistant_history';
  if (normalizedRole === 'tool' || normalizedRole === 'function') return 'tool_history';
  return undefined;
}

function runtimeContextPart(value: unknown): boolean {
  const item = record(value);
  const valueText = typeof value === 'string'
    ? value.trim()
    : typeof item?.text === 'string' ? item.text.trim() : undefined;
  return Boolean(valueText && ['environment_context', 'system-reminder'].some((tag) =>
    valueText.startsWith('<' + tag + '>') && valueText.endsWith('</' + tag + '>')));
}

function humanContent(value: unknown): unknown {
  if (!Array.isArray(value)) return runtimeContextPart(value) ? undefined : value;
  const visible = value.filter((part) =>
    record(part)?.type !== 'tool_result' && !runtimeContextPart(part));
  return visible.length ? visible : undefined;
}

function structuredMessages(interaction: T.AgentInteractionRecord): T.AgentInteractionMessage[] {
  const request = requestObject(interaction);
  const input = request?.messages ?? request?.input;
  if (!Array.isArray(input)) return interaction.request.messages ?? [];
  const messages: T.AgentInteractionMessage[] = [];
  for (const raw of input.slice(0, 4_096)) {
    const item = record(raw);
    if (!item) continue;
    const itemType = text(item.type, 80);
    const role = text(item.role, 80)
      ?? (itemType === 'message' ? 'user' : itemType ?? 'input');
    const content = item.content ?? item.output ?? raw;
    const kinds = contentItemKinds(item);
    const metadata = metadataObject(item);
    const sourceItemId = text(item.id);
    const turnId = text(item.turn_id) ?? text(metadata?.turn_id);
    const toolCallId = text(item.tool_call_id) ?? text(item.call_id);
    messages.push({
      role,
      content,
      ...(text(item.name, 240) ? { name: text(item.name, 240) } : {}),
      ...(toolCallId ? { toolCallId } : {}),
      ...(sourceItemId ? { sourceItemId } : {}),
      ...(turnId ? { turnId } : {}),
      ...(kinds.length ? { contentItemKinds: kinds } : {}),
      ...(messageOrigin(role, kinds, content)
        ? { messageOrigin: messageOrigin(role, kinds, content) }
        : {}),
    });
  }
  return messages.length ? messages : interaction.request.messages ?? [];
}

export function interactionHumanMessages(
  interaction: T.AgentInteractionRecord,
): HumanMessageIdentity[] {
  return structuredMessages(interaction)
    .filter((message) => {
      if (message.messageOrigin) return message.messageOrigin === 'human_input';
      return ['user', 'human'].includes(message.role.toLowerCase());
    })
    .map((message) => ({ message, content: humanContent(message.content) }))
    .filter((item): item is { message: T.AgentInteractionMessage; content: unknown } =>
      item.content !== undefined)
    .map(({ message, content }) => ({
      sourceItemId: message.sourceItemId,
      turnId: message.turnId,
      content,
    }));
}

function providerConversationValue(request: Record<string, unknown> | undefined): string | undefined {
  if (!request) return undefined;
  const conversation = request.conversation;
  const clientMetadata = record(request.client_metadata);
  return text(request.conversation_id)
    ?? text(request.thread_id)
    ?? text(request.session_id)
    ?? text(conversation)
    ?? text(record(conversation)?.id)
    ?? text(record(request.metadata)?.conversation_id)
    ?? text(record(request.metadata)?.thread_id)
    ?? text(record(request.metadata)?.session_id)
    // Responses WebSocket clients can carry the resumable product Thread in client_metadata,
    // including a generate=false prewarm followed by later generated turns. Treat the protocol
    // field generically; no Codex version, executable, or provider URL is required.
    ?? text(clientMetadata?.conversation_id)
    ?? text(clientMetadata?.thread_id)
    ?? text(clientMetadata?.session_id);
}

function continuityValue(request: Record<string, unknown> | undefined): string | undefined {
  if (!request) return undefined;
  return text(request.prompt_cache_key)
    ?? text(request.cache_key)
    ?? text(record(request.metadata)?.prompt_cache_key)
    ?? text(record(request.metadata)?.cache_key);
}

export function conversationAnchorsForInteraction(
  interaction: T.AgentInteractionRecord,
): T.AgentConversationAnchor[] {
  const anchors: T.AgentConversationAnchor[] = [];
  const seen = new Set<string>();
  const push = (
    kind: T.AgentConversationAnchorKind,
    value: string | undefined,
    strength: T.AgentConversationAnchor['strength'],
    sourcePath: string,
  ) => {
    if (!value || anchors.length >= 512) return;
    const valueHash = anchorHash(kind, value);
    const key = kind + '\u0000provider\u0000' + valueHash;
    if (seen.has(key)) return;
    seen.add(key);
    anchors.push({ kind, namespace: 'provider', valueHash, strength, sourcePath });
  };
  for (const anchor of interaction.conversationAnchors ?? []) {
    const key = anchor.kind + '\u0000' + anchor.namespace + '\u0000' + anchor.valueHash;
    if (seen.has(key) || anchors.length >= 512) continue;
    seen.add(key);
    anchors.push({ ...anchor });
  }
  const request = requestObject(interaction);
  push(
    'provider_conversation',
    interaction.providerConversationId ?? providerConversationValue(request),
    'exact',
    'conversation_id|thread_id|session_id',
  );
  push('response_id', interaction.providerResponseId, 'exact', 'response.id');
  push(
    'previous_response_id',
    interaction.providerPreviousResponseId ?? text(request?.previous_response_id),
    'exact',
    'previous_response_id',
  );
  push('continuity_key', continuityValue(request), 'strong', 'prompt_cache_key|cache_key');
  push(
    'turn_id',
    text(record(request?.client_metadata)?.turn_id),
    'exact',
    'client_metadata.turn_id',
  );
  for (const message of structuredMessages(interaction)) {
    push('message_item_id', message.sourceItemId, 'strong', 'input[].id|messages[].id');
    push('turn_id', message.turnId, 'strong', 'message.metadata.turn_id');
    push('tool_call_id', message.toolCallId, 'exact', 'request.tool_result.call_id');
  }
  for (const call of interaction.toolCalls) {
    push('tool_call_id', call.toolCallId, 'exact', 'response.tool_call.id');
  }
  for (const result of interaction.toolResults) {
    push('tool_call_id', result.toolCallId, 'exact', 'request.tool_result.call_id');
  }
  return anchors;
}

function jsonRpcMethod(interaction: T.AgentInteractionRecord): string | undefined {
  return text(requestObject(interaction)?.method, 160);
}

export function trafficRoleForInteraction(
  interaction: T.AgentInteractionRecord,
): ConversationMembershipRole {
  const request = requestObject(interaction);
  if (interaction.interactionType === 'model' && request?.generate === false) {
    return 'bootstrap';
  }
  if (interaction.trafficRole && interaction.trafficRole !== 'unclassified') {
    return interaction.trafficRole;
  }
  if (interaction.interactionType === 'tool') {
    const method = jsonRpcMethod(interaction);
    return method && CONTROL_METHODS.has(method) ? 'control' : 'conversation';
  }
  if (interaction.interactionType === 'model') {
    if (interactionHumanMessages(interaction).length > 0 || interaction.toolResults.length > 0) {
      return 'conversation';
    }
    if (structuredMessages(interaction).some((message) => message.messageOrigin)) {
      return 'bootstrap';
    }
    return 'conversation';
  }
  return 'unclassified';
}

export function conversationLogicalScopeKeyV2(record: T.AgentInteractionRecord): string {
  return stableId('ls', [
    normalized(record.tenantId),
    normalized(record.environmentId),
    normalized(record.agentProduct),
    normalized(record.workspacePath),
    normalized(record.process?.hostId),
  ].join('\u0000'));
}

function anchorScopeKey(record: T.AgentInteractionRecord): string {
  return stableId('as', [
    normalized(record.tenantId),
    normalized(record.environmentId),
    normalized(record.agentProduct),
    normalized(record.process?.hostId),
  ].join('\u0000'));
}

function explicitWorkspace(record: T.AgentInteractionRecord): string | undefined {
  const workspace = normalized(record.workspacePath).replace(/\/+$/u, '');
  if (
    !workspace
    || workspace === 'workspace:unknown'
    || workspace.startsWith('agent://')
    || workspace.startsWith('agent-scope:')
  ) return undefined;
  return workspace;
}

class DisjointSet {
  private readonly parents: number[];

  constructor(size: number) {
    this.parents = Array.from({ length: size }, (_, index) => index);
  }

  find(index: number): number {
    const parent = this.parents[index];
    if (parent !== index) this.parents[index] = this.find(parent);
    return this.parents[index];
  }

  union(left: number, right: number): void {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot !== rightRoot) this.parents[rightRoot] = leftRoot;
  }
}

function explicitProviderIds(
  indexes: number[],
  records: T.AgentInteractionRecord[],
): Set<string> {
  return new Set(indexes
    .map((index) => records[index].providerConversationId)
    .filter((value): value is string => Boolean(value)));
}

function properSubset(left: Set<string>, right: Set<string>): boolean {
  return left.size > 0 && left.size < right.size && [...left].every((value) => right.has(value));
}

function properPrefix(left: string[], right: string[]): boolean {
  return left.length > 0
    && left.length < right.length
    && left.every((value, index) => value === right[index]);
}

function humanContentHashes(record: T.AgentInteractionRecord): string[] {
  return interactionHumanMessages(record).map((message) => sha256(canonicalJson(message.content)));
}

function anchorValues(
  record: T.AgentInteractionRecord,
  kind: T.AgentConversationAnchorKind,
): Set<string> {
  return new Set((record.conversationAnchors ?? [])
    .filter((anchor) => anchor.kind === kind)
    .map((anchor) => anchor.valueHash));
}

function canMerge(
  left: number[],
  right: number[],
  records: T.AgentInteractionRecord[],
): boolean {
  const leftProvider = explicitProviderIds(left, records);
  const rightProvider = explicitProviderIds(right, records);
  const providerCompatible = leftProvider.size === 0
    || rightProvider.size === 0
    || [...leftProvider].some((value) => rightProvider.has(value));
  if (!providerCompatible) return false;
  // A synthetic/unknown workspace is missing evidence, not a contradictory identity. Strong
  // provider, response-chain, continuity, tool or replay anchors may bridge it to one explicit
  // workspace. Two different explicit workspaces remain a hard conflict so an anchor collision
  // cannot merge unrelated projects.
  const explicitWorkspaces = new Set([...left, ...right]
    .map((index) => explicitWorkspace(records[index]))
    .filter((value): value is string => Boolean(value)));
  return explicitWorkspaces.size <= 1;
}

function groupIndexes(set: DisjointSet, indexes: number[]): Map<number, number[]> {
  const groups = new Map<number, number[]>();
  for (const index of indexes) {
    const root = set.find(index);
    const members = groups.get(root) ?? [];
    members.push(index);
    groups.set(root, members);
  }
  return groups;
}

function unionGroupsIfAllowed(
  set: DisjointSet,
  leftIndex: number,
  rightIndex: number,
  indexes: number[],
  records: T.AgentInteractionRecord[],
): boolean {
  const groups = groupIndexes(set, indexes);
  const left = groups.get(set.find(leftIndex)) ?? [leftIndex];
  const right = groups.get(set.find(rightIndex)) ?? [rightIndex];
  if (!canMerge(left, right, records)) return false;
  set.union(leftIndex, rightIndex);
  return true;
}

function rememberIndex(map: Map<string, number[]>, key: string, index: number): void {
  const indexes = map.get(key) ?? [];
  indexes.push(index);
  map.set(key, indexes);
}

function unionCompatiblePrior(
  set: DisjointSet,
  map: Map<string, number[]>,
  key: string,
  index: number,
  visibleIndexes: number[],
  records: T.AgentInteractionRecord[],
): boolean {
  const candidates = map.get(key) ?? [];
  for (let offset = candidates.length - 1; offset >= 0; offset -= 1) {
    if (unionGroupsIfAllowed(set, candidates[offset], index, visibleIndexes, records)) return true;
  }
  return false;
}

function canonicalConversationId(
  indexes: number[],
  records: T.AgentInteractionRecord[],
): { conversationId: string; idSource: T.AgentConversationSummary['idSource'] } {
  const existing = new Map<string, { at: number; human: boolean; source: T.AgentConversationSummary['idSource'] }>();
  const sourceRank: Record<T.AgentConversationSummary['idSource'], number> = {
    provider: 3,
    runtime: 2,
    inferred: 1,
  };
  for (const index of indexes) {
    const item = records[index];
    if (!item.conversationId) continue;
    const previous = existing.get(item.conversationId);
    const observedSource: T.AgentConversationSummary['idSource'] = item.providerConversationId
      || item.conversationAnchors?.some((anchor) => anchor.kind === 'provider_conversation')
      ? 'provider'
      : item.conversationAnchors?.some((anchor) => anchor.kind === 'continuity_key')
        ? 'runtime'
        : item.conversationIdSource ?? 'inferred';
    existing.set(item.conversationId, {
      at: Math.min(previous?.at ?? Number.MAX_SAFE_INTEGER, item.at),
      human: Boolean(previous?.human || interactionHumanMessages(item).length > 0),
      source: previous && sourceRank[previous.source] > sourceRank[observedSource]
        ? previous.source
        : observedSource,
    });
  }
  const preferred = [...existing.entries()]
    .sort((left, right) =>
      Number(right[1].human) - Number(left[1].human)
      || left[1].at - right[1].at
      || left[0].localeCompare(right[0]))[0];
  if (preferred) return { conversationId: preferred[0], idSource: preferred[1].source };

  const first = records[indexes[0]];
  const scope = conversationLogicalScopeKeyV2(first);
  const provider = indexes
    .map((index) => records[index].conversationAnchors?.find((anchor) =>
      anchor.kind === 'provider_conversation'))
    .find(Boolean);
  if (provider) {
    return {
      conversationId: stableId('cv', 'v2\u0000' + scope + '\u0000provider\u0000' + provider.valueHash),
      idSource: 'provider',
    };
  }
  const continuity = indexes
    .map((index) => records[index].conversationAnchors?.find((anchor) =>
      anchor.kind === 'continuity_key'))
    .find(Boolean);
  if (continuity) {
    return {
      conversationId: stableId('cv', 'v2\u0000' + scope + '\u0000continuity\u0000' + continuity.valueHash),
      idSource: 'runtime',
    };
  }
  const human = indexes
    .flatMap((index) => interactionHumanMessages(records[index]))
    .find((message) => message.turnId || message.sourceItemId);
  return {
    conversationId: stableId(
      'cv',
      'v2\u0000' + scope + '\u0000human\u0000'
        + (human?.turnId ?? human?.sourceItemId ?? first.interactionId),
    ),
    idSource: 'inferred',
  };
}

function technicalActivityId(record: T.AgentInteractionRecord): string {
  return stableId(
    'ta',
    [
      record.agentInstanceId ?? record.agentAssetId,
      trafficRoleForInteraction(record),
      record.endpoint,
      record.path,
    ].join('\u0000'),
  );
}

function projectTechnicalActivities(
  records: T.AgentInteractionRecord[],
): TechnicalActivityProjection[] {
  const grouped = new Map<string, T.AgentInteractionRecord[]>();
  for (const record of records) {
    const id = technicalActivityId(record);
    const items = grouped.get(id) ?? [];
    items.push(record);
    grouped.set(id, items);
  }
  return [...grouped.entries()].map(([technicalActivityId, items]) => {
    items.sort((left, right) => left.at - right.at || left.interactionId.localeCompare(right.interactionId));
    const first = items[0];
    const last = items.at(-1)!;
    const failed = items.some((item) => item.statusCode >= 400);
    const partial = items.some((item) => item.completeness !== 'complete');
    const status: TechnicalActivityProjection['status'] = failed
      ? 'failed'
      : partial ? 'partial' : 'complete';
    return {
      technicalActivityId,
      agentAssetId: first.agentAssetId,
      agentInstanceId: first.agentInstanceId,
      role: trafficRoleForInteraction(first) as TechnicalActivityProjection['role'],
      interactionIds: items.map((item) => item.interactionId),
      startedAtUnixNs: first.startedAtUnixNs,
      endedAtUnixNs: last.endedAtUnixNs,
      methods: [...new Set(items.map((item) => item.method))],
      paths: [...new Set(items.map((item) => item.path))],
      status,
    };
  }).sort((left, right) => BigInt(left.startedAtUnixNs) < BigInt(right.startedAtUnixNs) ? -1 : 1);
}

export function resolveAgentConversationsV2(
  interactions: T.AgentInteractionRecord[],
  resolutionRevision = Math.max(
    1,
    ...interactions.map((interaction) => interaction.receivedAt),
  ) * 100 + AGENT_CONVERSATION_RESOLVER_V2,
): ConversationResolutionV2 {
  const records = interactions
    .map((item) => {
      const request = requestObject(item);
      const providerConversationId = item.providerConversationId
        ?? providerConversationValue(request);
      const providerPreviousResponseId = item.providerPreviousResponseId
        ?? text(request?.previous_response_id);
      const normalizedItem: T.AgentInteractionRecord = {
        ...item,
        ...(providerConversationId ? { providerConversationId } : {}),
        ...(providerPreviousResponseId ? { providerPreviousResponseId } : {}),
      };
      return {
        ...normalizedItem,
        trafficRole: trafficRoleForInteraction(normalizedItem),
        conversationAnchors: conversationAnchorsForInteraction(normalizedItem),
      };
    })
    .sort((left, right) => left.at - right.at || left.interactionId.localeCompare(right.interactionId));
  const decidedAt = Math.max(1, ...records.map((record) => record.receivedAt));
  const visibleIndexes = records
    .map((record, index) => ({ record, index }))
    .filter(({ record }) => ['conversation', 'context_replay'].includes(record.trafficRole ?? ''))
    .map(({ index }) => index);
  const visibleSet = new Set(visibleIndexes);
  const technicalRecords = records.filter((_, index) => !visibleSet.has(index));
  const set = new DisjointSet(records.length);

  const existing = new Map<string, number[]>();
  const provider = new Map<string, number[]>();
  const response = new Map<string, number[]>();
  const continuity = new Map<string, number[]>();
  const toolCalls = new Map<string, number[]>();

  for (const index of visibleIndexes) {
    const item = records[index];
    const scope = anchorScopeKey(item);
    if (item.conversationId) {
      const key = scope + '\u0000' + item.conversationId;
      unionCompatiblePrior(set, existing, key, index, visibleIndexes, records);
      rememberIndex(existing, key, index);
    }
    if (item.providerConversationId) {
      const key = scope + '\u0000' + item.providerConversationId;
      unionCompatiblePrior(set, provider, key, index, visibleIndexes, records);
      rememberIndex(provider, key, index);
    }
    if (item.providerPreviousResponseId) {
      const key = scope + '\u0000' + item.providerPreviousResponseId;
      unionCompatiblePrior(set, response, key, index, visibleIndexes, records);
    }
    if (item.providerResponseId) {
      rememberIndex(response, scope + '\u0000' + item.providerResponseId, index);
    }
    for (const anchor of item.conversationAnchors ?? []) {
      if (anchor.kind !== 'continuity_key') continue;
      const key = scope + '\u0000' + anchor.namespace + '\u0000' + anchor.valueHash;
      unionCompatiblePrior(set, continuity, key, index, visibleIndexes, records);
      rememberIndex(continuity, key, index);
    }
    for (const call of item.toolCalls) {
      rememberIndex(toolCalls, scope + '\u0000' + call.toolCallId, index);
    }
    for (const result of item.toolResults) {
      const key = scope + '\u0000' + result.toolCallId;
      unionCompatiblePrior(set, toolCalls, key, index, visibleIndexes, records);
    }
  }

  const byScope = new Map<string, number[]>();
  for (const index of visibleIndexes) {
    const scope = anchorScopeKey(records[index]);
    const indexes = byScope.get(scope) ?? [];
    indexes.push(index);
    byScope.set(scope, indexes);
  }
  for (const indexes of byScope.values()) {
    for (let currentOffset = 0; currentOffset < indexes.length; currentOffset += 1) {
      const currentIndex = indexes[currentOffset];
      const currentMessages = anchorValues(records[currentIndex], 'message_item_id');
      const currentTurns = anchorValues(records[currentIndex], 'turn_id');
      const currentHuman = humanContentHashes(records[currentIndex]);
      if (currentMessages.size === 0 && currentTurns.size === 0 && currentHuman.length === 0) continue;
      for (let priorOffset = currentOffset - 1; priorOffset >= 0; priorOffset -= 1) {
        const priorIndex = indexes[priorOffset];
        const priorMessages = anchorValues(records[priorIndex], 'message_item_id');
        const priorTurns = anchorValues(records[priorIndex], 'turn_id');
        const priorHuman = humanContentHashes(records[priorIndex]);
        const replayExtendsPrior = properSubset(priorMessages, currentMessages)
          || properSubset(priorTurns, currentTurns)
          || properPrefix(priorHuman, currentHuman);
        if (!replayExtendsPrior) continue;
        if (unionGroupsIfAllowed(set, priorIndex, currentIndex, visibleIndexes, records)) break;
      }
    }
  }

  const aliases: ConversationRouteAliasV1[] = [];
  const memberships: ConversationMembershipV2[] = [];
  const userConversationRouteIds = new Set<string>();
  for (const indexes of groupIndexes(set, visibleIndexes).values()) {
    indexes.sort((left, right) =>
      records[left].at - records[right].at
      || records[left].interactionId.localeCompare(records[right].interactionId));
    const canonical = canonicalConversationId(indexes, records);
    const existingIds = [...new Set(indexes
      .map((index) => records[index].conversationId)
      .filter((value): value is string => Boolean(value)))];
    userConversationRouteIds.add(canonical.conversationId);
    for (const existingId of existingIds) userConversationRouteIds.add(existingId);
    const evidence = indexes.flatMap((index) =>
      (records[index].conversationAnchors ?? []).map((anchor) => anchor.kind));
    // Persist an authoritative self-route so a newer resolution can repair an older control-flow
    // alias that accidentally reused this now-proven Canonical Thread id.
    aliases.push({
      schemaVersion: 'anysentry.agent_conversation_route_alias.v1',
      aliasConversationId: canonical.conversationId,
      targetType: 'conversation',
      targetId: canonical.conversationId,
      canonicalConversationId: canonical.conversationId,
      reason: 'provider_chain_merge',
      evidence: ['canonical_thread'],
      resolverVersion: AGENT_CONVERSATION_RESOLVER_V2,
      resolutionRevision,
      createdAt: decidedAt,
    });
    for (const alias of existingIds) {
      if (alias === canonical.conversationId) continue;
      aliases.push({
        schemaVersion: 'anysentry.agent_conversation_route_alias.v1',
        aliasConversationId: alias,
        targetType: 'conversation',
        targetId: canonical.conversationId,
        canonicalConversationId: canonical.conversationId,
        reason: evidence.includes('continuity_key')
          ? 'continuity_anchor_merge'
          : evidence.includes('message_item_id') || evidence.includes('turn_id')
            ? 'replay_lineage_merge'
            : 'provider_chain_merge',
        evidence: [...new Set(evidence)].sort(),
        resolverVersion: AGENT_CONVERSATION_RESOLVER_V2,
        resolutionRevision,
        createdAt: decidedAt,
      });
    }
    for (const index of indexes) {
      const itemEvidence = (records[index].conversationAnchors ?? []).map((anchor) => anchor.kind);
      records[index] = {
        ...records[index],
        conversationId: canonical.conversationId,
        conversationIdSource: canonical.idSource,
        conversationBindingVersion: AGENT_CONVERSATION_RESOLVER_V2,
        correlationQuality: records[index].correlationQuality === 'exact'
          ? 'exact'
          : evidence.includes('continuity_key') ? 'strong' : 'inferred',
      };
      memberships.push({
        schemaVersion: 'anysentry.agent_conversation_membership.v2',
        membershipId: stableId(
          'cm',
          records[index].interactionId + '\u0000' + String(resolutionRevision),
        ),
        interactionId: records[index].interactionId,
        canonicalConversationId: canonical.conversationId,
        role: records[index].trafficRole === 'context_replay' ? 'context_replay' : 'conversation',
        logicalScopeKey: conversationLogicalScopeKeyV2(records[index]),
        resolutionRevision,
        resolverVersion: AGENT_CONVERSATION_RESOLVER_V2,
        confidence: records[index].correlationQuality ?? 'inferred',
        evidence: [...new Set(itemEvidence)].sort(),
        decidedAt: records[index].receivedAt,
      });
    }
  }

  for (const item of technicalRecords) {
    const activityId = technicalActivityId(item);
    if (item.conversationId && !userConversationRouteIds.has(item.conversationId)) {
      aliases.push({
        schemaVersion: 'anysentry.agent_conversation_route_alias.v1',
        aliasConversationId: item.conversationId,
        targetType: 'technical_activity',
        targetId: activityId,
        technicalActivityId: activityId,
        reason: 'control_activity_fold',
        evidence: [item.trafficRole ?? 'unclassified'],
        resolverVersion: AGENT_CONVERSATION_RESOLVER_V2,
        resolutionRevision,
        createdAt: decidedAt,
      });
    }
    memberships.push({
      schemaVersion: 'anysentry.agent_conversation_membership.v2',
      membershipId: stableId('cm', item.interactionId + '\u0000' + String(resolutionRevision)),
      interactionId: item.interactionId,
      technicalActivityId: activityId,
      role: trafficRoleForInteraction(item),
      logicalScopeKey: conversationLogicalScopeKeyV2(item),
      resolutionRevision,
      resolverVersion: AGENT_CONVERSATION_RESOLVER_V2,
      confidence: item.correlationQuality ?? 'inferred',
      evidence: (item.conversationAnchors ?? []).map((anchor) => anchor.kind),
      decidedAt: item.receivedAt,
    });
  }

  return {
    records,
    conversationRecords: records.filter((_, index) => visibleSet.has(index)),
    technicalRecords,
    aliases: [...new Map(aliases.map((alias) => [alias.aliasConversationId, alias])).values()],
    technicalActivities: projectTechnicalActivities(technicalRecords),
    memberships,
    resolutionRevision,
  };
}
