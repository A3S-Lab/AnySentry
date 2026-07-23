#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PACKAGE_ROOT=$SCRIPT_DIR
INSTALL_ROOT=${ANYSENTRY_INSTALL_ROOT:-/opt/anysentry}
INSTALL_PARENT=$(dirname "$INSTALL_ROOT")
CONFIG_DIR=${ANYSENTRY_CONFIG_DIR:-/etc/anysentry}
ENV_FILE=${ANYSENTRY_ENV_FILE:-$CONFIG_DIR/anysentry.env}
STATE_DIR=${ANYSENTRY_STATE_DIR:-/var/lib/anysentry}
LOG_DIR=${ANYSENTRY_LOG_DIR:-/var/log/anysentry}
SYSTEMD_DIR=${ANYSENTRY_SYSTEMD_DIR:-/etc/systemd/system}
SYSCTL_DIR=${ANYSENTRY_SYSCTL_DIR:-/etc/sysctl.d}
COMPAT_RELEASE_ID=0.2.0-compat8
INSTALL_LOG_BASE=${ANYSENTRY_INSTALL_LOG_BASE:-/var/log/anysentry/install}
INSTALL_LOG_ROOT=${ANYSENTRY_INSTALL_LOG_ROOT:-$INSTALL_LOG_BASE/$COMPAT_RELEASE_ID}
TEMP_INSTALL_LOG=${ANYSENTRY_TEMP_INSTALL_LOG:-/tmp/anysentry-install-$COMPAT_RELEASE_ID}
MIN_FREE_KB=$((5 * 1024 * 1024))
CHECK_ONLY=0
STAGING=
ROLLBACK_ROOT=
ROLLBACK_UNITS=
ROLLBACK_ENV=
ACTIVATED=0
HAD_PREVIOUS=0
CURRENT_STAGE=bootstrap
INSTALL_START_TIME=
INSTALL_LOG_READY=0
ROLLBACK_RESULT=not-required
EXPECTED_BPF_VERSION=4.19.90
EXPECTED_BPF_CODE=0x0004135a
SERVICES=(
  anysentry-clickhouse.service
  anysentry-redis.service
  anysentry.service
  anysentry-fast-judge.service
  anysentry-l3-worker.service
  anysentry-observer.service
)
START_SERVICES=(
  anysentry-clickhouse.service
  anysentry-redis.service
  anysentry.service
  anysentry-fast-judge.service
  anysentry-l3-worker.service
  anysentry-observer.service
)
STOP_SERVICES=(
  anysentry-observer.service
  anysentry-l3-worker.service
  anysentry-fast-judge.service
  anysentry.service
  anysentry-redis.service
  anysentry-clickhouse.service
)

usage() {
  cat <<'EOF'
Usage: ./install.sh [--check]

  --check  Verify the release and target ABI without persistent system changes.

The same command performs a first installation or an in-place upgrade. Existing
configuration and persistent ClickHouse data are retained. Failed activation is
rolled back to the previously installed program and systemd units.
EOF
}

fail() { echo "ERROR: $*" >&2; exit 1; }
warn() { echo "WARNING: $*" >&2; }

set_stage() {
  CURRENT_STAGE=$1
  if [[ $INSTALL_LOG_READY -eq 1 ]]; then
    printf '%s\n' "$CURRENT_STAGE" >"$INSTALL_LOG_ROOT/current-stage.txt"
  fi
  echo "Install stage: $CURRENT_STAGE"
}

