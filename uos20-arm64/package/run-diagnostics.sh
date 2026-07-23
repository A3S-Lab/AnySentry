#!/usr/bin/env bash
set -u
set -o pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
collector=${1:-/opt/anysentry/observer/bin/a3s-observer-collector}
timestamp=$(date +%Y%m%d-%H%M%S 2>/dev/null || echo unknown-time)
report=${A3S_DIAG_OUTPUT:-$PWD/a3s-container-bpf-diagnostics-$timestamp.txt}

if [ -f "$SCRIPT_DIR/SHA256SUMS" ]; then
  (cd "$SCRIPT_DIR" && sha256sum --check SHA256SUMS) || exit 2
fi

echo "Running passive container and collector capability checks..."
A3S_DIAG_OUTPUT="$report" "$SCRIPT_DIR/RUN_PASSIVE_CHECK.sh" "$collector"
passive_rc=$?

{
  printf '\n===== RAW BPF SYSCALL PROBE =====\n'
  printf 'probe_binary=%s\n' "$SCRIPT_DIR/a3s-bpf-syscall-probe"
} | tee -a "$report"

if [ ! -x "$SCRIPT_DIR/a3s-bpf-syscall-probe" ]; then
  echo 'probe.status=MISSING_OR_NOT_EXECUTABLE' | tee -a "$report"
  probe_rc=127
else
  timeout --signal=TERM 45 "$SCRIPT_DIR/a3s-bpf-syscall-probe" 2>&1 | tee -a "$report"
  probe_rc=${PIPESTATUS[0]}
fi

{
  printf '\n===== DIAGNOSTIC RUN SUMMARY =====\n'
  printf 'passive.exit_code=%s\n' "$passive_rc"
  printf 'probe.exit_code=%s\n' "$probe_rc"
  printf 'report=%s\n' "$report"
  if [ "$probe_rc" -eq 0 ]; then
    echo 'diagnostics.completed=yes'
  else
    echo 'diagnostics.completed=partial'
  fi
} | tee -a "$report"

echo "Please return this report file: $report"
exit "$probe_rc"
