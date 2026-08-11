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


# Tools the agent runtime serves itself, so absent from the bridge's surface.
# The skills index them alongside the bridge tools because an agent calls them
# the same way, but they are registered by
# `console/packages/switch-agent-runtime/`, not here — checking them against
# this server's registrations would fail on tools that are working correctly.
RUNTIME_TOOLS = {"send_attachment", "download_attachment"}

# Served only when startup could not produce an identity, in place of the normal
# surface, and documented in their own sections rather than the index.
DEGRADED_TOOLS = {"select_agent", "switch_unavailable"}


def _indexed_tools(skill: Path) -> list[str]:
    """The tool names listed in a skill's `## Tool index` section.

    One tool per bullet, opening with the backticked name. Read from the body
    rather than the frontmatter: the `description:` is always-resident context
    on both hosts (and Codex truncates it to fit a budget), so it carries a
    trigger rather than an inventory.

    Every bullet in the section must parse. A tool silently dropping out
    because someone bolded it, indented it, or folded two onto one line is the
    failure this whole file exists to prevent, so an unparseable bullet is an
    error rather than a skipped line.
    """
    body = skill.read_text()
    section = re.search(r"^## Tool index$(.*?)(?=^## |\Z)", body, re.MULTILINE | re.S)
    assert section is not None, f"no '## Tool index' section in {skill}"
    bullets = re.findall(r"^[ \t]*[-*].*$", section.group(1), re.MULTILINE)
    assert bullets, f"no tool bullets under '## Tool index' in {skill}"
    names = []
    for bullet in bullets:
        match = re.fullmatch(r"- `([a-z_]+)` — .*", bullet)
        assert match is not None, (
            f"{skill}: tool-index bullet is not `- \\`name\\` — description`, so "
            f"the tool it names would not be checked: {bullet!r}"
        )
        names.append(match.group(1))
    return names


async def test_every_registered_tool_is_indexed(tool_names: set[str]) -> None:
    """The index names every tool the bridge serves — no silent omissions.

    The frontmatter list this replaced was one mechanical line; a prose bullet
    list is easy to shorten by accident. Without this, deleting a bullet passes
    every other check in the file: the drift test still sees two identical
    indexes, and the registration test only ever objects to *extra* names.
    """
    for skill in SKILLS:
        indexed = set(_indexed_tools(skill))
        missing = tool_names - indexed - DEGRADED_TOOLS
        assert not missing, (
            f"{skill} does not index registered tools: {sorted(missing)}"
        )


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
