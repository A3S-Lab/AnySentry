# One evidence plane across system and agent layers

The system layer knows what actually executed on a machine. The agent layer knows task, tool, and session intent. AnySentry connects both through stable identity, runtime context, and canonical events so security operations and runtime decisions reference the same evidence.

## Data flow

```text
Linux / Kubernetes / Agent Runtime / Existing Telemetry
                         │
                         ▼
Capture → Normalize + Redact → Canonical Event Stream
                                      │
                      ┌───────────────┴───────────────┐
                      ▼                               ▼
               L1 / L2 / L3                     Evidence store
                      │                     hot ring + ClickHouse
                      └───────────────┬───────────────┘
                                      ▼
               Dashboard / Incident / Evidence Bundle / Guard API
```

## Major layers

### L01 · Signals and enforcement points

`a3s-observer`, Kubernetes metadata, agent runtimes, tool gateways, and OpenTelemetry are event sources. Observer capture is separate from caller enforcement: the same evidence supports observe-only deployments or a tool gateway that explicitly honors guard results.

### L02 · Ingest and normalization

The ingest layer accepts Observer NDJSON, JSON, CloudEvents, and OTLP/HTTP JSON. Normalization adds stable fields, execution categories, and key-aware redaction. Real sources and explicitly labeled synthetic demo sources can coexist.

### L03 · Identity and context

An Agent Asset is the stable investigation object. Runtime Instances record Pods, containers, process trees, Sessions, Runs, and Workspaces. Display names may change but are never the historical join key. Behavior discovery can propose candidate identities; it cannot confirm an Agent by itself.

### L04 · Judgment and temporal correlation

L1/L2/L3 apply tiered judgment to security-relevant events. Streaming paths organize episodes, relationship edges, and findings by stable identity and event time. Supporting telemetry stays queryable without being mislabeled as judged risk.

### L05 · Security operations and governance

The dashboard presents Agents, events, topology, incidents, alerts, Evidence Bundles, objectives, notifications, maintenance windows, remediation work, and audit records from one control plane. The Progressive API gives agents a discoverable `list → describe → dry-run → execute` workflow.

## Core data relationships

```text
Agent Asset (stable agent_id)
  ├── Runtime Instance (pod / container / process tree / session)
  │     └── Atomic Event (source-linked evidence)
  ├── Episode / Topology edge / Stream finding
  ├── Human identity decision
  ├── Incident / Alert / Evidence Bundle
  └── Policy decision / Remediation / Audit record
```

## Two judgment deployment modes

| Mode         | Behavior                                                                           | Example                   |
| ------------ | ---------------------------------------------------------------------------------- | ------------------------- |
| Synchronous  | The API judges security events inline when no queue is configured                  | Base Kubernetes manifests |
| Asynchronous | The API queues work in Redis and configured tiers run in fast-judge and L3 workers | Docker Compose            |

L1 is enabled by default. L2 and L3 need independent model connections and policy. Their workers do not enable those tiers automatically.

## Storage, performance, and degradation

- Current reads use an in-memory hot ring; ClickHouse provides durable analytics and control-plane storage.
- Without ClickHouse, the service continues in memory but loses state after restart.
- Capture and streaming paths use batches, backpressure, bounded queues, and explicit dropped counters to avoid unbounded state.
- `/security-center/healthz` reports API and storage status; it is not a complete readiness guarantee for Redis and every worker dependency.

## Trust boundaries

The zero-code observation path currently requires supported Linux/amd64 nodes, privileged eBPF access, and host visibility. Management authentication is off by default; configure tokens, TLS, and network controls before exposure. Model investigation tools stay read-only and bounded. The deploying organization retains approval and execution authority for high-impact actions.
