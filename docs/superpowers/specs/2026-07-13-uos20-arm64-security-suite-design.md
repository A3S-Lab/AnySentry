# UOS 20 ARM64 Security Suite Offline Package Design

## Goal

Produce one WinSCP-transferable archive that installs AnySentry, ClickHouse, Sentry L1/L2/L3,
the Web dashboard, and Observer on the inspected UnionTech OS Server 20 Enterprise host without
Docker, package-manager access, or Internet access.

## Verified Target

The target is Linux `aarch64`, kernel `4.19.0-arm64-server`, glibc 2.28, 64 KiB pages, 16 Kunpeng
920 CPUs, 64 GiB RAM, systemd 241, and about 34 GiB free on the root filesystem. Ports 29653 and
8123 are free. KVM is unavailable. The kernel enables BPF, BPF syscall/JIT/events, perf events,
kprobes, uprobes, tracepoints, cgroup BPF, bpffs, and debugfs, but exposes neither BTF nor syscall
tracepoints and cannot support BPF ring buffers.

## Runtime Architecture

Observer captures host activity and emits NDJSON. A bundled Node forwarder posts that stream and
collector heartbeats to `http://127.0.0.1:29653/security-center/ingest`. AnySentry normalizes each
event and invokes the embedded ARM64 Sentry SDK. Sentry evaluates L1 rules in process, calls an
OpenAI-compatible model for L2 when configured, and invokes the bundled L3 agent plus security
skills for escalated decisions. ClickHouse stores durable events, and AnySentry serves the API and
Web dashboard on port 29653.

The installed services are:

- `anysentry-clickhouse.service`: unprivileged ClickHouse, loopback-only port 8123.
- `anysentry.service`: unprivileged API/dashboard with bundled Node and Sentry addon.
- `anysentry-observer.service`: capability-constrained root service for legacy eBPF loading and the
  bundled forwarder, ordered after the API.

## Observer Compatibility

The current Observer cannot run on the target because it uses `BPF_MAP_TYPE_RINGBUF` and
`bpf_probe_read_user*`. The target package uses a legacy build that emits through perf-event arrays,
uses helpers available to Linux 4.19, and attempts ARM64-compatible kprobe fallbacks where syscall
tracepoints are absent. Probe attachment is capability-based: installation fails if the collector
cannot capture a real smoke-test execution event, rather than reporting a healthy but blind
collector. Unsupported optional probes are reported in the collector heartbeat.

The modern RingBuf implementation remains available for newer kernels; the release records which
Observer backend was packaged. Enforcement remains disabled by default. The package observes and
judges activity but does not install cgroup/file deny guards without a separate explicit decision.

## LLM And Agent Configuration

The installer accepts an OpenAI-compatible base URL ending at `/v1`, model ID, and optional API
key. Secrets live only in root-readable `/etc/anysentry/anysentry.env`; API reads and dashboard
responses never return the key. L2 appends `/chat/completions`. L3 uses the same endpoint by default
and may later be assigned a different model through the environment file.

If no URL is configured, L1 works and L2/L3 remain disabled. If a URL is configured, the installer
tests `/models` when available and always tests `/chat/completions` for a parseable JSON verdict.
The build uses a local mock OpenAI service because the customer endpoint is not yet available.

## Release Layout

```text
app/                         AnySentry API, Web assets, production dependencies
runtime/node/                ARM64 Node.js 20 runtime
native/                      ARM64 Sentry N-API addon
observer/                    ARM64 legacy collector and backend metadata
l3/                          executable bridge, ARM64 a3s-code package, security skills
clickhouse/                  ARM64 ClickHouse and configuration
config/anysentry.env.example target configuration template
systemd/                     three service units
install.sh                   idempotent root installer and --check preflight
uninstall.sh                 retains data unless --purge-data is explicit
verify.sh                    ABI, service, storage, L1, L2/L3, and Observer checks
manifest.sha256              every staged file
VERSION                      all source commits, target ABI, and build provenance
README.md                    WinSCP, configuration, installation, API, and diagnostics runbook
```

## Installation And State

Programs install under `/opt/anysentry`, secrets under `/etc/anysentry`, ClickHouse data under
`/var/lib/anysentry`, and logs under `/var/log/anysentry`. The installer checks architecture,
glibc, 64 KiB ELF compatibility, disk, commands, systemd, kernel BPF features, trace/kprobe access,
and ports before mutation. It generates independent 256-bit ClickHouse, management, and Source
tokens when not supplied.

Installation is staged and idempotent. Existing secrets and data are preserved during upgrades.
Uninstall preserves data and configuration by default; `--purge-data` is required to delete them.

## Verification

Source contracts are test-first. The build validates every ARM64 ELF and native library against
glibc 2.28 and 64 KiB load-segment alignment. QEMU on Rocky Linux 8 runs Node, Sentry, ClickHouse,
the API/dashboard, L1 decisions, persistence, and a mock-backed L2/L3 chain. Static Observer tests
verify absence of RingBuf and new-kernel-only helpers in the legacy object. Because the local build
host cannot reproduce the customer's UOS kernel, final Observer acceptance is an installer smoke
test on the customer host that must capture and query a generated process event.

## Delivery Criteria

Delivery consists of the versioned `.tar.gz`, its `.sha256`, a clean `SOURCE_DIRTY=false` provenance
record, and the runbook. Installation is accepted only when ClickHouse storage is ready, management
authentication is enabled, the dashboard loads, L1 blocks the metadata-egress probe, configured
L2/L3 return model-backed decisions, and Observer reports at least one attached effective probe and
the generated smoke event appears in AnySentry.
