"""演示用 MCP server:通过 stdio 暴露两个工具。"""
from datetime import datetime

from mcp.server.fastmcp import FastMCP

mcp = FastMCP("demo-mcp")


@mcp.tool()
def get_datetime() -> str:
    """获取容器当前的日期和时间。"""
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


@mcp.tool()
def reverse_text(text: str) -> str:
    """将一段文本反转后返回。"""
    return text[::-1]


if __name__ == "__main__":
    mcp.run()
