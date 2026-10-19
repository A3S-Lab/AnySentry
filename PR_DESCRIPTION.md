# Summary

- Reorganize the AnySentry Console around AI assistance, global operations, alert response, Agent observability, deployment, and administration workflows.
- Add a dedicated AI Assistant page with seven investigation capabilities, capability-aware suggested questions, new-session controls, and a right-side conversation history drawer.
- Add browser-local Assistant session history with bounded retention and graceful fallback when storage capacity is limited.
- Add a Conversation Tracking entry and placeholder page for the future server-side conversation and evidence model.
- Split Agent presentation into Agent inventory and runtime-instance views, add card and trend modes, preserve precise `agentInstanceId` deep links, and improve navigation back to the originating Agent view.
- Improve the Runtime Chain experience by preserving the currently displayed event snapshot and showing newly polled events as pending updates instead of moving the investigator's scroll position.
- Add a Platform Monitoring page backed by Prometheus, node-exporter, cAdvisor, ClickHouse metrics, and low-cardinality AnySentry HTTP metrics.
- Add compact CPU, memory, disk, API latency, component-health, and resource-trend views to Runtime Overview without querying security-event history for infrastructure metrics.
- Add a PostgreSQL-backed local user directory with fixed governance roles, searchable user management, audit records, and a Sidebar user control.
- Add TanStack Query request deduplication, lazy route loading, route prefetching, and adaptive list virtualization for large result sets.
- Load Dashboard data only for the active view, prevent overlapping polling work, and reduce duplicate API requests during route transitions and refreshes.
- Improve ClickHouse query planning with mutually exclusive durable and hot-tail ranges, bounded representative-event hydration, chunked ID lookups, service-side single-flight, and commit-aware cache gap consolidation.
- Replace per-event ClickHouse writes with configurable micro-batching while preserving acknowledgement only after durable acceptance.
- Add stable event revision identities, server-side commit timestamps, deterministic `commitBatchId` values, replay-safe four-field cursors, and versioned source commit progress.
- Add commit-bounded Dashboard snapshots with checksums and safer cold-start hydration.
- Make business-effect application transaction-aware so persisted judgments, alerts, incidents, remediation state, notifications, and audit effects cannot be partially applied without explicit reconciliation.
- Add a durable Observer spool with bounded retries, backoff, absolute retry deadlines, partial-acceptance accounting, and graceful shutdown draining.
- Tighten Agent attribution by excluding Codex helper processes and infrastructure workloads from independent Agent roots while preserving valid parent Agent lineage.
- Prevent infrastructure candidates with no LLM evidence from being automatically promoted to confirmed Agents.
- Scope Flink risk-profile identity by `agentInstanceId`, with compatibility fallback for older events, so separate runtime windows of the same logical Agent do not share one risk profile.
- Add migration and verification tooling for query columns, source commit progress, write batching, forwarder durability, business-effect transactions, Web performance, and runtime data lifecycle guarantees.

# Why

## Console usability and investigation continuity

The previous Console exposed most capabilities, but navigation, Agent inventory, runtime instances, platform health, and Assistant workflows were mixed together. The new information architecture separates these responsibilities and makes common investigation paths easier to follow.

Live polling also replaced the event list while an investigator was scrolling or reviewing an event. Runtime Chain now keeps the visible snapshot stable and lets the user explicitly load newly received events, preserving the current investigation context.

## Frontend performance

Every route previously contributed more code and could trigger overlapping requests even when its data was not visible. Secondary pages are now split into lazy chunks, likely navigation targets can be prefetched, same-key requests share one in-flight query, and large lists switch to virtual rendering.

Dashboard requests are scoped to the active view. Monitoring freshness is preserved, while route changes, repeated mounts, and slow polling cycles no longer create unnecessary duplicate work.

## Backend query performance

Historical Agent and Dashboard queries previously mixed committed history with the hot tail, performed repeated scans for adjacent gaps, and could send large event-ID sets through one request. The new query path separates durable and uncommitted time ranges, consolidates cache gaps, bounds representative-event hydration, and shares identical concurrent aggregations.

