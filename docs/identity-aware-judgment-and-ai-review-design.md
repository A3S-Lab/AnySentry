# Identity-aware judgment and read-only AI review

Status: implementation plan
Target branch: `feat/identity-aware-judgment`
Related Sentry branch: `feat/staged-judgment-sdk`

## Goal

Separate three decisions that were previously coupled by `FORWARD_SCOPE` and event `scope`:

1. retention decides whether an observed event reaches ClickHouse;
2. visibility decides which persisted identities a page shows;
3. judgment routing decides the deepest eligible Sentry tier.

The completed system must retain Unknown evidence for missed-Agent discovery, avoid treating
Non-Agent workloads as Agent assets, and prevent Unknown events from consuming L2/L3 while keeping
their original L1 risk evidence.

## Identity contract

| Effective classification | Retain new events | Default UI visibility | Agent asset | Judgment route |
| --- | --- | --- | --- | --- |
| `confirmed_agent` | yes | all + identified-Agent views | yes | full configured L1 -> L2 -> L3 chain |
| `probable_agent` | yes | all + identified-Agent views | yes | full chain by default; configurable L1-only |
| `unknown` | yes by default | all-events and search | no | L1-only |
| `non_agent` | no | historical/audit only | no | none |

`full` means eligibility for the next configured tier on escalation. It does not mean every benign
event is sent unconditionally to every model.

## Ownership boundaries

- Observer/collector discovers runtime identity, applies retention and independent noise policy,
  and forwards immutable attribution evidence.
- AnySentry resolves effective identity, snapshots the routing decision, persists events, dispatches
  Sentry stages, serves ClickHouse-backed search, and owns human/AI identity review.
- Sentry exposes generic staged risk-evaluation APIs. It must not depend on AnySentry's Agent
  classification vocabulary.
- The identity-review Agent uses only the `@a3s-lab/code` SDK. It is advisory and cannot mutate
  files, processes, workloads, events, metadata, or human review state.

## Retention and noise

Replace the overloaded scope preset with orthogonal controls while retaining a compatibility
mapping during rollout:

- `FILTER_MODE=enforce|shadow`
- `RETAIN_UNKNOWN=true|false` (default true)
- `RETAIN_NON_AGENT=false|true` (default false)
- `NOISE_POLICY=balanced|off`

Confirmed and Candidate are always retained. Unknown is not a noise reason. A drop must carry an
independent reason such as pseudo-filesystem lifecycle noise. High-value security evidence is never
dropped merely because identity is Unknown.

## Visibility and historical search

The dashboard defaults to `all observed events` with `includeUnknown=true`. The identified-Agent
view and Agent assets contain only Confirmed and Candidate. Unknown high-risk L1 findings remain
visible and link to event search and identity review.

Event search must query ClickHouse with cursor pagination. The 100,000-row in-memory ring remains a
low-latency dashboard cache, not a historical source of truth. Classification, stable identity,
runtime, and common filter fields should be promoted to queryable columns/materialized columns so
multi-million-row Unknown searches do not parse attribution JSON per row.

## Judgment policy and immutable routing snapshot

The editable policy gains:

```ts
interface IdentityJudgmentPolicy {
  candidatePipeline: "full" | "l1_only";
}
```

Default: `candidatePipeline="full"`. Confirmed is fixed to full, Unknown to L1-only, and Non-Agent
to discard. At ingest AnySentry snapshots effective classification, stable identity keys, policy
version, routing version, route profile, maximum tier, and route reason into the judgment job. A
later human identity change affects future events, not an already accepted job.

Unknown/Candidate-L1-only calls Sentry's staged `evaluateL1`. The original `allow`, `block`, or
`escalate` decision is persisted. An Unknown escalation stops with
`judgmentStopReason=unknown_identity_l1_only`; it is not rewritten to a benign allow. Because this
deployment is observe-only, enforcement disposition is separately recorded as observed/pass-through
and the UI never claims the kernel operation was blocked.

Confirmed/Candidate-full calls `evaluateThroughL2`. Only an eligible L2 escalation is dispatched to
the durable L3 worker. Missing model configuration reduces the actual maximum tier without changing
the requested route snapshot.

## Read-only direct-model identity reviewer

Two UI launch points (selected event and Agent asset) use one asynchronous backend capability. A
bounded in-process scheduler collects one redacted evidence snapshot and performs exactly one
non-streaming Chat Completions request. It does not create an Agent, Session or Memory Store and
does not expose tools. No A3S CLI process or legacy L3 bridge is allowed.

