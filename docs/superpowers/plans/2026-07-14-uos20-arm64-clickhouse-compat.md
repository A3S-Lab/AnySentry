# UOS 20 ARM64 ClickHouse Compatibility Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a complete revisioned UOS 20 ARM64 offline archive containing a ClickHouse 24.8.14.39 ARMv8.0-compatible binary and a preflight that rejects incompatible runtimes before installation.

**Architecture:** Build ClickHouse from its pinned LTS source with its native `clang-18-aarch64-v80compat` Docker packager, cache the binary with provenance metadata, and make release staging verify that cache. Extend the target installer to execute bundled runtimes and read either conventional or IKCONFIG kernel configuration sources before performing mutations.

**Tech Stack:** Bash, Node.js contract tests, Docker, ClickHouse 24.8 CMake/Ninja packager, Git, SHA-256, QEMU user-mode verification.

---

### Task 1: Lock the compatibility contracts

**Files:**
- Modify: `scripts/verify-uos20-arm64-package.mjs`

- [ ] Add assertions requiring a dedicated compat builder, pinned ClickHouse tag and commit, the `clang-18-aarch64-v80compat` profile, checksum metadata, rejection of the modern ARM profile, installer runtime execution, and `/proc/config.gz` fallback.

```js
const clickhouseCompatBuild = requireFile('packaging/uos20-arm64/build-clickhouse-compat.sh');
requireText(clickhouseCompatBuild, /v24\.8\.14\.39-lts/u, 'compat build pins the ClickHouse tag');
requireText(clickhouseCompatBuild, /502d03925cf2c9c6629ed5c1b2d16b5de46e4362/u, 'compat build pins the ClickHouse commit');
requireText(clickhouseCompatBuild, /clang-18-aarch64-v80compat/u, 'compat build selects the ARMv8.0 profile');
requireText(clickhouseCompatBuild, /NO_ARMV81_OR_HIGHER/u, 'compat build verifies the CMake compatibility profile');
requireText(clickhouseCompatBuild, /sha256sum/u, 'compat build records its binary checksum');
requireText(installer, /\/proc\/config\.gz/u, 'installer supports IKCONFIG kernel configuration');
requireText(installer, /clickhouse\/bin\/clickhouse" --version/u, 'installer executes ClickHouse during preflight');
```

- [ ] Run `pnpm verify:uos20-arm64-package` and confirm it fails only for the missing compatibility behavior.

Expected: nonzero exit with failures naming the absent compat builder and preflight contracts.

### Task 2: Implement the pinned ClickHouse compat build

**Files:**
- Create: `packaging/uos20-arm64/build-clickhouse-compat.sh`
- Modify: `packaging/uos20-arm64/build-clickhouse.sh`
- Modify: `packaging/uos20-arm64/build-release.sh`

- [ ] Implement a cacheable source checkout fixed at `v24.8.14.39-lts` / `502d03925cf2c9c6629ed5c1b2d16b5de46e4362`.

```bash
git clone --filter=blob:none --no-checkout https://github.com/ClickHouse/ClickHouse.git "$SOURCE_DIR"
git -C "$SOURCE_DIR" fetch --depth 1 origin "$CLICKHOUSE_COMMIT"
git -C "$SOURCE_DIR" checkout --detach "$CLICKHOUSE_COMMIT"
git -C "$SOURCE_DIR" submodule update --init --recursive --depth 1
```

- [ ] Invoke `docker/packager/packager` with `--compiler clang-18-aarch64-v80compat --package-type binary` and a pinned builder image reference.

```bash
python3 "$SOURCE_DIR/docker/packager/packager" \
  --package-type binary \
  --compiler clang-18-aarch64-v80compat \
  --docker-image-version "$CLICKHOUSE_BUILDER_IMAGE" \
  --output-dir "$OUTPUT_DIR"
```

- [ ] Validate the produced binary with `check-elf.sh`, reject embedded modern ARM compiler flags, and write `VERSION`, `SOURCE_COMMIT`, `PROFILE`, and `SHA256` metadata.

```bash
"$SCRIPT_DIR/check-elf.sh" "$binary"
! strings "$binary" | grep -Fq -- '-march=armv8.2-a+simd+crypto+dotprod+ssbs+rcpc'
sha256sum "$binary" > "$CACHE_DIR/clickhouse.sha256"
printf '%s\n' 'armv8.0-compat' > "$CACHE_DIR/PROFILE"
```

- [ ] Change release staging to verify and copy only that compat cache, while continuing to extract matching XML configuration from the immutable server image.

```bash
(cd "$COMPAT_DIR" && sha256sum --check clickhouse.sha256)
install -m 0755 "$COMPAT_DIR/clickhouse" "$STAGE_DIR/clickhouse/bin/clickhouse"
docker cp "$container:/etc/clickhouse-server/." "$STAGE_DIR/clickhouse/etc/"
```

- [ ] Record `CLICKHOUSE_SOURCE_COMMIT`, `CLICKHOUSE_ARM_PROFILE`, and `CLICKHOUSE_BINARY_SHA256` in the release `VERSION` file.

Expected `VERSION` entries:

```text
CLICKHOUSE_SOURCE_COMMIT=502d03925cf2c9c6629ed5c1b2d16b5de46e4362
CLICKHOUSE_ARM_PROFILE=armv8.0-compat
CLICKHOUSE_BINARY_SHA256=<64 lowercase hexadecimal characters>
```

