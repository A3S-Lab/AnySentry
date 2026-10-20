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

max_glibc() {
  LANG=C readelf -W --version-info --dyn-syms "$1" 2>/dev/null     | sed -nE 's/.*Name: GLIBC_([0-9.]+).*/\1/p' | sort -V | tail -n 1
}

glibc_ok() {
  local required
  required=$(max_glibc "$1")
  [[ -z "$required" ]] && return 0
  [[ "$(printf '%s\n%s\n' "${TARGET_GLIBC#GLIBC_}" "$required" | sort -V | tail -n 1)" == "${TARGET_GLIBC#GLIBC_}" ]]
}

archive=$CACHE/a3s-lab-code-linux-x64-gnu-$CODE_VERSION.tgz
[[ -f "$archive" ]] || npm pack --silent --pack-destination "$CACHE" "@a3s-lab/code-linux-x64-gnu@$CODE_VERSION" >/dev/null
echo "$CODE_X64_SHA256  $archive" | sha256sum --check
tmp=$(mktemp -d "$BUILD_DIR/l3.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
tar -xzf "$archive" -C "$tmp"

# The published linux-x64-gnu .node links against symbols newer than the target
# glibc (2.34 on the debug-variant host). A locally rebuilt binary is used when
# present in the cache; zvec's libzvec_c_api.so only needs glibc 2.27 and always
# comes from the published package.
node_src=$tmp/package/index.linux-x64-gnu.node
if ! glibc_ok "$node_src"; then
  local_runtime=$CACHE/code-glibc234
  if [[ -f $local_runtime/index.linux-x64-gnu.node ]]; then
    node_src=$local_runtime/index.linux-x64-gnu.node
  else
    die "published a3s-code .node needs glibc > $TARGET_GLIBC; run scripts/build-code-x64.sh first"
  fi
fi
zvec_src=$tmp/package/zvec/libzvec_c_api.so

rm -rf "$STAGE_DIR/l3"
install -d -m 0755 "$STAGE_DIR/l3/node_modules/@a3s-lab" "$STAGE_DIR/l3/skills"
cp -aL "$generic" "$STAGE_DIR/l3/node_modules/@a3s-lab/code"
install_code_runtime() {
  local dest=$1
  find "$dest" -maxdepth 1 -name '*.node' -delete
  rm -rf "$dest/zvec"
  install -m 0755 "$node_src" "$dest/index.linux-x64-gnu.node"
  install -d -m 0755 "$dest/zvec"
  install -m 0755 "$zvec_src" "$dest/zvec/libzvec_c_api.so"
  patchelf --set-rpath '$ORIGIN/zvec' "$dest/index.linux-x64-gnu.node"
}
install_code_runtime "$STAGE_DIR/l3/node_modules/@a3s-lab/code"
app_code=$(readlink -f "$STAGE_DIR/app/node_modules/@a3s-lab/code")
[[ -d "$app_code" ]] || die "staged app does not contain a3s-code for the L3 worker"
install_code_runtime "$app_code"
install -m 0755 "$app_source/scripts/l3-agent.mjs" "$STAGE_DIR/l3/l3-agent.mjs"
cp -a "$app_source/skills/l3/." "$STAGE_DIR/l3/skills/"
printf '%s\n' "$CODE_VERSION" >"$STAGE_DIR/l3/CODE_VERSION"
"$CHANNEL_DIR/scripts/check-elf.sh" "$STAGE_DIR/l3/node_modules/@a3s-lab/code/index.linux-x64-gnu.node"
"$CHANNEL_DIR/scripts/check-elf.sh" "$app_code/index.linux-x64-gnu.node"
"$CHANNEL_DIR/scripts/check-elf.sh" "$STAGE_DIR/l3/node_modules/@a3s-lab/code/zvec/libzvec_c_api.so"
