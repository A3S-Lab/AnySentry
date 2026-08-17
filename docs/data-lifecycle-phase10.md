# Data lifecycle Phase 10

Phase 10 removes the moving dashboard snapshot from the role of data-retention boundary. It keeps
the existing 10-second refresh cadence while making historical reuse, hot-tail merging, and
decision revision semantics explicit.

## Query contract

- One dashboard polling cycle uses one 10-second-aligned `snapshotAsOf`.
- ClickHouse exposes a durable commit high-water per `sourceId` and `collectorId`.
- A commit high-water is not advertised as an event-time Watermark.
- Queries retain a 60-second overlap around the durable boundary because collectors do not yet
  publish complete partition Watermarks.
- Historical facts and hot facts are folded by stable `eventId` before they are exposed.
- Judgment delivery duplicates are identified by `eventId + decisionRevision`; the current
  judgment is the greatest `decisionRevision` for each `eventId`.
- Aggregate reads exclude overlapping hot `eventId` values before adding the latest hot facts.
  Overlapping aggregate counts are never added directly.

## Storage roles

- ClickHouse remains the durable source for historical event and judgment facts.
- Redis/in-memory state supplies the bounded hot tail and can be lost without deleting history.
- Dashboard caches reuse completed historical work, actively expire entries, and have a hard
  entry limit.
- Query responses expose commit progress and leave `watermark` unset until a genuine
  collector/partition event-time Watermark exists.

## Failure behavior

When a durable boundary is unavailable, queries read the persisted range and fold the available
hot facts rather than returning a false zero. Failed or timed-out historical computations are not
retained as completed cache results.

This phase does not remove raw evidence, change the UI refresh interval, restart services, or
modify existing data.
