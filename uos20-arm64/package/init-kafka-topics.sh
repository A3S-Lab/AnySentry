#!/usr/bin/env bash
set -euo pipefail

ROOT=${ANYSENTRY_INSTALL_ROOT:-/opt/anysentry}
export JAVA_HOME=$ROOT/java
export PATH=$JAVA_HOME/bin:$PATH
bootstrap=${ANYSENTRY_STREAM_BOOTSTRAP_SERVERS:-127.0.0.1:9092}
topics=(
  "${ANYSENTRY_STREAM_CANONICAL_TOPIC:-anysentry.events.canonical.v1}"
  "${ANYSENTRY_STREAM_JUDGMENTS_TOPIC:-anysentry.judgments.v1}"
  "${ANYSENTRY_STREAM_EPISODES_TOPIC:-anysentry.risk-analysis-batches.v1}"
  "${ANYSENTRY_STREAM_FINDINGS_TOPIC:-anysentry.stream.findings.v1}"
  "${ANYSENTRY_SUPPLY_CHAIN_CONTEXT_TOPIC:-anysentry.supply-chain.context.v1}"
  "${ANYSENTRY_STREAM_DLQ_TOPIC:-anysentry.stream.dlq.v1}"
)

for _ in $(seq 1 60); do
  "$ROOT/kafka/bin/kafka-topics.sh" --bootstrap-server "$bootstrap" --list >/dev/null 2>&1 && break
  sleep 2
done
"$ROOT/kafka/bin/kafka-topics.sh" --bootstrap-server "$bootstrap" --list >/dev/null
for topic in "${topics[@]}"; do
  "$ROOT/kafka/bin/kafka-topics.sh" --bootstrap-server "$bootstrap" \
    --create --if-not-exists --topic "$topic" --partitions 2 --replication-factor 1
done

