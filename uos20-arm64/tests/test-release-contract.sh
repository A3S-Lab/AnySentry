#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
CHANNEL=$ROOT/uos20-arm64

fail() { echo "FAIL $*" >&2; exit 1; }

for script in \
  build.sh \
  scripts/build-sentry.sh scripts/build-node.sh scripts/build-app.sh scripts/build-redis.sh \
  scripts/build-clickhouse.sh scripts/build-observer.sh scripts/build-l3.sh \
  scripts/build-diagnostics.sh scripts/assemble-release.sh scripts/check-elf.sh \
  scripts/verify-release.sh; do
  [[ -x "$CHANNEL/$script" ]] || fail "missing executable $script"
done

for file in \
  package/install.sh package/verify.sh package/inspect-host.sh package/DEPLOYMENT.md \
  package/provision-observer.mjs package/wait-clickhouse.sh package/uninstall.sh \
  package/config/anysentry.env.example package/config/clickhouse-config.xml \
  package/config/clickhouse-users.xml package/config/redis.conf \
  package/systemd/anysentry.service package/systemd/anysentry-redis.service \
  package/systemd/anysentry-fast-judge.service package/systemd/anysentry-l3-worker.service \
  package/systemd/anysentry-clickhouse.service package/systemd/anysentry-observer.service; do
  [[ -f "$CHANNEL/$file" ]] || fail "missing package contract file $file"
done

grep -Fq '/var/lib/anysentry/clickhouse/' "$CHANNEL/package/systemd/anysentry-observer.service" || fail "ClickHouse self-noise filter is missing"
grep -Fq '/var/lib/anysentry/redis/' "$CHANNEL/package/systemd/anysentry-observer.service" || fail "Redis self-noise filter is missing"
grep -Fq 'worker-main.js' "$CHANNEL/package/systemd/anysentry-fast-judge.service" || fail "fast worker entrypoint is missing"
grep -Fq 'ANYSENTRY_WORKER_ROLE=l3' "$CHANNEL/package/systemd/anysentry-l3-worker.service" || fail "L3 worker role is missing"
grep -Fq 'msgpackr-extract-linux-x64' "$CHANNEL/scripts/build-app.sh" || fail "app builder does not remove the host msgpackr native package"
grep -Fq 'manifest.sha256' "$CHANNEL/scripts/assemble-release.sh" || fail "release manifest is not generated"
grep -Fq 'PROVENANCE' "$CHANNEL/scripts/assemble-release.sh" || fail "release provenance is not generated"
grep -Fq '0x0004135a' "$CHANNEL/scripts/verify-release.sh" || fail "release verifier does not enforce UOS BPF ABI"
grep -Fq "'Linux BPF'" "$CHANNEL/scripts/verify-release.sh" || fail "release verifier does not recognize the legacy BPF object"

echo "PASS release file and metadata contract"
