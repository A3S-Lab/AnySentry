# Agent Discovery and Observation Filter

Status: implemented and development-environment verified on `feat/agent-discovery-filter`

The final acceptance target is the complete
`AnySentry-Agent-Discovery-High-Performance-Design.md` roadmap, not only the first Kubernetes
filter increment. Work is delivered in independently testable stages, but a stage is complete only
when its result is reconciled with the remaining roadmap.

## Scope

This feature reduces the volume of unrelated kernel events that reach AnySentry while preserving
the evidence required to discover previously unknown Agent workloads. It is an observation-only
pipeline. It does not make allow/deny decisions, attach enforcement programs, or change the
behavior of monitored workloads.

The implementation spans two repositories:

- Observer captures stable node and process facts and emits them in its NDJSON contract.
- AnySentry resolves those facts to physical workloads and logical Agents, keeps the identity
  registry, filters at the node forwarder, records filter metrics, and displays the resulting
  attribution.

The filter is an identity and event-routing layer in front of Sentry. L1/L2/L3 risk judgment stays
unchanged and receives only the events selected by this layer.

## Discovery modes

The registry has two complementary discovery modes. Both produce the same attribution envelope
and classification state machine.

### Operator templates

An operator can declare how an Agent is deployed without enumerating every runtime identifier.
Templates are trusted configuration and may be intentionally concise:

```json
{
  "schemaVersion": "anysentry.agent_templates.v1",
  "templates": [
    {
      "id": "claw-production",
      "agentId": "claw",
      "deployment": "docker",
      "name": "claw"
    },
    {
      "id": "review-agent",
      "agentId": "review-agent",
      "deployment": "kubernetes",
      "match": {
        "namespace": "agents-*",
        "pod": "review-*",
        "container": "agent"
      }
    },
    {
      "id": "host-codex",
      "agentId": "codex",
      "deployment": "host",
      "match": {
        "systemdUnit": "codex*.service",
        "executable": "codex"
      }
    }
  ]
}
```

`deployment` is `host`, `docker`, `kubernetes`, or `any`. A short `name` is matched against the
deployment's natural identity fields (unit/executable, container/image, or Pod/container/owner).
The optional `match` object narrows the result. Exact label and explicit-field matches are stronger
than fuzzy name matches. A template may explicitly declare `classification: "non_agent"`; absence
of an Agent template is never by itself positive non-Agent evidence.

Templates are loaded from `ANYSENTRY_AGENT_TEMPLATES_FILE` or
`ANYSENTRY_AGENT_TEMPLATES_JSON`. Invalid or ambiguous templates fail open and increment a
configuration/error counter. They never enter the kernel or execute arbitrary expressions.

### Framework discovery

The framework also discovers previously unknown runtimes. It keeps a bounded, expiring workload
window containing counters and small sets rather than raw event history:

```text
LLM endpoint activity
tool executions and unique tools
LLM/tool alternation
workspace file activity
network targets
child-process fanout
```

Lightweight deterministic scoring can promote `unknown` to `probable_agent`. Behavior alone never
produces `confirmed_agent`; confirmation requires a trusted template, platform registration, or
other authoritative binding. Hysteresis prevents a candidate from oscillating on every event.
No LLM call is used in this detection path.

The two modes are additive: an operator template gives immediate attribution, while framework
discovery covers missing, incomplete, or newly introduced deployments.

Set `ANYSENTRY_BUILTIN_AGENT_HINTS=off` on both the forwarder and API to disable the built-in
Codex, A3S Code, and Claude Code executable/argv hints for behavior-only discovery experiments.
`ANYSENTRY_AGENT_ROOT_NAMES` remains available for an explicit custom root-name set, and operator
templates are independently disabled by leaving both template variables unset or by setting
`ANYSENTRY_AGENT_TEMPLATES_JSON=[]`.

## Required properties

