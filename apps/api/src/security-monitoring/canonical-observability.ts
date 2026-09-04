/**
 * Versioned, product-neutral contracts for the agent observability pipeline.
 *
 * The existing `JudgedEvent`/`AgentInteractionRecord` shapes are intentionally kept as
 * compatibility projections.  This module is the additive contract used by new code: an
 * immutable raw observation is committed first, and every semantic/identity/correlation result
 * points back to that observation through source references and revisions.
 */

import { createHash, createHmac, randomBytes } from 'node:crypto';

export const CANONICAL_SCHEMA_VERSIONS = {
  rawObservation: 'anysentry.raw_observation.v1',
  kernelFact: 'anysentry.kernel_fact.v1',
  semanticRecord: 'anysentry.semantic_record.v1',
  logicalAgentDefinition: 'anysentry.logical_agent_definition.v1',
  agentInstance: 'anysentry.agent_instance.v1',
  runtimeInstance: 'anysentry.runtime_instance.v1',
  connectionIdentity: 'anysentry.connection_identity.v1',
  sessionMembership: 'anysentry.session_membership.v1',
  evidenceLink: 'anysentry.evidence_link.v1',
  coverageGap: 'anysentry.coverage_gap.v1',
  relationRevision: 'anysentry.relation_revision.v1',
} as const;

export type ProcessGenerationKey = string;
/** Shared with Observer's userspace enrichment (`host\\0boot\\0pid\\0start`). */
export const PROCESS_GENERATION_KEY_ALGORITHM_V1 = 'host\\0boot\\0pid\\0start.v1' as const;
export const SESSION_KEY_ALGORITHM_V1 = 'hmac-sha256(canonical\\0scope\\0provider-session).v1' as const;
export const CANONICAL_SESSION_ID_ALGORITHM_V1 = 'hmac-sha256(membership\\0namespace\\0native-session).v1' as const;
// A dedicated session secret gives stable tenant-scoped references across API restarts and
// replicas. Never reuse the management token: rotating an operator credential must not silently
// rewrite Session identities, and a leaked auth token must not become a dictionary key. In a local
// unconfigured profile use a process-ephemeral secret; this intentionally prevents cross-restart
// joins while keeping the raw provider ID out of canonical indexes. The secret itself is never
// returned or persisted by this module.
const configuredSessionHashSecret = process.env.ANYSENTRY_SESSION_HASH_SECRET?.trim();
const SESSION_HASH_SECRET = configuredSessionHashSecret || randomBytes(32).toString('hex');
export const SESSION_HASH_SECRET_MODE = configuredSessionHashSecret
  ? 'dedicated_env' as const
  : 'process_ephemeral' as const;

export interface ProcessGenerationKeyParts {
  hostId?: string;
  bootId?: string;
  pid: number;
  startTimeNs?: string;
  startTimeTicks?: string;
}

export interface ProcessGeneration {
  processGenerationKey: ProcessGenerationKey;
  pid: number;
  ppid?: number;
  parentProcessGenerationKey?: ProcessGenerationKey;
  hostId?: string;
  bootId?: string;
  pidNamespace?: string;
  namespacePid?: number;
  startTimeTicks?: string;
  /** Some producers expose a nanosecond start marker instead of Linux clock ticks. */
  startTimeNs?: string;
  execId?: string;
  executable?: string;
  argvHash?: string;
  cwd?: string;
  firstSeenAtUnixNs: string;
  exitedAtUnixNs?: string;
  sourceRefs: string[];
}

export type RuntimeEnvironment = 'host' | 'ssh' | 'docker' | 'kubernetes' | 'microvm' | 'unknown';

export interface RuntimeContext {
  runtimeInstanceId?: string;
  environment: RuntimeEnvironment;
  hostId?: string;
  bootId?: string;
  clusterId?: string;
  namespace?: string;
  podUid?: string;
  podName?: string;
  containerId?: string;
  containerName?: string;
  imageDigest?: string;
  deploymentId?: string;
  revision?: string;
  terminalContextId?: string;
  sshConnectionId?: string;
  sourceRefs?: string[];
}

export type ConnectionTransport = 'tcp' | 'tls' | 'http' | 'sse' | 'websocket' | 'quic' | 'unknown';
export type ConnectionIdentityQuality = 'exact' | 'strong' | 'weak' | 'unknown';

export interface ConnectionIdentity {
  schemaVersion: 'anysentry.connection_identity.v1';
  connectionId: string;
  processGenerationKey: ProcessGenerationKey;
  socketCookie?: string;
  fd?: number;
  fdGeneration?: string;
  tlsContextId?: string;
  netnsId?: string;
  streamId?: string;
  transport: ConnectionTransport;
  quality: ConnectionIdentityQuality;
  direction?: 'read' | 'write' | 'bidirectional' | string;
  sequence?: string;
  sourceRefs?: string[];
}

export type RawObservationSourceType =
  | 'kernel'
  | 'uprobe'
  | 'socket_payload'
  | 'api'
  | 'otel'
  | 'forwarder'
  | 'unknown';

export type RawPayloadEncoding = 'utf8' | 'base64' | 'binary';
export type RawRedactionState = 'none' | 'partial' | 'full' | 'hash_only';

export interface RawObservationPayload {
  kind: string;
  encoding?: RawPayloadEncoding;
  payloadRef?: string;
  sha256: string;
  originalBytes: number;
  capturedBytes: number;
  truncated?: boolean;
  redactionState: RawRedactionState;
  /** Optional short-lived in-memory payload. It must never be required for replay metadata. */
  body?: string;
}

export interface RawObservationCaptureDecision {
  profile?: string;
  action: 'full' | 'sample' | 'aggregate' | 'drop' | 'not_enabled';
  epoch?: string;
  authority?: string;
}

export interface RawObservation {
  schemaVersion: 'anysentry.raw_observation.v1';
  observationId: string;
  revision: number;
  eventAtUnixNs: string;
  receivedAtUnixNs: string;
  source: {
    sourceDomain?: string;
    sourceId?: string;
    collectorId?: string;
    sourceType: RawObservationSourceType;
    probeId?: string;
    sourceSequence?: string;
  };
  runtime?: RuntimeContext;
  process?: ProcessGeneration;
  /** Compact aliases accepted on the wire; normalized into `process`/`connection` on read. */
  processGenerationKey?: ProcessGenerationKey;
  connection?: ConnectionIdentity;
  connectionIdentity?: ConnectionIdentity;
  payload: RawObservationPayload;
  captureDecision?: RawObservationCaptureDecision;
  sourceRefs: string[];
  derivedFrom?: string[];
  idempotencyKey: string;
}

export type SemanticRecordKind =
  | 'message'
  | 'llm_call'
  | 'tool_call'
  | 'tool_result'
  | 'node_run'
  | 'runtime_activity'
  | 'unknown';

export type SemanticCompleteness = 'complete' | 'partial' | 'unparsed' | 'unsupported' | 'missing';

export interface SemanticRecord {
  schemaVersion: 'anysentry.semantic_record.v1';
  semanticRecordId: string;
  revision?: number;
  /** Independent Session/identity resolution revision that produced this semantic projection. */
  resolutionRevision?: number;
  kind: SemanticRecordKind;
  authority: 'attested_observer' | 'authenticated_adapter' | 'server_graph' | 'inferred';
  sourceRefs: string[];
  derivedFrom: string[];
  parserId?: string;
  parserVersion?: string;
  logicalAgentId?: string;
  agentInstanceId?: string;
  runtimeInstanceId?: string;
  sessionId?: string;
  /** Opaque AnySentry Session identifier; provider/native IDs remain compatibility evidence. */
  canonicalSessionId?: string;
  sessionNamespaceKey?: string;
  sessionKey?: string;
  providerSessionIdHash?: string;
  turnId?: string;
  runId?: string;
  sessionMode?: 'resumable' | 'conversation' | 'per_request' | 'ephemeral' | 'unknown';
  sessionLifecycle?: 'new' | 'resume' | 'fork';
  parentSessionId?: string;
  /** Opaque canonical parent; the raw/native parent remains on AgentInteraction/Event metadata. */
  canonicalParentSessionId?: string;
  toolCallId?: string;
  tenantId?: string;
  ownerId?: string;
  logicalDefinitionFingerprint?: string;
  logicalScopeMode?: LogicalScopeMode;
  logicalIdentityAuthority?: LogicalAgentDefinition['logicalIdentityAuthority'];
  profile?: string;
  profileVersion?: string;
  deploymentId?: string;
  deploymentRevision?: string;
  environmentId?: string;
  terminalContextId?: string;
  role?: 'user' | 'model' | 'tool' | 'system';
  observedAtUnixNs: string;
  completeness: SemanticCompleteness;
  partialReasons: string[];
  payloadRef?: string;
}

export type LogicalScopeMode =
  | 'registered_definition'
  | 'workflow_definition'
  | 'service_definition'
  | 'terminal'
  | 'unresolved';

export type IdentityQuality = 'confirmed' | 'strong' | 'inferred' | 'candidate' | 'unresolved' | 'ephemeral' | 'conflict';

export interface LogicalAgentDefinition {
  schemaVersion: 'anysentry.logical_agent_definition.v1';
  logicalAgentId?: string;
  family: string;
  tenantId?: string;
  ownerId?: string;
  workspacePath?: string;
  repositoryId?: string;
  profile?: string;
  profileVersion?: string;
  deploymentId?: string;
  deploymentRevision?: string;
  environmentId?: string;
  definitionId?: string;
  definitionType?: 'registered' | 'workflow' | 'service' | 'graph' | 'application' | 'candidate';
  logicalScopeMode: LogicalScopeMode;
  definitionFingerprint: string;
  identityQuality: IdentityQuality;
  /** Why this definition may be treated as stable; retained with every derived projection. */
  logicalIdentityAuthority: 'management_registration' | 'authenticated_adapter' | 'inferred' | 'unknown';
  terminalContextId?: string;
  sourceRefs: string[];
}

export interface AgentInstance {
  schemaVersion: 'anysentry.agent_instance.v1';
  agentInstanceId: string;
  logicalAgentId?: string;
  instanceKind: 'root_process_generation' | 'deployment_revision' | 'workflow_revision' | 'service_start' | 'unknown';
  revision?: string;
  startedAtUnixNs: string;
  endedAtUnixNs?: string;
  identityQuality: IdentityQuality;
  sourceRefs: string[];
}

export interface RuntimeInstance {
  schemaVersion: 'anysentry.runtime_instance.v1';
  runtimeInstanceId: string;
  agentInstanceId?: string;
  environment: RuntimeEnvironment;
  processGenerationKeys: ProcessGenerationKey[];
  terminalContextId?: string;
  state: 'starting' | 'running' | 'idle' | 'exited' | 'lost' | 'unobserved';
  startedAtUnixNs: string;
  endedAtUnixNs?: string;
  sourceRefs: string[];
}

export type SessionMembershipRole =
  | 'conversation'
  | 'context_replay'
  | 'bootstrap'
  | 'control'
  | 'background'
  | 'tool_backend'
  | 'derived_metadata'
  | 'retry'
  | 'unclassified';

export interface SessionMembership {
  schemaVersion: 'anysentry.session_membership.v1';
  membershipId: string;
  sessionId: string;
  /** Namespaced canonical key; native provider ID remains a compatibility alias only. */
  sessionKey?: string;
  providerSessionIdHash?: string;
  sessionNamespaceKey?: string;
  sessionMode?: 'resumable' | 'conversation' | 'per_request' | 'ephemeral' | 'unknown';
  sessionLifecycle?: 'new' | 'resume' | 'fork';
  parentSessionId?: string;
  /** Opaque canonical parent used for fork lineage; raw parent remains compatibility evidence. */
  canonicalParentSessionId?: string;
  interactionId?: string;
  semanticRecordId?: string;
  logicalAgentId?: string;
  agentInstanceId?: string;
  runtimeInstanceId?: string;
  segmentId?: string;
  role: SessionMembershipRole;
  confidence: IdentityQuality;
  evidence: string[];
  resolverVersion: string;
  resolutionRevision: number;
  validFromUnixNs: string;
  validToUnixNs?: string;
  sourceRefs: string[];
}

export type EvidenceLinkStatus = 'confirmed' | 'strong' | 'inferred' | 'ambiguous' | 'unmatched' | 'coverage_gap';
export type EvidenceLinkMethod =
  | 'explicit_id'
  | 'connection_stream'
  | 'process_generation'
  | 'command'
  | 'resource'
  | 'network'
  | 'temporal'
  | 'none';

export interface EvidenceLink {
  schemaVersion: 'anysentry.evidence_link.v1';
  linkId: string;
  fromType: 'semantic_record' | 'llm_call' | 'tool_call' | 'session' | 'runtime' | 'agent_instance';
  fromId: string;
  toType: 'raw_observation' | 'kernel_fact' | 'process_generation' | 'connection' | 'file' | 'network' | 'security';
  toId: string;
  relation: 'emitted_by' | 'executes_as' | 'file_effect' | 'network_effect' | 'supports' | 'contains';
  method: EvidenceLinkMethod;
  confidence: number;
  authority: 'attested_observer' | 'authenticated_adapter' | 'server_graph' | 'inferred';
  evidenceRefs: string[];
  algorithmVersion: string;
  status: EvidenceLinkStatus;
  validFromUnixNs: string;
  validToUnixNs?: string;
  resolutionRevision: number;
}

/** Append-only wrapper for late-event correlation updates.  A new revision supersedes a prior
 * projection but never mutates the RawObservation or the historical relation row. */
export interface RelationRevision {
  schemaVersion: 'anysentry.relation_revision.v1';
  relationId: string;
  revision: number;
  relation: EvidenceLink;
  supersedesRelationId?: string;
  decidedAtUnixNs: string;
  sourceRefs: string[];
}

export type CoverageGapStage =
  | 'ingest'
  | 'raw_commit'
  | 'runtime'
  | 'transport'
  | 'llm_format'
  | 'agent_adapter'
  | 'identity'
  | 'session'
  | 'correlation'
  | 'judgment'
  | 'projection';

export type CoverageGapReason =
  | 'no_event'
  | 'capture_disabled'
  | 'unsupported_tls_profile'
  | 'unsupported_protocol'
  | 'parser_failed'
  | 'identity_unknown'
  | 'relation_ambiguous'
  | 'truncated'
  | 'dropped'
  | 'redacted'
  | 'timeout'
  | 'permission_denied'
  | 'storage_unavailable'
  | 'unclassified'
  | string;

export interface CoverageGap {
  schemaVersion: 'anysentry.coverage_gap.v1';
  gapId: string;
  stage: CoverageGapStage;
  reason: CoverageGapReason;
  scope: string;
  sourceRefs: string[];
  firstSeenAtUnixNs: string;
  lastSeenAtUnixNs: string;
  droppedCount: number;
  orphanedCount: number;
  details?: Record<string, string | number | boolean>;
  revision: number;
}

export type KernelFactKind = 'exec' | 'fork' | 'exit' | 'file' | 'network' | 'dns' | 'tls' | 'security' | 'process' | 'unknown' | string;
export type KernelFactStatus = 'observed' | 'completed' | 'failed' | 'partial' | 'unknown';

/** Machine-side fact. It never depends on a product Adapter or a parsed LLM message. */
export interface KernelFact {
  schemaVersion: 'anysentry.kernel_fact.v1';
  factId: string;
  kind: KernelFactKind;
  authority: 'attested_observer' | 'server_process_graph' | 'inferred';
  sourceRefs: string[];
  derivedFrom: string[];
  observedAtUnixNs: string;
  processGenerationKey?: ProcessGenerationKey;
  parentProcessGenerationKey?: ProcessGenerationKey;
  connectionId?: string;
  payloadRef?: string;
  eventId?: string;
  scope?: string;
  status: KernelFactStatus;
}

export interface KernelFactStoreOptions {
  maxEntries?: number;
  maxBytes?: number;
  ttlMs?: number;
  /** Maximum number of distinct legacy/source aliases retained in the hot locator. */
  maxAliasEntries?: number;
  /** Maximum UTF-8 bytes retained by the hot alias locator. */
  maxAliasBytes?: number;
  now?: () => number;
}

export interface KernelFactStoreStats {
  entries: number;
  bytes: number;
  maxEntries: number;
  maxBytes: number;
  ttlMs: number;
  evicted: number;
  expired: number;
  dropped: number;
  duplicates: number;
  conflicts: number;
  /** Distinct event/source aliases currently retained by the bounded hot locator. */
  aliasEntries: number;
  /** Number of alias → canonical fact bindings (an ambiguous alias has >1 binding). */
  aliasBindings: number;
  aliasBytes: number;
  aliasMaxEntries: number;
  aliasMaxBytes: number;
  aliasEvicted: number;
  aliasExpired: number;
  aliasDropped: number;
  aliasConflicts: number;
  aliasOrphans: number;
  closed: boolean;
}

export interface SemanticRecordStoreOptions {
  maxEntries?: number;
  maxBytes?: number;
  ttlMs?: number;
  now?: () => number;
}

export interface SemanticRecordStoreStats {
  entries: number;
  bytes: number;
  maxEntries: number;
  maxBytes: number;
  ttlMs: number;
  evicted: number;
  expired: number;
  dropped: number;
  duplicates: number;
  conflicts: number;
  closed: boolean;
}

export type SemanticRecordStoreResult =
  | { status: 'inserted'; record: SemanticRecord }
  | { status: 'duplicate'; record: SemanticRecord }
  | { status: 'conflict' | 'rejected' | 'evicted'; reason: string };

export interface EvidenceLinkStoreOptions {
  maxEntries?: number;
  maxBytes?: number;
  ttlMs?: number;
  now?: () => number;
}

export interface EvidenceLinkStoreStats {
  entries: number;
  bytes: number;
  maxEntries: number;
  maxBytes: number;
  ttlMs: number;
  evicted: number;
  expired: number;
  dropped: number;
  duplicates: number;
  conflicts: number;
  closed: boolean;
}

export interface SessionMembershipStoreOptions {
  maxEntries?: number;
  maxBytes?: number;
  ttlMs?: number;
  now?: () => number;
}

export interface SessionMembershipStoreStats {
  entries: number;
  bytes: number;
  maxEntries: number;
  maxBytes: number;
  ttlMs: number;
  evicted: number;
  expired: number;
  dropped: number;
  duplicates: number;
  conflicts: number;
  closed: boolean;
}

export type SessionMembershipStoreResult =
  | { status: 'inserted'; membership: SessionMembership }
  | { status: 'duplicate'; membership: SessionMembership }
  | { status: 'conflict' | 'rejected' | 'evicted'; reason: string };

export type EvidenceLinkStoreResult =
  | { status: 'inserted'; link: EvidenceLink }
  | { status: 'duplicate'; link: EvidenceLink }
  | { status: 'conflict' | 'rejected' | 'evicted'; reason: string };

/** Declarative extension contract; product-specific code belongs behind this manifest boundary. */
export interface AgentAdapterManifest {
  schemaVersion: 'anysentry.agent_manifest.v1';
  id: string;
  family: string;
  versionPolicy?: string;
  detection: {
    commands?: string[];
    executableHints?: string[];
    parentHints?: string[];
  };
  logicalAgent: {
    keySources: string[];
    terminalRequired?: boolean;
  };
  instance: {
    boundary: 'root_process_generation' | 'deployment_revision' | 'workflow_revision' | 'service_start' | 'unknown';
    deploymentFields?: string[];
  };
  session: {
    idPaths: string[];
    pathHints?: string[];
    resumeArgs?: string[];
    forkSignals?: string[];
    mode: 'resumable' | 'conversation' | 'per_request' | 'ephemeral' | 'unknown';
  };
  turn?: { idPaths: string[] };
  tool?: { namePaths: string[]; idPaths?: string[]; argumentPaths?: string[]; resultPaths?: string[]; statusPaths?: string[] };
  capture?: { tlsImplementationHints?: string[]; transportHints?: string[]; contentPolicy?: 'opt_in' | 'disabled' | 'metadata_only' };
  fixtures?: string[];
  limitations?: string[];
  status?: 'current' | 'future' | 'deprecated';
}

export interface AgentAdapter {
  manifest: AgentAdapterManifest;
  matchRuntime?(context: RuntimeContext): 'confirmed' | 'likely' | 'unknown';
  extractIdentity?(exchange: unknown, runtime: RuntimeContext): Array<{ entityType: string; valueHash?: string; sourcePath: string; strength: 'exact' | 'strong' | 'supporting' }>;
  extractLifecycle?(exchange: unknown): Array<{ kind: string; sourceRefs: string[] }>;
  extractTool?(record: SemanticRecord): Array<{ rawName: string; rawId?: string; sourceRefs: string[] }>;
}

