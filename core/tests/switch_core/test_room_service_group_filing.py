"""`RoomService.create_room` puts a room in a group only for a workspace
admin, whichever front door the request came through."""

from __future__ import annotations

from typing import Any

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Room
from switch_core.db.stores.room_store import RoomStore
from switch_core.decision.settings import DecisionAvailability
from switch_core.room_service import RoomCreateConfig, RoomService


class _NeverProvisioned:
    def __getattr__(self, name: str) -> Any:
        raise AssertionError(f"provisioning reached: {name}")


def _service(session_factory: async_sessionmaker[AsyncSession]) -> RoomService:
    never: Any = _NeverProvisioned()
    return RoomService(
        provisioning=never,
        room_store=RoomStore(),
        agent_store=never,
        client_lifecycle=never,
        collab_lifecycle=never,
        collab_bridge_store=never,
        resource_service=never,
        session_factory=session_factory,
        room_cache=never,
        decisions=DecisionAvailability.off(),
    )


@pytest.mark.parametrize("group_id", ["no-such-group", "any"])
async def test_a_non_admin_cannot_create_a_room_in_a_group(
    session_factory: async_sessionmaker[AsyncSession], group_id: str
) -> None:
    with pytest.raises(PermissionError, match="workspace admin"):
        await _service(session_factory).create_room(
            RoomCreateConfig(
                name="filed",
                description="d",
                agent_names=[],
                group_id=group_id,
                acting_user_id="member",
                acting_is_admin=False,
            )
        )

    async with session_factory() as session:
        assert (await session.execute(select(Room))).scalars().all() == []
