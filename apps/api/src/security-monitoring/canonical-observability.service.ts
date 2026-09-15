import { Injectable, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type * as T from './types';
import { RelationalBusinessStore } from './relational-business-store.service';
import {
  CANONICAL_SCHEMA_VERSIONS,
  RawObservationStore,
  KernelFactStore,
  SemanticRecordStore,
  EvidenceLinkStore,
  SessionMembershipStore,
  AgentAdapterRegistry,
  ContractRegistry,
  createDefaultAgentAdapterRegistry,
  DEFAULT_TRANSPORT_REGISTRY,
  DEFAULT_LLM_FORMAT_REGISTRY,
  DEFAULT_RUNTIME_REGISTRY,
  mergeServerSourceRefs,
  normalizeKernelFact,
  rawObservationFromLine,
  validateCoverageGap,
  validateEvidenceLink,
  validateKernelFact,
  validateRawObservation,
  validateSemanticRecord,
  validateSessionMembership,
  type CoverageGap,
  type KernelFact,
  type SemanticRecord,
  type EvidenceLink,
  type SessionMembership,
  type RawObservation,
  type RawObservationSourceType,
  type RawObservationStoreResult,
} from './canonical-observability';

/**
 * The smallest write seam for the canonical observation plane.
 *
 * The in-memory store is intentionally always present: it is the bounded hot fallback when
 * PostgreSQL/ClickHouse is unavailable. A durable implementation can be attached by the module
 * without giving the Controller or a parser direct database access.
 */
export interface CanonicalRawObservationSink {
  saveRawObservations(observations: readonly RawObservation[]): Promise<boolean>;
  loadRawObservations?(input?: {
    observationIds?: readonly string[];
    revision?: number;
    limit?: number;
  }): Promise<RawObservation[]>;
  saveKernelFacts?(facts: readonly KernelFact[]): Promise<boolean>;
  loadKernelFacts?(input?: {
    factIds?: readonly string[];
    /** Compatibility event IDs retained as aliases of the canonical factId. */
    eventIds?: readonly string[];
    /** Raw/source references retained as aliases of the canonical factId. */
    sourceRefs?: readonly string[];
    /** Derived source references accepted for late relation/replay lookups. */
    derivedFrom?: readonly string[];
    limit?: number;
  }): Promise<KernelFact[]>;
  saveSemanticRecords?(records: readonly SemanticRecord[]): Promise<boolean>;
  loadSemanticRecords?(input?: { semanticRecordIds?: readonly string[]; revision?: number; limit?: number }): Promise<SemanticRecord[]>;
  saveCoverageGaps?(gaps: readonly CoverageGap[]): Promise<boolean>;
  loadCoverageGaps?(input?: { limit?: number }): Promise<CoverageGap[]>;
  saveEvidenceLinks?(links: readonly EvidenceLink[]): Promise<boolean>;
  isEvidenceLinksReadAvailable?(): boolean;
  loadEvidenceLinks?(input?: {
    linkIds?: readonly string[];
    fromType?: EvidenceLink['fromType'];
    fromIds?: readonly string[];
    toType?: EvidenceLink['toType'];
    toIds?: readonly string[];
    evidenceRef?: string;
    resolutionRevision?: number;
    limit?: number;
  }): Promise<EvidenceLink[]>;
  saveSessionMemberships?(memberships: readonly SessionMembership[]): Promise<boolean>;
  loadSessionMemberships?(input?: { membershipIds?: readonly string[]; interactionIds?: readonly string[]; resolutionRevision?: number; limit?: number; strictRead?: boolean }): Promise<SessionMembership[]>;
}

export interface CanonicalEvidenceLinkReadResult {
  items: EvidenceLink[];
  source: 'canonical_store' | 'canonical_store+hot_delta' | 'memory_hot_ring';
  degraded: boolean;
  reasons: string[];
}

export interface CanonicalObservationCommitContext {
  observationId?: string;
  revision?: number;
  eventAtUnixNs?: string;
  receivedAtUnixNs?: string;
  sourceId?: string;
  collectorId?: string;
  sourceType?: RawObservationSourceType;
  probeId?: string;
  sourceSequence?: string;
  /** Server-derived compatibility IDs; never copied from an untrusted producer envelope. */
  sourceRefs?: readonly string[];
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
}

export interface CanonicalObservationCommitResult {
  result: RawObservationStoreResult;
  observation?: RawObservation;
  kernelFact?: KernelFact;
  durable: boolean;
  gap?: CoverageGap;
}

const DEFAULT_GAP_LIMIT = 20_000;
const DEFAULT_GAP_TTL_MS = 24 * 60 * 60_000;
const EVIDENCE_LINK_READ_TIMEOUT_MS = 1_000;

function boundedEnvInt(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed)
    ? Math.min(max, Math.max(min, Math.trunc(parsed)))
    : fallback;
}

function nowUnixNs(): string {
  return (BigInt(Date.now()) * 1_000_000n).toString();
}

function boundedText(value: unknown, max = 512): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max && !/[\u0000-\u001f\u007f]/u.test(trimmed)
    ? trimmed
    : undefined;
}

function canonicalValueJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalValueJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalValueJson(item)}`)
    .join(',')}}`;
}

function canonicalValueFingerprint(value: unknown): string {
  return createHash('sha256').update(canonicalValueJson(value)).digest('hex');
}

function gapId(stage: string, reason: string, scope: string): string {
  const input = `${stage}\u0000${reason}\u0000${scope}`;
  // A 32-bit hash has a material collision probability at the configured gap cardinality. Use the
  // same collision-resistant opaque ID strategy as RawObservation/KernelFact instead.
  return `gap_${createHash('sha256').update(input).digest('hex').slice(0, 24)}`;
}

function safeGapScope(value: unknown): string {
  const normalized = boundedText(value, 512) ?? 'unknown';
  // Never persist a URL/userinfo/query or a free-form producer string in the coverage index.
  if (/[?&#]|:\/\/|@/u.test(normalized)) {
    return `scope_${createHash('sha256').update(normalized).digest('hex').slice(0, 24)}`;
  }
  return normalized.replace(/[^A-Za-z0-9_.:/-]/gu, '_').slice(0, 240) || 'unknown';
}

function safeGapDetails(details: Record<string, string | number | boolean>): Record<string, string | number | boolean> {
  return Object.fromEntries(Object.entries(details).slice(0, 32).map(([key, value]) => {
    if (typeof value !== 'string') return [key.slice(0, 80), value];
    const safeKey = key.slice(0, 80);
    // Key-based redaction catches conventional fields, but producer-controlled values can hide
    // credentials under innocuous names such as `endpoint`, `peer`, or `target`.  Hash any value
    // that looks like a URL/query/userinfo as well, so coverage diagnostics never become a second
    // secret-bearing payload path.
    const valueLooksSensitive = /[?&#]|:\/\/|@/u.test(value);
    return (/(token|secret|password|cookie|authorization|url|prompt|body|header)/iu.test(key)
      || valueLooksSensitive)
      ? [safeKey, `hash:${createHash('sha256').update(value).digest('hex').slice(0, 24)}`]
      : [safeKey, value.replace(/[^A-Za-z0-9_.:/-]/gu, '_').slice(0, 240)];
  }));
}

function gapBytes(gap: CoverageGap): number {
  try {
    return Math.max(1, Buffer.byteLength(JSON.stringify(gap), 'utf8'));
  } catch {
    return 1_024;
  }
}

function cloneWithoutBody(observation: RawObservation): RawObservation {
  // Raw bodies belong to the separately authorised, short-TTL content path. The canonical fact
  // store keeps hash/ref/length even when an untrusted producer supplied an optional body field.
  const payload = { ...observation.payload };
  delete payload.body;
  if (payload.redactionState === 'none' || payload.redactionState === 'partial') {
    payload.redactionState = 'hash_only';
  }
  return { ...observation, payload };
}

/**
 * Durable sinks are migration boundaries and may contain rows written by an older binary or a
 * manually repaired database.  Never pass an unvalidated row to a canonical API consumer: apply
 * the same contract validator used on ingest, and keep the raw lane metadata-only on reads.
 */
function safeDurableRawObservation(value: unknown): RawObservation | undefined {
  const checked = validateRawObservation(value);
  return checked.ok ? cloneWithoutBody(checked.value) : undefined;
}

function safeDurableKernelFact(value: unknown): KernelFact | undefined {
  const checked = validateKernelFact(value);
  return checked.ok ? checked.value : undefined;
}

function safeDurableSemanticRecord(value: unknown): SemanticRecord | undefined {
  const checked = validateSemanticRecord(value);
  return checked.ok ? checked.value : undefined;
}

function safeDurableEvidenceLink(value: unknown): EvidenceLink | undefined {
  const checked = validateEvidenceLink(value);
  return checked.ok ? checked.value : undefined;
}

function safeDurableSessionMembership(value: unknown): SessionMembership | undefined {
  const checked = validateSessionMembership(value);
  return checked.ok ? checked.value : undefined;
}

function safeDurableCoverageGap(value: unknown): CoverageGap | undefined {
  const checked = validateCoverageGap(value);
  return checked.ok ? checked.value : undefined;
}

function observerEnvelopeCandidate(line: string): unknown {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    return parsed.rawObservation ?? parsed.raw_observation;
  } catch {
    return undefined;
  }
}

function observerEnvelopeGaps(line: string): Array<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const value = parsed.coverageGaps ?? parsed.coverage_gaps;
    return Array.isArray(value)
      ? value.filter((item): item is Record<string, unknown> =>
          Boolean(item && typeof item === 'object' && !Array.isArray(item)),
        ).slice(0, 64)
      : [];
  } catch {
    return [];
  }
}

