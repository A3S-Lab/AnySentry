#!/usr/bin/env bash
set -euo pipefail

INSTALL_ROOT=${ANYSENTRY_INSTALL_ROOT:-/opt/anysentry}
ENV_FILE=${ANYSENTRY_ENV_FILE:-/etc/anysentry/anysentry.env}
PREFLIGHT=0

fail() { echo "FAIL $*" >&2; exit 1; }
pass() { echo "PASS $*"; }

env_value() {
  local key=$1
  awk -v key="$key" '
    index($0, key "=") == 1 {
      sub(/^[^=]*=/, "")
      value=$0
    }
    END {
      if (value != "") print value
    }
  ' "$ENV_FILE"
}

json_value() {
  local path=$1
  "$INSTALL_ROOT/runtime/node/bin/node" -e '
    let raw="";
    process.stdin.on("data", c => raw += c);
    process.stdin.on("end", () => {
      const payload=JSON.parse(raw);
      const value=process.argv[1].split(".").filter(Boolean)
        .reduce((current, key) => current == null ? undefined : current[key], payload);
      if (value !== undefined && value !== null) process.stdout.write(String(value));
    });
  ' "$path"
}

collector_value() {
  local field=$1
  "$INSTALL_ROOT/runtime/node/bin/node" -e '
    let raw="";
    process.stdin.on("data", c => raw += c);
    process.stdin.on("end", () => {
      const payload=JSON.parse(raw);
      const collectorId=process.argv[1];
      const field=process.argv[2];
      const item=payload?.data?.items?.find(value => value?.collectorId === collectorId);
      const value=item?.[field];
      if (value !== undefined && value !== null) process.stdout.write(String(value));
    });
  ' "$COLLECTOR_ID" "$field"
}

post_json() {
  local path=$1 body=$2
  curl --connect-timeout 2 --max-time 15 -fsS -X POST \
    "http://127.0.0.1:$API_PORT/security-center/$path" \
    -H 'Content-Type: application/json' --data-binary "$body"
}

wait_health() {
  local i response
  for i in $(seq 1 60); do
    response=$(curl --connect-timeout 2 --max-time 5 -fsS \
      "http://127.0.0.1:$API_PORT/security-center/healthz" 2>/dev/null) && {
      printf '%s' "$response"
      return 0
    }
    sleep 2
  done
  return 1
}

wait_for_collector_health() {
  local body response= state attached_probes
  body="{\"timeType\":\"last_3h\",\"collectorId\":\"$COLLECTOR_ID\",\"limit\":5}"
  for _ in $(seq 1 60); do
    if response=$(post_json collectors/health "$body"); then
      state=$(printf '%s' "$response" |
        collector_value state)
      attached_probes=$(printf '%s' "$response" |
        collector_value attachedProbes)
      [[ -n $attached_probes ]] || attached_probes=-1
      if [[ $state == healthy && $attached_probes =~ ^[0-9]+$ && $attached_probes -ge 8 ]]; then
        printf '%s' "$response"
        return 0
      fi
    fi
    sleep 1
  done
  [[ -n $response ]] || response='{"error":"collector health endpoint returned no successful response"}'
  printf '%s' "$response"
  return 1
}

host_checks() {
  [[ $(uname -m) == aarch64 ]] || fail "host architecture is not aarch64"
  [[ $(getconf PAGESIZE) == 65536 ]] || fail "host page size is not 65536"
  local glibc=${GLIBC_VERSION_OVERRIDE:-$(getconf GNU_LIBC_VERSION | awk '{print $2}')}
  [[ $(printf '2.28\n%s\n' "$glibc" | sort -V | head -n1) == 2.28 ]] || fail "glibc is older than 2.28"
  for command_name in curl systemctl sha256sum; do
    command -v "$command_name" >/dev/null 2>&1 || fail "required command is missing: $command_name"
  done
  pass "host ABI and required commands"
}

package_checks() {
  [[ $(<"$INSTALL_ROOT/observer/KERNEL_VERSION_CODE") == 0x0004135a ]] || fail "Observer BPF ABI is not 0x0004135a"
  (cd "$INSTALL_ROOT" && sha256sum --check --quiet manifest.sha256) || fail "installed package checksums"
  pass "installed package checksums and UOS BPF ABI"
}

if [[ ${ANYSENTRY_VERIFY_LIB:-0} == 1 ]]; then
  return 0 2>/dev/null || exit 0
fi

