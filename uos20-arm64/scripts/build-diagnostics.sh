#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"
ensure_stage

zig=$BUILD_DIR/tools/zig-$ZIG_VERSION/zig
[[ -x "$zig" ]] || die 'Zig toolchain missing; build sentry first'
rm -rf "$STAGE_DIR/diagnostics"
install -d -m 0755 "$STAGE_DIR/diagnostics"
"$zig" cc -target aarch64-linux-gnu.2.28 -O2 -Wall -Wextra -Werror \
  -Wl,-z,max-page-size=65536 -Wl,-z,common-page-size=65536 -s \
  "$CHANNEL_DIR/package/diagnostics-bpf-syscall-probe.c" -o "$STAGE_DIR/diagnostics/a3s-bpf-syscall-probe"
install -m 0755 "$CHANNEL_DIR/package/run-diagnostics.sh" "$STAGE_DIR/diagnostics/RUN_DIAGNOSTICS.sh"
install -m 0755 "$CHANNEL_DIR/package/inspect-bpf-passive.sh" "$STAGE_DIR/diagnostics/RUN_PASSIVE_CHECK.sh"
install -m 0644 "$CHANNEL_DIR/package/DIAGNOSTICS.md" "$STAGE_DIR/diagnostics/README.md"
"$CHANNEL_DIR/scripts/check-elf.sh" "$STAGE_DIR/diagnostics/a3s-bpf-syscall-probe"

