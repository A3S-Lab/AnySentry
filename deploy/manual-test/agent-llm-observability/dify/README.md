# Dify non-invasive TLS/HTTP observation lab

This directory is an isolated manual-test environment for the approved three-layer, non-invasive
Agent-to-LLM observation design. It starts the official Dify Docker deployment plus two local
fixtures:

- `llm-mock`: OpenAI-compatible HTTP and HTTPS endpoints with non-streaming JSON, HTTP/1.1
  chunked SSE, `/v1/models`, Chat Completions, and Responses fixtures;
- `tool-mock`: a separate HTTPS SNI that accepts a Dify HTTP Request tool instruction and returns
  an execution result with start/end nanosecond timestamps.

The default path makes no external model request. A real OpenAI-compatible endpoint can be selected
later through a protected file or process environment; no provider API key is stored in this
directory, a Dockerfile, Compose YAML, image layer, command argument, or fixture log.

This lab does not add a Dify Hook or Adapter and does not modify AnySentry or Observer core code.

## 1. What the lab proves

```text
Dify Service API request
        |
        v
  api / worker / plugin provider process             Observer decision level
        |                                             -----------------------
        | final prompt assembly                       1. Agent process/container
        v                                             2. exact POST path
  OpenAI-compatible client                            3. HTTP framing + model body
        |
        | SSL_write(_ex) plaintext       <--- uprobe capture point
        | TLS records                   <--- normal egress is ciphertext
        v
  llm-mock:443  -- HTTP/1.1/SSE --> response
        |
        v
  SSL_read(_ex) plaintext                <--- uprobe capture point
        |
        +--> optional HTTPS tool request --> tool-mock:443
```

The fixture records only request/response byte counts, SHA-256 values, protocol version, status,
and marker booleans. It deliberately does not log Authorization headers, request content, or
response content. This provides an independent reconciliation source without creating a second raw
content store. For chunked SSE, the response hash covers the dechunked SSE body, excluding HTTP
headers and chunk framing; compare it with Observer at the same normalization boundary.

Two Dify DSL fixtures are installed:

- `AnySentry Dify LLM Observation` sends `query` and `final_context` to the model. It accepts an
  `internal_rag_sentinel` input but never references it in the LLM prompt. The provider record must
  show `final_selected_rag_marker_present=true` and `internal_rag_sentinel_present=false`.
- `AnySentry Dify LLM and HTTP Tool Observation` calls the LLM, forwards its actual response as an
  HTTPS tool instruction, and returns the tool result. `llm-mock` and `tool-mock` use separate SNI
  names so endpoint attribution and independent reconciliation ledgers can be checked; the current
  plaintext gate itself uses PID/cgroup, exact POST path, and userspace semantics.

## 2. Reproducible inputs

[`versions.env`](./versions.env) pins:

- Dify `1.14.2`, archive checksum, and upstream commit;
- Dify API and plugin-daemon image tags used by the official Compose file, plus the observed
  registry pull digest for the Dify API image;
- the exact signed Marketplace identifier for OpenAI-API-compatible plugin `0.0.64`;
- the local fixture model name.

