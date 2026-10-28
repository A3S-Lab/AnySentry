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
docker cp "$container:/usr/lib/postgresql/13/bin/." "$tmp/"
docker rm "$container" >/dev/null
[[ -x "$tmp/postgres" && -x "$tmp/initdb" && -x "$tmp/pg_ctl" ]] || die "postgres archive incomplete"

rm -rf "$STAGE_DIR/postgresql"
install -d -m 0755 "$STAGE_DIR/postgresql/bin"
for b in postgres initdb pg_ctl pg_controldata pg_isready psql createdb createuser; do
  [[ -x "$tmp/$b" ]] && install -m 0755 "$tmp/$b" "$STAGE_DIR/postgresql/bin/"
done
# Debian buster system libs satisfy every NEEDED entry on UOS 20 (same base);
# ship only the server-side plugin dir for optional extensions.
docker create --platform linux/arm64 --name "$container" --entrypoint /bin/true "$POSTGRES_IMAGE" >/dev/null
libtmp=$(mktemp -d "$BUILD_DIR/pglib.XXXXXX")
docker cp "$container:/usr/lib/postgresql/13/lib/." "$libtmp/" 2>/dev/null || true
docker rm "$container" >/dev/null
if compgen -G "$libtmp/*.so" >/dev/null; then
  install -d -m 0755 "$STAGE_DIR/postgresql/lib"
  find "$libtmp" -maxdepth 1 -name '*.so' -exec install -m 0755 {} "$STAGE_DIR/postgresql/lib/" \;
fi
rm -rf "$tmp" "$libtmp"
"$CHANNEL_DIR/scripts/check-elf.sh" "$STAGE_DIR/postgresql/bin/postgres"
"$CHANNEL_DIR/scripts/check-elf.sh" "$STAGE_DIR/postgresql/bin/initdb"
printf '%s\n' "$POSTGRES_VERSION" >"$STAGE_DIR/postgresql/POSTGRES_VERSION"
