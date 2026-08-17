# Data lifecycle Phase 14

Phase 14 moves Workspace inventory onto the same commit-aware reusable history path used by Agent
inventory and topology.

For aligned Dashboard windows, ClickHouse returns exact absolute ten-second Workspace buckets.
Closed buckets are reused across refreshes, while the recent boundary remains an exact query and is
merged with the hot delta after `eventId` overlap exclusion.

The bucket content preserves:

- first and last event time;
- exact event and risky-event counts;
- session, run, trace, and Collector identities;
- token and latency totals;
- worst severity and latest risk evidence.

Late events and newer decision revisions invalidate their event-time bucket through the durable
commit journal. Custom or unaligned ranges deliberately retain the previous exact query path.

No original event is deleted or sampled. Raw evidence remains in ClickHouse and is still used for
drill-down.
