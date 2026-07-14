#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PACKAGE_ROOT=$SCRIPT_DIR
INSTALL_ROOT=/opt/anysentry
INSTALL_PARENT=$(dirname "$INSTALL_ROOT")
CONFIG_DIR=/etc/anysentry
ENV_FILE=$CONFIG_DIR/anysentry.env
STATE_DIR=/var/lib/anysentry
LOG_DIR=/var/log/anysentry
SYSTEMD_DIR=/etc/systemd/system
MIN_FREE_KB=$((5 * 1024 * 1024))
CHECK_ONLY=0
INSTALL_STAGING=
INSTALL_SERVICES_STARTED=0

usage() {
  cat <<'EOF'
Usage: ./install.sh [--check]

  --check  Validate the package and target host without changing the system.
EOF
}

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

version_at_least() {
  local actual=$1 minimum=$2
  [ "$(printf '%s\n%s\n' "$minimum" "$actual" | sort -V | head -n 1)" = "$minimum" ]
}

service_owns_port() {
  local service=$1
  systemctl is-active --quiet "$service" 2>/dev/null
}

port_is_listening() {
  local port=$1
  ss -lnt | awk -v suffix=":$port" 'NR > 1 && substr($4, length($4) - length(suffix) + 1) == suffix { found=1 } END { exit !found }'
}

verify_package_files() {
  local required
  for required in \
    app/dist/main.js \
    app/web/index.html \
    runtime/node/bin/node \
    native/a3s-sentry.linux-arm64-gnu.node \
    clickhouse/bin/clickhouse \
    observer/bin/a3s-observer-collector \
    observer/observer-forward.js \
    l3/l3-agent.mjs \
    l3/node_modules/@a3s-lab/code/index.linux-arm64-gnu.node \
    clickhouse/etc/config.xml \
    config/anysentry.env.example \
    systemd/anysentry.service \
    systemd/anysentry-clickhouse.service \
    systemd/anysentry-observer.service \
    provision-observer.mjs \
    wait-clickhouse.sh \
    verify.sh \
    uninstall.sh \
    VERSION \
    manifest.sha256; do
    [ -f "$PACKAGE_ROOT/$required" ] || fail "package file missing: $required"
  done

  (
    cd "$PACKAGE_ROOT"
    sha256sum --check --quiet manifest.sha256
  ) || fail "package checksum validation failed"
}

preflight() {
  local arch glibc_line glibc_version kernel_version page_size disk_path free_kb command_name config_source api_port kernel_config kernel_config_reader flag node_version clickhouse_version

  for command_name in uname getconf sort df du sha256sum ss systemctl curl awk sed grep install cp mv chmod chown id getent groupadd useradd nologin od tr bash; do
    command -v "$command_name" >/dev/null 2>&1 || fail "required command not found: $command_name"
  done

  arch=$(uname -m)
  [ "$arch" = aarch64 ] || fail "unsupported architecture: $arch (required: aarch64)"

  glibc_line=$(getconf GNU_LIBC_VERSION 2>/dev/null) || fail "unable to detect glibc"
  glibc_version=${glibc_line##* }
  version_at_least "$glibc_version" 2.28 || fail "glibc $glibc_version is too old (required: >= 2.28)"

  kernel_version=$(uname -r | sed 's/-.*//')
  version_at_least "$kernel_version" 4.19 || fail "kernel $kernel_version is too old (required: >= 4.19)"
  page_size=$(getconf PAGESIZE) || fail "unable to detect kernel page size"
  case "$page_size" in
    4096|65536) ;;
    *) fail "unsupported kernel page size: $page_size (supported: 4096 or 65536)" ;;
  esac

  [ -d /sys/fs/bpf ] || fail "/sys/fs/bpf is missing; BPF filesystem is required"
  if [ ! -e /sys/kernel/debug/tracing/kprobe_events ] && [ ! -e /sys/kernel/tracing/kprobe_events ]; then
    fail "kprobe_events is unavailable; mount debugfs/tracefs before installation"
  fi
  grep -qE '[[:space:]]__arm64_sys_execve$' /proc/kallsyms 2>/dev/null || fail "ARM64 execve kprobe symbol is unavailable"
  kernel_config=/boot/config-$(uname -r)
  kernel_config_reader=grep
  if [ -r "$kernel_config" ]; then
    :
  elif [ -r /proc/config.gz ]; then
    command -v zgrep >/dev/null 2>&1 || fail "zgrep is required to read /proc/config.gz"
    kernel_config=/proc/config.gz
    kernel_config_reader=zgrep
  else
    fail "kernel configuration is not readable from /boot/config-$(uname -r) or /proc/config.gz"
  fi
  for flag in CONFIG_BPF CONFIG_BPF_SYSCALL CONFIG_BPF_EVENTS CONFIG_KPROBES CONFIG_KPROBE_EVENTS CONFIG_PERF_EVENTS; do
    "$kernel_config_reader" -qx "$flag=y" "$kernel_config" || fail "required kernel option is disabled: $flag"
  done

  verify_package_files
  node_version=$("$PACKAGE_ROOT/runtime/node/bin/node" --version 2>&1) \
    || fail "bundled Node runtime cannot execute on this host: $node_version"
  clickhouse_version=$("$PACKAGE_ROOT/clickhouse/bin/clickhouse" --version 2>&1) \
    || fail "bundled ClickHouse cannot execute on this CPU: $clickhouse_version"

  config_source=$PACKAGE_ROOT/config/anysentry.env.example
  [ -f "$PACKAGE_ROOT/config/anysentry.env" ] && config_source=$PACKAGE_ROOT/config/anysentry.env
  [ -f "$ENV_FILE" ] && config_source=$ENV_FILE
  api_port=$(env_value PORT "$config_source")
  [ -n "$api_port" ] || api_port=29653
  case "$api_port" in
    *[!0-9]*) fail "PORT must be an integer: $api_port" ;;
  esac
  [ "$api_port" -ge 1 ] && [ "$api_port" -le 65535 ] || fail "PORT is outside 1-65535: $api_port"
  [ "$api_port" -ne 8123 ] || fail "PORT 8123 is reserved for ClickHouse"

  disk_path=$INSTALL_PARENT
  [ -d "$disk_path" ] || disk_path=/
  free_kb=$(df -Pk "$disk_path" | awk 'NR == 2 { print $4 }')
  [ -n "$free_kb" ] && [ "$free_kb" -ge "$MIN_FREE_KB" ] || fail "at least 5 GiB free space is required on $disk_path"

  if port_is_listening "$api_port" && ! service_owns_port anysentry.service; then
    fail "TCP port $api_port is already in use by another process"
  fi
  if port_is_listening 8123 && ! service_owns_port anysentry-clickhouse.service; then
    fail "TCP port 8123 is already in use by another process"
  fi

  echo "Preflight passed: architecture=$arch glibc=$glibc_version kernel=$kernel_version page_size=$page_size free=$((free_kb / 1024))MiB node=$node_version clickhouse=$clickhouse_version config=$kernel_config"
}

