#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
REVIEW=$ROOT/UOS20_ARM64_DEPLOYMENT_REVIEW.md
DEV=$ROOT/uos20-arm64/README.md
DEPLOY=$ROOT/uos20-arm64/package/DEPLOYMENT.md
CUSTOMER_DEPLOY=$ROOT/uos20-arm64/package/AnySentry部署手册.md
CUSTOMER_USER=$ROOT/uos20-arm64/package/AnySentry使用手册.md

fail() { echo "FAIL $*" >&2; exit 1; }

for file in "$REVIEW" "$DEV" "$DEPLOY" "$CUSTOMER_DEPLOY" "$CUSTOMER_USER"; do
  [[ -s "$file" ]] || fail "documentation is missing: $file"
done

for term in 'Kunpeng 920' 'glibc 2.28' '65536' '4.19.90' '0x0004135a' 'SIGILL' 'HTTP 201' '100000' 'FileAccess'; do
  grep -Fq "$term" "$REVIEW" || fail "review omits $term"
done

for term in 'integration branch' '--component' '--prepare-only' 'PROVENANCE' 'direct merge'; do
  grep -Fq -- "$term" "$DEV" || fail "developer guide omits $term"
done

for term in './install.sh --check' './install.sh' '/opt/anysentry/verify.sh' 'journalctl' 'rollback' '29653' 'L2' 'L3' 'inspect-host.sh' 'ARM64-COW-BUG' '临时队列'; do
  grep -Fq "$term" "$DEPLOY" || fail "deployment guide omits $term"
done

for term in 'sha256sum --check' './install.sh --check' './install.sh' '/var/log/anysentry/install/0.2.0-compat8' '/opt/anysentry/verify.sh' 'RUN_HEALTH_SMOKE.sh --safe'; do
  grep -Fq "$term" "$CUSTOMER_DEPLOY" || fail "customer deployment guide omits $term"
done

for term in 'http://<服务器IP>:29653/' '内置浏览器' 'Observer' 'Agent' 'Source' 'Collector' 'acceptedEvents' 'RUN_HEALTH_SMOKE.sh --safe'; do
  grep -Fq "$term" "$CUSTOMER_USER" || fail "customer user guide omits $term"
done

echo "PASS documentation contract"
