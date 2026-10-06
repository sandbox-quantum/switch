"""A stand-in for a Switch MCP server, faithful in the one way that matters.

`connect_to_room` is declared as an async FastMCP tool returning
`dict[str, Any]`, the shape the Switch tool returns. Running the probe shows
what Codex puts in the PostToolUse hook's `tool_response` for that call.
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
