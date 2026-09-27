# Data lifecycle Phase 15

Phase 15 closes three deployment blockers in the cross-refresh Dashboard cache without changing
the public Dashboard contract or sampling security evidence.

## Exact recent tail

Preset Dashboard windows up to 24 hours are read as:

```text
closed historical prefix
  -> reusable 10-second facts

last 60 seconds
  -> latest persisted ClickHouse events
  +  in-process hot deliveries
  -> one effective event per eventId
  -> greatest decisionRevision wins
```

The stable prefix and exact tail use disjoint event-time intervals. The tail is rebuilt on every
refresh, so a newly ingested event or L1 -> L2 -> L3 decision transition is visible without
rescanning the full historical range.

## Bounded API memory

Fact caches are bounded by:

- bucket count;
- retained fact count;
- estimated serialized bytes.

If the range required by one request cannot fit the cache budget, the cache is cleared and returns
`null`. The caller then uses the exact ClickHouse query. It does not sample, truncate, or silently
drop rows to stay under the memory budget.

The health response exposes retained buckets, facts, estimated bytes, evictions, budget rejects and
journal resets. This makes API memory protection observable instead of relying on a configured
bucket count that says nothing about high-cardinality fact volume.

## Commit journal continuity

The event commit journal has a finite retention period. Each reusable cache compares its cursor
with the oldest retained journal cursor. If the cache cursor is older, invalidations may have been
missed, so the entire reusable prefix is discarded and rebuilt from ClickHouse.

This prevents an API process that survived a journal-retention gap from presenting stale history as
complete.

## Scope and validation

The offline Phase 15 verification covers:

- exact fallback on fact or byte budget pressure;
- full cache reset on a commit journal gap;
- stable prefix plus exact recent tail;
- persisted/hot decision revision folding.

It does not claim a production ClickHouse scan ratio. `read_rows`, `read_bytes`, query memory and
Dashboard P95/P99 still require a controlled runtime benchmark before broad deployment.
