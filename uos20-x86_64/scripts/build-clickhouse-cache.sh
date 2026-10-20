#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT_DIR=$(cd "$SCRIPT_DIR/../.." && pwd)
BUILD_DIR=${ANYSENTRY_BUILD_DIR:-$ROOT_DIR/.build/uos20-x86_64}
CACHE_DIR=${CLICKHOUSE_COMPAT_DIR:-$BUILD_DIR/clickhouse-official}

# shellcheck source=../versions.env
source "$SCRIPT_DIR/../versions.env"

for command_name in docker sha256sum readelf; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "required command not found: $command_name" >&2
    exit 1
  }
done

cache_is_valid() {
  [[ -x "$CACHE_DIR/clickhouse" ]] || return 1
  [[ "$(cat "$CACHE_DIR/VERSION" 2>/dev/null)" == "$CLICKHOUSE_VERSION" ]] || return 1
  [[ "$(cat "$CACHE_DIR/PROFILE" 2>/dev/null)" == "$CLICKHOUSE_PROFILE" ]] || return 1
  (cd "$CACHE_DIR" && sha256sum --check --quiet clickhouse.sha256)
}

if cache_is_valid; then
  echo "Reusing official ClickHouse $CLICKHOUSE_VERSION amd64 cache: $CACHE_DIR"
  exit 0
fi

rm -rf "$CACHE_DIR"
mkdir -p "$CACHE_DIR"
container=anysentry-ch-extract-$$
trap 'docker rm -f "$container" >/dev/null 2>&1 || true' EXIT
docker image inspect "$CLICKHOUSE_IMAGE" >/dev/null 2>&1 ||
  docker pull --platform linux/amd64 "$CLICKHOUSE_IMAGE"
docker create --platform linux/amd64 --name "$container" --entrypoint /bin/true \
  "$CLICKHOUSE_IMAGE" >/dev/null
docker cp "$container:/usr/bin/clickhouse" "$CACHE_DIR/clickhouse"
docker rm "$container" >/dev/null

[[ -x "$CACHE_DIR/clickhouse" ]] || { echo "extracted clickhouse binary is not executable" >&2; exit 1; }
"$CACHE_DIR/clickhouse" --version >/dev/null
sha256sum "$CACHE_DIR/clickhouse" | awk '{print $1"  clickhouse"}' > "$CACHE_DIR/clickhouse.sha256"
printf '%s\n' "$CLICKHOUSE_VERSION" > "$CACHE_DIR/VERSION"
printf '%s\n' "$CLICKHOUSE_COMMIT" > "$CACHE_DIR/SOURCE_COMMIT"
printf '%s\n' "$CLICKHOUSE_PROFILE" > "$CACHE_DIR/PROFILE"
printf '%s\n' "$CLICKHOUSE_IMAGE" > "$CACHE_DIR/BUILDER_IMAGE"
printf '%s\n' "official-image" > "$CACHE_DIR/STRIP_MODE"
echo "Official ClickHouse $CLICKHOUSE_VERSION amd64 cached at $CACHE_DIR"