initialize_install_logging() {
  local persistent_parent
  command -v tee >/dev/null 2>&1 || fail "required command not found: tee"
  INSTALL_START_TIME=$(date '+%Y-%m-%d %H:%M:%S')
  persistent_parent=$(dirname "$INSTALL_LOG_ROOT")
  if install -d -m 0750 "$LOG_DIR" "$persistent_parent" 2>/dev/null; then
    rm -rf "$INSTALL_LOG_ROOT"
    install -d -m 0750 "$INSTALL_LOG_ROOT"
  else
    INSTALL_LOG_ROOT=$TEMP_INSTALL_LOG
    rm -rf "$INSTALL_LOG_ROOT"
    install -d -m 0750 "$INSTALL_LOG_ROOT"
  fi
  if [[ $TEMP_INSTALL_LOG != "$INSTALL_LOG_ROOT" ]]; then
    rm -rf "$TEMP_INSTALL_LOG"
    ln -s "$INSTALL_LOG_ROOT" "$TEMP_INSTALL_LOG"
  fi
  INSTALL_LOG_READY=1
  : >"$INSTALL_LOG_ROOT/install.log"
  exec > >(tee -a "$INSTALL_LOG_ROOT/install.log") 2>&1
  {
    printf 'release=%s\n' "$COMPAT_RELEASE_ID"
    printf 'package=%s\n' "$PACKAGE_ROOT"
    printf 'started_at=%s\n' "$INSTALL_START_TIME"
    printf 'check_only=%s\n' "$CHECK_ONLY"
    printf 'kernel=%s\n' "$(uname -r 2>/dev/null || true)"
    printf 'architecture=%s\n' "$(uname -m 2>/dev/null || true)"
    printf 'glibc=%s\n' "$(getconf GNU_LIBC_VERSION 2>/dev/null || true)"
    printf 'page_size=%s\n' "$(getconf PAGESIZE 2>/dev/null || true)"
  } >"$INSTALL_LOG_ROOT/context.txt"
  printf '%s\n' "$CURRENT_STAGE" >"$INSTALL_LOG_ROOT/current-stage.txt"
  echo "Installation diagnostics: $INSTALL_LOG_ROOT"
  echo "Temporary diagnostics link: $TEMP_INSTALL_LOG"
}

capture_diagnostics() {
  local phase=$1 unit name port collector_id source_id
  [[ $INSTALL_LOG_READY -eq 1 ]] || return 0
  {
    printf 'phase=%s\nstage=%s\ncaptured_at=%s\n' \
      "$phase" "$CURRENT_STAGE" "$(date '+%Y-%m-%d %H:%M:%S')"
    for unit in "${SERVICES[@]}"; do
      printf '%s=' "$unit"
      systemctl is-active "$unit" 2>/dev/null || true
    done
  } >"$INSTALL_LOG_ROOT/services-$phase.txt"
  systemctl status "${SERVICES[@]}" --no-pager -l \
    >>"$INSTALL_LOG_ROOT/services-$phase.txt" 2>&1 || true

  for unit in "${SERVICES[@]}"; do
    case "$unit" in
      anysentry.service) name=api ;;
      anysentry-fast-judge.service) name=fast-judge ;;
      anysentry-l3-worker.service) name=l3-worker ;;
      anysentry-observer.service) name=observer ;;
      anysentry-*.service) name=${unit#anysentry-}; name=${name%.service} ;;
      *) name=${unit%.service} ;;
    esac
    journalctl -b -u "$unit" --since "$INSTALL_START_TIME" --no-pager -o short-precise \
      >"$INSTALL_LOG_ROOT/journal-$name.log" 2>&1 || true
  done

  [[ -f $ENV_FILE ]] || return 0
  port=$(env_value PORT "$ENV_FILE")
  [[ -n $port ]] || port=29653
  collector_id=$(env_value A3S_OBSERVER_COLLECTOR_ID "$ENV_FILE")
  source_id=$(env_value ANYSENTRY_SOURCE_ID "$ENV_FILE")
  curl --connect-timeout 2 --max-time 15 -fsS \
    "http://127.0.0.1:$port/security-center/healthz" \
    >"$INSTALL_LOG_ROOT/health-api-$phase.json" 2>&1 || true
  if [[ -n $source_id ]]; then
    curl --connect-timeout 2 --max-time 15 -fsS -X POST \
      "http://127.0.0.1:$port/security-center/sources/list" \
      -H 'Content-Type: application/json' \
      --data-binary "{\"sourceId\":\"$source_id\",\"limit\":5}" \
      >"$INSTALL_LOG_ROOT/health-source-$phase.json" 2>&1 || true
  fi
  if [[ -n $collector_id ]]; then
    curl --connect-timeout 2 --max-time 15 -fsS -X POST \
      "http://127.0.0.1:$port/security-center/collectors/health" \
      -H 'Content-Type: application/json' \
      --data-binary "{\"timeType\":\"last_3h\",\"collectorId\":\"$collector_id\",\"limit\":5}" \
      >"$INSTALL_LOG_ROOT/health-collector-$phase.json" 2>&1 || true
  fi
  if [[ $phase == failure || $phase == success || $phase == activation ]]; then
    [[ ! -f $INSTALL_LOG_ROOT/health-api-$phase.json ]] ||
      cp "$INSTALL_LOG_ROOT/health-api-$phase.json" "$INSTALL_LOG_ROOT/health-api.json"
    [[ ! -f $INSTALL_LOG_ROOT/health-source-$phase.json ]] ||
      cp "$INSTALL_LOG_ROOT/health-source-$phase.json" "$INSTALL_LOG_ROOT/health-source.json"
    [[ ! -f $INSTALL_LOG_ROOT/health-collector-$phase.json ]] ||
      cp "$INSTALL_LOG_ROOT/health-collector-$phase.json" "$INSTALL_LOG_ROOT/health-collector.json"
  fi
}