The reviewer always uses the **fast-review model profile**, shared with L2 only at the connection
level. It never falls back to the deep-investigation profile. L2 and identity review use independent
prompts, bounded evidence and histories. If the fast-review profile is unavailable, review is
unavailable. Credentials are never persisted in a review result.

The server builds the snapshot from allowlisted read-only evidence sources:

- event, trace, run, behavior, LLM-activity and metadata queries;
- PID-reuse-safe process/ancestry/cgroup/runtime inspection;
- Docker/Kubernetes metadata reads;
- bounded workspace listing, search and text reads rooted at the reviewed workspace.

The model cannot request more evidence or invoke shell, network, write/edit/patch/git, process
control, workload mutation, delegation or sub-Agent capabilities. A node-side evidence probe owns
any required host `/proc` access and validates collector/host/boot/PID/start-time scope. Paths are
canonicalized, symlink escape is rejected, evidence size is bounded, and credentials are redacted.

The structured output is advisory:

```ts
interface IdentityReviewResult {
  verdict: "agent" | "not_agent";
  confidence: number;
  summary: string;
  reason: string;
  evidenceRefs: Array<"target.json" | "events.json" | "processes.json">;
}
```

AI results live in an immutable review-history store. They never update Agent metadata directly.
The UI offers only valid human state transitions after displaying the recommendation.

## Delivery phases and commits

1. Sentry staged L1 API, bindings, tests and documentation.
2. AnySentry policy/routing snapshots and identity-specific L1-L3 dispatch.
3. Retention/noise separation, Unknown visibility, and ClickHouse cursor search.
4. Read-only evidence gateway and security boundary tests.
5. Bounded single-request identity reviewer, concurrency control and audit storage.
6. Event-detail and Agent-asset UI launch points.
7. Full builds, contracts, Docker/Kafka/Flink chain tests, real identity review and performance
   regression.

## Runtime model connections

The policy page exposes two operator-facing connections instead of one shared L2/L3 credential:

| Connection | Consumers | Isolation |
| --- | --- | --- |
| 快速研判模型 | L2 structured judgment and AI identity assistance | shared endpoint/model/key, separate prompts, evidence snapshots and histories |
| 深度研判模型 | L3 deep-investigation Agent only | independent endpoint/model/key, timeout, context and Agent pool |

URL, model, timeout and context limits are non-secret policy fields and may be persisted. API keys
are runtime credentials: the browser sends a key only for a bounded connection test; after a
successful test the operator may apply the tested connection. The API keeps the credential in
process memory and distributes it to judgment workers only through Redis Pub/Sub. It must never be
placed in BullMQ job data, Redis keys/lists/streams, ClickHouse, audit details, application logs, API
responses, browser storage or persisted policy JSON.

Redis Pub/Sub is deliberately used as an ephemeral control channel. Workers keep only the newest
version in memory and rotate cached L2 judges or the L3 Agent pool when a profile version changes.
Workers request the current snapshot when they start. API restart clears UI-provided credentials;
deployment-injected environment credentials remain an explicit compatibility source. A missing
runtime credential leaves L1 available and makes the affected higher tier visibly unavailable; it
must not silently report a successful full judgment.

Each profile has a compact test state: unconfigured, untested, testing, connected or failed. Failed
tests return a bounded, redacted reason (authentication, rate limit, timeout, network or invalid
response). A successful test returns a short-lived opaque apply token, never the key. Applying is
hot and does not require restarting API, fast-judge or L3 workers.

Each phase is committed separately. No branch is pushed and no package is published as part of local
delivery.

## Acceptance criteria

- Unknown is retained and searchable by default, including outside the hot ring.
- Unknown never invokes L2/L3 and retains high-risk/escalate L1 evidence.
- Candidate defaults to full and can be changed to L1-only.
- Confirmed follows the complete configured escalation chain.
- Non-Agent new events are discarded independently of noise handling.
- Sentry staged APIs prove by call-count tests that L1-only never contacts L2/L3.
- Identity review performs exactly one bounded, non-streaming model request and exposes no tools.
- The model cannot write, execute shell, control processes/workloads, request more evidence, or
  auto-apply an identity decision.
- Existing human review, display-name, evidence-chain, Flink/Kafka and dashboard behavior remain
  compatible.
