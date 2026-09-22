import { createHash } from 'node:crypto';

import type * as T from './types';
import {
  humanVisibleUserContent,
  normalizedModelResponseText,
} from './agent-semantic-timeline';
import {
  interactionHumanMessages,
  trafficRoleForInteraction,
  conversationLogicalScopeKeyV2,
  conversationDeploymentScopeKey,
  conversationDirectoryScopeKey,
  canonicalPerRequestConversationId,
  hopConversationFence,
  hopScopedSessionConversationId,
  GENERIC_SESSION_IDS,
} from './agent-conversation-resolution-v2';
import {
  closeToolCallsAcrossInteractions,
  projectInteractionsWithReconstructedHistoryToolCalls,
} from './agent-tool-closure';
import { observabilityCoverageLayers } from './observability-coverage';

function deploymentSessionScopeKeyForRecord(record: T.AgentInteractionRecord): string {
  return conversationDeploymentScopeKey(record);
}

const PREVIEW_CHARACTERS = 320;

export interface AgentConversationProjection {
  summaries: T.AgentConversationSummary[];
  interactionsByConversation: Map<string, T.AgentInteractionRecord[]>;
  sourceInteractionsByConversation: Map<string, T.AgentInteractionRecord[]>;
}

function stableId(prefix: string, value: string): string {
  return `${prefix}_${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
}

function normalized(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? '';
}

function displayProduct(value: string | undefined): string | undefined {
  const product = value?.trim();
  switch (normalized(product)) {
    case 'codex':
    case 'codex-cli':
      return 'Codex';
    case 'claude':
    case 'claude-code':
      return 'Claude Code';
    case 'langchain':
      return 'LangChain';
    case 'langgraph':
      return 'LangGraph';
    default:
      return product || undefined;
  }
}

function interactionEnvironment(
  record: T.AgentInteractionRecord,
  asset?: T.AgentInventoryItem,
): T.AgentConversationSummary['environment'] {
  if (record.environment && record.environment !== 'unknown') return record.environment;
  if (asset?.runtime && asset.runtime !== 'unknown') return asset.runtime;
  const cgroup = record.process?.cgroup?.toLowerCase() ?? '';
  if (cgroup.includes('kubepods')) return 'kubernetes';
  if (/(?:docker|containerd|crio|libpod)/u.test(cgroup)) return 'docker';
  // Interactions normalized before the additive `environment` field retain Observer's legacy
  // container workspace (`agent://<container-id>`) even when cgroup text was unavailable. Host
  // TLS workers can also use the `agent://` namespace, so only a real short/full hexadecimal
  // container identity is Docker evidence; a generation-stable host root remains Host evidence.
  if (/^agent:\/\/[a-f0-9]{12,64}$/iu.test(record.workspacePath)) return 'docker';
  if (record.agentInstanceId?.startsWith('host-root:')) return 'host';
  const workspace = record.workspacePath?.trim() ?? '';
  const product = (record.agentProduct ?? asset?.agentProduct ?? '').toLowerCase();
  // Container app roots (/app, /) must not fall through to host merely because a process exists.
  if (workspace === '/' || workspace === '/app' || workspace.startsWith('/app/')
    || ((product.includes('langgraph') || product.includes('langchain') || product.includes('dify'))
      && workspace.startsWith('/'))) {
    return product.includes('langgraph') || product.includes('langchain') || product.includes('dify')
      ? 'docker'
      : 'unknown';
  }
  return record.process ? 'host' : asset?.runtime ?? 'unknown';
}

function stableRuntimeSession(value: string | undefined): string | undefined {
  const session = value?.trim();
  if (!session || session.length > 512 || GENERIC_SESSION_IDS.has(session.toLowerCase())) {
    return undefined;
  }
  return session;
}

function conversationRuntimeSession(record: T.AgentInteractionRecord): string | undefined {
  // Runtime/container IDs are machine evidence, not provider Conversation IDs.  Only an explicit
  // application-level session contract may reach this helper (legacy rows without quality are
  // handled by the inferred clustering path below).
  if (record.sessionIdentityQuality === 'ephemeral'
    || record.sessionIdSource === 'legacy_agent_fallback'
    || record.sessionIdSource === 'legacy_task_fallback'
    || record.sessionIdSource === 'per_request'
    || record.sessionIdSource === 'unresolved') return undefined;
  if (!['confirmed', 'strong'].includes(record.sessionIdentityQuality ?? '')
    || !['conversation', 'resumable'].includes(record.sessionMode ?? '')) return undefined;
  const session = stableRuntimeSession(record.runtimeSessionId);
  if (!session) return undefined;
  // Observer uses a short container id as the transport/runtime session when no application-level
  // session exists. Treating that physical identifier as a conversation would merge every HTTP
  // request handled by a long-running LangChain/Dify service. A real application session remains
  // valid because it is not embedded in the runtime/container identity evidence.
  const normalizedSession = session.toLowerCase();
  if (normalizedSession === record.process?.comm?.trim().toLowerCase()) return undefined;
  const physicalHints = [
    record.agentInstanceId,
    record.process?.cgroup,
  ].filter((value): value is string => Boolean(value)).map((value) => value.toLowerCase());
  if (normalizedSession.length >= 8 && physicalHints.some((value) => value.includes(normalizedSession))) {
    return undefined;
  }
  return session;
}

function rootIdentity(record: T.AgentInteractionRecord): string {
  const process = record.process;
  return [
    record.agentAssetId,
    record.workspacePath,
    record.agentInstanceId ?? '',
    process?.hostId ?? '',
    process?.bootId ?? '',
    process?.pidNamespace ?? '',
    process?.startTimeTicks ?? '',
    process?.pid ?? '',
    hopConversationFence(record),
  ].join('\u0000');
}

function explicitConversation(
  record: T.AgentInteractionRecord,
  providerChains: Map<string, string>,
): {
  conversationId: string;
  source: 'provider' | 'runtime' | 'inferred';
  /** Scope is part of the grouping key even when a legacy/provider ID is reused. */
  scopeKey: string;
} | undefined {
  const hopFence = hopConversationFence(record);
  const scopeKey = conversationDirectoryScopeKey(record);
  const perRequestBoundary = record.sessionMode === 'per_request'
    || record.sessionIdentityQuality === 'ephemeral'
    || record.sessionIdSource === 'per_request'
    || Boolean(
      record.providerConversationId
      && (record.sessionIdentityQuality === 'unknown'
        || record.sessionIdentityQuality === 'unresolved')
      && !record.sessionKey,
    );
  if (perRequestBoundary) {
    // A stateless service may repeat a native provider/session label on every POST. Prefer the
    // server-derived canonical Session; if it is unavailable, retain the interaction as an
    // event-local projection key rather than merging unrelated requests by provider text.
    return {
      conversationId: canonicalPerRequestConversationId([record]),
      source: 'inferred',
      scopeKey,
    };
  }
  if (record.conversationId
    && (record.conversationIdSource !== 'inferred' || record.conversationBindingVersion)) {
    // Durable v2 Thread ids are already hop-scoped. Hashing them again produces a directory
    // key with no route alias, so timeline-v3 point-reads of that key return 0 turns.
    // Keep the hop remint only for unbound provider/legacy ids that can be reused across hops.
    return {
      conversationId: hopFence && !record.conversationBindingVersion
        ? stableId('cv', `bound\0${record.conversationId}${hopFence}`)
        : record.conversationId,
      source: record.conversationIdSource ?? 'inferred',
      scopeKey,
    };
  }
  const directoryId = hopScopedSessionConversationId(record);
  if (directoryId) {
    return {
      conversationId: directoryId,
      source: record.sessionIdSource === 'provider' ? 'provider' : 'runtime',
      scopeKey,
    };
  }
  if (record.providerConversationId) {
    return {
      conversationId: stableId(
        'cv',
        `provider\u0000${scopeKey}\u0000${record.providerConversationId}`,
      ),
      source: 'provider',
      scopeKey,
    };
  }
  const providerChain = providerChains.get(record.interactionId);
  if (providerChain) {
    return {
      conversationId: hopFence
        ? stableId('cv', `provider-chain\0${providerChain}${hopFence}`)
        : providerChain,
      source: 'provider',
      scopeKey,
    };
  }
  const session = conversationRuntimeSession(record);
  if (session) {
    return {
      conversationId: stableId(
        'cv',
        `runtime\u0000${record.agentAssetId}\u0000${session}${hopFence}`,
      ),
      source: 'runtime',
      scopeKey,
    };
  }
  return undefined;
}

