#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"
ensure_stage

TOOLS=$BUILD_DIR/tools
CACHE=$BUILD_DIR/cache
zig=$TOOLS/zig-$ZIG_VERSION/zig
[[ -x $zig ]] || die 'ARM64 Zig toolchain cache missing; build sentry first'
require_command curl
require_command make

archive=$CACHE/redis-$REDIS_VERSION.tar.gz
mkdir -p "$CACHE"
if [[ ! -f $archive ]]; then
  curl --fail --location --retry 3 \
    -o "$archive" "https://download.redis.io/releases/redis-$REDIS_VERSION.tar.gz"
fi
echo "$REDIS_SOURCE_SHA256  $archive" | sha256sum --check

source_root=$BUILD_DIR/redis-source-$REDIS_VERSION
rm -rf "$source_root"
mkdir -p "$source_root"
tar -xzf "$archive" --strip-components=1 -C "$source_root"

cross_cc="$zig cc -target $TARGET_TRIPLE -mcpu=baseline"
make -C "$source_root" -j"$(getconf _NPROCESSORS_ONLN)" \
  CC="$cross_cc" \
  MALLOC=libc \
  BUILD_TLS=no \
  USE_SYSTEMD=no \
  CFLAGS="-O2 -fPIC" \
  LDFLAGS="-Wl,-z,max-page-size=$TARGET_PAGE_SIZE" \
  redis-server redis-cli

rm -rf "$STAGE_DIR/redis"
install -d -m 0755 "$STAGE_DIR/redis/bin" "$STAGE_DIR/redis/etc"
install -m 0755 "$source_root/src/redis-server" "$STAGE_DIR/redis/bin/redis-server"
install -m 0755 "$source_root/src/redis-cli" "$STAGE_DIR/redis/bin/redis-cli"
install -m 0644 "$CHANNEL_DIR/package/config/redis.conf" "$STAGE_DIR/redis/etc/redis.conf"
"$CHANNEL_DIR/scripts/check-elf.sh" "$STAGE_DIR/redis/bin/redis-server"
"$CHANNEL_DIR/scripts/check-elf.sh" "$STAGE_DIR/redis/bin/redis-cli"
