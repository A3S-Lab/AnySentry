#!/usr/bin/env bash
set -euo pipefail

ROOT=${ANYSENTRY_INSTALL_ROOT:-/opt/anysentry}
export JAVA_HOME=$ROOT/java
export PATH=$JAVA_HOME/bin:$PATH
export KAFKA_HEAP_OPTS=${KAFKA_HEAP_OPTS:--Xms1G -Xmx2G}
config=$ROOT/config/kafka-server.properties
data=${ANYSENTRY_KAFKA_DATA_DIR:-/var/lib/anysentry/kafka}
cluster_id=${ANYSENTRY_KAFKA_CLUSTER_ID:-MkU3OEVBNTcwNTJENDM2Qk}
# Kafka writes GC and Log4j files under LOG_DIR. The default is
# /opt/anysentry/kafka/logs, which ProtectSystem=strict keeps read-only.
# The directory must also stay outside log.dirs: Kafka treats every child of
# the data directory as a topic partition, so a child named "logs" is fatal.
log_dir=/var/lib/anysentry/kafka-logs

install -d -o anysentry -g anysentry -m 0750 "$data" "$log_dir"
if [[ -d $data/logs ]]; then
  rm -rf "$data/logs"
fi
export LOG_DIR=$log_dir
if [[ ! -f $data/meta.properties ]]; then
  "$ROOT/kafka/bin/kafka-storage.sh" format \
    --ignore-formatted --cluster-id "$cluster_id" --config "$config"
fi
exec "$ROOT/kafka/bin/kafka-server-start.sh" "$config"