function providerResponseChains(records: T.AgentInteractionRecord[]): Map<string, string> {
  const byResponseId = new Map(records
    .filter((record): record is T.AgentInteractionRecord & { providerResponseId: string } =>
      Boolean(record.providerResponseId))
    .map((record) => [record.providerResponseId, record]));
  const referenced = new Set(records
    .map((record) => record.providerPreviousResponseId)
    .filter((value): value is string => Boolean(value)));
  const projected = new Map<string, string>();
  for (const record of records) {
    if (!record.providerPreviousResponseId
      && (!record.providerResponseId || !referenced.has(record.providerResponseId))) continue;
    let rootId = record.providerPreviousResponseId ?? record.providerResponseId;
    let cursor: T.AgentInteractionRecord | undefined = record;
    const seen = new Set<string>();
    while (cursor?.providerPreviousResponseId && !seen.has(cursor.providerPreviousResponseId)) {
      seen.add(cursor.providerPreviousResponseId);
      rootId = cursor.providerPreviousResponseId;
      const prior = byResponseId.get(cursor.providerPreviousResponseId);
      if (!prior || conversationLogicalScopeKeyV2(prior) !== conversationLogicalScopeKeyV2(record)
        || deploymentSessionScopeKeyForRecord(prior) !== deploymentSessionScopeKeyForRecord(record)) break;
      rootId = prior.providerResponseId;
      cursor = prior;
    }
    if (!rootId) continue;
    projected.set(
      record.interactionId,
      stableId('cv', `provider-response-chain\u0000${conversationLogicalScopeKeyV2(record)}\u0000${rootId}`),
    );
  }
  return projected;
}

function compareInteraction(
  left: T.AgentInteractionRecord,
  right: T.AgentInteractionRecord,
): number {
  return left.at - right.at || left.interactionId.localeCompare(right.interactionId);
}

function scopeRunJoinKey(record: T.AgentInteractionRecord): string | undefined {
  const run = record.runId?.trim() || record.invocationId?.trim() || record.producerRunId?.trim();
  const asset = record.agentAssetId?.trim();
  if (!run || !asset) return undefined;
  return [
    asset,
    hopConversationFence(record),
    run,
  ].join('\u0000');
}

function groupScopeRunJoinKey(records: readonly T.AgentInteractionRecord[]): string | undefined {
  const keys = new Set(records.map(scopeRunJoinKey).filter((value): value is string => Boolean(value)));
  return keys.size === 1 ? [...keys][0] : undefined;
}

/**
 * One POST / one hop / one Run is one Thread when any sibling already has a
 * durable session-key id. Tool rows without a provider thread_id must not mint
 * a second directory Conversation for the same request.
 */
function coalesceScopeRunSessionGroups(
  grouped: Map<string, {
    source: 'provider' | 'runtime' | 'inferred';
    records: T.AgentInteractionRecord[];
    conversationId: string;
    scopeKey: string;
  }>,
): void {
  const byJoin = new Map<string, string[]>();
  for (const [key, group] of grouped) {
    const join = groupScopeRunJoinKey(group.records);
    if (!join) continue;
    const keys = byJoin.get(join) ?? [];
    keys.push(key);
    byJoin.set(join, keys);
  }
  for (const keys of byJoin.values()) {
    if (keys.length < 2) continue;
    const hopScoped = keys
      .map((key) => grouped.get(key))
      .filter((group): group is NonNullable<typeof group> => Boolean(
        group
        && group.records.some((record) => Boolean(hopScopedSessionConversationId(record))),
      ))
      .sort((left, right) =>
        right.records.length - left.records.length
        || left.records[0]!.at - right.records[0]!.at);
    const target = hopScoped[0];
    if (!target) continue;
    const targetKey = keys.find((key) => grouped.get(key) === target);
    if (!targetKey) continue;
    for (const key of keys) {
      if (key === targetKey) continue;
      const source = grouped.get(key);
      if (!source) continue;
      target.records.push(...source.records);
      if (source.source === 'provider') target.source = 'provider';
      else if (source.source === 'runtime' && target.source === 'inferred') {
        target.source = 'runtime';
      }
      grouped.delete(key);
    }
  }
}

function canonicalSemanticJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(canonicalSemanticJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalSemanticJson(object[key])}`).join(',')}}`;
}

function semanticValueHash(value: unknown): string {
  return createHash('sha256').update(canonicalSemanticJson(value)).digest('hex');
}

/**
 * Claude and other cumulative-message APIs resend prior tool results in every later model request.
 * Keep the immutable Interaction evidence untouched, but normalize the conversation projection so
 * an identical call/result is displayed and counted once. A changed result body remains visible as
 * a distinct observation because the semantic hash is part of its identity.
 */
function deduplicateToolEvidence(
  records: T.AgentInteractionRecord[],
): T.AgentInteractionRecord[] {
  const normalizedRecords = [...records].sort(compareInteraction).map((record) => ({
    ...record,
    toolCalls: [...record.toolCalls],
    toolResults: [...record.toolResults],
    semanticItems: record.semanticItems ? [...record.semanticItems] : undefined,
  }));
  const calls = new Map<string, { recordIndex: number; itemIndex: number; richness: number }>();
  const results = new Map<string, { recordIndex: number; itemIndex: number }>();

  normalizedRecords.forEach((record, recordIndex) => {
    const retainedCalls: T.AgentInteractionToolCall[] = [];
    for (const call of record.toolCalls) {
      const richness = canonicalSemanticJson(call.arguments).length
        + (normalized(call.name) === 'unknown' ? 0 : call.name.length);
      // Wire/HTTP tool captures must keep their toolCallId anchors. Collapsing them into the
      // model Interaction removes the only row linkHttpToolCaptureEvidence can attach, so the
      // inspector loses raw tool request/response bodies and plaintext evidenceEventIds.
      if (record.interactionType === 'tool') {
        retainedCalls.push(call);
        if (!calls.has(call.toolCallId)) {
          calls.set(call.toolCallId, {
            recordIndex,
            itemIndex: retainedCalls.length - 1,
            richness,
          });
        }
        continue;
      }
      const prior = calls.get(call.toolCallId);
      if (!prior) {
        calls.set(call.toolCallId, {
          recordIndex,
          itemIndex: retainedCalls.length,
          richness,
        });
        retainedCalls.push(call);
        continue;
      }
      if (richness > prior.richness) {
        normalizedRecords[prior.recordIndex].toolCalls[prior.itemIndex] = call;
        prior.richness = richness;
      }
    }
    record.toolCalls = retainedCalls;

    const retainedResults: T.AgentInteractionToolResult[] = [];
    for (const result of record.toolResults) {
      if (record.interactionType === 'tool') {
        retainedResults.push(result);
        continue;
      }
      const key = `${result.toolCallId}\u0000${semanticValueHash({
        content: result.content,
        isError: result.isError,
      })}`;
      const prior = results.get(key);
      if (prior) {
        const existing = normalizedRecords[prior.recordIndex].toolResults[prior.itemIndex];
        if (!existing.name && result.name) existing.name = result.name;
        continue;
      }
      results.set(key, { recordIndex, itemIndex: retainedResults.length });
      retainedResults.push(result);
    }
    record.toolResults = retainedResults;
  });

  return normalizedRecords;
}

function userMessageLineage(record: T.AgentInteractionRecord): string[] {
  return requestMessages(record)
    .filter((message) => message.role.toLowerCase() === 'user')
    .map((message) => humanVisibleUserContent(message.content))
    .filter((content) => content !== undefined)
    .map((message) => createHash('sha256')
      .update(JSON.stringify(message ?? null))
      .digest('hex'));
}

function isPrefix(left: string[], right: string[]): boolean {
  return left.length <= right.length && left.every((value, index) => value === right[index]);
}

function isProperPrefix(left: string[], right: string[]): boolean {
  return left.length > 0 && left.length < right.length && isPrefix(left, right);
}

function inferredThreadScope(record: T.AgentInteractionRecord): string {
  return `${conversationLogicalScopeKeyV2(record)}${hopConversationFence(record)}`;
}

function clusterContinuesPriorThread(
  prior: T.AgentInteractionRecord[],
  current: T.AgentInteractionRecord[],
): boolean {
  const issuedCalls = new Set(prior.flatMap((record) =>
    record.toolCalls.map((call) => call.toolCallId)));
  if (current.some((record) =>
    record.toolResults.some((result) => issuedCalls.has(result.toolCallId)))) return true;
  if (current.some((record) => record.sessionMode === 'per_request'
    || record.sessionIdentityQuality === 'ephemeral')) return false;
  // Cumulative request lineage is product-neutral.  Provider/adapter anchors are preferred; a
  // bounded human-message prefix is only a fallback for legacy rows without explicit IDs.
  const priorLineage = userMessageLineage(prior.at(-1)!);
  const currentLineage = userMessageLineage(current.at(-1)!);
  return isProperPrefix(priorLineage, currentLineage);
}

