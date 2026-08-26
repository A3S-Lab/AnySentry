import {
  DashboardAggregateBucketFact,
  DashboardWindowBucketRow,
  DashboardWindowDimensionRow,
  DashboardWindowHistory,
  EventCommitChange,
  EventCommitChanges,
  EventCommitCursor,
} from './clickhouse-store';
import { FactCacheBudget, FactCacheBudgetSnapshot } from './fact-cache-budget';

const FINAL_STATUSES = new Set(['succeeded', 'failed', 'timeout']);

export interface DashboardHistoryProvider {
  latestCursor(): Promise<EventCommitCursor | null>;
  earliestCursor?(): Promise<EventCommitCursor | null>;
  changes(after?: EventCommitCursor): Promise<EventCommitChanges | null>;
  facts(startMs: number, endExclusiveMs: number, bucketMs: number): Promise<DashboardAggregateBucketFact[] | null>;
}

function compareCursor(left: EventCommitCursor, right: EventCommitCursor): number {
  return (
    left.committedAtMs - right.committedAtMs ||
    (left.commitBatchId ?? '').localeCompare(right.commitBatchId ?? '') ||
    left.eventId.localeCompare(right.eventId) ||
    left.decisionRevision - right.decisionRevision
  );
}

function aggregateKey(values: Array<string | number | boolean>): string {
  return values.join('\u0000');
}

/** Fold reusable absolute facts into the existing Dashboard response contract. */
export function dashboardHistoryFromFacts(
  facts: DashboardAggregateBucketFact[],
  startMs: number,
  endMs: number,
  bucketCount: number,
): DashboardWindowHistory {
  const spanMs = Math.max(1, endMs - startMs);
  const buckets = Math.max(1, Math.min(360, Math.trunc(bucketCount)));
  const dimensions = new Map<string, DashboardWindowDimensionRow>();
  const bucketRows = new Map<string, DashboardWindowBucketRow>();
  const sessions = new Map<string, {
    sessionId: string;
    userId: string;
    workspacePath: string;
    eventCount: number;
    riskyEventCount: number;
    riskScoreTotal: number;
    lastEventAt: number;
    dimensionCounts: Record<string, number>;
  }>();
  const workspaces = new Map<string, {
    workspacePath: string;
    sessions: Set<string>;
    totalRiskScore: number;
    worstSeverityRank: number;
  }>();

  for (const fact of facts) {
    const period: 'current' | 'previous' = fact.bucketStartMs < startMs ? 'previous' : 'current';
    if (FINAL_STATUSES.has(fact.decisionStatus)) {
      const key = aggregateKey([
        period,
        fact.monitored,
        fact.verdict,
        fact.tier,
        fact.riskType,
        fact.riskCategory,
        fact.riskName,
      ]);
      const row = dimensions.get(key) ?? {
        period,
        monitored: fact.monitored,
        verdict: fact.verdict,
        tier: fact.tier,
        riskType: fact.riskType,
        riskCategory: fact.riskCategory,
        riskName: fact.riskName,
        eventCount: 0,
        tokenCount: 0,
        latencyTotal: 0,
        riskScoreTotal: 0,
      };
      row.eventCount += fact.eventCount;
      row.tokenCount += fact.tokenCount;
      row.latencyTotal += fact.latencyTotal;
      row.riskScoreTotal += fact.riskScoreTotal;
      dimensions.set(key, row);
    }

    if (period !== 'current') continue;
    const bucketIndex = Math.max(
      0,
      Math.min(buckets - 1, Math.floor(((fact.bucketStartMs - startMs) * buckets) / spanMs)),
    );
    const bucketKey = aggregateKey([bucketIndex, fact.monitored]);
    const bucket = bucketRows.get(bucketKey) ?? {
      bucketIndex,
      monitored: fact.monitored,
      eventCount: 0,
      blockedCount: 0,
      escalatedCount: 0,
      l2Count: 0,
      l3Count: 0,
      riskActivationCount: 0,
      tokenCount: 0,
      latencyTotal: 0,
      riskScoreTotal: 0,
    };
    bucket.eventCount += fact.eventCount;
    bucket.blockedCount += fact.blockedCount;
    bucket.escalatedCount += fact.escalatedCount;
    bucket.l2Count += fact.l2Count;
    bucket.l3Count += fact.l3Count;
    bucket.riskActivationCount += fact.riskActivationCount;
    bucket.tokenCount += fact.tokenCount;
    bucket.latencyTotal += fact.latencyTotal;
    bucket.riskScoreTotal += fact.riskScoreTotal;
    bucketRows.set(bucketKey, bucket);

    if (!fact.monitored) continue;
    const session = sessions.get(fact.sessionKey) ?? {
      sessionId: fact.sessionKey,
      userId: fact.userId,
      workspacePath: fact.workspacePath,
      eventCount: 0,
      riskyEventCount: 0,
      riskScoreTotal: 0,
      lastEventAt: 0,
      dimensionCounts: {
        command_danger: 0,
        prompt_injection: 0,
        data_leak: 0,
        jailbreak: 0,
        communication_risk: 0,
        systemic_risk: 0,
      },
    };
    session.eventCount += fact.eventCount;
    session.riskyEventCount += fact.riskyEventCount;
    session.riskScoreTotal += fact.riskScoreTotal;
    if (fact.lastEventAt >= session.lastEventAt) {
      session.lastEventAt = fact.lastEventAt;
      session.userId = fact.userId;
      session.workspacePath = fact.workspacePath;
    }
    session.dimensionCounts.command_danger += fact.commandDangerCount;
    session.dimensionCounts.prompt_injection += fact.promptInjectionCount;
    session.dimensionCounts.data_leak += fact.dataLeakCount;
    session.dimensionCounts.jailbreak += fact.promptInjectionCount;
    session.dimensionCounts.communication_risk += fact.communicationRiskCount;
    session.dimensionCounts.systemic_risk += fact.systemicRiskCount;
    sessions.set(fact.sessionKey, session);

    const workspace = workspaces.get(fact.workspacePath) ?? {
      workspacePath: fact.workspacePath,
      sessions: new Set<string>(),
      totalRiskScore: 0,
      worstSeverityRank: 0,
    };
    workspace.sessions.add(fact.sessionKey);
    workspace.totalRiskScore += fact.riskScoreTotal;
    if (fact.verdict !== 'allow') {
      workspace.worstSeverityRank = Math.max(workspace.worstSeverityRank, fact.severityRank);
    }
    workspaces.set(fact.workspacePath, workspace);
  }

  const topSession = [...sessions.values()]
    .sort((left, right) =>
      right.riskScoreTotal - left.riskScoreTotal ||
      right.lastEventAt - left.lastEventAt ||
      left.sessionId.localeCompare(right.sessionId),
    )[0];
  return {
    dimensions: [...dimensions.values()],
    buckets: [...bucketRows.values()].sort((left, right) =>
      left.bucketIndex - right.bucketIndex || Number(left.monitored) - Number(right.monitored),
    ),
    topSession,
    workspaces: [...workspaces.values()]
      .map((workspace) => ({
        workspacePath: workspace.workspacePath,
        sessionCount: workspace.sessions.size,
        totalRiskScore: workspace.totalRiskScore,
        worstSeverityRank: workspace.worstSeverityRank,
      }))
      .sort((left, right) =>
        right.totalRiskScore - left.totalRiskScore ||
        left.workspacePath.localeCompare(right.workspacePath),
      )
      .slice(0, 500),
  };
}

