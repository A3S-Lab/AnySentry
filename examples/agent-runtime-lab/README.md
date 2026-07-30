# AnySentry Agent Runtime Lab

This lab runs two deliberately small, continuously observable Agent workloads:

- `a3s-loop`: loads `@a3s-lab/code@6.6.0` and repeatedly invokes its direct
  `writeFile`, `readFile`, and `bash` tools. It needs no LLM credentials.
- `pi`: runs the official `@earendil-works/pi-coding-agent@0.83.0` CLI. With a
  provider credential it repeatedly asks the model to use `read` and `bash`.
  Without credentials it stays alive in RPC mode, providing a real Pi process
  for discovery and identity tests without producing paid model traffic.

Both runtimes use harmless canary files under `/workspace`. They never mount
the host filesystem or Docker socket. Their long-lived wrapper processes also
make a periodic connection attempt to the closed loopback port
`127.0.0.1:9`. No data leaves the container; this gives older Observer builds a
live PID from which to resolve the Docker cgroup before short-lived tool
processes exit.

## Prerequisites

- Docker 20.10+
- Node.js 22.19+ when running outside the image
- `kubectl` access to a Kubernetes cluster
- A registry reachable by the Kubernetes node (the commands below use the
  local registry at `127.0.0.1:5000`)

## Docker

Build and start both agents:

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f
```

To feed Docker workload events into an AnySentry API exposed on host port
`29653`, first build the current repository's forwarder around the local
Observer binary, then start the optional observe-only service:

```bash
docker build -f Dockerfile.observer \
  --build-arg OBSERVER_IMAGE=127.0.0.1:5000/anysentry-observer:local \
  -t 127.0.0.1:5000/anysentry-observer:agent-runtime-lab ../..
docker compose --profile observe up -d docker-observer
docker logs -f anysentry-agent-lab-observer
```

The observer needs `privileged`, host PID, read-only `/sys`, and read-only
Docker socket access so it can attach eBPF probes and resolve container labels.
It runs the passive collector only; it does not run an enforcement binary.
Override `ANYSENTRY_OBSERVER_IMAGE` or `ANYSENTRY_DOCKER_INGEST_URL` when the
image/endpoint differs. The default forwarder image is
`127.0.0.1:5000/anysentry-observer:agent-runtime-lab`; the build command above
combines the local Observer binary with the repository's current workload
discovery and filtering scripts. `FORWARD_SCOPE=agent` keeps known non-Agent
host and container activity out of the AnySentry ingest stream. Plaintext SSL
capture and the high-volume file-write probe are disabled in this lightweight
profile; process execution, network, DNS, security, and other core signals
remain available. The lab image also includes a loopback-only compatibility
adapter: the current forwarder sends a bounded batch to the adapter, which
submits its events one by one to older AnySentry deployments that only expose
`/security-center/ingest`. The adapter promotes the current attribution scope
to the legacy top-level `agentId` and only submits the two explicit Docker IDs
listed in `ANYSENTRY_LEGACY_AGENT_IDS`.

By default Pi uses RPC standby because no API key is supplied. To run real Pi
LLM/tool turns:

```bash
export PI_EXECUTION_MODE=loop
export PI_PROVIDER=openai
export PI_MODEL=gpt-4o
export OPENAI_API_KEY=...
docker compose up -d pi-agent
```

The Compose file also passes `ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`,
`GEMINI_API_KEY`, and `OPENROUTER_API_KEY` when they are present.

Stop and remove the lab containers while preserving their named volumes:

```bash
docker compose down
```

If the observer profile was started, include the profile while stopping it:

```bash
docker compose --profile observe down
```

To remove the test volumes as well:

```bash
docker compose down --volumes
```

## Kubernetes

Build and publish the image to the local registry:

```bash
docker build -t anysentry-agent-runtime-lab:0.1.0 .
docker tag anysentry-agent-runtime-lab:0.1.0 \
  127.0.0.1:5000/anysentry-agent-runtime-lab:0.1.0
docker push 127.0.0.1:5000/anysentry-agent-runtime-lab:0.1.0
```

Create the isolated namespace, grant the existing AnySentry service account
read-only Pod discovery in that namespace, and start both agents:

```bash
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/rbac.yaml
kubectl apply -f k8s/agents.yaml
kubectl -n anysentry-agent-test rollout status deployment/a3s-code-tool-loop
kubectl -n anysentry-agent-test rollout status deployment/pi-coding-agent
```

The AnySentry API must list the lab namespace in
`ANYSENTRY_AGENT_NAMESPACES`. Preserve its existing entries and append
`anysentry-agent-test`. For a deployment currently watching `default`:

```bash
kubectl -n anysentry set env deployment/anysentry \
  ANYSENTRY_AGENT_NAMESPACES=default,anysentry-agent-test
kubectl -n anysentry rollout status deployment/anysentry
```

Pi remains in RPC standby until credentials are added. Copy the example Secret
to an ignored/local filename, replace its value, apply it, and restart Pi:

```bash
cp k8s/pi-agent-credentials.example.yaml /tmp/pi-agent-credentials.yaml
# Edit /tmp/pi-agent-credentials.yaml; never commit the real key.
kubectl apply -f /tmp/pi-agent-credentials.yaml
kubectl -n anysentry-agent-test rollout restart deployment/pi-coding-agent
```

Observe the test:

```bash
kubectl -n anysentry-agent-test get pods -o wide
kubectl -n anysentry-agent-test logs -f deployment/a3s-code-tool-loop
kubectl -n anysentry-agent-test logs -f deployment/pi-coding-agent
kubectl -n anysentry-agent-test exec deployment/a3s-code-tool-loop -- \
  tail -n 5 /workspace/tool-events.log
```

Remove only the isolated test namespace and its contents:

```bash
kubectl delete namespace anysentry-agent-test
```

If the bundled AnySentry deployment is retained, also restore its original
namespace list:

```bash
kubectl -n anysentry set env deployment/anysentry \
  ANYSENTRY_AGENT_NAMESPACES=default
```

## Expected AnySentry attribution

| Runtime | Environment | Agent ID | Expected source |
|---|---|---|---|
| A3S Code | Docker | `docker-a3s-code-loop` | Docker self-registration |
| Pi | Docker | `docker-pi-agent` | Docker self-registration |
| A3S Code | Kubernetes | `k8s-a3s-code-loop` | Kubernetes labels |
| Pi | Kubernetes | `k8s-pi-agent` | Kubernetes labels |

The two Kubernetes workloads are in `anysentry-agent-test` and use
`anysentry.io/workload-kind=agent`. Docker containers carry the equivalent
labels. A3S Code emits periodic file and child-process activity. Pi emits the
same kinds of activity after LLM credentials are configured.

Older deployed AnySentry API images may display a Kubernetes Pod name as the
event's top-level `agentId` even though the workload label contains
`k8s-a3s-code-loop` or `k8s-pi-agent`. In that case, use the
`anysentry-agent-test/<pod-name>` workspace to verify Pod attribution. The
Docker compatibility adapter promotes label-derived scope IDs explicitly, so
its top-level IDs remain `docker-a3s-code-loop` and `docker-pi-agent`.

## Version and architecture notes

The repository's ARM64 release bundle contains `@a3s-lab/code@5.1.0` with an
ARM64-only native module and cannot run on this x86_64 machine. This lab locks
`@a3s-lab/code@6.6.0`, whose optional dependency resolver installs the correct
native module for the image architecture.

The old `@mariozechner/pi-coding-agent` package is deprecated. The maintained
package is `@earendil-works/pi-coding-agent`; both expose the `pi` command.