function continuesInferredConversation(
  cluster: T.AgentInteractionRecord[],
  current: T.AgentInteractionRecord,
): boolean {
  const previous = cluster.at(-1);
  if (!previous) return false;
  if (perRequestBoundary(previous) || perRequestBoundary(current)) {
    // A stateless service creates one Session per POST.  Keep a Tool loop together only when an
    // explicit Run/Invocation continuity key proves that the two exchanges belong to one call.
    return Boolean(previous.runIdSource === 'producer'
      && current.runIdSource === 'producer'
      && previous.runId && current.runId && previous.runId === current.runId);
  }
  if (current.providerPreviousResponseId && cluster.some((record) =>
    record.providerResponseId === current.providerPreviousResponseId)) return true;

  const issuedToolCalls = new Set(cluster.flatMap((record) =>
    record.toolCalls.map((call) => call.toolCallId)));
  if (current.toolResults.some((result) => issuedToolCalls.has(result.toolCallId))) return true;
  if (current.request.sha256 === previous.request.sha256) return true;

  const firstUsers = userMessageLineage(cluster[0]);
  const currentUsers = userMessageLineage(current);
  return firstUsers.length > 0
    && currentUsers.length > 0
    && (isPrefix(firstUsers, currentUsers) || isPrefix(currentUsers, firstUsers));
}

function perRequestBoundary(record: T.AgentInteractionRecord): boolean {
  return record.sessionMode === 'per_request'
    || record.sessionIdentityQuality === 'ephemeral'
    || record.sessionIdSource === 'per_request';
}

function annotateTurns(
  conversationId: string,
  records: T.AgentInteractionRecord[],
): T.AgentInteractionRecord[] {
  const ordered = [...records].sort(compareInteraction);
  const attempts = new Map<string, number>();
  let turn = 0;
  let previous: T.AgentInteractionRecord | undefined;
  return ordered.map((record) => {
    const latestHuman = interactionHumanMessages(record).at(-1);
    const stableTurnAnchor = record.runId
      ? `run:${record.runId}`
      : latestHuman?.turnId ?? latestHuman?.sourceItemId;
    const continuesToolLoop = Boolean(
      previous
      && (record.toolResults.length > 0 || previous.toolCalls.length > 0),
    );
    // A provider/CLI retry commonly replays the byte-identical request after an HTTP error. Older
    // payloads do not carry a stable message/turn id, so without this evidence the projection
    // incorrectly creates one empty user Turn per retry. Reuse the prior Turn only when the
    // immediately preceding attempt failed and the full request hash is identical; two successful
    // user turns that happen to contain the same prompt therefore remain distinct.
    const retriesPreviousRequest = Boolean(
      previous
      && previous.interactionType === 'model'
      && record.interactionType === 'model'
      && previous.statusCode >= 400
      && record.request.sha256 === previous.request.sha256,
    );
    if (!previous || (!continuesToolLoop && !retriesPreviousRequest && !stableTurnAnchor)) turn += 1;
    const turnId = stableTurnAnchor
      ? stableId('trn', [
          normalized(record.tenantId),
          normalized(record.environmentId),
          normalized(record.agentProduct),
          normalized(record.workspacePath),
          normalized(record.process?.hostId),
          stableTurnAnchor,
        ].join('\u0000'))
      : previous && (continuesToolLoop || retriesPreviousRequest) && previous.turnId
        ? previous.turnId
        : `${conversationId}:turn:${turn}`;
    const modelCallId = stableId(
      'mc',
      `${turnId}\u0000${record.request.sha256}`,
    );
    const attempt = (attempts.get(modelCallId) ?? 0) + 1;
    attempts.set(modelCallId, attempt);
    const annotated: T.AgentInteractionRecord = {
      ...record,
      conversationId,
      turnId,
      modelCallId,
      attemptId: `${modelCallId}:attempt:${attempt}`,
      correlationQuality: record.correlationQuality ?? 'inferred',
    };
    previous = annotated;
    return annotated;
  });
}

function jsonPreview(value: unknown, limit = PREVIEW_CHARACTERS): string | undefined {
  if (typeof value === 'string') {
    const text = value.replace(/\s+/gu, ' ').trim();
    if (!text) return undefined;
    if (text.length > 2_048 && /^[A-Za-z0-9+/=]+$/u.test(text.slice(0, 512))) {
      return `[inline binary/base64 · ${text.length.toLocaleString()} chars]`;
    }
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
  }
  if (Array.isArray(value)) {
    const text = value
      .map((item) => {
        if (typeof item === 'string') return item;
        if (!item || typeof item !== 'object') return '';
        const entry = item as Record<string, unknown>;
        return jsonPreview(entry.text ?? entry.content ?? entry.input_text ?? entry.output_text, limit);
      })
      .filter(Boolean)
      .join(' ');
    return jsonPreview(text, limit);
  }
  if (value && typeof value === 'object') {
    const entry = value as Record<string, unknown>;
    const direct = jsonPreview(
      entry.text ?? entry.content ?? entry.input_text ?? entry.output_text ?? entry.result,
      limit,
    );
    if (direct) return direct;
    try {
      const serialized = JSON.stringify(value);
      return serialized.length > limit ? `${serialized.slice(0, limit)}…` : serialized;
    } catch {
      return undefined;
    }
  }
  return value === undefined || value === null ? undefined : String(value);
}

function requestMessages(record: T.AgentInteractionRecord): T.AgentInteractionMessage[] {
  return record.request.messages ?? [];
}

function textualMessageContent(value: unknown, depth = 0): string | undefined {
  if (depth > 3) return undefined;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const text = value
      .map((item) => textualMessageContent(item, depth + 1))
      .filter((item): item is string => Boolean(item))
      .join(' ');
    return text || undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  const entry = value as Record<string, unknown>;
  return textualMessageContent(
    entry.text ?? entry.content ?? entry.input_text ?? entry.output_text,
    depth + 1,
  );
}

function messagePreview(message: T.AgentInteractionMessage | undefined): string | undefined {
  if (!message) return undefined;
  const raw = textualMessageContent(message.content) ?? jsonPreview(message.content, 8_192);
  if (!raw) return undefined;
  const withoutRuntimeContext = message.role.toLowerCase() === 'user'
    ? raw.replace(
        /^(?:<(environment_context|system-reminder)>.*?<\/\1>\s*)+/isu,
        '',
      ).trim()
    : raw;
  const preview = withoutRuntimeContext || raw;
  // Keep Agent→LLM cards on real human turns; Claude resume recaps are role=user but not human.
  if (
    message.role.toLowerCase() === 'user'
    && /^The user stepped away and is coming back\./u.test(preview.trim())
  ) {
    return undefined;
  }
  return jsonPreview(preview);
}

function requestPreview(
  record: T.AgentInteractionRecord,
  previous?: T.AgentInteractionRecord,
): string | undefined {
  const messages = requestMessages(record);
  const prior = previous ? requestMessages(previous) : [];
  let firstNew = 0;
  while (
    firstNew < messages.length
    && firstNew < prior.length
    && JSON.stringify(messages[firstNew]) === JSON.stringify(prior[firstNew])
  ) firstNew += 1;
  const delta = messages.slice(firstNew);
  // Claude often appends a trailing system `<total_tokens>…` (and similar) after the human turn.
  // Prefer the new user/developer message over the latest system/tool so the Agent→LLM card shows
  // what the human actually said, not the runtime counter.
  const preferred = [...delta].reverse().find((message) => {
    if (message.role.toLowerCase() !== 'user') return false;
    return Boolean(messagePreview(message));
  })
    ?? [...delta].reverse().find((message) => message.role.toLowerCase() === 'developer')
    ?? [...delta].reverse().find((message) => {
      if (message.role.toLowerCase() !== 'system') return false;
      const text = messagePreview(message) ?? '';
      return text.length > 0 && !/^<(?:total_tokens|system-reminder|environment_context)\b/iu.test(text);
    })
    ?? [...delta].reverse().find((message) => message.role.toLowerCase() === 'tool');
  const fallback = [...messages].reverse().find((message) => {
    if (message.role.toLowerCase() !== 'user') return false;
    return Boolean(messagePreview(message));
  });
  return messagePreview(preferred ?? fallback)
    ?? jsonPreview(record.request.structured)
    ?? jsonPreview(record.request.body);
}

