# Prove the runtime security loop in five minutes

The shortest AnySentry evaluation path does not start with a model. Start the local evidence plane, use the built-in L1 policy to assess a proposed high-risk command, and follow the returned `eventId` back to the exact evidence.

## 1. Start the local stack

Docker Compose starts the API and dashboard, ClickHouse, Redis, and asynchronous judgment workers. Model-backed tiers still require explicit configuration; L1 rules work by default.

```bash
git clone https://github.com/A3S-Lab/AnySentry.git
cd AnySentry

deploy/install.sh docker
curl -fsS http://localhost:29653/security-center/healthz
```

Open <http://localhost:29653>. Real-event mode is the default. Synthetic demo traffic appears only after explicitly enabling `ANYSENTRY_SYNTHETIC_FEED=on`.

## 2. Assess an action without executing it

This request describes a proposed command. AnySentry judges and records it, but does not run it.

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

The built-in rule detects cloud metadata access and returns an evidence-linked decision:

```json
{
  "data": {
    "policyAction": "require_approval",
    "verdict": "escalate",
    "tier": "Rules",
    "severity": "critical",
    "riskCategory": "systemic_risk",
    "evidence": {
      "eventId": "evt_...",
      "eventsHref": "/events?eventId=evt_..."
    }
  }
}
```

## 3. Investigate through the evidence

Use the returned `eventId` to open the exact event, or call `buildEvidenceBundle` to assemble a redaction-safe case file. Agent assets, timelines, topology, incidents, alerts, and remediation work in the dashboard all reference the same normalized evidence.

## 4. Connect real signals

Choose one or more inputs that match the infrastructure you already have:

| Input              | Best fit                                                                            |
| ------------------ | ----------------------------------------------------------------------------------- |
| `a3s-observer`     | Supported Linux/amd64 nodes for process, file, network, and DNS facts               |
| Observer NDJSON    | An existing Observer forwarding path                                                |
| JSON / CloudEvents | Gateways, webhooks, CI systems, or custom agent runtimes                            |
| OTLP/HTTP JSON     | Existing OpenTelemetry logs or traces                                               |
| Progressive API    | Agents that assess actions, record evidence, or plan response work before execution |

For production, create managed Sources and ingest tokens. Configure `ANYSENTRY_ADMIN_TOKEN` or `ANYSENTRY_MANAGEMENT_TOKEN`, TLS, and network access controls before exposing the control plane.

## 5. Keep the enforcement boundary explicit

AnySentry returns `allow`, `warn`, `require_approval`, or `block`. Hard enforcement exists only when the calling agent, tool gateway, or platform loop honors the result. `a3s-observer` is observe-only by default and does not terminate workloads.

Continue with the [safety loop](/safety-loop/), [architecture](/architecture/), and [scenarios](/scenarios/).
