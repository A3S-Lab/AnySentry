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
import re
import sys
import threading
import urllib.parse
import urllib.request


def env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name) or str(default))
    except ValueError:
        return default


URL = (sys.argv[1] if len(sys.argv) > 1 else None) or os.environ.get(
    "ANYSENTRY_INGEST_URL", "http://localhost:29653/security-center/ingest"
)
COLLECTOR_ID = (
    os.environ.get("A3S_OBSERVER_COLLECTOR_ID")
    or os.environ.get("COLLECTOR_ID")
    or os.environ.get("HOSTNAME")
    or ""
)
NODE_NAME = os.environ.get("A3S_NODE_NAME") or os.environ.get("NODE_NAME") or ""
SOURCE_ID = os.environ.get("ANYSENTRY_SOURCE_ID") or ""
SOURCE_NAME = os.environ.get("ANYSENTRY_SOURCE_NAME") or ""
SOURCE_TYPE = os.environ.get("ANYSENTRY_SOURCE_TYPE") or "observer"
SOURCE_TOKEN = os.environ.get("ANYSENTRY_INGEST_TOKEN") or ""
WORKSPACE_PATH = os.environ.get("ANYSENTRY_WORKSPACE_PATH") or ""
HEARTBEAT_SECS = max(0, env_int("ANYSENTRY_HEARTBEAT_SECS", 30))
DROP_PATHS = [
    value.strip()
    for value in os.environ.get("FORWARD_DROP_PATHS", "/sys/,/proc/,/run/,/dev/").split(",")
    if value.strip()
]


def default_heartbeat_url(ingest_url: str) -> str:
    parsed = urllib.parse.urlparse(ingest_url)
    path = re.sub(r"/ingest(?:/.*)?$", "/collectors/heartbeat", parsed.path)
    if path == parsed.path:
        path = "/security-center/collectors/heartbeat"
    return urllib.parse.urlunparse(parsed._replace(path=path, fragment=""))


HEARTBEAT_URL = os.environ.get("ANYSENTRY_HEARTBEAT_URL") or default_heartbeat_url(URL)
LOCK = threading.Lock()
EVENT_KIND_COUNTS: dict[str, int] = {}
OUTPUT_DROPPED = 0
ERROR_COUNT = 0
INFLIGHT = 0
STOP = threading.Event()


def source_fields() -> dict[str, str]:
    fields = {"sourceType": SOURCE_TYPE}
    if SOURCE_ID:
        fields["sourceId"] = SOURCE_ID
    if SOURCE_NAME:
        fields["sourceName"] = SOURCE_NAME
    if WORKSPACE_PATH:
        fields["workspacePath"] = WORKSPACE_PATH
    return fields


def source_headers() -> dict[str, str]:
    headers = {"Content-Type": "application/json"}
    if SOURCE_ID:
        headers["X-AnySentry-Source-Id"] = SOURCE_ID
    if SOURCE_TOKEN:
        headers["X-AnySentry-Ingest-Token"] = SOURCE_TOKEN
    return headers


def record_output_failure() -> None:
    global ERROR_COUNT, OUTPUT_DROPPED
    with LOCK:
        OUTPUT_DROPPED += 1
        ERROR_COUNT += 1


def post_json(url: str, payload: dict[str, object], timeout: float) -> bool:
    body = json.dumps(payload).encode()
    req = urllib.request.Request(url, body, source_headers())
    try:
        urllib.request.urlopen(req, timeout=timeout).read()
        return True
    except Exception as e:  # noqa: BLE001 — best-effort forwarder, never crash the pipe
        print(f"forward error: {e}", file=sys.stderr)
        return False


def event_kind(parsed: dict[str, object]) -> str:
    event = parsed.get("event")
    if not isinstance(event, dict):
        return ""
    return next(iter(event.keys()), "")


def is_noise(parsed: dict[str, object]) -> bool:
    event = parsed.get("event")
    if not isinstance(event, dict):
        return False
    payload = event.get("FileAccess") or event.get("FileDelete")
    if not isinstance(payload, dict):
        return False
    path = payload.get("path")
    return isinstance(path, str) and any(path.startswith(prefix) for prefix in DROP_PATHS)


def bump_event_kind(parsed: dict[str, object]) -> None:
    kind = event_kind(parsed)
    if not kind or kind == "CollectorHeartbeat":
        return
    with LOCK:
        EVENT_KIND_COUNTS[kind] = EVENT_KIND_COUNTS.get(kind, 0) + 1


def send_heartbeat() -> None:
    global ERROR_COUNT, EVENT_KIND_COUNTS, OUTPUT_DROPPED
    if HEARTBEAT_SECS <= 0:
        return
    with LOCK:
        counts = EVENT_KIND_COUNTS
        dropped = OUTPUT_DROPPED
        errors = ERROR_COUNT
        queue_depth = INFLIGHT
        EVENT_KIND_COUNTS = {}
        OUTPUT_DROPPED = 0
        ERROR_COUNT = 0
    status = "degraded" if dropped or errors else "ok"
    payload: dict[str, object] = {
        "collectorId": COLLECTOR_ID or None,
        "nodeName": NODE_NAME or None,
        "mode": "observer-forwarder-python",
        "status": status,
        "intervalSecs": HEARTBEAT_SECS,
        "eventKindCounts": counts,
        "queueDepth": queue_depth,
        "outputDropped": dropped,
        "errorCount": errors,
        **source_fields(),
    }
    if status != "ok":
        payload["message"] = f"{dropped} output drops, {errors} errors since last heartbeat"
    if not post_json(HEARTBEAT_URL, payload, 5):
        record_output_failure()


def heartbeat_loop() -> None:
    send_heartbeat()
    while not STOP.wait(HEARTBEAT_SECS):
        send_heartbeat()


def main() -> None:
    heartbeat_thread = None
    if HEARTBEAT_SECS > 0:
        heartbeat_thread = threading.Thread(target=heartbeat_loop, daemon=True)
        heartbeat_thread.start()
    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                parsed = json.loads(line)  # skip the collector's human log lines / partials
            except ValueError:
                continue
            if is_noise(parsed):
                continue
            bump_event_kind(parsed)
            payload = {"line": line, **source_fields()}
            if COLLECTOR_ID:
                payload["collectorId"] = COLLECTOR_ID
            if NODE_NAME:
                payload["nodeName"] = NODE_NAME
            global INFLIGHT
            with LOCK:
                INFLIGHT += 1
            try:
                if not post_json(URL, payload, 2):
                    record_output_failure()
            finally:
                with LOCK:
                    INFLIGHT = max(0, INFLIGHT - 1)
    finally:
        STOP.set()
        send_heartbeat()
        if heartbeat_thread:
            heartbeat_thread.join(timeout=0.2)


if __name__ == "__main__":
    main()
