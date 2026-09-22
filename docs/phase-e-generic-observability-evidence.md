# Phase E evidence and coverage boundaries

Date: 2026-09-22. Branch `fix/langgraph-cross-agent-hop`. Design: `docs/generic-agent-service-observability-design.md`. This is a live-verification record, not a claim that the Goal is closed.

## Deployed tip

- API pod image: `127.0.0.1:5000/anysentry@sha256:1b3776a1bc196128b741559d37d25684d90c3a69625aebe65f2b240db7c1ccc0`
- Overlay tag: `invocation-20260922` (base `readiness-20260922b` / `a48377fe…`)
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

Also complete: `GET /v1/kernel-facts`, `GET /v1/evidence-links`, `GET /v1/agent-invocations/:invocationId`, contracts `anysentry.run.v1` and `anysentry.agent_invocation.v1`.

Thread/run IDs that only exist as membership stubs are resolved once through the stub’s hop-fenced `conversationId`. List-window gap reasons are not inherited.

## Algorithm boundaries (kept)

- In-memory plan/todo tools and in-process memory/lookup capabilities (`lookup` / `remember` / `recall` / `scratch` / `note` / `memo`, no kernel-shaped payload) stay `semantic_only` / `no_kernel_event_expected`. No invented FileAccess. Undeclared custom tools still use process-lineage. Relation algorithm `v10`.
- LLM tool names (`run_python`, `run_in_sandbox`) fold onto wire/kernel (`http.code.execute` / Egress) by content fingerprint, same runtime, hop-compatible, 60s window. Fold only onto a backend that already owns Kernel.
- Parent hop (`cv_15e9d9f3`) stays kernel-unlinked. Child hop owns Kernel. Parent view does not import child kernel rows.
- 90s “no result” is suppressed when leftover fingerprint pairing already closed the call.
- AgentInstance/RuntimeInstance ID point-reads use the matched row’s own coverage. Directory-window `partial` is not inherited. After a container exits, the instance hydrates from Session/conversation projection; no invented Kernel.

## Persistence / WAL

- Derived-lane drops on the digest: `asyncRawPersistenceDropped=0`, `asyncKernelPersistenceDropped=0`, `asyncDerivedPersistenceDropped=0`.
- Agent/topology reusable history no longer folds `last_1d` in one 128 MiB ClickHouse query. `CommitAwareFactBucketCache` builds at most one 6h chunk per refresh (`FACT_BUCKET_QUERY_CHUNK_MS=6h`, `MAX_CHUNKS=1`); later polls resume. Bucket-build settings also use `max_block_size=1024`. Live `POST /agents/directory last_1d` is HTTP 200 (1.0s then 13.6s) with no `MEMORY_LIMIT_EXCEEDED`. The previous 24h fold hit 131.71 MiB and fell back after error.
- `persistenceDropped` is the coverage-gap in-flight bound, not a derived-lane drop.
- Live spool: `FORWARD_SPOOL_PATH=/var/lib/anysentry-forwarder/spool-clean-20260915.wal`. Observer holds two fds on this inode. **Do not truncate.** Compaction threshold is `compactMinBytes=32Mi`. The file grew to ~33Mi / 5 records, then self-rewrote (compaction 9) to ~1.4–2.9Mi / 0 live records by 2026-09-22T07:47Z. `droppedEvents=0`, `outputDropped=0`, `spoolAtCapacity=false`. Dead bytes were reclaimed by the designed rewrite, not by truncation. `.dlq` (5.2Mi) is still kept.
- Removed 2026-09-22: orphan compaction leftover `spool-clean-20260915.wal.1632171.1789873356423.tmp` (mtime 2026-09-20, not open, different inode from live WAL).
- Kept: `spool-clean-20260915.wal.dlq` (5.2Mi, mtime 2026-09-21). Dead-letter of rejected records; not open, but not discardable as live evidence.

## Phase C / D

Repeatable gates: `GET /v1/observability/readiness` (`anysentry.observability_readiness.v1`) and `scripts/verify-phase-c-d-live.mjs`. The readiness GET is in-process: it does not open collection, does not scan ClickHouse, and does not promote candidate `ifr_*` drafts. After an API roll, poll until F0 realigns.

Live `last_1d` on digest `1b3776a1…` (2026-09-22T16:40Z), including the LangChain sample:

- 8 Session point-reads complete (thread IDs, `cv_*` hops, parent `cv_15e9d9f3`, `lc_aba557509de9432aa8c8` → `cv_c01225ad`)
- 4 Run point-reads complete
- 8 AgentInvocation point-reads complete: 1 parent view (`tool_kernel_unlinked`, no child KernelFact, `childDeepLink.runId` only), 2 child views (`kernelOwnership=owned`), the rest `local` (in-memory plan / expected-no-kernel)
- 9 AgentInstance point-reads complete after lab teardown, including docker IDs that now hydrate from Session projection (`state=exited`, `dataSource=conversation_projection`). Live RuntimeInstance list for those IDs is empty and `complete` with `no_live_runtime_instance`.
- parent hops kernel-unlinked: 4
- child hops kernel-linked: 2
- derived-lane drops remain 0
- EvidenceLink and KernelFact stores remain `coverage=complete`

