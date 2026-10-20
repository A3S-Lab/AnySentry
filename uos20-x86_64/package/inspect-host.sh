#!/usr/bin/env bash
set -u
set -o pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
timestamp=$(date +%Y%m%d-%H%M%S)
report=${1:-$PWD/anysentry-host-inspection-$timestamp.txt}
collector=${ANYSENTRY_COLLECTOR_PATH:-/opt/anysentry/observer/bin/a3s-observer-collector}
diagnostic_report=${report%.txt}.bpf.txt

{
  echo '===== AnySentry UOS 20 ARM64 host inspection ====='
  printf 'collected_at=%s\n' "$(date --iso-8601=seconds 2>/dev/null || date)"
  printf 'report=%s\n' "$report"
  printf 'collector=%s\n' "$collector"
  echo
  echo '===== OS AND ABI ====='
  sed -n '1,80p' /etc/os-release 2>/dev/null || true
  uname -srvmo 2>/dev/null || true
  getconf GNU_LIBC_VERSION 2>/dev/null || true
  printf 'page_size='; getconf PAGESIZE 2>/dev/null || true
  printf 'cpu_count='; getconf _NPROCESSORS_ONLN 2>/dev/null || true
  grep -m1 -E 'model name|CPU part|Hardware' /proc/cpuinfo 2>/dev/null || true
  echo
  echo '===== STORAGE AND MEMORY ====='
  df -h / /opt /var 2>/dev/null || df -h / 2>/dev/null || true
  grep -E 'MemTotal|MemAvailable|SwapTotal|SwapFree' /proc/meminfo 2>/dev/null || true
  echo
  echo '===== INSTALLED RELEASE ====='
  sed -n '1,120p' /opt/anysentry/VERSION 2>/dev/null || echo 'installed_release=not_found'
  echo
  echo '===== SERVICE STATE ====='
  for service in anysentry-clickhouse.service anysentry.service anysentry-observer.service; do
    printf '%s=' "$service"
    systemctl is-active "$service" 2>/dev/null || true
  done
  echo
  echo '===== LISTENING PORTS ====='
  ss -lntp 2>/dev/null | grep -E ':(8123|29653)\b' || true
  echo
  echo '===== RECENT OBSERVER LOG ====='
  journalctl -b -u anysentry-observer.service -n 120 --no-pager -o cat 2>/dev/null || true
} >"$report"

if [[ -x $SCRIPT_DIR/diagnostics/RUN_DIAGNOSTICS.sh ]]; then
  A3S_DIAG_OUTPUT="$diagnostic_report" \
    "$SCRIPT_DIR/diagnostics/RUN_DIAGNOSTICS.sh" "$collector" >/dev/null 2>&1
  diagnostic_rc=$?
  {
    echo
    echo '===== BPF CAPABILITY REPORT ====='
    cat "$diagnostic_report" 2>/dev/null || true
    printf '\nbpf_diagnostics_exit_code=%s\n' "$diagnostic_rc"
  } >>"$report"
else
  echo 'bpf_diagnostics=not_available' >>"$report"
  diagnostic_rc=127
fi

echo "Inspection report: $report"
exit "$diagnostic_rc"
