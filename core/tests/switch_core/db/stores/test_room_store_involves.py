"""Rooms a person takes part in are readable to them: through their Switch
Console member client, a platform account they claimed, or an agent they own
— and no other private room. Real Postgres."""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.chats import MEMBER_CLIENT_TYPE
from switch_core.db.models import (
    Client,
    ClientRoom,
    CollaborationBridge,
    ExternalUser,
    ExternalUserClaim,
    Room,
    User,
    room_agents,
)
from switch_core.db.stores.room_store import RoomStore
from switch_core.room_changes import people_concerned
from tests.switch_core.gateway.agent_route_harness import add_agent


async def _room(session: AsyncSession, name: str, owner_id: str | None) -> Room:
    room = Room(
        transport_room_id=f"!{name}:test",
        name=name,
        description="",
        owner_id=owner_id,
        read_visibility="private",
        write_visibility="private",
    )
    session.add(room)
    await session.flush()
    return room


async def _client(
    session: AsyncSession, name: str, kind: str, user_id: str | None
) -> Client:
    client = Client(
        transport_user_id=f"@{name}:test", display_name=name, type=kind, user_id=user_id
    )
    session.add(client)
    await session.flush()
    return client


async def test_a_person_reads_the_rooms_they_take_part_in_and_no_other(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    store = RoomStore()
    async with session_factory() as session:
        alice = User(name="alice", email="alice@example.invalid", role="user")
        bob = User(name="bob", email="bob@example.invalid", role="user")
        session.add_all([alice, bob])
        await session.flush()

        owned = await _room(session, "owned", alice.id)
        console = await _room(session, "console", bob.id)
        discord = await _room(session, "discord", None)
        with_agent = await _room(session, "with-agent", bob.id)
        unrelated = await _room(session, "unrelated", bob.id)

        member = await _client(session, "alice-member", MEMBER_CLIENT_TYPE, alice.id)
        session.add(ClientRoom(client_id=member.id, room_id=console.id))

        bridge_client = await _client(session, "bridge", "bridge", None)
        bridge = CollaborationBridge(
            type="discord",
            display_name="Discord",
            client_id=bridge_client.id,
            status="active",
        )
        session.add(bridge)
        await session.flush()
        platform = await _client(session, "alice-discord", "user", None)
        account = ExternalUser(
            bridge_id=bridge.id,
            external_user_id="d-1",
            external_username="alice#1",
            client_id=platform.id,
        )
        session.add(account)
        await session.flush()
        session.add(ExternalUserClaim(external_user_id=account.id, user_id=alice.id))
        session.add(ClientRoom(client_id=platform.id, room_id=discord.id))

        agent = await add_agent(session, name="alices-agent", owner_id=alice.id)
        await session.execute(
            room_agents.insert().values(room_id=with_agent.id, agent_id=agent.id)
        )
        # Bob's own member client in the unrelated room does not reach Alice.
        bob_member = await _client(session, "bob-member", MEMBER_CLIENT_TYPE, bob.id)
        session.add(ClientRoom(client_id=bob_member.id, room_id=unrelated.id))
        await session.commit()

        readable = await store.list_readable(session, alice.id, is_admin=False)
        expected = {owned.id, console.id, discord.id, with_agent.id}
        assert {room.id for room in readable} == expected
        assert (
            await store.involved_room_ids(session, alice.id, [*expected, unrelated.id])
            == expected
        )
        concerned = await people_concerned(
            session,
            # Someone who just left is named by the client they left with.
            {discord.id: [], with_agent.id: [], unrelated.id: [member.id]},
        )
        assert concerned[discord.id] == [alice.id]
        assert set(concerned[with_agent.id]) == {alice.id, bob.id}
        assert alice.id in concerned[unrelated.id]
