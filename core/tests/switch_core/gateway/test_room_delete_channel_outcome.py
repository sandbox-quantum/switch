"""Deleting a room says what became of its platform channel, and room detail
says beforehand what will."""

from __future__ import annotations

import uuid
from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.collaboration.models import RetireOutcome
from switch_core.bridges.collaboration.platforms import PLATFORMS
from switch_core.db.models import Room, User
from switch_core.db.stores.room_store import RoomStore
from switch_core.gateway import rooms as rooms_module
from switch_core.gateway.rooms import (
    _channel_on_delete,
    bulk_delete_rooms,
    delete_room,
)
from switch_core.gateway.schemas import BulkDeleteRequest

_ROOM_STORE = RoomStore()


class _Registry:
    def __init__(self) -> None:
        self._classes = {p.key: p.adapter for p in PLATFORMS}

    def adapter_class(self, bridge_type: str) -> Any:
        return self._classes.get(bridge_type)


class _RoomService:
    def __init__(self, outcomes: dict[str, RetireOutcome | None]) -> None:
        self._outcomes = outcomes
        self.calls: list[tuple[str, bool]] = []

    async def delete_room(
        self, room_id: str, *, retire_channel: bool
    ) -> RetireOutcome | None:
        self.calls.append((room_id, retire_channel))
        return self._outcomes[room_id]


@pytest.mark.parametrize(
    ("bridge_type", "expected"),
    [
        ("slack", "archived"),
        ("mattermost", "archived"),
        ("discord", "deleted"),
        ("telegram", "left"),
        ("teams", "kept"),
    ],
)
def test_room_detail_names_the_platforms_outcome(
    monkeypatch: pytest.MonkeyPatch, bridge_type: str, expected: str
) -> None:
    monkeypatch.setattr(rooms_module, "get_collab_lifecycle", _Registry)
    room = SimpleNamespace(external_channel_id="C1", channel_type="channel_private")

    assert _channel_on_delete(room, bridge_type) == expected  # type: ignore[arg-type]


def test_a_direct_message_room_is_kept(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(rooms_module, "get_collab_lifecycle", _Registry)
    room = SimpleNamespace(external_channel_id="D1", channel_type="direct")

    assert _channel_on_delete(room, "slack") == "kept"  # type: ignore[arg-type]


def test_a_room_without_a_channel_has_no_outcome(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(rooms_module, "get_collab_lifecycle", _Registry)

    assert (
        _channel_on_delete(SimpleNamespace(external_channel_id=None), "slack") is None
    )  # type: ignore[arg-type]
    assert _channel_on_delete(SimpleNamespace(external_channel_id="C1"), None) is None  # type: ignore[arg-type]


async def _admin(session: AsyncSession) -> User:
    user = User(
        id=f"admin-{uuid.uuid4().hex[:8]}",
        name=f"admin-{uuid.uuid4().hex[:8]}",
        email=f"admin-{uuid.uuid4().hex[:8]}@example.test",
        role="admin",
    )
    session.add(user)
    await session.flush()
    return user


async def _room(session: AsyncSession) -> str:
    room = Room(
        transport_room_id=f"!{uuid.uuid4().hex[:8]}:test",
        name=f"room-{uuid.uuid4().hex[:8]}",
        description="",
    )
    session.add(room)
    await session.flush()
    return room.id


async def test_delete_keeps_the_channel_unless_asked(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        admin = await _admin(session)
        room_id = await _room(session)
        await session.commit()
    room_service = _RoomService({room_id: None})

    async with session_factory() as session:
        response = await delete_room(
            room_id,
            session,
            room_service,  # type: ignore[arg-type]
            _ROOM_STORE,
            admin,
            True,
        )

    assert room_service.calls == [(room_id, False)]
    assert response.model_dump() == {"ok": True, "channel": None}


async def test_delete_returns_the_channel_outcome(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        admin = await _admin(session)
        room_id = await _room(session)
        await session.commit()
    refused = RetireOutcome.failed("not_in_channel")
    room_service = _RoomService({room_id: refused})

    async with session_factory() as session:
        response = await delete_room(
            room_id,
            session,
            room_service,  # type: ignore[arg-type]
            _ROOM_STORE,
            admin,
            True,
            retire_channel=True,
        )

    assert room_service.calls == [(room_id, True)]
    assert response.model_dump() == {
        "ok": True,
        "channel": {"outcome": "failed", "reason": "not_in_channel"},
    }


async def test_bulk_delete_returns_each_rooms_channel_outcome(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        admin = await _admin(session)
        bridged = await _room(session)
        internal = await _room(session)
        await session.commit()
    room_service = _RoomService(
        {bridged: RetireOutcome(outcome="archived"), internal: None}
    )

    async with session_factory() as session:
        response = await bulk_delete_rooms(
            BulkDeleteRequest(room_ids=[bridged, internal], retire_channel=True),
            session,
            room_service,  # type: ignore[arg-type]
            _ROOM_STORE,
            admin,
            True,
        )

    assert room_service.calls == [(bridged, True), (internal, True)]
    assert response.deleted == 2
    assert response.channels == {bridged: RetireOutcome(outcome="archived")}


async def test_bulk_delete_keeps_channels_unless_asked(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        admin = await _admin(session)
        bridged = await _room(session)
        await session.commit()
    room_service = _RoomService({bridged: None})

    async with session_factory() as session:
        response = await bulk_delete_rooms(
            BulkDeleteRequest(room_ids=[bridged]),
            session,
            room_service,  # type: ignore[arg-type]
            _ROOM_STORE,
            admin,
            True,
        )

    assert room_service.calls == [(bridged, False)]
    assert response.channels == {}
