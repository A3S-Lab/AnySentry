#!/usr/bin/env bash
set -uo pipefail

SCRIPT_VERSION=0.3.0-compat1
INSTALL_ROOT=${ANYSENTRY_SMOKE_INSTALL_ROOT:-/opt/anysentry}
ENV_FILE=${ANYSENTRY_SMOKE_ENV_FILE:-/etc/anysentry/anysentry.env}
export JAVA_HOME=$INSTALL_ROOT/java
export PATH=$JAVA_HOME/bin:$PATH
REPORT_DIR=${ANYSENTRY_SMOKE_REPORT_DIR:-/tmp/anysentry-health-smoke-0.3.0-compat1}
REPORT=$REPORT_DIR/report.txt
MODE=safe
PASS_COUNT=0
WARN_COUNT=0
FAIL_COUNT=0

usage() {
  cat <<'EOF'
Usage: ./RUN_HEALTH_SMOKE.sh [--passive|--safe|--extended]

Modes:
  --passive   Read-only service, endpoint, Source, Collector and log checks.
  --safe      Default. Passive checks plus safe local operations and one uniquely
              tagged Sentry block simulation.
  --extended  Safe checks plus a multi-category Sentry ingestion simulation.
  --help      Show this help.

The script never restarts services, changes configuration, reads the Observer
token, contacts an external network, or performs destructive system operations.
The report is overwritten at /tmp/anysentry-health-smoke-0.3.0-compat1/report.txt.
EOF
}

case "${1:---safe}" in
  --passive) MODE=passive ;;
  --safe) MODE=safe ;;
  --extended) MODE=extended ;;
  -h|--help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac
[[ $# -le 1 ]] || { usage >&2; exit 2; }

mkdir -p "$REPORT_DIR" || {
  echo "FAIL cannot create report directory: $REPORT_DIR" >&2
  exit 1
}
find "$REPORT_DIR" -maxdepth 1 -type f -delete 2>/dev/null || true
exec > >(tee "$REPORT") 2>&1

section() {
  printf '\n===== %s =====\n' "$*"
}

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  echo "PASS $*"
}

warn() {
  WARN_COUNT=$((WARN_COUNT + 1))
  echo "WARN $*"
}

fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  echo "FAIL $*"
}

env_value() {
  local key=$1
  awk -v key="$key" '
    index($0, key "=") == 1 {
      sub(/^[^=]*=/, "")
      value=$0
    }
    END {
      prefix=key "="
      while (index(value, prefix) == 1) value=substr(value, length(prefix) + 1)
      if (value != "") print value
    }
  ' "$ENV_FILE" 2>/dev/null
}

json_path() {
  local path=$1
  "$NODE" -e '
    let raw="";
    process.stdin.on("data", c => raw += c);
    process.stdin.on("end", () => {
      try {
        const payload=JSON.parse(raw);
        const value=process.argv[1].split(".").filter(Boolean)
          .reduce((current, key) => current == null ? undefined : current[key], payload);
        if (value !== undefined && value !== null) process.stdout.write(String(value));
      } catch (_) {
        process.exitCode=2;
      }
    });
  ' "$path"
}

item_field() {
  local id_field=$1 id_value=$2 field=$3
  "$NODE" -e '
    let raw="";
    process.stdin.on("data", c => raw += c);
    process.stdin.on("end", () => {
      try {
        const payload=JSON.parse(raw);
        const item=payload?.data?.items?.find(
          value => String(value?.[process.argv[1]] ?? "") === process.argv[2]
        );
        const result=item?.[process.argv[3]];
        if (result !== undefined && result !== null) process.stdout.write(String(result));
      } catch (_) {
        process.exitCode=2;
      }
    });
  ' "$id_field" "$id_value" "$field"
}

post_json() {
  local path=$1 body=$2
  curl --connect-timeout 2 --max-time 20 -fsS -X POST \
    "http://127.0.0.1:$API_PORT/security-center/$path" \
    -H 'Content-Type: application/json' \
    --data-binary "$body"
}

save_raw() {
  local name=$1 value=$2
  printf '%s\n' "$value" > "$REPORT_DIR/$name"
}

