#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
INSTALLER=$ROOT/uos20-arm64/package/install.sh
VERIFY=$ROOT/uos20-arm64/package/verify.sh

fail() { echo "FAIL $*" >&2; exit 1; }

[[ -x "$INSTALLER" ]] || fail "installer is not executable"
[[ -x "$VERIFY" ]] || fail "runtime verifier is not executable"

grep -Fq -- '--check' "$INSTALLER" || fail "installer has no read-only check mode"
grep -Fq 'rollback' "$INSTALLER" || fail "installer has no rollback path"
activate_line=$(grep -n 'ACTIVATED=1' "$INSTALLER" | tail -n1 | cut -d: -f1)
move_line=$(grep -n 'mv "$INSTALL_ROOT" "$ROLLBACK_ROOT"' "$INSTALLER" | cut -d: -f1)
[[ -n $activate_line && -n $move_line && $activate_line -lt $move_line ]] ||
  fail "rollback protection does not precede program replacement"
grep -Fq 'ANYSENTRY_INSTALL_ROOT' "$INSTALLER" || fail "installer paths are not testable"
grep -Fq 'merge_environment' "$INSTALLER" || fail "upgrade config merge is missing"
grep -Fq 'manifest.sha256' "$INSTALLER" || fail "installer does not verify manifest"
grep -Fq 'acceptedEvents' "$VERIFY" || fail "verifier does not inspect Source acceptance"
grep -Fq 'outputDropped' "$VERIFY" || fail "verifier does not inspect forwarder drops"
grep -Fq 'errorCount' "$VERIFY" || fail "verifier does not inspect forwarder errors"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/package/config" "$tmp/package/payload"
cp "$INSTALLER" "$tmp/package/install.sh"
printf '%s\n' 'EXISTING=value' > "$tmp/existing.env"
printf '%s\n' 'EXISTING=default' 'NEW_KEY=new-default' > "$tmp/template.env"

ANYSENTRY_INSTALLER_LIB=1 bash -c '
  source "$1"
  ENV_FILE="$2"
  merge_environment "$3"
' _ "$tmp/package/install.sh" "$tmp/existing.env" "$tmp/template.env"

grep -Fxq 'EXISTING=value' "$tmp/existing.env" || fail "existing config was overwritten"
grep -Fxq 'NEW_KEY=new-default' "$tmp/existing.env" || fail "new config key was not appended"

echo "PASS installer transaction and preservation contract"
