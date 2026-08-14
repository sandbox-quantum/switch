"""The exposed operation surface — a security boundary, so pinned both ways."""

from __future__ import annotations

import inspect

from switch_core.bridges.agent.operations import all_operations
from switch_core.bridges.agent.server_connectors.agui.tools import (
    ROOM_SCOPED_OPERATIONS,
    is_exposed,
    room_scoped_tools,
)


def _operations_needing_a_connected_room() -> set[str]:
    """Operations that resolve their room from the caller's session binding.

    Derived by inspection, deliberately independent of the hand-written
    allowlist so the two can be compared.
    """
    return {
        name
        for name, operation in all_operations().items()
        if "require_connected_room()" in inspect.getsource(operation.fn)
    }


def test_allowlist_matches_the_room_scoped_operations_exactly() -> None:
    # Both directions matter. A new room-scoped operation that nobody added
    # here is a tool the agent silently lost; an operation that stopped being
    # room-scoped but stayed listed is a tool it should no longer have.
    assert ROOM_SCOPED_OPERATIONS == _operations_needing_a_connected_room()


def test_every_allowlisted_operation_exists_in_the_registry() -> None:
    assert ROOM_SCOPED_OPERATIONS <= all_operations().keys()


def test_connection_lifecycle_is_not_exposed() -> None:
    # connect_to_room claims a room slot on the caller's connection and can
    # evict a live session of the same agent elsewhere.
    assert not is_exposed("connect_to_room")
    assert not is_exposed("list_rooms")


def test_instance_wide_administration_is_not_exposed() -> None:
    for name in (
        "create_room",
        "archive_room",
        "unarchive_room",
        "update_room",
        "update_agent_detail",
        "invite_agent_to_room",
        "add_users_to_room",
        "create_reference",
        "link_rooms",
    ):
        assert not is_exposed(name), f"{name} must not be reachable from AG-UI"


def test_the_room_conversation_surface_is_exposed() -> None:
    for name in (
        "read_context",
        "post_message",
        "send_targeted_message",
        "list_participants",
        "delegate_task",
        "accept_task",
        "finalise_task",
    ):
        assert is_exposed(name), f"{name} should be reachable from AG-UI"


def test_tools_project_name_description_and_schema() -> None:
    registry = all_operations()
    tools = {tool.name: tool for tool in room_scoped_tools()}

    assert set(tools) == set(ROOM_SCOPED_OPERATIONS)
    for name, tool in tools.items():
        assert tool.description == registry[name].description
        assert tool.parameters == registry[name].input_schema


def test_projected_schemas_are_self_contained() -> None:
    # No `$ref`/`$defs`, so nothing has to be resolved by the far side. This is
    # what makes the projection mechanical rather than a translation.
    for tool in room_scoped_tools():
        assert "$ref" not in str(tool.parameters)
        assert "$defs" not in tool.parameters


def test_projected_schemas_are_json_schema_objects() -> None:
    for tool in room_scoped_tools():
        assert tool.parameters["type"] == "object"
        assert "properties" in tool.parameters


def test_no_exposed_operation_takes_a_room_id() -> None:
    # The room comes from the session binding Switch mints, never from the
    # agent — so it cannot aim an operation at a room it was not invited to.
    for tool in room_scoped_tools():
        assert "room_id" not in tool.parameters.get("properties", {})


def test_tool_order_is_stable() -> None:
    assert [tool.name for tool in room_scoped_tools()] == sorted(ROOM_SCOPED_OPERATIONS)


def test_the_subset_is_much_cheaper_than_the_whole_registry() -> None:
    # AG-UI re-sends tools[] on every POST, so this ratio is the reason the
    # subset exists at all. Pinned loosely: the point is the order of
    # magnitude, not a byte count that churns with every docstring edit.
    import json

    registry = all_operations()
    everything = json.dumps(
        [
            {
                "name": op.name,
                "description": op.description,
                "parameters": op.input_schema,
            }
            for op in registry.values()
        ]
    )
    subset = json.dumps([tool.model_dump() for tool in room_scoped_tools()])

    assert len(subset) < len(everything) / 2
