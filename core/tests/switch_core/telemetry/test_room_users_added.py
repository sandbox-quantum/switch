"""`room_users_added` says how many people a bridged room gained, and is not
sent when it gained nobody."""

from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Client, CollaborationBridge, Room
from switch_core.db.stores.room_store import RoomStore
from switch_core.room_service import RoomService
from tests.telemetry_records import recording_telemetry


async def _bridged_room(session_factory: async_sessionmaker[AsyncSession]) -> str:
    suffix = uuid.uuid4().hex[:8]
    async with session_factory() as session:
        bridge_client = Client(
            transport_user_id=f"@bridge-{suffix}:test", display_name="b", type="bridge"
        )
        session.add(bridge_client)
        await session.flush()
        bridge = CollaborationBridge(
            type="slack",
            display_name="Slack",
            client_id=bridge_client.id,
            status="active",
        )
        session.add(bridge)
        await session.flush()
        room = Room(
            transport_room_id=f"!{suffix}:test",
            name="room",
            description="",
            bridge_id=bridge.id,
            external_channel_id=f"C{suffix}",
        )
        session.add(room)
        await session.commit()
        return room.id


def _service(
    session_factory: async_sessionmaker[AsyncSession], resolved: dict[str, str]
):  # type: ignore[no-untyped-def]
    telemetry, sink = recording_telemetry()
    core = SimpleNamespace(
        resolve_external_user_id_map=AsyncMock(return_value=resolved),
        adapter=SimpleNamespace(add_users_to_channel=AsyncMock(return_value=[])),
        ensure_users_in_room=AsyncMock(),
    )
    service = object.__new__(RoomService)
    service._session_factory = session_factory  # type: ignore[assignment]
    service._room_store = RoomStore()  # type: ignore[assignment]
    service._collab_lifecycle = SimpleNamespace(get=lambda bridge_id: core)  # type: ignore[assignment]
    service._telemetry = telemetry
    return service, sink


async def test_adding_nobody_reports_nothing(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    room_id = await _bridged_room(session_factory)
    service, sink = _service(session_factory, resolved={})

    assert await service.add_users_to_room(room_id, ["nobody"]) == ["nobody"]

    assert sink.events("room_users_added") == []


async def test_the_people_added_are_counted(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    room_id = await _bridged_room(session_factory)
    service, sink = _service(session_factory, resolved={"ann": "U1"})

    assert await service.add_users_to_room(room_id, ["ann", "nobody"]) == ["nobody"]

    assert sink.events("room_users_added") == [{"user_count": 1}]
