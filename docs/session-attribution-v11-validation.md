# Session attribution v11 — 2026-09-08

## Changes

- Interactive (`persist:false`) and background attribution load the same host/boot competing bindings; collector boundaries cannot hide an overlapping Session.
- Missing/truncated binding context yields partial, unattributed evidence. Transient lookup failure does not supersede persisted decisions.
- Missing-root reconstruction rejects foreign runtime instances and competing scopes; majority event volume is not ownership evidence.
- Parent edges require comparable boot-scoped start times, with parent start <= child start. Equal-tick forks remain supported; unknown/mixed units cannot establish lineage.
- Observer-request-derived bindings carry `observer_request`, rather than claiming `/proc/fd` evidence.
- Attribution version is 11. On PostgreSQL initialization, active older relations are retained but invalidated and marked `requiresReattribution`. This is not a claim that full historical replay has finished.
- Native event names (`ToolExec`, `ProcessExit`, etc.) and UI categories are unchanged.

## Verification

Run API build to completion **before** tests; Nest rebuild replaces dist files.

```bash
cd /home/zhongyule/code/AnySentry/apps/api
npm run build
cd /home/zhongyule/code/AnySentry
for round in 1 2 3; do
  node scripts/verify-session-event-attribution.mjs || exit 1
  node scripts/verify-local-record-tracking.mjs || exit 1
done
node scripts/verify-a3s-code-local-record-tracking.mjs
ANYSENTRY_TEST_POSTGRES_CONTAINER=anysentry-postgres-1 node scripts/verify-session-attribution-store.mjs
```

The PostgreSQL integration test shadows the relation table with a temporary table and rolls back fixture changes. It does not migrate live records. Tests cover read/write path parity, input ordering, concurrent and nested Sessions, unavailable context, start-generation ordering, runtime identity mismatch, namespace transitions, provenance, query-cap overflow, and migration idempotency.

## Deployment boundary

This change does not start Observer or generate new captured model requests. The existing Docker API is not automatically replaced by a local build. Historical migration takes effect when the updated API initializes PostgreSQL. Old relation records remain available for audit; active-session background processing and on-demand evidence reads use the new algorithm, but a complete historical persisted replay is a separate operation.

Remaining coverage limits: unobserved Session ownership, missing lifecycle facts, and truncated family queries cannot be treated as fully validated historical attribution. Passing fixture tests does not establish that every existing Session is correctly attributed.

## Follow-up read-only production-data sample

`scripts/audit-session-attribution-readonly.mjs` reads PostgreSQL bindings and ClickHouse lifecycle facts without initializing either production store or writing decisions. Queries use one thread, 128 MiB memory and an 8-second server timeout. Initial broad/OR queries timed out; the successful run separated exact-root lookup from the parent-key query.

