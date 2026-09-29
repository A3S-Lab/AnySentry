#!/usr/bin/env bash
# Read-only field bundle for a UOS host. Secrets are fingerprinted, never copied.
set -u

INSTALL_ROOT=${ANYSENTRY_INSTALL_ROOT:-/opt/anysentry}
ENV_FILE=${ANYSENTRY_ENV_FILE:-/etc/anysentry/anysentry.env}
LOG_DIR=${ANYSENTRY_LOG_DIR:-/var/log/anysentry}
STAMP=$(date +%Y%m%d-%H%M%S)
HOST=$(hostname 2>/dev/null || echo host)
OUT=${1:-/tmp/anysentry-support-${HOST}-${STAMP}.tar.gz}
WORKDIR=$(mktemp -d /tmp/anysentry-support.XXXXXX)
UNITS=(
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

note() { printf '%s\n' "$*"; }
run() {
  printf '\n$ %s\n' "$*"
  "$@" 2>&1 || printf '[exit=%s]\n' "$?"
}

env_value() {
  local key=$1 file=$2
  [[ -r $file ]] || return 0
  awk -F= -v key="$key" '$1==key {print substr($0, index($0, "=")+1); exit}' "$file"
}

fingerprint() {
  local value=$1
  if [[ -z $value ]]; then
    printf 'empty\n'
    return
  fi
  printf 'set length=%s fingerprint=%s\n' "${#value}" "$(printf '%s' "$value" | sha256sum | awk '{print substr($1,1,12)}')"
}

redact_env() {
  local line key value
  while IFS= read -r line || [[ -n $line ]]; do
    case "$line" in
      ''|\#*) printf '%s\n' "$line"; continue ;;
    esac
    key=${line%%=*}
    value=${line#*=}
    case "$key" in
      *KEY*|*TOKEN*|*PASSWORD*|*SECRET*|*CREDENTIAL*)
        printf '%s=%s\n' "$key" "$(fingerprint "$value")"
        ;;
      *) printf '%s\n' "$line" ;;
    esac
  done
}

cleanup() { rm -rf "$WORKDIR"; }
trap cleanup EXIT

mkdir -p "$WORKDIR/journal" "$WORKDIR/install"
{
  note "ANYSENTRY SUPPORT BUNDLE"
  run date -Is
  run hostname
  run id
  printf 'output=%s\n' "$OUT"
} >"$WORKDIR/summary.txt"

{
  note "HOST"
  run uname -a
  run getconf GNU_LIBC_VERSION
  run getconf PAGESIZE
  run nproc
  run free -h
  run df -hT / /opt /var /var/lib /tmp
  run uptime
  printf '\n$ os-release\n'
  cat /etc/os-release 2>/dev/null || true
  printf '\n$ cgroup\n'
  stat -fc 'cgroup_fs=%T' /sys/fs/cgroup 2>/dev/null || true
  printf '\n$ bpf\n'
  sysctl kernel.unprivileged_bpf_disabled kernel.perf_event_paranoid kernel.kptr_restrict 2>/dev/null || true
  if [[ -e /sys/kernel/btf/vmlinux ]]; then
    echo '/sys/kernel/btf/vmlinux: present'
  else
    echo '/sys/kernel/btf/vmlinux: absent'
  fi
  if [[ -d /sys/kernel/debug/tracing ]]; then
    echo '/sys/kernel/debug/tracing: present'
  else
    echo '/sys/kernel/debug/tracing: absent'
  fi
} >"$WORKDIR/host.txt"

{
  note "SERVICES"
  if command -v systemctl >/dev/null 2>&1; then
    systemctl --failed --no-pager 2>&1 || true
    for unit in "${UNITS[@]}"; do
      printf '\n===== %s =====\n' "$unit"
      systemctl is-active "$unit" 2>&1 || true
      systemctl show "$unit" --no-pager \
        -p Id -p ActiveState -p SubState -p Result -p NRestarts \
        -p MemoryCurrent -p CPUUsageNSec -p ExecMainStatus 2>&1 || true
      systemctl status "$unit" --no-pager -l 2>&1 | head -n 40 || true
    done
  else
    echo 'systemctl: unavailable'
  fi
} >"$WORKDIR/services.txt"

{
  note "PERFORMANCE"
  run cat /proc/loadavg
  run free -h
  printf '\n$ process sample\n'
  ps -eo pid,user,pcpu,pmem,rss,comm,args --sort=-rss 2>/dev/null |
    awk 'NR==1 || /anysentry|clickhouse|kafka|flink|redis-server|a3s-observer|java/ {print}' |
    head -n 40 || true
  if command -v vmstat >/dev/null 2>&1; then
    vmstat 1 3 || true
  fi
} >"$WORKDIR/performance.txt"

{
  note "MODEL CONFIG"
  echo 'Secret values are replaced with length and sha256 prefix.'
  if [[ -r $ENV_FILE ]]; then
    redact_env <"$ENV_FILE"
  else
    echo "environment file is not readable: $ENV_FILE"
  fi
} >"$WORKDIR/model-config.txt"

