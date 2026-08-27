# L1, L2, and L3 tiered judgment and risk taxonomy

AnySentry separates low-latency deterministic judgment, single-event semantic interpretation, and multi-evidence investigation into three tiers. Every escalation carries the source event, identity, scope, policy version, and previous-tier reason, so the final decision never leaves the evidence chain.

## Three judgment tiers

| Tier     | Responsibility                                                      | Output                                                      |
| -------- | ------------------------------------------------------------------- | ----------------------------------------------------------- |
| L1 Rules | Match deterministic patterns and explicit boundaries at low latency | `allow`, `warn`, `require_approval`, `block`, or escalation |
| L2 LLM   | Add semantics, intent, and uncertainty for one event                | Structured risk reason and whether L3 is needed             |
| L3 Agent | Use bounded Skills to examine multiple sources and blast radius     | Sourced terminal allow-or-block decision                    |

## Three risk review domains

The Dashboard always exposes three domains and eight base risk slots—even when their count is zero—so operators can see what the system reviews.

### System risk · 2 slots

- Cloud metadata SSRF
- Privilege escalation and process injection

### Communication risk · 3 slots

- Secret exfiltration
- Prompt injection
- Abnormal egress and callbacks

### Atomic action risk · 3 slots

- Dangerous command execution
- Credential file access
- Other anomalous actions

A new live risk code is appended to its domain rather than silently dropped when it is not part of the base taxonomy.

## Session and temporal context

The highest-risk session is profiled across six dimensions: command danger, prompt injection, data leakage, jailbreak bypass, communication risk, and systemic risk.

Temporal detection uses a five-minute event-time window. Each Agent Session keeps at most eight active file candidates and sixty-four behavior facts, with explicit handling for out-of-order input, duplicates, and process identity. Temporal findings remain Shadow results; proximity alone is never presented as a proven attack.

## Judgment boundaries

- L1 is the deterministic hot path.
- L2 and L3 enter the path only when model connectivity and policy are ready.
- Natural-language judgment cannot overwrite source events.
- Color and severity alone do not decide escalation.
- Every result keeps eventId, policy version, tier, reason, and latency.

Continue with the [four AI-Native security agents](/en/ai-native/), [events and Evidence Bundles](/en/evidence/), or the [governance loop](/en/safety-loop/).
