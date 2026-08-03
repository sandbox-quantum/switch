"""HTTP operations front door (CHOO-1857 / CHOO-490).

The property under test is parity: every operation is reachable through both
doors under the same name, because both are built from one registry. If someone
adds an operation and these fail, that is the point.
"""

from __future__ import annotations

import pytest

from switch_core.bridges.agent.api.operations import (
    BadArgumentsError,
    UnknownOperationError,
    call_operation,
    list_operations,
)
from switch_core.bridges.agent.mcp import server as mcp_server
from switch_core.bridges.agent.operations import context as op_context
from switch_core.bridges.agent.operations import get_operation
from switch_core.bridges.agent.operations.callctx import (
    CallContext,
    current_call_context,
    reset_call_context,
    set_call_context,
)

AGENT = "agent-1"


async def _tool_names() -> set[str]:
    return {tool.name for tool in await mcp_server.mcp._list_tools()}


async def test_every_operation_is_registered_as_an_mcp_tool() -> None:
    # The MCP door registers whatever the registry holds, so this is the
    # parity guarantee: neither door can be missing an operation the other has.
    assert set(list_operations()) == await _tool_names()


async def test_operation_names_are_the_tool_names_verbatim() -> None:
    # One vocabulary: a translating runtime is POST /ops/${toolName}, nothing
    # more. Renaming or namespacing here would reintroduce a mapping table.
    ops = list_operations()
    for expected in ("connect_to_room", "post_message", "assume_role", "list_tasks"):
        assert expected in ops


def test_operations_advertise_a_json_schema_for_their_arguments() -> None:
    """Clients build their tool surface from this, so it must be real schema."""
    op = list_operations()["connect_to_room"]
    schema = op["input_schema"]

    assert schema["type"] == "object"
    assert schema["properties"]["room_id"]["type"] == "string"
    assert schema["required"] == ["room_id"]
    assert schema["properties"]["include_general_instructions"]["default"] is True
    # Transport details are not arguments an agent supplies.
    assert "ctx" not in schema["properties"]
    # The full docstring is the tool description an agent reads.
    assert "Connect this session to a room" in op["description"]


async def test_unknown_operation_names_what_is_available() -> None:
    with pytest.raises(UnknownOperationError) as excinfo:
        await call_operation(
            operation="teleport",
            arguments={},
            agent_id=AGENT,
            connection_id=None,
        )
    assert "connect_to_room" in str(excinfo.value)


async def test_unexpected_arguments_are_refused() -> None:
    with pytest.raises(BadArgumentsError) as excinfo:
        await call_operation(
            operation="connect_to_room",
            arguments={"room_id": "r", "colour": "blue"},
            agent_id=AGENT,
            connection_id=None,
        )
    assert "colour" in str(excinfo.value)


async def test_missing_required_arguments_are_refused() -> None:
    with pytest.raises(BadArgumentsError) as excinfo:
        await call_operation(
            operation="connect_to_room",
            arguments={},
            agent_id=AGENT,
            connection_id=None,
        )
    assert "room_id" in str(excinfo.value)


# ── Call context ────────────────────────────────────────────────────────────


async def test_the_call_context_carries_agent_and_connection() -> None:
    """The operation sees who called and which connection it belongs to."""
    seen: dict[str, object] = {}

    async def fake_op(room_id: str) -> str:
        seen["agent_id"] = op_context.get_agent_id()
        seen["session_key"] = op_context.session_key()
        return "ok"

    from switch_core.bridges.agent.operations import registry

    registry._REGISTRY["fake_op"] = registry.Operation(
        name="fake_op",
        fn=fake_op,
        description="fake",
        input_schema=registry._input_schema(fake_op),
    )
    try:
        result = await call_operation(
            operation="fake_op",
            arguments={"room_id": "room-1"},
            agent_id=AGENT,
            connection_id="conn-9",
        )
    finally:
        registry._REGISTRY.pop("fake_op", None)

    assert result == "ok"
    assert seen["agent_id"] == AGENT
    # The connection is the caller's session key: this is what lets an
    # operation resolve the room binding without an MCP transport session.
    assert seen["session_key"] == "conn-9"


def test_the_call_context_is_cleared_after_the_call() -> None:
    assert current_call_context() is None
    token = set_call_context(CallContext(agent_id=AGENT, session_key="c1"))
    assert current_call_context() is not None
    reset_call_context(token)
    assert current_call_context() is None


def test_agent_id_prefers_the_bound_context_over_the_request_scope() -> None:
    token = set_call_context(CallContext(agent_id="bound-agent", session_key=None))
    try:
        # No HTTP request in scope at all: resolving would fail if the bound
        # context were not consulted first.
        assert op_context.get_agent_id() == "bound-agent"
    finally:
        reset_call_context(token)


def test_session_key_prefers_the_bound_context() -> None:
    token = set_call_context(CallContext(agent_id=AGENT, session_key="conn-7"))
    try:
        assert op_context.session_key() == "conn-7"
    finally:
        reset_call_context(token)


def test_session_key_is_none_when_bound_to_nothing() -> None:
    # Neither an HTTP call context nor an MCP session: operations that need a
    # room report "not connected" rather than guessing one.
    assert op_context.session_key() is None


def test_the_registry_refuses_duplicate_operation_names() -> None:
    from switch_core.bridges.agent.operations import registry

    existing = get_operation("post_message")
    assert existing is not None
    with pytest.raises(RuntimeError):
        registry.operation(existing.fn)
