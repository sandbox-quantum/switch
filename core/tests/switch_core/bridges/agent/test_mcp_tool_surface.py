"""The MCP tool surface agents are told about must be the surface that exists.

The connector skills and `protocol/instructions.py` name specific tools and
tell agents to call them. Nothing tied those names to the server's actual
registrations, so `cancel_task` was documented in both skills and in the
in-room instructions for a long while without ever being exposed as an
`@mcp.tool` — it lived only on the HTTP surface. An agent following the
documentation called a tool that was not there.
"""

import pytest

from switch_core.bridges.agent.mcp.server import mcp

TASK_PROTOCOL_TOOLS = {
    "delegate_task",
    "accept_task",
    "update_task",
    "finalise_task",
    "cancel_task",
    "list_tasks",
}


@pytest.fixture
async def tool_names() -> set[str]:
    return {tool.name for tool in await mcp.list_tools()}


async def test_task_protocol_is_fully_exposed(tool_names: set[str]) -> None:
    """Every stage of the documented task lifecycle is callable over MCP.

    `cancel_task` is the requester's abort path; the other five were exposed
    without it, which left a lifecycle agents were told to drive but could
    only get four-sixths of the way through.
    """
    assert TASK_PROTOCOL_TOOLS <= tool_names


async def test_documented_tools_exist(tool_names: set[str]) -> None:
    """Every tool the connector skills advertise is registered.

    Mirrors the trigger list in `connectors/*/skills/switch/SKILL.md`. A tool
    renamed or dropped here without updating both skills fails this test
    rather than surfacing as an agent calling into nothing.
    """
    documented = TASK_PROTOCOL_TOOLS | {
        "list_rooms",
        "connect_to_room",
        "read_context",
        "post_message",
        "send_targeted_message",
        "list_participants",
        "list_roles",
        "get_role_detail",
        "assume_role",
        "release_role",
        "create_room",
        "invite_agent_to_room",
        "list_all_rooms",
        "get_room_detail",
        "list_bridges",
        "list_reference_types",
        "create_reference",
        "attach_reference_to_room",
        "link_rooms",
        "unlink_rooms",
        "list_room_groups",
        "create_room_group",
        "get_room_group_detail",
        "list_agents",
        "get_agent_detail",
        "update_agent_detail",
    }

    assert documented <= tool_names, (
        f"documented but not registered: {sorted(documented - tool_names)}"
    )
