"""LangChain 原生工作流:skills + MCP 工具 + 工具调用 Agent。"""
import asyncio
import os
import sys

from langchain.agents import create_agent
from langchain_core.tools import tool
from langchain_mcp_adapters.tools import load_mcp_tools
from langchain_openai import ChatOpenAI
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

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


async def main() -> None:
    if not API_KEY:
        raise SystemExit("GLM_API_KEY is empty")
    llm = ChatOpenAI(model=MODEL, api_key=API_KEY, base_url=BASE_URL, temperature=0)
    server_params = StdioServerParameters(command="python", args=["mcp_server.py"])
    async with stdio_client(server_params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            mcp_tools = await load_mcp_tools(session)
            tools = [get_weather, calculator, *mcp_tools]
            agent = create_agent(
                model=llm,
                tools=tools,
                system_prompt="你是一个助手,需要时调用工具完成任务,用中文回答。",
            )
            queries = sys.argv[1:] or [
                "现在几点?帮我算一下 128*46,再查一下北京天气,最后把 'LangChain' 反转",
                "刚才那个乘法结果再加 1000 是多少?",
            ]
            history = []
            for query in queries:
                print(f"\n[user] {query}\n")
                result = await agent.ainvoke({"messages": [*history, {"role": "user", "content": query}]})
                print(f"\n[final] {result['messages'][-1].content}")
                history = result["messages"]


if __name__ == "__main__":
    asyncio.run(main())
