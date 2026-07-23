#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"
ensure_stage

for dir in app runtime native clickhouse observer l3 diagnostics; do [[ -d "$STAGE_DIR/$dir" ]] || die "staged component missing: $dir"; done

install -d -m 0755 "$STAGE_DIR/config" "$STAGE_DIR/systemd"
for file in config/anysentry.env.example config/clickhouse-config.xml config/clickhouse-users.xml; do install -m 0644 "$CHANNEL_DIR/package/$file" "$STAGE_DIR/$file"; done
for file in systemd/anysentry.service systemd/anysentry-clickhouse.service systemd/anysentry-observer.service; do install -m 0644 "$CHANNEL_DIR/package/$file" "$STAGE_DIR/$file"; done
install -m 0644 "$CHANNEL_DIR/package/DEPLOYMENT.md" "$STAGE_DIR/DEPLOYMENT.md"
install -m 0644 "$CHANNEL_DIR/package/DIAGNOSTICS.md" "$STAGE_DIR/diagnostics/DIAGNOSTICS.md"
for file in install.sh verify.sh inspect-host.sh wait-clickhouse.sh uninstall.sh; do install -m 0755 "$CHANNEL_DIR/package/$file" "$STAGE_DIR/$file"; done
install -m 0755 "$CHANNEL_DIR/package/provision-observer.mjs" "$STAGE_DIR/provision-observer.mjs"

source "$BUILD_DIR/source-provenance.env"
{
  printf 'RELEASE_VERSION=%s\n' "$RELEASE_VERSION"
  printf 'TARGET_OS=UnionTech_OS_Server_20_Enterprise\nTARGET_ARCH=aarch64\nTARGET_GLIBC=%s\nTARGET_PAGE_SIZE=%s\n' "$TARGET_GLIBC" "$TARGET_PAGE_SIZE"
  printf 'TARGET_KERNEL_RELEASE=%s\nBPF_KERNEL_VERSION=%s\nBPF_KERNEL_VERSION_CODE=%s\n' "$UOS_KERNEL_RELEASE" "$UOS_BPF_KERNEL_VERSION" "$UOS_BPF_KERNEL_VERSION_CODE"
  printf 'ANYSENTRY_COMMIT=%s\nOBSERVER_COMMIT=%s\nSENTRY_COMMIT=%s\n' "$ANYSENTRY_COMMIT" "$OBSERVER_COMMIT" "$SENTRY_COMMIT"
  printf 'CLICKHOUSE_VERSION=%s\nCLICKHOUSE_PROFILE=%s\nNODE_VERSION=%s\nA3S_CODE_VERSION=%s\n' "$CLICKHOUSE_VERSION" "$CLICKHOUSE_PROFILE" "$NODE_VERSION" "$CODE_VERSION"
} > "$STAGE_DIR/VERSION"
{
  cat "$STAGE_DIR/VERSION"
  printf 'ANYSENTRY_PATCH_SHA256=%s\nOBSERVER_PATCH_SHA256=%s\n' "$ANYSENTRY_PATCH_SHA256" "$OBSERVER_PATCH_SHA256"
  printf 'SOURCE_DATE_EPOCH=%s\nBUILT_AT_UTC=%s\n' "$(git -C "$SECURITY_ROOT/AnySentry" log -1 --format=%ct)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "$STAGE_DIR/PROVENANCE"

(cd "$STAGE_DIR" && find . -type f ! -name manifest.sha256 -print0 | LC_ALL=C sort -z | xargs -0 sha256sum > manifest.sha256 && sha256sum --check --quiet manifest.sha256)
"$CHANNEL_DIR/scripts/verify-release.sh" "$STAGE_DIR"

mkdir -p "$RELEASE_DIR"
rm -rf "$RELEASE_DIR/$STAGE_NAME"
cp -a "$STAGE_DIR" "$RELEASE_DIR/$STAGE_NAME"
epoch=$(git -C "$SECURITY_ROOT/AnySentry" log -1 --format=%ct)
archive=$RELEASE_DIR/$STAGE_NAME.tar.gz
tar --sort=name --mtime="@$epoch" --owner=0 --group=0 --numeric-owner -C "$RELEASE_DIR" -czf "$archive" "$STAGE_NAME"
(cd "$RELEASE_DIR" && sha256sum "$STAGE_NAME.tar.gz" > "$STAGE_NAME.tar.gz.sha256")
echo "Release archive: $archive"
echo "Checksum:       $archive.sha256"

