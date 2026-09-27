#!/usr/bin/env python3

from __future__ import annotations

import json
import os
from pathlib import Path

results = Path(os.environ.get("LANGCHAIN_LAB_RESULTS", "/results"))
workspace = Path(os.environ.get("LANGCHAIN_LAB_WORKSPACE", "/workspace"))


def read_lines(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


agent = read_lines(results / "langchain-events.ndjson")
provider = read_lines(results / "fake-llm.ndjson")
requests = [item for item in provider if item.get("event") == "request_received"]
completed = [item for item in agent if item.get("event") == "agent_completed"]
tools = [item for item in agent if item.get("event") == "tool_completed"]

assert len(requests) == 3, len(requests)
assert [item.get("stage") for item in requests] == ["read", "bash", "final"]
assert all(item.get("transport") == "https" for item in requests)
assert all("PI_INTERNAL_RAG_MUST_NOT_LEAK_20260827" not in item.get("rawBody", "") for item in requests)
assert [item.get("name") for item in tools] == ["read", "bash"]
assert tools[0].get("content") == "PI_CANARY_RESULT_SENTINEL_20260827\n"
assert tools[1].get("content") == "PI_BASH_RESULT_SENTINEL_20260827\n"
assert completed and completed[-1].get("internalRagSentinelAbsent") is True
assert (workspace / "tool-events.log").read_text(encoding="utf-8") == "PI_BASH_RESULT_SENTINEL_20260827\n"

print(json.dumps({
    "event": "langchain_tls_lab_verification",
    "passed": True,
    "requests": len(requests),
    "toolOrder": [item.get("name") for item in tools],
    "internalRagSentinelAbsent": True,
}, separators=(",", ":")))