Platform resource metrics are stored and queried through Prometheus rather than inferred from security events. This prevents frequent CPU, memory, disk, and API-health refreshes from scanning the ClickHouse event history.

## Persistence and replay safety

Per-event writes created unnecessary ClickHouse insert pressure, while incomplete commit identity made retries, replay, pagination, and snapshots harder to reason about. Configurable micro-batching reduces insert overhead without acknowledging an event before ClickHouse accepts it.

Stable revisions, server commit time, deterministic batches, complete cursors, and snapshot boundaries ensure that historical reads can distinguish committed facts from the in-memory tail and can resume without skipping or duplicating revisions.

Business effects are now tied to explicit transaction state. A persisted judgment cannot silently leave only part of its alert, incident, remediation, notification, or audit effects applied.

## Observer durability and attribution accuracy

Temporary downstream failures previously risked losing forwarding state or producing ambiguous retry outcomes. The durable spool records pending envelopes locally, retries within a bounded deadline, accounts for partial HTTP acceptance, and drains safely during shutdown.

Codex helper processes and infrastructure services could also appear as standalone Agents. Parent-lineage inheritance, internal-helper exclusion, infrastructure negative evidence, and stricter review rules reduce false Agent assets without deleting the underlying runtime facts.

## Operational visibility

AnySentry previously showed security activity but did not provide enough host, container, API, and component health information to explain why the platform itself was slow or unhealthy. The new Prometheus-backed monitoring path provides real operational metrics and explicit fallback behavior when Prometheus is unavailable.

# Existing Pipelines

This iteration does **not** introduce the Kafka/Flink shadow pipeline or the OSV supply-chain pipeline; both already existed before this change.

The Flink change in this iteration is limited to runtime-instance isolation and compatibility updates:

- Prefer `agentInstanceId` as the risk-profile entity key.
- Fall back to the previous correlation identity for older events.
- Persist and expose the instance identity through stream findings and Dashboard views.
- Add regression coverage preventing separate runtime windows from sharing one profile.

The existing OSV and streaming pipelines were exercised during merge validation, but they are not presented as newly added capabilities in this change.

# Merge Compatibility

The branch was updated with the latest `main` changes. Conflict resolution preserves the newer Agent lifecycle, trusted-correlation, capture-governance, and unified-filter capabilities while retaining this branch's:

- ClickHouse micro-batching.
- Event revision identity and conflict detection.
- Server-side commit timestamps and stable commit batches.
- Replay-safe commit cursors.
- Dashboard snapshot commit boundaries.
- Observer partial-rejection accounting and bounded retry behavior.

# Validation

The final merged result has passed:

- Full API and Web builds.
- Local contract verification.
- Data Lifecycle Phase 1 through Phase 17.
- Dashboard runtime and deep-link contracts.
- Web performance contracts for route splitting, request deduplication, and list virtualization.
- Observer attribution, filtering, forwarding, durability, and accounting checks.
- ClickHouse write-buffer, query-bound, bootstrap, revision, cursor, and snapshot checks.
- Business-effect transaction verification.
- Streaming runtime verification.
- Flink job and checkpoint verification.
- Real OSV supply-chain runtime verification.
- Redis AOF recovery and persistence verification.

The API, ClickHouse, PostgreSQL, Redis, Kafka, Flink, Prometheus, and associated workers were healthy during final runtime validation.

# Current Boundaries

- Assistant history is currently stored in browser `localStorage`; it is not a server-side conversation record.
- Conversation Tracking is currently a placeholder and does not yet capture native user instructions or link messages to Trace, Event, or Evidence entities.
- The user directory is a governance directory, not an authentication system. It does not provide login sessions, passwords, or request-level RBAC.
- L2 and L3 activation still depends on deployment policy and model endpoint configuration.
- Agent recognition is intentionally not forced to 100%; uncertain workloads remain candidates instead of being automatically confirmed.
- `streaming/flink/target/` is a local build output and is intentionally excluded from the commit.
