# Deploying AnySentry + a3s-observer on Kubernetes

This deployment runs the complete event, judgment, streaming-correlation, and supply-chain stack:

```
 a3s-observer (every node)
          │
          ▼
 AnySentry API ──▶ Redis/BullMQ ──▶ Fast Judge / L3 Worker
          │
          ├──▶ ClickHouse
          │
          └──▶ Kafka ──▶ Flink ──▶ Stream Worker / Composite Judge
                         ▲
                         └──────── OSV assessment context
```

`deploy/anysentry.yaml` contains ClickHouse, Redis, the API, and single-event judge workers.
`deploy/streaming.yaml` contains Kafka, Flink, stream/composite workers, and the OSV assessment
worker. The bundled stateful services are a complete single-cluster baseline. Production fleets
should normally replace single-node ClickHouse, Redis, and Kafka with managed HA services.

## Prerequisites

- A Kubernetes cluster with a default RWO StorageClass for ClickHouse, Redis, and Kafka.
- An RWX-capable StorageClass for the bundled Flink checkpoint PVC. For production, use an object
  store checkpoint URI instead of a shared filesystem.
- **amd64 nodes** — `@a3s-lab/sentry` bundles a `linux-x64-gnu` binary requiring **GLIBC_2.39**, so
  the AnySentry runtime image is `ubuntu:24.04` (there is no linux-arm64 build).
- `kubectl` configured for your cluster.
- Published AnySentry, Flink-job, and observer images accessible to every cluster node.

## One-command install

The repo includes `deploy/install.sh` for the integrated middleware stack:

```bash
deploy/install.sh docker

ANYSENTRY_INSTALL_MODE=kubernetes \
CLICKHOUSE_PASSWORD="$(openssl rand -hex 16)" \
ANYSENTRY_FLINK_IMAGE=<your-registry>/anysentry-flink-streaming:<version> \
deploy/install.sh
```

Kubernetes mode creates the namespace and ClickHouse Secret, applies both core and streaming
manifests, applies the observe-only observer DaemonSet, optionally applies Ingress with
`ANYSENTRY_APPLY_INGRESS=1`, and waits for every workload to become available.

## 1. AnySentry image

Use the public image `ghcr.io/a3s-lab/anysentry:latest` (referenced by `deploy/anysentry.yaml`),
or build and push your own from the repo root:

```bash
docker build -t <your-registry>/anysentry:latest .
docker push    <your-registry>/anysentry:latest
# then set the `image:` in deploy/anysentry.yaml to your tag
```

The repo-root `Dockerfile` produces a standalone image with pnpm (corepack) — no extra steps.

Build and publish the Flink job image as well:

```bash
docker build -t <your-registry>/anysentry-flink-streaming:latest streaming/flink
docker push <your-registry>/anysentry-flink-streaming:latest
```

Pass immutable image references to the installer:

```bash
ANYSENTRY_IMAGE=<your-registry>/anysentry:<version> \
ANYSENTRY_FLINK_IMAGE=<your-registry>/anysentry-flink-streaming:<version> \
ANYSENTRY_OBSERVER_IMAGE=<your-registry>/anysentry-observer:<version> \
ANYSENTRY_INSTALL_MODE=kubernetes \
CLICKHOUSE_PASSWORD="$(openssl rand -hex 16)" \
deploy/install.sh
```

## 2. Create the namespace and ClickHouse credentials

The manifest reads ClickHouse credentials from a Secret named `anysentry-clickhouse`. Create it
before applying (choose your own password):

```bash
kubectl create namespace anysentry
kubectl -n anysentry create secret generic anysentry-clickhouse \
  --from-literal=CLICKHOUSE_USER=anysentry \
  --from-literal=CLICKHOUSE_PASSWORD='change-me'
```

L2/L3 model keys are deployment secrets too: do not put them in the policy document or a
ConfigMap. When Redis plus asynchronous judgment workers are installed, create a dedicated Secret
and expose it to every process that actually calls the model:

