# Data lifecycle Phase 5: relational business state

Phase 5 begins the migration of mutable business objects out of ClickHouse config rows.
The first bounded domain is Agent metadata and human identity review.

## Why this domain moves first

The previous representation rewrote one complete Agent registry document in ClickHouse. Two API
replicas editing different Agents could race and lose one another's changes. ClickHouse remains the
right store for immutable event and judgment facts, but not for frequently edited domain objects.

## Storage contract

- PostgreSQL stores one row per `agentAssetId` in `anysentry_agent_metadata`.
- The complete normalized domain object is stored as JSONB while searchable identity columns remain
  explicit.
- `updatedAt` provides last-write ordering; an older replica cannot replace a newer row.
- When stronger evidence changes a canonical asset ID, only aliases explicitly carried by the
  canonical record are removed, preventing stale identities from reappearing after refresh.
- API replicas refresh relational records every 15 seconds.
- Existing ClickHouse Agent metadata is read, merged by `updatedAt`, backfilled to PostgreSQL, and
  retained as a migration copy.
- Mutations dual-write PostgreSQL and ClickHouse during this phase.
- If PostgreSQL is not configured or temporarily unavailable, the API starts with the ClickHouse
  migration fallback rather than losing identity governance.

This fallback is for migration availability, not the final steady state. Production deployments
should set `ANYSENTRY_DATABASE_URL` and monitor `healthz.businessState.postgresqlReady`.

## Local baseline

Docker Compose includes PostgreSQL 17 and configures the API with:

```text
ANYSENTRY_DATABASE_URL=postgresql://anysentry:anysentry@postgres:5432/anysentry
```

Override the username, password, and database through
`ANYSENTRY_POSTGRES_USER`, `ANYSENTRY_POSTGRES_PASSWORD`, and
`ANYSENTRY_POSTGRES_DB`.

## Scope and next migration

This phase intentionally does not move every mutable object at once. Incident lifecycle, alerts,
remediation tasks, notification configuration, objectives, and audit-control metadata remain on
their existing path until their transaction and revision semantics are specified and independently
verified.

Run:

```bash
pnpm verify:data-lifecycle-phase5
```
