"""Everyone a deleted room concerned is told it changed, not only the people
who were in it. Real Postgres."""

from __future__ import annotations

import asyncio

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.chats import MEMBER_CLIENT_TYPE
from switch_core.db.models import (
    TENANT_ZERO_ID,
    Client,
    ClientRoom,
    Room,
    User,
    room_agents,
)
from switch_core.db.stores.room_store import RoomStore
from switch_core.room_changes import RoomChanges, people_concerned
from switch_core.user_changes import ROOM
from tests.switch_core.gateway.agent_route_harness import add_agent

WINDOW_S = 0.05


class _Publisher:
    def __init__(self) -> None:
        self.told: list[tuple[str, str, str, str]] = []

    def publish(self, tenant_id: str, user_id: str, kind: str, key: str) -> None:
        self.told.append((tenant_id, user_id, kind, key))


async def _room_with_people(
    session_factory: async_sessionmaker[AsyncSession],
) -> tuple[str, str, dict[str, str]]:
    """A room Alice owns but is not in, with Carol's agent added to it but not
    joined, and Bob in it through his Console. Returns the room, Bob's
    member client, and the three people by name."""
    async with session_factory() as session:
        alice = User(name="alice", email="alice@example.invalid", role="user")
        bob = User(name="bob", email="bob@example.invalid", role="user")
        carol = User(name="carol", email="carol@example.invalid", role="user")
        session.add_all([alice, bob, carol])
        await session.flush()
        room = Room(
            transport_room_id="!doomed:test",
            name="doomed",
            description="",
            owner_id=alice.id,
            read_visibility="private",
            write_visibility="private",
        )
        session.add(room)
        await session.flush()
        member = Client(
            transport_user_id="@bob-member:test",
            display_name="bob",
            type=MEMBER_CLIENT_TYPE,
            user_id=bob.id,
        )
        session.add(member)
        await session.flush()
        session.add(ClientRoom(client_id=member.id, room_id=room.id))
        agent = await add_agent(session, name="carols-agent", owner_id=carol.id)
        await session.execute(
            room_agents.insert().values(room_id=room.id, agent_id=agent.id)
        )
        await session.commit()
        people = {"alice": alice.id, "bob": bob.id, "carol": carol.id}
        return room.id, member.id, people


async def _delete(
    session_factory: async_sessionmaker[AsyncSession], room_id: str
) -> None:
    async with session_factory() as session:
        await RoomStore().delete(session, room_id)
        await session.commit()


def _told(publisher: _Publisher, room_id: str) -> list[str]:
    return sorted(
        user_id
        for _tenant, user_id, kind, key in publisher.told
        if kind == ROOM and key == room_id
    )


async def test_a_deleted_room_tells_its_owner_and_its_agents_owners(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    room_id, member_id, people = await _room_with_people(session_factory)
    publisher = _Publisher()
    changes = RoomChanges(
        session_factory=session_factory, publisher=publisher, window_seconds=WINDOW_S
    )

    # What `delete_room` does: read who the room concerns, remove the members
    # (which names them, as `kick_user` does), delete, then hand the people over.
    async with session_factory() as session:
        concerned = (await people_concerned(session, {room_id: [member_id]}))[room_id]
    changes.room_changed(TENANT_ZERO_ID, room_id, [member_id])
    await _delete(session_factory, room_id)
    changes.room_deleted(TENANT_ZERO_ID, room_id, concerned)
    await asyncio.sleep(WINDOW_S * 4)

    # Each told once, in the one window the removal opened.
    assert _told(publisher, room_id) == sorted(people.values())


async def test_without_the_people_read_first_only_the_members_are_told(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """The gap `room_deleted` closes: read after the delete, the room no longer
    says who owns it or which agents it had."""
    room_id, member_id, people = await _room_with_people(session_factory)
    publisher = _Publisher()
    changes = RoomChanges(
        session_factory=session_factory, publisher=publisher, window_seconds=WINDOW_S
    )

    changes.room_changed(TENANT_ZERO_ID, room_id, [member_id])
    await _delete(session_factory, room_id)
    await asyncio.sleep(WINDOW_S * 4)

    assert _told(publisher, room_id) == [people["bob"]]


async def test_a_deletion_after_the_window_closed_still_tells_everyone(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Retiring a platform channel can take longer than the window, so the
    deletion may come after the members' window has been read. What that
    window told people is no use to them: their Console read the room again
    and found it still there. The deletion has to be told again."""
    room_id, member_id, people = await _room_with_people(session_factory)
    publisher = _Publisher()
    changes = RoomChanges(
        session_factory=session_factory, publisher=publisher, window_seconds=WINDOW_S
    )

    async with session_factory() as session:
        concerned = (await people_concerned(session, {room_id: [member_id]}))[room_id]
    changes.room_changed(TENANT_ZERO_ID, room_id, [member_id])
    await asyncio.sleep(WINDOW_S * 4)
    publisher.told.clear()
    await _delete(session_factory, room_id)
    changes.room_deleted(TENANT_ZERO_ID, room_id, concerned)
    await asyncio.sleep(WINDOW_S * 4)

    assert _told(publisher, room_id) == sorted(people.values())
