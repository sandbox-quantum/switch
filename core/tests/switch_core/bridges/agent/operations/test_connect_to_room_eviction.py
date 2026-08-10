"""What `connect_to_room` tells its caller about the room it just took.

The operation-level counterpart to `test_connect_claims_room`, which covers the
claim helper alone. What is pinned here is the **payload**, because that is
where the original bug lived: the claim was refused, the refusal was swallowed,
and the tool still answered with a full room and no hint that anything had gone
wrong. A caller cannot act on a fact the response does not carry, so the
response is the contract worth testing.

Two sessions of one agent in one room produce exactly this call: the second
session connects while the first still holds the slot.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from types import SimpleNamespace
from typing import Any

import pytest

from switch_core.bridges.agent.operations import definitions
from switch_core.bridges.agent.operations.callctx import (
    CallContext,
    reset_call_context,
    set_call_context,
)
from switch_core.bridges.agent.operations.context import init_operations_protocol
from switch_core.bridges.agent.protocol.connections import (
    PROTOCOL_VERSION,
    ClientDeclaration,
    ConnectionRegistry,
)

AGENT = "agent-1"
ROOM = "room-1"

_PROFILE = {
    "connection_model": "session_addressable",
    "message_exchange": True,
    "pre_invocation_mediation": [],
    "post_invocation_mediation": [],
    "event_reporting": [],
    "task_protocol": {"can_delegate": False, "can_accept": False},
}


class _RecordingSessionStore:
    """Stands in for AgentSessionStore, remembering the binding it was asked for."""

    def __init__(self) -> None:
        self.bindings: list[tuple[str, str, str]] = []

    async def set_connected_room(
        self,
        session: Any,
        agent_id: str,
        room_id: str,
        transport_session_id: str,
        lifecycle: str,
    ) -> None:
        self.bindings.append((agent_id, room_id, transport_session_id))


def _protocol(registry: ConnectionRegistry, store: _RecordingSessionStore) -> Any:
    room = SimpleNamespace(id=ROOM, name="Room One", description="A room")
    agent = SimpleNamespace(id=AGENT, name="agent-one", integration_profile=_PROFILE)
    room_model = SimpleNamespace(id=ROOM, name="Room One", bridge_id=None)

    @asynccontextmanager
    async def session_factory():
        yield SimpleNamespace(commit=_noop, get=_noop_get)

    async def _noop(*_a: Any, **_kw: Any) -> None:
        return None

    async def _noop_get(*_a: Any, **_kw: Any) -> None:
        return None

    async def require_room_member(*_a: Any, **_kw: Any):
        return room

    async def list_participants(*_a: Any, **_kw: Any) -> list[Any]:
        return []

    async def list_room_resources(*_a: Any, **_kw: Any) -> dict[str, Any]:
        return {
            "reference_types": {},
            "references": [],
            "documents": [],
            "packages": [],
            "linked_rooms": [],
        }

    async def list_room_roles(*_a: Any, **_kw: Any) -> list[Any]:
        return []

    return SimpleNamespace(
        connections=registry,
        agent_session_store=store,
        session_factory=session_factory,
        agent_store=SimpleNamespace(get=_returning(agent)),
        room_store=SimpleNamespace(get=_returning(room_model)),
        require_room_member=require_room_member,
        list_participants=list_participants,
        list_room_resources=list_room_resources,
        list_room_roles=list_room_roles,
    )


def _returning(value: Any):
    async def _get(*_a: Any, **_kw: Any) -> Any:
        return value

    return _get


def _open(registry: ConnectionRegistry, connection_id: str):
    return registry.open(
        agent_id=AGENT,
        connection_id=connection_id,
        scope="single",
        delivery_filter="all",
        spawn_capable=False,
        cursor=0,
        declaration=ClientDeclaration(speaks=PROTOCOL_VERSION),
    )


@pytest.fixture
def harness(monkeypatch: pytest.MonkeyPatch):
    registry = ConnectionRegistry()
    store = _RecordingSessionStore()
    protocol = _protocol(registry, store)
    init_operations_protocol(protocol)
    # The instruction text is a large, separately-tested surface and none of it
    # bears on the room slot.
    monkeypatch.setattr(definitions, "build_room_instructions", lambda *a, **kw: "")
    yield SimpleNamespace(registry=registry, store=store)
    init_operations_protocol(None)  # type: ignore[arg-type]


async def _connect_as(connection_id: str) -> dict[str, Any]:
    token = set_call_context(CallContext(agent_id=AGENT, session_key=connection_id))
    try:
        return await definitions.connect_to_room(
            ROOM, include_general_instructions=False
        )
    finally:
        reset_call_context(token)


@pytest.mark.asyncio
async def test_the_first_session_in_a_room_is_warned_about_nothing(
    harness: Any,
) -> None:
    _open(harness.registry, "session-one")

    result = await _connect_as("session-one")

    assert result["warning"] is None
    assert result["room_id"] == ROOM


@pytest.mark.asyncio
async def test_the_second_session_is_told_it_displaced_the_first(harness: Any) -> None:
    """The response that used to hide this is the one that now carries it.

    Without it the caller has no way to distinguish "I am in the room" from "I
    took the room off something that was working in it".
    """
    _open(harness.registry, "session-one")
    await _connect_as("session-one")
    _open(harness.registry, "session-two")

    result = await _connect_as("session-two")

    assert result["warning"] is not None
    assert "session-one" in result["warning"]
    assert ROOM in result["warning"]


@pytest.mark.asyncio
async def test_the_second_session_actually_gets_the_room(harness: Any) -> None:
    """Warning without delivery would be the old bug wearing a label.

    The point of taking over is that the newcomer receives the room's events;
    the previous holder must no longer be the claimant.
    """
    first = _open(harness.registry, "session-one")
    await _connect_as("session-one")
    _open(harness.registry, "session-two")

    await _connect_as("session-two")

    claimant = harness.registry.claimant_of(AGENT, ROOM)
    assert claimant is not None
    assert claimant.id == "session-two"
    assert ROOM not in first.rooms


@pytest.mark.asyncio
async def test_the_evicted_session_is_woken_so_its_stream_reports_the_loss(
    harness: Any,
) -> None:
    """How the loser — and through it, switchdash's sidebar — finds out.

    The eviction reaches the previous holder as `subscription_changed` on its
    own stream. Its client clears the room from the session, which is what stops
    switchdash showing two sessions under one room.
    """
    first = _open(harness.registry, "session-one")
    await _connect_as("session-one")
    first.wake.clear()
    _open(harness.registry, "session-two")

    await _connect_as("session-two")

    assert first.wake.is_set()


@pytest.mark.asyncio
async def test_reconnecting_as_the_same_session_warns_about_nothing(
    harness: Any,
) -> None:
    """A session re-running its connect has displaced nobody but itself."""
    _open(harness.registry, "session-one")
    await _connect_as("session-one")

    result = await _connect_as("session-one")

    assert result["warning"] is None


@pytest.mark.asyncio
async def test_a_caller_with_no_live_connection_still_connects(harness: Any) -> None:
    """An MCP transport session has no connection to claim on.

    It is bound by the `agent_sessions` row instead, so the call must succeed
    and report no eviction rather than failing for want of a slot.
    """
    result = await _connect_as("mcp-transport-session")

    assert result["warning"] is None
    assert harness.store.bindings == [(AGENT, ROOM, "mcp-transport-session")]
