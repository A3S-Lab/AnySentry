import { createHash } from 'node:crypto';

import type * as T from './types';
import {
  humanVisibleUserContent,
  normalizedModelResponseText,
} from './agent-semantic-timeline';
import {
  interactionHumanMessages,
  trafficRoleForInteraction,
} from './agent-conversation-resolution-v2';

const PREVIEW_CHARACTERS = 320;
const GENERIC_SESSION_IDS = new Set([
  '', '-', 'none', 'null', 'unknown', 'legacy', 'default',
  'tokio-rt-worker', 'reqwest-internal', 'mainthread',
]);

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
  ].join('\u0000');
}

function explicitConversation(
  record: T.AgentInteractionRecord,
  providerChains: Map<string, string>,
): {
  conversationId: string;
  source: 'provider' | 'runtime' | 'inferred';
} | undefined {
  if (record.conversationId
    && (record.conversationIdSource !== 'inferred' || record.conversationBindingVersion)) {
    return {
      conversationId: record.conversationId,
      source: record.conversationIdSource ?? 'inferred',
    };
  }
  if (record.providerConversationId) {
    return {
      conversationId: stableId(
        'cv',
        `provider\u0000${record.agentAssetId}\u0000${record.providerConversationId}`,
      ),
      source: 'provider',
    };
  }
  const providerChain = providerChains.get(record.interactionId);
  if (providerChain) {
    return { conversationId: providerChain, source: 'provider' };
  }
  const session = conversationRuntimeSession(record);
  if (session) {
    return {
      conversationId: stableId('cv', `runtime\u0000${record.agentAssetId}\u0000${session}`),
      source: 'runtime',
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
      if (!prior || prior.agentAssetId !== record.agentAssetId) break;
      rootId = prior.providerResponseId;
      cursor = prior;
    }
    if (!rootId) continue;
    projected.set(
      record.interactionId,
      stableId('cv', `provider-response-chain\u0000${record.agentAssetId}\u0000${rootId}`),
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

function isCliAgent(record: T.AgentInteractionRecord): boolean {
  const product = normalized(record.agentProduct);
  return ['codex', 'codex-cli', 'claude', 'claude-code', 'pi', 'kimi', 'kimi-cli', 'kimi-code']
    .some((candidate) => product === candidate || product.includes(candidate));
}

function inferredThreadScope(record: T.AgentInteractionRecord): string {
  return [
    normalized(displayProduct(record.agentProduct) ?? record.agentProduct),
    normalized(record.workspacePath),
    normalized(record.process?.hostId),
  ].join('\u0000');
}

function clusterContinuesPriorThread(
  prior: T.AgentInteractionRecord[],
  current: T.AgentInteractionRecord[],
): boolean {
  const issuedCalls = new Set(prior.flatMap((record) =>
    record.toolCalls.map((call) => call.toolCallId)));
  if (current.some((record) =>
    record.toolResults.some((result) => issuedCalls.has(result.toolCallId)))) return true;
  if (!isCliAgent(current[0])) return false;
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
    const stableTurnAnchor = latestHuman?.turnId ?? latestHuman?.sourceItemId;
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
  return jsonPreview(withoutRuntimeContext || raw);
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
  const preferred = [...delta].reverse().find((message) =>
    ['user', 'developer', 'system'].includes(message.role.toLowerCase()))
    ?? [...delta].reverse().find((message) => message.role.toLowerCase() === 'tool');
  const fallback = [...messages].reverse().find((message) => message.role.toLowerCase() === 'user');
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
  return new Set(interactions.flatMap((item) =>
    item.toolResults.map((result) => result.toolCallId)));
}

function effectiveInteractionState(
  interaction: T.AgentInteractionRecord,
  resolvedResults: Set<string>,
): { complete: boolean; reasons: string[] } {
  const unresolvedToolCall = interaction.toolCalls.some((call) =>
    !resolvedResults.has(call.toolCallId));
  const reasons = interaction.partialReasons.filter((reason) =>
    reason !== 'tool_result_pending' || unresolvedToolCall);
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
  return {
    complete: (interaction.completeness === 'complete' && !unresolvedToolCall)
      || pendingResolved,
    reasons,
  };
}

function conversationCoverage(
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
  const states = interactions.map((item) => effectiveInteractionState(item, resolvedResults));
  const completeInteractions = states.filter((state) => state.complete).length;
  const partialInteractions = interactions.length - completeInteractions;
  const reasons = [...new Set(states.flatMap((state) => state.reasons))];
  let status: T.AgentConversationCoverageStatus = partialInteractions ? 'partial' : 'complete';
  if (interactions.every((item) => item.interactionType === 'unparsed')) {
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
  return {
    conversationId,
    idSource: source,
    hasContent: true,
    agentAssetId: first.agentAssetId,
    agentInstanceIds: instanceIds,
    agentProduct,
    displayName: asset?.displayName ?? agentProduct,
    environment: interactionEnvironment(first, asset),
    classification: first.currentEffectiveClassification,
    workspacePath: first.workspacePath,
    startedAtUnixNs: first.startedAtUnixNs,
    lastActivityAtUnixNs: last.endedAtUnixNs,
    firstPromptPreview: firstPromptPreview(first),
    turnCount: turnIds.size,
    modelCallCount: interactions.filter((item) => item.interactionType === 'model').length,
    toolCallCount: interactions.reduce((sum, item) => sum + item.toolCalls.length, 0),
    toolResultCount: interactions.reduce((sum, item) => sum + item.toolResults.length, 0),
    errorCount: interactions.filter((item) =>
      item.statusCode >= 400
      || !effectiveInteractionState(item, resolvedResults).complete).length,
    models: [...new Set(interactions
      .map((item) => item.model)
      .filter((value): value is string => Boolean(value)))],
    coverage: conversationCoverage(interactions),
  };
}

function assetOnlySummary(
  asset: T.AgentInventoryItem,
  evidence: T.AgentInteractionRecord[] = [],
): T.AgentConversationSummary {
  return {
    conversationId: stableId('asset', `asset-only\u0000${asset.agentAssetId}`),
    idSource: 'inferred',
    hasContent: false,
    agentAssetId: asset.agentAssetId,
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
    coverage: conversationCoverage(evidence),
  };
}

function summaryMatches(
  summary: T.AgentConversationSummary,
  query: T.AgentConversationQuery,
): boolean {
  if (query.agentAssetId && summary.agentAssetId !== query.agentAssetId) return false;
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
  }).filter((record) => ['conversation', 'context_replay'].includes(
    trafficRoleForInteraction(record),
  ));
  const grouped = new Map<string, {
    source: 'provider' | 'runtime' | 'inferred';
    records: T.AgentInteractionRecord[];
  }>();
  const inferredByRoot = new Map<string, T.AgentInteractionRecord[]>();
  const inferredClusters: Array<{ root: string; records: T.AgentInteractionRecord[] }> = [];
  const providerChains = providerResponseChains(semanticInteractions);

  for (const record of [...semanticInteractions].sort(compareInteraction)) {
    const explicit = explicitConversation(record, providerChains);
    if (explicit) {
      const group = grouped.get(explicit.conversationId) ?? {
        source: explicit.source,
        records: [],
      };
      group.records.push(record);
      grouped.set(explicit.conversationId, group);
      continue;
    }
    const key = rootIdentity(record);
    const records = inferredByRoot.get(key) ?? [];
    records.push(record);
    inferredByRoot.set(key, records);
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
    grouped.set(conversationId, { source: 'inferred', records: thread.records });
  }

  const interactionsByConversation = new Map<string, T.AgentInteractionRecord[]>();
  const sourceInteractionsByConversation = new Map<string, T.AgentInteractionRecord[]>();
  const summaries: T.AgentConversationSummary[] = [];
  const assetsWithContent = new Set<string>();
  for (const [conversationId, group] of grouped) {
    sourceInteractionsByConversation.set(
      conversationId,
      annotateTurns(conversationId, group.records),
    );
    const projected = annotateTurns(
      conversationId,
      deduplicateToolEvidence(group.records),
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

function eventId(kind: T.AgentConversationEventKind, interactionId: string, suffix = ''): string {
  return stableId('ce', `${kind}\u0000${interactionId}\u0000${suffix}`);
}

export function projectConversationTimeline(
  conversation: T.AgentConversationSummary,
  interactions: T.AgentInteractionRecord[],
): T.AgentConversationEvent[] {
  const ordered = [...interactions].sort(compareInteraction);
  const resolvedResults = resolvedToolResultIds(ordered);
  const callEventIds = new Map<string, string>();
  for (const interaction of ordered) {
    for (const call of interaction.toolCalls) {
      callEventIds.set(call.toolCallId, eventId('tool_call', interaction.interactionId, call.toolCallId));
    }
  }

  const attempts = new Map<string, number>();
  const pending: Array<T.AgentConversationEvent & { sortOrder: number }> = [];
  let previous: T.AgentInteractionRecord | undefined;
  for (const interaction of ordered) {
    const effectiveState = effectiveInteractionState(interaction, resolvedResults);
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
        parentEventId: callEventIds.get(result.toolCallId),
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
        eventId: callEventIds.get(call.toolCallId)
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
