"""Making people room admins, against a real database: who may, who can be
one, and how leaving the room or being handed it takes the role away."""

from __future__ import annotations

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.accounts.transfer import transfer_ownership
from switch_core.authz import Principal
from switch_core.chats import MEMBER_CLIENT_TYPE
from switch_core.db.models import (
    TENANT_ZERO_ID,
    AuditEvent,
    Client,
    ClientRoom,
    Room,
    TenantMember,
    User,
    room_agents,
)
from switch_core.db.stores.room_store import RoomStore
from switch_core.room_admins import (
    RoomAdminRefused,
    grant,
    is_room_admin,
    list_admins,
    revoke,
    standing,
)
from switch_core.room_policy import RoomCaller
from tests.conftest import TEST_KEYRING
from tests.switch_core.gateway.agent_route_harness import add_agent

STORE = RoomStore()


async def _person(session: AsyncSession, name: str, *, role: str = "member") -> User:
    user = User(name=name, email=f"{name}@example.invalid", role="user")
    session.add(user)
    await session.flush()
    session.add(TenantMember(tenant_id=TENANT_ZERO_ID, user_id=user.id, role=role))
    await session.flush()
    return user


async def _in_room(session: AsyncSession, user: User, room: Room) -> Client:
    client = Client(
        transport_user_id=f"@{user.name}-member:test",
        display_name=user.name,
        type=MEMBER_CLIENT_TYPE,
        user_id=user.id,
    )
    session.add(client)
    await session.flush()
    session.add(ClientRoom(client_id=client.id, room_id=room.id))
    await session.flush()
    return client


async def _room(session: AsyncSession, owner: User) -> Room:
    room = Room(
        transport_room_id=f"!room-{owner.name}:test",
        name="design-review",
        description="",
        owner_id=owner.id,
        read_visibility="private",
        write_visibility="private",
    )
    session.add(room)
    await session.flush()
    return room


def _caller(user: User, *, is_admin: bool = False) -> RoomCaller:
    return RoomCaller(Principal(user.id, is_admin), in_room=True)