TOKEN=$(env_value ANYSENTRY_ADMIN_TOKEN "$ENV_FILE")
NODE=${ANYSENTRY_NODE:-$INSTALL_ROOT/runtime/node/bin/node}
[[ -x $NODE ]] || NODE=$(command -v node 2>/dev/null || true)
if [[ -n $TOKEN ]] && command -v curl >/dev/null 2>&1; then
  curl --connect-timeout 2 --max-time 15 -fsS \
    -H "x-anysentry-management-token: $TOKEN" \
    http://127.0.0.1:29653/security-center/config/model-connections \
    >"$WORKDIR/model-connections.raw" 2>"$WORKDIR/model-connections.err" || true
  if [[ -s $WORKDIR/model-connections.raw && -n $NODE ]]; then
    "$NODE" -e '
      const fs = require("fs");
      const raw = fs.readFileSync(process.argv[1], "utf8");
      const secret = /key|token|password|secret|credential/i;
      const walk = (value) => {
        if (Array.isArray(value)) return value.map(walk);
        if (value && typeof value === "object") {
          return Object.fromEntries(Object.entries(value).map(([key, item]) => {
            if (secret.test(key) && typeof item === "string") {
              return [key, item ? `set length=${item.length}` : "empty"];
            }
            return [key, walk(item)];
          }));
        }
        return value;
      };
      try {
        process.stdout.write(JSON.stringify(walk(JSON.parse(raw)), null, 2) + "\n");
      } catch (error) {
        process.stdout.write("model-connections response was not json\n");
      }
    ' "$WORKDIR/model-connections.raw" >"$WORKDIR/model-connections.json" || true
  elif [[ -s $WORKDIR/model-connections.err ]]; then
    echo 'model-connections request failed; see model-connections.err' >"$WORKDIR/model-connections.json"
  else
    echo 'model-connections was not collected' >"$WORKDIR/model-connections.json"
  fi
  rm -f "$WORKDIR/model-connections.raw"
else
  echo 'model-connections skipped: admin token or curl unavailable' >"$WORKDIR/model-connections.json"
fi

{
  note "HEALTH"
  if command -v curl >/dev/null 2>&1; then
    printf '\n$ healthz\n'
    curl --connect-timeout 2 --max-time 15 -fsS http://127.0.0.1:29653/security-center/healthz 2>&1 || true
    printf '\n\n$ collectors\n'
    if [[ -n $TOKEN ]]; then
      curl --connect-timeout 2 --max-time 15 -fsS \
        -H "x-anysentry-management-token: $TOKEN" \
        http://127.0.0.1:29653/security-center/collectors 2>&1 || true
    else
      echo 'collector query skipped: admin token unavailable'
    fi
    printf '\n'
  fi
  if [[ -x $INSTALL_ROOT/clickhouse/bin/clickhouse ]]; then
    printf '\n$ clickhouse\n'
    curl --connect-timeout 2 --max-time 10 -fsS http://127.0.0.1:8123/ping 2>&1 || true
  fi
} >"$WORKDIR/health.txt"

if [[ -d $LOG_DIR/install ]]; then
  find "$LOG_DIR/install" -type f \
    \( -name summary.txt -o -name current-stage.txt -o -name rollback.log -o -name install.log -o -name verify.log \) \
    -print 2>/dev/null | while IFS= read -r file; do
    rel=${file#"$LOG_DIR/install/"}
    dest="$WORKDIR/install/${rel//\//__}"
    if [[ $file == *.log ]]; then
      tail -n 400 "$file" >"$dest" 2>/dev/null || true
    else
      cp -a "$file" "$dest" 2>/dev/null || true
    fi
  done
fi

if [[ -f $LOG_DIR/clickhouse-server.err.log ]]; then
  tail -n 200 "$LOG_DIR/clickhouse-server.err.log" >"$WORKDIR/clickhouse-server.err.log" 2>/dev/null || true
fi
if [[ -f $LOG_DIR/clickhouse-server.log ]]; then
  tail -n 200 "$LOG_DIR/clickhouse-server.log" >"$WORKDIR/clickhouse-server.log" 2>/dev/null || true
fi

if command -v journalctl >/dev/null 2>&1; then
  for unit in "${UNITS[@]}"; do
    journalctl -u "$unit" --no-pager -n 250 >"$WORKDIR/journal/${unit}.log" 2>&1 || true
  done
fi

{
  echo "host=$(uname -n 2>/dev/null || true)"
  echo "kernel=$(uname -r 2>/dev/null || true)"
  echo "arch=$(uname -m 2>/dev/null || true)"
  if [[ -r $INSTALL_ROOT/VERSION ]]; then
    cat "$INSTALL_ROOT/VERSION"
  else
    echo 'release=not-installed'
  fi
  for unit in anysentry.service anysentry-observer.service anysentry-fast-judge.service anysentry-composite-judge.service anysentry-stream-worker.service anysentry-flink-job.service; do
    if command -v systemctl >/dev/null 2>&1; then
      printf '%s=%s\n' "$unit" "$(systemctl is-active "$unit" 2>/dev/null || echo unknown)"
    fi
  done
  latest=$(find "$LOG_DIR/install" -name current-stage.txt -printf '%T@ %p\n' 2>/dev/null | sort -n | awk 'END {print $2}')
  if [[ -n ${latest:-} && -r $latest ]]; then
    echo "install_stage_file=$latest"
    cat "$latest"
  fi
} >>"$WORKDIR/summary.txt"

mkdir -p "$(dirname "$OUT")"
tar -C "$WORKDIR" -czf "$OUT" .
printf 'support bundle written: %s\n' "$OUT"
