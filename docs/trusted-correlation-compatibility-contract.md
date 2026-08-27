# Trusted correlation compatibility contract

This contract is the S0 migration boundary for
[the trusted-correlation and capture roadmap](./anysentry-trusted-correlation-and-capture-roadmap.md).
It records the legacy consumers that must remain stable while the additive correlation view is
introduced.

## Permanent compatibility rules

- `agentId`, `sessionId`, `traceId`, `spanId`, `parentSpanId`, `runId`,
  `agentInstanceId`, and `agentCorrelationId` keep their current field names and values.
- Historical rows and external OpenTelemetry trace identifiers are never rewritten.
- `invocationId` and `toolCallId` are separate optional identities; neither is an alias for
  `traceId`.
- A runtime-root or workload fallback describes runtime/workload scope. It must not manufacture an
  invocation.
- Existing Trace URLs, Incident IDs, Alert deduplication, evidence queries, and Flink keyed state
  continue to use the legacy fields until an individual versioned consumer explicitly opts in.
- With all new feature switches disabled, the emitted event and all existing read models are
  behaviorally identical to the S0 golden event.

## Consumer matrix

| Consumer | Current compatibility key | Additive migration rule |
|---|---|---|
| Observer and Forwarder NDJSON | raw identity plus ProcessKey facts | May add claims, but cannot overwrite legacy event identity |
| API `EventMeta` / `JudgedEvent` | `agentId/sessionId/traceId/runId` | Reader accepts optional claims before the writer emits them |
| ClickHouse events | legacy scalar columns and attribution JSON | Old columns remain; query columns are added with empty defaults |
| Event list and Timeline | `traceId` query parameter | `invocationId` gets a separate opt-in query parameter |
| Incident identity | workspace, Agent, session, trace, run, risk | Existing Incident IDs are never silently recalculated |
| Alert deduplication | workspace, Agent, trace, risk | `invocationId` may be attached for lookup, not substituted in-place |
| Evidence/Assistant/Remediation | legacy event and Trace scopes | Existing deep links remain valid for their full record lifetime |
| Canonical stream v1 | `agentCorrelationId/sessionId/traceId` | Java readers deploy optional fields before producers emit them |
| Flink profile state | `agentCorrelationId` | A future Invocation key requires a versioned parallel pipeline |
| Flink episode state | tenant/environment/Agent/session | No in-place re-key or serializer mutation without savepoint tests |

## Rollout gates

The three independent controls are:

| Environment variable | Safe default | Accepted values |
|---|---|---|
| `ANYSENTRY_TRUSTED_CORRELATION_MODE` | `off` | `off`, `shadow`, `enabled` |
| `ANYSENTRY_CAPTURE_PROFILE_MODE` | `legacy` | `legacy`, `shadow`, `enforce` |
| `ANYSENTRY_UNKNOWN_RETENTION_MODE` | `legacy` | `legacy`, `shadow`, `enforce` |

An invalid or missing value resolves to the safe default. Merely defining a mode does not enable a
producer: each stage must explicitly consume its own switch after its readers and tests are ready.

1. Reader and storage schema support deploy first.
2. Producers dual-write only in shadow mode.
3. Split, merge, collision, inferred, and coverage metrics are reviewed.
4. Read paths opt in one feature at a time.
5. Streaming key changes use a versioned pipeline and explicit state migration.
6. Disabling the new mode restores the exact legacy read path without rewriting stored data.

The executable guard is:

```bash
pnpm verify:trusted-correlation-compatibility
```

It validates the stable source contracts and runs the same golden event with and without additive
correlation claims. The canonical legacy identity must be identical in both cases.
