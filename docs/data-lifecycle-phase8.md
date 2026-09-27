# Data lifecycle Phase 8

Phase 8 completes the mutable business-state migration started in Phase 5.

## PostgreSQL authoritative objects

- ingestion sources;
- maintenance windows;
- notification channels and routes;
- objectives;
- the active L1/L2/L3 judgment policy.

Every collection is stored as one row per stable object ID and guarded by `updatedAt`. API
replicas refresh PostgreSQL every 15 seconds and merge only newer revisions. During migration,
the existing ClickHouse config documents remain as compatibility copies.

## Facts that remain in ClickHouse

- notification deliveries;
- identity AI review trails;
- audit records;
- event and judgment revisions;
- heartbeats, trends, and relationship facts.

These are append-oriented evidence, not mutable configuration objects. Model credentials remain
in the runtime connection store and are never persisted in the policy document.

## Failure behavior

If PostgreSQL is not configured or temporarily unavailable, services continue from their
ClickHouse migration copy. `/security-center/healthz` reports both the PostgreSQL backing state
and the object counts for every Phase 8 domain.

## Verification

```bash
pnpm verify:data-lifecycle-phase8
```
