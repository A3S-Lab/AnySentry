#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT_DIR=$(cd "$SCRIPT_DIR/../.." && pwd)
BUILD_DIR=${ANYSENTRY_BUILD_DIR:-$ROOT_DIR/.build/uos20-arm64}
STAGE_DIR=${ANYSENTRY_STAGE_DIR:-$ROOT_DIR/release/uos20-arm64}
CACHE_DIR=$BUILD_DIR/cache
CODE_VERSION=5.1.0
CODE_ARM64_PACKAGE=@a3s-lab/code-linux-arm64-gnu@$CODE_VERSION
CODE_ARM64_ARCHIVE=a3s-lab-code-linux-arm64-gnu-$CODE_VERSION.tgz
CODE_ARM64_SHA256=d8092bb02d2a04380cd29b21716b65ac1b45263c9903a38fcbfb4a9d1cf0e03f

generic_source=$ROOT_DIR/apps/api/node_modules/@a3s-lab/code
if [[ ! -f "$generic_source/index.js" ]]; then
  echo "@a3s-lab/code is missing; run pnpm install --frozen-lockfile first" >&2
  exit 1
fi
actual_version=$(node -p "require('$generic_source/package.json').version")
if [[ "$actual_version" != "$CODE_VERSION" ]]; then
  echo "@a3s-lab/code version mismatch: expected $CODE_VERSION, got $actual_version" >&2
  exit 1
fi

mkdir -p "$CACHE_DIR"
archive=$CACHE_DIR/$CODE_ARM64_ARCHIVE
if [[ ! -f "$archive" ]]; then
  npm pack --silent --pack-destination "$CACHE_DIR" "$CODE_ARM64_PACKAGE" >/dev/null
fi
echo "$CODE_ARM64_SHA256  $archive" | sha256sum --check --status

tmp=$(mktemp -d "$BUILD_DIR/l3.XXXXXX")
cleanup() {
  rm -rf "$tmp"
}
trap cleanup EXIT
tar -xzf "$archive" -C "$tmp"

rm -rf "$STAGE_DIR/l3"
install -d -m 0755 "$STAGE_DIR/l3/node_modules/@a3s-lab" "$STAGE_DIR/l3/skills"
cp -aL "$generic_source" "$STAGE_DIR/l3/node_modules/@a3s-lab/code"
find "$STAGE_DIR/l3/node_modules/@a3s-lab/code" -maxdepth 1 -type f -name '*.node' -delete
install -m 0644 "$tmp/package/index.linux-arm64-gnu.node" \
  "$STAGE_DIR/l3/node_modules/@a3s-lab/code/index.linux-arm64-gnu.node"
install -m 0755 "$ROOT_DIR/scripts/l3-agent.mjs" "$STAGE_DIR/l3/l3-agent.mjs"
cp -a "$ROOT_DIR/skills/l3/." "$STAGE_DIR/l3/skills/"

"$SCRIPT_DIR/check-elf.sh" "$STAGE_DIR/l3/node_modules/@a3s-lab/code/index.linux-arm64-gnu.node"
printf '%s\n' "$CODE_VERSION" > "$STAGE_DIR/l3/CODE_VERSION"
printf '%s\n' "$CODE_ARM64_SHA256" > "$STAGE_DIR/l3/CODE_ARM64_SHA256"
echo "ARM64 L3 agent runtime staged at $STAGE_DIR/l3"
