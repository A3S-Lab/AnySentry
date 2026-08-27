# Four AI-Native security agents

AnySentry does not place AI after the alert list merely to summarize it. Four bounded security agents work at deployment, monitoring, identity review, and high-risk investigation. They share one evidence plane, so explanations, identity decisions, and terminal judgments resolve to a Source, Agent, Session, and atomic event.

## Environment Scout

During initial deployment, Environment Scout reads host, workload, Workspace, process-tree, and platform identity evidence. It discovers candidate Agents and project boundaries, then builds the first runtime profile.

It may propose an identity but cannot silently promote an inference into a confirmed Agent. Confirmation still requires platform facts, explicit labels, or a human decision.

## Risk Copilot

Risk Copilot works in monitoring and investigation views. Operators can ask about current risk, affected assets, changes in posture, the basis for a decision, and response progress.

Each answer first binds system, Agent, Session, time window, and risk scope. Important claims cite events, topology, or an Evidence Bundle rather than replacing source facts with prose.

## Identity Reviewer

Identity Reviewer organizes candidate Agent evidence, process lineage, container or Pod identity, Workspace, and behavior sequence into an attribution chain that an operator can inspect.

A human decision records reviewer, reason, and time, then becomes stable context for later event correlation.

## L3 Investigator

L3 Investigator handles high-impact, high-uncertainty events. It uses explicitly configured read-only security Skills to examine intent, behavior trajectory, host indicators, and blast radius before returning a terminal allow-or-block decision.

Model connection, Skills, timeout, concurrency, and context budget have independent bounds. Each event uses an isolated session so one case cannot bias another.

## Shared constraints

- Each agent reads only the evidence needed for its responsibility.
- Model conclusions retain provenance and judgment tier.
- Candidate identities and policy candidates require explicit confirmation.
- High-impact control actions enter audit, while the deployment owner retains execution authority.

Continue with [tiered judgment and risk taxonomy](/en/judgment/), the [governance loop](/en/safety-loop/), or the [architecture](/en/architecture/).