### Task 3: Fail target preflight before mutations

**Files:**
- Modify: `packaging/uos20-arm64/install.sh`
- Modify: `packaging/uos20-arm64/README.md`

- [ ] Resolve kernel config from `/boot/config-$(uname -r)` using `grep`, or `/proc/config.gz` using `zgrep`.

```bash
if [ -r "/boot/config-$(uname -r)" ]; then
  kernel_config="/boot/config-$(uname -r)"
  kernel_config_reader=grep
elif [ -r /proc/config.gz ]; then
  kernel_config=/proc/config.gz
  kernel_config_reader=zgrep
else
  fail "kernel configuration is not readable from /boot/config-$(uname -r) or /proc/config.gz"
fi
```

- [ ] After manifest verification, run bundled Node and ClickHouse `--version`; report the captured error and fail on any nonzero exit.

```bash
node_version=$("$PACKAGE_ROOT/runtime/node/bin/node" --version 2>&1) \
  || fail "bundled Node runtime cannot execute on this host: $node_version"
clickhouse_version=$("$PACKAGE_ROOT/clickhouse/bin/clickhouse" --version 2>&1) \
  || fail "bundled ClickHouse cannot execute on this CPU: $clickhouse_version"
```

- [ ] Document the compat profile, runtime preflight, recovery from the failed 0.1.0 install, and revisioned output names.

Add commands to stop the failed services, verify the revisioned archive, run `--check`, and reinstall while preserving `/etc/anysentry` and `/var/lib/anysentry`.

- [ ] Run `pnpm verify:uos20-arm64-package` and confirm all compatibility contracts pass.

Expected: `UOS 20 ARM64 package verification passed` and exit 0.

### Task 4: Build the complete revisioned release

**Files:**
- Generated: `.build/uos20-arm64/clickhouse-compat/`
- Generated: `release/anysentry-security-suite-0.1.0-compat1-uos20-arm64/`
- Generated: `release/anysentry-security-suite-0.1.0-compat1-uos20-arm64.tar.gz`
- Generated: `release/anysentry-security-suite-0.1.0-compat1-uos20-arm64.tar.gz.sha256`

- [ ] Build the pinned ClickHouse compat cache with `packaging/uos20-arm64/build-clickhouse-compat.sh`.

```bash
packaging/uos20-arm64/build-clickhouse-compat.sh
```

- [ ] Commit reviewed source changes so the provenance release builder sees a clean tree.

```bash
git add packaging/uos20-arm64 scripts/verify-uos20-arm64-package.mjs docs/superpowers/plans/2026-07-14-uos20-arm64-clickhouse-compat.md
git commit -m "fix: package ARMv8.0-compatible ClickHouse"
```

- [ ] Run `ANYSENTRY_RELEASE_VERSION=0.1.0-compat1 pnpm build:uos20-arm64-package`.

Expected: the builder prints the release directory, archive, and checksum paths and exits 0.

- [ ] Monitor resource consumption and preserve the build cache for reproducibility.

```bash
df -h "$PWD"
du -sh .build/uos20-arm64/clickhouse-* release
```

### Task 5: Verify the deliverables

**Files:**
- Verify: `release/anysentry-security-suite-0.1.0-compat1-uos20-arm64.tar.gz`
- Verify: `release/anysentry-security-suite-0.1.0-compat1-uos20-arm64.tar.gz.sha256`

- [ ] Run the repository contract verifier from a clean tree.

```bash
git status --short
pnpm verify:uos20-arm64-package
```

- [ ] Verify the archive SHA256 file.

```bash
(cd release && sha256sum -c anysentry-security-suite-0.1.0-compat1-uos20-arm64.tar.gz.sha256)
```

- [ ] Extract the archive to a fresh directory and run `sha256sum --check manifest.sha256`.

```bash
tar -xzf "$archive" -C "$fresh_dir"
(cd "$fresh_dir/anysentry-security-suite-0.1.0-compat1-uos20-arm64" && sha256sum --check manifest.sha256)
```

- [ ] Re-run `check-elf.sh` for every ELF in the fresh extraction.

```bash
while IFS= read -r -d '' file; do
  if readelf -h "$file" >/dev/null 2>&1; then
    packaging/uos20-arm64/check-elf.sh "$file"
  fi
done < <(find "$fresh_dir" -type f -print0)
```

- [ ] Confirm `VERSION` records the compat source/profile/hash and that the staged binary does not contain the modern ARM compiler profile.

```bash
grep '^CLICKHOUSE_' "$stage/VERSION"
! strings "$stage/clickhouse/bin/clickhouse" | grep -Fq -- '-march=armv8.2-a+simd+crypto+dotprod+ssbs+rcpc'
```

- [ ] Run the ClickHouse binary with an AArch64 QEMU runtime if supported by the build host and record any target-only residual acceptance condition explicitly.

```bash
docker run --rm --platform linux/arm64 -v "$stage:/suite:ro" debian:10-slim /suite/clickhouse/bin/clickhouse --version
```

- [ ] Report absolute clickable paths, file sizes, and SHA256 values for direct download.

Expected: both files exist under the workspace `release/` directory; the reported archive hash exactly matches the `.sha256` sidecar.
