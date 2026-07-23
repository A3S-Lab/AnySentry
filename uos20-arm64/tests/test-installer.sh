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
grep -Fq 'anysentry-redis.service' "$INSTALLER" || fail "installer does not manage Redis"
grep -Fq 'anysentry-fast-judge.service' "$INSTALLER" || fail "installer does not manage the fast judgment worker"
grep -Fq 'anysentry-l3-worker.service' "$INSTALLER" || fail "installer does not manage the L3 worker"
grep -Fq 'wait_for_redis' "$INSTALLER" || fail "installer does not wait for Redis readiness"
grep -Fq 'validate_redis_runtime' "$INSTALLER" || fail "installer preflight does not exercise the Redis startup checks"
grep -Fq -- '--port 0' "$INSTALLER" || fail "Redis preflight does not disable network listeners"
grep -Fq 'observer/observer-agent-attribution.js' "$INSTALLER" || fail "installer does not require agent attribution runtime"
grep -Fq 'observer/observer-event-dedup.js' "$INSTALLER" || fail "installer does not require event dedup runtime"
wait_for_url_body=$(sed -n '/^wait_for_url()/,/^}/p' "$INSTALLER")
grep -Fq '2>/dev/null' <<<"$wait_for_url_body" || fail "API readiness retries expose transient curl errors"
grep -Fq 'redis-cli' "$VERIFY" || fail "verifier does not check Redis readiness"
if grep -Fq 'fail "only $probe_count' "$VERIFY"; then
  fail "verifier treats journal formatting as an activation failure"
fi
grep -Fq 'attachedProbes' "$VERIFY" || fail "verifier does not inspect runtime probe metadata"
grep -Fq 'attached_probes -ge 8' "$VERIFY" || fail "verifier does not require eight runtime probes"
grep -Fq 'wait_for_collector_health' "$VERIFY" || fail "verifier does not wait for collector health visibility"
collector_wait_body=$(sed -n '/^wait_for_collector_health()/,/^}/p' "$VERIFY")
grep -Fq 'seq 1 60' <<<"$collector_wait_body" || fail "collector health wait is shorter than 60 seconds"
grep -Fq 'Collector health response:' "$VERIFY" || fail "collector health failure omits the raw API response"
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
