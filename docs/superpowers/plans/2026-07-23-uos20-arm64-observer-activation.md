# UOS 20 ARM64 Observer Activation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a deployable UOS ARM64 release that cannot falsely roll back a healthy legacy Observer because of journal formatting.

**Architecture:** Stabilize collector logging at the source, propagate collector
metadata through the forwarder heartbeat, and use end-to-end Source/collector
health as the activation contract. Keep journal parsing diagnostic-only.

**Tech Stack:** Bash, Node.js 20, Rust/tracing-subscriber, systemd, UOS 20 ARM64.

---

### Task 1: Define failing release contracts

**Files:**
- Modify: `uos20-arm64/tests/test-installer.sh`
- Modify: `scripts/verify-forwarder-attribution.mjs`

- [ ] Add assertions requiring silent API retries, diagnostic-only journal
  counting, and a runtime `attachedProbes >= 8` gate.
- [ ] Add a forwarder heartbeat metadata test using a real local HTTP server.
- [ ] Run both tests and confirm they fail for the missing behavior.

### Task 2: Stabilize Observer output

**Files:**
- Modify: Observer `a3s-observer-collector/src/legacy.rs`
- Modify: `uos20-arm64/versions.env`

- [ ] Add a source contract requiring `.with_ansi(false)`.
- [ ] Run the contract and confirm it fails.
- [ ] Disable ANSI in legacy collector logging.
- [ ] Commit Observer and pin the new integration commit.

### Task 3: Fix activation and heartbeat behavior

**Files:**
- Modify: `scripts/observer-forward.js`
- Modify: `uos20-arm64/package/verify.sh`
- Modify: `uos20-arm64/package/install.sh`

- [ ] Cache CollectorHeartbeat probe metadata before forwarding each line.
- [ ] Include cached metadata in periodic forwarder heartbeats.
- [ ] Move journal attachment counting after end-to-end event validation and
  make it informational.
- [ ] Require collector `attachedProbes >= 8`.
- [ ] Suppress curl stderr during expected API startup retries.
- [ ] Run focused and complete UOS tests.

### Task 4: Build and verify the release

**Files:**
- Update: `uos20-arm64/package/DEPLOYMENT.md`
- Create: `release/anysentry-security-suite-0.2.0-compat6-uos20-arm64.tar.gz`
- Create: `release/anysentry-security-suite-0.2.0-compat6-uos20-arm64.tar.gz.sha256`

- [ ] Commit source changes.
- [ ] Incrementally rebuild Observer and app components.
- [ ] Assemble the release from the verified compat5 stage.
- [ ] Extract the archive, verify its manifest and runtime modules, and run the
  release ABI contract.
- [ ] Publish the exact archive SHA-256 and target installation commands.