function kernelFactKind(payloadKind: string): string {
  const kind = payloadKind.toLowerCase();
  if (kind.includes('exec') || kind.includes('fork')) return kind.includes('fork') ? 'fork' : 'exec';
  if (kind.includes('exit')) return 'exit';
  if (kind.includes('file')) return 'file';
  if (kind.includes('dns')) return 'dns';
  if (kind.includes('security') || kind.includes('sec')) return 'security';
  if (kind.includes('tls') || kind.includes('ssl')) return 'tls';
  if (kind.includes('connect') || kind.includes('egress') || kind.includes('network')) return 'network';
  if (kind.includes('process')) return 'process';
  return 'unknown';
}

/**
 * Bounded canonical raw-fact writer used by ingest. It never parses product JSON and never
 * replaces a judged event; it only commits provenance before downstream semantic work.
 */
@Injectable()
export class CanonicalObservabilityService implements OnModuleInit, OnModuleDestroy {
  readonly agentAdapters = createDefaultAgentAdapterRegistry();
  readonly transports = new ContractRegistry();
  readonly llmFormats = new ContractRegistry();
  readonly runtimes = new ContractRegistry();
  readonly raw = new RawObservationStore({
    maxEntries: boundedEnvInt('ANYSENTRY_RAW_OBSERVATION_MAX_ENTRIES', 20_000, 1, 1_000_000),
    maxBytes: boundedEnvInt('ANYSENTRY_RAW_OBSERVATION_MAX_BYTES', 64 * 1024 * 1024, 1_024, 512 * 1024 * 1024),
    ttlMs: boundedEnvInt('ANYSENTRY_RAW_OBSERVATION_TTL_MS', 15 * 60_000, 1_000, 30 * 24 * 60 * 60_000),
  });
  readonly kernel = new KernelFactStore({
    maxEntries: boundedEnvInt('ANYSENTRY_KERNEL_FACT_MAX_ENTRIES', 50_000, 1, 1_000_000),
    maxBytes: boundedEnvInt('ANYSENTRY_KERNEL_FACT_MAX_BYTES', 64 * 1024 * 1024, 1_024, 512 * 1024 * 1024),
    ttlMs: boundedEnvInt('ANYSENTRY_KERNEL_FACT_TTL_MS', 30 * 60_000, 1_000, 30 * 24 * 60 * 60_000),
  });
  readonly semantic = new SemanticRecordStore({
    maxEntries: boundedEnvInt('ANYSENTRY_SEMANTIC_RECORD_MAX_ENTRIES', 50_000, 1, 1_000_000),
    maxBytes: boundedEnvInt('ANYSENTRY_SEMANTIC_RECORD_MAX_BYTES', 64 * 1024 * 1024, 1_024, 512 * 1024 * 1024),
    ttlMs: boundedEnvInt('ANYSENTRY_SEMANTIC_RECORD_TTL_MS', 30 * 60_000, 1_000, 30 * 24 * 60 * 60_000),
  });
  readonly evidence = new EvidenceLinkStore({
    maxEntries: boundedEnvInt('ANYSENTRY_EVIDENCE_LINK_MAX_ENTRIES', 100_000, 1, 1_000_000),
    maxBytes: boundedEnvInt('ANYSENTRY_EVIDENCE_LINK_MAX_BYTES', 64 * 1024 * 1024, 1_024, 512 * 1024 * 1024),
    ttlMs: boundedEnvInt('ANYSENTRY_EVIDENCE_LINK_TTL_MS', 30 * 60_000, 1_000, 30 * 24 * 60 * 60_000),
  });
  readonly sessionMemberships = new SessionMembershipStore({
    maxEntries: boundedEnvInt('ANYSENTRY_SESSION_MEMBERSHIP_MAX_ENTRIES', 100_000, 1, 1_000_000),
    maxBytes: boundedEnvInt('ANYSENTRY_SESSION_MEMBERSHIP_MAX_BYTES', 64 * 1024 * 1024, 1_024, 512 * 1024 * 1024),
    ttlMs: boundedEnvInt('ANYSENTRY_SESSION_MEMBERSHIP_TTL_MS', 30 * 60_000, 1_000, 30 * 24 * 60 * 60_000),
  });

  private readonly gaps = new Map<string, { gap: CoverageGap; expiresAt: number }>();
  private readonly gapHistory = new Map<string, CoverageGap[]>();
  private readonly maxGaps = Math.max(1, Math.min(
    100_000,
    boundedEnvInt('ANYSENTRY_COVERAGE_GAP_MAX_ENTRIES', DEFAULT_GAP_LIMIT, 1, 100_000),
  ));
  private readonly gapTtlMs = Math.max(1_000, Math.min(
    30 * 24 * 60 * 60_000,
    boundedEnvInt('ANYSENTRY_COVERAGE_GAP_TTL_MS', DEFAULT_GAP_TTL_MS, 1_000, 30 * 24 * 60 * 60_000),
  ));
  private readonly gapMaxBytes = boundedEnvInt(
    'ANYSENTRY_COVERAGE_GAP_MAX_BYTES',
    64 * 1024 * 1024,
    4 * 1024,
    512 * 1024 * 1024,
  );
  private sink?: CanonicalRawObservationSink;
  private closed = false;
  private durableReadConflicts = 0;
  private gapBytes = 0;
  private gapHistoryBytes = 0;
  private gapEvicted = 0;
  private gapExpired = 0;
  private gapPersistenceInFlight = 0;
  private gapPersistenceDropped = 0;
  private readonly gapPersistenceMaxInFlight = 32;
  // Canonical raw/derived rows are a rebuildable side lane.  A slow relational store must not
  // hold the compatibility Observer ingest request (and therefore the Collector pipe) open for
  // its full database timeout.  The opt-in switch keeps direct/unit callers' historical
  // synchronous contract while formal deployments can use bounded eventual persistence.
  private readonly asyncPersistence = process.env.ANYSENTRY_CANONICAL_ASYNC_PERSIST === 'on';
  // The canonical lane is rebuildable evidence.  During Observer soak tests it can be disabled
  // explicitly so PostgreSQL latency cannot back up the primary ingest path.  The hot stores and
  // their CoverageGap counters remain active and are still available for later reconciliation.
  private readonly canonicalPersistenceEnabled = process.env.ANYSENTRY_CANONICAL_PERSIST !== 'off';
  private readonly asyncPersistenceMaxInFlight = boundedEnvInt(
    'ANYSENTRY_CANONICAL_ASYNC_PERSIST_MAX_INFLIGHT',
    8,
    1,
    64,
  );
  private asyncPersistenceInFlight = 0;
  private asyncPersistenceScheduled = 0;
  private asyncPersistenceCompleted = 0;
  private asyncPersistenceFailed = 0;
  private asyncPersistenceDropped = 0;
  private readonly asyncPersistenceTasks = new Set<Promise<void>>();
  private readonly asyncRawBatchMaxRows = boundedEnvInt(
    'ANYSENTRY_CANONICAL_ASYNC_RAW_BATCH_ROWS',
    128,
    1,
    512,
  );
  private readonly asyncRawBatchWindowMs = boundedEnvInt(
    'ANYSENTRY_CANONICAL_ASYNC_RAW_BATCH_WINDOW_MS',
    25,
    1,
    1_000,
  );
  private readonly asyncRawBatchMaxBytes = boundedEnvInt(
    'ANYSENTRY_CANONICAL_ASYNC_RAW_BATCH_MAX_BYTES',
    32 * 1024 * 1024,
    64 * 1024,
    256 * 1024 * 1024,
  );
  private asyncRawBatchQueue: Array<{ observation: RawObservation; onFailure: () => void }> = [];
  private asyncRawBatchQueueBytes = 0;
  private asyncRawBatchTimer?: ReturnType<typeof setTimeout>;
  private asyncKernelBatchQueue: Array<{ fact: KernelFact; onFailure: () => void }> = [];
  private asyncKernelBatchTimer?: ReturnType<typeof setTimeout>;

  constructor(@Optional() relationalStore?: RelationalBusinessStore) {
    for (const descriptor of DEFAULT_TRANSPORT_REGISTRY) this.transports.register(descriptor);
    for (const descriptor of DEFAULT_LLM_FORMAT_REGISTRY) this.llmFormats.register(descriptor);
    for (const descriptor of DEFAULT_RUNTIME_REGISTRY) this.runtimes.register(descriptor);
    // An unconfigured relational store is an intentional migration fallback, not a per-event
    // outage. Only attach it as a sink when a database URL was explicitly configured; otherwise
    // the bounded in-memory hot store is the expected source and no false storage gap is emitted.
    this.sink = relationalStore?.configured() ? relationalStore : undefined;
  }

