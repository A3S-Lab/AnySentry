# Five security moments that begin with evidence

AnySentry does not begin with an alert count. It begins with one real behavior and progressively answers identity, risk, context, and action. The homepage redraws these product moments with synthetic values while preserving interaction patterns from the current dashboard.

## 1. Identify the Agent that is actually running

Observer evidence connects process trees, containers or Pods, Workspaces, and behavior sequences to Agent Assets. Operators can distinguish `confirmed_agent`, `probable_agent`, `unknown`, and `non_agent`, inspect attribution sources, and record a human decision.

**Current boundary:** automated behavior discovery can only propose a candidate. Stable confirmation requires explicit labels, platform facts, or a human decision.

## 2. Judge a risky tool call before execution

An agent or tool gateway can call `assessRuntimeAction` before execution. L1 applies deterministic patterns and returns a `policyAction`, `severity`, `riskCategory`, `reason`, and `eventId`. L2/L3 escalate only after configuration and policy allow them.

**Current boundary:** AnySentry evaluates and records the proposed action; it does not run the submitted command. The caller must honor `require_approval` or `block` for hard control to exist.

## 3. Put isolated behavior back into time and topology

The events view preserves atomic facts. Topology connects Agents, Tools, Network, Files, LLM activity, and Risk. Episodes and streaming findings add combined signals within time windows. Investigators can drill from every aggregate relationship to an exact event.

**Research direction:** predicting dangerous trajectories over longer behavioral prefixes remains Advanced / Experimental and must be validated through lead time, false-positive rate, and evidence completeness.

## 4. Spend judgment cost only when needed

L1 handles the deterministic hot path, L2 adds semantics to one event, and L3 uses bounded read-only tools when an unresolved escalation needs context. Every tier has separate configuration, budgets, and provenance.

**Current boundary:** L2/L3 are not default out-of-box capabilities. They remain off without valid model connections and explicit policy.

## 5. Anchor every governance action to evidence

Incidents, alerts, Evidence Bundles, notifications, remediation work, objectives, and audit records share one control-plane relationship. Agents can also use the Progressive API to create a redaction-safe bundle or request evidence-ranked next actions.

**Current boundary:** an Evidence Bundle is investigation and handoff material, not a compliance certification. Remediation and notification state also does not prove an external system completed work unless its adapter returns a verifiable result.

## Recommended validation order

1. Use the [quick start](/guide/) to prove one L1 guard decision.
2. Connect one real Source and confirm identity, event, and Workspace joins.
3. Drill from topology or an Agent Asset to an atomic event.
4. Build an Evidence Bundle around the same `eventId`.
5. Only then enable L2/L3 or an enforcement gateway and measure latency, judgment error, and failure modes.