/**
 * Cross-refresh cache for complete 10-second facts. Only fully closed buckets are retained.
 * The exact end-millisecond is queried separately so the public closed-interval contract remains
 * intact. Durable commit changes invalidate the affected historical bucket before it is reused.
 */
export class DashboardHistoryBucketCache {
  private readonly bucketMs = 10_000;
  private readonly bucketFacts = new Map<number, DashboardAggregateBucketFact[]>();
  private readonly budget: FactCacheBudget;
  private cursor?: EventCommitCursor;
  private operation?: Promise<void>;
  private budgetRejected = false;

  constructor(
    private readonly provider: DashboardHistoryProvider,
    private readonly maxBuckets = 20_000,
    maxFacts = 250_000,
    maxEstimatedBytes = 128 * 1024 * 1024,
  ) {
    this.budget = new FactCacheBudget(maxBuckets, maxFacts, maxEstimatedBytes);
  }

  stats(): FactCacheBudgetSnapshot {
    return this.budget.snapshot();
  }

  async read(startMs: number, endMs: number, bucketCount: number): Promise<DashboardWindowHistory | null> {
    if (startMs % this.bucketMs !== 0 || endMs % this.bucketMs !== 0) return null;
    const queryStart = Math.max(0, startMs - (endMs - startMs));
    const task = (this.operation ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.refresh(queryStart, endMs));
    this.operation = task;
    try {
      await task;
    } finally {
      if (this.operation === task) this.operation = undefined;
    }
    if (this.budgetRejected) return null;

    const facts: DashboardAggregateBucketFact[] = [];
    for (let bucket = queryStart; bucket < endMs; bucket += this.bucketMs) {
      const rows = this.bucketFacts.get(bucket);
      if (!rows) return null;
      facts.push(...rows);
    }
    // The legacy contract is a closed interval. Events exactly on the snapshot boundary belong to
    // the final chart bucket but are never retained as a reusable full bucket.
    const boundary = await this.provider.facts(endMs, endMs + 1, this.bucketMs);
    if (boundary === null) return null;
    facts.push(...boundary);
    return dashboardHistoryFromFacts(facts, startMs, endMs, bucketCount);
  }

