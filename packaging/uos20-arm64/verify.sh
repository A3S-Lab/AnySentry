#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ENV_FILE=/etc/anysentry/anysentry.env
PREFLIGHT=0

fail() {
  echo "FAIL $*" >&2
  exit 1
}

pass() {
  echo "PASS $*"
}

version_at_least() {
  local actual=$1 minimum=$2
  [ "$(printf '%s\n%s\n' "$minimum" "$actual" | sort -V | head -n 1)" = "$minimum" ]
}

env_value() {
  local key=$1
  awk -v key="$key" 'index($0, key "=") == 1 { sub(/^[^=]*=/, ""); print; exit }' "$ENV_FILE"
}

host_checks() {
  local arch glibc_line glibc_version required
  arch=$(uname -m)
  [ "$arch" = aarch64 ] || fail "architecture is $arch; aarch64 is required"
  glibc_line=$(getconf GNU_LIBC_VERSION 2>/dev/null) || fail "unable to detect glibc"
  glibc_version=${glibc_line##* }
  version_at_least "$glibc_version" 2.28 || fail "glibc $glibc_version is older than 2.28"
  for required in curl systemctl sha256sum ss; do
    command -v "$required" >/dev/null 2>&1 || fail "required command is missing: $required"
  done
  pass "host ABI and required commands"
}

package_checks() {
  local required
  for required in app/dist/main.js app/web/index.html runtime/node/bin/node native/a3s-sentry.linux-arm64-gnu.node clickhouse/bin/clickhouse observer/bin/a3s-observer-collector observer/observer-forward.js l3/l3-agent.mjs l3/node_modules/@a3s-lab/code/index.linux-arm64-gnu.node VERSION manifest.sha256; do
    [ -f "$SCRIPT_DIR/$required" ] || fail "package file missing: $required"
  done
  (
    cd "$SCRIPT_DIR"
    sha256sum --check manifest.sha256 >/dev/null
  ) || fail "package checksums"
  pass "package files and checksums"
}

wait_for_url() {
  local url=$1 auth=${2:-} i
  for i in $(seq 1 60); do
    if [ -n "$auth" ]; then
      curl --connect-timeout 2 --max-time 5 -fsS --user "$auth" "$url" && return 0
    else
      curl --connect-timeout 2 --max-time 5 -fsS "$url" && return 0
    fi
    sleep 2
  done
  return 1
}

if [ "${1:-}" = --preflight ]; then
  PREFLIGHT=1
  shift
fi
[ "$#" -eq 0 ] || fail "usage: verify.sh [--preflight]"

host_checks
if [ "$PREFLIGHT" -eq 1 ]; then
  package_checks
  exit 0
fi

[ -f "$ENV_FILE" ] || fail "$ENV_FILE is missing"
[ -x /opt/anysentry/runtime/node/bin/node ] || fail "bundled Node runtime is missing"
[ -x /opt/anysentry/clickhouse/bin/clickhouse ] || fail "bundled ClickHouse is missing"
systemctl is-active --quiet anysentry-clickhouse.service || fail "anysentry-clickhouse.service is not active"
systemctl is-active --quiet anysentry.service || fail "anysentry.service is not active"
systemctl is-active --quiet anysentry-observer.service || fail "anysentry-observer.service is not active"
pass "ClickHouse, API, and Observer systemd services are active"

clickhouse_user=$(env_value CLICKHOUSE_USER)
clickhouse_password=$(env_value CLICKHOUSE_PASSWORD)
api_port=$(env_value PORT)
[ -n "$clickhouse_user" ] || clickhouse_user=anysentry
[ -n "$api_port" ] || api_port=29653

wait_for_url http://127.0.0.1:8123/ping "$clickhouse_user:$clickhouse_password" >/dev/null || fail "ClickHouse readiness endpoint"
pass "ClickHouse loopback readiness"

health=$(wait_for_url "http://127.0.0.1:$api_port/security-center/healthz") || fail "AnySentry health endpoint"
printf '%s' "$health" | grep -Eq '"status"[[:space:]]*:[[:space:]]*"ok"' || fail "health status is not ok"
printf '%s' "$health" | grep -Eq '"mode"[[:space:]]*:[[:space:]]*"clickhouse"' || fail 'health storage is not "mode": "clickhouse"'
pass "API health and ClickHouse storage mode"

smoke_id="install-$(date +%s)-$$"
smoke=$(curl --connect-timeout 2 --max-time 15 -fsS -X POST "http://127.0.0.1:$api_port/security-center/ingest/events" \
  -H 'Content-Type: application/json' \
  --data-binary "{\"sourceType\":\"custom\",\"sourceName\":\"offline-install-verifier\",\"workspacePath\":\"repo://offline-install\",\"agentId\":\"$smoke_id\",\"sessionId\":\"$smoke_id\",\"events\":[{\"kind\":\"egress\",\"peer\":\"169.254.169.254\",\"port\":80}]}" ) || fail "security-center/ingest/events smoke request"
printf '%s' "$smoke" | grep -Eq '"acceptedEvents"[[:space:]]*:[[:space:]]*1' || fail "smoke event was not accepted"
printf '%s' "$smoke" | grep -Eq '"verdict"[[:space:]]*:[[:space:]]*"block"' || fail "sentry did not block the smoke event"
pass "ARM64 native sentry ingest decision"

source_id=$(env_value ANYSENTRY_SOURCE_ID)
[ -n "$source_id" ] || fail "ANYSENTRY_SOURCE_ID is missing"
observer_marker="anysentry-observer-exec-$(date +%s)-$$"
observer_seen=0
for i in $(seq 1 20); do
  /bin/echo "$observer_marker" >/dev/null
  events=$(curl --connect-timeout 2 --max-time 10 -fsS -X POST \
    "http://127.0.0.1:$api_port/security-center/events/list" \
    -H 'Content-Type: application/json' \
    --data-binary "{\"timeType\":\"last_30d\",\"sourceId\":\"$source_id\",\"eventKind\":\"ToolExec\",\"limit\":200}") || events=
  if printf '%s' "$events" | grep -Fq "$observer_marker"; then
    observer_seen=1
    break
  fi
  sleep 1
done
[ "$observer_seen" -eq 1 ] || fail "Observer exec/ToolExec event was not found through security-center/events/list"
pass "Linux 4.19 Observer exec event reached the AnySentry API"
echo "AnySentry verification completed successfully."
