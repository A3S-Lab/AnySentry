# Modular development and test deployment

This is a development path, not a replacement for the canonical release manifests. Keep the
production `Dockerfile`, `docker-compose.yml`, and Kubernetes YAML immutable until the component
changes have passed local tests and the final Docker end-to-end gate.

## Test order

1. Run the smallest local unit and contract tests for the changed module. Do not build Docker here.
2. Run local module tests: Forwarder replay, API persistence adapter tests, Observer collector smoke,
   and `mvn test` for Flink as applicable.
3. After all planned features pass, render this Compose overlay and build only the affected targets.
4. Run the modular Docker end-to-end flow. Build immutable production images and run Kubernetes
   rollout validation only after this gate passes.

## Render and build

All Compose commands put the canonical file first so paths in this overlay resolve from the repo
root:

```bash
docker compose \
  -f docker-compose.yml \
  -f deploy/docker-compose.modules.yml \
  config

# Build one component without rebuilding stable infrastructure.
docker compose -f docker-compose.yml -f deploy/docker-compose.modules.yml build anysentry
docker compose -f docker-compose.yml -f deploy/docker-compose.modules.yml build fast-judge
docker compose -f docker-compose.yml -f deploy/docker-compose.modules.yml build web
docker compose -f docker-compose.yml -f deploy/docker-compose.modules.yml build flink-job-submit
```

The build targets share the lockfile-keyed `node-dependencies` layer. API and Worker are separate
images, while all Node Worker roles intentionally share one Worker image because they consume the
same API `dist` with different commands. A change to shared Worker code requires restarting every
affected Worker role; image separation does not remove that source-level dependency.

For the fastest TypeScript-only loop, compile on the host and add the optional read-only dist
overlay; no Docker build is involved:

```bash
pnpm --filter @anysentry/api build
docker compose \
  -f docker-compose.yml \
  -f deploy/docker-compose.modules.yml \
  -f deploy/modules/node-dist-dev.yml \
  up -d --no-deps --force-recreate anysentry stream-worker
```

Only include the Worker roles whose loaded code changed. Dependency or package-manifest changes
still require rebuilding the corresponding module image.

## Start and restart one component

Start the stable data plane once, then replace only the service under test:

```bash
docker compose -f docker-compose.yml -f deploy/docker-compose.modules.yml up -d clickhouse redis postgres
docker compose -f docker-compose.yml -f deploy/docker-compose.modules.yml up -d --no-deps anysentry
docker compose -f docker-compose.yml -f deploy/docker-compose.modules.yml up -d --no-deps web
docker compose -f docker-compose.yml -f deploy/docker-compose.modules.yml up -d --no-deps fast-judge
```

The API remains available on `http://127.0.0.1:29653`; the independently built Web proxy is on
`http://127.0.0.1:29654` by default. The Web proxy preserves same-origin `/security-center`, `/open`,
and `/api` requests while serving SPA routes from its own image.

Run only one mutating Compose command at a time for a given project name. `--no-deps` prevents a
targeted service update from recreating its dependencies, but two concurrent `build`, `up`, or
`restart` commands can still contend on Compose's replace transaction and create a temporary service
DNS gap. Finish and verify one component replacement before starting the next.

Before starting the modular Observer in S5 shadow/enforce mode, bootstrap its managed Source. The
output is a gitignored `0600` env file consumed by `docker-compose.modules.yml`; no token belongs in
a Compose file or shell history:

```bash
export ANYSENTRY_MANAGEMENT_TOKEN="$(openssl rand -hex 32)"
docker compose -f docker-compose.yml -f deploy/docker-compose.modules.yml up -d --no-deps anysentry
ANYSENTRY_API_BASE=http://127.0.0.1:29653/security-center \
ANYSENTRY_MANAGEMENT_TOKEN="$ANYSENTRY_MANAGEMENT_TOKEN" \
ANYSENTRY_OBSERVER_COLLECTOR_IDS=modules-observer \
ANYSENTRY_OBSERVER_AUTH_FORMAT=env \
ANYSENTRY_OBSERVER_AUTH_OUTPUT=.local/observer-auth.env \
  node scripts/bootstrap-observer-sources.mjs
docker compose -f docker-compose.yml -f deploy/docker-compose.modules.yml up -d --no-deps observer
```

