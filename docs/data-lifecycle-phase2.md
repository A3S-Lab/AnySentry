# Data lifecycle Phase 2

Phase 2 removes the 100,000-event hot ring as the source of truth for Agent inventory, topology,
and Collector history.

## Durable read paths

- Agent inventory is aggregated in ClickHouse after collapsing judgment revisions by `eventId`.
  The API reads only stable identity facts and representative evidence, then merges the recent
  hot delta after excluding its stable event IDs from the ClickHouse input.
- Topology is aggregated in ClickHouse by stable Agent identity and relationship target. Original
  events remain the evidence source; an aggregate edge is never an independent security fact.
- Collector heartbeats are append-only ClickHouse history. The in-memory list remains a current
  low-latency cache and compatibility fallback.

All three responses return the common query coverage contract. Until a real per-Collector
event-time commit cursor exists, ClickHouse and the hot ring may overlap defensively. The API
collects stable `eventId`s from the hot interval, excludes them from the ClickHouse query, and only
then aggregates both non-overlapping fact sets. It never adds or takes the maximum of aggregate
counters whose underlying events may overlap.

Session, run, trace, and Agent-instance cardinalities are merged as exact key sets across durable
and hot facts. Adding already-aggregated distinct counts would overcount identities present in both
sources.

Failed ClickHouse event and heartbeat batches are returned to the front of their buffers for retry;
they are not dropped. Event flushes are serialized. `committedCutoff` is exposed only while no
event batch is buffered or in flight, so a maximum persisted event time is never misrepresented as
a contiguous committed interval while an older batch is still retrying.

## Judgment revisions

Every event starts at `decisionRevision=1`. Each accepted lifecycle update increments the revision
inside a per-event critical section. ClickHouse keeps every revision as an append-only audit trail;
current event queries collapse it with the greatest `(decisionRevision, decisionUpdatedAt, at)`.
Dashboard dimensions, time buckets, Agent facts, topology facts, searches, and evidence lookup all
aggregate only that latest revision.

The revision is strictly monotonic within one `eventId`. Wall-clock timestamps remain audit
metadata and do not decide which judgment is current.

## Query columns

The event table stores these derived identity columns for new rows:

- `agentIdentityKey`
- `agentInstanceKey`
- `agentMonitored`
- `agentHasPhysicalIdentity`
- `agentHasRootIdentity`

Existing deployments add them with deterministic defaults. Run the one-time migration after the
new schema is installed:

```bash
pnpm migrate:event-query-columns
```

Add `-- --wait` only during a maintenance window when the caller should wait for the ClickHouse
mutation to complete. The migration materializes derived columns only; it does not rewrite the raw
event evidence or judgment payload.

## Remaining work

- Pinned topology edge/event drill-down still uses the exact hot lookup until a durable edge lookup
  is added.
- Agent and Workspace mutable metadata remain in the current registry pending the relational
  business-object store.
- Agent-instance time series, Workspace inventory, coverage, and Agent observability moved to
  durable latest-decision facts in Phase 3. Their synchronous implementations remain explicit
  degraded-mode fallbacks and report `partial=true`.
- Policy simulation intentionally remains a bounded sample. It must expose sample coverage and
  must never claim full-history evaluation.
