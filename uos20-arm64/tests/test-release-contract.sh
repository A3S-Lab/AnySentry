#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
CHANNEL=$ROOT/uos20-arm64

fail() { echo "FAIL $*" >&2; exit 1; }

for script in \
  build.sh \
  scripts/build-sentry.sh scripts/build-node.sh scripts/build-app.sh scripts/build-redis.sh \
  scripts/build-clickhouse.sh scripts/build-observer.sh scripts/build-l3.sh \
  scripts/build-java.sh scripts/build-kafka.sh scripts/build-flink.sh \
  scripts/build-diagnostics.sh scripts/assemble-release.sh scripts/check-elf.sh \
  scripts/verify-release.sh; do
  [[ -x "$CHANNEL/$script" ]] || fail "missing executable $script"
done

for file in \
  package/install.sh package/verify.sh package/inspect-host.sh package/RUN_HEALTH_SMOKE.sh package/ACCEPTANCE_CHECK.sh package/FIELD_DIAGNOSTIC.sh package/collect-support-bundle.sh package/anysentry-data-cleanup.sh package/DEPLOYMENT.md \
  package/AnySentry部署手册.md package/AnySentry使用手册.md package/AnySentry脚本说明.md package/现场问题采集.md package/UOS现场诊断规则.md \
  package/provision-observer.mjs package/wait-clickhouse.sh package/uninstall.sh \
  package/config/anysentry.env.example package/config/clickhouse-config.xml \
  package/config/clickhouse-users.xml package/config/redis.conf \
  package/config/kafka-server.properties package/config/flink-config.yaml \
  package/systemd/anysentry.service package/systemd/anysentry-redis.service \
  package/systemd/anysentry-kafka.service package/systemd/anysentry-kafka-init.service \
  package/systemd/anysentry-flink-jobmanager.service package/systemd/anysentry-flink-taskmanager.service \
  package/systemd/anysentry-flink-job.service package/systemd/anysentry-stream-worker.service \
  package/systemd/anysentry-composite-judge.service package/systemd/anysentry-supply-chain.service \
  package/systemd/anysentry-fast-judge.service package/systemd/anysentry-l3-worker.service \
  package/systemd/anysentry-clickhouse.service package/systemd/anysentry-observer.service; do
  [[ -f "$CHANNEL/$file" ]] || fail "missing package contract file $file"
done

grep -Fq '/var/lib/anysentry/clickhouse/' "$CHANNEL/package/systemd/anysentry-observer.service" || fail "ClickHouse self-noise filter is missing"
grep -Fq '/var/lib/anysentry/redis/' "$CHANNEL/package/systemd/anysentry-observer.service" || fail "Redis self-noise filter is missing"
grep -Fq 'worker-main.js' "$CHANNEL/package/systemd/anysentry-fast-judge.service" || fail "fast worker entrypoint is missing"
grep -Fq 'ANYSENTRY_WORKER_ROLE=l3' "$CHANNEL/package/systemd/anysentry-l3-worker.service" || fail "L3 worker role is missing"
grep -Fq 'ignore-warnings ARM64-COW-BUG' "$CHANNEL/package/config/redis.conf" || fail "Redis does not acknowledge the verified UOS ARM64 COW bug"
grep -Fq 'save ""' "$CHANNEL/package/config/redis.conf" || fail "Redis background RDB persistence is not disabled for the affected ARM64 kernel"
grep -Fq 'appendonly no' "$CHANNEL/package/config/redis.conf" || fail "Redis AOF persistence is not disabled for the affected ARM64 kernel"
if grep -Fqx 'appendonly yes' "$CHANNEL/package/config/redis.conf"; then
  fail "Redis AOF persistence is unsafe on the affected ARM64 kernel"
