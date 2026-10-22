import { createHash } from 'node:crypto';

export const INTERACTION_METADATA_SCHEMA = 'anysentry.interaction-metadata.v1' as const;
export const INTERACTION_INSTRUCTION_SCHEMA = 'anysentry.interaction-instruction.v1' as const;
export const INTERACTION_RESPONSE_SCHEMA = 'anysentry.interaction-response.v1' as const;
export const INTERACTION_KAFKA_SCHEMA = 'anysentry.interaction-envelope.v1' as const;
export const INTERACTION_CONTENT_MAX_BYTES = 256 * 1024;

export type InteractionTimingScope = 'connection' | 'unavailable';
export type InteractionAvailability = 'available' | 'unavailable';

export interface InteractionProcessInput {
  hostId?: string;
  bootId?: string;
  pid: number;
  tid?: number;
  startTimeTicks?: string;
  pidNamespace?: string;
  namespacePid?: number;
  namespacePpid?: number;
  comm?: string;
  exe?: string;
  cgroupId?: string;
}

/**
 * Stable conversation identity supplied by an Agent runtime.
 *
 * Runtime history must not be represented as a fake OS process. Projected records retain the
 * legacy `processInstanceId` storage field, but runtime records derive it from this thread.
 */
export type InteractionEbpfRuntimeType =
  | 'codex_ebpf_rustls'
  | 'a3s_code_ebpf_tls'
  | 'claude_code_ebpf_tls'
  | 'gemini_cli_ebpf_openssl'
  | 'kimi_cli_ebpf_openssl';

export interface InteractionRuntimeInput {
  runtimeType: 'codex_app_server' | InteractionEbpfRuntimeType;
  threadId: string;
  sessionId: string;
  source: string;
  cliVersion?: string;
  modelProvider?: string;
}

export const INTERACTION_EBPF_RUNTIME_TYPES = [
  'codex_ebpf_rustls',
  'a3s_code_ebpf_tls',
  'claude_code_ebpf_tls',
  'gemini_cli_ebpf_openssl',
  'kimi_cli_ebpf_openssl',
] as const satisfies readonly InteractionEbpfRuntimeType[];

export type InteractionInstructionInput =
  | {
      protocol: 'native_stdio';
      inputScope: 'agent_process_stdin';
      fd: 0;
    }
  | {
      protocol: 'codex_app_server';
      inputScope: 'codex_thread_user_message';
      itemId: string;
    }
  | {
      protocol: 'responses_api' | 'messages_api' | 'generate_content_api' | 'chat_completions_api';
      inputScope: 'llm_request_user_message';
      requestPath: string;
      transportProtocol: 'http1' | 'websocket';
      providerHost: string;
      endpointAttribution:
        | 'observed_headers'
        | 'observed_handshake'
        | 'configured_endpoint'
        | 'configured_late_attach';
      requestKind?: string;
      windowId?: string;
      model?: string;
    };

export type InteractionResponseOutput =
  | {
      protocol: 'native_stdio';
      outputScope: 'agent_process_stdout';
      fd: 1;
    }
  | {
      protocol: 'codex_app_server';
      outputScope: 'codex_thread_agent_message';
      itemId: string;
    }
  | {
      protocol: 'responses_api' | 'messages_api' | 'generate_content_api' | 'chat_completions_api';
      outputScope: 'llm_response_assistant_message';
      requestPath: string;
      transportProtocol: 'http1' | 'websocket';
      providerHost: string;
      endpointAttribution:
        | 'observed_headers'
        | 'observed_handshake'
        | 'configured_endpoint'
        | 'configured_late_attach';
      model?: string;
      statusCode?: number;
      finishReason?: string;
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      // Tool-call arguments are model-generated payload and stay in the encrypted content lane;
      // metadata carries only the callable identity needed for intent/execution cross-checks.
      toolCalls?: { id?: string; name: string }[];
    };

export type InteractionContentCapture =
  | {
      captureMethod: 'ebpf_stdin' | 'ebpf_stdout';
      captureProfile: 'isolated_fixture';
      captureMode: 'encrypted_full';
      captureCompleteness: 'complete' | 'partial' | 'truncated';
      parseStatus: 'boundary_observed';
      rawRetentionState: 'encrypted';
      presentationState: 'redacted';
    }
  | {
      captureMethod: 'codex_app_server';
      captureProfile: 'runtime_adapter';
      captureMode: 'encrypted_full';
      captureCompleteness: 'complete' | 'partial' | 'truncated';
      parseStatus: 'parsed';
      rawRetentionState: 'encrypted';
      presentationState: 'redacted';
    }
  | {
      captureMethod: 'ebpf_rustls' | 'ebpf_openssl' | 'ebpf_boringssl';
      captureProfile: 'exact_pid_runtime' | 'exact_binary_runtime';
      captureMode: 'encrypted_full';
      captureCompleteness: 'complete' | 'partial' | 'truncated';
      parseStatus: 'parsed';
      rawRetentionState: 'encrypted';
      presentationState: 'redacted';
    };

export interface InteractionTransportInput {
  sni?: string;
  provider?: string;
  peer?: string;
  protocol?: 'unknown' | 'http1' | 'http2' | 'websocket';
  requestBytes?: number;
  responseBytes?: number;
  timingScope: InteractionTimingScope;
  latencyAvailability: InteractionAvailability;
  latencyMs?: number;
  ttftAvailability: InteractionAvailability;
  ttftApproxMs?: number;
}

export interface InteractionTurnInput {
  sourceTurnId: string;
  sequence?: number;
}

export interface InteractionMetadataIngest {
  schemaVersion: typeof INTERACTION_METADATA_SCHEMA;
  eventType: 'LlmTransportObserved';
  sourceEventId: string;
  collectorId: string;
  observedAt: number;
  agentInstanceId?: string;
  workspacePath?: string;
  process: InteractionProcessInput;
  transport: InteractionTransportInput;
  capture: {
    captureMethod: 'ebpf_transport';
    captureMode: 'metadata';
    captureCompleteness: 'unavailable';
    parseStatus: 'not_attempted';
    rawRetentionState: 'not_retained';
    presentationState: 'metadata_only';
  };
}

export interface InteractionMetadataRecord extends InteractionMetadataIngest {
  interactionId: string;
  conversationId: string;
  sourceId: string;
  tenantId: string;
  environmentId?: string;
  processInstanceId: string;
  acceptedAt: number;
  projectedAt?: number;
}

export interface InteractionInstructionMetadataIngest {
  schemaVersion: typeof INTERACTION_INSTRUCTION_SCHEMA;
  eventType: 'AgentInputObserved';
  sourceEventId: string;
  collectorId: string;
  observedAt: number;
  agentInstanceId?: string;
  workspacePath?: string;
  turn?: InteractionTurnInput;
  process?: InteractionProcessInput;
  runtime?: InteractionRuntimeInput;
  input: InteractionInstructionInput;
  capture: InteractionContentCapture;
  userInstruction: {
    eventType: 'UserInstructionObserved';
    messageRole: 'user';
    contentBytes: number;
    contentSha256: string;
  };
}