1. Workload identity is evaluated before process-name heuristics.
2. Unknown identity is not equivalent to non-Agent identity.
3. Only a complete, positive non-Agent classification may be filtered.
4. Process lifecycle and high-signal security events are retained for discovery and audit.
5. Kubernetes, Docker, regular host processes, and short-lived processes use the same event
   envelope.
6. No Kubernetes API, Docker API, database query, regular expression scan, or model call is
   permitted in the per-event hot path.
7. Every filtered, sampled, deduplicated, or dropped event is represented by a counter.
8. `all`, `shadow`, and `agent` modes remain available for safe rollout and comparison.

## Component boundary

```text
Observer eBPF
  kernel facts: pid/tgid/ppid/cgroup_id/comm/event
        |
Observer collector
  process instance + cgroup path + boot/node facts
        |
NDJSON
        |
AnySentry node forwarder
  local WorkloadIdentity snapshot
  ProcessCache + WorkloadCache + negative/tombstone entries
  O(1) classification and event routing
        |
batched ingest
        |
AnySentry API
  AgentIdentityRegistry + Kubernetes metadata resolver
  attribution normalization
        |
Sentry judgment -> ClickHouse -> dashboard
```

AnySentry owns logical identity and trust. Observer owns kernel facts. A node-local workload handle
is an optimization and is never treated as a globally stable Agent ID.

## Identity model

### Process instance

PID alone is not an identity because Linux reuses PIDs.

```text
ProcessKey = node_id + boot_id + pid + process_start_marker
```

`process_start_marker` is best-effort for observations where `/proc` has already disappeared. An
event without it remains `unknown`; it must not inherit an older PID's classification.

### Physical workload

```text
host:       node_id + boot_id + cgroup_id or systemd unit
docker:     node_id + runtime + full container_id
kubernetes: cluster_id + pod_uid + full container_id
```

Pod UID identifies one Pod instance. Container ID distinguishes the Agent container from sidecars.
Neither Pod name nor a short container ID is a permanent Agent identity.

### Logical Agent

```text
AgentKey = tenant_id + agent_asset_id
AgentInstanceKey = AgentKey + physical_workload_id
```

When several logical Agents share one process or cgroup, the observation layer identifies the
shared Agent runtime only. Invocation-level identity requires application context such as
`traceId`, `runId`, or an OpenTelemetry Agent/tool span.

## Classification model

```text
confirmed_agent  authoritative registration, trusted platform metadata, or strong known signature
probable_agent   multiple non-authoritative signals agree
unknown          insufficient or temporarily unavailable evidence
non_agent        complete workload/ancestry evidence positively identifies unrelated infrastructure
```

The state machine uses hysteresis:

- confirmation requires a high threshold or authoritative evidence;
- transient metadata loss does not immediately downgrade a confirmed live workload;
- destruction creates a bounded tombstone for late events;
- negative cache entries have a TTL and are invalidated by lifecycle changes.

Classification priority is:

1. Explicit, authenticated registration.
2. Trusted Kubernetes/Docker/platform metadata.
3. Container or systemd workload binding.
4. Known executable and command-prefix signature.
5. Incremental process lineage.
6. Asynchronous behavior evidence.
7. Unknown.

Generic names such as `node`, `python`, `bash`, and `sh` never confirm an Agent by themselves.

A Kubernetes Pod that merely misses an Agent selector remains `unknown` unless an explicit
non-Agent template or authoritative inventory classifies it. This preserves autonomous discovery
for unlabelled Agents.

## Kubernetes discovery

AnySentry performs an initial list followed by watch streams. The registry stores:

- Pod UID, namespace, name, owner, labels, and resource version;
- every full Container ID and the container name/image;
- logical Agent ID selected by trusted labels or configured selectors;
- creation/deletion state and tombstone expiry.

Default labels:

```yaml
anysentry.io/workload-kind: agent
anysentry.io/agent-id: financial-agent
```

Additional selectors are configuration, not hard-coded platform assumptions. A label that an
untrusted tenant may edit is evidence, not an authorization grant.