```bash
kubectl -n anysentry create secret generic anysentry-model-credentials \
  --from-literal=A3S_SENTRY_LLM_KEY='<fast-review-key>' \
  --from-literal=A3S_SENTRY_L3_KEY='<deep-investigation-key>' \
  --from-literal=ANYSENTRY_COMPOSITE_LLM_KEY='<composite-review-key>'
```

The manifests load this Secret optionally into only the processes that call models. Add model URL
and model ID keys to the same Secret, or configure them from the policy page. UI-provided keys
remain memory-only and are synchronized to workers through Redis Pub/Sub, so they must be entered
again after the API restarts.

## 3. Deploy the complete stack

```bash
kubectl -n anysentry apply -f deploy/anysentry.yaml
kubectl -n anysentry apply -f deploy/streaming.yaml
kubectl -n anysentry rollout status deploy/clickhouse
kubectl -n anysentry rollout status statefulset/redis
kubectl -n anysentry rollout status statefulset/kafka
kubectl -n anysentry rollout status deploy/anysentry
kubectl -n anysentry rollout status deploy/fast-judge
kubectl -n anysentry rollout status deploy/l3-worker
kubectl -n anysentry rollout status deploy/flink-jobmanager
kubectl -n anysentry rollout status deploy/flink-taskmanager
kubectl -n anysentry rollout status deploy/stream-worker
kubectl -n anysentry rollout status deploy/composite-judge
kubectl -n anysentry rollout status deploy/supply-chain-assessment
```

The API may hydrate ClickHouse history during startup. Its `startupProbe` allows up to 180 seconds
and prevents liveness/readiness checks from killing it during that warm-up. After startup,
readiness controls traffic admission and liveness only restarts an unresponsive process.

Reach the dashboard:

```bash
kubectl -n anysentry port-forward svc/anysentry 29653:29653
# browse http://localhost:29653
```

To expose it outside the cluster instead, edit and apply `deploy/ingress.yaml` (set
`ingressClassName` + a host for your Ingress controller).

### Optional management API auth

Set `ANYSENTRY_ADMIN_TOKEN` to require an operator token for control-plane writes such as Source
management, policy saves, Maintenance windows, Notifications, Objectives, and Incident / Alert /
Remediation updates. Keep it in a Kubernetes Secret and inject it into the AnySentry Deployment, for
example:

```bash
kubectl -n anysentry create secret generic anysentry-admin \
  --from-literal=ANYSENTRY_ADMIN_TOKEN='<long-random-token>'
```

The AnySentry Deployment already references this Secret with `optional: true`; creating it and
restarting the API is sufficient. Read APIs and producer paths (`/security-center/ingest`,
Collector heartbeat, Source check-in) remain on Source identity and Source ingest tokens.

### PostgreSQL for mutable business state

Agent metadata and human identity reviews use PostgreSQL when `ANYSENTRY_DATABASE_URL` is
configured. Use a managed or separately operated PostgreSQL service in production and create the
optional database Secret before deploying the API:

```bash
kubectl -n anysentry create secret generic anysentry-database \
  --from-literal=ANYSENTRY_DATABASE_URL='postgresql://user:password@postgres.example:5432/anysentry'
```

The API creates its bounded Agent metadata table on first connection. During the migration it also
keeps the ClickHouse copy and can start without this Secret, but production should alert when
`healthz.businessState.postgresqlReady` is false. Do not store database credentials in the
ConfigMap or commit them to the repository.

### Using an external ClickHouse

To use your own ClickHouse instead of the bundled one, delete the ClickHouse `Deployment`,
`Service`, and `PersistentVolumeClaim` from `deploy/anysentry.yaml`, then set `CLICKHOUSE_URL` on
the AnySentry Deployment to your server, e.g. `http://my-clickhouse.db.svc.cluster.local:8123`.
Keep `CLICKHOUSE_DB`, `CLICKHOUSE_USER`, and `CLICKHOUSE_PASSWORD` pointing at credentials that
server accepts. If `CLICKHOUSE_URL` is unset entirely, AnySentry runs in-memory only (no durability
across restarts).

## 4. Forward observer events (optional but recommended)

Build the forwarder image (public a3s-observer + the node forwarder from
`scripts/observer-forward.js`) and push it to your registry:

