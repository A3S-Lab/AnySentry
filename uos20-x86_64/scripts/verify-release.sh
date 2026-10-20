#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source "$SCRIPT_DIR/../lib/common.sh"
release=${1:-${STAGE_DIR:-}}
[[ -d "$release" ]] || die "release directory not found: $release"

required=(
  app/dist/main.js app/web/index.html runtime/node/bin/node
  native/a3s-sentry.linux-x64-gnu.node clickhouse/bin/clickhouse
  redis/bin/redis-server redis/bin/redis-cli redis/etc/redis.conf
  java/bin/java kafka/bin/kafka-server-start.sh
  flink/bin/flink flink/usrlib/anysentry-flink-streaming.jar
  observer/bin/a3s-observer-collector observer/observer-forward.js
  observer/observer-agent-attribution.js observer/observer-agent-runtime-signatures.js
  observer/observer-agent-templates.js observer/observer-attribution-merge.js
  observer/observer-behavior-discovery.js observer/observer-capture-profile-control.js
  observer/observer-capture-profile-reporter.js observer/observer-classification-semantics.js
  observer/observer-cgroup-mounts.js observer/observer-docker-discovery.js observer/observer-durable-spool.js
  observer/observer-event-dedup.js observer/observer-file-aggregation.js
  observer/observer-filter-rule-publisher.js observer/observer-filter-rules.js
  observer/observer-infrastructure-policy.js observer/observer-infrastructure-roots.js
  observer/observer-infrastructure-rules.js observer/observer-launch-context.js
  observer/observer-pipeline-accounting.js observer/observer-priority-queue.js
  observer/observer-systemd-enrichment.js observer/observer-tls-agent-cgroups.js
  observer/observer-unified-filter-policy.js observer/observer-workload-filter.js
  observer/KERNEL_VERSION_CODE
  l3/l3-agent.mjs diagnostics/a3s-bpf-syscall-probe
  app/node_modules/@a3s-lab/code/index.linux-x64-gnu.node app/node_modules/@a3s-lab/code/zvec/libzvec_c_api.so
  install.sh verify.sh inspect-host.sh RUN_HEALTH_SMOKE.sh ACCEPTANCE_CHECK.sh FIELD_DIAGNOSTIC.sh collect-support-bundle.sh anysentry-data-cleanup.sh DEPLOYMENT.md
  AnySentry部署手册.md AnySentry使用手册.md AnySentry脚本说明.md 现场问题采集.md UOS现场诊断规则.md
  VERSION PROVENANCE manifest.sha256
)
for file in "${required[@]}"; do [[ -f "$release/$file" ]] || die "release file missing: $file"; done
[[ -x "$release/RUN_HEALTH_SMOKE.sh" ]] || die 'health smoke script is not executable'
[[ "$(cat "$release/observer/KERNEL_VERSION_CODE")" == "$UOS_BPF_KERNEL_VERSION_CODE" ]] || die 'Observer BPF kernel version code mismatch'
[[ "$(cat "$release/clickhouse/PROFILE")" == "$CLICKHOUSE_PROFILE" ]] || die 'ClickHouse profile mismatch'
grep -Fq 'src="/anysentry/static/' "$release/app/web/index.html" || die 'Web assets are not built for /anysentry'
(cd "$release/app" && node -e "const p=require('./node_modules/@a3s-lab/sentry/package.json'); if(p.version !== '$SENTRY_NPM_VERSION') process.exit(1)") ||
  die "staged Sentry npm module is not $SENTRY_NPM_VERSION"
(cd "$release" && sha256sum --check --quiet manifest.sha256) || die 'release manifest checksum failed'

elf_count=0
bpf_count=0
while IFS= read -r -d '' file; do
  if LANG=C readelf -h "$file" >/dev/null 2>&1; then
    machine=$(LANG=C readelf -h "$file" | awk -F: '/Machine:/ {sub(/^[[:space:]]+/, "", $2); print $2}')
    case "$machine" in
      'Advanced Micro Devices X86-64')
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
A3S_EXPECTED_BPF_CODE=$UOS_BPF_KERNEL_VERSION_CODE node "$SCRIPT_DIR/verify-legacy-bpf-object.mjs" "$release/observer/probes-legacy.o" >/dev/null
[[ -z "$(find "$release" -xtype l -print -quit)" ]] || die 'release contains dangling symlinks'
echo "PASS release contract: $elf_count x86-64 ELF files and $bpf_count verified BPF object: $release"
