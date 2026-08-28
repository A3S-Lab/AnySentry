# AnySentry LangChain TLS observability lab

This isolated Docker lab runs a real LangChain `ChatOpenAI.bind_tools` Agent loop against the same
deterministic HTTPS OpenAI-compatible fixture used by the Pi lab. It installs no Hook, callback,
Adapter, proxy, or certificate-forging component in the Agent. Observer discovers the Python
process from its `langchain` command line, resolves its container-private dynamic OpenSSL mapping,
and observes the HTTP/1.1 + SSE plaintext at the TLS function boundary.

The expected model/tool sequence is:

```text
final request #1 -> LLM -> read("canary.txt")
final request #2 (read result included) -> LLM -> bash(fixed fixture command)
final request #3 (both results included) -> LLM -> visible final response
```

Run from this directory:

```bash
LANGCHAIN_LAB_ATTACH_GRACE_SECONDS=10 ./scripts/run-docker.sh
```

The verifier requires three HTTPS provider requests, exact `read -> bash` order and results, the
final response markers, and absence of the internal-RAG sentinel from every serialized model
request. Results are retained under ignored `.runtime/<run-id>/` for Observer/hash reconciliation.

Test-only dependencies are pinned in the Dockerfile (`langchain==1.3.17` and
`langchain-openai==1.6.0`); they are not AnySentry production dependencies. The supported product
statement remains transport-specific: Python runtime with a verified dynamic OpenSSL ABI,
HTTP/1.1, JSON and SSE. A LangChain deployment using HTTP/2, a different TLS implementation, or a
remote sidecar/gateway must report its own coverage state.

## HTTP service fixture

`app/service.py` exposes `GET /health` and `POST /invoke` for testing a long-running LangChain
Agent entered through HTTP rather than a one-shot CLI. It uses one deterministic
`lookup_fixture(key="canary")` tool and sends every model call through the configured HTTPS
OpenAI-compatible base URL. Provider URL and credentials are required runtime environment values;
they are never embedded in this source or returned by the service.

The service-only dependencies are pinned in `requirements-service.txt`. They remain a manual lab
environment and do not become AnySentry production dependencies.