  setSink(sink: CanonicalRawObservationSink | undefined): void {
    this.sink = sink;
  }

  /**
   * Persist one canonical side-lane batch without making the Observer request wait for a slow
   * database.  The operation is intentionally converted to a non-rejecting Promise before it is
   * placed in the bounded task set; a late sink failure becomes a metadata-only CoverageGap.
   * Returns `true` when a task was admitted (or when the synchronous write durably completed).
   * Synchronous mode is retained for compatibility; asynchronous callers must treat an admitted
   * task as pending rather than as an already durable read-model row.
   */
  private async writeCanonicalSideLane(
    operation: () => Promise<boolean>,
    onFailure: () => void,
  ): Promise<boolean> {
    if (!this.sink || this.closed) return false;
    const reportFailure = () => {
      if (this.closed) return;
      try { onFailure(); } catch { /* coverage is best effort */ }
    };
    if (!this.asyncPersistence) {
      try {
        const durable = await operation();
        if (!durable) reportFailure();
        return durable;
      } catch {
        reportFailure();
        return false;
      }
    }
    if (this.asyncPersistenceInFlight >= this.asyncPersistenceMaxInFlight) {
      this.asyncPersistenceDropped += 1;
      reportFailure();
      return false;
    }
    this.asyncPersistenceInFlight += 1;
    this.asyncPersistenceScheduled += 1;
    let task!: Promise<void>;
    task = Promise.resolve()
      .then(operation)
      .then((durable) => {
        if (durable) this.asyncPersistenceCompleted += 1;
        else {
          this.asyncPersistenceFailed += 1;
          reportFailure();
        }
      })
      .catch(() => {
        this.asyncPersistenceFailed += 1;
        reportFailure();
      })
      .finally(() => {
        this.asyncPersistenceInFlight = Math.max(0, this.asyncPersistenceInFlight - 1);
        this.asyncPersistenceTasks.delete(task);
      });
    this.asyncPersistenceTasks.add(task);
    return true;
  }

  /**
   * Coalesce raw observations before entering the relational side lane.  The raw hot store has
   * already accepted each immutable observation, so this queue only controls durable delivery;
   * failures remain explicit CoverageGaps and never become an implicit ACK.
   */
  private enqueueRawObservation(
    observation: RawObservation,
    onFailure: () => void,
  ): boolean {
    if (!this.sink || this.closed) return false;
    const capacity = this.asyncPersistenceMaxInFlight * this.asyncRawBatchMaxRows;
    const observationBytes = Buffer.byteLength(JSON.stringify(observation));
    if (this.asyncRawBatchQueue.length >= capacity
      || this.asyncRawBatchQueueBytes + observationBytes > this.asyncRawBatchMaxBytes) {
      this.asyncPersistenceDropped += 1;
      try { onFailure(); } catch { /* coverage is best effort */ }
      return false;
    }
    this.asyncRawBatchQueue.push({ observation, onFailure });
    this.asyncRawBatchQueueBytes += observationBytes;
    this.asyncPersistenceScheduled += 1;
    if (this.asyncRawBatchQueue.length >= this.asyncRawBatchMaxRows) {
      void this.flushRawObservationBatch();
    } else this.scheduleRawObservationFlush();
    return true;
  }

  private scheduleRawObservationFlush(): void {
    if (this.asyncRawBatchTimer || this.closed) return;
    this.asyncRawBatchTimer = setTimeout(() => {
      this.asyncRawBatchTimer = undefined;
      void this.flushRawObservationBatch();
    }, this.asyncRawBatchWindowMs);
    this.asyncRawBatchTimer.unref?.();
  }

  private async flushRawObservationBatch(): Promise<void> {
    if (this.asyncRawBatchQueue.length === 0 || this.closed) return;
    if (this.asyncPersistenceInFlight >= this.asyncPersistenceMaxInFlight) {
      // Derived writes share the task limit. Their completion does not flush this queue, so
      // retain a timer even when no new observation arrives after capacity becomes available.
      this.scheduleRawObservationFlush();
      return;
    }
    const batch = this.asyncRawBatchQueue.splice(0, this.asyncRawBatchMaxRows);
    this.asyncRawBatchQueueBytes = Math.max(
      0,
      this.asyncRawBatchQueueBytes - batch.reduce(
        (sum, item) => sum + Buffer.byteLength(JSON.stringify(item.observation)),
        0,
      ),
    );
    this.asyncPersistenceInFlight += 1;
    const task = Promise.resolve()
      .then(() => this.sink?.saveRawObservations?.(batch.map(({ observation }) => observation)) ?? false)
      .then((durable) => {
        if (durable) {
          this.asyncPersistenceCompleted += batch.length;
          return;
        }
        this.asyncPersistenceFailed += batch.length;
        for (const item of batch) {
          try { item.onFailure(); } catch { /* coverage is best effort */ }
        }
      })
      .catch(() => {
        this.asyncPersistenceFailed += batch.length;
        for (const item of batch) {
          try { item.onFailure(); } catch { /* coverage is best effort */ }
        }
      })
      .finally(() => {
        this.asyncPersistenceInFlight = Math.max(0, this.asyncPersistenceInFlight - 1);
        this.asyncPersistenceTasks.delete(task);
        if (this.asyncRawBatchQueue.length > 0) void this.flushRawObservationBatch();
      });
    this.asyncPersistenceTasks.add(task);
  }

  /** Batch derived KernelFacts as well as raw observations; one SQL round trip per bounded block. */
  private enqueueKernelFact(fact: KernelFact, onFailure: () => void): boolean {
    if (!this.sink || this.closed) return false;
    const capacity = this.asyncPersistenceMaxInFlight * this.asyncRawBatchMaxRows;
    if (this.asyncKernelBatchQueue.length >= capacity) {
      this.asyncPersistenceDropped += 1;
      try { onFailure(); } catch { /* coverage is best effort */ }
      return false;
    }
    this.asyncKernelBatchQueue.push({ fact, onFailure });
    this.asyncPersistenceScheduled += 1;
    if (this.asyncKernelBatchQueue.length >= this.asyncRawBatchMaxRows) void this.flushKernelFactBatch();
    else {
      if (!this.asyncKernelBatchTimer && !this.closed) {
        this.asyncKernelBatchTimer = setTimeout(() => {
          this.asyncKernelBatchTimer = undefined;
          void this.flushKernelFactBatch();
        }, this.asyncRawBatchWindowMs);
        this.asyncKernelBatchTimer.unref?.();
      }
    }
    return true;
  }

  private async flushKernelFactBatch(): Promise<void> {
    if (this.asyncKernelBatchQueue.length === 0 || this.closed) return;
    if (this.asyncPersistenceInFlight >= this.asyncPersistenceMaxInFlight) {
      if (!this.asyncKernelBatchTimer) {
        this.asyncKernelBatchTimer = setTimeout(() => {
          this.asyncKernelBatchTimer = undefined;
          void this.flushKernelFactBatch();
        }, this.asyncRawBatchWindowMs);
        this.asyncKernelBatchTimer.unref?.();
      }
      return;
    }
    const batch = this.asyncKernelBatchQueue.splice(0, this.asyncRawBatchMaxRows);
    this.asyncPersistenceInFlight += 1;
    const task = Promise.resolve()
      .then(() => this.sink?.saveKernelFacts?.(batch.map(({ fact }) => fact)) ?? false)
      .then((durable) => {
        if (durable) this.asyncPersistenceCompleted += batch.length;
        else {
          this.asyncPersistenceFailed += batch.length;
          for (const item of batch) { try { item.onFailure(); } catch { /* best effort */ } }
        }
      })
      .catch(() => {
        this.asyncPersistenceFailed += batch.length;
        for (const item of batch) { try { item.onFailure(); } catch { /* best effort */ } }
      })
      .finally(() => {
        this.asyncPersistenceInFlight = Math.max(0, this.asyncPersistenceInFlight - 1);
        this.asyncPersistenceTasks.delete(task);
        if (this.asyncKernelBatchQueue.length > 0) void this.flushKernelFactBatch();
      });
    this.asyncPersistenceTasks.add(task);
  }

  registryCatalog(): {
    agents: ReturnType<AgentAdapterRegistry['list']>;
    transports: ReturnType<ContractRegistry['list']>;
    llmFormats: ReturnType<ContractRegistry['list']>;
    runtimes: ReturnType<ContractRegistry['list']>;
  } {
    return {
      agents: this.agentAdapters.list(),
      transports: this.transports.list(),
      llmFormats: this.llmFormats.list(),
      runtimes: this.runtimes.list(),
    };
  }

  async onModuleInit(): Promise<void> {
    if (!this.sink?.loadCoverageGaps) return;
    const loaded = await this.sink.loadCoverageGaps({ limit: this.maxGaps }).catch(() => []);
    for (const candidate of loaded) {
      const gap = safeDurableCoverageGap(candidate);
      if (!gap) continue;
      const history = this.gapHistory.get(gap.gapId) ?? [];
      if (!history.some((item) => item.revision === gap.revision)) history.push(structuredClone(gap));
      history.sort((left, right) => left.revision - right.revision);
      const retainedHistory = history.slice(-32);
      this.gapHistory.set(gap.gapId, retainedHistory);
      const latest = history.at(-1)!;
      this.gaps.set(gap.gapId, { gap: latest, expiresAt: Date.now() + this.gapTtlMs });
    }
    this.gapHistoryBytes = [...this.gapHistory.values()]
      .flat()
      .reduce((sum, item) => sum + gapBytes(item), 0);
    this.gapBytes = [...this.gaps.values()]
      .reduce((sum, item) => sum + gapBytes(item.gap), 0);
    this.enforceGapBudget();
  }

