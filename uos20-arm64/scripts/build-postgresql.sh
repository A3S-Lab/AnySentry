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

# binaries
docker cp "$container:/usr/lib/postgresql/13/bin/." "$tmp/bin/" 2>/dev/null || { mkdir -p "$tmp/bin"; docker cp "$container:/usr/lib/postgresql/13/bin/." "$tmp/bin/"; }
[[ -x "$tmp/bin/postgres" && -x "$tmp/bin/initdb" ]] || die "postgres binaries missing"

# system runtime libs (libpq chain — UOS lacks libpq5 package)
mkdir -p "$tmp/syslib"
for f in libpq.so.5.13 libldap_r-2.4.so.2.10.10 libicui18n.so.63.1 libicuuc.so.63.1 libicudata.so.63.1; do
  docker cp "$container:/usr/lib/aarch64-linux-gnu/$f" "$tmp/syslib/" 2>/dev/null || true
done
[[ -f "$tmp/syslib/libpq.so.5.13" ]] || die "libpq.so.5 missing from image"

# plugin libs (extensions)
mkdir -p "$tmp/pluglib"
docker cp "$container:/usr/lib/postgresql/13/lib/." "$tmp/pluglib/" 2>/dev/null || true

# share data — REQUIRED by initdb (postgres.bki, timezone, extension SQL).
# docker cp chokes on the relative sample symlinks; stream via export+tar instead.
mkdir -p "$tmp/share"
mkdir -p "$tmp/pghome"
docker export "$container" | tar -C "$tmp/pghome" --strip-components=3 -xf - usr/share/postgresql
[[ -f "$tmp/pghome/13/postgres.bki" ]] || die "postgres.bki missing — initdb would fail"

docker rm "$container" >/dev/null

rm -rf "$STAGE_DIR/postgresql"
install -d -m 0755 "$STAGE_DIR/postgresql/bin" "$STAGE_DIR/postgresql/lib" "$STAGE_DIR/postgresql/share"
for b in postgres initdb pg_ctl pg_controldata pg_isready psql createdb createuser; do
  [[ -x "$tmp/bin/$b" ]] && install -m 0755 "$tmp/bin/$b" "$STAGE_DIR/postgresql/bin/"
done
cd "$tmp/syslib"
ln -sf libpq.so.5.13 libpq.so.5
ln -sf libldap_r-2.4.so.2.10.10 libldap_r-2.4.so.2
ln -sf libicui18n.so.63.1 libicui18n.so.63
ln -sf libicuuc.so.63.1 libicuuc.so.63
ln -sf libicudata.so.63.1 libicudata.so.63
cd - >/dev/null
cp -a "$tmp/syslib/"* "$STAGE_DIR/postgresql/lib/"
if compgen -G "$tmp/pluglib/*.so" >/dev/null; then cp -a "$tmp/pluglib/"*.so "$STAGE_DIR/postgresql/lib/"; fi
cp -aL "$tmp/pghome/13/." "$STAGE_DIR/postgresql/share/"
rm -rf "$tmp"
"$CHANNEL_DIR/scripts/check-elf.sh" "$STAGE_DIR/postgresql/bin/postgres"
"$CHANNEL_DIR/scripts/check-elf.sh" "$STAGE_DIR/postgresql/bin/initdb"
printf '%s\n' "$POSTGRES_VERSION" >"$STAGE_DIR/postgresql/POSTGRES_VERSION"
