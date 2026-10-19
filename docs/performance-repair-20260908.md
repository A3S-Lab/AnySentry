# Performance repair — 2026-09-08, first tranche

## Boundaries

Do not trade coverage, durable acknowledgment, L1 latency, or UI freshness for lower resource use.
Do not compare different loads as a strict A/B. Existing workspace changes are preserved.
The first tranche did not restart Observer, API, JobManager or TaskManager. The second tranche
replaced only the API to deliver the tested PostgreSQL predicates; see its shutdown caveat below.

## 1. PostgreSQL unchanged business records (deployed 2026-09-08 14:04 local time)

Alert, Incident and Remediation UPSERTs now skip identical records while retaining the timestamp
guard, same-timestamp payload corrections and earliest/latest time aggregation. This reduces
unnecessary row versions; it does NOT remove full snapshot serialization or ClickHouse config writes.
No schema migration, in-memory correctness cache, retention change or early acknowledgment added.

Validation:

```sh
pnpm build:api
node scripts/verify-business-noop-writes.mjs
node scripts/verify-persistence-single-flight.mjs
```

The SQL test uses actual generated queries against connection-local PostgreSQL TEMP tables in a
transaction, then rolls back. Per entity, 100 duplicate updates before become 0 after. New revisions,
equal-timestamp corrections and stale-write rejection pass. This is a row-update/correctness test,
NOT a measurement of production WAL bytes (TEMP tables are not ordinary WAL-logged tables).
Deployment copied only the three predicates into a module extracted from the running API image,
not the full dirty worktree. The exact deployment module was also exercised by the same SQL test:

```sh
ANYSENTRY_TEST_STORE_FILE=/tmp/anysentry-api-noop.jbsR8V/relational-business-store.service.js \
  node scripts/verify-business-noop-writes.mjs
```

Running artifact SHA-256: `04866325fc0ca0b1473f87c1b6bc2617d60f57f246db8d62ce703dbd03a69f86`.
Current image: `anysentry-api:noop-20260908`; rollback image: `anysentry-api:pre-noop-20260908`.
The rollout retained the environment, read-only session/token mounts, host PID mode, network and
2 GiB limit. Compose files used:

```sh
docker compose -f docker-compose.yml -f deploy/docker-compose.modules.yml \
  -f docker-compose.override.yml -f /tmp/anysentry-api-noop-rollout.yml \
  up -d --no-deps --no-build anysentry
```

The temporary overlay selects the patch image and a 60-second stop grace period. To roll back,
change only its image to `anysentry-api:pre-noop-20260908` and repeat the scoped command, but resolve
the shutdown gate below before another routine restart. Other images/services were not changed.

### Live measurements (not fixed-load A/B)

- Before, UTC 06:00:44.269–06:01:56.184: alerts +20,892 updates / 71.915 s = ~290.5/s.
- After, UTC 06:05:07.236–06:05:52.462: alerts +329 / 45.227 s = 7.27/s;
  Incidents +0; Remediations +19 = 0.42/s.
- Repeat, UTC 06:06:18.441–06:07:03.628: alerts +359 / 45.188 s = 7.94/s;
  Incidents +36 = 0.80/s; Remediations +25 = 0.55/s and one new row inserted.
  Checked status/severity versus canonical record: zero mismatches in all three tables.
- Current one-minute monitoring sample at UTC ~06:06:19: CPU I/O wait 0.104%, NVMe busy 2.03%,
  writes 8.36 MB/s. This alone does not establish causal whole-host speedup.
- Observer stayed running; inspected minute windows had zero output/interaction/inbox drops.
  Recovery health reported PostgreSQL/ClickHouse ready and an empty event queue at the sampled instant.

Repeat the read-only database measurement with:

```sh
node scripts/measure-business-write-rate.mjs 45
```

### New shutdown gate — unresolved

The previous API received SIGTERM but ultimately SIGKILL (exit 137). Therefore the rollout was NOT
proved graceful or zero-loss. Source inspection shows new HTTP work is not explicitly gated before
Nest provider teardown, and Alert shutdown awaits its persistence loop; this is a candidate for
shutdown starvation, not a proven sole cause. Coordinated admission stop, in-flight receipt drain,
background-producer shutdown and storage close ordering need a separate fault test before another
routine rollout. Recovery queue emptiness and zero Collector drops do not prove every pre-kill
receipt was recovered. Audit producer WAL/Kafka acknowledgments for the boundary.

Session Process candidate ClickHouse queries also still time out around the five-second budget.
The three-predicate patch does not fix that query path. New snapshots/projections must be evaluated
separately, without mixing other sessions' pending source changes into this deployment.

## 2. Flink submission controller (deployed independently)

