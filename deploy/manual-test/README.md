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

The single-node `k8s-local-path` profile also runs PostgreSQL for durable mutable business state,
an unprivileged Workspace Scanner for live OSV input, and a read-only OTel service-context probe.
Create their Secrets before applying the overlay. Use a URL-safe generated password, keep shell
tracing disabled, and never print any credential:

```bash
set +x
kubectl create namespace anysentry --dry-run=client -o yaml | kubectl apply -f -
db_password="$(openssl rand -hex 24)"
db_url="postgresql://anysentry:${db_password}@postgres.anysentry.svc.cluster.local:5432/anysentry"
kubectl -n anysentry create secret generic anysentry-database \
  --from-literal=ANYSENTRY_DATABASE_URL="${db_url}" \
  --from-literal=POSTGRES_USER=anysentry \
  --from-literal=POSTGRES_PASSWORD="${db_password}" \
  --from-literal=POSTGRES_DB=anysentry \
  --dry-run=client -o yaml | kubectl apply -f -
scanner_token="$(openssl rand -hex 32)"
kubectl -n anysentry create secret generic anysentry-supply-chain \
  --from-literal=ANYSENTRY_WORKSPACE_SCANNER_TOKEN="${scanner_token}" \
  --dry-run=client -o yaml | kubectl apply -f -
# Create one managed, token-required OTel Source in the Sources UI/API. Bind it exactly to
# workspace /workspace, tag it system-context, and copy its one-time ID/token into shell variables.
kubectl -n anysentry create secret generic anysentry-system-context-source \
  --from-literal=source-id="${context_source_id}" \
  --from-literal=source-token="${context_source_token}" \
  --dry-run=client -o yaml | kubectl apply -f -
unset db_password db_url scanner_token context_source_id context_source_token
```

The tracked Scanner is digest-pinned and mounts
`/srv/anysentry/AnySentry` read-only. Place the checkout there or update the explicit hostPath before
applying this manual one-node profile. Build/push the `workspace-scanner` target and update its exact digest
in `k8s-local-path/kustomization.yaml` whenever the Scanner script or base image changes; do not
replace it with a mutable tag.

This repository includes six manual-test overlays. They leave the canonical manifests unchanged:

- `k8s-observer` pins the Observer, switches the manual collector to `enforce`, disables behavior
  promotion, and loads the complete versioned runtime-signature document. The shared single-node
  profile keeps ToolExec, Exit, Egress, DNS, process, security, and SSL signals enabled, but disables
  FileAccess/FileDelete after a full-probe load test exceeded the fixed FILE_EVENTS capacity and
  caused real Forwarder loss. A read-only Docker socket mount lets this one node-level Observer
  enrich the retained Docker Agent and Kubernetes workloads into one AnySentry.
- `k8s-core` rolls out the API and judges before Kafka/Flink are created.
- `k8s-local-path` adds the streaming plane, local-path PostgreSQL, the read-only Workspace
  Scanner, a digest-pinned System Context probe, and NodePort `32653`. The probe actively measures
  AnySentry/ClickHouse/Redis/Postgres error rate and P95 latency every minute and publishes only
  authenticated OTLP metrics; failures become non-zero error metrics rather than synthetic health.
  Its Flink patch changes only the manual checkpoint PVC from the production RWX contract to
  `local-path`/RWO, which is required by the single-node test cluster.
- `k8s-observer-file-canary` is used only after the six filter/batch modules pass local and
  component tests. It inherits the stable no-file manual profile, enables only the independently
  split FileAccess probe, keeps Unknown discovery on, and restores transport batching. Do
  not apply it before the filter-rule snapshot is being published and the Observer heartbeat
  reports a ready Capture Profile control plane.
- `k8s-observer-files-full` is the final, explicitly high-load profile. It enables both FileAccess
  and FileDelete only after their independent gates pass, retains lossless Unknown discovery,
  keeps all three rollout planes in `enforce`, batches 64 records, and attaches OpenSSL uprobes to
  the exact read-only host `libssl.so.3` inode. This covers processes using that inode only; it does
  not imply coverage for container-private OpenSSL, BoringSSL, Go TLS, or static TLS.

Render with Kustomize's explicit parent-directory allowance and use client-side apply. Do not use
server-side apply against the existing cluster because its historical field managers own several
of the same resource fields:

