# Full-function manual test profile

This profile is intentionally separate from the production-oriented defaults. It enables the API
stream publisher, Kafka/Flink processing, OSV supply-chain assessment, and runtime correlation.
L1 is always active in AnySentry. Applying `policy.json` makes L2 and L3 routable; the placeholder
URL and model names are never intended to receive requests. Real L2/L3/Composite connections come
from the in-memory Runtime Model profiles or from `anysentry-model-credentials`.

## Docker

Start the full stack:

```bash
export ANYSENTRY_IMAGE='127.0.0.1:5000/anysentry@sha256:<digest>'
export ANYSENTRY_FLINK_IMAGE='127.0.0.1:5000/anysentry-flink-streaming@sha256:<digest>'
export ANYSENTRY_OBSERVER_IMAGE='127.0.0.1:5000/anysentry-observer@sha256:<digest>'
export ANYSENTRY_RUNTIME_RULES_DIR="$PWD/.local/observer-rules"
docker compose --profile streaming \
  -f docker-compose.yml \
  -f deploy/docker-compose.manual-test.yml \
  up -d
```

The manual override pins the API and every Node worker to the same AnySentry digest, pins all four
Flink roles to one Flink digest, and starts the digest-pinned Observer without source-code bind
overlays. Its identity filter runs in `enforce` mode after the real multi-plane lifecycle gate has
passed, and behavior promotion is disabled so background process churn cannot turn into an
unbounded Agent event stream. Exact signatures plus Docker workload identity still classify the
manual Agents, and FileAccess remains enabled on this plane. L1/L2/L3 policy enforcement remains
independent from this transport filter.

Configure and apply both Runtime Model profiles through the Policy page before sending real model
traffic. The Composite Judge subscribes to the same `deep_investigation` Runtime Model profile, so
an explicit `ANYSENTRY_COMPOSITE_MODEL` is unnecessary and cannot silently replace DeepSeek with
the historical fallback model.

Then enable L2/L3 routing while retaining all built-in L1 rules:

```bash
curl --fail-with-body -X PUT \
  -H 'content-type: application/json' \
  --data-binary @deploy/manual-test/policy.json \
  http://127.0.0.1:29653/security-center/config
```

If management authentication is enabled, also pass
`-H "x-anysentry-admin-token: ${ANYSENTRY_ADMIN_TOKEN}"` without enabling shell tracing.

## Kubernetes

Create `anysentry-model-credentials` out of band. It may contain the normal L2/L3 environment
keys (`A3S_SENTRY_LLM_URL`, `A3S_SENTRY_LLM_MODEL`, `A3S_SENTRY_LLM_KEY`, and their
`A3S_SENTRY_L3_*` equivalents), or configure both profiles through the Policy page after rollout.
Do not commit a Secret manifest.

This repository includes three manual-test overlays. They leave the canonical manifests unchanged:

- `k8s-observer` pins the Observer, switches the manual collector to `enforce`, disables behavior
  promotion, and loads the complete versioned runtime-signature document. On this busy single node,
  it also disables the opt-in high-volume FileAccess/FileDelete probes; ToolExec, Exit, Egress, DNS,
  SSL, Kubernetes identity, and runtime-signature detection remain enabled. The Docker profile keeps
  FileAccess enabled for that part of the rule exercise.
- `k8s-core` rolls out the API and judges before Kafka/Flink are created.
- `k8s-local-path` adds the streaming plane and changes only the manual checkpoint PVC from the
  production RWX contract to `local-path`/RWO, which is required by the single-node test cluster.

Render with Kustomize's explicit parent-directory allowance and use client-side apply. Do not use
server-side apply against the existing cluster because its historical field managers own several
of the same resource fields:

