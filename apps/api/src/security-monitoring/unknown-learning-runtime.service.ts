import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { SentryJudgeService } from './sentry-judge.service';
import {
  UnknownLearningService,
  type UnknownFamilyReviewRecord,
  type UnknownFamilySnapshot,
  type UnknownLearningIngestResult,
  type UnknownLearningStatus,
  type UnknownPolicyRecommendation,
} from './unknown-learning.service';
import type {
  UnknownCanaryScopeKind,
  UnknownCluster,
  UnknownLearnedAction,
  UnknownPolicyCandidate,
  UnknownPolicyStage,
} from './unknown-learning';
import type { JudgedEvent } from './types';
import type { UnknownInfrastructureRecommendationEvidence } from './infrastructure-rule.types';

function envEnabled(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase());
}

function envInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}

function listLimit(value: number | undefined, fallback: number, maximum: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(maximum, Math.floor(Number(value)))) : fallback;
}

function boundedJsonPrefix<T>(items: T[], maxBytes = 4 * 1024 * 1024): T[] {
  if (Buffer.byteLength(JSON.stringify(items), 'utf8') <= maxBytes) return items;
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(items.slice(0, middle)), 'utf8') <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return items.slice(0, low);
}

function boundedIdentity(value: unknown, limit: number, label: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > limit || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error(`a bounded ${label} is required`);
  }
  return normalized;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function hasLearnableUnknownIdentity(event: JudgedEvent): boolean {
  const eventKind = event.eventKind?.trim().toLowerCase().replace(/[^a-z0-9]+/gu, '');
  if (eventKind === 'captureaggregate' || eventKind === 'systemcontext') return false;
  const semantic = event.classificationSemantics?.identityClassification;
  const attributed = event.attribution?.classification;
  if (semantic === 'confirmed_agent' || semantic === 'probable_agent' || semantic === 'non_agent') return false;
  if (attributed === 'confirmed_agent' || attributed === 'probable_agent' || attributed === 'non_agent') return false;
  const workloadRole = event.classificationSemantics?.workloadRole;
  if (workloadRole === 'anysentry_internal' || workloadRole === 'platform_infrastructure' ||
      workloadRole === 'business_service') return false;
  const isUnknown = semantic === 'unknown' || attributed === 'unknown';
  const reason = event.classificationSemantics?.unknownReason ?? event.process?.lifecycleReason;
  return isUnknown && Boolean(reason);
}

@Injectable()
export class UnknownLearningRuntimeService implements OnModuleInit, OnModuleDestroy {
  private readonly configuredEnabled = envEnabled(process.env.ANYSENTRY_UNKNOWN_LEARNING_ENABLED);
  private readonly persistIntervalMs = envInteger(
    process.env.ANYSENTRY_UNKNOWN_LEARNING_PERSIST_INTERVAL_MS,
    30_000,
    1_000,
    5 * 60_000,
  );
  private readonly core = new UnknownLearningService({
    enabled: this.configuredEnabled,
    windowMs: envInteger(process.env.ANYSENTRY_UNKNOWN_LEARNING_WINDOW_MS, 5 * 60_000, 60_000, 60 * 60_000),
    retentionWindows: envInteger(process.env.ANYSENTRY_UNKNOWN_LEARNING_RETENTION_WINDOWS, 288, 2, 288),
    // Conservative runtime defaults keep the closed worst-case document below the 16 MiB
    // ClickHouse state-row guard. Operators can raise them explicitly; export failure remains
    // fail-closed and observable rather than silently dropping state.
    maxClusters: envInteger(process.env.ANYSENTRY_UNKNOWN_LEARNING_MAX_CLUSTERS, 300, 1, 100_000),
    maxFamilies: envInteger(process.env.ANYSENTRY_UNKNOWN_LEARNING_MAX_FAMILIES, 300, 1, 100_000),
    maxReviews: envInteger(process.env.ANYSENTRY_UNKNOWN_LEARNING_MAX_REVIEWS, 500, 1, 100_000),
    maxPolicies: envInteger(process.env.ANYSENTRY_UNKNOWN_LEARNING_MAX_POLICIES, 75, 1, 20_000),
    maxDedupeEntries: envInteger(process.env.ANYSENTRY_UNKNOWN_LEARNING_MAX_DEDUPE, 10_000, 1, 1_000_000),
    maxIngestBatch: 512,
    maxStateBytes: 16 * 1024 * 1024,
  });
  private persistTimer?: NodeJS.Timeout;
  private persistInFlight?: Promise<boolean>;
  private dirty = false;
  private dirtyRevision = 0;
  private closing = false;
  private restored = false;
  private restoreError?: string;
  private lastPersistedAt?: number;
  private persistenceErrors = 0;

