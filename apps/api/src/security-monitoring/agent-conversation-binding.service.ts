import { Injectable, OnModuleDestroy, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';

import type * as T from './types';
import type { AgentConversationProjection } from './agent-conversation';
import { humanVisibleUserContent } from './agent-semantic-timeline';
import {
  AGENT_CONVERSATION_RESOLVER_V2,
  type ConversationMembershipV2,
  type ConversationMembershipRole,
  type ConversationResolutionV2,
  type ConversationRouteAliasV1,
  type TechnicalActivityProjection,
  conversationAnchorsForInteraction,
  conversationLogicalScopeKeyV2,
  conversationDeploymentScopeKey,
  trafficRoleForInteraction,
  resolveAgentConversationsV2,
} from './agent-conversation-resolution-v2';
import { canonicalParentSessionIdForMembership, canonicalSessionIdForMembership } from './canonical-observability';
import {
  RelationalBusinessStore,
  type AgentConversationInteractionMembershipSlice,
} from './relational-business-store.service';
import { CanonicalObservabilityService } from './canonical-observability.service';

export const AGENT_CONVERSATION_RESOLVER_VERSION = AGENT_CONVERSATION_RESOLVER_V2;
const CANONICAL_SESSION_REVISION_MAX = Number.MAX_SAFE_INTEGER;
const V2_PERSIST_MAX_ANCHORS = 50_000;
const V2_PERSIST_MAX_MEMBERSHIPS = 20_000;
const V2_PERSIST_MAX_ALIASES = 20_000;
const V2_PERSIST_MAX_TECHNICAL = 20_000;
const V2_PERSIST_MAX_CATEGORY_BYTES = 16 * 1024 * 1024;

export interface AgentConversationInteractionSelection
  extends AgentConversationInteractionMembershipSlice {
  durable: boolean;
}

function normalized(value?: string): string {
  return value?.trim().toLowerCase().replace(/\s+/gu, ' ') ?? '';
}

function stableId(prefix: string, value: string): string {
  return `${prefix}_${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
}

function userLineage(record: T.AgentInteractionRecord): string[] {
  return (record.request.messages ?? [])
    .filter((message) => ['user', 'human'].includes(message.role.toLowerCase()))
    .map((message) => humanVisibleUserContent(message.content))
    .filter((content) => content !== undefined)
    .map((content) => createHash('sha256').update(canonicalJson(content)).digest('hex'));
}

function properPrefix(left: string[], right: string[]): boolean {
  return left.length > 0
    && left.length < right.length
    && left.every((value, index) => value === right[index]);
}

function equalLineage(left: string[], right: string[]): boolean {
  return left.length > 0
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

export function conversationLogicalScopeKey(record: T.AgentInteractionRecord): string {
  const logical = conversationLogicalScopeKeyV2(record);
  const deployment = conversationDeploymentScopeKey(record);
  // PostgreSQL TEXT/JSONB cannot contain a NUL byte. Keep the deployment fence opaque and
  // storage-safe while retaining the base logical scope for compatibility checks below.
  return deployment ? `${logical}|deployment:${deployment}` : logical;
}

function compareInteraction(left: T.AgentInteractionRecord, right: T.AgentInteractionRecord): number {
  return left.at - right.at || left.interactionId.localeCompare(right.interactionId);
}

function threadRank(source: T.AgentConversationThreadRecord['idSource']): number {
  return source === 'provider' ? 3 : source === 'runtime' ? 2 : 1;
}

function syntheticWorkspace(value?: string): boolean {
  const workspace = value?.trim().replace(/\/+$/u, '') ?? '';
  return !workspace
    || workspace === 'workspace:unknown'
    || workspace.startsWith('agent://')
    || workspace.startsWith('agent-scope:');
}

function applicationScopeMode(value?: string): boolean {
  return value === 'workflow_definition' || value === 'service_definition';
}

function canonicalScopeMode(value?: string): boolean {
  return Boolean(value) && value !== 'unresolved';
}

const SESSION_MEMBERSHIP_TRAFFIC_ROLES = new Set<ConversationMembershipRole>([
  'conversation', 'bootstrap', 'control', 'context_replay', 'tool_backend',
  'derived_metadata', 'retry', 'background', 'unclassified',
]);
const TOOL_EXEC_EVENT_KINDS = new Set(['toolexec', 'exec', 'command', 'tool']);
const SEMANTIC_TOOL_EVENT_KINDS = new Set([
  'agenttool', 'toolcall', 'functioncall', 'executetool', 'toolresult',
  'functionresult', 'agenttoolresult',
]);
const EXECUTION_BACKGROUND_EVENT_KINDS = new Set([
  'agentinvocation', 'invokeagent', 'workflowrun', 'agentrun',
  'noderun', 'node', 'workflownode',
]);

// Kernel facts are supporting evidence, not human Conversation objects.  In particular, a
// ToolExec/ProcessExit/File/Egress row must not mint an event-scoped Session merely because the
// legacy Judge populated a fallback sessionId.  Keep this list product-neutral and conservative;
// semantic/application records can still opt in through the explicit sets or stable anchors below.
const KERNEL_ONLY_EVENT_KINDS = new Set([
  'exec', 'processexec', 'process_exec', 'fork', 'processfork', 'process_fork',
  'exit', 'processexit', 'process_exit', 'toolexec', 'tool_exec', 'tool',
  'file', 'fileaccess', 'file_access', 'filedelete', 'file_delete',
  'egress', 'dns', 'tls', 'sslcontent', 'ssl_content', 'securityaction', 'security_action',
  'connection', 'network', 'runtimeevent', 'runtime_event', 'systemcontext', 'system_context',
  'collectorheartbeat', 'collector_heartbeat', 'heartbeat',
]);

export function eventMembershipEligible(event: Pick<T.JudgedEvent,
  'eventKind' | 'sessionId' | 'sessionKey' | 'canonicalSessionId' | 'sessionIdSource'
  | 'turnId' | 'runId' | 'toolCallId' | 'eventCategory' | 'attributes'>): boolean {
  const normalizedKind = event.eventKind.trim().toLowerCase().replace(/[\s.-]+/gu, '_');
  const compactKind = normalizedKind.replace(/[_:/]+/gu, '');
  const semanticToolHint = event.eventCategory?.toLowerCase() === 'tool'
    || Boolean(event.toolCallId)
    || Boolean(event.attributes && [
      'gen_ai.tool.name', 'gen_ai.tool.call.id', 'tool_call.id', 'tool.name',
    ].some((key) => event.attributes?.[key] !== undefined));
  if ((KERNEL_ONLY_EVENT_KINDS.has(normalizedKind) || KERNEL_ONLY_EVENT_KINDS.has(compactKind))
    && !(semanticToolHint && ['tool', 'exec', 'command'].includes(compactKind))) return false;
  if (SEMANTIC_TOOL_EVENT_KINDS.has(compactKind)
    || EXECUTION_BACKGROUND_EVENT_KINDS.has(compactKind)
    || LLM_EVENT_KINDS.has(compactKind)
    || MESSAGE_EVENT_KINDS.has(compactKind)) return true;
  // Preserve unknown/pre-canonical events when they carry the legacy Session or another explicit
  // anchor. This is the compatibility fallback: we cannot safely infer that an unknown kind is a
  // kernel fact, so only the explicit product-neutral kernel allow-list above is blocked. Events
  // with no identity/anchor stay out of the canonical Session lane and remain KernelFact/Coverage
  // evidence at ingest.
  return Boolean(
    event.canonicalSessionId
    || event.sessionKey
    || event.turnId
    || event.toolCallId
    || event.runId
    || (event.sessionId && event.sessionIdSource !== 'per_request'),
  );
}
const LLM_EVENT_KINDS = new Set([
  'llmapi', 'llm_api', 'llmcall', 'llm_call', 'llminteraction', 'llm_interaction',
  'llmresponse', 'llm_response', 'llm', 'modelresponse', 'model_response',
]);
const MESSAGE_EVENT_KINDS = new Set([
  'usermessage', 'userinput', 'humanmessage', 'inputmessage',
  'modelmessage', 'assistantmessage', 'assistantoutput', 'finalresponse',
]);
const TECHNICAL_EVENT_KINDS = new Set([
  'runtimeevent', 'runtime_event', 'processexit', 'process_exit', 'processfork', 'process_fork',
  'fileaccess', 'file_access', 'filedelete', 'file_delete', 'egress', 'dns', 'tls', 'sslcontent',
  'securityaction', 'security_action', 'systemcontext', 'system_context', 'connection', 'network',
]);
const SEMANTIC_CONTENT_ATTRIBUTE_KEYS = [
  'anysentry.content',
  'gen_ai.prompt',
  'gen_ai.completion',
  'gen_ai.input.messages',
  'gen_ai.output.messages',
  'user.message',
  'tool_call.id',
  'gen_ai.tool.call.id',
];

/**
 * Resolve the traffic lane for a durable JudgedEvent membership.
 *
 * Generic/application events reach this service when no legacy AgentInteraction parser was able
 * to claim them.  The old fallback used an unbounded tool-name substring match, which made
 * semantic `AgentTool`/`ToolResult` records look like kernel ToolExec activity and also treated
 * model/run bookkeeping as human conversation.  Keep the compatibility aliases (`tool`, `exec`, etc.) but
 * classify canonical semantic kinds by exact normalized identity.  Adapter-provided role metadata
 * remains the highest-authority override; no product or version names are involved here.
 */
export function trafficRoleForEvent(event: Pick<
  T.JudgedEvent,
  | 'eventKind'
  | 'attributes'
  | 'activityContext'
  | 'runId'
  | 'runIdSource'
  | 'turnId'
  | 'sessionKey'
  | 'sessionIdentityQuality'
  | 'sessionIdSource'
  | 'canonicalSessionId'
  | 'eventCategory'
  | 'toolCallId'
>): ConversationMembershipRole {
  const attributes = event.attributes ?? {};
  const attributeText = (...keys: string[]): string => {
    for (const key of keys) {
      const value = attributes[key];
      if (typeof value !== 'string') continue;
      const normalized = value.trim().toLowerCase();
      if (normalized) return normalized;
    }
    return '';
  };
  const explicitRole = attributeText(
    'anysentry.traffic.role',
    'traffic.role',
    'agent.traffic.role',
  );
  if (SESSION_MEMBERSHIP_TRAFFIC_ROLES.has(explicitRole as ConversationMembershipRole)) {
    return explicitRole as ConversationMembershipRole;
  }

  const normalizedKind = event.eventKind.trim().toLowerCase().replace(/[\s.-]+/gu, '_');
  const compactKind = normalizedKind.replace(/[_:/]+/gu, '');
  const operation = attributeText(
    'gen_ai.operation.name',
    'rpc.method',
    'http.route',
    'operation.name',
  );
  const controlPattern = /(?:^|[/:.])(?:initialize|initialized|ping|tools?\/list|list_tools|resources?(?:\/templates)?\/list|prompts\/list|completion\/complete|logging\/setlevel|capabilit(?:y|ies))(?:$|[/:.?])/u;
  const bootstrapPattern = /bootstrap|system[_ -]?context|developer[_ -]?context/u;
  const metadataPattern = /title|summar(?:y|ize)|derived[_ -]?metadata/u;
  const retryPattern = /(?:^|[/:._-])retry(?:$|[/:._-])/u;
  const backgroundPattern = /(?:^|[/:._-])(?:heartbeat|healthcheck|telemetry|metrics?|poll)(?:$|[/:._-])/u;

  // Healthcheck/heartbeat events stay technical and never enter the human lane.  A genuine
  // ToolExec remains the sole automatic `tool_backend` mapping (unless an explicit role override
  // above was supplied), even if a producer attaches a generic operation name.
  if (event.activityContext === 'collector_heartbeat'
    || event.activityContext === 'platform_healthcheck') return 'background';
  const semanticToolHint = event.eventCategory?.toLowerCase() === 'tool'
    || Boolean(event.toolCallId)
    || Boolean(attributes && [
      'gen_ai.tool.name', 'gen_ai.tool.call.id', 'tool_call.id', 'tool.name',
    ].some((key) => attributes[key] !== undefined));
  // `ToolExec` is the canonical machine-side fact and remains tool_backend even though the
  // universal event category is commonly `tool`.  Only bare legacy aliases (`tool`/`exec`/
  // `command`) may opt into the semantic lane when an explicit ToolCall hint is present.
  if (TOOL_EXEC_EVENT_KINDS.has(compactKind)
    && !(semanticToolHint && ['tool', 'exec', 'command'].includes(compactKind))) return 'tool_backend';

  // Explicit control/bootstrap operation metadata is useful even when a producer sends a generic
  // LlmApi kind.
  if (bootstrapPattern.test(operation)) return 'bootstrap';
  if (controlPattern.test(operation)) return 'control';
  if (backgroundPattern.test(operation)) return 'background';
  if (metadataPattern.test(operation)) return 'derived_metadata';
  if (retryPattern.test(operation)) return 'retry';

  // Preserve the old compatibility convention for explicitly named role suffixes, while keeping
  // semantic names exact below.  An arbitrary unknown `SomethingTool` therefore remains on the
  // legacy conversation fallback instead of being silently promoted to kernel tool_backend.
  if (normalizedKind.includes('bootstrap')) return 'bootstrap';
  if (normalizedKind.includes('control')) return 'control';
  if (normalizedKind.includes('background')) return 'background';

  // AgentTool and ToolResult are semantic intent/result records.  They belong to the human-facing
  // turn lane; only a separately observed ToolExec can become tool_backend.
  if (SEMANTIC_TOOL_EVENT_KINDS.has(compactKind)) {
    return 'conversation';
  }

  // Invocation and graph/workflow node spans describe execution bookkeeping.  Keep them in the
  // technical/background lane even when a compatibility session id is present.
  if (EXECUTION_BACKGROUND_EVENT_KINDS.has(compactKind)) {
    return 'background';
  }

  // LLM request/response records can represent a real turn or infrastructure bookkeeping.  A
  // producer Run (not Judge's derived compatibility Run), Turn, or namespaced/strong Session is
  // the minimum generic evidence for conversation; otherwise retain the event as technical
  // background.  (Legacy callers without a semantic kind still use the final conversation
  // fallback below.)
  if (LLM_EVENT_KINDS.has(compactKind)) {
    const hasSemanticContent = SEMANTIC_CONTENT_ATTRIBUTE_KEYS.some((key) => attributes[key] !== undefined);
    const hasProducerRun = Boolean(event.runId)
      && (event.runIdSource === 'producer' || event.runIdSource === undefined);
    const hasCanonicalAnchor = hasProducerRun
      || event.turnId
      || event.sessionKey
      || ['provider', 'authenticated_adapter'].includes(event.sessionIdSource ?? '')
      || ['confirmed', 'strong'].includes(event.sessionIdentityQuality ?? '');
    return hasSemanticContent || hasCanonicalAnchor
      ? 'conversation' : 'background';
  }

  // Known user/model message aliases are semantic conversation records.  This is intentionally
  // exact so a future product-specific kind can remain visible without inventing a lane.
  if (MESSAGE_EVENT_KINDS.has(compactKind)) {
    return 'conversation';
  }

  if (TECHNICAL_EVENT_KINDS.has(compactKind)) return 'background';

  // Unknown event kinds and pre-canonical rows retain the historical conversation fallback.  They
  // remain queryable until a producer declares a more precise role; no evidence is dropped.
  return 'conversation';
}

function threadDeploymentScopeKey(thread: T.AgentConversationThreadRecord): string {
  // The persisted Thread does not retain arbitrary adapter attributes, so its deployment scope
  // uses the canonical fields and the same opaque digest as conversationDeploymentScopeKey().
  const parts = [
    thread.environment,
    thread.environmentId,
    thread.profile,
    thread.profileVersion,
    thread.deploymentId,
    thread.deploymentRevision,
  ].map(normalized);
  if (parts.every((value) => !value)) return '';
  return stableId('dps', parts.join('\u0000'));
}

function scopeBase(value?: string): string {
  const scope = value?.trim() ?? '';
  for (const marker of ['|deployment:', '\u0000deployment:']) {
    const markerIndex = scope.indexOf(marker);
    if (markerIndex >= 0) return scope.slice(0, markerIndex);
  }
  return scope;
}

function sameDefinitionFingerprint(
  record: T.AgentInteractionRecord,
  thread: T.AgentConversationThreadRecord,
): boolean {
  const recordFingerprint = normalized(record.logicalDefinitionFingerprint);
  // An unresolved legacy Thread may carry a candidate fingerprint derived from a workspace that
  // was later replaced by a synthetic runtime path.  Until the incoming record supplies its own
  // canonical fingerprint, that candidate must not defeat the legacy anchor resume bridge.
  const threadFingerprint = recordFingerprint || canonicalScopeMode(thread.logicalScopeMode)
    ? normalized(thread.definitionFingerprint)
    : '';
  return !recordFingerprint || !threadFingerprint || recordFingerprint === threadFingerprint;
}

function exactDefinitionFingerprint(
  record: T.AgentInteractionRecord,
  thread: T.AgentConversationThreadRecord,
): boolean {
  const recordFingerprint = normalized(record.logicalDefinitionFingerprint);
  const threadFingerprint = recordFingerprint || canonicalScopeMode(thread.logicalScopeMode)
    ? normalized(thread.definitionFingerprint)
    : '';
  return Boolean(recordFingerprint && threadFingerprint && recordFingerprint === threadFingerprint);
}

/**
 * Verify that a persisted anchor belongs to the same canonical scope as the candidate Thread.
 * Stable CLI definitions may resume from a synthetic workspace, but an application/workflow
 * anchor must never cross a definition or deployment boundary merely because its provider hash
 * happens to be reused.
 */
function anchorScopeCompatible(
  record: T.AgentInteractionRecord,
  thread: T.AgentConversationThreadRecord,
  storedAnchorScope: string,
): boolean {
  const currentScope = conversationLogicalScopeKey(record);
  const persistedThreadScope = thread.logicalScopeKey.trim();
  const storedScope = storedAnchorScope.trim();
  // The anchor row and the membership's Thread must agree first.  Checking only the incoming
  // scope would allow a corrupt/legacy membership pointer to attach an anchor from definition A
  // to Thread B when both happen to expose the same provider hash.
  if (!storedScope || !persistedThreadScope) return false;
  if (storedScope === persistedThreadScope && storedScope === currentScope) return true;

  // The only intentional scope mismatch is a CLI/runtime resume where one side has a synthetic
  // workspace.  A real definition fingerprint (when available) still has to agree.
  const application = applicationScopeMode(record.logicalScopeMode)
    || applicationScopeMode(thread.logicalScopeMode);
  if (application) {
    // Application/workflow scopes are never allowed to use the CLI synthetic-workspace bridge.
    // Require the persisted anchor, Thread and incoming deployment fence to be identical; an old
    // row without deployment metadata is intentionally treated as a coverage gap rather than
    // guessed into test or production.
    return storedScope === persistedThreadScope
      && storedScope === currentScope
      && exactDefinitionFingerprint(record, thread)
      && conversationDeploymentScopeKey(record) === threadDeploymentScopeKey(thread);
  }
  if (scopeBase(storedScope) !== scopeBase(persistedThreadScope)) return false;
  if (storedScope === currentScope || scopeBase(storedScope) === scopeBase(currentScope)) return true;
  // Legacy rows may have no canonical LogicalAgent fields at all.  Keep the pre-canonical
  // synthetic-workspace resume bridge, but only after requiring the persisted anchor to belong to
  // this exact Thread scope above; this cannot join two unrelated anchor namespaces.
  if (!record.logicalAgentId && !thread.logicalAgentId
    && !record.logicalDefinitionFingerprint
    && !(thread.definitionFingerprint && canonicalScopeMode(thread.logicalScopeMode))
    && !canonicalScopeMode(record.logicalScopeMode)
    && !canonicalScopeMode(thread.logicalScopeMode)) {
    return syntheticWorkspace(record.workspacePath) || syntheticWorkspace(thread.workspacePath);
  }
  return Boolean(
    record.logicalAgentId
    && thread.logicalAgentId
    && record.logicalAgentId === thread.logicalAgentId
    && (exactDefinitionFingerprint(record, thread)
      || syntheticWorkspace(record.workspacePath)
      || syntheticWorkspace(thread.workspacePath)),
  );
}

function preferredWorkspace(current: string, remembered?: string): string {
  return remembered && !syntheticWorkspace(remembered) && syntheticWorkspace(current)
    ? remembered
    : current;
}

function anchorKindsCompatible(
  current: T.AgentConversationAnchorKind,
  stored: T.AgentConversationAnchorKind,
): boolean {
  if (current === 'previous_response_id' && stored === 'response_id') return true;
  return current === stored && [
    'provider_conversation',
    'continuity_key',
    'response_id',
    'message_item_id',
    'turn_id',
    'tool_call_id',
  ].includes(current);
}

function anchorScore(kind: T.AgentConversationAnchorKind): number {
  switch (kind) {
    case 'provider_conversation': return 140;
    case 'previous_response_id':
    case 'response_id': return 130;
    case 'tool_call_id': return 120;
    case 'continuity_key': return 100;
    case 'turn_id': return 90;
    case 'message_item_id': return 80;
    default: return 0;
  }
}

function sameThreadDomain(
  record: T.AgentInteractionRecord,
  thread: T.AgentConversationThreadRecord,
): boolean {
  if (normalized(record.tenantId) && normalized(thread.tenantId)
    && normalized(record.tenantId) !== normalized(thread.tenantId)) return false;

  const recordScope = conversationLogicalScopeKey(record);
  const threadScope = thread.logicalScopeKey.trim();
  const application = applicationScopeMode(record.logicalScopeMode)
    || applicationScopeMode(thread.logicalScopeMode);
  const sameLogicalAgent = Boolean(
    record.logicalAgentId
    && thread.logicalAgentId
    && record.logicalAgentId === thread.logicalAgentId,
  );
  if (record.logicalAgentId && thread.logicalAgentId
    && record.logicalAgentId !== thread.logicalAgentId) return false;
  if (!sameDefinitionFingerprint(record, thread)) return false;

  // Explicit terminal scope is an opt-in LogicalAgent boundary.  A missing terminal context is
  // not evidence that two terminal-scoped records are the same object.
  if (record.logicalScopeMode === 'terminal' || thread.logicalScopeMode === 'terminal') {
    if (!record.terminalContextId || !thread.terminalContextId
      || normalized(record.terminalContextId) !== normalized(thread.terminalContextId)) return false;
  }

  // Do this check before the logicalScopeKey equality fast path.  Persisted rows are untrusted
  // compatibility data; a stale/malformed key must not be able to override the explicit
  // deployment fields that fence workflow/service Sessions.
  if (application
    && conversationDeploymentScopeKey(record) !== threadDeploymentScopeKey(thread)) return false;

  if (recordScope === threadScope) return true;

  // A registered definition is the durable business boundary. It may move between host/SSH/
  // Docker/Kubernetes runtimes for CLI resume, but application/workflow Sessions are fenced by
  // deployment/environment/profile/revision. Explicit terminal-scoped IDs remain distinct.
  if (record.logicalAgentId && thread.logicalAgentId) {
    if (application) {
      return exactDefinitionFingerprint(record, thread)
        && conversationDeploymentScopeKey(record) === threadDeploymentScopeKey(thread);
    }
    return sameLogicalAgent
      && (exactDefinitionFingerprint(record, thread)
        || syntheticWorkspace(record.workspacePath)
        || syntheticWorkspace(thread.workspacePath));
  }

  // Records without a complete registered identity can only use an exact persisted scope.  The
  // legacy product/host fallback below remains for old rows that predate canonical scope fields.
  if (record.logicalAgentId || thread.logicalAgentId
    || record.logicalDefinitionFingerprint
    || (thread.definitionFingerprint && canonicalScopeMode(thread.logicalScopeMode))
    || canonicalScopeMode(record.logicalScopeMode)
    || canonicalScopeMode(thread.logicalScopeMode)) return false;
  if (normalized(record.environmentId) && normalized(thread.environmentId)
    && normalized(record.environmentId) !== normalized(thread.environmentId)) return false;
  if (normalized(record.agentProduct) !== normalized(thread.agentProduct)) return false;
  if (normalized(record.process?.hostId) && normalized(thread.hostId)
    && normalized(record.process?.hostId) !== normalized(thread.hostId)) return false;
  return syntheticWorkspace(record.workspacePath)
    || syntheticWorkspace(thread.workspacePath)
    || normalized(record.workspacePath) === normalized(thread.workspacePath);
}

function segmentEnd(segment: T.ConversationInstanceSegment): bigint {
  return BigInt(segment.endedAtUnixNs ?? segment.startedAtUnixNs);
}

function segmentContains(
  outer: T.ConversationInstanceSegment,
  inner: T.ConversationInstanceSegment,
): boolean {
  return outer.agentInstanceId === inner.agentInstanceId
    && BigInt(outer.startedAtUnixNs) <= BigInt(inner.startedAtUnixNs)
    && segmentEnd(outer) >= segmentEnd(inner);
}

function segmentPreferred(
  left: T.ConversationInstanceSegment,
  right: T.ConversationInstanceSegment,
): boolean {
  const leftDuration = segmentEnd(left) - BigInt(left.startedAtUnixNs);
  const rightDuration = segmentEnd(right) - BigInt(right.startedAtUnixNs);
  return leftDuration > rightDuration
    || (leftDuration === rightDuration && left.interactionCount > right.interactionCount)
    || (leftDuration === rightDuration
      && left.interactionCount === right.interactionCount
      && left.updatedAt > right.updatedAt)
    || (leftDuration === rightDuration
      && left.interactionCount === right.interactionCount
      && left.updatedAt === right.updatedAt
      && left.segmentId < right.segmentId);
}

function collapseContainedSegments(
  segments: T.ConversationInstanceSegment[],
): T.ConversationInstanceSegment[] {
  return segments
    .filter((candidate) => !segments.some((other) =>
      other.segmentId !== candidate.segmentId
      && segmentContains(other, candidate)
      && (
        !segmentContains(candidate, other)
        || segmentPreferred(other, candidate)
      )))
    .sort((left, right) => {
      const leftStart = BigInt(left.startedAtUnixNs);
      const rightStart = BigInt(right.startedAtUnixNs);
      return leftStart === rightStart
        ? left.ordinal - right.ordinal || left.segmentId.localeCompare(right.segmentId)
        : leftStart < rightStart ? -1 : 1;
    })
    .map((segment, index) => ({ ...segment, ordinal: index + 1 }));
}

@Injectable()
export class AgentConversationBindingService implements OnModuleDestroy {
  private readonly bindings = new Map<string, T.AgentConversationBindingRecord>();
  private readonly threads = new Map<string, T.AgentConversationThreadRecord>();
  private readonly segments = new Map<string, T.ConversationInstanceSegment>();
  private readonly routeAliases = new Map<string, ConversationRouteAliasV1>();
  private readonly technicalActivities = new Map<string, TechnicalActivityProjection>();
  private readonly membershipsV2 = new Map<string, ConversationMembershipV2>();
  private readonly persistenceFingerprints = new Map<string, {
    fingerprint: string;
    bytes: number;
    touchedAt: number;
  }>();
  private readonly maxPersistenceFingerprints = 200_000;
  private readonly maxPersistenceFingerprintBytes = 32 * 1024 * 1024;
  private readonly persistenceFingerprintTtlMs = 24 * 60 * 60_000;
  private persistenceFingerprintBytes = 0;
  private persistenceFingerprintEvictions = 0;
  private persistenceFingerprintExpired = 0;
  private persistenceFingerprintDropped = 0;
  private readonly hotStateTtlMs = 24 * 60 * 60_000;
  private readonly hotStateMaxEntries = 100_000;
  private readonly hotStateMaxBytes = 64 * 1024 * 1024;
  private hotStateEvictions = 0;
  private pendingResolution?: ConversationResolutionV2;
  private resolutionRevision = 0;
  private resolutionInputFingerprint?: string;

  constructor(
    @Optional() private readonly relationalStore?: RelationalBusinessStore,
    @Optional() private readonly canonicalObservability?: CanonicalObservabilityService,
  ) {}

  onModuleDestroy(): void {
    this.bindings.clear();
    this.threads.clear();
    this.segments.clear();
    this.routeAliases.clear();
    this.technicalActivities.clear();
    this.membershipsV2.clear();
    this.persistenceFingerprints.clear();
    this.persistenceFingerprintBytes = 0;
    this.pendingResolution = undefined;
    this.resolutionInputFingerprint = undefined;
    this.resolutionRevision = 0;
  }

  private prunePersistenceFingerprints(now = Date.now()): void {
    for (const [key, entry] of this.persistenceFingerprints) {
      if (now - entry.touchedAt <= this.persistenceFingerprintTtlMs) continue;
      this.persistenceFingerprints.delete(key);
      this.persistenceFingerprintBytes = Math.max(0, this.persistenceFingerprintBytes - entry.bytes);
      this.persistenceFingerprintExpired += 1;
    }
    while (
      this.persistenceFingerprints.size > this.maxPersistenceFingerprints
      || this.persistenceFingerprintBytes > this.maxPersistenceFingerprintBytes
    ) {
      const oldest = this.persistenceFingerprints.entries().next().value as
        | [string, { fingerprint: string; bytes: number; touchedAt: number }]
        | undefined;
      if (!oldest) break;
      this.persistenceFingerprints.delete(oldest[0]);
      this.persistenceFingerprintBytes = Math.max(0, this.persistenceFingerprintBytes - oldest[1].bytes);
      this.persistenceFingerprintEvictions += 1;
    }
  }

  private pruneHotState(now = Date.now()): void {
    const nsMillis = (value?: string): number => {
      if (!value || !/^\d+$/u.test(value)) return 0;
      try { return Number(BigInt(value) / 1_000_000n); } catch { return 0; }
    };
    const prune = <V>(map: Map<string, V>, at: (value: V) => number): void => {
      for (const [key, value] of map) {
        const timestamp = at(value);
        if (timestamp > 0 && now - timestamp > this.hotStateTtlMs) {
          map.delete(key);
          this.hotStateEvictions += 1;
        }
      }
      while (map.size > this.hotStateMaxEntries) {
        const oldest = [...map.entries()].sort((left, right) => at(left[1]) - at(right[1]))[0]?.[0];
        if (oldest === undefined) break;
        map.delete(oldest);
        this.hotStateEvictions += 1;
      }
    };
    prune(this.bindings, (value) => value.updatedAt);
    prune(this.threads, (value) => nsMillis(value.lastActivityAtUnixNs));
    prune(this.segments, (value) => value.updatedAt);
    prune(this.routeAliases, (value) => value.createdAt);
    prune(this.technicalActivities, (value) => nsMillis(value.endedAtUnixNs));
    prune(this.membershipsV2, (value) => value.decidedAt);
    const maps: Array<Map<string, unknown>> = [
      this.bindings as Map<string, unknown>, this.threads as Map<string, unknown>,
      this.segments as Map<string, unknown>, this.routeAliases as Map<string, unknown>,
      this.technicalActivities as Map<string, unknown>, this.membershipsV2 as Map<string, unknown>,
    ];
    const estimate = () => maps.reduce<number>((sum, map) => sum + [...map.values()].reduce<number>((inner, value) => {
      try { return inner + Buffer.byteLength(JSON.stringify(value), 'utf8'); } catch { return inner + 1_024; }
    }, 0), 0);
    let bytes = estimate();
    while (bytes > this.hotStateMaxBytes) {
      const largest = maps.sort((left, right) => right.size - left.size)[0];
      if (!largest || largest.size === 0) break;
      largest.delete(largest.keys().next().value as string);
      this.hotStateEvictions += 1;
      bytes = estimate();
    }
  }

  hotStateStats(): {
    entries: number;
    estimatedBytes: number;
    maxEntries: number;
    maxBytes: number;
    ttlMs: number;
    evictions: number;
    persistenceDedupe: {
      entries: number;
      bytes: number;
      maxEntries: number;
      maxBytes: number;
      ttlMs: number;
      evicted: number;
      expired: number;
      dropped: number;
    };
  } {
    this.pruneHotState();
    this.prunePersistenceFingerprints();
    const maps: Array<Map<string, unknown>> = [
      this.bindings as Map<string, unknown>, this.threads as Map<string, unknown>,
      this.segments as Map<string, unknown>, this.routeAliases as Map<string, unknown>,
      this.technicalActivities as Map<string, unknown>, this.membershipsV2 as Map<string, unknown>,
    ];
    const estimatedBytes = maps.reduce<number>((sum, map) => sum + [...map.values()].reduce<number>((inner, value) => {
      try { return inner + Buffer.byteLength(JSON.stringify(value), 'utf8'); } catch { return inner + 1_024; }
    }, 0), 0);
    return {
      entries: maps.reduce((sum, map) => sum + map.size, 0),
      estimatedBytes,
      maxEntries: this.hotStateMaxEntries,
      maxBytes: this.hotStateMaxBytes,
      ttlMs: this.hotStateTtlMs,
      evictions: this.hotStateEvictions,
      persistenceDedupe: {
        entries: this.persistenceFingerprints.size,
        bytes: this.persistenceFingerprintBytes,
        maxEntries: this.maxPersistenceFingerprints,
        maxBytes: this.maxPersistenceFingerprintBytes,
        ttlMs: this.persistenceFingerprintTtlMs,
        evicted: this.persistenceFingerprintEvictions,
        expired: this.persistenceFingerprintExpired,
        dropped: this.persistenceFingerprintDropped,
      },
    };
  }

  private changedForPersistence<Item>(
    namespace: string,
    items: Item[],
    identity: (item: Item) => string,
  ): Item[] {
    this.prunePersistenceFingerprints();
    return items.filter((item) => {
      const key = `${namespace}\u0000${identity(item)}`;
      const fingerprint = createHash('sha256').update(canonicalJson(item)).digest('hex');
      return this.persistenceFingerprints.get(key)?.fingerprint !== fingerprint;
    });
  }

  private rememberPersisted<Item>(
    namespace: string,
    items: Item[],
    identity: (item: Item) => string,
  ): void {
    const now = Date.now();
    this.prunePersistenceFingerprints(now);
    for (const item of items) {
      const key = `${namespace}\u0000${identity(item)}`;
      const fingerprint = createHash('sha256').update(canonicalJson(item)).digest('hex');
      const bytes = Buffer.byteLength(key, 'utf8') + Buffer.byteLength(fingerprint, 'utf8') + 24;
      if (bytes > this.maxPersistenceFingerprintBytes) {
        this.persistenceFingerprintDropped += 1;
        continue;
      }
      const previous = this.persistenceFingerprints.get(key);
      if (previous) {
        this.persistenceFingerprints.delete(key);
        this.persistenceFingerprintBytes = Math.max(0, this.persistenceFingerprintBytes - previous.bytes);
      }
      this.persistenceFingerprints.set(key, { fingerprint, bytes, touchedAt: now });
      this.persistenceFingerprintBytes += bytes;
    }
    this.prunePersistenceFingerprints(now);
  }

  private boundV2PersistenceItems<Item>(
    items: readonly Item[],
    maxEntries: number,
    maxBytes = V2_PERSIST_MAX_CATEGORY_BYTES,
  ): { items: Item[]; truncated: boolean } {
    const bounded: Item[] = [];
    let bytes = 2;
    let truncated = false;
    for (const item of items) {
      if (bounded.length >= maxEntries) {
        truncated = true;
        break;
      }
      const itemBytes = Buffer.byteLength(canonicalJson(item), 'utf8') + 1;
      if (bytes + itemBytes > maxBytes) {
        truncated = true;
        break;
      }
      bounded.push(item);
      bytes += itemBytes;
    }
    if (bounded.length < items.length) truncated = true;
    return { items: bounded, truncated };
  }

  private async bindByPersistedAnchors(
    records: T.AgentInteractionRecord[],
  ): Promise<void> {
    this.pruneHotState();
    if (!records.length || !this.relationalStore?.configured()) return;
    for (const record of records) {
      record.conversationAnchors = conversationAnchorsForInteraction(record);
    }
    // A stable CLI definition may resume after the collector reports a synthetic workspace.  In
    // that case an SQL scope predicate would hide the very anchor needed for the resume bridge;
    // fetch broadly and apply the stricter per-Thread fence below.  Application/workflow records
    // (and records without a registered identity) use the database scope index as an early gate.
    const hasCrossRuntimeDefinition = records.some((record) =>
      syntheticWorkspace(record.workspacePath)
      || (Boolean(record.logicalAgentId) && !applicationScopeMode(record.logicalScopeMode)));
    const logicalScopeKeys = hasCrossRuntimeDefinition
      ? []
      : [...new Set(records.flatMap((record) => [
          conversationLogicalScopeKey(record),
          conversationLogicalScopeKeyV2(record), // additive bridge for pre-deployment-fence rows
        ]))].slice(0, 4_096);
    const matches = await this.relationalStore.loadAgentConversationMembershipsByAnchors(
      records.flatMap((record) => record.conversationAnchors ?? []),
      logicalScopeKeys,
    );
    const conversationIds = [...new Set(matches
      .map((match) => match.membership.canonicalConversationId)
      .filter((value): value is string => Boolean(value)))];
    const [threads, segments] = await Promise.all([
      this.relationalStore.loadAgentConversationThreadsByIds(conversationIds),
      this.relationalStore.loadAgentConversationSegments(conversationIds),
    ]);
    for (const thread of threads) this.threads.set(thread.conversationId, thread);
    for (const segment of segments) this.segments.set(segment.segmentId, segment);
    const byHash = new Map<string, typeof matches>();
    for (const match of matches) {
      const anchor = match.anchor.anchor;
      const key = `${anchor.namespace}\u0000${anchor.valueHash}`;
      const values = byHash.get(key) ?? [];
      values.push(match);
      byHash.set(key, values);
    }
    for (const record of records) {
      const candidates = new Map<string, {
        thread: T.AgentConversationThreadRecord;
        anchors: Map<string, number>;
        evidence: Set<string>;
        exact: boolean;
      }>();
      for (const current of record.conversationAnchors ?? []) {
        const key = `${current.namespace}\u0000${current.valueHash}`;
        for (const match of byHash.get(key) ?? []) {
          const stored = match.anchor.anchor;
          if (!anchorKindsCompatible(current.kind, stored.kind)) continue;
          const canonical = this.canonicalConversationId(
            match.membership.canonicalConversationId!,
          );
          const thread = this.threads.get(canonical);
          if (!thread || !sameThreadDomain(record, thread)) continue;
          if (!anchorScopeCompatible(record, thread, match.anchor.logicalScopeKey)) continue;
          const candidate = candidates.get(canonical) ?? {
            thread,
            anchors: new Map<string, number>(),
            evidence: new Set<string>(),
            exact: false,
          };
          const anchorKey = `${current.kind}\u0000${current.namespace}\u0000${current.valueHash}`;
          candidate.anchors.set(
            anchorKey,
            Math.max(candidate.anchors.get(anchorKey) ?? 0, anchorScore(current.kind)),
          );
          candidate.evidence.add(
            current.kind === 'previous_response_id' && stored.kind === 'response_id'
              ? 'previous_response_id:response_id'
              : current.kind,
          );
          candidate.exact ||= current.strength === 'exact' && stored.strength === 'exact';
          candidates.set(canonical, candidate);
        }
      }
      const ranked = [...candidates.entries()].map(([conversationId, candidate]) => ({
        conversationId,
        ...candidate,
        score: [...candidate.anchors.values()].reduce((sum, score) => sum + score, 0),
      })).sort((left, right) =>
        right.score - left.score
        || right.anchors.size - left.anchors.size
        || left.conversationId.localeCompare(right.conversationId));
      const best = ranked[0];
      const tied = best && ranked[1]?.score === best.score
        && ranked[1].anchors.size === best.anchors.size;
      if (!best || tied || best.score < 80) continue;
      record.conversationId = best.conversationId;
      record.conversationIdSource = best.thread.idSource;
      record.conversationBindingVersion = AGENT_CONVERSATION_RESOLVER_VERSION;
      record.correlationQuality = best.exact ? 'exact' : 'strong';
      record.workspacePath = preferredWorkspace(record.workspacePath, best.thread.workspacePath);
    }
  }

  async applyPersistedBindings(
    interactions: T.AgentInteractionRecord[],
  ): Promise<T.AgentInteractionRecord[]> {
    this.pruneHotState();
    if (interactions.length === 0) return [];
    const interactionIds = interactions.map((record) => record.interactionId);
    if (this.relationalStore?.configured()) {
      const [loadedMemberships, loadedBindings] = await Promise.all([
        this.relationalStore.loadAgentConversationMembershipsV2?.(interactionIds) ?? [],
        this.relationalStore.loadAgentConversationBindings(interactionIds),
      ]);
      for (const membership of loadedMemberships) {
        this.membershipsV2.set(membership.interactionId, membership);
      }
      for (const binding of loadedBindings) {
        this.bindings.set(binding.interactionId, binding);
      }
      const conversationIds = [...new Set([
        ...loadedBindings.map((binding) => binding.conversationId),
        ...loadedMemberships
          .map((membership) => membership.canonicalConversationId)
          .filter((value): value is string => Boolean(value)),
      ])];
      const logicalScopeKeys = [...new Set(loadedBindings.map((binding) => binding.logicalScopeKey))];
      const [scopeThreads, idThreads, segments, aliases] = await Promise.all([
        this.relationalStore.loadAgentConversationThreads(logicalScopeKeys),
        this.relationalStore.loadAgentConversationThreadsByIds(conversationIds),
        this.relationalStore.loadAgentConversationSegments(conversationIds),
        this.relationalStore.loadAgentConversationRouteAliases?.(conversationIds) ?? [],
      ]);
      for (const thread of [...scopeThreads, ...idThreads]) {
        this.threads.set(thread.conversationId, thread);
      }
      for (const segment of segments) this.segments.set(segment.segmentId, segment);
      for (const alias of aliases) {
        this.routeAliases.set(alias.aliasConversationId, alias);
      }
    }

    const projected = interactions.map((record) => {
      const binding = this.bindings.get(record.interactionId);
      const membership = this.membershipsV2.get(record.interactionId);
      const boundConversationId = membership?.canonicalConversationId
        ?? binding?.conversationId;
      const canonicalConversationId = boundConversationId
        ? this.canonicalConversationId(boundConversationId)
        : undefined;
      const thread = canonicalConversationId
        ? this.threads.get(canonicalConversationId)
        : undefined;
      return {
        ...record,
        ...(binding ? {
          ...(binding.logicalAgentId ? { logicalAgentId: binding.logicalAgentId } : {}),
          ...(binding.logicalDefinitionId ? { logicalDefinitionId: binding.logicalDefinitionId } : {}),
          ...(binding.logicalScopeMode ? { logicalScopeMode: binding.logicalScopeMode } : {}),
          ...(binding.logicalIdentityAuthority ? { logicalIdentityAuthority: binding.logicalIdentityAuthority } : {}),
          ...(binding.profile ? { profile: binding.profile } : {}),
          ...(binding.profileVersion ? { profileVersion: binding.profileVersion } : {}),
          ...(binding.deploymentId ? { deploymentId: binding.deploymentId } : {}),
          ...(binding.deploymentRevision ? { deploymentRevision: binding.deploymentRevision } : {}),
          ...(binding.environmentId ? { environmentId: binding.environmentId } : {}),
          ...(binding.sessionKey ? { sessionKey: binding.sessionKey } : {}),
          ...(binding.providerSessionIdHash ? { providerSessionIdHash: binding.providerSessionIdHash } : {}),
          ...(binding.canonicalSessionId ? { canonicalSessionId: binding.canonicalSessionId } : {}),
          ...(binding.sessionNamespaceKey ? { sessionNamespaceKey: binding.sessionNamespaceKey } : {}),
          ...(binding.sessionMode ? { sessionMode: binding.sessionMode } : {}),
          ...(binding.sessionLifecycle ? { sessionLifecycle: binding.sessionLifecycle } : {}),
          ...(binding.parentSessionId ? { parentSessionId: binding.parentSessionId } : {}),
          ...(binding.canonicalParentSessionId
            ? { canonicalParentSessionId: binding.canonicalParentSessionId }
            : {}),
        } : {}),
        ...(thread ? {
          workspacePath: preferredWorkspace(record.workspacePath, thread.workspacePath),
          ...(thread.logicalAgentId ? { logicalAgentId: thread.logicalAgentId } : {}),
          ...(thread.logicalDefinitionId ? { logicalDefinitionId: thread.logicalDefinitionId } : {}),
          ...(thread.logicalScopeMode ? { logicalScopeMode: thread.logicalScopeMode } : {}),
          ...(thread.logicalIdentityAuthority ? { logicalIdentityAuthority: thread.logicalIdentityAuthority } : {}),
          ...(thread.profile ? { profile: thread.profile } : {}),
          ...(thread.profileVersion ? { profileVersion: thread.profileVersion } : {}),
          ...(thread.deploymentId ? { deploymentId: thread.deploymentId } : {}),
          ...(thread.deploymentRevision ? { deploymentRevision: thread.deploymentRevision } : {}),
          ...(thread.environmentId ? { environmentId: thread.environmentId } : {}),
          ...(thread.environment ? { environment: thread.environment } : {}),
          ...(thread.sessionKey ? { sessionKey: thread.sessionKey } : {}),
          ...(thread.providerSessionIdHash ? { providerSessionIdHash: thread.providerSessionIdHash } : {}),
        } : {}),
        ...(canonicalConversationId ? { conversationId: canonicalConversationId } : {}),
        ...(canonicalConversationId ? { conversationIdSource: 'inferred' as const } : {}),
        ...(membership?.role ? { trafficRole: membership.role } : {}),
        ...(membership || binding
          ? {
              conversationBindingVersion: membership?.resolverVersion ?? binding!.resolverVersion,
              correlationQuality: membership?.confidence ?? binding!.correlationQuality,
            }
          : {}),
      };
    });
    const unbound = projected.filter((record) => !record.conversationId);
    await this.bindByPersistedAnchors(unbound);
    const remainingUnbound = unbound.filter((record) => !record.conversationId);
    const scopeKeys = [...new Set(remainingUnbound.map(conversationLogicalScopeKey))];
    if (scopeKeys.length && this.relationalStore?.configured()) {
      const loadedThreads = await this.relationalStore.loadAgentConversationThreads(scopeKeys);
      for (const thread of loadedThreads) {
        this.threads.set(thread.conversationId, thread);
      }
      for (const segment of await this.relationalStore.loadAgentConversationSegments(
        loadedThreads.map((thread) => thread.conversationId),
      )) this.segments.set(segment.segmentId, segment);
    }

    for (const record of remainingUnbound.sort(compareInteraction)) {
      const scope = conversationLogicalScopeKey(record);
      const lineage = userLineage(record);
      const resultIds = new Set(record.toolResults.map((result) => result.toolCallId));
      const candidates = [...this.threads.values()]
        .filter((thread) => thread.logicalScopeKey === scope)
        .map((thread) => {
          const sameInstance = Boolean(record.agentInstanceId
            && thread.agentInstanceIds.includes(record.agentInstanceId));
          const resolvesPending = thread.pendingToolCallIds.some((id) => resultIds.has(id));
          const sameRequest = thread.lastRequestSha256 === record.request.sha256;
          const extendedLineage = properPrefix(thread.userLineageHashes, lineage);
          const repeatedLineage = equalLineage(thread.userLineageHashes, lineage);
          let score = 0;
          const evidence: string[] = [];
          if (resolvesPending) {
            score += 100;
            evidence.push('tool_call_id');
          }
          if (sameRequest && sameInstance) {
            score += 80;
            evidence.push('request_sha256');
          }
          const resumableLineage = record.sessionMode !== 'per_request'
            && record.sessionIdentityQuality !== 'ephemeral';
          if (extendedLineage && (sameInstance || resumableLineage)) {
            score += sameInstance ? 70 : 60;
            evidence.push(sameInstance ? 'same_instance_lineage' : 'cli_resume_lineage');
          } else if (sameInstance && repeatedLineage) {
            score += 40;
            evidence.push('same_instance_equal_lineage');
          }
          return { thread, score, evidence };
        })
        .filter((candidate) => candidate.score > 0)
        .sort((left, right) => {
          const score = right.score - left.score;
          if (score) return score;
          const lineage = right.thread.userLineageHashes.length
            - left.thread.userLineageHashes.length;
          if (lineage) return lineage;
          const rightAt = BigInt(right.thread.lastActivityAtUnixNs);
          const leftAt = BigInt(left.thread.lastActivityAtUnixNs);
          return rightAt === leftAt ? 0 : rightAt > leftAt ? -1 : 1;
        });
      const best = candidates[0];
      const tied = best && candidates[1]?.score === best.score
        && candidates[1].thread.userLineageHashes.length === best.thread.userLineageHashes.length;
      if (!best || tied) continue;
      record.conversationId = best.thread.conversationId;
      record.conversationIdSource = best.thread.idSource;
      record.conversationBindingVersion = AGENT_CONVERSATION_RESOLVER_VERSION;
      record.correlationQuality = best.evidence.includes('tool_call_id') ? 'exact' : 'strong';
    }
    // Resolver revisions are logical projection versions. Keep a compact monotonic counter per
    // distinct input snapshot instead of deriving one from Unix milliseconds (which previously
    // produced values near 1e14 and then collapsed to the 1e6 safety cap in the canonical lane).
    // The fingerprint intentionally includes only bounded identity/anchor fields, never prompt or
    // response bodies.
    const resolutionInput = projected
      .map((record) => {
        const stableLogicalAuthority = record.logicalIdentityAuthority === 'management_registration'
          || record.logicalIdentityAuthority === 'authenticated_adapter';
        return {
          interactionId: record.interactionId,
          ...(stableLogicalAuthority ? {
            logicalAgentId: record.logicalAgentId,
            logicalDefinitionId: record.logicalDefinitionId,
            logicalScopeMode: record.logicalScopeMode,
          } : {}),
          sessionId: record.sessionId,
          canonicalSessionId: record.canonicalSessionId,
          sessionNamespaceKey: record.sessionNamespaceKey,
          sessionLifecycle: record.sessionLifecycle,
          parentSessionId: record.parentSessionId,
          canonicalParentSessionId: record.canonicalParentSessionId,
          trafficRole: trafficRoleForInteraction(record),
          conversationAnchors: (record.conversationAnchors ?? []).map((anchor) => ({
            kind: anchor.kind,
            namespace: anchor.namespace,
            valueHash: anchor.valueHash,
            strength: anchor.strength,
          })),
        };
      })
      .sort((left, right) => left.interactionId.localeCompare(right.interactionId));
    const nextFingerprint = createHash('sha256').update(canonicalJson(resolutionInput)).digest('hex');
    if (this.resolutionInputFingerprint !== nextFingerprint) {
      this.resolutionInputFingerprint = nextFingerprint;
      this.resolutionRevision = Math.min(
        CANONICAL_SESSION_REVISION_MAX,
        Math.max(1, this.resolutionRevision + 1),
      );
    }
    const resolution = resolveAgentConversationsV2(projected, this.resolutionRevision || 1);
    this.pendingResolution = resolution;
    this.resolutionRevision = Math.max(this.resolutionRevision, resolution.resolutionRevision);
    for (const aliasId of resolution.aliasConflicts ?? []) {
      this.canonicalObservability?.recordGap('correlation', 'relation_ambiguous', aliasId, {
        alias: 'competing_conversation_targets',
      });
    }
    for (const alias of resolution.aliases) this.routeAliases.set(alias.aliasConversationId, alias);
    for (const activity of resolution.technicalActivities) {
      this.technicalActivities.set(activity.technicalActivityId, activity);
    }
    for (const membership of resolution.memberships) {
      this.membershipsV2.set(membership.interactionId, membership);
    }
    return resolution.records;
  }

  /**
   * Ingest-time canonical Session projection.  Conversation/segment grouping is intentionally
   * deferred, but the Session identity and its source references are available on the interaction
   * itself and must not wait for a later read or PostgreSQL-enabled materializer.
   */
  async commitInteractionMembership(record: T.AgentInteractionRecord): Promise<void> {
    if (!this.canonicalObservability) return;
    const sessionKey = record.sessionKey;
    const rawSession = record.sessionId;
    const sessionId = sessionKey ?? rawSession ?? `sess_${createHash('sha256').update(record.interactionId).digest('hex').slice(0, 24)}`;
    const baseQuality: T.SessionIdentityQuality = record.sessionIdentityQuality === 'confirmed'
      ? 'confirmed'
      : record.sessionIdentityQuality === 'strong' ? 'strong'
        : record.sessionIdentityQuality === 'ephemeral' ? 'ephemeral' : 'inferred';
    const confidence: T.SessionIdentityQuality = !sessionKey
      && (baseQuality === 'confirmed' || baseQuality === 'strong') ? 'inferred' : baseQuality;
    const rawResolutionRevision = Number(
      record.sessionResolutionRevision ?? record.conversationBindingVersion ?? 1,
    );
    const resolutionRevision = Number.isSafeInteger(rawResolutionRevision) && rawResolutionRevision >= 1
      ? Math.min(CANONICAL_SESSION_REVISION_MAX, rawResolutionRevision) : 1;
    // Preserve every generic traffic role on the canonical membership.  In particular,
    // context_replay, derived_metadata, retry, and unclassified are technical/coverage states,
    // not newly observed human turns.  The shared resolver remains the authority; an unknown or
    // malformed value keeps the legacy conversation fallback so evidence is never dropped.
    const resolvedRole = record.trafficRole ?? trafficRoleForInteraction(record);
    const role = SESSION_MEMBERSHIP_TRAFFIC_ROLES.has(resolvedRole as ConversationMembershipRole)
      ? resolvedRole as ConversationMembershipRole
      : 'conversation' as const;
    const sourceRefs = [...new Set([
      record.interactionId,
      record.rawObservationId,
      ...(record.sourceObservationIds ?? []),
      ...(record.evidenceEventIds ?? []),
    ].filter((value): value is string => Boolean(value)))].slice(0, 128);
    const membership = {
      schemaVersion: 'anysentry.session_membership.v1' as const,
      membershipId: `sm_${createHash('sha256').update([
        record.interactionId, sessionKey ?? rawSession ?? '', String(resolutionRevision),
      ].join('\0')).digest('hex').slice(0, 24)}`,
      sessionId: record.canonicalSessionId
        ?? canonicalSessionIdForMembership(
          rawSession ?? sessionId,
          record.sessionNamespaceKey,
          record.interactionId,
        ),
      ...(sessionKey ? { sessionKey } : {}),
      ...(record.providerSessionIdHash ? { providerSessionIdHash: record.providerSessionIdHash } : {}),
      ...(record.sessionNamespaceKey ? { sessionNamespaceKey: record.sessionNamespaceKey } : {}),
      ...(record.sessionMode ? { sessionMode: record.sessionMode } : {}),
      ...(record.sessionLifecycle ? { sessionLifecycle: record.sessionLifecycle } : {}),
      ...(() => {
        const canonicalParentSessionId = record.canonicalParentSessionId
          ?? canonicalParentSessionIdForMembership(
            record.parentSessionId,
            record.sessionNamespaceKey,
          );
        if (record.parentSessionId && !canonicalParentSessionId) {
          this.canonicalObservability?.recordGap('session', 'identity_unknown', record.interactionId, {
            parent: 'namespace_unavailable',
          });
        }
        return canonicalParentSessionId
          ? { parentSessionId: canonicalParentSessionId, canonicalParentSessionId }
          : record.parentSessionId ? { parentSessionId: record.parentSessionId } : {};
      })(),
      interactionId: record.interactionId,
      ...(record.logicalAgentId ? { logicalAgentId: record.logicalAgentId } : {}),
      ...(record.canonicalAgentInstanceId
        ? { agentInstanceId: record.canonicalAgentInstanceId }
        : {}),
      ...(record.runtimeInstanceId ?? record.agentInstanceId
        ? { runtimeInstanceId: record.runtimeInstanceId ?? record.agentInstanceId }
        : {}),
      role,
      confidence,
      evidence: sourceRefs,
      resolverVersion: 'canonical-session-membership.v1',
      resolutionRevision,
      validFromUnixNs: record.startedAtUnixNs,
      sourceRefs,
    };
    const result = await this.canonicalObservability.commitSessionMemberships([membership]);
    if (result.rejected > 0) {
      this.canonicalObservability.recordGap('projection', 'dropped', record.interactionId, {
        projection: 'session_membership', rejected: result.rejected,
      });
    }
  }

  async commitEventMembership(event: T.JudgedEvent): Promise<void> {
    if (!this.canonicalObservability) return;
    // Kernel-only facts remain on the machine evidence lane.  They can later support a
    // ToolCall/Session relation, but creating an event-scoped Session here would inflate the human
    // conversation directory and incorrectly turn PID/Pod activity into a per-request dialog.
    if (!eventMembershipEligible(event)) return;
    const sessionKey = event.sessionKey;
    const rawSession = event.sessionId;
    // A parser/storage failure must not discard a Kernel/semantic event merely because no native
    // Session header was present. Derive one event-scoped ephemeral key, matching the universal
    // ingest per-request rule, and retain its unresolved provenance.
    const sessionSeed = sessionKey ?? rawSession ?? `event:${event.eventId}`;
    const sessionId = sessionKey ?? rawSession ?? `ephemeral:${event.eventId}`;
    const baseQuality: T.SessionIdentityQuality = !sessionKey && !rawSession
      ? 'ephemeral'
      : event.sessionIdentityQuality === 'confirmed'
      ? 'confirmed'
      : event.sessionIdentityQuality === 'strong' ? 'strong'
        : event.sessionIdentityQuality === 'ephemeral' ? 'ephemeral' : 'inferred';
    const confidence: T.SessionIdentityQuality = !sessionKey
      && (baseQuality === 'confirmed' || baseQuality === 'strong') ? 'inferred' : baseQuality;
    const rawResolutionRevision = Number(event.sessionResolutionRevision ?? 1);
    const resolutionRevision = Number.isSafeInteger(rawResolutionRevision) && rawResolutionRevision >= 1
      ? Math.min(CANONICAL_SESSION_REVISION_MAX, rawResolutionRevision) : 1;
    const role = trafficRoleForEvent(event);
    const sourceRefs = [...new Set([
      event.eventId,
      event.rawObservationId,
      event.sourceEventId,
    ].filter((value): value is string => Boolean(value)))].slice(0, 128);
    const membership = {
      schemaVersion: 'anysentry.session_membership.v1' as const,
      membershipId: `sm_${createHash('sha256').update([
        event.eventId, sessionSeed, String(resolutionRevision),
      ].join('\0')).digest('hex').slice(0, 24)}`,
      sessionId: event.canonicalSessionId
        ?? canonicalSessionIdForMembership(
          sessionSeed,
          event.sessionNamespaceKey,
          event.eventId,
        ),
      ...(sessionKey ? { sessionKey } : {}),
      ...(event.providerSessionIdHash ? { providerSessionIdHash: event.providerSessionIdHash } : {}),
      ...(event.sessionNamespaceKey ? { sessionNamespaceKey: event.sessionNamespaceKey } : {}),
      ...(event.sessionMode
        ? { sessionMode: event.sessionMode }
        : !sessionKey && !rawSession ? { sessionMode: 'per_request' as const } : {}),
      ...(event.sessionLifecycle
        ? { sessionLifecycle: event.sessionLifecycle }
        : !sessionKey && !rawSession ? { sessionLifecycle: 'new' as const } : {}),
      ...(() => {
        const canonicalParentSessionId = event.canonicalParentSessionId
          ?? canonicalParentSessionIdForMembership(
            event.parentSessionId,
            event.sessionNamespaceKey,
          );
        if (event.parentSessionId && !canonicalParentSessionId) {
          this.canonicalObservability?.recordGap('session', 'identity_unknown', event.eventId, {
            parent: 'namespace_unavailable',
          });
        }
        return canonicalParentSessionId
          ? { parentSessionId: canonicalParentSessionId, canonicalParentSessionId }
          : event.parentSessionId ? { parentSessionId: event.parentSessionId } : {};
      })(),
      interactionId: event.eventId,
      ...(event.logicalAgentId ? { logicalAgentId: event.logicalAgentId } : {}),
      ...(event.canonicalAgentInstanceId
        ? { agentInstanceId: event.canonicalAgentInstanceId }
        : {}),
      ...(event.runtimeInstanceId ?? event.attribution?.agentInstanceId
        ? { runtimeInstanceId: event.runtimeInstanceId ?? event.attribution?.agentInstanceId }
        : {}),
      role,
      confidence,
      evidence: sourceRefs,
      resolverVersion: 'canonical-session-membership.v1',
      resolutionRevision,
      validFromUnixNs: event.eventAtUnixNs ?? (BigInt(Math.max(1, Math.trunc(event.at))) * 1_000_000n).toString(),
      sourceRefs,
    };
    const result = await this.canonicalObservability.commitSessionMemberships([membership]);
    if (result.rejected > 0) {
      this.canonicalObservability.recordGap('projection', 'dropped', event.eventId, {
        projection: 'session_membership', rejected: result.rejected,
      });
    }
  }

  async persistProjection(projection: AgentConversationProjection): Promise<void> {
    this.pruneHotState();
    const threads: T.AgentConversationThreadRecord[] = [];
    const segments: T.ConversationInstanceSegment[] = [];
    const bindings: T.AgentConversationBindingRecord[] = [];

    for (const summary of projection.summaries) {
      if (!summary.hasContent) continue;
      const records = [...(projection.interactionsByConversation.get(summary.conversationId) ?? [])]
        .sort(compareInteraction);
      if (records.length === 0) continue;
      const first = records[0];
      const last = records.at(-1)!;
      const resolvedResultIds = new Set(records.flatMap((record) =>
        record.toolResults.map((result) => result.toolCallId)));
      const pendingToolCallIds = [...new Set(records.flatMap((record) =>
        record.toolCalls
          .map((call) => call.toolCallId)
          .filter((callId) => !resolvedResultIds.has(callId))))];
      const priorThread = this.threads.get(summary.conversationId);
      const workspacePath = preferredWorkspace(summary.workspacePath, priorThread?.workspacePath);
      const logicalScopeKey = conversationLogicalScopeKey({ ...first, workspacePath });
      const latestLineage = userLineage(last);
      const thread: T.AgentConversationThreadRecord = {
        schemaVersion: 'anysentry.agent_conversation_thread.v1',
        conversationId: summary.conversationId,
        logicalScopeKey,
        ...(first.logicalAgentId ? { logicalAgentId: first.logicalAgentId } : {}),
        ...(first.logicalDefinitionId ? { logicalDefinitionId: first.logicalDefinitionId } : {}),
        ...(first.logicalScopeMode ? { logicalScopeMode: first.logicalScopeMode } : {}),
        ...(first.logicalIdentityAuthority ? { logicalIdentityAuthority: first.logicalIdentityAuthority } : {}),
        ...(first.logicalDefinitionFingerprint
          ? { definitionFingerprint: first.logicalDefinitionFingerprint } : {}),
        ...(first.profile ? { profile: first.profile } : {}),
        ...(first.profileVersion ? { profileVersion: first.profileVersion } : {}),
        ...(first.deploymentId ? { deploymentId: first.deploymentId } : {}),
        ...(first.deploymentRevision ? { deploymentRevision: first.deploymentRevision } : {}),
        ...((summary.sessionId ?? first.sessionId ?? priorThread?.sessionId)
          ? { sessionId: summary.sessionId ?? first.sessionId ?? priorThread?.sessionId } : {}),
        ...((first.sessionKey ?? priorThread?.sessionKey)
          ? { sessionKey: first.sessionKey ?? priorThread?.sessionKey } : {}),
        ...((first.providerSessionIdHash ?? priorThread?.providerSessionIdHash)
          ? { providerSessionIdHash: first.providerSessionIdHash ?? priorThread?.providerSessionIdHash } : {}),
        ...((summary.sessionIdentityQuality ?? priorThread?.sessionIdentityQuality)
          ? { sessionIdentityQuality: summary.sessionIdentityQuality ?? priorThread?.sessionIdentityQuality } : {}),
        ...((summary.sessionMode ?? priorThread?.sessionMode)
          ? { sessionMode: summary.sessionMode ?? priorThread?.sessionMode } : {}),
        ...((summary.sessionLifecycle ?? priorThread?.sessionLifecycle)
          ? { sessionLifecycle: summary.sessionLifecycle ?? priorThread?.sessionLifecycle } : {}),
        ...((summary.parentSessionId ?? priorThread?.parentSessionId)
          ? { parentSessionId: summary.parentSessionId ?? priorThread?.parentSessionId } : {}),
        ...((summary.canonicalParentSessionId ?? priorThread?.canonicalParentSessionId)
          ? { canonicalParentSessionId: summary.canonicalParentSessionId ?? priorThread?.canonicalParentSessionId } : {}),
        idSource: priorThread && threadRank(priorThread.idSource) > threadRank(summary.idSource)
          ? priorThread.idSource
          : summary.idSource,
        ...(first.tenantId ?? priorThread?.tenantId
          ? { tenantId: first.tenantId ?? priorThread?.tenantId }
          : {}),
        ...(first.environmentId ?? priorThread?.environmentId
          ? { environmentId: first.environmentId ?? priorThread?.environmentId }
          : {}),
        ...(first.environment ?? priorThread?.environment
          ? { environment: first.environment ?? priorThread?.environment }
          : {}),
        agentProduct: summary.agentProduct,
        workspacePath,
        ...(first.process?.hostId ?? priorThread?.hostId
          ? { hostId: first.process?.hostId ?? priorThread?.hostId }
          : {}),
        agentInstanceIds: [...new Set([
          ...(priorThread?.agentInstanceIds ?? []),
          ...summary.agentInstanceIds,
        ])],
        userLineageHashes: latestLineage.length >= (priorThread?.userLineageHashes.length ?? 0)
          ? latestLineage
          : priorThread!.userLineageHashes,
        pendingToolCallIds,
        lastRequestSha256: last.request.sha256,
        startedAtUnixNs: priorThread
          && BigInt(priorThread.startedAtUnixNs) < BigInt(first.startedAtUnixNs)
          ? priorThread.startedAtUnixNs
          : first.startedAtUnixNs,
        lastActivityAtUnixNs: priorThread
          && BigInt(priorThread.lastActivityAtUnixNs) > BigInt(last.endedAtUnixNs)
          ? priorThread.lastActivityAtUnixNs
          : last.endedAtUnixNs,
        resolverVersion: AGENT_CONVERSATION_RESOLVER_VERSION,
        updatedAt: Math.max(last.receivedAt, priorThread?.updatedAt ?? 0),
      };
      threads.push(thread);
      this.threads.set(thread.conversationId, thread);

      const existingSegments = this.segmentsForConversation(summary.conversationId);
      const existingInteractionIds = new Set(records.map((record) => record.interactionId));
      const latestExisting = existingSegments.at(-1);
      const firstInstanceId = records[0].agentInstanceId ?? `unlinked:${records[0].interactionId}`;
      let segment: T.ConversationInstanceSegment | undefined = latestExisting
        && latestExisting.agentInstanceId === firstInstanceId
        && !existingInteractionIds.has(latestExisting.lastInteractionId)
        ? { ...latestExisting }
        : undefined;
      const reprojectsFromStart = existingSegments[0]?.firstInteractionId
        === records[0].interactionId;
      let nextOrdinal = reprojectsFromStart
        ? 0
        : existingSegments.reduce(
            (maximum, item) => Math.max(maximum, item.ordinal),
            0,
          );
      for (const record of records) {
        const instanceId = record.agentInstanceId ?? `unlinked:${record.interactionId}`;
        if (!segment || segment.agentInstanceId !== instanceId) {
          if (segment) segments.push(segment);
          nextOrdinal += 1;
          segment = {
            schemaVersion: 'anysentry.agent_conversation_segment.v1',
            segmentId: stableId(
              'seg',
              `${summary.conversationId}\u0000${instanceId}\u0000${record.interactionId}`,
            ),
            conversationId: summary.conversationId,
            agentInstanceId: instanceId,
            ...(record.canonicalAgentInstanceId
              ? { canonicalAgentInstanceId: record.canonicalAgentInstanceId }
              : {}),
            runtimeInstanceId: record.runtimeInstanceId ?? instanceId,
            ...(record.terminalContextId ? { terminalContextId: record.terminalContextId } : {}),
            ordinal: nextOrdinal,
            startedAtUnixNs: record.startedAtUnixNs,
            firstInteractionId: record.interactionId,
            lastInteractionId: record.interactionId,
            interactionCount: 1,
            correlationQuality: record.correlationQuality ?? 'inferred',
            resolverVersion: AGENT_CONVERSATION_RESOLVER_VERSION,
            updatedAt: record.receivedAt,
          };
        } else {
          segment.lastInteractionId = record.interactionId;
          segment.interactionCount += 1;
          segment.updatedAt = Math.max(segment.updatedAt, record.receivedAt);
        }
        segment.endedAtUnixNs = record.endedAtUnixNs;
        bindings.push({
          schemaVersion: 'anysentry.agent_conversation_binding.v1',
          interactionId: record.interactionId,
          conversationId: summary.conversationId,
          segmentId: segment.segmentId,
          agentInstanceId: instanceId,
          ...(record.canonicalAgentInstanceId
            ? { canonicalAgentInstanceId: record.canonicalAgentInstanceId }
            : {}),
          ...(record.runtimeInstanceId
            ? { runtimeInstanceId: record.runtimeInstanceId }
            : {}),
          logicalScopeKey,
          ...(record.logicalAgentId ? { logicalAgentId: record.logicalAgentId } : {}),
          ...(record.logicalDefinitionId ? { logicalDefinitionId: record.logicalDefinitionId } : {}),
          ...(record.logicalIdentityAuthority ? { logicalIdentityAuthority: record.logicalIdentityAuthority } : {}),
          ...(record.logicalScopeMode ? { logicalScopeMode: record.logicalScopeMode } : {}),
          ...(record.profile ? { profile: record.profile } : {}),
          ...(record.profileVersion ? { profileVersion: record.profileVersion } : {}),
          ...(record.deploymentId ? { deploymentId: record.deploymentId } : {}),
          ...(record.deploymentRevision ? { deploymentRevision: record.deploymentRevision } : {}),
          ...(record.environmentId ? { environmentId: record.environmentId } : {}),
          evidence: summary.idSource === 'provider'
            ? ['provider_conversation_or_response_chain']
            : summary.idSource === 'runtime'
              ? ['runtime_session']
              : ['runtime_root_and_message_lineage'],
          correlationQuality: summary.idSource === 'provider'
            ? 'exact'
            : summary.idSource === 'runtime' ? 'strong' : 'inferred',
          resolverVersion: AGENT_CONVERSATION_RESOLVER_VERSION,
          decidedAt: record.receivedAt,
          updatedAt: record.receivedAt,
          ...(record.sessionId ? { sessionId: record.sessionId } : {}),
          ...(record.sessionKey ? { sessionKey: record.sessionKey } : {}),
          ...(record.providerSessionIdHash ? { providerSessionIdHash: record.providerSessionIdHash } : {}),
          ...(record.canonicalSessionId ? { canonicalSessionId: record.canonicalSessionId } : {}),
          ...(record.sessionNamespaceKey ? { sessionNamespaceKey: record.sessionNamespaceKey } : {}),
          ...(record.sessionIdentityQuality
            ? { sessionIdentityQuality: record.sessionIdentityQuality } : {}),
          ...(record.sessionResolutionRevision !== undefined
            ? { sessionResolutionRevision: record.sessionResolutionRevision }
            : {}),
          ...(record.sessionMode ? { sessionMode: record.sessionMode } : {}),
          ...(record.sessionLifecycle ? { sessionLifecycle: record.sessionLifecycle } : {}),
          ...(() => {
            const canonicalParentSessionId = record.canonicalParentSessionId
              ?? canonicalParentSessionIdForMembership(
                record.parentSessionId,
                record.sessionNamespaceKey,
              );
            if (record.parentSessionId && !canonicalParentSessionId) {
              this.canonicalObservability?.recordGap('session', 'identity_unknown', record.interactionId, {
                parent: 'namespace_unavailable',
              });
            }
            return canonicalParentSessionId
              ? { parentSessionId: canonicalParentSessionId, canonicalParentSessionId }
              : record.parentSessionId ? { parentSessionId: record.parentSessionId } : {};
          })(),
        });
      }
      if (segment) segments.push(segment);
    }

    for (const segment of segments) this.segments.set(segment.segmentId, segment);
    for (const binding of bindings) this.bindings.set(binding.interactionId, binding);
    // Materialize the versioned canonical SessionMembership projection independently of the
    // legacy V1/V2 conversation tables.  This keeps the Session contract queryable in the
    // memory-only profile as well as when PostgreSQL is configured; raw/provider IDs remain
    // compatibility fields while `sessionKey`/hash carry the namespaced identity.
    if (this.canonicalObservability && bindings.length) {
      const pendingByInteraction = new Map(
        [...(this.pendingResolution?.memberships ?? [])].map((membership) => [membership.interactionId, membership]),
      );
      const recordByInteraction = new Map(
        [...projection.interactionsByConversation.values()].flat().map((record) => [record.interactionId, record]),
      );
      const canonicalMemberships = bindings.map((binding) => {
        const pending = pendingByInteraction.get(binding.interactionId);
        const record = recordByInteraction.get(binding.interactionId);
        // Canonical SessionMembership revisions belong to the interaction's Session resolution.
        // Prefer the explicit ingest-time revision; the resolver's batch revision may advance when
        // another interaction arrives and must not manufacture a duplicate row for an unchanged
        // interaction merely because a projection query used a different subset.
        const pendingRevision = Number(record?.sessionResolutionRevision ?? pending?.resolutionRevision ?? 1);
        const baseRevision = Number.isSafeInteger(pendingRevision) && pendingRevision >= 1
          ? Math.min(CANONICAL_SESSION_REVISION_MAX, pendingRevision) : 1;
        // Ingest commits the minimal SessionMembership before a conversation/segment is known.
        // The later binding is an additive projection revision (not an in-place enrichment), which
        // keeps the raw membership immutable and avoids same-key fingerprint conflicts on every
        // read-time projection. Re-reading the same binding deterministically produces revision
        // `base+1` and therefore a duplicate, not a conflict.
        const resolutionRevision = baseRevision >= CANONICAL_SESSION_REVISION_MAX
          ? baseRevision
          : baseRevision + 1;
        const confidence: T.SessionIdentityQuality = binding.correlationQuality === 'exact'
          ? 'confirmed'
          : binding.correlationQuality === 'strong'
            ? 'strong'
            : binding.correlationQuality === 'ambiguous'
              ? 'conflict'
            // Canonical IdentityQuality intentionally has no `unknown` member; retain the
            // evidence-level coverage gap in the binding while representing the Session identity
            // as unresolved so the canonical membership validator cannot drop the whole record.
            : binding.correlationQuality === 'coverage_gap' ? 'unresolved' : 'inferred';
        const validFromUnixNs = (BigInt(Math.max(1, Math.trunc(binding.decidedAt || Date.now()))) * 1_000_000n).toString();
        const sessionKey = binding.sessionKey;
        const canonicalConfidence: T.SessionIdentityQuality = !sessionKey
          && (confidence === 'confirmed' || confidence === 'strong')
          ? 'inferred'
          : confidence;
        // The canonical lane never exposes a provider's raw session identifier as its primary
        // key.  Prefer the opaque Session ID materialized at ingest; legacy bindings fall back to
        // the namespaced key or an interaction-scoped HMAC value.
        const sessionId = record?.canonicalSessionId
          ?? binding.canonicalSessionId
          ?? canonicalSessionIdForMembership(
            record?.sessionId ?? binding.sessionId ?? binding.conversationId,
            record?.sessionNamespaceKey ?? binding.sessionNamespaceKey,
            binding.interactionId,
          );
        return {
          schemaVersion: 'anysentry.session_membership.v1' as const,
          membershipId: `sm_${createHash('sha256').update([
            binding.interactionId,
            binding.sessionKey ?? binding.sessionId ?? '',
            String(resolutionRevision),
          ].join('\0')).digest('hex').slice(0, 24)}`,
          sessionId,
          ...(sessionKey ? { sessionKey } : {}),
          ...(binding.providerSessionIdHash ? { providerSessionIdHash: binding.providerSessionIdHash } : {}),
          ...(binding.sessionNamespaceKey ? { sessionNamespaceKey: binding.sessionNamespaceKey } : {}),
          ...(() => {
            const canonicalParentSessionId = record?.canonicalParentSessionId
              ?? binding.canonicalParentSessionId
              ?? canonicalParentSessionIdForMembership(
                record?.parentSessionId ?? binding.parentSessionId,
                record?.sessionNamespaceKey ?? binding.sessionNamespaceKey,
              );
            const rawParentSessionId = record?.parentSessionId ?? binding.parentSessionId;
            if (rawParentSessionId && !canonicalParentSessionId) {
              this.canonicalObservability?.recordGap('session', 'identity_unknown', binding.interactionId, {
                parent: 'namespace_unavailable',
              });
            }
            return canonicalParentSessionId
              ? { parentSessionId: canonicalParentSessionId, canonicalParentSessionId }
              : rawParentSessionId ? { parentSessionId: rawParentSessionId } : {};
          })(),
          interactionId: binding.interactionId,
          logicalAgentId: binding.logicalAgentId,
          ...(binding.canonicalAgentInstanceId
            ? { agentInstanceId: binding.canonicalAgentInstanceId }
            : {}),
          ...(binding.runtimeInstanceId
            ? { runtimeInstanceId: binding.runtimeInstanceId }
            : {}),
          segmentId: binding.segmentId,
          role: pending?.role ?? 'conversation',
          confidence: canonicalConfidence,
          evidence: [...new Set([
            ...binding.evidence,
            ...(record?.rawObservationId ? [record.rawObservationId] : []),
          ])].slice(0, 128),
          resolverVersion: 'canonical-session-membership.v1',
          resolutionRevision,
          validFromUnixNs,
          sourceRefs: [...new Set([
            binding.interactionId,
            ...(record?.rawObservationId ? [record.rawObservationId] : []),
          ])].slice(0, 128),
        };
      });
      const canonicalCommit = await this.canonicalObservability.commitSessionMemberships(canonicalMemberships);
      if (canonicalCommit.rejected > 0) {
        this.canonicalObservability.recordGap(
          'projection',
          'dropped',
          'session_membership',
          { rejected: canonicalCommit.rejected },
        );
      }
    }
    if (this.relationalStore?.configured()) {
      const changedThreads = this.changedForPersistence(
        'thread', threads, (item) => item.conversationId,
      );
      const changedSegments = this.changedForPersistence(
        'segment', segments, (item) => item.segmentId,
      );
      const changedBindings = this.changedForPersistence(
        'binding', bindings, (item) => item.interactionId,
      );
      const savedV1 = await this.relationalStore.saveAgentConversationResolution(
        changedThreads,
        changedSegments,
        changedBindings,
      );
      if (savedV1) {
        this.rememberPersisted('thread', changedThreads, (item) => item.conversationId);
        this.rememberPersisted('segment', changedSegments, (item) => item.segmentId);
        this.rememberPersisted('binding', changedBindings, (item) => item.interactionId);
      }
      const pending = this.pendingResolution;
      if (pending) {
        const bindingByInteraction = new Map(bindings.map((binding) => [
          binding.interactionId,
          binding,
        ]));
        const memberships = pending.memberships.map((membership) => {
          const binding = bindingByInteraction.get(membership.interactionId);
          return binding && membership.canonicalConversationId
            ? {
                ...membership,
                canonicalConversationId: binding.conversationId,
                segmentId: binding.segmentId,
              }
            : membership;
        });
        const rawAnchors = pending.records.flatMap((record) =>
          (record.conversationAnchors ?? []).map((anchor) => ({
            interactionId: record.interactionId,
            logicalScopeKey: conversationLogicalScopeKey(record),
            observedAt: record.receivedAt,
            anchor,
          })));
        const boundedAnchors = this.boundV2PersistenceItems(rawAnchors, V2_PERSIST_MAX_ANCHORS);
        const boundedMemberships = this.boundV2PersistenceItems(
          memberships,
          V2_PERSIST_MAX_MEMBERSHIPS,
        );
        const boundedAliases = this.boundV2PersistenceItems(
          pending.aliases,
          V2_PERSIST_MAX_ALIASES,
        );
        const boundedActivities = this.boundV2PersistenceItems(
          pending.technicalActivities,
          V2_PERSIST_MAX_TECHNICAL,
        );
        if (boundedAnchors.truncated || boundedMemberships.truncated
          || boundedAliases.truncated || boundedActivities.truncated) {
          this.canonicalObservability?.recordGap(
            'projection',
            'truncated',
            'conversation_resolution_v2',
            {
              anchors: rawAnchors.length,
              memberships: memberships.length,
              aliases: pending.aliases.length,
              technicalActivities: pending.technicalActivities.length,
            },
          );
        }
        const changedAnchors = this.changedForPersistence(
          'anchor', boundedAnchors.items,
          (item) => [
            item.interactionId,
            item.anchor.kind,
            item.anchor.namespace,
            item.anchor.valueHash,
          ].join('\u0000'),
        );
        const changedMemberships = this.changedForPersistence(
          'membership', boundedMemberships.items,
          (item) => `${item.interactionId}\u0000${item.resolutionRevision}`,
        );
        const changedAliases = this.changedForPersistence(
          'alias', boundedAliases.items, (item) => item.aliasConversationId,
        );
        const changedActivities = this.changedForPersistence(
          'technical', boundedActivities.items, (item) => item.technicalActivityId,
        );
        const savedV2 = await this.relationalStore.saveAgentConversationResolutionV2?.(
          changedAnchors,
          changedMemberships,
          changedAliases,
          changedActivities,
        );
        if (savedV2 === false) {
          this.canonicalObservability?.recordGap(
            'projection',
            'storage_unavailable',
            'conversation_resolution_v2',
            {
              anchors: changedAnchors.length,
              memberships: changedMemberships.length,
              aliases: changedAliases.length,
              technicalActivities: changedActivities.length,
            },
          );
        }
        if (savedV2) {
          this.rememberPersisted('anchor', changedAnchors, (item) => [
            item.interactionId,
            item.anchor.kind,
            item.anchor.namespace,
            item.anchor.valueHash,
          ].join('\u0000'));
          this.rememberPersisted('membership', changedMemberships,
            (item) => `${item.interactionId}\u0000${item.resolutionRevision}`);
          this.rememberPersisted('alias', changedAliases, (item) => item.aliasConversationId);
          this.rememberPersisted('technical', changedActivities, (item) => item.technicalActivityId);
        }
      }
    }
    this.pruneHotState();
  }

  segmentsForConversation(conversationId: string): T.ConversationInstanceSegment[] {
    this.pruneHotState();
    const canonical = this.canonicalConversationId(conversationId);
    return collapseContainedSegments([...this.segments.values()]
      .filter((segment) => segment.conversationId === canonical));
  }

  routeAlias(conversationId: string): ConversationRouteAliasV1 | undefined {
    this.pruneHotState();
    const alias = this.routeAliases.get(conversationId);
    return alias ? { ...alias, evidence: [...alias.evidence] } : undefined;
  }

  async resolveRouteAlias(conversationId: string): Promise<ConversationRouteAliasV1 | undefined> {
    const remembered = this.routeAlias(conversationId);
    if (remembered || !this.relationalStore?.configured()) return remembered;
    const loaded = await this.relationalStore.loadAgentConversationRouteAliases?.([conversationId]) ?? [];
    for (const alias of loaded) this.routeAliases.set(alias.aliasConversationId, alias);
    return this.routeAlias(conversationId);
  }

  /**
   * Resolve the exact current membership used to hydrate a selected Thread Timeline.
   *
   * PostgreSQL is authoritative when available. The in-memory maps are only a bounded hot fallback
   * and are therefore explicitly marked non-durable so callers cannot claim complete coverage.
   */
  async interactionIdsForConversation(
    conversationId: string,
    limit = 5_000,
  ): Promise<AgentConversationInteractionSelection> {
    const boundedLimit = Math.max(1, Math.min(10_000, Math.trunc(limit)));
    const canonical = this.canonicalConversationId(conversationId);
    if (this.relationalStore?.configured()) {
      const stored = await this.relationalStore.loadAgentConversationInteractionIds(
        canonical,
        boundedLimit,
      );
      if (stored) return { ...stored, durable: true };
    }
    const interactionIds = [...new Set([
      ...[...this.membershipsV2.values()]
        .filter((membership) => membership.canonicalConversationId
          && this.canonicalConversationId(membership.canonicalConversationId) === canonical)
        .map((membership) => membership.interactionId),
      ...[...this.bindings.values()]
        .filter((binding) => this.canonicalConversationId(binding.conversationId) === canonical)
        .map((binding) => binding.interactionId),
    ])].sort();
    return {
      interactionIds: interactionIds.slice(0, boundedLimit),
      truncated: interactionIds.length > boundedLimit,
      durable: false,
    };
  }

  canonicalConversationId(conversationId: string): string {
    let current = conversationId;
    const seen = new Set<string>();
    while (!seen.has(current)) {
      seen.add(current);
      const alias = this.routeAliases.get(current);
      if (!alias || alias.targetType !== 'conversation' || !alias.canonicalConversationId) break;
      current = alias.canonicalConversationId;
    }
    return current;
  }

  listTechnicalActivities(agentInstanceId?: string): TechnicalActivityProjection[] {
    return [...this.technicalActivities.values()]
      .filter((activity) => !agentInstanceId || activity.agentInstanceId === agentInstanceId)
      .sort((left, right) => BigInt(left.startedAtUnixNs) < BigInt(right.startedAtUnixNs) ? -1 : 1)
      .map((activity) => ({
        ...activity,
        interactionIds: [...activity.interactionIds],
        methods: [...activity.methods],
        paths: [...activity.paths],
      }));
  }

  currentResolutionRevision(): number {
    return Math.max(1, this.resolutionRevision);
  }
}