Four Session samples (each two minutes around its selected generation's latest root fact):

| Native Session | Result |
| --- | --- |
| `18d2ee1efff9427f-724be` | 1 direct fact, no child facts in window |
| `01a01383-65fc-7c01-9401-1cc0cdef1ce9` | Selected PID 1534197 had no root fact; not validated |
| `01a06747-6a98-7f90-ba5d-5af282d5fa4e` | 1 direct / 26 lineage facts |
| `01a06739-679e-71e2-8856-66610b3963c0` | 1 direct / 19 lineage facts |

The three available samples produced identical counts and event IDs on two fresh v11 service evaluations. These are root/direct-child identity replays, not complete process-family, command, API, or model-payload validation. They do not prove every attribution is correct.

Live API was still v10 during this follow-up. Observer was already running, contrary to the previous turn's deployment assumptions; this audit did not start/stop it. New PostgreSQL no-op-write changes overlap the same store module; their SQL and persistence-single-flight verification also passed. API rollout is pending confirmation of whether to include those overlapping performance changes.

## Writable-FD hardening follow-up

The native Session scan now requires a known Session path plus parseable writable FD access (`O_WRONLY` or `O_RDWR`). Read-only, `O_PATH`, missing or denied fdinfo, and malformed flags do not create a binding. The scan rechecks link target and access flags, then process start time/comm/cmdline. A changed or missing launcher falls back to the verified native process, not the stale launcher generation.

Only matching Session paths incur fdinfo reads. These are conservative snapshot checks, not an atomic kernel ownership proof: writable access alone still does not establish turn-level causality or eliminate all possible FD ABA races.

`scripts/verify-session-fd-ownership.mjs` adds 16 cases (access modes, malformed/missing/denied metadata, PID reuse, process exit, exec change, FD replacement and access-mode change). All 16 passed in three rounds, together with the attribution, Codex local-record and A3S local-record suites. Existing fixtures now explicitly provide writable fdinfo instead of relying on missing access metadata.

Testing used isolated TypeScript output `/tmp/anysentry-fd-test-5Cq5LD` to avoid shared dist rebuilds. A full-workspace compile found an unrelated `src/main.ts:29` error (`app.close(signal)`, expected zero arguments); that other change was not edited. No API/Observer rollout or historical data mutation was performed in this follow-up.

## 2026-09-08 API rollout and live verification

API-only rollout completed with image `sha256:7e4e30f7f77cdceab9e9ed75ed6e6da808cfbe6de839720c8d183435603571ce`; health is healthy. Observer retained container `ae75f48b1adbfffa78396feb93a4700d6b6324a5991df505dcf1a950cd061d7f` and its original 05:14:02 UTC start time.

Background reconciliation now isolates per-Session exceptions, logs failures and preserves its checkpoint on thrown errors. It can read recent Observer request identities without content. Durable binding reuse requires an independently supplied matching host, boot, namespace and process key as well as PID/start and supplied tenancy/runtime ownership context. PID/start alone never authorizes reuse. Added foreign-host/boot and missing-scope regression checks passed; isolated TypeScript compilation and local-record tests passed.

The live database sample contained 125 v11 results and 125 active relations: 98 LINEAGE relations for native Session `01a01383-65fc-7c01-9401-1cc0cdef1ce9`, PID 2727446, ticks:8883423; 27 for `019fa6c6-84c2-7931-b38e-95bbb8868bd8`, PID 2736622, ticks:8894206. No event in the active-relation sample had multiple conversation owners. This is a consistency check, not independent proof of every lineage edge.

Acceptance remains partial: local-record status/list returned HTTP 200 in 4.40/13.00 seconds after the final rollout, but a detail request with system evidence timed out after 20 seconds. An isolated service process discovered 194 records in 89 ms, so earlier speculation that all delay came from file discovery is unconfirmed. API contention and ClickHouse query latency need further diagnosis. Older relations were retained but deactivated; a complete historical v11 backfill has not been performed. Observer logs reported payload_capture_enabled=false, so this rollout did not validate new plaintext capture.

## 2026-09-08 System Evidence latency follow-up

Interactive System Evidence now prefers durable PostgreSQL relations already written by the
background reconciler, then hydrates event bodies by ID. When nothing is persisted yet, the live
ClickHouse family walk uses a lower fact floor (128), depth cap (6), and skips the legacy
events-table fallback. Active Sessions use a 2-hour interactive lookback instead of 24 hours, and
background reconciliation yields while an interactive evidence walk is in flight. Startup lifecycle
hydration was reduced from a 30-minute ordered scan to a 5-minute bounded sample so API restarts do
not starve the first detail requests.

API-only rollout image `sha256:744352e60f49bbddea002c7f8799950634fcdf8d0ea88595470b50a5533035f6`
(`anysentry-api:evidence-20260908`). Observer retained start time `2026-09-08T05:14:02Z`.
Fixture suites `verify-session-event-attribution` and `verify-local-record-tracking` passed.
Live contended detail checks returned HTTP 200 in under one second for the persisted path and
about 6 seconds for a cold/live walk on Session `01a01383` (evidenceLimit≈500), both under the
previous 20-second timeout. PostgreSQL still held 219 active relations / 219 v11 attribution
results after the rollout.

## 2026-09-08 Historical v11 backfill

Added `scripts/backfill-session-attribution-v11.mjs` (dry-run by default; `--write` to persist).
Run it in an isolated container with its own memory limit — executing inside the API cgroup OOMed
the shared 2 GiB budget. Relation reconcile was scoped to the binding IDs owned by the current
calculation so sibling historical bindings no longer clear each other's active edges.

Bounded per-binding replay (latest binding per native Session, ≤24h window, eventLimit 128)
reduced uncovered Sessions that still needed reattribution from 41 to 0. After the pass PostgreSQL
held about 11,190 active v11 relations. Two Sessions only produced evidence on alternate bindings
after their newest generation returned an empty family; those alternate bindings were replayed
explicitly. Old invalidated rows remain as audit history with `requiresReattribution=true`.

This is still not a claim that every historical event has been re-attributed end-to-end, and
plaintext Observer capture remains unvalidated (`payload_capture_enabled=false`).
