# Flink shadow context and Episode stream

This module consumes canonical AnySentry events, asynchronous judgment updates, and
Workspace-scoped OSV runtime context. It maintains per-Agent risk profiles and bounded
per-Agent/Session behavior Episodes.

The job emits:

- rolling Agent risk profiles to the findings topic;
- `anysentry.risk_analysis_batch.v1` file and supply-chain Temporal Episodes to the Episode topic;
- invalid canonical or judgment messages to the DLQ.

Only security-relevant behavior can enter an Episode. Generic lifecycle observations such as
`ProcessExit` remain available to the rolling profile path but are excluded from Composite Judge
evidence.

The job never calls an LLM, changes a Sentry verdict, or blocks an Agent action.
Deterministic Episodes are decided without a model; ambiguous supply-chain Episodes are
sent through BullMQ for exactly one Composite Judge call. Every result remains
Shadow-only. Raw invalid payloads are represented in the DLQ by a digest and a sanitized
error.

The legacy label-window `composite-risk-v2` and `supply-chain-exploit-v1` output path is
disabled by default. It can be enabled temporarily with
`ANYSENTRY_FLINK_LEGACY_COMPOSITE_ENABLED=on` and
`ANYSENTRY_LEGACY_COMPOSITE_ENABLED=on` for controlled comparison only. Temporal rules
are the production Shadow path and must not be accompanied by a duplicate legacy model
request.

The Temporal pipeline currently emits:

- `temporal-episode-v1`: download/execute and sensitive-data exfiltration;
- `temporal-episode-v2`: persistence installation, sandbox/privilege breakout,
  destructive behavior, and lateral movement;
- `supply-chain-temporal-v2`: OSV-matched component execution with direct process-lineage
  consequences.

Every v2 rule validates an entity or process relationship in addition to event-time
ordering. Broken target, root-process, path-scope, credential, or destination relationships
do not create an Episode.

The first validated runtime is Flink 2.2.1, Kafka Connector 5.0.0-2.2, and Java 17. The source and
sink use the Kafka protocol, so a compatible broker can replace Apache Kafka through configuration.
New consumer groups start at the latest offsets. Historical replay must be explicitly enabled with
`ANYSENTRY_FLINK_STARTUP_MODE=earliest`; the downstream services independently reject Episodes
whose evidence window is older than `ANYSENTRY_COMPOSITE_MAX_EVENT_AGE_MS`.

Build the job image:

```bash
docker build -t anysentry-flink-streaming:local streaming/flink
```

The normal development path is the repository Compose profile documented in the root README.
