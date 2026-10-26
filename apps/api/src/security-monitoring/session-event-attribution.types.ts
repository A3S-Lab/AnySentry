import { createHash } from 'node:crypto';

export const SESSION_EVENT_ATTRIBUTION_ALGORITHM = 'session_process_lineage' as const;
export const SESSION_EVENT_ATTRIBUTION_VERSION = 13 as const;

export type SessionEventAttributionStatus =
  | 'DIRECT'
  | 'LINEAGE'
  | 'AMBIGUOUS'
  | 'CONFLICT'
  | 'UNATTRIBUTED';

export interface SessionProcessBinding {
  schemaVersion: 'anysentry.session_process_binding.v1';
  bindingId: string;
  bindingRevision: number;
  tenantId: string;
  environmentId: string;
  collectorId: string;
  hostId: string;
  runtimeType: string;
  nativeSessionId: string;
  conversationId: string;
  runtimeProcessInstanceId?: string;
  matchedOsProcessInstanceKey: string;
  matchedPid: number;
  matchedStartTime: string;
  launcherProcessInstanceKey?: string;
  launcherStartTime?: string;
  launcherPid?: number;
  agentRootProcessInstanceKey?: string;
  agentInstanceId?: string;
  bootId: string;
  pidNamespace?: string;
  validFrom: number;
  validTo?: number;
  method: 'proc_fd' | 'ebpf_session_file' | 'controlled_launch' | 'observer_request' | 'tool_exec_exact';
  confidence: number;
  observedAt: number;
}

/**
 * Evidence available before a durable SessionProcessBinding exists.
 *
 * The FD scan provides the PID generation. Observer lifecycle facts provide the host/boot/
 * namespace scope. Runtime interaction metadata is optional enrichment and must never be a
 * prerequisite for Session-level system evidence.
 */
export interface SessionProcessBindingCandidate {
  tenantId?: string;
  environmentId?: string;
  collectorId?: string;
  runtimeType: string;
  nativeSessionId: string;
  conversationId?: string;
  runtimeProcessInstanceId?: string;
  matchedPid: number;
  matchedStartTime: string;
  launcherPid?: number;
  launcherStartTime?: string;
  agentInstanceId?: string;
  validFrom: number;
  validTo?: number;
  method?: SessionProcessBinding['method'];
  confidence?: number;
  observedIdentity?: {
    processInstanceKey: string;
    hostId: string;
    bootId: string;
    pidNamespace?: string;
  };
}

export interface ProcessLineageEdge {
  schemaVersion: 'anysentry.process_lineage_edge.v1';
  edgeId: string;
  childProcessInstanceKey: string;
  parentProcessInstanceKey: string;
  hostId?: string;
  bootId: string;
  pidNamespace?: string;
  childPid: number;
  parentPid: number;
  validFrom: number;
  validTo?: number;
  evidenceType: 'DIRECT_OBSERVED';
  sourceEventId: string;
  observedAt: number;
}

export interface EventSessionAttributionResult {
  schemaVersion: 'anysentry.event_session_attribution_result.v1';
  resultId: string;
  eventId: string;
  conversationId?: string;
  bindingId?: string;
  bindingRevision?: number;
  processInstanceKey?: string;
  status: SessionEventAttributionStatus;
  reason:
    | 'exact_session_process'
    | 'trusted_process_lineage'
    | 'multiple_active_sessions'
    | 'agent_identity_conflict'
    | 'before_agent_identity_transition'
    | 'missing_process_identity'
    | 'binding_context_unavailable'
    | 'outside_binding_interval'
    | 'lineage_not_observed';
  candidateConversationIds: string[];
  attributionAlgorithm: typeof SESSION_EVENT_ATTRIBUTION_ALGORITHM;
  attributionVersion: typeof SESSION_EVENT_ATTRIBUTION_VERSION;
  calculatedAt: number;
}

export interface EventSessionRelation {
  schemaVersion: 'anysentry.event_session_relation.v1';
  relationId: string;
  eventId: string;
  eventAt?: number;
  bindingContextHash?: string;
  conversationId: string;
  bindingId: string;
  bindingRevision: number;
  processInstanceKey: string;
  relation: 'DIRECT' | 'LINEAGE';
  confidence: number;
  /** A relation remains audit history after a newer calculation rejects it. */
  active: boolean;
  effectiveFrom: number;
  effectiveTo?: number;
  supersededByResultId?: string;
  attributionAlgorithm: typeof SESSION_EVENT_ATTRIBUTION_ALGORITHM;
  attributionVersion: typeof SESSION_EVENT_ATTRIBUTION_VERSION;
  createdAt: number;
}

function digest(parts: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24);
}

export function scopedConversationId(input: Pick<
  SessionProcessBinding,
  'tenantId' | 'environmentId' | 'collectorId' | 'hostId' | 'runtimeType' | 'nativeSessionId'
>): string {
  return `conv_local_${digest([
    input.tenantId,
    input.environmentId,
    input.collectorId,
    input.hostId,
    input.runtimeType,
    input.nativeSessionId,
  ])}`;
}

export function sessionProcessBindingId(input: Pick<
  SessionProcessBinding,
  'tenantId' | 'environmentId' | 'collectorId' | 'hostId' | 'runtimeType' | 'nativeSessionId' | 'matchedOsProcessInstanceKey'
>): string {
  return `spb_${digest([
    input.tenantId,
    input.environmentId,
    input.collectorId,
    input.hostId,
    input.runtimeType,
    input.nativeSessionId,
    input.matchedOsProcessInstanceKey,
  ])}`;
}

export function processLineageEdgeId(input: Pick<
  ProcessLineageEdge,
  'childProcessInstanceKey' | 'parentProcessInstanceKey' | 'validFrom' | 'sourceEventId'
>): string {
  return `ple_${digest([
    input.childProcessInstanceKey,
    input.parentProcessInstanceKey,
    input.validFrom,
    input.sourceEventId,
  ])}`;
}

export function eventSessionResultId(input: {
  eventId: string;
  conversationId?: string;
  bindingRevision?: number;
}): string {
  return `esar_${digest([
    input.eventId,
    input.conversationId ?? '',
    input.bindingRevision ?? 0,
    SESSION_EVENT_ATTRIBUTION_ALGORITHM,
    SESSION_EVENT_ATTRIBUTION_VERSION,
  ])}`;
}

export function eventSessionRelationId(input: Pick<
  EventSessionRelation,
  'eventId' | 'conversationId' | 'bindingRevision'
>): string {
  return `esr_${digest([
    input.eventId,
    input.conversationId,
    input.bindingRevision,
    SESSION_EVENT_ATTRIBUTION_ALGORITHM,
    SESSION_EVENT_ATTRIBUTION_VERSION,
  ])}`;
}
