# Deploying AnySentry + a3s-observer on Kubernetes

Real end-to-end: **a3s-observer** (eBPF, observe-only) on every node → forwards kernel events to
**AnySentry** → embedded **a3s-sentry** judges them → the dashboard shows real risk.

```
 kernel events (every node)
   a3s-observer-collector ──NDJSON──▶ observer-forward.js ──POST /security-center/ingest──▶ AnySentry
                                                                               │
                                                  @a3s-lab/sentry.evaluate() ◀──┘
                                                                               │
                                                          dashboard (Service :29653)
```

These manifests are a generic, self-contained example. They deploy into the `anysentry` namespace
and bundle a single-node ClickHouse for durable storage; nothing is tied to a specific cluster.

## Prerequisites

- A Kubernetes cluster with a **default StorageClass** (the bundled ClickHouse PVC uses it).
- **amd64 nodes** — `@a3s-lab/sentry` bundles a `linux-x64-gnu` binary requiring **GLIBC_2.39**, so
  the AnySentry runtime image is `ubuntu:24.04` (there is no linux-arm64 build).
- `kubectl` configured for your cluster.
- For the observer step only: a container registry you can push to (or use the public images).

## One-command install

The repo includes `deploy/install.sh` for the integrated middleware stack:

```bash
deploy/install.sh docker

ANYSENTRY_INSTALL_MODE=kubernetes \
CLICKHOUSE_PASSWORD="$(openssl rand -hex 16)" \
deploy/install.sh
```

Docker mode builds and starts AnySentry + ClickHouse with compose. Kubernetes mode creates the
namespace, creates the ClickHouse Secret, applies `deploy/anysentry.yaml`, applies the observe-only
`a3s-observer` DaemonSet, optionally applies Ingress with `ANYSENTRY_APPLY_INGRESS=1`, and waits for
the AnySentry, ClickHouse, and observer rollouts. The AnySentry image bundles `@a3s-lab/sentry`;
the observer DaemonSet runs only `a3s-observer-collector` plus the AnySentry forwarder.

## 1. AnySentry image

Use the public image `ghcr.io/a3s-lab/anysentry:latest` (referenced by `deploy/anysentry.yaml`),
or build and push your own from the repo root:

```bash
docker build -t <your-registry>/anysentry:latest .
docker push    <your-registry>/anysentry:latest
# then set the `image:` in deploy/anysentry.yaml to your tag
```

The repo-root `Dockerfile` produces a standalone image with pnpm (corepack) — no extra steps.

## 2. Create the namespace and ClickHouse credentials

The manifest reads ClickHouse credentials from a Secret named `anysentry-clickhouse`. Create it
before applying (choose your own password):

```bash
kubectl create namespace anysentry
kubectl -n anysentry create secret generic anysentry-clickhouse \
  --from-literal=CLICKHOUSE_USER=anysentry \
  --from-literal=CLICKHOUSE_PASSWORD='change-me'
```

## 3. Deploy AnySentry (+ bundled ClickHouse)

```bash
kubectl -n anysentry apply -f deploy/anysentry.yaml
kubectl -n anysentry rollout status deploy/clickhouse
kubectl -n anysentry rollout status deploy/anysentry
```

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

Then add an `env` entry with `valueFrom.secretKeyRef` to the AnySentry container. Read APIs and
producer paths (`/security-center/ingest`, Collector heartbeat, Source check-in) remain on Source
identity and Source ingest tokens.

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
`ghcr.io/a3s-lab/anysentry-observer:latest` if available), then:

```bash
kubectl -n anysentry apply -f deploy/observer.yaml
kubectl -n anysentry get pods -l app=a3s-observer -o wide
```

Events appear on the dashboard within seconds as workloads on the nodes run tools, make egress,
touch files, or escalate privileges.

The DaemonSet sets `A3S_OBSERVER_COLLECTOR_ID` and `A3S_NODE_NAME` from Kubernetes `spec.nodeName`,
so every node appears as a stable Collector. The bundled forwarder also emits source-aware
heartbeats every `ANYSENTRY_HEARTBEAT_SECS` seconds; with no explicit `ANYSENTRY_SOURCE_ID`,
AnySentry discovers one observer Source per node/collector automatically.

## Safety

- **Observe-only.** Only `a3s-observer-collector` runs — never `a3s-observer-enforce` /
  `-fileguard`. Tracepoints are passive and cannot block a process, so a misjudgment can't break
  any workload. (Enforcement is a separate, opt-in deployment.)
- `A3S_OBSERVER_SSL` / `A3S_OBSERVER_FILES` are on by default for full signal; set them to `0` to
  drop plaintext capture and the high-volume file-write stream for a smaller footprint.
- Additive: the manifests only add the `anysentry` namespace and its objects; nothing touches
  kubelet/containerd or existing workloads.

## Demo without observer

Set `ANYSENTRY_SYNTHETIC_FEED=on` on the AnySentry Deployment to drive the dashboard with a
synthetic event mix (sentry still really judges it). Unset = real ingested events only.