`prepare.sh` downloads the official tag archive, verifies SHA-256, and extracts only its `docker/`
directory under ignored `.runtime/`. The tracked repository does not vendor or silently rewrite
Dify's generated Compose file. The upstream references are the
[official Dify Compose file](https://github.com/langgenius/dify/blob/1.14.2/docker/docker-compose.yaml),
[official Docker deployment README](https://github.com/langgenius/dify/blob/1.14.2/docker/README.md),
and the
[official OpenAI-compatible provider schema](https://github.com/langgenius/dify-official-plugins/blob/main/models/openai_api_compatible/provider/openai_api_compatible.yaml).

The official Dify Compose still contains several upstream dependency images with mutable tags.
That is recorded as an upstream reproducibility limitation; AnySentry's lab-specific mock base image
is digest-pinned.

## 3. Quick start: local-only TLS test

Prerequisites: Docker Engine, Docker Compose, Bash, `curl`, `jq`, `openssl`, `python3`, and roughly
the resources required by a normal Dify self-hosted deployment.

From the AnySentry repository root:

```bash
LAB=deploy/manual-test/agent-llm-observability/dify

# Static validation downloads/verifies the pinned Dify archive and renders the merged Compose.
"$LAB/scripts/validate.sh" --static

# Start official Dify plus local HTTPS LLM/tool fixtures.
"$LAB/scripts/up.sh"

# Wait until all components are ready.
"$LAB/scripts/health.sh"

# One-time setup: admin, pinned provider plugin, local TLS model, two DSLs,
# workflow publication, and protected Service API keys.
"$LAB/scripts/initialize.sh"

# Generate one model-only exchange and one LLM -> HTTPS-tool exchange.
"$LAB/scripts/run-workflow.sh" llm
"$LAB/scripts/run-workflow.sh" tool

# Show the actual OpenSSL version, mapped libssl objects, resolvable symbols,
# provider-process host PIDs, and content-free HTTP/1.1/hash evidence.
"$LAB/scripts/inspect-tls.sh"
```

The Dify console is `http://127.0.0.1:18080`. Fixture endpoints are bound to loopback only:

| Service | HTTP | HTTPS |
| --- | --- | --- |
| LLM fixture | `127.0.0.1:18000` | `localhost:18444` |
| Tool fixture | `127.0.0.1:18001` | `localhost:18445` |

Inside the Compose network, Dify uses `https://llm-mock/v1` and
`https://tool-mock/tool/execute`. A private, 30-day test CA is generated under `.runtime/tls` and
combined with the host system PEM bundle before being mounted read-only into `api`, `worker`, and
`plugin_daemon`. This preserves public-CA validation while adding only the two lab DNS names. Dify's
test-only Squid include permits only `llm-mock` and `tool-mock`; do not reuse it in production.

## 4. Real OpenAI-compatible endpoint

The parent integration test should decide when to make a potentially billable external request.
The lab supports the supplied endpoint and credential but intentionally does not repeat either
credential value in tracked files or examples.

The protected file form is preferred because an exported secret is readable by other processes
running as the same OS user on some systems:

```bash
set +x
LAB=deploy/manual-test/agent-llm-observability/dify
provider_key_file="$(mktemp /tmp/anysentry-dify-provider-key.XXXXXX)"
chmod 0600 "$provider_key_file"
IFS= read -r -s -p 'OpenAI-compatible API key: ' provider_key
printf '\n'
printf '%s' "$provider_key" >"$provider_key_file"
unset provider_key

export DIFY_LAB_LLM_BASE_URL='<openai-compatible-base-url>'
export DIFY_LAB_LLM_API_KEY_FILE="$provider_key_file"
# Set this when the upstream model ID is not anysentry-observation-model.
export DIFY_LAB_ENDPOINT_MODEL_NAME='<upstream-model-id>'
export DIFY_LAB_FORCE_MODEL_CREDENTIAL=1
# For an explicitly approved http:// test endpoint only, also acknowledge that
# the provider key and conversation cross the network in plaintext:
# export DIFY_LAB_ALLOW_INSECURE_HTTP=1
"$LAB/scripts/initialize.sh"
unset DIFY_LAB_LLM_BASE_URL DIFY_LAB_LLM_API_KEY_FILE DIFY_LAB_ENDPOINT_MODEL_NAME \
  DIFY_LAB_FORCE_MODEL_CREDENTIAL DIFY_LAB_ALLOW_INSECURE_HTTP

# Move or securely delete the explicit temporary credential file according to local policy.
```

For a tightly controlled disposable shell, `DIFY_LAB_LLM_API_KEY` is also accepted. The script
copies it to a mode-0600 temporary request file, sends it only to Dify's credential endpoint, then
overwrites and unlinks the temporary file. It is never passed as a command-line argument or Docker
environment variable. Dify persists the configured provider credential in its own encrypted
credential store; the lab cannot make Dify stateless with respect to an installed provider.

If the base URL is plain `http://`, both the provider credential and conversation cross the network
without TLS protection. `initialize.sh` therefore requires the explicit
`DIFY_LAB_ALLOW_INSECURE_HTTP=1` acknowledgement. Use that path only on an approved isolated test
network. Observer should exercise its HTTP egress parser because bytes at the socket boundary are
plaintext. With the default `https://llm-mock/v1`, normal egress contains TLS records and the
expected body source is the dynamically attached TLS function boundary.

## 5. Observer attachment and expected evidence

The relevant containers carry these labels:

```text
anysentry.io/workload-kind=agent
anysentry.io/agent-id=dify-observation-lab
anysentry.io/agent-runtime=dify
anysentry.io/runtime-role=api|worker|model-provider
```

The LLM and tool fixtures are explicitly labeled `test-fixture`, not Agent. Observer applies the
same three gates as the production design before storing content:

1. the source PID/cgroup belongs to the Dify Agent asset;
2. the request is a POST to a default LLM path or explicitly configured tool path;
3. userspace validates an LLM request body, or relies on the explicit authority of the tool path.

The model path `/v1/chat/completions` is a closed default. The HTTP Request node additionally needs
`A3S_OBSERVER_TOOL_HTTP_ROUTES=/tool/execute`. The test run also uses
`A3S_OBSERVER_TLS_PROCESS_PATTERNS=openai_api_compatible,celery` to select the actual provider and
worker PIDs. `celery` is deliberately test-only and is too broad for a production default; never
broaden either process or route selection to every Dify dependency request.

`inspect-tls.sh --images` checks the pinned Dify API image without starting the full stack.
`inspect-tls.sh` checks running `api`/`worker` Python SSL linkage and reads host `/proc/<pid>/maps`
for provider subprocesses in `plugin_daemon`. The success condition for the eBPF TLS path is:

- `_ssl` and `libssl` are dynamically mapped;
- the real mapped inode is reachable through `/proc/<pid>/root/...`;
- required symbols such as `SSL_write`, `SSL_write_ex`, `SSL_read`, and `SSL_read_ex` resolve;
- the resolver attaches before `run-workflow.sh` sends the first model request;
- mock records show HTTP/1.1 and the Observer request/response hashes match after HTTP dechunking.

A fixed host path such as `/usr/lib/x86_64-linux-gnu/libssl.so.3` is insufficient for a
container-private library. An attach success against another inode does not prove Dify coverage.

The actual model client normally runs in a provider subprocess managed by `plugin_daemon`; exact
PID and mapped library are runtime facts and must be inspected after plugin installation and one
workflow call. The Dify API/worker probes are still useful for the HTTP Request tool node and for
negative/coverage evidence, but should not be assumed to own every model socket.

## 6. What passive TLS cannot infer by itself

The outbound provider body proves the final messages, tools schema, model parameters, and visible
response. It does not necessarily contain Dify's tenant ID, app ID, workflow-run ID, or node ID.
PID/cgroup attribution therefore proves the shared Dify runtime, not automatically the logical
tenant/workflow. In the current no-Hook phase:

- retain Runtime-level attribution when no stable semantic ID is present;
- use explicit provider/user/request IDs only when they actually occur on the wire;
- do not manufacture workflow/node identity from timing proximity;
- record this as a correlation limitation rather than marking the Interaction complete.

Later Dify Trace/Hook work can add strong logical IDs without changing the TLS content evidence.

## 7. Validation modes

```bash
# No Dify containers: syntax, Python compile, DSL parse/boundary assertions,
# secret-literal scan, upstream checksum, and merged Compose render.
deploy/manual-test/agent-llm-observability/dify/scripts/validate.sh --static

# Additionally build/run a disposable mock container and verify HTTP, TLS 1.2+,
# HTTP/1.1 chunked SSE, auth, marker boundary, and hash ledger.
deploy/manual-test/agent-llm-observability/dify/scripts/validate.sh --container
```

The container validation uses a unique ephemeral container name and random loopback host ports. It
does not start Dify or call an external LLM.

## 8. Cleanup and retained data

```bash
LAB=deploy/manual-test/agent-llm-observability/dify

# Stop/remove lab containers and network; retain Dify volumes and ignored runtime.
"$LAB/scripts/down.sh"

# Explicit destructive cleanup of volumes owned by this isolated Compose project.
"$LAB/scripts/down.sh" --volumes
```

Generated certificates, local test credentials, Console cookies, app API keys, result streams, and
the extracted upstream Docker directory remain under ignored `.runtime/`. Remove or archive that
exact directory according to the test host's data-handling policy after the run. The script does
not recursively delete it automatically because it can contain captured test conversation data.

## 9. Known constraints

- Dify and the OpenAI-compatible plugin are version-gated. Upgrading either requires regenerating
  fixture evidence and rechecking provider schema, process ownership, symbols, and DSL import.
- The local mock deliberately targets HTTP/1.1 + chunked SSE, matching the first eBPF parser gate.
  It does not claim HTTP/2, WebSocket, or QUIC coverage.
- `tool-mock` demonstrates an HTTPS HTTP Request node. A Dify plugin tool or Agent Strategy may run
  in a different provider subprocess and needs its own compatibility fixture.
- This isolated self-hosted setup initializes one workspace. It does not by itself satisfy the PRD
  two-tenant isolation scenario; that gate needs two supported workspaces or two separately labeled
  Dify projects and an explicit cross-tenant negative test.
- The Compose labels intentionally exercise a predeclared/Confirmed Dify workload. The lab leaves
  an attach grace in the parent test procedure; it does not claim that a request completed before
  PID-scoped attach can be recovered later.
- The bundled Dify DSLs cover text prompts and an HTTPS tool result, not Dify's upload/file-input
  path. Inline and reference-only multimodal semantics remain covered by the protocol fixture suite
  in the main implementation and need a separate Dify file-upload compatibility case.
- Dify's SSRF proxy is modified only through a test-only include that allowlists two Compose DNS
  names. The production SSRF policy must remain unchanged.
- Raw provider content is not written by the mock. Full plaintext appears only in the dedicated
  AnySentry Interaction record, whose raw query requires management authentication and audit.
