export type LocalRecordActivityStatus = 'active' | 'recent' | 'stopped';
export type LocalRecordProcessStatus = 'running' | 'exited' | 'unknown';
export type LocalRecordAdapter = 'codex' | 'a3s_code' | 'claude_code' | 'gemini_cli' | 'kimi_cli' | 'opencode';
export type LocalRecordProcessEvidence =
  | 'proc_fd'
  | 'ebpf_session_file'
  | 'sticky_binding'
  | 'live_agent'
  | 'observed_exit'
  | 'binding_replaced'
  | 'not_observed'
  | 'unavailable';
export type LocalRecordMetricScope = 'full_record' | 'recent_window';

export interface LocalRecordTokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  contextWindow?: number;
}

export interface LocalRecordSummary {
  recordId: string;
  adapter: LocalRecordAdapter;
  sessionId: string;
  title: string;
  cwd?: string;
  model?: string;
  modelProvider?: string;
  originator?: string;
  cliVersion?: string;
  startedAt: number;
  updatedAt: number;
  fileBytes: number;
  processStatus: LocalRecordProcessStatus;
  processEvidence: LocalRecordProcessEvidence;
  processPid?: number;
  processObservedAt?: number;
  activityStatus: LocalRecordActivityStatus;
  metricScope: LocalRecordMetricScope;
  userMessageCount: number;
  assistantMessageCount: number;
  completeTurnCount: number;
  toolCallCount: number;
  toolFailureCount: number;
  tokenUsage: LocalRecordTokenUsage;
}

export interface LocalRecordTrackingStatus {
  schemaVersion: 'anysentry.local-record-tracking-status.v1';
  enabled: boolean;
  adapter: LocalRecordAdapter | 'multi';
  adapters: LocalRecordAdapter[];
  rootConfigured: boolean;
  rootAccessible: boolean;
  rootDisplay?: string;
  recordCount: number;
  readMode: 'bounded_read_only';
  contentSource: 'local_session_files';
  systemEvidence: 'host_proc_fd' | 'not_collected' | 'unavailable';
  processObservation: {
    enabled: boolean;
    available: boolean;
    source: 'host_proc_fd' | 'not_configured' | 'unavailable';
    rootDisplay?: string;
    lastError?: string;
  };
  lastError?: string;
  limitations: string[];
  updateTime: string;
}

export interface LocalRecordList {
  schemaVersion: 'anysentry.local-record-list.v1';
  status: LocalRecordTrackingStatus;
  items: LocalRecordSummary[];
  total: number;
  aggregates: {
    runningProcesses: number;
    exitedRecords: number;
    unknownProcessRecords: number;
    activeRecords: number;
    recentRecords: number;
    totalBytes: number;
    observedTokens: number;
    observedToolCalls: number;
  };
  updateTime: string;
}

export type LocalRecordEventKind =
  | 'turn_start'
  | 'user_message'
  | 'assistant_message'
  | 'tool_call'
  | 'tool_result'
  | 'turn_complete'
  | 'system_event';

export interface LocalRecordTimelineEvent {
  eventId: string;
  kind: LocalRecordEventKind;
  timestamp: number;
  turnId?: string;
  role?: 'user' | 'assistant' | 'system';
  phase?: string;
  title: string;
  content?: string;
  toolName?: string;
  command?: string;
  workdir?: string;
  callId?: string;
  status?: 'observed' | 'success' | 'failure' | 'unknown';
  durationMs?: number;
  timeToFirstTokenMs?: number;
  /** kimi-code subagent journal id (e.g. `agent-0`); unset for the session's main agent. */
  agentId?: string;
  sourceOffset: number;
}

export interface LocalRecordDetailMetrics {
  scope: LocalRecordMetricScope;
  scannedBytes: number;
  fileBytes: number;
  messageCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  turnCount: number;
  completeTurnCount: number;
  toolCallCount: number;
  toolResultCount: number;
  toolFailureCount: number;
  completedDurationMs: number;
  averageTimeToFirstTokenMs?: number;
  tokenUsage: LocalRecordTokenUsage;
}

export interface LocalObservedLlmRequest {
  interactionId: string;
  observedAt: number;
  pid: number;
  tid?: number;
  protocol: 'http1' | 'websocket';
  providerHost: string;
  requestPath: string;
  endpointAttribution:
    | 'observed_headers'
    | 'observed_handshake'
    | 'configured_endpoint'
    | 'configured_late_attach';
  provider?: string;
  model?: string;
  sessionId: string;
  threadId: string;
  turnId?: string;
  windowId?: string;
  requestKind?: string;
  content?: string;
  contentBytes: number;
  contentSha256: string;
  contentAvailability:
    | 'available'
    | 'deleted'
    | 'unavailable'
    | 'not_authorized'
    | 'not_requested';
  capture: {
    method: 'ebpf_rustls' | 'ebpf_openssl' | 'ebpf_boringssl';
    profile: 'exact_pid_runtime' | 'exact_binary_runtime';
    completeness: 'complete' | 'partial' | 'truncated';
    parseStatus: 'parsed';
  };
}