  constructor(private readonly judge: SentryJudgeService) {}

  async onModuleInit(): Promise<void> {
    if (!this.configuredEnabled) return;
    const state = await this.judge.loadUnknownLearningState();
    if (state === undefined) return;
    try {
      this.core.restoreState(state);
      this.restored = true;
    } catch (error) {
      this.restoreError = error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
      // Invalid persisted learning state is untrusted control input. Keep the empty local state and
      // never relax the kill switch or emit recommendations from a partially restored document.
      this.core.setEnabled(false, {
        actor: 'system:unknown-learning-restore',
        reason: 'persisted state rejected',
      });
      console.error('[unknown-learning] persisted state rejected:', this.restoreError);
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.closing = true;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = undefined;
    // A mutation may arrive while an older immutable snapshot is being persisted.
    // Drain that write, then persist the newer dirty revision before shutdown.
    await this.flush();
    if (this.dirty) await this.flush();
  }

  observe(event: JudgedEvent): UnknownLearningIngestResult {
    return this.observeMany([event]);
  }

  /**
   * Ingest one already-durable Observer delivery as a single learning transaction. The Forwarder
   * normally sends up to 256 events per request; evaluating them one-by-one repeatedly rebuilt the
   * complete family set and could outpace V8 garbage collection under host noise.
   */
  observeMany(events: readonly JudgedEvent[]): UnknownLearningIngestResult {
    if (!this.configuredEnabled) {
      const current = this.core.status();
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
        activeClusters: current.activeClusters,
        activeFamilies: current.activeFamilies,
        watermarkMs: current.watermarkMs,
        degraded: false,
      };
    }
    const candidates = events.filter(hasLearnableUnknownIdentity);
    if (candidates.length === 0) {
      const current = this.core.status();
      return {
        skippedDisabledEvents: 0,
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
        activeClusters: current.activeClusters,
        activeFamilies: current.activeFamilies,
        watermarkMs: current.watermarkMs,
        degraded: false,
      };
    }
    const result = this.core.ingest(candidates, Date.now());
    if (
      result.observedUnknownEvents > 0 || result.duplicateEvents > 0 ||
      result.rejectedDedupeCapacity > 0 || result.overflowEvents > 0
    ) {
      this.schedulePersist();
    }
    return result;
  }

  listClusters(limit = 200): UnknownCluster[] {
    return boundedJsonPrefix(this.core.listClusters().slice(0, listLimit(limit, 200, 500)));
  }

  listFamilies(limit = 200): UnknownFamilySnapshot[] {
    return boundedJsonPrefix(this.core.listFamilies()
      .slice(0, listLimit(limit, 100, 100))
      .map((family) => ({ ...family, clusters: family.clusters.slice(-12) })));
  }

  listPolicies(limit = 200): UnknownPolicyCandidate[] {
    return boundedJsonPrefix(this.core.listPolicies().slice(0, listLimit(limit, 200, 500)));
  }

  /** Internal unified-Catalog adapter. The public learning API keeps its 500-row response bound. */
  catalogPolicies(): UnknownPolicyCandidate[] {
    return boundedJsonPrefix(this.core.listPolicies().slice(0, 2_000));
  }

  listRecommendations(): UnknownPolicyRecommendation[] {
    return this.core.listRecommendations();
  }

