#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"
ensure_stage

TOOLS=$BUILD_DIR/tools
CACHE=$BUILD_DIR/cache
mkdir -p "$TOOLS" "$CACHE" "$STAGE_DIR/native"

zig=$TOOLS/zig-$ZIG_VERSION/zig
if [[ ! -x "$zig" ]]; then
  archive=$CACHE/zig-x86_64-linux-$ZIG_VERSION.tar.xz
  [[ -f "$archive" ]] || curl --fail --location --retry 3 -o "$archive" "https://ziglang.org/download/$ZIG_VERSION/zig-x86_64-linux-$ZIG_VERSION.tar.xz"
  echo "$ZIG_SHA256  $archive" | sha256sum --check
  tar -xJf "$archive" -C "$TOOLS"
  mv "$TOOLS/zig-x86_64-linux-$ZIG_VERSION" "$TOOLS/zig-$ZIG_VERSION"
fi

zigbuild=$TOOLS/cargo-zigbuild-$CARGO_ZIGBUILD_VERSION/bin/cargo-zigbuild
[[ -x "$zigbuild" ]] || cargo install --locked --version "$CARGO_ZIGBUILD_VERSION" --root "$TOOLS/cargo-zigbuild-$CARGO_ZIGBUILD_VERSION" cargo-zigbuild
rustup target add "$RUST_TARGET" >/dev/null

export PATH="$(dirname "$zigbuild"):$PATH"
export CARGO_ZIGBUILD_ZIG_PATH=$zig
export CARGO_TARGET_DIR=$BUILD_DIR/sentry-target
cargo zigbuild --manifest-path "$SOURCE_DIR/sentry/sdk/typescript/Cargo.toml" --locked --release --target "$TARGET_TRIPLE"

built=$CARGO_TARGET_DIR/$RUST_TARGET/release/liba3s_sentry_node.so
[[ -f "$built" ]] || die "Sentry build output missing: $built"
install -m 0644 "$built" "$STAGE_DIR/native/a3s-sentry.linux-arm64-gnu.node"
"$CHANNEL_DIR/scripts/check-elf.sh" "$STAGE_DIR/native/a3s-sentry.linux-arm64-gnu.node"

