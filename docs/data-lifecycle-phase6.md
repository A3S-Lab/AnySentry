# Data lifecycle Phase 6: Workspace directory and temporal membership

Phase 6 gives Workspace identity and Agent-to-Workspace membership a durable lifecycle. Event rows
remain immutable facts; PostgreSQL stores the current directory and the effective-time association
history used by mutable inventory views.

## Identity contract

- `workspaceId` is the stable platform identity.
- `workspacePath` is an observed location and remains available for display and event filtering.
- An event's `workspacePath` remains its immutable process cwd. It does not automatically change
  Agent membership.
- Directory membership uses trusted Agent-root evidence: reviewed metadata, the attributed root
  process Workspace, or an event emitted by the root process itself. A child command changing cwd
  cannot create or replace an Agent-to-Workspace binding.
- `workspacePathFingerprint` joins a trusted supply-chain registration with runtime observations
  without exposing a local path in scanner tasks.
- `agentAssetId` identifies the observed Agent instance used by the existing identity-governance
  pipeline.
- An Agent instance has at most one active Workspace binding.
- Moving an instance closes the previous binding with `validTo` and opens a new binding with
  `validFrom`; history is never overwritten.
- Late events create bounded historical evidence and cannot replace a newer active association.

## Write paths

Both accepted event entry points update the directory projection:

```text
Universal/OTLP ingest ─┐
                       ├─ immutable event fact
Observer ingest ───────┘        │
                                └─ Workspace directory + temporal binding
```

Supply-chain scanner registration also updates the same directory. Its registered `workspaceId`
therefore becomes the stable identity later returned by Workspace inventory when a matching runtime
path is observed.

## Storage and availability

PostgreSQL tables:

- `anysentry_workspace_directory`
- `anysentry_agent_workspace_bindings`

The service maintains an in-process projection for low-latency lookups, persists changes in bounded
batches, and refreshes records from PostgreSQL every 15 seconds for multi-replica convergence.
PostgreSQL remains optional during migration: event judgment continues when it is unavailable, and
health reports whether the directory is relationally backed.

Operational endpoints:

- `GET /security-center/workspaces/directory`
- `GET /security-center/workspaces/bindings`
- `GET /security-center/healthz` under `businessState.workspaceDirectory`

Workspace inventory continues to expose `workspacePath` for compatibility and now also returns
`workspaceId` when the directory can resolve it.

Run:

```bash
pnpm verify:data-lifecycle-phase6
```
