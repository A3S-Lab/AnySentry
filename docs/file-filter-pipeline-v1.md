# File Filter Pipeline v1

Status: first implementation and privileged Docker canary complete. File probes are off in the
ordinary profile; the explicit Kubernetes canary and final immutable rollout remain gated.

## Goal

Keep the existing Agent attribution and lifecycle algorithms as the final authority while moving
only confirmed, physical-scope file decisions closer to the kernel. The pipeline reduces node-wide
FileAccess pressure without treating `unknown` as `non_agent` or hiding control-plane signals.

```text
current attribution -> FilterRuleSnapshot -> Observer cgroup map
       |                                         |
       +------------- Forwarder recheck <--------+
                              |
                   aggregate / batch / persist
                              |
                   canonical Kafka -> Flink
```

## Shared decision contract

`anysentry.filter_rule_snapshot.v1` is atomically written by the Forwarder and hot-loaded by the
Collector. The first version supports exact numeric cgroup IDs. Host ProcessTree fields are ABI
scaffolding only and are not used for hard filtering.

```json
{
  "schemaVersion": "anysentry.filter_rule_snapshot.v1",
  "version": 42,
  "epoch": 42,
  "generatedAt": "2026-08-17T09:00:00Z",
  "entries": [
    {
      "scopeType": "cgroup",
      "scopeKey": "cgroup:18412",
      "cgroupId": "18412",
      "classification": "confirmed_agent",
      "authority": "authoritative",
      "action": "keep",
      "reasonCode": "confirmed_agent",
      "epoch": 42,
      "expiresAt": "2026-08-17T09:02:00Z"
    }
  ]
}
```

Only authoritative platform/manual non-Agent evidence can publish `drop`. Probable Agent publishes
`keep`; unknown, stale, conflict, and map miss fail open to `keep`. A candidate or shadow rule may
publish `sample` as a would-drop marker, but the Collector's default `unknownPolicy=keep` treats it
as KEEP. Agent keep wins a conflicting drop.
The publisher restores the last valid epoch and unexpired entries after restart. Metadata changes
that do not alter action or authority do not rewrite the snapshot, preventing cgroup event churn
from forcing continuous whole-map reloads.

## Three filtering stages

1. **Observer eBPF:** cgroup lookup before path copy/ring reserve. Agent keep and authoritative
   Infrastructure drop are applied there; every unknown/stale/conflict/map-miss path is retained.
   FileDelete has its own ring and fails open except for authoritative drop.
2. **Collector/Forwarder fast path:** the first version keeps Collector event semantics unchanged.
   After existing classification and behavior discovery, exact repeated Agent or Unknown FileAccess
   records may be coalesced only when ProcessKey, cgroup, path, operation, identity, attribution,
   activity, and filter-decision semantics are identical. Both camelCase and snake_case count/time
   fields are retained end to end.
3. **Forwarder semantic path:** current workload/process/template/review classification remains the
   final authority. It reapplies retention/noise policy, publishes rule changes, records decision
   version/reason, and builds bounded HTTP batches.

Unknown FileAccess has no discovery budget in the default policy. Legacy sampling exists only behind
the explicit compatibility value `A3S_OBSERVER_FILE_UNKNOWN_POLICY=sample`; the Docker validation
profile pins `keep`. Aggregation, authoritative filtering, ring loss, queue loss, and delivery
exhaustion have separate counters so aggregation cannot conceal physical loss.

## Reliable batch boundary

One Forwarder request carries stable `batchId`, `payloadDigest`, per-event `sourceEventId`, and
`sourceSequence`. The API validates the whole envelope before side effects, prepares every item,
commits retained pending rows through one existing ClickHouse FIFO batch, then performs idempotent
post-commit job publication. ACKs remain per item. Pending and final decision revisions both use
batch insertion; transport failures replay the same identity until the bounded retry deadline.

The first version intentionally does not claim crash-atomic exactly-once delivery across
ClickHouse, Redis, and Kafka. A full durable outbox remains follow-up work. Post-commit delivery
failure is explicit and retryable rather than silently accepted.

## Flink boundary

Ordinary `file_written` remains a canonical fact but cannot open a new temporal candidate. It can
continue the same file candidate opened by download, sensitive read, or persistence write, so
download-write-chmod-execute and persistence rules remain intact. Candidate-capacity suppression
increments dedicated counters and no longer pollutes the schema/late-event DLQ.

## Test order

1. Node/Rust/Java unit and contract tests.
2. Forwarder replay, API fake/real ClickHouse module tests, Observer release build, and Flink JUnit.
3. Module-specific Docker targets with stable ClickHouse/Redis/Postgres/Kafka/Flink runtimes.
4. Full Docker event path after all modules pass.
5. Explicit `k8s-observer-file-canary` only after the heartbeat reports a loaded filter epoch.
6. Final immutable image digests and one Kubernetes rollout.

The canary gate requires zero ring/output/queue/retry-exhaustion loss, no temporal capacity DLQ,
100% known-Agent marker recall, isolated FileDelete evidence, batch-sized ClickHouse parts, and a
complete accounting of kept, sampled, suppressed, aggregated, filtered, persisted, and retrying
events.