function firstPromptPreview(record: T.AgentInteractionRecord): string | undefined {
  const messages = requestMessages(record);
  const users = messages.filter((message) => message.role.toLowerCase() === 'user');
  const userPreview = [...users].reverse().map(messagePreview).find(Boolean);
  const developer = messages.find((message) =>
    ['developer', 'system'].includes(message.role.toLowerCase()));
  return userPreview ?? jsonPreview(developer?.content) ?? requestPreview(record);
}

function resolvedToolResultIds(
  interactions: T.AgentInteractionRecord[],
): Set<string> {
  const callAt = new Map<string, bigint>();
  for (const interaction of interactions) {
    let interactionAt: bigint | undefined;
    try { interactionAt = BigInt(interaction.startedAtUnixNs); } catch { /* keep unknown */ }
    for (const call of interaction.toolCalls) {
      let at = interactionAt;
      try {
        if (call.issuedAtUnixNs) at = BigInt(call.issuedAtUnixNs);
      } catch { /* use interaction boundary */ }
      if (at !== undefined && (!callAt.has(call.toolCallId) || at < callAt.get(call.toolCallId)!)) {
        callAt.set(call.toolCallId, at);
      }
    }
  }
  const resolved = new Set<string>();
  for (const interaction of interactions) {
    for (const result of interaction.toolResults) {
      const started = callAt.get(result.toolCallId);
      if (started !== undefined && result.observedAtUnixNs) {
        try {
          if (BigInt(result.observedAtUnixNs) < started) continue;
        } catch {
          continue;
        }
      }
      resolved.add(result.toolCallId);
    }
  }
  // Cross-interaction ToolResult pairing (P2) closes Observer's single-row tool_result_pending
  // without mutating stored completeness. Merge those IDs so coverage/timeline stop warning.
  for (const match of closeToolCallsAcrossInteractions(interactions).matches) {
    if (match.firstSeen) resolved.add(match.toolCallId);
  }
  return resolved;
}

function unknownToolResultIds(
  interactions: readonly T.AgentInteractionRecord[],
): Set<string> {
  return new Set(interactions.flatMap((interaction) =>
    interaction.toolResults
      .filter((result) => typeof result.isError !== 'boolean')
      .map((result) => result.toolCallId)));
}

function uniqueToolItemCount(
  interactions: readonly T.AgentInteractionRecord[],
  kind: 'call' | 'result',
): number {
  const ids = new Set<string>();
  let anonymous = 0;
  for (const interaction of interactions) {
    const items = kind === 'call' ? interaction.toolCalls : interaction.toolResults;
    items.forEach((item, index) => {
      const id = typeof item.toolCallId === 'string' && item.toolCallId.trim()
        ? item.toolCallId.trim()
        : `${interaction.interactionId}:${kind}:${index}`;
      if (id.startsWith(`${interaction.interactionId}:${kind}:`)) anonymous += 1;
      else ids.add(id);
    });
  }
  // A lifecycle start/end or context-replay interaction may repeat the same native tool ID.  The
  // timeline already exposes one semantic ToolCall per ID; summary counters must use that same
  // identity while retaining anonymous malformed items as separate bounded observations.
  return ids.size + anonymous;
}

const RECOVERABLE_WIRE_REASONS = new Set([
  'wire_template_unparsed',
  'wire_unknown',
  'reassembly_idle_expire_incomplete',
  'reassembly_shutdown_incomplete',
]);

function hasRecoverableStructuredPayload(interaction: T.AgentInteractionRecord): boolean {
  const structured = (value: unknown) => Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value as object).length > 0);
  if (structured(interaction.request?.structured) || structured(interaction.response?.structured)) {
    return true;
  }
  const body = typeof interaction.response?.body === 'string' ? interaction.response.body.trim()
    : typeof interaction.request?.body === 'string' ? interaction.request.body.trim() : '';
  return body.startsWith('{') && body.includes('"');
}

function effectiveInteractionState(
  interaction: T.AgentInteractionRecord,
  resolvedResults: Set<string>,
  unknownResults: Set<string> = new Set(),
): { complete: boolean; reasons: string[] } {
  const unresolvedToolCall = interaction.toolCalls.some((call) =>
    !resolvedResults.has(call.toolCallId));
  const recovered = hasRecoverableStructuredPayload(interaction)
    && interaction.statusCode > 0;
  const reasons = interaction.partialReasons.filter((reason) => {
    if (reason === 'tool_result_pending') return unresolvedToolCall;
    if (recovered && RECOVERABLE_WIRE_REASONS.has(reason)) return false;
    return true;
  });
  const unknownToolResult = interaction.toolCalls.some((call) =>
    unknownResults.has(call.toolCallId));
  if (unknownToolResult && !reasons.includes('tool_result_status_unobserved')) {
    reasons.push('tool_result_status_unobserved');
  }
  if (unresolvedToolCall && !reasons.includes('tool_result_pending')) {
    reasons.push('tool_result_pending');
  }
  const pendingResolved = interaction.completeness === 'partial'
    && !unresolvedToolCall
    && reasons.length === 0
    && interaction.statusCode < 400
    && (
      interaction.partialReasons.includes('tool_result_pending')
      || interaction.conversationCompleteness === 'tool_pending'
    )
    && interaction.transportCompleteness !== 'partial'
    && (interaction.wireCompleteness === undefined || interaction.wireCompleteness === 'complete');
  const recoveredComplete = recovered
    && !unresolvedToolCall
    && reasons.length === 0
    && interaction.statusCode > 0
    && interaction.statusCode < 400;
  return {
    complete: !unknownToolResult && ((interaction.completeness === 'complete' && !unresolvedToolCall)
      || pendingResolved
      || recoveredComplete),
    reasons,
  };
}

/** Shared by conversation directory and canonical Session coverage point-reads. */
export function conversationCoverage(
  interactions: T.AgentInteractionRecord[],
): T.AgentConversationCoverage {
  if (interactions.length === 0) {
    return {
      status: 'asset_only',
      reasons: ['no_plaintext_interaction'],
      completeInteractions: 0,
      partialInteractions: 0,
    };
  }
  const resolvedResults = resolvedToolResultIds(interactions);
  const unknownResults = unknownToolResultIds(interactions);
  const states = interactions.map((item) => effectiveInteractionState(item, resolvedResults, unknownResults));
  const completeInteractions = states.filter((state) => state.complete).length;
  const partialInteractions = interactions.length - completeInteractions;
  const reasons = [...new Set(states.flatMap((state) => state.reasons))];
  let status: T.AgentConversationCoverageStatus = partialInteractions ? 'partial' : 'complete';
  if (interactions.every((item) =>
    item.interactionType === 'unparsed' && !hasRecoverableStructuredPayload(item))) {
    status = interactions.some((item) =>
      ['http/2', 'websocket', 'quic', 'unknown'].includes(
        item.transportProtocol ?? item.protocol,
      ))
      ? 'transport_unparsed'
      : 'template_unparsed';
  } else if (interactions.some((item) => item.completeness === 'unsupported')) {
    status = interactions.some((item) => /(?:http\/2|websocket|quic)/iu.test(item.protocol))
      ? 'unsupported_protocol'
      : 'unsupported_tls_profile';
  } else if (interactions.some((item, index) =>
    item.statusCode === 0 || states[index].reasons.includes('stream_incomplete'))) {
    status = 'no_final_response';
  }
  return {
    status,
    reasons,
    completeInteractions,
    partialInteractions,
    lastEvidenceAt: new Date(Math.max(...interactions.map((item) => item.at))).toISOString(),
  };
}

export function emptyAgentUsageSummary(): T.AgentUsageSummary {
  return {
    modelCallCount: 0,
    successfulModelCallCount: 0,
    failedModelCallCount: 0,
    tokenReportedModelCallCount: 0,
    tokenCoverage: 'unavailable',
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningOutputTokens: 0,
    totalDurationMs: 0,
  };
}

function durationMs(record: T.AgentInteractionRecord): number {
  try {
    const duration = BigInt(record.durationNs) / 1_000_000n;
    return Number(duration > BigInt(Number.MAX_SAFE_INTEGER)
      ? BigInt(Number.MAX_SAFE_INTEGER)
      : duration);
  } catch {
    return 0;
  }
}

