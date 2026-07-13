---
name: privilege-escalation-triage
description: Decide whether an observed privilege change (setuid/ptrace/capability) is a real escalation attempt or benign.
---

# Privilege-escalation triage

Use this when L1/L2 flagged a `SecurityAction` (setuid-root, ptrace) or a tool that changes privilege.

## What to establish
1. **Who.** Which agent/process, running as which uid, in which container/cgroup. A web-facing
   agent escalating to root is far more serious than an init script dropping privileges.
2. **Expected?** Is this process a known privileged tool (sudo, su, a package manager, a container
   runtime) invoked in a legitimate flow, or an interpreter (python/node/sh) suddenly calling
   `setuid(0)` mid-session? The latter is the strong signal.
3. **Chain.** Look at the events just before: a fresh `ToolExec` of a downloaded binary, a write to
   a setuid file, or a `ptrace` of another process turns a single event into an attack chain.

## Decide
- **block (high/critical)** — an interpreter or downloaded binary escalating to root with no
  legitimate reason; ptrace/inject into an unrelated process; setuid right after fetching a payload.
- **allow (low)** — a recognized privileged utility in an expected administrative flow, or a service
  dropping privileges (root → unprivileged), which is the safe direction.

When unsure between a one-off admin action and an exploit, prefer **block** for interpreters and
**allow** for well-known setuid binaries — and say which in the reason.