if [[ ${1:-} == --preflight ]]; then PREFLIGHT=1; shift; fi
[[ $# -eq 0 ]] || fail "usage: verify.sh [--preflight]"

host_checks
package_checks
[[ $PREFLIGHT -eq 0 ]] || exit 0
[[ -f $ENV_FILE ]] || fail "$ENV_FILE is missing"

for service in \
  anysentry-clickhouse.service \
  anysentry-redis.service \
  anysentry.service \
  anysentry-fast-judge.service \
  anysentry-l3-worker.service \
  anysentry-observer.service
do
  systemctl is-active --quiet "$service" || fail "$service is not active"
done
pass "ClickHouse, Redis, API, judgment workers, and Observer systemd services are active"

"$INSTALL_ROOT/redis/bin/redis-cli" -h 127.0.0.1 -p 6379 ping 2>/dev/null |
  grep -qx PONG || fail "Redis loopback readiness"
pass "Redis loopback readiness"

CLICKHOUSE_USER=$(env_value CLICKHOUSE_USER); [[ -n $CLICKHOUSE_USER ]] || CLICKHOUSE_USER=anysentry
CLICKHOUSE_PASSWORD=$(env_value CLICKHOUSE_PASSWORD)
API_PORT=$(env_value PORT); [[ -n $API_PORT ]] || API_PORT=29653
SOURCE_ID=$(env_value ANYSENTRY_SOURCE_ID)
COLLECTOR_ID=$(env_value A3S_OBSERVER_COLLECTOR_ID)
[[ -n $SOURCE_ID ]] || fail "ANYSENTRY_SOURCE_ID is missing"
[[ -n $COLLECTOR_ID ]] || fail "A3S_OBSERVER_COLLECTOR_ID is missing"
[[ $COLLECTOR_ID =~ ^[A-Za-z0-9._:-]+$ ]] ||
  fail "A3S_OBSERVER_COLLECTOR_ID contains an invalid value: $COLLECTOR_ID"

curl --connect-timeout 2 --max-time 10 -fsS --user "$CLICKHOUSE_USER:$CLICKHOUSE_PASSWORD" \
  http://127.0.0.1:8123/ping >/dev/null || fail "ClickHouse loopback readiness"
pass "ClickHouse loopback readiness"

health=$(wait_health) || fail "API health endpoint readiness"
[[ $(printf '%s' "$health" | json_value data.status) == ok ]] || fail "API health status"
[[ $(printf '%s' "$health" | json_value data.storage.mode) == clickhouse ]] || fail "API ClickHouse storage mode"
pass "API health and ClickHouse storage mode"

smoke_id="install-$(date +%s)-$$"
smoke=$(post_json ingest/events \
  "{\"sourceType\":\"custom\",\"sourceName\":\"offline-install-verifier\",\"workspacePath\":\"repo://offline-install\",\"agentId\":\"$smoke_id\",\"sessionId\":\"$smoke_id\",\"events\":[{\"kind\":\"egress\",\"peer\":\"169.254.169.254\",\"port\":80}]}") || fail "native Sentry smoke request"
[[ $(printf '%s' "$smoke" | json_value data.acceptedEvents) == 1 ]] || fail "native Sentry acceptedEvents"
[[ $(printf '%s' "$smoke" | json_value data.items.0.verdict) == block ]] || fail "native Sentry block verdict"
pass "ARM64 native Sentry ingest decision"

source_body="{\"sourceId\":\"$SOURCE_ID\",\"limit\":5}"
before=$(post_json sources/list "$source_body") || fail "Observer Source status before smoke"
before_accepted=$(printf '%s' "$before" | json_value data.items.0.acceptedEvents)
before_rejected=$(printf '%s' "$before" | json_value data.items.0.rejectedEvents)
[[ -n $before_accepted ]] || before_accepted=-1
[[ -n $before_rejected ]] || before_rejected=-1
[[ $before_accepted =~ ^[0-9]+$ ]] || fail "Observer Source acceptedEvents is unavailable"

/bin/sh -c 'echo anysentry-uos-observer-verify >/dev/null'
/usr/bin/env >/dev/null
/bin/ls /etc >/dev/null

after=$before
for _ in $(seq 1 30); do
  sleep 1
  after=$(post_json sources/list "$source_body") || continue
  after_accepted=$(printf '%s' "$after" | json_value data.items.0.acceptedEvents)
  [[ -n $after_accepted ]] || after_accepted=-1
  [[ $after_accepted =~ ^[0-9]+$ && $after_accepted -gt $before_accepted ]] && break
done
[[ ${after_accepted:-0} -gt $before_accepted ]] || fail "Observer Source acceptedEvents did not increase"
after_rejected=$(printf '%s' "$after" | json_value data.items.0.rejectedEvents)
[[ -n $after_rejected ]] || after_rejected=-1
[[ $after_rejected == "$before_rejected" ]] || fail "Observer Source rejectedEvents increased"
[[ $(printf '%s' "$after" | json_value data.items.0.status) == active ]] || fail "Observer Source is not active"
pass "Observer Source acceptedEvents increased without rejection"

if ! collector=$(wait_for_collector_health); then
  state=$(printf '%s' "$collector" | collector_value state)
  attached_probes=$(printf '%s' "$collector" | collector_value attachedProbes)
  [[ -n $attached_probes ]] || attached_probes=-1
  echo "Collector health response: $collector" >&2
  fail "collector did not become ready within 60 seconds; state=${state:-missing} attachedProbes=${attached_probes:--1}"
fi
state=$(printf '%s' "$collector" | collector_value state)
output_dropped=$(printf '%s' "$collector" | collector_value outputDropped)
error_count=$(printf '%s' "$collector" | collector_value errorCount)
attached_probes=$(printf '%s' "$collector" | collector_value attachedProbes)
[[ -n $output_dropped ]] || output_dropped=-1
[[ -n $error_count ]] || error_count=-1
[[ -n $attached_probes ]] || attached_probes=-1
[[ $state == healthy ]] || {
  echo "Collector health response: $collector" >&2
  fail "collector state is ${state:-missing}"
}
[[ $output_dropped == 0 ]] || {
  echo "Collector health response: $collector" >&2
  fail "collector outputDropped=$output_dropped"
}
[[ $error_count == 0 ]] || {
  echo "Collector health response: $collector" >&2
  fail "collector errorCount=$error_count"
}
[[ $attached_probes =~ ^[0-9]+$ && $attached_probes -ge 8 ]] ||
  {
    echo "Collector health response: $collector" >&2
    fail "collector attachedProbes=$attached_probes; expected at least 8"
  }
pass "Observer collector is healthy; outputDropped=0 errorCount=0 attachedProbes=$attached_probes"

echo "AnySentry verification completed successfully. acceptedEvents=$before_accepted->$after_accepted rejectedEvents=$after_rejected"