export interface TransportDecoderContract {
  id: string;
  version: string;
  feed(chunk: RawObservation): unknown[];
  flush(reason: 'close' | 'timeout' | 'gap' | 'limit'): unknown[];
}

export interface LlmFormatAdapterContract {
  id: string;
  version: string;
  detect(exchange: unknown): 'confirmed' | 'likely' | 'unknown';
  parse(exchange: unknown): SemanticRecord[];
}

export interface RuntimeAdapterContract {
  id: string;
  detect(facts: unknown[]): boolean;
  enrich(fact: unknown): RuntimeContext;
  processKey(fact: unknown): ProcessGenerationKey | undefined;
}

/** Bounded, version-aware registry. Unknown products remain candidates instead of blocking facts. */
export class AgentAdapterRegistry {
  private readonly adapters = new Map<string, AgentAdapter>();
  private readonly maxEntries: number;
  private closed = false;
  private registrations = 0;
  private rejected = 0;

  constructor(maxEntries = 256) {
    this.maxEntries = Math.max(1, Math.min(10_000, Math.trunc(maxEntries)));
  }

  register(adapter: AgentAdapter): boolean {
    if (this.closed || !adapter?.manifest || adapter.manifest.schemaVersion !== 'anysentry.agent_manifest.v1') {
      this.rejected += 1;
      return false;
    }
    const id = text(adapter.manifest.id, 240);
    const family = text(adapter.manifest.family, 160);
    if (!id || !family || (this.adapters.size >= this.maxEntries && !this.adapters.has(id))) {
      this.rejected += 1;
      return false;
    }
    this.adapters.set(id, adapter);
    this.registrations += 1;
    return true;
  }

  unregister(id: string): boolean {
    return this.adapters.delete(id);
  }

  get(id: string): AgentAdapter | undefined {
    return this.adapters.get(id);
  }

  list(): AgentAdapterManifest[] {
    return [...this.adapters.values()].map((adapter) => structuredClone(adapter.manifest));
  }

  match(context: RuntimeContext): Array<{ adapterId: string; result: 'confirmed' | 'likely' | 'unknown' }> {
    return [...this.adapters.values()].flatMap((adapter) => {
      const result = adapter.matchRuntime?.(context) ?? 'unknown';
      return [{ adapterId: adapter.manifest.id, result }];
    });
  }

  stats(): { entries: number; maxEntries: number; registrations: number; rejected: number; closed: boolean } {
    return { entries: this.adapters.size, maxEntries: this.maxEntries, registrations: this.registrations, rejected: this.rejected, closed: this.closed };
  }

  close(): void {
    this.closed = true;
    this.adapters.clear();
  }
}

export interface RegistryDescriptor {
  id: string;
  schemaVersion: string;
  version: string;
  capabilities: string[];
  limitations?: string[];
  status?: 'current' | 'future' | 'deprecated';
}

/** Small bounded descriptor registry for orthogonal transport/format/runtime extension points. */
export class ContractRegistry {
  private readonly entries = new Map<string, RegistryDescriptor>();
  private readonly maxEntries: number;
  private rejected = 0;
  private closed = false;

  constructor(maxEntries = 256) {
    this.maxEntries = Math.max(1, Math.min(10_000, Math.trunc(maxEntries)));
  }

  register(descriptor: RegistryDescriptor): boolean {
    if (this.closed || !descriptor || typeof descriptor.id !== 'string'
      || !descriptor.id.trim() || typeof descriptor.schemaVersion !== 'string'
      || typeof descriptor.version !== 'string' || !Array.isArray(descriptor.capabilities)
      || (this.entries.size >= this.maxEntries && !this.entries.has(descriptor.id))) {
      this.rejected += 1;
      return false;
    }
    this.entries.set(descriptor.id.trim(), structuredClone({
      ...descriptor,
      id: descriptor.id.trim(),
      capabilities: descriptor.capabilities.slice(0, 128),
      limitations: descriptor.limitations?.slice(0, 128),
    }));
    return true;
  }

  list(): RegistryDescriptor[] {
    return [...this.entries.values()].map((entry) => structuredClone(entry));
  }

  stats(): { entries: number; maxEntries: number; rejected: number; closed: boolean } {
    return { entries: this.entries.size, maxEntries: this.maxEntries, rejected: this.rejected, closed: this.closed };
  }

  close(): void {
    this.closed = true;
    this.entries.clear();
  }
}

export const DEFAULT_AGENT_ADAPTER_MANIFESTS: readonly AgentAdapterManifest[] = [
  {
    schemaVersion: 'anysentry.agent_manifest.v1',
    id: 'codex-cli', family: 'cli-agent', versionPolicy: 'manifest-versioned',
    detection: { commands: ['codex'], executableHints: ['codex'] },
    logicalAgent: { keySources: ['registered_definition', 'workspace', 'profile'] },
    instance: { boundary: 'root_process_generation' },
    session: { idPaths: ['request.thread_id', 'request.session_id'], resumeArgs: ['--resume', '--continue'], forkSignals: ['thread/fork'], mode: 'resumable' },
    turn: { idPaths: ['request.turn_id', 'response.turn_id'] },
    tool: { namePaths: ['response.output[].name'], idPaths: ['response.output[].call_id'], argumentPaths: ['response.output[].arguments'], resultPaths: ['request.input[].output'] },
    capture: { tlsImplementationHints: ['implementation-registry'], transportHints: ['http1', 'sse', 'websocket'], contentPolicy: 'opt_in' },
    limitations: ['product fields are hints; KernelFact remains independent'], status: 'current',
  },
  {
    schemaVersion: 'anysentry.agent_manifest.v1',
    id: 'claude-code', family: 'cli-agent', versionPolicy: 'manifest-versioned',
    detection: { commands: ['claude'], executableHints: ['claude', 'claude-code'] },
    logicalAgent: { keySources: ['registered_definition', 'workspace', 'profile'] },
    instance: { boundary: 'root_process_generation' },
    session: { idPaths: ['request.session_id', 'request.metadata.session_id'], resumeArgs: ['--resume', '--continue'], forkSignals: ['--fork-session'], mode: 'resumable' },
    turn: { idPaths: ['request.turn_id', 'response.turn_id'] },
    tool: { namePaths: ['response.content[].name'], idPaths: ['response.content[].id'], argumentPaths: ['response.content[].input'], resultPaths: ['request.content[].tool_use_id'] },
    capture: { tlsImplementationHints: ['implementation-registry'], transportHints: ['http1', 'sse'], contentPolicy: 'opt_in' },
    limitations: ['binary profile and TLS attach are versioned separately'], status: 'current',
  },
  {
    schemaVersion: 'anysentry.agent_manifest.v1',
    id: 'dify-workflow-chatflow', family: 'application-agent', versionPolicy: 'definition/revision',
    detection: { executableHints: ['dify-api', 'dify-worker', 'plugin-daemon'] },
    logicalAgent: { keySources: ['tenant', 'app_definition', 'workflow_definition'] },
    instance: { boundary: 'workflow_revision', deploymentFields: ['revision', 'environment', 'deployment_id'] },
    session: { idPaths: ['request.conversation_id'], mode: 'conversation' },
    turn: { idPaths: ['request.message_id', 'response.task_id'] },
    tool: { namePaths: ['event.node.title', 'event.tool.name'], idPaths: ['event.tool_call_id'], resultPaths: ['event.outputs'] },
    capture: { transportHints: ['http1', 'sse'], contentPolicy: 'opt_in' },
    limitations: ['workflow node identity requires an authenticated application/trace source'], status: 'current',
  },
  {
    schemaVersion: 'anysentry.agent_manifest.v1',
    id: 'langchain-langgraph', family: 'application-agent', versionPolicy: 'definition/deployment',
    detection: { executableHints: ['langchain', 'langgraph'] },
    logicalAgent: { keySources: ['service_definition', 'graph_definition', 'assistant'] },
    instance: { boundary: 'service_start', deploymentFields: ['revision', 'environment', 'deployment_id'] },
    session: { idPaths: ['request.thread_id', 'request.conversation_id'], mode: 'conversation' },
    turn: { idPaths: ['request.run_id', 'response.run_id'] },
    tool: { namePaths: ['event.tool.name', 'event.name'], idPaths: ['event.tool_call_id'], argumentPaths: ['event.input'], resultPaths: ['event.output'] },
    capture: { transportHints: ['http1', 'sse', 'websocket'], contentPolicy: 'opt_in' },
    limitations: ['without thread_id each POST is per_request/ephemeral'], status: 'current',
  },
  {
    schemaVersion: 'anysentry.agent_manifest.v1',
    id: 'pi-cli', family: 'cli-agent', versionPolicy: 'future-fixture',
    detection: { commands: ['pi'], executableHints: ['pi'] },
    logicalAgent: { keySources: ['registered_definition', 'workspace', 'profile'] },
    instance: { boundary: 'root_process_generation' },
    session: { idPaths: ['session.id', 'session.file'], resumeArgs: ['--continue'], forkSignals: ['/fork'], mode: 'resumable' },
    tool: { namePaths: ['tool.name'], idPaths: ['tool.id'], argumentPaths: ['tool.input'], resultPaths: ['tool.output'] },
    limitations: ['future adapter slot; not a current release gate'], status: 'future',
  },
  {
    schemaVersion: 'anysentry.agent_manifest.v1',
    id: 'generic-cli-future', family: 'unknown-cli', versionPolicy: 'fixture-required',
    detection: {},
    logicalAgent: { keySources: ['management_registration', 'workspace', 'profile'] },
    instance: { boundary: 'root_process_generation' },
    session: { idPaths: [], mode: 'unknown' },
    limitations: ['KernelFact/CandidateAgent path remains available without a semantic adapter'], status: 'future',
  },
];

export function createDefaultAgentAdapterRegistry(): AgentAdapterRegistry {
  const registry = new AgentAdapterRegistry();
  for (const manifest of DEFAULT_AGENT_ADAPTER_MANIFESTS) registry.register({ manifest });
  return registry;
}

export const DEFAULT_TRANSPORT_REGISTRY: readonly RegistryDescriptor[] = [
  { id: 'http1', schemaVersion: 'anysentry.transport.v1', version: '1', capabilities: ['content-length', 'chunked', 'keep-alive'], status: 'current' },
  { id: 'sse', schemaVersion: 'anysentry.transport.v1', version: '1', capabilities: ['event-boundary', 'stream-reassembly'], status: 'current' },
  { id: 'websocket', schemaVersion: 'anysentry.transport.v1', version: '1', capabilities: ['frame-boundary'], limitations: ['compression/late-handshake may be partial'], status: 'current' },
  { id: 'http2-quic', schemaVersion: 'anysentry.transport.v1', version: '1', capabilities: [], limitations: ['metadata-only/unsupported until a bounded multiplexer is enabled'], status: 'future' },
];

export const DEFAULT_LLM_FORMAT_REGISTRY: readonly RegistryDescriptor[] = [
  { id: 'openai-chat', schemaVersion: 'anysentry.llm_format.v1', version: '1', capabilities: ['messages', 'tool_calls', 'sse'], status: 'current' },
  { id: 'openai-responses', schemaVersion: 'anysentry.llm_format.v1', version: '1', capabilities: ['input-items', 'function-call', 'sse'], status: 'current' },
  { id: 'anthropic-messages', schemaVersion: 'anysentry.llm_format.v1', version: '1', capabilities: ['content-blocks', 'tool-use', 'sse'], status: 'current' },
  { id: 'gemini-compatible', schemaVersion: 'anysentry.llm_format.v1', version: '1', capabilities: ['contents', 'function-call'], limitations: ['provider-specific live modes require a fixture'], status: 'current' },
];

export const DEFAULT_RUNTIME_REGISTRY: readonly RegistryDescriptor[] = [
  { id: 'host', schemaVersion: 'anysentry.runtime_adapter.v1', version: '1', capabilities: ['process-generation', 'tty-context'], status: 'current' },
  { id: 'ssh', schemaVersion: 'anysentry.runtime_adapter.v1', version: '1', capabilities: ['remote-host', 'connection-context'], status: 'current' },
  { id: 'docker', schemaVersion: 'anysentry.runtime_adapter.v1', version: '1', capabilities: ['container-id', 'namespace-pid', 'cgroup'], status: 'current' },
  { id: 'kubernetes', schemaVersion: 'anysentry.runtime_adapter.v1', version: '1', capabilities: ['pod-uid', 'deployment-revision', 'container-id'], status: 'current' },
];

export interface RawObservationValidationOk {
  ok: true;
  value: RawObservation;
}

export interface RawObservationValidationError {
  ok: false;
  reason: string;
  field?: string;
}

export type RawObservationValidationResult = RawObservationValidationOk | RawObservationValidationError;

export interface CanonicalValidationOk<T> { ok: true; value: T }
export interface CanonicalValidationError { ok: false; reason: string; field?: string }
export type CanonicalValidationResult<T> = CanonicalValidationOk<T> | CanonicalValidationError;

export interface RawObservationStoreOptions {
  maxEntries?: number;
  maxBytes?: number;
  ttlMs?: number;
  now?: () => number;
}

export interface RawObservationStoreStats {
  entries: number;
  bytes: number;
  maxEntries: number;
  maxBytes: number;
  ttlMs: number;
  evicted: number;
  expired: number;
  dropped: number;
  duplicates: number;
  conflicts: number;
  orphaned: number;
  closed: boolean;
}

export type RawObservationStoreResult =
  | { status: 'inserted'; observation: RawObservation }
  | { status: 'duplicate'; observation: RawObservation }
  | { status: 'conflict'; reason: string }
  | { status: 'rejected'; reason: string }
  | { status: 'evicted'; reason: string };

const HEX64 = /^[a-f0-9]{64}$/u;
// PostgreSQL canonical timestamp columns use NUMERIC(40,0); keep the wire validator within the
// same precision so a value accepted in memory cannot fail only at the durable sink boundary.
const UNIX_NS = /^[1-9][0-9]{8,39}$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;

function text(value: unknown, max = 512): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= max && !CONTROL.test(normalized) ? normalized : undefined;
}

function exactText(value: unknown, max = 512): string | undefined {
  return typeof value === 'string' && value.length <= max && !CONTROL.test(value) ? value : undefined;
}

function positiveInteger(value: unknown, max = Number.MAX_SAFE_INTEGER): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= max
    ? value
    : undefined;
}

function nonNegativeInteger(value: unknown, max = Number.MAX_SAFE_INTEGER): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max
    ? value
    : undefined;
}

function unixNs(value: unknown): string | undefined {
  const candidate = text(value, 48);
  return candidate && UNIX_NS.test(candidate) ? candidate : undefined;
}

function boundedRefs(value: unknown, max = 128): string[] | undefined {
  if (!Array.isArray(value) || value.length > max) return undefined;
  const refs = value.map((item) => text(item, 512));
  return refs.every((item): item is string => Boolean(item)) ? [...new Set(refs)] : undefined;
}

/**
 * Server-derived compatibility references are intentionally narrower than producer sourceRefs.
 * They are accepted only through an internal commit context, capped by count/bytes, and merged
 * behind the immutable observationId.  This lets a legacy event/raw ID locate a fact without
 * allowing an unbounded or body-bearing value into the canonical row.
 */
function boundedServerSourceRefs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const refs: string[] = [];
  let bytes = 0;
  for (const item of value) {
    const ref = text(item, 240);
    if (!ref || refs.includes(ref)) continue;
    const refBytes = Buffer.byteLength(ref, 'utf8');
    if (refs.length >= 32 || bytes + refBytes > 8 * 1024) break;
    refs.push(ref);
    bytes += refBytes;
  }
  return refs;
}

