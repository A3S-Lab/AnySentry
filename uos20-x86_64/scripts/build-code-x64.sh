#!/usr/bin/env bash
# Rebuild the a3s-code Node addon for the debug-variant glibc floor (2.34).
# The published @a3s-lab/code-linux-x64-gnu binary requires glibc 2.35 (hypot),
# one symbol newer than the Rocky 9 debug machine provides.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"

TOOLS=$BUILD_DIR/tools
CACHE=$BUILD_DIR/cache
zig=$TOOLS/zig-$ZIG_VERSION/zig
zigbuild=$TOOLS/cargo-zigbuild-$CARGO_ZIGBUILD_VERSION/bin/cargo-zigbuild
[[ -x "$zig" && -x "$zigbuild" ]] || die 'x86_64 toolchain cache missing; build sentry first'

source_dir=$BUILD_DIR/code-source
if [[ ! -d "$source_dir/.git" ]]; then
  git clone "$CODE_SOURCE_REPO" "$source_dir"
fi
git -C "$source_dir" fetch --tags origin
git -C "$source_dir" checkout --detach --force "$CODE_SOURCE_COMMIT"

rustup target add "$RUST_TARGET" >/dev/null
export PATH="$(dirname "$zigbuild"):$PATH" CARGO_ZIGBUILD_ZIG_PATH=$zig
export CARGO_NET_RETRY=10 CARGO_HTTP_MULTIPLEXING=false
(cd "$source_dir/sdk/node" && cargo zigbuild --locked --release --target "$TARGET_TRIPLE")

built=$(find "$BUILD_DIR/code-source/sdk/node/target" -type f -name 'liba3s_code_node.so' -print -quit)
[[ -n "$built" ]] || die "a3s-code-node build output missing"
out=$CACHE/code-glibc234
mkdir -p "$out"
install -m 0755 "$built" "$out/index.linux-x64-gnu.node"
"$CHANNEL_DIR/scripts/check-elf.sh" "$out/index.linux-x64-gnu.node"
echo "Rebuilt a3s-code x64 addon cached at $out"