The forwarder periodically obtains a versioned node-relevant identity snapshot. Snapshot fetches
are outside the per-event hot path. Until a snapshot is ready, filtering fails open.

## Forwarder hot path

```text
parse one Observer event
  -> deduplicate exact duplicate ToolExec evidence
  -> resolve physical workload from local snapshot
  -> resolve ProcessKey/lineage cache when workload identity is absent
  -> classify
  -> apply observation routing policy
  -> enqueue for batch ingest
```

Routing policy:

| Classification | Lifecycle | Security signal | Normal Agent-relevant event | Routine noise |
|---|---:|---:|---:|---:|
| confirmed_agent | keep | keep | keep | aggregate/deduplicate |
| probable_agent | keep | keep | keep within budget | sample |
| unknown | keep | keep | keep within discovery budget | sample |
| non_agent | cleanup only | keep | filter in `agent` mode | aggregate/filter |

When identity metadata is unavailable, `ToolExec`, `SecurityAction`, `FileDelete`, network, and LLM
evidence remain fail-open. Only routine unknown `FileAccess` is rate-budgeted per physical
workload (default 20 events/second) to prevent a snapshot outage from turning filesystem churn into
an ingest storm. The budget never changes the classification and every suppressed event increments
`discovery_budget_dropped`.

`shadow` computes the same decision and counters but forwards the event. `all` bypasses Agent
classification filtering. `agent` applies the decision.

Shadow counters use a separate `would_filter` namespace so operators can compare the result with
`all` before enabling filtering. Filter metrics are structured heartbeat fields; the human-readable
heartbeat message is only a compatibility summary.

## Data contract

Observer process context is extended additively:

```json
{
  "process": {
    "host_id": "node-a",
    "boot_id": "f3c...",
    "pid": 1234,
    "ppid": 1200,
    "start_time_ticks": 998877,
    "comm": "bash",
    "exe": "/usr/bin/bash",
    "cwd": "/workspace",
    "cgroup_id": 18412,
    "cgroup": "0::/kubepods.slice/..."
  }
}
```

The forwarder adds authoritative attribution only when it has evidence:

```json
{
  "attribution": {
    "monitored": true,
    "classification": "confirmed_agent",
    "physicalWorkloadId": "k8s:cluster-a:pod-uid:container-id",
    "agentScopeId": "financial-agent",
    "agentDisplayName": "financial-agent",
    "agentInstanceId": "pod-uid/container-id",
    "confidence": 1,
    "reason": "authoritative_anchor",
    "source": "kubernetes",
    "evidence": ["label:anysentry.io/workload-kind=agent"]
  }
}
```

Unknown and non-Agent classifications are also propagated in the ingest envelope so that the API
and heartbeat counters use the same semantics as the forwarder.

## Backpressure and observability

The forwarder uses a bounded batch queue and persistent HTTP connections. On pressure, retention
priority is:

```text
security signal
> confirmed Agent
> probable Agent discovery
> unknown discovery
> non-Agent routine noise
```

Required metrics:

```text
events_observed_total
events_forwarded_total
events_filtered_total{reason,class,event_type}
events_sampled_total{class,event_type}
events_deduplicated_total{event_type}
identity_cache_hits_total{cache}
identity_cache_misses_total{cache}
identity_snapshot_version
identity_snapshot_age_seconds
identity_resolution_errors_total{source}
queue_depth
batch_size
output_drops_total{reason}
```

Heartbeat messages carry interval deltas. No filter action is silent.

## Delivery stages

The implementation is reconciled against the complete roadmap after every stage:

1. Stable Observer facts and the initial Kubernetes/host user-space filter.
2. Unified operator templates, positive non-Agent semantics, and Docker/host/Kubernetes metadata
   adapters.
3. Bounded framework discovery with candidate scoring, evidence, hysteresis, and expiry.
4. Correct shadow accounting, process/workload tombstones, structured metrics, and dashboard
   visibility.
5. Hot-path convergence: lifecycle-populated Process/Cgroup caches, cached parsing, priority
   buckets, adaptive sampling/batching, and no routine per-event `/proc` traversal.
