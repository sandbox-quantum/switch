"""Whoever takes part in a private room may read it, and only read it: a
person whose Switch Console member client or claimed platform account is in
the room, or who owns an agent in it. The route coroutines are called
directly against real Postgres, as in `test_room_access_permission_authz`."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi import HTTPException
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
from switch_core.gateway import rooms as rooms_module
from switch_core.gateway.schemas import RoomUpdateRequest
from tests.switch_core.gateway.agent_route_harness import add_agent

_ROOM_STORE = RoomStore()


class _GatePassed(Exception):
    pass


class _SentinelRoomService:
    async def update_room(self, *args: Any, **kwargs: Any) -> None:
        raise _GatePassed


async def _user(session: AsyncSession, name: str) -> User:
    user = User(name=name, email=f"{name}@example.com", role="user")
    session.add(user)
    await session.flush()
    return user


async def _client(
    session: AsyncSession, name: str, kind: str, user_id: str | None
) -> Client:
    client = Client(
        transport_user_id=f"@{name}:test", display_name=name, type=kind, user_id=user_id
    )
    session.add(client)
    await session.flush()
    return client


async def _read(session: AsyncSession, room_id: str, user: User) -> object:
    return await rooms_module.get_room(
        room_id,
        session,
        _ROOM_STORE,
        None,
        None,
        None,
        None,
        user,
        False,  # type: ignore[arg-type]
    )


async def _write(session: AsyncSession, room_id: str, user: User) -> None:
    await rooms_module.patch_room(
        room_id,
        RoomUpdateRequest(name="renamed"),
        session,
        _SentinelRoomService(),  # type: ignore[arg-type]
        _ROOM_STORE,
        None,  # type: ignore[arg-type]
        None,  # type: ignore[arg-type]
        None,  # type: ignore[arg-type]
        None,  # type: ignore[arg-type]
        user,
        False,
    )


async def test_participants_read_a_private_room_and_change_nothing(
    session_factory: async_sessionmaker[AsyncSession], monkeypatch: pytest.MonkeyPatch
) -> None:
    async def detail(_session: AsyncSession, room: Room, *_args: Any) -> str:
        return room.id

    monkeypatch.setattr(rooms_module, "_build_room_detail", detail)
    async with session_factory() as session:
        owner = await _user(session, "owner")
        member = await _user(session, "member")
        claimer = await _user(session, "claimer")
        agent_owner = await _user(session, "agent-owner")
        stranger = await _user(session, "stranger")
        room = Room(
            transport_room_id="!private:test",
            name="private",
            description="",
            owner_id=owner.id,
            read_visibility="private",
            write_visibility="private",
        )
        session.add(room)
        await session.flush()

        console = await _client(
            session, "member-console", MEMBER_CLIENT_TYPE, member.id
        )
        session.add(ClientRoom(client_id=console.id, room_id=room.id))
        bridge_client = await _client(session, "bridge", "bridge", None)
        bridge = CollaborationBridge(
            type="discord",
            display_name="Discord",
            client_id=bridge_client.id,
            status="active",
        )
        session.add(bridge)
        await session.flush()
        platform = await _client(session, "claimer-discord", "user", None)
        account = ExternalUser(
            bridge_id=bridge.id,
            external_user_id="d-1",
            external_username="claimer#1",
            client_id=platform.id,
        )
        session.add(account)
        await session.flush()
        session.add(ExternalUserClaim(external_user_id=account.id, user_id=claimer.id))
        session.add(ClientRoom(client_id=platform.id, room_id=room.id))
        agent = await add_agent(session, name="their-agent", owner_id=agent_owner.id)
        await session.execute(
            room_agents.insert().values(room_id=room.id, agent_id=agent.id)
        )
        await session.commit()

        for participant in (member, claimer, agent_owner):
            assert await _read(session, room.id, participant) == room.id
            with pytest.raises(HTTPException) as refused:
                await _write(session, room.id, participant)
            assert refused.value.status_code == 403

        with pytest.raises(HTTPException) as hidden:
            await _read(session, room.id, stranger)
        assert hidden.value.status_code == 403
        with pytest.raises(_GatePassed):
            await _write(session, room.id, owner)
