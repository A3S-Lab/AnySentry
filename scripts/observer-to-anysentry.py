#!/usr/bin/env python3
"""Bridge a3s-observer NDJSON -> AnySentry /ingest.

Usage:
    A3S_OBSERVER_JSON=1 sudo -E a3s-observer-collector \
        | python3 observer-to-anysentry.py [INGEST_URL]

INGEST_URL defaults to http://localhost:29653/security-center/ingest
(or set ANYSENTRY_INGEST_URL). Each observer line is posted raw; AnySentry
derives identity/workspace/session from the line itself.
"""
import json
import os
import sys
import urllib.request

URL = (sys.argv[1] if len(sys.argv) > 1 else None) or os.environ.get(
    "ANYSENTRY_INGEST_URL", "http://localhost:29653/security-center/ingest"
)


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            json.loads(line)  # skip the collector's human log lines / partials
        except ValueError:
            continue
        body = json.dumps({"line": line}).encode()
        req = urllib.request.Request(URL, body, {"Content-Type": "application/json"})
        try:
            urllib.request.urlopen(req, timeout=2).read()
        except Exception as e:  # noqa: BLE001 — best-effort forwarder, never crash the pipe
            print(f"forward error: {e}", file=sys.stderr)


if __name__ == "__main__":
    main()