write_install_summary() {
  local rc=$1 result=success
  [[ $rc -eq 0 ]] || result=failed
  {
    printf 'release=%s\n' "$COMPAT_RELEASE_ID"
    printf 'result=%s\n' "$result"
    printf 'exit_code=%s\n' "$rc"
    printf 'failure_stage=%s\n' "$CURRENT_STAGE"
    printf 'rollback=%s\n' "$ROLLBACK_RESULT"
    printf 'started_at=%s\n' "$INSTALL_START_TIME"
    printf 'finished_at=%s\n' "$(date '+%Y-%m-%d %H:%M:%S')"
    printf 'install_log=%s\n' "$INSTALL_LOG_ROOT/install.log"
    printf 'diagnostic_directory=%s\n' "$INSTALL_LOG_ROOT"
  } >"$INSTALL_LOG_ROOT/summary.txt"
  echo "Installation summary: $INSTALL_LOG_ROOT/summary.txt"
}

version_at_least() {
  local actual=$1 minimum=$2
  [[ $(printf '%s\n%s\n' "$minimum" "$actual" | sort -V | head -n1) == "$minimum" ]]
}

env_value() {
  local key=$1 file=$2
  [[ -f $file ]] || return 0
  awk -v key="$key" '
    index($0, key "=") == 1 {
      sub(/^[^=]*=/, "")
      value=$0
    }
    END {
      if (value != "") print value
    }
  ' "$file"
}

normalize_environment() {
  local file=${1:-$ENV_FILE} tmp
  [[ -f $file ]] || return 0
  tmp=$(mktemp "${file}.normalize.XXXXXX")
  awk '
    NR == FNR {
      line=$0
      sub(/\r$/, "", line)
      if (line ~ /^[A-Za-z_][A-Za-z0-9_]*=/) {
        key=line
        sub(/=.*/, "", key)
        last[key]=FNR
      }
      next
    }
    {
      line=$0
      sub(/\r$/, "", line)
      if (line !~ /^[A-Za-z_][A-Za-z0-9_]*=/) {
        print line
        next
      }
      key=line
      sub(/=.*/, "", key)
      if (FNR != last[key]) next
      value=line
      sub(/^[^=]*=/, "", value)
      while (index(value, key "=") == 1) {
        sub(/^[^=]*=/, "", value)
      }
      print key "=" value
    }
  ' "$file" "$file" >"$tmp"
  chmod --reference="$file" "$tmp" 2>/dev/null || chmod 0600 "$tmp"
  chown --reference="$file" "$tmp" 2>/dev/null || true
  mv "$tmp" "$file"
}

validate_collector_id() {
  local file=${1:-$ENV_FILE} collector_id
  collector_id=$(env_value A3S_OBSERVER_COLLECTOR_ID "$file")
  [[ -z $collector_id || $collector_id =~ ^[A-Za-z0-9._:-]+$ ]] ||
    fail "A3S_OBSERVER_COLLECTOR_ID is invalid in $file: $collector_id"
}

random_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
  fi
}

materialize_template_line() {
  local line=$1 key=${1%%=*}
  case "$line" in
    CLICKHOUSE_PASSWORD=__GENERATED__|ANYSENTRY_ADMIN_TOKEN=__GENERATED__)
      printf '%s=%s\n' "$key" "$(random_secret)" ;;
    ANYSENTRY_SOURCE_ID=__GENERATED__|ANYSENTRY_INGEST_TOKEN=__GENERATED__)
      printf '%s=\n' "$key" ;;
    *) printf '%s\n' "$line" ;;
  esac
}

