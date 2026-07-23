#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source "$SCRIPT_DIR/../lib/common.sh"
release=${1:-${STAGE_DIR:-}}
[[ -d "$release" ]] || die "release directory not found: $release"

required=(
  app/dist/main.js app/web/index.html runtime/node/bin/node
  native/a3s-sentry.linux-arm64-gnu.node clickhouse/bin/clickhouse
  redis/bin/redis-server redis/bin/redis-cli redis/etc/redis.conf
  observer/bin/a3s-observer-collector observer/observer-forward.js
  observer/observer-agent-attribution.js observer/observer-event-dedup.js
  observer/KERNEL_VERSION_CODE
  l3/l3-agent.mjs diagnostics/a3s-bpf-syscall-probe
  install.sh verify.sh inspect-host.sh RUN_HEALTH_SMOKE.sh DEPLOYMENT.md
  AnySentry部署手册.md AnySentry使用手册.md
  VERSION PROVENANCE manifest.sha256
)
for file in "${required[@]}"; do [[ -f "$release/$file" ]] || die "release file missing: $file"; done
[[ -x "$release/RUN_HEALTH_SMOKE.sh" ]] || die 'health smoke script is not executable'
[[ "$(cat "$release/observer/KERNEL_VERSION_CODE")" == '0x0004135a' ]] || die 'Observer BPF kernel version code mismatch'
[[ "$(cat "$release/clickhouse/PROFILE")" == 'armv8.0-compat' ]] || die 'ClickHouse profile mismatch'
(cd "$release" && sha256sum --check --quiet manifest.sha256) || die 'release manifest checksum failed'

elf_count=0
bpf_count=0
while IFS= read -r -d '' file; do
  if LANG=C readelf -h "$file" >/dev/null 2>&1; then
    machine=$(LANG=C readelf -h "$file" | awk -F: '/Machine:/ {sub(/^[[:space:]]+/, "", $2); print $2}')
    case "$machine" in
      AArch64)
        "$SCRIPT_DIR/check-elf.sh" "$file" >/dev/null
        elf_count=$((elf_count + 1))
        ;;
      'Linux BPF')
        bpf_count=$((bpf_count + 1))
        ;;
      *) die "release contains unsupported ELF machine '$machine': $file" ;;
    esac
  fi
done < <(find "$release" -type f -print0)
((elf_count > 0)) || die 'release contains no ELF files'
((bpf_count == 1)) || die "release must contain exactly one Linux BPF object (found $bpf_count)"
node "$SCRIPT_DIR/verify-legacy-bpf-object.mjs" "$release/observer/probes-legacy.o" >/dev/null
[[ -z "$(find "$release" -xtype l -print -quit)" ]] || die 'release contains dangling symlinks'
echo "PASS release contract: $elf_count AArch64 ELF files and $bpf_count verified BPF object: $release"
