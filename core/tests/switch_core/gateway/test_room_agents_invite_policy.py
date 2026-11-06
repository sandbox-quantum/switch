"""`POST /gateway/rooms/{id}/agents` and `POST /gateway/rooms` add an agent only
for someone its addressing policy admits, and say so with a 403. The routes are
called directly, as in `test_room_sync_name`."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.addressing import owner_only_policy
from switch_core.db.models import Room, User
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.gateway import rooms as rooms_module
from switch_core.gateway.schemas import RoomAgentsRequest, RoomCreateRequest
from tests.switch_core.gateway.conftest import _Harness


@pytest.fixture(autouse=True)
def _room_detail_is_its_name(monkeypatch: pytest.MonkeyPatch) -> None:
    async def detail(
        _session: AsyncSession, room: Room, *_args: Any, **_kwargs: Any
    ) -> str:
        return room.name

    monkeypatch.setattr(rooms_module, "_build_room_detail", detail)


async def _public_room(chats: _Harness, owner: User) -> str:
    async with chats.factory() as session:
        room = Room(
            transport_room_id="!shared:test",
            name="shared",
            description="",
            owner_id=owner.id,
            read_visibility="public",
            write_visibility="public",
        )
        session.add(room)
        await session.commit()
        return room.id


async def _add(chats: _Harness, room_id: str, agent_id: str, user: User) -> Any:
    async with chats.factory() as session:
        return await rooms_module.post_room_agents(
            room_id,
            RoomAgentsRequest(agent_ids=[agent_id]),
            session,
            chats.room_service,
            RoomStore(),
            CollaborationBridgeStore(),
            None,  # type: ignore[arg-type]
            None,  # type: ignore[arg-type]
            user,
            False,
        )


async def _members(chats: _Harness, room_id: str) -> list[str]:
    async with chats.factory() as session:
        return await RoomStore().get_agent_ids(session, room_id)


async def test_someone_the_agent_does_not_take_instructions_from_gets_a_403(
    chats: _Harness,
) -> None:
    agent = await chats.agent("alice-agent", owner=chats.alice, policy=_owner_only())
    room_id = await _public_room(chats, owner=chats.bob)

    with pytest.raises(HTTPException) as refused:
        await _add(chats, room_id, agent.id, chats.bob)

    assert refused.value.status_code == 403
    assert "alice-agent" in refused.value.detail
    assert "Ask its owner" in refused.value.detail
    assert await _members(chats, room_id) == []


async def test_the_owner_may_add_it_to_someone_elses_public_room(
    chats: _Harness,
) -> None:
    agent = await chats.agent("alice-agent", owner=chats.alice, policy=_owner_only())
    room_id = await _public_room(chats, owner=chats.bob)

    await _add(chats, room_id, agent.id, chats.alice)

    assert await _members(chats, room_id) == [agent.id]


async def test_an_agent_open_to_everyone_may_be_added_by_anyone(
    chats: _Harness,
) -> None:
    agent = await chats.agent("open-agent", owner=chats.alice, policy=None)
    room_id = await _public_room(chats, owner=chats.bob)

    await _add(chats, room_id, agent.id, chats.bob)

    assert await _members(chats, room_id) == [agent.id]


async def test_a_room_is_not_made_around_an_agent_its_creator_may_not_add(
    chats: _Harness,
) -> None:
    agent = await chats.agent("alice-agent", owner=chats.alice, policy=_owner_only())

    async with chats.factory() as session:
        with pytest.raises(HTTPException) as refused:
            await rooms_module.create_room(
                RoomCreateRequest(
                    name="new room",
                    description="d",
                    agent_ids=[agent.id],
                    internal_only=True,
                ),
                session,
                chats.room_service,
                RoomStore(),
                CollaborationBridgeStore(),
                None,  # type: ignore[arg-type]
                None,  # type: ignore[arg-type]
                chats.bob,
                False,
            )

    assert refused.value.status_code == 403
    async with chats.factory() as session:
        assert (
            await session.scalars(select(Room).where(Room.name == "new room"))
        ).all() == []


def _owner_only() -> dict[str, Any]:
    return owner_only_policy([]).model_dump()
