#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const packagingRoot = path.join(repoRoot, 'packaging/uos20-arm64');

let failures = 0;

function pass(message) {
  console.log(`PASS ${message}`);
}

function fail(message, detail) {
  failures += 1;
  console.error(`FAIL ${message}${detail ? `: ${detail}` : ''}`);
}

function requireFile(relativePath) {
  const absolutePath = path.join(repoRoot, relativePath);
  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
    fail(`required file exists`, relativePath);
    return '';
  }
  pass(`required file exists: ${relativePath}`);
  return fs.readFileSync(absolutePath, 'utf8');
}

function requireText(source, pattern, message) {
  if (pattern.test(source)) pass(message);
  else fail(message, pattern.toString());
}

console.log('AnySentry UOS 20 ARM64 offline package verification');

const requiredFiles = [
  'packaging/uos20-arm64/build-release.sh',
  'packaging/uos20-arm64/build-sentry.sh',
  'packaging/uos20-arm64/build-app.sh',
  'packaging/uos20-arm64/build-node-runtime.sh',
  'packaging/uos20-arm64/build-clickhouse.sh',
  'packaging/uos20-arm64/build-observer.sh',
  'packaging/uos20-arm64/build-l3.sh',
  'packaging/uos20-arm64/check-elf.sh',
  'packaging/uos20-arm64/install.sh',
  'packaging/uos20-arm64/uninstall.sh',
  'packaging/uos20-arm64/verify.sh',
  'packaging/uos20-arm64/wait-clickhouse.sh',
  'packaging/uos20-arm64/config/anysentry.env.example',
  'packaging/uos20-arm64/config/clickhouse-config.xml',
  'packaging/uos20-arm64/config/clickhouse-users.xml',
  'packaging/uos20-arm64/systemd/anysentry.service',
  'packaging/uos20-arm64/systemd/anysentry-clickhouse.service',
  'packaging/uos20-arm64/systemd/anysentry-observer.service',
  'packaging/uos20-arm64/README.md',
];

for (const file of requiredFiles) requireFile(file);

if (!fs.existsSync(packagingRoot)) fail('packaging root exists', 'packaging/uos20-arm64');
else pass('packaging root exists');

const packageJson = requireFile('package.json');
requireText(packageJson, /"verify:uos20-arm64-package"\s*:/u, 'package script exposes ARM64 package verification');
requireText(packageJson, /"build:uos20-arm64-package"\s*:/u, 'package script exposes ARM64 release build');

const sentryBuild = requireFile('packaging/uos20-arm64/build-sentry.sh');
requireText(sentryBuild, /f9a2f1dae626a2427e21ac5541a8a9f69d744d4a/u, 'sentry build pins the source commit');
requireText(sentryBuild, /cargo zigbuild/u, 'sentry build uses cargo-zigbuild');
requireText(sentryBuild, /aarch64-unknown-linux-gnu\.2\.28/u, 'sentry build targets glibc 2.28 ARM64');
requireText(sentryBuild, /a3s-sentry\.linux-arm64-gnu\.node/u, 'sentry build emits the N-API loader filename');
requireText(sentryBuild, /check-elf\.sh/u, 'sentry build verifies its ELF output');

const elfCheck = requireFile('packaging/uos20-arm64/check-elf.sh');
requireText(elfCheck, /readelf/u, 'ELF checker inspects ELF metadata');
requireText(elfCheck, /AArch64/u, 'ELF checker requires AArch64');
requireText(elfCheck, /GLIBC_2\.28/u, 'ELF checker enforces the glibc 2.28 ceiling');
requireText(elfCheck, /sort -V/u, 'ELF checker compares versioned GLIBC symbols');
requireText(elfCheck, /65536|0x10000/iu, 'ELF checker enforces 64 KiB page compatibility');

