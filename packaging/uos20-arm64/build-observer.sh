#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT_DIR=$(cd "$SCRIPT_DIR/../.." && pwd)
BUILD_DIR=${ANYSENTRY_BUILD_DIR:-$ROOT_DIR/.build/uos20-arm64}
STAGE_DIR=${ANYSENTRY_STAGE_DIR:-$ROOT_DIR/release/uos20-arm64}
TOOLS_DIR=$BUILD_DIR/tools
OBSERVER_COMMIT=b0413734c443bae12f4892129efac11a807874b6
OBSERVER_TARGET=aarch64-unknown-linux-gnu.2.28
OBSERVER_RUST_TARGET=aarch64-unknown-linux-gnu
CARGO_ZIGBUILD_VERSION=0.23.0
ZIG_VERSION=0.14.1

if [[ -n "${OBSERVER_SOURCE_DIR:-}" ]]; then
  observer_source=$(cd "$OBSERVER_SOURCE_DIR" && pwd)
else
  common_dir=$(git -C "$ROOT_DIR" rev-parse --path-format=absolute --git-common-dir)
  observer_source=$(cd "$(dirname "$common_dir")/../Observer" && pwd)
fi

actual_commit=$(git -C "$observer_source" rev-parse HEAD)
if [[ "$actual_commit" != "$OBSERVER_COMMIT" ]]; then
  echo "Observer source commit mismatch: expected $OBSERVER_COMMIT, got $actual_commit" >&2
  exit 1
fi
if [[ -n "$(git -C "$observer_source" status --porcelain)" ]]; then
  echo "Observer source is dirty; refusing a provenance release" >&2
  exit 1
fi

zig_bin=$TOOLS_DIR/zig-$ZIG_VERSION/zig
cargo_zig_root=$TOOLS_DIR/cargo-zigbuild-$CARGO_ZIGBUILD_VERSION
if [[ ! -x "$zig_bin" || ! -x "$cargo_zig_root/bin/cargo-zigbuild" ]]; then
  echo "ARM64 toolchain cache is missing; run build-sentry.sh first" >&2
  exit 1
fi

rustup target add "$OBSERVER_RUST_TARGET"
target_dir=$BUILD_DIR/observer-target
export PATH="$cargo_zig_root/bin:$PATH"
export CARGO_ZIGBUILD_ZIG_PATH="$zig_bin"
export CARGO_TARGET_DIR="$target_dir"

cargo zigbuild \
  --manifest-path "$observer_source/Cargo.toml" \
  --locked \
  --release \
  --package a3s-observer-collector \
  --bin a3s-observer-collector \
  --features legacy-kernel-4-19 \
  --target "$OBSERVER_TARGET"

built_collector=$target_dir/$OBSERVER_RUST_TARGET/release/a3s-observer-collector
if [[ ! -f "$built_collector" ]]; then
  echo "Observer collector output not found: $built_collector" >&2
  exit 1
fi

rm -rf "$STAGE_DIR/observer"
install -d -m 0755 "$STAGE_DIR/observer/bin"
install -m 0755 "$built_collector" "$STAGE_DIR/observer/bin/a3s-observer-collector"
install -m 0644 "$ROOT_DIR/scripts/observer-forward.js" "$STAGE_DIR/observer/observer-forward.js"
"$SCRIPT_DIR/check-elf.sh" "$STAGE_DIR/observer/bin/a3s-observer-collector"

printf '%s\n' "$OBSERVER_COMMIT" > "$STAGE_DIR/observer/OBSERVER_COMMIT"
printf '%s\n' "$OBSERVER_TARGET" > "$STAGE_DIR/observer/OBSERVER_TARGET"
printf '%s\n' 'perf-kprobe-legacy' > "$STAGE_DIR/observer/BACKEND"
echo "ARM64 Linux 4.19 Observer staged at $STAGE_DIR/observer"