Local contracts: generic `/runs/:param/nodes/:param` route shape; in-memory plan tools stay unlinked; parent coverage layers do not import child KernelFact.

## 11.2 one live window (mixed Agent + Infrastructure)

Recorded 2026-09-22T07:22Z from `POST /collectors/health timeType=last_1h` on collector `pjnl261070032`. Collection policy was not opened.

| Field | Value |
|---|---|
| observed (filter) | 163 |
| selected / forwarded | 524 |
| sampled | `unifiedSampleSuppressed=0` |
| aggregated | `captureAggregateOutputs=413` |
| filtered | non-agent 34, unknown 18 |
| ring dropped | 0 (`ringSubmitted=52137`) |
| collector dropped | 0 (`collectorReceived=collectorEnqueued=52137`) |
| forwarder / queue dropped | 0 |
| WAL/spool backlog | live WAL ~14Mi, `spoolRecords=1`, `spoolWalBytes=13562983`, not at capacity |
| query latency | Session point-read 1445 ms (`cv_23a18a63?timeType=last_1d`, complete) |
| canonical persistence | derived-lane drops 0; `pipeline.window.exact=true` |

Not executed (would require opening collection or a dedicated storm): unknown-host sustained, high-volume FileAccess, LLM/TLS fragment burst, many concurrent HTTP sessions, empty-WAL pressure window.

## 11.2 WAL/spool pressure window (live 32Mi rewrite)

Recorded across 2026-09-22T07:45–07:47Z on the same collector without opening collection. Compaction threshold is `compactMinBytes=32Mi`.

| Field | Peak (pre-rewrite) | After compaction 9 |
|---|---|---|
| observed (filter, last_1h) | 105 | 48 |
| selected / forwarded | 391 | 414 |
| sampled | `unifiedSampleSuppressed=0` | 0 |
| aggregated | (prior mixed window 413) | 391 |
| filtered | — | non-agent 24, unknown 1 |
| ring / collector / queue drop | 0 | 0 |
| WAL/spool backlog | ~33Mi, 5 live records, not at capacity | ~2.7–3.9Mi, 0 live records, not at capacity |
| query latency | — | 871 ms Session `cv_c01225ad?timeType=last_1d`, complete |
| canonical persistence | derived-lane drops 0 | derived-lane drops 0 |

This is a live-rewrite pressure window, not an empty-spool storm. The file was not truncated.

## 11.3 three-fixture matrix (generic shapes; LangGraph is a sample)

Recorded from `/tmp/s125-alias-fold-20260922` on digest `bff81619…`, then re-checked after lab teardown on `94482ba8…`.

| Fixture (design §11.3) | Sample input | Landed IDs | Observed | Not a product branch |
|---|---|---|---|---|
| 1. Stateless HTTP Agent — each POST an ephemeral Session | `POST /invoke` fanout `s125-fanout-r1` | Session/Run `s125-fanout-r1` → `cv_c92a6aff`; child Kernel `factCount=1` | generic `/invoke` route shape; per-request session; tool names `run_python`/`run_in_sandbox` fold onto execute Egress | Route is `/invoke`, not a LangGraph-named identity |
| 2. Stateful graph Agent — same thread, node loop in one Run | Design A `POST /runs` thread `70141be3-…` | Session/Run `70141be3` → `cv_096f6b1d`; nodes plan/work/verify | same thread kept; in-memory `write_todos` stays `no_kernel_event_expected`; execute hop `cv_23a18a63` owns Kernel | Node names are workflow labels, not a framework registry |
| 3. Parent → child Agent — views isolated | Design B orch→worker `c5dec736-…`; fanout parent `cv_15e9d9f3` | parent `cv_15e9d9f3` kernel `unlinked`; child `cv_c92a6aff` / B worker `cv_df08886c` kernel complete | parent does not import child KernelFact; delegation id is a hop fence | Child view is hop-scoped `cv_*`, not a merged parent timeline |

LangChain host `:18082` first returned 422 on `{"input":...}`. A later `POST /invoke {"message":...}` without wire anchors landed as ephemeral python Sessions (`cv_8fa36a60` complete, `cv_e1c02865` `tool_result_pending`); fixture-local `lc_*` 404. After the fixture put generic `x-anysentry-run-id` / `x-anysentry-session-id` on outbound LLM HTTP, `lc_aba557509de9432aa8c8` Session+Run point-reads are `complete` → `cv_c01225ad`, `sessionMode=conversation`, Run layer owns `lc_aba557509de9432aa8c8`. On digest `c18db377…`, in-process `lookup_fixture` is `semantic_only` / `no_kernel_event_expected` and the Session/Run kernel layer is `complete` (no invented FileAccess, no LangChain product name). Regression on `70141be3…`: `write_todos` stays `no_kernel_event_expected`; `run_in_sandbox` / `http.code.execute` stay `linked` / `delegated_command`. Host `:18082` remains stopped.

