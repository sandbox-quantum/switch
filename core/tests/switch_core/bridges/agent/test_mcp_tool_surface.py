"""The MCP tool surface agents are told about must be the surface that exists.

Every session's MCP tools are the operations Switch serves at
`/agents/{id}/ops`, relayed by the session's own runtime. The Switch skill
Console pushes into every session and `protocol/instructions.py` name specific
tools and tell agents to call them, and neither is checked against the
operation registry at build time. These tests pin the tool names so a rename, a
removal, or a name that only ever existed in the documentation fails here
rather than surfacing as an agent calling into nothing.
"""

import re
from collections.abc import Iterator
from pathlib import Path

import pytest

from switch_core.bridges.agent.api.operations import list_operations
from switch_core.bridges.agent.operations import all_operations
from switch_core.bridges.agent.operations.agent_management import (
    AGENT_MANAGEMENT_OPERATIONS,
)
from switch_core.bridges.agent.operations.registry import (
    disable_operation_group,
    enable_operation_group,
)

# Tools that exist only on a server running agent management. The skill
# documents them for those servers (and says they are absent elsewhere), so the
# surface is read here with their group enabled.
AGENT_MANAGEMENT_TOOLS = {
    "list_machines",
    "get_advanced_config",
    "create_agent",
    "list_managed_agents",
}


@pytest.fixture
def tool_names() -> Iterator[set[str]]:
    enable_operation_group(AGENT_MANAGEMENT_OPERATIONS)
    try:
        yield set(list_operations())
    finally:
        disable_operation_group(AGENT_MANAGEMENT_OPERATIONS)


def test_agent_management_tools_exist_only_with_their_group_enabled() -> None:
    names = set(list_operations())
    assert not AGENT_MANAGEMENT_TOOLS & names
    enable_operation_group(AGENT_MANAGEMENT_OPERATIONS)
    try:
        names = set(list_operations())
    finally:
        disable_operation_group(AGENT_MANAGEMENT_OPERATIONS)
    assert AGENT_MANAGEMENT_TOOLS <= names


def test_documented_tools_exist(tool_names: set[str]) -> None:
    """Every tool the Switch skill advertises is registered.

    Mirrors the tool names used in `console/packages/plugins/src/switch-skill/SKILL.md`,
    including those named only in the body. Maintained by hand: add a name here
    when the skill starts advertising one.
    """
    documented = {
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
        "list_all_references",
        "link_rooms",
        "unlink_rooms",
        "list_room_groups",
        "create_room_group",
        "get_room_group_detail",
        "create_room_from_yaml",
        "get_template_guide",
        "list_templates",
        "get_template",
        "run_template",
        "save_template",
        "update_template",
        "delete_template",
        "list_agents",
        "get_agent_detail",
        "update_agent_detail",
        *AGENT_MANAGEMENT_TOOLS,
    }

    assert documented <= tool_names, (
        f"documented but not registered: {sorted(documented - tool_names)}"
    )


def test_tool_descriptions_preserve_the_full_operation_contract() -> None:
    listed = list_operations()
    operation = all_operations()["list_agents"]

    assert listed[operation.name]["description"] == operation.description
    assert "Returns:" in listed[operation.name]["description"]


SKILL = (
    Path(__file__).parents[5]
    / "console"
    / "packages"
    / "plugins"
    / "src"
    / "switch-skill"
    / "SKILL.md"
)


# Tools the agent runtime serves itself, so absent from the operation registry.
# The skill indexes them alongside the operations because an agent calls them
# the same way, but they are implemented by
# `console/packages/switch-agent-runtime/`, not here — checking them against
# this server's operations would fail on tools that are working correctly.
RUNTIME_TOOLS = {"send_attachment", "download_attachment"}


def _indexed_tools(skill: Path) -> list[str]:
    """The tool names listed in the skill's `## Tool index` section.

    One tool per bullet, opening with the backticked name. Read from the body
    rather than the frontmatter: the `description:` is always-resident context
    on the hosts that load it as a skill (and Codex truncates it to fit a
    budget), so it carries a trigger rather than an inventory.

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
        match = re.fullmatch(r"- `([a-z_]+)`(?: —|:) .*", bullet)
        assert match is not None, (
            f"{skill}: tool-index bullet is not `- \\`name\\`: description`, so "
            f"the tool it names would not be checked: {bullet!r}"
        )
        names.append(match.group(1))
    return names


def test_every_registered_tool_is_indexed(tool_names: set[str]) -> None:
    """The index names every operation the bridge serves — no silent omissions.

    The frontmatter list this replaced was one mechanical line; a prose bullet
    list is easy to shorten by accident. Without this, deleting a bullet passes
    every other check in the file: the registration test only ever objects to
    *extra* names.
    """
    indexed = set(_indexed_tools(SKILL))
    missing = tool_names - indexed
    assert not missing, f"{SKILL} does not index registered tools: {sorted(missing)}"


def test_skill_indexed_tools_are_registered(tool_names: set[str]) -> None:
    """Every tool the skill's index advertises actually exists.

    Derived from the files rather than restated here, so this half cannot go
    stale the way the hand-maintained set above can. It does not replace that
    set: that one pins names this test would accept being dropped entirely.
    """
    advertised = set(_indexed_tools(SKILL)) - RUNTIME_TOOLS
    assert advertised <= tool_names, (
        f"{SKILL} advertises unregistered tools: {sorted(advertised - tool_names)}"
    )