const nodeBuild = requireFile('packaging/uos20-arm64/build-node-runtime.sh');
requireText(nodeBuild, /NODE_VERSION=20\.19\.4/u, 'Node runtime pins version 20.19.4');
requireText(nodeBuild, /4492c29882f604eb4cba6ce52ad2e6436f4eeb2b2917a74b0f85e6e42e261252/u, 'Node runtime pins the ARM64 archive checksum');
requireText(nodeBuild, /node-v\$\{NODE_VERSION\}-linux-arm64\.tar\.xz/u, 'Node runtime downloads Linux ARM64');
requireText(nodeBuild, /sha256sum --check/u, 'Node runtime verifies its archive checksum');
requireText(nodeBuild, /runtime\/node/u, 'Node runtime stages a private runtime');
requireText(nodeBuild, /check-elf\.sh/u, 'Node runtime verifies the ARM64 executable ABI');

const appBuild = requireFile('packaging/uos20-arm64/build-app.sh');
requireText(appBuild, /pnpm install --frozen-lockfile/u, 'application build uses the frozen lockfile');
requireText(appBuild, /pnpm build/u, 'application build compiles API and web');
requireText(appBuild, /--filter @anysentry\/api --prod deploy/u, 'application build creates a production deployment');
requireText(appBuild, /apps\/web\/dist/u, 'application build stages web assets');
requireText(appBuild, /a3s-sentry\.linux-arm64-gnu\.node/u, 'application build installs the ARM64 sentry addon');
requireText(appBuild, /rm -f .*\/\*\.node/u, 'application build removes incompatible native addons');
requireText(appBuild, /\.pnpm[\s\S]*@a3s-lab\+code/u, 'application build removes build-host a3s-code packages from the API virtual store');

const clickhouseBuild = requireFile('packaging/uos20-arm64/build-clickhouse.sh');
requireText(clickhouseBuild, /clickhouse\/clickhouse-server@sha256:/u, 'ClickHouse build pins an immutable image digest');
requireText(clickhouseBuild, /--platform linux\/arm64/u, 'ClickHouse build selects the ARM64 image');
requireText(clickhouseBuild, /docker cp .*\/usr\/bin\/clickhouse/u, 'ClickHouse build extracts the server binary');
requireText(clickhouseBuild, /docker cp .*\/etc\/clickhouse-server/u, 'ClickHouse build extracts official configuration');
requireText(clickhouseBuild, /check-elf\.sh/u, 'ClickHouse build verifies the extracted ARM64 binary');
requireText(clickhouseBuild, /rm -f .*docker_related_config\.xml/u, 'ClickHouse build removes container-wide network overrides');

const clickhouseConfig = requireFile('packaging/uos20-arm64/config/clickhouse-config.xml');
requireText(clickhouseConfig, /<listen_host[^>]*>127\.0\.0\.1<\/listen_host>/u, 'ClickHouse HTTP listens on loopback only');
requireText(clickhouseConfig, /<http_port>8123<\/http_port>/u, 'ClickHouse uses HTTP port 8123');
requireText(clickhouseConfig, /\/var\/lib\/anysentry\/clickhouse/u, 'ClickHouse data uses the AnySentry state directory');
requireText(clickhouseConfig, /\/var\/log\/anysentry/u, 'ClickHouse logs use the AnySentry log directory');
requireText(clickhouseConfig, /<user_directories[^>]*>[\s\S]*<local_directory>[\s\S]*<path>\/var\/lib\/anysentry\/clickhouse\/access\/<\/path>[\s\S]*<\/local_directory>[\s\S]*<\/user_directories>/u, 'ClickHouse access metadata uses the AnySentry state directory');
requireText(clickhouseConfig, /<max_server_memory_usage>8589934592<\/max_server_memory_usage>/u, 'ClickHouse memory is capped at 8 GiB');
requireText(clickhouseConfig, /<max_thread_pool_size>512<\/max_thread_pool_size>/u, 'ClickHouse global thread pool is bounded for 16 CPUs');
requireText(clickhouseConfig, /<background_pool_size>16<\/background_pool_size>/u, 'ClickHouse merge pool satisfies the 24.8 mutation concurrency minimum');
requireText(clickhouseConfig, /<background_schedule_pool_size>32<\/background_schedule_pool_size>/u, 'ClickHouse background scheduler is bounded for 16 CPUs');
requireText(clickhouseConfig, /<uncompressed_cache_size>536870912<\/uncompressed_cache_size>/u, 'ClickHouse uncompressed cache is capped at 512 MiB');
requireText(clickhouseConfig, /<mark_cache_size>1073741824<\/mark_cache_size>/u, 'ClickHouse mark cache is capped at 1 GiB');

