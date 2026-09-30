#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"
ensure_stage

app_source=$SOURCE_DIR/anysentry
generic=$STAGE_DIR/app/node_modules/@a3s-lab/code
[[ -f "$generic/index.js" ]] || die 'run the app component before l3'
actual=$(node -p "require('$generic/package.json').version")
[[ "$actual" == "$CODE_VERSION" ]] || die "a3s-code version mismatch: $actual"
CACHE=$BUILD_DIR/cache
mkdir -p "$CACHE"
# The published linux-arm64-gnu binary links a zvec library that needs glibc 2.38.
# A locally rebuilt pair for glibc 2.28 is used when it is present in the cache.
local_runtime=$CACHE/code-glibc228
if [[ -f $local_runtime/index.linux-arm64-gnu.node && -f $local_runtime/libzvec_c_api.so ]]; then
  node_src=$local_runtime/index.linux-arm64-gnu.node
  zvec_src=$local_runtime/libzvec_c_api.so
else
  archive=$CACHE/a3s-lab-code-linux-arm64-gnu-$CODE_VERSION.tgz
  [[ -f "$archive" ]] || npm pack --silent --pack-destination "$CACHE" "@a3s-lab/code-linux-arm64-gnu@$CODE_VERSION" >/dev/null
  echo "$CODE_ARM64_SHA256  $archive" | sha256sum --check
  tmp=$(mktemp -d "$BUILD_DIR/l3.XXXXXX")
  trap 'rm -rf "$tmp"' EXIT
  tar -xzf "$archive" -C "$tmp"
  node_src=$tmp/package/index.linux-arm64-gnu.node
  zvec_src=
fi
rm -rf "$STAGE_DIR/l3"
install -d -m 0755 "$STAGE_DIR/l3/node_modules/@a3s-lab" "$STAGE_DIR/l3/skills"
cp -aL "$generic" "$STAGE_DIR/l3/node_modules/@a3s-lab/code"
install_code_runtime() {
  local dest=$1
  find "$dest" -maxdepth 1 -name '*.node' -delete
  rm -rf "$dest/zvec"
  install -m 0755 "$node_src" "$dest/index.linux-arm64-gnu.node"
  if [[ -n $zvec_src ]]; then
    install -d -m 0755 "$dest/zvec"
    install -m 0755 "$zvec_src" "$dest/zvec/libzvec_c_api.so"
    patchelf --set-rpath '$ORIGIN/zvec' "$dest/index.linux-arm64-gnu.node"
  fi
}
install_code_runtime "$STAGE_DIR/l3/node_modules/@a3s-lab/code"
app_code=$(readlink -f "$STAGE_DIR/app/node_modules/@a3s-lab/code")
[[ -d "$app_code" ]] || die 'staged app does not contain a3s-code for the L3 worker'
install_code_runtime "$app_code"
install -m 0755 "$app_source/scripts/l3-agent.mjs" "$STAGE_DIR/l3/l3-agent.mjs"
cp -a "$app_source/skills/l3/." "$STAGE_DIR/l3/skills/"
printf '%s\n' "$CODE_VERSION" > "$STAGE_DIR/l3/CODE_VERSION"
"$CHANNEL_DIR/scripts/check-elf.sh" "$STAGE_DIR/l3/node_modules/@a3s-lab/code/index.linux-arm64-gnu.node"
"$CHANNEL_DIR/scripts/check-elf.sh" "$app_code/index.linux-arm64-gnu.node"
if [[ -n $zvec_src ]]; then
  "$CHANNEL_DIR/scripts/check-elf.sh" "$STAGE_DIR/l3/node_modules/@a3s-lab/code/zvec/libzvec_c_api.so"
  "$CHANNEL_DIR/scripts/check-elf.sh" "$app_code/zvec/libzvec_c_api.so"
fi
