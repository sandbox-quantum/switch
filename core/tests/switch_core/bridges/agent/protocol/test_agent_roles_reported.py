"""An agent defining or deleting a room role reports it, as the gateway does,
once the change is committed."""

from __future__ import annotations

import uuid
from unittest.mock import AsyncMock

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.agent_core import AgentCore
from switch_core.db.models import Room
from switch_core.db.stores.room_role_store import RoomRoleStore
from tests.telemetry_records import recording_telemetry


async def test_an_agents_roles_are_reported(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        room = Room(
            transport_room_id=f"!{uuid.uuid4().hex[:8]}:test",
            name="room",
            description="",
        )
        session.add(room)
        await session.commit()
    svc = object.__new__(AgentCore)
    svc.session_factory = session_factory  # type: ignore[attr-defined]
    svc.room_role_store = RoomRoleStore()  # type: ignore[attr-defined]
    svc._require_room_action = AsyncMock()  # type: ignore[method-assign]
    svc.telemetry, sink = recording_telemetry()  # type: ignore[misc]

    await svc.define_room_role("agent-x", room.id, "lead", "lead the room", True)
    await svc.delete_room_role("agent-x", room.id, "lead")

    assert sink.events("room_role_defined") == [{"exclusive": True}]
    assert sink.events("room_role_deleted") == [{}]
