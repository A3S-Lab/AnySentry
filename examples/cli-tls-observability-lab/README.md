# Codex HTTP and Claude Code TLS observability lab

This host lab validates exact installed CLI builds against a controlled provider without
installing a Hook, Adapter, proxy, or fake CA into either Agent. It starts a local test server,
launches each CLI with stdin held open for an attach grace window, and then feeds the prompt.

- Codex CLI uses an explicit custom provider with `wire_api="responses"` and
  `supports_websockets=false`. For the verified Codex `0.150.1` build, `SSL_CERT_FILE` or
  `CODEX_CA_CERTIFICATE` deliberately selects Rustls, while a hashed `SSL_CERT_DIR` keeps the
  custom-provider HTTPS REST request on the embedded OpenSSL path. The HTTPS fixture uses the
  latter and validates the exact OpenSSL 3 `_ex` profile without changing the system trust store.
- Claude Code uses `ANTHROPIC_BASE_URL` and the Messages/SSE protocol. The exact supported binary
  fingerprint is resolved to its embedded BoringSSL classic read/write offsets.

Both fixtures request one harmless stdout-only shell tool, return its result to the model, and then
finish. Credentials stay in process environment and are never written into tracked files or
provider transcripts. The CA is a two-day test-only CA supplied through per-process trust
environment variables; no system trust store or provider identity is modified.

```bash
CLI_LAB_ATTACH_GRACE_SECONDS=6 ./scripts/run-host.sh
```

The expected Observer result is two complete TLS `LlmInteraction` records for Codex and two
complete TLS records for Claude Code: a first response containing the tool instruction, and a
second request containing the tool result plus the visible final response. Unsupported
fingerprints fail closed. Set `CLI_LAB_CODEX_PROTOCOL=https` to exercise the verified OpenSSL TLS
path; the loopback HTTP mode remains useful for isolating parser behavior. The
official Codex configuration reference documents custom provider `base_url`/`env_key`, Responses
as the only `wire_api`, and `supports_websockets` as the WebSocket capability switch.

## Metadata-only HTTPS front

`app/proxy.mjs` provides an optional HTTPS, HTTP/1.1-only front for testing a real compatible
upstream. It forwards request and response bytes without persisting their content or authentication
headers. Its `0600` NDJSON diagnostic contains only method/path, sizes, body hashes, status,
content type, timing, and SSE event type order. The upstream URL, proxy URL, and credentials remain
process environment only.

Required runtime configuration:

```bash
CLI_LAB_UPSTREAM_BASE_URL=http://upstream.example/v1 \
CLI_LAB_UPSTREAM_PROXY_URL=http://proxy.example:3128 \
CLI_LAB_TLS_DIR=.runtime/proxy/tls \
CLI_LAB_RESULTS_DIR=.runtime/proxy/results \
node app/proxy.mjs
```

The current implementation accepts an HTTP or HTTPS direct upstream. Forward-proxy mode is
deliberately limited to an HTTP upstream; it does not implement CONNECT or act as a general-purpose
MITM. The generated CA and all metadata remain under the ignored `.runtime/` directory.
