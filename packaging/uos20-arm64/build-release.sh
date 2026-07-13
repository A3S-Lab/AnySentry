#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT_DIR=$(cd "$SCRIPT_DIR/../.." && pwd)
RELEASE_DIR=${ANYSENTRY_RELEASE_DIR:-$ROOT_DIR/release}
BUILD_DIR=${ANYSENTRY_BUILD_DIR:-$ROOT_DIR/.build/uos20-arm64}
ANYSENTRY_VERSION=$(node -p "require('$ROOT_DIR/package.json').version")
RELEASE_VERSION=${ANYSENTRY_RELEASE_VERSION:-$ANYSENTRY_VERSION}
STAGE_NAME=anysentry-security-suite-${RELEASE_VERSION}-uos20-arm64
STAGE_DIR=$RELEASE_DIR/$STAGE_NAME
ARCHIVE_NAME=$STAGE_NAME.tar.gz
ARCHIVE_PATH=$RELEASE_DIR/$ARCHIVE_NAME
SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH:-$(git -C "$ROOT_DIR" log -1 --format=%ct)}
SOURCE_COMMIT=$(git -C "$ROOT_DIR" rev-parse HEAD)

if [[ -n "$(git -C "$ROOT_DIR" status --porcelain)" ]]; then
  echo "AnySentry source is dirty; commit reviewed changes before building a provenance release" >&2
  exit 1
fi

export ANYSENTRY_BUILD_DIR=$BUILD_DIR
export ANYSENTRY_STAGE_DIR=$STAGE_DIR
export SOURCE_DATE_EPOCH

rm -rf "$STAGE_DIR"
rm -f "$ARCHIVE_PATH" "$ARCHIVE_PATH.sha256"
mkdir -p "$STAGE_DIR" "$RELEASE_DIR"

"$SCRIPT_DIR/build-sentry.sh"
"$SCRIPT_DIR/build-node-runtime.sh"
"$SCRIPT_DIR/build-app.sh"
"$SCRIPT_DIR/build-clickhouse.sh"
"$SCRIPT_DIR/build-observer.sh"
"$SCRIPT_DIR/build-l3.sh"

install -d -m 0755 "$STAGE_DIR/config" "$STAGE_DIR/systemd"
install -m 0644 "$SCRIPT_DIR/config/anysentry.env.example" "$STAGE_DIR/config/anysentry.env.example"
install -m 0644 "$SCRIPT_DIR/config/clickhouse-config.xml" "$STAGE_DIR/config/clickhouse-config.xml"
install -m 0644 "$SCRIPT_DIR/config/clickhouse-users.xml" "$STAGE_DIR/config/clickhouse-users.xml"
install -m 0644 "$SCRIPT_DIR/systemd/anysentry.service" "$STAGE_DIR/systemd/anysentry.service"
install -m 0644 "$SCRIPT_DIR/systemd/anysentry-clickhouse.service" "$STAGE_DIR/systemd/anysentry-clickhouse.service"
install -m 0644 "$SCRIPT_DIR/systemd/anysentry-observer.service" "$STAGE_DIR/systemd/anysentry-observer.service"
install -m 0644 "$SCRIPT_DIR/README.md" "$STAGE_DIR/README.md"
install -m 0755 "$SCRIPT_DIR/install.sh" "$STAGE_DIR/install.sh"
install -m 0755 "$SCRIPT_DIR/uninstall.sh" "$STAGE_DIR/uninstall.sh"
install -m 0755 "$SCRIPT_DIR/verify.sh" "$STAGE_DIR/verify.sh"
install -m 0755 "$SCRIPT_DIR/wait-clickhouse.sh" "$STAGE_DIR/wait-clickhouse.sh"
install -m 0755 "$SCRIPT_DIR/provision-observer.mjs" "$STAGE_DIR/provision-observer.mjs"

elf_count=0
while IFS= read -r -d '' candidate; do
  if LANG=C readelf -h "$candidate" >/dev/null 2>&1; then
    "$SCRIPT_DIR/check-elf.sh" "$candidate"
    elf_count=$((elf_count + 1))
  fi
done < <(find "$STAGE_DIR" -type f -print0)
if (( elf_count == 0 )); then
  echo "No ELF files found in release stage" >&2
  exit 1
fi
echo "Verified $elf_count staged AArch64 ELF files"

source_dirty=false

{
  printf 'ANYSENTRY_VERSION=%s\n' "$ANYSENTRY_VERSION"
  printf 'RELEASE_VERSION=%s\n' "$RELEASE_VERSION"
  printf 'SOURCE_COMMIT=%s\n' "$SOURCE_COMMIT"
  printf 'SOURCE_DIRTY=%s\n' "$source_dirty"
  printf 'SOURCE_DATE_EPOCH=%s\n' "$SOURCE_DATE_EPOCH"
  printf 'TARGET_OS=UnionTech_OS_Server_20_Enterprise\n'
  printf 'TARGET_ARCH=aarch64\n'
  printf 'TARGET_GLIBC=2.28\n'
  printf 'TARGET_KERNEL=4.19_or_newer\n'
  printf 'NODE_VERSION=20.19.4\n'
  printf 'SENTRY_COMMIT=f9a2f1dae626a2427e21ac5541a8a9f69d744d4a\n'
  printf 'SENTRY_TARGET=aarch64-unknown-linux-gnu.2.28\n'
  printf 'ZIG_VERSION=0.14.1\n'
  printf 'CARGO_ZIGBUILD_VERSION=0.23.0\n'
  printf 'CLICKHOUSE_VERSION=24.8.14.39\n'
  printf 'CLICKHOUSE_IMAGE_DIGEST=sha256:ae7eea6602398611a8d34ed6cbee659cf355de907304a44e105cf8a97cfadd5a\n'
  printf 'OBSERVER_COMMIT=%s\n' "$(cat "$STAGE_DIR/observer/OBSERVER_COMMIT")"
  printf 'OBSERVER_TARGET=%s\n' "$(cat "$STAGE_DIR/observer/OBSERVER_TARGET")"
  printf 'OBSERVER_BACKEND=perf-kprobe-legacy\n'
  printf 'A3S_OBSERVER_INCLUDED=true\n'
  printf 'A3S_CODE_VERSION=%s\n' "$(cat "$STAGE_DIR/l3/CODE_VERSION")"
  printf 'A3S_CODE_ARM64_SHA256=%s\n' "$(cat "$STAGE_DIR/l3/CODE_ARM64_SHA256")"
} > "$STAGE_DIR/VERSION"

(
  cd "$STAGE_DIR"
  find . -type f ! -name manifest.sha256 -print0 | LC_ALL=C sort -z | xargs -0 sha256sum > manifest.sha256
  sha256sum --check manifest.sha256 >/dev/null
)

tar \
  --sort=name \
  --mtime="@$SOURCE_DATE_EPOCH" \
  --owner=0 \
  --group=0 \
  --numeric-owner \
  -C "$RELEASE_DIR" \
  -czf "$ARCHIVE_PATH" \
  "$STAGE_NAME"

(
  cd "$RELEASE_DIR"
  sha256sum "$ARCHIVE_NAME" > "$ARCHIVE_NAME.sha256"
)

echo "Release directory: $STAGE_DIR"
echo "Release archive:   $ARCHIVE_PATH"
echo "Archive checksum:  $ARCHIVE_PATH.sha256"
