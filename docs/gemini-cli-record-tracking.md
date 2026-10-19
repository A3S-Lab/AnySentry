# Gemini CLI record tracking

## Supported chain

AnySentry treats the three identities as separate values:

```text
Gemini native sessionId
  -> AnySentry conversationId
  -> exact OS process generation
  -> persisted process lineage
  -> Observer event relation
```

The local adapter reads both whole-record JSON and append-oriented JSONL under
`$GEMINI_CLI_HOME/.gemini/tmp/<projectHash>/chats/` (default `~/.gemini/tmp/...`). It derives the display
title from the first real user instruction, excludes runtime context records, and keeps tool calls,
tool results, model, token usage, and stable timeline event IDs.

Gemini's npm launcher is a generic Node process. It is accepted as Gemini CLI only when argv's
entrypoint is inside `@google/gemini-cli`; a prompt or model argument containing `gemini` is not
identity evidence.

Session binding uses, in descending order:

1. `/proc/<pid>/fd` pointing at the exact Session file;
2. a bounded `FileAccess` observation for the Session file;
3. no binding. Time/workspace similarity is not promoted to a certain relation.

Use `deploy/modules/observer-gemini-file-canary.yml` only for a short binding validation. The
collector retains FileAccess records only below `/home/zhongyule/.gemini/tmp`; unrestricted file
capture remains disabled by default.

## Network plaintext boundary

The AnySentry Interaction schema and forwarder understand
`gemini_cli_ebpf_openssl`/`generate_content_api`, and route accepted content through the encrypted
Interaction lane. This is not by itself a production capture claim. The current Observer still
needs a supported exact Node/OpenSSL attach implementation and an end-to-end live Gemini request
test before network plaintext can be marked available.

## Verification

```bash
pnpm verify:gemini-cli-local-record-tracking
node scripts/verify-forwarder-attribution.mjs
node scripts/verify-observer-interaction-forwarder.mjs
```