## F0 / F1 / F2 / F3 and process generation

Repeatable gates: `GET /v1/observability/readiness` and `scripts/verify-phase-f0-f3-live.mjs`. Live on digest `a48377fe…` (2026-09-22T16:35Z):

- Catalog: 61 rules. Observer node `pjnl261070032` F0/F1/F2 `ready` + `aligned` on shared epoch `1790057274239030`. F3 is API-local `ready`.
- 16 candidate `ifr_*` drafts were merged from remaining exact/logical non-Agent k8s inventory (`aggregate` only, never drop). They stay `draft` / `candidate` and are **not** in the Forwarder identity projection (`intentHash` unchanged `9c7f97ff…`). `verify-unified-filter-rule-deployed.mjs` PASSes; catalog P95 15ms after a 60s sync TTL.
- Pollable readiness: `ready=true`, `collection.globallyOpened=false`, `enforcedInfrastructureRules=0`, C/D/E/F0–F3 all ready. Derived-lane drops remain 0.
- Forwarder projection: `intentHash` stable across TTL refresh; `contentHash` covers transport timestamps.
- Agent-vs-infrastructure conflict example: F1 and F3 both keep `fr_guardrail_agent_conflict_keep`.
- Explain on remaining inventory `service:k8s:default-cluster:anysentry:a3s-observer` (`bindingQuality=exact`): stages `f0→f1→f2→f3`, 4 facts.
- Process generation on a RuntimeInstance: `pgk_ac7ab74ac74cfe936e648002`, `physicalWorkloadId=docker:…`, `hostId` + `rootPid` + `rootStartTimeTicks`. Same PID different start time does not inherit AgentInstance (local contract).
- Materialization reports remain 0. Candidate drafts are catalog-visible F0 context, not enforced capture.

## Candidate discovery and cold-start collection bound

Repeatable gate: `scripts/verify-phase-candidate-coldstart-live.mjs` (wraps `verify-behavior-discovery.mjs` + `verify-filter-rule-snapshot.mjs`). Live on digest `94482ba8…` (2026-09-22T07:38Z). Collection policy was not opened.

- Local: behavior window `behavior-window-v1`; score/threshold; generation-fenced cold-start key; `fr_builtin_behavior_candidate` snapshot lineage.
- Live plane: `filterMode=enforce`, `captureProfileMode=enforce`, control plane `ready`, unified projection `ready`, `filterRuleEnforceDrops=true`.
- Grant is not global: `captureProfileActivationMode=preview`, reason `scope_expired`.
- FileAccess stays layered: `infrastructure_aggregate=drop`, `unknown_discovery=sample`, `agent_full=full`.
- `discoveryBudgetDropped=0`. Identity snapshot `ready` with 28 entries. `dockerEntries=2` after lab teardown (not a compose-agent inventory).
- `retainUnknown=false` / `retainNonAgent=false`: unknown is sampled, not retained as a global lossless open.

## 11.4 against this digest

| Criterion | Status |
|---|---|
| Candidate/Confirmed identity has explainable evidence | Met for remaining Observer service, process-generation keys, and `fr_builtin_behavior_candidate` |
| F1/F2/F3 share rule lineage / epoch | Met for F0–F2 Observer ACK; F3 is API-local ready. `GET /v1/observability/readiness` is the pollable surface |
| No unexplained Ring/Collector/Forwarder/WAL drop | Met on the one mixed 11.2 window; live WAL still grows |
| Plaintext / KernelFact / Session / Run coverage reported separately | Met |
| Parent/child not double-counted or merged | Met |
| Canonical point-read `coverage=complete` | Met for Session/Run/AgentInvocation/EvidenceLink/KernelFact and hydrated AgentInstance |
| Failure/ambiguity stays partial/ambiguous/unlinked | Met (`semantic_only` / `no_kernel_event_expected` for in-process lookup and plan tools, parent `unlinked`, empty runtimes `no_live_runtime_instance`) |
| Query latency and WAL backlog in budget | Agent directory `last_1d` stays inside the 30s in-flight timeout; not an empty-WAL pressure proof |
| No product-name / tool-name / fixed-port identity | Met for the accepted algorithms |

## Still open (Goal not closed)

- Live WAL continues to grow; pressure-window accounting is not a clean empty spool.
- Classic SSL / HTTPS remains WIP and out of this verification.
- Four of six §11.2 windows were not run (unknown-host, FileAccess, LLM/TLS burst, many HTTP sessions). Empty-WAL storm was not run; the 32Mi live rewrite is recorded instead.
- Candidate `ifr_*` drafts are catalog-visible only; they are not enforced and have no materialization reports.
- LangGraph compose remains down. Host LangChain `:18082` was started once for the message-body sample and stopped again. k8s control plane, Observer, Prometheus, and `anysentry-local-registry` were left running.
- Do not push.
