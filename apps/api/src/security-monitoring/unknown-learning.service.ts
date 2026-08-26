import { createHash } from 'node:crypto';
import type { JudgedEvent } from './types';
import {
  buildUnknownClusters,
  createUnknownPolicyCandidate,
  isUnknownLearningCandidate,
  mergeUnknownClusters,
  transitionUnknownPolicy,
  validateUnknownCluster,
  validateUnknownPolicyCandidate,
  type UnknownCanaryScopeKind,
  type UnknownCluster,
  type UnknownClusterReview,
  type UnknownLearnedAction,
  type UnknownPolicyCandidate,
  type UnknownPolicyTransition,
} from './unknown-learning';

export const UNKNOWN_LEARNING_STATE_SCHEMA_VERSION = 'anysentry.unknown_learning_state.v1' as const;
export const UNKNOWN_LEARNING_DEDUPE_SEMANTICS = 'bounded_sha256_event_ids_within_retained_event_time' as const;

export interface UnknownLearningServiceOptions {
  enabled?: boolean;
  windowMs?: number;
  retentionWindows?: number;
  maxClusters?: number;
  maxFamilies?: number;
  maxReviews?: number;
  maxPolicies?: number;
  maxDedupeEntries?: number;
  maxIngestBatch?: number;
  maxFutureSkewMs?: number;
  firstSamples?: number;
  reservoirSamples?: number;
  maxStateBytes?: number;
}

export interface UnknownLearningStateV1 {
  schemaVersion: typeof UNKNOWN_LEARNING_STATE_SCHEMA_VERSION;
  exportedAt: number;
  enabled: boolean;
  watermarkMs: number;
  clustering: {
    windowMs: number;
    firstSamples: number;
    reservoirSamples: number;
  };
  clusters: UnknownCluster[];
  reviews: UnknownFamilyReviewRecord[];
  policies: UnknownPolicyCandidate[];
  /** Hashes, never raw event IDs. Persistence preserves exact-once within the retained horizon. */
  dedupe: {
    semantics: typeof UNKNOWN_LEARNING_DEDUPE_SEMANTICS;
    entries: Array<{ eventIdHash: string; eventAt: number }>;
  };
  totals: UnknownLearningStatus['totals'];
}

export interface UnknownLearningRestoreResult {
  status: UnknownLearningStatus;
  pruned: {
    expiredClusters: number;
    capacityClusters: number;
    reviews: number;
    policies: number;
    dedupeEntries: number;
  };
}

export interface UnknownFamilyReviewRecord {
  familyId: string;
  decision: Exclude<UnknownClusterReview, 'unreviewed'>;
  revision: number;
  actor: string;
  reason: string;
  reviewedAt: number;
}

export interface UnknownFamilySnapshot {
  familyId: string;
  stableScope: string;
  unknownReason: UnknownCluster['unknownReason'];
  eventKind: string;
  targetBucket: string;
  /** Does not claim pre-ring SAMPLE/DROP/AGGREGATE totals from S5 accounting. */
  countScope: 'retained_events';
  exactCount: number;
  historicalWindows: number;
  firstSeenAt: number;
  lastSeenAt: number;
  review: UnknownClusterReview;
  clusters: UnknownCluster[];
}

export interface UnknownLearningIngestResult {
  skippedDisabledEvents: number;
  observedUnknownEvents: number;
  clusteredEvents: number;
  duplicateEvents: number;
  rejectedWithoutReason: number;
  rejectedWithoutStableScope: number;
  rejectedInvalidEvent: number;
  rejectedUnsafeIdentity: number;
  rejectedFutureEvent: number;
  rejectedDedupeCapacity: number;
  rejectedExpiredWindow: number;
  overflowEvents: number;
  activeClusters: number;
  activeFamilies: number;
  watermarkMs: number;
  degraded: boolean;
}

export interface UnknownLearningStatus {
  enabled: boolean;
  activeClusters: number;
  activeFamilies: number;
  reviews: number;
  policies: number;
  activePolicies: number;
  dedupeEntries: number;
  watermarkMs: number;
  totals: {
    observedUnknownEvents: number;
    clusteredEvents: number;
    duplicateEvents: number;
    rejectedEvents: number;
    overflowEvents: number;
  };
}

export interface UnknownPolicyRecommendation {
  policyId: string;
  revision: number;
  familyId: string;
  action: UnknownLearnedAction;
  authority: 'recommendation_only';
  authoritativeDrop: false;
  eligibleForCentralReview: true;
}

interface NormalizedOptions {
  enabled: boolean;
  windowMs: number;
  retentionWindows: number;
  maxClusters: number;
  maxFamilies: number;
  maxReviews: number;
  maxPolicies: number;
  maxDedupeEntries: number;
  maxIngestBatch: number;
  maxFutureSkewMs: number;
  firstSamples: number;
  reservoirSamples: number;
  maxStateBytes: number;
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Number(value)));
}

function timestamp(value: number | undefined): number {
  const at = value ?? Date.now();
  if (!Number.isSafeInteger(at) || at < 0) throw new Error('time must be a non-negative safe integer');
  return at;
}

function boundedText(value: string, limit: number, label: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > limit || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error(`a bounded ${label} is required`);
  }
  return normalized;
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function eventIdHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeAdd(left: number, right: number, label: string): number {
  if (!Number.isSafeInteger(left) || left < 0 || !Number.isSafeInteger(right) || right < 0 ||
      left > Number.MAX_SAFE_INTEGER - right) {
    throw new Error(`${label} exceeds the safe integer range`);
  }
  return left + right;
}

