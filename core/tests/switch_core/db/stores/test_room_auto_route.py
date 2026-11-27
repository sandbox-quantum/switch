"""A room's `!auto-route` setting, kept in its metadata."""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Room
from switch_core.db.stores.room_store import (
    AUTO_ROUTE_FALLBACK_KEY,
    AUTO_ROUTE_ON_KEY,
    DECISION_NOTICE_AT_KEY,
    RoomStore,
    auto_route_choice_in,
    auto_route_fallback_in,
    auto_route_on_in,
)


async def _room(session_factory: async_sessionmaker[AsyncSession]) -> str:
    async with session_factory() as session:
        room = Room(
            transport_room_id=f"!r-{uuid.uuid4().hex[:8]}:test",
            name="room",
            description="d",
            metadata_={"created_by_kind": "user"},
        )
        session.add(room)
        await session.commit()
        return room.id


def test_the_server_default_holds_until_the_room_chooses() -> None:
    for default_on in (True, False):
        assert auto_route_on_in(None, default_on) is default_on
        assert auto_route_on_in({}, default_on) is default_on
        assert auto_route_on_in({AUTO_ROUTE_ON_KEY: "yes"}, default_on) is default_on
        assert auto_route_on_in({AUTO_ROUTE_ON_KEY: True}, default_on)
        assert not auto_route_on_in({AUTO_ROUTE_ON_KEY: False}, default_on)


async def _choice(
    session_factory: async_sessionmaker[AsyncSession], room_id: str
) -> bool | None:
    async with session_factory() as session:
        room = await session.get(Room, room_id)
        assert room is not None
        return auto_route_choice_in(room.metadata_)


async def test_on_then_off_is_kept_beside_the_rest_of_the_metadata(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    room_id = await _room(session_factory)
    store = RoomStore()
    assert await _choice(session_factory, room_id) is None

    async with session_factory() as session:
        await store.set_auto_route_on(session, room_id, True)
        await session.commit()
    assert await _choice(session_factory, room_id) is True

    async with session_factory() as session:
        await store.set_auto_route_on(session, room_id, False)
        await session.commit()
        room = await store.get(session, room_id)
        assert room is not None
        assert room.metadata_ == {"created_by_kind": "user", AUTO_ROUTE_ON_KEY: False}
    assert await _choice(session_factory, room_id) is False


async def test_a_missing_room_is_refused(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        with pytest.raises(ValueError, match="does not exist"):
            await RoomStore().set_auto_route_on(session, str(uuid.uuid4()), True)


async def test_the_triage_agent_is_kept_in_the_metadata(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    room_id = await _room(session_factory)
    store = RoomStore()
    async with session_factory() as session:
        assert await store.auto_route_fallback(session, room_id) is None
        await store.set_auto_route_fallback(session, room_id, "agent-1")
        await session.commit()
        assert await store.auto_route_fallback(session, room_id) == "agent-1"
        assert auto_route_fallback_in({AUTO_ROUTE_FALLBACK_KEY: 7}) is None
        await store.set_auto_route_fallback(session, room_id, None)
        await session.commit()
        room = await session.get(Room, room_id)
        assert room is not None
        assert room.metadata_ == {"created_by_kind": "user"}


async def test_the_room_is_told_at_most_once_an_hour(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    room_id = await _room(session_factory)
    store = RoomStore()
    async with session_factory() as session:
        assert await store.claim_decision_notice(session, room_id, every_seconds=3600)
        await session.commit()
        assert not await store.claim_decision_notice(
            session, room_id, every_seconds=3600
        )
        await session.commit()
        # A shorter limit, as if the hour were up.
        assert await store.claim_decision_notice(session, room_id, every_seconds=0)
        await session.commit()
        room = await session.get(Room, room_id)
        await session.refresh(room)
        assert room is not None
        assert room.metadata_["created_by_kind"] == "user"
        assert DECISION_NOTICE_AT_KEY in room.metadata_


async def test_a_room_with_no_metadata_can_be_told(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        room = Room(
            transport_room_id=f"!r-{uuid.uuid4().hex[:8]}:test",
            name="bare",
            description="d",
            metadata_=None,
        )
        session.add(room)
        await session.commit()
        assert await RoomStore().claim_decision_notice(
            session, room.id, every_seconds=3600
        )