  /**
   * Validate and fence the S8 side of an explicit Infrastructure draft bridge.
   *
   * This method does not mutate either control plane. It proves that the recommendation is still
   * enforced, is backed by the current human non-Agent review, and completed its canary on the
   * exact physical workload supplied by the management caller.
   */
  authorizeInfrastructureDraft(input: {
    policyId: string;
    expectedPolicyRevision: number;
    expectedReviewRevision: number;
    physicalWorkloadId: string;
  }): UnknownInfrastructureRecommendationEvidence {
    if (!this.core.status().enabled) throw new Error('Unknown learning is disabled');
    const policyId = boundedIdentity(input.policyId, 128, 'Unknown policy ID');
    if (!Number.isSafeInteger(input.expectedPolicyRevision) || input.expectedPolicyRevision <= 0) {
      throw new Error('a positive expected Unknown policy revision is required');
    }
    if (!Number.isSafeInteger(input.expectedReviewRevision) || input.expectedReviewRevision <= 0) {
      throw new Error('a positive expected Unknown review revision is required');
    }
    const policy = this.core.getPolicy(policyId);
    if (!policy) throw new Error('Unknown policy does not exist');
    if (policy.revision !== input.expectedPolicyRevision) {
      throw new Error(`Unknown policy revision conflict: expected ${input.expectedPolicyRevision}, current ${policy.revision}`);
    }
    if (policy.stage !== 'enforced' || policy.authority !== 'recommendation_only' || policy.authoritativeDrop !== false) {
      throw new Error('only an enforced recommendation-only Unknown policy can create an Infrastructure draft');
    }
    const family = this.core.getFamily(policy.familyId);
    const review = this.core.getFamilyReview(policy.familyId);
    if (!family || !review || review.decision !== 'non_agent') {
      throw new Error('Unknown policy is not backed by a current non-Agent family review');
    }
    if (
      review.revision !== input.expectedReviewRevision
      || review.revision !== policy.evidence.reviewRevision
    ) {
      throw new Error(
        `Unknown review revision conflict: expected ${input.expectedReviewRevision}, current ${review.revision}`,
      );
    }
    const physicalWorkloadId = boundedIdentity(input.physicalWorkloadId, 500, 'physical workload ID');
    const physicalWorkloadIdHash = sha256(physicalWorkloadId).slice(0, 32);
    if (family.stableScope !== `workload:${physicalWorkloadIdHash}`) {
      throw new Error('physical workload ID does not match the reviewed Unknown family scope');
    }
    if (
      policy.evidence.canaryScope?.kind !== 'physical_workload'
      || policy.evidence.canaryScope.valueHash !== physicalWorkloadIdHash
    ) {
      throw new Error('Unknown recommendation did not complete canary on this exact physical workload');
    }
    return {
      policyId: policy.policyId,
      policyRevision: policy.revision,
      familyId: policy.familyId,
      clusterId: policy.clusterId,
      reviewRevision: review.revision,
      desiredAction: policy.desiredAction,
      stableScope: family.stableScope,
      eventKind: family.eventKind,
    };
  }

  status(): UnknownLearningStatus & {
    configuredEnabled: boolean;
    restored: boolean;
    restoreError?: string;
    dirty: boolean;
    lastPersistedAt?: string;
    persistenceErrors: number;
    persistenceIntervalMs: number;
  } {
    return {
      ...this.core.status(),
      configuredEnabled: this.configuredEnabled,
      restored: this.restored,
      restoreError: this.restoreError,
      dirty: this.dirty,
      lastPersistedAt: this.lastPersistedAt ? new Date(this.lastPersistedAt).toISOString() : undefined,
      persistenceErrors: this.persistenceErrors,
      persistenceIntervalMs: this.persistIntervalMs,
    };
  }

  reviewFamily(input: {
    familyId: string;
    decision: 'agent' | 'non_agent' | 'deferred';
    actor: string;
    reason: string;
    expectedRevision: number;
  }): UnknownFamilyReviewRecord {
    const result = this.core.reviewFamily(input);
    this.schedulePersist();
    return result;
  }

