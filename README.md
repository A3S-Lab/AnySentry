# AnySentry

Universal **agent security observability, monitoring & intervention** — built on
[a3s-sentry](https://github.com/A3S-Lab/Sentry) (`@a3s-lab/sentry`) and
[a3s-observer](https://github.com/A3S-Lab/Observer).

AnySentry turns kernel-level agent activity into live security signal: an eBPF observer
captures what every agent — and its tool subprocesses — actually does (tools run, egress, DNS,
file access, LLM calls, privilege escalations), `@a3s-lab/sentry` judges each event against a
tiered policy, and a real-time dashboard shows the risk. Every number on the screen is computed
from live judgments — no mock data.

```
 kernel events (every node)              unmodified agents · any language
   a3s-observer (eBPF) ──NDJSON──▶ forwarder ──POST /ingest──▶ AnySentry
                                                                  │
                        @a3s-lab/sentry (L1 rules / L2 LLM / L3 agent) judges
                                                                  │
                   ClickHouse (durable store)  ◀──▶  aggregation ──▶ dashboard
```

It ships as a single self-contained service (the API also serves the dashboard) plus ClickHouse
as the durable event store. Drop it in front of any agent fleet — it's a piece of middleware:
events in via `POST /ingest`, risk out via the dashboard and API.

## Quickstart

```bash
docker compose up -d --build      # AnySentry + ClickHouse
# open http://localhost:29653
```

The dashboard is live but empty until you feed it events. To see it populated immediately with a
self-driving demo load (every event still really judged by a3s-sentry), set
`ANYSENTRY_SYNTHETIC_FEED=on` in `docker-compose.yml` and `docker compose up -d`.

To feed it **real** activity, pipe an a3s-observer collector into the forwarder:

```bash
A3S_OBSERVER_JSON=1 sudo -E a3s-observer-collector \
  | ANYSENTRY_INGEST_URL=http://localhost:29653/security-center/ingest node scripts/observer-forward.js
```

Configuration is via environment variables — see [`.env.example`](.env.example).

## Ingest contract

AnySentry is fed by `POST /security-center/ingest`. The body is `{ "line": <raw a3s-observer
NDJSON> }`; identity, workspace, and session are derived from the line itself, so any producer in
any language can drive it:

```bash
curl -X POST localhost:29653/security-center/ingest -H 'Content-Type: application/json' -d '{
  "line": "{\"identity\":{\"agent\":\"py\",\"task\":\"1\"},\"event\":{\"Egress\":{\"pid\":1,\"peer\":\"169.254.169.254\",\"port\":80}}}"
}'
# → { "accepted": true, "verdict": "block", "tier": "Rules", "severity": "high", ... }
```

## What it shows

The backend holds one `Sentry` judge. Each ingested event is run through `sentry.evaluate()`, the
resulting `Decision { verdict, tier, severity, reason, action }` is recorded to ClickHouse, and an
in-memory hot ring (hydrated from ClickHouse on boot) serves the panels. Every panel is a query
over that live decision stream:

| Panel | Source |
|---|---|
| Health / token | block & escalate rates over the window |
| Explainability wave | safe-vs-risk score binned over time |
| Decision funnel | events resolved at L1 rules → L2 (escalations) → L3 (high/critical) → final block |
| Risk summary / breakdown | judged events grouped by the monitored risk taxonomy, with period-over-period change |
| Model-output interpretability (SAE) | white-box safety score from a3s-power's in-enclave SAE tap |
| Highest-risk session | the session with the largest summed risk, as a 6-dimension radar |
| Workspace distribution | risk grouped by workspace / agent identity |
| Agent observability | live SSE: heartbeat, error rate, throughput, behavior drift |

`escalate` rules fail-open when no L2/L3 backend is wired, but the marker + severity are
preserved, so the monitoring layer still surfaces them as escalations — exactly what the funnel's
L2/L3 tiers count.

## Storage

Judged events are written to **ClickHouse** (a columnar TSDB — the right home for time-windowed
event analytics); the in-memory ring is just a hot read cache hydrated from it on boot, so date
windows survive restarts. If `CLICKHOUSE_URL` is unset, AnySentry runs in-memory only (no
durability). Retention is a 90-day `TTL` on the `events` table (tune in
`apps/api/src/security-monitoring/clickhouse-store.ts`).

## Development

Requires Node 20+ and [pnpm](https://pnpm.io) (`corepack enable`).

```bash
pnpm install
pnpm dev          # api (29653) + web (5173, proxies /security-center → api) together
```

Open <http://localhost:5173>. Point `CLICKHOUSE_URL` at a local ClickHouse, or leave it unset to
run in-memory.

## Kubernetes

For a fleet, run `a3s-observer` as an observe-only eBPF DaemonSet on every node, forwarding events
to AnySentry. See [`deploy/`](deploy/) for example manifests (AnySentry + ClickHouse + the observer
DaemonSet) and the runbook.

## Layout

```
apps/api   NestJS — the sentry judge, ClickHouse store, aggregation, endpoints + SSE + ingest
apps/web   Rsbuild + React — the security dashboard
scripts/   a3s-observer → /ingest forwarders (Node + Python)
deploy/    example Kubernetes manifests + runbook
```

## License

[MIT](LICENSE)
