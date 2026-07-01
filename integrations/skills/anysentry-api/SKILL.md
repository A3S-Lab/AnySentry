---
name: anysentry-api
description: Drive AnySentry deployment checks and the source-compatible progressive API. Use when the user wants an agent to deploy or verify AnySentry, call /security-center/capabilities, discover security-center operations, assess runtime actions, ingest security evidence, build evidence bundles, plan next actions, or integrate a coding agent with AnySentry without relying on the deprecated ACP-style flow.
allowed-tools: bash(*)
parameters:
  - name: apiBase
    type: string
    required: false
    description: AnySentry API base without a trailing slash.
  - name: task
    type: string
    required: false
    description: Verification or integration task to run through the progressive API.
---

# AnySentry progressive API

Use this skill to operate a running AnySentry service and call its progressive
capability API from a coding agent.

## Preflight

Set the API base without a trailing slash:

```sh
export ANYSENTRY_API_BASE="${ANYSENTRY_API_BASE:-http://127.0.0.1:29653/security-center}"
curl -fsS "$ANYSENTRY_API_BASE/healthz"
```

If the service is not running:

```sh
deploy/install.sh docker
# or, for a Kubernetes fleet with observe-only a3s-observer:
ANYSENTRY_INSTALL_MODE=kubernetes deploy/install.sh
```

For Kubernetes, open a local tunnel before calling the API:

```sh
kubectl -n "${ANYSENTRY_NAMESPACE:-anysentry}" port-forward svc/anysentry 29653:29653
```

## Mental model

- Single endpoint: `GET|POST $ANYSENTRY_API_BASE/capabilities`.
- Action set: `list`, `search`, `describe`, `execute`.
- Dispatch shape: `action + module + operation + params`.
- `describe` returns the executable `inputSchema.body.properties.params` and
  `outputSchema.data` contract for each operation. Use that schema as the source
  of truth instead of maintaining a second reference.
- Default response is raw:
  - `list` -> `ApiModule[]`
  - `search` -> `ApiOperation[]`
  - `describe` -> `ApiModule | ApiOperation`
  - `execute` -> the operation result
- Add `shaped=true` only when the caller wants a tool-friendly envelope with
  `success`, `modules` / `operations` / `operation` / `data`, and compatibility metadata.
- `GET` is for discovery (`list`, `search`, `describe`). `execute` requires `POST`.
- Do not use old ACP-only actions (`poll`, `subscribe`, `approve`) as the protocol.
  Legacy `capabilityId` aliases may work, but the primary protocol is
  `module + operation + params`.

Always discover before executing:

```sh
curl -fsS "$ANYSENTRY_API_BASE/capabilities?action=list"
curl -fsS "$ANYSENTRY_API_BASE/capabilities?action=search&query=runtime%20guard"
curl -fsS "$ANYSENTRY_API_BASE/capabilities?action=describe&module=security-center&operation=assessRuntimeAction"
```

## Operations

The built-in module is `security-center`:

| Operation | Use for |
|---|---|
| `assessRuntimeAction` | Judge a tool/model/output/runtime action and return `allow`, `warn`, `require_approval`, or `block`. |
| `recordSecurityEvents` | Normalize custom, webhook, CloudEvents, or OTel-shaped evidence into judged AnySentry events. |
| `buildEvidenceBundle` | Build a governance evidence bundle around an event, run, trace, source, incident, objective, or scope. |
| `planNextActions` | Rank active remediation, incident, alert, objective, and coverage-derived work into an evidence-linked action plan for AI operators. |

## Runtime guard

Use `dryRun: true` for a schema-aware preflight that validates the same
`inputSchema.body` returned by `describe`, reports `schemaIssues`, and previews
the normalized request without writing an event:

```sh
curl -fsS -X POST "$ANYSENTRY_API_BASE/capabilities" \
  -H 'Content-Type: application/json' \
  -d '{
    "action": "execute",
    "module": "security-center",
    "operation": "assessRuntimeAction",
    "dryRun": true,
    "params": {
      "autonomy": "guarded",
      "stage": "tool",
      "workspacePath": "repo://example",
      "agentId": "coding-agent",
      "sessionId": "session-1",
      "toolName": "bash",
      "command": ["bash", "-lc", "id"]
    }
  }'
```