```bash
kubectl kustomize --load-restrictor=LoadRestrictionsNone \
  deploy/manual-test/k8s-observer | kubectl apply -f -
kubectl kustomize --load-restrictor=LoadRestrictionsNone \
  deploy/manual-test/k8s-core | kubectl apply -f -
kubectl -n anysentry rollout status deployment/anysentry --timeout=10m
kubectl kustomize --load-restrictor=LoadRestrictionsNone \
  deploy/manual-test/k8s-local-path | kubectl apply -f -
kubectl -n anysentry rollout status deployment/flink-jobmanager --timeout=10m
kubectl -n anysentry rollout status deployment/flink-taskmanager --timeout=10m
kubectl -n anysentry rollout status deployment/flink-job-submit --timeout=10m
```

After starting the `39653` port-forward, apply `policy.json` with the same curl command shown above
but replace port `29653` with `39653`. The policy only controls tier routing;
credentials remain memory-only/Secret-backed. Supply-chain workspace discovery additionally needs
a valid scanner token before external workspaces can publish dependency snapshots.

Use separate local port-forwards so the Docker and Kubernetes planes can be compared without
changing either Service:

```bash
kubectl -n anysentry port-forward service/anysentry 39653:29653
kubectl -n anysentry port-forward service/flink-jobmanager 38081:8081
```

The dashboard URLs are:

- Docker: `http://127.0.0.1:29653/`
- Kubernetes: `http://127.0.0.1:39653/`
- Agent instances: append `/agents`
- Collector health: append `/collectors`
- Security Monitor: append `/admin/security-monitor`
- Policy and Runtime Model connections: append `/admin/policy`
- Docker Flink: `http://127.0.0.1:8081/`
- Kubernetes Flink: `http://127.0.0.1:38081/`

## Persistent Pi agent for manual interaction

The files in this section start a real Pi process in RPC standby. RPC mode waits for input and does
not submit model turns, even though the authorized model catalogue and key file are mounted. A paid
request is only possible after an operator enters the container and starts the interactive command
shown below. Keep shell tracing disabled so the exported key is not printed.

Use the immutable digest of the locally built Agent Runtime Lab image:

```bash
export ANYSENTRY_AGENT_LAB_IMAGE='127.0.0.1:5000/anysentry-agent-runtime-lab@sha256:<digest>'
export ANYSENTRY_LLM_MODELS_FILE="$PWD/.local/real-llm/models.json"
export ANYSENTRY_LLM_KEY_FILE="$PWD/.local/real-llm/secrets/api-key"
export ANYSENTRY_AGENT_UID="$(id -u)"
export ANYSENTRY_AGENT_GID="$(id -g)"
export ANYSENTRY_PI_WORKSPACE_DIR="$PWD/.local/real-llm/docker-pi/workspace"
export ANYSENTRY_PI_STATE_DIR="$PWD/.local/real-llm/docker-pi/state"
install -d -m 0700 "$ANYSENTRY_PI_WORKSPACE_DIR" "$ANYSENTRY_PI_STATE_DIR"
```

Do not replace the digest with a mutable tag for this test. Neither Compose nor the Kubernetes
helper copies or prints the key. Both mount `models.json` at
`/home/node/.pi/agent/models.json` and the key at `/run/secrets/deepseek_api_key`, read-only.

### Docker agent

Start only the persistent Pi workload:

```bash
docker compose -f deploy/manual-test/docker-compose.pi-agent.yml up -d pi-agent
docker compose -f deploy/manual-test/docker-compose.pi-agent.yml ps pi-agent
```

It can also be added to the full manual stack by appending
`-f deploy/manual-test/docker-compose.pi-agent.yml` to the full-stack Compose command. Enter it and
start the interactive agent only when ready to generate real model traffic:

```bash
docker compose -f deploy/manual-test/docker-compose.pi-agent.yml \
  exec pi-agent /bin/bash
```

Then, inside the container:

