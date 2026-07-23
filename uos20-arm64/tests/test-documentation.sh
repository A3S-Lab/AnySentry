#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
REVIEW=$ROOT/UOS20_ARM64_DEPLOYMENT_REVIEW.md
DEV=$ROOT/uos20-arm64/README.md
DEPLOY=$ROOT/uos20-arm64/package/DEPLOYMENT.md
INSTALL_GUIDE=$ROOT/uos20-arm64/package/AnySentry部署手册.md
USAGE_GUIDE=$ROOT/uos20-arm64/package/AnySentry使用手册.md
SCRIPT_GUIDE=$ROOT/uos20-arm64/package/AnySentry脚本说明.md

fail() { echo "FAIL $*" >&2; exit 1; }

for file in "$REVIEW" "$DEV" "$DEPLOY" "$INSTALL_GUIDE" "$USAGE_GUIDE" "$SCRIPT_GUIDE"; do
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
  grep -Fq "$term" "$INSTALL_GUIDE" || fail "deployment guide omits $term"
done

for term in 'http://<服务器可达IP>:29653/' '同网段浏览器' 'Observer' 'Agent' 'Source' 'Collector' 'acceptedEvents' 'RUN_HEALTH_SMOKE.sh --safe'; do
  grep -Fq "$term" "$USAGE_GUIDE" || fail "usage guide omits $term"
done

for term in 'install.sh' 'verify.sh' 'RUN_HEALTH_SMOKE.sh' 'inspect-host.sh' 'RUN_DIAGNOSTICS.sh' 'RUN_PASSIVE_CHECK.sh' 'uninstall.sh' 'wait-clickhouse.sh' 'run-l3-worker.sh'; do
  grep -Fq "$term" "$SCRIPT_GUIDE" || fail "script guide omits $term"
done

for file in "$INSTALL_GUIDE" "$USAGE_GUIDE" "$SCRIPT_GUIDE"; do
  for link in './AnySentry部署手册.md' './AnySentry使用手册.md' './AnySentry脚本说明.md'; do
    grep -Fq "$link" "$file" || fail "document navigation is incomplete: $file -> $link"
  done
done

if grep -nE '双杨|客户|运维人员|运维|部署人员|root 用户' \
  "$DEPLOY" "$INSTALL_GUIDE" "$USAGE_GUIDE" "$SCRIPT_GUIDE"; then
  fail "published documentation contains a name or role-specific wording"
fi

echo "PASS documentation contract"
