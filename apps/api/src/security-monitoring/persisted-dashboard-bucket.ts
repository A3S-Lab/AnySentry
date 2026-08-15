import type {
  DashboardAggregateBucketFact,
  EventCommitCursor,
} from './clickhouse-store';

export interface PersistedDashboardBucket {
  bucketStartMs: number;
  bucketMs: number;
  cursor: EventCommitCursor;
  facts: DashboardAggregateBucketFact[];
}

export interface BucketCommitCursor {
  bucketStartMs: number;
  cursor: EventCommitCursor;
}

export function compareEventCommitCursor(
  left: EventCommitCursor,
  right: EventCommitCursor,
): number {
  return (
    left.committedAtMs - right.committedAtMs ||
    left.eventId.localeCompare(right.eventId) ||
    left.decisionRevision - right.decisionRevision
  );
}

/**
 * Accept only snapshots whose complete commit history can still be proven.
 *
 * A late event or a newer L1/L2/L3 revision advances the commit cursor of the event-time bucket it
 * belongs to. That bucket is rejected until an exact raw aggregation replaces the snapshot.
 * Snapshots older than the retained commit journal are rejected as well: absence of a retained
 * change is not evidence that no change happened.
 */
export function validPersistedDashboardBuckets(
  snapshots: PersistedDashboardBucket[],
  latestCommits: BucketCommitCursor[],
  earliestRetainedCursor: EventCommitCursor,
): Map<number, PersistedDashboardBucket> {
  const latestByBucket = new Map(
    latestCommits.map((commit) => [commit.bucketStartMs, commit.cursor]),
  );
  const valid = new Map<number, PersistedDashboardBucket>();
  for (const snapshot of snapshots) {
    if (
      earliestRetainedCursor.committedAtMs > 0 &&
      compareEventCommitCursor(snapshot.cursor, earliestRetainedCursor) < 0
    ) {
      continue;
    }
    const latest = latestByBucket.get(snapshot.bucketStartMs);
    if (latest && compareEventCommitCursor(snapshot.cursor, latest) < 0) continue;
    valid.set(snapshot.bucketStartMs, snapshot);
  }
  return valid;
}