fi
grep -Fq 'msgpackr-extract-linux-x64' "$CHANNEL/scripts/build-app.sh" || fail "app builder does not remove the host msgpackr native package"
grep -Fq 'STAGE_DIR/app/node_modules/@a3s-lab/code' "$CHANNEL/scripts/build-l3.sh" || fail "L3 component cannot resume from the staged app"
grep -Fq 'manifest.sha256' "$CHANNEL/scripts/assemble-release.sh" || fail "release manifest is not generated"
grep -Fq 'PROVENANCE' "$CHANNEL/scripts/assemble-release.sh" || fail "release provenance is not generated"
grep -Fq 'observer-agent-attribution.js' "$CHANNEL/scripts/build-observer.sh" || fail "observer builder omits agent attribution runtime"
grep -Fq 'observer-event-dedup.js' "$CHANNEL/scripts/build-observer.sh" || fail "observer builder omits event dedup runtime"
grep -Fq 'observer-priority-queue.js' "$CHANNEL/scripts/build-observer.sh" || fail "observer builder omits priority queue runtime"
grep -Fq 'PUBLIC_BASE_PATH=/anysentry' "$CHANNEL/scripts/build-app.sh" || fail "app builder omits /anysentry base path"
grep -Fq 'KAFKA_VERSION=4.1.1' "$CHANNEL/versions.env" || fail "Kafka version is not locked"
grep -Fq 'FLINK_VERSION=2.2.1' "$CHANNEL/versions.env" || fail "Flink version is not locked"
grep -Fq 'SENTRY_NPM_VERSION=0.3.0' "$CHANNEL/versions.env" || fail "Sentry npm version is not locked"
grep -Fq 'observer/observer-agent-attribution.js' "$CHANNEL/scripts/verify-release.sh" || fail "release verifier does not require agent attribution runtime"
grep -Fq 'observer/observer-event-dedup.js' "$CHANNEL/scripts/verify-release.sh" || fail "release verifier does not require event dedup runtime"
grep -Fq 'AnySentry部署手册.md' "$CHANNEL/scripts/assemble-release.sh" || fail "assembler omits the deployment guide"
grep -Fq 'AnySentry使用手册.md' "$CHANNEL/scripts/assemble-release.sh" || fail "assembler omits the usage guide"
grep -Fq 'AnySentry脚本说明.md' "$CHANNEL/scripts/assemble-release.sh" || fail "assembler omits the script guide"
grep -Fq 'AnySentry部署手册.md' "$CHANNEL/scripts/verify-release.sh" || fail "release verifier omits the deployment guide"
grep -Fq 'AnySentry使用手册.md' "$CHANNEL/scripts/verify-release.sh" || fail "release verifier omits the usage guide"
grep -Fq 'AnySentry脚本说明.md' "$CHANNEL/scripts/verify-release.sh" || fail "release verifier omits the script guide"
grep -Fq 'RUN_HEALTH_SMOKE.sh' "$CHANNEL/scripts/assemble-release.sh" || fail "assembler omits the health smoke script"
grep -Fq 'RUN_HEALTH_SMOKE.sh' "$CHANNEL/scripts/verify-release.sh" || fail "release verifier omits the health smoke script"
grep -Fq 'ACCEPTANCE_CHECK.sh' "$CHANNEL/scripts/assemble-release.sh" || fail "assembler omits the acceptance check script"
grep -Fq 'ACCEPTANCE_CHECK.sh' "$CHANNEL/scripts/verify-release.sh" || fail "release verifier omits the acceptance check script"
grep -Fq 'FIELD_DIAGNOSTIC.sh' "$CHANNEL/scripts/assemble-release.sh" || fail "assembler omits the field diagnostic script"
grep -Fq 'FIELD_DIAGNOSTIC.sh' "$CHANNEL/scripts/verify-release.sh" || fail "release verifier omits the field diagnostic script"
grep -Fq 'anysentry-data-cleanup.sh' "$CHANNEL/scripts/assemble-release.sh" || fail "assembler omits the data cleanup script"
grep -Fq 'anysentry-data-cleanup.sh' "$CHANNEL/scripts/verify-release.sh" || fail "release verifier omits the data cleanup script"
grep -Fq 'UOS现场诊断规则.md' "$CHANNEL/scripts/assemble-release.sh" || fail "assembler omits the UOS diagnostic rules"
grep -Fq 'UOS现场诊断规则.md' "$CHANNEL/scripts/verify-release.sh" || fail "release verifier omits the UOS diagnostic rules"
grep -Fq 'drop_inert_observer_keys' "$CHANNEL/package/install.sh" || fail "installer does not drop inert observer keys"
grep -Fq 'collect-support-bundle.sh' "$CHANNEL/scripts/assemble-release.sh" || fail "assembler omits the support bundle script"
grep -Fq '现场问题采集.md' "$CHANNEL/scripts/assemble-release.sh" || fail "assembler omits the field collection guide"
grep -Fq 'ANYSENTRY_STREAMING=on' "$CHANNEL/package/config/anysentry.env.example" || fail "streaming is not enabled in the release environment"
grep -Fq 'ANYSENTRY_ASYNC_JUDGE=on' "$CHANNEL/package/config/anysentry.env.example" || fail "async judgment is not enabled in the release environment"
grep -Fq 'FORWARD_RETAIN_UNKNOWN=false' "$CHANNEL/package/config/anysentry.env.example" || fail "unknown events are retained"
grep -Fq 'ANYSENTRY_UNKNOWN_RETENTION_MODE=enforce' "$CHANNEL/package/config/anysentry.env.example" || fail "unknown retention is not enforced"
grep -Fq 'A3S_OBSERVER_FILE_UNKNOWN_POLICY=drop' "$CHANNEL/package/config/anysentry.env.example" || fail "unknown file events are not dropped"
grep -Fq 'start_unit anysentry-fast-judge.service fast-judge' "$CHANNEL/package/install.sh" || fail "installer does not enable fast-judge"
grep -Fq 'start_unit anysentry-composite-judge.service composite-judge' "$CHANNEL/package/install.sh" || fail "installer does not enable composite-judge"
grep -Fq 'start_unit anysentry-stream-worker.service stream-worker' "$CHANNEL/package/install.sh" || fail "installer does not enable stream-worker"
grep -Fq 'start_unit anysentry-flink-job.service flink-job' "$CHANNEL/package/install.sh" || fail "installer does not enable the Flink job"
grep -Fq 'export LOG_DIR=$log_dir' "$CHANNEL/package/run-kafka.sh" || fail "Kafka GC logs still default to the read-only install tree"
grep -Fq 'export FLINK_LOG_DIR=$log_dir' "$CHANNEL/package/run-flink.sh" || fail "Flink logs still default to the read-only install tree"
grep -Fq 'log_dir=/var/lib/anysentry/kafka-logs' "$CHANNEL/package/run-kafka.sh" || fail "Kafka log directory is inside the topic data directory"
grep -Fq '0x0004135a' "$CHANNEL/scripts/verify-release.sh" || fail "release verifier does not enforce UOS BPF ABI"
grep -Fq "'Linux BPF'" "$CHANNEL/scripts/verify-release.sh" || fail "release verifier does not recognize the legacy BPF object"
grep -Fq 'maxmemory 4gb' "$CHANNEL/package/config/redis.conf" || fail "Redis queue memory is not capped at 4 GiB"
grep -Fq 'MemoryHigh=32G' "$CHANNEL/package/systemd/anysentry-clickhouse.service" || fail "ClickHouse MemoryHigh is not configured"
grep -Fq 'MemoryMax=40G' "$CHANNEL/package/systemd/anysentry-clickhouse.service" || fail "ClickHouse MemoryMax is not configured"
grep -Fq '<trace_log remove="remove"/>' "$CHANNEL/package/config/clickhouse-config.xml" || fail "ClickHouse profiler logs are not disabled"
grep -Fq '<asynchronous_metric_log><ttl>event_date + INTERVAL 3 DAY DELETE</ttl></asynchronous_metric_log>' "$CHANNEL/package/config/clickhouse-config.xml" || fail "ClickHouse system logs are not TTL-bounded"
grep -Fq '<old_parts_lifetime>120</old_parts_lifetime>' "$CHANNEL/package/config/clickhouse-config.xml" || fail "ClickHouse dead-part lifetime is not bounded"
if grep -Fq '<opentelemetry_span_log><ttl>' "$CHANNEL/package/config/clickhouse-config.xml"; then
  fail "opentelemetry_span_log carries a sibling ttl (base config has a custom engine; ClickHouse rejects it at startup)"
