# Data lifecycle Phase 11

Phase 11 removes the main Dashboard's dependency on repeated full-window ClickHouse scans while
keeping the existing ten-second refresh cadence and complete event semantics.

## Read path

Preset ranges up to one day are divided into absolute ten-second buckets:

1. The first request reads the complete previous and current window.
2. Closed buckets are retained in the API process and reused across aligned Dashboard snapshots.
3. Later refreshes query only newly closed buckets.
4. Events exactly on the closed interval end are read separately and are not cached as a complete
   bucket.
5. Custom and long investigation ranges keep the existing exact ClickHouse query as a fallback.

No sampling, event limit, shortened history, or slower refresh interval is introduced.

## Durable invalidation

ClickHouse maintains `event_commit_facts` through a materialized view on the event insert path.
Each record contains the event ID, decision revision, event time, commit time, source, and
collector. This observes writes from the API, Fast Judge, and L3 Worker.

A late event or a new decision revision invalidates only its event-time bucket. The bucket is
recomputed before being returned, so cross-refresh reuse does not make final judgments stale.

## Safety and fallback

- Commit-journal reads are cursor based and bounded.
- Failed or unavailable journal/bucket queries are not cached as successful results.
- The API falls back to the existing exact `dashboardWindowHistory` query.
- Runtime deployment and existing data are not changed by this phase.

## Verification

`pnpm verify:data-lifecycle-phase11` checks:

- first-load complete history materialisation;
- one-bucket incremental refresh;
- late-revision bucket invalidation;
- revision-aware current statistics;
- complete session and Workspace folding;
- durable ClickHouse journal wiring.
