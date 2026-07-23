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
grep -Fq 'normalize_environment' "$INSTALLER" || fail "installer does not normalize duplicate environment keys"
grep -Fq 'validate_collector_id' "$INSTALLER" || fail "installer does not validate the collector ID"
grep -Fq '0.2.0-compat8' "$INSTALLER" || fail "installer does not define the compat8 diagnostic directory"
grep -Fq '/var/log/anysentry/install' "$INSTALLER" || fail "installer does not persist installation diagnostics"
grep -Fq '/tmp/anysentry-install-' "$INSTALLER" || fail "installer does not publish the temporary diagnostic link"
grep -Fq 'capture_diagnostics' "$INSTALLER" || fail "installer does not capture activation and rollback diagnostics"
grep -Fq 'anysentry-observer.service) name=observer' "$INSTALLER" || fail "installer does not map the Observer journal"
grep -Fq 'journal-$name.log' "$INSTALLER" || fail "installer does not retain service journal output"
grep -Fq 'vm.overcommit_memory=1' "$INSTALLER" || fail "installer does not persist the Redis overcommit requirement"
if grep -Fq 'Function("data"' "$VERIFY"; then
  fail "verifier still executes dynamic JavaScript expressions"
fi
grep -Fq 'collector_value' "$VERIFY" || fail "verifier does not parse collector fields with an explicit ID"

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

printf '%s\n' \
  'PORT=29653' \
  'A3S_OBSERVER_COLLECTOR_ID=A3S_OBSERVER_COLLECTOR_ID=obsolete' \
  'A3S_OBSERVER_COLLECTOR_ID=observer-customer-host' \
  'PORT=29654' \
  > "$tmp/duplicate.env"

ANYSENTRY_INSTALLER_LIB=1 bash -c '
  source "$1"
  ENV_FILE="$2"
  normalize_environment "$ENV_FILE"
  validate_collector_id "$ENV_FILE"
' _ "$tmp/package/install.sh" "$tmp/duplicate.env"

[[ $(grep -c '^A3S_OBSERVER_COLLECTOR_ID=' "$tmp/duplicate.env") == 1 ]] ||
  fail "collector ID duplicates were not removed"
grep -Fxq 'A3S_OBSERVER_COLLECTOR_ID=observer-customer-host' "$tmp/duplicate.env" ||
  fail "the last valid collector ID was not preserved"
[[ $(grep -c '^PORT=' "$tmp/duplicate.env") == 1 ]] ||
  fail "generic duplicate environment keys were not removed"
grep -Fxq 'PORT=29654' "$tmp/duplicate.env" || fail "the last PORT value was not preserved"

mkdir -p "$tmp/runtime-tmp"
ANYSENTRY_INSTALLER_LIB=1 bash -c '
  source "$1"
  LOG_DIR="$2/runtime-log"
  INSTALL_LOG_ROOT="$LOG_DIR/install/0.2.0-compat8"
  TEMP_INSTALL_LOG="$2/runtime-tmp/anysentry-install-0.2.0-compat8"
  initialize_install_logging
  set_stage installer-contract-test
  echo installer-log-marker
  write_install_summary 0
' _ "$tmp/package/install.sh" "$tmp"

[[ -L $tmp/runtime-tmp/anysentry-install-0.2.0-compat8 ]] ||
  fail "temporary diagnostic path is not a symlink"
grep -Fq installer-log-marker "$tmp/runtime-log/install/0.2.0-compat8/install.log" ||
  fail "installer output was not captured"
grep -Fq result=success "$tmp/runtime-log/install/0.2.0-compat8/summary.txt" ||
  fail "installation summary was not persisted"

mkdir -p "$tmp/verify-root/runtime/node/bin"
ln -s "$(command -v node)" "$tmp/verify-root/runtime/node/bin/node"
collector_json='{"data":{"items":[{"collectorId":"observer-customer-host","state":"healthy","attachedProbes":8,"outputDropped":0,"errorCount":0}]}}'
parsed=$(ANYSENTRY_VERIFY_LIB=1 ANYSENTRY_INSTALL_ROOT="$tmp/verify-root" \
  bash -c '
    source "$1"
    COLLECTOR_ID=observer-customer-host
    state=$(printf "%s" "$2" | collector_value state)
    probes=$(printf "%s" "$2" | collector_value attachedProbes)
    printf "%s,%s\n" "$state" "$probes"
  ' _ "$VERIFY" "$collector_json")
[[ $parsed == healthy,8 ]] || fail "collector parser returned '$parsed' instead of healthy,8"

echo "PASS installer transaction and preservation contract"