function normalizeOptions(options: UnknownLearningServiceOptions): NormalizedOptions {
  const maxClusters = boundedInteger(options.maxClusters, 10_000, 1, 100_000);
  return {
    enabled: options.enabled !== false,
    windowMs: boundedInteger(options.windowMs, 5 * 60_000, 60_000, 60 * 60_000),
    retentionWindows: boundedInteger(options.retentionWindows, 12, 2, 288),
    maxClusters,
    maxFamilies: boundedInteger(options.maxFamilies, Math.min(maxClusters, 5_000), 1, maxClusters),
    maxReviews: boundedInteger(options.maxReviews, 10_000, 1, 100_000),
    maxPolicies: boundedInteger(options.maxPolicies, 2_000, 1, 20_000),
    maxDedupeEntries: boundedInteger(options.maxDedupeEntries, 100_000, 1, 1_000_000),
    maxIngestBatch: boundedInteger(options.maxIngestBatch, 20_000, 1, 100_000),
    maxFutureSkewMs: boundedInteger(options.maxFutureSkewMs, 5 * 60_000, 0, 24 * 60 * 60_000),
    firstSamples: boundedInteger(options.firstSamples, 3, 1, 16),
    reservoirSamples: boundedInteger(options.reservoirSamples, 8, 1, 32),
    maxStateBytes: boundedInteger(options.maxStateBytes, 64 * 1024 * 1024, 64 * 1024, 256 * 1024 * 1024),
  };
}

function closedRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const record = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unknown field ${key}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(record, key)) throw new Error(`${label} is missing field ${key}`);
  }
  return record;
}

