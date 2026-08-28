#!/usr/bin/env python3

from __future__ import annotations

import asyncio
import os
import time
import uuid
from typing import Any

import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from langchain.agents import create_agent
from langchain_core.tools import tool
from langchain_openai import ChatOpenAI

TOOL_RESULT = "LANGCHAIN_HTTP_TOOL_RESULT_20260829"
SYSTEM_PROMPT = (
    "You are the deterministic AnySentry LangChain TLS fixture. "
    "When the user asks to look up the canary, call lookup_fixture exactly once with key=canary. "
    "After the tool returns, include its complete result in the final answer."
)


class InvokeRequest(BaseModel):
    message: str = Field(min_length=1, max_length=4_096)


class InvokeResponse(BaseModel):
    run_id: str
    answer: str
    tool_calls: list[dict[str, Any]]
    started_at_unix_ns: str
    ended_at_unix_ns: str


@tool
def lookup_fixture(key: str) -> str:
    """Return the deterministic canary used by the AnySentry TLS observability test."""
    if key != "canary":
        raise ValueError("lookup_fixture accepts only key=canary")
    return TOOL_RESULT


def required_environment(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


model = ChatOpenAI(
    model=required_environment("LANGCHAIN_LAB_MODEL"),
    base_url=required_environment("LANGCHAIN_LAB_BASE_URL"),
    api_key=required_environment("LANGCHAIN_LAB_API_KEY"),
    streaming=False,
    temperature=0,
    max_retries=0,
    timeout=90,
)
agent = create_agent(model=model, tools=[lookup_fixture], system_prompt=SYSTEM_PROMPT)
app = FastAPI(title="AnySentry LangChain TLS Fixture", docs_url=None, redoc_url=None)


@app.get("/health")
def health() -> dict[str, object]:
    return {"ok": True, "service": "anysentry-langchain-tls-fixture"}


@app.post("/invoke", response_model=InvokeResponse)
async def invoke(request: InvokeRequest) -> InvokeResponse:
    run_id = f"lc_{uuid.uuid4().hex[:20]}"
    started = time.time_ns()
    try:
        result = await asyncio.to_thread(
            agent.invoke,
            {"messages": [{"role": "user", "content": request.message}]},
        )
    except Exception as error:
        raise HTTPException(status_code=502, detail="LangChain model invocation failed") from error

    messages = result.get("messages", [])
    tool_calls: list[dict[str, Any]] = []
    for message in messages:
        for call in getattr(message, "tool_calls", []) or []:
            tool_calls.append({
                "id": str(call.get("id", "")),
                "name": str(call.get("name", "")),
                "args": call.get("args", {}),
            })
    answer = str(getattr(messages[-1], "content", "")) if messages else ""
    if not tool_calls or TOOL_RESULT not in answer:
        raise HTTPException(status_code=502, detail="LangChain fixture did not complete its tool loop")
    return InvokeResponse(
        run_id=run_id,
        answer=answer,
        tool_calls=tool_calls,
        started_at_unix_ns=str(started),
        ended_at_unix_ns=str(time.time_ns()),
    )


if __name__ == "__main__":
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=int(os.environ.get("LANGCHAIN_LAB_PORT", "18082")),
        access_log=False,
    )
