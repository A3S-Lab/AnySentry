# UOS 20 ARM64 ClickHouse Compatibility Fix Design

## Problem

The UOS 20 target is an AArch64 OpenStack guest with glibc 2.28, Linux 4.19,
and 64 KiB pages. The ClickHouse 24.8.14.39 binary copied from the official
server image exits with `SIGILL` before it can print `--version`. Its embedded
compiler flags select the modern ARM profile:

```text
-march=armv8.2-a+simd+crypto+dotprod+ssbs+rcpc
```

The guest does not expose the required modern ARM feature set. The existing
installer checks the ELF architecture and ABI but never executes bundled
runtimes, so `install.sh --check` incorrectly succeeds before systemd enters a
ClickHouse restart loop.

## Decision

Keep ClickHouse at `24.8.14.39` and build the server from the pinned
`v24.8.14.39-lts` source using ClickHouse's own
`clang-18-aarch64-v80compat` packaging profile. That profile adds
`-DNO_ARMV81_OR_HIGHER=1` and selects the ARMv8.0 compatibility compiler
flags. Do not require an OpenStack CPU-model change and do not substitute a
newer unpinned master build.

The AnySentry release builder will consume a cached, checksum-pinned compat
binary rather than copying `/usr/bin/clickhouse` from the modern server image.
The official server image remains the pinned source of the matching 24.8 XML
configuration only.

## Components

### Compat binary builder

`packaging/uos20-arm64/build-clickhouse-compat.sh` will:

- pin ClickHouse tag `v24.8.14.39-lts` and commit
  `502d03925cf2c9c6629ed5c1b2d16b5de46e4362`;
- clone the repository and all submodules into the ignored build cache;
- invoke ClickHouse's Docker packager with compiler profile
  `clang-18-aarch64-v80compat`;
- validate the resulting ELF with the existing glibc 2.28 / 64 KiB checker;
- reject binaries that retain the modern ARM compiler profile;
- write the binary, SHA256, source commit, version, and profile metadata to a
  stable cache directory.

### Release staging

`packaging/uos20-arm64/build-clickhouse.sh` will require the compat cache
produced above, verify its SHA256 and metadata, stage the binary, and copy
matching configuration from the immutable ClickHouse 24.8 server image. The
release `VERSION` file will record the compat profile, source commit, and
binary SHA256.

### Target preflight

After package checksum verification, `install.sh --check` will execute:

```text
runtime/node/bin/node --version
clickhouse/bin/clickhouse --version
```

Any nonzero exit, including `SIGILL`, fails before users, files, credentials,
or services are changed. The kernel configuration lookup will also support
both `/boot/config-$(uname -r)` and `/proc/config.gz`, matching the inspected
UOS host.

### Failure containment

If service startup still fails, the installer will stop the ClickHouse/API
services before exiting instead of leaving an automatic restart loop. Existing
`/etc/anysentry` credentials and `/var/lib/anysentry` data remain preserved.

## Verification

The repository contract verifier will require the pinned compat source,
profile, metadata, runtime preflight, and `/proc/config.gz` fallback. The full
release build must additionally prove:

- all repository package contract tests pass;
- the compat binary checksum matches its metadata;
- no modern ARM `-march=armv8.2-a+...` profile is embedded;
- the final archive checksum verifies;
- extracting the final archive and checking its manifest succeeds;
- every staged ELF remains AArch64, glibc <= 2.28, and 64 KiB-page compatible;
- the AArch64 ClickHouse binary runs under the available QEMU runtime where
  possible; the customer UOS host remains the final native acceptance gate.

## Delivery

Generate a new revisioned archive rather than overwriting the failed artifact:

```text
anysentry-security-suite-0.1.0-compat1-uos20-arm64.tar.gz
anysentry-security-suite-0.1.0-compat1-uos20-arm64.tar.gz.sha256
```

The installer is idempotent and preserves the target's existing generated
credentials and state when the corrected release is installed.
