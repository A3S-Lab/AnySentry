# Data lifecycle Phase 3

Phase 3 removes Agent trends, live observability, Workspace inventory, and coverage analytics from
the 100,000-event in-process hot ring.

## Durable read paths

- Agent instance metrics are calculated from ClickHouse latest-decision facts grouped by stable
  workload identity and bounded time bucket.
- Agent observability reuses those facts for event rate, communication rate, decision latency,
  error rate, session transitions, and observed Agent count.
- Workspace inventory is calculated from ClickHouse Workspace facts and joined with the durable
  Agent inventory for mutable metadata, lifecycle, and ownership.
- Coverage combines durable Agent facts, ClickHouse Collector heartbeat history, current Source
  state, maintenance state, and incident state. It no longer scans the complete event window.
- Pinned topology edges and pinned events reuse persisted relationship facts and exact ClickHouse
  event lookup. Opening one edge no longer scans the entire in-process ring.
- Policy simulation replays a bounded latest-event sample from ClickHouse plus the hot delta. The
  response exposes the sample limit, sampled count, truncation flag, and query coverage; it never
  claims to represent unbounded history.

The synchronous hot-ring implementations remain degraded-mode fallbacks only. Their response
coverage is explicitly partial.

## Non-overlapping merge

The hot ring may contain both uncommitted events and recently committed events. Each durable query
receives the stable `eventId`s present in the hot interval and excludes them before ClickHouse
aggregation. Only after this exclusion are ClickHouse facts and hot facts merged.

Distinct Session, Run, Trace, Collector, Workspace, and Agent-instance values are merged as key
sets. Aggregate distinct counts are never added across overlapping sources.

## Coverage semantics

Coverage facts attached to Agent inventory include:

- the exact Collector IDs observed in the requested interval;
- the exact number of events without a Collector identity;
- stable representative evidence for drill-down.

Source configuration, maintenance windows, incidents, and manual identity decisions remain mutable
business state. Phase 3 does not move those objects into ClickHouse.

## Remaining lifecycle work

- Persist mutable Agent, Workspace, Incident, Alert, Remediation, and configuration objects in the
  relational business store.
- Move current online presence and short-lived distributed state to Redis.
- Move mutable operational objects and current online state to their final stores.

Collector current state is the first completed Phase 4 migration; see
`docs/data-lifecycle-phase4.md`.