  /** Commit a supplied canonical envelope after stripping any body from the raw fact lane. */
  async commit(observation: unknown): Promise<CanonicalObservationCommitResult> {
    if (this.closed) {
      return {
        result: { status: 'rejected', reason: 'canonical observation service is closed' },
        durable: false,
      };
    }
    const checked = validateRawObservation(observation);
    if (!checked.ok) {
      const gap = this.recordGap('raw_commit', 'parser_failed', 'raw_observation', {
        validation: checked.reason,
      });
      return {
        result: { status: 'rejected', reason: checked.reason },
        durable: false,
        gap,
      };
    }
    const sanitized = cloneWithoutBody(checked.value);
    const result = this.raw.commit(sanitized);
    if (result.status === 'rejected' || result.status === 'conflict') {
      const gap = this.recordGap(
        'raw_commit',
        result.status === 'conflict' ? 'dropped' : 'storage_unavailable',
        sanitized.source.sourceId ?? sanitized.source.collectorId ?? 'raw_observation',
        { reason: result.reason },
      );
      return { result, durable: false, gap };
    }

    let durable = false;
    let commitGap: CoverageGap | undefined;
    if (this.sink && this.canonicalPersistenceEnabled) {
      let sideLaneGap: CoverageGap | undefined;
      const failure = () => {
        // Keep processing the machine lane even when the durable raw sink is unavailable. The hot
        // RawObservation and derived KernelFact must remain available for degradation analysis.
        sideLaneGap = this.recordGap('raw_commit', 'storage_unavailable', sanitized.observationId);
      };
      if (this.asyncPersistence) {
        const admitted = this.enqueueRawObservation(sanitized, failure);
        // In async mode a task admitted to the bounded side lane is intentionally hot-only from
        // the request's perspective; its eventual durable result is reflected by metrics/gaps.
        if (!admitted) commitGap = sideLaneGap ?? this.recordGap('raw_commit', 'storage_unavailable', sanitized.observationId);
      } else {
        durable = await this.writeCanonicalSideLane(
          () => this.sink!.saveRawObservations!([sanitized]),
          failure,
        );
        if (!durable) commitGap = sideLaneGap ?? this.recordGap('raw_commit', 'storage_unavailable', sanitized.observationId);
      }
    }
    if (!sanitized.process && ['kernel', 'uprobe', 'socket_payload', 'forwarder'].includes(sanitized.source.sourceType)) {
      this.recordGap('runtime', 'identity_unknown', sanitized.observationId, {
        processGeneration: 'unavailable',
      }, sanitized.eventAtUnixNs);
    }
    // Keep a product-neutral machine fact for every non-semantic Observer event.  Adapter/LLM
    // parsing may fail later, but Kernel evidence remains queryable and can be correlated when a
    // stronger relation arrives.
    let kernelFact: KernelFact | undefined;
    const kernelSource = ['kernel', 'uprobe', 'socket_payload', 'forwarder']
      .includes(sanitized.source.sourceType);
    if (kernelSource
      && sanitized.payload.kind !== 'LlmInteraction'
      && sanitized.payload.kind !== 'AgentPlaintextEvidence') {
      const kernelResult = this.kernel.append(normalizeKernelFact({
        kind: kernelFactKind(sanitized.payload.kind),
        observedAtUnixNs: sanitized.eventAtUnixNs,
        sourceRefs: sanitized.sourceRefs,
        derivedFrom: sanitized.derivedFrom,
        processGenerationKey: sanitized.process?.processGenerationKey,
        connectionId: sanitized.connection?.connectionId,
        payloadRef: sanitized.payload.payloadRef,
        eventId: sanitized.observationId,
        scope: sanitized.runtime?.runtimeInstanceId,
        status: sanitized.payload.truncated ? 'partial' : 'observed',
        authority: ['kernel', 'uprobe', 'socket_payload', 'forwarder'].includes(sanitized.source.sourceType)
          ? 'attested_observer'
          : 'inferred',
      }));
      if (kernelResult.status === 'inserted' || kernelResult.status === 'duplicate') {
        kernelFact = kernelResult.fact;
        if (this.canonicalPersistenceEnabled && this.sink?.saveKernelFacts) {
          const kernelFailure = () => this.recordGap(
            'raw_commit',
            'storage_unavailable',
            sanitized.observationId,
            { kernelFact: 'durability_unavailable' },
          );
          if (this.asyncPersistence) this.enqueueKernelFact(kernelFact, kernelFailure);
          else {
            await this.writeCanonicalSideLane(
              () => this.sink!.saveKernelFacts!([kernelFact!]),
              kernelFailure,
            );
          }
        }
      }
      if (kernelResult.status === 'rejected' || kernelResult.status === 'conflict') {
        this.recordGap('runtime', 'dropped', sanitized.observationId, { kernelFact: kernelResult.reason });
      }
    }
    return {
      result,
      observation: sanitized,
      ...(kernelFact ? { kernelFact } : {}),
      durable,
      ...(commitGap ? { gap: commitGap } : {}),
    };
  }

  /** Build and commit a hash-only fact from an Observer NDJSON line. */
  async commitObserverLine(
    line: string,
    context: CanonicalObservationCommitContext = {},
  ): Promise<CanonicalObservationCommitResult> {
    // Compatibility Observer lines can omit producer timestamps. Resolve a receive-time anchor
    // once at the ingest boundary so their durable rows remain searchable and eligible for the
    // same bounded kernel↔tool time-window linker as fully timestamped events.
    const ingestNow = nowUnixNs();
    const resolvedContext: CanonicalObservationCommitContext = {
      ...context,
      eventAtUnixNs: context.eventAtUnixNs && /^\d{9,41}$/u.test(context.eventAtUnixNs)
        ? context.eventAtUnixNs : ingestNow,
      receivedAtUnixNs: context.receivedAtUnixNs && /^\d{9,41}$/u.test(context.receivedAtUnixNs)
        ? context.receivedAtUnixNs : ingestNow,
    };
    const sourceType = resolvedContext.sourceType;
    const acceptProducerGaps = sourceType === 'kernel'
      || sourceType === 'uprobe'
      || sourceType === 'socket_payload'
      || sourceType === 'forwarder';
    for (const gap of acceptProducerGaps ? observerEnvelopeGaps(line) : []) {
      const stage = boundedText(gap.stage, 64) ?? 'ingest';
      const reason = boundedText(gap.reason, 160) ?? 'unclassified';
      const scope = boundedText(gap.scope, 240) ?? resolvedContext.sourceId ?? resolvedContext.collectorId ?? 'observer';
      this.recordGap(stage as CoverageGap['stage'], reason, scope, {
        observerGapId: boundedText(gap.gapId, 240) ?? 'unknown',
      }, boundedText(gap.lastSeenAtUnixNs, 48) ?? boundedText(gap.firstSeenAtUnixNs, 48) ?? nowUnixNs());
    }
    const candidate = observerEnvelopeCandidate(line);
    if (candidate !== undefined) {
      let checked = validateRawObservation(candidate);
      // Some older Observer bridges emitted the immutable envelope before adding the
      // hash-only payload descriptor. Preserve the envelope identity and event kind while
      // repairing only that missing descriptor from the original line. This keeps the raw
      // commit fence useful for semantic projection without accepting arbitrary producer data.
      if (!checked.ok && (checked.reason.includes('payload') || checked.reason.includes('sourceRefs'))) {
        const fallback = rawObservationFromLine(line, resolvedContext);
        const repaired = candidate && typeof candidate === 'object' && !Array.isArray(candidate)
          ? {
              ...fallback,
              ...(candidate as Record<string, unknown>),
              payload: fallback.payload,
              sourceRefs: fallback.sourceRefs,
              derivedFrom: fallback.derivedFrom,
              idempotencyKey: fallback.idempotencyKey,
            }
          : candidate;
        checked = validateRawObservation(repaired);
      }
      if (checked.ok) {
        // The envelope may be supplied by an untrusted bridge. Rebind transport authority and
        // idempotency to the server-resolved Source context before committing; otherwise a caller
        // could label an API/OTel line as `kernel` and mint an attested KernelFact.
        const reboundSourceType = resolvedContext.sourceType ?? checked.value.source.sourceType;
        // A validated envelope from a generic API/OTel bridge is still producer-controlled. Only
        // an Observer/Forwarder source may carry its own immutable observation identity; generic
        // ingress receives a server-derived hash-only observation below.
        if (!['kernel', 'uprobe', 'socket_payload', 'forwarder'].includes(reboundSourceType)) {
          return this.commit(rawObservationFromLine(line, {
            ...resolvedContext,
            sourceType: reboundSourceType,
          }));
        }
        const sourceId = boundedText(resolvedContext.sourceId, 240) ?? checked.value.source.sourceId;
        const collectorId = boundedText(resolvedContext.collectorId, 240) ?? checked.value.source.collectorId;
        const sourceSequence = boundedText(resolvedContext.sourceSequence, 120) ?? checked.value.source.sourceSequence;
        const rebound: RawObservation = {
          ...checked.value,
          source: {
            ...checked.value.source,
            ...(sourceId ? { sourceId } : {}),
            ...(collectorId ? { collectorId } : {}),
            sourceType: reboundSourceType,
            ...(sourceSequence ? { sourceSequence } : {}),
          },
          ...(resolvedContext.eventAtUnixNs ? { eventAtUnixNs: resolvedContext.eventAtUnixNs } : {}),
          ...(resolvedContext.receivedAtUnixNs ? { receivedAtUnixNs: resolvedContext.receivedAtUnixNs } : {}),
          sourceRefs: (() => {
            const trustedRefs = ['kernel', 'uprobe', 'socket_payload', 'forwarder'].includes(reboundSourceType)
              ? mergeServerSourceRefs(
                  checked.value.observationId,
                  resolvedContext.sourceRefs,
                  resolvedContext.compatibilitySourceRefs,
                )
              : [checked.value.observationId];
            return [...new Set([...trustedRefs, ...checked.value.sourceRefs])].slice(0, 128);
          })(),
          idempotencyKey: resolvedContext.idempotencyKey ?? checked.value.idempotencyKey,
        };
        return this.commit(rebound);
      }
      // A malformed producer extension must not prevent the compatibility raw fact from being
      // retained. Record the gap and continue with the line hash below.
      this.recordGap('raw_commit', 'parser_failed', resolvedContext.sourceId ?? resolvedContext.collectorId ?? 'observer', {
        validation: checked.reason,
      });
    }
    const observation = rawObservationFromLine(line, resolvedContext);
    return this.commit(observation);
  }