fi
grep -Fq '<max_server_memory_usage>34359738368</max_server_memory_usage>' "$CHANNEL/package/config/clickhouse-config.xml" || fail "ClickHouse server memory is not raised to 32 GiB"
grep -Fq 'NODE_OPTIONS=--max-old-space-size=4096' "$CHANNEL/package/systemd/anysentry.service" || fail "API Node heap is not configured"
grep -Fq 'NODE_OPTIONS=--max-old-space-size=2048' "$CHANNEL/package/systemd/anysentry-fast-judge.service" || fail "fast judge Node heap is not configured"
grep -Fq 'NODE_OPTIONS=--max-old-space-size=4096' "$CHANNEL/package/systemd/anysentry-l3-worker.service" || fail "L3 Node heap is not configured"
grep -Fq 'NODE_OPTIONS=--max-old-space-size=1024' "$CHANNEL/package/systemd/anysentry-observer.service" || fail "Observer forwarder Node heap is not configured"
grep -Fq 'FORWARD_HTTP_TIMEOUT_MS=20000' "$CHANNEL/package/systemd/anysentry-observer.service" || fail "Observer HTTP timeout hotfix is not persisted"
grep -Fq 'A3S_OBSERVER_PERF_RING_PAGES=64' "$CHANNEL/package/systemd/anysentry-observer.service" || fail "Observer perf ring is not enlarged for 64K-page SSE bursts"
if grep -nE 'sleep [0-9]+[A-Za-z"]' "$CHANNEL/package/ACCEPTANCE_CHECK.sh" | grep -q .; then
  fail "ACCEPTANCE_CHECK.sh has a mangled sleep line (missing newline; syntax check cannot catch this)"
fi
grep -Fq 'FORWARD_HTTP_TIMEOUT_MS' "$ROOT/scripts/observer-forward.js" || fail "Observer forwarder does not read the HTTP timeout"
grep -Fq '[observer-forward] heartbeat delivery failed' "$ROOT/scripts/observer-forward.js" || fail "Observer forwarder does not log HTTP failure details"

echo "PASS release file and metadata contract"
