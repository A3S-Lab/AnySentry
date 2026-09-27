# Data lifecycle Phase 16

Phase 16 makes closed Dashboard history reusable after an API restart and across API replicas
without turning an aggregate into the source of truth.

## Storage contract

- `events` remains the canonical event and judgment-revision fact table.
- `event_commit_facts` remains the invalidation authority.
- `dashboard_bucket_snapshots` stores append-only, complete JSON snapshots of fixed event-time
  buckets.
- A snapshot records the exact global commit cursor against which it was computed.
- The latest snapshot is selected by the full commit cursor and write version, not by insertion
  order alone.

The snapshot table uses `MergeTree`, not `ReplacingMergeTree`. Historical snapshot revisions remain
auditable until TTL expiry, while queries select the latest proven revision.

## Read contract

For an aligned Dashboard interval:

1. Load the latest stored snapshot for each bucket.
2. Read the latest retained commit cursor for each affected event-time bucket.
3. Reject a snapshot when its cursor is older than a commit in that bucket.
4. Reject all snapshots whose cursor predates the oldest retained commit-journal row.
5. Recompute missing buckets from exact event facts after folding to the latest
   `decisionRevision`.
6. Persist the complete replacement only when the global commit cursor did not move during the
   exact computation.

Empty buckets are persisted as empty snapshots. Snapshot read or write failures fall back to the
exact raw aggregation and do not make the Dashboard unavailable.

## Guarantees

- A cold API process can reuse closed historical buckets.
- Multiple API processes can share the same persisted optimization.
- Late events and newer judgment revisions invalidate only affected buckets while the journal is
  continuous.
- A commit-journal retention gap forces exact reconstruction.
- Snapshots never replace canonical evidence and never drive Flink keyed state.

## Remaining runtime gate

This phase is verified offline. Before production rollout, run a controlled ClickHouse benchmark
that records `read_rows`, `read_bytes`, peak query memory, API RSS, and Dashboard P95/P99 across
cold start and repeated refreshes.