The normal Compose/Kubernetes guard now uses one long-lived Node process and REST JSON parsing.
Healthy/recovering jobs do not spawn a CLI JVM. Invalid responses, unknown states and network errors
never count as absence. Two consecutive missing observations plus a pre-submit check are required.
CLI timeout/failure gets a cooldown because the submission may already have succeeded.

This is a single-controller design, NOT distributed submission exactly-once. Keep one replica and
Recreate strategy; externally concurrent submitters still need ownership coordination.
The modules replacement script retains its explicit deployment replacement behavior; only its
steady-state loop and initial submission delegate to the guard.

Validation:

```sh
node scripts/verify-flink-job-guard.mjs
node scripts/verify-deployment-manifests.mjs
bash -n deploy/modules/flink-job-replace.sh
docker compose -f docker-compose.yml --profile streaming config --quiet
```

Before: one real `flink list` took 2.128 s wall / 4.187 s CLI CPU.
After: three real REST checks together took 245 ms wall / 66 ms client CPU.
This measures the checking operation, not whole-host speedup.
Post-deployment 45.105 s sample: controller CPU increased by 33,622 microseconds, averaging
0.0745% of one core. Restart count stayed zero; the same job and all 20 running tasks were confirmed.

Built `streaming/flink/Dockerfile.guard` over the previously deployed business-job image; no Maven
rebuild or business JAR change. Only `flink-job-submit` was recreated, retaining all application
environment values, its network, and the 512 MiB memory limit. Job ID
`6eccf32a0b51894d40d3a38638e49c5f` stayed unchanged and all 20 tasks remained RUNNING.

Local image tags:

- Current: `anysentry-flink-streaming:guard-20260908` (also tagged `:local`).
- Previous, retained: `anysentry-flink-streaming:pre-guard-20260908`.
- Rollout overlay: `/tmp/anysentry-flink-guard-rollout.yml`.

The existing implicit local Compose override cannot validate on its own because its Observer
service lacks an image/build declaration. Explicit `-f docker-compose.yml` was used after checking
that the submit service environment and mounts match the old container. Do not use `--remove-orphans`.
To roll back the controller, use the previous image AND its previous CLI entrypoint/command;
changing only the image is insufficient because the previous image does not contain the new guard.

## Remaining work — not completed by this tranche

### Third tranche: shutdown coordination (source/tests, not deployed)

Added `shared/http-shutdown.ts`: shutdown admission returns 503/Retry-After before body parsing,
tracks controller completion separately from client disconnect, ends read-only SSE subscriptions,
then calls Nest close. Repeated signals share one shutdown. HTTP drain budget is 20 seconds,
provider close budget 30 seconds; explicit incomplete diagnostics and nonzero exit replace a
silent wait for external SIGKILL. These deadlines do not prove recovery or cancel pending commits;
an incomplete shutdown still requires upstream replay auditing.

Moved final Alert/Remediation/Judge persistence to `beforeApplicationShutdown`, after producer
destroy hooks. PostgreSQL and ClickHouse shared clients close in `onApplicationShutdown`.
PostgreSQL cannot reopen after final shutdown. API Compose/Kubernetes grace is now 60 seconds.

Tests use a separate output directory because another build cleared shared `dist` during testing:

```sh
pnpm --filter @anysentry/api exec tsc -p tsconfig.json --outDir dist-shutdown-test --incremental false
ANYSENTRY_TEST_BUILD=dist-shutdown-test node scripts/verify-shutdown-lifecycle.mjs
ANYSENTRY_TEST_BUILD=dist-shutdown-test node scripts/verify-http-shutdown.mjs
ANYSENTRY_TEST_BUILD=dist-shutdown-test node scripts/verify-clickhouse-write-buffer.mjs
node scripts/verify-deployment-manifests.mjs
```

Real isolated Nest lifecycle test verifies producer completion before final saves and both shared
clients closing last. Real child-process signal tests cover pre-existing durable work, new-request
503, disconnected in-flight write, duplicate signals, SSE completion and both deadline failures.
Write-buffer test now scopes an explicit 100ms shutdown configuration for its short-deadline
fixture; setting the internal field alone was overridden by `close()` configuration loading.

Not yet claimed: full production writer/queue crash recovery, unchanged hot-path latency under
fixed load, or a graceful production rollout. These remain gates before deploying this tranche.

1. Resolve and fault-test shutdown/receipt draining; repeat fixed-load update/WAL measurements.
2. Replace full business-state dual writes with transactional incremental persistence/outbox; audit
   every reader and failure/replay contract before removing migration copies.
3. Segmented WAL/group commit plus dedicated I/O ownership, with crash/replay and capacity tests.
4. Control-plane versioned snapshots and Session background projections with revision-aware deltas.
5. Repeat end-to-end visibility/ack/CPU/I/O measurements without changing collection coverage.
