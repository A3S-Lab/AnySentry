import { CommittedSourceProgress } from './clickhouse-store';

export interface CommitProgressFilter {
  sourceId?: string;
  collectorId?: string;
}

export interface RelevantCommitProgress {
  entries: CommittedSourceProgress[];
  scope: 'all_sources' | 'query_sources';
}

/**
 * Select only the durable progress entries that can contribute to the current query.
 *
 * A progress entry is an observed ClickHouse high-water mark. It is deliberately not interpreted
 * as an event-time watermark: collectors can still deliver an older event after this point.
 */
export function relevantCommitProgress(
  entries: CommittedSourceProgress[],
  filter: CommitProgressFilter,
): RelevantCommitProgress {
  const sourceId = filter.sourceId?.trim();
  const collectorId = filter.collectorId?.trim();
  const scoped = Boolean(sourceId || collectorId);
  return {
    entries: entries.filter((entry) =>
      (!sourceId || entry.sourceId === sourceId) &&
      (!collectorId || entry.collectorId === collectorId),
    ),
    scope: scoped ? 'query_sources' : 'all_sources',
  };
}

/**
 * Preserve the existing global read-split marker for unscoped queries, but never expose that
 * marker as if it belonged to an explicitly selected source/collector. For a scoped query the
 * reported value is derived only from matching durable progress entries.
 */
export function observedDurableThrough(
  globalObservedMs: number | undefined,
  progress: RelevantCommitProgress,
): number | undefined {
  if (progress.scope === 'all_sources') return globalObservedMs;
  if (progress.entries.length === 0) return undefined;
  return Math.max(...progress.entries.map((entry) => entry.committedEventTimeMs));
}