async def test_the_owner_makes_someone_in_the_room_a_room_admin(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        olivia = await _person(session, "olivia")
        max_ = await _person(session, "max")
        room = await _room(session, olivia)
        await _in_room(session, max_, room)

        assert await grant(
            session, STORE, room, caller=_caller(olivia), user_id=max_.id
        )
        # Doing it again changes nothing.
        assert not await grant(
            session, STORE, room, caller=_caller(olivia), user_id=max_.id
        )

        assert (await standing(session, STORE, room.id, max_.id)).room_admin
        assert [a.user_id for a in await list_admins(session, STORE, room.id)] == [
            max_.id
        ]
        [row] = await list_admins(session, STORE, room.id)
        assert row.granted_by == olivia.id
        audit = (
            await session.scalars(
                select(AuditEvent).where(AuditEvent.action == "room_admin.added")
            )
        ).all()
        assert [(e.target_id, e.details["user_id"]) for e in audit] == [
            (room.id, max_.id)
        ]


async def test_a_workspace_admin_may_and_a_room_admin_may_not(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        olivia = await _person(session, "olivia")
        max_ = await _person(session, "max")
        bea = await _person(session, "bea")
        ada = await _person(session, "ada", role="admin")
        room = await _room(session, olivia)
        await _in_room(session, max_, room)
        await _in_room(session, bea, room)

        assert await grant(
            session, STORE, room, caller=_caller(ada, is_admin=True), user_id=max_.id
        )
        as_room_admin = RoomCaller(
            Principal(max_.id, False), in_room=True, room_admin=True
        )
        with pytest.raises(RoomAdminRefused) as refused:
            await grant(session, STORE, room, caller=as_room_admin, user_id=bea.id)
        assert refused.value.status == 403
        assert "owner or a workspace admin" in str(refused.value)
        with pytest.raises(RoomAdminRefused):
            await revoke(session, STORE, room, caller=_caller(bea), user_id=max_.id)


@pytest.mark.parametrize("case", ["outside", "owner", "not_a_member"])
async def test_who_cannot_be_a_room_admin(
    session_factory: async_sessionmaker[AsyncSession], case: str
) -> None:
    async with session_factory() as session:
        olivia = await _person(session, "olivia")
        room = await _room(session, olivia)
        if case == "outside":
            target = await _person(session, "bea")
            expected = "Only people in the room"
        elif case == "owner":
            target = olivia
            expected = "They own this room"
        else:
            target = User(name="stranger", email="s@example.invalid", role="user")
            session.add(target)
            await session.flush()
            await _in_room(session, target, room)
            expected = "Only members of this workspace"
        with pytest.raises(RoomAdminRefused) as refused:
            await grant(session, STORE, room, caller=_caller(olivia), user_id=target.id)
        assert refused.value.status == 400
        assert expected in str(refused.value)


async def test_a_room_admin_may_step_down(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        olivia = await _person(session, "olivia")
        max_ = await _person(session, "max")
        room = await _room(session, olivia)
        await _in_room(session, max_, room)
        await grant(session, STORE, room, caller=_caller(olivia), user_id=max_.id)

        assert await revoke(session, STORE, room, caller=_caller(max_), user_id=max_.id)
        assert not await is_room_admin(session, STORE, room.id, max_.id)
        assert not await revoke(
            session, STORE, room, caller=_caller(olivia), user_id=max_.id
        )


async def test_leaving_the_room_takes_the_role_away(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        olivia = await _person(session, "olivia")
        max_ = await _person(session, "max")
        room = await _room(session, olivia)
        client = await _in_room(session, max_, room)
        await grant(session, STORE, room, caller=_caller(olivia), user_id=max_.id)

        assert await STORE.remove_client(session, client.id, room.id)

        assert await list_admins(session, STORE, room.id) == []
        # Coming back does not bring it back.
        session.add(ClientRoom(client_id=client.id, room_id=room.id))
        await session.flush()
        assert not await is_room_admin(session, STORE, room.id, max_.id)


async def test_their_last_agent_leaving_takes_the_role_away(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        olivia = await _person(session, "olivia")
        max_ = await _person(session, "max")
        room = await _room(session, olivia)
        agent = await add_agent(session, name="maxs-agent", owner_id=max_.id)
        await session.execute(
            room_agents.insert().values(room_id=room.id, agent_id=agent.id)
        )
        await grant(session, STORE, room, caller=_caller(olivia), user_id=max_.id)

        await STORE.remove_agents(session, room.id, [agent.id])

        assert await list_admins(session, STORE, room.id) == []


async def test_someone_still_in_the_room_another_way_keeps_it(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        olivia = await _person(session, "olivia")
        max_ = await _person(session, "max")
        room = await _room(session, olivia)
        await _in_room(session, max_, room)
        agent = await add_agent(session, name="maxs-agent", owner_id=max_.id)
        await session.execute(
            room_agents.insert().values(room_id=room.id, agent_id=agent.id)
        )
        await grant(session, STORE, room, caller=_caller(olivia), user_id=max_.id)

        await STORE.remove_agents(session, room.id, [agent.id])

        assert await is_room_admin(session, STORE, room.id, max_.id)


async def test_being_handed_the_room_takes_them_off_the_list(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        olivia = await _person(session, "olivia")
        max_ = await _person(session, "max")
        room = await _room(session, olivia)
        await _in_room(session, max_, room)
        await grant(session, STORE, room, caller=_caller(olivia), user_id=max_.id)

        await transfer_ownership(
            session,
            tenant_id=TENANT_ZERO_ID,
            kind="room",
            resource_id=room.id,
            new_owner_id=max_.id,
            caller=Principal(olivia.id, False),
            keyring=TEST_KEYRING,
        )

        assert await list_admins(session, STORE, room.id) == []


async def test_coming_back_another_way_does_not_bring_it_back(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Gone through a path nothing prunes (their agent deleted outright), the
    grant counts for nothing, and is dropped before they rejoin."""
    async with session_factory() as session:
        olivia = await _person(session, "olivia")
        max_ = await _person(session, "max")
        room = await _room(session, olivia)
        agent = await add_agent(session, name="maxs-agent", owner_id=max_.id)
        await session.execute(
            room_agents.insert().values(room_id=room.id, agent_id=agent.id)
        )
        await grant(session, STORE, room, caller=_caller(olivia), user_id=max_.id)
        await session.execute(
            room_agents.delete().where(room_agents.c.agent_id == agent.id)
        )

        assert not await is_room_admin(session, STORE, room.id, max_.id)
        assert await list_admins(session, STORE, room.id) == []

        console = Client(
            transport_user_id="@max-member:test",
            display_name="max",
            type=MEMBER_CLIENT_TYPE,
            user_id=max_.id,
        )
        session.add(console)
        await session.flush()
        assert await STORE.add_client(session, console.id, room.id)
        assert not await is_room_admin(session, STORE, room.id, max_.id)
