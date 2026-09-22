# Phase E evidence and coverage boundaries

Date: 2026-09-22. Branch `fix/langgraph-cross-agent-hop`. Design: `docs/generic-agent-service-observability-design.md`. This is a live-verification record, not a claim that the Goal is closed.

## Deployed tip

- API pod image: `127.0.0.1:5000/anysentry@sha256:bff81619b1fd58ad62b72de71545372959340662e3d9c189402a12c847a11208`
- Overlay tag: `run-point-20260922d`
- `ANYSENTRY_PROMETHEUS_URL=http://prometheus:9090`
- Platform metrics: `source=prometheus` `status=ready`

## Canonical point-reads (`timeType=last_2h`)

All of the following returned `coverage=complete` on the digest above.

| ID | Kind | Landed conversation | Kernel layer |
|---|---|---|---|
| `70141be3-4eb2-4aa0-ae03-5a049019a827` | Session + Run | `cv_096f6b1d` chat | complete, `no_kernel_event_expected` (in-memory plan tool) |
| `c5dec736-5dc7-42b0-ab59-0c2e37e56305` | Session + Run | `cv_eba788` chat | same |
| `s125-fanout-r1` | Session + Run | `cv_c92a6aff` worker | complete, `factCount=1` |
| `cv_23a18a6377ced4a3b7b213b9` | Session (A execute hop) | itself | complete, `factCount=1` |
| `cv_df08886c1da407fc6b6c593c` | Session (B execute hop) | itself | complete, `factCount=1` |

Also complete: `GET /v1/kernel-facts`, `GET /v1/evidence-links`, contract `anysentry.run.v1`.

Thread/run IDs that only exist as membership stubs are resolved once through the stub’s hop-fenced `conversationId`. List-window gap reasons are not inherited.

## Algorithm boundaries (kept)

- In-memory plan tools (`write_todos` and peers) stay `semantic_only` / `no_kernel_event_expected`. No invented FileAccess or kernel edge.
- LLM tool names (`run_python`, `run_in_sandbox`) fold onto wire/kernel (`http.code.execute` / Egress) by content fingerprint, same runtime, hop-compatible, 60s window. Fold only onto a backend that already owns Kernel.
- Parent hop (`cv_15e9d9f3`) stays kernel-unlinked. Child hop owns Kernel. Parent view does not import child kernel rows.
- 90s “no result” is suppressed when leftover fingerprint pairing already closed the call.

## Persistence / WAL

- Derived-lane drops on the digest: `asyncRawPersistenceDropped=0`, `asyncKernelPersistenceDropped=0`, `asyncDerivedPersistenceDropped=0`.
- `persistenceDropped` is the coverage-gap in-flight bound, not a derived-lane drop.
- Live spool: `FORWARD_SPOOL_PATH=/var/lib/anysentry-forwarder/spool-clean-20260915.wal`. Observer holds two fds on this inode. **Do not truncate.**
- Removed 2026-09-22: orphan compaction leftover `spool-clean-20260915.wal.1632171.1789873356423.tmp` (mtime 2026-09-20, not open, different inode from live WAL).
- Kept: `spool-clean-20260915.wal.dlq` (5.2Mi, mtime 2026-09-21). Dead-letter of rejected records; not open, but not discardable as live evidence.

## Phase C / D (live, not a formal fixture matrix)

- Phase C: `GET /v1/agent-instances/{host-root:…:194202:735969}?timeType=last_2h` and `/runtimes` are `complete`. Directory lists stay `partial` for mixed windows.
- Phase D: parent `cv_15e9d9f3` complete + kernel unlinked; child `cv_c92a6aff` complete + linked. No double-count of child kernel on the parent.

## Still open (Goal not closed)

- Live WAL continues to grow; pressure-window accounting is not a clean empty spool.
- Classic SSL / HTTPS remains WIP and out of this verification.
- Formal three-fixture matrix write-up (stateless HTTP, graph loop, parent→child) is sampled by LangGraph labs, not replaced by product-named branches.
- Old lab processes were left running for the live point-reads.
- Do not push.
