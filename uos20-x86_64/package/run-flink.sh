#!/usr/bin/env bash
set -euo pipefail

ROOT=${ANYSENTRY_INSTALL_ROOT:-/opt/anysentry}
export JAVA_HOME=$ROOT/java
export PATH=$JAVA_HOME/bin:$PATH
export FLINK_HOME=$ROOT/flink
export FLINK_CONF_DIR=$ROOT/flink/conf
# Foreground Flink still opens a rolling log under FLINK_LOG_DIR. The default
# is /opt/anysentry/flink/log, which ProtectSystem=strict keeps read-only.
state=${ANYSENTRY_FLINK_DATA_DIR:-/var/lib/anysentry/flink}
log_dir=$state/log
install -d -o anysentry -g anysentry -m 0750 \
  "$log_dir" "$state/checkpoints" "$state/savepoints" "$state/blob" "$state/tmp"
export FLINK_LOG_DIR=$log_dir

case "${1:-}" in
  jobmanager)
    exec "$FLINK_HOME/bin/jobmanager.sh" start-foreground
    ;;
  taskmanager)
    exec "$FLINK_HOME/bin/taskmanager.sh" start-foreground
    ;;
  submit)
    for _ in $(seq 1 60); do
      "$FLINK_HOME/bin/flink" list -m 127.0.0.1:8081 >/tmp/anysentry-flink-list.$$ 2>/dev/null && break
      sleep 2
    done
    if grep -Fq 'AnySentry Flink Shadow Risk' /tmp/anysentry-flink-list.$$; then
      rm -f /tmp/anysentry-flink-list.$$
      exit 0
    fi
    rm -f /tmp/anysentry-flink-list.$$
    exec "$FLINK_HOME/bin/flink" run -d -m 127.0.0.1:8081 \
      -c org.a3s.anysentry.streaming.AnySentryStreamJob \
      "$FLINK_HOME/usrlib/anysentry-flink-streaming.jar"
    ;;
  *)
    echo 'usage: run-flink.sh jobmanager|taskmanager|submit' >&2
    exit 2
    ;;
esac

