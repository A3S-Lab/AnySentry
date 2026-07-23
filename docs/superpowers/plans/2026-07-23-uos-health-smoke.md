# UOS Health Smoke Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone UOS health and safe simulation script with passive, safe, and extended modes.

**Architecture:** A Bash entry point performs local service and endpoint checks, uses the bundled Node
runtime for JSON parsing and loopback network simulation, submits uniquely tagged custom events, and
writes a stable report. A shell integration test supplies temporary fake system commands and HTTP
responses to verify modes and failure behavior without requiring a running AnySentry installation.

**Tech Stack:** Bash 5, curl, systemd CLI, bundled Node.js 20, existing AnySentry HTTP APIs.

---

### Task 1: Define the executable contract

**Files:**
- Create: `uos20-arm64/tests/test-health-smoke.sh`
- Modify: `uos20-arm64/tests/run-all.sh`

- [ ] Write a failing integration test that requires `--help`, `--passive`, `--safe`, `--extended`,
  a stable report path, unique mock markers, and nonzero exit on unhealthy Collector.
- [ ] Run `./uos20-arm64/tests/test-health-smoke.sh` and verify it fails because
  `uos20-arm64/package/RUN_HEALTH_SMOKE.sh` does not exist.

### Task 2: Implement the health and simulation runner

**Files:**
- Create: `uos20-arm64/package/RUN_HEALTH_SMOKE.sh`

- [ ] Implement argument validation, stable report capture, prerequisite and version checks.
- [ ] Implement systemd, Redis, ClickHouse, dashboard, API, Source and Collector checks.
- [ ] Implement safe `/tmp`, process and loopback TCP simulations.
- [ ] Implement one blocking Sentry event for safe mode and additional benign/risky events for
  extended mode; verify acceptance, expected verdict and event list visibility.
- [ ] Implement Source counter comparison, recent service error summary and final PASS/WARN/FAIL totals.
- [ ] Run the integration test and verify all scenarios pass.

### Task 3: Include the script in future packages and documentation

**Files:**
- Modify: `uos20-arm64/scripts/assemble-release.sh`
- Modify: `uos20-arm64/scripts/verify-release.sh`
- Modify: `uos20-arm64/tests/test-release-contract.sh`
- Modify: `uos20-arm64/package/AnySentry部署手册.md`
- Modify: `uos20-arm64/package/AnySentry使用手册.md`

- [ ] Add failing release and documentation assertions for `RUN_HEALTH_SMOKE.sh`.
- [ ] Run the focused tests and verify the missing assembly/documentation behavior fails.
- [ ] Add executable assembly, release verification and concise customer commands.
- [ ] Run the focused tests and verify they pass.

### Task 4: Verify and deliver

**Files:**
- Create delivery copy: `security/release/RUN_HEALTH_SMOKE-compat8.sh`

- [ ] Run Bash syntax checks and `./uos20-arm64/tests/run-all.sh`.
- [ ] Copy the verified script without modifying the compat8 archive.
- [ ] Verify source and delivery SHA256 values match.
- [ ] Commit the UOS source, tests and documentation changes.

