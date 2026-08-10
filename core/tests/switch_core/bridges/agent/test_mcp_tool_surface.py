"""The MCP tool surface agents are told about must be the surface that exists.

The connector skills and `protocol/instructions.py` name specific tools and
tell agents to call them, and neither is checked against the server's actual
registrations at build time. These tests pin the tool names so a rename, a
removal, or a name that only ever existed in the documentation fails here
rather than surfacing as an agent calling into nothing.
"""

import re
from pathlib import Path

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

    `cancel_task` is the requester's abort path: without it the lifecycle the
    skills describe has no exit for the agent that opened it.
    """
    assert TASK_PROTOCOL_TOOLS <= tool_names


async def test_documented_tools_exist(tool_names: set[str]) -> None:
    """Every tool the connector skills advertise is registered.

    Mirrors the tool names used across `connectors/*/skills/switch/SKILL.md`,
    including those named only in the body. Maintained by hand: add a name here
    when a skill starts advertising one.
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
        "define_role",
        "edit_role",
        "delete_role",
        "list_linked_rooms",
        "update_room",
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


SKILLS = sorted(
    (Path(__file__).parents[5] / "connectors").glob("*/skills/switch/SKILL.md")
)


RUNTIME_TOOLS = {"send_attachment", "download_attachment"}
"""Tools the agent runtime serves itself, so absent from the bridge's surface.

The skills index them alongside the bridge tools because an agent calls them
the same way, but they are registered by
`dash/packages/switch-agent-runtime/`, not here — checking them against this
server's registrations would fail on tools that are working correctly.
"""


def _indexed_tools(skill: Path) -> list[str]:
    """The tool names listed in a skill's `## Tool index` section.

    One tool per bullet, opening with the backticked name. Read from the body
    rather than the frontmatter: the `description:` is always-resident context
    on both hosts (and Codex truncates it to fit a budget), so it carries a
    trigger rather than an inventory.
    """
    body = skill.read_text()
    section = re.search(r"^## Tool index$(.*?)(?=^## |\Z)", body, re.MULTILINE | re.S)
    assert section is not None, f"no '## Tool index' section in {skill}"
    names = re.findall(r"^- `([a-z_]+)`", section.group(1), re.MULTILINE)
    assert names, f"no tool bullets under '## Tool index' in {skill}"
    return names


def test_both_skills_index_the_same_tools() -> None:
    """The two connectors' tool indexes must not drift apart.

    They are host-specific documents but the tool surface behind them is one
    surface, and a tool added to one skill's index is silently absent from the
    other's.
    """
    assert len(SKILLS) == 2, f"expected two connector skills, found {SKILLS}"
    first, second = (_indexed_tools(skill) for skill in SKILLS)
    assert first == second


async def test_skill_indexed_tools_are_registered(tool_names: set[str]) -> None:
    """Every tool a skill's index advertises actually exists.

    Derived from the files rather than restated here, so this half cannot go
    stale the way the hand-maintained set above can. It does not replace that
    set: that one pins names this test would accept being dropped entirely.
    """
    for skill in SKILLS:
        advertised = set(_indexed_tools(skill)) - RUNTIME_TOOLS
        assert advertised <= tool_names, (
            f"{skill} advertises unregistered tools: {sorted(advertised - tool_names)}"
        )