  get(observationId: string, revision?: number): RawObservation | undefined {
    return this.raw.get(observationId, revision);
  }

  list(limit?: number): RawObservation[] {
    return this.raw.list(limit);
  }

  private mergeDurableFirst<T>(
    durable: readonly T[],
    hot: readonly T[],
    keyOf: (value: T) => string,
  ): T[] {
    const merged = new Map<string, T>();
    for (const value of durable) merged.set(keyOf(value), value);
    for (const value of hot) {
      const key = keyOf(value);
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, value);
        continue;
      }
      // PostgreSQL/ClickHouse rows are the authoritative copy for a given immutable revision.
      // Keep them when the hot ring diverges and expose a bounded diagnostic counter instead of
      // silently letting a process-local value overwrite durable history at read time.
      if (canonicalValueFingerprint(existing) !== canonicalValueFingerprint(value)) {
        this.durableReadConflicts += 1;
      }
    }
    return [...merged.values()];
  }

  async listDurable(limit = 1_000): Promise<RawObservation[]> {
    const requested = Number(limit);
    const bounded = Number.isFinite(requested)
      ? Math.max(1, Math.min(10_000, Math.trunc(requested)))
      : 1_000;
    const durable = this.sink?.loadRawObservations
      ? (await this.sink.loadRawObservations({ limit: bounded }).catch(() => []))
          .flatMap((candidate) => {
            const safe = safeDurableRawObservation(candidate);
            return safe ? [safe] : [];
          })
      : [];
    return this.mergeDurableFirst(
      durable,
      this.raw.list(bounded),
      (observation) => `${observation.observationId}\u0000${observation.revision}`,
    )
      .sort((left, right) => {
        try {
          const l = BigInt(left.eventAtUnixNs);
          const r = BigInt(right.eventAtUnixNs);
          return l === r ? right.revision - left.revision : l > r ? -1 : 1;
        } catch {
          return right.eventAtUnixNs.localeCompare(left.eventAtUnixNs);
        }
      })
      .slice(0, bounded)
      .map((observation) => structuredClone(observation));
  }

  async getDurableRawObservation(observationId: string, revision?: number): Promise<RawObservation | undefined> {
    const id = boundedText(observationId, 240);
    if (!id) return undefined;
    const durable = this.sink?.loadRawObservations
      ? (await this.sink.loadRawObservations({
          observationIds: [id],
          ...(revision === undefined ? {} : { revision }),
          limit: revision === undefined ? 128 : 1,
        }).catch(() => []))
          .flatMap((candidate) => {
            const safe = safeDurableRawObservation(candidate);
            return safe ? [safe] : [];
          })
      : [];
    const candidates = [
      ...durable,
      ...(this.raw.get(id, revision) ? [this.raw.get(id, revision)!] : []),
    ].filter((item) => revision === undefined || item.revision === revision);
    return candidates.sort((left, right) => right.revision - left.revision)[0]
      ? structuredClone(candidates.sort((left, right) => right.revision - left.revision)[0])
      : undefined;
  }

  stats(): ReturnType<RawObservationStore['stats']> {
    return this.raw.stats();
  }

  kernelStats(): ReturnType<KernelFactStore['stats']> {
    return this.kernel.stats();
  }

  semanticStats(): ReturnType<SemanticRecordStore['stats']> {
    return this.semantic.stats();
  }

  /** Commit parser/Adapter output as a rebuildable semantic projection. */
  async commitSemanticRecords(records: readonly (SemanticRecord | unknown)[]): Promise<{
    accepted: number;
    rejected: number;
    durable: boolean;
  }> {
    if (this.closed || records.length === 0) return { accepted: 0, rejected: records.length, durable: false };
    const results = this.semantic.appendMany(records);
    const acceptedRecords = results
      .filter((result): result is { status: 'inserted' | 'duplicate'; record: SemanticRecord } =>
        result.status === 'inserted' || result.status === 'duplicate')
      .map((result) => result.record);
    let durable = false;
    if (acceptedRecords.length > 0 && this.canonicalPersistenceEnabled && this.sink?.saveSemanticRecords) {
      durable = await this.writeCanonicalSideLane(
        () => this.sink!.saveSemanticRecords!(acceptedRecords),
        () => this.recordGap('projection', 'storage_unavailable', 'semantic_record', { count: acceptedRecords.length }),
      );
      // A scheduled asynchronous write is pending, not yet durable from the caller's point of
      // view.  The hot SemanticRecord remains queryable while the completion updates the durable
      // sink or records a bounded gap.
      if (this.asyncPersistence) durable = false;
    }
    return {
      accepted: results.filter((result) => result.status === 'inserted' || result.status === 'duplicate').length,
      rejected: results.filter((result) => result.status === 'rejected' || result.status === 'conflict' || result.status === 'evicted').length,
      durable,
    };
  }

  async listDurableSemanticRecords(limit = 1_000): Promise<SemanticRecord[]> {
    const requested = Number(limit);
    const bounded = Number.isFinite(requested) ? Math.max(1, Math.min(10_000, Math.trunc(requested))) : 1_000;
    const durable = this.sink?.loadSemanticRecords
      ? (await this.sink.loadSemanticRecords({ limit: bounded }).catch(() => []))
          .flatMap((candidate) => {
            const safe = safeDurableSemanticRecord(candidate);
            return safe ? [safe] : [];
          })
      : [];
    return this.mergeDurableFirst(
      durable,
      this.semantic.list(bounded),
      (record) => `${record.semanticRecordId}\0${record.revision ?? 1}`,
    )
      .sort((left, right) => left.observedAtUnixNs === right.observedAtUnixNs
        ? (right.revision ?? 1) - (left.revision ?? 1)
          || left.semanticRecordId.localeCompare(right.semanticRecordId)
        : left.observedAtUnixNs > right.observedAtUnixNs ? -1 : 1)
      .slice(0, bounded)
      .map((record) => structuredClone(record));
  }

  async getDurableSemanticRecord(semanticRecordId: string, revision?: number): Promise<SemanticRecord | undefined> {
    const id = boundedText(semanticRecordId, 240);
    if (!id) return undefined;
    const durable = this.sink?.loadSemanticRecords
      ? (await this.sink.loadSemanticRecords({
          semanticRecordIds: [id],
          ...(revision === undefined ? {} : { revision }),
          limit: revision === undefined ? 128 : 1,
        }).catch(() => []))
          .flatMap((candidate) => {
            const safe = safeDurableSemanticRecord(candidate);
            return safe ? [safe] : [];
          })
      : [];
    const candidates = [...durable, ...(this.semantic.get(id, revision) ? [this.semantic.get(id, revision)!] : [])]
      .filter((item) => revision === undefined || (item.revision ?? 1) === revision);
    return candidates.sort((left, right) => (right.revision ?? 1) - (left.revision ?? 1))[0]
      ? structuredClone(candidates.sort((left, right) => (right.revision ?? 1) - (left.revision ?? 1))[0])
      : undefined;
  }

  async commitEvidenceLinks(links: readonly (EvidenceLink | unknown)[]): Promise<{
    accepted: number;
    rejected: number;
    durable: boolean;
  }> {
    if (this.closed || links.length === 0) return { accepted: 0, rejected: links.length, durable: false };
    const results = this.evidence.appendMany(links);
    const acceptedLinks = results
      .filter((result): result is { status: 'inserted' | 'duplicate'; link: EvidenceLink } =>
        result.status === 'inserted' || result.status === 'duplicate')
      .map((result) => result.link);
    let durable = false;
    if (acceptedLinks.length > 0 && this.canonicalPersistenceEnabled && this.sink?.saveEvidenceLinks) {
      durable = await this.writeCanonicalSideLane(
        () => this.sink!.saveEvidenceLinks!(acceptedLinks),
        () => this.recordGap('projection', 'storage_unavailable', 'evidence_link', { count: acceptedLinks.length }),
      );
      if (this.asyncPersistence) durable = false;
    }
    return {
      accepted: results.filter((result) => result.status === 'inserted' || result.status === 'duplicate').length,
      rejected: results.filter((result) => result.status === 'rejected' || result.status === 'conflict' || result.status === 'evicted').length,
      durable,
    };
  }

  async listDurableEvidenceLinks(limit = 1_000): Promise<EvidenceLink[]> {
    const requested = Number(limit);
    const bounded = Number.isFinite(requested) ? Math.max(1, Math.min(10_000, Math.trunc(requested))) : 1_000;
    const durable = this.sink?.loadEvidenceLinks
      ? (await this.sink.loadEvidenceLinks({ limit: bounded }).catch(() => []))
          .flatMap((candidate) => {
            const safe = safeDurableEvidenceLink(candidate);
            return safe ? [safe] : [];
          })
      : [];
    return this.mergeDurableFirst(
      durable,
      this.evidence.list(bounded),
      (link) => `${link.linkId}\0${link.resolutionRevision}`,
    )
      .sort((left, right) => left.validFromUnixNs === right.validFromUnixNs
        ? right.resolutionRevision - left.resolutionRevision || left.linkId.localeCompare(right.linkId)
        : left.validFromUnixNs > right.validFromUnixNs ? -1 : 1)
      .slice(0, bounded)
      .map((link) => structuredClone(link));
  }

  /**
   * Bounded reverse/forward EvidenceLink lookup used by deep-link readers.  The canonical link
   * store is append-only; callers must never scan an unbounded relational table or silently turn a
   * sink outage into an empty successful result.  The hot ring is retained as a compatibility
   * fallback and the returned rows are still contract-validated before exposure.
   */
  private async readDurableEvidenceLinksMatching(
    input: Parameters<NonNullable<CanonicalRawObservationSink['loadEvidenceLinks']>>[0],
    matches: (link: EvidenceLink) => boolean,
    limit = 128,
  ): Promise<CanonicalEvidenceLinkReadResult> {
    const requested = Number(limit);
    const bounded = Number.isFinite(requested) ? Math.max(1, Math.min(2_000, Math.trunc(requested))) : 128;
    let degraded = false;
    let sinkReadFailed = false;
    const sink = this.sink;
    const sinkQueried = Boolean(sink?.loadEvidenceLinks);
    const durable = sinkQueried
      ? (await Promise.race([
          sink!.loadEvidenceLinks!({ ...input, limit: bounded }).catch(() => {
            degraded = true;
            sinkReadFailed = true;
            return [];
          }),
          new Promise<EvidenceLink[]>((resolve) => {
            const timer = setTimeout(() => {
              degraded = true;
              sinkReadFailed = true;
              resolve([]);
            }, EVIDENCE_LINK_READ_TIMEOUT_MS);
          }),
        ]))
          .flatMap((candidate) => {
            const safe = safeDurableEvidenceLink(candidate);
            return safe && matches(safe) ? [safe] : [];
          })
      : [];
    const sinkAvailability = typeof sink?.isEvidenceLinksReadAvailable === 'function'
      ? sink.isEvidenceLinksReadAvailable()
      : undefined;
    if (sinkAvailability === false) {
      degraded = true;
      sinkReadFailed = true;
    }
    const hot = this.evidence.list(Math.min(10_000, Math.max(bounded * 4, bounded)))
      .filter(matches);
    const durableKeys = new Set(durable.map((link) => `${link.linkId}\0${link.resolutionRevision}`));
    const hotOnly = sinkQueried && hot.some((link) => !durableKeys.has(`${link.linkId}\0${link.resolutionRevision}`));
    if (hotOnly) degraded = true;
    const merged = this.mergeDurableFirst(
      durable,
      hot,
      (link) => `${link.linkId}\0${link.resolutionRevision}`,
    );
    // Forward readers use the current effective revision for each logical edge. Historical
    // revisions remain available through the explicit link endpoint with `resolutionRevision`.
    const latestByLink = new Map<string, EvidenceLink>();
    for (const link of merged) {
      const previous = latestByLink.get(link.linkId);
      if (!previous || link.resolutionRevision > previous.resolutionRevision) latestByLink.set(link.linkId, link);
    }
    const items = [...latestByLink.values()]
      .sort((left, right) => left.validFromUnixNs === right.validFromUnixNs
        ? right.resolutionRevision - left.resolutionRevision || left.linkId.localeCompare(right.linkId)
        : left.validFromUnixNs > right.validFromUnixNs ? -1 : 1)
      .slice(0, bounded)
      .map((link) => structuredClone(link));
    const source: CanonicalEvidenceLinkReadResult['source'] = durable.length > 0
      ? hotOnly ? 'canonical_store+hot_delta' : 'canonical_store'
      : sinkQueried && !degraded ? 'canonical_store' : 'memory_hot_ring';
    return {
      items,
      source,
      degraded,
      reasons: degraded
        ? [
            ...(sinkReadFailed ? ['canonical_evidence_link_projection_unavailable'] : []),
            ...(hotOnly ? ['canonical_evidence_link_hot_delta_pending'] : []),
          ]
        : [],
    };
  }

  async listDurableEvidenceLinksByEvidenceRef(
    evidenceRef: string,
    limit = 128,
  ): Promise<EvidenceLink[]> {
    const ref = boundedText(evidenceRef, 512);
    if (!ref) return [];
    return (await this.readDurableEvidenceLinksMatching(
      { evidenceRef: ref },
      (link) => link.evidenceRefs.includes(ref),
      limit,
    )).items;
  }

  async readDurableEvidenceLinksByEvidenceRef(
    evidenceRef: string,
    limit = 128,
  ): Promise<CanonicalEvidenceLinkReadResult> {
    const ref = boundedText(evidenceRef, 512);
    if (!ref) return { items: [], source: 'memory_hot_ring', degraded: false, reasons: [] };
    return this.readDurableEvidenceLinksMatching(
      { evidenceRef: ref },
      (link) => link.evidenceRefs.includes(ref),
      limit,
    );
  }

  async listDurableEvidenceLinksForTarget(
    toType: EvidenceLink['toType'],
    toId: string,
    limit = 128,
  ): Promise<EvidenceLink[]> {
    const id = boundedText(toId, 512);
    if (!id) return [];
    return (await this.readDurableEvidenceLinksMatching(
      { toType, toIds: [id] },
      (link) => link.toType === toType && link.toId === id,
      limit,
    )).items;
  }

  async listDurableEvidenceLinksForTargetId(
    toId: string,
    limit = 128,
  ): Promise<EvidenceLink[]> {
    const id = boundedText(toId, 512);
    if (!id) return [];
    return (await this.readDurableEvidenceLinksMatching(
      { toIds: [id] },
      (link) => link.toId === id,
      limit,
    )).items;
  }

  async readDurableEvidenceLinksForTargetId(
    toId: string,
    limit = 128,
  ): Promise<CanonicalEvidenceLinkReadResult> {
    const id = boundedText(toId, 512);
    if (!id) return { items: [], source: 'memory_hot_ring', degraded: false, reasons: [] };
    return this.readDurableEvidenceLinksMatching(
      { toIds: [id] },
      (link) => link.toId === id,
      limit,
    );
  }

  async listDurableEvidenceLinksForSource(
    fromType: EvidenceLink['fromType'],
    fromId: string,
    limit = 128,
  ): Promise<EvidenceLink[]> {
    const id = boundedText(fromId, 512);
    if (!id) return [];
    return (await this.readDurableEvidenceLinksMatching(
      { fromType, fromIds: [id] },
      (link) => link.fromType === fromType && link.fromId === id,
      limit,
    )).items;
  }

  async getDurableEvidenceLink(linkId: string, resolutionRevision?: number): Promise<EvidenceLink | undefined> {
    const id = boundedText(linkId, 240);
    if (!id) return undefined;
    const durable = this.sink?.loadEvidenceLinks
      ? (await this.sink.loadEvidenceLinks({
          linkIds: [id],
          ...(resolutionRevision === undefined ? {} : { resolutionRevision }),
          limit: resolutionRevision === undefined ? 128 : 1,
        }).catch(() => []))
          .flatMap((candidate) => {
            const safe = safeDurableEvidenceLink(candidate);
            return safe ? [safe] : [];
          })
      : [];
    const candidates = [...durable, ...(this.evidence.get(id, resolutionRevision) ? [this.evidence.get(id, resolutionRevision)!] : [])]
      .filter((item) => resolutionRevision === undefined || item.resolutionRevision === resolutionRevision);
    return candidates.sort((left, right) => right.resolutionRevision - left.resolutionRevision)[0]
      ? structuredClone(candidates.sort((left, right) => right.resolutionRevision - left.resolutionRevision)[0])
      : undefined;
  }

  async commitSessionMemberships(memberships: readonly (SessionMembership | unknown)[]): Promise<{
    accepted: number;
    rejected: number;
    durable: boolean;
  }> {
    if (this.closed || memberships.length === 0) return { accepted: 0, rejected: memberships.length, durable: false };
    const results = this.sessionMemberships.appendMany(memberships);
    const acceptedMemberships = results
      .filter((result): result is { status: 'inserted' | 'duplicate'; membership: SessionMembership } =>
        result.status === 'inserted' || result.status === 'duplicate')
      .map((result) => result.membership);
    let durable = false;
    if (acceptedMemberships.length > 0 && this.canonicalPersistenceEnabled && this.sink?.saveSessionMemberships) {
      durable = await this.writeCanonicalSideLane(
        () => this.sink!.saveSessionMemberships!(acceptedMemberships),
        () => this.recordGap('projection', 'storage_unavailable', 'session_membership', { count: acceptedMemberships.length }),
      );
      if (this.asyncPersistence) durable = false;
    }
    return {
      accepted: results.filter((result) => result.status === 'inserted' || result.status === 'duplicate').length,
      rejected: results.filter((result) => result.status === 'rejected' || result.status === 'conflict' || result.status === 'evicted').length,
      durable,
    };
  }

  async listDurableSessionMemberships(limit = 1_000, interactionId?: string, sessionId?: string): Promise<SessionMembership[]> {
    const requested = Number(limit);
    const bounded = Number.isFinite(requested) ? Math.max(1, Math.min(10_000, Math.trunc(requested))) : 1_000;
    const durable = this.sink?.loadSessionMemberships
      ? (await this.sink.loadSessionMemberships({
          limit: bounded,
          ...(interactionId ? { interactionIds: [interactionId] } : {}),
          ...(sessionId ? { sessionIds: [sessionId] } : {}),
        }).catch(() => []))
          .flatMap((candidate) => {
            const safe = safeDurableSessionMembership(candidate);
            return safe ? [safe] : [];
          })
      : [];
    return this.mergeDurableFirst(
      durable,
      this.sessionMemberships.list(Math.min(10_000, bounded * (interactionId ? 8 : 1)))
        .filter((membership) => (!interactionId || membership.interactionId === interactionId)
          && (!sessionId || membership.sessionId === sessionId)),
      (membership) => `${membership.membershipId}\0${membership.resolutionRevision}`,
    )
      .sort((left, right) => left.validFromUnixNs === right.validFromUnixNs
        ? right.resolutionRevision - left.resolutionRevision
        : left.validFromUnixNs > right.validFromUnixNs ? -1 : 1)
      .slice(0, bounded)
      .map((membership) => structuredClone(membership));
  }

  async getDurableSessionMembership(membershipId: string, resolutionRevision?: number): Promise<SessionMembership | undefined> {
    const id = boundedText(membershipId, 240);
    if (!id) return undefined;
    // Point reads are the canonical durability boundary. Do not silently merge the hot ring into
    // a successful durable result: the controller must be able to mark a late or unavailable
    // PostgreSQL projection as partial while still returning the bounded hot fallback.
    if (!this.sink?.loadSessionMemberships) {
      throw new Error('canonical SessionMembership projection temporarily unavailable');
    }
    const durable = (await this.sink.loadSessionMemberships({
      membershipIds: [id],
      ...(resolutionRevision === undefined ? {} : { resolutionRevision }),
      limit: resolutionRevision === undefined ? 128 : 1,
      strictRead: true,
    }))
      .flatMap((candidate) => {
        const safe = safeDurableSessionMembership(candidate);
        return safe ? [safe] : [];
      })
      .filter((item) => resolutionRevision === undefined || item.resolutionRevision === resolutionRevision)
      .sort((left, right) => right.resolutionRevision - left.resolutionRevision);
    const hot = this.sessionMemberships.get(id, resolutionRevision);
    const latestDurable = durable[0];
    if (!latestDurable) return undefined;
    // A newer hot revision means the durable point is stale. Returning it as complete would
    // make a canonical reader hide an append-only resolution update.
    if (resolutionRevision === undefined && hot && hot.resolutionRevision > latestDurable.resolutionRevision) return undefined;
    return structuredClone(latestDurable);
  }

  sessionMembershipStats(): ReturnType<SessionMembershipStore['stats']> {
    return this.sessionMemberships.stats();
  }

  gapStats(): {
    entries: number;
    historyEntries: number;
    bytes: number;
    maxBytes: number;
    maxEntries: number;
    ttlMs: number;
    evicted: number;
    expired: number;
    closed: boolean;
    persistenceInFlight: number;
    persistenceMaxInFlight: number;
    persistenceDropped: number;
    durableReadConflicts: number;
    asyncPersistence: boolean;
    asyncPersistenceInFlight: number;
    asyncPersistenceMaxInFlight: number;
    asyncPersistenceScheduled: number;
    asyncPersistenceCompleted: number;
    asyncPersistenceFailed: number;
    asyncPersistenceDropped: number;
    asyncRawBatchQueueRows: number;
    asyncRawBatchQueueBytes: number;
    asyncRawBatchMaxRows: number;
    asyncRawBatchMaxBytes: number;
  } {
    return {
      entries: this.gaps.size,
      historyEntries: [...this.gapHistory.values()].reduce((sum, items) => sum + items.length, 0),
      bytes: this.gapBytes + this.gapHistoryBytes,
      maxBytes: this.gapMaxBytes,
      maxEntries: this.maxGaps,
      ttlMs: this.gapTtlMs,
      evicted: this.gapEvicted,
      expired: this.gapExpired,
      closed: this.closed,
      persistenceInFlight: this.gapPersistenceInFlight,
      persistenceMaxInFlight: this.gapPersistenceMaxInFlight,
      persistenceDropped: this.gapPersistenceDropped,
      durableReadConflicts: this.durableReadConflicts,
      asyncPersistence: this.asyncPersistence,
      asyncPersistenceInFlight: this.asyncPersistenceInFlight,
      asyncPersistenceMaxInFlight: this.asyncPersistenceMaxInFlight,
      asyncPersistenceScheduled: this.asyncPersistenceScheduled,
      asyncPersistenceCompleted: this.asyncPersistenceCompleted,
      asyncPersistenceFailed: this.asyncPersistenceFailed,
      asyncPersistenceDropped: this.asyncPersistenceDropped,
      asyncRawBatchQueueRows: this.asyncRawBatchQueue.length,
      asyncRawBatchQueueBytes: this.asyncRawBatchQueueBytes,
      asyncRawBatchMaxRows: this.asyncRawBatchMaxRows,
      asyncRawBatchMaxBytes: this.asyncRawBatchMaxBytes,
    };
  }

  kernelFacts(limit?: number) {
    return this.kernel.list(limit);
  }

  async listDurableKernelFacts(limit = 1_000): Promise<KernelFact[]> {
    const requested = Number(limit);
    const bounded = Number.isFinite(requested)
      ? Math.max(1, Math.min(10_000, Math.trunc(requested)))
      : 1_000;
    const durable = this.sink?.loadKernelFacts
      ? (await this.sink.loadKernelFacts({ limit: bounded }).catch(() => []))
          .flatMap((candidate) => {
            const safe = safeDurableKernelFact(candidate);
            return safe ? [safe] : [];
          })
      : [];
    return this.mergeDurableFirst(
      durable,
      this.kernel.list(bounded),
      (fact) => fact.factId,
    )
      .sort((left, right) => {
        try {
          const l = BigInt(left.observedAtUnixNs);
          const r = BigInt(right.observedAtUnixNs);
          return l === r ? right.factId.localeCompare(left.factId) : l > r ? -1 : 1;
        } catch {
          return right.observedAtUnixNs.localeCompare(left.observedAtUnixNs);
        }
      })
      .slice(0, bounded)
      .map((fact) => structuredClone(fact));
  }

  async getDurableKernelFact(factId: string): Promise<KernelFact | undefined> {
    const id = boundedText(factId, 240);
    if (!id) return undefined;
    const durable = this.sink?.loadKernelFacts
      ? (await this.sink.loadKernelFacts({ factIds: [id], limit: 8 }).catch(() => []))
          .flatMap((candidate) => {
            const safe = safeDurableKernelFact(candidate);
            return safe ? [safe] : [];
          })
      : [];
    // A canonical factId is authoritative when it is present.  Do not let a compatibility alias
    // shadow an exact durable row (an alias may legitimately have collided across revisions).
    const exactDurable = durable.filter((candidate) => candidate.factId === id);
    const hot = this.kernel.getCanonical(id);
    // Point reads follow the same durable-first rule as list reads. A process-local hot copy may
    // be stale or tampered with after a late projection; never let it overwrite an immutable
    // durable KernelFact at read time. Keep a bounded diagnostic counter for reconciliation.
    if (exactDurable[0] && hot
      && canonicalValueFingerprint(exactDurable[0]) !== canonicalValueFingerprint(hot)) {
      this.durableReadConflicts += 1;
    }
    if (exactDurable[0]) return structuredClone(exactDurable[0]);
    if (hot) return structuredClone(hot);

    // Older compatibility rows can address the same immutable fact with an event ID or a raw
    // source reference. Ask the durable sink for those scalar/JSON predicates without changing
    // the canonical record or copying a payload. The service deliberately refuses an ambiguous
    // alias: selecting whichever row happened to arrive first would fabricate ownership.
    const durableAliases = this.sink?.loadKernelFacts
      ? (await this.sink.loadKernelFacts({
          eventIds: [id],
          sourceRefs: [id],
          derivedFrom: [id],
          limit: 16,
        }).catch(() => []))
          .flatMap((candidate) => {
            const safe = safeDurableKernelFact(candidate);
            return safe ? [safe] : [];
          })
      : [];
    const matchingAliases = [...new Map(durableAliases
      .filter((candidate) => candidate.eventId === id
        || candidate.sourceRefs.includes(id)
        || candidate.derivedFrom.includes(id))
      .map((candidate) => [candidate.factId, candidate] as const)).values()];
    if (matchingAliases.length > 1) {
      this.durableReadConflicts += 1;
      return undefined;
    }
    if (matchingAliases[0]) return structuredClone(matchingAliases[0]);

    // The bounded hot locator is the final fallback for a just-committed fact whose durable side
    // lane is still catching up. `getByAlias` returns a fact only for a unique live binding.
    const hotAlias = this.kernel.getByAlias(id);
    return hotAlias ? structuredClone(hotAlias) : undefined;
  }

  private enforceGapBudget(): void {
    while (
      this.gaps.size > this.maxGaps
      || this.gapBytes + this.gapHistoryBytes > this.gapMaxBytes
    ) {
      const oldest = this.gaps.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      const current = this.gaps.get(oldest);
      this.gaps.delete(oldest);
      this.gapBytes = Math.max(0, this.gapBytes - (current ? gapBytes(current.gap) : 0));
      const history = this.gapHistory.get(oldest) ?? [];
      this.gapHistory.delete(oldest);
      this.gapHistoryBytes = Math.max(
        0,
        this.gapHistoryBytes - history.reduce((sum, item) => sum + gapBytes(item), 0),
      );
      this.gapEvicted += 1;
    }
  }

  recordGap(
    stage: CoverageGap['stage'],
    reason: CoverageGap['reason'],
    scope: string,
    details: Record<string, string | number | boolean> = {},
    atUnixNs = nowUnixNs(),
  ): CoverageGap {
    const safeStage = boundedText(stage, 64) ?? 'ingest';
    const safeReason = boundedText(reason, 160) ?? 'unclassified';
    const safeScope = safeGapScope(scope);
    const safeAt = /^\d{9,41}$/u.test(atUnixNs) ? atUnixNs : nowUnixNs();
    const key = gapId(safeStage, safeReason, safeScope);
    const now = Date.now();
    const previous = this.gaps.get(key);
    // A gap is itself a derived, auditable record.  When no concrete observation key is available
    // (for example a storage/projection failure scoped to a stage), retain the deterministic gap
    // key as a synthetic source reference rather than returning an untraceable empty array.
    const inferredSourceRefs = /^(?:ro_|ob_|kf_|mi_|pe_|rr_|src_)/u.test(safeScope)
      ? [safeScope]
      : [`coverage:${key}`];
    const firstSeenAtUnixNs = previous?.gap.firstSeenAtUnixNs
      && BigInt(previous.gap.firstSeenAtUnixNs) < BigInt(safeAt)
      ? previous.gap.firstSeenAtUnixNs
      : safeAt;
    const lastSeenAtUnixNs = previous?.gap.lastSeenAtUnixNs
      && BigInt(previous.gap.lastSeenAtUnixNs) > BigInt(safeAt)
      ? previous.gap.lastSeenAtUnixNs
      : safeAt;
    const gap: CoverageGap = {
      schemaVersion: CANONICAL_SCHEMA_VERSIONS.coverageGap,
      gapId: previous?.gap.gapId ?? key,
      stage: safeStage as CoverageGap['stage'],
      reason: safeReason,
      scope: safeScope,
      sourceRefs: previous?.gap.sourceRefs?.length ? previous.gap.sourceRefs : inferredSourceRefs,
      firstSeenAtUnixNs,
      lastSeenAtUnixNs,
      droppedCount: (previous?.gap.droppedCount ?? 0) + (safeReason === 'dropped' ? 1 : 0),
      orphanedCount: previous?.gap.orphanedCount ?? 0,
      details: { ...(previous?.gap.details ?? {}), ...safeGapDetails(details) },
      revision: (previous?.gap.revision ?? 0) + 1,
    };
    const previousGapBytes = previous ? gapBytes(previous.gap) : 0;
    this.gaps.delete(key);
    this.gapBytes = Math.max(0, this.gapBytes - previousGapBytes);
    this.gaps.set(key, { gap, expiresAt: now + this.gapTtlMs });
    const history = this.gapHistory.get(key) ?? [];
    if (history.length >= 32) {
      const removed = history.shift();
      if (removed) this.gapHistoryBytes = Math.max(0, this.gapHistoryBytes - gapBytes(removed));
    }
    history.push(structuredClone(gap));
    this.gapHistory.set(key, history);
    this.gapBytes += gapBytes(gap);
    this.gapHistoryBytes += gapBytes(gap);
    if (this.canonicalPersistenceEnabled && this.sink?.saveCoverageGaps) {
      if (this.gapPersistenceInFlight >= this.gapPersistenceMaxInFlight) {
        // Hot gap history remains available; bound durable side effects under a gap storm instead
        // of accumulating one Promise/DB request per failed event.
        this.gapPersistenceDropped += 1;
      } else {
        this.gapPersistenceInFlight += 1;
        void this.sink.saveCoverageGaps([gap])
          .catch(() => undefined)
          .finally(() => {
            this.gapPersistenceInFlight = Math.max(0, this.gapPersistenceInFlight - 1);
          });
      }
    }
    this.enforceGapBudget();
    return structuredClone(gap);
  }

  listGaps(limit = 1_000): CoverageGap[] {
    const now = Date.now();
    for (const [key, entry] of this.gaps) {
      if (entry.expiresAt > now) continue;
      this.gaps.delete(key);
      this.gapBytes = Math.max(0, this.gapBytes - gapBytes(entry.gap));
      const history = this.gapHistory.get(key) ?? [];
      this.gapHistoryBytes = Math.max(0, this.gapHistoryBytes - history.reduce((sum, item) => sum + gapBytes(item), 0));
      this.gapHistory.delete(key);
      this.gapExpired += 1;
    }
    // Durable restore or a prior revision can leave a history key without a live latest entry;
    // remove it as part of the same TTL sweep so history cannot grow beyond the hot bound.
    for (const key of this.gapHistory.keys()) {
      if (!this.gaps.has(key)) {
        const history = this.gapHistory.get(key) ?? [];
        this.gapHistoryBytes = Math.max(0, this.gapHistoryBytes - history.reduce((sum, item) => sum + gapBytes(item), 0));
        this.gapHistory.delete(key);
      }
    }
    const bounded = Math.max(1, Math.min(this.maxGaps, Math.trunc(limit)));
    return [...this.gapHistory.values()].flat()
      .sort((left, right) => left.lastSeenAtUnixNs === right.lastSeenAtUnixNs
        ? left.gapId.localeCompare(right.gapId) || left.revision - right.revision
        : left.lastSeenAtUnixNs > right.lastSeenAtUnixNs ? -1 : 1)
      .slice(0, bounded)
      .map((gap) => structuredClone(gap));
  }

  /** Attach immutable provenance IDs to a compatibility metadata object. */
  attachMeta(meta: T.EventMeta, observation: RawObservation | undefined): T.EventMeta {
    if (!observation) return meta;
    return {
      ...meta,
      rawObservationId: observation.observationId,
      rawObservationRevision: observation.revision,
      ...(observation.process?.processGenerationKey
        ? {
            process: {
              ...(meta.process ?? {}),
              processGenerationKey: observation.process.processGenerationKey,
              ...(observation.process.parentProcessGenerationKey
                ? { parentProcessGenerationKey: observation.process.parentProcessGenerationKey }
                : {}),
            },
          }
        : {}),
    };
  }

  close(): void {
    if (this.closed) return;
    if (this.asyncRawBatchTimer) clearTimeout(this.asyncRawBatchTimer);
    this.asyncRawBatchTimer = undefined;
    for (const item of this.asyncRawBatchQueue) {
      this.asyncPersistenceDropped += 1;
      try { item.onFailure(); } catch { /* coverage is best effort */ }
    }
    this.asyncRawBatchQueue = [];
    this.asyncRawBatchQueueBytes = 0;
    this.closed = true;
    this.raw.close();
    this.kernel.close();
    this.semantic.close();
    this.evidence.close();
    this.sessionMemberships.close();
    this.agentAdapters.close();
    this.transports.close();
    this.llmFormats.close();
    this.runtimes.close();
    this.gaps.clear();
    this.gapHistory.clear();
    this.gapBytes = 0;
    this.gapHistoryBytes = 0;
  }

  onModuleDestroy(): void {
    this.close();
  }
}
