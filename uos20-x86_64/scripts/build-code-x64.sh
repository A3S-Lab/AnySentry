#!/usr/bin/env bash
# Prepare a glibc-2.34-compatible a3s-code Node addon for the debug variant.
#
# The published @a3s-lab/code-linux-x64-gnu binary references hypot@GLIBC_2.35
# (the only 2.35 symbol; an artifact of the publisher's newer build glibc).
# glibc's hypot(double,double) has existed unchanged since GLIBC_2.2.5, so the
# version reference is retargeted instead of rebuilding from source: the source
# tree at this version needs private workspace crates that are not published.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"

CACHE=$BUILD_DIR/cache
mkdir -p "$CACHE"
archive=$CACHE/a3s-lab-code-linux-x64-gnu-$CODE_VERSION.tgz
[[ -f "$archive" ]] || npm pack --silent --pack-destination "$CACHE" "@a3s-lab/code-linux-x64-gnu@$CODE_VERSION" >/dev/null
echo "$CODE_X64_SHA256  $archive" | sha256sum --check

tmp=$(mktemp -d "$BUILD_DIR/code-patch.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
tar -xzf "$archive" -C "$tmp"

out=$CACHE/code-glibc234
rm -rf "$out"
mkdir -p "$out"
python3 "$CHANNEL_DIR/scripts/patch-code-glibc.py" \
  "$tmp/package/index.linux-x64-gnu.node" "$out/index.linux-x64-gnu.node"
install -d -m 0755 "$out/zvec"
install -m 0755 "$tmp/package/zvec/libzvec_c_api.so" "$out/zvec/libzvec_c_api.so"
"$CHANNEL_DIR/scripts/check-elf.sh" "$out/index.linux-x64-gnu.node"
if LANG=C readelf -W --version-info --dyn-syms "$out/index.linux-x64-gnu.node" \
    | grep -q 'GLIBC_2\.35'; then
  die 'patched addon still references GLIBC_2.35'
fi
echo "glibc-2.34-compatible a3s-code addon cached at $out"