export function mergeServerSourceRefs(observationId: string, ...groups: unknown[]): string[] {
  const merged = [observationId];
  for (const group of groups) merged.push(...boundedServerSourceRefs(group));
  return [...new Set(merged)].slice(0, 128);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableId(prefix: string, value: string): string {
  return `${prefix}_${sha256(value).slice(0, 24)}`;
}

function jsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`;
}

function sourceType(value: unknown): RawObservationSourceType | undefined {
  return ['kernel', 'uprobe', 'socket_payload', 'api', 'otel', 'forwarder', 'unknown']
    .includes(String(value)) ? value as RawObservationSourceType : undefined;
}

function normalizePayload(input: unknown): RawObservationPayload | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const value = input as Record<string, unknown>;
  const kind = text(value.kind, 160);
  const payloadRef = text(value.payloadRef, 512);
  const body = exactText(value.body, 8 * 1024 * 1024);
  const encoding = value.encoding === 'utf8' || value.encoding === 'base64' || value.encoding === 'binary'
    ? value.encoding
    : undefined;
  const originalBytes = nonNegativeInteger(value.originalBytes, 64 * 1024 * 1024);
  const capturedBytes = nonNegativeInteger(value.capturedBytes, 64 * 1024 * 1024);
  const sha = text(value.sha256, 64);
  const redactionState = ['none', 'partial', 'full', 'hash_only'].includes(String(value.redactionState))
    ? value.redactionState as RawRedactionState
    : undefined;
  if (!kind || originalBytes === undefined || capturedBytes === undefined || !sha || !HEX64.test(sha)
    || !redactionState || capturedBytes > originalBytes
    || (value.truncated === true && capturedBytes >= originalBytes)
    || (body !== undefined && !encoding)) return undefined;
  if (body !== undefined) {
    if (encoding === 'base64' && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(body)) {
      return undefined;
    }
    const bytes = encoding === 'base64' ? Buffer.from(body, 'base64') : Buffer.from(body, 'utf8');
    if (!bytes.length && originalBytes > 0) return undefined;
    // The canonical digest is over the captured bytes.  For UTF-8 this is the encoded body; for
    // base64 it is the decoded bytes.  Never accept a digest over an arbitrary textual re-encoding
    // of binary data, otherwise two byte streams could share one observation identity.
    if (createHash('sha256').update(bytes).digest('hex') !== sha) return undefined;
    if (capturedBytes !== bytes.length && redactionState !== 'hash_only') return undefined;
  }
  if (payloadRef?.startsWith('sha256:') && payloadRef.slice(7) !== sha) return undefined;
  return {
    kind,
    ...(encoding ? { encoding } : {}),
    ...(payloadRef ? { payloadRef } : {}),
    sha256: sha,
    originalBytes,
    capturedBytes,
    ...(value.truncated === true ? { truncated: true } : {}),
    redactionState,
    ...(body !== undefined ? { body } : {}),
  };
}

function normalizeRuntimeContext(input: unknown): RuntimeContext | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const value = input as Record<string, unknown>;
  const environment = ['host', 'ssh', 'docker', 'kubernetes', 'microvm', 'unknown']
    .includes(String(value.environment)) ? value.environment as RuntimeEnvironment : undefined;
  const sourceRefs = value.sourceRefs === undefined ? [] : boundedRefs(value.sourceRefs);
  if (!environment || !sourceRefs) return undefined;
  const output: RuntimeContext = {
    environment,
    sourceRefs,
  };
  const fields: Array<[keyof RuntimeContext, number]> = [
    ['runtimeInstanceId', 240], ['hostId', 240], ['bootId', 240], ['clusterId', 240],
    ['namespace', 240], ['podUid', 240], ['podName', 240], ['containerId', 240],
    ['containerName', 240], ['imageDigest', 240], ['deploymentId', 240], ['revision', 240],
    ['terminalContextId', 240], ['sshConnectionId', 240],
  ];
  for (const [field, limit] of fields) {
    const valueText = text(value[field], limit);
    if (value[field] !== undefined && !valueText) return undefined;
    if (valueText) (output as unknown as Record<string, unknown>)[field] = valueText;
  }
  return output;
}

function normalizeProcessGeneration(input: unknown): ProcessGeneration | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const value = input as Record<string, unknown>;
  const processGenerationKey = text(value.processGenerationKey, 128);
  const pid = positiveInteger(value.pid, 4_194_304);
  const firstSeenAtUnixNs = unixNs(value.firstSeenAtUnixNs);
  const hostId = text(value.hostId, 240);
  const bootId = text(value.bootId, 240);
  const startTimeTicks = value.startTimeTicks !== undefined
    ? (typeof value.startTimeTicks === 'number' && Number.isSafeInteger(value.startTimeTicks) && value.startTimeTicks > 0
      ? String(value.startTimeTicks)
      : text(value.startTimeTicks, 64))
    : undefined;
  const startTimeNs = value.startTimeNs !== undefined
    ? (typeof value.startTimeNs === 'number' && Number.isSafeInteger(value.startTimeNs) && value.startTimeNs > 0
      ? String(value.startTimeNs)
      : text(value.startTimeNs, 64))
    : undefined;
  const startMarker = startTimeTicks ?? startTimeNs;
  const sourceRefs = value.sourceRefs === undefined ? [] : boundedRefs(value.sourceRefs);
  if (!processGenerationKey || !/^pgk_[a-f0-9]{24}$/u.test(processGenerationKey)
    || pid === undefined || !firstSeenAtUnixNs || !sourceRefs
    // A processGenerationKey is only meaningful when the PID is fenced by host, boot and a
    // start/exec generation marker.  PID-only values are deliberately downgraded to a runtime
    // coverage gap instead of becoming a stable machine identity.
    || !hostId || !bootId || !startMarker) return undefined;
  const ppid = value.ppid === undefined ? undefined : nonNegativeInteger(value.ppid, 4_194_304);
  if (value.ppid !== undefined && ppid === undefined) return undefined;
  for (const [field, limit] of [
    ['processGenerationKey', 128], ['parentProcessGenerationKey', 128], ['hostId', 240],
    ['bootId', 240], ['pidNamespace', 240], ['executable', 1_024], ['argvHash', 64], ['cwd', 1_024],
    ['firstSeenAtUnixNs', 48], ['exitedAtUnixNs', 48], ['startTimeTicks', 64], ['startTimeNs', 64], ['execId', 240],
  ] as const) {
    if (value[field] === undefined) continue;
    if ((field === 'startTimeTicks' || field === 'startTimeNs') && typeof value[field] === 'number'
      && Number.isSafeInteger(value[field]) && value[field] > 0) continue;
    if (!text(value[field], limit)) return undefined;
  }
  const output: ProcessGeneration = {
    processGenerationKey,
    pid,
    ...(ppid !== undefined ? { ppid } : {}),
    ...(text(value.parentProcessGenerationKey, 128)
      ? { parentProcessGenerationKey: text(value.parentProcessGenerationKey, 128) } : {}),
    hostId,
    bootId,
    ...(text(value.pidNamespace, 240) ? { pidNamespace: text(value.pidNamespace, 240) } : {}),
    ...(value.namespacePid !== undefined ? { namespacePid: nonNegativeInteger(value.namespacePid, 4_194_304) ?? 0 } : {}),
    ...(startTimeTicks ? { startTimeTicks } : {}),
    ...(startTimeNs ? { startTimeNs } : {}),
    ...(text(value.execId, 240) ? { execId: text(value.execId, 240) } : {}),
    ...(text(value.executable, 1_024) ? { executable: text(value.executable, 1_024) } : {}),
    ...(text(value.argvHash, 64) ? { argvHash: text(value.argvHash, 64) } : {}),
    ...(text(value.cwd, 1_024) ? { cwd: text(value.cwd, 1_024) } : {}),
    firstSeenAtUnixNs,
    ...(unixNs(value.exitedAtUnixNs) ? { exitedAtUnixNs: unixNs(value.exitedAtUnixNs) } : {}),
    sourceRefs,
  };
  if (value.parentProcessGenerationKey !== undefined
    && !/^pgk_[a-f0-9]{24}$/u.test(output.parentProcessGenerationKey ?? '')) return undefined;
  if (output.exitedAtUnixNs !== undefined
    && BigInt(output.exitedAtUnixNs) < BigInt(output.firstSeenAtUnixNs)) return undefined;
  if (value.namespacePid !== undefined && output.namespacePid === 0) return undefined;
  if (value.argvHash !== undefined && !HEX64.test(output.argvHash ?? '')) return undefined;
  if (value.startTimeTicks !== undefined && !output.startTimeTicks) return undefined;
  if (value.startTimeNs !== undefined && !output.startTimeNs) return undefined;
  if (value.execId !== undefined && !text(value.execId, 240)) return undefined;
  const expectedKey = deriveProcessGenerationKey({
    hostId,
    bootId,
    pid,
    startTimeNs,
    startTimeTicks,
  });
  if (!expectedKey || expectedKey !== processGenerationKey) return undefined;
  return output;
}

function normalizeConnectionIdentity(input: unknown): ConnectionIdentity | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const value = input as Record<string, unknown>;
  const schemaVersion = value.schemaVersion === 'anysentry.connection_identity.v1';
  const connectionId = text(value.connectionId, 240);
  const processGenerationKey = text(value.processGenerationKey, 128);
  const transport = ['tcp', 'tls', 'http', 'sse', 'websocket', 'quic', 'unknown']
    .includes(String(value.transport)) ? value.transport as ConnectionTransport : undefined;
  const quality = ['exact', 'strong', 'weak', 'unknown']
    .includes(String(value.quality)) ? value.quality as ConnectionIdentityQuality : undefined;
  const sourceRefs = value.sourceRefs === undefined ? [] : boundedRefs(value.sourceRefs);
  if (!schemaVersion || !connectionId || !processGenerationKey
    || !/^conn_[a-f0-9]{24}$/u.test(connectionId)
    || !/^pgk_[a-f0-9]{24}$/u.test(processGenerationKey)
    || !transport || !quality || !sourceRefs || sourceRefs.length === 0) return undefined;
  const fd = value.fd === undefined ? undefined : nonNegativeInteger(value.fd, 4_194_304);
  if (value.fd !== undefined && fd === undefined) return undefined;
  for (const [field, limit] of [
    ['connectionId', 240], ['processGenerationKey', 128], ['socketCookie', 240],
    ['fdGeneration', 240], ['tlsContextId', 240], ['netnsId', 240], ['streamId', 240],
    ['direction', 80], ['sequence', 80],
  ] as const) {
    if (value[field] !== undefined && !text(value[field], limit)) return undefined;
  }
  return {
    schemaVersion: 'anysentry.connection_identity.v1',
    connectionId,
    processGenerationKey,
    ...(text(value.socketCookie, 240) ? { socketCookie: text(value.socketCookie, 240) } : {}),
    ...(fd !== undefined ? { fd } : {}),
    ...(text(value.fdGeneration, 240) ? { fdGeneration: text(value.fdGeneration, 240) } : {}),
    ...(text(value.tlsContextId, 240) ? { tlsContextId: text(value.tlsContextId, 240) } : {}),
    ...(text(value.netnsId, 240) ? { netnsId: text(value.netnsId, 240) } : {}),
    ...(text(value.streamId, 240) ? { streamId: text(value.streamId, 240) } : {}),
    transport,
    quality,
    ...(text(value.direction, 80) ? { direction: text(value.direction, 80) } : {}),
    ...(text(value.sequence, 80) ? { sequence: text(value.sequence, 80) } : {}),
    sourceRefs,
  };
}

/** Validate the normalized connection boundary independently of RawObservation. */
export function validateConnectionIdentity(input: unknown): CanonicalValidationResult<ConnectionIdentity> {
  const normalized = normalizeConnectionIdentity(input);
  return normalized
    ? { ok: true, value: normalized }
    : { ok: false, reason: 'connection identity has missing or invalid fields' };
}

function normalizeCaptureDecision(input: unknown): RawObservationCaptureDecision | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const value = input as Record<string, unknown>;
  const action = ['full', 'sample', 'aggregate', 'drop', 'not_enabled']
    .includes(String(value.action)) ? value.action as RawObservationCaptureDecision['action'] : undefined;
  if (!action) return undefined;
  return {
    action,
    ...(text(value.profile, 160) ? { profile: text(value.profile, 160) } : {}),
    ...(text(value.epoch, 120) ? { epoch: text(value.epoch, 120) } : {}),
    ...(text(value.authority, 160) ? { authority: text(value.authority, 160) } : {}),
  };
}

/** Validate and sanitize a raw observation without throwing on untrusted producer input. */
export function validateRawObservation(input: unknown): RawObservationValidationResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, reason: 'raw observation must be an object' };
  }
  const value = input as Record<string, unknown>;
  if (value.schemaVersion !== CANONICAL_SCHEMA_VERSIONS.rawObservation) {
    return { ok: false, reason: `schemaVersion must be ${CANONICAL_SCHEMA_VERSIONS.rawObservation}`, field: 'schemaVersion' };
  }
  const observationId = text(value.observationId, 240);
  const revision = positiveInteger(value.revision, Number.MAX_SAFE_INTEGER);
  const eventAtUnixNs = unixNs(value.eventAtUnixNs ?? value.eventAt);
  const receivedAtUnixNs = unixNs(value.receivedAtUnixNs ?? value.receivedAt);
  const source = value.source && typeof value.source === 'object' && !Array.isArray(value.source)
    ? value.source as Record<string, unknown>
    : undefined;
  const sourceTypeValue = sourceType(source?.sourceType);
  const payload = normalizePayload(value.payload);
  const sourceRefs = boundedRefs(value.sourceRefs);
  const derivedFrom = value.derivedFrom === undefined ? [] : boundedRefs(value.derivedFrom);
  const idempotencyKey = text(value.idempotencyKey, 512);
  if (!observationId || revision === undefined || !eventAtUnixNs || !receivedAtUnixNs
    || !source || !sourceTypeValue || !payload || !sourceRefs || sourceRefs.length === 0
    || !derivedFrom || !idempotencyKey) {
    return { ok: false, reason: 'raw observation has missing or invalid required fields' };
  }
  if (!sourceRefs.includes(observationId)) {
    return { ok: false, reason: 'sourceRefs must include observationId', field: 'sourceRefs' };
  }
  try {
    if (BigInt(receivedAtUnixNs) < BigInt(eventAtUnixNs)) {
      return { ok: false, reason: 'receivedAtUnixNs must not precede eventAtUnixNs' };
    }
  } catch {
    return { ok: false, reason: 'raw observation timestamp is invalid' };
  }
  const normalized: RawObservation = {
    schemaVersion: CANONICAL_SCHEMA_VERSIONS.rawObservation,
    observationId,
    revision,
    eventAtUnixNs,
    receivedAtUnixNs,
    source: {
      ...(text(source.sourceDomain, 240) ? { sourceDomain: text(source.sourceDomain, 240) } : {}),
      ...(text(source.sourceId, 240) ? { sourceId: text(source.sourceId, 240) } : {}),
      ...(text(source.collectorId, 240) ? { collectorId: text(source.collectorId, 240) } : {}),
      sourceType: sourceTypeValue,
      ...(text(source.probeId, 240) ? { probeId: text(source.probeId, 240) } : {}),
      ...(text(source.sourceSequence, 120) ? { sourceSequence: text(source.sourceSequence, 120) } : {}),
    },
    payload,
    sourceRefs,
    derivedFrom,
    idempotencyKey,
  };
  const runtime = normalizeRuntimeContext(value.runtime);
  if (value.runtime !== undefined && !runtime) return { ok: false, reason: 'runtime context is invalid', field: 'runtime' };
  if (runtime) normalized.runtime = runtime;
  const processInput = value.process ?? (value.processGenerationKey && value.pid !== undefined ? {
    processGenerationKey: value.processGenerationKey,
    pid: value.pid,
    hostId: value.hostId,
    bootId: value.bootId,
    firstSeenAtUnixNs: eventAtUnixNs,
    sourceRefs,
  } : undefined);
  const process = normalizeProcessGeneration(processInput);
  if (value.process !== undefined && !process) return { ok: false, reason: 'process generation is invalid', field: 'process' };
  if (value.processGenerationKey !== undefined
    && (!text(value.processGenerationKey, 128) || !/^pgk_[a-f0-9]{24}$/u.test(String(value.processGenerationKey)))) {
    return { ok: false, reason: 'processGenerationKey is invalid', field: 'processGenerationKey' };
  }
  if (value.processGenerationKey !== undefined
    && (!process || process.processGenerationKey !== String(value.processGenerationKey))) {
    return { ok: false, reason: 'processGenerationKey requires a complete process generation', field: 'processGenerationKey' };
  }
  if (process) normalized.process = process;
  const connection = normalizeConnectionIdentity(value.connection ?? value.connectionIdentity);
  if ((value.connection !== undefined || value.connectionIdentity !== undefined) && !connection) return { ok: false, reason: 'connection identity is invalid', field: 'connection' };
  if (value.connection !== undefined && value.connectionIdentity !== undefined) {
    const primary = normalizeConnectionIdentity(value.connection);
    const alias = normalizeConnectionIdentity(value.connectionIdentity);
    if (!primary || !alias || canonicalJson(primary) !== canonicalJson(alias)) {
      return { ok: false, reason: 'connection and connectionIdentity aliases conflict', field: 'connectionIdentity' };
    }
  }
  if (connection && (!process || connection.processGenerationKey !== process.processGenerationKey)) {
    return { ok: false, reason: 'connection identity must reference the same process generation', field: 'connection' };
  }
  if (connection) normalized.connection = connection;
  if (process?.processGenerationKey) normalized.processGenerationKey = process.processGenerationKey;
  else if (value.processGenerationKey) normalized.processGenerationKey = String(value.processGenerationKey);
  if (connection) normalized.connectionIdentity = connection;
  const capture = normalizeCaptureDecision(value.captureDecision);
  if (value.captureDecision !== undefined && !capture) return { ok: false, reason: 'capture decision is invalid', field: 'captureDecision' };
  if (capture) normalized.captureDecision = capture;
  return { ok: true, value: normalized };
}

function validateRefsAndTime(value: Record<string, unknown>): CanonicalValidationError | undefined {
  const sourceRefs = boundedRefs(value.sourceRefs);
  const observedAt = unixNs(value.observedAtUnixNs ?? value.validFromUnixNs ?? value.firstSeenAtUnixNs);
  if (!sourceRefs) return { ok: false, reason: 'sourceRefs must be a bounded string array', field: 'sourceRefs' };
  if (!observedAt) return { ok: false, reason: 'a valid Unix-ns timestamp is required', field: 'observedAtUnixNs' };
  return undefined;
}

export function validateSemanticRecord(input: unknown): CanonicalValidationResult<SemanticRecord> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, reason: 'semantic record must be an object' };
  const value = input as Record<string, unknown>;
  if (value.schemaVersion !== CANONICAL_SCHEMA_VERSIONS.semanticRecord) return { ok: false, reason: 'invalid semantic record schemaVersion', field: 'schemaVersion' };
  const semanticRecordId = text(value.semanticRecordId, 240);
  const revision = value.revision === undefined ? 1 : positiveInteger(value.revision, Number.MAX_SAFE_INTEGER);
  const resolutionRevision = value.resolutionRevision === undefined
    ? undefined : positiveInteger(value.resolutionRevision, Number.MAX_SAFE_INTEGER);
  const kind = ['message', 'llm_call', 'tool_call', 'tool_result', 'node_run', 'runtime_activity', 'unknown'].includes(String(value.kind)) ? value.kind as SemanticRecordKind : undefined;
  const authority = ['attested_observer', 'authenticated_adapter', 'server_graph', 'inferred'].includes(String(value.authority)) ? value.authority as SemanticRecord['authority'] : undefined;
  const sourceRefs = boundedRefs(value.sourceRefs);
  const derivedFrom = boundedRefs(value.derivedFrom);
  const observedAtUnixNs = unixNs(value.observedAtUnixNs);
  const completeness = ['complete', 'partial', 'unparsed', 'unsupported', 'missing'].includes(String(value.completeness)) ? value.completeness as SemanticCompleteness : undefined;
  const partialReasons = boundedRefs(value.partialReasons, 64);
  if (!semanticRecordId || revision === undefined || (value.resolutionRevision !== undefined && resolutionRevision === undefined) || !kind || !authority || !sourceRefs || !derivedFrom || !observedAtUnixNs || !completeness || !partialReasons || sourceRefs.length === 0 || derivedFrom.length === 0) return { ok: false, reason: 'semantic record has missing or invalid fields' };
  const role = value.role === undefined ? undefined : (['user', 'model', 'tool', 'system'].includes(String(value.role)) ? value.role as SemanticRecord['role'] : undefined);
  if (value.role !== undefined && !role) return { ok: false, reason: 'semantic record role is invalid', field: 'role' };
  const logicalScopeMode = value.logicalScopeMode === undefined ? undefined
    : ['registered_definition', 'workflow_definition', 'service_definition', 'terminal', 'unresolved'].includes(String(value.logicalScopeMode))
      ? value.logicalScopeMode as LogicalScopeMode : undefined;
  const logicalIdentityAuthority = value.logicalIdentityAuthority === undefined ? undefined
    : ['management_registration', 'authenticated_adapter', 'inferred', 'unknown'].includes(String(value.logicalIdentityAuthority))
      ? value.logicalIdentityAuthority as LogicalAgentDefinition['logicalIdentityAuthority'] : undefined;
  if (value.logicalScopeMode !== undefined && !logicalScopeMode) return { ok: false, reason: 'semantic record logicalScopeMode is invalid' };
  if (value.logicalIdentityAuthority !== undefined && !logicalIdentityAuthority) return { ok: false, reason: 'semantic record logicalIdentityAuthority is invalid' };
  const providerSessionIdHash = text(value.providerSessionIdHash, 64);
  if (value.providerSessionIdHash !== undefined && (!providerSessionIdHash || !HEX64.test(providerSessionIdHash))) return { ok: false, reason: 'semantic record providerSessionIdHash is invalid' };
  const canonicalSessionId = trustedCanonicalSessionId(value.canonicalSessionId);
  if (value.canonicalSessionId !== undefined && !canonicalSessionId) return { ok: false, reason: 'semantic record canonicalSessionId is invalid' };
  const sessionNamespaceKey = text(value.sessionNamespaceKey, 512);
  const sessionMode = value.sessionMode === undefined ? undefined
    : ['resumable', 'conversation', 'per_request', 'ephemeral', 'unknown'].includes(String(value.sessionMode))
      ? value.sessionMode as SemanticRecord['sessionMode'] : undefined;
  const sessionLifecycle = value.sessionLifecycle === undefined ? undefined
    : ['new', 'resume', 'fork'].includes(String(value.sessionLifecycle))
      ? value.sessionLifecycle as SemanticRecord['sessionLifecycle'] : undefined;
  const canonicalParentSessionId = trustedCanonicalSessionId(value.canonicalParentSessionId);
  if (value.canonicalParentSessionId !== undefined && !canonicalParentSessionId) return { ok: false, reason: 'semantic record canonicalParentSessionId is invalid' };
  if (value.sessionNamespaceKey !== undefined && !sessionNamespaceKey) return { ok: false, reason: 'semantic record sessionNamespaceKey is invalid' };
  if (value.sessionMode !== undefined && !sessionMode) return { ok: false, reason: 'semantic record sessionMode is invalid' };
  if (value.sessionLifecycle !== undefined && !sessionLifecycle) return { ok: false, reason: 'semantic record sessionLifecycle is invalid' };
  return { ok: true, value: { schemaVersion: CANONICAL_SCHEMA_VERSIONS.semanticRecord, semanticRecordId, revision, ...(resolutionRevision !== undefined ? { resolutionRevision } : {}), kind, authority, sourceRefs, derivedFrom, observedAtUnixNs, completeness, partialReasons, ...(text(value.parserId, 240) ? { parserId: text(value.parserId, 240) } : {}), ...(text(value.parserVersion, 120) ? { parserVersion: text(value.parserVersion, 120) } : {}), ...(text(value.logicalAgentId, 240) ? { logicalAgentId: text(value.logicalAgentId, 240) } : {}), ...(text(value.agentInstanceId, 240) ? { agentInstanceId: text(value.agentInstanceId, 240) } : {}), ...(text(value.runtimeInstanceId, 240) ? { runtimeInstanceId: text(value.runtimeInstanceId, 240) } : {}), ...(text(value.sessionId, 512) ? { sessionId: text(value.sessionId, 512) } : {}), ...(canonicalSessionId ? { canonicalSessionId } : {}), ...(sessionNamespaceKey ? { sessionNamespaceKey } : {}), ...(text(value.sessionKey, 512) ? { sessionKey: text(value.sessionKey, 512) } : {}), ...(providerSessionIdHash ? { providerSessionIdHash } : {}), ...(text(value.turnId, 512) ? { turnId: text(value.turnId, 512) } : {}), ...(text(value.runId, 512) ? { runId: text(value.runId, 512) } : {}), ...(sessionMode ? { sessionMode } : {}), ...(sessionLifecycle ? { sessionLifecycle } : {}), ...(text(value.parentSessionId, 512) ? { parentSessionId: text(value.parentSessionId, 512) } : {}), ...(canonicalParentSessionId ? { canonicalParentSessionId } : {}), ...(text(value.toolCallId, 512) ? { toolCallId: text(value.toolCallId, 512) } : {}), ...(text(value.tenantId, 240) ? { tenantId: text(value.tenantId, 240) } : {}), ...(text(value.ownerId, 240) ? { ownerId: text(value.ownerId, 240) } : {}), ...(text(value.logicalDefinitionFingerprint, 64) && HEX64.test(text(value.logicalDefinitionFingerprint, 64)!) ? { logicalDefinitionFingerprint: text(value.logicalDefinitionFingerprint, 64) } : {}), ...(logicalScopeMode ? { logicalScopeMode } : {}), ...(logicalIdentityAuthority ? { logicalIdentityAuthority } : {}), ...(text(value.profile, 240) ? { profile: text(value.profile, 240) } : {}), ...(text(value.profileVersion, 120) ? { profileVersion: text(value.profileVersion, 120) } : {}), ...(text(value.deploymentId, 240) ? { deploymentId: text(value.deploymentId, 240) } : {}), ...(text(value.deploymentRevision, 120) ? { deploymentRevision: text(value.deploymentRevision, 120) } : {}), ...(text(value.environmentId, 240) ? { environmentId: text(value.environmentId, 240) } : {}), ...(text(value.terminalContextId, 240) ? { terminalContextId: text(value.terminalContextId) } : {}), ...(role ? { role } : {}), ...(text(value.payloadRef, 512) ? { payloadRef: text(value.payloadRef, 512) } : {}) } };
}

export function validateLogicalAgentDefinition(input: unknown): CanonicalValidationResult<LogicalAgentDefinition> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, reason: 'logical agent definition must be an object' };
  const value = input as Record<string, unknown>;
  const family = text(value.family, 160);
  const mode = ['registered_definition', 'workflow_definition', 'service_definition', 'terminal', 'unresolved'].includes(String(value.logicalScopeMode)) ? value.logicalScopeMode as LogicalScopeMode : undefined;
  const fingerprint = text(value.definitionFingerprint, 64);
  const quality = ['confirmed', 'strong', 'inferred', 'candidate', 'unresolved', 'ephemeral', 'conflict'].includes(String(value.identityQuality)) ? value.identityQuality as IdentityQuality : undefined;
  const logicalIdentityAuthority = ['management_registration', 'authenticated_adapter', 'inferred', 'unknown'].includes(String(value.logicalIdentityAuthority))
    ? value.logicalIdentityAuthority as LogicalAgentDefinition['logicalIdentityAuthority'] : undefined;
  const sourceRefs = boundedRefs(value.sourceRefs);
  const definitionType = value.definitionType === undefined ? undefined : (['registered', 'workflow', 'service', 'graph', 'application', 'candidate'].includes(String(value.definitionType)) ? value.definitionType as LogicalAgentDefinition['definitionType'] : undefined);
  if (!family || !mode || !fingerprint || !/^[a-f0-9]{64}$/u.test(fingerprint) || !quality || !logicalIdentityAuthority || !sourceRefs || (value.definitionType !== undefined && !definitionType)) return { ok: false, reason: 'logical agent definition has missing or invalid fields' };
  const logicalAgentId = text(value.logicalAgentId, 240);
  const terminalContextId = text(value.terminalContextId, 240);
  const environmentId = text(value.environmentId, 240);
  if (value.environmentId !== undefined && !environmentId) {
    return { ok: false, reason: 'logical agent definition environmentId is invalid', field: 'environmentId' };
  }
  // A stable definition is an addressable management object.  Accepting a `confirmed`/`strong`
  // quality without its logical ID would force downstream readers to fall back to a product,
  // PID, or workspace key and would violate the identity boundary.  Likewise, an explicitly
  // terminal-scoped definition must carry the terminal evidence that made it a distinct scope.
  if (['confirmed', 'strong'].includes(quality) && !logicalAgentId) {
    return { ok: false, reason: 'stable logical agent definition requires logicalAgentId' };
  }
  if (quality === 'confirmed' && logicalIdentityAuthority !== 'management_registration') {
    return { ok: false, reason: 'confirmed logical definition requires management registration authority' };
  }
  if (['confirmed', 'strong'].includes(quality) && sourceRefs.length === 0) {
    return { ok: false, reason: 'stable logical definition requires sourceRefs' };
  }
  if (mode === 'terminal' && !terminalContextId) {
    return { ok: false, reason: 'terminal logical scope requires terminalContextId' };
  }
  return { ok: true, value: { schemaVersion: CANONICAL_SCHEMA_VERSIONS.logicalAgentDefinition, family, logicalScopeMode: mode, definitionFingerprint: fingerprint, identityQuality: quality, logicalIdentityAuthority, sourceRefs, ...(logicalAgentId ? { logicalAgentId } : {}), ...(text(value.tenantId, 240) ? { tenantId: text(value.tenantId, 240) } : {}), ...(text(value.ownerId, 240) ? { ownerId: text(value.ownerId, 240) } : {}), ...(text(value.workspacePath, 1_024) ? { workspacePath: text(value.workspacePath, 1_024) } : {}), ...(text(value.repositoryId, 240) ? { repositoryId: text(value.repositoryId, 240) } : {}), ...(text(value.profile, 240) ? { profile: text(value.profile, 240) } : {}), ...(text(value.profileVersion, 120) ? { profileVersion: text(value.profileVersion, 120) } : {}), ...(text(value.deploymentId, 240) ? { deploymentId: text(value.deploymentId, 240) } : {}), ...(text(value.deploymentRevision, 120) ? { deploymentRevision: text(value.deploymentRevision, 120) } : {}), ...(environmentId ? { environmentId } : {}), ...(text(value.definitionId, 240) ? { definitionId: text(value.definitionId, 240) } : {}), ...(terminalContextId ? { terminalContextId } : {}), ...(definitionType ? { definitionType } : {}) } };
}

export function validateSessionMembership(input: unknown): CanonicalValidationResult<SessionMembership> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, reason: 'session membership must be an object' };
  const value = input as Record<string, unknown>;
  const membershipId = text(value.membershipId, 240);
  const sessionId = text(value.sessionId, 512);
  const role = ['conversation', 'context_replay', 'bootstrap', 'control', 'background', 'tool_backend', 'derived_metadata', 'retry', 'unclassified'].includes(String(value.role)) ? value.role as SessionMembershipRole : undefined;
  const confidence = ['confirmed', 'strong', 'inferred', 'candidate', 'unresolved', 'ephemeral', 'conflict'].includes(String(value.confidence)) ? value.confidence as IdentityQuality : undefined;
  const resolverVersion = text(value.resolverVersion, 120);
  const sourceRefs = boundedRefs(value.sourceRefs);
  const evidence = boundedRefs(value.evidence, 128);
  const validFromUnixNs = unixNs(value.validFromUnixNs);
  const resolutionRevision = positiveInteger(value.resolutionRevision, Number.MAX_SAFE_INTEGER);
  if (value.schemaVersion !== CANONICAL_SCHEMA_VERSIONS.sessionMembership || !membershipId || !sessionId || !role || !confidence || !resolverVersion || !sourceRefs || sourceRefs.length === 0 || !evidence || evidence.length === 0 || !validFromUnixNs || resolutionRevision === undefined) return { ok: false, reason: 'session membership has missing or invalid fields' };
  const sessionKey = text(value.sessionKey, 512);
  if (['confirmed', 'strong'].includes(String(confidence)) && !sessionKey) {
    return { ok: false, reason: 'confirmed/strong session membership requires a namespaced sessionKey' };
  }
  const providerSessionIdHash = text(value.providerSessionIdHash, 64);
  if (value.providerSessionIdHash !== undefined && (!providerSessionIdHash || !HEX64.test(providerSessionIdHash))) {
    return { ok: false, reason: 'session membership providerSessionIdHash is invalid' };
  }
  const sessionNamespaceKey = text(value.sessionNamespaceKey, 512);
  if (value.sessionNamespaceKey !== undefined && !sessionNamespaceKey) {
    return { ok: false, reason: 'session membership sessionNamespaceKey is invalid' };
  }
  const sessionMode = value.sessionMode === undefined ? undefined
    : ['resumable', 'conversation', 'per_request', 'ephemeral', 'unknown'].includes(String(value.sessionMode))
      ? value.sessionMode as SessionMembership['sessionMode'] : undefined;
  const sessionLifecycle = value.sessionLifecycle === undefined ? undefined
    : ['new', 'resume', 'fork'].includes(String(value.sessionLifecycle))
      ? value.sessionLifecycle as SessionMembership['sessionLifecycle'] : undefined;
  if (value.sessionMode !== undefined && !sessionMode) return { ok: false, reason: 'session membership sessionMode is invalid' };
  if (value.sessionLifecycle !== undefined && !sessionLifecycle) return { ok: false, reason: 'session membership sessionLifecycle is invalid' };
  if (value.validToUnixNs !== undefined) {
    const validTo = unixNs(value.validToUnixNs);
    if (!validTo || BigInt(validTo) < BigInt(validFromUnixNs)) {
      return { ok: false, reason: 'session membership validToUnixNs must not precede validFromUnixNs' };
    }
  }
  const canonicalParentSessionId = trustedCanonicalSessionId(value.canonicalParentSessionId);
  if (value.canonicalParentSessionId !== undefined && !canonicalParentSessionId) {
    return { ok: false, reason: 'session membership canonicalParentSessionId is invalid' };
  }
  return { ok: true, value: { schemaVersion: CANONICAL_SCHEMA_VERSIONS.sessionMembership, membershipId, sessionId, role, confidence, resolverVersion, sourceRefs, evidence, validFromUnixNs, resolutionRevision, ...(sessionKey ? { sessionKey } : {}), ...(providerSessionIdHash ? { providerSessionIdHash } : {}), ...(sessionNamespaceKey ? { sessionNamespaceKey } : {}), ...(sessionMode ? { sessionMode } : {}), ...(sessionLifecycle ? { sessionLifecycle } : {}), ...(text(value.parentSessionId, 512) ? { parentSessionId: text(value.parentSessionId, 512) } : {}), ...(canonicalParentSessionId ? { canonicalParentSessionId } : {}), ...(text(value.interactionId, 240) ? { interactionId: text(value.interactionId, 240) } : {}), ...(text(value.semanticRecordId, 240) ? { semanticRecordId: text(value.semanticRecordId, 240) } : {}), ...(text(value.logicalAgentId, 240) ? { logicalAgentId: text(value.logicalAgentId, 240) } : {}), ...(text(value.agentInstanceId, 240) ? { agentInstanceId: text(value.agentInstanceId, 240) } : {}), ...(text(value.runtimeInstanceId, 240) ? { runtimeInstanceId: text(value.runtimeInstanceId, 240) } : {}), ...(text(value.segmentId, 240) ? { segmentId: text(value.segmentId, 240) } : {}), ...(unixNs(value.validToUnixNs) ? { validToUnixNs: unixNs(value.validToUnixNs) } : {}) } };
}

export function validateAgentInstance(input: unknown): CanonicalValidationResult<AgentInstance> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, reason: 'agent instance must be an object' };
  const value = input as Record<string, unknown>;
  const agentInstanceId = text(value.agentInstanceId, 512);
  const startedAtUnixNs = unixNs(value.startedAtUnixNs);
  const sourceRefs = boundedRefs(value.sourceRefs);
  const identityQuality = ['confirmed', 'strong', 'inferred', 'candidate', 'unresolved', 'ephemeral', 'conflict'].includes(String(value.identityQuality)) ? value.identityQuality as IdentityQuality : undefined;
  const instanceKind = ['root_process_generation', 'deployment_revision', 'workflow_revision', 'service_start', 'unknown'].includes(String(value.instanceKind)) ? value.instanceKind as AgentInstance['instanceKind'] : undefined;
  if (value.schemaVersion !== CANONICAL_SCHEMA_VERSIONS.agentInstance || !agentInstanceId || !startedAtUnixNs || !sourceRefs || sourceRefs.length === 0 || !identityQuality || !instanceKind) return { ok: false, reason: 'agent instance has missing or invalid fields' };
  if (value.endedAtUnixNs !== undefined && !unixNs(value.endedAtUnixNs)) return { ok: false, reason: 'agent instance endedAtUnixNs is invalid' };
  if (value.endedAtUnixNs !== undefined && BigInt(String(value.endedAtUnixNs)) < BigInt(startedAtUnixNs)) return { ok: false, reason: 'agent instance endedAtUnixNs must not precede startedAtUnixNs' };
  return { ok: true, value: { schemaVersion: CANONICAL_SCHEMA_VERSIONS.agentInstance, agentInstanceId, startedAtUnixNs, identityQuality, instanceKind, sourceRefs, ...(text(value.logicalAgentId, 240) ? { logicalAgentId: text(value.logicalAgentId, 240) } : {}), ...(text(value.revision, 120) ? { revision: text(value.revision, 120) } : {}), ...(unixNs(value.endedAtUnixNs) ? { endedAtUnixNs: unixNs(value.endedAtUnixNs) } : {}) } };
}

export function validateRuntimeInstance(input: unknown): CanonicalValidationResult<RuntimeInstance> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, reason: 'runtime instance must be an object' };
  const value = input as Record<string, unknown>;
  const runtimeInstanceId = text(value.runtimeInstanceId, 512);
  const environment = ['host', 'ssh', 'docker', 'kubernetes', 'microvm', 'unknown'].includes(String(value.environment)) ? value.environment as RuntimeEnvironment : undefined;
  const processGenerationKeys = boundedRefs(value.processGenerationKeys, 4_096);
  const sourceRefs = boundedRefs(value.sourceRefs);
  const startedAtUnixNs = unixNs(value.startedAtUnixNs);
  const state = ['starting', 'running', 'idle', 'exited', 'lost', 'unobserved'].includes(String(value.state)) ? value.state as RuntimeInstance['state'] : undefined;
  if (value.schemaVersion !== CANONICAL_SCHEMA_VERSIONS.runtimeInstance || !runtimeInstanceId || !environment || !processGenerationKeys || !sourceRefs || sourceRefs.length === 0 || !startedAtUnixNs || !state) return { ok: false, reason: 'runtime instance has missing or invalid fields' };
  if (value.endedAtUnixNs !== undefined && !unixNs(value.endedAtUnixNs)) return { ok: false, reason: 'runtime instance endedAtUnixNs is invalid' };
  if (value.endedAtUnixNs !== undefined && BigInt(String(value.endedAtUnixNs)) < BigInt(startedAtUnixNs)) return { ok: false, reason: 'runtime instance endedAtUnixNs must not precede startedAtUnixNs' };
  return { ok: true, value: { schemaVersion: CANONICAL_SCHEMA_VERSIONS.runtimeInstance, runtimeInstanceId, environment, processGenerationKeys, sourceRefs, startedAtUnixNs, state, ...(text(value.agentInstanceId, 512) ? { agentInstanceId: text(value.agentInstanceId, 512) } : {}), ...(text(value.terminalContextId, 240) ? { terminalContextId: text(value.terminalContextId, 240) } : {}), ...(unixNs(value.endedAtUnixNs) ? { endedAtUnixNs: unixNs(value.endedAtUnixNs) } : {}) } };
}

export function validateEvidenceLink(input: unknown): CanonicalValidationResult<EvidenceLink> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, reason: 'evidence link must be an object' };
  const value = input as Record<string, unknown>;
  const fields = ['linkId', 'fromId', 'toId', 'algorithmVersion'].map((field) => text(value[field], 512));
  const [linkId, fromId, toId, algorithmVersion] = fields;
  const method = ['explicit_id', 'connection_stream', 'process_generation', 'command', 'resource', 'network', 'temporal', 'none'].includes(String(value.method)) ? value.method as EvidenceLinkMethod : undefined;
  const status = ['confirmed', 'strong', 'inferred', 'ambiguous', 'unmatched', 'coverage_gap'].includes(String(value.status)) ? value.status as EvidenceLinkStatus : undefined;
  const authority = ['attested_observer', 'authenticated_adapter', 'server_graph', 'inferred'].includes(String(value.authority)) ? value.authority as EvidenceLink['authority'] : undefined;
  const fromType = ['semantic_record', 'llm_call', 'tool_call', 'session', 'runtime', 'agent_instance'].includes(String(value.fromType)) ? value.fromType as EvidenceLink['fromType'] : undefined;
  const toType = ['raw_observation', 'kernel_fact', 'process_generation', 'connection', 'file', 'network', 'security'].includes(String(value.toType)) ? value.toType as EvidenceLink['toType'] : undefined;
  const relation = ['emitted_by', 'executes_as', 'file_effect', 'network_effect', 'supports', 'contains'].includes(String(value.relation)) ? value.relation as EvidenceLink['relation'] : undefined;
  const evidenceRefs = boundedRefs(value.evidenceRefs);
  const validFromUnixNs = unixNs(value.validFromUnixNs);
  const resolutionRevision = positiveInteger(value.resolutionRevision, Number.MAX_SAFE_INTEGER);
  const confidence = typeof value.confidence === 'number' && Number.isFinite(value.confidence) && value.confidence >= 0 && value.confidence <= 1 ? value.confidence : undefined;
  if (value.schemaVersion !== CANONICAL_SCHEMA_VERSIONS.evidenceLink || !linkId || !fromId || !toId || !algorithmVersion || !method || !status || !authority || !fromType || !toType || !relation || !evidenceRefs || evidenceRefs.length === 0 || !validFromUnixNs || resolutionRevision === undefined || confidence === undefined) return { ok: false, reason: 'evidence link has missing or invalid fields' };
  if ((status === 'ambiguous' || status === 'unmatched' || status === 'coverage_gap') && confidence !== 0) {
    return { ok: false, reason: 'non-unique or unavailable evidence must have zero confidence' };
  }
  if ((method === 'temporal' || method === 'none') && status === 'confirmed') {
    return { ok: false, reason: 'temporal/none evidence cannot be confirmed' };
  }
  if (value.validToUnixNs !== undefined) {
    const validTo = unixNs(value.validToUnixNs);
    if (!validTo || BigInt(validTo) < BigInt(validFromUnixNs)) {
      return { ok: false, reason: 'validToUnixNs must not precede validFromUnixNs' };
    }
  }
  return { ok: true, value: { schemaVersion: CANONICAL_SCHEMA_VERSIONS.evidenceLink, linkId, fromId, toId, algorithmVersion, method, status, authority, evidenceRefs, validFromUnixNs, resolutionRevision, confidence, fromType, toType, relation, ...(unixNs(value.validToUnixNs) ? { validToUnixNs: unixNs(value.validToUnixNs) } : {}) } };
}

export function validateCoverageGap(input: unknown): CanonicalValidationResult<CoverageGap> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, reason: 'coverage gap must be an object' };
  const value = input as Record<string, unknown>;
  const gapId = text(value.gapId, 240);
  const stage = ['ingest', 'raw_commit', 'runtime', 'transport', 'llm_format', 'agent_adapter', 'identity', 'session', 'correlation', 'judgment', 'projection'].includes(String(value.stage)) ? value.stage as CoverageGapStage : undefined;
  const reason = text(value.reason, 240);
  const scope = text(value.scope, 512);
  const sourceRefs = boundedRefs(value.sourceRefs);
  const firstSeenAtUnixNs = unixNs(value.firstSeenAtUnixNs);
  const lastSeenAtUnixNs = unixNs(value.lastSeenAtUnixNs);
  const droppedCount = nonNegativeInteger(value.droppedCount);
  const orphanedCount = nonNegativeInteger(value.orphanedCount);
  const revision = positiveInteger(value.revision, Number.MAX_SAFE_INTEGER);
  if (value.schemaVersion !== CANONICAL_SCHEMA_VERSIONS.coverageGap || !gapId || !stage || !reason || !scope || !sourceRefs || sourceRefs.length === 0 || !firstSeenAtUnixNs || !lastSeenAtUnixNs || droppedCount === undefined || orphanedCount === undefined || revision === undefined) return { ok: false, reason: 'coverage gap has missing or invalid fields' };
  try {
    if (BigInt(lastSeenAtUnixNs) < BigInt(firstSeenAtUnixNs)) {
      return { ok: false, reason: 'lastSeenAtUnixNs must not precede firstSeenAtUnixNs' };
    }
  } catch {
    return { ok: false, reason: 'coverage gap timestamp is invalid' };
  }
  return { ok: true, value: { schemaVersion: CANONICAL_SCHEMA_VERSIONS.coverageGap, gapId, stage, reason, scope, sourceRefs, firstSeenAtUnixNs, lastSeenAtUnixNs, droppedCount, orphanedCount, revision, ...(value.details && typeof value.details === 'object' && !Array.isArray(value.details) ? { details: value.details as CoverageGap['details'] } : {}) } };
}

export function validateKernelFact(input: unknown): CanonicalValidationResult<KernelFact> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, reason: 'kernel fact must be an object' };
  const value = input as Record<string, unknown>;
  const factId = text(value.factId, 240);
  const kind = text(value.kind, 120);
  const authority = ['attested_observer', 'server_process_graph', 'inferred'].includes(String(value.authority)) ? value.authority as KernelFact['authority'] : undefined;
  const sourceRefs = boundedRefs(value.sourceRefs);
  const derivedFrom = boundedRefs(value.derivedFrom);
  const observedAtUnixNs = unixNs(value.observedAtUnixNs);
  const status = ['observed', 'completed', 'failed', 'partial', 'unknown'].includes(String(value.status)) ? value.status as KernelFactStatus : undefined;
  if (value.schemaVersion !== 'anysentry.kernel_fact.v1' || !factId || !kind || !authority || !sourceRefs || sourceRefs.length === 0 || !derivedFrom || !observedAtUnixNs || !status) return { ok: false, reason: 'kernel fact has missing or invalid fields' };
  const processGenerationKey = value.processGenerationKey === undefined ? undefined : text(value.processGenerationKey, 128);
  const parentProcessGenerationKey = value.parentProcessGenerationKey === undefined ? undefined : text(value.parentProcessGenerationKey, 128);
  if ((value.processGenerationKey !== undefined && !processGenerationKey)
    || (value.parentProcessGenerationKey !== undefined && !parentProcessGenerationKey)) return { ok: false, reason: 'kernel process generation key is invalid' };
  if (processGenerationKey && !/^pgk_[a-f0-9]{24}$/u.test(processGenerationKey)) return { ok: false, reason: 'kernel processGenerationKey is invalid' };
  if (parentProcessGenerationKey && !/^pgk_[a-f0-9]{24}$/u.test(parentProcessGenerationKey)) return { ok: false, reason: 'kernel parentProcessGenerationKey is invalid' };
  return { ok: true, value: { schemaVersion: 'anysentry.kernel_fact.v1', factId, kind, authority, sourceRefs, derivedFrom, observedAtUnixNs, status, ...(processGenerationKey ? { processGenerationKey } : {}), ...(parentProcessGenerationKey ? { parentProcessGenerationKey } : {}), ...(text(value.connectionId, 240) ? { connectionId: text(value.connectionId, 240) } : {}), ...(text(value.payloadRef, 512) ? { payloadRef: text(value.payloadRef, 512) } : {}), ...(text(value.eventId, 240) ? { eventId: text(value.eventId, 240) } : {}), ...(text(value.scope, 512) ? { scope: text(value.scope, 512) } : {}) } };
}

export function validateRelationRevision(input: unknown): CanonicalValidationResult<RelationRevision> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, reason: 'relation revision must be an object' };
  }
  const value = input as Record<string, unknown>;
  const relationId = text(value.relationId, 512);
  const revision = positiveInteger(value.revision, Number.MAX_SAFE_INTEGER);
  const decidedAtUnixNs = unixNs(value.decidedAtUnixNs);
  const sourceRefs = boundedRefs(value.sourceRefs);
  const relation = validateEvidenceLink(value.relation);
  if (value.schemaVersion !== CANONICAL_SCHEMA_VERSIONS.relationRevision
    || !relationId || revision === undefined || !decidedAtUnixNs || !sourceRefs || sourceRefs.length === 0
    || !relation.ok) {
    return { ok: false, reason: 'relation revision has missing or invalid fields' };
  }
  if (relation.value.resolutionRevision !== revision) {
    return { ok: false, reason: 'relation revision and nested evidence revision must agree' };
  }
  return {
    ok: true,
    value: {
      schemaVersion: CANONICAL_SCHEMA_VERSIONS.relationRevision,
      relationId,
      revision,
      relation: relation.value,
      decidedAtUnixNs,
      sourceRefs,
      ...(text(value.supersedesRelationId, 512)
        ? { supersedesRelationId: text(value.supersedesRelationId, 512) }
        : {}),
    },
  };
}

export function normalizeKernelFact(input: {
  kind: string;
  observedAtUnixNs: string;
  sourceRefs?: string[];
  derivedFrom?: string[];
  processGenerationKey?: string;
  parentProcessGenerationKey?: string;
  connectionId?: string;
  payloadRef?: string;
  eventId?: string;
  scope?: string;
  status?: KernelFactStatus;
  authority?: KernelFact['authority'];
}): KernelFact {
  const sourceRefs = [...new Set((input.sourceRefs ?? []).map((ref) => text(ref, 512)).filter((ref): ref is string => Boolean(ref)))].slice(0, 128);
  const derivedFrom = [...new Set((input.derivedFrom ?? []).map((ref) => text(ref, 512)).filter((ref): ref is string => Boolean(ref)))].slice(0, 128);
  const identity = [input.kind, input.observedAtUnixNs, input.processGenerationKey, input.connectionId, input.eventId, ...sourceRefs].join('\0');
  return {
    schemaVersion: 'anysentry.kernel_fact.v1',
    factId: stableId('kf', identity),
    kind: text(input.kind, 120) ?? 'unknown',
    authority: input.authority ?? 'attested_observer',
    // A normalized fact must remain traceable even when a low-level producer omitted explicit
    // references. Use a non-secret normalizer marker rather than inventing a product identity;
    // callers that have a real Observer reference retain it above.
    sourceRefs: sourceRefs.length > 0
      ? sourceRefs
      : [derivedFrom[0] ?? 'normalizer:kernel_fact.v1'],
    derivedFrom,
    observedAtUnixNs: unixNs(input.observedAtUnixNs) ?? '1000000000',
    ...(text(input.processGenerationKey, 128) ? { processGenerationKey: text(input.processGenerationKey, 128) } : {}),
    ...(text(input.parentProcessGenerationKey, 128) ? { parentProcessGenerationKey: text(input.parentProcessGenerationKey, 128) } : {}),
    ...(text(input.connectionId, 240) ? { connectionId: text(input.connectionId, 240) } : {}),
    ...(text(input.payloadRef, 512) ? { payloadRef: text(input.payloadRef, 512) } : {}),
    ...(text(input.eventId, 240) ? { eventId: text(input.eventId, 240) } : {}),
    ...(text(input.scope, 512) ? { scope: text(input.scope, 512) } : {}),
    status: input.status ?? 'observed',
  };
}

export type KernelFactStoreResult =
  | { status: 'inserted'; fact: KernelFact }
  | { status: 'duplicate'; fact: KernelFact }
  | { status: 'conflict' | 'rejected' | 'evicted'; reason: string };

export class KernelFactStore {
  private static readonly MAX_ALIASES_PER_FACT = 128;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly ttlMs: number;
  private readonly maxAliasEntries: number;
  private readonly maxAliasBytes: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, { fact: KernelFact; bytes: number; insertedAt: number }>();
  private readonly fingerprints = new Map<string, string>();
  /**
   * A locator is deliberately separate from the canonical fact map.  `factId` remains the sole
   * immutable primary identity; event/source IDs are compatibility aliases and may resolve to
   * more than one fact while a producer is retrying or a revision is late.  Such an alias is
   * treated as ambiguous rather than selecting an arbitrary fact.
   */
  private readonly aliasBindings = new Map<string, Set<string>>();
  private readonly aliasesByFact = new Map<string, string[]>();
  private bytes = 0;
  private aliasBytes = 0;
  private aliasBindingCount = 0;
  private closed = false;
  private evicted = 0;
  private expired = 0;
  private dropped = 0;
  private duplicates = 0;
  private conflicts = 0;
  private aliasEvicted = 0;
  private aliasExpired = 0;
  private aliasDropped = 0;
  private aliasConflicts = 0;
  private aliasOrphans = 0;

  constructor(options: KernelFactStoreOptions = {}) {
    this.maxEntries = Math.max(1, Math.min(1_000_000, Math.trunc(options.maxEntries ?? 50_000)));
    this.maxBytes = Math.max(1, Math.min(512 * 1024 * 1024, Math.trunc(options.maxBytes ?? 64 * 1024 * 1024)));
    this.ttlMs = Math.max(1, Math.min(30 * 24 * 60 * 60_000, Math.trunc(options.ttlMs ?? 30 * 60_000)));
    this.maxAliasEntries = Math.max(
      1,
      Math.min(
        1_000_000,
        Math.trunc(options.maxAliasEntries ?? Math.max(8, Math.min(1_000_000, this.maxEntries * 8))),
      ),
    );
    this.maxAliasBytes = Math.max(
      1,
      Math.min(
        512 * 1024 * 1024,
        Math.trunc(options.maxAliasBytes ?? Math.max(1_024, Math.min(64 * 1024 * 1024, Math.floor(this.maxBytes / 2)))),
      ),
    );
    this.now = options.now ?? Date.now;
  }

  private static aliasBytesFor(alias: string, factId: string): number {
    // This is an accounting bound, not a serialization promise. Include a small fixed overhead
    // for the Map/Set entry so the configured cap remains conservative under V8 object overhead.
    return Buffer.byteLength(alias, 'utf8') + Buffer.byteLength(factId, 'utf8') + 64;
  }

  private static aliasCandidate(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const alias = value.trim();
    if (!alias || alias.length > 512 || /[\u0000-\u001f\u007f]/u.test(alias)) return undefined;
    // The fallback marker is intentionally not an addressable identity. Indexing it would make
    // every fact without a producer reference collide under one useless alias.
    if (alias === 'normalizer:kernel_fact.v1') return undefined;
    return alias;
  }

  private removeAliasBinding(alias: string, factId: string, reason: 'expired' | 'evicted' | 'orphan' = 'orphan'): void {
    const members = this.aliasBindings.get(alias);
    if (!members || !members.delete(factId)) return;
    this.aliasBindingCount = Math.max(0, this.aliasBindingCount - 1);
    this.aliasBytes = Math.max(0, this.aliasBytes - KernelFactStore.aliasBytesFor(alias, factId));
    if (reason === 'expired') this.aliasExpired += 1;
    else if (reason === 'evicted') this.aliasEvicted += 1;
    if (members.size === 0) this.aliasBindings.delete(alias);
    const aliases = this.aliasesByFact.get(factId);
    if (aliases) {
      const index = aliases.indexOf(alias);
      if (index >= 0) aliases.splice(index, 1);
      if (aliases.length === 0) this.aliasesByFact.delete(factId);
    }
  }

  private removeFactAliases(factId: string, reason: 'expired' | 'evicted' | 'orphan' = 'orphan'): void {
    const aliases = this.aliasesByFact.get(factId);
    if (!aliases) return;
    // Copy because removeAliasBinding mutates aliasesByFact and the backing array.
    for (const alias of [...aliases]) this.removeAliasBinding(alias, factId, reason);
    this.aliasesByFact.delete(factId);
  }

  private pruneAliasBudget(): void {
    while (
      this.aliasBindings.size > this.maxAliasEntries
      || this.aliasBytes > this.maxAliasBytes
    ) {
      const oldest = this.aliasBindings.entries().next().value as [string, Set<string>] | undefined;
      if (!oldest) break;
      for (const factId of [...oldest[1]]) this.removeAliasBinding(oldest[0], factId, 'evicted');
    }
  }

  /**
   * Register non-primary IDs for an already committed fact. This method never creates a fact and
   * silently drops an alias when the independent locator budget is exhausted.
   */
  registerAliases(factId: string, aliases: readonly unknown[]): boolean {
    if (this.closed) return false;
    this.purge();
    const canonical = this.entries.get(factId);
    if (!canonical) {
      this.aliasOrphans += 1;
      return false;
    }
    const candidates = [...new Set(aliases
      .map((value) => KernelFactStore.aliasCandidate(value))
      .filter((value): value is string => Boolean(value)))]
      .filter((alias) => alias !== factId)
      .slice(0, KernelFactStore.MAX_ALIASES_PER_FACT);
    let registered = false;
    for (const alias of candidates) {
      const members = this.aliasBindings.get(alias);
      if (members?.has(factId)) {
        registered = true;
        continue;
      }
      const byFact = this.aliasesByFact.get(factId) ?? [];
      if (byFact.length >= KernelFactStore.MAX_ALIASES_PER_FACT) {
        this.aliasDropped += 1;
        continue;
      }
      const bytes = KernelFactStore.aliasBytesFor(alias, factId);
      if (!Number.isSafeInteger(bytes)
        || bytes > this.maxAliasBytes
        || this.aliasBindings.size >= this.maxAliasEntries && !members
        || this.aliasBytes + bytes > this.maxAliasBytes) {
        this.aliasDropped += 1;
        continue;
      }
      const target = members ?? new Set<string>();
      target.add(factId);
      this.aliasBindings.set(alias, target);
      this.aliasBindingCount += 1;
      this.aliasBytes += bytes;
      if (!byFact.includes(alias)) byFact.push(alias);
      this.aliasesByFact.set(factId, byFact);
      registered = true;
    }
    this.pruneAliasBudget();
    return registered;
  }

  private purge(at = this.now()): void {
    for (const [key, entry] of this.entries) {
      // Entries are append-ordered and never touched in place, so the first live entry bounds the
      // remaining scan. This keeps expiry work proportional to the expired prefix at high ingest
      // rates instead of walking the entire hot map on every read.
      if (at - entry.insertedAt <= this.ttlMs) break;
      this.entries.delete(key);
      this.bytes = Math.max(0, this.bytes - entry.bytes);
      this.fingerprints.delete(key);
      this.removeFactAliases(key, 'expired');
      this.expired += 1;
    }
  }

  append(input: KernelFact | unknown): KernelFactStoreResult {
    if (this.closed) return { status: 'rejected', reason: 'kernel fact store is closed' };
    this.purge();
    const checked = validateKernelFact(input);
    if (!checked.ok) {
      this.dropped += 1;
      return { status: 'rejected', reason: checked.reason };
    }
    const fact = structuredClone(checked.value);
    const key = fact.factId;
    const fingerprint = sha256(JSON.stringify(fact));
    const existing = this.entries.get(key);
    if (existing) {
      if (this.fingerprints.get(key) === fingerprint) {
        this.registerAliases(key, [existing.fact.eventId, ...existing.fact.sourceRefs, ...existing.fact.derivedFrom]);
        this.duplicates += 1;
        return { status: 'duplicate', fact: structuredClone(existing.fact) };
      }
      this.conflicts += 1;
      return { status: 'conflict', reason: 'factId is already bound to another payload' };
    }
    const bytes = jsonBytes(fact);
    if (!Number.isSafeInteger(bytes) || bytes > this.maxBytes) {
      this.dropped += 1;
      return { status: 'rejected', reason: 'kernel fact exceeds max_bytes' };
    }
    this.entries.set(key, { fact, bytes, insertedAt: this.now() });
    this.fingerprints.set(key, fingerprint);
    this.bytes += bytes;
    this.registerAliases(key, [fact.eventId, ...fact.sourceRefs, ...fact.derivedFrom]);
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.entries.entries().next().value as [string, { fact: KernelFact; bytes: number; insertedAt: number }] | undefined;
      if (!oldest) break;
      this.entries.delete(oldest[0]);
      this.fingerprints.delete(oldest[0]);
      this.bytes = Math.max(0, this.bytes - oldest[1].bytes);
      this.removeFactAliases(oldest[0], 'evicted');
      this.evicted += 1;
    }
    if (!this.entries.has(key)) {
      this.dropped += 1;
      return { status: 'evicted', reason: 'kernel fact evicted at capacity' };
    }
    return { status: 'inserted', fact: structuredClone(fact) };
  }

  appendMany(inputs: readonly (KernelFact | unknown)[]): KernelFactStoreResult[] {
    const bounded = inputs.slice(0, this.maxEntries);
    const results = bounded.map((input) => this.append(input));
    const overflow = inputs.length - bounded.length;
    if (overflow > 0) {
      this.dropped = Math.min(Number.MAX_SAFE_INTEGER, this.dropped + overflow);
      results.push(...Array.from({ length: overflow }, () => ({
        status: 'rejected' as const,
        reason: 'kernel fact batch exceeds max_entries',
      })));
    }
    return results;
  }

  get(factId: string): KernelFact | undefined {
    const canonical = this.getCanonical(factId);
    if (canonical) return canonical;
    return this.getByAlias(factId);
  }

  /** Exact primary lookup. Unlike get(), this never interprets a compatibility alias. */
  getCanonical(factId: string): KernelFact | undefined {
    this.purge();
    const entry = this.entries.get(factId);
    return entry ? structuredClone(entry.fact) : undefined;
  }

  /** Resolve an event/source alias to its sole live canonical fact ID. */
  resolveFactId(alias: string): string | undefined {
    this.purge();
    const normalized = KernelFactStore.aliasCandidate(alias);
    if (!normalized) return undefined;
    if (this.entries.has(normalized)) return normalized;
    const members = this.aliasBindings.get(normalized);
    if (!members) return undefined;
    const live = [...members].filter((factId) => this.entries.has(factId));
    // Defensive cleanup covers rows restored by an older process that did not have reverse alias
    // cleanup. It also keeps an orphaned alias from pinning a stale fact ID indefinitely.
    for (const factId of [...members]) {
      if (!this.entries.has(factId)) this.removeAliasBinding(normalized, factId, 'orphan');
    }
    if (live.length === 1) return live[0];
    if (live.length > 1) this.aliasConflicts += 1;
    return undefined;
  }

  getByAlias(alias: string): KernelFact | undefined {
    const factId = this.resolveFactId(alias);
    return factId ? this.getCanonical(factId) : undefined;
  }

  list(limit = this.maxEntries): KernelFact[] {
    this.purge();
    const requested = Number(limit);
    const bounded = Number.isFinite(requested)
      ? Math.max(1, Math.min(this.maxEntries, Math.trunc(requested)))
      : this.maxEntries;
    return [...this.entries.values()].slice(-bounded).map((entry) => structuredClone(entry.fact));
  }

  stats(): KernelFactStoreStats {
    this.purge();
    return {
      entries: this.entries.size,
      bytes: this.bytes,
      maxEntries: this.maxEntries,
      maxBytes: this.maxBytes,
      ttlMs: this.ttlMs,
      evicted: this.evicted,
      expired: this.expired,
      dropped: this.dropped,
      duplicates: this.duplicates,
      conflicts: this.conflicts,
      aliasEntries: this.aliasBindings.size,
      aliasBindings: this.aliasBindingCount,
      aliasBytes: this.aliasBytes,
      aliasMaxEntries: this.maxAliasEntries,
      aliasMaxBytes: this.maxAliasBytes,
      aliasEvicted: this.aliasEvicted,
      aliasExpired: this.aliasExpired,
      aliasDropped: this.aliasDropped,
      aliasConflicts: this.aliasConflicts,
      aliasOrphans: this.aliasOrphans,
      closed: this.closed,
    };
  }

  close(): void {
    this.closed = true;
    this.entries.clear();
    this.fingerprints.clear();
    this.aliasBindings.clear();
    this.aliasesByFact.clear();
    this.bytes = 0;
    this.aliasBytes = 0;
    this.aliasBindingCount = 0;
  }
}

/** Bounded semantic projection store. Raw facts remain the source of truth; this store is only a
 * replayable, versioned projection and can be rebuilt when a parser/adapter revision changes. */
export class SemanticRecordStore {
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, { record: SemanticRecord; bytes: number; insertedAt: number }>();
  private readonly fingerprints = new Map<string, string>();
  private bytes = 0;
  private closed = false;
  private evicted = 0;
  private expired = 0;
  private dropped = 0;
  private duplicates = 0;
  private conflicts = 0;

  constructor(options: SemanticRecordStoreOptions = {}) {
    this.maxEntries = Math.max(1, Math.min(1_000_000, Math.trunc(options.maxEntries ?? 50_000)));
    this.maxBytes = Math.max(1, Math.min(512 * 1024 * 1024, Math.trunc(options.maxBytes ?? 64 * 1024 * 1024)));
    this.ttlMs = Math.max(1, Math.min(30 * 24 * 60 * 60_000, Math.trunc(options.ttlMs ?? 30 * 60_000)));
    this.now = options.now ?? Date.now;
  }

  private purge(at = this.now()): void {
    for (const [key, entry] of this.entries) {
      if (at - entry.insertedAt <= this.ttlMs) break;
      this.entries.delete(key);
      this.fingerprints.delete(key);
      this.bytes = Math.max(0, this.bytes - entry.bytes);
      this.expired += 1;
    }
  }

  append(input: SemanticRecord | unknown): SemanticRecordStoreResult {
    if (this.closed) return { status: 'rejected', reason: 'semantic record store is closed' };
    this.purge();
    const checked = validateSemanticRecord(input);
    if (!checked.ok) {
      this.dropped += 1;
      return { status: 'rejected', reason: checked.reason };
    }
    const record = structuredClone(checked.value);
    const key = `${record.semanticRecordId}\0${record.revision ?? 1}`;
    const fingerprint = sha256(JSON.stringify(record));
    const existing = this.entries.get(key);
    if (existing) {
      if (this.fingerprints.get(key) === fingerprint) {
        this.duplicates += 1;
        return { status: 'duplicate', record: structuredClone(existing.record) };
      }
      this.conflicts += 1;
      return { status: 'conflict', reason: 'semanticRecordId/revision is already bound to another payload' };
    }
    const bytes = jsonBytes(record);
    if (!Number.isSafeInteger(bytes) || bytes > this.maxBytes) {
      this.dropped += 1;
      return { status: 'rejected', reason: 'semantic record exceeds max_bytes' };
    }
    this.entries.set(key, { record, bytes, insertedAt: this.now() });
    this.fingerprints.set(key, fingerprint);
    this.bytes += bytes;
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.entries.entries().next().value as [string, { record: SemanticRecord; bytes: number; insertedAt: number }] | undefined;
      if (!oldest) break;
      this.entries.delete(oldest[0]);
      this.fingerprints.delete(oldest[0]);
      this.bytes = Math.max(0, this.bytes - oldest[1].bytes);
      this.evicted += 1;
    }
    if (!this.entries.has(key)) {
      this.dropped += 1;
      return { status: 'evicted', reason: 'semantic record evicted at capacity' };
    }
    return { status: 'inserted', record: structuredClone(record) };
  }

  appendMany(inputs: readonly (SemanticRecord | unknown)[]): SemanticRecordStoreResult[] {
    const bounded = inputs.slice(0, this.maxEntries);
    const results = bounded.map((input) => this.append(input));
    const overflow = inputs.length - bounded.length;
    if (overflow > 0) {
      this.dropped = Math.min(Number.MAX_SAFE_INTEGER, this.dropped + overflow);
      results.push(...Array.from({ length: overflow }, () => ({
        status: 'rejected' as const,
        reason: 'semantic record batch exceeds max_entries',
      })));
    }
    return results;
  }

  get(semanticRecordId: string, revision?: number): SemanticRecord | undefined {
    this.purge();
    const entry = revision === undefined
      ? [...this.entries.values()]
          .filter((candidate) => candidate.record.semanticRecordId === semanticRecordId)
          .sort((left, right) => (right.record.revision ?? 1) - (left.record.revision ?? 1))[0]
      : this.entries.get(`${semanticRecordId}\0${revision}`);
    return entry?.record ? structuredClone(entry.record) : undefined;
  }

  list(limit = this.maxEntries): SemanticRecord[] {
    this.purge();
    const requested = Number(limit);
    const bounded = Number.isFinite(requested) ? Math.max(1, Math.min(this.maxEntries, Math.trunc(requested))) : this.maxEntries;
    return [...this.entries.values()].slice(-bounded).map((entry) => structuredClone(entry.record));
  }

  stats(): SemanticRecordStoreStats {
    this.purge();
    return { entries: this.entries.size, bytes: this.bytes, maxEntries: this.maxEntries, maxBytes: this.maxBytes, ttlMs: this.ttlMs, evicted: this.evicted, expired: this.expired, dropped: this.dropped, duplicates: this.duplicates, conflicts: this.conflicts, closed: this.closed };
  }

  close(): void {
    this.closed = true;
    this.entries.clear();
    this.fingerprints.clear();
    this.bytes = 0;
  }
}

/** Bounded canonical EvidenceLink projection. Competing/late links are retained by revision. */
export class EvidenceLinkStore {
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, { link: EvidenceLink; bytes: number; insertedAt: number }>();
  private readonly fingerprints = new Map<string, string>();
  private bytes = 0;
  private closed = false;
  private evicted = 0;
  private expired = 0;
  private dropped = 0;
  private duplicates = 0;
  private conflicts = 0;

  constructor(options: EvidenceLinkStoreOptions = {}) {
    this.maxEntries = Math.max(1, Math.min(1_000_000, Math.trunc(options.maxEntries ?? 100_000)));
    this.maxBytes = Math.max(1, Math.min(512 * 1024 * 1024, Math.trunc(options.maxBytes ?? 64 * 1024 * 1024)));
    this.ttlMs = Math.max(1, Math.min(30 * 24 * 60 * 60_000, Math.trunc(options.ttlMs ?? 30 * 60_000)));
    this.now = options.now ?? Date.now;
  }

  private purge(at = this.now()): void {
    for (const [key, entry] of this.entries) {
      if (at - entry.insertedAt <= this.ttlMs) break;
      this.entries.delete(key);
      this.fingerprints.delete(key);
      this.bytes = Math.max(0, this.bytes - entry.bytes);
      this.expired += 1;
    }
  }

  append(input: EvidenceLink | unknown): EvidenceLinkStoreResult {
    if (this.closed) return { status: 'rejected', reason: 'evidence link store is closed' };
    this.purge();
    const checked = validateEvidenceLink(input);
    if (!checked.ok) {
      this.dropped += 1;
      return { status: 'rejected', reason: checked.reason };
    }
    const link = structuredClone(checked.value);
    const key = `${link.linkId}\0${link.resolutionRevision}`;
    const fingerprint = sha256(JSON.stringify(link));
    const existing = this.entries.get(key);
    if (existing) {
      if (this.fingerprints.get(key) === fingerprint) {
        this.duplicates += 1;
        return { status: 'duplicate', link: structuredClone(existing.link) };
      }
      this.conflicts += 1;
      return { status: 'conflict', reason: 'linkId/revision is already bound to another payload' };
    }
    const bytes = jsonBytes(link);
    if (!Number.isSafeInteger(bytes) || bytes > this.maxBytes) {
      this.dropped += 1;
      return { status: 'rejected', reason: 'evidence link exceeds max_bytes' };
    }
    this.entries.set(key, { link, bytes, insertedAt: this.now() });
    this.fingerprints.set(key, fingerprint);
    this.bytes += bytes;
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.entries.entries().next().value as [string, { link: EvidenceLink; bytes: number; insertedAt: number }] | undefined;
      if (!oldest) break;
      this.entries.delete(oldest[0]);
      this.fingerprints.delete(oldest[0]);
      this.bytes = Math.max(0, this.bytes - oldest[1].bytes);
      this.evicted += 1;
    }
    if (!this.entries.has(key)) {
      this.dropped += 1;
      return { status: 'evicted', reason: 'evidence link evicted at capacity' };
    }
    return { status: 'inserted', link: structuredClone(link) };
  }

  appendMany(inputs: readonly (EvidenceLink | unknown)[]): EvidenceLinkStoreResult[] {
    const bounded = inputs.slice(0, this.maxEntries);
    const results = bounded.map((input) => this.append(input));
    const overflow = inputs.length - bounded.length;
    if (overflow > 0) {
      this.dropped = Math.min(Number.MAX_SAFE_INTEGER, this.dropped + overflow);
      results.push(...Array.from({ length: overflow }, () => ({ status: 'rejected' as const, reason: 'evidence link batch exceeds max_entries' })));
    }
    return results;
  }

  get(linkId: string, resolutionRevision?: number): EvidenceLink | undefined {
    this.purge();
    const entry = resolutionRevision === undefined
      ? [...this.entries.values()]
          .filter((candidate) => candidate.link.linkId === linkId)
          .sort((left, right) => right.link.resolutionRevision - left.link.resolutionRevision)[0]
      : this.entries.get(`${linkId}\0${resolutionRevision}`);
    return entry?.link ? structuredClone(entry.link) : undefined;
  }

  list(limit = this.maxEntries): EvidenceLink[] {
    this.purge();
    const requested = Number(limit);
    const bounded = Number.isFinite(requested) ? Math.max(1, Math.min(this.maxEntries, Math.trunc(requested))) : this.maxEntries;
    return [...this.entries.values()].slice(-bounded).map((entry) => structuredClone(entry.link));
  }

  stats(): EvidenceLinkStoreStats {
    this.purge();
    return { entries: this.entries.size, bytes: this.bytes, maxEntries: this.maxEntries, maxBytes: this.maxBytes, ttlMs: this.ttlMs, evicted: this.evicted, expired: this.expired, dropped: this.dropped, duplicates: this.duplicates, conflicts: this.conflicts, closed: this.closed };
  }

  close(): void {
    this.closed = true;
    this.entries.clear();
    this.fingerprints.clear();
    this.bytes = 0;
  }
}

/** Bounded canonical SessionMembership projection.  Resolver V2 remains the compatibility source;
 * this store makes the versioned Session contract independently queryable and replayable. */
export class SessionMembershipStore {
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, { membership: SessionMembership; bytes: number; insertedAt: number }>();
  private readonly fingerprints = new Map<string, string>();
  private bytes = 0;
  private closed = false;
  private evicted = 0;
  private expired = 0;
  private dropped = 0;
  private duplicates = 0;
  private conflicts = 0;

  constructor(options: SessionMembershipStoreOptions = {}) {
    this.maxEntries = Math.max(1, Math.min(1_000_000, Math.trunc(options.maxEntries ?? 100_000)));
    this.maxBytes = Math.max(1, Math.min(512 * 1024 * 1024, Math.trunc(options.maxBytes ?? 64 * 1024 * 1024)));
    this.ttlMs = Math.max(1, Math.min(30 * 24 * 60 * 60_000, Math.trunc(options.ttlMs ?? 30 * 60_000)));
    this.now = options.now ?? Date.now;
  }

  private key(membership: SessionMembership): string {
    return `${membership.membershipId}\0${membership.resolutionRevision}`;
  }

  private purge(at = this.now()): void {
    for (const [key, entry] of this.entries) {
      if (at - entry.insertedAt <= this.ttlMs) break;
      this.entries.delete(key);
      this.fingerprints.delete(key);
      this.bytes = Math.max(0, this.bytes - entry.bytes);
      this.expired += 1;
    }
  }

  append(input: SessionMembership | unknown): SessionMembershipStoreResult {
    if (this.closed) return { status: 'rejected', reason: 'session membership store is closed' };
    this.purge();
    const checked = validateSessionMembership(input);
    if (!checked.ok) {
      this.dropped += 1;
      return { status: 'rejected', reason: checked.reason };
    }
    const membership = structuredClone(checked.value);
    const key = this.key(membership);
    const fingerprint = sha256(JSON.stringify(membership));
    const existing = this.entries.get(key);
    if (existing) {
      if (this.fingerprints.get(key) === fingerprint) {
        this.duplicates += 1;
        return { status: 'duplicate', membership: structuredClone(existing.membership) };
      }
      this.conflicts += 1;
      return { status: 'conflict', reason: 'membershipId/revision is already bound to another payload' };
    }
    const bytes = jsonBytes(membership);
    if (!Number.isSafeInteger(bytes) || bytes > this.maxBytes) {
      this.dropped += 1;
      return { status: 'rejected', reason: 'session membership exceeds max_bytes' };
    }
    this.entries.set(key, { membership, bytes, insertedAt: this.now() });
    this.fingerprints.set(key, fingerprint);
    this.bytes += bytes;
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.entries.entries().next().value as [string, { membership: SessionMembership; bytes: number; insertedAt: number }] | undefined;
      if (!oldest) break;
      this.entries.delete(oldest[0]);
      this.fingerprints.delete(oldest[0]);
      this.bytes = Math.max(0, this.bytes - oldest[1].bytes);
      this.evicted += 1;
    }
    if (!this.entries.has(key)) {
      this.dropped += 1;
      return { status: 'evicted', reason: 'session membership evicted at capacity' };
    }
    return { status: 'inserted', membership: structuredClone(membership) };
  }

  appendMany(inputs: readonly (SessionMembership | unknown)[]): SessionMembershipStoreResult[] {
    const bounded = inputs.slice(0, this.maxEntries);
    const results = bounded.map((input) => this.append(input));
    const overflow = inputs.length - bounded.length;
    if (overflow > 0) {
      this.dropped = Math.min(Number.MAX_SAFE_INTEGER, this.dropped + overflow);
      results.push(...Array.from({ length: overflow }, () => ({
        status: 'rejected' as const,
        reason: 'session membership batch exceeds max_entries',
      })));
    }
    return results;
  }

  get(membershipId: string, resolutionRevision?: number): SessionMembership | undefined {
    this.purge();
    const entry = resolutionRevision === undefined
      ? [...this.entries.values()]
          .filter((entry) => entry.membership.membershipId === membershipId)
          .sort((left, right) => right.membership.resolutionRevision - left.membership.resolutionRevision)[0]
        : this.entries.get(`${membershipId}\0${resolutionRevision}`);
    return entry?.membership ? structuredClone(entry.membership) : undefined;
  }

  list(limit = this.maxEntries): SessionMembership[] {
    this.purge();
    const requested = Number(limit);
    const bounded = Number.isFinite(requested) ? Math.max(1, Math.min(this.maxEntries, Math.trunc(requested))) : this.maxEntries;
    return [...this.entries.values()].slice(-bounded).map((entry) => structuredClone(entry.membership));
  }

  stats(): SessionMembershipStoreStats {
    this.purge();
    return { entries: this.entries.size, bytes: this.bytes, maxEntries: this.maxEntries, maxBytes: this.maxBytes, ttlMs: this.ttlMs, evicted: this.evicted, expired: this.expired, dropped: this.dropped, duplicates: this.duplicates, conflicts: this.conflicts, closed: this.closed };
  }

  close(): void {
    this.closed = true;
    this.entries.clear();
    this.fingerprints.clear();
    this.bytes = 0;
  }
}

export function validateCanonicalContract(input: unknown): CanonicalValidationResult<unknown> {
  const schema = input && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>).schemaVersion
    : undefined;
  switch (schema) {
    case CANONICAL_SCHEMA_VERSIONS.rawObservation: return validateRawObservation(input);
    case CANONICAL_SCHEMA_VERSIONS.semanticRecord: return validateSemanticRecord(input);
    case CANONICAL_SCHEMA_VERSIONS.logicalAgentDefinition: return validateLogicalAgentDefinition(input);
    case CANONICAL_SCHEMA_VERSIONS.sessionMembership: return validateSessionMembership(input);
    case CANONICAL_SCHEMA_VERSIONS.agentInstance: return validateAgentInstance(input);
    case CANONICAL_SCHEMA_VERSIONS.runtimeInstance: return validateRuntimeInstance(input);
    case CANONICAL_SCHEMA_VERSIONS.connectionIdentity: return validateConnectionIdentity(input);
    case CANONICAL_SCHEMA_VERSIONS.evidenceLink: return validateEvidenceLink(input);
    case CANONICAL_SCHEMA_VERSIONS.coverageGap: return validateCoverageGap(input);
    case CANONICAL_SCHEMA_VERSIONS.kernelFact: return validateKernelFact(input);
    case CANONICAL_SCHEMA_VERSIONS.relationRevision: return validateRelationRevision(input);
    default: return { ok: false, reason: 'unsupported canonical schemaVersion' };
  }
}

/** Build a hash-only RawObservation from an Observer NDJSON line. */
export function rawObservationFromLine(
  line: string,
  context: {
    observationId?: string;
    revision?: number;
    eventAtUnixNs?: string;
    receivedAtUnixNs?: string;
    sourceId?: string;
    collectorId?: string;
    sourceType?: RawObservationSourceType | 'observer' | 'webhook' | 'custom';
    probeId?: string;
    sourceSequence?: string;
    /** Server-derived compatibility IDs; producer payloads must not populate this field. */
    sourceRefs?: readonly string[];
    /** Explicit spelling for callers that want to distinguish compatibility aliases. */
    compatibilitySourceRefs?: readonly string[];
    eventKind?: string;
    processGenerationKey?: string;
    pid?: number;
    ppid?: number;
    hostId?: string;
    bootId?: string;
    startTimeTicks?: string;
    startTimeNs?: string;
    idempotencyKey?: string;
  } = {},
): RawObservation {
  const body = typeof line === 'string' ? line : '';
  const digest = sha256(body);
  const nowNs = (BigInt(Date.now()) * 1_000_000n).toString();
  const observationId = context.observationId ?? stableId('ob', `${digest}\0${context.sourceSequence ?? ''}`);
  const eventAtUnixNs = context.eventAtUnixNs && UNIX_NS.test(context.eventAtUnixNs)
    ? context.eventAtUnixNs
    : nowNs;
  const receivedCandidate = context.receivedAtUnixNs && UNIX_NS.test(context.receivedAtUnixNs)
    ? context.receivedAtUnixNs
    : nowNs;
  const receivedAtUnixNs = (() => {
    try {
      return BigInt(receivedCandidate) >= BigInt(eventAtUnixNs)
        ? receivedCandidate
        : eventAtUnixNs;
    } catch {
      return eventAtUnixNs;
    }
  })();
  const processKey = text(context.processGenerationKey, 128);
  const processHostId = text(context.hostId, 240);
  const processBootId = text(context.bootId, 240);
  const processStartTimeTicks = text(context.startTimeTicks, 64);
  const processStartTimeNs = text(context.startTimeNs, 64);
  const completeProcessIdentity = Boolean(
    processKey && /^pgk_[a-f0-9]{24}$/u.test(processKey)
      && Number.isSafeInteger(context.pid) && Number(context.pid) > 0
      && processHostId
      && processBootId
      && (processStartTimeTicks || processStartTimeNs),
  );
  const completeProcessKey = completeProcessIdentity ? processKey! : undefined;
  const normalizedSourceType: RawObservationSourceType = context.sourceType === 'observer'
    ? 'kernel'
    : context.sourceType === 'kernel'
      ? 'kernel'
    : context.sourceType === 'forwarder'
      ? 'forwarder'
      : context.sourceType === 'otel'
        ? 'otel'
        : context.sourceType === 'uprobe'
          ? 'uprobe'
          : context.sourceType === 'socket_payload'
            ? 'socket_payload'
            : context.sourceType === 'api'
              ? 'api'
              : 'unknown';
  const acceptsServerRefs = ['kernel', 'uprobe', 'socket_payload', 'forwarder'].includes(normalizedSourceType);
  const observation: RawObservation = {
    schemaVersion: CANONICAL_SCHEMA_VERSIONS.rawObservation,
    observationId,
    revision: Math.max(1, Math.trunc(context.revision ?? 1)),
    eventAtUnixNs,
    receivedAtUnixNs,
    source: {
      ...(text(context.sourceId, 240) ? { sourceId: text(context.sourceId, 240) } : {}),
      ...(text(context.collectorId, 240) ? { collectorId: text(context.collectorId, 240) } : {}),
      sourceType: normalizedSourceType,
      ...(text(context.probeId, 240) ? { probeId: text(context.probeId, 240) } : {}),
      ...(text(context.sourceSequence, 120) ? { sourceSequence: text(context.sourceSequence, 120) } : {}),
    },
    ...(completeProcessIdentity ? {
      process: {
        processGenerationKey: completeProcessKey!,
        pid: Number(context.pid),
        ...(context.ppid !== undefined ? { ppid: Number(context.ppid) } : {}),
        hostId: processHostId!,
        bootId: processBootId!,
        ...(processStartTimeTicks ? { startTimeTicks: processStartTimeTicks } : {}),
        ...(processStartTimeNs ? { startTimeNs: processStartTimeNs } : {}),
        firstSeenAtUnixNs: eventAtUnixNs,
        sourceRefs: [observationId],
      },
    } : {}),
    payload: {
      kind: context.eventKind ?? 'observer_line',
      payloadRef: `sha256:${digest}`,
      sha256: digest,
      originalBytes: Buffer.byteLength(body, 'utf8'),
      capturedBytes: Buffer.byteLength(body, 'utf8'),
      redactionState: 'hash_only',
    },
    sourceRefs: mergeServerSourceRefs(
      observationId,
      acceptsServerRefs ? context.sourceRefs : undefined,
      acceptsServerRefs ? context.compatibilitySourceRefs : undefined,
    ),
    derivedFrom: [],
    idempotencyKey: context.idempotencyKey ?? `${context.sourceId ?? context.collectorId ?? 'local'}:${observationId}:${context.revision ?? 1}`,
  };
  return observation;
}

/**
 * A bounded in-memory raw fact store. It is deliberately metadata-first: callers must opt in to
 * putting a short-lived body in `payload.body`; normal Observer ingest stores only hash/ref/length.
 */
export class RawObservationStore {
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, { observation: RawObservation; bytes: number; insertedAt: number }>();
  private readonly idempotency = new Map<string, string>();
  private bytes = 0;
  private closed = false;
  private evicted = 0;
  private expired = 0;
  private dropped = 0;
  private duplicates = 0;
  private conflicts = 0;
  private orphaned = 0;

  constructor(options: RawObservationStoreOptions = {}) {
    this.maxEntries = Math.max(1, Math.min(1_000_000, Math.trunc(options.maxEntries ?? 10_000)));
    this.maxBytes = Math.max(1, Math.min(512 * 1024 * 1024, Math.trunc(options.maxBytes ?? 64 * 1024 * 1024)));
    this.ttlMs = Math.max(1, Math.min(30 * 24 * 60 * 60_000, Math.trunc(options.ttlMs ?? 15 * 60_000)));
    this.now = options.now ?? Date.now;
  }

  private key(observation: RawObservation): string {
    return `${observation.observationId}\0${observation.revision}`;
  }

  private idempotencyKey(observation: RawObservation): string {
    // A producer may legitimately emit a late correction as a new observation revision.  Scope
    // the retry fence to that revision, matching the PostgreSQL `(idempotency_key, revision)`
    // unique index; the observation/revision primary key still rejects a conflicting rewrite.
    return `${observation.idempotencyKey}\0${observation.revision}`;
  }

  private fingerprint(observation: RawObservation): string {
    return sha256(JSON.stringify(observation));
  }

  private purgeExpired(at = this.now()): void {
    for (const [key, entry] of this.entries) {
      if (at - entry.insertedAt <= this.ttlMs) break;
      this.entries.delete(key);
      this.bytes = Math.max(0, this.bytes - entry.bytes);
      const idempotencyKey = this.idempotencyKey(entry.observation);
      if (this.idempotency.get(idempotencyKey) === this.fingerprint(entry.observation)) {
        this.idempotency.delete(idempotencyKey);
      }
      this.expired += 1;
    }
  }

  append(input: RawObservation | unknown): RawObservationStoreResult {
    if (this.closed) return { status: 'rejected', reason: 'raw observation store is closed' };
    this.purgeExpired();
    // Preserve an explicit idempotency conflict even when the incoming payload itself is malformed
    // (for example a tampered digest).  A malformed first insert is rejected below; a malformed
    // replay of an existing key is a conflict, never a silent duplicate.
    if (input && typeof input === 'object' && !Array.isArray(input)) {
      const candidate = input as Record<string, unknown>;
      const candidateId = text(candidate.observationId, 240);
      const candidateRevision = positiveInteger(candidate.revision, 1_000_000);
      const existingKey = candidateId && candidateRevision !== undefined
        ? `${candidateId}\0${candidateRevision}`
        : undefined;
      if (existingKey && this.entries.has(existingKey)) {
        const existing = this.entries.get(existingKey)!;
        const checkedCandidate = validateRawObservation(input);
        if (!checkedCandidate.ok || this.fingerprint(existing.observation) !== this.fingerprint(checkedCandidate.value)) {
          this.conflicts += 1;
          return { status: 'conflict', reason: 'observation id/revision is already bound to another payload' };
        }
      }
    }
    const validation = validateRawObservation(input);
    if (!validation.ok) {
      this.dropped += 1;
      return { status: 'rejected', reason: validation.reason };
    }
    const observation = structuredClone(validation.value);
    const key = this.key(observation);
    const idempotencyKey = this.idempotencyKey(observation);
    const idempotencyFingerprint = this.idempotency.get(idempotencyKey);
    const incomingFingerprint = this.fingerprint(observation);
    if (idempotencyFingerprint && idempotencyFingerprint !== incomingFingerprint) {
      this.conflicts += 1;
      return { status: 'conflict', reason: 'idempotency key is already bound to another payload' };
    }
    const existing = this.entries.get(key);
    if (existing) {
      if (this.fingerprint(existing.observation) === incomingFingerprint) {
        this.duplicates += 1;
        return { status: 'duplicate', observation: structuredClone(existing.observation) };
      }
      this.conflicts += 1;
      return { status: 'conflict', reason: 'observation id/revision is already bound to another payload' };
    }
    const bytes = jsonBytes(observation);
    if (!Number.isSafeInteger(bytes) || bytes > this.maxBytes) {
      this.dropped += 1;
      return { status: 'rejected', reason: 'raw observation exceeds max_bytes' };
    }
    this.entries.set(key, { observation, bytes, insertedAt: this.now() });
    this.idempotency.set(idempotencyKey, incomingFingerprint);
    this.bytes += bytes;
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.entries.entries().next().value as
        | [string, { observation: RawObservation; bytes: number; insertedAt: number }]
        | undefined;
      if (!oldest) break;
      this.entries.delete(oldest[0]);
      this.bytes = Math.max(0, this.bytes - oldest[1].bytes);
      const idempotencyKey = this.idempotencyKey(oldest[1].observation);
      if (this.idempotency.get(idempotencyKey) === this.fingerprint(oldest[1].observation)) {
        this.idempotency.delete(idempotencyKey);
      }
      this.evicted += 1;
    }
    if (!this.entries.has(key)) {
      this.dropped += 1;
      return { status: 'evicted', reason: 'raw observation evicted at capacity' };
    }
    return { status: 'inserted', observation: structuredClone(observation) };
  }

  appendMany(inputs: readonly (RawObservation | unknown)[]): RawObservationStoreResult[] {
    const bounded = inputs.slice(0, this.maxEntries);
    const results = bounded.map((input) => this.append(input));
    const overflow = inputs.length - bounded.length;
    if (overflow > 0) {
      this.dropped = Math.min(Number.MAX_SAFE_INTEGER, this.dropped + overflow);
      results.push(...Array.from({ length: overflow }, () => ({
        status: 'rejected' as const,
        reason: 'raw observation batch exceeds max_entries',
      })));
    }
    return results;
  }

  put(input: RawObservation | unknown): RawObservationStoreResult {
    return this.append(input);
  }

  commit(input: RawObservation | unknown): RawObservationStoreResult {
    return this.append(input);
  }

  get(observationId: string, revision?: number): RawObservation | undefined {
    this.purgeExpired();
    const candidate = revision === undefined
      ? [...this.entries.values()]
          .filter((item) => item.observation.observationId === observationId)
          .sort((left, right) => right.observation.revision - left.observation.revision)[0]
      : undefined;
    const key = revision === undefined
      ? candidate ? this.key(candidate.observation) : undefined
      : `${observationId}\0${revision}`;
    const entry = key ? this.entries.get(key) : undefined;
    return entry ? structuredClone(entry.observation) : undefined;
  }

  list(limit = this.maxEntries): RawObservation[] {
    this.purgeExpired();
    const requested = Number(limit);
    const bounded = Number.isFinite(requested)
      ? Math.max(1, Math.min(this.maxEntries, Math.trunc(requested)))
      : this.maxEntries;
    return [...this.entries.values()].slice(-bounded).map((entry) => structuredClone(entry.observation));
  }

  remove(observationId: string, revision?: number): boolean {
    this.purgeExpired();
    const keys = revision === undefined
      ? [...this.entries.keys()].filter((item) => item.startsWith(`${observationId}\0`))
      : [`${observationId}\0${revision}`];
    let removed = false;
    for (const key of keys) {
      const entry = this.entries.get(key);
      if (!entry) continue;
      this.entries.delete(key);
      this.bytes = Math.max(0, this.bytes - entry.bytes);
      const idempotencyKey = this.idempotencyKey(entry.observation);
      if (this.idempotency.get(idempotencyKey) === this.fingerprint(entry.observation)) {
        this.idempotency.delete(idempotencyKey);
      }
      removed = true;
    }
    return removed;
  }

  markOrphan(count = 1): void {
    this.orphaned += Math.max(0, Math.trunc(count));
  }

  has(observationId: string, revision?: number): boolean {
    return this.get(observationId, revision) !== undefined;
  }

  size(): number {
    this.purgeExpired();
    return this.entries.size;
  }

  stats(): RawObservationStoreStats {
    this.purgeExpired();
    return {
      entries: this.entries.size,
      bytes: this.bytes,
      maxEntries: this.maxEntries,
      maxBytes: this.maxBytes,
      ttlMs: this.ttlMs,
      evicted: this.evicted,
      expired: this.expired,
      dropped: this.dropped,
      duplicates: this.duplicates,
      conflicts: this.conflicts,
      orphaned: this.orphaned,
      closed: this.closed,
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.entries.clear();
    this.idempotency.clear();
    this.bytes = 0;
  }
}

// Naming aliases kept intentionally small so callers can migrate from the design terminology
// (`CanonicalRawObservationStore`) without creating a second implementation or storage lane.
export { RawObservationStore as CanonicalRawObservationStore };

export interface LogicalAgentResolutionInput {
  logicalAgentId?: string;
  family?: string;
  product?: string;
  tenantId?: string;
  ownerId?: string;
  workspacePath?: string;
  repositoryId?: string;
  profile?: string;
  profileVersion?: string;
  deploymentId?: string;
  deploymentRevision?: string;
  /** Deployment/environment is an instance fence; it is not folded into the logical definition key. */
  environmentId?: string;
  definitionId?: string;
  definitionType?: LogicalAgentDefinition['definitionType'];
  logicalScopeMode?: LogicalScopeMode;
  terminalContextId?: string;
  sourceRefs?: string[];
  /** Authority for an explicit logicalAgentId; inferred IDs remain candidates/strong fingerprints. */
  authority?: 'management_registration' | 'authenticated_adapter' | 'inferred' | 'unknown';
}

export interface LogicalAgentResolution {
  definition: LogicalAgentDefinition;
  stable: boolean;
  logicalScopeKey: string;
  candidateId?: string;
  reason: 'explicit_registration' | 'definition_fingerprint' | 'insufficient_definition';
}

/** Resolve stable definition identity; terminal context is deliberately excluded by default. */
export function resolveLogicalAgentDefinition(input: LogicalAgentResolutionInput): LogicalAgentResolution {
  const family = text(input.family ?? input.product, 160) ?? 'unknown';
  const tenantId = text(input.tenantId, 240);
  const ownerId = text(input.ownerId, 240);
  const workspacePath = text(input.workspacePath, 1_024);
  const profile = text(input.profile, 240);
  const profileVersion = text(input.profileVersion, 120);
  const terminalContextId = text(input.terminalContextId, 240);
  const inferredMode: LogicalScopeMode = input.definitionType === 'workflow'
    ? 'workflow_definition'
    : input.definitionType === 'service' || input.definitionType === 'graph'
      ? 'service_definition'
      : 'registered_definition';
  const requestedMode = input.logicalScopeMode ?? inferredMode;
  const invalidTerminalScope = requestedMode === 'terminal' && !terminalContextId;
  const mode: LogicalScopeMode = requestedMode === 'terminal' && !terminalContextId
    ? 'unresolved'
    : requestedMode;
  const providedSourceRefs = [...new Set((input.sourceRefs ?? []).map((ref) => text(ref, 512)).filter((ref): ref is string => Boolean(ref)))].slice(0, 128);
  const explicit = text(input.logicalAgentId, 240);
  const explicitDefinitionType = input.definitionType;
  const explicitAuthority = input.authority ?? 'inferred';
  const explicitStable = Boolean(
    explicit
      && (explicitAuthority === 'management_registration' || explicitAuthority === 'authenticated_adapter')
      && !invalidTerminalScope
      && mode !== 'unresolved'
      && explicitDefinitionType !== 'candidate',
  );
  if (explicitStable) {
    const explicitId = explicit!;
    const explicitDefinitionId = text(input.definitionId, 240);
    const scopeFingerprint = sha256([
      family,
      tenantId,
      ownerId,
      workspacePath,
      text(input.repositoryId, 240),
      profile,
      profileVersion,
      explicitDefinitionId,
      input.definitionType,
      mode,
      mode === 'terminal' ? terminalContextId : '',
      explicitId,
    ].map((value) => value ?? '').join('\0'));
    const scopedLogicalAgentId = mode === 'terminal' && terminalContextId
      ? `la_${sha256(`terminal\0${scopeFingerprint}\0${terminalContextId}`).slice(0, 24)}`
      : explicitId;
    const logicalScopeKey = `las_${scopeFingerprint.slice(0, 24)}`;
    const definition: LogicalAgentDefinition = {
      schemaVersion: CANONICAL_SCHEMA_VERSIONS.logicalAgentDefinition,
      logicalAgentId: scopedLogicalAgentId,
      family,
      ...(tenantId ? { tenantId } : {}),
      ...(ownerId ? { ownerId } : {}),
      ...(workspacePath ? { workspacePath } : {}),
      ...(text(input.repositoryId, 240) ? { repositoryId: text(input.repositoryId, 240) } : {}),
      ...(profile ? { profile } : {}),
      ...(profileVersion ? { profileVersion } : {}),
      ...(text(input.deploymentId, 240) ? { deploymentId: text(input.deploymentId, 240) } : {}),
      ...(text(input.deploymentRevision, 120) ? { deploymentRevision: text(input.deploymentRevision, 120) } : {}),
      ...(text(input.environmentId, 240) ? { environmentId: text(input.environmentId, 240) } : {}),
      ...(explicitDefinitionId ? { definitionId: explicitDefinitionId } : {}),
      definitionType: input.definitionType ?? 'registered',
      logicalScopeMode: mode,
      definitionFingerprint: scopeFingerprint,
      identityQuality: explicitAuthority === 'management_registration' ? 'confirmed' : 'strong',
      logicalIdentityAuthority: explicitAuthority,
      ...(terminalContextId ? { terminalContextId } : {}),
      // A resolver may be called before a concrete ingest event/registration row is available
      // (for example while constructing a directory entry). Keep the definition auditable with a
      // deterministic, non-secret *derived* provenance marker.  The `derived:` prefix explicitly
      // distinguishes this marker from an observation or management-record evidence reference;
      // an ingest/registration caller should always pass its concrete sourceRefs when available.
      sourceRefs: providedSourceRefs.length > 0
        ? providedSourceRefs
        : [`derived:logical-definition:${scopeFingerprint}`],
    };
    return {
      definition,
      stable: true,
      logicalScopeKey,
      reason: 'explicit_registration',
    };
  }

  // A definition fingerprint requires a tenant/owner plus a product and either a registered
  // definition ID or a workspace/repository+profile tuple.  Workflow/service definitions often
  // have no profile field, so `definitionId + tenant/type` is sufficient and remains stable.
  const definitionId = text(input.definitionId, 240);
  const definitionType = input.definitionType;
  const enough = !invalidTerminalScope && mode !== 'unresolved' && definitionType !== 'candidate' && Boolean(
    (tenantId || ownerId)
    && family
    && ((definitionId && definitionType) || ((workspacePath || input.repositoryId) && profile)),
  );
  const fingerprintInput = [tenantId, ownerId, family, workspacePath, input.repositoryId, profile, profileVersion, definitionId, definitionType]
    .map((value) => value ?? '').join('\0');
  const fingerprint = sha256(`definition\0${fingerprintInput}`);
  const candidateId = `lac_${fingerprint.slice(0, 24)}`;
  const baseLogicalAgentId = enough ? `la_${fingerprint.slice(0, 24)}` : undefined;
  const logicalAgentId = baseLogicalAgentId && mode === 'terminal' && terminalContextId
    ? `la_${sha256(`terminal\0${baseLogicalAgentId}\0${terminalContextId}`).slice(0, 24)}`
    : baseLogicalAgentId;
  const definition: LogicalAgentDefinition = {
    schemaVersion: CANONICAL_SCHEMA_VERSIONS.logicalAgentDefinition,
    ...(logicalAgentId ? { logicalAgentId } : {}),
    family,
    ...(tenantId ? { tenantId } : {}),
    ...(ownerId ? { ownerId } : {}),
    ...(workspacePath ? { workspacePath } : {}),
    ...(text(input.repositoryId, 240) ? { repositoryId: text(input.repositoryId, 240) } : {}),
    ...(profile ? { profile } : {}),
    ...(profileVersion ? { profileVersion } : {}),
    ...(text(input.deploymentId, 240) ? { deploymentId: text(input.deploymentId, 240) } : {}),
    ...(text(input.deploymentRevision, 120) ? { deploymentRevision: text(input.deploymentRevision, 120) } : {}),
    ...(text(input.environmentId, 240) ? { environmentId: text(input.environmentId, 240) } : {}),
    ...(definitionId ? { definitionId } : {}),
    definitionType: enough ? (definitionType ?? 'registered') : 'candidate',
    logicalScopeMode: enough ? mode : 'unresolved',
    definitionFingerprint: fingerprint,
    identityQuality: enough ? 'strong' : 'unresolved',
    logicalIdentityAuthority: enough ? 'inferred' : 'unknown',
    ...(terminalContextId ? { terminalContextId } : {}),
    sourceRefs: providedSourceRefs.length > 0
      ? providedSourceRefs
      : [`derived:logical-definition:${fingerprint}`],
  };
  const base = enough ? logicalAgentId! : `candidate:${candidateId}`;
  return {
    definition,
    stable: enough,
    logicalScopeKey: base,
    ...(enough ? {} : { candidateId }),
    reason: enough ? 'definition_fingerprint' : 'insufficient_definition',
  };
}

export interface SessionResolutionInput {
  sessionId?: string;
  providerSessionId?: string;
  conversationId?: string;
  threadId?: string;
  runtimeSessionId?: string;
  serviceStateful?: boolean;
  requestId?: string;
  interactionId?: string;
  agentInstanceId?: string;
  resume?: boolean;
  fork?: boolean;
  parentSessionId?: string;
  scopeKey?: string;
  /** Namespace material used only for unscoped opaque IDs; never returned verbatim. */
  namespaceHint?: string;
}

export interface SessionResolution {
  sessionId: string;
  /** Opaque canonical ID safe for the canonical SessionMembership lane. */
  canonicalSessionId: string;
  /** Opaque parent ID for a fork, derived in the same logical namespace. */
  canonicalParentSessionId?: string;
  canonicalSessionKey?: string;
  providerSessionIdHash?: string;
  providerSessionId?: string;
  quality: IdentityQuality;
  source: 'provider' | 'runtime' | 'ephemeral' | 'none';
  mode: 'resumable' | 'conversation' | 'per_request' | 'ephemeral' | 'unknown';
  parentSessionId?: string;
  lifecycle: 'new' | 'resume' | 'fork';
  reason: 'explicit_provider_id' | 'explicit_session_id' | 'fork_without_parent'
    | 'fork_without_child_id' | 'per_request_default' | 'unresolved';
}

function looksLikeRuntimeSession(value: string): boolean {
  // These shapes are emitted by common container/PID runtimes rather than application session
  // contracts.  Only downgrade them when no explicit provider/conversation/thread field exists;
  // a provider ID is authoritative even if it happens to use a numeric representation.
  const generic = new Set(['', '-', 'none', 'null', 'unknown', 'legacy', 'default', 'main', 'mainthread', 'runtime']);
  return generic.has(value.trim().toLowerCase())
    || /^(?:pid[:_-]|pod[-_:]|container[-_:]|runtime[-_:])\S+$/iu.test(value)
    || /^\d{1,20}$/u.test(value);
}

function providerSessionUsable(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  // Numeric provider IDs can be legitimate; only reject placeholders and values that clearly
  // identify a runtime/container.  Numeric-only legacy `sessionId` values are handled by
  // looksLikeRuntimeSession when no provider field is present.
  return !new Set(['', '-', 'none', 'null', 'unknown', 'legacy', 'default', 'main', 'mainthread', 'runtime']).has(normalized)
    && !/^(?:pid[:_-]|pod[-_:]|container[-_:]|runtime[-_:])\S+$/iu.test(value);
}

function namespacedSessionKey(providerOrSession: string, scopeKey?: string): string {
  const digest = createHmac('sha256', SESSION_HASH_SECRET)
    .update(`canonical\0${scopeKey ?? 'unresolved'}\0${providerOrSession}`)
    .digest('hex')
    .slice(0, 24);
  return `sess_${digest}`;
}

function namespacedSessionDigest(providerOrSession: string, scopeKey?: string): string {
  return createHmac('sha256', SESSION_HASH_SECRET)
    .update(`provider\0${scopeKey ?? 'unresolved'}\0${providerOrSession}`)
    .digest('hex');
}

/** Derive an opaque, process-stable Session ID without exposing a native provider identifier. */
export function canonicalSessionIdForMembership(value: string, scopeKey?: string, uniqueHint?: string): string {
  const normalized = text(value, 512);
  if (!normalized) return stableId('sess', 'missing-session');
  // Never treat an opaque-looking producer value as canonical. A provider can deliberately send a
  // `sess_<24hex>` string that collides with a server-generated ID. Callers that already hold a
  // server-produced canonical field must preserve it explicitly (the `canonicalSessionId` field
  // branches in the resolvers); this function is only for native/provider/legacy input.
  // Namespace hints are often assembled from multiple fields with NUL separators. They are
  // internal material, not user-facing text, so hash a bounded raw string instead of routing it
  // through `text()` (which correctly rejects control characters for persisted fields). This keeps
  // an unscoped provider Session deterministic within a stable source/workspace namespace while
  // still avoiding disclosure of the hint itself. If no hint exists, retain the process-ephemeral
  // fallback so an arbitrary native ID cannot become a cross-tenant join key.
  const rawHint = typeof uniqueHint === 'string' && uniqueHint.length > 0 && uniqueHint.length <= 4_096
    ? uniqueHint : undefined;
  const namespace = scopeKey ?? `unresolved:${rawHint ? sha256(rawHint).slice(0, 64) : randomBytes(12).toString('hex')}`;
  return `sess_${createHmac('sha256', SESSION_HASH_SECRET)
    .update(`membership\0${namespace}\0${normalized}`)
    .digest('hex')
    .slice(0, 24)}`;
}

/** Return a canonical Session ID only when it came from a previously validated server field. */
export function trustedCanonicalSessionId(value: unknown): string | undefined {
  const normalized = text(value, 512);
  return normalized && /^sess_[a-f0-9]{24}$/u.test(normalized) ? normalized : undefined;
}

/**
 * Resolve a fork parent for a compatibility projection without manufacturing a different parent
 * for every event. A raw/native parent is only safe to hash when the caller has a stable namespace;
 * even an opaque-looking `sess_...` value is treated as producer data until that namespace is
 * present. When neither is available we leave the edge unresolved; the caller can retain the
 * native parent in its compatibility record and emit a coverage gap instead of presenting an
 * unstable lineage as fact.
 */
export function canonicalParentSessionIdForMembership(
  value: string | undefined,
  scopeKey?: string,
  namespaceHint?: string,
): string | undefined {
  const normalized = text(value, 512);
  if (!normalized) return undefined;
  // Even an opaque-looking parent is producer data here. Preserve a previously validated
  // canonical parent at the call site via `trustedCanonicalSessionId`; never infer trust from its
  // textual shape.
  // A caller may provide a bounded, non-persisted namespace hint when the management scope has
  // not yet been materialized.  It is still a stable namespace (unlike an interaction/event ID),
  // so it is safe to derive the same opaque parent across events.  Without either form of
  // namespace, leave the parent unresolved instead of manufacturing a different lineage edge per
  // event.
  if (!text(scopeKey, 1_024)
    && !(typeof namespaceHint === 'string' && namespaceHint.length > 0 && namespaceHint.length <= 4_096)) {
    return undefined;
  }
  return canonicalSessionIdForMembership(
    normalized,
    scopeKey,
    scopeKey ? undefined : namespaceHint,
  );
}

/** Resolve session identity without promoting a runtime/container ID to provider identity. */
let ephemeralSequence = 0;
export function resolveSessionIdentity(input: SessionResolutionInput): SessionResolution {
  const providerCandidate = text(input.providerSessionId ?? input.conversationId ?? input.threadId, 512);
  const hasScope = Boolean(text(input.scopeKey, 1_024));
  const stableNamespaceHint = !hasScope
    && typeof input.namespaceHint === 'string'
    && input.namespaceHint.length > 0
    && input.namespaceHint.length <= 4_096
    ? input.namespaceHint
    : undefined;
  const hasStableNamespace = hasScope || Boolean(stableNamespaceHint);
  const eventHint = text(input.interactionId ?? input.requestId, 512);
  // An explicitly supplied provider ID is retained as compatibility metadata even when its
  // tenant/definition namespace is unavailable.  In that case the canonical Session must be
  // event-scoped (or random when the producer supplied no event key), and its quality is
  // ephemeral; otherwise two unrelated tenants using the same native ID would look like one
  // durable Session.  A management scope or a bounded namespace hint restores cross-event
  // stability.
  const canonicalNamespace = input.scopeKey ?? stableNamespaceHint;
  const canonicalUniqueHint = hasStableNamespace ? undefined : eventHint;
  const providerHashScope = input.scopeKey
    ?? (stableNamespaceHint ? `hint_${sha256(stableNamespaceHint)}` : undefined);
  const provider = providerCandidate && providerSessionUsable(providerCandidate)
    ? providerCandidate : undefined;
  const suppliedSession = text(input.sessionId, 512);
  const runtimeSession = text(input.runtimeSessionId, 512);
  // Runtime/container IDs are useful correlation hints but are never provider Session IDs.  An
  // old producer sometimes copied that value into `sessionId`; reject the copy when both match.
  const runtimeOnly = Boolean(
    suppliedSession
      && !provider
      && ((runtimeSession && suppliedSession === runtimeSession)
        || looksLikeRuntimeSession(suppliedSession)),
  );
  // A caller that explicitly declares a stateless service is the authority for the boundary.  Do
  // not let a legacy `sessionId` fallback (or a provider-looking label copied into every POST)
  // turn otherwise independent requests into one inferred Conversation.  A stateful service may
  // still use `providerSessionId`/`sessionId` below; the universal ingest binder only sets this flag
  // false when no native conversation/thread continuity is available.
  // An explicit provider conversation/thread remains authoritative even when the surrounding
  // service is stateless by default.  `serviceStateful=false` suppresses only legacy/session
  // fallbacks; it must not discard a real provider anchor that enables a scoped resume.
  const explicit = provider
    ?? (input.serviceStateful === false ? undefined : (runtimeOnly ? undefined : suppliedSession));
  if (explicit) {
    const forked = input.fork === true;
    if (forked) {
      const parent = text(input.parentSessionId, 512);
      // When the product supplies a new native fork ID, preserve it as the Session identity. If
      // the only visible ID is the parent, derive a new opaque child and keep the parent edge.
      const forkId = provider && parent && provider !== parent
        ? provider
        : stableId('sess', `fork\0${explicit}\0${eventHint ?? randomBytes(12).toString('hex')}`);
      return {
        sessionId: forkId,
        canonicalSessionId: canonicalSessionIdForMembership(
          forkId,
          input.scopeKey,
          canonicalNamespace ? stableNamespaceHint : canonicalUniqueHint,
        ),
        ...(parent && hasStableNamespace
          ? {
              canonicalParentSessionId: canonicalParentSessionIdForMembership(
                parent,
                input.scopeKey,
                stableNamespaceHint,
              ),
            }
          : {}),
        ...(hasScope ? { canonicalSessionKey: namespacedSessionKey(forkId, input.scopeKey) } : {}),
        ...(provider ? { providerSessionIdHash: namespacedSessionDigest(provider, providerHashScope) } : {}),
        ...(provider ? { providerSessionId: provider } : {}),
        quality: hasStableNamespace ? (hasScope ? 'confirmed' : 'strong') : 'ephemeral',
        source: provider ? 'provider' : 'runtime',
        mode: hasStableNamespace ? 'resumable' : 'ephemeral',
        ...(parent ? { parentSessionId: parent } : {}),
        lifecycle: 'fork',
        reason: parent
          ? (provider ? 'explicit_provider_id' : 'explicit_session_id')
          : 'fork_without_parent',
      };
    }
    return {
      sessionId: explicit,
      canonicalSessionId: canonicalSessionIdForMembership(
        explicit,
        input.scopeKey,
        canonicalNamespace ? stableNamespaceHint : canonicalUniqueHint,
      ),
      ...(hasScope ? { canonicalSessionKey: namespacedSessionKey(explicit, input.scopeKey) } : {}),
      ...(provider ? { providerSessionIdHash: namespacedSessionDigest(provider, providerHashScope) } : {}),
      ...(provider ? { providerSessionId: provider } : {}),
      quality: provider
        ? (hasStableNamespace ? (hasScope ? 'confirmed' : 'strong') : 'ephemeral')
        : 'inferred',
      source: provider ? 'provider' : 'runtime',
      mode: provider ? (hasStableNamespace ? 'resumable' : 'ephemeral') : 'conversation',
      lifecycle: input.resume === true ? 'resume' : 'new',
      reason: provider ? 'explicit_provider_id' : 'explicit_session_id',
    };
  }
  const suppliedKey = [input.requestId, input.interactionId, input.agentInstanceId]
    .filter(Boolean).join('\0');
  const parent = text(input.parentSessionId, 512);
  if (input.fork === true) {
    const forkKey = [
      parent ?? '',
      suppliedKey || `${Date.now()}\0${ephemeralSequence += 1}`,
      input.scopeKey ?? stableNamespaceHint ?? '',
    ].join('\0');
    const forkId = stableId('sess', `fork\0${forkKey}`);
    return {
      sessionId: forkId,
      canonicalSessionId: canonicalSessionIdForMembership(
        forkId,
        input.scopeKey,
        stableNamespaceHint ?? suppliedKey,
      ),
      ...(parent && hasStableNamespace
        ? {
            canonicalParentSessionId: canonicalParentSessionIdForMembership(
              parent,
              input.scopeKey,
              stableNamespaceHint,
            ),
          }
        : {}),
      ...(hasScope ? { canonicalSessionKey: namespacedSessionKey(forkId, input.scopeKey) } : {}),
      quality: hasStableNamespace ? 'strong' : 'ephemeral',
      source: 'ephemeral',
      mode: hasStableNamespace ? 'resumable' : 'ephemeral',
      ...(parent ? { parentSessionId: parent } : {}),
      lifecycle: 'fork',
      reason: 'fork_without_child_id',
    };
  }
  const ephemeralKey = suppliedKey || `${Date.now()}\0${ephemeralSequence += 1}`;
  const sessionId = stableId('sess', `ephemeral\0${ephemeralKey || 'request'}`);
  return {
    sessionId,
    canonicalSessionId: sessionId,
    canonicalSessionKey: sessionId,
    quality: 'ephemeral',
    source: 'ephemeral',
    mode: input.serviceStateful === false || input.serviceStateful === true ? 'per_request' : 'ephemeral',
    lifecycle: 'new',
    reason: 'per_request_default',
  };
}

export function deriveProcessGenerationKey(input: ProcessGenerationKeyParts): ProcessGenerationKey | undefined {
  const pid = positiveInteger(input.pid, 4_194_304);
  const host = text(input.hostId, 240);
  const boot = text(input.bootId, 240);
  const start = text(input.startTimeNs ?? input.startTimeTicks, 240);
  if (pid === undefined || !host || !boot || !start) return undefined;
  return `pgk_${sha256([host, boot, String(pid), start].join('\0')).slice(0, 24)}`;
}

export interface AgentInstanceIdentityInput {
  logicalAgentId?: string;
  logicalDefinitionId?: string;
  logicalScopeMode?: LogicalScopeMode;
  deploymentId?: string;
  deploymentRevision?: string;
  environmentId?: string;
  profile?: string;
  profileVersion?: string;
  processGenerationKey?: string;
}

export interface AgentInstanceIdentityResolution {
  agentInstanceId?: string;
  instanceKind: AgentInstance['instanceKind'];
}

/**
 * Derive a functional AgentInstance only from a stable logical definition plus a deployment or
 * process generation.  Runtime/container IDs are deliberately not used as the functional key;
 * they belong in runtimeInstanceId and may fan out underneath one service/workflow deployment.
 */
export function deriveAgentInstanceIdentity(
  input: AgentInstanceIdentityInput,
): AgentInstanceIdentityResolution {
  const logical = text(input.logicalAgentId, 240) ?? text(input.logicalDefinitionId, 240);
  if (!logical) return { instanceKind: 'unknown' };
  const mode = input.logicalScopeMode;
  const deploymentParts = [
    text(input.deploymentId, 240),
    text(input.deploymentRevision, 120),
    text(input.environmentId, 240),
    text(input.profile, 240),
    text(input.profileVersion, 120),
  ];
  const hasDeployment = deploymentParts.some(Boolean);
  if (hasDeployment) {
    const instanceKind: AgentInstance['instanceKind'] = mode === 'workflow_definition'
      ? 'workflow_revision'
      : mode === 'service_definition' ? 'deployment_revision' : 'deployment_revision';
    return {
      agentInstanceId: stableId('ai', ['deployment', logical, ...deploymentParts.map((part) => part ?? '')].join('\0')),
      instanceKind,
    };
  }
  const processGenerationKey = text(input.processGenerationKey, 128);
  if (processGenerationKey) {
    return {
      agentInstanceId: stableId('ai', ['root_process_generation', logical, processGenerationKey].join('\0')),
      instanceKind: 'root_process_generation',
    };
  }
  return { instanceKind: 'unknown' };
}

export function deriveConnectionIdentity(input: {
  processGenerationKey?: string;
  socketCookie?: string;
  fd?: number;
  fdGeneration?: string;
  tlsContextId?: string;
  netnsId?: string;
  streamId?: string;
  direction?: string;
  sequence?: string;
  transport?: ConnectionTransport;
  sourceRefs?: string[];
}): ConnectionIdentity | undefined {
  const processGenerationKey = text(input.processGenerationKey, 128);
  if (!processGenerationKey) return undefined;
  const socketCookie = text(input.socketCookie, 240);
  const tlsContextId = text(input.tlsContextId, 240);
  const fdGeneration = text(input.fdGeneration, 240);
  const fd = input.fd !== undefined ? nonNegativeInteger(input.fd, 4_194_304) : undefined;
  const streamId = text(input.streamId, 240);
  const quality: ConnectionIdentityQuality = socketCookie
    ? 'exact'
    : tlsContextId || fdGeneration ? 'strong' : fd !== undefined ? 'weak' : 'unknown';
  const identity = [processGenerationKey, socketCookie, tlsContextId, fdGeneration, fd, input.transport ?? 'unknown', streamId, input.direction, input.sequence]
    .map((value) => value ?? '').join('\0');
  const connectionId = `conn_${sha256(identity).slice(0, 24)}`;
  return {
    schemaVersion: 'anysentry.connection_identity.v1',
    connectionId,
    processGenerationKey,
    ...(socketCookie ? { socketCookie } : {}),
    ...(fd !== undefined ? { fd } : {}),
    ...(fdGeneration ? { fdGeneration } : {}),
    ...(tlsContextId ? { tlsContextId } : {}),
    ...(text(input.netnsId, 240) ? { netnsId: text(input.netnsId, 240) } : {}),
    ...(streamId ? { streamId } : {}),
    transport: input.transport ?? 'unknown',
    quality,
    ...(text(input.direction, 80) ? { direction: text(input.direction, 80) } : {}),
    ...(text(input.sequence, 80) ? { sequence: text(input.sequence, 80) } : {}),
    sourceRefs: (() => {
      const refs = [...new Set((input.sourceRefs ?? [])
        .map((ref) => text(ref, 512))
        .filter((ref): ref is string => Boolean(ref)))].slice(0, 128);
      return refs.length > 0 ? refs : [`derived:connection-identity:${connectionId}`];
    })(),
  };
}

export function canonicalCoverageGap(input: Omit<CoverageGap, 'schemaVersion'>): CoverageGap {
  return { schemaVersion: CANONICAL_SCHEMA_VERSIONS.coverageGap, ...input };
}

export const validateRawObservationEnvelope = validateRawObservation;
export const canonicalLogicalAgentKey = (input: LogicalAgentResolutionInput): LogicalAgentResolution =>
  resolveLogicalAgentDefinition(input);
export const resolveSession = resolveSessionIdentity;

export interface EvidenceLinkInput {
  fromType: EvidenceLink['fromType'];
  fromId: string;
  toType: EvidenceLink['toType'];
  toId: string;
  relation: EvidenceLink['relation'];
  method: EvidenceLinkMethod;
  confidence?: number;
  authority?: EvidenceLink['authority'];
  evidenceRefs?: string[];
  algorithmVersion?: string;
  status?: EvidenceLinkStatus;
  validFromUnixNs: string;
  validToUnixNs?: string;
  resolutionRevision?: number;
}

/**
 * Create a versioned, auditable relation without allowing a weak temporal hint to masquerade as
 * a confirmed execution.  Callers can retain competing candidates by creating one link per
 * candidate with `status=ambiguous`; this helper never chooses an owner implicitly.
 */
export function createEvidenceLink(input: EvidenceLinkInput): EvidenceLink {
  const fromId = text(input.fromId, 512) ?? 'unknown';
  const toId = text(input.toId, 512) ?? 'unknown';
  const validFrom = unixNs(input.validFromUnixNs) ?? '1000000000';
  const validTo = input.validToUnixNs === undefined ? undefined : unixNs(input.validToUnixNs);
  const requestedRefs = [...new Set((input.evidenceRefs ?? [])
    .map((ref) => text(ref, 512))
    .filter((ref): ref is string => Boolean(ref)))].slice(0, 128);
  // An edge without a source reference cannot be audited. Preserve it as an explicit
  // no-evidence/coverage relation rather than silently presenting an inferred owner.
  const refs = requestedRefs.length > 0 ? requestedRefs : ['no_evidence'];
  const noEvidence = requestedRefs.length === 0;
  const confidence = noEvidence || input.status === 'ambiguous' || input.status === 'unmatched' || input.status === 'coverage_gap'
    ? 0
    : Math.max(0, Math.min(1, Number.isFinite(input.confidence) ? Number(input.confidence) : 0));
  let status: EvidenceLinkStatus = input.status ?? (
    confidence >= 0.99 ? 'confirmed' : confidence >= 0.75 ? 'strong' : 'inferred'
  );
  if (noEvidence && !['ambiguous', 'unmatched', 'coverage_gap'].includes(status)) {
    status = 'coverage_gap';
  }
  if ((input.method === 'temporal' || input.method === 'none') && status === 'confirmed') {
    status = confidence >= 0.75 ? 'strong' : 'inferred';
  }
  const algorithmVersion = text(input.algorithmVersion, 120) ?? 'canonical-correlation.v1';
  const revision = positiveInteger(input.resolutionRevision ?? 1, Number.MAX_SAFE_INTEGER) ?? 1;
  // `linkId` identifies the logical edge. Resolution revisions are stored as a separate version
  // dimension so a late correlation update can supersede the edge without changing every deep-link
  // URL or making a read computed at a newer revision miss an ingest-time link.
  const identity = [input.fromType, fromId, input.toType, toId, input.relation,
    input.method, validFrom].join('\0');
  return {
    schemaVersion: CANONICAL_SCHEMA_VERSIONS.evidenceLink,
    linkId: stableId('el', identity),
    fromType: input.fromType,
    fromId,
    toType: input.toType,
    toId,
    relation: input.relation,
    method: input.method,
    confidence,
    authority: input.authority ?? 'inferred',
    evidenceRefs: refs,
    algorithmVersion,
    status,
    validFromUnixNs: validFrom,
    ...(validTo ? { validToUnixNs: validTo } : {}),
    resolutionRevision: revision,
  };
}

/** Compatibility alias used by correlation adapters. */
export const evidenceLink = createEvidenceLink;

export function createRelationRevision(input: {
  relation: EvidenceLink;
  revision: number;
  supersedesRelationId?: string;
  decidedAtUnixNs: string;
  sourceRefs?: string[];
}): RelationRevision {
  const revision = positiveInteger(input.revision, Number.MAX_SAFE_INTEGER) ?? 1;
  const decidedAtUnixNs = unixNs(input.decidedAtUnixNs) ?? '1000000000';
  const relationId = stableId(
    'rr',
    `${input.relation.linkId}\0${revision}\0${decidedAtUnixNs}`,
  );
  const sourceRefs = [...new Set((input.sourceRefs?.length ? input.sourceRefs : input.relation.evidenceRefs)
    .map((ref) => text(ref, 512))
    .filter((ref): ref is string => Boolean(ref)))].slice(0, 128);
  return {
    schemaVersion: 'anysentry.relation_revision.v1',
    relationId,
    revision,
    relation: structuredClone(input.relation),
    ...(text(input.supersedesRelationId, 512)
      ? { supersedesRelationId: text(input.supersedesRelationId, 512) } : {}),
    decidedAtUnixNs,
    sourceRefs: sourceRefs.length > 0 ? sourceRefs : ['no_evidence'],
  };
}
