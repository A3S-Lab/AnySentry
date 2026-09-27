# Data lifecycle Phase 4

Phase 4 starts the distributed current-state layer without changing the historical source of
truth.

## Collector current state

- ClickHouse remains the durable history for every Collector heartbeat.
- Redis stores only the latest heartbeat per Collector with a bounded TTL.
- The Redis update is atomic and monotonic by heartbeat time. An older heartbeat received by
  another API replica cannot overwrite a newer state.
- Collector health combines ClickHouse window history, ClickHouse latest facts, Redis current
  state, and the local uncommitted fallback.
- Redis failure never rejects Observer ingestion. Queries degrade to ClickHouse plus the local
  snapshot and expose the actual data source in query coverage.

Redis current state is not a historical database. Expired Redis keys do not delete ClickHouse
facts, and a historical `snapshotAsOf` remains answerable from ClickHouse.

## Source current state

- Source configuration, token hashes, ownership and cumulative audit counters remain in the
  durable source registry. Redis is not the configuration database.
- Every accepted event or heartbeat publishes a compact latest-activity record keyed by
  `sourceId`.
- Redis updates are atomic and monotonic by activity time, so delayed requests cannot replace a
  newer check-in.
- API replicas refresh the distributed activity snapshot periodically and immediately before the
  Sources list or durable coverage query.
- Redis failure degrades to the durable source registry and the local update made by the accepting
  API process; it never rejects ingestion.

## Remaining Phase 4 work

- Agent metadata and identity review have entered the relational migration in Phase 5.
- Workspace directories, Incident, Alert, Remediation, and configuration objects still need
  bounded domain-by-domain migration.
- Each mutable domain must pass dual-write/read verification before its legacy ClickHouse or
  memory persistence is removed.
## Next phase

Mutable Agent metadata and human identity review begin their PostgreSQL migration in
`docs/data-lifecycle-phase5.md`.