export function summarizeAgentUsage(
  records: readonly T.AgentInteractionRecord[],
): T.AgentUsageSummary {
  const modelCalls = records.filter((record) =>
    record.interactionType === 'model' && record.semanticOnly !== true,
  );
  if (modelCalls.length === 0) return emptyAgentUsageSummary();
  const reported = modelCalls.filter((record) => Boolean(record.usage));
  const totalDurationMs = modelCalls.reduce((sum, record) => sum + durationMs(record), 0);
  const successfulModelCallCount = modelCalls.filter((record) =>
    record.statusCode >= 200
    && record.statusCode < 400
    && record.wireCompleteness !== 'error').length;
  const tokenCoverage: T.AgentUsageSummary['tokenCoverage'] = reported.length === 0
    ? 'unavailable'
    : reported.length === modelCalls.length
      && reported.every((record) => record.usage?.completeness === 'complete')
      ? 'complete'
      : 'partial';
  const sum = (select: (usage: T.AgentInteractionTokenUsage) => number | undefined) =>
    reported.reduce((total, record) => total + (record.usage ? select(record.usage) ?? 0 : 0), 0);
  return {
    modelCallCount: modelCalls.length,
    successfulModelCallCount,
    failedModelCallCount: modelCalls.length - successfulModelCallCount,
    tokenReportedModelCallCount: reported.length,
    tokenCoverage,
    inputTokens: sum((usage) => usage.inputTokens),
    outputTokens: sum((usage) => usage.outputTokens),
    totalTokens: sum((usage) => usage.totalTokens),
    cachedInputTokens: sum((usage) => usage.cachedInputTokens),
    cacheCreationInputTokens: sum((usage) => usage.cacheCreationInputTokens),
    reasoningOutputTokens: sum((usage) => usage.reasoningOutputTokens),
    totalDurationMs,
    averageDurationMs: totalDurationMs / modelCalls.length,
  };
}

export function rollupAgentUsageSummaries(
  summaries: readonly T.AgentUsageSummary[],
): T.AgentUsageSummary {
  const nonEmpty = summaries.filter((summary) => summary.modelCallCount > 0);
  if (nonEmpty.length === 0) return emptyAgentUsageSummary();
  const sum = (select: (summary: T.AgentUsageSummary) => number) =>
    nonEmpty.reduce((total, summary) => total + select(summary), 0);
  const modelCallCount = sum((summary) => summary.modelCallCount);
  const tokenReportedModelCallCount = sum((summary) => summary.tokenReportedModelCallCount);
  const totalDurationMs = sum((summary) => summary.totalDurationMs);
  return {
    modelCallCount,
    successfulModelCallCount: sum((summary) => summary.successfulModelCallCount),
    failedModelCallCount: sum((summary) => summary.failedModelCallCount),
    tokenReportedModelCallCount,
    tokenCoverage: tokenReportedModelCallCount === 0
      ? 'unavailable'
      : tokenReportedModelCallCount === modelCallCount
        && nonEmpty.every((summary) => summary.tokenCoverage === 'complete')
        ? 'complete'
        : 'partial',
    inputTokens: sum((summary) => summary.inputTokens),
    outputTokens: sum((summary) => summary.outputTokens),
    totalTokens: sum((summary) => summary.totalTokens),
    cachedInputTokens: sum((summary) => summary.cachedInputTokens),
    cacheCreationInputTokens: sum((summary) => summary.cacheCreationInputTokens),
    reasoningOutputTokens: sum((summary) => summary.reasoningOutputTokens),
    totalDurationMs,
    averageDurationMs: totalDurationMs / modelCallCount,
  };
}

function summarizeInstanceUsage(
  records: readonly T.AgentInteractionRecord[],
): T.AgentInstanceUsageSummary[] {
  const byInstance = new Map<string, T.AgentInteractionRecord[]>();
  for (const record of records) {
    if (!record.agentInstanceId) continue;
    const instance = byInstance.get(record.agentInstanceId) ?? [];
    instance.push(record);
    byInstance.set(record.agentInstanceId, instance);
  }
  return [...byInstance.entries()].map(([agentInstanceId, interactions]) => ({
    agentInstanceId,
    ...summarizeAgentUsage(interactions),
  }));
}

