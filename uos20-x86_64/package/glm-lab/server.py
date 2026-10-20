"""持久化 LangChain Agent 服务:skills + MCP 工具 + 会话记忆。

启动方式:python server.py
接口:
  POST /chat  {"session_id": "可选,默认 default", "message": "你的问题"}
  GET  /       服务说明
  GET  /sessions  当前活跃的会话列表
"""
import os

from fastapi import FastAPI
from langchain.agents import create_agent
from langchain_core.tools import tool
from langchain_mcp_adapters.tools import load_mcp_tools
from langchain_openai import ChatOpenAI
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from pydantic import BaseModel
from contextlib import asynccontextmanager
import uvicorn

BASE_URL = os.environ.get("GLM_BASE_URL", "http://35.220.164.252:3888/v1").rstrip("/")
API_KEY = os.environ.get("GLM_API_KEY", "").strip()
MODEL = os.environ.get("GLM_MODEL", "glm-5.3").strip() or "glm-5.3"


@tool
def get_weather(city: str) -> str:
    """查询指定城市的天气(演示 skill)。"""
    data = {"北京": "晴,26°C", "上海": "多云,29°C", "深圳": "雷阵雨,31°C"}
    return f"{city}:{data.get(city, '多云,27°C')}"


@tool
def calculator(expression: str) -> str:
    """计算一个数学表达式,例如 128*46。"""
    allowed = set("0123456789+-*/(). ")
    if not set(expression) <= allowed:
        return "表达式包含非法字符"
    return str(eval(expression))


@asynccontextmanager
async def lifespan(app: FastAPI):
    if not API_KEY:
        raise RuntimeError("GLM_API_KEY is empty")
    llm = ChatOpenAI(model=MODEL, api_key=API_KEY, base_url=BASE_URL, temperature=0)
    server_params = StdioServerParameters(command="python", args=["mcp_server.py"])
    async with stdio_client(server_params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            mcp_tools = await load_mcp_tools(session)
            app.state.agent = create_agent(
                model=llm,
                tools=[get_weather, calculator, *mcp_tools],
                system_prompt="你是一个助手,需要时调用工具完成任务,用中文回答。",
            )
            app.state.agent_tools = ["get_weather", "calculator"] + [t.name for t in mcp_tools]
            app.state.sessions = {}
            print(f"[ready] tools loaded: {app.state.agent_tools}", flush=True)
            yield
    print("[shutdown] mcp server stopped", flush=True)


app = FastAPI(title="LangChain GLM Agent", lifespan=lifespan)


class ChatRequest(BaseModel):
    session_id: str = "default"
    message: str


@app.get("/")
async def root():
    return {
        "service": "langchain-glm-agent",
        "model": MODEL,
        "tools": getattr(app.state, "agent_tools", []),
        "usage": 'curl -s -X POST localhost:8000/chat -H "Content-Type: application/json" '
                 '-d \'{"session_id": "u1", "message": "现在几点?"}\'',
    }


@app.get("/sessions")
async def sessions():
    return {"sessions": {sid: len(msgs) for sid, msgs in app.state.sessions.items()}}


@app.post("/chat")
async def chat(req: ChatRequest):
    history = app.state.sessions.setdefault(req.session_id, [])
    history.append({"role": "user", "content": req.message})
    result = await app.state.agent.ainvoke({"messages": history})
    app.state.sessions[req.session_id] = result["messages"]

    last_user_idx = max(
        i for i, m in enumerate(result["messages"]) if getattr(m, "type", "") == "human"
    )
    tool_calls = [
        {"tool": tc["name"], "args": tc["args"]}
        for m in result["messages"][last_user_idx + 1:]
        if getattr(m, "type", "") == "ai"
        for tc in (getattr(m, "tool_calls", None) or [])
    ]
    return {
        "session_id": req.session_id,
        "reply": result["messages"][-1].content,
        "tool_calls": tool_calls,
        "history_length": len(result["messages"]),
    }


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
