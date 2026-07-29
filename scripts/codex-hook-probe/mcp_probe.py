"""A stand-in for the Switch MCP server, faithful in the one way that matters.

`connect_to_room` is declared exactly as the real tool is — an async FastMCP
tool returning `dict[str, Any]` — so FastMCP serialises the result the same way
here as in `switch_core.bridges.agent.mcp.server`. What Codex then puts in the
PostToolUse hook's `tool_response` is the open question this probe answers.
"""

from typing import Any

from fastmcp import FastMCP

mcp: FastMCP = FastMCP("switch")


@mcp.tool
async def connect_to_room(room_id: str) -> dict[str, Any]:
    """Connect this session to a room.

    Args:
        room_id: The Switch room id to connect to.
    """
    return {
        "room_id": room_id,
        "agent_id": "probe-agent-1",
        "name": "Probe Room",
        "participants": [],
    }


if __name__ == "__main__":
    mcp.run()