  /**
   * Reuse the stable historical prefix while allowing the caller to provide an exact recent tail.
   * Tail facts are expected to have already folded persisted and hot deliveries by eventId and
   * decisionRevision.
   */
  async readWithTail(
    startMs: number,
    endMs: number,
    bucketCount: number,
    tailStartMs: number,
    tailFacts: DashboardAggregateBucketFact[],
  ): Promise<DashboardWindowHistory | null> {
    if (tailStartMs % this.bucketMs !== 0 || tailStartMs > endMs) {
      return null;
    }
    const queryStart = Math.max(0, startMs - (endMs - startMs));
    const firstFullBucket = Math.ceil(queryStart / this.bucketMs) * this.bucketMs;
    const currentBoundaryBucket = Math.floor(startMs / this.bucketMs) * this.bucketMs;
    const currentBoundaryEnd = Math.ceil(startMs / this.bucketMs) * this.bucketMs;
    const hasSplitCurrentBoundary = currentBoundaryBucket !== startMs;
    const stableEnd = Math.max(firstFullBucket, tailStartMs);
    // A very short preset can be served exactly by the caller's fallback. Keeping the reusable
    // path for it would make the exact current-window boundary overlap the supplied hot tail.
    if (hasSplitCurrentBoundary && currentBoundaryEnd > stableEnd) return null;
    const task = (this.operation ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.refresh(firstFullBucket, stableEnd));
    this.operation = task;
    try {
      await task;
    } finally {
      if (this.operation === task) this.operation = undefined;
    }
    if (this.budgetRejected) return null;

    const facts: DashboardAggregateBucketFact[] = [];
    const appendExactRange = async (
      rangeStart: number,
      rangeEnd: number,
      semanticBucketStart: number,
    ): Promise<boolean> => {
      if (rangeEnd <= rangeStart) return true;
      const rows = await this.provider.facts(rangeStart, rangeEnd, this.bucketMs);
      if (rows === null) return false;
      facts.push(...rows.map((row) => ({
        ...row,
        // Partial buckets straddling the previous/current boundary must retain their semantic
        // side. The raw ClickHouse bucket start is rounded down and would otherwise move current
        // events into the previous comparison period.
        bucketStartMs: semanticBucketStart,
      })));
      return true;
    };

    if (!await appendExactRange(queryStart, firstFullBucket, queryStart)) return null;
    if (hasSplitCurrentBoundary) {
      if (!await appendExactRange(currentBoundaryBucket, startMs, startMs - 1)) return null;
      if (!await appendExactRange(startMs, currentBoundaryEnd, startMs)) return null;
    }

    for (let bucket = firstFullBucket; bucket < stableEnd; bucket += this.bucketMs) {
      // This bucket was queried as two exact slices above so an event can never cross the
      // previous/current comparison boundary merely because the public snapshot has milliseconds.
      if (hasSplitCurrentBoundary && bucket === currentBoundaryBucket) continue;
      const rows = this.bucketFacts.get(bucket);
      if (!rows) return null;
      facts.push(...rows);
    }
    facts.push(...tailFacts);
    return dashboardHistoryFromFacts(facts, startMs, endMs, bucketCount);
  }

  private async refresh(startMs: number, endMs: number): Promise<void> {
    this.budgetRejected = false;
    if (!this.cursor) {
      const cursor = await this.provider.latestCursor();
      if (cursor === null) throw new Error('commit journal unavailable');
      this.cursor = cursor;
    } else {
      await this.ensureJournalContinuity();
      await this.applyChanges();
    }
    await this.loadMissing(startMs, endMs);
    // Close the race between reading the commit cursor and loading facts. A revision committed
    // during the query invalidates and reloads only its affected bucket.
    await this.applyChanges();
    await this.loadMissing(startMs, endMs);
    this.prune(startMs, endMs);
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

  private async loadMissing(startMs: number, endMs: number): Promise<void> {
    let rangeStart: number | undefined;
    for (let bucket = startMs; bucket <= endMs; bucket += this.bucketMs) {
      const missing = bucket < endMs && !this.bucketFacts.has(bucket);
      if (missing && rangeStart === undefined) rangeStart = bucket;
      if ((!missing || bucket === endMs) && rangeStart !== undefined) {
        const rangeEnd = bucket;
        const rows = await this.provider.facts(rangeStart, rangeEnd, this.bucketMs);
        if (rows === null) throw new Error('dashboard bucket facts unavailable');
        const grouped = new Map<number, DashboardAggregateBucketFact[]>();
        for (const row of rows) {
          const list = grouped.get(row.bucketStartMs) ?? [];
          list.push(row);
          grouped.set(row.bucketStartMs, list);
        }
        for (let current = rangeStart; current < rangeEnd; current += this.bucketMs) {
          const facts = grouped.get(current) ?? [];
          this.bucketFacts.set(current, facts);
          this.budget.record(current, facts);
        }
        rangeStart = undefined;
      }
    }
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