```bash
docker build -f deploy/observer-forwarder.Dockerfile -t <your-registry>/anysentry-observer:latest .
docker push <your-registry>/anysentry-observer:latest
```

Set the `image:` in `deploy/observer.yaml` to that tag (or use the published
`ghcr.io/a3s-lab/anysentry-observer:latest` if available). The canonical DaemonSet intentionally
requires `anysentry-control-auth` and `anysentry-observer-auth` Secrets: CaptureAggregate and
Capture Profile grants must never rely on an anonymous/discovered Source. The integrated installer
generates the management secret, creates one exact managed Observer Source per node, stores the
credentials in a read-only Secret, and only then starts the DaemonSet:

```bash
ANYSENTRY_INSTALL_MODE=kubernetes deploy/install.sh
kubectl -n anysentry get pods -l app=a3s-observer -o wide
```

For a manual deployment, follow the same order: create `anysentry-control-auth`, start the API,
run `scripts/bootstrap-observer-sources.mjs` for the exact node names, create
`anysentry-observer-auth` from its JSON output, then apply `deploy/observer.yaml`. The generated
file is sensitive and must remain outside the repository with mode `0600`.

Events appear on the dashboard within seconds as workloads on the nodes run tools, make egress,
touch files, or escalate privileges.

The DaemonSet sets `A3S_OBSERVER_COLLECTOR_ID` and `A3S_NODE_NAME` from Kubernetes `spec.nodeName`,
so every node appears as a stable Collector. The bundled forwarder also emits source-aware
heartbeats every `ANYSENTRY_HEARTBEAT_SECS` seconds. The Forwarder selects its exact node entry from
`ANYSENTRY_SOURCE_CREDENTIALS_FILE`; a token for one Collector cannot publish trusted summaries as
another Collector.

The manifest initially configures `FORWARD_FILTER_MODE=shadow`,
`FORWARD_RETAIN_UNKNOWN=true`, `FORWARD_RETAIN_NON_AGENT=false`, and
`FORWARD_NOISE_POLICY=balanced`. The forwarder checks the versioned Kubernetes workload
snapshot before host process signatures and PID ancestry. A generic `node` or `python` process in
an Agent container is therefore attributed by Pod UID + full Container ID, while a sidecar can be
classified separately. Unknown identities and positively identified non-Agent decisions remain
observable during this comparison. Events are sent in bounded batches (32 events or 50 ms), and
heartbeats report classification, cache, queue, batch, filtered, and dropped counters.
`FORWARD_MAX_OUTSTANDING_EVENTS` and `FORWARD_MAX_OUTSTANDING_BYTES` bound the combined pending,
in-flight, and API-authorized retry states (the manifest uses 16,384 events / 64 MiB and a 45-second
retry age). Within that same hard cap, `FORWARD_PROTECTED_RESERVE_EVENTS=4096` and
`FORWARD_PROTECTED_RESERVE_BYTES=16777216` keep one quarter of the ownership budget available for
Agent events and protected ToolExec, ProcessExit, SecurityAction, and Collector health evidence;
ordinary Infrastructure and aggregate traffic cannot consume that reserve. Heartbeats expose the
closed queue-loss class and a separate protected-loss counter without persisting dropped payloads.
Only an explicit per-item `clickhouse_event_buffer_full` acknowledgement is retried;
transport failures
and ambiguous HTTP failures remain terminal to avoid duplicating events whose acceptance is
unknown. Legacy `FORWARD_MAX_QUEUE` names are accepted as fallback aliases, but new deployments
should use the outstanding-limit names.
Routine `/proc`, `/sys`, `/run`, and `/dev` `FileAccess` noise is evaluated independently of the
identity class; high-value deletion and security events remain observable.

Label Agent Pods and, for multi-container Pods, identify the Agent container:

```yaml
metadata:
  labels:
    anysentry.io/workload-kind: agent
    anysentry.io/agent-id: claw-agent
    anysentry.io/agent-container: agent
```