random_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
  fi
}

env_value() {
  local key=$1 file=$2
  awk -v key="$key" 'index($0, key "=") == 1 { sub(/^[^=]*=/, ""); print; exit }' "$file"
}

install_environment() {
  local template clickhouse_password admin_token line

  install -d -m 0750 "$CONFIG_DIR"
  if [ ! -f "$ENV_FILE" ]; then
    template=$PACKAGE_ROOT/config/anysentry.env.example
    [ -f "$PACKAGE_ROOT/config/anysentry.env" ] && template=$PACKAGE_ROOT/config/anysentry.env
    clickhouse_password=$(random_secret)
    admin_token=$(random_secret)
    umask 077
    : > "$ENV_FILE"
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in
        CLICKHOUSE_PASSWORD=__GENERATED__) printf 'CLICKHOUSE_PASSWORD=%s\n' "$clickhouse_password" >> "$ENV_FILE" ;;
        ANYSENTRY_ADMIN_TOKEN=__GENERATED__) printf 'ANYSENTRY_ADMIN_TOKEN=%s\n' "$admin_token" >> "$ENV_FILE" ;;
        ANYSENTRY_SOURCE_ID=__GENERATED__) printf 'ANYSENTRY_SOURCE_ID=\n' >> "$ENV_FILE" ;;
        ANYSENTRY_INGEST_TOKEN=__GENERATED__) printf 'ANYSENTRY_INGEST_TOKEN=\n' >> "$ENV_FILE" ;;
        *) printf '%s\n' "$line" >> "$ENV_FILE" ;;
      esac
    done < "$template"
    echo "Created protected configuration: $ENV_FILE"
  else
    echo "Preserving existing configuration: $ENV_FILE"
  fi

  [ -n "$(env_value CLICKHOUSE_PASSWORD "$ENV_FILE")" ] || fail "CLICKHOUSE_PASSWORD is missing from $ENV_FILE"
  [ -n "$(env_value ANYSENTRY_ADMIN_TOKEN "$ENV_FILE")" ] || fail "ANYSENTRY_ADMIN_TOKEN is missing from $ENV_FILE"
  ! grep -q '__GENERATED__' "$ENV_FILE" || fail "generated-secret placeholders remain in $ENV_FILE"
  chown root:root "$ENV_FILE"
  chmod 0600 "$ENV_FILE"
}