```bash
kubectl kustomize --load-restrictor=LoadRestrictionsNone \
  deploy/manual-test/k8s-core | kubectl apply -f -
kubectl -n anysentry rollout status deployment/anysentry --timeout=10m
kubectl kustomize --load-restrictor=LoadRestrictionsNone \
  deploy/manual-test/k8s-local-path | kubectl apply -f -
kubectl -n anysentry rollout status deployment/flink-jobmanager --timeout=10m
kubectl -n anysentry rollout status deployment/flink-taskmanager --timeout=10m
kubectl -n anysentry rollout status deployment/flink-job-submit --timeout=10m
kubectl -n anysentry rollout status statefulset/postgres --timeout=10m
kubectl -n anysentry rollout status deployment/workspace-scanner --timeout=10m
kubectl -n anysentry rollout status deployment/system-context-probe --timeout=10m
# The API was already running during the staged core rollout. Recreate it only after PostgreSQL is
# ready so the final health state is PostgreSQL-backed instead of the migration fallback.
kubectl -n anysentry rollout restart deployment/anysentry
kubectl -n anysentry rollout status deployment/anysentry --timeout=10m
kubectl kustomize --load-restrictor=LoadRestrictionsNone \
  deploy/manual-test/k8s-observer | kubectl apply -f -
kubectl -n anysentry rollout status daemonset/a3s-observer --timeout=10m
```

Keep the stable no-file Observer running while the API, Kafka/Flink, rules, Source credentials, and
Capture Profile control plane become ready. Exercise high-volume file signals in this order:

1. Apply `k8s-observer-file-canary` and observe at least two heartbeat/TTL windows. Require zero
   FileAccess Ring, Collector inbox, writer queue, output, and retry-exhaustion loss.
2. Return to `k8s-observer`. Run the repository's independent FileDelete-only gate with
   `deploy/modules/observer-file-delete-canary.yml`; there is intentionally no second Kubernetes
   canary that could be mistaken for the final full profile. Require the same zero-loss result.
3. Apply `k8s-observer-files-full`, wait for the DaemonSet rollout, and repeat the zero-loss checks
   for both file rings together. If any gate fails, immediately return to `k8s-observer`; do not
   compensate by increasing Ring capacity.

```bash
kubectl kustomize --load-restrictor=LoadRestrictionsNone \
  deploy/manual-test/k8s-observer-file-canary | kubectl apply -f -
kubectl -n anysentry rollout status daemonset/a3s-observer --timeout=10m

kubectl kustomize --load-restrictor=LoadRestrictionsNone \
  deploy/manual-test/k8s-observer | kubectl apply -f -
kubectl -n anysentry rollout status daemonset/a3s-observer --timeout=10m

kubectl kustomize --load-restrictor=LoadRestrictionsNone \
  deploy/manual-test/k8s-observer-files-full | kubectl apply -f -
kubectl -n anysentry rollout status daemonset/a3s-observer --timeout=10m
```

The manual Service is pinned to NodePort `32653`, so the node is directly reachable at
`http://${NODE_IP}:32653/` after replacing `NODE_IP` with the cluster node address. Apply `policy.json` through that URL, or start the optional `39653`
port-forward and replace port `29653` with `39653` in the Docker command above. The policy only controls tier routing;
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
- Kubernetes NodePort: `http://${NODE_IP}:32653/`
- Kubernetes: `http://127.0.0.1:39653/`
- Agent instances: append `/agents`
- Collector health: append `/collectors`
- Security Monitor: append `/admin/security-monitor`
- Policy and Runtime Model connections: append `/admin/policy`
- Docker Flink (only after the JobManager and TaskManager have started and report Ready):
  `http://127.0.0.1:8081/`
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
export ANYSENTRY_ADAPTER_SOURCE_ID='<managed-source-id>'
export ANYSENTRY_ADAPTER_TOKEN_HOST_FILE="$PWD/.local/real-llm/secrets/anysentry-adapter-token"
install -d -m 0700 "$ANYSENTRY_PI_WORKSPACE_DIR" "$ANYSENTRY_PI_STATE_DIR"
```

Before launch, create a token-protected ingestion Source with correlation authority
`agent_adapter`. Bind it to the intended tenant/environment and `/workspace`, copy its returned
Source ID to `ANYSENTRY_ADAPTER_SOURCE_ID`, and write its token only to the mode-`0600` file named
by `ANYSENTRY_ADAPTER_TOKEN_HOST_FILE`. Do not put the token in this document or a manifest.

Do not replace the digest with a mutable tag for this test. Neither Compose nor the Kubernetes
helper copies or prints either credential. Both mount `models.json`, the model credential, and the
Agent adapter Source token read-only.

### Docker agent

Start only the persistent Pi workload:

```bash
docker compose -f deploy/manual-test/docker-compose.pi-agent.yml up -d pi-agent
docker compose -f deploy/manual-test/docker-compose.pi-agent.yml ps pi-agent
```

It can also be added to the full manual stack by appending
`-f deploy/manual-test/docker-compose.pi-agent.yml` to the full-stack Compose command. The reliable
entry point for either launch mode is the fixed container name:

```bash
docker exec -it anysentry-test-pi /bin/bash
```

When the workload was started as the Pi-only Compose project, this Compose-scoped entry point is
also available:

```bash
docker compose -f deploy/manual-test/docker-compose.pi-agent.yml \
  exec pi-agent /bin/bash
