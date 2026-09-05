"""Naming the room on an operation, for a connection that holds several.

`require_connected_room` has always answered "which room is this call about?"
from the caller's binding alone, which works precisely while a caller has one
room. A connection covering several surfaces has no single answer, and today it
gets an error that tells it to "pass the room explicitly" — an affordance no
operation actually offers. Delivery to such a connection works and every action
fails.

So the room becomes an optional argument on the operations that plausibly act
across rooms, and resolution moves into one place:

- omitted with one room, the room (every existing caller, unchanged);
- omitted with several, an error rather than a guess — picking one silently is
  how a private answer ends up in a public channel;
- supplied, checked against what the caller actually holds, because a room id
  arriving from a model is an argument and not a permission.

Only `post_message`, `read_context` and `send_targeted_message` are widened.
The rest keep raising on ambiguity; the error already says what happened, and
widening them costs tool-surface churn on three connector skills for calls
nobody is making across rooms yet.
"""

from __future__ import annotations

from contextlib import contextmanager
from types import SimpleNamespace
from typing import Any

import pytest

from switch_core.bridges.agent.operations import definitions as ops
from switch_core.bridges.agent.operations.callctx import (
    CallContext,
    reset_call_context,
    set_call_context,
)
from switch_core.bridges.agent.operations.context import (
    init_operations_protocol,
    require_connected_room,
)
from switch_core.bridges.agent.operations.registry import all_operations
from switch_core.bridges.agent.protocol.connections import (
    PROTOCOL_VERSION,
    ClientDeclaration,
    ConnectionRegistry,
)

AGENT = "agent-1"
CONN = "conn-1"
ROOM_A = "room-a"
ROOM_B = "room-b"
ROOM_ELSEWHERE = "room-elsewhere"

WIDENED = ("post_message", "read_context", "send_targeted_message")


# ── Fakes ────────────────────────────────────────────────────────────────────


class _NoSession:
    """A session factory that yields nothing — no database in these tests."""

    def __call__(self) -> _NoSession:
        return self

    async def __aenter__(self) -> None:
        return None

    async def __aexit__(self, *_exc: Any) -> bool:
        return False


class _BindingRows:
    """The legacy `agent_sessions` binding, for callers with no connection."""

    def __init__(self, bound_room: str | None) -> None:
        self._bound_room = bound_room

    async def get_connected_room(self, _db: Any, _key: str) -> tuple[str, str] | None:
        if self._bound_room is None:
            return None
        return ("session-row", self._bound_room)


class _Protocol(SimpleNamespace):
    """Records what the operations asked the protocol to do."""

    def __init__(self, registry: ConnectionRegistry, bound_room: str | None = None):
        super().__init__(
            connections=registry,
            session_factory=_NoSession(),
            agent_session_store=_BindingRows(bound_room),
        )
        self.sent: list[tuple[str, str]] = []
        self.targeted: list[tuple[str, str]] = []
        self.read: list[str] = []

    async def send_message(
        self, _agent_id: str, room_id: str, body: str, **_kw: Any
    ) -> str:
        self.sent.append((room_id, body))
        return "$event"

    async def send_targeted_message(
        self, _agent_id: str, room_id: str, _names: list[str], body: str, **_kw: Any
    ) -> Any:
        self.targeted.append((room_id, body))
        return SimpleNamespace(event_id="$event", target_statuses={})

    async def read_context(self, _agent_id: str, room_id: str, **_kw: Any) -> dict:
        self.read.append(room_id)
        return {"threads": [], "truncated": False, "oldest_timestamp": None}


def _registry_holding(*rooms: str, scope: str = "multi") -> ConnectionRegistry:
    registry = ConnectionRegistry()
    conn = registry.open(
        agent_id=AGENT,
        connection_id=CONN,
        scope=scope,  # type: ignore[arg-type]
        delivery_filter="all",
        spawn_capable=False,
        cursor=0,
        declaration=ClientDeclaration(speaks=PROTOCOL_VERSION),
    )
    for room in rooms:
        registry.claim_room(conn, room)
    return registry


@contextmanager
def _calling(protocol: Any, session_key: str | None = CONN):
    init_operations_protocol(protocol)
    token = set_call_context(CallContext(agent_id=AGENT, session_key=session_key))
    try:
        yield protocol
    finally:
        reset_call_context(token)


# ── Resolution: the room is omitted ──────────────────────────────────────────


async def test_one_room_and_no_argument_resolves_to_that_room() -> None:
    """Every caller that exists today. This must not change."""
    with _calling(_Protocol(_registry_holding(ROOM_A))):
        assert await require_connected_room() == ROOM_A


async def test_several_rooms_and_no_argument_is_an_error_not_a_guess() -> None:
    """Picking one silently is how a private answer reaches a public channel."""
    with _calling(_Protocol(_registry_holding(ROOM_A, ROOM_B))):
        with pytest.raises(ValueError) as excinfo:
            await require_connected_room()

    # Named specifically: "room" alone also matches the not-connected error, so
    # deleting the connection branch outright would leave this test green.
    message = str(excinfo.value)
    assert "several rooms" in message
    assert ROOM_A in message and ROOM_B in message


async def test_no_binding_at_all_still_says_to_connect_first() -> None:
    with _calling(_Protocol(ConnectionRegistry()), session_key=None):
        with pytest.raises(ValueError) as excinfo:
            await require_connected_room()

    assert "connect_to_room" in str(excinfo.value)


