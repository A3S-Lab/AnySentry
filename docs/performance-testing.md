# AnySentry Performance Testing

This runbook covers repeatable performance tests for AnySentry and the main
runtime dependency chain:

- API health and static dashboard serving.
- Progressive capability discovery and dispatch.
- `@a3s-lab/sentry` event judging through generic ingest and progressive
  `recordSecurityEvents`.
- Event storage and readback through the hot aggregation ring and ClickHouse
  when ClickHouse is configured.
- Dashboard aggregate query set.
- Evidence bundle assembly.
- Optional Kubernetes pod and resource snapshots for AnySentry, ClickHouse, and
  observer pods.

The test runner is dependency-free Node.js:

```bash
pnpm perf:anysentry
```

By default it targets `http://127.0.0.1:29653/security-center`, runs a gentle
baseline load, and writes JSON plus Markdown reports under `perf-results/`.

## Local Baseline

Build the app, start a temporary local API, run the performance suite, and stop
the API:

```bash
pnpm perf:anysentry:local
```

The local mode is useful for regression checks before changing aggregation,
ingest, dashboard serving, policy evaluation, or ClickHouse wiring.

## Deployed Baseline

Point the runner at a deployed API and dashboard. If the API is hosted under a
sub-path, `ANYSENTRY_WEB_BASE` is usually the same origin and path without
`/security-center`.

```bash
ANYSENTRY_API_BASE=https://anysentry.example.com/apps/anysentry/security-center \
ANYSENTRY_WEB_BASE=https://anysentry.example.com/apps/anysentry \
pnpm perf:anysentry
```

To include Kubernetes pod health and optional `kubectl top` samples:

```bash
KUBECONFIG="$HOME/.kube/a3s-cloud.yaml" \
ANYSENTRY_PERF_K8S_NAMESPACE=a3s \
ANYSENTRY_PERF_K8S_SELECTOR='app in (anysentry,clickhouse,a3s-observer)' \
ANYSENTRY_API_BASE=https://anysentry.example.com/apps/anysentry/security-center \
ANYSENTRY_WEB_BASE=https://anysentry.example.com/apps/anysentry \
pnpm perf:anysentry
```

If the cluster does not have metrics-server, the report still includes pod
phase/readiness/restart/image data and records the `kubectl top` error.

## Controls

Use environment variables to scale from smoke to stress:

| Variable | Default | Meaning |
|---|---:|---|
| `ANYSENTRY_PERF_DURATION_MS` | unset | Shared duration override for read and write scenarios. |
| `ANYSENTRY_PERF_READ_DURATION_MS` | `5000` | Duration per read scenario. |
| `ANYSENTRY_PERF_WRITE_DURATION_MS` | `7000` | Duration per write scenario. |
| `ANYSENTRY_PERF_READ_CONCURRENCY` | `4` | Concurrent read workers. |
| `ANYSENTRY_PERF_WRITE_CONCURRENCY` | `2` | Concurrent write workers. |
| `ANYSENTRY_PERF_INGEST_BATCH_SIZE` | `5` | Events per generic ingest request. |
| `ANYSENTRY_PERF_REQUEST_TIMEOUT_MS` | `15000` | Per-request timeout. |
| `ANYSENTRY_PERF_SCENARIOS` | all | Comma-separated scenario names to run. |
| `ANYSENTRY_PERF_REPORT_DIR` | `perf-results` | Report output directory. |
| `ANYSENTRY_PERF_FAIL_ON_THRESHOLD` | unset | Set to `1` to fail on p95/error-rate threshold warnings. |
| `ANYSENTRY_PERF_READ_P95_MS` | `1000` | Read p95 warning/fail threshold. |
| `ANYSENTRY_PERF_WRITE_P95_MS` | `2000` | Write p95 warning/fail threshold. |
| `ANYSENTRY_PERF_ASSET_P95_MS` | `3000` | Dashboard JS/CSS asset p95 warning/fail threshold. |
| `ANYSENTRY_PERF_EVIDENCE_P95_MS` | `5000` | Evidence Bundle p95 warning/fail threshold. |
| `ANYSENTRY_PERF_MAX_ERROR_RATE` | `0` | Error-rate warning/fail threshold. |

Scenario names:

- `healthz`
- `dashboard.index`
- `dashboard.assets`
- `capabilities.discovery`
- `progressive.guard.dryRun`
- `progressive.recordSecurityEvents`
- `ingest.events.batch`
- `events.list`
- `aggregate.dashboard`
- `evidence.bundle`

## Smoke Run

Use this after wiring changes or before running a broader production baseline:

```bash
ANYSENTRY_PERF_DURATION_MS=1000 \
ANYSENTRY_PERF_READ_CONCURRENCY=1 \
ANYSENTRY_PERF_WRITE_CONCURRENCY=1 \
ANYSENTRY_PERF_INGEST_BATCH_SIZE=2 \
pnpm perf:anysentry
```

## Stress Run

Run stress tests only against an environment where extra judged events are
acceptable. The write scenarios create real AnySentry evidence events tagged
with the generated `perf-*` run id.

```bash
ANYSENTRY_PERF_READ_DURATION_MS=30000 \
ANYSENTRY_PERF_WRITE_DURATION_MS=30000 \
ANYSENTRY_PERF_READ_CONCURRENCY=16 \
ANYSENTRY_PERF_WRITE_CONCURRENCY=8 \
ANYSENTRY_PERF_INGEST_BATCH_SIZE=20 \
ANYSENTRY_PERF_FAIL_ON_THRESHOLD=1 \
pnpm perf:anysentry
```

## Report Interpretation

Each report contains:

- Preflight `healthz`, `stats`, dashboard asset discovery, and storage status.
- Per-scenario request throughput, accepted event throughput, bytes/sec, latency
  percentiles, status counts, and first error samples.
- Dependency coverage labels showing which layer each scenario exercises.
- Optional before/after Kubernetes pod snapshots.
- Threshold warnings, or hard failures when `ANYSENTRY_PERF_FAIL_ON_THRESHOLD=1`.

For release comparison, keep the JSON report from the previous known-good build
and compare p95 latency, write event throughput, and error counts for the write
and aggregate scenarios. A broad regression usually appears in
`ingest.events.batch`, `progressive.recordSecurityEvents`, `events.list`, and
`aggregate.dashboard` together; a dashboard-serving regression usually appears
only in `dashboard.index` or `dashboard.assets`.
