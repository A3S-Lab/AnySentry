# Flink shadow context and Episode stream

This module consumes canonical AnySentry events and asynchronous judgment updates. It maintains
per-Agent risk profiles and bounded per-Agent/Session behavior Episodes.

The job emits:

- rolling Agent risk profiles to the findings topic;
- `anysentry.risk_analysis_batch.v1` Episodes to the Episode topic;
- invalid canonical or judgment messages to the DLQ.

Only security-relevant behavior can enter an Episode. Generic lifecycle observations such as
`ProcessExit` remain available to the rolling profile path but are excluded from Composite Judge
evidence.

The job never calls an LLM, changes a Sentry verdict, or blocks an Agent action. AnySentry consumes
Episodes through BullMQ and performs exactly one direct composite model call per Episode revision.
The result remains Shadow-only. Raw invalid payloads are represented in the DLQ by a digest and a
sanitized error.

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
