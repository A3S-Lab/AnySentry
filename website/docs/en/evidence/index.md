# How one event becomes a system fact you can question

AnySentry uses a stable `eventId` to connect the source signal, canonical event, judgment, topology, Evidence Bundle, policy candidate, and audit record. The risk shown to an operator is not an isolated red dot; it is a system fact that remains open to investigation.

## Capture the source signal

Observer, Agent API, JSON, CloudEvents, or OTLP accepts process, tool, file, network, DNS, LLM, and security actions. The system retains Source, receive time, source event identity, and available process context.

## Normalize identity and context

Signals become `anysentry.agent_event.v1` and bind Source, Agent, Workspace, Session, Run, Trace, and category. Sensitive fields receive key-aware redaction before storage or return.

## Preserve tiered judgment

Every tier records policy version, verdict, reason, latency, and whether escalation continues. Structured L2 and L3 conclusions coexist with—not overwrite—L1 and the source event.

## Connect governance actions

Judgment follows `eventId` into event detail, topology, Incident, Alert, Evidence Bundle, policy candidates, Runtime Guard, and audit. Human approval, response state, and execution result return to the same context.

## What an Evidence Bundle contains

- Case scope and stable identity
- Time-ordered atomic events
- Agent, Tool, File, Network, and Risk topology
- L1, L2, and L3 decisions with provenance
- Redaction and integrity state
- Policy, approval, response, and audit records

An Evidence Bundle supports investigation, review, and handoff. It does not replace source events or constitute a compliance certification.

Continue with the [architecture](/en/architecture/), [operating scenarios](/en/scenarios/), or [quick start](/en/guide/).
