#!/usr/bin/env python3

from __future__ import annotations

import json
import os
import subprocess
import time
from pathlib import Path
from typing import Any

from langchain_core.messages import HumanMessage, ToolMessage
from langchain_core.tools import tool
from langchain_openai import ChatOpenAI

FINAL_PROMPT = "PI_FINAL_PROMPT_SENTINEL_20260827"
CANARY_RESULT = "PI_CANARY_RESULT_SENTINEL_20260827"
BASH_RESULT = "PI_BASH_RESULT_SENTINEL_20260827"
INTERNAL_RAG = "PI_INTERNAL_RAG_MUST_NOT_LEAK_20260827"
EXPECTED_COMMAND = "printf '%s\\n' 'PI_BASH_RESULT_SENTINEL_20260827' | tee -a tool-events.log"

workspace = Path(os.environ.get("LANGCHAIN_LAB_WORKSPACE", "/workspace")).resolve()
results = Path(os.environ.get("LANGCHAIN_LAB_RESULTS", "/results")).resolve()
events_path = results / "langchain-events.ndjson"
workspace.mkdir(parents=True, exist_ok=True)
results.mkdir(parents=True, exist_ok=True)
(workspace / "canary.txt").write_text(f"{CANARY_RESULT}\n", encoding="utf-8")


def timestamp() -> dict[str, str]:
    return {
        "atUnixNs": str(time.time_ns()),
        "atMonotonicNs": str(time.monotonic_ns()),
    }


def record(event: str, **fields: Any) -> None:
    with events_path.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps({
            "schemaVersion": "anysentry.langchain_tls_fixture.v1",
            **timestamp(),
            "event": event,
            **fields,
        }, ensure_ascii=False, separators=(",", ":")) + "\n")


@tool
def read(path: str) -> str:
    """Read one fixture file from the isolated workspace."""
    started = time.time_ns()
    record("tool_started", toolCallId=current_tool_call_id, name="read", arguments={"path": path})
    if path != "canary.txt":
        raise ValueError("fixture permits only canary.txt")
    content = (workspace / path).read_text(encoding="utf-8")
    record("tool_completed", toolCallId=current_tool_call_id, name="read", content=content,
           startedAtUnixNs=str(started), endedAtUnixNs=str(time.time_ns()), isError=False)
    return content


@tool
def bash(command: str) -> str:
    """Run the one deterministic fixture command in the isolated workspace."""
    started = time.time_ns()
    record("tool_started", toolCallId=current_tool_call_id, name="bash", arguments={"command": command})
    if command != EXPECTED_COMMAND:
        raise ValueError("fixture rejected an unexpected command")
    completed = subprocess.run(
        ["/bin/bash", "-lc", command],
        cwd=workspace,
        check=True,
        capture_output=True,
        text=True,
        timeout=10,
    )
    content = completed.stdout
    record("tool_completed", toolCallId=current_tool_call_id, name="bash", content=content,
           startedAtUnixNs=str(started), endedAtUnixNs=str(time.time_ns()), isError=False)
    return content


record("attach_grace_started", pid=os.getpid(), executable="/usr/local/bin/python",
       graceSeconds=int(os.environ.get("LANGCHAIN_LAB_ATTACH_GRACE_SECONDS", "10")))
time.sleep(max(0, int(os.environ.get("LANGCHAIN_LAB_ATTACH_GRACE_SECONDS", "10"))))

model = ChatOpenAI(
    model=os.environ.get("LANGCHAIN_LAB_MODEL", "fixture-tool-model"),
    base_url=os.environ.get("LANGCHAIN_LAB_BASE_URL", "https://fake-llm:18443/v1"),
    api_key=os.environ.get("LANGCHAIN_LAB_API_KEY", "fixture-key-not-secret"),
    streaming=True,
    temperature=0,
)
model_with_tools = model.bind_tools([read, bash])
messages = [HumanMessage(content=(
    "Run the deterministic AnySentry LangChain transport fixture. "
    f"Final prompt marker: {FINAL_PROMPT}. Execute model-requested tools in order."
))]
current_tool_call_id = ""
tool_order: list[str] = []

for turn in range(1, 5):
    record("model_call_started", turn=turn)
    response = model_with_tools.invoke(messages)
    messages.append(response)
    record("model_call_completed", turn=turn, responseId=response.id,
           text=str(response.content), toolCalls=response.tool_calls)
    if not response.tool_calls:
        final_text = str(response.content)
        break
    for call in response.tool_calls:
        current_tool_call_id = str(call["id"])
        name = str(call["name"])
        tool_order.append(name)
        selected = {"read": read, "bash": bash}.get(name)
        if selected is None:
            raise RuntimeError(f"unexpected tool: {name}")
        output = selected.invoke(call["args"])
        messages.append(ToolMessage(content=output, tool_call_id=current_tool_call_id, name=name))
else:
    raise RuntimeError("fixture exceeded model turn limit")

if tool_order != ["read", "bash"]:
    raise RuntimeError(f"unexpected tool order: {tool_order}")
if FINAL_PROMPT not in final_text or CANARY_RESULT not in final_text or BASH_RESULT not in final_text:
    raise RuntimeError("final response omitted fixture markers")
if INTERNAL_RAG in json.dumps([message.model_dump() for message in messages]):
    raise RuntimeError("internal RAG sentinel entered the LangChain model messages")

record("agent_completed", toolOrder=tool_order, finalText=final_text,
       internalRagSentinelAbsent=True)
print(json.dumps({"event": "langchain_tls_fixture_passed", "pid": os.getpid(),
                  "toolOrder": tool_order, "finalText": final_text}, ensure_ascii=False))
