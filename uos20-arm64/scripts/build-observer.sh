#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"
ensure_stage

TOOLS=$BUILD_DIR/tools
zig=$TOOLS/zig-$ZIG_VERSION/zig
zigbuild=$TOOLS/cargo-zigbuild-$CARGO_ZIGBUILD_VERSION/bin/cargo-zigbuild
[[ -x "$zig" && -x "$zigbuild" ]] || die 'ARM64 toolchain cache missing; build sentry first'
require_command docker

observer=$SOURCE_DIR/observer
bpf=$BUILD_DIR/observer-bpf/probes-legacy.o
install -d -m 0755 "$(dirname "$bpf")"
image=${A3S_BPF_BUILDER_IMAGE:-clickhouse/binary-builder@sha256:050ad5096036206c44ac8b015eee5bbdb3207b4250fec957b0f3abd362dfcf9f}
docker run --rm --user "$(id -u):$(id -g)" -v "$observer:/src:ro" -v "$(dirname "$bpf"):/out" --entrypoint clang "$image" \
  -target bpfel -mcpu=v1 -O2 -g0 -Wall -Werror -fno-stack-protector -fno-asynchronous-unwind-tables \
  -mllvm -enable-tail-merge=0 -mllvm -disable-branch-fold -mllvm -disable-block-placement \
  -c /src/a3s-observer-ebpf-legacy/src/probes.c -o /out/probes-legacy.o
node "$CHANNEL_DIR/scripts/verify-legacy-bpf-object.mjs" "$bpf"

rustup target add "$RUST_TARGET" >/dev/null
export PATH="$(dirname "$zigbuild"):$PATH" CARGO_ZIGBUILD_ZIG_PATH=$zig CARGO_TARGET_DIR=$BUILD_DIR/observer-current-target A3S_LEGACY_BPF_OBJECT=$bpf
cargo zigbuild --manifest-path "$observer/Cargo.toml" --locked --release --package a3s-observer-collector --bin a3s-observer-collector --features legacy-kernel-4-19 --target "$TARGET_TRIPLE"
built=$CARGO_TARGET_DIR/$RUST_TARGET/release/a3s-observer-collector
[[ -f "$built" ]] || die "Observer output missing: $built"
rm -rf "$STAGE_DIR/observer"
install -d -m 0755 "$STAGE_DIR/observer/bin"
install -m 0755 "$built" "$STAGE_DIR/observer/bin/a3s-observer-collector"
install -m 0644 "$SOURCE_DIR/anysentry/scripts/observer-forward.js" "$STAGE_DIR/observer/observer-forward.js"
install -m 0644 "$SOURCE_DIR/anysentry/scripts/observer-agent-attribution.js" "$STAGE_DIR/observer/observer-agent-attribution.js"
install -m 0644 "$SOURCE_DIR/anysentry/scripts/observer-event-dedup.js" "$STAGE_DIR/observer/observer-event-dedup.js"
install -m 0644 "$bpf" "$STAGE_DIR/observer/probes-legacy.o"
printf '%s\n' 'perf-kprobe-legacy' > "$STAGE_DIR/observer/BACKEND"
printf '%s\n' "$UOS_BPF_KERNEL_VERSION" > "$STAGE_DIR/observer/KERNEL_VERSION"
printf '%s\n' "$UOS_BPF_KERNEL_VERSION_CODE" > "$STAGE_DIR/observer/KERNEL_VERSION_CODE"
"$CHANNEL_DIR/scripts/check-elf.sh" "$STAGE_DIR/observer/bin/a3s-observer-collector"