```

Do not rely on that Pi-only Compose command after adding the service to the full-stack Compose
project: invoking only the Pi file can select a different Compose project and report that the
service is missing or not running. `docker exec` addresses the fixed container directly.

Start the interactive agent only when ready to generate real model traffic. It is a second Pi
process in the same workload; the container's original Pi process remains in RPC standby. The
`exec` below replaces only the temporary shell, not the standby process.

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

The helper creates `pi-agent-models` from the local `models.json`, `pi-agent-llm` from the local
model credential file, and `pi-agent-adapter` from the managed Source ID/token file. Secrets are
streamed to the API server; no Secret YAML is created on disk and no credential is printed. It then
injects the required immutable image digest and applies a one-replica Deployment:

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
`version`. Treat `candidate.version > live.version` as a required operational gate; a valid but
stale or equal version must not be published.

- Docker source: `.local/observer-rules/agent-runtime-signatures.json`
- Docker mount in the Observer: `/etc/anysentry/agent-runtime-signatures.json`
- Kubernetes live state: ConfigMap `anysentry/anysentry-agent-templates`, key
  `agent-runtime-signatures.json`
- Kubernetes tracked desired state: `deploy/manual-test/k8s-observer/rules-version2-patch.yaml`
- Kubernetes mount in the Observer: `/etc/anysentry/agent-runtime-signatures.json`

Validate candidates with the same parser used by the Observer. A shallow `jq` shape check is not
enough: `canonicalDocument` also rejects unknown fields, unsafe generic matchers, duplicates, and
invalid limits. From the repository root, define this helper; its candidate hash is the value that
must later appear as `runtimeSignatureHash`:

```bash
validate_runtime_candidate() {
  node - "$1" "$2" <<'NODE'
'use strict';
const fs = require('node:fs');
const {
  canonicalDocument,
  documentHash,
} = require('./scripts/observer-agent-runtime-signatures.js');

const [livePath, candidatePath] = process.argv.slice(2);
const live = canonicalDocument(JSON.parse(fs.readFileSync(livePath, 'utf8')));
const candidate = canonicalDocument(JSON.parse(fs.readFileSync(candidatePath, 'utf8')));
if (candidate.version <= live.version) {
  throw new Error(
    `candidate.version (${candidate.version}) must be greater than live.version (${live.version})`,
  );
}
process.stdout.write(`${JSON.stringify({
  liveVersion: live.version,
  candidateVersion: candidate.version,
  candidateHash: documentHash(candidate),
})}\n`);
NODE
}
```

For Docker, create the candidate in the live file's directory so the final rename stays on one
filesystem. `mktemp` plus the explicit `chmod` keeps the candidate at mode `0600`; failed validation
leaves the live file unchanged:

```bash
RULES_DIR="$PWD/.local/observer-rules"
LIVE="$RULES_DIR/agent-runtime-signatures.json"
CANDIDATE="$(mktemp "$RULES_DIR/.agent-runtime-signatures.XXXXXX")"
cp -- "$LIVE" "$CANDIDATE"
vi "$CANDIDATE"
chmod 0600 "$CANDIDATE"
validate_runtime_candidate "$LIVE" "$CANDIDATE" &&
  mv -- "$CANDIDATE" "$LIVE"