```bash
set +x
export DEEPSEEK_API_KEY="$(tr -d '\r\n' </run/secrets/deepseek_api_key)"
cd /workspace
exec /opt/agent-lab/node_modules/.bin/pi \
  --provider anysentry-e2e-gateway \
  --model bailian/deepseek-v4-flash \
  --thinking off
```

### Kubernetes agent

The helper creates `pi-agent-models` from the local `models.json` and `pi-agent-llm` directly from
the local key file. The Secret is streamed to the API server; no Secret YAML is created on disk and
the key is not printed. It then injects the required immutable image digest and applies a one-replica
Deployment:

```bash
chmod 0755 deploy/manual-test/apply-pi-agent-k8s.sh
deploy/manual-test/apply-pi-agent-k8s.sh
kubectl -n anysentry-agent-test get pods -l app.kubernetes.io/name=pi-coding-agent -o wide
```

The bundled deployment already uses `ANYSENTRY_IDENTITY_NAMESPACES=*`, so it discovers the test
namespace without another rollout. If an operator has deliberately narrowed that setting (or uses
the legacy `ANYSENTRY_AGENT_NAMESPACES` fallback), preserve the existing entries and add
`anysentry-agent-test`. For example:

```bash
kubectl -n anysentry set env deployment/anysentry \
  ANYSENTRY_IDENTITY_NAMESPACES=default,anysentry-agent-test
kubectl -n anysentry rollout status deployment/anysentry
```

Enter the running Pod:

```bash
kubectl -n anysentry-agent-test exec -it deployment/pi-coding-agent -c agent -- /bin/bash
```

Inside the container, run the same `set +x`, key-file export, `cd`, and `pi` command shown in the
Docker section. The Deployment labels the workload as Agent ID `k8s-pi-agent-manual`; the Docker
workload uses `docker-pi-agent-manual`. These are the expected instance IDs on the AnySentry Agent
and Security Monitor pages.

Updating the local models file does not change an already mounted Kubernetes ConfigMap. Re-run the
helper and restart the Pod after an update:

```bash
deploy/manual-test/apply-pi-agent-k8s.sh
kubectl -n anysentry-agent-test rollout restart deployment/pi-coding-agent
kubectl -n anysentry-agent-test rollout status deployment/pi-coding-agent
```

## Runtime signature rule updates

The rule file is a complete registry document, not an incremental patch. Every accepted update must
retain `schemaVersion`, every runtime entry, and every variant, while increasing the integer
`version`.

- Docker source: `.local/observer-rules/agent-runtime-signatures.json`
- Docker mount in the Observer: `/etc/anysentry/agent-runtime-signatures.json`
- Kubernetes source of truth: ConfigMap `anysentry/anysentry-agent-templates`, key
  `agent-runtime-signatures.json`
- Kubernetes mount in the Observer: `/etc/anysentry/agent-runtime-signatures.json`

For Docker, write the edited complete document to a mode-`0600` temporary file in the same
`.local/observer-rules` directory, validate it, and atomically rename it over the live file. For
Kubernetes, preserve the sibling `agent-templates.json` key by patching only the runtime-signature
key:

```bash
RULES="$PWD/.local/observer-rules/agent-runtime-signatures.json"
jq -e '.schemaVersion == "anysentry.agent_runtime_signatures.v1" and
       (.version | type == "number") and
       (.runtimes | type == "array" and length > 0)' "$RULES" >/dev/null
kubectl -n anysentry patch configmap anysentry-agent-templates --type merge \
  --patch "$(jq -n --rawfile document "$RULES" \
    '{data:{"agent-runtime-signatures.json":$document}}')"
```

The Observer validates the full replacement before adopting it. A valid update changes the active
version/hash and triggers runtime reconciliation. An invalid update increments reload diagnostics
but keeps the last-good registry. Kubernetes projects ConfigMap changes through an atomic `..data`
symlink rotation. The reloader watches the directory and also hashes it every five seconds; the
polling path remains authoritative when `fs.watch` is unavailable because of host inotify limits.
