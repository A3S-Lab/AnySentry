#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
BUILD=$ROOT/uos20-arm64/build.sh
OBSERVER_REPO=${OBSERVER_REPO:-/home/chensicheng/.config/superpowers/worktrees/Observer/uos20-arm64-0.2.0}
SENTRY_REPO=${SENTRY_REPO:-/home/chensicheng/a3s/security/Sentry}

fail() { echo "FAIL $*" >&2; exit 1; }

[[ -x "$BUILD" ]] || fail "build.sh is not executable"
help=$($BUILD --help)
grep -Fq -- '--component' <<<"$help" || fail "help omits --component"
grep -Fq -- '--version' <<<"$help" || fail "help omits --version"
grep -Fq -- '--prepare-only' <<<"$help" || fail "help omits --prepare-only"
grep -Fq 'assemble-release.sh' "$BUILD" || fail "assemble component is not mapped to the release assembler"

if "$BUILD" --component invalid >/tmp/a3s-uos-build-invalid.out 2>&1; then
  fail "invalid component was accepted"
fi
grep -Fq 'unsupported component' /tmp/a3s-uos-build-invalid.out || fail "invalid component error is unclear"

for repo in "$ROOT" "$OBSERVER_REPO" "$SENTRY_REPO"; do
  git -C "$repo" diff --quiet || fail "$repo working tree is dirty before source preparation"
  git -C "$repo" diff --cached --quiet || fail "$repo index is dirty before source preparation"
done

tmp=$(mktemp -d)
trap 'rm -rf "$tmp" /tmp/a3s-uos-build-invalid.out' EXIT
ANYSENTRY_REPO="$ROOT" OBSERVER_REPO="$OBSERVER_REPO" SENTRY_REPO="$SENTRY_REPO" \
  ANYSENTRY_BUILD_DIR="$tmp/build" ANYSENTRY_RELEASE_DIR="$tmp/release" \
  "$BUILD" --prepare-only --version test-current-head >"$tmp/output"

for repo in anysentry observer sentry; do
  [[ -d "$tmp/build/sources/$repo" ]] || fail "isolated $repo source was not prepared"
  [[ ! -e "$tmp/build/sources/$repo/.git" ]] || fail "$repo source contains upstream git metadata"
done
[[ -f "$tmp/build/sources/observer/a3s-observer-ebpf-legacy/src/probes.c" ]] ||
  fail "Observer integration does not contain the legacy probe"
grep -Fq 'legacy-kernel-4-19' "$tmp/build/sources/observer/a3s-observer-collector/Cargo.toml" ||
  fail "Observer integration does not contain the legacy feature"
grep -Fq 'policyFromEnvironment' "$tmp/build/sources/anysentry/apps/api/src/security-monitoring/policy-config.ts" ||
  fail "AnySentry integration does not contain the UOS policy environment"
grep -Fq 'kernel_version_code=0x0004135a' "$tmp/build/source-provenance.env" || fail "UOS BPF ABI metadata is missing"
grep -Fq 'ANYSENTRY_COMMIT=' "$tmp/build/source-provenance.env" || fail "AnySentry commit is missing"
grep -Fq 'OBSERVER_COMMIT=' "$tmp/build/source-provenance.env" || fail "Observer commit is missing"
grep -Fq 'SENTRY_COMMIT=' "$tmp/build/source-provenance.env" || fail "Sentry commit is missing"

for repo in "$ROOT" "$OBSERVER_REPO" "$SENTRY_REPO"; do
  git -C "$repo" diff --quiet || fail "$repo was modified by source preparation"
  git -C "$repo" diff --cached --quiet || fail "$repo index was modified by source preparation"
done

echo "PASS build interface and isolated integration source preparation"
