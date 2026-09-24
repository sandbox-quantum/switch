"""Explicit recovery moves delivery only after checking the owner's confirmation."""

import pytest

from switch_core.bridges.agent.protocol.connections import ConnectionRegistry
from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.sessions.errors import SessionError

from .test_authority import setup
from .test_shared_connection import (
    AGENT,
    FIRST,
    OTHER_ROOM,
    ROOM,
    SECOND,
    _controller,
    _second_room,
    _second_session,
)


@pytest.mark.asyncio
async def test_reconnect_displaced_conversation_preserves_history_and_checks_owner(
    session_factory,
):
    service, first = await setup(session_factory)
    second = await _second_session(service)
    connections = ConnectionRegistry()
    connection = _controller(connections, [ROOM])
    buffer = EventBuffer()
    await service.bind_connection(AGENT, *FIRST, first, connection.id, connections)
    await service.bind_room(AGENT, *FIRST, first, ROOM)
    await service.bind_connection(AGENT, *SECOND, second, connection.id, connections)
    await service.bind_room(AGENT, *SECOND, second, ROOM)
    before = await service.snapshot(FIRST[0], "owner")
    assert await service.room_associations("owner") == {FIRST[0]: ROOM, SECOND[0]: ROOM}
    assert await service.room_associations("outsider") == {}
    assert await service.live_room_connections("outsider", connections) == {}
    assert await service.live_room_connections("owner", connections) == {
        AGENT: [connection.id]
    }
    with pytest.raises(SessionError, match="ownership changed"):
        await service.reconnect_room(
            FIRST[0], "owner", first, ROOM, None, connections, buffer
        )
    assert (await service.snapshot(SECOND[0], "owner")).session.room_ids == [ROOM]
    result = await service.reconnect_room(
        FIRST[0], "owner", first, ROOM, SECOND[0], connections, buffer
    )
    assert result.session.room_ids == [ROOM]
    assert result.session.epoch == before.session.epoch
    assert (await service.snapshot(SECOND[0], "owner")).session.room_ids == []
    assert connections.claimant_of(AGENT, ROOM) == connection
    # A repeated click is a no-op, with no new session event or command.
    repeated = await service.reconnect_room(
        FIRST[0], "owner", first, ROOM, SECOND[0], connections, buffer
    )
    assert repeated == result


@pytest.mark.asyncio
async def test_reconnect_releases_departed_room_and_rejects_stale_epoch(
    session_factory,
):
    service, epoch = await setup(session_factory)
    await _second_room(session_factory)
    connections = ConnectionRegistry()
    connection = _controller(connections, [ROOM])
    await service.bind_connection(AGENT, *FIRST, epoch, connection.id, connections)
    await service.bind_room(AGENT, *FIRST, epoch, ROOM)
    with pytest.raises(SessionError, match="restarted"):
        await service.reconnect_room(
            FIRST[0], "owner", "stale", OTHER_ROOM, None, connections, EventBuffer()
        )
    await service.reconnect_room(
        FIRST[0], "owner", epoch, OTHER_ROOM, None, connections, EventBuffer()
    )
    assert connections.claimant_of(AGENT, ROOM) is None
    assert connections.claimant_of(AGENT, OTHER_ROOM) == connection
    assert await service.room_associations("owner") == {FIRST[0]: OTHER_ROOM}


@pytest.mark.asyncio
async def test_reconnect_requires_owner_and_live_connection(session_factory):
    service, epoch = await setup(session_factory)
    connections = ConnectionRegistry()
    with pytest.raises(SessionError):
        await service.reconnect_room(
            FIRST[0], "outsider", epoch, ROOM, None, connections, EventBuffer()
        )
    with pytest.raises(SessionError, match="connection first"):
        await service.reconnect_room(
            FIRST[0], "owner", epoch, ROOM, None, connections, EventBuffer()
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("fault", ["retired", "not-member", "legacy-claim"])
async def test_reconnect_cannot_bypass_room_safety(session_factory, fault):
    service, epoch = await setup(session_factory)
    connections = ConnectionRegistry()
    connection = _controller(connections, [])
    await service.bind_connection(AGENT, *FIRST, epoch, connection.id, connections)
    room = ROOM
    if fault == "retired":
        await service.quiesce(AGENT, *FIRST, epoch)
        epoch = (await service.retire(FIRST[0], "owner", epoch)).session.epoch
    elif fault == "not-member":
        room = "not-a-member"
    else:
        from switch_core.bridges.agent.protocol.connections import ClientDeclaration

        other = connections.open(
            agent_id=AGENT,
            connection_id="legacy-visitor",
            scope="all",
            delivery_filter="all",
            spawn_capable=False,
            cursor=0,
            declaration=ClientDeclaration(),
            expected_generation=None,
        )
        connections.claim_room(other, ROOM)
    with pytest.raises(SessionError):
        await service.reconnect_room(
            FIRST[0], "owner", epoch, room, None, connections, EventBuffer()
        )
    assert (await service.snapshot(FIRST[0], "owner")).session.room_ids == []
