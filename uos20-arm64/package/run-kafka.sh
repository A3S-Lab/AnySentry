#!/usr/bin/env bash
set -euo pipefail

ROOT=${ANYSENTRY_INSTALL_ROOT:-/opt/anysentry}
export JAVA_HOME=$ROOT/java
export PATH=$JAVA_HOME/bin:$PATH
export KAFKA_HEAP_OPTS=${KAFKA_HEAP_OPTS:--Xms1G -Xmx2G}
config=$ROOT/config/kafka-server.properties
data=${ANYSENTRY_KAFKA_DATA_DIR:-/var/lib/anysentry/kafka}
cluster_id=${ANYSENTRY_KAFKA_CLUSTER_ID:-MkU3OEVBNTcwNTJENDM2Qk}

install -d -o anysentry -g anysentry -m 0750 "$data"
if [[ ! -f $data/meta.properties ]]; then
  "$ROOT/kafka/bin/kafka-storage.sh" format \
    --ignore-formatted --cluster-id "$cluster_id" --config "$config"
fi
exec "$ROOT/kafka/bin/kafka-server-start.sh" "$config"