const clickhouseUsers = requireFile('packaging/uos20-arm64/config/clickhouse-users.xml');
requireText(clickhouseUsers, /<anysentry>/u, 'ClickHouse defines the AnySentry user');
requireText(clickhouseUsers, /from_env="CLICKHOUSE_PASSWORD"/u, 'ClickHouse reads its password from the protected environment file');
requireText(clickhouseUsers, /<ip>127\.0\.0\.1<\/ip>/u, 'ClickHouse user accepts loopback clients');

const installer = requireFile('packaging/uos20-arm64/install.sh');
requireText(installer, /set -euo pipefail/u, 'installer uses strict shell mode');
requireText(installer, /--check/u, 'installer exposes a non-mutating preflight mode');
requireText(installer, /\$\(id -u\)/u, 'installer requires root for mutations');
requireText(installer, /uname -m/u, 'installer checks the target architecture');
requireText(installer, /getconf GNU_LIBC_VERSION/u, 'installer checks the target glibc ABI');
requireText(installer, /df -Pk/u, 'installer checks target filesystem capacity');
requireText(installer, /ss -lnt/u, 'installer checks required ports');
requireText(installer, /env_value PORT/u, 'installer preflights the configured API port');
requireText(installer, /sha256sum --check/u, 'installer validates package contents before mutation');
requireText(installer, /sha256sum --check --quiet manifest\.sha256/u, 'installer keeps successful package verification concise');
requireText(installer, /useradd[\s\S]*--system/u, 'installer creates an unprivileged system account');
requireText(installer, /getent group anysentry/u, 'installer detects a pre-existing service group');
requireText(installer, /groupadd --system anysentry/u, 'installer creates the service group idempotently');
requireText(installer, /for command_name in[^\n]*useradd/u, 'installer preflights mutation commands');
requireText(installer, /INSTALL_STAGING/u, 'installer stages program files before replacement');
requireText(installer, /umask 077/u, 'installer protects generated credentials');
requireText(installer, /openssl rand -hex 32/u, 'installer generates strong credentials');
requireText(installer, /ANYSENTRY_ADMIN_TOKEN/u, 'installer provisions the management credential');
requireText(installer, /CLICKHOUSE_PASSWORD/u, 'installer provisions the ClickHouse credential');
requireText(installer, /ANYSENTRY_INGEST_TOKEN/u, 'installer provisions the Observer Source credential');
requireText(installer, /systemctl enable --now anysentry-clickhouse\.service/u, 'installer enables ClickHouse before the API');
requireText(installer, /systemctl enable --now anysentry\.service/u, 'installer enables the API service');
requireText(installer, /systemctl enable --now anysentry-observer\.service/u, 'installer enables Observer after the API');
requireText(installer, /verify\.sh/u, 'installer runs post-install verification');

const uninstaller = requireFile('packaging/uos20-arm64/uninstall.sh');
requireText(uninstaller, /--purge-data/u, 'uninstaller requires an explicit data purge flag');
requireText(uninstaller, /systemctl disable --now anysentry-observer\.service/u, 'uninstaller stops Observer before the API');
requireText(uninstaller, /systemctl disable --now anysentry\.service/u, 'uninstaller stops and disables the API');
requireText(uninstaller, /systemctl disable --now anysentry-clickhouse\.service/u, 'uninstaller stops and disables ClickHouse');
requireText(uninstaller, /retained|保留/iu, 'uninstaller reports retained state by default');
requireText(uninstaller, /PURGE_DATA/u, 'uninstaller gates persistent-state removal');