For real assessment, omit `dryRun`. `autonomy` changes how block-level risk is
returned:

- `suggest`: advisory; usually returns `warn` instead of blocking.
- `guarded`: returns `require_approval` for block-level risk.
- `auto`: returns `block` for block-level risk.

```sh
curl -fsS -X POST "$ANYSENTRY_API_BASE/capabilities" \
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

## Evidence and ingest

Use `recordSecurityEvents` when the agent has structured evidence but not
a3s-observer NDJSON:

```sh
curl -fsS -X POST "$ANYSENTRY_API_BASE/capabilities" \
  -H 'Content-Type: application/json' \
  -d '{
    "action": "execute",
    "module": "security-center",
    "operation": "recordSecurityEvents",
    "params": {
      "sourceName": "coding-agent",
      "sourceType": "custom",
      "events": [{
        "kind": "ToolExec",
        "workspacePath": "repo://example",
        "agentId": "coding-agent",
        "sessionId": "session-1",
        "command": ["bash", "-lc", "npm test"],
        "cwd": "/workspace"
      }]
    }
  }'
```

Build a handoff bundle after you have an `eventId`, `runId`, `traceId`, or other
scope selector:

```sh
curl -fsS -X POST "$ANYSENTRY_API_BASE/capabilities" \
  -H 'Content-Type: application/json' \
  -d '{
    "action": "execute",
    "module": "security-center",
    "operation": "buildEvidenceBundle",
    "params": { "runId": "deploy-42" }
  }'
```

Ask for the next actions when an agent needs operational guidance. Each action
includes `evidence.bundleHint`; pass that hint to `buildEvidenceBundle` for the
case file before executing a risky fix:

```sh
curl -fsS -X POST "$ANYSENTRY_API_BASE/capabilities" \
  -H 'Content-Type: application/json' \
  -d '{
    "action": "execute",
    "module": "security-center",
    "operation": "planNextActions",
    "params": {
      "timeType": "last_1d",
      "workspacePath": "repo://example",
      "maxActions": 5
    }
  }'
```

## Authentication

Most discovery and ingest paths work without management auth. If the deployment
sets `ANYSENTRY_ADMIN_TOKEN` / `ANYSENTRY_MANAGEMENT_TOKEN`, pass it only for
control-plane writes:

```sh
curl -fsS "$ANYSENTRY_API_BASE/config" \
  -H "X-AnySentry-Admin-Token: $ANYSENTRY_ADMIN_TOKEN"
```

Producer identity is separate. For managed Sources, pass the Source token to
ingest calls via `X-AnySentry-Ingest-Token` or `Authorization: Bearer ...`.

## Verify

From the repo root:

```sh
pnpm verify:progressive-api
ANYSENTRY_API_BASE="$ANYSENTRY_API_BASE" pnpm verify:progressive-api
pnpm verify:progressive-api:local
A3S_TEST_MODEL=openai/glm5.1-w4a8 pnpm verify:a3s-code-skill-api
```

Use `pnpm verify:deployment-manifests` after changing manifests and
`pnpm verify:contracts:local` before release-sized changes.

## Errors

| Symptom | Fix |
|---|---|
| `action=execute requires POST` | Use `POST $ANYSENTRY_API_BASE/capabilities` with JSON body. |
| `Unknown capability action: approve` | Stop using ACP-only actions; use `list/search/describe/execute`. |
| `module parameter is required` | Pass `module: "security-center"` or discover modules with `action=list`. |
| `operation is required` | Describe the module, then pass one operation name such as `assessRuntimeAction`. |
| Raw array returned when envelope expected | Add `shaped=true`; raw responses are the default. |
| Empty dashboard after install | Feed observer/custom events or enable `ANYSENTRY_SYNTHETIC_FEED=on` for demo data. |
| Kubernetes service not reachable locally | Run `kubectl -n anysentry port-forward svc/anysentry 29653:29653`. |
