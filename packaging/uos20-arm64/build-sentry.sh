#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT_DIR=$(cd "$SCRIPT_DIR/../.." && pwd)
BUILD_DIR=${ANYSENTRY_BUILD_DIR:-$ROOT_DIR/.build/uos20-arm64}
STAGE_DIR=${ANYSENTRY_STAGE_DIR:-$ROOT_DIR/release/uos20-arm64}
TOOLS_DIR=$BUILD_DIR/tools
CACHE_DIR=$BUILD_DIR/cache

SENTRY_COMMIT=f9a2f1dae626a2427e21ac5541a8a9f69d744d4a
SENTRY_REPOSITORY=https://github.com/A3S-Lab/Sentry.git
SENTRY_TARGET=aarch64-unknown-linux-gnu.2.28
SENTRY_RUST_TARGET=aarch64-unknown-linux-gnu
SENTRY_OUTPUT=a3s-sentry.linux-arm64-gnu.node
CARGO_ZIGBUILD_VERSION=0.23.0
ZIG_VERSION=0.14.1
ZIG_SHA256=24aeeec8af16c381934a6cd7d95c807a8cb2cf7df9fa40d359aa884195c4716c
ZIG_ARCHIVE=zig-x86_64-linux-${ZIG_VERSION}.tar.xz
ZIG_URL=https://ziglang.org/download/${ZIG_VERSION}/${ZIG_ARCHIVE}

mkdir -p "$TOOLS_DIR" "$CACHE_DIR" "$STAGE_DIR/native"

zig_dir=$TOOLS_DIR/zig-$ZIG_VERSION
zig_bin=$zig_dir/zig
if [[ ! -x "$zig_bin" ]]; then
  archive=$CACHE_DIR/$ZIG_ARCHIVE
  if [[ ! -f "$archive" ]]; then
    curl --fail --location --retry 3 --output "$archive" "$ZIG_URL"
  fi
  echo "$ZIG_SHA256  $archive" | sha256sum --check --status
  rm -rf "$zig_dir"
  tar -xJf "$archive" -C "$TOOLS_DIR"
  mv "$TOOLS_DIR/zig-x86_64-linux-$ZIG_VERSION" "$zig_dir"
fi

cargo_zig_root=$TOOLS_DIR/cargo-zigbuild-$CARGO_ZIGBUILD_VERSION
if [[ ! -x "$cargo_zig_root/bin/cargo-zigbuild" ]]; then
  cargo install --locked --version "$CARGO_ZIGBUILD_VERSION" --root "$cargo_zig_root" cargo-zigbuild
fi

rustup target add "$SENTRY_RUST_TARGET"

if [[ -n "${SENTRY_SOURCE_DIR:-}" ]]; then
  sentry_source=$(cd "$SENTRY_SOURCE_DIR" && pwd)
else
  sentry_source=$CACHE_DIR/sentry
  if [[ ! -d "$sentry_source/.git" ]]; then
    git clone --filter=blob:none "$SENTRY_REPOSITORY" "$sentry_source"
  fi
  git -C "$sentry_source" fetch --depth 1 origin "$SENTRY_COMMIT"
  git -C "$sentry_source" checkout --detach "$SENTRY_COMMIT"
fi

actual_commit=$(git -C "$sentry_source" rev-parse HEAD)
if [[ "$actual_commit" != "$SENTRY_COMMIT" ]]; then
  echo "Sentry source commit mismatch: expected $SENTRY_COMMIT, got $actual_commit" >&2
  exit 1
fi
if [[ -n "$(git -C "$sentry_source" status --porcelain)" ]]; then
  echo "Sentry source is dirty; refusing a provenance release" >&2
  exit 1
fi

target_dir=$BUILD_DIR/sentry-target
export PATH="$cargo_zig_root/bin:$PATH"
export CARGO_ZIGBUILD_ZIG_PATH="$zig_bin"
export CARGO_TARGET_DIR="$target_dir"

cargo zigbuild \
  --manifest-path "$sentry_source/sdk/typescript/Cargo.toml" \
  --locked \
  --release \
  --target "$SENTRY_TARGET"

built_library=$target_dir/$SENTRY_RUST_TARGET/release/liba3s_sentry_node.so
if [[ ! -f "$built_library" ]]; then
  echo "sentry build output not found: $built_library" >&2
  exit 1
fi

install -m 0644 "$built_library" "$STAGE_DIR/native/$SENTRY_OUTPUT"
"$SCRIPT_DIR/check-elf.sh" "$STAGE_DIR/native/$SENTRY_OUTPUT"

printf '%s\n' "$SENTRY_COMMIT" > "$STAGE_DIR/native/SENTRY_COMMIT"
printf '%s\n' "$SENTRY_TARGET" > "$STAGE_DIR/native/SENTRY_TARGET"
echo "ARM64 sentry staged at $STAGE_DIR/native/$SENTRY_OUTPUT"