# ── Resolution: the room is supplied ─────────────────────────────────────────


async def test_a_supplied_room_the_caller_holds_is_used() -> None:
    with _calling(_Protocol(_registry_holding(ROOM_A, ROOM_B))):
        assert await require_connected_room(ROOM_B) == ROOM_B


async def test_a_supplied_room_the_caller_does_not_hold_is_refused() -> None:
    """A room id from a model is an argument, not a permission.

    Without the check, an agent could post into any room it can name — including
    one another of its own connections is claiming, which the slot invariant
    exists to prevent.
    """
    with _calling(_Protocol(_registry_holding(ROOM_A, ROOM_B))):
        with pytest.raises(ValueError) as excinfo:
            await require_connected_room(ROOM_ELSEWHERE)

    assert ROOM_ELSEWHERE in str(excinfo.value)


async def test_a_single_room_caller_may_name_the_room_it_holds() -> None:
    """Passing the room explicitly is allowed everywhere, not just under `multi`."""
    with _calling(_Protocol(_registry_holding(ROOM_A, scope="single"))):
        assert await require_connected_room(ROOM_A) == ROOM_A


async def test_a_single_room_caller_cannot_name_a_different_room() -> None:
    with _calling(_Protocol(_registry_holding(ROOM_A, scope="single"))):
        with pytest.raises(ValueError):
            await require_connected_room(ROOM_B)


# ── Resolution: the legacy binding row (MCP transport sessions) ──────────────


async def test_a_connectionless_caller_still_resolves_from_its_binding_row() -> None:
    protocol = _Protocol(ConnectionRegistry(), bound_room=ROOM_A)
    with _calling(protocol, session_key="mcp-transport-session"):
        assert await require_connected_room() == ROOM_A


async def test_a_connectionless_caller_may_name_the_room_it_is_bound_to() -> None:
    protocol = _Protocol(ConnectionRegistry(), bound_room=ROOM_A)
    with _calling(protocol, session_key="mcp-transport-session"):
        assert await require_connected_room(ROOM_A) == ROOM_A


async def test_a_connectionless_caller_cannot_name_another_room() -> None:
    """The row binds one room; naming a different one is not a way around it."""
    protocol = _Protocol(ConnectionRegistry(), bound_room=ROOM_A)
    with _calling(protocol, session_key="mcp-transport-session"):
        with pytest.raises(ValueError):
            await require_connected_room(ROOM_B)


async def test_a_connectionless_caller_with_no_row_says_to_connect_first() -> None:
    protocol = _Protocol(ConnectionRegistry(), bound_room=None)
    with _calling(protocol, session_key="mcp-transport-session"):
        with pytest.raises(ValueError) as excinfo:
            await require_connected_room()

    assert "connect_to_room" in str(excinfo.value)


# ── The widened operations actually route by it ──────────────────────────────


async def test_post_message_posts_to_the_named_room() -> None:
    protocol = _Protocol(_registry_holding(ROOM_A, ROOM_B))
    with _calling(protocol):
        await ops.post_message("hello", room_id=ROOM_B)

    assert protocol.sent == [(ROOM_B, "hello")]


async def test_post_message_without_a_room_refuses_when_several_are_held() -> None:
    """No fallback to "the first one" — the failure has to be visible."""
    protocol = _Protocol(_registry_holding(ROOM_A, ROOM_B))
    with _calling(protocol):
        with pytest.raises(ValueError):
            await ops.post_message("hello")

    assert protocol.sent == []


async def test_read_context_reads_the_named_room() -> None:
    protocol = _Protocol(_registry_holding(ROOM_A, ROOM_B))
    with _calling(protocol):
        await ops.read_context(room_id=ROOM_B)

    assert protocol.read == [ROOM_B]


async def test_send_targeted_message_sends_to_the_named_room() -> None:
    protocol = _Protocol(_registry_holding(ROOM_A, ROOM_B))
    with _calling(protocol):
        await ops.send_targeted_message(
            "over here", target_names=["someone"], room_id=ROOM_B
        )

    assert protocol.targeted == [(ROOM_B, "over here")]


async def test_an_unwidened_operation_still_refuses_rather_than_guessing() -> None:
    """The bounded widening must not leave a silent picker behind.

    `list_participants` has no room argument. Called from a connection holding
    several rooms it must fail, not answer about whichever room came first.
    """
    protocol = _Protocol(_registry_holding(ROOM_A, ROOM_B))
    with _calling(protocol):
        with pytest.raises(ValueError):
            await ops.list_participants()


# ── Both front doors see it ──────────────────────────────────────────────────


@pytest.mark.parametrize("name", WIDENED)
def test_the_room_argument_is_published_on_the_tool_surface(name: str) -> None:
    """The MCP server and the HTTP endpoint are both built from this schema.

    If `room_id` is not in it, the parameter exists in Python and no agent can
    reach it.
    """
    schema = all_operations()[name].input_schema

    assert "room_id" in schema["properties"]


@pytest.mark.parametrize("name", WIDENED)
def test_the_room_argument_is_optional(name: str) -> None:
    """Existing single-room callers must keep working untouched.

    Asserts presence as well as optionality: "not in required" is satisfied by
    a parameter that does not exist, so on its own it would pass today and go
    on passing if the argument were later dropped.
    """
    schema = all_operations()[name].input_schema

    assert "room_id" in schema["properties"]
    assert "room_id" not in schema.get("required", [])
