#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT_DIR=$(cd "$SCRIPT_DIR/../.." && pwd)
STAGE_DIR=${ANYSENTRY_STAGE_DIR:-$ROOT_DIR/release/uos20-arm64}
BUILD_DIR=${ANYSENTRY_BUILD_DIR:-$ROOT_DIR/.build/uos20-arm64}
CLICKHOUSE_COMPAT_DIR=${CLICKHOUSE_COMPAT_DIR:-$BUILD_DIR/clickhouse-compat}
CLICKHOUSE_IMAGE=clickhouse/clickhouse-server@sha256:ae7eea6602398611a8d34ed6cbee659cf355de907304a44e105cf8a97cfadd5a
CLICKHOUSE_VERSION=24.8.14.39
CLICKHOUSE_COMMIT=502d03925cf2c9c6629ed5c1b2d16b5de46e4362
CLICKHOUSE_PROFILE=armv8.0-compat
CLICKHOUSE_STRIP_MODE=llvm-strip-18--strip-all

for required in clickhouse clickhouse.sha256 VERSION SOURCE_COMMIT PROFILE BUILDER_IMAGE STRIP_MODE; do
  [[ -f "$CLICKHOUSE_COMPAT_DIR/$required" ]] || {
    echo "ClickHouse compat cache file missing: $CLICKHOUSE_COMPAT_DIR/$required" >&2
    echo "Run $SCRIPT_DIR/build-clickhouse-compat.sh first." >&2
    exit 1
  }
done
[[ "$(cat "$CLICKHOUSE_COMPAT_DIR/VERSION")" == "$CLICKHOUSE_VERSION" ]] || {
  echo "ClickHouse compat cache version mismatch" >&2
  exit 1
}
[[ "$(cat "$CLICKHOUSE_COMPAT_DIR/SOURCE_COMMIT")" == "$CLICKHOUSE_COMMIT" ]] || {
  echo "ClickHouse compat cache source commit mismatch" >&2
  exit 1
}
[[ "$(cat "$CLICKHOUSE_COMPAT_DIR/PROFILE")" == "$CLICKHOUSE_PROFILE" ]] || {
  echo "ClickHouse compat cache profile mismatch" >&2
  exit 1
}
[[ "$(cat "$CLICKHOUSE_COMPAT_DIR/STRIP_MODE")" == "$CLICKHOUSE_STRIP_MODE" ]] || {
  echo "ClickHouse compat cache strip mode mismatch" >&2
  exit 1
}
(
  cd "$CLICKHOUSE_COMPAT_DIR"
  sha256sum --check --quiet clickhouse.sha256
) || {
  echo "ClickHouse compat cache checksum validation failed" >&2
  exit 1
}

docker pull --platform linux/arm64 "$CLICKHOUSE_IMAGE"
container=$(docker create --platform linux/arm64 "$CLICKHOUSE_IMAGE")
cleanup() {
  docker rm "$container" >/dev/null 2>&1 || true
}
trap cleanup EXIT

rm -rf "$STAGE_DIR/clickhouse"
mkdir -p "$STAGE_DIR/clickhouse/bin" "$STAGE_DIR/clickhouse/etc/config.d" "$STAGE_DIR/clickhouse/etc/users.d"

install -m 0755 "$CLICKHOUSE_COMPAT_DIR/clickhouse" "$STAGE_DIR/clickhouse/bin/clickhouse"
docker cp "$container:/etc/clickhouse-server/." "$STAGE_DIR/clickhouse/etc/"
rm -f "$STAGE_DIR/clickhouse/etc/config.d/docker_related_config.xml"

install -m 0644 "$SCRIPT_DIR/config/clickhouse-config.xml" "$STAGE_DIR/clickhouse/etc/config.d/anysentry.xml"
install -m 0644 "$SCRIPT_DIR/config/clickhouse-users.xml" "$STAGE_DIR/clickhouse/etc/users.d/anysentry.xml"
chmod 0755 "$STAGE_DIR/clickhouse/bin/clickhouse"

"$SCRIPT_DIR/check-elf.sh" "$STAGE_DIR/clickhouse/bin/clickhouse"
printf '%s\n' "$CLICKHOUSE_IMAGE" > "$STAGE_DIR/clickhouse/IMAGE"
install -m 0644 "$CLICKHOUSE_COMPAT_DIR/VERSION" "$STAGE_DIR/clickhouse/VERSION"
install -m 0644 "$CLICKHOUSE_COMPAT_DIR/SOURCE_COMMIT" "$STAGE_DIR/clickhouse/SOURCE_COMMIT"
install -m 0644 "$CLICKHOUSE_COMPAT_DIR/PROFILE" "$STAGE_DIR/clickhouse/PROFILE"
install -m 0644 "$CLICKHOUSE_COMPAT_DIR/BUILDER_IMAGE" "$STAGE_DIR/clickhouse/BUILDER_IMAGE"
install -m 0644 "$CLICKHOUSE_COMPAT_DIR/STRIP_MODE" "$STAGE_DIR/clickhouse/STRIP_MODE"
awk '{ print $1 }' "$CLICKHOUSE_COMPAT_DIR/clickhouse.sha256" > "$STAGE_DIR/clickhouse/BINARY_SHA256"
echo "ARM64 ClickHouse $CLICKHOUSE_PROFILE staged at $STAGE_DIR/clickhouse"
