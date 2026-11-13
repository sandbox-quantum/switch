"""HTTP operations front door (CHOO-1857 / CHOO-490).

The property under test is parity: every operation is reachable through both
doors under the same name, because both are built from one registry. If someone
adds an operation and these fail, that is the point.
"""

from __future__ import annotations

import contextvars
from collections.abc import Coroutine, Generator
from typing import Any

import pytest

from switch_core.bridges.agent.api.operations import (
    BadArgumentsError,
    UnknownOperationError,
    call_operation,
    list_operations,
)
from switch_core.bridges.agent.mcp import server as mcp_server
from switch_core.bridges.agent.operations import context as op_context
from switch_core.bridges.agent.operations import get_operation, registry
from switch_core.bridges.agent.operations.agent_management import (
    AGENT_MANAGEMENT_OPERATIONS,
)
from switch_core.bridges.agent.operations.callctx import (
    CallContext,
    current_call_context,
    reset_call_context,
    set_call_context,
)
from switch_core.bridges.agent.protocol.types import SendTargetedResult, SentMessage
from switch_core.logging_context import current_log_context

AGENT = "agent-1"


async def _tool_names() -> set[str]:
    """The tools an MCP client is offered, the server's middleware included."""
    return {tool.name for tool in await mcp_server.mcp.list_tools()}


async def test_every_operation_is_registered_as_an_mcp_tool() -> None:
    # The MCP door registers whatever the registry holds, so this is the
    # parity guarantee: neither door can be missing an operation the other has.
    assert set(list_operations()) == await _tool_names()


async def test_parity_holds_with_an_operation_group_enabled() -> None:
    registry.enable_operation_group(AGENT_MANAGEMENT_OPERATIONS)
    try:
        assert {"list_machines", "create_agent"} <= set(list_operations())
        assert set(list_operations()) == await _tool_names()
    finally:
        registry.disable_operation_group(AGENT_MANAGEMENT_OPERATIONS)
    assert set(list_operations()) == await _tool_names()


async def test_operation_names_are_the_tool_names_verbatim() -> None:
    # One vocabulary: a translating runtime is POST /ops/${toolName}, nothing
    # more. Renaming or namespacing here would reintroduce a mapping table.
    ops = list_operations()
    for expected in ("connect_to_room", "post_message", "assume_role", "list_rooms"):
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
    # An argument the operation does not take is refused, and the schema says so.
    assert schema["additionalProperties"] is False
    # The full docstring is the tool description an agent reads.
    assert "Connect this session to a room" in op["description"]


def test_every_operation_refuses_arguments_it_does_not_take_in_its_schema() -> None:
    open_schemas = [
        name
        for name, op in list_operations().items()
        if op["input_schema"].get("additionalProperties") is not False
    ]
    assert open_schemas == []


async def test_unknown_operation_names_what_is_available() -> None:
    with pytest.raises(UnknownOperationError) as excinfo:
        await call_operation(
            operation="teleport",
            arguments={},
            agent_id=AGENT,
            connection_id=None,
            session=None,
        )
    assert "connect_to_room" in str(excinfo.value)


async def test_unexpected_arguments_are_refused() -> None:
    with pytest.raises(BadArgumentsError) as excinfo:
        await call_operation(
            operation="connect_to_room",
            arguments={"room_id": "r", "colour": "blue"},
            agent_id=AGENT,
            connection_id=None,
            session=None,
        )
    assert "colour" in str(excinfo.value)