const targetVerifier = requireFile('packaging/uos20-arm64/verify.sh');
requireText(targetVerifier, /--preflight/u, 'target verifier exposes package and host preflight');
requireText(targetVerifier, /systemctl is-active --quiet anysentry-clickhouse\.service/u, 'target verifier checks ClickHouse service state');
requireText(targetVerifier, /systemctl is-active --quiet anysentry\.service/u, 'target verifier checks API service state');
requireText(targetVerifier, /127\.0\.0\.1:8123\/ping/u, 'target verifier probes loopback-only ClickHouse');
requireText(targetVerifier, /security-center\/healthz/u, 'target verifier probes API health');
requireText(targetVerifier, /"mode"\s*:\s*"clickhouse"/u, 'target verifier requires durable storage mode');
requireText(targetVerifier, /security-center\/ingest\/events/u, 'target verifier performs an ingest smoke test');
requireText(targetVerifier, /systemctl is-active --quiet anysentry-observer\.service/u, 'target verifier checks Observer service state');
requireText(targetVerifier, /observer[\s\S]*(exec|ToolExec)[\s\S]*(events\/list|security-center)/iu, 'target verifier requires an Observer execution smoke event');

const envExample = requireFile('packaging/uos20-arm64/config/anysentry.env.example');
requireText(envExample, /PORT=29653/u, 'environment template exposes API port 29653');
requireText(envExample, /ANYSENTRY_WEB_DIR=\/opt\/anysentry\/app\/web/u, 'environment template locates dashboard assets');
requireText(envExample, /CLICKHOUSE_URL=http:\/\/127\.0\.0\.1:8123/u, 'environment template connects to loopback ClickHouse');
requireText(envExample, /CLICKHOUSE_USER=anysentry/u, 'environment template selects the dedicated ClickHouse user');
requireText(envExample, /CLICKHOUSE_DB=anysentry/u, 'environment template selects the AnySentry database');
requireText(envExample, /CLICKHOUSE_PASSWORD=__GENERATED__/u, 'environment template marks the ClickHouse secret for generation');
requireText(envExample, /ANYSENTRY_ADMIN_TOKEN=__GENERATED__/u, 'environment template marks the management secret for generation');
requireText(envExample, /ANYSENTRY_INGEST_TOKEN=__GENERATED__/u, 'environment template marks the Observer Source secret for generation');
requireText(envExample, /ANYSENTRY_LLM_BASE_URL=/u, 'environment template exposes the OpenAI-compatible base URL');
requireText(envExample, /ANYSENTRY_LLM_MODEL=/u, 'environment template exposes the LLM model ID');
requireText(envExample, /ANYSENTRY_LLM_API_KEY=/u, 'environment template exposes an optional protected LLM key');
requireText(envExample, /ANYSENTRY_L3_ENABLED=/u, 'environment template controls the bundled L3 agent');

const apiUnit = requireFile('packaging/uos20-arm64/systemd/anysentry.service');
requireText(apiUnit, /Requires=anysentry-clickhouse\.service/u, 'API service requires ClickHouse');
requireText(apiUnit, /After=[^\n]*anysentry-clickhouse\.service/u, 'API service starts after ClickHouse');
requireText(apiUnit, /User=anysentry/u, 'API service runs unprivileged');
requireText(apiUnit, /EnvironmentFile=\/etc\/anysentry\/anysentry\.env/u, 'API service reads protected configuration');
requireText(apiUnit, /ExecStartPre=\/opt\/anysentry\/wait-clickhouse\.sh/u, 'API service waits for ClickHouse readiness on every boot');
requireText(apiUnit, /ExecStart=\/opt\/anysentry\/runtime\/node\/bin\/node \/opt\/anysentry\/app\/dist\/main\.js/u, 'API service uses the bundled Node runtime');
requireText(apiUnit, /NoNewPrivileges=true/u, 'API service blocks privilege escalation');

