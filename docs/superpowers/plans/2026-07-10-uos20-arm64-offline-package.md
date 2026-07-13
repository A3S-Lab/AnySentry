# UOS 20 ARM64 Offline Package Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build, test, and package a network-independent AnySentry distribution for UOS 20 ARM64, kernel 4.19, and glibc 2.28.

**Architecture:** Build architecture-neutral application assets on x86_64, cross-compile the a3s-sentry N-API addon with Zig for aarch64/glibc 2.28, bundle official ARM64 Node.js and ClickHouse artifacts, and execute the staged release under QEMU in Rocky Linux 8 before producing the archive. Install through systemd without Docker on the customer host.

**Tech Stack:** Bash, Node.js 20, pnpm 9, Rust/N-API, cargo-zigbuild, Zig, Docker Buildx/binfmt/QEMU, ClickHouse 24.8 LTS, systemd.

---

### Task 1: Package Contract Verifier

**Files:**
- Create: `scripts/verify-uos20-arm64-package.mjs`
- Modify: `package.json`

- [ ] Write a verifier that fails while the packaging directory, build script, installer, service units, configuration, and required safety checks are absent.
- [ ] Run `node scripts/verify-uos20-arm64-package.mjs` and confirm it fails for the missing packaging implementation.
- [ ] Add the minimal packaging skeleton and package script required to make structural assertions pass.
- [ ] Run `pnpm verify:uos20-arm64-package` and confirm all static package-contract assertions pass.

### Task 2: ARM64 Sentry Cross-Build

**Files:**
- Create: `packaging/uos20-arm64/build-sentry.sh`
- Create: `packaging/uos20-arm64/check-elf.sh`
- Test: `scripts/verify-uos20-arm64-package.mjs`

- [ ] Add failing assertions for the pinned Sentry commit, Zig glibc 2.28 target, ARM64 output name, and ELF ABI check.
- [ ] Run the verifier and confirm the new assertions fail.
- [ ] Implement source acquisition, cargo-zigbuild invocation, deterministic artifact placement, AArch64 ELF validation, and rejection of GLIBC requirements newer than 2.28.
- [ ] Register ARM64 binfmt, install or download the pinned Zig/cargo-zigbuild toolchain, and build the addon.
- [ ] Run the verifier and execute the addon with ARM64 Node.js under Rocky Linux 8; require a metadata-egress event to return `verdict=block`.

### Task 3: Application and Runtime Staging

**Files:**
- Create: `packaging/uos20-arm64/build-app.sh`
- Create: `packaging/uos20-arm64/build-node-runtime.sh`
- Test: `scripts/verify-uos20-arm64-package.mjs`

- [ ] Add failing assertions for frozen pnpm installation, production deployment, web assets, native-addon replacement, Node version pinning, and checksum verification.
- [ ] Run the verifier and confirm the new assertions fail.
- [ ] Implement x86 application build/staging and official Node.js ARM64 download/checksum staging.
- [ ] Run the verifier, load the staged addon through the staged ARM64 Node runtime, and start AnySentry under QEMU in memory mode.
- [ ] Verify `/security-center/healthz`, dashboard HTML, and dangerous egress generic ingest.

### Task 4: ClickHouse ARM64 Persistence

**Files:**
- Create: `packaging/uos20-arm64/build-clickhouse.sh`
- Create: `packaging/uos20-arm64/config/clickhouse-config.xml`
- Create: `packaging/uos20-arm64/config/clickhouse-users.xml`
- Test: `scripts/verify-uos20-arm64-package.mjs`

- [ ] Add failing assertions for a pinned 24.8 LTS ARM64 artifact, loopback-only HTTP, data/log paths, and credential injection.
- [ ] Run the verifier and confirm the new assertions fail.
- [ ] Implement ClickHouse ARM64 artifact download/extraction and configuration templates.
- [ ] Start staged ClickHouse under QEMU, start AnySentry with ClickHouse variables, and require health storage mode `clickhouse`.
- [ ] Ingest an event, restart both processes, and verify the event remains queryable.

### Task 5: Offline Installer and Services

**Files:**
- Create: `packaging/uos20-arm64/install.sh`
- Create: `packaging/uos20-arm64/uninstall.sh`
- Create: `packaging/uos20-arm64/verify.sh`
- Create: `packaging/uos20-arm64/config/anysentry.env.example`
- Create: `packaging/uos20-arm64/systemd/anysentry.service`
- Create: `packaging/uos20-arm64/systemd/anysentry-clickhouse.service`
- Test: `scripts/verify-uos20-arm64-package.mjs`

- [ ] Add failing assertions for architecture/glibc/disk/port preflight, unprivileged ownership, secret generation, idempotence, service ordering, loopback ClickHouse, health checks, retained data by default, and explicit purge.
- [ ] Run the verifier and confirm the new assertions fail.
- [ ] Implement the installer, uninstaller, verifier, configuration template, and systemd units.
- [ ] Run static verification and installer `--check` against the staged release.

### Task 6: Reproducible Release Orchestrator

**Files:**
- Create: `packaging/uos20-arm64/build-release.sh`
- Create: `packaging/uos20-arm64/README.md`
- Modify: `.gitignore`
- Modify: `package.json`
- Test: `scripts/verify-uos20-arm64-package.mjs`

- [ ] Add failing assertions for strict mode, clean staging, ordered builders, provenance, content checksums, numeric ownership, archive checksum, and ignored release output.
- [ ] Run the verifier and confirm the new assertions fail.
- [ ] Implement the orchestrator and operator runbook.
- [ ] Run `pnpm verify:uos20-arm64-package` and build the complete archive.

### Task 7: Final Verification

**Files:**
- Verify only.

- [ ] Run `pnpm verify:contracts:local` from the isolated worktree.
- [ ] Run `pnpm verify:uos20-arm64-package` against source and staged release.
- [ ] Run ARM64 sentry, memory-mode API, dashboard, ingest, ClickHouse-mode API, restart persistence, and archive checksum tests under QEMU.
- [ ] Inspect every bundled ELF with `file` and `readelf`; require AArch64 and no GLIBC requirement newer than 2.28 for sentry and Node compatibility on the target.
- [ ] Record archive path, byte size, SHA-256, included versions, exclusions, and any residual target-host verification requirements.
