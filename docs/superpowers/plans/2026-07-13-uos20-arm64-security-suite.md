# UOS 20 ARM64 Security Suite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and validate one offline UOS 20 ARM64 archive containing AnySentry, ClickHouse,
Sentry L1/L2/L3, the Web dashboard, and a Linux 4.19-compatible Observer.

**Architecture:** Extend the existing AnySentry ARM64 package orchestrator with local Sentry,
Observer, and L3 builders. Add a legacy perf-event/kprobe Observer backend for the inspected 4.19
kernel, protect LLM secrets in the service environment, and verify all user-space components under
ARM64/glibc-2.28 QEMU before target-host Observer acceptance.

**Tech Stack:** Bash, TypeScript/NestJS, React, Rust, Aya eBPF, napi-rs, cargo-zigbuild, Zig,
Node.js 20, ClickHouse 24.8, systemd, Docker/QEMU, OpenAI-compatible HTTP.

---

### Task 1: Expanded Release Contract

**Files:**
- Modify: `scripts/verify-uos20-arm64-package.mjs`
- Modify: `packaging/uos20-arm64/README.md`

- [ ] Add failing assertions for `observer/`, `l3/`, the Observer service, local source commit
  provenance, LLM secret handling, 64 KiB ELF checks, and target Observer smoke verification.
- [ ] Run `pnpm verify:uos20-arm64-package`; require failure on the first missing artifact.
- [ ] Add only the package skeleton required by later tasks and keep the verifier failing on runtime
  behavior until the corresponding component exists.

### Task 2: Linux 4.19 Observer Backend

**Files (Observer repository):**
- Modify: `a3s-observer-ebpf/src/main.rs`
- Modify: `a3s-observer-collector/src/main.rs`
- Modify: `a3s-observer-collector/build.rs`
- Add tests under the existing crate test modules and packaging source-contract verifier.

- [ ] Write failing tests proving the legacy object uses perf-event arrays, avoids RingBuf and
  post-4.19 probe-read helpers, declares its backend in heartbeat metadata, and has ARM64 fallback
  attachment candidates.
- [ ] Run focused Rust/source-contract tests and confirm the expected failures.
- [ ] Implement perf-event output and userspace readers with per-CPU loss accounting.
- [ ] Implement attachment selection: syscall tracepoints when present, then ARM64-compatible
  kprobe candidates for the target; preserve non-fatal optional probes and fail when no effective
  event probe attaches.
- [ ] Build the eBPF object and ARM64/glibc-2.28 collector, inspect helpers/map types, and run modern
  host smoke tests where supported.

### Task 3: Secure L2/L3 Defaults In AnySentry

**Files:**
- Modify: `apps/api/src/security-monitoring/policy-config.ts`
- Modify: `apps/api/src/security-monitoring/sentry-judge.service.ts`
- Modify: `apps/web/src/pages/PolicyConfigPage.tsx` only where secret-state explanation is needed.
- Extend existing verification scripts.

- [ ] Add failing tests for environment-seeded L2/L3 policy, API-key injection into the in-memory
  ACL, omission of the key from persisted/read policy, and correct disabled behavior without URL.
- [ ] Implement `ANYSENTRY_LLM_BASE_URL`, `ANYSENTRY_LLM_MODEL`,
  `ANYSENTRY_LLM_API_KEY`, timeout, L3 bridge, skills, and model environment defaults.
- [ ] Verify the API never serializes the API key and management auth still protects policy writes.
- [ ] Run the existing policy, management-auth, dashboard, and complete contract suites.

### Task 4: L3 Offline Runtime

**Files:**
- Create: `packaging/uos20-arm64/build-l3.sh`
- Stage from pinned Sentry `scripts/l3-agent.mjs` and `skills/`.
- Stage a pinned ARM64 `@a3s-lab/code` package or build it from a clean pinned source revision.

- [ ] Add a failing contract for the executable L3 bridge, local module resolution, skills, version
  provenance, glibc ceiling, and 64 KiB ELF compatibility.
- [ ] Inspect the published ARM64 a3s-code addon; use it only if it satisfies glibc 2.28 and 64 KiB
  alignment, otherwise cross-build the pinned source.
- [ ] Run the staged bridge under ARM64 QEMU against a mock OpenAI endpoint and require a parseable
  `{verdict,severity,reason}` response.

### Task 5: Unified Installer And Services

**Files:**
- Modify: `packaging/uos20-arm64/config/anysentry.env.example`
- Modify: `packaging/uos20-arm64/install.sh`
- Modify: `packaging/uos20-arm64/uninstall.sh`
- Modify: `packaging/uos20-arm64/verify.sh`
- Create: `packaging/uos20-arm64/systemd/anysentry-observer.service`
- Modify existing API and ClickHouse units as required.

- [ ] Add failing installer contracts for page size, BPF/perf/kprobe checks, Observer service
  ordering, generated Source token, LLM fields, protected secret permissions, and retained state.
- [ ] Implement `--check`, staged installation, user creation, secret generation, and service
  ordering without invoking a package manager or network download.
- [ ] Implement LLM validation that does not print the key and Observer verification that generates
  a process event and queries it through the API.
- [ ] Verify idempotent install fixtures and uninstall retention/purge behavior.

### Task 6: Release Orchestration And ABI Validation

**Files:**
- Modify: `packaging/uos20-arm64/check-elf.sh`
- Create: `packaging/uos20-arm64/build-observer.sh`
- Modify: `packaging/uos20-arm64/build-sentry.sh`
- Modify: `packaging/uos20-arm64/build-app.sh`
- Modify: `packaging/uos20-arm64/build-release.sh`
- Modify: `.gitignore` and `package.json` as needed.

- [ ] Add failing checks for AArch64, glibc <= 2.28, 64 KiB PT_LOAD congruence, pinned commits,
  clean source state, and inclusion of all three repository revisions.
- [ ] Build Sentry from the local pinned source, build the legacy Observer, stage the AnySentry app,
  L3, Node, and ClickHouse, then generate deterministic manifest and archive hashes.
- [ ] Reject release creation if any source repository is dirty, except for the reviewed packaging
  changes being committed before the final build.

### Task 7: ARM64 Integration Verification

**Files:**
- Create focused build-host verification scripts under `packaging/uos20-arm64/` as needed.

- [ ] Run all source and package contracts.
- [ ] Under ARM64/glibc-2.28 QEMU, start ClickHouse and AnySentry and require
  `storage.mode=clickhouse`, `clickhouseReady=true`, and management auth enabled.
- [ ] Verify dashboard assets, L1 block, event query, process restart persistence, mock-backed L2,
  and mock-backed L3.
- [ ] Inspect the legacy eBPF object for compatible map types/helpers and the collector for ARM64,
  glibc 2.28, and 64 KiB compatibility.
- [ ] Run `pnpm verify:contracts:local` and the complete package verifier with zero failures.

### Task 8: Final Archive And Runbook

**Files:**
- Modify: `packaging/uos20-arm64/README.md`
- Generate only: `release/anysentry-security-suite-<version>-uos20-arm64.tar.gz`
- Generate only: matching `.sha256` and verification report.

- [ ] Document WinSCP upload, checksum, extraction, editable preinstall configuration, `--check`,
  installation, LLM testing, dashboard URL, API examples, logs, restart, upgrade, and uninstall.
- [ ] Build from committed clean revisions so `SOURCE_DIRTY=false` for every repository.
- [ ] Re-run archive checksum and manifest checks from a fresh extraction directory.
- [ ] Record residual target-only acceptance: the UOS 4.19 Observer process-event smoke test.