## Current Docker stage-one result (2026-08-17)

- The host K8s AnySentry Deployment remains at zero replicas and its Observer DaemonSet remains
  disabled. Validation uses only the modular Docker project.
- Real inventory produced 16 authoritative rules: 12 running Docker/Compose services, exact
  `docker.service`, `containerd.service`, and `k3s.service`, plus the CoreDNS Deployment/container.
  Every rule passed draft -> shadow -> real-inventory validation -> distinct-approver enforce.
- The node materializer resolved all 16 current cgroups before file-probe enablement, including the
  CoreDNS containerd cgroup via Pod UID and container ID. The resulting snapshot contained 16
  authoritative `drop` entries and zero Agent conflicts.
- In the first enforced non-file heartbeat window, 6,628 events were classified before filtering:
  4,376 known non-Agent, 1,940 Unknown, and 925 explicitly attributed to Infrastructure (the latter
  is a subset of non-Agent). Unknown was 29.3%, down from the earlier Docker baseline of roughly
  61.8%; `filteredUnknown`, output/queue drops, retry exhaustion, and error count were all zero.
- A labelled Docker Agent canary produced a current cgroup KEEP rule and its marker ToolExec reached
  ClickHouse as `confirmed_agent`, giving 100% recall for the controlled marker despite the active
  Infrastructure rules.

## Current Docker stage-two result (2026-08-18)

- FileAccess-only began with roughly 11.5万 write-open decisions/minute under build load. The
  authoritative prefilter removed 10.3万 before path copy/ring reserve; 11,887 were retained with
  zero access-ring loss. A synthetic 1,000-write Agent burst exposed 308 Collector stdout drops;
  the bounded writer was then changed to a 32K queue and 256-line/5-ms buffered drain. The identical
  burst subsequently produced zero output loss and two exact aggregates (`355 + 645 = 1000`).
- FileDelete now covers both `unlink` and `unlinkat`. That accuracy fix exposed up to roughly 5.1万
  delete decisions/minute; the original 128 KiB ring lost 4,069 during a burst. Its independent ring
  is now 4 MiB. The next delete-only window retained 8,145, prefiltered 25,568 Infrastructure deletes,
  and reported zero delete-ring/output loss. A Node `unlinkSync` marker reached ClickHouse as
  `confirmed_agent`.
- With FileAccess and FileDelete both enabled, two complete windows retained 19,311 and 15,980 file
  events. Infrastructure prefiltering removed 62,417 and then 78,308 additional file operations;
  access/delete ring drop, Collector output drop, Forwarder queue drop/retry exhaustion, and Unknown
  filtering were all zero.
- ClickHouse event INSERT blocks over the sustained full window had p50 128 rows, p95/max 512 rows;
  active event parts were 13 for about 1.5 million rows. This replaces the earlier tiny-part pattern.
- The running Flink JAR's corrected temporal/risk classes match the tested JAR byte-for-byte. All 41
  Maven tests pass, the job remains RUNNING with 20/20 tasks, and both DLQ partitions remain at
  offset zero.

Crash-atomic delivery across ClickHouse, Redis, and Kafka remains outside v1; retries and incomplete
delivery stay explicit and observable.

## Current Docker stage-three result (2026-08-18)

- The authoritative inventory grew from 16 to 48 rules after the Unknown report exposed additional
  A3S/AnySentry Kubernetes owners, non-primary Docker Compose projects, a standalone kind control
  plane identified by container name plus exact image digest, and exact Host units including the
  endpoint-security service. Every new rule followed shadow -> real inventory validation -> distinct
  approval -> enforce; the final window reported zero Agent/Infrastructure conflicts.
- Stable Infrastructure is resolved before behavior discovery, preventing ClickHouse file volume
  from creating false probable Agents. Explicit Agent signatures and labels still win. Probable
  Agent events fell from 5,652 in the affected window to 28–49 without reducing controlled Agent
  recall.
- Unknown classification fell from the original Docker baseline of about 61.8% to 29.3% after the
  first rules, 13.1% after broad platform inventory, and a stable 4.0–4.2% in final full-probe
  windows. Unknown drop remained zero. The remaining high groups are intentionally retained user
  session/short-process and base-OS events without a stable physical identity.
- The final Agent canary produced ToolExec, FileAccess, and FileDelete markers; all three reached
  ClickHouse as `confirmed_agent` with a cgroup KEEP decision.
- Final full-probe windows kept both rings and Collector/Forwarder loss counters at zero, Flink at
  RUNNING (20/20 tasks), and both DLQ partitions at offset zero. Runtime memory was approximately
  145 MiB Observer, 156 MiB API, 926 MiB ClickHouse, and 797 MiB Flink TaskManager.

The retained-event Unknown report can have a high Unknown ratio after authoritative filtering—this
is expected because known Infrastructure is intentionally absent from storage. Its population scope
is explicitly `retained_events_after_authoritative_filtering`; the 4% number above is the correct
pre-filter classification ratio from the Forwarder heartbeat.
