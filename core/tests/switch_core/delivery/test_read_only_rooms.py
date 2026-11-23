"""A frozen or archived room takes no new posts, whoever writes them and by
whatever path: the router refuses the row as it writes it
(`room_read_only.py`). Membership changes, Switch's own admin notices and run
telemetry still go in."""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.clients.admin_messages import ADMIN_MARKER, PLATFORM_MARKER
from switch_core.db.models import TENANT_ZERO_ID, Client, Message, Room
from switch_core.db.session_scope import tenant_session
from switch_core.room_read_only import RoomReadOnly
from tests.routing import (
    Process,
    add_member,
    make_agent,
    make_person,
    make_room,
    process_on,
)


async def _system_client(session_factory: async_sessionmaker[AsyncSession]) -> Client:
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        client = Client(
            transport_user_id=f"@switch-admin-{uuid.uuid4().hex[:6]}:test",
            display_name="Switch",
            type="admin",
        )
        session.add(client)
        await session.commit()
        await session.refresh(client)
    return client


async def _set(
    session_factory: async_sessionmaker[AsyncSession], room: Room, **values: object
) -> None:
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        await session.execute(update(Room).where(Room.id == room.id).values(**values))
        await session.commit()


async def _rows(
    session_factory: async_sessionmaker[AsyncSession], room: Room
) -> list[Message]:
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        return list(
            await session.scalars(
                select(Message).where(Message.room_id == room.id).order_by(Message.seq)
            )
        )


@pytest.fixture
async def scene(session_factory: async_sessionmaker[AsyncSession]):  # type: ignore[no-untyped-def]
    process = process_on(session_factory)
    room = await make_room(session_factory, "incident")
    alice = await make_person(session_factory, "alice")
    agent, agent_client = await make_agent(session_factory, "fixer")
    system = await _system_client(session_factory)
    await add_member(session_factory, room, alice)
    await add_member(session_factory, room, agent_client, agent=agent)
    await add_member(session_factory, room, system)
    return process, room, alice, agent_client, system


STATES = {
    "frozen": {"frozen_at": func.now()},
    "archived": {"archived_at": func.now()},
}


@pytest.mark.parametrize("state", list(STATES))
async def test_every_kind_of_post_is_refused(
    session_factory: async_sessionmaker[AsyncSession], scene, state: str
) -> None:  # type: ignore[no-untyped-def]
    process, room, alice, agent_client, system = scene
    await _set(session_factory, room, **STATES[state])
    process.transports.clear()

    posts = [
        process.say(room, "agent text", sender=agent_client),
        process.say(
            room,
            "a card",
            sender=agent_client,
            extra_content={"com.switch.ui": {"blocks": []}},
        ),
        process.send_file(room, "leak.png", sender=agent_client),
        process.say(room, "@fixer person text", sender=alice),
        process.send_file(room, "upload.png", sender=alice, caption="see"),
        process.command(room, "help", "", sender=alice),
        # A kickoff or a schedule's run: addressed to agents.
        process.say(
            room,
            "@fixer scheduled",
            sender=system,
            extra_content={PLATFORM_MARKER: {}},
        ),
        # An admin notice is Switch's only from its system client.
        process.say(
            room,
            "pretend notice",
            sender=agent_client,
            extra_content={ADMIN_MARKER: {"type": None}},
        ),
    ]
    for post in posts:
        with pytest.raises(RoomReadOnly) as refused:
            await post
        assert refused.value.state == state
        assert room.name in str(refused.value)

    assert await _rows(session_factory, room) == []


@pytest.mark.parametrize("state", list(STATES))
async def test_departures_notices_and_telemetry_still_go_in(
    session_factory: async_sessionmaker[AsyncSession], scene, state: str
) -> None:  # type: ignore[no-untyped-def]
    process: Process
    process, room, alice, agent_client, system = scene
    await _set(session_factory, room, **STATES[state])

    await process.say(
        room,
        "This room is frozen.",
        sender=system,
        extra_content={ADMIN_MARKER: {"type": "room_settings_notice"}},
    )
    await process.transport(agent_client).send_event(
        room.transport_room_id,
        "com.switch.report.tool_call",
        {
            "agent_id": "x",
            "tool_id": "grep",
            "args": {},
            "result": "",
            "duration_ms": 1,
        },
    )
    await process.provisioning.kick_user(
        room.transport_room_id, alice.transport_user_id, removed_by="security"
    )

    rows = await _rows(session_factory, room)
    assert [row.event_type for row in rows] == [
        "m.room.message",
        "com.switch.report.tool_call",
        "m.room.member",
    ]
    assert rows[0].sender_client_id == system.id
    assert rows[2].content["membership"] == "leave"


async def test_an_unfrozen_room_takes_posts_again(
    session_factory: async_sessionmaker[AsyncSession], scene
) -> None:  # type: ignore[no-untyped-def]
    process, room, alice, agent_client, _ = scene
    await _set(session_factory, room, frozen_at=func.now())
    with pytest.raises(RoomReadOnly):
        await process.say(room, "while frozen", sender=agent_client)

    await _set(session_factory, room, frozen_at=None)
    await process.say(room, "after", sender=agent_client)
    await process.say(room, "@fixer me too", sender=alice)
    await process.idle()

    # And the agent's offline reply after them: the room is live again.
    assert [row.body for row in await _rows(session_factory, room)][:2] == [
        "after",
        "@fixer me too",
    ]
