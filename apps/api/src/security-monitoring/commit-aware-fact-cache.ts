import {
  EventCommitChange,
  EventCommitChanges,
  EventCommitCursor,
} from './clickhouse-store';
import { FactCacheBudget, FactCacheBudgetSnapshot } from './fact-cache-budget';

export interface TimeBucketFact {
  bucketStartMs: number;
}

export interface CommitAwareFactProvider<T extends TimeBucketFact> {
  latestCursor(): Promise<EventCommitCursor | null>;
  earliestCursor?(): Promise<EventCommitCursor | null>;
  changes(after?: EventCommitCursor): Promise<EventCommitChanges | null>;
  facts(startMs: number, endExclusiveMs: number, bucketMs: number): Promise<T[] | null>;
}

function compareCursor(left: EventCommitCursor, right: EventCommitCursor): number {
  return (
    left.committedAtMs - right.committedAtMs ||
    left.eventId.localeCompare(right.eventId) ||
    left.decisionRevision - right.decisionRevision
  );
}

/**
 * Reuses exact, absolute event-time buckets across page refreshes.
 *
 * The cache never guesses that a historical bucket is immutable. Every durable event/revision
 * append is observed through the commit journal and invalidates the bucket containing that
 * eventTime. Missing adjacent buckets are loaded in one ClickHouse query, so the first read is
 * bounded to one historical aggregation while subsequent reads normally fetch only a new tail.
 */
/**
 * Wide Agent/topology prefixes must not fold a full day in one 128 MiB ClickHouse query.
 * 6h stays inside that budget; 4 chunks cover last_1d inside the 30s in-flight timeout.
 */
export const FACT_BUCKET_QUERY_CHUNK_MS = 6 * 3_600_000;
export const FACT_BUCKET_QUERY_MAX_CHUNKS = 1;
const FACT_BUCKET_WARMUP_MAX_ATTEMPTS = 4;

export class CommitAwareFactBucketCache<T extends TimeBucketFact> {
  private readonly bucketFacts = new Map<number, T[]>();
  private readonly budget: FactCacheBudget;
  private readonly queryChunkMs: number;
  private cursor?: EventCommitCursor;
  private operation?: Promise<void>;
  private warmup?: Promise<void>;
  private pendingWarmup?: { startMs: number; endExclusiveMs: number };
  private warmupAttempts = 0;
  private closed = false;
  private budgetRejected = false;

  constructor(
    private readonly provider: CommitAwareFactProvider<T>,
    private readonly bucketMs = 10_000,
    private readonly maxBuckets = 20_000,
    maxFacts = 100_000,
    maxEstimatedBytes = 96 * 1024 * 1024,
    queryChunkMs = FACT_BUCKET_QUERY_CHUNK_MS,
  ) {
    this.budget = new FactCacheBudget(maxBuckets, maxFacts, maxEstimatedBytes);
    this.queryChunkMs = Math.max(this.bucketMs, Math.trunc(queryChunkMs));
  }

  stats(): FactCacheBudgetSnapshot & { warming: boolean } {
    return {
      ...this.budget.snapshot(),
      warming: Boolean(this.pendingWarmup || this.warmup),
    };
  }

  /** Fill remaining aligned chunks after the HTTP path already returned a hot fallback. */
  continueWarmup(startMs: number, endExclusiveMs: number): void {
    if (this.closed || this.budgetRejected || endExclusiveMs <= startMs) return;
    if (
      this.pendingWarmup
      && this.pendingWarmup.startMs === startMs
      && this.pendingWarmup.endExclusiveMs === endExclusiveMs
    ) {
      this.maybeWarmup();
      return;
    }
    this.warmupAttempts = 0;
    this.pendingWarmup = { startMs, endExclusiveMs };
    this.maybeWarmup();
  }

  close(): void {
    this.closed = true;
    this.pendingWarmup = undefined;
  }

  async drainWarmup(): Promise<void> {
    this.maybeWarmup();
    while (this.warmup) await this.warmup;
  }

  async read(startMs: number, endExclusiveMs: number): Promise<T[] | null> {
    if (
      endExclusiveMs < startMs ||
      startMs % this.bucketMs !== 0 ||
      endExclusiveMs % this.bucketMs !== 0
    ) {
      return null;
    }
    if (endExclusiveMs === startMs) return [];

    const task = (this.operation ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.refresh(startMs, endExclusiveMs));
    this.operation = task;
    try {
      await task;
    } finally {
      if (this.operation === task) this.operation = undefined;
      this.maybeWarmup();
    }
    if (this.budgetRejected) return null;

    const result: T[] = [];
    for (let bucket = startMs; bucket < endExclusiveMs; bucket += this.bucketMs) {
      const rows = this.bucketFacts.get(bucket);
      if (!rows) return null;
      result.push(...rows);
    }
    return result;
  }

  private async refresh(startMs: number, endExclusiveMs: number): Promise<void> {
    this.budgetRejected = false;
    if (!this.cursor) {
      const cursor = await this.provider.latestCursor();
      if (cursor === null) throw new Error('commit journal unavailable');
      this.cursor = cursor;
    } else {
      await this.ensureJournalContinuity();
      await this.applyChanges();
    }

    const truncated = await this.loadMissing(startMs, endExclusiveMs);
    // A commit can land while ClickHouse is aggregating the missing range. Re-read the journal,
    // invalidate its event-time bucket and reload only that bucket before returning.
    await this.applyChanges();
    if (!truncated) await this.loadMissing(startMs, endExclusiveMs);
    this.prune(startMs, endExclusiveMs);
    if (this.budgetRejected) this.pendingWarmup = undefined;
  }