merge_environment() {
  local template=$1 line key
  [[ -f $ENV_FILE ]] || fail "configuration file is missing: $ENV_FILE"
  while IFS= read -r line || [[ -n $line ]]; do
    [[ $line == *=* && $line != \#* ]] || continue
    key=${line%%=*}
    if ! grep -qE "^${key}=" "$ENV_FILE"; then
      materialize_template_line "$line" >>"$ENV_FILE"
      echo "Added configuration key: $key"
    fi
  done <"$template"
}

install_environment() {
  local template=$PACKAGE_ROOT/config/anysentry.env.example line
  [[ -f $template ]] || fail "configuration template is missing: $template"
  install -d -m 0750 "$CONFIG_DIR"
  if [[ ! -f $ENV_FILE ]]; then
    umask 077
    : >"$ENV_FILE"
    while IFS= read -r line || [[ -n $line ]]; do
      materialize_template_line "$line" >>"$ENV_FILE"
    done <"$template"
    echo "Created protected configuration: $ENV_FILE"
  else
    echo "Preserving existing configuration: $ENV_FILE"
    normalize_environment "$ENV_FILE"
    merge_environment "$template"
  fi
  normalize_environment "$ENV_FILE"
  validate_collector_id "$ENV_FILE"
  [[ -n $(env_value CLICKHOUSE_PASSWORD "$ENV_FILE") ]] || fail "CLICKHOUSE_PASSWORD is empty in $ENV_FILE"
  [[ -n $(env_value ANYSENTRY_ADMIN_TOKEN "$ENV_FILE") ]] || fail "ANYSENTRY_ADMIN_TOKEN is empty in $ENV_FILE"
  ! grep -q '__GENERATED__' "$ENV_FILE" || fail "generated-secret placeholders remain in $ENV_FILE"
  chown root:root "$ENV_FILE"
  chmod 0600 "$ENV_FILE"
}

persist_resource_configuration() {
  local sysctl_file=$SYSCTL_DIR/90-anysentry.conf
  install -d -m 0755 "$SYSCTL_DIR"
  printf '%s\n' \
    '# AnySentry UOS runtime requirements. Managed by install.sh.' \
    'vm.overcommit_memory=1' \
    >"$sysctl_file"
  chown root:root "$sysctl_file"
  chmod 0644 "$sysctl_file"
  sysctl -w vm.overcommit_memory=1 >/dev/null
  echo "Persisted runtime memory configuration: $sysctl_file"
}

verify_package() {
  local file required=(
    app/dist/main.js app/web/index.html runtime/node/bin/node
    native/a3s-sentry.linux-arm64-gnu.node clickhouse/bin/clickhouse
    redis/bin/redis-server redis/bin/redis-cli redis/etc/redis.conf
    observer/bin/a3s-observer-collector observer/observer-forward.js
    observer/observer-agent-attribution.js observer/observer-event-dedup.js
    observer/KERNEL_VERSION_CODE l3/l3-agent.mjs
    app/dist/security-monitoring/worker-main.js run-l3-worker.sh
    diagnostics/a3s-bpf-syscall-probe diagnostics/RUN_DIAGNOSTICS.sh
    config/anysentry.env.example systemd/anysentry.service
    systemd/anysentry-clickhouse.service systemd/anysentry-redis.service
    systemd/anysentry-fast-judge.service systemd/anysentry-l3-worker.service
    systemd/anysentry-observer.service
    provision-observer.mjs wait-clickhouse.sh verify.sh inspect-host.sh
    AnySentry部署手册.md AnySentry使用手册.md AnySentry脚本说明.md
    VERSION PROVENANCE manifest.sha256
  )
  for file in "${required[@]}"; do
    [[ -f $PACKAGE_ROOT/$file ]] || fail "package file missing: $file"
  done
  [[ $(<"$PACKAGE_ROOT/observer/KERNEL_VERSION_CODE") == "$EXPECTED_BPF_CODE" ]] ||
    fail "Observer BPF code is not $EXPECTED_BPF_CODE"
  (cd "$PACKAGE_ROOT" && sha256sum --check --quiet manifest.sha256) ||
    fail "package checksum validation failed"
}

kernel_config_source() {
  if [[ -r /boot/config-$(uname -r) ]]; then
    printf '%s\n' "/boot/config-$(uname -r)"
  elif [[ -r /proc/config.gz ]]; then
    printf '%s\n' /proc/config.gz
  fi
}

validate_kernel_features() {
  local source reader flag
  source=$(kernel_config_source)
  if [[ -z $source ]]; then
    warn "kernel configuration is not readable; raw BPF capability probe remains authoritative"
    return 0
  fi
  reader=grep
  [[ $source != /proc/config.gz ]] || reader=zgrep
  for flag in CONFIG_BPF CONFIG_BPF_SYSCALL CONFIG_BPF_EVENTS CONFIG_KPROBES CONFIG_KPROBE_EVENTS CONFIG_PERF_EVENTS; do
    "$reader" -qx "$flag=y" "$source" || fail "required kernel option is disabled: $flag"
  done
}

validate_bpf_abi() {
  local output rc=0
  output=$(timeout --signal=TERM 45 "$PACKAGE_ROOT/diagnostics/a3s-bpf-syscall-probe" 2>&1) || rc=$?
  printf '%s\n' "$output"
  [[ $rc -eq 0 ]] || fail "raw BPF syscall probe failed with exit code $rc"
  grep -Fq "scan.kprobe_candidate.version=$EXPECTED_BPF_VERSION" <<<"$output" ||
    fail "kernel did not accept expected BPF version $EXPECTED_BPF_VERSION"
  grep -Fq "scan.kprobe_candidate.version_code=$EXPECTED_BPF_CODE" <<<"$output" ||
    fail "kernel did not accept expected BPF code $EXPECTED_BPF_CODE"
}

validate_redis_runtime() {
  local output rc=0
  output=$("$PACKAGE_ROOT/redis/bin/redis-server" \
    "$PACKAGE_ROOT/redis/etc/redis.conf" \
    --port 0 --save "" --appendonly no --dir /tmp 2>&1) || rc=$?
  printf '%s\n' "$output"
  if grep -Fq 'Redis will now exit to prevent data corruption' <<<"$output"; then
    fail "bundled Redis configuration did not safely acknowledge the ARM64 kernel COW check"
  fi
  [[ $rc -eq 1 ]] || fail "bundled Redis startup check returned unexpected exit code $rc"
  grep -Fq 'Configured to not listen anywhere, exiting.' <<<"$output" ||
    fail "bundled Redis did not complete its startup checks"
}

preflight() {
  local command_name arch glibc_line glibc_version page_size free_kb node_version clickhouse_version redis_version collector_version
  for command_name in uname getconf sort df sha256sum systemctl curl awk sed grep install cp mv chmod chown id getent groupadd useradd od tr bash timeout tee journalctl ln sysctl; do
    command -v "$command_name" >/dev/null 2>&1 || fail "required command not found: $command_name"
  done
  arch=$(uname -m)
  [[ $arch == aarch64 ]] || fail "unsupported architecture: $arch (required: aarch64)"
  glibc_line=$(getconf GNU_LIBC_VERSION 2>/dev/null) || fail "unable to detect glibc"
  glibc_version=${glibc_line##* }
  version_at_least "$glibc_version" 2.28 || fail "glibc $glibc_version is older than 2.28"
  page_size=$(getconf PAGESIZE)
  [[ $page_size == 65536 ]] || fail "unsupported page size: $page_size (this UOS release requires 65536)"
  [[ -e /sys/kernel/debug/tracing/kprobe_events || -e /sys/kernel/tracing/kprobe_events ]] ||
    fail "kprobe_events is unavailable; debugfs or tracefs is required"
  grep -qE '[[:space:]]__arm64_sys_execve$' /proc/kallsyms 2>/dev/null ||
    fail "ARM64 execve kprobe symbol is unavailable"
  verify_package
  validate_kernel_features
  node_version=$("$PACKAGE_ROOT/runtime/node/bin/node" --version 2>&1) ||
    fail "bundled Node runtime cannot execute: $node_version"
  clickhouse_version=$("$PACKAGE_ROOT/clickhouse/bin/clickhouse" --version 2>&1) ||
    fail "bundled ClickHouse cannot execute on this CPU: $clickhouse_version"
  redis_version=$("$PACKAGE_ROOT/redis/bin/redis-server" --version 2>&1) ||
    fail "bundled Redis cannot execute on this CPU: $redis_version"
  validate_redis_runtime
  collector_version=$("$PACKAGE_ROOT/observer/bin/a3s-observer-collector" --version 2>&1) ||
    fail "bundled Observer cannot execute: $collector_version"
  validate_bpf_abi
  free_kb=$(df -Pk "${INSTALL_PARENT:-/}" 2>/dev/null | awk 'NR == 2 {print $4}')
  [[ -n $free_kb ]] || free_kb=$(df -Pk / | awk 'NR == 2 {print $4}')
  [[ $free_kb -ge $MIN_FREE_KB ]] || fail "at least 5 GiB free disk space is required"
  echo "Preflight passed: architecture=$arch glibc=$glibc_version kernel=$(uname -r) page_size=$page_size free=$((free_kb / 1024))MiB node=$node_version clickhouse=$clickhouse_version redis=$redis_version observer=$collector_version bpf=$EXPECTED_BPF_CODE"
}

stop_services() {
  local unit
  for unit in "${STOP_SERVICES[@]}"; do
    systemctl stop "$unit" 2>/dev/null || true
  done
}

start_available_services() {
  local unit
  for unit in "${START_SERVICES[@]}"; do
    [[ -f $SYSTEMD_DIR/$unit ]] || continue
    systemctl enable --now "$unit"
  done
}

stage_release() {
  STAGING=$INSTALL_PARENT/.anysentry.install.$$
  install -d -m 0755 "$STAGING"
  cp -a "$PACKAGE_ROOT/." "$STAGING/"
  chown -R root:root "$STAGING"
}

backup_current() {
  local stamp
  stamp=$(date +%Y%m%d%H%M%S)-$$
  ROLLBACK_ROOT=$INSTALL_PARENT/.anysentry.rollback.$stamp
  ROLLBACK_UNITS=$INSTALL_PARENT/.anysentry.units.$stamp
  ROLLBACK_ENV=$INSTALL_PARENT/.anysentry.env.$stamp
  install -d -m 0700 "$ROLLBACK_UNITS"
  # Every operation after this point is covered by the EXIT rollback trap.
  ACTIVATED=1
  if [[ -e $INSTALL_ROOT ]]; then
    HAD_PREVIOUS=1
    mv "$INSTALL_ROOT" "$ROLLBACK_ROOT"
  fi
  local unit
  for unit in "${SERVICES[@]}"; do
    [[ -f $SYSTEMD_DIR/$unit ]] && cp -a "$SYSTEMD_DIR/$unit" "$ROLLBACK_UNITS/$unit"
  done
  [[ -f $ENV_FILE ]] && cp -a "$ENV_FILE" "$ROLLBACK_ENV"
}

restore_previous() {
  local unit
  [[ $ACTIVATED -eq 1 ]] || return 0
  ROLLBACK_RESULT=started
  echo "Activation failed; starting automatic rollback." >&2
  stop_services
  [[ ! -e $INSTALL_ROOT ]] || mv "$INSTALL_ROOT" "$INSTALL_ROOT.failed.$(date +%Y%m%d%H%M%S)"
  if [[ $HAD_PREVIOUS -eq 1 && -e $ROLLBACK_ROOT ]]; then
    mv "$ROLLBACK_ROOT" "$INSTALL_ROOT"
  fi
  for unit in "${SERVICES[@]}"; do
    if [[ -f $ROLLBACK_UNITS/$unit ]]; then
      cp -a "$ROLLBACK_UNITS/$unit" "$SYSTEMD_DIR/$unit"
    else
      rm -f "$SYSTEMD_DIR/$unit"
    fi
  done
  [[ ! -f $ROLLBACK_ENV ]] || cp -a "$ROLLBACK_ENV" "$ENV_FILE"
  systemctl daemon-reload
  if [[ $HAD_PREVIOUS -eq 1 ]]; then
    start_available_services
  fi
  ROLLBACK_RESULT=completed
  echo "Automatic rollback completed." >&2
}

cleanup() {
  local rc=$?
  set +e
  if [[ $rc -ne 0 ]]; then
    capture_diagnostics failure
    if ! restore_previous > >(tee -a "$INSTALL_LOG_ROOT/rollback.log") 2>&1; then
      ROLLBACK_RESULT=failed
    fi
    capture_diagnostics after-rollback
  else
    capture_diagnostics success
  fi
  [[ -z $STAGING || ! -e $STAGING ]] || rm -rf "$STAGING"
  write_install_summary "$rc"
  return "$rc"
}

wait_for_url() {
  local url=$1 i
  for i in $(seq 1 60); do
    curl --connect-timeout 2 --max-time 5 -fsS "$url" >/dev/null 2>/dev/null && return 0
    sleep 2
  done
  return 1
}

wait_for_redis() {
  local i
  for i in $(seq 1 60); do
    "$INSTALL_ROOT/redis/bin/redis-cli" -h 127.0.0.1 -p 6379 ping 2>/dev/null |
      grep -qx PONG && return 0
    sleep 1
  done
  return 1
}

provision_observer() {
  local port
  port=$(env_value PORT "$ENV_FILE")
  [[ -n $port ]] || port=29653
  wait_for_url "http://127.0.0.1:$port/security-center/healthz" || fail "AnySentry API readiness timeout"
  "$INSTALL_ROOT/runtime/node/bin/node" "$INSTALL_ROOT/provision-observer.mjs" \
    "$ENV_FILE" "http://127.0.0.1:$port/security-center"
  normalize_environment "$ENV_FILE"
  validate_collector_id "$ENV_FILE"
  [[ -n $(env_value ANYSENTRY_SOURCE_ID "$ENV_FILE") ]] || fail "Observer Source ID was not provisioned"
  [[ -n $(env_value ANYSENTRY_INGEST_TOKEN "$ENV_FILE") ]] || fail "Observer ingest token was not provisioned"
  chown root:root "$ENV_FILE"
  chmod 0600 "$ENV_FILE"
}

activate_release() {
  local unit
  set_stage stop-existing-services
  stop_services
  set_stage backup-current-release
  backup_current
  set_stage activate-program-files
  mv "$STAGING" "$INSTALL_ROOT"
  STAGING=
  for unit in "${SERVICES[@]}"; do
    install -m 0644 "$INSTALL_ROOT/systemd/$unit" "$SYSTEMD_DIR/$unit"
  done
  systemctl daemon-reload
  set_stage start-clickhouse
  systemctl enable --now anysentry-clickhouse.service
  set_stage start-redis
  systemctl enable --now anysentry-redis.service
  wait_for_redis || fail "AnySentry Redis readiness timeout"
  set_stage start-api
  systemctl enable --now anysentry.service
  set_stage provision-observer-source
  provision_observer
  set_stage start-judgment-workers
  systemctl enable --now anysentry-fast-judge.service
  systemctl enable --now anysentry-l3-worker.service
  set_stage start-observer
  systemctl enable --now anysentry-observer.service
  capture_diagnostics activation
  set_stage verify-activation
  "$INSTALL_ROOT/verify.sh" 2>&1 | tee "$INSTALL_LOG_ROOT/verify.log"
  ACTIVATED=0
}

main() {
  while (($#)); do
    case "$1" in
      --check) CHECK_ONLY=1 ;;
      -h|--help) usage; return 0 ;;
      *) usage >&2; fail "unknown argument: $1" ;;
    esac
    shift
  done
  initialize_install_logging
  trap cleanup EXIT
  set_stage preflight
  preflight 2>&1 | tee "$INSTALL_LOG_ROOT/preflight.log"
  if [[ $CHECK_ONLY -eq 1 ]]; then
    set_stage check-completed
    echo "No service, application, data, or sysctl changes were made."
    echo "Diagnostic log was written to $INSTALL_LOG_ROOT."
    return 0
  fi
  [[ $(id -u) -eq 0 ]] || fail "installer must run as root"
  set_stage prepare-service-account
  if ! getent group anysentry >/dev/null 2>&1; then groupadd --system anysentry; fi
  if ! id anysentry >/dev/null 2>&1; then
    useradd --system --gid anysentry --home-dir "$STATE_DIR" --shell "$(command -v nologin)" anysentry
  fi
  install -d -o anysentry -g anysentry -m 0750 \
    "$STATE_DIR" "$STATE_DIR/clickhouse" "$STATE_DIR/redis" "$STATE_DIR/l3" "$LOG_DIR"
  set_stage normalize-configuration
  install_environment 2>&1 | tee "$INSTALL_LOG_ROOT/config-validation.txt"
  set_stage persist-resource-configuration
  persist_resource_configuration
  set_stage stage-release
  stage_release
  activate_release
  [[ ! -d $ROLLBACK_UNITS ]] || rm -rf "$ROLLBACK_UNITS"
  [[ ! -f $ROLLBACK_ENV ]] || rm -f "$ROLLBACK_ENV"
  set_stage completed
  echo "AnySentry installation or upgrade completed. Dashboard: http://<host>:$(env_value PORT "$ENV_FILE")/"
  [[ $HAD_PREVIOUS -eq 0 ]] || echo "Previous program retained for rollback: $ROLLBACK_ROOT"
}

if [[ ${ANYSENTRY_INSTALLER_LIB:-0} == 1 ]]; then
  return 0 2>/dev/null || exit 0
fi
main "$@"
