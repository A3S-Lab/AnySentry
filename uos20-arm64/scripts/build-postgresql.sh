#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"
ensure_stage

require_command docker
container=anysentry-pg-extract-$$
trap 'docker rm -f "$container" >/dev/null 2>&1 || true' EXIT
docker image inspect "$POSTGRES_IMAGE" >/dev/null 2>&1 || docker pull --platform linux/arm64 "$POSTGRES_IMAGE"
docker create --platform linux/arm64 --name "$container" --entrypoint /bin/true "$POSTGRES_IMAGE" >/dev/null
tmp=$(mktemp -d "$BUILD_DIR/pg.XXXXXX")
docker cp "$container:/usr/local/bin/." "$tmp/"
docker rm "$container" >/dev/null
[[ -x "$tmp/postgres" && -x "$tmp/initdb" && -x "$tmp/pg_ctl" ]] || die "postgres archive incomplete"

rm -rf "$STAGE_DIR/postgresql"
install -d -m 0755 "$STAGE_DIR/postgresql/bin" "$STAGE_DIR/postgresql/lib"
install -m 0755 "$tmp"/{postgres,initdb,pg_ctl,pg_controldata,pg_isready} "$STAGE_DIR/postgresql/bin/" 2>/dev/null || install -m 0755 "$tmp"/{postgres,initdb,pg_ctl,pg_isready} "$STAGE_DIR/postgresql/bin/"
# shared libraries from the image are required at runtime
docker create --platform linux/arm64 --name "$container" --entrypoint /bin/true "$POSTGRES_IMAGE" >/dev/null
libtmp=$(mktemp -d "$BUILD_DIR/pglib.XXXXXX")
docker cp "$container:/usr/local/lib/." "$libtmp/" 2>/dev/null || true
docker rm "$container" >/dev/null
if [[ -d "$libtmp" ]]; then
  # Ship only the shared objects postgres links against; the image also carries static
  # archives (.a) that have no PT_LOAD segments and would fail the release ELF scan.
  find "$libtmp" -maxdepth 1 -name '*.so*' -exec cp -a {} "$STAGE_DIR/postgresql/lib/" \;
fi
rm -rf "$tmp" "$libtmp"
"$CHANNEL_DIR/scripts/check-elf.sh" "$STAGE_DIR/postgresql/bin/postgres"
printf '%s\n' "$POSTGRES_VERSION" >"$STAGE_DIR/postgresql/POSTGRES_VERSION"
