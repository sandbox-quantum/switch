"""Reading a room you are a member of without connecting to it (CHOO-2628).

Catching up on another room used to mean travelling to it, which drops the
agent out of the room it is supposed to be attending. `read_context` therefore
takes an optional room: omit it and the connected room is read as before, pass
one and that room is read instead, with nothing about the caller's connection
disturbed.

Membership, not connection, is the authorization boundary — and it is checked
where it always was, inside the protocol service, so an explicit room id buys
reach and not privilege.
"""

from __future__ import annotations

from typing import Any

import pytest

from switch_core.bridges.agent.operations import context as op_context
from switch_core.bridges.agent.operations.callctx import (
    CallContext,
    reset_call_context,
    set_call_context,
)
from switch_core.bridges.agent.operations.definitions import read_context
from switch_core.bridges.agent.protocol.connections import (
    PROTOCOL_VERSION,
    ClientDeclaration,
    ConnectionRegistry,
)

AGENT = "agent-1"
CONN = "conn-1"
CONNECTED_ROOM = "room-here"
OTHER_ROOM = "room-elsewhere"


class _Protocol:
    """Just enough protocol to answer a read: a registry and a recorder."""

    def __init__(self, registry: ConnectionRegistry) -> None:
        self.connections = registry
        self.calls: list[tuple[str, str]] = []
        self.members: set[str] = {CONNECTED_ROOM, OTHER_ROOM}

    async def read_context(
        self, agent_id: str, room_id: str, **kwargs: Any
    ) -> dict[str, Any]:
        if room_id not in self.members:
            raise PermissionError("Agent is not a member of this room")
        self.calls.append((agent_id, room_id))
        return {"threads": [], "truncated": False, "oldest_timestamp": None}


@pytest.fixture
def protocol(monkeypatch: pytest.MonkeyPatch) -> _Protocol:
    registry = ConnectionRegistry()
    service = _Protocol(registry)
    monkeypatch.setattr(op_context, "_protocol", service)
    return service


@pytest.fixture
def connected(protocol: _Protocol) -> None:
    connection = protocol.connections.open(
        agent_id=AGENT,
        connection_id=CONN,
        scope="single",
        delivery_filter="all",
        spawn_capable=False,
        cursor=0,
        declaration=ClientDeclaration(speaks=PROTOCOL_VERSION),
    )
    protocol.connections.claim_room(connection, CONNECTED_ROOM)


@pytest.fixture
def caller():
    token = set_call_context(CallContext(agent_id=AGENT, session_key=CONN))
    yield
    reset_call_context(token)


@pytest.fixture
def unbound_caller():
    """A caller with no connection at all, so no room can be defaulted."""
    token = set_call_context(CallContext(agent_id=AGENT, session_key=None))
    yield
    reset_call_context(token)


@pytest.mark.asyncio
async def test_omitting_the_room_reads_the_one_you_are_connected_to(
    protocol: _Protocol, connected: None, caller: None
) -> None:
    """The default is unchanged: the overwhelmingly common call reads here."""
    await read_context()

    assert protocol.calls == [(AGENT, CONNECTED_ROOM)]


@pytest.mark.asyncio
async def test_a_room_id_reads_that_room_instead(
    protocol: _Protocol, connected: None, caller: None
) -> None:
    await read_context(room_id=OTHER_ROOM)

    assert protocol.calls == [(AGENT, OTHER_ROOM)]


@pytest.mark.asyncio
async def test_reading_elsewhere_leaves_you_where_you_were(
    protocol: _Protocol, connected: None, caller: None
) -> None:
    """The whole point: catching up must not cost the agent its own room."""
    await read_context(room_id=OTHER_ROOM)

    claimant = protocol.connections.claimant_of(AGENT, CONNECTED_ROOM)
    assert claimant is not None
    assert claimant.id == CONN
    assert protocol.connections.claimant_of(AGENT, OTHER_ROOM) is None


@pytest.mark.asyncio
async def test_a_room_you_are_not_a_member_of_is_refused(
    protocol: _Protocol, connected: None, caller: None
) -> None:
    """Naming a room is not the same as being allowed to read it."""
    with pytest.raises(PermissionError):
        await read_context(room_id="room-strangers")

    assert protocol.calls == []


@pytest.mark.asyncio
async def test_an_unconnected_caller_can_still_read_a_room_it_names(
    protocol: _Protocol, unbound_caller: None
) -> None:
    """No connection is needed when the room is explicit — membership decides."""
    await read_context(room_id=OTHER_ROOM)

    assert protocol.calls == [(AGENT, OTHER_ROOM)]


@pytest.mark.asyncio
async def test_an_unconnected_caller_naming_no_room_is_told_to_connect(
    protocol: _Protocol, unbound_caller: None
) -> None:
    """The old error survives, but only for the case it actually describes."""
    with pytest.raises(ValueError, match="connect_to_room"):
        await read_context()


@pytest.mark.asyncio
async def test_the_room_is_advertised_as_an_argument() -> None:
    """Agents learn the tool from its generated schema, so it must appear there."""
    from switch_core.bridges.agent.operations.registry import get_operation

    op = get_operation("read_context")
    assert op is not None
    schema = op.input_schema
    assert "room_id" in schema["properties"]
    assert "room_id" not in schema.get("required", [])
