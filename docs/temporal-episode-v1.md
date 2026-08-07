# Temporal Episode v1

Temporal Episode v1 is a shadow-only Flink detector for ordered Agent behavior. It does
not replace Sentry L1/L2/L3 and does not participate in synchronous blocking.

## Rule families

The first release supports two file-centered rule families:

1. `download_execute`
   - `download`
   - `file_write`
   - `chmod`
   - `execute`
   - all four facts must reference the same file identity and occur within five minutes
2. `sensitive_data_exfiltration`
   - sensitive `file_read`
   - `encode` or `compress` of the same file identity
   - external `egress`
   - all three facts must occur in the same Agent session within five minutes

Matches are emitted once as immutable revision-1 risk-analysis batches. They use
`ruleVersion=temporal-episode-v1`, `triggerReason=pattern_match`, and
`decisionPath=deterministic_rule`. They are persisted as shadow findings and do not call
the Composite Judge.

## Evidence Gate

| Evidence | Current source | v1 status | Semantics |
|---|---|---:|---|
| Agent and Workspace | AnySentry attribution | available | correlation scope |
| PID and PPID | Observer process context | available | process lineage |
| host boot ID | Observer `/proc` enrichment | available after collector update | protects against host reboot reuse |
| process start time | Observer `/proc/<pid>/stat` | available after collector update | protects against PID reuse |
| mount namespace | Observer `/proc/<pid>/ns/mnt` | best effort after collector update | retained evidence; short-lived processes may exit before lookup |
| file write | Observer `openat` write flags | available when `A3S_OBSERVER_FILES=1` | direct write-open evidence |
| sensitive file read | command evidence or compatible read event | partial | command-derived facts are not kernel-proven reads |
| chmod target | ToolExec arguments | partial | direct command evidence; non-command syscalls are not covered |
| execute target | committed ToolExec arguments | available | path is resolved against process CWD |
| device and inode | not emitted by Observer | unavailable | prevents a strong file-instance claim |
| download-to-file mapping | curl/wget output arguments | partial | only explicit output paths are accepted |

## Confidence

- `strong`: device and inode identify a file instance, and the process instance has boot
  and start-time identity.
- `medium`: the same normalized path is scoped by trusted source, Agent/Workspace, and
  host boot. Mount namespace remains supporting evidence but is not part of the fallback
  key because short-lived processes can exit before `/proc/<pid>/ns/mnt` is read.
- `weak`: only a partially scoped path is available.

The current Observer does not emit device and inode. Therefore live v1 file matches are
normally `medium` or `weak`. They remain suspicious Shadow Episodes and must not claim
that exploitation or exfiltration has been proven.

The next rule pack adds `supply-chain-temporal-v2`:

1. an executed component is matched to an open OSV finding;
2. that process directly creates a shell or script runtime;
3. that runtime, or its direct child, performs a sensitive, destructive, dangerous, or
   external-network action;
4. all three facts occur in the same Agent session in event-time order within five
   minutes.

An OSV finding by itself never creates an attack Episode. Time proximity without explicit
PID/PPID lineage is also rejected. A high-confidence component match plus strong
boot-aware process identities uses a deterministic Shadow decision. A medium-confidence
match with valid direct lineage creates one Composite Judge request. The previous
`supply-chain-exploit-v1` label-window detector is retained only for historical records;
the Flink job no longer emits new v1 supply-chain candidates.

## State bounds

- event-time window: five minutes
- allowed out-of-order arrival: 30 seconds
- active file candidates per Agent session: eight
- retained behavior facts per Agent session: 64
- duplicate source event IDs: ignored
- repeated facts for the same file prefer the most recent complete ordered candidate
- a matched candidate cannot be completed by another terminal event
- one terminal event cannot complete multiple candidates for the same rule and file
- matched episode ID: stable hash of rule, correlation scope, file identity, and ordered
  evidence IDs

## Temporal Episode v2

`temporal-episode-v2` reuses the v1 identity, ordering, deduplication, bounded-state,
event-time Timer, and immutable Episode contract. It adds four strict Shadow rule
families:

1. `persistence_installation`
   - write a recognized persistence target;
   - activate the same absolute target or target basename;
   - both facts must share one Agent process scope.
2. `sandbox_privilege_breakout`
   - explicit namespace or sandbox-boundary probe;
   - privilege transition;
   - sensitive read, destructive action, dangerous execution, or egress consequence;
   - all facts must share one host/boot/container and Agent root process scope.
3. `destructive_behavior`
   - discover one target path;
   - perform two destructive facts inside that path scope;
   - all facts must share one Agent process scope.
4. `lateral_movement`
   - read one sensitive credential file;
   - use that same credential to connect to one remote destination;
   - use it again for remote execution or copy to that same destination;
   - all facts must share one Agent process scope.

Time proximity alone is insufficient. A different persistence target, process root, path
scope, credential identity, or remote destination rejects the candidate. The rules are
Shadow-only and emit deterministic suspicious decisions; synthetic fixtures are recorded
as simulations and remain excluded from production attack counts.

Unified acceptance covers ordered and out-of-order input, broken-relationship negatives,
stable event-ID deduplication, bounded candidates, immutable revision-1 Episodes,
checkpoint recovery, and deterministic decision validation before persistence.
