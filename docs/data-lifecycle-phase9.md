# Data lifecycle Phase 9

Phase 9 makes operational evidence append-only instead of storing bounded JSON arrays in the
ClickHouse configuration table.

## Immutable fact tables

- `notification_delivery_facts`: one immutable notification outcome per `deliveryId`;
- `identity_ai_review_revisions`: the complete `running -> succeeded/failed` lifecycle, ordered by
  a monotonic revision within each `reviewId`;
- `audit_facts`: one immutable management audit event per `auditId`.

Dashboard reads deduplicate idempotent retries by stable ID. Identity review lists project the
latest revision with `argMax(payload, tuple(revision, ingestedAt))`; previous revisions remain
queryable evidence.

## Migration

The former `notification_state`, `identity_ai_reviews`, and `audit_log` config documents remain
read-only migration sources. When a new fact table is empty, the API imports the legacy records
idempotently. New writes never append delivery or audit arrays to the config table.

Mutable notification channels and routes remain authoritative in PostgreSQL and retain their
ClickHouse migration copy.

## Verification

```bash
pnpm verify:data-lifecycle-phase9
```
