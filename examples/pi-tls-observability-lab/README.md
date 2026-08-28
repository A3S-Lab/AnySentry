# AnySentry Pi TLS/HTTP Observability Lab

This isolated lab produces a deterministic Pi coding-agent conversation for
the non-invasive TLS/HTTP observation path. It supports both a Pi process
started directly on the host and the same process in Docker. It does not load
an AnySentry extension, Hook, proxy, or MCP wrapper into Pi.

The local fake provider drives this exact sequence:

```text
Pi final request #1 -> fake LLM
fake LLM response #1 -> read("canary.txt")
Pi read result -> final request #2
fake LLM response #2 -> bash("... | tee -a tool-events.log")
Pi bash result -> final request #3
fake LLM response #3 -> final assistant text
```

Every provider request and response chunk is written to
`fake-llm.ndjson`. Every Pi JSON event is wrapped with observation and
monotonic timestamps in `pi-events.ndjson`. `verification.json` proves the
request hashes, response lifecycle, tool order, arguments, results, observed
start/end times, side effect, and that an internal-RAG sentinel which was not
placed in the final prompt never reached the provider.

## Why the lab uses Pi built-in tools

Pi 0.83.0 intentionally has no built-in MCP client. Adding MCP support would
require an extension or wrapper, which would contradict this phase's
non-invasive requirement. The fixture therefore uses Pi's real `read` and
`bash` tools. MCP transport coverage belongs in the separate pipe/relay lab,
not in this Pi TLS workload.

## Host run

Prerequisites are Node.js 22.19 or newer, npm, OpenSSL, `readelf`, and Bash.
The first run installs the locked Pi dependency locally.

Run the HTTPS path:

```bash
cd examples/pi-tls-observability-lab
./scripts/run-host.sh
```

Run the plaintext HTTP comparison:

```bash
PI_LAB_PROTOCOL=http ./scripts/run-host.sh
```

Override `PI_LAB_HTTP_PORT` or `PI_LAB_HTTPS_PORT` when the default host ports
are already in use.

The script creates a unique ignored directory under `.runtime/host`, starts a
local provider on ports 18080/18443, generates a two-day test-only CA, runs Pi,
executes the verifier, and stops the provider. It never writes a credential to
the repository.

## Docker run

Run Pi and the provider in separate containers over HTTPS:

```bash
./scripts/run-docker.sh
```

Run the HTTP comparison:

```bash
PI_LAB_PROTOCOL=http ./scripts/run-docker.sh
```

The script uses a unique Compose project, writes results under
`.runtime/docker`, and removes only that run's containers/network on exit.
The bind-mounted results remain available for Observer and UI correlation.
The script maps all fixture containers to the invoking user's UID/GID so raw
conversation evidence remains mode `0600` while still being readable by the
host operator.
The Pi container has these Agent labels:

```text
anysentry.io/workload-kind=agent
anysentry.io/agent-id=docker-pi-tls-fixture
anysentry.io/agent-runtime=pi
```

## Attach window and TLS symbol evidence

Before importing the official Pi CLI, the Pi process sets its process title
and `PI_CODING_AGENT=true`, writes `pi-attach-ready.json`, then waits for
`PI_LAB_ATTACH_GRACE_SECONDS` (5 seconds on the host, 8 seconds in Compose by
default). This gives the passive Observer time to identify the process and
attach before the first model request. Set a larger value while developing the
attach resolver:

```bash
PI_LAB_ATTACH_GRACE_SECONDS=20 ./scripts/run-host.sh
```

`tls-runtime.json` records the exact Node executable, architecture, exported
`SSL_read`/`SSL_write` symbols, and dynamically mapped TLS libraries. Node may
export OpenSSL symbols from its main executable without mapping a separate
`libssl.so`; the Observer must inspect the real runtime evidence instead of
assuming a fixed `/usr/lib/.../libssl.so.3` path.

## Result contract

A successful local fixture produces:

| File | Evidence |
| --- | --- |
| `results/fake-llm.ndjson` | Exact final request bodies, hashes, response chunks, request/response times, HTTP or HTTPS transport |
| `results/pi-events.ndjson` | Pi conversation, LLM-visible responses, tool start/end, arguments, results, wrapper observation times |
| `results/tls-runtime.json` | Executable and OpenSSL attach facts for the actual runtime |
| `results/verification.json` | Machine-readable assertions and paths |
| `workspace/tool-events.log` | Real bash side effect and output sentinel |

The deterministic verifier expects all assertions to pass. It also checks
that the Authorization value is never copied into a transcript; only the fact
that authorization was present is recorded.

## External OpenAI-compatible endpoint

The fake provider is the repeatable default. To let the main integration test
use an external endpoint, inject configuration through the environment. Never
put a real key in `compose.yaml`, `.env.example`, a command argument, or Git.

```bash
export PI_LAB_MODE=external
export PI_LAB_BASE_URL=http://openai-compatible-host.example/v1
export PI_LAB_API_KEY='set-outside-git'
export PI_LAB_MODEL='supported-model-id'
export PI_LAB_EXPECT_FIXTURE=0
export PI_LAB_ALLOW_EXTERNAL_HOST_TOOLS=1
./scripts/run-host.sh
```

External mode does not start or assert the fake-provider transcript. It still
requires Pi to complete the declared `read -> bash -> final` prompt and checks
the Pi-side tool order, arguments, result content, and timing. The actual API
key is resolved by Pi from `$PI_LAB_API_KEY`; generated `models.json` contains
only that environment-variable reference.

External host mode requires the explicit
`PI_LAB_ALLOW_EXTERNAL_HOST_TOOLS=1` acknowledgement because an external model
can select the enabled `bash` tool. Prefer Docker for external testing: it has
no host filesystem or Docker-socket mount beyond this lab's newly created
runtime directories.

## Cleanup

The run scripts stop their child processes and Compose resources themselves.
Remove only ignored lab output when no longer needed:

```bash
./scripts/cleanup.sh host
./scripts/cleanup.sh docker
./scripts/cleanup.sh all
```

The cleanup script validates its target and refuses paths outside this lab's
`.runtime` directory.