6. Host, Docker, and Kubernetes end-to-end tests plus throughput, latency, CPU, RSS, wakeup, and
   drop baselines.
7. Only after user-space shadow validation, evaluate the optional observation-only eBPF prefilter.

Stages 2-6 are part of the final feature target even when an earlier stage is deployable.

## Implementation status (2026-07-30)

The Collector user-space target in stages 1-6 is implemented:

- loose operator templates for host, Docker, Kubernetes, and deployment-agnostic matching;
- Docker list/event discovery and Kubernetes dynamic list/watch identity;
- container-level sidecar separation and lifecycle tombstones;
- bounded behavior discovery that promotes only to `probable_agent`;
- fail-open `all`/`shadow`/`agent` routing, discovery budgets, deduplication, priority buckets,
  adaptive batches, and structured counters;
- ProcessKey and direct cgroup caches, including numeric Observer fact compatibility and separate
  bootstrap/fallback/ancestry `/proc` counters;
- Collector UI visibility and server-side event evidence search;
- workload-aware risk-event identity: the readable Agent/Pod/container/service name is shown first,
  confirmed and candidate identities use distinct name colors, and compact Kubernetes, Docker, or
  local-service badges follow the name; confidence, stable IDs, workload metadata, and evidence are
  expanded only in the clicked event detail;
- real current-branch Observer -> forwarder -> API verification for host template, Docker
  template, unknown Docker behavior, Kubernetes Agent container, and Kubernetes sidecar.

The optional in-kernel observation prefilter in stage 7 is deliberately not enabled. One isolated
shadow run is not sufficient evidence for irreversible early dropping, especially for the first
short-lived process in a previously unseen cgroup. Standalone containerd/CRI and proprietary
platform adapters, invocation identity inside a shared runtime, and production power/long-soak
measurements remain environment-specific follow-up work.

The 60,000-event filter-core benchmark most recently measured 835,140 events/second, p99 3.06
microseconds, and 10.27 MiB RSS growth, with zero `/proc` reads on the warm path. This excludes
network, persistence, and risk judgment. Run it with:

```bash
node scripts/perf-agent-filter.mjs
```

Run the real five-scenario chain with:

```bash
pnpm verify:real-agent-discovery-chain:local
```

The real test keeps the first Kubernetes Agent command alive briefly so Observer can establish the
initial `cgroup_id -> Container ID` binding. A truly shorter first event with no prior binding
remains unknown and is forwarded; after binding, short-lived events use the direct cgroup cache.

## Rollout and commits

1. Documentation and additive contracts.
2. Observer kernel/process identity facts and tests.
3. AnySentry workload-first classifier and compatibility tests.
4. Kubernetes registry/snapshot and forwarder integration.
5. Batching, metrics, deployment updates, and full regression tests.
6. Real Observer NDJSON -> forwarder -> AnySentry -> Sentry -> event API verification.

Filtering is enabled only after `shadow` shows acceptable unknown and false-filter rates for the
target environment.

## Acceptance tests

- Known host Agent and all descendants are attributed.
- A normal host `node` service reaches PID 1 and becomes non-Agent.
- A Kubernetes Agent using a generic `node` or `python` process is selected by workload identity
  before process lineage and is never filtered.
- A sidecar in the same Pod is not attributed to the Agent container.
- PID reuse does not inherit identity.
- A short-lived process with missing `/proc` data remains unknown and is forwarded.
- Empty Kubernetes namespaces remove active identities while preserving bounded tombstones.
- Snapshot/watch interruption fails open and reports an error counter.
- `all`, `shadow`, and `agent` modes produce explainable, reconcilable counts.
- Existing Sentry judgment and ClickHouse persistence remain unchanged.
- Risk-event lists identify confirmed and candidate Agents by name color without replacing the
  stable `agentScopeId`; deployment type is a compact badge and detailed attribution is available
  after selecting the event.
- No enforcement binary or blocking hook is started by the integrated deployment.