export interface InteractionInstructionIngest
  extends Omit<InteractionInstructionMetadataIngest, 'userInstruction'> {
  userInstruction: InteractionInstructionMetadataIngest['userInstruction'] & {
    content: string;
  };
}

export interface ValidatedInteractionInstruction {
  metadata: InteractionInstructionMetadataIngest;
  content: string;
}

export interface InteractionInstructionRecord
  extends InteractionInstructionMetadataIngest {
  interactionId: string;
  conversationId: string;
  sourceId: string;
  tenantId: string;
  environmentId?: string;
  processInstanceId: string;
  turnId?: string;
  turnSequence?: number;
  turnCorrelation: 'explicit_source_turn' | 'unassigned';
  acceptedAt: number;
  projectedAt?: number;
  contentAvailability?: 'available' | 'deleted';
  /** UOS plaintext: inline body for merged timeline rendering (truncated). */
  content?: string;
  /** UOS plaintext: original captured body (unparsed fallback view, truncated). */
  rawBody?: string;
  /** UOS plaintext: captured transport/collection metadata for the raw view. */
  rawMeta?: Record<string, unknown>;
  userInstruction: InteractionInstructionMetadataIngest['userInstruction'] & {
    contentRef: string;
  };
}

export interface InteractionResponseMetadataIngest {
  schemaVersion: typeof INTERACTION_RESPONSE_SCHEMA;
  eventType: 'AgentOutputObserved';
  sourceEventId: string;
  collectorId: string;
  observedAt: number;
  agentInstanceId?: string;
  workspacePath?: string;
  turn?: InteractionTurnInput;
  process?: InteractionProcessInput;
  runtime?: InteractionRuntimeInput;
  output: InteractionResponseOutput;
  capture: InteractionContentCapture;
  assistantResponse: {
    eventType: 'AssistantResponseObserved';
    messageRole: 'assistant';
    phase?: 'commentary' | 'final_answer' | 'unknown';
    contentBytes: number;
    contentSha256: string;
  };
}

export interface InteractionResponseIngest
  extends Omit<InteractionResponseMetadataIngest, 'assistantResponse'> {
  assistantResponse: InteractionResponseMetadataIngest['assistantResponse'] & {
    content: string;
  };
}

export interface ValidatedInteractionResponse {
  metadata: InteractionResponseMetadataIngest;
  content: string;
}

export interface InteractionResponseRecord
  extends InteractionResponseMetadataIngest {
  interactionId: string;
  conversationId: string;
  sourceId: string;
  tenantId: string;
  environmentId?: string;
  processInstanceId: string;
  turnId?: string;
  turnSequence?: number;
  turnCorrelation: 'explicit_source_turn' | 'unassigned';
  acceptedAt: number;
  projectedAt?: number;
  contentAvailability?: 'available' | 'deleted';
  /** UOS plaintext: inline body for merged timeline rendering (truncated). */
  content?: string;
  /** UOS plaintext: original captured body (unparsed fallback view, truncated). */
  rawBody?: string;
  /** UOS plaintext: captured transport/collection metadata for the raw view. */
  rawMeta?: Record<string, unknown>;
  assistantResponse: InteractionResponseMetadataIngest['assistantResponse'] & {
    contentRef: string;
  };
}

export type InteractionContentRecord =
  | InteractionInstructionRecord
  | InteractionResponseRecord;

export type InteractionRecord =
  | InteractionMetadataRecord
  | InteractionInstructionRecord
  | InteractionResponseRecord;

export interface InteractionReceipt {
  schemaVersion: 'anysentry.interaction-receipt.v1';
  accepted: true;
  interactionId: string;
  sourceEventId: string;
  conversationId: string;
  contentDisposition: 'metadata_only' | 'encrypted';
  contentRef?: string;
  contentStoreDurable: boolean;
  kafkaDurable: true;
  projectionStatus: 'pending';
  acceptedAt: number;
}

export interface InteractionReceiptReservation {
  state: 'new' | 'pending' | 'accepted' | 'conflict' | 'unavailable';
  acceptedAt?: number;
}

export interface InteractionConversationSummary {
  conversationId: string;
  agentInstanceId?: string;
  processInstanceId: string;
  runtimeType?: InteractionRuntimeInput['runtimeType'];
  runtimeThreadId?: string;
  workspacePath?: string;
  provider?: string;
  collectorId: string;
  firstObservedAt: number;
  lastObservedAt: number;
  transportObservations: number;
  instructionObservations: number;
  responseObservations: number;
  completeTurns: number;
  requestBytes: number;
  responseBytes: number;
  timingScope: InteractionTimingScope;
  contentAvailable: boolean;
  /** UOS plaintext enrichment: first user-instruction preview for list display. */
  title?: string;
  /** UOS plaintext enrichment: summed token usage across the conversation's model calls. */
  tokenUsage?: { inputTokens: number; outputTokens: number; totalTokens: number };
}

export interface InteractionConversationList {
  schemaVersion: 'anysentry.interaction-conversations.v1';
  items: InteractionConversationSummary[];
  total: number;
  contentCapture: 'metadata_only' | 'encrypted_available';
  queryCompleteness: 'projected' | 'unavailable';
  updateTime: string;
}

export interface InteractionConversationDetail {
  schemaVersion: 'anysentry.interaction-conversation-detail.v1';
  conversation: InteractionConversationSummary;
  observations: InteractionRecord[];
  contentCapture: 'metadata_only' | 'encrypted_available';
}

