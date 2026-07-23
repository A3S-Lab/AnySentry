#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"
ensure_stage

CACHE=$BUILD_DIR/cache
mkdir -p "$CACHE"
archive=$CACHE/node-v${NODE_VERSION}-linux-arm64.tar.xz
[[ -f "$archive" ]] || curl --fail --location --retry 3 -o "$archive" "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-arm64.tar.xz"
echo "$NODE_SHA256  $archive" | sha256sum --check
tmp=$(mktemp -d "$BUILD_DIR/node.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
tar -xJf "$archive" -C "$tmp"
rm -rf "$STAGE_DIR/runtime"
install -d -m 0755 "$STAGE_DIR/runtime/node"
cp -a "$tmp/node-v${NODE_VERSION}-linux-arm64/." "$STAGE_DIR/runtime/node/"
printf '%s\n' "$NODE_VERSION" > "$STAGE_DIR/runtime/NODE_VERSION"
"$CHANNEL_DIR/scripts/check-elf.sh" "$STAGE_DIR/runtime/node/bin/node"

