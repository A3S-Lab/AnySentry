#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"
ensure_stage

app_source=$SOURCE_DIR/anysentry
generic=$app_source/apps/api/node_modules/@a3s-lab/code
[[ -f "$generic/index.js" ]] || die 'run the app component before l3'
actual=$(node -p "require('$generic/package.json').version")
[[ "$actual" == "$CODE_VERSION" ]] || die "a3s-code version mismatch: $actual"
CACHE=$BUILD_DIR/cache
mkdir -p "$CACHE"
archive=$CACHE/a3s-lab-code-linux-arm64-gnu-$CODE_VERSION.tgz
[[ -f "$archive" ]] || npm pack --silent --pack-destination "$CACHE" "@a3s-lab/code-linux-arm64-gnu@$CODE_VERSION" >/dev/null
echo "$CODE_ARM64_SHA256  $archive" | sha256sum --check
tmp=$(mktemp -d "$BUILD_DIR/l3.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
tar -xzf "$archive" -C "$tmp"
rm -rf "$STAGE_DIR/l3"
install -d -m 0755 "$STAGE_DIR/l3/node_modules/@a3s-lab" "$STAGE_DIR/l3/skills"
cp -aL "$generic" "$STAGE_DIR/l3/node_modules/@a3s-lab/code"
find "$STAGE_DIR/l3/node_modules/@a3s-lab/code" -maxdepth 1 -name '*.node' -delete
install -m 0644 "$tmp/package/index.linux-arm64-gnu.node" "$STAGE_DIR/l3/node_modules/@a3s-lab/code/index.linux-arm64-gnu.node"
app_code=$STAGE_DIR/app/node_modules/@a3s-lab/code
[[ -d "$app_code" ]] || die 'staged app does not contain a3s-code for the L3 worker'
find "$app_code" -maxdepth 1 -name '*.node' -delete
install -m 0644 "$tmp/package/index.linux-arm64-gnu.node" "$app_code/index.linux-arm64-gnu.node"
install -m 0755 "$app_source/scripts/l3-agent.mjs" "$STAGE_DIR/l3/l3-agent.mjs"
cp -a "$app_source/skills/l3/." "$STAGE_DIR/l3/skills/"
printf '%s\n' "$CODE_VERSION" > "$STAGE_DIR/l3/CODE_VERSION"
"$CHANNEL_DIR/scripts/check-elf.sh" "$STAGE_DIR/l3/node_modules/@a3s-lab/code/index.linux-arm64-gnu.node"
"$CHANNEL_DIR/scripts/check-elf.sh" "$app_code/index.linux-arm64-gnu.node"
