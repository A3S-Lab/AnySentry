# UOS 20 ARM64 Offline Package Design

## Goal

Produce a self-contained AnySentry release archive that installs without network access on UnionTech OS Server 20 Enterprise, Linux aarch64, kernel 4.19, and glibc 2.28. The target host has no Docker, Node.js, pnpm, or package registry access.

## Supported Scope

The first release contains the AnySentry API/dashboard, the native a3s-sentry L1 judge, and ClickHouse persistence. It accepts generic JSON, CloudEvents, OTLP/HTTP JSON, direct heartbeats, and observer-format NDJSON supplied by compatible external producers.

The package does not include a3s-observer. The current observer uses BPF ring buffers, which require a newer kernel than the customer's 4.19 kernel. This exclusion prevents an installer from deploying a collector that cannot load.

## Build Architecture

The Ubuntu x86_64 host performs normal AnySentry TypeScript and web builds natively. The a3s-sentry N-API addon is cross-compiled from the pinned Sentry commit for `aarch64-unknown-linux-gnu.2.28` with Zig. Official Linux ARM64 Node.js and ClickHouse artifacts are added to the staged release.

QEMU/binfmt supplies an ARM64 Rocky Linux 8 test environment. Rocky Linux 8 matches the target glibc 2.28 ABI and executes the staged Node runtime, native addon, API, dashboard, and ClickHouse before packaging.

## Release Layout

The archive expands to a versioned directory containing:

```text
app/                 deployed API dist, production node_modules, and web assets
runtime/node/        official Node.js 20 Linux ARM64 distribution
clickhouse/          ARM64 ClickHouse packages and checksums
config/              environment and ClickHouse configuration templates
systemd/             AnySentry and ClickHouse service units
install.sh           idempotent root installer
uninstall.sh         service/program removal with opt-in data purge
verify.sh            host and post-install verification
manifest.sha256      archive content checksums
VERSION              source and toolchain provenance
```

## Installation Model

The installer validates aarch64, glibc 2.28 or newer, systemd, free disk, and port availability. It creates an unprivileged `anysentry` account, installs under `/opt/anysentry`, stores mutable state under `/var/lib/anysentry`, writes secrets under `/etc/anysentry`, installs systemd units, starts ClickHouse before AnySentry, and runs the health and ingest smoke tests.

ClickHouse listens only on `127.0.0.1:8123`. AnySentry listens on `0.0.0.0:29653`. The installer generates independent random ClickHouse and management credentials unless an existing configuration is retained.

## Failure Handling

Every build and install step uses strict shell mode and validates its inputs before changing state. Installation stages files before replacing the active program directory. A failed service health check leaves logs and configuration intact for diagnosis and returns non-zero.

The uninstaller stops and disables services, removes units and program files, and retains configuration and data by default. `--purge-data` is required to delete persistent state.

## Verification

Static package-contract tests run before build scripts are implemented. ARM64 verification then checks ELF architecture, maximum required glibc version, Node loading of the N-API addon, a known sentry block decision, dashboard serving, health JSON, generic ingest, ClickHouse readiness, ClickHouse-backed storage mode, restart persistence, checksums, and installer dry-run behavior.
