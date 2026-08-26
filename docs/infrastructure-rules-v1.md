# Infrastructure rules v1

后续产品与生命周期设计：[统一资产生命周期、人工身份审核与采集规则治理优化设计](./anysentry-unified-asset-lifecycle-and-capture-rule-governance.md)

The authoritative API stores `anysentry.infrastructure_rule_state.v1` in PostgreSQL and publishes
`anysentry.infrastructure_policy_snapshot.v1`. The Forwarder adapts that snapshot into the pure
`anysentry.infrastructure_rules.v1` resolver, matches stable workload facts, and publishes the
result through the existing `anysentry.filter_rule_snapshot.v1` cgroup map. There is one rule
lineage, not an unrelated API rule set and Observer rule set.

The dashboard reads only the bounded human projections at `GET /ui/list` and `GET /ui/:ruleId`.
Those projections omit raw selectors, cgroup bindings, content hashes, event policies, and grants,
so rule discovery remains available without putting a management secret into every browser. Raw
policy/status/operation endpoints and every create, preview, transition, report, or revoke action
continue to require management authentication.

## Safety model

- Selectors are exact, stable workload fields. PID, cgroup ID, Pod UID, and Container ID are not
  accepted as reusable rule selectors.
- `candidate` rules may express a future `wouldAction=drop`, but their effective action is always
  `sample` or `keep`.
- `shadow` rules never drop. `canary` drops only when the caller explicitly marks the current node
  as selected. `enforce` may drop only for `authoritative` Infrastructure.
- An Agent rule always wins a matching Infrastructure rule and produces `keep` plus an auditable
  conflict.
- Collector heartbeat, rule ACK, runtime snapshot, container/Pod lifecycle, and SecurityAction are
  always kept. Agent ToolExec, ProcessExit, FileAccess, and FileDelete are kept by the higher-priority
  Agent identity. Ordinary events from an authoritative Infrastructure workload may be filtered.
- A cgroup `FilterDecision` is created only after a stable selector matches the current physical
  workload and the event supplies a valid node-local cgroup ID.

## Stable selectors

Kubernetes rules require:

```text
clusterId + namespace + ownerKind + ownerName + containerName
```

The central Docker selector requires either:

```text
composeProject + serviceName
```

or, for a non-Compose container:

```text
containerName + exact imageDigest
```

The local materializer adds the current exact `hostGroup`; it is never stored as a reusable
container or cgroup ID. Host rules require:

```text
nodeId + exact systemdUnit
```

An optional image digest or exact executable can further narrow a selector. Patterns, globs, and
regular expressions are rejected in v1 so an automatically learned rule cannot silently widen its
scope.

## Version, TTL, and audit

Every document has a positive monotonic `version`. Every rule has an independent positive
`revision`, `createdAt`, `updatedAt`, and `expiresAt`, plus mandatory `audit.createdBy` and
`audit.changeReason`. Expired and disabled rules do not match. Materialized decisions carry the
document version, matched/effective rule IDs, expiry, decision time, evidence references, and
change reasons for later heartbeat or central-rule ACK integration.

## Runtime chain

```text
Docker/Kubernetes/systemd inventory
        -> draft -> shadow -> inventory validation -> enforced
        -> central policy snapshot (5 s TTL refresh)
        -> exact selector match on each node
        -> current container/cgroup materialization
        -> existing FilterRuleSnapshot epoch
        -> Collector/eBPF hot reload
```

Docker PID membership and Kubernetes Pod UID/container ID are resolved to the current cgroup inode
outside the event hot path. Kubernetes ReplicaSet ownership is resolved to its stable Deployment.
The materialized cgroup is short-lived and is replaced when a workload is recreated.

`scripts/manage-infrastructure-rules.mjs` inventories allow-listed running Docker workloads, exact
Host systemd units, Kubernetes logical owners, and CoreDNS, then drives the audited
shadow/validate/promote flow. Candidate and shadow rules never produce a kernel drop. Promotion
requires a real inventory match, zero Agent
conflicts, an allow-listed authority source, the current revision, and a distinct approver.

Stable Infrastructure resolution runs before behavior-based Agent discovery. A confirmed/probable
Agent already established by a signature, explicit label, or template still wins and produces KEEP;
an exact Infrastructure workload is not first promoted merely because ClickHouse or PostgreSQL has
high file activity.

`scripts/unknown-learning-report.mjs` closes the feedback loop over centrally stored events. It
selects the latest decision revision, weights exact aggregates by `repeatCount`, and groups Unknown
by node/cgroup/physical workload, Kubernetes owner, Docker project/service, process, event type, and
non-sensitive path bucket. Only a complete stable selector repeated across nodes or physical
instances can become `candidate + draft + sample`; comm/exe/path never become selector fields, and
the learner never emits authoritative/drop. Missing physical identity remains in review clusters.

The final Docker experiment materialized 48 enforced rules with zero Agent conflicts. Coverage
includes the modular AnySentry stack, other exact Compose ClickHouse/Redis/PostgreSQL/etcd/MinIO
workloads, A3S and AnySentry Kubernetes owners, CoreDNS, a digest-pinned kind control plane, and
exact Host systemd units. Workload recreation changes only the short-lived cgroup materialization;
the logical rule remains reusable on every node.
