// Pure view-resolution helpers for the collectors/health aggregation.
//
// compat30: a briefly-late raw collector heartbeat used to collapse the health
// view to forwarder-shaped zeros (attachedProbes=0, default fileFilterMetrics)
// - field 2026-11-11 17:34 rendered four false FAILs in a soak verdict while
// the collector ran uninterrupted. These helpers prefer the LAST KNOWN raw
// values inside a grace window and expose staleness instead of fabricating
// zeros. No Nest dependencies: unit-testable in isolation.

export interface HeartbeatLike {
  at: number;
}

export interface FileFilterCarrier extends HeartbeatLike {
  fileFilterMetricsReportedAt?: number;
}

export interface MetadataView<T> {
  /** Last-known raw heartbeat when inside the grace window, else undefined. */
  heartbeat: T | undefined;
  /** Age of the honored heartbeat; 0 = fresh, >0 = honored-but-stale. */
  staleMs: number;
}

export function resolveMetadataView<T extends HeartbeatLike>(
  now: number,
  latestRaw: T | undefined,
  staleMs: number,
  graceMs: number,
): MetadataView<T> {
  if (latestRaw === undefined) return { heartbeat: undefined, staleMs: 0 };
  const age = now - latestRaw.at;
  if (age <= staleMs) return { heartbeat: latestRaw, staleMs: 0 };
  if (age <= staleMs + graceMs) return { heartbeat: latestRaw, staleMs: age };
  return { heartbeat: undefined, staleMs: age };
}

export function resolveFileFilterView<T extends FileFilterCarrier>(
  now: number,
  latestRaw: T | undefined,
  staleMs: number,
  graceMs: number,
): MetadataView<T> {
  if (latestRaw === undefined || latestRaw.fileFilterMetricsReportedAt === undefined) {
    return { heartbeat: undefined, staleMs: 0 };
  }
  const age = now - latestRaw.fileFilterMetricsReportedAt;
  if (age <= staleMs) return { heartbeat: latestRaw, staleMs: 0 };
  if (age <= staleMs + graceMs) return { heartbeat: latestRaw, staleMs: age };
  return { heartbeat: undefined, staleMs: age };
}

/** Tiny TTL cache: identical polling bodies are served coherently for ttlMs,
 *  capping how often the heavy aggregation path runs under UI polling storms. */
export class TtlCache<V> {
  private readonly entries = new Map<string, { value: V; expiresAt: number }>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(ttlMs: number, maxEntries = 32) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
  }

  get(key: string, now: number): V | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= now) {
      this.entries.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: V, now: number): void {
    if (this.entries.size >= this.maxEntries && !this.entries.has(key)) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expiresAt: now + this.ttlMs });
  }

  get size(): number {
    return this.entries.size;
  }
}