After local, Docker, and Kubernetes comparison passes, set `FORWARD_FILTER_MODE=enforce` to apply
those decisions. For a temporary
unfiltered recovery view, set `FORWARD_RETAIN_NON_AGENT=true` and `FORWARD_NOISE_POLICY=include`;
this does not change identity classification or risk routing.

For operator-managed discovery, copy `deploy/agent-templates.example.json` and set
`ANYSENTRY_AGENT_TEMPLATES_FILE` in the observer-forwarder environment. Templates intentionally
accept concise deployment/name declarations and may be refined with Kubernetes namespace/Pod/
container/owner, Docker container/image, or bare-metal systemd/executable fields. Missing templates
do not classify a workload as non-Agent.

`ANYSENTRY_IDENTITY_NAMESPACES` defaults to `*`, using the bundled read-only
ClusterRole/ClusterRoleBinding to map CRI/containerd IDs for every namespace. This identity map is
not an Agent allowlist: unlabelled infrastructure Pods remain `unknown` until behavior analysis or
human review classifies them. Set a comma-separated namespace allowlist and replace the binding
with equivalent namespaced Roles only when deliberately trading complete friendly-name coverage
for narrower metadata visibility. `ANYSENTRY_AGENT_NAMESPACES` remains a compatibility fallback.
For an out-of-cluster source deployment, set `ANYSENTRY_KUBECONFIG` (or `KUBECONFIG`) to a
kubeconfig containing CA plus client-certificate/client-key or bearer-token credentials. The API
also detects `~/.kube/config`; `ANYSENTRY_KUBE_CONTEXT` overrides its current context.

For Docker hosts, run the forwarder on the node with read access to `/var/run/docker.sock`, or set
`ANYSENTRY_DOCKER_SOCKET` to another Docker-compatible Unix socket. Discovery defaults to `auto`
and uses an initial `/containers/json` list plus the Docker container event stream; set
`ANYSENTRY_DOCKER_DISCOVERY=off` to disable it. Docker API access is outside the event hot path.

Framework discovery is enabled by default and keeps only bounded counters/small sets per physical
workload. It requires LLM/tool alternation or the sequence `tool → network/model decision →
different tool → workspace change`; volume alone cannot create a candidate. Known service-data
paths do not count as workspace evidence, and a dominant executable repeatedly touching service
data without LLM/sequence evidence can end a probable TTL early without declaring `non_agent`.
Configure additional comma-separated service-state prefixes with
`ANYSENTRY_BEHAVIOR_SERVICE_DATA_PATHS`. It cannot create confirmed identities and makes no model
calls. Disable it with `ANYSENTRY_BEHAVIOR_DISCOVERY=off` or tune the matching
`ANYSENTRY_BEHAVIOR_*` variables.

## Safety

- **Observe-only.** Only `a3s-observer-collector` runs — never `a3s-observer-enforce` /
  `-fileguard`. Tracepoints are passive and cannot block a process, so a misjudgment can't break
  any workload. (Enforcement is a separate, opt-in deployment.)
- `A3S_OBSERVER_SSL` / `A3S_OBSERVER_FILES` are on by default for full signal; set them to `0` to
  drop plaintext capture and the high-volume file-write stream for a smaller footprint.
- `A3S_OBSERVER_TLS_STATIC_TARGETS` accepts comma-separated host-visible absolute paths for known
  Codex/Claude executables or TLS libraries used by Python/LangChain/Dify. Static CLIs must match
  an embedded whole-file profile (size, hashes and instruction prefixes); named TLS libraries use
  standard exported symbols. The collector attaches once per inode to close the first-request
  race, but content still requires an identity-verified PID/cgroup and an exact LLM route/schema.
  A host-PID DaemonSet can address host or container files through `/proc/<host-pid>/root/...`.
  Keep local user, container and credential paths in deployment overrides, not this base manifest.
- Additive: the manifests only add the `anysentry` namespace and its objects; nothing touches
  kubelet/containerd or existing workloads.

## Demo without observer

Set `ANYSENTRY_SYNTHETIC_FEED=on` on the AnySentry Deployment to drive the dashboard with a
synthetic event mix (sentry still really judges it). Unset = real ingested events only.
