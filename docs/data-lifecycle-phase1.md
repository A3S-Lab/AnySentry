# Data lifecycle Phase 1

## Frozen ownership

- ClickHouse stores immutable event facts, judgment revisions, heartbeat history, trends, and
  relationship aggregates.
- Redis stores current online state and short-lived uncommitted deltas.
- Flink keyed state/checkpoints remain the runtime truth for active `AttackCandidate` state.
- Immutable `AttackEpisode` records are durable facts after a candidate matches.
- A relational database will own mutable Agent/Workspace directories, incidents, alerts,
  remediation, reviews, and configuration.
- The in-process event ring is a bounded latency cache only. It must never decide whether a
  historical event, Trace, Agent, or Workspace exists.

## Query contract

The first page query freezes a `snapshotAsOf`. Every card and drill-down carries the same value
until the operator refreshes. Event list and Trace responses include `coverage`:

- requested and observed data range;
- actual durable cutoff when known;
- whether the result is partial and why;
- source (`clickhouse`, `clickhouse+hot_delta`, or `memory_hot_ring`);
- total semantics (`exact`, `estimated`, or `omitted`).

No event-time Watermark is exposed until it is derived from the collectors/partitions involved in
the query. `max(eventTime)` is not a Watermark.

## `win()` audit

| Query family | Current source | Status / migration |
| --- | --- | --- |
| Event list | ClickHouse latest event fact + hot overlap deduped by `eventId` | Phase 1 complete |
| Trace timeline | ClickHouse latest event fact + hot overlap deduped by `eventId` | Phase 1 complete |
| Overview health, explainability, performance, risk, funnel, workspace distribution | ClickHouse dashboard window aggregation with hot-ring fallback | Existing durable path retained |
| Agent inventory | ClickHouse Agent facts plus non-overlapping hot facts | Phase 2 complete for event metrics; mutable directory persistence remains |
| Agent instance trends | ClickHouse identity/time buckets plus non-overlapping hot delta | Phase 3 complete |
| Workspace inventory | ClickHouse Workspace facts plus durable Agent inventory | Phase 3 event metrics complete; relational directory remains |
| Topology | ClickHouse relationship facts plus non-overlapping hot facts | Phase 2 complete |
| Collector health | ClickHouse heartbeat history plus in-memory current state | Phase 2 history complete; Redis current state remains |
| Coverage | durable Agent/Collector facts plus mutable operational state | Phase 3 analytics complete |
| Incident/Alert/Remediation | mutable in-process registries | Phase 3: relational business store |
| Policy simulation | bounded latest-event sample from ClickHouse plus hot delta | Sample limit, truncation, and coverage are explicit |

## Merge correctness

Until collector-scoped committed cursors and event-time Watermarks are available, durable queries
read a bounded overlap from the hot ring and deduplicate by stable `eventId`, choosing the latest
decision update. This prevents late buffered events from disappearing. A later phase may split the
sources into strictly non-overlapping ranges:

1. ClickHouse facts through a real committed cutoff.
2. Redis/hot uncommitted facts after that cutoff.
3. Any defensive overlap is deduplicated by `eventId` and monotonic decision revision before
   aggregation.