const clickhouseUnit = requireFile('packaging/uos20-arm64/systemd/anysentry-clickhouse.service');
requireText(clickhouseUnit, /Before=anysentry\.service/u, 'ClickHouse service orders before the API');
requireText(clickhouseUnit, /User=anysentry/u, 'ClickHouse service runs unprivileged');
requireText(clickhouseUnit, /EnvironmentFile=\/etc\/anysentry\/anysentry\.env/u, 'ClickHouse service reads protected credentials');
requireText(clickhouseUnit, /ExecStart=\/opt\/anysentry\/clickhouse\/bin\/clickhouse server/u, 'ClickHouse service uses the bundled ARM64 binary');
requireText(clickhouseUnit, /ReadWritePaths=\/var\/lib\/anysentry \/var\/log\/anysentry/u, 'ClickHouse service can write only its state and logs');
requireText(clickhouseUnit, /LimitNOFILE=262144/u, 'ClickHouse service receives a production file-descriptor limit');
requireText(clickhouseUnit, /NoNewPrivileges=true/u, 'ClickHouse service blocks privilege escalation');

const observerUnit = requireFile('packaging/uos20-arm64/systemd/anysentry-observer.service');
requireText(observerUnit, /After=[^\n]*anysentry\.service/u, 'Observer starts after the AnySentry API');
requireText(observerUnit, /Requires=anysentry\.service/u, 'Observer requires the AnySentry API');
requireText(observerUnit, /EnvironmentFile=\/etc\/anysentry\/anysentry\.env/u, 'Observer reads protected Source configuration');
requireText(observerUnit, /a3s-observer-collector/u, 'Observer service runs the bundled collector');
requireText(observerUnit, /observer-forward\.js/u, 'Observer service forwards NDJSON to AnySentry');
requireText(observerUnit, /Restart=on-failure/u, 'Observer service restarts failed collection pipelines');

const clickhouseWaiter = requireFile('packaging/uos20-arm64/wait-clickhouse.sh');
requireText(clickhouseWaiter, /set -euo pipefail/u, 'ClickHouse readiness gate uses strict shell mode');
requireText(clickhouseWaiter, /127\.0\.0\.1:8123\/ping/u, 'ClickHouse readiness gate probes loopback HTTP');
requireText(clickhouseWaiter, /CLICKHOUSE_PASSWORD/u, 'ClickHouse readiness gate authenticates with the configured credential');
requireText(clickhouseWaiter, /seq 1 60/u, 'ClickHouse readiness gate has a bounded retry window');

const releaseBuild = requireFile('packaging/uos20-arm64/build-release.sh');
requireText(releaseBuild, /set -euo pipefail/u, 'release builder uses strict shell mode');
requireText(releaseBuild, /rm -rf "\$STAGE_DIR"/u, 'release builder starts from a clean staging directory');
requireText(releaseBuild, /build-sentry\.sh[\s\S]*build-node-runtime\.sh[\s\S]*build-app\.sh[\s\S]*build-clickhouse\.sh/u, 'release builder runs component builders in dependency order');
requireText(releaseBuild, /build-observer\.sh/u, 'release builder includes the Observer');
requireText(releaseBuild, /build-l3\.sh/u, 'release builder includes the L3 agent runtime');
requireText(releaseBuild, /OBSERVER_COMMIT/u, 'release records Observer source provenance');
requireText(releaseBuild, /SENTRY_COMMIT/u, 'release records Sentry source provenance');
requireText(releaseBuild, /SOURCE_DATE_EPOCH/u, 'release builder pins archive timestamps');
requireText(releaseBuild, /VERSION/u, 'release builder records component provenance');
requireText(releaseBuild, /git -C "\$ROOT_DIR" status --porcelain/u, 'release builder records tracked and untracked source changes');
requireText(releaseBuild, /manifest\.sha256/u, 'release builder emits content checksums');
requireText(releaseBuild, /check-elf\.sh[\s\S]*done < <\(find "\$STAGE_DIR" -type f -print0\)/u, 'release builder validates every staged ELF');
requireText(releaseBuild, /find \. -type f[\s\S]*-print0[\s\S]*sort -z[\s\S]*sha256sum/u, 'release builder hashes every staged file deterministically');
requireText(releaseBuild, /--sort=name/u, 'release builder sorts archive entries');
requireText(releaseBuild, /--owner=0/u, 'release builder normalizes archive ownership');
requireText(releaseBuild, /--group=0/u, 'release builder normalizes archive group ownership');
requireText(releaseBuild, /--numeric-owner/u, 'release builder records numeric archive ownership');
requireText(releaseBuild, /sha256sum "\$ARCHIVE_NAME"/u, 'release builder emits an archive checksum');

