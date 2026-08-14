# Bounded hot-ring read audit

The 100,000-event in-memory ring is a latency cache and degraded-mode fallback. This inventory
tracks whether each user-facing read can still inherit that bound.

## Durable window reads

These controller routes use ClickHouse latest-per-event facts or ClickHouse aggregates when the
store is ready. Their synchronous hot implementation remains only as an explicit degraded fallback
and must return `coverage.partial=true`.

| Read model | Durable path |
| --- | --- |
| Health and token summary | dashboard window aggregation |
| Explainability trend | dashboard time buckets |
| Performance/TPS/latency | dashboard time buckets |
| Risk summary and breakdown | dashboard latest-decision dimensions |
| Highest-risk session | dashboard session aggregate |
| Decision funnel | dashboard latest-decision dimensions |
| Workspace risk distribution | dashboard Workspace aggregate |
| Event list | ClickHouse event search plus eventId-deduplicated hot delta |
| Trace/run/session timeline | ClickHouse event search plus eventId-deduplicated hot delta |
| Agent inventory | ClickHouse Agent facts plus non-overlapping hot facts |
| Agent topology | ClickHouse relationship facts plus non-overlapping hot facts |
| Collector history | ClickHouse heartbeat history plus current in-process cache |
| Agent instance metrics | ClickHouse identity/time buckets plus non-overlapping hot delta |
| Agent observability | ClickHouse identity/time buckets plus non-overlapping hot delta |
| Workspace inventory | ClickHouse Workspace facts joined with durable Agent inventory |
| Coverage overview | durable Agent/Collector facts plus mutable Source and operations state |
| Pinned topology edge/event | persisted relationship facts plus exact ClickHouse event lookup |
| Collector current health | ClickHouse heartbeat history plus Redis latest-state snapshot |

## Remaining lifecycle migrations

Mutable Agent, Workspace, Incident, Alert, Remediation, identity-review, and configuration objects
still need a relational system of record. Redis now holds the distributed latest Collector
heartbeat; Source check-ins and other short-lived current-state snapshots still need migration.
Pinned topology drill-down no longer scans the hot ring.

## Deliberately bounded reads

Policy simulation executes the Rust rules against a bounded latest-event sample from ClickHouse
plus the hot delta. It reports sample limit, sampled count, truncation, skipped events, and query
coverage; it is intentionally not a full-history analytics query.

Incident, remediation, alert, identity-review, and configuration records are mutable business
objects rather than raw event analytics. Their final system of record belongs in the relational
business store, not in the hot ring or an append-only ClickHouse aggregate.
