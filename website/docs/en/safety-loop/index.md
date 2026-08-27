# From runtime evidence to auditable governance

AnySentry is not a probe, a rule engine, or a model in isolation. It is a continuous and traceable control chain. Every conclusion should answer three questions: what actually happened, why it was judged risky, and who took which action under which policy version.

## 01 · Capture system facts

On supported Linux nodes, `a3s-observer` can capture process, tool, file, network, and DNS behavior without changing agent code. Existing systems can also send Observer NDJSON, generic JSON, CloudEvents, OTLP/HTTP JSON, or agent-native events.

Capture describes what was observed. It does not pretend every telemetry item is a security alert.

## 02 · Normalize canonical evidence

AnySentry normalizes incoming signals into `anysentry.agent_event.v1` and derives available Source, Agent, Workspace, Session, Run, Trace, and event-category fields. Key-aware redaction runs before sensitive evidence is stored or returned.

Identity confidence remains separate from event fact. Unknown workloads stay queryable and continue through L1 instead of disappearing because a friendly name is missing.

## 03 · Decide through configured tiers

| Tier     | Current state      | Responsibility                                                                 |
| -------- | ------------------ | ------------------------------------------------------------------------------ |
| L1 Rules | Enabled by default | Deterministic, low-latency decisions for explicit risks                        |
| L2 LLM   | Optional           | Semantic judgment, rationale, and uncertainty for one event                    |
| L3 Agent | Optional           | A deeper investigation with bounded read-only tools when L2 remains unresolved |

L3 does not run because severity alone is high. Model backends, policy, and budgets must be configured explicitly. Model output is an evidence-linked judgment; it never replaces the original fact.

## 04 · Operate with evidence-linked actions

The same evidence drives dashboards, incidents, alerts, topology, Evidence Bundles, notifications, remediation tasks, and the Progressive API. Runtime assessment returns `allow`, `warn`, `require_approval`, or `block` together with an `eventId`, severity, risk category, reason, and decision tier.

Whether a caller enforces approval or blocking remains an explicit trust boundary. AnySentry does not describe “recommended block” as “already enforced.”

## One complete chain

```text
ToolExec: curl 169.254.169.254/latest/meta-data
  → capture: observer / agent API
  → normalize: agent + workspace + session + redaction
  → decide: L1 / critical / systemic_risk
  → action: require_approval
  → evidence: eventId → timeline → Evidence Bundle → audit
```

This chain is the factual source for the homepage animation and can be reproduced with the request in the [quick start](/guide/).

## From review to preflight control

Runtime review and preflight control are not separate product features. They share identity, event, scope, policy version, and approval context:

1. Real behavior enters canonical evidence.
2. L1, L2, and L3 complete tiered judgment.
3. The system creates a sourced, conditional, scoped policy candidate.
4. A human confirms risk, policy, and effective scope.
5. The policy enters Runtime Guard.
6. When a similar action returns, preflight returns allow, warn, approval, or block.
7. Judgment and execution return to audit as input for the next governance cycle.

The same loop can learn control from observed behavior or accept explicit organizational policy. Automatically generated content always retains provenance, version, and rollback context.
