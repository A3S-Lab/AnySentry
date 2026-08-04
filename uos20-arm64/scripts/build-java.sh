#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"
ensure_stage

CACHE=$BUILD_DIR/cache
archive=$CACHE/OpenJDK17U-jre_aarch64_linux_hotspot_${JAVA_VERSION}.tar.gz
mkdir -p "$CACHE"
if [[ ! -f $archive ]]; then
  curl --fail --location --retry 3 -o "$archive" \
    "https://github.com/adoptium/temurin17-binaries/releases/download/jdk-${JAVA_DISPLAY_VERSION/+/%2B}/OpenJDK17U-jre_aarch64_linux_hotspot_${JAVA_VERSION}.tar.gz"
fi
echo "$JAVA_ARM64_SHA256  $archive" | sha256sum --check

tmp=$(mktemp -d "$BUILD_DIR/java.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
tar -xzf "$archive" -C "$tmp"
java_root=$(find "$tmp" -mindepth 1 -maxdepth 1 -type d -print -quit)
[[ -x $java_root/bin/java ]] || die 'Temurin ARM64 JRE archive does not contain bin/java'
rm -rf "$STAGE_DIR/java"
install -d -m 0755 "$STAGE_DIR/java"
cp -a "$java_root/." "$STAGE_DIR/java/"
printf '%s\n' "$JAVA_DISPLAY_VERSION" >"$STAGE_DIR/java/VERSION"
"$CHANNEL_DIR/scripts/check-elf.sh" "$STAGE_DIR/java/bin/java"
"$CHANNEL_DIR/scripts/check-elf.sh" "$STAGE_DIR/java/lib/server/libjvm.so"

