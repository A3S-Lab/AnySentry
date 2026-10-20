#!/usr/bin/env bash
# Start, stop, or show AnySentry systemd units. Other host services are left alone.
set -euo pipefail

START_ORDER=(
  anysentry-clickhouse.service
  anysentry-redis.service
  anysentry-kafka.service
  anysentry-kafka-init.service
  anysentry-flink-jobmanager.service
  anysentry-flink-taskmanager.service
  anysentry-flink-job.service
  anysentry.service
  anysentry-fast-judge.service
  anysentry-l3-worker.service
  anysentry-stream-worker.service
  anysentry-composite-judge.service
  anysentry-supply-chain.service
  anysentry-observer.service
)

usage() {
  cat <<'EOF'
Usage: anysentry-services.sh start|stop|status

start and stop require root. Data under /var/lib/anysentry is kept.
EOF
}

require_root() {
  [[ $(id -u) -eq 0 ]] || {
    echo "root is required" >&2
    exit 1
  }
}

unit_installed() {
  systemctl cat "$1" >/dev/null 2>&1
}

start_services() {
  local unit
  require_root
  for unit in "${START_ORDER[@]}"; do
    unit_installed "$unit" || {
      echo "missing unit: $unit" >&2
      exit 1
    }
    systemctl start "$unit"
    printf '%s %s\n' "$unit" "$(systemctl is-active "$unit" || true)"
  done
}

stop_services() {
  local unit i
  require_root
  for ((i = ${#START_ORDER[@]} - 1; i >= 0; i--)); do
    unit=${START_ORDER[$i]}
    if unit_installed "$unit"; then
      systemctl stop "$unit" || true
      printf '%s %s\n' "$unit" "$(systemctl is-active "$unit" || true)"
    else
      printf '%s not-installed\n' "$unit"
    fi
  done
}

show_status() {
  local unit state
  for unit in "${START_ORDER[@]}"; do
    if unit_installed "$unit"; then
      state=$(systemctl is-active "$unit" 2>/dev/null || true)
    else
      state=not-installed
    fi
    printf '%s %s\n' "$unit" "$state"
  done
}

case "${1:-}" in
  start) start_services ;;
  stop) stop_services ;;
  status) show_status ;;
  -h|--help) usage ;;
  *) usage >&2; exit 2 ;;
esac
