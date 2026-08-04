#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
SCRIPT=$ROOT/uos20-arm64/package/RUN_HEALTH_SMOKE.sh
[[ -x $SCRIPT ]] || {
  echo "FAIL health smoke script is missing or not executable: $SCRIPT" >&2
  exit 1
}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
fake_bin=$tmp/bin
install_root=$tmp/opt/anysentry
env_file=$tmp/etc/anysentry.env
report_dir=$tmp/report
mkdir -p "$fake_bin" "$install_root/runtime/node/bin" "$install_root/redis/bin" \
  "$install_root/java/bin" "$install_root/kafka/bin" "$(dirname "$env_file")"
ln -s "$(command -v node)" "$install_root/runtime/node/bin/node"
cat > "$install_root/VERSION" <<'EOF'
RELEASE_VERSION=0.3.0-compat1
BPF_KERNEL_VERSION=4.19.90
EOF
cat > "$env_file" <<'EOF'
PORT=29653
CLICKHOUSE_USER=anysentry
CLICKHOUSE_PASSWORD=test-password
ANYSENTRY_SOURCE_ID=src_test
A3S_OBSERVER_COLLECTOR_ID=observer-test
EOF

cat > "$fake_bin/systemctl" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  is-active) echo active; exit 0 ;;
  show) printf 'ActiveState=active\nSubState=running\nNRestarts=0\n'; exit 0 ;;
  *) exit 0 ;;
esac
EOF

cat > "$fake_bin/journalctl" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

cat > "$fake_bin/uname" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  -m) echo aarch64 ;;
  -r) echo 4.19.0-arm64-server ;;
  *) echo 'Linux test 4.19.0-arm64-server aarch64' ;;
esac
EOF

cat > "$fake_bin/getconf" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  PAGESIZE) echo 65536 ;;
  GNU_LIBC_VERSION) echo 'glibc 2.28' ;;
  *) exit 1 ;;
esac
EOF

cat > "$fake_bin/sysctl" <<'EOF'
#!/usr/bin/env bash
[[ "$*" == *vm.overcommit_memory* ]] && echo 1
EOF

cat > "$fake_bin/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
all="$*"
body=
previous=
for value in "$@"; do
  if [[ $previous == --data-binary ]]; then body=$value; fi
  previous=$value
done
case "$all" in
  *:8123/ping*) printf 'Ok.\n' ;;
  *security-center/healthz*)
    printf '%s\n' '{"code":200,"data":{"status":"ok","storage":{"mode":"clickhouse","clickhouseReady":true},"policy":{"l1":true,"l2":false,"l3":false}}}'
    ;;
  *security-center/sources/list*)
    counter_file=${FAKE_SOURCE_COUNTER_FILE:?}
    counter=$(cat "$counter_file" 2>/dev/null || echo 100)
    counter=$((counter + 1))
    printf '%s\n' "$counter" > "$counter_file"
    printf '{"code":200,"data":{"items":[{"sourceId":"src_test","status":"active","acceptedEvents":%s,"rejectedEvents":0,"lastHeartbeatAt":"2026-07-23 10:00:00"}]}}\n' "$counter"
    ;;
  *security-center/collectors/health*)
    state=${FAKE_COLLECTOR_STATE:-healthy}
    probes=8
    [[ $state == healthy ]] || probes=0
    printf '{"code":200,"data":{"items":[{"collectorId":"observer-test","state":"%s","attachedProbes":%s,"outputDropped":0,"errorCount":0,"queueDepth":0}]}}\n' "$state" "$probes"
    ;;
  *security-center/ingest/events*)
    if [[ $body == *169.254.169.254* ]]; then verdict=block; else verdict=allow; fi
    accepted=1
    [[ $body == *'"kind":"file"'* ]] && accepted=3
    printf '{"code":200,"data":{"acceptedEvents":%s,"items":[{"eventId":"evt_test","verdict":"%s"}]}}\n' "$accepted" "$verdict"
    ;;
  *security-center/events/list*)
    printf '%s\n' '{"code":200,"data":{"items":[{"eventId":"evt_test","agentId":"a3s-health-smoke-test","verdict":"block"}],"total":1}}'
    ;;
  *:8081/overview*) printf '%s\n' '{"taskmanagers":1,"slots-total":2,"slots-available":1}' ;;
  *:8081/jobs/overview*) printf '%s\n' '{"jobs":[{"name":"AnySentry Flink Shadow Risk","state":"RUNNING"}]}' ;;
  *127.0.0.1:29653/*) printf '%s\n' '<!doctype html><title>AnySentry</title>' ;;
  *) echo "unexpected curl call: $all" >&2; exit 22 ;;
esac
EOF

cat > "$install_root/redis/bin/redis-cli" <<'EOF'
#!/usr/bin/env bash
echo PONG
EOF
cat > "$install_root/kafka/bin/kafka-topics.sh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' anysentry.events.canonical.v1 anysentry.judgments.v1 anysentry.risk-analysis-batches.v1 anysentry.stream.findings.v1 anysentry.stream.dlq.v1
EOF
cat > "$install_root/java/bin/java" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$fake_bin/systemctl" "$fake_bin/journalctl" "$fake_bin/uname" \
  "$fake_bin/getconf" "$fake_bin/sysctl" "$fake_bin/curl" \
  "$install_root/redis/bin/redis-cli" "$install_root/kafka/bin/kafka-topics.sh" \
  "$install_root/java/bin/java"

run_smoke() {
  PATH="$fake_bin:$PATH" \
  ANYSENTRY_SMOKE_INSTALL_ROOT="$install_root" \
  ANYSENTRY_SMOKE_ENV_FILE="$env_file" \
  ANYSENTRY_SMOKE_REPORT_DIR="$report_dir" \
  FAKE_SOURCE_COUNTER_FILE="$tmp/source-counter" \
  "$SCRIPT" "$@"
}

help=$(run_smoke --help)
for term in --passive --safe --extended; do
  grep -Fq -- "$term" <<<"$help" || {
    echo "FAIL help omits $term" >&2
    exit 1
  }
done

run_smoke --passive >/dev/null
grep -Fq 'mode=passive' "$report_dir/report.txt"
! grep -Fq 'Sentry block simulation' "$report_dir/report.txt"

run_smoke --safe >/dev/null
grep -Fq 'mode=safe' "$report_dir/report.txt"
grep -Fq 'PASS Sentry block simulation' "$report_dir/report.txt"
grep -Fq 'PASS safe loopback TCP simulation' "$report_dir/report.txt"

run_smoke --extended >/dev/null
grep -Fq 'mode=extended' "$report_dir/report.txt"
grep -Fq 'PASS extended Sentry simulations' "$report_dir/report.txt"

set +e
FAKE_COLLECTOR_STATE=down run_smoke --passive >/dev/null 2>&1
rc=$?
set -e
[[ $rc -ne 0 ]] || {
  echo "FAIL unhealthy collector returned success" >&2
  exit 1
}
grep -Fq 'FAIL Observer collector state=down' "$report_dir/report.txt"

echo "PASS UOS health smoke modes and failure behavior"