  private rangeMissing(startMs: number, endExclusiveMs: number): boolean {
    for (let bucket = startMs; bucket < endExclusiveMs; bucket += this.bucketMs) {
      if (!this.bucketFacts.has(bucket)) return true;
    }
    return false;
  }

  private maybeWarmup(): void {
    if (this.closed || this.warmup || !this.pendingWarmup) return;
    if (this.budgetRejected) {
      this.pendingWarmup = undefined;
      return;
    }
    if (this.operation) {
      this.warmup = this.operation.catch(() => undefined).finally(() => {
        this.warmup = undefined;
        this.maybeWarmup();
      });
      return;
    }
    if (this.warmupAttempts >= FACT_BUCKET_WARMUP_MAX_ATTEMPTS) {
      this.pendingWarmup = undefined;
      return;
    }
    const range = this.pendingWarmup;
    this.warmupAttempts += 1;
    this.warmup = Promise.resolve();
    const task = this.refresh(range.startMs, range.endExclusiveMs)
      .catch(() => undefined)
      .then(() => {
        if (this.closed || !this.rangeMissing(range.startMs, range.endExclusiveMs)) {
          this.pendingWarmup = undefined;
        }
      });
    this.operation = task;
    this.warmup = task.finally(() => {
      if (this.operation === task) this.operation = undefined;
      this.warmup = undefined;
      this.maybeWarmup();
    });
  }

  private async ensureJournalContinuity(): Promise<void> {
    if (!this.cursor || !this.provider.earliestCursor) return;
    const earliest = await this.provider.earliestCursor();
    if (earliest === null) throw new Error('commit journal bounds unavailable');
    if (earliest.committedAtMs === 0 || compareCursor(this.cursor, earliest) >= 0) return;

    this.bucketFacts.clear();
    this.budget.clear('journal');
    const latest = await this.provider.latestCursor();
    if (latest === null) throw new Error('commit journal unavailable after gap');
    this.cursor = latest;
  }

  private async applyChanges(): Promise<void> {
    for (let page = 0; page < 8; page += 1) {
      const result = await this.provider.changes(this.cursor);
      if (result === null) throw new Error('commit journal unavailable');
      for (const change of result.changes) this.invalidate(change);
      this.cursor = result.cursor ?? this.cursor;
      if (!result.hasMore) return;
    }
    throw new Error('commit journal change backlog exceeded bounded refresh');
  }

  private invalidate(change: EventCommitChange): void {
    const bucket = Math.floor(change.eventAtMs / this.bucketMs) * this.bucketMs;
    this.bucketFacts.delete(bucket);
    this.budget.remove(bucket);
  }

  private async loadMissing(startMs: number, endExclusiveMs: number): Promise<boolean> {
    const ranges: Array<{ startMs: number; endExclusiveMs: number }> = [];
    let rangeStart: number | undefined;
    for (let bucket = startMs; bucket <= endExclusiveMs; bucket += this.bucketMs) {
      const missing = bucket < endExclusiveMs && !this.bucketFacts.has(bucket);
      if (missing && rangeStart === undefined) rangeStart = bucket;
      if ((!missing || bucket === endExclusiveMs) && rangeStart !== undefined) {
        ranges.push({ startMs: rangeStart, endExclusiveMs: bucket });
        rangeStart = undefined;
      }
    }
    // A recovery burst or delayed L2/L3 completions can invalidate many disjoint buckets. Issuing
    // one aggregation per gap repeatedly scans the same MergeTree marks and is much slower than a
    // single exact envelope read. Replacing already-valid buckets from that same snapshot is safe.
    const reads = ranges.length > 2
      ? [{
          startMs: ranges[0].startMs,
          endExclusiveMs: ranges[ranges.length - 1].endExclusiveMs,
        }]
      : ranges;
    const planned = reads.flatMap((range) => this.queryChunks(range.startMs, range.endExclusiveMs));
    const queries = planned.slice(0, FACT_BUCKET_QUERY_MAX_CHUNKS);
    for (const range of queries) {
      const rows = await this.provider.facts(
        range.startMs,
        range.endExclusiveMs,
        this.bucketMs,
      );
      if (rows === null) throw new Error('bucket facts unavailable');
      const grouped = new Map<number, T[]>();
      for (const row of rows) {
        const list = grouped.get(row.bucketStartMs) ?? [];
        list.push(row);
        grouped.set(row.bucketStartMs, list);
      }
      for (
        let current = range.startMs;
        current < range.endExclusiveMs;
        current += this.bucketMs
      ) {
        const facts = grouped.get(current) ?? [];
        this.bucketFacts.set(current, facts);
        this.budget.record(current, facts);
      }
    }
    return planned.length > queries.length;
  }

  private queryChunks(
    startMs: number,
    endExclusiveMs: number,
  ): Array<{ startMs: number; endExclusiveMs: number }> {
    const size = Math.max(this.bucketMs, Math.floor(this.queryChunkMs / this.bucketMs) * this.bucketMs);
    const chunks: Array<{ startMs: number; endExclusiveMs: number }> = [];
    for (let current = startMs; current < endExclusiveMs; current += size) {
      chunks.push({
        startMs: current,
        endExclusiveMs: Math.min(endExclusiveMs, current + size),
      });
    }
    return chunks;
  }

  private prune(requiredStart: number, requiredEnd: number): void {
    if (!this.budget.exceeded()) return;
    for (const bucket of [...this.bucketFacts.keys()].sort((left, right) => left - right)) {
      if (!this.budget.exceeded()) break;
      if (bucket >= requiredStart && bucket < requiredEnd) continue;
      this.bucketFacts.delete(bucket);
      this.budget.remove(bucket);
    }
    if (this.budget.exceeded()) {
      this.bucketFacts.clear();
      this.budget.clear('budget');
      this.budgetRejected = true;
    }
  }
}
