# Codex HTTP and Claude Code TLS observability lab

This host lab validates exact installed CLI builds against a controlled provider without
installing a Hook, Adapter, proxy, or fake CA into either Agent. It starts a local test server,
launches each CLI with stdin held open for an attach grace window, and then feeds the prompt.

- Codex CLI uses an explicit custom provider with `wire_api="responses"` and
  `supports_websockets=false`. In the verified Codex `0.150.1` build, both the default WebSocket
  path and custom-provider HTTPS REST use Rustls rather than the embedded OpenSSL functions. The
  default fixture therefore uses loopback HTTP and validates the syscall plaintext path. It does
  not claim passive HTTPS coverage for this Codex build.
- Claude Code uses `ANTHROPIC_BASE_URL` and the Messages/SSE protocol. The exact supported binary
  fingerprint is resolved to its embedded BoringSSL classic read/write offsets.

Both fixtures request one harmless stdout-only shell tool, return its result to the model, and then
finish. Credentials stay in process environment and are never written into tracked files or
provider transcripts. The CA is a two-day test-only CA supplied through per-process trust
environment variables; no system trust store or provider identity is modified.

```bash
CLI_LAB_ATTACH_GRACE_SECONDS=6 ./scripts/run-host.sh
```

The expected Observer result is two complete HTTP `LlmInteraction` records for Codex and two
complete TLS records for Claude Code: a first response containing the tool instruction, and a
second request containing the tool result plus the visible final response. Unsupported
fingerprints fail closed. `CLI_LAB_CODEX_PROTOCOL=https` can check that the fixture itself works
over HTTPS, but it is intentionally outside the currently verified Codex plaintext coverage. The
official Codex configuration reference documents custom provider `base_url`/`env_key`, Responses
as the only `wire_api`, and `supports_websockets` as the WebSocket capability switch.
