# Data lifecycle Phase 13

Phase 13 makes query completeness and commit progress explicit without weakening the existing
ten-second Dashboard refresh interval.

## Coverage semantics

- `snapshotAsOf` is the logical cutoff shared by every request in one Dashboard refresh.
- `observedDurableThrough` is the greatest relevant event time observed in a successful
  ClickHouse insert. It is a read-split/progress marker, not an event-time Watermark.
- `commitProgress` is filtered to the `sourceId` or `collectorId` selected by the query. An
  unrelated Collector can no longer make a scoped result look more complete.
- `completeness: exact_as_observed` means the result contains every fact known at the snapshot. It
  does not claim that a delayed Collector can never submit an older event later.
- A real `watermark` remains unset until Collector/Kafka partition progress and allowed lateness
  are available.

Late canonical events and later L1/L2/L3 revisions are recorded in the durable commit journal.
Their event-time buckets are invalidated and recomputed, so reusable history does not freeze an
obsolete result.

## Refresh-cost regression

The Phase 13 verifier simulates 360 ten-second refreshes over a three-hour window. The initial
request materialises the historical prefix; subsequent requests reuse those buckets and fetch only
the new ten-second tail. The verifier also injects a late event and a newer decision revision and
checks that only the affected bucket is read again.

This preserves exact event and revision semantics while avoiding a complete historical scan on
every refresh.

## Runtime boundary

This phase is a code and contract change only. It does not restart containers, modify running
volumes, or query production data. Runtime ClickHouse read-row, memory, and P95 measurements must
be collected in a controlled deployment after the build and behavior checks pass.
