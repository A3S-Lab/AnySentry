# Full-function manual test profile

This profile is intentionally separate from the production-oriented defaults. It enables the API
stream publisher, Kafka/Flink processing, OSV supply-chain assessment, and runtime correlation.
L1 is always active in AnySentry. Applying `policy.json` makes L2 and L3 routable; the placeholder
URL and model names are never intended to receive requests. Real L2/L3/Composite connections come
from the in-memory Runtime Model profiles or from `anysentry-model-credentials`.

## Docker

Start the full stack:

```bash
docker compose --profile streaming \
  -f docker-compose.yml \
  -f deploy/docker-compose.manual-test.yml \
  up -d
```

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

Apply the canonical resources first, then replace only the complete shared runtime ConfigMap with
the full-function values:

```bash
kubectl apply -f deploy/anysentry.yaml
kubectl apply -f deploy/streaming.yaml
kubectl apply -f deploy/manual-test/runtime-on.yaml
kubectl -n anysentry rollout restart deployment/anysentry deployment/fast-judge deployment/l3-worker \
  deployment/flink-job-submit deployment/stream-worker deployment/composite-judge \
  deployment/supply-chain-assessment
kubectl -n anysentry port-forward service/anysentry 29653:29653
```

Apply `policy.json` with the same curl command shown above. The policy only controls tier routing;
credentials remain memory-only/Secret-backed. Supply-chain workspace discovery additionally needs
a valid scanner token before external workspaces can publish dependency snapshots.
