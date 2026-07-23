#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
REVIEW=$ROOT/UOS20_ARM64_DEPLOYMENT_REVIEW.md
DEV=$ROOT/uos20-arm64/README.md
DEPLOY=$ROOT/uos20-arm64/package/DEPLOYMENT.md

fail() { echo "FAIL $*" >&2; exit 1; }

for file in "$REVIEW" "$DEV" "$DEPLOY"; do
  [[ -s "$file" ]] || fail "documentation is missing: $file"
done

for term in 'Kunpeng 920' 'glibc 2.28' '65536' '4.19.90' '0x0004135a' 'SIGILL' 'HTTP 201' '100000' 'FileAccess'; do
  grep -Fq "$term" "$REVIEW" || fail "review omits $term"
done

for term in 'current HEAD' '--component' '--prepare-only' 'PROVENANCE' 'patch'; do
  grep -Fq -- "$term" "$DEV" || fail "developer guide omits $term"
done

for term in './install.sh --check' './install.sh' '/opt/anysentry/verify.sh' 'journalctl' 'rollback' '29653' 'L2' 'L3' 'inspect-host.sh'; do
  grep -Fq "$term" "$DEPLOY" || fail "deployment guide omits $term"
done

echo "PASS documentation contract"