export interface LocalSessionSystemEvidence {
  schemaVersion: 'anysentry.local-session-system-evidence.v1';
  conversationId: string;
  evidenceScope?: 'current_generation' | 'historical_persisted' | 'historical_reconstructed' | 'mixed';
  binding: {
    bindingId: string;
    bindingRevision: number;
    nativeSessionId: string;
    runtimeProcessInstanceId?: string;
    matchedOsProcessInstanceKey: string;
    matchedPid: number;
    launcherProcessInstanceKey?: string;
    launcherPid?: number;
    agentRootProcessInstanceKey?: string;
    agentInstanceId?: string;
    method: 'proc_fd' | 'ebpf_session_file' | 'controlled_launch' | 'observer_request' | 'tool_exec_exact';
    confidence: number;
  };
  persistence: 'persisted' | 'not_checked' | 'degraded';
  completeness: 'complete_as_observed' | 'partial' | 'unavailable';
  counts: {
    direct: number;
    lineage: number;
    ambiguous: number;
    conflict: number;
    unattributed: number;
  };
  page: {
    requestedLimit: number;
    totalRelations: number;
    loadedRelations: number;
    returnedEvents: number;
    unavailableEvents: number;
    totalLineageEdges: number;
    returnedLineageEdges: number;
    processFamilyTruncated?: boolean;
    hasMore: boolean;
  };
  lineage: Array<{
    edgeId: string;
    parentProcessInstanceKey: string;
    childProcessInstanceKey: string;
    parentPid: number;
    childPid: number;
    validFrom: number;
    validTo?: number;
  }>;
  events: Array<{
    relationId: string;
    relation: 'DIRECT' | 'LINEAGE';
    toolCallBinding?: {
      method: 'authenticated_agent_adapter';
      toolCallId: string;
      invocationId?: string;
    };
    confidence: number;
    eventId: string;
    at: number;
    eventKind: string;
    eventCategory: string;
    subject: string;
    processInstanceKey: string;
    pid?: number;
    ppid?: number;
    command?: string;
    commandHash?: string;
    verdict: string;
    tier: string;
    severity: string;
    riskScore: number;
    decisionRevision?: number;
    traceId?: string;
    spanId?: string;
  }>;
  /** Observed events before an exact same-generation Agent identity transition; not Session evidence. */
  startupContext?: Array<{
    eventId: string;
    at: number;
    previousAgentInstanceId: string;
    identityObservedAt: number;
  }>;
  exceptions: Array<{
    resultId: string;
    eventId: string;
    status: 'AMBIGUOUS' | 'CONFLICT';
    reason: string;
    candidateConversationIds: string[];
  }>;
  calculatedAt: number;
}

/** Read-only associations within the returned semantic/system windows. Candidates are not facts. */
export interface LocalToolEvidence {
  schemaVersion: 'anysentry.local-tool-evidence.v1';
  nativeSessionId: string;
  scope: 'loaded_window';
  partial: boolean;
  calls: Array<{
    callEventId: string;
    callId?: string;
    status: 'confirmed' | 'candidate' | 'ambiguous' | 'unmatched' | 'pending' | 'unsupported';
    confirmedEventIds: string[];
    candidates: Array<{
      eventId: string;
      anchorEventId: string;
      reason: 'exact_command' | 'shell_wrapper' | 'command_hash' | 'process_lineage';
    }>;
  }>;
}

export interface LocalRecordDetail {
  schemaVersion: 'anysentry.local-record-detail.v1';
  record: LocalRecordSummary;
  events: LocalRecordTimelineEvent[];
  observedLlmRequests: LocalObservedLlmRequest[];
  systemEvidence?: LocalSessionSystemEvidence;
  toolEvidence?: LocalToolEvidence;
  metrics: LocalRecordDetailMetrics;
  page: {
    beforeOffset: number;
    nextBeforeOffset?: number;
    hasMore: boolean;
    returnedEvents: number;
    scannedFromOffset: number;
    scannedToOffset: number;
    truncatedLines: number;
  };
  provenance: {
    source:
      | 'codex_local_session'
      | 'a3s_code_local_session'
      | 'claude_code_local_session'
      | 'gemini_cli_local_session'
      | 'kimi_cli_local_session'
      | 'opencode_local_session';
    captureMethod: 'local_file_read';
    readOnly: true;
    ebpfIncluded: boolean;
    observerRequestEvidence: 'observed' | 'not_observed' | 'unavailable';
    observerSource: 'anysentry_observer';
    toolSemantics: 'agent_declared';
  };
  updateTime: string;
}