```

For a Kubernetes hot-reload drill, compare the edited complete JSON candidate with the current
ConfigMap document, then merge-patch only the runtime-signature key so the sibling
`agent-templates.json` key is preserved:

```bash
CANDIDATE="$PWD/.local/observer-rules/agent-runtime-signatures.candidate.json"
K8S_LIVE="$(mktemp)"
kubectl -n anysentry get configmap anysentry-agent-templates -o json |
  jq -er '.data["agent-runtime-signatures.json"]' >"$K8S_LIVE"
if validate_runtime_candidate "$K8S_LIVE" "$CANDIDATE"; then
  kubectl -n anysentry patch configmap anysentry-agent-templates --type merge \
    --patch "$(jq -n --rawfile document "$CANDIDATE" \
      '{data:{"agent-runtime-signatures.json":$document}}')"
fi
rm -f -- "$K8S_LIVE"
```

That patch changes live cluster state only; it does not update the tracked overlay and a later
overlay apply can replace it. For a persistent Kubernetes update, put the same validated complete
document in `deploy/manual-test/k8s-observer/rules-version2-patch.yaml`, review the repository diff,
and apply the tracked overlay with the client-side Kustomize command used above.

Run the following query immediately before the update and again after a fresh Forwarder heartbeat.
Use port `29653` and Collector `manual-docker-observer` for Docker. For Kubernetes, use port `39653`
and the Observer Pod's `spec.nodeName` as the Collector ID:

```bash
API_BASE="http://127.0.0.1:29653/security-center"
COLLECTOR_ID="manual-docker-observer"
curl --fail-with-body --silent --show-error -X POST \
  -H 'content-type: application/json' \
  --data "$(jq -nc --arg collectorId "$COLLECTOR_ID" \
    '{timeType:"last_30d",collectorId:$collectorId,limit:5}')" \
  "$API_BASE/collectors/health" |
  jq -e --arg collectorId "$COLLECTOR_ID" '
    ((.data // .).items // [])
    | map(select(.collectorId == $collectorId))[0]
    | if . == null then error("collector not found") else . end
    | {
        collectorId,
        lastHeartbeatAt,
        filterMetricsReported,
        version: .filterMetrics.runtimeSignatureVersion,
        hash: .filterMetrics.runtimeSignatureHash,
        matcherHash: .filterMetrics.runtimeSignatureMatcherHash,
        lastGoodRawHash: .filterMetrics.runtimeSignatureLastGoodHash,
        reload: {
          attempts: .filterMetrics.runtimeSignatureReloadAttempts,
          successes: .filterMetrics.runtimeSignatureReloadSuccesses,
          errors: .filterMetrics.runtimeSignatureReloadErrors,
          invalid: .filterMetrics.runtimeSignatureInvalid,
          reconcileErrors: .filterMetrics.runtimeReconcileErrors
        },
        drops: {
          droppedEvents,
          outputDropped,
          windowErrorMaxima,
          queueDropped: .filterMetrics.queueDropped,
          retryExhausted: (.filterMetrics.retryExhausted // 0),
          discoveryBudgetDropped: .filterMetrics.discoveryBudgetDropped
        }
      }'
```

The post-update heartbeat must have `filterMetricsReported: true`; its `version` and `hash` must
equal the validated candidate values. Reload attempts and successes must advance, while
reload/invalid/reconciliation errors must stay at their baseline (normally zero). Transport-loss
counters (`droppedEvents`, `outputDropped`, `queueDropped`, and `retryExhausted`) must not increase
across the update. `discoveryBudgetDropped` is policy filtering in `enforce` mode rather than
transport loss, but an unexpected jump still requires review. If management authentication is
enabled, add the admin-token header as described above without enabling shell tracing.

The Observer validates the full replacement before adopting it. An invalid update increments reload
diagnostics but keeps the last-good registry. Kubernetes projects ConfigMap changes through an
atomic `..data` symlink rotation. The reloader watches the directory and also hashes it every five
seconds; the polling path remains authoritative when `fs.watch` is unavailable because of host
inotify limits.
