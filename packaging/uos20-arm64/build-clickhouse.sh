#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT_DIR=$(cd "$SCRIPT_DIR/../.." && pwd)
STAGE_DIR=${ANYSENTRY_STAGE_DIR:-$ROOT_DIR/release/uos20-arm64}
CLICKHOUSE_IMAGE=clickhouse/clickhouse-server@sha256:ae7eea6602398611a8d34ed6cbee659cf355de907304a44e105cf8a97cfadd5a

docker pull --platform linux/arm64 "$CLICKHOUSE_IMAGE"
container=$(docker create --platform linux/arm64 "$CLICKHOUSE_IMAGE")
cleanup() {
  docker rm "$container" >/dev/null 2>&1 || true
}
trap cleanup EXIT

rm -rf "$STAGE_DIR/clickhouse"
mkdir -p "$STAGE_DIR/clickhouse/bin" "$STAGE_DIR/clickhouse/etc/config.d" "$STAGE_DIR/clickhouse/etc/users.d"

docker cp "$container:/usr/bin/clickhouse" "$STAGE_DIR/clickhouse/bin/clickhouse"
docker cp "$container:/etc/clickhouse-server/." "$STAGE_DIR/clickhouse/etc/"
rm -f "$STAGE_DIR/clickhouse/etc/config.d/docker_related_config.xml"

install -m 0644 "$SCRIPT_DIR/config/clickhouse-config.xml" "$STAGE_DIR/clickhouse/etc/config.d/anysentry.xml"
install -m 0644 "$SCRIPT_DIR/config/clickhouse-users.xml" "$STAGE_DIR/clickhouse/etc/users.d/anysentry.xml"
chmod 0755 "$STAGE_DIR/clickhouse/bin/clickhouse"

"$SCRIPT_DIR/check-elf.sh" "$STAGE_DIR/clickhouse/bin/clickhouse"
printf '%s\n' "$CLICKHOUSE_IMAGE" > "$STAGE_DIR/clickhouse/IMAGE"
echo "ARM64 ClickHouse staged at $STAGE_DIR/clickhouse"