## Full modular validation stack

After the module tests and the separate FileAccess/FileDelete canaries pass, use
`all-features.yml` for the final Docker gate. It enables the non-legacy API capabilities, every
Worker role, Kafka/Flink streaming, Supply Chain runtime correlation, the unprivileged Workspace
Scanner, and the complete Observer probe set:

```bash
export ANYSENTRY_WORKSPACE_SCANNER_TOKEN='<random value with at least 32 characters>'
export ANYSENTRY_WEB_PORT=39657 # only needed when the default 29654 is occupied

docker compose -p anysentry-modules-experiment \
  -f docker-compose.yml \
  -f deploy/docker-compose.modules.yml \
  -f deploy/modules/node-dist-dev.yml \
  -f deploy/modules/kube-identity-dev.yml \
  -f deploy/modules/all-features.yml \
  --profile streaming \
  --profile observer \
  config --quiet
```

The Scanner token is intentionally required and must be supplied to both the API and Scanner at
render time; do not commit it. Configure the reviewed fast, deep, and Assistant model variables in
the environment before starting their services. Build or recreate only the changed component, then
start Observer last so its loss window can be measured independently.

The full overlay attaches OpenSSL uprobes to
`${A3S_OBSERVER_HOST_LIBSSL:-/usr/lib/x86_64-linux-gnu/libssl.so.3}` and bind-mounts that exact host
inode. This covers processes using that host OpenSSL library. Container-private OpenSSL inodes,
BoringSSL, Go TLS, and statically linked TLS require separate library discovery and are not implied
by this single attachment.

## Observer boundary

The `observer-wrapper` target is a thin layer over `ANYSENTRY_OBSERVER_COLLECTOR_IMAGE`. Its scripts
are bind-mounted from the checkout in this development overlay. Validate JS first, then restart the
whole Observer service:

```bash
docker compose --profile observer \
  -f docker-compose.yml \
  -f deploy/docker-compose.modules.yml \
  up -d --no-deps observer
```

This is deliberately **not** described as a lossless Forwarder-only restart. The current Supervisor
owns a direct Collector stdout-to-Forwarder stdin pipe; a Forwarder exit also terminates the
Collector. A true Forwarder-only restart requires a durable relay/spool and ACK protocol first.
File probes default to off in this overlay. Run the bounded shadow canary explicitly after the
filtering and downstream capacity gates pass:

```bash
ANYSENTRY_OBSERVER_WRAPPER_IMAGE=anysentry-observer-wrapper:modules-local \
docker compose -p anysentry-modules-e2e \
  -f docker-compose.yml \
  -f deploy/docker-compose.modules.yml \
  -f deploy/modules/observer-file-canary.yml \
  --profile observer up -d --no-deps observer
```

The canary enables FileAccess while independently keeping FileDelete off, pins Unknown to lossless
`keep`, and enforces only the already-audited authoritative Infrastructure cgroups. Capacity must
come from those drops, exact duplicate aggregation, and 64-row/50-ms batching—not from sampling
Unknown evidence. FileDelete has its own
canary and ring test, so the two load sources remain attributable. Do not enable both until two
separate heartbeat windows show a loaded filter epoch and zero access/delete ring, Forwarder
output, queue, and retry-exhaustion loss.

## Flink job boundary

JobManager, TaskManager, and checkpoint initialization use the stable
`ANYSENTRY_FLINK_RUNTIME_IMAGE`. Only `flink-job-submit` contains the AnySentry business JAR. After
`mvn test` succeeds, rebuild and restart only the submission service:

```bash
docker compose --profile streaming \
  -f docker-compose.yml \
  -f deploy/docker-compose.modules.yml \
  build flink-job-submit
docker compose --profile streaming \
  -f docker-compose.yml \
  -f deploy/docker-compose.modules.yml \
  up -d --no-deps flink-job-submit
```

The development submitter cancels the exact-name running job and uploads the new JAR; it does not
restart JobManager or TaskManager. Set `ANYSENTRY_FLINK_RESTORE_PATH` to an explicit compatible
savepoint when state restoration is required. Without it, replacement intentionally starts the new
job without claiming checkpoint/savepoint continuity.
