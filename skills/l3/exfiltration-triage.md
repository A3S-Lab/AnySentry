---
name: exfiltration-triage
description: Judge whether outbound content or an egress connection is a real data-exfiltration attempt.
---

# Exfiltration triage

Use this when L1/L2 flagged outbound content (`SslContent`) or a connection (`Egress`) as possibly
leaking secrets or data.

## What to establish
1. **What is leaving.** Distinguish a credential/secret (private key, API token, password, large
   base64 blob, customer PII) from an ordinary request body that merely contains the word "token"
   (e.g. an OAuth flow to a known provider). False positives cluster on the latter.
2. **Where to.** Is the destination a known, allow-listed provider (its SNI/provider is classified),
   an unclassified IP, a paste/file-sharing host, or a raw IP with no DNS? Secrets going to a
   classified LLM provider in a normal prompt differ from secrets POSTed to an unknown IP.
3. **Volume & timing.** A sudden burst of outbound bytes, or egress right after reading a credential
   file, is the strong signal.

## Decide
- **block (high/critical)** — a private key / credential going to an unclassified or raw-IP
  destination; a read of `~/.aws/credentials` or `~/.ssh/id_*` immediately followed by egress; a
  large encoded blob to a paste host.
- **allow (low)** — a token in an authorization header to a recognized provider; ordinary API
  traffic; content that merely mentions secret-like words without an actual secret value.

If you block, prefer an egress deny on the destination so the channel itself is cut, not just one
request.
