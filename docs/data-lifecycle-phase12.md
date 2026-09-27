# Data lifecycle Phase 12

Phase 12 removes repeated full-window raw-event scans from Agent inventory and topology reads
without changing the ten-second refresh cadence, result completeness, or evidence drill-down.

## Exact two-part read

Preset ranges up to one day are split at an absolute ten-second boundary:

1. The stable historical prefix is read as exact absolute buckets and reused across refreshes.
2. The latest overlap interval remains an exact raw-fact query.
3. Hot events are folded by `eventId` and latest `decisionRevision`.
4. Persisted overlap event IDs are excluded before the boundary facts are merged.

Keeping the overlap outside the reusable aggregate buckets is intentional. It lets the API
deduplicate raw facts before aggregation instead of adding overlapping aggregate counters.

## Late events and judgment revisions

The same ClickHouse commit journal introduced in Phase 11 invalidates the event-time bucket touched
by:

- a late canonical event;
- an L1/L2/L3 judgment revision;
- a write performed by another API or Worker process.

Only the affected bucket is re-read. A second journal pass closes the race where a write lands
while ClickHouse is calculating a missing bucket.

## Fallback and evidence

- Unaligned custom ranges keep the existing exact query.
- Journal or bucket-query failures fall back to the exact whole-window aggregation.
- Representative event IDs remain attached to bucket facts.
- Raw event and evidence pages continue querying ClickHouse by stable IDs; no evidence is removed
  or sampled.
- This phase does not restart services or modify existing runtime data.

## Verification

`pnpm verify:data-lifecycle-phase12` checks:

- one-query initial history materialisation;
- cross-refresh tail-only reads;
- late-event invalidation;
- decision-revision invalidation;
- unaligned-range exact fallback;
- Agent and topology bucket-query wiring.
