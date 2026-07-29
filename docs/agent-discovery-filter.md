# Agent Discovery and Observation Filter

Status: implementation contract for `feat/agent-discovery-filter`

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

`shadow` computes the same decision and counters but forwards the event. `all` bypasses Agent
classification filtering. `agent` applies the decision.

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
- No enforcement binary or blocking hook is started by the integrated deployment.
