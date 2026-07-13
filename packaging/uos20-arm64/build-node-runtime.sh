#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT_DIR=$(cd "$SCRIPT_DIR/../.." && pwd)
BUILD_DIR=${ANYSENTRY_BUILD_DIR:-$ROOT_DIR/.build/uos20-arm64}
STAGE_DIR=${ANYSENTRY_STAGE_DIR:-$ROOT_DIR/release/uos20-arm64}
CACHE_DIR=$BUILD_DIR/cache

NODE_VERSION=20.19.4
NODE_SHA256=4492c29882f604eb4cba6ce52ad2e6436f4eeb2b2917a74b0f85e6e42e261252
NODE_ARCHIVE=node-v${NODE_VERSION}-linux-arm64.tar.xz
NODE_URL=https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ARCHIVE}

mkdir -p "$CACHE_DIR" "$STAGE_DIR/runtime"
archive=$CACHE_DIR/$NODE_ARCHIVE
if [[ ! -f "$archive" ]]; then
  curl --fail --location --retry 3 --output "$archive" "$NODE_URL"
fi
echo "$NODE_SHA256  $archive" | sha256sum --check

extract_dir=$BUILD_DIR/node-runtime
rm -rf "$extract_dir"
mkdir -p "$extract_dir"
tar -xJf "$archive" -C "$extract_dir"

rm -rf "$STAGE_DIR/runtime/node"
mkdir -p "$STAGE_DIR/runtime/node"
cp -a "$extract_dir/node-v${NODE_VERSION}-linux-arm64/." "$STAGE_DIR/runtime/node/"

"$SCRIPT_DIR/check-elf.sh" "$STAGE_DIR/runtime/node/bin/node"
printf '%s\n' "$NODE_VERSION" > "$STAGE_DIR/runtime/NODE_VERSION"
echo "ARM64 Node.js staged at $STAGE_DIR/runtime/node"
