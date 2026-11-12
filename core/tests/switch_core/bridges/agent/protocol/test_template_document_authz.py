"""Whose agents may maintain a room's template documents.

A template document's instructions reach every agent in the room, so taking
part in the room is not enough to change them: the agent's owner must be able
to write the room, the rule room roles already follow. `_owner_writes_room`
is what `request_room_document_update` / `request_room_document_delete` hand
the resource service for that.
"""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Room
from tests.switch_core.bridges.agent.protocol.test_room_roster_authz import (
    _make_user,
    _register,
    _service,
)


async def _room(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    owner_id: str,
    write_visibility: str,
) -> str:
    async with session_factory() as session:
        room = Room(
            transport_room_id=f"!{write_visibility}:test",
            name=write_visibility,
            description="",
            owner_id=owner_id,
            read_visibility="public",
            write_visibility=write_visibility,
        )
        session.add(room)
        await session.commit()
        return room.id


async def test_only_an_owner_who_writes_the_room_may_maintain_its_template_documents(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    svc = _service(session_factory)
    room_owner = await _make_user(session_factory, "room-owner")
    stranger = await _make_user(session_factory, "stranger")
    owners_agent = await _register(svc, "owners-agent", room_owner)
    strangers_agent = await _register(svc, "strangers-agent", stranger)
    private = await _room(
        session_factory, owner_id=room_owner, write_visibility="private"
    )
    public = await _room(
        session_factory, owner_id=room_owner, write_visibility="public"
    )

    async with session_factory() as session:
        assert await svc._owner_writes_room(session, owners_agent, private)
        assert not await svc._owner_writes_room(session, strangers_agent, private)
        assert await svc._owner_writes_room(session, strangers_agent, public)
