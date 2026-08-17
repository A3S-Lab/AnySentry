# Data lifecycle Phase 7: durable mutable security operations

Phase 7 moves Incident, Alert, and Remediation state out of process-local Maps and full-document
ClickHouse configuration rows. PostgreSQL stores each mutable business object independently while
ClickHouse retains the migration and audit copy.

## Storage contract

PostgreSQL tables:

- `anysentry_incidents`
- `anysentry_alerts`
- `anysentry_remediations`

Every object is keyed by its stable domain identifier and stores a JSONB representation plus indexed
status, severity, scope, and update-time columns. Writes are transactional per batch and use
`updatedAt` ordering so an older API replica cannot overwrite a newer state.

```text
API mutation / generated state
          │
          ├─ PostgreSQL per-object UPSERT (business-state authority)
          └─ ClickHouse state copy (migration and audit fallback)
```

The services restore the ClickHouse migration copy first and then merge PostgreSQL records. The
newest `updatedAt` wins. A 15-second PostgreSQL refresh converges independent API replicas without
replacing unrelated records.

## Domain behavior

- Incidents are re-derived from immutable event facts during startup and merged with durable
  PostgreSQL records. PostgreSQL also restores an Incident outside the event hydration window.
- Alerts persist acknowledgement, resolution, silence, notification, ownership, and occurrence
  state independently.
- Remediations persist workflow status, owner, notes, due time, completion, and steps independently.
- ClickHouse unavailability does not erase PostgreSQL state.
- PostgreSQL unavailability leaves the existing ClickHouse migration path operational.

Health reports all three domains under:

```text
GET /security-center/healthz
businessState.incidents
businessState.alerts
businessState.remediations
```

Each entry exposes the in-process record count and whether PostgreSQL is currently backing the
domain.

Run:

```bash
pnpm verify:data-lifecycle-phase7
```
