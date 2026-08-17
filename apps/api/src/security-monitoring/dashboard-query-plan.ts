export const DASHBOARD_REFRESH_QUANTUM_MS = 10_000;
export const DASHBOARD_HOT_OVERLAP_MS = 60_000;
export const DASHBOARD_HISTORY_CACHE_LIMIT = 48;

export interface DashboardQueryPlan {
  snapshotAsOfMs: number;
  persistedUntilMs?: number;
  hotFromMs: number;
  hasDurableBoundary: boolean;
}

/**
 * Split an exact dashboard snapshot into persisted and hot reads without claiming an event-time
 * watermark. `committedHighWaterMs` is only an observed ClickHouse commit high-water mark; callers
 * retain a bounded overlap and deduplicate by eventId/revision.
 */
export function planDashboardRead(
  requestedFromMs: number,
  snapshotAsOfMs: number,
  committedHighWaterMs?: number,
  overlapMs = DASHBOARD_HOT_OVERLAP_MS,
): DashboardQueryPlan {
  const snapshot = Math.max(requestedFromMs, snapshotAsOfMs);
  const hasDurableBoundary = Number.isFinite(committedHighWaterMs);
  const persistedUntilMs = hasDurableBoundary
    ? Math.min(snapshot, Math.max(requestedFromMs, Number(committedHighWaterMs)))
    : undefined;
  const hotFromMs = persistedUntilMs === undefined
    ? requestedFromMs
    : Math.max(requestedFromMs, persistedUntilMs - Math.max(0, overlapMs));
  return {
    snapshotAsOfMs: snapshot,
    persistedUntilMs,
    hotFromMs,
    hasDurableBoundary,
  };
}

/** Remove expired entries and cap caches whose keys contain moving dashboard snapshots. */
export function pruneSnapshotCache<T extends { completedAt?: number; startedAt: number }>(
  cache: Map<string, T>,
  nowMs: number,
  ttlFor: (entry: T) => number,
  maxEntries = DASHBOARD_HISTORY_CACHE_LIMIT,
): void {
  for (const [key, entry] of cache) {
    if (entry.completedAt !== undefined && nowMs - entry.completedAt >= ttlFor(entry)) {
      cache.delete(key);
    }
  }
  if (cache.size <= maxEntries) return;
  const completed = [...cache.entries()]
    .filter(([, entry]) => entry.completedAt !== undefined)
    .sort((left, right) =>
      (left[1].completedAt ?? left[1].startedAt) - (right[1].completedAt ?? right[1].startedAt),
    );
  for (const [key] of completed) {
    if (cache.size <= maxEntries) break;
    cache.delete(key);
  }
}