async def test_missing_required_arguments_are_refused() -> None:
    with pytest.raises(BadArgumentsError) as excinfo:
        await call_operation(
            operation="connect_to_room",
            arguments={},
            agent_id=AGENT,
            connection_id=None,
            session=None,
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
            session=None,
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
    token = set_call_context(
        CallContext(agent_id=AGENT, session_key="c1", session=None)
    )
    assert current_call_context() is not None
    reset_call_context(token)
    assert current_call_context() is None


def test_agent_id_prefers_the_bound_context_over_the_request_scope() -> None:
    token = set_call_context(
        CallContext(agent_id="bound-agent", session_key=None, session=None)
    )
    try:
        # No HTTP request in scope at all: resolving would fail if the bound
        # context were not consulted first.
        assert op_context.get_agent_id() == "bound-agent"
    finally:
        reset_call_context(token)


def test_session_key_prefers_the_bound_context() -> None:
    token = set_call_context(
        CallContext(agent_id=AGENT, session_key="conn-7", session=None)
    )
    try:
        assert op_context.session_key() == "conn-7"
    finally:
        reset_call_context(token)


def test_session_key_is_none_when_bound_to_nothing() -> None:
    # Neither an HTTP call context nor an MCP session: operations that need a
    # room report "not connected" rather than guessing one.
    assert op_context.session_key() is None


class _Suspend:
    """An await that suspends once, so a coroutine can be left mid-scope with
    no event loop in sight."""

    def __await__(self) -> Generator[None, None, None]:
        yield


def _drive_then_finalise_elsewhere(coro: Coroutine[Any, Any, None]) -> None:
    """Enter the scope inside its own context, then close from this one —
    what the garbage collector does to a coroutine dropped while suspended."""
    contextvars.copy_context().run(coro.send, None)
    coro.close()


async def test_the_call_context_survives_a_dropped_operation_call() -> None:
    """A caller that suspends inside an operation and is then dropped — the
    coroutine finalised by the garbage collector rather than resumed — must
    not raise trying to restore a token from the wrong context.
    """

    async def hanging_op(room_id: str) -> str:
        await _Suspend()
        return "unreached"

    from switch_core.bridges.agent.operations import registry

    registry._REGISTRY["hanging_op"] = registry.Operation(
        name="hanging_op",
        fn=hanging_op,
        description="hanging",
        input_schema=registry._input_schema(hanging_op),
    )
    try:

        async def body() -> None:
            await call_operation(
                operation="hanging_op",
                arguments={"room_id": "room-1"},
                agent_id=AGENT,
                connection_id="conn-9",
                session=None,
            )

        assert current_call_context() is None
        _drive_then_finalise_elsewhere(body())
        assert current_call_context() is None, (
            "finalising a dropped operation call leaked its call context "
            "into the collector's context"
        )
        assert current_log_context().agent_id is None, (
            "finalising a dropped operation call leaked its log context "
            "into the collector's context"
        )
    finally:
        registry._REGISTRY.pop("hanging_op", None)


def test_the_registry_refuses_duplicate_operation_names() -> None:
    from switch_core.bridges.agent.operations import registry

    existing = get_operation("post_message")
    assert existing is not None
    with pytest.raises(RuntimeError):
        registry.operation(existing.fn)


# ── The host's key on a room post ─────────────────────────────────────


@pytest.mark.parametrize(
    "value",
    [
        "restart:turn-1",  # the restart line's key is Core's, never a host's
        "reply:",
        "reply:" + "x" * 195,
        "turn-1",
        "reply:has space",  # plain characters only
        "reply:a/b",
        "reply:\u00e9",
        "reply:a\nb",
        "reply:abc\n",  # `$` would allow a final newline; fullmatch does not
    ],
)
def test_a_post_key_that_is_not_a_reply_key_is_refused(value: str) -> None:
    from fastapi import HTTPException

    from switch_core.bridges.agent.api.operations import checked_reply_key

    with pytest.raises(HTTPException) as excinfo:
        checked_reply_key(value)
    assert excinfo.value.status_code == 400


def test_a_reply_key_is_taken_as_it_is_and_none_stays_none() -> None:
    from switch_core.bridges.agent.api.operations import checked_reply_key

    assert checked_reply_key(None) is None
    key = "reply:" + "x" * 194
    assert len(key) == 200
    assert checked_reply_key(key) == key
    host_keys = (
        "reply:7f1c0000-0000-4000-8000-000000000001",
        "reply:7f1c0000-0000-4000-8000-000000000001:lost",
        "reply:a_b-c:d",
    )
    for host_key in host_keys:
        assert checked_reply_key(host_key) == host_key


@pytest.mark.parametrize("operation", ["post_message", "send_targeted_message"])
async def test_a_post_is_sent_under_the_hosts_key(
    operation: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    from switch_core.bridges.agent.operations import definitions

    sent: list[dict[str, object]] = []

    class _Protocol:
        async def send_message(self, *args: object, **kwargs: object) -> Any:
            sent.append(kwargs)
            return SentMessage(event_id="$event", trust=None)

        async def send_targeted_message(self, *args: object, **kwargs: object) -> Any:
            sent.append(kwargs)
            return SendTargetedResult(event_id="$event", target_statuses={}, trust=None)

    async def _room() -> str:
        return "room-1"

    monkeypatch.setattr(definitions, "require_connected_room", _room)
    monkeypatch.setattr(definitions, "get_protocol", lambda: _Protocol())
    arguments: dict[str, Any] = {"body": "the reply"}
    if operation == "send_targeted_message":
        arguments["target_names"] = ["louisa"]

    await call_operation(
        operation=operation,
        arguments=arguments,
        agent_id=AGENT,
        connection_id="conn-9",
        session=None,
        client_txn_id="reply:7f1c",
    )
    await call_operation(
        operation=operation,
        arguments=arguments,
        agent_id=AGENT,
        connection_id="conn-9",
        session=None,
    )

    assert [call["client_txn_id"] for call in sent] == ["reply:7f1c", None]


async def test_an_agent_cannot_name_the_key_in_its_own_arguments() -> None:
    # Only the host sets it, as a header; the agent's tool input is the body.
    with pytest.raises(BadArgumentsError) as excinfo:
        await call_operation(
            operation="post_message",
            arguments={"body": "hi", "client_txn_id": "reply:someone-elses"},
            agent_id=AGENT,
            connection_id="conn-9",
            session=None,
        )
    assert "client_txn_id" in str(excinfo.value)


@pytest.mark.parametrize(("v2", "status"), [(True, 503), (False, 400)])
async def test_a_post_while_the_agents_client_is_not_running_yet_is_a_503(
    monkeypatch: pytest.MonkeyPatch, v2: bool, status: int
) -> None:
    """Just after Core starts, before the agent's client is up: the host sends
    the post again rather than taking it as refused. With hosted agents
    v2 off, upstream's 400, as for any ValueError."""
    from fastapi import HTTPException

    from switch_core import hosted_v2
    from switch_core.bridges.agent.api import operations as api_operations

    monkeypatch.setattr(hosted_v2, "_process_on", v2)
    from switch_core.bridges.agent.protocol.agent_core import AgentClientNotRunning

    async def not_yet(**_kwargs: object) -> object:
        raise AgentClientNotRunning("Agent client not running")

    async def caller(**_kwargs: object) -> tuple[str, None]:
        return "conn-9", None

    monkeypatch.setattr(api_operations, "call_operation", not_yet)
    monkeypatch.setattr(api_operations, "resolve_caller", caller)
    request = type("Request", (), {"scope": {}})()
    with pytest.raises(HTTPException) as excinfo:
        await api_operations.post_operation(
            request=request,  # type: ignore[arg-type]
            agent_id=AGENT,
            operation="post_message",
            agent=type("Agent", (), {"id": AGENT})(),  # type: ignore[arg-type]
            protocol=None,  # type: ignore[arg-type]
            factory=None,  # type: ignore[arg-type]
            body={"body": "hi"},
            connection_id="conn-9",
        )
    assert excinfo.value.status_code == status