function summaryForConversation(
  conversationId: string,
  source: 'provider' | 'runtime' | 'inferred',
  records: T.AgentInteractionRecord[],
  asset?: T.AgentInventoryItem,
): T.AgentConversationSummary {
  const interactions = annotateTurns(conversationId, records);
  const first = interactions[0];
  const last = interactions.at(-1) ?? first;
  const turnIds = new Set(interactions.map((item) => item.turnId).filter(Boolean));
  const instanceIds = [...new Set(interactions
    .map((item) => item.agentInstanceId)
    .filter((value): value is string => Boolean(value)))];
  const agentProduct = displayProduct(
    first.agentProduct ?? asset?.agentProduct ?? asset?.detectedName,
  ) ?? 'Agent';
  const resolvedResults = resolvedToolResultIds(interactions);
  const unknownResults = unknownToolResultIds(interactions);
  const failedToolResults = interactions.reduce((count, item) =>
    count + item.toolResults.filter((result) => result.isError === true).length, 0);
  const usage = summarizeAgentUsage(interactions);
  const coverage = conversationCoverage(interactions);
  const firstLogical = interactions.find((item) => item.logicalAgentId)?.logicalAgentId;
  const firstCandidate = interactions.find((item) => item.logicalAgentCandidateId)?.logicalAgentCandidateId;
  const terminalContextIds = [...new Set(interactions
    .map((item) => item.terminalContextId)
    .filter((value): value is string => Boolean(value)))];
  const quality = interactions.some((item) => item.sessionIdentityQuality === 'confirmed')
    ? 'confirmed' as const
    : interactions.some((item) => item.sessionIdentityQuality === 'strong')
      ? 'strong' as const
      : interactions.some((item) => item.sessionIdentityQuality === 'ephemeral')
        ? 'ephemeral' as const
        : interactions.some((item) => item.sessionIdentityQuality === 'inferred')
          ? 'inferred' as const
          : undefined;
  const sessionId = interactions.find((item) => Boolean(item.sessionId))?.sessionId;
  const parentRecord = interactions.find((item) => Boolean(item.canonicalParentSessionId || item.parentSessionId));
  const sessionLifecycle = interactions.some((item) => item.sessionLifecycle === 'fork')
    ? 'fork' as const
    : interactions.some((item) => item.sessionLifecycle === 'resume')
      ? 'resume' as const
      : interactions.some((item) => item.sessionLifecycle === 'new')
        ? 'new' as const
        : undefined;
  return {
    conversationId,
    idSource: source,
    ...(first.tenantId ? { tenantId: first.tenantId } : {}),
    ...(first.ownerId ? { ownerId: first.ownerId } : {}),
    ...(firstLogical ? { logicalAgentId: firstLogical } : {}),
    ...(firstCandidate ? { logicalAgentCandidateId: firstCandidate } : {}),
    ...(first.logicalDefinitionId ? { logicalDefinitionId: first.logicalDefinitionId } : {}),
    ...(first.logicalScopeMode ? { logicalScopeMode: first.logicalScopeMode } : {}),
    ...(first.logicalIdentityAuthority ? { logicalIdentityAuthority: first.logicalIdentityAuthority } : {}),
    ...(first.logicalDefinitionFingerprint ? { logicalDefinitionFingerprint: first.logicalDefinitionFingerprint } : {}),
    ...(first.profile ? { profile: first.profile } : {}),
    ...(first.profileVersion ? { profileVersion: first.profileVersion } : {}),
    ...(first.deploymentId ? { deploymentId: first.deploymentId } : {}),
    ...(first.deploymentRevision ? { deploymentRevision: first.deploymentRevision } : {}),
    ...(first.environmentId ? { environmentId: first.environmentId } : {}),
    ...(terminalContextIds.length ? { terminalContextIds } : {}),
    ...(quality ? { sessionIdentityQuality: quality } : {}),
    ...(first.sessionMode ? { sessionMode: first.sessionMode } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(first.sessionKey ? { sessionKey: first.sessionKey } : {}),
    ...(first.providerSessionIdHash ? { providerSessionIdHash: first.providerSessionIdHash } : {}),
    ...(sessionLifecycle ? { sessionLifecycle } : {}),
    ...(parentRecord?.parentSessionId ? { parentSessionId: parentRecord.parentSessionId } : {}),
    ...(parentRecord?.canonicalParentSessionId
      ? { canonicalParentSessionId: parentRecord.canonicalParentSessionId }
      : {}),
    hasContent: true,
    agentAssetId: first.agentAssetId,
    agentAssetIds: [...new Set(interactions
      .map((item) => item.agentAssetId)
      .filter((value): value is string => Boolean(value)))].slice(0, 256),
    agentInstanceIds: instanceIds,
    agentProduct,
    displayName: displayProduct(asset?.displayName) ?? asset?.displayName ?? agentProduct,
    environment: interactionEnvironment(first, asset),
    classification: first.currentEffectiveClassification,
    workspacePath: first.workspacePath,
    startedAtUnixNs: first.startedAtUnixNs,
    lastActivityAtUnixNs: last.endedAtUnixNs,
    firstPromptPreview: firstPromptPreview(first),
    turnCount: turnIds.size,
    modelCallCount: usage.modelCallCount,
    toolCallCount: uniqueToolItemCount(interactions, 'call'),
    toolResultCount: uniqueToolItemCount(interactions, 'result'),
    errorCount: interactions.filter((item) =>
      item.statusCode >= 400
      || !effectiveInteractionState(item, resolvedResults, unknownResults).complete).length
      + failedToolResults,
    models: [...new Set(interactions
      .map((item) => item.model)
      .filter((value): value is string => Boolean(value)))],
    usage,
    instanceUsage: summarizeInstanceUsage(interactions),
    coverage,
    coverageLayers: observabilityCoverageLayers(interactions, [], coverage),
  };
}

function assetOnlySummary(
  asset: T.AgentInventoryItem,
  evidence: T.AgentInteractionRecord[] = [],
): T.AgentConversationSummary {
  const coverage = conversationCoverage(evidence);
  return {
    conversationId: stableId('asset', `asset-only\u0000${asset.agentAssetId}`),
    idSource: 'inferred',
    ...(asset.tenantId ? { tenantId: asset.tenantId } : {}),
    ...(asset.ownerId ? { ownerId: asset.ownerId } : {}),
    ...(asset.logicalAgentId ? { logicalAgentId: asset.logicalAgentId } : {}),
    ...(asset.logicalDefinitionId ? { logicalDefinitionId: asset.logicalDefinitionId } : {}),
    ...(asset.logicalScopeMode ? { logicalScopeMode: asset.logicalScopeMode } : {}),
    ...(asset.logicalIdentityAuthority ? { logicalIdentityAuthority: asset.logicalIdentityAuthority } : {}),
    ...(asset.profile ? { profile: asset.profile } : {}),
    ...(asset.profileVersion ? { profileVersion: asset.profileVersion } : {}),
    ...(asset.deploymentId ? { deploymentId: asset.deploymentId } : {}),
    ...(asset.deploymentRevision ? { deploymentRevision: asset.deploymentRevision } : {}),
    ...(asset.terminalContextId ? { terminalContextIds: [asset.terminalContextId] } : {}),
    hasContent: false,
    agentAssetId: asset.agentAssetId,
    agentAssetIds: [asset.agentAssetId],
    agentInstanceIds: asset.agentInstanceId ? [asset.agentInstanceId] : [],
    agentProduct: asset.agentProduct ?? asset.detectedName ?? asset.agentId,
    displayName: asset.displayName ?? asset.agentProduct ?? asset.detectedName ?? asset.agentId,
    environment: asset.runtime,
    classification: asset.classification,
    workspacePath: asset.workspacePath,
    lastActivityAtUnixNs: (BigInt(Date.parse(asset.lastSeen)) * 1_000_000n).toString(),
    firstPromptPreview: evidence.length
      ? '已观察到 Agent 明文流，但 transport 或 wire template 尚未解析。'
      : 'Agent 资产已识别，但当前时间范围没有可读取的模型明文交互。',
    turnCount: 0,
    modelCallCount: 0,
    toolCallCount: 0,
    toolResultCount: 0,
    errorCount: 0,
    models: [],
    usage: emptyAgentUsageSummary(),
    instanceUsage: [],
    coverage,
    coverageLayers: observabilityCoverageLayers(evidence, [], coverage),
  };
}

function summaryMatches(
  summary: T.AgentConversationSummary,
  query: T.AgentConversationQuery,
): boolean {
  if (query.agentAssetId
    && summary.agentAssetId !== query.agentAssetId
    && !summary.agentAssetIds?.includes(query.agentAssetId)) return false;
  if (query.agentInstanceId && !summary.agentInstanceIds.includes(query.agentInstanceId)) return false;
  if (query.conversationId && summary.conversationId !== query.conversationId) return false;
  if (query.product && !normalized(summary.agentProduct).includes(normalized(query.product))) return false;
  if (query.classification && summary.classification !== query.classification) return false;
  if (query.coverageStatus && summary.coverage.status !== query.coverageStatus) return false;
  if (query.model && !summary.models.includes(query.model)) return false;
  if (query.q) {
    const needle = normalized(query.q);
    const haystack = normalized([
      summary.agentProduct,
      summary.displayName,
      summary.workspacePath,
      summary.firstPromptPreview ?? '',
      ...summary.models,
    ].join(' '));
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

export function projectAgentConversations(
  interactions: T.AgentInteractionRecord[],
  assets: T.AgentInventoryItem[],
  query: T.AgentConversationQuery,
): AgentConversationProjection {
  const assetsById = new Map(assets.map((asset) => [asset.agentAssetId, asset]));
  const evidenceByAsset = new Map<string, T.AgentInteractionRecord[]>();
  const semanticInteractions = interactions.filter((record) => {
    if (record.interactionType !== 'unparsed') return true;
    const evidence = evidenceByAsset.get(record.agentAssetId) ?? [];
    evidence.push(record);
    evidenceByAsset.set(record.agentAssetId, evidence);
    return false;
  }).filter((record) => query.includeBackground
    || ['conversation', 'context_replay'].includes(trafficRoleForInteraction(record)));
  const grouped = new Map<string, {
    source: 'provider' | 'runtime' | 'inferred';
    records: T.AgentInteractionRecord[];
    conversationId: string;
    scopeKey: string;
  }>();
  // A provider/legacy conversation ID is not globally unique.  Keep the historical ID when it
  // occurs in one logical scope (compatibility), but derive a deterministic scoped projection for
  // collisions so two tenants/definitions can never be rendered as one conversation.  The raw ID
  // remains in each Interaction as an alias/provenance field.
  const explicitScopes = new Map<string, Set<string>>();
  const explicitGroups: Array<{
    key: string;
    conversationId: string;
    source: 'provider' | 'runtime' | 'inferred';
    scopeKey: string;
    record: T.AgentInteractionRecord;
  }> = [];
  const inferredByRoot = new Map<string, T.AgentInteractionRecord[]>();
  const inferredClusters: Array<{ root: string; records: T.AgentInteractionRecord[] }> = [];
  const providerChains = providerResponseChains(semanticInteractions);

  for (const record of [...semanticInteractions].sort(compareInteraction)) {
    const explicit = explicitConversation(record, providerChains);
    if (explicit) {
      const key = `${explicit.conversationId}\u0000${explicit.scopeKey}`;
      const scopes = explicitScopes.get(explicit.conversationId) ?? new Set<string>();
      scopes.add(explicit.scopeKey);
      explicitScopes.set(explicit.conversationId, scopes);
      explicitGroups.push({
        key,
        conversationId: explicit.conversationId,
        source: explicit.source,
        scopeKey: explicit.scopeKey,
        record,
      });
      continue;
    }
    const key = rootIdentity(record);
    const records = inferredByRoot.get(key) ?? [];
    records.push(record);
    inferredByRoot.set(key, records);
  }

  for (const group of explicitGroups) {
    const collision = (explicitScopes.get(group.conversationId)?.size ?? 0) > 1;
    const projectedConversationId = collision
      ? stableId('cv', `scoped-explicit\u0000${group.scopeKey}\u0000${group.conversationId}`)
      : group.conversationId;
    const current = grouped.get(group.key) ?? {
      source: group.source,
      records: [],
      conversationId: projectedConversationId,
      scopeKey: group.scopeKey,
    };
    current.records.push(group.record);
    // A single scoped group can receive provider-chain and legacy records with different source
    // labels; retain the strongest source for the summary without changing the scope fence.
    if (group.source === 'provider') current.source = 'provider';
    else if (group.source === 'runtime' && current.source === 'inferred') current.source = 'runtime';
    grouped.set(group.key, current);
  }

  for (const [root, records] of inferredByRoot) {
    let cluster: T.AgentInteractionRecord[] = [];
    const flush = () => {
      if (cluster.length === 0) return;
      inferredClusters.push({ root, records: cluster });
      cluster = [];
    };
    for (const record of records.sort(compareInteraction)) {
      if (cluster.length > 0 && !continuesInferredConversation(cluster, record)) flush();
      cluster.push(record);
    }
    flush();
  }

  const inferredThreads: Array<{
    root: string;
    scope: string;
    records: T.AgentInteractionRecord[];
  }> = [];
  for (const cluster of inferredClusters.sort((left, right) =>
    compareInteraction(left.records[0], right.records[0]))) {
    const scope = inferredThreadScope(cluster.records[0]);
    const candidate = inferredThreads
      .filter((thread) => thread.scope === scope && thread.root !== cluster.root)
      .filter((thread) => clusterContinuesPriorThread(thread.records, cluster.records))
      .sort((left, right) =>
        userMessageLineage(right.records.at(-1)!).length
        - userMessageLineage(left.records.at(-1)!).length)[0];
    if (candidate) {
      candidate.records.push(...cluster.records);
    } else {
      inferredThreads.push({ root: cluster.root, scope, records: [...cluster.records] });
    }
  }
  for (const thread of inferredThreads) {
    const conversationId = stableId(
      'cv',
      `inferred\u0000${thread.root}\u0000${thread.records[0].interactionId}`,
    );
    grouped.set(conversationId, {
      source: 'inferred',
      records: thread.records,
      conversationId,
      scopeKey: thread.scope,
    });
  }
  coalesceScopeRunSessionGroups(grouped);

  const interactionsByConversation = new Map<string, T.AgentInteractionRecord[]>();
  const sourceInteractionsByConversation = new Map<string, T.AgentInteractionRecord[]>();
  const summaries: T.AgentConversationSummary[] = [];
  const assetsWithContent = new Set<string>();
  for (const [, group] of grouped) {
    const conversationId = group.conversationId;
    sourceInteractionsByConversation.set(
      conversationId,
      annotateTurns(conversationId, group.records),
    );
    const projected = annotateTurns(
      conversationId,
      deduplicateToolEvidence(
        projectInteractionsWithReconstructedHistoryToolCalls(group.records),
      ),
    );
    interactionsByConversation.set(conversationId, projected);
    const summary = summaryForConversation(
      conversationId,
      group.source,
      projected,
      assetsById.get(projected[0].agentAssetId),
    );
    assetsWithContent.add(summary.agentAssetId);
    summaries.push(summary);
  }
  for (const asset of assets) {
    if (!assetsWithContent.has(asset.agentAssetId)) {
      summaries.push(assetOnlySummary(asset, evidenceByAsset.get(asset.agentAssetId)));
    }
  }

  attachRelatedConversations(summaries, interactionsByConversation);

  const visible = summaries
    .filter((summary) => summaryMatches(summary, query))
    .sort((left, right) => {
      const leftAt = left.lastActivityAtUnixNs ? BigInt(left.lastActivityAtUnixNs) : 0n;
      const rightAt = right.lastActivityAtUnixNs ? BigInt(right.lastActivityAtUnixNs) : 0n;
      return leftAt === rightAt
        ? left.conversationId.localeCompare(right.conversationId)
        : leftAt > rightAt ? -1 : 1;
    });

  return { summaries: visible, interactionsByConversation, sourceInteractionsByConversation };
}

function parseEndpointPeer(endpoint: string | undefined): { host?: string; port?: number } | undefined {
  const raw = endpoint?.trim();
  if (!raw) return undefined;
  try {
    const url = raw.includes('://') ? new URL(raw) : new URL(`http://${raw}`);
    const host = url.hostname || undefined;
    const port = url.port ? Number(url.port) : undefined;
    if (!host && port === undefined) return undefined;
    return {
      ...(host ? { host } : {}),
      ...(port !== undefined && Number.isFinite(port) ? { port } : {}),
    };
  } catch {
    const match = raw.match(/^([^:/]+)(?::(\d+))?/u);
    if (!match) return undefined;
    return {
      host: match[1],
      ...(match[2] ? { port: Number(match[2]) } : {}),
    };
  }
}

function conversationHopRole(
  records: readonly T.AgentInteractionRecord[],
): 'orchestrator' | 'worker' | 'unknown' {
  // Protocol roles only: outbound Agent RPC vs inbound child. Hop token strings are
  // opaque fences and must not be compared to product names.
  if (records.some((item) => item.interactionType === 'remote_agent' || item.trafficRole === 'delegation')) {
    return 'orchestrator';
  }
  if (records.some((item) => Boolean(item.parentSessionId || item.delegationId))) return 'worker';
  return 'unknown';
}

function attachRelatedConversations(
  summaries: T.AgentConversationSummary[],
  interactionsByConversation: Map<string, T.AgentInteractionRecord[]>,
): void {
  type RunMember = {
    conversationId: string;
    agentAssetId: string;
    role: 'orchestrator' | 'worker' | 'unknown';
    runId: string;
    delegationId?: string;
    parentSessionId?: string;
    hop?: string;
    workflowNode?: string;
    peer?: { host?: string; port?: number };
  };
  const byRun = new Map<string, RunMember[]>();
  for (const summary of summaries) {
    if (!summary.hasContent) continue;
    const records = interactionsByConversation.get(summary.conversationId) ?? [];
    const role = conversationHopRole(records);
    const runIds = [...new Set(records
      .map((item) => item.runId?.trim())
      .filter((value): value is string => Boolean(value)))];
    for (const runId of runIds) {
      const scoped = records.filter((item) => item.runId === runId);
      const delegationId = scoped.find((item) => item.delegationId)?.delegationId;
      const parentSessionId = scoped.find((item) => item.parentSessionId)?.parentSessionId;
      const hop = scoped.find((item) => item.hop)?.hop;
      const workflowNode = scoped.find((item) => item.workflowNode)?.workflowNode;
      const remote = scoped.find((item) =>
        item.interactionType === 'remote_agent' || item.trafficRole === 'delegation');
      const peer = parseEndpointPeer(remote?.endpoint);
      const members = byRun.get(runId) ?? [];
      members.push({
        conversationId: summary.conversationId,
        agentAssetId: summary.agentAssetId,
        role,
        runId,
        ...(delegationId ? { delegationId } : {}),
        ...(parentSessionId ? { parentSessionId } : {}),
        ...(hop ? { hop } : {}),
        ...(workflowNode ? { workflowNode } : {}),
        ...(peer ? { peer } : {}),
      });
      byRun.set(runId, members);
    }
  }

  const relatedByConversation = new Map<string, T.AgentRelatedConversation[]>();
  for (const members of byRun.values()) {
    for (let i = 0; i < members.length; i += 1) {
      for (let j = i + 1; j < members.length; j += 1) {
        const left = members[i]!;
        const right = members[j]!;
        if (left.conversationId === right.conversationId) continue;
        // Prefer distinct assets; when Docker cgroup attribution collapses to one host-root
        // asset, still link cross-hop peers distinguished by hop / agentIdHeader roles.
        const distinctPeer = left.agentAssetId !== right.agentAssetId
          || (left.role !== 'unknown' && right.role !== 'unknown' && left.role !== right.role)
          || (Boolean(left.hop) && Boolean(right.hop) && left.hop !== right.hop);
        if (!distinctPeer) continue;
        const exact = Boolean(
          (left.delegationId && left.delegationId === right.delegationId)
          || (left.parentSessionId && (
            left.parentSessionId === right.parentSessionId
            || right.role === 'worker'
          )),
        );
        const strength: T.AgentRelatedConversation['strength'] = exact ? 'exact' : 'strong';
        const link = (
          from: RunMember,
          to: RunMember,
          relation: T.AgentRelatedConversation['relation'],
        ): T.AgentRelatedConversation => ({
          conversationId: to.conversationId,
          relation,
          runId: from.runId,
          ...(from.hop ?? to.hop ? { hop: from.hop ?? to.hop } : {}),
          ...(from.workflowNode ?? to.workflowNode
            ? { workflowNode: from.workflowNode ?? to.workflowNode }
            : {}),
          ...(from.delegationId ?? to.delegationId
            ? { delegationId: from.delegationId ?? to.delegationId }
            : {}),
          peer: {
            ...(from.peer ?? to.peer ?? {}),
            agentAssetId: to.agentAssetId,
          },
          strength,
        });
        let leftRelation: T.AgentRelatedConversation['relation'] = 'same_run';
        let rightRelation: T.AgentRelatedConversation['relation'] = 'same_run';
        if (left.role === 'orchestrator' && right.role !== 'orchestrator') {
          leftRelation = 'delegates_to';
          rightRelation = 'delegated_from';
        } else if (right.role === 'orchestrator' && left.role !== 'orchestrator') {
          leftRelation = 'delegated_from';
          rightRelation = 'delegates_to';
        } else if (left.role === 'worker' && right.role !== 'worker') {
          leftRelation = 'delegated_from';
          rightRelation = 'delegates_to';
        } else if (right.role === 'worker' && left.role !== 'worker') {
          leftRelation = 'delegates_to';
          rightRelation = 'delegated_from';
        }
        const leftLinks = relatedByConversation.get(left.conversationId) ?? [];
        leftLinks.push(link(left, right, leftRelation));
        relatedByConversation.set(left.conversationId, leftLinks);
        const rightLinks = relatedByConversation.get(right.conversationId) ?? [];
        rightLinks.push(link(right, left, rightRelation));
        relatedByConversation.set(right.conversationId, rightLinks);
      }
    }
  }

  for (const summary of summaries) {
    const related = relatedByConversation.get(summary.conversationId);
    if (!related?.length) continue;
    const deduped = new Map<string, T.AgentRelatedConversation>();
    for (const item of related) {
      const key = `${item.relation}\u0000${item.conversationId}\u0000${item.runId}`;
      const previous = deduped.get(key);
      if (!previous || (previous.strength !== 'exact' && item.strength === 'exact')) {
        deduped.set(key, item);
      }
    }
    summary.relatedConversations = [...deduped.values()].slice(0, 32);
  }
}

function eventId(kind: T.AgentConversationEventKind, interactionId: string, suffix = ''): string {
  return stableId('ce', `${kind}\u0000${interactionId}\u0000${suffix}`);
}

export function projectConversationTimeline(
  conversation: T.AgentConversationSummary,
  interactions: T.AgentInteractionRecord[],
): T.AgentConversationEvent[] {
  const ordered = projectInteractionsWithReconstructedHistoryToolCalls(interactions)
    .sort(compareInteraction);
  const resolvedResults = resolvedToolResultIds(ordered);
  const unknownResults = unknownToolResultIds(ordered);
  const callEventIds = new Map<string, Array<{ eventId: string; at: bigint; interactionId: string }>>();
  for (const interaction of ordered) {
    for (const call of interaction.toolCalls) {
      let at: bigint;
      try { at = BigInt(call.issuedAtUnixNs ?? interaction.startedAtUnixNs); }
      catch { at = 0n; }
      const entries = callEventIds.get(call.toolCallId) ?? [];
      entries.push({
        eventId: eventId('tool_call', interaction.interactionId, call.toolCallId),
        at,
        interactionId: interaction.interactionId,
      });
      callEventIds.set(call.toolCallId, entries);
    }
  }
  const callEventIdFor = (toolCallId: string, resultAt?: string, interactionId?: string): string | undefined => {
    const entries = callEventIds.get(toolCallId) ?? [];
    const sameInteraction = interactionId ? entries.filter((entry) => entry.interactionId === interactionId) : entries;
    const pool = sameInteraction.length ? sameInteraction : entries;
    let at: bigint | undefined;
    try { if (resultAt) at = BigInt(resultAt); } catch { /* use latest available */ }
    return [...pool]
      .filter((entry) => at === undefined || entry.at <= at)
      .sort((left, right) => left.at === right.at ? left.eventId.localeCompare(right.eventId) : left.at > right.at ? -1 : 1)
      .at(0)?.eventId;
  };

  const attempts = new Map<string, number>();
  const pending: Array<T.AgentConversationEvent & { sortOrder: number }> = [];
  let previous: T.AgentInteractionRecord | undefined;
  for (const interaction of ordered) {
    const effectiveState = effectiveInteractionState(interaction, resolvedResults, unknownResults);
    const turnId = interaction.turnId ?? `${conversation.conversationId}:turn:1`;
    const modelCallId = interaction.modelCallId ?? stableId('mc', interaction.interactionId);
    const attemptNumber = (attempts.get(modelCallId) ?? 0) + 1;
    attempts.set(modelCallId, attemptNumber);
    const quality = interaction.correlationQuality ?? 'inferred';
    const common = {
      turnId,
      modelCallId,
      attemptId: interaction.attemptId ?? `${modelCallId}:attempt:${attemptNumber}`,
      interactionId: interaction.interactionId,
      completeness: effectiveState.complete ? 'complete' : interaction.completeness,
      correlationQuality: quality,
      evidenceEventIds: [] as string[],
    };

    if (interaction.interactionType === 'tool') {
      pending.push({
        ...common,
        eventId: eventId('external_tool', interaction.interactionId),
        kind: 'external_tool',
        sequence: 0,
        sortOrder: 20,
        atUnixNs: interaction.startedAtUnixNs,
        title: `${interaction.method} ${interaction.path}`,
        contentPreview: jsonPreview(interaction.response.text ?? interaction.response.structured),
        arguments: interaction.request.structured ?? interaction.request.body,
        result: interaction.response.structured ?? interaction.response.text ?? interaction.response.body,
        isError: interaction.statusCode >= 400,
        statusCode: interaction.statusCode,
        durationNs: interaction.durationNs,
      });
      previous = interaction;
      continue;
    }

    if (attemptNumber > 1) {
      pending.push({
        ...common,
        eventId: eventId('retry', interaction.interactionId, String(attemptNumber)),
        kind: 'retry',
        sequence: 0,
        sortOrder: 5,
        atUnixNs: interaction.startedAtUnixNs,
        title: `模型调用重试 · Attempt ${attemptNumber}`,
        attemptNumber,
      });
    }

    for (const result of interaction.toolResults) {
      pending.push({
        ...common,
        eventId: eventId('tool_result', interaction.interactionId, result.toolCallId),
        kind: 'tool_result',
        sequence: 0,
        sortOrder: 10,
        // A tool result embedded in the next model request necessarily existed before that HTTP
        // request started. The observer's raw `observedAtUnixNs` is the later body-complete time;
        // use request start for the Agent-facing semantic order while preserving the raw timestamp
        // on the underlying Interaction evidence.
        atUnixNs: interaction.startedAtUnixNs,
        parentEventId: callEventIdFor(result.toolCallId, result.observedAtUnixNs, interaction.interactionId),
        toolCallId: result.toolCallId,
        title: result.name ? `${result.name} 返回结果` : '工具返回结果',
        contentPreview: jsonPreview(result.content),
        toolName: result.name,
        result: result.content,
        isError: result.isError,
      });
    }

    const requestEvent = eventId('model_request', interaction.interactionId);
    pending.push({
      ...common,
      eventId: requestEvent,
      kind: 'model_request',
      sequence: 0,
      sortOrder: 20,
      atUnixNs: interaction.startedAtUnixNs,
      title: 'Agent 发送给 LLM',
      contentPreview: requestPreview(interaction, previous),
      model: interaction.model,
      statusCode: interaction.statusCode,
      durationNs: interaction.durationNs,
      attemptNumber,
    });

    const modelText = normalizedModelResponseText(interaction);
    const responseEvent = modelText
      ? eventId('model_response', interaction.interactionId)
      : undefined;
    if (modelText) {
      pending.push({
        ...common,
        eventId: responseEvent!,
        kind: 'model_response',
        sequence: 0,
        sortOrder: 30,
        atUnixNs: interaction.firstResponseAtUnixNs,
        parentEventId: requestEvent,
        title: interaction.toolCalls.length ? '模型过程说明' : '模型最终回复',
        contentPreview: jsonPreview(modelText),
        model: interaction.model,
        statusCode: interaction.statusCode,
        durationNs: interaction.durationNs,
        attemptNumber,
      });
    }

    for (const call of interaction.toolCalls) {
      pending.push({
        ...common,
        eventId: callEventIdFor(call.toolCallId, call.issuedAtUnixNs, interaction.interactionId)
          ?? eventId('tool_call', interaction.interactionId, call.toolCallId),
        kind: 'tool_call',
        sequence: 0,
        sortOrder: 40,
        atUnixNs: call.issuedAtUnixNs ?? interaction.endedAtUnixNs,
        parentEventId: responseEvent ?? requestEvent,
        toolCallId: call.toolCallId,
        title: `${call.name} 工具指令`,
        contentPreview: jsonPreview(call.arguments),
        toolName: call.name,
        arguments: call.arguments,
      });
    }

    if (interaction.statusCode >= 400 || !effectiveState.complete) {
      pending.push({
        ...common,
        eventId: eventId('error', interaction.interactionId),
        kind: 'error',
        sequence: 0,
        sortOrder: 50,
        atUnixNs: interaction.endedAtUnixNs,
        parentEventId: responseEvent ?? requestEvent,
        title: interaction.statusCode >= 400
          ? `模型调用失败 · HTTP ${interaction.statusCode}`
          : '模型交互内容不完整',
        contentPreview: effectiveState.reasons.join('、') || undefined,
        isError: true,
        statusCode: interaction.statusCode,
      });
    }
    previous = interaction;
  }

  return pending
    .sort((left, right) => {
      const leftAt = BigInt(left.atUnixNs);
      const rightAt = BigInt(right.atUnixNs);
      if (leftAt !== rightAt) return leftAt < rightAt ? -1 : 1;
      return left.sortOrder - right.sortOrder || left.eventId.localeCompare(right.eventId);
    })
    .map(({ sortOrder: _sortOrder, ...event }, index) => ({ ...event, sequence: index + 1 }));
}