  createCandidate(input: {
    familyId: string;
    desiredAction: UnknownLearnedAction;
    actor: string;
    reason: string;
  }): UnknownPolicyCandidate {
    const result = this.core.createCandidate(input);
    this.schedulePersist();
    return result;
  }

  transition(input: {
    policyId: string;
    expectedRevision: number;
    to: UnknownPolicyStage;
    actor: string;
    reason: string;
    replayEvents?: number;
    replayAgentConflicts?: number;
    canaryScope?: { kind: UnknownCanaryScopeKind; value: string };
    canaryEvents?: number;
    canaryAgentRecall?: number;
    canaryCriticalDrops?: number;
  }): UnknownPolicyCandidate {
    const common = { actor: input.actor, reason: input.reason };
    let result: UnknownPolicyCandidate;
    if (input.to === 'shadow') {
      result = this.core.beginShadow(input.policyId, input.expectedRevision, common);
    } else if (input.to === 'replay_validated') {
      result = this.core.validateReplay(input.policyId, input.expectedRevision, {
        ...common,
        replayEvents: Number(input.replayEvents),
        replayAgentConflicts: Number(input.replayAgentConflicts),
      });
    } else if (input.to === 'canary') {
      if (!input.canaryScope) throw new Error('a bounded canary scope is required');
      result = this.core.beginCanary(input.policyId, input.expectedRevision, {
        ...common,
        scope: input.canaryScope,
      });
    } else if (input.to === 'enforced') {
      result = this.core.enforceRecommendation(input.policyId, input.expectedRevision, {
        ...common,
        canaryEvents: Number(input.canaryEvents),
        canaryAgentRecall: Number(input.canaryAgentRecall),
        canaryCriticalDrops: Number(input.canaryCriticalDrops),
      });
    } else if (input.to === 'rolled_back') {
      result = this.core.rollback(input.policyId, input.expectedRevision, common);
    } else {
      throw new Error(`unsupported Unknown policy transition to ${input.to}`);
    }
    this.schedulePersist();
    return result;
  }

  setEnabled(enabled: boolean, input: { actor: string; reason: string }): UnknownLearningStatus {
    if (enabled && !this.configuredEnabled) {
      throw new Error('Unknown learning is disabled by the deployment kill switch');
    }
    const status = this.core.setEnabled(enabled, input);
    this.schedulePersist();
    return status;
  }

  private schedulePersist(): void {
    this.dirty = true;
    this.dirtyRevision += 1;
    if (this.closing || this.persistTimer || this.persistInFlight) return;
    const earliestNextPersistAt = (this.lastPersistedAt ?? 0) + this.persistIntervalMs;
    const delayMs = Math.max(1_000, earliestNextPersistAt - Date.now());
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.flush();
    }, delayMs);
    this.persistTimer.unref?.();
  }

  private async flush(): Promise<boolean> {
    if (!this.dirty) return true;
    if (this.persistInFlight) return this.persistInFlight;
    const revision = this.dirtyRevision;
    let snapshot: unknown;
    try {
      snapshot = this.core.exportState();
    } catch (error) {
      this.persistenceErrors += 1;
      console.error('[unknown-learning] state export failed:', error instanceof Error ? error.message : String(error));
      if (!this.closing) this.schedulePersist();
      return false;
    }
    const operation = this.judge.saveUnknownLearningState(snapshot).then((saved) => {
      if (saved && revision === this.dirtyRevision) {
        this.dirty = false;
        this.lastPersistedAt = Date.now();
      } else if (saved) {
        // A newer mutation arrived while this immutable snapshot was in flight.
        this.lastPersistedAt = Date.now();
      } else {
        this.persistenceErrors += 1;
      }
      return saved;
    }).catch((error) => {
      this.persistenceErrors += 1;
      console.error('[unknown-learning] state persistence failed:', error instanceof Error ? error.message : String(error));
      return false;
    }).finally(() => {
      if (this.persistInFlight === operation) this.persistInFlight = undefined;
      if (this.dirty && !this.closing) this.schedulePersist();
    });
    this.persistInFlight = operation;
    return operation;
  }
}
