#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"
ensure_stage

CACHE=${CLICKHOUSE_COMPAT_DIR:-$BUILD_DIR/clickhouse-compat}
if [[ ! -x "$CACHE/clickhouse" ]]; then
  "$CHANNEL_DIR/scripts/build-clickhouse-cache.sh"
fi
for file in clickhouse clickhouse.sha256 VERSION SOURCE_COMMIT PROFILE BUILDER_IMAGE STRIP_MODE; do
  [[ -f "$CACHE/$file" ]] || die "ClickHouse cache file missing: $CACHE/$file"
done
(cd "$CACHE" && sha256sum --check --quiet clickhouse.sha256) || die 'ClickHouse cache checksum failed'
[[ "$(cat "$CACHE/PROFILE")" == "$CLICKHOUSE_PROFILE" ]] || die 'ClickHouse cache is not armv8.0-compat'

require_command docker
container=$(docker create --platform linux/arm64 "$CLICKHOUSE_IMAGE")
trap 'docker rm "$container" >/dev/null 2>&1 || true' EXIT
rm -rf "$STAGE_DIR/clickhouse"
install -d -m 0755 "$STAGE_DIR/clickhouse/bin" "$STAGE_DIR/clickhouse/etc/config.d" "$STAGE_DIR/clickhouse/etc/users.d"
install -m 0755 "$CACHE/clickhouse" "$STAGE_DIR/clickhouse/bin/clickhouse"
docker cp "$container:/etc/clickhouse-server/." "$STAGE_DIR/clickhouse/etc/"
rm -f "$STAGE_DIR/clickhouse/etc/config.d/docker_related_config.xml"
install -m 0644 "$CHANNEL_DIR/package/config/clickhouse-config.xml" "$STAGE_DIR/clickhouse/etc/config.d/anysentry.xml"
install -m 0644 "$CHANNEL_DIR/package/config/clickhouse-users.xml" "$STAGE_DIR/clickhouse/etc/users.d/anysentry.xml"
for file in VERSION SOURCE_COMMIT PROFILE BUILDER_IMAGE STRIP_MODE; do install -m 0644 "$CACHE/$file" "$STAGE_DIR/clickhouse/$file"; done
awk '{print $1}' "$CACHE/clickhouse.sha256" > "$STAGE_DIR/clickhouse/BINARY_SHA256"
printf '%s\n' "$CLICKHOUSE_IMAGE" > "$STAGE_DIR/clickhouse/IMAGE"
"$CHANNEL_DIR/scripts/check-elf.sh" "$STAGE_DIR/clickhouse/bin/clickhouse"