stage_program_files() {
  INSTALL_STAGING=$INSTALL_PARENT/.anysentry.install.$$
  rm -rf "$INSTALL_STAGING"
  install -d -m 0755 "$INSTALL_STAGING"
  cp -a "$PACKAGE_ROOT/app" "$PACKAGE_ROOT/runtime" "$PACKAGE_ROOT/native" "$PACKAGE_ROOT/clickhouse" "$PACKAGE_ROOT/observer" "$PACKAGE_ROOT/l3" "$INSTALL_STAGING/"
  install -m 0755 "$PACKAGE_ROOT/verify.sh" "$INSTALL_STAGING/verify.sh"
  install -m 0755 "$PACKAGE_ROOT/uninstall.sh" "$INSTALL_STAGING/uninstall.sh"
  install -m 0755 "$PACKAGE_ROOT/wait-clickhouse.sh" "$INSTALL_STAGING/wait-clickhouse.sh"
  install -m 0755 "$PACKAGE_ROOT/provision-observer.mjs" "$INSTALL_STAGING/provision-observer.mjs"
  install -m 0644 "$PACKAGE_ROOT/VERSION" "$INSTALL_STAGING/VERSION"
  chown -R root:root "$INSTALL_STAGING"
}

activate_program_files() {
  local backup=
  systemctl stop anysentry-observer.service anysentry.service anysentry-clickhouse.service 2>/dev/null || true
  if [ -e "$INSTALL_ROOT" ]; then
    backup=$INSTALL_PARENT/.anysentry.previous.$$
    mv "$INSTALL_ROOT" "$backup"
  fi
  mv "$INSTALL_STAGING" "$INSTALL_ROOT"
  INSTALL_STAGING=
  [ -z "$backup" ] || rm -rf "$backup"
}

cleanup() {
  [ -z "$INSTALL_STAGING" ] || rm -rf "$INSTALL_STAGING"
  if [ "$INSTALL_SERVICES_STARTED" -eq 1 ]; then
    systemctl disable --now anysentry-observer.service anysentry.service anysentry-clickhouse.service 2>/dev/null || true
  fi
}
trap cleanup EXIT

wait_for_api() {
  local api_port=$1 i
  for i in $(seq 1 60); do
    curl --connect-timeout 2 --max-time 5 -fsS "http://127.0.0.1:$api_port/security-center/healthz" >/dev/null && return 0
    sleep 2
  done
  return 1
}

provision_observer_source() {
  local api_port
  api_port=$(env_value PORT "$ENV_FILE")
  [ -n "$api_port" ] || api_port=29653
  wait_for_api "$api_port" || fail "AnySentry API did not become ready for Observer Source provisioning"
  "$INSTALL_ROOT/runtime/node/bin/node" "$INSTALL_ROOT/provision-observer.mjs" \
    "$ENV_FILE" "http://127.0.0.1:$api_port/security-center"
  chown root:root "$ENV_FILE"
  chmod 0600 "$ENV_FILE"
  [ -n "$(env_value ANYSENTRY_SOURCE_ID "$ENV_FILE")" ] || fail "ANYSENTRY_SOURCE_ID was not provisioned"
  [ -n "$(env_value ANYSENTRY_INGEST_TOKEN "$ENV_FILE")" ] || fail "ANYSENTRY_INGEST_TOKEN was not provisioned"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --check) CHECK_ONLY=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; fail "unknown argument: $1" ;;
  esac
  shift
done

preflight
if [ "$CHECK_ONLY" -eq 1 ]; then
  echo "No system changes were made."
  exit 0
fi

[ "$(id -u)" -eq 0 ] || fail "installer must run as root"

if ! getent group anysentry >/dev/null 2>&1; then
  groupadd --system anysentry
fi
if ! id anysentry >/dev/null 2>&1; then
  useradd --system --gid anysentry --home-dir "$STATE_DIR" --shell "$(command -v nologin)" anysentry
fi

install -d -o anysentry -g anysentry -m 0750 "$STATE_DIR" "$STATE_DIR/clickhouse" "$STATE_DIR/l3" "$LOG_DIR"
install_environment
stage_program_files
activate_program_files

install -m 0644 "$PACKAGE_ROOT/systemd/anysentry-clickhouse.service" "$SYSTEMD_DIR/anysentry-clickhouse.service"
install -m 0644 "$PACKAGE_ROOT/systemd/anysentry.service" "$SYSTEMD_DIR/anysentry.service"
install -m 0644 "$PACKAGE_ROOT/systemd/anysentry-observer.service" "$SYSTEMD_DIR/anysentry-observer.service"
systemctl daemon-reload
INSTALL_SERVICES_STARTED=1
systemctl enable --now anysentry-clickhouse.service
systemctl enable --now anysentry.service
provision_observer_source
systemctl enable --now anysentry-observer.service

"$INSTALL_ROOT/verify.sh"
INSTALL_SERVICES_STARTED=0
echo "AnySentry installation completed. Dashboard: http://<host>:29653/"
