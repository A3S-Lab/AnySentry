#!/usr/bin/env bash
set -euo pipefail

clickhouse_user=${CLICKHOUSE_USER:-anysentry}
: "${CLICKHOUSE_PASSWORD:?CLICKHOUSE_PASSWORD is required}"

for _ in $(seq 1 60); do
  if curl --connect-timeout 2 --max-time 5 -fsS \
    --user "$clickhouse_user:$CLICKHOUSE_PASSWORD" \
    http://127.0.0.1:8123/ping >/dev/null; then
    exit 0
  fi
  sleep 2
done

echo "ClickHouse did not become ready within 120 seconds" >&2
exit 1