const gitignore = requireFile('.gitignore');
requireText(gitignore, /^\.build\/uos20-arm64\/$/mu, 'ARM64 package build cache is ignored');
requireText(gitignore, /^release\/anysentry-.*uos20-arm64.*\/$/mu, 'staged ARM64 release directories are ignored');
requireText(gitignore, /^release\/anysentry-.*uos20-arm64.*\.tar\.gz/mu, 'ARM64 release archives are ignored');

const runbook = requireFile('packaging/uos20-arm64/README.md');
requireText(runbook, /UOS Server 20[\s\S]*aarch64[\s\S]*glibc 2\.28/iu, 'runbook states the supported target ABI');
requireText(runbook, /构建机[\s\S]*联网/u, 'runbook distinguishes networked build requirements');
requireText(runbook, /目标机[\s\S]*(无需联网|完全离线)/u, 'runbook states target installation is offline');
requireText(runbook, /sha256sum -c/u, 'runbook verifies the archive checksum before extraction');
requireText(runbook, /\.\/install\.sh --check/u, 'runbook documents non-mutating target preflight');
requireText(runbook, /sudo \.\/install\.sh/u, 'runbook documents installation');
requireText(runbook, /\/etc\/anysentry\/anysentry\.env/u, 'runbook identifies the installed configuration file');
requireText(runbook, /ANYSENTRY_ADMIN_TOKEN/u, 'runbook documents management authentication');
requireText(runbook, /CLICKHOUSE_PASSWORD/u, 'runbook documents database credentials');
requireText(runbook, /29653/u, 'runbook documents the public API port');
requireText(runbook, /8123[\s\S]*127\.0\.0\.1/u, 'runbook documents loopback-only ClickHouse');
requireText(runbook, /security-center\/healthz/u, 'runbook documents the health endpoint');
requireText(runbook, /security-center\/ingest\/events/u, 'runbook documents generic JSON ingest');
requireText(runbook, /security-center\/ingest\/otlp\/v1\/logs/u, 'runbook documents OTLP logs ingest');
requireText(runbook, /security-center\/ingest\/otlp\/v1\/traces/u, 'runbook documents OTLP traces ingest');
requireText(runbook, /a3s-observer[\s\S]*(legacy|perf.?buffer|Linux 4\.19)/iu, 'runbook documents the bundled Linux 4.19 Observer backend');
requireText(runbook, /ANYSENTRY_LLM_BASE_URL[\s\S]*ANYSENTRY_LLM_MODEL[\s\S]*ANYSENTRY_LLM_API_KEY/u, 'runbook documents OpenAI-compatible LLM configuration');
requireText(runbook, /choices\[0\]\.message\.content|chat\/completions/u, 'runbook documents the required model response contract');
requireText(runbook, /journalctl -u anysentry/u, 'runbook documents service diagnostics');

if (failures > 0) {
  console.error(`UOS 20 ARM64 package verification failed with ${failures} issue(s)`);
  process.exitCode = 1;
} else {
  console.log('UOS 20 ARM64 package verification passed');
}