const ROOT_KEYS = new Set([
  'schemaVersion',
  'eventType',
  'sourceEventId',
  'collectorId',
  'observedAt',
  'agentInstanceId',
  'workspacePath',
  'process',
  'transport',
  'capture',
]);
const PROCESS_KEYS = new Set([
  'hostId',
  'bootId',
  'pid',
  'tid',
  'startTimeTicks',
  'pidNamespace',
  'namespacePid',
  'namespacePpid',
  'comm',
  'exe',
  'cgroupId',
]);
const TRANSPORT_KEYS = new Set([
  'sni',
  'provider',
  'peer',
  'protocol',
  'requestBytes',
  'responseBytes',
  'timingScope',
  'latencyAvailability',
  'latencyMs',
  'ttftAvailability',
  'ttftApproxMs',
]);
const CAPTURE_KEYS = new Set([
  'captureMethod',
  'captureMode',
  'captureCompleteness',
  'parseStatus',
  'rawRetentionState',
  'presentationState',
]);
const INSTRUCTION_ROOT_KEYS = new Set([
  'schemaVersion',
  'eventType',
  'sourceEventId',
  'collectorId',
  'observedAt',
  'agentInstanceId',
  'workspacePath',
  'turn',
  'process',
  'runtime',
  'input',
  'capture',
  'userInstruction',
]);
const INPUT_KEYS = new Set([
  'protocol',
  'inputScope',
  'fd',
  'itemId',
  'requestPath',
  'transportProtocol',
  'providerHost',
  'endpointAttribution',
  'requestKind',
  'windowId',
  'model',
]);
const TURN_KEYS = new Set(['sourceTurnId', 'sequence']);
const RUNTIME_KEYS = new Set([
  'runtimeType',
  'threadId',
  'sessionId',
  'source',
  'cliVersion',
  'modelProvider',
]);
const INSTRUCTION_CAPTURE_KEYS = new Set([
  'captureMethod',
  'captureProfile',
  'captureMode',
  'captureCompleteness',
  'parseStatus',
  'rawRetentionState',
  'presentationState',
]);
const USER_INSTRUCTION_METADATA_KEYS = new Set([
  'eventType',
  'messageRole',
  'contentBytes',
  'contentSha256',
]);
const USER_INSTRUCTION_INGEST_KEYS = new Set([
  ...USER_INSTRUCTION_METADATA_KEYS,
  'content',
]);
const RESPONSE_ROOT_KEYS = new Set([
  'schemaVersion',
  'eventType',
  'sourceEventId',
  'collectorId',
  'observedAt',
  'agentInstanceId',
  'workspacePath',
  'turn',
  'process',
  'runtime',
  'output',
  'capture',
  'assistantResponse',
]);
const OUTPUT_KEYS = new Set([
  'protocol',
  'outputScope',
  'fd',
  'itemId',
  'requestPath',
  'transportProtocol',
  'providerHost',
  'endpointAttribution',
  'model',
  'statusCode',
  'finishReason',
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'toolCalls',
]);
const ASSISTANT_RESPONSE_METADATA_KEYS = new Set([
  'eventType',
  'messageRole',
  'phase',
  'contentBytes',
  'contentSha256',
]);
const ASSISTANT_RESPONSE_INGEST_KEYS = new Set([
  ...ASSISTANT_RESPONSE_METADATA_KEYS,
  'content',
]);
const FORBIDDEN_CONTENT_KEY =
  /(?:content|prompt|message|messages|query|instruction|requestbody|responsebody|payload|hmac|contenthash)/iu;

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_CONTENT_KEY.test(key)) {
      throw new Error(`${label}.${key} is forbidden in metadata-only mode`);
    }
    if (!allowed.has(key)) throw new Error(`${label}.${key} is not part of the metadata schema`);
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label}.${key} is not part of the schema`);
  }
}

function text(value: unknown, label: string, limit: number, required = false): string | undefined {
  if (value === undefined || value === null || value === '') {
    if (required) throw new Error(`${label} is required`);
    return undefined;
  }
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > limit || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

function integer(
  value: unknown,
  label: string,
  min: number,
  max: number,
  required = false,
): number | undefined {
  if (value === undefined || value === null || value === '') {
    if (required) throw new Error(`${label} is required`);
    return undefined;
  }
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
  return Number(value);
}

function literal<T extends string>(
  value: unknown,
  label: string,
  allowed: readonly T[],
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`${label} must be ${allowed.join(' or ')}`);
  }
  return value as T;
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function messageContent(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.byteLength < 1 || encoded.byteLength > INTERACTION_CONTENT_MAX_BYTES) {
    throw new Error(
      `${label} must contain 1-${INTERACTION_CONTENT_MAX_BYTES} UTF-8 bytes`,
    );
  }
  if (encoded.toString('utf8') !== value) {
    throw new Error(`${label} must be valid UTF-8 without lone surrogates`);
  }
  return value;
}

function turnInput(value: unknown, label = 'body.turn'): InteractionTurnInput | undefined {
  if (value === undefined || value === null) return undefined;
  const turn = object(value, label);
  assertExactKeys(turn, TURN_KEYS, label);
  return {
    sourceTurnId: text(turn.sourceTurnId, `${label}.sourceTurnId`, 240, true)!,
    sequence: integer(turn.sequence, `${label}.sequence`, 1, Number.MAX_SAFE_INTEGER),
  };
}

function toolCallSummaries(
  value: unknown,
  label: string,
): { id?: string; name: string }[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > 64) {
    throw new Error(`${label} must be an array of at most 64 tool calls`);
  }
  return value.map((entry, index) => {
    const item = object(entry, `${label}[${index}]`);
    assertExactKeys(item, new Set(['id', 'name']), `${label}[${index}]`);
    return {
      id: text(item.id, `${label}[${index}].id`, 240),
      name: text(item.name, `${label}[${index}].name`, 160, true)!,
    };
  });
}

function processInput(
  value: unknown,
  label = 'body.process',
): InteractionProcessInput | undefined {
  if (value === undefined || value === null) return undefined;
  const process = object(value, label);
  assertAllowedKeys(process, PROCESS_KEYS, label);
  return {
    hostId: text(process.hostId, `${label}.hostId`, 240),
    bootId: text(process.bootId, `${label}.bootId`, 160),
    pid: integer(process.pid, `${label}.pid`, 1, 4_194_304, true)!,
    tid: integer(process.tid, `${label}.tid`, 1, 4_194_304),
    startTimeTicks: text(process.startTimeTicks, `${label}.startTimeTicks`, 80),
    pidNamespace: text(process.pidNamespace, `${label}.pidNamespace`, 512),
    namespacePid: integer(process.namespacePid, `${label}.namespacePid`, 1, 4_194_304),
    namespacePpid: integer(process.namespacePpid, `${label}.namespacePpid`, 1, 4_194_304),
    comm: text(process.comm, `${label}.comm`, 160),
    exe: text(process.exe, `${label}.exe`, 1_024),
    cgroupId: text(process.cgroupId, `${label}.cgroupId`, 160),
  };
}

function runtimeInput(
  value: unknown,
  label = 'body.runtime',
): InteractionRuntimeInput | undefined {
  if (value === undefined || value === null) return undefined;
  const runtime = object(value, label);
  assertExactKeys(runtime, RUNTIME_KEYS, label);
  return {
    runtimeType: literal(
      runtime.runtimeType,
      `${label}.runtimeType`,
      ['codex_app_server', 'codex_ebpf_rustls', 'a3s_code_ebpf_tls', 'claude_code_ebpf_tls', 'gemini_cli_ebpf_openssl', 'kimi_cli_ebpf_openssl'] as const,
    ),
    threadId: text(runtime.threadId, `${label}.threadId`, 240, true)!,
    sessionId: text(runtime.sessionId, `${label}.sessionId`, 240, true)!,
    source: text(runtime.source, `${label}.source`, 160, true)!,
    cliVersion: text(runtime.cliVersion, `${label}.cliVersion`, 80),
    modelProvider: text(runtime.modelProvider, `${label}.modelProvider`, 80),
  };
}

function executionIdentity(
  root: Record<string, unknown>,
): {
  process?: InteractionProcessInput;
  runtime?: InteractionRuntimeInput;
} {
  const process = processInput(root.process);
  const runtime = runtimeInput(root.runtime);
  if (!process && !runtime) {
    throw new Error('body.process or body.runtime is required');
  }
  if (
    process
    && runtime
    && !(INTERACTION_EBPF_RUNTIME_TYPES as readonly string[]).includes(
      runtime.runtimeType,
    )
  ) {
    throw new Error(
      'body.process and body.runtime may coexist only for an exact-PID eBPF TLS observation',
    );
  }
  return { process, runtime };
}

function stableId(prefix: string, parts: Array<string | number | undefined>): string {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(String(part ?? '')).update('\0');
  return `${prefix}_${hash.digest('hex').slice(0, 32)}`;
}

export function validateInteractionMetadataIngest(value: unknown): InteractionMetadataIngest {
  const root = object(value, 'body');
  assertAllowedKeys(root, ROOT_KEYS, 'body');
  if (root.schemaVersion !== INTERACTION_METADATA_SCHEMA) {
    throw new Error(`schemaVersion must be ${INTERACTION_METADATA_SCHEMA}`);
  }
  if (root.eventType !== 'LlmTransportObserved') {
    throw new Error('eventType must be LlmTransportObserved');
  }
  const process = object(root.process, 'body.process');
  const transport = object(root.transport, 'body.transport');
  const capture = object(root.capture, 'body.capture');
  assertAllowedKeys(process, PROCESS_KEYS, 'body.process');
  assertAllowedKeys(transport, TRANSPORT_KEYS, 'body.transport');
  assertAllowedKeys(capture, CAPTURE_KEYS, 'body.capture');

  const timingScope = literal(
    transport.timingScope,
    'body.transport.timingScope',
    ['connection', 'unavailable'] as const,
  );
  const latencyAvailability = literal(
    transport.latencyAvailability,
    'body.transport.latencyAvailability',
    ['available', 'unavailable'] as const,
  );
  const ttftAvailability = literal(
    transport.ttftAvailability,
    'body.transport.ttftAvailability',
    ['available', 'unavailable'] as const,
  );
  const latencyMs = integer(transport.latencyMs, 'body.transport.latencyMs', 0, 86_400_000);
  const ttftApproxMs = integer(
    transport.ttftApproxMs,
    'body.transport.ttftApproxMs',
    0,
    86_400_000,
  );
  if (timingScope === 'unavailable' && (latencyMs !== undefined || ttftApproxMs !== undefined)) {
    throw new Error('unavailable timingScope cannot carry timing values');
  }
  if (latencyAvailability === 'unavailable' && latencyMs !== undefined) {
    throw new Error('unavailable latency cannot carry latencyMs');
  }
  if (latencyAvailability === 'available' && latencyMs === undefined) {
    throw new Error('available latency requires latencyMs');
  }
  if (ttftAvailability === 'unavailable' && ttftApproxMs !== undefined) {
    throw new Error('unavailable TTFT cannot carry ttftApproxMs');
  }
  if (ttftAvailability === 'available' && ttftApproxMs === undefined) {
    throw new Error('available TTFT requires ttftApproxMs');
  }

  return {
    schemaVersion: INTERACTION_METADATA_SCHEMA,
    eventType: 'LlmTransportObserved',
    sourceEventId: text(root.sourceEventId, 'body.sourceEventId', 240, true)!,
    collectorId: text(root.collectorId, 'body.collectorId', 180, true)!,
    observedAt: integer(root.observedAt, 'body.observedAt', 1, Number.MAX_SAFE_INTEGER, true)!,
    agentInstanceId: text(root.agentInstanceId, 'body.agentInstanceId', 240),
    workspacePath: text(root.workspacePath, 'body.workspacePath', 500),
    process: {
      hostId: text(process.hostId, 'body.process.hostId', 240),
      bootId: text(process.bootId, 'body.process.bootId', 160),
      pid: integer(process.pid, 'body.process.pid', 1, 4_194_304, true)!,
      tid: integer(process.tid, 'body.process.tid', 1, 4_194_304),
      startTimeTicks: text(process.startTimeTicks, 'body.process.startTimeTicks', 80),
      pidNamespace: text(process.pidNamespace, 'body.process.pidNamespace', 512),
      namespacePid: integer(process.namespacePid, 'body.process.namespacePid', 1, 4_194_304),
      namespacePpid: integer(process.namespacePpid, 'body.process.namespacePpid', 1, 4_194_304),
      comm: text(process.comm, 'body.process.comm', 160),
      exe: text(process.exe, 'body.process.exe', 1_024),
      cgroupId: text(process.cgroupId, 'body.process.cgroupId', 160),
    },
    transport: {
      sni: text(transport.sni, 'body.transport.sni', 253),
      provider: text(transport.provider, 'body.transport.provider', 80),
      peer: text(transport.peer, 'body.transport.peer', 160),
      protocol: transport.protocol === undefined
        ? 'unknown'
        : literal(
            transport.protocol,
            'body.transport.protocol',
            ['unknown', 'http1', 'http2', 'websocket'] as const,
          ),
      requestBytes: integer(
        transport.requestBytes,
        'body.transport.requestBytes',
        0,
        Number.MAX_SAFE_INTEGER,
      ),
      responseBytes: integer(
        transport.responseBytes,
        'body.transport.responseBytes',
        0,
        Number.MAX_SAFE_INTEGER,
      ),
      timingScope,
      latencyAvailability,
      latencyMs,
      ttftAvailability,
      ttftApproxMs,
    },
    capture: {
      captureMethod: literal(
        capture.captureMethod,
        'body.capture.captureMethod',
        ['ebpf_transport'] as const,
      ),
      captureMode: literal(capture.captureMode, 'body.capture.captureMode', ['metadata'] as const),
      captureCompleteness: literal(
        capture.captureCompleteness,
        'body.capture.captureCompleteness',
        ['unavailable'] as const,
      ),
      parseStatus: literal(
        capture.parseStatus,
        'body.capture.parseStatus',
        ['not_attempted'] as const,
      ),
      rawRetentionState: literal(
        capture.rawRetentionState,
        'body.capture.rawRetentionState',
        ['not_retained'] as const,
      ),
      presentationState: literal(
        capture.presentationState,
        'body.capture.presentationState',
        ['metadata_only'] as const,
      ),
    },
  };
}

function contentCapture(
  capture: Record<string, unknown>,
  direction: 'input' | 'output',
  source: 'native' | 'runtime_adapter' | 'ebpf_rustls',
): InteractionContentCapture {
  if (source === 'runtime_adapter') {
    return {
      captureMethod: literal(
        capture.captureMethod,
        'body.capture.captureMethod',
        ['codex_app_server'] as const,
      ),
      captureProfile: literal(
        capture.captureProfile,
        'body.capture.captureProfile',
        ['runtime_adapter'] as const,
      ),
      captureMode: literal(
        capture.captureMode,
        'body.capture.captureMode',
        ['encrypted_full'] as const,
      ),
      captureCompleteness: literal(
        capture.captureCompleteness,
        'body.capture.captureCompleteness',
        ['complete', 'partial', 'truncated'] as const,
      ),
      parseStatus: literal(
        capture.parseStatus,
        'body.capture.parseStatus',
        ['parsed'] as const,
      ),
      rawRetentionState: literal(
        capture.rawRetentionState,
        'body.capture.rawRetentionState',
        ['encrypted'] as const,
      ),
      presentationState: literal(
        capture.presentationState,
        'body.capture.presentationState',
        ['redacted'] as const,
      ),
    };
  }
  if (source === 'ebpf_rustls') {
    return {
      captureMethod: literal(
        capture.captureMethod,
        'body.capture.captureMethod',
        ['ebpf_rustls', 'ebpf_openssl', 'ebpf_boringssl'] as const,
      ),
      captureProfile: literal(
        capture.captureProfile,
        'body.capture.captureProfile',
        ['exact_pid_runtime', 'exact_binary_runtime'] as const,
      ),
      captureMode: literal(
        capture.captureMode,
        'body.capture.captureMode',
        ['encrypted_full'] as const,
      ),
      captureCompleteness: literal(
        capture.captureCompleteness,
        'body.capture.captureCompleteness',
        ['complete', 'partial', 'truncated'] as const,
      ),
      parseStatus: literal(
        capture.parseStatus,
        'body.capture.parseStatus',
        ['parsed'] as const,
      ),
      rawRetentionState: literal(
        capture.rawRetentionState,
        'body.capture.rawRetentionState',
        ['encrypted'] as const,
      ),
      presentationState: literal(
        capture.presentationState,
        'body.capture.presentationState',
        ['redacted'] as const,
      ),
    };
  }
  return {
    captureMethod: literal(
      capture.captureMethod,
      'body.capture.captureMethod',
      [direction === 'input' ? 'ebpf_stdin' : 'ebpf_stdout'] as const,
    ),
    captureProfile: literal(
      capture.captureProfile,
      'body.capture.captureProfile',
      ['isolated_fixture'] as const,
    ),
    captureMode: literal(
      capture.captureMode,
      'body.capture.captureMode',
      ['encrypted_full'] as const,
    ),
    captureCompleteness: literal(
      capture.captureCompleteness,
      'body.capture.captureCompleteness',
      ['complete', 'partial', 'truncated'] as const,
    ),
    parseStatus: literal(
      capture.parseStatus,
      'body.capture.parseStatus',
      ['boundary_observed'] as const,
    ),
    rawRetentionState: literal(
      capture.rawRetentionState,
      'body.capture.rawRetentionState',
      ['encrypted'] as const,
    ),
    presentationState: literal(
      capture.presentationState,
      'body.capture.presentationState',
      ['redacted'] as const,
    ),
  };
}

function validateInstructionMetadataObjects(
  root: Record<string, unknown>,
  instruction: Record<string, unknown>,
): InteractionInstructionMetadataIngest {
  if (root.schemaVersion !== INTERACTION_INSTRUCTION_SCHEMA) {
    throw new Error(`schemaVersion must be ${INTERACTION_INSTRUCTION_SCHEMA}`);
  }
  if (root.eventType !== 'AgentInputObserved') {
    throw new Error('eventType must be AgentInputObserved');
  }
  const input = object(root.input, 'body.input');
  const capture = object(root.capture, 'body.capture');
  assertExactKeys(input, INPUT_KEYS, 'body.input');
  assertExactKeys(capture, INSTRUCTION_CAPTURE_KEYS, 'body.capture');
  const identity = executionIdentity(root);
  const protocol = literal(
    input.protocol,
    'body.input.protocol',
    ['native_stdio', 'codex_app_server', 'responses_api', 'messages_api', 'generate_content_api', 'chat_completions_api'] as const,
  );
  const runtimeAdapter = protocol === 'codex_app_server';
  const rustlsRuntime = protocol === 'responses_api'
    || protocol === 'messages_api'
    || protocol === 'generate_content_api'
    || protocol === 'chat_completions_api';
  const ebpfRuntimeType = identity.runtime?.runtimeType;
  const ebpfRuntimeOk = Boolean(
    ebpfRuntimeType
    && (INTERACTION_EBPF_RUNTIME_TYPES as readonly string[]).includes(ebpfRuntimeType),
  );
  if (
    (runtimeAdapter && (!identity.runtime || identity.process))
    || (rustlsRuntime && (!identity.process || !ebpfRuntimeOk))
    || (!runtimeAdapter && !rustlsRuntime && (!identity.process || identity.runtime))
  ) {
    throw new Error(
      'codex_app_server requires runtime only; TLS model APIs require process plus an approved eBPF runtime; native_stdio requires process only',
    );
  }

  return {
    schemaVersion: INTERACTION_INSTRUCTION_SCHEMA,
    eventType: 'AgentInputObserved',
    sourceEventId: text(root.sourceEventId, 'body.sourceEventId', 240, true)!,
    collectorId: text(root.collectorId, 'body.collectorId', 180, true)!,
    observedAt: integer(root.observedAt, 'body.observedAt', 1, Number.MAX_SAFE_INTEGER, true)!,
    agentInstanceId: text(root.agentInstanceId, 'body.agentInstanceId', 240),
    workspacePath: text(root.workspacePath, 'body.workspacePath', 500),
    turn: turnInput(root.turn),
    ...identity,
    input: runtimeAdapter
      ? {
          protocol: 'codex_app_server',
          inputScope: literal(
            input.inputScope,
            'body.input.inputScope',
            ['codex_thread_user_message'] as const,
          ),
          itemId: text(input.itemId, 'body.input.itemId', 240, true)!,
        }
      : rustlsRuntime
        ? {
            protocol,
            inputScope: literal(
              input.inputScope,
              'body.input.inputScope',
              ['llm_request_user_message'] as const,
            ),
            requestPath: text(
              input.requestPath,
              'body.input.requestPath',
              1_024,
              true,
            )!,
            transportProtocol: literal(
              input.transportProtocol,
              'body.input.transportProtocol',
              ['http1', 'websocket'] as const,
            ),
            providerHost: text(
              input.providerHost,
              'body.input.providerHost',
              253,
              true,
            )!,
            endpointAttribution: literal(
              input.endpointAttribution,
              'body.input.endpointAttribution',
              [
                'observed_headers',
                'observed_handshake',
                'configured_endpoint',
                'configured_late_attach',
              ] as const,
            ),
            requestKind: text(input.requestKind, 'body.input.requestKind', 120),
            windowId: text(input.windowId, 'body.input.windowId', 240),
            model: text(input.model, 'body.input.model', 160),
          }
        : {
          protocol: 'native_stdio',
          inputScope: literal(
            input.inputScope,
            'body.input.inputScope',
            ['agent_process_stdin'] as const,
          ),
          fd: integer(input.fd, 'body.input.fd', 0, 0, true)! as 0,
        },
    capture: contentCapture(
      capture,
      'input',
      runtimeAdapter
        ? 'runtime_adapter'
        : rustlsRuntime
          ? 'ebpf_rustls'
          : 'native',
    ),
    userInstruction: {
      eventType: literal(
        instruction.eventType,
        'body.userInstruction.eventType',
        ['UserInstructionObserved'] as const,
      ),
      messageRole: literal(
        instruction.messageRole,
        'body.userInstruction.messageRole',
        ['user'] as const,
      ),
      contentBytes: integer(
        instruction.contentBytes,
        'body.userInstruction.contentBytes',
        1,
        INTERACTION_CONTENT_MAX_BYTES,
        true,
      )!,
      contentSha256: sha256(
        instruction.contentSha256,
        'body.userInstruction.contentSha256',
      ),
    },
  };
}

export function validateInteractionInstructionMetadataIngest(
  value: unknown,
): InteractionInstructionMetadataIngest {
  const root = object(value, 'body');
  assertExactKeys(root, INSTRUCTION_ROOT_KEYS, 'body');
  const instruction = object(root.userInstruction, 'body.userInstruction');
  assertExactKeys(
    instruction,
    USER_INSTRUCTION_METADATA_KEYS,
    'body.userInstruction',
  );
  return validateInstructionMetadataObjects(root, instruction);
}

export function validateInteractionInstructionIngest(
  value: unknown,
): ValidatedInteractionInstruction {
  const root = object(value, 'body');
  assertExactKeys(root, INSTRUCTION_ROOT_KEYS, 'body');
  const instruction = object(root.userInstruction, 'body.userInstruction');
  assertExactKeys(instruction, USER_INSTRUCTION_INGEST_KEYS, 'body.userInstruction');
  const content = messageContent(
    instruction.content,
    'body.userInstruction.content',
  );
  const metadata = validateInstructionMetadataObjects(root, instruction);
  const encoded = Buffer.from(content, 'utf8');
  if (encoded.byteLength !== metadata.userInstruction.contentBytes) {
    throw new Error('body.userInstruction.contentBytes does not match the UTF-8 content');
  }
  const digest = createHash('sha256').update(encoded).digest('hex');
  if (digest !== metadata.userInstruction.contentSha256) {
    throw new Error('body.userInstruction.contentSha256 does not match the content');
  }
  return { metadata, content };
}

function validateResponseMetadataObjects(
  root: Record<string, unknown>,
  response: Record<string, unknown>,
): InteractionResponseMetadataIngest {
  if (root.schemaVersion !== INTERACTION_RESPONSE_SCHEMA) {
    throw new Error(`schemaVersion must be ${INTERACTION_RESPONSE_SCHEMA}`);
  }
  if (root.eventType !== 'AgentOutputObserved') {
    throw new Error('eventType must be AgentOutputObserved');
  }
  const output = object(root.output, 'body.output');
  const capture = object(root.capture, 'body.capture');
  assertExactKeys(output, OUTPUT_KEYS, 'body.output');
  assertExactKeys(capture, INSTRUCTION_CAPTURE_KEYS, 'body.capture');
  const identity = executionIdentity(root);
  const protocol = literal(
    output.protocol,
    'body.output.protocol',
    [
      'native_stdio',
      'codex_app_server',
      'responses_api',
      'messages_api',
      'generate_content_api',
      'chat_completions_api',
    ] as const,
  );
  const runtimeAdapter = protocol === 'codex_app_server';
  const tlsRuntime =
    protocol === 'responses_api'
    || protocol === 'messages_api'
    || protocol === 'generate_content_api'
    || protocol === 'chat_completions_api';
  const tlsRuntimeType = identity.runtime?.runtimeType;
  const tlsRuntimeOk = Boolean(
    tlsRuntimeType
    && (INTERACTION_EBPF_RUNTIME_TYPES as readonly string[]).includes(tlsRuntimeType),
  );
  if (
    (!tlsRuntime && runtimeAdapter !== Boolean(identity.runtime))
    || (tlsRuntime && (!identity.process || !tlsRuntimeOk))
  ) {
    throw new Error(
      'codex_app_server output requires body.runtime; native_stdio requires body.process; TLS model API output requires process plus an approved eBPF runtime',
    );
  }

  return {
    schemaVersion: INTERACTION_RESPONSE_SCHEMA,
    eventType: 'AgentOutputObserved',
    sourceEventId: text(root.sourceEventId, 'body.sourceEventId', 240, true)!,
    collectorId: text(root.collectorId, 'body.collectorId', 180, true)!,
    observedAt: integer(root.observedAt, 'body.observedAt', 1, Number.MAX_SAFE_INTEGER, true)!,
    agentInstanceId: text(root.agentInstanceId, 'body.agentInstanceId', 240),
    workspacePath: text(root.workspacePath, 'body.workspacePath', 500),
    turn: turnInput(root.turn),
    ...identity,
    output: runtimeAdapter
      ? {
          protocol: 'codex_app_server' as const,
          outputScope: literal(
            output.outputScope,
            'body.output.outputScope',
            ['codex_thread_agent_message'] as const,
          ),
          itemId: text(output.itemId, 'body.output.itemId', 240, true)!,
        }
      : tlsRuntime
        ? {
            protocol,
            outputScope: literal(
              output.outputScope,
              'body.output.outputScope',
              ['llm_response_assistant_message'] as const,
            ),
            requestPath: text(output.requestPath, 'body.output.requestPath', 1_024, true)!,
            transportProtocol: literal(
              output.transportProtocol,
              'body.output.transportProtocol',
              ['http1', 'websocket'] as const,
            ),
            providerHost: text(output.providerHost, 'body.output.providerHost', 253, true)!,
            endpointAttribution: literal(
              output.endpointAttribution,
              'body.output.endpointAttribution',
              [
                'observed_headers',
                'observed_handshake',
                'configured_endpoint',
                'configured_late_attach',
              ] as const,
            ),
            model: text(output.model, 'body.output.model', 160),
            statusCode: integer(output.statusCode, 'body.output.statusCode', 100, 599),
            finishReason: text(output.finishReason, 'body.output.finishReason', 80),
            inputTokens: integer(output.inputTokens, 'body.output.inputTokens', 0, Number.MAX_SAFE_INTEGER),
            outputTokens: integer(output.outputTokens, 'body.output.outputTokens', 0, Number.MAX_SAFE_INTEGER),
            totalTokens: integer(output.totalTokens, 'body.output.totalTokens', 0, Number.MAX_SAFE_INTEGER),
            toolCalls: toolCallSummaries(output.toolCalls, 'body.output.toolCalls'),
          }
        : {
            protocol: 'native_stdio' as const,
            outputScope: literal(
              output.outputScope,
              'body.output.outputScope',
              ['agent_process_stdout'] as const,
            ),
            fd: integer(output.fd, 'body.output.fd', 1, 1, true)! as 1,
          },
    capture: contentCapture(
      capture,
      'output',
      runtimeAdapter ? 'runtime_adapter' : tlsRuntime ? 'ebpf_rustls' : 'native',
    ),
    assistantResponse: {
      eventType: literal(
        response.eventType,
        'body.assistantResponse.eventType',
        ['AssistantResponseObserved'] as const,
      ),
      messageRole: literal(
        response.messageRole,
        'body.assistantResponse.messageRole',
        ['assistant'] as const,
      ),
      phase: response.phase === undefined
        ? undefined
        : literal(
            response.phase,
            'body.assistantResponse.phase',
            ['commentary', 'final_answer', 'unknown'] as const,
          ),
      contentBytes: integer(
        response.contentBytes,
        'body.assistantResponse.contentBytes',
        1,
        INTERACTION_CONTENT_MAX_BYTES,
        true,
      )!,
      contentSha256: sha256(
        response.contentSha256,
        'body.assistantResponse.contentSha256',
      ),
    },
  };
}

export function validateInteractionResponseMetadataIngest(
  value: unknown,
): InteractionResponseMetadataIngest {
  const root = object(value, 'body');
  assertExactKeys(root, RESPONSE_ROOT_KEYS, 'body');
  const response = object(root.assistantResponse, 'body.assistantResponse');
  assertExactKeys(
    response,
    ASSISTANT_RESPONSE_METADATA_KEYS,
    'body.assistantResponse',
  );
  return validateResponseMetadataObjects(root, response);
}

export function validateInteractionResponseIngest(
  value: unknown,
): ValidatedInteractionResponse {
  const root = object(value, 'body');
  assertExactKeys(root, RESPONSE_ROOT_KEYS, 'body');
  const response = object(root.assistantResponse, 'body.assistantResponse');
  assertExactKeys(
    response,
    ASSISTANT_RESPONSE_INGEST_KEYS,
    'body.assistantResponse',
  );
  const content = messageContent(
    response.content,
    'body.assistantResponse.content',
  );
  const metadata = validateResponseMetadataObjects(root, response);
  const encoded = Buffer.from(content, 'utf8');
  if (encoded.byteLength !== metadata.assistantResponse.contentBytes) {
    throw new Error('body.assistantResponse.contentBytes does not match the UTF-8 content');
  }
  const digest = createHash('sha256').update(encoded).digest('hex');
  if (digest !== metadata.assistantResponse.contentSha256) {
    throw new Error('body.assistantResponse.contentSha256 does not match the content');
  }
  return { metadata, content };
}

export function interactionRecord(
  input: InteractionMetadataIngest,
  context: {
    sourceId: string;
    tenantId?: string;
    environmentId?: string;
    workspacePath?: string;
  },
  acceptedAt = Date.now(),
): InteractionMetadataRecord {
  const identity = interactionIdentity(input, context, acceptedAt);
  return {
    ...input,
    ...identity,
  };
}

function interactionIdentity(
  input: {
    sourceEventId: string;
    agentInstanceId?: string;
    workspacePath?: string;
    process?: InteractionProcessInput;
    runtime?: InteractionRuntimeInput;
  },
  context: {
    sourceId: string;
    tenantId?: string;
    environmentId?: string;
    workspacePath?: string;
  },
  acceptedAt: number,
) {
  const sourceId = text(context.sourceId, 'source.sourceId', 240, true)!;
  const tenantId = text(
    context.tenantId ?? 'tenant_default',
    'source.tenantId',
    240,
    true,
  )!;
  const environmentId = text(context.environmentId, 'source.environmentId', 240);
  const workspacePath = text(
    context.workspacePath ?? input.workspacePath,
    'source.workspacePath',
    500,
  );
  const processInstanceId = input.runtime
    ? stableId('runtime', [
        input.runtime.runtimeType,
        input.runtime.threadId,
      ])
    : stableId('proc', [
        input.process?.hostId,
        input.process?.bootId,
        input.process?.pid,
        input.process?.startTimeTicks,
      ]);
  const conversationId = stableId('conv_observed', [
    tenantId,
    input.agentInstanceId,
    input.runtime?.threadId ?? processInstanceId,
  ]);
  return {
    workspacePath,
    interactionId: stableId('int', [sourceId, input.sourceEventId]),
    conversationId,
    sourceId,
    tenantId,
    environmentId,
    processInstanceId,
    acceptedAt,
  };
}

export function interactionContentRef(
  sourceId: string,
  sourceEventId: string,
  role: 'user_instruction' | 'assistant_response' = 'user_instruction',
): string {
  return stableId('blob', [sourceId, sourceEventId, role]);
}

function interactionTurnIdentity(
  input: { turn?: InteractionTurnInput },
  identity: { tenantId: string; conversationId: string },
) {
  if (!input.turn) {
    return {
      turnId: undefined,
      turnSequence: undefined,
      turnCorrelation: 'unassigned' as const,
    };
  }
  return {
    turnId: stableId('turn_observed', [
      identity.tenantId,
      identity.conversationId,
      input.turn.sourceTurnId,
    ]),
    turnSequence: input.turn.sequence,
    turnCorrelation: 'explicit_source_turn' as const,
  };
}

export function interactionInstructionRecord(
  input: InteractionInstructionMetadataIngest,
  context: {
    sourceId: string;
    tenantId?: string;
    environmentId?: string;
    workspacePath?: string;
  },
  contentRef: string,
  acceptedAt = Date.now(),
): InteractionInstructionRecord {
  const identity = interactionIdentity(input, context, acceptedAt);
  return {
    ...input,
    ...identity,
    ...interactionTurnIdentity(input, identity),
    userInstruction: {
      ...input.userInstruction,
      contentRef: text(contentRef, 'contentRef', 160, true)!,
    },
  };
}

export function interactionResponseRecord(
  input: InteractionResponseMetadataIngest,
  context: {
    sourceId: string;
    tenantId?: string;
    environmentId?: string;
    workspacePath?: string;
  },
  contentRef: string,
  acceptedAt = Date.now(),
): InteractionResponseRecord {
  const identity = interactionIdentity(input, context, acceptedAt);
  return {
    ...input,
    ...identity,
    ...interactionTurnIdentity(input, identity),
    assistantResponse: {
      ...input.assistantResponse,
      contentRef: text(contentRef, 'contentRef', 160, true)!,
    },
  };
}

export function interactionContentMetadata(record: InteractionContentRecord) {
  if (record.eventType === 'AgentInputObserved') {
    return {
      contentRole: 'user_instruction' as const,
      messageRole: 'user' as const,
      contentRef: record.userInstruction.contentRef,
      contentSha256: record.userInstruction.contentSha256,
      contentBytes: record.userInstruction.contentBytes,
    };
  }
  return {
    contentRole: 'assistant_response' as const,
    messageRole: 'assistant' as const,
    contentRef: record.assistantResponse.contentRef,
    contentSha256: record.assistantResponse.contentSha256,
    contentBytes: record.assistantResponse.contentBytes,
  };
}

/**
 * Fingerprint only the immutable logical observation. Receipt/projection timestamps are
 * deliberately excluded so a lost HTTP response can be retried without creating a conflict.
 */
export function interactionPayloadFingerprint(record: InteractionRecord): string {
  const immutable = {
    schemaVersion: record.schemaVersion,
    eventType: record.eventType,
    interactionId: record.interactionId,
    conversationId: record.conversationId,
    sourceId: record.sourceId,
    sourceEventId: record.sourceEventId,
    collectorId: record.collectorId,
    tenantId: record.tenantId,
    environmentId: record.environmentId,
    agentInstanceId: record.agentInstanceId,
    workspacePath: record.workspacePath,
    processInstanceId: record.processInstanceId,
    ...('turnId' in record
      ? {
          turnId: record.turnId,
          turnSequence: record.turnSequence,
          turnCorrelation: record.turnCorrelation,
        }
      : {}),
    observedAt: record.observedAt,
    process: record.process,
    ...('runtime' in record ? { runtime: record.runtime } : {}),
    ...(record.eventType === 'LlmTransportObserved'
      ? { transport: record.transport }
      : record.eventType === 'AgentInputObserved'
        ? { input: record.input, turn: record.turn, userInstruction: record.userInstruction }
        : { output: record.output, turn: record.turn, assistantResponse: record.assistantResponse }),
    capture: record.capture,
  };
  return createHash('sha256').update(JSON.stringify(immutable)).digest('hex');
}

export function deduplicateInteractionRecords(
  records: readonly InteractionRecord[],
): InteractionRecord[] {
  const logical = new Map<
    string,
    { record: InteractionRecord; fingerprint: string }
  >();
  for (const record of records) {
    const fingerprint = interactionPayloadFingerprint(record);
    const previous = logical.get(record.interactionId);
    if (previous && previous.fingerprint !== fingerprint) {
      throw new Error(
        `conflicting immutable Interaction projection for ${record.interactionId}`,
      );
    }
    if (!previous) logical.set(record.interactionId, { record, fingerprint });
  }
  return [...logical.values()].map(({ record }) => record);
}

export function summarizeInteractionRecords(
  records: readonly InteractionRecord[],
): InteractionConversationSummary[] {
  const summaries = new Map<string, InteractionConversationSummary>();
  const turnRoles = new Map<string, Set<'user' | 'assistant'>>();
  for (const record of deduplicateInteractionRecords(records)) {
    const current = summaries.get(record.conversationId);
    if (!current) {
      const transport = record.eventType === 'LlmTransportObserved'
        ? record.transport
        : undefined;
      const runtime =
        record.eventType === 'AgentInputObserved'
        || record.eventType === 'AgentOutputObserved'
          ? record.runtime
          : undefined;
      const instruction = record.eventType === 'AgentInputObserved';
      const response = record.eventType === 'AgentOutputObserved';
      summaries.set(record.conversationId, {
        conversationId: record.conversationId,
        agentInstanceId: record.agentInstanceId,
        processInstanceId: record.processInstanceId,
        runtimeType: runtime?.runtimeType,
        runtimeThreadId: runtime?.threadId,
        workspacePath: record.workspacePath,
        provider: transport?.provider ?? runtime?.modelProvider,
        collectorId: record.collectorId,
        firstObservedAt: record.observedAt,
        lastObservedAt: record.observedAt,
        transportObservations: transport ? 1 : 0,
        instructionObservations: instruction ? 1 : 0,
        responseObservations: response ? 1 : 0,
        completeTurns: 0,
        requestBytes: transport?.requestBytes ?? 0,
        responseBytes: transport?.responseBytes ?? 0,
        timingScope: transport?.timingScope ?? 'unavailable',
        contentAvailable: instruction || response,
      });
    } else {
      current.firstObservedAt = Math.min(current.firstObservedAt, record.observedAt);
      current.lastObservedAt = Math.max(current.lastObservedAt, record.observedAt);
      if (record.eventType === 'LlmTransportObserved') {
        current.transportObservations += 1;
        current.requestBytes += record.transport.requestBytes ?? 0;
        current.responseBytes += record.transport.responseBytes ?? 0;
        if (!current.provider && record.transport.provider) {
          current.provider = record.transport.provider;
        }
        if (current.timingScope === 'unavailable') {
          current.timingScope = record.transport.timingScope;
        }
      } else if (record.eventType === 'AgentInputObserved') {
        current.instructionObservations += 1;
        current.contentAvailable = true;
        if (!current.provider && record.runtime?.modelProvider) {
          current.provider = record.runtime.modelProvider;
        }
      } else {
        current.responseObservations += 1;
        current.contentAvailable = true;
        if (!current.provider && record.runtime?.modelProvider) {
          current.provider = record.runtime.modelProvider;
        }
      }
    }
    if (
      record.eventType !== 'LlmTransportObserved'
      && record.turnId
    ) {
      const key = `${record.conversationId}\0${record.turnId}`;
      const roles = turnRoles.get(key) ?? new Set<'user' | 'assistant'>();
      roles.add(record.eventType === 'AgentInputObserved' ? 'user' : 'assistant');
      turnRoles.set(key, roles);
    }
  }
  for (const [key, roles] of turnRoles) {
    if (roles.size !== 2) continue;
    const conversationId = key.slice(0, key.indexOf('\0'));
    const summary = summaries.get(conversationId);
    if (summary) summary.completeTurns += 1;
  }
  return [...summaries.values()].sort(
    (left, right) =>
      right.lastObservedAt - left.lastObservedAt
      || left.conversationId.localeCompare(right.conversationId),
  );
}
