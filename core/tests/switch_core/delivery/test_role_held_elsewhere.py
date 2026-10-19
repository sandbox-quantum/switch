"""A role held over a connection another process holds is found by any process.

A message tagged `@reviewer` is for the agent that live-holds the role. A
holder that stopped renewing the lease itself is live for as long as the
connection it took the seat over is, and that connection may be held by
another process, whose copy here can be missing or late. So the router asks
the recorded connections (`agent_connections`) as well as this process's
memory: the seat is held while its connection's row is open and the process
named on it holds its lease.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import (
    CONNECTION_INCARNATION_FLOOR,
    AgentConnectionRecord,
    RoleLease,
    RoomRole,
    SwitchCoreProcess,
)
from switch_core.db.session_scope import tenant_session
from tests.routing import (
    add_member,
    make_agent,
    make_person,
    make_room,
    own_events,
    process_on,
)


@pytest.mark.parametrize(
    ("holder_beat", "handed"),
    [
        # The process holding the connection is live: the seat is held.
        (timedelta(seconds=0), 1),
        # It stopped beating long ago: the connection, and the seat, are gone.
        (timedelta(minutes=10), 0),
    ],
)
async def test_a_role_held_over_another_process_s_connection(
    holder_beat: timedelta,
    handed: int,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    # This process holds no copy of the holder's connection.
    process = process_on(session_factory)
    room = await make_room(session_factory)
    alice = await make_person(session_factory, "alice")
    agent, client = await make_agent(session_factory, "worker")
    await add_member(session_factory, room, alice)
    await add_member(session_factory, room, client, agent=agent)

    other = str(uuid.uuid4())
    now = datetime.now(UTC)
    async with tenant_session(session_factory, room.tenant_id) as session:
        session.add(
            SwitchCoreProcess(id=other, started_at=now, beat_at=now - holder_beat)
        )
        await session.flush()
        session.add(
            AgentConnectionRecord(
                id="conn-elsewhere",
                agent_id=agent.id,
                process_id=other,
                incarnation=CONNECTION_INCARNATION_FLOOR + 1,
                scope="all",
                delivery_filter="addressed",
                spawn_capable=False,
                transport="sse",
            )
        )
        role = RoomRole(room_id=room.id, name="reviewer", instructions="Review.")
        session.add(role)
        await session.flush()
        session.add(
            RoleLease(
                role_id=role.id,
                room_id=room.id,
                agent_id=agent.id,
                transport_session_id="conn-elsewhere",
                # The holder renews nothing itself; only its connection
                # keeps the seat.
                last_seen_at=now - timedelta(minutes=5),
            )
        )
        await session.commit()

    await process.say(room, "@reviewer please look at this", sender=alice)
    await process.idle()

    assert len(await own_events(session_factory, agent.id)) == handed