numeric_or() {
  local value=$1 fallback=$2
  if [[ $value =~ ^[0-9]+$ ]]; then printf '%s\n' "$value"; else printf '%s\n' "$fallback"; fi
}

SERVICES=(
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

RUN_ID="a3s-health-smoke-$(date +%Y%m%d%H%M%S)-$$"
TEMP_DIR=
cleanup() {
  [[ -z ${TEMP_DIR:-} ]] || rm -rf "$TEMP_DIR"
}
trap cleanup EXIT INT TERM

section "A3S UOS HEALTH SMOKE"
echo "schema=a3s.uos-health-smoke.v1"
echo "script_version=$SCRIPT_VERSION"
echo "mode=$MODE"
echo "run_id=$RUN_ID"
echo "started_at=$(date --iso-8601=seconds 2>/dev/null || date)"
echo "install_root=$INSTALL_ROOT"
echo "env_file=$ENV_FILE"
echo "report=$REPORT"

section "PREREQUISITES AND VERSION"
for command_name in curl systemctl journalctl awk grep getconf sha256sum; do
  if command -v "$command_name" >/dev/null 2>&1; then
    pass "required command is available: $command_name"
  else
    fail "required command is missing: $command_name"
  fi
done

NODE=$INSTALL_ROOT/runtime/node/bin/node
if [[ -x $NODE ]]; then
  pass "bundled Node runtime is executable: $("$NODE" --version 2>/dev/null)"
else
  fail "bundled Node runtime is missing: $NODE"
  NODE=$(command -v node 2>/dev/null || true)
fi

if [[ -r $INSTALL_ROOT/VERSION ]]; then
  cat "$INSTALL_ROOT/VERSION"
  installed_release=$(awk -F= '$1=="RELEASE_VERSION" {print $2; exit}' "$INSTALL_ROOT/VERSION")
  if [[ $installed_release == 0.3.0-compat1 ]]; then
    pass "installed release is $installed_release"
  else
    warn "script targets 0.3.0-compat1; installed release is ${installed_release:-unknown}"
  fi
else
  fail "installed VERSION file is missing"
fi

if [[ -r $ENV_FILE ]]; then
  pass "protected environment is readable"
else
  fail "protected environment is not readable; run as root: $ENV_FILE"
fi

architecture=$(uname -m 2>/dev/null || true)
page_size=$(getconf PAGESIZE 2>/dev/null || true)
glibc=$(getconf GNU_LIBC_VERSION 2>/dev/null | awk '{print $2}')
kernel=$(uname -r 2>/dev/null || true)
echo "architecture=$architecture"
echo "page_size=$page_size"
echo "glibc=$glibc"
echo "kernel=$kernel"
[[ $architecture == aarch64 ]] && pass "host architecture is aarch64" ||
  fail "host architecture is ${architecture:-unknown}; expected aarch64"
[[ $page_size == 65536 ]] && pass "host page size is 65536" ||
  fail "host page size is ${page_size:-unknown}; expected 65536"
if [[ -n $glibc && $(printf '2.28\n%s\n' "$glibc" | sort -V | head -n1) == 2.28 ]]; then
  pass "glibc $glibc satisfies minimum 2.28"
else
  fail "glibc ${glibc:-unknown} is older than 2.28"
fi

if [[ -r $INSTALL_ROOT/manifest.sha256 ]]; then
  if (cd "$INSTALL_ROOT" && sha256sum --check --quiet manifest.sha256); then
    pass "installed manifest checksums are valid"
  else
    fail "installed manifest checksum verification failed"
  fi
else
  warn "installed manifest.sha256 is unavailable"
fi

section "PERSISTED RESOURCE CONFIGURATION"
if [[ -r /etc/sysctl.d/90-anysentry.conf ]] &&
  grep -Eq '^[[:space:]]*vm\.overcommit_memory[[:space:]]*=[[:space:]]*1' \
    /etc/sysctl.d/90-anysentry.conf; then
  pass "vm.overcommit_memory=1 is persisted"
else
  warn "persistent vm.overcommit_memory=1 was not confirmed"
fi
current_overcommit=$(sysctl -n vm.overcommit_memory 2>/dev/null || true)
[[ $current_overcommit == 1 ]] && pass "runtime vm.overcommit_memory=1" ||
  warn "runtime vm.overcommit_memory=${current_overcommit:-unknown}"

section "SYSTEMD SERVICES"
for service in "${SERVICES[@]}"; do
  if systemctl is-active --quiet "$service"; then
    pass "$service is active"
  else
    state=$(systemctl is-active "$service" 2>/dev/null || true)
    fail "$service is ${state:-unknown}"
  fi
  systemctl show "$service" \
    -p ActiveState -p SubState -p NRestarts -p MemoryCurrent -p MemoryHigh -p MemoryMax \
    --no-pager 2>/dev/null |
    sed "s/^/$service /" || true
done

if [[ ! -r $ENV_FILE || -z ${NODE:-} || ! -x ${NODE:-/nonexistent} ]]; then
  section "SUMMARY"
  echo "pass=$PASS_COUNT"
  echo "warn=$WARN_COUNT"
  echo "fail=$FAIL_COUNT"
  echo "RESULT=FAIL prerequisites prevent endpoint validation"
  exit 1
fi

API_PORT=$(env_value PORT); [[ -n $API_PORT ]] || API_PORT=29653
CLICKHOUSE_USER=$(env_value CLICKHOUSE_USER); [[ -n $CLICKHOUSE_USER ]] || CLICKHOUSE_USER=anysentry
CLICKHOUSE_PASSWORD=$(env_value CLICKHOUSE_PASSWORD)
SOURCE_ID=$(env_value ANYSENTRY_SOURCE_ID)
COLLECTOR_ID=$(env_value A3S_OBSERVER_COLLECTOR_ID)

echo "api_port=$API_PORT"
echo "source_id=$SOURCE_ID"
echo "collector_id=$COLLECTOR_ID"
[[ -n $SOURCE_ID ]] && pass "Observer Source ID is configured" ||
  fail "ANYSENTRY_SOURCE_ID is missing"
if [[ $COLLECTOR_ID =~ ^[A-Za-z0-9._:-]+$ ]]; then
  pass "Observer Collector ID is valid"
else
  fail "Observer Collector ID is missing or invalid: ${COLLECTOR_ID:-empty}"
fi

section "DATABASE AND HTTP READINESS"
if "$INSTALL_ROOT/redis/bin/redis-cli" -h 127.0.0.1 -p 6379 ping 2>/dev/null |
  grep -qx PONG; then
  pass "Redis loopback readiness"
else
  fail "Redis loopback readiness"
fi

if curl --connect-timeout 2 --max-time 10 -fsS \
  --user "$CLICKHOUSE_USER:$CLICKHOUSE_PASSWORD" \
  http://127.0.0.1:8123/ping 2>/dev/null | grep -q '^Ok'; then
  pass "ClickHouse loopback readiness"
else
  fail "ClickHouse loopback readiness"
fi

if "$INSTALL_ROOT/kafka/bin/kafka-topics.sh" --bootstrap-server 127.0.0.1:9092 \
  --list >"$REPORT_DIR/kafka-topics.txt" 2>/dev/null &&
  grep -Fxq anysentry.events.canonical.v1 "$REPORT_DIR/kafka-topics.txt"; then
  pass "Kafka loopback readiness and canonical topic"
else
  fail "Kafka loopback readiness or canonical topic"
fi

flink_overview=$(curl --connect-timeout 2 --max-time 15 -fsS \
  http://127.0.0.1:8081/overview 2>/dev/null || true)
flink_jobs=$(curl --connect-timeout 2 --max-time 15 -fsS \
  http://127.0.0.1:8081/jobs/overview 2>/dev/null || true)
save_raw flink-overview.json "${flink_overview:-{\"error\":\"unavailable\"}}"
save_raw flink-jobs.json "${flink_jobs:-{\"error\":\"unavailable\"}}"
if grep -Fq 'AnySentry Flink Shadow Risk' <<<"$flink_jobs" &&
  grep -Eq '"state"[[:space:]]*:[[:space:]]*"RUNNING"' <<<"$flink_jobs"; then
  pass "Flink streaming job is running"
else
  fail "Flink streaming job is unavailable or not running"
fi

health=$(curl --connect-timeout 2 --max-time 15 -fsS \
  "http://127.0.0.1:$API_PORT/security-center/healthz" 2>/dev/null || true)
save_raw api-health.json "${health:-{\"error\":\"unavailable\"}}"
health_status=$(printf '%s' "$health" | json_path data.status 2>/dev/null || true)
storage_mode=$(printf '%s' "$health" | json_path data.storage.mode 2>/dev/null || true)
clickhouse_ready=$(printf '%s' "$health" | json_path data.storage.clickhouseReady 2>/dev/null || true)
if [[ $health_status == ok && $storage_mode == clickhouse && $clickhouse_ready == true ]]; then
  pass "API health and ClickHouse storage mode"
else
  fail "API health status=$health_status storage=$storage_mode clickhouseReady=$clickhouse_ready"
fi

if curl --connect-timeout 2 --max-time 15 -fsS \
  "http://127.0.0.1:$API_PORT/anysentry/" 2>/dev/null |
  grep -Eqi '<!doctype|<html|AnySentry'; then
  pass "dashboard HTTP endpoint"
else
  fail "dashboard HTTP endpoint"
fi

l1=$(printf '%s' "$health" | json_path data.policy.l1 2>/dev/null || true)
l2=$(printf '%s' "$health" | json_path data.policy.l2 2>/dev/null || true)
l3=$(printf '%s' "$health" | json_path data.policy.l3 2>/dev/null || true)
[[ $l1 == true ]] && pass "L1 policy is enabled" || fail "L1 policy is not enabled"
[[ $l2 == true ]] && pass "L2 policy is enabled" || warn "L2 policy is disabled"
[[ $l3 == true ]] && pass "L3 policy is enabled" || warn "L3 policy is disabled"

section "SOURCE AND COLLECTOR"
source_body="{\"sourceId\":\"$SOURCE_ID\",\"limit\":5}"
source_response=$(post_json sources/list "$source_body" 2>/dev/null || true)
save_raw source-status.json "${source_response:-{\"error\":\"unavailable\"}}"
source_status=$(printf '%s' "$source_response" |
  item_field sourceId "$SOURCE_ID" status 2>/dev/null || true)
before_accepted=$(printf '%s' "$source_response" |
  item_field sourceId "$SOURCE_ID" acceptedEvents 2>/dev/null || true)
before_rejected=$(printf '%s' "$source_response" |
  item_field sourceId "$SOURCE_ID" rejectedEvents 2>/dev/null || true)
before_accepted=$(numeric_or "$before_accepted" -1)
before_rejected=$(numeric_or "$before_rejected" -1)
if [[ $source_status == active ]]; then
  pass "Observer Source is active; acceptedEvents=$before_accepted rejectedEvents=$before_rejected"
else
  fail "Observer Source state=${source_status:-missing}"
fi

collector_body="{\"timeType\":\"last_3h\",\"collectorId\":\"$COLLECTOR_ID\",\"limit\":5}"
collector_response=$(post_json collectors/health "$collector_body" 2>/dev/null || true)
save_raw collector-health.json "${collector_response:-{\"error\":\"unavailable\"}}"
collector_state=$(printf '%s' "$collector_response" |
  item_field collectorId "$COLLECTOR_ID" state 2>/dev/null || true)
attached_probes=$(printf '%s' "$collector_response" |
  item_field collectorId "$COLLECTOR_ID" attachedProbes 2>/dev/null || true)
output_dropped=$(printf '%s' "$collector_response" |
  item_field collectorId "$COLLECTOR_ID" outputDropped 2>/dev/null || true)
error_count=$(printf '%s' "$collector_response" |
  item_field collectorId "$COLLECTOR_ID" errorCount 2>/dev/null || true)
queue_depth=$(printf '%s' "$collector_response" |
  item_field collectorId "$COLLECTOR_ID" queueDepth 2>/dev/null || true)
attached_probes=$(numeric_or "$attached_probes" -1)
output_dropped=$(numeric_or "$output_dropped" -1)
error_count=$(numeric_or "$error_count" -1)
queue_depth=$(numeric_or "$queue_depth" -1)

[[ $collector_state == healthy ]] &&
  pass "Observer collector state=healthy" ||
  fail "Observer collector state=${collector_state:-missing}"
[[ $attached_probes -ge 8 ]] &&
  pass "Observer collector attachedProbes=$attached_probes" ||
  fail "Observer collector attachedProbes=$attached_probes; expected at least 8"
[[ $output_dropped == 0 ]] &&
  pass "Observer collector outputDropped=0" ||
  fail "Observer collector outputDropped=$output_dropped"
[[ $error_count == 0 ]] &&
  pass "Observer collector errorCount=0" ||
  fail "Observer collector errorCount=$error_count"
[[ $queue_depth -le 100 && $queue_depth -ge 0 ]] &&
  pass "Observer collector queueDepth=$queue_depth" ||
  warn "Observer collector queueDepth=$queue_depth"

if [[ $MODE != passive ]]; then
  section "SAFE LOCAL KERNEL OPERATIONS"
  TEMP_DIR=$(mktemp -d /tmp/anysentry-health-smoke.XXXXXX)
  test_file=$TEMP_DIR/$RUN_ID.txt
  if printf '%s\n' "$RUN_ID" > "$test_file" &&
    grep -Fxq "$RUN_ID" "$test_file" &&
    mv "$test_file" "$test_file.moved" &&
    rm -f "$test_file.moved"; then
    pass "safe process and file simulations"
  else
    fail "safe process and file simulations"
  fi

  if "$NODE" -e '
    const net=require("net");
    const server=net.createServer(socket => socket.end("ok"));
    const timer=setTimeout(() => { server.close(); process.exit(2); }, 5000);
    server.listen(0, "127.0.0.1", () => {
      const address=server.address();
      const client=net.connect(address.port, "127.0.0.1");
      client.on("data", data => {
        if (data.toString() !== "ok") process.exitCode=3;
        clearTimeout(timer);
        client.end();
        server.close(() => process.exit(process.exitCode || 0));
      });
      client.on("error", () => process.exit(4));
    });
  '; then
    pass "safe loopback TCP simulation"
  else
    fail "safe loopback TCP simulation"
  fi

  /bin/sh -c "echo $RUN_ID >/dev/null"
  /usr/bin/env >/dev/null
  /bin/ls /etc >/dev/null

  section "SENTRY AND STORAGE SIMULATION"
  block_payload="{\"sourceType\":\"custom\",\"sourceName\":\"uos-health-smoke\",\"workspacePath\":\"health://compat1\",\"agentId\":\"$RUN_ID\",\"sessionId\":\"$RUN_ID\",\"events\":[{\"kind\":\"egress\",\"peer\":\"169.254.169.254\",\"port\":80,\"attributes\":{\"marker\":\"$RUN_ID\",\"simulation\":\"safe\"}}]}"
  block_response=$(post_json ingest/events "$block_payload" 2>/dev/null || true)
  save_raw sentry-block-response.json "${block_response:-{\"error\":\"unavailable\"}}"
  block_accepted=$(printf '%s' "$block_response" |
    json_path data.acceptedEvents 2>/dev/null || true)
  block_verdict=$(printf '%s' "$block_response" |
    json_path data.items.0.verdict 2>/dev/null || true)
  if [[ $block_accepted == 1 && $block_verdict == block ]]; then
    pass "Sentry block simulation acceptedEvents=1 verdict=block marker=$RUN_ID"
  else
    fail "Sentry block simulation acceptedEvents=${block_accepted:-missing} verdict=${block_verdict:-missing}"
  fi

  event_visible=0
  event_response=
  event_body="{\"timeType\":\"last_3h\",\"agentId\":\"$RUN_ID\",\"limit\":20}"
  for _ in $(seq 1 20); do
    event_response=$(post_json events/list "$event_body" 2>/dev/null || true)
    event_total=$(printf '%s' "$event_response" |
      json_path data.total 2>/dev/null || true)
    if [[ $event_total =~ ^[0-9]+$ && $event_total -ge 1 ]]; then
      event_visible=1
      break
    fi
    sleep 1
  done
  save_raw mock-events.json "${event_response:-{\"error\":\"unavailable\"}}"
  [[ $event_visible == 1 ]] &&
    pass "mock event is visible through events/list marker=$RUN_ID" ||
    fail "mock event was not visible through events/list marker=$RUN_ID"

  if [[ $MODE == extended ]]; then
    extended_payload="{\"sourceType\":\"custom\",\"sourceName\":\"uos-health-smoke\",\"workspacePath\":\"health://compat1\",\"agentId\":\"$RUN_ID-extended\",\"sessionId\":\"$RUN_ID-extended\",\"events\":[{\"kind\":\"file\",\"path\":\"/tmp/$RUN_ID.txt\",\"operation\":\"read\"},{\"kind\":\"exec\",\"command\":\"/bin/true\"},{\"kind\":\"egress\",\"peer\":\"127.0.0.1\",\"port\":29653}]}"
    extended_response=$(post_json ingest/events "$extended_payload" 2>/dev/null || true)
    save_raw sentry-extended-response.json "${extended_response:-{\"error\":\"unavailable\"}}"
    extended_accepted=$(printf '%s' "$extended_response" |
      json_path data.acceptedEvents 2>/dev/null || true)
    if [[ $extended_accepted == 3 ]]; then
      pass "extended Sentry simulations acceptedEvents=3"
    else
      fail "extended Sentry simulations acceptedEvents=${extended_accepted:-missing}; expected 3"
    fi
  fi

  after_response=$source_response
  after_accepted=$before_accepted
  after_rejected=$before_rejected
  for _ in $(seq 1 30); do
    sleep 1
    candidate=$(post_json sources/list "$source_body" 2>/dev/null || true)
    candidate_accepted=$(printf '%s' "$candidate" |
      item_field sourceId "$SOURCE_ID" acceptedEvents 2>/dev/null || true)
    candidate_rejected=$(printf '%s' "$candidate" |
      item_field sourceId "$SOURCE_ID" rejectedEvents 2>/dev/null || true)
    candidate_accepted=$(numeric_or "$candidate_accepted" -1)
    candidate_rejected=$(numeric_or "$candidate_rejected" -1)
    after_response=$candidate
    after_accepted=$candidate_accepted
    after_rejected=$candidate_rejected
    [[ $after_accepted -gt $before_accepted ]] && break
  done
  save_raw source-status-after.json "${after_response:-{\"error\":\"unavailable\"}}"
  if [[ $before_accepted -ge 0 && $after_accepted -gt $before_accepted ]]; then
    pass "Observer Source acceptedEvents increased: $before_accepted->$after_accepted"
  else
    fail "Observer Source acceptedEvents did not increase: $before_accepted->$after_accepted"
  fi
  [[ $before_rejected -ge 0 && $after_rejected == "$before_rejected" ]] &&
    pass "Observer Source rejectedEvents unchanged: $after_rejected" ||
    fail "Observer Source rejectedEvents changed: $before_rejected->$after_rejected"
fi

section "RECENT ERROR SIGNALS"
error_pattern='illegal instruction|segfault|out of memory|oom-kill|BPF_PROG_LOAD|no effective legacy probes|MODULE_NOT_FOUND|uncaught|fatal'
for service in "${SERVICES[@]}"; do
  journal_file=$REPORT_DIR/journal-${service%.service}.log
  journalctl -b -u "$service" --since '-10 minutes' --no-pager -o cat \
    > "$journal_file" 2>&1 || true
  if grep -Eqi "$error_pattern" "$journal_file"; then
    warn "$service has a recent error signal; inspect $(basename "$journal_file")"
  else
    pass "$service has no matched fatal signal in the last 10 minutes"
  fi
done

section "SUMMARY"
echo "mode=$MODE"
echo "run_id=$RUN_ID"
echo "pass=$PASS_COUNT"
echo "warn=$WARN_COUNT"
echo "fail=$FAIL_COUNT"
echo "dashboard=http://<host>:$API_PORT/"
echo "report=$REPORT"
echo "completed_at=$(date --iso-8601=seconds 2>/dev/null || date)"
if [[ $FAIL_COUNT -gt 0 ]]; then
  echo "RESULT=FAIL"
  exit 1
fi
echo "RESULT=PASS"
exit 0