function arrayValue(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function nonNegativeSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${label} must be a non-negative safe integer`);
  return Number(value);
}

function validateSampleClosed(value: unknown, label: string): void {
  const sample = closedRecord(value, ['eventId', 'at', 'subject', 'targetBucket'], ['process'], label);
  if (sample.process !== undefined) {
    closedRecord(sample.process, [], ['pid', 'comm', 'exe'], `${label}.process`);
  }
}

function validateClusterClosed(value: unknown, label: string): UnknownCluster {
  const cluster = closedRecord(value, [
    'schemaVersion', 'familyId', 'clusterId', 'stableScope', 'unknownReason', 'eventKind', 'targetBucket',
    'windowStartMs', 'windowEndMs', 'countScope', 'exactCount', 'firstSamples', 'reservoirSamples', 'metadataCompleteness',
    'review', 'firstSeenAt', 'lastSeenAt',
  ], [], label);
  closedRecord(cluster.metadataCompleteness, [
    'processIdentity', 'processAncestry', 'workloadIdentity', 'containerIdentity',
  ], [], `${label}.metadataCompleteness`);
  arrayValue(cluster.firstSamples, `${label}.firstSamples`).forEach((sample, index) =>
    validateSampleClosed(sample, `${label}.firstSamples[${index}]`));
  arrayValue(cluster.reservoirSamples, `${label}.reservoirSamples`).forEach((sample, index) =>
    validateSampleClosed(sample, `${label}.reservoirSamples[${index}]`));
  validateUnknownCluster(cluster as unknown as UnknownCluster);
  return cluster as unknown as UnknownCluster;
}

function validateReviewClosed(value: unknown, label: string): UnknownFamilyReviewRecord {
  const review = closedRecord(value, [
    'familyId', 'decision', 'revision', 'actor', 'reason', 'reviewedAt',
  ], [], label);
  if (!/^ufam_[a-f0-9]{24}$/u.test(String(review.familyId)) ||
      !['agent', 'non_agent', 'deferred'].includes(String(review.decision)) ||
      !Number.isSafeInteger(review.revision) || Number(review.revision) <= 0) {
    throw new Error(`${label} is invalid`);
  }
  boundedText(review.actor as string, 240, 'review actor');
  boundedText(review.reason as string, 500, 'review reason');
  nonNegativeSafeInteger(review.reviewedAt, `${label}.reviewedAt`);
  return review as unknown as UnknownFamilyReviewRecord;
}

function validatePolicyClosed(value: unknown, label: string): UnknownPolicyCandidate {
  const policy = closedRecord(value, [
    'schemaVersion', 'policyId', 'revision', 'familyId', 'clusterId', 'stage', 'desiredAction', 'authority',
    'authoritativeDrop', 'createdAt', 'updatedAt', 'createdBy', 'evidence', 'audit',
  ], [], label);
  const evidence = closedRecord(policy.evidence, [
    'reviewRevision', 'countScope', 'clusterCount', 'historicalWindows',
  ], [
    'replayEvents', 'replayAgentConflicts', 'canaryScope', 'canaryEvents', 'canaryAgentRecall',
    'canaryCriticalDrops',
  ], `${label}.evidence`);
  if (evidence.canaryScope !== undefined) {
    closedRecord(evidence.canaryScope, ['kind', 'valueHash'], [], `${label}.evidence.canaryScope`);
  }
  arrayValue(policy.audit, `${label}.audit`).forEach((entry, index) =>
    closedRecord(entry, ['at', 'to', 'actor', 'reason'], ['from'], `${label}.audit[${index}]`));
  validateUnknownPolicyCandidate(policy as unknown as UnknownPolicyCandidate);
  return policy as unknown as UnknownPolicyCandidate;
}

function boundedJsonInput(value: unknown, maxBytes: number): unknown {
  let parsed = value;
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > maxBytes) throw new Error('Unknown learning state exceeds the byte limit');
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      throw new Error('Unknown learning state is not valid JSON');
    }
  }
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(parsed);
  } catch {
    throw new Error('Unknown learning state is not JSON serializable');
  }
  if (!serialized) throw new Error('Unknown learning state is not a JSON value');
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) throw new Error('Unknown learning state exceeds the byte limit');
  return parsed;
}

function jsonCloneBounded<T>(value: T, maxBytes: number): T {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error('Unknown learning state is not JSON serializable');
  }
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) throw new Error('Unknown learning state exceeds the byte limit');
  return JSON.parse(serialized) as T;
}

/**
 * Bounded in-memory S8 workflow core. It intentionally has no Nest lifecycle,
 * controller, persistence, or capture-control dependency.
 */
export class UnknownLearningService {
  private readonly options: NormalizedOptions;
  private readonly clusters = new Map<string, UnknownCluster>();
  private readonly reviews = new Map<string, UnknownFamilyReviewRecord>();
  private readonly policies = new Map<string, UnknownPolicyCandidate>();
  private readonly seenEventIds = new Map<string, number>();
  private enabled: boolean;
  private watermarkMs = 0;
  private totals = {
    observedUnknownEvents: 0,
    clusteredEvents: 0,
    duplicateEvents: 0,
    rejectedEvents: 0,
    overflowEvents: 0,
  };

  constructor(options: UnknownLearningServiceOptions = {}) {
    this.options = normalizeOptions(options);
    this.enabled = this.options.enabled;
  }

  ingest(events: readonly JudgedEvent[], observedAtInput?: number): UnknownLearningIngestResult {
    if (!this.enabled) {
      return {
        skippedDisabledEvents: events.length,
        observedUnknownEvents: 0,
        clusteredEvents: 0,
        duplicateEvents: 0,
        rejectedWithoutReason: 0,
        rejectedWithoutStableScope: 0,
        rejectedInvalidEvent: 0,
        rejectedUnsafeIdentity: 0,
        rejectedFutureEvent: 0,
        rejectedDedupeCapacity: 0,
        rejectedExpiredWindow: 0,
        overflowEvents: 0,
        activeClusters: this.clusters.size,
        activeFamilies: this.activeFamilyIds().size,
        watermarkMs: this.watermarkMs,
        degraded: false,
      };
    }
    if (events.length > this.options.maxIngestBatch) {
      throw new Error(`Unknown learning ingest batch exceeds ${this.options.maxIngestBatch} events`);
    }
    const observedAt = timestamp(observedAtInput);
    const accepted: JudgedEvent[] = [];
    let duplicateEvents = 0;
    let rejectedFutureEvent = 0;
    let rejectedDedupeCapacity = 0;
    let proposedWatermark = this.watermarkMs;

    // Advance the bounded event-time horizon before dedupe admission so a full
    // dedupe table cannot prevent its own expired entries from being reclaimed.
    for (const event of events) {
      if (isUnknownLearningCandidate(event) && Number.isSafeInteger(event.at) && event.at >= 0 &&
          event.at <= observedAt + this.options.maxFutureSkewMs) {
        proposedWatermark = Math.max(proposedWatermark, event.at);
      }
    }
    this.watermarkMs = proposedWatermark;
    this.prune();
    for (const event of events) {
      if (!Number.isSafeInteger(event.at) || event.at < 0 || event.at > observedAt + this.options.maxFutureSkewMs) {
        rejectedFutureEvent += 1;
        continue;
      }
      if (!isUnknownLearningCandidate(event)) {
        // Keep it in the builder input so actionable rejection counters (unsafe identity,
        // missing scope/reason, invalid event) remain observable, but do not spend dedupe
        // capacity or advance the retained Unknown event-time horizon.
        accepted.push(event);
        continue;
      }
      const eventId = typeof event.eventId === 'string' && event.eventId.trim().length <= 512
        ? event.eventId.trim()
        : '';
      if (!eventId) {
        accepted.push(event);
        continue;
      }
      const dedupeKey = eventIdHash(eventId);
      if (this.seenEventIds.has(dedupeKey)) {
        duplicateEvents += 1;
        continue;
      }
      if (this.seenEventIds.size >= this.options.maxDedupeEntries) {
        // Reject rather than silently losing exact-once counting when dedupe state is saturated.
        rejectedDedupeCapacity += 1;
        continue;
      }
      this.seenEventIds.set(dedupeKey, event.at);
      accepted.push(event);
    }

    const reviews = Object.fromEntries([...this.reviews].map(([familyId, review]) => [familyId, review.decision]));
    const built = buildUnknownClusters(accepted, {
      windowMs: this.options.windowMs,
      // Let the service perform state-aware admission (existing windows first).
      // The pure builder remains bounded by this already-bounded input batch.
      maxClusters: Math.max(this.options.maxClusters, accepted.length),
      maxEvents: this.options.maxIngestBatch,
      firstSamples: this.options.firstSamples,
      reservoirSamples: this.options.reservoirSamples,
      reviews,
    });
    const cutoff = this.retentionCutoff();
    let rejectedExpiredWindow = 0;
    let overflowEvents = built.overflowEvents;
    let clusteredEvents = 0;
    const families = this.activeFamilyIds();

    const prioritizedClusters = [...built.clusters].sort((left, right) =>
      Number(this.clusters.has(right.clusterId)) - Number(this.clusters.has(left.clusterId)) ||
      compareAscii(left.clusterId, right.clusterId));
    for (const incoming of prioritizedClusters) {
      if (incoming.windowEndMs <= cutoff) {
        rejectedExpiredWindow = safeAdd(rejectedExpiredWindow, incoming.exactCount, 'expired-window counter');
        continue;
      }
      const current = this.clusters.get(incoming.clusterId);
      if (current) {
        const merged = mergeUnknownClusters(current, incoming, {
          firstSamples: this.options.firstSamples,
          reservoirSamples: this.options.reservoirSamples,
        });
        merged.review = this.reviews.get(merged.familyId)?.decision ?? 'unreviewed';
        this.clusters.set(merged.clusterId, merged);
        clusteredEvents = safeAdd(clusteredEvents, incoming.exactCount, 'clustered-event counter');
        continue;
      }
      if (this.clusters.size >= this.options.maxClusters ||
          (!families.has(incoming.familyId) && families.size >= this.options.maxFamilies)) {
        overflowEvents = safeAdd(overflowEvents, incoming.exactCount, 'overflow counter');
        continue;
      }
      incoming.review = this.reviews.get(incoming.familyId)?.decision ?? 'unreviewed';
      this.clusters.set(incoming.clusterId, clone(incoming));
      families.add(incoming.familyId);
      clusteredEvents = safeAdd(clusteredEvents, incoming.exactCount, 'clustered-event counter');
    }

    const rejectedEvents = built.rejectedWithoutReason + built.rejectedWithoutStableScope +
      built.rejectedInvalidEvent + built.rejectedUnsafeIdentity + rejectedFutureEvent +
      rejectedDedupeCapacity + rejectedExpiredWindow;
    this.totals = {
      observedUnknownEvents: safeAdd(this.totals.observedUnknownEvents, built.observedUnknownEvents, 'observed counter'),
      clusteredEvents: safeAdd(this.totals.clusteredEvents, clusteredEvents, 'clustered total'),
      duplicateEvents: safeAdd(this.totals.duplicateEvents, duplicateEvents, 'duplicate total'),
      rejectedEvents: safeAdd(this.totals.rejectedEvents, rejectedEvents, 'rejected total'),
      overflowEvents: safeAdd(this.totals.overflowEvents, overflowEvents, 'overflow total'),
    };
    return {
      skippedDisabledEvents: 0,
      observedUnknownEvents: built.observedUnknownEvents,
      clusteredEvents,
      duplicateEvents,
      rejectedWithoutReason: built.rejectedWithoutReason,
      rejectedWithoutStableScope: built.rejectedWithoutStableScope,
      rejectedInvalidEvent: built.rejectedInvalidEvent,
      rejectedUnsafeIdentity: built.rejectedUnsafeIdentity,
      rejectedFutureEvent,
      rejectedDedupeCapacity,
      rejectedExpiredWindow,
      overflowEvents,
      activeClusters: this.clusters.size,
      activeFamilies: families.size,
      watermarkMs: this.watermarkMs,
      degraded: rejectedDedupeCapacity > 0 || overflowEvents > 0,
    };
  }

  listClusters(): UnknownCluster[] {
    return [...this.clusters.values()]
      .map((cluster) => ({ ...clone(cluster), review: this.reviewFor(cluster.familyId) }))
      .sort((left, right) => right.exactCount - left.exactCount || compareAscii(left.clusterId, right.clusterId));
  }

  listFamilies(): UnknownFamilySnapshot[] {
    const grouped = new Map<string, UnknownCluster[]>();
    for (const cluster of this.clusters.values()) {
      const list = grouped.get(cluster.familyId) ?? [];
      list.push(cluster);
      grouped.set(cluster.familyId, list);
    }
    return [...grouped].map(([familyId, familyClusters]) => {
      familyClusters.sort((left, right) => left.windowStartMs - right.windowStartMs || compareAscii(left.clusterId, right.clusterId));
      const first = familyClusters[0]!;
      return {
        familyId,
        stableScope: first.stableScope,
        unknownReason: first.unknownReason,
        eventKind: first.eventKind,
        targetBucket: first.targetBucket,
        countScope: 'retained_events' as const,
        exactCount: familyClusters.reduce((sum, cluster) => safeAdd(sum, cluster.exactCount, 'family count'), 0),
        historicalWindows: familyClusters.length,
        firstSeenAt: Math.min(...familyClusters.map((cluster) => cluster.firstSeenAt)),
        lastSeenAt: Math.max(...familyClusters.map((cluster) => cluster.lastSeenAt)),
        review: this.reviewFor(familyId),
        clusters: clone(familyClusters),
      };
    }).sort((left, right) => right.exactCount - left.exactCount || compareAscii(left.familyId, right.familyId));
  }

  getFamily(familyId: string): UnknownFamilySnapshot | undefined {
    const normalized = boundedText(familyId, 128, 'family ID');
    const family = this.listFamilies().find((item) => item.familyId === normalized);
    return family ? clone(family) : undefined;
  }

  getFamilyReview(familyId: string): UnknownFamilyReviewRecord | undefined {
    const normalized = boundedText(familyId, 128, 'family ID');
    const review = this.reviews.get(normalized);
    return review ? clone(review) : undefined;
  }

  reviewFamily(input: {
    familyId: string;
    decision: Exclude<UnknownClusterReview, 'unreviewed'>;
    actor: string;
    reason: string;
    expectedRevision: number;
    at?: number;
  }): UnknownFamilyReviewRecord {
    this.assertEnabled();
    const familyId = boundedText(input.familyId, 128, 'family ID');
    if (!['agent', 'non_agent', 'deferred'].includes(input.decision)) throw new Error('invalid Unknown family review');
    if (!this.activeFamilyIds().has(familyId)) throw new Error('Unknown family does not exist');
    const current = this.reviews.get(familyId);
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 ||
        input.expectedRevision !== (current?.revision ?? 0)) {
      throw new Error(`Unknown review revision conflict: expected ${input.expectedRevision}, current ${current?.revision ?? 0}`);
    }
    if (!current && this.reviews.size >= this.options.maxReviews) throw new Error('Unknown review capacity is exhausted');
    const at = timestamp(input.at);
    if (current && at < current.reviewedAt) throw new Error('review time must be monotonic');
    const next: UnknownFamilyReviewRecord = {
      familyId,
      decision: input.decision,
      revision: (current?.revision ?? 0) + 1,
      actor: boundedText(input.actor, 240, 'actor'),
      reason: boundedText(input.reason, 500, 'review reason'),
      reviewedAt: at,
    };

    // Pre-compute all safety rollbacks before mutating review state.
    const rollbacks = new Map<string, UnknownPolicyCandidate>();
    if (current || input.decision !== 'non_agent') {
      for (const policy of this.policies.values()) {
        if (policy.familyId !== familyId || policy.stage === 'rolled_back') continue;
        rollbacks.set(policy.policyId, transitionUnknownPolicy(policy, {
          to: 'rolled_back',
          actor: next.actor,
          reason: `family review revision changed to ${input.decision}`,
          at: Math.max(at, policy.updatedAt),
        }));
      }
    }
    this.reviews.set(familyId, next);
    for (const [policyId, policy] of rollbacks) this.policies.set(policyId, policy);
    for (const cluster of this.clusters.values()) {
      if (cluster.familyId === familyId) cluster.review = input.decision;
    }
    return clone(next);
  }

  createCandidate(input: {
    familyId: string;
    desiredAction: UnknownLearnedAction;
    actor: string;
    reason: string;
    at?: number;
  }): UnknownPolicyCandidate {
    this.assertEnabled();
    if (this.policies.size >= this.options.maxPolicies) throw new Error('Unknown policy capacity is exhausted');
    const family = this.listFamilies().find((item) => item.familyId === input.familyId);
    if (!family) throw new Error('Unknown family does not exist');
    if (family.review !== 'non_agent') throw new Error('Unknown family requires a current non-Agent review');
    const review = this.reviews.get(family.familyId)!;
    const at = timestamp(input.at);
    if (at < review.reviewedAt) throw new Error('candidate time cannot precede its human review');
    if ([...this.policies.values()].some((policy) => policy.familyId === family.familyId && policy.stage !== 'rolled_back')) {
      throw new Error('Unknown family already has an active policy workflow');
    }
    const anchor = clone(family.clusters[family.clusters.length - 1]!);
    anchor.review = 'non_agent';
    const policy = createUnknownPolicyCandidate({
      cluster: anchor,
      desiredAction: input.desiredAction,
      actor: input.actor,
      reason: input.reason,
      at,
      clusterCount: family.exactCount,
      historicalWindows: family.historicalWindows,
      reviewRevision: review.revision,
    });
    if (this.policies.has(policy.policyId)) throw new Error('Unknown policy ID collision');
    this.policies.set(policy.policyId, clone(policy));
    return clone(policy);
  }

  beginShadow(policyId: string, expectedRevision: number, input: { actor: string; reason: string; at?: number }): UnknownPolicyCandidate {
    return this.advance(policyId, expectedRevision, { ...input, to: 'shadow' });
  }

  validateReplay(policyId: string, expectedRevision: number, input: {
    actor: string;
    reason: string;
    replayEvents: number;
    replayAgentConflicts: number;
    at?: number;
  }): UnknownPolicyCandidate {
    return this.advance(policyId, expectedRevision, { ...input, to: 'replay_validated' });
  }

  beginCanary(policyId: string, expectedRevision: number, input: {
    actor: string;
    reason: string;
    scope: { kind: UnknownCanaryScopeKind; value: string };
    at?: number;
  }): UnknownPolicyCandidate {
    return this.advance(policyId, expectedRevision, { ...input, to: 'canary', canaryScope: input.scope });
  }

  enforceRecommendation(policyId: string, expectedRevision: number, input: {
    actor: string;
    reason: string;
    canaryEvents: number;
    canaryAgentRecall: number;
    canaryCriticalDrops: number;
    at?: number;
  }): UnknownPolicyCandidate {
    return this.advance(policyId, expectedRevision, { ...input, to: 'enforced' });
  }

  rollback(policyId: string, expectedRevision: number, input: { actor: string; reason: string; at?: number }): UnknownPolicyCandidate {
    return this.advance(policyId, expectedRevision, { ...input, to: 'rolled_back' }, true);
  }

  getPolicy(policyId: string): UnknownPolicyCandidate | undefined {
    const policy = this.policies.get(policyId);
    return policy ? clone(policy) : undefined;
  }

  listPolicies(): UnknownPolicyCandidate[] {
    return [...this.policies.values()].map(clone).sort((left, right) => right.updatedAt - left.updatedAt || compareAscii(left.policyId, right.policyId));
  }

  listRecommendations(): UnknownPolicyRecommendation[] {
    if (!this.enabled) return [];
    return [...this.policies.values()]
      .filter((policy) => policy.stage === 'enforced')
      .map((policy) => ({
        policyId: policy.policyId,
        revision: policy.revision,
        familyId: policy.familyId,
        action: policy.desiredAction,
        authority: 'recommendation_only' as const,
        authoritativeDrop: false as const,
        eligibleForCentralReview: true as const,
      }))
      .sort((left, right) => compareAscii(left.policyId, right.policyId));
  }

  exportState(exportedAtInput?: number): UnknownLearningStateV1 {
    const exportedAt = timestamp(exportedAtInput);
    let latestMutation = 0;
    for (const review of this.reviews.values()) latestMutation = Math.max(latestMutation, review.reviewedAt);
    for (const policy of this.policies.values()) latestMutation = Math.max(latestMutation, policy.updatedAt);
    if (exportedAt < latestMutation) throw new Error('state export time cannot precede review or policy mutations');
    const state: UnknownLearningStateV1 = {
      schemaVersion: UNKNOWN_LEARNING_STATE_SCHEMA_VERSION,
      exportedAt,
      enabled: this.enabled,
      watermarkMs: this.watermarkMs,
      clustering: {
        windowMs: this.options.windowMs,
        firstSamples: this.options.firstSamples,
        reservoirSamples: this.options.reservoirSamples,
      },
      clusters: this.listClusters().sort((left, right) => compareAscii(left.clusterId, right.clusterId)),
      reviews: [...this.reviews.values()].map(clone).sort((left, right) => compareAscii(left.familyId, right.familyId)),
      policies: [...this.policies.values()].map(clone).sort((left, right) => compareAscii(left.policyId, right.policyId)),
      dedupe: {
        semantics: UNKNOWN_LEARNING_DEDUPE_SEMANTICS,
        entries: [...this.seenEventIds]
          .map(([eventIdHashValue, eventAt]) => ({ eventIdHash: eventIdHashValue, eventAt }))
          .sort((left, right) => left.eventAt - right.eventAt || compareAscii(left.eventIdHash, right.eventIdHash)),
      },
      totals: clone(this.totals),
    };
    return jsonCloneBounded(state, this.options.maxStateBytes);
  }

  restoreState(input: unknown): UnknownLearningRestoreResult {
    const raw = boundedJsonInput(input, this.options.maxStateBytes);
    const state = closedRecord(raw, [
      'schemaVersion', 'exportedAt', 'enabled', 'watermarkMs', 'clustering', 'clusters', 'reviews',
      'policies', 'dedupe', 'totals',
    ], [], 'Unknown learning state');
    if (state.schemaVersion !== UNKNOWN_LEARNING_STATE_SCHEMA_VERSION) throw new Error('unsupported Unknown learning state schema');
    const exportedAt = nonNegativeSafeInteger(state.exportedAt, 'state.exportedAt');
    const watermarkMs = nonNegativeSafeInteger(state.watermarkMs, 'state.watermarkMs');
    if (typeof state.enabled !== 'boolean') throw new Error('state.enabled must be boolean');
    // Restore is monotonic toward safety: neither persisted state nor restore may
    // silently turn off an already-active local kill switch.
    const restoredEnabled = this.enabled && state.enabled;
    const clustering = closedRecord(state.clustering, [
      'windowMs', 'firstSamples', 'reservoirSamples',
    ], [], 'state.clustering');
    if (clustering.windowMs !== this.options.windowMs ||
        clustering.firstSamples !== this.options.firstSamples ||
        clustering.reservoirSamples !== this.options.reservoirSamples) {
      throw new Error('Unknown learning clustering contract does not match this service');
    }

    const totalsRecord = closedRecord(state.totals, [
      'observedUnknownEvents', 'clusteredEvents', 'duplicateEvents', 'rejectedEvents', 'overflowEvents',
    ], [], 'state.totals');
    const restoredTotals = {
      observedUnknownEvents: nonNegativeSafeInteger(totalsRecord.observedUnknownEvents, 'state.totals.observedUnknownEvents'),
      clusteredEvents: nonNegativeSafeInteger(totalsRecord.clusteredEvents, 'state.totals.clusteredEvents'),
      duplicateEvents: nonNegativeSafeInteger(totalsRecord.duplicateEvents, 'state.totals.duplicateEvents'),
      rejectedEvents: nonNegativeSafeInteger(totalsRecord.rejectedEvents, 'state.totals.rejectedEvents'),
      overflowEvents: nonNegativeSafeInteger(totalsRecord.overflowEvents, 'state.totals.overflowEvents'),
    };
    const dedupeRecord = closedRecord(state.dedupe, ['semantics', 'entries'], [], 'state.dedupe');
    if (dedupeRecord.semantics !== UNKNOWN_LEARNING_DEDUPE_SEMANTICS) throw new Error('unsupported Unknown dedupe semantics');

    const reviews = arrayValue(state.reviews, 'state.reviews').map((review, index) =>
      validateReviewClosed(review, `state.reviews[${index}]`));
    const originalReviews = new Map<string, UnknownFamilyReviewRecord>();
    for (const review of reviews) {
      if (originalReviews.has(review.familyId)) throw new Error(`duplicate Unknown review ${review.familyId}`);
      if (review.reviewedAt > exportedAt) throw new Error('Unknown review occurs after state export');
      originalReviews.set(review.familyId, review);
    }

    const policies = arrayValue(state.policies, 'state.policies').map((policy, index) =>
      validatePolicyClosed(policy, `state.policies[${index}]`));
    const policyIds = new Set<string>();
    const activeFamilies = new Set<string>();
    for (const policy of policies) {
      if (policyIds.has(policy.policyId)) throw new Error(`duplicate Unknown policy ${policy.policyId}`);
      policyIds.add(policy.policyId);
      if (policy.updatedAt > exportedAt) throw new Error('Unknown policy occurs after state export');
      if (policy.stage === 'rolled_back') continue;
      if (state.enabled === false) throw new Error('disabled Unknown state cannot contain an active policy');
      const review = originalReviews.get(policy.familyId);
      if (!review || review.decision !== 'non_agent' || review.revision !== policy.evidence.reviewRevision) {
        throw new Error('active Unknown policy is not backed by a current non-Agent review');
      }
      if (activeFamilies.has(policy.familyId)) throw new Error('Unknown family has multiple active policies');
      activeFamilies.add(policy.familyId);
    }

    const clusters = arrayValue(state.clusters, 'state.clusters').map((cluster, index) =>
      validateClusterClosed(cluster, `state.clusters[${index}]`));
    const clusterIds = new Set<string>();
    for (const cluster of clusters) {
      if (clusterIds.has(cluster.clusterId)) throw new Error(`duplicate Unknown cluster ${cluster.clusterId}`);
      clusterIds.add(cluster.clusterId);
      if (cluster.lastSeenAt > watermarkMs) throw new Error('Unknown cluster is newer than the state watermark');
      if (cluster.windowEndMs - cluster.windowStartMs !== this.options.windowMs ||
          cluster.windowStartMs % this.options.windowMs !== 0) {
        throw new Error('Unknown cluster does not use the configured fixed UTC window');
      }
      const expectedReview = originalReviews.get(cluster.familyId)?.decision ?? 'unreviewed';
      if (cluster.review !== expectedReview) throw new Error('Unknown cluster review does not match the family review record');
    }
    const clustersById = new Map(clusters.map((cluster) => [cluster.clusterId, cluster]));
    for (const policy of policies) {
      const anchor = clustersById.get(policy.clusterId);
      if (anchor && anchor.familyId !== policy.familyId) throw new Error('Unknown policy anchor belongs to another family');
    }

    const dedupeEntries = arrayValue(dedupeRecord.entries, 'state.dedupe.entries').map((entry, index) => {
      const record = closedRecord(entry, ['eventIdHash', 'eventAt'], [], `state.dedupe.entries[${index}]`);
      if (!/^[a-f0-9]{64}$/u.test(String(record.eventIdHash))) throw new Error('invalid Unknown dedupe event hash');
      const eventAt = nonNegativeSafeInteger(record.eventAt, `state.dedupe.entries[${index}].eventAt`);
      if (eventAt > watermarkMs) throw new Error('Unknown dedupe entry is newer than the state watermark');
      return { eventIdHash: String(record.eventIdHash), eventAt };
    });
    const dedupeIds = new Set<string>();
    for (const entry of dedupeEntries) {
      if (dedupeIds.has(entry.eventIdHash)) throw new Error(`duplicate Unknown dedupe hash ${entry.eventIdHash}`);
      dedupeIds.add(entry.eventIdHash);
    }
    const activeExactCount = clusters.reduce((sum, cluster) => safeAdd(sum, cluster.exactCount, 'restored active count'), 0);
    if (restoredTotals.clusteredEvents < activeExactCount ||
        restoredTotals.observedUnknownEvents < restoredTotals.clusteredEvents) {
      throw new Error('Unknown learning totals do not cover the restored exact counts');
    }

    const cutoff = Math.max(0, watermarkMs - this.options.retentionWindows * this.options.windowMs);
    const eligibleClusters = clusters
      .filter((cluster) => cluster.windowEndMs > cutoff)
      .sort((left, right) => right.windowEndMs - left.windowEndMs || right.exactCount - left.exactCount ||
        compareAscii(left.clusterId, right.clusterId));
    const selectedClusters = new Map<string, UnknownCluster>();
    const selectedFamilies = new Set<string>();
    let capacityClusters = 0;
    for (const cluster of eligibleClusters) {
      if (selectedClusters.size >= this.options.maxClusters ||
          (!selectedFamilies.has(cluster.familyId) && selectedFamilies.size >= this.options.maxFamilies)) {
        capacityClusters += 1;
        continue;
      }
      selectedClusters.set(cluster.clusterId, clone(cluster));
      selectedFamilies.add(cluster.familyId);
    }

    const policyOrder = [...policies].sort((left, right) =>
      Number(right.stage !== 'rolled_back') - Number(left.stage !== 'rolled_back') ||
      right.updatedAt - left.updatedAt || compareAscii(left.policyId, right.policyId));
    const initiallySelectedPolicies = policyOrder.slice(0, this.options.maxPolicies);
    const activeReviewRank = new Map<string, number>();
    for (const policy of initiallySelectedPolicies) {
      if (policy.stage !== 'rolled_back' && !activeReviewRank.has(policy.familyId)) {
        activeReviewRank.set(policy.familyId, activeReviewRank.size);
      }
    }
    const reviewOrder = [...reviews].sort((left, right) => {
      const leftRank = activeReviewRank.get(left.familyId);
      const rightRank = activeReviewRank.get(right.familyId);
      if (leftRank !== undefined || rightRank !== undefined) {
        if (leftRank === undefined) return 1;
        if (rightRank === undefined) return -1;
        if (leftRank !== rightRank) return leftRank - rightRank;
      }
      const clusterPriority = Number(selectedFamilies.has(right.familyId)) - Number(selectedFamilies.has(left.familyId));
      return clusterPriority || right.reviewedAt - left.reviewedAt || compareAscii(left.familyId, right.familyId);
    });
    const selectedReviews = new Map(
      reviewOrder.slice(0, this.options.maxReviews).map((review) => [review.familyId, clone(review)]),
    );
    const selectedPolicies = new Map<string, UnknownPolicyCandidate>();
    for (const policy of initiallySelectedPolicies) {
      if (!restoredEnabled && policy.stage !== 'rolled_back') continue;
      if (policy.stage !== 'rolled_back') {
        const review = selectedReviews.get(policy.familyId);
        if (!review || review.decision !== 'non_agent' || review.revision !== policy.evidence.reviewRevision) continue;
      }
      selectedPolicies.set(policy.policyId, clone(policy));
    }
    for (const cluster of selectedClusters.values()) {
      cluster.review = selectedReviews.get(cluster.familyId)?.decision ?? 'unreviewed';
    }

    const selectedDedupe = new Map<string, number>();
    for (const entry of [...dedupeEntries]
      .filter((entry) => entry.eventAt >= cutoff)
      .sort((left, right) => right.eventAt - left.eventAt || compareAscii(left.eventIdHash, right.eventIdHash))
      .slice(0, this.options.maxDedupeEntries)) {
      selectedDedupe.set(entry.eventIdHash, entry.eventAt);
    }

    // Atomic replacement only after every byte, field, invariant, and relationship has passed validation.
    this.clusters.clear();
    for (const [clusterId, cluster] of selectedClusters) this.clusters.set(clusterId, cluster);
    this.reviews.clear();
    for (const [familyId, review] of selectedReviews) this.reviews.set(familyId, review);
    this.policies.clear();
    for (const [policyId, policy] of selectedPolicies) this.policies.set(policyId, policy);
    this.seenEventIds.clear();
    for (const [eventIdHashValue, eventAt] of selectedDedupe) this.seenEventIds.set(eventIdHashValue, eventAt);
    this.watermarkMs = watermarkMs;
    this.enabled = restoredEnabled;
    this.totals = restoredTotals;

    return {
      status: this.status(),
      pruned: {
        expiredClusters: clusters.length - eligibleClusters.length,
        capacityClusters,
        reviews: reviews.length - selectedReviews.size,
        policies: policies.length - selectedPolicies.size,
        dedupeEntries: dedupeEntries.length - selectedDedupe.size,
      },
    };
  }

  setEnabled(enabled: boolean, input: { actor: string; reason: string; at?: number }): UnknownLearningStatus {
    const actor = boundedText(input.actor, 240, 'actor');
    const reason = boundedText(input.reason, 450, 'kill-switch reason');
    const at = timestamp(input.at);
    if (!enabled) {
      const rollbacks = new Map<string, UnknownPolicyCandidate>();
      for (const policy of this.policies.values()) {
        if (policy.stage === 'rolled_back') continue;
        rollbacks.set(policy.policyId, transitionUnknownPolicy(policy, {
          to: 'rolled_back', actor, reason: `learning kill switch: ${reason}`, at: Math.max(at, policy.updatedAt),
        }));
      }
      for (const [policyId, policy] of rollbacks) this.policies.set(policyId, policy);
    }
    this.enabled = enabled;
    return this.status();
  }

  status(): UnknownLearningStatus {
    const activePolicies = [...this.policies.values()].filter((policy) => policy.stage !== 'rolled_back').length;
    return {
      enabled: this.enabled,
      activeClusters: this.clusters.size,
      activeFamilies: this.activeFamilyIds().size,
      reviews: this.reviews.size,
      policies: this.policies.size,
      activePolicies,
      dedupeEntries: this.seenEventIds.size,
      watermarkMs: this.watermarkMs,
      totals: clone(this.totals),
    };
  }

  private advance(
    policyIdInput: string,
    expectedRevision: number,
    transition: UnknownPolicyTransition,
    allowWhenDisabled = false,
  ): UnknownPolicyCandidate {
    if (!allowWhenDisabled) this.assertEnabled();
    const policyId = boundedText(policyIdInput, 128, 'policy ID');
    const current = this.policies.get(policyId);
    if (!current) throw new Error('Unknown policy does not exist');
    if (!Number.isSafeInteger(expectedRevision) || current.revision !== expectedRevision) {
      throw new Error(`Unknown policy revision conflict: expected ${expectedRevision}, current ${current.revision}`);
    }
    const review = this.reviews.get(current.familyId);
    if (transition.to !== 'rolled_back' &&
        (review?.decision !== 'non_agent' || review.revision !== current.evidence.reviewRevision)) {
      throw new Error('Unknown family no longer has a current non-Agent review');
    }
    const next = transitionUnknownPolicy(current, transition);
    this.policies.set(policyId, clone(next));
    return clone(next);
  }

  private assertEnabled(): void {
    if (!this.enabled) throw new Error('Unknown learning policy workflow is disabled');
  }

  private activeFamilyIds(): Set<string> {
    return new Set([...this.clusters.values()].map((cluster) => cluster.familyId));
  }

  private reviewFor(familyId: string): UnknownClusterReview {
    return this.reviews.get(familyId)?.decision ?? 'unreviewed';
  }

  private retentionCutoff(): number {
    return Math.max(0, this.watermarkMs - this.options.retentionWindows * this.options.windowMs);
  }

  private prune(): void {
    const cutoff = this.retentionCutoff();
    for (const [clusterId, cluster] of this.clusters) {
      if (cluster.windowEndMs <= cutoff) this.clusters.delete(clusterId);
    }
    for (const [eventId, eventAt] of this.seenEventIds) {
      if (eventAt < cutoff) this.seenEventIds.delete(eventId);
    }
  }
}
